# SPDX-License-Identifier: Apache-2.0
"""What a push to main does about a release (``tests/release_plan.py``), on made-up facts."""

from __future__ import annotations

import pytest

import release_plan
from release_plan import Facts, decide

HERE = "a" * 40
OLDER = "b" * 40
CHANGELOG = """# Changelog

## [Unreleased]

### Fixed

- Something waiting.

## [0.12.0] - 2026-11-20

Intro line.

### Added

- A new thing.

## [0.12.0rc1] - 2026-11-15

### Added

- A candidate.

## [0.11.0] - 2026-11-10

### Fixed

- Old.
"""


def listing(**tags: str) -> str:
    return "".join(f"{sha}\trefs/tags/v{name}\n" for name, sha in tags.items())


def facts(**changes) -> Facts:
    base = dict(version="0.12.0", commit=HERE, tags="".join([f"{OLDER}\trefs/tags/v0.11.0\n"]), pypi_status="404",
                release_exists=False, publish_runs=0, changelog=CHANGELOG)
    return Facts(**{**base, **changes})


# Row 1: the version is not raised.
def test_a_push_that_leaves_the_version_alone_does_nothing():
    plan = decide(facts(version="0.11.0", tags=listing(**{"0.11.0": OLDER})))
    assert plan.action == "nothing" and not plan.create and not plan.dispatch


def test_an_annotated_tag_is_read_through_its_commit():
    tags = f"{'c' * 40}\trefs/tags/v0.11.0\n{OLDER}\trefs/tags/v0.11.0^{{}}\n"
    assert decide(facts(version="0.11.0", tags=tags, commit=OLDER, release_exists=True, pypi_status="200")).action == "nothing"
    assert decide(facts(version="0.11.0", tags=tags, commit="c" * 40, release_exists=True)).action == "nothing"


# Row 2: a raised version with a dated section, free on the index.
def test_a_raised_version_is_released_with_the_sections_body_as_notes():
    plan = decide(facts())
    assert (plan.action, plan.create, plan.dispatch, plan.prerelease) == ("release", True, True, False)
    assert plan.notes == "Intro line.\n\n### Added\n\n- A new thing.\n"
    assert not plan.notes.startswith("##") and "0.12.0rc1" not in plan.notes


def test_a_release_candidate_is_a_prerelease():
    plan = decide(facts(version="0.12.0rc1"))
    assert (plan.action, plan.prerelease, plan.dispatch) == ("release", True, True)
    assert plan.notes == "### Added\n\n- A candidate.\n"


def test_a_release_after_a_candidate_is_not_lower_than_it():
    tags = listing(**{"0.11.0": OLDER, "0.12.0rc1": OLDER})
    assert decide(facts(tags=tags)).action == "release"


def test_the_notes_are_the_section_text_that_the_changelog_test_sees():
    assert release_plan.sections(CHANGELOG)["0.12.0"].strip() + "\n" == release_plan.notes_for(CHANGELOG, "0.12.0")


# Row 3: no usable changelog section.
@pytest.mark.parametrize("changelog", [
    CHANGELOG.replace("## [0.12.0] - 2026-11-20", "## [0.12.0]"),      # undated
    CHANGELOG.replace("## [0.12.0] - 2026-11-20", "## [0.12.1] - 2026-11-20"),      # another version
    CHANGELOG.replace("Intro line.\n\n### Added\n\n- A new thing.\n\n", ""),         # empty
])
def test_a_raised_version_without_a_dated_section_is_refused_by_name(changelog):
    plan = decide(facts(changelog=changelog))
    assert plan.action == "refuse" and "[0.12.0]" in plan.reason and not plan.create and not plan.dispatch


# Row 4: the index and the order of versions.
def test_a_version_already_on_the_index_is_refused():
    plan = decide(facts(pypi_status="200"))
    assert plan.action == "refuse" and "already on the package index" in plan.reason and not plan.create


@pytest.mark.parametrize("status", ["000", "500", "503", "429", "403", ""])
def test_an_index_that_does_not_answer_404_is_refused(status):
    plan = decide(facts(pypi_status=status))
    assert plan.action == "refuse" and "instead of 404" in plan.reason and not plan.create and not plan.dispatch


def test_a_version_lower_than_the_newest_tag_is_refused():
    plan = decide(facts(tags=listing(**{"0.11.0": OLDER, "0.13.0": OLDER})))
    assert plan.action == "refuse" and "lower than the newest version tag, v0.13.0" in plan.reason


