# SPDX-License-Identifier: Apache-2.0
"""``docs/your-game.md``, run as the page writes it, on toy files standing in for a game.

The commands are not copied here: they are read out of the page's "Paste this into the
terminal" blocks each time, so that the page and this run cannot drift apart. ``HOME`` is a
scratch folder, so the page's own variable block puts ``$GAME`` and ``$WEIGHTS`` there. Before
the blocks run, the scratch ``$GAME`` gets what a reader brings (``cards.csv`` written from the
toy catalog under headers a spreadsheet export might have, the toy card images as ``images/``
and the demo's toy table as ``video.mp4``) and ``$WEIGHTS`` gets the three files of the demo's
stand-in release, which ``build-release`` accepts. The page's three lines run first
(``fetch-weights`` excepted: it needs the network), then the step-by-step blocks. The download,
the block that opens the report in a browser and the ``npm`` block are found and checked,
never run.
"""

from __future__ import annotations

import csv
import json
import os
import shutil
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

from beginner_path import PASTE, fenced_blocks, flat

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "docs" / "your-game.md"
ID_HEADER = "Card No."      # the id column's header, as a spreadsheet export might name it


@dataclass(frozen=True)
class Step:
    """A "Paste this" block of the page, in page order. ``expect`` is a piece of its text;
    ``run`` is ``"run"``, ``"fails"`` (the page shows it stopping, with ``message``),
    ``"network"``, ``"open"`` or ``"npm"`` (found and checked, never run)."""
    expect: str
    run: str = "run"
    message: str = ""


TRY = 'cardvision try "$GAME/cards.csv" --images "$GAME/images" --video "$GAME/video.mp4" --weights "$WEIGHTS"'
VARIABLES = 'export GAME="$HOME/Downloads/my-game"\nexport WEIGHTS="$HOME/Downloads/cardvision-weights"\n'
STEPS = (
    Step(VARIABLES),
    Step('cardvision fetch-weights "$WEIGHTS"', run="network"),
    Step(TRY),
    Step('open "$GAME/cardvision-try/report.html"', run="open"),
    Step('cardvision import-catalog "$GAME/cards.csv" --out "$GAME/catalog.json"'),
    Step('cardvision check-catalog "$GAME/catalog.json" --art "$GAME/images"'),
    Step('--recognizer "$WEIGHTS/recognizer.onnx" --out "$GAME/bank.json"'),
    Step('cardvision infer "$GAME/video.mp4" --every 5'),
    Step('cardvision make-composites --catalog "$GAME/catalog.json"'),
    Step('cardvision infer "$GAME/scenes/images"'),
    Step('cardvision evaluate hover --scenes "$GAME/scenes"'),
    Step('cp "$WEIGHTS"/{detector.onnx,recognizer.onnx,accept.json} "$GAME/release/"'),
    Step('npm run demo -- --release "$GAME/release" --images "$GAME/images" --file "$GAME/video.mp4"', run="npm"),
)

