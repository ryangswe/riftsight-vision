# SPDX-License-Identifier: Apache-2.0
"""The catalog: the one file a game supplies to describe its cards.

Shape of the file (JSON)::

    {
      "game": "toy",
      "locale": "en",
      "identity": "name",
      "cards": [
        {"id": "TOY-001", "name": "Amber Kite", "kind": "unit", "printingOf": null,
         "art": "TOY-001.png"},
        {"id": "TOY-T01", "name": "Plum Sprite", "kind": "unit", "printingOf": null,
         "art": "TOY-T01.png", "token": true}
      ],
      "kinds": {
        "landscape": ["site"],
        "foilProbability": {"unit": 0.1},
        "dice": ["leader"],
        "board": {"leader": "leader", "unit": "unit", "attachment": "item", "resource": "gem"},
        "boost": {"shareKind": "site", "share": 0.1}
      }
    }

* ``id`` is unique and is what every tool reports. It is 1 to 64 characters with no space or other
  whitespace and no control character anywhere in it, the rule a label manifest holds its card
  ids to.
* ``name`` is the card's name. Names are compared as exact strings.
* ``kind`` is a free label for the card's type, or null. ``kinds`` (optional, below) attaches
  settings to those labels.
* ``printingOf`` is the id of the card this one is an alternate printing of, or null.
* ``art`` locates the card image: an ``http(s)`` URL, or a file path relative to a folder or URL
  base that the caller supplies when resolving it. Nothing here opens a file or a connection
  other than the catalog file itself. ``"art": null`` marks a *card without art*: a card known
  by its id and name that has no image anywhere yet, such as a promotional card or one revealed
  before its release (below). The key itself is required, so a card that leaves it out is
  still an error.
* ``token`` (optional, true or false) marks a card that is made during play and is in no deck.
  It is recognized like any other card; the labeling tool lists such cards in a table of
  their own, since no deck list names them.

* ``facets`` (optional) gives the card's value for some of the facets the catalog declares
  (below): ``{"color": ["Red", "Blue"], "cost": 3, "set": "OGN"}``.
* ``extra`` (optional) is a JSON object of anything else a game wants to keep with the card:
  its rules text, its rarity, an upstream id. Its keys and values are free. Nothing in this
  package reads it: not detection, recognition, bank building, identity groups nor the hover
  rule. It is kept as it is, and a release pins the catalog file with it. A value that is not
  an object is an error.

``kind`` and ``printingOf`` may be left out, which means null, ``token``, which means false, and
``extra``, which means an empty object.
``identity`` may be left out, which means ``"name"``. Any other missing or unknown key, in a
card or at the top level, is an error, so that a misspelled key cannot be silently ignored.

Cards without art
-----------------

A card without art (``"art": null``) is a card like any other: it has an identity, it can be a
printing of another card or have printings of its own, and a label may name it. Only what needs
its image leaves it out: a bank built from this catalog has no row for it (``build-bank`` says
how many such cards there are; a bank extended from one that had a row for it keeps that row
and lists it), ``make-composites`` and the recognizer trainer draw no picture of it, and
``check-bank-art`` lists it apart from the cards whose image is missing. The card is then
never named by its own row; a printing of it that has art still names its identity. A labeled
box that names it is scored like any other: right when a printing of its identity is shown,
and otherwise as a card the recognizer cannot know. When its image appears, give the card its
``art`` and extend the bank.

Identity
--------

Identity says which entries count as the same card: a match that names one of them for another
is right, and a close score between two of them is not doubt. The optional top-level
``identity`` states the game's rule:

``"name"`` (the default)
    Entries with exactly the same ``name`` are one identity. This fits a game where a name is
    one card and its printings differ only in their picture. ``printingOf`` does not enter the
    rule; it marks the alternate printings for the tools that generate training rows.
``"printing"``
    An entry whose ``printingOf`` is null is a card of its own, and every entry whose
    ``printingOf`` is that entry's id is the same card. Two entries with the same name are
    different cards unless ``printingOf`` joins them. This fits a game where different cards
    share a name. Under this rule ``printingOf`` must point at an entry whose own
    ``printingOf`` is null: a printing of a printing is refused.

The rule is read in one place, ``Catalog.identity_of``. Everything that needs to know
whether two cards are the same asks the catalog (``identity_of``, ``same_identity``,
``identities``, ``identity_groups``), so one rule holds for the bank's identity groups, the
accept rule's margin, every measure and the recognizer's training.

Facets
------

Facets are the properties a person filters cards by when naming one in the labeling tool:
color, cost, set and the like. They are optional, and nothing but the labeling tool reads them.
The card's ``kind`` is always the first filter (labelled "Type"); the top-level ``facets`` list
declares the others, in the order their filters are shown::

    "facets": [
      {"key": "color", "label": "Color", "values": ["Red", "Blue", "Green"]},
      {"key": "cost", "label": "Cost", "type": "number"},
      {"key": "set", "label": "Set"}
    ]

``key`` matches ``^[a-z][a-zA-Z0-9]*$``, is unique and is not ``kind``. ``label`` is the
filter's name on screen. ``type`` (optional) is ``"text"`` or ``"number"``; without it the
type is that of the facet's first value. ``values`` (optional) fixes the allowed values and
their order; without it the values are those the cards carry, numbers in ascending order and
text in order of first appearance. Each card gives a facet one value or a list of values (a
card of two colors lists both), a string or a number of the facet's type. A key the catalog
does not declare, a value of the other type, a value outside the declared ``values`` and a
value listed twice are errors.

The ``kinds`` object
--------------------

``kinds`` says how the game's card kinds are treated by the tools that generate or augment
training images. Every key is optional. These are the keys the tools read:

``landscape``
    A list of kind names: the kinds printed sideways, wider than tall when upright. Read by
    the scene generator (``cardvision.composites``), where such cards fill a board's
    center-line slots, and by the labeling tool, which uses a landscape card's proportions.
``foilProbability``
    Kind name to a probability from 0 to 1: how often a generated face of that kind is given a
    foil finish. Read by the scene generator and by the recognizer trainer's physical
    augmentation (``cardvision.augment``). A kind not listed uses the tool's own default.
``dice``
    A list of kind names: the kinds that carry dice or counters in play. Read by the scene
    generator and the physical augmentation, which paint a die over some faces of these kinds.
``board``
    An object naming which kind (one name, or a list of names) fills each group of slots on a
    generated game board. Read by the scene generator, which defines the group names:
    ``leader``, ``unit``, ``attachment`` and ``resource``.
``boost``
    ``{"shareKind": kind, "share": fraction}``: the recognizer trainer adds rows of that kind
    until it makes up that share of the positive rows, when its config turns the boost on and
    states no kind and share of its own.

This module checks the shape of those five and passes any other key through untouched, for
tools outside this package. ``make-composites --kinds FILE`` and the recognizer trainer's
``[data] kinds`` take a file whose ``kinds`` object replaces the catalog's for one run.
"""

