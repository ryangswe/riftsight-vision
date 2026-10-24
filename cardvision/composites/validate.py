# SPDX-License-Identifier: Apache-2.0
"""Check the labels of a generated folder against its images.

Two kinds of check:

* Structure, for every object of every scene: the box lies inside the frame and is not empty,
  the normalized center and size agree with it, a face names a card of the catalog, a back
  names none, and only faces are positives. A close-up scene must also hold a positive face,
  and each of its faces a quad that a labeled manifest would accept: convex, clockwise on
  screen, and no corner more than one frame's width or height outside the frame
  (``cardvision.data.schema.QUAD_COORDINATE_RANGE``).
* Geometry, for clearly visible faces (at least 97 % visible, short side at least 60 px, no
  sleeve, not a featured card): the face is cut out of the saved, degraded image through its
  recorded homography and compared with the card's clean image in all four orientations. If
  the homography and corners are right, the upright comparison wins. The ``angle`` label is
  checked on its own: the axis-aligned box, turned back by ``angle``, must match the clean
  image better upright than upside down.

Blur, noise and compression cost a few comparisons, so the two geometry results are rates and
not pass or fail; a wrong label convention shows as a rate near chance (a quarter and a half).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from cardvision.composites.dataset import MANIFEST_NAME, read_labels
from cardvision.composites.geometry import CARD_ASPECT, check_aspect
from cardvision.core.catalog import Catalog
from cardvision.data.geometry import is_convex, signed_area
from cardvision.data.schema import QUAD_COORDINATE_RANGE

KINDS = ("face", "back", "distractor", "die", "hand", "overlay")
_TOLERANCE = 2e-4  # the box is rounded to a tenth of a pixel, which is this much of a small frame


def signature(im, size=(24, 33)):
    """A small zero-mean, unit-length vector of an image, for comparing two pictures."""
    a = np.asarray(im.convert("RGB").resize(size, Image.BILINEAR), np.float32).ravel()
    a -= a.mean()
    return a / (np.linalg.norm(a) + 1e-6)


def structure_problems(record: dict[str, Any], catalog: Catalog | None = None) -> list[str]:
    """What is wrong with one scene record's objects, as sentences (empty when nothing is)."""
    W, H = record["width"], record["height"]
    where = f"scene {record['index']}"
    problems = []
    seen = set()
    for o in record["objects"]:
        name = f"{where} object {o.get('id')}"
        if o["id"] in seen:
            problems.append(f"{name}: id used twice")
        seen.add(o["id"])
        if o["kind"] not in KINDS:
            problems.append(f"{name}: unknown kind {o['kind']!r}")
        x0, y0, x1, y1 = o["box"]
        if not (0 <= x0 < x1 <= W and 0 <= y0 < y1 <= H):
            problems.append(f"{name}: box {o['box']} is empty or outside the {W} x {H} frame")
        c = np.asarray(o["corners"], float)
        if c.shape != (4, 2):
            problems.append(f"{name}: corners must be four points")
        elif x0 < c[:, 0].min() - 0.06 or x1 > c[:, 0].max() + 0.06 or y0 < c[:, 1].min() - 0.06 \
                or y1 > c[:, 1].max() + 0.06:
            problems.append(f"{name}: box {o['box']} reaches beyond the corners")
        expect = ((x0 + x1) / 2 / W, (y0 + y1) / 2 / H, (x1 - x0) / W, (y1 - y0) / H)
        if any(abs(o[key] - value) > _TOLERANCE for key, value in zip(("cx", "cy", "w", "h"), expect)):
            problems.append(f"{name}: cx, cy, w, h do not match the box")
        if not 0 <= o["visible"] <= 1:
            problems.append(f"{name}: visible {o['visible']} is not a share")
        if o["kind"] == "face":
            if catalog is not None and o.get("cardId") not in catalog:
                problems.append(f"{name}: face of {o.get('cardId')!r}, which is not a card of the catalog")
            if o["positive"] != (o["ignore"] is None):
                problems.append(f"{name}: a face is a positive exactly when it is not ignored")
        else:
            if o.get("cardId") is not None:
                problems.append(f"{name}: a {o['kind']} must not name a card")
            if o["positive"] or o["ignore"] is not None:
                problems.append(f"{name}: only faces are positives or ignored")
    if record.get("layout") == "closeup":
        problems.extend(closeup_problems(record))
    return problems


def closeup_problems(record: dict[str, Any]) -> list[str]:
    """What is wrong with a close-up scene beyond its objects' structure: it must hold a
    positive face, and each face's corners must form a convex, clockwise quad within
    ``QUAD_COORDINATE_RANGE`` of the frame (as fractions of its width and height)."""
    W, H = record["width"], record["height"]
    where = f"scene {record['index']}"
    problems = []
    faces = [o for o in record["objects"] if o["kind"] == "face"]
    if not any(o["positive"] for o in faces):
        problems.append(f"{where}: a close-up holds no positive face")
    lo, hi = QUAD_COORDINATE_RANGE
    for o in faces:
        c = np.asarray(o["corners"], float)
        if c.shape != (4, 2):
            continue  # structure_problems names it
        name = f"{where} object {o.get('id')}"
        fractions = c / np.array([W, H], float)
        if fractions.min() < lo or fractions.max() > hi:
            problems.append(f"{name}: a corner lies more than one frame outside the frame")
        if not is_convex(c):
            problems.append(f"{name}: the corners do not form a convex quad")
        elif signed_area(c) <= 0:
            problems.append(f"{name}: the corners do not run clockwise on screen")
    return problems


