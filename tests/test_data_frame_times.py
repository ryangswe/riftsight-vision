# SPDX-License-Identifier: Apache-2.0
"""Frames are found by their own timestamps, at a constant frame rate and at a variable one.

Two kinds of generated video, and nothing downloaded:

- videos of constant frame rate, at the rates recordings and broadcasts commonly have. Here
  the frame for a time is the frame the rate names, and the tests check that for each of the
  first 300 frames, by time and by fingerprint;
- videos of variable frame rate, as a phone or a screen recorder writes them: a first frame
  that stays on screen for two and a half seconds, then frames of a sixtieth of a second to
  half a second. They are made with the ``ffmpeg`` program, as H.264 in MP4 and as VP9 in
  WebM, and the tests that read them are skipped when it is not installed.

The last tests take frames from such a recording as ``cardvision infer`` does, make rows of
them, and fetch the rows' frames from the same file.

Tests that read video are skipped when OpenCV is not installed.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from cardvision.data import extract, fetch
from cardvision.data.dhash import SAME_FRAME_MAX_HAMMING, dhash, hamming
from cardvision.data.schema import Row
from cardvision.infer.frames import read_video
from support_data import write_timed_video
from test_data_dhash import scene_frame

WIDTH, HEIGHT = 96, 54


def picture(number: int) -> np.ndarray:
    """Frame ``number`` of every video here: a picture with a fingerprint of its own."""
    return scene_frame(number, WIDTH, HEIGHT)


def quiet(_: str) -> None:
    pass


@pytest.fixture(autouse=True)
def decode_on_one_thread(monkeypatch):
    """The videos here are opened hundreds of times and are 96 by 54 pixels. OpenCV starts a
    decoding thread per processor on every open, and here that costs more than the decoding.
    So these tests decode on one thread, which gives the same frames. Recordings are larger and
    keep OpenCV's choice, as do the other tests that read video."""
    try:
        import cv2
    except ImportError:
        return
    opened = cv2.VideoCapture

    def one_thread(path, *rest):
        return opened(path, *rest) if rest else opened(path, cv2.CAP_ANY, [cv2.CAP_PROP_N_THREADS, 1])

    monkeypatch.setattr(cv2, "VideoCapture", one_thread)


def make_row(t: float, fingerprint: str | None, video_id: str = "own-table") -> Row:
    attributes = {} if fingerprint is None else {"frame_dhash": fingerprint}
    return Row(platform="local", video_id=video_id, t=t, frame_width=WIDTH, frame_height=HEIGHT, source_type="physical/phone",
               group="g-own", role="extra", trained_on=False, completeness="exhaustive-boxes", credit="Example Labeler",
               boxes=(), attributes=attributes)


# ---------------------------------------------------------------------- constant frame rates
# The frame rates that recordings and broadcasts commonly have, by name and as the exact rate.
RATES = {"23.976": 24000 / 1001, "24": 24.0, "25": 25.0, "29.97": 30000 / 1001, "30": 30.0, "50": 50.0,
         "59.94": 60000 / 1001, "60": 60.0}
CHECKED = 300       # the first frames of each video, every one of which is looked up


@pytest.fixture(scope="module", params=sorted(RATES, key=float))
def steady(request, tmp_path_factory) -> tuple[Path, float, list[str]]:
    """A video of constant frame rate, long enough for the second after frame 300, and the
    fingerprint of each of its frames."""
    cv2 = pytest.importorskip("cv2")
    rate = RATES[request.param]
    count = CHECKED + math.ceil(rate) + 2
    path = tmp_path_factory.mktemp("steady") / "steady.mp4"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), rate, (WIDTH, HEIGHT))
    assert writer.isOpened()
    for number in range(count):
        writer.write(np.ascontiguousarray(picture(number)[:, :, ::-1]))
    writer.release()
    return path, rate, [dhash(picture(number)) for number in range(count)]


def test_the_videos_here_are_decoded_on_one_thread(steady):
    cv2 = pytest.importorskip("cv2")
    capture = cv2.VideoCapture(str(steady[0]))
    try:
        assert capture.isOpened() and capture.get(cv2.CAP_PROP_N_THREADS) == 1
    finally:
        capture.release()


