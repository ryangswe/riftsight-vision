# SPDX-License-Identifier: Apache-2.0
"""Pure helpers for the labeling tool. No I/O beyond what the caller passes in, no model,
standard library only. Shared by serve.py, the export, repeat and report scripts and the tests.

Contents:
- the seeded point generator for point mode (content-independent by construction: its only
  inputs are the frame index, the seed and K);
- corner-target geometry (bounding box, projected short side, in-plane rotation,
  foreshortening) for corner and training mode;
- the enumerations of the label format and the validation of a frame row (FORMAT.md);
- what a sample lists (`sample_assets`): one rule for the server, the project screen and the
  export (labelfiles.py reads the files with it);
- mode and role rules, and deck-list parsing;
- box mode: a box is four corners with `cornerSource: box`, so a box set shares the corner
  format and a later pass can refine a box into corners. A box may be rotated, so the check is
  "a rectangle" (right angles within a small tolerance); a rotated box also stores its `angle`
  and a box may carry `zOrder`. The identity pass's walk and its geometry guard: which edge of a
  box is the card's top may change there, nothing else;
- box-mode prefill: box mode on a role=training set may take a model's boxes as pending boxes
  the labeler accepts, corrects or rejects (`cornerSource` prefill / prefill-edited,
  `labelSource` prefill-accepted / prefill-corrected); never in development or test sets;
- center mode (a "center census"): the labeler clicks the center of every card face and every
  card back; a frame row carries `centers: [{id, x, y, kind}]` (x/y normalized to [0, 1], kind
  face | back) and `centerSeq` (the last id number issued on the frame, so an id is never
  reused). Development and test sets only; never prefill, never any model output. The later
  verify pass adds per-center answers (CENTER_VERIFY_KEYS): center mode never writes them and
  keeps them as they are;
- verify mode (the naming pass of a center census): a pass over a center set that names every
  FACE center, crop first, then the proposals of one or two model "arms" (named on the command
  line), except a blind subsample that is named with no proposals. Answers only (`identity`,
  `printing`, `eligible`, `verifiedBy`, `blind`, `verifiedAt`, `correction`), never a center's
  x/y/id/kind or the frame's centerSeq. Helpers here: the answer contract (validation), the
  geometry guard and merge for a verify save, the arms' proposals (which of an arm's boxes a
  center falls in), the blind subsample (several shapes, anything ambiguous refused) and the
  stale rule.
  Readability first: `eligible` (readable from this frame alone, y / m / n) is answered from
  the crop BEFORE any proposal is shown, so that seeing a proposal cannot change which cards
  count as readable. The server stamps `readabilityAt` {x, y, at} when it stores it and
  `revealedAt` when it releases a center's proposals (only once a readability is stored); both
  are server-owned. A named or Unknown answer needs a readability stamped no later than the
  reveal, and a readability is fixed once the proposals have been shown. An answer that carries
  neither stamp (written by another tool) stays valid as it is.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import math
import re

SCHEMA_VERSION = 2

MODES = ("point", "corner", "training", "box", "identify", "center", "verify")
# the mode a label set is stored with (identify is a pass over a box/corner/training set, verify a
# pass over a center set: never set modes)
SET_MODES = ("point", "corner", "training", "box", "center")
IDENTIFY_SET_MODES = ("box", "corner", "training")
# The role of a label set says what its labels are for, and so what may be shown while labeling:
# training labels may start from a model's output (prefill); development and test labels are
# what models are measured on, so no model output is shown there (verify mode's reveal is the
# one, controlled exception, development only).
ROLES = ("development", "test", "training")
# center mode: evaluation frames only, never training (no prefill there either)
CENTER_ROLES = ("development", "test")
CENTER_KINDS = ("face", "back")
CENTER_ID = re.compile(r"^C(\d{3,})$")  # C001, C002, … per frame, never reused
# the verify pass's per-center answers; center mode never writes them
CENTER_VERIFY_KEYS = ("identity", "printing", "eligible", "verifiedBy", "blind", "verifiedAt", "correction",
                      "readabilityAt", "revealedAt")
# readability first: stamped by the server, never taken from the page
VERIFY_SERVER_KEYS = ("readabilityAt", "revealedAt")
# a readability answered before any name: the only answer fields a center may carry without verifiedBy
PENDING_KEYS = ("eligible", "blind", "readabilityAt", "revealedAt")
# verify mode: a pass over a center set, development only when proposals are shown (proposals are
# model output: never on a test set; never on training sets, which a census does not have)
VERIFY_ROLES = ("development",)
# a test center set may be named only blind: verify --all-blind, never with arms, a blind file or
# a reveal
VERIFY_ALL_BLIND_ROLES = ("development", "test")
# The arms of a verify run are named on the command line (--arm NAME=FILE, one or two). An accept
# is recorded as `accept-<arm name>`, or `accept-both` when two arms showed the same name.
ARM_NAME = re.compile(r"^[a-z][a-z0-9_]{0,23}$")
MAX_ARMS = 2
ACCEPT_PREFIX = "accept-"
ACCEPT_BOTH = "accept-both"
CORRECTIONS = ("not-card", "back")  # recorded as `correction`, never by changing `kind`
VERIFY_XY_TOL = 1e-6  # x/y are stored to 1e-6; a marker move is at least a pixel (> 5e-4)

OUTCOMES = ("card", "card-back", "not-card", "unreadable")
IDENTITY_SOURCES = ("current-frame", "later-close-up", "decklist", "other")
ELIGIBLE = ("yes", "no", "uncertain")
VISIBLE_SHARE = ("full", "most", "half", "little")
BOOL_CONDITIONS = ("faceUp", "blur", "glare", "sleeveOrFoil")
LABEL_SOURCES = ("manual", "prefill-accepted", "prefill-corrected", "propagated", "propagated-corrected",
                 "carried", "carried-corrected")
PROPAGATED_SOURCES = ("propagated", "propagated-corrected")
# carried = the labeler's own confirmed boxes copied to the next frame by the page (carry-over),
# reviewed on the frame's confirmation; allowed in every role but test.
# propagated = boxes written by a tracking script outside this tool (none ships with it): training
# sets only.
CARRIED_SOURCES = ("carried", "carried-corrected")
CORNER_SOURCES = ("hand", "snap", "snap-edited", "prefill", "prefill-edited", "box", "propagated", "carried")
PREFILL_LABEL_SOURCES = ("prefill-accepted", "prefill-corrected")
PREFILL_CORNER_SOURCES = ("prefill", "prefill-edited")
# the corner sources a box-mode target may have (prefill ones only where prefill is allowed)
BOX_CORNER_SOURCES = ("box", "propagated", "carried") + PREFILL_CORNER_SOURCES
# a box-mode target whose corners were freed in the Boxes pass (a quad: boxgeom.js isQuad) has
# hand-placed corners: any convex, clockwise outline, not only a rectangle
BOX_QUAD_SOURCE = "hand"

RECORDING_ENUMS = {
    "source": ("digital", "physical"),
    "physicalGroup": ("tournament", "webcam", "phone"),
    "cameraAngle": ("overhead", "oblique"),
    "stability": ("steady", "some-motion", "moving"),
    "lighting": ("even", "uneven", "low"),
    "upscaled": ("yes", "no", "unknown"),
}
RECORDING_FREE = ("sourceResolution", "language", "client")  # e.g. "1080p" / "1920x1080"; "en"; the digital client's name

ID_SAFE = re.compile(r"^[A-Za-z0-9_-]+$")  # set ids, video ids
# The rules a catalog may state for which of its entries are one card ("which entries of a
# catalog are one card", below).
IDENTITY_NAME = "name"
IDENTITY_PRINTING = "printing"
IDENTITY_RULES = (IDENTITY_NAME, IDENTITY_PRINTING)
# A card id is whatever its catalog calls the card: 1 to 64 characters with no space or other
# whitespace and no control character anywhere in it. This mirrors the rule for `card_id` in the
# manifest format (data/SCHEMA.md), which this standalone tool restates rather than imports.
CARD_ID_PATTERN = r"^[^\s\u0000-\u001f\u007f-\u009f\ufeff]+$"
CARD_ID_MAX = 64
CARD_ID = re.compile(CARD_ID_PATTERN)
# a frame's file name (never a path): letters, digits, _ - and . , ending .jpg, .jpeg or .png
FRAME_NAME = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(jpg|jpeg|png)$", re.IGNORECASE)


def sample_assets(doc) -> list | None:
    """What a sample lists, as every part of the tool reads it (the project screen, the labeling
    page, the export): the videos (`assets`) that have a usable id, each with the frames that
    have a usable name; None when `doc` is no sample (not an object with a list of `assets`).
    An entry that is no video with such an id, and a frame that is no object with such a name,
    is left out: no route of the server would show or save it. A video listed twice is listed
    once, as its last entry. Every other key of a video and of a frame is kept as the file has it."""
    if not isinstance(doc, dict) or not isinstance(doc.get("assets"), list):
        return None
    out = {}
    for a in doc["assets"]:
        if not isinstance(a, dict) or not isinstance(a.get("assetId"), str) or not ID_SAFE.fullmatch(a["assetId"]):
            continue
        frames = a.get("frames")
        entry = {**a, "frames": [f for f in (frames if isinstance(frames, list) else [])
                                 if isinstance(f, dict) and isinstance(f.get("name"), str) and FRAME_NAME.fullmatch(f["name"])]}
        for key in SOURCE_FIELDS:
            if key in entry and not source_field_ok(key, entry[key]):
                del entry[key]
        out[a["assetId"]] = entry
    return list(out.values())


# What a sample may say about a video, all optional, shown on the labeling page under "About
# this recording" with a link to the video at the frame's time: its `title`, its `uploadDate`
# (YYYY-MM-DD) and its `language` (a tag such as `en` or `pt-BR`). A value not of its form is
# left out of the entry (`sample_assets`); the rest of the entry is kept. Nothing is fetched.
SOURCE_FIELDS = ("title", "uploadDate", "language")
TITLE_MAX = 300
LANGUAGE_TAG = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}")
# characters a title of one plain line never holds: line and paragraph separators, NEL, and the
# bidirectional controls that would reorder what the page shows
TITLE_REFUSED = frozenset("\u0085\u2028\u2029\u200e\u200f\u061c\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")
FIRST_UPLOAD_YEAR = 1990


def source_field_ok(key: str, value, today: datetime.date | None = None) -> bool:
    """Whether `value` is of the form of the sample field `key` (SOURCE_FIELDS). An upload date is
    a real day from FIRST_UPLOAD_YEAR on and not after `today` (the local date) and one day more,
    for a clock that is a little behind."""
    if not isinstance(value, str):
        return False
    if key == "title":
        return 0 < len(value.strip()) <= TITLE_MAX and not any(ord(c) < 32 or ord(c) == 127 or c in TITLE_REFUSED for c in value)
    if key == "uploadDate":
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return False
        try:
            day = datetime.date.fromisoformat(value)
        except ValueError:
            return False
        return day.year >= FIRST_UPLOAD_YEAR and day <= (today or datetime.date.today()) + datetime.timedelta(days=1)
    if key == "language":
        return bool(LANGUAGE_TAG.fullmatch(value))
    return False


def source_unused(doc) -> dict:
    """{asset id: [fields]}: the SOURCE_FIELDS a sample gives in a form `sample_assets` leaves out,
    per video (the last entry of a video listed twice), so the page can say so."""
    out = {}
    for a in (doc.get("assets") if isinstance(doc, dict) and isinstance(doc.get("assets"), list) else []):
        if isinstance(a, dict) and isinstance(a.get("assetId"), str) and ID_SAFE.fullmatch(a["assetId"]):
            out[a["assetId"]] = [k for k in SOURCE_FIELDS if k in a and not source_field_ok(k, a[k])]
    return {k: v for k, v in out.items() if v}


# The standard trading-card size, 63 × 88 mm (upright). A landscape card is the inverse.
CARD_ASPECT = 63.0 / 88.0

DEFAULT_K = 12
DEFAULT_ZOOM = 3.0
POINT_INSET = 0.02  # points stay this fraction of the frame away from each edge
POINT_GENERATOR = "first K points of halton(2,3), Cranley-Patterson shift from sha256('label-points:<seed>:<frameIndex>'), mapped into [inset, 1-inset]"


# ---- point generator (point mode) ---------------------------------------------------------

def _radical_inverse(n: int, base: int) -> float:
    inv, f = 0.0, 1.0 / base
    while n > 0:
        n, digit = divmod(n, base)
        inv += digit * f
        f /= base
    return inv


def _shift(seed: int, index: int) -> tuple:
    h = hashlib.sha256(f"label-points:{int(seed)}:{int(index)}".encode()).digest()
    return (int.from_bytes(h[0:8], "big") / 2**64, int.from_bytes(h[8:16], "big") / 2**64)


def frame_index(name: str, t=None) -> int:
    """The frame index the generator keys on: the digits of an `fNNNNN.<ext>` name (also after a
    prefix, `<video>-fNNNNN.<ext>`, as the inference command names frames), else round(t)."""
    m = re.match(r"^(?:.*[-_.])?f(\d+)\.[A-Za-z]+$", str(name or ""))
    if m:
        return int(m.group(1))
    if t is None:
        raise ValueError(f"no frame index for {name!r}")
    return int(round(float(t)))


def points_for_frame(index: int, seed: int, k: int = DEFAULT_K, inset: float = POINT_INSET) -> list:
    """K pointer positions for one frame, normalized to [0, 1] (x right, y down).

    The first K points of the 2-D Halton sequence (bases 2 and 3), shifted modulo 1 by an
    offset hashed from (seed, frame index) — a Cranley–Patterson rotation, which keeps the set's
    spacing on the torus (min pairwise distance ≈ 0.16 of the frame at K = 12) — then mapped into
    [inset, 1 − inset]. Only (index, seed, k, inset) go in: no image, no size, no label.
    """
    if k < 1:
        raise ValueError("k must be ≥ 1")
    sx, sy = _shift(seed, index)
    span = 1.0 - 2.0 * inset
    out = []
    for j in range(k):
        u = (_radical_inverse(j + 1, 2) + sx) % 1.0
        v = (_radical_inverse(j + 1, 3) + sy) % 1.0
        out.append({"i": j, "x": round(inset + span * u, 6), "y": round(inset + span * v, 6)})
    return out


def point_rule(seed: int, k: int) -> dict:
    return {"generator": POINT_GENERATOR, "seed": int(seed), "k": int(k), "inset": POINT_INSET,
            "frameIndex": "digits of an fNNNNN.<ext> frame name (a <prefix>- before the f allowed), else round(t)"}


# ---- corner geometry (corner / training mode) ----------------------------------------------

def _dist(a, b) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def signed_area(q) -> float:
    """Shoelace area in y-down frame coordinates: > 0 when the corners run clockwise on screen."""
    s = 0.0
    for i in range(4):
        x0, y0 = q[i]
        x1, y1 = q[(i + 1) % 4]
        s += x0 * y1 - x1 * y0
    return s / 2.0


def is_convex(q) -> bool:
    sign = 0
    for i in range(4):
        ax, ay = q[i]
        bx, by = q[(i + 1) % 4]
        cx, cy = q[(i + 2) % 4]
        z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
        if abs(z) < 1e-9:
            return False
        s = 1 if z > 0 else -1
        if sign == 0:
            sign = s
        elif s != sign:
            return False
    return True


def parse_resolution_height(value) -> int | None:
    """'1080p' → 1080, '1920x1080' → 1080, 720 → 720; anything else → None."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value) if value > 0 else None
    s = str(value).strip().lower()
    m = re.match(r"^(\d{3,4})p$", s)
    if m:
        return int(m.group(1))
    m = re.match(r"^(\d{3,5})\s*[x×]\s*(\d{3,5})$", s)
    if m:
        return int(m.group(2))
    if s.isdigit():
        return int(s)
    return None


