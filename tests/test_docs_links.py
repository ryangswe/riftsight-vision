# SPDX-License-Identifier: Apache-2.0
"""Every relative Markdown link and ``#anchor`` in the documents resolves: the file exists and an
anchor names a heading (or an explicit HTML anchor) in it. External links are listed, never fetched."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote

import pytest

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = ("README.md", "AGENTS.md", "docs/*.md", "playbooks/*.md", "browser/README.md", "games/*/README.md", "labeler/*.md",
            "data/README.md", "CONTRIBUTING.md", "SUPPORT.md")

FENCE = re.compile(r"^\s*(```+|~~~+)")
HEADING = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$")
INLINE_LINK = re.compile(r"(?<!!)\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)|!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]*)")
REFERENCE_DEF = re.compile(r"^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)")
HTML_ANCHOR = re.compile(r"<a\s[^>]*?\b(?:id|name)=[\"']([^\"']+)[\"']", re.I)
HTML_HREF = re.compile(r"<(?:a|img)\s[^>]*?\b(?:href|src)=[\"']([^\"']+)[\"']", re.I)


def documents(root: Path = ROOT) -> list[Path]:
    return sorted({path for pattern in PATTERNS for path in root.glob(pattern) if path.is_file()})


def prose_lines(text: str) -> list[str]:
    """The lines outside fenced code blocks."""
    lines, fence = [], None
    for line in text.splitlines():
        marker = FENCE.match(line)
        if fence is None and marker:
            fence = marker.group(1)[0]
        elif fence is not None and marker and marker.group(1)[0] == fence:
            fence = None
        elif fence is None:
            lines.append(line)
    return lines


def slug(heading: str) -> str:
    """GitHub's anchor for a heading's text: links and code reduced to their text, lowercase,
    spaces to ``-``, other punctuation dropped (``-`` and ``_`` kept)."""
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", heading)
    text = re.sub(r"<[^>]+>", "", text).replace("`", "")
    text = re.sub(r"[*~]|(?<!\w)_|_(?!\w)", "", text).strip().lower()
    return re.sub(r"[^\w\- ]", "", text).replace(" ", "-")


def anchors(text: str) -> set[str]:
    found, seen = set(), {}
    lines = prose_lines(text)
    for line in lines:
        heading = HEADING.match(line)
        if heading:
            base = slug(heading.group(2))
            count = seen.get(base, 0)
            seen[base] = count + 1
            found.add(base if count == 0 else f"{base}-{count}")
        found.update(HTML_ANCHOR.findall(line))
    return found


def links(text: str) -> list[str]:
    found = []
    for line in prose_lines(text):
        line = re.sub(r"`[^`]*`", "", line)
        for match in INLINE_LINK.finditer(line):
            found.append(match.group(1) or match.group(2))
        reference = REFERENCE_DEF.match(line)
        if reference:
            found.append(reference.group(1))
        found.extend(HTML_HREF.findall(line))
    return [target.strip("<>") for target in found if target.strip("<>")]


def is_external(target: str) -> bool:
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target)) or target.startswith("//")


def problems(path: Path, root: Path = ROOT) -> list[str]:
    """What is wrong with the relative links of one document, one line per broken link."""
    text = path.read_text(encoding="utf-8")
    broken = []
    for target in links(text):
        if is_external(target):
            continue
        file_part, _, fragment = target.partition("#")
        destination = path if not file_part else (path.parent / unquote(file_part)).resolve()
        name = path.relative_to(root)
        if not destination.exists():
            broken.append(f"{name}: {target} -> no such file")
        elif fragment and destination.suffix == ".md" and unquote(fragment).lower() not in anchors(destination.read_text(encoding="utf-8")):
            broken.append(f"{name}: {target} -> no heading or anchor '{fragment}'")
    return broken


def external_links(root: Path = ROOT) -> list[str]:
    """The http(s) links the documents carry; listed for a person, never fetched."""
    return sorted({t for p in documents(root) for t in links(p.read_text(encoding="utf-8")) if t.startswith(("http://", "https://"))})


def test_the_documents_are_found():
    names = {path.relative_to(ROOT).as_posix() for path in documents()}
    assert {"README.md", "AGENTS.md", "CONTRIBUTING.md", "SUPPORT.md", "browser/README.md", "data/README.md"} <= names
    assert any(name.startswith("docs/") for name in names)


def test_every_relative_link_and_anchor_resolves():
    broken = [line for path in documents() for line in problems(path)]
    assert not broken, "broken links:\n" + "\n".join(broken)


def test_external_links_are_listed_not_fetched():
    assert all(link.startswith(("http://", "https://")) for link in external_links())


def test_slug_follows_github_rules():
    assert slug("Try it: `cardvision infer` [now](x.md)!") == "try-it-cardvision-infer-now"
    assert slug("Under_score & more-dash") == "under_score--more-dash"


def test_duplicate_headings_get_numbered_anchors():
    assert {"intro", "intro-1", "intro-2"} <= anchors("# Intro\n## Intro\n## Intro\n")


def test_links_in_fenced_code_are_ignored():
    assert links("```\n[x](nowhere.md)\n```\n[y](here.md)\n") == ["here.md"]


@pytest.mark.parametrize("body, expected", [
    ("[a](missing.md)\n", "no such file"),
    ("[a](#nope)\n# Real\n", "no heading or anchor 'nope'"),
    ("[a](other.md#nope)\n", "no heading or anchor 'nope'"),
])
def test_a_broken_fixture_fails(tmp_path, body, expected):
    (tmp_path / "other.md").write_text("# Other\n")
    page = tmp_path / "page.md"
    page.write_text(body)
    result = problems(page, tmp_path)
    assert len(result) == 1 and expected in result[0]


def test_a_good_fixture_passes(tmp_path):
    (tmp_path / "other.md").write_text("# Other Page\n<a id=\"extra\"></a>\n")
    page = tmp_path / "page.md"
    page.write_text("[a](other.md#other-page) [b](other.md#extra) [c](#real) [d](https://x.example/y#z)\n# Real\n")
    assert problems(page, tmp_path) == []


# Anchors of the adapt guide that pages outside this repository link to (the example extension's
# guide, video descriptions): the guide was split into pages, and the hub keeps them.
INBOUND = {
    "docs/adapt-your-game.md": ("tier-0-try-it", "tier-1-make-it-yours", "tier-2-ship-it",
                                "9-put-it-in-a-browser-extension-optional",
                                "measured-on-another-game-the-one-piece-card-game", "before-you-start",
                                "if-something-fails"),
}


def test_the_anchors_other_sites_link_to_still_resolve():
    for document, names in INBOUND.items():
        found = anchors((ROOT / document).read_text(encoding="utf-8"))
        assert [name for name in names if name not in found] == [], document
    # Linked from video descriptions: the page stays, as a pointer to where it moved.
    overview = (ROOT / "docs" / "overview.md").read_text(encoding="utf-8")
    assert "(start-here.md)" in overview and "(how-it-works.md#at-a-glance)" in overview
