# SPDX-License-Identifier: Apache-2.0
"""A two-player game board: where the cards of a game in progress lie on the table.

``layout_board`` returns slots in table coordinates: origin at the table center, +y towards
the near player, card width ``s0``, upright card height ``s0 / aspect`` (the run's card aspect,
``CARD_ASPECT`` by default). Each slot has a position ``q``, a table angle ``theta``, a
``role``, a ``draw`` group that says which cards may fill it, and ``back`` for a face-down card.
The slots come in drawing order, lowest first.

Each player's half holds:

* a leader slot on the left with, most of the time (p 0.85), a unit beside it. The leader slot
  is marked ``diceSlot``: the scene generator may rest dice on the card there;
* a row of 2 to 7 units. One in five is turned a quarter turn. Three in ten have an attachment
  tucked under them, so that only a strip of the attachment shows above the unit;
* 1 to 4 columns of 1 to 5 resource cards near the player. Each card in a column overlaps
  the one before, leaving 12 to 35 % of its height showing; three in ten are turned a quarter
  turn;
* on the right, a deck pile of 1 to 4 face-down cards, slightly offset, and a discard pile of
  1 to 5 face-up cards, untidy;
* sometimes (p 0.25) a fanned hand of 3 to 7 cards at the near edge.

The far half is the same generator turned half a turn about the center; it is present with
p 0.85. Between the halves, on the center line, lie 2 site cards (3 with p 0.25), each with up
to 3 units from either side standing beside it. Site cards are the game's landscape cards.

Every slot is then moved by N(0, 0.04 x card width) and turned by N(0, 3 degrees).

The ``draw`` groups are ``"leader"``, ``"unit"``, ``"attachment"``, ``"resource"`` and
``"site"``; ``None`` means any card. Which card kinds a group stands for is the game's choice,
made in its catalog (``cards.KindSettings``).
"""

from __future__ import annotations

import numpy as np

from cardvision.composites.geometry import CARD_ASPECT, rot2

DRAW_GROUPS = ("leader", "unit", "attachment", "resource", "site")


def _slot(q, theta, role, draw, back=False, **kw):
    d = {"q": np.asarray(q, float), "theta": float(theta), "role": role, "draw": draw, "back": back}
    d.update(kw)
    return d


def half(rng, w, h, gap):
    """Slots for one player's half, on the near side (y > 0), lowest first."""
    out = []
    y_base = gap + h * rng.uniform(0.55, 0.8)
    y_res = y_base + h * rng.uniform(1.15, 1.45)
    dx = w * rng.uniform(1.08, 1.35)
    # The leader, and a unit beside it.
    xl = -rng.uniform(3.6, 5.0) * w
    out.append(_slot((xl, y_base), 0, "leader", "leader", diceSlot=True))
    if rng.random() < 0.85:
        out.append(_slot((xl + dx, y_base + rng.uniform(-0.1, 0.1) * h), 0, "leader-unit", "unit"))
    # The row of units. A tucked attachment is drawn first, so that the unit covers all of it
    # but its top.
    n_units = int(rng.integers(2, 8))
    x0 = xl + dx * rng.uniform(2.0, 2.6)
    for i in range(n_units):
        x = x0 + i * dx
        th = 90.0 if rng.random() < 0.2 else 0.0
        if rng.random() < 0.3:
            out.append(_slot((x + rng.normal(0, 0.03 * w), y_base - h * rng.uniform(0.18, 0.32)), rng.normal(0, 4),
                             "attachment", "attachment"))
        out.append(_slot((x, y_base), th, "unit", "unit"))
    # Columns of resource cards, each column squeezed into strips: the first card is the
    # lowest, and each later one sits nearer the player and covers most of the one before.
    n_cols = int(rng.integers(1, 5))
    xr = xl + rng.uniform(0.0, 1.0) * w
    for c in range(n_cols):
        k = int(rng.integers(1, 6))
        step = h * rng.uniform(0.12, 0.35)
        col_x = xr + c * dx * rng.uniform(1.0, 1.3)
        for j in range(k):
            th = 90.0 if rng.random() < 0.3 else 0.0
            out.append(_slot((col_x, y_res + j * step), th, "resource", "resource", column=c))
    # The deck pile (face down) and the discard pile (face up), on the right.
    xd = x0 + n_units * dx + rng.uniform(0.5, 1.5) * w
    for j in range(int(rng.integers(1, 5))):
        out.append(_slot((xd + rng.normal(0, 0.012 * w), y_base + h * 0.9 + rng.normal(0, 0.012 * w)),
                         rng.normal(0, 1.5), "deck-pile", None, back=True))
    for j in range(int(rng.integers(1, 6))):
        out.append(_slot((xd + dx * 1.1 + rng.normal(0, 0.06 * w), y_base + h * 0.9 + rng.normal(0, 0.06 * w)),
                         rng.normal(0, 10), "discard-pile", None))
    # A fanned hand at the near edge.
    if rng.random() < 0.25:
        k = int(rng.integers(3, 8))
        spread = rng.uniform(8, 25)
        cx = rng.uniform(-2, 2) * w
        piv = np.array([cx, y_res + h * rng.uniform(2.2, 3.2)])
        for i in range(k):
            a = -spread + 2 * spread * i / max(1, k - 1)
            out.append(_slot(piv + rot2(a) @ np.array([0, -h * 1.1]), a, "hand-fan", None))
    return out


def layout_board(rng, s0, aspect=CARD_ASPECT):
    """A whole board for card width ``s0`` (table units) and upright card aspect ``aspect``
    (width over height). Returns ``(slots, info)``."""
    w, h = s0, s0 / aspect
    gap = h * rng.uniform(0.9, 1.4)  # half the height of the center band that holds the sites
    slots = []
    # Site cards on the center line. They are landscape cards; the scene generator gives a
    # landscape image the same short side as an upright card.
    nb = 3 if rng.random() < 0.25 else 2
    bdx = h * rng.uniform(1.6, 2.2)
    for i in range(nb):
        x = (i - (nb - 1) / 2) * bdx
        slots.append(_slot((x, 0.0), 0.0 if rng.random() < 0.5 else 180.0, "site", "site"))
    near = half(rng, w, h, gap)
    far = half(rng, w, h, gap) if rng.random() < 0.85 else []
    for s in far:  # the other player's side: reflected through the center and turned half a turn
        s["q"] = -s["q"]
        s["theta"] += 180.0
        s["side"] = "far"
    for s in near:
        s["side"] = "near"
    # Units standing beside the sites, from both sides.
    beside = []
    for i in range(nb):
        x = (i - (nb - 1) / 2) * bdx
        for side, sgn, th0 in (("near", 1, 0.0), ("far", -1, 180.0)):
            if side == "far" and not far:
                continue
            for j in range(int(rng.integers(0, 4))):
                q = np.array([x + (j - 1) * w * 1.05, sgn * (h * 0.5 + gap * 0.5)])
                beside.append(_slot(q, th0 + (90.0 if rng.random() < 0.2 else 0.0), "site-unit", "unit", side=side))
    slots += near + far + beside
    for s in slots:
        s["q"] = s["q"] + rng.normal(0, 0.04 * w, 2)
        s["theta"] += rng.normal(0, 3)
    info = {"sites": nb, "opponent": bool(far), "cards": len(slots)}
    return slots, info
