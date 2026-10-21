# SPDX-License-Identifier: Apache-2.0
"""Procedural textures: backgrounds, distractor patches, hands, dice and tokens, card backs.

Everything here is drawn from a numpy ``Generator``: no file is read and nothing is downloaded,
so every background, distractor and card back is free of any source image. Pillow and numpy
only. Backgrounds are float arrays (h, w, 3) of RGB in [0, 1]; patches are RGBA Pillow images.

The same generator state always gives the same pixels, and the functions draw their random
numbers in a fixed order, which is what makes a generated scene a pure function of its seed.
"""

from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from cardvision.composites.geometry import CARD_ASPECT

# ----------------------------------------------------------------------------- noise


def _resize_f(a, w, h, resample=Image.BICUBIC):
    return np.asarray(Image.fromarray(a.astype(np.float32), mode="F").resize((w, h), resample), dtype=np.float32)


def value_noise(rng, w, h, cell):
    """Smooth noise in ~[0, 1] with feature size ~cell px."""
    gw, gh = max(2, int(math.ceil(w / cell)) + 2), max(2, int(math.ceil(h / cell)) + 2)
    g = rng.random((gh, gw), dtype=np.float32)
    big = _resize_f(g, int(gw * cell), int(gh * cell))
    ox, oy = int(rng.integers(0, max(1, big.shape[1] - w))), int(rng.integers(0, max(1, big.shape[0] - h)))
    return big[oy:oy + h, ox:ox + w]


def fbm(rng, w, h, base_cell, octaves=5, gain=0.5):
    out = np.zeros((h, w), np.float32)
    amp, tot, cell = 1.0, 0.0, float(base_cell)
    for _ in range(octaves):
        if cell < 1.5:
            break
        out += amp * value_noise(rng, w, h, cell)
        tot += amp
        amp *= gain
        cell /= 2.0
    out /= max(tot, 1e-6)
    lo, hi = np.percentile(out, 1), np.percentile(out, 99)
    return np.clip((out - lo) / max(hi - lo, 1e-6), 0, 1)