def quad_measures(corners, frame_h=None, source_h=None, card_aspect: float = CARD_ASPECT) -> dict:
    """Derived measures of a corner target.

    corners: 4 [x, y] in frame pixels, in the fixed order top-left, top-right, bottom-right,
    bottom-left **of the card's own upright orientation** (so an upside-down card starts at the
    corner that is bottom-right on screen). Returned:

    - aabb [x, y, w, h]: axis-aligned bounding box in frame px;
    - sides {top, right, bottom, left}: edge lengths in frame px (card-relative names);
    - widthPx / heightPx: mean of top+bottom / left+right;
    - shortSidePx: min(widthPx, heightPx), the projected short side in frame px;
    - shortSideSourcePx: the same in the recording's native pixels (× source_h / frame_h) when
      both heights are known (an upscaled 720p frame reports 720p pixels), else null;
    - rotationDeg: in-plane rotation of the card's up vector (bottom-edge midpoint → top-edge
      midpoint) from screen-up, clockwise positive, in (−180, 180]; ≈ 180 for an upside-down card;
    - foreshortening: min of the three parts below (1 = none, smaller = stronger);
      foreshorteningParts {topBottom, leftRight, aspect}: opposite-side length ratios (≤ 1,
      perspective taper) and the card-relative aspect widthPx/heightPx against the card's own
      upright aspect `card_aspect` (63/88 for a portrait card, 88/63 for a landscape card), folded
      to ≤ 1 (compression from an oblique view; the corner order says which side is the width,
      so a half-squashed portrait card reads 0.5, not as a landscape card);
    - cardAspect: the upright aspect used;
    - clockwise (the order runs clockwise on screen, as the convention requires) and convex.
    """
    q = [[float(p[0]), float(p[1])] for p in corners]
    if len(q) != 4:
        raise ValueError("a corner target needs exactly 4 corners")
    xs = [p[0] for p in q]
    ys = [p[1] for p in q]
    top, right, bottom, left = _dist(q[0], q[1]), _dist(q[1], q[2]), _dist(q[2], q[3]), _dist(q[3], q[0])
    width = (top + bottom) / 2.0
    height = (left + right) / 2.0
    short = min(width, height)
    long_ = max(width, height)
    mid_top = ((q[0][0] + q[1][0]) / 2.0, (q[0][1] + q[1][1]) / 2.0)
    mid_bot = ((q[3][0] + q[2][0]) / 2.0, (q[3][1] + q[2][1]) / 2.0)
    ux, uy = mid_top[0] - mid_bot[0], mid_top[1] - mid_bot[1]
    rot = math.degrees(math.atan2(ux, -uy))
    if rot <= -180.0:
        rot += 360.0
    tb = min(top, bottom) / max(top, bottom) if max(top, bottom) > 0 else 0.0
    lr = min(left, right) / max(left, right) if max(left, right) > 0 else 0.0
    a = (width / height) / card_aspect if height > 0 else 0.0
    aspect = min(a, 1.0 / a) if a > 0 else 0.0
    scale = None
    if frame_h and source_h:
        scale = float(source_h) / float(frame_h)
    r = lambda v, n=2: round(v, n)  # noqa: E731
    return {
        "aabb": [r(min(xs), 1), r(min(ys), 1), r(max(xs) - min(xs), 1), r(max(ys) - min(ys), 1)],
        "sides": {"top": r(top, 1), "right": r(right, 1), "bottom": r(bottom, 1), "left": r(left, 1)},
        "widthPx": r(width, 1),
        "heightPx": r(height, 1),
        "shortSidePx": r(short, 1),
        "shortSideSourcePx": r(short * scale, 1) if scale else None,
        "rotationDeg": r(rot, 1),
        "foreshortening": r(min(tb, lr, aspect), 3),
        "foreshorteningParts": {"topBottom": r(tb, 3), "leftRight": r(lr, 3), "aspect": r(aspect, 3)},
        "cardAspect": r(card_aspect, 4),
        "clockwise": signed_area(q) > 0,
        "convex": is_convex(q),
    }


def box_corners(x0, y0, x1, y1) -> list:
    """An axis-aligned box as corners TL, TR, BR, BL on screen (the box-mode target format)."""
    a, b, c, d = min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)
    return [[a, b], [c, b], [c, d], [a, d]]


def is_axis_aligned_box(corners, tol: float = 1e-6) -> bool:
    """Corners TL, TR, BR, BL of an axis-aligned box with positive width and height."""
    try:
        (x0, y0), (x1, y1), (x2, y2), (x3, y3) = [(float(p[0]), float(p[1])) for p in corners]
    except (TypeError, ValueError):
        return False
    return (abs(x0 - x3) <= tol and abs(x1 - x2) <= tol and abs(y0 - y1) <= tol and abs(y2 - y3) <= tol
            and x1 > x0 and y3 > y0)


RECT_TOL = 0.5  # frame px: corners are stored to 0.1 px


def is_rectangle_box(corners, tol: float = RECT_TOL) -> bool:
    """Corners of a (possibly rotated) rectangle, in its own order TL, TR, BR, BL: clockwise on
    screen, every side at least 1 px, a parallelogram (the diagonals bisect each other) with equal
    diagonals, within `tol` px. An axis-aligned box is the angle-0 case. Mirrors boxgeom.js."""
    try:
        q = [(float(p[0]), float(p[1])) for p in corners]
    except (TypeError, ValueError, IndexError):
        return False
    if len(q) != 4 or not all(math.isfinite(v) for p in q for v in p):
        return False
    if signed_area(q) <= 0:
        return False
    if min(_dist(q[i], q[(i + 1) % 4]) for i in range(4)) < 1.0:
        return False
    mx = q[0][0] + q[2][0] - q[1][0] - q[3][0]
    my = q[0][1] + q[2][1] - q[1][1] - q[3][1]
    if math.hypot(mx, my) > tol:
        return False
    return abs(_dist(q[0], q[2]) - _dist(q[1], q[3])) <= tol


def is_box_quad(corners) -> bool:
    """Corners a box with free corners may have (`cornerSource: hand` in a box set): four finite
    [x, y], clockwise on screen, strictly convex, every side at least 1 px (what the export keeps)."""
    try:
        q = [(float(p[0]), float(p[1])) for p in corners]
    except (TypeError, ValueError, IndexError):
        return False
    if len(q) != 4 or not all(math.isfinite(v) for p in q for v in p):
        return False
    if signed_area(q) <= 0 or not is_convex(q):
        return False
    return min(_dist(q[i], q[(i + 1) % 4]) for i in range(4)) >= 1.0


