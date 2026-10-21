# SPDX-License-Identifier: Apache-2.0
"""``cardvision try``: the path of ``docs/your-game.md`` in one command, on toy files.

The weights are the three files of the demo's stand-in release; the card list is written from
its toy catalog; the video is the demo's toy table (a picture), or a short clip made from it.
Everything is written under ``tmp_path``: no image is ever written inside the repository.
"""

from __future__ import annotations

import csv
import json
import os
import re
import shutil
import urllib.error
from pathlib import Path

import pytest

from cardvision import cli
from cardvision.try_game import run as try_run
from cardvision.try_game.report import verdict

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def demo_packages_installed(monkeypatch):
    """The demo line as it reads where ``npm ci`` has run; a test that says otherwise patches it."""
    monkeypatch.setattr(try_run, "demo_installed", lambda: True)


@pytest.fixture(scope="module")
def demo(tmp_path_factory):
    pytest.importorskip("cv2")
    pytest.importorskip("onnx")
    import test_browser_fixtures

    folder = tmp_path_factory.mktemp("demo")
    test_browser_fixtures.write_demo(folder)
    return folder


def toy_cards(demo: Path) -> list[dict]:
    return json.loads((demo / "release" / "catalog.json").read_text(encoding="utf-8"))["cards"]


def write_sheet(path: Path, demo: Path, headers: list[str]) -> Path:
    """The toy catalog as a sheet: id, name, kind and image under ``headers``, then a text column."""
    with path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.writer(file)
        writer.writerow([*headers, "Text"])
        for card in toy_cards(demo):
            writer.writerow([card["id"], card["name"], card["kind"], card["art"] or "", "Draw a card."])
    return path


def write_clip(path: Path, demo: Path, fourcc: str = "mp4v", seconds: int = 4) -> Path:
    cv2 = pytest.importorskip("cv2")
    image = cv2.imread(str(demo / "table.png"))
    height, width = image.shape[:2]
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*fourcc), 5.0, (width, height))
    for _ in range(5 * seconds):
        writer.write(image)
    writer.release()
    return path


def try_it(capsys, *argv) -> tuple[int, list[str], str]:
    code = cli.main(["try", *map(str, argv)])
    printed = capsys.readouterr()
    return code, printed.out.splitlines(), printed.err


def test_a_card_list_a_picture_and_the_stand_in_weights_give_every_output_and_a_report(demo, tmp_path, capsys):
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                              "--weights", demo / "release")
    assert code == 0, err
    out = tmp_path / "cardvision-try"     # the default: beside the card list
    for name in ("catalog.json", "bank.json", "bank.identity-groups.json", "import-report.txt", "try.log",
                 "out/results.jsonl", "out/sheet.png", "out/annotated/table.jpg", "out/crops",
                 "release/release.json", "release/detector.onnx", "release/recognizer.onnx", "release/accept.json",
                 "release/catalog.json", "release/bank.json", "release/bank.identity-groups.json", "report.html"):
        assert (out / name).exists(), name
    # One progress line a step, then the verdict, the report and the demo line.
    assert [line[:5] for line in lines[:6]] == [f"[{i}/6]" for i in range(1, 7)]
    sentence, report_line, demo_line = lines[-3:]
    assert sentence.startswith("Found and named: cards found in 1 of 1 frame(s), 5 of 5 face(s) named, 5 distinct")
    assert report_line == f"report: {out / 'report.html'}"
    assert demo_line == (f"cd browser && npm run demo -- --release {try_run.shell_arg(str(out / 'release'))} "
                         f"--images {try_run.shell_arg(str((demo / 'art').resolve()))} "
                         f"--file {try_run.shell_arg(str((demo / 'table.png').resolve()))}")
    page = (out / "report.html").read_text(encoding="utf-8")
    assert "Found and named" in page and "cd browser &amp;&amp; npm run demo -- --release" in page
    assert "extension.md" in page and "calibrated for the released game" in page
    assert "Columns taken" in page and "Coral Triangle: TOY-003, TOY-003A" in page
    # Self-contained: no script, and every link and picture relative.
    assert "<script" not in page.lower()
    for target in re.findall(r'(?:href|src)="([^"]*)"', page):
        assert not re.match(r"[a-z]+:|/", target), target
    assert 'src="out/sheet.png"' in page and 'src="out/annotated/table.jpg"' in page
    # The importer's report is kept whole.
    assert "wrote " in (out / "import-report.txt").read_text(encoding="utf-8")
    log = (out / "try.log").read_text(encoding="utf-8")
    assert all(f"$ cardvision {name}" in log for name in ("import-catalog", "check-catalog", "build-bank",
                                                           "build-release", "verify-release", "infer"))

    # Again, without --overwrite: refused, and nothing changed.
    before = (out / "report.html").stat().st_mtime_ns
    code, _lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                               "--weights", demo / "release")
    assert code == 1 and "--overwrite" in err and (out / "report.html").stat().st_mtime_ns == before
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                              "--weights", demo / "release", "--overwrite")
    assert code == 0, err
    assert lines[-3].startswith("Found and named")


