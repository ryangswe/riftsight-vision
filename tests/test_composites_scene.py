# SPDX-License-Identifier: Apache-2.0
"""The scene generator on the toy game: what it writes, that it repeats, and what it opens."""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from cardvision.composites import CardPool, Settings, build_scene, generate, read_labels, validate_labels
from cardvision.composites import dataset as dataset_module
from cardvision.composites.geometry import CARD_ASPECT
from cardvision.composites.validate import recorded_aspect, structure_problems
from cardvision.core.catalog import load_catalog

# How the toy game's kinds are treated in these tests. Every unit is foil and no spell is, so
# the per-kind foil path shows in the labels; spells carry dice and fill a board's leader slot.
KINDS = {
    "landscape": ["site"],
    "foilProbability": {"unit": 1.0, "spell": 0.0},
    "dice": ["spell"],
    "board": {"leader": "spell", "unit": "unit", "attachment": "unit", "resource": ["unit", "spell"]},
}
SCAN_NAMES = [("fabric", "plain_cloth", "train"), ("wood", "oak_veneer", "train"), ("floor", "cobbles", "train"),
              ("wood", "pine_planks", "val"), ("plaster", "white_wall", "val")]


def write_scans(folder: Path) -> Path:
    """A textures folder as ``fetch-textures`` leaves it, holding small generated pictures."""
    records = []
    for number, (category, asset, split) in enumerate(SCAN_NAMES):
        y, x = np.mgrid[0:96, 0:128]
        picture = np.stack([(x * (number + 2) + y) % 256, (x + y * (number + 3)) % 256, (x * y) % 256], -1)
        rel = f"{split}/toy__{asset}.jpg"
        (folder / split).mkdir(parents=True, exist_ok=True)
        Image.fromarray(picture.astype(np.uint8)).save(folder / rel, quality=90)
        data = (folder / rel).read_bytes()
        records.append({"file": rel, "source": "toy", "assetId": asset, "category": category, "split": split,
                        "page": f"https://example.invalid/{asset}", "license": "CC0 1.0",
                        "licenseUrl": "https://example.invalid/license", "bytes": len(data),
                        "sha256": hashlib.sha256(data).hexdigest()})
    (folder / "index.json").write_text(json.dumps(records), encoding="utf-8")
    return folder


def tree(folder: Path) -> dict[str, bytes]:
    """Every file under a folder, by relative path."""
    return {str(path.relative_to(folder)): path.read_bytes() for path in sorted(folder.rglob("*")) if path.is_file()}


def faces(records, layouts=None):
    """``(record, object)`` for every card face drawn on a table (featured cards left out)."""
    return [(record, o) for record in records if layouts is None or record["layout"] in layouts
            for o in record["objects"] if o["kind"] == "face" and o["source"] == "art"]


@pytest.fixture(scope="module")
def catalog(toy):
    return load_catalog(toy[0])


@pytest.fixture(scope="module")
def scans(tmp_path_factory):
    return write_scans(tmp_path_factory.mktemp("scans"))


@pytest.fixture(scope="module")
def run(toy, catalog, scans, tmp_path_factory):
    """Forty training scenes with scans: ``(folder, manifest, records)``."""
    out = tmp_path_factory.mktemp("composites") / "train"
    manifest = generate(catalog, toy[1], out, n=40, seed=11, textures_dir=scans, kinds=KINDS)
    return out, manifest, read_labels(out)


# ------------------------------------------------------------------------------- the output
def test_the_folder_holds_images_labels_and_a_manifest(run):
    out, manifest, records = run
    assert sorted(path.name for path in out.iterdir()) == ["images", "labels.jsonl", "manifest.json"]
    assert [record["index"] for record in records] == list(range(40))
    assert sorted(path.name for path in (out / "images").iterdir()) == [f"{index:05d}.jpg" for index in range(40)]
    for record in records[:6]:
        with Image.open(out / record["file"]) as image:
            assert image.format == "JPEG" and image.size == (record["width"], record["height"])
        assert (record["width"], record["height"]) in [(1920, 1080), (1280, 720)]
        assert record["split"] == "train" and record["seed"] == 11


