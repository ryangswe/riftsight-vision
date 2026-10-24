# SPDX-License-Identifier: Apache-2.0
"""Where the recognizer trainer's data comes from: named streams of rows, and nothing else.

The trainer never opens a data folder itself. Everything it trains and validates on reaches it
through this module, as *streams*: named lists of rows in one format.

The row format
==============

A row is a dictionary::

    {"path": "crops/a.png",      # an image file, or instead "image": an (H, W, 3) uint8 RGB array
     "inner": [x, y, w, h],      # the card's box inside the image, in pixels
     "card_id": "SET-001",       # the catalog id of the card; None for a negative
     "group": "g-example-01",    # the recording group the row comes from
     "label": "back"}            # optional, negatives only: what the row shows

* The image has room around the card (a crop cut with a margin), and the card is upright to
  the nearest quarter turn. ``inner`` says where the card's box lies in it, in whole pixels.
  The built-in streams take it from ``cardvision.data.targets.margin_crop``, which cuts the
  box to whole pixels the way it cuts the crop; a plug-in's fractional value is cut down and
  the box clipped to the image (``whole_inner``).
* A relative ``path`` is resolved against the stream's ``root`` folder.
* A positive's ``card_id`` must be in the catalog and have a card image; other rows are
  dropped and counted. Rows of cards kept out of training are dropped from training streams.
* A negative shows no card face. Its ``label`` matters in one way: a label listed in the
  config's ``back_labels`` marks a card back, which the loss may weight differently.

The built-in streams
====================

``real_positives``, ``real_negatives``
    Crops cut from label manifests and a frames folder by
    ``cardvision.data.recognizer_crops`` and ``negative_crops``: named faces, and labeled
    backs and ``not-card`` boxes. The crops are written once to ``<out>/cache``.
``composite_positives``
    Face crops cut from a ``cardvision make-composites`` folder (``composite_crops``): the
    positive faces that are visible enough, large enough and near enough to a quarter turn,
    by the three limits of ``[streams.composite_positives]``.
``art``
    The catalog's card images, one row per card. At training time each is placed on a
    background patch with room around it, so that it has the form of a cut crop.
``background_patches``
    Not a stream of rows: square pieces of background for the background swap and for the
    card images' surroundings, drawn procedurally and, when a textures folder is given, from
    its scans (``make_background_patches``); or, with ``[background_patches] folder``, the
    images of that folder (``load_background_patches``).
``validation``
    Two sets, never trained on: ``seen``, the real crops of training cards from recording
    groups held out whole, and ``unseen``, composite crops of cards kept out of training
    altogether. Each is scored by top-1 retrieval against clean card images.

Plug-in streams
===============

``extra_sources = ["package.module:function"]`` in the config's ``[data]`` adds streams. Each
function is called with a ``SourceContext`` and returns a dictionary from stream name to either
a list of rows or ``{"root": folder, "rows": [...]}``. A name the trainer fills itself
(``art``, ``composite_positives``, ``real_positives``, ``real_negatives``) may be given too:
its rows are then added to the built-in ones. How a plug-in's stream is treated and how many of
its rows an epoch takes is said in the config (``[streams.NAME]`` and ``[[segment]]``), as for
any other stream.

``[validation] source = "package.module:function"`` replaces the two validation sets. The
function gets the same context and returns ``{"seen": SET, "unseen": SET}``, where a set is
``{"rows": [...], "root": folder or None, "bank": [card ids] or None}``; ``bank`` lists the
cards whose clean images the set is scored against (None: the training cards for ``seen``,
every card with an image for ``unseen``).
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import shutil
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from cardvision.core.catalog import Catalog, is_url
from cardvision.train_recognizer.config import (
    ART,
    BUILT_IN_STREAMS,
    COMPOSITE_POSITIVES,
    COMPOSITE_SELECTION,
    REAL_NEGATIVES,
    REAL_POSITIVES,
    ConfigError,
)

Row = dict[str, Any]
Log = Callable[[str], None]

PATCH_STREAM = 7101  # the tag of the random stream that draws the background patches
INDEX_NAME = "index.jsonl"
FINGERPRINT_NAME = "fingerprint.json"


@dataclass
class Stream:
    """A named list of rows and how the trainer treats them.

    Attributes:
        name: the stream's name.
        rows: its rows, in the format of the module docstring.
        chain: ``"physical"`` (the physical chain and the background swap run on its rows) or
            ``"plain"``.
        negative: its rows show no card face.
        root: the folder that relative ``path`` values are resolved against.
        surface_margin: for card images, the background placed around each image, as a
            fraction of its width and height on each side.
    """

    name: str
    rows: list[Row] = field(default_factory=list)
    chain: str = "plain"
    negative: bool = False
    root: str | None = None
    surface_margin: float = 0.0


@dataclass
class ValidationSet:
    """Rows to score and the cards whose clean images they are scored against."""

    rows: list[Row] = field(default_factory=list)
    root: str | None = None
    bank: list[str] | None = None


@dataclass
class SourceContext:
    """What a plug-in is given.

    Attributes:
        catalog: the game's catalog.
        config: the whole resolved config.
        seed, data_seed: the training seed and the seed of the validation choices.
        unseen: the card ids kept out of training.
        art_ids: the card ids that have a card image.
        out_dir: the run's output folder.
    """

    catalog: Catalog
    config: Mapping[str, Any]
    seed: int
    data_seed: int
    unseen: frozenset[str]
    art_ids: frozenset[str]
    out_dir: Path


@dataclass
class Sources:
    """Everything the trainer reads, assembled by ``build_sources``."""

    catalog: Catalog
    art: dict[str, np.ndarray]
    streams: dict[str, Stream]
    patches: list[np.ndarray]
    seen: ValidationSet
    unseen: ValidationSet
    unseen_ids: list[str]
    held_out_groups: list[str]
    inputs: dict[str, Any]
    notes: list[str]


# --------------------------------------------------------------------------------- pieces
def whole_inner(inner, width: int | None = None, height: int | None = None) -> list[int]:
    """A card's box in whole pixels: the left and top edges clipped to 0 and cut down, the
    right and bottom edges cut down and, with an image size, clipped to it.

    A box that is whole and inside the image already, as every built-in stream's is, comes
    back unchanged.
    """
    x, y, w, h = inner
    x0, y0 = int(max(0, x)), int(max(0, y))
    x1, y1 = int(x + w), int(y + h)
    if width is not None and height is not None:
        x1, y1 = min(x1, int(width)), min(y1, int(height))
    return [x0, y0, max(0, x1 - x0), max(0, y1 - y0)]


def load_image(row: Row, root: str | None = None) -> np.ndarray:
    """A row's image as ``(H, W, 3)`` uint8 RGB."""
    if row.get("image") is not None:
        return np.asarray(row["image"])
    path = Path(row["path"])
    if not path.is_absolute() and root is not None:
        path = Path(root) / path
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"))