from __future__ import annotations

import copy
import json
import math
import re
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any
from urllib.parse import quote

_TOP_KEYS = {"game", "locale", "identity", "cards", "kinds", "facets"}
_CARD_REQUIRED = ("id", "name", "art")
_CARD_KEYS = {"id", "name", "kind", "printingOf", "art", "token", "facets", "extra"}

# Facets (see "Facets" in the module docstring): a facet's key, the keys of a declaration and
# the two value types. ``kind`` is not a facet key: the card's kind is always the first filter.
FACET_KEY_PATTERN = r"^[a-z][a-zA-Z0-9]*$"
_FACET_KEY = re.compile(FACET_KEY_PATTERN)
_FACET_DECL_KEYS = {"key", "label", "values", "type"}
FACET_TYPES = ("text", "number")

# A card id is whatever its catalog calls the card, so the rule is a loose one: nowhere in it a
# space, a line break, or any other whitespace or control character. The label-manifest format
# (``cardvision.data.schema``, data/SCHEMA.md) holds ``card_id`` to the same rule.
CARD_ID_PATTERN = r"^[^\s\u0000-\u001f\u007f-\u009f\ufeff]+$"
CARD_ID_MAX_LENGTH = 64
_CARD_ID = re.compile(CARD_ID_PATTERN)