def test_a_catalog_is_used_as_it_is(demo, tmp_path, capsys):
    catalog = tmp_path / "my catalog.json"
    shutil.copy(demo / "release" / "catalog.json", catalog)
    out = tmp_path / "run"
    code, lines, err = try_it(capsys, catalog, "--images", demo / "art", "--video", demo / "table.png",
                              "--weights", demo / "release", "--out", out)
    assert code == 0, err
    assert "is one already, used as it is" in lines[0]
    assert (out / "catalog.json").read_bytes() == catalog.read_bytes()
    assert not (out / "import-report.json").exists()
    assert "import-catalog" not in (out / "try.log").read_text(encoding="utf-8")
    assert "is a catalog already" in (out / "report.html").read_text(encoding="utf-8")
    assert lines[-3].startswith("Found and named")


def test_a_vanguard_shaped_sheet_needs_no_map(demo, tmp_path, capsys):
    cards = write_sheet(tmp_path / "sheet.csv", demo, ["Card No.", "Card Name", "Grade", "Image"])
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                              "--weights", demo / "release")
    assert code == 0, err
    text = (tmp_path / "cardvision-try" / "import-report.txt").read_text(encoding="utf-8")
    assert "columns: id <- 'Card No.', name <- 'Card Name', image <- 'Image'" in text


def test_a_list_whose_id_column_is_not_found_stops_with_the_importer_message_and_leaves_nothing(demo, tmp_path,
                                                                                                capsys):
    cards = write_sheet(tmp_path / "cards.csv", demo, ["Collector #", "Card Name", "Type", "Image"])
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                              "--weights", demo / "release")
    assert code == 1
    assert "no column for the card's id: name it with --map id=HEADER" in err and "--map FIELD=HEADER" in err
    assert not (tmp_path / "cardvision-try").exists()
    # The same list with --map goes through: the importer's flags are passed on.
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                              "--weights", demo / "release", "--map", "id=Collector #")
    assert code == 0, err


def test_none_of_the_images_found_is_the_importer_error_and_nothing_is_written(demo, tmp_path, capsys):
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    empty = tmp_path / "no-images"
    empty.mkdir()
    code, _lines, err = try_it(capsys, cards, "--images", empty, "--video", demo / "table.png",
                               "--weights", demo / "release")
    assert code == 1 and "none of the" in err and "is under --images" in err
    assert not (tmp_path / "cardvision-try").exists()


def test_a_video_is_sampled_to_at_most_max_frames_and_an_mp4v_one_gets_the_h264_line(demo, tmp_path, capsys):
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    clip = write_clip(tmp_path / "clip.mp4", demo, "mp4v", seconds=6)
    out = tmp_path / "out"
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", clip, "--weights",
                              demo / "release", "--max-frames", "3", "--out", out)
    assert code == 0, err
    rows = (out / "out" / "results.jsonl").read_text(encoding="utf-8").splitlines()
    assert 1 <= len(rows) <= 3
    assert "never over 3" in lines[4]
    # The last three lines stay the verdict, the report and the demo line; the hint comes before them.
    assert lines[-4] == (f"if the video does not play in the demo (MPEG-4 Part 2), convert it first: ffmpeg -i {clip} -c:v libx264 "
                         f"-pix_fmt yuv420p {tmp_path / 'clip-h264.mp4'}, then give {tmp_path / 'clip-h264.mp4'} to --file")
    assert lines[-1].startswith("cd browser && npm run demo -- ") and lines[-1].endswith(f"--file {clip}")
    page = (out / "report.html").read_text(encoding="utf-8")
    assert "If the video does not play in the demo (MPEG-4 Part 2), convert it first: ffmpeg -i" in page


def test_a_webm_video_gets_no_conversion_line(demo, tmp_path, capsys):
    if not (demo / "table.webm").is_file():
        pytest.skip("OpenCV could not write the toy WebM")
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.webm",
                              "--weights", demo / "release", "--every", "2")
    assert code == 0, err
    assert lines[-1].startswith("cd browser && npm run demo") and not any("ffmpeg" in line for line in lines)


