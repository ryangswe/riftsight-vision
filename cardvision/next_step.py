# SPDX-License-Identifier: Apache-2.0
"""``cardvision next``: look at a game folder, say what is done and the one next step.

It follows ``docs/your-game.md``: the game folder, a card list, card images and a video in it,
the released weights, a run of ``cardvision try`` and its verdict. The first of these that is
not done is the next step, given as a sentence, the commands to paste (real paths, quoted as
``try`` quotes them) and the page to read.

It only looks: it never writes, creates, downloads or runs another command, and loads no
model. What ``try`` accepts and writes is taken from ``try`` itself (``cardvision.try_game``),
not repeated here. ``--json`` prints the same as one object, whose shape is a contract
(``SCHEMA_VERSION``; docs/commands.md describes it).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from cardvision import release_assets

SUMMARY = "Look at your game folder and say what is done and the next step, with the command to paste."

SCHEMA_VERSION = 1
GAME_VARIABLE, WEIGHTS_VARIABLE = "GAME", "WEIGHTS"
DEFAULT_GAME = Path("Downloads") / "my-game"                  # under the home folder
DEFAULT_WEIGHTS = Path("Downloads") / "cardvision-weights"
TRY_FOLDER = "cardvision-try"           # where try writes by default: beside the card list
IMAGE_FOLDERS = ("images", "art")       # the card images' folder, by the names the pages use
# Folders the steps of docs/your-game.md write into $GAME: never the card images or the video.
WRITTEN_FOLDERS = frozenset({TRY_FOLDER, "out", "out-scenes", "release", "scenes", "weights"})
# Files the step-by-step page writes into $GAME that are JSON but no card list.
WRITTEN_JSON = frozenset({"bank.json", "bank.identity-groups.json", "import-report.json", "release.json"})
STATES = ("done", "missing", "choice", "changed")
NUMBER_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine",
                10: "ten"}


# ------------------------------------------------------------------------------ what it says
@dataclass
class Check:
    """One thing looked at: ``id`` (stable), ``state`` (one of ``STATES``), a short ``detail``
    and the ``paths`` it is about."""
    id: str
    label: str
    state: str
    detail: str
    paths: list[str] = field(default_factory=list)
    blocks: bool = False    # several found and none taken: the way on waits for a choice
    taken: str | None = None    # the path a choice that does not block took
    source: str | None = None   # images and weights: where the folder came from (SOURCES)


@dataclass
class Doc:
    path: str                   # from the repository's root, such as docs/your-game.md
    section: str | None = None  # a heading of that page

    def link(self) -> str:
        return self.path + (f"#{anchor(self.section)}" if self.section else "")

    def words(self) -> str:
        return self.path + (f', "{self.section}"' if self.section else "")


@dataclass
class Step:
    """The next step: ``say`` in one sentence, ``notes`` (one line each) before the commands,
    the ``commands`` to paste, the page to read, and ``after``: lines that come after it."""
    id: str
    say: str
    doc: Doc
    commands: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    after: list[str] = field(default_factory=list)
    stop: str | None = None     # a key of STOPS: the step needs the person before an agent goes on

    @property
    def playbook(self) -> str:
        return PLAYBOOKS[self.id]


@dataclass
class Where:
    path: Path
    chosen: str        # "argument" (or "--weights"), "environment" or "default"
    words: str         # how the human output says it
    raw: str = ""      # as given, before it became an absolute path


@dataclass
class Look:
    game: Where
    weights: Where
    checks: list[Check]
    next: Step
    verdict: dict[str, Any] | None = None
    no_image: dict[str, int] | None = None


def anchor(heading: str) -> str:
    """A heading's anchor as GitHub makes it: lower case, punctuation dropped, spaces as hyphens."""
    return re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")


def number_words(count: int) -> str:
    return NUMBER_WORDS.get(count, str(count))


def plural(count: int, one: str, many: str | None = None) -> str:
    return f"{count} {one if count == 1 else (many or one + 's')}"


