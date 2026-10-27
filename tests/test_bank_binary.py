# SPDX-License-Identifier: Apache-2.0
"""The bank's binary form (``bank.bin``): its layout, the round trip, and what it refuses."""

from __future__ import annotations

import base64
import json
import struct
from pathlib import Path

import numpy as np
import pytest

from cardvision.bank.documents import canonical_bytes, read_json
from cardvision.core import bank as B
from cardvision.core import bank_binary as BIN

ROOT = Path(__file__).resolve().parents[1]
TOY_BANK = ROOT / "browser" / "test" / "fixtures" / "toy-release" / "bank.json"
FULL128 = {"id": "full128", "size": 128, "centerMask": False, "poolVersion": 2, "crop": "truncate"}


def bank_doc(count: int = 5, dim: int = 16, art: bool = True) -> dict:
    rows = B.l2_normalize(np.random.default_rng(3).normal(size=(count, dim)))
    ids = [f"GEN-{i:03d}" for i in range(count)]
    versions = [f"{i:016x}" if art and i % 2 == 0 else None for i in range(count)]
    extra = {"schemaVersion": 1, "kind": "embedding-bank", "game": "gen", "locale": "en", "version": 2, "model": "m",
             "dim": dim, "dtype": "fp16", "preprocessing": FULL128, "centerMask": False, "views": 16,
             "aggregation": "mean", "cardCount": count, "entryCount": count}
    return B.encode_bank(ids, rows, extra=extra, art_versions=versions)


def header_of(body: bytes) -> dict:
    (length,) = struct.unpack_from("<I", body, 8)
    return json.loads(body[12:12 + length])


def rebuilt(header: dict, values: bytes) -> bytes:
    text = json.dumps(header).encode("utf-8")
    return BIN.MAGIC + struct.pack("<I", len(text)) + text + values


def test_the_layout_is_magic_header_length_header_and_the_fp16_bytes():
    doc = bank_doc()
    body = BIN.encode(doc)
    assert body[:8] == b"CVBANK\x00\x01"
    header = header_of(body)
    assert "entries" not in header and header["cardIds"] == [entry["cardId"] for entry in doc["entries"]]
    assert header["artVs"] == [entry.get("artV") for entry in doc["entries"]]
    keys = list(doc)
    assert list(header) == keys[:keys.index("entries")] + ["cardIds", "artVs"] + keys[keys.index("entries") + 1:]
    (length,) = struct.unpack_from("<I", body, 8)
    assert body[12 + length:] == b"".join(base64.b64decode(entry["vec"]) for entry in doc["entries"])


def test_a_bank_without_artv_has_no_artvs_list():
    doc = bank_doc(art=False)
    assert "artVs" not in header_of(BIN.encode(doc))
    assert BIN.decode(BIN.encode(doc)) == doc


def test_the_round_trip_gives_the_json_file_byte_for_byte():
    doc = bank_doc()
    assert canonical_bytes(BIN.decode(BIN.encode(doc))) == canonical_bytes(doc)


def test_the_toy_release_s_bank_comes_back_byte_for_byte_and_smaller():
    raw = TOY_BANK.read_bytes()
    body = BIN.encode(read_json(TOY_BANK))
    assert canonical_bytes(BIN.decode(body)) == raw
    assert len(body) < len(raw)


def test_both_forms_read_to_the_same_ids_and_matrix(tmp_path):
    doc = read_json(TOY_BANK)
    (tmp_path / "bank.bin").write_bytes(BIN.encode(doc))
    ids_json, rows_json, doc_json = B.load_bank(TOY_BANK)
    ids_bin, rows_bin, doc_bin = B.load_bank(tmp_path / "bank.bin")
    assert ids_bin == ids_json and doc_bin == doc_json
    assert np.array_equal(rows_bin.view(np.uint32), rows_json.view(np.uint32))
    assert BIN.read_bank_file(TOY_BANK) == BIN.read_bank_file(tmp_path / "bank.bin")


