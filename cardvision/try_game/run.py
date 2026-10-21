# SPDX-License-Identifier: Apache-2.0
"""The steps of ``cardvision try``, in the order of ``docs/your-game.md``.

Each step is an existing command, run as ``cardvision.cli.main`` runs it, with its output kept
in ``OUT/try.log``; nothing here repeats what those commands do. The files land where the page
puts them under ``$GAME``: ``catalog.json``, ``bank.json`` and ``bank.identity-groups.json``,
``out/`` (``annotated/``, ``crops/``, ``sheet.png``, ``results.jsonl``) and ``release/``.
Beside them: ``import-report.txt`` (and ``.json``), ``try.log`` and ``report.html``.

Every run is built in a staging folder inside OUT, ``.try-new-<pid>``, and moved into place
only when every step succeeded; a run that fails deletes its staging folder and touches nothing
else. The names a completed run wrote are listed in ``OUT/.cardvision-try``: ``--overwrite``
replaces those and only those. A file or folder under an output name that no run of ``try``
wrote is never replaced: the run is refused.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cardvision

WEIGHT_FILES = ("detector.onnx", "recognizer.onnx", "accept.json")
# What a run writes in OUT, and so what --overwrite replaces. OUT/weights is not among them:
# the released weights fetched there are kept.
OUTPUTS = ("catalog.json", "bank.json", "bank.identity-groups.json", "import-report.txt", "import-report.json",
           "out", "release", "try.log", "report.html")
STEPS = 6
MIN_EVERY = 1.0          # seconds: a short clip is sampled once a second, as the page advises
UNKNOWN_LENGTH_EVERY = 5.0   # the page's example, when the video's length cannot be found
# Video codecs the common browsers play, as OpenCV's FOURCC names them (by tag or by codec); a
# video in another one (mp4v, which OpenCV calls fmp4; hevc; mjpg) gets the H.264 conversion line.
# An unknown codec gets none.
PLAYABLE_CODECS = frozenset({"avc1", "avc3", "h264", "x264", "avc", "vp80", "vp08", "vp8", "vp90", "vp09", "vp9",
                             "av01", "av1"})
MARKER = ".cardvision-try"   # in OUT: the names a completed run wrote, as JSON
STAGING_PREFIX = ".try-new-"
BANK_PROGRESS = re.compile(r"^\s+\d+ / \d+ cards$")


class TryError(RuntimeError):
    """A step failed or an argument was refused; ``lines`` say which and what to do."""

    def __init__(self, lines: list[str]):
        super().__init__("; ".join(lines))
        self.lines = lines


# ----------------------------------------------------------------------------- shell quoting
def shell_arg(text: str) -> str:
    """A path as one shell word, by the rule of ``h264Command`` in ``browser/demo/view.ts``:
    quoted only when needed, and ``./`` before a name that starts with ``-``."""
    path = f"./{text}" if text.startswith("-") else text
    return path if re.fullmatch(r"[A-Za-z0-9._+/-]+", path) else "'" + path.replace("'", "'\\''") + "'"


def log_word(text: str) -> str:
    """One word of a logged command: a flag as it is, any other word quoted as ``shell_arg``
    quotes it, so that the line can be pasted back."""
    if re.fullmatch(r"--?[A-Za-z][A-Za-z0-9-]*", text):
        return text
    return shell_arg(text)


def h264_name(name: str) -> str:
    """The converted file's name, as ``h264Command`` makes it: ``X.mp4`` becomes ``X-h264.mp4``."""
    stem = re.sub(r"\.[^./]*$", "", name) or name
    return f"{stem}-h264.mp4"


def h264_command(name: str) -> str:
    """The ffmpeg line that converts a video to H.264, as ``h264Command`` in ``browser/demo/view.ts``."""
    return f"ffmpeg -i {shell_arg(name)} -c:v libx264 -pix_fmt yuv420p {shell_arg(h264_name(name))}"


