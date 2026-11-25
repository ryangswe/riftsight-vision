# SPDX-License-Identifier: Apache-2.0
"""The browser runtime and this package agree, frame for frame, on the toy game.

The test builds everything from nothing: the toy game, stand-in models, seven generated frames
and a release for each (``cardvision build-bank`` and ``build-release``). Each frame goes
through ``cardvision infer`` and through the TypeScript pipeline of ``browser/``, which loads
the same release with its own loader and runs under Node on ONNX Runtime Web's WebAssembly
backend (``browser/node/agreement.ts``). The two answers must be the same:

* the same boxes in the same order, with the same class and detector score, and the same
  coordinates to the last bit: both sides decode the detector's rows in the same precision and
  clip a box in the same way. ``cardvision infer`` prints a box rounded to three decimals, and
  the printed box is checked as well. Equality to the last bit is a property of the toy model:
  its stand-in detector returns the rows it was built with, whatever the runtime. With real
  weights the two ONNX Runtime builds give detector scores that agree to about 0.00001, and
  what must match is the boxes there are, their order and class, the names and the decisions;
* for every face the same accept decision, look, best match and name; similarity and margin
  to 0.00001, because the two ONNX Runtime builds and the two dot products do not round alike
  in the last bits;
* for a grid of pointer positions, under each of the three hover selections, the same box hit
  and the same card shown.

Three frames hold cards at all four quarter turns (so the rotation retry runs), a card back, a
card the bank lacks, a card the bank cannot tell from another, alternate printings, boxes that
overlap, a box inside another, boxes that hang over the edge, one too small and one too weak.
One release turns the rotation retry off.

Four more frames put box edges beside whole pixels, where the first or last column or row of
a crop is decided: a hair under (single-precision arithmetic leaves 299.99998 for 300), 0.0003
px under, 0.0003 px over, and far edges only (a bottom edge at 163.99988, where the printed top
and the printed height add up to 164). Both sides cut a crop from the box as the detector
decoded it, the near edges and the far ones, and round nothing before the cut, so they cut the
same pixels. A crop cut from the printed box would start or end one pixel away in every one of
these frames but the third; scores then differed by 0.0003 to 0.0033 when that was tried,
where 0.00001 is allowed. A pointer between a decoded edge and the printed one would be answered
differently in the second, the third and the fourth.

One frame more is of a game where different cards share a name. Its catalog states
``"identity": "printing"``: two cards named alike are two identities, and an alternate printing
belongs to the card it reprints. Two of its cards share a name and a picture, so the margin of
the accept rule is measured between them and neither is named. Both sides must read the rule
from the release and agree there as well.

The test is skipped when Node or ``browser/node_modules`` is missing (run ``npm ci`` in
``browser/``). ``.github/workflows/browser.yml`` runs it with ``CARDVISION_REQUIRE_BROWSER=1``
set, which turns that skip into a failure, so that the workflow cannot pass without having
compared anything.
"""

from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from cardvision import cli
from cardvision.bank import build as bank_build
from cardvision.bank.release import yolox_anchor_count
from cardvision.core.catalog import load_catalog, parse_catalog
from cardvision.detect import letterbox_ratio
from cardvision.evaluate.hover import SELECTIONS, HoverLayer
from cardvision.infer.pipeline import Pipeline, reported_box
from cardvision.recognize import crop_edges, crop_truncated, load_accept

ROOT = Path(__file__).resolve().parents[1]
BROWSER = ROOT / "browser"
NODE = shutil.which("node")

REQUIRED = os.environ.get("CARDVISION_REQUIRE_BROWSER") == "1"
MISSING = ("Node is not installed" if NODE is None
           else "browser/node_modules is missing: run npm ci in browser/" if not (BROWSER / "node_modules").is_dir() else None)

if MISSING is not None and not REQUIRED:
    pytest.skip(f"the browser runtime is not compared: {MISSING}", allow_module_level=True)

SCORE_TOLERANCE = 1e-5

LEFT_OUT = "TOY-012"   # in no release's catalog, so the bank has no row for it
TWIN = "TOY-016"       # its bank row is embedded from TOY-015's image: the bank cannot tell TOY-015 from it,
                       # and has never seen TOY-016's own image
PORTRAIT, LANDSCAPE = (240, 336), (336, 240)