def load_art(catalog: Catalog, art_dir: str | Path, size: int) -> dict[str, np.ndarray]:
    """Every card image found in ``art_dir``, by card id, reduced to fit within ``2 * size``
    by ``3 * size`` px (Pillow's ``thumbnail``). Cards without an image file are left out, and so
    are the cards without art (``"art": null``)."""
    art: dict[str, np.ndarray] = {}
    for card in catalog:
        if not card.has_art or is_url(card.art):
            continue
        path = Path(catalog.art_location(card.id, art_dir))
        if path.is_file():
            with Image.open(path) as image:
                image = image.convert("RGB")
                image.thumbnail((size * 2, size * 3))
                art[card.id] = np.asarray(image)
    return art


def make_background_patches(count: int, size: int, seed: int, textures_dir: str | Path | None = None,
                            texture_share: float = 0.5) -> list[np.ndarray]:
    """``count`` square background patches of ``size`` px, uint8 RGB.

    Each is a procedural surface (``cardvision.composites.textures.make_background``) or, for
    ``texture_share`` of them when ``textures_dir`` holds scans marked for training, a piece
    of a scan (``cardvision.composites.surfaces.texture_background``). Patch ``i`` depends on
    the seed and ``i`` only.
    """
    from cardvision.composites.surfaces import load_texture_index, texture_background
    from cardvision.composites.textures import make_background

    records = []
    if textures_dir is not None:
        records = [record for record in load_texture_index(textures_dir) if record["split"] == "train"]
    patches = []
    for index in range(count):
        rng = np.random.default_rng([seed, PATCH_STREAM, index])
        if records and rng.random() < texture_share:
            image, _ = texture_background(rng, records, textures_dir, size, size)
        else:
            image, _ = make_background(rng, size, size)
        patches.append((np.clip(image, 0, 1) * 255).astype(np.uint8))
    return patches


