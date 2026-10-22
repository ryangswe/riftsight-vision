// SPDX-License-Identifier: Apache-2.0
// Tests for names.js, on made-up cards. Run: node test_names.js (also run by test_serve.py)
"use strict";
const assert = require("assert");
const P = require("./picker.js");
const N = require("./names.js");

// a card with printings (one a printing of a printing), two different cards of one name, a facet
const cat = [
  { id: "OP-010", name: "Sock Thief", kind: "Unit", facets: { color: "red" } },
  { id: "OP-010A", name: "Sock Thief", kind: "Unit", printingOf: "OP-010", facets: { color: "red" } },
  { id: "PR-777", name: "Sock Thief (promo)", kind: "Unit", printingOf: "OP-010A", facets: { color: "gold" } },
  { id: "OP-011", name: "Sock Thief", kind: "Spell", facets: { color: "blue" } },
  { id: "OP-012", name: "Thimble", kind: "Unit", facets: { color: "red" } },
];
const shape = (gs) => gs.map((g) => [g.card.id, g.tiles.map((t) => [t.id, t.printing])]);

// the grid: one group per card, every printing its own tile, the card's own tile first
{
  const gs = N.gridGroups(P.buildList(cat, { scope: "all", query: "sock" }).entries);
  assert.deepStrictEqual(shape(gs), [
    ["OP-010", [["OP-010", null], ["OP-010A", "OP-010A"], ["PR-777", "PR-777"]]],
    ["OP-011", [["OP-011", null]]],
  ], "printings are shown, grouped by card; two cards of one name stay two groups");
  assert.strictEqual(N.groupTitle(gs[0]), "OP-010 · Sock Thief · 3 printings");
  assert.strictEqual(N.groupTitle(gs[1]), "OP-011 · Sock Thief", "no count for a card with one printing");
  // groups are what picker.js decides: matched, ranked and limited by card
  assert.deepStrictEqual(shape(N.gridGroups(P.buildList(cat, { scope: "all", query: "pr-7" }).entries)).map((g) => g[0]), ["OP-010"]);
  assert.deepStrictEqual(N.gridGroups(P.buildList(cat, { scope: "all", limit: 2 }).entries).length, 2, "the limit counts groups");
  assert.deepStrictEqual(shape(N.gridGroups(P.buildList(cat, { scope: "all", query: "sock", filters: { color: "gold" } }).entries)).map((g) => g[0]), ["OP-010"]);
  // the deck list: its groups, labels kept
  const deck = N.gridGroups(P.buildList(cat, { decklists: [{ label: "A", ids: ["PR-777"] }, { label: "B", ids: ["OP-012"] }] }).entries);
  assert.deepStrictEqual(deck.map((g) => [g.card.id, g.deckLabels, g.fromDecklist]), [["OP-010", ["A"], true], ["OP-012", ["B"], true]]);
  assert.deepStrictEqual(N.gridGroups([]), []);
  assert.deepStrictEqual(N.gridGroups(null), []);
}

// a printing's id typed in full: one group, its card's, starting on that printing's tile
{
  const typed = P.buildList(cat, { query: "PR-777" });
  const gs = N.gridGroups(typed.entries);
  assert.deepStrictEqual(shape(gs).map((g) => g[0]), ["OP-010"], "the typed printing is not a group of its own");
  assert.strictEqual(gs[0].start, 2);
  assert.deepStrictEqual(N.startHl(gs), { g: 0, t: 2 });
  assert.deepStrictEqual(P.applyPick(N.tilePick(gs[0], 2), typed.scope),
    { outcome: "card", identity: "OP-010", printing: "PR-777", identitySource: "current-frame" });
  assert.strictEqual(P.applyPick(N.tilePick(gs[0], 0), typed.scope).printing, null, "the card's own tile records no printing, even here");
  // a ring of printings (no catalog should have one): the other member typed, the root's group
  const ring = [{ id: "R-2", name: "Ring", printingOf: "R-1" }, { id: "R-1", name: "Ring", printingOf: "R-2" }];
  const rg = N.gridGroups(P.buildList(ring, { query: "r-2" }).entries);
  assert.deepStrictEqual(shape(rg), [["R-1", [["R-1", null], ["R-2", "R-2"]]]]);
  assert.strictEqual(rg[0].start, 1);
}

// picking a tile: the card's own names it with no printing; an alternate names the card and records the printing
{
  const list = P.buildList(cat, { scope: "all", query: "sock" });
  const gs = N.gridGroups(list.entries);
  assert.deepStrictEqual(P.applyPick(N.tilePick(gs[0], 0), list.scope), { outcome: "card", identity: "OP-010", printing: null, identitySource: "current-frame" });
  assert.deepStrictEqual(P.applyPick(N.tilePick(gs[0], 1), list.scope), { outcome: "card", identity: "OP-010", printing: "OP-010A", identitySource: "current-frame" });
  assert.deepStrictEqual(P.applyPick(N.tilePick(gs[1], 0), list.scope).identity, "OP-011");
  assert.strictEqual(N.tilePick(gs[1], 5), null);
  const deck = P.buildList(cat, { decklistIds: ["OP-010"] });
  assert.strictEqual(P.applyPick(N.tilePick(N.gridGroups(deck.entries)[0], 1), deck.scope).identitySource, "decklist");
}