# ------------------------------------------------------------------------------ the folders
def resolve(given: Path | None, variable: str, default: Path, flag: str) -> Where:
    """The folder from the argument, else the environment variable, else the default under home."""
    if given is not None:
        return Where(_absolute(str(given)), "argument", flag, str(given))
    value = os.environ.get(variable, "")
    if value.strip():
        return Where(_absolute(value), "environment", f"from ${variable}", value)
    return Where(Path.home() / default, "default", "the default", str(Path("~") / default))


def _absolute(text: str) -> Path:
    """An absolute path with ``~`` expanded and ``..`` collapsed (symbolic links are kept)."""
    return Path(os.path.abspath(os.path.expanduser(text)))


def looks_like_windows(text: str) -> bool:
    """Whether a path is written the Windows way: a drive letter (``C:``) or backslashes."""
    return bool(re.match(r"^[A-Za-z]:([\\/]|$)", text)) or "\\" in text


WINDOWS_HINT = ("it looks like a Windows path: in WSL, write it as /mnt/c/Users/... (or convert it with "
                "wslpath 'C:\\Users\\...')")


# ------------------------------------------------------------------------------ the inputs
def _top_files(game: Path) -> list[Path]:
    return sorted(path for path in game.iterdir() if path.is_file() and not path.name.startswith("."))


def _top_folders(game: Path) -> list[Path]:
    return sorted(path for path in game.iterdir() if path.is_dir() and not path.name.startswith("."))


def _image_files(folder: Path, nested: bool) -> list[Path]:
    """The image files in a folder (and below it, with ``nested``), by the suffixes ``infer`` reads."""
    from cardvision.infer.frames import IMAGE_SUFFIXES

    found = []
    for root, folders, files in os.walk(folder):
        folders[:] = sorted(name for name in folders if not name.startswith("."))
        found += [Path(root) / name for name in files if Path(name).suffix.lower() in IMAGE_SUFFIXES]
        if not nested:
            break
    return sorted(found)


def is_card_list(path: Path) -> bool:
    """Whether ``try`` would take ``path`` as its card list: a CSV or TSV file, a catalog, or a
    JSON list of rows (or ``{"cards": [...]}``), as ``import-catalog`` reads them."""
    from cardvision.import_catalog.importer import _SUFFIX_FORMATS

    suffix = path.suffix.lower()
    if suffix not in _SUFFIX_FORMATS:
        return False
    if suffix != ".json":
        return True
    if path.name.lower() in WRITTEN_JSON:
        return False
    try:
        doc = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return False
    rows = doc.get("cards") if isinstance(doc, dict) else doc
    return isinstance(rows, list)


def find_cards(game: Path) -> tuple[list[Path], Path | None, list[Path]]:
    """The card lists at the top of ``game``, the one most likely meant (or ``None``) and the
    spreadsheet files there that would need exporting first."""
    from cardvision.import_catalog.importer import _SPREADSHEET_SUFFIXES
    from cardvision.try_game.run import is_catalog

    files = _top_files(game)
    found = [path for path in files if is_card_list(path)]
    # The step-by-step page writes catalog.json from your list: beside another list, it is that.
    if len(found) > 1:
        found = [path for path in found if not (path.name == "catalog.json" and is_catalog(path))] or found
    spreadsheets = [path for path in files if path.suffix.lower() in _SPREADSHEET_SUFFIXES]
    if len(found) == 1:
        return found, found[0], spreadsheets
    named = [path for path in found if path.stem.lower() == "cards"]
    sheets = [path for path in found if path.suffix.lower() != ".json"]
    likely = named[0] if len(named) == 1 else sheets[0] if len(sheets) == 1 else None
    return found, likely, spreadsheets


def find_images(game: Path) -> tuple[list[Path], Path | None]:
    """The folders that may hold the card images and the one taken: ``images/`` or ``art/``,
    else the one top-level folder holding image files."""
    for name in IMAGE_FOLDERS:
        if (game / name).is_dir():
            return [game / name], game / name
    found = [path for path in _top_folders(game) if path.name not in WRITTEN_FOLDERS and _image_files(path, nested=True)]
    return found, found[0] if len(found) == 1 else None


