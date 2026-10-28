# SPDX-License-Identifier: Apache-2.0
"""``cardvision refresh check``: the preconditions of a refresh, on toy releases.

The base is the toy game without three cards (two sites and an alternate printing); the
candidate appends them, as a refresh would. Every precondition is then broken once.
"""

from __future__ import annotations

import copy
import hashlib
import argparse
import json
import shutil
from pathlib import Path

import pytest

import toy_game
from cardvision.bank import build as BB
from cardvision.bank import release as R
from cardvision.core.catalog import load_catalog
from cardvision.core.onnx import create_session
from cardvision.refresh import commands
from cardvision.refresh.check import check_release, near_duplicates
from test_release_document import ACCEPT, write_tiny_detector

NEW = ("TOY-003A", "TOY-017", "TOY-018")


def toy_catalog(without=NEW) -> dict:
    doc = toy_game.catalog_document()
    doc["cards"] = [c for c in doc["cards"] if c["id"] not in without]
    return doc


def make_release(root: Path, catalog: dict, bank: dict, models: Path) -> Path:
    """Write a release folder from a catalog document and a bank document."""
    root.mkdir(parents=True)
    shutil.copytree(models, root / "models")
    (root / "catalog.json").write_text(json.dumps(catalog), encoding="utf-8")
    BB.write_bank(bank, load_catalog(root / "catalog.json"), root / "bank.json")
    R.build_release(root / "release.json", detector=root / "models/detector.onnx",
                    recognizer=root / "models/recognizer.onnx", bank=root / "bank.json",
                    catalog=root / "catalog.json", accept=dict(ACCEPT))
    return root / "release.json"


@pytest.fixture(scope="module")
def made(toy, tiny_model, tmp_path_factory):
    """``(workspace, models folder, base bank, candidate bank, base release, candidate release)``."""
    work = tmp_path_factory.mktemp("refresh-check")
    models = work / "models"
    write_tiny_detector(models / "detector.onnx")
    shutil.copy(tiny_model, models / "recognizer.onnx")
    session = create_session(tiny_model)
    (work / "base-catalog.json").write_text(json.dumps(toy_catalog()), encoding="utf-8")
    base_bank = BB.build_bank(load_catalog(work / "base-catalog.json"), toy[1], session, model="tiny").bank
    cand_bank = BB.build_bank(load_catalog(toy[0]), toy[1], session, base=base_bank).bank
    base = make_release(work / "base", toy_catalog(), base_bank, models)
    cand = make_release(work / "cand", toy_catalog(without=()), cand_bank, models)
    return work, models, base_bank, cand_bank, base, cand


def candidate(made, tmp_path, catalog=None, bank=None) -> Path:
    """Another candidate release, from a changed catalog and/or bank."""
    _work, models, _base_bank, cand_bank, _base, _cand = made
    return make_release(tmp_path / "other", catalog or toy_catalog(without=()), bank or cand_bank, models)


def failed(verdict) -> list[str]:
    return sorted(name for name, c in verdict["checks"].items() if c["ok"] is False)


def live_settings(folder: Path, release: Path) -> Path:
    """A live settings file naming ``release``."""
    live = folder / "live-config.json"
    live.write_text(json.dumps({"release": {"id": json.loads(release.read_text())["id"]}}), encoding="utf-8")
    return live


def test_a_candidate_that_only_appends_cards_passes_and_is_bank_only(made, tmp_path):
    *_, base, cand = made
    verdict = check_release(cand, base, live_config=live_settings(tmp_path, base))
    assert failed(verdict) == [] and verdict["ok"] and verdict["bankOnly"] and verdict["p0Checked"]
    assert verdict["newCards"] == {"withArt": 3, "withoutArt": 0}
    assert verdict["catalogEdits"] == {"count": 0, "ids": {}} and verdict["nearDuplicates"] == []
    assert verdict["checks"]["P0 base is the live release"]["ok"]
    assert verdict["checks"]["P2 check-refresh: additive, 0 re-embedded"]["ok"]
    assert verdict["checks"]["P4 verify-release candidate"]["ok"] and verdict["checks"]["P4 verify-release base"]["ok"]


def test_without_the_live_settings_p0_is_listed_as_not_checked_and_nothing_is_bank_only(made):
    *_, base, cand = made
    verdict = check_release(cand, base)
    assert verdict["ok"] and not verdict["bankOnly"] and not verdict["p0Checked"]
    assert verdict["liveConfigRelease"] is None and "P0 base is the live release" not in verdict["checks"]
    assert verdict["checks"]["P0 live configuration (not checked)"]["ok"] is None
    with pytest.raises(ValueError):
        check_release(cand, base, bundled_id="0" * 16)


