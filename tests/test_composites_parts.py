# SPDX-License-Identifier: Apache-2.0
"""The parts of the scene generator on their own: geometry, card finishing, the board layout,
the photometric effects, broadcast frames, textures, scans and the kinds settings."""

from __future__ import annotations

import json

import numpy as np
import pytest
from PIL import Image

from cardvision.composites import board, broadcast, photometric, surfaces, textures
from cardvision.composites.cards import KindSettings, load_kinds
from cardvision.composites.finish import Canvas, add_foil, add_sleeve, rounded_rgba
from cardvision.composites.geometry import (
    CARD_ASPECT,
    apply_h,
    card_aspect,
    image_angle,
    local_scale,
    parse_card_size,
    poly_area,
    scene_homography,
    unit_to_table,
)
from cardvision.composites.scene import label_objects, layout_table
from helpers import digest

UNIT_SQUARE = [(0, 0), (1, 0), (1, 1), (0, 1)]


def rng(seed=0):
    return np.random.default_rng(seed)


def place(canvas, card, center, width, theta, obj_id, camera=None, **paste):
    """Draw ``card`` on the table as the scene builder does and return its unfinished label."""
    H, W = canvas.ids.shape
    camera = camera if camera is not None else scene_homography(W, H, 0, 0, W)
    to_table = unit_to_table(np.subtract(center, (W / 2, H / 2)), width, width * card.height / card.width, theta)
    to_image = camera @ to_table
    to_image /= to_image[2, 2]
    corners = apply_h(to_image, UNIT_SQUARE)
    canvas.paste_warped(rng(obj_id), card, to_image @ np.diag([1 / card.width, 1 / card.height, 1.0]), obj_id, **paste)
    return {"id": obj_id, "kind": "face", "cardId": "TOY-001", "corners": corners.round(2).tolist(),
            "area": float(poly_area(corners))}


def white_card(width=120, height=168):
    return Image.new("RGBA", (width, height), (255, 255, 255, 255))


def drawn_box(mask):
    ys, xs = np.nonzero(mask)
    return [xs.min(), ys.min(), xs.max() + 1, ys.max() + 1]


# -------------------------------------------------------------------- a card drawn on its own
@pytest.mark.parametrize(("theta", "tilt"), [(0, 0), (33, 0), (90, 0), (200, 25), (-70, 35)])
def test_a_card_drawn_alone_is_where_its_label_says(theta, tilt):
    W, H = 640, 360
    canvas = Canvas(np.zeros((H, W, 3), np.float32))
    camera = scene_homography(W, H, tilt, 40, 700)
    obj = place(canvas, white_card(), (300, 170), 90, theta, 1, camera, shadow=False, feather=0.0)
    [label] = label_objects([obj], canvas.ids, W, H)
    lit = canvas.img.sum(axis=2) > 1.5
    assert np.abs(np.subtract(label["box"], drawn_box(lit))).max() <= 1.5  # the box hugs the white pixels
    assert np.abs(np.subtract(label["box"], drawn_box(canvas.ids == 1))).max() <= 1.5
    x0, y0, x1, y1 = (int(v) for v in np.floor(label["box"]))
    outside = lit.copy()
    outside[max(0, y0 - 1):y1 + 2, max(0, x0 - 1):x1 + 2] = False
    assert not outside.any()  # and nothing was drawn beyond it
    assert label["visible"] >= 0.97 and label["positive"] is True and label["ignore"] is None
    assert abs(lit.sum() - poly_area(np.asarray(label["corners"]))) <= 0.03 * lit.sum()  # the quad is the card
    # (the box is rounded to a tenth of a pixel; the normalized copy is not)
    assert label["cx"] == pytest.approx((label["box"][0] + label["box"][2]) / 2 / W, abs=2e-4)
    assert label["h"] == pytest.approx((label["box"][3] - label["box"][1]) / H, abs=3e-4)
    if tilt == 0:
        assert label["short"] == pytest.approx(90, abs=0.2)
        assert image_angle(np.asarray(label["corners"])) == pytest.approx(theta % 360, abs=0.1)


