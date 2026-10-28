# SPDX-License-Identifier: Apache-2.0
"""``tests/beginner_path.py`` finds the documents' blocks, refuses a page that moved under it,
and starts, checks and stops a demo server. The whole path, which installs packages from the
network, is run by ``.github/workflows/quickstart.yml``, not here."""

from __future__ import annotations

import json
import shlex
import shutil
import sys
from pathlib import Path

import pytest

import beginner_path
from beginner_path import ACQUIRE, BLOCKS, MARKERS, PATH, QUICKSTART as QUICKSTART_DOC, WINDOWS, Problem, fenced_blocks, flat, path_script, read_block

ROOT = Path(__file__).resolve().parents[1]


def test_every_block_is_found_where_the_pages_have_it():
    commands = {block.name: read_block(block) for block in (*PATH, *WINDOWS)}
    assert list(commands) == ["install", "toy", "bank", "infer", "browser-build", "demo-release", "demo-server",
                              "windows-packages", "windows-node"]
    assert commands["install"].startswith("python3 -m venv .venv\n. .venv/bin/activate\n")
    assert commands["infer"].startswith('cardvision infer "$WORK/toy/table.png" \\\n')
    assert commands["browser-build"] == "npm ci\nnpm test\nnpm run build\n"
    assert BLOCKS["browser-build"].document == "browser/README.md" and BLOCKS["browser-build"].folder == "browser"
    assert commands["demo-server"].splitlines()[-1].startswith('npm run demo -- --release "$WORK/demo/release"')
    assert commands["windows-node"] == "nvm install 24\n"


def test_the_quickstart_says_how_to_get_the_code_and_the_path_does_not_run_it():
    """Step 0 clones the public repository and moves into it; the path starts in a checkout
    that exists already, so the block is checked, never run."""
    (block,) = ACQUIRE
    assert read_block(block) == "git clone https://github.com/ryangswe/riftsight-vision.git\ncd riftsight-vision\n"
    quickstart = (ROOT / "docs" / "quickstart.md").read_text(encoding="utf-8")
    assert quickstart.index("**0. Get the code.**") < quickstart.index("**1. Install.**")
    assert "Download ZIP" in quickstart
    script, server = path_script(ROOT, Path("STATE"))
    assert "git clone" not in script and "git clone" not in server


def readme_quickstart(root: Path = ROOT) -> list[str]:
    """The command lines of the README's short quickstart: its "Paste this" block."""
    section = beginner_path.section_of((root / "README.md").read_text(encoding="utf-8"), "## Quickstart")
    blocks = [block for before, block in fenced_blocks(section) if beginner_path.PASTE.search(flat(before))]
    assert len(blocks) == 1
    return [line for line in blocks[0].splitlines() if line.strip()]


def in_order(lines: list[str], within: list[str]) -> bool:
    rest = iter(within)
    return all(line in rest for line in lines)


def test_the_readme_quickstart_is_the_full_quickstart_s_commands_in_order():
    """The README's short quickstart repeats steps 0 to 2 of docs/quickstart.md. Each of its
    lines is a line of the get-code, install and toy blocks there, in the same order, so the
    two copies cannot drift apart; and the line it says to expect is shown there too."""
    full = [line for name in ("get-code", "install", "toy") for line in read_block(BLOCKS[name]).splitlines()]
    short = readme_quickstart()
    assert short[:2] == ["git clone https://github.com/ryangswe/riftsight-vision.git", "cd riftsight-vision"]
    assert "python examples/toy_quickstart.py \"$WORK/toy\"" in short
    assert in_order(short, full), [line for line in short if line not in full]
    assert not in_order(list(reversed(short)), full)
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "`1 frame, 6 faces, 3 named`" in readme and (QUICKSTART_DOC, "1 frame, 6 faces, 3 named") in MARKERS


def test_a_readme_quickstart_that_drifted_is_refused(tmp_path):
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    drifted = text.replace("python -m pip install --no-deps -e .", "python -m pip install -e .", 1)
    assert drifted != text
    (tmp_path / "README.md").write_text(drifted, encoding="utf-8")
    full = [line for name in ("get-code", "install", "toy") for line in read_block(BLOCKS[name]).splitlines()]
    assert not in_order(readme_quickstart(tmp_path), full)


def test_the_path_script_runs_every_block_from_the_root_and_leaves_the_server_for_last(tmp_path):
    script, server = path_script(ROOT, tmp_path / "state")
    assert script.startswith("set -e\n")
    for block in PATH:
        assert f"# ---- {block.name}: " in script
    assert script.count('cd "$BEGINNER_ROOT') == len(PATH)
    # The browser's tests and build run in browser/, as browser/README.md says; every other block
    # from the root.
    assert script.count('cd "$BEGINNER_ROOT/browser"') == 1
    assert script.count('cd "$BEGINNER_ROOT"') == len(PATH) - 1
    assert server.startswith("npm run demo -- ") and server not in script
    # The quickstart's blocks for Windows are not part of the path.
    without_root = script.replace(str(ROOT), "")
    assert "nvm " not in without_root and "apt " not in without_root


