# SPDX-License-Identifier: Apache-2.0
"""``cardvision refresh verdict``: a frozen rule applied to a replay (gate R) and to a new-card
check (gate N), on synthetic evaluate hover runs of the toy game. Every gate passes once, fails
once and is found INVALID once; a rule that is not the frozen one, or whose PARAMETERS line does
not follow ``refresh-rule/1``, is refused."""

from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path

import pytest

from cardvision.refresh import commands  # noqa: F401  (the parser the helper uses)
from cardvision.refresh.diff import diff_runs
from cardvision.refresh.verdict import RuleError, judge, load_rule, parameter_errors, rule_schema, schema_errors
from test_refresh_diff import event, refresh, write_run

ROOT = Path(__file__).resolve().parents[1]
BASE_ID, CAND_ID, BASELINE_ID = "b" * 16, "c" * 16, "0" * 16
LIMIT0 = {"maxEvents": 0, "maxNamedRightDropPt": 0, "maxWrongOfShownRisePt": 0}
PARAMS = {
    "schema": "refresh-rule/1",
    "datasets": ["real", "generated"],
    "validity": {"real": {"minCompared": 10, "minFaces": 8}, "generated": {"minCompared": 40, "minFaces": 36}},
    "regressions": {"real": LIMIT0,
                    "generated": {"maxEvents": 2, "maxNamedRightDropPt": 5.0, "maxWrongOfShownRisePt": 5.0}},
    "newcard": {"seed": 7, "scenes": 20, "maxEventCountDiffShare": 0.1, "maxNamedRightBelowRefPt": 12,
                "maxWrongOfShownAboveRefPt": 4, "minDrawnShare": 0.8, "referenceDir": "newcard-ref",
                "n3": "fewerWrong"},
}


def write_rule(folder: Path, params: dict, name: str = "RULE.txt", freeze: bool = True) -> Path:
    """A rule file with a PARAMETERS line, and its frozen hash beside it."""
    folder.mkdir(parents=True, exist_ok=True)
    rule = folder / name
    rule.write_text("TOY BANK REFRESH: A FROZEN RULE\n\n1. QUESTION\n   ...\n\n"
                    f"PARAMETERS: {json.dumps(params)}\n", encoding="utf-8")
    if freeze:
        (folder / (Path(name).stem + ".SHA256")).write_text(
            f"{hashlib.sha256(rule.read_bytes()).hexdigest()}  {name}\n", encoding="utf-8")
    return rule


# ------------------------------------------------------------------------- gate R folders
def dataset_events(dataset: str, source: str) -> list[dict]:
    """The base run's events: ``real`` has 10 faces and 2 backs, ``generated`` 40 faces; one
    face of each is a card the candidate adds (TOY-017), for rehearsals that exclude it."""
    if dataset == "real":
        return ([event(f"real-{i}", source=source) for i in range(9)]
                + [event("real-9", outcome="nothing", truth="TOY-017", source=source)]
                + [event(f"real-back-{i}", "back", "nothing", source=source) for i in range(2)])
    return ([event(f"gen-{i}", source="generated") for i in range(36)]
            + [event(f"gen-{i}", outcome="nothing", source="generated") for i in range(36, 39)]
            + [event("gen-39", outcome="nothing", truth="TOY-017", source="generated")])


def changed(events: list[dict], changes: dict[str, dict]) -> list[dict]:
    return [dict(e, **changes.get(e["key"], {})) for e in events]


