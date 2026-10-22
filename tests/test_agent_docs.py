# SPDX-License-Identifier: Apache-2.0
"""The files a coding agent reads stay short, name each other, and name only commands and flags
that exist. An agent follows the text literally; a command the CLI no longer has, or a playbook
nothing points to, is a dead end for it."""

from __future__ import annotations

import argparse
import re
import textwrap
from pathlib import Path

from cardvision.cli import build_parser

ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / "AGENTS.md"
PLAYBOOKS = sorted((ROOT / "playbooks").glob("*.md"))
# AGENTS.md is read whole by every session; a playbook one job at a time.
AGENTS_LINES = 150
PLAYBOOK_LINES = 400

# A fenced block, at the margin or indented under a list item; its closing fence as indented.
FENCE = re.compile(r"^([ \t]*)```[^\n]*\n(.*?)^\1```", re.M | re.S)
INLINE = re.compile(r"`(cardvision [^`]+)`")
# Inline code that starts with a word and a flag, such as `try --download`: a command when the
# word is a subcommand's name.
BARE = re.compile(r"`([a-z][a-z-]*) (--[^`]*)`")


def subcommands() -> dict[str, argparse.ArgumentParser]:
    for action in build_parser()._actions:
        if isinstance(action, argparse._SubParsersAction):
            return dict(action.choices)
    raise AssertionError("no subcommands")


def mentions(text: str):
    """Every `cardvision ...` the text shows as a command: in code blocks, indented ones
    included (one per shell segment, continuation lines joined), in inline code, and as inline
    code that names a subcommand and a flag without the program's name (`try --download`)."""
    for indent, block in FENCE.findall(text):
        block = textwrap.dedent(block) if indent else block
        for line in re.sub(r"\\\n\s*", " ", block).splitlines():
            for segment in re.split(r"&&|\|\||;|\|", line):
                found = re.search(r"(?:^|[\s(])(cardvision\s+\S.*)$", segment.strip())
                if found:
                    yield found.group(1)
    for found in INLINE.finditer(text):
        yield found.group(1)
    names = set(subcommands())
    for found in BARE.finditer(text):
        if found.group(1) in names:
            yield f"cardvision {found.group(1)} {found.group(2)}"


def test_agents_md_is_short_and_each_playbook_fits_one_job():
    assert len(AGENTS.read_text(encoding="utf-8").splitlines()) <= AGENTS_LINES
    assert PLAYBOOKS
    for path in PLAYBOOKS:
        assert len(path.read_text(encoding="utf-8").splitlines()) <= PLAYBOOK_LINES, path.name


def test_agents_md_names_every_playbook_and_only_playbooks_that_exist():
    text = AGENTS.read_text(encoding="utf-8")
    named = set(re.findall(r"\(playbooks/([^)#]+\.md)", text))
    assert named == {path.name for path in PLAYBOOKS}


def test_every_command_and_flag_the_agent_and_human_docs_show_exists():
    subs = subcommands()
    files = [AGENTS, *PLAYBOOKS, ROOT / "README.md", *sorted((ROOT / "docs").glob("*.md"))]
    bad, checked = [], 0
    for path in files:
        for command in mentions(path.read_text(encoding="utf-8")):
            words = command.split()
            name = words[1]
            # printed output ("cardvision infer: 3 frame(s)"), a version, a top-level flag
            if name.endswith(":") or name[0].isdigit() or name.startswith("-"):
                continue
            checked += 1
            if name not in subs:
                bad.append(f"{path.relative_to(ROOT)}: {command}: no command {name!r}")
                continue
            options = subs[name]._option_string_actions
            for word in words[2:]:
                if word.startswith("--"):
                    flag = word.split("=")[0].rstrip("`,.;:)")
                    if flag not in options:
                        bad.append(f"{path.relative_to(ROOT)}: {command}: {name} has no {flag}")
    assert checked > 100
    assert not bad, "\n".join(bad)


def test_indented_blocks_and_bare_subcommands_are_checked():
    """The list item's block of start-here.md, method.md's `assign-roles`, train.md's
    `fetch-textures` and AGENTS.md's list of commands that reach the network are all read."""
    def seen(name: str) -> list[str]:
        return list(mentions((ROOT / name).read_text(encoding="utf-8")))

    assert any(command.startswith("cardvision try \"$GAME/cards.csv\"") for command in seen("docs/start-here.md"))
    assert any(command.startswith("cardvision assign-roles ") for command in seen("docs/method.md"))
    assert any(command.startswith("cardvision fetch-textures --index") for command in seen("docs/train.md"))
    agents = seen("AGENTS.md")
    for command in ("cardvision try --download", "cardvision import-catalog --download",
                    "cardvision train-detector --download-pretrained", "cardvision fetch --download"):
        assert any(found.startswith(command) for found in agents), command


def test_a_bare_word_and_flag_that_is_no_subcommand_is_not_taken_for_one():
    assert list(mentions("Run `npm ci --omit dev`, `python3 --version` and `try --download`.")) == [
        "cardvision try --download"]
