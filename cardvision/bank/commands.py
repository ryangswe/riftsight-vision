# SPDX-License-Identifier: Apache-2.0
"""The bank and release subcommands of the ``cardvision`` command line.

This module only describes the commands; the work is imported when a command runs, so that
listing the commands does not load the inference library.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable
from pathlib import Path


def _fail(command: str, messages: list[str] | str) -> int:
    lines = [messages] if isinstance(messages, str) else messages
    print(f"cardvision {command}: failed", file=sys.stderr)
    for line in lines:
        print(f"  - {line}", file=sys.stderr)
    return 1


# ------------------------------------------------------------------------------- build-bank
def _build_bank_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--catalog", required=True, type=Path, help="the game's catalog file")
    parser.add_argument("--art", required=True,
                        help="the folder, or the http(s) URL prefix, that each card's art is resolved against")
    parser.add_argument("--recognizer", required=True, type=Path, help="the recognizer, as an ONNX file")
    parser.add_argument("--out", required=True, type=Path,
                        help="where to write the bank; its identity groups are written beside it")
    parser.add_argument("--base", type=Path,
                        help="an existing bank to extend: its rows keep their order, a row is embedded again "
                             "only when the image it records (artV) differs from the image now under --art, "
                             "and the catalog's other cards are embedded and appended")
    parser.add_argument("--reembed-unrecorded", action="store_true",
                        help="with --base: also embed again the rows of the base bank that record no image, "
                             "instead of keeping them as they are; check-refresh refuses each one whose "
                             "vector changes")
    parser.add_argument("--groups-out", type=Path,
                        help="where to write the identity groups (default: <out>.identity-groups.json)")
    parser.add_argument("--model",
                        help="label for the recognizer, written into the bank (default: the base bank's, "
                             "or the recognizer file's name)")
    parser.add_argument("--version", type=int,
                        help="the bank's version number (default: 1, or one more than the base bank's)")
    parser.add_argument("--tau", type=float,
                        help="record this accept threshold in the bank, for runtimes that read it there")
    parser.add_argument("--skip-missing-art", action="store_true",
                        help="leave out cards whose image is not found, instead of stopping")
    parser.add_argument("--overwrite", action="store_true", help="replace existing output files")


def _base_rule(base: Path) -> object:
    """The identity rule the base bank's groups were made by, read from the groups file beside
    the base bank, as ``check-refresh`` finds it. ``None`` when there is no such file, when it
    cannot be read, or when it records no rule: nothing is known then, and nothing is said."""
    from cardvision.bank.build import groups_path_for
    from cardvision.bank.documents import read_json
    from cardvision.bank.refresh import recorded_rule

    try:
        return recorded_rule(read_json(groups_path_for(base)))
    except (OSError, ValueError):
        return None


def _build_bank(args: argparse.Namespace) -> int:
    from cardvision.bank.build import BankBuildError, build_bank, write_bank
    from cardvision.bank.documents import DocumentExistsError
    from cardvision.bank.refresh import check_refresh
    from cardvision.bank.suspect import Suspects, bank_suspects, suspect_lines
    from cardvision.core.bank_binary import read_bank_file
    from cardvision.core.catalog import CatalogError, load_catalog
    from cardvision.core.onnx import create_session

    def progress(done: int, total: int) -> None:
        if done % 100 == 0 or done == total:
            print(f"  {done} / {total} cards", flush=True)

    if args.reembed_unrecorded and not args.base:
        return _fail("build-bank", "--reembed-unrecorded needs --base: it is about the rows of a base bank")
    try:
        catalog = load_catalog(args.catalog)
        base = read_bank_file(args.base) if args.base else None
        model = args.model or (None if base is not None else args.recognizer.stem)
        session = create_session(args.recognizer)
        build = build_bank(catalog, args.art, session, model=model, version=args.version, base=base,
                           tau=args.tau, skip_missing_art=args.skip_missing_art,
                           reembed_unrecorded=args.reembed_unrecorded, progress=progress)
        # Rows embedded again: because their image changed, or (asked for) because none was recorded.
        changed = [card_id for card_id in build.reembedded if build.art_versions[card_id][0] is not None]
        asked = [card_id for card_id in build.reembedded if build.art_versions[card_id][0] is None]
        unverified: list[str] = []
        if base is not None:
            report = check_refresh(base, build.bank, reembedded_unrecorded=asked)
            if not report.ok:
                return _fail("build-bank", report.errors)
            unverified = report.unverified
        base_rule = _base_rule(args.base) if args.base else None   # read before a build in place replaces the file
        bank_path, groups_path = write_bank(build.bank, catalog, args.out, args.groups_out, args.overwrite)
    except (BankBuildError, CatalogError, DocumentExistsError, OSError, ValueError) as error:
        return _fail("build-bank", str(error))
    again = f"{len(build.reembedded)} re-embedded, " if build.reembedded else ""
    print(f"bank: {bank_path} ({build.bank['entryCount']} rows of {build.bank['dim']} values; "
          f"{len(build.embedded)} embedded, {again}{len(build.reused)} kept from the base bank)")
    if changed:
        print(f"re-embedded, image changed ({len(changed)}):")
        for card_id in changed:
            before, after = build.art_versions[card_id]
            print(f"  {card_id}  artV {before} -> {after}")
    if asked:
        print(f"re-embedded, image not recorded ({len(asked)}): {', '.join(asked)}")
    if unverified:
        print(f"of those, the new row differs from the base row ({len(unverified)}): {', '.join(unverified)}")
        print("  check-refresh reports these rows as errors: the base bank records no image that explains the change")
    if build.unrecorded:
        print(f"image not recorded, reused ({len(build.unrecorded)}): {', '.join(build.unrecorded)}")
    if build.art_missing:
        print(f"image not found, not compared, reused ({len(build.art_missing)}): {', '.join(build.art_missing)}")
    if build.skipped:
        print(f"left out, no image found ({len(build.skipped)}): {', '.join(build.skipped)}")
    if build.no_art:
        print(f"{len(build.no_art)} card(s) have no art and are not in the bank: {_some_ids(build.no_art)}")
    if build.no_art_kept:
        print(f"{len(build.no_art_kept)} row(s) kept for cards the catalog now lists without art: "
              f"{_some_ids(build.no_art_kept)}; build without --base to drop them (not an additive refresh)")
    print(f"identity groups: {groups_path}")
    if base_rule is not None and base_rule != catalog.identity:
        print(f'the base bank\'s identity groups were made by the "{base_rule}" rule and this catalog states the '
              f'"{catalog.identity}" rule: check-refresh will refuse to treat this bank as a refresh of the base bank')
    # What deserves a second look. It is a list for a person, and never a failure: a row kept
    # from the base bank that has no direction (all zeros) can be compared with nothing.
    try:
        found = bank_suspects(build.bank, catalog)
    except ValueError as error:
        found = Suspects()
        print(f"the cards that share an image file or a bank row could not be listed: {error}")
    found.placeholders = build.placeholders
    if found:
        print("look at these before you rely on the bank:")
        for line in suspect_lines(found):
            print(f"  {line}")
    return 0


# ---------------------------------------------------------------------------- check-refresh
def _check_refresh_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("old_bank", type=Path, metavar="OLD_BANK")
    parser.add_argument("new_bank", type=Path, metavar="NEW_BANK")
    parser.add_argument("--old-groups", type=Path,
                        help="the old bank's identity groups (default: the file beside the old bank)")
    parser.add_argument("--new-groups", type=Path,
                        help="the new bank's identity groups (default: the file beside the new bank)")
    parser.add_argument("--bank-only", action="store_true", help="compare the banks and not their identity groups")


def _check_refresh(args: argparse.Namespace) -> int:
    from cardvision.bank.build import groups_path_for
    from cardvision.bank.documents import read_json
    from cardvision.bank.refresh import check_refresh
    from cardvision.core.bank_binary import read_bank_file

    try:
        old_bank, new_bank = read_bank_file(args.old_bank), read_bank_file(args.new_bank)
        old_groups = new_groups = None
        if not args.bank_only:
            old_path = args.old_groups or groups_path_for(args.old_bank)
            new_path = args.new_groups or groups_path_for(args.new_bank)
            absent = [str(path) for path in (old_path, new_path) if not path.is_file()]
            if absent:
                return _fail("check-refresh", [f"no identity groups file at {path}" for path in absent]
                             + ["name the files with --old-groups and --new-groups, or pass --bank-only"])
            old_groups, new_groups = read_json(old_path), read_json(new_path)
    except (OSError, ValueError) as error:
        return _fail("check-refresh", str(error))
    report = check_refresh(old_bank, new_bank, old_groups, new_groups)
    if not report.ok:
        return _fail("check-refresh", report.errors)
    print(f"ok: {report.shared} shared rows, in the same order: {report.identical} byte-identical, "
          f"{len(report.reembedded)} re-embedded (image changed); {len(report.added)} card id(s) added"
          + ("" if args.bank_only else "; identity groups only grew"))
    if report.reembedded:
        print(f"re-embedded (image changed) ({len(report.reembedded)}):")
        for card_id, before, after in report.reembedded:
            print(f"  {card_id}  artV {before} -> {after}")
    for note in report.notes:
        print(f"note: {note}")
    return 0


# --------------------------------------------------------------------------- check-bank-art
def _check_bank_art_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("bank", type=Path, metavar="BANK", nargs="?",
                        help="the bank to look at; it is only read. Left out, the images of every card of the "
                             "catalog are looked at by themselves, which needs no bank and no recognizer")
    parser.add_argument("--catalog", required=True, type=Path, help="the game's catalog file")
    parser.add_argument("--art", required=True,
                        help="the folder, or the http(s) URL prefix, that each card's art is resolved against")


def _some_ids(card_ids: list[str], limit: int = 5) -> str:
    return ", ".join(card_ids[:limit]) + (f", and {len(card_ids) - limit} more" if len(card_ids) > limit else "")


def _check_art(args: argparse.Namespace) -> int:
    """``check-bank-art`` without a bank: the images of the catalog's cards, by themselves."""
    return report_card_images(args.catalog, args.art)


