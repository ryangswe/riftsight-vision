# SPDX-License-Identifier: Apache-2.0
"""``tests/release_prepare.py`` makes the mechanical part of a version commit and refuses what it must.

The fixtures in ``tests/fixtures/release_prepare/`` are small, made-up copies of the shape of a tree at a
first candidate whose Unreleased section already holds the next candidate's entry (``before``), and
of the same tree after the version commit, less the introduction a person writes (``after``). The
real tree's own agreement is in ``tests/test_release_process.py``. Nothing here reaches the network."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

import release_prepare
from release_prepare import STRINGS, Refused, prepare, previous_link_target, read_strings

FIXTURES = Path(__file__).parent / "fixtures" / "release_prepare"
FILES = ["CHANGELOG.md", *STRINGS]


def git(root: Path, *arguments: str) -> None:
    subprocess.run(["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=none",
                    "-c", "commit.gpgsign=false", *arguments], check=True, capture_output=True)


@pytest.fixture
def tree(tmp_path):
    root = tmp_path / "tree"
    shutil.copytree(FIXTURES / "before", root)
    git(root, "init", "-q")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "start")
    return root


def test_a_second_candidate_gets_exactly_the_mechanical_version_commit(tree):
    prepare(tree, "0.14.0rc2", "2026-11-13", check=False)
    for name in FILES:
        assert (tree / name).read_text(encoding="utf-8") == (FIXTURES / "after" / name).read_text(encoding="utf-8"), name


def test_check_prints_the_plan_and_writes_nothing_even_on_a_dirty_tree(tree, capsys):
    (tree / "notes.txt").write_text("uncommitted", encoding="utf-8")
    before = {name: (tree / name).read_text(encoding="utf-8") for name in FILES}
    assert release_prepare.main(["--root", str(tree), "--version", "0.14.0rc2", "--date", "2026-11-13", "--check"]) == 0
    out = capsys.readouterr().out
    assert "0.14.0rc1 -> 0.14.0rc2" in out and "compare/v0.14.0rc1...v0.14.0rc2" in out and "maintainer's" in out
    assert {name: (tree / name).read_text(encoding="utf-8") for name in FILES} == before


def test_the_script_says_the_prose_is_the_maintainers_and_writes_none(tree, capsys):
    assert release_prepare.main(["--root", str(tree), "--version", "0.14.0rc2", "--date", "2026-11-13"]) == 0
    assert "introduction" in capsys.readouterr().out
    text = (tree / "CHANGELOG.md").read_text(encoding="utf-8")
    assert "## [0.14.0rc2] - 2026-11-13\n\n### Changed\n" in text


@pytest.mark.parametrize("version", ["0.15", "0.15.0-rc1", "1.0.0.0.1", "v0.15.0", "0.15.0rc", "0.15.0a1", ""])
def test_a_version_that_is_not_x_y_z_or_x_y_z_rc_n_is_refused(tree, version):
    with pytest.raises(Refused, match="not X.Y.Z"):
        prepare(tree, version, "2026-11-13", check=True)


@pytest.mark.parametrize("version", ["0.14.0rc1", "0.13.0", "0.14.0rc0"])
def test_a_version_not_greater_than_the_current_one_is_refused(tree, version):
    with pytest.raises(Refused, match="not greater"):
        prepare(tree, version, "2026-11-13", check=True)


def test_an_empty_unreleased_section_is_refused(tree):
    path = tree / "CHANGELOG.md"
    text = path.read_text(encoding="utf-8")
    start, end = text.index("## [Unreleased]\n") + len("## [Unreleased]\n"), text.index("## [0.14.0rc1]")
    path.write_text(text[:start] + "\n" + text[end:], encoding="utf-8")
    with pytest.raises(Refused, match="empty"):
        prepare(tree, "0.14.0rc2", "2026-11-13", check=True)


def test_a_dirty_tree_is_refused_unless_check(tree):
    (tree / "docs" / "quickstart.md").write_text("changed\ncardvision 0.14.0rc1\n", encoding="utf-8")
    with pytest.raises(Refused, match="uncommitted"):
        prepare(tree, "0.14.0rc2", "2026-11-13", check=False)
    assert "changed" in (tree / "docs" / "quickstart.md").read_text(encoding="utf-8")
    assert prepare(tree, "0.14.0rc2", "2026-11-13", check=True)


def test_a_place_that_disagrees_on_the_current_version_is_refused(tree):
    path = tree / "playbooks" / "setup.md"
    path.write_text(path.read_text(encoding="utf-8").replace("0.14.0rc1", "0.13.0"), encoding="utf-8")
    with pytest.raises(Refused, match="disagree"):
        prepare(tree, "0.14.0rc2", "2026-11-13", check=True)


def test_a_place_that_cannot_be_found_is_refused(tree):
    (tree / "docs" / "quickstart.md").write_text("no version here\n", encoding="utf-8")
    with pytest.raises(Refused, match="quickstart.md"):
        read_strings(tree)


NAMES = ["0.14.0", "0.14.0rc2", "0.14.0rc1", "0.13.0", "0.13.0rc1", "0.12.0"]


@pytest.mark.parametrize("version, target", [
    ("0.14.0", "0.13.0"),       # a final after candidates compares with the previous final
    ("0.14.0rc1", "0.13.0"),    # a first candidate compares with the previous final
    ("0.15.0rc1", "0.14.0"),     # after a final, a first candidate compares with that final
    ("0.14.0rc2", "0.14.0rc1"),  # a later candidate compares with the candidate before it
    ("0.14.0rc3", None),         # its predecessor is missing from the changelog
])
def test_the_compare_link_rule(version, target):
    names = [name for name in NAMES if name != version]
    if target is None:
        with pytest.raises(Refused, match="0.14.0rc2"):
            previous_link_target(version, [n for n in names if n != "0.14.0rc2"])
    else:
        assert previous_link_target(version, names) == target


def test_a_final_after_candidates_writes_its_link_against_the_previous_final(tree):
    prepare(tree, "0.14.0", "2026-11-20", check=False)
    text = (tree / "CHANGELOG.md").read_text(encoding="utf-8")
    assert "[0.14.0]: https://example.test/sample/compare/v0.13.0...v0.14.0\n" in text
    assert "[Unreleased]: https://example.test/sample/compare/v0.14.0...HEAD\n" in text
    assert "\n## [Unreleased]\n\n## [0.14.0] - 2026-11-20\n" in text


def test_a_first_candidate_writes_its_link_against_the_previous_final():
    text = (FIXTURES / "before" / "CHANGELOG.md").read_text(encoding="utf-8")
    start, end = text.index("## [0.14.0rc1]"), text.index("## [0.13.0]")
    text = text[:start] + text[end:]
    text = "\n".join(line for line in text.splitlines() if not line.startswith("[0.14.0rc1]:")) + "\n"
    text = text.replace("v0.14.0rc1...HEAD", "v0.13.0...HEAD")
    changed = release_prepare.change_changelog(text, "0.14.0rc1", "2026-11-13")
    assert "[0.14.0rc1]: https://example.test/sample/compare/v0.13.0...v0.14.0rc1\n" in changed
    assert "[Unreleased]: https://example.test/sample/compare/v0.14.0rc1...HEAD\n" in changed
