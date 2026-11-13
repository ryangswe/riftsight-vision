# SPDX-License-Identifier: Apache-2.0
"""Prepares the version commit of a release: the mechanical part, so a person writes only the prose.

    python tests/release_prepare.py --version 0.15.0 [--date 2026-12-01] [--check]

It moves the entries under ``## [Unreleased]`` of ``CHANGELOG.md`` beneath a new ``## [X] - date``
heading, leaving an empty Unreleased section above it, rewrites the compare links at the bottom of
the changelog, and sets the five places that name the version: ``pyproject.toml``,
``cardvision/__init__.py``, ``docs/quickstart.md``, ``playbooks/setup.md`` and the quickstart marker of
``tests/beginner_path.py``. Each is found by its pattern, not by its line.

The compare link of a final version compares it with the previous final version; a first candidate
(``rc1``) does too; a later candidate (``rcN``) compares with ``rc(N-1)``.

It refuses a version that is not ``X.Y.Z`` or ``X.Y.ZrcN``, one that is not greater than the current
version, an empty Unreleased section and a tree with uncommitted changes (``--check`` only prints the
planned changes, on any tree). It writes no prose: the introduction of the release and its
"Changes that may need action" lines are the maintainer's.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from datetime import date as today_of
from pathlib import Path

from release_plan import HEADING, VERSION, sort_key

ROOT = Path(__file__).resolve().parents[1]
# Where the version is written: file, pattern with the version in group "v".
STRINGS = {
    "pyproject.toml": re.compile(r'^version = "(?P<v>[^"]+)"$', re.M),
    "cardvision/__init__.py": re.compile(r'^__version__ = "(?P<v>[^"]+)"$', re.M),
    "docs/quickstart.md": re.compile(r"^cardvision (?P<v>\d+\.\d+\.\d+(?:rc\d+)?)$", re.M),
    "playbooks/setup.md": re.compile(r"^- \*\*Expect:\*\* `cardvision (?P<v>[^`]+)`\.$", re.M),
    "tests/beginner_path.py": re.compile(r'^    \(QUICKSTART, "cardvision (?P<v>\d+\.\d+\.\d+(?:rc\d+)?)"\),$', re.M),
}
UNRELEASED_LINK = re.compile(r"^\[Unreleased\]: (?P<base>\S+)/compare/v(?P<last>\S+?)\.\.\.HEAD$", re.M)
REMINDER = ("Not written: the introduction of the release and its \"Changes that may need action\" lines "
            "are the maintainer's. Add them under the new heading before the pull request.")


class Refused(Exception):
    pass


def read_strings(root: Path) -> dict[str, str]:
    """The version each of the five places names; a place with no match, or two, is an error."""
    found = {}
    for name, pattern in STRINGS.items():
        matches = pattern.findall((root / name).read_text(encoding="utf-8"))
        if len(matches) != 1:
            raise Refused(f"{name}: expected one version string, found {len(matches)}.")
        found[name] = matches[0]
    return found


def previous_link_target(version: str, names: list[str]) -> str:
    """The version a new section compares with, from the versions the changelog already has."""
    older = [name for name in names if name != version and sort_key(name) < sort_key(version)]
    major, minor, patch, candidate = VERSION.fullmatch(version).groups()
    if candidate is not None and int(candidate) > 1:
        earlier = f"{major}.{minor}.{patch}rc{int(candidate) - 1}"
        if earlier in older:
            return earlier
        raise Refused(f"The changelog has no section for {earlier}, which {version} compares with.")
    finals = [name for name in older if "rc" not in name]
    if not finals:
        raise Refused(f"The changelog has no earlier final version for {version} to compare with.")
    return max(finals, key=sort_key)


def change_changelog(text: str, version: str, date: str) -> str:
    sections = list(HEADING.finditer(text))
    unreleased = next((m for m in sections if m["name"] == "Unreleased"), None)
    if unreleased is None:
        raise Refused("CHANGELOG.md has no Unreleased section.")
    after = sections[sections.index(unreleased) + 1]
    body = text[unreleased.end(): after.start()].strip("\n")
    if not body.strip():
        raise Refused("The Unreleased section of CHANGELOG.md is empty; there is nothing to release.")
    if any(m["name"] == version for m in sections):
        raise Refused(f"CHANGELOG.md already has a section for {version}.")
    names = [m["name"] for m in sections if m["name"] != "Unreleased"]
    link = UNRELEASED_LINK.search(text)
    if link is None:
        raise Refused("CHANGELOG.md has no [Unreleased] compare link.")
    target = previous_link_target(version, names)
    base = link["base"]
    new_links = (f"[Unreleased]: {base}/compare/v{version}...HEAD\n"
                 f"[{version}]: {base}/compare/v{target}...v{version}")
    text = text[:link.start()] + new_links + text[link.end():]
    head, rest = text[:unreleased.end()], text[after.start():]
    return f"{head}\n\n## [{version}] - {date}\n\n{body}\n\n{rest}"


def tree_is_clean(root: Path) -> bool:
    done = subprocess.run(["git", "-C", str(root), "status", "--porcelain"], capture_output=True, text=True)
    if done.returncode != 0:
        raise Refused("Could not read the state of the tree with git.")
    return not done.stdout.strip()


def prepare(root: Path, version: str, date: str, check: bool) -> list[str]:
    """Plan the changes, refuse what must be refused and, unless ``check``, write them. Returns the plan."""
    if not VERSION.fullmatch(version):
        raise Refused(f"{version!r} is not X.Y.Z or X.Y.ZrcN.")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise Refused(f"{date!r} is not a date as YYYY-MM-DD.")
    current = read_strings(root)
    if len(set(current.values())) != 1:
        raise Refused(f"The files disagree on the current version: {current}")
    old = current["pyproject.toml"]
    if sort_key(version) <= sort_key(old):
        raise Refused(f"{version} is not greater than the current version {old}.")
    changelog = root / "CHANGELOG.md"
    new_text = change_changelog(changelog.read_text(encoding="utf-8"), version, date)
    if not check and not tree_is_clean(root):
        raise Refused("The tree has uncommitted changes; commit or stash them first (--check ignores this).")
    writes = {changelog: new_text}
    compare = re.search(rf"^\[{re.escape(version)}\]: \S+/compare/(\S+)$", new_text, re.M)[1]
    plan = [f"CHANGELOG.md: Unreleased entries move under ## [{version}] - {date}; link compare/{compare}"]
    for name, pattern in STRINGS.items():
        path = root / name
        text = path.read_text(encoding="utf-8")
        writes[path] = pattern.sub(lambda m: m.group(0).replace(m["v"], version), text)
        plan.append(f"{name}: {old} -> {version}")
    if not check:
        for path, text in writes.items():
            path.write_text(text, encoding="utf-8")
    return plan


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--version", required=True)
    parser.add_argument("--date", default=today_of.today().isoformat(), help="YYYY-MM-DD; default today")
    parser.add_argument("--check", action="store_true", help="print the planned changes and write nothing")
    parser.add_argument("--root", type=Path, default=ROOT, help="the tree to change (default: this repository)")
    arguments = parser.parse_args(argv)
    try:
        plan = prepare(arguments.root, arguments.version, arguments.date, arguments.check)
    except Refused as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    print(("Planned (nothing written):" if arguments.check else "Written:"))
    for line in plan:
        print(f"  {line}")
    print(REMINDER)
    return 0


if __name__ == "__main__":
    sys.exit(main())
