# SPDX-License-Identifier: Apache-2.0
"""The fixtures that pin the browser runtime to this package, and the check that they are current.

``browser/test/fixtures/contract.json`` holds inputs and the answers this package gives for
them: preprocessing tensors, the detector's canvas, decoded boxes, a decoded bank, the identity
rules of a catalog, its facets and its cards without art, look choices, hover outcomes, frame
fingerprints, and the events file of a scoring run. The browser runtime's own tests (``npm
test`` in ``browser/``) compute the same answers in TypeScript and compare them with the file.
This module is the other half: it computes the answers again with the Python code and compares
them with the file, so the file cannot drift from either side unnoticed. Every input is generated from arithmetic; no image,
no footage and no model is involved.

``browser/test/fixtures/toy-release/`` holds a release of the toy game as ``cardvision
build-release`` wrote it, without its two model files (no model file is kept in this
repository). The check here is that it is a release this package accepts, except for exactly
those two missing files.

The ``events`` section ties the file the scoring page writes to the file this package reads.
It holds manifest rows, made-up videos (frame times and fingerprints), the boxes a made-up
analysis finds, and the exact lines of the events file such a run must write. The lines are
built here, by a model of the format in Python (``section_events``). The browser's tests run
the page's own run and writer on the same inputs and must get the same lines, character for
character; the test below reads those lines with ``cardvision.evaluate.browser``, checks them
against the manifest rows and scores them. A field that is renamed, removed or changes type on
either side fails one of the two.

To write the fixtures again after a deliberate change to a contract::

    python tests/test_browser_fixtures.py --write

The release needs the ``onnx`` package to build its stand-in models; the contract file does not.

The same builders make a toy release to look at in the demo page of ``browser/``::

    python tests/test_browser_fixtures.py --demo OUT_DIR

``OUT_DIR`` must lie outside the repository, which holds no images and no model files. It gets
``release/`` (a release document and everything it pins), ``art/`` (the toy game's card images)
and ``table.png`` (a table with five cards and a card back on it). The models are stand-ins
with no skill, as in ``examples/toy_quickstart.py``: the recognizer is an average pool and a
random projection, and the detector does not look at the image, it returns the boxes of the
cards in ``table.png``.

For the scoring page of ``browser/`` it also gets ``table.webm``, six seconds of that table as
a video, and ``labels/table.manifest.jsonl``, three labeled rows of it under the recording
name ``table``. Writing the video needs OpenCV (the ``video`` extra); without it the two are
left out and the command says so.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from cardvision.bank import release as R
from cardvision.bank.documents import canonical_bytes, read_json, sha256_hex
from cardvision.core.bank import IdentityGroups, decode_bank, encode_bank, groups_by_name
from cardvision.core.catalog import IDENTITY_NAME
from cardvision.core.preprocess import POOL_V1, POOL_V2, box_average, full128, rot4
from cardvision.data.dhash import SAME_FRAME_MAX_HAMMING, dhash, hamming
from cardvision.data.extract import FINGERPRINT_WINDOW_SECONDS
from cardvision.detect.decode import decode
from cardvision.detect.letterbox import letterbox_bgr, letterbox_ratio, letterbox_size, to_input_tensor
from cardvision.evaluate.hover import ACCEPTED_NMS, ACCEPTED_NMS_IOU, SELECTIONS, HoverLayer, Proposal, hover_order, kept_after_nms
from cardvision.infer.frames import MAX_ANALYSIS_WIDTH, MIN_ANALYSIS_WIDTH, analysis_size
from cardvision.recognize.accept import AcceptRule, choose_among
from cardvision.recognize.crops import crop_edges, crop_truncated
from cardvision.recognize.looks import Look, bank_transposed, name_columns, score_look, similarities

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "browser" / "test" / "fixtures"
CONTRACT = FIXTURES / "contract.json"
TOY_RELEASE = FIXTURES / "toy-release"
MODEL_FILES = ("detector.onnx", "recognizer.onnx")

SYNTHETIC = (
    "RGBA bytes, row-major, 4 per pixel. Row y has its own xorshift32 stream with initial state "
    "s = (seed + y * 0x9E3779B9) mod 2^32 (1 if that is 0). For each of the row's 4 * width bytes in "
    "order: s ^= (s << 13) mod 2^32; s ^= s >> 17; s ^= (s << 5) mod 2^32; byte = s >> 24. The alpha "
    "bytes are generated the same way and ignored."
)


# --------------------------------------------------------------------------- generated inputs
def synthetic_rgba(seed: int, width: int, height: int) -> np.ndarray:
    """A deterministic ``(height, width, 4)`` uint8 image (see ``SYNTHETIC``)."""
    out = np.empty((height, width * 4), dtype=np.uint8)
    for y in range(height):
        s = (seed + y * 0x9E3779B9) % 2**32 or 1
        row = out[y]
        for k in range(width * 4):
            s ^= (s << 13) & 0xFFFFFFFF
            s ^= s >> 17
            s ^= (s << 5) & 0xFFFFFFFF
            row[k] = s >> 24
    return out.reshape(height, width, 4)


class Stream:
    """A xorshift32 stream of numbers in [0, 1) with 24 bits each, the same in any language."""

    def __init__(self, seed: int) -> None:
        self.s = seed % 2**32 or 1

    def unit(self) -> float:
        s = self.s
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        self.s = s
        return (s >> 8) / 2**24

    def between(self, low: float, high: float) -> float:
        return low + (high - low) * self.unit()

    def below(self, n: int) -> int:
        return int(self.unit() * n)


def sha(array: np.ndarray) -> str:
    """SHA-256 of an array's bytes, little-endian, in C order."""
    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()


def hexed(array: np.ndarray) -> str:
    """An array's bytes as hexadecimal text."""
    return np.ascontiguousarray(array).tobytes().hex()


# ------------------------------------------------------------------------------- the sections
def section_preprocess() -> dict:
    frame = synthetic_rgba(1001, 333, 251)
    rgb = frame[:, :, :3]
    boxes = [(10.7, 20.2, 128.0, 128.0), (0.0, 0.0, 333.0, 251.0), (100.5, 60.5, 61.9, 90.2), (-20.0, -5.5, 80.0, 70.0),
             (300.2, 200.9, 90.0, 90.0), (5.999, 6.001, 127.002, 129.999), (40.0, 40.0, 200.0, 150.0), (17.3, 9.8, 24.4, 33.3)]
    crops = []
    for box in boxes:
        x0, y0, x1, y1 = crop_edges(box, 333, 251)
        crop = crop_truncated(rgb, box)
        tensor = full128(crop)
        crops.append({
            "box": list(box),
            "edges": [x0, y0, x1, y1],
            "tensorSha256": sha(tensor),
            "rot4Sha256": [sha(look) for look in rot4(tensor)],
        })
    small = []
    for seed, width, height in [(1101, 1, 1), (1102, 5, 3), (1103, 127, 129), (1104, 42, 300), (1105, 96, 96), (1106, 255, 64)]:
        image = synthetic_rgba(seed, width, height)[:, :, :3]
        small.append({
            "seed": seed, "width": width, "height": height,
            "tensorSha256": sha(full128(image)),
            "poolV1Sha256": sha(box_average(image, 16, 12, POOL_V1)),
            "poolV2Sha256": sha(box_average(image, 16, 12, POOL_V2)),
        })
    return {
        "note": "full128 of crops of one generated frame (box -> truncated edges -> tensor and its four looks), and "
                "of whole small images; tensor hashes are of float32 bytes, pool hashes of float64 bytes of a "
                "16 x 12 grid (width x height), row-major, R G B per cell.",
        "frame": {"seed": 1001, "width": 333, "height": 251, "rgbaSha256": sha(frame)},
        "crops": crops,
        "images": small,
    }


def section_letterbox() -> dict:
    cases = []
    for seed, width, height in [(2001, 1280, 720), (2002, 1920, 1080), (2003, 854, 480), (2004, 720, 405), (2005, 1000, 700),
                                (2006, 640, 384), (2007, 500, 900), (2008, 1281, 721), (2009, 300, 200)]:
        rgb = synthetic_rgba(seed, width, height)[:, :, :3]
        canvas, ratio = letterbox_bgr(np.ascontiguousarray(rgb))
        cases.append({
            "seed": seed, "width": width, "height": height,
            "ratio": ratio, "size": list(letterbox_size(width, height)),
            "canvasSha256": sha(canvas), "tensorSha256": sha(to_input_tensor(canvas)),
        })
    other = synthetic_rgba(2101, 900, 500)[:, :, :3]
    canvas, ratio = letterbox_bgr(np.ascontiguousarray(other), 416, 256, 0)
    custom = {"seed": 2101, "width": 900, "height": 500, "input": {"width": 416, "height": 256, "pad": 0},
              "ratio": ratio, "size": list(letterbox_size(900, 500, 416, 256)),
              "canvasSha256": sha(canvas), "tensorSha256": sha(to_input_tensor(canvas))}
    return {"note": "the detector's canvas (BGR bytes, row-major) and input tensor (float32, channel first) for "
                    "generated frames, on the 640 x 384 canvas padded with 114 and on one other canvas.",
            "cases": cases, "custom": custom}


def section_analysis_size() -> dict:
    cases = []
    for width, height in [(1920, 1080), (1280, 720), (854, 480), (720, 405), (640, 360), (480, 270), (426, 240), (3840, 2160),
                          (2560, 1440), (2560, 1080), (1000, 562), (500, 281), (719, 404), (1921, 1081),
                          # heights exactly between two whole numbers: 406.5, 403.5, 409.5, 412.5, 1080.5, 1079.5
                          (480, 271), (480, 269), (480, 273), (480, 275), (3840, 2161), (3840, 2159)]:
        cases.append({"width": width, "height": height, "analysis": list(analysis_size(width, height))})
    return {"note": "the size a picture is analyzed at. The last six heights fall exactly between two whole "
                    "numbers and are rounded upward.",
            "min": MIN_ANALYSIS_WIDTH, "max": MAX_ANALYSIS_WIDTH, "cases": cases}


def _random_rows(stream: Stream, count: int, classes: int) -> np.ndarray:
    rows = np.zeros((count, 5 + classes), dtype=np.float32)
    for row in rows:
        row[0] = stream.between(0, 640)
        row[1] = stream.between(0, 384)
        row[2] = stream.between(10, 220)
        row[3] = stream.between(10, 220)
        row[4] = stream.unit()
        for c in range(classes):
            row[5 + c] = stream.unit()
    return rows