def test_at_a_constant_rate_a_time_gives_the_frame_the_rate_names(steady):
    """The frame for ``t`` is frame number ``floor(t * rate)``: every one of the first 300, read
    by seeking and, every seventh, by reading from the start of the file."""
    path, rate, prints = steady
    with extract.VideoReader(path) as reader:
        for number in range(CHECKED):
            frame = reader.frame_at(extract.mid_frame_time(number, rate))
            assert frame.index == number and frame.time == pytest.approx(number / rate, abs=1e-3)
            assert hamming(dhash(frame.rgb), prints[number]) <= SAME_FRAME_MAX_HAMMING
        # Backwards, and at the two ends of a frame's time on screen.
        for number in (299, 150, 151, 7, 0):
            assert reader.frame_at(number / rate + 1e-4).index == number
            assert reader.frame_at((number + 1) / rate - 2e-3).index == number
    with extract.VideoReader(path, exact=True) as reader:
        assert [reader.frame_at(extract.mid_frame_time(number, rate)).index for number in range(0, CHECKED, 7)] == list(range(0, CHECKED, 7))


@pytest.fixture
def fingerprint_once(monkeypatch):
    """Fingerprint each decoded picture once. The windows of neighboring times share most of
    their frames, and the fingerprint of a picture does not change."""
    known: dict[bytes, str] = {}

    def once(rgb: np.ndarray) -> str:
        key = rgb.tobytes()
        if key not in known:
            known[key] = dhash(rgb)
        return known[key]

    monkeypatch.setattr(extract, "dhash", once)


def test_at_a_constant_rate_a_fingerprint_is_matched_in_the_second_either_side(steady, fingerprint_once):
    """For each of the first 300 frames: the frames within a second of its time are the ones
    the rate names, no more and no fewer, and the frame nearest the fingerprint is the frame
    itself."""
    path, rate, prints = steady
    with extract.VideoReader(path) as reader, extract.VideoReader(path, exact=True) as counting:
        for number in range(CHECKED):
            t = extract.mid_frame_time(number, rate)
            expected = list(range(extract.frame_index(max(0.0, t - 1.0), rate), extract.frame_index(t + 1.0, rate) + 1))
            window = reader.frames_between(t - 1.0, t + 1.0)
            assert [frame.index for frame in window] == expected
            assert [frame.time for frame in window] == pytest.approx([index / rate for index in expected], abs=1e-3)
            frame, distance = extract.nearest_frame(window, prints[number], t)
            assert frame.index == number and distance <= SAME_FRAME_MAX_HAMMING
            if number % 7 == 0:
                assert [frame.index for frame in counting.frames_between(t - 1.0, t + 1.0)] == expected


def test_at_a_constant_rate_fetch_writes_the_frame_of_each_row(steady, tmp_path):
    """Through ``fetch_frames``: rows by time and rows by fingerprint, the fingerprint being
    that of the row's own frame, or of a frame up to a second earlier or later."""
    path, rate, prints = steady
    by_time = {number: make_row(extract.mid_frame_time(number, rate), None) for number in (0, 1, 29, 150, 299)}
    shifts = {40: 0, 100: round(0.9 * rate), 200: -round(0.9 * rate), 260: 1}
    by_print = {number + shift: make_row(extract.mid_frame_time(number, rate), prints[number + shift]) for number, shift in shifts.items()}
    summary = fetch.fetch_frames([*by_time.values(), *by_print.values()], tmp_path / "out", video_files={"own-table": path},
                                 image_format="png", say=quiet)
    assert summary.complete
    index = extract.read_index(tmp_path / "out")
    for number, row in {**by_time, **by_print}.items():
        entry = index[row.key]
        assert entry.frame_time == pytest.approx(number / rate, abs=1e-3)
        with Image.open(tmp_path / "out" / entry.file) as image:
            assert hamming(dhash(np.asarray(image.convert("RGB"))), prints[number]) <= SAME_FRAME_MAX_HAMMING


