# SPDX-License-Identifier: Apache-2.0
"""Broadcast-style graphics: the table image laid out as a frame of a produced stream.

``compose`` takes a finished table image (after lighting, before degradation) with its id map
and objects, and returns a frame in one of three arrangements:

``panels`` (45 %)
    The table in a window 55 to 75 % of the frame wide, between side panels. Each panel wide
    enough holds a webcam-like picture and a name plate. Three times in four the wider panel
    also holds a featured card: a whole clean card image, upright, 35 to 65 % of the frame
    high.
``pip`` (25 %)
    A webcam-like picture fills the frame and the table is a small picture-in-picture window,
    22 to 45 % of the frame wide, in a corner. Cards in it are small.
``bars`` (30 %)
    The table fills the frame; three times in ten a featured card lies over a corner.

Any arrangement may add a score bar along the top or bottom edge (85 % of frames, 60 % for
``pip``) and a text banner across the table window (35 %): a filled strip with an outline and
random letters, 30 to 80 % of the window's width and 6 to 13 % of its height, at 20 to 80 %
of the way down. A banner covers whatever cards lie under it.

The webcam-like picture is drawn from colored shapes (a room and a head-and-shoulders
outline); it is never a photograph and never a real face. All text is random letters.

Labels. Each graphic is an object of kind ``"overlay"`` with tags ``["overlay"]``: background
to a detector. A featured card is kind ``"face"`` with tags ``["inset", "overlay"]`` and
follows the rules for faces. Graphics are drawn over the table, so they take pixels from the
table's objects in the id map and lower their visible share. The table's objects are scaled
and moved with the window (corners, H and area), and each gets a ``clipRect`` so that its box
is cut to the window.
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from cardvision.composites import textures as T
from cardvision.composites.geometry import CARD_ASPECT

VARIANTS = (("panels", 0.45), ("pip", 0.25), ("bars", 0.30))


def _font(size):
    return ImageFont.load_default(size=max(8, int(size)))


def _words(rng, n):
    a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return " ".join("".join(a[int(i)] for i in rng.integers(0, 26, int(rng.integers(3, 9)))) for _ in range(n))


def _rgb255(color):
    return tuple(int(x * 255) for x in color)


def person(rng, w, h):
    """A webcam-like picture made of shapes: a room-like background and a head-and-shoulders
    outline in flat colors."""
    w, h = max(16, int(w)), max(16, int(h))
    bg, _ = T.make_background(rng, w, h, ["gradient", "desk", "weave"][int(rng.integers(0, 3))])
    im = Image.fromarray((np.clip(bg, 0, 1) * 255).astype(np.uint8)).convert("RGBA")
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for _ in range(int(rng.integers(2, 6))):  # blocks in the room (shelves, lights)
        c = _rgb255(T.rand_color(rng)) + (int(rng.uniform(60, 200)),)
        x0, y0 = rng.uniform(0, w), rng.uniform(0, h * 0.6)
        d.rectangle([x0, y0, x0 + rng.uniform(0.05, 0.3) * w, y0 + rng.uniform(0.03, 0.2) * h], fill=c)
    cx = w * rng.uniform(0.35, 0.65)
    hr = min(w, h) * rng.uniform(0.16, 0.26)
    cy = h * rng.uniform(0.38, 0.55)
    shirt = _rgb255(T.rand_color(rng, val=(0.1, 0.9))) + (255,)
    d.ellipse([cx - hr * 2.4, cy + hr * 0.9, cx + hr * 2.4, cy + hr * 4.5], fill=shirt)  # shoulders
    skin = _rgb255(T.skin_tone(rng)) + (255,)
    d.rectangle([cx - hr * 0.35, cy + hr * 0.6, cx + hr * 0.35, cy + hr * 1.3], fill=skin)  # neck
    d.ellipse([cx - hr * 0.8, cy - hr, cx + hr * 0.8, cy + hr], fill=skin)  # head
    hair = _rgb255(T.rand_color(rng, sat=(0, 0.6), val=(0.05, 0.6))) + (255,)
    d.chord([cx - hr * 0.85, cy - hr * 1.1, cx + hr * 0.85, cy + hr * 0.5], 180, 360, fill=hair)
    if rng.random() < 0.4:  # a headset
        d.arc([cx - hr * 1.0, cy - hr * 1.2, cx + hr * 1.0, cy + hr * 0.8], 180, 360, fill=(20, 20, 20, 255),
              width=max(2, int(hr * 0.12)))
    ov = ov.filter(ImageFilter.GaussianBlur(rng.uniform(0.5, 2.0)))
    return Image.alpha_composite(im, ov).convert("RGB")


def _panel_fill(rng, w, h):
    w, h = max(8, int(w)), max(8, int(h))
    c1, c2 = T.rand_color(rng, val=(0.05, 0.35)), T.rand_color(rng, val=(0.1, 0.5))
    g = T.palette_map(T.gradient(w, h, rng.uniform(0, 6.28)), [c1, c2])
    return Image.fromarray((np.clip(g, 0, 1) * 255).astype(np.uint8))


def _bar(rng, w, h):
    im = _panel_fill(rng, w, h)
    d = ImageDraw.Draw(im)
    acc = _rgb255(T.rand_color(rng, sat=(0.6, 1), val=(0.6, 1)))
    d.rectangle([0, 0, max(2, int(w * rng.uniform(0.01, 0.04))), h], fill=acc)
    f = _font(h * 0.5)
    d.text((w * 0.05, h * 0.2), _words(rng, 2), fill=(255, 255, 255), font=f)
    score_at = (w * rng.uniform(0.45, 0.6), h * 0.2)
    d.text(score_at, f"{int(rng.integers(0, 9))} - {int(rng.integers(0, 9))}", fill=acc, font=f)
    d.text((w * rng.uniform(0.7, 0.8), h * 0.2), _words(rng, 1), fill=(255, 255, 255), font=f)
    return im


def _banner(rng, w, h):
    im = _panel_fill(rng, w, h)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, w - 1, h - 1], outline=_rgb255(T.rand_color(rng, val=(0.6, 1))), width=max(1, int(h * 0.06)))
    d.text((w * 0.08, h * 0.18), _words(rng, int(rng.integers(1, 4))), fill=(255, 255, 255), font=_font(h * 0.6))
    return im


class Out:
    """The output frame: the image, its id map, and ``put`` to draw a graphic on both."""

    def __init__(self, W, H, rng):
        self.W, self.H = W, H
        self.img = np.asarray(_panel_fill(rng, W, H), np.float32) / 255
        self.ids = np.zeros((H, W), np.int16)

    def put(self, pil, x, y, obj_id, alpha=None):
        x, y = int(round(x)), int(round(y))
        w, h = pil.size
        x0, y0, x1, y1 = max(0, x), max(0, y), min(self.W, x + w), min(self.H, y + h)
        if x1 <= x0 or y1 <= y0:
            return False
        a = np.asarray(pil.convert("RGB"), np.float32)[y0 - y:y1 - y, x0 - x:x1 - x] / 255
        if alpha is None:
            self.img[y0:y1, x0:x1] = a
            if obj_id:
                self.ids[y0:y1, x0:x1] = obj_id
        else:
            m = np.asarray(alpha, np.float32)[y0 - y:y1 - y, x0 - x:x1 - x] / 255
            self.img[y0:y1, x0:x1] = self.img[y0:y1, x0:x1] * (1 - m[..., None]) + a * m[..., None]
            if obj_id:
                self.ids[y0:y1, x0:x1][m > 0.5] = obj_id
        return True


def _draw_variant(grng):
    names, ps = zip(*VARIANTS)
    return names[int(grng.choice(len(names), p=np.array(ps) / sum(ps)))]


def predraw(grng):
    """Draw the arrangement and the table window's scale ahead of ``compose``.

    A board that is to fill the frame has to be sized for its window before it is laid out, so
    these two draws are made first and handed back to ``compose`` as ``preset``, which then
    skips them.
    """
    variant = _draw_variant(grng)
    if variant == "bars":
        s = 1.0
    elif variant == "panels":
        s = grng.uniform(0.55, 0.75)
    else:
        s = grng.uniform(0.22, 0.45)
    return {"variant": variant, "s": float(s)}


def compose(grng, img, ids, objects, W, H, inset_fn=None, probe=False, preset=None, card_aspect=CARD_ASPECT):
    """Lay the table image out as a broadcast frame.

    ``inset_fn(grng)`` returns ``(card image, card id)`` for a featured card; without it, and
    in card-free (``probe``) scenes, none is drawn. Returns ``(image, id map, objects, info)``:
    the table's objects moved with their window, followed by the graphics. ``card_aspect`` is
    the run's upright card aspect; it bounds the height of a featured card in a side panel.
    """
    variant = _draw_variant(grng) if preset is None else preset["variant"]
    out = Out(W, H, grng)
    next_id = max([o["id"] for o in objects] + [0]) + 1
    if variant == "bars":
        s, ox, oy = 1.0, 0, 0
    elif variant == "panels":
        s = grng.uniform(0.55, 0.75) if preset is None else preset["s"]
        ox = (W - s * W) * grng.uniform(0.3, 0.7)
        oy = (H - s * H) * grng.uniform(0.1, 0.6)
    else:
        s = grng.uniform(0.22, 0.45) if preset is None else preset["s"]
        corner = int(grng.integers(0, 4))
        m = 0.03
        ox = W * m if corner in (0, 3) else W - s * W - W * m
        oy = H * m if corner in (0, 1) else H - s * H - H * m
    graphics = []
    if variant == "pip":  # the main picture
        cam = person(grng, W, H)
        out.put(cam, 0, 0, next_id)
        graphics.append({"id": next_id, "sub": "webcam-main", "rect": (0, 0, W, H)})
        next_id += 1
    # The table window.
    tw, th = max(8, int(round(s * W))), max(8, int(round(s * H)))
    ox, oy = int(round(ox)), int(round(oy))
    timg = Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8))
    if s != 1.0:
        timg = timg.resize((tw, th), Image.BILINEAR, reducing_gap=2.0)
        tids = Image.fromarray(ids.astype(np.int32), "I").resize((tw, th), Image.NEAREST)
        tids = np.asarray(tids).astype(np.int16)
    else:
        tids = ids
    out.img[oy:oy + th, ox:ox + tw] = np.asarray(timg, np.float32) / 255
    out.ids[oy:oy + th, ox:ox + tw] = tids
    sx, sy = tw / W, th / H
    Tm = np.array([[sx, 0, ox], [0, sy, oy], [0, 0, 1.0]])
    for o in objects:
        c = np.asarray(o["corners"], float)
        o["corners"] = np.c_[c[:, 0] * sx + ox, c[:, 1] * sy + oy].round(2).tolist()
        o["area"] = o["area"] * sx * sy
        o["clipRect"] = [float(ox), float(oy), float(ox + tw), float(oy + th)]
        if o.get("H") is not None:
            Hn = Tm @ np.asarray(o["H"])
            o["H"] = (Hn / Hn[2, 2]).round(6).tolist()
    if variant != "bars":  # a thin frame around the window
        fr = Image.new("RGB", (tw + 6, th + 6), _rgb255(T.rand_color(grng, val=(0.5, 1))))
        a = Image.new("L", fr.size, 255)
        ImageDraw.Draw(a).rectangle([3, 3, tw + 2, th + 2], fill=0)
        out.put(fr, ox - 3, oy - 3, next_id, alpha=a)
        graphics.append({"id": next_id, "sub": "window-frame", "rect": (ox - 3, oy - 3, ox + tw + 3, oy + th + 3)})
        next_id += 1
    inset = None
    if variant == "panels":
        left, right = (0, ox - 3), (ox + tw + 3, W)
        for (a0, a1) in (left, right):
            pw = a1 - a0
            if pw < 40:
                continue
            ph = H * grng.uniform(0.2, 0.35)
            cam = person(grng, pw * 0.9, ph)
            cy = H * grng.uniform(0.02, 0.15)
            out.put(cam, a0 + pw * 0.05, cy, next_id)
            graphics.append({"id": next_id, "sub": "webcam",
                             "rect": (a0 + pw * 0.05, cy, a0 + pw * 0.05 + cam.width, cy + cam.height)})
            next_id += 1
            nb = _bar(grng, pw * 0.9, H * grng.uniform(0.04, 0.07))
            ny = cy + cam.height + H * 0.01
            out.put(nb, a0 + pw * 0.05, ny, next_id)
            graphics.append({"id": next_id, "sub": "name-plate",
                             "rect": (a0 + pw * 0.05, ny, a0 + pw * 0.05 + nb.width, ny + nb.height)})
            next_id += 1
        if inset_fn is not None and not probe and grng.random() < 0.75:
            side = left if (left[1] - left[0]) >= (right[1] - right[0]) else right
            inset = ("panel", side)
    elif variant == "bars" and inset_fn is not None and not probe and grng.random() < 0.3:
        inset = ("corner", None)
    if inset is not None:
        card, cid = inset_fn(grng)
        chh = H * grng.uniform(0.35, 0.65)
        if inset[0] == "panel":
            pw = inset[1][1] - inset[1][0]
            chh = min(chh, pw * 0.92 / card_aspect)
        cw = chh * card.width / card.height
        if cw >= 16 and chh >= 16:
            pil = card.resize((max(8, int(round(cw))), max(8, int(round(chh)))), Image.LANCZOS)
            al = T.rounded_mask(pil.width, pil.height, pil.width * 0.045)
            if inset[0] == "panel":
                x = inset[1][0] + (inset[1][1] - inset[1][0] - pil.width) / 2
                y = H - pil.height - H * grng.uniform(0.03, 0.12)
            else:
                x = W * 0.02 if grng.random() < 0.5 else W - pil.width - W * 0.02
                y = H * grng.uniform(0.05, 0.4)
            glow = Image.new("RGB", (pil.width + 8, pil.height + 8), _rgb255(T.rand_color(grng, val=(0.6, 1))))
            out.put(glow, x - 4, y - 4, 0, alpha=T.rounded_mask(glow.width, glow.height, glow.width * 0.05))
            out.put(pil, x, y, next_id, alpha=al)
            x0, y0 = int(round(x)), int(round(y))
            corners = [[float(x0), float(y0)], [float(x0 + pil.width), float(y0)],
                       [float(x0 + pil.width), float(y0 + pil.height)], [float(x0), float(y0 + pil.height)]]
            Hm = np.array([[pil.width, 0, x0], [0, pil.height, y0], [0, 0, 1.0]])
            objects.append({"id": next_id, "kind": "face", "cardId": cid, "source": "art-inset", "sleeve": 0,
                            "foil": False, "role": "inset", "tags": ["inset", "overlay"], "corners": corners,
                            "H": Hm.tolist(), "angle": 0.0, "tableAngle": None,
                            "area": float(pil.width * pil.height)})
            next_id += 1
    if grng.random() < (0.85 if variant != "pip" else 0.6):  # a score bar
        bw, bh = W * grng.uniform(0.4, 1.0), H * grng.uniform(0.045, 0.09)
        bx = (W - bw) * grng.uniform(0, 1)
        by = 0 if grng.random() < 0.5 else H - bh
        out.put(_bar(grng, bw, bh), bx, by, next_id)
        graphics.append({"id": next_id, "sub": "score-bar", "rect": (bx, by, bx + bw, by + bh)})
        next_id += 1
    if grng.random() < 0.35:  # a text banner across the table window
        bw, bh = tw * grng.uniform(0.3, 0.8), th * grng.uniform(0.06, 0.13)
        bx, by = ox + (tw - bw) * grng.uniform(0, 1), oy + (th - bh) * grng.uniform(0.2, 0.8)
        out.put(_banner(grng, bw, bh), bx, by, next_id)
        graphics.append({"id": next_id, "sub": "banner", "rect": (bx, by, bx + bw, by + bh)})
        next_id += 1
    for g in graphics:
        x0, y0, x1, y1 = [float(v) for v in g["rect"]]
        objects.append({"id": g["id"], "kind": "overlay", "source": g["sub"], "tags": ["overlay"], "cardId": None,
                        "corners": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], "H": None, "angle": 0.0,
                        "tableAngle": None, "area": max(1.0, (x1 - x0) * (y1 - y0))})
    inset_drawn = bool(inset is not None and any(o.get("role") == "inset" for o in objects))
    info = {"variant": variant, "tableScale": round(float(s), 3), "tableWindow": [ox, oy, ox + tw, oy + th],
            "graphics": [g["sub"] for g in graphics], "inset": inset_drawn}
    return np.clip(out.img, 0, 1), out.ids, objects, info