def test_the_manifest_describes_the_run(run):
    out, manifest, records = run
    assert manifest == json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert (manifest["format"], manifest["formatVersion"]) == ("cardvision-composites", 1)
    assert (manifest["seed"], manifest["split"], manifest["scenes"]) == (11, "train", 40)
    assert manifest["labelsSha256"] == hashlib.sha256((out / "labels.jsonl").read_bytes()).hexdigest()
    assert manifest["catalog"] == {"game": "toy", "locale": "en", "cards": 20, "cardsWithArt": 20,
                                   "cardsWithoutArt": 0}
    assert manifest["kinds"]["board"]["resource"] == ["unit", "spell"] and manifest["kinds"]["dice"] == ["spell"]
    assert manifest["textures"] == {"scans": 3, "surfaceLike": 2}  # the training scans; cobbles are no table
    settings = manifest["settings"]
    assert settings["background"] == "mix" and settings["boards"] and settings["fill_frame"]
    assert settings["back_share"] == 0.08 and settings["photometric"]["strength"] == 1.0
    assert manifest["parameters"]["boardCardPx"] == {"full": [80.0, 170.0], "pip": [35.0, 100.0]}
    counts = manifest["counts"]
    objects = [o for record in records for o in record["objects"]]
    assert counts["scenes"] == 40 and sum(counts["objects"].values()) == len(objects)
    assert counts["positiveFaces"] == sum(o["positive"] for o in objects) > 300
    assert counts["objects"]["back"] == sum(o["kind"] == "back" for o in objects) > 20
    assert sum(counts["layouts"].values()) == 40 and set(counts["layouts"]) == {"board", "scatter", "table"}


def test_nothing_written_names_a_folder_of_this_machine(run, toy, scans):
    out, _, _ = run
    text = (out / "labels.jsonl").read_text(encoding="utf-8") + (out / "manifest.json").read_text(encoding="utf-8")
    for folder in (out, toy[1], scans, Path.home()):
        assert str(folder) not in text


# ------------------------------------------------------------------------------ the labels
def test_every_label_is_well_formed_and_inside_its_image(run, catalog):
    _, _, records = run
    for record in records:
        assert structure_problems(record, catalog) == []
        W, H = record["width"], record["height"]
        ids = [o["id"] for o in record["objects"]]
        assert len(ids) == len(set(ids))
        for o in record["objects"]:
            x0, y0, x1, y1 = o["box"]
            assert 0 <= x0 < x1 <= W and 0 <= y0 < y1 <= H
            assert np.asarray(o["corners"]).shape == (4, 2)
            assert o["kind"] in ("face", "back", "distractor", "die", "hand", "overlay")
            if o["kind"] == "face":
                assert o["cardId"] in catalog and o["source"] in ("art", "art-inset")
                assert o["positive"] == (o["ignore"] is None) and o["ignore"] in (None, "lowvis", "small")
            else:
                assert o["cardId"] is None and o["positive"] is False and o["ignore"] is None


def test_the_labels_match_the_pictures(run, catalog, toy):
    out, _, _ = run
    report = validate_labels(out, catalog, toy[1])
    assert report["scenes"] == 40 and report["problemCount"] == 0 and report["problems"] == []
    # Cut out through its recorded homography, a clearly visible face matches its own card
    # image the right way up; a wrong corner order or axis would leave this near a quarter.
    assert report["checkedFaces"] >= 60
    assert report["homographyUprightRate"] >= 0.95 and report["rectifiedCorrMedian"] >= 0.8
    # The angle alone, upright against upside down. The toy pictures are close to symmetric in
    # the middle, so this is well short of certain; a wrong convention would leave it near half.
    assert report["angleUprightRate"] >= 0.7


def test_the_checker_notices_a_broken_label(run, catalog):
    _, _, records = run
    record = json.loads(json.dumps(records[0]))
    face = next(o for o in record["objects"] if o["kind"] == "face")
    face["box"][2] = record["width"] + 40
    face["cardId"] = "NOT-A-CARD"
    problems = structure_problems(record, catalog)
    assert any("outside" in line for line in problems) and any("not a card" in line for line in problems)


