# SPDX-License-Identifier: Apache-2.0
"""From a frame to boxes and names: one detector run, then one recognition of the faces.

The order of operations is fixed, because the accept rule was calibrated on crops produced
exactly this way:

1. the frame is brought to the analysis width (``cardvision.infer.frames.analysis_frame``);
2. the detector runs once on the analysis frame;
3. a detection whose crop would be under the minimum size on either side is dropped;
4. a face's box is clipped to the analysis frame and cut out with the truncation convention
   (``cardvision.recognize.crops``); backs are reported and not cropped;
5. the recognizer names the crops;
6. each remaining box is scaled to the original frame's pixels and clipped to that frame: this
   is the reported box.

No box is rounded on the way. Steps 3 and 4 use the box as the detector decoded it, and so does
the browser runtime (``browser/src/pipeline.ts``), so the two cut the same pixels. A box is
rounded to three decimals only where it is printed or written (``reported_box``).

``Pipeline.analyze_looks`` stops before the two thresholds: it runs steps 1 to 4, computes every
face's looks in all the orientations the accept rule allows, and returns a ``FrameLooks`` that
gives the frame's result under any ``tau`` and ``delta`` without running a model again.
``cardvision calibrate`` scores many pairs that way.
"""

from __future__ import annotations

import dataclasses
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from cardvision.core.catalog import Catalog
from cardvision.core.constants import DETECTOR_FACE_CLASS, DETECTOR_MIN_CROP_PX
from cardvision.core.onnx import DEFAULT_PROVIDERS
from cardvision.detect import Detection, Detector, class_name
from cardvision.infer.frames import MAX_ANALYSIS_WIDTH, MIN_ANALYSIS_WIDTH, Frame, analysis_frame
from cardvision.recognize import AcceptRule, Look, Recognition, Recognizer, crop_truncated, large_enough

Box = tuple[float, float, float, float]  # x, y, width, height


@dataclass(frozen=True)
class Card:
    """One detected card in a frame.

    Attributes:
        index: its position in the frame's list (detector score order, best first).
        box: ``(x, y, width, height)`` in the original frame's pixels, clipped to the frame and
            not rounded (``reported_box`` rounds it for output).
        score: the detector's score.
        cls: the detector's class index (0 face, 1 back).
        recognition: what the recognizer concluded, for a face; ``None`` for a back.
        crop: the pixels the recognizer was given, for a face; ``None`` for a back.
    """

    index: int
    box: Box
    score: float
    cls: int
    recognition: Recognition | None = None
    crop: np.ndarray | None = field(default=None, compare=False, repr=False)

    @property
    def is_face(self) -> bool:
        return self.cls == DETECTOR_FACE_CLASS

    @property
    def class_name(self) -> str:
        return class_name(self.cls)


@dataclass(frozen=True)
class FrameResult:
    """Everything found in one frame.

    ``best_score`` is the highest score the detector gave anything in the frame, before its
    threshold (``None`` for a detector that does not report it), and ``too_small`` the number
    of boxes that were dropped for their crop size. They explain a frame with no cards and are
    not part of ``to_json``.
    """

    name: str
    source: str
    t: float
    frame_width: int
    frame_height: int
    analysis_width: int
    analysis_height: int
    cards: tuple[Card, ...]
    ms: float
    best_score: float | None = None
    too_small: int = 0

    @property
    def faces(self) -> list[Card]:
        """The cards that were cropped and passed to the recognizer."""
        return [card for card in self.cards if card.recognition is not None]

    def to_json(self) -> dict[str, Any]:
        """The frame as the JSON object the command line prints, one per line."""
        return {
            "source": self.source,
            "frame": self.name,
            "t": self.t,
            "frameW": self.frame_width,
            "frameH": self.frame_height,
            "analysisW": self.analysis_width,
            "analysisH": self.analysis_height,
            "boxes": [card_json(card) for card in self.cards],
        }


def card_json(card: Card) -> dict[str, Any]:
    """One card as a JSON object. A face carries the recognizer's fields; a back does not."""
    out: dict[str, Any] = {
        "i": card.index,
        "box": reported_box(card.box),
        "score": round(card.score, 6),
        "class": card.class_name,
    }
    found = card.recognition
    if found is not None:
        out.update({
            "outcome": found.outcome,
            "name": found.name,
            "cardId": found.card_id,
            "topId": found.top_id,
            "topName": found.top_name,
            "similarity": round(found.similarity, 6),
            "margin": round(found.margin, 6),
            "look": found.look,
            "retried": found.retried,
            "tauPassed": found.tau_passed,
            "accepted": found.accepted,
        })
        if found.geometric is not None:
            out["geometric"] = found.geometric.to_json()
        if found.tilted is not None:
            out["tilted"] = found.tilted.to_json()
    return out


