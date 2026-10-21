# SPDX-License-Identifier: Apache-2.0
"""The cards a scene is built from: faces from a folder of card images, and generated backs.

Nothing else supplies a card. A face is the image the catalog names for a card id, read from
the art folder; a card back is drawn by ``textures.generated_back`` and is no real card back.

How a game's card kinds are treated comes from the catalog's ``kinds`` object. The scene
generator reads four of its keys (all optional)::

    "kinds": {
      "landscape": ["site"],
      "foilProbability": {"leader": 0.6},
      "dice": ["leader"],
      "board": {"leader": "leader", "unit": "unit", "attachment": "item", "resource": "token"}
    }

``landscape``
    The kinds printed sideways. On a game board these cards fill the center-line slots. (How a
    card is sized follows its image: one wider than tall gets the short side of an upright
    card.)
``foilProbability``
    Kind name to the probability that a face of that kind is foil. Other kinds use the
    photometric setting's ``foil_default``.
``dice``
    The kinds that carry dice or counters in play. Half of such faces in loose and tabled
    layouts get a die painted over the art, and on a game board dice may rest on the leader
    slot's card when the leader's kind is one of these.
``board``
    Which kind (a name, or a list of names) fills each group of slots on a game board:
    ``leader``, ``unit``, ``attachment`` and ``resource``. A group left out, or one with no
    card images, is filled from all cards.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from PIL import Image

from cardvision.composites import textures as T
from cardvision.composites.geometry import CARD_ASPECT
from cardvision.composites.surfaces import is_surface, load_texture_index
from cardvision.core.catalog import Catalog, is_url

BOARD_GROUPS = ("leader", "unit", "attachment", "resource")

# Faces are kept at this width unless a scene needs more pixels than that.
SMALL_ART_WIDTH = 288
LARGE_ART_ABOVE = 360


def _is_text(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _is_probability(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1


@dataclass(frozen=True)
class KindSettings:
    """The parts of a catalog's ``kinds`` object that the scene generator reads."""

    landscape: tuple[str, ...] = ()
    foil: Mapping[str, float] = field(default_factory=dict)
    dice: tuple[str, ...] = ()
    board: Mapping[str, tuple[str, ...]] = field(default_factory=dict)

    @classmethod
    def from_kinds(cls, kinds: Mapping[str, Any] | None) -> KindSettings:
        """Check and read a ``kinds`` object. Keys this module does not know are ignored."""
        kinds = {} if kinds is None else kinds
        if not isinstance(kinds, Mapping):
            raise ValueError('"kinds" must be an object')
        landscape = kinds.get("landscape", [])
        if not isinstance(landscape, list) or not all(_is_text(kind) for kind in landscape):
            raise ValueError('"kinds.landscape" must be a list of kind names')
        foil = kinds.get("foilProbability", {})
        if not isinstance(foil, Mapping) or not all(_is_text(k) and _is_probability(p) for k, p in foil.items()):
            raise ValueError('"kinds.foilProbability" must map kind names to probabilities from 0 to 1')
        dice = kinds.get("dice", [])
        if not isinstance(dice, list) or not all(_is_text(kind) for kind in dice):
            raise ValueError('"kinds.dice" must be a list of kind names')
        board = kinds.get("board", {})
        if not isinstance(board, Mapping):
            raise ValueError(f'"kinds.board" must be an object with keys from {list(BOARD_GROUPS)}')
        unknown = sorted(set(board) - set(BOARD_GROUPS))
        if unknown:
            raise ValueError(f'"kinds.board" has unknown key(s) {unknown} (expected some of {list(BOARD_GROUPS)})')
        groups: dict[str, tuple[str, ...]] = {}
        for group, value in board.items():
            names = [value] if isinstance(value, str) else value
            if not isinstance(names, list) or not names or not all(_is_text(kind) for kind in names):
                raise ValueError(f'"kinds.board.{group}" must be a kind name or a list of kind names')
            groups[group] = tuple(names)
        return cls(tuple(landscape), dict(foil), tuple(dice), groups)

    def to_json(self) -> dict[str, Any]:
        """The settings as a ``kinds`` object."""
        return {"landscape": list(self.landscape), "foilProbability": dict(self.foil), "dice": list(self.dice),
                "board": {group: list(names) for group, names in self.board.items()}}


def load_kinds(path: str | Path) -> dict[str, Any]:
    """Read a ``kinds`` object from a JSON file that holds either the object itself or an
    object with it under the key ``"kinds"``."""
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(doc, dict) and isinstance(doc.get("kinds"), dict):
        doc = doc["kinds"]
    KindSettings.from_kinds(doc)
    return doc


