# SPDX-License-Identifier: Apache-2.0
"""The ``cardvision refresh`` subcommand: the release gate of a card-data refresh, in four steps.

::

    cardvision refresh check CANDIDATE/release.json --base LIVE/release.json
        [--live-config CONFIG.json [--bundled-id ID]] [--editable name,facets] [--near 0.90]
        [--duplicate-vectors refuse|same-identity|report]
        [--geometric CAND_GEO.json --base-geometric BASE_GEO.json] [--cardvision "COMMAND"] [--json OUT.json]
    cardvision refresh diff BASE_DIR CANDIDATE_DIR
        [--exclude-truth-prefix PREFIX ...] [--exclude-truth-ids IDS.json] [--json OUT.json]
    cardvision refresh subset CATALOG OUT (--new-vs BASE_CATALOG | --ids IDS.json)
    cardvision refresh verdict replay|newcard DIR --rule RULE.txt
        [--sha-file RULE.SHA256] [--rehearsal] [--reference DIR]

``check`` holds the structural preconditions (``cardvision.refresh.check``); exit 0 when every
check holds, else 1. ``diff`` compares two ``evaluate hover --out`` folders event by event
(``cardvision.refresh.diff``). ``subset`` writes the catalog of the new cards for gate N's
scenes (``cardvision.refresh.subset``). ``verdict`` applies a frozen rule written from
``docs/refresh-rule-template.md`` (``cardvision.refresh.verdict``): exit 0 PASS, 1 FAIL,
3 INVALID, a refused rule included. A flag of another step is refused (exit 2).
"""

from __future__ import annotations

import argparse
import json
import shlex
from pathlib import Path

SUMMARY = "Gate a card-data refresh: preconditions, replay diff, new-card catalog, verdict by a frozen rule."
# step -> the names of its positional arguments
STEPS = {
    "check": ("CAND_RELEASE",),
    "diff": ("BASE_DIR", "CANDIDATE_DIR"),
    "subset": ("CATALOG", "OUT"),
    "verdict": ("GATE", "DIR"),
}
# step -> the destinations of the flags it takes
FLAGS = {
    "check": {"base", "live_config", "bundled_id", "editable", "near", "duplicate_vectors", "geometric", "base_geometric", "cardvision", "json"},
    "diff": {"exclude_truth_prefix", "exclude_truth_ids", "json"},
    "subset": {"new_vs", "ids"},
    "verdict": {"rule", "sha_file", "rehearsal", "reference"},
}


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Declare the subcommand's arguments."""
    from cardvision.refresh.check import DEFAULT_NEAR

    parser.add_argument("step", choices=tuple(STEPS), help="check, diff, subset or verdict")
    parser.add_argument("paths", nargs="*", metavar="ARG",
                        help="check takes CAND_RELEASE; diff takes BASE_DIR CANDIDATE_DIR; subset takes CATALOG OUT; "
                             "verdict takes replay|newcard DIR")
    group = parser.add_argument_group("check")
    group.add_argument("--base", metavar="BASE_RELEASE", help="the live (base) release.json (required)")
    group.add_argument("--live-config", metavar="CONFIG.json",
                       help="P0: the live settings file, read when the session starts; the release it names must be the base")
    group.add_argument("--bundled-id", metavar="ID",
                       help="P0: the release bundled with the extension, the base when the settings name no release")
    group.add_argument("--editable", metavar="FIELDS",
                       help="P3: catalog fields a base entry may change, comma-separated (default: none)")
    group.add_argument("--near", type=float, metavar="COSINE",
                       help=f"P2b: list appended rows this close to another identity's row (default {DEFAULT_NEAR})")
    group.add_argument("--duplicate-vectors", choices=("refuse", "same-identity", "report"),
                       help="P2: an added row whose vector repeats another row's: refuse (default), allow it within "
                            "one identity (same-identity), or only list it (report)")
    group.add_argument("--geometric", metavar="CAND_GEO.json", help="P4: the candidate's geometric settings")
    group.add_argument("--base-geometric", metavar="BASE_GEO.json", help="P4: the base's geometric settings")
    group.add_argument("--cardvision", metavar="COMMAND",
                       help="the command that runs cardvision check-refresh and verify-release "
                            "(default: this Python with -m cardvision)")
    group.add_argument("--json", metavar="OUT.json", help="check and diff: also write the whole document to this file")
    group = parser.add_argument_group("diff")
    group.add_argument("--exclude-truth-prefix", action="append", metavar="PREFIX",
                       help="rehearsals only: leave out events whose labeled card id starts with PREFIX (repeatable)")
    group.add_argument("--exclude-truth-ids", metavar="IDS.json",
                       help="rehearsals only: leave out events whose labeled card id is in this JSON list")
    group = parser.add_argument_group("subset")
    group.add_argument("--new-vs", metavar="BASE_CATALOG", help="keep the entries this catalog does not have")
    group.add_argument("--ids", metavar="IDS.json", help="keep the ids of this JSON list")
    group = parser.add_argument_group("verdict")
    group.add_argument("--rule", metavar="RULE.txt", help="the frozen rule (required)")
    group.add_argument("--sha-file", metavar="FILE",
                       help="the file holding the rule's frozen SHA-256 (default: RULE.SHA256 beside RULE.txt)")
    group.add_argument("--rehearsal", action="store_true", default=None,
                       help="a rehearsal: excluded events are allowed (as the rule's rehearsalEnv variable set to 1)")
    group.add_argument("--reference", metavar="DIR",
                       help="gate N: the reference run, in place of the rule's newcard.referenceDir ({arm} is replaced)")


