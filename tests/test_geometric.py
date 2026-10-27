# SPDX-License-Identifier: Apache-2.0
"""The optional geometric stage: settings, the descriptor index, the stage, and its place in the
recognizer and the commands. On the toy game's drawn cards, with the toy models."""

from __future__ import annotations

import dataclasses
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from cardvision.core.catalog import load_catalog
from cardvision.core.images import load_rgb
from cardvision.core.onnx import create_session, embed
from cardvision.core.preprocess import full128
from cardvision.geometric.config import DEFAULTS, GeometricConfigError, load_geometric, parse_geometric
from cardvision.recognize import AcceptRule, Recognizer

cv2 = pytest.importorskip("cv2")

from cardvision.bank.documents import canonical_bytes  # noqa: E402
from cardvision.geometric.index import build_index, load_index, parse_index  # noqa: E402
from cardvision.geometric.stage import GeometricStage  # noqa: E402
from test_infer_toy_models import ToySetup, build_recognizer  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
TRUTH, IMPOSTOR = "TOY-001", "TOY-002"


def _run_cli(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "cardvision", *args], capture_output=True, text=True, cwd=ROOT,
                          check=False)


@pytest.fixture(scope="module")
def built(tmp_path_factory, toy):
    """The index of the toy setup's bank (every card but the one it leaves out) under the
    default features, written beside the bank and pinned in a settings file. Every ``ToySetup``
    writes the same bank, so the index serves them all."""
    catalog_path, art_dir = toy
    folder = tmp_path_factory.mktemp("geometric")
    bank = ToySetup(folder, *toy).bank
    settings = folder / "geometric.json"
    settings.write_text(json.dumps({"candidates": {"embeddingTopK": 3}}), encoding="utf-8")
    result = _run_cli(["build-features", "--config", str(settings), "--catalog", str(catalog_path), "--art", str(art_dir),
                       "--bank", str(bank), "--out", str(folder / "toy.features.json"), "--pin"])
    assert result.returncode == 0, result.stderr
    return settings, folder / "toy.features.json"


def _settings(folder: Path, index: Path, **blocks) -> Path:
    """A settings file that pins ``index`` and overrides some blocks."""
    from cardvision.evaluate.config import file_sha256

    path = folder / f"settings-{len(list(folder.glob('settings-*')))}.json"
    path.write_text(json.dumps({"index": {"path": str(index), "sha256": file_sha256(index)}, **blocks}),
                    encoding="utf-8")
    return path


# ------------------------------------------------------------------------------------ settings
def test_every_setting_has_a_default_and_the_loaded_settings_are_written_out_in_full():
    config = parse_geometric({})
    assert set(config.to_json()) == set(DEFAULTS)
    assert config.to_json()["features"]["params"] == {"scaleFactor": 1.2, "nLevels": 8, "edgeThreshold": 15,
                                                      "patchSize": 15, "fastThreshold": 10}
    assert config.index_path is None and config.index_sha256 is None


def test_a_misspelled_or_out_of_range_setting_is_refused_with_every_reason():
    with pytest.raises(GeometricConfigError) as raised:
        parse_geometric({"fusion": {"wieght": 1}, "ransac": {"model": "conic"}, "features": {"type": "orb",
                         "params": {"threshold": 1}}, "colour": 1})
    text = str(raised.value)
    for fragment in ("wieght", "ransac.model", "features.params has unknown key", "colour"):
        assert fragment in text


def test_a_relative_index_path_is_read_beside_the_settings_file(tmp_path):
    path = tmp_path / "g.json"
    path.write_text(json.dumps({"index": {"path": "x.features.json", "sha256": "0" * 64}}), encoding="utf-8")
    assert load_geometric(path).index_path == tmp_path / "x.features.json"


# ------------------------------------------------------------------------------- nothing changes
def test_the_package_and_the_command_line_load_without_opencv():
    code = ("import sys; import cardvision.cli, cardvision.recognize, cardvision.infer, cardvision.evaluate.config; "
            "print('cv2' in sys.modules)")
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=ROOT, check=True)
    assert result.stdout.strip() == "False"


def test_without_the_stage_infer_prints_exactly_what_a_stageless_pipeline_gives(tmp_path_factory, toy, capsys):
    from cardvision import cli
    from cardvision.infer import Pipeline, card_json
    from cardvision.recognize import load_accept

    setup = ToySetup(tmp_path_factory.mktemp("off"), *toy)
    pipeline = Pipeline.open(setup.detector, setup.recognizer, setup.bank, load_catalog(setup.catalog),
                             load_accept(setup.accept))
    assert pipeline.recognizer.geometric is None
    expected = [card_json(card) for card in pipeline.analyze(setup.frame).cards]
    assert cli.main(["infer", str(setup.image), *setup.arguments()]) == 0
    printed = json.loads(capsys.readouterr().out.splitlines()[0])
    assert printed["boxes"] == expected
    assert not any("geometric" in box for box in printed["boxes"])


def test_a_stage_with_no_weight_and_no_penalty_changes_no_decision(tmp_path_factory, toy, built, capsys):
    from cardvision import cli

    setup = ToySetup(tmp_path_factory.mktemp("zero"), *toy)
    _, index = built
    zero = _settings(setup.folder, index, fusion={"weight": 0.0, "penalty": 0.0},
                     candidates={"embeddingTopK": 5, "voteTopN": 2})
    assert cli.main(["infer", str(setup.image), *setup.arguments()]) == 0
    off = json.loads(capsys.readouterr().out.splitlines()[0])["boxes"]
    assert cli.main(["infer", str(setup.image), *setup.arguments(), "--geometric", str(zero)]) == 0
    on = json.loads(capsys.readouterr().out.splitlines()[0])["boxes"]
    faces = [box for box in on if "geometric" in box]
    assert len(faces) == 6
    for before, after in zip(off, on):
        assert {key: value for key, value in after.items() if key != "geometric"} == before


def test_the_evaluation_records_the_stage_only_when_it_is_given(tmp_path_factory, toy, built):
    from cardvision.evaluate.config import open_configuration, spec_from_paths

    setup = ToySetup(tmp_path_factory.mktemp("describe"), *toy)
    spec = spec_from_paths(setup.detector, setup.recognizer, setup.bank, setup.catalog, setup.accept)
    plain = open_configuration(spec).describe()
    assert "geometric" not in plain and not any(label.startswith("geometric") for label in plain["files"])
    settings, index = built
    with_stage = open_configuration(spec.replacing(geometric=settings)).describe()
    assert with_stage["files"]["geometricIndex"]["sha256"] == json.loads(settings.read_text())["index"]["sha256"]
    assert with_stage["geometric"]["candidates"]["embeddingTopK"] == 3
    assert {k: v for k, v in with_stage.items() if k not in ("geometric", "files")} == \
        {k: v for k, v in plain.items() if k != "files"}


# ---------------------------------------------------------------------------------------- index
def test_the_index_round_trips_and_is_built_to_the_same_bytes_twice(toy, built):
    catalog_path, art_dir = toy
    from cardvision.bank.documents import read_json
    from cardvision.evaluate.config import file_sha256

    settings, path = built
    bank = path.parent / "bank.json"
    config = load_geometric(settings)
    doc, skipped = build_index(load_catalog(catalog_path), art_dir, config.features, bank=read_json(bank),
                               bank_sha256=file_sha256(bank))
    assert skipped == []
    assert canonical_bytes(doc) == path.read_bytes()
    assert doc["bank"]["sha256"] == file_sha256(bank) and doc["opencv"] == cv2.__version__
    index = load_index(path)
    assert index.ids == [card_id for card_id in load_catalog(catalog_path).ids() if card_id != "TOY-012"]
    assert index.features == config.features
    again = parse_index(json.loads(canonical_bytes(doc)))
    for card_id in index.ids:
        np.testing.assert_array_equal(index.cards[card_id].xy, again.cards[card_id].xy)
        np.testing.assert_array_equal(index.cards[card_id].descriptors, again.cards[card_id].descriptors)
    assert doc["featureCount"] == index.feature_count() > 0
    assert index.cards[TRUTH].descriptors.dtype == np.uint8 and index.cards[TRUTH].descriptors.shape[1] == 32