# Lines the page shows under "You should see something like" that the run must print too, with
# the scratch folders written as the page writes them.
MARKERS = (
    "[1/6] import-catalog: cards.csv -> $GAME/cardvision-try/catalog.json",
    "[2/6] check-catalog: the catalog and the images in $GAME/images",
    "[3/6] build-bank: one row per card image -> $GAME/cardvision-try/bank.json",
    "  20 / 20 cards",
    "[4/6] build-release and verify-release: the release folder $GAME/cardvision-try/release",
    "[5/6] infer: one frame every 1 s, at most 16 frame(s) of 15 s (never over 60; --every or --max-frames to change)",
    "if the video does not play in the demo (MPEG-4 Part 2), convert it first: ffmpeg -i $GAME/video.mp4 -c:v "
    "libx264 -pix_fmt yuv420p $GAME/video-h264.mp4, then give $GAME/video-h264.mp4 to --file",
    "[6/6] report: $GAME/cardvision-try/report.html",
    "Found and named: cards found in 15 of 15 frame(s), 75 of 75 face(s) named, 5 distinct card(s). Next: open the "
    "demo with the last line.",
    "report: $GAME/cardvision-try/report.html",
    "cd browser && npm ci && npm run demo -- --release $GAME/cardvision-try/release --images $GAME/images --file $GAME/video.mp4",
    f"columns: id <- '{ID_HEADER}', name <- 'Card Name', kind <- 'Type', image <- 'Image'",
    "extra (every column that is no field and no facet): Text",
    "check-bank-art on $GAME/images: 20 with a usable image, 0 with no image, 0 unreadable",
    "wrote $GAME/catalog.json: 20 card(s)",
    "20 cards (0 without art), identity rule: name, game: my-game",
    "card images: $GAME/images (20 catalog cards; 20 with a usable image)",
    "bank: $GAME/bank.json (20 rows of 128 values; 20 embedded, 0 kept from the base bank)",
    "identity groups: $GAME/bank.identity-groups.json",
    "cardvision infer: the contact sheet is $GAME/out/sheet.png",
    "cardvision infer: 3 frame(s), 15 face(s), 3 back(s), 15 named",
    "cardvision infer: boxes per frame, fewest / median / most: faces 5 / 5 / 5, backs 1 / 1 / 1",
    "wrote 3 scenes to $GAME/scenes: 25 positive faces showing 14 different cards, 10 more faces marked as ignore "
    "regions (too hidden or too small), 3 backs",
    "- events: 24 in 1 recording groups",
    "ok (my-game, 20 cards in the bank, 20 in the catalog; every file present, unchanged and consistent)",
    "bank: 20 of 20 rows record their source image (artV)",
)


def page_blocks(text: str) -> list[str]:
    """Every "Paste this" block of the page, in order."""
    return [block.strip() + "\n" for before, block in fenced_blocks(text) if PASTE.search(flat(before))]


def shown(text: str) -> str:
    """Every "You should see" block of the page, as one text."""
    return "\n".join(block for before, block in fenced_blocks(text) if "you should see" in flat(before))


def test_every_block_of_the_page_is_one_the_run_knows():
    """Each "Paste this" block is declared here, in page order, and says to run it from the
    repository's root; a new or moved block fails until it is declared."""
    text = PAGE.read_text(encoding="utf-8")
    blocks = page_blocks(text)
    assert len(blocks) == len(STEPS), [block.splitlines()[0] for block in blocks]
    for block, step in zip(blocks, STEPS):
        assert step.expect in block, (step.expect, block)
    assert blocks[0].startswith(VARIABLES)
    assert not any("export GAME=" in block or "export WEIGHTS=" in block for block in blocks[1:])
    befores = [before for before, block in fenced_blocks(text) if PASTE.search(flat(before))]
    assert all("from the repository's root" in flat(before) for before in befores)


def test_every_line_checked_in_the_run_is_shown_in_the_page():
    text = shown(PAGE.read_text(encoding="utf-8"))
    for line in MARKERS:
        assert line in text, line


def test_the_page_names_the_spreadsheet_and_the_way_on():
    text = PAGE.read_text(encoding="utf-8")
    first = text.split("\n\n", 3)[2]
    assert "spreadsheet" in first
    for target in ("(extension.md)", "(train.md)", "(measure.md)"):
        assert target in text


