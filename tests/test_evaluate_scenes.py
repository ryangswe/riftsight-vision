# SPDX-License-Identifier: Apache-2.0
"""``cardvision evaluate --scenes``: generated scenes scored by their exact labels.

Three things are checked on scenes of the toy game, made with fixed seeds:

* a case small enough to check by hand, where the stand-in models are right on a known number
  of cards;
* that the scenes scored through ``--scenes`` and through a manifest written by hand from the
  same labels give the same figures;
* that a folder which is not the generator's, or whose labels fail its check, is refused.
"""

from __future__ import annotations

import dataclasses
import json
import shutil
from pathlib import Path

import pytest

from cardvision import cli
from cardvision.composites import generate, read_labels
from cardvision.core.catalog import load_catalog
from cardvision.core.images import load_rgb
from cardvision.data.extract import frame_file_name
from cardvision.data.manifest import write_manifest
from cardvision.data.schema import Box, Row
from cardvision.evaluate import crop_results, detector_results, hover_results, open_configuration, spec_from_paths
from cardvision.evaluate import run_crops, run_detector, run_hover
from cardvision.evaluate.scenes import GROUP, NOTE, SOURCE_TYPE, ScenesError, read_scenes
from cardvision.recognize import AcceptRule
from test_infer_toy_models import ToySetup, build_bank, build_detector, build_recognizer, detector_rows

# ------------------------------------------------------------------- the case to check by hand
# One scene (split val, seed 22): a table 1920 x 1080 px with 16 faces, 3 backs, 3 distractors
# and 2 hands. Two of the faces show less than half of themselves, so 14 are faces a detector
# should find.
#
# The stand-in detector is given the boxes of the cards that stand clear of everything else in
# the scene: 5 faces and 1 back. It reports all six as faces, so the back is a detector's
# mistake. The bank holds one card, Slate Stripes, and the accept rule accepts every look, so
# every box the detector reports is named Slate Stripes. Three of the five clear faces are
# Slate Stripes. So, without running anything:
#
#   faces   right 3 (the clear Slate Stripes), wrong 2 (the other clear faces), nothing on the
#           other 9 of the 14
#   backs   a name shown on 1 (the clear back). The other two lie one on the other: the lower
#           shows 6 % of itself, so it is an ignore region, and the center of the upper falls
#           inside the lower's outline, so it gives no event
#   left out: 3 ignore regions (2 faces, 1 back) and 1 center inside another box
HAND_SEED = 22
THE_ONE_CARD = "TOY-011"  # Slate Stripes
CLEAR_FACES, CLEAR_FACES_OF_THE_CARD, CLEAR_BACKS = 5, 3, 1
FACES, FACES_MOSTLY_HIDDEN, BACKS = 16, 2, 3


def touches(a, b, gap: float = 2.0) -> bool:
    """Whether two ``[x0, y0, x1, y1]`` boxes overlap or come within ``gap`` px of each other."""
    return min(a[2], b[2]) > max(a[0], b[0]) - gap and min(a[3], b[3]) > max(a[1], b[1]) - gap


def stands_clear(found, scene) -> bool:
    """A card that lies wholly inside the frame, at least 40 px each way, shows all of itself
    (97 % or more, by the generator's figure) and touches no other labeled object of its scene."""
    x0, y0, x1, y1 = found["box"]
    inside = x0 > 0 and y0 > 0 and x1 < scene["width"] and y1 < scene["height"]
    return inside and x1 - x0 >= 40 and y1 - y0 >= 40 and found["visible"] >= 0.97 \
        and not any(touches(found["box"], other["box"]) for other in scene["objects"] if other is not found)


