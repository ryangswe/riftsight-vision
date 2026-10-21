# SPDX-License-Identifier: Apache-2.0
"""``cardvision calibrate``: the grid, the pick, the files, and above all that a pair's figures
are the ones ``cardvision evaluate hover`` prints with that pair as its accept rule.

The frames are a toy calibration set staged so that the thresholds matter
(``support_calibration``). Among its places are cards lying sideways and upside down whose
upright look scores well against another card: there the name shown depends on whether the
turned looks are tried, which the thresholds decide.
"""

from __future__ import annotations

import csv
import dataclasses
import io
import json
import shutil
from pathlib import Path

import numpy as np
import pytest

import support_calibration as support
import cardvision
from cardvision import cli
from cardvision.bank import build as bank_build
from cardvision.bank import release as release_module
from cardvision.calibrate import grid, report
from cardvision.core.catalog import load_catalog
from cardvision.core.images import load_rgb
from cardvision.core.onnx import create_session
from cardvision.data.extract import FrameStore, frame_file_name
from cardvision.data.manifest import write_manifest
from cardvision.detect import INPUT_HEIGHT, INPUT_WIDTH
from cardvision.evaluate import analyze_hover, hover_results, open_configuration, read_rows, run_hover, spec_from_paths
from cardvision.evaluate.events import rates
from cardvision.infer.pipeline import card_json
from cardvision.recognize import AcceptRule, Recognizer, load_accept
from cardvision.recognize import recognizer as recognizer_module
from test_infer_toy_models import build_detector, detector_rows

# Values of tau and delta on either side of the published rule's 0.62 and 0.05, and on either
# side of every score and margin the toy set turns on. Their thirty pairs are all scored.
TAUS = (0.5, 0.62, 0.7, 0.8, 0.86, 0.9)
DELTAS = (0.0, 0.02, 0.045, 0.06, 0.09)
BOOTSTRAP = ("--bootstrap", "200", "--seed", "4")
# Two more boxes for the detector: one shifted over the first place, which the hover rule's
# suppression has to settle against the place's own box, and a small one inside the third
# place, which lies on top of it.
OVERLAPS = [(60, 60, 240, 336), (660, 124, 120, 168)]


@pytest.fixture(scope="module")
def setup(tmp_path_factory, toy) -> support.Calibration:
    return support.Calibration(tmp_path_factory.mktemp("calibrate"), *toy)


@pytest.fixture(scope="module")
def stacked(tmp_path_factory, toy) -> support.Calibration:
    return support.Calibration(tmp_path_factory.mktemp("calibrate-stacked"), *toy, extra_boxes=OVERLAPS)


def run(capsys, *arguments: str) -> tuple[int, str, str]:
    code = cli.main(list(arguments))
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def accept_file(folder: Path, tau: float, delta: float, retry: bool = True) -> Path:
    path = folder / f"accept-{tau}-{delta}.json"
    path.write_text(json.dumps({"tau": tau, "delta": delta, "rotationRetry": retry}), encoding="utf-8")
    return path


def without_exact_bounds(overall: dict) -> dict:
    """An evaluation's overall figures as the grid holds them: all of them but each rate's
    exact bound."""
    return {key: {name: value for name, value in found.items() if name != "exact95"}
            if key in ("namedRight", "wrongOfShown") else found for key, found in overall.items()}


def lists(values) -> str:
    return ",".join(str(value) for value in values)


def open_set(setup: support.Calibration, accept: Path | None = None):
    return open_configuration(spec_from_paths(setup.detector, setup.recognizer, setup.bank, setup.catalog,
                                              accept or setup.accept))


def test_the_subcommand_is_registered(capsys):
    assert "calibrate" in cli.SUBCOMMANDS
    assert cli.main([]) == 0
    assert "calibrate" in capsys.readouterr().out


