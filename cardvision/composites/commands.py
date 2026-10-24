# SPDX-License-Identifier: Apache-2.0
"""The scene generator's subcommands of the ``cardvision`` command line: ``make-composites``
and ``fetch-textures``, each as a summary, a function that declares its arguments and a
function that runs it and returns the exit code."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from pathlib import Path


def _fail(command: str, messages: list[str] | str) -> int:
    lines = [messages] if isinstance(messages, str) else messages
    print(f"cardvision {command}: failed", file=sys.stderr)
    for line in lines:
        print(f"  - {line}", file=sys.stderr)
    return 1


# --------------------------------------------------------------------------- make-composites
def _make_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--catalog", required=True, type=Path, help="the game's catalog file")
    parser.add_argument("--art", required=True, type=Path,
                        help="the folder of card images that the catalog's art paths point into")
    parser.add_argument("--out", required=True, type=Path,
                        help="the folder to write: images/, labels.jsonl and manifest.json")
    parser.add_argument("--n", required=True, type=int, help="how many scenes to generate")
    parser.add_argument("--seed", required=True, type=int,
                        help="any non-negative whole number; the same seed gives the same scenes")
    parser.add_argument("--split", choices=["train", "val"], default="train",
                        help="which set of scenes: the two never share a scene or a background scan "
                             "(default: train)")
    parser.add_argument("--textures", type=Path,
                        help="a folder written by fetch-textures: half the scenes then lie on a scanned "
                             "surface (default: generated backgrounds only)")
    parser.add_argument("--kinds", type=Path,
                        help='a JSON file with a "kinds" object to use in place of the catalog\'s')
    parser.add_argument("--card-size", default="63x88", metavar="WxH",
                        help="the size of an upright card in millimeters, width then height; it sets the "
                             "shape of the layouts, the generated backs and the card-shaped distractors "
                             "(default: 63x88)")
    parser.add_argument("--closeups", type=float, default=0.0, metavar="SHARE",
                        help="the share of scenes, from 0 to 1, drawn as close-ups: one large card, sometimes two, "
                             "tilted 15 to 45 degrees toward the camera, as in a digital client's summon or "
                             "activation shot or a webcam close over the table. The other scenes stay the same "
                             "(default: 0, none)")
    parser.add_argument("--workers", type=int, default=1,
                        help="processes to spread the work over; the output does not depend on it (default: 1)")
    parser.add_argument("--check", action="store_true",
                        help="after generating, check the labels against the images and print the report")
    parser.add_argument("--overwrite", action="store_true", help="replace scenes already in the output folder")


def _make(args: argparse.Namespace) -> int:
    from cardvision.composites.cards import load_kinds
    from cardvision.composites.dataset import generate, positive_cards
    from cardvision.composites.geometry import card_aspect, parse_card_size
    from cardvision.composites.scene import Settings
    from cardvision.composites.validate import validate_labels
    from cardvision.core.catalog import CatalogError, load_catalog

    def progress(done: int, total: int) -> None:
        if done % 50 == 0 or done == total:
            print(f"  {done} / {total} scenes", file=sys.stderr, flush=True)

    try:
        aspect = card_aspect(*parse_card_size(args.card_size))
        if not args.art.is_dir():
            raise FileNotFoundError(f"{args.art}: no such folder of card images")
        catalog = load_catalog(args.catalog)
        settings = Settings(closeups=args.closeups)
        kinds = load_kinds(args.kinds) if args.kinds else None
        manifest = generate(catalog, args.art, args.out, args.n, seed=args.seed, split=args.split,
                            textures_dir=args.textures, settings=settings, kinds=kinds, workers=args.workers,
                            overwrite=args.overwrite, progress=progress, card_aspect=aspect)
    except (CatalogError, OSError, ValueError) as error:
        return _fail("make-composites", str(error))
    counts = manifest["counts"]
    # A positive face is one a detector should find. The others show too little of the card or
    # are too small, and the labels mark them as ignore regions.
    print(f"wrote {counts['scenes']} scenes to {args.out}: {counts['positiveFaces']} positive faces showing "
          f"{positive_cards(args.out)} different cards, {sum(counts['ignoredFaces'].values())} more faces marked as "
          f"ignore regions (too hidden or too small), {counts['objects'].get('back', 0)} backs")
    no_art = len(catalog.ids_without_art())
    if no_art:
        print(f"note: {no_art} catalog cards have no art (\"art\": null) and were left out", file=sys.stderr)
    if manifest["catalog"]["cardsWithoutArt"] > no_art:
        print(f"note: {manifest['catalog']['cardsWithoutArt'] - no_art} catalog cards have no image in {args.art} "
              "and were left out", file=sys.stderr)
    if args.check:
        report = validate_labels(args.out, catalog, args.art)
        print(json.dumps(report, indent=1))
        if report["problemCount"]:
            return _fail("make-composites", f"{report['problemCount']} label problem(s); the first are listed above")
    return 0


# ---------------------------------------------------------------------------- fetch-textures
def _fetch_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--index", required=True, type=Path,
                        help="the asset list (cardvision/composites/cc0_textures.json, or one of the same shape)")
    parser.add_argument("--out", required=True, type=Path, help="the folder to download into")
    parser.add_argument("--delay", type=float, default=0.3,
                        help="seconds to wait after each request (default: 0.3)")


def _fetch(args: argparse.Namespace) -> int:
    from cardvision.composites.fetch import FetchError, fetch_textures

    try:
        summary = fetch_textures(args.index, args.out, delay=args.delay, log=lambda line: print(line, flush=True))
    except (FetchError, OSError, ValueError) as error:
        return _fail("fetch-textures", str(error))
    print(f"{summary['downloaded']} downloaded, {summary['present']} already there, "
          f"{len(summary['failed'])} failed, of {summary['assets']} scans")
    if summary["failed"]:
        return _fail("fetch-textures", [f"{item['source']} {item['assetId']}: {item['reason']}"
                                        for item in summary["failed"]])
    return 0


Command = tuple[str, Callable[[argparse.ArgumentParser], None], Callable[[argparse.Namespace], int]]
COMMANDS: dict[str, Command] = {
    "make-composites": ("Generate labeled training scenes from card images.", _make_arguments, _make),
    "fetch-textures": ("Download and verify the CC0 background scans in an asset list.", _fetch_arguments, _fetch),
}
