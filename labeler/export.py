# SPDX-License-Identifier: Apache-2.0
"""Export label sets to other formats. The tool's own format (FORMAT.md) is the source of
truth; an export is a copy for another program to read and is never read back.

    python3 export.py coco --labels-dir DIR --out boxes.json [--set ID ...] [--role ROLE ...]
                           [--include-unconfirmed] [--catalog FILE]

`coco` writes the boxes of box, corner and training sets as one COCO-style detection file:

- `images`: one per frame, `file_name` `<frame asset>/<frame name>` (how the frames lie under a
  frames root), `width` / `height` the frame's own size as the page measured it, plus `set`,
  `role` and `t`. Only confirmed frames (Enter in box mode: "every card on it is boxed") unless
  `--include-unconfirmed`; a frame confirmed with no boxes is an image with no annotations, which
  says "no card here".
- `categories`: 1 `card` (a card face) and 2 `card-back`.
- `annotations`: one per box. `bbox` is the axis-aligned box around the four corners, `[x, y,
  width, height]` in frame pixels; `segmentation` is the four corners themselves as one polygon
  (the card's own top-left first, clockwise), so a rotated box or a quad is not lost; `area` is
  the polygon's. An ignored box (`h` in box mode: a card that is there but should neither be
  rewarded nor penalized) is exported with `iscrowd: 1`, COCO's own way to say that. Everything
  the label carries beyond a box goes under `attributes`: the card id and printing, eligibility,
  angle, provenance and the target's id. Targets answered "not a card" are left out, and so are
  boxes still waiting for review (a model's proposal nobody accepted).

Point sets and center sets hold no boxes and are skipped, with a note.

A frame removed from the project (removed-frames.json in the labels folder, FORMAT.md) is
skipped by both exports, with a note that counts them.

    python3 export.py manifest --labels-dir DIR [--labels-dir DIR] --sample FILE --credit "NAME"
                               --out labels.manifest.jsonl [--group [SET=]ID ...] [--source-type [SET=]TYPE ...]
                               [--frames-dir DIR] [--no-fingerprint] [--set ID ...] [--role ROLE ...] [--catalog FILE]

`manifest` writes the same sets in the repository's public label-manifest format (data/SCHEMA.md
there): one line of JSON per confirmed frame, naming a video and a time, with every coordinate
as a fraction of the frame. It also writes the labels made for measuring a model, as
`completeness: "points"` rows ("Measuring labels as points", below). It is the form in which labels are offered to the project, so every
row is written as an offer: `role` `extra`, `trained_on` false, `reachable` and
`reachable_checked` null. Check the result with `cardvision validate-manifest FILE
--contribution`; this tool imports nothing from that package and cannot run the check itself.

What a row needs beyond the labels, and where it comes from:

- `platform` and `video_id`: the sample file. A frame record, or its asset for all of its
  frames, carries `"platform": "youtube"` (or `"twitch"`) and `"videoId": "..."`. For a
  recording of your own, which is on no platform, the platform is `"local"` and the video id a
  name you choose (1 to 64 letters, digits, `_` and `-`, starting with a letter or a digit);
  `make_sample.py --local` writes both. Such rows are for your own use: they cannot be offered
  to the project, because nobody else can obtain the video.
- `t`: the frame record's `t`, which must be the frame's time in the video in seconds (the last
  frame at or before `t` is the labeled one), not merely a number that orders the frames.
- `frame_width`, `frame_height`: the row's `frameW` and `frameH`.
- `source_type`: `--source-type`, else the set's recording tags (`source`, with `physicalGroup`
  after a slash when it is set).
- `group`: `--group`. Videos of one channel or event belong in one group. Without the flag each
  video is a group of its own, with an id made from the video's id.
- `credit`: `--credit`.

Only confirmed frames are written, since a row says that every card on the frame has a box.
Each target becomes a box: `outcome` gives `kind`, `eligible` gives `readable` (`uncertain` is
`maybe`), an identity gives `card_id` (the printing on screen when one is recorded), a box
without an identity is `unlabeled`, and `labelSource` gives `origin`. A card id with a space or
other whitespace, a control character, or more than 64 characters stops the export, which names
the frame and the box. A frame with a target
that the format cannot hold (an outline that is not convex, or wholly off the frame) is left out
whole and listed, because a row that lacked one of its boxes would say that card is background.
Repeat sets are skipped: they label frames another set already has.

Measuring labels as points. A center set (the Centers pass, named in Check names) and a point
set (the Points pass) become rows whose `points` say what lies under each position, and nothing
about the rest of the frame:

- A center set's frame is written only when its census was confirmed (Enter: every card's
  center clicked). A confirmed frame with no center has no point to write; it is left out and
  counted in a note. Each center is a point with `origin` `center`.
- A named face is a `face` with its `card_id` and `identity` `named`; Unknown is `identity`
  `unknown`; the corrections "not a card" and "a card back" are those kinds; a clicked back is
  a `back`. A face that Check names has not answered in full, or whose answer is stale (the
  center moved, or the proposals' files changed), is a `face` with `identity` `unlabeled` and
  `readable` null, and the note says how many there are.
- `readable` is Check names' first answer, whether the name is legible in the crop (yes,
  unsure, no: `yes`, `maybe`, `no`), and such a point carries `attributes.readable_from`
  `crop`, since the manifest's own `readable` speaks of the whole frame. A face named with no
  proposal shown carries `attributes.blind` true.
- A point set's frame is written once it is done, each answered point with `origin` `seeded`,
  its answer mapped as a box's is.
- `--labels-dir` may be given more than once: a center set and a point set of the same video
  (kept in two labels folders, since a recording keeps one way of labeling in a folder) give
  one row for a frame they share, whose `points` hold both. Rows with boxes are never merged.

`attributes.frame_dhash`, the fingerprint that lets a frame be found again by its content, is
written for frames stored as 8-bit PNG files, which this tool can decode with the standard
library alone. It is left out for JPEG frames (the standard library has no JPEG decoder), and
with `--no-fingerprint`; a row without it is found by `t` alone.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import math
import os
import re
import stat
import struct
import sys
import tempfile
import zlib
from pathlib import Path

sys.dont_write_bytecode = True
import labelcore as lc  # noqa: E402
import labelfiles as lf  # noqa: E402

BOX_SET_MODES = ("box", "corner", "training")  # the set modes whose rows carry `targets`
POINT_SET_MODES = ("center", "point")  # the set modes the manifest writes as `points` rows
MANIFEST_SET_MODES = BOX_SET_MODES + POINT_SET_MODES
COCO_CATEGORIES = [{"id": 1, "name": "card", "supercategory": "card"},
                   {"id": 2, "name": "card-back", "supercategory": "card"}]
CATEGORY_OF = {"card": 1, "unreadable": 1, "card-back": 2}  # a card too blurred to name is still a card face


def write_text_atomic(path: Path, text: str) -> None:
    """Write `text` to `path` in one step: to a temporary file beside it, which then takes its
    place. A write that fails or is interrupted leaves the file that was there as it was. A file
    that is replaced keeps its permissions; a symbolic link is written through; a file that may
    not be written to is refused, as a plain write would refuse it."""
    path = Path(os.path.realpath(path))
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except FileNotFoundError:
        mask = os.umask(0)
        os.umask(mask)
        mode = 0o666 & ~mask
    else:
        if not os.access(path, os.W_OK):
            raise PermissionError(f"{path}: the file may not be written to")
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".partial")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


class Notes(list):
    """The notes of a read of label sets, with `removed` beside them: the reason (or None) of
    each removed frame that was skipped, for the summary of the manifest export."""

    def __init__(self, notes=(), removed=()):
        super().__init__(notes)
        self.removed = list(removed)


REASON_WORDS = {"blurry-or-small": "too blurry or too small", "no-cards": "no cards", "near-duplicate": "nearly the same as another",
                "other": "another reason", None: "no reason given"}


def removed_words(reasons: list) -> str:
    """The removed frames an export skipped, for its summary line: "3 removed frames skipped (2
    no cards, 1 no reason given)"; empty when none was."""
    if not reasons:
        return ""
    counts = {}
    for r in reasons:
        counts[r] = counts.get(r, 0) + 1
    order = [r for r in (*lf.REMOVE_REASONS, None) if r in counts]
    return (f"{len(reasons)} removed {'frame' if len(reasons) == 1 else 'frames'} skipped ("
            + ", ".join(f"{counts[r]} {REASON_WORDS[r]}" for r in order) + ")")