class HandCase:
    """The scene, the stand-in models described above, and the configuration that holds them."""

    def __init__(self, folder: Path, catalog_path: Path, art_dir: Path) -> None:
        self.scenes = folder / "scenes"
        catalog = load_catalog(catalog_path)
        generate(catalog, art_dir, self.scenes, 1, seed=HAND_SEED, split="val")
        self.scene = read_labels(self.scenes)[0]
        self.names = catalog.names()
        cards = [found for found in self.scene["objects"] if found["kind"] in ("face", "back")]
        self.faces = [found for found in cards if found["kind"] == "face"]
        self.backs = [found for found in cards if found["kind"] == "back"]
        self.clear = [found for found in cards if (found["kind"] == "back" or found["positive"])
                      and stands_clear(found, self.scene)]
        boxes = [(x0, y0, x1 - x0, y1 - y0) for x0, y0, x1, y1 in (found["box"] for found in self.clear)]
        scores = [0.9 - 0.01 * index for index in range(len(boxes))]
        size = (self.scene["width"], self.scene["height"])
        detector = build_detector(folder / "detector.onnx", detector_rows(boxes, scores, [0] * len(boxes), size))
        recognizer = build_recognizer(folder / "recognizer.onnx")
        bank = build_bank(folder / "bank.json", recognizer, catalog_path, art_dir,
                          leave_out=[card.id for card in catalog if card.id != THE_ONE_CARD])
        spec = spec_from_paths(detector, recognizer, bank, catalog_path)
        # An accept rule that accepts every look: no file can state it, so it is set on the spec.
        self.config = open_configuration(dataclasses.replace(spec, rule=AcceptRule(tau=-1.0, delta=0.0)))


@pytest.fixture(scope="module")
def hand(tmp_path_factory, toy) -> HandCase:
    return HandCase(tmp_path_factory.mktemp("scenes-by-hand"), *toy)


def test_the_scene_is_the_one_the_hand_check_describes(hand):
    assert (hand.scene["width"], hand.scene["height"], hand.scene["layout"]) == (1920, 1080, "table")
    assert (len(hand.faces), len(hand.backs)) == (FACES, BACKS)
    assert sum(found["ignore"] == "lowvis" for found in hand.faces) == FACES_MOSTLY_HIDDEN
    assert sum(found["ignore"] == "small" for found in hand.faces) == 0
    clear_faces = [found for found in hand.clear if found["kind"] == "face"]
    assert (len(clear_faces), len(hand.clear) - len(clear_faces)) == (CLEAR_FACES, CLEAR_BACKS)
    assert sum(found["cardId"] == THE_ONE_CARD for found in clear_faces) == CLEAR_FACES_OF_THE_CARD


def test_inference_names_every_box_the_stand_in_detector_reports(hand):
    """What ``cardvision infer`` does with the scene: six boxes, all faces, all named the one card."""
    result = hand.config.pipeline.analyze(load_rgb(hand.scenes / hand.scene["file"]))
    assert len(result.cards) == len(result.faces) == CLEAR_FACES + CLEAR_BACKS
    assert {card.recognition.name for card in result.faces} == {"Slate Stripes"}
    assert all(card.recognition.accepted for card in result.faces)


def test_hover_figures_are_the_ones_worked_out_by_hand(hand):
    rows, account, frames = read_scenes(hand.scenes, hand.config.catalog)
    scored = run_hover(rows, frames, hand.config, account)
    part = hover_results(scored, seed=0, replicates=20)["overall"]
    counts = part["counts"]
    assert (counts["faceRight"], counts["faceWrong"]) == (CLEAR_FACES_OF_THE_CARD, CLEAR_FACES - CLEAR_FACES_OF_THE_CARD)
    assert (counts["faceNothing"], counts["backShown"], counts["backNothing"]) == (9, CLEAR_BACKS, 0)
    assert account.labels_skipped == {"ignore-region": FACES_MOSTLY_HIDDEN + 1, "center-inside-another-box": 1}
    # Every card of the scene is an event or is counted as left out, and nothing else is an event.
    left_out = account.labels_skipped
    face_events = counts["faceRight"] + counts["faceWrong"] + counts["faceNothing"]
    back_events = counts["backShown"] + counts["backNothing"]
    assert part["events"] == face_events + back_events
    assert face_events + back_events + sum(left_out.values()) == FACES + BACKS
    # The rates are the scorer's own, from those counts.
    assert (part["namedRight"]["numerator"], part["namedRight"]["denominator"]) == (CLEAR_FACES_OF_THE_CARD, face_events)
    wrong = CLEAR_FACES - CLEAR_FACES_OF_THE_CARD + CLEAR_BACKS
    assert (part["wrongOfShown"]["numerator"], part["wrongOfShown"]["denominator"]) == (wrong, wrong + CLEAR_FACES_OF_THE_CARD)
    # One recording group: no group bootstrap interval, and a reason for it.
    assert part["groups"] == 1 and part["namedRight"]["groupBootstrap95"]["low"] is None
    assert part["namedRight"]["groupBootstrap95"]["undefinedReason"] == "fewer than two recording groups"
    # Each event is right, wrong or nothing by its own label.
    clear = {str(found["id"]): found for found in hand.clear}
    for item in scored:
        found = clear.get(item.event.label)
        if found is None:
            assert (item.outcome, item.shown) == ("nothing", None)
        elif found["kind"] == "back":
            assert (item.event.role, item.outcome, item.shown) == ("back", "wrong", "Slate Stripes")
        else:
            assert item.outcome == ("right" if found["cardId"] == THE_ONE_CARD else "wrong")
            assert (item.shown, item.event.truth) == ("Slate Stripes", hand.names[found["cardId"]])
    assert sum(item.event.label in clear for item in scored) == len(clear)


