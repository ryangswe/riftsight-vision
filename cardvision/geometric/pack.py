# SPDX-License-Identifier: Apache-2.0
"""The packed descriptor index: the same keypoints as a ``build-features`` index, laid out for a web page.

``cardvision pack-features`` repacks a pinned index (``cardvision.geometric.index``) into a
folder of a manifest and ``SHARDS`` binary shards. It never takes keypoints again: every
descriptor and position is copied from the index. A binary (ORB) index only.

A shard holds the rows of some whole cards: the descriptors first, ``rows * 32`` bytes, then the
positions, ``rows * 2`` little-endian ``float32`` values (x, y per row). Cards are dealt to the
shards in index order, each to the shard its first row falls in when the rows are cut into
``SHARDS`` equal parts, so the shards in order hold the index's rows in order. The manifest
(``manifest.json``, canonical JSON)::

    {"schemaVersion": 1, "kind": "geometric-index-packed",
     "source": {"sha256": "<SHA-256 of the index file>"}, "bank": {"sha256": "<the index's bank>"},
     "opencv": "5.0.0", "features": {...the index's settings block...},
     "cards": [{"cardId", "artV", "width", "height", "shard", "offset", "n"}, ...],
     "shards": [{"path": "shard-0.bin", "sha256": "<64 hex>", "rows": 1234}, ...]}

``offset`` is the card's first row inside its shard, in rows. The positions are the index's own
``float32`` values (the index stores ``float32``, and the stage reads them as ``float32``), so
the packed positions are exactly the stage's. The same index gives the same bytes.

A reader takes any number of shards, at any relative path under the manifest's folder: the
layout above is how this module deals them, not part of the format.

**Adding cards** (``pack-features --base``). When an index was extended (``build-features
--base``, ``cardvision.geometric.index``), it begins with the base index's cards, unchanged and
in order. ``append_index`` then keeps the base manifest's shards as they are, byte for byte and
at the same paths, with their cards' entries unchanged, and deals only the new cards to new
shards after them, each at most as large as the base's largest shard. A new shard is named by
its content, ``shard-<first 16 hex digits of its SHA-256>.bin``, so the files of successive
manifests can share one folder on a server and in a browser's cache: a new card set downloads
only its own shards. The new manifest records the new index and its bank; when the cards are
the same and only the bank changed, it names no new shard at all. Rows keep their order, so
every row is at the same global position as in a full pack of the same index. ``--content-names``
names the shards of a pack without a base the same way (and leaves out the empty ones), to start
such a series.
"""

from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import numpy as np

from cardvision.bank.documents import canonical_bytes, read_json, sha256_hex
from cardvision.geometric.index import DescriptorIndex, DescriptorIndexError, parse_index, same_features

PACKED_KIND = "geometric-index-packed"
PACKED_SCHEMA_VERSION = 1
SHARDS = 8
DESCRIPTOR_BYTES = 32
MANIFEST_NAME = "manifest.json"
_XY = np.dtype("<f4")


class PackError(ValueError):
    """An index cannot be packed, or a packed index does not match its source."""


def shard_name(position: int) -> str:
    return f"shard-{position}.bin"


def content_shard_name(blob: bytes) -> str:
    """A shard's name from its bytes: the same bytes always get the same name."""
    return f"shard-{sha256_hex(blob)[:16]}.bin"


def _check_packable(index: DescriptorIndex) -> Mapping[str, Any]:
    """The index's bank record, after checking that the index can be packed."""
    descriptor = index.doc.get("descriptor") or {}
    if descriptor.get("dtype") != "uint8" or descriptor.get("width") != DESCRIPTOR_BYTES:
        raise PackError(f"only binary descriptors of {DESCRIPTOR_BYTES} bytes (ORB) can be packed")
    bank = index.doc.get("bank")
    if not isinstance(bank, Mapping) or not isinstance(bank.get("sha256"), str):
        raise PackError("the index records no bank (build it with --bank): a packed index must name its bank")
    return bank


def _blob(descs: list[np.ndarray], xys: list[np.ndarray]) -> bytes:
    return b"".join(d.tobytes() for d in descs) + b"".join(x.tobytes() for x in xys)


def _manifest(index: DescriptorIndex, source_sha256: str, bank: Mapping[str, Any], cards: list[dict[str, Any]],
              shards: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schemaVersion": PACKED_SCHEMA_VERSION,
        "kind": PACKED_KIND,
        "source": {"sha256": source_sha256},
        "bank": {"sha256": bank["sha256"]},
        "opencv": index.doc.get("opencv"),
        "features": dict(index.features),
        "cards": cards,
        "shards": shards,
    }