def test_a_card_cut_by_the_frame_edge_keeps_its_corners_and_loses_visibility():
    W, H = 640, 360
    canvas = Canvas(np.zeros((H, W, 3), np.float32))
    obj = place(canvas, white_card(), (20, 180), 90, 0, 1, shadow=False, feather=0.0)
    [label] = label_objects([obj], canvas.ids, W, H)
    corners = np.asarray(label["corners"])
    assert corners[:, 0].min() == pytest.approx(-25, abs=0.1)  # the quad is not cut
    assert label["box"][0] == 0.0 and label["box"][2] == pytest.approx(65, abs=0.2)  # the box is
    assert label["visible"] == pytest.approx(65 / 90, abs=0.02) and label["positive"] is True
    # Mostly outside: still labeled, but not a positive. Wholly outside: no label at all.
    canvas = Canvas(np.zeros((H, W, 3), np.float32))
    mostly_out = place(canvas, white_card(), (-10, 180), 90, 0, 1, shadow=False, feather=0.0)
    gone = place(canvas, white_card(), (-200, 180), 90, 0, 2, shadow=False, feather=0.0)
    [label] = label_objects([mostly_out, gone], canvas.ids, W, H)
    assert label["id"] == 1 and label["ignore"] == "lowvis" and label["positive"] is False


def test_a_covered_card_and_a_tiny_card_are_ignored_not_positive():
    W, H = 640, 360
    canvas = Canvas(np.zeros((H, W, 3), np.float32))
    under = place(canvas, white_card(), (300, 180), 90, 0, 1, shadow=False, feather=0.0)
    over = place(canvas, white_card(), (330, 180), 90, 0, 2, shadow=False, feather=0.0)
    tiny = place(canvas, white_card(), (80, 80), 14, 0, 3, shadow=False, feather=0.0)
    hidden = place(canvas, white_card(), (500, 180), 60, 0, 4, shadow=False, feather=0.0)
    lid = place(canvas, white_card(), (500, 180), 90, 0, 5, shadow=False, feather=0.0)
    lid["kind"] = "back"
    labels = {o["id"]: o for o in label_objects([under, over, tiny, hidden, lid], canvas.ids, W, H)}
    assert labels[1]["visible"] == pytest.approx(1 / 3, abs=0.03) and labels[1]["ignore"] == "lowvis"
    assert labels[2]["visible"] >= 0.97 and labels[2]["positive"] is True
    assert labels[3]["ignore"] == "small" and labels[3]["positive"] is False and labels[3]["short"] < 20
    assert 4 not in labels  # nothing of it shows
    assert labels[5]["positive"] is False and labels[5]["ignore"] is None  # a back is never a positive


def test_a_window_cuts_the_box_of_an_object_inside_it():
    canvas = Canvas(np.zeros((360, 640, 3), np.float32))
    obj = place(canvas, white_card(), (300, 180), 90, 0, 1, shadow=False, feather=0.0)
    obj["clipRect"] = [0.0, 0.0, 310.0, 150.0]
    [label] = label_objects([obj], canvas.ids, 640, 360)
    assert label["box"] == [255.0, 117.0, 310.0, 150.0] and "clipRect" not in label and "area" not in label


def test_shadow_and_feather_soften_the_edge_without_moving_the_label():
    canvas = Canvas(np.full((360, 640, 3), 0.5, np.float32))
    obj = place(canvas, white_card(), (300, 180), 90, 20, 1)
    [label] = label_objects([obj], canvas.ids, 640, 360)
    assert np.abs(np.subtract(label["box"], drawn_box(canvas.ids == 1))).max() <= 1.5
    assert (canvas.img < 0.49).any()  # a shadow fell on the table


# ------------------------------------------------------------------------------------ geometry
def test_the_camera_keeps_scale_one_at_the_center_and_tilts_about_its_axis():
    flat = scene_homography(1920, 1080, 0, 123, 2000)
    assert apply_h(flat, [(0, 0), (100, -50)]).tolist() == [[960, 540], [1060, 490]]
    tilted = scene_homography(1920, 1080, 30, 0, 2000)
    assert apply_h(tilted, [(0, 0)]).tolist() == [[960, 540]]
    assert local_scale(tilted, (0, 0)) == pytest.approx(np.sqrt(np.cos(np.radians(30))), abs=1e-3)
    assert local_scale(tilted, (0, 300)) != pytest.approx(local_scale(tilted, (0, -300)), abs=1e-3)  # perspective


