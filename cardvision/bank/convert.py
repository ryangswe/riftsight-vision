# SPDX-License-Identifier: Apache-2.0
"""Convert a release to smaller files, without changing a value (``cardvision convert-release``).

Some consumers cannot take a large text file: a browser add-on store's linter refuses any text
file over 5 MiB. A release's two largest text files are its bank and its catalog, and both can
be written smaller with the same content:

* the bank becomes ``bank.bin``, its binary form (``cardvision.core.bank_binary``), holding the
  same fp16 bytes as the JSON bank's base64 text;
* the catalog is written as compact JSON: no indentation and no spaces after separators, the
  same keys in the same order, the same values.

The converted release is a new release, with a new id: its document pins the new files by their
new SHA-256 and size. Everything else in it is unchanged, so it scores exactly as the original.
The identity groups file records the SHA-256 of the bank it was made for, so it is copied with
that one value set to the new bank's; every other pinned file is copied byte for byte.

A geometric index records the SHA-256 of the bank it serves too. Converting changes it, so an
index built against the JSON bank does not serve the converted release: build it again with
``cardvision build-features --bank`` naming ``bank.bin``, and pack it again.
"""

from __future__ import annotations

import copy
import json
import shutil
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from cardvision.bank.documents import canonical_bytes, read_json, sha256_hex
from cardvision.bank.release import ReleaseError, release_errors, verify_release, with_id
from cardvision.core.bank_binary import encode, is_binary_bank

BINARY_BANK_NAME = "bank.bin"


@dataclass(frozen=True)
class Conversion:
    """What ``convert_release`` did: the two documents, and each pinned file's size before and after."""

    old: dict[str, Any]
    new: dict[str, Any]
    sizes: dict[str, tuple[int, int]]


def compact_json(doc: Any) -> bytes:
    """A document as compact JSON: no indentation, no space after a separator, non-ASCII
    characters as themselves, one trailing newline (as the house writer ends a file)."""
    return (json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _out_folder(out: Path) -> bool:
    """Make sure ``out`` can be written to. Returns whether it already existed (empty)."""
    if out.exists():
        if not out.is_dir():
            raise ReleaseError(f"{out} exists and is not a folder")
        if any(out.iterdir()):
            raise ReleaseError(f"{out} is not empty; give a new or empty folder")
        return True
    return False


def convert_release(release: str | Path, out: str | Path) -> Conversion:
    """Write the converted form of the release document ``release`` into the folder ``out``.

    The release must pass ``verify_release``, and ``out`` must not exist or be empty. The new
    release document gets the source document's file name. Raises ``ReleaseError`` naming
    every problem; then nothing is left in ``out``.
    """
    release, out = Path(release), Path(out)
    doc = verify_release(release)
    root = release.parent
    existed = _out_folder(out)

    files: dict[str, bytes] = {}          # relative path in out -> bytes
    sizes: dict[str, tuple[int, int]] = {}
    new = copy.deepcopy(doc)

    def seal(block: dict[str, Any], path: str, body: bytes) -> None:
        sizes[path] = (block["bytes"], len(body))
        block.update({"path": path, "sha256": sha256_hex(body), "bytes": len(body)})
        files[path] = body

    for label in ("detector", "recognizer"):
        path = doc[label]["path"]
        files[path] = (root / path).read_bytes()

    bank_path = doc["bank"]["path"]
    bank_body = (root / bank_path).read_bytes()
    if is_binary_bank(bank_body):
        new_bank_path, new_bank_body = bank_path, bank_body
    else:
        try:
            new_bank_body = encode(read_json(root / bank_path))
        except ValueError as error:
            raise ReleaseError(f"bank: {error}") from None
        new_bank_path = str(PurePosixPath(bank_path).with_name(BINARY_BANK_NAME))
    seal(new["bank"], new_bank_path, new_bank_body)

    groups_path = doc["identity"]["groups"]["path"]
    groups_body = (root / groups_path).read_bytes()
    old_sha, new_sha = doc["bank"]["sha256"], new["bank"]["sha256"]
    if old_sha != new_sha:
        text = groups_body.decode("utf-8")
        if text.count(old_sha) != 1:
            raise ReleaseError(f"identity.groups: {groups_path} does not name the bank's SHA-256 exactly once")
        expected = json.loads(text)
        expected["bank"]["sha256"] = new_sha
        groups_body = text.replace(old_sha, new_sha).encode("utf-8")
        if json.loads(groups_body) != expected:
            raise ReleaseError(f"identity.groups: {groups_path} names the bank's SHA-256 outside its bank block")
    seal(new["identity"]["groups"], groups_path, groups_body)

    catalog_path = doc["catalog"]["path"]
    catalog_doc = read_json(root / catalog_path)
    catalog_body = compact_json(catalog_doc)
    if json.loads(catalog_body) != catalog_doc:
        raise ReleaseError("catalog: the compact form does not read back as the same document")
    seal(new["catalog"], catalog_path, catalog_body)

    paths = [PurePosixPath(path) for path in files]
    if len(set(paths)) != len(paths) or PurePosixPath(release.name) in paths:
        raise ReleaseError("two of the converted release's files would have the same name")

    new = with_id(new)
    try:
        out.mkdir(parents=True, exist_ok=True)
        for path, body in files.items():
            target = out / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        (out / release.name).write_bytes(canonical_bytes(new))
        errors = release_errors(new, out)
        if errors:
            raise ReleaseError(errors)
    except BaseException:
        shutil.rmtree(out, ignore_errors=True)
        if existed:
            out.mkdir(parents=True, exist_ok=True)
        raise
    return Conversion(old=doc, new=new, sizes=sizes)


__all__ = ["BINARY_BANK_NAME", "Conversion", "compact_json", "convert_release"]