def frame_box(detection: Detection, scale_x: float, scale_y: float, frame_width: int, frame_height: int) -> Box:
    """A detection's box in a frame of the same picture: scaled and clipped, not rounded.

    With both scales 1 the frame is the one the detector analyzed, and a box that lies inside
    it is returned as it is. The browser runtime clips in the same way, so there the two boxes
    are the same to the last bit.
    """
    x, y, width, height = detection.box
    if scale_x == 1 and scale_y == 1 and x >= 0 and y >= 0 and x + width <= frame_width and y + height <= frame_height:
        return (x, y, width, height)
    x0 = max(0.0, x * scale_x)
    y0 = max(0.0, y * scale_y)
    x1 = min(frame_width, (x + width) * scale_x)
    y1 = min(frame_height, (y + height) * scale_y)
    return (x0, y0, max(0.0, x1 - x0), max(0.0, y1 - y0))


def reported_box(box: Sequence[float]) -> list[float]:
    """A box as it is printed and written: its four numbers rounded to three decimals.

    Rounding is for output only. A crop is never cut from a rounded box, and no pointer is
    tested against one.
    """
    return [round(float(value), 3) for value in box]


@dataclass(frozen=True)
class _Cut:
    """One frame after the detector: its sizes, the valid detections in the analysis frame, each
    face's crop and the box it was cut from by its position among the detections, and the analysis
    frame itself (the tilted retry samples it)."""

    frame_width: int
    frame_height: int
    analysis_width: int
    analysis_height: int
    detections: list[Detection]
    crops: dict[int, np.ndarray]
    too_small: int
    best_score: float | None
    analyzed: np.ndarray = field(repr=False)
    boxes: dict[int, Box] = field(default_factory=dict, repr=False)

    def result(self, recognitions: Mapping[int, Recognition], crops: Mapping[int, np.ndarray], name: str, source: str,
               t: float, started: float) -> FrameResult:
        """Step 6: the frame's result, each box scaled to the original frame and clipped."""
        scale_x, scale_y = self.frame_width / self.analysis_width, self.frame_height / self.analysis_height
        cards = tuple(
            Card(
                index=index,
                box=frame_box(detection, scale_x, scale_y, self.frame_width, self.frame_height),
                score=detection.score,
                cls=detection.cls,
                recognition=recognitions.get(index),
                crop=crops.get(index),
            )
            for index, detection in enumerate(self.detections)
        )
        return FrameResult(
            name=name,
            source=source,
            t=t,
            frame_width=self.frame_width,
            frame_height=self.frame_height,
            analysis_width=self.analysis_width,
            analysis_height=self.analysis_height,
            cards=cards,
            ms=round((time.perf_counter() - started) * 1000, 1),
            best_score=self.best_score,
            too_small=self.too_small,
        )


@dataclass(frozen=True)
class FrameLooks:
    """One analyzed frame before the two thresholds are applied (``Pipeline.analyze_looks``).

    Attributes:
        frame: the frame's boxes, as ``Pipeline.analyze`` reports them, with no recognition yet.
        looks: for each face, by its ``Card.index``, its looks, upright first: all four, or
            the upright one alone when the recognizer's rule does not try the turned looks.
        recognizer: the recognizer that made the looks, which turns them into a recognition.
    """

    frame: FrameResult
    looks: Mapping[int, tuple[Look, ...]]
    recognizer: Recognizer = field(repr=False)

    def under(self, rule: AcceptRule) -> FrameResult:
        """The frame as ``Pipeline.analyze`` reports it when the recognizer holds ``rule``.

        Each face's recognition comes from ``Recognizer.decide``: the same orientation rule and
        the same accept rule, applied to looks that are already known. ``rule`` may differ from
        the recognizer's own in ``tau`` and ``delta``; its ``rotation_retry`` must be the same,
        because that decided which looks were computed. The recognitions carry no candidates
        and the cards no crop.
        """
        if rule.rotation_retry != self.recognizer.rule.rotation_retry:
            raise ValueError("the looks were computed for a rule with another rotation_retry setting")
        cards = tuple(
            dataclasses.replace(card, recognition=self.recognizer.decide(self.looks[card.index], rule))
            if card.index in self.looks else card
            for card in self.frame.cards
        )
        return dataclasses.replace(self.frame, cards=cards)