def corners_aabb(corners) -> list:
    """[x, y, w, h] of any four corners."""
    xs = [float(p[0]) for p in corners]
    ys = [float(p[1]) for p in corners]
    return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]


def box_to_corners(box, rot: int = 0) -> list:
    """A prefill box [x, y, w, h] (axis-aligned) as corners TL, TR, BR, BL on screen, with the
    order shifted by `rot` quarter turns (the turn at which the model matched the card) so the first
    corner is the card's upright top-left. The labeler checks the first-corner marker anyway."""
    x, y, w, h = [float(v) for v in box]
    c = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    k = quarter_turns(rot)
    return c[k:] + c[:k]


def quarter_turns(rot) -> int:
    """A prefill box's `rot` as quarter turns (0..3): 0, 1, 2 or 3 is the number of quarter turns
    (what the inference command writes); 90, 180 or 270 is the same in degrees."""
    try:
        r = float(rot or 0)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(r):
        return 0
    return int(round(r)) % 4 if abs(r) < 45 else int(round(r / 90.0)) % 4


# ---- rows ------------------------------------------------------------------------------------

def is_foreign_set(meta, frames) -> bool:
    """A folder in the labels root that this tool did not write (its meta.json names no mode of
    this tool): opened read-only, so nothing in it is ever overwritten."""
    if isinstance(meta, dict) and meta.get("mode") in MODES:
        return False
    return bool(meta) or bool(frames)


def prefill_allowed(mode: str, role) -> bool:
    """Prefill (model proposals) is allowed in training mode, and in box mode on a role=training
    set; never in a development or test set, never in point, corner or identify mode."""
    return mode == "training" or (mode == "box" and role == "training")


def check_mode_role(mode: str, role: str, prefill: bool, all_blind: bool = False) -> None:
    """Server-run rules. box and identify take any role; training mode only role=training.
    Prefill: training mode, or box mode with role=training; nothing else. Verify mode:
    role=development, or role=test only with all_blind (no model output on a test set)."""
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")
    if mode == "training" and role != "training":
        raise ValueError("training mode (prefill allowed) is only for role=training")
    if mode == "center" and role not in CENTER_ROLES:
        raise ValueError("center mode (a census of card centers) is for role=development or role=test sets only")
    if mode == "center" and prefill:
        raise ValueError("center mode never takes --prefill (no model output is shown in a census)")
    if mode == "verify" and role not in (VERIFY_ALL_BLIND_ROLES if all_blind else VERIFY_ROLES):
        raise ValueError("verify mode (naming a census of centers) is for role=development sets, or role=test "
                         "with --all-blind only (never proposals on a test set)")
    if mode == "verify" and prefill:
        raise ValueError("verify mode takes --arm and --blind, never --prefill")
    if prefill and not prefill_allowed(mode, role):
        raise ValueError("prefill is allowed only in training mode or in box mode with role=training "
                         "(never in development or test sets)")


def target_complete(t: dict, mode: str | None = None) -> bool:
    """A labeled target/point: an outcome, and for a card an identity and an eligibility.
    In box mode a box is complete with an outcome alone (identity and eligibility are optional
    there; an ignored box is a card with `ignore: true`)."""
    o = t.get("outcome")
    if o not in OUTCOMES:
        return False
    if mode == "box":
        return True
    if o == "card":
        return bool(t.get("identity")) and t.get("eligible") in ELIGIBLE
    return True


def _check_target(t: dict, where: str, mode: str, errors: list, role: str | None = None) -> None:
    o = t.get("outcome")
    if o is not None and o not in OUTCOMES:
        errors.append(f"{where}: outcome {o!r}")
    src = t.get("identitySource")
    if src is not None and src not in IDENTITY_SOURCES:
        errors.append(f"{where}: identitySource {src!r}")
    el = t.get("eligible")
    if el is not None and el not in ELIGIBLE:
        errors.append(f"{where}: eligible {el!r}")
    cond = t.get("conditions") or {}
    if not isinstance(cond, dict):
        errors.append(f"{where}: conditions must be an object")
        cond = {}
    for key in BOOL_CONDITIONS:
        if cond.get(key) not in (None, True, False):
            errors.append(f"{where}: conditions.{key} {cond.get(key)!r}")
    if cond.get("visibleShare") not in (None,) + VISIBLE_SHARE:
        errors.append(f"{where}: conditions.visibleShare {cond.get('visibleShare')!r}")
    ls = t.get("labelSource")
    if ls is not None and ls not in LABEL_SOURCES:
        errors.append(f"{where}: labelSource {ls!r}")
    if not prefill_allowed(mode, role) and (ls in PREFILL_LABEL_SOURCES or "prefill" in t):
        errors.append(f"{where}: prefill provenance outside training mode / a role=training box set")
    if role is not None and role != "training" and (ls in PROPAGATED_SOURCES or "propagatedFrom" in t):
        errors.append(f"{where}: propagated labels belong to role=training sets only")
    if role == "test" and (ls in CARRIED_SOURCES or "carriedFrom" in t or t.get("cornerSource") == "carried"):
        errors.append(f"{where}: carried-over labels are not allowed in a test set")
    if t.get("ignore") not in (None, True, False):
        errors.append(f"{where}: ignore must be a boolean")


def validate_frame(fr: dict, mode: str, role: str | None = None) -> list:
    """Errors in one frame row for this (set) mode (empty list = fine). With `role`, propagated
    provenance is refused outside role=training."""
    errors = []
    if not isinstance(fr, dict):
        return ["frame must be an object"]
    if not isinstance(fr.get("name"), str):
        errors.append("frame.name missing")
    if mode == "center":
        _check_center_frame(fr, errors, role)
        return errors
    if "centers" in fr:
        errors.append("only center-mode frames carry `centers`")
    if mode == "point":
        if "targets" in fr:
            errors.append("point mode frames carry `points`, not `targets`")
        for p in fr.get("points") or []:
            where = f"point {p.get('i')}"
            if not isinstance(p.get("i"), int):
                errors.append(f"{where}: i must be an integer")
            for key in ("x", "y"):
                v = p.get(key)
                if not isinstance(v, (int, float)) or not (0.0 <= v <= 1.0):
                    errors.append(f"{where}: {key} must be normalized [0, 1]")
            _check_target(p, where, mode, errors, role)
    else:
        if "points" in fr:
            errors.append("corner/training frames carry `targets`, not `points`")
        for t in fr.get("targets") or []:
            where = f"target {t.get('id')}"
            c = t.get("corners")
            if not (isinstance(c, list) and len(c) == 4 and all(isinstance(p, list) and len(p) == 2 for p in c)):
                errors.append(f"{where}: corners must be 4 [x, y]")
            cs = t.get("cornerSource")
            if cs is not None and cs not in CORNER_SOURCES:
                errors.append(f"{where}: cornerSource {cs!r}")
            if not prefill_allowed(mode, role) and cs in PREFILL_CORNER_SOURCES:
                errors.append(f"{where}: prefill corners outside training mode / a role=training box set")
            if mode == "box" and cs == BOX_QUAD_SOURCE:
                if not is_box_quad(c):
                    errors.append(f"{where}: a box with free corners must be four corners TL, TR, BR, BL, clockwise, convex, every side at least 1 px")
            elif mode == "box":
                if cs not in BOX_CORNER_SOURCES:
                    errors.append(f"{where}: a box-mode target has cornerSource box (or propagated / carried / prefill / prefill-edited)")
                if not is_rectangle_box(c):
                    errors.append(f"{where}: a box must be a rectangle: four corners TL, TR, BR, BL of its own (rotated) frame, clockwise, right angles")
            elif cs == "box" and not is_rectangle_box(c):
                errors.append(f"{where}: cornerSource box needs the corners of a rectangle")
            a = t.get("angle")
            if a is not None and not (isinstance(a, (int, float)) and not isinstance(a, bool) and math.isfinite(a) and -180.0 < a <= 180.0):
                errors.append(f"{where}: angle must be degrees in (-180, 180]")
            z = t.get("zOrder")
            if z is not None and not (isinstance(z, (int, float)) and not isinstance(z, bool) and math.isfinite(z)):
                errors.append(f"{where}: zOrder must be a number")
            est = t.get("estimated")
            if est is not None and not (isinstance(est, list) and len(est) == 4):
                errors.append(f"{where}: estimated must be 4 booleans")
            _check_target(t, where, mode, errors, role)
            if mode == "box" and fr.get("done") and t.get("pending"):
                errors.append(f"{where}: a confirmed frame has an unreviewed prefill box (accept, correct or delete it first)")
    return errors


def frame_size_errors(fr: dict) -> list:
    """A row saved by a pass that draws on the frame (boxes, corners, points, centers) records
    the frame's size, `frameW` and `frameH`, which the page learns from the picture: a row
    without them comes from a frame whose picture did not load, and the server refuses it. The
    Names pass and Check names only answer rows that are stored already, and keep the size those
    have. Not part of `validate_frame`: a stored row that lacks a size stays readable."""
    if all(_is_num(fr.get(key)) and fr.get(key) > 0 for key in ("frameW", "frameH")):
        return []
    return ["frameW and frameH must be positive numbers: a frame is saved only once its picture has loaded, "
            "and this row records no frame size"]


def card_id_error(card_id) -> str | None:
    """Why `card_id` cannot be a card id (None = fine): see `CARD_ID_PATTERN`."""
    if isinstance(card_id, str) and len(card_id) <= CARD_ID_MAX and CARD_ID.fullmatch(card_id):
        return None
    return (f"card id {card_id!r} must be 1 to {CARD_ID_MAX} characters, with no space, line break or other "
            "whitespace and no control character")


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def center_number(cid) -> int | None:
    """The number of a center id (`C007` → 7), None if the id is not of that form."""
    m = CENTER_ID.fullmatch(cid) if isinstance(cid, str) else None
    return int(m.group(1)) if m else None


def _check_center_frame(fr: dict, errors: list, role: str | None) -> None:
    """A center-mode row: `centers` [{id, x, y, kind}] with x/y in [0, 1], kind face | back, ids
    unique of the form C001; `centerSeq` (int) at least the largest id number; frameW/frameH
    positive. The verify pass's answers (CENTER_VERIFY_KEYS) must follow their contract
    (`center_answer_errors`); any other extra key passes."""
    if role is not None and role not in CENTER_ROLES:
        errors.append(f"center mode is for role=development or role=test sets (this set is role={role})")
    for key in ("points", "targets"):
        if key in fr:
            errors.append(f"center-mode frames carry `centers`, not `{key}`")
    for key in ("frameW", "frameH"):
        if not (_is_num(fr.get(key)) and fr.get(key) > 0):
            errors.append(f"{key} must be a positive number (frame px)")
    if "prefillOffered" in fr or "prefill" in fr:
        errors.append("center mode never takes prefill")
    centers = fr.get("centers")
    if centers is None:
        centers = []
    if not isinstance(centers, list):
        errors.append("centers must be a list")
        return
    seen, top = set(), 0
    for n, c in enumerate(centers):
        if not isinstance(c, dict):
            errors.append(f"center #{n + 1} must be an object")
            continue
        cid = c.get("id")
        num = center_number(cid)
        where = f"center {cid!r}"
        if num is None:
            errors.append(f"{where}: id must be C followed by at least 3 digits (C001)")
        elif cid in seen:
            errors.append(f"{where}: duplicate id (ids are unique within a frame)")
        else:
            seen.add(cid)
            top = max(top, num)
        for key in ("x", "y"):
            v = c.get(key)
            if not (_is_num(v) and 0.0 <= v <= 1.0):
                errors.append(f"{where}: {key} must be normalized to [0, 1]")
        if c.get("kind") not in CENTER_KINDS:
            errors.append(f"{where}: kind must be face or back, not {c.get('kind')!r}")
        if "prefill" in c:
            errors.append(f"{where}: center mode never takes prefill")
        if any(k in c for k in CENTER_VERIFY_KEYS):
            errors.extend(f"{where}: {e}" for e in center_answer_errors(c))
    seq = fr.get("centerSeq")
    if seq is not None and not (isinstance(seq, int) and not isinstance(seq, bool) and seq >= top):
        errors.append(f"centerSeq must be an integer at least the largest center id number ({top})")


