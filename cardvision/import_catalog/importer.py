# SPDX-License-Identifier: Apache-2.0
"""Turn a card list into a catalog (``cardvision.core.catalog``).

The input is a file of rows, one card a row: CSV, TSV, or JSON (a list of objects, or an object
whose ``cards`` is that list), in UTF-8 with or without a byte-order mark. Five columns have a
place in the catalog, and are found by their header unless the caller names them:

=============  ===========================================  ==================
field          headers found by themselves                  catalog key
=============  ===========================================  ==================
``id``         id, card id, code                            ``id``
``name``       name, card name                              ``name``
``kind``       kind, type                                   ``kind``
``printing_of`` printing_of, printingOf, reprint of         ``printingOf``
``image``      image, art, image url, image file            ``art``
=============  ===========================================  ==================

Headers are compared without case, and spaces, underscores and dashes count as one space.
``id`` and ``name`` are needed. Every other column becomes a facet when the caller says so
(``facets``: its values are numbers when every value is one), goes to the card's ``extra``
object, or is left out. By default every column that is not a field or a facet goes to
``extra``, and the report lists them, so that the person can choose. An empty cell is left
out, never written as ``""``.

The ``image`` column holds a file path or an ``http(s)`` URL. A path is relative to the
folder of images (``images``). A URL is written as the card's ``art`` as it is, and nothing is
downloaded, unless the caller asks (``download``). It is then downloaded into ``art_out``, once
per URL, one request at a time with ``delay`` seconds between requests, and the card's ``art``
becomes the file's name there. A file already there is not downloaded again, so a run that stopped can be run
again. A file is kept only when its first bytes say JPEG, PNG or WebP and it is at most
``max_bytes`` long; a download that fails leaves the card without art (``"art": null``) and
the reason in the report. A request that failed for a reason that may pass (a server error, a
timeout, a dropped connection, a body cut short, HTTP 429) is made once more, and never more
than once. A redirect is followed only to another http(s) address, and never from https to
http. Characters a URL may not hold as they are (a space) are percent-encoded for the request;
the report gives the URL as the list does.

Before anything is written the rows are checked, and these are errors that write nothing: a
row with no id or no name, an id used twice, and a ``printing_of`` that names no card (or,
under ``"identity": "printing"``, a card that is itself a printing). The finished document is
then checked by the catalog's own loader. The report also lists, without stopping: names that
several ids share, one image file (the same bytes) under several cards, the cards without
art, the shapes of the ids, and the identity rule it suggests: ``"printing"`` when the list
uses ``printing_of``, ``"name"`` otherwise, with the groups of one name that decide it.
"""

from __future__ import annotations

import csv
import hashlib
import http.client
import io
import json
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

import cardvision
from cardvision.core.catalog import (
    FACET_KEY_PATTERN,
    IDENTITY_NAME,
    IDENTITY_PRINTING,
    IDENTITY_RULES,
    CatalogError,
    is_url,
    load_catalog,
    parse_catalog,
)
from cardvision.core.files import write_text_atomic
from cardvision.core.tls import CERTIFICATE_HELP, CertificatesMissing, is_certificate_failure, tls_context

# The catalog fields a column can fill, and the headers that fill them by themselves (compared
# as ``_norm`` gives them).
FIELDS = ("id", "name", "kind", "printing_of", "image")
AUTO_HEADERS = {
    "id": ("id", "card id", "code"),
    "name": ("name", "card name"),
    "kind": ("kind", "type"),
    "printing_of": ("printing of", "printingof", "reprint of"),
    "image": ("image", "art", "image url", "image file"),
}
# Other names a caller may give a field in a mapping: the catalog's own keys.
FIELD_NAMES = {**{name: name for name in FIELDS}, "printingOf": "printing_of", "art": "image"}

FORMATS = ("csv", "tsv", "json")
_SUFFIX_FORMATS = {".csv": "csv", ".tsv": "tsv", ".tab": "tsv", ".json": "json"}

# The largest image file kept, and the image types kept, by their first bytes.
MAX_IMAGE_BYTES = 5 * 1024 * 1024
IMAGE_SUFFIXES = (".jpg", ".png", ".webp")
DEFAULT_DELAY = 1.0
DEFAULT_TIMEOUT = 60.0

_NUMBER = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")
_INTEGER = re.compile(r"^[+-]?\d+$")
_LEADING_ZERO = re.compile(r"^[+-]?0\d")  # "008" is a code, not the number 8
_FACET_KEY = re.compile(FACET_KEY_PATTERN)


class CatalogImportError(ValueError):
    """The import cannot start, or cannot go on: a file that cannot be read, a column that is
    not there, options that contradict each other. The message says which."""


