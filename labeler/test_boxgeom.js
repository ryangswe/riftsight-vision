// SPDX-License-Identifier: Apache-2.0
// Tests for boxgeom.js (rotated boxes, resize in the box's own frame, tap toggle, z-order,
// copy/paste, carry-over, duplicates, same layout). Run: node test_boxgeom.js (also run by
// test_serve.py). Stdlib assert only.
"use strict";
const assert = require("assert");
const G = require("./boxgeom.js");

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-6), `${msg || ""} ${a} vs ${b}`);
const W = 1920, H = 1080;

// ---- rect <-> corners -----------------------------------------------------------------
{
  // an axis-aligned stored box reads as angle 0 and round-trips exactly
  const c = [[642.4, 525.3], [767.4, 525.3], [767.4, 690.8], [642.4, 690.8]];
  const r = G.rectFromCorners(c);
  close(r.w, 125, 1e-9); close(r.h, 165.5, 1e-9); assert.strictEqual(r.angle, 0);
  assert.deepStrictEqual(G.cornersFromRect(r), c, "unrotated box round-trips to the same corners");
  assert.ok(G.isRectangle(c));
}
{
  // a rotated box: corners are the rect's own TL, TR, BR, BL (clockwise), angle kept exactly
  const r = { cx: 500, cy: 400, w: 120, h: 168, angle: 30 };
  const c = G.cornersFromRect(r);
  assert.ok(G.signedArea(c) > 0, "clockwise on screen");
  assert.ok(G.isRectangle(c), "a 30° rectangle is a rectangle after 0.1 px rounding");
  const back = G.rectFromCorners(c, 30);
  close(back.cx, 500, 0.05); close(back.cy, 400, 0.05); close(back.w, 120, 0.1); close(back.h, 168, 0.1);
  assert.strictEqual(back.angle, 30);
  // without the stored angle, the top edge gives it back (to rounding)
  close(G.rectFromCorners(c).angle, 30, 0.1);
  // the rect's own top-left is up-left of center, rotated clockwise: right of the unrotated TL
  assert.ok(c[0][0] > 500 - 60 && c[0][1] < 400 - 84 + 40);
  // tapped (90°): the own top-left is at the screen top-RIGHT
  const t = G.cornersFromRect({ cx: 100, cy: 100, w: 60, h: 80, angle: 90 });
  assert.deepStrictEqual(t, [[140, 70], [140, 130], [60, 130], [60, 70]]);
  assert.ok(G.isRectangle(t));
}
{
  // not rectangles: a trapezoid, a slanted "box", counter-clockwise order, a degenerate side
  assert.ok(!G.isRectangle([[0, 0], [100, 0], [90, 140], [10, 140]]));
  assert.ok(!G.isRectangle([[0, 0], [10, 2], [10, 10], [0, 10]]));
  assert.ok(!G.isRectangle([[0, 0], [0, 10], [10, 10], [10, 0]]), "counter-clockwise");
  assert.ok(!G.isRectangle([[5, 5], [5, 5], [5, 9], [5, 9]]));
  // a small rotated box still passes after rounding
  for (let a = -179; a <= 180; a += 7) assert.ok(G.isRectangle(G.cornersFromRect({ cx: 50.33, cy: 60.71, w: 4.2, h: 6.9, angle: a })), `angle ${a}`);
}

// ---- boxes, moves, hits ---------------------------------------------------------------
assert.deepStrictEqual(G.boxCorners(300, 200, 240, 110, W, H), [[240, 110], [300, 110], [300, 200], [240, 200]]);
assert.deepStrictEqual(G.boxCorners(-5, 10, 30, 2000, W, H), [[0, 10], [30, 10], [30, 1080], [0, 1080]], "clamped into the frame");
assert.deepStrictEqual(G.translateCorners([[10, 10], [20, 10], [20, 30], [10, 30]], -50, 5, W, H), [[0, 15], [10, 15], [10, 35], [0, 35]], "stays in the frame");
// A box already past an edge (a turned card cut by the frame) is not pulled back in, nor pushed further out.
assert.deepStrictEqual(G.translateCorners([[10, -20], [40, -10], [30, 20], [0, 10]], 5, 3, W, H, true), [[15, -17], [45, -7], [35, 23], [5, 13]], "moves inward freely");
assert.deepStrictEqual(G.translateCorners([[10, -20], [40, -10], [30, 20], [0, 10]], -5, -3, W, H, true), [[10, -20], [40, -10], [30, 20], [0, 10]], "not further out, not pulled in");
assert.deepStrictEqual(G.translateCorners([[10, -20], [40, -10], [30, 20], [0, 10]], 0, 0, W, H), [[10, 0], [40, 10], [30, 40], [0, 30]], "without keepOverhang it is moved inside (paste)");
assert.deepStrictEqual(G.resizePoint({ x: -5000, y: -30 }, 0, 1920, 1080), { x: 0, y: 0 }, "upright handles stop at the frame");
assert.deepStrictEqual(G.resizePoint({ x: 100, y: -30 }, 20, 1920, 1080), { x: 100, y: -30 }, "turned handles may pass the frame");
assert.deepStrictEqual(G.resizePoint({ x: -5000, y: 5000 }, 20, 1920, 1080), { x: -960, y: 1620 }, "by at most half a frame");
{
  const r = { cx: 100, cy: 100, w: 60, h: 80, angle: 0 };
  assert.strictEqual(G.hitCorner(r, { x: 71, y: 61 }, 5), "tl");
  assert.strictEqual(G.hitCorner(r, { x: 100, y: 100 }, 5), null);
  assert.strictEqual(G.hitEdge(r, { x: 100, y: 60.5 }, 3), "t");
  assert.strictEqual(G.hitEdge(r, { x: 129, y: 100 }, 3), "r");
  assert.strictEqual(G.hitEdge(r, { x: 100, y: 100 }, 3), null);
  // the rotate knob sits above the box's own top edge; at 90° that is to the right
  const k = G.rotateHandlePos({ cx: 100, cy: 100, w: 60, h: 80, angle: 90 }, 10);
  close(k.x, 150, 1e-9); close(k.y, 100, 1e-9);
  close(G.angleFromCenter({ x: 0, y: 0 }, { x: 10, y: 0 }), 90, 1e-9);
  assert.ok(G.pointInQuad(G.cornersFromRect({ cx: 100, cy: 100, w: 60, h: 80, angle: 45 }), { x: 100, y: 100 }));
  assert.ok(!G.pointInQuad(G.cornersFromRect({ cx: 100, cy: 100, w: 20, h: 200, angle: 90 }), { x: 100, y: 180 }));
}

// ---- resize in the rotated frame ------------------------------------------------------
{
  // unrotated: dragging the bottom-right corner keeps the top-left put
  const o = { cx: 100, cy: 100, w: 60, h: 80, angle: 0 };
  const r = G.resizeRect(o, "br", { x: 150, y: 170 });
  close(r.cx - r.w / 2, 70, 1e-9); close(r.cy - r.h / 2, 60, 1e-9); close(r.w, 80, 1e-9); close(r.h, 110, 1e-9);
  // an edge moves one side only
  const e = G.resizeRect(o, "t", { x: 999, y: 40 });
  close(e.w, 60, 1e-9); close(e.h, 100, 1e-9); close(e.cy + e.h / 2, 140, 1e-9);
  // minimum size
  const m = G.resizeRect(o, "r", { x: 0, y: 0 });
  close(m.w, G.MIN_BOX, 1e-9); close(m.cx - m.w / 2, 70, 1e-9);
  // rotated 30°: the opposite (own top-left) corner stays fixed in the frame, the angle kept
  const ro = { cx: 500, cy: 400, w: 120, h: 168, angle: 30 };
  const tl = G.cornersFromRectRaw(ro)[0];
  const rr = G.resizeRect(ro, "br", { x: 600, y: 520 });
  const tl2 = G.cornersFromRectRaw(rr)[0];
  close(tl2[0], tl[0], 1e-9); close(tl2[1], tl[1], 1e-9);
  assert.strictEqual(rr.angle, 30);
}

// ---- tap toggle (`w`) --------------------------------------------------------------
assert.strictEqual(G.tapToggle(0, 1), 90);
assert.strictEqual(G.tapToggle(90, 1), 0);
assert.strictEqual(G.tapToggle(4, 1), 94);
assert.strictEqual(G.tapToggle(94, 1), 4);
assert.strictEqual(G.tapToggle(0, -1), -90);
assert.strictEqual(G.tapToggle(-90, -1), 0);
// box-pass quarter turn: w clockwise, W counter-clockwise, tilt kept, reaches 180
assert.strictEqual(G.quarterTurn(0, 1), 90);
assert.strictEqual(G.quarterTurn(90, 1), 180);
assert.strictEqual(G.quarterTurn(180, 1), -90);
assert.strictEqual(G.quarterTurn(-90, 1), 0);
assert.strictEqual(G.quarterTurn(4, 1), 94);
assert.strictEqual(G.quarterTurn(94, 1), -176);
assert.strictEqual(G.quarterTurn(0, -1), -90);
assert.strictEqual(G.quarterTurn(-90, -1), 180);
// the handle side is the card's top: at 180° the first corner is on screen bottom-right
{
  const q = G.cornersFromRectRaw({ cx: 100, cy: 100, w: 40, h: 60, angle: 180 });
  assert.deepStrictEqual(q[0].map(Math.round), [120, 130]);
}
assert.strictEqual(G.normalizeAngle(270), -90);
assert.strictEqual(G.normalizeAngle(-180), 180);
// the stored angle never rounds to −180 (the server accepts (−180, 180]) and is never −0
assert.strictEqual(G.roundAngle(-179.999), 180);
assert.strictEqual(G.roundAngle(-180), 180);
assert.strictEqual(G.roundAngle(179.996), 180);
assert.strictEqual(G.roundAngle(180.004), 180);
assert.strictEqual(G.roundAngle(540.001), 180);
assert.strictEqual(G.roundAngle(-179.994), -179.99);
assert.ok(Object.is(G.roundAngle(-0.001), 0), "no −0");
assert.strictEqual(G.roundAngle(-90), -90);
for (let a = -360; a <= 360; a += 0.0037) { const r = G.roundAngle(a); assert.ok(r > -180 && r <= 180, `roundAngle(${a}) = ${r}`); }

// ---- z-order --------------------------------------------------------------------------
{
  const ts = [{ id: "A" }, { id: "B" }, { id: "C" }];
  assert.deepStrictEqual(G.orderAsc(ts), [0, 1, 2], "no zOrder: array position");
  assert.strictEqual(G.nextZ(ts), null, "no zOrder on the frame: a new box is appended without one");
  assert.deepStrictEqual(G.reorder(ts, 0, "front"), [2, 0, 1]);
  assert.deepStrictEqual(G.reorder(ts, 2, "back"), [1, 2, 0]);
  assert.deepStrictEqual(G.reorder(ts, 1, 1), [0, 2, 1]);
  assert.strictEqual(G.reorder(ts, 2, 1), null, "already on top");
  assert.strictEqual(G.reorder(ts, 2, "front"), null, "already in front: nothing to write");
  const z = [{ zOrder: 5 }, { zOrder: 1 }, { zOrder: 3 }];
  assert.deepStrictEqual(G.orderDesc(z), [0, 2, 1], "topmost first");
  assert.strictEqual(G.nextZ(z), 6);
}

