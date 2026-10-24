// SPDX-License-Identifier: Apache-2.0
// The Boxes pass's geometry edits on the selected box: writing a rect onto a box, a box with
// free corners (a quad: Shift+drag a corner), turns, the top edge, the fit, a nudge's resize and
// a quad's drag. No DOM: the page hands in what these need (`create(page)`), and Node tests them
// with a stand-in (test_boxedit.js). Shared by the page (window.LabelerBoxEdit) and Node.
//
// page = {
//   frameSize()           [W, H] of the frame
//   framePixels()         the frame's pixels for snapping, or null
//   setStatus(text)       the status line
//   editGeometry(ids, fn) apply fn(t) to those boxes as one undo step; true when one changed
//   selected()            the primary selected box, or null
//   primaryIds()          [its id] or []
//   selectedIds()         every selected box's id
//   row()                 the frame's row; pushUndo(row, before) records an undo step
//   state                 the page's state: `nudge` ({at, key}) joins a burst of arrow presses
//   isMulti()             several boxes are selected
//   editable()            the frame takes a change now
//   noTargetMessage()     what to say with no box selected
//   turnedRect(t, angle)  t turned to angle, from its exact fit reference (sources.js)
//   fitStateOf(t), remember(t, base, rect)   the fit's state and record (boxgeom.fitAction)
//   notes                 uistate.js NOTES
//   QS                    quadsnap.js
// }
(function (root) {
  "use strict";

  const G = typeof module !== "undefined" && module.exports ? require("./boxgeom.js") : root.LabelerBoxGeom;

  const TOO_FAR = "A corner would be more than a whole frame outside the picture: the box stops here.";
  const EDGE_NAMES = ["top", "right", "bottom", "left"];
  const NUDGE_COALESCE_MS = 500;

  // What a geometry edit compares before and after (the page's editGeometry): corners, angle and
  // cornerSource, so E on a box with free corners that already form its rectangle is an edit too.
  function geometrySig(ts) { return JSON.stringify(ts.map((t) => [t.corners, t.angle, t.cornerSource])); }

  function create(page) {
    const P = page;
    const QN = P.notes.quad;

    // Write a rect onto a box: corners in its own order, `angle` stored only when not 0 (an
    // upright box is cut at the frame). A box with free corners given a rect is a rectangle again.
    function setRect(t, rect) {
      if (G.isQuad(t)) t.cornerSource = G.rectSource(t);
      const a = G.roundAngle(rect.angle || 0);
      if (a === 0) {
        const [W, H] = P.frameSize();
        t.corners = G.boxCorners(rect.cx - rect.w / 2, rect.cy - rect.h / 2, rect.cx + rect.w / 2, rect.cy + rect.h / 2, W, H);
        delete t.angle;
      } else {
        t.corners = G.cornersFromRect(Object.assign({}, rect, { angle: a }));
        t.angle = a;
      }
    }

    // Write a rect that turns a box (r, R, w, W, e, the knob): kept only when no corner ends past
    // QUAD_RANGE (or, for a box already past it, none further out). Otherwise the box stays as it
    // is, with TOO_FAR. True when written.
    function turnAllowed(t, rect) {
      const a = G.roundAngle(rect.angle || 0);
      return a === 0 || G.rangeNoWorse(G.cornersFromRect(Object.assign({}, rect, { angle: a })), t.corners, ...P.frameSize());
    }
    function turnTo(t, rect) {
      if (!turnAllowed(t, rect)) { P.setStatus(TOO_FAR); return false; }
      setRect(t, rect);
      return true;
    }

    // A resize that G.resizeWithin refused (null) leaves the box as it is, with a word why.
    function resizeTo(t, rect) {
      if (rect) setRect(t, rect); else P.setStatus(TOO_FAR);
    }

    // A quad edit's result ({corners} or {refused}) onto t: true when it was kept.
    function applyQuad(t, res) {
      if (res.refused) { P.setStatus(res.refused === "fold" ? QN.fold : TOO_FAR); return false; }
      G.setQuadCorners(t, res.corners);
      return true;
    }

    // A box with free corners turns about its center (r, R, w, W).
    const turnQuad = (t, deg) => applyQuad(t, G.rotateQuad(t.corners, deg, ...P.frameSize()));

    function rotateSel(delta) {
      P.editGeometry(P.primaryIds(), (t) => (G.isQuad(t) ? turnQuad(t, delta)
        : turnTo(t, P.turnedRect(t, G.normalizeAngle(G.rectFromCorners(t.corners, t.angle).angle + delta)))));
    }

    // w / W: a quarter turn, keeping any small tilt.
    function tapSel(dir) {
      P.editGeometry(P.primaryIds(), (t) => {
        if (G.isQuad(t)) return turnQuad(t, dir > 0 ? 90 : -90);
        const r = G.rectFromCorners(t.corners, t.angle);
        r.angle = G.quarterTurn(r.angle, dir);
        return turnTo(t, r);
      });
    }

    // Alt+click an edge of the selected box: that edge becomes the card's own top. The four points
    // stay exactly; the corner order starts at that edge (q[0]→q[1]) and the angle turns by 90·k
    // (a box with free corners has none).
    function setTopEdgeSel(k) {
      if (P.isMulti()) { P.setStatus(P.noTargetMessage()); return; }
      if (!k) { P.setStatus("That edge is already the top."); return; }
      const done = P.editGeometry(P.primaryIds(), (t) => {
        const a = G.roundAngle(G.rectFromCorners(t.corners, t.angle).angle + 90 * k);
        t.corners = G.topEdgeCorners(t.corners, k);
        if (a === 0 || G.isQuad(t)) delete t.angle; else t.angle = a;
      });
      if (done) P.setStatus(`The card's top is now the ${EDGE_NAMES[k]} edge.`);
    }

    // `e`: "Fit to the tilted card" (boxgeom.fitState / fitRect), one undo step; on a box with
    // free corners, a rectangle again (toRectSel).
    function fitSel() {
      if (!P.editable()) return;
      if (!P.isMulti() && G.isQuad(P.selected())) { toRectSel(); return; }
      const t = P.isMulti() ? null : P.selected(), st = P.fitStateOf(t);
      if (!st.base) { P.setStatus(P.notes.fitWhy[st.reason]); return; }
      const f = G.fitRect(t, st.base);
      if (!turnAllowed(t, f)) { P.setStatus(TOO_FAR); return; } // nothing remembered, nothing changed
      P.remember(t, st.base, f); // before the redraw
      P.setStatus(P.editGeometry([t.id], (x) => turnTo(x, f)) ? P.notes.fitted : P.notes.fitsAlready);
    }

    // E on a box with free corners: a rectangle again (G.quadBackToRect; the top edge stays). Its
    // cornerSource changes even when its corners already were that rectangle: an edit like any.
    function toRectSel() {
      const t = P.selected(), r = G.quadBackToRect(t.corners, ...P.frameSize());
      if (!r) P.setStatus(TOO_FAR); else if (P.editGeometry([t.id], (x) => setRect(x, r))) P.setStatus(QN.rect);
    }

    // S on a box with free corners: quadsnap.js, as in the Corners pass; one undo step. Snapping
    // only moves a corner that is already near the card's edges.
    function snapQuadSel() {
      const t = P.selected(), px = P.framePixels(), [W, H] = P.frameSize();
      if (!px || !P.editable()) { P.setStatus(px ? "" : QN.noPicture); return; }
      const res = P.QS.refineQuad(px, t.corners, t.estimated), q = res.snapped ? G.quadResult(res.corners, W, H) : { refused: 1 };
      if (q.refused || !P.editGeometry([t.id], (x) => { x.corners = q.corners; })) P.setStatus(QN.snapKept); else P.setStatus(QN.snapped);
    }

    // Alt+arrows on one box: its own right / bottom edge moves by (dx, dy). A turned box stops
    // where a corner would leave QUAD_RANGE (one already past it, where it would go further out); a box with free corners is not reshaped this way.
    function nudgeSize(t, dx, dy) {
      if (G.isQuad(t)) { P.setStatus(QN.arrows); return; }
      const [W, H] = P.frameSize(), r = G.rectFromCorners(t.corners, t.angle);
      const nw = Math.max(G.MIN_BOX, r.w + dx), nh = Math.max(G.MIN_BOX, r.h + dy);
      const off = G.rotatePoint((nw - r.w) / 2, (nh - r.h) / 2, r.angle);
      const next = { cx: r.cx + off.x, cy: r.cy + off.y, w: nw, h: nh, angle: r.angle }, a = G.roundAngle(r.angle);
      if (a !== 0 && !G.rangeNoWorse(G.cornersFromRect(Object.assign({}, next, { angle: a })), t.corners, W, H)) { P.setStatus(TOO_FAR); return; }
      setRect(t, next);
    }

    // Arrow keys: move the selection by (dx, dy); Alt (resize): move the primary box's own right /
    // bottom edge. A burst of arrow presses on the same boxes within 500 ms is one undo step.
    function nudgeBox(dx, dy, resize) {
      const ids = resize ? P.primaryIds() : P.selectedIds();
      if (!P.editable() || !ids.length) { P.setStatus(resize ? P.noTargetMessage() : "Select a box first: click it, or press Tab."); return; }
      const row = P.row(), now = Date.now(), S = P.state;
      const k = `${row.name}|${ids.join(",")}|${resize ? "r" : "m"}`;
      const coalesce = now - S.nudge.at < NUDGE_COALESCE_MS && S.nudge.key === k;
      const before = JSON.stringify(row.targets), [W, H] = P.frameSize();
      const changed = P.editGeometry(ids, (t) => {
        if (resize) nudgeSize(t, dx, dy); else t.corners = G.translateCorners(t.corners, dx, dy, W, H, true);
      }, { noUndo: true });
      if (changed && !coalesce) P.pushUndo(row, before);
      S.nudge = { at: now, key: k };
    }

    // A drag on a handle that frees a box's corners or reshapes a quad: the drag record (mode
    // "corner" | "edge" | "qrotate", the corners and center at its start), or null when the grab
    // is a box's own resize or rotate. hit: boxHit's {mode, t, handle}; p: the frame point.
    function quadDragStart(hit, p, shift) {
      const mode = hit.t ? G.quadDragMode(hit.t, hit, shift) : null;
      if (!mode) return null;
      const c = G.quadCenter(hit.t.corners);
      return { mode, id: hit.t.id, handle: hit.handle, corners: hit.t.corners.map((q) => [q[0], q[1]]), center: c, startAngle: G.angleFromCenter(c, p) };
    }

    // One step of that drag onto t (the drag record's `said`: a refusal is on the status line).
    function quadDragMove(d, t, p) {
      const res = G.quadDrag(d, p, ...P.frameSize());
      if (t && applyQuad(t, res) && d.said) P.setStatus("");
      d.said = !!res.refused;
    }

    // D then an arrow: where the box beside `src` goes, {rect, corners (a quad's own outline, else
    // null), status} or {refused: why}. A turned box or a quad whose center would be off the picture
    // is refused (one that only runs past the edge is kept whole), and so is a quad with a corner
    // past QUAD_RANGE; an upright box is cut at the picture's edge (setRect).
    function besidePlace(src, dir) {
      const b = G.besideOf(src, dir), r = b.rect, [W, H] = P.frameSize();
      if ((b.corners || G.roundAngle(r.angle) !== 0) && (r.cx < 0 || r.cy < 0 || r.cx > W || r.cy > H)) {
        return { refused: "There is no room for a box on that side: it would run off the picture." };
      }
      if (b.corners && !G.cornersInRange(b.corners, W, H)) return { refused: TOO_FAR };
      return { rect: r, corners: b.corners, status: b.corners ? QN.beside : "Box added beside. Drag its far edge to fit." };
    }

    return { besidePlace, nudgeBox, setRect, turnTo, turnAllowed, resizeTo, applyQuad, rotateSel, tapSel, setTopEdgeSel, fitSel, toRectSel, snapQuadSel, nudgeSize,
      quadDragStart, quadDragMove };
  }

  const api = { create, geometrySig, TOO_FAR };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LabelerBoxEdit = api;
})(typeof window !== "undefined" ? window : globalThis);