@dataclass
class ImportOptions:
    """What the caller decides. Column names are headers of the input, matched exactly, else
    without case as ``_norm`` compares them.

    Attributes:
        game, locale: the catalog's ``game`` and ``locale``.
        identity: ``"name"`` or ``"printing"``; ``None`` takes the rule the report suggests.
        mapping: field (``FIELDS``, or ``printingOf`` and ``art``) to the column that fills it,
            over the headers found by themselves.
        facets: the columns that become facets, in the order of their filters.
        splits: column to the text that separates its values (``";"``): a cell then holds a
            list of values.
        extra: the columns that go to ``extra``; ``None`` sends every column that is no field
            and no facet.
        images: the folder that the image column's file paths are relative to.
        art_out: where downloaded images go.
        download: download the images given as URLs into ``art_out``; without it they stay URLs
            and nothing reaches the network.
        delay: seconds between two requests.
        max_bytes: the largest image file kept.
        timeout: seconds a request may take.
        input_format: ``"csv"``, ``"tsv"`` or ``"json"``; ``None`` goes by the file's suffix.
    """

    game: str
    locale: str = "en"
    identity: str | None = None
    mapping: Mapping[str, str] = field(default_factory=dict)
    facets: Sequence[str] = ()
    splits: Mapping[str, str] = field(default_factory=dict)
    extra: Sequence[str] | None = None
    images: Path | None = None
    art_out: Path | None = None
    download: bool = False
    delay: float = DEFAULT_DELAY
    max_bytes: int = MAX_IMAGE_BYTES
    timeout: float = DEFAULT_TIMEOUT
    input_format: str | None = None


@dataclass
class ImportReport:
    """What an import read, wrote and found. ``errors`` empty and ``written`` set: a catalog
    was written. Any error: nothing was written."""

    source: str = ""
    format: str = ""
    rows: int = 0
    blank_rows: int = 0
    cards: int = 0
    written: str | None = None
    columns: dict[str, str] = field(default_factory=dict)
    facets: list[dict[str, Any]] = field(default_factory=list)
    extra: list[str] = field(default_factory=list)
    extra_by_default: bool = True
    left_out: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    same_name: list[dict[str, Any]] = field(default_factory=list)
    shared_images: list[list[str]] = field(default_factory=list)
    without_art: list[dict[str, str]] = field(default_factory=list)
    id_shapes: list[dict[str, Any]] = field(default_factory=list)
    identity: dict[str, Any] = field(default_factory=dict)
    downloads: dict[str, Any] = field(default_factory=lambda: {"requests": 0, "downloaded": 0, "present": 0,
                                                               "failed": 0})
    art_base: str | None = None
    art_check: dict[str, Any] | None = None
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        """The report as JSON-ready data (the ``--report`` file)."""
        return {
            "source": self.source, "format": self.format, "rows": self.rows, "blankRows": self.blank_rows,
            "cards": self.cards, "written": self.written, "columns": self.columns, "facets": self.facets,
            "extra": self.extra, "extraByDefault": self.extra_by_default, "leftOut": self.left_out,
            "errors": self.errors, "sameName": self.same_name, "sharedImages": self.shared_images,
            "withoutArt": self.without_art, "idShapes": self.id_shapes, "identity": self.identity,
            "downloads": self.downloads, "artBase": self.art_base, "artCheck": self.art_check, "notes": self.notes,
        }

    def lines(self, listed: int = 20) -> list[str]:
        """The report as lines of text. At most ``listed`` entries of a list are written out."""
        def some(items: Sequence[str]) -> str:
            return ", ".join(items[:listed]) + (f", and {len(items) - listed} more" if len(items) > listed else "")

        out = [f"read {self.source} ({self.format}): {self.rows} row(s)"
               + (f", {self.blank_rows} blank row(s) skipped" if self.blank_rows else "")]
        if self.columns:
            out.append("columns: " + ", ".join(f"{name} <- {header!r}" for name, header in self.columns.items()))
        for facet in self.facets:
            split = f", split on {facet['split']!r}" if facet.get("split") else ""
            why = f"; text, since {facet['why']}" if facet.get("why") else ""
            out.append(f"facet {facet['key']!r} <- {facet['column']!r} ({facet['type']}{split}{why})")
        numbers = [facet["column"] for facet in self.facets if facet["type"] == "number"]
        if numbers:
            out.append(f"taken as numbers (every value is one): {', '.join(numbers)}")
        if self.extra:
            how = "every column that is no field and no facet" if self.extra_by_default else "as asked"
            out.append(f"extra ({how}): {some(self.extra)}")
            if self.extra_by_default:
                out.append("  Choose with --extra COL,... (only those), --facets COL,... (filters), or --no-extra.")
        if self.left_out:
            out.append(f"left out: {some(self.left_out)}")
        if self.errors:
            out.append(f"errors ({len(self.errors)}); nothing was written:")
            out += [f"  {error}" for error in self.errors[:listed]]
            if len(self.errors) > listed:
                out.append(f"  and {len(self.errors) - listed} more")
        if self.identity:
            rule, suggested = self.identity.get("rule"), self.identity.get("suggested")
            given = "as given" if self.identity.get("given") else "suggested; pass --identity to choose"
            out.append(f'identity: "{rule}" ({given}). Suggested "{suggested}": {self.identity.get("reason")}')
        if self.same_name:
            out.append(f"one name under several ids ({len(self.same_name)} name(s)):")
            out += [f"  {group['name']!r}: {', '.join(group['ids'])}" for group in self.same_name[:listed]]
            if len(self.same_name) > listed:
                out.append(f"  and {len(self.same_name) - listed} more")
        if self.id_shapes:
            out.append("id shapes (A a letter, 9 a digit): " + ", ".join(
                f"{shape['shape']} x{shape['count']} (e.g. {shape['example']})" for shape in self.id_shapes[:listed]))
        downloads = self.downloads
        if downloads["requests"] or downloads["present"]:
            out.append(f"images: {downloads['downloaded']} downloaded, {downloads['present']} already present, "
                       f"{downloads['failed']} failed ({downloads['requests']} request(s))")
        if self.without_art:
            out.append(f"cards without art ({len(self.without_art)}):")
            out += [f"  {entry['id']}: {entry['reason']}" for entry in self.without_art[:listed]]
            if len(self.without_art) > listed:
                out.append(f"  and {len(self.without_art) - listed} more")
        if self.shared_images:
            out.append(f"one image file under several cards ({len(self.shared_images)} group(s)):")
            out += [f"  {some(group)}" for group in self.shared_images[:listed]]
        if self.art_check is not None:
            check = self.art_check
            out.append(f"check-bank-art on {self.art_base}: {check['usable']} with a usable image, "
                       f"{len(check['missing'])} with no image, {len(check['unreadable'])} unreadable")
            out += [f"  {line}" for line in check["lines"]]
        out += [f"note: {note}" for note in self.notes]
        if self.written:
            out.append(f"wrote {self.written}: {self.cards} card(s)")
        return out