class Pipeline:
    """A detector and a recognizer, applied to frames."""

    def __init__(
        self,
        detector: Detector,
        recognizer: Recognizer,
        *,
        min_width: int = MIN_ANALYSIS_WIDTH,
        max_width: int = MAX_ANALYSIS_WIDTH,
        min_crop_px: int = DETECTOR_MIN_CROP_PX,
    ) -> None:
        self.detector = detector
        self.recognizer = recognizer
        self.min_width = min_width
        self.max_width = max_width
        self.min_crop_px = min_crop_px

    @classmethod
    def open(
        cls,
        detector_path: str | Path,
        recognizer_path: str | Path,
        bank_path: str | Path,
        catalog: Catalog,
        rule: AcceptRule = AcceptRule(),
        *,
        providers: Sequence[str] = DEFAULT_PROVIDERS,
    ) -> Pipeline:
        """Open the two models and the bank."""
        return cls(
            Detector.open(detector_path, providers=providers),
            Recognizer.open(recognizer_path, bank_path, catalog, rule, providers=providers),
        )

    def valid_detections(self, analyzed: np.ndarray) -> list[Detection]:
        """Steps 2 and 3: the detector's boxes for an analysis frame, in that frame's pixels,
        without the ones whose crop would be too small. The size is judged on the box as the
        detector decoded it."""
        analysis_height, analysis_width = analyzed.shape[:2]
        return [detection for detection in self.detector.detect(analyzed)
                if large_enough(detection.box, analysis_width, analysis_height, self.min_crop_px)]

    def scan(self, analyzed: np.ndarray) -> tuple[list[Detection], int, float | None]:
        """``valid_detections``, with the number of boxes dropped for size and the highest score
        of any row before the threshold. A detector with only ``detect`` gives no such score."""
        look = getattr(self.detector, "look", None)
        found, best = (self.detector.detect(analyzed), None) if look is None else look(analyzed)
        analysis_height, analysis_width = analyzed.shape[:2]
        valid = [detection for detection in found
                 if large_enough(detection.box, analysis_width, analysis_height, self.min_crop_px)]
        return valid, len(found) - len(valid), best

    def detect(self, rgb: np.ndarray) -> tuple[list[tuple[Box, float, int]], np.ndarray]:
        """The detector alone: ``[(box in the original frame, score, class)]`` and the analysis
        frame. The boxes are the ones ``analyze`` reports, not rounded."""
        frame_height, frame_width = rgb.shape[:2]
        analyzed = analysis_frame(rgb, self.min_width, self.max_width)
        analysis_height, analysis_width = analyzed.shape[:2]
        scale_x, scale_y = frame_width / analysis_width, frame_height / analysis_height
        found = [(frame_box(detection, scale_x, scale_y, frame_width, frame_height), detection.score, detection.cls)
                 for detection in self.valid_detections(analyzed)]
        return found, analyzed

    def _cut(self, rgb: np.ndarray) -> _Cut:
        """Steps 1 to 4 for one frame: the valid detections, and each face's crop."""
        frame_height, frame_width = rgb.shape[:2]
        analyzed = analysis_frame(rgb, self.min_width, self.max_width)
        analysis_height, analysis_width = analyzed.shape[:2]
        detections, too_small, best_score = self.scan(analyzed)

        # A face is cut from its box in the analysis frame, clipped to that frame and not rounded.
        crops: dict[int, np.ndarray] = {}
        boxes: dict[int, Box] = {}
        for index, detection in enumerate(detections):
            if detection.cls == DETECTOR_FACE_CLASS:
                boxes[index] = frame_box(detection, 1.0, 1.0, analysis_width, analysis_height)
                crops[index] = crop_truncated(analyzed, boxes[index])
        return _Cut(frame_width, frame_height, analysis_width, analysis_height, detections, crops, too_small, best_score,
                    analyzed, boxes)

    def analyze(self, rgb: np.ndarray, name: str = "", source: str = "", t: float = 0.0,
                source_type: str | None = None, *, tilted: bool = True) -> FrameResult:
        """Detect and recognize the cards in one ``(H, W, 3)`` uint8 RGB frame.

        ``source_type`` is the kind of footage (a manifest's ``source_type``), when known; only a
        recognizer's geometric stage reads it (``Recognizer.recognize``). A recognizer with the
        tilted retry is given the analysis frame and each crop's box, and ``tilted`` false skips
        the retry for this frame."""
        started = time.perf_counter()
        cut = self._cut(rgb)
        crops = list(cut.crops.values())
        context = {} if source_type is None else {"source_type": source_type}
        if self.recognizer.tilted is not None:
            context.update(frame=cut.analyzed, boxes=list(cut.boxes.values()), tilted=tilted)
        found = self.recognizer.recognize(crops, **context)
        recognitions = dict(zip(cut.crops, found))
        return cut.result(recognitions, cut.crops, name, source, t, started)

    def analyze_looks(self, rgb: np.ndarray, name: str = "", source: str = "", t: float = 0.0) -> FrameLooks:
        """``analyze`` up to the two thresholds: the frame's boxes, and the looks of each face
        (``Recognizer.looks``).

        ``FrameLooks.under(rule)`` then gives the frame as ``analyze`` reports it under that
        rule, so one run of the models serves any number of pairs of ``tau`` and ``delta``.
        The crops are not kept.
        """
        started = time.perf_counter()
        cut = self._cut(rgb)
        looks = dict(zip(cut.crops, self.recognizer.looks(list(cut.crops.values()))))
        return FrameLooks(cut.result({}, {}, name, source, t, started), looks, self.recognizer)

    def analyze_frame(self, frame: Frame) -> FrameResult:
        """``analyze`` for a ``Frame`` read by ``cardvision.infer.frames``."""
        return self.analyze(frame.rgb, name=frame.name, source=frame.source, t=frame.t)
