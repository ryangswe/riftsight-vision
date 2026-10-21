# SPDX-License-Identifier: Apache-2.0
"""The release process leaves its traces in the tree: a changelog for the version being built, and a
stability page that names every command."""

from __future__ import annotations

import re
from pathlib import Path

from cardvision.cli import SUBCOMMANDS

ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
HEADING = re.compile(r"^## \[(?P<name>Unreleased|\d+\.\d+\.\d+(?:rc\d+)?)\](?: - (?P<date>\d{4}-\d{2}-\d{2}))?$", re.M)
KINDS = {"Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"}


def version() -> str:
    text = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    return re.search(r'^version = "([^"]+)"', text, re.M).group(1)


def sections() -> dict[str, str]:
    found = list(HEADING.finditer(CHANGELOG))
    return {m["name"]: CHANGELOG[m.end(): found[i + 1].start() if i + 1 < len(found) else len(CHANGELOG)]
            for i, m in enumerate(found)}


def test_the_changelog_has_an_unreleased_section_and_one_for_every_released_version():
    found = sections()
    assert "Unreleased" in found and "0.1.0" in found
    for match in HEADING.finditer(CHANGELOG):
        assert (match["name"] == "Unreleased") == (match["date"] is None), match.group(0)
    assert list(found)[0] == "Unreleased"


def test_the_changelog_covers_the_version_in_pyproject_or_has_unreleased_entries():
    found = sections()
    assert version() in found or found["Unreleased"].strip(), "no section for this version and nothing under Unreleased"


def test_every_changelog_section_uses_the_standard_headings_and_lists_something():
    for name, body in sections().items():
        kinds = re.findall(r"^### (.+)$", body, re.M)
        assert set(kinds) <= KINDS, (name, kinds)
        assert any(line.startswith("- ") for line in body.splitlines()), name


def test_the_stability_page_names_every_command():
    text = (ROOT / "docs" / "stability.md").read_text(encoding="utf-8")
    assert SUBCOMMANDS
    missing = [name for name in SUBCOMMANDS if f"`{name}`" not in text]
    assert not missing, f"docs/stability.md does not name: {missing}"


def test_dependabot_covers_pip_npm_and_actions_monthly_and_grouped():
    text = (ROOT / ".github" / "dependabot.yml").read_text(encoding="utf-8")
    assert re.findall(r"package-ecosystem: (\S+)", text) == ["pip", "npm", "github-actions"]
    assert text.count("interval: monthly") == 3 and text.count("patterns:") == 3


def test_the_pull_request_template_asks_for_a_changelog_line():
    text = (ROOT / ".github" / "PULL_REQUEST_TEMPLATE.md").read_text(encoding="utf-8")
    assert "no user-visible change" in text and "CHANGELOG.md" in text


def test_security_names_the_report_a_vulnerability_button_beside_the_email():
    text = (ROOT / "SECURITY.md").read_text(encoding="utf-8")
    assert "Report a vulnerability" in text and "riftsight.support@gmail.com" in text
