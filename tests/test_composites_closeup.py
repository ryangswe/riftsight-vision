# SPDX-License-Identifier: Apache-2.0
"""Close-up scenes (``make-composites --closeups``): one large card held at a steep angle, and the
promise that a run without them is the run it was before they existed."""

from __future__ import annotations

import hashlib
import json
import platform
from pathlib import Path

import numpy as np
import PIL
import pytest

from cardvision.composites import Settings, generate, read_labels, validate_labels
from cardvision.composites import closeup as C
from cardvision.composites.commands import COMMANDS
from cardvision.composites.geometry import apply_h
from cardvision.composites.validate import closeup_problems, structure_problems
from cardvision.core.catalog import load_catalog
from test_composites_scene import KINDS, tree, write_scans

UNIT = [(0, 0), (1, 0), (1, 1), (0, 1)]

# What main's code wrote for three runs without close-ups, before close-ups existed, recorded
# on the machine and package versions named here: the SHA-256 of every file of each folder
# (``folder_digest``). The bytes of a JPEG depend on the platform's floating point and image
# libraries, so the pins are checked only where they were recorded; elsewhere the tests below
# them still hold the same promise without fixed numbers.
PINNED_ON = {"system": "Darwin", "machine": "arm64", "numpy": "2.2.6", "pillow": "13.0.0"}
PINNED_DIGESTS = {
    "train-scans": "eb7562650db9ad5bc5be41d72877e95957a673317fd8e2979395056fe562377b",
    "val-plain": "3a8c78694e14560b8bafdd7f11424e92d902652fcb4b6686c888b7eba74e0908",
    "train-no-boards": "c8789719b5bd0eea43256ecad431224a6595b0f117f3a25e7420ea2f0dab5efb",
}


def folder_digest(folder: Path) -> str:
    """One SHA-256 over every file of a folder: its relative path and the SHA-256 of its bytes."""
    digest = hashlib.sha256()
    for name, data in tree(folder).items():
        digest.update(f"{name}\0{hashlib.sha256(data).hexdigest()}\n".encode())
    return digest.hexdigest()


def pinned_platform() -> bool:
    return (platform.system(), platform.machine(), np.__version__, PIL.__version__) == tuple(PINNED_ON.values())


@pytest.fixture(scope="module")
def catalog(toy):
    return load_catalog(toy[0])


@pytest.fixture(scope="module")
def scans(tmp_path_factory):
    return write_scans(tmp_path_factory.mktemp("scans"))


@pytest.fixture(scope="module")
def closeups(toy, catalog, tmp_path_factory):
    """Thirty training scenes, every one a close-up: ``(folder, manifest, records)``."""
    out = tmp_path_factory.mktemp("closeups") / "train"
    manifest = generate(catalog, toy[1], out, n=30, seed=4, kinds=KINDS, settings=Settings(closeups=1.0))
    return out, manifest, read_labels(out)


def faces(records):
    return [(record, o) for record in records for o in record["objects"] if o["kind"] == "face"]


@pytest.fixture(scope="module")
def plain(toy, catalog, scans, tmp_path_factory):
    """Sixteen training scenes with scans and the default settings: ``(folder, manifest)``."""
    out = tmp_path_factory.mktemp("plain") / "train"
    return out, generate(catalog, toy[1], out, n=16, seed=11, textures_dir=scans, kinds=KINDS)


# ------------------------------------------------------------------------------ the default
def test_a_run_without_closeups_writes_the_bytes_main_wrote(toy, catalog, plain, tmp_path):
    if not pinned_platform():
        pytest.skip(f"the pinned digests were recorded on {PINNED_ON}")
    assert folder_digest(plain[0]) == PINNED_DIGESTS["train-scans"]
    generate(catalog, toy[1], tmp_path / "val", n=8, seed=3, split="val", kinds=KINDS)
    assert folder_digest(tmp_path / "val") == PINNED_DIGESTS["val-plain"]
    generate(catalog, toy[1], tmp_path / "flat", n=8, seed=5, kinds=KINDS, settings=Settings(boards=False))
    assert folder_digest(tmp_path / "flat") == PINNED_DIGESTS["train-no-boards"]


def test_a_share_of_zero_is_the_default_and_the_manifest_does_not_name_it(toy, catalog, scans, plain, tmp_path):
    out, default = plain
    generate(catalog, toy[1], tmp_path / "zero", n=16, seed=11, textures_dir=scans, kinds=KINDS,
             settings=Settings(closeups=0.0))
    assert tree(tmp_path / "zero") == tree(out)
    assert "closeups" not in default["settings"] and "closeups" not in default["parameters"]
    assert "closeup" not in default["counts"]["layouts"]


def test_closeups_replace_their_scenes_and_leave_every_other_scene_as_it_was(toy, catalog, scans, plain, tmp_path):
    out = plain[0]
    mixed = generate(catalog, toy[1], tmp_path / "mixed", n=16, seed=11, textures_dir=scans, kinds=KINDS,
                     settings=Settings(closeups=0.4))
    before_all, records = read_labels(out), read_labels(tmp_path / "mixed")
    chosen = [r["index"] for r in records if r["layout"] == "closeup"]
    assert 0 < len(chosen) < 16 and mixed["counts"]["layouts"]["closeup"] == len(chosen)
    for before, after in zip(before_all, records):
        same_image = (out / before["file"]).read_bytes() == (tmp_path / "mixed" / after["file"]).read_bytes()
        if after["index"] in chosen:
            assert not same_image and before["layout"] != "closeup"
        else:
            assert after == before and same_image
    assert mixed["settings"]["closeups"] == 0.4
    assert mixed["parameters"]["closeups"]["share"] == 0.4
    assert mixed["parameters"]["closeups"]["tiltDegrees"] == [15.0, 45.0]