PATCH_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")


def _patch_files(folder: Path) -> list[Path]:
    if not folder.is_dir():
        raise ConfigError(f"[background_patches] folder {str(folder)!r} is not a folder")
    files = sorted((path for path in folder.iterdir() if path.is_file() and path.suffix.lower() in PATCH_SUFFIXES),
                   key=lambda path: os.fsencode(path.name))
    if not files:
        raise ConfigError(f"[background_patches] folder {str(folder)!r} has no .png, .jpg, .jpeg or .webp images")
    return files


def load_background_patches(folder: str | Path, size: int, count: int | None = None) -> list[np.ndarray]:
    """The background patches in ``folder``: every .png/.jpg/.jpeg/.webp file in it (not its
    subfolders, suffix in any case), sorted by file name byte-wise, decoded to RGB, not resized.
    Patch ``i`` is the ``i``-th file. Each must be ``size`` x ``size`` px, and there must be
    ``count`` of them when ``count`` is given."""
    files = _patch_files(Path(folder))
    if count is not None and count != len(files):
        raise ConfigError(f"[background_patches] count is {count} but folder {str(folder)!r} has {len(files)} images")
    patches = []
    for path in files:
        with Image.open(path) as image:
            if image.size != (size, size):
                raise ConfigError(f"[background_patches] folder image {path.name!r} is {image.size[0]}x{image.size[1]} px, "
                                  f"not the {size}x{size} px of size")
            patches.append(np.asarray(image.convert("RGB"), dtype=np.uint8).copy())
    return patches


def background_patches_digest(folder: str | Path) -> dict[str, Any]:
    """``{"files", "sha256"}`` of a patch folder: the sha256 over, for each image in patch
    order, its name bytes, a NUL, the file's sha256 in hex and a newline."""
    files = _patch_files(Path(folder))
    digest = hashlib.sha256()
    for path in files:
        digest.update(os.fsencode(path.name) + b"\0" + _sha256(path).encode() + b"\n")
    return {"files": len(files), "sha256": digest.hexdigest()}


def _sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _rows_digest(rows: list[Row]) -> str:
    digest = hashlib.sha256()
    for row in rows:
        image = row.get("image")
        what = row.get("path") if image is None else hashlib.sha256(np.ascontiguousarray(image).tobytes()).hexdigest()
        digest.update(json.dumps([what, list(row["inner"]), row.get("card_id"), row.get("group"), row.get("label")]).encode())
    return digest.hexdigest()


def _cached(folder: Path, fingerprint: dict[str, Any]) -> list[Row] | None:
    """The rows of a crop cache made from the same inputs, or None."""
    try:
        if json.loads((folder / FINGERPRINT_NAME).read_text(encoding="utf-8")) != fingerprint:
            return None
        lines = (folder / INDEX_NAME).read_text(encoding="utf-8").splitlines()
    except (OSError, ValueError):
        return None
    return [json.loads(line) for line in lines if line.strip()]


