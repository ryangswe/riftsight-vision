# SPDX-License-Identifier: Apache-2.0
"""Optional per-frame measurements of center-mode frames: the height of a typical card face on
the frame (pixels) and the angle class of the camera. They are asked for only when the tool is
started with --probe, and they are kept in their own file in the labels folder, never in the
label rows:

    <labels-dir>/probes.json
    {"probes": {"<set id>/<frame name>": {"cardHeightPx": 140, "angleClass": "<=30"}}}

A frame's entry may hold one of its two values for a while; a frame has a *full* probe when it
holds both. Standard library only.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

FILE = "probes.json"
SCHEMA_VERSION = 1
ANGLE_CLASSES = ("<=30", "30-45", ">45")
KEYS = ("cardHeightPx", "angleClass")


def entry_errors(entry) -> list:
    """Why one frame's entry is not acceptable, as sentences ([] when it is)."""
    if not isinstance(entry, dict):
        return ["a probe must be an object {cardHeightPx, angleClass}"]
    errs = [f"a probe has an unknown key {k!r}" for k in entry if k not in KEYS]
    if "cardHeightPx" in entry:
        h = entry["cardHeightPx"]
        if not (isinstance(h, int) and not isinstance(h, bool) and h > 0):
            errs.append("cardHeightPx must be a positive whole number (frame pixels)")
    if "angleClass" in entry and entry["angleClass"] not in ANGLE_CLASSES:
        errs.append(f"angleClass must be one of {', '.join(ANGLE_CLASSES)}")
    return errs


def is_full(entry) -> bool:
    return isinstance(entry, dict) and not entry_errors(entry) and all(k in entry for k in KEYS)


def key(set_id: str, name: str) -> str:
    return f"{set_id}/{name}"


def read(labels_dir) -> dict:
    """{"<set id>/<frame name>": entry} of the whole labels folder; {} when the file is absent or unreadable."""
    try:
        doc = json.loads((Path(labels_dir) / FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    probes = doc.get("probes") if isinstance(doc, dict) else None
    if not isinstance(probes, dict):
        return {}
    return {k: e for k, e in probes.items() if isinstance(k, str) and "/" in k and isinstance(e, dict) and not entry_errors(e)}


def read_strict(labels_dir) -> tuple:
    """(probes, problem): like `read`, but a file that exists and cannot be read in full (not JSON,
    not {"probes": {...}}, an entry or a key that is not valid) gives a problem sentence, and a
    caller that would write the file again must not."""
    path = Path(labels_dir) / FILE
    if not path.exists():
        return {}, None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}, f"{FILE} cannot be read (it is not JSON)"
    probes = doc.get("probes") if isinstance(doc, dict) else None
    if not isinstance(probes, dict):
        return {}, f'{FILE} is not {{"probes": {{...}}}}'
    for k, e in probes.items():
        if not (isinstance(k, str) and "/" in k) or entry_errors(e):
            return {}, f"{FILE} holds an entry the tool would not write ({k!r})"
    return probes, None


def read_set(labels_dir, set_id: str) -> dict:
    """{frame name: entry} of one set."""
    prefix = set_id + "/"
    return {k[len(prefix):]: e for k, e in read(labels_dir).items() if k.startswith(prefix)}


def merge(old, patch) -> dict:
    """The entry after `patch` (a subset of the two keys) is applied to `old`."""
    return {**{k: v for k, v in (old or {}).items() if k in KEYS}, **{k: v for k, v in patch.items() if k in KEYS}}


def write(labels_dir, probes: dict) -> None:
    """Whole file, to a temporary file that then replaces the old one."""
    d = Path(labels_dir)
    d.mkdir(parents=True, exist_ok=True)
    doc = {"probes": {k: probes[k] for k in sorted(probes)}}
    fd, tmp = tempfile.mkstemp(dir=str(d), prefix=f".{FILE}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(doc, indent=2, sort_keys=True) + "\n")
        os.replace(tmp, d / FILE)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
