# SPDX-License-Identifier: Apache-2.0
"""Make a small folder of made-up data to try the labeler on: a toy card game of twelve silly
cards, ten frames of two "videos" of a game being played with them, and the files the server takes.

    python3 make_toy_data.py OUT_DIR [--seed 1] [--frames 5]

No real game, footage or card art is involved and nothing is downloaded: every image is drawn
here, with the standard library only, and the same seed always gives the same files.

    OUT_DIR/catalog.json            the toy game's cards (the --catalog file)
    OUT_DIR/art/<id>.png              one image per card (the --art folder)
    OUT_DIR/frames/<video>/f00001.png ...   the frames to label
    OUT_DIR/sample.json               which frames to label (the --sample file)
    OUT_DIR/prefill.jsonl             a pretend model's boxes and names for those frames (--prefill)
    OUT_DIR/decklists/<video>.txt     the cards in play in each video
    OUT_DIR/truth.json                the right answers: every box a careful labeler would draw.
                                      Not a label file: neither the tool nor the export reads it.

A card face has its name in a banner along its own top edge, so you can see which way up it lies;
a card back is striped, with an emblem and no name. From frame to frame the cards are played,
moved, turned sideways and taken away, as in a real game. Each table has a face-down card, a
card turned sideways, a tilted one, a card cut by the frame's edge, a card partly covered by
another and one so covered that it gets an ignore box. The pretend model is deliberately
imperfect: its boxes are a few pixels off and one is well off, it never finds card backs, it
misses a card, puts a card's top on the wrong side, boxes something that is not a card, boxes
a hidden card as if it were whole, and sometimes names the wrong card.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import struct
import sys
import zlib
from pathlib import Path

sys.dont_write_bytecode = True

FRAME_W, FRAME_H = 960, 540
CARD_W, CARD_H = 63, 88  # the standard card shape, in millimeters
ART_SCALE = 4  # card images are drawn at four pixels a millimeter

COLORS = {
    "Amber": (232, 163, 23), "Azure": (38, 132, 214), "Coral": (240, 108, 92),
    "Jade": (46, 160, 110), "Plum": (126, 62, 150), "Slate": (92, 104, 122),
}

# (id, name, kind, printingOf): ten cards, one alternate printing, a landscape kind and a token.
# The two "Sock Thief" cards are different cards that share a name.
CARDS = [
    ("TOY-001", "Sir Wobbleton", "unit", None), ("TOY-002", "Grumbly Teapot", "unit", None),
    ("TOY-003", "Polite Dragon", "unit", None), ("TOY-004", "Sock Thief", "unit", None),
    ("TOY-005", "Sock Thief", "unit", None), ("TOY-006", "Nap Attack", "spell", None),
    ("TOY-007", "Sudden Picnic", "spell", None), ("TOY-008", "Mild Peril", "spell", None),
    ("TOY-009", "Overdue Library", "site", None), ("TOY-010", "Comfy Campfire", "site", None),
    ("TOY-011", "Long Sermon", "spell", None),
    ("TOY-003A", "Polite Dragon", "unit", "TOY-003"),
    ("TOY-T01", "Pocket Pebble", "token", None),
]
# id: (color, motif, cost, power, rules text). No cost on a site or a token; power on units.
LOOKS = {
    "TOY-001": ("Amber", "Circle", 2, 2, "Wobbles bravely."),
    "TOY-002": ("Azure", "Square", 3, 3, "Steams at you."),
    "TOY-003": ("Coral", "Triangle", 5, 4, "Roars politely."),
    "TOY-004": ("Jade", "Diamond", 1, 1, "Takes left socks."),
    "TOY-005": ("Plum", "Diamond", 2, 2, "Takes right socks."),  # the same creature as TOY-004: one name, two cards
    "TOY-006": ("Slate", "Circle", 1, None, "All units nap."),
    "TOY-007": ("Amber", "Square", 2, None, "Draw a sandwich."),
    "TOY-008": ("Azure", "Triangle", 0, None, "A bit scary."),
    "TOY-009": ("Coral", "Diamond", None, None, "Shhh. Return a card."),
    "TOY-010": ("Jade", "Campfire", None, None, "Stay a while and listen."),
    "TOY-011": ("Plum", "Ring", 3, None, "Wololo."),
    "TOY-003A": ("Coral", "Triangle", 5, 4, "Roars politely."),
    "TOY-T01": ("Plum", "Square", None, 1, "It is a pebble."),
}
KINDS = {"landscape": ["site"]}

INK = (34, 30, 40)
CREAM = (250, 243, 222)
PARCHMENT = (238, 229, 204)
GOLD = (222, 182, 76)
SLEEVE, SLEEVE_STRIPE = (46, 42, 104), (64, 60, 134)  # the card back: the same for every card
CORNER_MM = 3.2
FINE = 4  # a tilted card is drawn FINE times larger and averaged down: FINE x FINE points a pixel


# ---- a tiny RGB canvas and a PNG writer ---------------------------------------------------------

class Canvas:
    def __init__(self, width: int, height: int, color=(0, 0, 0)):
        self.w, self.h = width, height
        self.px = bytearray(bytes(color) * (width * height))
        self.clip = (0, 0, width, height)  # x0, y0, x1, y1: nothing is drawn outside it

    def span(self, y: int, x0: float, x1: float, color) -> None:
        """Fill the pixels of row y whose centers lie between x0 and x1."""
        cx0, cy0, cx1, cy1 = self.clip
        if not cy0 <= y < cy1:
            return
        a, b = max(cx0, int(math.ceil(x0 - 0.5))), min(cx1, int(math.floor(x1 - 0.5)) + 1)
        if b > a:
            self.px[(y * self.w + a) * 3:(y * self.w + b) * 3] = bytes(color) * (b - a)

    def rows(self, y0: float, y1: float):
        """The rows whose centers lie between y0 and y1, inside the canvas."""
        return range(max(0, int(math.ceil(y0 - 0.5))), min(self.h, int(math.floor(y1 - 0.5)) + 1))

    def polygon(self, points, color) -> None:
        """Fill a polygon (any orientation), one scan line at a time."""
        ys = [p[1] for p in points]
        for y in range(max(0, int(math.floor(min(ys)))), min(self.h, int(math.ceil(max(ys))) + 1)):
            yc = y + 0.5
            xs = []
            for i, (x0, y0) in enumerate(points):
                x1, y1 = points[(i + 1) % len(points)]
                if (y0 <= yc < y1) or (y1 <= yc < y0):
                    xs.append(x0 + (yc - y0) * (x1 - x0) / (y1 - y0))
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                self.span(y, xs[k], xs[k + 1], color)

    def rrect(self, x0, y0, x1, y1, r, color) -> None:
        """A rectangle with rounded corners of radius r."""
        for y in self.rows(y0, y1):
            self.span(y, *rrect_span(x0, y0, x1, y1, r, y + 0.5), color)

    def circle(self, cx, cy, r, color) -> None:
        for y in self.rows(cy - r, cy + r):
            d = r * r - (y + 0.5 - cy) ** 2
            if d >= 0:
                self.span(y, cx - math.sqrt(d), cx + math.sqrt(d), color)

    def png(self) -> bytes:
        raw = b"".join(b"\x00" + bytes(self.px[y * self.w * 3:(y + 1) * self.w * 3]) for y in range(self.h))

        def chunk(tag: bytes, data: bytes) -> bytes:
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        header = struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0)  # 8-bit RGB
        return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


def rrect_span(x0, y0, x1, y1, r, yc):
    """The left and right ends, at height yc, of a rectangle with rounded corners."""
    t = max(y0 + r - yc, yc - (y1 - r), 0.0)
    inset = r - math.sqrt(max(0.0, r * r - t * t)) if t > 0 else 0.0
    return x0 + inset, x1 - inset


def shade(color, factor: float):
    return tuple(max(0, min(255, round(c * factor))) for c in color)


def mix(a, b, t: float):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


# ---- a small bitmap font: capitals, digits and a little punctuation, five by seven -------------

_GLYPHS = {
    "A": "01110 10001 10001 11111 10001 10001 10001", "B": "11110 10001 10001 11110 10001 10001 11110",
    "C": "01110 10001 10000 10000 10000 10001 01110", "D": "11110 10001 10001 10001 10001 10001 11110",
    "E": "11111 10000 10000 11110 10000 10000 11111", "F": "11111 10000 10000 11110 10000 10000 10000",
    "G": "01110 10001 10000 10111 10001 10001 01111", "H": "10001 10001 10001 11111 10001 10001 10001",
    "I": "111 010 010 010 010 010 111", "J": "00111 00010 00010 00010 00010 10010 01100",
    "K": "10001 10010 10100 11000 10100 10010 10001", "L": "10000 10000 10000 10000 10000 10000 11111",
    "M": "10001 11011 10101 10101 10001 10001 10001", "N": "10001 11001 10101 10011 10001 10001 10001",
    "O": "01110 10001 10001 10001 10001 10001 01110", "P": "11110 10001 10001 11110 10000 10000 10000",
    "Q": "01110 10001 10001 10001 10101 10010 01101", "R": "11110 10001 10001 11110 10100 10010 10001",
    "S": "01111 10000 10000 01110 00001 00001 11110", "T": "11111 00100 00100 00100 00100 00100 00100",
    "U": "10001 10001 10001 10001 10001 10001 01110", "V": "10001 10001 10001 01010 01010 01010 00100",
    "W": "10001 10001 10001 10101 10101 10101 01010", "X": "10001 10001 01010 00100 01010 10001 10001",
    "Y": "10001 10001 01010 00100 00100 00100 00100", "Z": "11111 00001 00010 00100 01000 10000 11111",
    "0": "01110 10001 10011 10101 11001 10001 01110", "1": "010 110 010 010 010 010 111",
    "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11110 00001 00001 01110 00001 00001 11110",
    "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00010 01100",
    " ": "000 000 000 000 000 000 000", ".": "00 00 00 00 00 11 11", ",": "00 00 00 00 11 01 10",
    "!": "1 1 1 1 1 0 1", "?": "01110 10001 00001 00010 00100 00000 00100", "'": "1 1 0 0 0 0 0",
    "-": "0000 0000 0000 1111 0000 0000 0000", ":": "0 1 1 0 1 1 0",
}
FONT = {ch: (len(rows.split()[0]), [int(r, 2) for r in rows.split()]) for ch, rows in _GLYPHS.items()}


def text_width(text: str, size: int) -> int:
    """The width in pixels of `text` at `size` pixels a font dot: one blank dot between glyphs."""
    return max(0, sum((FONT[ch][0] + 1) * size for ch in text.upper()) - size)


def draw_text(canvas: Canvas, text: str, x: float, y: float, size: int, color) -> None:
    """Write `text` with its top-left at (x, y), each font dot `size` pixels square."""
    x, y = int(round(x)), int(round(y))
    for ch in text.upper():
        width, rows = FONT[ch]
        for r, bits in enumerate(rows):
            col = 0
            while col < width:
                if bits >> (width - 1 - col) & 1:
                    end = col
                    while end + 1 < width and bits >> (width - 2 - end) & 1:
                        end += 1
                    for dy in range(size):
                        canvas.span(y + r * size + dy, x + col * size, x + (end + 1) * size, color)
                    col = end + 1
                else:
                    col += 1
        x += (width + 1) * size


def wrap(text: str, width: float, size: int) -> list:
    """`text` cut into lines no wider than `width` (a word longer than a line stays whole)."""
    lines = []
    for word in text.split():
        if lines and text_width(lines[-1] + " " + word, size) <= width:
            lines[-1] += " " + word
        else:
            lines.append(word)
    return lines


# ---- a card as a picture: a sprite with rounded corners, drawn upright ---------------------------

class Sprite(Canvas):
    """A card drawn upright, and for each row the run of pixels that are card (its corners are
    rounded: what lies outside them is the table)."""

    def __init__(self, width: int, height: int, radius: float, color=(0, 0, 0)):
        super().__init__(width, height, color)
        self.radius = radius
        self.runs = []
        for y in range(height):
            a, b = rrect_span(0, 0, width, height, radius, y + 0.5)
            self.runs.append((max(0, int(math.ceil(a - 0.5))), min(width, int(math.floor(b - 0.5)) + 1)))

    def turned(self, quarters: int) -> "Sprite":
        """The sprite turned `quarters` quarter turns clockwise (kept: a card is turned often)."""
        quarters %= 4
        if quarters == 0:
            return self
        cache = self.__dict__.setdefault("_turned", {})
        if quarters not in cache:
            w, h, px = self.w, self.h, self.px
            if quarters == 2:
                out, back = Sprite(w, h, self.radius), px[::-1]  # every pixel backwards, its channels too
                for c in range(3):
                    out.px[c::3] = back[2 - c::3]
            else:
                out = Sprite(h, w, self.radius)
                rows = []
                for x in range(w):  # a quarter turn clockwise: the new row x is the old column x, from the bottom up
                    row = bytearray(3 * h)
                    for c in range(3):
                        column = px[x * 3 + c::w * 3]
                        row[c::3] = column[::-1] if quarters == 1 else column
                    rows.append(row)
                if quarters == 3:
                    rows.reverse()
                out.px = bytearray(b"".join(rows))
            cache[quarters] = out
        return cache[quarters]


def card_size(landscape: bool, scale: float) -> tuple:
    """A card's own width and height in whole pixels at `scale` pixels a millimeter."""
    w, h = round(CARD_W * scale), round(CARD_H * scale)
    return (h, w) if landscape else (w, h)


