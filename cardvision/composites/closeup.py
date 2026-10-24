# SPDX-License-Identifier: Apache-2.0
"""Geometry and drawn effects of a close-up scene: one large card, sometimes two, held at a
steep angle in front of the camera.

A close-up is what a digital client shows when a card is summoned or activated, and what a
webcam close over a table shows: a card that fills much of the frame under strong
perspective, often with a glow around it. The scene generator draws one on an opt-in share of
scenes (``scene.Settings.closeups``).

A close-up card is a rectangle in front of a pinhole camera (focal length ``focal`` px, the
principal point at the frame's center). Its pose is a turn by ``roll`` degrees in its own plane,
then a tilt by ``tilt`` degrees out of it, about an axis in the image plane at ``dir`` degrees.
The tilt is the angle between the card's normal and the camera's axis, so it can be read back
from the card's homography and the focal length (``tilt_from_h``).
"""

from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from cardvision.composites import textures as T
from cardvision.composites.geometry import poly_area

TILT = (15.0, 45.0)  # degrees out of the image plane
HEIGHT_SHARE = (0.25, 0.80)  # the card's long side at its center's depth, as a share of the frame height
PAIR_SHARE = 0.25  # share of close-ups that show two cards
FOCAL = (0.6, 1.4)  # focal length as a multiple of the frame width: short lenses give strong perspective
INSIDE_MIN = 0.75  # the main card keeps at least this share of its area inside the frame
GLOW_SHARE = 0.6  # share of close-ups with a glow around the cards


def _axis_rotation(axis, deg):
    """3 x 3 rotation by ``deg`` degrees about a unit ``axis`` (Rodrigues)."""
    k = np.asarray(axis, np.float64)
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    t = math.radians(deg)
    return np.eye(3) + math.sin(t) * K + (1 - math.cos(t)) * K @ K


def pose_rotation(tilt, tilt_dir, roll):
    """The card's rotation: ``roll`` degrees in its own plane, then ``tilt`` degrees out of it
    about the image-plane axis at ``tilt_dir`` degrees."""
    d = math.radians(tilt_dir)
    return _axis_rotation((math.cos(d), math.sin(d), 0.0), tilt) @ _axis_rotation((0.0, 0.0, 1.0), roll)


def card_homography(W, H, focal, center, R, width, height):
    """3 x 3 map from the unit square (top edge first) to image px, for a ``width`` x ``height``
    rectangle centered on the camera-space point ``center`` and turned by ``R``."""
    K = np.array([[focal, 0, W / 2], [0, focal, H / 2], [0, 0, 1.0]])
    c = np.asarray(center, np.float64)
    origin = c - R[:, 0] * width / 2 - R[:, 1] * height / 2
    Hm = K @ np.column_stack([R[:, 0] * width, R[:, 1] * height, origin])
    return Hm / Hm[2, 2]


def tilt_from_h(Hm, W, H, focal):
    """The out-of-plane tilt, in degrees, of the plane a homography from the unit square maps,
    seen by a camera of focal length ``focal`` px centered on a ``W`` x ``H`` frame."""
    K = np.array([[focal, 0, W / 2], [0, focal, H / 2], [0, 0, 1.0]])
    M = np.linalg.inv(K) @ np.asarray(Hm, np.float64)
    r1, r2 = M[:, 0] / np.linalg.norm(M[:, 0]), M[:, 1] / np.linalg.norm(M[:, 1])
    n = np.cross(r1, r2)
    n /= np.linalg.norm(n)
    return math.degrees(math.acos(min(1.0, abs(float(n[2])))))


def inside_share(corners, W, H):
    """The share of a convex quad's area that lies inside the ``W`` x ``H`` frame
    (Sutherland-Hodgman clipping)."""
    full = poly_area(np.asarray(corners, np.float64))
    poly = [np.asarray(p, np.float64) for p in corners]
    for axis, bound, sign in ((0, 0.0, 1), (0, float(W), -1), (1, 0.0, 1), (1, float(H), -1)):
        out = []
        for i, cur in enumerate(poly):
            prev = poly[i - 1]
            cur_in, prev_in = sign * (cur[axis] - bound) >= 0, sign * (prev[axis] - bound) >= 0
            if cur_in != prev_in:
                t = (bound - prev[axis]) / (cur[axis] - prev[axis])
                out.append(prev + t * (cur - prev))
            if cur_in:
                out.append(cur)
        poly = out
        if len(poly) < 3:
            return 0.0
    return float(poly_area(np.asarray(poly)) / full) if full > 0 else 0.0


def glow(rng, img, quads, W, H):
    """A soft colored glow around the cards' outlines, drawn into the float image under them,
    sometimes with rays and sparks. Returns what was drawn."""
    scale = 0.25
    w, h = max(1, int(W * scale)), max(1, int(H * scale))
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    for corners in quads:
        draw.polygon([(float(x) * scale, float(y) * scale) for x, y in corners], fill=255)
    size = max(math.sqrt(poly_area(np.asarray(c))) for c in quads) * scale
    radius = size * rng.uniform(0.06, 0.25)
    field = np.asarray(mask.filter(ImageFilter.GaussianBlur(radius)), np.float32) / 255
    field = np.clip(field * 2.0, 0, 1)
    color = np.asarray(T.rand_color(rng, sat=(0.3, 1.0), val=(0.75, 1.0)), np.float32)
    strength = rng.uniform(0.35, 1.1)
    log = {"radius": round(radius / scale, 1), "strength": round(strength, 3)}
    center = np.mean([np.mean(np.asarray(c), 0) for c in quads], 0) * scale
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    if rng.random() < 0.35:  # rays bursting from behind the cards
        n_rays = int(rng.integers(6, 24))
        ang = np.arctan2(yy - center[1], xx - center[0])
        r = np.hypot(xx - center[0], yy - center[1])
        rays = (0.5 + 0.5 * np.cos(n_rays * ang + rng.uniform(0, 6.28))) ** rng.uniform(2, 8)
        field = np.maximum(field, rays * np.exp(-r / (size * rng.uniform(0.6, 1.5))) * rng.uniform(0.4, 0.9))
        log["rays"] = n_rays
    if rng.random() < 0.35:  # sparks: small bright dots around the cards
        n_sparks = int(rng.integers(10, 60))
        spread = size * rng.uniform(0.5, 1.2)
        sparks = np.zeros((h, w), np.float32)
        for _ in range(n_sparks):
            sx, sy = center + rng.normal(0, spread, 2)
            sd = rng.uniform(0.6, 2.0)
            sparks += np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * sd * sd)) * rng.uniform(0.4, 1.0)
        field = np.maximum(field, np.clip(sparks, 0, 1))
        log["sparks"] = n_sparks
    full = np.asarray(Image.fromarray(field.astype(np.float32), "F").resize((W, H), Image.BILINEAR))
    img += full[..., None] * color * strength
    np.clip(img, 0, 1, out=img)
    return log