// the keys: ↑ ↓ between groups (to the group's own tile), ← → between the tiles of one group
{
  const gs = N.gridGroups(P.buildList(cat, { scope: "all" }).entries); // OP-010 (3 tiles), OP-011, OP-012
  let h = N.startHl(gs);
  assert.deepStrictEqual(h, { g: 0, t: 0 });
  h = N.moveHl(gs, h, "ArrowRight"); assert.deepStrictEqual(h, { g: 0, t: 1 });
  h = N.moveHl(gs, h, "ArrowRight"); h = N.moveHl(gs, h, "ArrowRight");
  assert.deepStrictEqual(h, { g: 0, t: 2 }, "→ stops at the group's last tile");
  assert.strictEqual(N.tileAt(gs, h).tile.id, "PR-777");
  h = N.moveHl(gs, h, "ArrowDown"); assert.deepStrictEqual(h, { g: 1, t: 0 });
  h = N.moveHl(gs, h, "ArrowRight"); assert.deepStrictEqual(h, { g: 1, t: 0 }, "a group of one tile");
  h = N.moveHl(gs, h, "ArrowDown"); h = N.moveHl(gs, h, "ArrowDown");
  assert.deepStrictEqual(h, { g: 2, t: 0 }, "↓ stops at the last group");
  h = N.moveHl(gs, h, "ArrowUp"); h = N.moveHl(gs, h, "ArrowUp"); h = N.moveHl(gs, h, "ArrowUp");
  assert.deepStrictEqual(h, { g: 0, t: 0 });
  h = N.moveHl(gs, h, "ArrowLeft"); assert.deepStrictEqual(h, { g: 0, t: 0 });
  assert.deepStrictEqual(N.fitHl(gs, { g: 9, t: 9 }), { g: 2, t: 0 }, "a highlight beyond a shorter list comes back into it");
  assert.deepStrictEqual(N.moveHl([], { g: 3, t: 1 }, "ArrowDown"), { g: 0, t: 0 });
  assert.strictEqual(N.tileAt([], { g: 0, t: 0 }), null);
}

// a catalog without facets says that more filters exist; one with facets does not
{
  const doc = fakeDoc();
  const els = {};
  const $ = (id) => (els[id] = els[id] || doc.createElement("div"));
  $("pickerInput");
  for (const [facets, hidden] of [[null, false], [[], false], [[{ key: "color", label: "Color" }], true]]) {
    const S = { picker: { query: "", scope: "all", hl: { g: 0, t: 0 }, list: null, grid: [] }, filters: {}, catalog: cat, facets,
      deckIds: [], decklists: [], byId: new Map(cat.map((c) => [c.id, c])) };
    N.panel({ S, $, mode: () => "identify", renderChrome() {}, cardWho: (id) => id }).renderFilters();
    assert.strictEqual($("facetHint").hidden, hidden, JSON.stringify(facets));
  }
}

// every answer clears the search and the filters
{
  for (const a of ["pick", "unknown", "card-back", "not-card", "unreadable", "back", "clear", "accept-new", "accept-both"]) assert.ok(N.clearsSearch(a), a);
  for (const a of [null, undefined, "", "readable", "turn"]) assert.ok(!N.clearsSearch(a), String(a));
}

// the page's panel: an answer empties the search box, the query, the filters and the highlight
{
  const doc = fakeDoc();
  const els = {};
  const $ = (id) => (els[id] = els[id] || doc.createElement("div"));
  $("pickerInput").value = "sock";
  const S = { picker: { query: "sock", scope: "all", hl: { g: 1, t: 0 }, list: null, grid: [] }, filters: { color: "red" }, catalog: cat, facets: null,
    deckIds: [], decklists: [], byId: new Map(cat.map((c) => [c.id, c])) };
  const mutated = [];
  const panel = N.panel({ S, $, mode: () => "identify", editable: () => true, renderChrome() {}, zoomStage: () => true, cardWho: (id) => id,
    mutate: (fn) => { const t = {}; fn(t); mutated.push(t); } });
  panel.renderPicker();
  assert.deepStrictEqual(S.picker.grid.map((g) => g.card.id), ["OP-010"], "the query and the filter apply");
  panel.clearSearch("readable");
  assert.strictEqual($("pickerInput").value, "sock", "not an answer: the search stays");
  panel.clearSearch("not-card");
  assert.deepStrictEqual([$("pickerInput").value, S.picker.query, S.filters, S.picker.hl], ["", "", {}, { g: 0, t: 0 }]);
  assert.deepStrictEqual(S.picker.grid.map((g) => g.card.id), ["OP-010", "OP-011", "OP-012"], "the list shows every card again");
  // a pick from the grid names the card and clears the search
  $("pickerInput").value = "thimble"; panel.renderPicker();
  panel.choose(N.tilePick(S.picker.grid[0], 0));
  assert.deepStrictEqual(mutated.map((t) => [t.identity, t.printing]), [["OP-012", null]]);
  assert.strictEqual($("pickerInput").value, "");
  // Unknown is an answer too
  $("pickerInput").value = "zzz"; panel.renderPicker();
  panel.choose({ kind: "unknown" });
  assert.deepStrictEqual([mutated[1].identity, $("pickerInput").value], ["unknown", ""]);
  // Enter picks the highlighted tile; → moves within the group
  $("pickerInput").value = "sock"; S.picker.fresh = true; panel.renderPicker();
  const key = (k) => panel.pickerKey({ key: k, preventDefault() {}, stopPropagation() {} });
  key("ArrowRight"); key("Enter");
  assert.deepStrictEqual([mutated[2].identity, mutated[2].printing], ["OP-010", "OP-010A"]);
}

