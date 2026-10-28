# SPDX-License-Identifier: Apache-2.0
"""``cardvision refresh diff`` and ``subset``: two evaluate hover runs compared event by event,
and the catalog of the new cards. The runs are synthetic ``evaluate hover --out`` folders on the
toy game's card ids; ``write_run`` is shared with the verdict tests."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import pytest

import toy_game
from cardvision.refresh import commands
from cardvision.refresh.diff import diff_runs, reduced
from cardvision.refresh.subset import SubsetError, subset_catalog


def event(key: str, role: str = "face", outcome: str = "right", truth: str | None = "TOY-001",
          shown: str | None = "TOY-001", source: str = "digital/client") -> dict:
    """One line of ``evaluate-hover-events.jsonl``."""
    if outcome == "nothing":
        shown = None
    return {"key": key, "source_type": source, "role": role, "truth_id": truth if role == "face" else None,
            "outcome": outcome, "shown_id": shown}


def _part(events: list[dict]) -> dict:
    count = Counter((e["role"], e["outcome"]) for e in events)
    counts = {"faceRight": count[("face", "right")], "faceWrong": count[("face", "wrong")],
              "faceNothing": count[("face", "nothing")], "backShown": count[("back", "wrong")],
              "backNothing": count[("back", "nothing")], "offCardShownNonAdjacent": count[("off-card", "wrong")],
              "offCardShownAdjacent": count[("off-card", "adjacent")], "offCardNothing": count[("off-card", "nothing")]}
    faces = counts["faceRight"] + counts["faceWrong"] + counts["faceNothing"]
    wrong = counts["faceWrong"] + counts["backShown"] + counts["offCardShownNonAdjacent"]
    return {"events": len(events), "counts": counts,
            "namedRight": {"value": counts["faceRight"] / faces if faces else None},
            "wrongOfShown": {"value": wrong / (counts["faceRight"] + wrong) if counts["faceRight"] + wrong else None}}


def write_run(folder: Path, events: list[dict], release: str = "aaaaaaaaaaaaaaaa") -> Path:
    """A synthetic ``evaluate hover --out`` folder: the events file and the result's overall
    and per-source-type counts, as the real command writes them."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "evaluate-hover-events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
    by_source = {}
    for name in sorted({e["source_type"] for e in events}):
        by_source[name] = _part([e for e in events if e["source_type"] == name])
    result = {"configuration": {"release": release}, "results": {"overall": _part(events), "bySourceType": by_source}}
    (folder / "evaluate-hover.json").write_text(json.dumps(result), encoding="utf-8")
    return folder


def refresh(argv: list[str]) -> int:
    """``cardvision refresh ARGV``, through the subcommand's own parser."""
    parser = argparse.ArgumentParser(prog="cardvision refresh")
    commands.add_arguments(parser)
    return commands.run(parser.parse_args(argv))


# ----------------------------------------------------------------------------------- diff
def test_reduced_outcomes():
    assert [reduced(event("k", "face", o)) for o in ("right", "wrong", "nothing")] == ["right", "wrong", "nothing"]
    assert reduced(event("k", "back", "wrong")) == "shown" and reduced(event("k", "back", "nothing")) == "nothing"
    assert reduced(event("k", "off-card", "adjacent")) == "nothing" and reduced(event("k", "off-card", "wrong")) == "shown"
    assert reduced(event("k", "face-unreadable", "shown")) is None and reduced(event("k", "face-unnamed", "nothing")) is None


def test_every_transition_is_counted_where_the_rule_says(tmp_path):
    base = [event("r2w"), event("r2n"), event("n2w", outcome="nothing"), event("w2w", outcome="wrong", shown="TOY-002"),
            event("w2r", outcome="wrong", shown="TOY-002"), event("n2r", outcome="nothing"),
            event("w2n", outcome="wrong", shown="TOY-002"), event("same"),
            event("back", "back", "nothing"), event("off", "off-card", "wrong", shown="TOY-003"),
            event("adj", "off-card", "nothing"), event("unread", "face-unreadable", "nothing")]
    cand = [event("r2w", outcome="wrong", shown="TOY-004"), event("r2n", outcome="nothing"),
            event("n2w", outcome="wrong", shown="TOY-004"), event("w2w", outcome="wrong", shown="TOY-005"),
            event("w2r"), event("n2r"), event("w2n", outcome="nothing"), event("same"),
            event("back", "back", "wrong", shown="TOY-006"), event("off", "off-card", "nothing"),
            event("adj", "off-card", "adjacent", shown="TOY-007"), event("unread", "face-unreadable", "shown", shown="TOY-008")]
    out = diff_runs(write_run(tmp_path / "base", base, "b" * 16), write_run(tmp_path / "cand", cand, "c" * 16))
    assert out["base"]["release"] == "b" * 16 and out["candidate"]["release"] == "c" * 16
    assert (out["compared"], out["onlyBase"], out["onlyCandidate"], out["excluded"]) == (12, 0, 0, 0)
    assert out["regressionsByType"] == {"right_to_wrong": 1, "right_to_nothing": 1, "nothing_to_wrong": 1,
                                        "new_wrong_nonface": 1, "different_wrong": 1}
    assert out["regressionCount"] == 4
    assert out["improvements"] == {"wrong_to_right": 1, "nothing_to_right": 1, "wrong_to_nothing": 1,
                                   "nonface_wrong_to_nothing": 1}
    assert out["regressions"]["right_to_wrong"] == [{"key": "r2w", "truth": "TOY-001", "base": "TOY-001", "cand": "TOY-004"}]
    assert out["transitions"]["nonface nothing -> nothing"] == 1  # an adjacent name counts as nothing
    assert sum(out["transitions"].values()) == 11  # the unreadable face is outside every count
    assert out["rates"]["base"] == {"faces": 8, "right": 3, "wrong": 3, "nothing": 2, "nonfaceShown": 1,
                                    "namedRight": 0.375, "wrongOfShown": round(4 / 7, 6)}


