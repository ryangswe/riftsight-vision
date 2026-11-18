# SPDX-License-Identifier: Apache-2.0
"""docs/hover-spec.json is the generated index of docs/hover-spec.md, and the Markdown is well
formed: unique, well-formed clause ids, and every test reference names an existing ``it(`` /
``it.each(`` (or pytest ``def test_``) line. The tests below run the generator on small fixtures
to show it fails on each fault."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from support_hover_spec import COVERAGE, INDEX, ROOT, SPEC, TESTLESS, coverage, parse, render

GOOD = """# Spec

## A. Loading

### S-A1 — One

Rule.

Status: changes in 0.14.0.

Today: it does less.

Test: `x.test.ts:2`, pending (real-browser test); the target: `x.test.ts:5`; harness check first-check

### S-A2 — Two

Rule. See S-A1.

Test: `x.test.ts:4`; harness checks other-check, first-check
"""


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    folder = tmp_path / "browser" / "test"
    folder.mkdir(parents=True)
    (folder / "x.test.ts").write_text('describe("d", () => {\n  it("a", () => {});\n  // c\n  it.each([1])("b", () => {});\n  it.fails("t", () => {});\n});\n')
    harness = tmp_path / "browser" / "harness"
    harness.mkdir()
    (harness / "clauses.mjs").write_text('export const CLAUSES = {\n  "first-check": "S-A1",\n  "other-check": "S-A2",\n  "loose-check": "no clause",\n};\n')
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_y.py").write_text("import x\n\ndef test_a():\n    pass\n")
    return tmp_path


def problems_of(text: str, root: Path, testless: frozenset[str] = frozenset()) -> list[str]:
    return parse(text, root, testless)[1]



def test_the_committed_index_matches_the_markdown():
    index, problems = parse(SPEC.read_text(encoding="utf-8"))
    assert not problems, "\n".join(problems)
    assert INDEX.read_text(encoding="utf-8") == render(index), "run: python tests/support_hover_spec.py"


def test_the_index_is_complete():
    index = json.loads(INDEX.read_text(encoding="utf-8"))
    ids = [c["id"] for c in index["clauses"]]
    assert len(ids) == len(set(ids)) > 0
    assert {c["group"] for c in index["clauses"]} <= set(index["groups"])
    assert all(c["tests"] or c["browser"] or c["pending"] for c in index["clauses"])


def test_a_good_fixture_parses(tree):
    index, problems = parse(GOOD, tree, frozenset())
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
    ("Test: `x.test.ts:4`; harness checks other-check, first-check", "Test: none yet", "no reference and no pending mark"),
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


def test_the_committed_coverage_doc_matches():
    index, _ = parse(SPEC.read_text(encoding="utf-8"))
    assert COVERAGE.read_text(encoding="utf-8") == coverage(index), "run: python tests/support_hover_spec.py"


def test_the_testless_list_is_what_the_spec_shows():
    index = json.loads(INDEX.read_text(encoding="utf-8"))
    bare = {c["id"] for c in index["clauses"] if not c["tests"] and not c["browser"]}
    assert bare == set(TESTLESS)


def test_browser_checks_land_in_the_index(tree):
    index, problems = parse(GOOD, tree, frozenset())
    assert problems == []
    one, second = index["clauses"]
    assert one["browser"] == ["first-check"]
    assert second["browser"] == ["other-check", "first-check"]


def test_a_check_in_a_wrapped_paragraph_is_found(tree):
    text = GOOD.replace("harness checks other-check", "harness\nchecks other-check")
    assert parse(text, tree, frozenset())[0]["clauses"][1]["browser"] == ["other-check", "first-check"]


def test_a_trailing_parenthetical_is_allowed(tree):
    text = GOOD.replace("harness check first-check", "harness check first-check (both steps)")
    assert problems_of(text, tree) == []


def test_an_unknown_check_is_a_fault(tree):
    text = GOOD.replace("harness check first-check", "harness check no-such-check")
    assert any("'no-such-check' is not in" in line for line in problems_of(text, tree))


def test_a_check_missing_from_its_clause_is_a_fault(tree):
    text = GOOD.replace("; harness check first-check", "")
    assert any("S-A1: its Test paragraph does not cite harness check first-check" in line for line in problems_of(text, tree))


def test_a_check_may_be_cited_by_another_clause_too(tree):
    assert problems_of(GOOD, tree) == []  # first-check is S-A1's and also cited under S-A2


def test_a_check_with_no_clause_needs_no_citation(tree):
    assert not any("loose-check" in line for line in problems_of(GOOD, tree))


def test_a_clause_with_no_test_is_a_fault(tree):
    text = GOOD.replace("Test: `x.test.ts:4`; harness checks other-check, first-check", "Test: pending (real-browser test)")
    assert any("S-A2 has no test" in line for line in problems_of(text, tree))


def test_a_testless_clause_is_allowed_when_listed(tree):
    text = GOOD.replace("Test: `x.test.ts:4`; harness checks other-check, first-check", "Test: pending (real-browser test)")
    assert not any("has no test" in line for line in problems_of(text, tree, frozenset({"S-A2"})))


def test_a_stale_testless_entry_is_a_fault(tree):
    assert any("S-A2 is in TESTLESS but now has a test" in line for line in problems_of(GOOD, tree, frozenset({"S-A2"})))
    assert any("S-Z9 is in TESTLESS but is not a clause" in line for line in problems_of(GOOD, tree, frozenset({"S-Z9"})))


def test_the_coverage_table_counts(tree):
    index, _ = parse(GOOD, tree, frozenset())
    text = coverage(index)
    assert "2 clauses; 2 with unit tests; 2 with browser checks; 0 pending only; 1 partial" in text
    assert "| S-A1 | One | changes in 0.14.0 | 2 | first-check | real-browser test |" in text


def test_a_missing_harness_table_is_a_fault(tree):
    (tree / "browser" / "harness" / "clauses.mjs").unlink()
    assert any("clauses.mjs not found" in p for p in problems_of(GOOD, tree))


def test_a_harness_table_line_it_cannot_read_is_a_fault(tree):
    table = tree / "browser" / "harness" / "clauses.mjs"
    table.write_text(table.read_text().replace('  "loose-check": "no clause",\n', '  "loose-check": "no clause", "two-check": "S-A2",\n'))
    assert any("cannot read the table line" in p for p in problems_of(GOOD, tree))
    table.write_text("export const CLAUSES = {\n};\n")
    assert any("has no entries" in p for p in problems_of(GOOD, tree))
    table.write_text("export const CLAUSES = { 'first-check': 'S-A1' };\n")
    assert any("no `export const CLAUSES = {` table" in p for p in problems_of(GOOD, tree))


def test_a_check_naming_no_clause_is_a_fault(tree):
    table = tree / "browser" / "harness" / "clauses.mjs"
    table.write_text(table.read_text().replace('"loose-check": "no clause"', '"loose-check": "S-Z9"'))
    assert "harness check 'loose-check' names S-Z9, which is not a clause" in problems_of(GOOD, tree)


@pytest.mark.parametrize(
    "citation",
    ["harness checks other-check and first-check", "Harness check first-check", "harness  check first-check"],
)
def test_a_citation_it_cannot_read_is_a_fault(tree, citation):
    text = GOOD.replace("harness checks other-check, first-check", citation)
    assert any("a harness check citation it cannot read" in p for p in problems_of(text, tree))


def test_a_check_only_the_products_run_is_marked_and_not_counted(tree):
    fixture = tree / "browser" / "fixture-extension"
    fixture.mkdir()
    fixture.joinpath("product.mjs").write_text('export default {\n  unsupported: {\n    "other-check": "why",\n  },\n};\n')
    text = GOOD.replace("Test: `x.test.ts:4`; harness checks other-check, first-check", "Test: harness check other-check")
    index, problems = parse(text, tree, frozenset())
    assert index["productsOnlyChecks"] == ["other-check"]
    assert "S-A2 has no test: add one, or add it to TESTLESS with a reason in the PR" in problems
    assert "| S-A2 | Two | current | 0 | other-check (products only) | - |" in coverage(index)
    assert "1 with browser checks;" in coverage(index)


def test_a_browser_check_alone_is_a_test(tree):
    text = GOOD.replace("Test: `x.test.ts:4`; harness checks other-check, first-check", "Test: harness checks other-check, first-check")
    assert problems_of(text, tree) == []