def test_a_masked_band_gives_no_keypoint_inside_it(toy):
    catalog_path, art_dir = toy
    features = parse_geometric({"features": {"mask": [[0.0, 0.3, 1.0, 0.7]]}}).features
    doc, _ = build_index(load_catalog(catalog_path), art_dir, features)
    for card in parse_index(doc).cards.values():
        y = card.xy[:, 1] / card.size[1]
        assert not np.any((y > 0.3 + 0.01) & (y < 0.7 - 0.01))


def test_the_stage_refuses_an_index_whose_bytes_or_features_differ(tmp_path, built):
    settings, index = built
    doc = json.loads(settings.read_text())
    doc["index"] = {"path": str(index), "sha256": "f" * 64}
    tampered = tmp_path / "tampered.json"
    tampered.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(ValueError, match="SHA-256"):
        GeometricStage.open(tampered)
    other = _settings(tmp_path, index, features={"maxFeatures": 100})
    with pytest.raises(ValueError, match="maxFeatures"):
        GeometricStage.open(other)


# ---------------------------------------------------------------------------------------- stage
def _crop(art_dir: Path, card_id: str = TRUTH) -> np.ndarray:
    """The card as a smaller, turned crop: what a detector might cut from a frame."""
    image = load_rgb(art_dir / f"{card_id}.png")
    small = cv2.resize(image, (image.shape[1] * 3 // 5, image.shape[0] * 3 // 5), interpolation=cv2.INTER_AREA)
    return np.ascontiguousarray(np.rot90(small))


def test_the_right_card_has_the_most_inliers(toy, built):
    _, art_dir = toy
    stage = GeometricStage.open(built[0])
    result = stage.verify(_crop(art_dir), [(TRUTH, 0.5), (IMPOSTOR, 0.6), ("TOY-007", 0.4)])
    by_id = {found.card_id: found for found in result.candidates}
    assert [found.card_id for found in result.candidates] == [IMPOSTOR, TRUTH, "TOY-007"]
    assert by_id[TRUTH].inliers > 2 * max(by_id[IMPOSTOR].inliers, by_id["TOY-007"].inliers)
    assert by_id[TRUTH].fused > by_id[TRUTH].cosine


@pytest.mark.parametrize("vote", [{"voteTopN": 0}, {"voteTopN": 3}])
def test_the_stage_is_deterministic(tmp_path, toy, built, vote):
    _, art_dir = toy
    path = _settings(tmp_path, built[1], candidates={"embeddingTopK": 4, **vote}, vote={"matcher": "flann"},
                     ransac={"method": "usac"}, seed=7)
    ranked = [(card_id, 0.9 - 0.01 * i) for i, card_id in enumerate(load_index(built[1]).ids)]
    first = GeometricStage.open(path).verify(_crop(art_dir), ranked)
    stage = GeometricStage.open(path)
    for _ in range(2):
        again = stage.verify(_crop(art_dir), ranked)
        assert again.candidates == first.candidates and again.crop_keypoints == first.crop_keypoints
    if vote["voteTopN"]:
        assert any(found.found_by in ("vote", "both") for found in first.candidates)


@pytest.mark.parametrize("scale", [0.6, 1.0, 1.7])
def test_the_debug_record_changes_nothing_and_describes_the_crop(tmp_path, toy, built, scale):
    """With debug on, the stage records the grey image it took keypoints from, the resize, every
    keypoint row and the whole vote; its candidates, counts and fused scores are those of a run
    with debug off, for a crop scaled down, not at all, and up."""
    import hashlib

    from cardvision.geometric.features import scaled_grey
    from cardvision.geometric.stage import resize_direction

    _, art_dir = toy
    image = load_rgb(art_dir / f"{TRUTH}.png")
    long_side = 160
    factor = scale * long_side / max(image.shape[:2])
    size = (max(1, round(image.shape[1] * factor)), max(1, round(image.shape[0] * factor)))
    crop = image if factor == 1 else cv2.resize(image, size, interpolation=cv2.INTER_AREA)
    path = _settings(tmp_path, built[1], candidates={"embeddingTopK": 3, "voteTopN": 2}, crop={"longSide": long_side})
    ranked = [(card_id, 0.9 - 0.01 * i) for i, card_id in enumerate(load_index(built[1]).ids)]
    plain = GeometricStage.open(path).verify(crop, ranked)
    stage = GeometricStage.open(path)
    stage.debug = True
    debugged = stage.verify(crop, ranked)
    assert plain.debug is None and debugged.debug is not None
    assert debugged.candidates == plain.candidates and debugged.crop_keypoints == plain.crop_keypoints
    assert [found.to_json() for found in debugged.candidates] == [found.to_json() for found in plain.candidates]
    record = debugged.debug
    grey = scaled_grey(crop, long_side)
    assert record["grey"] == {"sha256": hashlib.sha256(grey.tobytes()).hexdigest(), "width": grey.shape[1],
                              "height": grey.shape[0]}
    assert record["resize"] == resize_direction(crop.shape[1], crop.shape[0], long_side)
    assert record["resize"] == {0.6: "up", 1.0: "none", 1.7: "down"}[scale]
    assert record["source"] == [crop.shape[1], crop.shape[0]]
    assert record["keypoints"] == plain.crop_keypoints == len(record["rows"]) and len(set(record["rows"])) > 1
    assert all(record["votes"][found.card_id] == found.votes for found in plain.candidates if found.votes)
    assert record["ms"] == debugged.ms


def test_the_debug_record_changes_no_recognition(tmp_path, toy, built):
    catalog_path, art_dir = toy
    crop = _crop(art_dir)
    rule = AcceptRule(tau=0.8, delta=0.05, rotation_retry=False)
    cosines = {IMPOSTOR: 0.97, TRUTH: 0.93}
    settings = _settings(tmp_path, built[1], candidates={"embeddingTopK": 3, "voteTopN": 3})
    outcomes = []
    for debug in (False, True):
        stage = GeometricStage.open(settings)
        stage.debug = debug
        found = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, cosines, rule, stage).recognize([crop])[0]
        outcomes.append(found)
    plain, debugged = outcomes
    assert dataclasses.replace(debugged, geometric=None) == dataclasses.replace(plain, geometric=None)
    assert {k: v for k, v in debugged.geometric.to_json().items() if k != "debug"} == plain.geometric.to_json()
    assert "debug" not in plain.geometric.to_json() and "grey" in debugged.geometric.to_json()["debug"]


def test_a_card_the_vote_adds_takes_the_lowest_cosine_given(tmp_path, toy, built):
    _, art_dir = toy
    path = _settings(tmp_path, built[1], candidates={"embeddingTopK": 1, "voteTopN": 1}, fusion={"weight": 0.0})
    result = GeometricStage.open(path).verify(_crop(art_dir), [(IMPOSTOR, 0.8), ("TOY-007", 0.3)])
    voted = [found for found in result.candidates if found.found_by == "vote"]
    assert [found.card_id for found in voted] == [TRUTH]
    assert voted[0].cosine == 0.3


# ------------------------------------------------------------------- the stage in the recognizer
def _unit(vector: np.ndarray) -> np.ndarray:
    return vector / np.linalg.norm(vector)


def _toy_recognizer(folder: Path, catalog_path: Path, art_dir: Path, crop: np.ndarray, cosines: dict[str, float],
                    rule: AcceptRule, stage: GeometricStage | None) -> Recognizer:
    """A recognizer whose bank is drawn around the crop's embedding: each card in ``cosines`` gets a
    row with exactly that cosine to it, every other card a row that resembles it little."""
    model = build_recognizer(folder / "recognizer.onnx")
    session = create_session(model)
    target = embed(session, [crop], full128)[0].astype(np.float64)
    target = _unit(target)
    catalog = load_catalog(catalog_path)
    rng = np.random.default_rng(3)
    rows = []
    for card_id in catalog.ids():
        noise = rng.normal(size=target.shape)
        noise = _unit(noise - (noise @ target) * target)
        cosine = cosines.get(card_id, 0.1)
        rows.append(cosine * target + np.sqrt(1 - cosine ** 2) * noise)
    return Recognizer(session, catalog.ids(), np.array(rows, dtype=np.float32), catalog.names(), rule,
                      identities=catalog.identities(), geometric=stage)


def test_verification_turns_a_wrong_best_card_into_the_right_one(tmp_path, toy, built):
    catalog_path, art_dir = toy
    crop = _crop(art_dir)
    rule = AcceptRule(tau=0.8, delta=0.05, rotation_retry=False)
    cosines = {IMPOSTOR: 0.97, TRUTH: 0.93}
    without = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, cosines, rule, None).recognize([crop])[0]
    assert without.top_id == IMPOSTOR and not without.accepted   # wrong best card, margin too narrow
    reranker = _settings(tmp_path, built[1], candidates={"embeddingTopK": 3},
                         fusion={"weight": 0.15, "minInliers": 10, "fullInliers": 30, "penalty": 0.05,
                                 "baseline": "median", "reorder": True})
    stage = GeometricStage.open(reranker)
    found = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, cosines, rule, stage).recognize([crop])[0]
    assert found.top_id == TRUTH and found.accepted and found.card_id == TRUTH
    assert found.geometric.top_id == IMPOSTOR and not found.geometric.accepted
    assert found.similarity > found.geometric.similarity - 0.05
    assert found.names[0].card_id == TRUTH


