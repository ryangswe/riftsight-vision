# SPDX-License-Identifier: Apache-2.0
"""The embedding bank: its storage format, and the identity groups laid over it.

A bank is the set of reference embeddings a crop is compared against. On disk it is one JSON
document::

    {"entries": [{"cardId": "ABC-001", "vec": "<base64>", "artV": "<16 hex>"}, ...], ...}

``vec`` is the embedding as little-endian IEEE half floats (fp16), base64 encoded. A card may
have several entries. Any other top-level key is metadata that this module carries through
untouched.

``artV`` records which image the row was embedded from: the first 16 lower-case hexadecimal
digits of the SHA-256 of the bytes of the image file (``art_version``). It is optional. A bank
written before the field existed has none, and its rows are of unknown image; such a bank
loads like any other. No reader uses ``artV`` to score: it is there so that a row embedded from
an earlier image of a card can be found and embedded again.

Half floats keep the file small, at the cost that a stored row is no longer exactly unit
length. Every reader therefore renormalizes after decoding, and a tool that wants to score
against what a reader will see applies the same round trip first (``fp16_roundtrip``).

Identity groups say which card ids count as the same card when a match is judged: confusing
two cards of one identity is not an error and the margin between them is not evidence of doubt.
Which cards are one identity is the catalog's rule (``cardvision.core.catalog``,
``Catalog.identity_groups``): by default, printings of one name.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

from cardvision.core.catalog import groups_by_key

# Stored element type: IEEE 754 half precision, little-endian, on every platform.
VECTOR_DTYPE = np.dtype("<f2")

# The entry key that records a row's source image, and the form of its value.
ART_VERSION_KEY = "artV"
ART_VERSION_DIGITS = 16
_ART_VERSION = re.compile(r"^[0-9a-f]{%d}$" % ART_VERSION_DIGITS)


def art_version(data: bytes) -> str:
    """The ``artV`` of an image file: the first 16 hex digits of the SHA-256 of its bytes.

    The hash is of the file as stored or fetched, not of its pixels: the same picture saved
    again in another format, or compressed again, is another image.
    """
    return hashlib.sha256(data).hexdigest()[:ART_VERSION_DIGITS]


def is_art_version(value: Any) -> bool:
    """Whether ``value`` has the form of an ``artV``: 16 lower-case hexadecimal digits."""
    return isinstance(value, str) and _ART_VERSION.fullmatch(value) is not None


def l2_normalize(v: Any) -> np.ndarray:
    """Scale vectors to unit length along the last axis, in float32."""
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def fp16_roundtrip(v: Any) -> np.ndarray:
    """What unit float32 rows become once stored as fp16 and read back.

    The values are narrowed to fp16, widened to float32 and renormalized in float32. Use it to
    score against a bank in memory exactly as if it had been written and loaded.
    """
    h = np.asarray(v, dtype=np.float32).astype(np.float16).astype(np.float32)
    return h / np.linalg.norm(h, axis=-1, keepdims=True)


def encode_vector(v: Any) -> str:
    """Encode one embedding as base64 text of little-endian fp16 values.

    The values are stored as given (narrowed to float32, then to fp16); pass a unit vector.
    """
    row = np.asarray(v, dtype=np.float32)
    if row.ndim != 1 or row.size == 0:
        raise ValueError(f"expected a non-empty 1-D vector, got shape {row.shape}")
    if not np.isfinite(row).all():
        raise ValueError("cannot store a vector with NaN or infinite values")
    return base64.b64encode(row.astype(VECTOR_DTYPE).tobytes()).decode("ascii")


def decode_vector(text: str) -> np.ndarray:
    """Decode base64 text into the stored fp16 values, exactly as written (not renormalized)."""
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError, TypeError) as error:
        raise ValueError(f"not valid base64: {error}") from None
    if len(raw) == 0 or len(raw) % VECTOR_DTYPE.itemsize:
        raise ValueError(f"{len(raw)} bytes is not a whole, non-empty run of fp16 values")
    return np.frombuffer(raw, dtype=VECTOR_DTYPE).copy()


def encode_bank(ids: Sequence[str], rows: Any, extra: Mapping[str, Any] | None = None,
                art_versions: Sequence[str | None] | None = None) -> dict[str, Any]:
    """Build a bank document from card ids and their ``(N, D)`` rows.

    ``ids[i]`` owns ``rows[i]``; an id may repeat. ``extra`` supplies further top-level keys
    (model name, dimensions and the like) and may not define ``entries``. ``art_versions``
    gives each row's ``artV`` (see ``art_version``), or ``None`` for a row that records none;
    left out, no row records one. The stored vectors are the same either way.
    """
    matrix = np.asarray(rows, dtype=np.float32)
    if matrix.ndim != 2 or matrix.shape[0] != len(ids):
        raise ValueError(f"expected one row per id: {len(ids)} ids, rows of shape {matrix.shape}")
    if art_versions is not None and len(art_versions) != len(ids):
        raise ValueError(f"expected one artV per id: {len(ids)} ids, {len(art_versions)} values")
    doc: dict[str, Any] = dict(extra or {})
    if "entries" in doc:
        raise ValueError('"entries" is written by encode_bank and cannot be passed in extra')
    entries = []
    for position, (card_id, row) in enumerate(zip(ids, matrix)):
        try:
            entry = {"cardId": card_id, "vec": encode_vector(row)}
        except ValueError as error:
            raise ValueError(f"card {card_id!r}: {error}") from None
        recorded = None if art_versions is None else art_versions[position]
        if recorded is not None:
            if not is_art_version(recorded):
                raise ValueError(f"card {card_id!r}: artV {recorded!r} is not {ART_VERSION_DIGITS} "
                                 "lower-case hexadecimal digits")
            entry[ART_VERSION_KEY] = recorded
        entries.append(entry)
    doc["entries"] = entries
    return doc


def stored_vectors(doc: Mapping[str, Any]) -> tuple[list[str], np.ndarray]:
    """The card ids and the ``(N, D)`` fp16 values of a bank document, exactly as stored."""
    entries = doc.get("entries") if isinstance(doc, Mapping) else None
    if not isinstance(entries, list):
        raise ValueError('a bank document needs an "entries" list')
    ids: list[str] = []
    rows: list[np.ndarray] = []
    for position, entry in enumerate(entries):
        if not isinstance(entry, Mapping) or not isinstance(entry.get("cardId"), str):
            raise ValueError(f'entries[{position}] needs a "cardId" string')
        card_id = entry["cardId"]
        try:
            row = decode_vector(entry.get("vec"))
        except ValueError as error:
            raise ValueError(f"card {card_id!r} (entries[{position}]): {error}") from None
        if rows and row.shape != rows[0].shape:
            raise ValueError(
                f"card {card_id!r} (entries[{position}]) has {row.size} values, "
                f"the entries before it have {rows[0].size}"
            )
        ids.append(card_id)
        rows.append(row)
    if not rows:
        return ids, np.zeros((0, 0), dtype=VECTOR_DTYPE)
    return ids, np.stack(rows)


def stored_art_versions(doc: Mapping[str, Any]) -> list[str | None]:
    """The ``artV`` of every entry of a bank document, in row order: ``None`` where none is recorded.

    A value that is present and is not 16 lower-case hexadecimal digits raises ``ValueError``
    naming the card. ``stored_vectors`` and ``decode_bank`` do not look at the field at all.
    """
    entries = doc.get("entries") if isinstance(doc, Mapping) else None
    if not isinstance(entries, list):
        raise ValueError('a bank document needs an "entries" list')
    versions: list[str | None] = []
    for position, entry in enumerate(entries):
        if not isinstance(entry, Mapping) or not isinstance(entry.get("cardId"), str):
            raise ValueError(f'entries[{position}] needs a "cardId" string')
        if ART_VERSION_KEY not in entry:
            versions.append(None)
            continue
        recorded = entry[ART_VERSION_KEY]
        if not is_art_version(recorded):
            raise ValueError(
                f"card {entry['cardId']!r} (entries[{position}]): {ART_VERSION_KEY} {recorded!r} is not "
                f"{ART_VERSION_DIGITS} lower-case hexadecimal digits"
            )
        versions.append(recorded)
    return versions


def decode_bank(doc: Mapping[str, Any]) -> tuple[list[str], np.ndarray]:
    """The card ids and the ``(N, D)`` float32 unit rows of a bank document.

    Each stored row is widened to float64, its norm is taken in float64, and the quotient is
    narrowed to float32. That is the decode every runtime is expected to perform, so that all of
    them score against the same matrix.
    """
    ids, stored = stored_vectors(doc)
    rows = []
    for card_id, half in zip(ids, stored):
        v = half.astype(np.float64)
        norm = np.sqrt(float(np.sum(v * v)))
        if not np.isfinite(norm) or norm == 0.0:
            raise ValueError(f"card {card_id!r} has a stored vector that cannot be normalized")
        rows.append((v / norm).astype(np.float32))
    if not rows:
        return ids, np.zeros((0, 0), dtype=np.float32)
    return ids, np.stack(rows)


def load_bank(path: str | Path) -> tuple[list[str], np.ndarray, dict[str, Any]]:
    """Read a bank file, JSON or binary (``cardvision.core.bank_binary``): card ids, decoded
    float32 unit rows, and the whole document (in its JSON form)."""
    from cardvision.core.bank_binary import read_bank_file

    doc = read_bank_file(path)
    ids, rows = decode_bank(doc)
    return ids, rows, doc


_PLAIN_ID = re.compile(r"^([A-Z0-9]+)-(\d+)$")


def representative_key(card_id: str) -> tuple:
    """Sort key that picks the representative of an identity group (the minimum wins).

    Ids of the plain form ``SET-123`` come first, ordered by set code and then by number as an
    integer; every other id (letter suffixes, promotional numbering) follows in string order.
    The base printing therefore represents its alternates.
    """
    match = _PLAIN_ID.match(card_id)
    return (0, match.group(1), int(match.group(2)), card_id) if match else (1, card_id)


class IdentityGroups:
    """Which bank rows count as the same card.

    Built from a list of groups (each a list of card ids that share an identity) and the bank's
    row ids. Every group is represented by its member with the smallest ``representative_key``;
    a card in no group is its own identity.

    ``prefer`` names the ids that represent their group whenever they are in it, before any
    key is compared: the entries a catalog marks as standing for their identity
    (``Catalog.identity_anchors``), or the representatives a groups document records
    (``recorded_representatives``). Among a group's preferred members, or when it has none, the
    smallest ``representative_key`` wins as before.

    When ``known`` is given (the ids a consumer can actually display), a group whose
    representative is not in it is set aside into ``dropped`` and its members stay separate
    identities, since they could not be shown under the representative's id.

    Attributes:
        groups: every group passed in, each sorted.
        dropped: the groups set aside because of ``known``.
        ids: the bank's row ids, in row order.
        column_identity: int64 array, one entry per row: the index of that row's identity.
        identity_ids: the representative id of each identity, indexed by ``column_identity``.
    """

    def __init__(
        self,
        groups: Iterable[Iterable[str]],
        ids: Sequence[str],
        known: Iterable[str] | None = None,
        prefer: Iterable[str] = (),
    ) -> None:
        self.groups: list[list[str]] = [sorted(group) for group in groups]
        known_ids = None if known is None else set(known)
        preferred = frozenset(prefer)
        self._representative: dict[str, str] = {}
        self.dropped: list[list[str]] = []
        seen: set[str] = set()
        for group in self.groups:
            if not group:
                raise ValueError("an identity group cannot be empty")
            repeated = seen.intersection(group)
            if repeated or len(set(group)) != len(group):
                culprit = sorted(repeated)[0] if repeated else next(c for c in group if group.count(c) > 1)
                raise ValueError(f"card {culprit!r} appears more than once in the identity groups")
            seen.update(group)
            representative = min(group, key=lambda card_id: (card_id not in preferred, representative_key(card_id)))
            if known_ids is not None and representative not in known_ids:
                self.dropped.append(group)
                continue
            for card_id in group:
                if card_id != representative:
                    self._representative[card_id] = representative
        self.ids: list[str] = list(ids)
        self.identity_ids: list[str] = []
        index: dict[str, int] = {}
        self.column_identity = np.empty(len(self.ids), dtype=np.int64)
        for column, card_id in enumerate(self.ids):
            representative = self.of(card_id)
            if representative not in index:
                index[representative] = len(self.identity_ids)
                self.identity_ids.append(representative)
            self.column_identity[column] = index[representative]

    def of(self, card_id: str | None) -> str | None:
        """The representative id of a card's identity (the id itself when it is in no group)."""
        if card_id is None:
            return None
        return self._representative.get(card_id, card_id)

    def same(self, a: str | None, b: str | None) -> bool:
        """Whether two card ids are the same identity. ``None`` matches nothing."""
        return a is not None and b is not None and self.of(a) == self.of(b)

    def representative_map(self) -> dict[str, str]:
        """Every non-representative member mapped to its representative, sorted by member id."""
        return dict(sorted(self._representative.items()))