# ------------------------------------------------------------------------------------ reading
def _norm(header: str) -> str:
    """A header as headers are compared: no case, and spaces, underscores and dashes as one space."""
    return re.sub(r"[\s_\-]+", " ", str(header)).strip().casefold()


def _format_of(path: Path, given: str | None) -> str:
    if given is not None:
        if given not in FORMATS:
            raise CatalogImportError(f"unknown format {given!r}; expected one of {list(FORMATS)}")
        return given
    found = _SUFFIX_FORMATS.get(path.suffix.lower())
    if found is None:
        raise CatalogImportError(f"{path.name}: cannot tell the format from the suffix {path.suffix!r}; "
                                 f"name it .csv, .tsv or .json, or pass --format")
    return found


def read_rows(path: str | Path, input_format: str | None = None) -> tuple[list[dict[str, Any]], list[str], str]:
    """The rows of a card list, its headers in order, and its format.

    A CSV or TSV row maps each header to its cell (a string). A JSON row is the object as it
    is; its headers are the keys of all rows in order of first appearance. Raises
    ``CatalogImportError`` when the file cannot be read as that format.
    """
    path = Path(path)
    kind = _format_of(path, input_format)
    try:
        text = path.read_bytes().decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise CatalogImportError(f"{path.name}: not UTF-8 text ({error.reason} at byte {error.start}); "
                                 "save it as UTF-8") from None
    except OSError as error:
        raise CatalogImportError(f"{path}: {error.strerror or error}") from None
    if kind == "json":
        try:
            doc = json.loads(text)
        except json.JSONDecodeError as error:
            raise CatalogImportError(f"{path.name}: not valid JSON: {error}") from None
        rows = doc.get("cards") if isinstance(doc, dict) else doc
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise CatalogImportError(f'{path.name}: expected a list of objects, or an object whose "cards" is one')
        headers: list[str] = []
        for row in rows:
            headers += [key for key in row if key not in headers]
        return rows, headers, kind
    reader = csv.reader(io.StringIO(text, newline=""), delimiter="," if kind == "csv" else "\t")
    try:
        table = list(reader)
    except csv.Error as error:
        raise CatalogImportError(f"{path.name}: not readable as {kind.upper()}: {error}") from None
    if not table:
        raise CatalogImportError(f"{path.name}: the file is empty")
    headers = [header.strip() for header in table[0]]
    for position, header in enumerate(headers):
        if header in headers[:position]:
            raise CatalogImportError(f"{path.name}: the header {header!r} is used twice")
    rows = []
    for number, cells in enumerate(table[1:], start=1):
        if len(cells) > len(headers) and any(cell.strip() for cell in cells[len(headers):]):
            raise CatalogImportError(f"{path.name}: row {number} has {len(cells)} cells and the header "
                                     f"{len(headers)} (a {'comma' if kind == 'csv' else 'tab'} inside a cell "
                                     "must be quoted)")
        rows.append({header: cells[i] if i < len(cells) else "" for i, header in enumerate(headers) if header})
    return rows, [header for header in headers if header], kind