def report_card_images(catalog: str | Path, art: str) -> int:
    """Print the check ``check-bank-art`` makes with no bank: the image of every card of
    ``catalog``, resolved against ``art`` (a folder or an http(s) URL prefix). Returns the exit
    code: 0 whatever it lists, 1 when the catalog or the images cannot be read at all."""
    args = argparse.Namespace(catalog=catalog, art=art)
    from cardvision.bank.art import check_art
    from cardvision.bank.suspect import suspect_lines
    from cardvision.core.catalog import CatalogError, load_catalog
    from cardvision.core.tls import CertificatesMissing

    try:
        report = check_art(load_catalog(args.catalog), args.art)
    except (CatalogError, CertificatesMissing, OSError, ValueError) as error:
        return _fail("check-bank-art", str(error))
    found = report.suspects
    print(f"card images: {args.art} ({report.cards} catalog cards; {len(report.usable)} with a usable image)")
    print(f"  {len(report.missing)} with no image under --art")
    if report.no_art:
        print(f"  {len(report.no_art)} without art in the catalog (\"art\": null), so not in a bank built from it: "
              f"{_some_ids(report.no_art)}")
    print(f"  {len(found.not_pictures)} with a file that holds no picture")
    print(f"  {len(found.placeholders)} with a picture that looks like a placeholder")
    if report.unreadable:
        print(f"  {len(report.unreadable)} with an image that could not be read")
    if report.missing:
        print(f"no image under --art, for example: {_some_ids(report.missing)}")
    if report.unreadable:
        card_id, reason = report.unreadable[0]
        print(f"image could not be read, for example: {card_id} ({reason})")
    for line in suspect_lines(found):
        print(line)
    return 0


