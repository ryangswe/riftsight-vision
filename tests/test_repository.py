# SPDX-License-Identifier: Apache-2.0
"""Housekeeping checks on the source tree and the shared constants."""

from __future__ import annotations

import re
from pathlib import Path

from cardvision.core import constants

ROOT = Path(__file__).resolve().parents[1]
IDENTIFIER = "SPDX-License-Identifier: Apache-2.0"
HEADER = f"# {IDENTIFIER}"

# The folders whose files carry the license line, and how each kind of file writes it. JSON and
# CSV have no comments, so data files cannot carry one; any other kind of file has to be listed here.
LICENSED_FOLDERS = ("cardvision", "tests", "labeler", "games", "data", "examples", "browser", "docs", ".github")
SLASHES = f"// {IDENTIFIER}"
LICENSE_LINE = {
    ".py": HEADER, ".toml": HEADER, ".txt": HEADER, ".yml": HEADER, ".yaml": HEADER,
    ".js": SLASHES, ".mjs": SLASHES, ".ts": SLASHES, ".mts": SLASHES,
    ".css": f"/* {IDENTIFIER} */",
    ".md": f"<!-- {IDENTIFIER} -->",
    ".html": f"<!-- {IDENTIFIER} -->",
}
LICENSE_LINE_BY_NAME = {".gitignore": HEADER}
WITHOUT_COMMENTS = {".json", ".jsonl", ".csv"}
# Never scanned: caches, the packages npm installs under browser/, the build it writes there, and
# the OpenCV.js that browser/scripts/build-opencv.mjs writes to browser/vendor/.
NOT_SOURCE = {"__pycache__", ".pytest_cache", "node_modules", "dist", "vendor"}


def is_source(path: Path, root: Path = ROOT) -> bool:
    """Whether a file under ``root`` is one of the repository's own: no cache, installed
    package or build output on its way from the root."""
    return (path.is_file() and not NOT_SOURCE & set(path.relative_to(root).parts) and path.suffix != ".pyc"
            and path.name != ".DS_Store")


def license_line(path: Path) -> str | None:
    """The first-line comment a file must carry, or ``None`` for a kind of file with no rule."""
    return LICENSE_LINE_BY_NAME.get(path.name, LICENSE_LINE.get(path.suffix))


def python_files() -> list[Path]:
    return sorted(path for folder in ("cardvision", "tests", "labeler", "examples") for path in (ROOT / folder).rglob("*.py")
                  if is_source(path))


def licensed_files(root: Path = ROOT) -> list[Path]:
    """Every file of the licensed folders, and the files at the top of the repository."""
    inside = [path for folder in LICENSED_FOLDERS for path in (root / folder).rglob("*") if is_source(path, root)]
    top = [path for path in root.iterdir() if path.is_file() and license_line(path) is not None]
    return sorted([*inside, *top])


def test_every_source_file_starts_with_the_license_identifier():
    files = python_files()
    assert files and {"labeler", "examples"} <= {path.parent.name for path in files}
    missing = [str(path.relative_to(ROOT)) for path in files
               if path.read_text(encoding="utf-8").splitlines()[:1] != [HEADER]]
    assert missing == []


def test_every_file_of_the_licensed_folders_carries_the_license_line():
    """Python, TOML, YAML and text files, scripts in JavaScript and TypeScript, style sheets,
    pages and every Markdown page start with the identifier, written as that kind of file
    writes a comment. An HTML page keeps its doctype first and the identifier second. This
    covers the package, the tests, the labeling tool, the browser runtime under ``browser/``,
    the documents under ``docs/`` and the workflows and templates under ``.github/``."""
    files = licensed_files()
    seen = {path.suffix for path in files}
    assert {".py", ".toml", ".js", ".mjs", ".ts", ".css", ".md", ".html", ".yml", ".json"} <= seen
    unknown = sorted(str(path.relative_to(ROOT)) for path in files
                     if license_line(path) is None and path.suffix not in WITHOUT_COMMENTS)
    assert unknown == [], "a kind of file with no rule here"
    missing = []
    for path in files:
        if path.suffix in WITHOUT_COMMENTS:
            continue
        lines = path.read_text(encoding="utf-8").splitlines()
        first = lines[1:2] if path.suffix == ".html" else lines[:1]
        if first != [license_line(path)]:
            missing.append(str(path.relative_to(ROOT)))
    assert missing == []
    folders = {path.relative_to(ROOT).parts[0] for path in files if len(path.relative_to(ROOT).parts) > 1}
    assert folders == set(LICENSED_FOLDERS)
    names = {str(path.relative_to(ROOT)) for path in files}
    assert {"browser/src/pipeline.ts", "browser/scripts/build.mjs", "browser/examples/score-headless.mjs",
            "browser/demo/index.html", "browser/demo/demo.css",
            "browser/.gitignore", "docs/how-it-works.md", ".github/workflows/tests.yml", ".github/PULL_REQUEST_TEMPLATE.md",
            ".gitignore", "README.md"} <= names