// ---- copy / paste ---------------------------------------------------------------------
{
  const src = { id: "B003", corners: G.cornersFromRect({ cx: 300, cy: 300, w: 100, h: 140, angle: 12 }), angle: 12,
    cornerSource: "box", outcome: "card", identity: "NEW-082", printing: "NEW-082A", identitySource: "decklist",
    eligible: "yes", conditions: { blur: true }, labelSource: "manual", derived: { aabb: [] } };
  const clip = G.makeClip(src, "f1.jpg");
  assert.strictEqual(clip.angle, 12);
  // same frame: +12 px, a new manual box with the identity, not the per-instance answers
  const p = G.pasteTarget(clip, "f1.jpg", W, H, "B004", null);
  close(p.corners[0][0], src.corners[0][0] + 12, 1e-9); close(p.corners[2][1], src.corners[2][1] + 12, 1e-9);
  assert.deepStrictEqual([p.id, p.cornerSource, p.labelSource, p.angle, p.identity, p.printing, p.identitySource, p.eligible],
    ["B004", "box", "manual", 12, "NEW-082", "NEW-082A", "decklist", null]);
  assert.deepStrictEqual(p.conditions, {});
  assert.ok(!("derived" in p) && !("zOrder" in p));
  assert.ok(G.isRectangle(p.corners));
  // another frame: the exact position
  assert.deepStrictEqual(G.pasteTarget(clip, "f2.jpg", W, H, "B001", 7).corners, src.corners);
  assert.strictEqual(G.pasteTarget(clip, "f2.jpg", W, H, "B001", 7).zOrder, 7);
  // the kind travels: a back stays a back (eligible no, face down), an ignored box stays ignored
  const back = G.pasteTarget(G.makeClip({ id: "B1", corners: src.corners, outcome: "card-back", eligible: "no" }, "f1.jpg"), "f2.jpg", W, H, "B9");
  assert.deepStrictEqual([back.outcome, back.eligible, back.conditions, back.identity], ["card-back", "no", { faceUp: false }, null]);
  const ign = G.pasteTarget(G.makeClip({ id: "B1", corners: src.corners, outcome: "card", ignore: true }, "f1.jpg"), "f2.jpg", W, H, "B9");
  assert.deepStrictEqual([ign.ignore, ign.eligible], [true, "no"]);
  // pasted into a smaller frame (or off its edge): moved inside
  const off = G.pasteTarget(G.makeClip({ id: "B1", corners: [[1900, 1000], [1950, 1000], [1950, 1070], [1900, 1070]], outcome: "card" }, "f1.jpg"), "f2.jpg", 1920, 1080, "B2");
  assert.deepStrictEqual(off.corners, [[1870, 1000], [1920, 1000], [1920, 1070], [1870, 1070]]);
  // an unrotated box pastes without an angle field
  const flat = G.pasteTarget(G.makeClip({ id: "B1", corners: [[0, 0], [10, 0], [10, 10], [0, 10]], outcome: "card" }, "f1.jpg"), "f1.jpg", W, H, "B2");
  assert.ok(!("angle" in flat));
  assert.deepStrictEqual(flat.corners, [[12, 12], [22, 12], [22, 22], [12, 22]]);
}

// ---- carry-over -----------------------------------------------------------------------
{
  const prev = [{ id: "B001", corners: [[0, 0], [10, 0], [10, 10], [0, 10]], estimated: [false, false, false, false], cornerSource: "box",
    outcome: "card", identity: "TOY-001", identitySource: "decklist", eligible: "yes", conditions: { blur: true }, labelSource: "manual",
    derived: { aabb: [0, 0, 10, 10] }, zOrder: 2 }];
  const c = G.carryTargets(prev, "f1.jpg");
  assert.deepStrictEqual(c[0], { id: "B001", corners: [[0, 0], [10, 0], [10, 10], [0, 10]], estimated: [false, false, false, false],
    cornerSource: "carried", labelSource: "carried", carriedFrom: { frame: "f1.jpg", target: "B001" },
    outcome: "card", identity: "TOY-001", identitySource: "decklist", eligible: "yes", conditions: { blur: true }, zOrder: 2 });
  assert.ok(G.isCarried(c[0]) && !G.isCarried(prev[0]));
  c[0].conditions.blur = false;
  assert.strictEqual(prev[0].conditions.blur, true, "a deep copy");
}

// ---- duplicates and same layout -------------------------------------------------------
{
  const box = (x, y, a) => ({ corners: G.cornersFromRect({ cx: x, cy: y, w: 100, h: 140, angle: a || 0 }), angle: a || undefined });
  assert.deepStrictEqual(G.duplicates([box(100, 100), box(101, 100), box(400, 100)]), [[0, 1]]);
  assert.deepStrictEqual(G.duplicates([box(100, 100), box(112, 112)]), [], "a same-frame paste (+12 px) is not a duplicate");
  const cur = [box(100, 100), box(300, 100)];
  const frames = [{ index: 0, t: 0, dt: -2, targets: [box(100, 102), box(300, 102)] },   // same layout: skipped
    { index: 1, t: 1, dt: -1, targets: [box(150, 300), box(350, 300)] },
    { index: 3, t: 3, dt: 1, targets: [box(150, 500), box(350, 500)] },
    { index: 4, t: 4, dt: 2, targets: [box(150, 500)] }];                                   // other count: skipped
  assert.deepStrictEqual(G.layoutMatches(cur, frames).map((m) => m.index), [1, 3]);
}

// ---- "this edge is the top" (Alt+click an edge) ---------------------------------------
{
  const key4 = (c) => c.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).sort().join(" ");
  const near = (a, b, msg) => { close(a[0], b[0], 0.11, msg); close(a[1], b[1], 0.11, msg); };
  // upright 60×90: the right edge becomes the top → angle 90, the same four points, q[0] at the old top-right
  const up = { cx: 100, cy: 200, w: 60, h: 90, angle: 0 };
  const c0 = G.cornersFromRect(up);
  const r1 = G.setTopEdge(up, 1);
  assert.deepStrictEqual([r1.w, r1.h, r1.angle, r1.cx, r1.cy], [90, 60, 90, 100, 200]);
  const c1 = G.cornersFromRect(r1);
  assert.strictEqual(key4(c1), key4(c0), "same four screen corners");
  assert.deepStrictEqual(c1[0], c0[1], "new q[0] = old top-right");
  assert.deepStrictEqual(c1[1], c0[2], "new top edge = old right edge");
  assert.deepStrictEqual(G.topEdgeCorners(c0, 1), c1, "the corner rotation gives the same result exactly");
  // every edge, on a tilted box: same points, q[0]→q[1] on the chosen edge, the angle it implies
  const tilt = { cx: 400, cy: 300, w: 63, h: 88, angle: 17 };
  const ct = G.cornersFromRect(tilt);
  for (let k = 0; k < 4; k++) {
    const r = G.setTopEdge(tilt, k);
    const c = G.cornersFromRect(r);
    assert.strictEqual(key4(c), key4(ct), `k=${k}: same corners`);
    near(c[0], ct[k], `k=${k}: q0`); near(c[1], ct[(k + 1) % 4], `k=${k}: q1`);
    close(G.rectFromCorners(G.topEdgeCorners(ct, k)).angle, r.angle, 0.2, `k=${k}: the corner order implies the angle`);
    assert.ok(G.isRectangle(G.topEdgeCorners(ct, k)));
  }
  // k = 0 is a no-op; k wraps; ±180 normalizes
  assert.deepStrictEqual(G.setTopEdge(tilt, 0), tilt);
  assert.deepStrictEqual(G.topEdgeCorners(ct, 0), ct);
  assert.deepStrictEqual(G.setTopEdge(tilt, 5), G.setTopEdge(tilt, 1));
  assert.deepStrictEqual(G.setTopEdge(tilt, -1), G.setTopEdge(tilt, 3));
  assert.strictEqual(G.setTopEdge({ cx: 0, cy: 0, w: 10, h: 20, angle: 90 }, 1).angle, 180);
  assert.strictEqual(G.setTopEdge({ cx: 0, cy: 0, w: 10, h: 20, angle: -90 }, 3).angle, 180, "−180 → 180");
  assert.strictEqual(G.setTopEdge({ cx: 0, cy: 0, w: 10, h: 20, angle: 180 }, 2).angle, 0);
  assert.strictEqual(G.setTopEdge({ cx: 0, cy: 0, w: 10, h: 20, angle: 90.004 }, 1).angle, 180, "rounded then normalized");
  assert.ok(Object.is(G.setTopEdge({ cx: 0, cy: 0, w: 10, h: 20, angle: 270 }, 1).angle, 0), "no −0");
  // nearest edge, in the box's own frame (corners go to the nearer edge; the middle is none)
  assert.strictEqual(G.nearestEdge(up, { x: 131, y: 200 }, 5), 1);
  assert.strictEqual(G.nearestEdge(up, { x: 100, y: 154 }, 5), 0);
  assert.strictEqual(G.nearestEdge(up, { x: 100, y: 246 }, 5), 2);
  assert.strictEqual(G.nearestEdge(up, { x: 69, y: 200 }, 5), 3);
  assert.strictEqual(G.nearestEdge(up, { x: 100, y: 200 }, 5), null);
  assert.strictEqual(G.nearestEdge(up, { x: 140, y: 200 }, 5), null);
  assert.strictEqual(G.nearestEdge(up, { x: 129, y: 157 }, 5), 1, "near the top-right corner: the nearer edge");
  // on a tapped box (angle 90) the screen's right edge is the box's own bottom
  assert.strictEqual(G.nearestEdge({ cx: 100, cy: 200, w: 60, h: 90, angle: 90 }, { x: 145, y: 200 }, 5), 0);
}

// ---- box-mode prefill ------------------------------------------------------------
{
  // a detector box: axis-aligned, pending, cornerSource prefill, the proposal kept
  const t = G.prefillTarget({ box: [100, 50, 63, 88], outcome: "card", score: 0.91 }, 0, 1920, 1080, "P001");
  assert.deepStrictEqual(t.corners, [[100, 50], [163, 50], [163, 138], [100, 138]]);
  assert.strictEqual(t.pending, true);
  assert.strictEqual(t.cornerSource, "prefill");
  assert.strictEqual(t.labelSource, undefined, "no labelSource until reviewed");
  assert.strictEqual(t.angle, undefined);
  assert.deepStrictEqual([t.prefill.i, t.prefill.score, t.prefill.outcome], [0, 0.91, "card"]);
  assert.ok(G.isRectangle(t.corners));
  // a back: card-back, eligible no, face down
  const b = G.prefillTarget({ box: [10, 10, 40, 60], outcome: "card-back", score: 0.5 }, 1, 1920, 1080, "P002");
  assert.deepStrictEqual([b.outcome, b.eligible, b.conditions.faceUp], ["card-back", "no", false]);
  // clamped into the frame; too small or not a rectangle → null
  const c = G.prefillTarget({ box: [-20, 1000, 100, 200] }, 2, 1920, 1080, "P003");
  assert.deepStrictEqual(c.corners, [[0, 1000], [80, 1000], [80, 1080], [0, 1080]]);
  assert.strictEqual(c.outcome, "card", "no outcome → card");
  assert.strictEqual(G.prefillTarget({ box: [5, 5, 2, 50] }, 3, 1920, 1080, "P004"), null);
  assert.strictEqual(G.prefillTarget({ corners: [[0, 0], [10, 2], [10, 10], [0, 10]] }, 4, 1920, 1080, "P005"), null);
  assert.strictEqual(G.prefillTarget({}, 5, 1920, 1080, "P006"), null);
  // a proposal's rot (the quarter turn at which the model matched): the order shifts, the angle follows
  const r = G.prefillTarget({ box: [100, 100, 88, 63], rot: 90, cardId: "TOY-001" }, 6, 1920, 1080, "P007");
  assert.deepStrictEqual(r.corners, [[188, 100], [188, 163], [100, 163], [100, 100]]);
  assert.strictEqual(r.angle, 90);
  assert.ok(G.isRectangle(r.corners));
  close(G.rectFromCorners(r.corners).angle, 90, 1e-9, "the corner order implies the stored angle");
  assert.strictEqual(r.prefill.cardId, "TOY-001");
  assert.strictEqual(r.identity, null, "box mode never takes the proposal's identity");
  // rot as the inference command writes it, in quarter turns (0..3); degrees are read the same way
  const q = G.prefillTarget({ box: [100, 100, 88, 63], rot: 1 }, 7, 1920, 1080, "P008");
  assert.deepStrictEqual([q.corners, q.angle], [r.corners, 90]);
  assert.deepStrictEqual([0, 1, 2, 3, 90, 180, 270, 360, null, "x"].map(G.quarterTurns), [0, 1, 2, 3, 1, 2, 3, 0, 0, 0]);
  // a proposal is in the pixel space of its own record (frameW x frameH), which need not be the
  // frame on screen: a record written for a 960 x 540 frame, shown on the 1920 x 1080 frame
  const half = G.scaleProposal({ box: [50, 50, 44, 31.5], corners: [[50, 50], [94, 50], [94, 81.5], [50, 81.5]], rot: 1, cardId: "TOY-001" },
    [960, 540], 1920, 1080);
  assert.deepStrictEqual(half.box, [100, 100, 88, 63]);
  assert.deepStrictEqual(half.corners, [[100, 100], [188, 100], [188, 163], [100, 163]]);
  assert.deepStrictEqual([half.rot, half.cardId], [1, "TOY-001"], "everything else is kept");
  assert.deepStrictEqual(G.prefillTarget(half, 8, 1920, 1080, "P009").corners, r.corners, "the scaled box lands where the full-size one does");
  // each axis by its own factor (a 4:3 record on a 16:9 frame), and a 720p frame
  assert.deepStrictEqual(G.scaleProposal({ box: [10, 10, 20, 20] }, [640, 480], 1280, 720).box, [20, 15, 40, 30]);
  const t720 = G.prefillTarget(G.scaleProposal({ box: [300, 150, 120, 168] }, [1920, 1080], 1280, 720), 9, 1280, 720, "P010");
  assert.deepStrictEqual(t720.corners, [[200, 100], [280, 100], [280, 212], [200, 212]]);
  // a record in the frame's own pixels, or one without a size, is left exactly as it is
  const own = { box: [1, 2, 30, 40] };
  assert.strictEqual(G.scaleProposal(own, [1280, 720], 1280, 720), own);
  assert.strictEqual(G.scaleProposal(own, null, 1280, 720), own);
  assert.strictEqual(G.scaleProposal(own, [0, 720], 1280, 720), own);

  // provenance: as proposed → accepted; any change → corrected (prefill-edited once the geometry differs)
  const clone = (x) => JSON.parse(JSON.stringify(x));
  assert.deepStrictEqual(G.prefillProvenance(t), { labelSource: "prefill-accepted", cornerSource: "prefill" });
  const moved = clone(t); moved.corners = G.translateCorners(moved.corners, 1, 0, 1920, 1080);
  assert.deepStrictEqual(G.prefillProvenance(moved), { labelSource: "prefill-corrected", cornerSource: "prefill-edited" });
  const top = clone(t); top.corners = G.topEdgeCorners(top.corners, 1); top.angle = 90; // Alt+click: only the top edge
  assert.deepStrictEqual(G.prefillProvenance(top), { labelSource: "prefill-corrected", cornerSource: "prefill-edited" });
  const back = clone(t); back.outcome = "card-back";
  assert.deepStrictEqual(G.prefillProvenance(back), { labelSource: "prefill-corrected", cornerSource: "prefill" });
  const ign = clone(t); ign.ignore = true;
  assert.strictEqual(G.prefillProvenance(ign).labelSource, "prefill-corrected");
  const named = clone(t); named.identity = "TOY-001"; named.eligible = "yes";
  assert.strictEqual(G.prefillProvenance(named).labelSource, "prefill-accepted", "an identity is not a box correction");
  assert.strictEqual(G.prefillProvenance(clone(b)).labelSource, "prefill-accepted", "a back kept a back");
  assert.strictEqual(G.prefillProvenance(clone(r)).labelSource, "prefill-accepted", "a rot proposal kept as is");
  assert.strictEqual(G.prefillProvenance({ corners: t.corners }), null);
  // overlap with existing boxes (carry-over wins: a proposal comes only where IoU < 0.3)
  const rect = G.rectFromCorners(t.corners);
  assert.strictEqual(G.maxIoU(rect, []), 0);
  close(G.maxIoU(rect, [rect]), 1, 1e-6, "same box");
  assert.ok(G.maxIoU(rect, [{ cx: rect.cx + 50, cy: rect.cy, w: 63, h: 88, angle: 0 }]) < 0.3);
  assert.ok(G.maxIoU(rect, [{ cx: rect.cx + 5, cy: rect.cy, w: 63, h: 88, angle: 0 }]) >= 0.3);
}

