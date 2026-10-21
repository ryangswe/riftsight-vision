# SPDX-License-Identifier: Apache-2.0
"""One generated scene: labeled cards on a card-free background, as a camera would show them.

A scene is a pure function of ``(seed, split, index)`` and the settings. Its random numbers
come from named streams keyed by those three numbers, so the same call always gives the same
image and labels, and the train, validation and probe splits never share a stream.

How a scene is made (frame 1920 x 1080 or 1280 x 720, half each):

1. Camera. The table is seen untilted in 30 % of scenes and tilted by up to 35 degrees in the
   rest, in a random direction.
2. Background. One procedural family (``textures``), or a downloaded material scan when a
   textures folder is in use (half the scenes); it lies on the table plane and is seen
   through the camera.
3. Layout, 4 to 25 cards. ``table``: rows of slots for one or two players, the far player's
   turned half a turn, with turned cards, stacks, a fanned hand and deck piles. ``scatter``:
   free positions. ``board``: a game in progress (``board.layout_board``). With boards on,
   the shares are scatter 10 %, board 25 %, table 65 %. A board fills the frame
   (``fill_frame``): its cards are 80 to 170 px wide in a 1920 px frame, or 35 to 100 px when
   the frame is to show the table as a small picture-in-picture window, and it lies on a
   surface-like background.
4. Objects, lowest first. Faces come from the card images. Backs are generated; a back is a
   labeled object of kind ``back``, which a detector must tell from a face. A loose card
   is a back with probability ``back_share``; deck piles are backs always. Distractors
   (textured, picture-like or text rectangles, many of them card-shaped with borders and
   rounded corners), dice and tokens lie among the cards. Every object is warped by its own
   homography, with a feathered edge and usually a soft shadow. 35 % of cards are sleeved
   (a 2 to 6 px border); some faces are foil.
5. Hands: up to two skin-toned shapes that reach in from a frame edge, drawn on top.
6. Light: a brightness gradient, glare blobs, then the camera's exposure.
7. Broadcast graphics on 30 % of scenes when boards are on (``broadcast``).
8. Degradation: color shift, down- and up-scaling, blur or motion blur, noise, and JPEG at
   quality 40 to 90. The JPEG bytes returned are the image.

``probe`` scenes hold distractors, dice and hands but no cards: they measure what a detector
finds where there is nothing to find.

The label of each object is described in ``cardvision.composites`` (the package docstring).
"""

from __future__ import annotations

import io
import math
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np
from PIL import Image, ImageFilter

from cardvision.composites import board as B
from cardvision.composites import broadcast as G
from cardvision.composites import photometric as P
from cardvision.composites import textures as T
from cardvision.composites.finish import Canvas, add_foil, add_sleeve, color_jitter_rgba, rounded_rgba
from cardvision.composites.geometry import (
    CARD_ASPECT,
    apply_h,
    check_aspect,
    image_angle,
    local_scale,
    log_uniform,
    poly_area,
    rot2,
    scene_homography,
    unit_to_table,
)
from cardvision.composites.surfaces import surface_background, texture_background, warp_to_table

SPLITS = ("train", "val", "probe")
SPLIT_BASE = {"train": 1_000_003, "val": 2_000_003, "probe": 3_000_003}

# The random streams of a scene. Each is keyed by (seed, split, index, stream), and the
# per-card stream by the object's id as well.
STREAM_SCENE = 1  # camera, layout, card choice, objects, hands, light, degradation
STREAM_BACKGROUND = 7002  # whether the background is a scan, and which
STREAM_EXPOSURE = 7003  # the camera's exposure and white balance
STREAM_CARD = 7004  # photometric effects on one card
STREAM_BROADCAST = 7005  # broadcast graphics
STREAM_BOARD = 7006  # how a frame-filling board is sized and placed
STREAM_SURFACE = 7007  # the background under a frame-filling board

RESOLUTIONS = [(1920, 1080), (1280, 720)]
SIZE_MIN, SIZE_MAX = 24.0, 220.0  # card width in the image, px, for table and scatter layouts
MAX_TILT = 35.0  # degrees
VISIBLE_MIN = 0.5  # a face showing less than this share of itself is not a positive
SHORT_MIN = 20.0  # nor is one whose short side is under this many px