// ← → in the search: the text cursor moves while it is inside the typed text; else the grid's highlight
{
  const inp = (value, a, b) => ({ value, selectionStart: a, selectionEnd: b === undefined ? a : b });
  assert.ok(N.textArrow(inp("sock", 2), "ArrowLeft"));
  assert.ok(N.textArrow(inp("sock", 2), "ArrowRight"));
  assert.ok(!N.textArrow(inp("sock", 4), "ArrowRight"), "at the end: the grid");
  assert.ok(!N.textArrow(inp("sock", 4), "ArrowLeft"), "at an end: the grid");
  assert.ok(!N.textArrow(inp("sock", 0), "ArrowLeft"));
  assert.ok(!N.textArrow(inp("", 0), "ArrowRight"), "no text: the grid");
  assert.ok(!N.textArrow(inp("sock", 1, 3), "ArrowRight"), "a selection: the grid");
  assert.ok(!N.textArrow(inp("sock", 2), "ArrowDown"));
  assert.ok(!N.textArrow({}, "ArrowLeft"));
  // in the panel: the cursor inside the text keeps ← in the field (the default is not prevented)
  const doc = fakeDoc(), els = {};
  const $ = (id) => (els[id] = els[id] || doc.createElement("div"));
  const S = { picker: { query: "", scope: "all", hl: { g: 0, t: 0 }, list: null, grid: [] }, filters: {}, catalog: cat, facets: null, deckIds: [], decklists: [], byId: new Map() };
  const panel = N.panel({ S, $, mode: () => "identify", renderChrome() {}, cardWho: (id) => id });
  Object.assign($("pickerInput"), { value: "sock", selectionStart: 2, selectionEnd: 2 });
  panel.renderPicker();
  let prevented = false;
  panel.pickerKey({ key: "ArrowRight", target: $("pickerInput"), preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.deepStrictEqual([prevented, S.picker.hl], [false, { g: 0, t: 0 }]);
  Object.assign($("pickerInput"), { selectionStart: 4, selectionEnd: 4 });
  panel.pickerKey({ key: "ArrowRight", target: $("pickerInput"), preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.deepStrictEqual([prevented, S.picker.hl], [true, { g: 0, t: 1 }]);
  // a redrawn grid hides the preview (its tile may be gone)
  $("hoverPreview").classList.remove = () => { els.hidden = true; };
  panel.renderPicker();
  assert.strictEqual(els.hidden, true);
}

// box edits: a box against the server's copy, and provenance settled just before a save
{
  const G = require("./boxgeom.js");
  const c = [[0, 0], [10, 0], [10, 20], [0, 20]];
  assert.strictEqual(N.changeOf(G, { corners: c }, { corners: c }), 0);
  assert.strictEqual(N.changeOf(G, { corners: c }, { corners: G.topEdgeCorners(c, 1) }), 1);
  assert.strictEqual(N.changeOf(G, { corners: c }, { corners: G.topEdgeCorners(c, 3) }), 3);
  assert.strictEqual(N.changeOf(G, { corners: c }, { corners: [[1, 0], [11, 0], [11, 20], [1, 20]] }), -1);
  const base = { id: "B1", corners: c, labelSource: "carried", cornerSource: "carried" };
  const moved = { id: "B1", corners: [[1, 0], [11, 0], [11, 20], [1, 20]], labelSource: "carried" };
  const turned = { id: "B1", corners: G.topEdgeCorners(c, 2), labelSource: "carried-corrected", angle: 180 };
  N.settleProvenance(G, [moved, turned], new Map([["B1", base]]), true);
  assert.deepStrictEqual([moved.labelSource, moved.cornerSource], ["carried-corrected", "carried"], "an edit");
  assert.deepStrictEqual([turned.labelSource, turned.cornerSource], ["carried", "carried"], "a turn keeps the server's");
  const untouched = { id: "B2", labelSource: "x" };
  N.settleProvenance(G, [untouched], new Map([["B1", base]]), true);
  assert.strictEqual(untouched.labelSource, "x", "a box with no copy is left as it is");
  N.settleProvenance(G, [untouched], undefined, true);
  // a tilted box stored with no angle, put back by an undo after its edit was saved: an edit of
  // the server's (edited) copy, its corners exactly as stored, its angle written out as its top
  // edge's direction (what no angle means), so the server's check of an edit holds
  const tilt = [[100, 100], [186.6, 150], [161.6, 193.3], [75, 143.3]];
  const savedEdit = { id: "B3", corners: [[110, 100], [196.6, 150], [171.6, 193.3], [85, 143.3]], angle: 30, labelSource: "carried-corrected", cornerSource: "carried" };
  const undone = { id: "B3", corners: tilt.map((q) => q.slice()), labelSource: "carried", cornerSource: "carried" };
  N.settleProvenance(G, [undone], new Map([["B3", savedEdit]]), true);
  assert.deepStrictEqual(undone.corners, tilt, "the corners as they were");
  assert.strictEqual(undone.angle, 30, "the angle written out");
  assert.strictEqual(undone.labelSource, "carried-corrected");
  const unsaved = { id: "B3", corners: tilt.map((q) => q.slice()), labelSource: "carried" };
  N.settleProvenance(G, [unsaved], new Map([["B3", { id: "B3", corners: tilt, labelSource: "carried" }]]), true);
  assert.strictEqual("angle" in unsaved, false, "an undo before the edit was saved: exactly the stored box");
  const level = { id: "B4", corners: [[1, 0], [11, 0], [11, 20], [1, 20]], labelSource: "manual" };
  N.settleProvenance(G, [level], new Map([["B4", { id: "B4", corners: c, labelSource: "manual" }]]), true);
  assert.strictEqual("angle" in level, false, "an upright box stores no angle");
}

// the whole frame's view (the modal): zoom and pan
{
  const d = { W: 1920, H: 1080, w: 800, h: 450 };
  const fit = N.fitView(d);
  assert.deepStrictEqual(fit, { z: 1, cx: 960, cy: 540 });
  assert.strictEqual(N.fitScale(d), 800 / 1920);
  // a point and its view position, both ways
  const p = N.toView(fit, d, 1920, 1080);
  assert.deepStrictEqual([Math.round(p.x), Math.round(p.y)], [800, 450]);
  // zooming keeps the frame point under the pointer where it is
  const at = { x: 200, y: 100 }, before = N.toFrame(fit, d, at.x, at.y);
  const z2 = N.zoomAt(fit, d, 2, at.x, at.y), after = N.toFrame(z2, d, at.x, at.y);
  assert.strictEqual(z2.z, 2);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9, "the point under the pointer stays");
  assert.strictEqual(N.zoomAt(fit, d, 0.5, 10, 10).z, 1, "never smaller than the whole frame");
  assert.strictEqual(N.zoomAt({ z: 6, cx: 960, cy: 540 }, d, 4, 400, 225).z, N.ZOOM_MAX);
  // a pan stops at the frame's edges: no empty space beyond them
  const far = N.panBy(z2, d, 5000, 5000);
  assert.deepStrictEqual([far.cx, far.cy], [480, 270]);
  assert.deepStrictEqual(N.panBy(fit, d, 300, 0), fit, "the whole frame in view does not move");
}

// the zoom steps go round: Points' levels, Check names' crop sizes, the card's 1×, 2×, 4×
{
  assert.deepStrictEqual([0, 1, 2].map((i) => N.cycleLevel(i, 3, false)), [1, 2, 0], "z: on, and after the last the first");
  assert.deepStrictEqual([0, 1, 2].map((i) => N.cycleLevel(i, 3, true)), [2, 0, 1], "Shift+Z: back, and before the first the last");
  assert.strictEqual(N.cycleLevel(undefined, 3, false), 1, "no level yet is the first");
  const d = { W: 960, H: 540, w: 700, h: 400, rect: [400, 200, 500, 340] };
  let v = N.fitView(d);
  const zs = [];
  for (let i = 0; i < 4; i++) { v = N.cycleZoom(v, d, false, 450, 270); zs.push(v.z); }
  assert.deepStrictEqual(zs, [2, 4, 1, 2], "z wraps from the largest to the smallest");
  const back = [];
  for (let i = 0; i < 4; i++) { v = N.cycleZoom(v, d, true, 450, 270); back.push(v.z); }
  assert.deepStrictEqual(back, [1, 4, 2, 1], "Shift+Z wraps from the smallest to the largest");
  assert.strictEqual(N.cycleZoom({ z: 3, cx: 450, cy: 270 }, d, false, 450, 270).z, 4, "from a wheel zoom: the step above");
  assert.strictEqual(N.cycleZoom({ z: 3, cx: 450, cy: 270 }, d, true, 450, 270).z, 2, "... or below");
  assert.strictEqual(N.cycleZoom({ z: 6, cx: 450, cy: 270 }, d, false, 450, 270).z, 1, "past the largest step: round to the first");
  assert.deepStrictEqual([v.cx, v.cy], [450, 270], "centered on the card");
}

// the card's view: the box with a quarter of its size around it; its bounds; frame ↔ view
{
  const box = N.cardBox([[400, 200], [500, 200], [500, 340], [400, 340]], 960, 540);
  assert.deepStrictEqual(box.rect, [375, 165, 525, 375]);
  assert.deepStrictEqual(box.bounds, [-21, -21, 981, 561], "the frame and 15 % of the box's size beyond it");
  const tilted = N.cardBox([[100, 100], [140, 120], [120, 160], [80, 140]], 960, 540);
  assert.deepStrictEqual(tilted.rect, [65, 85, 155, 175], "a turned box: around its extent");
  assert.deepStrictEqual(N.boxMid([[100, 100], [140, 120], [120, 160], [80, 140]]), [110, 130]);
  const d = Object.assign({ W: 960, H: 540, w: 700, h: 400 }, box);
  assert.strictEqual(N.fitScale(d), Math.min(700 / 150, 400 / 210), "the box and its margin fill the view");
  const home = N.fitView(d);
  assert.deepStrictEqual(home, { z: 1, cx: 450, cy: 270 }, "on the box's middle");
  const c = N.toView(home, d, 375, 165), e = N.toView(home, d, 525, 375);
  assert.ok(c.x >= -1e-9 && e.x <= 700 + 1e-9 && Math.abs(c.y) < 1e-9 && Math.abs(e.y - 400) < 1e-9, "the whole margin in view, at 1×");
  for (const z of N.ZOOM_STEPS) {
    const v = N.clampView({ z, cx: 450, cy: 270 }, d);
    for (const [x, y] of [[400, 200], [500, 340], [450.5, 270.25], [420, 333]]) {
      const q = N.toView(v, d, x, y), back = N.toFrame(v, d, q.x, q.y);
      assert.ok(Math.abs(back.x - x) < 1e-9 && Math.abs(back.y - y) < 1e-9, `frame → card's view → frame at ${z}×`);
    }
    const mid = N.toView(v, d, 450, 270);
    assert.ok(Math.abs(mid.x - 350) < 1e-9 && Math.abs(mid.y - 200) < 1e-9, `the box's middle in the view's middle at ${z}×`);
    assert.ok(Math.abs(N.toView(v, d, 460, 270).x - mid.x - 10 * N.fitScale(d) * z) < 1e-9, `${z}× the fitted scale`);
    const dv = N.drawnView({ z, cx: 450, cy: 270 }, d);
    assert.deepStrictEqual(dv, { cx: v.cx, cy: v.cy, z: N.fitScale(d) * v.z, w: 700, h: 400 }, "the view as drawn, in screen px per frame px");
  }
  // a box that runs past the frame's edge: every corner in view at 1× (empty space beyond the
  // edge, up to 15 % of the box's size past the box), and the view never further out
  const off = [[-26, 220], [124, 220], [124, 327], [-26, 327]];
  const ob = N.cardBox(off, 960, 540), de = Object.assign({ W: 960, H: 540, w: 700, h: 400 }, ob);
  assert.deepStrictEqual(ob.bounds, [-48.5, -22.5, 982.5, 562.5]);
  const ve = N.clampView(N.fitView(de), de);
  for (const q of off) {
    const p = N.toView(ve, de, q[0], q[1]);
    assert.ok(p.x >= 0 && p.x <= 700 && p.y >= 0 && p.y <= 400, `corner ${q} in view (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
  }
  const far = N.panBy(N.fitView(de), de, 5000, 0);
  assert.ok(N.toView(far, de, -48.5, 0).x >= -1e-9, "a pan stops at the bounds");
  assert.strictEqual(N.fitView(de, 4).z, 4, "the next card keeps the zoom");
}

// the person's view is kept: a pane that shrinks (About opened, the window made shorter) and grows
// again draws the same view as before, the box wholly in view; nothing is written back
{
  const corners = [[600, 150], [690, 150], [690, 276], [600, 276]];
  const box = N.cardBox(corners, 960, 540), big = Object.assign({ W: 960, H: 540, w: 819, h: 599 }, box);
  const small = Object.assign({}, big, { w: 819, h: 120 });
  const cv = N.fitView(big);
  const before = N.drawnView(cv, big), kept = JSON.stringify(cv);
  N.drawnView(cv, small); N.clampView(cv, small);
  assert.strictEqual(JSON.stringify(cv), kept, "drawing never changes the person's view");
  const again = N.drawnView(cv, big);
  assert.deepStrictEqual(again, before, "the same view once the pane is back");
  const inView = (v, q) => { const x = (q[0] - v.cx) * v.z + v.w / 2, y = (q[1] - v.cy) * v.z + v.h / 2; return x >= 0 && x <= v.w && y >= 0 && y <= v.h; };
  assert.ok(corners.every((q) => inView(again, q)), "the box wholly in view");
  assert.ok(corners.every((q) => inView(N.drawnView(cv, small), q)), "and in the small pane too, refitted (not panned)");
  // panned at 2×, then the pane shrinks and grows: the pan is kept as it was
  const panned = N.panBy({ z: 2, cx: 645, cy: 213 }, big, -40, 0);
  const p1 = N.drawnView(panned, big);
  N.drawnView(panned, small);
  assert.deepStrictEqual(N.drawnView(panned, big), p1);
}

// a box grown past its rect: the rect takes it in, the view stays as it is on screen
{
  const before = [[400, 200], [500, 200], [500, 340], [400, 340]];
  const box = N.cardBox(before, 960, 540), d = Object.assign({ W: 960, H: 540, w: 700, h: 400 }, box);
  const cv = { z: 1, cx: 450, cy: 270 }, view = N.clampView(cv, d);
  const same = N.growCard(cv, view, d, box, [[402, 200], [502, 200], [502, 340], [402, 340]]);
  assert.ok(same.cv === cv && same.box === box, "a box still inside: nothing changes");
  const grown = [[400, 200], [640, 200], [640, 420], [400, 420]];
  const g = N.growCard(cv, view, d, box, grown), d1 = Object.assign({}, d, g.box);
  assert.deepStrictEqual(g.box.rect, [340, 145, 700, 475]);
  const s0 = N.fitScale(d) * view.z, s1 = N.fitScale(d1) * g.cv.z;
  assert.ok(Math.abs(s0 - s1) < 1e-9 && g.cv.cx === view.cx && g.cv.cy === view.cy, "the same scale and center: the view does not move");
  const at1 = N.drawnView({ z: 1, cx: 520, cy: 310 }, d1);
  assert.ok(grown.every((q) => { const x = (q[0] - at1.cx) * at1.z + 350, y = (q[1] - at1.cy) * at1.z + 200; return x >= 0 && x <= 700 && y >= 0 && y <= 400; }), "1× shows it all");
}

// Check names' crop: 180 to 420 px as in the sittings before the card's view
{
  assert.strictEqual(N.cropSize(835, 820), 328);
  assert.strictEqual(N.cropSize(742, 640), 256);
  assert.strictEqual(N.cropSize(300, 300), 180, "never smaller than 180 px");
  assert.strictEqual(N.cropSize(2000, 2000), 420, "never larger than 420 px");
}

// Points' crop: the size it had before the two panes, wherever the pane leaves room for the strip
// beside it (the same frame window and enlargement, so the same measurement)
{
  const before = (w, h) => Math.max(320, Math.min(640, h - 60, w - 40)); // the one side column's center
  assert.strictEqual(N.pointCropSize(1100, 820), before(1100, 820), "no strip: the formula as before");
  // the left pane at 1440 × 900 and 1280 × 720, against the center of the old layout at the same sizes
  assert.strictEqual(N.pointCropSize(835, 820, N.POINT_STRIP), before(1100, 820));
  assert.strictEqual(N.pointCropSize(835, 820, N.POINT_STRIP), 640);
  assert.strictEqual(N.pointCropSize(742, 640, N.POINT_STRIP), before(940, 640));
  assert.strictEqual(N.pointCropSize(742, 640, N.POINT_STRIP), 580);
  for (const h of [500, 640, 700, 820, 1000]) for (const w of [700, 900, 1400]) {
    const s = N.pointCropSize(w, h, N.POINT_STRIP);
    if (w - 40 - N.POINT_STRIP >= Math.min(640, h - 60)) assert.strictEqual(s, before(w + 1000, h), `${w} × ${h}: room for the strip, the size as before`);
    assert.ok(s >= 320 && s <= 640, "320 to 640 px");
  }
  assert.strictEqual(N.pointCropSize(600, 900, N.POINT_STRIP), 450, "a narrow pane: smaller, the strip still beside it");
  assert.strictEqual(N.pointCropSize(300, 300, N.POINT_STRIP), 320, "never smaller than 320 px");
}

// the whole frame in a modal: Esc, a click outside it and its close button close it; z / Shift+Z
// zoom it; any other key does nothing; the browser's shortcuts are left alone
{
  assert.strictEqual(N.modalAction({ key: "Escape" }), "close");
  assert.strictEqual(N.modalAction({ press: "backdrop" }), "close");
  assert.strictEqual(N.modalAction({ press: "close" }), "close");
  assert.strictEqual(N.modalAction({ press: "inside" }), null, "a press on the frame does not close it");
  assert.strictEqual(N.modalAction({ key: "z" }), "zoom");
  assert.strictEqual(N.modalAction({ key: "Z" }), "zoom-back");
  for (const key of ["x", "Enter", " ", "ArrowRight", "/", "Backspace"]) assert.strictEqual(N.modalAction({ key }), "block", key);
  assert.strictEqual(N.modalAction({ key: "r", meta: true }), null);
}

// where the frame comes from: title, date and language, and a link at the frame's time (YouTube)
{
  const video = "https://www.youtube.com/watch?v=EXAMPLE1234"; // a made-up id
  const src = { platform: "youtube", videoId: "EXAMPLE1234", title: "  A made-up practice game ", uploadDate: "2025-03-14", language: "en" };
  assert.deepStrictEqual(N.sourceLine(src, 83.9), { title: "A made-up practice game", meta: "uploaded 2025-03-14 · en",
    href: video + "&t=83s", link: "Open the video at 1:23", unused: null, empty: false });
  assert.strictEqual(N.sourceLine(src, 3725).link, "Open the video at 1:02:05");
  assert.strictEqual(N.sourceLine(src, undefined).href, video, "no time: the video's start");
  assert.strictEqual(N.sourceLine({ platform: "local", videoId: "my-table" }, 5).href, null, "a recording of one's own: no link");
  assert.strictEqual(N.sourceLine({ platform: "twitch", videoId: "123456789" }, 5).href, null);
  assert.strictEqual(N.sourceLine({ platform: "youtube", videoId: "bad id&x=1" }, 5).href, null, "only a video id of YouTube's form");
  assert.deepStrictEqual(N.sourceLine({ uploadDate: "2024-12-01" }, 1), { title: null, meta: "uploaded 2024-12-01", href: null, link: null, unused: null, empty: false });
  assert.strictEqual(N.sourceLine({}, 1).empty, true, "an older sample: nothing to show");
  const un = N.sourceLine({ title: "A made-up game", unused: ["uploadDate", "language"] }, 1);
  assert.strictEqual(un.unused, "2 values in the sample were not used (not of its form): uploadDate, language");
  assert.strictEqual(N.sourceLine({ unused: ["title"] }, 1).empty, false, "said even when nothing else is");
  assert.strictEqual(N.sourceLine(undefined, 1).empty, true);
  // drawn: a plain link that opens in the browser, nothing fetched
  const doc = fakeDoc(), el = doc.createElement("div");
  N.renderSource(doc, el, N.sourceLine(src, 83.9));
  assert.deepStrictEqual(el.children.map((c) => [c.tag, c.className, c.textContent]),
    [["span", "srcTitle", "A made-up practice game"], ["span", "srcMeta", "uploaded 2025-03-14 · en"], ["a", "srcLink", "Open the video at 1:23 ↗"]]);
  assert.deepStrictEqual(el.children[2].attrs, { href: video + "&t=83s", target: "_blank", rel: "noopener" });
  assert.strictEqual(el.hidden, false);
  N.renderSource(doc, el, N.sourceLine({}, 1));
  assert.deepStrictEqual([el.children.length, el.hidden], [0, true]);
}

// the grid drawn: every printing a tile with its art loaded lazily; a press picks; the preview
// follows the picture only
{
  const doc = fakeDoc();
  const list = doc.createElement("ol");
  const gs = N.gridGroups(P.buildList(cat, { scope: "all", query: "sock" }).entries);
  const arts = [], picks = [], hovers = [];
  let left = 0;
  N.renderGrid(doc, list, gs, { hl: { g: 0, t: 1 }, setArt: (img, id) => arts.push([id, img.attrs.loading]), onPick: (g, i) => picks.push([g.card.id, i]),
    onHover: (t) => hovers.push(t.id), onLeave: () => left++, deck: () => "" });
  assert.deepStrictEqual(arts, [["OP-010", "lazy"], ["OP-010A", "lazy"], ["PR-777", "lazy"], ["OP-011", "lazy"]], "lazy before the source is set");
  assert.strictEqual(list.children.length, 2, "one group per card");
  const head = list.children[0].children[0];
  assert.strictEqual(head.children.map((c) => c.textContent).join(""), "OP-010 · Sock Thief · 3 printings");
  const tiles = find(list, (n) => n.className === "tiles").children;
  assert.deepStrictEqual(tiles.map((t) => t.className), ["tile", "tile alt hl", "tile alt"]);
  tiles[2].fire("mousedown");
  assert.deepStrictEqual(picks, [["OP-010", 2]]);
  tiles[2].fire("mousemove");
  assert.deepStrictEqual(hovers, [], "no preview over a tile's label or the list");
  find(tiles[2], (n) => n.tag === "img").fire("mousemove");
  find(tiles[2], (n) => n.tag === "img").fire("mouseleave");
  assert.deepStrictEqual([hovers, left], [["PR-777"], 1]);
  list.children[0].fire("mousedown");
  assert.strictEqual(picks.length, 1, "a press between two tiles picks nothing");
}

// a card the catalog lists without art ("art": null; the server marks it noArt): listed and
// searchable, its tile a placeholder that says so with its name, picked and saved by its id
{
  const withNew = cat.concat([{ id: "NEW-099", name: "Lantern Moth", kind: "Unit", artUrl: null, noArt: true },
    { id: "NEW-099A", name: "Lantern Moth", kind: "Unit", printingOf: "NEW-099", artUrl: "/art/NEW-099A" }]);
  for (const query of ["lantern", "new-099", "moth"]) {
    const found = P.buildList(withNew, { scope: "all", query });
    assert.deepStrictEqual(found.entries.map((e) => e.card.id), ["NEW-099"], `found by "${query}"`);
  }
  const list = P.buildList(withNew, { scope: "all", query: "lantern" });
  const gs = N.gridGroups(list.entries);
  assert.deepStrictEqual(shape(gs), [["NEW-099", [["NEW-099", null], ["NEW-099A", "NEW-099A"]]]]);
  const doc = fakeDoc();
  const grid = doc.createElement("ol");
  const arts = [], picks = [], hovers = [];
  N.renderGrid(doc, grid, gs, { hl: { g: 0, t: 0 }, setArt: (img, id) => arts.push(id), onPick: (g, i) => picks.push([g.card.id, i]),
    onHover: (t) => hovers.push(t.id), deck: () => "" });
  assert.deepStrictEqual(arts, ["NEW-099A"], "no image is asked for the card without art; its printing with art gets one");
  const tiles = find(grid, (n) => n.className === "tiles").children;
  const holder = find(tiles[0], (n) => n.className === "noart");
  assert.ok(holder, "a placeholder in place of the picture");
  assert.deepStrictEqual(holder.children.map((c) => [c.className, c.textContent]), [["noart-note", "No picture yet"], ["noart-name", "Lantern Moth"]]);
  assert.strictEqual(find(tiles[0], (n) => n.className === "cid").textContent, "NEW-099", "the id under it, as on every tile");
  assert.strictEqual(find(tiles[0], (n) => n.tag === "img"), null);
  assert.ok(find(tiles[1], (n) => n.tag === "img"), "the printing with art keeps its picture");
  holder.fire("mousemove");
  assert.deepStrictEqual(hovers, ["NEW-099"], "pointing at the placeholder shows the enlarged preview (its name)");
  tiles[0].fire("mousedown");
  assert.deepStrictEqual(picks, [["NEW-099", 0]]);
  assert.deepStrictEqual(P.applyPick(N.tilePick(gs[0], 0), list.scope), { outcome: "card", identity: "NEW-099", printing: null, identitySource: "current-frame" },
    "picking it writes its id, as for any card");
}

// more cards than the grid shows: the count line, "Show more" (the button and ↓ on the last card),
// the extra cards dropped when the query, the filters or the card change; the scroll kept
{
  assert.strictEqual(N.PAGE, 60);
  assert.strictEqual(N.countLine(60, 230), "60 of 230 cards shown");
  assert.strictEqual(N.countLine(3, 3), "", "nothing cut: no line");
  assert.deepStrictEqual([N.moreCount(60, 230), N.moreCount(180, 230), N.moreCount(230, 230), N.moreCount(0, 0)], [60, 50, 0, 0]);
  assert.strictEqual(N.listKey({ query: " Same ", scope: "all", filters: { kind: null, color: "red" }, at: "s|f|1" }),
    N.listKey({ query: "same", scope: "all", filters: { color: "red" }, at: "s|f|1" }), "a cleared filter and the query's case are the same list");
  assert.notStrictEqual(N.listKey({ query: "same", at: "a" }), N.listKey({ query: "same", at: "b" }), "another card is another list");
  const many = Array.from({ length: 230 }, (_, i) => ({ id: `M-${String(i).padStart(3, "0")}`, name: "Same Name", kind: i % 2 ? "Unit" : "Spell" }));
  const doc = fakeDoc(), els = {};
  const $ = (id) => (els[id] = els[id] || doc.createElement(id === "pickerList" ? "ol" : "div"));
  const S = { picker: { query: "", scope: "all", hl: { g: 0, t: 0 }, list: null, grid: [] }, filters: {}, catalog: many, facets: null,
    deckIds: [], decklists: [], byId: new Map(many.map((c) => [c.id, c])), filterAt: "set|frame|B1" };
  let chrome = 0;
  const panel = N.panel({ S, $, mode: () => "identify", renderChrome() { chrome++; }, cardWho: (id) => id });
  $("pickerInput").value = "same"; S.picker.fresh = true; panel.renderPicker();
  const grid = $("pickerList");
  const moreLi = () => grid.children.find((c) => c.className === "more");
  assert.deepStrictEqual([S.picker.grid.length, S.picker.list.total], [60, 230]);
  assert.deepStrictEqual([$("pickerCount").textContent, $("pickerCount").hidden], ["60 of 230 cards shown", false]);
  assert.strictEqual(moreLi().children[0].textContent, "Show 60 more", "the button after the last card");
  assert.strictEqual(grid.children.indexOf(moreLi()), 60, "after the groups, which keep their places");
  // the button appends 60 more, keeps the first ones and the scroll, and the images stay lazy
  const first = S.picker.grid.map((g) => g.card.id);
  grid.scrollTop = 1234;
  moreLi().children[0].fire("click");
  assert.deepStrictEqual(S.picker.grid.length, 120);
  assert.deepStrictEqual(S.picker.grid.slice(0, 60).map((g) => g.card.id), first, "appended: the first 60 are where they were");
  assert.strictEqual(grid.scrollTop, 1234, "the scroll holds");
  assert.ok(chrome > 0);
  assert.strictEqual($("pickerCount").textContent, "120 of 230 cards shown");
  const imgs = []; const walk = (n) => { if (n.tag === "img") imgs.push(n); n.children.forEach(walk); }; walk(grid);
  assert.ok(imgs.length === 120 && imgs.every((i) => i.attrs.loading === "lazy"), "every image lazy");
  // a redraw for the same list (an arrow key) keeps the extra cards
  panel.pickerKey({ key: "ArrowRight", preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(S.picker.grid.length, 120);
  // keyboard: ↓ to the last card, then once more loads the rest and lands on the first new one
  const key = (k) => panel.pickerKey({ key: k, preventDefault() {}, stopPropagation() {} });
  S.picker.hl = { g: 119, t: 0 };
  assert.ok(N.downLoadsMore(S.picker.grid, S.picker.hl, "ArrowDown", 230));
  assert.ok(!N.downLoadsMore(S.picker.grid, S.picker.hl, "ArrowUp", 230));
  assert.ok(!N.downLoadsMore(S.picker.grid, { g: 118, t: 0 }, "ArrowDown", 230), "only from the last card");
  key("ArrowDown");
  assert.deepStrictEqual([S.picker.grid.length, S.picker.hl], [180, { g: 120, t: 0 }], "one press: at most 60 more");
  S.picker.hl = { g: 179, t: 0 }; key("ArrowDown"); key("ArrowDown");
  assert.deepStrictEqual([S.picker.grid.length, S.picker.hl.g], [230, 181], "the last 50, then an ordinary move: nothing more to load");
  assert.strictEqual(moreLi(), undefined, "all shown: no button");
  assert.deepStrictEqual([$("pickerCount").textContent, $("pickerCount").hidden], ["", true]);
  key("ArrowDown"); key("ArrowDown");
  assert.strictEqual(S.picker.hl.g, 183, "↓ keeps moving among the shown cards");
  // the extra cards are dropped when the query, the filters or the card change
  const grow = (n) => { moreLi().children[0].fire("click"); assert.strictEqual(S.picker.grid.length, n); };
  $("pickerInput").value = "same n"; S.picker.fresh = true; panel.renderPicker();
  assert.strictEqual(S.picker.grid.length, 60, "a new query");
  grow(120);
  panel.setFilter("kind", "Unit");
  assert.deepStrictEqual([S.picker.grid.length, S.picker.list.total, $("pickerCount").textContent], [60, 115, "60 of 115 cards shown"], "a filter");
  grow(115);
  S.filterAt = "set|frame|B2"; S.filters = {}; panel.renderPicker();
  assert.strictEqual(S.picker.grid.length, 60, "another card");
  assert.strictEqual(grid.scrollTop, 0, "a new list starts at its top");
  // nothing cut: no line, no button
  $("pickerInput").value = "M-007"; S.picker.fresh = true; panel.renderPicker();
  assert.deepStrictEqual([S.picker.grid.length, $("pickerCount").hidden, moreLi()], [1, true, undefined]);
}

function find(n, pred) {
  if (pred(n)) return n;
  for (const c of n.children || []) { const r = find(c, pred); if (r) return r; }
  return null;
}

// A minimal document: elements with children, classes, dataset and listeners; an event fired on
// an element bubbles up through its parents until a listener stops it.
function fakeDoc() {
  const doc = { activeElement: null, defaultView: { innerWidth: 1440, innerHeight: 900 } };
  const make = (tag) => {
    const el = { tag, parent: null, children: [], className: "", textContent: "", dataset: {}, attrs: {}, on: {}, value: "", hidden: false, ownerDocument: doc,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, style: {},
      appendChild(c) { c.parent = this; this.children.push(c); return c; },
      setAttribute(k, v) { this.attrs[k] = v; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(t, fn) { this.on[t] = fn; },
      focus() { doc.activeElement = this; }, blur() { if (doc.activeElement === this) doc.activeElement = null; }, select() {},
      querySelectorAll(sel) { const out = []; const cls = sel.replace(/^\./, ""); const walk = (n) => { for (const c of n.children) { if (c.className.split(" ").includes(cls)) out.push(c); walk(c); } }; walk(this); return out; },
      fire(t) {
        let stopped = false;
        const ev = { preventDefault() {}, stopPropagation() { stopped = true; } };
        for (let n = this; n && !stopped; n = n.parent) if (n.on[t]) n.on[t](ev);
      } };
    Object.defineProperty(el, "innerHTML", { set() { el.children = []; } });
    return el;
  };
  doc.createElement = make;
  doc.body = make("body");
  return doc;
}

console.log("test_names.js: all assertions passed");