def hsv2rgb(h, s, v):
    i = int(h * 6) % 6
    f = h * 6 - int(h * 6)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    return np.array([(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i], np.float32)


def rand_color(rng, sat=(0.2, 0.9), val=(0.15, 0.9), hue=None):
    h = rng.random() if hue is None else hue
    return hsv2rgb(h, rng.uniform(*sat), rng.uniform(*val))


def palette_map(t, colors):
    """t in [0,1] (H, W) -> RGB via piecewise-linear palette."""
    colors = np.asarray(colors, np.float32)
    n = len(colors) - 1
    x = np.clip(t, 0, 1) * n
    i = np.minimum(x.astype(np.int32), n - 1)
    f = (x - i)[..., None]
    return colors[i] * (1 - f) + colors[i + 1] * f


def gradient(w, h, angle, center=0.5):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    x, y = x / w - 0.5, y / h - 0.5
    return np.clip(center + x * math.cos(angle) + y * math.sin(angle), 0, 1)


def vignette(w, h, strength):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    r = np.sqrt(((x / w - 0.5) * 2) ** 2 + ((y / h - 0.5) * 2) ** 2) / math.sqrt(2)
    return 1 - strength * r ** 2


# ----------------------------------------------------------------------------- backgrounds
# The background families. Each returns a float array (h, w, 3), close to [0, 1].

def bg_felt(rng, w, h):
    base = rand_color(rng, sat=(0.25, 0.85), val=(0.12, 0.6))
    fine = (value_noise(rng, w, h, rng.uniform(1.5, 3.0)) - 0.5) * 3.0
    low = fbm(rng, w, h, rng.uniform(150, 600), octaves=4)
    img = base[None, None] * (0.8 + 0.4 * low[..., None]) + 0.035 * fine[..., None]
    return img * vignette(w, h, rng.uniform(0, 0.45))[..., None]


def bg_wood(rng, w, h):
    ang = rng.uniform(0, math.pi)
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    u = x * math.cos(ang) + y * math.sin(ang)
    v = -x * math.sin(ang) + y * math.cos(ang)
    warp = fbm(rng, w, h, rng.uniform(80, 300), octaves=4) * rng.uniform(20, 80)
    freq = rng.uniform(0.02, 0.09)
    grain = 0.5 + 0.5 * np.sin((v + warp) * freq)
    grain = grain ** rng.uniform(1, 3)
    plank = rng.uniform(120, 500)
    seams = np.abs(((u + rng.uniform(0, plank)) % plank) - plank / 2) > plank / 2 - rng.uniform(1, 3)
    seams = seams.astype(np.float32)
    dark = rand_color(rng, sat=(0.4, 0.8), val=(0.12, 0.35), hue=rng.uniform(0.03, 0.1))
    light = rand_color(rng, sat=(0.3, 0.7), val=(0.45, 0.85), hue=rng.uniform(0.04, 0.12))
    img = palette_map(grain * 0.8 + 0.2 * fbm(rng, w, h, 40, 3), [dark, light])
    img *= (1 - 0.5 * seams)[..., None]
    return img * vignette(w, h, rng.uniform(0, 0.4))[..., None]


def bg_weave(rng, w, h):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    p = rng.uniform(3, 9)
    ang = rng.uniform(0, math.pi)
    u = x * math.cos(ang) + y * math.sin(ang)
    v = -x * math.sin(ang) + y * math.cos(ang)
    wv = (0.5 + 0.25 * np.sin(u * 2 * math.pi / p) * np.sign(np.sin(v * math.pi / p))
          + 0.25 * np.sin(v * 2 * math.pi / p))
    c1, c2 = rand_color(rng, val=(0.2, 0.85)), rand_color(rng, val=(0.2, 0.85))
    img = palette_map(0.7 * wv + 0.3 * fbm(rng, w, h, rng.uniform(100, 400), 4), [c1, c2])
    return img * vignette(w, h, rng.uniform(0, 0.4))[..., None]


def bg_gradient(rng, w, h):
    cols = [rand_color(rng, val=(0.05, 0.95)) for _ in range(int(rng.integers(2, 4)))]
    if rng.random() < 0.5:
        t = gradient(w, h, rng.uniform(0, 2 * math.pi))
    else:
        y, x = np.mgrid[0:h, 0:w].astype(np.float32)
        cx, cy = rng.uniform(0, w), rng.uniform(0, h)
        t = np.clip(np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / rng.uniform(0.4, 1.2) / max(w, h), 0, 1)
    img = palette_map(t, cols) + rng.normal(0, 0.012, (h, w, 1)).astype(np.float32)
    return img


def bg_marble(rng, w, h):
    n = fbm(rng, w, h, rng.uniform(150, 500), octaves=6)
    veins = np.abs(np.sin((n * rng.uniform(6, 16)) + gradient(w, h, rng.uniform(0, 6.28)) * 4)) ** rng.uniform(0.2, 0.6)
    c1, c2 = rand_color(rng, sat=(0, 0.3), val=(0.55, 0.95)), rand_color(rng, sat=(0, 0.5), val=(0.05, 0.5))
    return palette_map(veins, [c2, c1])


def _zone_outlines(rng, img, w, h, n, color, fill_alpha=0.0, card_aspect=CARD_ASPECT):
    """Printed playmat zone markers: card-shaped rounded rectangles (hard negatives) of upright
    aspect ``card_aspect``, circles."""
    pil = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    col = tuple(int(c * 255) for c in color)
    for _ in range(n):
        s = rng.uniform(40, 260)
        if rng.random() < 0.7:
            ww, hh = (s * card_aspect, s) if rng.random() < 0.6 else (s, s * card_aspect)
        else:
            ww, hh = s * rng.uniform(0.5, 2.5), s
        x0, y0 = rng.uniform(-50, w), rng.uniform(-50, h)
        a = int(rng.uniform(60, 200))
        if rng.random() < 0.8:
            d.rounded_rectangle([x0, y0, x0 + ww, y0 + hh], radius=int(s * rng.uniform(0, 0.08)),
                                outline=col + (a,), width=int(rng.integers(1, 5)),
                                fill=col + (int(255 * fill_alpha),) if fill_alpha else None)
        else:
            d.ellipse([x0, y0, x0 + s, y0 + s], outline=col + (a,), width=int(rng.integers(1, 5)))
    pil = Image.alpha_composite(pil.convert("RGBA"), ov).convert("RGB")
    return np.asarray(pil, np.float32) / 255


def bg_playmat(rng, w, h, card_aspect=CARD_ASPECT):
    """Custom-playmat-like art: saturated low-frequency color fields (often bright), shapes,
    printed zone outlines (card-shaped at ``card_aspect``) and a logo/text block."""
    k = int(rng.integers(3, 6))
    bright = rng.random() < 0.5
    cols = [rand_color(rng, sat=(0.3, 1.0), val=(0.5, 1.0) if bright else (0.1, 0.8)) for _ in range(k)]
    t = fbm(rng, w, h, rng.uniform(120, 700), octaves=int(rng.integers(3, 7)))
    img = palette_map(t, cols)
    pil = Image.fromarray((img * 255).astype(np.uint8)).convert("RGBA")
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for _ in range(int(rng.integers(0, 12))):
        c = tuple(int(x * 255) for x in rand_color(rng, val=(0.3, 1))) + (int(rng.uniform(40, 160)),)
        r = rng.uniform(20, 400)
        x0, y0 = rng.uniform(-r, w), rng.uniform(-r, h)
        kind = rng.random()
        if kind < 0.4:
            d.ellipse([x0, y0, x0 + r, y0 + r], fill=c)
        elif kind < 0.7:
            pts = [(x0 + rng.uniform(-r, r), y0 + rng.uniform(-r, r)) for _ in range(int(rng.integers(3, 7)))]
            d.polygon(pts, fill=c)
        else:
            d.line([(x0, y0), (x0 + rng.uniform(-w, w), y0 + rng.uniform(-h, h))], fill=c,
                   width=int(rng.integers(2, 30)))
    ov = ov.filter(ImageFilter.GaussianBlur(rng.uniform(0, 6)))
    pil = Image.alpha_composite(pil, ov).convert("RGB")
    img = np.asarray(pil, np.float32) / 255
    if rng.random() < 0.7:
        img = _zone_outlines(rng, img, w, h, int(rng.integers(2, 12)), rand_color(rng, sat=(0, 0.4), val=(0.7, 1)),
                             card_aspect=card_aspect)
    if rng.random() < 0.5:
        pil = Image.fromarray((img * 255).astype(np.uint8))
        draw_text_block(rng, pil, int(rng.uniform(0, w * 0.7)), int(rng.uniform(0, h * 0.8)), transparent=True)
        img = np.asarray(pil, np.float32) / 255
    return img


def bg_desk(rng, w, h):
    """Plain desk / tablecloth: near-uniform color, soft light falloff, a little texture."""
    c = rand_color(rng, sat=(0, 0.35), val=(0.1, 0.95))
    light = gradient(w, h, rng.uniform(0, 6.28), rng.uniform(0.3, 0.7))
    img = c[None, None] * (0.75 + 0.5 * light[..., None]) + 0.02 * (fbm(rng, w, h, 20, 3)[..., None] - 0.5)
    return img


BG_FAMILIES = {"felt": bg_felt, "wood": bg_wood, "weave": bg_weave, "gradient": bg_gradient,
               "marble": bg_marble, "playmat": bg_playmat, "desk": bg_desk}
BG_WEIGHTS = {"felt": 0.2, "wood": 0.14, "weave": 0.1, "gradient": 0.1, "marble": 0.08, "playmat": 0.28, "desk": 0.1}


def make_background(rng, w, h, family=None, card_aspect=CARD_ASPECT):
    """A background of ``family`` (drawn by its weight when None), ``w`` x ``h``: a float array
    (h, w, 3) and the family's name. ``card_aspect`` shapes the zone outlines of a playmat."""
    if family is None:
        fams = list(BG_WEIGHTS)
        family = fams[int(rng.choice(len(fams), p=np.array([BG_WEIGHTS[f] for f in fams]) / sum(BG_WEIGHTS.values())))]
    # generate at reduced size for the smooth families (fast), then upscale; add fine noise
    scale = 2 if family in ("gradient", "desk", "marble", "playmat") else 1
    if family == "playmat":
        img = bg_playmat(rng, w // scale, h // scale, card_aspect)
    else:
        img = BG_FAMILIES[family](rng, w // scale, h // scale)
    img = np.clip(img, 0, 1)
    if scale != 1:
        img = np.asarray(Image.fromarray((img * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) / 255
    return img, family


# ----------------------------------------------------------------------------- text


def draw_text_block(rng, pil, x, y, transparent=False, width=None):
    d = ImageDraw.Draw(pil)
    size = int(rng.uniform(10, 48))
    font = ImageFont.load_default(size=size)
    col = tuple(int(c * 255) for c in rand_color(rng, sat=(0, 0.8), val=(0, 1)))
    alph = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789      "
    lines = int(rng.integers(1, 6))
    for i in range(lines):
        n = int(rng.integers(3, 28))
        s = "".join(alph[int(j)] for j in rng.integers(0, len(alph), n))
        d.text((x, y + i * size * 1.25), s, fill=col, font=font)


# ----------------------------------------------------------------------------- RGBA patches


def rounded_mask(w, h, r, supersample=4):
    m = Image.new("L", (w * supersample, h * supersample), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w * supersample - 1, h * supersample - 1],
                                        radius=int(r * supersample), fill=255)
    return m.resize((w, h), Image.LANCZOS)


def texture_patch(rng, w, h, card_aspect=CARD_ASPECT):
    fam = ["felt", "wood", "weave", "gradient", "marble", "playmat"][int(rng.integers(0, 6))]
    img, _ = make_background(rng, max(8, w), max(8, h), fam, card_aspect)
    return Image.fromarray((img * 255).astype(np.uint8)), fam


def distractor_patch(rng, target_short, card_aspect=CARD_ASPECT):
    """A pasted non-card: textured / photo-like / text / card-shaped rectangle. Returns (RGBA, sub).

    A card-shaped one has the upright aspect ``card_aspect``. It is drawn at the default card's
    shape and then stretched to it, so that the random draws do not depend on the card size."""
    kind = rng.random()
    s = int(max(12, target_short))
    card_shaped = False
    if rng.random() < 0.45:
        card_shaped = rng.random() < 0.7
        ar = CARD_ASPECT if card_shaped else 0.7
    else:
        ar = rng.uniform(0.3, 1.0)
    portrait = rng.random() < 0.7
    w, h = (s, int(s / ar)) if portrait else (int(s / ar), s)
    # build at a comfortable resolution then the paste pipeline scales it
    bw = int(np.clip(w * rng.uniform(1.0, 2.0), 16, 500))
    bh = int(np.clip(bw * h / max(w, 1), 16, 700))
    if kind < 0.4:
        pil, fam = texture_patch(rng, bw, bh, card_aspect)
        sub = f"texture-{fam}"
    elif kind < 0.7:
        img = bg_playmat(rng, bw, bh, card_aspect)
        pil, sub = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)), "photo-like"
    else:
        paper = rand_color(rng, sat=(0, 0.3), val=(0.6, 1.0))
        pil = Image.new("RGB", (bw, bh), tuple(int(c * 255) for c in paper))
        for k in range(int(rng.integers(1, 4))):
            draw_text_block(rng, pil, int(rng.uniform(0, bw * 0.3)), int(rng.uniform(0, bh * 0.7)))
        sub = "text"
    if card_shaped and card_aspect != CARD_ASPECT:  # the run's card shape, at the same width
        w, h = (s, int(s / card_aspect)) if portrait else (int(s / card_aspect), s)
        bh = int(np.clip(bw * h / max(w, 1), 16, 700))
        pil = pil.resize((bw, bh), Image.BILINEAR)
    # card-like decoration on some distractors so "has a border / rounded corners" != card
    if rng.random() < 0.4:
        d = ImageDraw.Draw(pil)
        b = int(max(1, bw * rng.uniform(0.01, 0.06)))
        d.rectangle([0, 0, bw - 1, bh - 1], outline=tuple(int(c * 255) for c in rand_color(rng)), width=b)
        sub += "+border"
    r = bw * rng.uniform(0.03, 0.08) if rng.random() < 0.5 else 0
    alpha = rounded_mask(bw, bh, r) if r else Image.new("L", (bw, bh), 255)
    pil = pil.convert("RGBA")
    pil.putalpha(alpha)
    return pil, sub


def skin_tone(rng):
    tones = [(0.98, 0.84, 0.72), (0.94, 0.76, 0.62), (0.85, 0.64, 0.5), (0.72, 0.52, 0.38), (0.55, 0.38, 0.27),
             (0.4, 0.27, 0.19), (0.3, 0.2, 0.15)]
    c = np.array(tones[int(rng.integers(0, len(tones)))], np.float32) * rng.uniform(0.85, 1.1)
    return np.clip(c, 0, 1)


def hand_patch(rng, size):
    """Skin-toned hand blob (palm + fingers + forearm), pointing 'up' in patch coords; the forearm
    runs to the bottom edge so the paste can enter from the frame edge. Returns RGBA."""
    W, H = int(size * 1.3), int(size * 2.2)
    ss = 2
    m = Image.new("L", (W * ss, H * ss), 0)
    d = ImageDraw.Draw(m)
    cx, palm_y = W * ss / 2, H * ss * 0.45
    pw, ph = size * ss * 0.55, size * ss * 0.6
    d.ellipse([cx - pw / 2, palm_y - ph / 2, cx + pw / 2, palm_y + ph / 2], fill=255)
    d.rectangle([cx - pw * 0.42, palm_y, cx + pw * 0.42, H * ss], fill=255)  # forearm
    nf = int(rng.integers(3, 6))
    fw = pw / 4.6
    for i in range(nf):
        a = math.radians(rng.uniform(-25, 25) + (i - (nf - 1) / 2) * rng.uniform(6, 16))
        L = size * ss * rng.uniform(0.35, 0.6) * (0.8 if i in (0, nf - 1) else 1.0)
        bx = cx + (i - (nf - 1) / 2) * fw * 1.05
        by = palm_y - ph * 0.35
        ex, ey = bx + L * math.sin(a), by - L * math.cos(a)
        d.line([(bx, by), (ex, ey)], fill=255, width=int(fw))
        d.ellipse([ex - fw / 2, ey - fw / 2, ex + fw / 2, ey + fw / 2], fill=255)
    if rng.random() < 0.8:  # thumb
        a = math.radians(rng.choice([-1, 1]) * rng.uniform(40, 80))
        L = size * ss * rng.uniform(0.3, 0.45)
        bx, by = cx + math.copysign(pw * 0.4, math.sin(a)), palm_y + ph * 0.05
        ex, ey = bx + L * math.sin(a), by - L * math.cos(a)
        d.line([(bx, by), (ex, ey)], fill=255, width=int(fw * 1.2))
        d.ellipse([ex - fw * 0.6, ey - fw * 0.6, ex + fw * 0.6, ey + fw * 0.6], fill=255)
    m = m.resize((W, H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.7))
    tone = skin_tone(rng)
    shade = (0.75 + 0.35 * gradient(W, H, rng.uniform(0, 6.28))[..., None]
             + 0.05 * (fbm(rng, W, H, 30, 3)[..., None] - 0.5))
    rgb = np.clip(tone[None, None] * shade, 0, 1)
    # darker creases near the fingers via the mask's own blur difference
    mm = np.asarray(m, np.float32) / 255
    edge = np.asarray(m.filter(ImageFilter.GaussianBlur(size * 0.03)), np.float32) / 255
    rgb *= (0.8 + 0.2 * edge)[..., None]
    pil = Image.fromarray((rgb * 255).astype(np.uint8)).convert("RGBA")
    pil.putalpha(Image.fromarray((mm * 255).astype(np.uint8)))
    return pil


def die_patch(rng, size):
    """d6 with pips, a d20-like hexagon, or a round token/counter. Returns (RGBA, sub)."""
    s = int(max(10, size))
    ss = 3
    S = s * ss
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    body = rand_color(rng, sat=(0.3, 1), val=(0.3, 1))
    bc = tuple(int(c * 255) for c in body) + (255,)
    ink = (255, 255, 255, 255) if body.mean() < 0.5 else (20, 20, 20, 255)
    r = rng.random()
    if r < 0.45:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.18), fill=bc)
        n = int(rng.integers(1, 7))
        pos = {1: [(0.5, 0.5)], 2: [(0.25, 0.25), (0.75, 0.75)], 3: [(0.25, 0.25), (0.5, 0.5), (0.75, 0.75)],
               4: [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)],
               5: [(0.25, 0.25), (0.75, 0.25), (0.5, 0.5), (0.25, 0.75), (0.75, 0.75)],
               6: [(0.25, 0.22), (0.75, 0.22), (0.25, 0.5), (0.75, 0.5), (0.25, 0.78), (0.75, 0.78)]}[n]
        pr = S * 0.08
        for (px, py) in pos:
            d.ellipse([px * S - pr, py * S - pr, px * S + pr, py * S + pr], fill=ink)
        sub = "d6"
    elif r < 0.75:
        pts = [(S / 2 + S / 2 * math.cos(math.radians(60 * k + 30)), S / 2 + S / 2 * math.sin(math.radians(60 * k + 30)))
               for k in range(6)]
        d.polygon(pts, fill=bc)
        tri = [(S / 2, S * 0.12), (S * 0.14, S * 0.72), (S * 0.86, S * 0.72)]
        dark = tuple(int(c * 200) for c in body) + (255,)
        d.polygon(tri, fill=dark)
        d.text((S * 0.36, S * 0.38), str(int(rng.integers(1, 21))), fill=ink,
               font=ImageFont.load_default(size=int(S * 0.25)))
        sub = "d20"
    else:
        d.ellipse([0, 0, S - 1, S - 1], fill=bc)
        d.ellipse([S * 0.1, S * 0.1, S * 0.9, S * 0.9], outline=ink, width=max(1, int(S * 0.03)))
        d.text((S * 0.33, S * 0.28), str(int(rng.integers(0, 10))), fill=ink,
               font=ImageFont.load_default(size=int(S * 0.4)))
        sub = "token"
    im = im.resize((s, s), Image.LANCZOS)
    # simple shading
    a = np.asarray(im, np.float32)
    sh = 0.8 + 0.35 * gradient(s, s, rng.uniform(0, 6.28))
    a[..., :3] = np.clip(a[..., :3] * sh[..., None], 0, 255)
    return Image.fromarray(a.astype(np.uint8), "RGBA"), sub


