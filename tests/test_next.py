# SPDX-License-Identifier: Apache-2.0
"""``cardvision next``: what it says of a game folder in each state, its JSON, where it looks by
default, and that it only looks.

The folders are made under ``tmp_path``. Most try runs are synthesized (the marker, the report,
``out/results.jsonl``, the catalog and the bank, with the inputs dated before the report); one
is a real run of ``cardvision try`` on the demo's toy files and stand-in weights.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

from cardvision import cli, next_step
from cardvision.try_game import run as try_run

ROOT = Path(__file__).resolve().parents[1]
CHECK_IDS = ["folder", "cards", "images", "video", "weights", "try", "verdict", "no-image"]


@pytest.fixture(autouse=True)
def demo_packages_installed(monkeypatch):
    monkeypatch.setattr(try_run, "demo_installed", lambda: True)


def ask(capsys, *argv) -> tuple[int, str, str]:
    code = cli.main(["next", *map(str, argv)])
    printed = capsys.readouterr()
    return code, printed.out, printed.err


def ask_json(capsys, *argv) -> dict:
    code, out, err = ask(capsys, *argv, "--json")
    assert code == 0, err
    return json.loads(out)


def states(found: dict) -> dict[str, str]:
    return {check["id"]: check["state"] for check in found["checks"]}


def weights_folder(tmp_path: Path) -> Path:
    folder = tmp_path / "weights"
    folder.mkdir(exist_ok=True)
    for name in try_run.WEIGHT_FILES:
        (folder / name).write_bytes(b"stand-in")
    return folder


def game_folder(tmp_path: Path, name: str = "my-game") -> Path:
    game = tmp_path / name
    (game / "images").mkdir(parents=True)
    (game / "cards.csv").write_text("id,name,image\nA-1,Alpha,a.png\nB-1,Beta,b.png\n", encoding="utf-8")
    (game / "images" / "a.png").write_bytes(b"png")
    (game / "images" / "b.png").write_bytes(b"png")
    (game / "video.mp4").write_bytes(b"mp4")
    return game


def face(card: str, accepted: bool) -> dict:
    return {"class": "face", "outcome": "named" if accepted else "unnamed", "accepted": accepted, "cardId": card}


def fake_run(game: Path, rows: list[dict], bank_ids: tuple[str, ...] = ("A-1", "B-1")) -> Path:
    """A completed run of try in ``game/cardvision-try``, dated after the inputs."""
    out = game / "cardvision-try"
    (out / "out").mkdir(parents=True)
    (out / "release").mkdir()
    catalog = {"game": "my-game", "locale": "en", "cards": [
        {"id": "A-1", "name": "Alpha", "kind": "unit", "printingOf": None, "art": "a.png"},
        {"id": "B-1", "name": "Beta", "kind": "unit", "printingOf": None, "art": "b.png"}]}
    (out / "catalog.json").write_text(json.dumps(catalog), encoding="utf-8")
    (out / "bank.json").write_text(json.dumps({"entries": [{"cardId": card} for card in bank_ids]}), encoding="utf-8")
    (out / "out" / "results.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    (out / "report.html").write_text("<p>report</p>", encoding="utf-8")
    try_run.write_marker(out, ["catalog.json", "bank.json", "out", "release", "report.html"])
    past = (out / "report.html").stat().st_mtime - 100
    for path in game.rglob("*"):
        if out not in path.parents and path != out:
            os.utime(path, (past, past))
    return out


NAMED = [{"boxes": [face("A-1", True), face("B-1", True)]}]
FEW = [{"boxes": [face("A-1", True), face("B-1", False), face("B-1", False)]}]
NONE = [{"boxes": [{"class": "back"}]}, {"boxes": []}]


def snapshot(*folders: Path) -> dict[str, tuple[int, int]]:
    seen = {}
    for folder in folders:
        for path in [folder, *folder.rglob("*")]:
            info = path.lstat()
            seen[str(path)] = (info.st_size, info.st_mtime_ns)
    return seen


# ------------------------------------------------------------------------------ the states
def test_no_folder_says_to_make_it_and_what_to_put_in_it(tmp_path, capsys):
    game = tmp_path / "my game"
    code, out, err = ask(capsys, game, "--weights", weights_folder(tmp_path))
    assert code == 0, err
    lines = out.splitlines()
    assert lines[0] == f"Looked at {game} (given as the argument)."
    assert "  missing  game folder: no such folder" in lines
    assert lines[lines.index("Next: make the game folder, then put three things in it:") + 1].startswith(
        "STOP (coding agents: ask the person first): the card list")
    assert f"  mkdir -p '{game}'" in lines
    assert sum(line.startswith("  - ") for line in lines) == 3
    assert 'Read: docs/your-game.md, "Your folders"' in lines
    assert lines[-1] == "Playbook (for coding agents): playbooks/try-my-game.md"
    assert not game.exists()


def test_an_empty_folder_lists_the_three_missing_inputs(tmp_path, capsys):
    game = tmp_path / "my-game"
    game.mkdir()
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert states(found)["folder"] == "done"
    assert [states(found)[key] for key in ("cards", "images", "video")] == ["missing"] * 3
    assert found["next"]["id"] == "cards" and len(found["next"]["notes"]) == 3
    assert found["next"]["stop"]["reason"] == "persons-file" and found["next"]["commands"] == []


def test_a_partial_folder_names_only_what_is_missing(tmp_path, capsys):
    game = game_folder(tmp_path)
    (game / "video.mp4").unlink()
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert states(found)["cards"] == "done" and states(found)["images"] == "done"
    assert found["next"]["id"] == "video" and len(found["next"]["notes"]) == 1
    assert found["next"]["notes"][0].startswith("video.mp4")


def test_a_spreadsheet_is_named_for_export(tmp_path, capsys):
    game = game_folder(tmp_path)
    (game / "cards.csv").unlink()
    (game / "My Cards.xlsx").write_bytes(b"xlsx")
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    cards = found["checks"][1]
    assert cards["state"] == "missing" and "My Cards.xlsx must be exported as CSV" in cards["detail"]


def test_several_lists_with_a_likely_one_go_on_with_it(tmp_path, capsys):
    game = game_folder(tmp_path)
    (game / "old.tsv").write_text("id\tname\n", encoding="utf-8")
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert states(found)["cards"] == "choice" and "the next step takes cards.csv" in found["checks"][1]["detail"]
    assert found["next"]["id"] == "try" and found["next"]["stop"] is None
    assert found["next"]["commands"][0].startswith(f"cardvision try {game / 'cards.csv'} ")
    assert any("the most likely of several" in note for note in found["next"]["notes"])
    assert found["checks"][1]["taken"] == str(game / "cards.csv") and found["checks"][1]["blocks"] is False


def test_several_lists_without_a_likely_one_ask_for_a_choice(tmp_path, capsys):
    game = game_folder(tmp_path)
    (game / "cards.csv").rename(game / "one.csv")
    (game / "two.csv").write_text("id,name\n", encoding="utf-8")
    (game / "rows.json").write_text(json.dumps([{"id": "A-1"}]), encoding="utf-8")
    (game / "notes.json").write_text(json.dumps({"other": 1}), encoding="utf-8")   # no card list
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    cards = found["checks"][1]
    assert cards["state"] == "choice" and len(cards["paths"]) == 3 and "say which one" in cards["detail"]
    assert cards["taken"] is None and cards["blocks"] is True
    assert found["next"]["id"] == "cards" and found["next"]["stop"]["reason"] == "persons-choice"
    assert found["next"]["playbook"] == "playbooks/try-my-game.md"


def test_the_step_by_step_catalog_beside_the_list_is_no_second_list(tmp_path, capsys):
    game = game_folder(tmp_path)
    catalog = {"game": "g", "locale": "en", "cards": [{"id": "A-1", "name": "Alpha", "kind": "unit", "art": "a.png"}]}
    (game / "catalog.json").write_text(json.dumps(catalog), encoding="utf-8")
    (game / "bank.json").write_text(json.dumps({"entries": []}), encoding="utf-8")
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert states(found)["cards"] == "done" and found["checks"][1]["detail"] == "cards.csv"


def test_images_in_another_folder_and_several_videos(tmp_path, capsys):
    game = game_folder(tmp_path)
    (game / "images").rename(game / "Card Art")
    (game / "match.mov").write_bytes(b"mov")
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert found["checks"][2]["detail"] == "Card Art/ (2 files)"
    video = found["checks"][3]
    assert video["state"] == "choice" and "the next step takes video.mp4" in video["detail"]
    assert "--images '" + str(game / "Card Art") + "'" in found["next"]["commands"][0]


def test_several_videos_with_no_likely_one_and_a_folder_of_frames(tmp_path, capsys):
    game = game_folder(tmp_path)
    (game / "video.mp4").rename(game / "a.mp4")
    (game / "b.webm").write_bytes(b"webm")
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert found["next"]["id"] == "video" and found["next"]["stop"]["reason"] == "persons-choice"
    (game / "a.mp4").unlink()
    (game / "b.webm").unlink()
    (game / "frames").mkdir()
    (game / "frames" / "0001.jpg").write_bytes(b"jpg")
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert found["checks"][3] == {"id": "video", "state": "done", "detail": "frames/", "paths": [str(game / "frames")],
                                  "taken": None, "blocks": False, "source": None}


def test_missing_weights_give_the_fetch_line_and_a_download_stop(tmp_path, capsys):
    game = game_folder(tmp_path)
    weights = tmp_path / "no weights"
    code, out, _err = ask(capsys, game, "--weights", weights)
    assert code == 0
    lines = out.splitlines()
    assert f"  cardvision fetch-weights '{weights}'" in lines
    assert lines[lines.index("Next: download the released models (v0.1.0) into the weights folder:") + 1].startswith(
        "STOP (coding agents: ask the person first): this downloads files from the internet (eight files")
    found = ask_json(capsys, game, "--weights", weights)
    assert found["next"]["id"] == "weights" and found["next"]["stop"]["reason"] == "download"
    assert found["next"]["doc"] == "docs/your-game.md#the-three-lines"


def test_no_try_yet_gives_the_try_line_without_overwrite(tmp_path, capsys):
    game = game_folder(tmp_path)
    weights = weights_folder(tmp_path)
    found = ask_json(capsys, game, "--weights", weights)
    assert states(found)["try"] == "missing" and states(found)["verdict"] == "missing"
    assert found["next"]["commands"] == [f"cardvision try {game}/cards.csv --images {game}/images --video "
                                         f"{game}/video.mp4 --weights {weights}"]
    assert found["next"]["stop"] is None and found["verdict"] is None and found["noImage"] is None


def test_inputs_newer_than_the_report_ask_for_try_again_with_overwrite(tmp_path, capsys):
    game = game_folder(tmp_path)
    fake_run(game, NAMED)
    (game / "images" / "HD").mkdir()
    (game / "images" / "HD" / "c.png").write_bytes(b"png")   # newest file, below the folder
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    check = found["checks"][5]
    assert check["state"] == "changed"
    assert check["detail"] == "images/HD/c.png is newer than the last try's report (edited, or copied again?)"
    assert any(note.startswith("if nothing was edited") and "report.html" in note for note in found["next"]["notes"])
    assert found["next"]["id"] == "try" and found["next"]["commands"][0].endswith(" --overwrite")
    assert found["verdict"]["kind"] == "named"


def test_several_newer_files_are_joined_with_and_and_take_are(tmp_path, capsys):
    game = game_folder(tmp_path)
    fake_run(game, NAMED)
    for name in ("cards.csv", "video.mp4"):
        os.utime(game / name)
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert found["checks"][5]["detail"] == ("cards.csv and video.mp4 are newer than the last try's report "
                                            "(edited, or copied again?)")
    (game / "images" / "a.png").touch()
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert found["checks"][5]["detail"].startswith("cards.csv, images/a.png and video.mp4 are newer")


def log_images(out: Path, images: Path) -> None:
    """A try.log as try writes it, its check-catalog line naming ``images``, and the marker listing it."""
    words = ["check-catalog", out / "catalog.json", "--art", images]
    (out / "try.log").write_text("$ cardvision " + " ".join(try_run.log_word(str(word)) for word in words)
                                 + "\n(exit code 0)\n\n", encoding="utf-8")
    try_run.write_marker(out, ["catalog.json", "bank.json", "out", "release", "report.html", "try.log"])


def test_the_images_folder_the_last_try_used_counts_even_outside_the_game_folder(tmp_path, capsys):
    game = game_folder(tmp_path)
    shutil.rmtree(game / "images")
    elsewhere = tmp_path / "card art" / "cards"
    elsewhere.mkdir(parents=True)
    (elsewhere / "a.png").write_bytes(b"png")
    out = fake_run(game, NAMED)
    log_images(out, elsewhere)
    weights = weights_folder(tmp_path)
    found = ask_json(capsys, game, "--weights", weights)
    images = found["checks"][2]
    assert images == {"id": "images", "state": "done", "detail": f"{elsewhere}/ (1 file, from the last try)",
                      "paths": [str(elsewhere)], "taken": None, "blocks": False, "source": "last-try"}
    assert found["next"]["id"] == "demo" and f"--images '{elsewhere}'" in found["next"]["commands"][0]
    # Its files count for "changed" too, and the try line takes the folder.
    os.utime(elsewhere / "a.png")
    found = ask_json(capsys, game, "--weights", weights)
    assert found["checks"][5]["state"] == "changed" and found["next"]["stop"] is None
    assert f"--images '{elsewhere}' " in found["next"]["commands"][0]
    # Once that folder is gone, the game folder is looked at again.
    shutil.rmtree(elsewhere)
    found = ask_json(capsys, game, "--weights", weights)
    assert found["checks"][2]["state"] == "missing" and found["next"]["stop"]["reason"] == "persons-file"


def test_the_last_try_s_images_are_read_from_its_log_only(tmp_path):
    out = tmp_path / "run"
    out.mkdir()
    assert next_step.images_of_last_try(out) is None
    (out / "try.log").write_text("$ cardvision import-catalog x --images /a\n$ cardvision check-catalog c.json\n",
                                 encoding="utf-8")
    assert next_step.images_of_last_try(out) is None
    log_images(out, tmp_path / "it's here")
    assert next_step.images_of_last_try(out) == tmp_path / "it's here"


def test_an_unreadable_run_is_run_again(tmp_path, capsys):
    game = game_folder(tmp_path)
    out = fake_run(game, NAMED)
    (out / "out" / "results.jsonl").write_text("{not json\n", encoding="utf-8")
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert states(found)["try"] == "missing" and found["next"]["commands"][0].endswith(" --overwrite")


def test_a_folder_without_a_marker_is_no_run(tmp_path, capsys):
    game = game_folder(tmp_path)
    (game / "cardvision-try").mkdir()
    (game / "cardvision-try" / "report.html").write_text("mine", encoding="utf-8")
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert states(found)["try"] == "missing" and "report.html, which try did not write" in found["checks"][5]["detail"]
    assert not found["next"]["commands"][0].endswith("--overwrite")
    assert any("move them out first" in note for note in found["next"]["notes"])


def test_verdict_named_gives_the_demo_line_then_the_extension(tmp_path, capsys):
    game = game_folder(tmp_path)
    out = fake_run(game, NAMED)
    code, text, _err = ask(capsys, game, "--weights", weights_folder(tmp_path))
    assert code == 0
    lines = text.splitlines()
    assert "  done     verdict: found and named (2 of 2 faces named, 2 distinct cards)" in lines
    assert "  done     cards with no image: none of the 2 cards in your list" in lines
    assert f"  {try_run.demo_line(out / 'release', game / 'images', game / 'video.mp4')}" in lines
    assert 'Read: docs/extension.md' in lines and not any(line.startswith("STOP") for line in lines)
    assert any("docs/measure.md" in line for line in lines) and any("not tracked here" in line for line in lines)
    assert lines[-1] == "Playbook (for coding agents): playbooks/make-extension.md"


def test_the_demo_line_installs_the_packages_when_they_are_not(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(try_run, "demo_installed", lambda: False)
    game = game_folder(tmp_path)
    fake_run(game, NAMED)
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert found["next"]["commands"][0].startswith("cd browser && npm ci && npm run demo")


def test_verdict_few_points_to_the_contact_sheet_and_training(tmp_path, capsys):
    game = game_folder(tmp_path)
    fake_run(game, FEW)
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert found["verdict"] == {"kind": "few", "frames": 1, "framesWithFaces": 1, "faces": 3, "backs": 0, "named": 1,
                                "distinct": 1}
    assert found["next"]["id"] == "train" and "contact sheet" in found["next"]["say"]
    assert found["next"]["doc"] == "docs/train.md" and found["next"]["playbook"] == "playbooks/train.md"
    assert found["next"]["stop"]["reason"] == "spend-or-time"


def test_verdict_none_asks_for_a_clearer_view_first(tmp_path, capsys):
    game = game_folder(tmp_path)
    fake_run(game, NONE)
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert found["verdict"]["kind"] == "none" and found["next"]["id"] == "clearer-view"
    assert found["next"]["doc"] == "docs/your-game.md#5-read-the-result"
    assert any("docs/train.md" in line for line in found["next"]["after"])
    assert found["next"]["playbook"] == "playbooks/train.md" and found["next"]["stop"]["reason"] == "persons-file"


def test_named_with_cards_that_have_no_image_adds_them_before_the_demo(tmp_path, capsys):
    game = game_folder(tmp_path)
    fake_run(game, NAMED, bank_ids=("A-1",))
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert found["noImage"] == {"none": 1, "own": 0, "total": 2}
    assert states(found)["no-image"] == "missing"
    assert found["next"]["id"] == "add-images" and "(B-1)" in found["next"]["say"]
    assert found["next"]["commands"][0].endswith(" --overwrite")
    assert found["next"]["stop"]["reason"] == "persons-file"
    assert found["next"]["playbook"] == "playbooks/try-my-game.md"


# ------------------------------------------------------------------------------ the contract
def test_the_json_schema_and_its_ids(tmp_path, capsys):
    game = game_folder(tmp_path)
    fake_run(game, NAMED)
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert list(found) == ["schemaVersion", "game", "weights", "checks", "next", "verdict", "noImage"]
    assert found["schemaVersion"] == 1
    assert found["game"] == {"path": str(game), "chosen": "argument"}
    assert [check["id"] for check in found["checks"]] == CHECK_IDS
    for check in found["checks"]:
        assert list(check) == ["id", "state", "detail", "paths", "taken", "blocks", "source"]
        assert check["state"] in next_step.STATES and isinstance(check["blocks"], bool)
    assert [check["source"] for check in found["checks"]] == [None, None, "game-folder", None, "argument", None, None,
                                                              None]
    assert list(found["next"]) == ["id", "say", "stop", "notes", "commands", "doc", "after", "playbook"]
    assert found["noImage"] == {"none": 0, "own": 0, "total": 2}


def test_every_step_has_a_playbook_and_the_stops_are_the_agreed_ones():
    assert next_step.PLAYBOOKS == {
        "folder": "playbooks/try-my-game.md", "cards": "playbooks/try-my-game.md",
        "images": "playbooks/try-my-game.md", "video": "playbooks/try-my-game.md",
        "weights": "playbooks/try-my-game.md", "try": "playbooks/try-my-game.md",
        "add-images": "playbooks/try-my-game.md", "demo": "playbooks/make-extension.md",
        "clearer-view": "playbooks/train.md", "train": "playbooks/train.md", "folder-access": "playbooks/try-my-game.md"}
    assert set(next_step.STOPS) == {"download", "persons-file", "persons-choice", "persons-permission", "spend-or-time"}
    assert not any("ask the person" in sentence for sentence in next_step.STOPS.values())
    assert "eight files" in next_step.STOPS["download"]


def test_the_docs_it_names_and_their_sections_exist():
    for doc in (next_step.YOUR_FOLDERS, next_step.THREE_LINES, next_step.Doc("docs/your-game.md", "5. Read the result")):
        text = (ROOT / doc.path).read_text(encoding="utf-8")
        assert f"# {doc.section}\n" in text, doc
    for name in ("docs/train.md", "docs/extension.md", "docs/measure.md", "docs/start-here.md"):
        assert (ROOT / name).is_file()


def test_commands_page_documents_the_fields():
    text = (ROOT / "docs" / "commands.md").read_text(encoding="utf-8")
    section = text[text.index("## `cardvision next`"):]
    for word in [*CHECK_IDS, *next_step.STATES, *next_step.STOPS, *next_step.PLAYBOOKS, "schemaVersion", "playbook",
                 "stop", "noImage"]:
        assert f"`{word}`" in section, word


# ------------------------------------------------------------------------------ where it looks
def test_game_and_weights_come_from_the_variables_else_the_defaults(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.delenv("GAME", raising=False)
    monkeypatch.delenv("WEIGHTS", raising=False)
    found = ask_json(capsys)
    assert found["game"] == {"path": str(tmp_path / "home" / "Downloads" / "my-game"), "chosen": "default"}
    assert found["weights"] == {"path": str(tmp_path / "home" / "Downloads" / "cardvision-weights"), "chosen": "default"}
    _code, out, _err = ask(capsys)
    assert out.splitlines()[0] == f"Looked at {tmp_path / 'home' / 'Downloads' / 'my-game'} (the default)."

    game, weights = game_folder(tmp_path), weights_folder(tmp_path)
    monkeypatch.setenv("GAME", str(game))
    monkeypatch.setenv("WEIGHTS", str(weights))
    found = ask_json(capsys)
    assert found["game"] == {"path": str(game), "chosen": "environment"}
    assert found["weights"] == {"path": str(weights), "chosen": "environment"}
    _code, out, _err = ask(capsys)
    assert out.splitlines()[0] == f"Looked at {game} (from $GAME)."
    assert f"  done     released weights: {weights} (from $WEIGHTS)" in out.splitlines()
    # The argument wins over the variable.
    other = tmp_path / "other"
    assert ask_json(capsys, other)["game"] == {"path": str(other), "chosen": "argument"}


def test_a_game_path_that_is_a_file_is_a_usage_error(tmp_path, capsys):
    game = game_folder(tmp_path)
    code, out, err = ask(capsys, game / "cards.csv")
    assert code == 2 and out == ""
    assert "is a file, not a folder" in err and f"cardvision next {game}" in err


def test_an_unknown_flag_is_a_usage_error(capsys):
    with pytest.raises(SystemExit) as stop:
        cli.main(["next", "--nope"])
    assert stop.value.code == 2


def test_it_only_looks(tmp_path, capsys):
    """Nothing under GAME or WEIGHTS is created or changed, in any state."""
    game = game_folder(tmp_path)
    weights = tmp_path / "weights"
    weights.mkdir()
    for prepare in (lambda: None, lambda: weights_folder(tmp_path), lambda: fake_run(game, NAMED),
                    lambda: (game / "images" / "new.png").write_bytes(b"png")):
        prepare()
        before = snapshot(tmp_path)
        for flags in ((), ("--json",)):
            code, _out, err = ask(capsys, game, "--weights", weights, *flags)
            assert code == 0, err
        assert snapshot(tmp_path) == before


def test_a_copied_game_folder_does_not_follow_the_original_s_images(tmp_path, capsys):
    game = game_folder(tmp_path, "A")
    shutil.rmtree(game / "images")
    art = tmp_path / "art"
    art.mkdir()
    (art / "a.png").write_bytes(b"png")
    out = fake_run(game, NAMED)
    log_images(out, art)
    assert ask_json(capsys, game, "--weights", weights_folder(tmp_path))["checks"][2]["source"] == "last-try"
    copy = tmp_path / "B"
    shutil.copytree(game, copy, symlinks=True)
    # A's images are still there, but B's log names A's catalog: B does not take them.
    found = ask_json(capsys, copy, "--weights", weights_folder(tmp_path))
    assert found["checks"][2]["state"] == "missing" and found["checks"][2]["source"] is None
    assert next_step.images_of_last_try(copy / "cardvision-try") is None


def test_a_crafted_log_naming_another_catalog_is_ignored(tmp_path, capsys):
    game = game_folder(tmp_path)
    out = fake_run(game, NAMED)
    (out / "try.log").write_text(f"$ cardvision check-catalog {tmp_path}/elsewhere/catalog.json --art /usr\n",
                                 encoding="utf-8")
    try_run.write_marker(out, ["catalog.json", "bank.json", "out", "release", "report.html", "try.log"])
    assert next_step.images_of_last_try(out) is None
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert found["checks"][2]["detail"] == "images/ (2 files)" and found["checks"][2]["source"] == "game-folder"


@pytest.mark.parametrize("which", ["root", "home", "parent", "grandparent"])
def test_a_logged_images_folder_that_holds_the_game_s_parent_is_refused(tmp_path, capsys, monkeypatch, which):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    game = game_folder(tmp_path / "home" / "Downloads")
    out = fake_run(game, NAMED)
    art = {"root": Path("/"), "home": tmp_path / "home", "parent": game.parent, "grandparent": game.parent.parent}[which]
    log_images(out, art)
    assert next_step.images_of_last_try(out) == art    # the log names it, and it is this run's
    assert next_step.too_wide(art, game)
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert found["checks"][2]["source"] == "game-folder" and found["checks"][2]["detail"] == "images/ (2 files)"


def test_a_sibling_or_inner_images_folder_is_not_too_wide(tmp_path):
    game = tmp_path / "Downloads" / "my-game"
    assert not next_step.too_wide(tmp_path / "Downloads" / "art", game)
    assert not next_step.too_wide(game / "images", game)


def test_weights_from_the_last_try_s_download_are_taken(tmp_path, capsys):
    game = game_folder(tmp_path)
    downloaded = game / "cardvision-try" / "weights"
    downloaded.mkdir(parents=True)
    for name in try_run.WEIGHT_FILES:
        (downloaded / name).write_bytes(b"stand-in")
    found = ask_json(capsys, game, "--weights", tmp_path / "none here")
    weights = found["checks"][4]
    assert weights["state"] == "done" and weights["source"] == "last-try-download"
    assert weights["detail"] == "cardvision-try/weights/ (from the last try's download)"
    assert found["weights"] == {"path": str(tmp_path / "none here"), "chosen": "argument"}
    assert found["next"]["id"] == "try" and found["next"]["commands"][0].endswith(f"--weights {downloaded}")


def test_an_unreadable_game_folder_says_how_to_allow_it(tmp_path, capsys):
    game = game_folder(tmp_path)
    game.chmod(0)
    try:
        try:
            os.listdir(game)
        except PermissionError:
            pass
        else:
            pytest.skip("this user reads a folder with no permissions (root)")
        code, out, err = ask(capsys, game, "--weights", weights_folder(tmp_path))
        assert code == 0, err
        assert "  missing  game folder: can't read it (Permission denied)" in out.splitlines()
        assert "Files and Folders" in out and "Traceback" not in err
        assert "  missing  card list: the game folder can't be read" in out.splitlines()
        assert f"  - elsewhere: check the folder's permissions (ls -ld {game})" in out.splitlines()
        found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
        assert found["next"]["id"] == "folder-access" and found["next"]["stop"]["reason"] == "persons-permission"
    finally:
        game.chmod(0o755)


def test_a_name_that_is_not_utf_8_is_printed_escaped(tmp_path, monkeypatch):
    raw = io.BytesIO()
    monkeypatch.setattr(sys, "stdout", io.TextIOWrapper(raw, encoding="utf-8", errors="strict"))
    game = Path(os.fsdecode(os.fsencode(str(tmp_path)) + b"/bad\xffname"))
    code = next_step.run(argparse.Namespace(game=game, weights=tmp_path, json=False))
    sys.stdout.flush()
    assert code == 0 and b"bad\\udcffname" in raw.getvalue() and b"bad\\xffname" not in raw.getvalue()


def test_paths_are_collapsed_and_a_windows_path_gets_a_hint(tmp_path, capsys, monkeypatch):
    monkeypatch.chdir(tmp_path)
    found = ask_json(capsys, "x/../my-game")
    assert found["game"]["path"] == str(tmp_path / "my-game")
    code, out, _err = ask(capsys, "C:\\Users\\me\\my-game")
    assert code == 0 and "it looks like a Windows path: in WSL, write it as /mnt/c/Users/" in out
    assert any(line.startswith("  - it looks like a Windows path") for line in out.splitlines())
    assert "Windows path" not in ask(capsys, tmp_path / "my-game")[1]


def test_control_characters_in_names_are_escaped_outside_the_commands(tmp_path, capsys):
    game = game_folder(tmp_path)
    (game / "cards.csv").rename(game / "c\x1b[2Jards\r.csv")
    code, out, _err = ask(capsys, game, "--weights", weights_folder(tmp_path))
    assert code == 0
    lines = out.splitlines()
    assert "  done     card list: c\\x1b[2Jards\\r.csv" in lines
    assert "\x1b" not in out and "\r" not in out
    assert "Next: rename what is named below, then run cardvision next again:" in lines
    assert f"  - rename {game}/c\\x1b[2Jards\\r.csv: its name has control characters, which a terminal can't " \
           "take safely" in lines
    assert not any(line.startswith("  cardvision try") for line in lines)
    # A program gets the command as it is.
    found = ask_json(capsys, game, "--weights", weights_folder(tmp_path))
    assert found["next"]["commands"][0].startswith(f"cardvision try '{game}/c\x1b[2Jards\r.csv' ")


def test_a_control_character_in_a_folder_names_that_folder(tmp_path, capsys):
    game = game_folder(tmp_path, "my\x07game")
    _code, out, _err = ask(capsys, game, "--weights", weights_folder(tmp_path))
    assert f"  - rename {tmp_path}/my\\x07game: its name has control characters, which a terminal can't take " \
           "safely" in out.splitlines()
    assert "\x07" not in out


def test_a_folder_of_frames_is_the_video_once_the_last_try_names_the_card_images(tmp_path, capsys):
    """The layout of the real-run test below, with a synthesized run: no cv2 or onnx needed."""
    game = tmp_path / "my-game"
    game.mkdir()
    (game / "cards.csv").write_text("id,name,image\nA-1,Alpha,a.png\nB-1,Beta,b.png\n", encoding="utf-8")
    (game / "cards-art").mkdir()
    (game / "cards-art" / "a.png").write_bytes(b"png")
    (game / "frames").mkdir()
    (game / "frames" / "0001.jpg").write_bytes(b"jpg")
    weights = weights_folder(tmp_path)
    found = ask_json(capsys, game, "--weights", weights)
    assert found["next"]["id"] == "images" and "Rename the card images' folder to images/" in found["next"]["say"]
    out = fake_run(game, NAMED)
    log_images(out, game / "cards-art")
    found = ask_json(capsys, game, "--weights", weights)
    assert found["checks"][2]["source"] == "last-try"
    assert found["checks"][3]["state"] == "done" and found["checks"][3]["detail"] == "frames/"
    assert found["next"]["id"] == "demo"
    assert found["next"]["commands"] == [try_run.demo_line(out / "release", game / "cards-art",
                                                           game / "frames" / "0001.jpg")]


# ------------------------------------------------------------------------------ a real run
@pytest.fixture(scope="module")
def demo(tmp_path_factory):
    pytest.importorskip("cv2")
    pytest.importorskip("onnx")
    import test_browser_fixtures

    folder = tmp_path_factory.mktemp("demo")
    test_browser_fixtures.write_demo(folder)
    return folder


def test_after_a_real_try_it_says_found_and_named_and_shows_the_demo_line(demo, tmp_path, capsys):
    game = tmp_path / "my-game"
    game.mkdir()
    cards = json.loads((demo / "release" / "catalog.json").read_text(encoding="utf-8"))["cards"]
    with (game / "cards.csv").open("w", encoding="utf-8", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["id", "name", "kind", "image"])
        for card in cards:
            writer.writerow([card["id"], card["name"], card["kind"], card["art"] or ""])
    shutil.copytree(demo / "art", game / "images")
    shutil.copyfile(demo / "table.png", game / "table.png")
    found = ask_json(capsys, game, "--weights", demo / "release")
    assert found["next"]["id"] == "try" and found["checks"][3]["detail"] == "table.png"
    command = found["next"]["commands"][0]
    assert command == (f"cardvision try {game}/cards.csv --images {game}/images --video {game}/table.png "
                       f"--weights {demo / 'release'}")
    assert cli.main(command.split()[1:]) == 0
    capsys.readouterr()
    found = ask_json(capsys, game, "--weights", demo / "release")
    assert states(found) == {key: "done" for key in CHECK_IDS}
    assert found["verdict"]["kind"] == "named" and found["next"]["id"] == "demo"
    assert found["next"]["commands"] == [try_run.demo_line(game / "cardvision-try" / "release", game / "images",
                                                           game / "table.png")]


def test_a_folder_of_frames_beside_another_picture_folder_is_the_video_after_try(demo, tmp_path, capsys):
    """``cards-art/`` (the card images), ``frames/`` (a picture) and ``cards.csv``, no video file:
    before a run the images are ambiguous; after ``try --images cards-art --video frames`` the
    run's images folder is known and ``frames/`` is the video."""
    game = tmp_path / "my-game"
    game.mkdir()
    cards = json.loads((demo / "release" / "catalog.json").read_text(encoding="utf-8"))["cards"]
    with (game / "cards.csv").open("w", encoding="utf-8", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["id", "name", "kind", "image"])
        for card in cards:
            writer.writerow([card["id"], card["name"], card["kind"], card["art"] or ""])
    shutil.copytree(demo / "art", game / "cards-art")
    (game / "frames").mkdir()
    shutil.copyfile(demo / "table.png", game / "frames" / "table.png")
    found = ask_json(capsys, game, "--weights", demo / "release")
    images = found["checks"][2]
    assert images["state"] == "choice" and images["blocks"] is True
    assert found["next"]["id"] == "images" and found["next"]["stop"]["reason"] == "persons-choice"
    assert "Rename the card images' folder to images/" in found["next"]["say"]
    assert "move the others out" not in found["next"]["say"]
    assert cli.main(["try", str(game / "cards.csv"), "--images", str(game / "cards-art"), "--video",
                     str(game / "frames"), "--weights", str(demo / "release")]) == 0
    capsys.readouterr()
    found = ask_json(capsys, game, "--weights", demo / "release")
    assert found["checks"][2]["source"] == "last-try" and found["checks"][2]["paths"] == [str(game / "cards-art")]
    assert found["checks"][3]["state"] == "done" and found["checks"][3]["detail"] == "frames/"
    assert states(found) == {key: "done" for key in CHECK_IDS} and found["next"]["id"] == "demo"
    assert found["next"]["commands"] == [try_run.demo_line(game / "cardvision-try" / "release", game / "cards-art",
                                                           game / "frames" / "table.png")]
