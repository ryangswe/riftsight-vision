# SPDX-License-Identifier: Apache-2.0
"""The recognizer alone, on crops cut from labeled face boxes.

This measure takes the detector out of the picture: each crop is cut from a box a person drew,
so what is measured is whether the recognizer names a card it is shown.

**Which boxes.** The faces of exhaustively boxed rows that are named, are not ignore regions
and are not labeled unreadable (``readable`` is not ``no``). Everything else is left out and
counted by reason: ``ignore-region``, ``unnamed``, ``unreadable``, ``card-not-in-catalog``,
and ``small`` for a box whose crop would be under the pipeline's smallest side.

**How a crop is cut.** As inference cuts a detected box: the frame is brought to the analysis
width, the upright box around the labeled corners is clipped to the frame, and its edges are
truncated to whole pixels (``cardvision.recognize.crops``). No margin is added and the crop is
not turned; the recognizer's own orientation rule deals with a card lying sideways, when the
configuration's accept rule lets it try the turned looks (``rotationRetry``).

**Rates**, each over the crops of a slice:

* *top-1 right* = crops whose best bank row has the labeled card's name / crops, whether or
  not the accept rule passed;
* *named right* = crops the accept rule passed with the labeled name / crops;
* *named wrong* = crops the accept rule passed with another name / crops;
* *rejected* = crops the accept rule did not pass / crops;
* *wrong of named* = named wrong / (named right + named wrong).

"The labeled card's name" stands for its identity throughout, and the catalog's rule says
which cards are one identity (``Catalog.identity_of``). Under the default rule printings of
one name are one identity. Under the ``printing`` rule a row or a named card is right when it
is the labeled card or one of its printings, and a different card of the same name is wrong.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cardvision.data.extract import FrameStore
from cardvision.data.schema import Box, Row
from cardvision.evaluate.config import Configuration
from cardvision.evaluate.rows import Account, scorable_rows, sliced
from cardvision.evaluate.stats import GroupBootstrap, rate
from cardvision.infer.frames import analysis_frame
from cardvision.recognize import crop_truncated, large_enough

DEFINITIONS = {
    "crops": "crops = the faces of the used rows that are named, not marked ignore, not labeled unreadable, and "
             "large enough to cut. This is not the detector measure's count of face targets: a face that "
             "cardvision evaluate detector sets aside for its proportions is still a crop here",
    "top1Right": "top-1 right = crops whose best bank row has the labeled card's name / crops (accepted or not)",
    "namedRight": "named right = crops the accept rule passed with the labeled name / crops",
    "namedWrong": "named wrong = crops the accept rule passed with another name / crops",
    "rejected": "rejected = crops the accept rule did not pass / crops",
    "wrongOfNamed": "wrong of named = named wrong / (named right + named wrong)",
    "byLook": "by look = named right and named wrong counted by the look that named the crop: upright (0), one, two "
              "or three quarter turns, or a rectangle of the tilted retry (counted apart, whatever its look)",
}


def crop_exclusion(box: Box, names: Mapping[str, str]) -> str | None:
    """Why a box gives no evaluation crop, or ``None`` when it gives one (``small`` is decided
    later, on the frame)."""
    if box.kind != "face":
        return "not-face"
    if box.ignore:
        return "ignore-region"
    if box.identity != "named" or box.card_id is None:
        return "unnamed"
    if box.readable == "no":
        return "unreadable"
    if box.card_id not in names:
        return "card-not-in-catalog"
    return None


@dataclass(frozen=True)
class CropResult:
    """One labeled crop and what the recognizer made of it."""

    platform: str
    video_id: str
    t: float
    group: str
    source_type: str
    label: str
    truth: str
    top_name: str
    name: str | None
    similarity: float
    margin: float
    look: int
    # The identity keys of the labeled card, of the best row's card and of the named card
    # (``Catalog.identities()``). They decide right and wrong and are not written out. A
    # result made without them compares the three names.
    truth_key: str | None = None
    top_key: str | None = None
    name_key: str | None = None
    # The card ids behind the three names: the labeled card, the best row's card and the named
    # card. They are written out only where names do not tell cards apart (``to_json``).
    truth_id: str | None = None
    top_id: str | None = None
    card_id: str | None = None
    # Whether a rectangle of the tilted retry named the crop (``Recognition.named_by_tilt``).
    tilted: bool = False

    @property
    def _keys(self) -> tuple[str, str, str | None]:
        if self.truth_key is None:
            return self.truth, self.top_name, self.name
        return self.truth_key, self.top_key, self.name_key

    @property
    def top1_right(self) -> bool:
        truth, top, _ = self._keys
        return top == truth

    @property
    def named_right(self) -> bool:
        truth, _, named = self._keys
        return self.name is not None and named == truth

    @property
    def named_wrong(self) -> bool:
        truth, _, named = self._keys
        return self.name is not None and named != truth

    def to_json(self, with_ids: bool = False) -> dict[str, Any]:
        """The crop's line of the listing. ``with_ids`` puts each card's id beside its name
        (``truthId``, ``topId``, ``cardId``), for a catalog in which different cards share a
        name: the listing then says which card was labeled and which was found."""
        def named(key: str, name: str | None, id_key: str, card_id: str | None) -> dict[str, Any]:
            return {key: name, id_key: card_id} if with_ids else {key: name}

        return {"platform": self.platform, "video_id": self.video_id, "t": self.t, "group": self.group,
                "source_type": self.source_type, "label": self.label,
                **named("truth", self.truth, "truthId", self.truth_id),
                **named("topName", self.top_name, "topId", self.top_id),
                **named("name", self.name, "cardId", self.card_id),
                "similarity": round(self.similarity, 6), "margin": round(self.margin, 6), "look": self.look,
                **({"tilted": True} if self.tilted else {})}


def _labels(names: Mapping[str, str]):
    def labels(row: Row) -> Counter:
        if row.completeness != "exhaustive-boxes":
            return Counter()
        return Counter("crop" for box in row.boxes or () if crop_exclusion(box, names) is None)
    return labels


def run_crops(rows: Sequence[Row], frames: FrameStore | str | Path, config: Configuration, account: Account) -> list[CropResult]:
    """Recognize every labeled face crop of ``rows``."""
    names, identities = config.catalog.names(), config.catalog.identities()
    pipeline = config.pipeline
    results: list[CropResult] = []
    for row, rgb in scorable_rows(rows, frames, account, _labels(names)):
        analyzed = analysis_frame(rgb, pipeline.min_width, pipeline.max_width)
        height, width = analyzed.shape[:2]
        wanted, crops, boxes = [], [], []
        for index, box in enumerate(row.boxes or ()):
            reason = crop_exclusion(box, names)
            if reason is None:
                pixel_box = box.pixel_box(width, height)
                if not large_enough(pixel_box, width, height, pipeline.min_crop_px):
                    reason = "small"
            if reason is None:
                wanted.append((index, box))
                crops.append(crop_truncated(analyzed, pixel_box))
                boxes.append(pixel_box)
            elif reason != "not-face":
                account.labels_skipped[reason] += 1
        from cardvision.evaluate.scoring import source_of

        context = source_of(config, row)
        if pipeline.recognizer.tilted is not None:
            context.update(frame=analyzed, boxes=boxes)
        for (index, box), found in zip(wanted, pipeline.recognizer.recognize(crops, **context)):
            results.append(CropResult(platform=row.platform, video_id=row.video_id, t=row.t, group=row.group,
                                      source_type=row.source_type, label=box.id or f"b{index}",
                                      truth=names[box.card_id], top_name=found.top_name, name=found.name,
                                      similarity=found.similarity, margin=found.margin, look=found.look,
                                      truth_key=identities[box.card_id], top_key=identities[found.top_id],
                                      name_key=None if found.card_id is None else identities[found.card_id],
                                      truth_id=box.card_id, top_id=found.top_id, card_id=found.card_id,
                                      tilted=found.named_by_tilt))
    return results


def crop_rates(results: Sequence[CropResult], seed: int, replicates: int) -> dict[str, Any]:
    """The counts and rates of a set of crops, with their intervals."""
    groups = [r.group for r in results]
    boot = GroupBootstrap(set(groups), seed, replicates)
    ones = boot.per_group(groups)
    top1 = boot.per_group(groups, [float(r.top1_right) for r in results])
    right = boot.per_group(groups, [float(r.named_right) for r in results])
    wrong = boot.per_group(groups, [float(r.named_wrong) for r in results])
    n = len(results)
    n_top1, n_right, n_wrong = int(top1.sum()), int(right.sum()), int(wrong.sum())

    def of(count: int, total: int, bound: str, per_group) -> dict[str, Any]:
        return rate(count, total, bound=bound, bootstrap=boot, per_group=per_group)

    return {
        "crops": n,
        "groups": len(boot.groups),
        "top1Right": of(n_top1, n, "lower", (top1, ones)),
        "namedRight": of(n_right, n, "lower", (right, ones)),
        "namedWrong": of(n_wrong, n, "upper", (wrong, ones)),
        "rejected": of(n - n_right - n_wrong, n, "upper", (ones - right - wrong, ones)),
        "wrongOfNamed": of(n_wrong, n_right + n_wrong, "upper", (wrong, right + wrong)),
        "byLook": by_look(results),
    }


LOOKS = ("0", "1", "2", "3")
TILTED = "tilted"


def by_look(results: Sequence[CropResult]) -> dict[str, dict[str, int]]:
    """Named right and named wrong by the look that named each crop: ``"0"`` to ``"3"`` quarter
    turns, and ``"tilted"`` for a rectangle of the tilted retry, listed only when one named a crop."""
    counts = {key: {"namedRight": 0, "namedWrong": 0} for key in LOOKS}
    for result in results:
        if result.named_right or result.named_wrong:
            key = TILTED if result.tilted else str(result.look)
            entry = counts.setdefault(key, {"namedRight": 0, "namedWrong": 0})
            entry["namedRight" if result.named_right else "namedWrong"] += 1
    return counts


def crop_results(results: Sequence[CropResult], seed: int, replicates: int) -> dict[str, Any]:
    """The crop rates overall, by source type and by source family."""
    return sliced(results, lambda r: r.source_type, lambda part: crop_rates(part, seed, replicates))