# Each scene: the frame's size, the accept rule, the cards laid on the table as (card id, x, y,
# quarter turns counter-clockwise), and the detector's boxes as (x, y, width, height, score,
# class). A box given as a number is the box of that card, with the score and class that follow.
# A scene may add pointer positions of its own to the grid ("points").
SCENES = {
    # A frame the detector's canvas halves exactly, so every box sits on whole pixels: pointer
    # positions on edges and corners must then resolve alike on both sides.
    "table": {
        "size": (1280, 768),
        "accept": {"tau": 0.9, "delta": 0.02, "rotationRetry": True},
        "cards": [("TOY-001", 20, 20, 0), ("TOY-003", 280, 20, 1), ("TOY-007", 640, 20, 2), ("TOY-009", 900, 20, 3),
                  (LEFT_OUT, 20, 400, 0), ("TOY-015", 280, 400, 0), ("TOY-017", 540, 400, 0), ("TOY-005", 1160, 400, 0)],
        "boxes": [(0, 0.95, 0), (1, 0.93, 0), (2, 0.91, 0), (3, 0.89, 0), (4, 0.87, 0), (5, 0.85, 0), (6, 0.83, 0), (7, 0.81, 0),
                  (900, 400, 240, 336, 0.79, 1),      # a card back
                  (30, 24, 240, 336, 0.77, 0),        # a second box on the first card: the detector's own suppression drops it
                  (80, 120, 120, 160, 0.97, 0),       # a box inside the first card, with the best detector score
                  (20, 20, 860, 336, 0.73, 0),        # one box over three cards
                  (700, 700, 20, 20, 0.71, 0),        # too small to crop
                  (1000, 700, 100, 60, 0.2, 0)],      # under the detector's threshold
    },
    # A frame scaled by one third: no box lands on a whole pixel, and the boxes are offset from
    # the cards by fractions, so the truncation of crop edges is exercised.
    "wide": {
        "size": (1920, 1080),
        "accept": {"tau": 0.6, "delta": 0.02, "rotationRetry": True},
        "cards": [("TOY-002", 100, 60, 0), ("TOY-004", 500, 80, 2), ("TOY-018", 900, 100, 1), ("TOY-006", 1300, 60, 3),
                  ("TOY-003A", 100, 560, 0), ("TOY-P01", 480, 600, 1), ("TOY-011", 1000, 560, 0), (TWIN, 1400, 600, 0)],
        "boxes": [(100.4, 60.7, 239.3, 335.1, 0.96, 0), (499.6, 80.2, 240.9, 336.5, 0.94, 0), (900.3, 99.6, 239.5, 336.8, 0.92, 0),
                  (1300.9, 60.1, 335.2, 239.6, 0.9, 0), (99.7, 560.3, 240.6, 335.9, 0.88, 0), (480.2, 599.9, 335.7, 240.3, 0.86, 0),
                  (1000.5, 559.5, 239.8, 336.9, 0.84, 0), (1399.1, 600.6, 241.3, 334.7, 0.82, 0),
                  (700.5, 500.5, 250.0, 350.0, 0.8, 1),          # a card back
                  (1010.2, 580.4, 215.5, 300.5, 0.78, 0),        # a tighter box on a card
                  (195.9, 60.7, 239.3, 335.1, 0.77, 0),          # half on the first card: overlaps its box by 0.43
                  (1760.4, 800.2, 400.0, 400.0, 0.76, 0)],       # table only, hanging over the corner
    },
    # A small frame and no rotation retry: a turned card is judged on its upright look alone.
    "small": {
        "size": (854, 480),
        "accept": {"tau": 0.9, "delta": 0.02, "rotationRetry": False},
        "cards": [("TOY-008", 30, 60, 0), ("TOY-003", 300, 100, 1), ("TOY-013", 660, 60, 0)],
        "boxes": [(30.4, 60.3, 239.4, 335.5, 0.9, 0), (300.3, 99.7, 335.5, 240.6, 0.85, 0), (659.6, 60.4, 240.0, 335.3, 0.8, 0),
                  (560.5, 380.4, 90.2, 90.3, 0.75, 1)],
    },
}