def test_as_an_accept_booster_it_lifts_a_right_best_card_over_the_threshold_and_never_reorders(tmp_path, toy, built):
    catalog_path, art_dir = toy
    crop = _crop(art_dir)
    rule = AcceptRule(tau=0.9, delta=0.05, rotation_retry=True)
    cosines = {TRUTH: 0.86, IMPOSTOR: 0.70}
    without = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, cosines, rule, None).recognize([crop])[0]
    assert without.top_id == TRUTH and not without.accepted   # right, but under tau
    booster = _settings(tmp_path, built[1], candidates={"embeddingTopK": 3},
                        fusion={"weight": 0.1, "minInliers": 10, "fullInliers": 30, "baseline": "median",
                                "reorder": False})
    found = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, cosines, rule,
                            GeometricStage.open(booster)).recognize([crop])[0]
    assert found.accepted and found.card_id == TRUTH and found.similarity >= 0.9

    # Without reordering the recognizer's best card stays the answer, even when another card
    # has more evidence.
    swapped = {IMPOSTOR: 0.86, TRUTH: 0.85}
    kept = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, swapped, rule,
                           GeometricStage.open(booster)).recognize([crop])[0]
    assert kept.top_id == IMPOSTOR and not kept.accepted


def test_the_threshold_search_refuses_a_recognizer_with_a_stage(tmp_path, toy, built):
    catalog_path, art_dir = toy
    crop = _crop(art_dir)
    recognizer = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, {TRUTH: 0.9}, AcceptRule(),
                                 GeometricStage.open(built[0]))
    with pytest.raises(ValueError, match="geometric"):
        recognizer.looks([crop])


def test_infer_with_the_stage_reports_what_it_found(tmp_path_factory, toy, built, capsys):
    from cardvision import cli

    setup = ToySetup(tmp_path_factory.mktemp("on"), *toy)
    assert cli.main(["infer", str(setup.image), *setup.arguments(), "--geometric", str(built[0])]) == 0
    boxes = json.loads(capsys.readouterr().out.splitlines()[0])["boxes"]
    first = boxes[0]["geometric"]
    assert set(first) == {"before", "candidates"}
    assert first["candidates"][0]["cardId"] == "TOY-001" and first["candidates"][0]["inliers"] > 0


def test_adding_the_stage_keeps_the_release_and_every_setting():
    from cardvision.evaluate.config import Spec

    spec = Spec(detector=Path("d.onnx"), recognizer=Path("r.onnx"), bank=Path("b.json"), catalog=Path("c.json"),
                rule=AcceptRule(tau=0.7), release=Path("release.json"), release_id="abc")
    added = spec.replacing(geometric="g.json")
    assert added.geometric == Path("g.json")
    assert added.release_id == "abc" and added.rule == spec.rule and added.replacing(bank="b2.json").geometric == Path("g.json")
    assert spec.geometric is None


# ------------------------------------------------------------- identity, rows, formats
def test_the_booster_keeps_the_identity_and_names_its_best_fused_printing(tmp_path, toy, built):
    # Two printings of one name: the cosine prefers the wrong printing by a hair, both are under
    # tau, and only the crop's own printing has inliers. The booster keeps the identity, names
    # the printing with the best fused score, and lists it first.
    catalog_path, art_dir = toy
    crop = _crop(art_dir, "TOY-003A")
    rule = AcceptRule(tau=0.9, delta=0.05, rotation_retry=False)
    cosines = {"TOY-003": 0.86, "TOY-003A": 0.85}
    booster = _settings(tmp_path, built[1], candidates={"embeddingTopK": 3},
                        fusion={"weight": 0.1, "minInliers": 10, "fullInliers": 30, "baseline": "median",
                                "reorder": False})
    found = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, cosines, rule,
                            GeometricStage.open(booster)).recognize([crop])[0]
    assert found.geometric.top_id == "TOY-003" and not found.geometric.accepted
    assert found.accepted and found.card_id == "TOY-003A" and found.top_id == "TOY-003A"
    assert found.rows[0].card_id == found.top_id and found.names[0].card_id == found.top_id
    assert found.similarity == pytest.approx(0.85 + 0.1, abs=1e-6)
    _assert_one_answer(found)


def _assert_one_answer(found) -> None:
    """A recognition names one card, with its score, or nothing: never two candidates."""
    if found.accepted:
        assert found.name is not None and found.card_id == found.top_id
        assert found.rows[0].card_id == found.card_id and found.names[0].card_id == found.card_id
        assert found.names[0].similarity == pytest.approx(found.similarity)
    else:
        assert found.name is None and found.card_id is None


def test_the_booster_answers_one_name_or_nothing(tmp_path, toy, built):
    catalog_path, art_dir = toy
    rule = AcceptRule(tau=0.9, delta=0.05, rotation_retry=False)
    booster = GeometricStage.open(_settings(tmp_path, built[1], candidates={"embeddingTopK": 3},
                                            fusion={"weight": 0.1, "minInliers": 10, "fullInliers": 30,
                                                    "baseline": "median", "reorder": False}))
    for card_id, cosines in (("TOY-003A", {"TOY-003": 0.86, "TOY-003A": 0.85}),   # lifted: one name
                             (TRUTH, {IMPOSTOR: 0.86, TRUTH: 0.85}),               # kept, refused: nothing
                             (TRUTH, {IMPOSTOR: 0.86, TRUTH: 0.86})):
        crop = _crop(art_dir, card_id)
        found = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, cosines, rule, booster).recognize([crop])[0]
        assert found.geometric is not None and not found.geometric.accepted
        _assert_one_answer(found)