def test_a_window_wholly_past_the_end_of_the_file_fails_the_row(steady, tmp_path):
    """A row with a fingerprint is matched in the second either side of its time. Past the end
    of the file that second is cut short; where nothing of it is left, the row has failed, and
    the file's last frame is not compared with it."""
    path, rate, prints = steady
    last = len(prints) - 1
    end = last / rate                                    # the timestamp of the last frame
    rows = {
        "cut short": make_row(round(end + 0.5, 3), prints[last - 3]),                 # the time is past the end, the window is not
        "cut short, another picture": make_row(round(end + 0.6, 3), dhash(picture(5000))),
        "its start on the last frame": make_row(round(end + 1.0 + 0.5 / rate, 3), prints[last]),
        "past the end": make_row(round(end + 1.0 + 3.0 / rate, 3), prints[last]),     # the last frame would match
        "far past the end": make_row(round(end + 30.0, 3), prints[last]),
        "by time, past the end": make_row(round(end + 0.7, 3), None),
    }
    out = tmp_path / "out"
    summary = fetch.fetch_frames(list(rows.values()), out, video_files={"own-table": path}, image_format="png", say=quiet)
    index = extract.read_index(out)
    entry = {name: index[row.key] for name, row in rows.items()}
    assert [entry[name].status for name in rows] == ["ok", "unusable", "ok", "failed", "failed", "failed"] and not summary.complete
    assert entry["cut short"].frame_time == pytest.approx((last - 3) / rate, abs=1e-3)
    assert entry["cut short, another picture"].reason == "fingerprint"
    assert entry["its start on the last frame"].frame_time == pytest.approx(end, abs=1e-3)
    for name in ("past the end", "far past the end"):
        start = round(rows[name].t - 1.0, 6)
        assert f"the video ends before t={start}, where the window that runs to t={round(start + 2.0, 6)} starts" in entry[name].reason
        assert entry[name].file is None and entry[name].distance is None and entry[name].frame_time is None
        assert not (out / "frames" / extract.frame_file_name(rows[name], ".png")).exists()
    assert "the video ends before t=" in entry["by time, past the end"].reason
    for exact in (False, True):
        with extract.VideoReader(path, exact=exact) as reader:
            assert [frame.index for frame in reader.frames_between(end - 0.2, end + 5.0)] == list(range(extract.frame_index(end - 0.2, rate), last + 1))
            assert [frame.index for frame in reader.frames_between(end + 0.5 / rate, end + 5.0)] == [last]
            for start in (end + 3.0 / rate, end + 0.9, end + 1.1, end + 30.0):
                with pytest.raises(extract.FrameNotFound, match="the video ends before t=.*where the window"):
                    reader.frames_between(start, start + 2.0)


# ----------------------------------------------------------------------- variable frame rate
needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs the ffmpeg program")

# How long each frame of the recording stays on screen, in sixtieths of a second: the first for
# two and a half seconds, then a repeating run of short and long frames, for eight seconds.
TICK_RATE = 60
RUN = (1, 1, 2, 6, 1, 3, 15, 1, 1, 1, 2, 30, 2, 1)
TICKS = [150]
while sum(TICKS) < 8 * TICK_RATE:
    TICKS.append(RUN[(len(TICKS) - 1) % len(RUN)])
STARTS = [sum(TICKS[:number]) / TICK_RATE for number in range(len(TICKS))]     # each frame's timestamp
LAST = len(TICKS) - 1
PRINTS = [dhash(picture(number)) for number in range(len(TICKS))]
# A WebM file keeps timestamps to the millisecond, so a timestamp can be half of one off.
STAMP = 6e-4

AFTER_THE_LONG_FIRST = 1                                    # a sixtieth of a second, right after the long first frame
HALF_SECOND = next(number for number, ticks in enumerate(TICKS) if ticks == 30)
QUARTER_SECOND = next(number for number, ticks in enumerate(TICKS) if ticks == 15)


def on_screen(number: int) -> float:
    """A time at which frame ``number`` is on screen: halfway to the next frame, as a row carries it."""
    if number == LAST:
        return round(STARTS[LAST] + 0.004, 3)
    return round((STARTS[number] + STARTS[number + 1]) / 2.0, 3)


def shown(rgb: np.ndarray) -> int:
    """Which frame of the recording a decoded picture is."""
    found = dhash(rgb)
    number = min(range(len(PRINTS)), key=lambda candidate: hamming(found, PRINTS[candidate]))
    assert hamming(found, PRINTS[number]) <= SAME_FRAME_MAX_HAMMING
    return number


def on_screen_between(start: float, end: float) -> list[int]:
    """The frames on screen from ``start`` to ``end``, by the timestamps the recording was made with."""
    first = max((number for number, stamp in enumerate(STARTS) if stamp <= start), default=0)
    return [number for number, stamp in enumerate(STARTS) if number >= first and stamp <= end]


@pytest.fixture(scope="module", params=["mp4", "webm"])
def recording(request, tmp_path_factory) -> Path:
    """The recording of variable frame rate: H.264 in MP4, and VP9 in WebM."""
    pytest.importorskip("cv2")
    path = tmp_path_factory.mktemp("recording") / f"recording.{request.param}"
    if not write_timed_video(path, [picture(number) for number in range(len(TICKS))], TICKS, TICK_RATE):
        pytest.skip("this ffmpeg cannot write the test video")
    return path


