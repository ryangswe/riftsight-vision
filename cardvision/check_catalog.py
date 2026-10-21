# SPDX-License-Identifier: Apache-2.0
"""The ``cardvision check-catalog`` subcommand: is this catalog one the tools can read?

Loads the catalog as every other command does and prints what it holds. With ``--art`` it then
looks at the image of every card, as ``check-bank-art`` does without a bank. The exit code is 1
when the catalog cannot be loaded, with the loader's message.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SUMMARY = "Check that a catalog loads, count its cards, and optionally look at their images."


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Declare the subcommand's arguments."""
    parser.add_argument("catalog", type=Path, metavar="CATALOG", help="the game's catalog file")
    parser.add_argument("--art", metavar="DIR_OR_URL",
                        help="also look at the image of every card: the folder, or the http(s) URL prefix, that "
                             "each card's art is resolved against (the check `check-bank-art` makes with no bank)")


def run(args: argparse.Namespace) -> int:
    """Run the subcommand; returns the process exit code."""
    from cardvision.core.catalog import CatalogError, load_catalog

    try:
        catalog = load_catalog(args.catalog)
    except CatalogError as error:
        print(f"cardvision check-catalog: failed\n  - {error}\n  - fix the catalog, or write it again with "
              "`cardvision import-catalog`", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"cardvision check-catalog: failed\n  - {args.catalog}: {error.strerror or error}\n"
              "  - check the path to the catalog file", file=sys.stderr)
        return 1
    without_art = sum(1 for card in catalog if not card.has_art)
    print(f"{len(catalog)} cards ({without_art} without art), identity rule: {catalog.identity}, "
          f"game: {catalog.game}")
    if args.art is None:
        return 0
    from cardvision.bank.commands import _check_art

    return _check_art(argparse.Namespace(catalog=args.catalog, art=args.art))
