# SPDX-License-Identifier: Apache-2.0
"""docs/hover-map.md names the code it maps, and the names are real.

The map ties each element to code by anchors, written ``browser/src/<file>.ts#<symbol>``. This test
checks names only: the file exists, the file defines the symbol (a function, class, interface,
type, constant or method, not just a mention), every spec clause the map cites exists in
docs/hover-spec.md, and every file in the map's coverage list carries at least one anchor. It does
not check behavior; the diagrams are read by a reviewer. It does catch a semicolon in a sequence
diagram, which ends the line there and stops the diagram from drawing. Nothing here reads the
network.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MAP = ROOT / "docs" / "hover-map.md"
SPEC = ROOT / "docs" / "hover-spec.md"

FIX = "update docs/hover-map.md in the same change (names it anchors, the clause ids it cites, its coverage list)"

# `browser/src/x.ts` or `browser/src/x.ts#Class.method`, in backticks.
ANCHOR = re.compile(r"`(browser/src/[A-Za-z0-9_./-]+\.ts)(?:#([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?))?`")
CLAUSE = re.compile(r"\bS-[A-Z]\d+\b")
SPEC_HEADING = re.compile(r"^### (S-[A-Z]\d+) ", re.M)


def split_coverage(text: str) -> tuple[str, str]:
    """The map's body, and its ``## Coverage`` section."""
    head, sep, tail = text.partition("\n## Coverage\n")
    return head, tail if sep else ""


def strip_code(source: str) -> str:
    """The source without comments and the text of quoted strings, so braces in them are not counted."""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    source = re.sub(r"(?m)(^|[^:\\'\"`])//[^\n]*", r"\1", source)
    return re.sub(r"\"(?:\\.|[^\"\\\n])*\"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`", '""', source)


def class_members(source: str, cls: str) -> list[str]:
    """The lines of ``cls`` that start at the depth of its members (not inside a method's body)."""
    lines = strip_code(source).splitlines()
    start = next((i for i, line in enumerate(lines) if re.search(rf"\bclass\s+{re.escape(cls)}\b", line)), None)
    if start is None:
        return []
    members: list[str] = []
    depth = 0
    opened = False
    for line in lines[start:]:
        if opened and depth == 1:
            members.append(line)
        depth += line.count("{") - line.count("}")
        opened = opened or depth > 0
        if opened and depth <= 0:
            break
    return members


def method_line(name: str) -> re.Pattern[str]:
    word = re.escape(name)
    return re.compile(rf"^[ \t]+(?:(?:private|public|protected|static|async|readonly|override)\s+)*(?:(?:get|set)\s+)?{word}"
                      rf"\s*(?:<[^>\n]*>)?\([^\n]*\)\s*(?::[^\n]*)?\{{\s*(?:\}}\s*)?$")


def defined(source: str, symbol: str) -> bool:
    """Whether ``source`` defines ``symbol`` rather than mentions it. ``name``: a function, class,
    interface, type, enum or constant, or a method. ``Class.name``: a method written in the body
    of that class, and nothing else (a local of the same name does not count)."""
    cls, _, name = symbol.rpartition(".")
    if cls:
        pattern = method_line(name)
        return any(pattern.match(line) for line in class_members(source, cls))
    declared = rf"\b(?:function\*?|class|interface|type|enum|const|let|var)\s+{re.escape(name)}\b"
    source = strip_code(source)
    return bool(re.search(declared, source) or re.search(method_line(name).pattern, source, re.M))


def problems_of(text: str, root: Path, spec_text: str) -> list[str]:
    body, coverage = split_coverage(text)
    found: list[str] = []
    clauses = set(SPEC_HEADING.findall(spec_text))
    anchored: set[str] = set()
    anchors = ANCHOR.findall(body)
    if not anchors:
        found.append("the map has no anchors")
    for path, symbol in anchors:
        file = root / path
        if not file.is_file():
            found.append(f"anchor {path}#{symbol}: the file does not exist")
            continue
        anchored.add(path)
        if symbol and not defined(file.read_text(encoding="utf-8"), symbol):
            found.append(f"anchor {path}#{symbol}: {path} defines no {symbol}")
    for clause in sorted(set(CLAUSE.findall(body)) - clauses):
        found.append(f"clause {clause} is not in docs/hover-spec.md")
    covered = ANCHOR.findall(coverage)
    if not covered:
        found.append("the map has no coverage list")
    for path, _ in covered:
        if not (root / path).is_file():
            found.append(f"coverage {path}: the file does not exist")
        elif path not in anchored:
            found.append(f"coverage {path}: no anchor in the map names this file")
    if len(re.findall(r"^```mermaid$", body, re.M)) < 3 or "sequenceDiagram" not in body:
        found.append("the map needs its Mermaid diagrams (at least three, one a sequenceDiagram)")
    for block in re.findall(r"^```mermaid[ \t]*\n(.*?)^```", body, re.M | re.S):
        if not re.search(r"^\s*sequenceDiagram\b", block, re.M):
            continue
        for line in block.splitlines():
            if ";" in line:
                found.append(f"a semicolon ends a sequence diagram line and breaks the diagram: {line.strip()}")
    return found


