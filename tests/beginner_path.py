# SPDX-License-Identifier: Apache-2.0
"""The beginner path, run as the documents write it.

The commands are not copied here: they are read out of the "Paste this into the terminal"
blocks of ``docs/quickstart.md`` and ``browser/README.md`` each time, so that a page and this run
cannot drift apart. The path is the quickstart's steps 1 to 4, the browser runtime's tests and
build (``browser/README.md``, "Run it"), the demo's toy release and the demo server ("The demo
page", steps 1 and 2). The server is started, its page, the toy release document and the toy table are
fetched over HTTP from the address it prints, and it is stopped.

    python3 tests/beginner_path.py                 run the path, from the repository's root
    python3 tests/beginner_path.py --print path    print the script it would run, and stop
    python3 tests/beginner_path.py --print NAME    print one block (--list names them)
    python3 tests/beginner_path.py --while-serving COMMAND
                                                   also run COMMAND with bash while the demo
                                                   server is up; $DEMO_URL holds its address

``.github/workflows/quickstart.yml`` runs it on Linux and in WSL on Windows. It writes where
the documents write: the ``.venv`` and ``browser/`` folders of the checkout and
``$HOME/Downloads/cardvision-toy``. Run it with ``HOME`` set to a scratch folder to keep your
own Downloads folder out of it. POSIX only. Python's standard library only: it runs before the
environment it installs exists.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PASTE = re.compile(r"paste this into the (same )?terminal")
FROM_ROOT = "from the repository's root"


QUICKSTART = "docs/quickstart.md"


@dataclass(frozen=True)
class Block:
    """A "Paste this" block of a document: the first one after ``anchor`` in ``section``.
    ``expect`` is a piece of its text, so that the wrong block is never run unnoticed.
    ``folder`` is where the page says to run it: the repository's root, or a folder in it."""
    name: str
    document: str
    section: str
    anchor: str
    expect: str
    folder: str = ""

    @property
    def where(self) -> str:
        """What the text before the block must say about where it runs."""
        return f"in `{self.folder}/`" if self.folder else FROM_ROOT


PATH = (
    Block("install", QUICKSTART, "# Quickstart on a toy game", "**1. Install.**", "python3 -m venv .venv"),
    Block("toy", QUICKSTART, "# Quickstart on a toy game", "**2. Run the toy quickstart.**", "examples/toy_quickstart.py"),
    Block("bank", QUICKSTART, "# Quickstart on a toy game", "**3. Build a bank**", "cardvision build-bank"),
    Block("infer", QUICKSTART, "# Quickstart on a toy game", "**4. Detect and name the cards**", "cardvision infer"),
    Block("browser-build", "browser/README.md", "## Run it", "Paste this into the terminal, in `browser/`", "npm run build",
          folder="browser"),
    Block("demo-release", "browser/README.md", "## The demo page", "**1. Write the toy release.**",
          "tests/test_browser_fixtures.py --demo"),
    Block("demo-server", "browser/README.md", "## The demo page", "**2. Start the demo on the toy table.**", "npm run demo"),
)
# Not part of the path: what the quickstart asks a Windows reader to run in Ubuntu first.
WINDOWS = (
    Block("windows-packages", QUICKSTART, "# Quickstart on a toy game", "**Which computer?**", "python3-venv"),
    Block("windows-node", QUICKSTART, "# Quickstart on a toy game", "Then close Ubuntu, open it again", "nvm install"),
)
# Not part of the path either: how the quickstart gets the code. The run starts in a checkout that
# exists already, so the block is only found and checked, never run (it needs the network).
ACQUIRE = (
    Block("get-code", QUICKSTART, "# Quickstart on a toy game", "**0. Get the code.**",
          "git clone https://github.com/ryangswe/riftsight-vision.git"),
)
BLOCKS = {block.name: block for block in (*PATH, *WINDOWS, *ACQUIRE)}