def read_sets(root: Path, only=None, roles=None, modes=BOX_SET_MODES) -> tuple:
    """([(set id, meta, frame rows)], notes) for the sets of a labels root whose mode is one of
    `modes` (the box, corner and training sets unless said), in set-id order. `only`: set ids to
    keep (all when empty); `roles`: roles to keep. A frame removed from the project
    (removed-frames.json in the root, labelfiles.read_removed) is skipped, with a note."""
    root = Path(root)
    if not root.is_dir():
        raise SystemExit(f"--labels-dir: not a folder: {root}")
    sets, notes = [], Notes()
    record, problem = lf.read_removed(root)
    if problem:
        raise SystemExit(f"{root / lf.REMOVED_FILE}: the list of removed frames cannot be used "
                         f"({lf.PROBLEM_WORDS.get(problem, 'it is not JSON' if problem == 'not-json' else 'it holds an entry the tool would not write')}); "
                         "correct it or delete it, then export again")
    gone = lf.removed_keys(record)
    why = {(e["assetId"], e["name"]): e["reason"] for e in record["removed"]}
    wanted = list(only or [])
    for set_id in wanted:
        if not (root / set_id / "meta.json").is_file():
            raise SystemExit(f"no label set {set_id!r} in {root}")
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        if wanted and d.name not in wanted:
            continue
        # the tool's one reader (labelfiles.py): what the project screen and the labeling page read
        meta, frames = lf.read_label_set(d)
        damage = lf.own_damage(meta, frames)
        if damage:
            # never written from in part: the set is left out whole, and said with its file and line
            notes.append(f"{d.name}: left out, a label file cannot be read in full ({lf.damage_words(damage)}); correct or remove that line, then export again")
            continue
        if not (d / "meta.json").is_file() or not (d / "frames.jsonl").is_file():
            continue  # not a label set
        if not isinstance(meta, dict) or lc.is_foreign_set(meta, frames):
            notes.append(f"{d.name}: not a label set of this tool, skipped")
            continue
        if meta.get("mode") not in modes:
            notes.append(f"{d.name}: a {meta.get('mode')} set holds no boxes, skipped")
            continue
        if roles and meta.get("role") not in roles:
            continue
        video = meta.get("frameAsset") or d.name
        kept = [fr for fr in frames if (video, fr.get("name")) not in gone]
        if len(kept) < len(frames):
            skipped = len(frames) - len(kept)
            notes.removed += [why[(video, fr.get("name"))] for fr in frames if (video, fr.get("name")) in gone]
            notes.append(f"{d.name}: {skipped} removed {'frame' if skipped == 1 else 'frames'} skipped")
        sets.append((d.name, meta, kept))
    return sets, notes


def read_manifest_sets(roots: list, only=None, roles=None) -> tuple:
    """`read_sets` for the manifest: the box, corner, training, center and point sets of one or
    more labels roots, root by root. A set named by `only` must be in at least one of them."""
    sets, notes = [], Notes()
    for set_id in only or []:
        if not any((Path(root) / set_id / "meta.json").is_file() for root in roots):
            raise SystemExit(f"no label set {set_id!r} in {', '.join(str(r) for r in roots)}")
    for root in roots:
        here = [s for s in only or [] if (Path(root) / s / "meta.json").is_file()]
        if only and not here:
            continue
        more, said = read_sets(Path(root), here, roles, MANIFEST_SET_MODES)
        sets += more
        notes += said
        notes.removed += said.removed
    return sets, notes


