// SPDX-License-Identifier: Apache-2.0
// Tests for boxedit.js (the Boxes pass's geometry edits on the selected box), against a stand-in
// for the page. Run: node test_boxedit.js (also run by test_serve.py). Stdlib assert only.
"use strict";
const assert = require("assert");
const G = require("./boxgeom.js");
const BE = require("./boxedit.js");
const U = require("./uistate.js");

const W = 1920, H = 1080;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-6), `${msg || ""} ${a} vs ${b}`);

// A page with one frame: its row, a selection, an undo stack and the status line. editGeometry
// works as sources.js's: one undo step, and no change when geometrySig is the same.
function page(targets, opts) {
  const o = opts || {};
  const p = {
    rowObj: { name: "f00001.png", targets }, sel: targets.length ? targets[0].id : null, extra: [],
    status: "", undos: 0, pixels: o.pixels === undefined ? {} : o.pixels, state: { nudge: { at: 0, key: null } },
  };
  Object.assign(p, {
    frameSize: () => [W, H], framePixels: () => p.pixels, setStatus: (t) => { p.status = t; },
    selected: () => targets.find((t) => t.id === p.sel) || null, primaryIds: () => (p.sel ? [p.sel] : []),
    selectedIds: () => (p.sel ? [p.sel] : []).concat(p.extra), isMulti: () => p.extra.length > 0, editable: () => true,
    noTargetMessage: () => "Select a box first.", row: () => p.rowObj, pushUndo: () => { p.undos++; },
    turnedRect: (t, angle) => Object.assign(G.rectFromCorners(t.corners, t.angle), { angle }),
    fitStateOf: () => ({ reason: "edited" }), remember: () => {}, notes: U.NOTES, QS: o.QS || { refineQuad: () => ({ snapped: false }) },
    editGeometry(ids, fn, eo) {
      const ts = ids.map((id) => targets.find((t) => t.id === id)).filter(Boolean);
      const sig = BE.geometrySig(ts);
      ts.forEach((t, k) => fn(t, k));
      if (BE.geometrySig(ts) === sig) return false;
      if (!(eo && eo.noUndo)) p.undos++;
      return true;
    },
  });
  p.be = BE.create(p);
  return p;
}

const quadAt = (id, q) => ({ id, corners: q, cornerSource: "hand", outcome: "card", labelSource: "manual" });

// ---- D then an arrow beside a quad near the frame's edge: never on top of its source ----------
{
  const src = quadAt("B001", [[60, 300], [180, 305], [178, 470], [62, 465]]);
  const p = page([src]);
  const left = p.be.besidePlace(src, "left");
  assert.ok(left.corners, JSON.stringify(left));
  assert.ok(left.corners.every((c, i) => c[0] <= src.corners[i][0] - 100), `moved its whole width left, past the frame's edge: ${JSON.stringify(left.corners)}`);
  assert.ok(left.corners[0][0] < 0, "not pulled back inside the frame");
  // against its source's left side (a trapezoid's sides are not parallel: at most a sliver
  // where they meet), not 60 px on top of it as a clamp into the frame put it
  assert.ok(Math.max(...left.corners.map((c) => c[0])) <= 63, JSON.stringify(left.corners));
  const top = quadAt("B002", [[400, 100], [520, 105], [518, 265], [402, 260]]);
  const up = page([top]).be.besidePlace(top, "up");
  assert.ok(up.corners && up.corners[0][1] < 0 && Math.max(...up.corners.map((c) => c[1])) <= 106, JSON.stringify(up));
  // the center off the picture: refused, with a word why
  const edge = quadAt("B003", [[2, 300], [100, 300], [100, 450], [2, 450]]);
  assert.ok(/no room/.test(page([edge]).be.besidePlace(edge, "left").refused));
  // a corner past QUAD_RANGE: refused
  const huge = quadAt("B004", [[0, 0], [1800, 10], [1810, 1080], [5, 1075]]);
  const r = page([huge]).be.besidePlace(huge, "right");
  assert.ok(r.refused, JSON.stringify(r));
}

// ---- E on a box with free corners that already form an upright rectangle: a real edit ---------
{
  const t = quadAt("B001", G.boxCorners(100, 100, 163, 188, W, H));
  const p = page([t]);
  p.be.fitSel();
  assert.deepStrictEqual([t.cornerSource, t.angle, p.undos, p.status], ["box", undefined, 1, U.NOTES.quad.rect], "an undo step, and saved");
  assert.deepStrictEqual(t.corners, G.boxCorners(100, 100, 163, 188, W, H));
  assert.notStrictEqual(BE.geometrySig([t]), BE.geometrySig([Object.assign({}, t, { cornerSource: "hand" })]), "cornerSource counts");
  // a turned trapezoid becomes the rectangle of the same top edge
  const q = quadAt("B002", [[500, 400], [620, 420], [600, 580], [490, 560]]);
  const p2 = page([q]);
  p2.be.fitSel();
  assert.ok(q.cornerSource === "box" && typeof q.angle === "number" && G.isRectangle(q.corners));
  close(G.quadCenter(q.corners).x, 552.5, 0.2);
}