# ---------------------------------------------------------------- the same figures as evaluate
@pytest.mark.parametrize("which, retry", [("setup", True), ("stacked", True), ("setup", False)])
def test_every_pair_has_the_figures_evaluate_hover_gives_with_that_accept_rule(which, retry, request, capsys, tmp_path):
    """The core requirement. One calibration run, then one ``evaluate hover`` run per pair with
    that pair written as its accept file: the counts, both rates and both intervals are equal,
    and so is every event."""
    setup = request.getfixturevalue(which)
    start = accept_file(tmp_path, 0.62, 0.05, retry)
    out = tmp_path / "calibrate"
    code, _, err = run(capsys, "calibrate", *setup.arguments("--tau", lists(TAUS), "--delta", lists(DELTAS), "--out",
                                                             str(out), *BOOTSTRAP, accept=start))
    assert code == 0, err
    result = json.loads((out / "calibrate.json").read_text())
    # The thirty pairs, and the pair the run started from.
    assert len(result["points"]) == len(TAUS) * len(DELTAS) + 1 == result["grid"]["pairs"]
    assert result["grid"]["rotationRetry"] is retry and result["configuration"]["accept"]["rotationRetry"] is retry

    rows, account = read_rows([setup.manifest], "train")
    analysis = analyze_hover(rows, setup.frames, open_set(setup, start), account)
    table = list(csv.DictReader(io.StringIO((out / "calibrate-grid.csv").read_text())))
    distinct = set()
    for point, line in zip(result["points"], table):
        tau, delta = point["tau"], point["delta"]
        accept = accept_file(tmp_path, tau, delta, retry)
        scored = tmp_path / f"evaluate-{tau}-{delta}"
        code, _, err = run(capsys, "evaluate", "hover", "--role", "train", "--out", str(scored), *BOOTSTRAP,
                           *setup.arguments(accept=accept))
        assert code == 0, err
        evaluated = json.loads((scored / "evaluate-hover.json").read_text())
        assert evaluated["configuration"]["accept"] == {"tau": tau, "delta": delta, "rotationRetry": retry}
        overall = evaluated["results"]["overall"]
        # Everything evaluate reports for the pair but the exact bounds, which the grid leaves out.
        assert point == {"tau": tau, "delta": delta, **without_exact_bounds(overall)}, (tau, delta)
        if (tau, delta) == (0.62, 0.05):
            assert result["startedFrom"] == {"tau": tau, "delta": delta, **overall}       # the bounds too
        # The grid's table has the same counts.
        assert (float(line["tau"]), float(line["delta"])) == (tau, delta)
        assert [int(line[key]) for key in ("namedRight", "readableFaces", "wrongShown", "shown")] == [
            overall["namedRight"]["numerator"], overall["namedRight"]["denominator"],
            overall["wrongOfShown"]["numerator"], overall["wrongOfShown"]["denominator"]]
        assert {key: int(line[key]) for key in overall["counts"]} == overall["counts"]
        # Event by event: what is shown where, and the box it is shown for.
        events = [json.loads(text) for text in (scored / "evaluate-hover-events.jsonl").read_text().splitlines()]
        rule = AcceptRule(tau=tau, delta=delta, rotation_retry=retry)
        assert [item.to_json() for item in analysis.score(rule)] == events
        distinct.add(json.dumps(overall["counts"], sort_keys=True))
    # The comparison is not of one outcome with itself: the pairs differ.
    assert len(distinct) >= (8 if retry else 5)


def test_the_library_gives_run_hover_s_events_for_any_rule(setup):
    """Without the command line: ``HoverAnalysis.score`` against ``run_hover`` under a
    configuration opened with the rule, as whole objects."""
    rows, account = read_rows([setup.manifest], "train")
    analysis = analyze_hover(rows, setup.frames, open_set(setup), account)
    assert account.used == 6 and len(analysis.rows) == 6 and account.skipped == {"role": 2}
    for tau, delta in [(0.5, 0.0), (0.62, 0.05), (0.8, 0.05), (0.86, 0.045), (0.9, 0.09)]:
        config = open_set(setup)
        rule = AcceptRule(tau=tau, delta=delta)
        config.pipeline.recognizer.rule = rule
        again, other_account = read_rows([setup.manifest], "train")
        expected = run_hover(again, setup.frames, config, other_account)
        assert analysis.score(rule) == expected and len(expected) == 48
        assert rates(analysis.score(rule), 0, 50) == hover_results(expected, 0, 50)["overall"]
        assert rates(expected, 0, 50, exact=False) == without_exact_bounds(rates(expected, 0, 50))
        assert "exact95" in rates(expected, 0, 50)["namedRight"]
    assert other_account.to_json() == account.to_json()


def test_a_frame_under_a_rule_is_the_frame_the_pipeline_reports_with_that_rule(setup):
    """One level down: ``FrameLooks.under`` against ``Pipeline.analyze``, box by box, as
    ``cardvision infer`` would print them."""
    store = FrameStore(setup.frames)
    looks_of = open_set(setup).pipeline
    for row in setup.rows[:3]:
        rgb = load_rgb(store.path(row))
        looks = looks_of.analyze_looks(rgb, name="frame.png", source="memory", t=row.t)
        assert all(len(found) == 4 for found in looks.looks.values()) and len(looks.looks) == 8
        for tau in (0.5, 0.7, 0.86):
            for delta in (0.0, 0.03, 0.06):
                rule = AcceptRule(tau=tau, delta=delta)
                pipeline = open_set(setup).pipeline
                pipeline.recognizer.rule = rule
                expected = pipeline.analyze(rgb, name="frame.png", source="memory", t=row.t)
                found = looks.under(rule)
                assert found.to_json() == expected.to_json()
                assert [card_json(card) for card in found.cards] == [card_json(card) for card in expected.cards]
                assert all(card.recognition.rows == () and card.crop is None for card in found.cards)