# ------------------------------------------------------------------------------- the inputs
def repository_root() -> Path | None:
    """The checkout this package runs from, or ``None`` when it is installed elsewhere."""
    from cardvision.core.checkout import checkout_root

    return checkout_root()


def demo_installed() -> bool:
    """Whether the demo page's packages are installed (``npm ci`` in ``browser/`` has run)."""
    root = repository_root()
    return root is not None and (root / "browser" / "node_modules").is_dir()


def _inside(path: Path, folder: Path) -> bool:
    from cardvision.core.checkout import inside

    return inside(path, folder)


@dataclass
class VideoFacts:
    """What OpenCV says of a video file, as far as it says it."""
    seconds: float | None = None
    codec: str | None = None


def video_facts(path: Path) -> VideoFacts:
    """The length and the codec (FOURCC) of a video file; unknown parts are ``None``."""
    try:
        import cv2
    except ImportError:
        return VideoFacts()
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            return VideoFacts()
        seconds = stated_length(capture, cv2)
        code = int(capture.get(cv2.CAP_PROP_FOURCC))
        if seconds is None:
            seconds = measured_length(capture, cv2)
        codec = "".join(chr((code >> shift) & 0xFF) for shift in (0, 8, 16, 24)).strip("\0 ").lower() if code > 0 else ""
        return VideoFacts(seconds, codec if codec.isprintable() and codec else None)
    finally:
        capture.release()


def stated_length(capture: Any, cv2: Any) -> float | None:
    """The length in seconds the file states (frame count over frame rate), or ``None``."""
    fps = capture.get(cv2.CAP_PROP_FPS)
    count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
    return count / fps if fps and fps > 0 and count and count > 0 else None


def measured_length(capture: Any, cv2: Any) -> float | None:
    """The length in seconds of a video that does not state it, found by reading it once to
    the end: the last frame's time plus one frame's. ``None`` when no frame can be read."""
    fps = capture.get(cv2.CAP_PROP_FPS)
    last = None
    while capture.grab():
        last = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
    if last is None:
        return None
    return last + (1 / fps if fps and fps > 0 else 0.0)


# OpenCV's FOURCC names, in words.
CODEC_NAMES = {
    "fmp4": "MPEG-4 Part 2", "mp4v": "MPEG-4 Part 2", "xvid": "MPEG-4 Part 2", "divx": "MPEG-4 Part 2",
    "dx50": "MPEG-4 Part 2", "hevc": "HEVC (H.265)", "hvc1": "HEVC (H.265)", "hev1": "HEVC (H.265)",
    "h265": "HEVC (H.265)", "mjpg": "Motion JPEG", "mpg2": "MPEG-2", "mpeg": "MPEG-1",
}


def codec_words(codec: str) -> str:
    """A codec's name in words, or its FOURCC when it has none here."""
    return CODEC_NAMES.get(codec.lower(), codec)


def unplayable_codec(facts: VideoFacts) -> str | None:
    """The codec's name when browsers are not known to play it; ``None`` when they do or it is unknown."""
    return facts.codec if facts.codec and facts.codec not in PLAYABLE_CODECS else None


def choose_every(seconds: float | None, max_frames: int) -> float:
    """The time between analyzed frames so that at most ``max_frames`` frames of a video of
    ``seconds`` are analyzed (the first frame, then one every so many seconds), never under
    ``MIN_EVERY``, in tenths of a second."""
    if seconds is None:
        return UNKNOWN_LENGTH_EVERY
    if max_frames <= 1:
        return max(MIN_EVERY, math.ceil(seconds * 10 + 1) / 10)
    every = max(MIN_EVERY, math.ceil(seconds / (max_frames - 1) * 10) / 10)
    while expected_frames(seconds, every) > max_frames:
        every = round(every + 0.1, 1)
    return every


def expected_frames(seconds: float, every: float) -> int:
    return math.floor(seconds / every + 1e-9) + 1


