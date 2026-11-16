# SPDX-License-Identifier: Apache-2.0
"""Split a test run into parts that take about the same time: ``python -m pytest --shard K/N``.

The Tests workflow runs each Python version in two parts, on two runners at the same time. A
test file stays whole in one part, so the setup its tests share runs once, and every file is in
exactly one part: the N parts together run every test once.

Files are dealt out longest first, each to the part with the least time so far, by the seconds
in ``shard_seconds.json`` beside this file. A file that is not listed there counts as one
second. The seconds only balance the parts: a stale or missing entry never leaves a test out.

A part then runs its longest files first, so that its last files are short and the workers
finish together. pytest-xdist hands out files by their number of tests unless it is given
``--no-loadscope-reorder``, as the Tests workflow does.

To measure the seconds again, from the repository's root:

    python -m pytest -p no:cacheprovider --junitxml=run.xml
    python tests/shards.py run.xml > tests/shard_seconds.json
"""

from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Mapping

SECONDS_FILE = Path(__file__).with_name("shard_seconds.json")
UNLISTED_SECONDS = 1.0


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


if __name__ == "__main__":
    json.dump(seconds_from_junit(Path(sys.argv[1])), sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")