def test_crop_figures_are_the_ones_worked_out_by_hand(hand):
    """The recognizer alone names every labeled face Slate Stripes: right on the faces that are."""
    rows, account, frames = read_scenes(hand.scenes, hand.config.catalog)
    found = run_crops(rows, frames, hand.config, account)
    part = crop_results(found, seed=0, replicates=20)["overall"]
    wanted = [face for face in hand.faces if face["positive"]]
    assert part["crops"] == len(wanted) == FACES - FACES_MOSTLY_HIDDEN
    assert account.labels_skipped == {"ignore-region": FACES_MOSTLY_HIDDEN}
    # Slate Stripes is on the table three times, and all three stand clear.
    of_the_card = sum(face["cardId"] == THE_ONE_CARD for face in wanted)
    assert of_the_card == CLEAR_FACES_OF_THE_CARD
    assert part["namedRight"]["numerator"] == part["top1Right"]["numerator"] == of_the_card
    assert part["namedWrong"]["numerator"] == len(wanted) - of_the_card
    assert part["rejected"]["numerator"] == 0
    assert {item.label for item in found} == {str(face["id"]) for face in wanted}


def test_detector_figures_are_the_ones_worked_out_by_hand(hand):
    """Five faces found, and the box on the back is a false positive on a back."""
    rows, account, frames = read_scenes(hand.scenes, hand.config.catalog)
    records = run_detector(rows, frames, hand.config, account)
    part = detector_results(records, hand.config.spec.threshold, seed=0, replicates=20)["overall"]
    assert (part["frames"], part["notCardBoxes"]) == (1, 0)
    assert (part["faceTargets"], part["backTargets"], part["ignoreRegions"]) == (FACES - FACES_MOSTLY_HIDDEN, 2, 3)
    point = part["points"]["operatingPoint"]
    assert (point["recall"]["numerator"], point["recall"]["denominator"]) == (CLEAR_FACES, part["faceTargets"])
    assert point["falsePositivesPerFrame"]["numerator"] == point["falsePositivesOnBacks"] == CLEAR_BACKS
    assert (point["backRecall"]["numerator"], point["backRecall"]["denominator"]) == (0, 2)