def test_backs_are_generated_and_name_no_card(run):
    _, manifest, records = run
    backs = [o for record in records for o in record["objects"] if o["kind"] == "back"]
    assert backs and all(o["source"] == "generated-back" and o["cardId"] is None and not o["foil"] for o in backs)
    piles = [o for o in backs if o["role"] in ("pile", "deck-pile")]
    loose = [o for o in backs if o["role"] not in ("pile", "deck-pile")]
    assert piles and loose
    # Loose cards are face down with probability back_share (0.08); piles always are.
    loose_cards = [o for record in records if record["layout"] in ("table", "scatter") for o in record["objects"]
                   if o["kind"] in ("face", "back") and o.get("role") != "pile"]
    share = sum(o["kind"] == "back" for o in loose_cards) / len(loose_cards)
    assert 0.03 < share < 0.15


# --------------------------------------------------------------------------- the card kinds
def test_foil_follows_the_probability_of_each_kind(run, catalog):
    _, _, records = run
    by_kind = {}
    for _, o in faces(records):
        by_kind.setdefault(catalog.card(o["cardId"]).kind, []).append(o["foil"])
    assert len(by_kind["unit"]) > 100 and all(by_kind["unit"])  # probability 1
    assert len(by_kind["spell"]) > 30 and not any(by_kind["spell"])  # probability 0
    share = sum(by_kind["site"]) / len(by_kind["site"])  # no entry: the default, 0.15
    assert len(by_kind["site"]) > 20 and 0 < share < 0.4


def test_landscape_cards_lie_sideways_and_fill_the_center_line_of_a_board(run, catalog):
    _, _, records = run

    def wider_than_tall(o):
        c = np.asarray(o["corners"])
        return np.linalg.norm(c[1] - c[0]) > np.linalg.norm(c[2] - c[1])

    seen = {"site": 0, "other": 0}
    for record, o in faces(records):
        if record["camera"]["tilt"] > 15:  # a steep camera can squash an upright card past square
            continue
        landscape = catalog.card(o["cardId"]).kind == "site"
        assert wider_than_tall(o) == landscape
        seen["site" if landscape else "other"] += 1
    assert seen["site"] > 10 and seen["other"] > 100
    sites = [o for _, o in faces(records, {"board"}) if o["role"] == "site"]
    assert sites and all(catalog.card(o["cardId"]).kind == "site" for o in sites)


def test_board_slots_are_filled_from_the_kinds_the_catalog_names(run, catalog):
    _, _, records = run
    boards = [record for record in records if record["layout"] == "board"]
    assert len(boards) >= 5 and all(record["board"]["placed"] > 0 for record in boards)
    allowed = {"leader": {"spell"}, "leader-unit": {"unit"}, "unit": {"unit"}, "site-unit": {"unit"},
               "attachment": {"unit"}, "resource": {"unit", "spell"}, "site": {"site"}}
    seen = set()
    for record, o in faces(boards):
        seen.add(o["role"])
        if o["role"] in allowed:
            assert catalog.card(o["cardId"]).kind in allowed[o["role"]], o["role"]
    assert set(allowed) | {"discard-pile"} <= seen
    assert any(o["kind"] == "back" and o["role"] == "deck-pile" for record in boards for o in record["objects"])
    # A board that fills the frame records the card size it was built for.
    for record in boards:
        frame = record["board"]["frame"]
        low, high = (35.0, 100.0) if frame["preset"] and frame["preset"]["variant"] == "pip" else (80.0, 170.0)
        assert low <= frame["finalCardPx1920"] <= high


def test_dice_go_with_the_kind_that_carries_them(run, catalog):
    _, _, records = run
    painted = [(record, o) for record, o in faces(records) if "dice" in o["photo"]]
    assert painted
    for record, o in painted:  # a die over the art: loose and tabled spells only
        assert catalog.card(o["cardId"]).kind == "spell" and record["layout"] in ("table", "scatter")
    resting = [o for record in records for o in record["objects"] if o.get("role") == "leader-die"]
    assert resting and all(o["kind"] == "die" for o in resting)
    assert all(record["layout"] == "board" for record in records
               if any(o.get("role") == "leader-die" for o in record["objects"]))


def test_without_a_dice_kind_no_card_gets_dice(toy, catalog, tmp_path):
    kinds = {key: value for key, value in KINDS.items() if key != "dice"}
    generate(catalog, toy[1], tmp_path / "out", n=6, seed=11, kinds=kinds)
    records = read_labels(tmp_path / "out")
    assert any(record["layout"] == "board" for record in records)
    assert not any("dice" in o["photo"] for _, o in faces(records))
    assert not any(o.get("role") == "leader-die" for record in records for o in record["objects"])