def recorded_representatives(doc: Mapping[str, Any]) -> frozenset[str]:
    """The representatives an identity-groups document records: the members of its groups that
    its ``representative`` map does not point away from. Pass them as ``prefer`` to read the
    document's groups with the representatives it was written with. A document without a
    usable map gives the empty set, and the smallest key then represents each group.
    """
    groups, mapped = doc.get("groups"), doc.get("representative")
    if not isinstance(groups, list) or not isinstance(mapped, Mapping):
        return frozenset()
    return frozenset(card_id for group in groups if isinstance(group, list)
                     for card_id in group if isinstance(card_id, str) and card_id not in mapped)


def groups_by_name(ids: Iterable[str], names: Mapping[str, str]) -> list[list[str]]:
    """The groups of bank cards that share a name, for a caller that has names and no catalog.

    ``names`` maps card id to name. Ids missing from it are left alone. Names are compared as
    exact strings. Only groups of two or more are returned, each sorted, the list ordered by
    each group's first id. A catalog's own groups, under whichever identity rule it states,
    come from ``Catalog.identity_groups``; both use ``cardvision.core.catalog.groups_by_key``.
    """
    return groups_by_key(ids, names)


def groups_by_name_and_cosine(
    ids: Sequence[str],
    stored: Any,
    names: Mapping[str, str],
    threshold: float = 0.95,
) -> list[list[str]]:
    """Historical alternative to ``groups_by_name``; kept for the record, not used by releases.

    This stricter rule merges two cards only when they share a name *and* look alike: some pair
    of their bank rows has cosine similarity of at least ``threshold``. Under it, two printings
    of one name with clearly different art stay separate identities. Releases use the plain name
    rule; this one is here so that results produced under it can be reproduced.

    ``ids`` and ``stored`` are the bank's rows as stored (see ``stored_vectors``). Merges are
    transitive within a name. The return value has the shape ``groups_by_name`` returns.
    """
    vectors: dict[str, list[np.ndarray]] = {}
    for card_id, row in zip(ids, np.asarray(stored)):
        v = row.astype(np.float32)
        vectors.setdefault(card_id, []).append(v / float(np.linalg.norm(v)))
    views = {card_id: np.stack(rows) for card_id, rows in vectors.items()}
    by_name: dict[str, list[str]] = {}
    for card_id in sorted(views):
        if card_id in names:
            by_name.setdefault(names[card_id], []).append(card_id)

    parent: dict[str, str] = {}

    def find(x: str) -> str:
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for group in by_name.values():
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                if float((views[a] @ views[b].T).max()) >= threshold - 1e-6:
                    parent[find(a)] = find(b)
    components: dict[str, list[str]] = {}
    for card_id in list(parent):
        components.setdefault(find(card_id), []).append(card_id)
    return sorted((sorted(c) for c in components.values() if len(c) >= 2), key=lambda group: group[0])