def section_decode() -> dict:
    cases = []

    def add(name: str, rows: np.ndarray, ratio: float, **settings) -> None:
        found = decode(rows, ratio, **settings)
        cases.append({
            "name": name, "columns": int(rows.shape[1]), "rows": hexed(rows.astype("<f4")), "ratio": ratio,
            "threshold": settings.get("threshold", 0.3), "nmsIou": settings.get("nms_iou", 0.45),
            "maxProposals": settings.get("max_detections", 80),
            "detections": [{"x": d.x, "y": d.y, "width": d.width, "height": d.height, "score": d.score, "cls": d.cls}
                           for d in found],
        })

    add("dense", _random_rows(Stream(3001), 160, 2), 0.5)
    add("one third", _random_rows(Stream(3002), 120, 2), 1 / 3)
    add("low threshold, cut to 20", _random_rows(Stream(3003), 120, 2), 0.3555555555555555, threshold=0.05, max_detections=20)
    add("loose suppression", _random_rows(Stream(3004), 100, 2), 0.5, nms_iou=0.8)
    add("three classes", _random_rows(Stream(3005), 100, 3), 0.5)
    ties = _random_rows(Stream(3006), 60, 2)
    ties[30:] = ties[:30]  # every row twice: equal scores keep row order
    ties[30:, 0] += np.float32(300.0)
    add("equal scores", ties, 0.5)
    edge = np.zeros((4, 7), dtype=np.float32)
    edge[:, :4] = [[100, 100, 50, 80], [300, 100, 50, 80], [100, 300, 50, 80], [300, 300, 50, 80]]
    edge[:, 4] = [0.3, np.nextafter(np.float32(0.3), np.float32(0)), 0.6, 0.6]
    edge[:, 5] = [1.0, 1.0, 0.5, 0.5]
    edge[:, 6] = [0.0, 0.0, 0.5, 0.25]
    add("at the threshold, and a tie between classes", edge, 0.5)
    add("nothing passes", _random_rows(Stream(3007), 50, 2), 0.5, threshold=0.999999)
    return {"note": "raw detector rows (little-endian float32 bytes, in hexadecimal) and the detections cardvision.detect.decode "
                    "gives for them, in frame pixels, best first.",
            "cases": cases}


def _unit_rows(stream: Stream, count: int, dim: int) -> np.ndarray:
    rows = np.array([[stream.between(-1, 1) for _ in range(dim)] for _ in range(count)], dtype=np.float32)
    return rows / np.linalg.norm(rows, axis=1, keepdims=True)


def section_bank() -> dict:
    stream = Stream(4001)
    ids = ["GEN-001", "GEN-002", "GEN-002A", "GEN-003", "GEN-P01", "GEN-004", "GEN-002"]
    names = {"GEN-001": "Alder", "GEN-002": "Birch", "GEN-002A": "Birch", "GEN-003": "Cedar", "GEN-P01": "Cedar",
             "GEN-004": "Dogwood"}
    doc = encode_bank(ids, _unit_rows(stream, len(ids), 128))
    decoded_ids, rows = decode_bank(doc)
    assert decoded_ids == ids
    queries = _unit_rows(stream, 12, 128)
    queries[:4] = (rows[[1, 2, 3, 5]] + np.float32(0.05) * queries[:4]).astype(np.float32)
    queries /= np.linalg.norm(queries, axis=1, keepdims=True)
    columns = name_columns(ids, names)
    looks = [score_look(row, columns) for row in similarities(queries, bank_transposed(rows))]
    groups = groups_by_name(ids, names)
    identity = IdentityGroups(groups, ids)
    return {
        "note": "a generated bank as encode_bank stores it, the float32 matrix decode_bank reads from it, and the "
                "look (best row, score, margin against another name) of generated unit queries.",
        "dim": 128, "ids": ids, "names": names, "entries": doc["entries"], "matrixSha256": sha(rows.astype("<f4")),
        "groups": groups, "representative": identity.representative_map(), "identityIds": identity.identity_ids,
        "queries": hexed(queries.astype("<f4")),
        "looks": [{"top": look.top, "score": look.score, "margin": look.margin} for look in looks],
    }


IDENTITY_CARDS = [
    # (id, name, printingOf). Two different cards are named Alder, each with a printing; one
    # printing carries another name than its card; one id of the plain form is a printing.
    ("GEN-001", "Alder", None), ("GEN-001A", "Alder", "GEN-001"),
    ("GEN-002", "Alder", None), ("GEN-002A", "Alder, second edition", "GEN-002"),
    ("GEN-003X", "Birch", None), ("GEN-009", "Birch", "GEN-003X"),
    ("GEN-004", "Cedar", None), ("GEN-P01", "Cedar", "GEN-004"), ("GEN-P02", "Cedar", "GEN-004"),
    ("GEN-005", "Dogwood", None),
]


def section_identity() -> dict:
    """The two identity rules on one generated catalog: every card's identity key, and the
    groups and representatives of two sets of bank ids (the whole catalog, and a bank that
    lacks some cards and repeats one)."""
    from cardvision.core.catalog import IDENTITY_RULES, CatalogError, parse_catalog

    cards = [{"id": card_id, "name": name, "kind": None, "printingOf": printing_of, "art": f"{card_id}.png"}
             for card_id, name, printing_of in IDENTITY_CARDS]
    every = [card["id"] for card in cards]
    partial = ["GEN-P02", "GEN-001A", "GEN-002", "GEN-009", "GEN-P01", "GEN-002A", "GEN-001A", "GEN-005"]
    rules = {}
    for rule in IDENTITY_RULES:
        catalog = parse_catalog({"game": "generated", "locale": "en", "identity": rule, "cards": cards})
        banks = []
        for ids in (every, partial):
            groups = catalog.identity_groups(ids)
            identity = IdentityGroups(groups, ids, prefer=catalog.identity_anchors())
            banks.append({"ids": ids, "groups": groups, "representative": identity.representative_map(),
                          "identityIds": identity.identity_ids})
        rules[rule] = {"keys": catalog.identities(), "banks": banks}
    # Catalogs the printing rule refuses, and the same documents under the name rule, which takes them.
    chain = [*cards, {"id": "GEN-001B", "name": "Alder", "kind": None, "printingOf": "GEN-001A", "art": "GEN-001B.png"}]
    refused = []
    for label, entries in (("a printing of a printing", chain),):
        document = {"game": "generated", "locale": "en", "identity": "printing", "cards": entries}
        try:
            parse_catalog(document)
        except CatalogError as error:
            assert "'GEN-001B'" in str(error)
        else:
            raise AssertionError(f"{label} was not refused")
        parse_catalog({**document, "identity": "name"})
        refused.append({"what": label, "card": "GEN-001B", "cards": entries})
    return {
        "note": "a generated catalog under each identity rule a catalog can state. keys: card id to identity key "
                "(Catalog.identity_of); two cards are the same card exactly when their keys are equal. banks: for a "
                "list of bank ids, the groups of two or more ids of one identity, each group's other members mapped to "
                "its representative, and the identities in the order the bank first shows them. refused: catalogs the "
                "printing rule refuses, naming the card, and the name rule accepts.",
        "cards": cards, "rules": rules, "refused": refused,
    }


FACET_DECLS = [
    {"key": "color", "label": "Color", "values": ["Red", "Blue", "Green"]},
    {"key": "cost", "label": "Cost", "type": "number"},
    {"key": "set", "label": "Set"},
    {"key": "rarity", "label": "Rarity"},
]
FACET_CARDS = [
    {"id": "GEN-001", "name": "Alder", "kind": "unit", "art": "GEN-001.png",
     "facets": {"color": ["Red", "Blue"], "cost": 3, "set": "BETA"}},
    {"id": "GEN-002", "name": "Birch", "kind": "spell", "art": "GEN-002.png",
     "facets": {"color": "Green", "cost": 1, "set": "ALPHA"}},
    {"id": "GEN-003", "name": "Cedar", "kind": "unit", "art": "GEN-003.png", "facets": {"cost": 10, "color": "Red"}},
    {"id": "GEN-004", "name": "Dogwood", "kind": None, "art": "GEN-004.png"},
    {"id": "GEN-005", "name": "Elm", "kind": "site", "art": "GEN-005.png", "facets": {}},
]


def _facet_doc(decls=FACET_DECLS, card: dict | None = None, at: int = 1) -> dict:
    """The generated catalog with facets ``decls`` (None: no top-level key), and with the facets
    of the card at ``at`` replaced by ``card`` when given."""
    cards = json.loads(json.dumps(FACET_CARDS))
    if card is not None:
        cards[at]["facets"] = card
    doc = {"game": "generated", "locale": "en", "cards": cards}
    if decls is not None:
        doc["facets"] = decls
    return doc


def _with_decl(position: int, **change) -> list:
    decls = json.loads(json.dumps(FACET_DECLS))
    decls[position] = {key: value for key, value in {**decls[position], **change}.items() if value is not ...}
    return decls