def test_a_candidate_of_an_already_tagged_release_is_lower_than_it():
    plan = decide(facts(version="0.12.0rc1", tags=listing(**{"0.12.0": OLDER})))
    assert plan.action == "refuse" and "v0.12.0" in plan.reason


def test_a_version_that_is_not_a_version_is_refused():
    assert decide(facts(version="1.0")).action == "refuse"


def test_tags_that_are_not_versions_are_ignored_when_ordering():
    tags = listing(**{"0.11.0": OLDER, "store-9.9.9": OLDER}).replace("refs/tags/vstore", "refs/tags/store")
    assert decide(facts(tags=tags)).action == "release"


# Row 6: a re-run, the tag at this commit.
def test_a_rerun_with_everything_done_does_nothing():
    plan = decide(facts(tags=listing(**{"0.12.0": HERE}), release_exists=True, publish_runs=1))
    assert plan.action == "nothing" and not plan.create and not plan.dispatch


def test_a_rerun_with_only_the_release_missing_creates_only_the_release():
    plan = decide(facts(tags=listing(**{"0.12.0": HERE}), publish_runs=1))
    assert (plan.action, plan.create, plan.dispatch) == ("release", True, False)
    assert plan.notes.startswith("Intro line.")


def test_a_rerun_with_only_the_upload_missing_dispatches_only():
    plan = decide(facts(tags=listing(**{"0.12.0": HERE}), release_exists=True))
    assert (plan.action, plan.create, plan.dispatch) == ("release", False, True)


@pytest.mark.parametrize("status", ["200", "000", "500"])
def test_a_rerun_never_dispatches_unless_the_index_says_404(status):
    plan = decide(facts(tags=listing(**{"0.12.0": HERE}), release_exists=True, pypi_status=status))
    assert plan.action == "nothing" and not plan.dispatch


def test_a_rerun_does_not_recheck_ordering_or_the_index_before_finishing():
    # The tag is this commit's own, so a higher tag made since does not make it a refusal.
    tags = listing(**{"0.12.0": HERE, "0.13.0": OLDER})
    plan = decide(facts(tags=tags, publish_runs=1))
    assert (plan.action, plan.create) == ("release", True)


def test_a_rerun_missing_the_release_and_its_changelog_section_is_refused():
    plan = decide(facts(tags=listing(**{"0.12.0": HERE}), changelog=CHANGELOG.replace("## [0.12.0] - 2026-11-20", "## [0.12.0]")))
    assert plan.action == "refuse" and "[0.12.0]" in plan.reason


# The script: environment in, notes file and outputs out.
def run(tmp_path, monkeypatch, **overrides):
    tags = tmp_path / "tags.txt"
    tags.write_text(listing(**{"0.11.0": OLDER}), encoding="utf-8")
    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text(CHANGELOG, encoding="utf-8")
    monkeypatch.setattr(release_plan, "ROOT", tmp_path)
    environment = {"VERSION": "0.12.0", "COMMIT": HERE, "TAGS_FILE": str(tags), "PYPI_STATUS": "404", "RELEASE_EXISTS": "false",
                   "PUBLISH_RUNS": "0", "GITHUB_OUTPUT": str(tmp_path / "out"), "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"),
                   **overrides}
    notes = tmp_path / "notes.md"
    return release_plan.main(["--notes", str(notes)], environment), notes


def test_the_script_writes_the_notes_and_the_outputs(tmp_path, monkeypatch):
    code, notes = run(tmp_path, monkeypatch)
    assert code == 0
    assert notes.read_text(encoding="utf-8") == "Intro line.\n\n### Added\n\n- A new thing.\n"
    assert (tmp_path / "out").read_text(encoding="utf-8") == "create=true\nprerelease=false\ndispatch=true\n"


def test_the_script_writes_nothing_on_a_refusal(tmp_path, monkeypatch, capsys):
    code, notes = run(tmp_path, monkeypatch, PYPI_STATUS="200")
    assert code == 1 and not notes.exists() and not (tmp_path / "out").exists()
    assert "already on the package index" in capsys.readouterr().err
    assert "refuse: " in (tmp_path / "summary").read_text(encoding="utf-8")


def test_the_script_does_nothing_for_an_old_tag(tmp_path, monkeypatch):
    code, notes = run(tmp_path, monkeypatch, VERSION="0.11.0")
    assert code == 0 and not notes.exists()
    assert (tmp_path / "out").read_text(encoding="utf-8") == "create=false\nprerelease=false\ndispatch=false\n"