# Lines the documents show under "You should see something like" that a run must print too.
# Each is checked in its document as well (tests/test_beginner_path.py), so neither can change
# alone.
MARKERS = (
    (QUICKSTART, "cardvision 0.9.0rc1"),
    (QUICKSTART, "1 frame, 6 faces, 3 named"),
    (QUICKSTART, "(20 rows of 128 values; 20 embedded, 0 kept from the base bank)"),
    (QUICKSTART, "cardvision infer: 1 frame(s), 6 face(s), 1 back(s), 5 named"),
    ("browser/README.md", "the cards on the table: Amber Circle, Coral Triangle, Azure Circle, Slate Stripes, "
                          "Amber Stripes, and a card back"),
    ("browser/README.md", "demo: http://127.0.0.1:8765/"),
)
SERVER_STARTS = 300   # seconds for the demo's build and the server's first lines


class Problem(Exception):
    pass


def fenced_blocks(text: str) -> list[tuple[str, str]]:
    """``(the text before it since the last block, the block)`` for every fenced block."""
    found, before, block, inside = [], [], [], False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            if inside:
                found.append(("\n".join(before), "\n".join(block)))
                before, block = [], []
            inside = not inside
        elif inside:
            block.append(line)
        else:
            before.append(line)
    return found


def section_of(text: str, heading: str) -> str:
    level = heading.split(" ", 1)[0]
    start = text.find("\n" + heading + "\n")
    if start < 0:
        raise Problem(f"no section {heading!r}")
    rest = text[start + len(heading) + 2:]
    end = re.search(rf"^{re.escape(level)} ", rest, re.MULTILINE)
    return rest[:end.start()] if end else rest


def flat(text: str) -> str:
    return " ".join(text.split()).lower()


def read_block(block: Block, root: Path = ROOT) -> str:
    """The commands of a block, as the page has them. The text before it must say to paste it,
    and, for the path, from the repository's root."""
    section = section_of((root / block.document).read_text(encoding="utf-8"), block.section)
    at = section.find(block.anchor)
    if at < 0:
        raise Problem(f"{block.document}: no {block.anchor!r} in {block.section!r}")
    for before, commands in fenced_blocks(section[at:]):
        if PASTE.search(flat(before)):
            if block in PATH and block.where not in flat(before):
                raise Problem(f"{block.document}, {block.anchor!r}: the block no longer says it runs {block.where}")
            if block.expect not in commands:
                raise Problem(f"{block.document}, {block.anchor!r}: the block no longer holds {block.expect!r}")
            return commands.strip() + "\n"
    raise Problem(f"{block.document}: no 'Paste this' block after {block.anchor!r}")


def path_script(root: Path, state: Path) -> tuple[str, str]:
    """The script of the path up to the demo server, and the server's own command (the last
    line of its block). Every block starts where its page says, the repository's root or a
    folder in it; what a block sets (the Python environment, ``WORK``) carries on to the next,
    as in one terminal.
    The script ends by writing what the server's command needs into ``state``."""
    parts = ["set -e", f"BEGINNER_ROOT={shlex.quote(str(root))}"]
    server = ""
    for block in PATH:
        commands = read_block(block, root)
        if block.name == "demo-server":
            *commands_before, server = commands.rstrip("\n").split("\n")
            commands = "\n".join(commands_before) + "\n"
        folder = f'"$BEGINNER_ROOT/{block.folder}"' if block.folder else '"$BEGINNER_ROOT"'
        parts += [f"\n# ---- {block.name}: {block.document}, {block.anchor}", f"cd {folder}", commands.rstrip("\n")]
    parts += ["", f'{{ printf "%s\\n" "$PWD" "$WORK"; }} > {shlex.quote(str(state))}']
    return "\n".join(parts) + "\n", server


def run_logged(command: list[str], **options) -> str:
    """Run a command, show its output as it comes and return it."""
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, **options)
    lines = []
    for line in process.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        lines.append(line)
    if process.wait() != 0:
        raise Problem(f"{command[0]} ended with exit code {process.returncode}")
    return "".join(lines)


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=30) as answer:      # an address on 127.0.0.1 only
        if answer.status != 200:
            raise Problem(f"{url}: HTTP {answer.status}")
        return answer.read()