def center_seq_errors(old: dict | None, new: dict) -> list:
    """Ids are never reused within a frame: the page numbers a new center from `centerSeq` (the
    last id number issued on the frame, kept through deletes and undo), so a save may not lower it
    or drop it once the frame has issued ids."""
    if not old:
        return []
    old_seq = old.get("centerSeq")
    if not isinstance(old_seq, int):
        old_seq = max([center_number(c.get("id")) or 0 for c in old.get("centers") or [] if isinstance(c, dict)] or [0])
    new_seq = new.get("centerSeq")
    if isinstance(new_seq, int) and new_seq < old_seq:
        return [f"centerSeq may not go back ({old_seq} → {new_seq}): center ids are never reused within a frame"]
    if new_seq is None and old_seq:
        return ["centerSeq missing: the frame has issued center ids before"]
    return []


# ---- verify pass (naming a center census) ---------------------------------------------------

def _is_sha(v) -> bool:
    return isinstance(v, str) and bool(v.strip())


def arm_name_error(name) -> str | None:
    """Why `name` cannot name an arm (None = fine): lower-case letters, digits and `_`, starting
    with a letter, at most 24 characters, and not `both` (`accept-both` means every arm)."""
    if not (isinstance(name, str) and ARM_NAME.fullmatch(name)):
        return f"arm name {name!r}: use lower-case letters, digits and _ (starting with a letter, at most 24 characters)"
    if name == "both":
        return "arm name 'both' is taken: accept-both means both arms"
    return None


def is_accept(vb) -> bool:
    """`accept-both`, or `accept-<arm name>`."""
    return isinstance(vb, str) and vb.startswith(ACCEPT_PREFIX) and (vb == ACCEPT_BOTH or arm_name_error(vb[len(ACCEPT_PREFIX):]) is None)


def is_named_by(vb) -> bool:
    """A named card (an accept or a pick): readability y / m / n (`eligible`) required."""
    return vb == "picked" or is_accept(vb)


def is_verified_by(vb) -> bool:
    return is_named_by(vb) or vb == "unknown" or vb in CORRECTIONS


def accept_arms(vb, arms) -> tuple | None:
    """The arms an accept credits in a run with these `arms` (in command-line order):
    `accept-both` → both arms of a two-arm run; `accept-<name>` → that arm. None when the run has
    no such arm (or `accept-both` in a one-arm run)."""
    arms = tuple(arms or ())
    if vb == ACCEPT_BOTH:
        return arms if len(arms) == 2 else None
    if is_accept(vb) and vb[len(ACCEPT_PREFIX):] in arms:
        return (vb[len(ACCEPT_PREFIX):],)
    return None


def center_answer(c: dict) -> dict:
    """The verify answer fields a center carries (CENTER_VERIFY_KEYS present on it)."""
    return {k: c[k] for k in CENTER_VERIFY_KEYS if k in c}


def center_answer_errors(c: dict) -> list:
    """The answer contract of one center (empty = fine; no answer field at all is fine too).

    verifiedBy: accept-<arm name> | accept-both | picked (a named card: `identity` a card
    id, `printing` optional, `eligible` yes | uncertain | no once readability is answered; an
    accept is never blind) · unknown (`identity` "unknown", with its readability) · not-card | back (a correction: `correction` equal to it, no identity; a readability
    given before it may stay; `kind` is never changed).
    Always `blind` (bool) and `verifiedAt` {x, y, armsManifestSha256}: the center's position and
    the proposals' run when it was answered (a later move or another run makes it stale).
    Readability first: a readability alone (`eligible`, `blind`, `readabilityAt`,
    optionally `revealedAt`) is a valid pending answer; `readabilityAt` {x, y, at}, `revealedAt` an
    ISO time no earlier than readabilityAt.at, never on a blind center."""
    a = center_answer(c)
    if not a:
        return []
    errors = _readability_stamp_errors(a)
    vb = a.get("verifiedBy")
    if vb is None:
        extra = sorted(k for k in a if k not in PENDING_KEYS)
        if extra or "eligible" not in a:
            return errors + ["answer fields without verifiedBy"]
        if a.get("eligible") not in ELIGIBLE:
            errors.append(f"eligible {a.get('eligible')!r} not in {ELIGIBLE}")
        if not isinstance(a.get("blind"), bool):
            errors.append("blind must be true or false")
        if "readabilityAt" not in a:
            errors.append("a readability without readabilityAt")
        return errors
    if not is_verified_by(vb):
        return [f"verifiedBy {vb!r} is not accept-<arm>, accept-both, picked, unknown, not-card or back"]
    if not isinstance(a.get("blind"), bool):
        errors.append("blind must be true or false")
    at = a.get("verifiedAt")
    if not (isinstance(at, dict) and all(_is_num(at.get(k)) and 0.0 <= at.get(k) <= 1.0 for k in ("x", "y"))
            and _is_sha(at.get("armsManifestSha256"))):
        errors.append("verifiedAt must be {x, y (normalized), armsManifestSha256}")
    ident, el, pr, corr = a.get("identity"), a.get("eligible"), a.get("printing"), a.get("correction")
    if pr is not None and not (isinstance(pr, str) and pr):
        errors.append("printing must be a printing id or null")
    if el is not None and el not in ELIGIBLE:
        errors.append(f"eligible {el!r} not in {ELIGIBLE}")
    if is_named_by(vb):
        if not (isinstance(ident, str) and ident and ident != "unknown"):
            errors.append(f"{vb} needs a card id as identity")
        if corr is not None:
            errors.append(f"{vb} carries no correction")
        if is_accept(vb) and a.get("blind") is True:
            errors.append(f"{vb} on a blind center: blind centers are named without proposals")
    elif vb == "unknown":
        if ident != "unknown":
            errors.append('verifiedBy unknown needs identity "unknown"')
        if pr is not None or corr is not None:
            errors.append("an unknown answer has no printing or correction")
        if el is not None and "readabilityAt" not in a:
            errors.append("an unknown answer's readability needs readabilityAt (readability first)")
    else:  # not-card / back: a correction
        if corr != vb:
            errors.append(f"verifiedBy {vb} needs correction {vb!r}")
        if ident is not None or pr is not None:
            errors.append(f"a {vb} correction has no identity or printing")
        if el is not None and "readabilityAt" not in a:
            errors.append(f"a {vb} correction carries a readability only when it was answered first (readabilityAt)")
    if corr is not None and corr not in CORRECTIONS:
        errors.append(f"correction {corr!r} not in {CORRECTIONS}")
    return errors


def _readability_stamp_errors(a: dict) -> list:
    """The shape of the server's readability-first stamps (an answer may carry neither)."""
    errors = []
    ra, rv = a.get("readabilityAt"), a.get("revealedAt")
    if ra is not None and not (isinstance(ra, dict) and all(_is_num(ra.get(k)) and 0.0 <= ra.get(k) <= 1.0 for k in ("x", "y"))
                               and isinstance(ra.get("at"), str) and ra.get("at")):
        errors.append("readabilityAt must be {x, y (normalized), at (ISO time)}")
    if ra is not None and a.get("eligible") not in ELIGIBLE:
        errors.append("readabilityAt without a readability (eligible)")
    if rv is not None:
        if not (isinstance(rv, str) and rv):
            errors.append("revealedAt must be an ISO time")
        elif not isinstance(ra, dict):
            errors.append("revealedAt without readabilityAt: the proposals were shown before the readability")
        elif isinstance(ra.get("at"), str) and ra["at"] > rv:
            errors.append("readabilityAt is later than revealedAt: readability must come before the reveal")
        if a.get("blind") is True:
            errors.append("revealedAt on a blind center (blind centers show no proposals)")
    return errors


def readability_stamp_moved(c: dict) -> bool:
    """A readability stamped for another position of the marker (the center was moved since)."""
    ra = c.get("readabilityAt")
    if not isinstance(ra, dict):
        return False
    try:
        return abs(float(ra.get("x")) - float(c.get("x"))) > VERIFY_XY_TOL or abs(float(ra.get("y")) - float(c.get("y"))) > VERIFY_XY_TOL
    except (TypeError, ValueError):
        return True


def readability_ready(c: dict) -> bool:
    """A readability stored from the crop for the center's current position: the proposals may be
    released (verify mode's reveal)."""
    return c.get("eligible") in ELIGIBLE and isinstance(c.get("readabilityAt"), dict) and not readability_stamp_moved(c)


def verify_stamp(old_c: dict, new_c: dict, now: str) -> list:
    """Readability first, on one center of a verify save (mutates `new_c`, the merged center):
    the server-owned stamps come from the stored center, never the page; a readability that
    changes is stamped `readabilityAt` now; once the proposals were shown (`revealedAt`, for this
    position) the readability is fixed: a change is refused, and a cleared answer keeps it (the
    identity is cleared, the readability and the reveal stay). → errors (empty = fine)."""
    for k in VERIFY_SERVER_KEYS:
        new_c.pop(k, None)
        if k in old_c:
            new_c[k] = old_c[k]
    if center_answer(new_c) == center_answer(old_c):
        # an untouched answer (stale, pending or unstamped) stays exactly as stored: never re-stamped
        # without the labeler answering again (after a marker move: clear, then y / m / n)
        return []
    old_el, new_el = old_c.get("eligible"), new_c.get("eligible")
    revealed = "revealedAt" in old_c and not readability_stamp_moved(old_c)
    if revealed:
        if new_el is None and old_el is not None:
            new_c["eligible"] = old_el
            new_c.setdefault("blind", old_c.get("blind"))
            return []
        if new_el != old_el:
            return [f"center {new_c.get('id')}: the readability was answered before the proposals were shown; "
                    "it cannot change after the reveal"]
        return []
    if "revealedAt" in old_c:  # a reveal for an earlier position of the marker: void
        new_c.pop("revealedAt", None)
    if new_el is None:
        new_c.pop("readabilityAt", None)
    elif new_el != old_el or readability_stamp_moved(old_c):
        # (an unchanged readability of an unstamped answer stays unstamped: never back-dated)
        if _named_or_unknown(new_c.get("verifiedBy")) and new_el != old_el and _named_or_unknown(old_c.get("verifiedBy")) \
                and isinstance(old_c.get("readabilityAt"), dict) and not readability_stamp_moved(old_c):
            return [f"center {new_c.get('id')}: the readability is answered before the name; clear the answer to change it"]
        new_c["readabilityAt"] = {"x": round(float(new_c.get("x")), 6), "y": round(float(new_c.get("y")), 6), "at": now}
    return []