def test_a_mostly_hidden_or_tiny_card_is_an_ignore_region(hand):
    """The rule, on the rows: a face by the generator's own mark, a back by the same two limits."""
    rows, account, _ = read_scenes(hand.scenes, hand.config.catalog)
    (row,) = rows
    assert (row.completeness, row.source_type, row.group, row.platform) == ("exhaustive-boxes", SOURCE_TYPE, GROUP, "local")
    assert (row.frame_width, row.frame_height, row.points) == (1920, 1080, None)
    boxes = {box.id: box for box in row.boxes}
    assert len(boxes) == len(row.boxes) == FACES + BACKS
    for found in hand.faces:
        box = boxes[str(found["id"])]
        assert (box.kind, box.card_id, box.identity, box.readable) == ("face", found["cardId"], "named", None)
        assert box.ignore == (found["visible"] < 0.5 or found["short"] < 20) == (not found["positive"])
    for found in hand.backs:
        box = boxes[str(found["id"])]
        assert (box.kind, box.card_id) == ("back", None)
        assert box.ignore == (found["visible"] < 0.5 or found["short"] < 20)
    for found in hand.faces + hand.backs:
        corners = [(x / 1920, y / 1080) for x, y in found["corners"]]
        # One approx per corner: pytest 9.2 refuses approx() on a list of pairs.
        assert list(boxes[str(found["id"])].quad) == [pytest.approx(corner) for corner in corners]
    # Nothing that is not a card has a box.
    assert sum(found["kind"] not in ("face", "back") for found in hand.scene["objects"]) == 5
    assert account.role is None and account.read == 1
    assert account.scenes["boxes"] == {"faces": FACES, "backs": BACKS, "ignoredFaces": FACES_MOSTLY_HIDDEN,
                                       "ignoredBacks": sum(box.ignore for box in row.boxes if box.kind == "back")}
    assert (account.scenes["split"], account.scenes["seed"], account.scenes["scenes"]) == ("val", HAND_SEED, 1)
    assert (account.scenes["visibleMin"], account.scenes["shortSideMinPx"]) == (0.5, 20.0)


def test_a_small_back_is_an_ignore_region_too(hand, tmp_path):
    """The generator marks no back, so the two limits are applied to a back's own figures."""
    from cardvision.evaluate.scenes import scene_box

    back = dict(hand.backs[0])
    for visible, short, ignore in ((0.49, 100.0, True), (0.5, 100.0, False), (1.0, 19.9, True), (1.0, 20.0, False)):
        box = scene_box({**back, "visible": visible, "short": short}, 1920, 1080, 0.5, 20.0)
        assert (box.kind, box.ignore) == ("back", ignore)
    assert scene_box({**back, "kind": "distractor"}, 1920, 1080, 0.5, 20.0) is None


# --------------------------------------------------- the command, beside a manifest made by hand
class Setup:
    """Three scenes of the toy game and the toy models of the other evaluation tests."""

    def __init__(self, folder: Path, catalog_path: Path, art_dir: Path) -> None:
        (folder / "models").mkdir()
        self.toy = ToySetup(folder / "models", catalog_path, art_dir)
        self.catalog = load_catalog(catalog_path)
        self.art_dir = art_dir
        self.scenes = folder / "scenes"
        generate(self.catalog, art_dir, self.scenes, 3, seed=1, split="val")

    def arguments(self, *extra: str) -> list[str]:
        return ["--scenes", str(self.scenes), *self.toy.arguments(), "--bootstrap", "20", *extra]


@pytest.fixture(scope="module")
def setup(tmp_path_factory, toy) -> Setup:
    return Setup(tmp_path_factory.mktemp("scenes"), *toy)


def run(capsys, *arguments: str) -> tuple[int, str, str]:
    code = cli.main(["evaluate", *arguments])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def manifest_by_hand(scenes: Path, folder: Path) -> tuple[Path, Path]:
    """A label manifest and a frames folder written from a scene folder's labels, by the rules
    the documentation states and with no code of ``cardvision.evaluate.scenes``."""
    frames = folder / "frames"
    frames.mkdir(parents=True)
    rows = []
    for scene in read_labels(scenes):
        width, height = scene["width"], scene["height"]
        boxes = []
        for found in scene["objects"]:
            if found["kind"] not in ("face", "back"):
                continue
            quad = tuple((x / width, y / height) for x, y in found["corners"])
            hidden = found["visible"] < 0.5 or found["short"] < 20
            if found["kind"] == "face":
                boxes.append(Box(kind="face", quad=quad, ignore=found["ignore"] is not None, oriented=True,
                                 card_id=found["cardId"], identity="named", readable=None, id=str(found["id"])))
            else:
                boxes.append(Box(kind="back", quad=quad, ignore=hidden, oriented=True, id=str(found["id"])))
        # A manifest has no source type for generated scenes, so the rows are given one of footage.
        row = Row(platform="local", video_id="val-seed1", t=float(scene["index"]), frame_width=width,
                  frame_height=height, source_type="physical", group=GROUP, role="evaluation", trained_on=False,
                  completeness="exhaustive-boxes", credit="tests", boxes=tuple(boxes))
        rows.append(row)
        shutil.copyfile(scenes / scene["file"], frames / frame_file_name(row, ".jpg"))
    manifest = folder / "labels" / "scenes.manifest.jsonl"
    manifest.parent.mkdir()
    write_manifest(manifest, rows)
    return manifest, frames