def test_the_unit_square_maps_to_a_turned_rectangle_with_its_top_edge_first():
    corners = apply_h(unit_to_table((10, 20), 60, 84, 0), UNIT_SQUARE)
    assert corners.tolist() == [[-20, -22], [40, -22], [40, 62], [-20, 62]]
    turned = apply_h(unit_to_table((0, 0), 60, 84, 90), UNIT_SQUARE)
    assert np.allclose(turned, [[42, -30], [42, 30], [-42, 30], [-42, -30]])
    assert image_angle(turned) == pytest.approx(90) and poly_area(turned) == pytest.approx(60 * 84)


# ----------------------------------------------------------------------------- card finishing
def test_generated_backs_are_sleeve_like_and_differ_by_seed():
    backs = [textures.generated_back(rng(seed)) for seed in range(12)]
    assert all(back.mode == "RGBA" and back.size == (320, 447) for back in backs)
    assert len({digest(np.asarray(back)) for back in backs}) == 12
    assert digest(np.asarray(textures.generated_back(rng(3)))) == digest(np.asarray(backs[3]))
    for back in backs:
        alpha = np.asarray(back.getchannel("A"))
        assert alpha[0, 0] < 40 and alpha[223, 160] == 255  # rounded corners, solid middle
    colors = np.array([np.asarray(back)[40, 40, :3] for back in backs], float)
    assert np.ptp(colors, axis=0).min() > 60  # the sleeve color is random
    # A plain color with a pattern: most of the back is close to its typical color.
    for back in backs:
        rgb = np.asarray(back)[..., :3].reshape(-1, 3).astype(float)
        assert (np.abs(rgb - np.median(rgb, axis=0)).max(axis=1) < 90).mean() > 0.5


def test_a_sleeve_adds_a_border_and_foil_brightens_without_resizing():
    card = rounded_rgba(Image.new("RGB", (100, 140), (40, 90, 160)), 0.045)
    assert card.mode == "RGBA" and np.asarray(card.getchannel("A"))[0, 0] < 40
    kinds = set()
    for seed in range(12):
        sleeved, kind = add_sleeve(rng(seed), card, 4)
        kinds.add(kind)
        assert sleeved.size == (108, 148)
        assert np.asarray(sleeved)[74, 54, :3].tolist() == [40, 90, 160]  # the card shows through
    assert kinds == {"clear", "opaque"}
    foiled = add_foil(rng(1), card)
    assert foiled.size == card.size and not np.array_equal(np.asarray(foiled), np.asarray(card))
    assert np.array_equal(np.asarray(foiled.getchannel("A")), np.asarray(card.getchannel("A")))


# ---------------------------------------------------------------------------------- the board
def test_a_board_has_every_role_and_draws_each_from_its_group():
    groups = {"leader": "leader", "leader-unit": "unit", "unit": "unit", "site-unit": "unit",
              "attachment": "attachment", "resource": "resource", "site": "site",
              "deck-pile": None, "discard-pile": None, "hand-fan": None}
    seen = set()
    for seed in range(40):
        slots, info = board.layout_board(rng(seed), 60.0)
        assert info["cards"] == len(slots) and info["sites"] in (2, 3)
        assert sum(slot["role"] == "site" for slot in slots) == info["sites"]
        assert [slot["role"] for slot in slots[:info["sites"]]] == ["site"] * info["sites"]  # drawn first
        for slot in slots:
            seen.add(slot["role"])
            assert slot["draw"] == groups[slot["role"]] and slot["draw"] in (*board.DRAW_GROUPS, None)
            assert slot["back"] == (slot["role"] == "deck-pile")
            assert slot.get("diceSlot", False) == (slot["role"] == "leader")
            assert slot["q"].shape == (2,) and np.isfinite(slot["q"]).all()
        sides = {slot.get("side") for slot in slots if slot["role"] == "leader"}
        assert sides == ({"near", "far"} if info["opponent"] else {"near"})
    assert seen == set(groups)


