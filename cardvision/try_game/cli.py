# SPDX-License-Identifier: Apache-2.0
"""The ``cardvision try`` subcommand: a card list, card images and a video in; a catalog, a
bank, a release folder, the names found on the video and a report page out."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SUMMARY = "Run the released models on your own game in one command: card list, images and a video in, a report out."

DEFAULT_MAX_FRAMES = 60


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Declare the subcommand's arguments."""
    parser.add_argument("cards", type=Path, metavar="CARDS",
                        help="your card list (.csv, .tsv or a .json list of rows), or a catalog, used as it is")
    parser.add_argument("--images", required=True, type=Path, metavar="DIR",
                        help="the folder of card images, named as the list's image column says")
    parser.add_argument("--video", required=True, type=Path, metavar="FILE_OR_IMAGE_OR_FOLDER",
                        help="a video of your game, a photo or screenshot, or a folder of images")
    parser.add_argument("--out", type=Path, metavar="DIR",
                        help="the folder to write into (default: cardvision-try beside CARDS); it must lie outside "
                             "the repository")
    weights = parser.add_mutually_exclusive_group()
    weights.add_argument("--weights", type=Path, metavar="DIR",
                         help="a folder holding detector.onnx, recognizer.onnx and accept.json, such as the one "
                              "fetch-weights fills or a release folder (default: OUT/weights)")
    weights.add_argument("--download", action="store_true",
                         help="when OUT/weights does not hold the released weights, download them there with "
                              "fetch-weights first (needs the network)")
    parser.add_argument("--game", default="my-game", help="a short name for the game, the catalog's \"game\" "
                                                          "(default my-game)")
    parser.add_argument("--map", action="append", metavar="FIELD=HEADER",
                        help="passed to import-catalog: the column for a field, such as --map id=\"Collector #\"")
    parser.add_argument("--identity", choices=("name", "printing"),
                        help="passed to import-catalog: which entries are one card")
    parser.add_argument("--facets", action="append", metavar="COL[,COL...]",
                        help="passed to import-catalog: columns that become facets")
    parser.add_argument("--delimiter", metavar="CHAR",
                        help="passed to import-catalog: the character between a CSV's cells, when not a comma")
    parser.add_argument("--every", type=float, metavar="SECONDS",
                        help="for a video, the time between analyzed frames (default: chosen so that at most "
                             "--max-frames frames are analyzed, and never under 1 second; a video that does not "
                             "state its length is read once to measure it)")
    parser.add_argument("--max-frames", type=int, default=DEFAULT_MAX_FRAMES, metavar="N",
                        help=f"the most frames analyzed when --every is not given, and the most images taken from a "
                             f"folder (default {DEFAULT_MAX_FRAMES})")
    parser.add_argument("--overwrite", action="store_true",
                        help="replace what an earlier run of try wrote in OUT (as its .cardvision-try file lists), "
                             "once the new run has succeeded; other files are never replaced")


def run(args: argparse.Namespace) -> int:
    """Run the subcommand; returns the process exit code."""
    from cardvision.try_game.run import TryError, run_try

    try:
        return run_try(args)
    except TryError as error:
        print("cardvision try: failed", file=sys.stderr)
        for line in error.lines:
            print(f"  - {line}", file=sys.stderr)
        return 1