def test_the_rotation_retry_decides_outcomes_and_the_grid_follows_it(setup):
    """The cases a shortcut would get wrong. A card on its side whose upright look reads as
    another card: under a low ``tau`` the upright look is accepted, the turned looks are never
    tried, and the wrong name is shown; under a higher ``tau`` they are tried and the right
    name is shown. Taking the best of the four looks would show the right name both times."""
    rows, account = read_rows([setup.manifest], "train")
    analysis = analyze_hover(rows, setup.frames, open_set(setup), account)
    first = analysis.rows[0]
    assert support.FRAMES[0][2] == ("turned", "TOY-017", 1)
    sideways = first.looks.looks[2]
    best = max(range(4), key=lambda k: sideways[k].score)
    assert best != 0 and sideways[0].score > 0.8 and sideways[0].top != sideways[best].top

    def outcome(video: int, place: int, tau: float, delta: float) -> tuple[str, str | None]:
        scored = analysis.score(AcceptRule(tau=tau, delta=delta))
        (found,) = [item for item in scored
                    if item.event.video_id == f"CALIBRATE{video:02d}" and item.event.label == f"p{place}"]
        return found.outcome, found.shown

    # The card on its side, either side of its upright look's score.
    assert outcome(0, 3, 0.8, 0.05) == ("wrong", "Amber Circle")
    assert outcome(0, 3, 0.86, 0.05) == ("right", "Amber Stripes")
    low, high = first.looks.under(AcceptRule(0.8, 0.05)).cards[2], first.looks.under(AcceptRule(0.86, 0.05)).cards[2]
    assert (low.recognition.look, low.recognition.retried) == (0, False)
    assert (high.recognition.look, high.recognition.retried) == (best, True)
    # The card upside down, either side of its upright look's margin: here delta decides.
    assert support.FRAMES[1][1] == ("turned", "TOY-003", 2)
    assert outcome(1, 2, 0.62, 0.02) == ("wrong", "Coral Circle")
    assert outcome(1, 2, 0.62, 0.05) == ("right", "Coral Triangle")
    # Raising tau past the upright look's score also sends it to the turned looks.
    assert outcome(1, 2, 0.7, 0.02) == ("right", "Coral Triangle")


def test_no_turned_look_is_computed_for_a_rule_without_the_retry(setup, tmp_path, monkeypatch):
    embedded = []
    run_batched = recognizer_module.run_batched
    monkeypatch.setattr(recognizer_module, "run_batched",
                        lambda session, tensors, *a, **k: embedded.append(len(tensors)) or run_batched(session, tensors, *a, **k))
    upright = open_set(setup, accept_file(tmp_path, 0.62, 0.05, retry=False))
    store = FrameStore(setup.frames)
    looks = upright.pipeline.analyze_looks(load_rgb(store.path(setup.rows[0])))
    assert embedded == [8] and all(len(found) == 1 for found in looks.looks.values())
    assert not any(card.recognition.retried for card in looks.under(AcceptRule(0.9, 0.0, rotation_retry=False)).cards)
    # Such looks cannot say what a rule with the retry would do, and are not asked to.
    with pytest.raises(ValueError, match="another rotation_retry"):
        looks.under(AcceptRule(0.9, 0.0, rotation_retry=True))
    embedded.clear()
    open_set(setup).pipeline.analyze_looks(load_rgb(store.path(setup.rows[0])))
    assert embedded == [8, 24]


def test_looks_and_decisions_equal_recognize_for_the_same_rule(setup):
    """``Recognizer.looks`` and ``decide`` against ``recognize``, on the crops of one frame."""
    config = open_set(setup)
    pipeline, recognizer = config.pipeline, config.pipeline.recognizer
    store = FrameStore(setup.frames)
    crops = [card.crop for card in pipeline.analyze(load_rgb(store.path(setup.rows[2]))).cards]
    looks = recognizer.looks(crops)
    assert recognizer.looks([]) == [] and len(looks) == 8
    for rule in (AcceptRule(0.5, 0.0), AcceptRule(0.62, 0.05), AcceptRule(0.84, 0.02), AcceptRule(0.9, 0.1)):
        expected = Recognizer(recognizer.session, recognizer.ids, config.pipeline.recognizer._bank_t.T,
                              config.catalog.names(), rule).recognize(crops)
        found = [recognizer.decide(item, rule) for item in looks]
        for got, want in zip(found, expected):
            assert (got.name, got.card_id, got.top_id, got.top_name, got.similarity, got.margin, got.look, got.retried,
                    got.tau_passed, got.accepted) == (want.name, want.card_id, want.top_id, want.top_name,
                                                      want.similarity, want.margin, want.look, want.retried,
                                                      want.tau_passed, want.accepted)
    # Without a rule, the recognizer's own.
    assert recognizer.decide(looks[0]) == recognizer.decide(looks[0], recognizer.rule)