@dataclass
class Sampling:
    """What ``infer`` is given: the inputs, ``--every`` and a line that says why."""
    inputs: list[Path]
    every: float
    note: str
    demo_file: Path


def plan_sampling(video: Path, every: float | None, max_frames: int) -> tuple[Sampling, VideoFacts]:
    from cardvision.infer.frames import expand_inputs, is_video

    if video.is_dir():
        files = expand_inputs([video])
        if len(files) > max_frames:
            picked = sorted({round(i * (len(files) - 1) / max(1, max_frames - 1)) for i in range(max_frames)})
            files = [files[i] for i in picked]
            note = f"{len(files)} of the folder's images, evenly spaced (--max-frames to change)"
        else:
            note = f"the folder's {len(files)} image(s)"
        return Sampling(files, every or MIN_EVERY, note, files[0]), VideoFacts()
    if not is_video(video):
        return Sampling([video], every or MIN_EVERY, "one image", video), VideoFacts()
    facts = video_facts(video)
    if every is not None:
        about = f", at most {expected_frames(facts.seconds, every)} frame(s)" if facts.seconds else ""
        return Sampling([video], every, f"one frame every {every:g} s (--every){about}", video), facts
    chosen = choose_every(facts.seconds, max_frames)
    if facts.seconds is None:
        note = f"one frame every {chosen:g} s (its length could not be found; --every to change)"
    else:
        note = (f"one frame every {chosen:g} s, at most {expected_frames(facts.seconds, chosen)} frame(s) of "
                f"{facts.seconds:.0f} s (never over {max_frames}; --every or --max-frames to change)")
    return Sampling([video], chosen, note, video), facts


def is_catalog(path: Path) -> bool:
    """Whether ``path`` is a catalog already: a JSON file the catalog's loader accepts."""
    from cardvision.core.catalog import CatalogError, parse_catalog

    if path.suffix.lower() != ".json":
        return False
    try:
        parse_catalog(json.loads(path.read_text(encoding="utf-8-sig")), source=path.name)
    except (CatalogError, ValueError, OSError):
        return False
    return True


# ------------------------------------------------------------------------- running commands
class _Capture(io.StringIO):
    """Keeps what a command prints; echoes the lines that match ``echo`` to standard error."""

    def __init__(self, echo: re.Pattern[str] | None = None):
        super().__init__()
        self._echo, self._partial, self._target = echo, "", sys.stderr

    def write(self, text: str) -> int:
        if self._echo is not None:
            self._partial += text
            *lines, self._partial = self._partial.split("\n")
            for line in lines:
                if self._echo.match(line):
                    print(line, file=self._target, flush=True)
        return super().write(text)


@dataclass
class Outcome:
    code: int
    out: str
    err: str


@dataclass
class Log:
    path: Path
    # (staging folder, OUT): the log names the files where they end up
    rename: tuple[str, str] = ("", "")
    parts: list[str] = field(default_factory=list)

    def add(self, argv: list[str], outcome: Outcome, stdout_file: Path | None = None) -> None:
        self.parts.append("$ cardvision " + " ".join(log_word(str(a)) for a in argv)
                          + (f" > {shell_arg(str(stdout_file))}" if stdout_file else "") + "\n")
        self.parts += [text if text.endswith("\n") else text + "\n" for text in (outcome.out, outcome.err) if text]
        self.parts.append(f"(exit code {outcome.code})\n\n")

    def write(self) -> None:
        text = "".join(self.parts)
        if self.rename[0]:
            text = text.replace(*self.rename)
        self.path.write_text(text, encoding="utf-8")


