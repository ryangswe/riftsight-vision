# SPDX-License-Identifier: Apache-2.0
"""``--shard K/N`` (``tests/shards.py``): the N parts of a run together run every test once, and
the Tests workflow runs every part of every Python version."""

from __future__ import annotations

import json
import os
import re
import shutil
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


@pytest.mark.parametrize("parts", [2, 3])
def test_the_recorded_seconds_split_the_suite_into_nearly_even_parts(parts):
    """Longest first, each to the lighter part: the parts differ by at most the longest file."""
    seconds = shards.load_seconds()
    assert seconds and all(re.fullmatch(r"(tests|labeler)/test_\w+\.py", name) for name in seconds)
    loads = [sum(seconds[name] for name in part) for part in shards.deal(seconds, seconds, parts)]
    assert max(loads) - min(loads) <= max(seconds.values())


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
                f"    if: always()\n    runs-on: ubuntu-latest\n    steps:\n      - name: Every part passed\n"
                f"        env:\n          PARTS: ${{{{ needs.{job}.result }}}}\n"
                f"        run: test \"$PARTS\" = success\n") in text
    # The steps are written once and repeated for every other version.
    assert text.count("    steps: &steps\n") == 1 and text.count("    steps: *steps\n") == len(VERSIONS) - 1
    assert len(re.findall(r'^        python: \["[\d.]+"\]$', text, flags=re.MULTILINE)) == len(VERSIONS)