# -------------------------------------------------------------------------------- the grid
def test_values_are_lists_and_ranges_that_include_their_stop():
    assert grid.parse_values("0.5,0.62, 0.7", "--tau") == (0.5, 0.62, 0.7)
    assert grid.parse_values("0.7,0.5,0.5", "--tau") == (0.5, 0.7)
    assert grid.parse_values("0.40:0.50:0.02", "--tau") == (0.4, 0.42, 0.44, 0.46, 0.48, 0.5)
    assert grid.parse_values("0:0.1:0.05,0.02", "--delta") == (0.0, 0.02, 0.05, 0.1)
    assert grid.parse_values("0.6:0.65:0.02", "--tau") == (0.6, 0.62, 0.64)          # the stop is not on a step
    # The defaults: 26 values of tau and 11 of delta, exact to the digit, the published pair among them.
    taus, deltas = grid.parse_values(grid.DEFAULT_TAU, "--tau"), grid.parse_values(grid.DEFAULT_DELTA, "--delta")
    assert (grid.DEFAULT_TAU, grid.DEFAULT_DELTA) == ("0.40:0.90:0.02", "0.00:0.10:0.01")
    assert taus == tuple(round(0.4 + 0.02 * step, 2) for step in range(26)) and taus[-1] == 0.9
    assert deltas == tuple(round(0.01 * step, 2) for step in range(11)) and 0.62 in taus and 0.05 in deltas
    for bad in ("", "high", "0.5:0.9", "0.9:0.5:0.1", "0.5:0.9:0", "0.5:0.9:-0.1", "0.1:0.9:1e-9"):
        with pytest.raises(ValueError, match="--tau"):
            grid.parse_values(bad, "--tau")


def test_the_grid_pairs_every_value_adds_the_starting_pair_and_keeps_its_retry():
    start = AcceptRule(tau=0.99, delta=0.02, rotation_retry=False)
    rules = grid.grid_rules((0.5, 0.7), (0.0, 0.05), start)
    assert [(rule.tau, rule.delta) for rule in rules] == [(0.5, 0.0), (0.5, 0.05), (0.7, 0.0), (0.7, 0.05), (0.99, 0.02)]
    assert all(rule.rotation_retry is False for rule in rules)
    assert len(grid.grid_rules((0.5, 0.99), (0.02,), start)) == 2                  # already in the grid: not twice
    # The values go through the accept rule's own reader, which refuses what the rule does not allow.
    with pytest.raises(ValueError, match="tau must be a number above 0 and at most 1"):
        grid.grid_rules((0.5, 1.5), (0.05,), start)
    with pytest.raises(ValueError, match="delta must be a number from 0 to below 1"):
        grid.grid_rules((0.5,), (-0.01,), start)
    with pytest.raises(ValueError, match="at most 10000"):
        grid.grid_rules(tuple(step / 1000 for step in range(1, 201)), tuple(step / 1000 for step in range(100)), start)


def point(tau: float, delta: float, right: int, wrong: int, faces: int = 20) -> grid.Point:
    shown = right + wrong
    return grid.Point(AcceptRule(tau=tau, delta=delta), {
        "namedRight": {"numerator": right, "denominator": faces, "value": right / faces},
        "wrongOfShown": {"numerator": wrong, "denominator": shown, "value": wrong / shown if shown else None}})


def test_the_pick_is_the_most_named_right_under_the_limit_and_ties_go_to_the_stricter_rule():
    points = [
        point(0.5, 0.0, 16, 8),      # the most right, a third wrong
        point(0.6, 0.0, 14, 2),
        point(0.6, 0.05, 14, 2),     # the same figures as the pair above and below: the higher tau, then delta, wins
        point(0.7, 0.02, 14, 2),
        point(0.7, 0.0, 14, 2),
        point(0.8, 0.0, 14, 3),      # as many right as those four, more wrong: never better than them
        point(0.9, 0.05, 10, 0),
        point(0.95, 0.05, 0, 0),     # shows nothing: no wrong of shown, never picked
    ]
    def pick(limit):
        found = grid.recommend(points, limit)
        return None if found is None else (found.rule.tau, found.rule.delta)

    assert pick(0.0) == (0.9, 0.05)
    assert pick(0.1) == (0.9, 0.05)                  # 2 / 16 = 12.5 % is over the limit
    assert pick(0.125) == (0.7, 0.02)                # at the limit counts as under it
    assert pick(0.2) == (0.7, 0.02)                  # not (0.8, 0.0): the lower wrong of shown comes first
    assert pick(0.33) == (0.7, 0.02) and pick(1 / 3) == (0.5, 0.0) and pick(1.0) == (0.5, 0.0)
    assert [(row.rule.tau, row.rule.delta) for row in grid.trade_off(points)] == [(0.9, 0.05), (0.7, 0.02), (0.5, 0.0)]
    # The pick at any limit is the last row of the trade-off at or under it.
    rows = grid.trade_off(points)
    for limit in (0.0, 0.05, 0.125, 0.13, 0.2, 0.3, 0.34, 0.9):
        under = [row for row in rows if row.wrong_of_shown <= limit]
        assert grid.recommend(points, limit) is under[-1]
    # Nothing at or under the limit: no pick, and a grid that shows nothing has no trade-off.
    assert grid.recommend([point(0.5, 0.0, 16, 8)], 0.1) is None
    assert grid.recommend([point(0.95, 0.05, 0, 0)], 1.0) is None and grid.trade_off([point(0.95, 0.05, 0, 0)]) == []