def test_the_far_half_of_a_board_faces_the_other_way():
    slots, info = next(result for result in (board.layout_board(rng(seed), 60.0) for seed in range(20))
                       if result[1]["opponent"])
    near = [slot for slot in slots if slot["role"] == "leader" and slot["side"] == "near"][0]
    far = [slot for slot in slots if slot["role"] == "leader" and slot["side"] == "far"][0]
    assert near["q"][1] > 0 > far["q"][1] and near["q"][0] < 0 < far["q"][0]
    assert abs(near["theta"]) < 15 and abs(far["theta"] - 180) < 15


def test_the_table_layout_keeps_to_the_card_count_and_marks_piles_face_down():
    roles = set()
    for seed in range(30):
        slots, width = layout_table(rng(seed), 12, 60.0)
        assert width == 60.0 and len(slots) <= 12
        roles |= {slot["role"] for slot in slots}
        assert all(slot.get("back", False) == (slot["role"] == "pile") for slot in slots)
    assert roles == {"slot", "stack", "fan", "pile"}


# ------------------------------------------------------------------------- photometric effects
def card_picture(seed=0):
    pixels = (rng(100 + seed).random((140, 100, 3)) * 255).astype(np.uint8)
    return rounded_rgba(Image.fromarray(pixels), 0.045)


def test_the_default_setting_holds_the_documented_fractions():
    assert photometric.DEFAULT == {"p_cast": 0.6, "p_contrast": 0.6, "p_dice_art": 0.5, "p_streak_sleeved": 0.6,
                                   "p_streak_bare": 0.15, "p_defocus": 0.25, "foil_default": 0.15,
                                   "strength": 1.0, "name": "default", "foil": {}}
    stronger = photometric.setting(2.3, foil={"unit": 0.4})
    assert stronger["name"] == "strength-2.3" and stronger["p_cast"] == 0.6
    assert photometric.foil_probability("unit", stronger) == 0.4
    assert photometric.foil_probability("spell", stronger) == photometric.foil_probability(None, stronger) == 0.15


def test_strength_zero_leaves_colors_alone_and_more_strength_changes_more():
    card = card_picture()
    still, log = photometric.print_effects(rng(1), card, photometric.setting(0.0))
    assert np.abs(np.asarray(still).astype(int) - np.asarray(card).astype(int)).max() <= 1 and "cast" in log
    changes = []
    for strength in (0.5, 1.0, 2.0):
        out, _ = photometric.print_effects(rng(1), card, photometric.setting(strength))
        assert np.array_equal(np.asarray(out.getchannel("A")), np.asarray(card.getchannel("A")))
        changes.append(np.abs(np.asarray(out).astype(float) - np.asarray(card)).mean())
    assert changes[0] < changes[1] < changes[2]


def test_a_die_is_painted_only_on_a_card_that_carries_dice():
    setting = photometric.setting(1.0)
    logs = [photometric.print_effects(rng(seed), card_picture(), setting, dice=True, die_fn=textures.die_patch)[1]
            for seed in range(40)]
    share = sum("dice" in log for log in logs) / len(logs)
    assert 0.3 < share < 0.7 and {log["dice"] for log in logs if "dice" in log} <= {"d6", "d20", "token"}
    for seed in range(40):
        assert "dice" not in photometric.print_effects(rng(seed), card_picture(), setting, die_fn=textures.die_patch)[1]
        assert "dice" not in photometric.print_effects(rng(seed), card_picture(), setting, dice=True)[1]


def test_streaks_only_add_light_and_are_commoner_on_sleeves():
    setting = photometric.setting(1.0)
    counts = {}
    for sleeved in (True, False):
        results = [photometric.streaks(rng(seed), card_picture(), sleeved, setting) for seed in range(60)]
        counts[sleeved] = sum(bands is not None for _, bands in results)
        for out, bands in results:
            assert bands in (None, 1, 2, 3)
            if bands:
                assert (np.asarray(out)[..., :3].astype(int) >= np.asarray(card_picture())[..., :3]).all()
    assert counts[True] > counts[False] * 2