def test_no_cards_found_gives_the_detector_diagnosis(demo, tmp_path, capsys):
    import numpy as np
    from test_infer_toy_models import build_detector, detector_rows

    from cardvision.bank import release as R

    weights = tmp_path / "weights-blind"
    weights.mkdir()
    for name in ("recognizer.onnx", "accept.json"):
        shutil.copy(demo / "release" / name, weights / name)
    rows = np.zeros((R.yolox_anchor_count(640, 384), 7), dtype=np.float32)
    rows[:1] = detector_rows([(10, 10, 100, 100)], [0.21], [0])     # nothing reaches the threshold
    build_detector(weights / "detector.onnx", rows)
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png", "--weights", weights)
    assert code == 0, err
    assert lines[-3].startswith("No cards found") and "clearer, larger view" in lines[-3]
    page = (tmp_path / "cardvision-try" / "report.html").read_text(encoding="utf-8")
    assert "cardvision infer: table.png: highest score 0.21, threshold 0.30" in page and "train.md" in page


def test_a_folder_of_more_images_than_max_frames_is_thinned(demo, tmp_path, capsys):
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    frames = tmp_path / "frames"
    frames.mkdir()
    for index in range(5):
        shutil.copy(demo / "table.png", frames / f"f{index}.png")
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", frames, "--weights",
                              demo / "release", "--max-frames", "2")
    assert code == 0, err
    rows = [json.loads(line) for line in (tmp_path / "cardvision-try" / "out" / "results.jsonl").read_text().splitlines()]
    assert [row["frame"] for row in rows] == ["f0.png", "f4.png"]
    assert lines[-1].endswith(try_run.shell_arg(str((frames / "f0.png").resolve())))


def test_text_from_the_files_is_escaped_in_the_report(demo, tmp_path, capsys):
    folder = tmp_path / "a&b <i>"
    folder.mkdir()
    cards = write_sheet(folder / "<b>cards&.csv", demo, ["id", "name", "kind", "image"])
    code, _lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                               "--weights", demo / "release")
    assert code == 0, err
    page = (folder / "cardvision-try" / "report.html").read_text(encoding="utf-8")
    assert "<b>cards" not in page and "&lt;b&gt;cards&amp;.csv" in page
    assert "a&b <i>" not in page and "a&amp;b &lt;i&gt;" in page


def test_without_weights_it_stops_with_the_fetch_weights_line(demo, tmp_path, capsys):
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    code, _lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png")
    out = tmp_path / "cardvision-try"
    assert code == 1 and f"cardvision fetch-weights {out / 'weights'}" in err and "--download" in err
    assert not out.exists()
    # Weights in OUT/weights are found by themselves.
    (out / "weights").mkdir(parents=True)
    for name in try_run.WEIGHT_FILES:
        shutil.copy(demo / "release" / name, out / "weights" / name)
    code, _lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png")
    assert code == 0, err


def test_download_without_the_network_fails_before_writing_anything(demo, tmp_path, capsys, monkeypatch):
    class Offline:
        def open(self, *_args, **_kwargs):
            raise urllib.error.URLError("no network")

    # fetch-weights opens every request through an opener of its own; this one never reaches a host.
    monkeypatch.setattr("cardvision.fetch_weights.urllib.request.build_opener", lambda *_handlers: Offline())
    monkeypatch.setattr("cardvision.fetch_weights.urllib.request.urlopen",
                        lambda *_a, **_k: (_ for _ in ()).throw(urllib.error.URLError("no network")))
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png", "--download")
    assert code == 1
    assert any(line.startswith("downloading 8 files") for line in lines)   # the notice, before the request
    assert "could not fetch" in err and "could not be downloaded" in err
    assert not (tmp_path / "cardvision-try").exists()


def test_a_weights_folder_without_the_three_files_is_refused(demo, tmp_path, capsys):
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    code, _lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                               "--weights", tmp_path)
    assert code == 1 and "holds no detector.onnx, recognizer.onnx, accept.json" in err


def test_an_output_folder_inside_the_repository_is_refused(tmp_path, capsys):
    cards = tmp_path / "cards.csv"
    cards.write_text("id,name\nA,One\n", encoding="utf-8")
    code, _lines, err = try_it(capsys, cards, "--images", tmp_path, "--video", cards, "--out", ROOT / "try-out")
    assert code == 1 and "inside the repository" in err
    assert not (ROOT / "try-out").exists()


