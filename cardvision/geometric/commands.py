# SPDX-License-Identifier: Apache-2.0
"""The ``cardvision build-features`` subcommand: the geometric stage's descriptor index.

::

    cardvision build-features --config G.json --catalog C.json --art DIR_OR_URL
        [--bank B.json] [--base OLD.features.json] [--out FILE] [--pin] [--skip-missing-art] [--overwrite]

Reads the ``features`` block of the settings file, takes each card's keypoints from its image
and writes the index (``cardvision.geometric.index``): to ``--out``, else to the path the
settings file names, else beside ``--bank`` as ``<bank>.features.json``. With ``--bank`` the
index holds the bank's cards in the bank's order and records the bank's SHA-256; every bank card
must then have its image, and it must be the image the bank row records (``artV``): otherwise
the bank was embedded from a different image and must be refreshed first. ``--skip-missing-art``
is for an index without a bank. The index's SHA-256 is printed; ``--pin`` writes it, with the index's path, into the settings file, which
is how the stage finds the index and knows it is the one it was tuned with.

``--base`` extends an older index instead of building one from nothing: its cards are copied
unchanged and first, and keypoints are taken only from the new cards' images. The old cards'
images are still read and hashed to check them, without a bank or where the bank's row records
no image (``cardvision.geometric.index``, "Adding cards to an index"). ``pack-features --base``
then keeps the old shards as they are.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SUMMARY = "Build the geometric stage's descriptor index from card images (optional stage)."


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", required=True, type=Path, help="the geometric stage's settings file")
    parser.add_argument("--catalog", required=True, type=Path, help="the game's catalog file")
    parser.add_argument("--art", required=True, help="the folder, or the http(s) URL prefix, of the card images")
    parser.add_argument("--bank", type=Path,
                        help="the bank the index goes with: its cards, in its order, and its SHA-256 are recorded")
    parser.add_argument("--base", type=Path,
                        help="an older index to extend: its cards are kept unchanged and first, new cards follow")
    parser.add_argument("--out", type=Path,
                        help="where to write the index (default: the settings file's index.path, else beside --bank)")
    parser.add_argument("--pin", action="store_true",
                        help="write the index's path and SHA-256 into the settings file")
    parser.add_argument("--skip-missing-art", action="store_true",
                        help="leave out cards whose image is not found, instead of stopping")
    parser.add_argument("--overwrite", action="store_true", help="replace an existing index file")


def _fail(message: str) -> int:
    print(f"cardvision build-features: failed\n  - {message}", file=sys.stderr)
    return 1


def run(args: argparse.Namespace) -> int:
    from cardvision.bank.documents import DocumentExistsError, canonical_bytes, read_json, sha256_hex, write_document
    from cardvision.core.catalog import CatalogError, load_catalog
    from cardvision.evaluate.config import file_sha256
    from cardvision.geometric.config import load_geometric
    from cardvision.geometric.index import build_index, index_path_for

    def progress(done: int, total: int) -> None:
        if done % 500 == 0 or done == total:
            print(f"  {done} / {total} cards", flush=True)

    try:
        config = load_geometric(args.config)
        out = args.out or config.index_path or (index_path_for(args.bank) if args.bank else None)
        if out is None:
            return _fail("give --out, an index.path in the settings file, or --bank")
        catalog = load_catalog(args.catalog)
        bank = read_json(args.bank) if args.bank else None
        base = read_json(args.base) if args.base else None
        doc, skipped = build_index(catalog, args.art, config.features, bank=bank,
                                   bank_sha256=file_sha256(args.bank) if args.bank else None,
                                   skip_missing_art=args.skip_missing_art, progress=progress, base=base)
        body = canonical_bytes(doc)
        write_document(out, body, args.overwrite)
    except (CatalogError, DocumentExistsError, OSError, ValueError, ImportError) as error:
        return _fail(str(error))
    digest = sha256_hex(body)
    print(f"index: {out} ({doc['cardCount']} cards, {doc['featureCount']} keypoints, "
          f"{len(body) / 1e6:.1f} MB)")
    print(f"sha256: {digest}")
    if base is not None:
        print(f"kept from the base index: {len(base['cards'])} cards, unchanged; added: "
              f"{doc['cardCount'] - len(base['cards'])}")
    if skipped:
        print(f"left out, no image found ({len(skipped)}): {', '.join(skipped)}")
    if args.pin:
        raw = json.loads(Path(args.config).read_text(encoding="utf-8"))
        relative = os.path.relpath(Path(out).resolve(), Path(args.config).resolve().parent)
        raw["index"] = {"path": Path(relative).as_posix(), "sha256": digest}
        Path(args.config).write_bytes(canonical_bytes(raw))
        print(f"pinned in {args.config}")
    else:
        print('pin it in the settings file as "index": {"path": ..., "sha256": ...} (or run again with --pin)')
    return 0


PACK_SUMMARY = "Repack a pinned descriptor index into manifest + shards for the browser runtime."


def add_pack_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--index", required=True, type=Path, help="the descriptor index file (build-features output)")
    parser.add_argument("--out", required=True, type=Path, help="the folder to write manifest.json and the shards to")
    parser.add_argument("--config", type=Path,
                        help="the settings file that pins the index: refuse an index whose SHA-256 differs")
    parser.add_argument("--base", type=Path,
                        help="the manifest of an earlier pack, its shards beside it: keep those shards unchanged and "
                             "put only the new cards in new shards named by content (the index must come from "
                             "build-features --base)")
    parser.add_argument("--content-names", action="store_true",
                        help="without --base: name the shards by content, to start a series that --base extends")
    parser.add_argument("--manifest-name", default="manifest.json",
                        help="the manifest's file name in --out (default manifest.json); with --base into the base's "
                             "own folder, a name other than the base manifest's")
    parser.add_argument("--overwrite", action="store_true", help="replace existing files that hold other bytes")


def run_pack(args: argparse.Namespace) -> int:
    from cardvision.bank.documents import sha256_hex
    from cardvision.geometric.config import GeometricConfigError
    from cardvision.geometric.pack import PackError, pack_file

    if args.base is not None and args.content_names:
        print("cardvision pack-features: failed\n  - --content-names is for a pack without --base "
              "(with --base, new shards are always named by content)", file=sys.stderr)
        return 1
    try:
        manifest, body, kept = pack_file(args.index, args.out, config=args.config, overwrite=args.overwrite,
                                         base=args.base, content_names=args.content_names,
                                         manifest_name=args.manifest_name)
    except (PackError, GeometricConfigError, OSError, ValueError) as error:
        print(f"cardvision pack-features: failed\n  - {error}", file=sys.stderr)
        return 1
    rows = sum(shard["rows"] for shard in manifest["shards"])
    print(f"packed: {args.out} ({len(manifest['cards'])} cards, {rows} keypoints, {len(manifest['shards'])} shards, "
          f"{rows * 40 / 1e6:.1f} MB)")
    if args.base is not None:
        added = manifest["shards"][kept:]
        print(f"kept from the base: {kept} shards, unchanged; new: {len(added)} shards, "
              f"{sum(shard['rows'] for shard in added) * 40 / 1e6:.1f} MB "
              f"({', '.join(shard['path'] for shard in added) or 'none'})")
    print(f"manifest sha256: {sha256_hex(body)}")
    print("round trip: ok (descriptors and float32 positions identical to the index)")
    return 0


COMMANDS = {"build-features": (SUMMARY, add_arguments, run),
            "pack-features": (PACK_SUMMARY, add_pack_arguments, run_pack)}