def test_the_recording_s_frames_last_from_a_sixtieth_of_a_second_to_seconds():
    gaps = [later - earlier for earlier, later in zip(STARTS, STARTS[1:])]
    assert gaps[0] == 2.5 and min(gaps) == pytest.approx(1 / 60) and max(gaps[1:]) == pytest.approx(0.5)
    assert gaps[AFTER_THE_LONG_FIRST] == pytest.approx(1 / 60) and gaps[HALF_SECOND] == pytest.approx(0.5)
    assert all(STARTS[number] < on_screen(number) < STARTS[number + 1] for number in range(LAST))


@needs_ffmpeg
@pytest.mark.skipif(shutil.which("ffprobe") is None, reason="needs the ffprobe program")
def test_the_times_read_are_the_container_s(recording):
    """Every frame's time, as the reader gives it, is the presentation timestamp another
    program reads from the same file."""
    listed = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "json",
                             str(recording)], check=True, capture_output=True, text=True)
    stamps = [float(frame["pts_time"]) for frame in json.loads(listed.stdout)["frames"]]
    assert stamps == pytest.approx(STARTS, abs=STAMP)
    for exact in (True, False):
        with extract.VideoReader(recording, exact=exact) as reader:
            assert [frame.time for frame in reader.frames_between(0.0, 60.0)] == pytest.approx(stamps, abs=2e-6)
            assert [reader.frame_at(on_screen(number)).time for number in range(len(TICKS))] == pytest.approx(stamps, abs=2e-6)


@needs_ffmpeg
@pytest.mark.parametrize("exact", [False, True])
def test_at_a_variable_rate_a_time_gives_the_frame_on_screen(recording, exact):
    with extract.VideoReader(recording, exact=exact) as reader:
        order = list(range(len(TICKS)))
        for number in [*order, *np.random.default_rng(3).permutation(order).tolist()]:      # in order, then to and fro
            frame = reader.frame_at(on_screen(number))
            assert shown(frame.rgb) == number and frame.time == pytest.approx(STARTS[number], abs=STAMP)
        # The first frame stays on screen for two and a half seconds; the next one for a sixtieth.
        assert [shown(reader.frame_at(t).rgb) for t in (0.0, 0.3, 1.0, 2.4, 2.495)] == [0, 0, 0, 0, 0]
        assert shown(reader.frame_at(STARTS[AFTER_THE_LONG_FIRST] + 0.004).rgb) == AFTER_THE_LONG_FIRST
        assert shown(reader.frame_at(STARTS[AFTER_THE_LONG_FIRST + 1] + 0.004).rgb) == AFTER_THE_LONG_FIRST + 1
        # Anywhere in a frame's time on screen, and just before the next frame comes.
        for number in (HALF_SECOND, QUARTER_SECOND):
            assert [shown(reader.frame_at(STARTS[number] + part).rgb) for part in (0.004, 0.1, 0.24)] == [number] * 3
            assert shown(reader.frame_at(STARTS[number + 1] - 0.004).rgb) == number
            assert shown(reader.frame_at(STARTS[number] - 0.004).rgb) == number - 1
        with pytest.raises(extract.FrameNotFound, match="ends before"):
            reader.frame_at(STARTS[LAST] + 1.0)
        assert shown(reader.frame_at(on_screen(LAST)).rgb) == LAST                     # and the reader goes on after that


@needs_ffmpeg
@pytest.mark.parametrize("exact", [False, True])
def test_at_a_variable_rate_the_frames_within_a_second_are_the_ones_on_screen(recording, exact):
    """The window of a time: the frame on screen a second before it, however long that frame
    has been there, and every frame that comes on screen up to a second after it."""
    times = [on_screen(number) for number in range(len(TICKS))] + [0.0, 0.5, 1.2, 3.0, 3.45, STARTS[LAST] + 0.5]
    # A window's edge that falls within two milliseconds of a timestamp is left out: a WebM
    # file keeps timestamps to the millisecond.
    clear = [t for t in times if all(abs(stamp - edge) > 2e-3 for stamp in STARTS for edge in (t - 1.0, t + 1.0))]
    assert len(clear) > 50 and {0.0, 3.0, 3.45} <= set(clear)
    with extract.VideoReader(recording, exact=exact) as reader:
        for t in clear:
            window = reader.frames_between(t - 1.0, t + 1.0)
            expected = on_screen_between(max(0.0, t - 1.0), t + 1.0)
            assert [shown(frame.rgb) for frame in window] == expected
            assert [frame.time for frame in window] == pytest.approx([STARTS[number] for number in expected], abs=STAMP)
        # A window that starts while the long first frame is on screen begins with that frame.
        assert [shown(frame.rgb) for frame in reader.frames_between(2.0, 2.52)] == [0, 1, 2]
        assert [shown(frame.rgb) for frame in reader.frames_between(0.2, 0.4)] == [0]


