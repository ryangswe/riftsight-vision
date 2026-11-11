# SPDX-License-Identifier: Apache-2.0
"""Decides what a push to ``main`` does about a release, from facts it is given.

``.github/workflows/release.yml`` gathers the facts (the tags on the remote, what the package
index answers for the version, whether the GitHub release and a Publish run exist), runs this
script, and then creates the release and starts the upload only as the script's outputs say. The
decision itself reads no network and no git, so ``tests/test_release_plan.py`` runs it on made-up
facts. The changelog parser lives here too; ``tests/test_release_process.py`` uses it.

Environment: ``VERSION``, ``COMMIT`` (the pushed commit), ``TAGS_FILE`` (the output of
``git ls-remote --tags``), ``PYPI_STATUS`` (an HTTP status, or ``000``), ``RELEASE_EXISTS``
(``true`` or ``false``), ``PUBLISH_RUNS`` (a count). ``--notes`` names the notes file to write.
Outputs go to ``GITHUB_OUTPUT`` and the reason to ``GITHUB_STEP_SUMMARY`` when those are set.
Exit 0 when the plan is to release or to do nothing, 1 on a refusal.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEADING = re.compile(r"^## \[(?P<name>Unreleased|\d+\.\d+\.\d+(?:rc\d+)?)\](?: - (?P<date>\d{4}-\d{2}-\d{2}))?$", re.M)
VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)(?:rc(\d+))?")
TAG_REF = re.compile(r"^(?P<sha>[0-9a-f]{40})\s+refs/tags/(?P<tag>.+?)(?P<peeled>\^\{\})?$")


def sections(text: str) -> dict[str, str]:
    """The changelog's sections: ``{heading name: the text under it, up to the next heading}``."""
    found = list(HEADING.finditer(text))
    return {m["name"]: text[m.end(): found[i + 1].start() if i + 1 < len(found) else len(text)]
            for i, m in enumerate(found)}


def notes_for(text: str, version: str) -> str | None:
    """The body of a dated, non-empty section for ``version``, without its heading; else None."""
    found = list(HEADING.finditer(text))
    for i, match in enumerate(found):
        body = text[match.end(): found[i + 1].start() if i + 1 < len(found) else len(text)]
        if match["name"] == version and match["date"] and body.strip():
            return body.strip() + "\n"
    return None


def sort_key(version: str) -> tuple[int, int, int, float]:
    """Order of versions: a release candidate sorts before the release it leads to."""
    major, minor, patch, candidate = VERSION.fullmatch(version).groups()
    return int(major), int(minor), int(patch), float("inf") if candidate is None else int(candidate)


def tags_of(listing: str) -> tuple[dict[str, str], list[str]]:
    """From ``git ls-remote --tags``: ``({tag: the commit it points at}, the version tags' versions)``."""
    commits: dict[str, str] = {}
    for line in listing.splitlines():
        match = TAG_REF.match(line.strip())
        if match and (match["peeled"] or match["tag"] not in commits):
            commits[match["tag"]] = match["sha"]
    versions = [tag[1:] for tag in commits if tag.startswith("v") and VERSION.fullmatch(tag[1:])]
    return commits, versions


@dataclass(frozen=True)
class Facts:
    version: str
    commit: str
    tags: str                # the output of git ls-remote --tags
    pypi_status: str         # the HTTP status for the version on the package index
    release_exists: bool
    publish_runs: int        # Publish workflow runs on the version's tag
    changelog: str


@dataclass(frozen=True)
class Plan:
    action: str              # "nothing", "release" or "refuse"
    reason: str
    create: bool = False
    prerelease: bool = False
    dispatch: bool = False
    notes: str = ""


def refuse(reason: str) -> Plan:
    return Plan("refuse", reason)


def decide(facts: Facts) -> Plan:
    version = facts.version
    if not VERSION.fullmatch(version):
        return refuse(f"The version {version!r} in pyproject.toml is not X.Y.Z or X.Y.ZrcN.")
    tag = f"v{version}"
    commits, versions = tags_of(facts.tags)
    at = commits.get(tag)
    if at is not None and at != facts.commit:
        return Plan("nothing", f"{tag} is already tagged on an earlier commit; the version is not raised.")
    notes = notes_for(facts.changelog, version)
    prerelease = "rc" in version
    if at is None:
        if notes is None:
            return refuse(f"CHANGELOG.md has no dated, non-empty section [{version}]; nothing was created.")
        if facts.pypi_status == "200":
            return refuse(f"{version} is already on the package index; nothing was created.")
        if facts.pypi_status != "404":
            return refuse(f"The package index answered {facts.pypi_status} instead of 404 for {version}; "
                          "it cannot be told whether the version is free, so nothing was created.")
        newest = max(versions, key=sort_key, default=None)
        if newest is not None and sort_key(version) < sort_key(newest):
            return refuse(f"{version} is lower than the newest version tag, v{newest}; nothing was created.")
        return Plan("release", f"Releasing {tag}.", create=True, prerelease=prerelease, dispatch=True, notes=notes)
    # A re-run: the tag is at this commit. Do only what is still missing.
    create = not facts.release_exists
    if create and notes is None:
        return refuse(f"The release {tag} is missing and CHANGELOG.md has no dated, non-empty section [{version}] "
                      "for its notes; nothing was created.")
    dispatch = facts.pypi_status == "404" and facts.publish_runs == 0
    if not create and not dispatch:
        return Plan("nothing", f"{tag} is already released and its upload already started or done.")
    return Plan("release", f"Finishing {tag}: " + " and ".join(
        part for part, wanted in (("creating the release", create), ("starting the upload", dispatch)) if wanted) + ".",
        create=create, prerelease=prerelease, dispatch=dispatch, notes=notes or "")


def facts_from(environment: dict[str, str]) -> Facts:
    return Facts(version=environment["VERSION"], commit=environment["COMMIT"],
                 tags=Path(environment["TAGS_FILE"]).read_text(encoding="utf-8"),
                 pypi_status=environment["PYPI_STATUS"].strip(),
                 release_exists=environment["RELEASE_EXISTS"].strip() == "true",
                 publish_runs=int(environment["PUBLISH_RUNS"].strip()),
                 changelog=(ROOT / "CHANGELOG.md").read_text(encoding="utf-8"))


def main(argv: list[str] | None = None, environment: dict[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--notes", type=Path, required=True, help="where to write the release notes")
    arguments = parser.parse_args(argv)
    environment = dict(os.environ if environment is None else environment)
    plan = decide(facts_from(environment))
    summary = environment.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(f"{plan.action}: {plan.reason}\n")
    if plan.action == "refuse":
        print(plan.reason, file=sys.stderr)
        return 1
    if plan.create:
        arguments.notes.write_text(plan.notes, encoding="utf-8")
    output = environment.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"create={str(plan.create).lower()}\nprerelease={str(plan.prerelease).lower()}\n"
                         f"dispatch={str(plan.dispatch).lower()}\n")
    print(plan.reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())
