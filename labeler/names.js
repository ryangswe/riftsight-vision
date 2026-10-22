// SPDX-License-Identifier: Apache-2.0
// The list of names (the Names pass, Check names, Points, and the Boxes pass with names shown):
// the search, the filters, the grid of cards, the answers that clear the search, the hover
// preview, and the two-pane layout of the Names pass, Check names and Points: the card's view,
// the whole frame (a thumbnail and a modal) and where the frame comes from. Shared by the page
// (window.LabelerNames) and Node (test_names.js).
//
// The pure part, tested under Node:
//   - the grid: one group per card (picker.js decides which cards show, ranked and limited by
//     card), every printing its own tile in its card's group; the keys that move in it; how many
//     match beyond the limit, and "Show more";
//   - the rule that every answer clears the search and the filters;
//   - the views' zoom (in steps that go round) and pan, the crops' sizes, the modal's keys, the
//     source line.
// The page part (`panel`) takes the page's state and the few functions of sources.js it needs,
// and returns the functions sources.js calls (renderPicker, choose, pickerKey ...).
(function (root) {
  "use strict";

  const node = typeof module !== "undefined" && module.exports;
  const Picker = node ? require("./picker.js") : root.LabelerPicker;
  const Filters = node ? require("./filters.js") : root.LabelerFilters;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- the grid --------------------------------------------------------------------------------

  // picker.js's entries as the grid's groups: [{ key, entry, card, tiles: [{ id, card, printing }],
  // start, deckLabels, fromDecklist }]. One group per card, its own tile first (printing null),
  // then one tile per alternate printing (printing = its id). A printing's id typed in full
  // (picker.js lists that printing, then its card with the printing recorded) is one group: the
  // card's, starting on the typed printing's tile.
  function gridGroups(entries) {
    const list = (entries || []).filter((e) => e && e.kind === "card" && e.card);
    const typed = new Set(list.filter((e) => e.printing).map((e) => e.printing));
    const out = [];
    for (const e of list) {
      if (!e.printing && typed.has(e.card.id) && !(e.printings || []).length) continue; // in its card's group
      const tiles = [{ id: e.card.id, card: e.card, printing: null }]
        .concat((e.printings || []).map((p) => ({ id: p.id, card: p, printing: p.id })));
      const at = e.printing ? tiles.findIndex((t) => t.printing === e.printing) : 0;
      out.push({ key: e.card.id, entry: e, card: e.card, tiles, start: Math.max(0, at), deckLabels: e.deckLabels || [], fromDecklist: !!e.fromDecklist });
    }
    return out;
  }

  // The group's header: "TOY-003 · Polite Dragon · 2 printings" (the count only when
  // the card has more than one).
  function groupTitle(g) {
    const n = g.tiles.length;
    return `${g.card.id} · ${g.card.name || g.card.id}${n > 1 ? ` · ${n} printings` : ""}`;
  }

  // Where the highlight starts: the first group, on its starting tile.
  function startHl(groups) { return { g: 0, t: groups && groups.length ? groups[0].start : 0 }; }

  // The highlight kept inside the grid.
  function fitHl(groups, hl) {
    if (!groups || !groups.length) return { g: 0, t: 0 };
    const g = clamp((hl && hl.g) | 0, 0, groups.length - 1);
    return { g, t: clamp((hl && hl.t) | 0, 0, groups[g].tiles.length - 1) };
  }

  // ↑ ↓ move between groups (to the group's own tile), ← → between the tiles of one group.
  function moveHl(groups, hl, key) {
    const h = fitHl(groups, hl);
    if (!groups || !groups.length) return h;
    const last = groups[h.g].tiles.length - 1;
    if (key === "ArrowDown") return h.g + 1 < groups.length ? { g: h.g + 1, t: 0 } : h;
    if (key === "ArrowUp") return h.g > 0 ? { g: h.g - 1, t: 0 } : h;
    if (key === "ArrowRight") return { g: h.g, t: Math.min(last, h.t + 1) };
    if (key === "ArrowLeft") return { g: h.g, t: Math.max(0, h.t - 1) };
    return h;
  }

  // The tile at the highlight, or null: { group, tile }.
  function tileAt(groups, hl) {
    if (!groups || !groups.length) return null;
    const h = fitHl(groups, hl);
    return { group: groups[h.g], tile: groups[h.g].tiles[h.t] };
  }

  // ---- more of the grid: picker.js shows PAGE cards; "Show more" (or ↓ on the last card) adds
  // PAGE more, kept while the list stays the same (listKey) and dropped when it changes.
  const PAGE = 60;

  // What the grid lists: the query, the scope, the filters and the card being named (`at`).
  function listKey(o) {
    const x = o || {}, f = x.filters || {};
    const filters = Object.keys(f).filter((k) => f[k] !== null && f[k] !== undefined).sort().map((k) => [k, f[k]]);
    return JSON.stringify([String(x.query || "").trim().toLowerCase(), x.scope || "", filters, x.at || ""]);
  }

  // "60 of 230 cards shown" when the limit cut anything, else "".
  function countLine(shown, total) { return total > shown ? `${shown} of ${total} cards shown` : ""; }

  // How many more cards one press adds (0: none left).
  function moreCount(shown, total) { return Math.max(0, Math.min(PAGE, (total | 0) - (shown | 0))); }

  // ↓ on the last card while more match: the press loads more.
  function downLoadsMore(groups, hl, key, total) {
    return key === "ArrowDown" && !!groups && groups.length > 0 && fitHl(groups, hl).g === groups.length - 1 && moreCount(groups.length, total) > 0;
  }

  // What picking a tile names (an entry for Picker.applyPick): the card's own tile names the card
  // with no printing; an alternate's tile names the card and records that printing.
  function tilePick(group, i) {
    const t = group.tiles[i];
    if (!t) return null;
    return t.printing ? Picker.stripPick(group.entry, t.card) : Object.assign({}, group.entry, { printing: null });
  }

  // ---- box edits in the Names pass: provenance as the server checks it ----------------------

  // A box against the server's copy of it (`b`, its turn base): 0 unchanged, k 1..3 its top edge
  // turned (the same four points, their order rotated), -1 moved, resized or rotated (an edit).
  // G: boxgeom.js.
  function changeOf(G, b, t) {
    const c = JSON.stringify(t.corners);
    if (c === JSON.stringify(b.corners)) return 0;
    const k = [1, 2, 3].find((n) => JSON.stringify(G.topEdgeCorners(b.corners, n)) === c);
    return k || -1;
  }

  // Just before a Names-pass save: each box's provenance as labelcore.py geometry_changes checks
  // it, from the server's copy (bases: id → that copy): an edited box gets the Boxes pass's edit
  // provenance (G.editProvenance applied to the server's), any other the server's own. So an undo,
  // an autosave during a drag or an outcome changed in the same save never disagrees with the
  // server. An edited box with no `angle` (a box stored without one, put back by an undo after its
  // edit was saved) gets its angle written out: the direction of its top edge, which is what no
  // angle means, so the server's check of an edit holds; its corners are exactly as they were.
  // Mutates the targets.
  const PROVENANCE = ["labelSource", "cornerSource", "pending", "suggestion"];
  function settleProvenance(G, targets, bases, boxSet) {
    if (!bases) return;
    for (const t of targets || []) {
      const b = bases.get(t.id);
      if (!b) continue;
      for (const f of PROVENANCE) { if (b[f] === undefined) delete t[f]; else t[f] = b[f]; }
      if (changeOf(G, b, t) < 0) {
        G.editProvenance(t, boxSet);
        const a = G.roundAngle(G.rectFromCorners(t.corners).angle);
        if (t.angle === undefined && a) t.angle = a;
      }
    }
  }

  // Whether ← / → belong to the search field (the text cursor moves): the field holds text, the
  // cursor is inside it (not at an end) and nothing is selected. inp: { value, selectionStart, selectionEnd }.
  function textArrow(inp, key) {
    const v = String((inp && inp.value) || ""), a = inp && inp.selectionStart, b = inp && inp.selectionEnd;
    if (!v || (key !== "ArrowLeft" && key !== "ArrowRight") || typeof a !== "number" || a !== b) return false;
    return a > 0 && a < v.length;
  }

  // ---- the answers -----------------------------------------------------------------------------

  // Every answer clears the search and the filters, so the next card starts with an empty search:
  // a pick, Unknown, a card back, not a card, cannot be read, a model's name accepted, a clear.
  const CLEARING = ["pick", "unknown", "card-back", "not-card", "unreadable", "back", "clear"];
  function clearsSearch(answer) { return CLEARING.includes(answer) || /^accept-/.test(String(answer || "")); }

  // ---- the card's view (the main view of the left pane) and the whole frame ---------------------
  // A view: { z, cx, cy }: z ≥ 1 times the fitted scale, centered on frame point (cx, cy). d:
  // { W, H, w, h, rect? }: the frame's size and the view's (CSS px). The fitted scale shows the
  // whole frame, or, with `rect` ([x0, y0, x1, y1] frame px), that part of it: the card's view
  // fits the box with some room around it (cardBox); the whole frame (the modal) has none.

  const ZOOM_MAX = 8;
  const ZOOM_STEPS = [1, 2, 4];

  function fitScale(d) {
    const r = d.rect;
    return r ? Math.min(d.w / Math.max(1, r[2] - r[0]), d.h / Math.max(1, r[3] - r[1])) : Math.min(d.w / d.W, d.h / d.H);
  }
  function scaleOf(v, d) { return fitScale(d) * v.z; }

  // The card's part of the frame: { rect, bounds }. `rect` is what the card's view fits at 1×: the
  // box's axis-aligned extent with a quarter of its width and height on each side. `bounds` is
  // where the view may go: the frame, and beyond its edges 15 % of the box's size more, or as far
  // as the box itself runs past an edge and that 15 % again, so every corner can be reached.
  // `rect` is kept inside `bounds`.
  function cardBox(corners, W, H) {
    const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const w = x1 - x0, h = y1 - y0, ex = 0.15 * Math.max(w, h);
    const bounds = [Math.min(0, x0) - ex, Math.min(0, y0) - ex, Math.max(W, x1) + ex, Math.max(H, y1) + ex];
    const rect = [clamp(x0 - w / 4, bounds[0], bounds[2]), clamp(y0 - h / 4, bounds[1], bounds[3]),
      clamp(x1 + w / 4, bounds[0], bounds[2]), clamp(y1 + h / 4, bounds[1], bounds[3])];
    return { rect, bounds };
  }
  // The middle of a box's extent: where the card's zoom and the whole frame's zoom center.
  function boxMid(q) {
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

  // The view kept inside its bounds (`d.bounds`, else the frame): a picture narrower than the view
  // is centered, a wider one shows no empty space beyond them. Only for drawing: the person's
  // own view (zoom and center) is kept as they left it, so a pane that shrinks and grows again,
  // or a window resized, brings it back as it was.
  function clampView(v, d) {
    const z = clamp(v.z || 1, 1, ZOOM_MAX), s = fitScale(d) * z, b = d.bounds || [0, 0, d.W, d.H];
    const hw = d.w / s / 2, hh = d.h / s / 2;
    const cx = hw * 2 >= b[2] - b[0] ? (b[0] + b[2]) / 2 : clamp(v.cx, b[0] + hw, b[2] - hw);
    const cy = hh * 2 >= b[3] - b[1] ? (b[1] + b[3]) / 2 : clamp(v.cy, b[1] + hh, b[3] - hh);
    return { z, cx, cy };
  }

  // The view as drawn, for the page's pointer and drawing code: { cx, cy, z: screen px per frame
  // px, w, h } (boxgeom.js frameToView). The person's view `v` is read, never changed.
  function drawnView(v, d) { const c = clampView(v, d); return { cx: c.cx, cy: c.cy, z: fitScale(d) * c.z, w: d.w, h: d.h }; }

  // The whole view, as the person's view (not clamped): the frame, or the card's rect, centered
  // (`z`: the zoom kept from the card before).
  function fitView(d, z) {
    const r = d.rect || [0, 0, d.W, d.H];
    return { z: z || 1, cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2 };
  }

  function toView(v, d, x, y) { const s = scaleOf(v, d); return { x: (x - v.cx) * s + d.w / 2, y: (y - v.cy) * s + d.h / 2 }; }
  function toFrame(v, d, x, y) { const s = scaleOf(v, d); return { x: v.cx + (x - d.w / 2) / s, y: v.cy + (y - d.h / 2) / s }; }

  // Zoom by `factor` keeping the frame point under view point (px, py) where it is (from the view
  // as drawn).
  function zoomAt(v0, d, factor, px, py) {
    const v = clampView(v0, d), f = toFrame(v, d, px, py);
    const z = clamp(v.z * factor, 1, ZOOM_MAX), s = fitScale(d) * z;
    return clampView({ z, cx: f.x - (px - d.w / 2) / s, cy: f.y - (py - d.h / 2) / s }, d);
  }

  // Drag the picture by (dx, dy) view px (from the view as drawn).
  function panBy(v0, d, dx, dy) {
    const v = clampView(v0, d), s = scaleOf(v, d);
    return clampView({ z: v.z, cx: v.cx - dx / s, cy: v.cy - dy / s }, d);
  }

  // A box changed past the card's rect: the rect (and bounds) grown to take in the box and its
  // margin, so 1× shows it all, and the person's view kept on screen as it is: the same center,
  // and a zoom that keeps the same scale over the larger rect. `view`: the view as drawn; d: the
  // dims with the old rect. → { cv, box } (the same cv and box while the box is inside the rect).
  function growCard(cv, view, d, box, corners) {
    const r = box.rect, inside = corners.every((q) => q[0] >= r[0] && q[0] <= r[2] && q[1] >= r[1] && q[1] <= r[3]);
    if (inside) return { cv, box };
    const nb = cardBox(corners, d.W, d.H), rect = union(r, nb.rect);
    const grown = { rect, bounds: union(box.bounds, nb.bounds) }, d1 = Object.assign({}, d, grown);
    return { cv: { z: view.z * fitScale(d) / fitScale(d1), cx: view.cx, cy: view.cy }, box: grown };
  }

  // Check names' crop: a square of 180 to 420 px, about 40 % of the left pane's height and never
  // more than half its width, as in the sittings before the card's view: the crop's enlargement is
  // part of what the "can you read it" answer was judged on.
  function cropSize(paneW, paneH) {
    return Math.round(clamp(Math.min(paneH * 0.4, paneW * 0.5), 180, 420));
  }

  // Points' crop: a square of 320 to 640 px, 60 px kept under it for its caption and 40 beside
  // it, as in the sittings before the two panes, less `strip` px of the pane's width: the column
  // beside it (the whole frame's thumbnail, the less used controls). How much of the frame the
  // point is judged in, so it stays as it was wherever the pane has that room.
  const POINT_STRIP = 110;
  function pointCropSize(paneW, paneH, strip) {
    return Math.max(320, Math.min(640, paneH - 60, paneW - 40 - (strip || 0)));
  }

  // Zoom levels that go round: the next of n levels, after the last the first; `back` the other
  // way. Points' view zoom, Check names' crop and the card's view all step so.
  function cycleLevel(i, n, back) { return ((((i | 0) + (back ? -1 : 1)) % n) + n) % n; }

  // `z` / Shift+Z on the card's view: the next / previous of 1×, 2×, 4×, round and round, centered
  // on (x, y) (the person's view: drawn through clampView). From a wheel zoom between two steps,
  // the step that way.
  function cycleZoom(v, d, back, x, y) {
    const n = ZOOM_STEPS.length, on = ZOOM_STEPS.findIndex((s) => Math.abs(s - v.z) < 1e-6);
    const i = on >= 0 ? cycleLevel(on, n, back)
      : back ? Math.max(0, ZOOM_STEPS.filter((s) => s < v.z).length - 1) : Math.max(0, ZOOM_STEPS.findIndex((s) => s > v.z));
    return { z: ZOOM_STEPS[i], cx: x, cy: y };
  }

  // ---- the whole frame in a modal: what a key or a press does while it is open ---------------
  // e: { key, meta } for a key, { press: "backdrop" | "close" | "inside" } for a mouse press. →
  // "close", "zoom", "zoom-back", "block" (the key does nothing else), or null (left alone).
  function modalAction(e) {
    if (e.press) return e.press === "backdrop" || e.press === "close" ? "close" : null;
    if (e.meta) return null; // the browser's own shortcuts
    if (e.key === "Escape") return "close";
    if (e.key === "z" || e.key === "Z") return e.key === "z" ? "zoom" : "zoom-back";
    return "block";
  }

  // ---- where the frame comes from: the sample's title, upload date and language, and a link --
  // src: { platform, videoId, title, uploadDate, language, unused } (any may be absent; `unused`:
  // the fields the sample gave in a form the tool does not take); t: the frame's time in seconds.
  // → { title, meta, href, link, unused, empty }. A link only for a YouTube video id;
  // nothing is fetched, the link opens in the browser.
  const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
  function clock(t) {
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = String(t % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }
  function sourceLine(src, t) {
    const o = src || {}, str = (x) => (typeof x === "string" && x.trim() ? x.trim() : null);
    const sec = typeof t === "number" && isFinite(t) && t >= 0 ? Math.floor(t) : null;
    const href = o.platform === "youtube" && YOUTUBE_ID.test(o.videoId || "")
      ? "https://www.youtube.com/watch?v={video_id}".replace("{video_id}", o.videoId) + (sec === null ? "" : `&t=${sec}s`) : null;
    const title = str(o.title), meta = [str(o.uploadDate) && `uploaded ${o.uploadDate.trim()}`, str(o.language)].filter(Boolean).join(" · ");
    const un = Array.isArray(o.unused) ? o.unused : [];
    const unused = un.length ? `${un.length === 1 ? "1 value" : `${un.length} values`} in the sample ${un.length === 1 ? "was" : "were"} not used (not of its form): ${un.join(", ")}` : null;
    return { title, meta, href, link: href ? (sec === null ? "Open the video" : `Open the video at ${clock(sec)}`) : null, unused, empty: !title && !meta && !href && !unused };
  }

  // The line drawn into `el` (emptied first): the title, the date and language, the link.
  function renderSource(doc, el, line) {
    el.innerHTML = "";
    el.hidden = line.empty;
    const add = (tag, cls, text) => { const n = doc.createElement(tag); n.className = cls; n.textContent = text; el.appendChild(n); return n; };
    if (line.title) add("span", "srcTitle", line.title).setAttribute("title", line.title);
    if (line.meta) add("span", "srcMeta", line.meta);
    if (line.href) {
      const a = add("a", "srcLink", `${line.link} ↗`);
      a.setAttribute("href", line.href); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener");
    }
    if (line.unused) add("span", "srcUnused", line.unused);
  }

  // ---- the grid, drawn -------------------------------------------------------------------------

  // Draws the groups into `list` (emptied first): per group a thin header (groupTitle, and its
  // deck lists) and one tile per printing (its art, loaded lazily, and its id). h: { hl: {g, t},
  // setArt(img, id), deck(group) → text, onPick(group, i), onHover(tile, ev), onLeave() }. The
  // preview follows the pointer on a tile's picture only, never the highlight or the list.
  // h.more: { count, onMore() } puts a "Show N more" button after the last group.
  function renderGrid(doc, list, groups, h) {
    list.innerHTML = "";
    const el = (tag, cls, parent, text) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      if (parent) parent.appendChild(n);
      return n;
    };
    const hl = fitHl(groups, h.hl);
    groups.forEach((g, gi) => {
      const box = el("li", "group" + (g.fromDecklist ? " deck" : "") + (gi === hl.g ? " hl" : ""), list);
      box.dataset.card = g.card.id;
      const head = el("div", "ghead", box);
      head.setAttribute("title", groupTitle(g));
      el("span", "cid", head, g.card.id);
      el("span", "gname", head, ` · ${g.card.name || g.card.id}`);
      if (g.tiles.length > 1) el("span", "gcount", head, ` · ${g.tiles.length} printings`);
      const deck = h.deck ? h.deck(g) : "";
      if (deck) el("span", "gdeck", head, ` · ${deck}`);
      const row = el("div", "tiles", box);
      g.tiles.forEach((t, ti) => {
        const tile = el("div", "tile" + (t.printing ? " alt" : "") + (gi === hl.g && ti === hl.t ? " hl" : ""), row);
        tile.dataset.tile = t.id;
        // a card the catalog lists without art ("art": null): a placeholder with its name, never an image
        const noArt = !!(t.card && t.card.noArt);
        const img = el(noArt ? "div" : "img", noArt ? "noart" : "", tile);
        if (noArt) {
          el("span", "noart-note", img, "No picture yet");
          el("span", "noart-name", img, t.card.name || t.id);
        } else {
          img.setAttribute("loading", "lazy");
          img.setAttribute("alt", "");
          h.setArt(img, t.id);
        }
        el("span", "cid", tile, t.id);
        tile.addEventListener("mousedown", (ev) => { ev.preventDefault(); ev.stopPropagation(); h.onPick(g, ti); });
        if (h.onHover) img.addEventListener("mousemove", (ev) => h.onHover(t, ev));
        if (h.onLeave) img.addEventListener("mouseleave", h.onLeave);
      });
    });
    if (h.more && h.more.count > 0) {
      const b = el("button", "", el("li", "more", list), `Show ${h.more.count} more`);
      b.type = "button";
      b.title = "More cards match: show the next ones (↓ on the last card does it too)";
      b.addEventListener("mousedown", (ev) => ev.preventDefault()); // the keys stay in the search
      b.addEventListener("click", () => h.more.onMore());
    }
  }

  // ---- the page --------------------------------------------------------------------------------

  // The Names pass, Check names and Points: the page in two panes. Left: the card's view (Points:
  // the point's crop), large, and under it (Points: beside it) a strip: the whole frame's
  // thumbnail (a click opens it in a modal), then the less used controls, About this recording
  // and Options; right: a fixed top (the status, the answers, the search and the filters) over the
  // grid, the only part that scrolls. Moves the page's own elements once, at start (the pass is
  // fixed for a run). The Boxes and Corners passes keep their one side column.
  function arrangePanes(doc, mode) {
    const $ = (id) => doc.getElementById(id);
    doc.body.classList.add("names-ui");
    if (mode === "point") doc.body.classList.add("points-ui");
    const center = $("center"), side = $("side");
    const strip = doc.createElement("div"); strip.id = "namesStrip";
    const left = doc.createElement("div"); left.id = "namesTools";
    const top = doc.createElement("div"); top.id = "namesTop";
    center.insertBefore(strip, $("legend"));
    const more = doc.createElement("div"); more.id = "namesMore"; // under the thumbnail: Options
    more.append($("options"));
    strip.append($("overviewWrap"), left, more);
    $("overview").title = "The whole frame: click to open it (Esc closes it)";
    for (const id of ["verifyPanel", "actions", "inspector", "recording"]) left.appendChild($(id));
    // right: the fixed top, then the grid
    side.insertBefore(top, side.firstChild);
    for (const id of ["panelHead", "question", "otherAnswers", "searchBox", "pickerSpecials", "printingEditor"]) top.appendChild($(id));
    $("names").insertBefore($("pickerEmpty"), $("pickerList"));
  }

  // The whole frame: the thumbnail under the card's view, and the modal that shows it large (every
  // box, the current one thick; the wheel zooms, a drag pans, z / Shift+Z step). The pass draws its
  // own marks with paint(marks, at): marks(fv, big) on the thumbnail and, when open, on the modal
  // (fv: { ctx, s, map: frame point → view point }); `at`: [x, y] of the card, where z centers.
  // P: { S, $, img(), frameSize(), sizeCanvas, voidColor, render, focus }
  function wholeFrame(P) {
    const { S, $ } = P;
    function draw(c, d, v) {
      const ctx = P.sizeCanvas(c, d.w, d.h), s = scaleOf(v, d), ox = d.w / 2 - v.cx * s, oy = d.h / 2 - v.cy * s, img = P.img();
      ctx.fillStyle = P.voidColor; ctx.fillRect(0, 0, d.w, d.h);
      if (img && img.naturalWidth) ctx.drawImage(img, ox, oy, d.W * s, d.H * s);
      return { ctx, s, map: (p) => [p[0] * s + ox, p[1] * s + oy] };
    }
    const dims = (el, box) => { const [W, H] = P.frameSize(), w = Math.max(80, el.clientWidth); return { W, H, w, h: box ? Math.max(90, el.clientHeight) : Math.round(w * H / W) }; };
    const modalDims = () => dims($("frameModalView"), true);
    function paint(marks, at) {
      S.frameAt = at;
      const td = dims($("overview").parentNode);
      marks(draw($("overview"), td, fitView(td)), false);
      if (!S.frameModal) return;
      const d = modalDims();
      S.fv = S.fv || fitView(d);
      marks(draw($("frameModalCanvas"), d, clampView(S.fv, d)), true);
    }
    function setOpen(on) {
      S.frameModal = !!on; S.fv = null;
      $("frameModal").hidden = !on;
      if (!on) P.focus();
      P.render();
    }
    function act(a) {
      if (a === "close") setOpen(false);
      else if (a === "zoom" || a === "zoom-back") {
        const d = modalDims(), c = S.frameAt || [d.W / 2, d.H / 2];
        S.fv = cycleZoom(S.fv || fitView(d), d, a === "zoom-back", c[0], c[1]);
        P.render();
      }
    }
    // A key while the modal is open is the modal's (→ true): Esc closes it, z / Shift+Z zoom, the
    // others do nothing; the browser's own shortcuts are left to it.
    function key(ev) {
      if (!S.frameModal) return false;
      const a = modalAction({ key: ev.key, meta: ev.metaKey || ev.ctrlKey });
      if (a) { ev.preventDefault(); act(a); }
      return true;
    }
    function wire() {
      const cv = $("frameModalCanvas"), redraw = () => { if (!S.fvRaf) S.fvRaf = requestAnimationFrame(() => { S.fvRaf = 0; P.render(); }); };
      // the card's view follows its pane's size (the strip under it is filled after a first draw)
      const two = () => cv.ownerDocument.body.classList.contains("names-ui");
      if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => { if (two()) redraw(); }).observe($("pointStage"));
      $("overview").addEventListener("click", () => { if (two() && P.img()) setOpen(true); });
      $("frameModalClose").addEventListener("click", () => act(modalAction({ press: "close" })));
      $("frameModal").addEventListener("mousedown", (ev) => act(modalAction({ press: ev.target === $("frameModal") ? "backdrop" : "inside" })));
      cv.addEventListener("wheel", (ev) => {
        if (!S.fv) return;
        ev.preventDefault();
        const r = cv.getBoundingClientRect();
        S.fv = zoomAt(S.fv, modalDims(), Math.exp(-ev.deltaY / 300), ev.clientX - r.left, ev.clientY - r.top); redraw();
      }, { passive: false });
      cv.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0 || !S.fv) return;
        ev.preventDefault();
        let x = ev.clientX, y = ev.clientY;
        const move = (e) => { S.fv = panBy(S.fv, modalDims(), e.clientX - x, e.clientY - y); x = e.clientX; y = e.clientY; redraw(); };
        const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
        addEventListener("mousemove", move); addEventListener("mouseup", up);
      });
    }
    return { paint, setOpen, key, wire };
  }

  // ctx: { S, $, SG, mode, editable, gateState, setStatus, selected, noTargetMessage, vCenter,
  // vItem, verifyAnswer, mutate, zoomStage, renderChrome, renderToolbar, cardWho, lsSet, LS }
  function panel(P) {
    const { S, $ } = P;

    function openPicker() {
      if (!P.editable()) return;
      if (P.mode() === "verify" ? !P.vCenter(P.vItem()) : !P.selected()) { P.setStatus(P.mode() === "verify" ? "There is no card here." : P.noTargetMessage()); return; }
      $("searchBox").hidden = false; // a hidden field takes no focus: `/` and Change always reach it
      const inp = $("pickerInput");
      inp.focus(); inp.select();
      renderPicker();
    }

    function closePicker() {
      S.pickerOpenedAt = null;
      $("pickerInput").blur();
      const target = P.zoomStage() ? doc().body : $("frameCanvas");
      if (target.focus) target.focus();
      P.renderChrome();
    }
    const doc = () => $("pickerInput").ownerDocument;

    function groups() { return (S.picker.grid) || []; }

    // The search, the filters and the highlight back to empty: after every answer (clearsSearch).
    function clearSearch(answer) {
      if (!clearsSearch(answer)) return;
      $("pickerInput").value = ""; S.picker.query = "";
      S.picker.hl = { g: 0, t: 0 };
      S.filters = {};
      renderFilters(); renderPicker();
    }

    function choose(entry) {
      if (entry.kind === "not-in-list") {
        S.picker.scope = S.picker.scope === "all" && S.deckIds.length ? "decklist" : "all";
        S.picker.hl = { g: 0, t: 0 }; S.picker.fresh = true; renderPicker(); $("pickerInput").focus(); return;
      }
      const pick = Picker.applyPick(entry, S.picker.list.scope);
      if (!pick) return;
      if (!P.editable()) { P.setStatus(P.SG.mayEdit(P.gateState()).text); return; } // a name is a change of the frame
      const answer = entry.kind === "unknown" ? "unknown" : "pick";
      if (P.mode() === "verify") {
        clearSearch(answer);
        closePicker();
        P.verifyAnswer("picked", pick);
        return;
      }
      P.mutate((t) => {
        t.outcome = pick.outcome; t.identity = pick.identity; t.printing = pick.printing;
        t.identitySource = pick.identitySource;
      });
      clearSearch(answer);
      closePicker();
    }

    function pickTile(g, i) { const e = tilePick(g, i); if (e) choose(e); }

    function pickHighlighted() {
      const gs = groups();
      if (gs.length) { const h = fitHl(gs, S.picker.hl); pickTile(gs[h.g], h.t); }
      else if (S.picker.list && S.picker.list.scope === "decklist") choose({ kind: "not-in-list" });
    }

    // What the catalog says of a card beyond its name and id: its kind, its printing, and that it
    // has no picture yet (a card the catalog lists without art).
    function cardKind(card, printing) {
      return [card.kind, card.token && !/token/i.test(card.kind || "") ? "token" : null,
        card.printingOf ? `printing of ${card.printingOf}` : null,
        printing ? `printing ${printing}` : null, card.noArt ? "no picture yet" : null].filter(Boolean).join(" · ");
    }

    // Where a card's image comes from (the catalog entry's `artUrl`, set by the server from --art),
    // or null: no --art, or no image for this card. The previews then show the name only.
    function artSrc(id) { const c = S.byId.get(id); return (c && c.artUrl) || null; }
    // Put a card's art into an <img>; without art the image is hidden (class no-art). → has art
    function setArt(img, id) {
      const src = artSrc(id);
      img.onerror = () => { img.removeAttribute("src"); img.classList.add("no-art"); };
      if (src) { img.classList.remove("no-art"); img.src = src; } else { img.removeAttribute("src"); img.classList.add("no-art"); }
      return !!src;
    }

    function renderPicker() {
      hideHoverPreview(); // the tile it showed may be gone: the next pointer move shows it again
      S.picker.query = $("pickerInput").value;
      // the cards "Show more" added stay while the list is the same one (listKey), and so does its scroll
      const key = listKey({ query: S.picker.query, scope: S.picker.scope, filters: S.filters, at: S.filterAt });
      const same = key === S.picker.moreKey;
      if (!same) { S.picker.moreKey = key; S.picker.extra = 0; }
      S.picker.list = Picker.buildList(S.catalog, { query: S.picker.query, decklistIds: S.deckIds, scope: S.picker.scope, limit: PAGE + (S.picker.extra || 0),
        decklists: S.decklists.length > 1 ? S.decklists.map((d) => ({ label: d.label, ids: d.ids })) : null, filters: S.filters });
      const gs = gridGroups(S.picker.list.entries);
      // a new list starts on its first group (on the typed printing, when one was typed in full)
      if (S.picker.fresh || typeof S.picker.hl !== "object") S.picker.hl = startHl(gs);
      S.picker.fresh = false;
      S.picker.grid = gs;
      S.picker.hl = fitHl(gs, S.picker.hl);
      const list = S.picker.list;
      $("scopeDeck").className = list.scope === "decklist" ? "on" : "";
      $("scopeAll").className = list.scope === "all" ? "on" : "";
      $("scopeDeck").disabled = !S.deckIds.length;
      $("scopeDeck").textContent = `Deck list (${list.counts.deck})`;
      $("scopeAll").textContent = `All cards (${list.counts.all})`;
      const grid = $("pickerList"), top = grid.scrollTop, more = moreCount(gs.length, list.total);
      renderGrid(doc(), grid, gs, { hl: S.picker.hl, setArt, onPick: pickTile, onLeave: hideHoverPreview, more: more ? { count: more, onMore: showMore } : null,
        deck: (g) => (g.deckLabels.length ? `deck list ${g.deckLabels.join(" + ")}` : g.fromDecklist ? "in the deck list" : ""),
        // the picture of a tile, pointed at: the card enlarged over the frame, whatever the Card previews option says
        onHover: (t, ev) => showHoverPreview({ id: `pick:${t.id}`, identity: t.id, outcome: "card", printing: null }, ev.clientX, ev.clientY, true, true) });
      grid.scrollTop = same ? top : 0; // a new list starts at its top, as its highlight does
      const count = $("pickerCount");
      count.textContent = countLine(gs.length, list.total);
      count.hidden = !count.textContent;
      const sp = $("pickerSpecials");
      sp.innerHTML = "";
      const nE = gs.length;
      // "Unknown card" is an answer (with the others, above the search); here only the scope
      const all = list.scope === "all";
      const b = doc().createElement("button");
      b.type = "button";
      b.textContent = all ? (S.deckIds.length ? "Back to the deck list" : "All cards are shown") : "Search all cards";
      b.title = all ? "" : "The card is not in the deck list: search the whole catalog (Tab, in the search)";
      b.disabled = all && !S.deckIds.length;
      b.dataset.act = "search-all";
      sp.appendChild(b);
      if (P.mode() === "box") { // the Boxes pass has no answers row: Unknown stays here
        const u = doc().createElement("button");
        u.type = "button"; u.textContent = "Unknown card"; u.dataset.act = "unknown";
        u.title = "A card whose name you cannot tell. Better than a guess.";
        sp.appendChild(u);
      }
      $("filterNote").textContent = list.filtered ? `${nE} shown` : "";
      // a search with no match says so; the scope button stays (search all cards)
      const empty = $("pickerEmpty");
      const q = S.picker.query.trim();
      empty.hidden = nE > 0;
      empty.textContent = nE ? "" : !S.catalog.length ? "No catalog was given, so there are no cards to pick."
        : list.scope === "decklist" ? `No card${q ? ` matches “${q}”` : ""} in the deck list.`
          : `No card${q ? ` matches “${q}”` : " to show"}${list.filtered ? " with these filters" : ""}.`;
      if (S.picker.byKeys) { // the highlighted tile in sight, when the keys moved it
        const li = $("pickerList").children[S.picker.hl.g];
        const tile = li && li.querySelectorAll(".tile")[S.picker.hl.t];
        if (tile && tile.scrollIntoView) tile.scrollIntoView({ block: "nearest" });
      }
    }

    // PAGE more cards in the grid (the button after the last card).
    function showMore() { S.picker.extra = (S.picker.extra || 0) + PAGE; renderPicker(); P.renderChrome(); }

    // The highlighted tile, for the instruction line and the primary button.
    function searchState() {
      const inp = $("pickerInput");
      const list = S.picker.list;
      const at = tileAt(groups(), S.picker.hl);
      const card = at ? at.group.card : null;
      return { focused: doc().activeElement === inp, query: inp.value, matches: groups().length, scope: list ? list.scope : "all",
        highlight: at ? P.cardWho(at.tile.id) : null,
        highlightName: card ? card.name : null, sameName: card ? Picker.sameName(list.entries, card) : 0 };
    }

    function pickerKey(ev) {
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(ev.key)) {
        // ← → move the text cursor while it is inside the typed text (not at an end, nothing
        // selected); otherwise they move along the printings, as ↑ ↓ move between cards
        // ↓ on the last card while more match loads more and moves onto the first new one
        if (!textArrow(ev.target || $("pickerInput"), ev.key)) {
          const gs = groups();
          if (downLoadsMore(gs, S.picker.hl, ev.key, S.picker.list ? S.picker.list.total : 0)) { S.picker.extra = (S.picker.extra || 0) + PAGE; S.picker.hl = { g: gs.length, t: 0 }; }
          else S.picker.hl = moveHl(gs, S.picker.hl, ev.key);
          S.picker.byKeys = true; renderPicker(); S.picker.byKeys = false; ev.preventDefault();
        }
      } else if (ev.key === "Enter") { pickHighlighted(); ev.preventDefault(); }
      else if (ev.key === "Tab") { choose({ kind: "not-in-list" }); ev.preventDefault(); }
      else if (ev.key === "Escape") { $("pickerInput").value = ""; S.picker.fresh = true; renderPicker(); closePicker(); ev.preventDefault(); }
      // `/` puts the keys in the search from the frame; pressed again in the empty search it is not typed
      else if (ev.key === "/" && !$("pickerInput").value) ev.preventDefault();
      ev.stopPropagation();
      P.renderChrome();
    }

    // ---- card filters (Type and the catalog's facets, filters.js; ANDed with the query; cleared per card)

    function kindChips() { return Filters.kindChips(S.catalog); }

    function renderFilters() {
      const rows = Filters.chipRows(S.catalog, S.facets);
      $("filters").hidden = !rows.length;
      // a catalog that declares no facets: say that more filters exist and where they come from
      $("facetHint").hidden = Array.isArray(S.facets) && S.facets.length > 0;
      Filters.renderChips(doc(), $("kindChips"), rows, S.filters, setFilter);
    }

    function setFilter(k, v) {
      S.filters[k] = v === undefined ? null : v;
      S.picker.fresh = true;
      renderFilters(); renderPicker();
    }

    function cycleFilter(k, vals) {
      const i = S.filters[k] === null || S.filters[k] === undefined ? -1 : vals.indexOf(S.filters[k]);
      setFilter(k, i + 1 >= vals.length ? null : vals[i + 1]);
    }

    function clearFilters() { S.filters = {}; setFilter("kind", null); }

    // t / 0 (box, identify and verify mode, never while a text field has focus)
    function onFilterKey(k) {
      if (k === "t") cycleFilter("kind", kindChips());
      else if (k === "0") clearFilters();
      else return false;
      return true;
    }

    // ---- printing editor (`a`) -------------------------------------------------------------

    function openPrintingEditor() {
      const t = P.selected();
      if (!P.editable() || !t) { P.setStatus(P.noTargetMessage()); return; }
      if (t.outcome !== "card") { P.setStatus("Only a card can have another printing."); return; }
      const inp = $("printingInput");
      $("printingEditor").hidden = false;
      // the first alternate printing the catalog lists for this card, as a starting point
      const alts = t.identity && t.identity !== "unknown" ? Filters.printingsOf(S.catalog, t.identity) : [];
      inp.value = t.printing || (alts.length ? alts[0].id : "");
      inp.focus(); inp.select();
    }

    function closePrintingEditor() { $("printingEditor").hidden = true; }

    function commitPrinting() {
      const val = Filters.canonicalPrinting(S.catalog, $("printingInput").value);
      P.mutate((t) => { t.printing = val; });
      closePrintingEditor();
      closePicker();
    }

    // ---- hover art ("Card previews": the enlarged art of the card a hovered box is labeled as) --

    function setHoverArt(on) {
      S.hoverArt = !!on;
      P.lsSet(P.LS.hover, S.hoverArt ? "on" : "off");
      if (!S.hoverArt) hideHoverPreview();
      P.renderToolbar();
    }

    // The card on its view, in client px: the box (Names), the middle of the crop (Check names,
    // Points).
    function cardRect() {
      const v = S.idView, t = P.selected(), r = $("zoomView").getBoundingClientRect();
      const q = P.mode() === "verify" || P.mode() === "point" ? [[r.width * 0.35, r.height * 0.35], [r.width * 0.65, r.height * 0.65]]
        : v && t ? t.corners.map((c) => [(c[0] - v.cx) * v.z + v.w / 2, (c[1] - v.cy) * v.z + v.h / 2]) : null;
      if (!q) return null;
      const xs = q.map((c) => c[0]), ys = q.map((c) => c[1]);
      return { left: r.left + Math.min(...xs), right: r.left + Math.max(...xs), top: r.top + Math.min(...ys), bottom: r.top + Math.max(...ys) };
    }

    function hideHoverPreview() { S.hoverKey = null; $("hoverPreview").classList.remove("visible"); }

    // `overFrame`: placed over the left pane (the Names pass's card view), not by the pointer, so
    // it never covers the grid it was asked from: beside the card (cardRect, client px) on the
    // side with more room, narrowed to that room (200 to 384 px), so the two are seen side by side.
    function showHoverPreview(t, clientX, clientY, force, overFrame) {
      if ((!S.hoverArt && !force) || !t || !t.identity || t.identity === "unknown" || t.outcome !== "card") { hideHoverPreview(); return; }
      const el = $("hoverPreview");
      const k = `${t.id}|${t.identity}|${t.printing || ""}`;
      if (k !== S.hoverKey) {
        S.hoverKey = k;
        const card = S.byId.get(t.identity);
        const img = $("hoverPreviewImg");
        el.classList.toggle("no-art", !setArt(img, t.identity));
        img.onerror = () => { img.removeAttribute("src"); el.classList.add("no-art"); };
        $("hoverPreviewName").textContent = P.cardWho(t.identity);
        $("hoverPreviewMeta").textContent = card ? cardKind(card, t.printing) : "";
      }
      const win = doc().defaultView, m = 18, top = $("layout").getBoundingClientRect().top + 4; // below the top bar
      const crop = overFrame && doc().body.classList.contains("names-ui") ? $("zoomView").getBoundingClientRect() : null;
      const card = crop && crop.width ? cardRect() : null;
      const roomL = card ? card.left - crop.left - 2 * m : 0, roomR = card ? crop.right - card.right - 2 * m : 0;
      el.style.width = card ? `${Math.round(clamp(Math.max(roomL, roomR), 200, 384))}px` : "";
      const w = el.offsetWidth || 384, h = el.offsetHeight || 560;
      let x = clientX + m, y = clientY + m;
      if (card) {
        x = roomL >= roomR ? Math.max(crop.left + 4, card.left - m - w) : Math.min(crop.right - 4 - w, card.right + m);
        y = clamp((card.top + card.bottom) / 2 - h / 2, top, Math.max(top, win.innerHeight - 8 - h));
      } else if (crop && crop.width) { x = Math.max(8, crop.left + 8); y = clamp(crop.bottom - h, top, Math.max(top, win.innerHeight - 8 - h)); }
      else {
        if (x + w > win.innerWidth - 8) x = clientX - m - w;
        if (y + h > win.innerHeight - 8) y = Math.max(8, win.innerHeight - 8 - h);
      }
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      el.classList.add("visible");
    }

    return { openPicker, closePicker, choose, pickHighlighted, clearSearch, cardKind, artSrc, setArt, renderPicker, searchState, pickerKey,
      showMore, kindChips, renderFilters, setFilter, cycleFilter, clearFilters, onFilterKey, openPrintingEditor, closePrintingEditor, commitPrinting,
      setHoverArt, hideHoverPreview, showHoverPreview };
  }

  const api = { textArrow, changeOf, settleProvenance, gridGroups, groupTitle, startHl, fitHl, moveHl, tileAt, tilePick, clearsSearch,
    PAGE, listKey, countLine, moreCount, downLoadsMore,
    ZOOM_MAX, ZOOM_STEPS, fitScale, boxMid, cardBox, growCard, cropSize, POINT_STRIP, pointCropSize, clampView, drawnView, fitView, toView, toFrame, zoomAt, panBy, cycleLevel, cycleZoom,
    modalAction, sourceLine, renderSource, renderGrid, arrangePanes, wholeFrame, panel };
  if (node) module.exports = api;
  else root.LabelerNames = api;
})(typeof window !== "undefined" ? window : globalThis);
