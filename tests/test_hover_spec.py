# SPDX-License-Identifier: Apache-2.0
"""docs/hover-spec.json is the generated index of docs/hover-spec.md, and the Markdown is well
formed: unique, well-formed clause ids, and every test reference names an existing ``it(`` /
``it.each(`` (or pytest ``def test_``) line. The tests below run the generator on small fixtures
to show it fails on each fault."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from support_hover_spec import INDEX, ROOT, SPEC, parse, render

GOOD = """# Spec

## A. Loading

### S-A1 — One

Rule.

Status: changes in 0.14.0.

Today: it does less.

Test: `x.test.ts:2`, pending (real-browser test); the target: `x.test.ts:5`

### S-A2 — Two

Rule. See S-A1.

Test: `x.test.ts:4`
"""


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    folder = tmp_path / "browser" / "test"
    folder.mkdir(parents=True)
    (folder / "x.test.ts").write_text('describe("d", () => {\n  it("a", () => {});\n  // c\n  it.each([1])("b", () => {});\n  it.fails("t", () => {});\n});\n')
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_y.py").write_text("import x\n\ndef test_a():\n    pass\n")
    return tmp_path


def problems_of(text: str, root: Path) -> list[str]:
    return parse(text, root)[1]


def test_the_committed_index_matches_the_markdown():
    index, problems = parse(SPEC.read_text(encoding="utf-8"))
    assert not problems, "\n".join(problems)
    assert INDEX.read_text(encoding="utf-8") == render(index), "run: python tests/support_hover_spec.py"


def test_the_index_is_complete():
    index = json.loads(INDEX.read_text(encoding="utf-8"))
    ids = [c["id"] for c in index["clauses"]]
    assert len(ids) == len(set(ids)) > 0
    assert {c["group"] for c in index["clauses"]} <= set(index["groups"])
    assert all(c["tests"] or c["pending"] for c in index["clauses"])


def test_a_good_fixture_parses(tree):
    index, problems = parse(GOOD, tree)
    assert problems == []
    one, second = index["clauses"]
    assert (one["id"], one["group"], one["title"], one["status"]) == ("S-A1", "A", "One", "changes in 0.14.0")
    assert one["tests"] == [{"file": "x.test.ts", "line": 2, "target": False}, {"file": "x.test.ts", "line": 5, "target": True}] and one["pending"] == ["real-browser test"]
    assert second["status"] == "current"


def test_a_python_test_line_resolves(tree):
    text = GOOD.replace("`x.test.ts:4`", "`tests/test_y.py:3`")
    assert problems_of(text, tree) == []


@pytest.mark.parametrize("old, new, expected", [
    ("S-A2 — Two", "S-A1 — Two", "duplicate clause id S-A1"),
    ("S-A2 — Two", "S-A02 — Two", "malformed clause heading"),
    ("S-A2 — Two", "S-J2 — Two", "malformed clause heading"),
    ("S-A2 — Two", "S-A2 - Two", "malformed clause heading"),
    ("S-A2 — Two", "S-B2 — Two", "sits under group 'A'"),
    ("`x.test.ts:4`", "`x.test.ts:3`", "not an it( / it.each( / def test_ line"),
    ("`x.test.ts:4`", "`x.test.ts:99`", "the file has 6 lines"),
    ("`x.test.ts:4`", "`gone.test.ts:4`", "no such file"),
    ("`x.test.ts:4`", "`x.test.ts`", "malformed test reference"),
    ("`x.test.ts:4`", "`x.test.ts:0`", "malformed test reference"),
    ("`x.test.ts:4`", "`tests/test_y.py:1`", "not an it( / it.each( / def test_ line"),
    ("Test: `x.test.ts:4`", "Test: pending (somewhere)", "unknown pending kind"),
    ("Test: `x.test.ts:4`", "Test: none yet", "no reference and no pending mark"),
    ("Test: `x.test.ts:4`", "", "exactly one Test paragraph"),
    ("Status: changes in 0.14.0.", "Status: later", "unknown status"),
    ("Status: changes in 0.14.0.", "Status: changes in 0.14.0. After it, more.", "words after it"),
    ("Status: changes in 0.14.0.", "Status: changes in a product release", None),
    ("Today: it does less.\n\n", "", "needs a Today paragraph"),
    ("Rule. See S-A1.", "Rule. See S-Z1.", "S-Z1 is mentioned but no clause has that id"),
    ("Rule. See S-A1.", "Rule. See `x.test.ts:3`.", "not an it( / it.each( / def test_ line"),
    ("Rule. See S-A1.", "Rule. See `gone.test.ts:3`.", "no such file"),
    ("Rule. See S-A1.", "Rule. See `x.test.ts`.", "malformed test reference"),
    ("; the target: `x.test.ts:5`", "; `x.test.ts:5`", 'does not say "target"'),
    ("Test: `x.test.ts:4`", "Test: the target `x.test.ts:5`", "not changing"),
    ("See S-A1.", "See S-A9.", "S-A9 is mentioned but no clause has that id"),
])
def test_a_fault_is_found(tree, old, new, expected):
    text = GOOD.replace(old, new)
    assert text != GOOD
    found = problems_of(text, tree)
    if expected is None:
        assert found == []
    else:
        assert any(expected in line for line in found), found


def test_a_second_status_line_is_a_fault(tree):
    text = GOOD.replace("Status: changes in 0.14.0.\n", "Status: changes in 0.14.0.\n\nStatus: open decision.\n")
    assert any("more than one Status" in line for line in problems_of(text, tree))


def test_a_clause_outside_any_group_is_a_fault(tree):
    text = GOOD.replace("## A. Loading\n", "")
    assert any("sits under group None" in line for line in problems_of(text, tree))


def test_the_spec_is_linked_from_the_docs():
    text = (ROOT / "docs" / "extension.md").read_text(encoding="utf-8")
    assert "hover-spec.md" in text