def test_the_catalogs_own_kinds_are_used_when_none_are_passed(toy, catalog):
    pool = CardPool(catalog, toy[1])
    assert pool.kinds.landscape == ("site",) and pool.kinds.foil == {"unit": 0.1, "spell": 0.0}
    assert pool.kinds.dice == () and pool.kinds.board == {} and not pool.leader_dice
    assert pool.group_ids("site") == ["TOY-017", "TOY-018"]
    assert pool.group_ids("leader") == pool.ids == sorted(catalog.ids())  # no such group: any card


# ------------------------------------------------------------------- backgrounds and graphics
def test_scans_are_used_for_half_the_tables_and_credited(run, scans):
    _, manifest, records = run
    index = {record["assetId"]: record for record in json.loads((scans / "index.json").read_text())}
    scanned = [record["background"] for record in records if record["background"]["family"].startswith("texture")]
    drawn = [record["background"] for record in records if not record["background"]["family"].startswith("texture")]
    assert 10 <= len(scanned) <= 30 and len(scanned) + len(drawn) == 40
    for background in scanned:
        source = index[background["assetId"]]
        assert source["split"] == "train"
        assert background["sha256"] == source["sha256"] and background["license"] == "CC0 1.0"
        assert background["page"] == source["page"] and background["source"] == "toy"
    assert all(background["license"] == "generated (procedural, no source image)" for background in drawn)
    # Under a board that fills the frame only a surface-like scan is used.
    under_boards = {b["assetId"] for b in scanned if b["family"] == "texture-surface"}
    assert under_boards and under_boards <= {"plain_cloth", "oak_veneer"}


def test_validation_scenes_use_the_validation_scans(toy, catalog, scans, tmp_path):
    manifest = generate(catalog, toy[1], tmp_path / "val", n=6, seed=11, split="val", textures_dir=scans,
                        kinds=KINDS, settings=Settings(background="textures"))
    assert manifest["textures"] == {"scans": 2, "surfaceLike": 1} and manifest["settings"]["background"] == "textures"
    backgrounds = [record["background"] for record in read_labels(tmp_path / "val")]
    assert {b["assetId"] for b in backgrounds if "assetId" in b} == {"pine_planks", "white_wall"}
    assert all("assetId" in b or b["family"] in ("felt", "playmat", "wood", "desk", "weave") for b in backgrounds)


def test_without_a_textures_folder_every_background_is_generated(toy, catalog, tmp_path):
    manifest = generate(catalog, toy[1], tmp_path / "out", n=3, seed=5, kinds=KINDS)
    assert manifest["textures"] is None and manifest["settings"]["background"] == "procedural"
    assert all(record["background"] == {"family": record["background"]["family"],
                                        "license": "generated (procedural, no source image)"}
               for record in read_labels(tmp_path / "out"))
    with pytest.raises(ValueError, match="needs a textures folder"):
        generate(catalog, toy[1], tmp_path / "other", n=1, seed=5, settings=Settings(background="mix"))


def test_broadcast_frames_label_their_graphics(run, catalog):
    _, manifest, records = run
    frames = [record for record in records if record["broadcast"]]
    assert len(frames) >= 6 and sum(manifest["counts"]["broadcast"].values()) == len(frames)
    assert {record["broadcast"]["variant"] for record in frames} <= {"panels", "pip", "bars"}
    for record in frames:
        overlays = [o for o in record["objects"] if o["kind"] == "overlay"]
        assert [o["source"] for o in overlays] == [g for g in record["broadcast"]["graphics"]
                                                   if g in {o["source"] for o in overlays}]
        assert all(o["tags"] == ["overlay"] and o["H"] is None for o in overlays)
        x0, y0, x1, y1 = record["broadcast"]["tableWindow"]
        for o in record["objects"]:
            if o["kind"] in ("face", "back") and o.get("role") != "inset":  # cut to the table's window
                assert x0 <= o["box"][0] and o["box"][2] <= x1 and y0 <= o["box"][1] and o["box"][3] <= y1
    insets = [o for record in frames for o in record["objects"] if o.get("role") == "inset"]
    assert insets and all(o["kind"] == "face" and o["tags"] == ["inset", "overlay"] and o["cardId"] in catalog
                          and o["angle"] == 0.0 for o in insets)


