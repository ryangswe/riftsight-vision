# SPDX-License-Identifier: Apache-2.0
"""The release document: build, verify, and every way a release can fail its checks."""

from __future__ import annotations

import copy
import json
import re
import shutil
from pathlib import Path

import numpy as np
import pytest

import toy_game
from cardvision import cli
from cardvision.bank import build as BB
from cardvision.bank import release as R
from cardvision.bank.documents import DocumentExistsError, canonical_bytes, read_json, sha256_hex
from cardvision.core.catalog import load_catalog, parse_catalog
from cardvision.core.onnx import create_session
from cardvision.recognize import AcceptRule, accept_errors, load_accept

ACCEPT = {"tau": 0.62, "delta": 0.05, "rotationRetry": True}
COMPONENTS = {"detector": "models/detector.onnx", "recognizer": "models/recognizer.onnx", "bank": "bank.json",
              "identity.groups": "bank.identity-groups.json", "catalog": "catalog.json"}


def write_tiny_detector(path: Path, size: int = 64, name_in: str = "images", name_out: str = "output") -> Path:
    """A model with a detector's interface and none of its skill: ``(n, 3, size, size)`` in,
    ``(n, anchors, 7)`` out, where ``anchors`` is what a YOLOX head gives for that input size."""
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    anchors = R.yolox_anchor_count(size, size)
    weights = np.random.default_rng(7).normal(size=(3, anchors * 7)).astype(np.float32)
    graph = helper.make_graph(
        [
            helper.make_node("GlobalAveragePool", [name_in], ["pooled"]),
            helper.make_node("Flatten", ["pooled"], ["flat"], axis=1),
            helper.make_node("MatMul", ["flat", "weights"], ["rows"]),
            helper.make_node("Reshape", ["rows", "shape"], [name_out]),
        ],
        "tiny-detector",
        [helper.make_tensor_value_info(name_in, TensorProto.FLOAT, ["n", 3, size, size])],
        [helper.make_tensor_value_info(name_out, TensorProto.FLOAT, ["n", anchors, 7])],
        [numpy_helper.from_array(weights, "weights"),
         numpy_helper.from_array(np.array([0, anchors, 7], dtype=np.int64), "shape")],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(path))
    return path


def components(root: Path, **changes) -> dict:
    """The arguments of ``build_release`` for the files laid out under ``root``."""
    arguments = {
        "detector": root / COMPONENTS["detector"],
        "recognizer": root / COMPONENTS["recognizer"],
        "bank": root / COMPONENTS["bank"],
        "catalog": root / COMPONENTS["catalog"],
        "accept": dict(ACCEPT),
    }
    arguments.update(changes)
    return arguments


@pytest.fixture(scope="module")
def built(toy, tiny_model, tmp_path_factory) -> Path:
    """A folder holding every component of a toy release and its ``release.json``."""
    root = tmp_path_factory.mktemp("release")
    shutil.copy(toy[0], root / "catalog.json")
    (root / "accept.json").write_text(json.dumps(ACCEPT), encoding="utf-8")
    write_tiny_detector(root / COMPONENTS["detector"])
    shutil.copy(tiny_model, root / COMPONENTS["recognizer"])
    catalog = load_catalog(root / "catalog.json")
    bank = BB.build_bank(catalog, toy[1], create_session(tiny_model), model="tiny").bank
    BB.write_bank(bank, catalog, root / "bank.json")
    R.build_release(root / "release.json", **components(root))
    return root


@pytest.fixture()
def folder(built, tmp_path) -> Path:
    """A copy of the built release for one test, free to be tampered with."""
    return Path(shutil.copytree(built, tmp_path / "release"))


def reseal(root: Path, label: str, doc: dict) -> None:
    """Make the document's seal of one component match the file as it is now."""
    block = doc["identity"]["groups"] if label == "identity.groups" else doc[label]
    body = (root / block["path"]).read_bytes()
    block.update({"sha256": sha256_hex(body), "bytes": len(body)})


def rewrite(root: Path, change) -> list[str]:
    """Apply ``change`` to the release document, give it its new id, write it, and verify."""
    doc = read_json(root / "release.json")
    change(doc)
    (root / "release.json").write_bytes(canonical_bytes(R.with_id(doc)))
    return errors_of(root)


def errors_of(root: Path) -> list[str]:
    try:
        R.verify_release(root / "release.json")
    except R.ReleaseError as error:
        return error.errors
    return []