// ---- turns, the top edge, a drag, Alt+arrows, snapping ---------------------------------------
{
  const q = [[500, 400], [620, 420], [600, 580], [490, 560]];
  const t = quadAt("B001", q.map((c) => c.slice()));
  const p = page([t]);
  p.be.tapSel(1);
  const c = G.quadCenter(q), c2 = G.quadCenter(t.corners);
  close(c2.x, c.x, 0.1); close(c2.y, c.y, 0.1);
  assert.ok(G.isQuad(t) && t.angle === undefined && p.undos === 1, "w turns it about its center and stays a quad");
  p.be.rotateSel(5);
  assert.ok(G.isQuad(t) && p.undos === 2);
  const before = t.corners.map((x) => x.slice());
  p.be.setTopEdgeSel(1);
  assert.deepStrictEqual(t.corners, G.topEdgeCorners(before, 1));
  assert.strictEqual(t.angle, undefined, "a box with free corners keeps no angle");
  assert.ok(/right edge/.test(p.status));
  // Alt+arrows: refused, nothing changes
  const was = JSON.stringify(t);
  p.be.nudgeBox(1, 0, true);
  assert.strictEqual(JSON.stringify(t), was);
  assert.strictEqual(p.status, U.NOTES.quad.arrows);
  // arrows: a burst is one undo step
  const u = p.undos;
  p.be.nudgeBox(1, 0, false); p.be.nudgeBox(1, 0, false);
  assert.strictEqual(p.undos, u + 1);
  // a drag that would fold it is refused, with a word why; the next good step clears it
  const box = { id: "B009", corners: G.cornersFromRect({ cx: 800, cy: 500, w: 120, h: 168, angle: 10 }), angle: 10, cornerSource: "box" };
  const pb = page([box]);
  const d = pb.be.quadDragStart({ mode: "resize", handle: "br", t: box }, { x: box.corners[2][0], y: box.corners[2][1] }, true);
  assert.strictEqual(d.mode, "corner");
  assert.strictEqual(pb.be.quadDragStart({ mode: "resize", handle: "br", t: box }, { x: 0, y: 0 }, false), null, "a plain drag resizes");
  pb.be.quadDragMove(d, box, { x: box.corners[0][0] - 20, y: box.corners[0][1] - 20 });
  assert.ok(!G.isQuad(box) && pb.status === U.NOTES.quad.fold, "nothing freed by a refused step");
  pb.be.quadDragMove(d, box, { x: d.corners[2][0] + 10, y: d.corners[2][1] + 6 });
  assert.ok(G.isQuad(box) && box.angle === undefined && pb.status === "");
  // snapping: kept when quadsnap does not move it, applied when it does
  const ps = page([quadAt("B001", q.map((x) => x.slice()))], { QS: { refineQuad: (px, cs) => ({ snapped: true, corners: cs.map((x) => [x[0] + 1.04, x[1]]), moved: [1, 1, 1, 1] }) } });
  ps.be.snapQuadSel();
  assert.deepStrictEqual([ps.status, ps.undos, ps.selected().corners[0]], [U.NOTES.quad.snapped, 1, [501, 400]]);
  const pk = page([quadAt("B001", q.map((x) => x.slice()))]);
  pk.be.snapQuadSel();
  assert.deepStrictEqual([pk.status, pk.undos], [U.NOTES.quad.snapKept, 0]);
  const pn = page([quadAt("B001", q.map((x) => x.slice()))], { pixels: null });
  pn.be.snapQuadSel();
  assert.strictEqual(pn.status, U.NOTES.quad.noPicture);
}

