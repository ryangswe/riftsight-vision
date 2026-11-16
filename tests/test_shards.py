# SPDX-License-Identifier: Apache-2.0
"""``--shard K/N`` (``tests/shards.py``): the N parts of a run together run every test once, and
the Tests workflow runs every part of every Python version."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

import shards

ROOT = Path(__file__).resolve().parents[1]
VERSIONS = ("3.11", "3.12", "3.13")


def test_every_file_is_in_exactly_one_part_whatever_the_seconds():
    files = [f"tests/test_{number}.py" for number in range(40)]
    seconds = {name: 3.0 * (index % 7) for index, name in enumerate(files[:30])}  # ten unlisted
    for parts in (1, 2, 3, 5):
        dealt = shards.deal(files, seconds, parts)
        assert len(dealt) == parts and all(dealt)
        assert sorted(name for part in dealt for name in part) == sorted(files)
    assert shards.deal([], seconds, 2) == [set(), set()]


def test_the_parts_depend_on_the_files_not_on_their_order():
    files = [f"labeler/test_{number}.py" for number in range(12)]
    seconds = {name: float(len(name) % 5) for name in files}
    once = shards.deal(files, seconds, 3)
    assert shards.deal(reversed(files), seconds, 3) == once
    assert shards.deal(files + files, seconds, 3) == once


def test_the_recorded_seconds_split_the_suite_into_two_nearly_even_parts():
    """Longest first, each to the lighter part: the parts differ by at most the longest file."""
    seconds = shards.load_seconds()
    assert seconds and all(re.fullmatch(r"(tests|labeler)/test_\w+\.py", name) for name in seconds)
    first, second = (sum(seconds[name] for name in part) for part in shards.deal(seconds, seconds, 2))
    assert abs(first - second) <= max(seconds.values())


@pytest.mark.parametrize("spec", ["0/2", "3/2", "1/0", "2", "1/2/3", " 1/2", "a/b", "01/2", ""])
def test_a_shard_that_names_no_part_is_refused(spec):
    with pytest.raises(ValueError, match="--shard takes K/N"):
        shards.parse(spec)


def collect(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", *args],
                          cwd=ROOT, capture_output=True, text=True, timeout=300)


def test_the_parts_of_a_run_collect_each_test_once():
    """Through pytest itself, on the labeling tool's files and this one: three parts, none empty,
    that together hold every test of the whole run once."""
    def ids(*args: str) -> list[str]:
        done = collect(*args, "labeler", "tests/test_shards.py")
        assert done.returncode == 0, done.stdout + done.stderr
        return [line for line in done.stdout.splitlines() if "::" in line]

    everything = ids()
    parts = [ids("--shard", f"{part}/3") for part in (1, 2, 3)]
    assert all(parts)
    assert sorted(test for part in parts for test in part) == sorted(everything)


def test_a_part_runs_its_longest_files_first_and_the_tests_of_a_file_in_their_own_order():
    seconds = shards.load_seconds()
    done = collect("--shard", "1/1", "labeler", "tests/test_shards.py")
    assert done.returncode == 0, done.stdout + done.stderr
    tests = [line for line in done.stdout.splitlines() if "::" in line]
    files = [test.split("::")[0] for test in tests]
    order = list(dict.fromkeys(files))
    assert len(order) > 2
    # Each file's tests together, the files from the longest down.
    assert files == [name for name in order for _ in range(files.count(name))]
    costs = [shards.cost(name, seconds) for name in order]
    assert costs == sorted(costs, reverse=True) and costs[0] > costs[-1]
    # Within a file, the order pytest collects.
    whole = [line for line in collect("labeler", "tests/test_shards.py").stdout.splitlines() if "::" in line]
    assert all([test for test in tests if test.startswith(name + "::")]
               == [test for test in whole if test.startswith(name + "::")] for name in order)


def test_a_shard_that_names_no_part_stops_the_run_before_any_test():
    done = collect("--shard", "3/2", "tests/test_shards.py")
    assert done.returncode == pytest.ExitCode.USAGE_ERROR
    assert "--shard takes K/N" in done.stderr


@pytest.mark.maintainer
def test_the_tests_workflow_runs_every_part_of_every_version_and_names_each_check_after_its_version():
    """Each version's parts are one job, so that the job named after the version can wait for
    its own parts only. The checks of a pull request go by those names."""
    text = (ROOT / ".github/workflows/tests.yml").read_text(encoding="utf-8")
    counts = re.findall(r"--shard \$\{\{ matrix\.part \}\}/(\d+)\n", text)
    assert len(counts) == 1
    # Without it, pytest-xdist would hand out the files by their number of tests, not longest first.
    assert re.search(r"--no-loadscope-reorder .*--shard \$\{\{ matrix\.part \}\}/", text)
    parts = int(counts[0])
    assert parts >= 2
    listed = ", ".join(str(part) for part in range(1, parts + 1))
    for version in VERSIONS:
        job = "tests-" + version.replace(".", "-")
        assert (f"  {job}:\n    name: Python ${{{{ matrix.python }}}}, part ${{{{ matrix.part }}}} of {parts}\n"
                f"    runs-on: ubuntu-latest\n    strategy:\n      fail-fast: false\n      matrix:\n"
                f"        python: [\"{version}\"]\n        part: [{listed}]\n    steps: ") in text
        # always(): a version whose parts failed or were cancelled fails here rather than being
        # skipped, since a skipped check would not stop a merge.
        assert (f"  python-{version.replace('.', '-')}:\n    name: Python {version}\n    needs: {job}\n"
                f"    if: always()\n    runs-on: ubuntu-latest\n    steps:\n      - name: Both parts passed\n"
                f"        env:\n          PARTS: ${{{{ needs.{job}.result }}}}\n"
                f"        run: test \"$PARTS\" = success\n") in text
    # The steps are written once and repeated for every other version.
    assert text.count("    steps: &steps\n") == 1 and text.count("    steps: *steps\n") == len(VERSIONS) - 1
    assert len(re.findall(r'^        python: \["[\d.]+"\]$', text, flags=re.MULTILINE)) == len(VERSIONS)