def test_the_near_duplicate_report_lists_close_rows_and_takes_the_release_out_of_bank_only(made, tmp_path):
    *_, base, cand = made
    verdict = check_release(cand, base, near=0.5, live_config=live_settings(tmp_path, base))
    assert verdict["ok"] and not verdict["bankOnly"]
    listed = {x["cardId"] for x in verdict["nearDuplicates"]}
    assert {"TOY-017", "TOY-018"} <= listed
    # the alternate printing is compared with other identities only, never with its own card
    assert all(not (x["cardId"] == "TOY-003A" and x["nearest"] == "TOY-003") for x in verdict["nearDuplicates"])


def test_near_duplicates_skip_the_same_identity():
    from cardvision.core import bank as B
    import numpy as np

    rows = np.eye(3, 8, dtype=np.float32)
    base = B.encode_bank(["A", "B", "C"], rows)["entries"]
    added = B.encode_bank(["A2"], rows[:1])["entries"]
    assert near_duplicates(base, added, {"A2": "A"})[0]["nearest"] != "A"
    assert near_duplicates(base, added, {}) == [{"cardId": "A2", "nearest": "A", "cosine": 1.0}]
    assert near_duplicates(base, [], {}) == []


def test_p0_the_base_must_be_the_release_the_live_settings_name(made, tmp_path):
    *_, base, cand = made
    base_id = json.loads(base.read_text())["id"]
    live = tmp_path / "config.json"
    live.write_text(json.dumps({"release": {"id": base_id, "path": "x"}}), encoding="utf-8")
    assert check_release(cand, base, live_config=live)["checks"]["P0 base is the live release"]["ok"]
    live.write_text(json.dumps({"release": {"id": "0" * 16}}), encoding="utf-8")
    verdict = check_release(cand, base, live_config=live)
    assert failed(verdict) == ["P0 base is the live release"] and verdict["liveConfigRelease"] == "0" * 16
    # no release in the settings: the base must be the bundled one
    live.write_text(json.dumps({"other": 1}), encoding="utf-8")
    assert check_release(cand, base, live_config=live, bundled_id=base_id)["ok"]
    assert failed(check_release(cand, base, live_config=live, bundled_id="f" * 16)) == ["P0 base is the live release"]
    assert failed(check_release(cand, base, live_config=live)) == ["P0 base is the live release"]


def test_p1_another_accept_rule_fails(made, tmp_path):
    work, models, _bb, cand_bank, base, _cand = made
    root = tmp_path / "other"
    root.mkdir()
    shutil.copytree(models, root / "models")
    (root / "catalog.json").write_text(json.dumps(toy_catalog(without=())), encoding="utf-8")
    BB.write_bank(cand_bank, load_catalog(root / "catalog.json"), root / "bank.json")
    R.build_release(root / "release.json", detector=root / "models/detector.onnx", recognizer=root / "models/recognizer.onnx",
                    bank=root / "bank.json", catalog=root / "catalog.json", accept={**ACCEPT, "tau": 0.7})
    assert failed(check_release(root / "release.json", base)) == ["P1 accept"]


def with_copied_row(made, folder: Path, card: dict) -> Path:
    """A candidate whose one extra card ``card`` carries TOY-001's vector."""
    _work, models, _bb, cand_bank, _base, _cand = made
    bank = copy.deepcopy(cand_bank)
    first = next(e for e in bank["entries"] if e["cardId"] == "TOY-001")
    bank["entries"].append({"cardId": card["id"], "vec": first["vec"]})
    bank["cardCount"] += 1
    bank["entryCount"] += 1
    catalog = toy_catalog(without=())
    catalog["cards"].append(card)
    return make_release(folder, catalog, bank, models)


DUPLICATE = "P2 no appended row duplicates another row's vector"


def test_p2_a_repeated_vector_under_each_duplicate_vectors_mode(made, tmp_path):
    *_, base, _cand = made
    # another identity: a made-up card with TOY-001's picture
    cross = with_copied_row(made, tmp_path / "cross", {"id": "TOY-900", "name": "Fake Card", "kind": "unit",
                                                       "printingOf": None, "art": "TOY-001.png"})
    # the same identity: a reprint of TOY-001 under a new id, with the very same picture
    same = with_copied_row(made, tmp_path / "same", {"id": "TOY-001R", "name": "Amber Circle", "kind": "unit",
                                                     "printingOf": "TOY-001", "art": "TOY-001.png"})
    expected = {("cross", "refuse"): False, ("cross", "same-identity"): False, ("cross", "report"): True,
                ("same", "refuse"): False, ("same", "same-identity"): True, ("same", "report"): True}
    for (name, mode), passes in expected.items():
        verdict = check_release(cross if name == "cross" else same, base, duplicate_vectors=mode)
        assert verdict["checks"][DUPLICATE]["ok"] is passes, (name, mode)
        assert failed(verdict) == ([] if passes else [DUPLICATE]), (name, mode)
        new_id = "TOY-900" if name == "cross" else "TOY-001R"
        assert verdict["duplicateVectors"] == {"mode": mode, "pairs": [
            {"ids": ["TOY-001", new_id], "sameIdentity": name == "same"}]}, (name, mode)
        if name == "cross":  # another identity at cosine 1 is also a near duplicate
            assert verdict["nearDuplicates"][0]["cardId"] == "TOY-900" and verdict["nearDuplicates"][0]["cosine"] == 1.0
        else:
            assert verdict["nearDuplicates"] == []
    with pytest.raises(ValueError):
        check_release(same, base, duplicate_vectors="allow")