def _column(headers: Sequence[str], wanted: str, what: str) -> str:
    """The header ``wanted`` names: itself, or the one header equal to it as ``_norm`` compares."""
    if wanted in headers:
        return wanted
    found = [header for header in headers if _norm(header) == _norm(wanted)]
    if len(found) == 1:
        return found[0]
    if found:
        raise CatalogImportError(f"{what}: {wanted!r} matches several columns: {found}")
    raise CatalogImportError(f"{what}: no column {wanted!r} (the columns are {list(headers)})")


def _empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "") or value == [] or value == {}


def _text(value: Any, what: str) -> str:
    """A field's value as text: a string stripped, or a number written out."""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    raise ValueError(f"{what} must be text or a number, not {json.dumps(value)}")


def _values(value: Any, separator: str | None) -> list[Any]:
    """A cell as a list of values: split when it has a separator, a JSON list as it is; empty
    values and repeats dropped."""
    if isinstance(value, list):
        items = value
    elif isinstance(value, str) and separator:
        items = value.split(separator)
    else:
        items = [value]
    out: list[Any] = []
    for item in items:
        item = item.strip() if isinstance(item, str) else item
        if not _empty(item) and item not in out:
            out.append(item)
    return out


def _number(value: Any) -> int | float | None:
    """A facet value as a number, or None when it is not one."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str) and _NUMBER.fullmatch(value):
        return int(value) if _INTEGER.fullmatch(value) else float(value)
    return None


def _facet_key(header: str) -> str | None:
    """A facet key from a header: its words in camel case (``Sub Type`` is ``subType``), or
    None when that is no facet key."""
    words = re.findall(r"[A-Za-z0-9]+", header)
    if not words:
        return None
    parts = [word.lower() if word.isupper() else word for word in words]
    key = parts[0][:1].lower() + parts[0][1:] + "".join(part[:1].upper() + part[1:] for part in parts[1:])
    return key if _FACET_KEY.fullmatch(key) and key != "kind" else None


def _shape(card_id: str) -> str:
    return re.sub(r"[0-9]", "9", re.sub(r"[a-z]", "a", re.sub(r"[A-Z]", "A", card_id)))


# ------------------------------------------------------------------------------------- images
def sniff_image(data: bytes) -> str | None:
    """The suffix of an image file by its first bytes: ``.jpg``, ``.png`` or ``.webp``; None
    for anything else."""
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


class _Failure(Exception):
    """A download that failed; ``again`` when one more try may succeed."""

    def __init__(self, reason: str, again: bool = False) -> None:
        super().__init__(reason)
        self.again = again


class _HttpOnlyRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to another http(s) address, and never from https down to http.
    A refusal is a ``_Failure`` that names the address, not the redirect's status."""

    def http_error_302(self, req, fp, code, msg, headers):  # noqa: ANN001, ANN201 - urllib's signature
        # urllib refuses a scheme it does not follow before redirect_request is asked, with an
        # HTTPError that names only the status; look at the address first, to say why.
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
        if not is_url(newurl):
            scheme = urllib.parse.urlsplit(newurl).scheme or "a relative address"
            raise _Failure(f"redirect to {scheme}: refused ({newurl}); only http and https are followed")
        if req.full_url.lower().startswith("https://") and newurl.lower().startswith("http://"):
            raise _Failure(f"redirect from https to http refused ({newurl})")


def request_url(url: str) -> str:
    """A URL as it is requested: characters a URL may not hold as they are (a space, a letter
    outside ASCII) percent-encoded, and existing escapes kept."""
    return urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%~")


class _Downloader:
    """One request at a time, ``delay`` seconds apart, each failure that may pass tried once more."""

    def __init__(self, options: ImportOptions, report: ImportReport, sleep: Callable[[float], None]) -> None:
        self.options, self.report, self.sleep = options, report, sleep
        # One opener for every request, with this package's certificates even for a request
        # that starts on http and is redirected to https.
        self.opener = urllib.request.build_opener(_HttpOnlyRedirects(),
                                                  urllib.request.HTTPSHandler(context=tls_context()))
        self.requested = False

    def _get(self, url: str) -> bytes:
        if self.requested and self.options.delay > 0:
            self.sleep(self.options.delay)
        self.requested = True
        self.report.downloads["requests"] += 1
        limit = self.options.max_bytes
        try:
            request = urllib.request.Request(request_url(url), headers={
                "User-Agent": f"cardvision/{cardvision.__version__} import-catalog"})
            with self.opener.open(request, timeout=self.options.timeout) as response:
                length = response.headers.get("Content-Length")
                expected = int(length) if length is not None and length.strip().isdigit() else None
                if expected is not None and expected > limit:
                    raise _Failure(f"larger than {limit} bytes ({expected})")
                data = response.read(limit + 1)  # the cap holds while reading, with or without a length
        except urllib.error.HTTPError as error:
            raise _Failure(f"HTTP {error.code}", again=error.code >= 500 or error.code == 429) from None
        except http.client.IncompleteRead as error:
            raise _Failure(f"the body was cut short ({len(error.partial)} bytes)", again=True) from None
        except (urllib.error.URLError, socket.timeout, ConnectionError, TimeoutError) as error:
            if is_certificate_failure(error):
                raise CertificatesMissing(f"{url}: {CERTIFICATE_HELP}") from None
            reason = getattr(error, "reason", error)
            raise _Failure(f"request failed ({reason})", again=True) from None
        except http.client.InvalidURL as error:  # before HTTPException, which it also is
            raise _Failure(f"not a URL that can be requested ({error})") from None
        except http.client.HTTPException as error:  # a reply that is not HTTP
            raise _Failure(f"not a valid HTTP reply ({type(error).__name__}: {error})", again=True) from None
        except ValueError as error:  # a URL that cannot be requested (http.client.InvalidURL among them)
            raise _Failure(f"not a URL that can be requested ({error})") from None
        if len(data) > limit:
            raise _Failure(f"larger than {limit} bytes")
        if expected is not None and len(data) != expected:
            raise _Failure(f"the body was cut short ({len(data)} of {expected} bytes)", again=True)
        return data

    def fetch(self, url: str) -> bytes:
        try:
            return self._get(url)
        except _Failure as failure:
            if not failure.again:
                raise
        return self._get(url)  # once more, and never again