def test_the_switches_turn_the_newer_parts_off(toy, catalog, tmp_path):
    plain = Settings(photometric=None, boards=False, fill_frame=False, back_share=0.5)
    manifest = generate(catalog, toy[1], tmp_path / "out", n=8, seed=11, kinds=KINDS, settings=plain)
    records = read_labels(tmp_path / "out")
    assert {record["layout"] for record in records} <= {"table", "scatter"}
    assert all(record["broadcast"] is None and record["board"] is None and record["photometric"] is None
               and "exposure" not in record["light"] for record in records)
    cards = [o for record in records for o in record["objects"] if o["kind"] in ("face", "back")]
    assert all("photo" not in o for o in cards)
    assert 0.35 < sum(o["kind"] == "back" for o in cards) / len(cards) < 0.7  # back_share 0.5, and piles
    assert manifest["settings"]["photometric"] is None and manifest["settings"]["back_share"] == 0.5
    with pytest.raises(ValueError):
        Settings(background="photos")
    with pytest.raises(ValueError):
        Settings(back_share=1.5)


def test_probe_scenes_hold_no_card(toy, catalog, tmp_path):
    manifest = generate(catalog, toy[1], tmp_path / "probe", n=4, seed=11, split="probe", kinds=KINDS)
    records = read_labels(tmp_path / "probe")
    kinds = {o["kind"] for record in records for o in record["objects"]}
    assert kinds and kinds <= {"distractor", "die", "hand", "overlay"}
    assert all(record["layout"] == "probe" for record in records) and manifest["counts"]["positiveFaces"] == 0


# ------------------------------------------------------------------------------ determinism
def test_the_same_seed_gives_the_same_bytes(toy, catalog, scans, tmp_path):
    first = generate(catalog, toy[1], tmp_path / "a", n=3, seed=3, textures_dir=scans, kinds=KINDS)
    second = generate(catalog, toy[1], tmp_path / "b", n=3, seed=3, textures_dir=scans, kinds=KINDS)
    assert first == second
    a, b = tree(tmp_path / "a"), tree(tmp_path / "b")
    assert sorted(a) == sorted(b) and len(a) == 5 and all(a[name] == b[name] for name in a)


def test_seed_split_and_index_each_change_the_scene(toy, catalog):
    pool = CardPool(catalog, toy[1], kinds=KINDS)
    record, jpeg = build_scene(pool, "train", 2, seed=3)
    again, jpeg_again = build_scene(CardPool(catalog, toy[1], kinds=KINDS), "train", 2, seed=3)
    assert record == again and jpeg == jpeg_again
    assert Image.open(io.BytesIO(jpeg)).size == (record["width"], record["height"])
    for split, index, seed in (("train", 2, 4), ("val", 2, 3), ("train", 3, 3)):
        other, other_jpeg = build_scene(pool, split, index, seed=seed)
        assert other_jpeg != jpeg and other["camera"] != record["camera"]
    with pytest.raises(ValueError, match="split"):
        build_scene(pool, "test", 0)


def test_the_number_of_worker_processes_does_not_change_the_output(toy, catalog, tmp_path, monkeypatch):
    monkeypatch.setattr(dataset_module, "CHUNK", 2)  # several chunks, so that their order matters
    done = []
    one = generate(catalog, toy[1], tmp_path / "one", n=5, seed=9, kinds=KINDS)
    two = generate(catalog, toy[1], tmp_path / "two", n=5, seed=9, kinds=KINDS, workers=2,
                   progress=lambda count, total: done.append((count, total)))
    assert one == two and done[-1] == (5, 5) and done == sorted(done)
    a, b = tree(tmp_path / "one"), tree(tmp_path / "two")
    assert sorted(a) == sorted(b) and all(a[name] == b[name] for name in a)


def test_photometric_effects_do_not_move_anything(toy, catalog):
    pool = CardPool(catalog, toy[1], kinds=KINDS)
    with_effects, jpeg = build_scene(pool, "train", 1, seed=11)
    without, jpeg_plain = build_scene(pool, "train", 1, seed=11, settings=Settings(photometric=None))
    assert jpeg != jpeg_plain and with_effects["photometric"] == "default" and without["photometric"] is None
    assert len(with_effects["objects"]) == len(without["objects"])
    for a, b in zip(with_effects["objects"], without["objects"]):
        assert (a["kind"], a["cardId"], a["corners"], a["box"]) == (b["kind"], b["cardId"], b["corners"], b["box"])