def find_video(game: Path, images: Path | None) -> tuple[list[Path], Path | None]:
    """What ``try --video`` would take at the top of ``game``: the video files; else the
    pictures; else the folders holding pictures (other than ``images``, the card images' folder
    taken). Returns the candidates of the first kind found and the one most likely meant (or
    ``None``)."""
    from cardvision.infer.frames import IMAGE_SUFFIXES, VIDEO_SUFFIXES

    files = _top_files(game)
    folders = [path for path in _top_folders(game)
               if path.name not in WRITTEN_FOLDERS and path != images and _image_files(path, nested=False)]
    for found in ([path for path in files if path.suffix.lower() in VIDEO_SUFFIXES],
                  [path for path in files if path.suffix.lower() in IMAGE_SUFFIXES], folders):
        if found:
            if len(found) == 1:
                return found, found[0]
            named = [path for path in found if path.stem.lower() == "video"]
            return found, named[0] if len(named) == 1 else None
    return [], None


def _newest(path: Path) -> tuple[float, Path] | None:
    """The newest modification time of a file, or of the files below a folder, and that file."""
    if path.is_file():
        return path.stat().st_mtime, path
    newest = None
    for root, folders, files in os.walk(path):
        folders[:] = [name for name in folders if not name.startswith(".")]
        for name in files:
            if name.startswith("."):
                continue
            try:
                stamp = (Path(root) / name).stat().st_mtime
            except OSError:
                continue
            if newest is None or stamp > newest[0]:
                newest = (stamp, Path(root) / name)
    return newest


def _names(paths: list[Path], game: Path) -> str:
    return ", ".join(_name(path, game) for path in paths)


def _and(words: list[str]) -> str:
    """``a``, ``a and b``, ``a, b and c``."""
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def images_of_last_try(out: Path) -> Path | None:
    """The card images' folder the last run of try used: the ``--art`` of ``check-catalog`` in
    its ``try.log`` (a step every run takes, with the folder as given to ``--images``). Only a
    line whose catalog is this run's own ``catalog.json`` counts, so that a log copied with the
    game folder, or one written by hand, is not followed elsewhere. ``None`` when there is no
    such log or line."""
    own = (out / "catalog.json").resolve()
    try:
        text = (out / "try.log").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    for line in text.splitlines():
        if line.startswith("$ cardvision check-catalog "):
            try:
                words = shlex.split(line[2:])
            except ValueError:
                return None
            if len(words) > 2 and Path(words[2]).resolve() == own and "--art" in words[:-1]:
                return Path(words[words.index("--art") + 1])
    return None


def too_wide(folder: Path, game: Path) -> bool:
    """Whether a logged images folder is one ``next`` won't walk: ``/``, the home folder, or a
    folder that holds the game folder's parent (a log written by hand could name one)."""
    try:
        folder, parent, home = folder.resolve(), game.resolve().parent, Path.home().resolve()
    except (OSError, RuntimeError):
        return True
    return folder == Path(folder.anchor) or folder == home or folder == parent or folder in parent.parents


def _safe(test: Any, path: Path) -> bool:
    """``test(path)`` (``Path.is_file``, ``is_dir``, ``exists``), false where the folder above
    can't be read rather than an error."""
    try:
        return test(path)
    except OSError:
        return False


def _name(path: Path, game: Path) -> str:
    relative = path.relative_to(game).as_posix() if path.is_relative_to(game) else str(path)
    return relative + ("/" if path.is_dir() else "")