def _named_or_unknown(vb) -> bool:
    return is_named_by(vb) or vb == "unknown"


def answer_complete(c: dict) -> bool:
    """An answer that needs nothing more (a named card has its readability)."""
    vb = c.get("verifiedBy")
    if is_named_by(vb):
        return c.get("eligible") in ELIGIBLE
    return is_verified_by(vb)


def answer_stale(c: dict, sha) -> bool:
    """An answer given for another position of the marker, or for another run of the arms."""
    at = c.get("verifiedAt")
    if not c.get("verifiedBy") or not isinstance(at, dict):
        return False
    try:
        moved = abs(float(at.get("x")) - float(c.get("x"))) > VERIFY_XY_TOL or abs(float(at.get("y")) - float(c.get("y"))) > VERIFY_XY_TOL
    except (TypeError, ValueError):
        return True
    return moved or (sha is not None and at.get("armsManifestSha256") != sha)


def center_verified(c: dict, sha) -> bool:
    """Counts as verified: answered completely, and not stale."""
    return answer_complete(c) and not answer_stale(c, sha)


def verify_walk(frames: list, include_backs: bool = False) -> list:
    """The verify walk: every FACE center (and every back with include_backs), frames in the order
    given (the sample's, by time), centers by id number. [{frame, id}]."""
    out = []
    for fr in frames:
        cs = [c for c in fr.get("centers") or [] if isinstance(c, dict) and (c.get("kind") == "face" or include_backs)]
        for c in sorted(cs, key=lambda c: (center_number(c.get("id")) or 0, str(c.get("id")))):
            out.append({"frame": fr.get("name"), "id": c.get("id")})
    return out


_ROW_GEOMETRY = ("centerSeq", "frameW", "frameH")


def verify_geometry_changes(old: dict, new: dict) -> list:
    """What a verify save would change beyond answers (empty = nothing): centers added or removed,
    any non-answer field of a center (x, y, id, kind, anything else), or the row's centerSeq /
    frameW / frameH. The verify pass never edits the clicked centers."""
    errors = []
    o = {c.get("id"): c for c in (old or {}).get("centers") or [] if isinstance(c, dict)}
    n = {c.get("id"): c for c in (new or {}).get("centers") or [] if isinstance(c, dict)}
    if set(o) != set(n) or len(n) != len((new or {}).get("centers") or []):
        errors.append(f"centers added/removed ({sorted(map(str, set(n) - set(o)))} / {sorted(map(str, set(o) - set(n)))}): "
                      "the verify pass never changes the clicked centers")
    for cid in sorted(set(o) & set(n), key=str):
        a = {k: v for k, v in o[cid].items() if k not in CENTER_VERIFY_KEYS}
        b = {k: v for k, v in n[cid].items() if k not in CENTER_VERIFY_KEYS}
        for k in sorted(set(a) | set(b)):
            va, vb = a.get(k), b.get(k)
            if k in ("x", "y") and _is_num(va) and _is_num(vb) and abs(va - vb) <= 1e-9:
                continue
            if va != vb:
                errors.append(f"center {cid}: {k} changed ({va!r} → {vb!r}): the verify pass changes answers only")
    for k in _ROW_GEOMETRY:
        if (old or {}).get(k) != (new or {}).get(k):
            errors.append(f"{k} changed: the verify pass changes answers only")
    return errors


def verify_merge(old: dict, new: dict, now: str | None = None, errors: list | None = None) -> dict:
    """The stored row with each center's answer fields taken from `new` (a field absent there is
    removed: Backspace clears an answer). Everything else is the stored row's. With `now`, the
    readability-first stamps are applied (`verify_stamp`; problems appended to `errors`)."""
    n = {c.get("id"): c for c in (new or {}).get("centers") or [] if isinstance(c, dict)}
    out = dict(old)
    centers = []
    for c in old.get("centers") or []:
        nc = n.get(c.get("id")) or {}
        merged = {k: v for k, v in c.items() if k not in CENTER_VERIFY_KEYS}
        merged.update(center_answer(nc))
        if now is not None:
            errs = verify_stamp(c, merged, now)
            if errors is not None:
                errors.extend(errs)
        centers.append(merged)
    out["centers"] = centers
    return out


def verify_answer_errors(c: dict, proposal, blind: bool, sha, names: dict, arms=(), rule: str = IDENTITY_NAME, roots=None) -> list:
    """Server checks of an answer the save CHANGED (on top of `center_answer_errors`): `blind`
    equals the subsample's; `verifiedAt` is this center's position and the arms' run (`sha`);
    an accept names an arm of this run (`arms`, in command-line order) and exactly what the
    arm(s) showed (the same card by the catalog's `rule`, `same_card`: by name under "name",
    `names`: id → name; by the card printed under "printing", `roots`: `printing_roots`; the
    arm's printingId always); a picked id is in the catalog."""
    a = center_answer(c)
    if not a:
        return []
    errors = []
    cid = c.get("id")
    if a.get("blind") is not bool(blind):
        errors.append(f"center {cid}: blind must be {bool(blind)} (the blind subsample decides, not the page)")
    if a.get("verifiedBy") is None:
        return errors  # a readability alone (readability first)
    vb, ident = a.get("verifiedBy"), a.get("identity")
    if _named_or_unknown(vb):
        # readability first: a name only after the readability, stamped no later than any reveal
        if not readability_ready(a | {"x": c.get("x"), "y": c.get("y")}):
            errors.append(f"center {cid}: readable from the crop (y / m / n) comes first, before any name")
        elif a.get("revealedAt") is not None and a["readabilityAt"].get("at", "") > a["revealedAt"]:
            errors.append(f"center {cid}: the readability was stamped after the reveal")
    if is_accept(vb) and not blind and a.get("revealedAt") is None:
        errors.append(f"center {cid}: an accept needs the proposals to have been shown (revealedAt)")
    at = a.get("verifiedAt") or {}
    try:
        if abs(float(at.get("x")) - float(c.get("x"))) > VERIFY_XY_TOL or abs(float(at.get("y")) - float(c.get("y"))) > VERIFY_XY_TOL:
            errors.append(f"center {cid}: verifiedAt is not the center's position")
    except (TypeError, ValueError):
        errors.append(f"center {cid}: verifiedAt has no position")
    if sha is not None and at.get("armsManifestSha256") != sha:
        errors.append(f"center {cid}: verifiedAt.armsManifestSha256 is not this run of the arms ({sha})")
    if is_accept(vb):
        if blind:
            errors.append(f"center {cid}: {vb} on a blind center")
        credited = accept_arms(vb, arms)
        if credited is None:
            errors.append(f"center {cid}: {vb}: this run has no such arm (arms: {', '.join(arms) or 'none'})")
            return errors
        shown_by = (proposal or {}).get("arms") or {}
        shown = []
        for arm in credited:
            p = shown_by.get(arm) or {}
            if not p.get("name"):
                errors.append(f"center {cid}: {vb}: the {arm} arm showed no name")
                continue
            shown.append(p)
            if p.get("printingId") and ident == p.get("printingId"):
                continue
            if not same_card(ident, names.get(ident), p.get("printingId"), p.get("name"), rule, roots):
                errors.append(f"center {cid}: {vb}: identity {ident!r} is not the {arm} arm's card ({p.get('name')!r})")
        if len(shown) == 2 and not same_card(shown[0].get("printingId"), shown[0].get("name"), shown[1].get("printingId"), shown[1].get("name"), rule, roots):
            errors.append(f"center {cid}: accept-both: the arms showed different {'cards' if rule == IDENTITY_PRINTING else 'names'}")
    elif vb == "picked" and ident not in names:
        errors.append(f"center {cid}: picked identity {ident!r} is not in the catalog")
    return errors


def frame_name_matches(given, name) -> bool:
    """A proposals/blind `frame` names a label row: the frame file name, or its stem."""
    if not isinstance(given, str) or not isinstance(name, str):
        return False
    return given == name or given == name.rsplit(".", 1)[0]


def prefill_frame_size(row: dict, default_w=None, default_h=None) -> tuple:
    """The pixel space a prefill record's boxes are in: its own `frameW` x `frameH` when it gives
    both (the inference command writes them), else the defaults (the frame's own size)."""
    w, h = (row or {}).get("frameW"), (row or {}).get("frameH")
    if _is_num(w) and _is_num(h) and w > 0 and h > 0:
        return float(w), float(h)
    return default_w, default_h


def prefill_row_errors(row, where: str) -> list:
    """Problems of one prefill record as an arm's input (empty = fine): a frame name, boxes that
    are [x, y, w, h] with positive w and h, and a frame size that is both numbers or absent."""
    if not isinstance(row, dict):
        return [f"{where}: not an object"]
    errors = []
    if not (isinstance(row.get("name"), str) and row.get("name")):
        errors.append(f"{where}: no frame name")
    w, h = row.get("frameW"), row.get("frameH")
    if (w is not None or h is not None) and not (_is_num(w) and _is_num(h) and w > 0 and h > 0):
        errors.append(f"{where}: frameW and frameH must both be positive numbers (or both absent)")
    boxes = row.get("boxes")
    if boxes is None:
        boxes = []
    if not isinstance(boxes, list):
        return errors + [f"{where}: boxes must be a list"]
    for n, b in enumerate(boxes):
        box = b.get("box") if isinstance(b, dict) else None
        if not (isinstance(box, list) and len(box) == 4 and all(_is_num(v) for v in box) and box[2] > 0 and box[3] > 0):
            errors.append(f"{where}: box {n + 1} must be {{box: [x, y, w, h]}} with positive w and h")
        elif b.get("cardId") is not None and not isinstance(b.get("cardId"), str):
            errors.append(f"{where}: box {n + 1}: cardId must be a card id or null")
    return errors


def arm_proposal(row, x: float, y: float, frame_w: float, frame_h: float, names: dict) -> dict:
    """What one arm proposes for a clicked center: of the boxes in its prefill record `row` for the
    frame that contain the click, the one whose own center is nearest to it; none → nothing shown.
    The record's boxes are in its own `frameW` x `frameH` pixel space and are scaled to the label
    row's `frame_w` x `frame_h`. x/y are the center's, normalized. `names`: card id → name.
    → {box [x, y, w, h] in the label row's frame px | None, boxScore, name | None, printingId |
    None, similarity, margin, look}."""
    out = {"box": None, "boxScore": None, "name": None, "printingId": None, "similarity": None, "margin": None, "look": None}
    if not isinstance(row, dict):
        return out
    rw, rh = prefill_frame_size(row, frame_w, frame_h)
    sx, sy = float(frame_w) / float(rw), float(frame_h) / float(rh)
    px, py = float(x) * float(frame_w), float(y) * float(frame_h)
    best, best_d = None, None
    for b in row.get("boxes") or []:
        bx, by, bw, bh = [float(v) for v in b["box"]]
        bx, by, bw, bh = bx * sx, by * sy, bw * sx, bh * sy
        if not (bx <= px <= bx + bw and by <= py <= by + bh):
            continue
        d = math.hypot(bx + bw / 2.0 - px, by + bh / 2.0 - py)
        if best_d is None or d < best_d:
            best, best_d = (b, [round(bx, 2), round(by, 2), round(bw, 2), round(bh, 2)]), d
    if best is None:
        return out
    b, box = best
    cid = b.get("cardId")
    out.update(box=box, boxScore=b.get("score"), similarity=b.get("sim"), margin=b.get("margin"), look=b.get("rot") or None)
    if cid and names.get(cid):
        out.update(name=names[cid], printingId=cid)
    return out