def test_each_card_is_given_to_the_stage_by_its_best_row(tmp_path, toy, built):
    # A bank with two rows for one card: its second row is the better one, and that is the
    # cosine the stage must see.
    catalog_path, art_dir = toy
    crop = _crop(art_dir)
    model = build_recognizer(tmp_path / "recognizer.onnx")
    session = create_session(model)
    target = _unit(embed(session, [crop], full128)[0].astype(np.float64))
    catalog = load_catalog(catalog_path)
    rng = np.random.default_rng(5)

    def row_at(cosine: float) -> np.ndarray:
        noise = rng.normal(size=target.shape)
        noise = _unit(noise - (noise @ target) * target)
        return cosine * target + np.sqrt(1 - cosine ** 2) * noise

    ids = [TRUTH, TRUTH, *[card_id for card_id in catalog.ids() if card_id != TRUTH]]
    rows = [row_at(0.4), row_at(0.95), *[row_at(0.1) for _ in ids[2:]]]
    seen = []

    class Spy:
        config = {"fusion": {"reorder": True}}

        def applies(self, source_type, accepted):
            return True

        def verify(self, crop, ranked, known=None):
            from cardvision.geometric.stage import StageResult

            seen.extend(ranked)
            return StageResult((), 0)

    recognizer = Recognizer(session, ids, np.array(rows, dtype=np.float32), catalog.names(),
                            AcceptRule(rotation_retry=False), identities=catalog.identities(), geometric=Spy())
    found = recognizer.recognize([crop])[0]
    assert dict(seen)[TRUTH] == pytest.approx(0.95, abs=1e-6)
    assert found.top_id == TRUTH and found.similarity == pytest.approx(0.95, abs=1e-6)


def test_sift_features_work_end_to_end(toy):
    catalog_path, art_dir = toy
    config = parse_geometric({"features": {"type": "sift", "maxFeatures": 200}, "candidates": {"embeddingTopK": 3},
                              "ransac": {"model": "affine"}})
    doc, _ = build_index(load_catalog(catalog_path), art_dir, config.features)
    assert doc["descriptor"] == {"dtype": "float32", "width": 128, "norm": "l2"}
    index = parse_index(json.loads(canonical_bytes(doc)))
    result = GeometricStage(config, index).verify(_crop(art_dir), [(IMPOSTOR, 0.6), (TRUTH, 0.5), ("TOY-007", 0.4)])
    best = max(result.candidates, key=lambda found: found.inliers)
    assert best.card_id == TRUTH and best.inliers > 0


def _broken(built, change) -> dict:
    doc = json.loads(built[1].read_text())
    change(doc)
    return doc


@pytest.mark.parametrize("change, message", [
    (lambda doc: doc["descriptor"].update(width=0), "descriptor.width"),
    (lambda doc: doc["descriptor"].update(width=61), "descriptor.width must be 32"),
    (lambda doc: doc["descriptor"].update(width="32"), "descriptor.width"),
    (lambda doc: doc["cards"][0].update(n="300"), "whole numbers"),
    (lambda doc: doc["cards"][0].update(n=-1), "whole numbers"),
    (lambda doc: doc["cards"][0].update(n=7), "records n 7"),
    (lambda doc: doc["cards"][0].update(xy=5), "base64 text"),
    (lambda doc: doc.update(cards={"a": 1}), "cards must be a list"),
    (lambda doc: doc["features"].update(type="surf"), "features.type"),
])
def test_a_malformed_index_is_a_value_error(built, change, message):
    with pytest.raises(ValueError, match=message):
        parse_index(_broken(built, change))


def test_the_command_reports_a_malformed_index(tmp_path, tmp_path_factory, toy, built, capsys):
    from cardvision import cli

    setup = ToySetup(tmp_path_factory.mktemp("malformed"), *toy)
    index = tmp_path / "broken.features.json"
    index.write_text(json.dumps(_broken(built, lambda doc: doc["descriptor"].update(width=-3))), encoding="utf-8")
    assert cli.main(["infer", str(setup.image), *setup.arguments(), "--geometric", str(_settings(tmp_path, index))]) == 2
    assert "descriptor.width" in capsys.readouterr().err


def _bank_like(path: Path, index_path: Path, *, extra: tuple[str, ...] = (), art=None) -> Path:
    """A bank of the index's cards (plus ``extra``) with random rows, recording each card's
    image as ``art(card_id, index's artV)`` does."""
    from cardvision.core.bank import encode_bank

    index = load_index(index_path)
    ids = [*index.ids, *extra]
    rows = np.random.default_rng(0).normal(size=(len(ids), 8))
    rows /= np.linalg.norm(rows, axis=1, keepdims=True)
    versions = [(art or (lambda card_id, version: version))(card_id, index.art_versions.get(card_id, "0" * 16))
                for card_id in ids]
    path.write_text(json.dumps(encode_bank(ids, rows, {"dim": 8}, art_versions=versions)), encoding="utf-8")
    return path


def test_the_index_must_serve_the_bank(tmp_path, built):
    settings, index = built
    # The bank it was built beside, and another bank of the same images: both served.
    assert GeometricStage.open(settings, bank=index.parent / "bank.json")
    assert GeometricStage.open(settings, bank=_bank_like(tmp_path / "same-images.json", index))
    refused = {
        "another image": _bank_like(tmp_path / "changed.json", index,
                                    art=lambda card_id, version: "f" * 16 if card_id == TRUTH else version),
        "no entry": _bank_like(tmp_path / "extra.json", index, extra=("TOY-012",)),
        "record no image": _bank_like(tmp_path / "unrecorded.json", index, art=lambda card_id, version: None),
    }
    for message, bank in refused.items():
        with pytest.raises(ValueError, match=message):
            GeometricStage.open(settings, bank=bank)


def test_the_flann_vote_is_the_same_whatever_the_random_state_before_it_is_built(tmp_path, toy, built):
    _, art_dir = toy
    path = _settings(tmp_path, built[1], candidates={"embeddingTopK": 1, "voteTopN": 3},
                     vote={"matcher": "flann", "lshTables": 2, "lshKeySize": 12, "lshProbes": 0})
    crops = [_crop(art_dir, card_id) for card_id in ("TOY-001", "TOY-005", "TOY-009", "TOY-014")]

    def votes(disturb: int) -> list[dict[str, int]]:
        stage = GeometricStage.open(path)
        cv2.setRNGSeed(disturb)
        cv2.randu(np.zeros((64, 64), np.float32), 0, 1)
        stage._build_vote()
        return [stage.votes(stage.crop_features(crop)) for crop in crops]

    assert votes(1) == votes(987654)


# --------------------------------------------------------------------------------- compare
@pytest.fixture(scope="module")
def evaluation(tmp_path_factory, toy):
    from test_evaluate_cli import Evaluation

    return Evaluation(tmp_path_factory.mktemp("compare"), *toy)


def _evaluate(capsys, *arguments: str) -> tuple[int, str]:
    from cardvision import cli

    code = cli.main(["evaluate", *arguments])
    return code, capsys.readouterr().err