# ------------------------------------------------------------------------------ the look
def look(game: Where, weights: Where) -> Look:
    from cardvision.try_game.run import MARKER, OUTPUTS, WEIGHT_FILES, earlier_run

    root, checks, look_weights = game.path, [], weights
    there = _safe(Path.is_dir, root)
    unreadable = None
    if there:
        try:
            os.listdir(root)
        except OSError as error:      # macOS may deny the terminal a folder such as ~/Downloads
            unreadable = error.strerror or type(error).__name__
            there = False
    if unreadable:
        folder_detail = f"can't read it ({unreadable})"
    elif there:
        folder_detail = "there"
    else:
        folder_detail = "no such folder" + (f"; {WINDOWS_HINT}" if looks_like_windows(game.raw) else "")
    checks.append(Check("folder", "game folder", "done" if there else "missing", folder_detail, [str(root)]))

    # The three inputs.
    cards = images_folder = video = None
    cards_found: list[Path] = []
    spreadsheets: list[Path] = []
    image_found: list[Path] = []
    video_found: list[Path] = []
    if there:
        cards_found, cards, spreadsheets = find_cards(root)
        image_found, images_folder = find_images(root)
    checks.append(_cards_check(root, there, cards_found, cards, spreadsheets))
    used = (images_of_last_try(root / TRY_FOLDER) if there and "try.log" in earlier_run(root / TRY_FOLDER)
            else None)
    if used is not None and too_wide(used, root):
        used = None
    if used is not None and used.is_dir() and _image_files(used, nested=True):
        count = len(_image_files(used, nested=True))
        images_folder = used
        images_check = Check("images", "card images", "done",
                             f"{_name(used, root)} ({plural(count, 'file')}, from the last try)", [str(used)],
                             source="last-try")
    else:
        images_check, _count = _images_check(root, there, image_found, images_folder)
    checks.append(images_check)
    if images_check.state != "done":
        images_folder = None
    if there:
        video_found, video = find_video(root, images_folder)
    checks.append(_choice_check("video", "video", root, there, video_found, video,
                                "no video, picture or folder of pictures at the top"))

    # The weights: the folder chosen, else the one try --download filled in the last run's folder.
    folder = weights.path
    missing = [name for name in WEIGHT_FILES if not _safe(Path.is_file, folder / name)]
    downloaded = root / TRY_FOLDER / "weights"
    if not missing:
        checks.append(Check("weights", "released weights", "done", f"{folder} ({weights.words})", [str(folder)],
                            source=weights.chosen))
    elif there and all(_safe(Path.is_file, downloaded / name) for name in WEIGHT_FILES):
        weights = Where(downloaded, weights.chosen, weights.words, weights.raw)
        checks.append(Check("weights", "released weights", "done",
                            f"{_name(downloaded, root)} (from the last try's download)", [str(downloaded)],
                            source="last-try-download"))
    else:
        what = ("not a folder" if _safe(Path.exists, folder) and not _safe(Path.is_dir, folder)
                else f"no {', '.join(missing)}")
        checks.append(Check("weights", "released weights", "missing", f"{what} in {folder} ({weights.words})",
                            [str(folder)], source=weights.chosen))

    # The try run.
    out = root / TRY_FOLDER
    ran = earlier_run(out) if there else set()
    report = out / "report.html"
    out_there = there and _safe(Path.is_dir, out)
    foreign = [name for name in OUTPUTS if _safe(Path.exists, out / name) and name not in ran] if out_there else []
    run_ok = "report.html" in ran and _safe(Path.is_file, report)
    verdict = no_image = None
    read_error = None
    if run_ok:
        try:
            verdict, no_image = _read_run(out)
        except Exception as error:    # a run's files that cannot be read: run it again
            read_error = f"{type(error).__name__}: {error}"
    inputs = [path for path in (cards, images_folder, video) if path is not None]
    changed: list[Path] = []
    if run_ok and read_error is None:
        stamp = report.stat().st_mtime
        for path in inputs:
            newest = _newest(path)
            if newest is not None and newest[0] > stamp:
                changed.append(newest[1])
    if not out_there:
        try_check = Check("try", "try run", "missing", "not run yet", [str(out)])
    elif not run_ok:
        detail = f"{TRY_FOLDER}/ holds no completed run (no {MARKER} naming report.html)"
        if foreign:
            detail += f"; it holds {', '.join(foreign)}, which try did not write and never replaces"
        try_check = Check("try", "try run", "missing", detail, [str(out)])
    elif read_error is not None:
        try_check = Check("try", "try run", "missing", f"its files can't be read ({read_error})", [str(out)])
    elif changed:
        try_check = Check("try", "try run", "changed",
                          f"{_and([_name(path, root) for path in changed])} {'is' if len(changed) == 1 else 'are'} "
                          f"newer than the last try's report (edited, or copied again?)",
                          [str(report), *map(str, changed)])
    else:
        try_check = Check("try", "try run", "done", f"{TRY_FOLDER}/report.html", [str(report)])
    checks.append(try_check)

    # Its verdict and the cards with no image.
    if verdict is None:
        checks.append(Check("verdict", "verdict", "missing", "no try run to read"))
        checks.append(Check("no-image", "cards with no image", "missing", "no try run to read"))
    else:
        last = " (from the last try)" if changed else ""
        results = str(out / "out" / "results.jsonl")
        checks.append(Check("verdict", "verdict", "done", _verdict_words(verdict) + last, [results]))
        checks.append(_no_image_check(no_image, out, last))

    if unreadable:
        for check in checks:
            if check.detail == "no game folder":
                check.detail = "the game folder can't be read"
        step = Step("folder-access", f"let the terminal read {root}: on macOS, System Settings, Privacy & Security, "
                                     "Files and Folders (or Full Disk Access), turn it on for your terminal app, then "
                                     "run cardvision next again.", YOUR_FOLDERS,
                    notes=[f"elsewhere: check the folder's permissions (ls -ld {_quoted(root)})"],
                    stop="persons-permission")
    else:
        step = _next(root, weights, checks, cards, images_folder, video, verdict, no_image, ran, out, bool(foreign),
                     game.raw)
    return Look(game, look_weights, checks, step, _verdict_json(verdict), _no_image_json(no_image))