def polygon_area(corners) -> float:
    """The area of four corners (shoelace), whichever way they run."""
    return abs(lc.signed_area([[float(p[0]), float(p[1])] for p in corners]))


def target_annotation(t: dict, names: dict):
    """One target as a COCO annotation without its ids, or None when it is not exported: no
    corners, answered "not a card", or a proposal still waiting for review."""
    corners = t.get("corners")
    if not (isinstance(corners, list) and len(corners) == 4) or t.get("pending"):
        return None
    outcome = t.get("outcome") or "card"
    if outcome not in CATEGORY_OF:
        return None
    try:
        x, y, w, h = lc.corners_aabb(corners)
        area = polygon_area(corners)
    except (TypeError, ValueError, IndexError):
        return None
    identity = t.get("identity") if t.get("identity") not in (None, "", "unknown") else None
    attributes = {
        "targetId": t.get("id"),
        "cardId": identity,
        "cardName": names.get(identity) if identity else None,
        "printing": t.get("printing"),
        "identityUnknown": t.get("identity") == "unknown",
        "eligible": t.get("eligible"),
        "ignore": bool(t.get("ignore")),
        "unreadable": outcome == "unreadable",
        "angle": t.get("angle") or 0,
        "cornerSource": t.get("cornerSource"),
        "labelSource": t.get("labelSource"),
        "estimatedCorners": [bool(v) for v in (t.get("estimated") or [False] * 4)],
        "conditions": t.get("conditions") or {},
    }
    return {
        "category_id": CATEGORY_OF[outcome],
        "bbox": [round(x, 2), round(y, 2), round(w, 2), round(h, 2)],
        "area": round(area, 2),
        "segmentation": [[round(float(v), 2) for p in corners for v in p]],
        "iscrowd": 1 if t.get("ignore") else 0,
        "attributes": attributes,
    }


def to_coco(sets: list, names=None, include_unconfirmed: bool = False) -> dict:
    """A COCO-style detection document for `sets` ([(set id, meta, frame rows)]).
    `names`: card id → name, to write the name beside the id (optional)."""
    names = names or {}
    images, annotations = [], []
    for set_id, meta, frames in sets:
        asset = meta.get("frameAsset") or set_id
        for fr in sorted(frames, key=lambda r: (r.get("t") or 0, r.get("name") or "")):
            if not (fr.get("done") or include_unconfirmed):
                continue
            image_id = len(images) + 1
            images.append({"id": image_id, "file_name": f"{asset}/{fr.get('name')}",
                           "width": fr.get("frameW"), "height": fr.get("frameH"),
                           "set": set_id, "role": meta.get("role"), "t": fr.get("t"), "confirmed": bool(fr.get("done"))})
            for t in fr.get("targets") or []:
                ann = target_annotation(t, names)
                if ann is not None:
                    annotations.append({"id": len(annotations) + 1, "image_id": image_id, **ann})
    return {
        "info": {"description": "Card boxes exported by the labeling tool (COCO-style)",
                 "date_created": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
                 "labelSchemaVersion": lc.SCHEMA_VERSION},
        "licenses": [],
        "categories": [dict(c) for c in COCO_CATEGORIES],
        "images": images,
        "annotations": annotations,
    }


def card_names(catalog_path) -> dict:
    """Card id → name from a catalog file ({} without one)."""
    if not catalog_path:
        return {}
    try:
        doc = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"--catalog: cannot read {catalog_path}: {exc}")
    cards = doc.get("cards") if isinstance(doc, dict) else None
    return {c["id"]: c.get("name") for c in cards or [] if isinstance(c, dict) and isinstance(c.get("id"), str)}


# ---- the public label-manifest format -----------------------------------------------------------
#
# The format is defined by the repository's data/SCHEMA.md; this is a writer for it, in the
# standard library only. The patterns below restate that document's so that a mistake is reported
# here, by set and frame, before the file is written. The card-id rule is in labelcore.py.