// ---- review walk ------------------------------------------------------------
{
  const box = (id, cx, cy, extra) => Object.assign({ id, corners: G.cornersFromRect({ cx, cy, w: 60, h: 84, angle: 0 }) }, extra || {});
  // two rows (centers jitter within a row), an ignored box in the first row
  const ts = [
    box("A", 400, 310), box("B", 100, 300), box("C", 250, 295, { ignore: true }),
    box("D", 120, 600), box("E", 300, 610),
  ];
  const ids = (idx) => idx.map((i) => ts[i].id);
  assert.deepStrictEqual(ids(G.reviewOrder(ts, false)), ["B", "A", "D", "E"], "reading order: rows top to bottom, left to right");
  assert.deepStrictEqual(ids(G.reviewOrder(ts, true)), ["B", "A", "D", "E", "C"], "ignored boxes last on the frame");
  // a quarter turn (about the center) or a new top edge (same points) never reorders the walk
  const turned = ts.map((t) => Object.assign({}, t));
  const rA = G.rectFromCorners(turned[0].corners);
  turned[0].corners = G.cornersFromRect(Object.assign({}, rA, { angle: G.quarterTurn(0, 1) })); turned[0].angle = 90;
  turned[3].corners = G.topEdgeCorners(turned[3].corners, 2); turned[3].angle = 180;
  assert.deepStrictEqual(G.reviewOrder(turned, true).map((i) => turned[i].id), ["B", "A", "D", "E", "C"], "orientation edits keep the order");

  // the frame's order is kept while walked: h on A does not move it to the end
  let r = G.reviewFrameIds(ts, true, null);
  assert.deepStrictEqual(r.ids, ["B", "A", "D", "E", "C"]);
  const hA = ts.map((t) => (t.id === "A" ? Object.assign({}, t, { ignore: true }) : t));
  assert.deepStrictEqual(G.reviewFrameIds(hA, true, r.cache).ids, ["B", "A", "D", "E", "C"], "cached: A stays in place");
  assert.deepStrictEqual(G.reviewFrameIds(hA, false, r.cache).ids, ["B", "D", "E"], "without ignore: A leaves the walk");
  assert.deepStrictEqual(G.reviewFrameIds(hA, true, null).ids, ["B", "D", "E", "C", "A"], "fresh: ignored last");
  // a deleted box leaves; brought back by an undo, it is in its old place (the cache keeps it)
  const noD = ts.filter((t) => t.id !== "D");
  const r2 = G.reviewFrameIds(noD, true, r.cache);
  assert.deepStrictEqual(r2.ids, ["B", "A", "E", "C"]);
  assert.deepStrictEqual(G.reviewFrameIds(ts, true, r2.cache).ids, ["B", "A", "D", "E", "C"]);
  // a box new since the cache comes after the cached ones
  const plus = ts.concat([box("F", 50, 50)]);
  assert.deepStrictEqual(G.reviewFrameIds(plus, true, r.cache).ids, ["B", "A", "D", "E", "C", "F"]);

  // the walk spans the frames in order, frames without boxes skipped
  const cache = new Map();
  const walk = G.reviewWalk([{ name: "f1", targets: ts }, { name: "f2", targets: [] }, { name: "f3", targets: [box("P001", 10, 10)] }], false, cache);
  assert.deepStrictEqual(walk.map((e) => `${e.frame}:${e.id}`), ["f1:B", "f1:A", "f1:D", "f1:E", "f3:P001"]);
  assert.deepStrictEqual(cache.get("f1"), ["B", "A", "D", "E", "C"]);
  assert.ok(!cache.has("f2"));

  // stepping: next / previous, the ends, and the gap a removed box leaves
  assert.strictEqual(G.reviewStep(walk, { frame: "f1", id: "A", idx: 1 }, 1), 2);
  assert.strictEqual(G.reviewStep(walk, { frame: "f1", id: "A", idx: 1 }, -1), 0);
  assert.strictEqual(G.reviewStep(walk, { frame: "f1", id: "B", idx: 0 }, -1), -1, "before the first");
  assert.strictEqual(G.reviewStep(walk, { frame: "f3", id: "P001", idx: 4 }, 1), -1, "after the last");
  const gap = walk.filter((e) => e.id !== "D"); // D deleted while shown at index 2
  assert.deepStrictEqual(G.reviewLocate(gap, { frame: "f1", id: "D", idx: 2 }), { i: 2, present: false });
  assert.strictEqual(gap[G.reviewStep(gap, { frame: "f1", id: "D", idx: 2 }, 1)].id, "E", "next after a deleted box: its successor");
  assert.strictEqual(gap[G.reviewStep(gap, { frame: "f1", id: "D", idx: 2 }, -1)].id, "A", "previous: its predecessor");
  assert.strictEqual(G.reviewStep([], { frame: "f1", id: "D", idx: 2 }, 1), -1, "empty walk");
}
{
  // fitted zoom: the set's zoom unless the box would not fit `fill` of the view
  assert.strictEqual(G.fitZoom(100, 640, 3, 0.9), 3, "100 px at 3× fits 576");
  close(G.fitZoom(300, 640, 3, 0.9), 640 * 0.9 / 300, 1e-12, "300 px is fitted");
  close(G.fitZoom(300, 640, 3, 0.6), 640 * 0.6 / 300, 1e-12);
  assert.strictEqual(G.fitZoom(1e6, 640, 3), 0.1, "floor");
  // view ↔ frame mapping round-trips, the center maps to (cx, cy)
  const v = { cx: 500, cy: 400, z: 2.5, w: 800, h: 600 };
  assert.deepStrictEqual(G.viewToFrame(v, 400, 300), { x: 500, y: 400 });
  const p = G.viewToFrame(v, 123, 456);
  const back = G.frameToView(v, [p.x, p.y]);
  close(back[0], 123, 1e-9); close(back[1], 456, 1e-9);
  // Alt+click an edge in the zoom view → the edge, counted clockwise from the box's own top
  const rect = { cx: 500, cy: 400, w: 60, h: 84, angle: 0 }; // top at y = 358, right at x = 530
  const at = (fx, fy) => G.frameToView(v, [fx, fy]);
  assert.strictEqual(G.viewEdgeAt(v, rect, ...at(500, 358), 12), 0, "top edge");
  assert.strictEqual(G.viewEdgeAt(v, rect, ...at(530, 400), 12), 1, "right edge");
  assert.strictEqual(G.viewEdgeAt(v, rect, ...at(500, 442), 12), 2, "bottom edge");
  assert.strictEqual(G.viewEdgeAt(v, rect, ...at(470, 400), 12), 3, "left edge");
  assert.strictEqual(G.viewEdgeAt(v, rect, ...at(500, 400), 12), null, "the center is no edge");
  // the tolerance is in view px: 12 view px = 4.8 frame px at 2.5×
  assert.strictEqual(G.viewEdgeAt(v, rect, ...at(534.5, 400), 12), 1, "4.5 frame px out: within 12 view px");
  assert.strictEqual(G.viewEdgeAt(v, rect, ...at(535.5, 400), 12), null, "5.5 frame px out: beyond 12 view px");
  // a box turned 90°: its own top is the screen's right side; a click on the screen's top edge is k = 3 (left of the card)
  const r90 = { cx: 500, cy: 400, w: 60, h: 84, angle: 90 }; // on screen: 84 wide, 60 tall
  assert.strictEqual(G.viewEdgeAt(v, r90, ...at(542, 400), 12), 0, "the card's top, on the screen's right");
  assert.strictEqual(G.viewEdgeAt(v, r90, ...at(500, 370), 12), 3, "the screen's top = the card's left");
  // and setting that edge as the top gives a box whose q[0]→q[1] is the screen-top edge
  const q = G.cornersFromRect(r90);
  const nq = G.topEdgeCorners(q, 3);
  close((nq[0][1] + nq[1][1]) / 2, 370, 0.11, "new top edge is the screen's top");
}