def test_every_line_checked_in_a_run_is_shown_in_its_page():
    """The lines a run must print are in a "You should see" block of their page."""
    for document, line in MARKERS:
        shown = [block for before, block in fenced_blocks((ROOT / document).read_text(encoding="utf-8"))
                 if "you should see" in flat(before)]
        assert any(line in block for block in shown), (document, line)


@pytest.mark.parametrize(("change", "message"), [
    (("From the repository's root (if you are in", "From your home folder (if you are in"), "no longer says it runs"),
    (("python tests/test_browser_fixtures.py --demo", "python tests/other.py --demo"), "no longer holds"),
    (("**1. Write the toy release.**", "**1. The toy release.**"), "no '**1. Write the toy release.**'"),
])
def test_a_page_that_moved_under_it_is_refused(tmp_path, change, message):
    (tmp_path / "browser").mkdir()
    text = (ROOT / "browser" / "README.md").read_text(encoding="utf-8")
    assert change[0] in text
    (tmp_path / "browser" / "README.md").write_text(text.replace(change[0], change[1], 1), encoding="utf-8")
    with pytest.raises(Problem, match=message.replace("*", r"\*")):
        read_block(BLOCKS["demo-release"], tmp_path)


FAKE_SERVER = """
import functools, http.server, sys
site = sys.argv[1]
handler = functools.partial(type("Quiet", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}),
                            directory=site)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
address = f"http://127.0.0.1:{server.server_address[1]}/"
print(f"demo: {address}", flush=True)
print(f"open the file in the demo: {address}?file=/file/table.png", flush=True)
server.serve_forever()
"""


@pytest.fixture()
def demo(tmp_path):
    """A work folder with a toy release and table, and a stand-in for the demo server that
    serves ``site`` and prints the lines the real one does."""
    if shutil.which("bash") is None:
        pytest.skip("the server's command is run with bash")
    work, site = tmp_path / "work", tmp_path / "site"
    for folder in (work / "demo" / "release", site / "release", site / "file"):
        folder.mkdir(parents=True)
    release, table = json.dumps({"schema": "toy"}).encode(), b"\x89PNG not really"
    for path, data in ((work / "demo" / "release" / "release.json", release), (site / "release" / "release.json", release),
                       (work / "demo" / "table.png", table), (site / "file" / "table.png", table),
                       (site / "index.html", b"<!doctype html><html><title>demo</title></html>")):
        path.write_bytes(data)
    (tmp_path / "server.py").write_text(FAKE_SERVER, encoding="utf-8")
    command = f"{shlex.quote(sys.executable)} {shlex.quote(str(tmp_path / 'server.py'))} {shlex.quote(str(site))}"
    return command, work, site


def test_the_server_is_started_checked_and_stopped(demo, tmp_path, capsys):
    command, work, _ = demo
    marker = tmp_path / "while-serving"
    output = beginner_path.serve_and_check(command, tmp_path, work, f'printf "%s" "$DEMO_URL" > {shlex.quote(str(marker))}')
    address = marker.read_text(encoding="utf-8")
    assert output.startswith(f"demo: {address}\n")
    assert "serves the page, the toy release (17 bytes) and the table" in capsys.readouterr().out
    with pytest.raises(OSError):            # stopped
        beginner_path.fetch(address)


def test_a_server_that_serves_another_release_or_fails_a_check_is_a_failure(demo, tmp_path):
    command, work, site = demo
    with pytest.raises(Problem, match="--while-serving ended with exit code 3"):
        beginner_path.serve_and_check(command, tmp_path, work, "exit 3")
    (site / "release" / "release.json").write_text('{"schema": "other"}', encoding="utf-8")
    with pytest.raises(Problem, match="is not the toy release document"):
        beginner_path.serve_and_check(command, tmp_path, work, None)


def test_a_server_that_does_not_start_is_a_failure(tmp_path, monkeypatch):
    if shutil.which("bash") is None:
        pytest.skip("the server's command is run with bash")
    monkeypatch.setattr(beginner_path, "SERVER_STARTS", 20)
    with pytest.raises(Problem, match="did not start: port in use"):
        beginner_path.serve_and_check("echo port in use; exit 1", tmp_path, tmp_path, None)


def test_a_browser_block_that_no_longer_says_it_runs_in_browser_is_refused(tmp_path):
    (tmp_path / "browser").mkdir()
    text = (ROOT / "browser" / "README.md").read_text(encoding="utf-8")
    anchor = "Paste this into the terminal, in `browser/`"
    assert anchor in text
    (tmp_path / "browser" / "README.md").write_text(text.replace(anchor, "Paste this into the terminal", 1), encoding="utf-8")
    with pytest.raises(Problem, match="no 'Paste this into the terminal, in `browser/`'"):
        read_block(BLOCKS["browser-build"], tmp_path)