def _write_cache(folder: Path, fingerprint: dict[str, Any], items) -> list[Row]:
    """Write ``(file name, image, row)`` items as PNG files and an index; return the rows."""
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    rows = []
    for name, image, row in items:
        Image.fromarray(image).save(folder / name, compress_level=1)
        rows.append({"path": name, **row, "sha256": hashlib.sha256(np.ascontiguousarray(image).tobytes()).hexdigest()})
    (folder / INDEX_NAME).write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    (folder / FINGERPRINT_NAME).write_text(json.dumps(fingerprint, indent=1) + "\n", encoding="utf-8")
    return rows


# --------------------------------------------------------------------------- real crops
def _real_rows(crops) -> Any:
    for crop in crops:
        height, width = crop.image.shape[:2]
        inner = list(crop.inner)
        if inner[2] < 2 or inner[3] < 2:
            continue
        yield crop.name, crop.image, {
            "inner": inner, "card_id": crop.card_id, "group": crop.row.group, "label": crop.label,
            "source_type": crop.row.source_type, "turns": crop.turns, "half": crop.half,
            "hw": [height, width],
        }


def real_crops(manifests: list[str], frames: str | Path, cache: Path, *, margin: float, roles: list[str],
               sources_file: str | None, exclude_ids: frozenset[str], log: Log) -> tuple[list[Row], list[Row], dict]:
    """Cut the real positives and negatives of label manifests, or read them back from the
    cache when it was made from the same inputs.

    Positives are the faces ``cardvision.data.recognizer_crops`` accepts (named, readable,
    whole-card proportions or an exempt half card), cut with ``margin`` and turned upright;
    negatives are the backs and ``not-card`` boxes of ``negative_crops``, cut with the same
    margin and not turned. Returns ``(positives, negatives, record)``.
    """
    from cardvision.data import FrameStore, TargetRules, iter_rows, load_source_config, read_manifest
    from cardvision.data.targets import negative_crops, recognizer_crops

    hashes = {Path(path).name: _sha256(path) for path in manifests}
    rows = [row for path in manifests for row in read_manifest(path)]
    rows = list(iter_rows(rows, role=roles))
    store = FrameStore(frames)
    present = sorted((row.platform, row.video_id, row.t, store.path(row).stat().st_size) for row in rows if store.has(row))
    fingerprint = {"manifests": hashes, "roles": sorted(roles), "margin": margin,
                   "sources": None if sources_file is None else _sha256(sources_file),
                   "excluded": sorted(exclude_ids),
                   "frames": hashlib.sha256(json.dumps(present).encode()).hexdigest()}
    rules = TargetRules.for_sources(load_source_config(sources_file)) if sources_file else TargetRules()
    out = {}
    record: dict[str, Any] = {"manifests": hashes, "rows": len(rows), "framesFound": len(present)}
    for name, cut in ((REAL_POSITIVES, lambda tally: recognizer_crops(rows, store, margin=margin, rules=rules,
                                                                    exclude_ids=exclude_ids, skipped=tally)),
                      (REAL_NEGATIVES, lambda tally: negative_crops(rows, store, margin=margin, skipped=tally))):
        folder = cache / name
        found = _cached(folder, fingerprint)
        if found is None:
            tally: Counter = Counter()
            found = _write_cache(folder, fingerprint, _real_rows(cut(tally)))
            log(f"{name}: cut {len(found)} crops into {folder}" + (f" (left out: {dict(tally)})" if tally else ""))
        else:
            log(f"{name}: {len(found)} crops read back from {folder}")
        out[name] = found
        record[name] = {"crops": len(found), "indexSha256": _sha256(folder / INDEX_NAME)}
    return out[REAL_POSITIVES], out[REAL_NEGATIVES], {**record, "roots": {name: str(cache / name) for name in out}}


# ---------------------------------------------------------------------- composite crops
NOT_VISIBLE_ENOUGH = "less visible than min_visible"
TOO_SMALL = "short side under min_short_side"
TOO_TILTED = "further from a quarter turn than max_tilt"
IN_A_CLOSEUP = "in a close-up scene"