def test_without_a_repeated_vector_every_mode_records_no_pairs(made):
    *_, base, cand = made
    verdict = check_release(cand, base)
    assert verdict["duplicateVectors"] == {"mode": "refuse", "pairs": []} and verdict["checks"][DUPLICATE]["ok"]


def test_p2_a_bank_that_rewrites_a_base_row_fails(made, tmp_path):
    _work, _models, _bb, cand_bank, base, _cand = made
    bank = copy.deepcopy(cand_bank)
    bank["entries"][0], bank["entries"][1] = bank["entries"][1], bank["entries"][0]
    bad = failed(check_release(candidate(made, tmp_path, bank=bank), base))
    assert "P2 base rows kept, in order" in bad and "P2 check-refresh: additive, 0 re-embedded" in bad


def test_p3_a_dropped_base_entry_fails(made, tmp_path):
    _work, _models, _bb, cand_bank, base, _cand = made
    catalog = toy_catalog(without=())
    catalog["cards"] = [c for c in catalog["cards"] if c["id"] != "TOY-002"]
    bank = copy.deepcopy(cand_bank)
    bank["entries"] = [e for e in bank["entries"] if e["cardId"] != "TOY-002"]
    bank["cardCount"] -= 1
    bank["entryCount"] -= 1
    assert "P3 no base entry dropped" in failed(check_release(candidate(made, tmp_path, catalog, bank), base))


def test_p3_a_renamed_base_entry_needs_editable_and_is_listed(made, tmp_path):
    *_, base, _cand = made
    catalog = toy_catalog(without=())
    for card in catalog["cards"]:
        if card["id"] == "TOY-005":
            card["name"] = "Plum Bars"
    renamed = candidate(made, tmp_path, catalog)
    assert failed(check_release(renamed, base)) == ["P3 base entries kept unchanged"]
    verdict = check_release(renamed, base, editable=["name", "facets"], live_config=live_settings(tmp_path, base))
    assert verdict["ok"] and not verdict["bankOnly"]
    assert verdict["catalogEdits"] == {"count": 1, "ids": {"TOY-005": ["name"]}}
    assert "P3 base entries change name/facets only" in verdict["checks"]
    # another field is never editable
    for card in catalog["cards"]:
        if card["id"] == "TOY-005":
            card["kind"] = "spell"
    shutil.rmtree(tmp_path / "other")
    assert failed(check_release(candidate(made, tmp_path, catalog), base, editable=["name"])) == [
        "P3 base entries change name only"]


def test_p4_a_candidate_whose_file_changed_after_sealing_fails(made, tmp_path):
    *_, base, cand = made
    copied = Path(shutil.copytree(cand.parent, tmp_path / "copied"))
    catalog = copied / "catalog.json"
    catalog.write_text(catalog.read_text() + " ", encoding="utf-8")
    assert "P4 verify-release candidate" in failed(check_release(copied / "release.json", base))


# ------------------------------------------------------------ a bank in binary form (bank.bin)
def converted(release: Path, out: Path) -> Path:
    """The release converted as ``cardvision convert-release`` does: the bank as ``bank.bin``."""
    from cardvision.bank.convert import convert_release

    convert_release(release, out)
    assert json.loads((out / "release.json").read_text())["bank"]["path"] == "bank.bin"
    return out / "release.json"


def outcome(verdict) -> tuple:
    """A verdict without what names files: the checks and their results, and every report."""
    return ({name: c["ok"] for name, c in verdict["checks"].items()}, verdict["ok"], verdict["bankOnly"],
            verdict["newCards"], verdict["catalogEdits"], verdict["nearDuplicates"], verdict["duplicateVectors"])