def generated_back(rng, w=320, h=447, card_aspect=None):
    """A card back as an opaque sleeve shows it: a plain or graded color, a simple center
    pattern (disc, diamond or blob) and, on most, a border line. The colors are random.
    Returns RGBA with rounded corners, ``w`` x ``h``, or ``w`` wide with the upright aspect
    ``card_aspect`` when one is given. The pattern is always drawn at ``w`` x ``h`` and then
    stretched, so that the random draws do not depend on the card size."""
    base = rand_color(rng, sat=(0.2, 0.95), val=(0.08, 0.8))
    img = palette_map(gradient(w, h, rng.uniform(0, 6.28)) * rng.uniform(0.2, 0.6) + 0.2,
                      [base * 0.7, base, base * 1.2])
    if rng.random() < 0.4:
        img = img * (0.85 + 0.3 * fbm(rng, w, h, rng.uniform(20, 120), 4)[..., None])
    pil = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).convert("RGBA")
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    lc = tuple(int(c * 255) for c in rand_color(rng, sat=(0, 0.9), val=(0.5, 1))) + (int(rng.uniform(120, 255)),)
    cx, cy = w / 2, h / 2
    r = w * rng.uniform(0.18, 0.38)
    shape = rng.random()
    if shape < 0.35:
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=lc)
    elif shape < 0.7:
        d.polygon([(cx, cy - r * 1.3), (cx + r, cy), (cx, cy + r * 1.3), (cx - r, cy)], outline=lc,
                  width=int(max(2, w * 0.02)))
        d.polygon([(cx, cy - r * 0.8), (cx + r * 0.6, cy), (cx, cy + r * 0.8), (cx - r * 0.6, cy)], fill=lc)
    else:
        pts = [(cx + r * rng.uniform(0.5, 1.2) * math.cos(t), cy + r * rng.uniform(0.5, 1.2) * math.sin(t))
               for t in np.linspace(0, 6.28, 9)[:-1]]
        d.polygon(pts, fill=lc)
    if rng.random() < 0.6:
        m = int(w * rng.uniform(0.04, 0.09))
        d.rounded_rectangle([m, m, w - m, h - m], radius=int(w * 0.04), outline=lc, width=int(max(1, w * 0.012)))
    pil = Image.alpha_composite(pil, ov)
    out_h = h if card_aspect is None else int(round(w / card_aspect))
    if out_h != h:
        pil = pil.resize((w, out_h), Image.BILINEAR)
    pil.putalpha(rounded_mask(w, out_h, w * 0.045))
    return pil
