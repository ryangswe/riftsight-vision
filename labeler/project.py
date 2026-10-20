# SPDX-License-Identifier: Apache-2.0
"""What the labeling tool's start screen and project screen are told: the facts, never the words.

A project is one sample file and what lies beside it. Everything here takes paths and returns
plain values; nothing here knows about the running server, and nothing is written except by the
three functions that say so (`remember_recent`, `forget_recent`, `write_project_file`).

    find_project(text, base)   a path a person typed, resolved and checked: a sample, or why not
    find_samples(root)         the sample files under one folder, to a bounded depth and count
    report(sample, ...)        one project: its recordings and frames, where each of its files is
                               looked for and whether it is there, what its labels are for, how
                               far each pass has come, which passes can be started and why not,
                               and the commands that start them
    open_values(report, ...)   the server settings that start one pass of a reported project

What is remembered, in two small files (labeler/FORMAT.md, "What the tool remembers"):

    <labels folder>/labeler-project.json   what a project was opened with: its purpose and the
                                            locations that are not where they are looked for anyway
    <per-user folder>/recent.json           the projects opened before, newest first

The per-user folder is `Library/Application Support/card-labeler` in the home folder on macOS,
`%APPDATA%\\card-labeler` on Windows and `$XDG_STATE_HOME/card-labeler` elsewhere (in the home
folder, `.local/state/card-labeler`); the environment variable LABELER_STATE_DIR names
another one. The tool works when either file is absent, unreadable or out of date.

Standard library only.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import shlex
import sys
import tempfile
from collections import deque
from pathlib import Path

sys.dont_write_bytecode = True

import labelcore as lc  # noqa: E402
import labelfiles as lf  # noqa: E402

PROJECT_FILE = "labeler-project.json"
PROJECT_SCHEMA = 1
STATE_ENV = "LABELER_STATE_DIR"
STATE_NAME = "card-labeler"
RECENT_NAME = "recent.json"
RECENT_MAX = 20
SAMPLE_NAME = "sample.json"

# The search for samples under the start folder: how deep, and when it gives up.
SEARCH_DEPTH = 3
SEARCH_DIRS = 400
SEARCH_ENTRIES = 20000
SEARCH_FOUND = 12
SEARCH_SKIP = frozenset({"node_modules", "__pycache__", "site-packages"})
SAMPLE_BYTES = lf.SAMPLE_BYTES  # the largest file a path from the page may name (labelfiles.py)

ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
ROLE_ORDER = ("training", "development", "test")
PASS_ORDER = ("box", "identify", "corner", "training", "point", "center", "verify")
GEOMETRY_PASSES = ("box", "corner", "training", "point", "center")
BUTTON_PASSES = ("box", "identify", "corner", "training", "point", "center", "verify")  # every pass the page starts
BOX_SET_MODES = ("box", "corner", "training")  # the sets the COCO export writes
MANIFEST_SET_MODES = BOX_SET_MODES + ("center", "point")  # the sets the manifest export writes
MEASURING_ROLES = ("development", "test")  # labels a model is measured on: the census of centers comes first
MANIFEST_FOLDER = "manifest"  # beside the sample: a manifest's folder holds text only
LOCATION_KEYS = ("frames", "labels", "catalog", "art", "decklists", "prefill")
STORED_LOCATIONS = ("frames", "catalog", "art", "decklists", "prefill")  # labels: the file lies in it
PREFILL_NAMES = ("prefill.jsonl", "prefill.json")
DEFAULT_COMMAND = {"prefix": ["python3", "labeler/serve.py"], "tail": [], "cwd": None}


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def is_url(text) -> bool:
    return isinstance(text, str) and text.lower().startswith(("http://", "https://"))


def _write_whole(path: Path, text: str) -> None:
    """The file is written whole or not at all."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def _read_json(path):
    """A small JSON file of this tool (the project file, the list of projects), or None: only a
    regular file of a bounded size is read."""
    doc, problem = lf.read_json(path, SAMPLE_BYTES)
    return None if problem else doc


def _resolve(value, base) -> Path:
    """A path as a person or a file gives it: `~` is the home folder, a relative path starts at
    `base`."""
    p = Path(str(value)).expanduser()
    if not p.is_absolute():
        p = Path(base) / p
    return p.resolve()


def _same(a, b) -> bool:
    try:
        return Path(a).resolve() == Path(b).resolve()
    except OSError:
        return False


def _inside(path, root) -> bool:
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
        return True
    except (ValueError, OSError):
        return False


# ---- the per-user list of projects opened before -------------------------------------------------

def state_place(platform: str, env: dict, home: str) -> list:
    """Where the per-user folder is, as path parts, for a platform (`sys.platform`), its
    environment and the home folder."""
    if env.get(STATE_ENV):
        return [env[STATE_ENV]]
    if platform == "darwin":
        return [home, "Library", "Application Support", STATE_NAME]
    if platform.startswith("win"):
        return [env["APPDATA"], STATE_NAME] if env.get("APPDATA") else [home, "AppData", "Roaming", STATE_NAME]
    return [env["XDG_STATE_HOME"], STATE_NAME] if env.get("XDG_STATE_HOME") else [home, ".local", "state", STATE_NAME]


def state_dir() -> Path:
    try:
        home = str(Path.home())
    except RuntimeError:  # no home folder is known: the list is kept beside the temporary files
        home = tempfile.gettempdir()
    return Path(*state_place(sys.platform, dict(os.environ), home)).expanduser()


def recent_file() -> Path:
    return state_dir() / RECENT_NAME