def fetched(recording: Path, rows: list[Row], out: Path, **options) -> dict:
    summary = fetch.fetch_frames(rows, out, video_files={"own-table": recording}, image_format="png", say=quiet, **options)
    assert summary.complete, [(entry.t, entry.status, entry.reason) for entry in summary.entries]
    return extract.read_index(out)


def written(out: Path, entry: extract.IndexEntry) -> int:
    with Image.open(out / entry.file) as image:
        return shown(np.asarray(image.convert("RGB")))


@needs_ffmpeg
@pytest.mark.parametrize("exact_seek", [False, True])
def test_at_a_variable_rate_fetch_finds_rows_by_fingerprint(recording, tmp_path, exact_seek):
    labeled = {
        on_screen(AFTER_THE_LONG_FIRST): AFTER_THE_LONG_FIRST,       # the short frame right after the long first frame
        1.0: 0,                                                      # the long first frame, a time inside it
        0.0: 0,                                                      # the start of the file
        on_screen(2): 2,
        on_screen(HALF_SECOND): HALF_SECOND,                         # a frame that stays for half a second
        round(STARTS[30] + 0.6, 3): 30,                              # the row's time is 0.6 s late
        round(STARTS[45] - 0.7, 3): 45,                              # and 0.7 s early
        on_screen(LAST - 1): LAST - 1,                               # the end of the file
        on_screen(LAST): LAST,
    }
    rows = [make_row(t, PRINTS[number]) for t, number in labeled.items()]
    index = fetched(recording, rows, tmp_path / "out", exact_seek=exact_seek)
    for row, number in zip(rows, labeled.values()):
        entry = index[row.key]
        assert written(tmp_path / "out", entry) == number and entry.distance <= SAME_FRAME_MAX_HAMMING
        assert entry.frame_time == pytest.approx(STARTS[number], abs=STAMP)
        assert entry.offset == pytest.approx(STARTS[number] - row.t, abs=1e-3)


@needs_ffmpeg
@pytest.mark.parametrize("exact_seek", [False, True])
def test_at_a_variable_rate_fetch_finds_rows_by_time(recording, tmp_path, exact_seek):
    labeled = {
        on_screen(AFTER_THE_LONG_FIRST): AFTER_THE_LONG_FIRST,
        2.4: 0,                                                      # late in the long first frame
        0.0: 0,
        on_screen(2): 2,
        round(STARTS[HALF_SECOND] + 0.4, 3): HALF_SECOND,
        on_screen(QUARTER_SECOND): QUARTER_SECOND,
        on_screen(LAST - 1): LAST - 1,
        on_screen(LAST): LAST,
    }
    rows = [make_row(t, None) for t in labeled]
    index = fetched(recording, rows, tmp_path / "out", exact_seek=exact_seek)
    for row, number in zip(rows, labeled.values()):
        entry = index[row.key]
        assert written(tmp_path / "out", entry) == number and entry.distance is None
        assert entry.frame_time == pytest.approx(STARTS[number], abs=STAMP)


@needs_ffmpeg
@pytest.mark.parametrize("exact_seek", [False, True])
def test_at_a_variable_rate_a_window_wholly_past_the_end_fails_the_row(recording, tmp_path, exact_seek):
    end = STARTS[LAST]
    rows = [make_row(round(end + 0.5, 3), PRINTS[LAST - 2]),          # past the end; the second before it is not
            make_row(round(end + 0.6, 3), dhash(picture(5000))),
            make_row(round(end + 1.4, 3), PRINTS[LAST]),              # the window starts 0.4 s past the end
            make_row(round(end + 2.5, 3), PRINTS[LAST]),
            make_row(round(end + 0.9, 3), None)]
    out = tmp_path / "out"
    summary = fetch.fetch_frames(rows, out, video_files={"own-table": recording}, image_format="png", exact_seek=exact_seek, say=quiet)
    assert [(entry.status, entry.reason if entry.status == "unusable" else None) for entry in summary.entries] == [
        ("ok", None), ("unusable", "fingerprint"), ("failed", None), ("failed", None), ("failed", None)]
    assert written(out, summary.entries[0]) == LAST - 2
    for entry in summary.entries[2:4]:
        assert "the video ends before t=" in entry.reason and "where the window" in entry.reason and entry.distance is None
    assert sorted(path.name for path in (out / "frames").iterdir()) == [extract.frame_file_name(rows[0], ".png")]