// ---- model boxes over kept boxes: which are held back -------------------------------------
{
  const R = (cx, cy, w, h, angle) => ({ cx, cy, w: w || 107, h: h || 150, angle: angle || 0 });
  const iou = (a, b) => require("./labeltools.js").rectIoU(a, b);
  const nap = R(640, 414); // a kept box, the model named it TOY-006
  const kept = [{ rect: nap, card: "TOY-006" }];
  // the toy's frame 3: the Teapot played onto the Nap Attack, 34 px aside (IoU about 0.5), and
  // the model's own box for the Nap Attack too
  const teapot = { rect: R(674, 410), card: "TOY-002" }, napModel = { rect: R(641, 415), card: "TOY-006" };
  assert.ok(iou(teapot.rect, nap) >= G.HOLD_IOU && iou(teapot.rect, nap) < G.OTHER_CARD_IOU);
  assert.deepStrictEqual(G.heldBack([napModel, teapot], kept), [0, -1], "another card, partly over it: offered; its own card: held back");
  // the same model box naming the kept box's own card: held back, as before
  assert.deepStrictEqual(G.heldBack([napModel, { rect: teapot.rect, card: "TOY-006" }], kept), [0, 0], "the same card: held back");
  // the model box is the kept box's own match (no other model box over it): the model calls the
  // same card another name. Held back, whatever the name: no flood of renamed boxes
  assert.deepStrictEqual(G.heldBack([teapot], kept), [0], "another name for the kept box's own card: held back");
  const renamed = { rect: R(646, 418), card: "TOY-001" };
  assert.ok(iou(renamed.rect, nap) < G.OTHER_CARD_IOU);
  assert.deepStrictEqual(G.heldBack([renamed], kept), [0]);
  // a near-copy (IoU ≥ 0.9) is held back even when another model box is the kept box's match
  const copy = { rect: R(642, 416), card: "TOY-001" }, exact = { rect: R(640, 414), card: "TOY-006" };
  assert.ok(iou(copy.rect, nap) >= G.OTHER_CARD_IOU);
  assert.deepStrictEqual(G.heldBack([exact, copy], kept), [0, 0], "IoU ≥ 0.9: a double box, held back");
  // just under 0.9 and not the kept box's match: offered (the bar's other side)
  const under = { rect: R(648, 414), card: "TOY-001" };
  assert.ok(iou(under.rect, nap) < G.OTHER_CARD_IOU && iou(under.rect, nap) > 0.8);
  assert.deepStrictEqual(G.heldBack([exact, under], kept), [0, -1]);
  // HOLD_IOU's two sides, for a box with no card (drawn by hand): held at ≥ 0.3, offered below
  const plain = [{ rect: nap, card: null }];
  const at = (dx) => ({ rect: R(640 + dx, 414), card: "TOY-002" });
  assert.ok(iou(at(55).rect, nap) >= 0.3 && iou(at(60).rect, nap) < 0.3);
  assert.deepStrictEqual(G.heldBack([napModel, at(55)], plain), [0, 0], "no card on the kept box: any model box over it is held back");
  assert.deepStrictEqual(G.heldBack([at(60)], plain), [-1], "under 0.3: offered");
  // a model box with no card is held back as before
  assert.deepStrictEqual(G.heldBack([napModel, { rect: teapot.rect, card: null }], kept), [0, 0]);
  // two ids that are one card (printings) count as the same card
  const same = (a, b) => a.replace(/A$/, "") === b.replace(/A$/, "");
  assert.deepStrictEqual(G.heldBack([napModel, { rect: teapot.rect, card: "TOY-006A" }], kept, same), [0, 0]);
  assert.deepStrictEqual(G.heldBack([], kept), []);
  assert.deepStrictEqual(G.heldBack([teapot], []), [-1]);
}

// ---- a box's card, followed back through kept boxes ----------------------------------------
{
  const rows = {
    f1: [{ id: "P001", outcome: "card", prefill: { i: 0, cardId: "TOY-004" }, labelSource: "prefill-accepted" },
      { id: "B002", outcome: "card", labelSource: "manual", identity: null },
      { id: "B003", outcome: "card-back", labelSource: "manual" }],
    f2: [{ id: "P001", outcome: "card", labelSource: "carried", carriedFrom: { frame: "f1", target: "P001" } },
      { id: "B002", outcome: "card", labelSource: "carried", carriedFrom: { frame: "f1", target: "B002" } },
      { id: "P009", outcome: "card", labelSource: "carried", identity: "TOY-007", carriedFrom: { frame: "f1", target: "gone" } }],
  };
  const lookup = (f, id) => (rows[f] || []).find((t) => t.id === id) || null;
  const kept = { id: "P001", outcome: "card", labelSource: "carried", carriedFrom: { frame: "f2", target: "P001" } };
  assert.strictEqual(G.boxCard(kept, lookup), "TOY-004", "two frames back: the card the model named when it was accepted");
  assert.strictEqual(G.boxCard(rows.f2[1], lookup), null, "drawn by hand, never named");
  assert.strictEqual(G.boxCard(rows.f2[2], lookup), "TOY-007", "its own name wins");
  assert.strictEqual(G.boxCard(rows.f1[2], lookup), null, "a card back has no card");
  assert.strictEqual(G.boxCard({ outcome: "card", ignore: true, identity: "TOY-001" }, lookup), null, "an ignored box neither");
  assert.strictEqual(G.boxCard({ outcome: "card", identity: "unknown", prefill: { cardId: "TOY-002" } }, lookup), "TOY-002");
  assert.strictEqual(G.boxCard(kept, null), null, "no lookup: a kept box's card is not known");
  // a loop of carriedFrom (never written by the tool) ends
  const loop = { a: [{ id: "X", outcome: "card", carriedFrom: { frame: "a", target: "X" } }] };
  assert.strictEqual(G.boxCard(loop.a[0], (f, id) => loop[f].find((t) => t.id === id)), null);
}

// ---- a kept box whose card moved -----------------------------------------------------------
{
  const R = (cx, cy) => ({ cx, cy, w: 107, h: 150, angle: 0 });
  const kept = [{ id: "K1", rect: R(428, 414), card: "TOY-004" }, { id: "K2", rect: R(250, 424), card: "TOY-001" }];
  const proposals = [R(250, 424), R(462, 268)]; // nothing where K1 was; the thief at its new place
  const sugg = [{ id: "P7", rect: R(462, 268), card: "TOY-004" }];
  assert.deepStrictEqual(G.movedPairs(kept, proposals, sugg), [{ kept: "K1", suggestion: "P7" }]);
  // a model box still over the kept box (IoU ≥ STALE_IOU): the card may still be there, no pair
  const near = R(428 + 80, 414);
  assert.ok(G.maxIoU(near, [kept[0].rect]) >= G.STALE_IOU);
  assert.deepStrictEqual(G.movedPairs(kept, proposals.concat([near]), sugg), []);
  const far = R(428 + 95, 414);
  assert.ok(G.maxIoU(far, [kept[0].rect]) < G.STALE_IOU);
  assert.deepStrictEqual(G.movedPairs(kept, proposals.concat([far]), sugg), [{ kept: "K1", suggestion: "P7" }], "under STALE_IOU: nothing there");
  // the suggestion names another card: no pair
  assert.deepStrictEqual(G.movedPairs(kept, proposals, [{ id: "P7", rect: R(462, 268), card: "TOY-005" }]), []);
  // two suggestions of that card, or two stale kept boxes of it: ambiguous, no pair
  assert.deepStrictEqual(G.movedPairs(kept, proposals, sugg.concat([{ id: "P8", rect: R(700, 100), card: "TOY-004" }])), []);
  assert.deepStrictEqual(G.movedPairs(kept.concat([{ id: "K3", rect: R(800, 100), card: "TOY-004" }]), proposals, sugg), []);
  // a kept box without a card is never paired; `same` decides what one card is
  assert.deepStrictEqual(G.movedPairs([{ id: "K1", rect: R(428, 414), card: null }], proposals, sugg), []);
  assert.deepStrictEqual(G.movedPairs(kept, proposals, [{ id: "P7", rect: R(462, 268), card: "TOY-004A" }], (a, b) => a.slice(0, 7) === b.slice(0, 7)),
    [{ kept: "K1", suggestion: "P7" }]);
}

// ---- turning a model's upright box onto a tilted card ---------------------------------------
{
  // the upright bounding box of a w × h card turned by deg
  const upright = (w, h, deg) => {
    const [x0, y0, x1, y1] = G.aabb(G.cornersFromRectRaw({ cx: 400, cy: 300, w, h, angle: deg }));
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  };
  const fits = (r, base, eps, msg) => {
    const [x0, y0, x1, y1] = G.aabb(G.cornersFromRectRaw(r));
    close(x1 - x0, base.w, eps, `${msg} W`); close(y1 - y0, base.h, eps, `${msg} H`);
    close(r.cx, base.cx, 1e-9, `${msg} cx`); close(r.cy, base.cy, 1e-9, `${msg} cy`);
  };
  // the toy's Sock Thief: a 107 × 150 card at −11°, its model box 129 × 170 or so
  for (const deg of [-11, 11, 3, -29.9, 30, 169, -101, 90, 180, 0]) {
    const base = upright(107, 150, deg);
    const r = G.fitRotated(base, deg, 0.5); // the exact solution: the aspect given is not used
    close(r.w, 107, 1e-6, `w at ${deg}°`); close(r.h, 150, 1e-6, `h at ${deg}°`);
    assert.strictEqual(r.angle, deg);
    fits(r, base, 1e-6, `${deg}°`);
  }
  // 0° and 90° give the model's box back (90°: the box's own sides swap)
  const b = { cx: 10, cy: 20, w: 129, h: 170 };
  assert.deepStrictEqual(G.fitRotated(b, 0, 1.4), { cx: 10, cy: 20, w: 129, h: 170, angle: 0 });
  const q = G.fitRotated(b, 90, 1.4);
  close(q.w, 170, 1e-9); close(q.h, 129, 1e-9);
  // beyond 30° from a side the shape comes from the aspect: with the card's own, the card comes back
  for (const deg of [31, 40, 45, -45, 50, 59, 135]) {
    const r = G.fitRotated(upright(107, 150, deg), deg, 150 / 107);
    close(r.w, 107, 1e-6, `w at ${deg}°`); close(r.h, 150, 1e-6, `h at ${deg}°`);
  }
  // at 45° W = H whatever the shape: the aspect keeps the card's shape, the size fits the box
  const r45 = G.fitRotated({ cx: 0, cy: 0, w: 182, h: 182 }, 45, 88 / 63);
  close(r45.h / r45.w, 88 / 63, 1e-9, "45°: the card's shape");
  fits(r45, { cx: 0, cy: 0, w: 182, h: 182 }, 1e-6, "45°");
  // a box that is no tilted card (an exact answer with a side under 0): the aspect, never a negative side
  const odd = G.fitRotated({ cx: 0, cy: 0, w: 200, h: 100 }, 28, 88 / 63);
  assert.ok(odd.w >= G.MIN_BOX && odd.h >= G.MIN_BOX);
  close(odd.h / odd.w, 88 / 63, 1e-9, "an inconsistent box keeps the shape");
  // a model box a few px off: the fit stays near the card (no blow-up within 30°)
  const off = upright(107, 150, -11); off.w += 4; off.h -= 3;
  const ro = G.fitRotated(off, -11, 88 / 63);
  assert.ok(Math.abs(ro.w - 107) < 8 && Math.abs(ro.h - 150) < 8, `${ro.w} × ${ro.h}`);
  // tiny boxes stay at least MIN_BOX
  const tiny = G.fitRotated({ cx: 0, cy: 0, w: 14, h: 14 }, 45, 1);
  assert.ok(tiny.w >= G.MIN_BOX && tiny.h >= G.MIN_BOX);
  // a NaN angle: the upright box as it is, never NaN corners
  assert.deepStrictEqual(G.fitRotated({ cx: 5, cy: 6, w: 100, h: 150 }, NaN, 1.4), { cx: 5, cy: 6, w: 100, h: 150, angle: 0 });
  // an exact answer more than 3 : 1 is no card: the shape comes from the aspect
  const long = G.fitRotated(upright(300, 60, 10), 10, 88 / 63);
  close(long.h / long.w, 88 / 63, 1e-9, "ratio > 3: the aspect");
  // FIT_EXACT_DEG from both sides, with a wrong aspect (1): within 30° the exact solve ignores it
  // and the card comes back; past 30° the aspect decides the shape
  const in30 = G.fitRotated(upright(107, 150, 29.9), 29.9, 1);
  close(in30.w, 107, 1e-6, "29.9°: exact"); close(in30.h, 150, 1e-6, "29.9°: exact");
  const out30 = G.fitRotated(upright(107, 150, 30.1), 30.1, 1);
  close(out30.w, out30.h, 1e-9, "30.1°: the aspect given (square)");
}