def _cards_check(root: Path, there: bool, found: list[Path], likely: Path | None, spreadsheets: list[Path]) -> Check:
    if not there:
        return Check("cards", "card list", "missing", "no game folder")
    if not found:
        detail = "no .csv, .tsv or .json card list at the top"
        if spreadsheets:
            detail += f"; {_names(spreadsheets, root)} must be exported as CSV (UTF-8) first"
        return Check("cards", "card list", "missing", detail, [str(path) for path in spreadsheets])
    return _choice_check("cards", "card list", root, there, found, likely, "")


def _choice_check(check_id: str, label: str, root: Path, there: bool, found: list[Path], likely: Path | None,
                  none: str) -> Check:
    if not there:
        return Check(check_id, label, "missing", "no game folder")
    if not found:
        return Check(check_id, label, "missing", none)
    paths = [str(path) for path in found]
    if len(found) == 1:
        return Check(check_id, label, "done", _name(found[0], root), paths)
    pick = (f"the next step takes {_name(likely, root)}" if likely is not None
            else "say which one")
    return Check(check_id, label, "choice", f"several: {_names(found, root)} ({pick})", paths, likely is None,
                 None if likely is None else str(likely))


def _images_check(root: Path, there: bool, found: list[Path], folder: Path | None) -> tuple[Check, int]:
    if not there:
        return Check("images", "card images", "missing", "no game folder"), 0
    if not found:
        return Check("images", "card images", "missing", "no images/ folder, and no folder of image files"), 0
    if folder is None:
        return Check("images", "card images", "choice",
                     f"several folders hold image files: {_names(found, root)} (say which one)",
                     [str(path) for path in found], True), 0
    count = len(_image_files(folder, nested=True))
    if not count:
        return Check("images", "card images", "missing", f"{_name(folder, root)} holds no image files",
                     [str(folder)]), 0
    return Check("images", "card images", "done", f"{_name(folder, root)} ({plural(count, 'file')})",
                 [str(folder)], source="game-folder"), count


def _read_run(out: Path) -> tuple[Any, Any]:
    from cardvision.try_game.report import cards_without_image, read_results, verdict

    found = verdict(read_results(out / "out" / "results.jsonl"))
    return found, cards_without_image(out / "catalog.json", out / "bank.json")


def _verdict_words(found: Any) -> str:
    if found.kind == "none":
        return f"no cards found ({plural(found.frames, 'frame')} looked at)"
    named = f"{found.named} of {plural(found.faces, 'face')} named, {plural(found.distinct, 'distinct card')}"
    return ("found and named" if found.kind == "named" else "found, few named") + f" ({named})"


def _no_image_check(found: Any, out: Path, last: str) -> Check:
    paths = [str(out / "catalog.json"), str(out / "bank.json")]
    none, own = len(found.none), len(found.own)
    if none:
        detail = (f"{none} of the {found.total} cards in your list can't be named: no image"
                  + (f"; {own} more have no image of their own" if own else ""))
        return Check("no-image", "cards with no image", "missing", detail + last, paths)
    if own:
        return Check("no-image", "cards with no image", "done",
                     f"{own} of the {found.total} cards have no image of their own (named where they look like "
                     f"another printing){last}", paths)
    return Check("no-image", "cards with no image", "done", f"none of the {found.total} cards in your list{last}",
                 paths)