# ------------------------------------------------------------------------- inputs and refusals
def test_cards_without_an_image_are_left_out_and_counted(toy, catalog, tmp_path):
    art = tmp_path / "art"
    shutil.copytree(toy[1], art)
    (art / "TOY-001.png").unlink()
    manifest = generate(catalog, art, tmp_path / "out", n=4, seed=2, kinds=KINDS)
    assert manifest["catalog"]["cardsWithArt"] == 19 and manifest["catalog"]["cardsWithoutArt"] == 1
    assert "TOY-001" not in {o["cardId"] for record in read_labels(tmp_path / "out") for o in record["objects"]}
    assert CardPool(catalog, art).missing == ["TOY-001"]
    (tmp_path / "empty").mkdir()
    with pytest.raises(FileNotFoundError, match="none of the catalog's 20 card images"):
        generate(catalog, tmp_path / "empty", tmp_path / "nothing", n=1, seed=2)


def test_a_folder_that_holds_scenes_is_not_overwritten_unasked(toy, catalog, tmp_path):
    generate(catalog, toy[1], tmp_path / "out", n=1, seed=1)
    before = tree(tmp_path / "out")
    with pytest.raises(FileExistsError, match="already holds generated scenes"):
        generate(catalog, toy[1], tmp_path / "out", n=1, seed=2)
    assert tree(tmp_path / "out") == before
    generate(catalog, toy[1], tmp_path / "out", n=1, seed=2, overwrite=True)
    assert tree(tmp_path / "out")["labels.jsonl"] != before["labels.jsonl"]


@pytest.mark.parametrize("arguments", [{"n": 0}, {"seed": -1}, {"split": "test"}, {"workers": 0}, {"seed": 1.5},
                                       {"card_aspect": 1.2}, {"card_aspect": 0.3}, {"card_aspect": "0.686"}])
def test_bad_arguments_are_refused_before_anything_is_written(toy, catalog, tmp_path, arguments):
    call = {"n": 1, "seed": 1, **arguments}
    with pytest.raises(ValueError):
        generate(catalog, toy[1], tmp_path / "out", **call)
    assert not (tmp_path / "out").exists()


# ------------------------------------------------------------------------- another card size
def test_a_smaller_card_size_shapes_the_backs(toy, catalog):
    pool = CardPool(catalog, toy[1], kinds=KINDS)
    checked = 0
    for index in range(12):
        default, _ = build_scene(pool, "train", index, seed=5)
        record, _ = build_scene(pool, "train", index, seed=5, card_aspect=0.686)
        assert (record["width"], record["layout"], record["camera"]) == \
            (default["width"], default["layout"], default["camera"])
        if record["camera"]["tilt"] != 0:
            continue
        for o in record["objects"]:
            if o["kind"] == "back" and not o["sleeve"]:  # a back of the run's shape: 320 x 466
                c = np.asarray(o["corners"])
                across, down = np.linalg.norm(c[1] - c[0]), np.linalg.norm(c[3] - c[0])
                assert across / down == pytest.approx(320 / 466, abs=0.01)
                checked += 1
    assert checked >= 3


def test_a_folder_records_its_card_aspect_and_is_checked_with_it(toy, catalog, tmp_path):
    manifest = generate(catalog, toy[1], tmp_path / "small", n=3, seed=4, kinds=KINDS, card_aspect=0.686)
    assert manifest["parameters"]["cardAspect"] == 0.686 == recorded_aspect(tmp_path / "small")
    report = validate_labels(tmp_path / "small", catalog, toy[1])
    assert report["problemCount"] == 0 and report["checkedFaces"] > 0 and report["homographyUprightRate"] > 0.9
    # a folder that does not record its aspect, or has no manifest, was made with the default card
    doc = json.loads((tmp_path / "small" / "manifest.json").read_text(encoding="utf-8"))
    del doc["parameters"]["cardAspect"]
    (tmp_path / "small" / "manifest.json").write_text(json.dumps(doc), encoding="utf-8")
    assert recorded_aspect(tmp_path / "small") == CARD_ASPECT
    (tmp_path / "small" / "manifest.json").unlink()
    assert recorded_aspect(tmp_path / "small") == CARD_ASPECT
    (tmp_path / "small" / "manifest.json").write_text(json.dumps({"parameters": {"cardAspect": 1.4}}), encoding="utf-8")
    with pytest.raises(ValueError, match="card aspect"):
        recorded_aspect(tmp_path / "small")