# ------------------------------------------------------------------------------ the command
def test_the_default_grid_on_the_toy_set(setup, capsys, tmp_path):
    out = tmp_path / "out"
    code, printed, err = run(capsys, "calibrate", *setup.arguments("--max-wrong", "0.15", "--out", str(out)))
    assert code == 0, err
    result = json.loads((out / "calibrate.json").read_text())
    assert (result["kind"], result["version"], result["package"]["version"]) == ("cardvision-calibration", 1, cardvision.__version__)
    assert (out / "calibrate.md").read_text() == printed
    assert sorted(path.name for path in out.iterdir()) == ["accept.json", "calibrate-grid.csv", "calibrate.json", "calibrate.md"]

    # 26 values of tau by 11 of delta; the pair the run started from is one of them.
    assert result["grid"] == {"tau": list(grid.parse_values(grid.DEFAULT_TAU, "--tau")),
                              "delta": list(grid.parse_values(grid.DEFAULT_DELTA, "--delta")), "rotationRetry": True,
                              "startedFrom": {"tau": 0.62, "delta": 0.05}, "pairs": 286, "pairsShowingNothing": 0}
    assert result["events"] == {"events": 48, "groups": 3, "readableFaces": 36, "backs": 5, "offCard": 7, "negatives": 12}
    assert result["inputs"]["role"] == "train" and result["inputs"]["rowsUsed"] == 6
    assert result["inputs"]["rowsRead"] == 8 and result["inputs"]["rowsSkipped"] == {"role": 2}

    by_pair = {(found["tau"], found["delta"]): found for found in result["points"]}

    def figures(pair):
        found = by_pair[pair]
        return (found["namedRight"]["numerator"], found["wrongOfShown"]["numerator"], found["wrongOfShown"]["denominator"])

    assert figures((0.62, 0.05)) == (26, 13, 39)
    # The trade-off: each row names more faces right, and shows more wrong.
    assert [tuple(pair.values()) for pair in result["tradeOff"]] == [(0.9, 0.07), (0.9, 0.05), (0.9, 0.04), (0.78, 0.04)]
    assert [figures(tuple(pair.values())) for pair in result["tradeOff"]] == [(21, 0, 21), (23, 4, 27), (27, 9, 36), (30, 18, 48)]
    assert "| 0.9 | 0.05 | 23 / 36 = 63.89 % | 4 / 27 = 14.81 % |" in printed
    assert "| 0.78 | 0.04 | 30 / 36 = 83.33 % | 18 / 48 = 37.50 % |" in printed

    # The recommendation: 4 / 27 is under 15 %, 9 / 36 is not.
    chosen = result["recommended"]
    assert (chosen["tau"], chosen["delta"], chosen["rotationRetry"], result["maxWrong"]) == (0.9, 0.05, True, 0.15)
    assert by_pair[(0.9, 0.05)] == {"tau": 0.9, "delta": 0.05, **without_exact_bounds(chosen["results"]["overall"])}
    assert chosen["results"]["overall"]["wrongOfShown"]["exact95"]["side"] == "upper"
    assert list(chosen["results"]["bySourceType"]) == ["digital/toy-client", "physical/webcam"]
    assert "- limit: wrong of shown at or under 15.00 % (`--max-wrong 0.15`)" in printed
    assert "- **recommended**: tau 0.9, delta 0.05, the turned looks retried" in printed
    assert "- it rests on 48 events in 3 recording groups: 36 readable faces and 12 negative events" in printed
    assert f"- {report.FRAGILE_NOTE}" in printed and "with few events one event more or less changes which pair" in printed
    assert "Score your evaluation rows once with it" in printed
    assert "recommended: tau 0.9, delta 0.05" in err

    # Few negative events: said in the report, in the result and on standard error.
    warning = ("wrong of shown is weakly measured: the rows hold 12 negative event(s) (card backs and positions with no "
               "card), fewer than 30. A name shown where there is no card can only be counted on such events")
    assert result["warnings"] == [warning] and f"**Warning:** {warning}." in printed and f"warning: {warning}" in err

    # The report says what was scored, as an evaluation's does.
    assert printed.startswith("# Calibration: the accept rule on hover events\n")
    assert "- accept rule: tau 0.62, delta 0.05, the turned looks retried" in printed
    assert "- role evaluated: `train`" in printed and "- rows used: 6" in printed
    assert "- tau: 26 values from 0.4 to 0.9" in printed and "- delta: 11 values from 0 to 0.1" in printed
    assert "- pairs scored: 286, each with the turned looks retried." in printed
    assert "- bootstrap: 10000 replicates, seed 0" in printed
    assert report.RECOMMENDED_DEFINITION in printed and "group bootstrap interval" in printed
    for name in ("detector.onnx", "recognizer.onnx", "bank.json", "catalog.json", "accept.json",
                 "toy-calibration.manifest.jsonl"):
        assert f"`{name}`" in printed
    assert str(setup.frames) not in printed and str(setup.manifest.parent) not in printed

    # Progress is about the analysis pass, and nothing else.
    lines = err.splitlines()
    assert lines[0] == "cardvision calibrate: analyzing the frames of 6 row(s) of role train, each once"
    assert lines[1] == "cardvision calibrate: 6 frame(s) analyzed, 0 row(s) not scored; scoring 286 pairs on them"

    # The accept file: the three keys, read by the one reader, with the retry setting kept.
    assert json.loads((out / "accept.json").read_text()) == {"tau": 0.9, "delta": 0.05, "rotationRetry": True}
    assert (out / "accept.json").read_text() == '{\n "tau": 0.9,\n "delta": 0.05,\n "rotationRetry": true\n}\n'
    assert load_accept(out / "accept.json") == AcceptRule(tau=0.9, delta=0.05, rotation_retry=True)

    # The grid as a table: one line per pair, marked where it matters.
    table = list(csv.DictReader(io.StringIO((out / "calibrate-grid.csv").read_text())))
    assert len(table) == 286 and tuple(table[0]) == report.GRID_COLUMNS
    marked = {name: [(float(line["tau"]), float(line["delta"])) for line in table if line[name] == "yes"]
              for name in ("tradeOff", "recommended", "startedFrom")}
    assert marked == {"tradeOff": [(0.78, 0.04), (0.9, 0.04), (0.9, 0.05), (0.9, 0.07)], "recommended": [(0.9, 0.05)],
                      "startedFrom": [(0.62, 0.05)]}
    assert {line["rotationRetry"] for line in table} == {"true"}

    # Scoring the written file with evaluate gives the report's figures for the recommended pair.
    scored = tmp_path / "scored"
    code, evaluated, err = run(capsys, "evaluate", "hover", "--role", "train", "--out", str(scored),
                               *setup.arguments(accept=out / "accept.json"))
    assert code == 0, err
    assert json.loads((scored / "evaluate-hover.json").read_text())["results"] == chosen["results"]
    for title in ("Overall", "Source type `digital/toy-client`", "Source family `physical`"):
        ours = printed.split(f"### {title}, with the recommended pair\n\n")[1].split("\n\n")[0]
        assert ours == evaluated.split(f"### {title}\n\n")[1].split("\n\n")[0] and "**wrong of shown**" in ours