// ---- the turning paths and a resize keep a turned box within QUAD_RANGE ------------------------
{
  const boxAt = (rect) => ({ id: "B001", corners: G.cornersFromRect(rect), angle: rect.angle, cornerSource: "box", outcome: "card", labelSource: "manual" });
  const inR = (t) => G.cornersInRange(t.corners, W, H);
  const stays = (p, t, was, msg) => {
    assert.strictEqual(JSON.stringify(t), was, msg + ": the box is unchanged");
    assert.strictEqual(p.status, BE.TOO_FAR, msg + ": TOO_FAR");
    assert.strictEqual(p.undos, 0, msg + ": no undo step");
  };
  // r / R: a long box whose tilt by one more degree swings a corner past the range
  const longRect = { cx: 960, cy: 540, w: 5600, h: 400, angle: 0.5 };
  let tilt = null;
  for (let a = 0; a < 40 && !tilt; a += 0.5) {
    const r = Object.assign({}, longRect, { angle: a });
    const next = Object.assign({}, r, { angle: a + 5 });
    if (G.cornersInRange(G.cornersFromRect(r), W, H) && !G.cornersInRange(G.cornersFromRect(next), W, H)) tilt = r;
  }
  assert.ok(tilt, "a box that sits in range and leaves it by a 5 degree tilt");
  const tl = boxAt(tilt), pr = page([tl]), was = JSON.stringify(tl);
  pr.be.rotateSel(5);
  stays(pr, tl, was, "R");
  // the same box tilts the other way, back toward the range, and is kept
  pr.status = "";
  pr.be.rotateSel(-1);
  assert.ok(inR(tl) && pr.undos === 1 && pr.status === "", "a small tilt that stays within is allowed");
  // w / W: a quarter turn of a wide box makes it taller than the range
  const wide = boxAt({ cx: 960, cy: 540, w: 3600, h: 300, angle: 5 });
  assert.ok(inR(wide));
  const pw = page([wide]), wasW = JSON.stringify(wide);
  pw.be.tapSel(1);
  stays(pw, wide, wasW, "w");
  pw.be.tapSel(-1);
  stays(pw, wide, wasW, "W");
  // e (fit): a base wider than the range fits to a box that is past it
  const fb = boxAt({ cx: 960, cy: 540, w: 400, h: 300, angle: 30 });
  const pf = page([fb], { }), wasF = JSON.stringify(fb);
  pf.fitStateOf = () => ({ base: { cx: 960, cy: 540, w: 7000, h: 300 } });
  pf.be = BE.create(pf);
  pf.be.fitSel();
  stays(pf, fb, wasF, "e");
  // the knob: turnTo refuses the same way, and keeps a turn that stays within
  const kb = boxAt(tilt), pk = page([kb]), wasK = JSON.stringify(kb);
  assert.strictEqual(pk.be.turnTo(kb, Object.assign({}, tilt, { angle: tilt.angle + 5 })), false);
  stays(pk, kb, wasK, "knob");
  assert.strictEqual(pk.be.turnTo(kb, Object.assign({}, tilt, { angle: tilt.angle - 0.5 })), true);
  // turnAllowed (re-snap and Layout use it, the latter for all boxes before changing any): the same verdict, no write
  assert.strictEqual(pk.be.turnAllowed(kb, Object.assign({}, tilt, { angle: tilt.angle + 5 })), false);
  assert.strictEqual(pk.be.turnAllowed(kb, Object.assign({}, tilt, { angle: tilt.angle - 0.5 })), true);
  // a box already past the range: it may be turned toward it, not further out
  const out = boxAt({ cx: 960, cy: 540, w: 5900, h: 400, angle: 10 });
  assert.ok(!inR(out));
  const worse = G.rangeExcess(out.corners, W, H);
  assert.ok(worse > 0);
  const po = page([out]);
  assert.strictEqual(po.be.turnTo(out, { cx: 960, cy: 540, w: 5900, h: 400, angle: 20 }), true, "toward the range");
  assert.ok(G.rangeExcess(out.corners, W, H) < worse);
  const was2 = JSON.stringify(out);
  assert.strictEqual(po.be.turnTo(out, { cx: 960, cy: 540, w: 5900, h: 400, angle: 0.5 }), false, "further out");
  assert.strictEqual(JSON.stringify(out), was2);
  // Alt+arrows (nudgeSize): toward the range is kept, further out is refused
  const na = boxAt({ cx: 960, cy: 540, w: 5900, h: 400, angle: 10 }), pn = page([na]);
  pn.be.nudgeSize(na, 40, 0);
  assert.strictEqual(G.rangeExcess(na.corners, W, H), worse, "wider goes further out: refused, unchanged");
  assert.strictEqual(pn.status, BE.TOO_FAR);
  pn.status = "";
  pn.be.nudgeSize(na, -200, 0);
  assert.ok(pn.status === "" && JSON.stringify(na.corners) !== JSON.stringify(boxAt({ cx: 960, cy: 540, w: 5900, h: 400, angle: 10 }).corners) && G.rangeExcess(na.corners, W, H) <= worse, "narrower is no further out: kept");
}

// ---- a rect onto a box ------------------------------------------------------------------------
{
  const t = quadAt("B001", [[500, 400], [620, 420], [600, 580], [490, 560]]);
  t.carriedFrom = { frame: "f0", target: "B001" };
  const p = page([t]);
  p.be.setRect(t, { cx: 100, cy: 100, w: 60, h: 80, angle: 30 });
  assert.deepStrictEqual([t.cornerSource, t.angle], ["carried", 30], "a kept quad given a rect is a kept rectangle again");
  p.be.setRect(t, { cx: 10, cy: 10, w: 60, h: 80, angle: 0 });
  assert.deepStrictEqual(t.corners[0], [0, 0], "an upright box is cut at the frame");
  p.be.resizeTo(t, null);
  assert.strictEqual(p.status, BE.TOO_FAR);
}

console.log("test_boxedit.js: all assertions passed");