def test_the_default_card_aspect_writes_what_the_constant_writes(toy, catalog, tmp_path):
    generate(catalog, toy[1], tmp_path / "plain", n=2, seed=6)
    generate(catalog, toy[1], tmp_path / "given", n=2, seed=6, card_aspect=CARD_ASPECT)
    assert tree(tmp_path / "plain") == tree(tmp_path / "given")
    assert json.loads((tmp_path / "plain" / "manifest.json").read_text())["parameters"]["cardAspect"] == 0.716


def test_worker_processes_do_not_change_a_smaller_card_size(toy, catalog, tmp_path, monkeypatch):
    monkeypatch.setattr(dataset_module, "CHUNK", 2)
    one = generate(catalog, toy[1], tmp_path / "one", n=3, seed=9, kinds=KINDS, card_aspect=0.686)
    two = generate(catalog, toy[1], tmp_path / "two", n=3, seed=9, kinds=KINDS, card_aspect=0.686, workers=2)
    assert one == two and tree(tmp_path / "one") == tree(tmp_path / "two")
    assert one["parameters"]["cardAspect"] == 0.686


# --------------------------------------------------------------------- what the generator opens
_OPENED: list[str] = []
_RECORDING: list[bool] = []


def _note_open(event: str, args: tuple) -> None:
    if event == "open" and _RECORDING and isinstance(args[0], (str, bytes, os.PathLike)):
        _OPENED.append(os.fsdecode(args[0]))


sys.addaudithook(_note_open)  # an audit hook cannot be removed; it only records while asked to


def test_the_generator_opens_nothing_outside_its_three_folders(toy, catalog, scans, tmp_path):
    """Every file the interpreter opens raises an audit event, whichever function opened it."""
    # A first run, so that code loaded on first use is already loaded when the recording starts.
    generate(catalog, toy[1], tmp_path / "warm", n=3, seed=6, textures_dir=scans, kinds=KINDS)
    out = tmp_path / "out"
    _OPENED.clear()
    _RECORDING.append(True)
    try:
        generate(catalog, toy[1], out, n=3, seed=6, textures_dir=scans, kinds=KINDS)
        validate_labels(out, catalog, toy[1])
    finally:
        _RECORDING.clear()
    opened = [Path(name).resolve() for name in _OPENED]
    roots = {"art": Path(toy[1]).resolve(), "textures": scans.resolve(), "out": out.resolve()}
    used = {name: [path for path in opened if root in path.parents] for name, root in roots.items()}
    assert all(used.values()), {name: len(paths) for name, paths in used.items()}
    outside = [str(path) for path in opened if not any(root in path.parents for root in roots.values())]
    assert outside == []
    assert {path.suffix for path in used["art"]} == {".png"}
    assert {path.name for path in used["textures"]} > {"index.json"}  # the index, and scans
    assert {path.suffix for path in used["textures"]} == {".json", ".jpg"}
    assert {path.name for path in used["out"]} >= {"labels.jsonl", "manifest.json", "00000.jpg"}
    assert tree(out) == tree(tmp_path / "warm")
    # The recorder does see a file opened elsewhere: reading the catalog, which the caller
    # does before the generator starts, is one.
    _OPENED.clear()
    _RECORDING.append(True)
    try:
        load_catalog(toy[0])
    finally:
        _RECORDING.clear()
    assert [Path(name).resolve() for name in _OPENED] == [Path(toy[0]).resolve()]


@pytest.mark.parametrize("text, problem", [("[1, 2]", "not a JSON object"), ("{not json", "not valid JSON"),
                                           ('"just a string"', "not a JSON object")])
def test_a_manifest_that_is_no_json_object_is_a_value_error_naming_it(tmp_path, text, problem):
    from cardvision.composites.dataset import MANIFEST_NAME

    (tmp_path / MANIFEST_NAME).write_text(text, encoding="utf-8")
    with pytest.raises(ValueError, match=problem) as raised:
        recorded_aspect(tmp_path)
    assert MANIFEST_NAME in str(raised.value)