# ------------------------------------------------------------------------------ close-ups
def test_closeup_tilts_cover_15_to_45_degrees_read_back_from_h(closeups):
    _, _, records = closeups
    tilts = []
    for record, o in faces(records):
        tilt = C.tilt_from_h(o["H"], record["width"], record["height"], record["camera"]["focal"])
        assert tilt == pytest.approx(o["pose"]["tilt"], abs=0.5)
        tilts.append(tilt)
    assert 14.5 <= min(tilts) and max(tilts) <= 45.5
    counts, _ = np.histogram(tilts, bins=[15, 25, 35, 45])
    assert all(counts >= 3), counts


def test_every_closeup_face_has_four_corners_that_its_h_maps(closeups):
    _, _, records = closeups
    for record, o in faces(records):
        corners = np.asarray(o["corners"])
        assert corners.shape == (4, 2)
        assert np.abs(apply_h(np.asarray(o["H"]), UNIT) - corners).max() < 0.05


def test_closeups_are_large_and_each_holds_a_positive_face(closeups):
    _, manifest, records = closeups
    assert manifest["counts"]["layouts"] == {"closeup": 30}
    shares = []
    for record in records:
        assert record["layout"] == "closeup" and record["board"] is None and record["broadcast"] is None
        main = [o for o in record["objects"] if o.get("role") == "closeup"]
        assert len(main) == 1 and main[0]["positive"]
        c = np.asarray(main[0]["corners"])
        long_side = max(np.linalg.norm(c[(i + 1) % 4] - c[i]) for i in range(4))
        shares.append(long_side / record["height"])
    assert 0.2 <= min(shares) and max(shares) <= 1.3
    assert min(shares) < 0.45 and max(shares) > 0.6
    assert any(len(r["objects"]) == 2 for r in records)  # some show a pair


def test_the_check_passes_closeups_and_their_homographies_rectify_the_card(closeups, catalog, toy):
    out, _, records = closeups
    report = validate_labels(out, catalog, toy[1])
    assert report["problemCount"] == 0, report["problems"]
    assert report["checkedFaces"] >= 10 and report["homographyUprightRate"] >= 0.9
    assert all(closeup_problems(r) == [] for r in records)


def test_the_check_notices_a_bad_closeup(closeups):
    _, _, records = closeups
    record = json.loads(json.dumps(records[0]))
    face = next(o for o in record["objects"] if o.get("role") == "closeup")
    corners = [list(point) for point in face["corners"]]
    face["corners"] = [corners[i] for i in (0, 2, 1, 3)]  # crossed
    assert any("convex" in p for p in closeup_problems(record))
    face["corners"] = corners[::-1]  # counter-clockwise
    assert any("clockwise" in p for p in closeup_problems(record))
    face["corners"] = [[x - 3 * record["width"], y] for x, y in corners]
    assert any("outside the frame" in p for p in closeup_problems(record))
    face["corners"] = corners
    assert closeup_problems(record) == []
    for o in record["objects"]:
        o["positive"], o["ignore"] = False, "lowvis"
    assert any("no positive face" in p for p in structure_problems(record))


def test_the_same_seed_gives_the_same_closeups(toy, catalog, tmp_path):
    for name in ("a", "b"):
        generate(catalog, toy[1], tmp_path / name, n=8, seed=4, kinds=KINDS, settings=Settings(closeups=1.0))
    assert tree(tmp_path / "a") == tree(tmp_path / "b")


@pytest.mark.parametrize("share", [-0.1, 1.5, float("nan"), True, "0.5"])
def test_a_share_that_is_not_a_share_is_refused(share):
    with pytest.raises(ValueError, match="share of close-ups"):
        Settings(closeups=share)


def test_the_command_line_draws_closeups_and_checks_them(toy, tmp_path, capsys):
    import argparse

    _, arguments, run = COMMANDS["make-composites"]
    parser = argparse.ArgumentParser()
    arguments(parser)
    base = ["--catalog", str(toy[0]), "--art", str(toy[1]), "--n", "6", "--seed", "2", "--check"]
    assert run(parser.parse_args([*base, "--out", str(tmp_path / "on"), "--closeups", "0.5"])) == 0
    manifest = json.loads((tmp_path / "on" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["parameters"]["closeups"]["share"] == 0.5 and manifest["counts"]["layouts"].get("closeup")
    assert run(parser.parse_args([*base, "--out", str(tmp_path / "off")])) == 0
    off = json.loads((tmp_path / "off" / "manifest.json").read_text(encoding="utf-8"))
    assert "closeups" not in off["parameters"] and "closeups" not in off["settings"]
    assert run(parser.parse_args([*base, "--out", str(tmp_path / "bad"), "--closeups", "2"])) == 1
    assert "share of close-ups" in capsys.readouterr().err