# Share of scenes whose background is a material scan, by background mode.
BACKGROUND_SHARE = {"procedural": 0.0, "mix": 0.5, "textures": 1.0}
# Share of scenes of each layout when boards are on (the rest are "table"), and when off.
LAYOUT_SHARE = {"scatter": 0.10, "board": 0.25}
SCATTER_SHARE_PLAIN = 0.35
# Share of scenes laid out as a broadcast frame, when boards are on.
BROADCAST_SHARE = {"train": 0.30, "val": 0.30, "probe": 0.50}
# Width of a card of a frame-filling board, in px of a 1920 px frame: when the table is the
# whole frame or a large window ("full"), and when it is to be shown as a small
# picture-in-picture window ("pip"). The board is drawn larger by the window's scale and
# shrinks with it, so the cards have these sizes in the finished frame.
BOARD_CARD_PX = {"full": (80.0, 170.0), "pip": (35.0, 100.0)}
# Foil probability of a face when the photometric effects are off.
FOIL_PLAIN = 0.15


@dataclass(frozen=True)
class Settings:
    """The switches of the scene generator.

    Attributes:
        background: ``"procedural"`` (no scans), ``"mix"`` (half the scenes on a scan) or
            ``"textures"`` (every scene on a scan). None means ``"mix"`` when the card pool
            has scans and ``"procedural"`` when it has none.
        photometric: a photometric setting (``photometric.setting``), or None for none. The
            catalog's per-kind foil probabilities are added to it.
        boards: game-board layouts and broadcast graphics.
        fill_frame: with ``boards``, a board fills the frame on a surface-like background.
        back_share: probability that a loose card of a table or scatter layout lies face down.
    """

    background: str | None = None
    photometric: Mapping[str, Any] | None = field(default_factory=lambda: dict(P.DEFAULT))
    boards: bool = True
    fill_frame: bool = True
    back_share: float = 0.08

    def __post_init__(self) -> None:
        if self.background is not None and self.background not in BACKGROUND_SHARE:
            raise ValueError(f"background must be one of {sorted(BACKGROUND_SHARE)} or None, not {self.background!r}")
        if not 0 <= self.back_share <= 1:
            raise ValueError("back_share must be from 0 to 1")

    def to_json(self) -> dict[str, Any]:
        """The settings as plain JSON values."""
        return asdict(self)


def stream(seed: int, split: str, index: int, *tags: int) -> np.random.Generator:
    """The random stream named by ``tags`` for one scene."""
    return np.random.default_rng([seed, SPLIT_BASE[split], index, *tags])


def layout_table(rng, n_target, s0, aspect=CARD_ASPECT):
    """Rows of card slots for one or two players, in table coordinates (card width ``s0``,
    upright card aspect ``aspect``).

    Returns ``(slots, card width)``; a slot is ``{"q", "theta", "role"}`` and, for a card of a
    deck pile, ``"back": True``. The far player's half is turned half a turn.
    """
    w, h = s0, s0 / aspect
    out = []
    halves = ["near", "far"] if rng.random() < 0.6 else ["near"]
    gap = h * rng.uniform(0.2, 1.0)
    dx, dy = w * rng.uniform(1.06, 1.6), h * rng.uniform(1.04, 1.4)
    for half in halves:
        rows, cols = int(rng.integers(1, 4)), int(rng.integers(2, 9))
        base_theta = 0.0 if half == "near" else 180.0
        for r in range(rows):
            for c in range(cols):
                if rng.random() > 0.65:
                    continue
                x = (c - (cols - 1) / 2) * dx
                y = gap / 2 + h / 2 + r * dy
                if half == "far":
                    x, y = -x, -y
                th = base_theta + (90.0 if rng.random() < 0.15 else 0.0) + rng.normal(0, 3)
                if rng.random() < 0.1:
                    th += rng.uniform(-25, 25)
                q = np.array([x + rng.normal(0, 0.05 * w), y + rng.normal(0, 0.05 * w)])
                out.append({"q": q, "theta": th, "role": "slot"})
                if rng.random() < 0.12:  # a stack: offset copies on top
                    off_dir = rot2(th) @ np.array([0, rng.choice([-1, 1])])
                    for k in range(int(rng.integers(1, 4))):
                        out.append({"q": q + off_dir * h * rng.uniform(0.1, 0.35) * (k + 1),
                                    "theta": th + rng.normal(0, 2), "role": "stack"})
    if rng.random() < 0.3:  # a fanned hand near the near edge
        k = int(rng.integers(3, 8))
        spread = rng.uniform(10, 30)
        cx = rng.uniform(-2 * w, 2 * w)
        cy = gap / 2 + h * rng.uniform(2.0, 4.5)
        for i in range(k):
            a = -spread + 2 * spread * i / max(1, k - 1)
            piv = np.array([cx, cy + h * 1.2])
            q = piv + rot2(a) @ np.array([0, -h * 1.2])
            out.append({"q": q, "theta": a, "role": "fan"})
    if rng.random() < 0.35:  # deck piles, face down
        for _ in range(int(rng.integers(1, 3))):
            q = np.array([rng.choice([-1, 1]) * (rng.uniform(3, 5) * w),
                          rng.choice([-1, 1]) * (gap / 2 + h * rng.uniform(0.5, 2))])
            th = rng.normal(0, 4) + (0 if q[1] > 0 else 180)
            for j in range(int(rng.integers(1, 4))):
                out.append({"q": q + rng.normal(0, 1.2, 2), "theta": th + rng.normal(0, 1.5), "role": "pile",
                            "back": True})
    if len(out) > n_target:  # keep a random n_target of them, in order
        keep = sorted(rng.choice(len(out), n_target, replace=False))
        out = [out[i] for i in keep]
    return out, w


