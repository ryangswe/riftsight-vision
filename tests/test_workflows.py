# SPDX-License-Identifier: Apache-2.0
"""The commands the workflows under ``.github/workflows/`` run are run here, as written.

A workflow file is only tried when it is pushed, and a wrong command in one is found late. So
the steps that need no network are read out of the workflow files and run with ``bash``, on the
files of this repository:

* ``manifests.yml``: the steps a push runs must pass on the published ``data/`` folder, and the
  step a pull request adds must accept offered rows and refuse rows that claim a check;
* ``no-binaries.yml``: its check must pass on the tracked files and refuse a picture;
* ``dco.yml``: its check must tell a signed-off commit from one that is not;
* ``pages.yml``: the browser tests come before the build, the toy game's step and the build step
  write the hosted demo with its game picker, and the deploy job runs only when the
  repository's Pages deploy from GitHub Actions.
* ``publish.yml``: it runs only by hand, never on a published release, and uploads to the real
  package index only when asked for that target on a tag;
* ``quickstart.yml``: it runs ``tests/beginner_path.py``, which reads the beginner path out of
  the documents, on Linux and in Ubuntu under WSL 2, with an action that is not GitHub's own
  pinned to a full commit.

The steps are found by a small reader of the workflows' own layout, not by a YAML library. A
test fails when a step it expects is no longer found, so a rewritten workflow cannot leave
these tests checking nothing.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from support_data import row_doc, write_lines

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
STEP_INDENT = "      - "

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="the workflows' steps are bash scripts")


def steps_of(workflow: str) -> dict[str, dict[str, str]]:
    """The named steps of a workflow file that run a script: ``{name: {"run": script, "if":
    condition or ""}}``. A step starts at a line ``      - ``; ``run:`` is one line, or a block
    after ``run: |`` that ends where the indentation does."""
    lines = (WORKFLOWS / workflow).read_text(encoding="utf-8").splitlines()
    chunks: list[list[str]] = []
    for line in lines:
        if line.startswith(STEP_INDENT):
            chunks.append([line[len(STEP_INDENT):]])
        elif chunks and (line.startswith(" " * len(STEP_INDENT)) or not line.strip()):
            chunks[-1].append(line[len(STEP_INDENT):])
        elif chunks and line.strip():
            chunks.append([])      # a line outside any step ends the last one; nothing is added to this chunk
    steps: dict[str, dict[str, str]] = {}
    for chunk in chunks:
        fields = {"name": "", "if": "", "run": ""}
        for at, line in enumerate(chunk):
            for key in ("name", "if"):
                if line.startswith(f"{key}: "):
                    fields[key] = line[len(key) + 2:].strip()
            if line.startswith("run: |"):
                block = []
                for following in chunk[at + 1:]:
                    if following.strip() and not following.startswith("  "):
                        break
                    block.append(following)
                fields["run"] = textwrap.dedent("\n".join(block)).strip() + "\n"
            elif line.startswith("run: "):
                fields["run"] = line[5:].strip() + "\n"
        if fields["name"] and fields["run"]:
            steps[fields["name"]] = {"run": fields["run"], "if": fields["if"]}
    return steps


@pytest.fixture()
def tools(tmp_path) -> dict[str, str]:
    """An environment in which ``cardvision`` and ``python3`` are this interpreter's: the
    package under test, not whatever else is installed."""
    folder = tmp_path / "tools"
    folder.mkdir()
    for name, call in (("cardvision", f'exec "{sys.executable}" -m cardvision "$@"'), ("python3", f'exec "{sys.executable}" "$@"')):
        (folder / name).write_text(f"#!/bin/sh\n{call}\n", encoding="utf-8")
        (folder / name).chmod(0o755)
    environment = {key: value for key, value in os.environ.items() if key not in ("BASE", "HEAD")}
    environment["PATH"] = f"{folder}{os.pathsep}{environment.get('PATH', '')}"
    return environment


def run_step(script: str, cwd: Path, environment: dict[str, str]) -> subprocess.CompletedProcess:
    """Run a step's script as the workflow runner does when a step names no shell: with
    ``bash -e``, which stops at the first command that fails."""
    return subprocess.run(["bash", "-e", "-c", script], cwd=cwd, env=environment, capture_output=True, text=True, timeout=300)


# ------------------------------------------------------------------------------ manifests.yml
PUSH_STEPS = ("Every manifest, together", "The example, against the template catalog",
              "The Riftbound manifests, against the Riftbound catalog")
OFFER_STEP = "Rows added or changed by this pull request are offers"


def test_the_manifest_workflow_has_the_steps_these_tests_run():
    steps = steps_of("manifests.yml")
    assert [name for name in steps if "cardvision validate-manifest" in steps[name]["run"]] == [*PUSH_STEPS, OFFER_STEP]
    # The three steps of a push have no condition; the fourth runs for pull requests only.
    assert [steps[name]["if"] for name in PUSH_STEPS] == ["", "", ""]
    assert "github.event_name == 'pull_request'" in steps[OFFER_STEP]["if"]
    assert steps[PUSH_STEPS[0]]["run"] == "cardvision validate-manifest data --sources games/riftbound/sources.json\n"
    assert steps["Install"]["run"].splitlines() == ["python -m pip install -r requirements-lock.txt",
                                                    "python -m pip install --no-deps -e ."]


@pytest.mark.parametrize("name", PUSH_STEPS)
def test_each_validation_step_of_a_push_passes_on_the_published_data(name, tools):
    """The same invocation the workflow makes, on the tracked ``data/`` folder."""
    done = run_step(steps_of("manifests.yml")[name]["run"], ROOT, tools)
    assert done.returncode == 0, done.stdout + done.stderr
    assert done.stdout.startswith("valid: ") and "card ids" in done.stdout


def test_the_validation_steps_cover_every_published_manifest(tools):
    published = sorted(path.name for path in (ROOT / "data").glob("*.manifest.jsonl"))
    assert "example.manifest.jsonl" in published and len(published) >= 2
    steps = steps_of("manifests.yml")
    together = run_step(steps[PUSH_STEPS[0]]["run"], ROOT, tools).stdout
    assert f"in {len(published)} file(s)" in together
    riftbound = run_step(steps[PUSH_STEPS[2]]["run"], ROOT, tools).stdout
    assert f"in {len(published) - 1} file(s); card ids checked against the catalog" in riftbound


def test_a_validation_step_fails_when_a_manifest_is_wrong(tools, tmp_path):
    """The steps are live checks: on a copy of the repository's files with one bad row, the
    first step fails and names the row."""
    copy = tmp_path / "copy"
    shutil.copytree(ROOT / "data", copy / "data")
    shutil.copytree(ROOT / "games", copy / "games")
    target = copy / "data" / "example.manifest.jsonl"
    target.write_text(target.read_text(encoding="utf-8").replace('"role":"extra"', '"role":"elsewhere"', 1), encoding="utf-8")
    done = run_step(steps_of("manifests.yml")[PUSH_STEPS[0]]["run"], copy, tools)
    assert done.returncode != 0 and "example.manifest.jsonl" in done.stderr and "[schema] role" in done.stderr


# Made-up people for the commits of the test repositories, with addresses on a reserved example domain.
EXAMPLE_DOMAIN = "example.org"
PERSON = ("Example Person", f"person@{EXAMPLE_DOMAIN}")
SOMEBODY_ELSE = ("Somebody Else", f"else@{EXAMPLE_DOMAIN}")


def git(folder: Path, *arguments: str) -> str:
    identity = ["-c", f"user.name={PERSON[0]}", "-c", f"user.email={PERSON[1]}", "-c", "commit.gpgsign=false"]
    return subprocess.run(["git", *identity, *arguments], cwd=folder, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture()
def checkout(tmp_path) -> Path:
    """A small git repository with the files the manifest workflow reads, and one commit."""
    if shutil.which("git") is None:
        pytest.skip("git is not installed")
    folder = tmp_path / "checkout"
    shutil.copytree(ROOT / "games", folder / "games")
    (folder / "data").mkdir()
    shutil.copy(ROOT / "data" / "example.manifest.jsonl", folder / "data" / "example.manifest.jsonl")
    git(folder, "init", "--quiet")
    git(folder, "add", "-A")
    git(folder, "commit", "--quiet", "-m", "the files the workflow reads")
    return folder


def offered_row(**fields) -> dict:
    return row_doc(**{"role": "extra", "source_type": "physical/webcam", "boxes": [], "group": "g-offer-01", **fields})


def test_the_pull_request_step_takes_offered_rows_and_refuses_claimed_ones(checkout, tools):
    step = steps_of("manifests.yml")[OFFER_STEP]["run"]
    base = git(checkout, "rev-parse", "HEAD")

    def head_with(docs: list[dict], name: str = "data/new.manifest.jsonl") -> dict[str, str]:
        git(checkout, "checkout", "--quiet", "-B", "offer", base)
        write_lines(checkout / name, docs)
        git(checkout, "add", "-A")
        git(checkout, "commit", "--quiet", "-m", "labels")
        return {**tools, "BASE": base, "HEAD": git(checkout, "rev-parse", "HEAD")}

    done = run_step(step, checkout, head_with([offered_row(), offered_row(t=20.5)]))
    assert done.returncode == 0, done.stdout + done.stderr
    assert "data/new.manifest.jsonl: 2 row(s) added or changed" in done.stdout and "valid: 2 row(s)" in done.stdout

    done = run_step(step, checkout, head_with([offered_row(), offered_row(t=20.5, reachable=True, reachable_checked="2026-01-01")]))
    assert done.returncode != 0 and "[contribution] reachable is set" in done.stderr

    done = run_step(step, checkout, head_with([offered_row(platform="local", video_id="kitchen-table")]))
    assert done.returncode != 0 and '[contribution] platform is "local"' in done.stderr

    # A pull request that touches no manifest row passes, and says so.
    done = run_step(step, checkout, head_with([offered_row()], name="notes/labels.jsonl"))
    assert done.returncode == 0 and "adds or changes no manifest row" in done.stdout


# ---------------------------------------------------------------------------- no-binaries.yml
BINARY_STEP = "Refuse images, videos, weights and other binary files"


def test_the_binary_check_passes_on_the_tracked_files_and_refuses_a_picture(checkout, tools):
    step = steps_of("no-binaries.yml")[BINARY_STEP]["run"]
    assert '"ls-files"' in step and step.startswith("python3 - <<'PY'\n")
    if (ROOT / ".git").exists() and shutil.which("git"):
        done = run_step(step, ROOT, tools)       # on a push: every tracked file of this repository
        assert done.returncode == 0, done.stdout + done.stderr
        assert "file(s) in the repository checked" in done.stdout
    (checkout / "data" / "frame.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (checkout / "weights.onnx").write_bytes(b"model")
    (checkout / "notes.txt").write_bytes(b"text with a zero byte \x00")
    git(checkout, "add", "-A")
    done = run_step(step, checkout, tools)
    assert done.returncode != 0
    for expected in ("data/frame.png: its name is that of an image", "weights.onnx: its name is that of a model or weights file",
                     "notes.txt: not a text file (it holds a zero byte)"):
        assert expected in done.stdout
    # In a pull request only the files it adds or changes are checked.
    base = git(checkout, "rev-parse", "HEAD")
    git(checkout, "commit", "--quiet", "-m", "files that do not belong")
    (checkout / "plain.txt").write_text("plain text\n", encoding="utf-8")
    git(checkout, "add", "-A")
    git(checkout, "commit", "--quiet", "-m", "a text file")
    head = git(checkout, "rev-parse", "HEAD")
    done = run_step(step, checkout, {**tools, "BASE": git(checkout, "rev-parse", "HEAD~1"), "HEAD": head})
    assert done.returncode == 0 and "1 file(s) added or changed by this pull request checked" in done.stdout
    assert run_step(step, checkout, {**tools, "BASE": base, "HEAD": head}).returncode != 0


# ------------------------------------------------------------------------------------ dco.yml
def test_the_sign_off_check_tells_a_signed_commit_from_one_that_is_not(checkout, tools):
    step = steps_of("dco.yml")["Check Signed-off-by on every commit"]["run"]
    base = git(checkout, "rev-parse", "HEAD")

    def commit(message: str) -> None:
        with open(checkout / "notes.txt", "a", encoding="utf-8") as handle:
            handle.write(message + "\n")
        git(checkout, "add", "-A")
        git(checkout, "commit", "--quiet", "-m", message)

    commit(f"a change\n\nSigned-off-by: {PERSON[0]} <{PERSON[1]}>")
    signed = {**tools, "BASE": base, "HEAD": git(checkout, "rev-parse", "HEAD")}
    done = run_step(step, checkout, signed)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "ok        " in done.stdout and "1 commit(s) checked" in done.stdout

    commit("a change nobody signed")
    commit(f"signed by another\n\nSigned-off-by: {SOMEBODY_ELSE[0]} <{SOMEBODY_ELSE[1]}>")
    done = run_step(step, checkout, {**tools, "BASE": base, "HEAD": git(checkout, "rev-parse", "HEAD")})
    assert done.returncode != 0 and "3 commit(s) checked" in done.stdout
    assert "MISSING   " in done.stdout and "MISMATCH  " in done.stdout and "git commit --amend --signoff" in done.stdout


def test_the_sign_off_check_exempts_only_commits_authored_by_dependabot(checkout, tools):
    step = steps_of("dco.yml")["Check Signed-off-by on every commit"]["run"]
    # The job name is a required status check in the repository's ruleset: renaming it blocks every PR.
    assert "\n    name: Every commit is signed off\n" in (WORKFLOWS / "dco.yml").read_text(encoding="utf-8")
    base = git(checkout, "rev-parse", "HEAD")

    def commit(email: str, message: str) -> None:
        with open(checkout / "notes.txt", "a", encoding="utf-8") as handle:
            handle.write(message + "\n")
        git(checkout, "add", "-A")
        git(checkout, "-c", "user.name=dependabot[bot]", "-c", f"user.email={email}", "commit", "--quiet", "-m", message)

    bot = "49699333+dependabot[bot]@users.noreply.github.com"
    commit(bot, "Bump a thing")
    done = run_step(step, checkout, {**tools, "BASE": base, "HEAD": git(checkout, "rev-parse", "HEAD")})
    assert done.returncode == 0, done.stdout + done.stderr
    assert "exempt    " in done.stdout
    # A name alone is not enough, and a lookalike address is not the bot's.
    commit(f"dependabot[bot]@{EXAMPLE_DOMAIN}", "Pretends to be the bot")
    done = run_step(step, checkout, {**tools, "BASE": base, "HEAD": git(checkout, "rev-parse", "HEAD")})
    assert done.returncode != 0 and "MISSING   " in done.stdout


# ---------------------------------------------------------------------------------- pages.yml
PAGES_STEPS = ("Install the browser runtime's locked dependencies", "Type-check and run the browser runtime's tests",
               "Install the Python package, for the toy game",
               "Write the toy game (stand-in models, colored-shape cards, the example table)", "Build the hosted demo")
PAGES_CHECK = "Ask GitHub how this repository's Pages are published"
BROWSER = ROOT / "browser"


def test_the_pages_workflow_tests_first_and_deploys_with_the_least_permissions():
    text = (WORKFLOWS / "pages.yml").read_text(encoding="utf-8")
    steps = steps_of("pages.yml")
    assert list(steps) == [*PAGES_STEPS, PAGES_CHECK]
    assert [steps[name]["run"] for name in PAGES_STEPS] == [
        "npm ci\n", "npm test\n",
        "python -m pip install -r requirements-lock.txt\npython -m pip install --no-deps -e .\n",
        'python tests/test_browser_fixtures.py --demo "${RUNNER_TEMP}/toy"\n',
        'npm run build:pages -- --games toy,one-piece,local --toy "${RUNNER_TEMP}/toy"\n']
    # The games are named in the workflow: no repository variable and no secret is read.
    assert "vars." not in text and "DEMO_RELEASE_URL" not in text
    assert "secrets." not in text
    # A push to main and a run by hand; never a pull request.
    assert "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n\n" in text and "pull_request" not in text
    assert [line.strip() for line in text.splitlines() if line.strip().startswith("uses: ") or line.startswith("      - uses: ")] == [
        "- uses: actions/checkout@v4", "- uses: actions/setup-node@v4", "- uses: actions/setup-python@v5",
        "- uses: actions/upload-pages-artifact@v3",
        "uses: actions/deploy-pages@v4"]
    # Read-only at the top; Pages read for the check; Pages write and the OIDC token for the deploy job only.
    lines = text.splitlines()
    granted = []
    for at, line in enumerate(lines):
        if line.strip() == "permissions:":
            indent = len(line) - len(line.lstrip())
            block = []
            for following in lines[at + 1:]:
                if len(following) - len(following.lstrip()) <= indent:
                    break
                block.append(following.strip())
            granted.append(sorted(block))
    assert granted == [["contents: read"], ["pages: read"], ["id-token: write", "pages: write"]]
    deploy = text[text.index("\n  deploy:\n"):]
    assert "needs: [build, pages]" in deploy
    assert "if: needs.pages.outputs.enabled == 'true' && github.ref == 'refs/heads/main'" in deploy
    assert "path: browser/dist/pages" in text


@pytest.mark.parametrize(("answer", "enabled"), [("workflow", "true"), ("legacy", "false"), (None, "false")])
def test_the_pages_check_deploys_only_when_pages_deploy_from_actions(answer, enabled, tools, tmp_path):
    """The check asks GitHub with ``gh``, here a stand-in that answers as GitHub would: Pages
    that deploy from GitHub Actions, Pages that publish a branch, or no Pages at all (an error)."""
    fake = tmp_path / "gh"
    fake.mkdir()
    reply = "exit 1" if answer is None else f"echo {answer}"
    (fake / "gh").write_text(f'#!/bin/sh\n[ "$1 $2" = "api repos/example/repo/pages" ] || exit 9\n{reply}\n', encoding="utf-8")
    (fake / "gh").chmod(0o755)
    output = tmp_path / "output"
    environment = {**tools, "PATH": f"{fake}{os.pathsep}{tools['PATH']}", "GITHUB_REPOSITORY": "example/repo",
                   "GITHUB_OUTPUT": str(output)}
    done = run_step(steps_of("pages.yml")[PAGES_CHECK]["run"], tmp_path, environment)
    assert done.returncode == 0, done.stdout + done.stderr
    assert output.read_text(encoding="utf-8") == f"enabled={enabled}\n"
    assert ("::notice title=Hosted demo not deployed::" in done.stdout) == (enabled == "false")


@pytest.mark.skipif(shutil.which("node") is None or not (BROWSER / "node_modules").is_dir(),
                    reason="needs Node and browser/node_modules (npm ci in browser/)")
def test_the_pages_steps_write_the_toy_game_and_build_the_site_with_the_game_picker(tools, tmp_path):
    """The toy game's step, from the repository's root, and the build step, in browser/, as the
    workflow runs them (``RUNNER_TEMP`` is a folder of the test's): the site in dist/pages, the
    folder the next step uploads, offers the toy game and the One Piece Card Game."""
    shim = tmp_path / "python"
    shim.mkdir()
    (shim / "python").write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n', encoding="utf-8")
    (shim / "python").chmod(0o755)
    environment = {**tools, "PATH": f"{shim}{os.pathsep}{tools['PATH']}", "RUNNER_TEMP": str(tmp_path)}
    steps = steps_of("pages.yml")
    written = run_step(steps["Write the toy game (stand-in models, colored-shape cards, the example table)"]["run"], ROOT, environment)
    assert written.returncode == 0, written.stdout + written.stderr
    assert (tmp_path / "toy" / "release" / "release.json").is_file() and (tmp_path / "toy" / "table.webm").is_file()
    done = run_step(steps["Build the hosted demo"]["run"], BROWSER, environment)
    assert done.returncode == 0, done.stdout + done.stderr
    site = BROWSER / "dist" / "pages"
    page = (site / "index.html").read_text(encoding="utf-8")
    assert '<meta name="cardvision-games" content="' in page and 'name="cardvision-release"' not in page
    assert "https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece/resolve/5526f531863381745780f4377f1cae767077ca77/" in page
    assert not (site / "score.html").exists()
    assert (site / "games" / "toy" / "release" / "release.json").is_file() and (site / "games" / "toy" / "table.png").is_file()
    assert len(list((site / "games" / "toy" / "images").glob("*.png"))) == 20
    assert "game toy: Toy game (practice)" in done.stdout and "game one-piece: One Piece Card Game (Kenbunshoku models)" in done.stdout
    assert "game local: Your game (files on this computer), its model from a folder the visitor chooses" in done.stdout


# ----------------------------------------------------------------------------- quickstart.yml
QUICKSTART_LINUX = "Run the beginner path as the documents write it"
QUICKSTART_WSL = ("Let the user run sudo, as the user Ubuntu asks for on its first start can",
                  "Prepare Ubuntu with the quickstart's blocks for Windows", "Clone the repository into the Linux home",
                  "Run the beginner path as the documents write it, and open the demo from Windows")
SETUP_WSL = "Vampire/setup-wsl@4c48163d9f981914dd8caa0fc335fe19cca5bff4"


def test_the_quickstart_workflow_runs_the_documents_beginner_path_on_linux_and_in_wsl():
    """The commands are not in the workflow: ``tests/beginner_path.py`` reads them out of the
    documents (``tests/test_beginner_path.py``). The workflow runs it on Linux, and in Ubuntu
    under WSL 2 on Windows after preparing Ubuntu with the quickstart's own blocks."""
    text = (WORKFLOWS / "quickstart.yml").read_text(encoding="utf-8")
    steps = steps_of("quickstart.yml")
    assert list(steps) == [QUICKSTART_LINUX, *QUICKSTART_WSL]
    assert steps[QUICKSTART_LINUX]["run"] == "python3 tests/beginner_path.py\n"
    prepare = steps[QUICKSTART_WSL[1]]["run"]
    assert "--print windows-packages" in prepare and "--print windows-node" in prepare
    # The repository is cloned into the Linux home, not used from the Windows drive.
    clone = steps[QUICKSTART_WSL[2]]["run"]
    assert 'git init --quiet "$HOME/riftsight-vision"' in clone and "git checkout --quiet --detach FETCH_HEAD" in clone
    run = steps[QUICKSTART_WSL[3]]["run"]
    assert run.startswith('cd "$HOME/riftsight-vision"\n') and "python3 tests/beginner_path.py --while-serving '" in run
    assert '"${DEMO_URL/127.0.0.1/localhost}"' in run and "/mnt/c/Windows/System32/curl.exe" in run
    # A push to main, a pull request, a run by hand; no secret and no variable.
    assert "on:\n  push:\n    branches: [main]\n  pull_request:\n  workflow_dispatch:\n\n" in text
    assert "secrets." not in text and "vars." not in text
    assert "permissions:\n  contents: read\n" in text and text.count("permissions:") == 1
    assert "runs-on: ubuntu-latest" in text and "runs-on: windows-latest" in text
    assert "          distribution: Ubuntu-24.04\n          wsl-version: 2\n" in text
    assert "    defaults:\n      run:\n        shell: wsl-bash {0}\n" in text
    used = [line.strip() for line in text.splitlines() if "uses: " in line]
    assert used == ["- uses: actions/checkout@v4", "- uses: actions/setup-node@v4",
                    "- uses: actions/checkout@v4", f"uses: {SETUP_WSL} # v7.2.0", f"uses: {SETUP_WSL} # v7.2.0"]
    # An action that is not GitHub's own is pinned to a full commit, never to a tag or a branch.
    for line in used:
        action = line.split("uses: ", 1)[1].split(" ", 1)[0]
        if not action.startswith("actions/"):
            assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", action), action
    # The second set-up runs only when the first failed, with the same inputs.
    assert f"      - id: wsl\n        continue-on-error: true\n        uses: {SETUP_WSL} # v7.2.0\n" in text
    first, second = text.split(f"uses: {SETUP_WSL} # v7.2.0\n")[1:]
    assert first.endswith("      - if: steps.wsl.outcome == 'failure'\n        ")
    assert first.split("      - ", 1)[0] == second.split("      - ", 1)[0]


def test_the_quickstart_workflow_s_windows_blocks_are_the_quickstart_s(tools):
    """The step that prepares Ubuntu prints the quickstart's blocks for Windows with the script; on
    this computer the printing is run, not the blocks."""
    for name, expected in (("windows-packages", "sudo apt install --yes python3-venv git curl\n"),
                           ("windows-node", "nvm install --lts\n")):
        done = run_step(f"python3 tests/beginner_path.py --print {name}\n", ROOT, tools)
        assert done.returncode == 0, done.stderr
        assert expected in done.stdout


def test_publish_runs_only_by_hand():
    """Publishing to the package index is not set up: a published GitHub release must upload
    nothing. The workflow runs only by hand, the test site is the default target, and the real
    index is reached only when that target is chosen, on a tag."""
    text = (WORKFLOWS / "publish.yml").read_text(encoding="utf-8")
    trigger = text.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
    assert trigger.startswith("  workflow_dispatch:\n") and "release" not in trigger
    assert "push:" not in trigger and "pull_request" not in trigger and "schedule" not in trigger
    assert "options: [testpypi, pypi]\n        default: testpypi\n" in trigger
    assert "github.event_name" not in text
    assert "    if: inputs.target == 'testpypi'\n" in text
    assert "    if: inputs.target == 'pypi' && github.ref_type == 'tag'\n" in text