def test_shell_words_follow_the_demo_pages_h264_command():
    # The cases of browser/test/demo-view.test.ts.
    assert try_run.h264_command("it's.webm") == "ffmpeg -i 'it'\\''s.webm' -c:v libx264 -pix_fmt yuv420p 'it'\\''s-h264.mp4'"
    assert try_run.h264_command("clip.mp4") == "ffmpeg -i clip.mp4 -c:v libx264 -pix_fmt yuv420p clip-h264.mp4"
    assert try_run.h264_command("-clip.mp4") == "ffmpeg -i ./-clip.mp4 -c:v libx264 -pix_fmt yuv420p ./-clip-h264.mp4"
    assert try_run.h264_command("$x`y`.mp4") == "ffmpeg -i '$x`y`.mp4' -c:v libx264 -pix_fmt yuv420p '$x`y`-h264.mp4'"
    assert try_run.shell_arg("/a b/c.mp4") == "'/a b/c.mp4'"


@pytest.mark.parametrize("seconds, frames", [(15, 60), (600, 60), (7200, 60), (7200, 10), (30, 1), (0.5, 60)])
def test_the_chosen_interval_keeps_to_max_frames(seconds, frames):
    every = try_run.choose_every(seconds, frames)
    assert every >= try_run.MIN_EVERY
    assert try_run.expected_frames(seconds, every) <= frames
    assert try_run.choose_every(None, frames) == try_run.UNKNOWN_LENGTH_EVERY


def test_the_codec_decides_the_conversion_line():
    assert try_run.unplayable_codec(try_run.VideoFacts(10, "fmp4")) == "fmp4"
    assert try_run.unplayable_codec(try_run.VideoFacts(10, "hevc")) == "hevc"
    assert try_run.unplayable_codec(try_run.VideoFacts(10, "h264")) is None
    assert try_run.unplayable_codec(try_run.VideoFacts(10, "vp80")) is None
    assert try_run.unplayable_codec(try_run.VideoFacts(10, None)) is None


def test_the_verdict_has_three_outcomes():
    def frame(*boxes):
        return {"boxes": list(boxes)}

    named = {"class": "face", "outcome": "named", "accepted": True, "cardId": "A"}
    unnamed = {"class": "face", "outcome": "unknown", "accepted": False, "cardId": None}
    back = {"class": "back"}
    assert verdict([frame(named, back), frame()]).kind == "named"
    assert verdict([frame(named, unnamed)]).kind == "named"            # exactly half named: named
    assert verdict([frame(named, unnamed, unnamed)]).kind == "few"     # under half: few
    assert verdict([frame(named, unnamed, unnamed)]).kind == "few"
    assert verdict([frame(back), frame()]).kind == "none"
    found = verdict([frame(named, named, back), frame(unnamed)])
    assert (found.frames, found.frames_with_faces, found.faces, found.named, found.distinct, found.backs) == (2, 2, 3, 2, 1, 1)


# ------------------------------------------------------------------ what --overwrite may touch
def good_run(capsys, demo: Path, tmp_path: Path, out: Path, *more) -> list[str]:
    cards = tmp_path / "cards.csv"
    if not cards.exists():
        write_sheet(cards, demo, ["id", "name", "kind", "image"])
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                              "--weights", demo / "release", "--out", out, *more)
    assert code == 0, err
    return lines


def broken_video(tmp_path: Path) -> Path:
    clip = tmp_path / "broken.mp4"
    clip.write_bytes(b"this is not a video")
    return clip


def no_staging_left(out: Path) -> bool:
    return not any(path.name.startswith(try_run.STAGING_PREFIX) for path in out.iterdir())


def test_a_completed_run_writes_its_marker_and_no_staging_folder(demo, tmp_path, capsys):
    out = tmp_path / "out"
    good_run(capsys, demo, tmp_path, out)
    assert set(json.loads((out / try_run.MARKER).read_text())["wrote"]) == set(try_run.OUTPUTS)
    assert no_staging_left(out)
    assert ".try-new-" not in (out / "try.log").read_text() + (out / "import-report.txt").read_text()
    assert ".try-new-" not in (out / "report.html").read_text()


def test_a_failing_overwrite_run_leaves_the_earlier_run_as_it_was(demo, tmp_path, capsys):
    out = tmp_path / "out"
    good_run(capsys, demo, tmp_path, out)
    report, release = (out / "report.html").read_bytes(), (out / "release" / "release.json").read_bytes()
    code, _lines, err = try_it(capsys, tmp_path / "cards.csv", "--images", demo / "art", "--video",
                               broken_video(tmp_path), "--weights", demo / "release", "--out", out, "--overwrite")
    assert code == 1 and "infer stopped" in err
    assert (out / "report.html").read_bytes() == report and (out / "release" / "release.json").read_bytes() == release
    assert no_staging_left(out)
    # And one that succeeds replaces it.
    good_run(capsys, demo, tmp_path, out, "--overwrite")
    assert no_staging_left(out)