def test_events_in_one_run_only_and_both_exclusion_shapes(tmp_path):
    base = [event("a", truth="TOY-017"), event("b", truth="TOY-018"), event("c", truth="TOY-001"), event("gone")]
    cand = [event("a", outcome="nothing", truth="TOY-017"), event("b", truth="TOY-018"), event("c", truth="TOY-001"),
            event("new")]
    b, c = write_run(tmp_path / "base", base), write_run(tmp_path / "cand", cand)
    out = diff_runs(b, c)
    assert (out["onlyBase"], out["onlyCandidate"], out["compared"], out["regressionCount"]) == (1, 1, 3, 1)
    by_prefix = diff_runs(b, c, exclude_prefixes=["TOY-01"])
    assert (by_prefix["excluded"], by_prefix["compared"], by_prefix["regressionCount"]) == (2, 1, 0)
    by_ids = diff_runs(b, c, exclude_ids=["TOY-017"])
    assert (by_ids["excluded"], by_ids["compared"], by_ids["regressionCount"]) == (1, 2, 0)


def test_the_command_prints_a_summary_and_writes_the_whole_comparison(tmp_path, capsys):
    b = write_run(tmp_path / "base", [event("a", truth="TOY-017"), event("b")])
    c = write_run(tmp_path / "cand", [event("a", outcome="nothing", truth="TOY-017"), event("b")])
    ids = tmp_path / "ids.json"
    ids.write_text(json.dumps(["TOY-017"]), encoding="utf-8")
    out = tmp_path / "diff.json"
    assert refresh(["diff", str(b), str(c), "--json", str(out)]) == 0
    printed = json.loads(capsys.readouterr().out)
    written = json.loads(out.read_text())
    assert out.read_text().endswith("}\n") and written == diff_runs(b, c)
    assert printed["regressionCount"] == 1 and "regressions" not in printed and "rates" in printed
    assert refresh(["diff", str(b), str(c), "--exclude-truth-ids", str(ids)]) == 0
    assert json.loads(capsys.readouterr().out)["excluded"] == 1
    assert refresh(["diff", str(b), str(c), "--exclude-truth-prefix", "TOY-0", "--exclude-truth-prefix", "X"]) == 0
    assert json.loads(capsys.readouterr().out)["excluded"] == 2
    assert refresh(["diff", str(b)]) == 2
    assert refresh(["diff", str(b), str(c), "--new-vs", "x"]) == 2


# --------------------------------------------------------------------------------- subset
def test_subset_keeps_the_new_cards_with_art_and_their_roots_without_art(tmp_path):
    full, base = toy_game.catalog_document(), toy_game.catalog_document()
    base["cards"] = [c for c in base["cards"] if c["id"] not in ("TOY-003A", "TOY-017", "TOY-018")]
    full["cards"] = [dict(c, art=None) if c["id"] == "TOY-018" else c for c in full["cards"]]
    (tmp_path / "full.json").write_text(json.dumps(full), encoding="utf-8")
    (tmp_path / "base.json").write_text(json.dumps(base), encoding="utf-8")
    assert subset_catalog(tmp_path / "full.json", tmp_path / "new.json", new_vs=tmp_path / "base.json") == (2, 1)
    doc = json.loads((tmp_path / "new.json").read_text())
    assert [c["id"] for c in doc["cards"]] == ["TOY-017", "TOY-003A", "TOY-003"]
    assert doc["cards"][-1]["art"] is None and doc["kinds"] == full["kinds"]
    assert subset_catalog(tmp_path / "full.json", tmp_path / "ids.json", ids=["TOY-001", "TOY-P01"]) == (2, 1)
    with pytest.raises(SubsetError):
        subset_catalog(tmp_path / "full.json", tmp_path / "x.json", ids=["TOY-999"])
    with pytest.raises(ValueError):
        subset_catalog(tmp_path / "full.json", tmp_path / "x.json")


def test_the_subset_command(tmp_path, capsys):
    (tmp_path / "full.json").write_text(json.dumps(toy_game.catalog_document()), encoding="utf-8")
    (tmp_path / "ids.json").write_text(json.dumps(["TOY-002"]), encoding="utf-8")
    assert refresh(["subset", str(tmp_path / "full.json"), str(tmp_path / "out.json"), "--ids", str(tmp_path / "ids.json")]) == 0
    assert "1 cards with art, 0 roots without art" in capsys.readouterr().out
    (tmp_path / "ids.json").write_text(json.dumps(["NOPE"]), encoding="utf-8")
    assert refresh(["subset", str(tmp_path / "full.json"), str(tmp_path / "out.json"), "--ids", str(tmp_path / "ids.json")]) == 1
    assert refresh(["subset", str(tmp_path / "full.json"), str(tmp_path / "out.json")]) == 2
