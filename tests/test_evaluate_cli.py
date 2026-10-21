# SPDX-License-Identifier: Apache-2.0
"""``cardvision evaluate`` end to end: a synthetic manifest, generated frames, toy models.

The toy detector returns the same boxes for any image (see ``test_infer_toy_models``), so every
frame here is the same table of toy cards, and the labels decide what each event should be.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

import cardvision
from cardvision import cli
from cardvision.bank import build as bank_build
from cardvision.bank import release as release_module
from cardvision.bank.documents import canonical_bytes, read_json, sha256_hex
from cardvision.core.catalog import load_catalog
from cardvision.core.onnx import create_session
from cardvision.data.extract import frame_file_name
from cardvision.data.manifest import write_manifest
from cardvision.data.schema import Box, Point, Row
from cardvision.detect import INPUT_HEIGHT, INPUT_WIDTH
from cardvision.evaluate import open_configuration, read_rows, run_hover, spec_from_paths, spec_from_release
from cardvision.recognize import AcceptRule, Recognizer, load_accept
from cardvision.recognize import recognizer as recognizer_module
from test_infer_toy_models import (
    LEFT_OUT,
    SCENE_BACK,
    SCENE_SIZE,
    TOY_DELTA,
    TOY_TAU,
    ToySetup,
    build_bank,
    build_detector,
    detector_rows,
    save_image,
)

ROOT = Path(__file__).resolve().parents[1]
W, H = SCENE_SIZE


def quad(x, y, w, h):
    return ((x / W, y / H), ((x + w) / W, y / H), ((x + w) / W, (y + h) / H), (x / W, (y + h) / H))


def face(box, card_id, *, readable="yes", box_id=None):
    return Box(kind="face", quad=quad(*box), card_id=card_id, identity="named", readable=readable, id=box_id)


def row(video, group, source_type, *, role="evaluation", boxes=None, points=None, t=12.517):
    return Row(platform="youtube", video_id=video, t=t, frame_width=W, frame_height=H, source_type=source_type,
               group=group, role=role, trained_on=False, credit="tests",
               completeness="exhaustive-boxes" if boxes is not None else "points",
               boxes=None if boxes is None else tuple(boxes), points=None if points is None else tuple(points))


# The scene's cards (test_infer_toy_models.SCENE_CARDS) and what the toy pipeline shows on them:
#   TOY-001 at (40, 40)          named "Amber Circle"
#   TOY-003 at (320, 40), turned named "Coral Triangle"
#   TOY-012 at (700, 40)         nothing: the bank has no such card
#   TOY-015 at (980, 40)         nothing: TOY-016's bank row is a copy, so the margin is zero
#   TOY-017 at (40, 420)         named "Amber Stripes"
#   a back at (420, 420)         a back: never a hover candidate
#   TOY-005 at (1160, 420)       cut by the frame's edge: nothing
BOXED = [
    face((40, 40, 240, 336), "TOY-001", box_id="amber-circle"),          # right
    face((320, 40, 336, 240), "TOY-003A", box_id="coral-triangle"),      # right: another printing of the name
    face((700, 40, 240, 336), LEFT_OUT, box_id="left-out"),              # nothing
    face((980, 40, 240, 336), "TOY-015", box_id="copied"),               # nothing
    face((40, 420, 336, 240), "TOY-018", box_id="mislabeled"),          # labeled Azure Ring, shown Amber Stripes: wrong
    Box(kind="back", quad=quad(*SCENE_BACK), id="back"),                 # nothing
    face((1160, 420, 240, 336), "TOY-005", readable="no", box_id="cut"),  # outside every rate
    Box(kind="not-card", quad=quad(700, 450, 100, 100), id="table"),     # nothing
]
BOXED_POINTS = [
    Point(x=60 / W, y=60 / H, kind="not-card", id="edge-of-amber"),      # Amber Circle shown; its center is in the box: adjacent
    Point(x=60 / W, y=440 / H, kind="not-card", id="edge-of-stripes"),   # Amber Stripes shown; no such face labeled: wrong
    Point(x=260 / W, y=360 / H, kind="back", id="sleeve"),               # a name shown on a back: wrong
]
POINTS = [
    Point(x=160 / W, y=208 / H, kind="face", card_id="TOY-001", identity="named", readable="yes", id="amber"),   # right
    Point(x=1100 / W, y=208 / H, kind="face", card_id="TOY-015", identity="named", readable="maybe", id="copied"),  # nothing
    Point(x=0.5, y=0.99, kind="unreadable", id="blur"),
    Point(x=160 / W, y=100 / H, kind="face", card_id=None, identity="unknown", readable=None, id="who"),
]
ROWS = [
    row("VIDEOAAAAA1", "g-one", "digital/toy-client", boxes=BOXED, points=BOXED_POINTS),
    row("VIDEOBBBBB2", "g-two", "physical/webcam", points=POINTS),
    row("VIDEOCCCCC3", "g-three", "physical/webcam", boxes=BOXED[:2]),   # its frame is missing
    row("VIDEODDDDD4", "g-four", "digital/toy-client", role="train", boxes=BOXED[:1]),
]


class Evaluation:
    """The toy models, a manifest, a frames folder and a second bank."""

    def __init__(self, folder: Path, catalog_path: Path, art_dir: Path) -> None:
        (folder / "models").mkdir()
        self.toy = ToySetup(folder / "models", catalog_path, art_dir)
        self.manifest = folder / "labels" / "toy.manifest.jsonl"
        self.manifest.parent.mkdir()
        write_manifest(self.manifest, ROWS)
        self.frames = folder / "frames"
        self.frames.mkdir()
        for labeled in (ROWS[0], ROWS[1], ROWS[3]):
            save_image(self.frames / frame_file_name(labeled, ".png"), self.toy.frame)
        # A second bank: it has the card the first left out and its own row for TOY-016, and it
        # lacks TOY-001.
        self.other_bank = build_bank(folder / "models" / "other-bank.json", self.toy.recognizer, self.toy.catalog,
                                     self.toy.art_dir, leave_out=["TOY-001"])

    def arguments(self, *extra: str) -> list[str]:
        return ["--manifest", str(self.manifest), "--frames", str(self.frames), *self.toy.arguments(), *extra]


@pytest.fixture(scope="module")
def setup(tmp_path_factory, toy) -> Evaluation:
    return Evaluation(tmp_path_factory.mktemp("evaluate"), *toy)


def run(capsys, *arguments: str) -> tuple[int, str, str]:
    code = cli.main(["evaluate", *arguments])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def counts(found: dict) -> tuple[int, int]:
    return found["numerator"], found["denominator"]


def test_the_subcommand_is_registered(capsys):
    assert "evaluate" in cli.SUBCOMMANDS
    assert cli.main([]) == 0
    assert "evaluate" in capsys.readouterr().out


# -------------------------------------------------------------------------------------- hover
def test_hover_end_to_end(setup, capsys, tmp_path):
    out = tmp_path / "out"
    code, report, err = run(capsys, "hover", *setup.arguments("--out", str(out), "--bootstrap", "200", "--seed", "4"))
    assert code == 0, err
    result = json.loads((out / "evaluate-hover.json").read_text())
    assert (out / "evaluate-hover.md").read_text() == report
    assert (result["kind"], result["measure"], result["package"]["version"]) == ("cardvision-evaluation", "hover", cardvision.__version__)

    overall = result["results"]["overall"]
    assert overall["counts"] == {
        "faceRight": 3, "faceWrong": 1, "faceNothing": 3,
        "backShown": 1, "backNothing": 1,
        "offCardShownNonAdjacent": 1, "offCardShownAdjacent": 1, "offCardNothing": 1,
        "faceUnreadableShown": 0, "faceUnreadableNothing": 1, "faceUnnamedShown": 1, "faceUnnamedNothing": 0,
        "unreadableShown": 0, "unreadableNothing": 1,
    }
    assert counts(overall["namedRight"]) == (3, 7)
    assert counts(overall["wrongOfShown"]) == (3, 6)
    assert overall["groups"] == 2 and overall["namedRight"]["groupBootstrap95"]["groups"] == 2
    assert overall["wrongOfShown"]["exact95"]["side"] == "upper"
    assert list(result["results"]["bySourceType"]) == ["digital/toy-client", "physical/webcam"]
    assert counts(result["results"]["bySourceType"]["physical/webcam"]["namedRight"]) == (1, 2)
    assert counts(result["results"]["bySourceFamily"]["digital"]["wrongOfShown"]) == (3, 5)

    events = [json.loads(line) for line in (out / "evaluate-hover-events.jsonl").read_text().splitlines()]
    by_label = {(event["video_id"], event["label"]): event for event in events}
    assert by_label[("VIDEOAAAAA1", "coral-triangle")]["outcome"] == "right"
    assert by_label[("VIDEOAAAAA1", "coral-triangle")]["truth_id"] == "TOY-003A"
    assert by_label[("VIDEOAAAAA1", "coral-triangle")]["shown_id"] == "TOY-003"
    assert by_label[("VIDEOAAAAA1", "mislabeled")]["shown"] == "Amber Stripes"
    assert by_label[("VIDEOAAAAA1", "edge-of-amber")]["outcome"] == "adjacent"
    assert by_label[("VIDEOAAAAA1", "edge-of-stripes")]["outcome"] == "wrong"
    assert by_label[("VIDEOAAAAA1", "sleeve")]["outcome"] == "wrong"
    # The copied card's box is found and shows nothing: the box is recorded, the name is not.
    assert by_label[("VIDEOBBBBB2", "copied")]["shown"] is None and by_label[("VIDEOBBBBB2", "copied")]["box"] is not None
    assert len(events) == 15


def test_the_report_says_exactly_what_was_scored(setup, capsys):
    code, report, err = run(capsys, "hover", *setup.arguments("--bootstrap", "50"))
    assert code == 0, err
    result_files = {"detector": setup.toy.detector, "recognizer": setup.toy.recognizer, "bank": setup.toy.bank,
                    "catalog": setup.toy.catalog, "accept": setup.toy.accept, "manifest": setup.manifest}
    for path in result_files.values():
        assert sha256_hex(Path(path).read_bytes()) in report, path
        assert f"`{Path(path).name}`" in report
    assert f"accept rule: tau {TOY_TAU}, delta {TOY_DELTA}" in report
    assert "hover selection: accepted-nms (suppression overlap 0.3)" in report
    assert f"cardvision {cardvision.__version__}" in report
    assert "no identity groups file was given" in report
    assert "named right = right / (right + wrong + nothing), over readable faces" in report
    assert ("wrong of shown = (faces named wrong + names shown on backs + non-adjacent names shown on off-card "
            "positions) / (faces named right + those three)") in report
    assert "**named right**: 3 / 7 = 42.86 %; exact one-sided 95 % lower bound" in report
    assert "(assumes independent events); group bootstrap 95 % interval" in report
    assert "the interval to trust" not in report
    assert "it accounts for dependence within recordings" in report
    # Two groups: every interval of the toy set is marked as descriptive.
    assert "(2 groups, resamples whole recording groups). **Read as descriptive:** 2 recording groups" in report
    assert "bootstrap: 50 replicates, seed 0" in report
    # No folder of this machine is printed: files are given by name.
    assert str(setup.manifest.parent) not in report and str(setup.frames) not in report


def test_a_row_without_a_frame_is_listed_and_never_dropped_silently(setup, capsys, tmp_path):
    out = tmp_path / "out"
    code, report, err = run(capsys, "hover", *setup.arguments("--out", str(out), "--bootstrap", "20"))
    assert code == 0
    inputs = json.loads((out / "evaluate-hover.json").read_text())["inputs"]
    assert inputs["rowsRead"] == 4 and inputs["rowsUsed"] == 2 and inputs["framesPresent"] == 2
    assert inputs["rowsSkipped"] == {"role": 1} and inputs["rowsUnusable"] == {"frame-missing": 1}
    assert inputs["rowsNotScored"] == [{
        "platform": "youtube", "video_id": "VIDEOCCCCC3", "t": 12.517, "group": "g-three",
        "source_type": "physical/webcam", "reason": "frame-missing", "lost": {"face": 2},
    }]
    assert inputs["labelsNotScored"] == {"face": 2}
    assert "- rows unusable (not scored): frame-missing 1" in report
    assert "youtube VIDEOCCCCC3 t=12.517 (physical/webcam, group g-three): frame-missing; would have given face 2" in report
    assert "2 row(s) scored, 1 not scored (listed in the report)" in err


def test_a_frame_of_another_shape_is_unusable_not_scored(setup, capsys, tmp_path):
    frames = tmp_path / "frames"
    shutil.copytree(setup.frames, frames)
    save_image(frames / frame_file_name(ROWS[1], ".png"), np.zeros((500, 500, 3), dtype=np.uint8))
    arguments = ["--manifest", str(setup.manifest), "--frames", str(frames), *setup.toy.arguments(), "--bootstrap", "20",
                 "--out", str(tmp_path / "out")]
    code, report, _ = run(capsys, "hover", *arguments)
    assert code == 0
    inputs = json.loads((tmp_path / "out" / "evaluate-hover.json").read_text())["inputs"]
    assert inputs["rowsUnusable"] == {"frame-missing": 1, "frame-shape": 1} and inputs["rowsUsed"] == 1
    assert inputs["framesPresent"] == 2
    assert inputs["labelsNotScored"] == {"face": 4, "face-unnamed": 1, "unreadable": 1}


def test_another_role_selects_other_rows(setup, capsys, tmp_path):
    code, _, err = run(capsys, "hover", *setup.arguments("--role", "train", "--out", str(tmp_path), "--bootstrap", "20"))
    assert code == 0, err
    result = json.loads((tmp_path / "evaluate-hover.json").read_text())
    assert result["inputs"]["role"] == "train" and result["inputs"]["rowsSkipped"] == {"role": 3}
    assert counts(result["results"]["overall"]["namedRight"]) == (1, 1)
    assert result["results"]["overall"]["namedRight"]["groupBootstrap95"]["undefinedReason"] == "fewer than two recording groups"


def test_box_centers_inside_another_box_are_counted_and_the_totals_add_up(setup, capsys, tmp_path):
    # The boxed row again, with three more boxes: a not-card box lying on the first card, away
    # from that card's center, and a face and a back stacked so that each covers the other's center.
    extra = [
        Box(kind="not-card", quad=quad(60, 60, 60, 60), id="on-amber"),
        face((900, 500, 100, 140), "TOY-002", box_id="under"),
        Box(kind="back", quad=quad(910, 510, 100, 140), id="over"),
    ]
    stacked = row("VIDEOFFFFF6", "g-six", "digital/toy-client", boxes=[*BOXED, *extra], points=BOXED_POINTS)
    plain = row("VIDEOGGGGG7", "g-seven", "digital/toy-client", boxes=BOXED, points=BOXED_POINTS)
    points_only = row("VIDEOHHHHH8", "g-eight", "physical/webcam", points=POINTS)
    manifest = tmp_path / "stacked.manifest.jsonl"
    write_manifest(manifest, [stacked, plain, points_only])
    frames = tmp_path / "frames"
    frames.mkdir()
    for labeled in (stacked, plain, points_only):
        save_image(frames / frame_file_name(labeled, ".png"), setup.toy.frame)
    out = tmp_path / "out"
    code, report, err = run(capsys, "hover", "--manifest", str(manifest), "--frames", str(frames), *setup.toy.arguments(),
                            "--out", str(out), "--bootstrap", "20")
    assert code == 0, err
    result = json.loads((out / "evaluate-hover.json").read_text())
    inputs = result["inputs"]
    assert inputs["rowsUsed"] == 3 and inputs["labelsLeftOut"] == {"center-inside-another-box": 3}
    assert "- labels left out of used rows: center-inside-another-box 3" in report

    # The rule is in the definitions, as one sentence.
    definition = result["definitions"]["centerInsideAnotherBox"]
    assert definition.startswith("center inside another box = a box's center that lies inside another labeled box")
    assert f"- {definition}" in report.split("## Definitions")[1].split("## Results")[0]

    # Every labeled point and box is an event or is counted as left out, and the events are
    # the ones the results count.
    events = [json.loads(line) for line in (out / "evaluate-hover-events.jsonl").read_text().splitlines()]
    labeled_items = sum(len(item.boxes or ()) + len(item.points or ()) for item in (stacked, plain, points_only))
    assert labeled_items == 14 + 11 + 4
    assert len(events) + sum(inputs["labelsLeftOut"].values()) == labeled_items
    overall = result["results"]["overall"]
    assert overall["events"] == len(events) == 26 and sum(overall["counts"].values()) == len(events)
    assert sum(part["events"] for part in result["results"]["bySourceType"].values()) == len(events)

    # The stacked row's other events are scored exactly as the plain row's.
    def outcomes(video):
        return {(event["kind"], event["label"]): event["outcome"] for event in events if event["video_id"] == video}

    assert outcomes("VIDEOFFFFF6") == outcomes("VIDEOGGGGG7") and len(outcomes("VIDEOGGGGG7")) == 11
    assert not {"on-amber", "under", "over"} & {event["label"] for event in events}
    # The points row is untouched by the rule.
    assert len(outcomes("VIDEOHHHHH8")) == 4

    # The comparison of two configurations reads the same events and states the same rule.
    code, report, err = run(capsys, "compare", "--manifest", str(manifest), "--frames", str(frames),
                            *setup.toy.arguments(), "--other-bank", str(setup.other_bank), "--bootstrap", "20",
                            "--out", str(out))
    assert code == 0, err
    compared = json.loads((out / "evaluate-compare.json").read_text())
    assert compared["inputs"]["labelsLeftOut"] == {"center-inside-another-box": 3}
    assert compared["definitions"]["centerInsideAnotherBox"] == definition
    assert len((out / "evaluate-compare-events.jsonl").read_text().splitlines()) == 26


# -------------------------------------------------------------------------------------- crops
def test_crops_end_to_end(setup, capsys, tmp_path):
    code, report, err = run(capsys, "crops", *setup.arguments("--out", str(tmp_path), "--bootstrap", "50"))
    assert code == 0, err
    result = json.loads((tmp_path / "evaluate-crops.json").read_text())
    overall = result["results"]["overall"]
    # Five crops: Amber Circle and Coral Triangle named right; the mislabeled one named wrong; the
    # left-out card and the copied card rejected. The copied card's best row is still its own.
    assert overall["crops"] == 5
    assert counts(overall["top1Right"]) == (3, 5)
    assert counts(overall["namedRight"]) == (2, 5)
    assert counts(overall["namedWrong"]) == (1, 5)
    assert counts(overall["rejected"]) == (2, 5)
    assert counts(overall["wrongOfNamed"]) == (1, 3)
    inputs = result["inputs"]
    # The points row has no boxes; the boxed row without a frame is listed with its two crops.
    assert inputs["rowsSkipped"] == {"no-labels": 1, "role": 1} and inputs["rowsUsed"] == 1
    assert inputs["labelsLeftOut"] == {"unreadable": 1} and inputs["labelsNotScored"] == {"crop": 2}
    listed = [json.loads(line) for line in (tmp_path / "evaluate-crops-crops.jsonl").read_text().splitlines()]
    assert [(item["label"], item["truth"], item["topName"], item["name"]) for item in listed] == [
        ("amber-circle", "Amber Circle", "Amber Circle", "Amber Circle"),
        ("coral-triangle", "Coral Triangle", "Coral Triangle", "Coral Triangle"),
        ("left-out", "Amber Ring", listed[2]["topName"], None),
        ("copied", "Plum Triangle", "Plum Triangle", None),
        ("mislabeled", "Azure Ring", "Amber Stripes", "Amber Stripes"),
    ]
    assert listed[1]["look"] != 0 and listed[2]["topName"] != "Amber Ring"
    assert "**top-1 right**: 3 / 5 = 60.00 %" in report and "**wrong of named**: 1 / 3 = 33.33 %" in report


# ----------------------------------------------------------------------------------- detector
def test_detector_end_to_end(setup, capsys, tmp_path):
    code, report, err = run(capsys, "detector", *setup.arguments("--out", str(tmp_path), "--bootstrap", "50",
                                                                 "--fp-caps", "0.5,1"))
    assert code == 0, err
    result = json.loads((tmp_path / "evaluate-detector.json").read_text())
    found = result["results"]
    # One frame. Its six faces and its back are all found at the operating point; a weak box on
    # the table, scoring 0.2, is a false positive once the threshold reaches it. There is no
    # minimum score: the lowest threshold a cap can give is that box's own score.
    assert found["thresholds"]["operatingPoint"] == pytest.approx(0.3)
    assert found["thresholds"]["falsePositivesPerFrame<=0.5"] == pytest.approx(0.65)
    assert found["thresholds"]["falsePositivesPerFrame<=1"] == pytest.approx(0.2)
    assert "minScore" not in found and found["overlap"] == {"recall": "upright boxes", "ap50": "outline polygon"}
    overall = found["overall"]
    assert (overall["frames"], overall["faceTargets"], overall["backTargets"], overall["notCardBoxes"]) == (1, 6, 1, 1)
    at_op = overall["points"]["operatingPoint"]
    assert counts(at_op["recall"]) == (6, 6) and counts(at_op["falsePositivesPerFrame"]) == (0, 1)
    assert counts(at_op["backRecall"]) == (1, 1)
    assert counts(overall["points"]["falsePositivesPerFrame<=1"]["falsePositivesPerFrame"]) == (1, 1)
    assert overall["ap50"]["face"] == {"ap": pytest.approx(1.0), "targets": 6, "detections": 7, "truePositives": 6,
                                       "falsePositives": 1, "leftOut": 0}
    assert overall["ap50"]["back"]["ap"] == pytest.approx(1.0)
    inputs = result["inputs"]
    assert inputs["rowsSkipped"] == {"no-labels": 1, "role": 1} and inputs["rowsUnusable"] == {"frame-missing": 1}
    assert "**AP@0.5, face**: 1.0000 (6 targets, 7 detections: 6 true positives, 1 false positives, 0 left out)" in report
    # A cap's threshold is found on all frames together. Each line under a cap says that one
    # source alone can be above it; the operating point is a fixed threshold and says no such thing.
    assert "- at `operatingPoint` (score threshold 0.3):" in report
    assert ("- at `falsePositivesPerFrame<=0.5` (score threshold 0.65; found on all sources together, so one source alone "
            "can be above the cap):") in report
    assert report.count("so one source alone can be above the cap") == 2 * report.count("- at `operatingPoint`")
    assert "all-point interpolation" in report
    # The report says which overlap each result uses, and that no minimum score was applied.
    assert "Detections were read with no minimum score" in report
    assert "recall and false positives on upright boxes" in report and "AP@0.5 on the outline polygon" in report
    assert "with the polygon of the target's outline, not with the upright box around it" in report


def test_detector_reads_the_hand_row_rule_from_a_sources_file(setup, capsys, tmp_path):
    # A face in the bottom rows of a client that draws its hand cut off is squarer than a whole
    # card. Without the game's sources file it is an ignore region; with it, a target.
    hand = face((500, 548, 240, 220), "TOY-002", box_id="in-hand")   # 220 : 240, centered at 86 % of the height
    manifest = tmp_path / "hand.manifest.jsonl"
    labeled = row("VIDEOEEEEE5", "g-five", "digital/toy-client", boxes=[*BOXED, hand])
    write_manifest(manifest, [labeled])
    frames = tmp_path / "frames"
    frames.mkdir()
    save_image(frames / frame_file_name(labeled, ".png"), setup.toy.frame)
    sources = tmp_path / "sources.json"
    sources.write_text(json.dumps({"sourceTypes": ["digital/toy-client"],
                                   "handRow": {"sourceTypes": ["digital/toy-client"], "minCenterY": 0.85}}))
    found = {}
    for label, extra in (("without", []), ("with", ["--sources", str(sources)])):
        out = tmp_path / label
        code, _, err = run(capsys, "detector", "--manifest", str(manifest), "--frames", str(frames),
                           *setup.toy.arguments(), "--out", str(out), "--bootstrap", "10", *extra)
        assert code == 0, err
        found[label] = json.loads((out / "evaluate-detector.json").read_text())["results"]["overall"]
    assert (found["without"]["faceTargets"], found["without"]["ignoreRegions"]) == (6, 1)
    assert (found["with"]["faceTargets"], found["with"]["ignoreRegions"]) == (7, 0)
    assert counts(found["with"]["points"]["operatingPoint"]["recall"]) == (6, 7)


# ------------------------------------------------------------------------------------ compare
def test_compare_two_banks_end_to_end(setup, capsys, tmp_path):
    code, report, err = run(capsys, "compare", *setup.arguments("--other-bank", str(setup.other_bank), "--out",
                                                                str(tmp_path), "--bootstrap", "100"))
    assert code == 0, err
    result = json.loads((tmp_path / "evaluate-compare.json").read_text())
    assert result["base"]["files"]["bank"]["sha256"] == sha256_hex(setup.toy.bank.read_bytes())
    assert result["candidate"]["files"]["bank"]["sha256"] == sha256_hex(setup.other_bank.read_bytes())
    assert result["candidate"]["files"]["detector"] == result["base"]["files"]["detector"]
    assert result["candidate"]["accept"] == result["base"]["accept"]
    overall = result["results"]["overall"]
    moves = overall["transitions"]
    # The candidate bank lacks TOY-001 (two faces go right -> nothing, and the names it showed
    # on a back and beside the card go away) and gains the two cards the base could not name.
    assert moves["events"] == 12
    assert moves["table"] == {"nothing -> nothing": 3, "nothing -> right": 3, "right -> nothing": 2,
                              "right -> right": 1, "wrong -> nothing": 1, "wrong -> wrong": 2}
    assert moves["regressions"] == 2
    assert [item["key"].split("/", 1)[1] for item in moves["regressingEvents"]] == ["center/amber-circle", "point/amber"]
    paired = overall["paired"]
    assert paired["namedRight"]["base"] == pytest.approx(3 / 7) and paired["namedRight"]["candidate"] == pytest.approx(4 / 7)
    assert paired["wrongOfShown"]["base"] == pytest.approx(3 / 6) and paired["wrongOfShown"]["candidate"] == pytest.approx(2 / 6)
    assert counts(overall["candidate"]["namedRight"]) == (4, 7)
    assert "| right -> nothing | 2 |" in report and "- **regressions**: 2" in report
    assert "### Base configuration" in report and "### Candidate configuration" in report
    events = [json.loads(line) for line in (tmp_path / "evaluate-compare-events.jsonl").read_text().splitlines()]
    assert len(events) == 15 and events[0]["candidate"]["outcome"] in ("right", "wrong", "nothing", "adjacent", "shown")


def test_compare_needs_a_candidate_and_other_measures_refuse_one(setup, capsys):
    code, _, err = run(capsys, "compare", *setup.arguments())
    assert code == 2 and "compare needs a candidate" in err
    code, _, err = run(capsys, "hover", *setup.arguments("--other-bank", str(setup.other_bank)))
    assert code == 2 and "have no meaning for hover" in err


# ------------------------------------------------------------------------------------ release
def write_release(root: Path, setup: Evaluation, boxes, scores, classes, accept: dict, settings: dict | None = None) -> Path:
    """A release document over toy parts, in ``root``: the given boxes from a detector with a
    full set of anchors, a bank built by the bank tool, and the given accept rule."""
    shutil.copy(setup.toy.catalog, root / "catalog.json")
    shutil.copy(setup.toy.recognizer, root / "recognizer.onnx")
    anchors = release_module.yolox_anchor_count(INPUT_WIDTH, INPUT_HEIGHT)
    rows = np.zeros((anchors, 7), dtype=np.float32)
    rows[:len(boxes)] = detector_rows(boxes, scores, classes)
    build_detector(root / "detector.onnx", rows)
    catalog = load_catalog(root / "catalog.json")
    bank = bank_build.build_bank(catalog, setup.toy.art_dir, create_session(root / "recognizer.onnx"), model="toy").bank
    bank_build.write_bank(bank, catalog, root / "bank.json")
    release_module.build_release(
        root / "release.json", detector=root / "detector.onnx", recognizer=root / "recognizer.onnx",
        bank=root / "bank.json", catalog=root / "catalog.json", accept=accept, settings=settings,
    )
    return root


@pytest.fixture(scope="module")
def release(setup, tmp_path_factory) -> Path:
    """A release whose detector reports the scene's first card and its back, with a loose accept
    rule and another hover selection than the default."""
    return write_release(tmp_path_factory.mktemp("release"), setup, [(40, 40, 240, 336), (420, 420, 240, 336)],
                         [0.9, 0.8], [0, 1], {"tau": 0.9, "delta": 0.01, "rotationRetry": True},
                         {"hover": {"selection": "detector-score"}})


def test_a_release_document_pins_everything(setup, release, capsys, tmp_path):
    arguments = ["--manifest", str(setup.manifest), "--frames", str(setup.frames), "--release", str(release / "release.json"),
                 "--out", str(tmp_path), "--bootstrap", "20"]
    code, report, err = run(capsys, "hover", *arguments)
    assert code == 0, err
    result = json.loads((tmp_path / "evaluate-hover.json").read_text())
    doc = read_json(release / "release.json")
    described = result["configuration"]
    assert described["release"] == doc["id"]
    assert set(described["files"]) == {"release", "detector", "recognizer", "bank", "identityGroups", "catalog"}
    for label, block in (("detector", doc["detector"]), ("recognizer", doc["recognizer"]), ("bank", doc["bank"]),
                         ("identityGroups", doc["identity"]["groups"]), ("catalog", doc["catalog"])):
        assert described["files"][label]["sha256"] == block["sha256"]
    assert described["accept"] == {"tau": 0.9, "delta": 0.01, "rotationRetry": True}
    assert described["hover"] == {"selection": "detector-score"}
    assert f"release document id: `{doc['id']}`" in report and "hover selection: detector-score" in report
    # Amber Circle is the only face this detector reports, and both rows label its center.
    assert counts(result["results"]["overall"]["namedRight"])[0] == 2


def test_release_and_explicit_files_do_not_mix_and_a_broken_release_is_refused(setup, release, capsys, tmp_path):
    base = ["--manifest", str(setup.manifest), "--frames", str(setup.frames)]
    code, _, err = run(capsys, "hover", *base, "--release", str(release / "release.json"), "--bank", str(setup.toy.bank))
    assert code == 2 and "do not also give --bank" in err
    code, _, err = run(capsys, "hover", *base, "--detector", str(setup.toy.detector))
    assert code == 2 and "missing --recognizer, --bank, --catalog" in err

    broken = Path(shutil.copytree(release, tmp_path / "broken"))
    (broken / "bank.json").write_bytes((broken / "bank.json").read_bytes() + b"\n")
    code, _, err = run(capsys, "hover", *base, "--release", str(broken / "release.json"))
    assert code == 2 and "the release cannot be used" in err

    # A valid release that asks for something the reference pipeline does not do is refused too.
    unsupported = Path(shutil.copytree(release, tmp_path / "unsupported"))
    doc = read_json(unsupported / "release.json")
    doc["detector"]["decode"]["nms"]["classAgnostic"] = False
    (unsupported / "release.json").write_bytes(canonical_bytes(release_module.with_id(doc)))
    code, _, err = run(capsys, "hover", *base, "--release", str(unsupported / "release.json"))
    assert code == 2 and "this release cannot be used here" in err and "classAgnostic is false" in err


# ---------------------------------------------------------------------------- the accept rule
# The scene's second card lies on its side: it is named only after the turned looks are tried.
# An accept rule with "rotationRetry": false must therefore leave it unnamed, in every measure.
def accept_file(folder: Path, retry: bool) -> Path:
    path = folder / f"accept-{'retry' if retry else 'upright'}.json"
    path.write_text(json.dumps({"tau": TOY_TAU, "delta": TOY_DELTA, "rotationRetry": retry}), encoding="utf-8")
    return path


class Watch:
    """What every call of the recognizer was asked and what it embedded.

    One entry per call of ``Recognizer.recognize`` with crops: whether that recognizer's rule
    allows the retry, the number of crops, the number of tensors embedded during the call, the
    number of embedding batches (calls of ``run_batched``), and how many results say the turned
    looks were tried.
    """

    def __init__(self, monkeypatch) -> None:
        self.calls: list[tuple[bool, int, int, int, int]] = []
        self._embedded = self._batches = 0
        run_batched, recognize = recognizer_module.run_batched, Recognizer.recognize

        def counted_run(session, tensors, *args, **kwargs):
            self._batches += 1
            self._embedded += len(tensors)
            return run_batched(session, tensors, *args, **kwargs)

        def counted_recognize(recognizer, crops):
            embedded, batches = self._embedded, self._batches
            found = recognize(recognizer, crops)
            if len(crops):
                self.calls.append((recognizer.rule.rotation_retry, len(crops), self._embedded - embedded,
                                   self._batches - batches, sum(item.retried for item in found)))
            return found

        monkeypatch.setattr(recognizer_module, "run_batched", counted_run)
        monkeypatch.setattr(Recognizer, "recognize", counted_recognize)

    def of(self, retry: bool) -> list[tuple[int, int, int, int]]:
        return [call[1:] for call in self.calls if call[0] is retry]

    def assert_no_turned_look_without_the_flag(self) -> None:
        """Under a rule without the retry: one batch per call, one tensor per crop, no result
        marked as retried."""
        for crops, embedded, batches, retried in self.of(False):
            assert (embedded, batches, retried) == (crops, 1, 0)


def test_the_accept_help_names_the_three_keys(capsys):
    with pytest.raises(SystemExit):
        cli.main(["evaluate", "--help"])
    text = " ".join(capsys.readouterr().out.split())
    assert '{"tau": ..., "delta": ..., "rotationRetry": ...}' in text


def test_a_spec_holds_the_rule_as_the_one_reader_returned_it(setup, tmp_path):
    parts = (setup.toy.detector, setup.toy.recognizer, setup.toy.bank, setup.toy.catalog)
    assert spec_from_paths(*parts).rule == AcceptRule()
    for retry in (True, False):
        path = accept_file(tmp_path, retry)
        expected = AcceptRule(tau=TOY_TAU, delta=TOY_DELTA, rotation_retry=retry)
        assert load_accept(path) == expected
        assert spec_from_paths(*parts, path).rule == expected
        replaced = spec_from_paths(*parts).replacing(accept=path)
        assert replaced.rule == expected and replaced.accept_file == path
        config = open_configuration(spec_from_paths(*parts, path))
        assert config.pipeline.recognizer.rule == expected and config.describe()["accept"] == expected.to_json()
    # The reader is strict: the older file of two keys is refused, not read with a default.
    two_keys = tmp_path / "two-keys.json"
    two_keys.write_text(json.dumps({"tau": TOY_TAU, "delta": TOY_DELTA}), encoding="utf-8")
    with pytest.raises(ValueError, match="two-keys.json.rotationRetry must be true or false"):
        spec_from_paths(*parts, two_keys)


def test_an_accept_file_of_two_keys_is_an_error_of_the_command(setup, capsys, tmp_path):
    two_keys = tmp_path / "two-keys.json"
    two_keys.write_text(json.dumps({"tau": TOY_TAU, "delta": TOY_DELTA}), encoding="utf-8")
    arguments = setup.arguments()
    arguments[arguments.index("--accept") + 1] = str(two_keys)
    code, _, err = run(capsys, "hover", *arguments)
    assert code == 2 and "rotationRetry must be true or false" in err


@pytest.mark.parametrize("retry", [True, False])
def test_an_accept_file_with_either_rotation_retry_is_honored_and_reported(setup, capsys, tmp_path, monkeypatch, retry):
    arguments = setup.arguments("--bootstrap", "20")
    arguments[arguments.index("--accept") + 1] = str(accept_file(tmp_path, retry))
    expected = {"tau": TOY_TAU, "delta": TOY_DELTA, "rotationRetry": retry}
    looks = "the turned looks retried" if retry else "the turned looks not tried (upright looks only)"
    watch = Watch(monkeypatch)

    code, report, err = run(capsys, "hover", *arguments, "--out", str(tmp_path / "hover"))
    assert code == 0, err
    result = json.loads((tmp_path / "hover" / "evaluate-hover.json").read_text())
    assert result["configuration"]["accept"] == expected
    assert f"- accept rule: tau {TOY_TAU}, delta {TOY_DELTA}, {looks}" in report
    events = [json.loads(line) for line in (tmp_path / "hover" / "evaluate-hover-events.jsonl").read_text().splitlines()]
    by_label = {(event["video_id"], event["label"]): event["outcome"] for event in events}
    assert by_label[("VIDEOAAAAA1", "amber-circle")] == "right"
    assert by_label[("VIDEOAAAAA1", "coral-triangle")] == ("right" if retry else "nothing")
    assert counts(result["results"]["overall"]["namedRight"]) == ((3, 7) if retry else (2, 7))

    code, report, err = run(capsys, "crops", *arguments, "--out", str(tmp_path / "crops"))
    assert code == 0, err
    result = json.loads((tmp_path / "crops" / "evaluate-crops.json").read_text())
    assert result["configuration"]["accept"] == expected and looks in report
    listed = {item["label"]: item for item in
              map(json.loads, (tmp_path / "crops" / "evaluate-crops-crops.jsonl").read_text().splitlines())}
    assert listed["amber-circle"]["name"] == "Amber Circle" and listed["amber-circle"]["look"] == 0
    if retry:
        assert listed["coral-triangle"]["name"] == "Coral Triangle" and listed["coral-triangle"]["look"] != 0
    else:
        assert listed["coral-triangle"]["name"] is None and all(item["look"] == 0 for item in listed.values())
    assert counts(result["results"]["overall"]["namedRight"]) == ((2, 5) if retry else (1, 5))

    code, report, err = run(capsys, "detector", *arguments, "--out", str(tmp_path / "detector"))
    assert code == 0, err
    assert json.loads((tmp_path / "detector" / "evaluate-detector.json").read_text())["configuration"]["accept"] == expected
    assert looks in report

    # Three calls of the recognizer: two frames for hover, one for crops; the detector measure
    # never asks it.
    assert len(watch.of(retry)) == 3 and watch.of(not retry) == []
    watch.assert_no_turned_look_without_the_flag()


def test_evaluation_never_embeds_a_turned_look_when_the_rule_forbids_it(setup, capsys, tmp_path, monkeypatch):
    """Every measure, counted at the embedding model: with ``rotationRetry`` false a call of the
    recognizer embeds exactly its crops, in one batch. The same count with the retry on is
    larger, which shows that the count would catch a retry."""
    upright, turning = accept_file(tmp_path, False), accept_file(tmp_path, True)
    arguments = setup.arguments("--bootstrap", "20")
    arguments[arguments.index("--accept") + 1] = str(upright)
    watch = Watch(monkeypatch)
    for measure in ("hover", "crops", "detector"):
        code, _, err = run(capsys, measure, *arguments)
        assert code == 0, err
    code, _, err = run(capsys, "compare", *arguments, "--other-bank", str(setup.other_bank))
    assert code == 0, err
    # hover 2 frames, crops 1, compare 2 frames under each of two configurations.
    assert len(watch.of(False)) == 7 and watch.of(True) == []
    assert [(embedded, batches, retried) for _, embedded, batches, retried in watch.of(False)] \
        == [(crops, 1, 0) for crops, _, _, _ in watch.of(False)]
    watch.assert_no_turned_look_without_the_flag()

    # A comparison of the two rules: the base retries, the candidate does not, on the same frames.
    watch.calls.clear()
    out = tmp_path / "compare"
    arguments[arguments.index("--accept") + 1] = str(turning)
    code, report, err = run(capsys, "compare", *arguments, "--other-accept", str(upright), "--out", str(out))
    assert code == 0, err
    result = json.loads((out / "evaluate-compare.json").read_text())
    assert result["base"]["accept"]["rotationRetry"] is True and result["candidate"]["accept"]["rotationRetry"] is False
    assert result["candidate"]["files"]["accept"]["file"] == upright.name
    assert "the turned looks retried" in report and "the turned looks not tried (upright looks only)" in report
    moves = result["results"]["overall"]["transitions"]
    assert moves["regressions"] == 1 and moves["regressingEvents"][0]["key"].endswith("center/coral-triangle")
    assert moves["regressingEvents"][0]["transition"] == "right -> nothing"
    assert len(watch.of(True)) == 2 and len(watch.of(False)) == 2
    watch.assert_no_turned_look_without_the_flag()
    retried = watch.of(True)
    assert all(embedded > crops and batches == 2 and tried > 0 for crops, embedded, batches, tried in retried)


@pytest.mark.parametrize("retry", [True, False])
def test_a_release_with_either_rotation_retry_is_evaluated_as_it_says(setup, capsys, tmp_path, monkeypatch, retry):
    # The detector of this release reports the upright card and the one lying on its side.
    root = tmp_path / "release"
    root.mkdir()
    accept = {"tau": TOY_TAU, "delta": TOY_DELTA, "rotationRetry": retry}
    write_release(root, setup, [(40, 40, 240, 336), (320, 40, 336, 240)], [0.9, 0.8], [0, 0], accept)
    spec = spec_from_release(root / "release.json")
    assert spec.rule == AcceptRule(tau=TOY_TAU, delta=TOY_DELTA, rotation_retry=retry)
    watch = Watch(monkeypatch)
    base = ["--manifest", str(setup.manifest), "--frames", str(setup.frames), "--release", str(root / "release.json"),
            "--bootstrap", "20"]
    looks = "the turned looks retried" if retry else "the turned looks not tried (upright looks only)"

    code, report, err = run(capsys, "hover", *base, "--out", str(tmp_path / "hover"))
    assert code == 0, err
    result = json.loads((tmp_path / "hover" / "evaluate-hover.json").read_text())
    assert result["configuration"]["accept"] == accept == read_json(root / "release.json")["accept"]
    assert f"- accept rule: tau {TOY_TAU}, delta {TOY_DELTA}, {looks}" in report
    events = [json.loads(line) for line in (tmp_path / "hover" / "evaluate-hover-events.jsonl").read_text().splitlines()]
    by_label = {(event["video_id"], event["label"]): event["outcome"] for event in events}
    assert by_label[("VIDEOAAAAA1", "amber-circle")] == "right"
    assert by_label[("VIDEOAAAAA1", "coral-triangle")] == ("right" if retry else "nothing")

    code, report, err = run(capsys, "crops", *base, "--out", str(tmp_path / "crops"))
    assert code == 0, err
    result = json.loads((tmp_path / "crops" / "evaluate-crops.json").read_text())
    assert result["configuration"]["accept"] == accept and looks in report
    listed = {item["label"]: item for item in
              map(json.loads, (tmp_path / "crops" / "evaluate-crops-crops.jsonl").read_text().splitlines())}
    assert (listed["coral-triangle"]["name"], listed["coral-triangle"]["look"] != 0) \
        == (("Coral Triangle", True) if retry else (None, False))

    assert len(watch.of(retry)) == 3 and watch.of(not retry) == []
    watch.assert_no_turned_look_without_the_flag()
    if retry:
        assert any(embedded > crops for crops, embedded, _, _ in watch.of(True))


# --------------------------------------------------------------------------------- the rest
def test_missing_inputs_are_reported(setup, capsys, tmp_path):
    code, _, err = run(capsys, "hover", "--manifest", str(tmp_path / "none.jsonl"), "--frames", str(setup.frames),
                       *setup.toy.arguments())
    assert code == 2 and "no such manifest file" in err
    code, _, err = run(capsys, "hover", "--manifest", str(setup.manifest), "--frames", str(tmp_path / "none"),
                       *setup.toy.arguments())
    assert code == 2 and "no such folder of frames" in err
    code, _, err = run(capsys, "detector", *setup.arguments("--fp-caps", "one"))
    assert code == 2 and "--fp-caps" in err
    twice = ["--manifest", str(setup.manifest), str(setup.manifest), "--frames", str(setup.frames), *setup.toy.arguments()]
    code, _, err = run(capsys, "hover", *twice)
    assert code == 2 and "is given twice" in err


def test_the_library_gives_the_same_events_as_the_command(setup):
    rows, account = read_rows([setup.manifest])
    config = open_configuration(spec_from_paths(setup.toy.detector, setup.toy.recognizer, setup.toy.bank,
                                                setup.toy.catalog, setup.toy.accept))
    scored = run_hover(rows, setup.frames, config, account)
    assert len(scored) == 15 and account.used == 2 and account.unusable == {"frame-missing": 1}
    assert account.labels_skipped == {}
    assert sum(item.outcome == "right" for item in scored) == 3


def test_the_installed_program_runs_it(setup, tmp_path):
    done = subprocess.run([sys.executable, "-m", "cardvision", "evaluate", "hover", *setup.arguments("--bootstrap", "20")],
                          capture_output=True, text=True, cwd=ROOT)
    assert done.returncode == 0, done.stderr
    assert done.stdout.startswith("# Evaluation: hover events")
    assert "2 row(s) scored, 1 not scored" in done.stderr
