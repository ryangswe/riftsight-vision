# SPDX-License-Identifier: Apache-2.0
"""Local labeling server for card-game video frames.

Standard library only. Binds 127.0.0.1 and never opens a network connection itself.

    python3 serve.py                    start, then choose what to label on the page
    python3 serve.py FOLDER-OR-SAMPLE   start on one project: a sample file, or the folder that
                                        holds a sample.json

Started like that, the page shows the samples found under the folder the tool was started in and
the projects opened before, then one screen for a project: what its labels are for, its passes
in order with how far each has come, and one button for each. The page starts a pass, switches
the running tool to another pass or another project when one is finished (no new start of the
tool), and writes the export.

Every pass can also be started with flags, as scripts do. Seven modes, one per run (`--mode`);
all but identify and verify are stored in each label set's meta.json together with its role:

  box       Boxes (four corners, cornerSource box), which may be rotated; no identity needed.
            With --role training it may take --prefill: a model's boxes to accept, correct or
            reject; never in development or test sets.
  identify  a pass over an existing box/corner/training set of the same role: walks the targets
            without an identity; answers, and in box sets which edge of a box is the card's top
            (its corner order turned) and, in training and development box sets, a box moved,
            resized or rotated, its provenance recorded as a Boxes edit's. Never in test sets.
  corner    Four-corner card targets (quads) with edge snapping and derived geometry.
  training  corners plus prefill from a JSON(L) file of model proposals (role=training only).
  point     K seeded pointer positions per frame; one answer per point.
  center    a click on the center of every card face (Shift+click: every card back) per frame;
            development and test sets only, no prefill. `--mode center` is the same mode.
  verify    a pass over a center set that names every FACE center: the crop first, then the
            proposals of one or two model arms (--arm NAME=FILE), except the blind subsample
            (--blind), named with no proposals. Answers only, never a center's x/y/id/kind.
            role=development. With --all-blind there are no arms and no blind file: every
            center is named with no proposals (role=development or role=test).

    python3 serve.py --mode box --role training --sample sample.json --catalog catalog.json
    python3 serve.py --mode box --role training --sample sample.json --prefill prefill.jsonl
    python3 serve.py --mode identify --role training --sample sample.json --catalog catalog.json --art art/
    python3 serve.py --mode center --role development --sample sample.json
    python3 serve.py --mode verify --role development --sample sample.json \
        --arm new=new.jsonl --arm old=old.jsonl --blind blind.json

--sample FILE is the list of frames to label ({assets: [{assetId, frames: [{t, name}]}]};
make_sample.py writes one from folders of frames). Beside it by default: labels/ (--labels-dir),
frames/<assetId>/<name> (--frames-dir, unless an asset names its own framesDir) and decklists/
(--decklists-dir). --catalog FILE lists the game's cards and --art DIR_OR_URL_BASE says where
their images are; without --art the card previews show names only. --port (default 8090; 0 picks
a free one). README.md has the full guide and FORMAT.md the label format.

A set's fixed fields (mode, role, point rule, zoom) are written on its first save and never
change: a set whose stored mode/role differs from this run opens read-only.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shlex
import shutil
import sys
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

sys.dont_write_bytecode = True  # never leave __pycache__ anywhere this imports from

import export as ex  # noqa: E402
import labelcore as lc  # noqa: E402
import labelfiles as lf  # noqa: E402
import make_toy_data  # noqa: E402
import project as pj  # noqa: E402

TOOL_DIR = Path(__file__).resolve().parent
DEFAULT_PORT = 8090
DEFAULT_SEED = 1
TOOL_NAME = "labeler"

# Both are tested with fullmatch: with match, the `$` of a pattern also matches before a line
# break that ends the text, and an id or a frame name ending in one would pass.
ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
FRAME_NAME_RE = lc.FRAME_NAME
STATIC_FILES = {
    "/sources.js": "application/javascript; charset=utf-8",
    "/picker.js": "application/javascript; charset=utf-8",
    "/names.js": "application/javascript; charset=utf-8",
    "/quadsnap.js": "application/javascript; charset=utf-8",
    "/snap.js": "application/javascript; charset=utf-8",
    "/filters.js": "application/javascript; charset=utf-8",
    "/labeltools.js": "application/javascript; charset=utf-8",
    "/boxgeom.js": "application/javascript; charset=utf-8",
    "/boxsize.js": "application/javascript; charset=utf-8",
    "/timinglog.js": "application/javascript; charset=utf-8",
    "/centergeom.js": "application/javascript; charset=utf-8",
    "/verifycore.js": "application/javascript; charset=utf-8",
    "/uistate.js": "application/javascript; charset=utf-8",
    "/keyroute.js": "application/javascript; charset=utf-8",
    "/savegate.js": "application/javascript; charset=utf-8",
    "/theme.css": "text/css; charset=utf-8",
    "/sources.css": "text/css; charset=utf-8",
    "/hubstate.js": "application/javascript; charset=utf-8",
    "/hub.js": "application/javascript; charset=utf-8",
    "/hub.css": "text/css; charset=utf-8",
}
HTML = "text/html; charset=utf-8"
# The start screen and the project screen (hub.html) at these paths; at / too until a pass runs.
HUB_PATHS = ("/start", "/project")
GUIDE_PATH = "/guide"  # README.md, the guide the screens link to
MAX_BODY = 64 * 1024 * 1024  # a request body larger than this is not read
# The page asks this every few seconds to learn whether the server still runs. It is an ordinary
# request for /api/config; its lines are left out of the request log.
HEARTBEAT = "/api/config?ping"


class Config:
    sample = None  # the list of frames to label (required)
    labels_dir = None  # default: labels/ beside the sample
    frames_dir = None  # default: frames/ beside the sample
    catalog = None  # the game's cards; None: boxes can be drawn, no card can be named
    art = None  # a folder (Path) or a URL base (str) the catalog's `art` is resolved against
    mode = "point"
    role = "development"
    k = lc.DEFAULT_K
    seed = 1
    zoom = lc.DEFAULT_ZOOM
    snap = False  # corner edge snapping at page start (the page's `f` toggles it)
    decklists: dict = {}  # set id or "*" → [Path, ...]
    decklists_dir = None  # <video id>.txt / <video id>.<label>.txt, per video; default beside the sample
    prefills: dict = {}  # set id or "*" → Path
    verify = None  # verify mode: the arms' proposals and the blind subsample, loaded and checked at start
    byte_cap = None  # the largest file this run reads whole: None for a start with flags; a start from the page has pj.SAMPLE_BYTES
    launch = None  # the command line this run was started with (main() sets it), or the one that stands for a start from the page


CFG = Config()
LOCK = threading.RLock()  # one write of a label file at a time; a save checks its run under it too


class Gate:
    """Requests read the configuration together; a switch to another pass changes it alone. A
    switch waits until every request in progress has answered, and requests that come meanwhile
    wait until it is done: none sees a configuration half-made."""

    def __init__(self):
        self._cond = threading.Condition()
        self._readers = 0
        self._writer = False
        self._waiting = 0

    @contextlib.contextmanager
    def read(self):
        with self._cond:
            while self._writer or self._waiting:
                self._cond.wait()
            self._readers += 1
        try:
            yield
        finally:
            with self._cond:
                self._readers -= 1
                self._cond.notify_all()

    @contextlib.contextmanager
    def write(self):
        with self._cond:
            self._waiting += 1
            try:
                while self._writer or self._readers:
                    self._cond.wait()
            finally:
                self._waiting -= 1
            self._writer = True
        try:
            yield
        finally:
            with self._cond:
                self._writer = False
                self._cond.notify_all()


GATE = Gate()

# This run of the server, as a token made when it starts. The labeling page learns it from
# /api/config and sends it back with every save: a page that was loaded from another run (the
# tool was stopped and started again, maybe on another project with the same set ids) is told
# so, and nothing it sends is written.
RUN_ID = secrets.token_hex(8)
OTHER_RUN = ("The tool was started again, or switched to another pass, since this page was loaded, so this page belongs to the run before. "
             "Nothing was saved. Reload the page to work in what the tool runs now.")
SAVE_ROUTES = ("labels", "timing", "verify-reveal", "remove-frame")  # the requests that write label files, the timing log or the removed frames


class Saves:
    """The saves in progress, and what each open labeling page last said about its unsaved
    changes (/api/tabs). A switch is refused while either says that work could be lost."""
    in_flight = 0
    tabs: dict = {}  # tab id → {"run", "unsaved", "at"}
    lock = threading.Lock()


SAVES = Saves()
TAB_FRESH = 10.0  # seconds: a page that said nothing for longer is taken to be closed
TAB_MAX = 64
TAB_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class Hub:
    """What the start screen and the project screen need to know about this run."""
    start_dir = None  # the folder the tool was started in: the search for samples stays under it
    project = None  # the sample a start without --mode named (FOLDER-OR-SAMPLE, or --sample)
    flags: dict = {}  # the locations, the role and the other settings that command line gave for it
    args = None  # that command line, parsed: a pass of THAT project started from the page keeps its settings
    command = None  # how the tool was started: {"prefix": [...], "tail": [...], "cwd"}
    configuring = False  # the page is starting a pass right now


HUB = Hub()
OPEN_LOCK = threading.Lock()  # one start of a pass from the page at a time


def ready() -> bool:
    """A pass is configured: the labeling page and its routes answer."""
    return CFG.sample is not None and not HUB.configuring


def project_key():
    """The work this run does, as a short key: its sample, its labels folder, its pass and its
    purpose. Two runs with the same key write the same label files; no path is given away."""
    if CFG.sample is None:
        return None
    words = json.dumps([str(CFG.sample), str(CFG.labels_dir), CFG.mode, CFG.role])
    return hashlib.sha256(words.encode("utf-8")).hexdigest()[:16]


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def _now_ms() -> str:
    """The readability-first stamps (readabilityAt.at, revealedAt): ms, so their order is exact."""
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds")


def _safe_id(value: str):
    value = unquote(value)
    return value if value and ID_RE.fullmatch(value) else None


def _safe_frame(value: str):
    value = unquote(value)
    return value if FRAME_NAME_RE.fullmatch(value) else None


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _file_name(path) -> str:
    """How a file is recorded in a label set's meta.json: by its name, never by its full path
    (label sets are meant to be shared; the sha beside it says which file it was)."""
    return Path(path).name


# ---- catalog ------------------------------------------------------------------------------
#
# The one file that describes a game's cards:
#
#   {"cards": [{"id", "name", "kind", "printingOf", "art", "token", "extra"}, ...],   ("token", "extra": optional)
#    "kinds": {"landscape": [kind, ...]},          (optional)
#    "tokens": [{"name", "id", "kind", "art"}, ...]}   (optional)
#
# `id` and `name` are needed; the rest may be absent. Other keys are ignored, so a catalog
# written for other tools can be passed as it is. Nothing about any game is built in.

_CATALOG_CACHE: dict = {}
TOKEN_KIND_RE = re.compile(r"\btokens?\b", re.IGNORECASE)
_TOKEN_SUFFIX_RE = re.compile(r"\s*\(token\)\s*$", re.IGNORECASE)


def is_url(text) -> bool:
    return isinstance(text, str) and text.lower().startswith(("http://", "https://"))


def catalog_doc() -> dict:
    """The catalog file as parsed JSON ({} without one, or when it cannot be read). Read again
    only when the file changes, so a catalog edited while the server runs is picked up."""
    path = CFG.catalog
    if not path:
        return {}
    try:
        st = Path(path).stat()
    except OSError:
        return {}
    key = (str(path), st.st_mtime_ns, st.st_size)
    if _CATALOG_CACHE.get("key") != key:
        data, problem = lf.read_json(path, CFG.byte_cap)
        if problem:
            return {}
        _CATALOG_CACHE.update(key=key, doc=data if isinstance(data, dict) else {})
    return _CATALOG_CACHE["doc"]


def catalog_rule() -> str:
    """Which of the catalog's entries are one card: its "identity" rule (labelcore)."""
    return lc.identity_rule(catalog_doc()) or lc.IDENTITY_NAME


def catalog_id_problem(doc: dict) -> str | None:
    """The first card id of a catalog that breaks the card-id rule, as a message naming the entry
    (its place in `cards` or `tokens`), or None. A missing id is not a problem here: it is skipped."""
    for key in ("cards", "tokens"):
        entries = doc.get(key)
        for position, entry in enumerate(entries if isinstance(entries, list) else []):
            card_id = entry.get("id") if isinstance(entry, dict) else None
            if isinstance(card_id, str) and card_id and lc.card_id_error(card_id):
                return f"{key}[{position}]: {lc.card_id_error(card_id)}"
    return None


def is_token_kind(kind) -> bool:
    """A card whose `kind` marks it as a token: the word "token" in it ("Token", "Unit Token")."""
    return bool(TOKEN_KIND_RE.search(str(kind or "")))


def is_token_card(card: dict) -> bool:
    """A card of the catalog that is a token: marked `"token": true`, or of a token kind."""
    return card.get("token") is True or is_token_kind(card.get("kind"))


def token_id(name: str) -> str:
    """The id of a `tokens` entry that names none: TOK-<its name, runs of other characters as ->."""
    return "TOK-" + re.sub(r"[^A-Za-z0-9]+", "-", str(name)).strip("-")


def _bare_name(name) -> str:
    """A name without a trailing "(token)", lower-cased: "Sprite (token)" is the card "Sprite"."""
    return _TOKEN_SUFFIX_RE.sub("", str(name or "")).strip().lower()