def section_facets() -> dict:
    """The optional facets of a catalog: catalogs that are accepted, with the facets they give
    (values in chip order) and each card's values, and catalogs that are refused, with the
    fragments every refusal must contain. The labeling tool's own reading agrees with both
    (tests/test_catalog_facets.py)."""
    from cardvision.core.catalog import CatalogError, parse_catalog

    plain = [{key: value for key, value in card.items() if key != "facets"} for card in FACET_CARDS]
    accepted_docs = [
        ("every kind of facet", _facet_doc()),
        ("no facets at all", {"game": "generated", "locale": "en", "cards": plain}),
        ("an empty list of facets", {"game": "generated", "locale": "en", "facets": [], "cards": plain}),
        ("values that set the type and the order", {"game": "generated", "locale": "en", "cards": plain[:1] + [
            {**plain[1], "facets": {"size": [2.5, 1]}}], "facets": [{"key": "size", "label": "Size", "values": [2.5, 1, 3]}]}),
        ("a text type stated", {"game": "generated", "locale": "en", "cards": [{**plain[0], "facets": {"set": "B"}},
            {**plain[1], "facets": {"set": "A"}}], "facets": [{"key": "set", "label": "Set", "type": "text"}]}),
    ]
    accepted = []
    for label, doc in accepted_docs:
        catalog = parse_catalog(doc)
        accepted.append({
            "what": label, "doc": doc,
            "facets": [{"key": f.key, "label": f.label, "type": f.type, "values": list(f.values)} for f in catalog.facets],
            "cards": {card.id: {key: list(values) for key, values in card.facets.items()} for card in catalog.cards},
        })
    refused_docs = [
        ("facets not a list", _facet_doc(decls={"color": "Color"}), ["facets"]),
        ("a declaration not an object", _facet_doc(decls=["color"]), ["facets[0]"]),
        ("a declaration without a label", _facet_doc(decls=_with_decl(0, label=...)), ["facets[0]"]),
        ("an empty label", _facet_doc(decls=_with_decl(2, label="  ")), ["facets[2]", "label"]),
        ("a label not text", _facet_doc(decls=_with_decl(2, label=7)), ["facets[2]", "label"]),
        ("an unknown declaration key", _facet_doc(decls=_with_decl(1, order="asc")), ["facets[1]", "order"]),
        ("a key with a capital first", _facet_doc(decls=_with_decl(3, key="Rarity")), ["facets[3]", "key"]),
        ("a key with a dash", _facet_doc(decls=_with_decl(3, key="rare-ity")), ["facets[3]", "key"]),
        ("a key ending in a line break", _facet_doc(decls=_with_decl(3, key="rarity\n")), ["facets[3]", "key"]),
        ("a key not text", _facet_doc(decls=_with_decl(3, key=3)), ["facets[3]", "key"]),
        ("the reserved key kind", _facet_doc(decls=_with_decl(3, key="kind")), ["facets[3]", "kind"]),
        ("a key declared twice", _facet_doc(decls=_with_decl(3, key="set")), ["facets[3]", "set"]),
        ("an unknown type", _facet_doc(decls=_with_decl(1, type="integer")), ["facets[1]", "type"]),
        ("an empty values list", _facet_doc(decls=_with_decl(0, values=[])), ["facets[0]", "values"]),
        ("values not a list", _facet_doc(decls=_with_decl(0, values="Red")), ["facets[0]", "values"]),
        ("values of two types", _facet_doc(decls=_with_decl(0, values=["Red", 1])), ["facets[0]"]),
        ("a value listed twice in values", _facet_doc(decls=_with_decl(0, values=["Red", "Blue", "Red"])), ["facets[0]"]),
        ("values not of the stated type", _facet_doc(decls=_with_decl(1, values=["1", "3"])), ["facets[1]"]),
        ("an empty text value", _facet_doc(decls=_with_decl(0, values=["Red", " "])), ["facets[0]"]),
        ("a true or false value", _facet_doc(decls=_with_decl(0, values=[True])), ["facets[0]"]),
        ("a card's facets not an object", _facet_doc(card=["Red"]), ["GEN-002", "facets"]),
        ("an undeclared key on a card", _facet_doc(card={"colour": "Red"}), ["GEN-002", "facets.colour"]),
        ("a text value for a number facet", _facet_doc(card={"cost": "3"}), ["GEN-002", "facets.cost"]),
        ("a value outside the declared values", _facet_doc(card={"color": "Teal"}), ["GEN-002", "facets.color"]),
        ("a value listed twice on a card", _facet_doc(card={"color": ["Red", "Red"]}), ["GEN-002", "facets.color"]),
        ("an empty list on a card", _facet_doc(card={"color": []}), ["GEN-002", "facets.color"]),
        ("a list in a list", _facet_doc(card={"color": [["Red"]]}), ["GEN-002", "facets.color"]),
        ("a null value", _facet_doc(card={"cost": None}), ["GEN-002", "facets.cost"]),
        ("a true or false value on a card", _facet_doc(card={"set": False}), ["GEN-002", "facets.set"]),
        ("an untyped facet given a number after text", _facet_doc(card={"set": 7}), ["GEN-002", "facets.set"]),
        ("facets on a card of a catalog that declares none", _facet_doc(decls=None), ["GEN-001", "facets.color"]),
    ]
    refused = []
    for label, doc, mentions in refused_docs:
        doc["cards"] = doc["cards"][:2]  # the first two cards are enough to break, and keep the file short
        try:
            parse_catalog(doc)
        except CatalogError as error:
            missing = [fragment for fragment in mentions if fragment not in str(error)]
            assert not missing, f"{label}: {error} does not mention {missing}"
        else:
            raise AssertionError(f"{label} was not refused")
        refused.append({"what": label, "doc": doc, "mentions": mentions})
    return {
        "note": "the optional facets of a catalog (the labeling tool's filters). accepted: catalogs this package takes, "
                "with each declared facet (its values in chip order: declared, else numbers ascending and text in order "
                "of first appearance) and each card's values as lists. refused: catalogs it refuses, with fragments the "
                "refusal names (a facet's position or a card's id and facets.<key>).",
        "accepted": accepted, "refused": refused,
    }


EXTRA_CARDS = [
    {"id": "GEN-001", "name": "Alder", "kind": "unit", "art": "GEN-001.png",
     "extra": {"text": "Draw a card.", "rarity": "common", "upstream": {"id": 1001, "tags": ["a", "b"]}}},
    {"id": "GEN-002", "name": "Birch", "kind": "spell", "art": "GEN-002.png", "extra": {}},
    {"id": "GEN-003", "name": "Cedar", "kind": "unit", "art": "GEN-003.png"},
]


def section_extra() -> dict:
    """A card's optional ``extra`` object: catalogs that are accepted, with each card's extra as
    the file gives it (absent when the card has none), and catalogs that are refused, with the
    fragments every refusal must contain. The labeling tool agrees with both
    (tests/test_catalog_extra.py)."""
    from cardvision.core.catalog import CatalogError, parse_catalog

    def doc_with(extra: Any = ..., at: int = 1) -> dict:
        cards = json.loads(json.dumps(EXTRA_CARDS))
        if extra is not ...:
            cards[at]["extra"] = extra
        return {"game": "generated", "locale": "en", "cards": cards}

    accepted = []
    for label, doc in [("objects of any shape, and a card with none", doc_with()),
                       ("an extra beside facets, a token and a card without art",
                        {"game": "generated", "locale": "en", "facets": [{"key": "cost", "label": "Cost"}],
                         "cards": [{**EXTRA_CARDS[0], "art": None, "token": True, "facets": {"cost": 2}}]})]:
        catalog = parse_catalog(doc)
        given = {entry["id"] for entry in doc["cards"] if "extra" in entry}
        accepted.append({"what": label, "doc": doc,
                         "cards": {card.id: dict(card.extra) for card in catalog.cards if card.id in given}})
    refused = []
    for label, doc, mentions in [
        ("extra a list", doc_with(["Draw a card."]), ["GEN-002", "extra"]),
        ("extra a string", doc_with("Draw a card."), ["GEN-002", "extra"]),
        ("extra a number", doc_with(3), ["GEN-002", "extra"]),
        ("extra null", doc_with(None), ["GEN-002", "extra"]),
        ("extra true", doc_with(True, at=0), ["GEN-001", "extra"]),
    ]:
        try:
            parse_catalog(doc)
        except CatalogError as error:
            missing = [fragment for fragment in mentions if fragment not in str(error)]
            assert not missing, f"{label}: {error} does not mention {missing}"
        else:
            raise AssertionError(f"{label} was not refused")
        refused.append({"what": label, "doc": doc, "mentions": mentions})
    return {
        "note": "a card's optional extra object, which nothing reads and every reader keeps. accepted: catalogs this "
                "package takes, with the extra of each card that gives one, as given. refused: catalogs it refuses "
                "(an extra that is not an object), with fragments the refusal names (the card's id and extra).",
        "accepted": accepted, "refused": refused,
    }


ART_CARDS = [
    # (id, name, printingOf, art). A card without art among cards with art; under the printing
    # rule a card without art that has a printing with art, and a printing without art.
    ("GEN-001", "Alder", None, "GEN-001.png"), ("GEN-001A", "Alder", "GEN-001", None),
    ("GEN-002", "Birch", None, None), ("GEN-002A", "Birch", "GEN-002", "GEN-002A.png"),
    ("GEN-003", "Cedar", None, None),
    ("GEN-004", "Dogwood", None, "https://cards.example/GEN-004.png"),
]


def section_art() -> dict:
    """Cards without art (``"art": null``): catalogs that are accepted under each identity rule,
    with each card's art, its identity key, and the groups of a bank that holds only the cards
    with art; and catalogs that are refused, with the fragments every refusal must contain."""
    from cardvision.core.catalog import IDENTITY_RULES, CatalogError, parse_catalog

    cards = [{"id": card_id, "name": name, "kind": None, "printingOf": printing_of, "art": art}
             for card_id, name, printing_of, art in ART_CARDS]
    accepted = []
    for rule in IDENTITY_RULES:
        doc = {"game": "generated", "locale": "en", "identity": rule, "cards": cards}
        catalog = parse_catalog(doc)
        bank = catalog.ids_with_art()  # a bank built from this catalog: a card without art has no row
        groups = catalog.identity_groups(bank)
        identity = IdentityGroups(groups, bank, prefer=catalog.identity_anchors())
        accepted.append({"what": f"cards without art, identity {rule}", "doc": doc,
                         "art": {card.id: card.art for card in catalog.cards}, "keys": catalog.identities(),
                         "withoutArt": catalog.ids_without_art(),
                         "bank": {"ids": bank, "groups": groups, "representative": identity.representative_map(),
                                  "identityIds": identity.identity_ids}})
    refused_cards = [
        ("art left out", {"id": "GEN-002", "name": "Birch"}),
        ("an empty art", {"id": "GEN-002", "name": "Birch", "art": ""}),
        ("an art of spaces", {"id": "GEN-002", "name": "Birch", "art": "  "}),
        ("an art of false", {"id": "GEN-002", "name": "Birch", "art": False}),
        ("an art that is a number", {"id": "GEN-002", "name": "Birch", "art": 0}),
        ("an art that is a list", {"id": "GEN-002", "name": "Birch", "art": []}),
    ]
    refused = []
    for label, card in refused_cards:
        doc = {"game": "generated", "locale": "en", "cards": [cards[0], card]}
        mentions = ["GEN-002", "art"]
        try:
            parse_catalog(doc)
        except CatalogError as error:
            missing = [fragment for fragment in mentions if fragment not in str(error)]
            assert not missing, f"{label}: {error} does not mention {missing}"
        else:
            raise AssertionError(f"{label} was not refused")
        refused.append({"what": label, "doc": doc, "mentions": mentions})
    return {
        "note": 'cards without art ("art": null). accepted: catalogs this package takes, under each identity rule, '
                "with each card's art (null for a card without art), its identity key, the cards without art, and a "
                "bank of the cards with art only: its groups, representatives and identities, as for the identity "
                'section. refused: catalogs it refuses, with fragments the refusal names; a card must state "art", '
                "as a path or URL or as null.",
        "accepted": accepted, "refused": refused,
    }


