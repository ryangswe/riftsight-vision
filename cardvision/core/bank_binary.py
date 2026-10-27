# SPDX-License-Identifier: Apache-2.0
"""The bank in binary form (``bank.bin``): the same document, with its vectors as raw bytes.

A bank document (``cardvision.core.bank``) stores each row as base64 text inside JSON. Some
consumers cannot take a large JSON file (a browser add-on store's linter refuses any text file
over 5 MiB, for one), so the same bank can also be written as one binary file holding the same
fp16 bytes. Nothing is computed again: the values are bit for bit the ones the JSON form
stores, so a release that uses the binary form scores exactly as the one that uses JSON.

Layout, format version 1::

    bytes 0-7    magic: ASCII "CVBANK", a 0x00 byte, then the format version, 0x01
    bytes 8-11   H, an unsigned 32-bit little-endian integer
    next H bytes the header: UTF-8 JSON, one object
    the rest     entryCount x dim little-endian IEEE half floats (fp16), row by row

The header is the bank document with its ``entries`` list replaced, at the same place among
the keys, by ``"cardIds"``: the card id of each row, in row order. When any row records the
image it was embedded from (``artV``), ``"artVs"`` follows ``cardIds``: one value per row, the
row's ``artV`` or ``null``. The header keeps every other key of the document, in order, so
that ``decode`` gives back the document and the bank tools write it to the same bytes as the
original JSON file.

``decode`` refuses (``ValueError``) a wrong magic, a format version it does not know, a header
that is not a bank's (``kind``, ``version``, ``dim``, ``preprocessing``, ``entryCount`` equal to
the number of card ids, ``dtype`` fp16, no ``entries`` list, ``artVs`` one string or null per
card id when present), and a body that is not exactly ``entryCount x dim`` values long. A file
whose first bytes are not the magic is a JSON bank; ``read_bank_bytes`` tells the two apart.
"""

from __future__ import annotations

import base64
import binascii
import json
import struct
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from cardvision.core.bank import ART_VERSION_KEY, VECTOR_DTYPE

MAGIC_PREFIX = b"CVBANK\x00"
FORMAT_VERSION = 1
MAGIC = MAGIC_PREFIX + bytes([FORMAT_VERSION])
BANK_KIND = "embedding-bank"
IDS_KEY = "cardIds"
ART_VERSIONS_KEY = "artVs"
_HEADER_LENGTH = struct.Struct("<I")
_ENTRY_KEYS = (("cardId", "vec"), ("cardId", "vec", ART_VERSION_KEY))


def _is_positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def is_binary_bank(body: bytes) -> bool:
    """Whether bytes are a binary bank of some format version (they start with ``CVBANK\\0``)."""
    return bytes(body[:len(MAGIC_PREFIX)]) == MAGIC_PREFIX