def art_url(card_id, art):
    """Where the page loads a card's image from, or None (the preview then shows the name only).
    No --art: None, always. An `art` that is already an http(s) URL: that URL. With a URL base:
    the base plus the percent-encoded path. With a folder: this server's own /art/<id>."""
    if CFG.art is None or not isinstance(art, str) or not art.strip():
        return None
    if is_url(art):
        return art
    if is_url(CFG.art):
        return str(CFG.art).rstrip("/") + "/" + quote(art)
    return "/art/" + quote(str(card_id), safe="")


def _entry(card: dict, card_id, token: bool) -> dict:
    """One card as the page gets it. `noArt`: the catalog lists the card without art (`"art": null`),
    a card known by its id and name with no picture anywhere yet; the grid shows a placeholder."""
    return {"id": card_id, "name": card.get("name"), "kind": card.get("kind"),
            "printingOf": card.get("printingOf"), "token": token, "artUrl": art_url(card_id, card.get("art")),
            **({"noArt": True} if "art" in card and card["art"] is None else {}),
            **({"facets": card["facets"]} if isinstance(card.get("facets"), dict) else {})}


def catalog_facets() -> list:
    """The facets the catalog declares, for the card filters after Type ([] without any, or
    when they break the rules: the server refuses such a catalog at start)."""
    doc = catalog_doc()
    return [] if lc.facets_problem(doc) else doc.get("facets") or []


def load_catalog() -> list:
    """The cards the picker offers, compact: [{id, name, kind, printingOf, token, artUrl}].
    Every entry of the catalog's `cards`, then the token table's entries that are not cards
    already (see `token_table`), so every token on a table can be labeled."""
    doc = catalog_doc()
    out, ids = [], set()
    for c in doc.get("cards") or []:
        if isinstance(c, dict) and isinstance(c.get("id"), str) and not lc.card_id_error(c["id"]) and c["id"] not in ids:
            ids.add(c["id"])
            out.append(_entry(c, c["id"], is_token_card(c)))
    names = {_bare_name(c["name"]) for c in out}
    for t in _extra_tokens(doc):
        tid = t["id"] if isinstance(t.get("id"), str) and not lc.card_id_error(t["id"]) else token_id(t["name"])
        if _bare_name(t["name"]) in names or tid in ids:
            continue  # a token the cards already list is never offered twice
        ids.add(tid)
        names.add(_bare_name(t["name"]))
        out.append(_entry({**t, "kind": t.get("kind") or "Token"}, tid, True))
    return out


def _extra_tokens(doc: dict) -> list:
    """The catalog's optional `tokens` list: objects with a name (a bare string is a name)."""
    out = []
    for t in doc.get("tokens") or []:
        if isinstance(t, str):
            t = {"name": t}
        if isinstance(t, dict) and isinstance(t.get("name"), str) and t["name"].strip():
            out.append(t)
    return out


def token_table() -> list:
    """The game's tokens, read from the catalog and from nowhere else: the cards marked
    `"token": true`, the cards whose `kind` marks them as tokens, and the entries of its `tokens`
    list. [{id, name, kind, ...}]."""
    return [c for c in load_catalog() if c.get("token")]


def art_file(card_id: str):
    """The local file of a card's image (--art is a folder), or None: the catalog's `art` for
    that id, resolved inside the folder and never outside it."""
    if CFG.art is None or is_url(CFG.art):
        return None
    doc = catalog_doc()
    art = None
    for c in doc.get("cards") or []:
        if isinstance(c, dict) and c.get("id") == card_id:
            art = c.get("art")
            break
    else:
        for t in _extra_tokens(doc):
            if (t.get("id") or token_id(t["name"])) == card_id:
                art = t.get("art")
                break
    if not isinstance(art, str) or not art.strip() or is_url(art):
        return None
    path = (Path(CFG.art) / art).resolve()
    return path if _inside(path, Path(CFG.art)) else None


# ---- sets ---------------------------------------------------------------------------------

def load_sample(as_listed: bool = False) -> dict:
    """{"assets": [...]}: what this run's sample lists, by the rule every part of the tool uses
    (labelcore.sample_assets), with the frames removed from the project left out and the nearby
    frames used instead put in (labelfiles.apply_frame_changes); `as_listed`: as the sample file
    alone lists them. No assets when the file cannot be read."""
    assets, _problem = lf.read_sample(CFG.sample, CFG.byte_cap)
    assets = assets or []
    if not as_listed and CFG.labels_dir is not None:
        assets = lf.apply_frame_changes(assets, lf.read_removed(CFG.labels_dir)[0])
    return {"assets": assets}


def read_set(set_id: str) -> tuple:
    """(meta or None, frame rows) of one label set, read by the tool's one reader. A line that
    could not be read is under `rows.damage`, and `read_only_reason` then opens the set
    read-only: a save writes the whole file again, and would drop that line."""
    return lf.read_label_set(Path(CFG.labels_dir) / set_id)


def read_only_reason(meta, frames):
    damage = lf.own_damage(meta, frames)
    if damage:
        return (f"a label file of this set cannot be read in full ({lf.damage_words(damage)}): opened read-only, so nothing is "
                "written over it. Correct or remove that line, then reload")
    if lc.is_foreign_set(meta, frames):
        return "not a label set of this tool (its meta.json names no mode): opened read-only"
    if CFG.mode == "identify":
        if not meta:
            return "identify mode works on an existing box or corner set (draw boxes first: --mode box)"
        if meta.get("mode") not in lc.IDENTIFY_SET_MODES:
            return f"this set is mode={meta.get('mode')}; identify mode opens box, corner or training sets"
        if meta.get("role") != CFG.role:
            return f"this set is role={meta.get('role')}; the server runs role={CFG.role}"
        return None
    if CFG.mode == "verify":
        if not meta:
            return "verify mode names the centers of an existing center set (click the centers first: --mode center)"
        if meta.get("mode") != "center":
            return f"this set is mode={meta.get('mode')}; verify mode opens center sets"
        if meta.get("role") != CFG.role:
            return f"this set is role={meta.get('role')}; the server runs role={CFG.role}"
        return None
    if meta:
        if meta.get("mode") != CFG.mode:
            return f"this set is mode={meta.get('mode')}; the server runs mode={CFG.mode}"
        if meta.get("role") != CFG.role:
            return f"this set is role={meta.get('role')}; the server runs role={CFG.role}"
    return None


def _pick(mapping: dict, set_id: str):
    return mapping.get(set_id) or mapping.get("*")


def _frame_asset(set_id: str) -> str:
    meta, _ = read_set(set_id)
    fa = (meta or {}).get("frameAsset")
    if fa:
        return fa
    entry = next((s for s in list_sets() if s["setId"] == set_id), None)
    return entry["frameAsset"] if entry else set_id


def decklist_files(set_id: str) -> list:
    """--decklist for this set (or for every set), else the per-video folder: `<video>.txt` and
    `<video>.<label>.txt` in --decklists-dir, keyed by the set's frame asset (the video id)."""
    explicit = CFG.decklists.get(set_id) or CFG.decklists.get("*")
    if explicit:
        return [Path(p) for p in explicit]
    d = Path(CFG.decklists_dir)
    vid = _frame_asset(set_id)
    if not d.is_dir() or not ID_RE.fullmatch(vid or ""):
        return []
    return sorted(p for p in d.iterdir() if p.is_file() and (p.name == f"{vid}.txt" or (p.name.startswith(f"{vid}.") and p.suffix == ".txt")))


def decklist_for(set_id: str):
    """{lists: [{label, file, sha1, ids, unresolved, ambiguous, counts}], ids (union, list order),
    unresolved (union)}; None without a decklist. One list per file (one per player)."""
    files = decklist_files(set_id)
    catalog = load_catalog() if files else []
    lists = []
    for n, path in enumerate(files):
        text, problem = lf.read_text(path, CFG.byte_cap)
        if problem:
            continue  # not a file that can be read as a deck list (a pipe, a device, too large for a start from the page)
        stem = Path(path).name[:-4]
        vid_label = stem.split(".", 1)[1] if "." in stem else ""
        default = vid_label or (f"Decklist {n + 1}" if len(files) > 1 else "Decklist")
        res = lc.parse_decklist(text, catalog)
        lists.append({"label": lc.decklist_label(text, default), "file": _file_name(path),
                      "sha1": hashlib.sha1(text.encode()).hexdigest(), **res})
    if not lists:
        return None
    ids, unresolved = [], []
    for li in lists:
        ids += [i for i in li["ids"] if i not in ids]
        unresolved += li["unresolved"]
    out = {"lists": lists, "ids": ids, "unresolved": unresolved}
    if len(lists) == 1:  # a single list also keeps the flat one-file shape
        out.update(file=lists[0]["file"], sha1=lists[0]["sha1"])
    return out


def frames_dir_for(asset_id: str) -> Path:
    """An asset of the sample may name its own `framesDir` (absolute, or relative to the sample
    file): its frames are served from where they are. Else <--frames-dir>/<asset id>."""
    for a in load_sample().get("assets", []):
        if a.get("assetId") == asset_id and a.get("framesDir"):
            p = Path(a["framesDir"]).expanduser()
            return p if p.is_absolute() else (Path(CFG.sample).parent / p).resolve()
    return Path(CFG.frames_dir) / asset_id


def fixed_meta(set_id: str, frame_asset: str) -> dict:
    meta = {"schemaVersion": lc.SCHEMA_VERSION, "tool": TOOL_NAME, "setId": set_id,
            "frameAsset": frame_asset, "mode": CFG.mode, "role": CFG.role, "zoom": CFG.zoom,
            "blind": True, "createdAt": _now()}
    if CFG.mode == "point":
        meta["pointRule"] = lc.point_rule(CFG.seed, CFG.k)
    return meta


def list_sets() -> list:
    """Every sample asset is a set of the same id; label dirs whose meta names a `frameAsset`
    from the sample (consistency-repeat sets) are sets too, restricted to their own frames."""
    unused = lc.source_unused(lf.read_json(CFG.sample, CFG.byte_cap)[0])
    return [_set_entry(e["setId"], e["frameAsset"], e["asset"], e["meta"], e["rows"], unused.get(e["frameAsset"]))
            for e in lf.label_sets(CFG.labels_dir, load_sample()["assets"])]


def _set_entry(set_id, frame_asset, asset, meta, frames, unused=None) -> dict:
    # `labeled` counts this sample's frames only: two samples may share one labels root (the
    # same sets, different frames), and a frame done under the other sample must not make this
    # one's set look done
    names = {f.get("name") for f in asset.get("frames", [])}
    # where the frames come from (About this recording): the platform and video id, of the asset
    # or of a frame, and the sample's title, upload date and language (labelcore.SOURCE_FIELDS);
    # `unused`: those the sample gave in a form not taken (labelcore.source_unused)
    where = ("platform", "videoId")
    out = {"setId": set_id, "frameAsset": frame_asset, "channel": asset.get("channel"),
           "source": {**{k: asset[k] for k in where + lc.SOURCE_FIELDS if isinstance(asset.get(k), str)}, **({"unused": unused} if unused else {})},
           "frames": [{"t": f.get("t"), "name": f.get("name"), **{k: f[k] for k in where if isinstance(f.get(k), str)}}
                      for f in asset.get("frames", [])],
           "mode": (meta or {}).get("mode"), "role": (meta or {}).get("role"),
           "labeled": sum(1 for fr in frames if fr.get("done") and fr.get("name") in names),
           "removed": len(asset.get("removedFrames") or []),
           "readOnly": read_only_reason(meta, frames)}
    if CFG.mode == "verify" and CFG.verify:
        out["verify"] = verify_counts(frame_asset, asset, frames)
    return out


def set_payload(set_id: str) -> dict:
    meta, frames = read_set(set_id)
    entry = next((s for s in list_sets() if s["setId"] == set_id), None)
    ro = read_only_reason(meta, frames)
    effective = meta or fixed_meta(set_id, entry["frameAsset"] if entry else set_id)
    deck = None if ro else decklist_for(set_id)
    return {"setId": set_id, "meta": meta, "effectiveMeta": effective, "frames": frames,
            "readOnly": ro, "decklist": deck,
            "server": {"mode": CFG.mode, "role": CFG.role},
            "identifyQueue": ([e for e in lc.identify_queue(frames) if e.get("frame") in {f["name"] for f in entry["frames"]}] if entry else [])
            if CFG.mode == "identify" and not ro else None,
            "verify": verify_payload(entry, frames) if CFG.mode == "verify" and CFG.verify and entry and not ro else None}


def landscape_ids() -> frozenset:
    """The ids of the cards whose upright orientation is landscape: those whose `kind` is listed
    in the catalog's `kinds.landscape`."""
    kinds = catalog_doc().get("kinds")
    landscape = {k for k in (kinds.get("landscape") or [] if isinstance(kinds, dict) else []) if isinstance(k, str)}
    return frozenset(c["id"] for c in load_catalog() if c.get("kind") in landscape)


def _source_h(meta) -> int | None:
    return lc.parse_resolution_height(((meta or {}).get("recording") or {}).get("sourceResolution"))


def _atomic_write(path: Path, text: str) -> None:
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


def _write_set(set_id: str, meta: dict, frames: list) -> None:
    d = Path(CFG.labels_dir) / set_id
    frames = sorted(frames, key=lambda fr: (fr.get("t") or 0, fr.get("name") or ""))
    _atomic_write(d / "frames.jsonl", "".join(json.dumps(fr, sort_keys=True) + "\n" for fr in frames))
    _atomic_write(d / "meta.json", json.dumps(meta, indent=2, sort_keys=True) + "\n")


def _base_meta(set_id: str, meta):
    if meta:
        return dict(meta)
    entry = next((s for s in list_sets() if s["setId"] == set_id), None)
    if entry is None:
        raise LookupError("unknown set")
    return fixed_meta(set_id, entry["frameAsset"])