def test_the_map_matches_the_code():
    found = problems_of(MAP.read_text(encoding="utf-8"), ROOT, SPEC.read_text(encoding="utf-8"))
    assert not found, f"docs/hover-map.md is out of date with the code: {FIX}\n  " + "\n  ".join(found)


def test_every_source_file_in_the_coverage_list_is_a_real_file_and_listed_once():
    _, coverage = split_coverage(MAP.read_text(encoding="utf-8"))
    paths = [p for p, _ in ANCHOR.findall(coverage)]
    assert paths and len(paths) == len(set(paths)), f"the coverage list is empty or repeats a file: {FIX}"


# The checker itself, on small trees: it must fail on each kind of drift.

SOURCE = """export const LIMIT = 3;
export interface Thing { a: number }
export function top(x: number): number {
  const inner = (): void => {};
  return x;
}
export class Box {
  private hidden(): boolean {
    return true;
  }
  show(a: number, b?: string): void {
    const inner = 1;
    this.hidden();
  }
}
export class Other {
  other(): void {
    const inner = (): void => {};
  }
}
// mentioned() only in a comment
"""
GOOD = """# Map

```mermaid
flowchart LR
  A --> B
```
```mermaid
flowchart LR
  A --> B
```
```mermaid
sequenceDiagram
  A->>B: m
```

| E | Anchors | Spec |
| --- | --- | --- |
| a | `browser/src/x.ts#top`, `browser/src/x.ts#Box.show`, `browser/src/x.ts#LIMIT` | S-A1 |

## Coverage

- `browser/src/x.ts`
"""
SPEC_TEXT = "### S-A1 — One\n\nRule.\n"


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    (tmp_path / "browser" / "src").mkdir(parents=True)
    (tmp_path / "browser" / "src" / "x.ts").write_text(SOURCE, encoding="utf-8")
    (tmp_path / "browser" / "src" / "y.ts").write_text("export const Y = 1;\n", encoding="utf-8")
    return tmp_path


def test_a_sound_map_passes(tree: Path):
    assert problems_of(GOOD, tree, SPEC_TEXT) == []


def test_a_semicolon_in_a_flowchart_is_not_flagged(tree: Path):
    text = GOOD.replace("  A --> B\n", '  A --> B;\n  B["one; two"]\n', 1)
    assert text != GOOD
    assert problems_of(text, tree, SPEC_TEXT) == []


@pytest.mark.parametrize("old, new, expected", [
    ("#top`", "#bottom`", "defines no bottom"),
    ("#Box.show`", "#Box.hide`", "defines no Box.hide"),
    ("#Box.show`", "#Crate.show`", "defines no Crate.show"),
    ("#Box.show`", "#Other.show`", "defines no Other.show"),
    ("#Box.show`", "#Box.inner`", "defines no Box.inner"),
    ("#LIMIT`", "#mentioned`", "defines no mentioned"),
    ("browser/src/x.ts#top", "browser/src/gone.ts#top", "the file does not exist"),
    ("| S-A1 |", "| S-A9 |", "clause S-A9 is not in docs/hover-spec.md"),
    ("- `browser/src/x.ts`", "- `browser/src/x.ts`\n- `browser/src/y.ts`", "coverage browser/src/y.ts: no anchor"),
    ("- `browser/src/x.ts`", "- `browser/src/gone.ts`", "coverage browser/src/gone.ts: the file does not exist"),
    ("sequenceDiagram", "gantt", "needs its Mermaid diagrams"),
    ("  A->>B: m\n", "  A->>B: m; then n\n", "a semicolon ends a sequence diagram line"),
    ("sequenceDiagram\n  A->>B: m\n", "%% a comment first\nsequenceDiagram\n  A->>B: m; then n\n",
     "a semicolon ends a sequence diagram line"),
])
def test_each_kind_of_drift_is_found(tree: Path, old: str, new: str, expected: str):
    assert GOOD.count(old) >= 1
    found = problems_of(GOOD.replace(old, new, 1), tree, SPEC_TEXT)
    assert any(expected in line for line in found), found


def test_the_coverage_list_does_not_count_as_an_anchor(tree: Path):
    only_listed = GOOD.split("| E |")[0] + "\n## Coverage\n\n- `browser/src/x.ts`\n"
    assert any("the map has no anchors" in line for line in problems_of(only_listed, tree, SPEC_TEXT))


def test_a_dotted_anchor_needs_a_method_of_that_class_not_a_local_or_a_function():
    source = "export class A {\n  run(): void {\n    const show = (): void => {};\n  }\n}\nexport function show(): void {}\nexport class B {\n  show(): void {}\n}\n"
    assert not defined(source, "A.show")  # a local and a function of that name are not a method of A
    assert defined(source, "B.show")
    assert not defined(source, "A.missing")
    assert not defined("export class A {}\nconst show = 1;\n", "A.show")


def test_a_comment_or_a_string_does_not_stand_in_for_a_symbol():
    source = "// export function gone(): void {}\n/* const gone = 1; */\nconst text = \"function gone() {}\";\n"
    assert not defined(source, "gone")
    assert defined("export function gone(): void {}\n", "gone")