def command(argv: list[str], log: Log, stdout_file: Path | None = None, echo: re.Pattern[str] | None = None) -> Outcome:
    """Run ``cardvision ARGV`` in this process, its output kept (standard output in
    ``stdout_file`` when given) and logged."""
    from cardvision.cli import main

    out, err = _Capture(echo), _Capture()
    handle = open(stdout_file, "w", encoding="utf-8") if stdout_file else None
    try:
        with contextlib.redirect_stdout(handle or out), contextlib.redirect_stderr(err):
            try:
                code = main([str(a) for a in argv])
            except SystemExit as stop:   # argparse refused an argument
                code = stop.code if isinstance(stop.code, int) else 2
            except Exception as error:   # a command's error it did not report itself
                code = 1
                err.write(f"{type(error).__name__}: {error}\n")
    finally:
        if handle is not None:
            handle.close()
    outcome = Outcome(code, out.getvalue(), err.getvalue())
    log.add(argv, outcome, stdout_file)
    return outcome


def _failed(name: str, outcome: Outcome, advice: str) -> TryError:
    for text in (outcome.out, outcome.err):
        if text:
            print(text.rstrip("\n"), file=sys.stderr)
    return TryError([f"{name} stopped (its messages are above); nothing of this run was kept", advice])


# ---------------------------------------------------------------------------------- the run
def _say(step: int, text: str) -> None:
    print(f"[{step}/{STEPS}] {text}", flush=True)


def _remove(paths: list[Path]) -> None:
    for path in paths:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        elif path.exists() or path.is_symlink():
            path.unlink()


def _check_inputs(args: argparse.Namespace) -> tuple[Path, Path, Path, Path]:
    cards, images, video = args.cards.resolve(), args.images.resolve(), args.video.resolve()
    problems = []
    if not cards.is_file():
        problems.append(f"{args.cards}: no such card list or catalog file")
    if not images.is_dir():
        problems.append(f"--images {args.images}: no such folder")
    if not video.exists():
        problems.append(f"--video {args.video}: no such file or folder")
    if problems:
        from cardvision.core.checkout import unset_variable_hint

        hints = {unset_variable_hint(raw) for raw, ok in ((args.cards, cards.is_file()), (args.images, images.is_dir()),
                                                          (args.video, video.exists())) if not ok}
        problems += sorted(hint for hint in hints if hint)
    if args.max_frames < 1:
        problems.append("--max-frames must be at least 1")
    if args.every is not None and args.every <= 0:
        problems.append("--every must be more than 0 seconds")
    if problems:
        raise TryError(problems)
    out = (args.out if args.out is not None else args.cards.parent / "cardvision-try").resolve()
    if out.exists() and not out.is_dir():
        raise TryError([f"--out {out} is a file, not a folder", "choose a folder with --out DIR"])
    from cardvision.core.checkout import inside_checkout

    if inside_checkout(out):
        raise TryError([f"{out} lies inside the repository, which holds no images and no model files",
                        "choose a folder outside it with --out DIR"])
    given = [(cards, "CARDS"), (images, "--images"), (video, "--video")]
    if args.weights is not None:
        given.append((args.weights.resolve(), "--weights"))
    for name in (*OUTPUTS, MARKER):
        for path, label in given:
            if _inside(path, out / name):
                raise TryError([f"{label} {path} lies where this command writes ({out / name})",
                                "move it, or choose another folder with --out DIR"])
    return cards, images, video, out


def earlier_run(out: Path) -> set[str]:
    """The output names an earlier completed run of ``try`` wrote in ``out``, by its marker."""
    try:
        names = json.loads((out / MARKER).read_text(encoding="utf-8")).get("wrote")
    except (OSError, ValueError, AttributeError):
        return set()
    return {name for name in names if name in OUTPUTS} if isinstance(names, list) else set()