def section_looks() -> dict:
    stream = Stream(5001)
    cases = []
    for index in range(96):
        tau = [0.62, 0.5, 0.9][index % 3]
        delta = [0.05, 0.0, 0.2][(index // 3) % 3]
        retry = index % 7 != 0
        looks = [Look(top=k, score=stream.between(0.3, 1.0), margin=stream.between(-0.05, 0.4)) for k in range(4)]
        if index % 5 == 0:  # two looks with the same score
            a, b = stream.below(4), stream.below(4)
            looks[b] = Look(top=b, score=looks[a].score, margin=looks[b].margin)
        if index % 11 == 0:  # a score exactly at tau
            k = stream.below(4)
            looks[k] = Look(top=k, score=tau, margin=looks[k].margin)
        if index % 13 == 0:  # a margin exactly at delta
            k = stream.below(4)
            looks[k] = Look(top=k, score=looks[k].score, margin=delta)
        choice = choose_among(looks, AcceptRule(tau=tau, delta=delta, rotation_retry=retry))
        cases.append({"tau": tau, "delta": delta, "rotationRetry": retry,
                      "looks": [[look.score, look.margin] for look in looks],
                      "orientation": choice.orientation, "retried": choice.retried,
                      "tauPassed": choice.tau_passed, "accepted": choice.accepted})
    return {"note": "four looks of a crop (score, margin), upright first, and the look the orientation rule "
                    "chooses under an accept rule.", "cases": cases}


def _hover_frame(stream: Stream, count: int, width: int, height: int) -> list[Proposal]:
    proposals = []
    for index in range(count):
        w, h = stream.between(40, 320), stream.between(40, 320)
        x, y = stream.between(-30, width - 60), stream.between(-30, height - 60)
        if index % 4 == 1 and proposals:  # close to the box before it: suppression and stacking matter
            before = proposals[-1].box
            x, y, w, h = before[0] + stream.between(-12, 12), before[1] + stream.between(-12, 12), before[2], before[3]
        if index % 6 == 5 and proposals:  # inside the box before it
            before = proposals[-1].box
            x, y, w, h = before[0] + before[2] * 0.25, before[1] + before[3] * 0.25, before[2] * 0.5, before[3] * 0.5
        # The pipeline reports boxes clipped to the frame.
        x0, y0, x1, y1 = max(0.0, x), max(0.0, y), min(float(width), x + w), min(float(height), y + h)
        similarity = round(stream.between(0.4, 1.0), 2)  # two decimals: equal similarities occur
        tau_passed = similarity >= 0.62
        accepted = tau_passed and stream.unit() < 0.7
        proposals.append(Proposal(
            box=(x0, y0, x1 - x0, y1 - y0), detector_score=round(stream.between(0.3, 1.0), 1), similarity=similarity,
            look=stream.below(4) if stream.unit() < 0.3 else 0, tau_passed=tau_passed, accepted=accepted,
            name=f"Card {index}" if accepted else None, card_id=f"GEN-{index:03d}" if accepted else None,
            top_name=f"Card {index}"))
    return proposals


def section_hover() -> dict:
    frames = []
    for seed, count, width, height in [(6001, 14, 1280, 720), (6002, 24, 1920, 1080), (6003, 9, 720, 405), (6004, 1, 1280, 720),
                                       (6005, 0, 1280, 720)]:
        stream = Stream(seed)
        proposals = _hover_frame(stream, count, width, height)
        points = [[(i + 0.5) * width / 12, (j + 0.5) * height / 8] for j in range(8) for i in range(12)]
        for proposal in proposals[:6]:  # on corners and edges too
            x, y, w, h = proposal.box
            points += [[x, y], [x + w, y + h], [x + w / 2, y], [x, y + h / 2]]
        kept = kept_after_nms(proposals)
        selections = {}
        for selection in SELECTIONS:
            layer = HoverLayer(proposals, width, height, selection)
            shown = [layer.at(px, py) for px, py in points]
            selections[selection] = {
                "order": hover_order(proposals, selection),
                "hits": [[hit.index, hit.card_id] for hit in shown],
            }
        frames.append({
            "width": width, "height": height,
            "proposals": [{"box": list(p.box), "detectorScore": p.detector_score, "similarity": p.similarity, "look": p.look,
                           "tauPassed": p.tau_passed, "accepted": p.accepted, "cardId": p.card_id, "name": p.name}
                          for p in proposals],
            "kept": kept, "points": points, "selections": selections,
        })
    return {"note": "generated face boxes of a frame and, per hover selection, the stack (bottom first) and what a "
                    "pointer at each point resolves to: [index of the box hit or null, card id shown or null].",
            "frames": frames}


# Colors whose gray value, 0.299 R + 0.587 G + 0.114 B in double precision, is a whole number
# and a half: the first three round down to an even number, the last three up to one.
_HALF_DOWN = [(0, 0, 250), (0, 8, 86), (0, 14, 213)]   # 28.5, 14.5, 32.5
_HALF_UP = [(0, 4, 168), (0, 12, 4), (0, 18, 131)]     # 21.5, 7.5, 25.5


def _halves_image() -> np.ndarray:
    """An 18 x 8 image of 2 x 1 px cells, one cell of the fingerprint's grid each. Each row
    alternates a color whose gray is a half with the plain gray it rounds to under round-half-
    to-even, so every bit of its fingerprint is 0. Rounding halves upward, downward or by
    cutting would set bits."""
    image = np.zeros((8, 18, 3), dtype=np.uint8)
    for row in range(8):
        color = (_HALF_DOWN + _HALF_UP)[row % 6]
        gray = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]
        assert gray - int(gray) == 0.5
        even = int(gray) if int(gray) % 2 == 0 else int(gray) + 1
        for column in range(9):
            image[row, 2 * column: 2 * column + 2] = color if (column + row) % 2 == 0 else (even, even, even)
    return image


def section_dhash() -> dict:
    images = []
    for seed, width, height in [(7001, 333, 251), (7002, 640, 360), (7003, 100, 37), (7004, 9, 8), (7005, 18, 16), (7006, 17, 9),
                                (7007, 8, 7), (7008, 5, 3), (7009, 1, 1), (7010, 1, 40), (7011, 40, 1), (7012, 427, 240)]:
        rgb = synthetic_rgba(seed, width, height)[:, :, :3]
        images.append({"seed": seed, "width": width, "height": height, "dhash": dhash(np.ascontiguousarray(rgb))})
    # Images with a picture in them: bands of a generated frame, brightened from left to right
    # and from top to bottom, so that the bits are not all decided by noise.
    ramps = []
    for seed, width, height, across, down in [(7101, 320, 180, 1, 0), (7102, 320, 180, 0, 1), (7103, 213, 120, 1, 1), (7104, 96, 54, -1, 1)]:
        rgb = synthetic_rgba(seed, width, height)[:, :, :3].astype(np.int64) // 4
        x, y = np.meshgrid(np.arange(width), np.arange(height))
        level = 96 + across * ((x * 9 // width) * 12) + down * ((y * 8 // height) * 12)
        picture = np.clip(rgb + level[:, :, None], 0, 255).astype(np.uint8)
        ramps.append({"seed": seed, "width": width, "height": height, "across": across, "down": down,
                      "dhash": dhash(picture)})
    halves = _halves_image()
    prints = [image["dhash"] for image in images[:6]] + [ramp["dhash"] for ramp in ramps]
    return {
        "note": "the frame fingerprint (cardvision.data.dhash) of generated images. images: the RGB of a generated "
                "RGBA image. ramps: (the RGB of a generated image, each byte divided by 4 and rounded down) + 96 + "
                "across * 12 * floor(9x / width) + down * 12 * floor(8y / height), cut to 0..255. halves: RGB bytes, "
                "row-major, of an image whose every second cell has a gray value of a whole number and a half and "
                "whose other cells have the gray it rounds to, halves to the even number. distances: pairs of "
                "fingerprints and the number of bits in which they differ.",
        "maxHamming": SAME_FRAME_MAX_HAMMING,
        "images": images,
        "ramps": ramps,
        "halves": {"width": 18, "height": 8, "rgb": halves.ravel().tolist(), "dhash": dhash(halves)},
        "distances": [[a, b, hamming(a, b)] for a, b in zip(prints, prints[1:] + prints[:1])]
                     + [["0000000000000000", "ffffffffffffffff", 64], [prints[0], prints[0], 0]],
    }


# ------------------------------------------------------ the events file of a scoring run
# A model, in Python, of what the scoring page writes (browser/score/run.ts, select.ts). The
# numbers below are chosen so that both languages print them alike: no number is smaller than
# a ten-thousandth, and a whole number is written without a decimal point (``_js``).
EVENTS_STEP = 0.016       # browser/score/select.ts, MAX_STEP_SEC
EVENTS_ROLE = "evaluation"
EVENTS_NAMES = {"GEN-001": "Alder", "GEN-002": "Birch", "GEN-003": "Cedar"}
_PRINT_ROW = "0000000000000000"     # the fingerprint every row of the fixture carries
_PRINT_NEAR = "0000000000000003"    # 2 bits from it: the labeled frame
_PRINT_NEXT = "000000000000001f"    # 5 bits from it: the frame before the labeled one
_PRINT_FAR = "000000ffffffffff"     # 40 bits from it: every other frame


def _js(value):
    """``value`` with every whole float as an int, which is how JavaScript prints one."""
    if isinstance(value, dict):
        return {key: _js(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_js(item) for item in value]
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def js_line(doc: dict) -> str:
    """One line of JSON as JavaScript's ``JSON.stringify`` writes it."""
    return json.dumps(_js(doc), separators=(",", ":"), ensure_ascii=False)


def _js_round(value: float, places: int) -> float:
    """``Math.round(value * 10 ** places) / 10 ** places``: a half goes upward."""
    scale = 10 ** places
    return float(np.floor(value * scale + 0.5)) / scale


def _events_quad(x: float, y: float, w: float, h: float, width: int, height: int) -> list[list[float]]:
    return [[x / width, y / height], [(x + w) / width, y / height], [(x + w) / width, (y + h) / height], [x / width, (y + h) / height]]


def _events_boxes() -> tuple[list[dict], list[Proposal]]:
    """What the made-up analysis finds in a frame of 1280 x 720: three faces and a back. The
    first face is named, the second reaches ``tau`` and fails the margin, the third does not
    reach ``tau``."""
    faces = [
        # box, detector score, similarity, margin, look, tau passed, accepted, best row
        ((80.0, 60.0, 200.0, 280.0), 0.95, 0.91, 0.25, 0, True, True, "GEN-001"),
        ((400.0, 60.0, 200.0, 280.0), 0.9, 0.75, 0.01, 1, True, False, "GEN-002"),
        ((720.0, 60.0, 200.0, 280.0), 0.85, 0.4, 0.2, 0, False, False, "GEN-003"),
    ]
    proposals = [Proposal(box=box, detector_score=score, similarity=similarity, look=look, tau_passed=tau_passed,
                          accepted=accepted, name=EVENTS_NAMES[top] if accepted else None, card_id=top if accepted else None,
                          top_name=EVENTS_NAMES[top])
                 for box, score, similarity, _, look, tau_passed, accepted, top in faces]
    kept = kept_after_nms(proposals)
    boxes = []
    for index, (box, score, similarity, margin, look, tau_passed, accepted, top) in enumerate(faces):
        boxes.append({"box": list(box), "score": score, "cls": 0, "className": "face",
                      "face": {"topId": top, "topName": EVENTS_NAMES[top], "similarity": similarity, "margin": margin, "look": look,
                               "retried": look != 0, "tauPassed": tau_passed, "accepted": accepted,
                               "cardId": top if accepted else None, "name": EVENTS_NAMES[top] if accepted else None,
                               "kept": index in kept}})
    # The back comes second in the list of boxes, so a face's place among the boxes is not its place among the faces.
    boxes.insert(1, {"box": [1000.0, 400.0, 200.0, 280.0], "score": 0.92, "cls": 1, "className": "back", "face": None})
    return boxes, proposals


def _events_row(video_id: str, t: float, width: int, height: int, *, platform: str = "youtube", fingerprint: bool = True,
                boxes: bool = True) -> dict:
    """A manifest row labeled on the made-up frame, at any size of the same picture."""
    scale = width / 1280
    row = {"manifest_version": 1, "platform": platform, "video_id": video_id, "t": t, "frame_width": width, "frame_height": height,
           "source_type": "physical/webcam", "group": f"g-{video_id.lower()}", "role": EVENTS_ROLE, "trained_on": False,
           "completeness": "exhaustive-boxes" if boxes else "points", "credit": "fixture", "reachable": None,
           "reachable_checked": None}
    if fingerprint:
        row["attributes"] = {"frame_dhash": _PRINT_ROW}
    if boxes:
        def face(label: str, x: float, card: str) -> dict:
            return {"id": label, "kind": "face", "ignore": False, "quad": _events_quad(x * scale, 60 * scale, 200 * scale, 280 * scale, width, height),
                    "oriented": True, "shape": "rotated-box", "card_id": card, "identity": "named", "readable": "yes"}

        row["boxes"] = [face("alder", 80, "GEN-001"), face("birch", 400, "GEN-002"), face("cedar", 720, "GEN-003"),
                        {"id": "back", "kind": "back", "ignore": False, "oriented": False, "shape": "rotated-box",
                         "quad": _events_quad(1000 * scale, 400 * scale, 200 * scale, 280 * scale, width, height)}]
    row["points"] = [{"id": "on-alder", "x": 0.125, "y": 0.25, "kind": "face", "card_id": "GEN-001", "identity": "named", "readable": "yes"},
                     {"id": "table", "x": 0.5, "y": 0.875, "kind": "not-card"},
                     {"id": "on-back", "x": 0.875, "y": 0.75, "kind": "back"}]
    return row


def _events_videos() -> list[dict]:
    """The made-up video files of the run. ``prints`` gives the fingerprint of the frames that
    have one of their own; every other frame has ``otherPrint``."""
    def video(file: str, width: int, height: int, frames: int, prints: dict[int, str], reports: bool = True) -> dict:
        return {"file": file, "width": width, "height": height, "rate": 30, "frames": frames, "reportsFrameTimes": reports,
                "prints": {str(index): value for index, value in prints.items()}, "otherPrint": _PRINT_FAR}

    labeled = {149: _PRINT_NEXT, 150: _PRINT_NEAR}
    return [
        video("EXAMPLE0001.mp4", 2560, 1440, 600, labeled),                       # a whole video, twice the analyzed size
        video("EXAMPLE0003.mp4", 900, 900, 600, {}),                               # another shape than its row
        video("youtube-EXAMPLE0004+77.mp4", 1280, 720, 210, {90: _PRINT_NEAR}),    # a section that starts at 77 s
        video("local-kitchen-table-01.webm", 1280, 720, 600, labeled, reports=False),   # times asked for, not frame times
    ]


def _events_frames(video: dict) -> tuple[list[float], list[str], float]:
    times = [index / video["rate"] for index in range(video["frames"])]
    prints = [video["prints"].get(str(index), video["otherPrint"]) for index in range(video["frames"])]
    return times, prints, times[-1] + (times[1] - times[0])


def _events_window(video: dict, start: float, end: float) -> list[tuple[float, str]]:
    """The frames the page compares for a window of the file's own timeline, as ``(time,
    fingerprint)``: the frames themselves where the browser reports frame times, and the looks
    the page takes, a step apart, where it reports the time it was asked for."""
    times, prints, duration = _events_frames(video)

    def on_screen(at: float) -> int:
        clamped = min(max(0.0, at), duration)
        return max(index for index, time in enumerate(times) if time <= clamped + 1e-9)

    if video["reportsFrameTimes"]:
        first = on_screen(max(0.0, start))
        return [(times[index], prints[index]) for index in range(first, len(times)) if index == first or times[index] <= end + 1e-6]
    looks, target = [], max(0.0, start)
    while True:
        at = min(max(0.0, target), duration)
        if at > end + 1e-6 or (looks and at <= looks[-1][0] + 1e-6):
            return looks
        looks.append((at, prints[on_screen(target)]))
        target = at + EVENTS_STEP


def _events_line(row: dict, video: dict | None, start: float | None, layer: HoverLayer, boxes: list[dict], backend: dict) -> dict:
    """The line the page writes for one row (browser/score/run.ts, ``scoreRow``)."""
    line: dict = {"platform": row["platform"], "video_id": row["video_id"], "t": row["t"], "status": "no-video",
                  "labels": {"points": len(row.get("points", [])), "boxes": len(row.get("boxes", []))}}
    if video is None:
        return line
    offset = start or 0.0
    line["video"] = {"file": video["file"], "width": video["width"], "height": video["height"], **({} if start is None else {"start": start})}
    if abs((video["width"] / video["height"]) / (row["frame_width"] / row["frame_height"]) - 1.0) > 0.01:
        return {**line, "status": "frame-shape"}
    t, fingerprint = row["t"], row.get("attributes", {}).get("frame_dhash")
    duration = _js_round(offset + _events_frames(video)[2], 6) if start is not None else _events_frames(video)[2]
    exact = video["reportsFrameTimes"]

    def own(time: float) -> float:  # a time of the file, on the video's timeline
        return time if start is None else _js_round(offset + time, 6)

    if fingerprint is None:
        times, prints, _ = _events_frames(video)
        shown = max(index for index, time in enumerate(times) if time <= (t - offset) + 1e-9)
        time, distance, looked = (own(times[shown]) if exact else t), None, 1
    else:
        if t - FINGERPRINT_WINDOW_SECONDS > duration + 1e-6:
            reason = (f"the video ends before t={_js(_js_round(t - FINGERPRINT_WINDOW_SECONDS, 6))}, where the window of the row "
                      f"at t={_js(t)} starts")
            return {**line, "status": "failed", "reason": reason}
        window = [(own(time), value) for time, value in
                  _events_window(video, t - FINGERPRINT_WINDOW_SECONDS - offset, t + FINGERPRINT_WINDOW_SECONDS - offset)]
        distance, _, time = min((hamming(value, fingerprint), abs(time - t), time) for time, value in window)
        looked = len(window)
    line["frame"] = {"mediaTime": time, "offset": _js_round(time - t, 3), "distance": distance, "looked": looked, "exactTime": exact}
    if distance is not None and distance > SAME_FRAME_MAX_HAMMING:
        return {**line, "status": "unreachable"}

    def outcome(index: int, x: float, y: float) -> dict:
        shown = layer.at(x * layer.frame_width, y * layer.frame_height)
        face = None if shown.index is None else [box for box in boxes if box["face"] is not None][shown.index]
        return {"index": index, "x": x, "y": y, "cardId": shown.card_id, "name": shown.name,
                "box": None if face is None else face["box"],
                "similarity": None if face is None else face["face"]["similarity"],
                "margin": None if face is None else face["face"]["margin"],
                "accepted": None if face is None else face["face"]["accepted"]}

    def center(quad: list[list[float]]) -> tuple[float, float]:  # browser/score/manifest.ts adds the corners in this order
        return (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4, (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4

    return {**line, "status": "kept", "analyzed": {"width": layer.frame_width, "height": layer.frame_height}, "backend": dict(backend),
            "points": [outcome(index, point["x"], point["y"]) for index, point in enumerate(row.get("points", []))],
            "centers": [outcome(index, *center(box["quad"])) for index, box in enumerate(row.get("boxes", []))]}


def section_events() -> dict:
    boxes, proposals = _events_boxes()
    layer = HoverLayer(proposals, 1280, 720, ACCEPTED_NMS)
    videos = {video["file"]: video for video in _events_videos()}
    # Each row with the file that serves it and where that file starts in the video (None: a whole video).
    plan = [
        (_events_row("EXAMPLE0001", 5.017, 2560, 1440), "EXAMPLE0001.mp4", None),                    # kept, by its fingerprint
        (_events_row("EXAMPLE0001", 9.017, 2560, 1440), "EXAMPLE0001.mp4", None),                    # unreachable
        (_events_row("EXAMPLE0001", 12.017, 2560, 1440, fingerprint=False, boxes=False), "EXAMPLE0001.mp4", None),   # kept, by time
        (_events_row("EXAMPLE0001", 25.5, 2560, 1440), "EXAMPLE0001.mp4", None),                     # failed: past the end
        (_events_row("EXAMPLE0002", 5.017, 1280, 720), None, None),                                  # no video file
        (_events_row("EXAMPLE0003", 5.017, 1280, 720), "EXAMPLE0003.mp4", None),                     # another shape
        (_events_row("EXAMPLE0004", 80.017, 1280, 720), "youtube-EXAMPLE0004+77.mp4", 77.0),         # kept, in a section
        (_events_row("kitchen-table-01", 5.017, 1280, 720, platform="local"), "local-kitchen-table-01.webm", None),  # kept, times asked for
    ]
    manifest_lines = [json.dumps(row) for row, _, _ in plan]
    manifest = {"file": "events.manifest.jsonl", "lines": manifest_lines}
    release = {"id": "0123456789abcdef", "game": "generated", "locale": "en",
               "detector": {"version": "fixture-detector", "ep": "wasm"}, "recognizer": {"version": "fixture-recognizer", "ep": "wasm"},
               "bankCards": 3, "catalogCards": 3, "identityLevel": IDENTITY_NAME,
               "decode": {"threshold": 0.3, "nmsIou": 0.45, "maxProposals": 80, "minCropPx": 24},
               "accept": {"tau": 0.62, "delta": 0.05, "rotationRetry": True}, "hoverSelection": ACCEPTED_NMS, "hoverMaxAgeMs": 2000,
               "analysisWidth": {"min": MIN_ANALYSIS_WIDTH, "max": MAX_ANALYSIS_WIDTH}, "ortWeb": "1.29.0"}
    package = json.loads((ROOT / "browser" / "package.json").read_text(encoding="utf-8"))
    run = {"userAgent": "FixtureBrowser/1.0 (a made-up user agent)", "asked": "wasm", "role": EVENTS_ROLE,
           "runtime": {"name": package["name"], "version": package["version"]}}
    backend = {"detector": release["detector"]["ep"], "recognizer": release["recognizer"]["ep"]}
    header = {
        "kind": "cardvision-browser-events", "version": 1,
        "release": {"id": release["id"], "game": release["game"], "locale": release["locale"],
                    "detector": {"version": release["detector"]["version"], **release["decode"]},
                    "recognizer": {"version": release["recognizer"]["version"]},
                    "identity": {"level": release["identityLevel"]},
                    "accept": dict(release["accept"]),
                    "hover": {"selection": release["hoverSelection"], "nmsIou": ACCEPTED_NMS_IOU},
                    "analysisWidth": dict(release["analysisWidth"]), "ortWeb": release["ortWeb"]},
        "runtime": dict(run["runtime"]),
        "userAgent": run["userAgent"],
        "backend": {"asked": run["asked"], **backend},
        "role": run["role"],
        "manifests": [{"file": manifest["file"], "sha256": hashlib.sha256(("\n".join(manifest_lines) + "\n").encode()).hexdigest(),
                       "rows": len(manifest_lines)}],
        "frameSelection": {"windowSeconds": FINGERPRINT_WINDOW_SECONDS, "maxHamming": SAME_FRAME_MAX_HAMMING},
    }
    lines = [js_line(header)] + [js_line(_events_line(row, videos.get(file), start, layer, boxes, backend)) for row, file, start in plan]
    return {
        "note": "a scoring run of the browser runtime on made-up inputs, and the events file it must write. manifest.lines: "
                "the manifest, one row a line. videos: the files given; frame k of a file is at k / rate seconds and has "
                "the fingerprint prints[k], or otherPrint; reportsFrameTimes false means the browser reports, for a frame, "
                "the time it was asked for. analysis: what the analysis of any kept frame finds, as the runtime's "
                "FrameAnalysis gives it (frame and boxes); the hover layer is the release's selection over these boxes. "
                "release and run: what the run's header is written from. lines: the events file, line for line, as the "
                "page must write it and as cardvision.evaluate.browser must read it.",
        "manifest": manifest, "names": EVENTS_NAMES, "videos": list(videos.values()),
        "analysis": {"frame": {"width": 1280, "height": 720}, "boxes": boxes},
        "release": release, "run": run, "lines": lines,
    }


def build_contract() -> dict:
    return {
        "about": "Inputs and the answers the Python package gives for them. Written by tests/test_browser_fixtures.py "
                 "--write; read by the browser runtime's tests and checked again by pytest.",
        "synthetic": SYNTHETIC,
        "preprocess": section_preprocess(),
        "letterbox": section_letterbox(),
        "analysisSize": section_analysis_size(),
        "decode": section_decode(),
        "bank": section_bank(),
        "identity": section_identity(),
        "facets": section_facets(),
        "extra": section_extra(),
        "art": section_art(),
        "looks": section_looks(),
        "hover": section_hover(),
        "dhash": section_dhash(),
        "events": section_events(),
        "geometricIndex": section_geometric_index(),
    }


# ------------------------------------------------------------------- the packed geometric index
GEO_BANK_SHA = "b" * 64
GEO_VOTE = {"ratio": 0.8}
GEO_FUSION = {"weight": 1.5, "minInliers": 15, "fullInliers": 50, "penalty": 0.0}


def _geo_toy() -> dict:
    """A toy descriptor index (an ``cardvision-geometric-index`` document, as ``build-features``
    writes it, from arithmetic: no OpenCV, no image), the identity and image of each card for the
    vote's exemption, and the queries. Row pairs that tie are planted on purpose."""
    from cardvision.geometric.index import _b64

    stream = Stream(7001)
    sizes = [("TOY-A", 12), ("TOY-B", 9), ("TOY-C", 0), ("TOY-D", 14), ("TOY-E", 7), ("TOY-F", 6)]
    desc = {card: np.array([[stream.below(256) for _ in range(32)] for _ in range(n)], dtype=np.uint8).reshape(n, 32)
            for card, n in sizes}
    desc["TOY-B"][2] = desc["TOY-A"][5]      # two cards, one descriptor: a tie between rivals
    desc["TOY-E"][0] = desc["TOY-D"][0]      # the same, between two cards of one identity
    desc["TOY-F"][1] = desc["TOY-A"][2]      # and between two cards taken from one image
    desc["TOY-A"][8] = desc["TOY-A"][7]      # the same, inside one card
    identity = {"TOY-A": 0, "TOY-B": 1, "TOY-C": 2, "TOY-D": 3, "TOY-E": 3, "TOY-F": 4}
    art = {"TOY-A": "0" * 16, "TOY-B": "1" * 15 + "0", "TOY-C": "2" * 16, "TOY-D": "3" * 16, "TOY-E": "4" * 16,
           "TOY-F": "0" * 16}                # F was taken from A's image
    cards = []
    for card, n in sizes:
        # positions a float32 only approximates (they are rounded once, as the index stores them)
        xy = np.array([[stream.between(0, 229) / 3, stream.between(0, 320) / 7] for _ in range(n)],
                      dtype=np.float32).reshape(n, 2)
        cards.append({"cardId": card, "artV": art[card], "width": 229, "height": 320, "n": n,
                      "xy": _b64(xy.astype("<f4")) if n else "", "desc": _b64(desc[card]) if n else ""})
    doc = {"schemaVersion": 1, "kind": "cardvision-geometric-index", "game": "toy", "locale": "en", "opencv": "5.0.0",
           "features": {"type": "orb", "maxFeatures": 300, "artLongSide": 320, "mask": [], "params": {
               "scaleFactor": 1.2, "nLevels": 8, "edgeThreshold": 15, "patchSize": 15, "fastThreshold": 10}},
           "descriptor": {"dtype": "uint8", "width": 32, "norm": "hamming"},
           "bank": {"version": 1, "sha256": GEO_BANK_SHA}, "cardCount": len(cards),
           "featureCount": sum(n for _, n in sizes), "cards": cards}
    rows = np.concatenate([desc[card] for card, _ in sizes])
    queries = [rows[3].copy(), rows[3].copy(), rows[5].copy(), rows[21].copy(), rows[7].copy(), rows[2].copy()]
    queries[1][0] ^= 0b101  # two bits off row 3
    # rows 5 and 14 tie (A5, B2); row 21 is TOY-D row 0, tied with TOY-E; 7 and 8 are TOY-A's; 2 ties F1
    for _ in range(18):
        base = rows[stream.below(len(rows))].copy()
        for _ in range(stream.below(60)):
            base[stream.below(32)] ^= 1 << stream.below(8)
        queries.append(base)
    queries.append(np.array([stream.below(256) for _ in range(32)], dtype=np.uint8))
    return {"doc": doc, "rows": rows, "queries": np.array(queries, dtype=np.uint8), "identity": identity, "art": art,
            "ids": [card for card, _ in sizes], "counts": [n for _, n in sizes]}


def _geo_knn2(rows: np.ndarray, queries: np.ndarray) -> dict:
    """Nearest and second nearest row of each query by Hamming distance, a tie to the lowest row
    (OpenCV's brute-force matcher keeps the first of equal distances)."""
    best, second, d_best, d_second = [], [], [], []
    for query in queries:
        dist = np.unpackbits(rows ^ query, axis=1).sum(axis=1)
        order = np.argsort(dist, kind="stable")
        best.append(int(order[0]))
        second.append(int(order[1]))
        d_best.append(int(dist[order[0]]))
        d_second.append(int(dist[order[1]]))
    return {"best": best, "second": second, "dBest": d_best, "dSecond": d_second}


def _geo_votes(toy: dict, knn: dict) -> dict:
    """``GeometricStage.votes`` on the toy: card id to votes (the ratio test, waived for two
    cards of one identity or one image)."""
    row_card = [card for card, n in zip(toy["ids"], toy["counts"]) for _ in range(n)]
    counts: dict[str, int] = {}
    for best, second, d_best, d_second in zip(knn["best"], knn["second"], knn["dBest"], knn["dSecond"]):
        card, other = row_card[best], row_card[second]
        rivals = other != card and toy["identity"][other] != toy["identity"][card] and toy["art"][other] != toy["art"][card]
        if rivals and d_best >= GEO_VOTE["ratio"] * d_second:
            continue
        counts[card] = counts.get(card, 0) + 1
    return counts


def _geo_fused(cosine: float, evidence: int) -> float:
    """``GeometricStage.fused_score`` for the passed configuration's fusion block."""
    if evidence >= GEO_FUSION["minInliers"]:
        return cosine + GEO_FUSION["weight"] * min(evidence, GEO_FUSION["fullInliers"]) / GEO_FUSION["fullInliers"]
    return cosine - GEO_FUSION["penalty"]


def _geo_pack(toy: dict) -> tuple[dict, list[bytes], str]:
    from cardvision.geometric.index import parse_index
    from cardvision.geometric.pack import pack_index

    body = canonical_bytes(toy["doc"])
    manifest, blobs = pack_index(parse_index(toy["doc"]), sha256_hex(body))
    return manifest, blobs, sha256_hex(body)


def section_geometric_index() -> dict:
    """The toy packed index (manifest and shards) and what Python makes of it."""
    from cardvision.geometric.index import parse_index

    toy = _geo_toy()
    manifest, blobs, source = _geo_pack(toy)
    index = parse_index(toy["doc"])
    knn = _geo_knn2(toy["rows"], toy["queries"])
    cosines = [0.5, 0.62, 0.71, 0.3333333333333333, 0.9]
    evidences = [0, 14, 15, 33, 50, 80]
    return {
        "about": "The toy index packed by cardvision pack-features: 'manifest' and the eight 'shards' (hex of each shard's bytes). 'cards' lists each card's "
                 "unpacked descriptors (hex) and positions (the hex of their little-endian float32 bytes); 'knn' is "
                 "each query's nearest and second nearest row over all rows (ties to the lowest row); 'votes' is "
                 "GeometricStage.votes on it (ratio 0.8, waived for one identity or one image).",
        "manifest": manifest, "shards": [blob.hex() for blob in blobs],
        "sourceSha256": source, "bankSha256": GEO_BANK_SHA, "manifestSha256": sha256_hex(canonical_bytes(manifest)),
        "shardSha256": [shard["sha256"] for shard in manifest["shards"]],
        "rows": index.feature_count(),
        "cards": [{"cardId": card, "n": len(index.cards[card]), "desc": hexed(index.cards[card].descriptors),
                   "xy": hexed(index.cards[card].xy.astype("<f4")), "identity": toy["identity"][card],
                   "artV": toy["art"][card]} for card in index.ids],
        "queries": hexed(toy["queries"]),
        "knn": knn,
        "votes": _geo_votes(toy, knn),
        "ratio": GEO_VOTE["ratio"],
        "fusion": {**GEO_FUSION, "cases": [{"cosine": c, "evidence": e, "fused": _geo_fused(c, e)}
                                           for c in cosines for e in evidences]},
    }



# ------------------------------------------------------------------------------ the toy release
def build_toy_release(folder: Path, rows: np.ndarray | None = None, art_out: Path | None = None) -> None:
    """Write a release of the toy game into ``folder``, with stand-in models built on the spot.

    ``rows`` are the rows the stand-in detector returns for any image (default: all zero, so it
    finds nothing). ``art_out``, when given, receives the toy game's card images.
    """
    sys.path.insert(0, str(ROOT / "tests"))
    import toy_game
    from test_infer_toy_models import build_detector, build_recognizer

    from cardvision.bank import build as BB
    from cardvision.core.catalog import load_catalog
    from cardvision.core.onnx import create_session

    folder.mkdir(parents=True, exist_ok=True)
    accept = {"tau": 0.9, "delta": 0.02, "rotationRetry": True}
    with tempfile.TemporaryDirectory() as scratch:
        catalog_path, art_dir = toy_game.write_toy_game(Path(scratch))
        shutil.copy(catalog_path, folder / "catalog.json")
        (folder / "accept.json").write_text(json.dumps(accept), encoding="utf-8")
        build_recognizer(folder / "recognizer.onnx")
        detector_rows = np.zeros((R.yolox_anchor_count(640, 384), 7), dtype=np.float32)
        if rows is not None:
            detector_rows[: len(rows)] = rows
        build_detector(folder / "detector.onnx", detector_rows)
        catalog = load_catalog(folder / "catalog.json")
        bank = BB.build_bank(catalog, art_dir, create_session(folder / "recognizer.onnx"), model="toy-recognizer").bank
        BB.write_bank(bank, catalog, folder / "bank.json", overwrite=True)
        if art_out is not None:
            shutil.copytree(art_dir, art_out, dirs_exist_ok=True)
    R.build_release(folder / "release.json", overwrite=True, detector=folder / "detector.onnx",
                    recognizer=folder / "recognizer.onnx", bank=folder / "bank.json", catalog=folder / "catalog.json",
                    accept=accept, detector_version="toy-detector")


# One table for the demo page: five cards, one of them turned a quarter, and a card back.
DEMO_CARDS = [("TOY-001", 40, 40, 0), ("TOY-003", 320, 40, 1), ("TOY-007", 700, 40, 0), ("TOY-011", 980, 40, 0),
              ("TOY-017", 40, 420, 0)]
DEMO_BACK = (420, 420, 240, 336)
DEMO_NAMES = ["Amber Circle", "Coral Triangle", "Azure Circle", "Slate Stripes", "Amber Stripes"]


DEMO_RECORDING = "table"    # the name of the toy video as a recording of one's own: its file is table.webm
DEMO_SECONDS, DEMO_RATE = 6, 30
DEMO_ROW_TIMES = (1.5, 3.5, 4.5)


def _demo_seconds(table: np.ndarray) -> list[np.ndarray]:
    """The table once for each second of the toy video. The free part of the table, under the
    two cards on the right, carries a pattern of gray blocks that is another one each second,
    so that each second has a fingerprint of its own. The blocks are cells of the
    fingerprint's 9 x 8 grid, and neighbors in a row differ clearly."""
    height, width = table.shape[:2]
    stream, seconds, prints = Stream(8001), [], []
    while len(seconds) < DEMO_SECONDS:
        frame = table.copy()
        for row in range(4, 8):
            level = None
            for column in range(5, 9):
                level = next(value for value in iter(lambda: stream.below(8), None) if level is None or abs(value - level) >= 2)
                frame[row * height // 8:(row + 1) * height // 8, column * width // 9:(column + 1) * width // 9] = 20 + 30 * level
        if all(hamming(dhash(frame), other) >= 6 for other in prints):
            seconds.append(frame)
            prints.append(dhash(frame))
    return seconds


def write_demo_video(out_dir: Path, table: np.ndarray, boxes: Sequence[tuple[int, int, int, int]]) -> bool:
    """Write ``table.webm`` and ``labels/table.manifest.jsonl`` for the scoring page. False,
    with nothing written, when OpenCV is not installed or cannot write the video."""
    from cardvision.data.manifest import write_manifest
    from cardvision.data.schema import Box, Point, Row

    try:
        import cv2
    except ImportError:
        return False
    height, width = table.shape[:2]
    seconds = _demo_seconds(table)
    video = out_dir / f"{DEMO_RECORDING}.webm"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"VP80"), float(DEMO_RATE), (width, height))
    if not writer.isOpened():
        return False
    for second in seconds:
        for _ in range(DEMO_RATE):
            writer.write(np.ascontiguousarray(second[:, :, ::-1]))
    writer.release()

    def quad(x: float, y: float, w: float, h: float) -> tuple[tuple[float, float], ...]:
        return ((x / width, y / height), ((x + w) / width, y / height), ((x + w) / width, (y + h) / height), (x / width, (y + h) / height))

    faces = [Box(kind="face", quad=quad(*box), card_id=card, identity="named", readable="yes", id=card)
             for (card, _, _, _), box in zip(DEMO_CARDS, boxes)]
    back = Box(kind="back", quad=quad(*DEMO_BACK), id="back")
    points = (Point(x=(boxes[0][0] + 60) / width, y=(boxes[0][1] + 80) / height, kind="face", card_id=DEMO_CARDS[0][0],
                    identity="named", readable="yes", id="on-the-first-card"),
              Point(x=(DEMO_BACK[0] + 120) / width, y=(DEMO_BACK[1] + 160) / height, kind="back", id="on-the-back"),
              Point(x=0.3, y=0.97, kind="not-card", id="on-the-table"))

    def row(t: float, **labels) -> Row:
        return Row(platform="local", video_id=DEMO_RECORDING, t=t, frame_width=width, frame_height=height, source_type="digital",
                   group="g-toy-table", role="evaluation", trained_on=False, credit="toy",
                   attributes={"frame_dhash": dhash(seconds[int(t)])}, **labels)

    first, second, third = DEMO_ROW_TIMES
    rows = [row(first, completeness="exhaustive-boxes", boxes=(*faces, back), points=points),
            row(second, completeness="exhaustive-boxes", boxes=(*faces, back)),
            row(third, completeness="points", points=points)]
    (out_dir / "labels").mkdir(exist_ok=True)
    write_manifest(out_dir / "labels" / f"{DEMO_RECORDING}.manifest.jsonl", rows)
    return True


def write_demo(out_dir: Path) -> None:
    """Write a toy release, the card images, ``table.png`` and the toy video with its manifest
    (see the module's description)."""
    from test_infer_toy_models import detector_rows, make_scene, save_image

    out_dir = Path(out_dir)
    resolved = out_dir.resolve()
    if resolved == ROOT or ROOT in resolved.parents:
        sys.exit(f"{out_dir} lies inside the repository, which holds no images and no model files; choose a folder outside it")
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as scratch:
        import toy_game

        _, art_dir = toy_game.write_toy_game(Path(scratch))
        frame, boxes = make_scene(art_dir, DEMO_CARDS)
    x, y, width, height = DEMO_BACK
    frame[y:y + height, x:x + width] = (60, 30, 90)  # the back: a plain rectangle
    rows = detector_rows([*boxes, DEMO_BACK], [0.95, 0.9, 0.85, 0.8, 0.75, 0.7], [0, 0, 0, 0, 0, 1])
    build_toy_release(out_dir / "release", rows, art_out=out_dir / "art")
    save_image(out_dir / "table.png", frame)
    print(f"wrote {out_dir / 'release' / 'release.json'}, {out_dir / 'art'} and {out_dir / 'table.png'}")
    print("the cards on the table: " + ", ".join(DEMO_NAMES) + ", and a card back")
    if write_demo_video(out_dir, frame, boxes):
        print(f"for the scoring page: {out_dir / (DEMO_RECORDING + '.webm')} and "
              f"{out_dir / 'labels' / (DEMO_RECORDING + '.manifest.jsonl')} ({len(DEMO_ROW_TIMES)} rows)")
    else:
        print("no video for the scoring page was written: that needs OpenCV (python -m pip install -e \".[video]\")")


def contract_text(contract: dict) -> str:
    """The contract as indented JSON, with every list of plain values on one line."""
    text = json.dumps(contract, indent=1)
    return re.sub(r"\[\s+([^\[\]{}]*?)\s+\]", lambda found: "[" + re.sub(r",\s+", ", ", found.group(1)) + "]", text) + "\n"


def write_fixtures() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    CONTRACT.write_text(contract_text(build_contract()), encoding="utf-8")
    with tempfile.TemporaryDirectory() as scratch:
        built = Path(scratch) / "release"
        build_toy_release(built)
        if TOY_RELEASE.exists():
            shutil.rmtree(TOY_RELEASE)
        TOY_RELEASE.mkdir(parents=True)
        for file in sorted(built.iterdir()):
            if file.name not in MODEL_FILES:  # no model file is kept in the repository
                shutil.copy(file, TOY_RELEASE / file.name)
    print(f"wrote {CONTRACT.relative_to(ROOT)} and {TOY_RELEASE.relative_to(ROOT)}/")


# --------------------------------------------------------------------------------- the checks
def test_the_contract_file_holds_what_the_python_code_computes_now():
    stored = json.loads(CONTRACT.read_text(encoding="utf-8"))
    current = json.loads(json.dumps(build_contract()))  # through JSON, as the file went
    assert sorted(stored) == sorted(current)
    # The scores and margins of the bank's looks are sums of 128 products that BLAS adds in an
    # order of its own, which differs between processors (arm64 macOS and x86-64 Linux differ
    # in the last bits). The browser's test holds them to 12 decimal places for the same reason;
    # here every other value, and the best row of each look, must be equal.
    stored_looks, current_looks = stored["bank"].pop("looks"), current["bank"].pop("looks")
    assert [look["top"] for look in stored_looks] == [look["top"] for look in current_looks]
    for key in ("score", "margin"):
        assert [look[key] for look in stored_looks] == pytest.approx([look[key] for look in current_looks], rel=0, abs=1e-12)
    for section in current:
        assert stored[section] == current[section], f"{section}: run python tests/test_browser_fixtures.py --write"


def test_the_events_fixture_is_read_checked_and_scored_by_this_package(tmp_path):
    """The lines of ``events`` are, character for character, what the scoring page's own run
    and writer produce for the fixture's inputs (``browser/test/score.test.ts`` requires it).
    Here the same lines go through this package's reader, its checks and its scorer."""
    from collections import Counter

    from cardvision.evaluate.browser import check_correspondence, manifest_warnings, read_browser_events, run_browser_hover
    from cardvision.evaluate.rows import read_rows

    stored = json.loads(CONTRACT.read_text(encoding="utf-8"))["events"]
    manifest = tmp_path / "labels" / stored["manifest"]["file"]
    manifest.parent.mkdir()
    manifest.write_text("\n".join(stored["manifest"]["lines"]) + "\n", encoding="utf-8")
    events = tmp_path / "browser-events.jsonl"
    events.write_text("\n".join(stored["lines"]) + "\n", encoding="utf-8")

    run = read_browser_events(events)
    assert [found.status for found in run.rows.values()] == [
        "kept", "unreachable", "kept", "failed", "no-video", "frame-shape", "kept", "kept"]
    rows, account = read_rows([manifest], stored["run"]["role"])
    assert len(rows) == 8
    # The header records the hash of the manifest the run read, and it is this manifest.
    assert manifest_warnings(run, account.manifests) == []
    check_correspondence(rows, run, stored["run"]["role"])

    scored = run_browser_hover(rows, run, stored["names"], account)
    assert account.used == 4 and account.unusable == {"unreachable": 1, "failed": 1, "no-video": 1, "frame-shape": 1}
    assert [entry.get("detail") for entry in account.not_scored] == [
        "the nearest frame was 40 bits from the row's fingerprint",
        "the video ends before t=24.5, where the window of the row at t=25.5 starts", None, "the video is 900 x 900"]
    # Three rows with seven events each, and the row without boxes with its three points.
    assert len(scored) == 3 * 7 + 3
    first = {item.event.label: item for item in scored if (item.event.video_id, item.event.t) == ("EXAMPLE0001", 5.017)}
    assert {label: (item.outcome, item.shown) for label, item in first.items()} == {
        "on-alder": ("right", "Alder"), "table": ("nothing", None), "on-back": ("nothing", None),
        "alder": ("right", "Alder"), "birch": ("nothing", None), "cedar": ("nothing", None), "back": ("nothing", None)}
    # The video is twice the size of the analyzed frame: the recorded box is brought to its pixels.
    assert first["alder"].box == (160.0, 120.0, 400.0, 560.0)
    # A box that reaches tau and fails the margin takes the pointer and shows nothing; one that
    # does not reach tau is not in the hover layer at all.
    assert first["birch"].box == (800.0, 120.0, 400.0, 560.0) and first["cedar"].box is None
    assert Counter(item.outcome for item in scored) == {"right": 7, "nothing": 17}
    # The row read where the browser reports the time it was asked for says so.
    last = run.rows[("local", "kitchen-table-01", 5.017)].line["frame"]
    assert last["exactTime"] is False and 5.0 <= last["mediaTime"] < 5.0 + 1 / 30 and last["looked"] == 126


def test_the_fingerprint_fixture_turns_on_how_a_half_is_rounded():
    """The ``halves`` image has no bit set under the fingerprint's rounding, and would have some
    under any other, so a runtime that rounds halves another way fails on it."""
    halves = _halves_image()
    assert dhash(halves) == "0000000000000000"
    gray = 0.299 * halves[:, :, 0] + 0.587 * halves[:, :, 1] + 0.114 * halves[:, :, 2]
    for other in (np.floor(gray + 0.5), np.floor(gray), np.ceil(gray)):
        cells = other.reshape(8, 9, 2).mean(axis=2)
        assert (cells[:, 1:] > cells[:, :-1]).any()


def test_the_generated_inputs_are_what_the_description_says():
    image = synthetic_rgba(7, 3, 2)
    # Row 0 by hand: s = 7, then three shifts per byte.
    s, expected = 7, []
    for _ in range(4):
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        expected.append(s >> 24)
    assert image.shape == (2, 3, 4) and image[0, 0].tolist() == expected
    assert 0 <= Stream(1).unit() < 1


def test_the_toy_release_is_one_this_package_accepts_but_for_its_model_files():
    doc = read_json(TOY_RELEASE / "release.json")
    assert doc["game"] == "toy" and R.release_id(doc) == doc["id"]
    assert sorted(path.name for path in TOY_RELEASE.iterdir()) == [
        "accept.json", "bank.identity-groups.json", "bank.json", "catalog.json", "release.json"]
    for block in (doc["bank"], doc["identity"]["groups"], doc["catalog"]):
        body = (TOY_RELEASE / block["path"]).read_bytes()
        assert (sha256_hex(body), len(body)) == (block["sha256"], block["bytes"])
    assert sorted(doc[label]["path"] for label in ("detector", "recognizer")) == sorted(MODEL_FILES)
    assert R.release_errors(doc, TOY_RELEASE) == [
        "detector: file detector.onnx is missing", "recognizer: file recognizer.onnx is missing"]


def test_the_runtime_s_defaults_are_this_package_s():
    """The numbers a release is built with unless told otherwise, as the browser runtime's
    tests read them from the toy release: a change here has to be made on both sides."""
    doc = read_json(TOY_RELEASE / "release.json")
    assert doc["detector"]["decode"]["threshold"] == 0.3 and doc["detector"]["decode"]["nms"]["iou"] == 0.45
    assert doc["detector"]["decode"]["maxProposals"] == 80 and doc["detector"]["minCropPx"] == 24
    assert doc["detector"]["decode"]["letterbox"]["pad"] == 114
    assert doc["hover"] == {"selection": "accepted-nms", "maxAgeMs": 2000}
    assert doc["runtime"] == {"ortWeb": "1.29.0", "executionProviders": ["webgpu", "wasm"], "wasmThreads": 1,
                              "analysisWidth": {"min": 720, "max": 1920}}
    assert letterbox_ratio(1280, 768) == 0.5


def test_the_demo_release_names_the_cards_on_its_table(tmp_path):
    """The folder ``--demo`` writes is a release this package accepts, and ``cardvision infer``
    names the five cards of its table and leaves the back unnamed."""
    import pytest

    pytest.importorskip("onnx")
    sys.path.insert(0, str(ROOT / "tests"))
    write_demo(tmp_path / "demo")
    release = tmp_path / "demo" / "release"
    doc = R.verify_release(release / "release.json")
    from cardvision.core.catalog import load_catalog
    from cardvision.core.images import load_rgb
    from cardvision.infer.pipeline import Pipeline
    from cardvision.recognize import parse_accept

    pipeline = Pipeline.open(release / doc["detector"]["path"], release / doc["recognizer"]["path"], release / doc["bank"]["path"],
                             load_catalog(release / doc["catalog"]["path"]), parse_accept(doc["accept"]))
    result = pipeline.analyze(load_rgb(tmp_path / "demo" / "table.png"))
    assert [card.recognition.name for card in result.faces] == DEMO_NAMES
    assert [card.class_name for card in result.cards] == ["face"] * 5 + ["back"]
    assert sorted(path.name for path in (tmp_path / "demo" / "art").iterdir())[:2] == ["TOY-001.png", "TOY-002.png"]


def test_the_demo_video_and_its_manifest_give_python_every_row(tmp_path, capsys):
    """The toy video and the manifest ``--demo`` writes for the scoring page: the manifest is
    valid, ``cardvision fetch`` finds each row's frame in the video by its fingerprint, and the
    demo release names the labeled cards on those frames."""
    import pytest

    pytest.importorskip("onnx")
    pytest.importorskip("cv2")
    from cardvision import cli

    sys.path.insert(0, str(ROOT / "tests"))
    demo = tmp_path / "demo"
    write_demo(demo)
    said = capsys.readouterr().out.splitlines()
    assert said[2] == f"for the scoring page: {demo / 'table.webm'} and {demo / 'labels' / 'table.manifest.jsonl'} (3 rows)"
    manifest, video, release = demo / "labels" / "table.manifest.jsonl", demo / "table.webm", demo / "release" / "release.json"
    assert sorted(path.name for path in manifest.parent.iterdir()) == ["table.manifest.jsonl"]
    assert cli.main(["validate-manifest", str(manifest), "--catalog", str(release.parent / "catalog.json")]) == 0
    assert cli.main(["fetch", str(manifest), "--out", str(tmp_path / "frames"), "--video-file", f"{DEMO_RECORDING}={video}"]) == 0
    found = [json.loads(line) for line in (tmp_path / "frames" / "index.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [(entry["t"], entry["status"]) for entry in found] == [(t, "ok") for t in DEMO_ROW_TIMES]
    assert all(entry["distance"] <= SAME_FRAME_MAX_HAMMING and abs(entry["offset"]) < 0.5 for entry in found)
    capsys.readouterr()
    assert cli.main(["evaluate", "hover", "--manifest", str(manifest), "--frames", str(tmp_path / "frames"), "--release", str(release),
                     "--out", str(tmp_path / "results"), "--bootstrap", "20"]) == 0
    overall = json.loads((tmp_path / "results" / "evaluate-hover.json").read_text(encoding="utf-8"))["results"]["overall"]
    assert (overall["namedRight"]["numerator"], overall["namedRight"]["denominator"]) == (12, 12)
    assert (overall["wrongOfShown"]["numerator"], overall["wrongOfShown"]["denominator"]) == (0, 12)


def test_the_packed_toy_index_unpacks_to_the_index_it_came_from(tmp_path):
    from cardvision.geometric.index import parse_index
    from cardvision.geometric.pack import unpack, verify_round_trip, write_packed

    toy = _geo_toy()
    index = parse_index(toy["doc"])
    packed, blobs, _ = _geo_pack(toy)
    write_packed(tmp_path, packed, blobs)
    verify_round_trip(index, tmp_path)
    manifest, cards = unpack(tmp_path)
    assert manifest["source"]["sha256"] == sha256_hex(canonical_bytes(toy["doc"]))
    assert [shard["rows"] for shard in manifest["shards"]].count(0) >= 1  # an empty shard is legal
    assert sum(shard["rows"] for shard in manifest["shards"]) == len(toy["rows"])
    assert cards["TOY-C"][0].shape == (0, 32)


def test_the_toy_knn_follows_the_tie_rule_of_opencv_s_matcher():
    cv2 = pytest.importorskip("cv2")
    toy = _geo_toy()
    knn = _geo_knn2(toy["rows"], toy["queries"])
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    for q, pair in enumerate(matcher.knnMatch(toy["queries"], toy["rows"], k=2)):
        assert (pair[0].trainIdx, pair[1].trainIdx) == (knn["best"][q], knn["second"][q])
        assert (int(pair[0].distance), int(pair[1].distance)) == (knn["dBest"][q], knn["dSecond"][q])
    assert 0 in knn["dBest"] and knn["dBest"][2] == knn["dSecond"][2] == 0  # the planted tie


def test_the_toy_votes_exercise_the_ratio_test_and_both_exemptions():
    toy = _geo_toy()
    knn = _geo_knn2(toy["rows"], toy["queries"])
    row_card = [card for card, n in zip(toy["ids"], toy["counts"]) for _ in range(n)]
    pairs = {(row_card[b], row_card[s]) for b, s in zip(knn["best"], knn["second"])}
    assert ("TOY-A", "TOY-B") in pairs and ("TOY-D", "TOY-E") in pairs and ("TOY-A", "TOY-A") in pairs
    assert ("TOY-A", "TOY-F") in pairs
    votes = _geo_votes(toy, knn)
    assert votes and sum(votes.values()) < len(toy["queries"])  # some query failed the ratio test
    assert votes.get("TOY-D", 0) >= 1                          # a tie waived for one identity


def test_pack_features_refuses_a_source_the_settings_file_does_not_pin(tmp_path):
    from cardvision.geometric.pack import PackError, pack_file

    index = tmp_path / "toy.features.json"
    index.write_bytes(canonical_bytes(_geo_toy()["doc"]))
    settings = tmp_path / "geometric.json"
    settings.write_text(json.dumps({"index": {"path": str(index), "sha256": "0" * 64}}), encoding="utf-8")
    with pytest.raises(PackError, match="pins"):
        pack_file(index, tmp_path / "out", config=settings)
    settings.write_text(json.dumps({"index": {"path": str(index), "sha256": sha256_hex(index.read_bytes())}}),
                        encoding="utf-8")
    manifest, body = pack_file(index, tmp_path / "out", config=settings)
    again, same = pack_file(index, tmp_path / "again", config=settings)
    assert body == same and [p.read_bytes() for p in sorted((tmp_path / "out").iterdir())] == \
        [p.read_bytes() for p in sorted((tmp_path / "again").iterdir())]
    assert manifest["kind"] == "geometric-index-packed" and len(manifest["shards"]) == 8


def test_pack_features_command_packs_and_reports(tmp_path, capsys):
    from cardvision import cli

    index = tmp_path / "toy.features.json"
    index.write_bytes(canonical_bytes(_geo_toy()["doc"]))
    assert cli.main(["pack-features", "--index", str(index), "--out", str(tmp_path / "packed")]) == 0
    said = capsys.readouterr().out
    assert "manifest sha256: " in said and "round trip: ok" in said
    assert cli.main(["pack-features", "--index", str(index), "--out", str(tmp_path / "packed")]) == 0  # same bytes: fine
    (tmp_path / "packed" / "shard-0.bin").write_bytes(b"x")
    assert cli.main(["pack-features", "--index", str(index), "--out", str(tmp_path / "packed")]) == 1


def test_a_packed_index_with_no_bank_is_refused():
    from cardvision.geometric.index import parse_index
    from cardvision.geometric.pack import PackError, pack_index

    doc = dict(_geo_toy()["doc"], bank=None)
    with pytest.raises(PackError, match="bank"):
        pack_index(parse_index(doc), "0" * 64)


if __name__ == "__main__":
    if sys.argv[1:] == ["--write"]:
        write_fixtures()
    elif len(sys.argv) == 3 and sys.argv[1] == "--demo":
        sys.path.insert(0, str(ROOT / "tests"))
        write_demo(Path(sys.argv[2]))
    else:
        sys.exit("usage: python tests/test_browser_fixtures.py --write | --demo OUT_DIR")
