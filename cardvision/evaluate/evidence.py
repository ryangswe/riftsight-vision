# SPDX-License-Identifier: Apache-2.0
"""Per-face evidence of a hover run: what ``cardvision evaluate hover --evidence FILE`` writes.

The rates of ``evaluate hover`` say how often a pointer is shown the right card. The evidence
file says, frame by frame, what every face of the frame came to and why, so that two runs of
the same configuration (two builds of OpenCV, or this package and the browser runtime of
``browser/``, which writes the same file) can be compared face by face and event by event.

It is opt-in and changes nothing that is scored: with ``--evidence`` the geometric stage, when
the configuration has one, also records a debug account of each crop
(``cardvision.geometric.stage.debug_record``), which is computed beside the stage's work and
decides nothing.

**The file** is JSON Lines. The first line is the header::

    {"kind": "cardvision-hover-evidence", "version": 1, "side": "python", "runtime": {...},
     "configuration": {...}, "identities": {card id: identity key}}

Every other line is one scored row (a frame), in the order the rows were scored::

    {"key", "platform", "video_id", "t", "group", "source_type",
     "frame": {"width", "height", "pixelSha256"},     the frame as read: SHA-256 of its RGB bytes
     "analyzed": {"width", "height"},                 the analysis frame
     "ms": {"frame", "geometric"},                    the frame's time, and the stage's on it
     "faces": [...], "events": [...], "namedFaces": [[x, y, card id], ...]}

A face: ``index`` (its position among the frame's detections, best detector score first),
``box`` (``[x, y, width, height]`` in frame pixels, to three decimals), ``score``, ``topId``,
``similarity``, ``margin``, ``look``, ``accepted``, ``shownId`` (the card named, or null) and
``geometric`` (the stage's ``GeometricOutcome.to_json``, its ``debug`` included, or null
without a stage) and ``tilted`` (``TiltedOutcome.to_json``: the tilt, the scale that named the card
or null, and the answer before the retry; null when the retry was not tried on the face).

An event: ``key``, ``kind``, ``label``, ``role``, ``x``, ``y`` (fractions of the frame),
``truthId``, ``hit`` (the ``index`` of the face the pointer is on, or null), ``shownId`` and
``shown`` (the card id and name shown, or null), ``box`` (the hit box, frame pixels) and
``outcome`` (``cardvision.evaluate.events``). ``namedFaces`` are the labels an off-card name
can be adjacent to (``named_face_centers``), as fractions and card ids.
"""

from __future__ import annotations

import hashlib
import json
import platform
from collections.abc import Sequence
from pathlib import Path
from typing import IO, Any

import numpy as np

from cardvision.data.schema import Row
from cardvision.evaluate.events import Scored, named_face_centers
from cardvision.evaluate.hover import HoverLayer
from cardvision.infer.pipeline import FrameResult, reported_box

EVIDENCE_KIND = "cardvision-hover-evidence"
EVIDENCE_VERSION = 1


def row_key(row: Row) -> str:
    """A row's id: platform, video id and its time in milliseconds (as an event key starts)."""
    return f"{row.platform}-{row.video_id}-t{round(row.t * 1000):010d}"


def pixel_sha256(rgb: np.ndarray) -> str:
    """SHA-256 of an ``(H, W, 3)`` uint8 frame's bytes, row by row."""
    return hashlib.sha256(np.ascontiguousarray(rgb, dtype=np.uint8).tobytes()).hexdigest()


def header(configuration: Any) -> dict[str, Any]:
    """The first line: what ran, and the identity rule the outcomes were scored under."""
    from cardvision import __version__
    from cardvision.geometric.features import cv2_module

    stage = configuration.pipeline.recognizer.geometric
    runtime: dict[str, Any] = {"name": "cardvision", "version": __version__, "python": platform.python_version(),
                               "machine": platform.machine(), "numpy": np.__version__}
    if stage is not None:
        runtime["opencv"] = cv2_module().__version__
    return {"kind": EVIDENCE_KIND, "version": EVIDENCE_VERSION, "side": "python", "runtime": runtime,
            "configuration": configuration.describe(), "identities": dict(configuration.catalog.identities())}


def face_json(card: Any) -> dict[str, Any]:
    found = card.recognition
    return {"index": card.index, "box": reported_box(card.box), "score": round(card.score, 6), "topId": found.top_id,
            "similarity": round(found.similarity, 6), "margin": round(found.margin, 6), "look": found.look,
            "accepted": found.accepted, "shownId": found.card_id if found.accepted else None,
            "geometric": None if found.geometric is None else found.geometric.to_json(),
            "tilted": None if found.tilted is None else found.tilted.to_json()}


def row_line(row: Row, rgb: np.ndarray, result: FrameResult, layer: HoverLayer, scored: Sequence[Scored]) -> dict[str, Any]:
    """One frame's line (see the module's description)."""
    faces = result.faces
    width, height = layer.frame_width, layer.frame_height
    events = []
    for item in scored:
        event = item.event
        shown = layer.at(event.x * width, event.y * height)
        events.append({"key": event.key, "kind": event.kind, "label": event.label, "role": event.role, "x": event.x,
                       "y": event.y, "truthId": event.truth_id,
                       "hit": None if shown.index is None else faces[shown.index].index,
                       "shownId": item.shown_id, "shown": item.shown,
                       "box": None if item.box is None else reported_box(item.box), "outcome": item.outcome})
    stage_ms = [card.recognition.geometric.result.ms for card in faces if card.recognition.geometric is not None]
    names = {}
    for box in (*(row.points or ()), *(row.boxes or ())):
        if getattr(box, "card_id", None) is not None:
            names[box.card_id] = box.card_id
    return {
        "key": row_key(row), "platform": row.platform, "video_id": row.video_id, "t": row.t, "group": row.group,
        "source_type": row.source_type,
        "frame": {"width": int(rgb.shape[1]), "height": int(rgb.shape[0]), "pixelSha256": pixel_sha256(rgb)},
        "analyzed": {"width": result.analysis_width, "height": result.analysis_height},
        "ms": {"frame": round(result.ms, 3), "geometric": round(sum(stage_ms), 3) if stage_ms else None},
        "faces": [face_json(card) for card in faces],
        "events": events,
        "namedFaces": [[x, y, card_id] for x, y, card_id in named_face_centers(row, names)],
    }


class EvidenceWriter:
    """Writes the evidence file as a run goes: the header at once, then one line per frame."""

    def __init__(self, path: str | Path, configuration: Any) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file: IO[str] = self.path.open("w", encoding="utf-8")
        self._write(header(configuration))
        self.rows = 0

    def _write(self, doc: dict[str, Any]) -> None:
        self._file.write(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n")

    def __call__(self, row: Row, rgb: np.ndarray, result: FrameResult, layer: HoverLayer,
                 scored: Sequence[Scored]) -> None:
        self._write(row_line(row, rgb, result, layer, scored))
        self.rows += 1

    def close(self) -> None:
        self._file.close()


def enable_debug(configuration: Any) -> None:
    """Ask the configuration's geometric stage, if it has one, for its debug record."""
    stage = configuration.pipeline.recognizer.geometric
    if stage is not None:
        stage.debug = True