@pytest.mark.parametrize("measure", ["hover", "crops", "detector"])
def test_scenes_and_a_manifest_of_the_same_labels_give_the_same_figures(setup, tmp_path, capsys, measure):
    manifest, frames = manifest_by_hand(setup.scenes, tmp_path / "by-hand")
    assert cli.main(["validate-manifest", str(manifest), "--catalog", str(setup.toy.catalog)]) == 0
    capsys.readouterr()
    code, _, err = run(capsys, measure, *setup.arguments("--out", str(tmp_path / "scenes")))
    assert code == 0, err
    code, _, err = run(capsys, measure, "--manifest", str(manifest), "--frames", str(frames), *setup.toy.arguments(),
                       "--bootstrap", "20", "--out", str(tmp_path / "manifest"))
    assert code == 0, err
    name = f"evaluate-{measure}.json"
    ours = json.loads((tmp_path / "scenes" / name).read_text())
    theirs = json.loads((tmp_path / "manifest" / name).read_text())
    assert ours["results"]["overall"] == theirs["results"]["overall"]
    assert ours["results"]["bySourceType"] == {SOURCE_TYPE: theirs["results"]["bySourceType"]["physical"]}
    assert ours["results"]["bySourceFamily"] == {SOURCE_TYPE: theirs["results"]["bySourceFamily"]["physical"]}
    assert ours["configuration"] == theirs["configuration"] and ours["definitions"] == theirs["definitions"]
    for key in ("rowsRead", "rowsUsed", "rowsSkipped", "rowsUnusable", "framesPresent", "labelsLeftOut", "labelsNotScored"):
        assert ours["inputs"][key] == theirs["inputs"][key], key
    assert ours["inputs"]["rowsUsed"] == 3
    # The listings agree line for line, apart from the source type.
    for listing in (tmp_path / "scenes").glob("*.jsonl"):
        mine = [json.loads(line) for line in listing.read_text().splitlines()]
        other = [json.loads(line) for line in (tmp_path / "manifest" / listing.name).read_text().splitlines()]
        assert mine and [{**item, "source_type": "physical"} for item in mine] == other
    # Only the scenes' result says that its rows are generated scenes.
    assert "scenes" not in theirs["inputs"] and theirs["inputs"]["role"] == "evaluation"
    assert ours["inputs"]["role"] is None and ours["inputs"]["scenes"]["note"] == NOTE


def test_the_report_opens_by_saying_that_the_rows_are_generated_scenes(setup, capsys):
    code, report, err = run(capsys, "hover", *setup.arguments())
    assert code == 0, err
    lines = report.splitlines()
    assert lines[0] == "# Evaluation: hover events"
    assert lines[4].startswith("**These rows are generated scenes, not footage.** `cardvision make-composites` drew "
                               "them from card images: 3 scenes, split `val`, seed 1. ")
    assert lines[4].endswith(NOTE)
    assert "a harder and a different test from a real table" in NOTE and "do not say how the models do on real video" in NOTE
    assert "roughly where the models stand" in NOTE
    assert "| Labels of the generated scenes | SHA-256 | Scenes |" in report and "| `labels.jsonl` |" in report
    assert "- role evaluated: none." in report and "is an ignore region" in report
    assert "- events: " in report and " in 1 recording groups" in report
    assert "group bootstrap: no interval (fewer than two recording groups)" in report
    assert "### Source type `generated`" in report
    # Names only, never a folder of this machine.
    assert str(setup.scenes) not in report and str(setup.scenes.parent) not in report
    assert "3 row(s) scored, 0 not scored" in err