// ---- which way a card stands, from the upright box (cardAspect), as the page derives it ----------
{
  const upright = (w, h, deg) => {
    const [x0, y0, x1, y1] = G.aabb(G.cornersFromRectRaw({ cx: 400, cy: 300, w, h, angle: deg }));
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  };
  // the page: 88 / 63 (not the card's true 150 / 107), and the model box's own sides (upright)
  const pageFit = (w, h, deg) => { const b = upright(w, h, deg); return G.fitRotated(b, deg, G.cardAspect(b, deg, 88 / 63, { w: b.w, h: b.h })); };
  for (const deg of [46, 50, 59, 130, -50]) {
    const portrait = pageFit(107, 150, deg); // a unit: standing
    assert.ok(portrait.h > portrait.w, `${deg}°: a portrait card stands (${portrait.w} × ${portrait.h})`);
    assert.ok(Math.abs(portrait.w - 107) < 1.5 && Math.abs(portrait.h - 150) < 1.5, `${deg}°: ${portrait.w} × ${portrait.h}`);
    const landscape = pageFit(150, 107, deg); // a battlefield: lying
    assert.ok(landscape.w > landscape.h, `${deg}°: a landscape card lies (${landscape.w} × ${landscape.h})`);
    assert.ok(Math.abs(landscape.w - 150) < 1.5 && Math.abs(landscape.h - 107) < 1.5, `${deg}°: ${landscape.w} × ${landscape.h}`);
  }
  // the ratio either way round; only a true tie falls back to the box's own shape
  close(G.cardAspect({ w: 100, h: 150 }, 10, 63 / 88), 88 / 63);
  close(G.cardAspect({ w: 150, h: 150 }, 10, 88 / 63, { w: 88, h: 63 }), 63 / 88, 1e-9, "a square box: its own shape");
  close(G.cardAspect({ w: 150, h: 160 }, 45, 88 / 63, { w: 63, h: 88 }), 88 / 63, 1e-9, "45°: its own shape");
  close(G.cardAspect({ w: 150, h: 160 }, 45, 88 / 63), 88 / 63, 1e-9, "no shape given: standing");
}

// ---- the page's glue: one frame's pairs, the move, the arrow, the fit's base -----------------
{
  const box = (id, cx, cy, extra) => Object.assign({ id, corners: G.cornersFromRect({ cx, cy, w: 107, h: 150, angle: 0 }) }, extra);
  const kept = box("K1", 428, 414, { labelSource: "carried", outcome: "card", carriedFrom: { frame: "f2", target: "K1" }, angle: undefined });
  const edited = box("K2", 250, 424, { labelSource: "carried-corrected", outcome: "card" });
  const sugg = box("P7", 462, 268, { pending: true, suggestion: true, prefill: { i: 3, cardId: "TOY-004", corners: [] } });
  const model = box("P8", 674, 410, { pending: true, prefill: { i: 4, cardId: "TOY-004" } }); // not a suggestion
  const ts = [kept, edited, sugg, model];
  const rects = [G.rectFromCorners(sugg.corners), G.rectFromCorners(model.corners)];
  const cardOf = (t) => (t.id === "K1" ? "TOY-004" : "TOY-001");
  assert.deepStrictEqual(G.movedOnFrame(ts, rects, cardOf), [{ kept: "K1", suggestion: "P7" }]);
  assert.deepStrictEqual(G.movedOnFrame(ts, rects, cardOf, null, (t) => t.id === "K1"), [], "a box being adjusted is not paired");
  assert.deepStrictEqual(G.movedOnFrame([edited, sugg], rects, () => "TOY-004"), [], "an edited kept box is the labeler's own");
  // the move: the suggestion's corners and turn, the kept box's id and the rest
  const k = Object.assign({}, kept, { identity: "TOY-004", angle: -11, ignore: undefined });
  const s2 = Object.assign({}, sugg, { angle: 90 });
  G.moveOnto(k, s2);
  assert.deepStrictEqual(k.corners, s2.corners); assert.notStrictEqual(k.corners, s2.corners, "a copy");
  assert.strictEqual(k.angle, 90); assert.strictEqual(k.id, "K1"); assert.strictEqual(k.identity, "TOY-004");
  assert.deepStrictEqual(k.carriedFrom, { frame: "f2", target: "K1" }); assert.strictEqual(k.labelSource, "carried");
  G.moveOnto(k, sugg);
  assert.ok(!("angle" in k), "an upright suggestion: no angle");
  // the arrow: a shaft and a head of two strokes ending at the target; nothing for a point
  const a = G.arrow(0, 0, 100, 0, 12);
  assert.strictEqual(a.length, 3);
  assert.deepStrictEqual(a[0], [[0, 0], [100, 0]]);
  assert.deepStrictEqual(a[1][1].map((v) => Math.round(v)), [88, -6]); assert.deepStrictEqual(a[2][1].map((v) => Math.round(v)), [88, 6]);
  assert.deepStrictEqual(G.arrow(5, 5, 6, 6), []);
  // upright: the bounding box on screen; a model box is its own fit base (at a quarter turn too)
  assert.deepStrictEqual(G.upright([[10, 20], [110, 20], [110, 170], [10, 170]]), { cx: 60, cy: 95, w: 100, h: 150 });
  const p = G.prefillTarget({ box: [10, 20, 100, 150] }, 0, 1920, 1080, "P1");
  assert.deepStrictEqual(G.fitBase(p, null), { cx: 60, cy: 95, w: 100, h: 150 });
  const q = G.prefillTarget({ box: [10, 20, 100, 150], rot: 1 }, 0, 1920, 1080, "P2");
  assert.strictEqual(q.angle, 90);
  assert.deepStrictEqual(G.fitBase(q, null), { cx: 60, cy: 95, w: 100, h: 150 }, "a quarter turn from the model: still its box");
  const moved = Object.assign({}, p, { corners: G.translateCorners(p.corners, 5, 0, 1920, 1080) });
  assert.strictEqual(G.fitBase(moved, null), null, "moved: no base");
  assert.strictEqual(G.fitBase({ corners: p.corners }, null), null, "not a model box");
  // `last` (the page's record of a fit or an m): its base holds while the box is only turned since
  const rec = (t, base) => G.fitRecord(null, base, G.rectFromCorners(t.corners, t.angle));
  const last = rec(moved, { cx: 1, cy: 2, w: 3, h: 4 });
  assert.deepStrictEqual(G.fitBase(moved, last), last.base, "as the last fit left it: that fit's base");
  const movedTurned = Object.assign({}, moved, { corners: G.cornersFromRect(Object.assign(G.rectFromCorners(moved.corners), { angle: 17 })), angle: 17 });
  assert.deepStrictEqual(G.fitBase(movedTurned, last), last.base, "turned since: still that base");
  assert.strictEqual(G.fitBase(null, last), null);
  // a stale `last` (the box was moved or resized since) is not used: the model's own box, or nothing
  const stale = rec(Object.assign({}, p, { corners: G.translateCorners(p.corners, 9, 0, 1920, 1080) }), { cx: 1, cy: 2, w: 3, h: 4 });
  assert.deepStrictEqual(G.fitBase(p, stale), { cx: 60, cy: 95, w: 100, h: 150 }, "a model box: its own base, not the stale one");
  assert.strictEqual(G.fitBase(moved, stale), null, "moved since: no base");
  // a model box cut by the frame's edge is no card's upright box
  const cutBox = () => G.prefillTarget({ box: [0, 20, 100, 150] }, 0, 1920, 1080, "P3");
  const cut = cutBox();
  assert.strictEqual(G.fitBase(cut, null, 1920, 1080), null, "touches the left edge");
  assert.deepStrictEqual(G.fitBase(cut, null), { cx: 50, cy: 95, w: 100, h: 150 }, "no frame size: not checked");
  assert.ok(G.fitBase(p, null, 1920, 1080), "inside the frame");
  assert.strictEqual(G.atEdge(G.prefillTarget({ box: [1820, 20, 100, 150] }, 0, 1920, 1080, "P4").corners, 1920, 1080), true, "right edge");
  assert.strictEqual(G.atEdge(G.prefillTarget({ box: [10, 930, 100, 150] }, 0, 1920, 1080, "P5").corners, 1920, 1080), true, "bottom edge");
  assert.strictEqual(G.atEdge(p.corners, 1920, 1080), false);
  // ---- the fit action's availability (fitState) and its result (fitRect, needsFit) ----
  const turn = (t, deg) => { const r = G.rectFromCorners(t.corners, t.angle); r.angle = deg; return Object.assign({}, t, { corners: G.cornersFromRect(r), angle: deg }); };
  assert.deepStrictEqual(G.fitState(null), { reason: "none" });
  assert.deepStrictEqual(G.fitState(p, null, 1920, 1080), { base: { cx: 60, cy: 95, w: 100, h: 150 }, ref: { cx: 60, cy: 95, w: 100, h: 150 } }, "the model's box as given");
  assert.deepStrictEqual(G.fitState(turn(p, -11), null, 1920, 1080).base, { cx: 60, cy: 95, w: 100, h: 150 }, "turned (knob, r, R): same size and center");
  assert.ok(G.fitState(turn(p, 90), null, 1920, 1080).base, "a quarter turn (w)");
  const top = Object.assign({}, p, { corners: G.topEdgeCorners(p.corners, 1), angle: 90 });
  assert.ok(G.fitState(top, null, 1920, 1080).base, "another top edge (Alt+click): the same rectangle");
  assert.deepStrictEqual(G.fitState(top, null, 1920, 1080).ref, { cx: 60, cy: 95, w: 150, h: 100 }, "the reference with the box's own sides");
  const bigger = Object.assign({}, p, { corners: G.cornersFromRect(Object.assign(G.rectFromCorners(p.corners), { w: 110 })) });
  assert.deepStrictEqual(G.fitState(bigger, null, 1920, 1080), { reason: "edited" }, "resized");
  assert.deepStrictEqual(G.fitState(moved, null, 1920, 1080), { reason: "edited" }, "moved");
  assert.deepStrictEqual(G.fitState({ corners: p.corners, labelSource: "manual" }, null, 1920, 1080), { reason: "edited" }, "drawn by hand");
  assert.deepStrictEqual(G.fitState({ corners: p.corners, labelSource: "carried" }, null, 1920, 1080), { reason: "edited" }, "kept, no record");
  assert.deepStrictEqual(G.fitState(turn(cutBox(), 12), null, 1920, 1080).reason, "edge", "the model's box at the frame's edge");
  assert.ok(G.fitState(turn(cutBox(), 12), null, 1920, 1080).ref, "still turned from its exact reference");
  // the fit: at the box's own angle, inside the base; a box turned and larger than its fit needs it
  const ub = G.upright(G.cornersFromRectRaw({ cx: 400, cy: 300, w: 107, h: 150, angle: -10.6 })); // a tight model box
  const card = G.prefillTarget({ box: [ub.cx - ub.w / 2, ub.cy - ub.h / 2, ub.w, ub.h] }, 0, 1920, 1080, "PT");
  const tilted = turn(card, -10.6);
  const f = G.fitRect(tilted, G.fitBase(tilted, null, 1920, 1080));
  assert.strictEqual(f.angle, -10.6);
  assert.ok(Math.abs(f.w - 107) < 0.3 && Math.abs(f.h - 150) < 0.3, `${f.w} × ${f.h}`);
  assert.strictEqual(G.needsFit(tilted, null, 1920, 1080), true, "turned and larger: the line says so");
  assert.strictEqual(G.needsFit(card, null, 1920, 1080), false, "not turned");
  const fitted = Object.assign({}, tilted, { corners: G.cornersFromRect(f) });
  assert.strictEqual(G.needsFit(fitted, rec(fitted, G.upright(card.corners)), 1920, 1080), false, "fitted already");
  assert.strictEqual(G.needsFit(fitted, null, 1920, 1080), false, "fitted, no record: no base, no hint");
  // ---- the page's sequence, as the page stores boxes: corners rounded to 0.1 px ----
  const W1 = 1920, H1 = 1080;
  const put = (t, r) => Object.assign({}, t, { corners: G.cornersFromRect(r), angle: G.roundAngle(r.angle) || undefined });
  const turnBy = (t, last, d) => put(t, G.turnRect(t, G.normalizeAngle(G.rectFromCorners(t.corners, t.angle).angle + d), last, W1, H1));
  const fitOnce = (t, last) => { const st = G.fitState(t, last, W1, H1); const f = G.fitRect(t, st.base); return [put(t, f), G.fitRecord(last, st.base, f)]; };
  {
    // e -> turn -> e -> undo: the box is back as the first fit left it (then turned) and still fits
    let t = turnBy(card, null, 11), last = null;
    [t, last] = fitOnce(t, last);
    const afterFirst = t = turnBy(t, last, 5);
    [t, last] = fitOnce(t, last);
    assert.ok(G.fitState(t, last, W1, H1).base);
    assert.ok(G.fitState(afterFirst, last, W1, H1).base, "undo of the second e: still fittable");
    assert.deepStrictEqual(G.fitAction(afterFirst, last, W1, H1).base, G.upright(card.corners));
    // m -> turn -> e -> undo: a kept box with no model box of its own
    const kept = { id: "K", corners: G.cornersFromRect({ cx: 500, cy: 300, w: 129.2, h: 169.8, angle: 0 }), labelSource: "carried" };
    let lastK = G.fitRecord(null, G.upright(kept.corners), G.rectFromCorners(kept.corners));
    const turned = turnBy(kept, lastK, -8);
    let k2; [k2, lastK] = fitOnce(turned, lastK);
    assert.ok(G.fitState(k2, lastK, W1, H1).base);
    assert.ok(G.fitState(turned, lastK, W1, H1).base, "undo of e after m: still fittable");
    assert.deepStrictEqual(G.fitState(kept, lastK, W1, H1).base, G.upright(kept.corners), "undo of the turn too");
    // a record for another base starts again
    assert.strictEqual(G.fitRecord(lastK, { cx: 0, cy: 0, w: 1, h: 1 }, { cx: 0, cy: 0, w: 1, h: 1 }).rects.length, 1);
    assert.strictEqual(lastK.rects.length, 2);
    // pressing e on a box that already fits adds nothing
    const top = lastK.rects[1];
    assert.strictEqual(G.fitRecord(lastK, lastK.base, { ...top, angle: -8 }), lastK);
  }
  {
    // 60 random r / R presses (and a fit now and then) never drift the box out of its base: each
    // turn is made from the exact reference, not from the rounded corners
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let run = 0; run < 20; run++) {
      let t = card, last = null;
      for (let n = 0; n < 60; n++) {
        t = turnBy(t, last, rnd() < 0.5 ? -1 : 5);
        if (rnd() < 0.1 && G.fitAction(t, last, W1, H1).base) [t, last] = fitOnce(t, last);
        assert.ok(G.fitState(t, last, W1, H1).base, `run ${run}, press ${n}: refused`);
      }
    }
    // the reference keeps a nudge out: 1 px off is not a turn
    const nudged = Object.assign({}, card, { corners: G.translateCorners(card.corners, 1, 0, W1, H1) });
    assert.deepStrictEqual(G.fitState(nudged, null, W1, H1).reason, "edited");
    assert.deepStrictEqual(G.turnRect(nudged, 10, null, W1, H1).cx, G.rectFromCorners(nudged.corners).cx, "no reference: from its own corners");
  }
  // fitAction: upright (a quarter turn) has nothing to fit; turned it does
  assert.deepStrictEqual(G.fitAction(card, null, W1, H1), { reason: "upright" });
  assert.deepStrictEqual(G.fitAction(turnBy(card, null, 90), null, W1, H1), { reason: "upright" });
  assert.ok(G.fitAction(turnBy(card, null, 3), null, W1, H1).base);
  assert.deepStrictEqual(G.fitAction(moved, null, W1, H1).reason, "edited");
  // heldBack keeps the proposals' positions: a null stays null
  assert.deepStrictEqual(G.heldBack([null, { rect: rects[0], card: "X" }], []), [null, -1]);
}