def _check_bank_art(args: argparse.Namespace) -> int:
    from cardvision.bank.art import check_bank_art
    from cardvision.core.bank_binary import read_bank_file
    from cardvision.bank.suspect import suspect_lines
    from cardvision.core.catalog import CatalogError, load_catalog
    from cardvision.core.tls import CertificatesMissing

    if args.bank is None:
        return _check_art(args)
    try:
        report = check_bank_art(read_bank_file(args.bank), load_catalog(args.catalog), args.art)
    except (CatalogError, CertificatesMissing, OSError, ValueError) as error:
        return _fail("check-bank-art", str(error))
    print(f"bank: {args.bank} ({report.rows} rows; {report.recorded} record their source image)")
    print(f"  {len(report.matching)} embedded from the image now under --art")
    print(f"  {len(report.changed)} embedded from a different image")
    print(f"  {len(report.unrecorded)} with no recorded image")
    print(f"  {len(report.missing)} with no image under --art")
    if report.no_art:
        print(f"  {len(report.no_art)} for a card the catalog now lists without art: {_some_ids(report.no_art)}")
    if report.unreadable:
        print(f"  {len(report.unreadable)} with an image that could not be read")
    if report.unknown:
        print(f"  {len(report.unknown)} with a card id that is not in the catalog")
    if report.changed:
        print(f"embedded from a different image ({len(report.changed)}):")
        for card_id, recorded, now in report.changed:
            print(f"  {card_id}  artV {recorded}, the image now is {now}")
    if report.missing:
        print(f"no image under --art, for example: {_some_ids(report.missing)}")
    if report.unreadable:
        card_id, reason = report.unreadable[0]
        print(f"image could not be read, for example: {card_id} ({reason})")
    if report.unknown:
        print(f"not in the catalog, for example: {_some_ids(report.unknown)}")
    for line in suspect_lines(report.suspects):
        print(line)
    return 0


