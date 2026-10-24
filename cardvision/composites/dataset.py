# SPDX-License-Identifier: Apache-2.0
"""Write a set of generated scenes to a folder: images, labels and a manifest.

The folder gets::

    images/00000.jpg ...   one JPEG per scene, named by the scene's index
    labels.jsonl           one JSON object per scene, in index order
    manifest.json          what was run: seed, split, counts, every setting

The label format is described in ``cardvision.composites`` (the package docstring). Nothing in
these files depends on the clock, the machine or the number of worker processes: the same
catalog, card images, scans, seed, split, count and settings give the same bytes.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from cardvision.composites import closeup as C
from cardvision.composites import photometric as P
from cardvision.composites import scene as S
from cardvision.composites.board import DRAW_GROUPS
from cardvision.composites.broadcast import VARIANTS
from cardvision.composites.cards import CardPool
from cardvision.composites.geometry import CARD_ASPECT, check_aspect
from cardvision.composites.surfaces import SURFACE_FAMILIES
from cardvision.composites.textures import BG_WEIGHTS
from cardvision.core.catalog import Catalog

FORMAT = "cardvision-composites"
FORMAT_VERSION = 1
LABELS_NAME = "labels.jsonl"
MANIFEST_NAME = "manifest.json"
CHUNK = 50  # scenes handed to a worker process at a time

_worker: dict[str, Any] = {}


def read_labels(out_dir: str | Path) -> list[dict[str, Any]]:
    """The scene records of a generated folder, in index order."""
    text = (Path(out_dir) / LABELS_NAME).read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def _scene_line(pool: CardPool, out_dir: Path, split: str, index: int, seed: int, settings: S.Settings,
                card_aspect: float) -> str:
    record, jpeg = S.build_scene(pool, split, index, seed, settings, card_aspect)
    (out_dir / record["file"]).write_bytes(jpeg)
    return json.dumps(record)


def _start_worker(catalog, art_dir, textures_dir, split, kinds, settings, seed, out_dir, card_aspect) -> None:
    _worker.update(pool=CardPool(catalog, art_dir, textures_dir, split, kinds), split=split, settings=settings,
                   seed=seed, out_dir=Path(out_dir), card_aspect=card_aspect)


def _work(indices: list[int]) -> list[str]:
    w = _worker
    return [_scene_line(w["pool"], w["out_dir"], w["split"], index, w["seed"], w["settings"], w["card_aspect"])
            for index in indices]


def parameters(card_aspect: float = CARD_ASPECT, closeups: float = 0.0) -> dict[str, Any]:
    """The fixed numbers of the generator, as written into every manifest, with the run's
    upright card aspect (``cardAspect``) and, when the run draws close-ups, their share and
    ranges (``closeups``; absent when it draws none, so such a manifest is the one written
    before close-ups existed)."""
    out = {
        "resolutions": [list(size) for size in S.RESOLUTIONS],
        "cardAspect": card_aspect,
        "cardWidthPx": [S.SIZE_MIN, S.SIZE_MAX],
        "maxTiltDegrees": S.MAX_TILT,
        "visibleMin": S.VISIBLE_MIN,
        "shortSideMinPx": S.SHORT_MIN,
        "backgroundShare": dict(S.BACKGROUND_SHARE),
        "backgroundFamilies": dict(BG_WEIGHTS),
        "surfaceFamilies": dict(SURFACE_FAMILIES),
        "layoutShare": dict(S.LAYOUT_SHARE),
        "scatterShareWithoutBoards": S.SCATTER_SHARE_PLAIN,
        "broadcastShare": dict(S.BROADCAST_SHARE),
        "broadcastVariants": dict(VARIANTS),
        "boardCardPx": {name: list(span) for name, span in S.BOARD_CARD_PX.items()},
        "boardGroups": list(DRAW_GROUPS),
        "foilWithoutPhotometric": S.FOIL_PLAIN,
        "photometricBase": dict(P.BASE),
    }
    if closeups:
        out["closeups"] = {"share": closeups, "tiltDegrees": list(C.TILT), "cardHeightShare": list(C.HEIGHT_SHARE),
                           "pairShare": C.PAIR_SHARE, "focalOverWidth": list(C.FOCAL), "insideMin": C.INSIDE_MIN,
                           "glowShare": C.GLOW_SHARE}
    return out


class _Tally:
    """Counts over the scene records, kept as they are written."""

    def __init__(self) -> None:
        self.scenes = 0
        self.positive = 0
        self.kinds: Counter[str] = Counter()
        self.ignored: Counter[str] = Counter()
        self.layouts: Counter[str] = Counter()
        self.backgrounds: Counter[str] = Counter()
        self.variants: Counter[str] = Counter()
        self.cards: set[str] = set()

    def add(self, record: dict[str, Any]) -> None:
        self.scenes += 1
        self.layouts[record["layout"]] += 1
        self.backgrounds[record["background"]["family"]] += 1
        if record["broadcast"]:
            self.variants[record["broadcast"]["variant"]] += 1
        for o in record["objects"]:
            self.kinds[o["kind"]] += 1
            if o["kind"] == "face":
                self.cards.add(o["cardId"])
                self.positive += int(o["positive"])
                if o["ignore"]:
                    self.ignored[o["ignore"]] += 1

    def result(self) -> dict[str, Any]:
        return {
            "scenes": self.scenes,
            "objects": dict(sorted(self.kinds.items())),
            "positiveFaces": self.positive,
            "ignoredFaces": dict(sorted(self.ignored.items())),
            "distinctCards": len(self.cards),
            "layouts": dict(sorted(self.layouts.items())),
            "backgrounds": dict(sorted(self.backgrounds.items())),
            "broadcast": dict(sorted(self.variants.items())),
        }


def positive_cards(out_dir: str | Path) -> int:
    """How many different cards the positive faces of a folder of generated scenes show.

    A manifest's ``distinctCards`` counts the cards of every face, the ignored ones included,
    so it can be larger. The labels file is read once.
    """
    cards: set[str] = set()
    with open(Path(out_dir) / LABELS_NAME, encoding="utf-8") as handle:
        for line in handle:
            cards.update(o["cardId"] for o in json.loads(line)["objects"] if o["kind"] == "face" and o["positive"])
    return len(cards)


def generate(catalog: Catalog, art_dir: str | Path, out_dir: str | Path, n: int, seed: int = 0,
             split: str = "train", textures_dir: str | Path | None = None, settings: S.Settings | None = None,
             kinds: Mapping[str, Any] | None = None, workers: int = 1, overwrite: bool = False,
             progress: Callable[[int, int], None] | None = None, card_aspect: float = CARD_ASPECT) -> dict[str, Any]:
    """Generate scenes 0 to ``n - 1`` of a split into ``out_dir``. Returns the manifest.

    Args:
        catalog: the game's catalog.
        art_dir: the folder of card images that the catalog's ``art`` paths point into.
        out_dir: where to write. A folder that already holds labels is refused unless
            ``overwrite`` is set.
        n: how many scenes.
        seed: any non-negative integer. With the split and a scene's index it fixes the scene.
        split: ``"train"``, ``"val"`` or ``"probe"`` (card-free scenes).
        textures_dir: a folder from ``cardvision fetch-textures``; None for procedural
            backgrounds only.
        settings: the generator's switches (``scene.Settings``); the defaults when None.
        kinds: a ``kinds`` object to use in place of the catalog's.
        workers: processes to spread the scenes over. The output does not depend on it.
        progress: called with ``(scenes done, n)`` as the work goes on.
        card_aspect: width over height of an upright card of the game, from 0.5 to 1.0
            (``geometry.card_aspect`` makes it from a size in millimeters). It is recorded in the
            manifest as ``parameters.cardAspect``.
    """
    if split not in S.SPLITS:
        raise ValueError(f"split must be one of {list(S.SPLITS)}, not {split!r}")
    if not isinstance(n, int) or n < 1:
        raise ValueError("n must be a whole number of at least 1")
    if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0:
        raise ValueError("seed must be a non-negative whole number")
    if workers < 1:
        raise ValueError("workers must be at least 1")
    card_aspect = check_aspect(card_aspect)
    settings = settings if settings is not None else S.Settings()
    out_dir = Path(out_dir)
    labels_path, manifest_path = out_dir / LABELS_NAME, out_dir / MANIFEST_NAME
    if not overwrite and (labels_path.exists() or manifest_path.exists()):
        raise FileExistsError(f"{out_dir} already holds generated scenes (pass overwrite to replace them)")
    pool = CardPool(catalog, art_dir, textures_dir, split, kinds)
    background = S.background_mode(settings, pool)  # also refuses a scan mode with no scans
    (out_dir / "images").mkdir(parents=True, exist_ok=True)

    chunks = [list(range(lo, min(lo + CHUNK, n))) for lo in range(0, n, CHUNK)]
    digest = hashlib.sha256()
    tally = _Tally()

    def keep(lines: list[str], handle) -> None:
        for line in lines:
            data = (line + "\n").encode("utf-8")
            handle.write(data)
            digest.update(data)
            tally.add(json.loads(line))
        if progress is not None:
            progress(tally.scenes, n)

    with open(labels_path, "wb") as handle:
        if workers == 1:
            for chunk in chunks:
                for index in chunk:
                    keep([_scene_line(pool, out_dir, split, index, seed, settings, card_aspect)], handle)
        else:
            import multiprocessing

            start = (catalog, str(art_dir), None if textures_dir is None else str(textures_dir), split, kinds,
                     settings, seed, str(out_dir), card_aspect)
            with multiprocessing.get_context("spawn").Pool(workers, _start_worker, start) as processes:
                for lines in processes.imap(_work, chunks):
                    keep(lines, handle)

    resolved = settings.to_json()
    resolved["background"] = background
    manifest = {
        "format": FORMAT,
        "formatVersion": FORMAT_VERSION,
        "split": split,
        "seed": seed,
        "scenes": n,
        "images": "images",
        "labels": LABELS_NAME,
        "labelsSha256": digest.hexdigest(),
        "catalog": {"game": catalog.game, "locale": catalog.locale, "cards": len(catalog),
                    "cardsWithArt": len(pool.ids), "cardsWithoutArt": len(pool.missing)},
        "kinds": pool.kinds.to_json(),
        "textures": None if textures_dir is None else {"scans": len(pool.textures),
                                                       "surfaceLike": len(pool.surfaces)},
        "settings": resolved,
        "parameters": parameters(card_aspect, settings.closeups),
        "counts": tally.result(),
    }
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    return manifest