def test_without_a_limit_nothing_is_recommended_and_no_accept_file_is_written(setup, capsys, tmp_path):
    out = tmp_path / "out"
    code, printed, err = run(capsys, "calibrate", *setup.arguments("--out", str(out), *BOOTSTRAP))
    assert code == 0, err
    result = json.loads((out / "calibrate.json").read_text())
    assert result["maxWrong"] is None and result["recommended"] is None and len(result["tradeOff"]) == 4
    assert sorted(path.name for path in out.iterdir()) == ["calibrate-grid.csv", "calibrate.json", "calibrate.md"]
    assert "No pair is recommended, because no limit was given." in printed and "`--max-wrong RATE`" in printed
    assert "**recommended**" not in printed and "with the recommended pair" not in printed
    assert "| 0.9 | 0.07 | 21 / 36 = 58.33 % | 0 / 21 = 0.00 % |" in printed
    assert "no pair recommended: no --max-wrong was given" in err
    # The same folder takes a second run, which now picks a pair and writes it.
    code, printed, err = run(capsys, "calibrate", *setup.arguments("--out", str(out), "--max-wrong", "0", *BOOTSTRAP))
    assert code == 0, err
    assert json.loads((out / "accept.json").read_text()) == {"tau": 0.9, "delta": 0.07, "rotationRetry": True}
    assert "- limit: wrong of shown at or under 0.00 % (`--max-wrong 0`)" in printed


def test_a_limit_no_pair_meets_gives_no_pick_and_exit_code_1(setup, capsys, tmp_path):
    out = tmp_path / "out"
    arguments = setup.arguments("--tau", "0.5,0.6", "--delta", "0,0.02", "--max-wrong", "0.05", "--out", str(out), *BOOTSTRAP)
    code, printed, err = run(capsys, "calibrate", *arguments)
    assert code == 1
    assert "**no pair is recommended**: no pair of the grid that shows a name keeps wrong of shown at or under the limit" in printed
    assert "The lowest that any pair reaches is 13 / 39 = 33.33 %" in printed
    assert "no pair recommended: none keeps wrong of shown at or under 0.05" in err
    assert not (out / "accept.json").exists() and (out / "calibrate.md").read_text() == printed
    assert json.loads((out / "calibrate.json").read_text())["recommended"] is None


