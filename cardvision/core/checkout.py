# SPDX-License-Identifier: Apache-2.0
"""Where this toolkit's checkout is, and the checks that keep files out of it.

The repository holds no images and no model files, so the commands that write such files
(``try``, ``fetch-weights``) refuse a folder inside the checkout they run from. A path given
as ``"$GAME/cards.csv"`` with ``$GAME`` unset reads ``/cards.csv``; ``unset_variable_hint``
says so.
"""

from __future__ import annotations

from pathlib import Path


def checkout_root() -> Path | None:
    """The checkout this package runs from, or ``None`` when it is installed elsewhere."""
    root = Path(__file__).resolve().parents[2]     # core/ -> cardvision/ -> the checkout
    return root if (root / "pyproject.toml").is_file() else None


def inside(path: Path, folder: Path) -> bool:
    """Whether ``path`` is ``folder`` or lies below it (both resolved by the caller)."""
    return path == folder or folder in path.parents


def inside_checkout(path: str | Path) -> bool:
    """Whether ``path`` lies inside the checkout this package runs from."""
    root = checkout_root()
    return root is not None and inside(Path(path).resolve(), root)


def unset_variable_hint(raw: str | Path) -> str | None:
    """A hint for a path that starts at the filesystem root with one name after it, such as
    ``/cards.csv``: what ``"$GAME/cards.csv"`` becomes when ``$GAME`` is unset. ``None`` otherwise."""
    text = str(raw)
    if not text.startswith("/"):
        return None
    path = Path(text)
    if path.parent != Path("/") or path == Path("/"):
        return None
    return (f"{text} starts at the top of the file system: if you typed it as \"$SOMETHING/{path.name}\", that "
            "shell variable is empty (a new terminal forgets it; paste its export line again)")