// ---- visible parts (the stacking view) -----------------------------------------------------
{
  const CW = 126, CH = 176; // a synthetic 63:88 card
  const bx = (x, y, extra) => Object.assign({ corners: [[x, y], [x + CW, y], [x + CW, y + CH], [x, y + CH]] }, extra || {});
  const xs = (c) => [Math.min(...c.map((p) => p[0])), Math.max(...c.map((p) => p[0]))];
  const TOLV = 1; // frame px: the grid is under a pixel a cell here

  // a stack drawn left to right, each box on top of the one before: 40 px of each lower box shows
  const ltr = [0, 1, 2, 3].map((i) => bx(100 + 40 * i, 50));
  const v = G.visibleParts(ltr);
  assert.deepStrictEqual(v.map((p) => p.rank), [1, 2, 3, 4]);
  for (let i = 0; i < 3; i++) {
    const [x0, x1] = xs(v[i].corners);
    close(x0, 100 + 40 * i, TOLV, "left edge");
    close(x1, 140 + 40 * i, TOLV, "right edge at the box above");
    assert.ok(x1 <= 140 + 40 * i + 0.05, "never reaches into the box above");
    close(v[i].share, 40 / CW, 0.01, "share");
  }
  assert.deepStrictEqual(v[3].corners, ltr[3].corners, "the top box keeps its corners");
  assert.strictEqual(v[3].share, 1);

  // the same boxes, each restacked UNDER the one before (zOrder): the right part shows
  const rtl = [0, 1, 2, 3].map((i) => bx(100 + 40 * i, 50, { zOrder: 10 - i }));
  const w = G.visibleParts(rtl);
  assert.deepStrictEqual(w.map((p) => p.rank), [4, 3, 2, 1]);
  for (let i = 1; i < 4; i++) close(xs(w[i].corners)[0], 100 + 40 * i + CW - 40, TOLV, "right part");

  // the middle box brought to the front cuts both neighbors
  const mid = G.visibleParts([bx(100, 50), bx(160, 50, { zOrder: 5 }), bx(220, 50)]);
  close(xs(mid[0].corners)[1], 160, TOLV);
  close(xs(mid[2].corners)[0], 286, TOLV);

  // a tilted box stays tilted, in its own corner order
  const tilt = (cx, cy, deg) => ({ corners: G.cornersFromRectRaw({ cx, cy, w: CW, h: CH, angle: deg }) });
  const a = (20 * Math.PI) / 180;
  const tv = G.visibleParts([tilt(300, 300, 20), tilt(300 + 63 * Math.cos(a), 300 + 63 * Math.sin(a), 20)]);
  const c = tv[0].corners;
  close((Math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0]) * 180) / Math.PI, 20, 0.1, "tilt kept");
  close(Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]), 63, TOLV, "half the width");
  close(tv[0].share, 0.5, 0.01);

  // an ignore box covers like any other box; a wholly covered box has no visible part
  const ig = G.visibleParts([bx(100, 50), bx(180, 50, { ignore: true })]);
  close(xs(ig[0].corners)[1], 180, TOLV);
  const hid = G.visibleParts([bx(100, 50), { corners: [[90, 40], [290, 40], [290, 240], [90, 240]] }]);
  assert.strictEqual(hid[0].corners, null);
  assert.strictEqual(hid[0].share, 0);

  // a box only touching another one's edge is not covered; the result is deterministic
  const touch = G.visibleParts([bx(100, 50), bx(100 + CW, 50)]);
  assert.strictEqual(touch[0].share, 1);
  assert.deepStrictEqual(G.visibleParts(ltr), v);
}

// ---- a box beside another (D then an arrow) --------------------------------------------------
{
  const r = { cx: 300, cy: 200, w: 100, h: 140, angle: 0 };
  assert.deepStrictEqual(G.besideRect(r, "right"), { cx: 400, cy: 200, w: 100, h: 140, angle: 0 });
  assert.deepStrictEqual(G.besideRect(r, "left"), { cx: 200, cy: 200, w: 100, h: 140, angle: 0 });
  assert.deepStrictEqual(G.besideRect(r, "down"), { cx: 300, cy: 340, w: 100, h: 140, angle: 0 });
  assert.deepStrictEqual(G.besideRect(r, "up"), { cx: 300, cy: 60, w: 100, h: 140, angle: 0 });
  assert.strictEqual(G.besideRect(r, "sideways"), null);
  // the new box touches the old one along a whole side: shared corners, no gap, no overlap
  const c0 = G.cornersFromRectRaw(r), c1 = G.cornersFromRectRaw(G.besideRect(r, "right"));
  close(c1[0][0], c0[1][0], 1e-9); close(c1[3][1], c0[2][1], 1e-9);
  // a box turned a quarter (a card lying sideways): "right" on screen is along its own left edge,
  // so the step is its height, and the new box keeps the turn
  const q = { cx: 300, cy: 200, w: 100, h: 140, angle: 90 };
  const qr = G.besideRect(q, "right");
  close(qr.cx, 440, 1e-9); close(qr.cy, 200, 1e-9); assert.strictEqual(qr.angle, 90); assert.strictEqual(qr.w, 100);
  // a tilted box: the neighbor stays in the box's own row, a full width along its top edge
  const t = { cx: 300, cy: 200, w: 100, h: 140, angle: 20 };
  const tr = G.besideRect(t, "right");
  close(Math.hypot(tr.cx - 300, tr.cy - 200), 100, 1e-9);
  close((Math.atan2(tr.cy - 200, tr.cx - 300) * 180) / Math.PI, 20, 1e-9);
  // the visible parts of a row built this way: each box wholly visible (they only touch)
  const row = [r, G.besideRect(r, "right")].map((x) => ({ corners: G.cornersFromRectRaw(x) }));
  assert.deepStrictEqual(G.visibleParts(row).map((p) => p.share), [1, 1]);
}

// ---- stacks: overlaps, layers within a stack, a layer up / down among overlapping boxes --------
{
  const sq = (x, y, w, h) => ({ corners: [[x, y], [x + (w || 100), y], [x + (w || 100), y + (h || 140)], [x, y + (h || 140)]] });
  assert.ok(G.quadsOverlap(sq(0, 0).corners, sq(50, 0).corners));
  assert.ok(!G.quadsOverlap(sq(0, 0).corners, sq(100, 0).corners), "touching is not overlapping");
  assert.ok(!G.quadsOverlap(sq(0, 0).corners, sq(300, 0).corners));
  // a tilted box near the corner of another: the separating axis is the tilted one's
  const tl = { corners: G.cornersFromRectRaw({ cx: 185, cy: 70, w: 100, h: 140, angle: 45 }) };
  assert.ok(!G.quadsOverlap(sq(0, 0).corners, tl.corners));

  // two stacks and a lone box: layers count within each stack; a chain is one stack
  const ts = [sq(0, 0), sq(500, 0), sq(50, 0), sq(900, 0), sq(550, 0), sq(100, 0)];
  const L = G.stackLayers(ts);
  assert.deepStrictEqual(L.map((x) => x.layer), [1, 1, 2, 1, 2, 3]);
  assert.deepStrictEqual(L.map((x) => x.size), [3, 2, 3, 1, 2, 3]);
  assert.strictEqual(L[0].stack, L[2].stack); assert.strictEqual(L[0].stack, L[5].stack);
  assert.notStrictEqual(L[0].stack, L[1].stack);
  // a chain: 0 overlaps 1, 1 overlaps 2, 0 and 2 do not touch
  const chain = G.stackLayers([sq(0, 0), sq(80, 0), sq(160, 0)]);
  assert.deepStrictEqual(chain.map((x) => [x.size, x.layer]), [[3, 1], [3, 2], [3, 3]]);

  // `.` moves past the next OVERLAPPING box, skipping boxes elsewhere in the frame
  // order (bottom first): 0 (stack A), 1 (elsewhere), 2 (stack A)
  const fr = [sq(0, 0), sq(700, 0), sq(50, 0)];
  const z = G.reorderAmongOverlaps(fr, 0, 1);
  assert.deepStrictEqual(z, [2, 0, 1], "box 0 jumps above box 2, over the unrelated box 1");
  assert.strictEqual(G.reorderAmongOverlaps(fr, 2, 1), null, "nothing overlapping above");
  const down = G.reorderAmongOverlaps(fr, 2, -1);
  assert.deepStrictEqual(down, [1, 2, 0], "box 2 drops just below box 0");
  assert.strictEqual(G.reorderAmongOverlaps(fr, 1, 1), null, "a lone box has no overlapping box to pass");
  // in a stack of three, one press passes exactly one overlapping box
  const st = [sq(0, 0), sq(40, 0), sq(80, 0)];
  assert.deepStrictEqual(G.reorderAmongOverlaps(st, 0, 1), [1, 0, 2]);
  assert.deepStrictEqual(G.reorderAmongOverlaps(st, 2, -1), [0, 2, 1]);
  // the plain frame-wide reorder is unchanged
  assert.deepStrictEqual(G.reorder(fr, 0, 1), [1, 0, 2]);

  // a step changes the visible parts of its own stack only: every other box comes out the same
  const frame = [sq(0, 0), sq(500, 0), sq(60, 0), sq(900, 0), sq(560, 0), sq(120, 0), sq(620, 0)];
  const before = G.visibleParts(frame);
  const stackOf = G.stackLayers(frame).map((x) => x.stack);
  for (const [idx, dir] of [[0, 1], [5, -1], [1, 1], [6, -1], [2, 1]]) {
    const z = G.reorderAmongOverlaps(frame, idx, dir);
    assert.ok(z, `step ${idx} ${dir}`);
    const after = G.visibleParts(frame.map((t, i) => Object.assign({}, t, { zOrder: z[i] })));
    let changed = false;
    frame.forEach((_, i) => {
      if (stackOf[i] !== stackOf[idx]) assert.deepStrictEqual([after[i].corners, after[i].share], [before[i].corners, before[i].share], `box ${i} outside the stack`);
      else if (JSON.stringify(after[i].corners) !== JSON.stringify(before[i].corners)) changed = true;
    });
    assert.ok(changed, "the step changed its own stack");
  }
}