# Box edges beside whole pixels. The frame is scaled by a ratio that is not a power of two
# (640 / 854), so the detector's single-precision arithmetic does not return a box exactly. Every
# card lies on whole pixels. In order of detector score each scene has three faces and a back.
EDGE_FRAME = (854, 480)
EDGE_ACCEPT = {"tau": 0.9, "delta": 0.02, "rotationRetry": True}
EDGE_CARDS = [("TOY-008", 30, 60, 0), ("TOY-001", 300, 60, 0), ("TOY-013", 570, 60, 0)]
EDGE_BACK = (560.5, 410.4, 90.2, 60.3, 0.75, 1)
EDGE_SCENES = {
    # Boxes given on whole pixels: the arithmetic leaves some decoded edges a hair under a whole
    # number (299.99998 for 300). The third card hangs over the frame's right edge.
    "hair": {
        "size": EDGE_FRAME,
        "accept": EDGE_ACCEPT,
        "cards": [("TOY-008", 30, 60, 0), ("TOY-010", 300, 100, 1), ("TOY-013", 650, 60, 0)],
        "boxes": [(0, 0.9, 0), (1, 0.85, 0), (2, 0.8, 0), (30.0, 400.0, 90.0, 70.0, 0.75, 1)],
    },
    # Edges 0.0003 px under a whole number, which three decimals round up to it: all four edges
    # of the first box, the right and bottom edges of the second, the left edge of the third.
    # The other edges lie well away from whole pixels.
    "under": {
        "size": EDGE_FRAME,
        "accept": EDGE_ACCEPT,
        "cards": EDGE_CARDS,
        "boxes": [(29.9997, 59.9997, 240.0, 336.0, 0.9, 0), (300.3, 60.3, 239.6997, 335.6997, 0.85, 0),
                  (569.9997, 60.3, 240.0006, 335.4, 0.8, 0), EDGE_BACK],
        # Between a decoded edge and the printed one: inside the first box (its left edge is
        # at 29.9997, its top edge at 59.9997), outside the second (its right edge is at 539.9997).
        "points": [[29.99985, 200.0], [150.0, 59.99985], [539.99985, 200.0]],
    },
    # The same edges 0.0003 px over a whole number, which three decimals round down to it.
    "over": {
        "size": EDGE_FRAME,
        "accept": EDGE_ACCEPT,
        "cards": EDGE_CARDS,
        "boxes": [(30.0003, 60.0003, 240.0, 336.0, 0.9, 0), (300.3, 60.3, 239.7003, 335.7003, 0.85, 0),
                  (570.0004, 60.3, 239.9999, 335.4, 0.8, 0), EDGE_BACK],
        # Outside the first box (its left edge is at 30.0003, its top edge at 60.0003), inside
        # the second (its right edge is at 540.0003).
        "points": [[30.00015, 200.0], [150.0, 60.00015], [540.00015, 200.0]],
    },
    # Far edges only: the bottom edges of the first two boxes (163.99988 and 358.9996) and the
    # right edge of the third (809.9999) lie just under a whole number, and every left and top
    # edge lies well away from one. Printed, the top and the height of the first box are 60.4
    # and 103.6, which add up to 164: the row the decoded box does not reach.
    "far": {
        "size": EDGE_FRAME,
        "accept": EDGE_ACCEPT,
        "cards": EDGE_CARDS,
        "boxes": [(30.4, 60.4, 239.3, 103.59988, 0.9, 0), (300.3, 60.3, 239.5, 298.6996, 0.85, 0),
                  (570.4, 60.4, 239.59988, 335.3, 0.8, 0), EDGE_BACK],
        # Between the decoded bottom edge of the first box and the printed one: outside the box.
        "points": [[150.0, 163.99995]],
    },
}


def by_printing(catalog: dict) -> dict:
    """The toy catalog as a game where different cards share a name: it states the
    ``printing`` rule, TOY-007 takes the name of TOY-001 and keeps its own picture, and the
    twin takes the name of the card whose picture it has."""
    by_id = {card["id"]: card for card in catalog["cards"]}
    by_id["TOY-007"]["name"] = by_id["TOY-001"]["name"]
    by_id[TWIN]["name"] = by_id["TOY-015"]["name"]
    return {"game": catalog["game"], "locale": catalog["locale"], "identity": "printing",
            **{key: value for key, value in catalog.items() if key not in ("game", "locale")}}


# A game where different cards share a name. On the table: two cards named alike with their own
# pictures, a card whose picture a second card of its name also has, and two alternate
# printings. "views" builds the bank from each card's image alone, so that the two rows of one
# picture are equal and the margin between them is exactly nothing. The accept rule is strict,
# so that no turned look of the stand-in recognizer is taken for another card.
IDENTITY_SCENES = {
    "namesakes": {
        "size": (1280, 768),
        "accept": {"tau": 0.99, "delta": 0.02, "rotationRetry": True},
        "catalog": by_printing,
        "views": 1,
        "cards": [("TOY-001", 20, 20, 0), ("TOY-007", 280, 20, 0), ("TOY-015", 540, 20, 0), ("TOY-003A", 800, 20, 0),
                  ("TOY-P01", 20, 400, 0), ("TOY-017", 300, 400, 0)],
        "boxes": [(0, 0.95, 0), (1, 0.93, 0), (2, 0.91, 0), (3, 0.89, 0), (4, 0.87, 0), (5, 0.85, 0),
                  (900, 400, 240, 336, 0.79, 1),      # a card back
                  (20, 20, 500, 336, 0.73, 0)],       # one box over the two cards of one name
    },
}
ALL_SCENES = {**SCENES, **EDGE_SCENES, **IDENTITY_SCENES}


def scene_boxes(scene: dict, card_boxes: list) -> tuple[list, list, list]:
    boxes, scores, classes = [], [], []
    for entry in scene["boxes"]:
        if len(entry) == 3:
            card, score, cls = entry
            boxes.append(card_boxes[card])
        else:
            *box, score, cls = entry
            boxes.append(tuple(box))
        scores.append(score)
        classes.append(cls)
    return boxes, scores, classes