def test_installed_packages_and_build_output_are_never_scanned(tmp_path):
    """``browser/node_modules`` and ``browser/dist`` hold other people's files and generated
    ones. They are left out wherever they lie, and every other file of a licensed folder is in."""
    for name in ("browser/src/own.ts", "browser/scripts/own.mjs", "browser/node_modules/other/index.js",
                 "browser/node_modules/other/dist/index.mts", "browser/dist/cardvision.js", "browser/dist/demo/index.html",
                 "browser/test/__pycache__/x.py", "docs/page.md", ".github/workflows/check.yml", "top.md", "top.bin"):
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text("", encoding="utf-8")
    found = [str(path.relative_to(tmp_path)) for path in licensed_files(tmp_path)]
    assert found == [".github/workflows/check.yml", "browser/scripts/own.mjs", "browser/src/own.ts", "docs/page.md", "top.md"]
    assert [license_line(Path(name)) for name in ("a.ts", "a.mts", "a.mjs", "a.js", "a.yml")] == [SLASHES] * 4 + [HEADER]
    assert license_line(Path("a.css")) == f"/* {IDENTIFIER} */" and license_line(Path("a.html")) == f"<!-- {IDENTIFIER} -->"
    assert license_line(Path("browser/.gitignore")) == HEADER and license_line(Path("a.json")) is None


def test_the_package_s_data_files_are_declared_for_the_wheel():
    """Every file inside the package that is not Python is named under package-data, so that a
    wheel carries it; a file added without a declaration would be left out silently."""
    try:
        import tomllib
    except ImportError:
        import pytest

        tomllib = pytest.importorskip("tomli")
    declared = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["tool"]["setuptools"]["package-data"]
    named = {(package, name) for package, names in declared.items() for name in names}
    found = {(".".join(path.parent.relative_to(ROOT).parts), path.name) for path in (ROOT / "cardvision").rglob("*")
             if is_source(path) and path.suffix != ".py"}
    assert named == found and len(found) == 3
    from importlib import resources

    for package, name in sorted(named):
        assert resources.files(package).joinpath(name).is_file(), (package, name)


def test_every_file_the_notice_names_is_packaged_with_it():
    """The wheel and the source archive carry the license files. NOTICE sends the reader to other
    files at the top of the repository; each must be packaged beside it, or the reference dangles."""
    try:
        import tomllib
    except ImportError:
        import pytest

        tomllib = pytest.importorskip("tomli")
    packaged = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["license-files"]
    named = {word for word in re.findall(r"[A-Z][A-Z-]*(?:\.md)?", (ROOT / "NOTICE").read_text(encoding="utf-8"))
             if (ROOT / word).is_file()}
    assert {"LICENSE", "PROVENANCE.md", "TRADEMARK.md"} <= named
    assert named | {"NOTICE", "LICENSE-DATA"} <= set(packaged), sorted(named - set(packaged))
    assert all((ROOT / name).is_file() for name in packaged)


def test_the_source_archive_leaves_the_tests_out():
    """setuptools adds tests/test*.py to a source archive by default, without the helpers they
    import; MANIFEST.in prunes the folder so that no half of it ships."""
    lines = [line.strip() for line in (ROOT / "MANIFEST.in").read_text(encoding="utf-8").splitlines()]
    assert "prune tests" in lines
    assert not [line for line in lines if line and not line.startswith("#") and line != "prune tests"]


