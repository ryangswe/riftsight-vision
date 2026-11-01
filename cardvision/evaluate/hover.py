# SPDX-License-Identifier: Apache-2.0
"""The hover rule: what a pointer resting at one position of a frame would show.

A frame's detections are the face boxes the pipeline reports, each with the recognizer's
conclusion. The rule has three parts, and they are the browser runtime's:

**Which boxes take part, and how they stack.** A release names one of three selections.

* ``accepted-nms``: the boxes whose chosen look reaches ``tau``, after a suppression pass that
  ignores identity: boxes are visited by similarity, highest first (on equal similarity an
  upright look before a turned one, then detector order), and a box is kept unless it overlaps
  a kept box by ``ACCEPTED_NMS_IOU`` or more. Among the kept boxes the **smallest is on top**
  (on equal area the higher similarity, then the earlier box).
* ``best-score``: every box; the higher similarity is on top (then the smaller box, then the
  earlier one).
* ``detector-score``: every box; the higher detector score is on top (then the earlier one).

**Which box the pointer hits.** The topmost box that contains the point. Containment is the
runtime's hit test: the box is expressed as fractions of the frame, each of the four numbers
clamped to 0..1, turned back into a four-corner outline in pixels, and the point is inside when
it lies on the same side of all four edges. A point exactly on an edge is inside.

**What is shown.** The hit box's name, if its look is accepted (``tau`` and the margin
``delta``); otherwise nothing. A box that takes part but fails the margin still wins the
pointer and shows nothing: it hides whatever lies beneath it.

Card backs are never candidates: the detector reports them and nothing is shown for them.
"""

from __future__ import annotations

import functools
from collections.abc import Sequence
from dataclasses import dataclass

from cardvision.infer.pipeline import FrameResult

Box = tuple[float, float, float, float]  # x, y, width, height in frame pixels

ACCEPTED_NMS = "accepted-nms"
BEST_SCORE = "best-score"
DETECTOR_SCORE = "detector-score"
SELECTIONS = (ACCEPTED_NMS, BEST_SCORE, DETECTOR_SCORE)

# In the accepted-nms selection, a box that overlaps an already kept box by this much is dropped.
ACCEPTED_NMS_IOU = 0.3


@dataclass(frozen=True)
class Proposal:
    """One face box of a frame, with what the hover rule needs to know about it.

    Attributes:
        box: ``(x, y, width, height)`` in frame pixels.
        detector_score: the detector's score.
        similarity: the chosen look's score.
        look: the chosen orientation (0 upright).
        tau_passed: whether the similarity reaches ``tau``.
        accepted: whether the look is accepted (``tau`` and the margin).
        name: the card's name when accepted, else ``None``.
        card_id: the matched printing when accepted, else ``None``.
        top_name: the best bank row's name, accepted or not.
        tilted: whether a rectangle of the tilted retry named the card. Such a face enters the
            suppression with the turned looks, whatever its look.
    """

    box: Box
    detector_score: float
    similarity: float
    look: int
    tau_passed: bool
    accepted: bool
    name: str | None
    card_id: str | None = None
    top_name: str | None = None
    tilted: bool = False


def proposals_of(result: FrameResult) -> list[Proposal]:
    """The hover candidates of an analyzed frame: its faces, in detector order."""
    out = []
    for card in result.faces:
        found = card.recognition
        out.append(Proposal(box=tuple(card.box), detector_score=card.score, similarity=found.similarity,
                            look=found.look, tau_passed=found.tau_passed, accepted=found.accepted,
                            name=found.name, card_id=found.card_id, top_name=found.top_name,
                            tilted=found.named_by_tilt))
    return out


def box_iou(a: Box, b: Box) -> float:
    """Intersection over union of two ``(x, y, width, height)`` boxes; 0 when they do not overlap."""
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    inter = (x1 - x0) * (y1 - y0)
    return inter / (a[2] * a[3] + b[2] * b[3] - inter)


def kept_after_nms(proposals: Sequence[Proposal], iou: float = ACCEPTED_NMS_IOU) -> list[int]:
    """The members of the ``accepted-nms`` selection, as indices into ``proposals``, in the
    order they were kept."""
    upright = [i for i, p in enumerate(proposals) if p.tau_passed and p.look == 0 and not p.tilted]
    turned = [i for i, p in enumerate(proposals) if p.tau_passed and (p.look != 0 or p.tilted)]
    kept: list[int] = []
    for i in sorted(upright + turned, key=lambda i: -proposals[i].similarity):  # stable
        if all(box_iou(proposals[i].box, proposals[k].box) < iou for k in kept):
            kept.append(i)
    return kept


