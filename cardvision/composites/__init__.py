# SPDX-License-Identifier: Apache-2.0
"""Generated training scenes: labeled cards on card-free backgrounds.

The generator needs card images and nothing else. Faces are the images a catalog names, read
from one folder; card backs, tables, distractors, dice, hands and broadcast graphics are all
drawn by code. A folder of CC0 material scans may be added for more varied tables.

    from cardvision.composites import generate
    from cardvision.core.catalog import load_catalog

    generate(load_catalog("catalog.json"), "art/", "out/", n=1000, seed=7)

or ``cardvision make-composites --catalog C.json --art DIR --out DIR --n N --seed S``.

``cardvision evaluate hover|crops|detector --scenes DIR`` scores a configuration on such a folder by
its exact labels (``cardvision.evaluate.scenes``).

The output folder
=================

``images/00000.jpg`` and so on, ``labels.jsonl`` and ``manifest.json``. The same inputs, seed,
split and settings always give the same bytes.

``labels.jsonl`` has one JSON object per scene, in index order:

``index``, ``split``, ``seed``
    Which scene this is.
``file``, ``width``, ``height``
    The image, relative to the folder, and its size in px.
``background``
    ``family`` and ``license``; for a scan also ``source``, ``assetId``, ``page``,
    ``licenseUrl`` and ``sha256``.
``camera``
    ``tilt`` and ``dir`` in degrees, ``focal`` in px, and ``H``, the 3 x 3 map from the table
    plane to the image.
``layout``
    ``"table"``, ``"scatter"``, ``"board"`` or ``"probe"``. ``board`` describes a game board
    (None otherwise) and ``broadcast`` the broadcast graphics (None when there are none).
``photometric``, ``light``, ``glare``, ``degrade``
    What was done to the picture: the photometric setting's name, the lighting, the strength
    of each glare blob, and the degradation steps with their values.
``objects``
    Everything labeled, in drawing order (later objects lie on top).

An object always has the keys down to ``source``; the ones after it are there when they apply.

``id``
    Unique in its scene.
``kind``
    The class: ``"face"`` (a card, face up), ``"back"`` (a card, face down), ``"distractor"``,
    ``"die"``, ``"hand"`` or ``"overlay"`` (a broadcast graphic).
``cardId``
    For a face, the catalog id of the card. None for everything else.
``box``
    ``[x0, y0, x1, y1]`` in px: the axis-aligned box around the four corners, cut to the frame
    (and, in a broadcast frame, to the table's window).
``corners``
    The quad: four ``[x, y]`` points in px, in the order top-left, top-right, bottom-right,
    bottom-left of the object's own outline, sleeve included. They are not cut to the frame.
``H``
    The 3 x 3 homography from the unit square (top edge first) to image px. None for hands
    and overlays.
``angle``, ``tableAngle``
    ``angle`` is the direction of the object's top in the image, in degrees clockwise from
    image-up; ``tableAngle`` its rotation on the table.
``visible``
    The share of the object's area that is on top in the image, from 0 to 1. Being covered and
    being cut by the frame edge both lower it.
``short``
    The length of the quad's short side, in px.
``positive``, ``ignore``
    ``positive`` is true for a face that a detector should find. A face that is less than half
    visible has ``ignore: "lowvis"`` and one with a short side under 20 px ``ignore: "small"``:
    neither positive nor background. Everything that is not a face has both unset
    (false and None); a back is a second class for a detector that has one, and background
    for one that does not.
``cx``, ``cy``, ``w``, ``h``
    The box again, as center and size divided by the frame's width and height.
``source``
    Where the picture came from: ``"art"`` (a card image), ``"art-inset"`` (a featured card in
    a broadcast frame), ``"generated-back"``, or the name of the generated shape.
``sleeve``, ``sleeveType``, ``foil``, ``photo``
    For cards: the sleeve's border in px (0 for none) and whether it is clear or opaque,
    whether the face is foil, and the photometric effects applied.
``role``, ``side``, ``tags``
    The slot the card fills in its layout, whose side of a board it is on, and, in broadcast
    frames, ``["overlay"]`` or ``["inset", "overlay"]``.

``manifest.json`` records the run: ``format`` and ``formatVersion``, ``seed``, ``split``,
``scenes``, the SHA-256 of ``labels.jsonl``, how many catalog cards had an image
(``catalog.cardsWithArt``) and how many had no image used (``catalog.cardsWithoutArt``: a
missing file, a URL, or ``"art": null``), the
``kinds`` settings read from the catalog, the ``settings`` and fixed ``parameters`` of the
generator, and ``counts`` of objects, positives, layouts and backgrounds. ``parameters.cardAspect``
is the width over the height of an upright card in that run (``--card-size``; 0.716 for the
default 63 x 88 mm); ``validate`` reads it, and takes 0.716 when a folder does not record it.

Modules
=======

``scene`` builds one scene; ``dataset`` writes a set of them; ``validate`` checks a written
set. ``cards`` supplies faces and generated backs, ``board`` the game-board layout,
``photometric`` the color effects, ``broadcast`` the stream graphics, ``textures`` every
procedural texture, ``surfaces`` the scanned backgrounds, ``finish`` sleeves, foil and the
canvas, ``geometry`` the plane maps, and ``fetch`` downloads the scans.
"""

from cardvision.composites.cards import CardPool, KindSettings, load_kinds
from cardvision.composites.fetch import FetchError, fetch_textures
from cardvision.composites.dataset import generate, read_labels
from cardvision.composites.scene import Settings, build_scene
from cardvision.composites.validate import validate_labels

__all__ = [
    "CardPool",
    "FetchError",
    "KindSettings",
    "Settings",
    "build_scene",
    "fetch_textures",
    "generate",
    "load_kinds",
    "read_labels",
    "validate_labels",
]