def test_the_docs_give_each_manifest_s_current_sha256():
    """The data card and PROVENANCE.md give each published manifest's SHA-256. A manifest that
    changes without its hash changing there would leave a hash nobody can match."""
    import hashlib

    manifests = sorted((ROOT / "data").glob("riftbound-*.manifest.jsonl"))
    assert len(manifests) == 3
    for doc in ("docs/data-card.md", "PROVENANCE.md"):
        text = (ROOT / doc).read_text(encoding="utf-8")
        given = dict(re.findall(r"`(data/riftbound-[a-z]+\.manifest\.jsonl)`[^`]*`([0-9a-f]{64})`", text))
        actual = {f"data/{path.name}": hashlib.sha256(path.read_bytes()).hexdigest() for path in manifests}
        assert given == actual, doc


# An install command that names this package as if a package index held it: "pip install",
# any options, then the name with or without a quote and extras. The pattern is written so that
# this file does not contain what it looks for.
INSTALL_BY_NAME = re.compile(r"pip3?\s+install\s+(?:-\S+\s+)*[\"']?" + "cardvision", re.IGNORECASE)
NOT_SCANNED = {"__pycache__", "build", "dist", "venv", "node_modules"}
TEXT_SUFFIXES = {".py", ".md", ".toml", ".txt", ".yml", ".yaml", ".json", ".jsonl", ".js", ".css", ".html", ".cff", ".cfg", ".csv", ""}


def text_files() -> list[Path]:
    """Every text file of the repository: the folders git would track, hidden folders left out
    except the workflows, and no environment or build output."""
    found = []
    for path in ROOT.rglob("*"):
        folders = path.relative_to(ROOT).parts[:-1]
        if any(part in NOT_SCANNED or part.endswith(".egg-info") or (part.startswith(".") and part != ".github")
               for part in folders):
            continue
        if path.is_file() and path.suffix in TEXT_SUFFIXES and path.name != ".DS_Store":
            found.append(path)
    return sorted(found)


def test_no_instruction_installs_the_package_by_name():
    """The package is installed from a checkout of this repository. Its name is not registered
    on the package index, so an instruction to install it by name would fail, or would install
    somebody else's package if the name were ever taken. No message, comment or page gives one."""
    for wrong in ('pip install "' + "cardvision[video]\"", "pip install " + "cardvision",
                  "pip3 install -U '" + "cardvision[train]'", "python -m pip install --upgrade " + "cardvision"):
        assert INSTALL_BY_NAME.search(wrong), wrong
    for right in ('python -m pip install -e ".[video]"', "python -m pip install --no-deps -e .",
                  "python -m pip install -r requirements-lock.txt"):
        assert not INSTALL_BY_NAME.search(right), right
    files = text_files()
    names = {str(path.relative_to(ROOT)) for path in files}
    assert {"README.md", "AGENTS.md", "data/README.md", "docs/adapt-your-game.md", "cardvision/infer/frames.py",
            ".github/workflows/tests.yml", "tests/test_repository.py"} <= names
    found = []
    for path in files:
        for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
            if INSTALL_BY_NAME.search(line):
                found.append(f"{path.relative_to(ROOT)}:{number}")
    assert found == []


def test_core_imports_nothing_from_the_rest_of_the_package():
    for path in (ROOT / "cardvision" / "core").glob("*.py"):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(("import cardvision", "from cardvision")):
                assert line.startswith("from cardvision.core"), f"{path.name}: {line}"


def test_detector_constants():
    assert constants.DETECTOR_FACE_CLASS == 0
    assert constants.DETECTOR_BACK_CLASS == 1
    assert constants.DETECTOR_MIN_CROP_PX == 24


def _locked(name: str) -> dict[str, str]:
    lines = (ROOT / name).read_text(encoding="utf-8").splitlines()
    assert lines[0] == HEADER
    pins = [line for line in lines if line and not line.startswith("#")]
    assert all("==" in line for line in pins), "only exact versions; anything else is explained in a comment"
    return dict(line.split("==") for line in pins)