def _exists(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def _check_out(out: Path, overwrite: bool) -> list[str]:
    """The earlier run's names that this run replaces. Refuses a name no run of ``try`` wrote,
    even with ``--overwrite``, and an earlier run's names without it."""
    if (out / MARKER).is_symlink():
        raise TryError([f"{out / MARKER} is a symbolic link; cardvision try neither reads nor writes through one",
                        "remove the link, or choose another folder with --out DIR"])
    present = [name for name in OUTPUTS if _exists(out / name)]
    ours = earlier_run(out)
    foreign = [name for name in present if name not in ours]
    if foreign:
        raise TryError([f"{out} already holds {', '.join(foreign)}, which cardvision try did not write; it never "
                        "replaces such files, even with --overwrite",
                        "move them, or choose another folder with --out DIR"])
    replaced = [name for name in present if name in ours]
    if replaced and not overwrite:
        raise TryError([f"{out} holds an earlier run's {', '.join(replaced)}",
                        "pass --overwrite to replace them (once the new run has succeeded), or choose another "
                        "folder with --out DIR"])
    return replaced


def write_marker(out: Path, names: list[str]) -> None:
    """Write the marker by a temporary file in ``out`` renamed over it, so that it is never
    written through a symbolic link and never left half written."""
    marker = out / MARKER
    if marker.is_symlink():
        raise TryError([f"{marker} is a symbolic link; cardvision try neither reads nor writes through one",
                        "remove the link, then run cardvision try again"])
    temp = None
    try:
        handle, temp = tempfile.mkstemp(dir=out, prefix=f"{MARKER}.", suffix=".part")
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            file.write(json.dumps({"wrote": names}) + "\n")
        os.replace(temp, marker)
        temp = None
    finally:
        if temp is not None:
            Path(temp).unlink(missing_ok=True)


def _alive(pid: int) -> bool:
    """Whether a process of that number runs. Asked only where signal 0 is a question (POSIX);
    elsewhere the answer is no."""
    if os.name != "posix":
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:      # it runs, under another user
        return True
    return True


def leftover_staging(out: Path, own: Path) -> list[Path]:
    """Staging folders in OUT of runs that are no longer running."""
    if not out.is_dir():
        return []
    found = []
    for path in sorted(out.glob(f"{STAGING_PREFIX}*")):
        tail = path.name[len(STAGING_PREFIX):]
        if path == own or not path.is_dir() or path.is_symlink():
            continue
        if tail.isdigit() and _alive(int(tail)):
            continue
        found.append(path)
    return found


def _weights(args: argparse.Namespace, out: Path) -> Path:
    if args.weights is not None:
        folder = args.weights.resolve()
        missing = [name for name in WEIGHT_FILES if not (folder / name).is_file()]
        if missing:
            raise TryError([f"--weights {args.weights} holds no {', '.join(missing)}",
                            "give the folder fetch-weights filled, or a release folder"])
        return folder
    folder = out / "weights"
    if all((folder / name).is_file() for name in WEIGHT_FILES):
        return folder
    fetch = f"cardvision fetch-weights {shell_arg(str(folder))}"
    if not args.download:
        from cardvision.release_assets import ASSETS

        raise TryError([f"no released weights in {folder}",
                        f"download them (about {sum(a.bytes for a in ASSETS) / 1e6:.0f} MB) with: {fetch}",
                        "or run this again with --download, which runs that first, or give a folder with --weights DIR"])
    from cardvision import fetch_weights

    made = [path for path in (out, folder) if not path.exists()]
    code = fetch_weights.run(argparse.Namespace(dir=folder, list=False, overwrite=False))
    if code != 0:
        for path in reversed(made):
            if path.is_dir() and not any(path.iterdir()):
                path.rmdir()
        raise TryError(["the released weights could not be downloaded (the reason is above); nothing was written",
                        f"run again when the network is there, or download them with: {fetch}"])
    return folder


def demo_line(release: Path, images: Path, file: Path, install: bool = False) -> str:
    """The line that opens the demo page on this run's release, images and video, from the
    repository's root; with ``install``, it installs the page's packages first."""
    return (f"cd browser && {'npm ci && ' if install else ''}npm run demo -- --release {shell_arg(str(release))} --images {shell_arg(str(images))} "
            f"--file {shell_arg(str(file))}")


def codec_hint(file: Path, codec: str | None) -> str | None:
    """For a video in a codec browsers may not play: how to convert it, or ``None``."""
    if codec is None:
        return None
    return (f"if the video does not play in the demo ({codec_words(codec)}), convert it first: {h264_command(str(file))}, "
            f"then give {shell_arg(h264_name(str(file)))} to --file")


def run_try(args: argparse.Namespace) -> int:
    from cardvision.try_game.report import (Facts, cards_without_image, no_image_sentence, read_results, verdict,
                                            write_report)

    cards, images, video, out = _check_inputs(args)
    replaced = _check_out(out, args.overwrite)
    try:
        sampling, facts = plan_sampling(video, args.every, args.max_frames)
    except (ValueError, OSError) as error:
        raise TryError([f"--video {args.video}: {error}", "give a video, a picture or a folder of images"]) from None
    weights = _weights(args, out)
    created = not out.exists()
    try:
        out.mkdir(parents=True, exist_ok=True)
        stage = out / f"{STAGING_PREFIX}{os.getpid()}"
        _remove([stage])     # left by a run of the same process number that was killed
        left = leftover_staging(out, stage)
        if left:
            print(f"{out} holds leftover {', '.join(path.name for path in left)} folder(s) from an interrupted run; "
                  "they are safe to delete", flush=True)
        stage.mkdir()
    except OSError as error:
        raise TryError([f"--out {out}: cannot write there ({error.strerror or error})",
                        "choose another folder with --out DIR"]) from None
    log = Log(stage / "try.log", rename=(str(stage), str(out)))
    built = False
    try:
        result = _steps(args, cards, images, stage, out, weights, sampling, log)
        codec = unplayable_codec(facts)
        hint = codec_hint(sampling.demo_file, codec)
        demo = demo_line(out / "release", images, sampling.demo_file, install=not demo_installed())
        found = verdict(read_results(stage / "out" / "results.jsonl"))
        no_images = cards_without_image(stage / "catalog.json", stage / "bank.json")
        no_image = no_image_sentence(no_images)
        log.write()
        for name in ("import-report.txt", "import-report.json"):    # name the files where they end up
            path = stage / name
            if path.is_file():
                path.write_text(path.read_text(encoding="utf-8").replace(str(stage), str(out)), encoding="utf-8")
        write_report(stage / "report.html", Facts(
            out=stage, final=out, cards=cards, images=images, video=video, weights=weights,
            sampling_note=sampling.note, verdict=found, infer_lines=result["infer"], import_report=result["import"],
            from_catalog=result["from_catalog"], demo_line=demo, codec_hint=hint, no_image=no_images))
        built = True
    finally:
        if not built:
            _remove([stage])
            if created and out.is_dir() and not any(out.iterdir()):
                out.rmdir()
    _put_in_place(stage, out, args.overwrite)
    if hint is not None:
        print(hint)
    if no_image is not None:
        print(no_image)
    print(found.sentence)
    print(f"report: {out / 'report.html'}")
    print(demo)
    return 0


def _put_in_place(stage: Path, out: Path, overwrite: bool) -> None:
    """Move a completed run from its staging folder into OUT: the earlier run's names go only
    now, and the marker lists what this run wrote. OUT is checked again first: what appeared in
    it while the run went is never replaced, and the run is then not kept."""
    try:
        replaced = _check_out(out, overwrite)
    except TryError as error:
        _remove([stage])
        raise TryError([f"while the run went, OUT changed: {error.lines[0]}",
                        "nothing of this run was kept; " + error.lines[-1]]) from None
    wrote = [name for name in OUTPUTS if _exists(stage / name)]
    # While names move, the marker covers both runs, so that an interrupted move leaves nothing
    # that a later run would take for someone else's file.
    try:
        write_marker(out, sorted(set(wrote) | set(replaced)))
    except BaseException:
        _remove([stage])
        raise
    _remove([out / name for name in replaced])
    for name in wrote:
        os.replace(stage / name, out / name)
    write_marker(out, wrote)
    _remove([stage])


def _steps(args: argparse.Namespace, cards: Path, images: Path, out: Path, final: Path, weights: Path,
           sampling: Sampling, log: Log) -> dict[str, Any]:
    """The steps, writing into ``out`` (the staging folder); the progress lines name ``final``."""
    catalog = out / "catalog.json"
    from_catalog = is_catalog(cards)
    if from_catalog:
        _say(1, f"catalog: {cards} is one already, used as it is")
        shutil.copyfile(cards, catalog)
        imported: dict[str, Any] | None = None
        report_text = f"{cards} is a catalog already: copied as it is to {final / 'catalog.json'}; import-catalog was not run.\n"
    else:
        _say(1, f"import-catalog: {cards.name} -> {final / 'catalog.json'}")
        argv: list[Any] = ["import-catalog", cards, "--out", catalog, "--game", args.game, "--images", images,
                           "--report", out / "import-report.json"]
        for value in args.map or []:
            argv += ["--map", value]
        for value in args.facets or []:
            argv += ["--facets", value]
        if args.identity:
            argv += ["--identity", args.identity]
        if args.delimiter is not None:
            argv += ["--delimiter", args.delimiter]
        outcome = command(argv, log)
        if outcome.code != 0 or not catalog.is_file():
            raise _failed("import-catalog", outcome, "fix the list (or name a column with --map FIELD=HEADER), "
                                                     "then run cardvision try again")
        imported = json.loads((out / "import-report.json").read_text(encoding="utf-8"))
        report_text = outcome.out

    _say(2, f"check-catalog: the catalog and the images in {images}")
    outcome = command(["check-catalog", catalog, "--art", images], log)
    if outcome.code != 0:
        raise _failed("check-catalog", outcome, "fix the catalog or the images, then run cardvision try again")
    (out / "import-report.txt").write_text(report_text + "\n$ cardvision check-catalog\n" + outcome.out, encoding="utf-8")

    _say(3, f"build-bank: one row per card image -> {final / 'bank.json'}")
    bank = out / "bank.json"
    outcome = command(["build-bank", "--catalog", catalog, "--art", images, "--recognizer", weights / "recognizer.onnx",
                       "--out", bank, "--skip-missing-art"], log, echo=BANK_PROGRESS)
    if outcome.code != 0:
        raise _failed("build-bank", outcome, "fix the images or the list, then run cardvision try again")

    release = out / "release"
    _say(4, f"build-release and verify-release: the release folder {final / 'release'}")
    release.mkdir()
    for name in WEIGHT_FILES:
        shutil.copyfile(weights / name, release / name)
    for path in (catalog, bank, out / "bank.identity-groups.json"):
        shutil.copyfile(path, release / path.name)
    outcome = command(["build-release", "--detector", release / "detector.onnx", "--recognizer",
                       release / "recognizer.onnx", "--bank", release / "bank.json", "--catalog",
                       release / "catalog.json", "--accept", release / "accept.json", "--out",
                       release / "release.json"], log)
    if outcome.code != 0:
        raise _failed("build-release", outcome, "check the --weights folder's three files, then run cardvision try again")
    outcome = command(["verify-release", release / "release.json"], log)
    if outcome.code != 0:
        raise _failed("verify-release", outcome, "run cardvision try again with --overwrite")

    found = out / "out"
    _say(5, f"infer: {sampling.note}")
    found.mkdir()
    outcome = command(["infer", *sampling.inputs, "--release", release / "release.json", "--every", f"{sampling.every:g}",
                       "--annotate", found / "annotated", "--crops", found / "crops", "--contact-sheet",
                       found / "sheet.png", "--art", images], log, stdout_file=found / "results.jsonl")
    if outcome.code != 0:
        raise _failed("infer", outcome, "check the video (a photo or a folder of images works too), then run "
                                        "cardvision try again")
    _say(6, f"report: {final / 'report.html'}")
    return {"infer": [line for line in outcome.err.splitlines() if line.strip()], "import": imported,
            "from_catalog": from_catalog}