def read_recent() -> list:
    """[{sample, labels, openedAt}], newest first. [] when the file is absent or is not what
    this tool wrote; an entry that is not is skipped."""
    doc = _read_json(recent_file())
    out = []
    for e in (doc.get("projects") if isinstance(doc, dict) else None) or []:
        if isinstance(e, dict) and isinstance(e.get("sample"), str) and e["sample"]:
            labels = e.get("labels") if isinstance(e.get("labels"), str) and e.get("labels") else None
            out.append({"sample": e["sample"], "labels": labels, "openedAt": e.get("openedAt") if isinstance(e.get("openedAt"), str) else None})
    return out[:RECENT_MAX]


def _write_recent(entries: list) -> bool:
    try:
        _write_whole(recent_file(), json.dumps({"schemaVersion": 1, "tool": "labeler", "projects": entries[:RECENT_MAX]}, indent=1) + "\n")
        return True
    except OSError:
        return False


def remember_recent(sample, labels) -> bool:
    """Put a project at the top of the list. False when the list cannot be written."""
    sample = str(Path(sample))
    entries = [e for e in read_recent() if e["sample"] != sample]
    entries.insert(0, {"sample": sample, "labels": str(Path(labels)) if labels else None, "openedAt": _now()})
    return _write_recent(entries)


def forget_recent(sample) -> bool:
    sample = str(sample)
    entries = read_recent()
    kept = [e for e in entries if e["sample"] != sample]
    return len(kept) == len(entries) or _write_recent(kept)


# ---- a sample ------------------------------------------------------------------------------------

def _asset(listed: dict) -> dict:
    """A video of a sample as this module works with it: {"id", "frames": [frame names],
    "framesDir": text or None, "listed": the entry itself (labelcore.sample_assets)}."""
    own = listed.get("framesDir") if isinstance(listed.get("framesDir"), str) and listed.get("framesDir") else None
    return {"id": listed["assetId"], "frames": [f["name"] for f in listed["frames"]], "framesDir": own, "listed": listed}


def read_sample(path) -> tuple:
    """(assets, None), or (None, problem): missing, not-file (a folder, a device or a pipe),
    too-big (over SAMPLE_BYTES), unreadable, not-json, not-sample. An asset is {"id", "frames":
    [frame names], "framesDir": text or None, "listed"}. What a sample lists is one rule for
    the whole tool (labelcore.sample_assets): an entry that is no video with a usable id, and a
    frame without a usable name, is left out here, on the labeling page and in the export.
    The file is read only when it is a regular file of at most SAMPLE_BYTES (labelfiles.py)."""
    listed, problem = lf.read_sample(path, SAMPLE_BYTES)
    if problem:
        return None, problem
    return [_asset(a) for a in listed], None