# ----------------------------------------------------------------------- build and verify
def test_build_then_verify(built):
    doc = R.verify_release(built / "release.json")
    assert doc == read_json(built / "release.json")
    assert (built / "release.json").read_bytes() == canonical_bytes(doc)
    assert list(doc) == ["schemaVersion", "kind", "id", "game", "locale", "detector", "recognizer", "bank",
                         "identity", "catalog", "accept", "hover", "runtime"]
    assert doc["schemaVersion"] == 1 and doc["kind"] == "vision-release"
    assert (doc["game"], doc["locale"]) == ("toy", "en")
    assert re.fullmatch(r"[0-9a-f]{16}", doc["id"]) and doc["id"] == R.release_id(doc)
    assert R.release_errors(doc, built) == []


def test_every_component_is_pinned_by_path_hash_and_size(built):
    doc = read_json(built / "release.json")
    blocks = {"detector": doc["detector"], "recognizer": doc["recognizer"], "bank": doc["bank"],
              "identity.groups": doc["identity"]["groups"], "catalog": doc["catalog"]}
    for label, block in blocks.items():
        body = (built / COMPONENTS[label]).read_bytes()
        assert block["path"] == COMPONENTS[label]  # relative to the document, forward slashes
        assert block["sha256"] == sha256_hex(body) and block["bytes"] == len(body)


def test_the_blocks_describe_the_components(built):
    doc = read_json(built / "release.json")
    detector = doc["detector"]
    assert list(detector) == ["arm", "version", "path", "sha256", "bytes", "weights", "input", "decode",
                              "faceClass", "minCropPx"]
    assert (detector["arm"], detector["version"], detector["weights"]) == ("yolox", "detector", "fp32")
    # Read from the model: its tensor names and input size, and the anchor count that follows.
    assert detector["input"] == {"width": 64, "height": 64}
    assert detector["decode"]["letterbox"]["width"] == detector["decode"]["letterbox"]["height"] == 64
    assert detector["decode"]["output"]["anchors"] == 84
    assert (detector["decode"]["inputName"], detector["decode"]["outputName"]) == ("images", "output")
    assert (detector["faceClass"], detector["minCropPx"]) == (0, 24)

    recognizer = doc["recognizer"]
    assert list(recognizer) == ["version", "path", "sha256", "bytes", "weights", "dim", "inputName", "outputName",
                                "preprocessing"]
    assert (recognizer["version"], recognizer["weights"], recognizer["dim"]) == ("tiny", "fp32", 128)
    assert (recognizer["inputName"], recognizer["outputName"]) == ("x", "y")
    assert recognizer["preprocessing"] == {"id": "full128", "size": 128, "centerMask": False, "poolVersion": 2,
                                           "crop": "truncate"}

    assert {key: doc["bank"][key] for key in ("version", "cardCount", "entryCount", "views", "aggregation")} == {
        "version": 1, "cardCount": 20, "entryCount": 20, "views": 16, "aggregation": "mean"}
    assert doc["identity"]["level"] == "name" and doc["identity"]["display"] == "best-printing"
    assert doc["identity"]["groups"]["version"] == 1
    assert doc["catalog"]["cardCount"] == 20
    assert doc["accept"] == ACCEPT
    assert doc["hover"] == {"selection": "accepted-nms", "maxAgeMs": 2000}
    assert doc["runtime"] == {"ortWeb": "1.29.0", "executionProviders": ["webgpu", "wasm"], "wasmThreads": 1,
                              "analysisWidth": {"min": 720, "max": 1920}}


def test_the_default_detector_contract():
    detector = R.default_detector()
    assert detector["input"] == {"width": 640, "height": 384}
    assert detector["decode"] == {
        "inputName": "images", "outputName": "output", "layout": "NCHW", "channels": "BGR", "scale": "0-255",
        "letterbox": {"width": 640, "height": 384, "pad": 114, "anchor": "top-left", "resize": "pillow-bilinear",
                      "ratio": "min(height / frameHeight, width / frameWidth)", "size": "round(frame * ratio)"},
        "output": {"anchors": 5040, "columns": ["cx", "cy", "w", "h", "obj", "cls_face", "cls_back"],
                   "boxes": "cx, cy, w, h in letterbox px (decoded in the graph); frame px = / ratio"},
        "classes": ["face", "back"], "score": "obj * max(cls)", "class": "argmax(cls)", "threshold": 0.3,
        "nms": {"iou": 0.45, "classAgnostic": True, "greedy": True}, "maxProposals": 80,
    }
    assert R.yolox_anchor_count(640, 384) == 80 * 48 + 40 * 24 + 20 * 12


