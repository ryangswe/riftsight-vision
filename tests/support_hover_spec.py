# SPDX-License-Identifier: Apache-2.0
"""Turns docs/hover-spec.md into docs/hover-spec.json, and checks the Markdown on the way.

    python tests/support_hover_spec.py            write docs/hover-spec.json and docs/hover-coverage.md
    python tests/support_hover_spec.py --check    fail when either committed file is out of date

Each clause is a ``### S-<group><n> — <title>`` heading under its ``## <group>. <title>`` section.
The index holds the clause id, group, title, status and test references. A clause is checked for:
a well-formed and unique id, a group that matches its section, a ``Status:`` line that is one of
the known marks, a ``Test:`` paragraph whose every reference is ``file:line`` and whose line is an
``it(`` / ``it.each(`` line (TypeScript) or a ``def test_`` line (Python), or a ``pending (...)``
mark, and every ``S-`` id the text mentions naming a clause. A ``harness check <name>`` (or
``harness checks <a>, <b>``) in a Test paragraph names a check of the hover browser test, read
from browser/harness/clauses.mjs; every check there that names a clause must be cited by that
clause. A clause with no unit test and no browser check must be in TESTLESS. The script also
writes docs/hover-coverage.md, one row per clause. Nothing here reads the network.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs" / "hover-spec.md"
INDEX = ROOT / "docs" / "hover-spec.json"
COVERAGE = ROOT / "docs" / "hover-coverage.md"
BROWSER_TESTS = ROOT / "browser" / "test"
CHECKS_FILE = Path("browser") / "harness" / "clauses.mjs"
# The toolkit's own run of the hover browser test (CI) uses this product module; a check it lists as
# unsupported runs only in the products, so it is not counted as the toolkit's test of a clause.
FIXTURE_FILE = Path("browser") / "fixture-extension" / "product.mjs"

# Clauses with no unit test and no browser check today. The list only shrinks: a new clause needs a
# test, and a clause that gets one leaves the list.
TESTLESS = frozenset({"S-B12"})

STATUSES = ("changes in 0.14.0", "changes in a product release", "open decision")
CHANGES = STATUSES[:2]
PENDING_KINDS = ("slow-clock test", "real-browser test", "vendoring check")

GROUP = re.compile(r"^## ([A-Z])\. (.+?)\s*$")
CLAUSE_HEAD = re.compile(r"^### (S-.*)$")
CLAUSE = re.compile(r"^### (S-([A-CFGHPWX])([1-9][0-9]*)) — (\S.*?)\s*$")
ID_MENTION = re.compile(r"\bS-[A-Z][0-9]+\b")
FILE_TOKEN = re.compile(r"^[A-Za-z0-9_./-]+\.(?:test\.ts|py)(?::.*)?$")
REF = re.compile(r"^([A-Za-z0-9_./-]+\.(?:test\.ts|py)):([1-9][0-9]*)$")
CHECK_ENTRY = re.compile(r'^\s*"([a-z0-9-]+)":\s*"([^"]+)",?\s*$')
CHECKS_BLOCK = re.compile(r"^export const CLAUSES = \{\n(.*?)^\};", re.MULTILINE | re.DOTALL)
UNSUPPORTED_BLOCK = re.compile(r"^[ \t]*unsupported: \{\n(.*?)^[ \t]*\},", re.MULTILINE | re.DOTALL)
UNSUPPORTED_ENTRY = re.compile(r'^[ \t]*"([a-z0-9-]+)": ".*",?[ \t]*$')
HARNESS_WORD = re.compile(r"harness", re.IGNORECASE)
CHECK_CITE = re.compile(r"harness checks? ([a-z][a-z0-9-]*(?:,\s*[a-z][a-z0-9-]*)*)")
PENDING = re.compile(r"pending \(([^)]*)\)")
TS_TEST_LINE = re.compile(r"^\s*it(?:\.each\b|\.fails\b|\()")
TS_TARGET_LINE = re.compile(r"^\s*it\.fails\b")
PY_TEST_LINE = re.compile(r"^\s*(?:async\s+)?def test_")


def test_file(name: str, root: Path = ROOT) -> Path:
    """A bare file name is a browser test; a name with a folder is relative to the repository."""
    return (root / "browser" / "test" / name) if "/" not in name else root / name


def resolve(name: str, line: int, root: Path = ROOT) -> str | None:
    """None when ``name:line`` is a test line; else what is wrong with it."""
    path = test_file(name, root)
    if not path.is_file():
        return f"{name}:{line} -> no such file"
    lines = path.read_text(encoding="utf-8").splitlines()
    if line > len(lines):
        return f"{name}:{line} -> the file has {len(lines)} lines"
    pattern = PY_TEST_LINE if name.endswith(".py") else TS_TEST_LINE
    if not pattern.match(lines[line - 1]):
        return f"{name}:{line} -> not an it( / it.each( / def test_ line: {lines[line - 1].strip()[:60]!r}"
    return None


def is_target(name: str, line: int, root: Path = ROOT) -> bool:
    """True when the line is an ``it.fails(`` test: it pins the behavior a clause is changing to."""
    lines = test_file(name, root).read_text(encoding="utf-8").splitlines()
    return bool(TS_TARGET_LINE.match(lines[line - 1]))


def paragraphs(body: list[str]) -> list[str]:
    out, cur = [], []
    for line in body:
        if line.strip():
            cur.append(line)
        elif cur:
            out.append(" ".join(part.strip() for part in cur))
            cur = []
    if cur:
        out.append(" ".join(part.strip() for part in cur))
    return out


def read_checks(root: Path = ROOT) -> tuple[dict[str, str], list[str]]:
    """Check name -> clause id (or "no clause") from the harness table, and the problems reading it:
    every line of the table must be one ``"name": "clause",`` entry, so a new layout fails loudly."""
    path = root / CHECKS_FILE
    if not path.is_file():
        return {}, [f"{CHECKS_FILE} not found: browser checks cannot be checked"]
    block = CHECKS_BLOCK.search(path.read_text(encoding="utf-8"))
    if not block:
        return {}, [f"{CHECKS_FILE}: no `export const CLAUSES = {{` table ending in `}};`"]
    checks: dict[str, str] = {}
    problems: list[str] = []
    for line in block.group(1).splitlines():
        if not line.strip() or line.strip().startswith("//"):
            continue
        m = CHECK_ENTRY.match(line)
        if not m:
            problems.append(f"{CHECKS_FILE}: cannot read the table line {line.strip()!r}")
        else:
            checks[m.group(1)] = m.group(2)
    if not checks:
        problems.append(f"{CHECKS_FILE}: the CLAUSES table has no entries")
    return checks, problems


def products_only(checks: dict[str, str], root: Path = ROOT) -> tuple[list[str], list[str]]:
    """The checks the toolkit's fixture module lists as unsupported, and the problems reading them.
    Without the file there are none; a file that mentions `unsupported` must hold the block in the
    form read here, one ``"check": "reason",`` a line, each a check of the harness table."""
    path = root / FIXTURE_FILE
    if not path.is_file():
        return [], []
    text = path.read_text(encoding="utf-8")
    if "unsupported" not in text:
        return [], []
    block = UNSUPPORTED_BLOCK.search(text)
    if not block:
        return [], [f"{FIXTURE_FILE}: cannot read its `unsupported: {{ ... }},` block"]
    names: list[str] = []
    problems: list[str] = []
    for line in block.group(1).splitlines():
        if not line.strip() or line.strip().startswith("//"):
            continue
        m = UNSUPPORTED_ENTRY.match(line)
        if not m:
            problems.append(f"{FIXTURE_FILE}: cannot read the unsupported line {line.strip()[:60]!r}")
        elif m.group(1) not in checks:
            problems.append(f"{FIXTURE_FILE}: unsupported {m.group(1)!r} is not in {CHECKS_FILE}")
        else:
            names.append(m.group(1))
    return sorted(names), problems


def is_tested(clause: dict, only_in_products: list[str] | set[str]) -> bool:
    """A clause the toolkit tests: a unit test, or a browser check its own CI runs."""
    return bool(clause["tests"]) or any(name not in only_in_products for name in clause["browser"])


def parse(text: str, root: Path = ROOT, testless: frozenset[str] = TESTLESS) -> tuple[dict, list[str]]:
    """The index of ``text`` and the problems found, one line each."""
    problems: list[str] = []
    checks, read_problems = read_checks(root)
    problems.extend(read_problems)
    only_in_products, fixture_problems = products_only(checks, root)
    problems.extend(fixture_problems)
    groups: dict[str, str] = {}
    clauses: list[dict] = []
    seen: set[str] = set()
    group = None
    current: dict | None = None
    in_fence = False

    def finish() -> None:
        if current is not None:
            clauses.append(current)

    lines = text.splitlines()
    heads: list[tuple[int, str | None]] = []  # (line index, group letter or None) per clause head
    for number, line in enumerate(lines):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        if in_fence:
            continue
        m = GROUP.match(line)
        if m:
            group = m.group(1)
            if group in groups:
                problems.append(f"line {number + 1}: group {group} appears twice")
            groups[group] = m.group(2)
            continue
        if not CLAUSE_HEAD.match(line):
            continue
        heads.append((number, group))

    for at, (number, group) in enumerate(heads):
        end = heads[at + 1][0] if at + 1 < len(heads) else len(lines)
        # The body stops at the next heading of any level.
        body = []
        for line in lines[number + 1:end]:
            if line.startswith("## ") or line.startswith("### "):
                break
            body.append(line)
        m = CLAUSE.match(lines[number])
        where = f"line {number + 1}"
        if not m:
            problems.append(f"{where}: malformed clause heading {lines[number]!r}")
            continue
        cid, letter, _, title = m.groups()
        if group is None or letter != group:
            problems.append(f"{where}: {cid} sits under group {group!r}")
        if cid in seen:
            problems.append(f"{where}: duplicate clause id {cid}")
        seen.add(cid)
        paras = paragraphs(body)
        status = "current"
        marks = [p for p in paras if p.startswith("Status:")]
        if len(marks) > 1:
            problems.append(f"{cid}: more than one Status line")
        if marks:
            value = marks[0][len("Status:"):].strip()
            known = next((s for s in STATUSES if value in (s, s + ".")), None)
            if known is None:
                problems.append(f"{cid}: unknown status, or words after it: {value!r}")
            else:
                status = known
        if status in CHANGES and not any(p.startswith("Today:") for p in paras):
            problems.append(f"{cid}: a clause marked {status!r} needs a Today paragraph")
        for para in paras:
            if para.startswith("Test:"):
                continue
            for token in re.findall(r"`([^`]*)`", para):
                if FILE_TOKEN.match(token):
                    ref = REF.match(token)
                    if not ref:
                        problems.append(f"{cid}: malformed test reference `{token}`")
                    else:
                        bad = resolve(ref.group(1), int(ref.group(2)), root)
                        if bad:
                            problems.append(f"{cid}: test reference {bad}")
        tests: list[dict] = []
        pending: list[str] = []
        browser: list[str] = []
        test_paras = [p for p in paras if p.startswith("Test:")]
        if len(test_paras) != 1:
            problems.append(f"{cid}: needs exactly one Test paragraph, found {len(test_paras)}")
        for para in test_paras:
            content = para[len("Test:"):]
            for token in re.findall(r"`([^`]*)`", content):
                ref = REF.match(token)
                if not ref:
                    problems.append(f"{cid}: malformed test reference `{token}`")
                    continue
                name, line_no = ref.group(1), int(ref.group(2))
                bad = resolve(name, line_no, root)
                if bad:
                    problems.append(f"{cid}: test reference {bad}")
                target = bad is None and is_target(name, line_no, root)
                if target and status not in CHANGES:
                    problems.append(f"{cid}: `{token}` is an it.fails test, which pins a change, in a clause that is not changing")
                if target and "target" not in content:
                    problems.append(f"{cid}: `{token}` pins the target and the Test paragraph does not say \"target\"")
                tests.append({"file": name, "line": line_no, "target": target})
            for group_of_names in CHECK_CITE.findall(content):
                for name in re.split(r",\s*", group_of_names):
                    if name not in checks:
                        problems.append(f"{cid}: harness check {name!r} is not in {CHECKS_FILE}")
                    if name not in browser:
                        browser.append(name)
            # Every mention of the harness must be a citation it read: a list joined by "and", a
            # capital letter or a double space would otherwise drop a check silently.
            rest = CHECK_CITE.sub("", re.sub(r"`[^`]*`", "", content))
            if HARNESS_WORD.search(rest) or re.search(r"harness checks? [a-z][a-z0-9-]*(?:,\s*[a-z][a-z0-9-]*)*\s+and\b", content):
                problems.append(f"{cid}: a harness check citation it cannot read: write `harness check <name>` or `harness checks <a>, <b>`")
            for kind in PENDING.findall(content):
                if kind not in PENDING_KINDS:
                    problems.append(f"{cid}: unknown pending kind {kind!r}")
                pending.append(kind)
            if not tests and not pending and not browser:
                problems.append(f"{cid}: the Test paragraph has no reference and no pending mark")
        clauses.append({"id": cid, "group": letter, "title": title, "status": status, "tests": tests, "browser": browser, "pending": pending})

    ids = {c["id"] for c in clauses}
    by_id = {c["id"]: c for c in clauses}
    for name, clause in checks.items():
        if clause == "no clause":
            continue
        if clause not in ids:
            problems.append(f"harness check {name!r} names {clause}, which is not a clause")
        elif name not in by_id[clause]["browser"]:
            problems.append(f"{clause}: its Test paragraph does not cite harness check {name}")
    for c in clauses:
        if not is_tested(c, only_in_products) and c["id"] not in testless:
            problems.append(f"{c['id']} has no test: add one, or add it to TESTLESS with a reason in the PR")
    for cid in sorted(testless):
        if cid not in ids:
            problems.append(f"{cid} is in TESTLESS but is not a clause: remove it from TESTLESS")
        elif is_tested(by_id[cid], only_in_products):
            problems.append(f"{cid} is in TESTLESS but now has a test: remove it from TESTLESS")
    for mention in sorted(set(ID_MENTION.findall(text)) - ids):
        problems.append(f"{mention} is mentioned but no clause has that id")
    if not clauses:
        problems.append("no clauses found")
    index = {"source": "docs/hover-spec.md", "groups": groups, "clauses": clauses, "productsOnlyChecks": only_in_products}
    return index, problems


def render(index: dict) -> str:
    return json.dumps(index, indent=2, ensure_ascii=False) + "\n"


def coverage(index: dict) -> str:
    rows = index["clauses"]
    only = set(index.get("productsOnlyChecks", []))
    has_test = [c for c in rows if c["tests"]]
    has_browser = [c for c in rows if any(name not in only for name in c["browser"])]
    pending_only = [c for c in rows if c["pending"] and not is_tested(c, only)]
    partial = [c for c in rows if c["pending"] and is_tested(c, only)]
    lines = [
        "<!-- SPDX-License-Identifier: Apache-2.0 -->",
        "",
        "# Hover spec coverage",
        "",
        "Generated from [hover-spec.md](hover-spec.md) by `python tests/support_hover_spec.py`, which",
        "also writes `hover-spec.json`. Do not edit it by hand; `--check` fails when it is out of date.",
        "",
        "- **Status**: the clause's mark in the spec (`current` when it has none).",
        "- **Unit tests**: how many `file:line` tests the clause's Test paragraph lists.",
        "- **Browser checks**: the hover browser test checks it cites (`harness check <name>`). A check",
        "  marked \"products only\" is unsupported by the toolkit's own fixture, so only the products' runs",
        "  test it; it is not counted below.",
        "- **Pending**: the parts a test does not check yet, as the spec marks them.",
        "- **Pending only**: a pending mark, and no unit test or browser check.",
        "- **Partial**: a unit test or browser check, and a pending mark beside it. The spec marks what",
        "  the tests leave; the count is of marks, not a measured gap.",
        "",
        "The counts overlap: a clause with unit tests and browser checks is in both.",
        "",
        f"{len(rows)} clauses; {len(has_test)} with unit tests; {len(has_browser)} with browser checks; "
        f"{len(pending_only)} pending only; {len(partial)} partial.",
        "",
        "| Clause | Title | Status | Unit tests | Browser checks | Pending |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for c in rows:
        lines.append(
            f"| {c['id']} | {c['title'].replace('|', '/')} | {c['status']} | {len(c['tests'])} | "
            f"{', '.join(n + (' (products only)' if n in only else '') for n in c['browser']) or '-'} | {'; '.join(c['pending']) or '-'} |"
        )
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    index, problems = parse(SPEC.read_text(encoding="utf-8"))
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    outputs = [(INDEX, render(index)), (COVERAGE, coverage(index))]
    if "--check" in argv:
        stale = [p for p, out in outputs if not p.is_file() or p.read_text(encoding="utf-8") != out]
        for p in stale:
            print(f"docs/{p.name} is out of date: run python tests/support_hover_spec.py", file=sys.stderr)
        return 1 if stale else 0
    for p, out in outputs:
        p.write_text(out, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