# ------------------------------------------------- frames taken by the inference command
def taken_for_each_moment(every: float, rate: float) -> list[int]:
    """The frames ``read_video`` is to take: the first frame, and for each moment ``k * every``
    the first frame at or after it, both times counted in frames' times at the rate the file
    reports, to the nearest whole one; each frame once."""
    taken = [0]
    for moment in range(1, math.ceil(STARTS[LAST] / every) + 2):
        at = [number for number, stamp in enumerate(STARTS) if round(stamp * rate) >= round(moment * every * rate)]
        if at and at[0] != taken[-1]:
            taken.append(at[0])
    return taken


@needs_ffmpeg
@pytest.mark.parametrize("every", [0.5, 1.0, 0.25])
def test_at_a_variable_rate_infer_samples_by_seconds_of_video(recording, every):
    with extract.VideoReader(recording) as reader:
        rate = reader.rate
    frames = list(read_video(recording, every=every, image_format="png"))
    numbers = [shown(frame.rgb) for frame in frames]
    assert numbers == taken_for_each_moment(every, rate) and [frame.name for frame in frames] == [
        f"recording-f{count:05d}.png" for count in range(1, len(frames) + 1)]
    # The first frame stays for two and a half seconds: it is taken once, and the next frame
    # taken is the one that follows it, however many moments have passed.
    assert numbers[:2] == [0, 1] and len(set(numbers)) == len(numbers)
    # Seconds of video: after the long first frame, no moment is passed over. Each moment has
    # a frame that came on screen less than one frame's time (at the reported rate) before it,
    # or after it by no more than the longest time a frame stays, half a second.
    stamps = [STARTS[number] for number in numbers]
    for moment in range(math.ceil(2.5 / every), int(STARTS[LAST] / every) + 1):
        assert any(-1.0 / rate < stamp - moment * every <= 0.5 + 1e-9 for stamp in stamps)
    assert len(frames) <= STARTS[LAST] / every + 2


@needs_ffmpeg
def test_at_a_variable_rate_a_frame_s_time_is_inside_its_own_time_on_screen(recording):
    frames = list(read_video(recording, every=0.001, image_format="png"))            # every frame of the file
    assert [shown(frame.rgb) for frame in frames] == list(range(len(TICKS)))
    for number, frame in enumerate(frames[:LAST]):
        assert STARTS[number] < frame.t < STARTS[number + 1] and round(frame.t, 3) == frame.t
        assert frame.t == pytest.approx((STARTS[number] + STARTS[number + 1]) / 2.0, abs=1.1e-3)
    assert STARTS[LAST] < frames[LAST].t


@needs_ffmpeg
@pytest.mark.parametrize("exact_seek", [False, True])
@pytest.mark.parametrize("every", [0.5, 0.001])
def test_at_a_variable_rate_a_row_made_by_infer_leads_fetch_back_to_its_frame(recording, tmp_path, every, exact_seek):
    """A frame that ``cardvision infer`` takes from a recording has a time. A row made from it,
    with the frame's fingerprint or without one, gives ``cardvision fetch`` the very same
    frame from the same file: the same pixels."""
    frames = list(read_video(recording, every=every, image_format="png"))
    for name, fingerprints in (("by-fingerprint", [dhash(frame.rgb) for frame in frames]), ("by-time", [None] * len(frames))):
        rows = [make_row(frame.t, fingerprint) for frame, fingerprint in zip(frames, fingerprints)]
        out = tmp_path / name
        index = fetched(recording, rows, out, exact_seek=exact_seek)
        for frame, row in zip(frames, rows):
            entry = index[row.key]
            with Image.open(out / entry.file) as image:
                assert np.array_equal(np.asarray(image.convert("RGB")), frame.rgb)
            assert entry.frame_time == pytest.approx(STARTS[shown(frame.rgb)], abs=STAMP)
            assert entry.distance == (None if name == "by-time" else 0)