def _stems(card_ids: Sequence[str]) -> dict[str, str]:
    """A file name stem for each card id: the id with every character but letters, digits, dot,
    dash and underscore as ``_``; two ids with one stem get a part of their id's hash added."""
    stems = {card_id: re.sub(r"^\.", "_", re.sub(r"[^A-Za-z0-9._-]", "_", card_id)) for card_id in card_ids}
    count: dict[str, int] = {}
    for stem in stems.values():
        count[stem.casefold()] = count.get(stem.casefold(), 0) + 1
    return {card_id: stem if count[stem.casefold()] == 1 else f"{stem}-{hashlib.sha256(card_id.encode()).hexdigest()[:8]}"
            for card_id, stem in stems.items()}


def _present(folder: Path, stem: str) -> Path | None:
    for suffix in IMAGE_SUFFIXES:
        if (folder / (stem + suffix)).is_file():
            return folder / (stem + suffix)
    return None


def _write_bytes(path: Path, data: bytes) -> None:
    """Write a file whole or not at all: a stopped run leaves no half image to be taken for a whole one."""
    partial = path.with_name(path.name + ".partial")  # never one of the names ``_present`` looks for
    try:
        partial.write_bytes(data)
        os.replace(partial, path)
    finally:
        if partial.exists():
            partial.unlink()


def _local_art(value: str, images: Path | None) -> tuple[str | None, str | None]:
    """An image path as the catalog's ``art``, relative to ``images``: ``(art, None)``, or
    ``(None, the reason)`` when it cannot be one."""
    value = value.replace("\\", "/")
    if "://" in value:
        return None, f"{value!r} uses an unsupported URL scheme (only http and https)"
    absolute = PurePosixPath(value).is_absolute() or PureWindowsPath(value).drive != ""
    if absolute:
        if images is None:
            return None, f"{value!r} is an absolute path; pass --images with the folder that holds it"
        try:
            value = Path(value).resolve().relative_to(images.resolve()).as_posix()
        except ValueError:
            return None, f"{value!r} is outside --images {images}"
    if ".." in PurePosixPath(value).parts:
        return None, f"{value!r} goes outside the images folder (..)"
    return value, None


# ------------------------------------------------------------------------------------- import
@dataclass
class _Row:
    number: int
    id: str
    name: str
    kind: str | None
    printing_of: str | None
    image: str | None
    facets: dict[str, list[Any]]
    extra: dict[str, Any]


def _resolve_columns(headers: Sequence[str], options: ImportOptions, report: ImportReport) -> dict[str, str]:
    columns: dict[str, str] = {}
    for name, header in options.mapping.items():
        if name not in FIELD_NAMES:
            raise CatalogImportError(f"--map {name}=...: unknown field {name!r}; the fields are "
                                     f"{', '.join(FIELDS)}")
        columns[FIELD_NAMES[name]] = _column(headers, header, f"--map {name}")
    for name in FIELDS:
        if name in columns:
            continue
        found = [header for header in headers if _norm(header) in AUTO_HEADERS[name] and header not in
                 columns.values()]
        if len(found) > 1:
            raise CatalogImportError(f"columns {found} could each be the {name}; choose one with --map {name}=HEADER")
        if found:
            columns[name] = found[0]
    for name in ("id", "name"):
        if name not in columns:
            raise CatalogImportError(f"no column for the card's {name}: name it with --map {name}=HEADER "
                                     f"(the columns are {list(headers)})")
    used = list(columns.values())
    for header in used:
        if used.count(header) > 1:
            raise CatalogImportError(f"the column {header!r} is mapped to more than one field")
    report.columns = {name: columns[name] for name in FIELDS if name in columns}
    return columns