def _verdict_json(found: Any) -> dict[str, Any] | None:
    if found is None:
        return None
    return {"kind": found.kind, "frames": found.frames, "framesWithFaces": found.frames_with_faces,
            "faces": found.faces, "backs": found.backs, "named": found.named, "distinct": found.distinct}


def _no_image_json(found: Any) -> dict[str, int] | None:
    return None if found is None else {"none": len(found.none), "own": len(found.own), "total": found.total}


# ------------------------------------------------------------------------------ the next step
YOUR_FOLDERS = Doc("docs/your-game.md", "Your folders")
THREE_LINES = Doc("docs/your-game.md", "The three lines")
UNTRACKED = ("Later stages (labeling, training, measuring, extension builds) are not tracked here: "
             "docs/start-here.md, \"Where to go\", has the way on.")
# The playbook a coding agent loads for each next step (by the step's id), in playbooks/.
PLAYBOOKS = {
    **{key: "playbooks/try-my-game.md" for key in ("folder", "cards", "images", "video", "weights", "try",
                                                   "add-images")},
    "folder-access": "playbooks/try-my-game.md",
    "demo": "playbooks/make-extension.md",
    "clearer-view": "playbooks/train.md",
    "train": "playbooks/train.md",
}
# Why a step waits for the person, by a stable reason: what an agent says before going on.
STOP_PREFIX = "STOP (coding agents: ask the person first):"
STOPS = {
    "download": ("this downloads files from the internet "
                 f"({number_words(len(release_assets.ASSETS))} files from this project's GitHub release, each checked "
                 "against the hashes this repository pins)."),
    "persons-file": "the card list, the card images and the video come from them; never download or make them up.",
    "persons-choice": "several were found; which one they mean is theirs to say.",
    "persons-permission": "only they can let the terminal read this folder, in the system's settings.",
    "spend-or-time": "the way on is training, which takes a GPU (a rented one costs money) and hours of labeling.",
}
PUT = {
    "cards": "card list: your spreadsheet exported as CSV (UTF-8), such as cards.csv; a TSV file or a JSON list of "
             "rows works too",
    "images": "images/: one cleanly cropped image per card, named as your list's image column says",
    "video": "video.mp4: a video of your game; a photo, a screenshot or a folder of them works too",
}


def try_line(cards: Path, images: Path, video: Path, weights: Path, overwrite: bool) -> str:
    """The try line as docs/your-game.md writes it, with real paths."""
    from cardvision.try_game.run import shell_arg

    return (f"cardvision try {shell_arg(str(cards))} --images {shell_arg(str(images))} --video {shell_arg(str(video))} "
            f"--weights {shell_arg(str(weights))}" + (" --overwrite" if overwrite else ""))


def _choose(check_id: str) -> str:
    """How the person settles a choice that blocks."""
    if check_id == "images":
        return "rename the card images' folder to images/"
    return "keep the one you mean in the folder and move the others out"


def _blocking(check: Check) -> bool:
    """Whether a check stops the way on: missing, or several found and none taken."""
    return check.state == "missing" or check.blocks


