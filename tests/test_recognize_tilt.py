# SPDX-License-Identifier: Apache-2.0
"""The tilted retry (``cardvision.recognize.tilt``): the estimator, the rectangle solve and the
sampler on arithmetic inputs with known answers, its block in a release, and the recognizer
with a stand-in model that accepts a crop only when it is almost all card."""

from __future__ import annotations

import math
from types import SimpleNamespace

import numpy as np
import pytest

from cardvision.evaluate.crops import CropResult, by_look
from cardvision.evaluate.hover import Proposal, kept_after_nms
from cardvision.recognize import (
    AcceptRule,
    Recognizer,
    TiltedRetry,
    crop_truncated,
    estimate_tilt,
    parse_tilted_retry,
    rect_from_aabb,
    sample_rect,
    tilted_retry_errors,
)
from cardvision.recognize.tilt import fold, tilted_rects

CENTER = 150.5


def card_image(theta: float, size: int = 301, card=(126, 176)) -> np.ndarray:
    """A white card on black, turned by ``theta`` degrees about the image's center, each pixel's
    value the share of a 4 x 4 grid of its points inside the card, cropped to the pixels it
    touches (the detector box)."""
    half_w, half_h = card[0] / 2, card[1] / 2
    c, s = math.cos(math.radians(theta)), math.sin(math.radians(theta))
    offsets = (np.arange(4) + 0.5) / 4
    xs = (np.arange(size)[:, None] + offsets[None, :]).ravel() - CENTER
    big_x = np.repeat(xs[None, :], size * 4, 0)
    big_y = np.repeat(xs[:, None], size * 4, 1)
    u, v = big_x * c + big_y * s, -big_x * s + big_y * c
    cover = ((np.abs(u) <= half_w) & (np.abs(v) <= half_h)).reshape(size, 4, size, 4).mean((1, 3))
    image = np.repeat(np.floor(cover * 255 + 0.5)[..., None], 3, 2).astype(np.uint8)
    rows, cols = np.nonzero(cover > 0)
    return image[rows.min():rows.max() + 1, cols.min():cols.max() + 1]


# G1 of the method's specification: theta, the crop's size, the estimate and the solved card. The
# specification's estimate for -2 degrees, -1.717, came from NumPy's float32 arctangent on one
# platform; with the correctly rounded arctangent this module uses (its description says why) it
# is -1.691, and the solved card 127.82 x 177.31.
G1 = [
    (-40, 211, 217, -39.629, 126.82, 177.15, "prior"),
    (-30, 197, 215, -28.642, 129.21, 174.41, "exact"),
    (-12, 161, 199, -10.660, 130.33, 177.96, "exact"),
    (-5, 141, 187, -4.446, 127.61, 177.64, "exact"),
    (-2, 133, 181, -1.691, 127.82, 177.31, "exact"),
    (0, 127, 177, 0.500, 125.47, 175.91, "exact"),
    (3, 135, 183, 2.710, 126.76, 177.20, "exact"),
    (7, 147, 191, 6.354, 128.10, 177.92, "exact"),
    (12, 161, 199, 10.652, 130.35, 177.97, "exact"),
    (20, 179, 209, 18.163, 130.24, 177.23, "exact"),
    (33, 203, 217, 31.945, 130.52, 174.34, "exact"),
    (90, 177, 127, 0.500, 175.91, 125.47, "exact"),
    (107, 205, 173, 15.259, 176.72, 131.11, "exact"),
]


@pytest.mark.parametrize("theta, width, height, estimate, w, h, how", G1)
def test_the_estimate_and_the_solved_card_on_a_synthetic_card(theta, width, height, estimate, w, h, how):
    crop = card_image(theta)
    assert crop.shape[:2] == (height, width)
    found = estimate_tilt(crop)
    assert found == pytest.approx(estimate, abs=1e-3)
    solved = rect_from_aabb(float(width), float(height), found)
    assert solved[2] == how
    assert solved[:2] == pytest.approx((w, h), abs=6e-3)  # the table is rounded to 0.01


# G2: the rectangle solve alone.
G2 = [
    (100, 140, 0, 100.000, 140.000, "exact"),
    (100, 140, 10, 78.930, 128.242, "exact"),
    (100, 140, -10, 78.930, 128.242, "exact"),
    (140, 100, 8, 129.746, 82.748, "exact"),
    (120, 130, 20, 89.160, 105.892, "exact"),
    (130, 130, 40, 76.982, 107.530, "prior"),
    (90, 160, 3, 101.141, 141.277, "prior"),
    (150, 150, 0, 170.170, 121.826, "prior"),
]