def import_catalog(source: str | Path, out: str | Path, options: ImportOptions, force: bool = False,
                   sleep: Callable[[float], None] = time.sleep,
                   progress: Callable[[str], None] | None = None) -> ImportReport:
    """Read a card list, write the catalog ``out``, and report.

    Refuses to replace an existing ``out`` unless ``force``. Raises ``CatalogImportError`` for
    what stops the import before any row is looked at (the file, a column, the options), and
    ``CertificatesMissing`` when an https server's certificate cannot be verified. Errors in
    the rows are in the report's ``errors``, and then nothing is written. ``progress`` is
    told of each download.
    """
    source, out = Path(source), Path(out)
    if out.exists() and not force:
        raise CatalogImportError(f"{out} exists; pass --force to replace it")
    if options.identity is not None and options.identity not in IDENTITY_RULES:
        raise CatalogImportError(f"--identity must be one of {list(IDENTITY_RULES)}, not {options.identity!r}")
    if not isinstance(options.game, str) or not options.game.strip():
        raise CatalogImportError("--game must be a short name for the game")
    report = ImportReport(source=str(source))
    rows, headers, report.format = read_rows(source, options.input_format)
    columns = _resolve_columns(headers, options, report)

    taken = set(columns.values())
    splits = {_column(headers, column, "--split"): separator for column, separator in options.splits.items()}
    facet_columns: list[str] = []
    keys: dict[str, str] = {}
    for wanted in options.facets:
        column = _column(headers, wanted, "--facets")
        if column in taken or column in facet_columns:
            raise CatalogImportError(f"--facets: the column {column!r} is already "
                                     + ("a facet" if column in facet_columns else "a field"))
        key = _facet_key(column)
        if key is None:
            raise CatalogImportError(f"--facets: no facet key can be made from the column {column!r} (a key is a "
                                     "lowercase letter, then letters and digits, and not kind); rename the column")
        if key in keys:
            raise CatalogImportError(f"--facets: the columns {keys[key]!r} and {column!r} both make the key {key!r}")
        keys[key] = column
        facet_columns.append(column)
    taken |= set(facet_columns)
    if options.extra is None:
        extra_columns = [header for header in headers if header not in taken]
        report.extra_by_default = True
    else:
        extra_columns = []
        for wanted in options.extra:
            column = _column(headers, wanted, "--extra")
            if column in taken:
                raise CatalogImportError(f"--extra: the column {column!r} is already a field or a facet")
            if column not in extra_columns:
                extra_columns.append(column)
        report.extra_by_default = False
    for column in splits:
        if column not in facet_columns and column not in extra_columns:
            raise CatalogImportError(f"--split: the column {column!r} is neither a facet nor in extra")
    report.extra = list(extra_columns)
    report.left_out = [header for header in headers if header not in taken and header not in extra_columns]

    # -- the rows
    parsed: list[_Row] = []
    for number, row in enumerate(rows, start=1):
        report.rows += 1
        if all(_empty(value) for value in row.values()):
            report.blank_rows += 1
            continue
        fields: dict[str, str | None] = {}
        bad = False
        for name, column in columns.items():
            value = row.get(column)
            try:
                fields[name] = None if _empty(value) else _text(value, f"row {number}: {column!r}")
            except ValueError as error:
                report.errors.append(str(error))
                bad = True
        for name in ("id", "name"):
            if not bad and not fields.get(name):
                report.errors.append(f"row {number}: no {name} (column {columns[name]!r} is empty)")
                bad = True
        facets: dict[str, list[Any]] = {}
        for column in facet_columns:
            values = [] if _empty(row.get(column)) else _values(row.get(column), splits.get(column))
            for value in values:
                if _number(value) is None and not isinstance(value, str):
                    report.errors.append(f"row {number}: {column!r}: {json.dumps(value)} is not a facet value "
                                         "(text or a number)")
                    bad = True
            if values:
                facets[_facet_key(column)] = values  # type: ignore[index]
        extra: dict[str, Any] = {}
        for column in extra_columns:
            value = row.get(column)
            if _empty(value):
                continue
            if column in splits:
                extra[column] = _values(value, splits[column])
            else:
                extra[column] = value.strip() if isinstance(value, str) else value
        if not bad:
            parsed.append(_Row(number, fields["id"], fields["name"], fields.get("kind"),  # type: ignore[arg-type]
                               fields.get("printing_of"), fields.get("image"), facets, extra))

    # -- ids, names and printings
    first: dict[str, int] = {}
    for row in parsed:
        if row.id in first:
            report.errors.append(f"row {row.number}: the id {row.id!r} is used twice (first in row {first[row.id]})")
        else:
            first[row.id] = row.number
    by_id = {row.id: row for row in parsed}
    for row in parsed:
        if row.printing_of is not None and row.printing_of not in by_id:
            report.errors.append(f"row {row.number}: printing_of {row.printing_of!r} names no card")
        elif row.printing_of == row.id:
            report.errors.append(f"row {row.number}: printing_of names the card itself")
    names: dict[str, list[str]] = {}
    for row in parsed:
        names.setdefault(row.name, [])
        if row.id not in names[row.name]:
            names[row.name].append(row.id)
    report.same_name = [{"name": name, "ids": ids} for name, ids in names.items() if len(ids) > 1]
    printings = [row for row in parsed if row.printing_of is not None]
    if printings:
        suggested = IDENTITY_PRINTING
        apart = [group for group in report.same_name
                 if len({by_id[card_id].printing_of or card_id for card_id in group["ids"]}) > 1]
        reason = (f"{len(printings)} card(s) name the card they are a printing of, so printing_of says which "
                  "entries are one card"
                  + (f"; {len(apart)} name(s) are shared by cards that printing_of does not join, which stay "
                     "different cards" if apart else ""))
    else:
        suggested = IDENTITY_NAME
        reason = ("no card names one it is a printing of, so cards with one name are one card"
                  + (f" ({len(report.same_name)} name(s) under several ids, listed below: if any of them is "
                     "different cards, fill in printing_of and use --identity printing)" if report.same_name else ""))
    rule = options.identity or suggested
    report.identity = {"rule": rule, "given": options.identity is not None, "suggested": suggested,
                       "reason": reason}
    if rule == IDENTITY_PRINTING:
        for row in printings:
            base = by_id.get(row.printing_of)  # type: ignore[arg-type]
            if base is not None and base is not row and base.printing_of is not None:
                report.errors.append(f"row {row.number}: printing_of {row.printing_of!r} is itself a printing of "
                                     f"{base.printing_of!r}; under \"identity\": \"printing\" a printing names the card "
                                     "itself (or use --identity name)")
    shapes: dict[str, list[Any]] = {}
    for row in parsed:
        entry = shapes.setdefault(_shape(row.id), [0, row.id])
        entry[0] += 1
    report.id_shapes = [{"shape": shape, "count": count, "example": example}
                        for shape, (count, example) in sorted(shapes.items(), key=lambda item: (-item[1][0], item[0]))]
    if report.errors:
        return report

    # -- facets: numbers when every value is one
    declarations = []
    for column in facet_columns:
        key = _facet_key(column)
        values = [value for row in parsed for value in row.facets.get(key, ())]  # type: ignore[arg-type]
        zeros = [value for value in values if isinstance(value, str) and _LEADING_ZERO.match(value)]
        numeric = bool(values) and not zeros and all(_number(value) is not None for value in values)
        for row in parsed:
            if key in row.facets:
                row.facets[key] = [_number(value) if numeric else (value if isinstance(value, str) else
                                                                   json.dumps(value)) for value in row.facets[key]]
                deduped: list[Any] = []
                for value in row.facets[key]:  # "3" and "3.0" are one number
                    if value not in deduped:
                        deduped.append(value)
                row.facets[key] = deduped
        declaration = {"key": key, "label": column[:1].upper() + column[1:] if column.islower() else column}
        if numeric:
            declaration["type"] = "number"
        declarations.append(declaration)
        report.facets.append({"column": column, "key": key, "type": "number" if numeric else "text",
                              **({"split": splits[column]} if column in splits else {}),
                              **({"why": f"a value has a leading zero ({zeros[0]})"} if zeros else {})})

    # -- images
    arts = _images(parsed, options, out, report, sleep, progress)

    # -- the catalog
    doc: dict[str, Any] = {"game": options.game.strip(), "locale": options.locale, "identity": rule}
    if declarations:
        doc["facets"] = declarations
    cards = []
    for row in parsed:
        card: dict[str, Any] = {"id": row.id, "name": row.name, "kind": row.kind, "printingOf": row.printing_of,
                                "art": arts.get(row.id)}
        if row.facets:
            card["facets"] = {key: values[0] if len(values) == 1 else values for key, values in row.facets.items()}
        if row.extra:
            card["extra"] = row.extra
        cards.append(card)
    doc["cards"] = cards
    try:
        parse_catalog(doc, source=out.name)
    except CatalogError as error:
        report.errors.append(str(error))
        return report
    out.parent.mkdir(parents=True, exist_ok=True)
    write_text_atomic(out, catalog_text(doc))
    catalog = load_catalog(out)
    report.written, report.cards = str(out), len(catalog)

    # -- the existing art check, when every image is a local file
    base = Path(report.art_base) if report.art_base else None
    if any(card["art"] is not None and is_url(card["art"]) for card in cards):
        report.notes.append("some art is a URL, so the images were not checked here; run cardvision check-bank-art")
    elif base is not None and catalog.ids_with_art():
        from cardvision.bank.art import check_art
        from cardvision.bank.suspect import suspect_lines

        found = check_art(catalog, base)
        report.art_check = {"usable": len(found.usable), "missing": found.missing,
                            "unreadable": [list(entry) for entry in found.unreadable],
                            "lines": suspect_lines(found.suspects)}
        if found.missing:
            report.art_check["lines"].insert(0, f"no image under {base}, for example: {', '.join(found.missing[:5])}")
    elif base is None and catalog.ids_with_art():
        report.notes.append("the images were not checked: pass --images with the folder the image paths are in")
    return report