def _refuse(message: str) -> int:
    print(f"cardvision refresh: {message}")
    return 2


def run(args: argparse.Namespace) -> int:
    """Run the chosen step and return its exit code."""
    step = args.step
    names = STEPS[step]
    if len(args.paths) != len(names):
        return _refuse(f"{step} takes {' '.join(names)}, got {len(args.paths)} argument(s)")
    foreign = sorted("--" + dest.replace("_", "-") for flags in FLAGS.values() for dest in flags
                     if dest not in FLAGS[step] and getattr(args, dest) is not None)
    if foreign:
        return _refuse(f"{step} takes no {', '.join(dict.fromkeys(foreign))}")
    return {"check": _check, "diff": _diff, "subset": _subset, "verdict": _verdict}[step](args)


def _check(args: argparse.Namespace) -> int:
    from cardvision.refresh.check import DEFAULT_NEAR, check_release

    if not args.base:
        return _refuse("check needs --base")
    if (args.geometric is None) != (args.base_geometric is None):
        return _refuse("--geometric and --base-geometric go together")
    if args.bundled_id is not None and args.live_config is None:
        return _refuse("--bundled-id needs --live-config")
    editable = [f.strip() for f in (args.editable or "").split(",") if f.strip()]
    verdict = check_release(args.paths[0], args.base, live_config=args.live_config, bundled_id=args.bundled_id,
                            editable=editable, near=DEFAULT_NEAR if args.near is None else args.near,
                            duplicate_vectors=args.duplicate_vectors or "refuse",
                            geometric=args.geometric, base_geometric=args.base_geometric,
                            cardvision=shlex.split(args.cardvision) if args.cardvision else None)
    text = json.dumps(verdict, indent=1)
    if args.json:
        Path(args.json).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if verdict["ok"] else 1


def _diff(args: argparse.Namespace) -> int:
    from cardvision.refresh.diff import diff_runs, summary

    ids = json.loads(Path(args.exclude_truth_ids).read_text(encoding="utf-8")) if args.exclude_truth_ids else []
    document = diff_runs(args.paths[0], args.paths[1], exclude_prefixes=args.exclude_truth_prefix or [], exclude_ids=ids)
    if args.json:
        Path(args.json).write_text(json.dumps(document, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(summary(document), indent=1))
    return 0


def _subset(args: argparse.Namespace) -> int:
    from cardvision.refresh.subset import SubsetError, subset_catalog

    if (args.new_vs is None) == (args.ids is None):
        return _refuse("subset takes exactly one of --new-vs and --ids")
    ids = json.loads(Path(args.ids).read_text(encoding="utf-8")) if args.ids else None
    try:
        with_art, stubs = subset_catalog(args.paths[0], args.paths[1], new_vs=args.new_vs, ids=ids)
    except SubsetError as error:
        print(f"cardvision refresh subset: {error}")
        return 1
    print(f"{args.paths[1]}: {with_art} cards with art, {stubs} roots without art")
    return 0


def _verdict(args: argparse.Namespace) -> int:
    from cardvision.refresh.verdict import EXIT, GATES, RuleError, judge

    gate, folder = args.paths
    if gate not in GATES:
        return _refuse(f"verdict takes replay or newcard, not {gate!r}")
    if not args.rule:
        return _refuse("verdict needs --rule")
    try:
        out = judge(gate, folder, args.rule, sha_file=args.sha_file, rehearsal=True if args.rehearsal else None,
                    reference=args.reference)
    except RuleError as error:
        print(f"INVALID: the rule is refused: {error}")
        return EXIT["INVALID"]
    print(json.dumps({k: out[k] for k in ("gate", "verdict", "notes")}, indent=1))
    for key, value in out["detail"].items():
        shown = {kk: vv for kk, vv in value.items() if kk != "events"} if isinstance(value, dict) else value
        print(key, json.dumps(shown))
    return EXIT[out["verdict"]]
