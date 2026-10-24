# SPDX-License-Identifier: Apache-2.0
"""The data seam: the row format, the built-in streams cut from toy data, plug-in streams
defined in this file, and the two validation sets. No PyTorch needed."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import support_train_recognizer as support
from cardvision.composites import read_labels
from cardvision.data import geometry
from cardvision.train_recognizer import sources as S
from cardvision.train_recognizer.config import ConfigError, parse_config
from helpers import pattern

PLUGIN_IMAGE = pattern(140, 100)
QUIET = lambda line: None  # noqa: E731


@pytest.fixture(scope="module")
def toy(tmp_path_factory):
    return support.shared_toy_data(tmp_path_factory)


def build(toy, out: Path, log=QUIET, **over) -> S.Sources:
    return S.build_sources(parse_config(support.toy_document(toy, **over)), out, log)


@pytest.fixture(scope="module")
def built(toy, tmp_path_factory) -> S.Sources:
    return build(toy, tmp_path_factory.mktemp("sources"))


# ----------------------------------------------------------------------------- the row format
def test_inner_is_cut_to_whole_pixels_and_clipped():
    assert S.whole_inner([10.7, 20.2, 50.9, 60.0]) == [10, 20, 51, 60]            # edges 10.7..61.6 and 20.2..80.2
    assert S.whole_inner([-4.5, -1.0, 50.0, 60.0]) == [0, 0, 45, 59]
    assert S.whole_inner([80.0, 90.0, 50.0, 60.0], 100, 120) == [80, 90, 20, 30]
    assert S.whole_inner([200.0, 10.0, 50.0, 60.0], 100, 120) == [200, 10, 0, 60]  # wholly outside: no width left
    assert S.whole_inner([3, 4, 5, 6], 100, 120) == [3, 4, 5, 6]


def cut_before_the_turn(inner, width, height, turns):
    """How the trainer used to bring a turned crop's fractional box to whole pixels: turn it
    back to how it lay when the crop was cut, cut it down and clip it there, and turn it again."""
    k = turns % 4
    if not k:
        return S.whole_inner(inner, width, height)
    before = geometry.rotate_box_with_crop(tuple(inner), width, height, 4 - k)
    w0, h0 = (height, width) if k % 2 else (width, height)
    return [int(v) for v in geometry.rotate_box_with_crop(tuple(S.whole_inner(before, w0, h0)), w0, h0, k)]


@pytest.mark.parametrize("turns", [0, 1, 2, 3])
def test_a_cut_crop_s_inner_needs_no_further_work(turns):
    """``margin_crop`` now returns the box in whole pixels, clipped, cut before the turn. Over
    random boxes (inside the frame, across its edges, any margin) that is exactly what the
    trainer used to work out from the fractional box, so the rows are the same rows."""
    from cardvision.data.targets import margin_crop

    rng = np.random.default_rng(100 + turns)
    frame = np.zeros((360, 640, 3), dtype=np.uint8)
    compared = clipped = off_frame = 0
    for _ in range(4000):
        box = (rng.uniform(-40, 660), rng.uniform(-40, 380), rng.uniform(3, 300), rng.uniform(3, 300))
        margin = float(rng.choice([0.0, 0.1, 0.25, 0.4]))
        crop, inner = margin_crop(frame, box, margin, turns)
        if crop.size == 0:
            continue
        height, width = crop.shape[:2]
        # The fractional box as it was returned before, and what the trainer made of it.
        x, y, w, h = box
        x0, y0 = int(max(0, x - margin * w)), int(max(0, y - margin * h))
        uncut = (width, height) if turns % 2 == 0 else (height, width)
        fractional = geometry.rotate_box_with_crop((x - x0, y - y0, w, h), *uncut, turns)
        before = cut_before_the_turn(fractional, width, height, turns)
        # Already whole and inside the image: nothing is left for whole_inner to do.
        assert all(isinstance(value, int) for value in inner)
        assert S.whole_inner(inner, width, height) == list(inner)
        if int(min(640, x + w)) <= int(max(0, x)) or int(min(360, y + h)) <= int(max(0, y)):
            # The box has no pixel in the frame (only its margin does): no area either way,
            # and both the old and the new trainer drop such a row.
            assert inner[2] * inner[3] == 0 and before[2] * before[3] == 0
            off_frame += 1
            continue
        assert list(inner) == before, (box, margin)
        compared += 1
        clipped += x < 0 or y < 0 or x + w > 640 or y + h > 360
    assert compared > 3000 and clipped > 300 and off_frame > 10


def test_a_row_s_image_comes_from_a_path_or_an_array(tmp_path):
    Image.fromarray(PLUGIN_IMAGE).save(tmp_path / "a.png")
    assert np.array_equal(S.load_image({"path": "a.png", "inner": [0, 0, 1, 1]}, str(tmp_path)), PLUGIN_IMAGE)
    assert np.array_equal(S.load_image({"path": str(tmp_path / "a.png"), "inner": [0, 0, 1, 1]}), PLUGIN_IMAGE)
    assert S.load_image({"image": PLUGIN_IMAGE, "inner": [0, 0, 1, 1]}) is PLUGIN_IMAGE


# ----------------------------------------------------------------------- card images, patches
def test_card_images_are_read_once_and_reduced(toy):
    from cardvision.core.catalog import load_catalog

    catalog = load_catalog(toy.catalog)
    art = S.load_art(catalog, toy.art, 64)
    assert sorted(art) == sorted(catalog.ids())
    assert all(image.dtype == np.uint8 and image.shape[1] <= 128 and image.shape[0] <= 192 for image in art.values())
    portrait, landscape = art["TOY-001"], art["TOY-017"]
    assert portrait.shape[0] > portrait.shape[1] and landscape.shape[1] > landscape.shape[0]
    (toy.root / "half-art").mkdir(exist_ok=True)
    Image.open(toy.art / "TOY-001.png").save(toy.root / "half-art" / "TOY-001.png")
    assert list(S.load_art(catalog, toy.root / "half-art", 64)) == ["TOY-001"]   # the rest are left out


def test_a_card_without_art_has_no_image_to_train_on(toy):
    from cardvision.core.catalog import parse_catalog

    document = json.loads(Path(toy.catalog).read_text(encoding="utf-8"))
    document["cards"].append({"id": "TOY-NEW", "name": "Lantern Moth", "kind": "unit", "printingOf": None, "art": None})
    catalog = parse_catalog(document)
    assert sorted(S.load_art(catalog, toy.art, 64)) == sorted(catalog.ids_with_art()) and "TOY-NEW" not in catalog.ids_with_art()


def test_background_patches_are_fixed_by_the_seed(tmp_path):
    a = S.make_background_patches(5, 48, seed=3)
    b = S.make_background_patches(5, 48, seed=3)
    c = S.make_background_patches(5, 48, seed=4)
    assert len(a) == 5 and all(p.shape == (48, 48, 3) and p.dtype == np.uint8 for p in a)
    assert all(np.array_equal(x, y) for x, y in zip(a, b)) and not all(np.array_equal(x, y) for x, y in zip(a, c))
    assert np.array_equal(S.make_background_patches(2, 48, seed=3)[1], a[1])       # patch i depends on i, not on the count

    # With a textures folder, the stated share of patches comes from its training scans.
    scan = np.zeros((64, 64, 3), np.uint8)
    scan[..., 0] = 250
    (tmp_path / "train").mkdir()
    Image.fromarray(scan).save(tmp_path / "train" / "red.png")
    (tmp_path / "index.json").write_text(json.dumps([
        {"file": "train/red.png", "source": "made-up", "assetId": "red", "split": "train", "category": "fabric"},
        {"file": "train/missing.png", "source": "made-up", "assetId": "other", "split": "val", "category": "fabric"}]))
    every = S.make_background_patches(6, 32, seed=3, textures_dir=tmp_path, texture_share=1.0)
    assert all(p[..., 0].mean() > 150 and p[..., 1].mean() < 20 for p in every)
    none = S.make_background_patches(6, 32, seed=3, textures_dir=tmp_path, texture_share=0.0)
    assert not any(p[..., 0].mean() > 150 and p[..., 1].mean() < 20 for p in none)
    with pytest.raises(FileNotFoundError):
        S.make_background_patches(1, 32, seed=3, textures_dir=tmp_path / "nowhere")


# ------------------------------------------------------- [background_patches] folder
def _patch_folder(folder: Path, size: int = 24) -> dict[str, np.ndarray]:
    folder.mkdir()
    made = {}
    for i, name in enumerate(["b.PNG", "a.png", "C.jpg", "d.webp", "Z.jpeg"]):
        image = np.full((size, size, 3), 10 + 40 * i, np.uint8)
        image[0, 0] = (i, 2 * i, 3 * i)
        Image.fromarray(image).save(folder / name, lossless=True) if name.endswith("webp") else \
            Image.fromarray(image).save(folder / name, quality=100) if name.endswith(("jpg", "jpeg")) else \
            Image.fromarray(image).save(folder / name)
        made[name] = image
    (folder / "notes.txt").write_text("not an image")
    (folder / "sub").mkdir()
    return made


def test_a_patch_folder_replaces_the_generated_patches(tmp_path):
    made = _patch_folder(tmp_path / "p")
    patches = S.load_background_patches(tmp_path / "p", 24)
    # byte-wise name order: uppercase before lowercase
    assert [p[1, 1, 0] for p in patches] == [made[n][1, 1, 0] for n in ["C.jpg", "Z.jpeg", "a.png", "b.PNG", "d.webp"]]
    assert np.array_equal(patches[2], made["a.png"]) and np.array_equal(patches[3], made["b.PNG"])
    assert all(p.shape == (24, 24, 3) and p.dtype == np.uint8 for p in patches)
    assert len(S.load_background_patches(tmp_path / "p", 24, count=5)) == 5


def test_a_patch_folder_is_checked(tmp_path):
    _patch_folder(tmp_path / "p")
    with pytest.raises(ConfigError, match="C.jpg.*24x24"):
        S.load_background_patches(tmp_path / "p", 32)
    with pytest.raises(ConfigError, match="count is 4"):
        S.load_background_patches(tmp_path / "p", 24, count=4)
    (tmp_path / "empty").mkdir()
    with pytest.raises(ConfigError, match="no .png"):
        S.load_background_patches(tmp_path / "empty", 24)


def test_the_folder_key_in_a_config(toy, tmp_path):
    made = _patch_folder(tmp_path / "p")
    doc = support.toy_document(toy, background_patches={"size": 24, "folder": "p"})
    doc["background_patches"].pop("count", None)      # the toy document may set one; here it is left out
    cfg = parse_config(doc, folder=tmp_path)
    assert cfg["background_patches"]["folder"] == str((tmp_path / "p").resolve()) and cfg["background_patches"]["count"] is None
    sources = S.build_sources(cfg, tmp_path / "out", QUIET)
    assert len(sources.patches) == 5 and np.array_equal(sources.patches[2], made["a.png"])
    import hashlib
    expected = hashlib.sha256()
    for name in sorted(made):
        expected.update(name.encode() + b"\0" + hashlib.sha256((tmp_path / "p" / name).read_bytes()).hexdigest().encode() + b"\n")
    assert sources.inputs["backgroundPatches"] == {"files": 5, "sha256": expected.hexdigest()}
    cfg = parse_config(support.toy_document(toy, background_patches={"size": 24, "folder": "p", "count": 6}), folder=tmp_path)
    with pytest.raises(ConfigError, match="count is 6"):
        S.build_sources(cfg, tmp_path / "out2", QUIET)
    with pytest.raises(ConfigError, match="unknown"):
        parse_config(support.toy_document(toy, background_patches={"folders": "p"}), folder=tmp_path)


def test_without_a_folder_the_patches_are_the_generated_ones(toy, tmp_path):
    cfg = parse_config(support.toy_document(toy, background_patches={"count": 4, "size": 48}))
    assert cfg["background_patches"]["folder"] is None
    sources = S.build_sources(cfg, tmp_path / "out", QUIET)
    expected = S.make_background_patches(4, 48, cfg["seed"], cfg["data"]["textures"], 0.5)
    assert all(np.array_equal(a, b) for a, b in zip(sources.patches, expected)) and len(sources.patches) == 4
    assert "backgroundPatches" not in sources.inputs


# ---------------------------------------------------------------------- the built-in streams
def test_the_built_in_streams_of_the_toy_data(built, toy):
    streams = built.streams
    assert set(streams) == {"art", "composite_positives", "real_positives", "real_negatives"}
    unseen = set(support.UNSEEN)
    assert built.unseen_ids == sorted(unseen) and built.held_out_groups == [support.HELD_OUT_GROUP]

    # Card images: one row per card that may be trained on.
    art_rows = streams["art"].rows
    assert [row["card_id"] for row in art_rows] == sorted(set(built.art) - unseen) and len(built.art) == 20
    assert streams["art"].chain == "physical" and streams["art"].surface_margin == 0.4

    # Real crops: 12 frames of 6 faces, one back and one not-card box each.
    positives, negatives = streams["real_positives"].rows, streams["real_negatives"].rows
    held = [row for row in built.seen.rows]
    from cardvision.data import read_manifest

    named = [box.card_id for row in read_manifest(toy.manifest) for box in row.boxes if box.kind == "face"]
    assert len(named) == 72 and len(positives) + len(held) == sum(card_id not in unseen for card_id in named)
    assert {row["group"] for row in positives} == set(support.GROUPS) - {support.HELD_OUT_GROUP}
    assert {row["group"] for row in held} == {support.HELD_OUT_GROUP}
    assert not unseen & {row["card_id"] for row in positives + held}
    assert len(negatives) == 9 * 2 and {row["label"] for row in negatives} == {"back", "not-card"}
    assert all(row["card_id"] is None and row["group"] != support.HELD_OUT_GROUP for row in negatives)
    assert streams["real_negatives"].negative and not streams["real_positives"].negative

    # Composite crops: training cards to the stream, the cards kept out to validation.
    composites = streams["composite_positives"].rows
    assert composites and not unseen & {row["card_id"] for row in composites}
    assert built.unseen.rows and {row["card_id"] for row in built.unseen.rows} <= unseen
    assert len(built.unseen.rows) <= 40
    assert built.seen.bank is None and built.unseen.bank is None

    # The record of what was read.
    assert set(built.inputs) >= {"catalog", "art", "real", "composites"}
    assert len(built.inputs["catalog"]["sha256"]) == 64 and built.inputs["art"]["cards"] == 20
    assert len(built.inputs["real"]["real_positives"]["indexSha256"]) == 64
    assert len(built.patches) == 8 and built.patches[0].shape == (96, 96, 3)


def test_a_real_positive_is_an_upright_card_with_room_around_it(built, toy):
    seen_turned = 0
    for row in built.streams["real_positives"].rows:
        image = S.load_image(row)
        x, y, w, h = row["inner"]
        assert row["hw"] == list(image.shape[:2]) and x >= 0 and y >= 0 and x + w <= image.shape[1] and y + h <= image.shape[0]
        # The margin is 0.4 of the box on each side wherever the frame allows it.
        assert image.shape[1] <= round(w * 1.8) + 2 and image.shape[0] <= round(h * 1.8) + 2
        # Turned upright: the box holds the card's own picture.
        art = Image.open(toy.art / f"{row['card_id']}.png").convert("RGB").resize((w, h), Image.BILINEAR)
        difference = np.abs(np.asarray(art).astype(int) - image[y:y + h, x:x + w].astype(int)).mean()
        assert difference < 12, (row["path"], difference)
        seen_turned += row["turns"] != 0
    assert seen_turned > 0


def test_a_composite_crop_follows_the_stated_rule(built, toy):
    from cardvision.data.targets import margin_crop

    scenes = {scene["index"]: scene for scene in read_labels(toy.composites)}
    positive = [o for scene in scenes.values() for o in scene["objects"]
                if o["kind"] == "face" and o["positive"] and o["cardId"]]
    # The three limits, written out: nearly whole, not tiny, within 15 degrees of 0, 90, 180 or 270.
    wanted = [o for o in positive if o["visible"] >= 0.90 and o["short"] >= 48
              and min(o["angle"] % 90, 90 - o["angle"] % 90) <= 15]
    rows = built.streams["composite_positives"].rows
    cache_rows = [json.loads(line) for line in (Path(rows[0]["path"]).parent / "index.jsonl").read_text().splitlines()]
    assert len(cache_rows) == len(wanted) and 0 < len(wanted) < len(positive)
    assert built.inputs["composites"]["selection"] == {"minVisible": 0.90, "minShortSidePx": 48, "maxTiltDegrees": 15.0}
    turned = 0
    for row in cache_rows[:25]:
        index, face_id = Path(row["path"]).stem.split("-")
        scene = scenes[int(index)]
        face = next(o for o in scene["objects"] if str(o["id"]) == face_id)
        frame = np.asarray(Image.open(toy.composites / scene["file"]).convert("RGB"))
        turns = geometry.quarter_turns(face["corners"])
        expected, inner = margin_crop(frame, geometry.bounding_box(face["corners"]), support.MARGIN, turns)
        image = S.load_image(row, str(Path(rows[0]["path"]).parent))
        assert row["card_id"] == face["cardId"] and row["turns"] == turns and row["group"] == "composites"
        assert face in wanted and turns == round(face["angle"] / 90) % 4
        assert np.array_equal(image, expected)
        assert row["inner"] == list(inner) == S.whole_inner(inner, image.shape[1], image.shape[0])
        turned += turns != 0
    assert all(isinstance(value, int) for row in cache_rows for value in row["inner"])


# -------------------------------------------------------- which composite faces are cut
SCENE_SIZE = (1600, 900)  # width, height
CARD_ASPECT = 336 / 240   # the toy cards' height over their width


def drawn_face(frame: Image.Image, art_dir: Path, face_id: str, card_id: str, center, short: int, angle: float) -> dict:
    """Draw a toy card on ``frame`` and return its label object, as ``make-composites`` writes
    one: the corners from the placement, and ``angle``, ``short`` and ``visible`` computed from
    the corners. ``angle`` is the direction of the card's top, in degrees clockwise from
    image-up. ``visible`` is the share of the card inside the frame (nothing covers a card
    here); a card that is cut by the frame is drawn upright."""
    from cardvision.composites.geometry import image_angle

    width, height = short, round(short * CARD_ASPECT)
    picture = Image.open(art_dir / f"{card_id}.png").convert("RGBA").resize((width, height), Image.BILINEAR)
    turned = picture.rotate(-angle, expand=True, resample=Image.BICUBIC)
    cx, cy = center
    frame.paste(turned, (round(cx - turned.width / 2), round(cy - turned.height / 2)), turned)
    theta = np.radians(angle)
    turn = np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]])
    outline = np.array([[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]])
    corners = outline @ turn.T + np.array([cx, cy])
    x0, y0, x1, y1 = corners[:, 0].min(), corners[:, 1].min(), corners[:, 0].max(), corners[:, 1].max()
    inside = (min(x1, SCENE_SIZE[0]) - max(x0, 0)) * (min(y1, SCENE_SIZE[1]) - max(y0, 0)) / ((x1 - x0) * (y1 - y0))
    assert inside == 1 or angle == 0, "only an upright card may be cut by the frame here"
    sides = [float(np.linalg.norm(corners[i] - corners[(i + 1) % 4])) for i in range(4)]
    return {"id": face_id, "kind": "face", "source": "art", "cardId": card_id, "corners": corners.round(3).tolist(),
            "angle": round(image_angle(corners), 2), "visible": round(inside, 3), "short": round(min(sides), 1),
            "box": [max(x0, 0), max(y0, 0), min(x1, SCENE_SIZE[0]), min(y1, SCENE_SIZE[1])],
            "positive": True, "ignore": None}


# Faces on either side of each limit: id -> (center, short side, angle). A card of width 100
# whose center is 40 px from the left edge has 90 px of its width in the frame; at 39 px, 89.
JUST_INSIDE = {
    "whole": ((150, 150), 100, 0),
    "visible-090": ((40, 450), 100, 0),
    "short-48": ((330, 100), 48, 0),
    "tilt-15": ((500, 150), 100, 15),
    "tilt-75": ((750, 150), 100, 75),
    "tilt-105": ((1000, 150), 100, 105),
    "tilt-195": ((1250, 150), 100, 195),
    "tilt-285": ((1450, 150), 100, 285),
    "tilt-345": ((500, 400), 100, 345),
}
JUST_OUTSIDE = {
    "visible-089": ((39, 700), 100, 0),
    "short-47": ((330, 250), 47, 0),
    "tilt-15.02": ((750, 400), 100, 15.02),
    "tilt-74.98": ((1000, 400), 100, 74.98),
    "tilt-45": ((1250, 400), 100, 45),
    "tilt-164.9": ((1450, 400), 100, 164.9),
    "tilt-344.98": ((500, 700), 100, 344.98),
}
OUTSIDE_REASON = {"visible-089": S.NOT_VISIBLE_ENOUGH, "short-47": S.TOO_SMALL}
# An unseen card of the toy runs, one face on either side of a limit, for the validation set.
UNSEEN_FACES = {"unseen-in": ((850, 700), 100, 0), "unseen-out": ((1100, 700), 100, 30)}


def edge_scene(folder: Path, art_dir: Path) -> dict[str, dict]:
    """Write a composites folder of one scene holding the faces above, a card back and a face
    the labels do not mark positive. Returns the label objects by id."""
    (folder / "images").mkdir(parents=True)
    frame = Image.new("RGB", SCENE_SIZE, (24, 60, 44))
    objects = []
    ids = [card_id for card_id, _, _, _ in support.toy_game.CARDS if card_id not in support.UNSEEN]
    for number, (face_id, (center, short, angle)) in enumerate({**JUST_INSIDE, **JUST_OUTSIDE}.items()):
        objects.append(drawn_face(frame, art_dir, face_id, ids[number % len(ids)], center, short, angle))
    for face_id, (center, short, angle) in UNSEEN_FACES.items():
        objects.append(drawn_face(frame, art_dir, face_id, support.UNSEEN[0], center, short, angle))
    hidden = drawn_face(frame, art_dir, "not-positive", ids[0], (1400, 700), 100, 0)
    objects.append({**hidden, "positive": False, "ignore": "lowvis"})
    back = drawn_face(frame, art_dir, "back", ids[1], (1500, 700), 100, 0)
    objects.append({**back, "kind": "back", "cardId": None, "positive": False})
    frame.save(folder / "images" / "00000.png")
    scene = {"index": 0, "split": "train", "seed": 0, "file": "images/00000.png", "width": SCENE_SIZE[0],
             "height": SCENE_SIZE[1], "layout": "table", "objects": objects}
    (folder / "labels.jsonl").write_text(json.dumps(scene) + "\n", encoding="utf-8")
    return {o["id"]: o for o in objects}


@pytest.fixture(scope="module")
def edges(toy, tmp_path_factory) -> tuple[Path, dict[str, dict]]:
    folder = tmp_path_factory.mktemp("edge-scene")
    return folder, edge_scene(folder, toy.art)


def cut_ids(rows) -> set[str]:
    return {Path(row["path"]).stem.split("-", 1)[1] for row in rows}


def test_the_drawn_faces_lie_where_the_limits_are(edges):
    _, objects = edges
    assert (objects["visible-090"]["visible"], objects["visible-089"]["visible"]) == (0.9, 0.89)
    assert (objects["short-48"]["short"], objects["short-47"]["short"]) == (48.0, 47.0)
    assert [objects[name]["angle"] for name in ("tilt-15", "tilt-75", "tilt-105", "tilt-195", "tilt-285", "tilt-345")] \
        == [15.0, 75.0, 105.0, 195.0, 285.0, 345.0]
    assert [objects[name]["angle"] for name in ("tilt-15.02", "tilt-74.98", "tilt-164.9", "tilt-344.98")] \
        == [15.02, 74.98, 164.9, 344.98]
    # Each face outside fails one limit only, so each limit is tested alone.
    for name in JUST_OUTSIDE:
        o = objects[name]
        assert [o["visible"] < 0.90, o["short"] < 48, S.quarter_turn_tilt(o["angle"]) > 15].count(True) == 1, name


def test_distance_from_a_quarter_turn():
    assert [S.quarter_turn_tilt(angle) for angle in (0, 15, 45, 75, 90, 100, 180, 269, 345, 360)] \
        == [0, 15, 45, 15, 0, 10, 0, 1, 15, 0]
    assert S.quarter_turn_tilt(-10) == 10 and S.quarter_turn_tilt(15.02) == pytest.approx(15.02)


@pytest.mark.parametrize("change, inside, outside", [
    ({}, None, None),
    ({"visible": 0.90}, True, None), ({"visible": 0.899}, False, S.NOT_VISIBLE_ENOUGH),
    ({"short": 48}, True, None), ({"short": 47.9}, False, S.TOO_SMALL),
    ({"angle": 15.0}, True, None), ({"angle": 15.01}, False, S.TOO_TILTED),
    ({"angle": 75.0}, True, None), ({"angle": 74.99}, False, S.TOO_TILTED),
    ({"angle": 345.0}, True, None), ({"angle": 344.99}, False, S.TOO_TILTED),
    ({"angle": 255.0}, True, None), ({"angle": 225.0}, False, S.TOO_TILTED),
])
def test_each_limit_is_inclusive_and_names_its_reason(change, inside, outside):
    face = {"kind": "face", "positive": True, "cardId": "T-1", "visible": 1.0, "short": 120.0, "angle": 3.0, **change}
    assert S.composite_face_exclusion(face) == outside
    assert (S.composite_face_exclusion(face) is None) == (inside is not False)


def test_composite_faces_are_cut_on_the_inside_of_each_limit(edges, tmp_path):
    folder, objects = edges
    lines: list[str] = []
    rows, record = S.composite_crops(folder, tmp_path / "cache", margin=support.MARGIN, log=lines.append)
    assert cut_ids(rows) == {*JUST_INSIDE, "unseen-in"}
    assert record["crops"] == 10 and record["selection"] == {"minVisible": 0.90, "minShortSidePx": 48, "maxTiltDegrees": 15.0}
    # What was left out is said once, by the first limit that failed.
    assert len(lines) == 1 and str({S.TOO_TILTED: 6, S.NOT_VISIBLE_ENOUGH: 1, S.TOO_SMALL: 1}) in lines[0]
    # A kept face is turned upright by quarter turns: the turn is the angle rounded to a quarter.
    by_id = {Path(row["path"]).stem.split("-", 1)[1]: row for row in rows}
    assert {name: by_id[name]["turns"] for name in JUST_INSIDE if name.startswith("tilt")} \
        == {"tilt-15": 0, "tilt-75": 1, "tilt-105": 1, "tilt-195": 2, "tilt-285": 3, "tilt-345": 0}
    assert all(row["turns"] == round(objects[name]["angle"] / 90) % 4 for name, row in by_id.items())
    # The crop of the card cut by the frame stops at the frame: its box starts at the crop's edge.
    assert by_id["visible-090"]["inner"][0] == 0 and by_id["whole"]["inner"][0] == 40


@pytest.mark.parametrize("limits, admitted", [
    # One limit moved to the far side of the face just outside it admits that face and no other.
    ({"min_visible": 0.89}, {"visible-089"}),
    ({"min_short_side": 47}, {"short-47"}),
    ({"max_tilt": 15.02}, {"tilt-15.02", "tilt-74.98", "tilt-344.98"}),
    ({"max_tilt": 15.1}, {"tilt-15.02", "tilt-74.98", "tilt-344.98", "tilt-164.9"}),
    ({"min_visible": 0, "min_short_side": 0, "max_tilt": 45}, {*JUST_OUTSIDE, "unseen-out"}),
])
def test_each_limit_is_a_setting_of_the_composite_stream(toy, edges, tmp_path, limits, admitted):
    folder, _ = edges
    built = build(toy, tmp_path, data={"composites": str(folder), "manifests": []},
                  streams={"composite_positives": limits})
    rows = built.streams["composite_positives"].rows + built.unseen.rows
    assert cut_ids(rows) == {*JUST_INSIDE, "unseen-in"} | admitted
    expected = {"minVisible": 0.90, "minShortSidePx": 48, "maxTiltDegrees": 15.0,
                **{{"min_visible": "minVisible", "min_short_side": "minShortSidePx", "max_tilt": "maxTiltDegrees"}[key]: value
                   for key, value in limits.items()}}
    assert built.inputs["composites"]["selection"] == expected


@pytest.mark.parametrize("limits, refused", [
    ({"min_visible": 0.901}, "visible-090"),
    ({"min_short_side": 48.1}, "short-48"),
    ({"max_tilt": 14.99}, "tilt-15"),
])
def test_a_limit_moved_inwards_refuses_the_face_that_sat_on_it(toy, edges, tmp_path, limits, refused):
    folder, _ = edges
    built = build(toy, tmp_path, data={"composites": str(folder), "manifests": []},
                  streams={"composite_positives": limits})
    kept = cut_ids(built.streams["composite_positives"].rows)
    assert refused not in kept and "whole" in kept
    assert {*JUST_INSIDE} - kept == ({refused} if "max_tilt" not in limits else
                                     {name for name in JUST_INSIDE if name.startswith("tilt")})


def test_the_limits_also_choose_the_unseen_validation_crops(toy, edges, tmp_path):
    folder, _ = edges
    built = build(toy, tmp_path, validation={"composites": str(folder), "groups": [support.HELD_OUT_GROUP],
                                             "unseen_cards": list(support.UNSEEN), "unseen_count": 40, "every": 1})
    assert cut_ids(built.unseen.rows) == {"unseen-in"}
    assert built.inputs["validationComposites"]["selection"]["maxTiltDegrees"] == 15.0
    wider = build(toy, tmp_path / "wider", streams={"composite_positives": {"max_tilt": 30}},
                  validation={"composites": str(folder), "groups": [support.HELD_OUT_GROUP],
                              "unseen_cards": list(support.UNSEEN), "unseen_count": 40, "every": 1})
    assert cut_ids(wider.unseen.rows) == {"unseen-in", "unseen-out"}


def test_close_up_scenes_give_no_crops_and_are_counted(edges, tmp_path):
    folder, objects = edges
    mixed = tmp_path / "mixed"
    (mixed / "images").mkdir(parents=True)
    (mixed / "images" / "00000.png").write_bytes((folder / "images" / "00000.png").read_bytes())
    table = json.loads((folder / "labels.jsonl").read_text(encoding="utf-8"))
    closeup = {**table, "index": 1, "layout": "closeup"}
    (mixed / "labels.jsonl").write_text(json.dumps(table) + "\n" + json.dumps(closeup) + "\n", encoding="utf-8")
    lines: list[str] = []
    rows, record = S.composite_crops(mixed, tmp_path / "cache", margin=support.MARGIN, log=lines.append)
    alone, _ = S.composite_crops(folder, tmp_path / "cache-alone", margin=support.MARGIN, log=lambda line: None)
    # The table scene gives exactly the crops it gives alone; the close-up gives none.
    assert sorted(Path(row["path"]).name for row in rows) == sorted(Path(row["path"]).name for row in alone)
    assert all(Path(row["path"]).name.startswith("00000-") for row in rows) and record["crops"] == 10
    named = sum(o["kind"] == "face" and o["positive"] and bool(o["cardId"]) for o in objects.values())
    assert f"'{S.IN_A_CLOSEUP}': {named}" in lines[0]


def test_composite_crops_are_cut_again_when_a_limit_changes(edges, tmp_path):
    folder, _ = edges
    lines: list[str] = []
    cut = lambda **limits: S.composite_crops(folder, tmp_path, margin=support.MARGIN, log=lines.append, **limits)[0]  # noqa: E731
    first = cut()
    assert cut() == first and "read back" in lines[-1]
    assert len(cut(min_short_side=47)) == len(first) + 1 and "read back" not in lines[-1]
    assert cut() == first and "read back" not in lines[-1]


def test_crops_are_cut_once_and_cut_again_when_an_input_changes(toy, tmp_path):
    lines: list[str] = []
    build(toy, tmp_path, lines.append)
    assert sum("cut" in line for line in lines) == 3 and not any("read back" in line for line in lines)
    lines.clear()
    again = build(toy, tmp_path, lines.append)
    assert sum("read back" in line for line in lines) == 3
    lines.clear()
    wider = build(toy, tmp_path, lines.append, data={"margin": 0.2})
    assert sum("cut" in line and "read back" not in line for line in lines) == 3
    a, b = again.streams["real_positives"].rows[0], wider.streams["real_positives"].rows[0]
    assert a["path"] == b["path"] and a["hw"][0] > b["hw"][0]


def test_recording_groups_are_held_out_by_name_or_by_a_seeded_share(toy, tmp_path):
    named = build(toy, tmp_path, validation={"groups": ["g-toy-01", "g-toy-02"]})
    assert named.held_out_groups == ["g-toy-01", "g-toy-02"]
    assert {row["group"] for row in named.streams["real_positives"].rows} == {"g-toy-03", "g-toy-04"}
    shared = [build(toy, tmp_path, validation={"groups": [], "group_share": 0.5}, data_seed=seed) for seed in (1, 1, 2, 3, 4)]
    picks = [tuple(s.held_out_groups) for s in shared]
    assert all(len(pick) == 2 for pick in picks) and picks[0] == picks[1] and len(set(picks)) > 1
    for s in shared:
        assert {row["group"] for row in s.seen.rows} == set(s.held_out_groups)
        assert not set(s.held_out_groups) & {row["group"] for row in s.streams["real_positives"].rows}
    nobody = build(toy, tmp_path, validation={"groups": [], "group_share": 0.0})
    assert nobody.held_out_groups == [] and nobody.seen.rows == []


def test_the_cards_kept_out_are_named_or_picked_by_the_data_seed(toy, tmp_path):
    picked = [build(toy, tmp_path, validation={"unseen_cards": [], "unseen_pick": 4}, data_seed=seed) for seed in (1, 1, 2)]
    assert len(picked[0].unseen_ids) == 4 and picked[0].unseen_ids == picked[1].unseen_ids != picked[2].unseen_ids
    for s in picked:
        kept_out = set(s.unseen_ids)
        assert all(not kept_out & {row["card_id"] for row in stream.rows} for stream in s.streams.values())
        assert {row["card_id"] for row in s.unseen.rows} <= kept_out
    with pytest.raises(ConfigError, match="not in the catalog"):
        build(toy, tmp_path, validation={"unseen_cards": ["NOT-A-CARD"]})
    without = build(toy, tmp_path, validation={"unseen_cards": []})
    assert without.unseen_ids == [] and without.unseen.rows == []


# ------------------------------------------------------------------------------- plug-ins
def extra_streams(context: S.SourceContext) -> dict:
    """A plug-in: two streams of its own and more rows for a built-in one."""
    assert "TOY-005" in context.unseen and "TOY-001" in context.art_ids and context.seed == 3
    folder = context.out_dir / "plugin-files"
    folder.mkdir(parents=True, exist_ok=True)
    Image.fromarray(PLUGIN_IMAGE).save(folder / "on-disk.png")
    return {
        "my_crops": {"root": str(folder), "rows": [
            {"path": "on-disk.png", "inner": [20.5, 28.0, 60.0, 84.0], "card_id": "TOY-001", "group": "mine-1"},
            {"image": PLUGIN_IMAGE, "inner": [20, 28, 60, 84], "card_id": "TOY-002", "group": "mine-1"},
            {"image": PLUGIN_IMAGE, "inner": [20, 28, 60, 84], "card_id": "TOY-005", "group": "mine-2"},   # kept out
            {"image": PLUGIN_IMAGE, "inner": [20, 28, 60, 84], "card_id": "NOT-A-CARD", "group": "mine-2"},
        ]},
        "my_negatives": [{"image": PLUGIN_IMAGE, "inner": [20, 28, 60, 84], "label": "back"},
                         {"image": PLUGIN_IMAGE, "inner": [20, 28, 60, 84], "card_id": "TOY-003", "label": "table"}],
        "real_positives": [{"image": PLUGIN_IMAGE, "inner": [20, 28, 60, 84], "card_id": "TOY-004", "group": "mine-3"}],
    }


def more_of_the_same(context):
    return {"my_crops": []}


def not_a_dictionary(context):
    return [1, 2, 3]


def bad_rows(context):
    return {"my_crops": [{"image": PLUGIN_IMAGE}]}


def validation_sets(context: S.SourceContext) -> dict:
    row = {"image": PLUGIN_IMAGE, "inner": [20, 28, 60, 84], "card_id": "TOY-001", "group": "mine-9"}
    return {"seen": {"rows": [row, row], "bank": ["TOY-001", "TOY-002"]},
            "unseen": {"rows": [{**row, "card_id": "TOY-005"}], "root": None}}


PLUGIN_STREAMS = {"my_crops": {"chain": "physical"}, "my_negatives": {"negative": True}}
HERE = "test_train_recognizer_sources"


def test_a_plug_in_adds_streams_in_the_row_format(toy, tmp_path):
    lines: list[str] = []
    s = build(toy, tmp_path, lines.append, data={"extra_sources": [f"{HERE}:extra_streams"]}, streams=PLUGIN_STREAMS)
    mine = s.streams["my_crops"]
    assert mine.chain == "physical" and not mine.negative and mine.root == str(tmp_path / "plugin-files")
    assert [row["card_id"] for row in mine.rows] == ["TOY-001", "TOY-002"]         # the kept-out and the unknown card are dropped
    assert any("my_crops: 2 rows dropped" in note for note in s.notes) and any("plug-in stream my_crops: 4 rows" in line for line in lines)
    assert np.array_equal(S.load_image(mine.rows[0], mine.root), PLUGIN_IMAGE)
    negatives = s.streams["my_negatives"]
    assert negatives.negative and [row["card_id"] for row in negatives.rows] == [None, None]
    assert [row["label"] for row in negatives.rows] == ["back", "table"]
    # Rows given under a built-in name join that stream.
    assert s.streams["real_positives"].rows[-1]["group"] == "mine-3"
    assert len(s.streams["real_positives"].rows) == len(build(toy, tmp_path).streams["real_positives"].rows) + 1
    assert s.inputs["extra"]["my_crops"]["rows"] == 4 and len(s.inputs["extra"]["my_crops"]["sha256"]) == 64


@pytest.mark.parametrize("spec, streams, message", [
    (f"{HERE}:extra_streams", {}, r"no \[streams.my_crops\] table"),
    (f"{HERE}:not_a_dictionary", PLUGIN_STREAMS, "must return a dictionary"),
    (f"{HERE}:bad_rows", PLUGIN_STREAMS, 'needs "inner"'),
    (f"{HERE}:no_such_function", PLUGIN_STREAMS, "has no attribute"),
    ("no_such_module_anywhere:load", PLUGIN_STREAMS, "cannot import"),
])
def test_a_plug_in_that_is_wrong_is_refused(toy, tmp_path, spec, streams, message):
    with pytest.raises(ConfigError, match=message):
        build(toy, tmp_path, data={"extra_sources": [spec]}, streams=streams)


def test_two_plug_ins_may_not_give_the_same_stream(toy, tmp_path):
    with pytest.raises(ConfigError, match="already given by another plug-in"):
        build(toy, tmp_path, data={"extra_sources": [f"{HERE}:extra_streams", f"{HERE}:more_of_the_same"]}, streams=PLUGIN_STREAMS)


def test_a_plug_in_may_replace_both_validation_sets(toy, tmp_path):
    s = build(toy, tmp_path, validation={"source": f"{HERE}:validation_sets"})
    assert len(s.seen.rows) == 2 and s.seen.bank == ["TOY-001", "TOY-002"]
    assert [row["card_id"] for row in s.unseen.rows] == ["TOY-005"] and s.unseen.bank is None
    assert s.inputs["validationPlugin"]["seen"]["rows"] == 2
    # The training streams are still held out as the config says.
    assert s.held_out_groups == [support.HELD_OUT_GROUP]