def face_sprite(card_id: str, scale: float) -> Sprite:
    """A card face as a trading card: a rounded border in the card's color, its name in a banner
    along its top, a picture, a cost gem, a type line and a line of rules text."""
    name = next(n for i, n, _k, _o in CARDS if i == card_id)
    kind = next(k for i, _n, k, _o in CARDS if i == card_id)
    alt = next(o for i, _n, _k, o in CARDS if i == card_id) is not None
    color_name, motif, cost, power, rules = LOOKS[card_id]
    color = COLORS[color_name]
    landscape = kind in KINDS["landscape"]
    w, h = card_size(landscape, scale)
    s = Sprite(w, h, CORNER_MM * scale)
    mm = lambda v: v * scale  # noqa: E731
    size = max(1, int(scale / 1.6))  # font dots: one pixel at the frames' scale
    border = GOLD if alt else color
    s.rrect(0, 0, w, h, mm(CORNER_MM), shade(border, 0.62))
    s.rrect(mm(0.9), mm(0.9), w - mm(0.9), h - mm(0.9), mm(CORNER_MM - 0.9), border)
    # the name banner
    top, bottom = 3.4, 12.6
    s.rrect(mm(3.0), mm(top - 0.4), w - mm(3.0), mm(bottom + 0.4), mm(1.6), shade(border, 0.45))
    s.rrect(mm(3.4), mm(top), w - mm(3.4), mm(bottom), mm(1.3), (226, 228, 232) if kind == "token" else CREAM)
    tw = text_width(name, size)
    draw_text(s, name, (w - tw) / 2, mm((top + bottom) / 2) - 3.5 * size, size, INK)
    # the picture, the type line and the rules text
    art_bottom = 42.5 if landscape else 50.5
    type_top, type_bottom = art_bottom + 1.2, art_bottom + 7.4
    s.rrect(mm(3.0), mm(13.6), w - mm(3.0), mm(art_bottom + 0.4), mm(0.8), shade(border, 0.45))
    draw_picture(s, card_id, kind, motif, color, alt, (mm(3.4), mm(14.0), w - mm(3.4), mm(art_bottom)), scale)
    s.rrect(mm(3.4), mm(type_top), w - mm(3.4), mm(type_bottom), mm(0.8), mix(border, (255, 255, 255), 0.55))
    draw_text(s, kind, mm(5.2), mm((type_top + type_bottom) / 2) - 3.5 * size, size, INK)
    if alt:  # an alternate printing: a star in its type line
        star(s, w - mm(7.5), mm((type_top + type_bottom) / 2), mm(2.6), shade(GOLD, 0.7))
    s.rrect(mm(3.4), mm(type_bottom + 1.2), w - mm(3.4), h - mm(3.4), mm(1.3), PARCHMENT)
    lines = wrap(rules, w - mm(9), size)
    box_mid = (mm(type_bottom + 1.2) + h - mm(3.4)) / 2
    line_h = 10 * size
    for n, line in enumerate(lines):
        y = box_mid - (len(lines) * line_h - 3 * size) / 2 + n * line_h
        draw_text(s, line, (w - text_width(line, size)) / 2, y, size, INK)
    if cost is not None:  # the cost gem, on the picture's top-left corner
        gem(s, mm(8.4), mm(18.6), mm(4.4), (36, 40, 64), str(cost), size)
    if power is not None:  # the power, at the bottom right
        gem(s, w - mm(6.6), h - mm(6.6), mm(4.0), shade(color, 0.55), str(power), size)
    return s