def _images(rows: Sequence[_Row], options: ImportOptions, out: Path, report: ImportReport,
            sleep: Callable[[float], None], progress: Callable[[str], None] | None) -> dict[str, str | None]:
    """Each card's ``art``: a path relative to the art folder, a URL, or None; downloads what is
    to be downloaded, and records in the report the cards without art and the image files
    under several cards."""
    arts: dict[str, str | None] = {}
    urls = [row for row in rows if row.image is not None and is_url(row.image)]
    paths = [row for row in rows if row.image is not None and not is_url(row.image)]
    download = bool(urls) and options.download
    art_out = options.art_out if options.art_out is not None else out.parent / "art"
    if download and paths and (options.images is None or options.images.resolve() != art_out.resolve()):
        raise CatalogImportError(
            "the image column holds file paths and URLs, and a catalog has one art folder: pass --art-out the same "
            "folder as --images, or leave out --download to write the URLs as they are")
    report.art_base = str(art_out) if download else (str(options.images) if options.images is not None else None)
    for row in rows:
        if row.image is None:
            arts[row.id] = None
            report.without_art.append({"id": row.id, "reason": "no image in the list"})
    for row in paths:
        arts[row.id], reason = _local_art(row.image, options.images)  # type: ignore[arg-type]
        if reason:
            report.without_art.append({"id": row.id, "reason": reason})
    for row in urls if not download else ():
        arts[row.id] = row.image
    if urls and not download:
        report.notes.append(
            f"{len(urls)} image(s) are URLs and stay URLs in the catalog; nothing was downloaded. To fetch them, run "
            "again with --download --art-out DIR, and only for images you are allowed to download: prefer the "
            "source's bulk download, or files you are allowed to copy (--images)")
    if download:
        art_out.mkdir(parents=True, exist_ok=True)
        stems = _stems([row.id for row in urls])
        fetcher = _Downloader(options, report, sleep)
        done: dict[str, tuple[str | None, str | None]] = {}
        for row in urls:
            url = row.image
            if url not in done:  # each URL once: later cards with the same URL share its file
                done[url] = _fetch_one(fetcher, url, art_out, stems[row.id], options, report)  # type: ignore[index]
                if progress is not None:
                    progress(f"{row.id}: {done[url][0] or done[url][1]}")  # type: ignore[index]
            arts[row.id], reason = done[url]  # type: ignore[index]
            if reason:
                report.without_art.append({"id": row.id, "reason": f"{url}: {reason}"})
    base = Path(report.art_base) if report.art_base else None
    if base is not None:
        by_hash: dict[str, list[str]] = {}
        for row in rows:
            art = arts.get(row.id)
            if art is None or is_url(art) or not (base / art).is_file():
                continue
            digest = hashlib.sha256((base / art).read_bytes()).hexdigest()
            by_hash.setdefault(digest, []).append(row.id)
        report.shared_images = sorted((ids for ids in by_hash.values() if len(ids) > 1), key=lambda ids: ids[0])
    return arts