def test_a_manifest_report_does_not_change(setup, tmp_path, capsys):
    manifest, frames = manifest_by_hand(setup.scenes, tmp_path / "by-hand")
    code, report, err = run(capsys, "hover", "--manifest", str(manifest), "--frames", str(frames),
                            *setup.toy.arguments(), "--bootstrap", "20")
    assert code == 0, err
    assert "generated scenes" not in report and "| Manifest | SHA-256 | Rows |" in report
    assert "- role evaluated: `evaluation`" in report


# ---------------------------------------------------------------------------------- refusals
def copy_of(setup: Setup, folder: Path) -> Path:
    shutil.copytree(setup.scenes, folder)
    return folder


def rewrite_labels(folder: Path, change) -> None:
    """Change the scene records of a folder, and record the new file's hash as the generator would."""
    import hashlib

    scenes = read_labels(folder)
    change(scenes)
    data = "".join(json.dumps(scene) + "\n" for scene in scenes).encode("utf-8")
    (folder / "labels.jsonl").write_bytes(data)
    record = json.loads((folder / "manifest.json").read_text())
    record["labelsSha256"] = hashlib.sha256(data).hexdigest()
    (folder / "manifest.json").write_text(json.dumps(record), encoding="utf-8")


def test_a_folder_that_the_generator_did_not_write_is_refused(setup, tmp_path, capsys):
    def refused(folder: Path) -> str:
        code, out, err = run(capsys, "hover", "--scenes", str(folder), *setup.toy.arguments())
        assert (code, out) == (2, "")
        return err

    assert "no such folder of generated scenes" in refused(tmp_path / "none")
    (tmp_path / "empty").mkdir()
    assert "not a folder of generated scenes that cardvision make-composites wrote: it has no manifest.json and " \
           "labels.jsonl" in refused(tmp_path / "empty")
    # A folder of frames that cardvision fetch wrote is not one either.
    assert "not a folder of generated scenes" in refused(setup.toy.folder)
    other = copy_of(setup, tmp_path / "other-format")
    (other / "manifest.json").write_text(json.dumps({"format": "something-else"}), encoding="utf-8")
    assert 'does not have the format "cardvision-composites"' in refused(other)
    (other / "manifest.json").write_text("not json", encoding="utf-8")
    assert 'does not have the format "cardvision-composites"' in refused(other)
    newer = copy_of(setup, tmp_path / "newer")
    record = json.loads((newer / "manifest.json").read_text())
    (newer / "manifest.json").write_text(json.dumps({**record, "formatVersion": 2}), encoding="utf-8")
    assert "has format version 2, and this package reads version 1" in refused(newer)


def test_labels_that_are_not_the_generators_or_fail_its_check_are_refused(setup, tmp_path, capsys):
    def refused(folder: Path) -> str:
        code, out, err = run(capsys, "detector", "--scenes", str(folder), *setup.toy.arguments())
        assert (code, out) == (2, "")
        return err

    edited = copy_of(setup, tmp_path / "edited")
    with open(edited / "labels.jsonl", "a", encoding="utf-8") as handle:
        handle.write("\n")
    assert "labels.jsonl is not the file the generator wrote: its SHA-256 differs" in refused(edited)

    missing = copy_of(setup, tmp_path / "missing")
    (missing / "images" / "00001.jpg").unlink()
    said = refused(missing)
    assert "the labels fail the check of make-composites --check, with 1 problem(s)" in said
    assert "scene 1: image images/00001.jpg is missing" in said

    def outside(scenes) -> None:
        scenes[0]["objects"][0]["box"][2] = scenes[0]["width"] + 50.0

    broken = copy_of(setup, tmp_path / "broken")
    rewrite_labels(broken, outside)
    said = refused(broken)
    assert "the labels fail the check of make-composites --check" in said and "is empty or outside the" in said

    def unknown_card(scenes) -> None:
        for scene in scenes:
            for found in scene["objects"]:
                if found["kind"] == "face":
                    found["cardId"] = "NOT-A-CARD"

    foreign = copy_of(setup, tmp_path / "foreign")
    rewrite_labels(foreign, unknown_card)
    said = refused(foreign)
    assert "which is not a card of the catalog" in said and "; and " in said and " more" in said

    with pytest.raises(ScenesError, match="the labels fail the check"):
        read_scenes(foreign, setup.catalog)