def test_the_id_is_the_hash_of_the_canonical_document(built):
    doc = read_json(built / "release.json")
    body = {key: value for key, value in doc.items() if key != "id"}
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    assert doc["id"] == sha256_hex(text.encode("utf-8"))[:16]
    # Key order and an existing id do not enter it; any value does.
    assert R.release_id(dict(reversed(list(doc.items())))) == doc["id"]
    assert R.release_id({**doc, "id": "0" * 16}) == doc["id"]
    assert R.release_id({**doc, "accept": {**ACCEPT, "tau": 0.63}}) != doc["id"]
    assert list(R.with_id(body))[:3] == ["schemaVersion", "kind", "id"] and R.with_id(body) == doc


def test_building_again_gives_the_same_release_and_other_settings_another(folder):
    before = (folder / "release.json").read_bytes()
    again = R.build_release(folder / "release.json", **components(folder))
    assert (folder / "release.json").read_bytes() == before and again["id"] == read_json(folder / "release.json")["id"]
    other = components(folder, settings={"hover": {"selection": "best-score"}})
    with pytest.raises(DocumentExistsError, match="already exists with different content; write to another path, or pass --overwrite to replace it"):
        R.build_release(folder / "release.json", **other)
    assert (folder / "release.json").read_bytes() == before
    changed = R.build_release(folder / "release.json", overwrite=True, **other)
    assert changed["id"] != again["id"] and changed["hover"] == {"selection": "best-score", "maxAgeMs": 2000}
    assert errors_of(folder) == []


def test_settings_override_parts_of_the_defaults(folder):
    settings = {
        "detector": {"version": "toy-detector", "weights": "fp16w", "decode": {"threshold": 0.25, "nms": {"iou": 0.5}}},
        "recognizer": {"weights": "fp16w"},
        "identity": {"display": "representative"},
        "runtime": {"executionProviders": ["wasm"]},
    }
    doc = R.build_release(folder / "other.json", **components(folder, settings=settings))
    assert (doc["detector"]["version"], doc["detector"]["weights"]) == ("toy-detector", "fp16w")
    assert doc["detector"]["decode"]["threshold"] == 0.25
    assert doc["detector"]["decode"]["nms"] == {"iou": 0.5, "classAgnostic": True, "greedy": True}
    assert doc["detector"]["decode"]["maxProposals"] == 80  # untouched defaults stay
    assert doc["recognizer"]["weights"] == "fp16w" and doc["identity"]["display"] == "representative"
    assert doc["runtime"]["executionProviders"] == ["wasm"] and doc["runtime"]["ortWeb"] == "1.29.0"
    labels = {"detector_version": "det-b", "recognizer_version": "rec-b"}
    labeled = R.compose_release(folder / "x.json", **components(folder, **labels))
    assert (labeled["detector"]["version"], labeled["recognizer"]["version"]) == ("det-b", "rec-b")


def test_settings_that_cannot_be_used_are_refused(folder):
    def build(settings):
        return R.build_release(folder / "other.json", **components(folder, settings=settings))

    with pytest.raises(R.ReleaseError, match=r"unknown key\(s\) \['bank'\]"):
        build({"bank": {"version": 9}})
    with pytest.raises(R.ReleaseError, match=r'"detector" may not set \[\'sha256\'\]'):
        build({"detector": {"sha256": "0" * 64}})
    with pytest.raises(R.ReleaseError, match='"hover" must be an object'):
        build({"hover": "accepted-nms"})
    with pytest.raises(R.ReleaseError, match="hover.selection 'nearest' is not one of"):
        build({"hover": {"selection": "nearest"}})
    with pytest.raises(R.ReleaseError, match="detector.input 640 x 384 is not the model's input size 64 x 64"):
        build({"detector": {"input": {"width": 640, "height": 384}}})
    assert not (folder / "other.json").exists()