def quarter_turn_tilt(angle: float) -> float:
    """How far a direction, in degrees, lies from the nearest quarter turn: 0 to 45."""
    off = float(angle) % 90.0
    return min(off, 90.0 - off)


def composite_face_exclusion(item: Mapping[str, Any], *, min_visible: float = COMPOSITE_SELECTION["min_visible"],
                             min_short_side: float = COMPOSITE_SELECTION["min_short_side"],
                             max_tilt: float = COMPOSITE_SELECTION["max_tilt"]) -> str | None:
    """Why a positive, named face of a composite scene gives no crop, or ``None`` when it
    gives one.

    ``item`` is the face's object in the scene's labels. It gives a crop when its ``visible``
    share is at least ``min_visible``, its ``short`` side is at least ``min_short_side`` px,
    and its ``angle`` is at most ``max_tilt`` degrees from the nearest quarter turn. Each limit
    is inclusive; the first one that fails is the reason returned.
    """
    if item["visible"] < min_visible:
        return NOT_VISIBLE_ENOUGH
    if item["short"] < min_short_side:
        return TOO_SMALL
    if quarter_turn_tilt(item["angle"]) > max_tilt:
        return TOO_TILTED
    return None


def composite_crops(folder: str | Path, cache: Path, *, margin: float, log: Log,
                    min_visible: float = COMPOSITE_SELECTION["min_visible"],
                    min_short_side: float = COMPOSITE_SELECTION["min_short_side"],
                    max_tilt: float = COMPOSITE_SELECTION["max_tilt"]) -> tuple[list[Row], dict]:
    """Cut the face crops of a ``cardvision make-composites`` folder.

    **Which faces.** An object gives one crop when all of these hold:

    * its kind is ``face``, the scene's labels mark it ``positive`` (at least half visible,
      short side of 20 px or more) and it names a card (``cardId``);
    * its ``visible`` share is at least ``min_visible`` (0.90);
    * its short side, ``short``, is at least ``min_short_side`` px (48);
    * its ``angle``, the direction of the card's top in the image, is at most ``max_tilt``
      degrees (15) from the nearest quarter turn.

    The last three are the limits of ``[streams.composite_positives]``
    (``composite_face_exclusion``). They keep the faces a recognizer can be expected to name:
    nearly whole, not tiny, and nearly straight once turned upright by quarter turns.

    Close-up scenes (``layout`` ``"closeup"``, from ``make-composites --closeups``) give no
    crops: their cards are tilted 15 to 45 degrees out of the image plane, and an upright crop
    of such a card is not what the recognizer is trained to name. Their faces are counted as
    left out ``"in a close-up scene"``.

    **The crop.** The upright box around the object's four corners, widened by ``margin``
    times its width and height on each side, clipped to the image and cut to whole pixels,
    then turned by quarter turns so that the card's top edge (the first edge of ``corners``)
    is nearest the top. That is the rule ``cardvision.data.targets.margin_crop`` applies to
    real crops. ``inner`` is the upright box around the corners inside the turned crop, and
    ``group`` is ``"composites"``.
    """
    from cardvision.composites.dataset import LABELS_NAME, read_labels
    from cardvision.data import geometry
    from cardvision.data.targets import margin_crop

    folder = Path(folder)
    labels_sha = _sha256(folder / LABELS_NAME)
    selection = {"minVisible": min_visible, "minShortSidePx": min_short_side, "maxTiltDegrees": max_tilt}
    fingerprint = {"labels": labels_sha, "margin": margin, "selection": selection}
    found = _cached(cache, fingerprint)
    if found is not None:
        log(f"{COMPOSITE_POSITIVES}: {len(found)} crops read back from {cache}")
    else:
        tally: Counter = Counter()

        def items():
            for scene in read_labels(folder):
                if scene.get("layout") == "closeup":
                    tally[IN_A_CLOSEUP] += sum(o["kind"] == "face" and bool(o.get("positive")) and bool(o.get("cardId"))
                                               for o in scene["objects"])
                    continue
                faces = []
                for o in scene["objects"]:
                    if o["kind"] != "face" or not o.get("positive") or not o.get("cardId"):
                        continue
                    reason = composite_face_exclusion(o, min_visible=min_visible, min_short_side=min_short_side,
                                                      max_tilt=max_tilt)
                    if reason is None:
                        faces.append(o)
                    else:
                        tally[reason] += 1
                if not faces:
                    continue
                with Image.open(folder / scene["file"]) as image:
                    frame = np.asarray(image.convert("RGB"))
                for face in faces:
                    turns = geometry.quarter_turns(face["corners"])
                    crop, inner = margin_crop(frame, geometry.bounding_box(face["corners"]), margin, turns)
                    if crop.size == 0:
                        continue
                    height, width = crop.shape[:2]
                    inner = list(inner)
                    if inner[2] < 2 or inner[3] < 2:
                        continue
                    yield (f"{scene['index']:05d}-{face['id']}.png", crop,
                           {"inner": inner, "card_id": face["cardId"], "group": "composites", "turns": turns,
                            "hw": [height, width]})

        found = _write_cache(cache, fingerprint, items())
        log(f"{COMPOSITE_POSITIVES}: cut {len(found)} crops into {cache}"
            + (f" (positive faces left out: {dict(sorted(tally.items()))})" if tally else ""))
    return found, {"folder": str(folder), "labelsSha256": labels_sha, "selection": selection, "crops": len(found),
                   "indexSha256": _sha256(cache / INDEX_NAME)}