def save_frame(set_id: str, frame: dict) -> tuple:
    """Upsert one frame row. Returns (status, payload)."""
    with LOCK:
        meta, frames = read_set(set_id)
        ro = read_only_reason(meta, frames)
        if ro:
            return 409, {"error": ro}
        try:
            meta = _base_meta(set_id, meta)
        except LookupError:
            return 404, {"error": "unknown set"}
        set_mode = meta.get("mode") or CFG.mode
        if CFG.mode == "verify":
            return _save_verify(set_id, meta, frames, frame)
        if CFG.mode == "identify":
            old = next((fr for fr in frames if fr.get("name") == frame.get("name")), None)
            if old is None:
                return 409, {"error": "the identity pass only answers frames that already have targets"}
            changes = lc.geometry_changes(old, frame, set_mode, meta.get("role"))
            if changes:
                return 409, {"error": "; ".join(changes)}
            lc.mark_orientation(old, frame, set_mode)  # orientationFixedIn on a box whose top edge turned
        errors = lc.validate_frame(frame, set_mode, meta.get("role"))
        if CFG.mode != "identify" and not errors:  # a pass that draws on the frame: the row records the frame's size
            errors = lc.frame_size_errors(frame)
        if set_mode == "center" and not errors:  # center ids are never reused within a frame
            errors = lc.center_seq_errors(next((fr for fr in frames if fr.get("name") == frame.get("name")), None), frame)
        if errors:
            return 400, {"error": "; ".join(errors)}
        row = lc.normalize_frame(frame, set_mode, _source_h(meta), landscape_ids())
        if CFG.mode == "identify":
            row["done"] = bool(old.get("done"))  # frame confirmation belongs to the geometry pass
            meta["identifiedAt"] = _now()
        frames = [fr for fr in frames if fr.get("name") != row["name"]] + [row]
        if lc.prefill_allowed(set_mode, meta.get("role")) and (row.get("prefillOffered") or any("prefill" in t for t in row.get("targets", []))):
            meta["prefillUsed"] = True
            meta["blind"] = False
            src = _pick(CFG.prefills, set_id)
            if src:
                meta.setdefault("prefillSource", _file_name(src))
        deck = decklist_for(set_id)
        if deck:
            meta["decklist"] = deck
        meta["labeledAt"] = _now()
        _write_set(set_id, meta, frames)
        return 200, {"ok": True, "frame": row, "meta": meta}


def save_meta(set_id: str, body: dict) -> tuple:
    """Editable per-recording fields only: recording tags, annotator, notes."""
    with LOCK:
        meta, frames = read_set(set_id)
        ro = read_only_reason(meta, frames)
        if ro:
            return 409, {"error": ro}
        try:
            meta = _base_meta(set_id, meta)
        except LookupError:
            return 404, {"error": "unknown set"}
        if "recording" in body:
            rec = {k: v for k, v in (body.get("recording") or {}).items() if v not in (None, "")}
            errors = lc.validate_recording(rec)
            if errors:
                return 400, {"error": "; ".join(errors)}
            meta["recording"] = rec
        for key in ("annotator", "notes"):
            if key in body:
                meta[key] = str(body[key] or "")
        set_mode = meta.get("mode") or CFG.mode
        if set_mode != "point":  # the native resolution feeds shortSideSourcePx
            land = landscape_ids()
            frames = [lc.normalize_frame(fr, set_mode, _source_h(meta), land) for fr in frames]
        _write_set(set_id, meta, frames)
        return 200, {"ok": True, "meta": meta}


def append_timing(set_id: str, events: list) -> tuple:
    with LOCK:
        meta, frames = read_set(set_id)
        ro = read_only_reason(meta, frames)
        if ro:
            return 409, {"error": ro}
        if not isinstance(events, list):
            return 400, {"error": "events must be a list"}
        if meta is None and not any(s["setId"] == set_id for s in list_sets()):
            return 404, {"error": "unknown set"}  # never a new folder in the labels root for an id nobody labels
        d = Path(CFG.labels_dir) / set_id
        d.mkdir(parents=True, exist_ok=True)
        stamp = _now()
        with (d / "timing.jsonl").open("a", encoding="utf-8") as f:
            for ev in events:
                if isinstance(ev, dict) and isinstance(ev.get("ev"), str):
                    f.write(json.dumps({**ev, "serverAt": stamp}, sort_keys=True) + "\n")
        return 200, {"ok": True}


def prefill_on() -> bool:
    """This run offers prefill: training mode, or box mode with role=training, with a file."""
    return lc.prefill_allowed(CFG.mode, CFG.role) and CFG.role == "training" and bool(CFG.prefills)


def read_prefill_rows(path) -> list:
    """The records of a prefill file, one per frame: JSON lines (what `cardvision infer
    --prefill-out` writes), or JSON `{"frames": [...]}`, a list, or `{"<frame name>": {...}}`.
    Raises ValueError when the file is not JSON, or is not a file that may be read whole."""
    text, problem = lf.read_text(path, CFG.byte_cap)
    if problem:
        raise ValueError(f"{Path(path).name}: {lf.PROBLEM_WORDS[problem]}")
    try:
        if str(path).endswith(".jsonl"):
            return [json.loads(line) for line in text.splitlines() if line.strip()]
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{Path(path).name}: not JSON ({exc})") from None
    rows = data.get("frames", data) if isinstance(data, dict) else data
    if isinstance(rows, dict):  # {"<frame name>": {...}}
        rows = [{"name": k, **v} for k, v in rows.items() if isinstance(v, dict)]
    return rows if isinstance(rows, list) else []


def _row_set(row: dict):
    """The set a prefill record names (`set` or `assetId`), or None: it applies to any set."""
    rset = row.get("set") or row.get("assetId")
    return None if rset is None else str(rset)