# ------------------------------------------------------------------------------- balance check
def write_report(path: Path, seconds: dict[str, float]) -> None:
    """A ``--junitxml`` report in which each file's tests take ``seconds`` in all."""
    cases = "".join(f'<testcase classname="{name[:-3].replace("/", ".")}" name="test_{half}" time="{total / 2}"/>'
                    for name, total in seconds.items() for half in ("a", "b"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'<?xml version="1.0"?><testsuites><testsuite name="pytest">{cases}</testsuite></testsuites>',
                    encoding="utf-8")


def test_the_reports_of_a_run_give_each_file_its_median_over_the_python_versions(tmp_path):
    for version, slow in (("3.11", 10.0), ("3.12", 12.0), ("3.13", 30.0)):
        write_report(tmp_path / f"junit-{version}-part-1" / "junit.xml", {"tests/test_a.py": slow})
        write_report(tmp_path / f"junit-{version}-part-2" / "junit.xml", {"tests/test_b.py": 2.0, "labeler/test_c.py": 1.0})
    assert shards.seconds_from_reports(tmp_path) == {"labeler/test_c.py": 1.0, "tests/test_a.py": 12.0, "tests/test_b.py": 2.0}
    with pytest.raises(ValueError, match="no reports"):
        shards.seconds_from_reports(tmp_path / "empty")


def test_stale_seconds_open_the_issue_and_balanced_parts_close_it():
    files = {f"tests/test_{number}.py": 10.0 for number in range(9)}
    # One file has become five times slower than its recorded seconds, and a new one is listed nowhere.
    measured = {**files, "tests/test_0.py": 50.0, "tests/test_new.py": 30.0}
    stale = shards.compare(measured, files, 3)
    assert stale["state"] == "open" and stale["gain"] >= shards.OPEN_GAIN
    assert sum(stale["now"]) == sum(stale["new"]) == sum(measured.values())
    assert stale["unlisted"] == ["tests/test_new.py"] and stale["gone"] == []
    balanced = shards.compare(measured, measured, 3)
    assert balanced["state"] == "close" and balanced["gain"] == 0
    # A gain between the two limits keeps an open issue up to date and opens none.
    assert shards.CLOSE_GAIN < shards.OPEN_GAIN
    # Two files dealt into the same part have each become a little slower: 36 s against 33 s.
    middle = shards.compare({**files, "tests/test_0.py": 13.0, "tests/test_3.py": 13.0}, files, 3)
    assert shards.CLOSE_GAIN <= middle["gain"] < shards.OPEN_GAIN and middle["state"] == "keep"


def test_the_issue_holds_the_new_seconds_as_shard_seconds_json_is_written():
    measured = {"tests/test_b.py": 2.5, "tests/test_a.py": 40.0}
    body = shards.issue_body(shards.compare(measured, {"tests/test_a.py": 1.0}, 2), measured, "https://example.invalid/run/1")
    block = body.split("```json\n", 1)[1].split("```", 1)[0]
    assert block == shards.json_text(measured) and json.loads(block) == measured
    assert "(https://example.invalid/run/1)" in body and "`tests/test_b.py`" in body


def test_the_check_command_writes_the_issue_and_prints_its_state(tmp_path):
    """On the seconds recorded in the repository the parts are balanced, so the state is close."""
    recorded = shards.load_seconds()
    names = sorted(recorded)
    for part in (1, 2, 3):
        write_report(tmp_path / "junit" / f"junit-3.12-part-{part}" / "junit.xml",
                     {name: recorded[name] for name in names[part - 1::3]})
    done = subprocess.run([sys.executable, "tests/shards.py", "check", str(tmp_path / "junit"), "--parts", "3",
                           "--run-url", "https://example.invalid/run/2", "--body", str(tmp_path / "balance.md")],
                          cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    assert done.stdout == "state=close\n"
    assert "https://example.invalid/run/2" in (tmp_path / "balance.md").read_text(encoding="utf-8")


ISSUE_STEP = "Open, update or close the issue"


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
@pytest.mark.parametrize(("state", "existing", "expected"), [
    ("open", "", ["issue list", "issue create --repo example/toolkit --title Test parts are out of balance --body-file balance.md"]),
    ("open", "7", ["issue list", "issue edit 7 --repo example/toolkit --body-file balance.md"]),
    ("keep", "", ["issue list"]),
    ("keep", "7", ["issue list", "issue edit 7 --repo example/toolkit --body-file balance.md"]),
    ("close", "", ["issue list"]),
    ("close", "7", ["issue list", "issue close 7 --repo example/toolkit --comment The parts are balanced again: https://example.invalid/run/3"]),
])
def test_the_issue_step_opens_updates_or_closes_the_one_issue(state, existing, expected, tmp_path):
    """The step's own script, with a stand-in ``gh`` that records its calls and finds the open
    issue number ``existing``, if any."""
    from test_workflows import run_step, steps_of

    bin_folder = tmp_path / "bin"
    bin_folder.mkdir()
    (bin_folder / "gh").write_text('#!/bin/bash\necho "$*" >> "$CALLS"\n'
                                   '[ "$1 $2" = "issue list" ] && printf "%s" "$EXISTING"\nexit 0\n', encoding="utf-8")
    (bin_folder / "gh").chmod(0o755)
    work = tmp_path / "work"
    work.mkdir()
    (work / "tests").symlink_to(ROOT / "tests")
    (work / "balance.md").write_text("the text\n", encoding="utf-8")
    calls, summary = tmp_path / "calls", tmp_path / "summary"
    environment = {**os.environ, "PATH": f"{bin_folder}{os.pathsep}{Path(sys.executable).parent}{os.pathsep}{os.environ['PATH']}",
                   "CALLS": str(calls), "EXISTING": existing, "STATE": state, "GITHUB_REPOSITORY": "example/toolkit",
                   "RUN_URL": "https://example.invalid/run/3", "GITHUB_STEP_SUMMARY": str(summary), "GH_TOKEN": "unused"}
    done = run_step(steps_of("tests.yml")[ISSUE_STEP]["run"], work, environment)
    assert done.returncode == 0, done.stderr
    made = calls.read_text(encoding="utf-8").splitlines()
    assert [made[0][:10]] + made[1:] == expected
    assert summary.read_text(encoding="utf-8") == f"Balance: {state}\nthe text\n"


def test_an_unknown_state_fails_the_issue_step(tmp_path):
    from test_workflows import run_step, steps_of

    bin_folder = tmp_path / "bin"
    bin_folder.mkdir()
    (bin_folder / "gh").write_text("#!/bin/bash\nexit 0\n", encoding="utf-8")
    (bin_folder / "gh").chmod(0o755)
    (tmp_path / "tests").symlink_to(ROOT / "tests")
    environment = {**os.environ, "PATH": f"{bin_folder}{os.pathsep}{Path(sys.executable).parent}{os.pathsep}{os.environ['PATH']}",
                   "STATE": "", "GITHUB_REPOSITORY": "example/toolkit", "RUN_URL": "u", "GITHUB_STEP_SUMMARY": str(tmp_path / "s")}
    done = run_step(steps_of("tests.yml")[ISSUE_STEP]["run"], tmp_path, environment)
    assert done.returncode == 1 and "unknown state" in done.stdout


@pytest.mark.maintainer
def test_only_the_balance_job_may_write_issues_and_it_runs_on_pushes_to_main_after_every_part():
    text = (ROOT / ".github/workflows/tests.yml").read_text(encoding="utf-8")
    assert "\npermissions:\n  contents: read\n" in text and text.count("issues: write") == 1
    job = text.split("\n  balance:\n", 1)[1]
    assert job.startswith("    name: Test parts balance\n    needs: [tests-3-11, tests-3-12, tests-3-13]\n"
                          "    if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n"
                          "    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      issues: write\n")
    assert "        with:\n          pattern: junit-*\n          path: junit\n" in job
    assert 'python tests/shards.py check junit --parts 3 --run-url "$RUN_URL" --body balance.md >> "$GITHUB_OUTPUT"' in job
    # Each part keeps its report under the name the check reads, for a week.
    assert "--junitxml=junit.xml --shard ${{ matrix.part }}/3\n" in text
    assert ("          name: junit-${{ matrix.python }}-part-${{ matrix.part }}\n          path: junit.xml\n"
            "          retention-days: 7\n") in text