# The identity rules a catalog can state (see "Identity" in the module docstring).
IDENTITY_NAME = "name"
IDENTITY_PRINTING = "printing"
IDENTITY_RULES = (IDENTITY_NAME, IDENTITY_PRINTING)
# How a report's definitions are to be read under a rule other than the default one. They
# speak of a card's name, which is its identity only under "name".
IDENTITY_DEFINITION = (
    'identity: by the catalog\'s rule, "the labeled card\'s name", "that name" and "another name" in these '
    "definitions stand for the labeled card's identity: the card and its printings. A different card that has the "
    "same name is another card here, and a wrong answer"
)
# Each rule in a sentence, as the reports state it.
IDENTITY_DESCRIPTIONS = {
    IDENTITY_NAME: "printings that share a catalog name are one identity",
    IDENTITY_PRINTING: 'a card and the entries whose "printingOf" names it are one identity, and cards that only '
                       'share a name are different cards (the catalog states "identity": "printing")',
}


class CatalogError(ValueError):
    """The catalog does not have the documented shape. The message says where."""


class NoArtError(ValueError):
    """A card's image was asked for, and the card is one without art (``"art": null``)."""


@dataclass(frozen=True)
class Card:
    """One catalog entry. ``facets`` maps a facet key to the card's values for it (a tuple, one
    value or several); a facet the card does not carry is absent. ``extra`` is the card's
    ``extra`` object as the file gives it (empty when it has none); nothing here reads it."""

    id: str
    name: str
    kind: str | None
    printing_of: str | None
    art: str | None
    token: bool = False
    facets: Mapping[str, tuple[str | float, ...]] = field(default_factory=dict, hash=False)
    extra: Mapping[str, Any] = field(default_factory=dict, hash=False)

    @property
    def has_art(self) -> bool:
        """Whether the card has an image (``art`` is not null)."""
        return self.art is not None


@dataclass(frozen=True)
class Facet:
    """One facet the catalog declares: its key, its label, its type (``"text"`` or
    ``"number"``) and its values in chip order (the declared ``values``, or else the values the
    cards carry: numbers in ascending order, text in order of first appearance)."""

    key: str
    label: str
    type: str
    values: tuple[str | float, ...]


def is_url(text: str) -> bool:
    """Whether ``text`` is an ``http`` or ``https`` URL."""
    return text.lower().startswith(("http://", "https://"))