def serve_and_check(server: str, cwd: Path, work: Path, while_serving: str | None) -> str:
    """Start the demo server with the page's command, fetch what it serves, run
    ``while_serving``, stop it. Returns its output."""
    lines: list[str] = []
    seen = threading.Event()     # the server named its file, or its output ended
    started = threading.Event()  # the server named its file
    process = subprocess.Popen(["bash", "-c", f"exec {server}"], cwd=cwd, env={**os.environ, "WORK": str(work)},
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    group = process.pid          # its own session: the group holds npm and the server it starts

    def read() -> None:
        for line in process.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            lines.append(line)
            if line.startswith("open the file in the demo: "):
                started.set()
                seen.set()
        seen.set()

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        # Output that ended before the server named its file is a failure, whether or not the
        # process has been reaped yet: the end of its output can come before poll() sees it exit.
        if not seen.wait(SERVER_STARTS) or not started.is_set() or process.poll() is not None:
            raise Problem("the demo server did not start: " + ("".join(lines[-5:]).strip() or "no output"))
        address = next(line.split(": ", 1)[1].strip() for line in lines if line.startswith("demo: "))
        page = fetch(address).decode("utf-8")
        if "<html" not in page.lower():
            raise Problem(f"{address}: not a page")
        served = fetch(address + "release/release.json")
        on_disk = (work / "demo" / "release" / "release.json").read_bytes()
        if served != on_disk or not json.loads(served):
            raise Problem(f"{address}release/release.json is not the toy release document")
        table = next(line.split(": ", 1)[1].strip() for line in lines if line.startswith("open the file in the demo: "))
        if fetch(address + "file/table.png") != (work / "demo" / "table.png").read_bytes():
            raise Problem(f"{address}file/table.png is not the toy table")
        print(f"beginner path: {address} serves the page, the toy release ({len(served)} bytes) and the table; {table}", flush=True)
        if while_serving:
            done = subprocess.run(["bash", "-c", while_serving], env={**os.environ, "DEMO_URL": address})
            if done.returncode != 0:
                raise Problem(f"--while-serving ended with exit code {done.returncode}")
    finally:
        if process.poll() is None:
            os.killpg(group, signal.SIGTERM)
            try:
                process.wait(10)
            except subprocess.TimeoutExpired:
                os.killpg(group, signal.SIGKILL)
                process.wait()
        reader.join(5)
    return "".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--print", dest="show", metavar="NAME", help="print the path's script ('path') or one block")
    parser.add_argument("--list", action="store_true", help="name the blocks")
    parser.add_argument("--while-serving", metavar="COMMAND", help="run this with bash while the demo server is up")
    options = parser.parse_args(argv)
    try:
        if options.list:
            for block in (*PATH, *WINDOWS, *ACQUIRE):
                print(f"{block.name:17} {block.document}, {block.anchor}")
            return 0
        if options.show:
            if options.show == "path":
                script, server = path_script(ROOT, Path("STATE"))
                sys.stdout.write(script + f"\n# then, in the folder it ends in, in the background:\n{server}\n")
            elif options.show in BLOCKS:
                sys.stdout.write(read_block(BLOCKS[options.show]))
            else:
                parser.error(f"--print {options.show}: not 'path' or a block's name (see --list)")
            return 0
        with tempfile.TemporaryDirectory(prefix="beginner-path-") as scratch:
            state = Path(scratch) / "state"
            script, server = path_script(ROOT, state)
            output = run_logged(["bash", "-c", script], cwd=ROOT)
            folder, work = state.read_text(encoding="utf-8").splitlines()
        output += serve_and_check(server, Path(folder), Path(work), options.while_serving)
        missing = [line for _, line in MARKERS if line not in output]
        if missing:
            raise Problem("the run did not print what the pages show: " + "; ".join(missing))
        print(f"beginner path: every step ran as written, and printed the {len(MARKERS)} lines checked")
        return 0
    except Problem as problem:
        print(f"beginner path: FAILED: {problem}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