# ---------------------------------------------------------------------------- build-release
def _build_release_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--detector", required=True, type=Path, help="the detector, as an ONNX file")
    parser.add_argument("--recognizer", required=True, type=Path, help="the recognizer, as an ONNX file")
    parser.add_argument("--bank", required=True, type=Path, help="the bank built with that recognizer")
    parser.add_argument("--identity-groups", type=Path,
                        help="the bank's identity groups (default: the file beside the bank)")
    parser.add_argument("--catalog", required=True, type=Path, help="the game's catalog file")
    parser.add_argument("--accept", required=True, type=Path,
                        help="the accept rule: a JSON file with tau, delta and rotationRetry")
    parser.add_argument("--out", required=True, type=Path,
                        help="where to write the release; every file above must be in its folder or below")
    parser.add_argument("--detector-version", help="label for the detector (default: its file name)")
    parser.add_argument("--recognizer-version", help="label for the recognizer (default: the bank's model)")
    parser.add_argument("--settings", type=Path,
                        help="a JSON file overriding parts of the default detector, recognizer, identity, "
                             "hover and runtime blocks; a tiltedRetry key turns the tilted retry on")
    parser.add_argument("--overwrite", action="store_true", help="replace an existing release file")


def _build_release(args: argparse.Namespace) -> int:
    from cardvision.bank.documents import DocumentExistsError, read_json
    from cardvision.bank.release import ReleaseError, build_release
    from cardvision.recognize.accept import AcceptError, load_accept

    try:
        doc = build_release(
            args.out,
            overwrite=args.overwrite,
            detector=args.detector,
            recognizer=args.recognizer,
            bank=args.bank,
            identity_groups=args.identity_groups,
            catalog=args.catalog,
            accept=load_accept(args.accept),
            detector_version=args.detector_version,
            recognizer_version=args.recognizer_version,
            settings=read_json(args.settings) if args.settings else None,
        )
    except (ReleaseError, AcceptError) as error:
        return _fail("build-release", error.errors)
    except (DocumentExistsError, OSError, ValueError) as error:
        return _fail("build-release", str(error))
    print(f"release {doc['id']}: {args.out}")
    return 0