def gem(s: Canvas, cx, cy, r, color, digit: str, size: int) -> None:
    s.circle(cx, cy, r, (250, 250, 250))
    s.circle(cx, cy, r * 0.84, color)
    draw_text(s, digit, cx - text_width(digit, size) / 2, cy - 3.5 * size, size, (255, 255, 255))


def star(s: Canvas, cx, cy, r, color, points: int = 5) -> None:
    pts = []
    for k in range(points * 2):
        a = math.pi * k / points - math.pi / 2
        rr = r if k % 2 == 0 else r * 0.45
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    s.polygon(pts, color)


def shape_points(motif: str, cx, cy, r) -> list:
    """The motif's outline (a polygon) centered at (cx, cy), about r across from the middle."""
    if motif in ("Circle", "Ring"):
        return [(cx + r * math.cos(2 * math.pi * k / 40), cy + r * math.sin(2 * math.pi * k / 40)) for k in range(40)]
    if motif == "Square":
        q = r * 0.88
        return [(cx - q, cy - q), (cx + q, cy - q), (cx + q, cy + q), (cx - q, cy + q)]
    if motif == "Triangle":
        return [(cx, cy - r * 1.15), (cx + r * 1.12, cy + r * 0.85), (cx - r * 1.12, cy + r * 0.85)]
    return [(cx, cy - r * 1.2), (cx + r, cy), (cx, cy + r * 1.2), (cx - r, cy)]  # Diamond


def draw_shape(s: Canvas, motif: str, cx, cy, r, color, hole, outline: float) -> None:
    """The motif filled with `color`, with a dark outline `outline` pixels wide; a ring gets a
    hole of the color `hole`."""
    s.polygon(shape_points(motif, cx, cy, r + outline), shade(color, 0.45))
    s.polygon(shape_points(motif, cx, cy, r), color)
    if motif == "Ring":
        s.circle(cx, cy + r * 0.28, r * 0.36 + outline, shade(color, 0.45))
        s.circle(cx, cy + r * 0.28, r * 0.36, hole)


def draw_picture(s: Canvas, card_id: str, kind: str, motif: str, color, alt: bool, box, scale: float) -> None:
    """The card's picture inside `box` (x0, y0, x1, y1): a little creature for a unit or a token,
    a spell's shape among sparkles, a site's house on a hill."""
    x0, y0, x1, y1 = box
    ww, wh = x1 - x0, y1 - y0
    rng = random.Random(f"picture:{card_id}")
    s.clip = (int(math.ceil(x0 - 0.5)), int(math.ceil(y0 - 0.5)), int(math.floor(x1 - 0.5)) + 1, int(math.floor(y1 - 0.5)) + 1)
    sky = (32, 38, 84) if alt else mix(color, (255, 255, 255), 0.78) if kind != "spell" else mix(color, (36, 32, 72), 0.62)
    s.rrect(x0, y0, x1, y1, 0, sky)
    s.rrect(x0, y0 + wh * 0.32, x1, y1, 0, mix(sky, (255, 255, 255) if not alt else (60, 70, 130), 0.25))
    if alt:  # a night sky: stars
        for _ in range(14):
            sx, sy = x0 + rng.uniform(0.05, 0.95) * ww, y0 + rng.uniform(0.05, 0.55) * wh
            star(s, sx, sy, max(1.2, scale * rng.uniform(0.6, 1.2)), (250, 240, 190), 4)
    line = max(1.0, scale * 0.45)
    if kind == "site" and motif == "Campfire":
        draw_campfire(s, card_id, color, box, scale)
    elif kind == "site":
        sun = mix(color, (255, 236, 160), 0.4)
        s.circle(x0 + ww * 0.82, y0 + wh * 0.26, wh * 0.14, sun)
        for hx, hr, tone in ((0.2, 0.55, 0.85), (0.75, 0.62, 0.7), (0.45, 0.5, 1.0)):
            s.circle(x0 + ww * hx, y1 + wh * hr * 0.55, wh * hr, shade(mix(color, (70, 140, 70), 0.6), tone))
        cx, cy, r = x0 + ww * 0.45, y0 + wh * 0.5, wh * 0.2
        draw_shape(s, motif, cx, cy, r, color, sky, line)
        s.rrect(cx - r * 0.18, cy + r * 0.3, cx + r * 0.18, cy + r * 0.85, r * 0.15, shade(color, 0.35))  # a door
    elif kind == "spell":
        cx, cy, r = x0 + ww / 2, y0 + wh * 0.52, wh * 0.26
        for _ in range(7):
            a, d = rng.uniform(0, 2 * math.pi), rng.uniform(1.25, 1.75) * r
            star(s, cx + d * math.cos(a) * 1.3, cy + d * math.sin(a), rng.uniform(0.12, 0.2) * r, (255, 255, 255), 4)
        draw_shape(s, motif, cx, cy, r, color, sky, line)
        draw_shape(s, motif, cx - r * 0.12, cy - r * 0.12, r * 0.45, mix(color, (255, 255, 255), 0.45), sky, 0)
    else:  # a unit or a token: a creature with eyes and a grin, standing on the ground
        ground = y0 + wh * 0.78
        s.rrect(x0, ground, x1, y1, 0, shade(mix(color, (96, 150, 80), 0.55), 0.9 if not alt else 0.6))
        r = wh * (0.24 if kind == "token" else 0.3)
        cx, cy = x0 + ww / 2, ground - r * (0.85 if motif != "Diamond" else 1.0)
        s.polygon([(cx + r * 1.1 * math.cos(2 * math.pi * k / 24), ground + r * 0.16 * math.sin(2 * math.pi * k / 24)) for k in range(24)],
                  shade(mix(color, (96, 150, 80), 0.55), 0.6))  # its shadow
        draw_shape(s, motif, cx, cy, r, color, sky if not alt else (32, 38, 84), line)
        eye_y = cy - r * (0.05 if motif == "Triangle" else 0.32)
        look = (rng.uniform(-0.5, 0.5), rng.uniform(-0.4, 0.4))
        for side in (-1, 1):
            ex = cx + side * r * 0.36
            s.circle(ex, eye_y, r * 0.24, (255, 255, 255))
            s.circle(ex + look[0] * r * 0.12, eye_y + look[1] * r * 0.12, r * 0.12, INK)
        my = eye_y + r * 0.34
        if motif != "Ring":  # a ring's hole is its open mouth
            s.polygon([(cx + r * 0.22 * math.cos(math.pi * k / 10), my + r * 0.2 * math.sin(math.pi * k / 10)) for k in range(11)], INK)
    s.clip = (0, 0, s.w, s.h)