def test_defocus_and_exposure_scale_with_strength():
    sigmas = [photometric.defocus_sigma(rng(seed), photometric.setting(1.0)) for seed in range(80)]
    blurred = [sigma for sigma in sigmas if sigma]
    assert 0.1 < len(blurred) / 80 < 0.4 and all(0.5 <= sigma <= 1.4 for sigma in blurred)
    picture = np.full((4, 4, 3), 0.5, np.float32)
    same, log = photometric.exposure(rng(0), picture.copy(), photometric.setting(0.0))
    assert np.array_equal(same, picture) and log == {"gain": 1.0, "wb": [1.0, 1.0, 1.0]}
    out, log = photometric.exposure(rng(0), picture.copy(), photometric.setting(1.0))
    assert 2 ** -0.35 <= log["gain"] <= 2 ** 0.35 and not np.array_equal(out, picture)


# ------------------------------------------------------------------------------- broadcast frames
def table_scene(seed=0, W=480, H=270):
    picture = rng(seed).random((H, W, 3), dtype=np.float32)
    ids = np.zeros((H, W), np.int16)
    ids[100:180, 200:260] = 1
    obj = {"id": 1, "kind": "face", "cardId": "TOY-001", "source": "art", "area": 60.0 * 80.0,
           "corners": [[200.0, 100.0], [260.0, 100.0], [260.0, 180.0], [200.0, 180.0]],
           "H": [[60.0, 0.0, 200.0], [0.0, 80.0, 100.0], [0.0, 0.0, 1.0]]}
    return picture, ids, [obj]


def featured(grng):
    return Image.new("RGB", (300, 419), (200, 180, 40)), "TOY-002"


def test_a_broadcast_frame_moves_the_table_and_labels_what_it_adds():
    seen = set()
    for seed in range(30):
        picture, ids, objects = table_scene(seed)
        out, out_ids, objects, info = broadcast.compose(rng(seed), picture, ids, objects, 480, 270, inset_fn=featured)
        seen.add(info["variant"])
        assert out.shape == (270, 480, 3) and out.dtype == np.float32 and 0 <= out.min() and out.max() <= 1
        assert out_ids.shape == (270, 480)
        x0, y0, x1, y1 = info["tableWindow"]
        scale = info["tableScale"]
        assert abs((x1 - x0) - 480 * scale) <= 1 and abs((y1 - y0) - 270 * scale) <= 1
        card = objects[0]
        assert card["clipRect"] == [x0, y0, x1, y1]
        assert np.allclose(card["corners"][0], [200 * (x1 - x0) / 480 + x0, 100 * (y1 - y0) / 270 + y0], atol=0.01)
        assert card["area"] == pytest.approx(4800 * scale * scale, rel=0.02)
        assert np.allclose(apply_h(np.asarray(card["H"]), UNIT_SQUARE), card["corners"], atol=0.01)
        graphics = [o for o in objects if o["kind"] == "overlay"]
        assert [o["source"] for o in graphics] == info["graphics"]
        assert all(o["tags"] == ["overlay"] and o["cardId"] is None for o in graphics)
        if info["variant"] == "bars":
            assert scale == 1.0 and "window-frame" not in info["graphics"]
        else:
            assert "window-frame" in info["graphics"]
            assert (0.22 <= scale <= 0.45) if info["variant"] == "pip" else (0.55 <= scale <= 0.75)
        insets = [o for o in objects if o.get("role") == "inset"]
        assert info["inset"] == bool(insets) and (info["variant"] != "pip" or not insets)
        for inset in insets:
            assert inset["kind"] == "face" and inset["cardId"] == "TOY-002" and inset["tags"] == ["inset", "overlay"]
            ix0, iy0 = (int(v) for v in inset["corners"][0])
            assert out_ids[iy0 + 20, ix0 + 20] == inset["id"]
        labels = label_objects(objects, out_ids, 480, 270)
        assert all(0 <= o["box"][0] < o["box"][2] <= 480 and 0 <= o["box"][1] < o["box"][3] <= 270 for o in labels)
    assert seen == {"panels", "pip", "bars"}


def test_no_featured_card_without_a_source_of_cards_or_in_a_card_free_frame():
    for seed in range(20):
        for extra in ({}, {"inset_fn": featured, "probe": True}):
            picture, ids, objects = table_scene(seed)
            _, _, objects, info = broadcast.compose(rng(seed), picture, ids, objects, 480, 270, **extra)
            assert info["inset"] is False and not any(o.get("role") == "inset" for o in objects)