def test_a_release_with_its_bank_in_binary_form_checks_as_its_json_twin(made, tmp_path):
    *_, base, cand = made
    cross = with_copied_row(made, tmp_path / "cross", {"id": "TOY-900", "name": "Fake Card", "kind": "unit",
                                                       "printingOf": None, "art": "TOY-001.png"})
    bin_base = converted(base, tmp_path / "bin-base")
    for name, json_cand in (("cand", cand), ("cross", cross)):
        bin_cand = converted(json_cand, tmp_path / f"bin-{name}")
        twin = check_release(json_cand, base, near=0.5)
        assert twin["checks"]["P2 base rows kept, in order"]["ok"]
        for c, b in ((bin_cand, bin_base), (bin_cand, base), (json_cand, bin_base)):
            assert outcome(check_release(c, b, near=0.5)) == outcome(twin), (name, c, b)
        assert failed(twin) == ([] if name == "cand" else [DUPLICATE])


# --------------------------------------------------------------------- the geometric stage
def write_geometric(folder: Path, bank_sha: str, settings: dict, packed: bool = True) -> Path:
    folder.mkdir(parents=True)
    index = folder / "cards.features.json"
    index.write_text(json.dumps({"kind": "features", "bank": {"sha256": bank_sha}}), encoding="utf-8")
    sha = hashlib.sha256(index.read_bytes()).hexdigest()
    (folder / "geometric.json").write_text(json.dumps({**settings, "index": {"path": index.name, "sha256": sha}}),
                                           encoding="utf-8")
    if packed:
        (folder / "packed").mkdir()
        (folder / "packed" / "manifest.json").write_text(
            json.dumps({"source": {"sha256": sha}, "bank": {"sha256": bank_sha}}), encoding="utf-8")
    return folder / "geometric.json"


def test_p4_geometric_settings_index_and_packed_manifest(made, tmp_path):
    *_, base, cand = made
    base_sha = json.loads(base.read_text())["bank"]["sha256"]
    cand_sha = json.loads(cand.read_text())["bank"]["sha256"]
    settings = {"features": {"kind": "orb"}, "minInliers": 12}
    base_geo = write_geometric(tmp_path / "base-geo", base_sha, settings)
    good = write_geometric(tmp_path / "good", cand_sha, settings)
    verdict = check_release(cand, base, geometric=good, base_geometric=base_geo)
    assert verdict["ok"] and {"P4 same geometric settings", "P4 index pinned", "P4 index bound to the candidate bank",
                              "P4 packed manifest repacks the index"} <= set(verdict["checks"])
    other = write_geometric(tmp_path / "other", cand_sha, {**settings, "minInliers": 10})
    assert failed(check_release(cand, base, geometric=other, base_geometric=base_geo)) == ["P4 same geometric settings"]
    unbound = write_geometric(tmp_path / "unbound", base_sha, settings)
    assert failed(check_release(cand, base, geometric=unbound, base_geometric=base_geo)) == [
        "P4 index bound to the candidate bank", "P4 packed manifest repacks the index"]
    unpacked = write_geometric(tmp_path / "unpacked", cand_sha, settings, packed=False)
    assert failed(check_release(cand, base, geometric=unpacked, base_geometric=base_geo)) == ["P4 packed manifest present"]
    (tmp_path / "good" / "cards.features.json").write_text("{}", encoding="utf-8")
    assert "P4 index pinned" in failed(check_release(cand, base, geometric=good, base_geometric=base_geo))
    with pytest.raises(ValueError):
        check_release(cand, base, geometric=good)


# ------------------------------------------------------------------------- the command line
def refresh(argv: list[str]) -> int:
    """``cardvision refresh ARGV``, through the subcommand's own parser."""
    parser = argparse.ArgumentParser(prog="cardvision refresh")
    commands.add_arguments(parser)
    return commands.run(parser.parse_args(argv))


def test_the_command_prints_and_writes_one_verdict(made, tmp_path, capsys):
    *_, base, cand = made
    out = tmp_path / "check.json"
    live = live_settings(tmp_path, base)
    assert refresh(["check", str(cand), "--base", str(base), "--live-config", str(live), "--json", str(out)]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed == json.loads(out.read_text()) and printed["bankOnly"]
    assert refresh(["check", str(cand), "--base", str(base), "--bundled-id", "0" * 16]) == 2
    capsys.readouterr()
    assert refresh(["check", str(cand), "--base", str(base), "--duplicate-vectors", "report"]) == 0
    assert json.loads(capsys.readouterr().out)["duplicateVectors"]["mode"] == "report"
    live = tmp_path / "config.json"
    live.write_text(json.dumps({"release": {"id": "0" * 16}}), encoding="utf-8")
    assert refresh(["check", str(cand), "--base", str(base), "--live-config", str(live)]) == 1
    capsys.readouterr()
    assert refresh(["check", str(cand)]) == 2
    assert refresh(["check", str(cand), "--base", str(base), "--rule", "x"]) == 2
    assert refresh(["check", str(cand), "--base", str(base), "--geometric", "g.json"]) == 2
