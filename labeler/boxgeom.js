// SPDX-License-Identifier: Apache-2.0
// Box-mode geometry and editing helpers for the labeling tool. Pure: no DOM, no fetch. Shared
// by the page (window.LabelerBoxGeom) and Node (test_boxgeom.js).
//
// Rotated boxes, resize in the box's own rotated frame, the 90° tap toggle, z-order, copy/paste,
// carry-over, prefill boxes and the review walk. The storage is the corner format: a box is four
// corners in `targets[].corners`, `cornerSource: box`, in the screen-rotated rectangle's own
// order TL, TR, BR, BL (clockwise). A rotated box also stores its angle (`angle`, degrees,
// absent when 0) so the rectangle round-trips exactly.
//
// rect = {cx, cy, w, h, angle}: frame px, angle in degrees, y-down, positive = clockwise on
// screen (labeltools.js's convention; rotationDeg of the server's derived geometry).
(function (root) {
  "use strict";

  const Tools = typeof module !== "undefined" && module.exports ? require("./labeltools.js") : root.LabelerTools;

  const MIN_BOX = 12; // frame px: the smallest box side (a smaller one is a stray click-drag, not a box)
  const PASTE_OFFSET = 12; // frame px, pasting into the frame the box was copied from
  const RECT_TOL = 0.5; // frame px: corners are stored to 0.1 px, a rectangle check within this

  const r1 = (v) => Math.round(v * 10) / 10;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function normalizeAngle(a) {
    let x = a % 360;
    if (x > 180) x -= 360;
    if (x <= -180) x += 360;
    return x;
  }

  // The stored angle: normalized, rounded to 0.01°, normalized again (a rounded −179.999 would
  // otherwise be −180, which the server refuses), never −0.
  function roundAngle(a) {
    const r = Math.round(normalizeAngle(a || 0) * 100) / 100;
    return normalizeAngle(r) + 0;
  }

  function rotatePoint(dx, dy, deg) {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

  // The rectangle of four stored corners. `angle` (the stored additive field) wins when it is a
  // number; else the angle of the top edge (0 for an axis-aligned box).
  function rectFromCorners(corners, angle) {
    const q = corners;
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
    const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const a = typeof angle === "number" && isFinite(angle)
      ? angle : (Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180) / Math.PI;
    return { cx, cy, w: dist(q[0], q[1]), h: dist(q[1], q[2]), angle: normalizeAngle(Math.abs(a) < 1e-9 ? 0 : a) };
  }

  // Corners TL, TR, BR, BL of the rect's own (rotated) frame, rounded to 0.1 px as stored.
  function cornersFromRect(rect) {
    const hw = rect.w / 2, hh = rect.h / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => {
      const p = rotatePoint(x, y, rect.angle || 0);
      return [r1(rect.cx + p.x) + 0, r1(rect.cy + p.y) + 0];
    });
  }

  function signedArea(q) {
    let s = 0;
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a[0] * b[1] - b[0] * a[1]; }
    return s / 2;
  }

  // Mirror of labelcore.is_rectangle_box: clockwise on screen, sides ≥ 1 px, a parallelogram
  // (the diagonals bisect each other) with equal diagonals, within `tol` px.
  function isRectangle(corners, tol) {
    const t = typeof tol === "number" ? tol : RECT_TOL;
    if (!Array.isArray(corners) || corners.length !== 4) return false;
    const q = corners.map((p) => [Number(p[0]), Number(p[1])]);
    if (q.some((p) => !isFinite(p[0]) || !isFinite(p[1]))) return false;
    if (signedArea(q) <= 0) return false;
    for (let i = 0; i < 4; i++) if (dist(q[i], q[(i + 1) % 4]) < 1) return false;
    const mx = q[0][0] + q[2][0] - q[1][0] - q[3][0], my = q[0][1] + q[2][1] - q[1][1] - q[3][1];
    if (Math.hypot(mx, my) > t) return false;
    return Math.abs(dist(q[0], q[2]) - dist(q[1], q[3])) <= t;
  }

  function aabb(corners) {
    const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  // Axis-aligned corners TL, TR, BR, BL from two opposite points, clamped into the frame.
  function boxCorners(x0, y0, x1, y1, W, H) {
    const a = clamp(Math.min(x0, x1), 0, W), b = clamp(Math.min(y0, y1), 0, H);
    const c = clamp(Math.max(x0, x1), 0, W), d = clamp(Math.max(y0, y1), 0, H);
    return [[r1(a), r1(b)], [r1(c), r1(b)], [r1(c), r1(d)], [r1(a), r1(d)]];
  }

  function pointInQuad(q, p) {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = q[i], [xj, yj] = q[j];
      if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Move by (dx, dy), limited so the box's bounding box stays inside the frame (when it fits).
  // With keepOverhang (dragging or nudging a box), a box that already runs past an edge (a turned
  // card cut by the frame) is not pulled back in; it just cannot move further out on that side.
  function translateCorners(corners, dx, dy, W, H, keepOverhang) {
    const [x0, y0, x1, y1] = aabb(corners);
    const lo = (v) => (keepOverhang ? Math.min(0, v) : v), hi = (v) => (keepOverhang ? Math.max(0, v) : v);
    const mx = x1 - x0 <= W ? clamp(dx, lo(-x0), hi(W - x1)) : dx;
    const my = y1 - y0 <= H ? clamp(dy, lo(-y0), hi(H - y1)) : dy;
    return corners.map((p) => [r1(p[0] + mx) + 0, r1(p[1] + my) + 0]);
  }

  // Where a resize handle may be dragged. Upright boxes stop at the frame (setRect cuts them there
  // anyway); a turned box may reach half a frame past each edge, so it can cover a card the frame
  // cuts off. The export accepts corners up to a whole frame outside.
  function resizePoint(p, angle, W, H) {
    if (roundAngle(angle || 0) === 0) return { x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) };
    return { x: clamp(p.x, -W / 2, W * 1.5), y: clamp(p.y, -H / 2, H * 1.5) };
  }

  // How far outside the frame a corner may lie, as a fraction of the frame: export.py's
  // QUAD_RANGE (test_boxgeom.js reads it from there). The export leaves out a frame with a
  // corner past it.
  const QUAD_RANGE = [-1, 2];

  function cornersInRange(corners, W, H) {
    const [lo, hi] = QUAD_RANGE;
    return corners.every((p) => p[0] >= lo * W && p[0] <= hi * W && p[1] >= lo * H && p[1] <= hi * H);
  }

  // How far the worst corner lies outside QUAD_RANGE, in the export's own unit: a fraction of the
  // frame (the larger of the x overshoot over W and the y overshoot over H); 0 when every corner
  // is within it. Fractions, not pixels, so a frame that is not square is judged as the export does.
  function rangeExcess(corners, W, H) {
    const [lo, hi] = QUAD_RANGE;
    let worst = 0;
    for (const p of corners) worst = Math.max(worst, lo - p[0] / W, p[0] / W - hi, lo - p[1] / H, p[1] / H - hi);
    return worst;
  }

  // Whether `next` corners may replace `prev`: all within QUAD_RANGE, or, for a box already past
  // it, no further out than before (rangeExcess). So a box past the range can be brought back, and
  // cannot be pushed further out.
  function rangeNoWorse(next, prev, W, H) {
    return rangeExcess(next, W, H) <= rangeExcess(prev, W, H);
  }

  // The rect's corners at its stored angle, as setRect writes them.
  const storedCorners = (r) => cornersFromRect(Object.assign({}, r, { angle: roundAngle(r.angle || 0) }));

  // A resize of a box (resizeRect on the bounded handle, resizePoint), or null when it would put
  // a turned box's corner past QUAD_RANGE: the handle alone is bounded, but a turned box's other
  // corners swing further out. A box already past the range may still be resized when the result's
  // worst corner is no further out (rangeNoWorse). Upright boxes are cut at the frame (setRect),
  // never refused.
  function resizeWithin(orig, handle, p, W, H, min) {
    const r = resizeRect(orig, handle, resizePoint(p, orig.angle, W, H), min);
    if (roundAngle(r.angle || 0) === 0) return r;
    return rangeNoWorse(storedCorners(r), storedCorners(orig), W, H) ? r : null;
  }

  // `count` new target ids, none among `targets`' ids nor each other: `prefix` and a three-digit
  // number, counting up from one past the number of targets, each id taken before the next.
  function newTargetIds(targets, count, prefix) {
    const used = new Set((targets || []).map((t) => t.id));
    const out = [];
    for (let n = (targets || []).length + 1; out.length < count; n++) {
      const id = `${prefix}${String(n).padStart(3, "0")}`;
      if (!used.has(id)) { used.add(id); out.push(id); }
    }
    return out;
  }

  // ---- handles (the hit-testing, in the box's own rotated frame) -------------------------

  const HANDLES = ["tl", "tr", "br", "bl"];

  function toLocal(rect, p) { return rotatePoint(p.x - rect.cx, p.y - rect.cy, -(rect.angle || 0)); }

  // Corner handle within `tol` frame px: "tl" | "tr" | "br" | "bl" | null.
  function hitCorner(rect, p, tol) {
    const c = cornersFromRectRaw(rect);
    let best = null, bd = tol;
    c.forEach((q, i) => { const d = Math.hypot(q[0] - p.x, q[1] - p.y); if (d <= bd) { bd = d; best = HANDLES[i]; } });
    return best;
  }

  function cornersFromRectRaw(rect) {
    const hw = rect.w / 2, hh = rect.h / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => {
      const q = rotatePoint(x, y, rect.angle || 0);
      return [rect.cx + q.x, rect.cy + q.y];
    });
  }

  // Edge band `ew` frame px wide along one side, corners excluded: "t" | "b" | "l" | "r" | null.
  function hitEdge(rect, p, ew) {
    const l = toLocal(rect, p), hw = rect.w / 2, hh = rect.h / 2;
    if (l.x < -hw - ew || l.x > hw + ew || l.y < -hh - ew || l.y > hh + ew) return null;
    const inX = l.x > -hw + ew && l.x < hw - ew, inY = l.y > -hh + ew && l.y < hh - ew;
    if (Math.abs(l.y + hh) <= ew && inX) return "t";
    if (Math.abs(l.y - hh) <= ew && inX) return "b";
    if (Math.abs(l.x + hw) <= ew && inY) return "l";
    if (Math.abs(l.x - hw) <= ew && inY) return "r";
    return null;
  }

  // The rotate knob: `offset` frame px above the box's own top edge.
  function rotateHandlePos(rect, offset) {
    const l = rotatePoint(0, -(rect.h / 2 + offset), rect.angle || 0);
    return { x: rect.cx + l.x, y: rect.cy + l.y };
  }

  function angleFromCenter(c, p) { return (Math.atan2(p.x - c.x, -(p.y - c.y)) * 180) / Math.PI; }

  // Resize from a grab of `handle` (a corner "tl"… or an edge "t"/"b"/"l"/"r") that started on
  // rect `orig`, the pointer now at `p`. In the box's own frame: the opposite side stays put in
  // the frame, the angle is kept. Sides never go below `min` px.
  function resizeRect(orig, handle, p, min) {
    const m = typeof min === "number" ? min : MIN_BOX;
    const l = rotatePoint(p.x - orig.cx, p.y - orig.cy, -(orig.angle || 0));
    let x0 = -orig.w / 2, y0 = -orig.h / 2, x1 = orig.w / 2, y1 = orig.h / 2;
    if (handle.includes("l")) x0 = l.x;
    if (handle.includes("r")) x1 = l.x;
    if (handle.includes("t")) y0 = l.y;
    if (handle.includes("b")) y1 = l.y;
    if (x1 - x0 < m) { if (handle.includes("l")) x0 = x1 - m; else x1 = x0 + m; }
    if (y1 - y0 < m) { if (handle.includes("t")) y0 = y1 - m; else y1 = y0 + m; }
    const off = rotatePoint((x0 + x1) / 2, (y0 + y1) / 2, orig.angle || 0);
    return { cx: orig.cx + off.x, cy: orig.cy + off.y, w: x1 - x0, h: y1 - y0, angle: orig.angle || 0 };
  }

  // the tap/exhaust toggle: ±90° about the center, w/h unchanged, a true toggle judged by the
  // side of the 45° (−45° for direction −1) threshold, so 4° ↔ 94° and 0° ↔ −90° round-trip.
  function tapToggle(angle, direction) {
    const a = angle || 0;
    const next = direction > 0 ? (a >= 45 ? a - 90 : a + 90) : a <= -45 ? a + 90 : a - 90;
    return normalizeAngle(next);
  }

  // Box-pass quarter turn (the handle side is the card's own top, so a box
  // records orientation): w / double-click turn 90° clockwise, W counter-clockwise, keeping any
  // small tilt (4° → 94° → −176° → −86° → 4°). Replaces the toggle, which could not reach 180°.
  function quarterTurn(angle, direction) {
    return normalizeAngle((angle || 0) + (direction > 0 ? 90 : -90));
  }

  // "This edge is the top" (Alt+click an edge): the box keeps exactly its on-screen rectangle; only
  // which edge is the card's own top changes. k = the chosen edge counted clockwise from the
  // current top (0 top, 1 right, 2 bottom, 3 left): angle + 90·k, w/h swapped for odd k.
  function setTopEdge(rect, k) {
    const kk = ((k % 4) + 4) % 4;
    const odd = kk % 2 === 1;
    return { cx: rect.cx, cy: rect.cy, w: odd ? rect.h : rect.w, h: odd ? rect.w : rect.h, angle: roundAngle((rect.angle || 0) + 90 * kk) };
  }

  // The same on stored corners, exactly: the four points stay, the order starts at the chosen
  // edge's first corner (new q[i] = old q[(i + k) % 4]), so q[0]→q[1] is the new top.
  function topEdgeCorners(corners, k) {
    const kk = ((k % 4) + 4) % 4;
    return [0, 1, 2, 3].map((i) => [corners[(i + kk) % 4][0], corners[(i + kk) % 4][1]]);
  }

  // The edge of `rect` nearest to point p, within `tol` frame px of it (corners included, the
  // nearer edge wins): k clockwise from the box's own top (0 top, 1 right, 2 bottom, 3 left) or null.
  function nearestEdge(rect, p, tol) {
    const l = toLocal(rect, p), hw = rect.w / 2, hh = rect.h / 2;
    if (l.x < -hw - tol || l.x > hw + tol || l.y < -hh - tol || l.y > hh + tol) return null;
    const d = [Math.abs(l.y + hh), Math.abs(l.x - hw), Math.abs(l.y - hh), Math.abs(l.x + hw)];
    let k = 0;
    for (let i = 1; i < 4; i++) if (d[i] < d[k]) k = i;
    return d[k] <= tol ? k : null;
  }

  // ---- z-order (additive `zOrder`; absent = array position, the stacking old rows implied) ---

  function zOf(targets) { return targets.map((t, i) => (typeof t.zOrder === "number" ? t.zOrder : i)); }
  function orderAsc(targets) { const z = zOf(targets); return targets.map((_, i) => i).sort((a, b) => z[a] - z[b] || a - b); }
  function orderDesc(targets) { return orderAsc(targets).reverse(); }

  // The zOrder a new box gets: absent while no box of the frame has one (it is appended, so on
  // top), else one above the highest.
  function nextZ(targets) {
    if (!targets.some((t) => typeof t.zOrder === "number")) return null;
    return Math.max(...zOf(targets)) + 1;
  }

  // New zOrder values (ranks 0..n−1, index-aligned with `targets`) after moving target `idx`
  // one step (dir ±1) or to an edge (edge "front" | "back"); null when nothing changes.
  function reorder(targets, idx, how) {
    const asc = orderAsc(targets);
    const pos = asc.indexOf(idx);
    if (pos < 0) return null;
    let order = asc.slice();
    if (how === "front" || how === "back") {
      order = asc.filter((i) => i !== idx);
      if (how === "front") order.push(idx); else order.unshift(idx);
    } else {
      const to = pos + how;
      if (to < 0 || to >= asc.length) return null;
      [order[pos], order[to]] = [order[to], order[pos]];
    }
    if (order.every((v, k) => v === asc[k])) return null;
    const z = new Array(targets.length);
    order.forEach((i, rank) => { z[i] = rank; });
    return z;
  }

  // Two convex quads overlap when they share more than an edge (separating-axis test; boxes that
  // only touch do not overlap).
  function quadsOverlap(a, b) {
    for (const q of [a, b]) {
      for (let i = 0; i < 4; i++) {
        const p = q[i], r = q[(i + 1) % 4];
        const nx = r[1] - p[1], ny = p[0] - r[0];
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (const v of a) { const d = v[0] * nx + v[1] * ny; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
        for (const v of b) { const d = v[0] * nx + v[1] * ny; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
        const eps = 1e-6 * Math.hypot(nx, ny);
        if (a1 <= b0 + eps || b1 <= a0 + eps) return false;
      }
    }
    return true;
  }

  const hasQuad = (t) => Array.isArray(t.corners) && t.corners.length === 4;

  // `.` and `,`: one layer up / down among the boxes this one overlaps. The box moves just past
  // the nearest overlapping box above (dir +1) or below (dir −1) it in the stacking order, so its
  // order changes against that box only; where it now sits against boxes it does not touch makes
  // no difference to anything drawn or computed. New zOrder ranks as reorder gives them, or null
  // when no overlapping box is on that side.
  function reorderAmongOverlaps(targets, idx, dir) {
    const asc = orderAsc(targets);
    const pos = asc.indexOf(idx);
    if (pos < 0 || !hasQuad(targets[idx])) return null;
    const touches = (j) => j !== idx && hasQuad(targets[j]) && quadsOverlap(targets[idx].corners, targets[j].corners);
    let at = -1;
    if (dir > 0) { for (let k = pos + 1; k < asc.length; k++) if (touches(asc[k])) { at = k; break; } }
    else { for (let k = pos - 1; k >= 0; k--) if (touches(asc[k])) { at = k; break; } }
    if (at < 0) return null;
    const order = asc.filter((i) => i !== idx);
    const j = order.indexOf(asc[at]);
    order.splice(dir > 0 ? j + 1 : j, 0, idx);
    const z = new Array(targets.length);
    order.forEach((i, rank) => { z[i] = rank; });
    return z;
  }

  // The stacks of a frame: groups of boxes joined by overlaps (a chain counts as one stack). Per
  // box: its stack's number, the stack's size, and its layer within the stack (1 = the bottom).
  function stackLayers(targets) {
    const n = targets.length, parent = targets.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (hasQuad(targets[i]) && hasQuad(targets[j]) && quadsOverlap(targets[i].corners, targets[j].corners)) parent[find(i)] = find(j);
    }
    const out = targets.map(() => ({ stack: -1, size: 1, layer: 1 }));
    const seen = new Map();
    for (const i of orderAsc(targets)) {
      const r = find(i);
      if (!seen.has(r)) seen.set(r, { id: seen.size, count: 0 });
      const g = seen.get(r);
      g.count += 1;
      out[i] = { stack: g.id, size: 0, layer: g.count };
    }
    for (let i = 0; i < n; i++) out[i].size = seen.get(find(i)).count;
    return out;
  }

  // ---- copy / paste / carry-over -------------------------------------------------------

  const KIND_FIELDS = ["outcome", "ignore"];
  const ID_FIELDS = ["identity", "printing", "identitySource"];

  // One box on the clipboard: its geometry (corners and angle), its kind (card / back / ignore)
  // and its identity if it has one; the frame it came from decides the paste offset.
  function makeClip(t, frameName) {
    const c = { corners: t.corners.map((p) => [p[0], p[1]]), angle: typeof t.angle === "number" ? t.angle : null,
      sourceFrame: frameName, sourceTarget: t.id };
    if (isQuad(t)) { c.quad = true; c.angle = null; }
    for (const k of KIND_FIELDS.concat(ID_FIELDS)) if (t[k] !== undefined && t[k] !== null) c[k] = t[k];
    return c;
  }

  // The pasted target (id and zOrder from the caller): +PASTE_OFFSET px in the frame it was
  // copied from, the exact position in another frame, moved inside the frame either way (when it
  // fits). A back/ignored box keeps the eligibility and face-up its kind implies; other answers
  // (eligibility, conditions) are not copied.
  function pasteTarget(clip, frameName, W, H, id, zOrder, boxesOnly) {
    const same = clip.sourceFrame === frameName;
    const corners = translateCorners(clip.corners, same ? PASTE_OFFSET : 0, same ? PASTE_OFFSET : 0, W, H);
    const t = { id, corners, estimated: [false, false, false, false], cornerSource: "box", outcome: clip.outcome || "card",
      identity: clip.identity || null, printing: clip.printing || null, identitySource: clip.identitySource || null,
      eligible: null, conditions: {}, labelSource: "manual" };
    if (clip.quad) t.cornerSource = "hand"; // a box with free corners stays one
    else if (clip.angle) t.angle = clip.angle;
    if (clip.ignore) { t.ignore = true; t.eligible = "no"; }
    if (t.outcome === "card-back") { t.eligible = "no"; t.conditions = { faceUp: false }; t.identity = null; t.printing = null; t.identitySource = null; }
    if (typeof zOrder === "number") t.zOrder = zOrder;
    if (boxesOnly) { t.identity = null; t.printing = null; t.identitySource = null; } // names come in the identity pass
    return t;
  }

  // Several copied boxes (clips, bottom layer first) pasted as one group: the same offset as one
  // box (+PASTE_OFFSET px in the frame they were copied from, none in another), then the whole
  // group moved by one shift so that every box lies inside the frame; each box keeps its kind,
  // angle and names exactly as pasteTarget gives them. A group larger than the frame is refused
  // whole: {refused: why}; else {targets}, in the clips' order (ids and zOrders from the caller,
  // zOrders null when the frame has none).
  function pasteGroup(clips, frameName, W, H, ids, zOrders, boxesOnly) {
    if (clips.length === 1) return { targets: [pasteTarget(clips[0], frameName, W, H, ids[0], zOrders[0], boxesOnly)] };
    const same = clips[0].sourceFrame === frameName;
    let dx = same ? PASTE_OFFSET : 0, dy = same ? PASTE_OFFSET : 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of clips) for (const p of c.corners) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    if (x1 - x0 > W || y1 - y0 > H) return { refused: "The copied boxes span more than this frame, so they were not pasted." };
    if (x0 + dx < 0) dx = -x0; else if (x1 + dx > W) dx = W - x1;
    if (y0 + dy < 0) dy = -y0; else if (y1 + dy > H) dy = H - y1;
    const targets = clips.map((c, k) => {
      const moved = Object.assign({}, c, { corners: c.corners.map((p) => [r1(p[0] + dx), r1(p[1] + dy)]), sourceFrame: null });
      return pasteTarget(moved, frameName, W, H, ids[k], zOrders[k], boxesOnly);
    });
    return { targets };
  }

  // carry-over (label reuse across time, never model output): the previous confirmed frame's
  // boxes as provenance-marked copies: `labelSource` / `cornerSource: carried` and `carriedFrom`
  // (every role except test; labelcore refuses it in test sets).
  const CARRY_FIELDS = ["outcome", "identity", "printing", "identitySource", "eligible", "conditions", "ignore", "angle", "zOrder"];
  // boxesOnly: the box pass carries boxes, not names: identity fields stay behind
  const NAME_FIELDS = new Set(["identity", "printing", "identitySource", "eligible"]);
  // A box with free corners keeps `cornerSource: hand` (its provenance is in labelSource and
  // carriedFrom): "carried" corners are a rectangle's.
  function carryTargets(prevTargets, prevFrame, boxesOnly) {
    return prevTargets.map((p) => {
      const t = { id: p.id, corners: p.corners.map((q) => [q[0], q[1]]), estimated: (p.estimated || [false, false, false, false]).slice(),
        cornerSource: isQuad(p) ? "hand" : "carried", labelSource: "carried", carriedFrom: { frame: prevFrame, target: p.id } };
      for (const k of CARRY_FIELDS) if (p[k] !== undefined && !(boxesOnly && NAME_FIELDS.has(k) && p.outcome !== "card-back" && !p.ignore)) t[k] = k === "conditions" ? Object.assign({}, p[k]) : p[k];
      return t;
    });
  }

  function isCarried(t) { return !!(t && (t.carriedFrom || (t.propagatedFrom && t.propagatedFrom.method === "carry-over"))); }

  // Pairs [i, j] (i < j) of boxes on one frame that overlap almost completely (IoU ≥ thr): an
  // accidental paste or a double box. Enter's check and the confirmed-frame flag in box mode.
  function duplicates(targets, thr) {
    const th = typeof thr === "number" ? thr : 0.9;
    const rects = targets.map((t) => rectFromCorners(t.corners, t.angle));
    const out = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      if (Tools.rectIoU(rects[i], rects[j]) >= th) out.push([i, j]);
    }
    return out;
  }

  // "Same layout as…": the group is the whole frame: confirmed frames with the SAME number of
  // boxes on the whole frame and a different layout (mean IoU < `same`), nearest in time first.
  // frames: [{index, t, dt, targets}] (confirmed, not the current one).
  function layoutMatches(curTargets, frames, opts) {
    const o = Object.assign({ same: 0.9, limit: 4 }, opts || {});
    if (curTargets.length < 2) return [];
    const cur = curTargets.map((t) => rectFromCorners(t.corners, t.angle));
    const out = [];
    for (const f of frames) {
      if (f.targets.length !== cur.length) continue;
      const sim = Tools.layoutSimilarity(cur, f.targets.map((t) => rectFromCorners(t.corners, t.angle)));
      if (sim >= o.same) continue;
      out.push({ index: f.index, t: f.t, dt: f.dt, similarity: sim });
    }
    out.sort((a, b) => Math.abs(a.dt) - Math.abs(b.dt) || a.dt - b.dt);
    return out.slice(0, o.limit);
  }

  // ---- box-mode prefill (role=training sets only) --------------------------------------
  // A detector box arrives as a PENDING box: `pending: true`, `cornerSource: prefill`, no
  // labelSource yet, the proposal kept under `prefill` ({i, corners, angle?, outcome, score, …}).
  // The labeler accepts it as is (labelSource prefill-accepted), changes it (prefill-corrected;
  // cornerSource prefill-edited once the corners or angle differ) or deletes it (prefill-rejected).

  // `rot` as quarter turns (0..3): 0–3 is the number of quarter turns (what the inference command
  // writes); 90, 180 or 270 is the same in degrees. Mirrors labelcore.quarter_turns.
  function quarterTurns(rot) {
    const r = Number(rot || 0);
    if (!isFinite(r)) return 0;
    const k = Math.abs(r) < 45 ? Math.round(r) : Math.round(r / 90);
    return ((k % 4) + 4) % 4;
  }

  // A prefill proposal scaled from the pixel space it was written in (`size`: [w, h], the
  // record's own frameW x frameH) to the frame the page shows (W x H). A proposal without a
  // size, or one already in the frame's own pixels, is returned as it is.
  function scaleProposal(p, size, W, H) {
    if (!p || !Array.isArray(size) || size.length !== 2) return p;
    const sw = Number(size[0]), sh = Number(size[1]);
    if (!(sw > 0 && sh > 0 && W > 0 && H > 0) || (sw === W && sh === H)) return p;
    const sx = W / sw, sy = H / sh;
    const out = Object.assign({}, p);
    if (Array.isArray(p.box) && p.box.length === 4) out.box = [p.box[0] * sx, p.box[1] * sy, p.box[2] * sx, p.box[3] * sy];
    if (Array.isArray(p.corners)) out.corners = p.corners.map((q) => [q[0] * sx, q[1] * sy]);
    return out;
  }

  // A proposal {box: [x, y, w, h], rot?, outcome?, score?, …} or {corners: rectangle} as a pending
  // box target, clamped into the frame; null when it is not a rectangle or under MIN_BOX.
  function prefillTarget(p, i, W, H, id) {
    if (!p) return null;
    let corners = null, angle = 0;
    if (Array.isArray(p.box) && p.box.length === 4) {
      const [x, y, w, h] = p.box.map(Number);
      if (![x, y, w, h].every(isFinite)) return null;
      corners = boxCorners(x, y, x + w, y + h, W, H);
      const k = quarterTurns(p.rot); // the quarter turn at which the model matched the card
      if (k) { corners = topEdgeCorners(corners, k); angle = roundAngle(90 * k); }
    } else if (Array.isArray(p.corners) && isRectangle(p.corners)) {
      corners = p.corners.map((q) => [r1(Number(q[0])) + 0, r1(Number(q[1])) + 0]);
      if (!isRectangle(corners)) return null;
      angle = roundAngle(rectFromCorners(corners).angle);
    } else return null;
    const r = rectFromCorners(corners, angle);
    if (!(r.w >= MIN_BOX && r.h >= MIN_BOX)) return null;
    const back = p.outcome === "card-back";
    const pf = { i, corners: corners.map((q) => [q[0], q[1]]), outcome: back ? "card-back" : "card" };
    if (angle) pf.angle = angle;
    for (const k of ["score", "box", "rot", "cardId", "sim", "margin", "flag"]) {
      if (p[k] !== undefined && p[k] !== null && !(k === "rot" && !p[k])) pf[k] = p[k];
    }
    const t = { id, corners, estimated: [false, false, false, false], cornerSource: "prefill",
      outcome: pf.outcome, identity: null, identitySource: null, eligible: back ? "no" : null,
      conditions: back ? { faceUp: false } : {}, pending: true, prefill: pf };
    if (angle) t.angle = angle;
    return t;
  }

  function sameCorners(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
    for (let i = 0; i < 4; i++) if (r1(a[i][0]) !== r1(b[i][0]) || r1(a[i][1]) !== r1(b[i][1])) return false;
    return true;
  }

  // The box's provenance against its proposal: accepted when the corners (so the top edge too),
  // the angle and the kind (card / back, not ignored) are as proposed; any other state is
  // corrected. The identity and the click-only tags do not count (a proposal has none).
  function prefillProvenance(t) {
    const p = t && t.prefill;
    if (!p) return null;
    const geom = sameCorners(t.corners, p.corners) && roundAngle(t.angle || 0) === roundAngle(p.angle || 0);
    const kind = (t.outcome || "card") === (p.outcome || "card") && !t.ignore;
    return { labelSource: geom && kind ? "prefill-accepted" : "prefill-corrected", cornerSource: geom ? "prefill" : "prefill-edited" };
  }

  // The provenance an edit of a box gives it, in the Boxes pass and in the Names pass alike
  // (labelcore.py edit_provenance holds the server to the same rule): with `boxSet`, a model box
  // is accepted or corrected against its proposal (prefillProvenance) and is no longer pending;
  // a kept or propagated box becomes `-corrected`; any other keeps its own. Mutates t; → t.
  // A box with free corners keeps `cornerSource: hand`.
  function editProvenance(t, boxSet) {
    const pv = boxSet ? prefillProvenance(t) : null;
    const quad = isQuad(t);
    if (pv) { t.labelSource = pv.labelSource; t.cornerSource = quad ? "hand" : pv.cornerSource; delete t.pending; delete t.suggestion; }
    else if (t.labelSource === "propagated") t.labelSource = "propagated-corrected";
    else if (t.labelSource === "carried") t.labelSource = "carried-corrected";
    return t;
  }

  // The highest IoU of `rect` against any of `rects` (0 for none).
  function maxIoU(rect, rects) {
    let m = 0;
    for (const r of rects) m = Math.max(m, Tools.rectIoU(rect, r));
    return m;
  }

  // ---- model boxes on a frame that already has boxes ---------------------------------------
  //
  // A model box is held back when a box already there covers the same place (IoU ≥ HOLD_IOU),
  // unless both say which card they are, the cards differ, and the model box is not that box's
  // own match: the model box over it that overlaps it most is another one. The two are then two
  // cards, one partly on the other (a card played onto another), and the model box is offered as
  // a suggestion. A model box that is the box's own match, or a near-copy of it (IoU ≥
  // OTHER_CARD_IOU, the tool's "double box" bar: duplicates()), is held back whatever card it
  // names: the same card with another name from the model, which would flood the frame.
  const HOLD_IOU = 0.3;
  const OTHER_CARD_IOU = 0.9;

  // The card a box stands for, as far as the frame's own data says: its name, else the card the
  // model named for it (`prefill.cardId`), else, for a box kept from an earlier frame, that box's
  // card (lookup(frame, id) → the target there, or null). Card backs and ignored boxes have none.
  function boxCard(t, lookup) {
    let cur = t;
    for (let d = 0; cur && d < 1000; d++) {
      if (cur.ignore || (cur.outcome && cur.outcome !== "card")) return null;
      if (cur.identity && cur.identity !== "unknown") return cur.identity;
      if (cur.prefill && typeof cur.prefill.cardId === "string" && cur.prefill.cardId) return cur.prefill.cardId;
      const from = cur.carriedFrom;
      if (!from || !lookup) return null;
      cur = lookup(from.frame, from.target);
    }
    return null;
  }

  // For each model box of a frame (proposals: [{rect, card} or null]), the index in `others`
  // ([{rect, card}], the boxes already there) of the box that holds it back, −1 when it is
  // offered (null for a null proposal).
  // `same(a, b)`: two card ids are one card (default: the same id). A box without a card (drawn
  // by hand and not named yet, a back, an ignored box) holds back any model box over it.
  function heldBack(proposals, others, same) {
    const eq = same || ((a, b) => a === b);
    const iou = others.map((o) => proposals.map((p) => (p ? Tools.rectIoU(p.rect, o.rect) : 0)));
    const own = iou.map((row) => { let b = -1; row.forEach((v, i) => { if (v >= HOLD_IOU && (b < 0 || v > row[b])) b = i; }); return b; });
    return proposals.map((p, i) => {
      if (!p) return null;
      for (let j = 0; j < others.length; j++) {
        const v = iou[j][i];
        if (v < HOLD_IOU) continue;
        const differ = !!p.card && !!others[j].card && !eq(p.card, others[j].card);
        if (!differ || own[j] === i || v >= OTHER_CARD_IOU) return j;
      }
      return -1;
    });
  }

  // ---- a kept box whose card has moved -----------------------------------------------------
  //
  // A kept box (carried, untouched) with no model box over it (every proposal of the frame below
  // STALE_IOU against it: nothing the model sees is there any more), paired with a suggestion
  // that names the same card: the card has moved. Pairs are made only when they are unambiguous:
  // one such kept box and one such suggestion for that card.
  const STALE_IOU = 0.1;

  // kept: [{id, rect, card}] the untouched kept boxes; proposals: [rect] every model box of the
  // frame (held back or not); suggestions: [{id, rect, card}] the pending suggestions.
  // → [{kept: id, suggestion: id}], in the order of `kept`.
  function movedPairs(kept, proposals, suggestions, same) {
    const eq = same || ((a, b) => a === b);
    const stale = kept.filter((k) => k.card && maxIoU(k.rect, proposals) < STALE_IOU);
    const out = [];
    for (const k of stale) {
      const s = suggestions.filter((x) => x.card && eq(x.card, k.card));
      if (s.length !== 1) continue;
      if (stale.filter((o) => eq(o.card, s[0].card)).length !== 1) continue;
      out.push({ kept: k.id, suggestion: s[0].id });
    }
    return out;
  }

  // movedPairs on one frame. targets: the frame's boxes; proposals: [rect] every model box of
  // the frame; cardOf(t): a box's card (boxCard); busy(t): the box is being adjusted.
  function movedOnFrame(targets, proposals, cardOf, same, busy) {
    const one = (t, card) => ({ id: t.id, rect: rectFromCorners(t.corners, t.angle), card });
    const kept = targets.filter((t) => t.labelSource === "carried" && !t.pending && !(busy && busy(t))).map((t) => one(t, cardOf(t)));
    const sugg = targets.filter((t) => t.pending && t.suggestion && t.prefill).map((t) => one(t, t.prefill.cardId || null));
    return movedPairs(kept, proposals, sugg, same);
  }

  // `m`: the kept box takes the suggestion's place, size and turn (its id, kind, name and
  // provenance stay: an edit of a kept box like any other). Mutates kept.
  function moveOnto(kept, sugg) {
    if (isQuad(kept)) kept.cornerSource = rectSource(kept); // the model's box is a rectangle
    kept.corners = sugg.corners.map((q) => [q[0], q[1]]);
    if (sugg.angle) kept.angle = sugg.angle; else delete kept.angle;
    return kept;
  }

  // An arrow from (x0, y0) to (x1, y1): [[from, to], …] segments, the head `head` px long; [] when
  // the two points are closer than 4.
  function arrow(x0, y0, x1, y1, head) {
    const len = Math.hypot(x1 - x0, y1 - y0), k = head || 12;
    if (len < 4) return [];
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    return [[[x0, y0], [x1, y1]], [[x1, y1], [x1 - k * ux + (k / 2) * uy, y1 - k * uy - (k / 2) * ux]],
      [[x1, y1], [x1 - k * ux - (k / 2) * uy, y1 - k * uy + (k / 2) * ux]]];
  }

  // ---- fitting a rotated box into the model's upright box ----------------------------------
  //
  // Turning never changes a box's size. The fit is asked for: `e`, "Fit to
  // the tilted card", resizes a box at its own angle to fit inside its upright base (fitRect),
  // when it has one (fitState): the model's own box, changed only by turns about its center.
  //
  // A model box is upright: the bounding box of a tilted card. Turned as it is, it is larger than
  // the card. fitRotated gives the box of `angle` whose own bounding box is the model's (W × H
  // about its center):  W = w·|cos θ| + h·|sin θ|,  H = w·|sin θ| + h·|cos θ|.
  // Within FIT_EXACT_DEG of a side (|cos 2θ| ≥ cos 2·FIT_EXACT_DEG) the two equations are solved
  // for w and h, the card's own shape (error in W and H grows as 1/|cos 2θ|: at most 2× here).
  // Nearer 45° they say little about the shape (at 45° only w + h), so the shape is kept:
  // h = aspect·w, the least-squares w of both equations. Same for an exact answer that is not a
  // card (a side under MIN_BOX, or one side over FIT_MAX_RATIO times the other).
  const FIT_EXACT_DEG = 30;
  const FIT_MAX_RATIO = 3;

  // A box's upright bounding box on screen: {cx, cy, w, h}.
  function upright(corners) {
    const [x0, y0, x1, y1] = aabb(corners);
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  }

  // Whether `t` can be fitted, and into what: {base: its upright box, ref} or {reason}:
  //   "none"    no box
  //   "edited"  not the model's own box changed only by turns about its center (moved, resized,
  //             drawn by hand, kept from another frame) and no fit or `m` of this one since
  //   "edge"    the model's box touches the frame's W × H edge: a cut box is no card's upright box
  // last: the page's record of the box's fits and `m` ({base, rects: [{cx, cy, w, h}]}): every
  // rect a fit or `m` gave it, so an undo back to any of them still matches; while the box is
  // only turned since, the base holds. Turns keep the center and the own sides (w, h; an odd
  // top-edge change swaps them), within FIT_SAME_PX. `ref` is the matched rect, exact and with
  // the box's own sides: turns are made from it (turnRect), so 0.1 px rounding never adds up.
  const FIT_SAME_PX = 0.5;
  function fitState(t, last, W, H) {
    if (!t || !Array.isArray(t.corners)) return { reason: "none" };
    const r = rectFromCorners(t.corners, t.angle);
    const near = (a, b) => Math.abs(a - b) <= FIT_SAME_PX;
    const match = (a) => {
      if (!near(r.cx, a.cx) || !near(r.cy, a.cy)) return null;
      if (near(r.w, a.w) && near(r.h, a.h)) return { cx: a.cx, cy: a.cy, w: a.w, h: a.h };
      return near(r.w, a.h) && near(r.h, a.w) ? { cx: a.cx, cy: a.cy, w: a.h, h: a.w } : null;
    };
    for (const a of (last && last.base && last.rects) || []) { const ref = match(a); if (ref) return { base: last.base, ref }; }
    const p = t.prefill;
    const ref = p && Array.isArray(p.corners) ? match(rectFromCorners(p.corners, p.angle)) : null;
    if (!ref) return { reason: "edited" };
    if (atEdge(p.corners, W, H)) return { reason: "edge", ref };
    return { base: upright(p.corners), ref };
  }

  // The fit as the key and the button offer it: fitState, and "upright" for a box at a quarter
  // turn (nothing to fit: turn it to the card's angle first).
  function fitAction(t, last, W, H) {
    const st = fitState(t, last, W, H);
    return st.base && roundAngle(rectFromCorners(t.corners, t.angle).angle) % 90 === 0 ? { reason: "upright" } : st;
  }

  // `t` turned to `angle`: from its matched reference (fitState's ref, exact) when it has one,
  // else from its own corners.
  function turnRect(t, angle, last, W, H) {
    const src = fitState(t, last, W, H).ref || rectFromCorners(t.corners, t.angle);
    return { cx: src.cx, cy: src.cy, w: src.w, h: src.h, angle };
  }

  // The record after a fit or `m` left the box as `rect` in `base`: appended to `last` when it
  // is for the same base, else a new one.
  function fitRecord(last, base, rect) {
    const one = { cx: rect.cx, cy: rect.cy, w: rect.w, h: rect.h };
    const same = last && last.base && ["cx", "cy", "w", "h"].every((k) => last.base[k] === base[k]);
    const rects = same ? last.rects : [];
    const top = rects[rects.length - 1];
    if (top && ["cx", "cy", "w", "h"].every((k) => top[k] === one[k])) return last; // an "already fits" press
    return { base, rects: rects.concat([one]) };
  }

  function fitBase(t, last, W, H) { return fitState(t, last, W, H).base || null; }

  // The box `t` fitted into `base` at its own angle (the card's 88 : 63 near 45°, cardAspect).
  function fitRect(t, base) {
    const r = rectFromCorners(t.corners, t.angle);
    return fitRotated(base, r.angle, cardAspect(base, r.angle, 88 / 63, r));
  }

  // A turned box (not at a quarter turn) with a base, larger than its fit by more than 1 px: the
  // instruction line says the fit is there.
  function needsFit(t, last, W, H) {
    const base = fitBase(t, last, W, H);
    if (!base) return false;
    const r = rectFromCorners(t.corners, t.angle), f = fitRect(t, base);
    return roundAngle(r.angle) % 90 !== 0 && (r.w > f.w + 1 || r.h > f.h + 1);
  }

  // The box touches the edge of a W × H frame (within half a pixel); false when W, H are not given.
  function atEdge(corners, W, H) {
    if (!(W > 0 && H > 0)) return false;
    const [x0, y0, x1, y1] = aabb(corners);
    return x0 <= 0.5 || y0 <= 0.5 || x1 >= W - 0.5 || y1 >= H - 0.5;
  }

  // The card's own h / w for a fit near 45°, from its long / short `ratio` (the page: 88 / 63,
  // as the tool assumes for every card: labelcore.CARD_ASPECT). Which way the card stands comes
  // from the upright box: H − W = (h − w)(|cos θ| − |sin θ|), so the card stands (h > w) when
  // (H − W)(|cos θ| − |sin θ|) ≥ 0. Only at a true tie (a square box, or 45°) does the box's
  // own shape `own` ({w, h}) decide. (The box's own sides alone lay a portrait card down past
  // 45°: its upright box is then wider than tall.)
  function cardAspect(base, angle, ratio, own) {
    const r = ratio >= 1 ? ratio : 1 / ratio;
    const t = (angle * Math.PI) / 180, k = (base.h - base.w) * (Math.abs(Math.cos(t)) - Math.abs(Math.sin(t)));
    const standing = Math.abs(k) < 1e-6 || !isFinite(k) ? !own || own.h >= own.w : k > 0;
    return standing ? r : 1 / r;
  }

  // base: {cx, cy, w: W, h: H} (the upright box), angle: degrees, aspect: the card's own h / w
  // in the box's own frame (> 1 standing, < 1 lying). → {cx, cy, w, h, angle}
  function fitRotated(base, angle, aspect) {
    if (!isFinite(angle)) return { cx: base.cx, cy: base.cy, w: base.w, h: base.h, angle: 0 };
    const t = (angle * Math.PI) / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
    const W = base.w, H = base.h, det = c * c - s * s;
    const out = (w, h) => ({ cx: base.cx, cy: base.cy, w, h, angle });
    if (Math.abs(det) >= Math.cos((2 * FIT_EXACT_DEG * Math.PI) / 180) - 1e-9) {
      const w = (W * c - H * s) / det, h = (H * c - W * s) / det;
      if (w >= MIN_BOX && h >= MIN_BOX && Math.max(w, h) / Math.min(w, h) <= FIT_MAX_RATIO) return out(w, h);
    }
    const r = aspect > 0 && isFinite(aspect) ? aspect : 1;
    const a = c + r * s, b = s + r * c;
    const w = Math.max(MIN_BOX, (W * a + H * b) / (a * a + b * b));
    return out(w, Math.max(MIN_BOX, r * w));
  }

  // ---- review walk: one box at a time, zoomed, to check and fix its top edge ------

  // The walk's order on one frame, as target indices: the boxes that are not ignored in reading
  // order (rows top to bottom, then left to right, by box center: labeltools.readingOrder), then
  // the ignored ones in reading order (only with includeIgnore). Depends on the centers and the
  // ignore flag only, so a quarter turn or a new top edge (same center) never reorders it.
  // Boxes whose orientation does not matter: ignore regions, card backs and
  // other non-face outcomes. The review walk leaves them out unless asked ("include backs and ignore").
  function reviewAside(t) { return !!t.ignore || (!!t.outcome && t.outcome !== "card"); }

  function reviewOrder(targets, includeIgnore) {
    const part = (ign) => {
      const ii = targets.map((_, i) => i).filter((i) => reviewAside(targets[i]) === ign);
      return Tools.readingOrder(ii.map((i) => rectFromCorners(targets[i].corners, targets[i].angle))).map((k) => ii[k]);
    };
    return part(false).concat(includeIgnore ? part(true) : []);
  }

  // One frame's walk, stable while it is walked: `cached` (the ids in the order first seen this
  // review session, or null) keeps a box where it was even after `h` (else it would jump to the
  // end of the frame and the walk would skip the boxes between); a box new since then (an undo
  // brought it back) comes after, in reviewOrder. Returns {ids: the walk's ids now (removed boxes
  // and, without includeIgnore, ignored ones left out), cache: the order to keep}.
  function reviewFrameIds(targets, includeIgnore, cached) {
    const byId = new Map(targets.map((t) => [t.id, t]));
    const base = Array.isArray(cached) ? cached.slice() : [];
    const seen = new Set(base);
    for (const i of reviewOrder(targets, true)) if (!seen.has(targets[i].id)) { base.push(targets[i].id); seen.add(targets[i].id); }
    const ids = base.filter((id) => byId.has(id) && (includeIgnore || !reviewAside(byId.get(id))));
    return { ids, cache: base };
  }

  // The whole walk: frames in order ([{name, targets}]), each frame's boxes by reviewFrameIds.
  // `cache` (a Map name → ids) is read and updated. Returns [{frame, id}].
  function reviewWalk(frames, includeIgnore, cache) {
    const out = [];
    for (const f of frames) {
      const ts = f.targets || [];
      if (!ts.length) continue;
      const r = reviewFrameIds(ts, includeIgnore, cache ? cache.get(f.name) : null);
      if (cache) cache.set(f.name, r.cache);
      for (const id of r.ids) out.push({ frame: f.name, id });
    }
    return out;
  }

  // Where `cur` ({frame, id, idx: its index when last seen}) is in the walk: {i, present}. A box
  // that left the walk (deleted, or ignored while ignored boxes are left out) leaves a gap at its
  // old index: list[i] is then its successor.
  function reviewLocate(list, cur) {
    if (!cur) return { i: 0, present: false };
    const i = list.findIndex((e) => e.frame === cur.frame && e.id === cur.id);
    if (i >= 0) return { i, present: true };
    return { i: clamp(Math.round(cur.idx || 0), 0, list.length), present: false };
  }

  // The index one step from `cur` (dir +1 next, −1 previous), or −1 past either end.
  function reviewStep(list, cur, dir) {
    const { i, present } = reviewLocate(list, cur);
    const j = dir > 0 ? (present ? i + 1 : i) : i - 1;
    return j >= 0 && j < list.length ? j : -1;
  }

  // The zoom views (identify's walk, the review walk): the set's zoom z0, lowered only when the
  // box (its larger aabb side `span`, frame px) would not fit `fill` of the view's `size` px.
  function fitZoom(span, size, z0, fill) {
    const f = typeof fill === "number" ? fill : 0.9;
    return span * z0 > size * f ? Math.max(0.1, (size * f) / span) : z0;
  }

  // A zoom view v = {cx, cy, z, w, h}: frame point (cx, cy) at the center of a w × h px view, z
  // view px per frame px. View px ↔ frame px.
  function viewToFrame(v, x, y) { return { x: v.cx + (x - v.w / 2) / v.z, y: v.cy + (y - v.h / 2) / v.z }; }
  function frameToView(v, p) { return [(p[0] - v.cx) * v.z + v.w / 2, (p[1] - v.cy) * v.z + v.h / 2]; }

  // Alt+click in a zoom view: the edge of `rect` (frame px) within tolPx VIEW px of view point
  // (x, y), as nearestEdge's k (0 the current top, clockwise), or null.
  function viewEdgeAt(v, rect, x, y, tolPx) { return nearestEdge(rect, viewToFrame(v, x, y), tolPx / v.z); }

  // ---- visible parts (the stacking view; nothing is saved) ----------------------------------
  // The part of each box that no box above it covers, every box counting as a cover (ignore
  // boxes too). Each box is laid on a grid in its own frame (its top edge along x, `grid` cells
  // on its longer side); a cell is covered when a box above touches any part of it, so a visible
  // part never reaches into a box above. Per box (index-aligned with `targets`): rank (1 = the
  // bottom), share (uncovered cells / all cells), and corners (the largest uncovered rectangle,
  // in the box's own frame and corner order; the box's own corners when nothing covers it; null
  // when it is wholly covered).
  const VISIBLE_GRID = 240;

  function clipHalfPlane(poly, f) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
    }
    return out;
  }

  // The x extent of a convex polygon inside the band y0 <= y <= y1, or null.
  function bandExtent(poly, y0, y1) {
    let p = clipHalfPlane(poly, (q) => q[1] - y0);
    if (p.length < 2) return null;
    p = clipHalfPlane(p, (q) => y1 - q[1]);
    if (!p.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const q of p) { lo = Math.min(lo, q[0]); hi = Math.max(hi, q[0]); }
    return [lo, hi];
  }

  // The largest all-true rectangle of a row-major boolean grid: {area, x0, y0, x1, y1} (x1, y1
  // exclusive); the first found wins a tie.
  function largestRect(free, nx, ny) {
    let best = { area: 0, x0: 0, y0: 0, x1: 0, y1: 0 };
    const hts = new Array(nx).fill(0);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) hts[x] = free[y * nx + x] ? hts[x] + 1 : 0;
      const st = [];
      for (let x = 0; x <= nx; x++) {
        const h = x < nx ? hts[x] : 0;
        let start = x;
        while (st.length && st[st.length - 1][1] >= h) {
          const [s, sh] = st.pop();
          const area = sh * (x - s);
          if (area > best.area) best = { area, x0: s, y0: y - sh + 1, x1: x, y1: y + 1 };
          start = s;
        }
        st.push([start, h]);
      }
    }
    return best;
  }

  // A box with free corners (not a rectangle) is laid on a grid in the frame of its top edge,
  // over its own extent there; only the cells whose middle lies inside it count.
  function visiblePart(corners, covers, grid) {
    const [p0, p1, , p3] = corners;
    const quad = !isRectangle(corners);
    let W = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), H = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    if (!(W > 0 && H > 0)) return { share: 0, corners: null };
    let ex = [(p1[0] - p0[0]) / W, (p1[1] - p0[1]) / W], ey = [(p3[0] - p0[0]) / H, (p3[1] - p0[1]) / H], u0 = 0, v0 = 0;
    if (quad) {
      ey = [-ex[1], ex[0]];
      const us = corners.map((p) => (p[0] - p0[0]) * ex[0] + (p[1] - p0[1]) * ex[1]), vs = corners.map((p) => (p[0] - p0[0]) * ey[0] + (p[1] - p0[1]) * ey[1]);
      u0 = Math.min(...us); v0 = Math.min(...vs); W = Math.max(...us) - u0; H = Math.max(...vs) - v0;
      if (!(W > 0 && H > 0)) return { share: 0, corners: null };
    }
    const toBox = (p) => { const dx = p[0] - p0[0], dy = p[1] - p0[1]; return [dx * ex[0] + dy * ex[1] - u0, dx * ey[0] + dy * ey[1] - v0]; };
    const fromBox = (u, v) => [r1(p0[0] + (u + u0) * ex[0] + (v + v0) * ey[0]), r1(p0[1] + (u + u0) * ex[1] + (v + v0) * ey[1])];
    const polys = [];
    for (const c of covers) {
      const poly = c.map(toBox);
      const xs = poly.map((q) => q[0]), ys = poly.map((q) => q[1]);
      if (Math.max(...xs) <= 0 || Math.min(...xs) >= W || Math.max(...ys) <= 0 || Math.min(...ys) >= H) continue;
      if (signedArea(poly) === 0) continue;
      polys.push(poly);
    }
    if (!polys.length) return { share: 1, corners: corners.map((p) => [p[0], p[1]]) };
    const step = Math.max(W, H) / (grid || VISIBLE_GRID);
    const nx = Math.max(1, Math.round(W / step)), ny = Math.max(1, Math.round(H / step));
    const sx = W / nx, sy = H / ny;
    const free = new Uint8Array(nx * ny).fill(1);
    let all = nx * ny;
    if (quad) {
      const own = corners.map(toBox);
      all = 0;
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        if (pointInQuad(own, { x: (x + 0.5) * sx, y: (y + 0.5) * sy })) all++; else free[y * nx + x] = 0;
      }
      if (!all) return { share: 0, corners: null };
    }
    for (let y = 0; y < ny; y++) {
      const y0 = y * sy + 1e-9, y1 = (y + 1) * sy - 1e-9; // a box that only touches the row's edge does not cover it
      for (const poly of polys) {
        const e = bandExtent(poly, y0, y1);
        if (!e) continue;
        const i0 = Math.max(0, Math.floor(e[0] / sx + 1e-9)), i1 = Math.min(nx - 1, Math.ceil(e[1] / sx - 1e-9) - 1);
        for (let i = i0; i <= i1; i++) free[y * nx + i] = 0;
      }
    }
    let n = 0;
    for (const v of free) n += v;
    if (!n) return { share: 0, corners: null };
    const b = largestRect(free, nx, ny);
    if (!quad && b.area === nx * ny) return { share: 1, corners: corners.map((p) => [p[0], p[1]]) };
    if (quad && n === all) return { share: 1, corners: corners.map((p) => [p[0], p[1]]) };
    const u0b = b.x0 * sx, u1 = b.x1 * sx, v0b = b.y0 * sy, v1 = b.y1 * sy;
    return { share: n / all, corners: [fromBox(u0b, v0b), fromBox(u1, v0b), fromBox(u1, v1), fromBox(u0b, v1)] };
  }

  function visibleParts(targets, grid) {
    const order = orderAsc(targets);
    return targets.map((t, i) => {
      const pos = order.indexOf(i);
      const covers = order.slice(pos + 1).map((j) => targets[j].corners).filter((c) => Array.isArray(c) && c.length === 4);
      const v = Array.isArray(t.corners) && t.corners.length === 4 ? visiblePart(t.corners, covers, grid) : { share: 0, corners: null };
      return { rank: pos + 1, share: v.share, corners: v.corners };
    });
  }

  // ---- a box with free corners (a quad) ------------------------------------------------------
  // In the Boxes pass, Shift+drag on a corner handle frees the box's corners: from then on each
  // corner moves on its own, so a card seen in perspective gets its true outline. Such a box is
  // stored with `cornerSource: "hand"` (the hand-placed corners of the format) and no `angle`;
  // its corner order still starts at the card's own top-left. It stays convex and clockwise,
  // every side at least MIN_BOX px, every corner within QUAD_RANGE. Pressing E (quadToRect) or
  // any action that sets a box's size makes it a rectangle again.

  const CONVEX_EPS = 1e-9;

  function isQuad(t) { return !!t && t.cornerSource === "hand"; }

  // The cornerSource a quad gets back when it becomes a rectangle again: kept from another frame
  // or from a tracking script it is that again; a model's box is "prefill-edited" (editProvenance
  // settles it when the box is committed); any other is a box.
  function rectSource(t) {
    if (t && t.carriedFrom) return "carried";
    if (t && t.propagatedFrom) return "propagated";
    if (t && t.prefill) return "prefill-edited";
    return "box";
  }

  function quadCenter(q) {
    return { x: (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, y: (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4 };
  }

  // Clockwise on screen, strictly convex (every turn the same way), every side at least `minSide`.
  function isConvexQuad(q, minSide) {
    if (!Array.isArray(q) || q.length !== 4) return false;
    if (q.some((p) => !isFinite(p[0]) || !isFinite(p[1]))) return false;
    const m = typeof minSide === "number" ? minSide : 1;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      if (dist(a, b) < m) return false;
      // a turn under CONVEX_EPS (labelcore.is_convex's tolerance) is a straight corner: refused
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < CONVEX_EPS) return false;
    }
    return true;
  }

  // Why an edited quad cannot be kept, or null: "fold" (not convex, or a side under MIN_BOX) or
  // "range" (a corner past QUAD_RANGE).
  function quadProblem(q, W, H) {
    if (!isConvexQuad(q, MIN_BOX)) return "fold";
    if (W > 0 && H > 0 && !cornersInRange(q, W, H)) return "range";
    return null;
  }

  // An edited quad, rounded as stored: {corners} or {refused: "fold" | "range"}.
  function quadResult(raw, W, H) {
    const q = raw.map((p) => [r1(p[0]) + 0, r1(p[1]) + 0]);
    const why = quadProblem(q, W, H);
    return why ? { refused: why } : { corners: q };
  }

  // Corner i (0 TL … 3 BL in the card's own order) dragged to p; the others stay.
  function moveQuadCorner(q, i, p, W, H) {
    return quadResult(q.map((c, k) => (k === i ? [p.x, p.y] : [c[0], c[1]])), W, H);
  }

  // Edge k (0 top, 1 right, 2 bottom, 3 left: corners k and k+1) moved by (dx, dy).
  function moveQuadEdge(q, k, dx, dy, W, H) {
    return quadResult(q.map((c, i) => (i === k || i === (k + 1) % 4 ? [c[0] + dx, c[1] + dy] : [c[0], c[1]])), W, H);
  }

  // The quad turned by `deg` (clockwise on screen) about its center.
  function rotateQuad(q, deg, W, H) {
    const c = quadCenter(q);
    return quadResult(q.map((p) => { const r = rotatePoint(p[0] - c.x, p[1] - c.y, deg); return [c.x + r.x, c.y + r.y]; }), W, H);
  }

  // One step of a drag on a quad (the page's drag record d: mode "corner" | "edge" | "qrotate",
  // the handle, the corners and center at its start, the start point and angle), p the pointer.
  function quadDrag(d, p, W, H) {
    if (d.mode === "corner") return moveQuadCorner(d.corners, HANDLES.indexOf(d.handle), p, W, H);
    if (d.mode === "edge") return moveQuadEdge(d.corners, EDGE_NAMES.indexOf(d.handle), p.x - d.start.x, p.y - d.start.y, W, H);
    return rotateQuad(d.corners, angleFromCenter(d.center, p) - d.startAngle, W, H);
  }

  // Corners kept as a quad's: `cornerSource: hand`, no angle. Mutates t.
  function setQuadCorners(t, corners) {
    t.corners = corners;
    t.cornerSource = "hand";
    delete t.angle;
    return t;
  }

  // The rotate knob of any box, `offset` px out from its own top edge.
  function knobOf(t, offset) {
    return isQuad(t) ? quadKnobPos(t.corners, offset) : rotateHandlePos(rectFromCorners(t.corners, t.angle), offset);
  }

  // The handles of any box: where they are drawn (its corners), and which one is under p (knob,
  // corner or edge, the box's own sides for a quad): {mode: "rotate"} | {mode: "resize", handle} | null.
  function handlePoints(t) { return isQuad(t) ? t.corners : cornersFromRectRaw(rectFromCorners(t.corners, t.angle)); }
  function handleAt(t, p, knobOff, tol, ew) {
    const k = knobOf(t, knobOff);
    if (Math.hypot(p.x - k.x, p.y - k.y) <= tol) return { mode: "rotate" };
    const q = isQuad(t), r = rectFromCorners(t.corners, t.angle);
    const c = q ? hitQuadCorner(t.corners, p, tol) : hitCorner(r, p, tol);
    const e = c || (q ? hitQuadEdge(t.corners, p, ew) : hitEdge(r, p, ew));
    return e ? { mode: "resize", handle: e } : null;
  }

  // The drag a grab of a box's handle starts: "corner", "edge" or "qrotate" on a quad (a corner
  // grabbed with Shift frees a box's corners: "corner"), null for a box's own resize or rotate.
  function quadDragMode(t, hit, shift) {
    const corner = hit.mode === "resize" && HANDLES.includes(hit.handle);
    if (!isQuad(t)) return corner && shift ? "corner" : null;
    return hit.mode === "rotate" ? "qrotate" : corner ? "corner" : hit.mode === "resize" ? "edge" : null;
  }

  // E on a quad: the rectangle it goes back to (quadToRect), or null when a turned one would put a
  // corner past QUAD_RANGE.
  function quadBackToRect(q, W, H) {
    const r = quadToRect(q), a = roundAngle(r.angle);
    return a !== 0 && !cornersInRange(cornersFromRect(Object.assign({}, r, { angle: a })), W, H) ? null : r;
  }

  // The rectangle a quad goes back to: its center, the mean direction of its top and bottom
  // edges, the mean length of each pair of opposite sides. A rectangle comes back exactly.
  function quadToRect(q) {
    const c = quadCenter(q);
    const ux = (q[1][0] - q[0][0]) + (q[2][0] - q[3][0]), uy = (q[1][1] - q[0][1]) + (q[2][1] - q[3][1]);
    const a = (Math.atan2(uy, ux) * 180) / Math.PI;
    return { cx: c.x, cy: c.y, w: (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, h: (dist(q[1], q[2]) + dist(q[0], q[3])) / 2,
      angle: normalizeAngle(Math.abs(a) < 1e-9 ? 0 : a) };
  }

  // The rotate knob of a quad: `offset` px out from the middle of its top edge, square to it.
  function quadKnobPos(q, offset) {
    const mx = (q[0][0] + q[1][0]) / 2, my = (q[0][1] + q[1][1]) / 2;
    const ex = q[1][0] - q[0][0], ey = q[1][1] - q[0][1], len = Math.hypot(ex, ey) || 1;
    return { x: mx + (ey / len) * offset, y: my - (ex / len) * offset }; // clockwise corners: the outside is to the left
  }

  function hitQuadCorner(q, p, tol) {
    let best = null, bd = tol;
    q.forEach((c, i) => { const d = Math.hypot(c[0] - p.x, c[1] - p.y); if (d <= bd) { bd = d; best = HANDLES[i]; } });
    return best;
  }

  // Distance from p to segment a-b, and where along it (0..1) the nearest point is.
  function segDist(a, b, p) {
    const ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey || 1;
    const u = clamp(((p.x - a[0]) * ex + (p.y - a[1]) * ey) / l2, 0, 1);
    return { d: Math.hypot(a[0] + u * ex - p.x, a[1] + u * ey - p.y), u, len: Math.sqrt(l2) };
  }

  const EDGE_NAMES = ["t", "r", "b", "l"];

  // The edge band `ew` px wide along a quad's side, its ends (the corners) excluded: "t" | … | null.
  function hitQuadEdge(q, p, ew) {
    let best = null, bd = ew;
    for (let k = 0; k < 4; k++) {
      const s = segDist(q[k], q[(k + 1) % 4], p);
      const end = ew / s.len;
      if (s.d <= bd && s.u > end && s.u < 1 - end) { bd = s.d; best = EDGE_NAMES[k]; }
    }
    return best;
  }

  // The edge of a quad nearest to p within `tol` px (corners included): k (0 its top, clockwise) or null.
  function nearestQuadEdge(q, p, tol) {
    let k = null, bd = tol;
    for (let i = 0; i < 4; i++) { const d = segDist(q[i], q[(i + 1) % 4], p).d; if (d <= bd) { bd = d; k = i; } }
    return k;
  }

  // nearestEdge for any box: a quad by its own sides, a rectangle as before.
  function nearestEdgeOf(t, p, tol) {
    return isQuad(t) ? nearestQuadEdge(t.corners, p, tol) : nearestEdge(rectFromCorners(t.corners, t.angle), p, tol);
  }

  // ---- a box beside another (D then an arrow) ------------------------------------------------
  // The same size and angle, directly against the side of `rect` that faces the screen direction
  // `dir` ("left" | "right" | "up" | "down"): of the box's own four sides, the one whose outward
  // direction is closest to `dir`, so a tilted or turned box gets its neighbor in its own row or
  // column. Frame px; nothing is clamped to the frame.
  const SCREEN_DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

  function besideRect(rect, dir) {
    const d = SCREEN_DIRS[dir];
    if (!d) return null;
    const a = ((rect.angle || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const sides = [
      { u: [c, s], ext: rect.w }, { u: [-c, -s], ext: rect.w }, // along the box's own top edge
      { u: [-s, c], ext: rect.h }, { u: [s, -c], ext: rect.h }, // along its own left edge
    ];
    let best = sides[0], bd = -Infinity;
    for (const sd of sides) { const v = sd.u[0] * d[0] + sd.u[1] * d[1]; if (v > bd + 1e-9) { bd = v; best = sd; } }
    return { cx: rect.cx + best.u[0] * best.ext, cy: rect.cy + best.u[1] * best.ext, w: rect.w, h: rect.h, angle: rect.angle || 0 };
  }

  // D then an arrow on any box: {rect: besideRect of it, corners: null}; a quad's own outline is
  // moved beside it instead (corners; rect is where its quadToRect lands).
  function besideOf(t, dir) {
    const q = isQuad(t), from = q ? quadToRect(t.corners) : rectFromCorners(t.corners, t.angle), r = besideRect(from, dir);
    const dx = r.cx - from.cx, dy = r.cy - from.cy; // not clamped: the page refuses one past QUAD_RANGE
    return { rect: r, corners: q ? t.corners.map((p) => [r1(p[0] + dx) + 0, r1(p[1] + dy) + 0]) : null };
  }

  const api = {
    besideOf,
    isQuad, rectSource, quadCenter, isConvexQuad, quadProblem, quadResult, quadDrag, knobOf, handlePoints, handleAt, quadDragMode, quadBackToRect, setQuadCorners, moveQuadCorner, moveQuadEdge, rotateQuad, quadToRect, quadKnobPos,
    hitQuadCorner, hitQuadEdge, nearestQuadEdge, nearestEdgeOf, EDGE_NAMES, HANDLES,
    besideRect, quadsOverlap, reorderAmongOverlaps, stackLayers, pasteGroup,
    VISIBLE_GRID, visibleParts,
    reviewOrder, reviewFrameIds, reviewWalk, reviewLocate, reviewStep, fitZoom, viewToFrame, frameToView, viewEdgeAt,
    MIN_BOX, PASTE_OFFSET, RECT_TOL, r1, clamp, normalizeAngle, roundAngle, rotatePoint, rectFromCorners, cornersFromRect,
    cornersFromRectRaw, signedArea, isRectangle, aabb, boxCorners, pointInQuad, translateCorners, resizePoint, QUAD_RANGE, cornersInRange, rangeExcess, rangeNoWorse, resizeWithin, newTargetIds, hitCorner, hitEdge,
    rotateHandlePos, angleFromCenter, resizeRect, tapToggle, quarterTurn, setTopEdge, topEdgeCorners, nearestEdge, zOf, orderAsc, orderDesc, nextZ, reorder, makeClip,
    pasteTarget, carryTargets, isCarried, duplicates, layoutMatches,
    prefillTarget, prefillProvenance, editProvenance, sameCorners, maxIoU, quarterTurns, scaleProposal,
    HOLD_IOU, OTHER_CARD_IOU, STALE_IOU, FIT_EXACT_DEG, boxCard, heldBack, movedPairs, movedOnFrame, moveOnto, arrow, upright, fitBase, fitState, fitAction, turnRect, fitRecord, fitRect, needsFit, atEdge, cardAspect, fitRotated,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LabelerBoxGeom = api;
})(typeof window !== "undefined" ? window : globalThis);
