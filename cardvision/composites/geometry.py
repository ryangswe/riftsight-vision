# SPDX-License-Identifier: Apache-2.0
"""Plane geometry for the scene generator.

A scene has a table plane and a camera. Table coordinates are in pixels of an untilted view,
with the origin at the image center and +y towards the bottom of the frame. Every object is a
unit square (s to the right, t down, top edge at t = 0) mapped on to the table plane and from
there, through the camera, to image pixels; the product of the two maps is the 3 x 3
homography recorded in the object's label.
"""

from __future__ import annotations

import math

import numpy as np

# Width over height of an upright card of the default size, 63 x 88 mm. It sets the spacing of
# layouts, the shape of generated backs and of card-shaped distractors; a face's own shape always
# follows its image. A run may use another card size (``card_aspect``).
CARD_ASPECT = 0.716
DEFAULT_CARD_SIZE_MM = (63.0, 88.0)
ASPECT_RANGE = (0.5, 1.0)  # the upright aspects a run accepts


def card_aspect(width_mm: float, height_mm: float) -> float:
    """Width over height of an upright card of ``width_mm`` x ``height_mm``, rounded to three
    decimals, so that the default 63 x 88 mm gives ``CARD_ASPECT`` exactly. Raises ValueError for
    a size that is not positive or whose aspect lies outside ``ASPECT_RANGE``."""
    if not (math.isfinite(width_mm) and math.isfinite(height_mm) and width_mm > 0 and height_mm > 0):
        raise ValueError(f"card size {width_mm:g} x {height_mm:g} mm: both sides must be positive numbers")
    aspect = round(width_mm / height_mm, 3)
    lo, hi = ASPECT_RANGE
    if not lo <= aspect <= hi:
        raise ValueError(f"card size {width_mm:g} x {height_mm:g} mm: width over height is {aspect:g}, outside "
                         f"{lo:g} to {hi:g}; give the width and then the height of an upright card, such as 63x88")
    return aspect


def check_aspect(aspect: float) -> float:
    """``aspect`` as a float, or ValueError when it is not a number within ``ASPECT_RANGE``."""
    lo, hi = ASPECT_RANGE
    if isinstance(aspect, bool) or not isinstance(aspect, (int, float)) or not lo <= aspect <= hi:
        raise ValueError(f"card aspect must be a number from {lo:g} to {hi:g}, not {aspect!r}")
    return float(aspect)


def parse_card_size(text: str) -> tuple[float, float]:
    """``"WxH"`` in millimeters, such as ``"63x88"`` or ``"59x86"``, as ``(width, height)``.
    Raises ValueError for anything else."""
    parts = str(text).strip().lower().split("x")
    try:
        if len(parts) != 2:
            raise ValueError
        width, height = (float(part) for part in parts)
    except ValueError:
        raise ValueError(f"card size {text!r}: give the width and height in millimeters as WxH, such as 63x88") \
            from None
    card_aspect(width, height)  # refuses a size that is not positive or not card-shaped
    return width, height


def scene_homography(W, H, tilt_deg, dir_deg, f):
    """Table plane (px units, origin at the image center) -> image px, for a camera tilted by
    ``tilt_deg`` about an in-plane axis at ``dir_deg``. The scale is 1 at the center."""
    t, d = math.radians(tilt_deg), math.radians(dir_deg)
    k = np.array([math.cos(d), math.sin(d), 0.0])
    Kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    R = np.eye(3) + math.sin(t) * Kx + (1 - math.cos(t)) * Kx @ Kx
    K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1.0]])
    Hm = K @ np.column_stack([R[:, 0], R[:, 1], [0, 0, f]])
    return Hm / Hm[2, 2]


def apply_h(Hm, pts):
    """Map an (n, 2) list of points through a 3 x 3 homography."""
    p = np.asarray(pts, np.float64)
    q = np.c_[p, np.ones(len(p))] @ Hm.T
    return q[:, :2] / q[:, 2:3]


def local_scale(Hm, q):
    """Linear magnification of the homography at point ``q`` (square root of the area ratio)."""
    a = apply_h(Hm, [q, (q[0] + 1, q[1]), (q[0], q[1] + 1)])
    j = np.array([a[1] - a[0], a[2] - a[0]])
    return math.sqrt(abs(np.linalg.det(j)))


def rot2(deg):
    """2 x 2 rotation by ``deg`` degrees."""
    r = math.radians(deg)
    return np.array([[math.cos(r), -math.sin(r)], [math.sin(r), math.cos(r)]])


def unit_to_table(q, wt, ht, theta):
    """3 x 3 map from the unit square to the table plane: a ``wt`` x ``ht`` rectangle centered
    on ``q`` and turned by ``theta`` degrees. The card's top edge is t = 0."""
    R = rot2(theta) @ np.diag([wt, ht])
    off = np.asarray(q) - R @ np.array([0.5, 0.5])
    return np.array([[R[0, 0], R[0, 1], off[0]], [R[1, 0], R[1, 1], off[1]], [0, 0, 1.0]])


def poly_area(c):
    """Area of a polygon given as an (n, 2) array of corners."""
    x, y = c[:, 0], c[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def image_angle(corners):
    """Direction of a card's top in the image: degrees clockwise from image-up, in [0, 360)."""
    ctr = corners.mean(0)
    top = (corners[0] + corners[1]) / 2
    u = top - ctr
    return (math.degrees(math.atan2(u[0], -u[1])) + 360) % 360


def log_uniform(rng, a, b):
    """A draw between ``a`` and ``b`` that is uniform in the logarithm."""
    return math.exp(rng.uniform(math.log(a), math.log(b)))