def _next(root: Path, weights: Where, checks: list[Check], cards: Path | None, images: Path | None,
          video: Path | None, verdict: Any, no_image: Any, ran: set[str], out: Path, foreign: bool,
          raw: str) -> Step:
    from cardvision.try_game.run import demo_installed, demo_line, shell_arg

    by_id = {check.id: check for check in checks}
    if by_id["folder"].state == "missing":
        hint = [WINDOWS_HINT] if looks_like_windows(raw) else []
        return Step("folder", "make the game folder, then put three things in it:", YOUR_FOLDERS,
                    [f"mkdir -p {shell_arg(str(root))}"], hint + [PUT[key] for key in ("cards", "images", "video")],
                    stop="persons-file")
    inputs = [by_id[key] for key in ("cards", "images", "video")]
    blocking = [check for check in inputs if _blocking(check)]
    if blocking:
        first = blocking[0]
        missing = [check for check in blocking if check.state == "missing"]
        if first.state == "missing":
            notes = [PUT[check.id] for check in missing]
            notes += [f"{check.label}: {check.detail}; {_choose(check.id)}"
                      for check in blocking if check.state == "choice"]
            return Step(first.id, f"put what is missing in {root}:", YOUR_FOLDERS, notes=notes, stop="persons-file")
        return Step(first.id, f"choose the {first.label} to use: {first.detail}. {_choose(first.id)[:1].upper()}"
                              f"{_choose(first.id)[1:]}, then run cardvision next again.", YOUR_FOLDERS,
                    stop="persons-choice")
    if by_id["weights"].state == "missing":
        from cardvision.release_assets import RELEASE_TAG

        return Step("weights", f"download the released models ({RELEASE_TAG}) into the weights folder:",
                    THREE_LINES, [f"cardvision fetch-weights {shell_arg(str(weights.path))}"], stop="download")
    assert cards is not None and images is not None and video is not None
    try_check = by_id["try"]
    if try_check.state != "done":
        picks = [f"{check.label}: the line takes {_name(path, root)}, the most likely of several; put another in its "
                 "place if you mean it" for check, path in zip(inputs, (cards, images, video)) if check.state == "choice"]
        overwrite = bool(ran)
        if try_check.state == "changed":
            say = ("run try again: some of your files are newer than the last try's report (--overwrite replaces "
                   "only what try wrote):")
        elif overwrite:
            say = "run try again: the last run in cardvision-try can't be read (--overwrite replaces only what try wrote):"
        else:
            say = "try the released models on your cards:"
        notes = picks + ([f"{TRY_FOLDER}/ holds files try did not write and never replaces: move them out first"]
                         if foreign else [])
        if try_check.state == "changed":
            notes.append(f"if nothing was edited (the files were only copied again), the last report still holds: "
                         f"{shell_arg(str(out / 'report.html'))}")
        return Step("try", say, THREE_LINES, [try_line(cards, images, video, weights.path, overwrite)], notes,
                    [f"Then open {shell_arg(str(out / 'report.html'))} in a browser."])
    report = shell_arg(str(out / "report.html"))
    if verdict.kind == "none":
        return Step("clearer-view", "no cards were found: try a clearer, larger, more top-down view of the same cards, "
                                    "then run try again with --overwrite.", Doc("docs/your-game.md", "5. Read the result"),
                    notes=[f"the report says more: {report}"],
                    after=["If that does not help, training the detector for your game is next: docs/train.md.",
                           UNTRACKED], stop="persons-file")
    if verdict.kind == "few":
        return Step("train", f"cards were found but few named: look at the contact sheet in the report ({report}), "
                             "then read how to train the recognizer for your game.", Doc("docs/train.md"),
                    after=[UNTRACKED], stop="spend-or-time")
    if no_image is not None and no_image.none:
        many = len(no_image.none) > 1
        shown = ", ".join(card_id for card_id, _name in no_image.none[:5])
        more = f" and {len(no_image.none) - 5} more" if len(no_image.none) > 5 else ""
        return Step("add-images", f"{len(no_image.none)} of the cards in your list can't be named for want of an "
                                  f"image ({shown}{more}): add {'their images' if many else 'its image'} to "
                                  f"{_name(images, root)} (or fix the image column), then run try again.",
                    THREE_LINES, [try_line(cards, images, video, weights.path, True)],
                    [f"the report lists them all: {report}"], stop="persons-file")
    demo_file = video
    if video.is_dir():
        from cardvision.infer.frames import expand_inputs

        demo_file = expand_inputs([video])[0]
    line = demo_line(out / "release", images, demo_file, install=not demo_installed())
    return Step("demo", "cards were found and named: see them in the demo page (from the repository's root):",
                Doc("docs/extension.md"), [line],
                after=["Before you claim how accurate it is for your game: docs/measure.md.", UNTRACKED])