@pytest.mark.parametrize("width, height, tilt, w, h, how", G2)
def test_the_rectangle_solve(width, height, tilt, w, h, how):
    found = rect_from_aabb(width, height, tilt)
    assert found[2] == how and found[:2] == pytest.approx((w, h), abs=6e-4)


def test_the_fold():
    assert [fold(value) for value in (0.0, 44.9, 45.0, 45.1, -44.9, -45.0, 90.0, 135.0, 89.5)] == \
        pytest.approx([0.0, 44.9, 45.0, -44.9, -44.9, 45.0, 0.0, 45.0, -0.5])


def test_an_axis_aligned_card_reads_half_a_degree_and_a_tiny_or_flat_crop_reads_nothing():
    assert estimate_tilt(card_image(0)) == pytest.approx(0.5, abs=1e-9)  # the bins are centered on half degrees
    assert estimate_tilt(np.zeros((40, 7, 3), np.uint8)) == 0.0  # under 8 px a side
    assert estimate_tilt(np.full((40, 40, 3), 90, np.uint8)) == 0.0  # no edge at all


def test_a_quarter_turn_is_folded_away():
    assert estimate_tilt(np.ascontiguousarray(np.rot90(card_image(12)))) == pytest.approx(estimate_tilt(card_image(12)), abs=0.05)


def test_the_sampler_copies_pixels_at_no_tilt_and_fills_black_outside():
    frame = np.random.default_rng(3).integers(0, 256, (40, 60, 3), dtype=np.uint8)
    copy = sample_rect(frame, 30.0, 20.0, 20.0, 10.0, 0.0)  # centered on a pixel corner: exact taps
    assert copy.shape == (10, 20, 3) and np.array_equal(copy, frame[15:25, 20:40])
    outside = sample_rect(frame, -50.0, -50.0, 6.0, 4.0, 10.0)
    assert outside.shape == (4, 6, 3) and not outside.any()
    assert sample_rect(frame, 30.0, 20.0, 0.4, 2.5, 0.0).shape == (2, 2, 3)  # at least 2 px; 2.5 rounds to 2


def test_the_rectangles_are_centered_on_the_box_and_sized_by_the_scales():
    frame = np.zeros((300, 300, 3), np.uint8)
    frame[100:240, 80:180] = 200
    box = (80.0, 100.0, 100.0, 140.0)
    tilt, rects = tilted_rects(frame, box, crop_truncated(frame, box), (0.95, 1.0, 1.05))
    assert tilt == 0.0  # a crop that is all card has no edge to read
    assert [rect.shape[:2] for rect in rects] == [(133, 95), (140, 100), (147, 105)]
    assert rects[0].min() > 150  # all card


# ------------------------------------------------------------------------- the release block
def test_the_block_is_checked_and_read():
    good = {"scales": [0.95, 1.0, 1.05], "maxFacesPerFrame": 8, "budgetMs": 1500}
    assert tilted_retry_errors(good) == []
    assert parse_tilted_retry(good) == TiltedRetry()
    assert TiltedRetry().to_json() == good
    assert tilted_retry_errors([]) == ["tiltedRetry must be an object"]
    errors = tilted_retry_errors({"scales": [], "maxFacesPerFrame": 0, "budgetMs": 1.5, "extra": 1})
    assert errors == ["tiltedRetry has unknown key(s) extra (expected scales, maxFacesPerFrame, budgetMs)",
                      "tiltedRetry.scales must list 1 to 5 numbers from 0.5 to 1.5",
                      "tiltedRetry.maxFacesPerFrame must be a whole number above 0",
                      "tiltedRetry.budgetMs must be a whole number above 0"]
    assert tilted_retry_errors({**good, "scales": [0.4]}) and tilted_retry_errors({**good, "maxFacesPerFrame": True})
    with pytest.raises(ValueError, match="budgetMs"):
        parse_tilted_retry({**good, "budgetMs": 0})


# ------------------------------------------------------------- the recognizer, with a stand-in
TABLE, CARD = 0, 200


class CardShare:
    """A stand-in model: the embedding turns from the card's row toward the other row as the
    share of table in the crop grows, so only a crop that is almost all card is accepted."""

    def __init__(self, threshold: float) -> None:
        self.threshold = threshold
        self.batches: list[int] = []

    def get_inputs(self):
        return [SimpleNamespace(name="crops", shape=["n", 3, 128, 128])]

    def get_outputs(self):
        return [SimpleNamespace(name="embeddings", shape=["n", 2])]

    def run(self, _names, feeds):
        crops = feeds["crops"]
        self.batches.append(len(crops))
        share = (crops[:, 0] > self.threshold).mean(axis=(1, 2))
        angle = (1 - share) * math.pi / 2
        return [np.stack([np.cos(angle), np.sin(angle)], 1).astype(np.float32)]