MANIFEST_VERSION = 1
MANIFEST_PLATFORMS = ("youtube", "twitch", "local")  # "local": a recording of your own, on no platform
_VIDEO_ID = {"youtube": re.compile(r"^[A-Za-z0-9_-]{11}$"), "twitch": re.compile(r"^[0-9]{6,12}$"),
             "local": re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")}
_GROUP = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")
_SOURCE_TYPE = re.compile(r"^(physical|digital)(/[a-z0-9]+(-[a-z0-9]+)*)?$")
_LABEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
KIND_OF = {"card": "face", "card-back": "back", "unreadable": "unreadable", "not-card": "not-card"}
READABLE_OF = {"yes": "yes", "uncertain": "maybe", "no": "no"}
ORIGIN_OF = {"manual": "manual", "prefill-accepted": "prefill", "prefill-corrected": "prefill",
             "carried": "carried", "carried-corrected": "carried",
             "propagated": "propagated", "propagated-corrected": "propagated"}
QUAD_RANGE = (-1.0, 2.0)  # a corner may lie this far outside the frame, as a fraction of it
GRID_COLUMNS, GRID_ROWS = 9, 8  # the fingerprint's grid


def credit_error(credit) -> str | None:
    """Why a credit cannot be written, or None: 1 to 80 characters, no line break or other
    control character, no space at either end."""
    if not isinstance(credit, str) or not credit:
        return "a credit is needed (--credit): the name to show for these labels"
    if len(credit) > 80 or _CONTROL.search(credit) or credit != credit.strip():
        return "--credit must be 1 to 80 characters on one line, with no space at either end"
    return None


def default_group(platform: str, video_id: str) -> str:
    """The group of a video nobody grouped: an id of its own, made from the video's id."""
    return "new-" + hashlib.sha256(f"{platform}/{video_id}".encode("utf-8")).hexdigest()[:12]


def recording_source_type(meta: dict) -> str | None:
    """A set's source type from its recording tags: `physical/<physicalGroup>`, `physical` or
    `digital`; None when the footage's source was never tagged."""
    rec = meta.get("recording") if isinstance(meta.get("recording"), dict) else {}
    source = rec.get("source")
    if source == "physical" and rec.get("physicalGroup"):
        return f"physical/{rec['physicalGroup']}"
    return source if source in ("physical", "digital") else None


def read_sample(path) -> dict:
    """{asset id: asset} of a sample file: what the sample lists by the tool's one rule
    (labelcore.sample_assets), as the project screen and the labeling page list it."""
    assets, problem = lf.read_sample(path)
    if problem and problem != "not-sample":
        raise SystemExit(f"--sample: cannot read {path}: {'it is not JSON' if problem == 'not-json' else lf.PROBLEM_WORDS[problem]}")
    return {a["assetId"]: a for a in assets or []}


def frame_address(asset: dict, name: str) -> dict:
    """Where a frame comes from, as the sample says: {platform, videoId, t}, each from the frame's
    own record when it has one and else from its asset (`t` only ever from the frame)."""
    record = next((f for f in asset.get("frames") or [] if isinstance(f, dict) and f.get("name") == name), {})
    return {"platform": record.get("platform", asset.get("platform")),
            "videoId": record.get("videoId", asset.get("videoId")),
            "t": record.get("t")}


def manifest_box(t: dict, set_mode: str, frame_w: float, frame_h: float) -> tuple:
    """(box, None) for a target as a manifest box, or (None, why) when the format cannot hold it."""
    corners = t.get("corners")
    if t.get("pending"):
        return None, "a model's proposal nobody reviewed"
    try:
        quad = [[float(p[0]), float(p[1])] for p in corners]
    except (TypeError, ValueError, IndexError):
        return None, "no corners"
    if len(quad) != 4 or not all(math.isfinite(v) for p in quad for v in p):
        return None, "no corners"
    kind = KIND_OF.get(t.get("outcome") or "card")
    if kind is None:
        return None, f"outcome {t.get('outcome')!r}"
    if lc.signed_area(quad) < 0:  # the same corners clockwise, the first corner kept first
        quad = [quad[0], quad[3], quad[2], quad[1]]
    if not lc.is_convex(quad):
        return None, "an outline that is not convex"
    if min(math.hypot(quad[(i + 1) % 4][0] - quad[i][0], quad[(i + 1) % 4][1] - quad[i][1]) for i in range(4)) < 1.0:
        return None, "an edge shorter than one pixel"
    x, y, w, h = lc.corners_aabb(quad)
    if x >= frame_w or y >= frame_h or x + w <= 0 or y + h <= 0:
        return None, "an outline wholly off the frame"
    fractions = [[round(px / frame_w, 6), round(py / frame_h, 6)] for px, py in quad]
    if not all(QUAD_RANGE[0] <= v <= QUAD_RANGE[1] for p in fractions for v in p):
        return None, "a corner too far outside the frame"
    ignore = bool(t.get("ignore"))
    box = {}
    if isinstance(t.get("id"), str) and _LABEL_ID.fullmatch(t["id"]):
        box["id"] = t["id"]
    # a box set's boxes are rectangles, except one whose corners were freed (cornerSource hand) and
    # no longer form one; elsewhere only a box drawn as a box is
    freed = t.get("cornerSource") == lc.BOX_QUAD_SOURCE and not lc.is_rectangle_box(quad)
    rectangle = (set_mode == "box" and not freed) or t.get("cornerSource") == "box"
    box.update(kind=kind, ignore=ignore, quad=fractions,
               # the corner order says which way up a card face lies; for anything else it says nothing
               oriented=kind == "face" and not ignore,
               shape="rotated-box" if rectangle else "quad")
    if kind == "face":
        identity = t.get("identity")
        if identity == "unknown":
            box.update(card_id=None, identity="unknown")
        elif isinstance(identity, str) and identity:
            printing = t.get("printing")
            box.update(card_id=printing if isinstance(printing, str) and printing else identity, identity="named")
        else:
            box.update(card_id=None, identity="unlabeled")
        box["readable"] = READABLE_OF.get(t.get("eligible"))
    origin = ORIGIN_OF.get(t.get("labelSource"))
    if origin:
        box["origin"] = origin
    share = (t.get("conditions") or {}).get("visibleShare") if isinstance(t.get("conditions"), dict) else None
    if share in lc.VISIBLE_SHARE:
        box["attributes"] = {"visible_share": share}
    return box, None


# ---- the frame fingerprint, for PNG frames ----
#
# data/SCHEMA.md defines the fingerprint: gray = round(0.299 R + 0.587 G + 0.114 B) per pixel
# (halves to the even number), the mean gray of each cell of a 9 x 8 grid, and one bit per pair
# of neighboring cells in a row. Whole numbers and one division per cell: the standard library
# computes exactly the bits the reference code does, given the same pixels. A PNG file stores
# its pixels exactly, so those can be had without an image library; a JPEG file's cannot.

def _png_rows(data: bytes):
    """(width, height, color type, palette, rows) of an 8-bit PNG that is not interlaced: each
    row its unfiltered bytes. None for any other file."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    at, header, palette, packed = 8, None, b"", []
    while at + 8 <= len(data):
        length, tag = struct.unpack(">I4s", data[at:at + 8])
        body = data[at + 8:at + 8 + length]
        at += 12 + length
        if tag == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif tag == b"PLTE":
            palette = body
        elif tag == b"IDAT":
            packed.append(body)
        elif tag == b"IEND":
            break
    if header is None:
        return None
    width, height, depth, color, _compression, _filter, interlace = header
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
    if depth != 8 or interlace != 0 or channels is None or width < 1 or height < 1 or (color == 3 and not palette):
        return None
    try:
        raw = zlib.decompress(b"".join(packed))
    except zlib.error:
        return None
    stride = width * channels
    if len(raw) < height * (stride + 1):
        return None
    rows, previous = [], bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        method, row = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        if method == 1:    # each byte is stored less the byte one pixel to its left
            for i in range(channels, stride):
                row[i] = (row[i] + row[i - channels]) & 255
        elif method == 2:  # less the byte above
            row = bytearray((a + b) & 255 for a, b in zip(row, previous))
        elif method == 3:  # less the mean of the two
            for i in range(stride):
                left = row[i - channels] if i >= channels else 0
                row[i] = (row[i] + ((left + previous[i]) >> 1)) & 255
        elif method == 4:  # less whichever of left, above and upper-left is nearest left + above - upper-left
            for i in range(stride):
                left = row[i - channels] if i >= channels else 0
                up = previous[i]
                corner = previous[i - channels] if i >= channels else 0
                guess = left + up - corner
                da, db, dc = abs(guess - left), abs(guess - up), abs(guess - corner)
                row[i] = (row[i] + (left if da <= db and da <= dc else up if db <= dc else corner)) & 255
        elif method != 0:
            return None
        rows.append(row)
        previous = row
    return width, height, color, palette, rows


def _cells(size: int, count: int) -> list:
    """[(cell, first, end)]: the pixels first..end-1 of a side `size` long lie in that cell of
    `count`: pixel i in cell min(count - 1, count * i // size)."""
    spans, first = [], 0
    for i in range(1, size + 1):
        if i == size or min(count - 1, count * i // size) != min(count - 1, count * first // size):
            spans.append((min(count - 1, count * first // size), first, i))
            first = i
    return spans


def png_dhash(path) -> str | None:
    """The frame fingerprint of a PNG file as 16 lower-case hexadecimal digits, or None when the
    file is not an 8-bit PNG this reads (a JPEG, a 16-bit or interlaced PNG, a damaged file).
    An alpha channel is dropped, not blended, and a palette is looked up."""
    try:
        decoded = _png_rows(Path(path).read_bytes())
    except OSError:
        return None
    if decoded is None:
        return None
    width, height, color, palette, rows = decoded
    red, green, blue = ([weight * v for v in range(256)] for weight in (0.299, 0.587, 0.114))
    if color == 3:  # a palette index stands for the palette's color
        entries = len(palette) // 3
        tables = [bytes(palette[3 * i + c] if i < entries else 0 for i in range(256)) for c in range(3)]
    columns = _cells(width, GRID_COLUMNS)
    sums = [[0] * GRID_COLUMNS for _ in range(GRID_ROWS)]
    counts = [[0] * GRID_COLUMNS for _ in range(GRID_ROWS)]
    for cell_row, first, end in _cells(height, GRID_ROWS):
        for row in rows[first:end]:
            if color == 2:
                r, g, b = row[0::3], row[1::3], row[2::3]
            elif color == 6:
                r, g, b = row[0::4], row[1::4], row[2::4]
            elif color == 3:
                r, g, b = (row.translate(table) for table in tables)
            else:  # gray, with or without alpha
                r = g = b = row if color == 0 else row[0::2]
            gray = [round(red[x] + green[y] + blue[z]) for x, y, z in zip(r, g, b)]
            for cell, x0, x1 in columns:
                sums[cell_row][cell] += sum(gray[x0:x1])
                counts[cell_row][cell] += x1 - x0
    value = 0
    for cell_row in range(GRID_ROWS):
        means = [sums[cell_row][c] / counts[cell_row][c] if counts[cell_row][c] else 0.0 for c in range(GRID_COLUMNS)]
        for c in range(GRID_COLUMNS - 1):
            value = (value << 1) | (1 if means[c + 1] > means[c] else 0)
    return f"{value:016x}"


def frames_folder(asset: dict, sample_path, frames_dir=None) -> Path:
    """Where an asset's frame files are: its own `framesDir` (absolute, or relative to the
    sample file), else <frames dir>/<asset id>, the frames dir being `frames/` beside the
    sample unless given. The same rule as the server's."""
    sample_path = Path(sample_path)
    if asset.get("framesDir"):
        p = Path(asset["framesDir"]).expanduser()
        return p if p.is_absolute() else (sample_path.parent / p).resolve()
    root = Path(frames_dir).expanduser().resolve() if frames_dir else sample_path.parent / "frames"
    return root / str(asset.get("assetId"))


def _choice(mapping: dict, set_id: str):
    return mapping.get(set_id, mapping.get("*"))


class ManifestRefused(SystemExit):
    """The manifest cannot be written. A SystemExit, so that the command line ends in its
    sentences as before; `problems` holds them again as [{"code", "where", "text"}], so that a
    page can say what to fill in for each (serve.py, hubstate.js). The codes:

    credit           the credit is missing or not one short line
    no-asset         a set labels a video the sample does not list
    source-type      no source type: neither --source-type nor the recording's tags give one
    bad-source-type  a source type that is not physical or digital with an optional /detail
    address          a frame's video is not known: no platform and video id in the sample
    time-size        a frame has no time, or no size in whole pixels
    group            a group of the wrong form
    group-conflict   one video in two groups
    card-id          a card id the manifest cannot hold
    same-frame       two sets label the same frame of a video in ways that cannot be one row
    """

    def __init__(self, problems: list):
        self.problems = problems
        super().__init__("cannot write the manifest:\n" + "\n".join(f"  {p['text']}" for p in problems)
                         if len(problems) != 1 or problems[0]["code"] != "credit" else problems[0]["text"])


def _problem(code: str, where: str, text: str) -> dict:
    return {"code": code, "where": where, "text": text}


def _position(value) -> float | None:
    """A point's coordinate, a fraction of the frame, or None when it is not one."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0.0 <= value <= 1.0:
        return None
    return round(float(value), 6)


def _face(point: dict, identity, printing, readable) -> None:
    """The identity fields of a face (`identity` the stored answer: a card id, "unknown" or None)."""
    if identity == "unknown":
        point.update(card_id=None, identity="unknown", readable=READABLE_OF.get(readable))
    elif isinstance(identity, str) and identity:
        point.update(card_id=printing if isinstance(printing, str) and printing else identity, identity="named",
                     readable=READABLE_OF.get(readable))
    else:
        point.update(card_id=None, identity="unlabeled", readable=None)


def center_answer_stale(c: dict, meta: dict) -> bool:
    """Check names' answer to a center no longer holds: the center moved since, or it was given
    for another run of the proposals than the set's last (meta.verify)."""
    if lc.answer_stale(c, None):
        return True
    runs = (meta.get("verify") or {}).get("armsManifestSha256") if isinstance(meta.get("verify"), dict) else None
    at = c.get("verifiedAt") if isinstance(c.get("verifiedAt"), dict) else {}
    return bool(c.get("verifiedBy")) and isinstance(runs, list) and bool(runs) and at.get("armsManifestSha256") not in runs


def center_point(c: dict, meta: dict) -> tuple:
    """(point, unanswered) for one center of a confirmed census, or (None, why) when the format
    cannot hold it. `unanswered`: a face without a checked name (written as unlabeled)."""
    x, y = _position(c.get("x")), _position(c.get("y"))
    if x is None or y is None:
        return None, "a position outside the frame"
    point = {"x": x, "y": y}
    if isinstance(c.get("id"), str) and _LABEL_ID.fullmatch(c["id"]):
        point["id"] = c["id"]
    answered = lc.answer_complete(c) and not center_answer_stale(c, meta)
    correction = c.get("correction") if answered else None
    unanswered = False
    if correction in ("not-card", "back"):
        point["kind"] = correction
    elif c.get("kind") == "back":
        point["kind"] = "back"
    elif c.get("kind") == "face":
        point["kind"] = "face"
        _face(point, c.get("identity") if answered else None, c.get("printing"), c.get("eligible"))
        unanswered = point["identity"] == "unlabeled"
        if not unanswered:
            point["attributes"] = {READABLE_FROM: "crop", **({"blind": True} if c.get("blind") is True else {})}
    else:
        return None, f"kind {c.get('kind')!r}"
    point["origin"] = "center"
    return point, unanswered


def seeded_point(p: dict) -> tuple:
    """(point, None) for one answered point of a point set, or (None, why)."""
    x, y = _position(p.get("x")), _position(p.get("y"))
    if x is None or y is None:
        return None, "a position outside the frame"
    kind = KIND_OF.get(p.get("outcome")) if p.get("outcome") else None
    if kind is None:
        return None, "no answer"
    point = {"x": x, "y": y, "kind": kind}
    if isinstance(p.get("i"), int) and not isinstance(p.get("i"), bool):
        point["id"] = f"P{p['i']:03d}"
    if kind == "face":
        _face(point, p.get("identity"), p.get("printing"), p.get("eligible"))
    point["origin"] = "seeded"
    return point, None


READABLE_FROM = "readable_from"  # the attribute that says what `readable` was judged from (a key of the manifest's form)


def _frame_points(set_mode: str, meta: dict, fr: dict, tally: dict) -> tuple:
    """(points, left out) of one confirmed frame of a center or point set."""
    points, bad = [], []
    if set_mode == "center":
        for c in fr.get("centers") or []:
            if not isinstance(c, dict):
                continue
            point, why = center_point(c, meta)
            if point is None:
                bad.append(f"{c.get('id')} ({why})")
                continue
            tally["unanswered"] += bool(why)
            points.append(point)
    else:
        for p in fr.get("points") or []:
            if not isinstance(p, dict):
                continue
            point, why = seeded_point(p)
            if point is None:
                if why == "no answer":
                    tally["unanswered-points"] += 1
                else:
                    bad.append(f"P{p.get('i')} ({why})")
                continue
            points.append(point)
    return points, bad


def manifest_rows(sets: list, sample: dict, credit: str, groups=None, source_types=None,
                  fingerprints=None) -> tuple:
    """(rows, notes) for `sets` ([(set id, meta, frame rows)], as `read_sets` returns them).

    `sample`: {asset id: asset} (`read_sample`). `groups` and `source_types`: {set id or "*":
    value}. `fingerprints`: a function (asset, frame name) -> fingerprint or None, or None to
    write none. Raises ManifestRefused (a SystemExit), listing every problem, when a row cannot
    be addressed (no platform or video id, no source type, a malformed group) or two rows name
    the same frame in ways that cannot be one row."""
    groups, source_types = groups or {}, source_types or {}
    problem = credit_error(credit)
    if problem:
        raise ManifestRefused([_problem("credit", "", problem)])
    rows, notes, errors = [], [], []
    seen, group_of_video = {}, {}
    for set_id, meta, frames in sets:
        if meta.get("repeatOf"):
            notes.append(f"{set_id}: a repeat set, skipped (its frames are another set's)")
            continue
        set_mode = meta.get("mode")
        asset_id = meta.get("frameAsset") or set_id
        asset = sample.get(asset_id)
        if asset is None:
            errors.append(_problem("no-asset", set_id, f"{set_id}: the sample has no asset {asset_id!r}, so its video is not known"))
            continue
        source_type = _choice(source_types, set_id) or recording_source_type(meta)
        if not source_type or not _SOURCE_TYPE.fullmatch(source_type):
            errors.append(_problem("bad-source-type" if source_type else "source-type", set_id, f"{set_id}: " + (
                f"source type {source_type!r} is not physical or digital with an optional /detail"
                if source_type else "no source type: tag the recording's source in the tool, or pass --source-type")))
            continue
        confirmed = [fr for fr in sorted(frames, key=lambda r: (r.get("t") or 0, r.get("name") or "")) if fr.get("done")]
        if len(confirmed) < len(frames):
            notes.append(f"{set_id}: {len(frames) - len(confirmed)} frame(s) not confirmed, left out")
        tally = {"empty": 0, "unanswered": 0, "unanswered-points": 0}
        for fr in confirmed:
            name = fr.get("name")
            where = f"{set_id}/{name}"
            address = frame_address(asset, name)
            platform, video_id = address["platform"], address["videoId"]
            if platform not in MANIFEST_PLATFORMS or not isinstance(video_id, str) or not _VIDEO_ID[platform].fullmatch(video_id):
                errors.append(_problem("address", where, f"{where}: the sample must give \"platform\" ({', '.join(MANIFEST_PLATFORMS[:-1])} or "
                                       f"{MANIFEST_PLATFORMS[-1]}) and a \"videoId\" of that platform's form, on the frame or its "
                                       f"asset; got {platform!r}, {video_id!r}"))
                continue
            t = address["t"] if address["t"] is not None else fr.get("t")
            frame_w, frame_h = fr.get("frameW"), fr.get("frameH")
            sized = all(isinstance(v, (int, float)) and not isinstance(v, bool) and v == int(v) and 16 <= v <= 16384
                        for v in (frame_w, frame_h))
            if not isinstance(t, (int, float)) or isinstance(t, bool) or not math.isfinite(t) or t < 0 or not sized:
                errors.append(_problem("time-size", where, f"{where}: needs a time t of 0 or more and a frame size in whole pixels"))
                continue
            group = _choice(groups, set_id) or default_group(platform, video_id)
            if not _GROUP.fullmatch(group):
                errors.append(_problem("group", set_id, f"{set_id}: group {group!r} must be 2 to 40 lower-case letters, digits and hyphens"))
                break
            if group_of_video.setdefault((platform, video_id), group) != group:
                errors.append(_problem("group-conflict", where, f"{where}: video {video_id} is in group {group_of_video[(platform, video_id)]!r} "
                                       f"and in {group!r}; a video belongs to one group"))
                break
            if set_mode in POINT_SET_MODES:
                points, bad = _frame_points(set_mode, meta, fr, tally)
                if bad:
                    notes.append(f"{where}: left out, the manifest cannot hold {', '.join(bad)}")
                    continue
                if not points:
                    tally["empty"] += 1
                    continue
                labels = {"completeness": "points", "points": points}
            else:
                boxes, bad = [], []
                for target in fr.get("targets") or []:
                    box, why = manifest_box(target, meta.get("mode"), frame_w, frame_h)
                    if box is not None and box.get("card_id") is not None and lc.card_id_error(box["card_id"]):
                        errors.append(_problem("card-id", where, f"{where}: box {target.get('id')}: {lc.card_id_error(box['card_id'])}"))
                    elif box is None:
                        bad.append(f"{target.get('id')} ({why})")
                    elif any(box["quad"] == other["quad"] for other in boxes):
                        bad.append(f"{target.get('id')} (the same outline as another box)")
                    else:
                        boxes.append(box)
                if bad:
                    notes.append(f"{where}: left out, the manifest cannot hold {', '.join(bad)}")
                    continue
                labels = {"completeness": "exhaustive-boxes", "boxes": boxes}
            for point in labels.get("points") or []:
                if point.get("card_id") is not None and lc.card_id_error(point["card_id"]):
                    errors.append(_problem("card-id", where, f"{where}: point {point.get('id')}: {lc.card_id_error(point['card_id'])}"))
            key = (platform, video_id, round(float(t), 3))
            if key in seen:
                other_where, other = seen[key]
                if not _merge_points(other, labels, source_type, int(frame_w), int(frame_h)):
                    errors.append(_problem("same-frame", where, f"{where}: the same video and time as {other_where}; export one of the two sets (--set)"))
                continue
            row = {"manifest_version": MANIFEST_VERSION, "platform": platform, "video_id": video_id, "t": key[2],
                   "frame_width": int(frame_w), "frame_height": int(frame_h), "source_type": source_type,
                   "group": group, "role": "extra", "trained_on": False, "completeness": labels["completeness"],
                   "credit": credit, "reachable": None, "reachable_checked": None,
                   "prefill_offered": bool(fr.get("prefillOffered") or any("prefill" in x for x in fr.get("targets") or []))}
            seen[key] = (where, row)
            fingerprint = fingerprints(asset, name) if fingerprints else None
            if fingerprint:
                row["attributes"] = {"frame_dhash": fingerprint}
            if "boxes" in labels:
                row["boxes"] = labels["boxes"]
            else:
                row["points"] = labels["points"]
            rows.append(row)
        if tally["empty"]:
            notes.append(f"{set_id}: {tally['empty']} frame(s) confirmed empty, not exportable as points")
        if tally["unanswered"]:
            notes.append(f"{set_id}: {tally['unanswered']} face(s) without a checked name (not answered in full, or stale), written as unlabeled")
        if tally["unanswered-points"]:
            notes.append(f"{set_id}: {tally['unanswered-points']} point(s) without an answer, left out")
    if errors:
        raise ManifestRefused(errors)
    return rows, notes


def _merge_points(row: dict, labels: dict, source_type: str, width: int, height: int) -> bool:
    """Put the points of a second set into a row of the same frame: only points into points,
    on a frame of the same size and kind of footage, with no id or position twice. False (the
    row unchanged) when they cannot be one row."""
    if row.get("completeness") != "points" or labels.get("completeness") != "points":
        return False
    if (row["source_type"], row["frame_width"], row["frame_height"]) != (source_type, width, height):
        return False
    ids = {p.get("id") for p in row["points"] if p.get("id")}
    places = {(p["x"], p["y"]) for p in row["points"]}
    new = labels["points"]
    if any(p.get("id") in ids for p in new if p.get("id")) or any((p["x"], p["y"]) in places for p in new):
        return False
    row["points"] = row["points"] + new
    return True


def export_manifest(sets: list, out: Path, sample: dict, credit: str, groups=None, source_types=None,
                    fingerprints=None) -> tuple:
    """Write `sets` to `out` in the public label-manifest format, one row per line.
    Returns (rows, notes); see `manifest_rows` for the arguments. Nothing is written when there
    is no row to write."""
    rows, notes = manifest_rows(sets, sample, credit, groups, source_types, fingerprints)
    if rows:
        out = Path(out)
        out.parent.mkdir(parents=True, exist_ok=True)
        write_text_atomic(out, "".join(json.dumps(row, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
                                       for row in rows))
    return rows, notes


def _set_values(values, flag: str) -> dict:
    """[SET=]VALUE arguments as {set id or "*": value}."""
    out = {}
    for value in values or []:
        key, sep, rest = value.partition("=")
        key, rest = (key, rest) if sep else ("*", value)
        if not key or not rest:
            raise SystemExit(f"{flag} takes [SET=]VALUE, not {value!r}")
        out[key] = rest
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="format", required=True)
    for name, text in (("coco", "a COCO-style detection file of the boxes"),
                       ("manifest", "the repository's public label-manifest format, one row per confirmed frame")):
        sp = sub.add_parser(name, help=text)
        if name == "coco":
            sp.add_argument("--labels-dir", required=True, help="the labels root (the server's --labels-dir)")
        else:
            sp.add_argument("--labels-dir", required=True, action="append",
                            help="the labels root (the server's --labels-dir); repeat it to put the sets of two folders in one file")
        sp.add_argument("--out", required=True, help="the file to write (refused if it exists, unless --force)")
        sp.add_argument("--set", action="append", default=None, help="a label set to export (repeatable; default: every box set)")
        sp.add_argument("--role", action="append", choices=lc.ROLES, default=None, help="only sets of this role (repeatable)")
        sp.add_argument("--force", action="store_true", help="overwrite an existing file")
        if name == "coco":
            sp.add_argument("--include-unconfirmed", action="store_true", help="also frames that were never confirmed")
            sp.add_argument("--catalog", default=None, help="the catalog, to write each card's name beside its id")
            continue
        sp.add_argument("--sample", required=True,
                        help="the sample file the sets were labeled from; its frames or assets carry \"platform\" and \"videoId\"")
        sp.add_argument("--credit", required=True, help="the credit to show for these labels (1 to 80 characters)")
        sp.add_argument("--group", action="append", metavar="[SET=]ID", default=None,
                        help="the recording group of a set's video, or of every set (repeatable; default: one group per video)")
        sp.add_argument("--source-type", action="append", metavar="[SET=]TYPE", default=None,
                        help="the kind of footage, such as physical/webcam or digital (repeatable; default: the set's recording tags)")
        sp.add_argument("--frames-dir", default=None,
                        help="frames as <DIR>/<asset id>/<frame name>, to fingerprint them (default: frames/ beside the sample)")
        sp.add_argument("--no-fingerprint", action="store_true", help="write no frame fingerprint")
        sp.add_argument("--catalog", default=None, help="the catalog, to list card ids it does not hold")
    a = p.parse_args(argv)
    out = Path(a.out).expanduser().resolve()
    if out.exists() and not a.force:
        raise SystemExit(f"{out} exists (use --force)")
    if a.format == "manifest" and out.suffix != ".jsonl":
        raise SystemExit("--out: a manifest file's name ends in .jsonl")
    if a.format == "manifest":
        sets, notes = read_manifest_sets([Path(d).expanduser().resolve() for d in a.labels_dir], a.set, a.role)
        notes_read = notes
    else:
        sets, notes = read_sets(Path(a.labels_dir).expanduser().resolve(), a.set, a.role)
    for note in notes:
        print(note)
    if not sets:
        raise SystemExit("no box, corner or training set to export" if a.format == "coco"
                         else "no box, corner, training, center or point set to export")
    names = card_names(a.catalog)
    if a.format == "manifest":
        sample_path = Path(a.sample).expanduser().resolve()
        fingerprints = None if a.no_fingerprint else (
            lambda asset, name: png_dhash(frames_folder(asset, sample_path, a.frames_dir) / name))
        rows, notes = export_manifest(sets, out, read_sample(sample_path), a.credit, _set_values(a.group, "--group"),
                                      _set_values(a.source_type, "--source-type"), fingerprints)
        for note in notes:
            print(note)
        if not rows:
            raise SystemExit("no confirmed frame to write")
        boxes = [box for row in rows for box in row.get("boxes") or []]
        points = [point for row in rows for point in row.get("points") or []]
        marked = sum(1 for row in rows if "attributes" in row)
        print(f"wrote {out}: {len(rows)} rows, {len(boxes)} boxes, " + (f"{len(points)} points, " if points else "")
              + f"{marked} rows with a frame fingerprint" + (f", {removed_words(notes_read.removed)}" if notes_read.removed else ""))
        if marked < len(rows) and not a.no_fingerprint:
            print(f"  {len(rows) - marked} row(s) have no fingerprint: only 8-bit PNG frames can be fingerprinted here")
        if names:
            unknown = sorted({box["card_id"] for box in boxes + points if box.get("card_id") and box["card_id"] not in names})
            if unknown:
                print(f"  not in the catalog: {', '.join(unknown)}")
        if any(row["platform"] == "local" for row in rows):
            # Rows of a recording of your own are for your own use; the offer check refuses them.
            print(f"check it: cardvision validate-manifest {out}")
            print("  rows of your own recordings (platform local) cannot be offered: nobody else can obtain the video")
        else:
            print(f"check it: cardvision validate-manifest {out} --contribution")
        return 0
    doc = to_coco(sets, names, a.include_unconfirmed)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    crowd = sum(1 for x in doc["annotations"] if x["iscrowd"])
    print(f"wrote {out}: {len(doc['images'])} images, {len(doc['annotations'])} boxes ({crowd} ignored) from {len(sets)} sets")
    return 0


if __name__ == "__main__":
    sys.exit(main())