def label_objects(objects, ids, W, H):
    """Finish the labels of a scene's objects from the id map.

    Each object comes in with ``id``, ``kind``, ``corners`` and ``area`` (and ``clipRect`` when
    its box is to be cut to a window) and leaves with ``visible``, ``box``, ``short``,
    ``positive``, ``ignore`` and the normalized ``cx``, ``cy``, ``w``, ``h`` (and ``cardId``,
    None unless it had one). An object with no pixel on top anywhere, or wholly outside the
    frame, is dropped. Returns the kept objects.
    """
    counts = np.bincount(ids.ravel().astype(np.int64), minlength=max([o["id"] for o in objects] + [0]) + 2)
    labels = []
    for o in objects:
        c = np.asarray(o["corners"])
        vis = float(min(1.0, counts[o["id"]] / max(1.0, o.pop("area"))))
        x0, y0 = max(0.0, c[:, 0].min()), max(0.0, c[:, 1].min())
        x1, y1 = min(float(W), c[:, 0].max()), min(float(H), c[:, 1].max())
        cr = o.pop("clipRect", None)
        if cr is not None:
            x0, y0, x1, y1 = max(x0, cr[0]), max(y0, cr[1]), min(x1, cr[2]), min(y1, cr[3])
        sides = [np.linalg.norm(c[(i + 1) % 4] - c[i]) for i in range(4)]
        short = float(min((sides[0] + sides[2]) / 2, (sides[1] + sides[3]) / 2))
        o.update({"visible": round(vis, 3), "box": [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)],
                  "short": round(short, 1)})
        if x1 <= x0 or y1 <= y0 or counts[o["id"]] == 0:
            continue
        ignore = None
        if o["kind"] == "face":
            if o["visible"] < VISIBLE_MIN:
                ignore = "lowvis"  # covered by other objects, cut by the frame edge, or both
            elif short < SHORT_MIN:
                ignore = "small"
        o.setdefault("cardId", None)
        o["positive"] = o["kind"] == "face" and ignore is None
        o["ignore"] = ignore
        o.update({"cx": round((x0 + x1) / 2 / W, 6), "cy": round((y0 + y1) / 2 / H, 6),
                  "w": round((x1 - x0) / W, 6), "h": round((y1 - y0) / H, 6)})
        labels.append(o)
    return labels


def _photometric(cfg, pool):
    if cfg.photometric is None:
        return None
    photo = dict(cfg.photometric)
    photo["foil"] = {**pool.kinds.foil, **photo.get("foil", {})}
    return photo


def background_mode(cfg, pool) -> str:
    """The background mode in force: the setting's, or the default for this card pool."""
    mode = cfg.background or ("mix" if pool.textures else "procedural")
    if BACKGROUND_SHARE[mode] > 0 and not pool.textures:
        raise ValueError(f'background "{mode}" needs a textures folder with scans for this split')
    return mode