def read_prefill(set_id: str) -> tuple:
    """Proposals per frame name for one set. A record may name its set (`set`: the asset id, so
    one file can serve every video); a record naming another set is skipped, a record without one
    applies to any set. Records: `{name, frameW, frameH, boxes: [{box: [x, y, w, h], cardId, sim,
    margin, top5, rot, flag}]}` (the inference command's output); a box may also carry `outcome`
    (card | card-back) and `score`, or `corners` / `quad` instead of `box`.
    Coordinates are in the record's own `frameW` x `frameH` pixel space; `sizes` passes that
    space on so the page can scale each proposal to the frame it shows. A record without a size
    is taken to be in the frame's own pixels."""
    if not lc.prefill_allowed(CFG.mode, CFG.role) or CFG.role != "training":
        return 404, {"error": "no prefill outside training mode / box mode on role=training"}
    meta, frames = read_set(set_id)
    if meta and meta.get("role") != "training":
        return 403, {"error": "prefill is only for role=training sets"}
    path = _pick(CFG.prefills, set_id)
    if not path:
        return 404, {"error": "no prefill file for this set"}
    try:
        rows = read_prefill_rows(path)
    except ValueError as exc:
        return 500, {"error": f"prefill unreadable: {exc}"}
    asset = _frame_asset(set_id)
    out, sizes = {}, {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        name = r.get("name")
        rset = _row_set(r)
        if rset is not None and rset not in (set_id, asset):
            continue  # another video's frame (frame names repeat across videos)
        props = []
        for b in r.get("boxes") or r.get("targets") or []:
            if not isinstance(b, dict):
                continue
            if b.get("corners") or b.get("quad"):
                corners = [[float(x), float(y)] for x, y in (b.get("corners") or b.get("quad"))]
            elif b.get("box"):
                corners = lc.box_to_corners(b["box"], b.get("rot") or 0)
            else:
                continue
            outcome = b.get("outcome")
            props.append({"corners": corners, "box": [float(v) for v in b["box"]] if b.get("box") else None,
                          "rot": b.get("rot") or 0, "outcome": outcome if outcome in ("card", "card-back") else None,
                          "score": b.get("score"), "cardId": b.get("cardId"), "sim": b.get("sim"),
                          "margin": b.get("margin"), "flag": b.get("flag"),
                          "top5": [c.get("id") if isinstance(c, dict) else c for c in (b.get("top5") or [])]})
        if name:
            out[name] = props
            w, h = lc.prefill_frame_size(r)
            if w and h:
                sizes[name] = [w, h]
    return 200, {"file": _file_name(path), "frames": out, "sizes": sizes}


# ---- removing a frame from the project --------------------------------------------------------

REMOVED_PROBLEM = ("The list of removed frames ({file}) cannot be used ({why}), so no frame can be removed or restored. "
                   "Correct the file or delete it (deleting it brings every removed frame back), then reload.")


def _removed_problem_text(labels_dir, problem) -> str:
    why = {"not-json": "it is not JSON", "not-record": "it holds an entry this tool would not write"}.get(problem) or lf.PROBLEM_WORDS.get(problem, problem)
    return REMOVED_PROBLEM.format(file=str(Path(labels_dir) / lf.REMOVED_FILE), why=why)


def _suggestions_file(set_id: str):
    """The suggestions file of a set, for the times and boxes of nearby frames: the one this run
    was given, else the one the project screen looks for beside the sample; None when there is none."""
    given = _pick(CFG.prefills, set_id)
    if given:
        return Path(given)
    beside = Path(CFG.sample).parent
    return next((beside / n for n in pj.PREFILL_NAMES if (beside / n).is_file()), None)


def _suggestion_facts(set_id: str) -> tuple:
    """({frame name: t}, {frame names with the model's boxes}) from the suggestions file, read
    once. The times are used whatever the role (the file is where the video's frames were cut);
    the boxes count only when this run offers them."""
    path = _suggestions_file(set_id)
    if path is None:
        return {}, set()
    try:
        rows = read_prefill_rows(path)
    except ValueError:
        return {}, set()
    video = _frame_asset(set_id)
    times, boxed = {}, set()
    for r in rows:
        if not isinstance(r, dict) or not isinstance(r.get("name"), str):
            continue
        rset = _row_set(r)
        if rset is not None and rset not in (set_id, video):
            continue  # another video's frame (frame names repeat across videos)
        if lf.is_time(r.get("t")):
            times[r["name"]] = float(r["t"])
        if any(isinstance(b, dict) for b in r.get("boxes") or r.get("targets") or []):
            boxed.add(r["name"])
    return times, boxed if prefill_on() else set()


def _measuring(set_id: str) -> bool:
    """The set's labels are for measuring a model (development or test): no frame is picked by
    hand in place of another there, since a hand-picked frame is a selection."""
    meta, _rows = read_set(set_id)
    return ((meta or {}).get("role") or CFG.role) in MEASURING_ROLES


MEASURING_ROLES = ("development", "test")
REVEALED = "This frame's answers have been shown; removing it now would bias the measurement."
NOT_IN_VERIFY = "Frames are not removed in Check names: that would change which answers are measured."
MEASURING_NEARBY = "In a measuring set, add frames by drawing a new sample, not by picking one."


def nearby_payload(set_id: str, name: str) -> tuple:
    """The frames that could be used instead of frame `name` of a set: those of its video's
    folder that the sample does not list (README, "Removing a frame"). A repeat set offers none:
    its frames are another set's."""
    asset = next((a for a in load_sample(as_listed=True)["assets"] if a["assetId"] == set_id), None)
    if asset is None:
        return 200, {"frames": [], "folder": None}
    if _measuring(set_id):
        return 200, {"frames": [], "folder": None, "measuring": MEASURING_NEARBY}
    record, problem = lf.read_removed(CFG.labels_dir)
    if problem:
        return 409, {"error": _removed_problem_text(CFG.labels_dir, problem)}
    folder = frames_dir_for(set_id)
    found = lf.nearby_frames(folder, asset["frames"], record, set_id, name)
    times, boxed = _suggestion_facts(set_id)
    for f in found:
        if f["name"] in times:
            f["t"] = times[f["name"]]
        f["modelBoxes"] = f["name"] in boxed
    return 200, {"frames": found, "folder": str(folder), "suggestions": prefill_on()}


def remove_frame(set_id: str, body: dict) -> tuple:
    """Remove one frame from the project: it is recorded in removed-frames.json in the labels
    folder, and nothing else is written. Its labels stay where they are. With `replaceWith`, a
    nearby frame of the same video's folder is put in its place. The page sends this only once
    everything on it is saved (`unsaved`: 0)."""
    name = body.get("frame")
    reason = body.get("reason")
    unsaved = body.get("unsaved")
    if not isinstance(name, str) or not lc.FRAME_NAME.fullmatch(name):
        return 400, {"error": "invalid frame"}
    if reason is not None and reason not in lf.REMOVE_REASONS:
        return 400, {"error": f"the reason is one of {', '.join(lf.REMOVE_REASONS)}, or none"}
    if isinstance(unsaved, bool) or not isinstance(unsaved, int) or unsaved != 0:
        return 409, {"error": "This page has changes that are not saved yet. Wait until the top bar says Saved, then remove the frame.", "problem": "unsaved"}
    with LOCK:
        meta, frames = read_set(set_id)
        ro = read_only_reason(meta, frames)
        if ro:
            return 409, {"error": ro}
        entry = next((s for s in list_sets() if s["setId"] == set_id), None)
        if entry is None:
            return 404, {"error": "unknown set"}
        if name not in {f["name"] for f in entry["frames"]}:
            return 409, {"error": f"{name} is not a frame of this set (it may have been removed already). Reload the page."}
        if entry["frameAsset"] != set_id:
            return 409, {"error": f"This is a repeat set: its frames are those of {entry['frameAsset']}. Remove the frame from that video's own set instead.", "problem": "repeat-set"}
        if CFG.mode == "verify":
            return 409, {"error": NOT_IN_VERIFY, "problem": "verify"}
        row = next((fr for fr in frames if fr.get("name") == name), None) or {}
        if any(isinstance(c, dict) and c.get("revealedAt") for c in row.get("centers") or []):
            return 409, {"error": REVEALED, "problem": "revealed"}
        if body.get("replaceWith") is not None and _measuring(set_id):
            return 409, {"error": MEASURING_NEARBY, "problem": "measuring"}
        record, problem = lf.read_removed(CFG.labels_dir)
        if problem:
            return 409, {"error": _removed_problem_text(CFG.labels_dir, problem)}
        video = entry["frameAsset"]
        added = None
        if body.get("replaceWith") is not None:
            status, near = nearby_payload(set_id, name)
            pick = next((f for f in near.get("frames", []) if f["name"] == body.get("replaceWith")), None) if status == 200 else None
            if pick is None:
                return 409, {"error": f"{body.get('replaceWith')!s} cannot be used instead of {name}: it is not one of the nearby frames offered. Reload the page."}
            added = {"name": pick["name"], **({"t": pick["t"]} if pick["t"] is not None else {})}
        at = _now()
        record["removed"] = [e for e in record["removed"] if (e["assetId"], e["name"]) != (video, name)]
        record["removed"].append({"assetId": video, "name": name, "reason": reason, "at": at})
        if added:
            record["replacements"].append({"assetId": video, "removed": name, "added": added, "at": at})
        lf.write_removed(CFG.labels_dir, record)
        return 200, {"ok": True, "removed": name, "added": added}


def restore_frame(labels_dir, video: str, name: str) -> tuple:
    """Take a frame off the list of removed frames: it is labeled again, with its labels as they
    were. A nearby frame put in its place stays (it is a frame of the project like any other)."""
    with LOCK:
        record, problem = lf.read_removed(labels_dir)
        if problem:
            return 409, {"ok": False, "problem": "removed-file", "error": _removed_problem_text(labels_dir, problem)}
        kept = [e for e in record["removed"] if (e["assetId"], e["name"]) != (video, name)]
        if len(kept) == len(record["removed"]):
            return 409, {"ok": False, "problem": "not-removed", "error": f"{video}/{name} is not a removed frame (it may have been restored already)."}
        record["removed"] = kept
        lf.write_removed(labels_dir, record)
        return 200, {"ok": True, "restored": name}


# ---- verify mode (naming a center census) ---------------------------------------------------

def _sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _labels_root_frames(root: Path) -> dict:
    """{set id: [frame rows]} of every set in the labels root."""
    out = {}
    if Path(root).is_dir():
        for d in sorted(Path(root).iterdir()):
            if d.is_dir() and ID_RE.fullmatch(d.name) and (d / "frames.jsonl").exists():
                _meta, rows = lf.read_label_set(d)
                if rows.damage:
                    raise SystemExit(f"a label file cannot be read in full ({lf.damage_words(rows.damage)}): correct or remove that line first")
                out[d.name] = list(rows)
    return out


def _arm_records(arm: str, path: Path, problems: list) -> dict:
    """One arm's prefill file as {(set or None, frame name): record}; malformed or repeated
    records are added to `problems` (nothing is guessed)."""
    try:
        rows = read_prefill_rows(path)
    except ValueError as exc:
        problems.append({"arm": arm, "problem": str(exc)})
        return {}
    out = {}
    for n, r in enumerate(rows):
        errors = lc.prefill_row_errors(r, f"record {n + 1}")
        if errors:
            problems += [{"arm": arm, "problem": e} for e in errors]
            continue
        key = (_row_set(r), r["name"])
        if key in out:
            problems.append({"arm": arm, "problem": f"record {n + 1}: a second record for {'/'.join(k for k in key if k)}"})
            continue
        out[key] = r
    return out


def load_verify(arms: dict, blind_path=None, problems_report=None) -> dict:
    """Read and check a verify run's inputs against the labels root and this run's sample: the
    arms' files (`arms`: {name: prefill file}, in command-line order) and the blind subsample.
    Refused at start (SystemExit, every problem listed and, with --problems-report, written
    there): a malformed or repeated record; a frame of this run that has a FACE center and no
    record in an arm's file (an arm that found nothing on a frame still has a record, with no
    boxes); a box naming a card the catalog lacks; an ambiguous or unknown blind entry.
    Nothing is fixed.

    Each FACE center then gets each arm's proposal: the arm's box that the click falls in
    (`labelcore.arm_proposal`), scaled from the record's own frame size to the label row's."""
    files = {arm: Path(pth) for arm, pth in arms.items()}
    for arm, pth in files.items():
        if not pth.is_file():
            raise SystemExit(f"verify mode: --arm {arm}: file not found: {pth}")
    if blind_path is not None and not Path(blind_path).is_file():
        raise SystemExit(f"verify mode: --blind file not found: {blind_path}")
    problems = []
    records = {arm: _arm_records(arm, pth, problems) for arm, pth in files.items()}
    labels = _labels_root_frames(CFG.labels_dir)
    names = {c["id"]: c.get("name") for c in load_catalog() if c.get("id")}
    for arm, recs in records.items():
        unknown = sorted({str(b.get("cardId")) for r in recs.values() for b in r.get("boxes") or []
                          if b.get("cardId") and b.get("cardId") not in names})
        if unknown:
            problems.append({"arm": arm, "problem": f"{len(unknown)} card id(s) are not in the catalog", "ids": unknown[:10]})
    file_shas = {arm: _sha256(pth) for arm, pth in files.items()}
    run = lc.arms_run_sha(file_shas)
    by_key = {}
    for a in load_sample().get("assets", []):
        video = a.get("assetId")
        rows = {fr.get("name"): fr for fr in labels.get(video) or []}
        for f in a.get("frames", []):
            fr = rows.get(f.get("name"))
            faces = [c for c in (fr or {}).get("centers") or [] if isinstance(c, dict) and c.get("kind") == "face"]
            if not faces:
                continue
            found = {arm: recs.get((video, fr["name"])) or recs.get((None, fr["name"])) for arm, recs in records.items()}
            missing = [arm for arm, r in found.items() if r is None]
            for arm in missing:
                problems.append({"arm": arm, "video": video, "frame": fr["name"],
                                 "problem": "no record for a frame with face centers (a frame with no boxes is a record with none)"})
            if missing or problems:
                continue
            for c in faces:
                by_key[(video, fr["name"], c.get("id"))] = {
                    "armsManifestSha256": run,
                    "arms": {arm: lc.arm_proposal(found[arm], c.get("x"), c.get("y"), fr.get("frameW"), fr.get("frameH"), names)
                             for arm in files}}
    events = [(v, fr.get("name"), c.get("id")) for v, frs in labels.items() for fr in frs
              for c in fr.get("centers") or [] if isinstance(c, dict)]
    blind = set()
    if blind_path is not None:
        try:
            blind_data = json.loads(Path(blind_path).read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            blind_data, problems = None, problems + [{"problem": f"blind file is not JSON: {exc}"}]
        blind, berr = lc.parse_blind(blind_data, events) if blind_data is not None else (set(), [])
        problems += [{"problem": e} for e in berr]
    if problems:
        if problems_report:
            Path(problems_report).write_text(json.dumps({"arms": {arm: _file_name(pth) for arm, pth in files.items()},
                                                         "blind": _file_name(blind_path) if blind_path else None,
                                                         "problems": problems}, indent=1) + "\n", encoding="utf-8")
        lines = "\n".join("  " + json.dumps(p, sort_keys=True) for p in problems)
        raise SystemExit(f"verify mode refuses to start: {len(problems)} problem(s) with the arms' files / the blind file "
                         f"against {CFG.labels_dir} (nothing was changed; fix the files at their source):\n{lines}")
    return {"proposals": by_key, "blind": blind, "arms": list(files),
            "armFiles": {arm: {"file": _file_name(pth), "sha256": file_shas[arm]} for arm, pth in files.items()},
            "blindPath": _file_name(blind_path) if blind_path else None,
            "blindSha256": _sha256(blind_path) if blind_path else None,
            "armsManifestSha256": [run], "defaultSha": run, "rows": len(by_key), "blindEvents": len(blind)}


ALL_BLIND_SHA = "all-blind"  # verifiedAt.armsManifestSha256 of an --all-blind run: no run of any arm exists


def load_all_blind() -> dict:
    """--all-blind: the verify config with no arms and every center event of the labels root
    blind. Refuses to start when this run's sample has no face center."""
    labels = _labels_root_frames(CFG.labels_dir)
    events = {(v, fr.get("name"), c.get("id")) for v, frs in labels.items() for fr in frs
              for c in fr.get("centers") or [] if isinstance(c, dict)}
    walk = {a.get("assetId"): {f.get("name") for f in a.get("frames", [])} for a in load_sample().get("assets", []) if a.get("assetId")}
    faces = sum(1 for v, frs in labels.items() for fr in frs if fr.get("name") in walk.get(v, set())
                for c in fr.get("centers") or [] if isinstance(c, dict) and c.get("kind") == "face")
    if not faces:
        raise SystemExit(f"--all-blind: no face center of this run's sample in {CFG.labels_dir} (click the centers first: --mode center)")
    return {"proposals": {}, "blind": events, "allBlind": True, "arms": [], "armFiles": {},
            "blindPath": None, "blindSha256": None,
            "armsManifestSha256": [ALL_BLIND_SHA], "defaultSha": ALL_BLIND_SHA, "rows": 0, "blindEvents": len(events)}


def verify_sha(video: str, name: str, cid: str):
    """The run of the arms a center's answer is recorded against."""
    r = CFG.verify["proposals"].get((video, name, cid))
    return r["armsManifestSha256"] if r else CFG.verify["defaultSha"]


def _sample_frames(asset: dict, frames: list) -> list:
    """This run's frames of a set (the sample's, in time order) as stored rows (those with centers)."""
    by_name = {fr.get("name"): fr for fr in frames}
    order = sorted(asset.get("frames", []), key=lambda f: (f.get("t") or 0, f.get("name") or ""))
    return [by_name[f.get("name")] for f in order if f.get("name") in by_name]


def verify_counts(video: str, asset: dict, frames: list) -> dict:
    """Over the FACE centers of this run's frames: verified (complete and not stale), stale, blind."""
    v = {"total": 0, "verified": 0, "stale": 0, "blind": 0, "blindVerified": 0}
    for fr in _sample_frames(asset, frames):
        for c in fr.get("centers") or []:
            if not isinstance(c, dict) or c.get("kind") != "face":
                continue
            sha = verify_sha(video, fr.get("name"), c.get("id"))
            blind = (video, fr.get("name"), c.get("id")) in CFG.verify["blind"]
            ok = lc.center_verified(c, sha)
            v["total"] += 1
            v["verified"] += ok
            v["stale"] += lc.answer_stale(c, sha)
            v["blind"] += blind
            v["blindVerified"] += blind and ok
    v["open"] = v["total"] - v["verified"]
    return v


def _arm_view(p: dict, by_name: dict) -> dict:
    """What the page shows of one arm: its name (or nothing), the card id for the art (its
    printingId, else the catalog's first printing of that name), its box and scores."""
    art = None
    if p.get("name"):
        art = p.get("printingId") or (by_name.get(lc.normalize_name(p.get("name"))) or [None])[0]
    return {"name": p.get("name"), "printingId": p.get("printingId"), "artId": art, "box": p.get("box"),
            "boxScore": p.get("boxScore"), "similarity": p.get("similarity"), "margin": p.get("margin"),
            "look": p.get("look")}


def verify_payload(entry: dict, frames: list) -> dict:
    """Per center of this run's frames: blind (from the subsample), the run it is answered against,
    `proposals` (a face center outside the blind subsample), and the arms' proposals ONLY once
    they were revealed (readability first: the reveal is a POST that needs the readability
    stored). A blind center's proposals never leave the server. The page draws each arm's crop
    itself, from the frame and the arm's box, so nothing of an arm reaches it before the reveal."""
    video = entry["frameAsset"]
    asset = {"frames": entry["frames"]}
    by_name = lc.catalog_name_index(load_catalog())
    centers = {}
    for fr in _sample_frames(asset, frames):
        for c in fr.get("centers") or []:
            if not isinstance(c, dict):
                continue
            key = (video, fr.get("name"), c.get("id"))
            blind = key in CFG.verify["blind"]
            info = {"blind": blind, "sha": verify_sha(*key)}
            r = CFG.verify["proposals"].get(key)
            info["proposals"] = r is not None and not blind
            if info["proposals"] and _revealed(c):
                info["arms"] = {arm: _arm_view(r["arms"][arm], by_name) for arm in CFG.verify["arms"]}
            centers[f"{fr.get('name')}#{c.get('id')}"] = info
    return {"centers": centers, "counts": verify_counts(video, asset, frames), "arms": CFG.verify["arms"]}


def _revealed(c: dict) -> bool:
    """This center's proposals were released, for its current position (readability first)."""
    return isinstance(c, dict) and bool(c.get("revealedAt")) and lc.readability_ready(c)


def verify_reveal(set_id: str, frame_name: str, cid: str) -> tuple:
    """Release one center's proposals (readability first): only outside the blind
    subsample, only once the center's readability is stored for its current position. Stamps
    `revealedAt` on the first release (kept after that) and returns the arms."""
    if CFG.mode != "verify" or not CFG.verify:
        return 404, {"error": "no verify run"}
    with LOCK:
        meta, frames = read_set(set_id)
        if read_only_reason(meta, frames):
            return 409, {"error": f"read-only: {read_only_reason(meta, frames)}"}
        video = meta.get("frameAsset") or _frame_asset(set_id)
        row = next((fr for fr in frames if fr.get("name") == frame_name), None)
        c = next((x for x in (row or {}).get("centers") or [] if isinstance(x, dict) and x.get("id") == cid), None)
        if c is None:
            return 404, {"error": "no such center"}
        key = (video, frame_name, cid)
        if key in CFG.verify["blind"]:
            return 403, {"error": "a blind center: no proposals are shown"}
        r = CFG.verify["proposals"].get(key)
        if r is None:
            return 404, {"error": "no proposals for this center"}
        if not lc.readability_ready(c):
            return 409, {"error": "readable from the crop (y / m / n) comes first; the proposals only after it"}
        if not c.get("revealedAt"):
            c["revealedAt"] = _now_ms()
            _write_set(set_id, meta, frames)
        by_name = lc.catalog_name_index(load_catalog())
        return 200, {"ok": True, "revealedAt": c["revealedAt"], "readabilityAt": c.get("readabilityAt"),
                     "arms": {arm: _arm_view(r["arms"][arm], by_name) for arm in CFG.verify["arms"]}}


def _save_verify(set_id: str, meta: dict, frames: list, frame: dict) -> tuple:
    """A verify save (under LOCK): answers only. The stored row is the base; a save that would
    change any center's x/y/id/kind, add or remove one, or change centerSeq / frameW / frameH is
    refused; each answer it changes must match the blind subsample, the center's position and run,
    and what the arms showed. `done` (the click pass's confirmation) is never touched."""
    old = next((fr for fr in frames if fr.get("name") == frame.get("name")), None)
    if old is None:
        return 409, {"error": "the verify pass only answers frames that have centers"}
    changes = lc.verify_geometry_changes(old, frame)
    if changes:
        return 409, {"error": "; ".join(changes)}
    stamp_errors = []
    row = lc.verify_merge(old, frame, _now_ms(), stamp_errors)
    if stamp_errors:
        return 409, {"error": "; ".join(stamp_errors)}
    errors = lc.validate_frame(row, "center", meta.get("role"))
    video = meta.get("frameAsset") or _frame_asset(set_id)
    if not errors:
        catalog = load_catalog()
        names = {c["id"]: c.get("name") for c in catalog if c.get("id")}
        rule, roots = catalog_rule(), lc.printing_roots(catalog)  # which answers are the same card
        olds = {c.get("id"): c for c in old.get("centers") or []}
        for c in row["centers"]:
            if lc.center_answer(c) == lc.center_answer(olds.get(c.get("id")) or {}):
                continue  # untouched (a stale answer stays as it was until it is answered again)
            key = (video, row.get("name"), c.get("id"))
            errors += lc.verify_answer_errors(c, CFG.verify["proposals"].get(key), key in CFG.verify["blind"],
                                              verify_sha(*key), names, CFG.verify["arms"], rule, roots)
    if errors:
        return 400, {"error": "; ".join(errors)}
    row = lc.normalize_frame(row, "center")
    frames = [fr for fr in frames if fr.get("name") != row["name"]] + [row]
    v = CFG.verify
    meta["verify"] = {"arms": v["armFiles"], "armsManifestSha256": v["armsManifestSha256"], "blind": v["blindPath"],
                      "blindSha256": v["blindSha256"], "lastSavedAt": _now(),
                      "note": "verify pass: arms' proposals shown except on the blind subsample (per-center `blind`); meta.blind is the click pass's"}
    if v.get("allBlind"):
        meta["verify"].update(allBlind=True, note="verify pass --all-blind: every center named with no proposals (no arm was loaded); meta.blind is the click pass's")
    _write_set(set_id, meta, frames)
    return 200, {"ok": True, "frame": row, "meta": meta}


# ---- the start screen and the project screen ------------------------------------------------
#
# project.py works out the facts about a project from its files; this part adds what only the
# running server knows (the pass it runs, how it was started) and does the few things the page
# may ask for: check a path, remember a project, make the toy example, start the first pass.

NO_PASS = "No pass is open on this tool yet. Open its address in a browser to choose what to label."


def _start_dir() -> Path:
    return Path(HUB.start_dir) if HUB.start_dir else Path.cwd()


def _command() -> dict:
    return HUB.command or {**pj.DEFAULT_COMMAND, "cwd": str(_start_dir())}


def _running():
    """The pass this server runs, for a project report; None before one is configured."""
    if not ready():
        return None
    return {"sample": CFG.sample, "labels": CFG.labels_dir, "mode": CFG.mode, "role": CFG.role}


def _own_sample():
    """The sample this run is about: the running pass's, else the one the command line named."""
    return CFG.sample if ready() else HUB.project


def _settings(k, seed, zoom, snap: bool, decklists: dict) -> dict:
    """The settings of a run that are not locations, each only when it is not the default: what
    the command of a pass has to say so that a start with it behaves the same."""
    out = {}
    if decklists:
        out["decklist"] = [(key, str(path)) for key, paths in decklists.items() for path in paths]
    if zoom != lc.DEFAULT_ZOOM:
        out["zoom"] = zoom
    if snap:
        out["snap"] = "on"
    if k != lc.DEFAULT_K:
        out["k"] = k
    if seed != DEFAULT_SEED:
        out["seed"] = seed
    return out


def _flags_for(sample) -> dict:
    """What this run already settled about a project: the running pass's own locations, role
    and settings, or what a start without --mode gave on the command line for the project it
    named. {} for any other project: a flag given at start belongs to the project named at
    start, and a different project opened on the page gets none of them."""
    if ready() and pj._same(CFG.sample, sample):
        # False: this pass was started without it, whatever lies beside the sample
        prefill = _pick(CFG.prefills, "*") or next(iter(CFG.prefills.values()), None)
        return {"labels": CFG.labels_dir, "frames": CFG.frames_dir, "decklists": CFG.decklists_dir, "role": CFG.role,
                "catalog": CFG.catalog if CFG.catalog is not None else False, "art": CFG.art if CFG.art is not None else False,
                "prefill": prefill if prefill and prefill_on() else False,
                "settings": _settings(CFG.k, CFG.seed, CFG.zoom, CFG.snap, CFG.decklists)}
    if _own_start(sample):
        return dict(HUB.flags)
    return {}


def _own_start(sample) -> bool:
    """`sample` is the project the tool was started on (FOLDER-OR-SAMPLE, without --mode)."""
    return HUB.project is not None and pj._same(HUB.project, sample)


# The one frame a project screen shows. /api/thumb serves a file only under a key that a project
# report gave out: a frame of a sample the server has read and checked itself, never a folder or
# a file that a request names.
THUMBS: dict = {}  # key → the frame's file, the newest last
THUMBS_MAX = 64
THUMB_LOCK = threading.Lock()


def _offer_thumb(report: dict) -> None:
    thumb = report["frames"]["thumb"] if report.get("ok") else None
    if not thumb:
        return
    key = hashlib.sha256(f"{report['sample']}\0{thumb['path']}".encode("utf-8")).hexdigest()[:24]
    with THUMB_LOCK:
        THUMBS.pop(key, None)
        THUMBS[key] = thumb["path"]
        while len(THUMBS) > THUMBS_MAX:
            THUMBS.pop(next(iter(THUMBS)))
    thumb["key"] = key


def project_report(sample, given=None, role=None, model_boxes=None) -> dict:
    """project.report for the page. For the project of the running pass, what the page asks for
    (other locations, another purpose) is left out: the pass runs with what it was started with."""
    running = _running()
    if running and pj._same(running["sample"], sample):
        given, role, model_boxes = None, None, prefill_on()
    report = pj.report(sample, given=given, flags=_flags_for(sample), role=role, model_boxes=model_boxes,
                       base=_start_dir(), running=running, command=_command())
    _offer_thumb(report)
    return report


def _asked(body: dict) -> tuple:
    """(locations, role, model boxes) as a page sends them, with anything else dropped."""
    given = body.get("locations")
    given = {k: v.strip() for k, v in given.items() if k in pj.LOCATION_KEYS and isinstance(v, str) and v.strip()} if isinstance(given, dict) else {}
    role = body.get("role") if body.get("role") in lc.ROLES else None
    model_boxes = body.get("modelBoxes") if isinstance(body.get("modelBoxes"), bool) else None
    return given, role, model_boxes


def _report_for(body: dict) -> dict:
    """The report of the project a page names (`path`: a folder or a sample, as typed), or of
    this run's own project when it names none."""
    text = body.get("path")
    if isinstance(text, str) and text.strip():
        found = pj.find_project(text, _start_dir())
        if not found["ok"]:
            return found
        sample = found["sample"]
    else:
        sample = _own_sample()
        if sample is None:
            return {"ok": False, "problem": "none", "path": None}
    return project_report(sample, *_asked(body))


WORK_FOLDER = "work"  # in this repository's own checkout, what the tool makes goes here (ignored by git)


def is_checkout(folder) -> bool:
    """`folder` is a checkout of this repository: it holds labeler/serve.py beside a .git."""
    folder = Path(folder)
    return (folder / "labeler" / "serve.py").is_file() and os.path.lexists(folder / ".git")


def make_dir() -> Path:
    """Where the tool makes new folders (the toy example): the folder it was started in, or in a
    checkout of this repository its work/ folder, which git ignores, so that nothing the tool
    makes shows up among the repository's files."""
    start = _start_dir()
    return start / WORK_FOLDER if is_checkout(start) else start


def toy_target() -> dict:
    """Where the toy example would be written: a folder that does not exist yet, under the
    folder the tool was started in (in a checkout of this repository, under its work/ folder).
    {"path", "state": ok | not-writable | none-free}."""
    base = make_dir()
    writable = base if base.is_dir() else base.parent  # work/ is made with the toy when it is not there yet
    for n in range(1, 100):
        path = base / ("toy" if n == 1 else f"toy-{n}")
        if not os.path.lexists(path):
            return {"path": str(path), "state": "ok" if os.access(writable, os.W_OK | os.X_OK) and not base.is_file() else "not-writable"}
    return {"path": None, "state": "none-free"}


def hub_facts() -> dict:
    """What the start screen shows: the projects opened before (the newest that is still there
    in full, to resume), the samples found under the start folder, where the toy example would
    go, and what this server runs."""
    recent = [{**pj.summary(e["sample"]), "openedAt": e["openedAt"]} for e in pj.read_recent()[:8]]
    resume = None
    for entry in recent:
        if "problem" not in entry:
            report = project_report(Path(entry["sample"]))
            resume = report if report.get("ok") else None
            break
    search = pj.find_samples(_start_dir())
    own = _own_sample()
    command = _command()
    script = str(command["prefix"][-1])
    return {"startDir": str(_start_dir()), "run": RUN_ID, "recent": recent, "resume": resume,
            "found": [pj.summary(path) for path in search["found"]],
            "search": {"cut": search["cut"], "depth": search["depth"]},
            "toy": toy_target(),
            "restart": pj._parts([(w, False) for w in list(command["prefix"]) + list(command.get("tail") or [])])["text"],
            # ready to put into a command: each word quoted as the commands of project.py are
            "tools": {"sample": shlex.quote(re.sub(r"serve\.py$", "make_sample.py", script)),
                      "python": " ".join(shlex.quote(str(w)) for w in command["prefix"][:-1])},
            "server": {"configured": ready(), "mode": CFG.mode if ready() else None, "role": CFG.role if ready() else None,
                       "project": str(own) if own is not None else None, "name": pj.project_name(own) if own is not None else None}}


def _remember(report: dict, model_boxes=None) -> dict:
    """A person opened this project: it goes to the top of the per-user list, and what it was
    opened with (its purpose, the locations that are not found anyway) into the project file of
    its labels folder. Nothing is written into a labels folder when there is nothing to say."""
    places = report["locations"]
    out = {"recent": pj.remember_recent(report["sample"], places["labels"]["path"]), "projectFile": None, "problem": None}
    role = report["role"]["value"]
    stored = [k for k in pj.STORED_LOCATIONS if not places[k]["usual"] and places[k]["source"] != "beside"]
    if role is None and not stored and model_boxes is None:
        return out
    if places["labels"]["state"] not in ("ok", "will-create"):
        out["problem"] = "labels-not-writable"
        return out
    if model_boxes is None and report["modelBoxes"]["offered"] and not report["modelBoxes"]["on"]:
        model_boxes = False
    if model_boxes is None and report["passes"]["box"]["running"] and CFG.role == "training" and not prefill_on():
        model_boxes = False  # a Boxes pass that runs without a model's boxes goes on without them
    path, problem = pj.write_project_file(places["labels"]["path"], report["sample"], role, places, model_boxes)
    out.update(projectFile=str(path) if path else None, problem="labels-not-writable" if problem else None, detail=problem)
    return out


def api_project(body: dict, port=None) -> tuple:
    return _report_for(body), 200


def api_remember(body: dict, port=None) -> tuple:
    report = _report_for(body)
    if not report["ok"]:
        return report, 200
    return {"ok": True, "remembered": _remember(report, _asked(body)[2]), "project": report}, 200


def api_forget(body: dict, port=None) -> tuple:
    sample = body.get("sample")
    if not isinstance(sample, str) or not sample:
        return {"error": "expected the sample to forget"}, 400
    return {"ok": pj.forget_recent(sample)}, 200


def api_toy(body: dict, port=None) -> tuple:
    """Write the toy example into the folder the start screen showed, and nowhere else: the
    folder is worked out here, and a request that names another one is refused. Never over
    anything: the folder must not exist."""
    with OPEN_LOCK:
        target = toy_target()
        if target["state"] != "ok":
            return {"ok": False, "problem": target["state"], "toy": target}, 409
        if body.get("path") != target["path"]:
            return {"ok": False, "problem": "moved", "toy": target}, 409
        folder = Path(target["path"])
        try:
            folder.parent.mkdir(exist_ok=True)  # work/ in a checkout of this repository
            os.mkdir(folder)  # fails when something is there now
            make_toy_data.build(folder)
        except OSError as exc:
            return {"ok": False, "problem": "not-writable", "detail": getattr(exc, "strerror", None) or str(exc), "toy": target}, 409
        sample = folder / pj.SAMPLE_NAME
        # the toy comes with a pretend model's boxes, which only training labels may start from:
        # its purpose is answered so, and can be changed on its screen until a label is saved
        report = pj.report(sample, flags={"role": "training"}, base=_start_dir(), running=_running(), command=_command())
        _remember(report)
        return {"ok": True, "sample": str(sample), "folder": str(folder)}, 200


def describe_run(port) -> list:
    """The lines the terminal shows when a pass starts."""
    lines = [f"labeling tool: http://127.0.0.1:{port}/  mode={CFG.mode} role={CFG.role}",
             f"labels:    {CFG.labels_dir}", f"sample:    {CFG.sample}", f"frames:    {CFG.frames_dir}"]
    if CFG.catalog is None:
        lines.append("catalog: none (boxes can be drawn; no card can be named without --catalog)")
    else:
        cards = load_catalog()
        lines.append(f"catalog: {CFG.catalog} ({len(cards)} cards, {sum(1 for c in cards if c['token'])} tokens)")
    lines.append(f"art:       {CFG.art if CFG.art is not None else 'none (previews show card names only)'}")
    if CFG.verify and CFG.verify.get("allBlind"):
        lines.append(f"verify:    --all-blind · {CFG.verify['blindEvents']} center events, every one named with no proposals")
    elif CFG.verify:
        v = CFG.verify
        lines.append(f"verify:    {v['rows']} face centers with proposals · {v['blindEvents']} blind center events · run {v['defaultSha'][:12]}")
        for arm in v["arms"]:
            lines.append(f"arm {arm}: {v['armFiles'][arm]['file']} (sha256 {v['armFiles'][arm]['sha256'][:12]})")
        if v["blindPath"]:
            lines.append(f"blind:     {v['blindPath']} (sha256 {v['blindSha256'][:12]})")
    for label, m in (("decklist", CFG.decklists), ("prefill", CFG.prefills)):
        for k, v in m.items():
            lines.append(f"{label}: {k} = {v}")
    lines.append(f"decklists: {CFG.decklists_dir}{'' if Path(CFG.decklists_dir).is_dir() else ' (absent)'}")
    return lines


def api_open(body: dict, port=None) -> tuple:
    """Start a pass from the page, on a tool that runs none yet: the same settings the flags
    would give, checked by the same `configure`. Once a pass runs, this answers only for that
    pass (`already`); any other is a new start of the tool, which the page explains.

    The flags given when the tool was started belong to the project named then: that project is
    started with them, any other project with none of them. A start that is refused, or that
    fails, leaves the tool as it was (`configure` changes nothing unless all of it worked), and
    is not remembered: a project is remembered once its pass runs."""
    with OPEN_LOCK:
        report = _report_for(body)
        mode = body.get("pass")
        if not report["ok"]:
            return report, 409
        if ready():
            running = report["passes"].get(mode, {}).get("running")
            return ({"ok": True, "already": True}, 200) if running else ({"ok": False, "problem": "running", "server": report["server"]}, 409)
        try:
            settings = _pass_settings(report, mode)
        except ValueError as exc:
            return {"ok": False, "problem": str(exc)}, 409
        failed = _configure_from_page(settings)
        if failed:
            return failed
        CFG.launch = report["passes"][mode]["command"]["argv"]
        remembered = _remember(report, _asked(body)[2])
        print("\n".join(describe_run(port)))
        sys.stdout.flush()
        return {"ok": True, "remembered": remembered}, 200


def _pass_settings(report: dict, mode: str):
    """The settings that start `mode` of a reported project, as the flags would give them.
    Raises ValueError with the reason's code when the pass cannot be started. The settings given
    when the tool was started belong to the project named then: that project gets them, any other
    project none of them. Check names started from the page names every center with no
    proposal (--all-blind); with models' proposals it is a start with flags."""
    values = pj.open_values(report, mode)
    base = vars(build_parser().parse_args([]))
    if HUB.args is not None and _own_start(report["sample"]):
        # its deck lists as they were resolved at start, wherever the tool's working folder is now
        lists = [path if key == "*" else f"{key}={path}" for key, path in (HUB.flags.get("settings") or {}).get("decklist") or []]
        base = {**vars(HUB.args), "decklist": lists or None}
    return argparse.Namespace(**{**base, **values, "arm": None, "blind": None, "all_blind": mode == "verify", "problems_report": None,
                                 "byte_cap": pj.SAMPLE_BYTES})


def _configure_from_page(settings):
    """`configure`, for a start or a switch from the page: None when it worked, else the answer
    that says why not. Whatever stops it, the tool is left as it was."""
    try:
        configure(settings)
    except (SystemExit, ValueError) as exc:  # the sentence a start with these flags would end in
        return {"ok": False, "problem": "refused", "detail": str(exc)}, 409
    except Exception as exc:  # a fault of the tool itself: said on the page and in the terminal, and nothing is half-started
        traceback.print_exc()
        return {"ok": False, "problem": "refused", "detail": f"the tool failed while it started the pass ({type(exc).__name__}: {exc})"}, 500
    return None


def _fresh_unsaved(exclude=None) -> int:
    """How many other open labeling pages of this run said lately that they hold unsaved changes."""
    now = _dt.datetime.now().timestamp()
    with SAVES.lock:
        return sum(1 for tab, e in SAVES.tabs.items()
                   if tab != exclude and e["run"] == RUN_ID and e["unsaved"] > 0 and now - e["at"] <= TAB_FRESH)


def _busy(tab=None):
    """Why a switch must wait now, or None: a save in progress, or a page with unsaved changes."""
    with SAVES.lock:
        saving = SAVES.in_flight
    pages = _fresh_unsaved(tab)
    if saving or pages:
        return {"ok": False, "problem": "busy", "saving": saving, "pages": pages}, 409
    return None


def api_tabs(body: dict, port=None) -> tuple:
    """A labeling page says whether it holds changes that are not saved yet: each page every few
    seconds, and at once when that changes. Only a page of this run is heard."""
    if body.get("run") != RUN_ID:
        return {"error": OTHER_RUN, "problem": "other-run"}, 409
    tab, unsaved = body.get("tab"), body.get("unsaved")
    if not isinstance(tab, str) or not TAB_RE.fullmatch(tab) or isinstance(unsaved, bool) or not isinstance(unsaved, int) or unsaved < 0:
        return {"error": "expected a tab id and a count of unsaved changes"}, 400
    with SAVES.lock:
        SAVES.tabs.pop(tab, None)
        SAVES.tabs[tab] = {"run": RUN_ID, "unsaved": unsaved, "at": _dt.datetime.now().timestamp()}
        while len(SAVES.tabs) > TAB_MAX:
            SAVES.tabs.pop(next(iter(SAVES.tabs)))
    return {"ok": True}, 200


def api_switch(body: dict, port=None) -> tuple:
    """Switch the running tool to another pass, of this project or another, without a new start.

    The page that asks has saved everything first and says so (`unsaved`: 0). The switch is
    refused while a save of this run is in progress or another page of this run said lately that
    it holds unsaved changes. The new pass is configured exactly as a start from the page would
    configure it, while no other request is answered; refused or failed, the tool runs on as it
    was. On success this is a new run: a new run identity, and the work key (`project`) of the
    new pass, so every open page follows the rules of a tool started again (savegate.js)."""
    global RUN_ID
    # No OPEN_LOCK here: a start or the toy example holds it inside a request (GATE.read), and
    # the switch waits for every request (GATE.write). Two switches are kept apart by the gate and
    # by the run identity, which each switch changes and each checks again inside the gate.
    if body.get("run") != RUN_ID:
        return {"ok": False, "error": OTHER_RUN, "problem": "other-run"}, 409
    if not ready():
        return {"ok": False, "problem": "no-pass"}, 409
    unsaved = body.get("unsaved")
    if isinstance(unsaved, bool) or not isinstance(unsaved, int) or unsaved != 0:
        return {"ok": False, "problem": "unsaved"}, 409
    tab = body.get("tab") if isinstance(body.get("tab"), str) else None
    with GATE.read():
        report = _report_for(body)
    mode = body.get("pass")
    if not report["ok"]:
        return report, 409
    if report["passes"].get(mode, {}).get("running"):
        return {"ok": True, "already": True}, 200
    try:
        settings = _pass_settings(report, mode)
    except ValueError as exc:
        return {"ok": False, "problem": str(exc)}, 409
    busy = _busy(tab)
    if busy:
        return busy
    with GATE.write():
        if body.get("run") != RUN_ID or not ready():  # another switch came first
            return {"ok": False, "error": OTHER_RUN, "problem": "other-run"}, 409
        busy = _busy(tab)  # a save that came in while the requests in progress answered
        if busy:
            return busy
        failed = _configure_from_page(settings)
        if failed:
            return failed
        CFG.launch = report["passes"][mode]["command"]["argv"]
        RUN_ID = secrets.token_hex(8)
    remembered = _remember(report, _asked(body)[2])
    print(f"labeling tool: switched to mode={CFG.mode} role={CFG.role} · {CFG.sample} · labels {CFG.labels_dir}")
    sys.stdout.flush()
    return {"ok": True, "remembered": remembered, "run": RUN_ID}, 200


EXPORT_KINDS = ("coco", "manifest")


def api_export(body: dict, port=None) -> tuple:
    """Write the export of a project from the page, as `export.py` would (its functions, called
    here): `coco` (the boxes, for training) or `manifest` (the labels in the public manifest
    format, the form `cardvision evaluate` reads). An existing file is replaced only when the
    request says so (`replace`). A manifest that cannot be written says why, each problem with
    its code (export.ManifestRefused), so the page can say what to fill in."""
    if body.get("run") != RUN_ID:
        return {"ok": False, "error": OTHER_RUN, "problem": "other-run"}, 409
    kind = body.get("kind")
    if kind not in EXPORT_KINDS:
        return {"ok": False, "problem": "kind"}, 400
    report = _report_for(body)
    if not report["ok"]:
        return report, 409
    places = report["locations"]
    labels = Path(places["labels"]["path"])
    out = Path(report["export"][kind]["out"])
    if not labels.is_dir():
        return {"ok": False, "problem": "nothing", "out": str(out)}, 409
    if os.path.lexists(out) and body.get("replace") is not True:
        return {"ok": False, "problem": "exists", "out": str(out)}, 409
    names = ex.card_names(places["catalog"]["path"]) if places["catalog"]["state"] == "ok" else {}
    try:
        if kind == "coco":
            sets, notes = ex.read_sets(labels)
            if not sets:
                return {"ok": False, "problem": "nothing", "out": str(out), "notes": notes}, 409
            doc = ex.to_coco(sets, names)
            if not doc["images"]:
                return {"ok": False, "problem": "nothing", "out": str(out), "notes": notes}, 409
            out.parent.mkdir(parents=True, exist_ok=True)
            ex.write_text_atomic(out, json.dumps(doc, indent=1) + "\n")
            return {"ok": True, "kind": kind, "out": str(out), "frames": len(doc["images"]), "boxes": len(doc["annotations"]),
                    "ignored": sum(1 for a in doc["annotations"] if a["iscrowd"]), "sets": len(sets), "notes": notes}, 200
        sets, notes = ex.read_manifest_sets([labels])
        if not sets:
            return {"ok": False, "problem": "nothing", "out": str(out), "notes": notes}, 409
        credit = body.get("credit") if isinstance(body.get("credit"), str) else ""
        source = body.get("sourceType") if isinstance(body.get("sourceType"), str) and body.get("sourceType") else None
        sample = Path(report["sample"])
        frames_dir = places["frames"]["path"]
        rows, more = ex.export_manifest(sets, out, ex.read_sample(sample), credit.strip(), None, {"*": source} if source else None,
                                        lambda asset, name: ex.png_dhash(ex.frames_folder(asset, sample, frames_dir) / name))
    except ex.ManifestRefused as exc:
        return {"ok": False, "problem": "refused", "problems": exc.problems, "out": str(out)}, 409
    except (SystemExit, OSError) as exc:
        return {"ok": False, "problem": "failed", "detail": str(exc), "out": str(out)}, 409
    if not rows:
        return {"ok": False, "problem": "nothing", "out": str(out), "notes": notes + more}, 409
    summary = ex.removed_words(notes.removed)  # the removals behind a measuring export, with their reasons
    return {"ok": True, "kind": kind, "out": str(out), "frames": len(rows), "boxes": sum(len(r.get("boxes") or []) for r in rows),
            "points": sum(len(r.get("points") or []) for r in rows), "sets": len(sets), "notes": ([summary] if summary else []) + notes + more,
            "ownRecording": any(r["platform"] == "local" for r in rows)}, 200


def api_restore(body: dict, port=None) -> tuple:
    """Restore a removed frame of a project, from its screen (`path`, as for the export): the
    frame comes back with its labels as they were. Refused, as a switch is, while a save is
    being written or a labeling page says it holds unsaved changes."""
    if body.get("run") != RUN_ID:
        return {"ok": False, "error": OTHER_RUN, "problem": "other-run"}, 409
    video, name = body.get("assetId"), body.get("name")
    if not isinstance(video, str) or not ID_RE.fullmatch(video) or not isinstance(name, str) or not lc.FRAME_NAME.fullmatch(name):
        return {"ok": False, "problem": "invalid"}, 400
    busy = _busy()
    if busy:
        return busy
    report = _report_for(body)
    if not report["ok"]:
        return report, 409
    status, payload = restore_frame(Path(report["locations"]["labels"]["path"]), video, name)
    return payload, status


HUB_POSTS = {"project": api_project, "remember": api_remember, "forget": api_forget, "toy": api_toy, "open": api_open,
             "tabs": api_tabs, "export": api_export, "restore-frame": api_restore}


# ---- HTTP ---------------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "Labeler/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("LABELER_QUIET") or HEARTBEAT in str(getattr(self, "path", "")) or str(getattr(self, "path", "")) == "/api/tabs":
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, obj, status=200):
        if getattr(self, "_held", None) is not None:  # a save: answered once it no longer counts as in flight
            self._held.append((obj, status))
            return
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, ctype=None, say_path: bool = False):
        data, problem = lf.read_bytes(path)  # a regular file only: never a pipe or a device that stands at that name
        if problem:
            # a frame that is not there: the page names the file it looked for
            return self._json({"error": "not found", **({"path": str(path)} if say_path else {})}, 404)
        self.send_response(200)
        self.send_header("Content-Type", ctype or mimetypes.guess_type(str(path))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        if ctype == HTML:  # which page / is depends on whether a pass runs: never an old copy
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _own_hosts(self) -> set:
        port = self.server.server_address[1]
        return {f"127.0.0.1:{port}", f"localhost:{port}"}

    def _from_another_site(self) -> bool:
        """The browser says this request was caused by a page of another site (a link, a
        redirect, an image, a frame). A browser that sends no such header says nothing."""
        return (self.headers.get("Sec-Fetch-Site") or "").strip().lower() in ("cross-site", "same-site")

    def _see(self, where: str):
        """Answer with another address of this tool (303)."""
        self.send_response(303)
        self.send_header("Location", where)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _refused(self) -> bool:
        """The checks every request passes before anything is looked at. This server is for the
        browser on this computer, at its own address:

        - the `Host` header must be 127.0.0.1:<port> or localhost:<port>, so a page that reaches
          this port under another name is turned away;
        - a POST (every request that changes or configures anything is one) must say
          `Content-Type: application/json`, which a form on another site cannot send, and when
          the browser names the page it comes from (`Origin`), that must be this server;
        - a GET of the tool's data (/api/...) that the browser marks as coming from another
          site (`Sec-Fetch-Site: cross-site` or `same-site`) is turned away: only this tool's
          own pages, and an address a person typed, ask for it.

        No CORS header is ever sent, so no other site's script can read an answer either."""
        hosts = self._own_hosts()
        problem = None
        if (self.headers.get("Host") or "").strip().lower() not in hosts:
            problem = 403, "this tool answers only at its own address on this computer (http://127.0.0.1:<port>/)"
        elif self.command == "GET" and self._from_another_site() and urlparse(self.path).path.startswith("/api/"):
            problem = 403, "this tool's data is for its own pages only"
        elif self.command == "POST":
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            origin = self.headers.get("Origin")
            if ctype != "application/json":
                problem = 415, "a request that changes anything must be JSON (Content-Type: application/json)"
            elif origin is not None and origin.strip().lower() not in {f"http://{h}" for h in hosts}:
                problem = 403, "a request that changes anything must come from this tool's own page"
        if problem is None:
            return False
        try:  # what was sent is read and dropped, so the answer arrives
            self.rfile.read(max(0, min(int(self.headers.get("Content-Length") or 0), MAX_BODY)))
        except (ValueError, OSError):
            pass
        self._json({"error": problem[1]}, problem[0])
        return True

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):  # RecursionError: nested too deep to be anything of this tool's
            return None

    def do_GET(self):
        if self._refused():
            return
        with GATE.read():  # never while a switch changes what runs
            self._get()

    def _get(self):
        path = urlparse(self.path).path
        parts = [p for p in path.split("/") if p]
        query = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        if path in ("/", "/index.html", *HUB_PATHS) and "sample" in query and self._from_another_site():
            # another site sent the browser here with a project in the address: that is not a
            # person opening a project. The start screen, with nothing named.
            return self._see("/start")
        if path in ("/", "/index.html"):
            # the labeling page once a pass runs; until then the start screen
            return self._file(TOOL_DIR / ("index.html" if ready() else "hub.html"), HTML)
        if path in HUB_PATHS:
            return self._file(TOOL_DIR / "hub.html", HTML)
        if path == GUIDE_PATH:
            # the guide (README.md) as plain text, for the links of the two screens
            return self._file(TOOL_DIR / "README.md", "text/plain; charset=utf-8")
        if path in STATIC_FILES:
            return self._file(TOOL_DIR / path.lstrip("/"), STATIC_FILES[path])
        if path == "/api/hub":
            return self._json(hub_facts())
        if path == "/api/thumb":
            # one frame of a project, for its screen: the one a report of that project named
            # (`frames.thumb.key`), and no other file
            with THUMB_LOCK:
                thumb = THUMBS.get((query.get("key") or [""])[0])
            return self._file(Path(thumb)) if thumb else self._json({"error": "no frame to show"}, 404)
        if not ready():
            if path == "/api/config":  # the page's question whether the server still runs
                return self._json({"mode": None, "role": None, "launch": CFG.launch, "run": RUN_ID, "project": None})
            if parts[:1] in (["api"], ["frames"], ["art"]):  # what the labeling page asks for
                return self._json({"error": NO_PASS}, 409)
            return self._json({"error": "not found"}, 404)
        if path == "/api/config":
            return self._json({"mode": CFG.mode, "role": CFG.role, "k": CFG.k, "seed": CFG.seed, "zoom": CFG.zoom, "snap": CFG.snap,
                               "prefill": prefill_on(),
                               "identifyTurns": True,  # the identity pass may turn a box's top edge
                               "identifyEdits": True,  # ... and move, resize or rotate a box (training and development box sets)
                               "art": CFG.art is not None,
                               "launch": CFG.launch,
                               # which run of the tool this is, and which work it does: the page sends
                               # `run` back with every save, and tells by `project` whether a tool that
                               # was started again went on with the same work
                               "run": RUN_ID, "project": project_key(),
                               "identity": catalog_rule(),  # which of the catalog's cards are one card (Check names)
                               "verify": ({"arms": CFG.verify["arms"], "allBlind": bool(CFG.verify.get("allBlind")),
                                           "rows": CFG.verify["rows"], "blindEvents": CFG.verify["blindEvents"]}
                                          if CFG.mode == "verify" and CFG.verify else None),
                               "enums": {"outcome": lc.OUTCOMES, "identitySource": lc.IDENTITY_SOURCES,
                                         "eligible": lc.ELIGIBLE, "visibleShare": lc.VISIBLE_SHARE, "centerKind": lc.CENTER_KINDS,
                                         "recording": lc.RECORDING_ENUMS, "recordingFree": lc.RECORDING_FREE}})
        if path == "/api/sets":
            return self._json(list_sets())
        if path == "/api/catalog":
            return self._json(load_catalog())
        if path == "/api/facets":
            return self._json(catalog_facets())
        if path == "/api/tokens":
            return self._json(token_table())
        if len(parts) == 2 and parts[0] == "art":
            # /art/<card id>: the catalog's `art` for that id, inside the --art folder
            art = art_file(unquote(parts[1]))
            return self._file(art) if art is not None else self._json({"error": "no art"}, 404)
        if len(parts) == 3 and parts[0] == "frames":
            aid, name = _safe_id(parts[1]), _safe_frame(parts[2])
            if aid is None or name is None:
                return self._json({"error": "invalid asset or frame"}, 400)
            return self._file(frames_dir_for(aid) / name, say_path=True)
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "labels":
            sid = _safe_id(parts[2])
            if sid is None:
                return self._json({"error": "invalid set id"}, 400)
            return self._json(set_payload(sid))
        if len(parts) == 4 and parts[0] == "api" and parts[1] == "points":
            # /api/points/<set>/<frame>?t=… — the generator; only (frame index, seed, K) go in.
            sid, name = _safe_id(parts[2]), _safe_frame(parts[3])
            if sid is None or name is None:
                return self._json({"error": "invalid set or frame"}, 400)
            meta, _ = read_set(sid)
            rule = (meta or {}).get("pointRule") or lc.point_rule(CFG.seed, CFG.k)
            q = dict(p.split("=", 1) for p in (urlparse(self.path).query or "").split("&") if "=" in p)
            try:
                idx = lc.frame_index(name, q.get("t"))
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)
            return self._json({"frameIndex": idx, "rule": rule,
                               "points": lc.points_for_frame(idx, rule["seed"], rule["k"], rule.get("inset", lc.POINT_INSET))})
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "identify-queue":
            sid = _safe_id(parts[2])
            if sid is None:
                return self._json({"error": "invalid set id"}, 400)
            meta, frames = read_set(sid)
            # the set's frames as the project labels them: a removed frame's boxes wait for no name
            entry = next((s for s in list_sets() if s["setId"] == sid), None)
            names = {f["name"] for f in entry["frames"]} if entry else set()
            return self._json({"queue": [e for e in lc.identify_queue(frames) if e.get("frame") in names], "readOnly": read_only_reason(meta, frames)})
        if len(parts) == 4 and parts[0] == "api" and parts[1] == "nearby":
            # /api/nearby/<set>/<frame>: the frames that could be used instead of that one
            sid, name = _safe_id(parts[2]), _safe_frame(parts[3])
            if sid is None or name is None:
                return self._json({"error": "invalid set or frame"}, 400)
            status, payload = nearby_payload(sid, name)
            return self._json(payload, status)
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "prefill":
            sid = _safe_id(parts[2])
            if sid is None:
                return self._json({"error": "invalid set id"}, 400)
            status, payload = read_prefill(sid)
            return self._json(payload, status)
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self._refused():
            return
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self._body()
        if not isinstance(body, dict):
            return self._json({"error": "expected a JSON object"}, 400)
        if parts == ["api", "switch"]:  # it waits for every other request itself (GATE.write)
            payload, status = api_switch(body, self.server.server_address[1])
            return self._json(payload, status)
        saving = len(parts) >= 3 and parts[0] == "api" and parts[1] in SAVE_ROUTES
        if saving:
            with SAVES.lock:
                SAVES.in_flight += 1
            # The reply waits until the save no longer counts as in flight: a page that acts on it at
            # once (a restore right after a removal) must not find this save still running.
            self._held = []
        try:
            with GATE.read():  # the run is checked and the save written with no switch in between
                self._post(parts, body)
        finally:
            if saving:
                with SAVES.lock:
                    SAVES.in_flight -= 1
                held, self._held = self._held, None
                for obj, status in held:
                    self._json(obj, status)

    def _post(self, parts: list, body: dict):
        if len(parts) == 2 and parts[0] == "api" and parts[1] in HUB_POSTS:
            payload, status = HUB_POSTS[parts[1]](body, self.server.server_address[1])
            return self._json(payload, status)
        if not ready():
            return self._json({"error": NO_PASS}, 409)
        if len(parts) >= 3 and parts[0] == "api" and parts[1] in SAVE_ROUTES and body.get("run") != RUN_ID:
            # a page loaded from another run of the tool: what it holds may belong to other work
            return self._json({"error": OTHER_RUN, "problem": "other-run"}, 409)
        if len(parts) >= 3 and parts[0] == "api" and parts[1] in ("labels", "timing"):
            sid = _safe_id(parts[2])
            if sid is None:
                return self._json({"error": "invalid set id"}, 400)
            if parts[1] == "timing" and len(parts) == 3:
                status, payload = append_timing(sid, body.get("events"))
                return self._json(payload, status)
            if len(parts) == 5 and parts[3] == "frames":
                name = _safe_frame(parts[4])
                frame = body.get("frame")
                if name is None or not isinstance(frame, dict) or frame.get("name") != name:
                    return self._json({"error": "frame name mismatch"}, 400)
                status, payload = save_frame(sid, frame)
                return self._json(payload, status)
            if len(parts) == 4 and parts[3] == "meta":
                status, payload = save_meta(sid, body)
                return self._json(payload, status)
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "remove-frame":
            sid = _safe_id(parts[2])
            if sid is None:
                return self._json({"error": "invalid set id"}, 400)
            status, payload = remove_frame(sid, body)
            return self._json(payload, status)
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "verify-reveal":
            sid, name = _safe_id(parts[2]), _safe_frame(str(body.get("frame") or ""))
            if sid is None or name is None or not isinstance(body.get("center"), str):
                return self._json({"error": "invalid set, frame or center"}, 400)
            status, payload = verify_reveal(sid, name, body["center"])
            return self._json(payload, status)
        return self._json({"error": "not found"}, 404)