def find_project(text, base) -> dict:
    """A folder or a sample file as a person names it → {"ok": True, "sample": Path}, or
    {"ok": False, "problem", "path"}: empty, bad-path, missing, no-sample-in-folder, unreadable,
    not-json, not-sample. A folder stands for the `sample.json` in it; nothing else in a folder
    is looked at."""
    raw = str(text or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        raw = raw[1:-1].strip()
    if not raw:
        return {"ok": False, "problem": "empty", "path": None}
    try:
        p = _resolve(raw, base)
        is_dir = p.is_dir()
        exists = p.exists()
    except (OSError, ValueError, RuntimeError):
        return {"ok": False, "problem": "bad-path", "path": raw}
    if is_dir:
        if not (p / SAMPLE_NAME).is_file():
            return {"ok": False, "problem": "no-sample-in-folder", "path": str(p)}
        p = p / SAMPLE_NAME
    elif not exists:
        return {"ok": False, "problem": "missing", "path": str(p)}
    _assets, problem = read_sample(p)
    if problem:
        return {"ok": False, "problem": problem, "path": str(p)}
    return {"ok": True, "sample": p}


def find_samples(root) -> dict:
    """{"found": [Path], "cut": bool, "depth"}: the sample files in `root` and up to SEARCH_DEPTH
    folders below it: JSON files with "sample" in their name that hold a list of videos. Hidden
    folders are not entered. `cut`: the search stopped at one of its bounds, so there may be more."""
    root = Path(root)
    found, cut = [], False
    queue = deque([(root, 0)])
    dirs = entries = 0
    while queue and not cut:
        folder, depth = queue.popleft()
        if dirs >= SEARCH_DIRS:
            cut = True
            break
        dirs += 1
        below, here = [], []
        try:
            with os.scandir(folder) as it:
                for e in it:
                    entries += 1
                    if entries > SEARCH_ENTRIES:
                        cut = True
                        break
                    name = e.name
                    if name.startswith("."):
                        continue
                    try:
                        if e.is_dir(follow_symlinks=False):
                            if name not in SEARCH_SKIP and depth < SEARCH_DEPTH:
                                below.append(Path(e.path))
                        elif name.lower().endswith(".json") and "sample" in name.lower() and e.is_file() and e.stat().st_size <= SAMPLE_BYTES:
                            here.append(Path(e.path))
                    except OSError:
                        continue
        except OSError:
            continue
        for p in sorted(here):
            if len(found) >= SEARCH_FOUND:
                cut = True
                break
            if read_sample(p)[0] is not None:
                found.append(p)
        queue.extend((p, depth + 1) for p in sorted(below))
    return {"found": found, "cut": cut, "depth": SEARCH_DEPTH}


def project_name(sample) -> str:
    sample = Path(sample)
    folder = sample.parent.name or str(sample.parent)
    return folder if sample.name == SAMPLE_NAME else f"{folder}/{sample.name}"


def summary(sample) -> dict:
    """One line about a sample, for a list: {sample, folder, name, recordings, frames}, or with
    `problem` when it cannot be read any more."""
    sample = Path(sample)
    assets, problem = read_sample(sample)
    out = {"sample": str(sample), "folder": str(sample.parent), "name": project_name(sample)}
    if problem:
        return {**out, "problem": problem}
    return {**out, "recordings": len(assets), "frames": sum(len(a["frames"]) for a in assets)}


# ---- the file in the labels folder ---------------------------------------------------------------

def read_project_file(labels_dir, sample) -> dict:
    """{"role", "locations": {key: Path or URL}, "modelBoxes"}, or {} when there is no such file,
    it is not this tool's, or it was written for another sample."""
    labels_dir = Path(labels_dir)
    doc = _read_json(labels_dir / PROJECT_FILE)
    if not isinstance(doc, dict) or doc.get("tool") != "labeler":
        return {}
    named = doc.get("sample")
    if not isinstance(named, str) or not named or not _same(_resolve(named, labels_dir), sample):
        return {}
    out = {"role": doc.get("role") if doc.get("role") in lc.ROLES else None, "locations": {},
           "modelBoxes": doc.get("modelBoxes") if isinstance(doc.get("modelBoxes"), bool) else None}
    given = doc.get("locations")
    for key in STORED_LOCATIONS:
        value = given.get(key) if isinstance(given, dict) else None
        if isinstance(value, str) and value:
            out["locations"][key] = value if is_url(value) else _resolve(value, labels_dir)
    return out


def _portable(path, labels_dir: Path, project_dir: Path) -> str:
    """A path as the project file holds it: relative to the labels folder when it lies in the
    project's own folder (the folder can then be moved as a whole), else in full."""
    if is_url(path):
        return str(path)
    if _inside(path, project_dir):
        return Path(os.path.relpath(str(path), str(labels_dir))).as_posix()
    return str(path)


def write_project_file(labels_dir, sample, role, places: dict, model_boxes=None) -> tuple:
    """Write what a project was opened with. `places`: the report's `locations`. Only what is
    not found anyway is stored: a location that is where it is looked for is left out. Returns
    (path, None), or (None, problem) when the labels folder cannot be written. A file that
    already says the same is left as it is."""
    labels_dir, sample = Path(labels_dir), Path(sample)
    doc = {"schemaVersion": PROJECT_SCHEMA, "tool": "labeler",
           "sample": _portable(sample, labels_dir, sample.parent) if _inside(labels_dir, sample.parent) else str(sample)}
    if role in lc.ROLES:
        doc["role"] = role
    stored = {}
    for key in STORED_LOCATIONS:
        place = places.get(key) or {}
        if place.get("path") and not place.get("usual"):
            stored[key] = _portable(place["path"], labels_dir, sample.parent)
    if stored:
        doc["locations"] = stored
    if isinstance(model_boxes, bool):
        doc["modelBoxes"] = model_boxes
    path = labels_dir / PROJECT_FILE
    old = _read_json(path)
    if isinstance(old, dict) and {k: v for k, v in old.items() if k != "savedAt"} == doc:
        return path, None
    try:
        _write_whole(path, json.dumps({**doc, "savedAt": _now()}, indent=1) + "\n")
    except OSError as exc:
        return None, getattr(exc, "strerror", None) or str(exc)
    return path, None


# ---- where a project's files are -----------------------------------------------------------------

def _writable(path: Path) -> str:
    """ok (a folder that can be written), will-create (it is not there and can be made),
    not-folder, or not-writable."""
    if path.exists():
        if not path.is_dir():
            return "not-folder"
        return "ok" if os.access(path, os.W_OK | os.X_OK) else "not-writable"
    parent = path.parent
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    return "will-create" if parent.is_dir() and os.access(parent, os.W_OK | os.X_OK) else "not-writable"


def catalog_check(path) -> tuple:
    """(number of cards, None), or (None, what is wrong with the file in one sentence): the
    checks the server makes before it starts with a catalog. Only a regular file of at most
    SAMPLE_BYTES is read."""
    doc, problem = lf.read_json(path, SAMPLE_BYTES)
    if problem == "not-json":
        return None, "it is not JSON"
    if problem:
        return None, lf.PROBLEM_WORDS[problem]
    if not isinstance(doc, dict):
        return None, "it is not a JSON object with a `cards` list"
    for key in ("cards", "tokens"):
        entries = doc.get(key)
        for position, entry in enumerate(entries if isinstance(entries, list) else []):
            card_id = entry.get("id") if isinstance(entry, dict) else None
            if isinstance(card_id, str) and card_id and lc.card_id_error(card_id):
                return None, f"{key}[{position}]: {lc.card_id_error(card_id)}"
    problem = lc.identity_rule_problem(doc) or lc.facets_problem(doc) or lc.extra_problem(doc)
    if problem:
        return None, problem
    cards = doc.get("cards")
    return sum(1 for c in (cards if isinstance(cards, list) else []) if isinstance(c, dict) and isinstance(c.get("id"), str)), None


def _candidates(key, given, flags, remembered):
    for source, values in (("page", given), ("flag", flags), ("remembered", remembered)):
        value = (values or {}).get(key)
        if value not in (None, ""):
            yield source, value


def locations(sample, assets, given=None, flags=None, remembered=None, base=None, recent_labels=None) -> dict:
    """Where each of a project's files is looked for: {key: {path, source, state, ...}}.

    source   page (changed on the project screen), flag (given on the command line), remembered
             (the project file, or for the labels folder the list of projects opened before),
             beside (the conventional place beside the sample)
    state    ok; absent (nothing at the conventional place: fine for what is optional); missing
             (a place that was named holds nothing); unreadable (a catalog that cannot be
             used: `problem` says why); for the labels folder ok, will-create, not-folder or
             not-writable; for the frames folder also unused (every video names its own folder);
             off (the running pass was started without it: `False` among the flags)
    """
    sample = Path(sample)
    beside = sample.parent
    base = Path(base) if base else beside
    out = {}

    def pick(key, conventional, remembered_values=remembered):
        for source, value in _candidates(key, given, flags, remembered_values):
            if value is False:  # this run does without it, whatever lies beside the sample
                return None, source
            if key == "art" and is_url(value):
                return str(value), source
            try:
                return _resolve(value, base if source != "remembered" else beside), source
            except (OSError, ValueError, RuntimeError):
                continue
        return conventional, "beside"

    # the labels folder
    path, source = pick("labels", beside / "labels", {"labels": recent_labels} if recent_labels else None)
    out["labels"] = {"path": str(path), "source": source, "state": _writable(Path(path))}

    # the frames folder (a video of the sample may name its own)
    path, source = pick("frames", beside / "frames")
    own = sum(1 for a in assets if a["framesDir"])
    state = "ok" if Path(path).is_dir() else "unused" if assets and own == len(assets) else "missing" if source != "beside" else "absent"
    out["frames"] = {"path": str(path), "source": source, "state": state, "ownFolders": own}

    # the catalog
    path, source = pick("catalog", beside / "catalog.json")
    place = {"path": str(path) if path else None, "source": source}
    if path is None:
        place["state"] = "off"
    elif os.path.exists(path):
        cards, problem = catalog_check(path)
        place.update({"state": "ok", "cards": cards} if problem is None else {"state": "unreadable", "problem": problem})
    else:
        place["state"] = "missing" if source != "beside" else "absent"
    out["catalog"] = place

    # the card images: a folder, or an address the browser loads them from
    path, source = pick("art", beside / "art")
    if path is None:
        out["art"] = {"path": None, "source": source, "state": "off"}
    elif is_url(path):
        out["art"] = {"path": path, "source": source, "state": "ok", "url": True}
    else:
        out["art"] = {"path": str(path), "source": source, "state": "ok" if Path(path).is_dir() else "missing" if source != "beside" else "absent"}

    # the deck lists
    path, source = pick("decklists", beside / "decklists")
    place = {"path": str(path), "source": source}
    if Path(path).is_dir():
        try:
            place.update(state="ok", files=sum(1 for p in Path(path).iterdir() if p.suffix == ".txt" and p.is_file()))
        except OSError:
            place.update(state="missing")
    else:
        place["state"] = "missing" if source != "beside" else "absent"
    out["decklists"] = place

    # a model's suggestions
    conventional = next((beside / name for name in PREFILL_NAMES if (beside / name).is_file()), beside / PREFILL_NAMES[0])
    path, source = pick("prefill", conventional)
    if path is None:
        out["prefill"] = {"path": None, "source": source, "state": "off"}
    else:  # read later, by the pass that uses it: only a regular file of a bounded size is offered
        problem = lf.file_problem(path, SAMPLE_BYTES)
        place = {"path": str(path), "source": source, "state": "ok" if problem is None else "missing" if source != "beside" else "absent"}
        if problem not in (None, "missing"):
            place.update(state="unreadable", problem=lf.PROBLEM_WORDS[problem])
        out["prefill"] = place
    usual = {"labels": beside / "labels", "frames": beside / "frames", "catalog": beside / "catalog.json", "art": beside / "art",
             "decklists": beside / "decklists", "prefill": conventional}
    for key, place in out.items():  # `usual`: it is where it would be looked for anyway
        place["usual"] = bool(place["path"]) and not is_url(place["path"]) and Path(place["path"]) == usual[key]
    return out


def frames_folder(sample, asset: dict, frames_dir) -> Path:
    """Where one video's frames are: its own `framesDir` (relative to the sample), else
    <frames folder>/<asset id>. The server's own rule (serve.frames_dir_for)."""
    if asset["framesDir"]:
        p = Path(asset["framesDir"]).expanduser()
        return p if p.is_absolute() else (Path(sample).parent / p).resolve()
    return Path(frames_dir) / asset["id"]


def frame_check(sample, assets, frames_dir) -> dict:
    """{listed, onDisk, missing, firstMissing, thumb}: how many of the frames the sample lists are
    on disk, the first that is not, and the first that is (for a thumbnail)."""
    listed = on_disk = 0
    first_missing = thumb = None
    for a in assets:
        folder = frames_folder(sample, a, frames_dir)
        try:
            names = set(os.listdir(folder))
        except OSError:
            names = set()
        for name in a["frames"]:
            listed += 1
            if name in names:
                on_disk += 1
                thumb = thumb or {"asset": a["id"], "name": name, "path": str(folder / name)}
            elif first_missing is None:
                first_missing = str(folder / name)
    return {"listed": listed, "onDisk": on_disk, "missing": listed - on_disk, "firstMissing": first_missing, "thumb": thumb}


# ---- what the label files say --------------------------------------------------------------------

def read_set(labels_dir, set_id) -> tuple:
    """(meta or None, frame rows) of one label set, read by the tool's one reader
    (labelfiles.read_label_set): a line that is not a JSON object is never skipped in silence,
    it is under `rows.damage` with its file and line number."""
    return lf.read_label_set(Path(labels_dir) / set_id)


def _is_card(t: dict) -> bool:
    return isinstance(t, dict) and t.get("outcome") in (None, "card") and not t.get("ignore")


def set_status(entry: dict) -> dict:
    """What one label set holds (`entry`: one of labelfiles.label_sets), counted over the frames
    this sample lists for it: its mode and role, frames done, boxes, the cards among them and
    how many still wait in the Names pass's walk, and the centers clicked. `damaged`: the lines
    of its files that could not be read ([{file, line, problem}]); such a set is counted from
    its readable rows, opens read-only on the labeling page and is left out of the export."""
    meta, rows = entry["meta"], entry["rows"]
    names = {f["name"] for f in entry["asset"]["frames"]}
    mine = [r for r in rows if r.get("name") in names]
    out = {"setId": entry["setId"], "frames": len(names), "labeled": bool(meta) or bool(rows),
           "foreign": lc.is_foreign_set(meta, rows), "mode": (meta or {}).get("mode"), "role": (meta or {}).get("role"),
           "done": sum(1 for r in mine if r.get("done")), "boxes": 0, "cards": 0, "toName": 0, "faces": 0, "facesNamed": 0,
           "removed": len(entry["asset"].get("removedFrames") or []),
           "damaged": lf.own_damage(meta, rows)}
    if entry["frameAsset"] != entry["setId"]:
        out["repeatOf"] = entry["frameAsset"]  # a repeat set: some frames of that video, labeled again
    if out["foreign"]:
        return out
    targets = [t for r in mine for t in (r.get("targets") or []) if isinstance(t, dict)]
    out["boxes"] = len(targets)
    out["cards"] = sum(1 for t in targets if _is_card(t))
    if out["mode"] in lc.IDENTIFY_SET_MODES:
        out["toName"] = len(lc.identify_queue(mine))
    faces = [c for r in mine for c in (r.get("centers") or []) if isinstance(c, dict) and c.get("kind") == "face"]
    out["faces"] = len(faces)
    out["facesNamed"] = sum(1 for c in faces if lc.answer_complete(c))
    return out


def role_facts(sets: list, asked, flagged, remembered) -> dict:
    """What the labels are for. `stored`: the roles the label sets on disk were made with, each
    with its sets. One stored role is the answer and cannot be changed (`fixed`); with none, the
    answer is the one asked for (on the page, else on the command line), else the one remembered.
    `refused`: a role that was asked for and is not the stored one."""
    stored = {}
    for role in ROLE_ORDER:
        ids = [s["setId"] for s in sets if s["labeled"] and not s["foreign"] and s["role"] == role]
        if ids:
            stored[role] = ids
    wanted = asked if asked in lc.ROLES else flagged if flagged in lc.ROLES else None
    remembered = remembered if remembered in lc.ROLES else None
    if len(stored) == 1:
        value = next(iter(stored))
    elif stored:
        value = wanted if wanted in stored else remembered if remembered in stored else None
    else:
        value = wanted or remembered
    return {"value": value, "stored": stored, "fixed": len(stored) == 1, "choices": list(stored) if stored else list(ROLE_ORDER),
            "refused": wanted if wanted and stored and wanted not in stored else None,
            "source": "labels" if stored and value else "asked" if value and value == wanted else "remembered" if value else None}


def _refusal(mode: str, role: str):
    """The reason the server would refuse to start `mode` for `role`, as a code, or None. Check
    names started from the page is the form with no model's proposal (--all-blind)."""
    try:
        lc.check_mode_role(mode, role, False, mode == "verify")
    except ValueError:
        return {"training": "training-only", "center": "not-for-training", "verify": "not-for-training"}.get(mode, "refused")
    return None


def pass_facts(mode: str, role, sets: list, places: dict, frames: dict) -> dict:
    """One pass of a project: the sets it works on, how far it has come, and whether it can be
    started (`allowed`), with the reason as a code when it cannot.

    A set takes a pass that draws (Boxes, Corners, Corners from the model, Points, Centers) when
    it has no labels yet, or has that pass's labels for the same purpose: a set keeps one way of
    labeling. Names works on sets that have boxes or corners, Check names on sets with centers.
    """
    out = {"id": mode, "allowed": False, "reason": None, "sets": [], "frames": 0, "done": 0, "action": None,
           "button": mode in BUTTON_PASSES}
    usable = [s for s in sets if not s["foreign"] and not s["damaged"]]  # a damaged set opens read-only
    if mode in GEOMETRY_PASSES:
        mine = [s for s in usable if not s["labeled"] or (s["mode"] == mode and s["role"] == role)]
    elif mode == "identify":
        mine = [s for s in usable if s["labeled"] and s["mode"] in lc.IDENTIFY_SET_MODES and s["role"] == role]
    else:
        mine = [s for s in usable if s["labeled"] and s["mode"] == "center" and s["role"] == role]
    out["sets"] = [s["setId"] for s in mine]
    out["frames"] = sum(s["frames"] for s in mine)
    out["done"] = sum(s["done"] for s in mine)
    if mode == "identify":
        out.update(cards=sum(s["cards"] for s in mine), left=sum(s["toName"] for s in mine), boxes=sum(s["boxes"] for s in mine))
    if mode == "verify":
        out.update(faces=sum(s["faces"] for s in mine), named=sum(s["facesNamed"] for s in mine))
    reason = None
    if role is None:
        reason = "no-role"
    elif _refusal(mode, role):
        reason = _refusal(mode, role)
    elif places["labels"]["state"] not in ("ok", "will-create"):
        reason = "labels-not-writable"
    elif mode in ("identify", "verify") and places["catalog"]["state"] != "ok":
        reason = "bad-catalog" if places["catalog"]["state"] == "unreadable" else "no-catalog"
    elif mode == "identify" and not out["boxes"]:
        reason = "nothing-to-name"
    elif mode == "verify" and not out["faces"]:
        reason = "no-centers"
    elif mode == "training" and places["prefill"]["state"] != "ok":
        reason = "bad-suggestions" if places["prefill"]["state"] == "unreadable" else "no-suggestions"
    elif mode in GEOMETRY_PASSES and not mine:
        out["have"] = sorted({s["mode"] for s in usable if s["labeled"] and s["mode"]})
        # every set is labeled another way, or what is left cannot be read (the top of the page says which file)
        reason = "no-frames" if not sets else "other-way" if out["have"] or not any(s["damaged"] for s in sets) else "damaged"
    elif mode in GEOMETRY_PASSES and not out["frames"]:
        reason = "all-removed" if any(s.get("removed") for s in mine) else "no-frames"
    elif mode in GEOMETRY_PASSES and frames["listed"] and not frames["onDisk"]:
        reason = "frames-missing"
    out["reason"] = reason
    out["allowed"] = reason is None
    if out["allowed"]:
        if mode == "identify":
            named = out["cards"] - out["left"]
            out["action"] = "review" if not out["left"] else "continue" if named > 0 else "start"
        elif mode == "verify":
            out["action"] = "review" if out["named"] >= out["faces"] else "continue" if out["named"] else "start"
        else:
            out["action"] = "review" if out["done"] >= out["frames"] else "continue" if out["done"] else "start"
    return out


def first_pass(role, sets: list) -> str:
    """The pass a project's labels are made with, from what its label files hold: the way its
    sets were labeled, or for a project with no labels yet the way that fits its purpose (labels
    to measure a model on: the census of centers, the way this project's own figures were
    measured; else boxes)."""
    modes = {s["mode"] for s in sets if s["labeled"] and not s["foreign"] and not s["damaged"]}
    if not modes:
        return "center" if role in MEASURING_ROLES else "box"
    return "box" if "box" in modes else next((m for m in ("corner", "training", "center", "point") if m in modes), "box")


def export_kind(role) -> str:
    """The export a purpose leads to: `coco` (boxes to train on) for Training, `manifest` (the
    form `cardvision evaluate` reads) for labels a model is measured on."""
    return "manifest" if role in MEASURING_ROLES else "coco"


def next_step(passes: dict, sets: list, export: dict, role=None) -> dict:
    """{"pass": a pass id, "export" or None, "startable"}: what comes next in a project, from
    what its label files hold and what they are for. Training: Boxes, then Names, then the export.
    Development and Test: Centers, then Check names, then the export. A project whose sets were
    made another way (Boxes, Corners, Points) goes on that way."""
    flow = first_pass(role, sets)
    first = passes[flow]
    kind = export_kind(role)
    if first["allowed"] and first["done"] < first["frames"]:
        step = flow
    elif flow in BOX_SET_MODES and passes["identify"]["allowed"] and passes["identify"]["left"] > 0:
        step = "identify"
    elif flow == "center" and passes["verify"]["allowed"] and passes["verify"]["named"] < passes["verify"]["faces"]:
        step = "verify"
    elif export[kind]["included"] > 0 and (flow in BOX_SET_MODES or kind == "manifest"):
        step = "export"
    else:
        step = None
    return {"pass": step, "startable": step in BUTTON_PASSES and passes[step]["allowed"]}


def _exported(meta, row) -> bool:
    """A frame row the manifest export writes: confirmed, and for a census or a point set with at
    least one point to write (a confirmed census with no center is not exportable as points)."""
    if not row.get("done"):
        return False
    if meta.get("mode") == "center":
        return any(isinstance(c, dict) for c in row.get("centers") or [])
    if meta.get("mode") == "point":
        return any(isinstance(p, dict) and p.get("outcome") for p in row.get("points") or [])
    return True


def export_facts(labels_dir, sets: list, assets=None) -> dict:
    """What each export would write from this labels folder (every set in the folder, as the
    export reads it): `coco` the frames done in its box, corner and training sets; `manifest`
    those and the confirmed frames of its censuses and point sets. For each: the frames written,
    from how many recordings, and how many frames of this sample are not done and so left out.
    A set with a damaged file is left out whole, as the export leaves it out: `damaged` names
    each such file and line. For the manifest also what it needs that labeling did not ask for:
    `untagged` (sets whose footage has no source type: the page asks for one), `unaddressed` (the
    recordings of the sample with no platform and video id: the sample must say where they are)
    and `unanswered` (faces of a census without a checked name)."""
    counts = {kind: {"included": 0, "recordings": 0} for kind in ("coco", "manifest")}
    damaged, untagged, unanswered = [], [], 0
    root = Path(labels_dir)
    gone = lf.removed_keys(lf.read_removed(root)[0])  # the export skips removed frames
    try:
        folders = sorted(p for p in root.iterdir() if p.is_dir())
    except OSError:
        folders = []
    for d in folders:
        meta, rows = read_set(root, d.name)
        if lf.own_damage(meta, rows):
            damaged += [{"setId": d.name, **x} for x in lf.own_damage(meta, rows)]
            continue
        if meta is None or lc.is_foreign_set(meta, rows) or meta.get("mode") not in MANIFEST_SET_MODES:
            continue
        video = meta.get("frameAsset") or d.name
        rows = [r for r in rows if (video, r.get("name")) not in gone]
        for kind, modes in (("coco", BOX_SET_MODES), ("manifest", MANIFEST_SET_MODES)):
            if meta.get("mode") not in modes:
                continue
            done = sum(1 for r in rows if _exported(meta, r))
            counts[kind]["included"] += done
            counts[kind]["recordings"] += 1 if done else 0
        rec = meta.get("recording") if isinstance(meta.get("recording"), dict) else {}
        if rec.get("source") not in ("physical", "digital") and not meta.get("repeatOf"):
            untagged.append(d.name)
        if meta.get("mode") == "center":
            unanswered += sum(1 for r in rows if r.get("done") for c in r.get("centers") or []
                              if isinstance(c, dict) and c.get("kind") == "face" and not lc.answer_complete(c))
    out = {"damaged": damaged}
    for kind, modes in (("coco", BOX_SET_MODES), ("manifest", MANIFEST_SET_MODES)):
        mine = [s for s in sets if not s["foreign"] and not s["damaged"] and (not s["labeled"] or s["mode"] in modes)]
        out[kind] = {**counts[kind], "leftOut": sum(s["frames"] - s["done"] for s in mine)}
    unaddressed = [a["id"] for a in assets or [] if not _addressed(a["listed"])]
    out["manifest"].update(untagged=untagged, unaddressed=unaddressed, unanswered=unanswered)
    return out


def removed_facts(labels_dir, assets: list, record: dict, problem) -> dict:
    """The frames removed from this project, for its screen: {"frames": [{assetId, name, reason,
    at, replacedBy}], "file", "problem"}, oldest first. `replacedBy`: the nearby frame put in
    its place, or None. `problem`: the file is there and cannot be used (labelfiles.read_removed)."""
    videos = {a["id"] for a in assets}
    instead = {(r["assetId"], r["removed"]): r["added"]["name"] for r in record.get("replacements", [])}
    frames = [{**e, "replacedBy": instead.get((e["assetId"], e["name"]))} for e in record.get("removed", []) if e["assetId"] in videos]
    return {"frames": frames, "file": str(Path(labels_dir) / lf.REMOVED_FILE), "problem": problem}


def _addressed(asset: dict) -> bool:
    """Every frame of a video of the sample says where the video is hosted (on itself or on its
    asset): a platform and a video id, which a manifest row names."""
    frames = asset.get("frames") or []
    return bool(frames) and all((f.get("platform") or asset.get("platform")) and (f.get("videoId") or asset.get("videoId")) for f in frames)


# ---- commands ------------------------------------------------------------------------------------

def _shown(path, cwd) -> str:
    """A path as a command shows it: relative to the folder the tool was started in when it lies
    in it, else in full."""
    if is_url(path):
        return str(path)
    if cwd and _inside(path, cwd):
        rel = os.path.relpath(str(Path(path).resolve()), str(Path(cwd).resolve()))
        return rel
    return str(path)


def _parts(words: list) -> dict:
    """[(text, fill)] → {"text": the command line, "parts": [{"t", "fill"}]}; `fill` marks a part
    that stands for something the person still has to give."""
    parts = [{"t": w if fill else shlex.quote(str(w)), "fill": bool(fill)} for w, fill in words]
    return {"text": " ".join(p["t"] for p in parts), "parts": parts, "argv": [str(w) for w, _fill in words]}


def _number(value) -> str:
    return str(int(value)) if float(value) == int(value) else repr(float(value))


def pass_command(mode: str, role, sample, places: dict, model_boxes: bool, command: dict, settings=None) -> dict:
    """The command that starts one pass with flags, for scripts: the same settings the page
    would start it with. `settings`: what this run has beyond locations, each only when it is
    not the default ({"decklist": [(set or "*", file)], "zoom", "snap", "k", "seed"}); the
    command says every one of them, so a start with it behaves as the page's start does."""
    cwd = command.get("cwd")
    settings = settings or {}
    words = [(w, False) for w in command["prefix"]]
    words += [("--mode", False), (str(mode), False), ("--role", False), (role or "ROLE", role is None), ("--sample", False), (_shown(sample, cwd), False)]
    for key, flag in (("labels", "--labels-dir"), ("frames", "--frames-dir"), ("decklists", "--decklists-dir")):
        if not places[key]["usual"]:
            words += [(flag, False), (_shown(places[key]["path"], cwd), False)]
    for key, flag in (("catalog", "--catalog"), ("art", "--art")):
        if places[key]["state"] == "ok":
            words += [(flag, False), (_shown(places[key]["path"], cwd), False)]
    if places["prefill"]["state"] == "ok" and role == "training" and (mode == "training" or (mode == "box" and model_boxes)):
        words += [("--prefill", False), (_shown(places["prefill"]["path"], cwd), False)]
    for key, path in settings.get("decklist") or []:
        words += [("--decklist", False), (_shown(path, cwd) if key == "*" else f"{key}={_shown(path, cwd)}", False)]
    if "zoom" in settings:
        words += [("--zoom", False), (_number(settings["zoom"]), False)]
    if settings.get("snap") == "on":
        words += [("--snap", False), ("on", False)]
    if mode == "point":  # the two numbers of the point rule: marked for the person to set, unless this run was given them
        words += [("--k", False), (str(settings.get("k", lc.DEFAULT_K)), "k" not in settings),
                  ("--seed", False), (str(settings.get("seed", 1)), "seed" not in settings)]
    else:
        for key, flag in (("k", "--k"), ("seed", "--seed")):
            if key in settings:
                words += [(flag, False), (str(settings[key]), False)]
    if mode == "verify":  # as the page starts it: no model's proposal (models' proposals: --arm NAME=FILE)
        words += [("--all-blind", False)]
    words += [(w, False) for w in command.get("tail") or []]
    return _parts(words)


def export_out(sample, kind: str) -> Path:
    """Where the page writes an export, and where its command writes it: `boxes.json` beside the
    sample, or a manifest in a folder of its own beside it."""
    folder = Path(sample).parent
    return folder / "boxes.json" if kind == "coco" else folder / MANIFEST_FOLDER / "labels.manifest.jsonl"


def export_command(sample, places: dict, command: dict, kind: str = "coco", source_type: bool = False) -> dict:
    """The command that writes the export `kind`, for scripts. A manifest's credit is marked for
    the person to fill in, and so is its kind of footage when the labels do not say it."""
    cwd = command.get("cwd")
    prefix = list(command["prefix"])
    prefix[-1] = re.sub(r"serve\.py$", "export.py", str(prefix[-1]))
    out = export_out(sample, kind)
    words = [(w, False) for w in prefix] + [(kind, False), ("--labels-dir", False), (_shown(places["labels"]["path"], cwd), False)]
    if kind == "manifest":
        words += [("--sample", False), (_shown(sample, cwd), False), ("--credit", False), ('"YOUR NAME"', True)]
        if source_type:
            words += [("--source-type", False), ("physical/webcam", True)]
    words += [("--out", False), (_shown(out, cwd), False)]
    if places["catalog"]["state"] == "ok":
        words += [("--catalog", False), (_shown(places["catalog"]["path"], cwd), False)]
    return {**_parts(words), "out": str(out), "outExists": os.path.lexists(out)}


# ---- one project, for the page -------------------------------------------------------------------

def report(sample, *, given=None, flags=None, role=None, model_boxes=None, base=None, running=None, command=None) -> dict:
    """Everything the project screen shows about one sample, as facts.

    given    locations changed on the page ({key: text}); they win over everything
    flags    locations and `role` given on the command line ({key: Path or text; False: the
             running pass was started without that one}), and under `settings` what else this
             run was given for this project (see `pass_command`)
    role     the purpose chosen on the page, or None
    running  what the server runs now: {"sample", "labels", "mode", "role", "prefill"}, or None
    command  how the tool was started: {"prefix": [...], "tail": [...], "cwd"}
    """
    sample = Path(sample)
    command = command or DEFAULT_COMMAND
    assets, problem = read_sample(sample)
    if problem:
        return {"ok": False, "problem": problem, "path": str(sample)}
    flags = dict(flags or {})
    recent = next((e["labels"] for e in read_recent() if e["sample"] == str(sample) and e["labels"]), None)
    first = locations(sample, assets, given, flags, None, base, recent)
    remembered = read_project_file(first["labels"]["path"], sample)
    places = locations(sample, assets, given, flags, remembered.get("locations"), base, recent)
    # the frames as the project labels them: those removed left out, nearby ones used instead put in
    removed_record, removed_problem = lf.read_removed(places["labels"]["path"])
    assets = [_asset(a) for a in lf.apply_frame_changes([a["listed"] for a in assets], removed_record)]
    frames = frame_check(sample, assets, places["frames"]["path"])
    # the sets every screen lists: one for each video, then the repeat sets made from them
    sets = [set_status(entry) for entry in lf.label_sets(places["labels"]["path"], [a["listed"] for a in assets])]
    roles = role_facts(sets, role, flags.get("role"), remembered.get("role"))
    value = roles["value"]
    passes = {m: pass_facts(m, value, sets, places, frames) for m in PASS_ORDER}
    suggestions = places["prefill"]["state"] == "ok" and value == "training" and lc.prefill_allowed("box", value)
    if model_boxes is None:
        model_boxes = remembered.get("modelBoxes")
    use_model = bool(suggestions and model_boxes is not False)
    same = bool(running) and _same(running["sample"], sample) and _same(running["labels"], places["labels"]["path"])
    for m, p in passes.items():
        p["running"] = bool(same and running["mode"] == m and running["role"] == value)
        p["command"] = pass_command(m, value, sample, places, use_model, command, flags.get("settings"))
    export = export_facts(places["labels"]["path"], sets, assets)
    export["kind"] = export_kind(value)
    for kind in ("coco", "manifest"):
        export[kind].update(export_command(sample, places, command, kind, bool(export["manifest"]["untagged"])))
    return {
        "ok": True, "sample": str(sample), "folder": str(sample.parent), "name": project_name(sample),
        "recordings": len(assets), "frames": frames, "sets": sets, "locations": places,
        "projectFile": str(Path(places["labels"]["path"]) / PROJECT_FILE), "role": roles, "passes": passes,
        "modelBoxes": {"offered": bool(suggestions), "on": use_model, "file": Path(places["prefill"]["path"]).name if places["prefill"]["path"] else None},
        "export": export, "next": next_step(passes, sets, export, value), "flow": first_pass(value, sets),
        "removed": removed_facts(places["labels"]["path"], assets, removed_record, removed_problem),
        "server": {"configured": bool(running), "sameProject": same, "mode": running["mode"] if running else None,
                   "role": running["role"] if running else None},
        "restart": _parts([(w, False) for w in list(command["prefix"]) + list(command.get("tail") or [])])["text"],
    }


def open_values(rep: dict, mode: str) -> dict:
    """The settings that start `mode` on a reported project: what the flags of serve.py would
    say. Raises ValueError with the reason's code when the pass cannot be started."""
    p = rep["passes"].get(mode)
    if p is None or not p["button"]:
        raise ValueError("not-offered")
    if not p["allowed"]:
        raise ValueError(p["reason"])
    places = rep["locations"]
    use_prefill = places["prefill"]["state"] == "ok" and rep["role"]["value"] == "training" and (mode == "training" or (mode == "box" and rep["modelBoxes"]["on"]))
    return {"mode": mode, "role": rep["role"]["value"], "sample": rep["sample"],
            "labels_dir": places["labels"]["path"], "frames_dir": places["frames"]["path"],
            "decklists_dir": places["decklists"]["path"],
            "catalog": places["catalog"]["path"] if places["catalog"]["state"] == "ok" else None,
            "art": places["art"]["path"] if places["art"]["state"] == "ok" else None,
            "prefill": [places["prefill"]["path"]] if use_prefill else None}