# ------------------------------------------------------------------------------ plug-ins
def _call_plugin(spec: str, context: SourceContext) -> Any:
    from cardvision.export.checkpoint import load_factory

    try:
        function = load_factory(spec)
    except ValueError as error:
        raise ConfigError(f"plug-in {spec!r}: {error}") from None
    return function(context)


def _check_rows(rows: Any, where: str) -> list[Row]:
    if not isinstance(rows, list):
        raise ConfigError(f"{where}: the rows must be a list")
    for position, row in enumerate(rows):
        if not isinstance(row, dict) or "inner" not in row or ("path" not in row and row.get("image") is None):
            raise ConfigError(f'{where}: row {position} needs "inner" and either "path" or "image"')
        if len(row["inner"]) != 4:
            raise ConfigError(f'{where}: row {position}: "inner" must be [x, y, width, height]')
        row.setdefault("card_id", None)
        row.setdefault("group", "")
    return rows


def _plugin_streams(specs: list[str], context: SourceContext) -> dict[str, tuple[str | None, list[Row]]]:
    out: dict[str, tuple[str | None, list[Row]]] = {}
    for spec in specs:
        result = _call_plugin(spec, context)
        if not isinstance(result, dict):
            raise ConfigError(f"plug-in {spec!r} must return a dictionary of stream name to rows")
        for name, value in result.items():
            root = None
            if isinstance(value, dict):
                root, value = value.get("root"), value.get("rows")
            if name in out:
                raise ConfigError(f"plug-in {spec!r}: stream {name!r} was already given by another plug-in")
            out[name] = (None if root is None else str(root), _check_rows(value, f"plug-in {spec!r}, stream {name!r}"))
    return out


def _validation_set(value: Any, where: str) -> ValidationSet:
    if not isinstance(value, dict):
        raise ConfigError(f'{where} must be {{"rows": [...], "root": ..., "bank": ...}}')
    root, bank = value.get("root"), value.get("bank")
    return ValidationSet(rows=_check_rows(value.get("rows"), where), root=None if root is None else str(root),
                         bank=None if bank is None else list(bank))


# ------------------------------------------------------------------------------ assembly
def _absolute(rows: list[Row], root: str | None) -> list[Row]:
    """Rows whose relative paths are joined to their stream's root, so that rows of several
    roots can share a list."""
    if root is None:
        return rows
    return [row if row.get("image") is not None or Path(row["path"]).is_absolute()
            else {**row, "path": str(Path(root) / row["path"])} for row in rows]