def _parse_mapping(values, many: bool = False, flag: str = "") -> dict:
    """[SET=]FILE values → {set or "*": Path}; with many=True a key may repeat (→ [Path, ...]),
    e.g. two decklists (one per player) for one set. `flag`: the flag they were given with, for
    the sentence that says a value is no file."""
    out = {}
    for v in values or []:
        key, _, path = v.partition("=") if "=" in v and not os.path.exists(v) else ("*", "", v)
        p = Path(path).expanduser().resolve()
        if not p.is_file():
            raise SystemExit(f"{flag + ': ' if flag else ''}not a file: {p}")
        if many:
            out.setdefault(key, []).append(p)
        else:
            out[key] = p
    return out


def _parse_arms(values) -> dict:
    """--arm NAME=FILE values → {name: Path}, in the order given. One or two arms."""
    out = {}
    for v in values or []:
        name, sep, path = v.partition("=")
        if not sep or not path:
            raise SystemExit(f"--arm takes NAME=FILE, not {v!r}")
        problem = lc.arm_name_error(name)
        if problem:
            raise SystemExit(f"--arm: {problem}")
        if name in out:
            raise SystemExit(f"--arm: {name} is given twice")
        out[name] = Path(path).expanduser().resolve()
    if len(out) > lc.MAX_ARMS:
        raise SystemExit(f"--arm: at most {lc.MAX_ARMS} arms (the reveal shows them side by side)")
    return out