def test_a_preset_fixes_the_arrangement_and_the_window_scale():
    for seed in range(12):
        grng = rng(seed)
        preset = broadcast.predraw(grng)
        assert preset["variant"] in ("panels", "pip", "bars")
        picture, ids, objects = table_scene(seed)
        _, _, _, info = broadcast.compose(grng, picture, ids, objects, 480, 270, preset=preset)
        assert info["variant"] == preset["variant"] and info["tableScale"] == round(preset["s"], 3)


def test_the_webcam_picture_is_drawn_not_photographed():
    picture = broadcast.person(rng(4), 320, 180)
    assert picture.mode == "RGB" and picture.size == (320, 180)
    assert digest(np.asarray(picture)) == digest(np.asarray(broadcast.person(rng(4), 320, 180)))
    assert digest(np.asarray(picture)) != digest(np.asarray(broadcast.person(rng(5), 320, 180)))


# ------------------------------------------------------------------------- textures and scans
@pytest.mark.parametrize("family", sorted(textures.BG_FAMILIES))
def test_every_background_family_fills_the_frame_and_repeats(family):
    picture, name = textures.make_background(rng(2), 192, 108, family)
    assert name == family and picture.shape == (108, 192, 3) and picture.dtype.kind == "f"
    assert 0 <= picture.min() and picture.max() <= 1 and picture.std() > 0
    assert digest(picture) == digest(textures.make_background(rng(2), 192, 108, family)[0])


def test_backgrounds_are_drawn_in_their_stated_shares():
    assert sum(textures.BG_WEIGHTS.values()) == pytest.approx(1.0) and set(textures.BG_WEIGHTS) == set(textures.BG_FAMILIES)
    names = [textures.make_background(rng(seed), 64, 36)[1] for seed in range(200)]
    assert set(names) == set(textures.BG_FAMILIES) and 30 < names.count("playmat") < 85


def test_distractors_dice_and_hands_are_rgba_patches():
    subs = set()
    for seed in range(40):
        patch, sub = textures.distractor_patch(rng(seed), 64)
        subs.add(sub.split("+")[0].split("-")[0])
        assert patch.mode == "RGBA" and min(patch.size) >= 16
    assert subs == {"texture", "photo", "text"}
    names = set()
    for seed in range(40):
        die, name = textures.die_patch(rng(seed), 48)
        names.add(name)
        assert die.mode == "RGBA" and die.size == (48, 48) and np.asarray(die.getchannel("A")).max() == 255
    assert names == {"d6", "d20", "token"}
    hand = textures.hand_patch(rng(1), 100.0)
    alpha = np.asarray(hand.getchannel("A"))
    assert hand.size == (130, 220) and alpha[-1].max() == 255 and alpha[0].max() == 0  # the arm leaves by the bottom


def test_the_surface_rule_keeps_tables_and_drops_walls_and_ground():
    yes = [("fabric", "cotton_jersey"), ("wood", "oak_veneer_01"), ("wood", "wood_table_001"),
           ("concrete", "concrete_floor_02"), ("concrete", "brushed_concrete_03")]
    no = [("fabric", "dirty_carpet"), ("wood", "bark_brown_02"), ("wood", "bamboo_wall"), ("concrete", "concrete_wall_004"),
          ("plaster", "painted_plaster_wall"), ("floor", "cobblestone_floor_08"), ("marble", "marble_01"), (None, "oak")]
    assert all(surfaces.is_surface(category, asset) for category, asset in yes)
    assert not any(surfaces.is_surface(category, asset) for category, asset in no)
    assert sum(surfaces.SURFACE_FAMILIES.values()) == pytest.approx(1.0)
    assert set(surfaces.SURFACE_FAMILIES) <= set(textures.BG_FAMILIES)