def test_an_accept_rule_is_never_replaced(setup, capsys, tmp_path):
    out = tmp_path / "game"
    out.mkdir()
    kept = '{"tau": 0.62, "delta": 0.05, "rotationRetry": true}'
    (out / "accept.json").write_text(kept, encoding="utf-8")
    for extra in (("--max-wrong", "0.15"), ()):
        code, printed, err = run(capsys, "calibrate", *setup.arguments("--out", str(out), *extra, *BOOTSTRAP))
        assert code == 2 and printed == ""
        assert "accept.json already exists, and calibrate never replaces an accept rule" in err
        assert "analyzing" not in err                  # refused before any model ran
    assert (out / "accept.json").read_text() == kept and [path.name for path in out.iterdir()] == ["accept.json"]
    # Starting from a file and writing elsewhere leaves the file as it was.
    before = setup.accept.read_bytes()
    code, _, err = run(capsys, "calibrate", *setup.arguments("--out", str(tmp_path / "new"), "--max-wrong", "0.15", *BOOTSTRAP))
    assert code == 0, err
    assert setup.accept.read_bytes() == before and (tmp_path / "new" / "accept.json").is_file()
    # The library's writer refuses as well.
    result = json.loads((tmp_path / "new" / "calibrate.json").read_text())
    with pytest.raises(FileExistsError, match="never replaces an accept rule"):
        report.write_calibration(tmp_path / "new", result)


def test_the_evaluation_rows_are_refused_unless_asked_for_and_then_warned_about(setup, capsys, tmp_path):
    held = setup
    code, printed, err = run(capsys, "calibrate", *held.arguments("--role", "evaluation", "--max-wrong", "0.15", *BOOTSTRAP))
    assert code == 2 and printed == ""
    assert "--role evaluation names the rows that figures are reported on" in err
    assert "any figure scored on those rows afterwards is optimistic" in err and "add --allow-evaluation-rows" in err
    assert "analyzing" not in err

    out = tmp_path / "out"
    code, printed, err = run(capsys, "calibrate", *held.arguments("--role", "evaluation", "--allow-evaluation-rows",
                                                                  "--max-wrong", "0.15", "--out", str(out), *BOOTSTRAP))
    assert code == 0, err
    warning = ("these are the evaluation rows (--role evaluation). A rule chosen on them fits them, so any figure scored "
               "on these rows afterwards is optimistic. Calibrate on other rows and keep these for the final score")
    assert f"**Warning:** {warning}." in printed and f"cardvision calibrate: warning: {warning}" in err
    assert json.loads((out / "calibrate.json").read_text())["warnings"][0] == warning
    assert "- role evaluated: `evaluation`" in printed and "- rows used: 2" in printed and "- rows skipped: role 6" in printed
    assert "- events: 16 in 2 recording groups" in printed
    # A role with no row says so in place of scoring nothing; the flag does not matter to it.
    code, printed, err = run(capsys, "calibrate", *held.arguments("--role", "extra", "--allow-evaluation-rows", *BOOTSTRAP))
    assert code == 2 and "no row of role extra could be scored: 8 row(s) read, 0 of that role" in err
    assert cli.build_parser().parse_args(["calibrate", *held.arguments()]).role == "train"


def test_enough_negative_events_bring_no_warning(toy, capsys, tmp_path):
    """Thirty negative events are enough: the same frames three times over, as eighteen rows."""
    plenty = support.Calibration(tmp_path / "set", *toy)
    rows = list(plenty.rows)
    for copy in (1, 2):
        for row in plenty.rows[:6]:
            again = dataclasses.replace(row, video_id=f"COPY{copy}{row.video_id[5:]}")
            shutil.copy(plenty.frames / frame_file_name(row, ".png"), plenty.frames / frame_file_name(again, ".png"))
            rows.append(again)
    write_manifest(plenty.manifest, rows)
    code, printed, err = run(capsys, "calibrate", *plenty.arguments("--tau", "0.9", "--delta", "0.05", *BOOTSTRAP))
    assert code == 0, err
    assert "36 negative events (15 card backs, 21 off-card positions)" in printed
    assert "weakly measured" not in printed and "warning" not in err and report.few_negatives_warning(30) is None
    assert report.few_negatives_warning(29).startswith("wrong of shown is weakly measured: the rows hold 29 negative")


def test_a_row_that_cannot_be_scored_is_listed_and_the_rest_are_calibrated_on(setup, capsys, tmp_path):
    # One frame is missing: its row is listed, as in an evaluation, and the rest are scored.
    frames = tmp_path / "frames"
    shutil.copytree(setup.frames, frames)
    (frames / frame_file_name(setup.rows[5], ".png")).unlink()
    arguments = ["--manifest", str(setup.manifest), "--frames", str(frames), *setup.models(), *BOOTSTRAP]
    code, printed, err = run(capsys, "calibrate", *arguments, "--tau", "0.9", "--delta", "0.07")
    assert code == 0, err
    assert "- rows unusable (not scored): frame-missing 1" in printed and "youtube CALIBRATE05 t=15.0" in printed
    assert "5 frame(s) analyzed, 1 row(s) not scored (listed in the report); scoring 2 pairs on them" in err
    assert "- events: 40 in 3 recording groups" in printed