def _resolve_art(value):
    """--art: a URL base as given, or a folder that must exist."""
    if value is None:
        return None
    if is_url(value):
        return value
    d = Path(value).expanduser().resolve()
    if not d.is_dir():
        raise SystemExit(f"--art: not a folder or an http(s) URL: {value}")
    return d


def configure(args) -> None:
    """Set this run up for one pass, from a parsed command line or from what the page asked for.
    Raises SystemExit (one sentence) or ValueError when the settings cannot work. Whatever stops
    it, a refusal or a fault, the configuration is put back exactly as it was: there is never a
    half-configured server, and while this runs the server does not report a pass (`ready`)."""
    before = dict(CFG.__dict__)
    was = HUB.configuring
    HUB.configuring = True
    try:
        _configure(args)
    except BaseException:
        CFG.__dict__.clear()
        CFG.__dict__.update(before)
        raise
    finally:
        HUB.configuring = was


def check_numbers(args) -> None:
    if args.k < 1 or args.zoom <= 0:
        raise SystemExit("--k must be ≥ 1 and --zoom > 0")


def check_settings(args) -> tuple:
    """(deck lists, suggestions files) of a command line, after the checks `configure` makes of
    the settings that are not locations: SystemExit with one sentence. A start without --mode
    makes them too, so that a start which could never open a pass ends at once, not on the
    page at every try."""
    check_numbers(args)
    return _parse_mapping(args.decklist, many=True, flag="--decklist"), _parse_mapping(args.prefill, flag="--prefill")