def hover_order(proposals: Sequence[Proposal], selection: str = ACCEPTED_NMS) -> list[int]:
    """The selection's members as indices into ``proposals``, bottom of the stack first."""
    if selection not in SELECTIONS:
        raise ValueError(f"unknown hover selection {selection!r}; expected one of {list(SELECTIONS)}")
    members = kept_after_nms(proposals) if selection == ACCEPTED_NMS else list(range(len(proposals)))

    def area(i: int) -> float:
        return proposals[i].box[2] * proposals[i].box[3]

    def below(a: int, b: int) -> int:
        """Negative when ``a`` is stacked below ``b``."""
        if selection == DETECTOR_SCORE:
            da, db = proposals[a].detector_score, proposals[b].detector_score
            if da != db:
                return -1 if da < db else 1
            return b - a
        by_area = area(b) - area(a)  # the larger box is below
        by_score = proposals[a].similarity - proposals[b].similarity  # the lower similarity is below
        primary, secondary = (by_area, by_score) if selection == ACCEPTED_NMS else (by_score, by_area)
        if primary != 0:
            return -1 if primary < 0 else 1
        if secondary != 0:
            return -1 if secondary < 0 else 1
        return b - a  # the earlier box is on top

    return sorted(members, key=functools.cmp_to_key(below))


# ------------------------------------------------------------------------------- the hit test
def _clamp01(value: float) -> float:
    return 0.0 if value < 0 else 1.0 if value > 1 else value


def hitbox_quad(box: Box, frame_width: float, frame_height: float) -> list[tuple[float, float]]:
    """The four corners, in frame pixels, of the outline the runtime tests a pointer against.

    The box goes through the runtime's own representation: fractions of the frame, each clamped
    to 0..1, a center and a half size, and back to pixels. The corners run top-left, top-right,
    bottom-right, bottom-left.
    """
    x, y, width, height = box
    left, top = _clamp01(x / frame_width), _clamp01(y / frame_height)
    wide, tall = _clamp01(width / frame_width), _clamp01(height / frame_height)
    center_x, center_y = left + wide / 2, top + tall / 2
    left, top = center_x - wide / 2, center_y - tall / 2
    cx, cy = (left + wide / 2) * frame_width, (top + tall / 2) * frame_height
    half_w, half_h = wide / 2 * frame_width, tall / 2 * frame_height
    return [(cx - half_w, cy - half_h), (cx + half_w, cy - half_h), (cx + half_w, cy + half_h), (cx - half_w, cy + half_h)]


def point_in_convex_quad(px: float, py: float, quad: Sequence[tuple[float, float]]) -> bool:
    """Whether a point is inside a convex outline: on the same side of every edge. A point on an
    edge is inside."""
    sign = 0
    for i in range(len(quad)):
        ax, ay = quad[i]
        bx, by = quad[(i + 1) % len(quad)]
        cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
        if cross == 0:
            continue
        current = 1 if cross > 0 else -1
        if sign == 0:
            sign = current
        elif current != sign:
            return False
    return True


def hit(box: Box, px: float, py: float, frame_width: float, frame_height: float) -> bool:
    """Whether a pointer at ``(px, py)`` frame pixels is on ``box``, by the runtime's hit test."""
    return point_in_convex_quad(px, py, hitbox_quad(box, frame_width, frame_height))


# --------------------------------------------------------------------------------- resolution
@dataclass(frozen=True)
class Shown:
    """What the pointer resolves to.

    Attributes:
        index: the hit box's position in the frame's proposals, or ``None`` when no box is hit.
        box: the hit box.
        name: the name shown, or ``None`` when nothing is shown (no box, or a box that is not
            accepted).
        card_id: the printing shown.
    """

    index: int | None = None
    box: Box | None = None
    name: str | None = None
    card_id: str | None = None


NOTHING_HIT = Shown()


class HoverLayer:
    """One frame's hover candidates, stacked once and asked many times."""

    def __init__(self, proposals: Sequence[Proposal], frame_width: float, frame_height: float,
                 selection: str = ACCEPTED_NMS) -> None:
        self.proposals = list(proposals)
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.selection = selection
        self.order = hover_order(self.proposals, selection)
        self._quads = {i: hitbox_quad(self.proposals[i].box, frame_width, frame_height) for i in self.order}

    @classmethod
    def of(cls, result: FrameResult, selection: str = ACCEPTED_NMS) -> HoverLayer:
        """The hover layer of an analyzed frame."""
        return cls(proposals_of(result), result.frame_width, result.frame_height, selection)

    def at(self, px: float, py: float) -> Shown:
        """What a pointer at ``(px, py)`` frame pixels shows."""
        for i in reversed(self.order):
            if point_in_convex_quad(px, py, self._quads[i]):
                proposal = self.proposals[i]
                shown = proposal.accepted
                return Shown(index=i, box=proposal.box, name=proposal.name if shown else None,
                             card_id=proposal.card_id if shown else None)
        return NOTHING_HIT


def resolve(proposals: Sequence[Proposal], px: float, py: float, frame_width: float, frame_height: float,
            selection: str = ACCEPTED_NMS) -> Shown:
    """``HoverLayer(...).at(px, py)`` in one call."""
    return HoverLayer(proposals, frame_width, frame_height, selection).at(px, py)
