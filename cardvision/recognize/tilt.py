# SPDX-License-Identifier: Apache-2.0
"""The tilted retry: a second chance for a face crop that is not accepted because its card is tilted.

A detector box is axis-aligned. When the card inside it is turned by a few degrees, the crop holds
the card at that angle plus the corners of whatever lies around it, and the embedding may then not
reach the accept rule. The tilted retry estimates the card's in-plane tilt from the edges of the
crop, cuts three tight, straightened rectangles out of the frame, and gives each one look.

Where it runs
-------------
On a face whose shipped crop the accept rule did not accept, after the turned looks and after a
geometric stage, if any (``Recognizer.recognize``). A face that is already named is never touched.
A release turns it on with its ``tiltedRetry`` block (``TiltedRetry``); without the block it is off.

The steps
---------
1. **The tilt** (``estimate_tilt``). The crop is shrunk to at most 128 pixels a side by averaging
   whole blocks, turned grey, and differentiated with a 3 x 3 Sobel filter. In the outer band of
   the crop, where the card's outline lies, the strongest quarter of the gradients vote for their
   direction modulo 90 degrees, each with its magnitude. The votes are smoothed around the circle
   and the peak, refined by a parabola, is folded to (-45, 45]. The fold means a sideways card and
   an upright one give the same tilt; the quarter turn is left to the look (step 3).
2. **The rectangles** (``rect_from_aabb``, ``sample_rect``). The card's sides are solved from the
   box's width and height and the tilt; when that is ill-posed (near 45 degrees) or gives a shape
   unlike a card, the card-aspect prior is fitted instead. Rectangles at 0.95, 1.0 and 1.05 times
   that size, centered on the box and turned by the tilt, are sampled from the frame bilinearly,
   black outside it, and go through the recognizer's own preprocessing.
3. **One look each.** Each rectangle is embedded in the orientation of the crop's best look (the
   look with the highest score among the four, the first on ties), the same tensor rotation the
   turned looks use. That is three embeddings per face.
4. **The decision.** A rectangle passes when its look passes the release's accept rule, unchanged.
   If none passes the face stays as it was; otherwise the passing rectangle with the highest score
   names it, the earlier scale winning ties.

The arithmetic follows the measurement that validated the method: the shrunk copy, the gradients
and the vote weights are 32-bit floats, and the sampler works in 64-bit floats and rounds half up.
One step departs from it: each gradient's direction is computed in 64 bits and then rounded to 32,
where the measurement used NumPy's 32-bit arctangent. That one is not correctly rounded on every
platform, and its last bit moves the tilt of a nearly upright card by up to about 0.1 degree; the
correctly rounded value is the same everywhere, and is what the browser runtime computes. An
exactly axis-aligned card reads +0.5 degrees, because the vote's bins are centered on half
degrees; that is what was measured, and it is kept.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

# The shape of the card the prior assumes: short side over long side. It is the same for every
# game and only matters when the exact solve is not used (near 45 degrees, or an unlikely shape).
CARD_ASPECT = 63.0 / 88.0

TILT_MAX_SIDE = 128
TILT_BINS = 90
TILT_TOP_FRACTION = 0.25
TILT_BORDER = 0.2
TILT_SMOOTH_BINS = 2.0
TILT_MIN_SIDE = 8

# The exact solve is trusted while cos^2 - sin^2 of the tilt is above this (|tilt| below ~34.7 degrees)
# and the solved sides have a card's shape.
EXACT_MIN_DEN = 0.35
EXACT_ASPECT = (0.55, 0.90)

DEFAULT_SCALES = (0.95, 1.0, 1.05)
DEFAULT_MAX_FACES_PER_FRAME = 8
DEFAULT_BUDGET_MS = 1500

TILTED_RETRY_KEYS = ("scales", "maxFacesPerFrame", "budgetMs")


def fold(degrees: float) -> float:
    """An angle in degrees folded to (-45, 45] modulo 90."""
    folded = degrees - 90.0 * math.ceil((degrees - 45.0) / 90.0)
    return 45.0 if folded <= -45.0 else folded


def _downscale(rgb: np.ndarray, max_side: int) -> np.ndarray:
    """The crop as 32-bit floats, shrunk by the whole factor that brings its longer side to at most
    ``max_side``: the bottom and right remainders are dropped and k x k blocks averaged."""
    height, width = rgb.shape[:2]
    k = max(1, int(math.ceil(max(height, width) / max_side)))
    if k == 1:
        return rgb.astype(np.float32)
    h2, w2 = height // k, width // k
    return rgb[:h2 * k, :w2 * k].reshape(h2, k, w2, k, -1).astype(np.float32).mean((1, 3))


def _grey(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def _sobel(grey: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """3 x 3 Sobel gradients with the edge pixels repeated outward, x to the right and y down."""
    p = np.pad(grey, 1, mode="edge")
    gx = (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    gy = (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    return gx, gy


def estimate_tilt(crop: np.ndarray) -> float:
    """The in-plane tilt, in degrees in (-45, 45], of the card in an ``(H, W, 3)`` uint8 RGB crop.

    The crop is the shipped crop of a detector box. A crop that is under 8 pixels on a side once
    shrunk, or that has no edges at all, gives 0. Image coordinates, y down: a card whose top edge
    runs along the direction ``atan2(dy, dx) = theta`` gives ``fold(theta)``.
    """
    grey = _grey(_downscale(np.asarray(crop), TILT_MAX_SIDE))
    if min(grey.shape) < TILT_MIN_SIDE:
        return 0.0
    gx, gy = _sobel(grey)
    gx, gy = gx[1:-1, 1:-1], gy[1:-1, 1:-1]
    hh, ww = gx.shape
    yy, xx = np.mgrid[0:hh, 0:ww]
    distance = np.minimum(np.minimum(xx, ww - 1 - xx) / ww, np.minimum(yy, hh - 1 - yy) / hh)
    band = (distance <= TILT_BORDER).ravel()
    magnitude = np.where(band, np.hypot(gx, gy).ravel(), 0.0)
    if magnitude.max() <= 0:
        return 0.0
    threshold = np.quantile(magnitude[band], 1.0 - TILT_TOP_FRACTION)
    strong = (magnitude >= threshold) & band & (magnitude > 0)
    # The arctangent is taken in float64 and rounded to float32 (see the module's description).
    angle = np.degrees(np.arctan2(gy.ravel()[strong].astype(np.float64), gx.ravel()[strong].astype(np.float64))
                       .astype(np.float32)) % 90.0
    bins = np.minimum((angle / 90.0 * TILT_BINS).astype(int), TILT_BINS - 1)
    votes = np.bincount(bins, weights=magnitude[strong], minlength=TILT_BINS)
    radius = int(math.ceil(3 * TILT_SMOOTH_BINS))
    kernel = np.exp(-0.5 * (np.arange(-radius, radius + 1) / TILT_SMOOTH_BINS) ** 2)
    smoothed = sum(kernel[j + radius] * np.roll(votes, j) for j in range(-radius, radius + 1))
    i = int(np.argmax(smoothed))
    left, right = smoothed[(i - 1) % TILT_BINS], smoothed[(i + 1) % TILT_BINS]
    den = left - 2 * smoothed[i] + right
    shift = 0.5 * (left - right) / den if den != 0 else 0.0
    peak = ((i + 0.5 + shift) * 90.0 / TILT_BINS) % 90.0
    return fold(float(peak))


def rect_from_aabb(width: float, height: float, tilt: float) -> tuple[float, float, str]:
    """The sides ``(w, h)`` of a card turned by ``tilt`` degrees whose bounding box is ``width`` x
    ``height``, and how they were found: ``"exact"`` or ``"prior"``.

    ``w`` runs along the tilted top edge. The exact solve of ``width = w c + h s``, ``height = w s +
    h c`` is used while it is well posed and gives a card-like shape; otherwise the card-aspect
    prior, portrait or landscape, whichever fits the box better, is scaled to it by least squares.
    """
    t = math.radians(abs(tilt))
    c, s = math.cos(t), math.sin(t)
    den = c * c - s * s
    if den > EXACT_MIN_DEN:
        w = (width * c - height * s) / den
        h = (height * c - width * s) / den
        if w > 0 and h > 0 and EXACT_ASPECT[0] <= min(w, h) / max(w, h) <= EXACT_ASPECT[1]:
            return w, h, "exact"
    best: tuple[float, float, float] | None = None
    for ratio in (CARD_ASPECT, 1.0 / CARD_ASPECT):  # w = ratio * h
        bw, bh = ratio * c + s, ratio * s + c
        k = (width * bw + height * bh) / (bw * bw + bh * bh)
        residual = (width - k * bw) ** 2 + (height - k * bh) ** 2
        if best is None or residual < best[0]:
            best = (residual, ratio * k, k)
    assert best is not None
    return best[1], best[2], "prior"


def _bilinear(rgb: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """``rgb`` sampled at fractional pixel coordinates (pixel centers at integer + 0.5), black
    outside the frame, rounded half up to uint8."""
    frame_height, frame_width = rgb.shape[:2]
    x, y = xs - 0.5, ys - 0.5
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    pixels = rgb.astype(np.float32)

    def tap(yy: np.ndarray, xx: np.ndarray) -> np.ndarray:
        inside = (yy >= 0) & (yy < frame_height) & (xx >= 0) & (xx < frame_width)
        out = pixels[np.clip(yy, 0, frame_height - 1), np.clip(xx, 0, frame_width - 1)]
        out[~inside] = 0
        return out

    value = (tap(y0, x0) * (1 - fx) * (1 - fy) + tap(y0, x0 + 1) * fx * (1 - fy) + tap(y0 + 1, x0) * (1 - fx) * fy
             + tap(y0 + 1, x0 + 1) * fx * fy)
    return np.clip(np.floor(value + 0.5), 0, 255).astype(np.uint8)


def sample_rect(frame: np.ndarray, cx: float, cy: float, width: float, height: float, tilt: float) -> np.ndarray:
    """The ``(round(height), round(width), 3)`` uint8 RGB rectangle of ``frame`` centered on
    ``(cx, cy)`` and turned by ``tilt`` degrees, its first axis along the turned top edge.

    Each side is at least 2 pixels. Output pixel ``(j, i)`` is the frame at ``u = j + 0.5 - ow/2``,
    ``v = i + 0.5 - oh/2`` turned by the tilt about the center. Sides are rounded half to even.
    """
    out_w, out_h = max(2, int(round(width))), max(2, int(round(height)))
    a = math.radians(tilt)
    c, s = math.cos(a), math.sin(a)
    u = (np.arange(out_w, dtype=np.float64) + 0.5 - out_w / 2)[None, :]
    v = (np.arange(out_h, dtype=np.float64) + 0.5 - out_h / 2)[:, None]
    xs = cx + u * c - v * s
    ys = cy + u * s + v * c
    return np.ascontiguousarray(_bilinear(np.asarray(frame), xs, ys))


def tilted_rects(frame: np.ndarray, box: Sequence[float], crop: np.ndarray,
                 scales: Sequence[float] = DEFAULT_SCALES) -> tuple[float, list[np.ndarray]]:
    """The tilt of the card in ``box`` and the straightened rectangles at ``scales``, in that order.

    ``box`` is the detector box ``(x, y, width, height)`` in ``frame``'s pixels, unrounded, and
    ``crop`` the shipped crop it gave (``crop_truncated``).
    """
    x, y, width, height = (float(value) for value in box)
    tilt = estimate_tilt(crop)
    w, h, _ = rect_from_aabb(width, height, tilt)
    cx, cy = x + width / 2, y + height / 2
    return tilt, [sample_rect(frame, cx, cy, w * scale, h * scale, tilt) for scale in scales]


@dataclass(frozen=True)
class TiltedOutcome:
    """What the tilted retry did with one crop.

    Attributes:
        tilt: the estimated tilt, in degrees.
        scale: the scale of the rectangle that named the card, or ``None`` when none passed.
        top_id, similarity, margin: the crop's answer before the retry.
    """

    tilt: float
    scale: float | None
    top_id: str
    similarity: float
    margin: float

    def to_json(self) -> dict[str, Any]:
        return {"tilt": round(self.tilt, 6), "scale": self.scale, "before": {
            "topId": self.top_id, "similarity": round(self.similarity, 6), "margin": round(self.margin, 6)}}


@dataclass(frozen=True)
class TiltedRetry:
    """A release's ``tiltedRetry`` block: the tilted retry is on, with these settings.

    Attributes:
        scales: the sizes of the rectangles, relative to the solved card, in the order they are
            tried; on equal scores the earlier one wins.
        max_faces_per_frame: at most this many faces of one frame are retried (the browser
            runtime's cap, faces under the pointer first; the Python pipeline retries every face).
        budget_ms: the browser runtime turns the retry off for the session when it takes more
            than this of a frame on two frames in a row.
    """

    scales: tuple[float, ...] = DEFAULT_SCALES
    max_faces_per_frame: int = DEFAULT_MAX_FACES_PER_FRAME
    budget_ms: int = DEFAULT_BUDGET_MS

    def to_json(self) -> dict[str, Any]:
        return {"scales": list(self.scales), "maxFacesPerFrame": self.max_faces_per_frame, "budgetMs": self.budget_ms}


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_whole(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def tilted_retry_errors(block: Any, where: str = "tiltedRetry") -> list[str]:
    """Every reason ``block`` is not a valid ``tiltedRetry`` block; empty when it is."""
    if not isinstance(block, Mapping):
        return [f"{where} must be an object"]
    errors = []
    unknown = sorted(set(block) - set(TILTED_RETRY_KEYS))
    if unknown:
        errors.append(f"{where} has unknown key(s) {', '.join(unknown)} (expected {', '.join(TILTED_RETRY_KEYS)})")
    scales = block.get("scales")
    if (not isinstance(scales, list) or not 1 <= len(scales) <= 5
            or not all(_is_number(scale) and 0.5 <= scale <= 1.5 for scale in scales)):
        errors.append(f"{where}.scales must list 1 to 5 numbers from 0.5 to 1.5")
    if not _is_whole(block.get("maxFacesPerFrame")) or block["maxFacesPerFrame"] < 1:
        errors.append(f"{where}.maxFacesPerFrame must be a whole number above 0")
    if not _is_whole(block.get("budgetMs")) or block["budgetMs"] < 1:
        errors.append(f"{where}.budgetMs must be a whole number above 0")
    return errors


def parse_tilted_retry(block: Any, where: str = "tiltedRetry") -> TiltedRetry:
    """Read a ``tiltedRetry`` block; raises ``ValueError`` with every reason when it is invalid."""
    errors = tilted_retry_errors(block, where)
    if errors:
        raise ValueError("; ".join(errors))
    return TiltedRetry(scales=tuple(float(scale) for scale in block["scales"]),
                       max_faces_per_frame=block["maxFacesPerFrame"], budget_ms=block["budgetMs"])