def arms_run_sha(file_shas: dict) -> str:
    """The identity of a run of the arms: a sha256 over each arm's name and its file's sha256
    (arms in name order). An answer records it (`verifiedAt.armsManifestSha256`); another file
    for any arm is another run, and makes the answers given under the old one stale."""
    text = "\n".join(f"{name}:{file_shas[name]}" for name in sorted(file_shas))
    return hashlib.sha256(text.encode()).hexdigest()


_BLIND_LIST_KEYS = ("blind", "ids", "centerIds", "centers", "events", "items", "subsample", "keys")
_BLIND_SEP = re.compile(r"[/|:#]")


def parse_blind(data, events) -> tuple:
    """The blind subsample → (set of (video, frame name, centerId), errors). `events`: every center
    event as (video, frame name, centerId) (the labels root). Accepted shapes:
    - a list of entries, or an object holding exactly one such list (`blind`, `ids`, `centerIds`,
      `centers`, `events`, `items`, `subsample`, `keys`; other keys such as seed are ignored);
    - an object keyed by video ({video: [entries]} or {video: {frame: [entries]}});
    an entry is a center id (`C012`), a composite string `video/frame/C012` (also `:` `|` `#`, the
    frame with or without its extension), or an object {video, frame, centerId} (aliases `name`,
    `id`). Every entry must name exactly ONE event:
    a bare id that several frames share, an unknown event or an unreadable shape is an error, and
    so is anything else ambiguous (two list keys). Nothing is guessed."""
    evs = list(events)
    errors = []
    keys = set()

    def resolve(where, video=None, frame=None, cid=None):
        hits = [e for e in evs if (video is None or e[0] == video) and (frame is None or frame_name_matches(frame, e[1]))
                and (cid is None or e[2] == cid)]
        if len(hits) == 1:
            keys.add(hits[0])
        elif not hits:
            errors.append(f"{where}: no such center event")
        else:
            errors.append(f"{where}: ambiguous ({len(hits)} center events match, e.g. {'/'.join(hits[0])}, {'/'.join(hits[1])})")

    def entry(e, where, video=None, frame=None):
        if isinstance(e, str):
            parts = [p for p in _BLIND_SEP.split(e.strip())]
            if any(not p for p in parts) or len(parts) > 3 or center_number(parts[-1]) is None:
                errors.append(f"{where}: {e!r} is not a center id or video/frame/centerId")
                return
            if len(parts) == 3:
                if (video and parts[0] != video) or (frame and not frame_name_matches(parts[1], frame)):
                    errors.append(f"{where}: {e!r} contradicts its key")
                    return
                resolve(f"{where} {e!r}", parts[0], parts[1], parts[2])
            elif len(parts) == 2:
                errors.append(f"{where}: {e!r}: two parts are ambiguous (video or frame?); use video/frame/centerId")
            else:
                resolve(f"{where} {e!r}", video, frame, parts[0])
        elif isinstance(e, dict):
            v = e.get("video", e.get("assetId", video))
            f = e.get("frame", e.get("name", frame))
            c = e.get("centerId", e.get("center", e.get("id")))
            if center_number(c) is None or not all(x is None or isinstance(x, str) for x in (v, f)):
                errors.append(f"{where}: {e!r} has no center id (centerId / id)")
                return
            resolve(f"{where} {json_dumps_short(e)}", v, f, c)
        else:
            errors.append(f"{where}: {e!r} is not an entry")

    def entries(lst, where, video=None, frame=None):
        if not isinstance(lst, list):
            errors.append(f"{where}: expected a list")
            return
        for n, e in enumerate(lst):
            entry(e, f"{where}[{n}]", video, frame)

    if isinstance(data, list):
        entries(data, "blind")
    elif isinstance(data, dict):
        found = [k for k in _BLIND_LIST_KEYS if k in data]
        videos = {e[0] for e in evs}
        if len(found) > 1:
            errors.append(f"blind: ambiguous, more than one list key {found}")
        elif found:
            inner = data[found[0]]
            if isinstance(inner, dict):
                sub, errs = parse_blind(inner, evs)
                keys |= sub
                errors += errs
            else:
                entries(inner, f"blind.{found[0]}")
        elif data and all(k in videos for k in data):
            for v, val in data.items():
                if isinstance(val, list):
                    entries(val, f"blind.{v}", video=v)
                elif isinstance(val, dict):
                    for f, lst in val.items():
                        entries(lst, f"blind.{v}.{f}", video=v, frame=f)
                else:
                    errors.append(f"blind.{v}: expected a list or {{frame: list}}")
        else:
            errors.append("blind: an object with no list key and keys that are not all videos of the labels "
                          f"({sorted(k for k in data if k not in videos)[:5]})")
    else:
        errors.append("blind: expected a list or an object")
    return keys, errors


def json_dumps_short(obj) -> str:
    s = json.dumps(obj, sort_keys=True)
    return s if len(s) <= 80 else s[:77] + "..."


def normalize_frame(fr: dict, mode: str, source_h=None, landscape_ids=frozenset()) -> dict:
    """Server-side: recompute every corner target's derived measures (the client's are ignored).
    `landscape_ids`: card ids whose upright orientation is landscape (the catalog's
    `kinds.landscape`). Center-mode
    rows have no derived geometry: x/y are rounded to 1e-6 (a fraction of a pixel)."""
    out = dict(fr)
    if mode == "center":
        out["centers"] = [dict(c, x=round(float(c["x"]), 6), y=round(float(c["y"]), 6)) for c in fr.get("centers") or []]
        return out
    if mode != "point":
        targets = []
        for t in fr.get("targets") or []:
            t = dict(t)
            t["estimated"] = [bool(v) for v in (t.get("estimated") or [False] * 4)]
            try:
                aspect = 1.0 / CARD_ASPECT if t.get("identity") in landscape_ids else CARD_ASPECT
                t["derived"] = quad_measures(t["corners"], fr.get("frameH"), source_h, aspect)
            except (KeyError, ValueError, TypeError, ZeroDivisionError):
                t["derived"] = None
            targets.append(t)
        out["targets"] = targets
    return out


# ---- identity pass (identify mode) -----------------------------------------------------------

GEOMETRY_KEYS = ("corners", "estimated", "cornerSource", "ignore", "angle", "zOrder")
PROVENANCE_KEYS = ("labelSource", "carriedFrom", "propagatedFrom")
TRACKED_SOURCES = PROPAGATED_SOURCES + CARRIED_SOURCES


def needs_identity(t: dict) -> bool:
    """A target the identity pass walks: a card (or not yet answered) that is not ignored and
    has no identity. Card backs, non-cards, unreadable and ignored boxes are skipped."""
    return t.get("outcome") in (None, "card") and not t.get("ignore") and not t.get("identity")


def needs_readability(t: dict) -> bool:
    """A named card (not unknown, not ignored) with no y/n/m answer yet: the walk includes it so
    "readable from this frame alone" gets recorded. Cards named in box mode, where y/n/m are not
    keys, land here."""
    return (t.get("outcome") in (None, "card") and not t.get("ignore") and bool(t.get("identity"))
            and t.get("identity") != "unknown" and t.get("eligible") is None)


def identify_queue(frames: list) -> list:
    """The identity pass's walk, fixed when a set is opened: every target that needs an identity,
    frame by frame in time order, targets in stored order. [{frame, target}]."""
    out = []
    for fr in sorted(frames or [], key=lambda f: (f.get("t") or 0, f.get("name") or "")):
        for t in fr.get("targets") or []:
            if needs_identity(t) or needs_readability(t):
                out.append({"frame": fr.get("name"), "target": t.get("id")})
    return out


def normalize_angle(a: float) -> float:
    """Degrees into (-180, 180] (boxgeom.js normalizeAngle: JS `%` keeps the dividend's sign)."""
    x = math.fmod(float(a), 360.0)
    if x > 180.0:
        x -= 360.0
    if x <= -180.0:
        x += 360.0
    return x


def round_angle(a) -> float:
    """The stored angle: normalized, rounded to 0.01 deg (JS Math.round: half up), normalized
    again, never -0 (boxgeom.js roundAngle)."""
    r = math.floor(normalize_angle(a or 0.0) * 100.0 + 0.5) / 100.0
    return normalize_angle(r) + 0.0


def effective_angle(t: dict) -> float:
    """A box's angle as the page reads it (boxgeom.js rectFromCorners): the stored `angle` when it
    is a number, else the direction of its top edge q[0]->q[1] (0 for an axis-aligned box; the
    page stores no angle for 0)."""
    a = t.get("angle")
    if isinstance(a, (int, float)) and not isinstance(a, bool) and math.isfinite(a):
        return normalize_angle(a)
    q = t.get("corners")
    d = math.degrees(math.atan2(float(q[1][1]) - float(q[0][1]), float(q[1][0]) - float(q[0][0])))
    return normalize_angle(0.0 if abs(d) < 1e-9 else d)


def _float_corners(c):
    """Four [x, y] as floats, or None when `c` is not that."""
    if not (isinstance(c, list) and len(c) == 4 and all(isinstance(p, list) and len(p) == 2 for p in c)):
        return None
    try:
        return [[float(p[0]), float(p[1])] for p in c]
    except (TypeError, ValueError):
        return None


def quarter_turn_steps(old_corners, new_corners) -> int | None:
    """k in 1..3 when `new_corners` are `old_corners` in a cyclic rotation of their order
    (new[i] == old[(i + k) % 4], every point identical: boxgeom.js topEdgeCorners), else None.
    A reflection (the order run anticlockwise), a moved point or k = 0 (no change) is None."""
    a, b = _float_corners(old_corners), _float_corners(new_corners)
    if a is None or b is None:
        return None
    for k in (1, 2, 3):
        if all(b[i] == a[(i + k) % 4] for i in range(4)):
            return k
    return None


# The one geometry change the identity pass may make: which edge of a box is
# the card's top. The four points stay; only their order turns, and the angle with it.
ORIENTATION_MARK = "orientationFixedIn"