def test_compare_scores_the_base_against_the_base_with_the_stage(evaluation, built, capsys, tmp_path):
    code, err = _evaluate(capsys, "compare", *evaluation.arguments("--other-geometric", str(built[0]), "--out",
                                                                  str(tmp_path), "--bootstrap", "50"))
    assert code == 0, err
    result = json.loads((tmp_path / "evaluate-compare.json").read_text())
    assert "geometric" not in result["base"] and "geometricIndex" not in result["base"]["files"]
    assert result["candidate"]["geometric"]["opencv"] == cv2.__version__
    assert result["candidate"]["files"]["geometricIndex"]["sha256"] == json.loads(built[0].read_text())["index"]["sha256"]


def test_compare_asks_what_the_stage_of_another_bank_is(evaluation, built, capsys, tmp_path):
    base = evaluation.arguments("--geometric", str(built[0]), "--bootstrap", "20")
    other = ("--other-bank", str(evaluation.other_bank))
    code, err = _evaluate(capsys, "compare", *base, *other)
    assert code == 2 and "--other-geometric" in err
    # The base's index does not serve the other bank (it has a card the index lacks).
    code, err = _evaluate(capsys, "compare", *base, *other, "--other-geometric", str(built[0]))
    assert code == 2 and "no entry" in err
    code, err = _evaluate(capsys, "compare", *base, *other, "--other-geometric", "none", "--out", str(tmp_path))
    assert code == 0, err
    result = json.loads((tmp_path / "evaluate-compare.json").read_text())
    assert "geometric" in result["base"] and "geometric" not in result["candidate"]


# ------------------------------------------------------------------------------------ gates
def test_the_gates_are_off_by_default_and_checked():
    assert parse_geometric({}).to_json()["gate"] == {"belowAccept": False, "sources": None}
    assert parse_geometric({"gate": {"belowAccept": True, "sources": ["physical/*"]}})["gate"]["sources"] == ["physical/*"]
    for bad in ({"belowAccept": 1}, {"sources": []}, {"sources": "physical/*"}, {"sources": [""]}):
        with pytest.raises(GeometricConfigError, match="gate"):
            parse_geometric({"gate": bad})


def test_below_accept_leaves_an_accepted_crop_exactly_as_the_embedding_named_it(tmp_path, toy, built):
    catalog_path, art_dir = toy
    crop = _crop(art_dir)
    rule = AcceptRule(tau=0.8, delta=0.05, rotation_retry=False)
    settings = _settings(tmp_path, built[1], candidates={"embeddingTopK": 3}, gate={"belowAccept": True},
                         fusion={"weight": 0.15, "minInliers": 10, "fullInliers": 30, "penalty": 0.05,
                                 "baseline": "median", "reorder": True})
    stage = GeometricStage.open(settings)
    accepted = {IMPOSTOR: 0.97, TRUTH: 0.5}
    plain = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, accepted, rule, None).recognize([crop])[0]
    gated = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, accepted, rule, stage).recognize([crop])[0]
    assert plain.accepted and gated == plain and gated.geometric is None
    rejected = {IMPOSTOR: 0.97, TRUTH: 0.93}   # margin under delta: the stage runs
    found = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, rejected, rule, stage).recognize([crop])[0]
    assert found.geometric is not None and found.card_id == TRUTH


@pytest.mark.parametrize("sources, source_type, runs", [
    (None, None, True), (None, "digital/client", True),
    (["physical/*"], "physical/webcam", True), (["physical/*"], "digital/client", False),
    (["physical/*"], None, False), (["generated", "physical/tournament"], "generated", True),
])
def test_the_stage_runs_only_on_the_sources_it_is_given(tmp_path, toy, built, sources, source_type, runs):
    catalog_path, art_dir = toy
    crop = _crop(art_dir)
    settings = _settings(tmp_path, built[1], gate={"sources": sources})
    recognizer = _toy_recognizer(tmp_path, catalog_path, art_dir, crop, {TRUTH: 0.9}, AcceptRule(),
                                 GeometricStage.open(settings))
    found = recognizer.recognize([crop], source_type=source_type)[0]
    assert (found.geometric is not None) is runs


def test_the_evaluation_gives_the_stage_each_rows_source_type(evaluation, built, capsys, tmp_path, monkeypatch):
    seen = []
    verify = GeometricStage.verify

    def spy(stage, crop, ranked, known=None):
        seen.append(len(ranked))
        return verify(stage, crop, ranked, known)

    monkeypatch.setattr(GeometricStage, "verify", spy)
    nowhere = _settings(tmp_path, built[1], gate={"sources": ["no-such-source/*"]})
    code, err = _evaluate(capsys, "hover", *evaluation.arguments("--geometric", str(nowhere), "--bootstrap", "20"))
    assert code == 0, err
    assert seen == []
    webcam = _settings(tmp_path, built[1], gate={"sources": ["physical/*"]})
    code, err = _evaluate(capsys, "hover", *evaluation.arguments("--geometric", str(webcam), "--bootstrap", "20"))
    assert code == 0, err
    assert seen   # the physical row's frame
    seen.clear()
    code, err = _evaluate(capsys, "crops", *evaluation.arguments("--geometric", str(webcam), "--bootstrap", "20"))
    assert code == 0, err
    assert seen == []   # the crops come from the digital row only
    client = _settings(tmp_path, built[1], gate={"sources": ["digital/*"]})
    code, err = _evaluate(capsys, "crops", *evaluation.arguments("--geometric", str(client), "--bootstrap", "20"))
    assert code == 0, err
    assert seen


# ------------------------------------------------------------- a release, from private inputs
def test_an_index_is_built_from_a_callers_own_catalog_art_and_bank(tmp_path, toy, evaluation):
    import shutil

    from cardvision.bank.build import build_bank, write_bank
    from cardvision.evaluate.config import file_sha256

    catalog_path, art_dir = toy
    private = tmp_path / "private"
    shutil.copytree(art_dir, private / "images")
    (private / "game").mkdir()
    shutil.copy(catalog_path, private / "game" / "catalog.json")   # the default rule: one identity per name
    catalog = load_catalog(private / "game" / "catalog.json")
    assert catalog.identity == "name"
    bank_doc = build_bank(catalog, private / "images", create_session(evaluation.toy.recognizer), model="toy").bank
    bank, _ = write_bank(bank_doc, catalog, private / "banks" / "bank.json")
    settings = private / "geometric.json"
    settings.write_text(json.dumps({"features": {"artLongSide": 200}, "crop": {"longSide": 200},
                                    "index": {"path": "features/index.json"}}), encoding="utf-8")
    result = subprocess.run([sys.executable, "-m", "cardvision", "build-features", "--config", str(settings),
                             "--catalog", str(private / "game" / "catalog.json"), "--art", str(private / "images"),
                             "--bank", str(bank), "--pin"], capture_output=True, text=True, cwd=tmp_path,
                            env={**__import__("os").environ, "PYTHONPATH": str(ROOT)}, check=False)
    assert result.returncode == 0, result.stderr
    index = private / "features" / "index.json"
    pinned = json.loads(settings.read_text())["index"]
    assert pinned == {"path": "features/index.json", "sha256": file_sha256(index)}
    assert f"sha256: {pinned['sha256']}" in result.stdout
    doc = json.loads(index.read_text())
    assert doc["features"]["artLongSide"] == 200 and doc["bank"]["sha256"] == file_sha256(bank)
    assert GeometricStage.open(settings, bank=bank).index.ids == [entry["cardId"] for entry in bank_doc["entries"]]