def replay_folder(root: Path, changes: dict | None = None, *, arms=None, canary: bool | None = True,
                  base_id: str = BASE_ID, cumulative: dict | None = None, source: str = "digital/client",
                  exclude: tuple = ()) -> Path:
    """A replay folder as a product's replay script leaves it: base and candidate runs per
    dataset (and arm), their diffs, the canary; with ``cumulative`` (changes against the
    baseline run), the baseline runs and their diffs."""
    changes = changes or {}
    root.mkdir(parents=True)
    for dataset in ("real", "generated"):
        for arm in arms or [None]:
            name = dataset if arm is None else f"{dataset}-{arm}"
            base = dataset_events(dataset, source)
            b = write_run(root / f"base-{name}", base, base_id)
            c = write_run(root / f"cand-{name}", changed(base, changes.get(dataset, {})), CAND_ID)
            doc = diff_runs(b, c, exclude_prefixes=exclude)
            (root / f"diff-{name}.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
            if cumulative is not None:
                t = write_run(root / f"baseline-{name}", base, BASELINE_ID)
                c2 = write_run(root / f"cand-vs-baseline-{name}", changed(base, cumulative.get(dataset, {})), CAND_ID)
                doc = diff_runs(t, c2)
                (root / f"diff-cum-{name}.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    if canary is not None:
        (root / "CANARY.json").write_text(json.dumps({"ok": canary, "baseline": BASELINE_ID}), encoding="utf-8")
    return root


def lost(*keys: str) -> dict:
    """Faces named right in the base that show nothing in the candidate."""
    return {key: {"outcome": "nothing", "shown_id": None} for key in keys}


# ------------------------------------------------------------------------------ gate R
def test_gate_r_passes_writes_its_verdict_and_reports_every_number(tmp_path):
    rule = write_rule(tmp_path / "rule", PARAMS)
    folder = replay_folder(tmp_path / "replay", {"generated": lost("gen-0")})
    out = judge("replay", folder, rule)
    assert (out["gate"], out["verdict"], out["notes"], out["rehearsal"]) == ("R", "PASS", [], False)
    assert out["rule"] == hashlib.sha256(rule.read_bytes()).hexdigest()
    assert list(out["detail"]) == ["real", "generated"]
    gen = out["detail"]["generated"]
    assert (gen["compared"], gen["faces"], gen["regressions"], gen["namedRightDeltaPt"], gen["ok"]) == (40, 40, 1, -2.5, True)
    assert gen["events"] == {"right_to_nothing": [{"key": "gen-0", "truth": "TOY-001", "base": "TOY-001", "cand": None}]}
    written = (folder / "VERDICT-R.json").read_text()
    assert written.endswith("\n") and json.loads(written) == out


def test_gate_r_fails_on_one_real_regression_and_on_a_generated_step_beyond_its_bar(tmp_path):
    rule = write_rule(tmp_path / "rule", PARAMS)
    out = judge("replay", replay_folder(tmp_path / "a", {"real": lost("real-0")}), rule)
    assert out["verdict"] == "FAIL" and out["notes"] == [
        "real: 1 regression(s) (max 0), named right -10.00 pt, wrong of shown +0.00 pt"]
    out = judge("replay", replay_folder(tmp_path / "b", {"generated": lost("gen-0", "gen-1", "gen-2")}), rule)
    assert out["verdict"] == "FAIL" and out["notes"][0].startswith("generated: 3 regression(s) (max 2)")
    # a rate bar alone: two wrong names push wrong of shown past 5 pt within the event bar
    wrong = {k: {"outcome": "wrong", "shown_id": "TOY-002"} for k in ("gen-36", "gen-37")}
    out = judge("replay", replay_folder(tmp_path / "c", {"generated": wrong}), rule)
    assert out["verdict"] == "FAIL" and out["detail"]["generated"]["regressions"] == 2


def test_gate_r_is_invalid_on_excluded_events_outside_a_rehearsal(tmp_path, monkeypatch):
    rule = write_rule(tmp_path / "rule", PARAMS)
    folder = replay_folder(tmp_path / "replay", exclude=("TOY-017",))
    params = copy.deepcopy(PARAMS)
    for need in params["validity"].values():
        need["minCompared"] = need["minFaces"] = 0
    lenient = write_rule(tmp_path / "lenient", params)
    out = judge("replay", folder, lenient)
    assert out["verdict"] == "INVALID" and out["notes"] == ["real: compared 11 (min 0), only 0/0, excluded 1"]
    assert judge("replay", folder, lenient, rehearsal=True)["verdict"] == "PASS"
    monkeypatch.setenv("REFRESH_REHEARSAL", "1")
    out = judge("replay", folder, lenient)
    assert out["verdict"] == "PASS" and out["rehearsal"] is True
    # the rule names its own switch
    custom = write_rule(tmp_path / "custom", {**params, "rehearsalEnv": "MY_GAME_REHEARSAL"})
    assert judge("replay", folder, custom)["verdict"] == "INVALID"
    monkeypatch.setenv("MY_GAME_REHEARSAL", "1")
    assert judge("replay", folder, custom)["verdict"] == "PASS"
    assert judge("replay", folder, rule, rehearsal=True)["verdict"] == "INVALID"  # too few compared once excluded


def test_gate_r_is_invalid_on_too_few_events_events_out_of_step_or_a_missing_diff(tmp_path):
    params = copy.deepcopy(PARAMS)
    params["validity"]["real"]["minCompared"] = 13
    out = judge("replay", replay_folder(tmp_path / "a"), write_rule(tmp_path / "r1", params))
    assert out["verdict"] == "INVALID" and out["notes"] == ["real: compared 12 (min 13), only 0/0, excluded 0"]
    params = copy.deepcopy(PARAMS)
    params["validity"]["generated"]["minFaces"] = 41
    out = judge("replay", replay_folder(tmp_path / "b"), write_rule(tmp_path / "r2", params))
    assert out["notes"] == ["generated: 40 readable faces (min 41)"]
    rule = write_rule(tmp_path / "rule", PARAMS)
    folder = replay_folder(tmp_path / "c")
    doc = json.loads((folder / "diff-real.json").read_text())
    doc["onlyCandidate"] = 1
    (folder / "diff-real.json").write_text(json.dumps(doc), encoding="utf-8")
    assert judge("replay", folder, rule)["verdict"] == "INVALID"
    (folder / "diff-generated.json").unlink()
    (folder / "diff-real.json").unlink()
    out = judge("replay", folder, rule)
    assert out["verdict"] == "INVALID" and out["notes"][0].startswith("missing ")


def test_the_canary(tmp_path):
    rule = write_rule(tmp_path / "rule", {**PARAMS, "canary": {"file": "CANARY.json"}})
    out = judge("replay", replay_folder(tmp_path / "ok"), rule)
    assert out["verdict"] == "PASS" and out["detail"]["canary"]["ok"] is True
    for name, canary in (("failed", False), ("absent", None)):
        out = judge("replay", replay_folder(tmp_path / name, canary=canary), rule)
        assert out["verdict"] == "INVALID" and out["notes"][0].startswith("no passing canary")
    # a rule without a canary does not look for one
    assert judge("replay", replay_folder(tmp_path / "none", canary=None), write_rule(tmp_path / "r2", PARAMS))["verdict"] == "PASS"


CUMULATIVE = {"baselineRelease": BASELINE_ID, "baseRun": "base-generated",
              "regressions": {"real": LIMIT0, "generated": {"maxEvents": 3, "maxNamedRightDropPt": 10.0,
                                                            "maxWrongOfShownRisePt": 10.0}}}


def test_the_cumulative_limit_applies_unless_the_live_release_is_the_baseline(tmp_path):
    rule = write_rule(tmp_path / "rule", {**PARAMS, "cumulative": CUMULATIVE})
    # step within its bar, cumulative within its bar
    out = judge("replay", replay_folder(tmp_path / "pass", {"generated": lost("gen-0")},
                                        cumulative={"generated": lost("gen-0", "gen-1", "gen-2")}), rule)
    assert out["verdict"] == "PASS" and out["detail"]["cumulative-generated"]["regressions"] == 3
    # each step passes, the losses add up: the cumulative limit fails
    out = judge("replay", replay_folder(tmp_path / "fail", {"generated": lost("gen-0")},
                                        cumulative={"generated": lost(*(f"gen-{i}" for i in range(5)))}), rule)
    assert out["verdict"] == "FAIL" and out["detail"]["generated"]["ok"]
    assert out["notes"] == ["cumulative generated vs the baseline: 5 regression(s) (max 3), named right -12.50 pt, "
                            "wrong of shown +0.00 pt"]
    # the base is not the baseline and the cumulative diffs are missing
    out = judge("replay", replay_folder(tmp_path / "missing"), rule)
    assert out["verdict"] == "INVALID" and "is not the baseline release" in out["notes"][0]
    # the base is the baseline: nothing more to judge, no cumulative file needed
    out = judge("replay", replay_folder(tmp_path / "baseline", base_id=BASELINE_ID), rule)
    assert out["verdict"] == "PASS" and not any(k.startswith("cumulative") for k in out["detail"])


def test_real_faces_by_source(tmp_path):
    real = {"minFaces": 10, "sources": {"client": {"runs": ["base-real"], "prefixes": ["digital/"]},
                                        "table": {"runs": ["base-real"], "prefixes": ["physical"]}}}
    rule = write_rule(tmp_path / "rule", {**PARAMS, "realFacesBySource": real})
    out = judge("replay", replay_folder(tmp_path / "digital"), rule)
    assert out["verdict"] == "INVALID" and out["detail"]["realFacesBySource"] == {"client": 10, "table": 0}
    assert out["notes"] == ["real footage: 0 readable table faces (min 10)"]
    real["sources"]["table"]["runs"] = ["base-real", "base-generated"]
    real["sources"]["table"]["prefixes"] = ["physical", "generated"]
    out = judge("replay", replay_folder(tmp_path / "both"), write_rule(tmp_path / "r2", {**PARAMS, "realFacesBySource": real}))
    assert out["verdict"] == "PASS" and out["detail"]["realFacesBySource"] == {"client": 10, "table": 40}


def test_real_faces_by_exact_source_type_and_by_prefix_are_told_apart(tmp_path):
    folder = replay_folder(tmp_path / "replay", source="digital/client")
    # a second source type that shares the first's name as a prefix
    events = [dict(e, source_type="digital/client-beta") for e in dataset_events("real", "digital/client")]
    write_run(folder / "base-beta", events, BASE_ID)
    sources = {"client": {"runs": ["base-real", "base-beta"], "types": ["digital/client"]},
               "beta": {"runs": ["base-real", "base-beta"], "types": ["digital/client-beta"]},
               "all": {"runs": ["base-real", "base-beta"], "prefixes": ["digital/client"]},
               "both": {"runs": ["base-real", "base-beta"], "types": ["digital/client"], "prefixes": ["digital/client-"]}}
    rule = write_rule(tmp_path / "rule", {**PARAMS, "realFacesBySource": {"minFaces": 1, "sources": sources}})
    out = judge("replay", folder, rule)
    assert out["verdict"] == "PASS"
    assert out["detail"]["realFacesBySource"] == {"client": 10, "beta": 10, "all": 20, "both": 20}


def test_malformed_inputs_are_invalid_never_a_fail_or_a_traceback(tmp_path, capsys):
    rule = write_rule(tmp_path / "rule", {**PARAMS, "canary": {"file": "CANARY.json"}, "cumulative": CUMULATIVE})
    folder = replay_folder(tmp_path / "canary-list")
    (folder / "CANARY.json").write_text("[]", encoding="utf-8")
    assert judge("replay", folder, rule)["verdict"] == "INVALID"
    folder = replay_folder(tmp_path / "null-configuration")
    (folder / "base-generated" / "evaluate-hover.json").write_text(json.dumps({"configuration": None}), encoding="utf-8")
    out = judge("replay", folder, rule)
    assert out["verdict"] == "INVALID" and out["notes"][0].startswith("unreadable input: AttributeError")
    folder = replay_folder(tmp_path / "diff-list")
    (folder / "diff-real.json").write_text("[1]", encoding="utf-8")
    assert judge("replay", folder, rule)["verdict"] == "INVALID"
    folder = replay_folder(tmp_path / "not-json")
    (folder / "diff-real.json").write_text("{", encoding="utf-8")
    assert judge("replay", folder, rule)["verdict"] == "INVALID"
    n_rule = newcard_rule(tmp_path, "n-rule")
    folder = newcard_folder(tmp_path / "manifest-list", faces(55, 3, 42), faces(0, 20, 80))
    (folder / "scenes" / "manifest.json").write_text("[]", encoding="utf-8")
    assert judge("newcard", folder, n_rule)["verdict"] == "INVALID"
    assert refresh(["verdict", "newcard", str(folder), "--rule", str(n_rule)]) == 3
    folder = newcard_folder(tmp_path / "labels", faces(55, 3, 42), faces(0, 20, 80))
    (folder / "scenes" / "labels.jsonl").write_text('{"objects": [3]}\n', encoding="utf-8")
    assert judge("newcard", folder, n_rule)["verdict"] == "INVALID"
    folder = newcard_folder(tmp_path / "counts", faces(55, 3, 42), faces(0, 20, 80))
    (folder / "old" / "evaluate-hover.json").write_text(json.dumps({"results": {"overall": None}}), encoding="utf-8")
    assert judge("newcard", folder, n_rule)["verdict"] == "INVALID"


def test_a_missing_folder_is_invalid_and_writes_nothing_and_an_unwritable_verdict_is_invalid(tmp_path, monkeypatch):
    rule = write_rule(tmp_path / "rule", PARAMS)
    out = judge("replay", tmp_path / "absent", rule)
    assert (out["verdict"], out["notes"]) == ("INVALID", [f"no folder at {tmp_path / 'absent'}"])
    assert not (tmp_path / "absent").exists()
    assert refresh(["verdict", "replay", str(tmp_path / "absent"), "--rule", str(rule)]) == 3
    folder = replay_folder(tmp_path / "replay")

    def refuse(self, *args, **kwargs):
        raise PermissionError("read-only")

    monkeypatch.setattr(Path, "write_text", refuse)
    out = judge("replay", folder, rule)
    assert out["verdict"] == "INVALID" and out["notes"][-1].startswith("could not write ")


def test_arms_name_every_file_and_row(tmp_path):
    params = {**PARAMS, "arms": ["plain", "stage"]}
    rule = write_rule(tmp_path / "rule", params)
    out = judge("replay", replay_folder(tmp_path / "replay", arms=["plain", "stage"]), rule)
    assert out["verdict"] == "PASS" and list(out["detail"]) == ["real-plain", "real-stage", "generated-plain", "generated-stage"]
    out = judge("replay", replay_folder(tmp_path / "one-arm"), rule)
    assert out["verdict"] == "INVALID" and out["notes"][0].endswith("diff-real-plain.json")


def test_the_tolerance_on_the_rate_bars(tmp_path):
    folder = tmp_path / "replay"
    folder.mkdir()
    for dataset, n in (("real", 12), ("generated", 40)):
        rates = {"base": {"faces": n, "namedRight": 0.5, "wrongOfShown": 0.01},
                 "candidate": {"faces": n, "namedRight": 0.499, "wrongOfShown": 0.01}}
        doc = {"onlyBase": 0, "onlyCandidate": 0, "excluded": 0, "compared": n, "regressionCount": 0,
               "regressionsByType": {}, "improvements": {}, "rates": rates, "regressions": {}}
        (folder / f"diff-{dataset}.json").write_text(json.dumps(doc), encoding="utf-8")
    params = copy.deepcopy(PARAMS)
    params["regressions"] = {"real": {**LIMIT0, "maxNamedRightDropPt": 0.1},
                             "generated": {**LIMIT0, "maxNamedRightDropPt": 0.1}}
    assert (0.499 - 0.5) * 100 < -0.1  # rounding puts the drop a hair past the bar
    assert judge("replay", folder, write_rule(tmp_path / "default", params))["verdict"] == "PASS"
    assert judge("replay", folder, write_rule(tmp_path / "exact", {**params, "tolerancePt": 0}))["verdict"] == "FAIL"


# ------------------------------------------------------------------------------ gate N
def faces(right: int, wrong: int, nothing: int, backs_shown: int = 0) -> list[dict]:
    return ([event(f"f{i}") for i in range(right)]
            + [event(f"f{right + i}", outcome="wrong", shown="TOY-002") for i in range(wrong)]
            + [event(f"f{right + wrong + i}", outcome="nothing") for i in range(nothing)]
            + [event(f"b{i}", "back", "wrong", shown="TOY-003") for i in range(backs_shown)])


def newcard_folder(root: Path, cand: list[dict], old: list[dict], *, arms=None, seed: int = 7, scenes: int = 20,
                   drawn: int = 3, with_art: int = 3) -> Path:
    root.mkdir(parents=True)
    (root / "scenes").mkdir()
    (root / "scenes" / "manifest.json").write_text(
        json.dumps({"seed": seed, "scenes": scenes, "catalog": {"cardsWithArt": with_art, "cardsWithoutArt": 0}}),
        encoding="utf-8")
    labels = [{"objects": [{"kind": "face", "cardId": f"TOY-0{17 + i}"}, {"kind": "back"}]} for i in range(drawn)]
    (root / "scenes" / "labels.jsonl").write_text("".join(json.dumps(x) + "\n" for x in labels), encoding="utf-8")
    for arm in arms or [None]:
        suffix = "" if arm is None else f"-{arm}"
        write_run(root / f"cand{suffix}", cand, CAND_ID)
        write_run(root / f"old{suffix}", old, BASE_ID)
    return root


def newcard_rule(tmp_path: Path, name: str, arms=None, **newcard) -> Path:
    params = copy.deepcopy(PARAMS)
    params["newcard"].update(newcard)
    if arms:
        params["arms"] = arms
    rule = write_rule(tmp_path / name, params)
    reference = faces(60, 2, 38)  # named right 60 %, wrong of shown 2/62
    for arm in arms or [None]:
        folder = rule.parent / params["newcard"]["referenceDir"].replace("{arm}", arm or "")
        write_run(folder, reference, BASE_ID)
    return rule


def test_gate_n_passes_and_fails_on_n1_n2_and_n3(tmp_path):
    rule = newcard_rule(tmp_path, "rule")
    out = judge("newcard", newcard_folder(tmp_path / "pass", faces(55, 3, 42), faces(0, 20, 80)), rule)
    assert out["verdict"] == "PASS" and out["gate"] == "N"
    runs = out["detail"]["runs"]
    assert runs["N1 named right"] and runs["N2 wrong of shown"] and runs["N3 fewer wrong than the old bank"]
    assert runs["candidate"]["faces"] == 100 and out["detail"]["drawn"] == {"cards": 3, "withArt": 3}
    assert json.loads((tmp_path / "pass" / "VERDICT-N.json").read_text()) == out
    out = judge("newcard", newcard_folder(tmp_path / "n1", faces(45, 1, 54), faces(0, 20, 80)), rule)
    assert out["verdict"] == "FAIL" and "(N1 False)" in out["notes"][0]
    out = judge("newcard", newcard_folder(tmp_path / "n2", faces(60, 6, 34), faces(0, 20, 80)), rule)
    assert out["verdict"] == "FAIL" and "(N2 False)" in out["notes"][0]
    # the live bank judged as the candidate (a trip from the template's section 8)
    out = judge("newcard", newcard_folder(tmp_path / "n3", faces(0, 20, 80), faces(0, 20, 80)), rule)
    assert out["verdict"] == "FAIL" and "(N1 False)" in out["notes"][0] and "(N3 False)" in out["notes"][0]


def test_the_two_n3_variants(tmp_path):
    # the live bank already names some of the new art: no fewer wrong, but more right
    cand, old = faces(60, 1, 39), faces(40, 1, 59)
    fewer = judge("newcard", newcard_folder(tmp_path / "a", cand, old), newcard_rule(tmp_path, "fewer", n3="fewerWrong"))
    assert fewer["verdict"] == "FAIL" and fewer["detail"]["runs"]["N3 fewer wrong than the old bank"] is False
    rule = newcard_rule(tmp_path, "better", n3="notWorseOneBetter")
    better = judge("newcard", newcard_folder(tmp_path / "b", cand, old), rule)
    assert better["verdict"] == "PASS" and better["detail"]["runs"]["N3 better than the old bank on these cards"] is True
    # not worse on both counts is not enough, and a worse count fails whatever the other
    assert judge("newcard", newcard_folder(tmp_path / "c", faces(40, 1, 59), old), rule)["verdict"] == "FAIL"
    assert judge("newcard", newcard_folder(tmp_path / "d", faces(61, 2, 37), old), rule)["verdict"] == "FAIL"


def test_gate_n_invalid_trips(tmp_path):
    rule = newcard_rule(tmp_path, "rule")
    good, old = faces(55, 3, 42), faces(0, 20, 80)
    cases = {
        "seed": (dict(seed=8), "scenes seed/count 8/20, rule 7/20"),
        "drawn": (dict(drawn=2), "only 2 of 3 new cards drawn (min 80%)"),
        "none": (dict(drawn=0, with_art=0), "only 0 of 0 new cards drawn (min 80%)"),
    }
    for name, (options, note) in cases.items():
        out = judge("newcard", newcard_folder(tmp_path / name, good, old, **options), rule)
        assert (out["verdict"], out["notes"]) == ("INVALID", [note]), name
    # minNewCards 0 lets an empty set through to the other checks
    empty = newcard_rule(tmp_path, "empty", minNewCards=0)
    assert judge("newcard", newcard_folder(tmp_path / "empty-ok", good, old, drawn=0, with_art=0), empty)["verdict"] == "PASS"
    out = judge("newcard", newcard_folder(tmp_path / "steps", good, faces(0, 20, 81)), rule)
    assert out["verdict"] == "INVALID" and out["notes"] == ["events cand 100 / old 101 / reference 100"]
    out = judge("newcard", newcard_folder(tmp_path / "far", faces(55, 3, 62), faces(0, 20, 100)), rule)
    assert out["verdict"] == "INVALID"  # 120 events against the reference's 100: beyond 10 %
    folder = newcard_folder(tmp_path / "missing", good, old)
    (folder / "old" / "evaluate-hover.json").unlink()
    out = judge("newcard", folder, rule)
    assert out["verdict"] == "INVALID" and out["notes"][0].startswith("missing run: ")
    (folder / "scenes" / "manifest.json").unlink()
    out = judge("newcard", folder, rule)
    assert out["verdict"] == "INVALID" and out["notes"][0].startswith("unreadable input: ")


def test_gate_n_with_arms_and_a_reference_per_arm(tmp_path):
    rule = newcard_rule(tmp_path, "rule", arms=["plain", "stage"], referenceDir="refs/base-{arm}")
    out = judge("newcard", newcard_folder(tmp_path / "n", faces(55, 3, 42), faces(0, 20, 80), arms=["plain", "stage"]), rule)
    assert out["verdict"] == "PASS" and {"plain", "stage"} <= set(out["detail"])
    assert out["detail"]["stage"]["reference"]["events"] == 100
    # --reference stands in for the rule's folder
    other = tmp_path / "elsewhere"
    write_run(other / "x-plain", faces(90, 0, 10), BASE_ID)
    write_run(other / "x-stage", faces(90, 0, 10), BASE_ID)
    out = judge("newcard", tmp_path / "n", rule, reference=other / "x-{arm}")
    assert out["verdict"] == "FAIL" and out["notes"][0].startswith("plain: ")


# ------------------------------------------------------------------------- the rule itself
def test_a_rule_whose_hash_is_not_the_frozen_one_is_refused_and_nothing_is_written(tmp_path, capsys):
    rule = newcard_rule(tmp_path, "rule")
    folder = newcard_folder(tmp_path / "n", faces(55, 3, 42), faces(0, 20, 80))
    rule.write_bytes(rule.read_bytes() + b" ")
    with pytest.raises(RuleError, match="is not the frozen"):
        judge("newcard", folder, rule)
    assert refresh(["verdict", "newcard", str(folder), "--rule", str(rule)]) == 3
    assert "INVALID: the rule is refused" in capsys.readouterr().out
    assert not (folder / "VERDICT-N.json").exists()
    (rule.parent / "RULE.SHA256").unlink()
    with pytest.raises(RuleError, match="no frozen hash"):
        load_rule(rule)
    with pytest.raises(RuleError, match="cannot read the rule"):
        load_rule(tmp_path / "absent.txt")


def test_the_sha_file_may_be_named(tmp_path):
    rule = write_rule(tmp_path / "rule", PARAMS, freeze=False)
    sums = tmp_path / "frozen.txt"
    sums.write_text(hashlib.sha256(rule.read_bytes()).hexdigest() + "\n", encoding="utf-8")
    assert load_rule(rule, sums)[0] == PARAMS
    with pytest.raises(RuleError):
        load_rule(rule)


BAD_PARAMETERS = {
    "unknown key": lambda p: p.update(extra=1),
    "missing newcard": lambda p: p.pop("newcard"),
    "another schema": lambda p: p.update(schema="refresh-rule/2"),
    "an unknown n3": lambda p: p["newcard"].update(n3="fewer"),
    "a negative limit": lambda p: p["regressions"]["real"].update(maxEvents=-1),
    "a limit as text": lambda p: p["regressions"]["real"].update(maxNamedRightDropPt="0"),
    "a share above 1": lambda p: p["newcard"].update(minDrawnShare=1.5),
    "an upper-case dataset": lambda p: p.update(datasets=["Real", "generated"]),
    "a dataset without validity": lambda p: p.update(datasets=["real", "generated", "third"]),
    "a boolean seed": lambda p: p["newcard"].update(seed=True),
    "an absolute reference": lambda p: p["newcard"].update(referenceDir="/abs/ref"),
    "a short baseline id": lambda p: p.update(cumulative={**CUMULATIVE, "baselineRelease": "abc"}),
    "an option outside the schema": lambda p: p.update(baseline="0123456789abcdef"),
    "a dataset named canary": lambda p: (p.update(datasets=["real", "canary"]),
                                         p["validity"].update(canary=p["validity"].pop("generated")),
                                         p["regressions"].update(canary=p["regressions"].pop("generated"))),
    "an arm named drawn": lambda p: p.update(arms=["plain", "drawn"]),
    "an arm named runs": lambda p: p.update(arms=["runs"]),
    "a source with neither types nor prefixes": lambda p: p.update(
        realFacesBySource={"minFaces": 1, "sources": {"s": {"runs": ["base-real"]}}}),
}


@pytest.mark.parametrize("case", sorted(BAD_PARAMETERS))
def test_a_parameters_line_that_does_not_follow_the_schema_is_refused(tmp_path, case, capsys):
    params = copy.deepcopy(PARAMS)
    BAD_PARAMETERS[case](params)
    rule = write_rule(tmp_path / "rule", params)
    folder = replay_folder(tmp_path / "replay")
    with pytest.raises(RuleError, match="does not follow refresh-rule/1"):
        judge("replay", folder, rule)
    assert refresh(["verdict", "replay", str(folder), "--rule", str(rule)]) == 3
    assert not (folder / "VERDICT-R.json").exists()


def test_a_rule_without_exactly_one_json_parameters_line_is_refused(tmp_path):
    for name, text in (("none", "no parameters\n"), ("two", f"PARAMETERS: {json.dumps(PARAMS)}\n" * 2),
                       ("text", "PARAMETERS: {not json}\n")):
        rule = tmp_path / f"{name}.txt"
        rule.write_text(text, encoding="utf-8")
        (tmp_path / f"{name}.SHA256").write_text(hashlib.sha256(rule.read_bytes()).hexdigest(), encoding="utf-8")
        with pytest.raises(RuleError):
            load_rule(rule)


def test_the_schema_validator_agrees_with_jsonschema():
    jsonschema = pytest.importorskip("jsonschema")
    schema = rule_schema()
    jsonschema.Draft202012Validator.check_schema(schema)
    validator = jsonschema.Draft202012Validator(schema)
    full = {**PARAMS, "arms": ["a"], "canary": {"file": "CANARY.json"}, "cumulative": CUMULATIVE, "tolerancePt": 0,
            "rehearsalEnv": "X_REHEARSAL",
            "realFacesBySource": {"minFaces": 1, "sources": {"s": {"runs": ["base-real"], "prefixes": ["p"]}}}}
    for good in (PARAMS, full):
        assert schema_errors(good) == [] and list(validator.iter_errors(good)) == [] and parameter_errors(good) == []
    for case, change in BAD_PARAMETERS.items():
        params = copy.deepcopy(PARAMS)
        change(params)
        assert parameter_errors(params), case
        if case != "a dataset without validity":  # a cross-check the schema cannot state
            assert schema_errors(params) and list(validator.iter_errors(params)), case


def template_example() -> dict:
    text = (ROOT / "docs" / "refresh-rule-template.md").read_text(encoding="utf-8")
    blocks = re.findall(r"^```json\n(.*?)^```", text, re.M | re.S)
    assert len(blocks) == 1
    return json.loads(blocks[0])


def test_the_template_s_example_parameters_follow_the_schema(tmp_path):
    example = template_example()
    assert parameter_errors(example) == []
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(example, rule_schema(), cls=jsonschema.Draft202012Validator)
    # and a rule frozen with it loads
    assert load_rule(write_rule(tmp_path / "rule", example))[0] == example


def test_the_template_has_the_eight_sections_and_names_every_key_of_the_schema():
    text = (ROOT / "docs" / "refresh-rule-template.md").read_text(encoding="utf-8")
    for heading in ("1. QUESTION", "2. PRECONDITIONS", "3. DATA", "4. GATE R", "5. GATE N", "6. OUTCOMES",
                    "7. HOW EACH GATE TRIPS IN PRACTICE", "8. EVIDENCE BEFORE FREEZING", "PARAMETERS: "):
        assert heading in text, heading
    schema = rule_schema()
    for key in [*schema["properties"], *schema["properties"]["newcard"]["properties"]]:
        assert f"`{key}`" in text, key
    for variant in schema["properties"]["newcard"]["properties"]["n3"]["enum"]:
        assert f'`"{variant}"`' in text, variant


def test_the_verdict_command(tmp_path, capsys):
    rule = write_rule(tmp_path / "rule", PARAMS)
    assert refresh(["verdict", "replay", str(replay_folder(tmp_path / "a")), "--rule", str(rule)]) == 0
    assert json.loads(capsys.readouterr().out.split("\n}\n")[0] + "\n}")["verdict"] == "PASS"
    assert refresh(["verdict", "replay", str(replay_folder(tmp_path / "b", {"real": lost("real-0")})), "--rule", str(rule)]) == 1
    folder = replay_folder(tmp_path / "c", exclude=("TOY-017",))
    assert refresh(["verdict", "replay", str(folder), "--rule", str(rule)]) == 3
    assert refresh(["verdict", "replay", str(folder), "--rule", str(rule), "--rehearsal"]) == 3  # too few compared
    assert json.loads((folder / "VERDICT-R.json").read_text())["rehearsal"] is True
    assert refresh(["verdict", "other", str(folder), "--rule", str(rule)]) == 2
    assert refresh(["verdict", "replay", str(folder)]) == 2
    assert refresh(["verdict", "replay", str(folder), "--rule", str(rule), "--base", "x"]) == 2