# ------------------------------------------------------------------------------ output
def as_json(found: Look) -> dict[str, Any]:
    step = found.next
    return {
        "schemaVersion": SCHEMA_VERSION,
        "game": {"path": str(found.game.path), "chosen": found.game.chosen},
        "weights": {"path": str(found.weights.path), "chosen": found.weights.chosen},
        "checks": [{"id": check.id, "state": check.state, "detail": check.detail, "paths": check.paths,
                    "taken": check.taken, "blocks": check.blocks, "source": check.source} for check in found.checks],
        "next": {"id": step.id, "say": step.say,
                 "stop": None if step.stop is None else {"reason": step.stop, "say": STOPS[step.stop]},
                 "notes": step.notes, "commands": step.commands, "doc": step.doc.link(), "after": step.after,
                 "playbook": step.playbook},
        "verdict": found.verdict,
        "noImage": found.no_image,
    }


def as_text(found: Look) -> str:
    step = found.next
    lines = [f"Looked at {found.game.path} ({found.game.words})."]
    lines += [f"  {check.state:<8} {check.label}: {check.detail}" for check in found.checks]
    lines.append(f"Next: {step.say}")
    if step.stop is not None:
        lines.append(f"{STOP_PREFIX} {STOPS[step.stop]}")
    unsafe = _unsafe_names(step.commands)
    if unsafe:      # a command a terminal can't take safely is not shown; the step is to rename
        lines[-1 if step.stop is None else -2] = "Next: rename what is named below, then run cardvision next again:"
    lines += [f"  - {note}" for note in step.notes]
    lines += [f"  - rename {name}: its name has control characters, which a terminal can't take safely"
              for name in unsafe]
    lines = [visible(line) for line in lines]
    if not unsafe:
        lines += [f"  {command}" for command in step.commands]     # quoted for the shell already
    lines.append(f"Read: {step.doc.words()}")
    lines += [visible(line) for line in step.after]
    lines.append(f"Playbook (for coding agents): {step.playbook}")
    return "\n".join(lines)


def _unsafe_names(commands: list[str]) -> list[str]:
    """The paths, up to the first name that holds a character that prints as nothing (a control
    character), that the commands hold; empty when they hold none."""
    found: list[str] = []
    for command in commands:
        if command.isprintable():
            continue
        try:
            words = shlex.split(command)
        except ValueError:
            words = command.split()
        for word in words:
            if word.isprintable():
                continue
            parts = Path(word).parts
            cut = next(index for index, part in enumerate(parts) if not part.isprintable())
            name = str(Path(*parts[:cut + 1]))
            if name not in found:
                found.append(name)
    return found


def visible(text: str) -> str:
    """``text`` with control characters (a carriage return, an escape, ...) and other characters
    that print as nothing written as Python writes them in a string (``\\r``, ``\\x1b``), so
    that a file's name can't move the cursor or recolor the terminal."""
    return "".join(char if char.isprintable() else repr(char)[1:-1] for char in text)


# ------------------------------------------------------------------------------ the command
def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Declare the subcommand's arguments."""
    parser.add_argument("game", nargs="?", type=Path, metavar="GAME",
                        help="your game folder (default: $GAME, else ~/Downloads/my-game)")
    parser.add_argument("--weights", type=Path, metavar="DIR",
                        help="the folder of the released weights (default: $WEIGHTS, else "
                             "~/Downloads/cardvision-weights)")
    parser.add_argument("--json", action="store_true",
                        help="print one JSON object (schemaVersion 1) instead of the lines for people")


def run(args: argparse.Namespace) -> int:
    """Run the subcommand; returns the process exit code."""
    game = resolve(args.game, GAME_VARIABLE, DEFAULT_GAME, "given as the argument")
    weights = resolve(args.weights, WEIGHTS_VARIABLE, DEFAULT_WEIGHTS, "given with --weights")
    if _safe(Path.exists, game.path) and not _safe(Path.is_dir, game.path):
        print(f"cardvision next: {game.path} ({game.words}) is a file, not a folder; give the folder that holds your "
              f"card list, images and video, such as: cardvision next {_quoted(game.path.parent)}", file=sys.stderr)
        return 2
    found = look(game, weights)
    try:     # a name that is not valid UTF-8 is printed escaped rather than stopping the command
        sys.stdout.reconfigure(errors="backslashreplace")
    except (AttributeError, ValueError):
        pass
    print(json.dumps(as_json(found), indent=1) if args.json else as_text(found))
    return 0


def _quoted(path: Path) -> str:
    from cardvision.try_game.run import shell_arg

    return shell_arg(str(path))