# --------------------------------------------------------------------------- verify-release
def _verify_release_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("release", type=Path, metavar="RELEASE", help="the release document")


def _verify_release(args: argparse.Namespace) -> int:
    from cardvision.bank.release import ReleaseError, bank_image_records, verify_release

    try:
        doc = verify_release(args.release)
    except ReleaseError as error:
        return _fail("verify-release", error.errors)
    except OSError as error:
        return _fail("verify-release", str(error))
    print(f"release {doc['id']}: ok ({doc['game']}, {doc['bank']['cardCount']} cards in the bank, "
          f"{doc['catalog']['cardCount']} in the catalog; every file present, unchanged and consistent)")
    recorded, rows = bank_image_records(doc, args.release.parent)
    print(f"bank: {recorded} of {rows} rows record their source image (artV)")
    return 0


# -------------------------------------------------------------------------- convert-release
_CONVERT_DESCRIPTION = """\
The bank becomes bank.bin, its binary form, which holds the same fp16 bytes as the JSON bank,
and the catalog is written as compact JSON. Every other pinned file is copied
byte for byte, except that the identity groups record the new bank's SHA-256. The new release
document pins the new files, so it has a new id; it scores exactly as the original.

A geometric index (build-features) records the SHA-256 of the bank it serves. Converting changes
it, so an index built against the JSON bank does not serve the converted release: build the
index again with --bank naming the converted bank.bin, and pack it again."""


def _convert_release_arguments(parser: argparse.ArgumentParser) -> None:
    parser.epilog = _CONVERT_DESCRIPTION
    parser.formatter_class = argparse.RawDescriptionHelpFormatter
    parser.add_argument("release", type=Path, metavar="RELEASE", help="the release document to convert")
    parser.add_argument("--out", required=True, type=Path,
                        help="the folder to write the converted release to; it must not exist or must be empty")


def _convert_release(args: argparse.Namespace) -> int:
    from cardvision.bank.convert import convert_release
    from cardvision.bank.release import ReleaseError

    try:
        done = convert_release(args.release, args.out)
    except ReleaseError as error:
        return _fail("convert-release", error.errors)
    except (OSError, ValueError) as error:
        return _fail("convert-release", str(error))
    print(f"release {done.old['id']} -> release {done.new['id']}: {args.out / args.release.name}")
    for path, (before, after) in done.sizes.items():
        print(f"  {path}: {before} -> {after} bytes")
    print("a geometric index built against the original bank does not serve this release: "
          "build it again with --bank naming the converted bank")
    return 0


# name -> (one-line help, function that adds the arguments, function that runs the command)
COMMANDS: dict[str, tuple[str, Callable[[argparse.ArgumentParser], None], Callable[[argparse.Namespace], int]]] = {
    "build-bank": ("Build an embedding bank and its identity groups from card images.",
                   _build_bank_arguments, _build_bank),
    "check-refresh": ("Check that a new bank only adds to an old one, or re-embeds rows whose image changed.",
                      _check_refresh_arguments, _check_refresh),
    "check-bank-art": ("List a catalog's card images that need a look; with --bank, which rows match the images now.",
                       _check_bank_art_arguments, _check_bank_art),
    "build-release": ("Pin models, bank, identity groups, catalog and settings in one release document.",
                      _build_release_arguments, _build_release),
    "verify-release": ("Check a release document and every file it pins.",
                       _verify_release_arguments, _verify_release),
    "convert-release": ("Write a release with the bank as bank.bin and a compact catalog, every value unchanged.",
                        _convert_release_arguments, _convert_release),
}