def test_files_try_did_not_write_are_never_replaced(demo, tmp_path, capsys):
    out = tmp_path / "game"
    (out / "out").mkdir(parents=True)
    (out / "out" / "thesis.docx").write_text("mine", encoding="utf-8")
    (out / "catalog.json").write_text("{}", encoding="utf-8")
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    for more in ([], ["--overwrite"]):
        code, _lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                                   "--weights", demo / "release", "--out", out, *more)
        assert code == 1 and "catalog.json, out, which cardvision try did not write" in err
        assert "move them, or choose another folder" in err and "earlier run" not in err
    assert (out / "out" / "thesis.docx").read_text() == "mine" and (out / "catalog.json").read_text() == "{}"
    assert sorted(path.name for path in out.iterdir()) == ["catalog.json", "out"]


def test_a_marker_covers_only_the_names_it_lists(demo, tmp_path, capsys):
    out = tmp_path / "out"
    good_run(capsys, demo, tmp_path, out)
    (out / try_run.MARKER).write_text(json.dumps({"wrote": ["report.html"]}), encoding="utf-8")
    code, _lines, err = try_it(capsys, tmp_path / "cards.csv", "--images", demo / "art", "--video", demo / "table.png",
                               "--weights", demo / "release", "--out", out, "--overwrite")
    assert code == 1 and "which cardvision try did not write" in err and "report.html" not in err.split("did not")[0]


def test_user_files_in_out_survive_a_late_failure_and_out_stays(demo, tmp_path, capsys):
    out = tmp_path / "game"
    out.mkdir()
    (out / "thesis.docx").write_text("mine", encoding="utf-8")
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    code, _lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", broken_video(tmp_path),
                               "--weights", demo / "release", "--out", out)
    assert code == 1 and "infer stopped" in err
    assert sorted(path.name for path in out.iterdir()) == ["thesis.docx"]


def test_an_empty_out_folder_the_user_made_is_kept_after_a_failure(demo, tmp_path, capsys):
    out = tmp_path / "made-by-me"
    out.mkdir()
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    code, _lines, _err = try_it(capsys, cards, "--images", demo / "art", "--video", broken_video(tmp_path),
                                "--weights", demo / "release", "--out", out)
    assert code == 1 and out.is_dir() and not any(out.iterdir())


def test_an_interrupted_run_removes_its_staging_folder(demo, tmp_path, capsys, monkeypatch):
    out = tmp_path / "out"
    good_run(capsys, demo, tmp_path, out)
    report = (out / "report.html").read_bytes()
    real = try_run.command

    def interrupted(argv, *rest, **named):
        if argv[0] == "infer":
            raise KeyboardInterrupt
        return real(argv, *rest, **named)

    monkeypatch.setattr(try_run, "command", interrupted)
    with pytest.raises(KeyboardInterrupt):
        cli.main(["try", str(tmp_path / "cards.csv"), "--images", str(demo / "art"), "--video",
                  str(demo / "table.png"), "--weights", str(demo / "release"), "--out", str(out), "--overwrite"])
    assert no_staging_left(out) and (out / "report.html").read_bytes() == report
    fresh = tmp_path / "fresh"
    with pytest.raises(KeyboardInterrupt):
        cli.main(["try", str(tmp_path / "cards.csv"), "--images", str(demo / "art"), "--video",
                  str(demo / "table.png"), "--weights", str(demo / "release"), "--out", str(fresh)])
    assert not fresh.exists()


@pytest.mark.parametrize("which", ["cards", "images", "video", "weights"])
def test_an_input_inside_an_output_name_is_refused(demo, tmp_path, capsys, which):
    out = tmp_path / "out"
    release = out / "release"
    release.mkdir(parents=True)
    paths = {"cards": write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"]),
             "images": demo / "art", "video": demo / "table.png", "weights": demo / "release"}
    if which == "cards":
        paths["cards"] = Path(shutil.copy(paths["cards"], release / "cards.csv"))
    elif which == "images":
        paths["images"] = Path(shutil.copytree(demo / "art", release / "art"))
    elif which == "video":
        paths["video"] = Path(shutil.copy(demo / "table.png", release / "table.png"))
    else:
        for name in try_run.WEIGHT_FILES:
            shutil.copy(demo / "release" / name, release / name)
        paths["weights"] = release
    code, _lines, err = try_it(capsys, paths["cards"], "--images", paths["images"], "--video", paths["video"],
                               "--weights", paths["weights"], "--out", out, "--overwrite")
    label = {"cards": "CARDS", "images": "--images", "video": "--video", "weights": "--weights"}[which]
    assert code == 1 and f"{label} " in err and "lies where this command writes" in err
    assert release.is_dir()