def test_a_scan_covers_the_frame_and_a_tilted_table_is_covered_too(tmp_path):
    y, x = np.mgrid[0:48, 0:64]
    (tmp_path / "train").mkdir()
    Image.fromarray(np.stack([x * 4, y * 5, x + y], -1).astype(np.uint8)).save(tmp_path / "train/toy__cloth.jpg")
    records = [{"file": "train/toy__cloth.jpg", "source": "toy", "assetId": "cloth", "split": "train"}]
    (tmp_path / "index.json").write_text(json.dumps(records))
    assert surfaces.load_texture_index(tmp_path) == records
    picture, record = surfaces.texture_background(rng(0), records, tmp_path, 320, 180)
    assert record is records[0] and picture.shape == (180, 320, 3) and picture.dtype.kind == "f"
    assert 0 <= picture.min() and picture.max() <= 1 and (picture.reshape(-1, 3).max(axis=1) > 0).all()
    inverse = np.linalg.inv(scene_homography(320, 180, 35, 60, 300))
    warped = surfaces.warp_to_table(picture, 320, 180, inverse)
    assert warped.shape == picture.shape and (warped.reshape(-1, 3).max(axis=1) > 0).mean() > 0.99
    family_names = {surfaces.surface_background(rng(seed), [], None, 64, 36)[1] for seed in range(40)}
    assert family_names == set(surfaces.SURFACE_FAMILIES)
    scanned = [surfaces.surface_background(rng(seed), records, tmp_path, 64, 36) for seed in range(20)]
    assert {name for _, name, _ in scanned} > {"texture-surface"}
    assert all((source is records[0]) == (name == "texture-surface") for _, name, source in scanned)


@pytest.mark.parametrize("bad", [
    {"oops": 1},
    [{"file": "a.jpg", "source": "toy", "assetId": "a"}],
    [{"file": "../a.jpg", "source": "toy", "assetId": "a", "split": "train"}],
    [{"file": "/tmp/a.jpg", "source": "toy", "assetId": "a", "split": "train"}],
])
def test_a_texture_index_that_points_outside_its_folder_is_refused(tmp_path, bad):
    (tmp_path / "index.json").write_text(json.dumps(bad))
    with pytest.raises(ValueError):
        surfaces.load_texture_index(tmp_path)


def test_a_folder_without_an_index_says_how_to_make_one(tmp_path):
    with pytest.raises(FileNotFoundError, match="fetch-textures"):
        surfaces.load_texture_index(tmp_path)


# ------------------------------------------------------------------------------ kinds settings
def test_kind_settings_are_read_from_a_kinds_object():
    kinds = KindSettings.from_kinds({"landscape": ["site"], "foilProbability": {"unit": 0.25}, "dice": ["hero"],
                                     "board": {"leader": "hero", "resource": ["token", "land"]},
                                     "boost": {"shareKind": "site", "share": 0.1}})
    assert kinds.landscape == ("site",) and kinds.foil == {"unit": 0.25} and kinds.dice == ("hero",)
    assert kinds.board == {"leader": ("hero",), "resource": ("token", "land")}
    assert KindSettings.from_kinds(kinds.to_json()) == kinds
    assert KindSettings.from_kinds(None) == KindSettings.from_kinds({}) == KindSettings()


@pytest.mark.parametrize("bad", [
    {"landscape": "site"},
    {"foilProbability": {"unit": 1.5}},
    {"foilProbability": {"unit": True}},
    {"dice": "hero"},
    {"dice": [""]},
    {"board": ["hero"]},
    {"board": {"hero": "hero"}},
    {"board": {"leader": []}},
    {"board": {"leader": 3}},
    ["site"],
])
def test_a_malformed_kinds_object_is_refused(bad):
    with pytest.raises(ValueError, match="kinds"):
        KindSettings.from_kinds(bad)


def test_a_kinds_file_may_hold_the_object_bare_or_under_its_key(tmp_path):
    kinds = {"landscape": ["site"], "dice": ["hero"]}
    (tmp_path / "bare.json").write_text(json.dumps(kinds))
    (tmp_path / "keyed.json").write_text(json.dumps({"kinds": kinds}))
    assert load_kinds(tmp_path / "bare.json") == load_kinds(tmp_path / "keyed.json") == kinds
    (tmp_path / "bad.json").write_text(json.dumps({"kinds": {"dice": "hero"}}))
    with pytest.raises(ValueError, match="kinds.dice"):
        load_kinds(tmp_path / "bad.json")


def test_the_card_aspect_is_that_of_a_standard_card():
    assert CARD_ASPECT == pytest.approx(63 / 88, abs=0.001)