def orientation_turn(old_t: dict, new_t: dict, set_mode: str | None) -> tuple:
    """(k, error) for a box whose corners changed in an identity-pass save: k (1..3) when the
    change is a quarter turn of the corner order with the matching angle (old + 90*k, normalized
    and rounded as the page does) in a box set; else (None, why it is refused)."""
    tid = new_t.get("id")
    if set_mode != "box":
        return None, f"target {tid}: corners changed: the identity pass never changes geometry"
    k = quarter_turn_steps(old_t.get("corners"), new_t.get("corners"))
    if k is None:
        return None, (f"target {tid}: corners changed: the identity pass may only turn which edge is the top "
                      "(the same four points, their order rotated), never move, resize or mirror a box")
    if old_t.get("cornerSource") == BOX_QUAD_SOURCE:  # a box with free corners has no angle
        if new_t.get("angle") is not None:
            return None, f"target {tid}: a box with free corners has no angle (got {new_t.get('angle')!r})"
        return k, None
    try:
        expected = round_angle(effective_angle(old_t) + 90.0 * k)
        got = new_t.get("angle")
        if got is None:
            ok = abs(round_angle(effective_angle(new_t)) - expected) < 1e-6 and expected == 0.0
        else:
            ok = (isinstance(got, (int, float)) and not isinstance(got, bool) and math.isfinite(got)
                  and abs(normalize_angle(got) - expected) < 1e-6)
    except (TypeError, ValueError, IndexError):
        ok, expected, got = False, None, new_t.get("angle")
    if not ok:
        return None, f"target {tid}: angle {got!r} does not match a {90 * k} deg turn of the top edge (expected {expected!r})"
    return k, None


# Box edits in the identity pass: on a box set made for training or development, the current box
# may be moved, resized or turned (its corners and angle), and its provenance changes exactly as
# the same edit in the Boxes pass changes it. A test set's boxes change only in the Boxes pass.
NAMES_EDIT_ROLES = ("training", "development")
TEST_SET_LOCKED = "In a test set, boxes are not moved, resized or rotated here; the top edge can still be turned."


def names_edits_allowed(set_mode: str | None, role: str | None) -> bool:
    """Whether the identity pass may move, resize or rotate the boxes of this set."""
    return set_mode == "box" and role in NAMES_EDIT_ROLES


def _r1(v) -> float:
    """boxgeom.js r1: rounded to 0.1 (JS Math.round: half up)."""
    return math.floor(float(v) * 10.0 + 0.5) / 10.0


def same_corners(a, b) -> bool:
    """boxgeom.js sameCorners: four [x, y] equal at 0.1 px."""
    fa, fb = _float_corners(a), _float_corners(b)
    if fa is None or fb is None:
        return False
    return all(_r1(p[0]) == _r1(q[0]) and _r1(p[1]) == _r1(q[1]) for p, q in zip(fa, fb))


def prefill_provenance(t: dict):
    """boxgeom.js prefillProvenance: (labelSource, cornerSource) of a model box against its
    proposal: accepted when corners, angle and kind are as proposed, else corrected; the corners
    are `prefill` while they are the proposal's, else `prefill-edited`. None without a proposal."""
    p = t.get("prefill") if isinstance(t, dict) else None
    if not isinstance(p, dict):
        return None
    geom = same_corners(t.get("corners"), p.get("corners")) and round_angle(t.get("angle") or 0) == round_angle(p.get("angle") or 0)
    kind = (t.get("outcome") or "card") == (p.get("outcome") or "card") and not t.get("ignore")
    return ("prefill-accepted" if geom and kind else "prefill-corrected", "prefill" if geom else "prefill-edited")


EDIT_CORRECTED = {"carried": "carried-corrected", "propagated": "propagated-corrected"}


def edit_provenance(old_t: dict, new_t: dict) -> dict:
    """The provenance a Boxes-pass edit gives a box (sources.js logCommit and finalizePrefill):
    a model box is accepted or corrected against its proposal (prefill_provenance of the edited
    box), a kept or propagated box becomes `-corrected`, any other keeps its own. Only
    labelSource and cornerSource change; carriedFrom, propagatedFrom and the proposal stay."""
    pv = prefill_provenance(dict(new_t, prefill=old_t.get("prefill"))) if old_t.get("prefill") else None
    if pv:
        return {"labelSource": pv[0], "cornerSource": pv[1]}
    ls = old_t.get("labelSource")
    return {"labelSource": EDIT_CORRECTED.get(ls, ls), "cornerSource": old_t.get("cornerSource")}


def geometry_changes(old: dict, new: dict, set_mode: str | None = None, role: str | None = None) -> list:
    """What an identity-pass save would change beyond what the pass may change (empty = nothing).
    Always refused: targets added or removed, a target's estimated flags, ignore flag or
    stacking order (zOrder), its proposal (`prefill`), and the provenance of a carried /
    propagated / (box set) prefill box (labelSource, carriedFrom, propagatedFrom) when the box
    was not edited in this save.
    A box's corners and angle may change in two ways. In a box set, its top edge may be turned:
    the same four points in a cyclic rotation of their order (k = 1, 2, 3) with angle = old +
    90*k (`orientation_turn`); provenance stays as it is, and the server marks the box
    `orientationFixedIn: "identify"` (`mark_orientation`). And in a box set of role training
    or development (`names_edits_allowed`), a box may be moved, resized or rotated; its
    labelSource and cornerSource must then be what the same edit gives in the Boxes pass
    (`edit_provenance`). A test set's boxes are refused (TEST_SET_LOCKED); so are corner and
    training sets."""
    tracked = TRACKED_SOURCES + (PREFILL_LABEL_SOURCES if set_mode == "box" else ())
    errors = []
    o = {t.get("id"): t for t in (old or {}).get("targets") or []}
    n = {t.get("id"): t for t in (new or {}).get("targets") or []}
    if set(o) != set(n):
        errors.append(f"targets added/removed ({sorted(set(n) - set(o))} / {sorted(set(o) - set(n))}): the identity pass never changes geometry")
    for tid in sorted(set(o) & set(n), key=str):
        turned = edited = False
        a, b = o[tid].get("corners"), n[tid].get("corners")
        fa, fb = _float_corners(a), _float_corners(b)
        if fa is not None and fb is not None:
            a, b = fa, fb
        if a != b:  # an angle alone never changes: a rotation moves the corners
            if quarter_turn_steps(o[tid].get("corners"), n[tid].get("corners")) is not None or not names_edits_allowed(set_mode, role):
                _steps, err = orientation_turn(o[tid], n[tid], set_mode)
                if err:
                    errors.append(f"target {tid}: {TEST_SET_LOCKED}" if set_mode == "box" and role == "test"
                                  and quarter_turn_steps(o[tid].get("corners"), n[tid].get("corners")) is None else err)
                    continue
                turned = True
            else:
                edited = True
        for k in GEOMETRY_KEYS:
            if k == "corners" or (turned and k == "angle") or (edited and k in ("angle", "cornerSource")):
                continue  # checked above (a turn's angle by orientation_turn; an edit's below)
            a, b = o[tid].get(k), n[tid].get(k)
            if k == "estimated":
                a, b = [bool(v) for v in (a or [False] * 4)], [bool(v) for v in (b or [False] * 4)]
            elif k == "ignore":
                a, b = bool(a), bool(b)
            if a != b:
                errors.append(f"target {tid}: {k} changed: the identity pass never changes geometry")
        if o[tid].get("prefill") != n[tid].get("prefill"):
            errors.append(f"target {tid}: prefill changed: the identity pass keeps a model box's proposal")
        if edited:
            if not is_rectangle_box(n[tid].get("corners")):
                errors.append(f"target {tid}: corners changed into no rectangle: an edited box stays a box")
                continue
            # the stored corners are rounded to 0.1 px: on a short top edge that moves its direction
            # by up to atan(0.15 / length), so the tolerance grows as the edge shrinks
            d = math.degrees(math.atan2(fb[1][1] - fb[0][1], fb[1][0] - fb[0][0]))
            tol = 0.05 + math.degrees(math.atan(0.15 / max(1e-9, math.hypot(fb[1][0] - fb[0][0], fb[1][1] - fb[0][1]))))
            got = n[tid].get("angle")
            got = 0 if got is None else got
            if not (isinstance(got, (int, float)) and not isinstance(got, bool) and math.isfinite(got)
                    and abs(normalize_angle(d - got)) < tol):
                errors.append(f"target {tid}: angle {n[tid].get('angle')!r} is not the direction of its top edge ({round(d, 2)})")
                continue
            want = edit_provenance(o[tid], n[tid])
            for k in ("labelSource", "cornerSource"):
                if n[tid].get(k) != want[k]:
                    errors.append(f"target {tid}: {k} {n[tid].get(k)!r} after a box edit: the Boxes pass would record {want[k]!r}")
        # a model box's review state: only an edit may finalize it (pending / suggestion dropped, as
        # the Boxes pass does on an edit); nothing else adds, drops or changes them
        for k in ("pending", "suggestion"):
            if o[tid].get(k) != n[tid].get(k) and not (edited and k in o[tid] and k not in n[tid]):
                errors.append(f"target {tid}: {k} changed: only an edit of the box in this save may finalize a model's box")
        for k in PROVENANCE_KEYS:
            a, b = o[tid].get(k), n[tid].get(k)
            if k == "labelSource" and (edited or (a not in tracked and b not in tracked)):
                continue
            if a != b:
                errors.append(f"target {tid}: {k} changed: the identity pass keeps a carried/propagated/prefill box's provenance")
    return errors


def mark_orientation(old: dict, new: dict, set_mode: str | None = None) -> list:
    """After `geometry_changes` passed an identity-pass save: set `orientationFixedIn: "identify"`
    on every box whose top edge this save turned, and keep the mark on a box that had it (an undo
    that turns a box back still leaves it: the pass touched its orientation). The mark is the
    server's alone: one the page sends on an unturned, unmarked box is dropped. Mutates `new`'s
    targets; returns the ids turned by this save."""
    o = {t.get("id"): t for t in (old or {}).get("targets") or []}
    turned = []
    for t in (new or {}).get("targets") or []:
        ot = o.get(t.get("id"))
        if ot is None:
            continue
        now = set_mode == "box" and quarter_turn_steps(ot.get("corners"), t.get("corners")) is not None
        if now:
            turned.append(t.get("id"))
        if now or ot.get(ORIENTATION_MARK):
            t[ORIENTATION_MARK] = ot.get(ORIENTATION_MARK) or "identify"
        else:
            t.pop(ORIENTATION_MARK, None)
    return turned


def validate_recording(rec: dict) -> list:
    errors = []
    if not isinstance(rec, dict):
        return ["recording must be an object"]
    for key, values in RECORDING_ENUMS.items():
        v = rec.get(key)
        if v not in (None, "") and v not in values:
            errors.append(f"recording.{key} {v!r} not in {values}")
    for key in rec:
        if key not in RECORDING_ENUMS and key not in RECORDING_FREE:
            errors.append(f"recording.{key}: unknown tag")
    return errors


# ---- which entries of a catalog are one card -----------------------------------------------
#
# A catalog may state its rule at its top level: "identity": "name" (the rule when it states
# none) or "printing". Under "name", entries that share a name are printings of one card. Under
# "printing", an entry and the entries whose `printingOf` names it are one card, and entries that
# only share a name are different cards. The tool's other parts restate this rule (the
# catalog format is the repository's; this tool reads it on its own).

def identity_rule(doc):
    """The rule a catalog (the parsed file) states; "name" when it states none, None when what
    it states is no rule."""
    rule = doc.get("identity", IDENTITY_NAME) if isinstance(doc, dict) else IDENTITY_NAME
    return rule if rule in IDENTITY_RULES else None