def pack_index(index: DescriptorIndex, source_sha256: str, shards: int = SHARDS,
               content_names: bool = False) -> tuple[dict[str, Any], list[bytes]]:
    """The manifest and the shard bytes of a loaded index whose file has SHA-256 ``source_sha256``.
    With ``content_names``, the shards are named by their content and the empty ones are left out
    (one stays when every shard is empty)."""
    bank = _check_packable(index)
    total = index.feature_count()
    descs: list[list[np.ndarray]] = [[] for _ in range(shards)]
    xys: list[list[np.ndarray]] = [[] for _ in range(shards)]
    rows = [0] * shards
    cards = []
    start = 0
    for card_id in index.ids:
        found = index.cards[card_id]
        n = len(found)
        shard = min(shards - 1, start * shards // total) if total else 0
        descs[shard].append(np.ascontiguousarray(found.descriptors, dtype=np.uint8))
        xys[shard].append(np.ascontiguousarray(found.xy, dtype=_XY))
        cards.append({"cardId": card_id, "artV": index.art_versions[card_id], "width": found.size[0],
                      "height": found.size[1], "shard": shard, "offset": rows[shard], "n": n})
        rows[shard] += n
        start += n
    blobs = [_blob(descs[shard], xys[shard]) for shard in range(shards)]
    if not content_names:
        entries = [{"path": shard_name(i), "sha256": sha256_hex(blobs[i]), "rows": rows[i]} for i in range(shards)]
        return _manifest(index, source_sha256, bank, cards, entries), blobs
    kept = [i for i in range(shards) if rows[i]] or [0]
    position = {shard: i for i, shard in enumerate(kept)}
    for card in cards:
        # A card with no row may sit in a shard that is left out: it moves to the end of the
        # nearest kept shard before it (or the first), where it adds no row.
        shard = card["shard"]
        if shard not in position:
            before = [k for k in kept if k < shard]
            target = before[-1] if before else kept[0]
            card["shard"], card["offset"] = target, rows[target] if before else 0
        card["shard"] = position[card["shard"]]
    blobs = [blobs[i] for i in kept]
    entries = [{"path": content_shard_name(blob), "sha256": sha256_hex(blob), "rows": rows[i]}
               for i, blob in zip(kept, blobs)]
    return _manifest(index, source_sha256, bank, cards, entries), blobs


def _same_card(index: DescriptorIndex, card_id: str, entry: Mapping[str, Any],
               found: tuple[np.ndarray, np.ndarray]) -> bool:
    """Whether the index's card ``card_id`` is the base manifest's ``entry``, whose rows are ``found``."""
    mine = index.cards[card_id]
    desc, xy = found
    return (entry.get("artV") == index.art_versions[card_id] and entry.get("width") == mine.size[0]
            and entry.get("height") == mine.size[1] and entry.get("n") == len(mine)
            and np.array_equal(desc, mine.descriptors)
            and xy.view(np.uint32).tobytes() == mine.xy.astype(_XY).view(np.uint32).tobytes())


def append_index(index: DescriptorIndex, source_sha256: str, base: Mapping[str, Any], base_blobs: list[bytes],
                 base_cards: Mapping[str, tuple[np.ndarray, np.ndarray]]) -> tuple[dict[str, Any], list[bytes]]:
    """The manifest and every shard's bytes (the base's, unchanged, then the new ones) of an index
    that extends the packed index ``base`` (its manifest, its shards' bytes, and its cards as
    ``unpack`` reads them). Refuses an index that does not begin with the base's cards, unchanged,
    or that was taken with other settings or another OpenCV version."""
    bank = _check_packable(index)
    named = [entry["path"] for entry in base["shards"] if entry["path"] != f"shard-{entry['sha256'][:16]}.bin"]
    if named:
        raise PackError(f"the base's shards are not named by their content (e.g. {named[:2]}), so their names can "
                        "clash with a later pack's: start a series with pack-features --content-names, without --base")
    problems = []
    differ = same_features(base.get("features") or {}, index.features)
    if differ:
        problems.append(f"other features settings (differing: {', '.join(differ)})")
    if base.get("opencv") != index.doc.get("opencv"):
        problems.append(f"another OpenCV version ({base.get('opencv')!r}, the index's is {index.doc.get('opencv')!r})")
    if problems:
        raise PackError("the base was packed from an index taken with " + " and ".join(problems)
                        + ": pack the index without --base")
    old = list(base["cards"])
    old_ids = [card["cardId"] for card in old]
    if index.ids[:len(old_ids)] != old_ids:
        raise PackError("the index does not begin with the base's cards in their order: build it with "
                        "cardvision build-features --base, or pack it without --base")
    changed = [card["cardId"] for card in old
               if not _same_card(index, card["cardId"], card, base_cards[card["cardId"]])]
    if changed:
        raise PackError(f"{len(changed)} card(s) of the base differ in the index (e.g. {changed[:3]}): build it with "
                        "cardvision build-features --base, or pack it without --base")
    shards = [dict(entry) for entry in base["shards"]]
    cap = max([entry["rows"] for entry in shards] + [1])
    cards = [dict(card) for card in old]
    blobs = list(base_blobs)
    descs: list[np.ndarray] = []
    xys: list[np.ndarray] = []
    rows = 0
    new_shards: list[tuple[list[np.ndarray], list[np.ndarray], int]] = []

    def close() -> None:
        nonlocal descs, xys, rows
        if rows:
            new_shards.append((descs, xys, rows))
        descs, xys, rows = [], [], 0

    for card_id in index.ids[len(old_ids):]:
        found = index.cards[card_id]
        n = len(found)
        if rows and rows + n > cap:
            close()
        if n == 0 and rows == 0:
            # No row to hold: the card goes at the end of the last shard there is, adding nothing.
            shard = len(shards) + len(new_shards) - 1
            offset = shards[shard]["rows"] if shard < len(shards) else new_shards[shard - len(shards)][2]
        else:
            shard, offset = len(shards) + len(new_shards), rows
            descs.append(np.ascontiguousarray(found.descriptors, dtype=np.uint8))
            xys.append(np.ascontiguousarray(found.xy, dtype=_XY))
            rows += n
        cards.append({"cardId": card_id, "artV": index.art_versions[card_id], "width": found.size[0],
                      "height": found.size[1], "shard": shard, "offset": offset, "n": n})
    close()
    for shard_descs, shard_xys, shard_rows in new_shards:
        blob = _blob(shard_descs, shard_xys)
        blobs.append(blob)
        shards.append({"path": content_shard_name(blob), "sha256": sha256_hex(blob), "rows": shard_rows})
    return _manifest(index, source_sha256, bank, cards, shards), blobs


def write_packed(folder: str | Path, manifest: dict[str, Any], blobs: list[bytes], overwrite: bool = False,
                 manifest_name: str = MANIFEST_NAME) -> bytes:
    """Write the shards and the manifest (as ``manifest_name``) into ``folder`` and return the
    manifest's bytes. Refuses to replace a file that holds other bytes unless ``overwrite``."""
    folder = Path(folder)
    body = canonical_bytes(manifest)
    files = [(folder / manifest_name, body)] + [(folder / entry["path"], blob)
                                                for entry, blob in zip(manifest["shards"], blobs)]
    if not overwrite:
        clash = [path.name for path, data in files if path.exists() and path.read_bytes() != data]
        if clash:
            raise PackError(f"{folder}: {', '.join(clash)} already exist with different content (use --overwrite)")
    folder.mkdir(parents=True, exist_ok=True)
    for path, data in files:
        path.write_bytes(data)
    return body


def read_packed(manifest_path: str | Path) -> tuple[dict[str, Any], list[bytes]]:
    """A packed index's manifest, read from ``manifest_path``, and its shards' bytes, read beside
    it. Every shard is checked against its recorded SHA-256 and row count."""
    manifest_path = Path(manifest_path)
    manifest = read_json(manifest_path)
    if not isinstance(manifest, Mapping) or manifest.get("kind") != PACKED_KIND:
        raise PackError(f"{manifest_path.name}: not a packed index manifest (kind {PACKED_KIND!r})")
    if manifest.get("schemaVersion") != PACKED_SCHEMA_VERSION:
        raise PackError(f"{manifest_path.name}: schemaVersion {manifest.get('schemaVersion')!r} is not "
                        f"{PACKED_SCHEMA_VERSION}")
    blobs = []
    for entry in manifest["shards"]:
        blob = (manifest_path.parent / entry["path"]).read_bytes()
        if hashlib.sha256(blob).hexdigest() != entry["sha256"]:
            raise PackError(f"{entry['path']}: SHA-256 does not match the manifest")
        if len(blob) != entry["rows"] * (DESCRIPTOR_BYTES + 8):
            raise PackError(f"{entry['path']}: {len(blob)} bytes is not {entry['rows']} rows")
        blobs.append(blob)
    return manifest, blobs


def unpack(folder: str | Path, manifest_name: str = MANIFEST_NAME
           ) -> tuple[dict[str, Any], dict[str, tuple[np.ndarray, np.ndarray]]]:
    """Read a packed folder back: the manifest and, per card id, ``(descriptors, xy)``. Every shard
    is checked against its recorded SHA-256 and row count."""
    manifest, blobs = read_packed(Path(folder) / manifest_name)
    out = {}
    for card in manifest["cards"]:
        blob, rows = blobs[card["shard"]], manifest["shards"][card["shard"]]["rows"]
        a, n = card["offset"], card["n"]
        desc = np.frombuffer(blob, np.uint8, rows * DESCRIPTOR_BYTES).reshape(rows, DESCRIPTOR_BYTES)[a:a + n]
        xy = np.frombuffer(blob, _XY, rows * 2, rows * DESCRIPTOR_BYTES).reshape(rows, 2)[a:a + n]
        out[card["cardId"]] = (desc.copy(), xy.astype(np.float32))
    return manifest, out


def verify_round_trip(index: DescriptorIndex, folder: str | Path, manifest_name: str = MANIFEST_NAME) -> None:
    """Raise ``PackError`` unless the packed folder holds exactly the index's keypoints: same
    cards in the same order, same descriptors, and the same positions bit for bit as ``float32``."""
    manifest, cards = unpack(folder, manifest_name)
    if [card["cardId"] for card in manifest["cards"]] != index.ids:
        raise PackError("the packed cards are not the index's, in its order")
    for card_id in index.ids:
        found = index.cards[card_id]
        desc, xy = cards[card_id]
        if not np.array_equal(desc, found.descriptors):
            raise PackError(f"{card_id}: descriptors differ after unpacking")
        if xy.shape != found.xy.shape or xy.view(np.uint32).tobytes() != found.xy.astype(np.float32).view(np.uint32).tobytes():
            raise PackError(f"{card_id}: positions differ after unpacking")


def pack_file(index_path: str | Path, out: str | Path, *, config: str | Path | None = None,
              overwrite: bool = False, base: str | Path | None = None, content_names: bool = False,
              manifest_name: str = MANIFEST_NAME) -> tuple[dict[str, Any], bytes, int]:
    """Pack the index file ``index_path`` into ``out``, the manifest as ``manifest_name``. With
    ``config``, the file's SHA-256 must be the one that settings file pins. With ``base``, the path
    of an earlier packed index's manifest (its shards beside it), keep its shards and add the new
    cards' (``append_index``); the base's shards are copied into ``out``, which may be the base's
    own folder as long as the new manifest has another name. Verifies the result by unpacking it.
    Returns the manifest, its bytes, and how many of its shards are the base's (0 without one)."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.json", manifest_name) or manifest_name.startswith("shard-"):
        raise PackError(f"{manifest_name!r}: a manifest name is a plain file name ending in .json, not shard-*")
    target = Path(out) / manifest_name
    if base is not None and (target.resolve() == Path(base).resolve()
                             or (target.exists() and os.path.samefile(target, base))):
        raise PackError(f"{Path(base).name}: the new manifest would replace the base's; give --manifest-name "
                        "another name or --out another folder")
    index_path = Path(index_path)
    digest = sha256_hex(index_path.read_bytes())
    if config is not None:
        from cardvision.geometric.config import load_geometric

        pinned = load_geometric(config).index_sha256
        if pinned != digest:
            raise PackError(f"{index_path.name}: its SHA-256 is {digest}, not the {pinned} that {Path(config).name} pins")
    try:
        index = parse_index(read_json(index_path), source=index_path.name)
    except DescriptorIndexError as error:
        raise PackError(str(error)) from None
    kept = 0
    if base is None:
        manifest, blobs = pack_index(index, digest, content_names=content_names)
    else:
        base_manifest, base_blobs = read_packed(base)
        _, base_cards = unpack(Path(base).parent, Path(base).name)
        manifest, blobs = append_index(index, digest, base_manifest, base_blobs, base_cards)
        kept = len(base_manifest["shards"])
    body = write_packed(out, manifest, blobs, overwrite, manifest_name)
    verify_round_trip(index, out, manifest_name)
    return manifest, body, kept


__all__ = ["PACKED_KIND", "PACKED_SCHEMA_VERSION", "SHARDS", "PackError", "append_index", "content_shard_name",
           "pack_file", "pack_index", "read_packed", "unpack", "verify_round_trip", "write_packed"]