def test_an_earlier_runs_out_folder_as_a_symlink_is_replaced_without_following_it(demo, tmp_path, capsys):
    out = tmp_path / "out"
    good_run(capsys, demo, tmp_path, out)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "keep.txt").write_text("kept", encoding="utf-8")
    shutil.rmtree(out / "out")
    (out / "out").symlink_to(elsewhere, target_is_directory=True)
    good_run(capsys, demo, tmp_path, out, "--overwrite")
    assert not (out / "out").is_symlink() and (out / "out" / "results.jsonl").is_file()
    assert (elsewhere / "keep.txt").read_text() == "kept" and sorted(p.name for p in elsewhere.iterdir()) == ["keep.txt"]


def test_an_empty_video_folder_and_an_out_that_is_a_file_are_clear_errors(demo, tmp_path, capsys):
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    empty = tmp_path / "empty"
    empty.mkdir()
    code, _lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", empty, "--weights", demo / "release")
    assert code == 1 and "the folder holds no image files" in err and "Traceback" not in err
    a_file = tmp_path / "a-file"
    a_file.write_text("x", encoding="utf-8")
    code, _lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                               "--weights", demo / "release", "--out", a_file)
    assert code == 1 and "is a file, not a folder" in err


def test_a_commands_unexpected_error_is_reported_not_raised(tmp_path, monkeypatch):
    def broken(_argv):
        raise RuntimeError("went wrong")

    monkeypatch.setattr("cardvision.cli.main", broken)
    outcome = try_run.command(["infer"], try_run.Log(tmp_path / "log"))
    assert outcome.code == 1 and "RuntimeError: went wrong" in outcome.err


def test_a_video_that_does_not_state_its_length_is_measured(demo, tmp_path):
    cv2 = pytest.importorskip("cv2")
    clip = write_clip(tmp_path / "clip.mp4", demo, "mp4v", seconds=6)
    capture = cv2.VideoCapture(str(clip))
    try:
        assert try_run.measured_length(capture, cv2) == pytest.approx(6.0, abs=0.25)
    finally:
        capture.release()

    class Unstated:
        """A capture that states no frame count."""
        def __init__(self):
            self.inner = cv2.VideoCapture(str(clip))

        def get(self, prop):
            return 0.0 if prop == cv2.CAP_PROP_FRAME_COUNT else self.inner.get(prop)

        def grab(self):
            return self.inner.grab()

    unstated = Unstated()
    assert try_run.stated_length(unstated, cv2) is None
    assert try_run.measured_length(unstated, cv2) == pytest.approx(6.0, abs=0.25)
    unstated.inner.release()


# ------------------------------------------------------------------ the marker and the move
def test_a_marker_that_is_a_symlink_is_refused_and_never_written_through(demo, tmp_path, capsys):
    out = tmp_path / "out"
    good_run(capsys, demo, tmp_path, out)
    target = tmp_path / "outside.txt"
    target.write_text(json.dumps({"wrote": list(try_run.OUTPUTS)}), encoding="utf-8")
    (out / try_run.MARKER).unlink()
    (out / try_run.MARKER).symlink_to(target)
    report = (out / "report.html").read_bytes()
    code, _lines, err = try_it(capsys, tmp_path / "cards.csv", "--images", demo / "art", "--video", demo / "table.png",
                               "--weights", demo / "release", "--out", out, "--overwrite")
    assert code == 1 and "is a symbolic link" in err
    assert json.loads(target.read_text())["wrote"] == list(try_run.OUTPUTS)
    assert (out / "report.html").read_bytes() == report and no_staging_left(out)


def test_the_marker_is_written_by_a_rename_and_never_through_a_link(tmp_path):
    target = tmp_path / "outside.txt"
    target.write_text("keep", encoding="utf-8")
    (tmp_path / try_run.MARKER).symlink_to(target)
    with pytest.raises(try_run.TryError, match="symbolic link"):
        try_run.write_marker(tmp_path, ["report.html"])
    assert target.read_text() == "keep"
    (tmp_path / try_run.MARKER).unlink()
    try_run.write_marker(tmp_path, ["report.html"])
    assert json.loads((tmp_path / try_run.MARKER).read_text()) == {"wrote": ["report.html"]}
    assert sorted(p.name for p in tmp_path.iterdir()) == [try_run.MARKER, "outside.txt"]   # no temporary file left


