# SPDX-License-Identifier: Apache-2.0
"""The ``cardvision`` command line.

One entry point with subcommands. Each tool registers itself in ``SUBCOMMANDS``; with no
subcommand given, the program lists what is available.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence

from cardvision import __version__
from cardvision.bank.commands import COMMANDS as BANK_COMMANDS
from cardvision.calibrate import cli as calibrate_cli
from cardvision.check_catalog import SUMMARY as CHECK_CATALOG_SUMMARY
from cardvision.check_catalog import add_arguments as check_catalog_arguments
from cardvision.check_catalog import run as check_catalog_run
from cardvision.composites.commands import COMMANDS as COMPOSITE_COMMANDS
from cardvision.data.commands import COMMANDS as DATA_COMMANDS
from cardvision.evaluate import cli as evaluate_cli
from cardvision.export import cli as export_cli
from cardvision import fetch_weights as fetch_weights_cli
from cardvision.geometric.commands import COMMANDS as GEOMETRIC_COMMANDS
from cardvision.import_catalog import cli as import_catalog_cli
from cardvision.infer import cli as infer_cli
from cardvision import next_step as next_cli
from cardvision.train_detector import cli as train_detector_cli
from cardvision.train_recognizer import cli as train_recognizer_cli
from cardvision.try_game import cli as try_cli

# name -> (one-line help, function that adds the subcommand's arguments to its parser,
#          function that runs it and returns the process exit code)
Subcommand = tuple[str, Callable[[argparse.ArgumentParser], None], Callable[[argparse.Namespace], int]]
SUBCOMMANDS: dict[str, Subcommand] = {
    **BANK_COMMANDS,  # build-bank, check-refresh, check-bank-art, build-release, verify-release, convert-release
    **COMPOSITE_COMMANDS,  # make-composites, fetch-textures
    **DATA_COMMANDS,  # validate-manifest, assign-roles, fetch, record-reachable
    **GEOMETRIC_COMMANDS,  # build-features, pack-features (the optional geometric stage)
    "check-catalog": (CHECK_CATALOG_SUMMARY, check_catalog_arguments, check_catalog_run),
    "calibrate": (calibrate_cli.SUMMARY, calibrate_cli.add_arguments, calibrate_cli.run),
    "evaluate": (evaluate_cli.SUMMARY, evaluate_cli.add_arguments, evaluate_cli.run),
    "export": (export_cli.SUMMARY, export_cli.add_arguments, export_cli.run),
    "import-catalog": (import_catalog_cli.SUMMARY, import_catalog_cli.add_arguments, import_catalog_cli.run),
    "fetch-weights": (fetch_weights_cli.SUMMARY, fetch_weights_cli.add_arguments, fetch_weights_cli.run),
    "infer": (infer_cli.SUMMARY, infer_cli.add_arguments, infer_cli.run),
    "next": (next_cli.SUMMARY, next_cli.add_arguments, next_cli.run),
    "train-detector": (train_detector_cli.SUMMARY, train_detector_cli.add_arguments, train_detector_cli.run),
    "train-recognizer": (train_recognizer_cli.SUMMARY, train_recognizer_cli.add_arguments, train_recognizer_cli.run),
    "try": (try_cli.SUMMARY, try_cli.add_arguments, try_cli.run),
}


# The order a newcomer meets the commands in. Every registered command is in exactly one group
# (tests/test_cli.py pins it); a command registered but not listed here is shown under "Other".
GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Start here", ("next", "try", "import-catalog", "check-catalog", "check-bank-art", "build-bank", "infer", "build-release",
                    "verify-release", "convert-release", "fetch-weights")),
    ("Train", ("make-composites", "fetch-textures", "train-recognizer", "train-detector", "export")),
    ("Measure", ("evaluate", "calibrate", "check-refresh", "build-features", "pack-features")),
    ("Data", ("validate-manifest", "fetch", "record-reachable", "assign-roles")),
)


def available_subcommands() -> str:
    """A printable list of the registered subcommands, in groups."""
    if not SUBCOMMANDS:
        return "Available subcommands: none yet."
    width = max(len(name) for name in SUBCOMMANDS)
    grouped = [(title, [name for name in names if name in SUBCOMMANDS]) for title, names in GROUPS]
    listed = {name for _title, names in grouped for name in names}
    grouped.append(("Other", sorted(set(SUBCOMMANDS) - listed)))
    lines = ["Available subcommands:"]
    for title, names in grouped:
        if names:
            lines += ["", f"{title}:", *(f"  {name.ljust(width)}  {SUBCOMMANDS[name][0]}" for name in names)]
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    """The argument parser, with one sub-parser per registered subcommand."""
    parser = argparse.ArgumentParser(prog="cardvision", description="Card detection and recognition tools.",
                                     epilog=available_subcommands(),
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", action="version", version=f"cardvision {__version__}")
    if SUBCOMMANDS:
        sub = parser.add_subparsers(dest="command", metavar="COMMAND")
        for name, (summary, add_arguments, run) in sorted(SUBCOMMANDS.items()):
            child = sub.add_parser(name, help=summary, description=summary)
            add_arguments(child)
            child.set_defaults(_run=run)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command line and return the process exit code."""
    args = build_parser().parse_args(argv)
    run = getattr(args, "_run", None)
    if run is None:
        print(f"cardvision {__version__}")
        print(available_subcommands())
        return 0
    return run(args)