def test_a_release_is_calibrated_with_its_own_settings(setup, toy, capsys, tmp_path):
    """With ``--release`` the starting rule, its retry setting and the hover selection are the
    release's; the figures are again those of ``evaluate hover`` on that release with another
    accept rule."""
    root = tmp_path / "release"
    root.mkdir()
    shutil.copy(setup.catalog, root / "catalog.json")
    shutil.copy(setup.recognizer, root / "recognizer.onnx")
    rows = np.zeros((release_module.yolox_anchor_count(INPUT_WIDTH, INPUT_HEIGHT), 7), dtype=np.float32)
    rows[:8] = detector_rows(support.PLACES, [0.9 - 0.05 * index for index in range(8)], [0] * 8)
    build_detector(root / "detector.onnx", rows)
    catalog = load_catalog(root / "catalog.json")
    bank = bank_build.build_bank(catalog, toy[1], create_session(root / "recognizer.onnx"), model="toy").bank
    bank_build.write_bank(bank, catalog, root / "bank.json")
    release_module.build_release(
        root / "release.json", detector=root / "detector.onnx", recognizer=root / "recognizer.onnx",
        bank=root / "bank.json", catalog=root / "catalog.json",
        accept={"tau": 0.95, "delta": 0.03, "rotationRetry": False}, settings={"hover": {"selection": "best-score"}})
    before = (root / "release.json").read_bytes()

    base = ["--manifest", str(setup.manifest), "--frames", str(setup.frames), "--release", str(root / "release.json")]
    out = tmp_path / "out"
    code, printed, err = run(capsys, "calibrate", *base, "--tau", "0.6,0.9", "--delta", "0.02,0.06", "--max-wrong", "0.3",
                             "--out", str(out), *BOOTSTRAP)
    assert code == 0, err
    result = json.loads((out / "calibrate.json").read_text())
    assert result["grid"]["startedFrom"] == {"tau": 0.95, "delta": 0.03} and result["grid"]["pairs"] == 5
    assert result["grid"]["rotationRetry"] is False and result["configuration"]["hover"] == {"selection": "best-score"}
    assert "release document id" in printed and "the turned looks not tried (upright looks only)" in printed
    assert json.loads((out / "accept.json").read_text())["rotationRetry"] is False
    assert (root / "release.json").read_bytes() == before and sorted(path.name for path in root.iterdir()) == [
        "bank.identity-groups.json", "bank.json", "catalog.json", "detector.onnx", "recognizer.onnx", "release.json"]
    # The release's own pair, scored by evaluate on the release itself.
    code, _, err = run(capsys, "evaluate", "hover", "--role", "train", *base, "--out", str(tmp_path / "scored"), *BOOTSTRAP)
    assert code == 0, err
    overall = json.loads((tmp_path / "scored" / "evaluate-hover.json").read_text())["results"]["overall"]
    (own,) = [found for found in result["points"] if (found["tau"], found["delta"]) == (0.95, 0.03)]
    assert own == {"tau": 0.95, "delta": 0.03, **without_exact_bounds(overall)}
    assert result["startedFrom"] == {"tau": 0.95, "delta": 0.03, **overall}
    # A release pins every file and setting: no accept file beside it.
    code, _, err = run(capsys, "calibrate", *base, "--accept", str(setup.accept))
    assert code == 2 and "--release pins every file and setting" in err


def test_wrong_arguments_are_reported(setup, capsys, tmp_path):
    for extra, message in (
        (("--tau", "high"), "--tau: expected numbers separated by commas"),
        (("--delta", "0.1:0"), "--delta: expected numbers separated by commas"),
        (("--tau", "1.5"), "tau must be a number above 0 and at most 1"),
        (("--max-wrong", "15"), "--max-wrong is a fraction from 0 to 1 (0.02 is 2 %), got 15"),
        (("--bootstrap", "0"), "--bootstrap must be at least 1"),
    ):
        code, printed, err = run(capsys, "calibrate", *setup.arguments(*extra))
        assert code == 2 and printed == "" and message in err, extra
    code, _, err = run(capsys, "calibrate", "--manifest", str(tmp_path / "none.jsonl"), "--frames", str(setup.frames),
                       *setup.models())
    assert code == 2 and "no such manifest file" in err
    code, _, err = run(capsys, "calibrate", "--manifest", str(setup.manifest), "--frames", str(tmp_path / "none"),
                       *setup.models())
    assert code == 2 and "no such folder of frames" in err
    code, _, err = run(capsys, "calibrate", "--manifest", str(setup.manifest), "--frames", str(setup.frames),
                       "--detector", str(setup.detector))
    assert code == 2 and "give --release, or all of --detector, --recognizer, --bank and --catalog" in err


def test_the_help_states_the_defaults_and_that_there_is_no_default_limit(capsys):
    with pytest.raises(SystemExit):
        cli.main(["calibrate", "--help"])
    text = " ".join(capsys.readouterr().out.split())
    assert "(default 0.40:0.90:0.02)" in text and "(default 0.00:0.10:0.01)" in text and "(default train)" in text
    assert "There is no default" in text and "--allow-evaluation-rows" in text