def _configure(args) -> None:
    if not getattr(args, "sample", None):
        raise SystemExit("--sample FILE is needed: the list of frames to label (make_sample.py writes one)")
    sample = Path(args.sample).expanduser().resolve()
    if not sample.is_file():
        raise SystemExit(f"--sample: not a file: {sample}")
    arms = _parse_arms(getattr(args, "arm", None))
    lc.check_mode_role(args.mode, args.role, bool(args.prefill), bool(getattr(args, "all_blind", False)))
    check_numbers(args)
    beside = sample.parent  # everything defaults to living beside the sample file
    CFG.byte_cap = getattr(args, "byte_cap", None)  # a start from the page reads no file larger than this
    CFG.sample = sample
    CFG.labels_dir = Path(args.labels_dir).expanduser().resolve() if args.labels_dir else beside / "labels"
    CFG.frames_dir = Path(args.frames_dir).expanduser().resolve() if args.frames_dir else beside / "frames"
    cat = getattr(args, "catalog", None)
    CFG.catalog = Path(cat).expanduser().resolve() if cat else None
    if CFG.catalog is not None:
        doc, problem = lf.read_json(CFG.catalog, CFG.byte_cap)
        if problem:
            raise SystemExit(f"--catalog: cannot read {CFG.catalog}: {'it is not JSON' if problem == 'not-json' else lf.PROBLEM_WORDS[problem]}")
        if not isinstance(doc, dict):
            raise SystemExit(f"--catalog: {CFG.catalog} is not a JSON object with a `cards` list")
        problem = (catalog_id_problem(doc) or lc.identity_rule_problem(doc) or lc.facets_problem(doc)
                   or lc.extra_problem(doc))
        if problem:
            raise SystemExit(f"--catalog: {CFG.catalog}: {problem}")
    CFG.art = _resolve_art(getattr(args, "art", None))
    CFG.mode, CFG.role, CFG.k, CFG.seed, CFG.zoom = args.mode, args.role, args.k, args.seed, args.zoom
    CFG.snap = getattr(args, "snap", "off") == "on"
    CFG.decklists = _parse_mapping(args.decklist, many=True, flag="--decklist")
    ddir = getattr(args, "decklists_dir", None)
    CFG.decklists_dir = Path(ddir).expanduser().resolve() if ddir else beside / "decklists"
    CFG.prefills = _parse_mapping(args.prefill, flag="--prefill")
    blind = getattr(args, "blind", None)
    report = getattr(args, "problems_report", None)
    all_blind = bool(getattr(args, "all_blind", False))
    CFG.verify = None
    if args.mode == "verify" and all_blind:
        if arms or blind or report:
            raise SystemExit("--all-blind takes no --arm, --blind or --problems-report (one way or the other)")
        CFG.verify = load_all_blind()
    elif args.mode == "verify":
        if not arms:
            raise SystemExit("verify mode needs --arm NAME=FILE (one or two), or --all-blind")
        CFG.verify = load_verify(arms, Path(blind).expanduser() if blind else None, report)
    elif arms or blind or all_blind or report:
        raise SystemExit("--arm / --blind / --all-blind / --problems-report belong to verify mode")