// ---- several boxes copied and pasted as one group ----------------------------------------------
{
  const mk = (id, x, extra) => Object.assign({ id, corners: [[x, 100], [x + 100, 100], [x + 100, 240], [x, 240]], outcome: "card" }, extra || {});
  const src = [mk("B1", 100), mk("B2", 160, { outcome: "card-back" }), mk("B3", 220, { ignore: true, identity: "NEW-001" })];
  const clips = src.map((t) => G.makeClip(t, "f1.jpg"));
  // the same frame: the group moves 12 px together, each box keeping its kind
  const g = G.pasteGroup(clips, "f1.jpg", W, H, ["B4", "B5", "B6"], [null, null, null]);
  assert.deepStrictEqual(g.targets.map((t) => t.corners[0]), [[112, 112], [172, 112], [232, 112]]);
  assert.deepStrictEqual(g.targets.map((t) => [t.outcome, !!t.ignore]), [["card", false], ["card-back", false], ["card", true]]);
  // another frame: exactly where they were; zOrders from the caller
  const o = G.pasteGroup(clips, "f2.jpg", W, H, ["B1", "B2", "B3"], [5, 6, 7]);
  assert.deepStrictEqual(o.targets.map((t) => t.corners), src.map((t) => t.corners));
  assert.deepStrictEqual(o.targets.map((t) => t.zOrder), [5, 6, 7]);
  // a group near the edge moves inside as one: the spacing between its boxes is kept
  const edge = [mk("B1", 1800), mk("B2", 1860)].map((t) => G.makeClip(t, "f1.jpg")); // runs 40 px off the right edge
  const e = G.pasteGroup(edge, "f2.jpg", 1920, 1080, ["B1", "B2"], [null, null]);
  assert.deepStrictEqual(e.targets.map((t) => t.corners[1][0]), [1860, 1920]);
  close(e.targets[1].corners[0][0] - e.targets[0].corners[0][0], 60, 1e-9, "spacing kept");
  // a group wider than the frame is refused whole, never pasted in part
  const wide = [mk("B1", 0), mk("B2", 1900)].map((t) => G.makeClip(t, "f1.jpg"));
  const r = G.pasteGroup(wide, "f2.jpg", 1920, 1080, ["B1", "B2"], [null, null]);
  assert.ok(r.refused && !r.targets);
  // one box: exactly pasteTarget
  assert.deepStrictEqual(G.pasteGroup([clips[0]], "f1.jpg", W, H, ["B9"], [null]).targets[0], G.pasteTarget(clips[0], "f1.jpg", W, H, "B9", null));
}

// ---- new target ids: several at once never share one ---------------------------------
{
  // a gap in the ids (B002 deleted): a two-box paste once got B004 twice
  const ts = [{ id: "B001" }, { id: "B003" }];
  const ids = G.newTargetIds(ts, 2, "B");
  assert.strictEqual(ids.length, 2);
  assert.notStrictEqual(ids[0], ids[1], "two pasted boxes, two ids");
  for (const id of ids) assert.ok(!ts.some((t) => t.id === id), `${id} is new`);
  assert.deepStrictEqual(ids, ["B004", "B005"]);
  // no gap: the numbers go on from the count, as before
  assert.deepStrictEqual(G.newTargetIds([{ id: "B001" }, { id: "B002" }], 3, "B"), ["B003", "B004", "B005"]);
  // ids of another prefix do not block, a run of taken ones is skipped, an empty frame starts at 1
  assert.deepStrictEqual(G.newTargetIds([{ id: "P003" }, { id: "B003" }, { id: "B004" }], 2, "B"), ["B005", "B006"]);
  assert.deepStrictEqual(G.newTargetIds(undefined, 2, "Q"), ["Q001", "Q002"]);
  assert.deepStrictEqual(G.newTargetIds([], 0, "B"), []);
  // the paste itself keeps the ids it is given, so the group's ids are distinct end to end
  const clips = [{ cx: 300, cy: 300, w: 60, h: 84 }, { cx: 400, cy: 300, w: 60, h: 84 }]
    .map((r, k) => G.makeClip({ id: `B00${k + 1}`, corners: G.cornersFromRect(r), outcome: "card" }, "f0.jpg"));
  const res = G.pasteGroup(clips, "f1.jpg", W, H, ids, [null, null]);
  assert.deepStrictEqual(res.targets.map((t) => t.id), ids);
}

// ---- resize of a turned box: every corner within export.py's QUAD_RANGE ----------------
{
  // the bound is export.py's own
  const py = require("fs").readFileSync(require("path").join(__dirname, "export.py"), "utf8");
  const m = py.match(/^QUAD_RANGE = \((-?[\d.]+), (-?[\d.]+)\)/m);
  assert.ok(m, "export.py defines QUAD_RANGE");
  assert.deepStrictEqual(G.QUAD_RANGE, [Number(m[1]), Number(m[2])], "boxgeom.js and export.py agree on QUAD_RANGE");
  const inRange = (c, w, h) => c.every((p) => p[0] >= -w && p[0] <= 2 * w && p[1] >= -h && p[1] <= 2 * h);
  assert.ok(G.cornersInRange([[0, 0], [W, 0], [W, H], [0, H]], W, H));
  assert.ok(G.cornersInRange([[-W, -H], [2 * W, -H], [2 * W, 2 * H], [-W, 2 * H]], W, H), "the bound itself is inside");
  assert.ok(!G.cornersInRange([[-W - 0.1, 0], [W, 0], [W, H], [0, H]], W, H));
  const handles = ["tl", "tr", "br", "bl", "t", "b", "l", "r"];
  const origs = [];
  for (const [cx, cy] of [[960, 540], [20, 20], [1900, 1060], [-200, 540], [960, 1250], [2100, -150]])
    for (const [w, h] of [[120, 168], [400, 560], [1500, 900]]) origs.push({ cx, cy, w, h });
  const ptrs = [];
  for (let x = -2 * W; x <= 3 * W; x += W / 4) for (let y = -2 * H; y <= 3 * H; y += H / 4) ptrs.push({ x, y });
  let tried = 0, kept = 0, wouldEscape = 0;
  for (let angle = -179; angle <= 180; angle += 7) {
    for (const o0 of origs) {
      const o = Object.assign({}, o0, { angle });
      if (!G.cornersInRange(G.cornersFromRect(o), W, H)) continue; // a resize starts from a box the export takes
      for (const hd of handles) for (const p of ptrs) {
        tried++;
        const raw = G.resizeRect(o, hd, G.resizePoint(p, angle, W, H), G.MIN_BOX);
        if (!inRange(G.cornersFromRect(raw), W, H)) wouldEscape++;
        const r = G.resizeWithin(o, hd, p, W, H, G.MIN_BOX);
        if (!r) continue;
        kept++;
        const c = G.cornersFromRect(Object.assign({}, r, { angle: G.roundAngle(r.angle) }));
        assert.ok(inRange(c, W, H), `angle ${angle} handle ${hd} at ${p.x},${p.y}: ${JSON.stringify(c)}`);
      }
    }
  }
  assert.ok(wouldEscape > 0, "the sweep reaches resizes that the handle bound alone lets past the range");
  assert.ok(kept > tried / 2, `most resizes are still allowed (${kept} of ${tried})`);
  // an upright box is never refused: setRect cuts it at the frame
  assert.ok(G.resizeWithin({ cx: 100, cy: 100, w: 60, h: 80, angle: 0 }, "br", { x: 9999, y: 9999 }, W, H, G.MIN_BOX));
  // a box already past the range: a resize toward it is allowed, one further out is refused
  const past = { cx: 960, cy: 540, w: 5900, h: 400, angle: 10 };
  const pastC = G.cornersFromRect(past);
  assert.ok(!G.cornersInRange(pastC, W, H));
  const before = G.rangeExcess(pastC, W, H);
  assert.ok(before > 0);
  const toward = G.resizeWithin(past, "r", { x: past.cx + 2000, y: past.cy }, W, H, G.MIN_BOX);
  assert.ok(toward && G.rangeExcess(G.cornersFromRect(toward), W, H) <= before, "shorter: allowed");
  assert.strictEqual(G.resizeWithin(past, "b", { x: past.cx, y: 1600 }, W, H, G.MIN_BOX), null, "taller: refused");
  assert.strictEqual(G.rangeExcess([[0, 0], [W, H]], W, H), 0);
  // the unit is a fraction of the frame, so a frame that is not square is judged as the export does
  close(G.rangeExcess([[-W - W / 10, 0], [W, 2 * H + H / 20]], W, H), 0.1);
  close(G.rangeExcess([[0, 205]], 2000, 100), 0.05, 1e-9, "5 px over a 100 px frame is 0.05, not 5");
  // a corner exactly on the limit is within it, and further out is not
  const edge = [[-W, -H], [2 * W, 2 * H]];
  assert.strictEqual(G.rangeExcess(edge, W, H), 0);
  assert.ok(G.rangeNoWorse(edge, edge, W, H) && G.rangeNoWorse(edge, [[0, 0]], W, H));
  assert.ok(!G.rangeNoWorse([[2 * W + 1, 0]], [[0, 0]], W, H));
  // from an in-range box, rangeNoWorse agrees with cornersInRange
  for (const c of [[[0, 0], [W, H]], [[-W, 0], [2 * W, 5]], [[-W - 1, 0]], [[0, 2 * H + 1]], [[3 * W, 0]]]) {
    assert.strictEqual(G.rangeNoWorse(c, [[10, 10]], W, H), G.cornersInRange(c, W, H));
  }
  // a turned box dragged a little past the edge still resizes
  assert.ok(G.resizeWithin({ cx: 100, cy: 100, w: 60, h: 80, angle: 30 }, "tl", { x: -40, y: -40 }, W, H, G.MIN_BOX));
}