@pytest.fixture(scope="module")
def toy_release(evaluation, tmp_path_factory):
    """A toy release (its bank and groups file built by the bank tool) and an index for it."""
    from test_evaluate_cli import write_release

    root = write_release(tmp_path_factory.mktemp("release"), evaluation, [(40, 40, 240, 336)], [0.9], [0],
                         {"tau": 0.9, "delta": 0.02, "rotationRetry": True})
    catalog_path = root / "catalog.json"
    settings = root / "geometric.json"
    settings.write_text(json.dumps({"candidates": {"embeddingTopK": 3}, "gate": {"sources": ["physical/*"]}}),
                        encoding="utf-8")
    result = _run_cli(["build-features", "--config", str(settings), "--catalog", str(catalog_path), "--art",
                       str(evaluation.toy.art_dir), "--bank", str(root / "bank.json"), "--pin"])
    assert result.returncode == 0, result.stderr
    return root


def test_an_evaluation_of_a_release_with_the_stage_records_what_ran(evaluation, toy_release, capsys, tmp_path):
    code, err = _evaluate(capsys, "hover", "--manifest", str(evaluation.manifest), "--frames", str(evaluation.frames),
                          "--release", str(toy_release / "release.json"), "--geometric",
                          str(toy_release / "geometric.json"), "--bootstrap", "20", "--out", str(tmp_path))
    assert code == 0, err
    result = json.loads((tmp_path / "evaluate-hover.json").read_text())
    described = result["configuration"]
    pinned = json.loads((toy_release / "geometric.json").read_text())["index"]["sha256"]
    assert described["files"]["geometricIndex"]["sha256"] == pinned
    assert described["geometric"]["opencv"] == cv2.__version__
    assert described["geometric"]["gate"] == {"belowAccept": False, "sources": ["physical/*"]}
    assert described["release"] is not None
    report = (tmp_path / "evaluate-hover.md").read_text()
    assert pinned in report and cv2.__version__ in report and "geometric stage" in report


def test_with_the_stage_identity_is_read_from_the_releases_groups_file(toy_release, tmp_path):
    import dataclasses

    from cardvision.evaluate.config import open_configuration, spec_from_release

    spec = spec_from_release(toy_release / "release.json").replacing(geometric=toy_release / "geometric.json")
    recognizer = open_configuration(spec).pipeline.recognizer
    column = {card_id: recognizer.column_identity[i] for i, card_id in enumerate(recognizer.ids)}
    assert column["TOY-003"] == column["TOY-003A"] and column["TOY-010"] == column["TOY-P01"]
    # A groups file that merges two cards the catalog keeps apart: with the stage, its word wins.
    groups = json.loads((toy_release / "bank.identity-groups.json").read_text())
    groups["groups"].append(["TOY-001", "TOY-002"])
    groups["representative"]["TOY-002"] = "TOY-001"
    merged = tmp_path / "merged.identity-groups.json"
    merged.write_text(json.dumps(groups), encoding="utf-8")
    recognizer = open_configuration(dataclasses.replace(spec, identity_groups=merged)).pipeline.recognizer
    column = {card_id: recognizer.column_identity[i] for i, card_id in enumerate(recognizer.ids)}
    assert column["TOY-001"] == column["TOY-002"] and column["TOY-003"] == column["TOY-003A"]
    assert column["TOY-001"] != column["TOY-005"]


# ----------------------------------------------------------- an index and the bank it serves
@pytest.fixture
def own_bank(tmp_path, toy, evaluation):
    """A copy of the toy art and a bank built from it by the bank tool (each row records its
    image), with an index built for that bank and pinned in a settings file."""
    import shutil

    from cardvision.bank.build import build_bank, write_bank

    catalog_path, art_dir = toy
    art = tmp_path / "art"
    shutil.copytree(art_dir, art)
    catalog = load_catalog(catalog_path)
    bank, _ = write_bank(build_bank(catalog, art, create_session(evaluation.toy.recognizer), model="toy").bank,
                         catalog, tmp_path / "bank.json")
    settings = tmp_path / "geometric.json"
    settings.write_text("{}", encoding="utf-8")
    result = _run_cli(["build-features", "--config", str(settings), "--catalog", str(catalog_path), "--art", str(art),
                       "--bank", str(bank), "--pin"])
    assert result.returncode == 0, result.stderr
    return settings, tmp_path / "bank.features.json", bank, art


def test_an_index_is_not_built_from_another_image_than_the_bank_records(tmp_path, toy, own_bank):
    import shutil

    settings, _, bank, art = own_bank
    shutil.copy(art / "TOY-002.png", art / "TOY-001.png")   # the image changed after the bank was built
    result = _run_cli(["build-features", "--config", str(settings), "--catalog", str(toy[0]), "--art", str(art),
                       "--bank", str(bank), "--out", str(tmp_path / "again.json")])
    assert result.returncode == 1
    assert "TOY-001" in result.stderr and "refresh the bank first" in result.stderr
    result = _run_cli(["build-features", "--config", str(settings), "--catalog", str(toy[0]), "--art", str(art),
                       "--bank", str(bank), "--skip-missing-art", "--out", str(tmp_path / "skip.json")])
    assert result.returncode == 1 and "--skip-missing-art" in result.stderr


def _edited_index(own_bank, folder: Path, change) -> Path:
    """The index of ``own_bank`` edited by hand: it still records the bank's SHA-256."""
    doc = json.loads(own_bank[1].read_text())
    change(doc)
    doc["cardCount"] = len(doc["cards"])
    path = folder / "edited.features.json"
    path.write_bytes(canonical_bytes(doc))
    return _settings(folder, path)


def test_a_matching_bank_hash_does_not_excuse_a_changed_image(tmp_path, own_bank):
    def swap(doc):
        doc["cards"][0]["artV"] = "0123456789abcdef"

    edited = _edited_index(own_bank, tmp_path, swap)
    assert json.loads(own_bank[1].read_text())["bank"]["sha256"] == __import__("hashlib").sha256(
        own_bank[2].read_bytes()).hexdigest()
    with pytest.raises(ValueError, match="another image"):
        GeometricStage.open(edited, bank=own_bank[2])


def test_a_matching_bank_hash_does_not_excuse_a_missing_card(tmp_path, own_bank):
    edited = _edited_index(own_bank, tmp_path, lambda doc: doc["cards"].pop(3))
    with pytest.raises(ValueError, match="no entry"):
        GeometricStage.open(edited, bank=own_bank[2])
    assert GeometricStage.open(own_bank[0], bank=own_bank[2])


def test_another_catalog_lets_go_of_the_release_identity_groups():
    from cardvision.evaluate.config import Spec

    spec = Spec(detector=Path("d.onnx"), recognizer=Path("r.onnx"), bank=Path("b.json"), catalog=Path("c.json"),
                identity_groups=Path("b.identity-groups.json"), geometric=Path("g.json"))
    assert spec.replacing(catalog="other.json").identity_groups is None
    assert spec.replacing(accept=None, geometric="h.json").identity_groups == Path("b.identity-groups.json")


def test_infer_says_when_the_source_gate_keeps_the_stage_off(tmp_path_factory, toy, built, capsys, tmp_path):
    from cardvision import cli

    setup = ToySetup(tmp_path_factory.mktemp("gate-note"), *toy)
    gated = _settings(tmp_path, built[1], gate={"sources": ["physical/*"]})
    assert cli.main(["infer", str(setup.image), *setup.arguments(), "--geometric", str(gated)]) == 0
    captured = capsys.readouterr()
    assert "gate.sources is set and infer knows no source type" in captured.err
    assert not any("geometric" in box for box in json.loads(captured.out.splitlines()[0])["boxes"])