def label_problems(out_dir: str | Path, records: list[dict[str, Any]], catalog: Catalog | None = None) -> list[str]:
    """What is wrong with the scene records of a folder, as sentences: the ``structure_problems``
    of each scene, and each scene whose image is not in the folder. These are the problems
    ``validate_labels`` counts."""
    problems: list[str] = []
    for record in records:
        problems.extend(structure_problems(record, catalog))
        if not (Path(out_dir) / record["file"]).is_file():
            problems.append(f"scene {record['index']}: image {record['file']} is missing")
    return problems


def recorded_aspect(out_dir: str | Path) -> float:
    """The upright card aspect a generated folder was made with: its manifest's
    ``parameters.cardAspect``, or ``CARD_ASPECT`` for a folder whose manifest is absent or does
    not record one. Raises ValueError for a recorded value outside the accepted range."""
    path = Path(out_dir) / MANIFEST_NAME
    if not path.is_file():
        return CARD_ASPECT
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{path}: not valid JSON ({error})") from None
    if not isinstance(manifest, dict):
        raise ValueError(f"{path}: not a JSON object, so it records no parameters")
    parameters = manifest.get("parameters")
    aspect = parameters.get("cardAspect") if isinstance(parameters, dict) else None
    return CARD_ASPECT if aspect is None else check_aspect(aspect)


def validate_labels(out_dir: str | Path, catalog: Catalog, art_dir: str | Path,
                    max_faces: int = 400) -> dict[str, Any]:
    """Check a generated folder. Returns a report:

    ``scenes``, ``objects``, ``problemCount`` and ``problems`` (the first 20 sentences) for the
    structure; ``checkedFaces``, ``homographyUprightRate``, ``rectifiedCorrMedian``,
    ``rectifiedCorrP5`` and ``angleUprightRate`` for the geometry of up to ``max_faces`` faces.
    The card aspect is the one the folder records (``recorded_aspect``).
    """
    out_dir = Path(out_dir)
    aspect = recorded_aspect(out_dir)
    records = read_labels(out_dir)
    problems = label_problems(out_dir, records, catalog)
    rows = []
    objects = 0
    for record in records:
        objects += len(record["objects"])
        for o in record["objects"]:
            if (len(rows) < max_faces and o["kind"] == "face" and o["positive"] and o["visible"] >= 0.97
                    and o["short"] >= 60 and o["source"] == "art" and not o["sleeve"]):
                rows.append((record, o))
    wins, wins_angle, corrs = 0, 0, []
    for record, o in rows:
        im = Image.open(out_dir / record["file"]).convert("RGB")
        art = Image.open(catalog.art_location(o["cardId"], art_dir)).convert("RGB")
        w, h = (64, 89) if art.width < art.height else (89, 64)
        Hm = np.asarray(o["H"]) @ np.diag([1.0 / w, 1.0 / h, 1.0])
        Hm /= Hm[2, 2]
        rect = im.transform((w, h), Image.PERSPECTIVE, tuple(Hm.ravel()[:8]), Image.BILINEAR)
        size = (24, 33) if w < h else (33, 24)
        ref = signature(art, size)
        scores = []
        for quarter in (0, 90, 180, 270):
            turned = rect.rotate(quarter, expand=True)
            scores.append(float(signature(turned, size) @ ref) if (turned.width < turned.height) == (w < h) else -2)
        wins += int(np.argmax(scores) == 0)
        corrs.append(scores[0])
        # The angle, on the axis-aligned crop: compare the middle of the card with the middle
        # of its clean image, upright and upside down.
        x0, y0, x1, y1 = o["box"]
        crop = im.crop((int(x0), int(y0), int(x1), int(y1))).rotate(o["angle"], expand=True, resample=Image.BILINEAR)
        cw, ch = crop.size
        k = 0.45
        half_w, half_h = k * o["short"] / 2, k * o["short"] / 2 / aspect
        middle = crop.crop((int(cw / 2 - half_w), int(ch / 2 - half_h), int(cw / 2 + half_w), int(ch / 2 + half_h)))
        art_middle = art.crop((int(art.width * (0.5 - k / 2)), int(art.height * (0.5 - k / 2)),
                               int(art.width * (0.5 + k / 2)), int(art.height * (0.5 + k / 2))))
        up = float(signature(middle, (16, 22)) @ signature(art_middle, (16, 22)))
        down = float(signature(middle.rotate(180), (16, 22)) @ signature(art_middle, (16, 22)))
        wins_angle += int(up > down)
    n = len(corrs)
    return {
        "scenes": len(records),
        "objects": objects,
        "problemCount": len(problems),
        "problems": problems[:20],
        "checkedFaces": n,
        "homographyUprightRate": round(wins / n, 4) if n else None,
        "rectifiedCorrMedian": round(float(np.median(corrs)), 3) if n else None,
        "rectifiedCorrP5": round(float(np.percentile(corrs, 5)), 3) if n else None,
        "angleUprightRate": round(wins_angle / n, 4) if n else None,
    }