def build_sources(cfg: Mapping[str, Any], out_dir: str | Path, log: Log = print) -> Sources:
    """Read everything a config names and return the streams, the card images, the background
    patches and the two validation sets."""
    from cardvision.core.catalog import load_catalog
    from cardvision.core.preprocess import input_size

    out_dir = Path(out_dir)
    cache = out_dir / "cache"
    data, val = cfg["data"], cfg["validation"]
    notes: list[str] = []
    catalog = load_catalog(data["catalog"])
    inputs: dict[str, Any] = {"catalog": {"file": Path(data["catalog"]).name, "sha256": _sha256(data["catalog"])}}
    for key in ("kinds", "sources"):
        if data[key]:
            inputs[key] = {"file": Path(data[key]).name, "sha256": _sha256(data[key])}

    art = load_art(catalog, data["art"], input_size(cfg["contract"]))
    if not art:
        raise FileNotFoundError(f"{data['art']}: none of the catalog's {len(catalog)} card images is here")
    art_digest = hashlib.sha256()
    for card_id in sorted(art):
        art_digest.update(f"{card_id} {_sha256(catalog.art_location(card_id, data['art']))}\n".encode())
    inputs["art"] = {"cards": len(art), "missing": len(catalog) - len(art), "sha256": art_digest.hexdigest()}
    log(f"card images: {len(art)} of {len(catalog)} catalog cards")

    # The cards kept out of training.
    unseen = list(val["unseen_cards"])
    unknown = sorted(set(unseen) - set(catalog.ids()))
    if unknown:
        raise ConfigError(f"[validation] unseen_cards names {unknown[:5]}, not in the catalog")
    if val["unseen_pick"]:
        unseen = sorted(random.Random(cfg["data_seed"]).sample(sorted(art), min(val["unseen_pick"], len(art))))
    unseen_ids = frozenset(unseen)

    context = SourceContext(catalog=catalog, config=cfg, seed=cfg["seed"], data_seed=cfg["data_seed"],
                            unseen=unseen_ids, art_ids=frozenset(art), out_dir=out_dir)

    pools: dict[str, list[Row]] = {name: [] for name in BUILT_IN_STREAMS}
    pools[ART] = [{"image": None, "from_art": True, "inner": [0, 0, art[c].shape[1], art[c].shape[0]], "card_id": c,
                   "group": "art"} for c in sorted(art)]

    # Real crops, with whole recording groups held out for validation.
    held: list[str] = []
    seen_rows: list[Row] = []
    if data["manifests"]:
        positives, negatives, record = real_crops(
            data["manifests"], data["frames"], cache, margin=data["margin"], roles=data["roles"],
            sources_file=data["sources"], exclude_ids=unseen_ids, log=log)
        roots = record.pop("roots")
        inputs["real"] = record
        groups = sorted({row["group"] for row in positives})
        if val["groups"]:
            held = sorted(set(val["groups"]))
        else:
            order = list(groups)
            random.Random(cfg["data_seed"]).shuffle(order)
            held = sorted(order[: int(len(order) * val["group_share"])])
        held_set = set(held)
        positives = _absolute(positives, roots[REAL_POSITIVES])
        negatives = _absolute(negatives, roots[REAL_NEGATIVES])
        seen_rows = [row for row in positives if row["group"] in held_set]
        pools[REAL_POSITIVES] = [row for row in positives if row["group"] not in held_set]
        pools[REAL_NEGATIVES] = [row for row in negatives if row["group"] not in held_set]
        log(f"real crops: {len(groups)} recording groups, {len(held)} held out for validation "
            f"({len(seen_rows)} crops); {len(pools[REAL_POSITIVES])} positives and "
            f"{len(pools[REAL_NEGATIVES])} negatives to train on")

    # Composite crops: training cards to the stream, the cards kept out to validation.
    unseen_rows: list[Row] = []
    selection = {key: cfg["streams"][COMPOSITE_POSITIVES][key] for key in COMPOSITE_SELECTION}
    if data["composites"]:
        rows, record = composite_crops(data["composites"], cache / COMPOSITE_POSITIVES, margin=data["margin"], log=log,
                                       **selection)
        rows = _absolute(rows, str(cache / COMPOSITE_POSITIVES))
        inputs["composites"] = record
        pools[COMPOSITE_POSITIVES] = [row for row in rows if row["card_id"] not in unseen_ids]
        unseen_rows = [row for row in rows if row["card_id"] in unseen_ids]
    if val["composites"]:
        rows, record = composite_crops(val["composites"], cache / "validation-composites", margin=data["margin"], log=log,
                                       **selection)
        inputs["validationComposites"] = record
        unseen_rows = [row for row in _absolute(rows, str(cache / "validation-composites")) if row["card_id"] in unseen_ids]

    roots: dict[str, str | None] = {}
    for name, (root, rows) in _plugin_streams(data["extra_sources"], context).items():
        if name in BUILT_IN_STREAMS:
            pools[name] = pools[name] + _absolute(rows, root)
        else:
            pools[name], roots[name] = rows, root
        inputs.setdefault("extra", {})[name] = {"rows": len(rows), "sha256": _rows_digest(rows)}
        log(f"plug-in stream {name}: {len(rows)} rows")

    streams: dict[str, Stream] = {}
    for name, rows in pools.items():
        settings = cfg["streams"].get(name)
        if settings is None:
            raise ConfigError(f"stream {name!r} has rows but no [streams.{name}] table in the config")
        kept, dropped = [], Counter()
        for row in rows:
            card_id = row.get("card_id")
            if settings["negative"]:
                kept.append({**row, "card_id": None})
            elif card_id not in art:
                dropped["no card image"] += 1
            elif card_id in unseen_ids:
                dropped["kept out of training"] += 1
            else:
                kept.append(row)
        if dropped:
            notes.append(f"{name}: {sum(dropped.values())} rows dropped ({dict(dropped)})")
        streams[name] = Stream(name=name, rows=kept, chain=settings["chain"], negative=settings["negative"],
                               root=roots.get(name), surface_margin=float(settings.get("surface_margin", 0.0)))

    # Validation: the built-in sets, or a plug-in's.
    unseen_rows = [row for row in unseen_rows if row["card_id"] in art]
    random.Random(cfg["data_seed"]).shuffle(unseen_rows)
    seen = ValidationSet(rows=[row for row in seen_rows if row["card_id"] in art])
    unseen_set = ValidationSet(rows=unseen_rows[: val["unseen_count"]])
    if val["source"]:
        result = _call_plugin(val["source"], context)
        if not isinstance(result, dict) or set(result) != {"seen", "unseen"}:
            raise ConfigError(f'validation plug-in {val["source"]!r} must return {{"seen": ..., "unseen": ...}}')
        seen = _validation_set(result["seen"], "validation plug-in, seen")
        unseen_set = _validation_set(result["unseen"], "validation plug-in, unseen")
        inputs["validationPlugin"] = {"seen": {"rows": len(seen.rows), "sha256": _rows_digest(seen.rows)},
                                      "unseen": {"rows": len(unseen_set.rows), "sha256": _rows_digest(unseen_set.rows)}}

    spec = cfg["background_patches"]
    if spec.get("folder"):
        patches = load_background_patches(spec["folder"], spec["size"], spec["count"])
        inputs["backgroundPatches"] = background_patches_digest(spec["folder"])
    else:
        patches = make_background_patches(spec["count"], spec["size"], cfg["seed"], data["textures"],
                                          spec["texture_share"])
    if data["textures"]:
        inputs["textures"] = {"indexSha256": _sha256(Path(data["textures"]) / "index.json")}
    for note in notes:
        log(note)
    return Sources(catalog=catalog, art=art, streams=streams, patches=patches, seen=seen, unseen=unseen_set,
                   unseen_ids=sorted(unseen_ids), held_out_groups=held, inputs=inputs, notes=notes)
