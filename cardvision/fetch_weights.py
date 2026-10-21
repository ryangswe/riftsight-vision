# SPDX-License-Identifier: Apache-2.0
"""``cardvision fetch-weights DIR``: download the released weights of this repository into a
folder, check every file against the hashes pinned in :mod:`cardvision.release_assets` and
against ``SHA256SUMS``, then run ``verify-release`` on the release document.

Nothing is requested until the notice has been printed. A file is written under a temporary
name and renamed only when its size and SHA-256 match, so a failed run leaves no partial file.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path

import cardvision
from cardvision import release_assets
from cardvision.core.tls import CERTIFICATE_HELP, is_certificate_failure, tls_context

SUMMARY = "Download the released weights into a folder, check every file, then verify the release."
TIMEOUT = 60.0
MIN_DEADLINE = 120.0  # seconds for one file, at least
MIN_RATE = 50_000  # bytes per second the deadline allows for


class FetchWeightsError(RuntimeError):
    """The download or a check failed; the message says which and what to do."""


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class _HttpOnlyRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to another http(s) address, and never from https down to http."""

    def http_error_302(self, req, fp, code, msg, headers):  # noqa: ANN001, ANN201 - urllib's signature
        # urllib turns away a scheme it does not follow before redirect_request is asked, with an
        # error that names only the status; look at the address first, to say why.
        location = headers.get("location") or headers.get("uri")
        if location is not None:
            self._check(req, urllib.parse.urljoin(req.full_url, location))
        return super().http_error_302(req, fp, code, msg, headers)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201 - urllib's signature
        self._check(req, newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

    @staticmethod
    def _check(req, newurl: str) -> None:  # noqa: ANN001
        if not newurl.lower().startswith(("http://", "https://")):
            raise FetchWeightsError(f"{req.full_url}: redirect to {newurl} refused; only http and https are followed")
        if req.full_url.lower().startswith("https://") and newurl.lower().startswith("http://"):
            raise FetchWeightsError(f"{req.full_url}: redirect from https to http refused ({newurl})")


def _get(url: str, limit: int) -> bytes:
    """The body at ``url``, read in chunks up to ``limit`` + 1 bytes under an overall deadline."""
    if not url.lower().startswith(("http://", "https://")):
        raise FetchWeightsError(f"refused link {url!r}: only http and https are fetched")
    request = urllib.request.Request(url, headers={"User-Agent": f"cardvision/{cardvision.__version__} fetch-weights"})
    opener = urllib.request.build_opener(_HttpOnlyRedirects(), urllib.request.HTTPSHandler(context=tls_context()))
    started = time.monotonic()
    allowed = max(MIN_DEADLINE, limit / MIN_RATE)
    chunks: list[bytes] = []
    total = 0
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            while total <= limit:
                chunk = response.read1(min(1 << 16, limit + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if time.monotonic() - started > allowed:
                    raise FetchWeightsError(f"{url}: too slow ({total} bytes in {time.monotonic() - started:.0f} s; "
                                            f"the limit is {allowed:.0f} s)")
    except urllib.error.HTTPError as error:
        raise FetchWeightsError(f"could not fetch {url}: HTTP {error.code}") from None
    except (urllib.error.URLError, OSError) as error:
        if is_certificate_failure(error):
            raise FetchWeightsError(f"{url}: {CERTIFICATE_HELP}") from None
        reason = getattr(error, "reason", None) or error
        raise FetchWeightsError(f"could not fetch {url}: {reason}. Nothing was written for this file; "
                                "check the connection and run the command again") from None
    except http.client.HTTPException as error:
        raise FetchWeightsError(f"could not fetch {url}: {type(error).__name__} {error}".rstrip()) from None
    return b"".join(chunks)


def parse_sums(text: str) -> dict[str, str]:
    """A ``SHA256SUMS`` file as {name: sha256}."""
    sums: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2:
            sums[parts[1].lstrip("*")] = parts[0].lower()
    return sums


def _megabytes(count: int) -> str:
    return f"{count / 1e6:.1f}"


def list_lines(assets: tuple[release_assets.Asset, ...], base_url: str) -> list[str]:
    width = max(len(asset.name) for asset in assets)
    lines = [f"{asset.name.ljust(width)}  {asset.bytes:>9} bytes  {base_url}{asset.name}" for asset in assets]
    lines.append(f"{len(assets)} files, about {_megabytes(sum(asset.bytes for asset in assets))} MB; "
                 f"SHA-256 of each is pinned in cardvision/release_assets.py and docs/release-files.md")
    return lines


def fetch_weights(dest: Path, *, assets: tuple[release_assets.Asset, ...] | None = None, base_url: str | None = None,
                  overwrite: bool = False, say: Callable[[str], None] = print) -> None:
    """Fetch the release into ``dest``. Raises ``FetchWeightsError`` on any mismatch."""
    assets = release_assets.ASSETS if assets is None else assets
    base_url = release_assets.BASE_URL if base_url is None else base_url
    dest = Path(dest)
    # Before any request: which files are there, and which of those differ.
    present: list[str] = []
    todo: list[release_assets.Asset] = []
    differ: list[str] = []
    for asset in assets:
        path = dest / asset.name
        if path.is_file():
            if _sha256_of(path) == asset.sha256:
                present.append(asset.name)
                continue
            differ.append(asset.name)
        elif path.exists():
            raise FetchWeightsError(f"{path} exists and is not a file")
        todo.append(asset)
    if differ and not overwrite:
        raise FetchWeightsError(f"{dest}: {', '.join(differ)} differ from the released files; nothing was changed. "
                                "Run again with --overwrite to replace them, or choose another folder")
    if todo:
        say(f"downloading {len(todo)} file{'' if len(todo) == 1 else 's'} (about {_megabytes(sum(a.bytes for a in todo))} MB) from {base_url} into {dest}")
    if present:
        say(f"already present with the right hash: {', '.join(present)}")
    try:
        dest.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise FetchWeightsError(f"cannot create {dest}: {error.strerror or error}") from None

    def check_pins(sums: dict[str, str]) -> None:
        wrong = [a.name for a in assets if a.name in sums and sums[a.name] != a.sha256]
        if wrong:
            raise FetchWeightsError(f"the pinned SHA-256 of {', '.join(wrong)} differs from the one in "
                                    f"{release_assets.SUMS_NAME}; nothing more was fetched")

    sums_path = dest / release_assets.SUMS_NAME
    if release_assets.SUMS_NAME in present:
        check_pins(parse_sums(sums_path.read_text(encoding="utf-8", errors="replace")))
    ordered = sorted(todo, key=lambda a: a.name != release_assets.SUMS_NAME)  # the sums file first
    for asset in ordered:
        data = _get(base_url + asset.name, asset.bytes)
        got = hashlib.sha256(data).hexdigest()
        if len(data) != asset.bytes or got != asset.sha256:
            raise FetchWeightsError(f"{base_url}{asset.name}: {len(data)} bytes with SHA-256 {got}, expected "
                                    f"{asset.bytes} bytes with {asset.sha256}; the file was not written")
        if asset.name == release_assets.SUMS_NAME:
            check_pins(parse_sums(data.decode("utf-8", errors="replace")))
        _write(dest / asset.name, data)
        say(f"  {asset.name}: ok ({len(data)} bytes)")


def _read_umask() -> int:
    mask = os.umask(0)
    os.umask(mask)
    return mask


_UMASK = _read_umask()  # read once at import: the umask can only be read by setting it


def _write(final: Path, data: bytes) -> None:
    """Write ``data`` to a new, uniquely named file next to ``final`` (never following a link),
    then rename it over ``final``. A failure leaves no temporary file."""
    temp = None
    try:
        handle, temp = tempfile.mkstemp(dir=final.parent, prefix=f".{final.name}.", suffix=".part")
        with os.fdopen(handle, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temp, 0o666 & ~_UMASK)  # mkstemp makes the file private; a downloaded file follows the umask
        os.replace(temp, final)
        temp = None
    except OSError as error:
        raise FetchWeightsError(f"cannot write {final}: {error.strerror or error}; the file was not written") from None
    finally:
        if temp is not None:
            Path(temp).unlink(missing_ok=True)


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("dir", metavar="DIR",
                        help="the folder to put the eight files in (created if missing); not inside the repository")
    parser.add_argument("--list", action="store_true",
                        help="print the files, their sizes and addresses, and stop: no request is made")
    parser.add_argument("--overwrite", action="store_true",
                        help="replace a file that is there but differs from the released one")


SUGGESTED_DIR = '"$HOME/Downloads/cardvision-weights"'


def dir_problem(raw: str | Path) -> list[str] | None:
    """Why a DIR is refused, as lines, or ``None``: an empty one, which would mean the current
    folder, and one inside the repository, which holds no model files."""
    from cardvision.core.checkout import inside_checkout, unset_variable_hint

    if isinstance(raw, str) and not raw.strip():
        return ["DIR is empty, which would put the files in the current folder; if you typed it as "
                "\"$WEIGHTS\", that shell variable is empty (a new terminal forgets it)",
                f"name a folder outside the repository, for example {SUGGESTED_DIR}"]
    if inside_checkout(raw):
        return [f"{raw} lies inside the repository, which holds no model files",
                f"choose a folder outside it, for example {SUGGESTED_DIR}"]
    hint = unset_variable_hint(raw)
    if hint is not None and not Path(raw).exists():
        return [hint, f"name a folder outside the repository, for example {SUGGESTED_DIR}"]
    return None


def run(args: argparse.Namespace) -> int:
    if args.list:
        for line in list_lines(release_assets.ASSETS, release_assets.BASE_URL):
            print(line)
        return 0
    problem = dir_problem(args.dir)
    if problem is not None:
        print("cardvision fetch-weights: failed", file=sys.stderr)
        for line in problem:
            print(f"  - {line}", file=sys.stderr)
        return 1
    args.dir = Path(args.dir)
    try:
        fetch_weights(args.dir, overwrite=args.overwrite)
    except FetchWeightsError as error:
        print("cardvision fetch-weights: failed", file=sys.stderr)
        print(f"  - {error}", file=sys.stderr)
        return 1
    from cardvision.bank.commands import _verify_release

    return _verify_release(argparse.Namespace(release=args.dir / "release.json"))