def encode(doc: Mapping[str, Any]) -> bytes:
    """The binary form of a bank document. Raises ``ValueError`` for a document it cannot hold
    exactly: one that would not come back from ``decode`` as the same document."""
    if not isinstance(doc, Mapping) or not isinstance(doc.get("entries"), list):
        raise ValueError('a bank document needs an "entries" list')
    for key in (IDS_KEY, ART_VERSIONS_KEY):
        if key in doc:
            raise ValueError(f'a bank document with a top-level "{key}" key cannot be written in binary form')
    dim = doc.get("dim")
    if not _is_positive_int(dim):
        raise ValueError("the binary form needs the bank's dim, a whole number above 0")
    if doc.get("dtype", "fp16") != "fp16":
        raise ValueError(f"the binary form holds fp16 vectors, and the bank's dtype is {doc.get('dtype')!r}")
    ids: list[str] = []
    art_versions: list[str | None] = []
    chunks: list[bytes] = []
    for position, entry in enumerate(doc["entries"]):
        if not isinstance(entry, Mapping) or tuple(entry) not in _ENTRY_KEYS \
                or not isinstance(entry["cardId"], str) or not isinstance(entry["vec"], str):
            raise ValueError(f"entries[{position}] is not a cardId and a vec, and an optional {ART_VERSION_KEY}, "
                             "in that order")
        try:
            raw = base64.b64decode(entry["vec"], validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError(f"entries[{position}] ({entry['cardId']!r}): not valid base64: {error}") from None
        if len(raw) != dim * VECTOR_DTYPE.itemsize:
            raise ValueError(f"entries[{position}] ({entry['cardId']!r}) holds {len(raw)} bytes, "
                             f"not {dim} fp16 values")
        if base64.b64encode(raw).decode("ascii") != entry["vec"]:
            raise ValueError(f"entries[{position}] ({entry['cardId']!r}): the base64 text is not in its usual form")
        recorded = entry.get(ART_VERSION_KEY)
        if ART_VERSION_KEY in entry and not isinstance(recorded, str):
            raise ValueError(f"entries[{position}] ({entry['cardId']!r}): {ART_VERSION_KEY} must be text")
        ids.append(entry["cardId"])
        art_versions.append(recorded)
        chunks.append(raw)
    header: dict[str, Any] = {}
    for key, value in doc.items():
        if key == "entries":
            header[IDS_KEY] = ids
            if any(recorded is not None for recorded in art_versions):
                header[ART_VERSIONS_KEY] = art_versions
        else:
            header[key] = value
    text = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    body = MAGIC + _HEADER_LENGTH.pack(len(text)) + text + b"".join(chunks)
    back = decode(body)
    if json.dumps(back, ensure_ascii=False) != json.dumps(doc, ensure_ascii=False):
        raise ValueError("the bank document does not come back unchanged from its binary form")
    return body


def decode(body: bytes) -> dict[str, Any]:
    """The bank document a binary bank holds, with its ``entries`` as the JSON form writes them.

    Raises ``ValueError`` naming the first problem found.
    """
    body = bytes(body)
    if not is_binary_bank(body):
        raise ValueError("not a binary bank: the file does not start with CVBANK")
    if len(body) < len(MAGIC) + _HEADER_LENGTH.size:
        raise ValueError("the binary bank is cut short before its header")
    if body[len(MAGIC_PREFIX)] != FORMAT_VERSION:
        raise ValueError(f"the binary bank is of format version {body[len(MAGIC_PREFIX)]}, and this "
                         f"version of cardvision reads version {FORMAT_VERSION} only")
    (length,) = _HEADER_LENGTH.unpack_from(body, len(MAGIC))
    start = len(MAGIC) + _HEADER_LENGTH.size
    if len(body) < start + length:
        raise ValueError("the binary bank is cut short inside its header")
    try:
        header = json.loads(body[start:start + length].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("the binary bank's header is not UTF-8 JSON") from None
    if not isinstance(header, dict):
        raise ValueError("the binary bank's header is not a JSON object")
    if header.get("kind") != BANK_KIND:
        raise ValueError(f'the binary bank\'s header is not an "{BANK_KIND}" document')
    if "entries" in header:
        raise ValueError('the binary bank\'s header may not hold "entries"')
    if not _is_positive_int(header.get("version")):
        raise ValueError("the binary bank's version must be a whole number above 0")
    dim = header.get("dim")
    if not _is_positive_int(dim):
        raise ValueError("the binary bank's dim must be a whole number above 0")
    if "preprocessing" not in header:
        raise ValueError("the binary bank's header does not name its preprocessing")
    if header.get("dtype", "fp16") != "fp16":
        raise ValueError(f"the binary bank's dtype is {header.get('dtype')!r}; it holds fp16 values")
    ids = header.get(IDS_KEY)
    if not isinstance(ids, list) or not all(isinstance(card_id, str) for card_id in ids):
        raise ValueError(f'the binary bank\'s header needs "{IDS_KEY}", a list of card ids')
    if header.get("entryCount") != len(ids):
        raise ValueError(f"the binary bank's entryCount {header.get('entryCount')!r} is not its "
                         f"{len(ids)} card ids")
    art_versions = header.get(ART_VERSIONS_KEY)
    if ART_VERSIONS_KEY in header and (
            not isinstance(art_versions, list) or len(art_versions) != len(ids)
            or not all(recorded is None or isinstance(recorded, str) for recorded in art_versions)):
        raise ValueError(f'the binary bank\'s "{ART_VERSIONS_KEY}" must give one text or null per card id')
    row_bytes = dim * VECTOR_DTYPE.itemsize
    values = body[start + length:]
    if len(values) != len(ids) * row_bytes:
        raise ValueError(f"the binary bank holds {len(values)} bytes of vectors, and {len(ids)} rows of "
                         f"{dim} fp16 values are {len(ids) * row_bytes}")
    entries = []
    for row, card_id in enumerate(ids):
        entry: dict[str, Any] = {"cardId": card_id,
                                 "vec": base64.b64encode(values[row * row_bytes:(row + 1) * row_bytes]).decode("ascii")}
        if art_versions is not None and art_versions[row] is not None:
            entry[ART_VERSION_KEY] = art_versions[row]
        entries.append(entry)
    doc: dict[str, Any] = {}
    for key, value in header.items():
        if key == IDS_KEY:
            doc["entries"] = entries
        elif key != ART_VERSIONS_KEY:
            doc[key] = value
    return doc


def read_bank_bytes(body: bytes) -> Any:
    """The bank document in a bank file's bytes, binary or JSON.

    Bytes that start with the binary magic are read by ``decode``; any others are parsed as
    JSON. Raises ``ValueError`` when they are neither.
    """
    if is_binary_bank(body):
        return decode(body)
    try:
        return json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError(f"not valid JSON: {error}") from None


def read_bank_file(path: str | Path) -> Any:
    """The bank document in a bank file, binary or JSON. A file that is neither raises
    ``ValueError`` naming it."""
    path = Path(path)
    try:
        return read_bank_bytes(path.read_bytes())
    except ValueError as error:
        raise ValueError(f"{path.name}: {error}") from None


__all__ = ["FORMAT_VERSION", "MAGIC", "decode", "encode", "is_binary_bank", "read_bank_bytes", "read_bank_file"]