def _fetch_one(fetcher: _Downloader, url: str, folder: Path, stem: str, options: ImportOptions,
               report: ImportReport) -> tuple[str | None, str | None]:
    """``(art, None)`` for an image there or downloaded now, ``(None, the reason)`` otherwise."""
    present = _present(folder, stem)
    if present is not None:
        report.downloads["present"] += 1
        return present.name, None
    try:
        data = fetcher.fetch(url)
    except _Failure as failure:
        report.downloads["failed"] += 1
        return None, str(failure)
    suffix = sniff_image(data)
    if suffix is None:
        report.downloads["failed"] += 1
        return None, "not a JPEG, PNG or WebP image (by its first bytes)"
    _write_bytes(folder / (stem + suffix), data)
    report.downloads["downloaded"] += 1
    return stem + suffix, None


def catalog_text(doc: Mapping[str, Any]) -> str:
    """A catalog as the template writes one: the top-level keys on lines of their own, one card
    or facet a line."""
    lines = ["{"]
    items = list(doc.items())
    for position, (key, value) in enumerate(items):
        comma = "," if position < len(items) - 1 else ""
        if isinstance(value, list):
            lines.append(f" {json.dumps(key)}: [")
            lines += [f"  {json.dumps(item, ensure_ascii=False)}" + ("," if i < len(value) - 1 else "")
                      for i, item in enumerate(value)]
            lines.append(f" ]{comma}")
        else:
            lines.append(f" {json.dumps(key)}: {json.dumps(value, ensure_ascii=False)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"
