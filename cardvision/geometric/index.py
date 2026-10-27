# SPDX-License-Identifier: Apache-2.0
"""The descriptor index: each card's local features, computed once from its image.

``cardvision build-features`` writes it, by default beside the bank, and the geometric stage
reads it. It is one JSON document in the bank tools' canonical form (``cardvision.bank.
documents``), so building it twice from the same images and settings gives the same bytes, and
the settings file pins it by the SHA-256 of those bytes::

    {
     "schemaVersion": 1,
     "kind": "cardvision-geometric-index",
     "game": "toy", "locale": "en", "opencv": "4.10.0",
     "features": {"type": "orb", "maxFeatures": 300, "artLongSide": 320, "mask": [], "params": {...}},
     "descriptor": {"dtype": "uint8", "width": 32, "norm": "hamming"},
     "bank": {"version": 1, "sha256": "<64 hex>"},
     "cardCount": 20, "featureCount": 5904,
     "cards": [{"cardId": "TOY-001", "artV": "<16 hex>", "width": 229, "height": 320, "n": 300,
                "xy": "<base64>", "desc": "<base64>"}, ...]
    }

``opencv`` is the version of OpenCV that took the keypoints: another version may take slightly
different ones, so a rebuild with it may give other bytes. ``features`` is the settings block
the index was built with (every key filled in);
``descriptor`` says how a descriptor is stored and compared: ``uint8`` bytes compared by
Hamming distance (ORB, AKAZE) or little-endian ``float32`` values compared by Euclidean
distance (SIFT), ``width`` per keypoint. ``bank`` ties the index to the bank it was built beside
(``null`` when none was given), as the identity groups file does. Per card: ``artV`` names the
image the keypoints came from as the bank's rows do (``cardvision.core.bank.art_version``),
``width`` and ``height`` are the scaled image's size, ``n`` the keypoint count, ``xy`` the
keypoints' positions in that image as little-endian ``float32`` pairs and ``desc`` their
descriptors, both base64. A card with no keypoint has ``n`` 0 and empty strings. Cards are in
the catalog's order, or the bank's when a bank is given.

**Adding cards to an index** (``build_index(..., base=old)``, ``build-features --base``). An
index is extended, not rebuilt, when cards are added, as a bank is (``cardvision.bank.build``):
every card entry of the old index is copied byte for byte, in its old order, and only the cards
it lacks get their keypoints taken, after the old ones, in the order a full build would give
them (the bank's, or the catalog's). The old index must have been built with the same settings
block, the same descriptor and the same OpenCV version (another version may take other
keypoints), for the same game and locale, else it is refused. An old card whose image changed
is refused too: copying its keypoints would verify it against its old picture, so such an index
is built again without a base. When the bank too was extended from the old index's bank
(``build-bank --base``), its new rows come after the old ones, so the extended index holds the
same cards in the same order as a full build, and is byte for byte the same file. The packed
form keeps the old shards as they are (``cardvision.geometric.pack``).

**Which bank an index serves** (``bank_mismatch``). Always: every card of the bank must be in
the index, and where the bank's row records its image (``artV``) the index's entry must record
the same. Then the bank is served when it is the one the index records (same SHA-256), or,
failing that, when every row records its image (a bank of another recognizer built from the
same images, say). Anything else is refused: a bank card the index lacks would never be
verified nor found by the vote, and a card whose image changed would be verified against the
wrong picture. ``build_index`` enforces the same when it is given a bank: it refuses a card
whose image now differs from the one the bank row records, and it cannot leave out a card
whose image is missing.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from cardvision.core.bank import art_version, is_art_version, stored_vectors
from cardvision.core.catalog import Catalog
from cardvision.geometric.features import Features, cv2_module, descriptor_dtype, extract, is_binary

INDEX_KIND = "cardvision-geometric-index"
INDEX_SCHEMA_VERSION = 1
# The descriptor width, in values, of each feature type.
DESCRIPTOR_WIDTH = {"orb": 32, "akaze": 61, "sift": 128}
_XY = np.dtype("<f4")


class DescriptorIndexError(ValueError):
    """A descriptor index cannot be built or read. The message says why."""


@dataclass
class DescriptorIndex:
    """A loaded index: card ids in order, each card's ``Features``, and the settings it was
    built with."""

    ids: list[str]
    cards: dict[str, Features]
    features: dict[str, Any]
    doc: dict[str, Any] = field(default_factory=dict, repr=False)
    art_versions: dict[str, str] = field(default_factory=dict)

    @property
    def kind(self) -> str:
        return self.features["type"]

    def feature_count(self) -> int:
        return sum(len(found) for found in self.cards.values())


def _b64(array: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(array).tobytes()).decode("ascii")


def _unb64(text: str, dtype: np.dtype, width: int, what: str) -> np.ndarray:
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError, TypeError) as error:
        raise DescriptorIndexError(f"{what}: not valid base64: {error}") from None
    row = dtype.itemsize * width
    if len(raw) % row:
        raise DescriptorIndexError(f"{what}: {len(raw)} bytes is not a whole number of {width}-value rows")
    return np.frombuffer(raw, dtype=dtype).reshape(-1, width).copy()


def card_document(card_id: str, image_bytes: bytes, found: Features) -> dict[str, Any]:
    """One card's entry of the index."""
    return {"cardId": card_id, "artV": art_version(image_bytes), "width": found.size[0], "height": found.size[1],
            "n": len(found), "xy": _b64(found.xy.astype(_XY)) if len(found) else "",
            "desc": _b64(found.descriptors.astype(descriptor_dtype_of(found))) if len(found) else ""}