def python_name(executable=None, which=shutil.which) -> str:
    """How a command shown to a person calls `executable` (default: the interpreter that runs this
    server): `python3` or `python` when that name, looked up on PATH, runs this same program (a
    link to it counts), else its full path."""
    exe = executable or sys.executable
    for name in ("python3", "python"):
        found = which(name)
        if found and _same_program(found, exe):
            return name
    return exe


def _same_program(a, b) -> bool:
    if os.path.realpath(a) == os.path.realpath(b):
        return True
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


_PYTHON_NAME: list = []


def _python_name() -> str:
    """python_name() worked out once for this run: every command the tool shows (the project
    screen's passes and export, the start screen's, the labeling page's) names the interpreter
    the same way, however PATH looks when one of them is asked for."""
    if not _PYTHON_NAME:
        _PYTHON_NAME.append(python_name())
    return _PYTHON_NAME[0]


PROJECT_FLAGS = (("role", "--role"), ("labels_dir", "--labels-dir"), ("frames_dir", "--frames-dir"), ("catalog", "--catalog"),
                 ("art", "--art"), ("decklists_dir", "--decklists-dir"), ("decklist", "--decklist"), ("prefill", "--prefill"))
VERIFY_FLAGS = (("arm", "--arm"), ("blind", "--blind"), ("all_blind", "--all-blind"), ("problems_report", "--problems-report"))


class Parser(argparse.ArgumentParser):
    """The command line. With --mode it starts that pass, and then --role and the sample are
    needed too; without --mode the page asks, and the flags that describe a project need one."""

    def parse_args(self, args=None, namespace=None):
        a = super().parse_args(args, namespace)
        given = lambda names: [flag for key, flag in names if getattr(a, key, None)]  # noqa: E731
        if a.sample and a.project:
            self.error("the sample is given twice: use --sample FILE or FOLDER-OR-SAMPLE, not both")
        if a.mode:
            missing = [flag for flag, value in (("--role", a.role), ("--sample", a.sample or a.project)) if not value]
            if missing:
                self.error(f"--mode {a.mode} also needs {' and '.join(missing)} (or start with no arguments and choose on the page)")
        else:
            if given(VERIFY_FLAGS):
                self.error(f"{', '.join(given(VERIFY_FLAGS))}: only with --mode verify")
            if given(PROJECT_FLAGS) and not (a.sample or a.project):
                self.error(f"{', '.join(given(PROJECT_FLAGS))}: say which project too (FOLDER-OR-SAMPLE), or leave it out and choose on the page")
        return a


def build_parser():
    p = Parser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("project", nargs="?", default=None, metavar="FOLDER-OR-SAMPLE",
                   help="a project to open: a sample file, or the folder that holds a sample.json (without --mode: its screen on the page)")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port on 127.0.0.1 (default {DEFAULT_PORT}; 0 picks a free one)")
    p.add_argument("--mode", choices=lc.MODES, default=None,
                   help="start this pass at once (then --role and the sample are needed); without it the page asks")
    p.add_argument("--role", choices=lc.ROLES, default=None, help="what the labels are for")
    p.add_argument("--sample", default=None, help="the frames to label: {assets: [{assetId, frames: [{t, name}]}]}")
    p.add_argument("--labels-dir", default=None, help="labels root (default: labels/ beside the sample)")
    p.add_argument("--frames-dir", default=None, help="frames root <dir>/<assetId>/<name> (default: frames/ beside the sample)")
    p.add_argument("--catalog", default=None,
                   help="the game's cards: {cards: [{id, name, kind, printingOf, art, token}], kinds: {landscape: [...]}, tokens: [...]}")
    p.add_argument("--art", default=None,
                   help="where the catalog's `art` files are: a folder, or an http(s) URL base the browser loads them from "
                        "(without it the previews show card names only)")
    p.add_argument("--k", type=int, default=lc.DEFAULT_K, help="points per frame for NEW point-mode sets")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED, help="point seed for NEW point-mode sets")
    p.add_argument("--zoom", type=float, default=lc.DEFAULT_ZOOM, help="fixed zoom (screen px per frame px) for NEW sets")
    p.add_argument("--snap", choices=("on", "off"), default="off",
                   help="corner snapping when the page opens (default off: it helps rough clicks, not careful ones)")
    p.add_argument("--decklist", action="append",
                   help="[SET=]FILE: ids or names, one per line (repeat for a second player's list); overrides --decklists-dir")
    p.add_argument("--decklists-dir", default=None,
                   help="per-video deck lists <video id>.txt / <video id>.<label>.txt (default: decklists/ beside the sample)")
    p.add_argument("--prefill", action="append",
                   help="[SET=]FILE: model proposals (training mode, or box mode with --role training)")
    p.add_argument("--arm", action="append", metavar="NAME=FILE",
                   help="verify mode: a model arm, named, and its prefill file (give one or two)")
    p.add_argument("--blind", default=None, help="verify mode: the blind subsample (center events named with no proposals)")
    p.add_argument("--all-blind", action="store_true",
                   help="verify mode: every center blind, no arm; excludes --arm / --blind")
    p.add_argument("--problems-report", default=None,
                   help="verify mode: write the problems that refuse the start to this JSON file too")
    return p


NOT_A_PROJECT = {
    "missing": "nothing is there",
    "bad-path": "that is not a path this computer understands",
    "no-sample-in-folder": "that folder holds no sample.json (name the sample file itself if it is called something else)",
    "unreadable": "the file cannot be read",
    "not-file": "that is not a file (a device or a pipe)",
    "too-big": "the file is larger than 20 MB, which no sample is (start it with --mode, --role and --sample to read it all the same)",
    "not-json": "the file is not JSON, so it is not a sample",
    "not-sample": "the file is JSON but lists no videos (a sample is {\"assets\": [...]}; make_sample.py writes one)",
}


def _named_project(args):
    """The sample a command line names (--sample, or FOLDER-OR-SAMPLE), checked; None when it
    names none. Ends in one sentence when what it names is no sample."""
    text = args.sample or args.project
    if not text:
        return None
    found = pj.find_project(text, Path.cwd())
    if not found["ok"]:
        raise SystemExit(f"{text}: {NOT_A_PROJECT.get(found['problem'], 'not a sample')}: {found['path']}")
    return found["sample"]


def _launch_command(args) -> dict:
    """How this run was started, for the commands the page shows: the interpreter and the script
    as they were typed, and the port when one was asked for."""
    argv = [_python_name(), *(getattr(sys, "orig_argv", None) or [None, *sys.argv])[1:]]
    at = next((i for i, word in enumerate(argv) if re.search(r"(^|[\\/])serve\.py$", str(word))), None)
    prefix = argv[:at + 1] if at is not None else list(pj.DEFAULT_COMMAND["prefix"])
    return {"prefix": prefix, "tail": ["--port", str(args.port)] if args.port != DEFAULT_PORT else [], "cwd": str(Path.cwd())}


def _hub_flags(args) -> dict:
    """The role, the locations and the other settings a start without --mode gave for its
    project, resolved and checked as the same flags are when they start a pass: a start that
    names a deck list which is no file ends here, in one sentence."""
    decklists, prefills = check_settings(args)
    flags = {"role": args.role, "settings": _settings(args.k, args.seed, args.zoom, args.snap == "on", decklists)}
    for key, value in (("labels", args.labels_dir), ("frames", args.frames_dir), ("catalog", args.catalog), ("decklists", args.decklists_dir)):
        if value:
            flags[key] = Path(value).expanduser().resolve()
    if args.art:
        flags["art"] = _resolve_art(args.art)
    if prefills:
        flags["prefill"] = prefills.get("*") or next(iter(prefills.values()))
    return flags


def adopt_flag_start(args) -> None:
    """A run started with --mode may be switched to another pass from the page. The flags it was
    started with keep belonging to its project: that project gets them again on a switch back,
    and another project opened on the page gets none of them."""
    HUB.args, HUB.project, HUB.flags = args, CFG.sample, _hub_flags(args)


def main() -> None:
    args = build_parser().parse_args()
    HUB.start_dir = Path.cwd()
    HUB.command = _launch_command(args)
    sample = None
    if args.mode:
        if not args.sample:  # FOLDER-OR-SAMPLE names the file --sample would; --sample itself is taken as before
            args.sample = str(_named_project(args))
        try:
            configure(args)
        except ValueError as exc:  # a mode, role and pre-fill that do not go together: one sentence, no traceback
            raise SystemExit(f"--mode {args.mode} --role {args.role}: {exc}")
        adopt_flag_start(args)
    else:  # no pass yet: the page asks
        sample = _named_project(args)
        HUB.args = args
        HUB.project = sample
        HUB.flags = _hub_flags(args) if sample is not None else {}
    CFG.launch = [_python_name(), *(getattr(sys, "orig_argv", None) or [None, *sys.argv])[1:]]
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except (OSError, OverflowError) as exc:  # the port is taken, not a port, or not one this user may open
        raise SystemExit(f"--port {args.port}: cannot listen on 127.0.0.1:{args.port} ({getattr(exc, 'strerror', None) or exc}); "
                         "pass another --port (0 picks a free one)")
    port = server.server_address[1]
    if args.mode:
        print("\n".join(describe_run(port)))
    else:
        what = f"choose what to label in {pj.project_name(sample)}" if sample is not None else "choose what to label"
        print(f"Card labeler: http://127.0.0.1:{port}/\nOpen this address to {what}.\nCtrl+C stops the tool.")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