def test_decode_refuses_a_wrong_magic_or_an_unknown_version():
    body = BIN.encode(bank_doc())
    with pytest.raises(ValueError, match="does not start with CVBANK"):
        BIN.decode(b"XVBANK\x00\x01" + body[8:])
    with pytest.raises(ValueError, match="format version 2"):
        BIN.decode(body[:7] + b"\x02" + body[8:])
    with pytest.raises(ValueError, match="format version 2"):
        BIN.read_bank_bytes(body[:7] + b"\x02" + body[8:])   # refused, not guessed at as JSON


def test_decode_refuses_a_cut_body_and_trailing_bytes():
    body = BIN.encode(bank_doc())
    with pytest.raises(ValueError, match="bytes of vectors"):
        BIN.decode(body[:-1])
    with pytest.raises(ValueError, match="bytes of vectors"):
        BIN.decode(body[:-32])
    with pytest.raises(ValueError, match="bytes of vectors"):
        BIN.decode(body + b"\x00\x00")
    with pytest.raises(ValueError, match="inside its header"):
        BIN.decode(body[:20])
    with pytest.raises(ValueError, match="before its header"):
        BIN.decode(body[:10])


def test_decode_refuses_a_header_that_is_not_a_bank_s():
    body = BIN.encode(bank_doc())
    header = header_of(body)
    (length,) = struct.unpack_from("<I", body, 8)
    values = body[12 + length:]
    assert BIN.decode(rebuilt(header, values))  # the rebuilt file itself is good
    changes = {
        "entryCount": ({"entryCount": 4}, "entryCount 4 is not its 5 card ids"),
        "kind": ({"kind": "something-else"}, "embedding-bank"),
        "version": ({"version": 0}, "version"),
        "dim": ({"dim": 8}, "bytes of vectors"),
        "dim0": ({"dim": 0}, "dim"),
        "dtype": ({"dtype": "fp32"}, "dtype"),
        "ids": ({"cardIds": ["A", 3, "C", "D", "E"]}, "cardIds"),
        "artVs": ({"artVs": [None]}, "artVs"),
        "entries": ({"entries": []}, "entries"),
    }
    for name, (change, message) in changes.items():
        with pytest.raises(ValueError, match=message):
            BIN.decode(rebuilt({**header, **change}, values))
    without = {key: value for key, value in header.items() if key != "preprocessing"}
    with pytest.raises(ValueError, match="preprocessing"):
        BIN.decode(rebuilt(without, values))
    text = b"[1, 2]"
    with pytest.raises(ValueError, match="not a JSON object"):
        BIN.decode(BIN.MAGIC + struct.pack("<I", len(text)) + text)
    with pytest.raises(ValueError, match="not UTF-8 JSON"):
        BIN.decode(BIN.MAGIC + struct.pack("<I", 2) + b"\xff{")


def test_encode_refuses_a_document_it_cannot_hold_exactly():
    doc = bank_doc()
    with pytest.raises(ValueError, match="dim"):
        BIN.encode({key: value for key, value in doc.items() if key != "dim"})
    with pytest.raises(ValueError, match="holds 32 bytes, not 8 fp16 values"):
        BIN.encode({**doc, "dim": 8})
    with pytest.raises(ValueError, match="cardIds"):
        BIN.encode({**doc, "cardIds": []})
    with pytest.raises(ValueError, match="dtype"):
        BIN.encode({**doc, "dtype": "fp32"})
    odd = {**doc, "entries": [{"vec": doc["entries"][0]["vec"], "cardId": "X"}]}
    with pytest.raises(ValueError, match="in that order"):
        BIN.encode(odd)
    extra = {**doc, "entries": [{**doc["entries"][0], "note": "x"}]}
    with pytest.raises(ValueError, match="in that order"):
        BIN.encode(extra)


def test_a_json_bank_is_read_as_json_and_anything_else_is_refused(tmp_path):
    assert BIN.read_bank_bytes(TOY_BANK.read_bytes()) == read_json(TOY_BANK)
    (tmp_path / "junk.bin").write_bytes(b"CVBAN")
    with pytest.raises(ValueError, match="junk.bin: not valid JSON"):
        BIN.read_bank_file(tmp_path / "junk.bin")