class CardPool:
    """Everything a scene draws cards and scanned backgrounds from.

    Args:
        catalog: the game's catalog.
        art_dir: the folder its ``art`` paths are resolved against. Cards whose image is not
            in it are left out (``missing`` lists them); an ``art`` that is a URL counts as
            missing, since nothing is downloaded, and so does a card without art
            (``"art": null``), which ``no_art`` also lists.
        textures_dir: a folder written by ``cardvision fetch-textures``, or None for
            procedural backgrounds only.
        split: ``"train"``, ``"val"`` or ``"probe"``. It selects the scans: validation scenes
            use the scans marked ``val`` and the others those marked ``train``.
        kinds: a ``kinds`` object to use in place of the catalog's.
    """

    def __init__(self, catalog: Catalog, art_dir: str | Path, textures_dir: str | Path | None = None,
                 split: str = "train", kinds: Mapping[str, Any] | None = None) -> None:
        self.kinds = KindSettings.from_kinds(catalog.kinds if kinds is None else kinds)
        self.art_dir = Path(art_dir)
        self._kind = {card.id: card.kind for card in catalog}
        self._path: dict[str, Path] = {}
        self.missing: list[str] = []
        self.no_art: list[str] = catalog.ids_without_art()
        for card in catalog:
            path = (None if not card.has_art or is_url(card.art)
                    else Path(catalog.art_location(card.id, self.art_dir)))
            if path is not None and path.is_file():
                self._path[card.id] = path
            else:
                self.missing.append(card.id)
        self.ids = sorted(self._path)
        if not self.ids:
            raise FileNotFoundError(f"{self.art_dir}: none of the catalog's {len(catalog)} card images is here"
                                    + (f" ({len(self.no_art)} of the cards have no art)" if self.no_art else ""))
        groups = {**self.kinds.board, "site": self.kinds.landscape}
        self._groups = {group: [cid for cid in self.ids if self._kind[cid] in names]
                        for group, names in groups.items()}
        self.leader_dice = any(kind in self.kinds.dice for kind in self.kinds.board.get("leader", ()))

        self.textures_dir = None if textures_dir is None else Path(textures_dir)
        self.textures: list[dict[str, Any]] = []
        self.surfaces: list[dict[str, Any]] = []
        if self.textures_dir is not None:
            wanted = "val" if split == "val" else "train"
            self.textures = [r for r in load_texture_index(self.textures_dir) if r["split"] == wanted]
            self.surfaces = [r for r in self.textures if is_surface(r.get("category"), r["assetId"])]
        self._art = lru_cache(maxsize=256)(self._read_art)

    def _read_art(self, card_id: str, large: bool) -> Image.Image:
        im = Image.open(self._path[card_id]).convert("RGB")
        if not large:
            im = im.resize((SMALL_ART_WIDTH, int(round(SMALL_ART_WIDTH * im.height / im.width))), Image.LANCZOS)
        return im

    def kind_of(self, card_id: str | None) -> str | None:
        """A card's kind (None for a card back)."""
        return None if card_id is None else self._kind.get(card_id)

    def carries_dice(self, kind: str | None) -> bool:
        """Whether cards of this kind carry dice."""
        return kind in self.kinds.dice

    def group_ids(self, group: str | None) -> list[str]:
        """The card ids that may fill a board slot of this group: the group's own when it has
        any, otherwise every card."""
        return self._groups.get(group) or self.ids

    def face(self, rng, target_long: float, group: str | None = None):
        """A card face for a slot. ``target_long`` is the long side it will have in the image,
        in px, and picks between the small and the full-size copy of the image.
        Returns ``(RGB image, card id, "art")``."""
        ids = self.group_ids(group)
        cid = ids[int(rng.integers(0, len(ids)))]
        return self._art(cid, target_long > LARGE_ART_ABOVE), cid, "art"

    def inset_art(self, rng):
        """A full-size card image for a featured card. Returns ``(RGB image, card id)``."""
        cid = self.ids[int(rng.integers(0, len(self.ids)))]
        return self._art(cid, True), cid

    def back(self, rng, card_aspect=CARD_ASPECT):
        """A generated card back of upright aspect ``card_aspect``. Returns
        ``(RGBA image, "generated-back")``."""
        return T.generated_back(rng, card_aspect=card_aspect), "generated-back"