def flame(cx, base, w, h, lean=0.0) -> list:
    """A flame's outline: round at the bottom (base is its lowest point), narrowing to a tip h
    above, leaning by `lean` pixels."""
    r = w / 2
    cy = base - r
    pts = [(cx + r * math.cos(math.pi * k / 12), cy + r * math.sin(math.pi * k / 12)) for k in range(13)]  # the bottom
    tip = (cx + lean, base - h)
    for k in range(1, 9):  # the left side curves in to the tip
        t = k / 9
        pts.append(((1 - t) ** 2 * (cx - r) + 2 * (1 - t) * t * (cx - r * 0.75 + lean * 0.3) + t * t * tip[0],
                    (1 - t) ** 2 * cy + 2 * (1 - t) * t * (cy - (h - r) * 0.55) + t * t * tip[1]))
    pts.append(tip)
    for k in range(8, 0, -1):  # the right side, back down
        t = k / 9
        pts.append(((1 - t) ** 2 * (cx + r) + 2 * (1 - t) * t * (cx + r * 0.75 + lean * 0.3) + t * t * tip[0],
                    (1 - t) ** 2 * cy + 2 * (1 - t) * t * (cy - (h - r) * 0.55) + t * t * tip[1]))
    return pts


def log_points(cx, cy, length, thick, deg) -> list:
    a = math.radians(deg)
    ux, uy, vx, vy = math.cos(a) * length / 2, math.sin(a) * length / 2, -math.sin(a) * thick / 2, math.cos(a) * thick / 2
    return [(cx - ux - vx, cy - uy - vy), (cx + ux - vx, cy + uy - vy), (cx + ux + vx, cy + uy + vy), (cx - ux + vx, cy - uy + vy)]


def draw_campfire(s: Canvas, card_id: str, color, box, scale: float) -> None:
    """A campfire at dusk: crossed logs in a ring of stones, three layers of flame, sparks rising,
    the card's color in the hills behind."""
    x0, y0, x1, y1 = box
    ww, wh = x1 - x0, y1 - y0
    rng = random.Random(f"campfire:{card_id}")
    night = mix(color, (24, 22, 58), 0.78)
    s.rrect(x0, y0, x1, y1, 0, night)
    for _ in range(9):  # the first stars
        star(s, x0 + rng.uniform(0.04, 0.96) * ww, y0 + rng.uniform(0.06, 0.4) * wh, max(1.0, scale * rng.uniform(0.4, 0.8)), (236, 232, 200), 4)
    for hx, hr, tone in ((0.15, 0.6, 0.55), (0.85, 0.66, 0.45), (0.5, 0.52, 0.65)):
        s.circle(x0 + ww * hx, y1 + wh * hr * 0.62, wh * hr, shade(mix(color, night, 0.45), tone))
    cx, ground = x0 + ww * 0.5, y0 + wh * 0.84
    fire = (255, 150, 60)
    glow = (255, 118, 40)
    for r, t in ((0.5, 0.9), (0.38, 0.82), (0.27, 0.72)):  # the glow, warmer toward the fire
        s.circle(cx, ground - wh * 0.16, wh * r, mix(glow, night, t))
    for k in range(7):  # a ring of stones
        a = math.pi * (0.08 + 0.84 * k / 6)
        s.circle(cx - math.cos(a) * ww * 0.15, ground + math.sin(a) * wh * 0.02 - wh * 0.01, wh * 0.045, shade((150, 146, 140), 0.55 + 0.1 * (k % 2)))
    length, thick = ww * 0.3, wh * 0.075
    for deg in (-16, 16):  # two logs, crossed
        s.polygon(log_points(cx, ground - thick * 0.6, length + thick * 0.4, thick + scale * 0.9, deg), (60, 36, 22))
        s.polygon(log_points(cx, ground - thick * 0.6, length, thick, deg), (128, 82, 46))
        for end in (-1, 1):
            a = math.radians(deg)
            s.circle(cx + end * math.cos(a) * length / 2, ground - thick * 0.6 + end * math.sin(a) * length / 2, thick * 0.42, (214, 170, 112))
    base = ground - thick * 0.9
    s.polygon(flame(cx, base, ww * 0.2, wh * 0.52, -wh * 0.03), (226, 72, 46))   # the outer flame
    s.polygon(flame(cx + ww * 0.01, base, ww * 0.14, wh * 0.38, wh * 0.03), (250, 146, 48))
    s.polygon(flame(cx, base, ww * 0.075, wh * 0.22, 0), (255, 226, 120))   # the heart
    for _ in range(6):  # sparks rising
        s.circle(cx + rng.uniform(-0.12, 0.12) * ww, base - wh * rng.uniform(0.55, 0.8), max(0.8, scale * rng.uniform(0.35, 0.6)), (255, 214, 120))


def back_sprite(scale: float) -> Sprite:
    """A card back, the same for every card: a striped sleeve, a gold line and an emblem, and
    nothing written on it."""
    w, h = card_size(False, scale)
    s = Sprite(w, h, CORNER_MM * scale)
    mm = lambda v: v * scale  # noqa: E731
    s.rrect(0, 0, w, h, mm(CORNER_MM), shade(SLEEVE, 0.7))
    s.rrect(mm(0.8), mm(0.8), w - mm(0.8), h - mm(0.8), mm(CORNER_MM - 0.8), SLEEVE)
    s.rrect(mm(3.0), mm(3.0), w - mm(3.0), h - mm(3.0), mm(1.8), GOLD)
    s.rrect(mm(3.8), mm(3.8), w - mm(3.8), h - mm(3.8), mm(1.2), SLEEVE)
    s.clip = (int(math.ceil(mm(3.8))), int(math.ceil(mm(3.8))), w - int(math.ceil(mm(3.8))), h - int(math.ceil(mm(3.8))))
    step = mm(4.6)
    k = -h
    while k < w + h:  # diagonal stripes, clipped to the inside of the gold line
        s.polygon([(k, 0), (k + step / 2, 0), (k + step / 2 + h, h), (k + h, h)], SLEEVE_STRIPE)
        k += step
    s.clip = (0, 0, w, h)
    cx, cy = w / 2, h / 2
    s.circle(cx, cy, mm(13.5), shade(SLEEVE, 0.7))
    s.circle(cx, cy, mm(12.6), GOLD)
    s.circle(cx, cy, mm(11.2), SLEEVE)
    star(s, cx, cy, mm(9.6), GOLD, 8)
    s.circle(cx, cy, mm(2.6), SLEEVE)
    for y in (mm(9.0), h - mm(9.0)):
        s.polygon([(cx, y - mm(2.4)), (cx + mm(2.0), y), (cx, y + mm(2.4)), (cx - mm(2.0), y)], GOLD)
    return s