@pytest.mark.parametrize("hostile", [["../x"], ["/abs"], ["."], ["/"], ["../x", "/abs", ".", "/", ".."]])
def test_a_marker_naming_things_outside_the_outputs_is_ignored(demo, tmp_path, capsys, hostile):
    out = tmp_path / "out"
    good_run(capsys, demo, tmp_path, out)
    (tmp_path / "x").write_text("outside", encoding="utf-8")
    # Only the hostile names: the outputs are then no run's, and refused.
    (out / try_run.MARKER).write_text(json.dumps({"wrote": hostile}), encoding="utf-8")
    assert try_run.earlier_run(out) == set()
    code, _lines, err = try_it(capsys, tmp_path / "cards.csv", "--images", demo / "art", "--video", demo / "table.png",
                               "--weights", demo / "release", "--out", out, "--overwrite")
    assert code == 1 and "did not write" in err
    # With the real names beside them: the run goes through, and touches nothing else.
    (out / try_run.MARKER).write_text(json.dumps({"wrote": [*hostile, *try_run.OUTPUTS]}), encoding="utf-8")
    good_run(capsys, demo, tmp_path, out, "--overwrite")
    assert (tmp_path / "x").read_text() == "outside" and (tmp_path / "cards.csv").is_file() and out.is_dir()
    assert json.loads((out / try_run.MARKER).read_text())["wrote"] == list(try_run.OUTPUTS)


def test_a_file_that_appears_in_out_during_the_run_is_kept_and_the_run_is_not(demo, tmp_path, capsys, monkeypatch):
    out = tmp_path / "out"
    real = try_run._steps

    def meanwhile(*args, **named):
        result = real(*args, **named)
        (out / "catalog.json").write_text("made meanwhile", encoding="utf-8")
        return result

    monkeypatch.setattr(try_run, "_steps", meanwhile)
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    code, _lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                               "--weights", demo / "release", "--out", out, "--overwrite")
    assert code == 1 and "while the run went, OUT changed" in err and "catalog.json" in err
    assert sorted(p.name for p in out.iterdir()) == ["catalog.json"]
    assert (out / "catalog.json").read_text() == "made meanwhile"


def test_leftover_staging_folders_are_mentioned_and_kept(demo, tmp_path, capsys):
    out = tmp_path / "out"
    good_run(capsys, demo, tmp_path, out)
    dead = out / f"{try_run.STAGING_PREFIX}999999999"
    dead.mkdir()
    (dead / "bank.json").write_text("{}", encoding="utf-8")
    lines = good_run(capsys, demo, tmp_path, out, "--overwrite")
    assert any(f"leftover {dead.name} folder(s) from an interrupted run; they are safe to delete" in line
               for line in lines)
    assert (dead / "bank.json").is_file()
    assert try_run.leftover_staging(out, out / "none") == [dead]
    running = out / f"{try_run.STAGING_PREFIX}{os.getpid()}"
    running.mkdir()
    assert try_run.leftover_staging(out, out / "none") == ([dead] if os.name == "posix" else [dead, running])


def test_an_interrupted_move_leaves_a_marker_for_both_runs_and_the_next_run_recovers(demo, tmp_path, capsys,
                                                                                    monkeypatch):
    out = tmp_path / "out"
    good_run(capsys, demo, tmp_path, out)
    real, moved = os.replace, []

    def stops(source, target):
        if Path(source).parent.name.startswith(try_run.STAGING_PREFIX):
            if len(moved) == 2:
                raise KeyboardInterrupt
            moved.append(Path(target).name)
        return real(source, target)

    monkeypatch.setattr(try_run.os, "replace", stops)
    with pytest.raises(KeyboardInterrupt):
        cli.main(["try", str(tmp_path / "cards.csv"), "--images", str(demo / "art"), "--video",
                  str(demo / "table.png"), "--weights", str(demo / "release"), "--out", str(out), "--overwrite"])
    monkeypatch.setattr(try_run.os, "replace", real)
    capsys.readouterr()
    assert set(json.loads((out / try_run.MARKER).read_text())["wrote"]) == set(try_run.OUTPUTS)
    assert len(moved) == 2 and all((out / name).exists() for name in moved)
    # The interrupted run's staging folder has this process's number, so the next run here takes
    # it for its own and clears it; from another process it would be reported as a leftover.
    good_run(capsys, demo, tmp_path, out, "--overwrite")
    assert json.loads((out / try_run.MARKER).read_text())["wrote"] == list(try_run.OUTPUTS)
    assert (out / "report.html").is_file() and no_staging_left(out)



# ------------------------------------------------------------------ rc fixes
def test_without_the_demo_packages_the_demo_line_installs_them_first(demo, tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(try_run, "demo_installed", lambda: False)
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                              "--weights", demo / "release")
    assert code == 0, err
    assert lines[-1].startswith("cd browser && npm ci && npm run demo -- --release ")
    assert "npm ci" not in lines[-3]
    page = (tmp_path / "cardvision-try" / "report.html").read_text(encoding="utf-8")
    assert "cd browser &amp;&amp; npm ci &amp;&amp; npm run demo" in page and "installs the page" in page