def write_inputs(game: Path, weights: Path, scratch: Path) -> None:
    """What a reader brings, made from the demo's toy files: the list, the images, the video;
    and three files of a stand-in release as the released weights."""
    cv2 = pytest.importorskip("cv2")
    pytest.importorskip("onnx")
    import test_browser_fixtures

    demo = scratch / "demo"
    test_browser_fixtures.write_demo(demo)
    game.mkdir(parents=True)
    weights.mkdir(parents=True)
    for name in ("detector.onnx", "recognizer.onnx", "accept.json"):
        shutil.copy(demo / "release" / name, weights / name)
    shutil.copytree(demo / "art", game / "images")
    cards = json.loads((demo / "release" / "catalog.json").read_text(encoding="utf-8"))["cards"]
    with (game / "cards.csv").open("w", encoding="utf-8", newline="") as file:
        writer = csv.writer(file)
        writer.writerow([ID_HEADER, "Card Name", "Type", "Image", "Text"])
        for card in cards:
            writer.writerow([card["id"], card["name"], card["kind"], card["art"] or "", "Draw a card, then discard one."])
    image = cv2.imread(str(demo / "table.png"))
    height, width = image.shape[:2]
    writer = cv2.VideoWriter(str(game / "video.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), 5.0, (width, height))
    for _ in range(75):    # 15 seconds at 5 frames a second
        writer.write(image)
    writer.release()


def test_the_page_runs_as_written_on_toy_files(tmp_path):
    if shutil.which("bash") is None:
        pytest.skip("the page's blocks are run with bash")
    home = tmp_path / "home"
    game, weights = home / "Downloads" / "my-game", home / "Downloads" / "cardvision-weights"
    write_inputs(game, weights, tmp_path)
    shim = tmp_path / "bin" / "cardvision"      # the command, from this checkout, with this Python
    shim.parent.mkdir()
    shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" -m cardvision "$@"\n', encoding="utf-8")
    shim.chmod(shim.stat().st_mode | stat.S_IXUSR)
    environment = {**os.environ, "HOME": str(home), "PATH": f"{shim.parent}{os.pathsep}{os.environ['PATH']}",
                   "PYTHONPATH": str(ROOT)}
    blocks = page_blocks(PAGE.read_text(encoding="utf-8"))
    output = []
    for block, step in zip(blocks, STEPS):
        if step.run in ("network", "open", "npm"):
            continue
        done = subprocess.run(["bash", "-c", "set -e\n" + blocks[0] + block], cwd=ROOT, env=environment,
                              capture_output=True, text=True, timeout=300)
        printed = (done.stdout + done.stderr).replace(str(game), "$GAME").replace(str(weights), "$WEIGHTS")
        # try's demo line starts with "npm ci && " where browser/node_modules is missing, which
        # depends on the checkout the test runs in; the page shows it as on a fresh clone.
        printed = printed.replace("cd browser && npm ci && npm run demo", "cd browser && npm run demo")
        printed = printed.replace("cd browser && npm run demo", "cd browser && npm ci && npm run demo")
        output.append(printed)
        if step.run == "fails":
            assert done.returncode != 0 and step.message in printed, printed
            assert not (game / "catalog.json").exists()
        else:
            assert done.returncode == 0, (block, printed)
    printed = "\n".join(output)
    missing = [line for line in MARKERS if line not in printed]
    assert missing == [], printed
    for path in ("cardvision-try/report.html", "cardvision-try/release/release.json", "catalog.json", "bank.json", "out/sheet.png", "out/results.jsonl", "out/annotated", "release/release.json",
                 "out-scenes/sheet.png", "out-scenes/results.jsonl"):
        assert (game / path).exists(), path
    assert len((game / "out" / "results.jsonl").read_text(encoding="utf-8").splitlines()) == 3


def test_the_page_s_try_line_is_the_one_the_commands_page_gives_and_its_flags_exist():
    """The three lines' `try` is the one docs/commands.md shows, and every flag in it is one the
    command declares; the page names the report and the paths it holds."""
    from cardvision.cli import build_parser

    assert TRY in (ROOT / "docs" / "commands.md").read_text(encoding="utf-8")
    page = PAGE.read_text(encoding="utf-8")
    assert TRY in page and 'cardvision fetch-weights "$WEIGHTS"' in page
    assert "absolute paths that name your home folder" in page
    import argparse

    commands = next(action for action in build_parser()._actions if isinstance(action, argparse._SubParsersAction))
    help_text = commands.choices["try"].format_help()
    for flag in ("--images", "--video", "--weights", "--overwrite", "--map"):
        assert flag in help_text, flag


def test_the_three_lines_elsewhere_are_the_page_s():
    """start-here.md's block activates the virtual environment, sets the two folders as the page does and then runs the page's
    three lines; playbooks/try-my-game.md's step 0.0 runs the same `try` line."""
    import textwrap

    start = (ROOT / "docs" / "start-here.md").read_text(encoding="utf-8")
    blocks = [textwrap.dedent(block).strip() for _, block in fenced_blocks(start)]
    three = ". .venv/bin/activate\n" + VARIABLES + "\n".join(['cardvision fetch-weights "$WEIGHTS"', TRY, 'open "$GAME/cardvision-try/report.html"'])
    assert three in blocks, blocks
    agents = (ROOT / "playbooks" / "try-my-game.md").read_text(encoding="utf-8")
    zero = agents[agents.index("## 0.0 "):agents.index("## 0.1 ")]
    assert any(TRY in block and VARIABLES in block for _, block in fenced_blocks(zero))