def build_scene(pool, split, index, seed=0, settings=None, card_aspect=CARD_ASPECT):
    """Generate one scene. Returns ``(record, JPEG bytes)``.

    ``pool`` is a ``cards.CardPool``. ``record`` is the scene's entry in ``labels.jsonl``.
    ``card_aspect`` is the width over the height of an upright card of the game: it sets the
    spacing of the layouts and the shape of backs and card-shaped distractors. A face's shape
    follows its image. The random draws of a scene do not depend on it; what it moves is where
    the cards lie, and so which board slots fall inside the frame.
    """
    if split not in SPLIT_BASE:
        raise ValueError(f"split must be one of {list(SPLITS)}, not {split!r}")
    aspect = check_aspect(card_aspect)
    cfg = settings if settings is not None else Settings()
    bg_mode = background_mode(cfg, pool)
    photo = _photometric(cfg, pool)
    rng = stream(seed, split, index, STREAM_SCENE)
    W, H = RESOLUTIONS[int(rng.integers(0, 2))]
    probe = split == "probe"
    # --- camera
    tilt = 0.0 if rng.random() < 0.3 else float(rng.uniform(0, MAX_TILT))
    tdir = float(rng.uniform(0, 360))
    focal = float(W * rng.uniform(0.9, 1.6))
    Hs = scene_homography(W, H, tilt, tdir, focal)
    Hinv = np.linalg.inv(Hs)
    # --- background. The procedural one is always drawn from the scene stream, so that every
    # later draw is the same whatever the background mode; a scan replaces it on its own stream.
    bg, family = T.make_background(rng, W, H, card_aspect=aspect)
    bg_src = None
    share = BACKGROUND_SHARE[bg_mode]
    if share > 0:
        brng = stream(seed, split, index, STREAM_BACKGROUND)
        if brng.random() < share:
            bg, bg_src = texture_background(brng, pool.textures, pool.textures_dir, W, H)
            family = "texture"
    if tilt > 0:
        bg = warp_to_table(bg, W, H, Hinv)
    cv = Canvas(bg)
    objects = []
    # --- layout
    n_target = int(rng.integers(4, 26))
    u_mode = rng.random()
    if cfg.boards:
        if u_mode < LAYOUT_SHARE["scatter"]:
            mode = "scatter"
        elif u_mode < LAYOUT_SHARE["scatter"] + LAYOUT_SHARE["board"]:
            mode = "board"
        else:
            mode = "table"
    else:
        mode = "scatter" if u_mode < SCATTER_SHARE_PLAIN else "table"
    board_info = None
    preset = None
    grng = None
    placements = []
    if not probe:
        if mode == "table":
            s0 = log_uniform(rng, SIZE_MIN, SIZE_MAX)
            slots, wt = layout_table(rng, n_target, s0, aspect)
            phi = rng.uniform(0, 360)
            Rphi = rot2(phi)
            shift = np.array([rng.uniform(-0.3, 0.3) * W, rng.uniform(-0.3, 0.3) * H])
            for sl in slots:
                q = Rphi @ sl["q"] + shift
                size = s0 * rng.uniform(0.97, 1.03)
                placements.append({"q": q, "theta": sl["theta"] + phi, "wt": size,
                                   "back": sl.get("back", False) or rng.random() < cfg.back_share,
                                   "role": sl["role"]})
            while len(placements) < n_target:  # top up with loose cards around the layout
                p = np.array([rng.uniform(-0.05, 1.05) * W, rng.uniform(-0.05, 1.05) * H])
                q = apply_h(Hinv, [p])[0]
                placements.append({"q": q, "theta": rng.uniform(0, 360), "wt": s0 * rng.uniform(0.9, 1.1) / 1.0,
                                   "back": rng.random() < cfg.back_share, "role": "loose"})
        elif mode == "board" and cfg.fill_frame:
            # The board fills the frame. The card size is chosen for the finished frame, so the
            # broadcast arrangement and its window scale are drawn first.
            lrng = stream(seed, split, index, STREAM_BOARD)
            grng = stream(seed, split, index, STREAM_BROADCAST)
            preset = G.predraw(grng) if grng.random() < BROADCAST_SHARE[split] else None
            pip = bool(preset and preset["variant"] == "pip")
            s_win = preset["s"] if preset else 1.0
            final1920 = log_uniform(lrng, *BOARD_CARD_PX["pip" if pip else "full"])
            final = final1920 * W / 1920.0  # the same share of the frame at either resolution
            s0 = final / s_win
            slots, board_info = B.layout_board(rng, s0, aspect)
            bg, family, bg_src = surface_background(stream(seed, split, index, STREAM_SURFACE), pool.surfaces,
                                                    pool.textures_dir, W, H, aspect)
            if tilt > 0:
                bg = warp_to_table(bg, W, H, Hinv)
            cv = Canvas(bg)
            aligned = lrng.random() < 0.8
            kq = int(lrng.integers(0, 4))
            phi = 90.0 * kq + lrng.uniform(-8, 8) if aligned else lrng.uniform(0, 360)
            xs = np.array([sl["q"][0] for sl in slots])
            ys = np.array([sl["q"][1] for sl in slots])
            nat_w = xs.max() - xs.min() + s0 / aspect
            cover = lrng.uniform(0.70, 1.0)
            span = H if (aligned and kq % 2 == 1) else W  # the frame side the board's long axis meets
            kx = float(np.clip(cover * span / nat_w, 0.85, 2.0))
            cxb, cyb = (xs.max() + xs.min()) / 2, (ys.max() + ys.min()) / 2
            for sl in slots:  # spread the board along its long axis
                sl["q"] = np.array([(sl["q"][0] - cxb) * kx, sl["q"][1] - cyb])
            Rphi = rot2(phi)
            shift = np.array([lrng.uniform(-0.08, 0.08) * W, lrng.uniform(-0.08, 0.08) * H])
            for sl in slots:
                q = Rphi @ sl["q"] + shift
                pimg = apply_h(Hs, [q])[0]
                size = s0 * rng.uniform(0.97, 1.03)
                if not (-0.25 * W < pimg[0] < 1.25 * W and -0.25 * H < pimg[1] < 1.25 * H):
                    continue
                placements.append({"q": q, "theta": sl["theta"] + phi, "wt": size, "back": sl["back"],
                                   "role": sl["role"], "draw": sl["draw"], "side": sl.get("side"),
                                   "diceSlot": sl.get("diceSlot", False), "diceArt": False})
            board_info.update({"placed": len(placements), "frame": {
                "finalCardPx": round(final, 1), "finalCardPx1920": round(final1920, 1),
                "windowScale": round(s_win, 3), "tableCardPx": round(s0, 1), "aligned": bool(aligned),
                "phi": round(phi % 360, 2), "spreadX": round(kx, 3), "cover": round(cover, 3),
                "surface": family, "preset": preset}})
        elif mode == "board":
            s0 = log_uniform(rng, SIZE_MIN, SIZE_MAX)
            slots, board_info = B.layout_board(rng, s0, aspect)
            phi = rng.uniform(0, 360)
            Rphi = rot2(phi)
            shift = np.array([rng.uniform(-0.3, 0.3) * W, rng.uniform(-0.3, 0.3) * H])
            for sl in slots:
                q = Rphi @ sl["q"] + shift
                pimg = apply_h(Hs, [q])[0]
                size = s0 * rng.uniform(0.97, 1.03)
                if not (-0.25 * W < pimg[0] < 1.25 * W and -0.25 * H < pimg[1] < 1.25 * H):
                    continue  # far outside the frame: it could not be seen
                placements.append({"q": q, "theta": sl["theta"] + phi, "wt": size, "back": sl["back"],
                                   "role": sl["role"], "draw": sl["draw"], "side": sl.get("side"),
                                   "diceSlot": sl.get("diceSlot", False), "diceArt": False})
            board_info["placed"] = len(placements)
        else:
            clusters = []
            if rng.random() < 0.3:
                clusters.append(np.array([rng.uniform(0.15, 0.85) * W, rng.uniform(0.15, 0.85) * H]))
            for i in range(n_target):
                if clusters and rng.random() < 0.3:
                    p = clusters[0] + rng.normal(0, 40, 2)
                else:
                    p = np.array([rng.uniform(-0.05, 1.05) * W, rng.uniform(-0.05, 1.05) * H])
                q = apply_h(Hinv, [p])[0]
                s_img = log_uniform(rng, SIZE_MIN, SIZE_MAX)
                placements.append({"q": q, "theta": rng.uniform(0, 360), "wt": s_img / local_scale(Hs, q),
                                   "back": rng.random() < cfg.back_share, "role": "scatter"})
    # --- distractors, dice and tokens: on the table, through the same pipeline as the cards
    n_dis = int(rng.integers(3, 13)) if probe else (int(rng.integers(0, 7)) if rng.random() < 0.8 else 0)
    n_dice = int(rng.integers(0, 6)) if (probe or rng.random() < 0.5) else 0
    ref = np.median([p["wt"] for p in placements]) if placements else log_uniform(rng, SIZE_MIN, SIZE_MAX)
    items = [("card", p) for p in placements]
    for _ in range(n_dis):
        p = np.array([rng.uniform(-0.05, 1.05) * W, rng.uniform(-0.05, 1.05) * H])
        q = apply_h(Hinv, [p])[0]
        if probe or rng.random() < 0.5:
            s = log_uniform(rng, SIZE_MIN, SIZE_MAX * 1.2) / local_scale(Hs, q)
        else:
            s = ref * rng.uniform(0.7, 1.4)
        items.append(("distractor", {"q": q, "theta": rng.uniform(0, 360), "wt": s}))
    for _ in range(n_dice):
        p = np.array([rng.uniform(0, 1) * W, rng.uniform(0, 1) * H])
        q = apply_h(Hinv, [p])[0]
        items.append(("die", {"q": q, "theta": rng.uniform(0, 360), "wt": max(8.0, ref * rng.uniform(0.2, 0.45))}))
    if mode == "board":
        # Dice resting on the leader's card: one or two, each 30 to 40 % of the card's width
        # across, on six in ten such cards. They are drawn last, so nothing covers them.
        leader_dice = []
        for pl in placements:
            if pl.get("diceSlot") and pool.leader_dice and not pl["back"] and rng.random() < 0.6:
                h_t = pl["wt"] / aspect
                for k in range(int(rng.integers(1, 3))):
                    off = rot2(pl["theta"]) @ np.array([rng.uniform(-0.25, 0.25) * pl["wt"],
                                                        -h_t * rng.uniform(0.05, 0.22)])
                    leader_dice.append(("die", {"q": pl["q"] + off, "theta": rng.uniform(0, 360),
                                                "wt": pl["wt"] * rng.uniform(0.30, 0.40), "role": "leader-die"}))
        items += leader_dice
    # --- drawing order: cards keep their layout order (stacks above slots); distractors and
    # dice go in at random depths
    order = list(range(len(items)))
    cards_idx = [i for i in order if items[i][0] == "card"]
    others = [i for i in order if items[i][0] != "card" and items[i][1].get("role") != "leader-die"]
    pinned = [i for i in order if items[i][1].get("role") == "leader-die"]
    z = list(cards_idx)
    for o in others:
        z.insert(int(rng.integers(0, len(z) + 1)), o)
    if rng.random() < 0.5:  # dice usually sit on top
        z = [i for i in z if items[i][0] != "die"] + [i for i in z if items[i][0] == "die"]
    z += pinned
    for obj_id, i in enumerate(z, start=1):
        kind, p = items[i]
        rec = {"id": obj_id}
        feather, blur, shadow = None, 0.0, rng.random() < 0.6
        if kind == "card":
            wt = p["wt"]
            ls = local_scale(Hs, p["q"])
            if p["back"]:
                src, sub = pool.back(rng, aspect)
                cid, rec["kind"] = None, "back"
            else:
                src, cid, sub = pool.face(rng, wt * ls / aspect * 1.3, p.get("draw"))
                rec["kind"] = "face"
            ar = src.width / src.height
            if ar > 1.05 and not p["back"]:
                wt_card = wt / aspect  # a landscape card: the same short side as an upright one
            else:
                wt_card = wt
            # Shrink the source to about 1.4 times its largest size in the image, then warp.
            tgt_w = max(8, int(round(wt_card * ls * 1.4 * (1 + tilt / 60))))
            if tgt_w < src.width:
                src = src.resize((tgt_w, max(8, int(round(tgt_w / ar)))), Image.LANCZOS)
            card = rounded_rgba(src, rng.uniform(0.035, 0.055))
            card = color_jitter_rgba(rng, card, 0.06)
            plog, card_kind = {}, pool.kind_of(cid)
            if photo is not None:
                prng = stream(seed, split, index, STREAM_CARD, obj_id)
                card, plog = P.print_effects(prng, card, photo, dice=pool.carries_dice(card_kind),
                                             die_fn=T.die_patch if p.get("diceArt", True) else None)
            sleeve = 0
            if rng.random() < 0.35:
                bpx = rng.uniform(2, 6)  # border width in image px
                sleeve_card_px = bpx * card.width / max(1e-3, wt_card * ls)
                card, stype = add_sleeve(rng, card, sleeve_card_px)
                sleeve = round(bpx, 2)
                rec["sleeveType"] = stype
            if photo is not None:
                card, ns = P.streaks(prng, card, bool(sleeve), photo)
                if ns:
                    plog["streaks"] = ns
            # The scene stream always makes the plain foil draw, so that a scene is the same
            # with the photometric effects on or off. With them on, whether a face is foil is
            # decided on the card's own stream, by its kind.
            foil = bool(not p["back"] and rng.random() < FOIL_PLAIN)
            foiled = add_foil(rng, card) if foil else None
            if photo is None:
                if foil:
                    card = foiled
            else:
                foil = bool(not p["back"] and prng.random() < P.foil_probability(card_kind, photo))
                if foil:
                    card = foiled if foiled is not None else add_foil(prng, card)
            inner_w = src.width if not sleeve else (card.width - 2 * max(1, int(round(sleeve_card_px))))
            wt_out = wt_card * card.width / inner_w
            ht_out = wt_out * card.height / card.width
            A = unit_to_table(p["q"], wt_out, ht_out, p["theta"])
            if rng.random() < 0.15:
                blur = rng.uniform(0.4, 1.4)
            if photo is not None:
                sd = P.defocus_sigma(prng, photo)
                if sd:
                    blur = math.sqrt(blur ** 2 + sd ** 2)
                    plog["defocus"] = round(sd, 3)
                rec["photo"] = plog
            rec.update({"cardId": cid, "source": sub, "sleeve": sleeve, "foil": foil, "role": p.get("role")})
            if p.get("side"):
                rec["side"] = p["side"]
            src_img = card
        elif kind == "distractor":
            patch, sub = T.distractor_patch(rng, 64, aspect)
            wt = p["wt"]
            ht = wt * patch.height / patch.width
            A = unit_to_table(p["q"], wt, ht, p["theta"])
            rec.update({"kind": "distractor", "source": sub})
            src_img = patch
        else:
            patch, sub = T.die_patch(rng, int(np.clip(p["wt"] * local_scale(Hs, p["q"]) * 1.5, 12, 160)))
            A = unit_to_table(p["q"], p["wt"], p["wt"], p["theta"])
            rec.update({"kind": "die", "source": sub})
            if p.get("role"):
                rec["role"] = p["role"]
            src_img = patch
            shadow = True
        Hunit = Hs @ A
        Hunit /= Hunit[2, 2]
        M = Hunit @ np.diag([1.0 / src_img.width, 1.0 / src_img.height, 1.0])
        corners = apply_h(Hunit, [(0, 0), (1, 0), (1, 1), (0, 1)])
        cv.paste_warped(rng, src_img, M, obj_id, shadow=shadow, feather=feather, blur=blur)
        rec.update({"corners": corners.round(2).tolist(), "H": Hunit.round(6).tolist(),
                    "angle": round(image_angle(corners), 2), "tableAngle": round(float(p["theta"]) % 360, 2),
                    "area": float(poly_area(corners))})
        objects.append(rec)
    # --- hands: on top, unwarped, most of them reaching for an object
    n_hands = 0
    if rng.random() < (0.45 if probe else 0.3):
        n_hands = int(rng.integers(1, 3))
    for k in range(n_hands):
        size = float(np.clip(ref * local_scale(Hs, np.zeros(2)) * rng.uniform(1.2, 2.2), 30, 520))
        hp = T.hand_patch(rng, size)
        edge = int(rng.integers(0, 4))
        ang = {0: 0, 1: 90, 2: 180, 3: 270}[edge] + rng.uniform(-35, 35)  # 0: the forearm leaves by the bottom edge
        hp = hp.rotate(ang, expand=True, resample=Image.BICUBIC)
        tgt = np.array([rng.uniform(0.1, 0.9) * W, rng.uniform(0.1, 0.9) * H])
        if objects and rng.random() < 0.7:
            o = objects[int(rng.integers(0, len(objects)))]
            tgt = np.mean(o["corners"], 0)
        # Place the patch so that the fingertips land near the target and the arm runs off-frame.
        d = rot2(-ang) @ np.array([0, -hp.height * 0.3])
        cxy = tgt - d * 1.0
        x, y = int(cxy[0] - hp.width / 2), int(cxy[1] - hp.height / 2)
        hid = len(objects) + 1
        cv.paste_flat(hp, x, y, hid)
        corners = np.array([(x, y), (x + hp.width, y), (x + hp.width, y + hp.height), (x, y + hp.height)], float)
        objects.append({"id": hid, "kind": "hand", "source": "generated-hand", "corners": corners.tolist(),
                        "H": None, "angle": round(ang % 360, 2), "tableAngle": None,
                        "area": float(np.asarray(hp.getchannel("A")).astype(bool).sum())})
    # --- light and glare
    img = cv.img
    light = {"gain": 1.0}
    if rng.random() < 0.6:
        g = T.gradient(W // 8, H // 8, rng.uniform(0, 6.28), rng.uniform(0.3, 0.7))
        fld = 0.75 + 0.5 * g * rng.uniform(0.2, 1.0)
        fld = np.asarray(Image.fromarray(fld.astype(np.float32), "F").resize((W, H), Image.BILINEAR))
        img *= fld[..., None]
        light["gradient"] = True
    glare = []
    if rng.random() < 0.3:
        small = np.zeros((H // 8, W // 8), np.float32)
        yy, xx = np.mgrid[0:H // 8, 0:W // 8].astype(np.float32)
        for _ in range(int(rng.integers(1, 4))):
            cx, cy = rng.uniform(0, W // 8), rng.uniform(0, H // 8)
            sx, sy = rng.uniform(0.02, 0.2) * W / 8, rng.uniform(0.02, 0.12) * W / 8
            th = rng.uniform(0, math.pi)
            u = (xx - cx) * math.cos(th) + (yy - cy) * math.sin(th)
            v = -(xx - cx) * math.sin(th) + (yy - cy) * math.cos(th)
            s = rng.uniform(0.15, 0.8)
            small += s * np.exp(-(u / sx) ** 2 - (v / sy) ** 2)
            glare.append(round(float(s), 3))
        gl = np.asarray(Image.fromarray(small, "F").resize((W, H), Image.BILINEAR))
        tint = np.array([1.0, rng.uniform(0.95, 1.0), rng.uniform(0.85, 1.0)], np.float32)
        img += gl[..., None] * tint
    img = np.clip(img, 0, 1)
    if photo is not None:
        img, light["exposure"] = P.exposure(stream(seed, split, index, STREAM_EXPOSURE), img, photo)
    # --- broadcast graphics
    ids = cv.ids
    broadcast = None
    if cfg.boards and cfg.fill_frame and mode == "board" and not probe:
        # the arrangement and the window scale were drawn before the layout
        if preset is not None:
            img, ids, objects, broadcast = G.compose(grng, img, ids, objects, W, H, inset_fn=pool.inset_art,
                                                     probe=probe, preset=preset, card_aspect=aspect)
    elif cfg.boards:
        grng = stream(seed, split, index, STREAM_BROADCAST)
        if grng.random() < BROADCAST_SHARE[split]:
            img, ids, objects, broadcast = G.compose(grng, img, ids, objects, W, H, inset_fn=pool.inset_art,
                                                     probe=probe, card_aspect=aspect)
    # --- degradation
    deg = {}
    gains = rng.uniform(0.9, 1.1, 3)
    gamma = rng.uniform(0.8, 1.25)
    sat = rng.uniform(0.6, 1.3)
    contrast = rng.uniform(0.8, 1.2)
    img = np.clip(img * gains, 0, 1) ** gamma
    lum = img.mean(2, keepdims=True)
    img = np.clip(lum + (img - lum) * sat, 0, 1)
    img = np.clip(0.5 + (img - 0.5) * contrast + rng.uniform(-0.06, 0.06), 0, 1)
    deg.update({"gains": gains.round(3).tolist(), "gamma": round(gamma, 3), "sat": round(sat, 3),
                "contrast": round(contrast, 3)})
    pil = Image.fromarray((img * 255 + 0.5).astype(np.uint8))
    if rng.random() < 0.6:
        f = rng.uniform(0.35, 0.9)
        pil = pil.resize((max(8, int(W * f)), max(8, int(H * f))), Image.BILINEAR).resize((W, H), Image.BICUBIC)
        deg["rescale"] = round(f, 3)
    r = rng.random()
    if r < 0.3:
        b = rng.uniform(0.3, 1.8)
        pil = pil.filter(ImageFilter.GaussianBlur(b))
        deg["blur"] = round(b, 2)
    elif r < 0.42:  # motion blur: the mean of shifted copies
        L = int(rng.integers(3, 9))
        th = rng.uniform(0, math.pi)
        a = np.asarray(pil, np.float32)
        acc = np.zeros_like(a)
        for k in range(L):
            dx, dy = int(round((k - L / 2) * math.cos(th))), int(round((k - L / 2) * math.sin(th)))
            acc += np.roll(np.roll(a, dy, 0), dx, 1)
        pil = Image.fromarray((acc / L).astype(np.uint8))
        deg["motion"] = L
    if rng.random() < 0.6:
        sd = rng.uniform(1, 8)
        a = (np.asarray(pil, np.float32) + rng.normal(0, sd, (H, W, 1)).astype(np.float32)
             + rng.normal(0, sd * 0.4, (H, W, 3)).astype(np.float32))
        pil = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
        deg["noise"] = round(sd, 2)
    q = int(rng.integers(40, 91))
    deg["jpeg"] = q
    buf = io.BytesIO()
    pil.save(buf, format="JPEG", quality=q)
    # --- labels
    labels = label_objects(objects, ids, W, H)
    background = {"family": family, "license": "generated (procedural, no source image)"}
    if bg_src:
        background = {"family": family, "source": bg_src["source"], "assetId": bg_src["assetId"]}
        background.update({key: bg_src[key] for key in ("page", "license", "licenseUrl", "sha256") if key in bg_src})
    record = {
        "split": split, "index": index, "seed": seed, "file": f"images/{index:05d}.jpg", "width": W, "height": H,
        "background": background,
        "camera": {"tilt": round(tilt, 2), "dir": round(tdir, 2), "focal": round(focal, 1), "H": Hs.round(6).tolist()},
        "layout": mode if not probe else "probe", "board": board_info, "broadcast": broadcast,
        "photometric": photo["name"] if photo else None,
        "light": light, "glare": glare, "degrade": deg, "objects": labels,
    }
    return record, buf.getvalue()