def descriptor_dtype_of(found: Features) -> np.dtype:
    return np.dtype(np.uint8) if found.descriptors.dtype == np.uint8 else np.dtype("<f4")


def card_features(rgb: np.ndarray, features: Mapping[str, Any]) -> Features:
    """The keypoints of one card image under an index's ``features`` settings."""
    return extract(rgb, features["type"], features["artLongSide"], features["maxFeatures"], features["params"],
                   features["mask"])


def build_index(
    catalog: Catalog,
    art: str | Path,
    features: Mapping[str, Any],
    *,
    bank: Mapping[str, Any] | None = None,
    bank_sha256: str | None = None,
    skip_missing_art: bool = False,
    progress: Callable[[int, int], None] | None = None,
    base: Mapping[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """The index document for the catalog's cards (the bank's, in its order, when ``bank`` is
    given), and the ids left out for a missing image (only with ``skip_missing_art``).

    ``features`` is a full settings block (``GeometricConfig.features``).

    ``base`` is an older index document to extend (see "Adding cards to an index" above): its
    card entries are copied unchanged and first, and only the other cards are read. Refused
    (``DescriptorIndexError``) when it was built with other settings, another OpenCV version,
    for another game or locale, or when one of its cards has another image now: the bank row's
    ``artV`` with a bank, else the image at the art location.

    With ``bank``, every bank card must have its image, and the image must be the one the bank
    row records (its ``artV``, where the row records one): an index of another picture than
    the bank's would verify the card against the wrong art. Both are refused, so
    ``skip_missing_art`` cannot be used with a bank.
    """
    from cardvision.bank.build import BankBuildError, _read_card_art, decode_art
    from cardvision.core.bank import stored_art_versions

    recorded: dict[str, str | None] = {}
    if bank is not None:
        if skip_missing_art:
            raise DescriptorIndexError("an index built for a bank must have every bank card: --skip-missing-art "
                                       "cannot be used with --bank")
        ids, _ = stored_vectors(bank)
        recorded = dict(zip(ids, stored_art_versions(bank)))
        ids = list(dict.fromkeys(ids))
        unknown = [card_id for card_id in ids if card_id not in catalog]
        if unknown:
            raise DescriptorIndexError(f"{len(unknown)} bank id(s) are not in the catalog (e.g. {unknown[:5]})")
    else:
        ids = catalog.ids()
    kind = features["type"]
    entries, skipped, stale = [], [], []
    width = None
    kept: dict[str, dict[str, Any]] = {}
    if base is not None:
        kept = _base_entries(base, catalog, features, recorded if bank is not None else None)
        listed = set(ids)
        orphans = [card_id for card_id in kept if card_id not in listed]
        if orphans:
            raise DescriptorIndexError(
                f"{len(orphans)} card(s) of the base index are not in the {'bank' if bank is not None else 'catalog'} "
                f"(e.g. {orphans[:5]}): their entries could not be checked; build the index again without --base")
        entries = list(kept.values())
        if entries:
            width = DESCRIPTOR_WIDTH[kind]
    for done, card_id in enumerate(ids, 1):
        if card_id in kept:
            # With a bank, a row that records its image was compared above; one that records none
            # is checked against the image at the art location, as without a bank.
            if bank is None or recorded.get(card_id) is None:
                _check_base_image(card_id, kept[card_id], catalog, art, skip_missing_art, stale)
            if progress is not None:
                progress(done, len(ids))
            continue
        try:
            data = _read_card_art(card_id, catalog.art_location(card_id, art))
        except BankBuildError as error:
            raise DescriptorIndexError(str(error)) from None
        if data is None:
            if not skip_missing_art:
                raise DescriptorIndexError(f"no image for card {card_id!r} at {catalog.art_location(card_id, art)} "
                                  "(pass --skip-missing-art to leave such cards out)")
            skipped.append(card_id)
            continue
        if recorded.get(card_id) is not None and recorded[card_id] != art_version(data):
            stale.append(card_id)
            continue
        found = card_features(decode_art(data), features)
        if len(found):
            width = found.descriptors.shape[1]
        entries.append(card_document(card_id, data, found))
        if progress is not None:
            progress(done, len(ids))
    if stale and base is not None:
        raise DescriptorIndexError(
            f"{len(stale)} card(s) of the base index have another image now: {', '.join(stale[:10])}"
            + (" and more" if len(stale) > 10 else "") + "; an index cannot be extended over a changed image: "
            "build it again without --base")
    if stale:
        raise DescriptorIndexError(
            f"{len(stale)} card(s) have another image now than the bank records (artV): {', '.join(stale[:10])}"
            + (" and more" if len(stale) > 10 else "") + "; the bank was embedded from a different image; "
            "refresh the bank first (cardvision build-bank --base)")
    if width is None:
        width = DESCRIPTOR_WIDTH[kind]
    doc = {
        "schemaVersion": INDEX_SCHEMA_VERSION,
        "kind": INDEX_KIND,
        "game": catalog.game,
        "locale": catalog.locale,
        "opencv": cv2_module().__version__,
        "features": dict(features),
        "descriptor": {"dtype": "uint8" if is_binary(kind) else "float32", "width": width,
                       "norm": "hamming" if is_binary(kind) else "l2"},
        "bank": None if bank is None else {"version": bank.get("version"), "sha256": bank_sha256},
        "cardCount": len(entries),
        "featureCount": sum(entry["n"] for entry in entries),
        "cards": entries,
    }
    return doc, skipped


def _base_entries(base: Mapping[str, Any], catalog: Catalog, features: Mapping[str, Any],
                  recorded: Mapping[str, str | None] | None) -> dict[str, dict[str, Any]]:
    """The card entries of the base index ``base``, by card id in its order, after checking that
    it may be extended by a build with ``features`` on this OpenCV, for ``catalog``; with a bank
    (``recorded``: card id to the ``artV`` its row records), that no kept card's row records
    another image than the base entry."""
    parsed = parse_index(base, source="the base index")
    problems = []
    differ = same_features(parsed.features, features)
    if differ:
        problems.append(f"it was built with other features settings (differing: {', '.join(differ)})")
    running = cv2_module().__version__
    if base.get("opencv") != running:
        problems.append(f"it was built with OpenCV {base.get('opencv')!r}, this build runs {running!r}, "
                        "which may take other keypoints")
    for key, value in (("game", catalog.game), ("locale", catalog.locale)):
        if base.get(key) != value:
            problems.append(f"its {key} is {base.get(key)!r}, the catalog's is {value!r}")
    if problems:
        raise DescriptorIndexError("the base index cannot be extended: " + "; ".join(problems)
                                   + "; build the index again without --base")
    entries = {entry["cardId"]: dict(entry) for entry in base["cards"]}
    if recorded is not None:
        changed = [card_id for card_id, entry in entries.items()
                   if recorded.get(card_id) is not None and recorded[card_id] != entry["artV"]]
        if changed:
            raise DescriptorIndexError(
                f"{len(changed)} card(s) of the base index have another image in the bank (artV): "
                f"{', '.join(changed[:10])}" + (" and more" if len(changed) > 10 else "")
                + "; an index cannot be extended over a changed image: build it again without --base")
    return entries


def _check_base_image(card_id: str, entry: Mapping[str, Any], catalog: Catalog, art: str | Path,
                      skip_missing_art: bool, stale: list[str]) -> None:
    """Without a bank, or when the bank's row records no image: note ``card_id`` in ``stale`` when
    the image at its art location is not the one its base entry was taken from. A missing image keeps the entry under ``skip_missing_art``."""
    from cardvision.bank.build import BankBuildError, _read_card_art

    try:
        data = _read_card_art(card_id, catalog.art_location(card_id, art))
    except BankBuildError as error:
        raise DescriptorIndexError(str(error)) from None
    if data is None:
        if not skip_missing_art:
            raise DescriptorIndexError(f"no image for card {card_id!r} at {catalog.art_location(card_id, art)} "
                                       "(pass --skip-missing-art to keep its entry from the base index)")
        return
    if art_version(data) != entry["artV"]:
        stale.append(card_id)


def _whole(value: Any, low: int = 0) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= low


def parse_index(doc: Any, source: str = "index") -> DescriptorIndex:
    """Read an index document. Raises ``DescriptorIndexError`` (a ``ValueError``) saying what
    is wrong: the kind and version, the feature type, a descriptor width that is not the
    feature type's, a card entry of the wrong shape or with counts that do not match its
    data."""
    if not isinstance(doc, Mapping) or doc.get("kind") != INDEX_KIND:
        raise DescriptorIndexError(f"{source}: not a descriptor index (kind {INDEX_KIND!r})")
    if doc.get("schemaVersion") != INDEX_SCHEMA_VERSION:
        raise DescriptorIndexError(f"{source}: schemaVersion {doc.get('schemaVersion')!r} is not {INDEX_SCHEMA_VERSION}")
    features, descriptor = doc.get("features"), doc.get("descriptor")
    if not isinstance(features, Mapping) or not isinstance(descriptor, Mapping):
        raise DescriptorIndexError(f"{source}: features and descriptor must be objects")
    kind = features.get("type")
    if kind not in DESCRIPTOR_WIDTH:
        raise DescriptorIndexError(f"{source}: features.type must be one of {sorted(DESCRIPTOR_WIDTH)}, got {kind!r}")
    dtype = descriptor_dtype(kind)
    expected = "uint8" if dtype == np.uint8 else "float32"
    width = descriptor.get("width")
    if descriptor.get("dtype") != expected:
        raise DescriptorIndexError(f"{source}: descriptor.dtype must be {expected!r} for {kind}")
    if not _whole(width, 1) or width != DESCRIPTOR_WIDTH[kind]:
        raise DescriptorIndexError(f"{source}: descriptor.width must be {DESCRIPTOR_WIDTH[kind]} for {kind}, "
                                   f"got {width!r}")
    entries = doc.get("cards")
    if not isinstance(entries, list):
        raise DescriptorIndexError(f"{source}: cards must be a list")
    ids: list[str] = []
    cards: dict[str, Features] = {}
    art_versions: dict[str, str] = {}
    for position, entry in enumerate(entries):
        where = f"{source}: cards[{position}]"
        if not isinstance(entry, Mapping):
            raise DescriptorIndexError(f"{where} must be an object")
        card_id = entry.get("cardId")
        if not isinstance(card_id, str) or card_id in cards:
            raise DescriptorIndexError(f"{where} has a missing or repeated cardId")
        n, size = entry.get("n"), (entry.get("width"), entry.get("height"))
        if not _whole(n) or not all(_whole(side) for side in size):
            raise DescriptorIndexError(f"{where} ({card_id}): n, width and height must be whole numbers of 0 or more")
        if not isinstance(entry.get("xy", ""), str) or not isinstance(entry.get("desc", ""), str):
            raise DescriptorIndexError(f"{where} ({card_id}): xy and desc must be base64 text")
        if n == 0:
            xy, desc = np.zeros((0, 2), np.float32), np.zeros((0, width), dtype)
        else:
            xy = _unb64(entry.get("xy", ""), _XY, 2, f"{source}: {card_id} xy").astype(np.float32)
            desc = _unb64(entry.get("desc", ""), dtype, width, f"{source}: {card_id} desc")
            if len(xy) != n or len(desc) != n:
                raise DescriptorIndexError(f"{source}: {card_id} records n {n} but holds {len(xy)} positions and "
                                           f"{len(desc)} descriptors")
        ids.append(card_id)
        cards[card_id] = Features(xy, desc.astype(np.uint8 if dtype == np.uint8 else np.float32), size)
        if not np.isfinite(xy).all():
            raise DescriptorIndexError(f"{where} ({card_id}): xy holds a value that is not a finite number")
        if not is_art_version(entry.get("artV")):
            raise DescriptorIndexError(f"{where} ({card_id}): artV must be 16 lowercase hex digits")
        art_versions[card_id] = entry["artV"]
    if doc.get("cardCount") != len(ids):
        raise DescriptorIndexError(f"{source}: cardCount {doc.get('cardCount')!r} but {len(ids)} cards")
    return DescriptorIndex(ids=ids, cards=cards, features=dict(features), doc=dict(doc), art_versions=art_versions)


def load_index(path: str | Path) -> DescriptorIndex:
    """Read an index file."""
    from cardvision.bank.documents import read_json

    path = Path(path)
    return parse_index(read_json(path), source=path.name)


def bank_mismatch(index: DescriptorIndex, bank_path: str | Path) -> str | None:
    """Why ``index`` must not be used with the bank file at ``bank_path``, or ``None`` when it
    may (see the module docstring)."""
    from cardvision.bank.documents import read_json, sha256_hex
    from cardvision.core.bank import stored_art_versions

    bank_path = Path(bank_path)
    recorded = index.doc.get("bank")
    body = bank_path.read_bytes()
    bank = read_json(bank_path)
    ids, _ = stored_vectors(bank)
    versions = stored_art_versions(bank)
    # Checked whatever the hashes say: an index must hold every bank card, from the image the
    # bank's row records where it records one.
    missing = [card_id for card_id in ids if card_id not in index.cards]
    if missing:
        return (f"the index has no entry for {len(missing)} card(s) of {bank_path.name} (e.g. {missing[:3]}); "
                "build it again with cardvision build-features --bank")
    changed = [card_id for card_id, version in zip(ids, versions)
               if version is not None and index.art_versions.get(card_id) != version]
    if changed:
        return (f"the index took {len(changed)} card(s) from another image than {bank_path.name} records "
                f"(e.g. {changed[:3]}); build it again with cardvision build-features --bank")
    if isinstance(recorded, Mapping) and recorded.get("sha256") == sha256_hex(body):
        return None
    unknown = [card_id for card_id, version in zip(ids, versions) if version is None]
    if unknown:
        return (f"{bank_path.name} is not the bank the index records, and {len(unknown)} of its rows record no "
                f"image (artV) to compare (e.g. {unknown[:3]})")
    return None


def index_path_for(bank_path: str | Path) -> Path:
    """Where ``build-features`` writes the index of a bank by default: beside it."""
    bank_path = Path(bank_path)
    return bank_path.with_name(bank_path.stem + ".features.json")


def same_features(a: Mapping[str, Any], b: Mapping[str, Any]) -> list[str]:
    """The keys of two ``features`` blocks that differ (empty when they agree)."""
    return sorted(key for key in set(a) | set(b) if a.get(key) != b.get(key))


__all__ = ["INDEX_KIND", "INDEX_SCHEMA_VERSION", "DescriptorIndex", "DescriptorIndexError", "bank_mismatch",
           "build_index", "card_features",
           "index_path_for", "load_index", "parse_index", "same_features"]