// ---- a box with free corners (Shift+drag a corner in the Boxes pass) ---------------------
{
  const box = { id: "B001", corners: G.cornersFromRect({ cx: 500, cy: 400, w: 120, h: 168, angle: 20 }), angle: 20, cornerSource: "box" };
  assert.ok(!G.isQuad(box) && G.isQuad({ cornerSource: "hand" }) && !G.isQuad(null));
  // the gesture: Shift+drag on a corner of a box frees it; a quad's own handles move on their own
  assert.strictEqual(G.quadDragMode(box, { mode: "resize", handle: "br" }, true), "corner");
  assert.strictEqual(G.quadDragMode(box, { mode: "resize", handle: "br" }, false), null, "a plain corner drag resizes, as before");
  assert.strictEqual(G.quadDragMode(box, { mode: "resize", handle: "b" }, true), null, "Shift on an edge: a plain resize");
  assert.strictEqual(G.quadDragMode(box, { mode: "rotate" }, true), null);
  const q0 = Object.assign({}, box, { cornerSource: "hand" });
  delete q0.angle;
  assert.strictEqual(G.quadDragMode(q0, { mode: "resize", handle: "tl" }, false), "corner");
  assert.strictEqual(G.quadDragMode(q0, { mode: "resize", handle: "l" }, false), "edge");
  assert.strictEqual(G.quadDragMode(q0, { mode: "rotate" }, false), "qrotate");
  assert.strictEqual(G.quadDragMode(q0, { mode: "move" }, false), null);

  // detach: one corner moves, the other three stay exactly; the page then stores it as hand
  const br = box.corners[2];
  const d = { mode: "corner", handle: "br", corners: box.corners, start: { x: br[0], y: br[1] } };
  const r1 = G.quadDrag(d, { x: br[0] + 15, y: br[1] + 9 }, W, H);
  assert.ok(r1.corners, JSON.stringify(r1));
  assert.deepStrictEqual([r1.corners[0], r1.corners[1], r1.corners[3]], [box.corners[0], box.corners[1], box.corners[3]]);
  assert.deepStrictEqual(r1.corners[2], [G.r1(br[0] + 15), G.r1(br[1] + 9)]);
  const t = G.setQuadCorners(JSON.parse(JSON.stringify(box)), r1.corners);
  assert.ok(G.isQuad(t) && t.angle === undefined, "a freed box keeps no angle");
  assert.ok(!G.isRectangle(t.corners) && G.isConvexQuad(t.corners, G.MIN_BOX));
  // the card's own top stays: the first corner and the top edge are where they were
  assert.deepStrictEqual(t.corners.slice(0, 2), box.corners.slice(0, 2));
  // each corner alone
  for (let i = 0; i < 4; i++) {
    const p = t.corners[i], m = G.moveQuadCorner(t.corners, i, { x: p[0] + 3, y: p[1] - 2 }, W, H);
    assert.ok(m.corners, `corner ${i}`);
    for (let k = 0; k < 4; k++) if (k !== i) assert.deepStrictEqual(m.corners[k], t.corners[k], `corner ${i} moves only itself`);
  }
  // convexity: a drag that folds the box over (a corner across the opposite diagonal), bends a
  // corner inward, or makes a side shorter than MIN_BOX is refused
  const c = t.corners, mid = G.quadCenter(c);
  assert.strictEqual(G.moveQuadCorner(c, 2, { x: c[0][0] - 30, y: c[0][1] - 30 }, W, H).refused, "fold", "dragged past the opposite corner");
  assert.strictEqual(G.moveQuadCorner(c, 1, { x: c[3][0] - 5, y: c[3][1] + 5 }, W, H).refused, "fold", "across the diagonal");
  assert.strictEqual(G.moveQuadCorner(c, 2, { x: mid.x + (c[0][0] - mid.x) * 0.3, y: mid.y + (c[0][1] - mid.y) * 0.3 }, W, H).refused, "fold", "bent inward past the middle");
  assert.strictEqual(G.moveQuadCorner(c, 1, { x: c[0][0] + 5, y: c[0][1] }, W, H).refused, "fold", "a side under MIN_BOX");
  // a straight (180°) corner is refused, as labelcore.is_convex refuses it on save
  const straight = [[100, 100], [200, 100], [200, 300], [100, 200]].map((p, i) => (i === 3 ? [100, 200] : p));
  const flat = [[100, 100], [200, 100], [300, 100], [100, 300]]; // corner 1 lies on the line from 0 to 2
  assert.ok(!G.isConvexQuad(flat, 1), "a corner on its neighbors' line");
  assert.strictEqual(G.moveQuadCorner(straight, 3, { x: 100, y: 250 }, W, H).corners !== undefined, true, "a real corner is kept");
  assert.strictEqual(G.moveQuadCorner([[100, 100], [200, 100], [200, 300], [100, 300]], 1, { x: 150, y: 200 }, W, H).refused, "fold",
    "corner 1 dragged onto the line from corner 0 to corner 2");
  // the range: a corner past QUAD_RANGE (the export's) is refused; up to it is kept
  const far = (2 * W + 5 - mid.x) / (c[2][0] - mid.x); // pulled out along its own diagonal: still convex
  assert.strictEqual(G.moveQuadCorner(c, 2, { x: mid.x + (c[2][0] - mid.x) * far, y: mid.y + (c[2][1] - mid.y) * far }, W, H).refused, "range");
  const edge = G.moveQuadCorner([[0, 0], [100, 0], [100, 100], [0, 100]], 2, { x: 2 * W, y: 2 * H }, W, H);
  assert.ok(edge.corners, "a corner exactly at the range's end is kept");
  // an edge: its two corners move together, the others stay
  const e = G.quadDrag({ mode: "edge", handle: "r", corners: c, start: { x: 0, y: 0 } }, { x: 6, y: -4 }, W, H);
  assert.deepStrictEqual([e.corners[0], e.corners[3]], [c[0], c[3]]);
  assert.deepStrictEqual(e.corners[1], [G.r1(c[1][0] + 6), G.r1(c[1][1] - 4)]);
  assert.strictEqual(G.moveQuadEdge(c, 1, -400, 0, W, H).refused, "fold", "an edge dragged across the box");
  // turning: about its center, its shape and corner order kept (r, R, w, W and the knob)
  for (const deg of [90, -90, 5, -1, 180, 37]) {
    const rq = G.rotateQuad(c, deg, W, H);
    assert.ok(rq.corners, `${deg}`);
    const m2 = G.quadCenter(rq.corners);
    close(m2.x, mid.x, 0.1); close(m2.y, mid.y, 0.1);
    for (let i = 0; i < 4; i++) close(Math.hypot(rq.corners[i][0] - rq.corners[(i + 1) % 4][0], rq.corners[i][1] - rq.corners[(i + 1) % 4][1]),
      Math.hypot(c[i][0] - c[(i + 1) % 4][0], c[i][1] - c[(i + 1) % 4][1]), 0.2, `side ${i} after ${deg}°`);
  }
  const quarter = G.rotateQuad(c, 90, W, H).corners;
  const back4 = [90, 90, 90].reduce((q) => G.rotateQuad(q, 90, W, H).corners, quarter);
  for (let i = 0; i < 4; i++) { close(back4[i][0], c[i][0], 0.3); close(back4[i][1], c[i][1], 0.3); }
  const knob = G.knobOf(t, 24), top = G.knobOf(t, 0);
  close(top.x, (c[0][0] + c[1][0]) / 2, 1e-9); close(top.y, (c[0][1] + c[1][1]) / 2, 1e-9);
  assert.ok(!G.pointInQuad(c, knob), "the knob is outside the box, beyond its top edge");
  const kd = { mode: "qrotate", corners: c, center: mid, startAngle: G.angleFromCenter(mid, knob) };
  const turned = G.quadDrag(kd, { x: mid.x + (knob.y - mid.y) * -1, y: mid.y + (knob.x - mid.x) }, W, H); // the knob dragged a quarter round
  assert.ok(turned.corners);
  close(G.quadCenter(turned.corners).x, mid.x, 0.1);
  assert.strictEqual(G.rotateQuad([[10, 10], [1900, 10], [1900, 1070], [10, 1070]], 45, W, H).refused, undefined, "inside the range");
  assert.strictEqual(G.rotateQuad([[-1500, 10], [3000, 10], [3000, 1070], [-1500, 1070]], 45, W, H).refused, "range");
  // hit-testing on the quad's own corners and sides
  assert.strictEqual(G.hitQuadCorner(c, { x: c[2][0] + 2, y: c[2][1] - 2 }, 5), "br");
  const hs = G.handleAt(t, { x: c[2][0] + 1, y: c[2][1] }, 24, 5, 3);
  assert.deepStrictEqual(hs, { mode: "resize", handle: "br" });
  const mr = [(c[1][0] + c[2][0]) / 2, (c[1][1] + c[2][1]) / 2];
  assert.deepStrictEqual(G.handleAt(t, { x: mr[0], y: mr[1] }, 24, 5, 3), { mode: "resize", handle: "r" });
  assert.deepStrictEqual(G.handleAt(t, knob, 24, 5, 3), { mode: "rotate" });
  assert.strictEqual(G.handleAt(t, mid, 24, 5, 3), null, "inside: a move, no handle");
  assert.deepStrictEqual(G.handlePoints(t), c);
  // a rectangle's handles are as before
  assert.deepStrictEqual(G.handleAt(box, { x: br[0], y: br[1] }, 24, 5, 3), { mode: "resize", handle: "br" });
  assert.strictEqual(G.nearestEdgeOf(t, { x: mr[0] + 1, y: mr[1] }, 4), 1);
  assert.strictEqual(G.nearestEdgeOf(box, { x: mr[0], y: mr[1] }, 400), G.nearestEdge(G.rectFromCorners(box.corners, box.angle), { x: mr[0], y: mr[1] }, 400));

  // back to a rectangle (E): its center, its top edge's direction; a rectangle comes back exactly
  const back = G.quadBackToRect(t.corners, W, H);
  close(back.cx, mid.x, 1e-9); close(back.cy, mid.y, 1e-9);
  assert.ok(Math.abs(G.normalizeAngle(back.angle - 20)) < 3, `about the box's own angle: ${back.angle}`);
  const exact = G.quadToRect(box.corners);
  close(exact.w, 120, 0.1); close(exact.h, 168, 0.1); close(exact.angle, 20, 0.05);
  // a turned quad near the range's end whose rectangle would reach past it: refused
  const nearEnd = [[3343.2, 178], [3835.6, 264.8], [3743.6, 959.4], [2827.7, 797.9]];
  assert.ok(G.cornersInRange(nearEnd, W, H) && G.isConvexQuad(nearEnd, G.MIN_BOX));
  assert.strictEqual(G.quadBackToRect(nearEnd, W, H), null, "a rectangle that would leave the range is refused");
  assert.strictEqual(G.rectSource(t), "box");
  assert.strictEqual(G.rectSource({ carriedFrom: { frame: "f", target: "B" } }), "carried");
  assert.strictEqual(G.rectSource({ prefill: { i: 0 } }), "prefill-edited");

  // copy / paste / group paste keep it a quad; D then an arrow gives one beside it
  const clip = G.makeClip(t, "set/f1");
  const pasted = G.pasteTarget(clip, "set/f1", W, H, "B009", null);
  assert.ok(G.isQuad(pasted) && pasted.angle === undefined);
  assert.deepStrictEqual(pasted.corners, t.corners.map((p) => [G.r1(p[0] + G.PASTE_OFFSET), G.r1(p[1] + G.PASTE_OFFSET)]));
  const grp = G.pasteGroup([clip, G.makeClip(box, "set/f1")], "set/f2", W, H, ["B010", "B011"], [null, null]);
  assert.deepStrictEqual(grp.targets.map((x) => [x.cornerSource, x.angle]), [["hand", undefined], ["box", 20]]);
  const bes = G.besideOf(t, "right");
  assert.ok(bes.corners && G.isConvexQuad(bes.corners, G.MIN_BOX));
  const shift = [bes.corners[0][0] - c[0][0], bes.corners[0][1] - c[0][1]];
  for (let i = 0; i < 4; i++) { close(bes.corners[i][0] - c[i][0], shift[0], 0.11); close(bes.corners[i][1] - c[i][1], shift[1], 0.11); }
  assert.ok(Math.hypot(...shift) > 100, "the same outline, beside it");
  assert.strictEqual(G.besideOf(box, "right").corners, null, "a rectangle: a rectangle beside it, as before");
  // carry-over keeps it free; an edit of a model's box keeps it free; m makes it a rectangle again
  const carried = G.carryTargets([t], "f1", false)[0];
  assert.deepStrictEqual([carried.cornerSource, carried.labelSource], ["hand", "carried"]);
  assert.strictEqual(G.carryTargets([box], "f1", false)[0].cornerSource, "carried");
  const model = Object.assign(JSON.parse(JSON.stringify(t)), { prefill: { i: 0, corners: box.corners, angle: 20, outcome: "card" }, pending: true });
  G.editProvenance(model, true);
  assert.deepStrictEqual([model.labelSource, model.cornerSource, model.pending], ["prefill-corrected", "hand", undefined]);
  const keptQ = Object.assign(JSON.parse(JSON.stringify(t)), { carriedFrom: { frame: "f0", target: "B001" } });
  G.moveOnto(keptQ, { corners: box.corners, angle: 20 });
  assert.deepStrictEqual([keptQ.cornerSource, keptQ.angle], ["carried", 20]);
  // layers and the stacking view
  const under = { id: "U", corners: G.cornersFromRect({ cx: 520, cy: 420, w: 120, h: 168, angle: 0 }), zOrder: 0 };
  const ts = [under, Object.assign({}, t, { zOrder: 1 })];
  assert.deepStrictEqual(G.reorderAmongOverlaps(ts, 1, -1), [1, 0]);
  assert.deepStrictEqual(G.stackLayers(ts).map((x) => x.layer), [1, 2]);
  const parts = G.visibleParts(ts);
  assert.deepStrictEqual(parts[1].corners, t.corners, "the top one is wholly seen");
  assert.ok(parts[0].share > 0 && parts[0].share < 0.5, `the one under it is mostly covered: ${parts[0].share}`);
  const lowered = G.visibleParts([Object.assign({}, t, { zOrder: 0 }), Object.assign({}, under, { zOrder: 1 })]);
  assert.ok(lowered[0].share > 0 && lowered[0].share < 0.5, `a quad under a box: ${lowered[0].share}`);
  assert.ok(G.cornersInRange(lowered[0].corners, W, H) && G.pointInQuad(t.corners, G.quadCenter(lowered[0].corners)), "its visible part lies inside it");
  // a quad on its own is wholly seen
  assert.deepStrictEqual(G.visibleParts([t])[0], { rank: 1, share: 1, corners: t.corners });
}

console.log("test_boxgeom.js: all assertions passed");
