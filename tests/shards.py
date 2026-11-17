# SPDX-License-Identifier: Apache-2.0
"""Split a test run into parts that take about the same time: ``python -m pytest --shard K/N``.

The Tests workflow runs each Python version in three parts, on three runners at the same
time. A test file stays whole in one part, so the setup its tests share runs once, and every
file is in exactly one part: the N parts together run every test once.

Files are dealt out longest first, each to the part with the least time so far, by the seconds
in ``shard_seconds.json`` beside this file. A file that is not listed there counts as one
second. The seconds only balance the parts: a stale or missing entry never leaves a test out.

A part then runs its longest files first, so that its last files are short and the workers
finish together. pytest-xdist hands out files by their number of tests unless it is given
``--no-loadscope-reorder``, as the Tests workflow does.

The seconds are kept current by the Tests workflow. Each part saves its JUnit report, and on a
push to main a last job compares the parts (``python tests/shards.py check``). When new seconds,
measured on CI, would make the slowest part at least ``OPEN_GAIN`` faster, the job opens or
updates the issue "Test parts are out of balance", which holds the new ``shard_seconds.json``
to put in a pull request. When the parts are balanced again, it closes the issue.

To measure the seconds on this computer instead, from the repository's root:

    python -m pytest -p no:cacheprovider --junitxml=run.xml
    python tests/shards.py run.xml > tests/shard_seconds.json
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Mapping

SECONDS_FILE = Path(__file__).with_name("shard_seconds.json")
UNLISTED_SECONDS = 1.0
ISSUE_TITLE = "Test parts are out of balance"
# New seconds that would make the slowest part this much faster open the issue; once they would
# gain less than CLOSE_GAIN, the parts are balanced again and the issue is closed. In between,
# an open issue is kept up to date and none is opened, so that the noise of one run cannot open
# and close it in turn.
OPEN_GAIN = 0.15
CLOSE_GAIN = 0.05


def parse(spec: str) -> tuple[int, int]:
    """``"K/N"`` → ``(K, N)``, with ``1 <= K <= N``."""
    match = re.fullmatch(r"([1-9][0-9]*)/([1-9][0-9]*)", spec)
    if not match or int(match[1]) > int(match[2]):
        raise ValueError(f"--shard takes K/N, part K of N with 1 <= K <= N, not {spec!r}")
    return int(match[1]), int(match[2])


def deal(files: Iterable[str], seconds: Mapping[str, float], parts: int) -> list[set[str]]:
    """The files of each of ``parts`` parts. Every file is in exactly one part, and the result
    depends only on the set of files and the seconds, not on their order."""
    dealt: list[set[str]] = [set() for _ in range(parts)]
    load = [0.0] * parts
    for name in sorted(set(files), key=lambda name: (-cost(name, seconds), name)):
        part = min(range(parts), key=lambda part: (load[part], part))
        dealt[part].add(name)
        load[part] += cost(name, seconds)
    return dealt


def cost(name: str, seconds: Mapping[str, float]) -> float:
    """The recorded seconds of a test file, or ``UNLISTED_SECONDS``."""
    return seconds.get(name, UNLISTED_SECONDS)


def load_seconds(path: Path = SECONDS_FILE) -> dict[str, float]:
    return json.loads(path.read_text(encoding="utf-8"))


def seconds_from_junit(report: Path) -> dict[str, float]:
    """The seconds of each test file in a ``--junitxml`` report, each test's fixtures included."""
    total: dict[str, float] = defaultdict(float)
    for case in ET.parse(report).getroot().iter("testcase"):
        # "tests.test_try" or "labeler.test_project.Screens": the file is the first two parts. A
        # file skipped as a whole has no class name and is named in "name".
        dotted = case.get("classname") or case.get("name", "")
        total["/".join(dotted.split(".")[:2]) + ".py"] += float(case.get("time", 0))
    return {name: round(total[name], 1) for name in sorted(total)}


def json_text(seconds: Mapping[str, float]) -> str:
    """``seconds`` as ``shard_seconds.json`` is written."""
    return json.dumps(dict(seconds), indent=1, sort_keys=True) + "\n"