# -------------------------------------------------------------------------------- card size
def test_a_card_size_gives_its_aspect_and_the_default_size_gives_the_constant():
    # 63 / 88 is 0.71590..., which earlier runs wrote as 0.716: rounding to three decimals keeps it
    assert card_aspect(*parse_card_size("63x88")) == CARD_ASPECT == 0.716
    assert card_aspect(*parse_card_size("59x86")) == 0.686
    assert parse_card_size(" 59.5X86.25 ") == (59.5, 86.25)


@pytest.mark.parametrize("text", ["59", "59x", "x86", "59x86x2", "59 by 86", "abc", "", "0x86", "-59x86", "59x0",
                                  "nanx86", "infx86", "88x63", "40x100", "100x99"])
def test_a_card_size_that_is_not_a_card_is_refused(text):
    with pytest.raises(ValueError, match="card size"):
        card_aspect(*parse_card_size(text))


class _NoJitter:
    """A random generator whose normal draws are zero, so that a layout is its plain geometry."""

    def __init__(self, seed):
        self._rng = rng(seed)

    def normal(self, loc=0.0, scale=1.0, size=None):
        return np.zeros(size) + loc if size is not None else float(loc)

    def __getattr__(self, name):
        return getattr(self._rng, name)


def test_the_layouts_follow_the_card_aspect_with_the_same_draws():
    ratio = CARD_ASPECT / 0.686  # how much taller a 59 x 86 card is, at the same width
    for seed in range(20):
        # the same draws: the generator ends in the same state whatever the aspect
        states = []
        for aspect in (CARD_ASPECT, 0.686):
            generator = rng(seed)
            board.layout_board(generator, 60.0, aspect)
            layout_table(generator, 12, 60.0, aspect)
            states.append(generator.bit_generator.state)
        assert states[0] == states[1]
        # without the jitter, every slot of the near player's rows is as far from the center line
        # as the card is tall, and where it was across
        a, _ = board.layout_board(_NoJitter(seed), 60.0)
        b, _ = board.layout_board(_NoJitter(seed), 60.0, 0.686)
        assert [slot["role"] for slot in a] == [slot["role"] for slot in b]
        for slot_a, slot_b in zip(a, b):
            if slot_a.get("side") == "near" and slot_a["role"] not in ("hand-fan", "site-unit"):
                assert slot_b["q"][0] == pytest.approx(slot_a["q"][0])
                assert slot_b["q"][1] == pytest.approx(slot_a["q"][1] * ratio)
        a, _ = layout_table(_NoJitter(seed), 12, 60.0)
        b, _ = layout_table(_NoJitter(seed), 12, 60.0, 0.686)
        for slot_a, slot_b in zip(a, b):
            if slot_a["role"] == "slot":
                assert slot_b["q"] == pytest.approx(slot_a["q"] * [1, ratio])


def test_backs_and_card_shaped_distractors_take_the_card_aspect_with_the_same_draws():
    for seed in range(6):
        states, sizes = [], []
        for aspect in (None, CARD_ASPECT, 0.686):
            generator = rng(seed)
            sizes.append(textures.generated_back(generator, card_aspect=aspect).size)
            states.append(generator.bit_generator.state)
        assert sizes == [(320, 447), (320, 447), (320, 466)] and states[0] == states[1] == states[2]
    assert digest(np.asarray(textures.generated_back(rng(4), card_aspect=CARD_ASPECT))) == \
        digest(np.asarray(textures.generated_back(rng(4))))
    card_shaped = 0
    for seed in range(120):
        patches, states = [], []
        for aspect in (CARD_ASPECT, 0.686):
            generator = rng(seed)
            patches.append(textures.distractor_patch(generator, 64, aspect)[0])
            states.append(generator.bit_generator.state)
        assert states[0] == states[1]
        (wa, ha), (wb, hb) = patches[0].size, patches[1].size
        if (wa, ha) != (wb, hb):  # a card-shaped one: the same width across, the run's card shape
            card_shaped += 1
            assert abs(min(wa, ha) / max(wa, ha) - CARD_ASPECT) < 0.01
            assert abs(min(wb, hb) / max(wb, hb) - 0.686) < 0.01
    assert card_shaped >= 10