def resolve_art(art: str, base: str | Path | None = None) -> str:
    """Where a card's image is: a URL or a local path, as a string.

    An ``art`` that is already a URL is returned unchanged. Otherwise it is joined to ``base``,
    which is either a URL prefix (the path is percent-encoded and appended) or a local folder.
    Nothing is fetched or checked for existence.
    """
    if is_url(art):
        return art
    if base is None:
        raise ValueError(f"art {art!r} is a relative path: a folder or URL base is needed to resolve it")
    if isinstance(base, str) and is_url(base):
        return base.rstrip("/") + "/" + quote(art)
    return str(Path(base) / art)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_text(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _art_problem(art: Any) -> str | None:
    if art is None:
        return None  # a card without art
    if not _is_text(art):
        return '"art" must be a non-empty string (a file path or an http(s) URL), or null for a card without art'
    if is_url(art):
        return None
    if "://" in art:
        return f'"art" {art!r} uses an unsupported URL scheme (only http and https are accepted)'
    if "\\" in art:
        return f'"art" {art!r} must use forward slashes'
    if PurePosixPath(art).is_absolute() or PureWindowsPath(art).is_absolute() or PureWindowsPath(art).drive:
        return f'"art" {art!r} must be a relative path or an http(s) URL'
    if ".." in PurePosixPath(art).parts:
        return f'"art" {art!r} must not contain ".."'
    return None


def _check_kinds(kinds: Any, source: str) -> dict[str, Any]:
    if not isinstance(kinds, dict):
        raise CatalogError(f'{source}: "kinds" must be an object')
    landscape = kinds.get("landscape", [])
    if not isinstance(landscape, list) or not all(_is_text(kind) for kind in landscape):
        raise CatalogError(f'{source}: "kinds.landscape" must be a list of kind names')
    foil = kinds.get("foilProbability", {})
    if not isinstance(foil, dict):
        raise CatalogError(f'{source}: "kinds.foilProbability" must be an object of kind name to probability')
    for kind, probability in foil.items():
        if not _is_number(probability) or not 0 <= probability <= 1:
            raise CatalogError(
                f'{source}: "kinds.foilProbability" for kind {kind!r} must be a number from 0 to 1'
            )
    dice = kinds.get("dice", [])
    if not isinstance(dice, list) or not all(_is_text(kind) for kind in dice):
        raise CatalogError(f'{source}: "kinds.dice" must be a list of kind names')
    board = kinds.get("board", {})
    if not isinstance(board, dict):
        raise CatalogError(f'{source}: "kinds.board" must be an object of slot group to kind name(s)')
    for group, value in board.items():
        names = [value] if isinstance(value, str) else value
        if not isinstance(names, list) or not names or not all(_is_text(kind) for kind in names):
            raise CatalogError(f'{source}: "kinds.board.{group}" must be a kind name or a list of kind names')
    if "boost" in kinds:
        boost = kinds["boost"]
        if not isinstance(boost, dict) or set(boost) != {"shareKind", "share"}:
            raise CatalogError(f'{source}: "kinds.boost" must be an object with exactly "shareKind" and "share"')
        if not _is_text(boost["shareKind"]):
            raise CatalogError(f'{source}: "kinds.boost.shareKind" must be a kind name')
        if not _is_number(boost["share"]) or not 0 <= boost["share"] <= 1:
            raise CatalogError(f'{source}: "kinds.boost.share" must be a number from 0 to 1')
    return copy.deepcopy(kinds)


def _facet_value_ok(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip() != ""
    if not _is_number(value):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:  # an integer too large for a float
        return False


def _facet_type(value: Any) -> str:
    return "text" if isinstance(value, str) else "number"


def _check_facet_values(values: list, kind: str | None, what: str) -> str:
    """The type of a list of facet values (``kind`` when given), or a CatalogError naming
    ``what``: every value text or every value a number, none empty and none twice."""
    for position, value in enumerate(values):
        if not _facet_value_ok(value):
            raise CatalogError(f"{what}: {value!r} is not a facet value (a non-empty string or a number)")
        kind = kind or _facet_type(value)
        if _facet_type(value) != kind:
            raise CatalogError(f"{what}: {value!r} is not {'text' if kind == 'text' else 'a number'}, "
                               f"and the facet's values are {'text' if kind == 'text' else 'numbers'}")
        if value in values[:position]:
            raise CatalogError(f"{what}: {value!r} is listed twice")
    return kind


def _check_facets(decls: Any, source: str) -> list[dict]:
    """The declared facets, each as {key, label, type (or None), values (or None)}."""
    if not isinstance(decls, list):
        raise CatalogError(f'{source}: "facets" must be a list of objects, each with a "key" and a "label"')
    out: list[dict] = []
    for position, decl in enumerate(decls):
        where = f"{source}: facets[{position}]"
        if not isinstance(decl, dict) or "key" not in decl or "label" not in decl:
            raise CatalogError(f'{where} must be an object with a "key" and a "label"')
        unknown = sorted(set(decl) - _FACET_DECL_KEYS)
        if unknown:
            raise CatalogError(f"{where}: unknown key(s) {unknown} (expected {sorted(_FACET_DECL_KEYS)})")
        key = decl["key"]
        if not isinstance(key, str) or not _FACET_KEY.fullmatch(key):
            raise CatalogError(f'{where}: "key" {key!r} must be a lowercase letter, then letters and digits only')
        if key == "kind":
            raise CatalogError(f'{where}: "key" "kind" is reserved: the card\'s kind is always the first filter')
        for earlier, other in enumerate(out):
            if other["key"] == key:
                raise CatalogError(f"{where}: duplicate key {key!r}, first used by facets[{earlier}]")
        if not _is_text(decl["label"]):
            raise CatalogError(f'{where} ({key!r}): "label" must be a non-empty string')
        kind = decl.get("type")
        if "type" in decl and kind not in FACET_TYPES:
            raise CatalogError(f'{where} ({key!r}): "type" must be "text" or "number", not {kind!r}')
        values = decl.get("values")
        if "values" in decl:
            if not isinstance(values, list) or not values:
                raise CatalogError(f'{where} ({key!r}): "values" must be a non-empty list')
            kind = _check_facet_values(values, kind, f"{where} ({key!r}) values")
        out.append({"key": key, "label": decl["label"], "type": kind, "values": values})
    return out


def _card_facets(raw: Any, decls: list[dict], where: str) -> dict[str, tuple]:
    """A card's ``facets``, each value list as a tuple; ``decls`` gain the type of the first
    value of an untyped facet."""
    if not isinstance(raw, dict):
        raise CatalogError(f'{where}: "facets" must be an object of facet key to a value or a list of values')
    by_key = {decl["key"]: decl for decl in decls}
    out: dict[str, tuple] = {}
    for key, value in raw.items():
        decl = by_key.get(key)
        if decl is None:
            raise CatalogError(f"{where}: facets.{key}: the catalog declares no facet {key!r}")
        values = value if isinstance(value, list) else [value]
        if not values:
            raise CatalogError(f'{where}: facets.{key} is an empty list (leave the key out instead)')
        decl["type"] = _check_facet_values(values, decl["type"], f"{where}: facets.{key}")
        if decl["values"] is not None:
            for item in values:
                if item not in decl["values"]:
                    raise CatalogError(f"{where}: facets.{key}: {item!r} is not one of the declared values")
        out[key] = tuple(values)
    return out


def _resolve_facets(decls: list[dict], cards: list[Card]) -> tuple[Facet, ...]:
    out = []
    for decl in decls:
        if decl["values"] is not None:
            values = list(decl["values"])
        else:
            values = []
            for card in cards:
                for value in card.facets.get(decl["key"], ()):
                    if value not in values:
                        values.append(value)
            if decl["type"] == "number":
                values.sort()
        out.append(Facet(decl["key"], decl["label"], decl["type"] or "text", tuple(values)))
    return tuple(out)


class Catalog:
    """A validated catalog. Build one with ``load_catalog`` or ``parse_catalog``.

    Attributes:
        game: the game's name.
        locale: the language of the card names, for example ``"en"``.
        cards: the entries, in file order.
        kinds: the optional ``kinds`` object (empty when the file has none).
        identity: the identity rule the file states, ``"name"`` or ``"printing"`` (``"name"``
            when it states none).
        identity_description: that rule in a sentence, as the reports state it.
        facets: the declared facets (``Facet``), in file order (empty when the file has none).
    """

    def __init__(self, game: str, locale: str, cards: tuple[Card, ...], kinds: Mapping[str, Any],
                 identity: str = IDENTITY_NAME, facets: Iterable[Facet] = ()) -> None:
        if identity not in IDENTITY_RULES:
            raise ValueError(f"unknown identity rule {identity!r}; expected one of {list(IDENTITY_RULES)}")
        self.game = game
        self.locale = locale
        self.cards = tuple(cards)
        self.kinds = dict(kinds)
        self.identity = identity
        self.identity_description = IDENTITY_DESCRIPTIONS[identity]
        self.facets = tuple(facets)
        self._by_id = {card.id: card for card in self.cards}
        by_name: dict[str, list[str]] = {}
        for card in self.cards:
            by_name.setdefault(card.name, []).append(card.id)
        self._by_name = {name: tuple(ids) for name, ids in by_name.items()}

    def __len__(self) -> int:
        return len(self.cards)

    def __iter__(self) -> Iterator[Card]:
        return iter(self.cards)

    def __contains__(self, card_id: object) -> bool:
        return card_id in self._by_id

    def card(self, card_id: str) -> Card:
        """The entry for an id. Raises ``KeyError`` naming the id when there is none."""
        try:
            return self._by_id[card_id]
        except KeyError:
            raise KeyError(f"no card {card_id!r} in the {self.game} catalog") from None

    def ids(self) -> list[str]:
        """Every card id, in file order."""
        return [card.id for card in self.cards]

    def ids_with_art(self) -> list[str]:
        """The ids of the cards that have an image, in file order."""
        return [card.id for card in self.cards if card.has_art]

    def ids_without_art(self) -> list[str]:
        """The ids of the cards without art (``"art": null``), in file order."""
        return [card.id for card in self.cards if not card.has_art]

    def token_ids(self) -> list[str]:
        """The ids of the cards marked ``token``, in file order."""
        return [card.id for card in self.cards if card.token]

    def name_of(self, card_id: str) -> str:
        """The name of a card."""
        return self.card(card_id).name

    def names(self) -> dict[str, str]:
        """Card id to name, for every card."""
        return {card.id: card.name for card in self.cards}

    def ids_named(self, name: str) -> tuple[str, ...]:
        """The ids of every printing with exactly this name, in file order (empty if none)."""
        return self._by_name.get(name, ())

    def ids_by_name(self) -> dict[str, tuple[str, ...]]:
        """Name to the ids of the entries with that name. Under the ``"name"`` rule each name
        is one identity."""
        return dict(self._by_name)

    def identity_of(self, card_id: str) -> str:
        """The identity a card belongs to, as a key: two cards are the same card exactly when
        their keys are equal.

        This is the one place the identity rule is read. Under ``"name"`` the key is the
        card's name. Under ``"printing"`` it is the id of the entry the card is a printing of,
        or its own id when it is a printing of none. Keys of two catalogs can be compared
        when the catalogs state the same rule and agree on the cards they share.
        """
        card = self.card(card_id)
        if self.identity == IDENTITY_PRINTING:
            return card.id if card.printing_of is None else card.printing_of
        return card.name

    def identities(self) -> dict[str, str]:
        """Card id to identity key (``identity_of``), for every card."""
        return {card.id: self.identity_of(card.id) for card in self.cards}

    def same_identity(self, a: str, b: str) -> bool:
        """Whether two card ids are the same card under the catalog's identity rule."""
        return self.identity_of(a) == self.identity_of(b)

    def identity_groups(self, ids: Iterable[str] | None = None) -> list[list[str]]:
        """The identities that hold two or more of ``ids`` (every card when omitted).

        Each group is sorted, and the list is ordered by each group's first id. Repeated ids
        count once. An id the catalog does not hold raises ``KeyError``.
        """
        wanted = self.ids() if ids is None else ids
        return groups_by_key(wanted, {card_id: self.identity_of(card_id) for card_id in set(wanted)})

    def identity_anchors(self) -> frozenset[str]:
        """The ids that stand for their identity because the catalog says so: under
        ``"printing"``, the entries that are a printing of none. Under ``"name"`` no entry is
        marked, and the set is empty. A bank's identity groups take their representatives from
        this set where they can (``cardvision.core.bank.IdentityGroups``).
        """
        if self.identity != IDENTITY_PRINTING:
            return frozenset()
        return frozenset(card.id for card in self.cards if card.printing_of is None)

    def art_location(self, card_id: str, base: str | Path | None = None) -> str:
        """Where a card's image is, resolved against ``base`` (see ``resolve_art``). Raises
        ``NoArtError`` (a ``ValueError``) for a card without art."""
        art = self.card(card_id).art
        if art is None:
            raise NoArtError(f"card {card_id!r} has no art in the {self.game} catalog")
        return resolve_art(art, base)


def groups_by_key(ids: Iterable[str], key_of: Mapping[str, str]) -> list[list[str]]:
    """The ids that share a key, as groups of two or more.

    ``key_of`` maps an id to its key. Ids missing from it are left alone, and repeated ids count
    once. Keys are compared as exact strings. Each group is sorted, and the list is ordered by
    each group's first id. This is the grouping behind ``Catalog.identity_groups``, where the
    key is the card's identity.
    """
    by_key: dict[str, list[str]] = {}
    for card_id in sorted(set(ids)):
        if card_id in key_of:
            by_key.setdefault(key_of[card_id], []).append(card_id)
    return sorted((group for group in by_key.values() if len(group) >= 2), key=lambda group: group[0])


def parse_catalog(doc: Any, source: str = "catalog") -> Catalog:
    """Validate an already parsed catalog document.

    ``source`` prefixes every error message; pass the file name. Raises ``CatalogError`` at
    the first problem, naming the card (by id when it has one, and by position) at fault.
    """
    if not isinstance(doc, dict):
        raise CatalogError(f"{source}: the catalog must be a JSON object")
    unknown = sorted(set(doc) - _TOP_KEYS)
    if unknown:
        raise CatalogError(f"{source}: unknown key(s) {unknown} (expected {sorted(_TOP_KEYS)})")
    for key in ("game", "locale"):
        if not _is_text(doc.get(key)):
            raise CatalogError(f'{source}: "{key}" must be a non-empty string')
    identity = doc.get("identity", IDENTITY_NAME)
    if identity not in IDENTITY_RULES:
        raise CatalogError(f'{source}: "identity" must be one of {list(IDENTITY_RULES)}, not {identity!r}')
    entries = doc.get("cards")
    if not isinstance(entries, list) or not entries:
        raise CatalogError(f'{source}: "cards" must be a non-empty list')

    decls = _check_facets(doc["facets"], source) if "facets" in doc else []
    cards: list[Card] = []
    position_of: dict[str, int] = {}
    for position, entry in enumerate(entries):
        where = f"cards[{position}]"
        if not isinstance(entry, dict):
            raise CatalogError(f"{source}: {where} must be an object")
        card_id = entry.get("id")
        if not _is_text(card_id):
            raise CatalogError(f'{source}: {where}: "id" must be a non-empty string')
        if card_id != card_id.strip():
            raise CatalogError(f'{source}: {where}: "id" {card_id!r} has leading or trailing whitespace')
        if len(card_id) > CARD_ID_MAX_LENGTH or not _CARD_ID.fullmatch(card_id):
            raise CatalogError(
                f'{source}: {where}: "id" {card_id!r} must be at most {CARD_ID_MAX_LENGTH} characters, with no space '
                "or other whitespace and no control character")
        where = f"card {card_id!r} ({where})"
        if card_id in position_of:
            raise CatalogError(f"{source}: {where}: duplicate id, first used by cards[{position_of[card_id]}]")
        missing = [key for key in _CARD_REQUIRED if key not in entry]
        if missing:
            raise CatalogError(f"{source}: {where}: missing key(s) {missing}")
        unknown = sorted(set(entry) - _CARD_KEYS)
        if unknown:
            raise CatalogError(f"{source}: {where}: unknown key(s) {unknown}")
        name = entry["name"]
        if not _is_text(name):
            raise CatalogError(f'{source}: {where}: "name" must be a non-empty string')
        if name != name.strip():
            raise CatalogError(f'{source}: {where}: "name" {name!r} has leading or trailing whitespace')
        kind = entry.get("kind")
        if kind is not None and not _is_text(kind):
            raise CatalogError(f'{source}: {where}: "kind" must be a non-empty string or null')
        printing_of = entry.get("printingOf")
        if printing_of is not None and not _is_text(printing_of):
            raise CatalogError(f'{source}: {where}: "printingOf" must be a card id or null')
        problem = _art_problem(entry["art"])
        if problem:
            raise CatalogError(f"{source}: {where}: {problem}")
        token = entry.get("token", False)
        if not isinstance(token, bool):
            raise CatalogError(f'{source}: {where}: "token" must be true or false')
        facets = _card_facets(entry["facets"], decls, f"{source}: {where}") if "facets" in entry else {}
        extra = entry.get("extra", {})
        if not isinstance(extra, dict):
            raise CatalogError(f'{source}: {where}: "extra" must be an object (any keys and values), not '
                               f"{json.dumps(extra, default=repr)}")
        position_of[card_id] = position
        cards.append(Card(id=card_id, name=name, kind=kind, printing_of=printing_of, art=entry["art"], token=token,
                          facets=facets, extra=copy.deepcopy(extra)))

    for position, card in enumerate(cards):
        if card.printing_of is None:
            continue
        where = f"card {card.id!r} (cards[{position}])"
        if card.printing_of == card.id:
            raise CatalogError(f'{source}: {where}: "printingOf" names the card itself')
        if card.printing_of not in position_of:
            raise CatalogError(f'{source}: {where}: "printingOf" names {card.printing_of!r}, which is not a card')
        if identity == IDENTITY_PRINTING and cards[position_of[card.printing_of]].printing_of is not None:
            raise CatalogError(
                f'{source}: {where}: "printingOf" names {card.printing_of!r}, which is itself a printing of '
                f'{cards[position_of[card.printing_of]].printing_of!r}; under "identity": "printing" every printing '
                "points straight at the card it is a printing of")

    kinds = _check_kinds(doc["kinds"], source) if "kinds" in doc else {}
    return Catalog(doc["game"], doc["locale"], tuple(cards), kinds, identity, _resolve_facets(decls, cards))


def load_catalog(path: str | Path) -> Catalog:
    """Read and validate a catalog file. Raises ``CatalogError`` when it is not valid."""
    path = Path(path)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise CatalogError(f"{path.name}: not valid JSON: {error}") from None
    return parse_catalog(doc, source=path.name)