def seconds_from_reports(folder: Path) -> dict[str, float]:
    """Each file's seconds in a folder of reports, ``<run>-part-<K>/junit.xml``: the parts of a run
    together give every file's seconds in that run, and a file's seconds are the median over the
    runs, here one per Python version."""
    runs: dict[str, dict[str, float]] = defaultdict(dict)
    for report in sorted(folder.glob("*/junit.xml")):
        run = re.sub(r"-part-\d+$", "", report.parent.name)
        runs[run].update(seconds_from_junit(report))
    if not runs:
        raise ValueError(f"{folder}: no reports named <run>-part-<K>/junit.xml")
    files = sorted({name for seconds in runs.values() for name in seconds})
    return {name: round(statistics.median(seconds[name] for seconds in runs.values() if name in seconds), 1)
            for name in files}


def compare(measured: Mapping[str, float], recorded: Mapping[str, float], parts: int) -> dict:
    """How long each part takes by the ``measured`` seconds, as the ``recorded`` ones deal the
    files out now and as the measured ones would, and what to do about the issue."""
    def loads(dealt: list[set[str]]) -> list[float]:
        return [round(sum(measured[name] for name in part), 1) for part in dealt]

    now = loads(deal(measured, recorded, parts))
    new = loads(deal(measured, measured, parts))
    gain = 1 - max(new) / max(now) if max(now) else 0.0
    state = "open" if gain >= OPEN_GAIN else "close" if gain < CLOSE_GAIN else "keep"
    return {"now": now, "new": new, "gain": gain, "state": state,
            "unlisted": sorted(set(measured) - set(recorded)), "gone": sorted(set(recorded) - set(measured))}


def issue_body(result: dict, measured: Mapping[str, float], run_url: str) -> str:
    lines = [f"The test parts of the [Tests run on main]({run_url}) are out of balance. With the seconds "
             "measured in that run, the slowest part would take "
             f"{max(result['new']):.0f} s of test time instead of {max(result['now']):.0f} s "
             f"({result['gain']:.0%} less).", "",
             "| Part | Now | With the new seconds |", "|---|---|---|"]
    lines += [f"| {number} | {now:.0f} s | {new:.0f} s |"
              for number, (now, new) in enumerate(zip(result["now"], result["new"]), start=1)]
    lines.append("")
    if result["unlisted"]:
        lines.append(f"Test files with no recorded seconds: {', '.join(f'`{name}`' for name in result['unlisted'])}.")
    if result["gone"]:
        lines.append(f"Recorded files that no longer exist: {', '.join(f'`{name}`' for name in result['gone'])}.")
    lines += ["", "To balance the parts, put this in `tests/shard_seconds.json` in a pull request. Each file's "
              "seconds are its test time on CI in that run, the median over the Python versions. Stale "
              "seconds never leave a test out; they only make one part slower than the others.", "",
              "```json", json_text(measured).rstrip("\n"), "```", "",
              "The Tests workflow keeps this issue up to date on each push to main "
              "(`python tests/shards.py check`), and closes it when the parts are balanced again."]
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    if argv and argv[0] == "check":
        parser = argparse.ArgumentParser(prog="shards.py check", description="Compare the parts' times on CI "
                                         "with the recorded seconds; print state=open, keep or close.")
        parser.add_argument("reports", type=Path, help="folder of <run>-part-<K>/junit.xml")
        parser.add_argument("--parts", type=int, required=True)
        parser.add_argument("--run-url", required=True)
        parser.add_argument("--body", type=Path, required=True, help="where to write the issue's text")
        args = parser.parse_args(argv[1:])
        measured = seconds_from_reports(args.reports)
        result = compare(measured, load_seconds(), args.parts)
        args.body.write_text(issue_body(result, measured, args.run_url), encoding="utf-8")
        print(f"state={result['state']}")
        return 0
    sys.stdout.write(json_text(seconds_from_junit(Path(argv[0]))))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
