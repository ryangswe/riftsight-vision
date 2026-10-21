# SPDX-License-Identifier: Apache-2.0
"""The ``cardvision import-catalog`` subcommand: a card list in, a catalog out.

The report goes to standard output, and to a JSON file with ``--report``. Progress of the
downloads goes to standard error. The exit code is 0 when a catalog was written (a download
that failed is reported, and leaves its card without art), and 1 when nothing was.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SUMMARY = "Write a catalog from a card list you already have (CSV, TSV or JSON)."


def _pairs(values: list[str] | None, flag: str) -> list[tuple[str, str]]:
    out = []
    for value in values or []:
        name, equals, rest = value.partition("=")
        if not equals or not name.strip():
            raise SystemExit(f"cardvision import-catalog: {flag} {value!r}: expected NAME=VALUE")
        out.append((name.strip(), rest))
    return out


def _columns(values: list[str] | None) -> list[str]:
    return [column.strip() for value in values or [] for column in value.split(",") if column.strip()]


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Declare the subcommand's arguments."""
    parser.add_argument("source", type=Path, metavar="CARDS",
                        help="the card list: a .csv, a .tsv, or a .json list of rows (or {\"cards\": [...]})")
    parser.add_argument("--out", required=True, type=Path, help="the catalog to write; an existing file is refused")
    parser.add_argument("--overwrite", action="store_true", help="replace --out when it exists")
    parser.add_argument("--force", dest="overwrite", action="store_true", help=argparse.SUPPRESS)  # the old name
    parser.add_argument("--game", required=True, help="a short name for the game, the catalog's \"game\"")
    parser.add_argument("--locale", default="en", help="the language of the card names (default en)")
    parser.add_argument("--identity", choices=("name", "printing"),
                        help="which entries are one card; left out, the rule the report suggests is written")
    parser.add_argument("--format", dest="input_format", choices=("csv", "tsv", "json"),
                        help="the card list's format, when its suffix does not say")
    parser.add_argument("--delimiter", metavar="CHAR",
                        help="the character between a CSV's cells, when it is not a comma (--delimiter ';'); "
                             "CSV only")
    parser.add_argument("--map", action="append", metavar="FIELD=HEADER",
                        help="the column for a field (id, name, kind, printing_of, image), over the headers found "
                             "by themselves; may be given more than once")
    parser.add_argument("--facets", action="append", metavar="COL[,COL...]",
                        help="columns that become facets, the labeling tool's filters; a column whose every value is "
                             "a number becomes a number facet")
    parser.add_argument("--split", action="append", metavar="COL=SEP",
                        help="a facet or extra column whose cells hold several values, and the text between them "
                             "(--split color=;); may be given more than once")
    extra = parser.add_mutually_exclusive_group()
    extra.add_argument("--extra", action="append", metavar="COL[,COL...]",
                       help="columns that go to each card's \"extra\" object; left out, every column that is no "
                            "field and no facet goes there")
    extra.add_argument("--no-extra", action="store_true", help="write no \"extra\": leave the other columns out")
    parser.add_argument("--images", type=Path, metavar="DIR",
                        help="the folder the image column's file paths are relative to (and checked in)")
    parser.add_argument("--art-out", type=Path, metavar="DIR",
                        help="with --download, where images given as URLs are downloaded (default: an art folder beside --out)")
    parser.add_argument("--download", action="store_true",
                        help="download the images given as URLs into --art-out; without it they stay URLs and "
                             "nothing reaches the network")
    parser.add_argument("--delay", type=float, default=1.0, metavar="SECONDS",
                        help="seconds between two downloads (default 1.0)")
    parser.add_argument("--report", type=Path, metavar="FILE", help="also write the report as JSON")


def run(args: argparse.Namespace) -> int:
    """Run the subcommand; returns the process exit code."""
    from cardvision.core.tls import CertificatesMissing
    from cardvision.import_catalog.importer import CatalogImportError, ImportOptions, import_catalog

    if args.delay < 0:
        print("cardvision import-catalog: --delay must be 0 or more", file=sys.stderr)
        return 1
    options = ImportOptions(
        game=args.game, locale=args.locale, identity=args.identity, mapping=dict(_pairs(args.map, "--map")),
        facets=_columns(args.facets), splits=dict(_pairs(args.split, "--split")),
        extra=[] if args.no_extra else (_columns(args.extra) if args.extra else None),
        images=args.images, art_out=args.art_out, download=args.download, delay=args.delay,
        input_format=args.input_format, delimiter=args.delimiter)
    try:
        report = import_catalog(args.source, args.out, options, force=args.overwrite,
                                progress=lambda line: print(f"  {line}", file=sys.stderr, flush=True))
    except (CatalogImportError, CertificatesMissing, OSError) as error:
        print(f"cardvision import-catalog: failed\n  - {error}", file=sys.stderr)
        return 1
    for line in report.lines():
        print(line)
    if args.report is not None:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report.as_dict(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0 if report.written else 1