def test_an_index_built_with_another_opencv_is_reported(evaluation, built, capsys, tmp_path):
    doc = json.loads(built[1].read_text())
    doc["opencv"] = "0.0.1"
    index = tmp_path / "old.features.json"
    index.write_bytes(canonical_bytes(doc))
    settings = _settings(tmp_path, index)
    code, err = _evaluate(capsys, "hover", *evaluation.arguments("--geometric", str(settings), "--bootstrap", "20",
                                                                "--out", str(tmp_path / "out")))
    assert code == 0, err
    assert "OpenCV 0.0.1" in err
    described = json.loads((tmp_path / "out" / "evaluate-hover.json").read_text())["configuration"]["geometric"]
    assert described["indexOpencv"] == "0.0.1" and described["opencv"] == cv2.__version__
    assert "**warning**: the descriptor index was built with OpenCV 0.0.1" in (tmp_path / "out" / "evaluate-hover.md").read_text()


@pytest.mark.parametrize("change, message", [
    (lambda doc: doc["cards"][0].update(artV="NOT-HEX"), "artV"),
    (lambda doc: doc["cards"][0].pop("artV"), "artV"),
    (lambda doc: doc["cards"][0].update(xy=__import__("base64").b64encode(
        np.full(2 * doc["cards"][0]["n"], np.nan, "<f4").tobytes()).decode()), "finite"),
])
def test_an_index_with_a_bad_image_record_or_positions_is_refused(built, change, message):
    with pytest.raises(ValueError, match=message):
        parse_index(_broken(built, change))


def test_evaluate_hover_evidence_changes_no_figure(tmp_path, toy, built):
    """``evaluate hover --evidence`` writes a line per frame with each face's debug account, and
    the result, the report and the listing are byte for byte those of a run without it."""
    from cardvision.composites import generate
    from cardvision.evaluate.evidence import EVIDENCE_KIND

    catalog_path, art_dir = toy
    (tmp_path / "models").mkdir()
    setup = ToySetup(tmp_path / "models", catalog_path, art_dir)
    scenes = tmp_path / "scenes"
    generate(load_catalog(catalog_path), art_dir, scenes, 2, seed=1, split="val")
    base = ["evaluate", "hover", "--scenes", str(scenes), *setup.arguments(), "--geometric", str(built[0]),
            "--bootstrap", "20"]
    plain = _run_cli([*base, "--out", str(tmp_path / "plain")])
    assert plain.returncode == 0, plain.stderr
    evidence = tmp_path / "evidence.jsonl"
    witnessed = _run_cli([*base, "--out", str(tmp_path / "witnessed"), "--evidence", str(evidence)])
    assert witnessed.returncode == 0, witnessed.stderr
    assert witnessed.stdout == plain.stdout
    for name in ("evaluate-hover.json", "evaluate-hover.md", "evaluate-hover-events.jsonl"):
        assert (tmp_path / "witnessed" / name).read_bytes() == (tmp_path / "plain" / name).read_bytes(), name
    lines = [json.loads(line) for line in evidence.read_text().splitlines()]
    assert lines[0]["kind"] == EVIDENCE_KIND and lines[0]["side"] == "python" and lines[0]["identities"]
    rows = lines[1:]
    assert len(rows) == 2
    listed = [json.loads(line) for line in (tmp_path / "plain" / "evaluate-hover-events.jsonl").read_text().splitlines()]
    assert [event["outcome"] for row in rows for event in row["events"]] == [event["outcome"] for event in listed]
    faces = [face for row in rows for face in row["faces"]]
    assert faces and all(face["geometric"] and face["geometric"]["debug"]["grey"]["sha256"] for face in faces)
    assert all(len(face["geometric"]["debug"]["rows"]) == face["geometric"]["debug"]["keypoints"] for face in faces)
    assert all(len(row["frame"]["pixelSha256"]) == 64 for row in rows)


# ------------------------------------------------------------------------ adding cards to an index
def _bank_file(path: Path, catalog_path: Path, art_dir: Path, ids: list[str], unrecorded: set[str] = frozenset()) -> Path:
    """A bank of ``ids`` in that order whose rows record their images, but for the ``unrecorded``
    ones (the vectors do not matter here)."""
    from cardvision.core.bank import art_version, encode_bank

    catalog = load_catalog(catalog_path)
    rows = np.random.default_rng(0).normal(size=(len(ids), 8))
    versions = [None if card_id in unrecorded else art_version((art_dir / catalog.card(card_id).art).read_bytes())
                for card_id in ids]
    path.write_text(json.dumps(encode_bank(ids, rows / np.linalg.norm(rows, axis=1, keepdims=True), {"dim": 8},
                                           versions)), encoding="utf-8")
    return path


def _sub_catalog(path: Path, catalog_path: Path, leave_out: set[str], extra: list[dict] = ()) -> Path:
    raw = json.loads(catalog_path.read_text(encoding="utf-8"))
    raw["cards"] = [card for card in raw["cards"] if card["id"] not in leave_out] + list(extra)
    path.write_text(json.dumps(raw), encoding="utf-8")
    return path


def _build(settings: Path, catalog: Path, art_dir: Path, out: Path, *extra: str) -> subprocess.CompletedProcess:
    return _run_cli(["build-features", "--config", str(settings), "--catalog", str(catalog), "--art", str(art_dir),
                     "--out", str(out), *extra])


def test_an_index_extended_over_an_extended_bank_is_the_full_build_and_packs_onto_the_old_shards(tmp_path, toy):
    """The case of a product with a bank: the bank is extended (old rows first, build-bank --base),
    the index with --base, and the pack with --base. The extended index is byte for byte the index
    a full build gives, so the stage's results are the same, and the old shards are unchanged."""
    from cardvision.evaluate.config import file_sha256
    from cardvision.geometric.pack import read_packed

    catalog_path, art_dir = toy
    ids = load_catalog(catalog_path).ids()
    old_bank = _bank_file(tmp_path / "old-bank.json", catalog_path, art_dir, ids[:-4])
    new_bank = _bank_file(tmp_path / "new-bank.json", catalog_path, art_dir, ids)
    settings = tmp_path / "geometric.json"
    settings.write_text("{}", encoding="utf-8")
    old, extended, full = (tmp_path / f"{name}.features.json" for name in ("old", "extended", "full"))
    for result in (_build(settings, catalog_path, art_dir, old, "--bank", str(old_bank)),
                   _build(settings, catalog_path, art_dir, extended, "--bank", str(new_bank), "--base", str(old)),
                   _build(settings, catalog_path, art_dir, full, "--bank", str(new_bank))):
        assert result.returncode == 0, result.stderr
    assert extended.read_bytes() == full.read_bytes()
    assert "kept from the base index: 16 cards, unchanged; added: 4" in _build(
        settings, catalog_path, art_dir, tmp_path / "again.features.json", "--bank", str(new_bank), "--base",
        str(old)).stdout
    for args in (["--index", str(old), "--out", str(tmp_path / "v1"), "--content-names"],
                 ["--index", str(extended), "--out", str(tmp_path / "v2"), "--base", str(tmp_path / "v1" / "manifest.json")]):
        result = _run_cli(["pack-features", *args])
        assert result.returncode == 0, result.stderr
    base, base_blobs = read_packed(tmp_path / "v1" / "manifest.json")
    manifest, blobs = read_packed(tmp_path / "v2" / "manifest.json")
    assert manifest["shards"][:len(base["shards"])] == base["shards"] and blobs[:len(base_blobs)] == base_blobs
    assert len(manifest["shards"]) > len(base["shards"])
    assert manifest["bank"]["sha256"] == file_sha256(new_bank) and base["bank"]["sha256"] == file_sha256(old_bank)
    assert manifest["source"]["sha256"] == file_sha256(full)