# -------------------------------------------------------------------------------- tampering
@pytest.mark.parametrize("label", list(COMPONENTS))
def test_a_changed_byte_in_any_component_fails(folder, label):
    path = folder / COMPONENTS[label]
    body = bytearray(path.read_bytes())
    body[len(body) // 2] ^= 0x01
    path.write_bytes(bytes(body))
    assert errors_of(folder) == [f"{label}: sha256 of {COMPONENTS[label]} does not match the release"]


@pytest.mark.parametrize("label", list(COMPONENTS))
def test_a_file_of_another_size_fails(folder, label):
    path = folder / COMPONENTS[label]
    size = path.stat().st_size
    path.write_bytes(path.read_bytes() + b"\n")
    assert errors_of(folder) == [
        f"{label}: {COMPONENTS[label]} is {size + 1} bytes, the release says {size}",
        f"{label}: sha256 of {COMPONENTS[label]} does not match the release",
    ]


def test_a_document_that_states_the_wrong_size_fails(folder):
    def grow(doc):
        doc["bank"]["bytes"] += 1

    size = (folder / "bank.json").stat().st_size
    assert rewrite(folder, grow) == [f"bank: bank.json is {size} bytes, the release says {size + 1}"]


@pytest.mark.parametrize("label", list(COMPONENTS))
def test_a_missing_component_fails(folder, label):
    (folder / COMPONENTS[label]).unlink()
    assert errors_of(folder) == [f"{label}: file {COMPONENTS[label]} is missing"]


def test_an_edited_document_no_longer_matches_its_id(folder):
    doc = read_json(folder / "release.json")
    doc["accept"]["tau"] = 0.5
    (folder / "release.json").write_bytes(canonical_bytes(doc))
    assert errors_of(folder) == [f"id {doc['id']!r} is not the hash of the document (which is {R.release_id(doc)})"]


def test_a_bank_id_missing_from_the_catalog_fails(folder):
    document = toy_game.catalog_document()
    document["cards"] = [card for card in document["cards"] if card["id"] != "TOY-018"]
    (folder / "catalog.json").write_text(json.dumps(document), encoding="utf-8")

    def repin(doc):
        reseal(folder, "catalog", doc)
        doc["catalog"]["cardCount"] = 19

    assert rewrite(folder, repin) == ["1 bank id(s) are not in the catalog (e.g. ['TOY-018'])"]
    # Building a release from those files is refused for the same reason, and writes nothing.
    with pytest.raises(R.ReleaseError, match=r"1 bank id\(s\) are not in the catalog"):
        R.build_release(folder / "fresh.json", **components(folder))
    assert not (folder / "fresh.json").exists()


@pytest.mark.parametrize("rule", ["name", "printing"])
def test_a_release_holds_a_catalog_with_cards_without_art(folder, toy, tiny_model, rule):
    # Cards without art have no bank row: the bank, its groups and the release speak of the
    # bank's ids, and the catalog keeps every card.
    document = toy_game.catalog_document()
    document["identity"] = rule
    for card in document["cards"]:
        if card["id"] == "TOY-010":     # a card whose printing (TOY-P01) has art
            card["art"] = None
    document["cards"].append({"id": "TOY-NEW", "name": "Lantern Moth", "kind": "unit", "printingOf": None, "art": None})
    (folder / "catalog.json").write_text(json.dumps(document), encoding="utf-8")
    rebuild_bank(folder, toy, tiny_model)
    doc = R.build_release(folder / "fresh.json", **components(folder))
    assert R.verify_release(folder / "fresh.json") == doc
    assert (doc["catalog"]["cardCount"], doc["bank"]["cardCount"], doc["identity"]["level"]) == (21, 19, rule)
    groups = read_json(folder / COMPONENTS["identity.groups"])
    assert groups["groups"] == [["TOY-003", "TOY-003A"]] and groups["identityCount"] == 18


# ------------------------------------------------------------------- components must agree
def rebuild_bank(folder: Path, toy, tiny_model, catalog=None, **options) -> None:
    catalog = catalog or load_catalog(folder / "catalog.json")
    options.setdefault("model", "tiny")
    bank = BB.build_bank(catalog, toy[1], create_session(tiny_model), **options).bank
    BB.write_bank(bank, catalog, folder / "bank.json", overwrite=True)


def repin_bank_and_groups(folder: Path):
    def change(doc):
        reseal(folder, "bank", doc)
        reseal(folder, "identity.groups", doc)

    return change


def test_a_bank_made_by_another_recognizer_fails(folder, toy, tiny_model):
    rebuild_bank(folder, toy, tiny_model, model="another")
    assert rewrite(folder, repin_bank_and_groups(folder)) == [
        "bank: the file's model 'another' is not recognizer.version 'tiny'"]


def test_a_bank_that_records_another_threshold_fails(folder, toy, tiny_model):
    rebuild_bank(folder, toy, tiny_model, tau=0.7)
    assert rewrite(folder, repin_bank_and_groups(folder)) == ["bank: the file records tau 0.7, accept.tau is 0.62"]
    rebuild_bank(folder, toy, tiny_model, tau=0.62)
    assert rewrite(folder, repin_bank_and_groups(folder)) == []


def test_a_bank_of_fewer_cards_than_stated_fails(folder, toy, tiny_model):
    ids = [card["id"] for card in toy_game.catalog_document()["cards"]][:18]
    cards = [card for card in toy_game.catalog_document()["cards"] if card["id"] in ids]
    rebuild_bank(folder, toy, tiny_model, catalog=parse_catalog({"game": "toy", "locale": "en", "cards": cards}))
    assert rewrite(folder, repin_bank_and_groups(folder)) == [
        "bank.entryCount, the file's entryCount and the number of entries do not all agree",
        "bank.cardCount, the file's cardCount and the number of distinct card ids do not all agree",
    ]


def test_identity_groups_of_another_bank_fail(folder, toy, tiny_model):
    groups_before = (folder / COMPONENTS["identity.groups"]).read_bytes()
    rebuild_bank(folder, toy, tiny_model, version=2)
    (folder / COMPONENTS["identity.groups"]).write_bytes(groups_before)

    def change(doc):
        reseal(folder, "bank", doc)
        doc["bank"]["version"] = 2

    assert rewrite(folder, change) == [
        "identity.groups: the file was not made for this release's bank (its bank sha256 differs)"]


def test_identity_groups_that_the_catalog_does_not_give_fail(folder):
    # The catalog renames one printing, so the groups in the file no longer follow from its names.
    document = toy_game.catalog_document()
    next(card for card in document["cards"] if card["id"] == "TOY-P01")["name"] = "Plum Diamond Promo"
    (folder / "catalog.json").write_text(json.dumps(document), encoding="utf-8")
    assert rewrite(folder, lambda doc: reseal(folder, "catalog", doc)) == [
        "identity.groups: the groups are not the ones the catalog's names give for the bank's ids"]


def test_identity_groups_with_a_wrong_representative_fail(folder):
    path = folder / COMPONENTS["identity.groups"]
    groups = read_json(path)
    groups["representative"] = {"TOY-003": "TOY-003A", "TOY-P01": "TOY-010"}
    path.write_bytes(canonical_bytes(groups))
    assert rewrite(folder, lambda doc: reseal(folder, "identity.groups", doc)) == [
        "identity.groups: the representative map does not match the groups"]


def test_tensor_names_that_are_not_the_models_fail(folder):
    def change(doc):
        doc["detector"]["decode"]["inputName"] = "frames"
        doc["recognizer"]["outputName"] = "vectors"
        doc["recognizer"]["dim"] = 64

    assert rewrite(folder, change) == [
        "detector.decode.inputName 'frames' is not the model's input 'images'",
        "recognizer.outputName 'vectors' is not the model's output 'y'",
        "recognizer.dim 64 is not the model's output size 128",
        "bank: the vector size differs from recognizer.dim",
    ]


def test_models_in_each_others_place_fail(folder):
    def swap(doc):
        for key in ("path", "sha256", "bytes"):
            doc["detector"][key], doc["recognizer"][key] = doc["recognizer"][key], doc["detector"][key]

    errors = rewrite(folder, swap)
    assert "detector.decode.inputName 'images' is not the model's input 'x'" in errors
    assert "detector.input 64 x 64 is not the model's input size 128 x 128" in errors
    assert "recognizer.preprocessing gives 128 x 128 inputs, the model takes 64 x 64" in errors


def test_a_file_that_is_not_a_model_fails(folder):
    (folder / COMPONENTS["detector"]).write_bytes(b"not a model")
    errors = rewrite(folder, lambda doc: reseal(folder, "detector", doc))
    assert len(errors) == 1 and errors[0].startswith("detector: not a loadable ONNX model")
    with pytest.raises(R.ReleaseError, match="detector: not a loadable ONNX model"):
        R.build_release(folder / "fresh.json", **components(folder))


@pytest.mark.parametrize("change, message", [
    (lambda doc: doc["recognizer"]["preprocessing"].update(poolVersion=1),
     "recognizer.preprocessing {'id': 'full128', 'size': 128, 'centerMask': False, 'poolVersion': 1, "
     "'crop': 'truncate'} is not a known contract (known: ['full128'])"),
    (lambda doc: doc["detector"].update(arm="other"), "detector.arm 'other' is not one of ['yolox']"),
    (lambda doc: doc["detector"]["decode"].pop("nms"),
     "detector.decode does not have the keys of the yolox contract (missing ['nms'], unknown [])"),
    (lambda doc: doc["detector"]["decode"]["letterbox"].update(width=32),
     "detector.decode.letterbox differs from detector.input"),
    (lambda doc: doc["detector"]["decode"]["output"].update(anchors=85),
     "detector.decode.output.anchors must be 84 for a 64 x 64 input"),
    (lambda doc: doc["detector"]["decode"].update(classes=["back", "face"]),
     'detector.decode.classes must name class detector.faceClass "face"'),
    (lambda doc: doc["detector"]["decode"].update(threshold=1.5),
     "detector.decode.threshold must be a number between 0 and 1"),
    (lambda doc: doc["detector"]["decode"].update(threshold=0.005),
     "detector.decode.threshold 0.005 is below 0.01, the lowest score at which the detector export checks "
     "box parity"),
    (lambda doc: doc["detector"].update(weights="int8"), "detector.weights 'int8' is not one of ['fp32', 'fp16w']"),
    (lambda doc: doc["accept"].update(tau=0), "accept.tau must be a number above 0 and at most 1"),
    (lambda doc: doc["accept"].update(delta=1), "accept.delta must be a number from 0 to below 1"),
    (lambda doc: doc["accept"].update(rotationRetry="yes"), "accept.rotationRetry must be true or false"),
    (lambda doc: doc["hover"].update(selection="nearest"),
     "hover.selection 'nearest' is not one of ['detector-score', 'accepted-nms', 'best-score']"),
    (lambda doc: doc["hover"].update(maxAgeMs=0), "hover.maxAgeMs must be a whole number above 0"),
    (lambda doc: doc["runtime"].update(ortWeb="^1.29"), "runtime.ortWeb must be an exact version of the form 1.2.3"),
    (lambda doc: doc["runtime"].update(executionProviders=["webgpu", "cuda"]),
     "runtime.executionProviders must list one or more of ['webgpu', 'wasm'], each once"),
    (lambda doc: doc["runtime"].update(wasmThreads=4), "runtime.wasmThreads must be 1"),
    (lambda doc: doc["runtime"].update(analysisWidth={"min": 2000, "max": 1920}),
     "runtime.analysisWidth must give whole numbers min <= max above 0"),
    (lambda doc: doc["identity"].update(display="first"),
     "identity.display 'first' is not one of ['best-printing', 'representative']"),
    (lambda doc: doc["identity"].update(level="art"), 'identity.level must be "name"'),
    (lambda doc: doc.update(game="another"),
     "catalog: the file is for 'toy' ('en'), the release for 'another' ('en')"),
    (lambda doc: doc["catalog"].update(cardCount=21), "catalog.cardCount 21 is not the file's 20 cards"),
    (lambda doc: doc["bank"].update(views=8), "bank.views differs from the bank file's"),
    (lambda doc: doc.update(extra=1), "unknown key(s) ['extra']"),
    (lambda doc: doc["bank"].update(path="../bank.json"),
     "bank.path '../bank.json' must stay inside the folder of the release document"),
    (lambda doc: doc["bank"].update(path="/tmp/bank.json"),
     "bank.path '/tmp/bank.json' must stay inside the folder of the release document"),
    (lambda doc: doc["bank"].update(sha256="ABC"), "bank.sha256 must be 64 lowercase hex digits"),
    (lambda doc: doc["bank"].update(sha256="0" * 64 + "\n"), "bank.sha256 must be 64 lowercase hex digits"),
    (lambda doc: doc["runtime"].update(ortWeb="1.29.0\n"),
     "runtime.ortWeb must be an exact version of the form 1.2.3"),
])
def test_each_setting_is_checked(folder, change, message):
    assert message in rewrite(folder, change)


@pytest.mark.parametrize("block", ["detector", "recognizer", "bank", "catalog", "accept", "hover", "runtime"])
def test_a_release_without_one_of_its_parts_is_incomplete(folder, block):
    assert rewrite(folder, lambda doc: doc.pop(block)) == [
        f"incomplete release: {block} missing (a release is all-or-nothing)"]


def test_a_release_without_identity_groups_is_incomplete(folder):
    assert rewrite(folder, lambda doc: doc["identity"].pop("groups")) == [
        "incomplete release: identity.groups missing (a release is all-or-nothing)"]


def test_documents_of_another_kind_are_refused(folder):
    assert R.release_errors([1], folder) == ["the release is not a JSON object"]
    assert R.release_errors({"schemaVersion": 2, "kind": "vision-release"}, folder) == [
        'not a "vision-release" document of schema version 1']
    with pytest.raises(R.ReleaseError, match="no release document at"):
        R.verify_release(folder / "absent.json")
    (folder / "text.json").write_text("{", encoding="utf-8")
    with pytest.raises(R.ReleaseError, match="text.json: not valid JSON"):
        R.verify_release(folder / "text.json")


def test_components_must_live_with_the_release(folder, tmp_path):
    outside = tmp_path / "elsewhere.onnx"
    shutil.copy(folder / COMPONENTS["detector"], outside)
    with pytest.raises(R.ReleaseError, match="is not in or below .*the folder of the release document"):
        R.build_release(folder / "fresh.json", **components(folder, detector=outside))
    with pytest.raises(R.ReleaseError, match="bank: no file at"):
        R.build_release(folder / "fresh.json", **components(folder, bank=folder / "absent.json"))
    # A release in a subfolder cannot reach up to its components either.
    with pytest.raises(R.ReleaseError, match="is not in or below"):
        R.build_release(folder / "sub" / "release.json", **components(folder))


# ------------------------------------------------------------------------------ accept rule
def test_accept_rule_files(tmp_path):
    path = tmp_path / "accept.json"
    path.write_text(json.dumps(ACCEPT), encoding="utf-8")
    # The release tools have no reader of their own: they use the recognizer's.
    assert R.accept_errors is accept_errors and not hasattr(R, "load_accept")
    assert load_accept(path).to_json() == ACCEPT
    assert accept_errors(ACCEPT) == []
    assert accept_errors({**ACCEPT, "rotation": "retry"}) == [
        "accept has unknown key(s) ['rotation'] (expected ['tau', 'delta', 'rotationRetry'])"]
    assert accept_errors({"tau": True, "delta": "0.05"}) == [
        "accept.tau must be a number above 0 and at most 1",
        "accept.delta must be a number from 0 to below 1",
        "accept.rotationRetry must be true or false",
    ]
    assert accept_errors([0.62, 0.05]) == ["accept must be an object with the keys ['tau', 'delta', 'rotationRetry']"]
    path.write_text(json.dumps({"tau": 0.62}), encoding="utf-8")
    with pytest.raises(ValueError, match="accept.json.delta must be a number"):
        load_accept(path)
    with pytest.raises(R.ReleaseError, match="the accept rule.tau"):
        R.build_release(tmp_path / "r.json", detector="d", recognizer="r", bank="b", catalog="c", accept={})


@pytest.mark.parametrize("retry", [True, False])
def test_a_release_takes_the_rule_as_the_recognizer_reads_it(folder, retry):
    """The rule object that inference uses is accepted as it is, and both settings of the
    rotation retry are written to the document and pass its checks."""
    (folder / "accept.json").write_text(json.dumps({**ACCEPT, "rotationRetry": retry}), encoding="utf-8")
    rule = load_accept(folder / "accept.json")
    assert rule == AcceptRule(0.62, 0.05, rotation_retry=retry)
    doc = R.build_release(folder / "release.json", overwrite=True, **components(folder, accept=rule))
    assert doc["accept"] == {**ACCEPT, "rotationRetry": retry}
    assert R.verify_release(folder / "release.json")["accept"]["rotationRetry"] is retry
    assert doc == R.compose_release(folder / "release.json", **components(folder, accept=rule.to_json()))


# ----------------------------------------------------------------------------- command line
def test_build_and_verify_commands(folder, capsys):
    out = folder / "cli.json"
    arguments = ["build-release", "--detector", str(folder / COMPONENTS["detector"]),
                 "--recognizer", str(folder / COMPONENTS["recognizer"]), "--bank", str(folder / "bank.json"),
                 "--catalog", str(folder / "catalog.json"), "--accept", str(folder / "accept.json"),
                 "--out", str(out)]
    assert cli.main(arguments) == 0
    doc = read_json(out)
    assert capsys.readouterr().out.strip() == f"release {doc['id']}: {out}"
    assert doc == read_json(folder / "release.json")  # the same inputs, the same release
    assert cli.main(["verify-release", str(out)]) == 0
    assert capsys.readouterr().out.splitlines() == [
        f"release {doc['id']}: ok (toy, 20 cards in the bank, 20 in the catalog; "
        "every file present, unchanged and consistent)",
        "bank: 20 of 20 rows record their source image (artV)"]

    settings = folder / "settings.json"
    settings.write_text(json.dumps({"hover": {"selection": "detector-score"}}), encoding="utf-8")
    labeled = folder / "labeled.json"
    assert cli.main([*arguments[:-1], str(labeled), "--settings", str(settings), "--detector-version", "d7",
                     "--identity-groups", str(folder / COMPONENTS["identity.groups"])]) == 0
    assert read_json(labeled)["hover"]["selection"] == "detector-score"
    assert read_json(labeled)["detector"]["version"] == "d7"
    capsys.readouterr()
    assert cli.main([*arguments, "--recognizer-version", "another"]) == 1
    assert "bank: the file's model 'tiny' is not recognizer.version 'another'" in capsys.readouterr().err


def test_a_bank_that_records_no_source_image_builds_and_verifies_as_before(folder, capsys):
    """A bank written before rows recorded their image (``artV``) is as valid a component as any."""
    catalog = load_catalog(folder / "catalog.json")
    recorded = read_json(folder / "bank.json")
    assert all("artV" in entry for entry in recorded["entries"])
    original = read_json(folder / "release.json")
    assert R.bank_image_records(original, folder) == (20, 20)

    def write_bank_without(ids) -> dict:
        bank = copy.deepcopy(recorded)
        for entry in bank["entries"]:
            if entry["cardId"] in ids:
                del entry["artV"]
        BB.write_bank(bank, catalog, folder / "bank.json", overwrite=True)
        return R.build_release(folder / "release.json", overwrite=True, **components(folder))

    earlier = write_bank_without(catalog.ids())
    assert R.verify_release(folder / "release.json") == earlier and errors_of(folder) == []
    assert R.bank_image_records(earlier, folder) == (0, 20)
    assert cli.main(["verify-release", str(folder / "release.json")]) == 0
    assert capsys.readouterr().out.splitlines() == [
        f"release {earlier['id']}: ok (toy, 20 cards in the bank, 20 in the catalog; "
        "every file present, unchanged and consistent)",
        "bank: 0 of 20 rows record their source image (artV)"]
    # Only the hashes that follow from the bank file's bytes differ from the release of the recorded bank.
    assert {key for key in original if original[key] != earlier[key]} == {"id", "bank", "identity"}
    assert {key for key in original["bank"] if original["bank"][key] != earlier["bank"][key]} == {"sha256", "bytes"}

    mixed = write_bank_without(["TOY-001", "TOY-002", "TOY-003"])
    assert R.bank_image_records(mixed, folder) == (17, 20)
    assert cli.main(["verify-release", str(folder / "release.json")]) == 0
    assert capsys.readouterr().out.splitlines()[1] == "bank: 17 of 20 rows record their source image (artV)"


def test_verify_command_lists_every_failure(folder, capsys):
    (folder / "bank.json").write_bytes((folder / "bank.json").read_bytes()[:-10])
    (folder / COMPONENTS["detector"]).unlink()
    assert cli.main(["verify-release", str(folder / "release.json")]) == 1
    printed = capsys.readouterr()
    assert printed.out == "" and "cardvision verify-release: failed" in printed.err
    assert "detector: file models/detector.onnx is missing" in printed.err
    assert "bank: sha256 of bank.json does not match the release" in printed.err
    assert cli.main(["verify-release", str(folder / "absent.json")]) == 1
    assert "no release document at" in capsys.readouterr().err


def test_a_release_document_can_be_rebuilt_from_its_own_blocks(built):
    """What a reader needs is all in the document: nothing refers to anything outside its folder."""
    text = (built / "release.json").read_text(encoding="utf-8")
    assert "://" not in text and str(built) not in text
    doc = copy.deepcopy(read_json(built / "release.json"))
    assert R.with_id(doc) == doc