def pointer_grid(width: int, height: int, boxes: list, on_edges: bool) -> list[list[float]]:
    """Pointer positions: a grid over the frame, and points at the center and near the corners
    of every box. With ``on_edges`` the corner points lie exactly on the corners."""
    points = [[(i + 0.25) * width / 28, (j + 0.25) * height / 16] for j in range(16) for i in range(28)]
    inset = 0.0 if on_edges else 0.01
    for x, y, w, h in boxes:
        x0, y0, x1, y1 = max(0, x), max(0, y), min(width, x + w), min(height, y + h)
        points += [[(x0 + x1) / 2, (y0 + y1) / 2], [x0 + inset, y0 + inset], [x1 - inset, y1 - inset],
                   [x1 - inset, y0 + inset], [x0 + inset, y1 - inset], [x0 - 1.5, y0 - 1.5]]
    return points


def run_cli(*arguments) -> tuple[int, str, str]:
    """Run the ``cardvision`` command line in this process: exit code, standard output, standard error."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli.main([str(argument) for argument in arguments])
    return code, out.getvalue(), err.getvalue()


def run_browser(job: Path, runtime: str = "all") -> subprocess.CompletedProcess:
    """Run the TypeScript pipeline under Node on a job file (esbuild bundles it first). ``runtime``
    "wasm" builds it on ONNX Runtime's WebAssembly-only entry, as ``npm run vendor -- --runtime wasm``
    ships it."""
    return subprocess.run([NODE, str(BROWSER / "scripts" / "agreement.mjs"), "--runtime", runtime, str(job)],
                          capture_output=True, text=True, cwd=BROWSER, timeout=600)


class Built:
    """One scene: its release folder, its frame, what Python found and what the browser runtime found."""


@pytest.fixture(scope="module")
def built(toy, tmp_path_factory) -> dict[str, Built]:
    pytest.importorskip("onnx")
    from test_infer_toy_models import build_detector, build_recognizer, detector_rows, make_scene, save_image

    catalog_path, art_dir = toy
    work = tmp_path_factory.mktemp("agreement")
    catalog = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    catalog["cards"] = [card for card in catalog["cards"] if card["id"] != LEFT_OUT]
    for card in catalog["cards"]:
        if card["id"] == TWIN:
            card["art"] = "TOY-015.png"
    recognizer = build_recognizer(work / "recognizer.onnx")

    scenes: dict[str, Built] = {}
    for name, scene in ALL_SCENES.items():
        item = Built()
        item.name, item.scene, item.art_dir = name, scene, art_dir
        item.folder = work / name
        item.folder.mkdir()
        width, height = scene["size"]
        item.frame, card_boxes = make_scene(art_dir, scene["cards"], size=(width, height))
        item.boxes, scores, classes = scene_boxes(scene, card_boxes)
        # The detector's rows: the scene's boxes scattered among the rows of a full-size output.
        rows = np.zeros((yolox_anchor_count(640, 384), 7), dtype=np.float32)
        real = detector_rows(item.boxes, scores, classes, frame_size=(width, height))
        positions = np.random.default_rng(7).permutation(len(rows))[: len(real)]
        rows[positions] = real
        shutil.copy(recognizer, item.folder / "recognizer.onnx")
        build_detector(item.folder / "detector.onnx", rows)
        written = scene["catalog"](copy.deepcopy(catalog)) if "catalog" in scene else catalog
        (item.folder / "catalog.json").write_text(json.dumps(written, indent=1), encoding="utf-8")
        (item.folder / "accept.json").write_text(json.dumps(scene["accept"]), encoding="utf-8")
        item.image = save_image(item.folder / f"{name}.png", item.frame)
        rgba = np.dstack([item.frame, np.full(item.frame.shape[:2], 255, dtype=np.uint8)])
        rgba.tofile(item.folder / f"{name}.rgba")
        item.points = pointer_grid(width, height, item.boxes, on_edges=(letterbox_ratio(width, height) == 0.5))
        item.points += scene.get("points", [])
        scenes[name] = item
    return scenes


@pytest.fixture(scope="module")
def answers(built) -> dict[str, Built]:
    """Build each release with the command line, then run ``cardvision infer`` and the browser runtime."""
    for item in built.values():
        folder = item.folder
        models = ["--detector", folder / "detector.onnx", "--recognizer", folder / "recognizer.onnx", "--bank", folder / "bank.json",
                  "--catalog", folder / "catalog.json", "--accept", folder / "accept.json"]
        views, bank_build.VIEWS_PER_CARD = bank_build.VIEWS_PER_CARD, item.scene.get("views", bank_build.VIEWS_PER_CARD)
        try:
            code, _, err = run_cli("build-bank", "--catalog", folder / "catalog.json", "--art", item.art_dir, "--recognizer",
                                   folder / "recognizer.onnx", "--out", folder / "bank.json", "--model", "toy-recognizer")
        finally:
            bank_build.VIEWS_PER_CARD = views
        assert code == 0, err
        code, _, err = run_cli("build-release", *models, "--out", folder / "release.json")
        assert code == 0, err
        item.release = json.loads((folder / "release.json").read_text(encoding="utf-8"))
        code, out, err = run_cli("infer", item.image, *models)
        assert code == 0, err
        (item.python,) = [json.loads(line) for line in out.splitlines()]
        # The same pipeline in this process, for the hover rule, which the command does not print.
        pipeline = Pipeline.open(folder / "detector.onnx", folder / "recognizer.onnx", folder / "bank.json",
                                 load_catalog(folder / "catalog.json"), load_accept(folder / "accept.json"))
        item.result = pipeline.analyze(item.frame, name=item.image.name, source=str(item.image))
        assert item.result.to_json() == item.python

        job = {"release": str(folder / "release.json"),
               "frames": [{"name": item.name, "rgba": str(folder / f"{item.name}.rgba"), "width": item.scene["size"][0],
                           "height": item.scene["size"][1], "points": item.points}]}
        (folder / "job.json").write_text(json.dumps(job), encoding="utf-8")
        ran = run_browser(folder / "job.json")
        assert ran.returncode == 0, ran.stderr
        item.browser = json.loads(ran.stdout)
    return built


# ---------------------------------------------------------------------------------- the checks
def test_the_browser_runtime_is_there_to_compare_with():
    assert MISSING is None, f"CARDVISION_REQUIRE_BROWSER is set and {MISSING}"


@pytest.mark.parametrize("name", list(ALL_SCENES))
def test_the_browser_runtime_loads_the_release_python_wrote(answers, name):
    item = answers[name]
    assert item.browser["release"] == item.release["id"]
    assert item.browser["backend"] == {"detector": "wasm", "recognizer": "wasm"}
    assert item.browser["selection"] == item.release["hover"]["selection"] == "accepted-nms"


@pytest.mark.parametrize("name", list(ALL_SCENES))
def test_the_same_boxes_in_the_same_order(answers, name):
    item = answers[name]
    (frame,) = item.browser["frames"]
    theirs, ours = frame["boxes"], item.python["boxes"]
    assert len(theirs) == len(ours) >= 4
    assert [box["className"] for box in theirs] == [box["class"] for box in ours]
    for theirs_box, card, printed in zip(theirs, item.result.cards, ours):
        # Equal to the last bit, score and box: a property of the toy model. Its stand-in detector
        # returns the rows it was built with, so both runtimes decode the same numbers (the score
        # is the same float32 product). With real weights the two ONNX Runtime builds give scores
        # that agree to about 1e-5; there the boxes that are found, their order and class, the
        # names and the decisions are what must match. Do not loosen this for the toy model.
        assert theirs_box["score"] == card.score
        assert theirs_box["box"] == list(card.box)
        assert printed["box"] == reported_box(theirs_box["box"])
    assert "back" in [box["class"] for box in ours]


@pytest.mark.parametrize("name", list(ALL_SCENES))
def test_the_same_decision_for_every_face(answers, name):
    item = answers[name]
    (frame,) = item.browser["frames"]
    compared = 0
    for theirs, ours in zip(frame["boxes"], item.python["boxes"]):
        face = theirs["face"]
        if ours["class"] != "face":
            assert face is None
            continue
        compared += 1
        assert (face["accepted"], face["tauPassed"], face["look"], face["retried"]) == (
            ours["accepted"], ours["tauPassed"], ours["look"], ours["retried"]), ours
        assert (face["topId"], face["topName"], face["cardId"], face["name"]) == (
            ours["topId"], ours["topName"], ours["cardId"], ours["name"]), ours
        assert abs(face["similarity"] - ours["similarity"]) <= SCORE_TOLERANCE
        assert abs(face["margin"] - ours["margin"]) <= SCORE_TOLERANCE
    assert compared == len(item.result.faces) >= 3


@pytest.mark.parametrize("name", list(ALL_SCENES))
def test_the_same_card_under_every_pointer_position(answers, name):
    item = answers[name]
    (frame,) = item.browser["frames"]
    face_boxes = [index for index, card in enumerate(item.result.cards) if card.recognition is not None]
    width, height = item.scene["size"]
    for selection in SELECTIONS:
        layer = HoverLayer.of(item.result, selection)
        hits = shown = 0
        for (px, py), theirs in zip(item.points, frame["hover"][selection]):
            ours = layer.at(px, py)
            ours_box = None if ours.index is None else face_boxes[ours.index]
            assert (theirs["boxIndex"], theirs["name"], theirs["cardId"]) == (ours_box, ours.name, ours.card_id), (
                selection, px, py)
            hits += ours.index is not None
            shown += ours.name is not None
        assert len(frame["hover"][selection]) == len(item.points)
        assert hits > 20 and shown > 10, (selection, hits, shown)  # the grid does land on cards


def at(boxes: list[dict], x: float, y: float) -> dict:
    """The box whose top-left corner is at ``(x, y)``."""
    (found,) = [box for box in boxes if abs(box["box"][0] - x) < 0.01 and abs(box["box"][1] - y) < 0.01]
    return found


def test_the_scenes_hold_what_they_are_meant_to(answers):
    """The agreement above is only worth something if the frames exercise the rules. The
    stand-in recognizer has no skill, so what matters here is which rule fired, not which name
    came out."""
    table = answers["table"].python["boxes"]
    faces = [box for box in table if box["class"] == "face"]
    # Every quarter turn was chosen for some card, and a turned look only after the retry.
    assert {box["look"] for box in faces if box["accepted"]} == {0, 1, 2, 3}
    assert all(box["retried"] for box in faces if box["look"] != 0)
    assert [box["class"] for box in table].count("back") == 1
    # Three of the detector's boxes are gone: one too small, one too weak, and the second box on
    # the first card, which the detector's own suppression dropped.
    assert len(table) == len(SCENES["table"]["boxes"]) - 3 == 11
    assert at(table, 20, 400)["tauPassed"] is False                         # the card the bank lacks
    assert at(table, 1160, 400)["box"] == [1160.0, 400.0, 120.0, 336.0]    # clipped at the frame's edge
    assert table[0]["box"] == [80.0, 120.0, 120.0, 160.0] and table[0]["tauPassed"] is False

    wide = answers["wide"].python["boxes"]
    (wide_frame,) = answers["wide"].browser["frames"]
    assert any(box["tauPassed"] and not box["accepted"] for box in wide if box["class"] == "face")   # refused by the margin
    assert {"TOY-003A", "TOY-P01"} <= {box["cardId"] for box in wide if box.get("accepted")}        # the printing that matched
    assert any(abs(value - round(value)) > 0.01 for box in wide for value in box["box"])            # boxes off the pixel grid
    assert at(wide, 1760.4, 800.2)["box"][2:] == [159.6, 279.8]                                     # clipped at the corner
    # Suppression among the boxes that reach tau: the box half on the first card reaches tau and
    # is not among the kept.
    half = at(wide_frame["boxes"], 195.9, 60.7)["face"]
    assert half["tauPassed"] is True and half["kept"] is False
    assert at(wide_frame["boxes"], 100.4, 60.7)["face"]["kept"] is True

    # The three selections do not answer alike: each pair differs in one of the frames.
    def hits(frame: dict, selection: str) -> list:
        return [(hit["boxIndex"], hit["name"]) for hit in frame["hover"][selection]]

    (table_frame,) = answers["table"].browser["frames"]
    assert hits(table_frame, "detector-score") != hits(table_frame, "best-score")
    assert hits(table_frame, "detector-score") != hits(table_frame, "accepted-nms")
    assert hits(wide_frame, "accepted-nms") != hits(wide_frame, "best-score")

    small = [box for box in answers["small"].python["boxes"] if box["class"] == "face"]
    assert [box["retried"] for box in small] == [False, False, False]
    # The same card, turned the same way, is named in the first frame after the retry and is
    # not named here, where the release turns the retry off.
    assert at(table, 280, 20)["topId"] == "TOY-003" and at(table, 280, 20)["accepted"] is True and at(table, 280, 20)["look"] != 0
    assert at(small, 300.3, 99.7)["accepted"] is False and at(small, 300.3, 99.7)["look"] == 0
    assert at(small, 30.4, 60.3)["accepted"] is True


def test_the_scene_of_shared_names_holds_what_it_is_meant_to(answers):
    """The frame of the game where different cards share a name. Both sides read the rule from
    the release; the tests above require that they answer alike, and this one that the answers
    are the ones the ``printing`` rule gives."""
    item = answers["namesakes"]
    folder = item.folder
    assert item.release["identity"]["level"] == "printing"
    groups = json.loads((folder / item.release["identity"]["groups"]["path"]).read_text(encoding="utf-8"))
    # Only a card and its printing are one identity. No group joins the cards that share a name.
    assert groups["rule"] == {"level": "printing"}
    assert groups["groups"] == [["TOY-003", "TOY-003A"], ["TOY-010", "TOY-P01"]]

    ours = item.python["boxes"]
    (frame,) = item.browser["frames"]
    theirs = {tuple(box["box"][:2]): box["face"] for box in frame["boxes"] if box["face"] is not None}
    # Two different cards with one name are both named, and the card id tells them apart.
    first, second = at(ours, 20, 20), at(ours, 280, 20)
    assert (first["name"], first["cardId"]) == ("Amber Circle", "TOY-001")
    assert (second["name"], second["cardId"]) == ("Amber Circle", "TOY-007")
    assert [theirs[(20.0, 20.0)]["cardId"], theirs[(280.0, 20.0)]["cardId"]] == ["TOY-001", "TOY-007"]
    assert theirs[(20.0, 20.0)]["name"] == theirs[(280.0, 20.0)]["name"] == "Amber Circle"
    # The card whose picture a second card of its name has: its best row reaches tau, the other
    # card's row is as close, and nothing is named, on both sides.
    plum = at(ours, 540, 20)
    assert (plum["topId"], plum["topName"], plum["tauPassed"], plum["accepted"], plum["name"]) == (
        "TOY-015", "Plum Triangle", True, False, None)
    assert plum["margin"] == 0.0 and abs(theirs[(540.0, 20.0)]["margin"]) <= SCORE_TOLERANCE
    assert (theirs[(540.0, 20.0)]["topId"], theirs[(540.0, 20.0)]["accepted"]) == ("TOY-015", False)
    # An alternate printing is named, as itself: its own card's row does not count against it.
    for corner, card_id in (((800, 20), "TOY-003A"), ((20, 400), "TOY-P01")):
        printing = at(ours, *corner)
        assert (printing["accepted"], printing["cardId"]) == (True, card_id)
        assert theirs[tuple(float(value) for value in corner)]["cardId"] == card_id
    # The pointer on the unnamed card is taken by its box and shows nothing, on both sides.
    layer = HoverLayer.of(item.result)
    shown = layer.at(660.0, 188.0)
    index = item.points.index([660.0, 188.0])
    assert shown.index is not None and shown.name is None
    assert frame["hover"]["accepted-nms"][index]["boxIndex"] is not None and frame["hover"]["accepted-nms"][index]["name"] is None

    # The same files under the name rule, for contrast: the two rows of one picture are then
    # one identity, the margin looks past both, and the card is named.
    by_name = json.loads((folder / "catalog.json").read_text(encoding="utf-8"))
    del by_name["identity"]
    pipeline = Pipeline.open(folder / "detector.onnx", folder / "recognizer.onnx", folder / "bank.json", parse_catalog(by_name),
                             load_accept(folder / "accept.json"))
    named = at(pipeline.analyze(item.frame).to_json()["boxes"], 540, 20)
    assert (named["accepted"], named["name"], named["cardId"]) == (True, "Plum Triangle", "TOY-015")


def crop_edges_of(item: Built, box: list[float]) -> tuple[int, int, int, int]:
    width, height = item.scene["size"]
    return crop_edges(box, width, height)


@pytest.mark.parametrize("name", list(EDGE_SCENES))
def test_a_box_edge_beside_a_whole_pixel(answers, name):
    """Every face of the edge scenes is cut from the box the browser runtime reports, cut down to
    whole pixels, and scores alike on both sides. Cut from the printed box, a crop of the first
    two scenes would start or end one pixel away, and its score would miss the tolerance."""
    item = answers[name]
    (frame,) = item.browser["frames"]
    compared = 0
    for theirs, ours, card in zip(frame["boxes"], item.python["boxes"], item.result.cards):
        if theirs["face"] is None:
            continue
        compared += 1
        np.testing.assert_array_equal(card.crop, crop_truncated(item.frame, theirs["box"]))
        assert abs(theirs["face"]["similarity"] - ours["similarity"]) <= SCORE_TOLERANCE
        assert abs(theirs["face"]["margin"] - ours["margin"]) <= SCORE_TOLERANCE
    assert compared == 3


def test_the_edge_scenes_hold_what_they_are_meant_to(answers):
    """The edges do lie where the scenes say, on the side of the whole pixel they say, and the
    printed box does not tell which side that is."""
    def boxes(name: str) -> tuple[list, list, list]:
        item = answers[name]
        (frame,) = item.browser["frames"]
        faces = [(theirs["box"], ours["box"]) for theirs, ours in zip(frame["boxes"], item.python["boxes"]) if ours["class"] == "face"]
        return ([crop_edges_of(item, decoded) for decoded, _ in faces], [crop_edges_of(item, printed) for _, printed in faces],
                [decoded for decoded, _ in faces])

    # A hair under: printed on whole pixels, decoded just under, and so cut one column to the left.
    cut, cut_if_printed, decoded = boxes("hair")
    assert [box["box"] for box in answers["hair"].python["boxes"]] == [
        [30.0, 60.0, 240.0, 336.0], [300.0, 100.0, 336.0, 240.0], [650.0, 60.0, 204.0, 336.0], [30.0, 400.0, 90.0, 70.0]]
    assert 299.9999 < decoded[1][0] < 300
    assert cut[1][0] == 299 and cut_if_printed[1][0] == 300

    # 0.0003 px under: every face is cut one pixel away from what its printed box says.
    cut, cut_if_printed, decoded = boxes("under")
    assert [box["box"] for box in answers["under"].python["boxes"]][:3] == [
        [30.0, 60.0, 240.0, 336.0], [300.3, 60.3, 239.7, 335.7], [570.0, 60.3, 240.001, 335.4]]
    assert 29.9995 < decoded[0][0] < 30 and 59.9995 < decoded[0][1] < 60
    assert 539.9995 < decoded[1][0] + decoded[1][2] < 540 and 395.9995 < decoded[1][1] + decoded[1][3] < 396
    assert 569.9995 < decoded[2][0] < 570 and 810 < decoded[2][0] + decoded[2][2] < 810.0005
    assert cut == [(29, 59, 269, 395), (300, 60, 539, 395), (569, 60, 810, 395)]
    assert cut_if_printed == [(30, 60, 270, 396), (300, 60, 540, 396), (570, 60, 810, 395)]

    # 0.0003 px over: the printed box and the decoded one are cut alike.
    cut, cut_if_printed, decoded = boxes("over")
    assert [box["box"] for box in answers["over"].python["boxes"]][:3] == [
        [30.0, 60.0, 240.0, 336.0], [300.3, 60.3, 239.7, 335.7], [570.0, 60.3, 240.0, 335.4]]
    assert 30 < decoded[0][0] < 30.0005 and 60 < decoded[0][1] < 60.0005
    assert 540 < decoded[1][0] + decoded[1][2] < 540.0005 and 396 < decoded[1][1] + decoded[1][3] < 396.0005
    assert 570 < decoded[2][0] < 570.0005 and 810 < decoded[2][0] + decoded[2][2] < 810.0005
    assert cut == cut_if_printed == [(30, 60, 270, 396), (300, 60, 540, 396), (570, 60, 810, 395)]

    # Far edges only: every near edge is cut as printed, and each far edge named above is not.
    cut, cut_if_printed, decoded = boxes("far")
    assert [box["box"] for box in answers["far"].python["boxes"]][:3] == [
        [30.4, 60.4, 239.3, 103.6], [300.3, 60.3, 239.5, 298.7], [570.4, 60.4, 239.6, 335.3]]
    assert 163.9998 < decoded[0][1] + decoded[0][3] < 163.9999
    assert 358.9995 < decoded[1][1] + decoded[1][3] < 359 and 809.9995 < decoded[2][0] + decoded[2][2] < 810
    assert cut == [(30, 60, 269, 163), (300, 60, 539, 358), (570, 60, 809, 395)]
    assert cut_if_printed == [(30, 60, 269, 164), (300, 60, 539, 359), (570, 60, 810, 395)]

    # The pointer positions between a decoded edge and the printed one, under the selection that
    # takes every box: the box hit is the decoded one's answer, not the printed one's.
    def hits(name: str) -> list:
        item = answers[name]
        (frame,) = item.browser["frames"]
        extra = len(item.scene["points"])
        assert item.points[-extra:] == item.scene["points"]
        return [hit["boxIndex"] for hit in frame["hover"]["detector-score"][-extra:]]

    assert hits("under") == [0, 0, None]
    assert hits("over") == [None, None, 1]
    assert hits("far") == [None]
    # Each of the six faces of these two scenes is named, so a miss here would show.
    for name in ("under", "over"):
        assert [box["accepted"] for box in answers[name].python["boxes"][:3]] == [True, True, True]


@pytest.mark.parametrize("name", list(ALL_SCENES))
def test_the_webassembly_only_runtime_gives_the_same_answer(answers, name):
    """The runtime built on ONNX Runtime's WebAssembly-only entry runs the same WebAssembly kernels as
    the default one does without WebGPU, so its answer is the default's, to the last bit: and through
    it, Python's."""
    item = answers[name]
    ran = run_browser(item.folder / "job.json", runtime="wasm")
    assert ran.returncode == 0, ran.stderr
    assert json.loads(ran.stdout) == item.browser


def test_the_browser_runtime_refuses_a_release_with_a_changed_file(answers, tmp_path):
    item = answers["small"]
    folder = Path(shutil.copytree(item.folder, tmp_path / "release"))
    job = json.loads((folder / "job.json").read_text(encoding="utf-8"))
    job["release"] = str(folder / "release.json")
    job["frames"][0]["rgba"] = str(folder / "small.rgba")
    (folder / "job.json").write_text(json.dumps(job), encoding="utf-8")
    assert run_browser(folder / "job.json").returncode == 0

    bank = (folder / "bank.json").read_bytes()
    (folder / "bank.json").write_bytes(bank.replace(b"TOY-001", b"TOY-00l", 1))
    ran = run_browser(folder / "job.json")
    assert ran.returncode != 0 and "sha256 of bank.json does not match the release" in ran.stderr

    (folder / "bank.json").write_bytes(bank)
    document = (folder / "release.json").read_text(encoding="utf-8")
    (folder / "release.json").write_text(document.replace('"tau": 0.9', '"tau": 0.5'), encoding="utf-8")
    ran = run_browser(folder / "job.json")
    assert ran.returncode != 0 and "is not the hash of the document" in ran.stderr


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))