def test_with_the_demo_packages_the_demo_line_does_not_install(demo, tmp_path, capsys):
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", demo / "table.png",
                              "--weights", demo / "release")
    assert code == 0, err
    assert lines[-1].startswith("cd browser && npm run demo -- --release ") and "npm ci" not in "\n".join(lines)
    assert "npm ci" not in (tmp_path / "cardvision-try" / "report.html").read_text(encoding="utf-8")


def test_demo_installed_looks_for_the_browser_packages(tmp_path, monkeypatch):
    monkeypatch.undo()       # the real function, not the autouse stand-in
    monkeypatch.setattr(try_run, "repository_root", lambda: tmp_path)
    assert try_run.demo_installed() is False
    (tmp_path / "browser" / "node_modules").mkdir(parents=True)
    assert try_run.demo_installed() is True
    monkeypatch.setattr(try_run, "repository_root", lambda: None)
    assert try_run.demo_installed() is False


def test_a_few_named_verdict_says_names_show_and_training_names_more():
    named = {"class": "face", "outcome": "named", "accepted": True, "cardId": "A"}
    unnamed = {"class": "face", "outcome": "unknown", "accepted": False, "cardId": None}
    found = verdict([{"boxes": [named, unnamed, unnamed]}])
    assert found.kind == "few"
    assert "names show on 1 of 3 face(s)" in found.sentence and "many cards stay unnamed" in found.sentence
    assert "training (docs/train.md)" in found.sentence


def test_the_codec_hint_names_the_codec_in_words_and_is_in_the_report_for_every_verdict(demo, tmp_path, capsys):
    from test_infer_toy_models import build_detector, detector_rows
    import numpy as np

    from cardvision.bank import release as R

    assert try_run.codec_words("fmp4") == "MPEG-4 Part 2" and try_run.codec_words("hvc1") == "HEVC (H.265)"
    assert try_run.codec_words("abcd") == "abcd"
    weights = tmp_path / "weights-blind"
    weights.mkdir()
    for name in ("recognizer.onnx", "accept.json"):
        shutil.copy(demo / "release" / name, weights / name)
    rows = np.zeros((R.yolox_anchor_count(640, 384), 7), dtype=np.float32)
    rows[:1] = detector_rows([(10, 10, 100, 100)], [0.21], [0])
    build_detector(weights / "detector.onnx", rows)
    cards = write_sheet(tmp_path / "cards.csv", demo, ["id", "name", "kind", "image"])
    clip = write_clip(tmp_path / "clip.mp4", demo, "mp4v", seconds=2)
    code, lines, err = try_it(capsys, cards, "--images", demo / "art", "--video", clip, "--weights", weights)
    assert code == 0, err
    assert lines[-3].startswith("No cards found") and "(MPEG-4 Part 2)" in lines[-4]
    page = (tmp_path / "cardvision-try" / "report.html").read_text(encoding="utf-8")
    assert "If the video does not play in the demo (MPEG-4 Part 2), convert it first: ffmpeg -i" in page


def test_a_logged_command_pastes_back_to_the_same_words(tmp_path):
    import shlex

    argv = ["build-bank", "--catalog", tmp_path / "my cards" / "catalog.json", "--art", "-odd name", "--out",
            "it's.json", "--map", "id=Collector #", "--skip-missing-art"]
    log = try_run.Log(tmp_path / "log")
    log.add([str(a) for a in argv], try_run.Outcome(0, "", ""))
    line = log.parts[0].strip()
    assert line.startswith("$ cardvision build-bank --catalog ") and "./--" not in line
    words = shlex.split(line[2:])
    assert words[0] == "cardvision"
    expected = [str(a) for a in argv]
    expected[expected.index("-odd name")] = "./-odd name"     # a value that looks like a flag gets ./
    assert words[1:] == expected


@pytest.mark.parametrize("which", ["cards", "images", "video"])
def test_a_path_at_the_top_of_the_file_system_hints_at_an_empty_variable(tmp_path, capsys, which):
    cards = tmp_path / "cards.csv"
    cards.write_text("id,name\nA,One\n", encoding="utf-8")
    paths = {"cards": cards, "images": tmp_path, "video": cards}
    paths[which] = Path("/no-such-cardvision-file.csv")
    code, _lines, err = try_it(capsys, paths["cards"], "--images", paths["images"], "--video", paths["video"],
                               "--weights", tmp_path)
    assert code == 1 and "starts at the top of the file system" in err and "shell variable is empty" in err