def test_the_generators_own_check_passes_on_what_is_scored(setup):
    """``--scenes`` refuses exactly the problems that ``make-composites --check`` counts."""
    from cardvision.composites import validate_labels
    from cardvision.composites.validate import label_problems

    assert label_problems(setup.scenes, read_labels(setup.scenes), setup.catalog) == []
    assert validate_labels(setup.scenes, setup.catalog, setup.art_dir)["problemCount"] == 0


def test_arguments_that_have_no_meaning_beside_scenes_are_refused(setup, tmp_path, capsys):
    cases = [
        (["compare", *setup.arguments("--other-bank", str(setup.toy.bank))], "--scenes is read by hover, crops and detector, not by compare"),
        (["hover", *setup.arguments("--role", "train")], "do not also give --role"),
        (["hover", *setup.arguments("--frames", str(tmp_path))], "do not also give --frames"),
        (["crops", *setup.arguments("--manifest", str(tmp_path / "a.jsonl"))], "do not also give --manifest"),
        (["hover", *setup.arguments("--browser-events", str(tmp_path / "e.jsonl"))], "do not also give --browser-events"),
        (["hover", *setup.toy.arguments()], "give --manifest, one or more label manifests, or --scenes, a folder of generated scenes"),
    ]
    for arguments, message in cases:
        code, out, err = run(capsys, *arguments)
        assert (code, out) == (2, "") and message in err, arguments


def test_the_detector_and_the_crops_reports_say_what_each_counts(setup, tmp_path, capsys):
    """Two scenes whose camera foreshortens some cards past a whole card's proportions. The
    detector measure reads boxes as its trainer does and sets such a face aside as an ignore
    region; the crops measure cuts it. The two totals differ by exactly those faces, and each
    report says so, so that neither number is read as the other."""
    scenes = tmp_path / "tilted"
    generate(setup.catalog, setup.art_dir, scenes, 2, seed=13)
    arguments = ["--scenes", str(scenes), *setup.toy.arguments(), "--bootstrap", "20"]
    code, detector_report, err = run(capsys, "detector", *arguments, "--out", str(tmp_path / "detector"))
    assert code == 0, err
    code, crops_report, err = run(capsys, "crops", *arguments, "--out", str(tmp_path / "crops"))
    assert code == 0, err
    found = json.loads((tmp_path / "detector" / "evaluate-detector.json").read_text())
    cut = json.loads((tmp_path / "crops" / "evaluate-crops.json").read_text())
    overall, boxes = found["results"]["overall"], found["inputs"]["scenes"]["boxes"]
    positive = boxes["faces"] - boxes["ignoredFaces"]
    assert (positive, overall["facesIgnoredForProportions"]) == (21, 7)
    # Face targets and the faces set aside make up the faces that are not ignore regions by the generator's marks.
    assert overall["faceTargets"] + overall["facesIgnoredForProportions"] == positive
    assert overall["ignoreRegions"] == boxes["ignoredFaces"] + boxes["ignoredBacks"] + overall["facesIgnoredForProportions"]
    # The crops are those same faces, less the ones too small to cut, which the report counts.
    assert cut["results"]["overall"]["crops"] + cut["inputs"]["labelsLeftOut"].get("small", 0) == positive
    assert cut["results"]["overall"]["crops"] > overall["faceTargets"]
    assert (f"- frames: 2; face targets {overall['faceTargets']}, back targets {overall['backTargets']}, ignore regions "
            f"{overall['ignoreRegions']}, not-card boxes 0\n  - of the ignore regions, 7 are faces set aside because their "
            "outline does not have a whole card's proportions; `evaluate crops` and `evaluate hover` count them as faces\n"
            ) in detector_report
    assert "- targets = the labeled boxes of the used frames, read as the detector's trainer reads them" in detector_report
    assert "- crops = the faces of the used rows that are named, not marked ignore, not labeled unreadable" in crops_report
    assert found["definitions"]["targets"].endswith("so their totals can be larger than face targets")
    # Where no face is set aside the detector's report has no such line.
    code, plain, err = run(capsys, "detector", *setup.arguments())
    assert code == 0 and "faces set aside" not in plain.split("## Results")[1]