def identity_rule_problem(doc):
    """Why a catalog's rule cannot be used, in one sentence, or None."""
    if identity_rule(doc) is None:
        return f'"identity" must be "{IDENTITY_NAME}" or "{IDENTITY_PRINTING}", not {json.dumps(doc.get("identity"))}'
    return None


# ---- a catalog's facets (the filters of the card list) ---------------------------------------
#
# A catalog may declare, beside each card's `kind`, the facets a card is filtered by: a top-level
# "facets": [{"key", "label", "values"?, "type"?}], and per card "facets": {key: value or list}.
# The repository's catalog format defines them (cardvision/core/catalog.py, "Facets"); this tool
# checks them on its own, by the same rules, so a bad catalog is refused at start.

FACET_KEY = re.compile(r"^[a-z][a-zA-Z0-9]*$")


def _finite(v) -> bool:
    """A number JSON can carry as a finite value (a huge integer overflows a float: not finite)."""
    try:
        return math.isfinite(v)
    except OverflowError:
        return False


def _facet_values_problem(values: list, kind, what: str):
    """(type, None) for a good list of facet values, or (None, the problem naming `what`)."""
    for n, v in enumerate(values):
        if not ((isinstance(v, str) and v.strip()) or (isinstance(v, (int, float)) and not isinstance(v, bool)
                                                         and _finite(v))):
            return None, f"{what}: {json.dumps(v)} is not a facet value (a non-empty string or a number)"
        t = "text" if isinstance(v, str) else "number"
        kind = kind or t
        if t != kind:
            return None, f"{what}: {json.dumps(v)} is not {'text' if kind == 'text' else 'a number'}"
        if v in values[:n]:
            return None, f"{what}: {json.dumps(v)} is listed twice"
    return kind, None


def facets_problem(doc):
    """Why a catalog's facets cannot be used, in one sentence, or None."""
    decls = doc.get("facets", []) if isinstance(doc, dict) else []
    if not isinstance(decls, list):
        return '"facets" must be a list of objects, each with a "key" and a "label"'
    known = {}
    for n, d in enumerate(decls):
        where = f"facets[{n}]"
        if not isinstance(d, dict) or "key" not in d or "label" not in d:
            return f'{where} must be an object with a "key" and a "label"'
        unknown = sorted(set(d) - {"key", "label", "values", "type"})
        if unknown:
            return f"{where}: unknown key(s) {', '.join(unknown)}"
        key = d["key"]
        if not isinstance(key, str) or not FACET_KEY.fullmatch(key):
            return f'{where}: "key" {json.dumps(key)} must be a lowercase letter, then letters and digits only'
        if key == "kind" or key in known:
            return f'{where}: "key" "{key}" is ' + ("reserved: the card's kind is always the first filter" if key == "kind" else "declared twice")
        if not isinstance(d["label"], str) or not d["label"].strip():
            return f'{where} ({key}): "label" must be a non-empty string'
        kind = d.get("type")
        if "type" in d and kind not in ("text", "number"):
            return f'{where} ({key}): "type" must be "text" or "number", not {json.dumps(kind)}'
        if "values" in d:
            if not isinstance(d["values"], list) or not d["values"]:
                return f'{where} ({key}): "values" must be a non-empty list'
            kind, problem = _facet_values_problem(d["values"], kind, f"{where} ({key}) values")
            if problem:
                return problem
        known[key] = [kind, d.get("values")]
    cards = doc.get("cards") if isinstance(doc, dict) else None
    for c in cards if isinstance(cards, list) else []:
        if not isinstance(c, dict) or "facets" not in c:
            continue
        where = f"card {c.get('id')}"
        if not isinstance(c["facets"], dict):
            return f'{where}: "facets" must be an object of facet key to a value or a list of values'
        for key, value in c["facets"].items():
            if key not in known:
                return f'{where}: facets.{key}: the catalog declares no facet "{key}"'
            values = value if isinstance(value, list) else [value]
            if not values:
                return f"{where}: facets.{key} is an empty list (leave the key out instead)"
            kind, problem = _facet_values_problem(values, known[key][0], f"{where}: facets.{key}")
            if problem:
                return problem
            known[key][0] = kind
            allowed = known[key][1]
            for v in values:
                if allowed is not None and v not in allowed:
                    return f"{where}: facets.{key}: {json.dumps(v)} is not one of the declared values"
    return None


# ---- a card's extra data ----------------------------------------------------------------------
#
# A card may carry "extra": an object of anything else its game keeps with it (rules text, rarity,
# an upstream id). The repository's catalog format defines it (cardvision/core/catalog.py); this
# tool reads none of it, and refuses a catalog whose "extra" is not an object, as the package does.

def extra_problem(doc):
    """Why a card's `extra` cannot be kept, in one sentence (the first such card), or None."""
    cards = doc.get("cards") if isinstance(doc, dict) else None
    for c in cards if isinstance(cards, list) else []:
        if isinstance(c, dict) and "extra" in c and not isinstance(c["extra"], dict):
            return f'card {c.get("id")}: "extra" must be an object (any keys and values), not {json.dumps(c["extra"])}'
    return None


def printing_roots(catalog: list) -> dict:
    """Card id → the card it is a printing of: its `printingOf`, followed to an entry that is a
    printing of none (an entry that is no printing is its own). The cards of `catalog` only."""
    parent = {c["id"]: c.get("printingOf") for c in catalog if isinstance(c, dict) and isinstance(c.get("id"), str)}
    out = {}
    for cid in parent:
        path, cur = [cid], cid
        while isinstance(parent.get(cur), str) and parent[cur] in parent and parent[cur] not in path:
            cur = parent[cur]
            path.append(cur)
        nxt = parent.get(cur)
        # entries that name each other in a ring (no catalog should) are one card, the lowest id
        out[cid] = min(path[path.index(nxt):]) if isinstance(nxt, str) and nxt in path else cur
    return out


def same_card(a_id, a_name, b_id, b_name, rule: str = IDENTITY_NAME, roots=None) -> bool:
    """Two answers (a card id and its name each) are the same card by the catalog's rule: under
    "name" their names agree (case, quotes and spacing aside); under "printing" both are printings
    of one card (`roots`: `printing_roots`)."""
    if rule == IDENTITY_PRINTING:
        roots = roots or {}
        return bool(a_id) and bool(b_id) and roots.get(a_id, a_id) == roots.get(b_id, b_id)
    return normalize_name(a_name) == normalize_name(b_name)


# ---- decklist ---------------------------------------------------------------------------------

_LEAD_COUNT_RE = re.compile(r"^(\d+)\s*[x×]?\s+(.+)$", re.IGNORECASE)
_TRAIL_COUNT_RE = re.compile(r"^(.+?)\s+(?:[x×]\s*(\d+)|\(\s*[x×]?\s*(\d+)\s*\))$", re.IGNORECASE)


def normalize_name(name: str) -> str:
    """Case, typographic quotes/dashes and runs of spaces only: two names are the same card name
    when these agree. No fuzzy matching (a decklist line either matches exactly or is reported)."""
    s = str(name or "")
    for a, b in (("\u2019", "'"), ("\u2018", "'"), ("\u201c", '"'), ("\u201d", '"'), ("\u2013", "-"), ("\u2014", "-")):
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip().casefold()


def split_count(line: str) -> tuple:
    """'3x Name', '3 Name', '3 x Name', 'Name x3', 'Name ×3', 'Name (3)', 'Name (x3)' → (count, entry);
    a line without a count → (None, line)."""
    line = line.strip()
    m = _LEAD_COUNT_RE.match(line)
    if m:
        return int(m.group(1)), m.group(2).strip()
    m = _TRAIL_COUNT_RE.match(line)
    if m:
        return int(m.group(2) or m.group(3)), m.group(1).strip()
    return None, line


def catalog_name_index(catalog: list) -> dict:
    """normalized name → every id with that name: base printings first, then the alternate
    printings (entries with `printingOf`), each group in id order."""
    out: dict = {}
    alternate = set()
    for c in catalog:
        n = normalize_name(c.get("name"))
        if n and c.get("id"):
            out.setdefault(n, []).append(c["id"])
            if c.get("printingOf"):
                alternate.add(c["id"])
    for n, ids in out.items():
        ids.sort(key=lambda i: (i in alternate, str(i)))
    return out


def resolve_entry(entry: str, by_id: dict, by_name: dict) -> list:
    """An id (case-insensitive) → [that id]; an exact name → every printing with that name; else []."""
    cid = by_id.get(entry.strip().upper())
    if cid:
        return [cid]
    return list(by_name.get(normalize_name(entry), []))


def parse_decklist(text: str, catalog: list) -> dict:
    """A text decklist (one card id or exact name per line; an optional count before (`3 `, `3x `)
    or after (` x3`, ` (3)`) the entry; blank lines and `#` comments ignored) resolved against the
    catalog: ids first (case-insensitive), then exact names (case, quotes and spacing aside).
    A name that several printings share resolves to ALL of them (the picker shows each; the
    labeler picks the one on screen) and is reported under `ambiguous`; nothing is guessed.
    Returns {ids (in list order, no duplicates), unresolved (the lines that matched nothing),
    ambiguous [{line, ids}], counts {id: count as written}}."""
    by_id = {str(c.get("id") or "").upper(): c.get("id") for c in catalog if c.get("id")}
    by_name = catalog_name_index(catalog)
    ids, unresolved, ambiguous, counts = [], [], [], {}
    for raw in (text or "").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        n, entry = split_count(line)
        found = resolve_entry(entry, by_id, by_name)
        if not found and n is not None:  # a name that itself ends in a number-like token
            found = resolve_entry(line, by_id, by_name)
            n = None if found else n
        if not found:
            unresolved.append(raw.strip())
            continue
        if len(found) > 1:
            ambiguous.append({"line": raw.strip(), "ids": found})
        for cid in found:
            if cid not in ids:
                ids.append(cid)
            if n is not None:
                counts[cid] = counts.get(cid, 0) + n
    return {"ids": ids, "unresolved": unresolved, "ambiguous": ambiguous, "counts": counts}


def decklist_label(text: str, default: str) -> str:
    """The list's label: a `# label: …` or `# player: …` line, else `default`."""
    for raw in (text or "").splitlines():
        m = re.match(r"^\s*#\s*(?:label|player)\s*:\s*(.+?)\s*$", raw, re.IGNORECASE)
        if m:
            return m.group(1)
    return default


def strip_answers(item: dict, mode: str) -> dict:
    """A labeled point/target with every answer removed (for a consistency-repeat set): the
    point's position, or the target's corners, stay; outcome, identity, provenance, eligibility,
    conditions and label source go."""
    if mode == "point":
        return {"i": item["i"], "x": item["x"], "y": item["y"]}
    out = {"id": item["id"], "corners": item["corners"], "estimated": item.get("estimated") or [False] * 4}
    if mode == "box":
        out["cornerSource"] = BOX_QUAD_SOURCE if item.get("cornerSource") == BOX_QUAD_SOURCE else "box"
        if item.get("angle"):
            out["angle"] = item["angle"]
    return out
