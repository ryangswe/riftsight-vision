# SPDX-License-Identifier: Apache-2.0
"""Backgrounds from a folder of downloaded CC0 material scans, and the table seen in perspective.

The scans are optional. ``cardvision fetch-textures`` downloads them into a folder and writes
``index.json`` there: a list of records, one per file::

    {"file": "train/polyhaven__oak_veneer_01.jpg", "source": "polyhaven", "assetId": "oak_veneer_01",
     "category": "wood", "split": "train", "page": "https://...", "license": "CC0 1.0",
     "licenseUrl": "https://...", "sha256": "..."}

``file`` is relative to the folder. ``split`` keeps the scans used for training scenes apart
from those used for validation scenes. A material scan shows a surface and nothing else, which
is why scans are used and photographs of tables are not: a photograph may have cards in it.

Scans are of two uses. Any scan may be the table of a scene. Only *surface-like* scans, the
ones that look like something cards are played on (cloth, leather, table-top woods, plain
concrete), are used under a game board that fills the frame; ``is_surface`` is that rule.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
from PIL import Image

from cardvision.composites import textures as T
from cardvision.composites.geometry import CARD_ASPECT

# Which scans count as playing surfaces, by the category and the asset id in the index.
# A category that maps to None is never one (walls; pavement, brick, cobbles, tarmac).
SURFACE_RULE = {
    # textiles and leather
    "fabric": {"include": r".*", "exclude": r"dirty"},
    # table-top woods, not bark or wooden walls
    "wood": {"include": r"veneer|plank|parquet|pine|wood|cedar|sycamore|oak|walnut|cherry",
             "exclude": r"bark|bamboo_wall|beam_wall|textured_concrete"},
    # plain concrete only
    "concrete": {"include": r"^(brushed_concrete.*|concrete|concrete_floor(_0[12])?|concrete_floor_painted"
                            r"|garage_floor|granular_concrete|anti_slip_concrete)$",
                 "exclude": r"$^"},
    "plaster": None,
    "floor": None,
}

# Procedural families that stand in for a playing surface, and how often each is drawn.
SURFACE_FAMILIES = {"felt": 0.3, "playmat": 0.3, "wood": 0.2, "desk": 0.1, "weave": 0.1}

INDEX_NAME = "index.json"
_REQUIRED = ("file", "source", "assetId", "split")


def is_surface(category, asset_id):
    """Whether a scan of this category and id looks like something cards are played on."""
    rule = SURFACE_RULE.get(category)
    return bool(rule) and bool(re.search(rule["include"], asset_id)) and not re.search(rule["exclude"], asset_id)


def load_texture_index(textures_dir):
    """The records of ``index.json`` in a textures folder, checked for the keys the generator
    reads. Every ``file`` must be a relative path inside the folder."""
    path = Path(textures_dir) / INDEX_NAME
    if not path.is_file():
        raise FileNotFoundError(f"{path}: no texture index (run cardvision fetch-textures --out {textures_dir})")
    records = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(records, list):
        raise ValueError(f"{path.name}: the texture index must be a list of records")
    for position, record in enumerate(records):
        if not isinstance(record, dict) or any(not isinstance(record.get(key), str) for key in _REQUIRED):
            raise ValueError(f"{path.name}: record {position} needs the text keys {list(_REQUIRED)}")
        rel = Path(record["file"])
        if rel.is_absolute() or ".." in rel.parts:
            raise ValueError(f"{path.name}: record {position}: \"file\" must be a relative path inside the folder")
    return records


def texture_background(rng, records, textures_dir, W, H):
    """A scan as a table: a random record, a quarter-turn, perhaps a mirror flip, scaled so
    that it spans between half a frame and two frames (tiled where it is the smaller), with a
    small color shift. Returns ``(float array (H, W, 3) in [0, 1], record)``."""
    c = records[int(rng.integers(0, len(records)))]
    im = Image.open(Path(textures_dir) / c["file"]).convert("RGB")
    im = im.rotate(90 * int(rng.integers(0, 4)), expand=True)
    if rng.random() < 0.5:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    k = max(W / im.width, H / im.height) * rng.uniform(0.5, 2.0)
    im = im.resize((max(8, int(im.width * k)), max(8, int(im.height * k))), Image.BICUBIC)
    canvas = Image.new("RGB", (W, H))
    for y in range(0, H, im.height):
        for x in range(0, W, im.width):
            canvas.paste(im, (x, y))
    a = np.asarray(canvas, np.float32) / 255 * rng.uniform(0.8, 1.2, 3)
    return np.clip(a, 0, 1), c


def warp_to_table(bg, W, H, Hinv):
    """The table texture lying on the table plane, seen through the camera. The texture is
    mirror-tiled 3 x 3 first, so that the far side of a tilted table is still covered."""
    big = Image.fromarray((bg * 255).astype(np.uint8))
    tex = Image.new("RGB", (W * 3, H * 3))
    for i in range(3):
        for j in range(3):
            tile = big
            if i != 1:
                tile = tile.transpose(Image.FLIP_LEFT_RIGHT)
            if j != 1:
                tile = tile.transpose(Image.FLIP_TOP_BOTTOM)
            tex.paste(tile, (i * W, j * H))
    Minv2 = np.array([[1, 0, 1.5 * W], [0, 1, 1.5 * H], [0, 0, 1.0]]) @ Hinv
    Minv2 /= Minv2[2, 2]
    warped = tex.transform((W, H), Image.PERSPECTIVE, tuple(Minv2.ravel()[:8]), Image.BILINEAR)
    return np.asarray(warped, np.float32) / 255


def surface_background(srng, surfaces, textures_dir, W, H, card_aspect=CARD_ASPECT):
    """The table under a board that fills the frame: half the time a surface-like scan (when
    there are any), otherwise one of the procedural surface families.
    ``card_aspect`` shapes the zone outlines of a playmat.
    Returns ``(image, family name, scan record or None)``."""
    if surfaces and srng.random() < 0.5:
        bg, record = texture_background(srng, surfaces, textures_dir, W, H)
        return bg, "texture-surface", record
    fams = list(SURFACE_FAMILIES)
    fam = fams[int(srng.choice(len(fams), p=np.array([SURFACE_FAMILIES[f] for f in fams])))]
    bg, fam = T.make_background(srng, W, H, fam, card_aspect)
    return bg, fam, None