def test_the_lock_files_agree_with_each_other_and_with_the_package():
    base, train = _locked("requirements-lock.txt"), _locked("requirements-lock-train.txt")
    # The training environment is the base one and more: no shared package at two versions.
    assert {name: train.get(name) for name in base} == base
    assert {"numpy", "onnxruntime", "pillow", "pytest", "onnx"} <= set(base)
    # The base environment has OpenCV and jsonschema, so no test is skipped for want of a Python
    # package other than PyTorch. (The check against the browser runtime needs Node, not a package.)
    assert {"opencv-python-headless", "jsonschema"} <= set(base)
    assert not {"torch", "torchvision", "safetensors"} & set(base)
    assert {"torch", "torchvision", "safetensors", "opencv-python-headless", "pycocotools"} <= set(train)
    # YOLOX is installed in a step of its own, stated in a comment with the verified revision.
    from cardvision.export.detector import YOLOX_INSTALL, YOLOX_REVISION

    text = (ROOT / "requirements-lock-train.txt").read_text(encoding="utf-8")
    assert "yolox" not in {name.lower() for name in train}
    assert f"python -m {YOLOX_INSTALL}" in text and YOLOX_REVISION in text


def test_the_dev_extra_can_run_every_test_that_needs_no_pytorch():
    """The ``dev`` extra names the video extra's package and jsonschema, the two things tests
    ask for (``pytest.importorskip``) beside PyTorch and the packages installed with it."""
    try:
        import tomllib
    except ImportError:
        import pytest

        tomllib = pytest.importorskip("tomli")
    extras = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["optional-dependencies"]

    def names(extra: str) -> set[str]:
        return {re.split(r"[<>=!~; ]", requirement, maxsplit=1)[0] for requirement in extras[extra]}

    assert names("video") == {"opencv-python-headless"} and names("video") <= names("dev")
    # The optional geometric stage needs OpenCV alone, and the tests have it through "dev".
    assert names("geometric") == {"opencv-python-headless"} and names("geometric") <= names("dev")
    # pytest-xdist runs the tests on every core (tests.yml); a plain "python -m pytest" needs it not.
    assert names("dev") == {"pytest", "pytest-xdist", "onnx", "opencv-python-headless", "jsonschema"}
    assert not {"torch", "torchvision", "safetensors"} & names("dev")
    # What the tests may skip for: these modules only. cv2 and jsonschema come with "dev"; the
    # rest come with "train" (tomli stands in for tomllib on Python 3.10) and with YOLOX.
    asked = set()
    for path in (ROOT / "tests").glob("*.py"):
        asked |= set(re.findall(r"importorskip\(\"([a-z0-9_]+)", path.read_text(encoding="utf-8")))
    assert asked == {"cv2", "jsonschema", "onnx", "safetensors", "tomli", "torch", "torchvision", "yolox"}


THEME_FILES = ("labeler/theme.css", "browser/demo/theme.css")


def shared_theme(text: str) -> list[tuple[str, str]]:
    """The properties of a theme file's first ``:root`` block, in order, as (name, value)."""
    block = re.search(r":root\s*\{(.*?)\}", text, re.S)
    assert block, "no :root block"
    body = re.sub(r"/\*.*?\*/", "", block.group(1), flags=re.S)
    return [(name.strip(), " ".join(value.split())) for name, value in
            (declaration.split(":", 1) for declaration in body.split(";") if declaration.strip())]


def test_the_tools_share_one_set_of_theme_values():
    # The labeling tool takes no build step and the browser pages are bundled apart from it, so
    # each carries its own theme file. Their first blocks are the shared look and must not drift.
    labeler, demo = (shared_theme((ROOT / name).read_text(encoding="utf-8")) for name in THEME_FILES)
    assert labeler and labeler == demo
    assert all(name.startswith("--") for name, _ in labeler)


def test_shared_theme_reads_the_first_block_only():
    text = ":root {\n  --a: 1px; /* note */\n  --b: linear-gradient(1deg, #000,\n    #fff);\n}\n:root { --c: 2px; }\n"
    assert shared_theme(text) == [("--a", "1px"), ("--b", "linear-gradient(1deg, #000, #fff)")]