def tilted_card_frame(theta: float, size=(320, 260), card=(100, 140)) -> tuple[np.ndarray, tuple[float, ...]]:
    """A card turned by ``theta`` on a plain table, and its bounding box."""
    width, height = size
    cx, cy = width / 2, height / 2
    c, s = math.cos(math.radians(theta)), math.sin(math.radians(theta))
    ys, xs = np.mgrid[0:height, 0:width] + 0.5
    u, v = (xs - cx) * c + (ys - cy) * s, -(xs - cx) * s + (ys - cy) * c
    inside = (np.abs(u) <= card[0] / 2) & (np.abs(v) <= card[1] / 2)
    frame = np.where(inside[..., None], CARD, TABLE).astype(np.uint8).repeat(3, 2)
    rows, cols = np.nonzero(inside)
    return frame, (float(cols.min()), float(rows.min()), float(cols.max() - cols.min() + 1), float(rows.max() - rows.min() + 1))


def stand_in(tilted: TiltedRetry | None = TiltedRetry()) -> Recognizer:
    from cardvision.core.preprocess import full128

    threshold = float(full128(np.full((8, 8, 3), (TABLE + CARD) // 2, np.uint8))[0, 0, 0])
    rows = np.array([[1.0, 0.0], [0.0, 1.0]], np.float32)
    return Recognizer(CardShare(threshold), ["CARD-1", "OTHER-1"], rows, {"CARD-1": "Card", "OTHER-1": "Other"},
                      AcceptRule(0.99, 0.05, True), tilted=tilted)


def test_a_tilted_card_the_crop_misses_is_named_by_a_rectangle():
    frame, box = tilted_card_frame(8.0)
    crop = crop_truncated(frame, box)
    plain = stand_in(None).recognize([crop])[0]
    assert not plain.accepted and plain.tilted is None
    recognizer = stand_in()
    found = recognizer.recognize([crop], frame=frame, boxes=[box])[0]
    assert found.accepted and found.named_by_tilt and found.card_id == "CARD-1" and found.name == "Card"
    assert found.similarity > 0.99 and found.look == plain.look and found.retried
    assert found.tilted.tilt == pytest.approx(8.0, abs=1.0)
    assert found.tilted.scale in (0.95, 1.0)
    assert (found.tilted.top_id, found.tilted.similarity, found.tilted.margin) == (plain.top_id, plain.similarity, plain.margin)
    assert recognizer.session.batches == [1, 3, 3]  # upright, the three turns, the three rectangles


def test_the_retry_is_skipped_without_a_frame_when_switched_off_and_on_accepted_crops():
    frame, box = tilted_card_frame(8.0)
    crop = crop_truncated(frame, box)
    recognizer = stand_in()
    assert recognizer.recognize([crop])[0].tilted is None
    assert recognizer.recognize([crop], frame=frame, boxes=[box], tilted=False)[0].tilted is None
    upright, upright_box = tilted_card_frame(0.0)
    found = recognizer.recognize([crop_truncated(upright, upright_box)], frame=upright, boxes=[upright_box])[0]
    assert found.accepted and found.tilted is None
    with pytest.raises(ValueError, match="one box per crop"):
        recognizer.recognize([crop], frame=frame)


def test_a_face_no_rectangle_names_keeps_its_answer_and_records_the_try():
    frame = np.zeros((200, 200, 3), np.uint8)
    frame[:, :90] = CARD  # half card, half table: equally like both rows, so nothing is named
    box = (50.0, 50.0, 80.0, 100.0)
    crop = crop_truncated(frame, box)
    found = stand_in().recognize([crop], frame=frame, boxes=[box])[0]
    before = stand_in(None).recognize([crop])[0]
    assert not found.accepted and found.tilted is not None and found.tilted.scale is None
    assert (found.top_id, found.similarity, found.margin, found.look) == (before.top_id, before.similarity, before.margin, before.look)


def test_the_threshold_search_refuses_a_recognizer_with_the_retry():
    with pytest.raises(ValueError, match="tilted retry needs the frame"):
        stand_in().looks([np.zeros((30, 30, 3), np.uint8)])


# ---------------------------------------------------------------------------- the evaluation
def test_a_face_named_by_a_rectangle_enters_the_suppression_with_the_turned_looks():
    def proposal(x: float, similarity: float, tilted: bool) -> Proposal:
        return Proposal(box=(x, 0.0, 10.0, 10.0), detector_score=0.9, similarity=similarity, look=0, tau_passed=True,
                        accepted=True, name="n", tilted=tilted)

    # Equal scores and overlapping boxes: the upright one enters first and is kept.
    assert kept_after_nms([proposal(1.0, 0.8, True), proposal(0.0, 0.8, False)]) == [1]
    assert kept_after_nms([proposal(1.0, 0.8, False), proposal(0.0, 0.8, False)]) == [0]


def test_named_crops_are_counted_by_the_look_that_named_them():
    def crop(look: int, right: bool, tilted: bool = False, named: bool = True) -> CropResult:
        return CropResult(platform="p", video_id="v", t=0.0, group="g", source_type="physical", label="b", truth="A",
                          top_name="A" if right else "B", name=("A" if right else "B") if named else None,
                          similarity=0.9, margin=0.1, look=look, tilted=tilted)

    counts = by_look([crop(0, True), crop(0, False), crop(2, True), crop(1, True, tilted=True), crop(3, True, named=False)])
    assert counts == {"0": {"namedRight": 1, "namedWrong": 1}, "1": {"namedRight": 0, "namedWrong": 0},
                      "2": {"namedRight": 1, "namedWrong": 0}, "3": {"namedRight": 0, "namedWrong": 0},
                      "tilted": {"namedRight": 1, "namedWrong": 0}}
    assert crop(1, True, tilted=True).to_json()["tilted"] is True and "tilted" not in crop(1, True).to_json()


def test_the_frame_pipeline_gives_the_recognizer_the_analysis_frame_and_the_boxes():
    from cardvision.detect.decode import Detection
    from cardvision.infer.pipeline import Pipeline, card_json

    frame, box = tilted_card_frame(8.0)

    class OneBox:
        def detect(self, analyzed):
            return [Detection(*box, score=0.9, cls=0)]

    pipeline = Pipeline(OneBox(), stand_in(), min_width=320, max_width=320)
    card = pipeline.analyze(frame).faces[0]
    assert card.recognition.named_by_tilt and card_json(card)["tilted"]["scale"] in (0.95, 1.0)
    assert pipeline.analyze(frame, tilted=False).faces[0].recognition.tilted is None


class QuadrantShare(CardShare):
    """A stand-in that reads only the tensor's top-left quadrant, so the four looks of a tilted
    card's crop differ; it keeps every batch it was given."""

    def __init__(self, threshold: float) -> None:
        super().__init__(threshold)
        self.given: list[np.ndarray] = []

    def run(self, _names, feeds):
        crops = feeds["crops"]
        self.given.append(crops.copy())
        share = (crops[:, 0, :64, :64] > self.threshold).mean(axis=(1, 2))
        angle = (1 - share) * math.pi / 2
        return [np.stack([np.cos(angle), np.sin(angle)], 1).astype(np.float32)]


def test_each_rectangle_is_embedded_at_the_crops_best_look():
    from cardvision.core.preprocess import rot4

    frame, box = tilted_card_frame(8.0)
    crop = crop_truncated(frame, box)
    recognizer = stand_in()
    recognizer.session = QuadrantShare(recognizer.session.threshold)
    found = recognizer.recognize([crop], frame=frame, boxes=[box])[0]
    assert found.look != 0 and found.accepted and found.named_by_tilt
    _, rects = tilted_rects(frame, box, crop, TiltedRetry().scales)
    expected = np.stack([rot4(recognizer.preprocess(rect))[found.look] for rect in rects])
    assert len(recognizer.session.given) == 3 and np.array_equal(recognizer.session.given[2], expected)


def test_the_retry_runs_after_the_geometric_stage_on_what_it_left_and_keeps_its_record():
    class Stage:
        """A geometric stage that verifies nothing, or lifts the card's fused score by ``lift``."""

        def __init__(self, lift: float) -> None:
            self.lift = lift
            self.config = {"fusion": {"reorder": False}}

        def applies(self, source_type, accepted):
            return True

        def verify(self, crop, ranked, known):
            cosine = dict(ranked)["CARD-1"]
            found = [SimpleNamespace(card_id="CARD-1", cosine=cosine, fused=cosine + self.lift)] if self.lift else []
            return SimpleNamespace(candidates=found)

    frame, box = tilted_card_frame(8.0)
    crop = crop_truncated(frame, box)
    recognizer = stand_in()
    recognizer.geometric = Stage(0.0)
    found = recognizer.recognize([crop], frame=frame, boxes=[box])[0]
    assert found.accepted and found.named_by_tilt and found.geometric is not None
    assert found.tilted.similarity == found.geometric.similarity  # the answer before the retry is the stage's
    recognizer.geometric = Stage(0.5)
    lifted = recognizer.recognize([crop], frame=frame, boxes=[box])[0]
    assert lifted.accepted and lifted.tilted is None and lifted.geometric is not None