def test_build_features_base_refuses_an_index_it_cannot_extend(tmp_path, toy):
    catalog_path, art_dir = toy
    ids = load_catalog(catalog_path).ids()
    settings = tmp_path / "geometric.json"
    settings.write_text("{}", encoding="utf-8")
    old_bank = _bank_file(tmp_path / "old-bank.json", catalog_path, art_dir, ids[:-2])
    old = tmp_path / "old.features.json"
    assert _build(settings, catalog_path, art_dir, old, "--bank", str(old_bank)).returncode == 0
    new_bank = _bank_file(tmp_path / "new-bank.json", catalog_path, art_dir, ids)

    def refused(base: Path, fragment: str, config: Path = settings, bank: Path = new_bank, art: Path = art_dir,
                *extra: str) -> None:
        out = tmp_path / "refused.features.json"
        result = _build(config, catalog_path, art, out, "--base", str(base), *(["--bank", str(bank)] if bank else []),
                        *extra)
        assert result.returncode == 1 and fragment in result.stderr, result.stderr
        assert not out.exists()

    other = tmp_path / "other.json"
    other.write_text(json.dumps({"features": {"maxFeatures": 200}}), encoding="utf-8")
    refused(old, "maxFeatures", other)
    doc = json.loads(old.read_text())
    doc["opencv"] = "4.10.0"
    tampered = tmp_path / "opencv.features.json"
    tampered.write_bytes(canonical_bytes(doc))
    refused(tampered, "OpenCV '4.10.0'")
    # An old card whose image changed: the bank's row records the new image ...
    import shutil

    moved = tmp_path / "art"
    shutil.copytree(art_dir, moved)
    shutil.copy(moved / "TOY-002.png", moved / "TOY-001.png")
    refused(old, "have another image in the bank", bank=_bank_file(tmp_path / "moved-bank.json", catalog_path, moved, ids),
            art=moved)
    # ... the bank's row records no image, so the image at the art location is compared ...
    unrecorded = _bank_file(tmp_path / "unrecorded-bank.json", catalog_path, moved, ids, unrecorded={"TOY-001"})
    refused(old, "have another image now", bank=unrecorded, art=moved)
    # ... and without a bank, the same.
    refused(old, "have another image now", bank=None, art=moved)
    # An old card the bank no longer lists is refused: its entry could not be checked.
    refused(old, "not in the bank", bank=_bank_file(tmp_path / "fewer-bank.json", catalog_path, art_dir, ids[1:]))
    # A row that records no image but whose image is unchanged is accepted.
    accepted = _build(settings, catalog_path, art_dir, tmp_path / "ok.features.json", "--base", str(old), "--bank",
                      str(_bank_file(tmp_path / "ok-bank.json", catalog_path, art_dir, ids, unrecorded={"TOY-001"})))
    assert accepted.returncode == 0, accepted.stderr


def _scaled(art_dir: Path, card_id: str, scale: float) -> np.ndarray:
    image = load_rgb(art_dir / f"{card_id}.png")
    if scale == 1:
        return image
    size = (int(image.shape[1] * scale), int(image.shape[0] * scale))
    return cv2.resize(image, size, interpolation=cv2.INTER_AREA)


def _competing(stage: GeometricStage, crop: np.ndarray, new: set[str]) -> bool:
    """Whether a new card's row is the nearest or second nearest row of any crop keypoint."""
    index = stage.index
    row_card = [card_id for card_id in index.ids for _ in range(len(index.cards[card_id]))]
    stacked = np.concatenate([index.cards[card_id].descriptors for card_id in index.ids])
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(stage.crop_features(crop).descriptors, stacked, k=2)
    return any(row_card[match.trainIdx] in new for pair in pairs for match in pair)


def test_old_cards_are_found_as_before_when_the_added_cards_do_not_compete(tmp_path):
    """Base plus append against the base alone, on crops of the old cards: wherever no added
    card's row is among a crop keypoint's two nearest, the stage's result is the same (old rows
    keep their order, so every tie goes as before)."""
    import toy_game
    from PIL import Image

    from cardvision.geometric.index import build_index

    catalog_path, art_dir = toy_game.write_toy_game(tmp_path / "toy")
    rng = np.random.default_rng(5)
    added = []
    first = json.loads(catalog_path.read_text())["cards"][0]
    for i in range(3):
        Image.fromarray(rng.integers(0, 256, size=(320, 229, 3), dtype=np.uint8)).save(art_dir / f"NEW-{i}.png")
        added.append(dict(first, id=f"NEW-{i}", name=f"Noise {i}", art=f"NEW-{i}.png", printingOf=None))
    old_catalog = load_catalog(catalog_path)
    new_catalog = load_catalog(_sub_catalog(tmp_path / "new.json", catalog_path, set(), added))
    features = parse_geometric({}).features
    base, _ = build_index(old_catalog, art_dir, features)
    extended, _ = build_index(new_catalog, art_dir, features, base=base)
    assert extended["cards"][:len(base["cards"])] == base["cards"]
    config = parse_geometric({"candidates": {"embeddingTopK": 3, "voteTopN": 3}})
    before, after = GeometricStage(config, parse_index(base)), GeometricStage(config, parse_index(extended))
    old = old_catalog.ids()
    ranked = [(card_id, 0.9 - 0.01 * i) for i, card_id in enumerate(old)]
    quiet = 0
    for scale in (1.0, 0.6):
        for card_id in old:
            crop = _scaled(art_dir, card_id, scale)
            if _competing(after, crop, {card["id"] for card in added}):
                continue
            quiet += 1
            mine, theirs = after.verify(crop, ranked, known=set(old)), before.verify(crop, ranked, known=set(old))
            assert (mine.candidates, mine.crop_keypoints) == (theirs.candidates, theirs.crop_keypoints), card_id
    assert quiet >= 10


def test_an_index_extended_in_catalog_order_differs_from_a_full_build_only_in_row_order(tmp_path, toy):
    """Without a bank, cards are in catalog order, and a card the catalog lists among the old ones
    is appended at the end, where a full build puts it in place. The entries are the same; only
    their order differs, and with it which of two equally near rows a crop keypoint is given in
    the vote. Matches and inliers of a card do not depend on the order."""
    from cardvision.geometric.index import build_index

    catalog_path, art_dir = toy
    catalog = load_catalog(catalog_path)
    middle = {"TOY-006", "TOY-007", "TOY-008"}
    features = parse_geometric({}).features
    base, _ = build_index(load_catalog(_sub_catalog(tmp_path / "sub.json", catalog_path, middle)), art_dir, features)
    extended, _ = build_index(catalog, art_dir, features, base=base)
    full, _ = build_index(catalog, art_dir, features)
    assert [card["cardId"] for card in extended["cards"]] == [card["cardId"] for card in base["cards"]] + \
        [card_id for card_id in catalog.ids() if card_id in middle]
    assert [card["cardId"] for card in full["cards"]] == catalog.ids()
    assert sorted(extended["cards"], key=lambda card: card["cardId"]) == sorted(full["cards"], key=lambda card: card["cardId"])
    config = parse_geometric({"candidates": {"embeddingTopK": 3, "voteTopN": 3}})
    one, other = GeometricStage(config, parse_index(extended)), GeometricStage(config, parse_index(full))
    ranked = [(card_id, 0.9 - 0.01 * i) for i, card_id in enumerate(catalog.ids())]
    for card_id in ("TOY-001", "TOY-007", "TOY-P01"):
        crop = _crop(art_dir, card_id)
        mine = {found.card_id: (found.matches, found.inliers) for found in one.verify(crop, ranked).candidates}
        theirs = {found.card_id: (found.matches, found.inliers) for found in other.verify(crop, ranked).candidates}
        assert mine.keys() & theirs.keys()
        assert all(mine[card] == theirs[card] for card in mine.keys() & theirs.keys())