# ---- putting a card on the table ----------------------------------------------------------------

def card_frame(cx: float, cy: float, w: float, h: float, deg: float):
    """A function mapping a point of the card's own frame (u right, v down, both in [-0.5, 0.5])
    to the canvas, for a card of w x h centered at (cx, cy) and turned `deg` clockwise."""
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)

    def at(u: float, v: float):
        x, y = u * w, v * h
        return (cx + x * c - y * s, cy + x * s + y * c)

    return at


def corners_of(cx, cy, w, h, deg) -> list:
    """The card's own top-left, top-right, bottom-right, bottom-left on the canvas."""
    at = card_frame(cx, cy, w, h, deg)
    return [list(at(u, v)) for u, v in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5))]


def draw_card(canvas: Canvas, sprite: Sprite, cx: float, cy: float, deg: float, fine: "Sprite | None" = None) -> tuple:
    """Put an upright sprite on the canvas, centered near (cx, cy) and turned `deg` clockwise; a
    card turned by whole quarter turns lands on whole pixels, so its writing stays sharp.
    A card turned by any other angle is area-sampled, as a camera would see it: `fine` is the same
    card drawn FINE times larger, and each canvas pixel under the card averages a FINE x FINE grid
    of points of it, so strokes and edges are anti-aliased and the pixels along the card's border
    (its rounded corners too) blend with what is already on the canvas by how much of them is card.
    `sprite` alone fixes the geometry (corners, center); without `fine` it is supersampled itself.
    → (cx, cy) where its center really is."""
    quarters = deg / 90.0
    if abs(quarters - round(quarters)) < 1e-9:
        sp = sprite.turned(int(round(quarters)) % 4)
        x0, y0 = int(round(cx - sp.w / 2)), int(round(cy - sp.h / 2))
        for r in range(max(0, -y0), min(sp.h, canvas.h - y0)):
            a, b = sp.runs[r]
            a, b = max(a, -x0), min(b, canvas.w - x0)
            if b > a:
                y = y0 + r
                canvas.px[(y * canvas.w + x0 + a) * 3:(y * canvas.w + x0 + b) * 3] = sp.px[(r * sp.w + a) * 3:(r * sp.w + b) * 3]
        return x0 + sp.w / 2, y0 + sp.h / 2
    # turned by an angle: every canvas pixel near the card averages a grid of points looked up on it
    rad = math.radians(deg)
    c, s = math.cos(rad), math.sin(rad)
    hw, hh = sprite.w / 2, sprite.h / 2
    quad = corners_of(cx, cy, sprite.w, sprite.h, deg)
    if fine is None:
        fine, n = sprite, 1
    else:
        n = FINE
    fx, fy = fine.w / sprite.w, fine.h / sprite.h  # the fine sprite's pixels per coarse one
    src, dst, fw, fh, runs = fine.px, canvas.px, fine.w, fine.h, fine.runs
    offsets = [((i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5) for j in range(n) for i in range(n)]
    du = [(ox * c + oy * s) * fx for ox, oy in offsets]  # a step across the pixel, in fine sprite pixels
    dv = [(-ox * s + oy * c) * fy for ox, oy in offsets]
    total = n * n
    ys = [q[1] for q in quad]
    for y in range(max(0, int(math.floor(min(ys))) - 1), min(canvas.h, int(math.ceil(max(ys))) + 2)):
        yc = y + 0.5
        xs = []
        for i in range(4):
            (ax, ay), (bx, by) = quad[i], quad[(i + 1) % 4]
            for yy in (yc - 1, yc, yc + 1):  # the pixel's row and its neighbours: edges reach into it
                if (ay <= yy < by) or (by <= yy < ay):
                    xs.append(ax + (yy - ay) * (bx - ax) / (by - ay))
        if len(xs) < 2:
            continue
        xa, xb = max(0, int(math.floor(min(xs)))), min(canvas.w, int(math.ceil(max(xs))) + 1)
        dy = yc - cy
        u = ((xa + 0.5 - cx) * c + dy * s + hw) * fx
        v = (-(xa + 0.5 - cx) * s + dy * c + hh) * fy
        stepu, stepv = c * fx, -s * fy
        row = y * canvas.w
        for x in range(xa, xb):
            r = g = bl = hit = 0
            for k in range(total):
                sx, sy = int(u + du[k] + 1000) - 1000, int(v + dv[k] + 1000) - 1000
                if 0 <= sy < fh:
                    a, b = runs[sy]
                    if a <= sx < b:
                        i = (sy * fw + sx) * 3
                        r += src[i]
                        g += src[i + 1]
                        bl += src[i + 2]
                        hit += 1
            if hit:
                o = (row + x) * 3
                if hit == total:
                    dst[o], dst[o + 1], dst[o + 2] = (r + total // 2) // total, (g + total // 2) // total, (bl + total // 2) // total
                else:  # the rest of the pixel's points are the table
                    rest = total - hit
                    dst[o] = (r + dst[o] * rest + total // 2) // total
                    dst[o + 1] = (g + dst[o + 1] * rest + total // 2) // total
                    dst[o + 2] = (bl + dst[o + 2] * rest + total // 2) // total
            u += stepu
            v += stepv
    return cx, cy


def draw_die(canvas: Canvas, cx: float, cy: float, face: int) -> None:
    """A six-sided die, seen from above: not a card."""
    canvas.rrect(cx - 15, cy - 15, cx + 15, cy + 15, 5, (200, 200, 196))
    canvas.rrect(cx - 14, cy - 14, cx + 14, cy + 14, 4.5, (246, 246, 240))
    pips = {1: [(0, 0)], 2: [(-1, -1), (1, 1)], 3: [(-1, -1), (0, 0), (1, 1)], 4: [(-1, -1), (1, -1), (-1, 1), (1, 1)],
            5: [(-1, -1), (1, -1), (0, 0), (-1, 1), (1, 1)], 6: [(-1, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (1, 1)]}[face]
    for px, py in pips:
        canvas.circle(cx + px * 8, cy + py * 8, 3, (200, 40, 50) if face == 1 else INK)


def draw_bead(canvas: Canvas, cx: float, cy: float, _face: int) -> None:
    """A glass bead counter: not a card."""
    canvas.circle(cx, cy + 2, 15, (24, 30, 50))
    canvas.circle(cx, cy, 14, (196, 48, 64))
    canvas.circle(cx - 4, cy - 5, 4, (246, 170, 176))


PROPS = {"die": draw_die, "bead": draw_bead}


def draw_table(seed: int, mat) -> Canvas:
    """A play mat: cloth with a few faint bands, and a line between the two players' halves."""
    rng = random.Random(f"table:{seed}")
    canvas = Canvas(FRAME_W, FRAME_H, mat)
    for _ in range(6):
        y = rng.randrange(FRAME_H)
        canvas.polygon([(0, y), (FRAME_W, y + rng.randint(-30, 30)), (FRAME_W, y + 26), (0, y + 22)], shade(mat, rng.uniform(0.92, 1.08)))
    line = shade(mat, 1.35)
    canvas.rrect(14, 14, FRAME_W - 14, FRAME_H - 14, 18, line)
    canvas.rrect(16, 16, FRAME_W - 16, FRAME_H - 16, 16, mat)
    canvas.rrect(16, FRAME_H / 2 - 1, FRAME_W - 16, FRAME_H / 2 + 1, 0, line)
    return canvas


# ---- the two tables: what lies where in each frame ----------------------------------------------
#
# Each video is a short game. `cast` names the card each role is played by (None: face down);
# `order` is the stacking order, bottom first; each step is one frame: role -> (x, y, degrees
# clockwise) of the card's center and turn. A role missing from a step is not on the table.
# `model` lists, per frame, the pretend model's deliberate mistakes:
#   miss: roles it does not box (it never boxes a card back either)
#   turn: role -> the quarter turns it says (wrong)
#   off: role -> (dx, dy, dw, dh) added to its box
#   stray: a box on the n-th thing on the table that is not a card (a die, a bead), and the card it names there
#   name: role -> the card it names instead
#   whole: roles hidden enough to get an ignore box, which it boxes whole as a card
# The frame's edge and the cards on top decide the rest (truth.json says what each card is).

SCENES = {
    "table-a": {
        "scale": 1.7, "mat": (34, 62, 52),
        "cast": {"site": "TOY-009", "dragon": "TOY-003A", "wobble": "TOY-001", "thief": "TOY-004", "nap": "TOY-006",
                 "teapot": "TOY-002", "pebble": "TOY-T01", "picnic": "TOY-007", "deck": None},
        "order": ["site", "deck", "dragon", "nap", "teapot", "wobble", "pebble", "thief", "picnic"],
        "props": [("die", 600, 262)],
        "steps": [
            {"site": (52, 270, 0), "dragon": (440, 98, 180), "wobble": (250, 424, 0), "thief": (420, 418, -11),
             "nap": (640, 414, 7), "deck": (884, 424, 0)},
            {"site": (52, 270, 0), "dragon": (440, 98, 180), "wobble": (250, 424, 0), "thief": (428, 414, -11),
             "nap": (640, 414, 7), "deck": (884, 424, 0), "pebble": (190, 318, 14)},
            {"site": (52, 270, 0), "dragon": (440, 98, 180), "wobble": (250, 424, 90), "thief": (462, 268, -6),
             "nap": (640, 414, 7), "teapot": (674, 410, -2), "deck": (884, 424, 0), "pebble": (190, 318, 14)},
            {"site": (52, 270, 0), "dragon": (440, 98, 270), "wobble": (250, 424, 90),
             "nap": (640, 414, 7), "teapot": (674, 410, -2), "deck": (884, 424, 0), "pebble": (190, 318, 14)},
            {"site": (52, 270, 0), "dragon": (440, 98, 180), "wobble": (250, 424, 0), "picnic": (470, 262, 0),
             "nap": (640, 414, 7), "teapot": (674, 410, -2), "deck": (884, 424, 0), "pebble": (190, 318, 14)},
        ],
        "model": [
            {"turn": {"dragon": 0}},
            {"miss": ["pebble"], "stray": (0, "TOY-T01")},
            {"whole": ["nap"], "off": {"teapot": (12, 9, -4, 0)}},
            {"name": {"teapot": "TOY-001"}},
            {"turn": {"picnic": 2}},
        ],
    },
    "table-b": {
        "scale": 1.6, "mat": (34, 50, 82),
        "cast": {"site": "TOY-010", "theirs": "TOY-005", "mine": "TOY-004", "dragon": "TOY-003", "peril": "TOY-008",
                 "pebble": "TOY-T01", "picnic": "TOY-007", "sermon": "TOY-011", "deck": None},
        "order": ["site", "theirs", "deck", "dragon", "picnic", "mine", "pebble", "peril", "sermon"],
        "props": [("bead", 610, 300)],
        "steps": [
            {"site": (800, 104, 180), "theirs": (380, 104, 180), "mine": (330, 420, 0), "dragon": (620, 420, 0),
             "deck": (90, 428, 0)},
            {"site": (800, 104, 180), "theirs": (380, 104, 180), "mine": (330, 420, 0), "dragon": (620, 420, 0),
             "deck": (90, 428, 0), "peril": (480, 584, 4)},
            {"site": (800, 104, 180), "theirs": (380, 104, 180), "mine": (330, 420, 0), "dragon": (620, 420, 0),
             "deck": (90, 428, 0), "peril": (478, 274, -9), "pebble": (430, 432, 15)},
            {"site": (800, 104, 180), "theirs": (380, 104, 270), "mine": (350, 286, 0), "dragon": (620, 420, 0),
             "deck": (90, 428, 0), "pebble": (430, 432, 15), "sermon": (566, 236, 6)},
            {"site": (800, 104, 180), "theirs": (380, 104, 270), "mine": (350, 286, 0), "dragon": (620, 420, 0),
             "deck": (90, 428, 0), "pebble": (430, 432, 15), "picnic": (648, 410, 3)},
        ],
        "model": [
            {"name": {"mine": "TOY-005"}},
            {"whole": ["peril"], "stray": (0, "TOY-T01")},
            {"miss": ["pebble"]},
            {"turn": {"theirs": 2}},
            {"whole": ["dragon"], "off": {"picnic": (-10, 8, 6, -6)}},
        ],
    },
}
VIDEOS = tuple(SCENES)


def scene_cards(video: str, seed: int, k: int) -> list:
    """The cards of frame k (0-based) of a video, bottom first: each where the game has put it,
    moved a few pixels by the seed. Frames past the last step keep its table, the cards nudged."""
    scene = SCENES[video]
    step = scene["steps"][min(k, len(scene["steps"]) - 1)]
    out = []
    for role in scene["order"]:
        if role not in step:
            continue
        rng = random.Random(f"place:{seed}:{video}:{role}")
        cx, cy, deg = step[role]
        cx, cy = cx + rng.uniform(-4, 4), cy + rng.uniform(-4, 4)
        if deg % 90:
            deg += rng.uniform(-1.5, 1.5)
        if k >= len(scene["steps"]):
            nudge = random.Random(f"nudge:{seed}:{video}:{role}:{k}")
            cx, cy = cx + nudge.uniform(-3, 3), cy + nudge.uniform(-3, 3)
        card_id = scene["cast"][role]
        kind = next((kd for i, _n, kd, _o in CARDS if i == card_id), "unit")
        out.append({"role": role, "cardId": card_id, "back": card_id is None, "landscape": kind in KINDS["landscape"],
                    "cx": cx, "cy": cy, "deg": round(deg, 3)})
    return out


def visible_share(card: dict, above: list, fine: bool = False) -> tuple:
    """How much of a card can be seen: inside the frame and under no card above it. Measured on a
    grid of points over the card. → (share 0..1, [x, y, w, h] around the visible points or None,
    the positions in `above` of the cards that hide some of it)."""
    nu, nv = (48, 64) if fine else (18, 24)
    at = card_frame(card["cx"], card["cy"], card["w"], card["h"], card["deg"])
    covers = []
    for o in above:
        r = math.radians(o["deg"])
        covers.append((o["cx"], o["cy"], math.cos(r), math.sin(r), o["w"] / 2, o["h"] / 2))
    seen, xs, ys, hiding = 0, [], [], set()
    for i in range(nu):
        for j in range(nv):
            x, y = at((i + 0.5) / nu - 0.5, (j + 0.5) / nv - 0.5)
            if not (0 <= x < FRAME_W and 0 <= y < FRAME_H):
                continue
            over = [n for n, (ox, oy, c, s, hw, hh) in enumerate(covers)
                    if abs((x - ox) * c + (y - oy) * s) <= hw and abs(-(x - ox) * s + (y - oy) * c) <= hh]
            if over:
                hiding.update(over)
                continue
            seen += 1
            xs.append(x)
            ys.append(y)
    if not seen:
        return 0.0, None, hiding
    pad = max(card["w"] / nu, card["h"] / nv) / 2
    x0, y0 = max(0.0, min(xs) - pad), max(0.0, min(ys) - pad)
    x1, y1 = min(float(FRAME_W), max(xs) + pad), min(float(FRAME_H), max(ys) + pad)
    return seen / (nu * nv), [x0, y0, x1 - x0, y1 - y0], hiding


def aabb(corners) -> list:
    xs, ys = [q[0] for q in corners], [q[1] for q in corners]
    return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]


def clip_box(box) -> list:
    x, y, w, h = box
    x0, y0, x1, y1 = max(0.0, x), max(0.0, y), min(float(FRAME_W), x + w), min(float(FRAME_H), y + h)
    return [x0, y0, x1 - x0, y1 - y0]


def rect_corners(box) -> list:
    x, y, w, h = box
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def quarter_turn(deg: float) -> int:
    return int(round(deg / 90.0)) % 4 if abs(deg / 90.0 - round(deg / 90.0)) < 1e-9 else 0


def pretend_model(cards: list, video: str, k: int, seed: int) -> tuple:
    """What an imperfect model would say about frame k: axis-aligned boxes a few pixels off, no
    card backs, and the frame's deliberate mistakes. → (boxes, the mistakes as truth.json lists them)."""
    rng = random.Random(f"model:{seed}:{video}:{k}")
    script = SCENES[video]["model"][k] if k < len(SCENES[video]["model"]) else {}
    names = {cid: nm for cid, nm, _k, _o in CARDS}
    boxes, mistakes = [], []
    for c in cards:
        if c["back"]:
            mistakes.append({"mistake": "missed", "cardId": None, "what": "a card back: the model never boxes one"})
            continue
        if c["role"] in script.get("miss", ()):
            mistakes.append({"mistake": "missed", "cardId": c["cardId"]})
            continue
        if c["ignore"] and c["role"] not in script.get("whole", ()):
            mistakes.append({"mistake": "missed", "cardId": c["cardId"], "what": "too hidden for a card box: it needs an ignore box"})
            continue
        x, y, w, h = clip_box(aabb(c["cardCorners"]))
        dx, dy, dw, dh = script.get("off", {}).get(c["role"], (0, 0, 0, 0))
        if (dx, dy, dw, dh) != (0, 0, 0, 0):
            mistakes.append({"mistake": "box-off", "cardId": c["cardId"], "by": [dx, dy, dw, dh]})
        box = [round(x + dx + rng.uniform(-3, 3), 1), round(y + dy + rng.uniform(-3, 3), 1),
               round(w + dw + rng.uniform(-4, 4), 1), round(h + dh + rng.uniform(-4, 4), 1)]
        said = script.get("name", {}).get(c["role"], c["cardId"])
        if said != c["cardId"]:
            mistakes.append({"mistake": "wrong-name", "cardId": c["cardId"], "said": said, "saidName": names[said]})
        if c["ignore"]:
            mistakes.append({"mistake": "boxed-whole", "cardId": c["cardId"], "what": "too hidden to be a card box: an ignore box around what shows"})
        rot = quarter_turn(c["deg"])
        if c["role"] in script.get("turn", {}):
            rot = script["turn"][c["role"]]
            mistakes.append({"mistake": "wrong-turn", "cardId": c["cardId"], "said": rot, "is": quarter_turn(c["deg"])})
        low = said != c["cardId"] or c["ignore"]
        sim = round(rng.uniform(0.55, 0.68) if low else rng.uniform(0.76, 0.93), 4)
        boxes.append({"box": box, "cardId": said, "sim": sim, "margin": round(rng.uniform(0.06, 0.2), 4),
                      "top5": [{"id": said, "sim": sim}], "rot": rot, "flag": None})
    if "stray" in script:
        n, said = script["stray"]
        _prop, px, py = prop_at(video, seed, n)
        sim = round(rng.uniform(0.5, 0.6), 4)
        boxes.append({"box": [round(px - 19 + rng.uniform(-2, 2), 1), round(py - 19 + rng.uniform(-2, 2), 1), 38.0, 38.0], "cardId": said, "sim": sim, "margin": round(rng.uniform(0.02, 0.06), 4),
                      "top5": [{"id": said, "sim": sim}], "rot": 0, "flag": None})
        mistakes.append({"mistake": "stray", "cardId": None, "what": "a box on something that is not a card"})
    return boxes, mistakes


def lay_out(video: str, seed: int, k: int) -> list:
    """The cards of frame k with their corners, how much of each shows, and the box each should get."""
    scale = SCENES[video]["scale"]
    cards = scene_cards(video, seed, k)
    for c in cards:
        c["w"], c["h"] = card_size(c["landscape"], scale)
    return cards


def place_and_measure(cards: list) -> None:
    """Fill in each card's corners (where it really landed), what shows of it and its right box."""
    for c in cards:
        c["cardCorners"] = corners_of(c["cx"], c["cy"], c["w"], c["h"], c["deg"])
    for n, c in enumerate(cards):
        above = cards[n + 1:]
        share, seen, hiding = visible_share(c, above)
        c["ignore"] = share <= 0.5
        if c["ignore"]:
            share, seen, hiding = visible_share(c, above, fine=True)
        c["visible"] = round(share, 2)
        c["seenBox"] = seen
        c["cut"] = any(not (0 <= x <= FRAME_W and 0 <= y <= FRAME_H) for x, y in c["cardCorners"])
        c["coveredBy"] = [above[i]["cardId"] for i in sorted(hiding)]


_SPRITES: dict = {}


def sprite_for(card: dict, scale: float) -> Sprite:
    key = (card["cardId"], scale)
    if key not in _SPRITES:
        _SPRITES[key] = back_sprite(scale) if card["back"] else face_sprite(card["cardId"], scale)
    return _SPRITES[key]


def prop_at(video: str, seed: int, n: int) -> tuple:
    """Where the n-th thing on a video's table that is not a card lies, moved a few pixels by the seed."""
    prop, px, py = SCENES[video]["props"][n]
    rng = random.Random(f"place:{seed}:{video}:prop:{n}")
    return prop, px + rng.uniform(-4, 4), py + rng.uniform(-4, 4)


_DRAWN: dict = {}  # what is drawn once is kept: the tests build the toy project many times


def forget_drawings() -> None:
    """Drop every kept drawing, so the next build draws everything again."""
    _SPRITES.clear()
    _DRAWN.clear()


def render_frame(video: str, seed: int, k: int) -> tuple:
    """Frame k of a video: (the PNG, its cards with corners and boxes)."""
    key = ("frame", video, seed, k)
    if key not in _DRAWN:
        _DRAWN[key] = _render_frame(video, seed, k)
    png, cards = _DRAWN[key]
    return png, [dict(c) for c in cards]


def _render_frame(video: str, seed: int, k: int) -> tuple:
    scene = SCENES[video]
    cards = lay_out(video, seed, k)
    canvas = draw_table(seed * 1000 + k + (500 if video == "table-b" else 0), scene["mat"])
    for n in range(len(scene["props"])):
        prop, px, py = prop_at(video, seed, n)
        PROPS[prop](canvas, px, py, random.Random(f"roll:{seed}:{video}:{k}").randint(1, 6))
    for c in cards:
        tilted = abs(c["deg"] / 90.0 - round(c["deg"] / 90.0)) >= 1e-9
        fine = sprite_for(c, scene["scale"] * FINE) if tilted else None
        c["cx"], c["cy"] = draw_card(canvas, sprite_for(c, scene["scale"]), c["cx"], c["cy"], c["deg"], fine)
    place_and_measure(cards)
    return canvas.png(), cards


def truth_entry(c: dict) -> dict:
    """One card as the right answer: the box a careful labeler draws for it (docs/labeling.md)."""
    names = {cid: nm for cid, nm, _k, _o in CARDS}
    whole = [[round(v, 1) for v in q] for q in c["cardCorners"]]
    box = [[round(v, 1) for v in q] for q in rect_corners(c["seenBox"])] if c["ignore"] else whole
    return {"cardId": c["cardId"], "name": names.get(c["cardId"]), "outcome": "card-back" if c["back"] else "card",
            "ignore": c["ignore"], "corners": box, "cardCorners": whole, "turn": round(c["deg"] % 360, 1),
            "visible": c["visible"], "cut": c["cut"], "coveredBy": c["coveredBy"]}


TRUTH_ABOUT = ("The toy project's right answers, frame by frame, to compare your labels with. This is not a "
               "label file: the labeling tool and its export never read it. Each frame lists its cards bottom "
               "first. `corners` is the box to draw, in the card's own order (top-left, top-right, bottom-right, "
               "bottom-left, in frame pixels): the whole card for a card or a card back, even where it runs past "
               "the frame's edge, and for an `ignore` card (half or less of it shows) the smallest box around what "
               "shows, whose order does not matter. `cardCorners` is the whole card always. `cardId` names the "
               "card as printed (an alternate printing's own id); a card back has none. `visible` is the share "
               "of the card that shows, `turn` its turn clockwise in degrees, `coveredBy` the cards lying on it. "
               "`model` lists the pretend model's mistakes in prefill.jsonl.")


# The filters of the Names pass after Type: the card's border color, the cost on its gem (none on
# a site or a token) and its set. See "Facets" in cardvision/core/catalog.py.
FACETS = [{"key": "color", "label": "Color", "values": list(COLORS)}, {"key": "cost", "label": "Cost", "type": "number"},
          {"key": "set", "label": "Set"}]


def card_facets(cid: str) -> dict:
    color, _motif, cost, _power, _rules = LOOKS[cid]
    return {"color": color, **({} if cost is None else {"cost": cost}), "set": "TOY"}


def catalog() -> dict:
    # "printing": a card and its alternate printing are one card, and the two Sock Thieves, which
    # only share a name, are two different cards: the id tells them apart, as in many real games.
    return {"game": "toy", "locale": "en", "identity": "printing",
            "cards": [{"id": cid, "name": name, "kind": kind, "printingOf": of, "art": f"{cid}.png", "facets": card_facets(cid)}
                      for cid, name, kind, of in CARDS],
            "kinds": KINDS, "facets": FACETS}


def write_art(out: Path) -> None:
    (out / "art").mkdir(parents=True, exist_ok=True)
    for cid, _name, _kind, _of in CARDS:
        if ("art", cid) not in _DRAWN:
            sprite = face_sprite(cid, ART_SCALE)
            canvas = Canvas(sprite.w, sprite.h, (18, 18, 22))
            draw_card(canvas, sprite, sprite.w / 2, sprite.h / 2, 0)
            _DRAWN[("art", cid)] = canvas.png()
        (out / "art" / f"{cid}.png").write_bytes(_DRAWN[("art", cid)])


def build(out: Path, seed: int = 1, frames: int = 5) -> dict:
    """Write everything under `out`; return a summary {videos, frames, cards}."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "catalog.json").write_text(json.dumps(catalog(), indent=1) + "\n", encoding="utf-8")
    write_art(out)
    names = {cid: nm for cid, nm, _k, _o in CARDS}
    assets, prefill, truth, mistakes = [], [], {}, {}
    (out / "decklists").mkdir(exist_ok=True)
    for video in VIDEOS:
        (out / "frames" / video).mkdir(parents=True, exist_ok=True)
        rows, seen = [], []
        for k in range(frames):
            name = f"f{k + 1:05d}.png"
            png, cards = render_frame(video, seed, k)
            (out / "frames" / video / name).write_bytes(png)
            rows.append({"t": float(k), "name": name})
            boxes, said = pretend_model(cards, video, k, seed)
            prefill.append({"set": video, "t": float(k), "name": name, "frameW": FRAME_W, "frameH": FRAME_H, "boxes": boxes})
            truth[f"{video}/{name}"] = [truth_entry(c) for c in cards]
            mistakes[f"{video}/{name}"] = said
            seen += [c["cardId"] for c in cards if not c["back"] and c["cardId"] not in seen]
        assets.append({"assetId": video, "framesDir": f"frames/{video}", "frames": rows})
        deck = [f"# label: {video}"] + [f"{cid}  # {names[cid]}" for cid in seen]
        (out / "decklists" / f"{video}.txt").write_text("\n".join(deck) + "\n", encoding="utf-8")
    (out / "sample.json").write_text(json.dumps({"schemaVersion": 1, "seed": seed, "assets": assets}, indent=1) + "\n", encoding="utf-8")
    (out / "prefill.jsonl").write_text("".join(json.dumps(r) + "\n" for r in prefill), encoding="utf-8")
    doc = {"about": TRUTH_ABOUT, "seed": seed, "frameW": FRAME_W, "frameH": FRAME_H, "frames": truth, "model": mistakes}
    (out / "truth.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    return {"videos": len(assets), "frames": len(prefill), "cards": len(CARDS)}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("out", help="the folder to write (created if needed)")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--frames", type=int, default=5, help="frames per video (default 5: ten frames in all)")
    a = p.parse_args(argv)
    if a.frames < 1:
        raise SystemExit("--frames must be at least 1")
    out = Path(a.out).expanduser().resolve()
    if (out / "sample.json").exists():
        raise SystemExit(f"{out} already holds toy data (sample.json exists): pick another folder or delete it first")
    done = build(out, a.seed, a.frames)
    here = Path(__file__).resolve().parent
    print(f"wrote {out}: {done['cards']} cards, {done['frames']} frames of {done['videos']} videos\n")
    print("label them:")
    print(f"  python3 {here / 'serve.py'} --mode box --role training --sample {out / 'sample.json'} \\")
    print(f"      --catalog {out / 'catalog.json'} --art {out / 'art'} --prefill {out / 'prefill.jsonl'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
