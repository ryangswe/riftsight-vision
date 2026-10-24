// SPDX-License-Identifier: Apache-2.0
// The labeling tool's page. Vanilla JS, no build step. Talks only to serve.py.
// Modes (fixed per server run, stored per set): point, corner, training (corners + prefill
// proposals), box (boxes, no identity needed) and identify (a pass over a box/corner set that
// walks the targets without an identity; in box sets its top edge may turn and, in training and
// development sets, the current box may be moved, resized or rotated as in the Boxes pass).
// Box mode's editor: undo / redo, copy/paste, multi-select, rotated boxes, edge resize, z-order,
// default box, unconfirm, carry-over, snap, row tools; in box + identify mode the card filters,
// hover art, selected-card panel and printing editor. Pure helpers: boxgeom.js (tested by
// test_boxgeom.js).
// Box mode on a role=training set with --prefill: a model's boxes come in as pending boxes
// (dash-dot, marked "model") to accept (a / Enter), correct (any edit) or reject (Delete); Enter
// on the frame accepts every untouched one. Never in development or test sets.
// Center mode (a center census): a click on the center of every card face (Shift+click: back) on
// the whole frame, with a loupe; no model output, no identities. Pure helpers: centergeom.js
// (tested by test_centergeom.js), needed only in this mode.
// Verify mode (naming a center census): a pass over a center set that walks every FACE center,
// crop first, then the proposals of the run's one or two model arms; the blind subsample is
// named with no proposals. Answers only. Pure helpers: verifycore.js (test_verifycore.js).
// Around the editor of every mode: a top bar, one instruction line, a primary button and the
// everyday actions as buttons, a finish card, and the save and connection indicators. Their
// words come from uistate.js (test_uistate.js); who takes a key press is decided by where the
// focus is, in keyroute.js (test_keyroute.js); every color drawn here comes from theme.css.
// Whether a frame may be changed, whether a change may be saved, and whether the tool that
// answers is still the run this page was loaded from, is decided in savegate.js
// (test_savegate.js): every control asks `editable()`, and every change passes the one gate in
// `scheduleSave` and `saveFrame` on its way to the server.
// See README.md for the modes and the keys, FORMAT.md for the label format.
(function (root) {
  "use strict";
  const Picker = root.LabelerPicker;
  const Names = root.LabelerNames; // the list of names, and the Names pass's two panes
  const QS = root.LabelerQuadSnap;
  const G = root.LabelerBoxGeom;
  const Tools = root.LabelerTools;
  const Snap = root.LabelerSnap;
  const Filters = root.LabelerFilters;
  const TL = root.LabelerTimingLog;
  const C = root.LabelerCenterGeom; // center mode only (an older serve.py does not serve it)
  const V = root.LabelerVerifyCore; // verify mode only
  const U = root.LabelerUiState; // the instruction line, the primary button, progress, the finish card
  const BE0 = root.LabelerBoxEdit; // the Boxes pass's geometry edits
  // The server behavior this page needs (serve.py's PAGE_API); an older running serve.py lacks it.
  const PAGE_API = 2;
  const KR = root.LabelerKeyRoute; // who handles a key press
  const SG = root.LabelerSaveGate; // may this frame be changed, may this change be saved, is this still the same run
  const BS = root.LabelerBoxSize; // the size of a new box, and what a click on the frame does
  // This page, among the pages open on this tool: it tells the server whether it holds unsaved
  // changes (/api/tabs), and the server does not switch to another pass while one does.
  const TAB = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  const S = {
    config: null, catalog: [], byId: new Map(), sets: [], set: null, meta: null, readOnly: null,
    frames: [], rows: new Map(), frameIdx: 0, img: null, pixels: null, issueCache: new Map(), stripShown: null,
    altEdge: null, // Alt held over an edge of the selected box: {id, k}, drawn highlighted
    // point mode
    pIdx: 0,
    // corner / training mode
    selId: null, selCorner: null, placing: null, drag: null, snapOn: true, undo: new Map(), prefill: null, prefillSizes: null,
    view: { s: 1 }, mouse: null,
    // box mode: extra selected ids (multi-select; S.selId is the primary, "last clicked"),
    // the boxes being adjusted before Enter confirms them, a mouse gesture in progress, redo
    // stacks, the clipboard (one slot, across frames and sets), the arrow-nudge burst, n-mode,
    // snap mode, carry-over, the default box, the origin of tool-made boxes (timing log only)
    extraSel: new Set(), prov: new Set(), bdrag: null, redo: new Map(), clip: null,
    nudge: { at: 0, key: null }, newBoxMode: false, boxSnap: false, carryOn: true, carried: new Set(),
    defaultBox: { w: 110, h: 150 }, defaultFrom: "default", origin: new Map(), lastCreateAt: 0,
    // boxes that were being adjusted when an undo/redo removed them: pending again if they return
    provParked: new Set(),
    // box-mode prefill: keys of detector boxes rejected / brought back by an undo this session, or
    // moved into a kept box (m); the base of a box's last fit or m (boxgeom.fitState)
    rejectedKeys: new Set(), unrejectedKeys: new Set(), mergedKeys: new Set(), fitted: new Map(),
    // frames whose save failed: retried on the next save and on frame change, named in a red banner
    failed: new Map(),
    // identify mode: the walk (fixed at set open) and the position in it; the zoom view's mapping
    idq: [], qIdx: 0, idView: null,
    // identify mode's top-edge turns: the edge Alt points at in the zoom view, the
    // pointer there, and per frame the server's geometry of each box turned since its last save
    // (a refused save puts it back, answers kept)
    idAltK: null, idMouse: null, idTurnBase: new Map(),
    // picker
    picker: { query: "", scope: "decklist", hl: { g: 0, t: 0 }, list: null, grid: [] }, deckIds: [], decklists: [],
    filters: {},
    hoverArt: true, hoverKey: null,
    stackView: false, // the stacking view (O): a visual aid, never saved
    besideArmed: null, // D was pressed: the context it was armed in (KR.armedFor); the next arrow there adds a box beside the selected one
    // timing: the event queue (timinglog.js; each event keeps the set it was logged in), when the
    // picker was opened (box mode's `identified` carries the time to the pick)
    snaps: new Map(), timing: null, shownKey: null, pickerOpenedAt: null,
    saveTimer: null, saving: 0,
    // review walk (box mode): on/off, the ignored boxes in or out, the position per set
    // (memory only), the boxes turned per set, each frame's order while walked, the box shown
    // ({frame, id, idx}), the zoom view's mapping, the edge Alt points at, the view of a deleted box
    review: { on: false, includeIgnore: false, pos: new Map(), turned: new Map(), cache: new Map(), cur: null,
      view: null, mouse: null, altK: null, gapView: null },
    // center mode: the selected marker, a press/drag in progress, the hovered marker,
    // undo / redo stacks per frame (snapshots of `centers`; `centerSeq` is never rolled back)
    csel: null, cdrag: null, chover: null, cundo: new Map(), credo: new Map(),
    // verify mode: the walk ([{frame, id}]) and the position in it, the server's
    // per-center info ("frame#id" → {blind, sha, arms?}), the centers revealed this session, when
    // the current one was shown, backs in the walk, the crop window level
    vq: [], vIdx: 0, vInfo: new Map(), vRevealed: new Set(), vShownAt: 0, vIncludeBacks: false, vZoom: 0,
    // the page around the editor: a frame picture that did not load ({name, src, path}), whether
    // the server answers, the finish card on show, the keys overlay, the Names pass's count per
    // set (set id → {done, total}), whether each card of the Names pass starts in the search box
    imgFailed: null, connected: true, finish: null, helpOpen: false, named: new Map(), searchFirst: false,
    // the tool was started again on other work while this page held changes: nothing more is saved
    otherRun: false, switching: false,
  };
  const $ = (id) => document.getElementById(id);
  const OUTCOME_LABEL = { card: "card", "card-back": "card back", "not-card": "not a card", unreadable: "cannot be read" };
  // Every color drawn on a frame comes from theme.css (its second block), read once at start.
  const T = {};
  const THEME = { model: "--line-model", kept: "--line-kept", confirmed: "--line-confirmed", back: "--line-back", ignored: "--line-ignored",
    cross: "--line-cross", adjusting: "--line-adjusting", selected: "--line-selected", open: "--line-open", notCard: "--line-not-card",
    target: "--mark-target", top: "--mark-top", flag: "--mark-flag", first: "--mark-first", second: "--mark-second",
    void: "--frame-void", halo: "--frame-halo", faint: "--frame-faint", ink: "--ink-strong" };
  const OUTCOME_COLOR = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of Object.keys(THEME)) T[k] = cs.getPropertyValue(THEME[k]).trim() || "white";
    Object.assign(OUTCOME_COLOR, { card: T.confirmed, "card-back": T.back, "not-card": T.notCard, unreadable: T.open });
    Object.assign(CENTER_COLOR, { face: T.confirmed, back: T.back });
    ARM_COLORS.splice(0, ARM_COLORS.length, T.first, T.second);
  }
  const PREVIEW_W = 314; // CSS px: the small pictures at the top of the side panel
  const VIS = ["full", "most", "half", "little"];
  const SRC = ["current-frame", "later-close-up", "decklist", "other"];
  const HANDLE_PX = 9; // screen px: corner handle / rotate knob hit radius
  const EDGE_PX = 6; // screen px: edge-resize band
  const KNOB_PX = 24; // screen px: rotate knob above the top edge
  const DRAG_PX = 4; // screen px: under this a gesture is a click
  const ALT_EDGE_PX = 10; // screen px: Alt+click this near an edge of the selected box makes it the top
  const REVIEW_EDGE_PX = 22; // view px: the same in the review walk's zoom view
  const REVIEW_FILL = 0.6; // the review zoom fits the box in this share of the view (room for the TOP arrow)
  const HISTORY_CAP = 100;
  const LS = { filters: "labeler-picker-filters", hover: "labeler-hover-art", carry: "labeler-carry-over", defaultBox: "labeler-default-box", boxesOnly: "labeler-boxes-only", verifyBacks: "labeler-verify-backs", searchFirst: "labeler-search-first" };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }

  // ---- boot -------------------------------------------------------------------------------

  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }

  async function boot() {
    if (!G || !BE0 || !Tools || !Filters || !Picker || !Names || !TL || !U || !KR || !SG || !BS) {
      // a serve.py older than this page serves it but 404s some of its scripts
      const b = $("banner");
      b.hidden = false;
      b.textContent = "This page is newer than the running serve.py, which does not serve all of its scripts. Restart serve.py (Ctrl+C, then the same command) and reload. Nothing is loaded or saved until then.";
      return;
    }
    readTheme();
    S.timing = TL.createQueue({ post: postTiming, beacon: beaconTiming, onChange: renderSaveBanner, extra: () => ({ run: S.config ? S.config.run : null }) });
    S.config = await getJSON("/api/config");
    if ((S.config.pageApi || 1) < PAGE_API) {
      // a serve.py started before an update: new page files from disk, old Python in memory
      const b = $("banner");
      b.hidden = false;
      b.textContent = "This page is newer than the running serve.py. Restart serve.py (Ctrl+C, then the same command) and reload. Nothing is loaded or saved until then.";
      return;
    }
    if (S.config.mode === "center" && !C) {
      const b = $("banner");
      b.hidden = false;
      b.textContent = "This pass needs a script that the running serve.py does not serve. Restart serve.py (Ctrl+C, then the same command) and reload.";
      return;
    }
    if (S.config.mode === "verify" && (!V || !S.config.verify)) {
      const b = $("banner");
      b.hidden = false;
      b.textContent = "This pass needs a newer serve.py than the one running. Restart serve.py (Ctrl+C, then the same command) and reload.";
      return;
    }
    if (["identify", "verify", "point"].includes(S.config.mode)) Names.arrangePanes(document, S.config.mode); // two panes (names.js)
    S.snapOn = !!S.config.snap;
    S.catalog = await getJSON("/api/catalog");
    S.facets = await getJSON("/api/facets");
    S.byId = new Map(S.catalog.map((c) => [c.id, c]));
    S.roots = V ? V.printingRoots(S.catalog) : {}; // which cards are one card, under the catalog's rule "printing"
    S.sets = await getJSON("/api/sets");
    loadPrefs();
    await loadNamedCounts();
    const sel = $("setSelect");
    sel.innerHTML = "";
    for (const s of S.sets) {
      const o = document.createElement("option");
      o.value = s.setId;
      o.textContent = setLabel(s);
      sel.appendChild(o);
    }
    // the choice is made: the keys go back to the frame (a menu left in focus would take letters).
    // Opening the set moves the focus about; once it has opened, a person who came to the menu
    // with the keyboard is still at the menu for the next Tab (keyroute.js, tabFrom).
    sel.addEventListener("change", async () => {
      const opened = openSet(sel.value);
      focusEditor();
      await opened;
      const a = document.activeElement;
      const focus = KR.focusKind(a && a !== document.body ? { tag: a.tagName, type: a.type, editable: a.isContentEditable } : null);
      if (KR.tabFrom({ focus, onFrame: a === $("frameCanvas") }) === "menu") { sel.focus({ preventScroll: true }); sel.blur(); }
    });
    let start = lsGet("labeler.set");
    if (!S.sets.some((s) => s.setId === start)) start = S.sets[0] && S.sets[0].setId;
    wireUi();
    renderSaveState();
    $("passName").textContent = U.passName(S.config.mode);
    if (start) { sel.value = start; await openSet(start); } else showNoWork();
    renderKeys();
    setInterval(flushTiming, 3000);
    setInterval(heartbeat, HEARTBEAT_MS);
    window.addEventListener("beforeunload", () => { flushSavesBeacon(); flushTiming(true); });
    window.addEventListener("pagehide", () => flushTiming(true)); // whichever comes; the second finds nothing left
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushTiming(); });
  }

  // What a set has done, in the unit of the pass: frames, names (the Names pass) or centers
  // checked (Check names). The top bar, the set menu and the finish card all read this.
  function setCounts(s) {
    if (s.verify) return { unit: "checked", done: s.verify.verified, total: s.verify.total };
    if (S.config.mode === "identify") {
      const c = S.named.get(s.setId);
      return c ? { unit: "named", done: c.done, total: c.total } : { unit: "named", done: 0, total: null };
    }
    return { unit: "frames", done: s.labeled, total: s.frames.length };
  }
  function setLabel(s) { return U.setLabel({ setId: s.setId, channel: s.channel, readOnly: s.readOnly, removed: s.removed, counts: setCounts(s) }); }

  // The Names pass: how many boxes of each set still wait for a name (the server's walk of the
  // set, as it stands on disk; how many were named before is not known here, and not shown).
  // The open set is counted from the page's own rows instead.
  async function loadNamedCounts() {
    if (S.config.mode !== "identify") return;
    for (const s of S.sets) {
      if (S.set && s.setId === S.set.setId) continue;
      try {
        const q = await getJSON(`/api/identify-queue/${encodeURIComponent(s.setId)}`);
        S.named.set(s.setId, { done: 0, total: q.readOnly ? null : (q.queue || []).length });
      } catch (e) { /* the menu shows no count for this set */ }
    }
  }

  // The live counts of the open set, written back into the list every display reads.
  function syncCounts() {
    if (!S.set) return;
    if (mode() === "identify") {
      const open = S.idq.filter((e) => needsIdentity(e)).length;
      S.named.set(S.set.setId, { done: S.idq.length - open, total: S.idq.length });
    } else if (mode() === "verify" && S.set.verify) {
      const c = verifyCounts();
      Object.assign(S.set.verify, { verified: c.verified, total: c.total, open: c.total - c.verified });
    } else {
      S.set.labeled = S.frames.filter((f) => (S.rows.get(f.name) || {}).done).length;
    }
    const o = [...$("setSelect").options].find((x) => x.value === S.set.setId);
    const text = setLabel(S.set);
    if (o && o.textContent !== text) o.textContent = text;
  }

  function refreshSetMenu() {
    const sel = $("setSelect");
    for (const s of S.sets) {
      const o = [...sel.options].find((x) => x.value === s.setId);
      if (o) o.textContent = setLabel(s);
    }
  }

  function loadPrefs() {
    try { localStorage.removeItem(LS.filters); } catch (e) { /* filters are no longer kept */ }
    S.hoverArt = lsGet(LS.hover) !== "off";
    S.carryOn = lsGet(LS.carry) !== "off";
    S.boxesOnly = lsGet(LS.boxesOnly) !== "off"; // box pass = boxes only, names in the identity pass
    S.vIncludeBacks = lsGet(LS.verifyBacks) === "on";
    S.searchFirst = lsGet(LS.searchFirst) === "on";
  }

  async function openSet(setId) {
    if (S.set && mode() === "box") confirmBox();
    await flushSave();
    if (S.set && S.failed.size) { // never leave a set with frames that did not save
      $("setSelect").value = S.set.setId;
      setStatus("This set has frames that are not saved yet (see the banner). They must save before you switch sets.");
      return;
    }
    hideFinish();
    setStatus(""); // a note from the previous set must not stay
    await flushTiming();
    S.img = null; S.imgFailed = null; S.frameIdx = 0; S.picker.fresh = true;
    const p = await getJSON(`/api/labels/${encodeURIComponent(setId)}`);
    S.set = S.sets.find((s) => s.setId === setId);
    if ($("setSelect").value !== setId) $("setSelect").value = setId;
    S.meta = p.meta || p.effectiveMeta;
    S.readOnly = p.readOnly;
    const frameNames = new Set(S.set.frames.map((f) => f.name));
    S.idq = (p.identifyQueue || []).filter((e) => frameNames.has(e.frame));
    S.qIdx = 0;
    S.deckIds = (p.decklist && p.decklist.ids) || [];
    S.decklists = (p.decklist && p.decklist.lists) || [];
    S.prov = new Set(); S.bdrag = null; S.extraSel = new Set(); S.newBoxMode = false;
    S.picker.scope = S.deckIds.length ? "decklist" : "all";
    S.frames = S.set.frames.slice().sort((a, b) => (a.t || 0) - (b.t || 0));
    if (!S.frames.length) {
      showNoWork(S.set.removed ? `Every frame of the set ${setId} was removed from the project. The project screen lists them, and Restore brings one back.` : `The set ${setId} lists no frames.`);
      return;
    }
    S.rows = new Map(p.frames.map((fr) => [fr.name, fr]));
    S.undo = new Map(); S.redo = new Map();
    S.snaps = new Map(); S.origin = new Map(); S.carried = new Set(); S.provParked = new Set();
    S.rejectedKeys = new Set(); S.unrejectedKeys = new Set(); S.mergedKeys = new Set(); S.fitted = new Map();
    S.csel = null; S.cdrag = null; S.chover = null; S.cundo = new Map(); S.credo = new Map();
    S.prefill = null; S.prefillSizes = null;
    if (S.config.prefill && !S.readOnly) {
      try {
        const pf = await getJSON(`/api/prefill/${encodeURIComponent(setId)}`);
        S.prefill = pf.frames; S.prefillSizes = pf.sizes || null;
      } catch (e) { S.prefill = null; S.prefillSizes = null; }
    }
    // commit snapshots of what is already labeled, so a later change counts as a correction
    // (an unreviewed detector box is not committed yet: its accept logs the commit)
    for (const fr of p.frames) for (const t of items(fr)) if (complete(t) && !(t.pending && t.prefill && setModeOf(p) === "box")) S.snaps.set(key(fr.name, t), answerSig(t));
    lsSet("labeler.set", setId);
    const b = $("banner");
    const notes = [];
    if (p.decklist && p.decklist.unresolved.length && S.catalog.length) notes.push(`Deck list lines that match no card of the catalog: ${p.decklist.unresolved.join(" · ")}`);
    b.hidden = !notes.length;
    b.textContent = notes.join("   |   ");
    const m = S.meta || {};
    // where you are: the pass (in words), what the labels are for, and what the pass works on
    $("passName").textContent = U.passName(mode());
    $("passName").title = U.passWhat(mode());
    $("modeBadge").textContent = [U.roleName(m.role), m.repeatOf ? `repeat of ${m.repeatOf.set}` : null,
      mode() === "verify" ? (verifyArms().length ? `comparing ${verifyArms().join(" and ")}` : "no suggestions") : null,
      S.readOnly ? "read-only" : null].filter(Boolean).join(" · ");
    $("modeBadge").title = `What these labels are for: ${U.roleName(m.role)} (--role ${m.role || "?"}). Enlarged views use ${m.zoom || "?"}× the frame's size.`;
    $("modeBadge").className = `badge ${m.role || ""}`;
    document.body.classList.toggle("center-mode", mode() === "center");
    document.body.classList.toggle("verify-mode", mode() === "verify");
    document.body.classList.remove("no-work");
    $("notice").hidden = true;
    $("deckNote").textContent = S.deckIds.length
      ? S.decklists.map((d) => `Deck list ${d.label}: ${d.ids.length} cards (${d.file.split("/").pop()})`).join("  |  ")
      : S.catalog.length ? "No deck list for this video: the list shows every card." : "No catalog was given, so no card can be named (start the server with --catalog FILE).";
    loadDefaultBox();
    renderRecording();
    renderFilters();
    renderPicker();
    renderKeys();
    renderToolbar();
    renderFrameStrip();
    if (S.review.on && !reviewAllowed()) S.review.on = false; // another set's mode or a read-only set
    S.review.cache = new Map(); S.review.cur = null; S.review.gapView = null; S.review.altK = null;
    renderToolbar();
    applyStage();
    $("eligTitle").textContent = `Selected ${mode() === "box" ? "box" : "card"}, enlarged ${m.zoom || "?"}×`;
    logEvent({ ev: "session-open" });
    if (mode() === "identify") {
      const k = S.idq.findIndex((e) => needsIdentity(e));
      if (S.idq.length) { await gotoQueue(k < 0 ? 0 : k); return; }
    }
    if (mode() === "verify") {
      S.vInfo = new Map(Object.entries((p.verify && p.verify.centers) || {}));
      verifyBuild();
      const k = S.vq.findIndex(vOpen);
      await verifyGo(k < 0 ? 0 : k);
      if (S.vq.length && k < 0) setStatus("Every card of this set is checked. ← and → look back.");
      return;
    }
    // first frame with work left
    let idx = S.frames.findIndex((f) => !(S.rows.get(f.name) || {}).done);
    await gotoFrame(idx < 0 ? 0 : idx, mode() === "point" ? "first-open" : null);
    if (reviewOn()) await reviewEnter(); // the review stays on across the set menu
  }

  // The page's mode: the set's own mode, except that an identify server shows its editable
  // (box/corner/training) sets as an identity pass.
  function mode() {
    // verify: a pass over an editable center set; anything else opens read-only
    if (S.config.mode === "verify") return S.meta && S.meta.mode === "center" && !S.readOnly ? "verify" : (S.meta && S.meta.mode) || "center";
    if (S.config.mode === "identify" && !S.readOnly && S.meta && S.meta.mode !== "point") return "identify";
    return (S.meta && S.meta.mode) || S.config.mode;
  }
  function setMode() { return (S.meta && S.meta.mode) || S.config.mode; } // geometry format of the set
  function setModeOf(p) { return ((p.meta || p.effectiveMeta || {}).mode) || S.config.mode; }
  function role() { return (S.meta && S.meta.role) || S.config.role; }
  function zoomStage() { return (mode() === "point") || mode() === "identify" || mode() === "verify"; }
  function isBoxTarget(t) { return !!t && (t.cornerSource === "box" || setMode() === "box"); }
  function zoom() { return (S.meta && S.meta.zoom) || S.config.zoom || 3; }
  // What savegate.js reads: is the set read-only, did the picture of the frame on the page not
  // load, is the tool that answers another run doing other work.
  function gateState() { return { readOnly: !!S.readOnly, noPicture: S.imgFailed ? S.imgFailed.name : null, otherRun: !!S.otherRun }; }
  // May the frame on the page be changed now? Every control and every key asks this first.
  function editable() { return SG.mayEdit(gateState()).ok; }
  // The set takes saves at all, whatever frame is on the page (a save that waits belongs to
  // another frame; the working-time log and the recording's tags belong to the set).
  function writable() { return !S.readOnly; }

  // ---- frames -------------------------------------------------------------------------------

  function currentFrame() { return S.frames[S.frameIdx]; }

  function rowFor(frame) {
    let row = S.rows.get(frame.name);
    if (!row) {
      row = { name: frame.name, t: frame.t, done: false };
      if (mode() === "point") row.points = [];
      else if (mode() === "center") { row.centers = []; row.centerSeq = 0; }
      else row.targets = [];
      S.rows.set(frame.name, row);
    }
    return row;
  }

  function items(row) { return (row && (row.points || row.targets)) || []; }
  function key(name, t) { return `${name}#${t.id !== undefined ? t.id : t.i}`; }
  // a model's box by its proposal (an id can be given again to another box once this one is gone)
  function pkey(name, t) { return t.prefill && typeof t.prefill.i === "number" ? `${name}#p${t.prefill.i}` : key(name, t); }

  async function gotoFrame(idx, pointPos) {
    if (!S.frames.length) return;
    idx = Math.max(0, Math.min(S.frames.length - 1, idx));
    S.besideArmed = null; // D's arrow belongs to the frame it was pressed on
    if (mode() === "box") { confirmBox(); S.bdrag = null; S.newBoxMode = false; S.extraSel = new Set(); setStatus(""); }
    if (mode() === "center") { S.csel = null; S.cdrag = null; S.chover = null; }
    hideHoverPreview();
    closePrintingEditor();
    S.busy = true;
    try { await flushSave(); } catch (e) { /* the save reports its own error */ }
    S.frameIdx = idx;
    S.selId = mode() === "identify" ? (pointPos || null) : null;
    S.selCorner = null; S.placing = null;
    const f = currentFrame();
    await loadImage(frameSrc(f), f.name);
    S.busy = false;
    renderToolbar(); // the controls that change a frame follow the picture: off while it is missing
    if (S.imgFailed) { // no picture: nothing of this frame is touched, offered or saved
      S.imgFailed.row = JSON.stringify(S.rows.get(f.name) || null); // the row as it is stored, to put back
      render();
      return;
    }
    const row = rowFor(f);
    if (mode() !== "verify") { row.frameW = S.img.naturalWidth; row.frameH = S.img.naturalHeight; } // verify never touches the clicked centers
    if (mode() === "point") {
      if (!row.points || !row.points.length) {
        const g = await getJSON(`/api/points/${encodeURIComponent(S.set.setId)}/${encodeURIComponent(f.name)}?t=${f.t}`);
        row.points = g.points.map((p) => ({ i: p.i, x: p.x, y: p.y }));
      }
      if (pointPos === "last") S.pIdx = row.points.length - 1;
      else if (pointPos === "first") S.pIdx = 0;
      else { const k = row.points.findIndex((p) => !complete(p)); S.pIdx = k < 0 ? 0 : k; }
    } else if (mode() === "training" && S.prefill && !row.done && !row.prefillOffered && !items(row).length && editable()) {
      const props = prefillFor(f.name) || [];
      const ids = G.newTargetIds(row.targets, props.length, "Q");
      row.targets = props.map((p, n) => ({
        id: ids[n], corners: p.corners.map((c) => [c[0], c[1]]), estimated: [false, false, false, false],
        outcome: p.cardId ? "card" : null, identity: p.cardId || null, identitySource: p.cardId ? "other" : null,
        eligible: null, conditions: {}, labelSource: null, pending: true, cornerSource: "prefill",
        prefill: { cardId: p.cardId || null, corners: p.corners, sim: p.sim, margin: p.margin, flag: p.flag, top5: p.top5 },
      }));
      row.prefillOffered = true;
      if (row.targets.length) { logEvent({ ev: "prefill-offered", n: row.targets.length }); scheduleSave(); }
    } else if (mode() === "box") {
      tryCarryOver(idx);
      offerBoxPrefill(row, f);
      loadDefaultBox(); // the model's boxes scale to this frame's size; the finished frames may be more now
    }
    render();
    markShown();
  }

  // A frame's prefill proposals, scaled from the pixel space their record was written in (its
  // own frameW x frameH) to the frame the page shows; null when the file has no record for it.
  function prefillFor(name) {
    const props = S.prefill ? S.prefill[name] : null;
    if (!Array.isArray(props)) return null;
    const size = S.prefillSizes && S.prefillSizes[name];
    if (!size) return props;
    const [W, H] = frameSize();
    return props.map((p) => G.scaleProposal(p, size, W, H));
  }

  function frameSrc(f) { return `/frames/${encodeURIComponent(S.set.frameAsset)}/${encodeURIComponent(f.name)}`; }

  // A frame's picture. One that does not load is remembered (S.imgFailed) with the file the
  // server looked for, and the frame cannot be labeled or confirmed until it loads.
  function loadImage(src, name) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { S.img = img; S.imgFailed = null; S.pixels = null; resolve(); };
      img.onerror = async () => {
        S.img = img; S.pixels = null;
        S.imgFailed = { name, src, path: null, why: "the server did not answer" };
        try { // the server's answer names the file it looked for
          const r = await fetch(src, { cache: "no-store" });
          const j = r.ok ? {} : await r.json().catch(() => ({}));
          S.imgFailed.path = j.path || null;
          S.imgFailed.why = r.ok ? "the file is not a picture this browser can show" : r.status === 404 ? "there is no such file" : `the server answered ${r.status}`;
        } catch (e) { /* the server is not running: the connection indicator says so */ }
        resolve();
      };
      img.src = src;
    });
  }

  // The primary button of a frame whose picture did not load.
  async function reloadFrame() {
    if (!S.set || S.busy) return;
    await gotoFrame(S.frameIdx, mode() === "identify" ? S.selId : null);
  }

  function framePixels() {
    if (S.pixels) return S.pixels;
    const img = S.img;
    if (!img || !img.naturalWidth) return null;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    S.pixels = { data: d.data, width: c.width, height: c.height, channels: 4 };
    return S.pixels;
  }

  // ---- label state helpers -----------------------------------------------------------------

  // box mode: a box is complete once drawn (an outcome; identity and eligibility optional there).
  // Every other mode: an outcome, and for a card an identity and an eligibility.
  function complete(t) {
    if (!t || !["card", "card-back", "not-card", "unreadable"].includes(t.outcome)) return false;
    if (mode() === "box") return true;
    if (t.outcome === "card") return !!t.identity && ["yes", "no", "uncertain"].includes(t.eligible);
    return true;
  }

  function needsIdentity(e) {
    const row = S.rows.get(e.frame);
    const t = row && (row.targets || []).find((x) => x.id === e.target);
    if (!t || !(t.outcome === null || t.outcome === undefined || t.outcome === "card") || t.ignore) return false;
    // open = no identity yet, or a named card (not unknown) with no y/n/m answer: mirrors
    // labelcore.needs_identity / needs_readability, so the walk never skips an unanswered card
    return !t.identity || (t.identity !== "unknown" && (t.eligible === null || t.eligible === undefined));
  }

  // what counts as a change for the correction log: answers and geometry, not the condition tags.
  // Box mode: not the identity either. Naming a box is not correcting it; it logs its
  // own `identified` event (mutate) instead of a `corrected`.
  // Identify mode: not the corners either. The pass may only turn a box's top edge,
  // which logs its own `identify-turned`, never a `corrected`.
  function answerSig(t) {
    const identity = mode() === "box" ? null : t.identity || null;
    const corners = mode() === "identify" ? null : t.corners || null;
    return JSON.stringify([t.outcome || null, identity, t.eligible || null, corners, t.estimated || null, !!t.ignore]);
  }
  function identitySig(t) { return JSON.stringify([t.identity || null, t.printing || null]); }

  // box mode selection: the primary (S.selId, the last clicked) first, then the others
  function selectedIds() {
    if (!S.selId) return [];
    const have = new Set(((rowFor(currentFrame()).targets) || []).map((t) => t.id));
    if (!have.has(S.selId)) return [];
    return [S.selId].concat(Array.from(S.extraSel).filter((id) => id !== S.selId && have.has(id)));
  }
  function isMulti() { return mode() === "box" && selectedIds().length > 1; }
  function selectOnly(id) { S.selId = id; S.extraSel = new Set(); S.selCorner = null; }
  function targetById(row, id) { return (row.targets || []).find((t) => t.id === id) || null; }

  // The selected point/target. In box mode, null while several boxes are selected (the
  // single-box operations do nothing then).
  function selected() {
    const row = rowFor(currentFrame());
    if (mode() === "point") return row.points[S.pIdx] || null;
    if (isMulti()) return null;
    return (row.targets || []).find((t) => t.id === S.selId) || null;
  }

  function noTargetMessage() {
    if (mode() === "point") return "There is no point here.";
    if (isMulti()) return `That works on one box, and ${selectedIds().length} are selected: click one.`;
    return mode() === "box" ? "Select or draw a box first." : "Select a card first, or mark its four corners.";
  }

  // Apply fn to the selected point/target, then bookkeeping: prefill provenance, commit/correction
  // log, save. Returns true when the item became (or stayed) complete.
  function mutate(fn, opts) {
    if (!editable()) return false;
    const row = rowFor(currentFrame());
    const t = selected();
    if (!t) { setStatus(noTargetMessage()); return false; }
    if (mode() !== "point") pushUndo(row);
    const idBefore = identitySig(t);
    fn(t);
    if (mode() === "box" && t.identity && identitySig(t) !== idBefore) logIdentified(row, t, idBefore);
    afterChange(row, t, opts);
    return complete(t);
  }

  // Box mode: a box named (picker, `u`) or its printing changed. `first`: the box had no identity
  // before; `pickerMs`: time since the picker was opened, when the pick came from it.
  function logIdentified(row, t, idBefore) {
    const ev = { ev: "identified", target: t.id, identityKnown: t.identity !== "unknown", identitySource: t.identitySource || null,
      printing: !!t.printing, first: JSON.parse(idBefore)[0] === null };
    if (S.pickerOpenedAt) { ev.pickerMs = Date.now() - S.pickerOpenedAt; S.pickerOpenedAt = null; }
    logEvent(ev);
  }

  function afterChange(row, t, opts) {
    // a box flagged "fix top" (boxFix {reason: "top", angle}) is cleared once its angle changes
    if (t && t.boxFix && typeof t.boxFix === "object" && t.boxFix.reason === "top" && (t.angle || 0) !== t.boxFix.angle) delete t.boxFix;
    if (setMode() === "box" && t.prefill) {
      // box-mode prefill: the review provenance is set when the box is committed (logCommit),
      // never by the identity pass
    } else if (t.pending !== undefined || t.prefill) {
      // training: provenance against the proposal (identity/outcome/corners changed ⇒ corrected)
      // accepted = the proposal's identity and corners kept as they were; anything else (a
      // proposal without an identity, a changed identity/outcome, a moved corner) = corrected
      const p = t.prefill;
      const same = !!(p && p.cardId) && t.outcome === "card" && t.identity === p.cardId
        && JSON.stringify(t.corners) === JSON.stringify(p.corners);
      if (complete(t)) { t.labelSource = same ? "prefill-accepted" : "prefill-corrected"; delete t.pending; }
    } else if (!t.labelSource) {
      t.labelSource = "manual";
    }
    // a box being adjusted is committed (or corrected) when Enter confirms it, not on each nudge
    if (!(mode() === "box" && S.prov.has(t.id))) logCommit(row, t);
    if (mode() === "point") row.done = row.points.length > 0 && row.points.every(complete);
    else if (mode() !== "identify" && row.done && !items(row).every(complete)) row.done = false;
    scheduleSave();
    render();
    if (opts && opts.advance && complete(t)) advance();
  }

  // extra.via (box-mode prefill): how a detector box was accepted (a, enter, frame-enter)
  function logCommit(row, t, extra) {
    if (!complete(t)) return;
    if (mode() === "box" && t.prefill) finalizePrefill(t); // reviewed: accepted or corrected
    const k = key(row.name, t);
    const sig = answerSig(t);
    const base = { target: t.id !== undefined ? t.id : t.i, outcome: t.outcome, eligible: t.eligible || null };
    if (mode() === "identify" && t.outcome === "card") base.identityKnown = t.identity !== "unknown";
    if (mode() === "box") base.ignore = !!t.ignore;
    if (extra && extra.via) base.via = extra.via;
    if (!S.snaps.has(k)) {
      S.snaps.set(k, sig);
      const origin = S.origin.get(k) || (mode() === "box" && t.prefill ? "prefill" : null);
      logEvent(Object.assign({ ev: "committed", labelSource: t.labelSource }, origin ? { origin } : {}, base));
    } else if (S.snaps.get(k) !== sig) {
      S.snaps.set(k, sig);
      // provenance records edits made in the geometry pass; an identity answer does not change it
      if (mode() !== "identify") G.editProvenance(t, setMode() === "box"); // the Names pass records its edits itself (namesEditEnd)
      if (mode() === "box") base.origin = originOf(row, t);
      logEvent(Object.assign({ ev: "corrected", labelSource: t.labelSource }, base));
    }
  }

  // Where a box came from, for the timing log's corrections: drawn (the default; "snap" and
  // "default-box" are drawn by a click), paste / duplicate / insert, carried, propagated, prefill.
  function originOf(row, t) {
    const o = S.origin.get(key(row.name, t));
    if (o) return o;
    const ls = String(t.labelSource || "");
    if (ls.startsWith("carried")) return "carried";
    if (ls.startsWith("propagated")) return "propagated";
    if (ls.startsWith("prefill")) return "prefill";
    return "drawn";
  }

  // ---- point mode ---------------------------------------------------------------------------

  function advance() {
    if (mode() === "identify") { nextInQueue(); return; }
    const row = rowFor(currentFrame());
    // point mode: a frame whose points are all answered is finished at once, never looped over
    //: go to the next frame or set with points left and say so
    if (mode() === "point" && pointsComplete(row)) { finishPointFrame(); return; }
    if (S.pIdx < row.points.length - 1) { S.pIdx++; render(); markShown(); return; }
    nextUnlabeled();
  }

  function pointsComplete(row) { return !!(row && row.points && row.points.length && row.points.every(complete)); }

  async function finishPointFrame() {
    return finishFrame((r) => !pointsComplete(r) && !(r && r.done), {
      frame: () => "Frame done. This is the next frame with points left.",
      set: (prev, next) => `${prev} is done: every point is answered. This is ${next}.`,
      all: (prev) => `${prev} is done. Every frame of every set is answered.`,
    });
  }

  // A frame is finished: go to the next frame of this set with work left (`left(row)`), else the
  // next set (menu order) with frames left, and say so (point mode's auto-advance; center mode's
  // after Enter).
  async function finishFrame(left, msg) {
    await flushSave();
    const doneName = currentFrame() ? currentFrame().name : "";
    for (let k = 1; k < S.frames.length; k++) { // another frame of this set with work left
      const idx = (S.frameIdx + k) % S.frames.length;
      const r = S.rows.get(S.frames[idx].name);
      if (left(r)) { await gotoFrame(idx); setStatus(msg.frame(doneName)); return; }
    }
    // this set is done: the next set (menu order) with frames left
    const prev = S.set.setId;
    try { S.sets = await getJSON("/api/sets"); } catch (e) { /* keep the old list */ }
    const sel = $("setSelect");
    for (const s of S.sets) {
      const o = [...sel.options].find((x) => x.value === s.setId);
      if (o) o.textContent = setLabel(s);
    }
    const i0 = S.sets.findIndex((s) => s.setId === prev);
    for (let k = 1; k <= S.sets.length; k++) {
      const s = S.sets[(i0 + k) % S.sets.length];
      if (s.setId !== prev && !s.readOnly && s.labeled < s.frames.length) {
        sel.value = s.setId; await openSet(s.setId);
        setStatus(msg.set(prev, s.setId)); return;
      }
    }
    setStatus(msg.all(prev));
    render();
    if (!S.failed.size) await showFinish();
  }

  async function nextUnlabeled() {
    for (let k = 1; k <= S.frames.length; k++) {
      const idx = (S.frameIdx + k) % S.frames.length;
      const row = S.rows.get(S.frames[idx].name);
      if (!row || (!row.done && !(mode() === "point" && pointsComplete(row)))) { await gotoFrame(idx); return; }
    }
    if (mode() === "point") { finishPointFrame(); return; }
    setStatus("Every frame of this set is done.");
    render();
  }

  function markShown() {
    if (mode() === "verify") { verifyShown(); return; }
    if (mode() === "identify") {
      const t = selected();
      const k = t && key(currentFrame().name, t);
      if (k && k !== S.shownKey) { S.shownKey = k; logEvent({ ev: "shown", target: t.id }); }
    } else if (mode() === "point") {
      const t = selected();
      const k = t && key(currentFrame().name, t);
      if (k && k !== S.shownKey) { S.shownKey = k; logEvent({ ev: "shown", target: t.i }); }
    } else {
      const k = `frame:${currentFrame().name}`;
      if (k !== S.shownKey) { S.shownKey = k; logEvent({ ev: "shown" }); }
    }
  }

  function setOutcome(outcome) {
    if (zoomStage()) clearSearch(outcome); // every answer clears the search (names.js)
    mutate((t) => {
      t.outcome = outcome;
      if (outcome !== "card") { t.identity = null; t.printing = null; t.identitySource = null; }
      if (outcome === "card-back") { t.eligible = "no"; setCond(t, "faceUp", false); }
      if (outcome === "unreadable") t.eligible = "no";
      if (outcome === "not-card") { t.eligible = null; t.conditions = {}; }
    }, { advance: mode() === "point" || mode() === "identify" });
  }

  function setCond(t, k, v) { t.conditions = Object.assign({}, t.conditions || {}); if (v === null) delete t.conditions[k]; else t.conditions[k] = v; }

  function cycleBool(k) {
    mutate((t) => {
      const v = (t.conditions || {})[k];
      setCond(t, k, v === undefined || v === null ? true : v === true ? false : null);
    });
  }

  function cycleVis() {
    mutate((t) => {
      const v = (t.conditions || {}).visibleShare;
      const i = VIS.indexOf(v);
      setCond(t, "visibleShare", i === VIS.length - 1 ? null : VIS[i + 1]);
    });
  }

  function cycleSource() {
    mutate((t) => { const i = SRC.indexOf(t.identitySource); t.identitySource = SRC[(i + 1) % SRC.length]; });
  }

  function setEligible(v) {
    const t = selected();
    const auto = (mode() === "point" || mode() === "identify") && t && t.outcome === "card" && t.identity;
    mutate((x) => { x.eligible = v; }, { advance: auto });
  }

  function clearAnswer() {
    if (mode() === "identify") { // back to an unanswered card; the box pass's own fields stay
      clearSearch("clear");
      mutate((t) => { for (const k of ["identity", "printing", "identitySource", "eligible"]) delete t[k]; t.outcome = "card"; });
      const row = rowFor(currentFrame());
      S.snaps.delete(key(row.name, selected()));
      render(); return;
    }
    if (mode() === "point") clearSearch("clear");
    mutate((t) => {
      for (const k of ["outcome", "identity", "printing", "identitySource", "eligible", "labelSource"]) delete t[k];
      t.conditions = {};
    });
    const row = rowFor(currentFrame());
    S.snaps.delete(key(row.name, selected()));
  }

  // ---- corner mode --------------------------------------------------------------------------

  // One new target id; boxes added together take theirs from G.newTargetIds in one call, so no
  // two of them get the same id.
  function newTargetId(row, prefix) { return G.newTargetIds(row.targets, 1, prefix || "Q")[0]; }

  // Undo/redo (per frame, in memory only): a snapshot of the frame's targets before every
  // edit; a new edit clears the redo stack.
  function pushUndo(row, snapshot) {
    if (mode() === "point") return;
    const st = S.undo.get(row.name) || [];
    st.push(snapshot || JSON.stringify(row.targets || []));
    if (st.length > HISTORY_CAP) st.shift();
    S.undo.set(row.name, st);
    S.redo.set(row.name, []);
  }

  function undo() { restoreHistory(S.undo, S.redo, "undo"); }
  function redo() { restoreHistory(S.redo, S.undo, "redo"); }

  function restoreHistory(from, to, what) {
    if (!editable() || S.bdrag || S.drag || S.ndrag) return;
    const row = rowFor(currentFrame());
    const st = from.get(row.name) || [];
    if (!st.length) { setStatus(`Nothing to ${what}.`); return; }
    const before = row.targets || [];
    const other = to.get(row.name) || [];
    other.push(JSON.stringify(before));
    if (other.length > HISTORY_CAP) other.shift();
    to.set(row.name, other);
    row.targets = JSON.parse(st.pop());
    if (mode() === "identify") identifyHistoryTurns(row, before, what);
    reconcileLog(row, before);
    const had = new Set(before.map((t) => t.id));
    const back = row.targets.filter((t) => !had.has(t.id));
    if (back.length) selectOnly(back[back.length - 1].id); // the restored box is selected again
    else if (!row.targets.some((t) => t.id === S.selId)) S.selId = null;
    S.extraSel = new Set(Array.from(S.extraSel).filter((id) => row.targets.some((t) => t.id === id)));
    const wasDone = row.done;
    // an unreviewed detector box never sits on a confirmed frame (the server refuses it too);
    // the identity pass never changes a frame's confirmation (the server keeps it anyway)
    if (mode() !== "identify") row.done = row.done && row.targets.every(complete) && !(mode() === "box" && row.targets.some((t) => t.pending));
    if (wasDone && !row.done && mode() === "box") logEvent({ ev: "frame-unconfirmed", n: row.targets.length, via: "history" });
    setStatus(what === "undo" ? "Undone." : "Redone.");
    scheduleSave(); render();
  }

  // After an undo/redo the timing log follows the labels: a committed box that vanished is
  // `deleted`, a box that came back is committed again (carried boxes silently, as on arrival),
  // a committed box whose answer or geometry changed back is `corrected`. Boxes still being
  // adjusted (dashed) are left to their Enter.
  function reconcileLog(row, before) {
    const now = new Set((row.targets || []).map((t) => t.id));
    const had = new Set(before.map((t) => t.id));
    for (const t of before) {
      if (now.has(t.id)) continue;
      const k = key(row.name, t);
      if (S.prov.delete(t.id)) S.provParked.add(k);
      if (t.pending && t.prefill && mode() === "box") { prefillVanished(row, t); continue; }
      if (S.snaps.has(k)) { S.snaps.delete(k); logRemoved(row, t, "history"); }
    }
    for (const t of row.targets || []) {
      const k = key(row.name, t);
      const pendingPrefill = !!(t.pending && t.prefill && mode() === "box");
      if (pendingPrefill && !had.has(t.id)) prefillReturned(row, t);
      if (S.provParked.delete(k)) { S.prov.add(t.id); continue; } // still being adjusted: Enter commits it
      if (pendingPrefill) continue; // not reviewed yet: its accept commits it
      if (S.prov.has(t.id) || !complete(t)) continue;
      if (!S.snaps.has(k) && /^(propagated|carried)/.test(String(t.labelSource || ""))) S.snaps.set(k, answerSig(t));
      else logCommit(row, t);
    }
  }

  function placeCorner(p, estimated) {
    if (!editable()) return;
    if (!S.placing) { S.placing = { corners: [], estimated: [] }; logEvent({ ev: "started" }); }
    S.placing.corners.push([Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
    S.placing.estimated.push(!!estimated);
    if (S.placing.corners.length === 4) finishPlacing();
    render();
  }

  function finishPlacing() {
    const row = rowFor(currentFrame());
    let corners = S.placing.corners, snapped = false;
    const est = S.placing.estimated;
    S.placing = null;
    setStatus("");
    if (QS.signedArea(corners) <= 0) setStatus("These corners run the wrong way round. The order is the card's own top-left, top-right, bottom-right, bottom-left.");
    else if (S.snapOn) ({ corners, snapped } = snapCorners(corners, est));
    pushUndo(row);
    const t = { id: newTargetId(row), corners, estimated: est, cornerSource: snapped ? "snap" : "hand", outcome: null,
      identity: null, identitySource: null, eligible: null, conditions: {}, labelSource: "manual" };
    row.targets.push(t);
    S.selId = t.id; S.selCorner = null;
    afterChange(row, t);
  }

  function snapCorners(corners, est) {
    const px = framePixels();
    if (!px) return { corners, snapped: false };
    const res = QS.refineQuad(px, corners, est);
    if (!res.snapped) { if (res.reason) setStatus(`Snap left your corners as they are (${res.reason}).`); return { corners, snapped: false }; }
    setStatus(`Snapped to the card's edges (a corner moved up to ${Math.max(...res.moved).toFixed(1)} px).`);
    return { corners: res.corners, snapped: true };
  }

  function resnap() {
    mutate((t) => {
      const r = snapCorners(t.corners, t.estimated);
      if (r.snapped) { t.corners = r.corners; t.cornerSource = "snap"; }
    });
  }

  function rotateOrder() {
    mutate((t) => { const r = QS.rotateOrder(t.corners, t.estimated); t.corners = r.corners; t.estimated = r.estimated; });
  }

  function toggleEstimated() {
    if (S.placing && S.placing.estimated.length) {
      const n = S.placing.estimated.length - 1;
      S.placing.estimated[n] = !S.placing.estimated[n];
      render(); return;
    }
    if (S.selCorner === null) { setStatus("Click a corner first."); return; }
    mutate((t) => { t.estimated = (t.estimated || [false, false, false, false]).slice(); t.estimated[S.selCorner] = !t.estimated[S.selCorner]; });
  }

  // Delete the selected target (box mode: every selected box, one undo step).
  function deleteTarget() {
    if (!editable()) return;
    const row = rowFor(currentFrame());
    const ids = mode() === "box" ? selectedIds() : (selected() ? [S.selId] : []);
    if (!ids.length) return;
    pushUndo(row);
    for (const id of ids) {
      const t = targetById(row, id);
      if (!t) continue;
      row.targets = row.targets.filter((x) => x !== t);
      S.snaps.delete(key(row.name, t));
      S.prov.delete(t.id);
      logRemoved(row, t);
    }
    S.selId = null; S.extraSel = new Set();
    if (row.done && !row.targets.every(complete)) row.done = false;
    scheduleSave(); render();
  }

  // Confirm the frame (Enter; the toolbar's Confirmed box confirms in place: advance false).
  async function confirmFrame(opts) {
    if (!editable()) return;
    const advanceAfter = !opts || opts.advance !== false;
    const row = rowFor(currentFrame());
    if (S.placing) { setStatus("Place the remaining corners first, or press Esc to cancel them."); return; }
    if (mode() === "box") {
      confirmBox();
      // suggestions (detector boxes beside carried-over ones) are never accepted by default
      const sugg = row.targets.filter((t) => t.pending && t.suggestion);
      if (sugg.length) {
        selectOnly(sugg[0].id);
        setStatus(`${sugg.length} model ${sugg.length === 1 ? "suggestion" : "suggestions"} left to accept or remove before the frame can be finished.`);
        render(); return;
      }
    }
    const bad = row.targets.filter((t) => !complete(t));
    if (bad.length) {
      S.selId = bad[0].id;
      setStatus(`${bad.length} ${bad.length === 1 ? "card still needs" : "cards still need"} an answer: a name, and whether it can be read.`);
      render(); return;
    }
    if (mode() === "box") {
      const d = G.duplicates(row.targets);
      if (d.length) {
        const [i, j] = d[0];
        selectOnly(row.targets[j].id);
        setStatus("Two boxes are in the same place. One of them is selected: remove it or move it, then finish the frame.");
        render(); return;
      }
    }
    let note = "";
    if (mode() === "box") { // Enter on the frame accepts every untouched detector box as is
      const pend = row.targets.filter((t) => t.pending);
      if (pend.length) {
        pushUndo(row);
        for (const t of pend) logCommit(row, t, { via: "frame-enter" });
        note = `Accepted ${pend.length} model ${pend.length === 1 ? "box" : "boxes"} as ${pend.length === 1 ? "it was" : "they were"} on frame ${S.frameIdx + 1}.`;
      }
    }
    row.done = true;
    logEvent({ ev: "frame-confirmed", n: row.targets.length });
    // re-arm carry-over into the next frame when it is empty and unconfirmed
    const next = S.frames[S.frameIdx + 1];
    const nr = next && S.rows.get(next.name);
    if (next && (!nr || (!nr.done && !(nr.targets || []).length))) S.carried.delete(next.name);
    scheduleSave();
    const last = S.frameIdx === S.frames.length - 1;
    if (advanceAfter) await gotoFrame(S.frameIdx + 1);
    else { await flushSave(); render(); }
    if (note) { const cur = $("status").textContent; setStatus(note + (cur ? " " + cur : "")); }
    // the last frame of the set, and no frame left to do: say what was done and what is next
    if (advanceAfter && last && !S.failed.size && S.frames.every((f) => (S.rows.get(f.name) || {}).done)) await showFinish();
  }

  // Shift+Enter / unticking Confirmed: back to not done, staying on the frame.
  function unconfirmFrame() {
    if (!editable()) return;
    const row = rowFor(currentFrame());
    if (!row.done) { setStatus("This frame is not done yet."); render(); return; }
    row.done = false;
    logEvent({ ev: "frame-unconfirmed", n: (row.targets || []).length });
    setStatus("Frame reopened.");
    scheduleSave(); render();
  }

  function cycleTarget(dir) {
    const ts = rowFor(currentFrame()).targets || [];
    if (!ts.length) return;
    if (mode() === "box") {
      confirmBox();
      const order = G.orderAsc(ts); // Tab walks the stacking order
      const pos = order.findIndex((i) => ts[i].id === S.selId);
      selectOnly(ts[order[(pos + dir + order.length) % order.length]].id);
      render(); return;
    }
    const i = ts.findIndex((t) => t.id === S.selId);
    S.selId = ts[(i + dir + ts.length) % ts.length].id;
    S.selCorner = null;
    render();
  }

  function nextPending() {
    const ts = rowFor(currentFrame()).targets || [];
    const i = ts.findIndex((t) => t.id === S.selId);
    for (let k = 1; k <= ts.length; k++) {
      const t = ts[(i + k + ts.length) % ts.length];
      if (!complete(t)) { S.selId = t.id; render(); return; }
    }
    setStatus("Every card on this frame is complete.");
  }

  // Confirmed frames keep their checks: a confirmed frame that fails Enter's checks after
  // a later edit is flagged amber (header) and counted in the progress line.
  function frameIssues(row) {
    if (!row || !row.done || mode() === "identify" || mode() === "center" || mode() === "verify") return []; // the walk has its own done state
    if (mode() === "box") {
      const d = G.duplicates(row.targets || []);
      return d.length ? [`${d.length === 1 ? "two boxes are" : d.length + " pairs of boxes are"} in the same place`] : [];
    }
    const bad = items(row).filter((t) => !complete(t)).length;
    return bad ? [`${bad} without an answer`] : [];
  }

  // Issues per frame, cached: only the current frame is ever edited, so it alone is recomputed on
  // each render (the strip and the progress line would otherwise re-check every frame per redraw).
  function issuesOf(name, fresh) {
    if (fresh || !S.issueCache.has(name)) S.issueCache.set(name, frameIssues(S.rows.get(name)));
    return S.issueCache.get(name);
  }

  // ---- frame strip: one numbered square per frame (identify mode: per frame of the walk) ----

  function stripFrames() {
    if (mode() !== "identify") return S.frames;
    const names = new Set(S.idq.map((e) => e.frame));
    return S.frames.filter((f) => names.has(f.name));
  }

  function renderFrameStrip() {
    const el = $("frameStrip");
    el.innerHTML = "";
    S.issueCache = new Map();
    const fs = S.set ? stripFrames() : [];
    el.hidden = !fs.length;
    for (const f of fs) {
      const tick = document.createElement("div");
      tick.className = "frame-tick";
      tick.dataset.name = f.name;
      tick.textContent = String(S.frames.indexOf(f) + 1);
      tick.addEventListener("click", () => {
        if (S.busy) return;
        if (mode() === "identify") { const i = S.idq.findIndex((e) => e.frame === f.name); if (i >= 0) gotoQueue(i); }
        else if (mode() === "verify") { const i = S.vq.findIndex((e) => e.frame === f.name); if (i >= 0) verifyGo(i); }
        else if (reviewOn()) reviewGotoFrame(f.name);
        else gotoFrame(S.frames.indexOf(f));
      });
      el.appendChild(tick);
    }
    updateFrameStrip();
  }

  function updateFrameStrip() {
    const el = $("frameStrip");
    if (!el || el.hidden || !S.set) return;
    const cur = currentFrame() && currentFrame().name;
    for (const tick of el.children) {
      const name = tick.dataset.name;
      const f = S.frames.find((x) => x.name === name);
      const row = S.rows.get(name);
      const done = mode() === "identify" ? !S.idq.some((e) => e.frame === name && needsIdentity(e))
        : mode() === "verify" ? !S.vq.some((e) => e.frame === name && vOpen(e)) : !!(row && row.done);
      const issues = issuesOf(name, name === cur);
      const failed = S.failed.get(name);
      // the Names pass and Check names: a frame with some of its cards answered is marked as begun
      const some = !done && (mode() === "identify" ? S.idq.some((e) => e.frame === name && !needsIdentity(e))
        : mode() === "verify" ? S.vq.some((e) => e.frame === name && !vOpen(e)) : false);
      tick.classList.toggle("current", name === cur);
      tick.classList.toggle("done", done);
      tick.classList.toggle("part", some);
      tick.classList.toggle("needs-fix", issues.length > 0);
      tick.classList.toggle("failed", !!failed);
      tick.classList.toggle("unsaved", !failed && S.pendingSave === name);
      const what = mode() === "identify" ? (done ? "every box named" : some ? "some boxes named" : "no box named yet")
        : mode() === "verify" ? (done ? "every card checked" : some ? "some cards checked" : "no card checked yet") : done ? "done" : "not done yet";
      tick.title = `Frame ${S.frames.indexOf(f) + 1}: ${what} (${name}, at ${f ? f.t : "?"} s)`
        + (issues.length ? `. Needs a fix: ${issues.join("; ")}` : "") + (failed ? `. NOT SAVED: ${failed}` : "");
    }
    const curTick = el.querySelector(".frame-tick.current");
    if (curTick && curTick.dataset.name !== S.stripShown) { S.stripShown = curTick.dataset.name; curTick.scrollIntoView({ block: "nearest", inline: "nearest" }); }
  }

  // ---- box mode -----------------------------------------------------------------------------
  // A box is four corners TL, TR, BR, BL of its own (possibly rotated) rectangle with cornerSource
  // "box" (the corner format, so a later mode can refine it); a rotated box also stores `angle`.
  // Drawn by a drag (a click never starts one); it stays "provisional" (dashed) while adjusted and
  // Enter confirms it (the timing log's commit). Drawing the next box, Tab, a click elsewhere or
  // leaving the frame confirms it too.

  function frameSize() { return [S.img && S.img.naturalWidth || 1920, S.img && S.img.naturalHeight || 1080]; }
  function rectOf(t) { return G.rectFromCorners(t.corners, t.angle); }

  // The Boxes pass's geometry edits (boxedit.js), on this page's state.
  const BE = BE0 && BE0.create({ frameSize, framePixels, setStatus, editGeometry, selected, primaryIds, selectedIds, isMulti, editable, noTargetMessage,
    row: () => rowFor(currentFrame()), pushUndo, state: S,
    turnedRect: (t, a) => turnedRect(t, a), fitStateOf: (t) => fitStateOf(t), remember: (...a) => remember(...a), notes: U.NOTES, QS });
  const { setRect, turnTo, turnAllowed, resizeTo, nudgeBox, rotateSel, tapSel, setTopEdgeSel, fitSel, snapQuadSel } = BE || {}; // BE is absent only before the restart banner

  // A new box from a rect (drag, default size, snap, row insert). opts.origin: the timing log's
  // origin of a box the labeler did not draw ("insert"), or of one placed differently ("snap",
  // "default-box": still drawn by hand).
  function createBoxRect(rect, opts) {
    if (!editable()) return null;
    const o = opts || {};
    const row = rowFor(currentFrame());
    const t = { id: newTargetId(row, "B"), corners: null, estimated: [false, false, false, false], cornerSource: "box",
      outcome: "card", identity: null, identitySource: null, eligible: null, conditions: {}, labelSource: "manual" };
    if (o.corners) G.setQuadCorners(t, o.corners); else setRect(t, rect);
    const r = rectOf(t);
    if (r.w < G.MIN_BOX || r.h < G.MIN_BOX) { setStatus(`That box was too small (under ${G.MIN_BOX} px), so it was not drawn.`); render(); return null; }
    if (!o.keepProv) confirmBox();
    if (!o.noUndo) pushUndo(row);
    const z = G.nextZ(row.targets);
    if (z !== null) t.zOrder = z;
    row.targets.push(t);
    selectOnly(t.id);
    S.prov.add(t.id);
    S.lastCreateAt = Date.now();
    if (o.origin) S.origin.set(key(row.name, t), o.origin);
    setStatus(o.status || "Box drawn.");
    afterChange(row, t);
    return t;
  }

  // D then an arrow: a box beside the selected one (boxedit.js besidePlace), of the same kind
  // (card, back or ignored); an upright one is refused when too small (createBoxRect).
  function besideSel(dir) {
    const row = rowFor(currentFrame()), src = selected();
    if (!editable() || !src || !isBoxTarget(src)) { setStatus("Select a box first, then press D and an arrow."); return; }
    const b = BE.besidePlace(src, dir);
    if (b.refused) { setStatus(b.refused); render(); return; }
    const t = createBoxRect(b.rect, b);
    if (!t) return;
    if (src.outcome === "card-back") t.outcome = "card-back";
    if (src.ignore) t.ignore = true;
    if (t.outcome !== "card" || t.ignore) afterChange(row, t);
    render();
  }

  // Confirm the boxes being adjusted: logs each commit (or a correction, if it was reopened and
  // changed). Returns true when there was one.
  function confirmBox() {
    if (!S.prov.size) return false;
    const row = S.frames.length ? rowFor(currentFrame()) : null;
    const ids = Array.from(S.prov);
    S.prov = new Set();
    let any = false;
    for (const id of ids) {
      const t = row && targetById(row, id);
      if (t) { logCommit(row, t); any = true; }
    }
    if (any) scheduleSave();
    render();
    return any;
  }

  // Reopen boxes for adjustment (their commit snapshots stay: Enter logs a correction). Boxes
  // being adjusted that are not among `ids` are confirmed first.
  function reopen(ids) {
    const keep = new Set(ids);
    const row = rowFor(currentFrame());
    for (const id of Array.from(S.prov)) {
      if (keep.has(id)) continue;
      S.prov.delete(id);
      const t = targetById(row, id);
      if (t) { logCommit(row, t); scheduleSave(); }
    }
    for (const id of ids) S.prov.add(id);
  }

  // Geometry edits on the selection (move, resize, rotate, tap, default size, snap, reflow):
  // one undo step, the boxes reopened (dashed) until Enter.
  function editGeometry(ids, fn, opts) {
    if (!editable()) return false;
    const row = rowFor(currentFrame());
    const ts = ids.map((id) => targetById(row, id)).filter(Boolean);
    if (!ts.length) { setStatus(noTargetMessage()); return false; }
    const before = JSON.stringify(row.targets);
    const sig = BE0.geometrySig(ts);
    ts.forEach((t, k) => fn(t, k));
    if (BE0.geometrySig(ts) === sig) { render(); return false; }
    if (!(opts && opts.noUndo)) pushUndo(row, before);
    reopen(ts.map((t) => t.id));
    afterChange(row, ts[0]);
    return true;
  }

  function primaryIds() { const t = selected(); return t ? [t.id] : []; }

  // `e`, "Fit to the tilted card" (boxgeom.fitState / fitRect): one undo step. Turning never
  // changes a box's size; this is the one action that fits a turned model's box to the card.
  const fitRecord = (t) => S.fitted.get(key(currentFrame().name, t));
  const fitStateOf = (t) => G.fitAction(t, fitRecord(t), ...frameSize());
  function remember(t, base, rect) { S.fitted.set(key(currentFrame().name, t), G.fitRecord(fitRecord(t), base, rect || rectOf(t))); }
  const turnedRect = (t, angle) => G.turnRect(t, angle, fitRecord(t), ...frameSize()); // from its exact reference: no drift

  // The box edge near p, for Alt: the selected box's first, else the topmost box with an edge
  // there (Alt+click must work on a box that is not selected, e.g. right after Enter).
  function altEdgeAt(p) {
    if (!p || !editable()) return null;
    const row = rowFor(currentFrame());
    const tol = ALT_EDGE_PX / S.view.s;
    const sel = S.selId ? targetById(row, S.selId) : null;
    const ts = row.targets || [];
    const order = (sel ? [sel] : []).concat(G.orderDesc(ts).map((i) => ts[i]).filter((t) => t !== sel));
    for (const t of order) {
      const k = G.nearestEdgeOf(t, p, tol);
      if (k !== null) return { id: t.id, k };
    }
    return null;
  }

  function setAltEdge(e) {
    const same = (a, b) => (a && b ? a.id === b.id && a.k === b.k : a === b);
    if (!same(e, S.altEdge)) { S.altEdge = e; render(); }
  }

  // `b` / `h`: card back / ignore on or off. With several boxes selected, every one is set to the
  // opposite of the primary's value (the `h`).
  function toggleKind(kind) {
    if (!editable()) return;
    const row = rowFor(currentFrame());
    const ids = selectedIds();
    if (!ids.length) { setStatus("Select a box first."); return; }
    const prim = targetById(row, ids[0]);
    const on = kind === "back" ? prim.outcome !== "card-back" : !prim.ignore;
    pushUndo(row);
    for (const id of ids) {
      const t = targetById(row, id);
      if (!t) continue;
      if (kind === "back") {
        if (on) { t.outcome = "card-back"; t.identity = null; t.printing = null; t.identitySource = null; t.eligible = "no"; setCond(t, "faceUp", false); delete t.ignore; }
        else if (t.outcome === "card-back") { t.outcome = "card"; t.eligible = null; setCond(t, "faceUp", null); }
      } else if (on) { t.ignore = true; t.eligible = "no"; if (t.outcome !== "card") { t.outcome = "card"; setCond(t, "faceUp", null); } }
      else if (t.ignore) { delete t.ignore; if (t.eligible === "no") t.eligible = null; }
      afterChange(row, t);
    }
  }

  function setUnknown() {
    const t = selected();
    if (t && t.outcome === "card-back") { setStatus("A card back has no name. B turns it back into a card."); return; }
    mutate((x) => { x.outcome = "card"; x.identity = "unknown"; x.printing = null; x.identitySource = null; });
  }

  function topBoxAt(p) {
    const ts = rowFor(currentFrame()).targets || [];
    for (const i of G.orderDesc(ts)) if (G.pointInQuad(ts[i].corners, p)) return ts[i];
    return null;
  }

  // Shift+click: add a box to the selection or take it out.
  function toggleInSelection(id) {
    confirmBox();
    const sel = selectedIds();
    if (sel.includes(id)) {
      const rest = sel.filter((x) => x !== id);
      S.selId = rest.length ? rest[rest.length - 1] : null;
      S.extraSel = new Set(rest);
    } else {
      S.extraSel = new Set(sel);
      S.selId = id;
    }
    render();
  }

  // Shift+drag on empty space: add every box whose center is inside the rectangle; the primary
  // becomes the rightmost (`+` inserts at the right end).
  function selectInRect(a, b) {
    confirmBox();
    const ts = rowFor(currentFrame()).targets || [];
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const sel = selectedIds();
    for (const t of ts) {
      const r = rectOf(t);
      if (r.cx >= x0 && r.cx <= x1 && r.cy >= y0 && r.cy <= y1 && !sel.includes(t.id)) sel.push(t.id);
    }
    if (!sel.length) { render(); return; }
    const right = sel.reduce((m, id) => (rectOf(targetById({ targets: ts }, id)).cx > rectOf(targetById({ targets: ts }, m)).cx ? id : m), sel[0]);
    S.selId = right;
    S.extraSel = new Set(sel);
    setStatus(`${sel.length} boxes selected.`);
    render();
  }

  // ---- copy / paste / duplicate (one slot, across frames and sets) --------------------

  function clipFrameKey() { return `${S.set.setId}/${currentFrame().name}`; }

  // Copies the selected box, or every selected box (bottom layer first). A copy that cannot be
  // made empties the clipboard, so a later paste never brings back an older copy.
  function copyBox() {
    const row = rowFor(currentFrame());
    const ids = new Set(selectedIds());
    const ts = G.orderAsc(row.targets || []).map((i) => row.targets[i]).filter((t) => ids.has(t.id) && Array.isArray(t.corners));
    if (!ts.length) { S.clip = null; setStatus(noTargetMessage()); return false; }
    S.clip = ts.map((t) => G.makeClip(t, clipFrameKey()));
    setStatus(ts.length === 1 ? "Box copied." : `${ts.length} boxes copied.`);
    return true;
  }

  function pasteBox(origin) {
    if (!editable() || !S.clip) { if (!S.clip) setStatus(`Nothing copied yet: select a box and press ${CMD}+C.`); return; }
    const row = rowFor(currentFrame());
    const [W, H] = frameSize();
    const clips = S.clip;
    const ids = G.newTargetIds(row.targets, clips.length, "B");
    const z0 = G.nextZ(row.targets);
    const res = G.pasteGroup(clips, clipFrameKey(), W, H, ids, clips.map((_, k) => (z0 === null ? null : z0 + k)), mode() === "box" && S.boxesOnly);
    if (res.refused) { setStatus(res.refused); return; }
    confirmBox();
    pushUndo(row); // one undo takes back the whole paste
    for (const t of res.targets) row.targets.push(t);
    const pasted = res.targets;
    selectOnly(pasted[pasted.length - 1].id);
    S.extraSel = new Set(pasted.slice(0, -1).map((t) => t.id));
    S.lastCreateAt = Date.now();
    pasted.forEach((t, k) => {
      S.prov.add(t.id);
      S.origin.set(key(row.name, t), origin || "paste");
      logEvent({ ev: origin === "duplicate" ? "duplicated" : "pasted", target: t.id,
        source: { frame: clips[k].sourceFrame, target: clips[k].sourceTarget } });
    });
    const t = pasted[pasted.length - 1];
    let note = "";
    if (row.done) { // a pasted box is unchecked: the frame needs confirming again
      row.done = false;
      logEvent({ ev: "frame-unconfirmed", n: row.targets.length, via: "paste" });
      note = " The frame was done: it is open again until you finish it.";
    }
    setStatus(pasted.length === 1 ? `Box ${origin === "duplicate" ? "duplicated" : "pasted"}: move it into place.${note}`
      : `${pasted.length} boxes ${origin === "duplicate" ? "duplicated" : "pasted"}: drag one to move them together.${note}`);
    afterChange(row, t);
  }

  function duplicateBox() { if (copyBox()) pasteBox("duplicate"); }

  // ---- z-order (additive `zOrder`; keys . , > <) ----------------------------------------

  function reorderSel(how) {
    const t = selected();
    if (!editable() || !t) { setStatus(noTargetMessage()); return; }
    const row = rowFor(currentFrame());
    const step = how === 1 || how === -1;
    const z = step ? G.reorderAmongOverlaps(row.targets, row.targets.indexOf(t), how) : G.reorder(row.targets, row.targets.indexOf(t), how);
    if (!z) {
      setStatus(step ? (how === 1 ? "No box it overlaps is above it." : "No box it overlaps is below it.")
        : how === "front" ? "This box is already on top." : "This box is already at the back.");
      return;
    }
    pushUndo(row);
    row.targets.forEach((x, i) => { x.zOrder = z[i]; });
    const L = G.stackLayers(row.targets)[row.targets.indexOf(t)];
    setStatus(L.size > 1 ? `This box is now layer ${L.layer} of ${L.size} in its stack.` : "This box overlaps no other box: its layer makes no difference.");
    scheduleSave(); render();
  }

  // ---- default box size (per set in localStorage) -------------------------------------

  function readDefaultStore() {
    try { const s = JSON.parse(lsGet(LS.defaultBox) || "null"); return s && typeof s === "object" ? s : {}; } catch (e) { return {}; }
  }
  const validSize = (s) => !!s && isFinite(s.w) && isFinite(s.h) && s.w >= G.MIN_BOX && s.h >= G.MIN_BOX;

  // The boxes a new box takes its size from (boxsize.js): the model's boxes on this set, as the
  // page shows them, and the card boxes of its finished frames, each as it lies on screen.
  function boxSamples() {
    const model = [], confirmed = [];
    if (mode() !== "box") return { model, confirmed };
    for (const name of Object.keys(S.prefill || {})) {
      for (const pr of prefillFor(name) || []) {
        if (!Array.isArray(pr.corners) || pr.corners.length !== 4) continue;
        const xs = pr.corners.map((c) => c[0]), ys = pr.corners.map((c) => c[1]);
        model.push({ w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
      }
    }
    for (const f of S.frames) {
      const row = S.rows.get(f.name);
      if (!row || !row.done) continue;
      for (const t of row.targets || []) {
        if (t.pending || t.ignore || (t.outcome && t.outcome !== "card") || !Array.isArray(t.corners)) continue;
        confirmed.push(BS.screenSize(rectOf(t)));
      }
    }
    return { model, confirmed };
  }

  function loadDefaultBox() {
    const st = readDefaultStore();
    const own = st.bySet && S.set ? st.bySet[S.set.setId] : null;
    const size = BS.newBoxSize(Object.assign({ chosen: own, last: st.last, min: G.MIN_BOX }, boxSamples()));
    S.defaultBox = { w: size.w, h: size.h };
    S.defaultFrom = size.from;
    renderDefaultBox();
  }

  function setDefaultBox(w, h) {
    if (!validSize({ w, h })) return;
    S.defaultBox = { w: Math.round(w), h: Math.round(h) };
    S.defaultFrom = "chosen";
    const st = readDefaultStore();
    st.bySet = st.bySet && typeof st.bySet === "object" ? st.bySet : {};
    if (S.set) st.bySet[S.set.setId] = Object.assign({}, S.defaultBox);
    st.last = Object.assign({}, S.defaultBox);
    lsSet(LS.defaultBox, JSON.stringify(st));
    renderDefaultBox();
  }

  function renderDefaultBox() {
    const { w, h } = S.defaultBox;
    const said = BS.sizeText({ w, h, from: S.defaultFrom });
    $("newBoxText").textContent = said.text;
    $("newBoxRow").title = said.from;
    if (document.activeElement !== $("defaultBoxW")) $("defaultBoxW").value = w;
    if (document.activeElement !== $("defaultBoxH")) $("defaultBoxH").value = h;
    $("defaultBoxSize").textContent = `${w} × ${h} px`;
    const stage = $("defaultBoxStage"), sw = $("defaultBoxSwatch");
    const ds = S.view.s || 0.5; // drawn at the frame canvas's on-screen scale, shrunk to fit
    const fit = Math.min(1, (stage.clientWidth - 16) / (w * ds || 1), (stage.clientHeight - 16) / (h * ds || 1));
    const pw = w * ds * fit, ph = h * ds * fit;
    Object.assign(sw.style, { width: `${pw}px`, height: `${ph}px`, left: `${(stage.clientWidth - pw) / 2}px`, top: `${(stage.clientHeight - ph) / 2}px` });
    $("defaultBoxHint").textContent = `A click on the frame where there is no box (or N, then a click) places a box of this size centered on the click. ${said.from} A size you set here is remembered for this set.${fit < 0.999 ? ` Shown at ${Math.round(fit * 100)} % of its size on the frame.` : ""}`;
  }

  function defaultFromSelected() {
    const t = selected();
    if (!t) { setStatus(noTargetMessage()); return; }
    const r = rectOf(t);
    setDefaultBox(r.w, r.h);
    setStatus(`The new-box size is now ${S.defaultBox.w} × ${S.defaultBox.h} px.`);
  }

  function defaultToSelected() {
    const { w, h } = S.defaultBox;
    editGeometry(primaryIds(), (t) => { const r = rectOf(t); r.w = w; r.h = h; setRect(t, r); });
  }

  function placeDefaultAt(p) {
    const [W, H] = frameSize();
    const { w, h } = S.defaultBox;
    createBoxRect({ cx: G.clamp(p.x, w / 2, W - w / 2), cy: G.clamp(p.y, h / 2, H - h / 2), w, h, angle: 0 },
      { origin: "default-box", status: `Box of the new-box size placed (${w} × ${h} px).` });
  }

  // ---- snap (snap.js; off by default) ----------------------------------------------------

  function snapSeed(seed) {
    const px = Snap ? framePixels() : null;
    if (!px) return null;
    const r = Snap.snapRect(px, seed).rect;
    return { cx: r.cx, cy: r.cy, w: r.w, h: r.h, angle: G.normalizeAngle(r.angle || 0) };
  }

  function snapClickAt(p, landscape) {
    const rect = snapSeed(Snap.seedFromClick(p.x, p.y, S.defaultBox, landscape));
    if (!rect) { setStatus("Snap needs the frame's picture: nothing was placed."); return; }
    createBoxRect(rect, { origin: "snap", status: "Box snapped to the card: check its edges." });
  }

  function resnapSel() {
    editGeometry(primaryIds(), (t) => { const r = snapSeed(rectOf(t)); if (r) turnTo(t, r); });
  }

  function besideContext() { return { set: S.set && S.set.setId, frame: S.frameIdx, mode: mode(), sel: selectedIds() }; }

  function armBeside() {
    const t = selected();
    if (!editable() || !t || !isBoxTarget(t)) { setStatus("Select a box first, then press D and an arrow."); return; }
    S.besideArmed = KR.armedFor(besideContext());
    setStatus("A box beside this one: press an arrow for the side (Esc cancels).");
  }

  function setStackView(on) {
    S.stackView = !!on;
    setStatus(S.stackView ? "Stacking view on: each box is shaded where no box above it covers it; the number is its layer in its stack (1 = the bottom). Nothing is saved." : "Stacking view off.");
    renderToolbar(); render();
  }

  function setBoxSnap(on) {
    S.boxSnap = !!on && !!Snap;
    setStatus(S.boxSnap ? "Snap is on: click a card to place a box fitted to its edges (Shift+click for a card lying sideways)." : "Snap is off.");
    renderToolbar();
  }

  // ---- row tools (labeltools.js; keys only) ----------------------------------------------

  function distributeSel() {
    const ids = selectedIds();
    if (ids.length < 3) { setStatus("To space a row evenly, select 3 or more of its boxes first (Shift+click or Shift+drag)."); return; }
    const row = rowFor(currentFrame());
    const d = Tools.distribute(ids.map((id) => rectOf(targetById(row, id))));
    editGeometry(ids, (t) => { const slot = d.order.indexOf(ids.indexOf(t.id)); setRect(t, d.rects[slot]); });
  }

  function insertIntoRow() {
    const ids = selectedIds();
    if (!editable() || !ids.length) { setStatus("To add a box to a row, select the row's boxes first (Shift+click or Shift+drag)."); return; }
    const row = rowFor(currentFrame());
    const res = Tools.insertSlot(ids.map((id) => rectOf(targetById(row, id))), 0); // primary = last clicked
    const before = JSON.stringify(row.targets);
    confirmBox();
    res.order.forEach((k, slot) => { if (k >= 0) setRect(targetById(row, ids[k]), res.rects[slot]); });
    const t = createBoxRect(res.rects[res.newSlot], { origin: "insert", keepProv: true, noUndo: true, status: "Box added to the row." });
    if (!t) { row.targets = JSON.parse(before); render(); return; }
    pushUndo(row, before);
    reopen(ids.concat([t.id]));
    afterChange(row, t);
  }

  function removeFromRow() {
    const ids = selectedIds();
    if (!editable() || ids.length < 2) { setStatus("To take a card out of a row, select the row, click the card that left last, then press the minus key."); return; }
    const row = rowFor(currentFrame());
    const res = Tools.removeSlot(ids.map((id) => rectOf(targetById(row, id))), 0);
    const before = JSON.stringify(row.targets);
    const gone = targetById(row, ids[0]);
    res.order.forEach((k, slot) => setRect(targetById(row, ids[k]), res.rects[slot]));
    row.targets = row.targets.filter((x) => x !== gone);
    S.snaps.delete(key(row.name, gone)); S.prov.delete(gone.id);
    logRemoved(row, gone);
    pushUndo(row, before);
    const rest = ids.slice(1);
    S.selId = rest[rest.length - 1]; S.extraSel = new Set(rest);
    reopen(rest);
    afterChange(row, targetById(row, S.selId));
  }

  // `l` "same layout as…": the group is the whole frame: the nearest
  // confirmed frame with the same number of boxes and a different layout lends its geometry,
  // box by box in reading order; identities stay.
  function sameLayout() {
    const row = rowFor(currentFrame());
    const cur = row.targets || [];
    const frames = [];
    S.frames.forEach((f, i) => {
      const r = S.rows.get(f.name);
      if (i !== S.frameIdx && r && r.done && (r.targets || []).length) frames.push({ index: i, t: f.t, dt: (f.t || 0) - (currentFrame().t || 0), targets: r.targets });
    });
    const m = G.layoutMatches(cur, frames);
    if (!m.length) { setStatus(`No finished frame has ${cur.length} boxes in another layout to copy.`); return; }
    const src = frames.find((f) => f.index === m[0].index);
    const pairs = Tools.applyLayout(cur.map(rectOf), src.targets.map(rectOf));
    if (!pairs) return;
    const byIdx = new Map(pairs.map((p) => [p.targetIndex, p.rect]));
    if (!cur.every((t, k) => turnAllowed(t, byIdx.get(k)))) { setStatus(BE0.TOO_FAR); return; } // all or none
    if (editGeometry(cur.map((t) => t.id), (t, k) => setRect(t, byIdx.get(k)))) {
      S.selId = cur[0].id; S.extraSel = new Set(cur.map((t) => t.id));
      setStatus(`Layout taken from frame ${src.index + 1}.`);
      render();
    }
  }

  // ---- carry-over (propagation of the labeler's own confirmed boxes) ---------------------
  // Box mode, every role except test, under its own provenance:
  // `labelSource` / `cornerSource: carried`, `carriedFrom`. Entering an empty, unconfirmed frame
  // whose previous frame is confirmed copies that frame's boxes (violet); `x` clears the ones
  // still unedited on an unconfirmed frame; confirming a frame re-arms the next one.

  // What a set allows is a matter of the set (`writable`); whether the frame on the page takes
  // a change right now is asked apart (`editable`).
  function carryAllowed() { return mode() === "box" && writable() && role() !== "test"; }

  function tryCarryOver(idx) {
    if (!carryAllowed() || !editable() || !S.carryOn || idx < 1) return;
    const f = S.frames[idx], row = rowFor(f);
    if (row.done || (row.targets || []).length || S.carried.has(f.name)) return;
    const prev = S.rows.get(S.frames[idx - 1].name);
    if (!prev || !prev.done || !(prev.targets || []).length) return;
    row.targets = G.carryTargets(prev.targets, prev.name, S.boxesOnly);
    S.carried.add(f.name);
    for (const t of row.targets) if (complete(t)) S.snaps.set(key(f.name, t), answerSig(t));
    logEvent({ ev: "carried-over", n: row.targets.length, from: prev.name });
    setStatus("");
    scheduleSave();
  }

  // `x`: remove the carried boxes nobody has checked yet: labelSource still "carried" (not
  // corrected), not being adjusted, on a frame that is not confirmed. A confirmed frame's boxes
  // were reviewed by its Enter and are never removed by `x` (Delete removes a box on purpose).
  function clearCarried() {
    if (!editable()) return;
    if (!carryAllowed()) { setStatus("No boxes are kept from frame to frame in a set made for the final test."); return; }
    const row = rowFor(currentFrame());
    if (row.done) { setStatus("This frame is done, so its boxes stay. Shift+Enter reopens it; Delete removes one box."); return; }
    S.carried.add(row.name); // a frame cleared on purpose is not refilled this session
    const unedited = (t) => t.labelSource === "carried" && !S.prov.has(t.id);
    const gone = (row.targets || []).filter(unedited);
    if (!gone.length) {
      const edited = (row.targets || []).filter(G.isCarried).length;
      setStatus(edited ? `The ${edited} kept ${edited === 1 ? "box here was" : "boxes here were"} already edited, so X leaves them. Delete removes a box.` : "No boxes on this frame were kept from the frame before.");
      return;
    }
    pushUndo(row);
    row.targets = row.targets.filter((t) => !unedited(t));
    for (const t of gone) { S.snaps.delete(key(row.name, t)); S.prov.delete(t.id); }
    S.selId = null; S.extraSel = new Set();
    logEvent({ ev: "carry-over-cleared", n: gone.length });
    const back = reofferSuppressed(row);
    setStatus(`Cleared ${gone.length} kept ${gone.length === 1 ? "box" : "boxes"}.${back ? ` The ${back} model ${back === 1 ? "box" : "boxes"} held back under them ${back === 1 ? "is" : "are"} shown now.` : ""}`);
    scheduleSave(); render();
  }

  // Shift+X / the toolbar's "Clear frame…": every box on the frame, after a confirm dialog.
  // One undo step restores them; the frame is left unconfirmed and is not refilled
  // by carry-over this session.
  function clearFrame() {
    if (!editable() || mode() !== "box") return;
    const row = rowFor(currentFrame());
    const n = (row.targets || []).length;
    if (!n) { setStatus("There are no boxes on this frame."); return; }
    if (!window.confirm(`Remove all ${n} ${n === 1 ? "box" : "boxes"} on this frame? Undo (${CMD}+Z) brings them back.`)) { setStatus("Nothing was cleared."); return; }
    pushUndo(row);
    for (const t of row.targets) {
      S.snaps.delete(key(row.name, t)); S.prov.delete(t.id);
      logRemoved(row, t, "clear-frame");
    }
    row.targets = [];
    row.done = false;
    S.carried.add(row.name);
    S.selId = null; S.extraSel = new Set();
    logEvent({ ev: "frame-cleared", n });
    setStatus(`Cleared ${n} ${n === 1 ? "box" : "boxes"}. Undo (${CMD}+Z) brings them back.`);
    scheduleSave(); render();
  }


  // ---- box-mode prefill (role=training sets with --prefill only) -------------------------
  // An unconfirmed frame with no boxes gets the detector's boxes as PENDING boxes (violet
  // dash-dot; backs orange), offered once per frame (`prefillOffered`, saved). A frame that
  // already has boxes (carry-over wins) gets them as SUGGESTIONS ("?") where boxgeom.heldBack
  // offers them; the others are held back (`prefillSuppressed`) until `x` clears the carried
  // boxes. Review: a / Enter accepts (prefill-accepted), any edit corrects
  // (prefill-corrected, decided against the proposal when the box is committed), Delete rejects
  // (timing `prefill-rejected`), Enter on the frame accepts every untouched pending box (never a
  // suggestion). Provenance: boxgeom.prefillProvenance.

  function prefillActive() { return mode() === "box" && writable() && role() === "training" && !!S.prefill; }

  // Two card ids are one card by the catalog's rule; a box's card (boxgeom.boxCard).
  function sameCardId(a, b) {
    const c = (id) => S.byId && S.byId.get(id) && { name: S.byId.get(id).name, printingId: id };
    return a === b || (!!V && !!c(a) && !!c(b) && V.sameCard(c(a), c(b), S.config.identity, S.roots));
  }
  const cardOfBox = (t) => G.boxCard(t, (f, id) => { const r = S.rows.get(f); return r ? targetById(r, id) : null; });
  const asCard = (t) => t && { rect: rectOf(t), card: cardOfBox(t) };
  const frameProps = (row) => { const [W, H] = frameSize(); return (prefillFor(row.name) || []).map((p, i) => G.prefillTarget(p, i, W, H, "P")); };

  function offerBoxPrefill(row, f) {
    if (!prefillActive() || row.done || row.prefillOffered) return;
    const props = prefillFor(f.name);
    if (!Array.isArray(props)) return; // no record for this frame in the file: nothing offered
    const [W, H] = frameSize();
    const existing = (row.targets || []).slice();
    const cands = props.map((p, i) => G.prefillTarget(p, i, W, H, "P"));
    const held = G.heldBack(cands.map(asCard), existing.map(asCard), sameCardId);
    const suppressed = [];
    let n = 0, sugg = 0;
    props.forEach((p, i) => {
      const t = cands[i];
      if (!t) return;
      t.id = newTargetId(row, "P");
      if (existing.length) {
        if (held[i] >= 0) { suppressed.push(i); return; }
        t.suggestion = true; sugg++;
      }
      const z = G.nextZ(row.targets);
      if (z !== null) t.zOrder = z;
      row.targets.push(t); n++;
    });
    row.prefillOffered = true;
    if (suppressed.length) row.prefillSuppressed = suppressed;
    if (!n && !suppressed.length) return;
    logEvent({ ev: "prefill-offered", n, suggestions: sugg, heldBack: suppressed.length });
    scheduleSave();
  }

  // `x` removed the untouched carried boxes: bring in the detector boxes they had held back
  // (pending; suggestions while other boxes remain). Returns how many came in.
  function reofferSuppressed(row) {
    if (!prefillActive() || !Array.isArray(row.prefillSuppressed) || !row.prefillSuppressed.length) return 0;
    const props = prefillFor(row.name) || [];
    const [W, H] = frameSize();
    const others = (row.targets || []).filter((t) => !t.prefill);
    const rest = [];
    let n = 0;
    const all = frameProps(row).map(asCard);
    for (const i of row.prefillSuppressed) {
      const t = G.prefillTarget(props[i], i, W, H, newTargetId(row, "P"));
      if (!t) continue;
      if (G.heldBack(all, row.targets.map(asCard), sameCardId)[i] >= 0) { rest.push(i); continue; }
      if (others.length) t.suggestion = true;
      const z = G.nextZ(row.targets);
      if (z !== null) t.zOrder = z;
      row.targets.push(t); n++;
    }
    if (!others.length) for (const t of row.targets) if (t.pending) delete t.suggestion;
    if (rest.length) row.prefillSuppressed = rest; else delete row.prefillSuppressed;
    if (n) logEvent({ ev: "prefill-offered", n, via: "carry-over-cleared" });
    return n;
  }

  // The box is reviewed: its provenance against the proposal, no longer pending.
  function finalizePrefill(t) { if (t.prefill) G.editProvenance(t, true); }

  // A box removed (Delete, row tool, Clear frame, undo): a detector box is `prefill-rejected`
  // (reviewed: whether it had been accepted / corrected first), any other `deleted`.
  function logRemoved(row, t, via) {
    const extra = via ? { via } : {};
    if (t.prefill && setMode() === "box") {
      const k = pkey(row.name, t);
      S.rejectedKeys.add(k); S.unrejectedKeys.delete(k);
      logEvent(Object.assign({ ev: "prefill-rejected", target: t.id, reviewed: !t.pending }, extra));
    } else if (t.prefill && !via) logEvent({ ev: "prefill-rejected", target: t.id }); // training mode's Delete
    else logEvent(Object.assign({ ev: "deleted", target: t.id }, extra));
  }

  // undo/redo took away an unreviewed detector box: the redo of a rejection logs it again; else
  // it was brought in by `x` and is held back again
  function prefillVanished(row, t) {
    const k = pkey(row.name, t);
    if (S.unrejectedKeys.has(k)) { logRemoved(row, t, "history"); return; }
    if (S.mergedKeys.has(k)) return; // a redone `m`: the suggestion is in the kept box again
    const i = t.prefill && t.prefill.i;
    if (typeof i === "number") row.prefillSuppressed = Array.from(new Set((row.prefillSuppressed || []).concat([i])));
  }

  // undo/redo brought back an unreviewed detector box: an undone rejection, or a redone `x`
  function prefillReturned(row, t) {
    const k = pkey(row.name, t);
    if (S.rejectedKeys.has(k)) {
      S.rejectedKeys.delete(k); S.unrejectedKeys.add(k);
      logEvent({ ev: "prefill-unrejected", target: t.id, via: "history" });
      return;
    }
    const i = t.prefill && t.prefill.i;
    if (Array.isArray(row.prefillSuppressed)) {
      row.prefillSuppressed = row.prefillSuppressed.filter((x) => x !== i);
      if (!row.prefillSuppressed.length) delete row.prefillSuppressed;
    }
  }

  // Accept the given detector boxes as they are now (a box being adjusted is committed too: its
  // provenance is decided against the proposal). Returns how many were reviewed.
  function acceptPrefill(ids, via) {
    if (!editable()) return 0;
    const row = rowFor(currentFrame());
    const ts = ids.map((id) => targetById(row, id)).filter((t) => t && t.pending && t.prefill);
    if (!ts.length) return 0;
    pushUndo(row);
    for (const t of ts) { S.prov.delete(t.id); logCommit(row, t, { via }); }
    scheduleSave(); render();
    return ts.length;
  }

  function pendingPrefill(row) { return (row.targets || []).filter((t) => t.pending && t.prefill); }

  // `a`: on a selected detector box, accept it and select the next unreviewed one; else the
  // printing editor.
  const NAMES_LATER = "Names come in the Names pass. To name cards here, untick Hide names under Options.";
  function namesGuard(fn) { return (...a) => (mode() === "box" && S.boxesOnly ? setStatus(NAMES_LATER) : fn(...a)); }
  function setBoxesOnly(on) {
    S.boxesOnly = !!on; lsSet(LS.boxesOnly, on ? "on" : "off");
    setStatus(on ? "Names are hidden: this pass draws boxes only." : "Names can be picked in this pass again.");
    renderToolbar(); render();
  }

  function acceptKey() {
    const row = rowFor(currentFrame());
    const ids = selectedIds().filter((id) => { const t = targetById(row, id); return t && t.pending && t.prefill; });
    if (!ids.length) { if (S.boxesOnly) { setStatus(NAMES_LATER); return; } openPrintingEditor(); return; }
    const n = acceptPrefill(ids, "a");
    const left = pendingPrefill(row);
    if (left.length) { confirmBox(); selectOnly(nextPrefillId(row, null)); setStatus(`Accepted ${n}. ${left.length} model ${left.length === 1 ? "box" : "boxes"} left on this frame.`); }
    else { confirmBox(); S.selId = null; S.extraSel = new Set(); setStatus(`Accepted ${n}. Every model box on this frame is checked.`); }
    render();
  }

  // A card that moved (boxgeom.movedPairs): `m` moves its kept box onto the model's `?` box.
  function movedPairsOf(row) {
    if (!prefillActive() || !row || row.done) return [];
    return G.movedOnFrame(row.targets || [], frameProps(row).filter(Boolean).map(rectOf), cardOfBox, sameCardId,
      (t) => S.prov.has(t.id) && S.snaps.get(key(row.name, t)) !== answerSig(t)); // being changed (not: back as it was, by an undo)
  }

  function moveKept() {
    if (!editable()) return;
    if (!prefillActive()) { setStatus(U.NOTES.noModel); return; }
    if (S.bdrag) { setStatus(U.NOTES.busy); return; }
    const row = rowFor(currentFrame()), sel = selectedIds(), pairs = movedPairsOf(row);
    const pair = sel.length ? pairs.find((q) => sel.includes(q.kept) || sel.includes(q.suggestion)) : pairs[0];
    if (!pair) { setStatus(pairs.length ? U.NOTES.notPaired : U.NOTES.noMove); return; }
    const t = targetById(row, pair.kept), s = targetById(row, pair.suggestion);
    S.prov.delete(s.id); // an adjusted `?` is not committed: an undo brings it back as a suggestion
    confirmBox(); pushUndo(row);
    G.moveOnto(t, s);
    row.targets = row.targets.filter((x) => x !== s);
    S.mergedKeys.add(pkey(row.name, s)); S.snaps.delete(key(row.name, s));
    logEvent({ ev: "kept-moved", target: t.id, suggestion: s.id });
    if (!G.atEdge(t.corners, ...frameSize())) remember(t, G.upright(t.corners));
    selectOnly(t.id); reopen([t.id]); afterChange(row, t);
    setStatus(U.NOTES.moved);
  }

  // The next unreviewed detector box after the selected one (stacking order, wrapping).
  function nextPrefillId(row, fromId) {
    const ts = row.targets || [];
    const order = G.orderAsc(ts).map((i) => ts[i]);
    const pend = order.filter((t) => t.pending && t.prefill);
    if (!pend.length) return null;
    const pos = order.findIndex((t) => t.id === fromId);
    const after = pend.find((t) => order.indexOf(t) > pos);
    return (after || pend[0]).id;
  }

  // `j`: select the next unreviewed detector box on this frame.
  function jumpPrefill() {
    const row = rowFor(currentFrame());
    let id = nextPrefillId(row, S.selId);
    if (!id) { // no detector box left: the boxes flagged to fix (boxFix), in order after the selection
      const ts = (row.targets || []).filter((x) => x.boxFix);
      if (ts.length) {
        const i = ts.findIndex((x) => x.id === S.selId);
        const t = ts[(i + 1) % ts.length];
        confirmBox(); selectOnly(t.id);
        setStatus(`This box was flagged: ${t.boxFix.reason === "top" ? "set its top edge (W turns it, or Option/Alt+click the card's top)" : "fix its size or place"}. ${ts.length} flagged on this frame.`);
        render(); return;
      }
      setStatus(S.prefill ? "No model box or flagged box is left to check on this frame." : "No box is flagged on this frame."); return;
    }
    confirmBox();
    selectOnly(id);
    const t = targetById(row, id);
    setStatus(`${pendingPrefill(row).length} model ${pendingPrefill(row).length === 1 ? "box" : "boxes"} left to check on this frame.`);
    render();
  }

  // ---- review walk (box mode) ---------------------------------------------------
  // Every box of the set one at a time, frame by frame, zoomed (the image as on screen, never
  // derotated) with its top edge (q[0]→q[1]) drawn big, so the labeler checks and fixes the card's
  // own top. Every edit goes through box mode's own paths (editGeometry, toggleKind,
  // deleteTarget, undo), so autosave, undo, provenance, the timing log and the server's checks
  // are box mode's. The walk position is kept per set in memory only.

  function reviewAllowed() { return !!S.set && mode() === "box" && writable(); }
  function reviewOn() { return S.review.on && reviewAllowed(); }

  // The center shows the zoom view in review, the frame canvas otherwise.
  function applyStage() {
    const z = zoomStage() || reviewOn();
    $("pointStage").hidden = !z;
    $("cornerStage").hidden = z;
    $("defaultBox").hidden = mode() !== "box" || reviewOn();
    $("newBoxRow").hidden = mode() !== "box" || reviewOn() || !!S.readOnly;
    $("verifyPanel").hidden = mode() !== "verify";
  }

  function reviewList() {
    const frames = S.frames.map((f) => ({ name: f.name, targets: (S.rows.get(f.name) || {}).targets || [] }));
    return G.reviewWalk(frames, S.review.includeIgnore, S.review.cache);
  }

  function turnedSet() {
    const id = S.set.setId;
    if (!S.review.turned.has(id)) S.review.turned.set(id, new Set());
    return S.review.turned.get(id);
  }

  async function setReview(on) {
    if (on && !reviewAllowed()) { setStatus("Top edges can be checked in a Boxes set that is not read-only."); renderToolbar(); return; }
    if (!!on === reviewOn()) { renderToolbar(); return; }
    if (S.bdrag) { setStatus("Finish the drag first."); renderToolbar(); return; }
    S.newBoxMode = false; S.altEdge = null; S.review.altK = null; S.review.gapView = null;
    hideHoverPreview();
    if (on) {
      logEvent({ ev: "review-start" }); // before `on`: the time up to here was box-mode work
      S.review.on = true;
      S.review.cache = new Map();
      applyStage(); renderToolbar(); renderKeys();
      await reviewEnter();
    } else {
      logEvent({ ev: "review-end" }); // still flagged: looking at the last box was review time
      S.review.on = false;
      S.extraSel = new Set(); // the box shown stays selected (S.selId) for a full edit
      applyStage(); renderToolbar(); renderKeys();
      setStatus(selected() ? "Back on the frame, with the box you were checking selected. V returns to the check." : "Back on the frame.");
      render();
      $("frameCanvas").focus();
    }
  }

  // Where the walk starts: the selected box (back from a full edit), else this set's remembered
  // position, else the first box on or after the current frame.
  async function reviewEnter() {
    const list = reviewList();
    if (!list.length) {
      S.review.cur = null; S.review.gapView = null;
      setStatus(`This set has no box to check${S.review.includeIgnore ? "." : ": card backs and ignored boxes are left out (Options has a switch for them)."}`);
      render(); return;
    }
    const f = currentFrame();
    let i = S.selId ? list.findIndex((e) => e.frame === f.name && e.id === S.selId) : -1;
    if (i < 0 && S.review.pos.has(S.set.setId)) {
      const { i: j } = G.reviewLocate(list, S.review.pos.get(S.set.setId));
      i = Math.min(j, list.length - 1);
    }
    if (i < 0) {
      const after = new Set(S.frames.slice(S.frameIdx).map((x) => x.name));
      i = Math.max(0, list.findIndex((e) => after.has(e.frame)));
    }
    await reviewGo(i, list);
    setStatus(`${list.length} ${list.length === 1 ? "box" : "boxes"} to check in this set.`);
  }

  async function reviewGo(i, list) {
    const l = list || reviewList();
    const e = l[i];
    if (!e) return;
    const idx = S.frames.findIndex((f) => f.name === e.frame);
    if (idx < 0) return;
    if (idx !== S.frameIdx || !S.img) await gotoFrame(idx); // confirms a box being adjusted, saves
    else confirmBox();
    selectOnly(e.id);
    S.review.cur = { frame: e.frame, id: e.id, idx: i };
    S.review.pos.set(S.set.setId, S.review.cur);
    S.review.gapView = null; S.review.altK = null;
    render();
  }

  // Enter / → / Space (dir 1, `key` set): OK, the box goes as it is now (a box turned in the
  // review is committed: box mode's correction; an unreviewed detector box is accepted); ←: back.
  async function reviewNext(dir, how) {
    const list = reviewList();
    const t = selected();
    if (dir > 0 && how && t) {
      const row = rowFor(currentFrame());
      if (t.pending && t.prefill) acceptPrefill([t.id], "review");
      confirmBox();
      const k = key(row.name, t);
      logEvent({ ev: "reviewed", target: t.id, key: how, turned: turnedSet().has(k),
        kind: t.ignore ? "ignore" : t.outcome === "card-back" ? "back" : "card" });
    }
    const j = G.reviewStep(list, S.review.cur, dir);
    if (j < 0) {
      setStatus(dir > 0 ? "That was the last box of this set. Esc goes back to the frame." : "This is the first box of this set.");
      render(); return;
    }
    await reviewGo(j, list);
  }

  // ] / [ and the frame strip: the first box of a frame of the walk.
  async function reviewGotoFrame(name) {
    const list = reviewList();
    const i = list.findIndex((e) => e.frame === name);
    if (i < 0) { setStatus("That frame has no box to check."); return; }
    await reviewGo(i, list);
  }

  async function reviewFrameStep(dir) {
    const names = Array.from(new Set(reviewList().map((e) => e.frame)));
    const cur = S.review.cur ? S.review.cur.frame : currentFrame().name;
    const order = S.frames.map((f) => f.name);
    const at = order.indexOf(cur);
    const pick = dir > 0 ? names.find((n) => order.indexOf(n) > at) : names.filter((n) => order.indexOf(n) < at).pop();
    if (!pick) { setStatus(dir > 0 ? "No later frame has boxes to check." : "No earlier frame has boxes to check."); return; }
    await reviewGotoFrame(pick);
  }

  // j: the next box flagged to fix (boxFix), after the current one, wrapping.
  async function reviewJumpFix() {
    const list = reviewList();
    const flagged = (e) => { const r = S.rows.get(e.frame); const t = r && targetById(r, e.id); return !!(t && t.boxFix); };
    const n = list.filter(flagged).length;
    if (!n) { setStatus("No box of this set is flagged."); return; }
    const { i, present } = G.reviewLocate(list, S.review.cur);
    const start = present ? i + 1 : i;
    for (let k = 0; k < list.length; k++) {
      const j = (start + k) % list.length;
      if (flagged(list[j])) { await reviewGo(j, list); setStatus(`A flagged box. ${n} flagged in this set.`); return; }
    }
  }

  function noteTurned(t, via) {
    turnedSet().add(key(currentFrame().name, t));
    logEvent({ ev: "review-turned", target: t.id, via, angle: t.angle || 0 });
  }

  // w / W: box mode's quarter turn; stays on the box so the result shows (Enter goes on).
  function reviewTurn(dir) {
    const t = selected();
    if (!t) { setStatus(`The box here was removed. Undo (${CMD}+Z) brings it back; Enter goes on.`); return; }
    tapSel(dir);
    noteTurned(t, dir > 0 ? "w" : "W");
    render();
    setStatus(`Turned a quarter ${dir > 0 ? "clockwise" : "counter-clockwise"}.`);
  }

  function reviewViewPos(ev) {
    const r = $("zoomView").getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  // The edge of the shown box under view point p (k clockwise from its current top), or null.
  function reviewEdgeAt(p) {
    const t = selected(), v = S.review.view;
    if (!p || !t || !v) return null;
    return G.nearestEdgeOf(t, G.viewToFrame(v, p.x, p.y), REVIEW_EDGE_PX / v.z);
  }

  function setReviewAlt(k) {
    const kk = k === undefined ? null : k;
    if (kk !== S.review.altK) { S.review.altK = kk; if (reviewOn()) render(); }
    $("zoomView").style.cursor = kk !== null && reviewOn() ? "cell" : "";
  }

  function reviewEdgeClick(p) {
    const t = selected();
    if (!t) { setStatus(`The box here was removed. Undo (${CMD}+Z) brings it back; Enter goes on.`); return; }
    const k = reviewEdgeAt(p);
    if (k === null) { setStatus("Hold Option/Alt and click on an edge of the box: the edge lights up under the pointer."); return; }
    if (k === 0) { setStatus("That edge is already the top."); return; }
    setTopEdgeSel(k);
    noteTurned(t, "edge");
    S.review.altK = null;
    render();
  }

  function reviewDelete() {
    const t = selected();
    if (!t) { setStatus(`Already removed. Undo (${CMD}+Z) brings it back.`); return; }
    S.review.gapView = S.review.view;
    deleteTarget();
    setStatus(`Box removed. Undo (${CMD}+Z) brings it back; Enter goes on.`);
    render();
  }

  // The keys of the review walk (no fall-through to box mode: one meaning per key here).
  function onReviewKey(ev) {
    const k = ev.key;
    if (k === "Enter" || k === "ArrowRight" || k === " ") { reviewNext(1, k === "Enter" ? "enter" : k === " " ? "space" : "arrow"); return true; }
    if (k === "ArrowLeft") { reviewNext(-1); return true; }
    if (k === "Escape" || k === "v" || k === "V") { setReview(false); return true; }
    const map = {
      w: () => reviewTurn(1), W: () => reviewTurn(-1),
      b: () => toggleKind("back"), B: () => toggleKind("back"),
      h: () => toggleKind("ignore"), H: () => toggleKind("ignore"),
      Delete: reviewDelete, Backspace: reviewDelete,
      j: reviewJumpFix, J: reviewJumpFix,
      "]": () => reviewFrameStep(1), PageDown: () => reviewFrameStep(1),
      "[": () => reviewFrameStep(-1), PageUp: () => reviewFrameStep(-1),
    };
    if (map[k]) { map[k](); return true; }
    if (k.length === 1) setStatus("That key does nothing while top edges are checked. The ? key lists the keys.");
    return k.length === 1 || k === "Tab" || k === "ArrowUp" || k === "ArrowDown";
  }

  // The panel's status while top edges are checked: boxes left after this one, boxes turned.
  function reviewProgress() {
    const list = reviewList();
    const { i, present } = G.reviewLocate(list, S.review.cur);
    const left = S.review.cur ? list.length - (present ? i + 1 : i) : list.length;
    return `Checking top edges: ${left} of ${list.length} left in this set · ${turnedSet().size} turned`;
  }

  // ---- identify mode ------------------------------------------------------------------------

  // Top-edge turns in the identity pass (box sets only): the four points stay
  // exactly where they are, only which edge is the card's top changes (the corner order rotates,
  // the angle turns by 90·k): w = the next edge clockwise, W = counter-clockwise, Option+click =
  // that edge. The box never moves. The server accepts exactly this change (labelcore
  // orientation_turn) and marks the box `orientationFixedIn: "identify"`; provenance stays.
  function identifyTurnsShown() { return mode() === "identify" && setMode() === "box"; }

  function identifyTurnBlocked() {
    if (!identifyTurnsShown()) return "The top edge can be turned in a set of boxes only: this pass never moves a corner.";
    if (!editable()) return SG.mayEdit(gateState()).text;
    // an older serve.py refuses any corner change in this pass: do not offer it
    if (!(S.config && S.config.identifyTurns)) return "The running server is older than this page and cannot save a turned top edge. Restart it (Ctrl+C, then the same command) and reload. Nothing was changed.";
    return null;
  }

  // A box's geometry and provenance as the server holds them: what a refused save puts back.
  const turnBase = (t) => JSON.parse(JSON.stringify({ corners: t.corners, angle: t.angle, orientationFixedIn: t.orientationFixedIn, boxFix: t.boxFix,
    labelSource: t.labelSource, cornerSource: t.cornerSource, pending: t.pending, suggestion: t.suggestion }));

  // The server's geometry of a box before its first turn (or edit) since the frame last saved.
  function rememberTurnBase(row, t) {
    const m = S.idTurnBase.get(row.name) || new Map();
    if (!m.has(t.id)) {
      m.set(t.id, turnBase(t));
    }
    S.idTurnBase.set(row.name, m);
  }

  function identifyTurn(k, via) {
    const why = identifyTurnBlocked();
    if (why) { setStatus(why); return false; }
    const t = selected();
    if (!t) { setStatus(noTargetMessage()); return false; }
    const kk = ((k % 4) + 4) % 4;
    if (!kk) { setStatus("That edge is already the top."); return false; }
    const row = rowFor(currentFrame());
    rememberTurnBase(row, t);
    pushUndo(row);
    const a = G.roundAngle(rectOf(t).angle + 90 * kk);
    t.corners = G.topEdgeCorners(t.corners, kk);
    if (a === 0 || G.isQuad(t)) delete t.angle; else t.angle = a; // a box with free corners has no angle
    t.orientationFixedIn = "identify"; // the server sets it too (and keeps it)
    // a box flagged "fix top" in box mode is cleared once its angle changes (afterChange's rule)
    if (t.boxFix && typeof t.boxFix === "object" && t.boxFix.reason === "top" && (t.angle || 0) !== t.boxFix.angle) delete t.boxFix;
    logEvent({ ev: "identify-turned", target: t.id, via, angle: t.angle || 0 });
    S.idAltK = null;
    scheduleSave();
    render();
    const names = ["top", "right", "bottom", "left"];
    setStatus(`The card's top is now what was the ${names[kk]} edge.`);
    return true;
  }

  // Undo / redo in the identity pass: a box whose corners came back or went again is logged as
  // a turn (`via` undo / redo), and its server geometry remembered for a refused save.
  function identifyHistoryTurns(row, before, what) {
    const now = new Map((row.targets || []).map((t) => [t.id, t]));
    for (const b of before) {
      const t = now.get(b.id);
      if (!t || JSON.stringify(t.corners) === JSON.stringify(b.corners)) continue;
      rememberTurnBase(row, b);
      logEvent({ ev: "identify-turned", target: t.id, via: what, angle: t.angle || 0 });
    }
  }

  const changeOf = (b, t) => Names.changeOf(G, b, t);
  // just before a Names-pass save: provenance as the server will check it (names.js)
  function settleEditProvenance(row) { Names.settleProvenance(G, row.targets, S.idTurnBase.get(row.name), setMode() === "box"); }

  // A save refused while the frame has turned or edited boxes (an older serve.py, or a change the
  // server does not accept): those boxes go back to the server's copy, every answer is kept and
  // the frame is saved again. A refused turn switches turning off until a restart (and drops the
  // undo history, whose snapshots hold it); a refused edit only puts its box back.
  // Returns true when it put boxes back.
  function revertRefusedTurns(name, err) {
    const m = S.idTurnBase.get(name);
    const row = S.rows.get(name);
    if (!m || !m.size || !row) return false;
    const turned = [], edited = [];
    for (const t of row.targets || []) {
      const b = m.get(t.id);
      if (!b) continue;
      const how = changeOf(b, t);
      t.corners = b.corners;
      for (const f of ["angle", "orientationFixedIn", "labelSource", "cornerSource", "pending", "suggestion"]) { if (b[f] === undefined) delete t[f]; else t[f] = b[f]; }
      if (b.boxFix && typeof b.boxFix === "object" && !t.boxFix) t.boxFix = b.boxFix; // the turn had cleared a "fix top" flag
      if (how > 0) turned.push(t.id); else if (how < 0) edited.push(t.id);
    }
    S.idTurnBase.delete(name);
    if (!turned.length && !edited.length) return false;
    const n = (ids) => (ids.length === 1 ? "a box" : `${ids.length} boxes`);
    const words = [];
    if (turned.length) {
      S.undo.set(name, []); S.redo.set(name, []); // their snapshots hold the refused turns
      S.config.identifyTurns = false;
      words.push(`the turned top edge of ${n(turned)}`);
    }
    if (edited.length) words.push(`the change to ${n(edited)}`);
    const bn = $("banner");
    bn.hidden = false;
    setStatus(bn.textContent = `The server refused ${words.join(" and ")} on ${name} (${err}). ${turned.length + edited.length === 1 ? "That box is" : "Those boxes are"} back as saved; every answer is kept and saved.${turned.length ? " Turning is off until the server is restarted (Ctrl+C, then the same command) and the page reloaded." : ""}`); // never "Undone."
    for (const id of turned) logEvent({ ev: "identify-turned", target: id, via: "refused" });
    for (const id of edited) logEvent({ ev: "identify-edited", target: id, how: "refused" });
    render();
    return true;
  }

  // After a save: a turn the server now holds needs no base any more; one made while the save
  // was in flight keeps the server's (just saved) geometry as its base.
  function settleTurnBase(name, saved) {
    const m = S.idTurnBase.get(name);
    const row = S.rows.get(name);
    if (!m || !row) return;
    for (const id of Array.from(m.keys())) {
      const lt = targetById(row, id), st = (saved.targets || []).find((x) => x.id === id);
      if (!lt || !st) { m.delete(id); continue; }
      if (JSON.stringify(lt.corners) === JSON.stringify(st.corners)) m.delete(id);
      else m.set(id, turnBase(st));
    }
    if (!m.size) S.idTurnBase.delete(name);
  }

  function idViewPos(ev) {
    const r = $("zoomView").getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  // The edge of the walk's box under view point p (k clockwise from its current top), or null.
  function idEdgeAt(p) {
    const t = selected(), v = S.idView;
    if (!p || !t || !v || !identifyTurnsShown()) return null;
    return G.nearestEdgeOf(t, G.viewToFrame(v, p.x, p.y), REVIEW_EDGE_PX / v.z);
  }

  function setIdAlt(k) {
    const kk = k === undefined ? null : k;
    if (kk !== S.idAltK) { S.idAltK = kk; if (mode() === "identify") render(); }
    $("zoomView").style.cursor = kk !== null && mode() === "identify" ? "cell" : "";
  }

  function identifyEdgeClick(p) {
    const why = identifyTurnBlocked();
    if (why) { setStatus(why); return; }
    if (!selected()) { setStatus(noTargetMessage()); return; }
    const k = idEdgeAt(p);
    if (k === null) { setStatus("Hold Option/Alt and click on an edge of the box: the edge lights up under the pointer."); return; }
    if (k === 0) { setStatus("That edge is already the top."); return; }
    identifyTurn(k, "edge");
  }

  // Box edits in the Names pass (box sets of role training or development; labelcore.py
  // names_edits_allowed): on the card's view, the current box's corners and edges resize it, the
  // knob above its top rotates it and a drag inside moves it, as in the Boxes pass (boxgeom.js);
  // anywhere else a drag moves the picture. Its provenance changes as a Boxes edit's
  // (G.editProvenance); undo takes it back; it saves by itself.
  const TEST_LOCKED = "In a test set, boxes are not moved, resized or rotated here; the top edge can still be turned.";
  function namesEditBlocked() {
    if (!identifyTurnsShown()) return "";
    if (role() === "test") return TEST_LOCKED;
    if (G.isQuad(selected())) return U.NOTES.quad.names;
    if (!editable()) return SG.mayEdit(gateState()).text;
    if (!(S.config && S.config.identifyEdits)) return "The running server is older than this page and cannot save a changed box. Restart it (Ctrl+C, then the same command) and reload.";
    return null;
  }
  function namesHit(ev) {
    const r = $("zoomView").getBoundingClientRect(), v = S.idView, p = G.viewToFrame(v, ev.clientX - r.left, ev.clientY - r.top);
    return { p, hit: mode() === "identify" && selected() && namesEditBlocked() !== "" ? boxHit(p, ev, v.z, true) : null };
  }
  function namesEditStart(ev) {
    const { p, hit } = namesHit(ev), t = selected();
    if (!hit || hit.mode === "empty") return false;
    const why = namesEditBlocked();
    if (why) { setStatus(why); return false; }
    const r = rectOf(t), row = rowFor(currentFrame());
    rememberTurnBase(row, t); // the server's copy, before an autosave can fire mid-drag
    S.ndrag = { mode: hit.mode, handle: hit.handle, start: p, orig: r, corners: t.corners.map((q) => q.slice()), startAngle: G.angleFromCenter({ x: r.cx, y: r.cy }, p),
      before: JSON.stringify(row.targets), x: ev.clientX, y: ev.clientY, moved: false };
    return true;
  }
  function namesEditMove(ev) {
    const d = S.ndrag, t = selected();
    if (!d || !t) return;
    if (!d.moved && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) <= DRAG_PX) return;
    d.moved = true;
    const { p } = namesHit(ev), [W, H] = frameSize();
    if (d.mode === "move") t.corners = G.translateCorners(d.corners, p.x - d.start.x, p.y - d.start.y, W, H, true);
    else if (d.mode === "resize") resizeTo(t, G.resizeWithin(d.orig, d.handle, p, W, H, G.MIN_BOX));
    else turnTo(t, Object.assign({}, d.orig, { angle: G.normalizeAngle(d.orig.angle + (G.angleFromCenter({ x: d.orig.cx, y: d.orig.cy }, p) - d.startAngle)) }));
    render();
  }
  function namesEditEnd() {
    const d = S.ndrag, t = selected();
    S.ndrag = null;
    if (!d || !t) return;
    const row = rowFor(currentFrame());
    if (!d.moved || JSON.stringify(t.corners) === JSON.stringify(d.corners)) { render(); return; }
    pushUndo(row, d.before);
    G.editProvenance(t, true);
    logEvent({ ev: "identify-edited", target: t.id, how: d.mode });
    setStatus(`Box ${d.mode === "move" ? "moved" : d.mode === "resize" ? "resized" : "rotated"}: saved as an edit of the Boxes pass. ${CMD}+Z takes it back.`);
    ({ cv: S.cv, box: S.cvBox } = Names.growCard(S.cv, Names.clampView(S.cv, cropDims()), cropDims(), S.cvBox, t.corners)); // 1× still shows it all
    afterChange(row, t);
  }

  async function gotoQueue(i) {
    if (!S.idq.length) return;
    S.qIdx = Math.max(0, Math.min(S.idq.length - 1, i));
    const e = S.idq[S.qIdx];
    const idx = S.frames.findIndex((f) => f.name === e.frame);
    if (idx < 0) return;
    closePrintingEditor();
    if (idx !== S.frameIdx || !S.img) await gotoFrame(idx, e.target);
    else { await flushSave(); S.selId = e.target; render(); markShown(); }
    arriveAtCard();
  }

  // The Names pass, on arrival at a card. The search box takes the focus only when the labeler
  // asked for that (Options, off at start): with the focus in a text field the letter keys type,
  // so the single-key answers (x, u, w ...) would need Esc first.
  function arriveAtCard() {
    if (mode() !== "identify" || !S.searchFirst || !editable() || S.imgFailed || S.finish) return;
    const e = S.idq[S.qIdx];
    if (e && needsIdentity(e) && !(selected() && selected().identity)) { const inp = $("pickerInput"); inp.focus(); inp.select(); renderPicker(); renderChrome(); }
  }

  // next target of the walk; `onlyOpen`: the next one still without an identity
  async function nextInQueue(onlyOpen) {
    for (let k = S.qIdx + 1; k < S.idq.length; k++) {
      if (!onlyOpen || needsIdentity(S.idq[k])) { await gotoQueue(k); return; }
    }
    if (onlyOpen) {
      const k = S.idq.findIndex((e) => needsIdentity(e));
      if (k >= 0) { await gotoQueue(k); return; }
    }
    const open = S.idq.some((e) => needsIdentity(e));
    setStatus(open ? "This is the last card. Some cards before it have no answer yet: Space goes to the next one." : "Every card of this set has an answer.");
    render();
    if (!open) { await flushSave(); if (!S.failed.size) await showFinish(); }
  }

  // ---- the list of names: search, filters, grid, previews (names.js) ------------------------

  const NP = Names.panel({ S, $, SG, mode, editable, gateState, setStatus, selected, noTargetMessage, vCenter, vItem, verifyAnswer, mutate,
    zoomStage, renderChrome, renderToolbar, cardWho, lsSet, LS });
  const NF = Names.wholeFrame({ S, $, img: () => S.img, frameSize, sizeCanvas, voidColor: T.void, render, focus: () => focusEditor() });
  const { openPicker, closePicker, choose, pickHighlighted, clearSearch, cardKind, artSrc, setArt, renderPicker, searchState, pickerKey,
    kindChips, renderFilters, setFilter, clearFilters, onFilterKey, openPrintingEditor, closePrintingEditor, commitPrinting,
    setHoverArt, hideHoverPreview, showHoverPreview } = NP;

  // ---- recording tags -----------------------------------------------------------------------

  // The form's words for the stored fields and values (the stored ones are in FORMAT.md).
  const REC_LABEL = { source: "Kind of footage", physicalGroup: "Filmed with", cameraAngle: "Camera angle", stability: "Camera movement",
    lighting: "Lighting", upscaled: "Enlarged from a smaller picture", sourceResolution: "Size as recorded", language: "Language of the cards",
    client: "Name of the digital client", annotator: "Labeled by" };
  const REC_VALUE = { digital: "digital: a game client", physical: "physical: a filmed table", tournament: "a tournament camera", webcam: "a webcam",
    phone: "a phone", overhead: "from above", oblique: "at an angle", steady: "steady", "some-motion": "some movement", moving: "moving",
    even: "even", uneven: "uneven", low: "low", yes: "yes", no: "no", unknown: "not known" };

  function renderRecording() {
    const f = $("recForm");
    f.innerHTML = "";
    const rec = (S.meta && S.meta.recording) || {};
    const enums = S.config.enums.recording;
    const note = document.createElement("div");
    note.className = "recNote muted";
    note.textContent = "Optional: it helps to sort footage later. Labeling does not wait for it.";
    f.appendChild(note);
    const add = (k, el) => {
      const l = document.createElement("label"); l.textContent = REC_LABEL[k] || k; l.htmlFor = `rec-${k}`; f.appendChild(l);
      el.name = k; el.id = `rec-${k}`; f.appendChild(el);
    };
    for (const k of Object.keys(enums)) {
      const s = document.createElement("select");
      s.appendChild(Object.assign(document.createElement("option"), { value: "", textContent: "not said" }));
      for (const v of enums[k]) s.appendChild(Object.assign(document.createElement("option"), { value: v, textContent: REC_VALUE[v] || v }));
      s.value = rec[k] || "";
      add(k, s);
    }
    for (const k of S.config.enums.recordingFree) {
      const i = document.createElement("input");
      i.placeholder = k === "sourceResolution" ? "such as 720p or 1920x1080" : k === "language" ? "such as en" : "";
      i.value = rec[k] || "";
      add(k, i);
    }
    const ann = document.createElement("input");
    ann.value = (S.meta && S.meta.annotator) || "";
    add("annotator", ann);
    const b = document.createElement("button");
    b.type = "submit"; b.textContent = "Save"; b.disabled = !writable() || S.otherRun;
    f.appendChild(b);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const recording = {};
      for (const el of f.elements) if (el.name && el.name !== "annotator" && el.value) recording[el.name] = el.value;
      const r = await fetch(`/api/labels/${encodeURIComponent(S.set.setId)}/meta`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: saveBody({ recording, annotator: f.elements.annotator.value }),
      });
      const j = await r.json();
      if (SG.isOtherRun(r.status, j) && await checkRun() === "adopt") { f.requestSubmit(); return; } // the same work, started again: once more
      if (!r.ok) { setStatus(`Not saved: ${j.error}`); return; }
      S.meta = j.meta; setStatus("Saved what you said about this recording."); renderRecording();
    };
    const missing = Object.keys(enums).concat(["sourceResolution"]).filter((k) => !rec[k] && !(k === "physicalGroup" && rec.source !== "physical"));
    $("recState").textContent = missing.length ? `· optional, ${missing.length} not filled in` : "· filled in";
  }

  // ---- saving + timing ----------------------------------------------------------------------

  function setSaveState(s) { S.saveKind = s; renderSaveState(); updateFrameStrip(); reportUnsaved(false); }

  // The server is told whether this page holds unsaved changes: at once when that changes, and
  // with every heartbeat. It switches to another pass only while no page says so (savegate.js).
  let reportedUnsaved = null;
  function reportUnsaved(always) {
    if (!S.config || !S.config.run || S.otherRun) return;
    const n = SG.unsavedCount({ failed: S.failed.size, pending: !!S.pendingSave || S.saveKind === "unsaved", saving: S.saveKind === "saving" });
    if (!always && n === reportedUnsaved) return;
    reportedUnsaved = n;
    fetch("/api/tabs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run: S.config.run, tab: TAB, unsaved: n }) })
      .catch(() => { reportedUnsaved = null; });
  }

  // Every change of a frame comes through here on its way to the server, and through nowhere
  // else. The gate (savegate.js) is asked once more: a control that changed a frame without
  // asking `editable()` first still saves nothing.
  function scheduleSave() {
    const name = currentFrame().name;
    const gate = SG.maySave(gateState(), name);
    if (!gate.ok) { refuseChange(name, gate); return; }
    setSaveState("unsaved");
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => { saveFrame(name).then(retryFailed); }, 300);
    S.pendingSave = name;
  }

  // A change the gate refuses. On a frame whose picture did not load the row goes back to what
  // is stored (nothing sticks to a frame nobody saw); on a page of another run the change stays
  // on the page and is named in the banner as not saved.
  function refuseChange(name, gate) {
    if (gate.why === "no-picture" && S.imgFailed && S.imgFailed.name === name && S.imgFailed.row !== undefined) {
      const was = JSON.parse(S.imgFailed.row);
      if (was) S.rows.set(name, was); else S.rows.delete(name);
      S.undo.delete(name); S.redo.delete(name); S.carried.delete(name);
    } else if (gate.why === "other-run") {
      S.failed.set(name, SG.OTHER_RUN);
    }
    setStatus(gate.text);
    renderSaveProblems();
  }

  // The pending autosave, then every frame whose save failed (frame change, set change, confirm).
  async function flushSave() {
    if (S.pendingSave) { clearTimeout(S.saveTimer); await saveFrame(S.pendingSave); }
    await retryFailed();
  }

  async function retryFailed() {
    for (const name of Array.from(S.failed.keys())) if (name !== S.pendingSave) await saveFrame(name);
  }

  function frameUrl(name) { return `/api/labels/${encodeURIComponent(S.set.setId)}/frames/${encodeURIComponent(name)}`; }
  // Every save says which run of the tool this page was loaded from.
  function saveBody(body) { return JSON.stringify(SG.saveBody(S.config.run, body)); }

  function unsavedNow() { return S.failed.size > 0 || !!S.pendingSave || S.saveKind === "saving" || S.saveKind === "unsaved"; }

  // The tool that answers may be another run than the one this page was loaded from (`now`:
  // /api/config as just read, or nothing to ask for it). savegate.js decides: go on, go on under
  // the new run's identity (the same work was started again), load the page again (other work,
  // nothing unsaved here), or stop saving and say so (other work, and changes wait here).
  async function checkRun(now) {
    if (!now) {
      try { now = await getJSON("/api/config?ping=1"); } catch (e) { return "go-on"; } // no answer: the connection indicator says so
    }
    const act = SG.onRun(S.config, now, unsavedNow());
    if (act === "go-on") return act;
    if (act === "reload") { window.location.reload(); return act; }
    const was = S.otherRun;
    if (act === "adopt") { S.config.run = now.run; S.otherRun = false; }
    else S.otherRun = true;
    if (was !== S.otherRun) { // the page's controls follow: off on a page that saves nothing more
      renderToolbar();
      S.chromeSig = null;
      render();
    }
    renderSaveProblems();
    return act;
  }

  // A save that fails is kept: the frame stays in S.failed (retried later) and a red banner names
  // it until it saves; the header keeps "error" meanwhile, even when another frame saves.
  async function saveFrame(name) {
    if (!writable() || !S.set) return;
    const waited = S.pendingSave === name;
    if (waited) S.pendingSave = null;
    const row = S.rows.get(name);
    if (!row) return;
    const gate = SG.maySave(gateState(), name); // the same gate again: nothing reaches the server past it
    if (!gate.ok) {
      if (gate.why === "other-run" && (waited || S.failed.has(name))) S.failed.set(name, SG.OTHER_RUN);
      renderSaveProblems();
      return;
    }
    setSaveState("saving");
    const setId = S.set.setId;
    try {
      if (mode() === "identify") settleEditProvenance(row);
      const r = await fetch(frameUrl(name), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: saveBody({ frame: row }),
      });
      let j = {};
      try { j = await r.json(); } catch (e) { j = { error: `HTTP ${r.status}` }; }
      if (SG.isOtherRun(r.status, j)) {
        // the tool was started again since this page was loaded: this change is not saved. It is
        // kept; whether it can still be saved depends on what the tool runs now.
        S.failed.set(name, SG.OTHER_RUN);
        renderSaveProblems();
        if (await checkRun() === "adopt") return saveFrame(name);
        return;
      }
      if (!r.ok) {
        // identify mode: a refused turn goes back (answers kept) and the frame saves again
        if (r.status === 409 && mode() === "identify" && S.set && S.set.setId === setId && revertRefusedTurns(name, j.error || `HTTP ${r.status}`)) {
          S.failed.delete(name);
          return saveFrame(name);
        }
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      if (!S.set || S.set.setId !== setId) return;
      S.failed.delete(name);
      S.meta = j.meta;
      if (mode() === "identify") settleTurnBase(name, j.frame);
      if (mode() === "verify") settleVerifyStamps(row, j.frame);
      // merge the server's derived geometry (targets unchanged since the request)
      for (const st of (j.frame.targets || [])) {
        const lt = (row.targets || []).find((t) => t.id === st.id);
        if (lt && JSON.stringify(lt.corners) === JSON.stringify(st.corners)) lt.derived = st.derived;
      }
    } catch (e) {
      // no answer at all (the server is not running) reads better than the browser's own words
      if (S.set && S.set.setId === setId) S.failed.set(name, e instanceof TypeError ? "the server did not answer" : e.message);
      if (e instanceof TypeError) heartbeat();
    }
    renderSaveProblems();
    if (!S.failed.has(name)) render(); // outside the try: a drawing error is not a save that failed
  }

  // verify mode: readabilityAt / revealedAt are the server's (readability first); a readability the
  // server kept after a clear (the proposals were shown) comes back too
  function settleVerifyStamps(row, srv) {
    const byId = new Map(((srv && srv.centers) || []).map((c) => [c.id, c]));
    for (const c of row.centers || []) {
      const sc = byId.get(c.id);
      if (!sc) continue;
      for (const k of ["readabilityAt", "revealedAt"]) { if (k in sc) c[k] = sc[k]; else delete c[k]; }
      if (sc.revealedAt && sc.eligible && !c.eligible) { c.eligible = sc.eligible; c.blind = sc.blind; }
    }
  }

  function renderSaveProblems() {
    renderSaveBanner();
    setSaveState(S.failed.size || S.otherRun ? "error" : S.pendingSave ? "unsaved" : "saved");
  }

  // The banner: a server that has stopped, and frames that did not save (kept on the page and
  // tried again). A record of working times that could not be written is said apart and quietly,
  // on the save indicator: the labels are not affected by it.
  function renderSaveBanner() {
    const b = $("saveBanner");
    const stopped = S.connected ? "" : "The labeling server has stopped, so nothing new can be saved. Start it again with the same command and keep this tab open.";
    const frames = S.failed.size
      ? `NOT SAVED: ${Array.from(S.failed, ([n, err]) => `${n} (${err})`).join(" · ")}. The page keeps these changes and tries again on the next save and on every frame change. Keep this tab open until this message goes away.`
      : "";
    // a page of another run: what was not saved, and what to do about it (the words are savegate.js's)
    const text = S.otherRun ? SG.stopText({ unsaved: Array.from(S.failed.keys()), launch: S.config.launch })
      : [stopped, frames].filter(Boolean).join("   ");
    b.hidden = !text;
    if (b.textContent !== text) b.textContent = text;
    const timing = S.timing && S.timing.state.problem;
    $("saveState").title = timing ? `The record of when you worked is not being written (${timing}). The labels are not affected.` : "Whether every change is saved";
  }

  // Page closing: the pending autosave and any failed frame go out as beacons (serve.py takes
  // them as ordinary POSTs; a beacon's answer is never read, so a refusal is not reported here).
  function flushSavesBeacon() {
    if (!writable() || !S.set || !navigator.sendBeacon) return;
    const names = new Set(S.failed.keys());
    if (S.pendingSave) { clearTimeout(S.saveTimer); names.add(S.pendingSave); }
    for (const name of names) {
      const row = S.rows.get(name);
      if (row && SG.maySave(gateState(), name).ok) navigator.sendBeacon(frameUrl(name), new Blob([saveBody({ frame: row })], { type: "application/json" }));
    }
  }

  // An event belongs to the set open when it happened (timinglog.js posts it there even after a
  // set switch).
  function logEvent(ev) {
    if (!writable() || !S.set || !S.timing) return;
    const f = currentFrame();
    // review: true while the review walk is on (report_throughput.py books that time to it)
    S.timing.push(S.set.setId, Object.assign({ ts: Date.now(), mode: mode(), frame: f ? f.name : null }, reviewOn() ? { review: true } : {}, ev));
  }

  // Every 3 s, on a set switch, when the tab is hidden; beacon=true when the page closes.
  // No keepalive here and the answer is always read: see timinglog.js for why.
  function flushTiming(beacon) {
    if (!S.timing) return Promise.resolve();
    if (beacon) { S.timing.flushBeacon(); return Promise.resolve(); }
    return S.timing.flush();
  }

  function timingUrl(setId) { return `/api/timing/${encodeURIComponent(setId)}`; }

  // The queue keeps a batch whose post throws, and tries it again: so it does on a page of
  // another run, whose record of working times is written once the page may save again.
  async function postTiming(setId, body) {
    if (S.otherRun) throw new Error(SG.OTHER_RUN);
    const r = await fetch(timingUrl(setId), { method: "POST", headers: { "Content-Type": "application/json" }, body });
    let j = {};
    try { j = await r.json(); } catch (e) { j = {}; }
    if (SG.isOtherRun(r.status, j)) { await checkRun(); throw new Error(SG.OTHER_RUN); }
    return { status: r.status, error: j.error };
  }

  function beaconTiming(setId, body) {
    return !!navigator.sendBeacon && navigator.sendBeacon(timingUrl(setId), new Blob([body], { type: "application/json" }));
  }

  function setStatus(msg) { $("status").textContent = msg || ""; }

  // ---- rendering ----------------------------------------------------------------------------

  function render() {
    if (!S.set || !currentFrame()) return;
    const f = currentFrame();
    const row = rowFor(f);
    const at = [S.set.setId, f.name, mode() === "verify" ? "v" + S.vIdx : mode() === "point" ? "p" + S.pIdx : S.selId] + "";
    if (at !== S.filterAt) { S.filters = Filters.filtersAt(S.filterAt, at, S.filters); S.filterAt = at; renderFilters(); renderPicker(); }
    const needFix = S.frames.filter((x) => issuesOf(x.name, x.name === f.name).length).length;
    $("frameInfo").textContent = U.frameLabel(S.frameIdx + 1, S.frames.length);
    $("frameInfo").title = `${f.name}, at ${f.t} s in the video${row.done ? ", done" : ""}`;
    Names.renderSource(document, $("recSource"), Names.sourceLine(Object.assign({}, S.set.source, f), f.t)); // where it comes from
    const issues = issuesOf(f.name);
    $("frameIssue").hidden = !issues.length;
    $("frameIssue").textContent = issues.length ? `Needs a fix: ${issues.join(" · ")}` : "";
    // one state for every progress display: the top bar and the set menu read the same counts
    syncCounts();
    $("progress").textContent = U.progress({ counts: setCounts(S.set), needFix });
    if (S.imgFailed) renderFailedFrame();
    else {
      $("notice").hidden = true;
      applyStage();
      if (reviewOn()) renderReview(row);
      else if (mode() === "point") renderPoint(row);
      else if (mode() === "identify") renderIdentify(row);
      else if (mode() === "center" && C) renderCenter(row);
      else if (mode() === "verify") renderVerify(row);
      else renderCorner(row);
      if (mode() === "center") renderCenterInspector(row);
      else if (mode() === "verify") renderVerifyInspector(row);
      else renderInspector(row);
    }
    if (mode() === "box") { $("confirmedToggle").checked = !!row.done; renderDefaultBox(); }
    updateFrameStrip();
    renderChrome();
  }

  // A frame whose picture did not load: one card that says so and names the file; the frame is
  // not drawn and cannot be labeled or confirmed (onKey lets only the frame keys through).
  function renderFailedFrame() {
    $("pointStage").hidden = true; $("cornerStage").hidden = true;
    $("overviewWrap").hidden = true; $("eligWrap").hidden = true;
    $("inspector").innerHTML = "";
    const f = S.imgFailed;
    const el = $("notice");
    const sig = JSON.stringify(f);
    if (el.dataset.sig === sig && !el.hidden) return;
    el.dataset.sig = sig;
    el.innerHTML = `<h1><span class="mark bad" aria-hidden="true">×</span> The picture of this frame did not load</h1><p class="what"></p><pre></pre><p>Put the frame's file there, or correct the sample file, then try again. Until its picture loads, this frame cannot be labeled or confirmed, and nothing is saved for it.</p><div class="row"><button type="button" class="primary" data-act="reload-frame"><span>Try loading the picture again</span></button></div>`;
    el.querySelector(".what").textContent = `${U.frameLabel(S.frameIdx + 1, S.frames.length)} (${f.name}): ${f.why}. The server looked for:`;
    el.querySelector("pre").textContent = f.path || f.src;
    el.hidden = false;
  }

  function renderToolbar() {
    const m = S.set ? mode() : null;
    // the controls of one pass only (Options, the frame's menu): shown in that pass
    for (const el of document.querySelectorAll(".boxOnly, .centerOnly, .verifyOnly, .namesOnly")) {
      el.hidden = !((m === "box" && el.classList.contains("boxOnly")) || (m === "center" && el.classList.contains("centerOnly"))
        || (m === "verify" && el.classList.contains("verifyOnly")) || (m === "identify" && el.classList.contains("namesOnly")));
    }
    $("frameMenu").hidden = !m || !editable(); // every pass: at least "Remove this frame"
    const noRemove = removeRefusal();
    $("removeFrameBtn").disabled = !S.set || !editable() || !S.frames.length || !!noRemove;
    $("removeFrameWhy").textContent = noRemove || "";
    $("removeFrameWhy").hidden = !noRemove;
    $("searchFirstToggle").checked = S.searchFirst;
    $("verifyBacksToggle").checked = S.vIncludeBacks;
    $("hoverToggle").checked = S.hoverArt;
    $("boxesOnlyToggle").checked = S.boxesOnly;
    document.body.classList.toggle("boxes-only", mode() === "box" && S.boxesOnly);
    $("snapToggle").checked = S.boxSnap;
    $("stackViewToggle").checked = S.stackView;
    // the list of names changes a frame too: out of reach while the frame takes no change
    // (its picture did not load, or this page saves nothing more); a read-only set keeps it to look things up
    const gate = SG.mayEdit(gateState());
    $("names").inert = !gate.ok && gate.why !== "read-only";
    $("confirmedToggle").disabled = !S.set || !editable();
    $("clearFrameBtn").disabled = !S.set || !editable();
    $("snapToggle").disabled = !S.set || !editable();
    const ok = S.set && role() !== "test";
    $("carryToggle").checked = S.carryOn && !!ok;
    $("carryToggle").disabled = !ok || !editable();
    $("carryLabel").className = `boxOnly${ok ? "" : " disabled"}`;
    $("carryLabel").title = ok
      ? "An empty frame that follows a finished one starts with that frame's boxes, so you only fix what moved. X clears the ones you have not touched."
      : "Not in a set made for the final test: its boxes are drawn from the frame alone.";
    $("reviewToggle").checked = reviewOn();
    $("reviewToggle").disabled = !reviewAllowed();
    $("reviewIgnoreToggle").checked = S.review.includeIgnore;
    $("reviewIgnoreToggle").disabled = !reviewAllowed();
  }

  function sizeCanvas(c, cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    c.style.width = `${cssW}px`; c.style.height = `${cssH}px`;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) { c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr); }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  // Draw frame region (fx, fy) centered at `zoom()` screen px per frame px into a cssW × cssH canvas.
  function drawZoom(c, cssW, cssH, fx, fy, zOverride) {
    const ctx = sizeCanvas(c, cssW, cssH);
    const z = zOverride || zoom();
    ctx.fillStyle = T.void; ctx.fillRect(0, 0, cssW, cssH);
    if (!S.img || !S.img.naturalWidth) return ctx;
    const sw = cssW / z, sh = cssH / z;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(S.img, fx - sw / 2, fy - sh / 2, sw, sh, 0, 0, cssW, cssH);
    return ctx;
  }

  // point mode's view zoom: z cycles the set's zoom → half → a quarter (more of
  // the board around the point), Z back; a viewing aid only, the answer is still about the ring's center
  function pointViewZoom() { return zoom() / [1, 2, 4][S.pZoomLevel || 0]; }
  function cyclePointZoom(back) { S.pZoomLevel = Names.cycleLevel(S.pZoomLevel, 3, back); render(); }

  // Hovering the frame on the left shows it enlarged beside it, with the current point / center
  // ringed (context around the zoomed crop).
  function enlargeFocus() {
    if (mode() === "point") { const row = S.rows.get(currentFrame().name); return row && row.points ? row.points[S.pIdx] : null; }
    if (mode() === "verify") return vCenter(vItem());
    return null;
  }
  function showFrameEnlarge() {
    if (!S.img || !S.img.naturalWidth || document.body.classList.contains("names-ui")) return; // the frame is large there already
    const el = $("frameEnlarge"), W = S.img.naturalWidth, H = S.img.naturalHeight;
    const ov = $("overview").getBoundingClientRect();
    const maxW = Math.max(400, ov.left - 24), maxH = window.innerHeight - 24;
    const s2 = Math.min(maxW / W, maxH / H, 1.25), cw = Math.round(W * s2), ch = Math.round(H * s2);
    const ctx = sizeCanvas($("frameEnlargeCanvas"), cw, ch);
    ctx.drawImage(S.img, 0, 0, cw, ch);
    const f = enlargeFocus();
    if (f) {
      const x = f.x * cw, y = f.y * ch;
      ctx.lineWidth = 4; ctx.strokeStyle = T.halo;
      ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = T.target;
      ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.beginPath(); ctx.moveTo(x + dx * 20, y + dy * 20); ctx.lineTo(x + dx * 40, y + dy * 40); ctx.stroke(); }
    }
    el.style.left = `${Math.round(Math.max(12, ov.left - 12 - cw))}px`;
    el.style.top = `${Math.round(Math.max(12, Math.min(ov.top, window.innerHeight - ch - 12)))}px`;
    el.hidden = false;
  }
  function hideFrameEnlarge() { $("frameEnlarge").hidden = true; }

  function renderPoint(row) {
    const [W, H] = frameSize(), c = $("center");
    const p = row.points[S.pIdx];
    const size = Names.pointCropSize(c.clientWidth, c.clientHeight, Names.POINT_STRIP);
    const vz = pointViewZoom();
    if (p) {
      const ctx = drawZoom($("zoomView"), size, size, p.x * W, p.y * H, vz);
      // reticle: a gap ring so the pixel under the pointer stays visible
      ctx.strokeStyle = T.target; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(size / 2, size / 2, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = T.halo; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(size / 2, size / 2, 11, 0, Math.PI * 2); ctx.stroke();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.strokeStyle = T.target; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(size / 2 + dx * 16, size / 2 + dy * 16); ctx.lineTo(size / 2 + dx * 34, size / 2 + dy * 34); ctx.stroke();
      }
    }
    $("pointCaption").textContent = p ? `The point is at the center of the ring · enlarged ${+vz.toFixed(2)}× (Z shows more around it)` : "";
    // the whole frame: the crop's window and every point (names.js)
    NF.paint((fv, big) => {
      const x = fv.ctx, s = size / vz * fv.s;
      if (p) { const a = fv.map([p.x * W, p.y * H]); x.strokeStyle = T.target; x.lineWidth = big ? 2 : 1; x.strokeRect(a[0] - s / 2, a[1] - s / 2, s, s); }
      row.points.forEach((q, n) => {
        const a = fv.map([q.x * W, q.y * H]);
        x.beginPath(); x.arc(a[0], a[1], (n === S.pIdx ? 5 : 3.5) * (big ? 1.5 : 1), 0, Math.PI * 2);
        x.fillStyle = complete(q) ? OUTCOME_COLOR[q.outcome] : (n === S.pIdx ? T.target : T.ink);
        x.fill(); x.strokeStyle = T.void; x.lineWidth = 1; x.stroke();
      });
    }, p ? [p.x * W, p.y * H] : null);
    $("eligWrap").hidden = true;
    $("overviewWrap").hidden = false;
  }


  // The enlarged crop: a square of `cropSide` px, as large as the center allows (`below` px kept
  // under it); in Check names 180 to 420 px as before (names.js cropSize: its enlargement is part
  // of what the readability answer is judged on).
  function cropSide(below) {
    const c = $("center");
    return document.body.classList.contains("names-ui") ? Names.cropSize(c.clientWidth, c.clientHeight)
      : Math.max(300, Math.min(640, c.clientHeight - 60 - below, c.clientWidth - 40));
  }

  // The Names pass: the card's view, the main view of the left pane: the box with a quarter of its
  // size around it, as large as the pane allows (names.js; z / Shift+Z step round 1×, 2×, 4×, the
  // wheel zooms at the pointer, a drag off the box moves it). The part shown is kept per card, so
  // an edit of the box does not move the view; the next card keeps the zoom. S.cv is the person's
  // view; it is clamped only to draw (S.idView), so a pane or window resized does not move it.
  function cropDims() { const st = $("pointStage"), [W, H] = frameSize(); return Object.assign({ W, H, w: Math.max(160, st.clientWidth), h: Math.max(120, st.clientHeight) }, S.cvBox); }
  function zoomCard(back) {
    const t = selected();
    if (!t || !S.cv) return;
    S.cv = Names.cycleZoom(S.cv, cropDims(), back, ...Names.boxMid(t.corners));
    render();
  }

  // Identify mode: the current box on the card's view (other boxes faint, the top marked, its
  // handles where it may be changed), and the whole frame's thumbnail with every box.
  function renderIdentify(row) {
    const t = selected();
    S.idView = null;
    const cv = $("zoomView");
    if (t) {
      const key = `${S.set.setId}/${row.name}#${t.id}`, [W, H] = frameSize();
      if (key !== S.cvAt) { S.cvAt = key; S.cvBox = Names.cardBox(t.corners, W, H); S.cv = Names.fitView(cropDims(), S.cv && S.cv.z); }
      const d = cropDims(), v = S.idView = Names.drawnView(S.cv, d);
      const ctx = drawZoom(cv, d.w, d.h, v.cx, v.cy, v.z);
      const toView = (q) => q.map((p) => G.frameToView(v, p));
      for (const o of row.targets || []) {
        if (o === t) continue;
        tracePoly(ctx, toView(o.corners), 1); ctx.strokeStyle = T.faint; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
      }
      const q = toView(t.corners);
      tracePoly(ctx, q, 1); ctx.strokeStyle = T.target; ctx.lineWidth = 2; ctx.stroke();
      // box sets: the card's top as saved (q[0]→q[1]), as in the review walk
      if (identifyTurnsShown()) drawTopMarker(ctx, q, S.idAltK, d.w, d.h);
      // a box that may be changed here: its handles (corners, and the knob above its top)
      if (identifyTurnsShown() && !namesEditBlocked()) {
        const k = G.frameToView(v, ((p) => [p.x, p.y])(G.knobOf(t, KNOB_PX / v.z)));
        ctx.strokeStyle = T.target; ctx.fillStyle = T.void; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo((q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2); ctx.lineTo(k[0], k[1]); ctx.stroke();
        ctx.beginPath(); ctx.arc(k[0], k[1], 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        for (const c of q) { ctx.fillRect(c[0] - 4, c[1] - 4, 8, 8); ctx.strokeRect(c[0] - 4, c[1] - 4, 8, 8); }
      }
    } else {
      const st = $("pointStage");
      sizeCanvas(cv, st.clientWidth, st.clientHeight).clearRect(0, 0, st.clientWidth, st.clientHeight);
    }
    const aabb = t && t.derived && t.derived.aabb;
    const ang = t && identifyTurnsShown() ? ` · turned ${G.roundAngle(rectOf(t).angle)}°${t.orientationFixedIn ? " (top set in this pass)" : ""}` : "";
    $("pointCaption").textContent = t ? `${aabb ? `The box is ${Math.round(aabb[2])} × ${Math.round(aabb[3])} px in the frame · ` : ""}zoom ${+S.cv.z.toFixed(2)}× (z) · ${S.idView.z.toFixed(2)}× the frame${ang}${t.boxFix ? " · ⚑ flagged to fix" : ""}` : "";
    // the whole frame: every box drawn, the current one thick
    NF.paint((fv, big) => {
      for (const o of row.targets || []) {
        tracePoly(fv.ctx, o.corners.map(fv.map), 1);
        if (o === t) { fv.ctx.strokeStyle = T.halo; fv.ctx.lineWidth = big ? 6 : 4; fv.ctx.stroke(); }
        fv.ctx.strokeStyle = o === t ? T.target : o.ignore || o.outcome === "card-back" ? T.ignored : complete(o) ? OUTCOME_COLOR[o.outcome] : T.ink;
        fv.ctx.lineWidth = o === t ? (big ? 3 : 2) : 1; fv.ctx.stroke();
      }
    }, t ? Names.boxMid(t.corners) : null);
    $("eligWrap").hidden = true;
    $("overviewWrap").hidden = false;
  }

  // Review walk: the box alone, fitted into the view with room around it (identify's fitted zoom),
  // the image as on screen (never derotated), the box in its rotated frame, its top edge as a
  // thick yellow bar with an arrow and "TOP" outside it; the other boxes faint. A deleted box
  // leaves its view (gapView) until Enter goes on or Cmd+Z brings it back.
  function renderReview(row) {
    const img = S.img;
    const W = img.naturalWidth || 1920, H = img.naturalHeight || 1080;
    const f = currentFrame();
    const list = reviewList();
    const t = selected();
    if (t && (!S.review.cur || S.review.cur.id !== t.id || S.review.cur.frame !== f.name)) {
      // an undo brought a box back (selected), or the selection moved: the walk follows it
      const i = list.findIndex((e) => e.frame === f.name && e.id === t.id);
      S.review.cur = { frame: f.name, id: t.id, idx: i >= 0 ? i : S.review.cur ? S.review.cur.idx : 0 };
      S.review.pos.set(S.set.setId, S.review.cur);
    }
    if (t) S.review.gapView = null;
    const vw = Math.max(360, Math.floor($("center").clientWidth - 40));
    const vh = Math.max(300, Math.floor($("center").clientHeight - 70));
    let v = null;
    if (t) {
      const [x0, y0, x1, y1] = G.aabb(t.corners);
      const z = Math.min(G.fitZoom(x1 - x0, vw, zoom(), REVIEW_FILL), G.fitZoom(y1 - y0, vh, zoom(), REVIEW_FILL));
      v = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, z, w: vw, h: vh };
    } else if (S.review.gapView) v = S.review.gapView;
    S.review.view = t ? v : null;
    const zc = $("zoomView");
    if (!v) {
      const ctx = sizeCanvas(zc, vw, vh);
      ctx.fillStyle = T.void; ctx.fillRect(0, 0, vw, vh);
    } else {
      const ctx = drawZoom(zc, v.w, v.h, v.cx, v.cy, v.z);
      const toV = (q) => q.map((p) => G.frameToView(v, p));
      for (const o of row.targets || []) {
        if (o === t) continue;
        tracePoly(ctx, toV(o.corners), 1);
        ctx.setLineDash([4, 4]); ctx.strokeStyle = T.faint; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      }
      if (t) drawReviewBox(ctx, t, toV(t.corners));
      else {
        ctx.font = "bold 16px sans-serif";
        const msg = "Box removed · undo brings it back · Enter goes on";
        const w = ctx.measureText(msg).width + 16;
        ctx.fillStyle = T.halo; ctx.fillRect(v.w / 2 - w / 2, v.h / 2 - 14, w, 28);
        ctx.fillStyle = T.cross; ctx.fillText(msg, v.w / 2 - w / 2 + 8, v.h / 2 + 6);
      }
    }
    // caption: box P012 · 7/43 on this set · frame 3/5 · card / back · name
    const { i, present } = G.reviewLocate(list, S.review.cur);
    if (t) {
      const card = t.identity && t.identity !== "unknown" && S.byId.get(t.identity);
      const kind = t.ignore ? "an ignored box" : t.outcome === "card-back" ? "a card back" : "a card";
      const name = card ? cardWho(card.id) : t.identity === "unknown" ? "unknown card" : t.identity || "";
      const extra = [
        present ? null : "now ignored, so no longer part of the check",
        t.angle ? `turned ${Math.round(t.angle)}°` : null,
        turnedSet().has(key(f.name, t)) ? "top turned here" : null,
        S.prov.has(t.id) ? "changed: Enter confirms it and goes on" : null,
        t.pending && t.prefill ? "a model box not checked yet: Enter accepts it as it is" : null,
        t.boxFix ? "⚑ flagged to fix" : null,
        `enlarged ${v.z < zoom() ? `${v.z.toFixed(2)}× to fit` : `${v.z}×`}`,
      ].filter(Boolean);
      $("pointCaption").textContent = [`Box ${present ? i + 1 : "–"} of ${list.length} in this set`, kind].concat(name ? [name] : []).concat(extra).join(" · ");
    } else {
      $("pointCaption").textContent = "";
    }
    // the frame overview: every box, this one in pink, the zoom view's area
    const ow = PREVIEW_W, oh = Math.round(ow * H / W);
    const octx = sizeCanvas($("overview"), ow, oh);
    octx.drawImage(img, 0, 0, ow, oh);
    const sc = ow / W;
    for (const o of row.targets || []) {
      tracePoly(octx, o.corners, sc);
      octx.strokeStyle = o === t ? T.target : o.ignore || o.outcome === "card-back" ? T.ignored : T.ink;
      octx.lineWidth = o === t ? 2 : 1; octx.stroke();
    }
    if (v) {
      octx.strokeStyle = T.top; octx.lineWidth = 1;
      octx.strokeRect((v.cx - v.w / 2 / v.z) * sc, (v.cy - v.h / 2 / v.z) * sc, v.w / v.z * sc, v.h / v.z * sc);
    }
    $("eligWrap").hidden = true;
    $("overviewWrap").hidden = false;
  }

  // The reviewed box in view px: outline by kind, the top edge (q[0]→q[1]) as a thick yellow bar
  // with an arrow pointing out of the card and "TOP" beyond it; Alt over another edge shows it.
  function drawReviewBox(ctx, t, q) {
    const prov = S.prov.has(t.id);
    const pend = !!(t.pending && t.prefill);
    const col = t.ignore ? T.ignored : t.outcome === "card-back" ? OUTCOME_COLOR["card-back"] : pend ? T.model : OUTCOME_COLOR.card;
    ctx.save();
    tracePoly(ctx, q, 1);
    ctx.setLineDash(prov ? [8, 4] : pend ? [9, 4, 2, 4] : []);
    ctx.strokeStyle = T.halo; ctx.lineWidth = 5; ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.setLineDash([]);
    if (t.ignore) {
      ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]); ctx.lineTo(q[2][0], q[2][1]); ctx.moveTo(q[1][0], q[1][1]); ctx.lineTo(q[3][0], q[3][1]);
      ctx.strokeStyle = T.cross; ctx.lineWidth = 2; ctx.stroke();
    }
    const v = S.review.view;
    drawTopMarker(ctx, q, S.review.altK, v ? v.w : 0, v ? v.h : 0);
    if (t.boxFix) zoomLabel(ctx, t.boxFix.reason === "top" ? "⚑ flagged: fix top" : "⚑ flagged: fix box", 110, 22, T.flag);
    ctx.restore();
  }

  // A label on a zoom view, kept inside it (vw × vh view px; 0 = no bounds).
  function zoomLabel(ctx, text, x, y, color, vw, vh) {
    ctx.font = "bold 18px sans-serif";
    const w = ctx.measureText(text).width + 12;
    if (vw) x = Math.max(w / 2 + 2, Math.min(vw - w / 2 - 2, x));
    if (vh) y = Math.max(15, Math.min(vh - 15, y));
    ctx.fillStyle = T.halo; ctx.fillRect(x - w / 2, y - 13, w, 26);
    ctx.fillStyle = color; ctx.fillText(text, x - w / 2 + 6, y + 6);
  }

  // The card's top on a zoom view (the review walk, identify mode's box sets): the edge
  // q[0]→q[1] as a thick yellow bar, an arrow out of the card and TOP beyond it; `altK` (Alt over
  // an edge, k clockwise from the top) shows that edge in blue. q in view px, view vw × vh.
  function drawTopMarker(ctx, q, altK, vw, vh) {
    ctx.save();
    const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
    const edge = (k, color, width) => {
      const a = q[k], b = q[(k + 1) % 4];
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.lineCap = "round";
      ctx.strokeStyle = T.halo; ctx.lineWidth = width + 4; ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
      ctx.lineCap = "butt";
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const len = Math.hypot(mx - cx, my - cy) || 1;
      return { mx, my, nx: (mx - cx) / len, ny: (my - cy) / len };
    };
    const label = (text, x, y, color) => zoomLabel(ctx, text, x, y, color, vw, vh);
    // the top: bar, arrow out of the card, TOP
    const top = edge(0, T.top, 9);
    const a0 = { x: top.mx + top.nx * 10, y: top.my + top.ny * 10 }, a1 = { x: top.mx + top.nx * 44, y: top.my + top.ny * 44 };
    ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y);
    ctx.strokeStyle = T.halo; ctx.lineWidth = 8; ctx.stroke();
    ctx.strokeStyle = T.top; ctx.lineWidth = 4; ctx.stroke();
    const px = -top.ny, py = top.nx; // along the edge
    ctx.beginPath();
    ctx.moveTo(a1.x + top.nx * 14, a1.y + top.ny * 14);
    ctx.lineTo(a1.x + px * 10, a1.y + py * 10); ctx.lineTo(a1.x - px * 10, a1.y - py * 10); ctx.closePath();
    ctx.fillStyle = T.top; ctx.fill(); ctx.strokeStyle = T.halo; ctx.lineWidth = 2; ctx.stroke();
    label("TOP", a1.x + top.nx * 34, a1.y + top.ny * 34, T.top);
    // Alt over another edge: that one would become the top
    const k = altK;
    if (k !== null && k !== undefined && k !== 0) {
      const e = edge(k, T.selected, 7);
      label("click: this is the top", e.mx + e.nx * 30, e.my + e.ny * 30, T.selected);
    } else if (k === 0) {
      label("already the top", top.mx - top.nx * 30, top.my - top.ny * 30, T.top);
    }
    ctx.restore();
  }

  function fitCorner() {
    const c = $("frameCanvas"), box = $("center");
    const W = S.img.naturalWidth || 1920, H = S.img.naturalHeight || 1080;
    const leg = $("legend"), below = leg.hidden ? 0 : leg.offsetHeight + 12; // the legend sits under the frame, never on it
    $("cornerStage").style.bottom = `${below}px`;
    const s = Math.min((box.clientWidth - 16) / W, (box.clientHeight - below - 16) / H);
    S.view.s = s;
    return sizeCanvas(c, Math.floor(W * s), Math.floor(H * s));
  }

  // ---- the stacking view (O): a visual aid, nothing is saved ----------------------------------
  const STACK_HUES = [205, 35, 140, 290, 0, 95, 250, 170, 320, 60];

  // Every box painted opaque from the bottom layer up on a layer of its own, so each pixel keeps
  // the color of the topmost box over it; the layer is then laid over the frame, see-through.
  function drawStackShade(ctx, ts, s) {
    const c = ctx.canvas;
    const off = document.createElement("canvas");
    off.width = c.width; off.height = c.height;
    const o = off.getContext("2d");
    o.setTransform(ctx.getTransform());
    G.orderAsc(ts).forEach((i, rank) => {
      const t = ts[i];
      if (!Array.isArray(t.corners) || t.corners.length !== 4) return;
      tracePoly(o, t.corners, s);
      o.fillStyle = t.ignore ? "hsl(0, 0%, 45%)" : `hsl(${STACK_HUES[rank % STACK_HUES.length]}, 85%, 55%)`;
      o.fill();
    });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 0.4;
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  }

  // Each box's layer in its stack (boxes joined by overlaps), at the middle of its largest visible rectangle (dashed where it is smaller
  // than the box); a box with under a fifth of it showing is marked: its layer is likely wrong.
  function drawStackLabels(ctx, ts, parts, s) {
    const layers = G.stackLayers(ts);
    ctx.save();
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "bold 15px system-ui, sans-serif";
    ts.forEach((t, i) => {
      const v = parts[i];
      if (!v) return;
      const q = v.corners || t.corners;
      if (!Array.isArray(q)) return;
      if (v.corners && v.share < 1) {
        ctx.setLineDash([4, 3]); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
        tracePoly(ctx, v.corners, s); ctx.stroke(); ctx.setLineDash([]);
      }
      const cx = (q.reduce((a, p) => a + p[0], 0) / 4) * s, cy = (q.reduce((a, p) => a + p[1], 0) / 4) * s;
      const low = !v.corners || v.share < 0.2;
      if (layers[i].size < 2 && !low) return; // a box that overlaps nothing has no layer worth showing
      const label = String(layers[i].layer) + (low ? (v.corners ? " ?" : " hidden") : "");
      ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0, 0, 0, 0.85)"; ctx.strokeText(label, cx, cy);
      ctx.fillStyle = low ? "#ff6b6b" : "#fff"; ctx.fillText(label, cx, cy);
    });
    ctx.restore();
  }

  function tracePoly(ctx, q, s) {
    ctx.beginPath();
    q.forEach((p, i) => (i ? ctx.lineTo(p[0] * s, p[1] * s) : ctx.moveTo(p[0] * s, p[1] * s)));
    ctx.closePath();
  }

  function drawTarget(ctx, t, s, isSel) {
    const q = t.corners;
    const col = t.pending ? T.model : complete(t) ? (OUTCOME_COLOR[t.outcome] || T.confirmed) : T.open;
    tracePoly(ctx, q, s);
    ctx.setLineDash(t.pending ? [6, 3, 2, 3] : []);
    ctx.lineWidth = isSel ? 2.5 : 1.5; ctx.strokeStyle = col; ctx.stroke();
    ctx.setLineDash([]);
    // top edge tick (card's own top) and the first-corner marker
    const mx = (q[0][0] + q[1][0]) / 2 * s, my = (q[0][1] + q[1][1]) / 2 * s;
    const cx = q.reduce((a, p) => a + p[0], 0) / 4 * s, cy = q.reduce((a, p) => a + p[1], 0) / 4 * s;
    ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + (mx - cx) * 0.18, my + (my - cy) * 0.18);
    ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
    q.forEach((p, i) => {
      const est = t.estimated && t.estimated[i];
      ctx.beginPath(); ctx.arc(p[0] * s, p[1] * s, i === 0 ? 6 : (isSel ? 4.5 : 2.5), 0, Math.PI * 2);
      if (est) { ctx.setLineDash([2, 2]); ctx.strokeStyle = T.ink; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); }
      else { ctx.fillStyle = i === 0 ? T.target : col; ctx.fill(); }
      if (isSel && S.selCorner === i) { ctx.strokeStyle = T.ink; ctx.lineWidth = 2; ctx.stroke(); }
    });
    ctx.fillStyle = T.target; ctx.font = "bold 11px sans-serif";
    ctx.fillText("1", q[0][0] * s - 3, q[0][1] * s - 9);
    const card = t.identity && S.byId.get(t.identity);
    const label = t.outcome === "card" ? (card ? card.name : t.identity || "?") : OUTCOME_LABEL[t.outcome] || (t.pending ? "model ?" : "?");
    ctx.font = "12px sans-serif";
    const w = ctx.measureText(label).width + 6;
    ctx.fillStyle = T.halo; ctx.fillRect(cx - w / 2, cy - 8, w, 16);
    ctx.fillStyle = col; ctx.fillText(label, cx - w / 2 + 3, cy + 4);
  }

  // the canvas label: the card's NAME, shortened with an ellipsis to the box's on-screen width;
  // the id only when the identity has no catalog card; "•alt" when a printing is set.
  function boxLabel(ctx, t, maxW) {
    if (t.outcome === "card-back") return "back";
    if (!t.identity) return t.ignore ? "ignored" : "";
    const card = t.identity !== "unknown" && S.byId.get(t.identity);
    const text = card && card.name ? card.name : t.identity;
    const suffix = t.printing ? " (other printing)" : "";
    if (ctx.measureText(text + suffix).width <= maxW) return text + suffix;
    if (maxW <= ctx.measureText("…" + suffix).width) return text + suffix;
    let cut = text;
    while (cut.length > 1 && ctx.measureText(cut + "…" + suffix).width > maxW) cut = cut.slice(0, -1);
    return cut + "…" + suffix;
  }

  // The kinds of box on a frame, each with a line of its own (the legend under the frame shows
  // the same lines) and a word on the box where the line alone would not tell.
  const BOX_LINES = {
    model: { label: "Model suggestion", dash: [7, 3, 2, 3], color: () => T.model },
    kept: { label: "Kept from the previous frame", dash: [12, 4], color: () => T.kept },
    confirmed: { label: "Yours, confirmed", dash: [], color: () => T.confirmed },
    back: { label: "Card back", dash: [], color: () => T.back },
    adjusting: { label: "Being adjusted", dash: [5, 3], color: () => T.adjusting },
    ignored: { label: "Ignored", dash: [2, 3], color: () => T.ignored },
  };
  function boxKind(t, prov, pend, kept) {
    return prov ? "adjusting" : t.ignore ? "ignored" : pend ? "model" : t.outcome === "card-back" ? "back" : kept ? "kept" : "confirmed";
  }

  function drawBox(ctx, t, s, isSel, isExtra) {
    const q = t.corners;
    const prov = S.prov.has(t.id);
    const carried = /^(propagated|carried)/.test(String(t.labelSource || ""));
    const pend = !!(t.pending && t.prefill); // a model's box nobody has checked yet
    // kept from the previous frame and not touched since (an edited one counts as the labeler's own)
    const kept = carried && !/corrected$/.test(String(t.labelSource || "")) && !rowFor(currentFrame()).done;
    const kind = boxKind(t, prov, pend, kept);
    const col = BOX_LINES[kind].color();
    tracePoly(ctx, q, s);
    ctx.setLineDash(BOX_LINES[kind].dash);
    ctx.lineWidth = isSel || isExtra ? 3 : kind === "back" ? 2.5 : 1.5;
    // the selection has a color of its own; a box still being adjusted stays dashed
    ctx.strokeStyle = isSel || isExtra ? T.selected : col;
    ctx.stroke();
    ctx.setLineDash([]);
    if (t.boxFix) {
      ctx.save(); tracePoly(ctx, q, s); ctx.setLineDash([8, 4]); ctx.lineWidth = 4; ctx.strokeStyle = T.flag; ctx.stroke(); ctx.restore();
      const [fx, fy] = G.aabb(q);
      ctx.font = "bold 12px sans-serif"; const lbl = t.boxFix.reason === "top" ? "⚑ fix the top" : "⚑ fix the box";
      ctx.fillStyle = T.halo; ctx.fillRect(fx * s, fy * s + 2, ctx.measureText(lbl).width + 8, 16);
      ctx.fillStyle = T.flag; ctx.fillText(lbl, fx * s + 4, fy * s + 14);
    }
    // ignored (the not-hoverable marker): a red X corner to corner, dark-outlined
    if (t.ignore) {
      ctx.beginPath();
      ctx.moveTo(q[0][0] * s, q[0][1] * s); ctx.lineTo(q[2][0] * s, q[2][1] * s);
      ctx.moveTo(q[1][0] * s, q[1][1] * s); ctx.lineTo(q[3][0] * s, q[3][1] * s);
      ctx.strokeStyle = T.halo; ctx.lineWidth = 4; ctx.stroke();
      ctx.strokeStyle = T.cross; ctx.lineWidth = 2; ctx.stroke();
    }
    // the card's top (the handle side, q[0]→q[1]): a short white tick outward from the middle of
    // the top edge on every box, so a box turned the wrong way shows at a glance
    {
      const mx = (q[0][0] + q[1][0]) / 2 * s, my = (q[0][1] + q[1][1]) / 2 * s;
      const cx = q.reduce((a, p) => a + p[0], 0) / 4 * s, cy = q.reduce((a, p) => a + p[1], 0) / 4 * s;
      const len = Math.hypot(mx - cx, my - cy) || 1, k = Math.min(10, len * 0.25) / len;
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + (mx - cx) * k, my + (my - cy) * k);
      ctx.strokeStyle = T.halo; ctx.lineWidth = 4; ctx.stroke();
      ctx.strokeStyle = T.ink; ctx.lineWidth = 2; ctx.stroke();
    }
    if (S.altEdge && S.altEdge.id === t.id && mode() === "box") {
      const k = S.altEdge.k, a = q[k], b2 = q[(k + 1) % 4];
      ctx.beginPath(); ctx.moveTo(a[0] * s, a[1] * s); ctx.lineTo(b2[0] * s, b2[1] * s);
      ctx.strokeStyle = T.halo; ctx.lineWidth = 7; ctx.stroke();
      ctx.strokeStyle = T.top; ctx.lineWidth = 4; ctx.stroke();
      ctx.font = "bold 11px sans-serif"; ctx.fillStyle = T.top;
      ctx.fillText(k ? "click: top" : "top", ((a[0] + b2[0]) / 2) * s + 6, ((a[1] + b2[1]) / 2) * s - 6);
    }
    if (isSel && !isMulti()) {
      ctx.fillStyle = T.ink;
      for (const p of G.handlePoints(t)) ctx.fillRect(p[0] * s - 3, p[1] * s - 3, 6, 6);
      if (editable() && mode() === "box") {
        const top = G.knobOf(t, 0), knob = G.knobOf(t, KNOB_PX / s);
        ctx.beginPath(); ctx.moveTo(top.x * s, top.y * s); ctx.lineTo(knob.x * s, knob.y * s);
        ctx.strokeStyle = T.ink; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.arc(knob.x * s, knob.y * s, 5, 0, Math.PI * 2); ctx.fillStyle = T.selected; ctx.fill();
      }
    }
    ctx.font = "11px sans-serif";
    const [x0, y0, x1] = G.aabb(q);
    let label = boxLabel(ctx, t, Math.max(24, (x1 - x0) * s - 6)) + (t.angle ? ` ${Math.round(t.angle)}°` : "");
    if (pend) {
      const sc = typeof t.prefill.score === "number" ? ` ${t.prefill.score.toFixed(2)}` : "";
      label = `${t.suggestion ? "? " : ""}model${sc}${label.trim() ? " · " + label.trim() : ""}`;
    } else if (kept && !prov) label = `kept${label.trim() ? " · " + label.trim() : ""}`;
    if (label.trim()) {
      const w = ctx.measureText(label).width + 6;
      ctx.fillStyle = T.halo; ctx.fillRect(x0 * s, y0 * s - 15, w, 14);
      ctx.fillStyle = t.ignore ? T.cross : col; ctx.fillText(label, x0 * s + 3, y0 * s - 4);
    }
  }

  // A card that moved: an arrow from its kept box to the model's box.
  function drawMovedPair(ctx, a, b, s) {
    const ra = rectOf(a), rb = rectOf(b), mx = (ra.cx + rb.cx) * s / 2, my = (ra.cy + rb.cy) * s / 2, lbl = "moved? M moves its box";
    ctx.save(); ctx.beginPath();
    for (const [p, q] of G.arrow(ra.cx * s, ra.cy * s, rb.cx * s, rb.cy * s)) { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); }
    ctx.strokeStyle = T.halo; ctx.lineWidth = 5; ctx.stroke();
    ctx.setLineDash([6, 4]); ctx.strokeStyle = T.kept; ctx.lineWidth = 2; ctx.stroke();
    ctx.font = "bold 11px sans-serif"; const w = ctx.measureText(lbl).width + 8;
    ctx.fillStyle = T.halo; ctx.fillRect(mx - w / 2, my - 9, w, 16); ctx.fillStyle = T.kept; ctx.fillText(lbl, mx - w / 2 + 4, my + 3);
    ctx.restore();
  }

  function renderCorner(row) {
    const ctx = fitCorner();
    const s = S.view.s;
    ctx.drawImage(S.img, 0, 0, S.img.naturalWidth * s, S.img.naturalHeight * s);
    if (mode() === "box") {
      const ts = row.targets || [];
      const sel = new Set(selectedIds());
      const parts = S.stackView ? G.visibleParts(ts) : null;
      if (parts) drawStackShade(ctx, ts, s);
      for (const i of G.orderAsc(ts)) drawBox(ctx, ts[i], s, ts[i].id === S.selId, sel.size > 1 && sel.has(ts[i].id));
      if (parts) drawStackLabels(ctx, ts, parts, s);
      if (!reviewOn()) for (const q of movedPairsOf(row)) drawMovedPair(ctx, targetById(row, q.kept), targetById(row, q.suggestion), s);
      const d = S.bdrag;
      if (d && (d.mode === "draw" || d.mode === "marquee") && d.moved) {
        ctx.setLineDash(d.mode === "draw" ? [5, 3] : [2, 3]); ctx.strokeStyle = d.mode === "draw" ? T.adjusting : T.ink; ctx.lineWidth = 1.5;
        ctx.strokeRect(Math.min(d.start.x, d.cur.x) * s, Math.min(d.start.y, d.cur.y) * s, Math.abs(d.cur.x - d.start.x) * s, Math.abs(d.cur.y - d.start.y) * s);
        ctx.setLineDash([]);
      }
      if (S.newBoxMode && S.mouse) {
        const { w, h } = S.defaultBox;
        ctx.setLineDash([4, 3]); ctx.strokeStyle = T.confirmed; ctx.lineWidth = 1;
        ctx.strokeRect((S.mouse.x - w / 2) * s, (S.mouse.y - h / 2) * s, w * s, h * s);
        ctx.setLineDash([]);
      }
    } else {
      for (const t of row.targets || []) (isBoxTarget(t) ? drawBox : drawTarget)(ctx, t, s, t.id === S.selId);
    }
    if (S.placing) {
      const pc = S.placing.corners;
      ctx.strokeStyle = T.target; ctx.lineWidth = 1.5;
      ctx.beginPath();
      pc.forEach((p, i) => (i ? ctx.lineTo(p[0] * s, p[1] * s) : ctx.moveTo(p[0] * s, p[1] * s)));
      if (S.mouse) ctx.lineTo(S.mouse.x * s, S.mouse.y * s);
      ctx.stroke();
      pc.forEach((p, i) => {
        ctx.beginPath(); ctx.arc(p[0] * s, p[1] * s, i === 0 ? 6 : 4, 0, Math.PI * 2);
        if (S.placing.estimated[i]) { ctx.strokeStyle = T.ink; ctx.stroke(); } else { ctx.fillStyle = T.target; ctx.fill(); }
      });
      const names = ["top-left", "top-right", "bottom-right", "bottom-left"];
      setStatus("");
    }
    // fixed-zoom view of the selected target
    const t = selected();
    $("eligWrap").hidden = !t;
    if (t) {
      const cx = t.corners.reduce((a, p) => a + p[0], 0) / 4, cy = t.corners.reduce((a, p) => a + p[1], 0) / 4;
      const ew = PREVIEW_W, eh = 200;
      const ectx = drawZoom($("eligView"), ew, eh, cx, cy);
      const z = zoom();
      tracePoly(ectx, t.corners.map((p) => [(p[0] - cx) + ew / 2 / z, (p[1] - cy) + eh / 2 / z]), z);
      ectx.strokeStyle = T.target; ectx.lineWidth = 1; ectx.stroke();
    }
    // overview is the main canvas in this mode
    $("overviewWrap").hidden = true;
    renderLoupe();
  }

  function renderLoupe() {
    if (mode() === "center" && C) { renderCenterLoupe(); return; }
    const l = $("loupe");
    l.classList.remove("left");
    const d = S.bdrag;
    const show = !zoomStage() && S.mouse && (S.placing || S.drag || (d && d.moved && (d.mode === "draw" || d.mode === "resize")));
    l.hidden = !show;
    if (!show) return;
    const ctx = l.getContext("2d");
    const z = 4, sw = l.width / z;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = T.void; ctx.fillRect(0, 0, l.width, l.height);
    ctx.drawImage(S.img, S.mouse.x - sw / 2, S.mouse.y - sw / 2, sw, sw, 0, 0, l.width, l.height);
    ctx.strokeStyle = T.target; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(l.width / 2, 0); ctx.lineTo(l.width / 2, l.height); ctx.moveTo(0, l.height / 2); ctx.lineTo(l.width, l.height / 2); ctx.stroke();
  }

  function chip(label, on, onClick) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; if (on) b.className = "on";
    b.addEventListener("click", onClick);
    return b;
  }

  const MADE_BY = { manual: "you, by hand", "prefill-accepted": "the model, accepted as it was", "prefill-corrected": "the model, then corrected by you",
    carried: "kept from the frame before", "carried-corrected": "kept from the frame before, then corrected",
    propagated: "a tracking script", "propagated-corrected": "a tracking script, then corrected" };
  const SRC_LABEL = { "current-frame": "this frame", "later-close-up": "a later close-up", decklist: "the deck list", other: "other" };

  // The selected box or card: what it is, and under Details its tags and how it was made. The
  // tags keep their keys whether Details is open or not.
  function renderInspector(row) {
    const box = $("inspector");
    box.innerHTML = "";
    if (isMulti()) return; // the instruction line says what several selected boxes take
    const t = selected();
    if (!t) return;
    const boxy = mode() === "box";
    const card = t.identity && S.byId.get(t.identity);
    const head = document.createElement("div");
    head.className = "idrow";
    const img = document.createElement("img");
    if (card) setArt(img, t.printing || card.id); else img.classList.add("no-art");
    const txt = document.createElement("div");
    const title = t.ignore ? "Ignored box" : t.outcome === "card" ? (card ? card.name : t.identity === "unknown" ? "Unknown card" : t.identity || (boxy ? "Card" : "Card without a name yet"))
      : t.outcome === "card-back" ? "Card back" : t.outcome === "not-card" ? "Not a card" : t.outcome === "unreadable" ? "A card that cannot be read" : "No answer yet";
    txt.innerHTML = `<div><b></b></div><div class="muted"></div><div></div>`;
    txt.children[0].firstChild.textContent = card && t.outcome === "card" && !t.ignore ? cardWho(card.id) : title;
    txt.children[1].textContent = card ? cardKind(card, t.printing) : t.printing ? `printing ${t.printing}` : "";
    txt.children[2].innerHTML = boxy && S.prov.has(t.id) ? `<span class="req">◌ Being adjusted</span>`
      : boxy && t.pending && t.prefill ? `<span class="req">◌ The model's ${t.suggestion ? "suggestion" : "box"}, not checked yet</span>`
      : complete(t) ? `<span class="done">✓ ${boxy ? "Confirmed" : "Complete"}</span>` : `<span class="req">◌ Needs an answer</span>`;
    head.append(img, txt);
    box.appendChild(head);
    const det = document.createElement("details");
    det.open = lsGet("labeler-details") === "open";
    det.addEventListener("toggle", () => lsSet("labeler-details", det.open ? "open" : "closed"));
    det.appendChild(Object.assign(document.createElement("summary"), { textContent: "Details" }));
    const f = document.createElement("div");
    f.className = "fields";
    const add = (k, node) => { const a = document.createElement("div"); a.className = "k"; a.textContent = k; f.appendChild(a); f.appendChild(node); };
    const chips = (vals, cur, fn, labels) => { const d = document.createElement("div"); d.className = "chips"; vals.forEach((v, i) => d.appendChild(chip(labels ? labels[i] : v, cur === v, () => fn(v)))); return d; };
    const text = (s) => Object.assign(document.createElement("div"), { textContent: s });
    // in the Boxes pass these tags are optional and set by a click; elsewhere each has its key
    const k = (label, keyName) => (boxy ? label : `${label} (${keyName})`);
    if (boxy && !S.boxesOnly) add("Name", text(t.identity ? (card ? card.name : t.identity === "unknown" ? "Unknown card" : t.identity) : "None yet: / searches, U marks it unknown"));
    if (mode() === "box" || mode() === "identify") add(k("Other printing", "A"), text(t.printing || "—"));
    add(k("How you knew", "O"), chips(SRC, t.identitySource, (v) => mutate((x) => { x.identitySource = v; }), SRC.map((v) => SRC_LABEL[v] || v)));
    add("Readable", chips(["yes", "uncertain", "no"], t.eligible, setEligible, boxy ? ["yes", "unsure", "no"] : ["yes (Y)", "unsure (M)", "no (N)"]));
    const c = t.conditions || {};
    const tri = (cond) => chips([true, false], c[cond], (v) => mutate((x) => setCond(x, cond, c[cond] === v ? null : v)), ["yes", "no"]);
    add(k("Face up", "C"), tri("faceUp"));
    add(k("Showing", "V"), chips(VIS, c.visibleShare, (v) => mutate((x) => setCond(x, "visibleShare", c.visibleShare === v ? null : v))));
    add(k("Blur", "L"), tri("blur"));
    add(k("Glare", "G"), tri("glare"));
    add(k("Sleeve or foil", "K"), tri("sleeveOrFoil"));
    const from = G.isCarried(t) ? (t.carriedFrom || t.propagatedFrom).frame : null;
    const fromN = from ? S.frames.findIndex((x) => x.name === from) + 1 : 0;
    add("Made by", text(t.labelSource ? `${MADE_BY[t.labelSource] || t.labelSource}${fromN ? ` (frame ${fromN})` : ""}` : t.pending ? "the model, not checked yet" : "—"));
    if (t.prefill && setMode() === "box") {
      const p = t.prefill;
      add("The model said", text([p.outcome === "card-back" ? "a card back" : "a card", typeof p.score === "number" ? `score ${p.score.toFixed(3)}` : null,
        t.suggestion ? "offered where no box was kept" : null, p.flag || null].filter(Boolean).join(" · ")));
    } else if (t.prefill) {
      const pc = t.prefill.cardId && S.byId.get(t.prefill.cardId);
      add("The model said", text(`${pc ? pc.name : t.prefill.cardId || "no name"}${t.prefill.flag ? " · " + t.prefill.flag : ""}${typeof t.prefill.margin === "number" ? " · margin " + t.prefill.margin.toFixed(3) : ""}`));
    }
    if (t.corners && isBoxTarget(t)) {
      const r = rectOf(t);
      const ts = row.targets || [];
      const layer = G.orderAsc(ts).indexOf(ts.indexOf(t)) + 1;
      const pf = t.propagatedFrom && !G.isCarried(t) ? ` · from ${t.propagatedFrom.frame} (score ${t.propagatedFrom.score})` : "";
      add("Size and place", text(`${Math.round(r.w)} × ${Math.round(r.h)} px, centered at (${Math.round(r.cx)}, ${Math.round(r.cy)})${t.angle ? ` · turned ${t.angle}°` : ""}${G.isQuad(t) ? " · free corners (E: a rectangle again)" : ""} · layer ${layer} of ${ts.length}${pf}`));
    } else if (t.corners) {
      const d = t.derived;
      add("Measured", text(d ? `short side ${d.shortSidePx} px${d.shortSideSourcePx ? " (" + d.shortSideSourcePx + " in the recording)" : ""} · turned ${d.rotationDeg}° · seen flat ${d.foreshortening}${d.clockwise ? "" : " · CORNERS RUN THE WRONG WAY"}` : "(saving…)"));
      add("Placed by guess (E)", text((t.estimated || []).map((v, i) => (v ? ["top-left", "top-right", "bottom-right", "bottom-left"][i] : null)).filter(Boolean).join(", ") || "no corner"));
    }
    det.appendChild(f);
    box.appendChild(det);
  }

  function keyTable(rows) { return `<table>${rows.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join("")}</table>`; }

  function renderKeys() {
    const m = S.set ? mode() : S.config ? S.config.mode : null;
    const title = (t) => `<div class="keyTitle">${t}</div>`;
    let html = "";
    if (reviewOn()) html = keyTable(U.KEYS_REVIEW);
    else if (m === "verify") html = keyTable(U.KEYS_VERIFY);
    else if (m === "center") html = keyTable(U.KEYS_CENTER);
    else if (m === "box") html = (prefillActive() ? title("The model's suggestions") + keyTable(U.KEYS_PREFILL) + title("Every box") : "") + keyTable(U.KEYS_BOX);
    else if (m === "identify") html = keyTable(U.KEYS_IDENTIFY);
    else if (m === "point") html = keyTable(U.KEYS_ANSWER.concat(U.KEYS_POINT));
    else if (m) html = keyTable(U.KEYS_ANSWER.concat(U.KEYS_CORNER));
    $("keyHelp").innerHTML = html;
  }

  // ---- center mode (a center census) ---------------------------------------------
  // The whole frame fitted to the center pane (as box mode). A click adds a FACE center, a
  // Shift+click a BACK center; a click within C.HIT_PX screen px of a marker selects it, a drag
  // moves it. `b` face ↔ back, Delete removes, Cmd+Z / Cmd+Shift+Z per frame, Enter confirms the
  // frame (zero clicks = no cards) and goes on. No model output, no identities.

  const CENTER_COLOR = {}; // readTheme() fills it
  function centerRow() { return rowFor(currentFrame()); }
  function centerList(row) { if (!row.centers) row.centers = []; return row.centers; }
  function centerById(row, id) { return centerList(row).find((c) => c.id === id) || null; }
  function centerTol() { return C.HIT_PX / (S.view.s || 1); } // frame px
  function imgReady() { return !!(S.img && S.img.naturalWidth); }

  function centerPushUndo(row, snap) {
    const st = S.cundo.get(row.name) || [];
    st.push(snap || JSON.stringify(centerList(row)));
    if (st.length > HISTORY_CAP) st.shift();
    S.cundo.set(row.name, st);
    S.credo.set(row.name, []);
  }

  function centerUndo() { centerHistory(S.cundo, S.credo, "undo"); }
  function centerRedo() { centerHistory(S.credo, S.cundo, "redo"); }

  // An undo / redo puts back a snapshot of the frame's centers; the timing log follows (each
  // change logged with `via: undo | redo`). `centerSeq` stays: an id is never issued twice.
  function centerHistory(from, to, what) {
    if (!editable() || S.cdrag) return;
    const row = centerRow();
    const st = from.get(row.name) || [];
    if (!st.length) { setStatus(`Nothing to ${what}.`); return; }
    const before = centerList(row);
    const other = to.get(row.name) || [];
    other.push(JSON.stringify(before));
    if (other.length > HISTORY_CAP) other.shift();
    to.set(row.name, other);
    row.centers = JSON.parse(st.pop());
    row.centerSeq = Math.max(C.seqOf(row), row.centerSeq || 0);
    for (const e of C.diff(before, row.centers)) logEvent(Object.assign(e, { via: what }));
    if (!centerById(row, S.csel)) S.csel = null;
    setStatus(what === "undo" ? "Undone." : "Redone.");
    scheduleSave(); render();
  }

  function addCenterAt(p, kind) {
    if (!editable() || !imgReady()) return null;
    const row = centerRow();
    const [W, H] = frameSize();
    if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) return null;
    centerPushUndo(row);
    const made = C.makeCenter(C.seqOf(row), p, W, H, kind);
    centerList(row).push(made.center);
    row.centerSeq = made.seq;
    row.frameW = W; row.frameH = H;
    S.csel = made.center.id;
    logEvent({ ev: "center-added", center: made.center.id, kind: made.center.kind });
    scheduleSave(); render();
    return made.center;
  }

  function deleteCenter() {
    if (!editable()) return;
    const row = centerRow();
    const c = centerById(row, S.csel);
    if (!c) { setStatus("Select a marker first: click it."); return; }
    centerPushUndo(row);
    row.centers = centerList(row).filter((x) => x.id !== c.id);
    S.csel = null;
    logEvent({ ev: "center-deleted", center: c.id, kind: c.kind });
    setStatus(`Marker removed. Undo (${CMD}+Z) brings it back.`);
    scheduleSave(); render();
  }

  function toggleCenterKind() {
    if (!editable()) return;
    const row = centerRow();
    const c = centerById(row, S.csel);
    if (!c) { setStatus("Select a marker first: click it."); return; }
    centerPushUndo(row);
    c.kind = C.otherKind(c.kind);
    logEvent({ ev: "center-kind", center: c.id, kind: c.kind });
    setStatus(`This marker is now a card ${c.kind === "back" ? "back" : "face"}.`);
    scheduleSave(); render();
  }

  async function confirmCenterFrame() {
    if (!editable() || S.cdrag || !imgReady()) return;
    const row = centerRow();
    const [W, H] = frameSize();
    row.frameW = W; row.frameH = H;
    centerList(row);
    if (!Number.isInteger(row.centerSeq)) row.centerSeq = C.seqOf(row);
    row.done = true;
    const n = C.counts(row.centers);
    logEvent({ ev: "frame-confirmed", n: row.centers.length, faces: n.faces, backs: n.backs });
    S.csel = null;
    scheduleSave();
    const tag = `${n.faces} ${n.faces === 1 ? "face" : "faces"} and ${n.backs} ${n.backs === 1 ? "back" : "backs"}`;
    await finishFrame((r) => !(r && r.done), {
      frame: () => `Frame confirmed with ${tag}. This is the next frame to do.`,
      set: (prev, next) => `${prev} is done: its last frame was confirmed with ${tag}. This is ${next}.`,
      all: (prev) => `${prev} is done. Every frame of every set is confirmed.`,
    });
  }

  function unconfirmCenterFrame() {
    if (!editable()) return;
    const row = centerRow();
    if (!row.done) { setStatus("This frame is not done yet."); return; }
    row.done = false;
    logEvent({ ev: "frame-unconfirmed", n: centerList(row).length });
    setStatus("Frame reopened.");
    scheduleSave(); render();
  }

  function centerMouseDown(p, ev) {
    if (!imgReady() || S.busy) return;
    const row = centerRow();
    const [W, H] = frameSize();
    const hit = C.hitCenter(centerList(row), p, W, H, centerTol());
    if (hit) {
      S.csel = hit;
      if (editable()) {
        const c = centerById(row, hit);
        S.cdrag = { id: hit, start: p, cx: ev.clientX, cy: ev.clientY, orig: { x: c.x, y: c.y }, before: JSON.stringify(row.centers), moved: false, added: false };
      }
      render(); return;
    }
    if (!editable()) { S.csel = null; render(); return; }
    const c = addCenterAt(p, ev.shiftKey ? "back" : "face");
    // press-drag-release places it precisely (the loupe follows); part of the add, one undo step
    if (c) S.cdrag = { id: c.id, start: p, cx: ev.clientX, cy: ev.clientY, orig: { x: c.x, y: c.y }, before: null, moved: false, added: true };
  }

  function centerMouseMove(p, ev) {
    const cv = $("frameCanvas");
    const d = S.cdrag;
    const row = centerRow();
    const [W, H] = frameSize();
    if (!d) {
      if (ev.target !== cv) { if (S.chover) { S.chover = null; render(); } else renderLoupe(); return; }
      const h = imgReady() ? C.hitCenter(centerList(row), p, W, H, centerTol()) : null;
      cv.style.cursor = h ? "move" : "crosshair";
      if (h !== S.chover) { S.chover = h; render(); } else renderLoupe();
      return;
    }
    if (!d.moved) {
      if (Math.hypot(ev.clientX - d.cx, ev.clientY - d.cy) <= DRAG_PX) return;
      d.moved = true;
    }
    const c = centerById(row, d.id);
    if (c) {
      const q = C.fromFrame({ x: d.orig.x * W + (p.x - d.start.x), y: d.orig.y * H + (p.y - d.start.y) }, W, H);
      c.x = q.x; c.y = q.y;
    }
    render();
  }

  function centerMouseUp() {
    const d = S.cdrag;
    if (!d) return;
    S.cdrag = null;
    const row = centerRow();
    const c = centerById(row, d.id);
    if (d.moved && c && (c.x !== d.orig.x || c.y !== d.orig.y)) {
      if (!d.added) { // a marker moved (an add's own drag is part of the add)
        centerPushUndo(row, d.before);
        logEvent({ ev: "center-moved", center: c.id, kind: c.kind });
      }
      scheduleSave();
    }
    render();
  }

  function onCenterKey(ev) {
    const k = ev.key;
    if (["ArrowRight", "]", "PageDown"].includes(k)) { gotoFrame(S.frameIdx + 1); return true; }
    if (["ArrowLeft", "[", "PageUp"].includes(k)) { gotoFrame(S.frameIdx - 1); return true; }
    if (!editable()) return false;
    if (k === "Enter") { if (ev.shiftKey) unconfirmCenterFrame(); else confirmCenterFrame(); return true; }
    if (k === "Escape") {
      const d = S.cdrag;
      if (d) {
        S.cdrag = null;
        const c = centerById(centerRow(), d.id);
        if (c) { c.x = d.orig.x; c.y = d.orig.y; }
        setStatus("Canceled.");
      } else S.csel = null;
      render(); return true;
    }
    if (k === "b" || k === "B") { toggleCenterKind(); return true; }
    if (k === "Delete" || k === "Backspace") { deleteCenter(); return true; }
    if (k === "Tab") { S.csel = C.cycle(centerList(centerRow()), S.csel, ev.shiftKey ? -1 : 1); render(); return true; }
    return k.length === 1; // center mode owns the printable keys: none falls through to another mode
  }

  // One marker: faces a green crosshair ring, backs an orange ring with a dot, its click number
  // beside it; faint (the card under it stays readable), the selected one blue and solid.
  function drawCenter(ctx, c, x, y, n, isSel, isHover, scale) {
    const k = scale || 1;
    const col = isSel ? T.selected : CENTER_COLOR[c.kind] || CENTER_COLOR.face;
    const r = (isSel ? 8 : 6) * k;
    ctx.save();
    ctx.globalAlpha = isSel || isHover ? 1 : 0.75;
    const stroke = (w, color) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      if (c.kind !== "back") { // crosshair ticks outside the ring, a gap at the center
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(x + dx * (r - 3 * k), y + dy * (r - 3 * k)); ctx.lineTo(x + dx * (r + 4 * k), y + dy * (r + 4 * k)); }
      }
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke();
    };
    stroke((isHover || isSel ? 4.5 : 3.5) * k, T.halo);
    stroke((isHover || isSel ? 2.2 : 1.5) * k, col);
    if (c.kind === "back") { ctx.beginPath(); ctx.arc(x, y, 1.6 * k, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); }
    ctx.font = `bold ${Math.round(10 * k)}px sans-serif`;
    const label = String(n);
    const tx = x + r + 3 * k, ty = y - r + 2 * k;
    ctx.lineWidth = 3; ctx.strokeStyle = T.halo; ctx.strokeText(label, tx, ty);
    ctx.fillStyle = col; ctx.fillText(label, tx, ty);
    ctx.restore();
  }

  function renderCenter(row) {
    const ctx = fitCorner();
    const s = S.view.s;
    ctx.drawImage(S.img, 0, 0, S.img.naturalWidth * s, S.img.naturalHeight * s);
    const [W, H] = frameSize();
    for (const c of centerList(row)) {
      if (c.id === S.csel) continue;
      drawCenter(ctx, c, c.x * W * s, c.y * H * s, C.idNumber(c.id) || "?", false, c.id === S.chover);
    }
    const sel = centerById(row, S.csel); // the selected one on top
    if (sel) drawCenter(ctx, sel, sel.x * W * s, sel.y * H * s, C.idNumber(sel.id) || "?", true, false);
    if (row.done) { // a confirmed frame says so on the canvas too
      ctx.font = "bold 12px sans-serif"; const t = "✓ frame confirmed";
      ctx.fillStyle = T.halo; ctx.fillRect(6, 6, ctx.measureText(t).width + 10, 18);
      ctx.fillStyle = T.confirmed; ctx.fillText(t, 11, 19);
    }
    $("overviewWrap").hidden = true;
    $("eligWrap").hidden = true;
    renderCenterLoupe();
  }

  // The loupe: a 4× inset around the pointer with the markers in it, top-right of the pane (left
  // when the pointer is under it).
  function renderCenterLoupe() {
    const l = $("loupe");
    const [W, H] = frameSize();
    const p = S.mouse;
    const show = !!(p && imgReady() && p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H);
    l.hidden = !show;
    if (!show) return;
    const cv = $("frameCanvas").getBoundingClientRect(), st = $("cornerStage").getBoundingClientRect();
    const sx = cv.left + p.x * S.view.s - st.left, sy = cv.top + p.y * S.view.s - st.top;
    l.classList.toggle("left", sx > st.width - l.width - 40 && sy < l.height + 40);
    const ctx = l.getContext("2d");
    const z = 4, half = l.width / 2;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = T.void; ctx.fillRect(0, 0, l.width, l.height);
    ctx.drawImage(S.img, p.x - half / z, p.y - half / z, l.width / z, l.height / z, 0, 0, l.width, l.height);
    for (const c of centerList(centerRow())) {
      const x = (c.x * W - p.x) * z + half, y = (c.y * H - p.y) * z + half;
      if (x < -20 || y < -20 || x > l.width + 20 || y > l.height + 20) continue;
      drawCenter(ctx, c, x, y, C.idNumber(c.id) || "?", c.id === S.csel, false, 1.4);
    }
    // the pointer: a gap cross, so the pixel under it stays visible
    ctx.strokeStyle = T.target; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(half, 0); ctx.lineTo(half, half - 6); ctx.moveTo(half, half + 6); ctx.lineTo(half, l.height);
    ctx.moveTo(0, half); ctx.lineTo(half - 6, half); ctx.moveTo(half + 6, half); ctx.lineTo(l.width, half);
    ctx.stroke();
  }

  function renderCenterInspector(row) {
    const box = $("inspector");
    const c = C && centerById(row, S.csel);
    box.innerHTML = `<div class="sel"></div><div class="centerRule"><b>Which cards get a marker:</b> every card face and every card back. `
      + `<b>Not</b> a card mostly covered by another card, such as the overlapped strips in a row of overlapping cards.</div>`;
    box.querySelector(".sel").textContent = c ? `The selected marker is a card ${c.kind === "back" ? "back" : "face"}.` : "";
  }

  // ---- verify mode (naming a center census) --------------------------------------
  // Every FACE center of the set's frames (with "include backs", the backs too), frame then id
  // order. Two steps per center (anti-anchoring): 1. the crop: a fixed window around the center
  // with the click marker, and the whole-frame overview, no names; readable from this crop alone
  // (y / m / n) is answered HERE, before anything of the arms (readability first: seeing a
  // proposal must not change which cards count as readable); 2. the readability saved, the
  // server releases the arms' proposals (POST /api/verify-reveal) side by side (each arm's crop,
  // drawn here from the frame and the arm's box, its name or "nothing shown", its box on the zoom
  // view in its own color, the card art). A center of the blind subsample has no step 2: the
  // picker opens and nothing of the arms is in the page (the server never sends it). Answers only:
  // the center's x / y / id / kind are never changed (the server refuses it). verifycore.js holds
  // the answer rules; labelcore.py checks every save.

  // The run's arms, in the server's order (--arm): the first is key 1 (cyan, solid), the second
  // key 2 (amber, dashed). An --all-blind run has none.
  const ARM_COLORS = []; // readTheme() fills it
  function verifyArms() { return (S.config && S.config.verify && S.config.verify.arms) || []; }
  function armColor(arm) { return ARM_COLORS[Math.max(0, verifyArms().indexOf(arm)) % ARM_COLORS.length]; }
  function armKey(arm) { return String(verifyArms().indexOf(arm) + 1); }
  // "1 new · 2 old · a both · / another · u · x · b"
  function armPrompt() {
    const arms = verifyArms();
    return arms.map((arm) => `${armKey(arm)} accepts ${arm}'s name`).concat(arms.length === 2 ? ["A both"] : [], ["/ another card", "U unknown", "X not a card", "B a card back"]).join(" · ");
  }
  function vItem() { return S.vq[S.vIdx] || null; }
  function vKey(it) { return `${it.frame}#${it.id}`; }
  function vInfo(it) { return (it && S.vInfo.get(vKey(it))) || { blind: false, sha: null }; }
  function vCenter(it) {
    const row = it && S.rows.get(it.frame);
    return (row && (row.centers || []).find((c) => c.id === it.id)) || null;
  }
  function vOpen(it) { const c = vCenter(it); return !!c && !V.isVerified(c, vInfo(it).sha); }
  function vRevealKey(it) { return `${S.set.setId}/${vKey(it)}`; }
  // Step 2 is showing: the server released the arms (it does so only after the readability is
  // stored). Never on a blind center (it has no arms).
  function vRevealed(it) {
    if (!it) return false;
    const info = vInfo(it);
    return !info.blind && !!info.arms;
  }
  const READ_PROMPT = "First answer whether the name is legible in this crop: Y, M or N.";
  function cardName(id) { const c = S.byId.get(id); return (c && c.name) || id; }
  // A card as the page names it: name and id (different cards may share one name).
  function cardWho(id) { const c = S.byId.get(id); return c && c.name && c.name !== id ? `${c.name} · ${id}` : String(id); }

  function verifyBuild() {
    const frames = S.frames.map((f) => ({ name: f.name, centers: (S.rows.get(f.name) || {}).centers || [] }));
    S.vq = V.walk(frames, S.vIncludeBacks);
  }

  function verifyCounts() {
    const frames = S.frames.map((f) => ({ name: f.name, centers: (S.rows.get(f.name) || {}).centers || [] }));
    return V.counts(V.walk(frames, false), (it) => ({ c: vCenter(it), info: vInfo(it) }));
  }

  async function setVerifyBacks(on) {
    S.vIncludeBacks = !!on;
    lsSet(LS.verifyBacks, S.vIncludeBacks ? "on" : "off");
    if (mode() !== "verify") { renderToolbar(); return; }
    const cur = vItem();
    verifyBuild();
    let i = cur ? S.vq.findIndex((e) => e.frame === cur.frame && e.id === cur.id) : -1;
    if (i < 0) i = Math.max(0, S.vq.findIndex(vOpen));
    renderToolbar();
    setStatus(S.vIncludeBacks ? "Card backs are shown too: B says it is a back, X that it is not a card, or name it if it is a face." : "Card backs are left out.");
    await verifyGo(i);
  }

  async function verifyGo(i) {
    if (!S.vq.length) { setStatus(""); render(); return; }
    S.vIdx = Math.max(0, Math.min(S.vq.length - 1, i));
    // leaving a center lets go of the picker (a blind center opens it again on arrival)
    if (document.activeElement === $("pickerInput")) { $("pickerInput").value = ""; renderPicker(); closePicker(); }
    const it = vItem();
    const idx = S.frames.findIndex((f) => f.name === it.frame);
    if (idx < 0) return;
    if (idx !== S.frameIdx || !S.img) await gotoFrame(idx);
    else { await flushSave(); render(); markShown(); }
  }

  function verifyShown() {
    const it = vItem();
    if (!it || !S.set) return;
    const k = vRevealKey(it);
    if (k === S.shownKey) return;
    S.shownKey = k;
    S.vShownAt = Date.now();
    const info = vInfo(it), c = vCenter(it);
    const stale = !!c && V.isStale(c, info.sha);
    logEvent({ ev: "verify-shown", center: it.id, blind: !!info.blind, kind: c ? c.kind : null, stale });
    if (!c || !editable() || (V.isVerified(c, info.sha))) return;
    setStatus("");
    // a card without suggestions: the search takes the focus, but only once step 1 has its answer
    if (V.readability(c) && info.blind && (!V.hasAnswer(c) || stale)) openPicker();
  }

  function verifyReveal() {
    const it = vItem(), c = vCenter(it);
    if (!c) return;
    const info = vInfo(it);
    if (V.isVerified(c, info.sha)) { verifyAdvance(); return; }
    if (!V.readability(c)) { setStatus(READ_PROMPT); return; }
    if (V.needsReadability(c) && !V.isStale(c, info.sha)) { setStatus(`${cardWho(c.identity)} is named. Now Y, M or N: is its name legible in this crop?`); return; }
    if (info.blind) { setStatus(""); openPicker(); return; }
    if (!info.proposals) { setStatus("There is no suggestion for this card."); return; }
    if (vRevealed(it)) { setStatus(armPrompt()); return; }
    verifyFetchArms(it);
  }

  // The server releases a center's proposals only once its readability is stored: save first.
  async function verifyFetchArms(it) {
    const setId = S.set.setId;
    await flushSave();
    if (S.failed.size) { setStatus("Your answer is not saved yet, and the suggestion waits for it (see the banner)."); return; }
    let r, j = {};
    try {
      r = await fetch(`/api/verify-reveal/${encodeURIComponent(setId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: saveBody({ frame: it.frame, center: it.id }),
      });
      try { j = await r.json(); } catch (e) { j = { error: `HTTP ${r.status}` }; }
    } catch (e) { j = { error: e.message }; }
    if (r && SG.isOtherRun(r.status, j) && await checkRun() === "adopt") return verifyFetchArms(it); // the same work, started again: once more
    if (!S.set || S.set.setId !== setId) return;
    if (!r || !r.ok) { setStatus(`The suggestion could not be shown: ${j.error || "the server did not answer"}.`); return; }
    const info = S.vInfo.get(vKey(it));
    if (info) info.arms = j.arms;
    const c = vCenter(it);
    if (c) { c.revealedAt = j.revealedAt; if (j.readabilityAt) c.readabilityAt = j.readabilityAt; }
    logEvent({ ev: "verify-revealed", center: it.id, blind: false, ms: Date.now() - S.vShownAt });
    if (vItem() === it) setStatus("");
    render();
  }

  function verifyLogAnswer(it, c, revealed) {
    logEvent({ ev: "verify-answer", center: it.id, verifiedBy: c.verifiedBy, blind: !!c.blind, eligible: c.eligible || null,
      revealed: !!revealed, ms: Date.now() - S.vShownAt });
    if (c.correction) logEvent({ ev: "verify-correction", center: it.id, correction: c.correction, blind: !!c.blind });
  }

  function verifyAnswer(how, pick) {
    if (!editable()) return;
    const it = vItem(), c = vCenter(it);
    if (!c) { setStatus("There is no card here."); return; }
    const info = vInfo(it);
    // safeguard: when both arms show the same card (by the catalog's rule), 1 / 2 record "both
    // agree" (accept-both), never one arm, so the record does not credit one arm for a shared answer
    const arms = verifyArms();
    if (V.isAccept(how) && how !== V.ACCEPT_BOTH && arms.length === 2 && info.arms) {
      const a0 = info.arms[arms[0]] || {}, a1 = info.arms[arms[1]] || {};
      if (a0.name && a1.name && V.sameCard(a0, a1, S.config.identity, S.roots)) {
        how = V.ACCEPT_BOTH;
        setStatus(S.config.identity === "printing" ? "Both models show this card, so it is recorded as agreed by both." : "Both models show this name, so it is recorded as agreed by both.");
      }
    }
    const revealed = vRevealed(it);
    const res = V.answerFor(how, c, { sha: info.sha, blind: !!info.blind, armNames: arms, arms: info.arms || null, revealed, pick,
      identity: S.config.identity, roots: S.roots });
    if (res.error) { setStatus(verifyWords(res.error)); return; }
    V.applyAnswer(c, res.fields);
    clearSearch(how === "picked" ? "pick" : how);
    scheduleSave();
    if (V.isComplete(c)) {
      verifyLogAnswer(it, c, revealed);
      verifyAdvance();
      return;
    }
    setStatus("");
    render();
  }

  // Step 1 (readability first): y / m / n from the crop, then the proposals (or, blind, the picker).
  async function verifyReadability(key) {
    if (!editable()) return;
    const it = vItem(), c = vCenter(it);
    if (!c) return;
    const info = vInfo(it);
    // a readability stored for an earlier marker position: clear it on the server first, so the
    // new answer is stamped afresh (the server never re-stamps an unchanged answer)
    if (c.eligible && !V.readability(c) && !V.isRevealed(c)) {
      V.clearAnswer(c);
      scheduleSave();
      await flushSave();
      if (S.failed.size || vItem() !== it) return;
    }
    const r = V.setReadability(c, key, info.blind);
    if (r.error) { setStatus(verifyWords(r.error)); return; }
    scheduleSave();
    logEvent({ ev: "verify-readability", center: it.id, eligible: c.eligible, blind: !!info.blind, revealed: false, ms: Date.now() - S.vShownAt });
    if (V.isComplete(c) && V.hasAnswer(c)) { render(); return; } // a correction given first keeps its answer
    setStatus("");
    if (info.blind) { openPicker(); render(); return; } // step 1 is answered: now the search takes the focus
    if (!info.proposals) { render(); return; }
    setStatus("Fetching the suggestion…");
    render();
    verifyFetchArms(it);
  }

  function verifyClear() {
    if (!editable()) return;
    const it = vItem(), c = vCenter(it);
    if (!c || (!V.hasAnswer(c) && !(c.eligible && !V.isRevealed(c)))) { setStatus(c && V.isRevealed(c) ? "The answer on reading the crop stays once the suggestion was shown." : "There is no answer to clear."); return; }
    V.clearForRedo(c);
    clearSearch("clear");
    scheduleSave();
    logEvent({ ev: "verify-cleared", center: it.id, blind: !!vInfo(it).blind });
    setStatus(V.readability(c) ? "Name cleared. The answer on reading the crop stays: the suggestion was shown." : "Answer cleared.");
    render();
  }

  // The next open center of the set (wrapping), else the next set with centers left.
  async function verifyAdvance() {
    // remember the answer just given, shown on the left so it can be double-checked
    { const it = vItem(), c = vCenter(it); if (c && V.isComplete(c)) S.vLast = { id: it.id, identity: c.identity || null, verifiedBy: c.verifiedBy, eligible: c.eligible || null, correction: c.correction || null, idx: S.vIdx, set: S.set && S.set.setId }; }
    const i = V.nextOpen(S.vq, S.vIdx, vOpen);
    if (i >= 0 && i !== S.vIdx) { await verifyGo(i); return; }
    if (i === S.vIdx) { render(); return; }
    await verifyNextSet();
  }

  async function verifyNextSet() {
    await flushSave();
    const prev = S.set.setId;
    try { S.sets = await getJSON("/api/sets"); } catch (e) { /* keep the old list */ }
    const sel = $("setSelect");
    for (const s of S.sets) { const o = [...sel.options].find((x) => x.value === s.setId); if (o) o.textContent = setLabel(s); }
    const i0 = S.sets.findIndex((s) => s.setId === prev);
    for (let k = 1; k <= S.sets.length; k++) {
      const s = S.sets[(i0 + k) % S.sets.length];
      if (s.setId !== prev && !s.readOnly && s.verify && s.verify.open > 0) {
        sel.value = s.setId; await openSet(s.setId);
        setStatus(`${prev} is done: every card is checked. This is ${s.setId}.`);
        return;
      }
    }
    setStatus(`${prev}: every card is checked. No set of this sample has cards left to check.`);
    render();
    if (!S.failed.size) await showFinish();
  }

  // verifycore.js answers in the words of the files and flags; the page says the same in its own.
  const VERIFY_WORDS = [
    [/^readable from this crop alone\? y \/ m \/ n first, then the name$/, "First answer whether the name is legible in this crop: Y, M or N. Then the name."],
    [/^blind: name it yourself.*$/, "This card has no suggestion: search for its name with /."],
    [/^no proposals for this center$/, "There is no suggestion for this card."],
    [/^Space or Enter reveals the proposals first$/, "The suggestion is not shown yet: Space shows it."],
    [/^this run has one arm: 1 accepts it$/, "This run compares one model only: 1 accepts its name."],
    [/^this run has no such arm$/, "This run has no such model."],
    [/^(.*) showed nothing: nothing to accept$/, "$1 shows no name here, so there is nothing to accept."],
    [/^the arms show different names: 1 or 2, or \/ for another$/, "The two models show different names: 1 or 2 accepts one, / picks another card."],
    [/^the arms show different cards: 1 or 2, or \/ for another$/, "The two models show different cards: 1 or 2 accepts one, / picks another card."],
    [/^the readability was answered before the proposals were shown; it stays$/, "The answer on reading the crop was given before the suggestion was shown, and it stays."],
    [/^already named: Backspace clears the answer to change the readability$/, "This card is named already. Backspace clears the answer, and then this one can change."],
  ];
  function verifyWords(msg) {
    for (const [re, to] of VERIFY_WORDS) if (re.test(msg)) return String(msg).replace(re, to);
    return msg;
  }

  function verifyOpenPicker() {
    const c = vCenter(vItem());
    if (c && !V.readability(c)) { setStatus(READ_PROMPT); return; }
    openPicker();
  }

  function onVerifyKey(ev) {
    const k = ev.key;
    if (k === " " || k === "Enter") { verifyReveal(); return true; }
    if (k === "ArrowLeft" || k === "[") { if (S.vIdx > 0) verifyGo(S.vIdx - 1); else setStatus("This is the first card of this set."); return true; }
    if (k === "ArrowRight" || k === "]") { if (S.vIdx < S.vq.length - 1) verifyGo(S.vIdx + 1); else setStatus("This is the last card of this set. Space goes to the next one still open."); return true; }
    if (k === "z" || k === "Z") { S.vZoom = Names.cycleLevel(S.vZoom, V.WINDOWS.length, k === "Z"); render(); return true; }
    if (k === "p") { setHoverArt(!S.hoverArt); return true; }
    if (!editable()) return k.length === 1;
    const arms = verifyArms();
    const acceptArm = (n) => () => { if (arms[n]) verifyAnswer(V.acceptOf(arms[n])); else setStatus(arms.length ? "This run compares one model only: 1 accepts its name." : "This run shows no suggestions: name the card yourself."); };
    const map = {
      1: acceptArm(0), 2: acceptArm(1), a: () => verifyAnswer(V.ACCEPT_BOTH),
      "/": verifyOpenPicker, i: verifyOpenPicker, u: () => verifyAnswer("unknown"),
      x: () => verifyAnswer("not-card"), b: () => verifyAnswer("back"),
      y: () => verifyReadability("y"), m: () => verifyReadability("m"), n: () => verifyReadability("n"),
      Backspace: verifyClear, Delete: verifyClear,
    };
    if (map[k]) { map[k](); return true; }
    if (onFilterKey(k)) return true;
    return k.length === 1; // verify mode owns the printable keys
  }

  // The crop-first view: the same fixed window around the center whatever the arms did; the arms'
  // boxes only after the reveal (never on a blind center).
  function renderVerify(row) {
    const [W, H] = frameSize();
    const it = vItem(), c = vCenter(it), info = vInfo(it);
    const panelH = 270;
    const size = cropSide(panelH);
    const cv = $("zoomView");
    $("eligWrap").hidden = true;
    $("overviewWrap").hidden = false;
    if (!c || !imgReady()) {
      sizeCanvas(cv, size, size).clearRect(0, 0, size, size);
      $("pointCaption").textContent = "";
      renderVerifyPanel(it, c, info, false);
      return;
    }
    const cx = c.x * W, cy = c.y * H;
    const win = V.windowFor(S.vZoom, H, size);
    const ctx = drawZoom(cv, size, size, cx, cy, win.z);
    const revealed = vRevealed(it);
    if (revealed && info.arms) {
      for (const arm of verifyArms()) {
        const a = info.arms[arm];
        const b = a && a.box ? V.boxToFrame(a.box, W, H) : null;
        if (!b) continue;
        const second = verifyArms().indexOf(arm) === 1;
        const x = (b[0] - cx) * win.z + size / 2, y = (b[1] - cy) * win.z + size / 2, w = b[2] * win.z, h = b[3] * win.z;
        ctx.save();
        ctx.setLineDash(second ? [7, 4] : []);
        ctx.lineWidth = 4; ctx.strokeStyle = T.halo; ctx.strokeRect(x, y, w, h);
        ctx.lineWidth = 2; ctx.strokeStyle = armColor(arm); ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
        ctx.font = "bold 12px sans-serif";
        const label = `${armKey(arm)} ${arm}`, ty = second ? y + h + 13 : y - 4;
        ctx.lineWidth = 3; ctx.strokeStyle = T.halo; ctx.strokeText(label, x + 2, ty);
        ctx.fillStyle = armColor(arm); ctx.fillText(label, x + 2, ty);
        ctx.restore();
      }
    }
    // the click marker: a gap ring (the pixel under it stays visible), orange for a back
    const col = c.kind === "back" ? T.back : T.target, m = size / 2;
    ctx.strokeStyle = T.halo; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(m, m, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(m, m, 9, 0, Math.PI * 2); ctx.stroke();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.beginPath(); ctx.moveTo(m + dx * 14, m + dy * 14); ctx.lineTo(m + dx * 26, m + dy * 26); ctx.stroke();
    }
    $("pointCaption").textContent = `Card ${S.vIdx + 1} of ${S.vq.length}, a ${c.kind === "back" ? "card back" : "card face"} · the crop shows ${Math.round(win.side)} px of the frame, enlarged ${win.z.toFixed(2)}× (Z / Shift+Z change it)`;
    // the whole frame: the window and every center of the walk (current pink, verified green, stale amber)
    NF.paint((fv, big) => {
      const octx = fv.ctx, sc = fv.s, wp = fv.map([cx - win.side / 2, cy - win.side / 2]);
      octx.strokeStyle = col; octx.lineWidth = big ? 2 : 1;
      octx.strokeRect(wp[0], wp[1], win.side * sc, win.side * sc);
      for (const e of S.vq) {
        if (e.frame !== it.frame) continue;
        const o = vCenter(e);
        if (!o) continue;
        const cur = e.id === it.id, sha = vInfo(e).sha, q = fv.map([o.x * W, o.y * H]);
        octx.beginPath(); octx.arc(q[0], q[1], cur ? (big ? 7 : 4) : big ? 4 : 2.5, 0, Math.PI * 2);
        octx.fillStyle = cur ? col : V.isStale(o, sha) ? T.open : V.isVerified(o, sha) ? T.confirmed : T.ink;
        octx.fill(); octx.strokeStyle = T.void; octx.lineWidth = 1; octx.stroke();
      }
    }, [cx, cy]);
    renderVerifyPanel(it, c, info, revealed);
  }

  // Under the zoom view: step 2 (both arms side by side) once revealed; a blind center gets one
  // line of text and NO proposal element at all (nothing hidden either).
  function renderVerifyPanel(it, c, info, revealed) {
    const el = $("verifyPanel");
    const sig = JSON.stringify([it && S.set ? vRevealKey(it) : null, !!(info && info.blind), !!revealed, !!(info && info.arms)]);
    if (el.dataset.sig === sig) return; // the images are not fetched again on each redraw
    el.dataset.sig = sig;
    el.innerHTML = "";
    const note = (cls, text, sub) => {
      const d = document.createElement("div");
      d.className = `vNote ${cls}`;
      const b = document.createElement("b"); b.textContent = text; d.appendChild(b);
      if (sub) { const s2 = document.createElement("div"); s2.className = "muted"; s2.textContent = sub; d.appendChild(s2); }
      el.appendChild(d);
    };
    if (!it || !c) { note("", "No card to show"); return; }
    if (info.blind) { note("vBlindNote", "No suggestion for this card (blind check)", "Some cards are named without a model's suggestion, to measure how much the suggestions move the answers. Answer step 1, then search for the card's name."); return; }
    if (!info.proposals && !info.arms) { note("", "No suggestion for this card", "Answer step 1, then pick the card yourself."); return; }
    if (!revealed) { note("vStep1", "Step 1: the crop only", "The model's suggestion appears after your answer, and that answer is then fixed."); return; }
    const wrap = document.createElement("div");
    wrap.className = "vArms";
    const [fw, fh] = frameSize();
    for (const arm of verifyArms()) {
      const a = info.arms[arm] || {};
      const col = document.createElement("div");
      col.className = `vArm ${verifyArms().indexOf(arm) === 1 ? "second" : "first"}`;
      col.dataset.arm = arm;
      const h = document.createElement("div");
      h.className = "vArmHead";
      const hk = document.createElement("kbd"); hk.textContent = armKey(arm);
      h.append(hk, document.createTextNode(` ${arm} suggests`));
      col.appendChild(h);
      const pics = document.createElement("div");
      pics.className = "vPics";
      // the arm's crop: the part of the frame inside its box, drawn here from the frame on screen
      const cb = a.box && imgReady() ? V.boxToFrame(a.box, fw, fh) : null;
      if (cb) {
        const cvs = document.createElement("canvas");
        cvs.className = "vCrop"; cvs.title = `The part of the frame inside the box ${arm} found`;
        const k = Math.min(1, 300 / Math.max(cb[2], cb[3]));
        cvs.width = Math.max(1, Math.round(cb[2] * k)); cvs.height = Math.max(1, Math.round(cb[3] * k));
        cvs.getContext("2d").drawImage(S.img, cb[0], cb[1], cb[2], cb[3], 0, 0, cvs.width, cvs.height);
        pics.appendChild(cvs);
      } else pics.appendChild(Object.assign(document.createElement("div"), { className: "vNoPic muted", textContent: "found no box" }));
      if (a.name && a.artId && artSrc(a.artId)) {
        const art = document.createElement("img");
        art.className = "vArt"; art.alt = a.name;
        setArt(art, a.artId);
        const pv = { id: `arm:${arm}`, identity: a.artId, outcome: "card", printing: null };
        art.addEventListener("mousemove", (ev) => showHoverPreview(pv, ev.clientX, ev.clientY, true));
        art.addEventListener("mouseleave", hideHoverPreview);
        pics.appendChild(art);
      }
      col.appendChild(pics);
      const nm = document.createElement("div");
      nm.className = a.name ? "vName" : "vName muted";
      nm.textContent = a.name ? `${a.name}${a.printingId || a.artId ? " · " + (a.printingId || a.artId) : ""}` : "No name";
      col.appendChild(nm);
      const fmt = (v) => (typeof v === "number" ? (Math.round(v * 1000) / 1000).toString() : v === null || v === undefined ? "—" : String(v));
      const meta = document.createElement("div");
      meta.className = "vMeta muted";
      meta.textContent = [`box score ${a.box ? fmt(a.boxScore) : "none"}`, `similarity ${fmt(a.similarity)}`, `margin ${fmt(a.margin)}`, a.look ? `look ${a.look}` : null].filter(Boolean).join(" · ");
      col.appendChild(meta);
      wrap.appendChild(col);
    }
    el.appendChild(wrap);
    const shown = verifyArms().map((arm) => info.arms[arm] || {});
    const same = shown.length === 2 && shown[0].name && shown[1].name && V.sameCard(shown[0], shown[1], S.config.identity, S.roots);
    const byPrinting = S.config.identity === "printing"; // cards that share a name may be different cards
    const foot = document.createElement("div");
    foot.className = "vFoot muted";
    foot.textContent = shown.length < 2 ? (shown[0] && shown[0].name ? "" : "The model shows no name for this card.")
      : same ? (byPrinting ? "Both show the same card." : "Both show the same name.") : !shown[0].name && !shown[1].name ? "Neither model shows a name."
        : byPrinting ? "The two cards differ." : "The two names differ.";
    el.appendChild(foot);
  }

  function renderVerifyInspector(row) {
    const box = $("inspector");
    const it = vItem(), c = vCenter(it), info = vInfo(it);
    box.innerHTML = `<div class="vAnswer"></div><div class="muted vNext" hidden></div>`;
    if (!c) return;
    const stale = V.isStale(c, info.sha);
    const ans = box.querySelector(".vAnswer");
    const HOW = { picked: "picked by you", unknown: "", "not-card": "", back: "", "accept-both": "both models' name, accepted" };
    if (!V.hasAnswer(c)) ans.textContent = "";
    else if (stale) { // the earlier answer is not shown: it would anchor the new one
      ans.textContent = "Answered before, for another position of the marker or another set of suggestions. That answer is not shown: answer again.";
      ans.className = "vAnswer stale";
    } else {
      const what = c.verifiedBy === "unknown" ? "Unknown card" : c.correction ? (c.correction === "back" ? "A card back, not a face" : "Not a card")
        : `${cardWho(c.identity)}${c.printing ? ", printing " + c.printing : ""}`;
      const how = c.verifiedBy in HOW ? HOW[c.verifiedBy] : V.isAccept(c.verifiedBy) ? `${c.verifiedBy.slice("accept-".length)}'s name, accepted` : "";
      ans.textContent = `Answer: ${what}${how ? ` · ${how}` : ""}${c.eligible ? ` · name legible in the crop: ${c.eligible === "uncertain" ? "unsure" : c.eligible}` : ""}`;
      ans.className = "vAnswer";
    }
    // the chosen card's art, for the current center once answered, and for the previous answer
    const art = (ident, label) => {
      const card = ident && ident !== "unknown" ? S.byId.get(ident) : null;
      const d = document.createElement("div"); d.className = "vPick";
      d.innerHTML = `<div class="muted"></div>${card ? '<img alt="">' : ""}<div class="vPickName"></div>`;
      d.querySelector(".muted").textContent = label;
      if (card) setArt(d.querySelector("img"), ident);
      d.querySelector(".vPickName").textContent = card ? cardWho(ident) : ident === "unknown" ? "Unknown card" : "—";
      return d;
    };
    if (V.hasAnswer(c) && !stale && c.identity) box.insertBefore(art(c.identity, "Your answer for this card"), box.querySelector(".vNext"));
    if (S.vLast && S.vLast.set === (S.set && S.set.setId) && S.vLast.id !== it.id) {
      const L = S.vLast;
      const lbl = `The card before: ${L.correction ? (L.correction === "back" ? "a card back" : "not a card") : L.verifiedBy === "unknown" ? "unknown" : L.verifiedBy === "picked" ? "picked by you" : "suggestion accepted"}${L.eligible ? `, legible: ${L.eligible === "uncertain" ? "unsure" : L.eligible}` : ""}. ← goes back to it.`;
      box.appendChild(art(L.correction ? null : L.identity, lbl));
    }
  }

  // ---- the page around the editor ------------------------------------------------------------
  // The instruction line, the primary button, the everyday actions, the question about reading a
  // card, the finish card, the keys overlay and the save and connection indicators. uistate.js
  // decides the words from the page's state; this part draws them. Every button here stands
  // for a key and runs that key's own handler (pressKey), so a button and its key cannot differ.

  const HEARTBEAT_MS = 3000;
  const CMD = /Mac|iPhone|iPad/.test(navigator.platform || "") ? "Cmd" : "Ctrl";
  const FRAME_KEYS = ["ArrowLeft", "ArrowRight", "[", "]", "PageUp", "PageDown", "{", "}"];

  // The focus goes back to the frame: the keys act on the editor again.
  function focusEditor() {
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
    if (S.set && !zoomStage() && !reviewOn() && !$("cornerStage").hidden) $("frameCanvas").focus({ preventScroll: true });
  }

  // F6: the focus moves to the side panel's first control; Tab goes on from there, Esc comes back.
  function focusPanel() {
    const first = [$("primaryBtn")].concat(Array.from($("side").querySelectorAll("button, input, select, summary")))
      .find((el) => el && !el.disabled && el.offsetParent !== null);
    if (first) first.focus();
  }

  // A key press sent to the editor, as if typed with the focus on the frame.
  function pressKey(key, mods) {
    const m = String(mods || "");
    editorKey({ key, shiftKey: m.includes("shift"), altKey: m.includes("alt"), metaKey: m.includes("meta"), ctrlKey: false, preventDefault() {} });
  }

  // Box mode: a box of the new-box size in the middle of the frame, selected for adjusting (the
  // arrow keys move it), so a box can be made without the pointer.
  function addBoxAtCenter() {
    if (mode() !== "box" || !editable() || S.imgFailed || reviewOn()) return;
    const [W, H] = frameSize();
    placeDefaultAt({ x: W / 2, y: H / 2 });
  }

  function runAct(act) {
    if (act === "enter") pressKey("Enter");
    else if (act === "space") pressKey(" ");
    else if (act === "search") pressKey("/");
    else if (act === "pick") pickHighlighted();
    else if (act === "search-all") choose({ kind: "not-in-list" });
    else if (act === "unknown") choose({ kind: "unknown" });
    else if (act === "reload-frame") reloadFrame();
    else if (act === "remove-frame") openRemove();
    else if (act === "remove-confirm") doRemove();
    else if (act === "remove-cancel") closeRemove();
    else if (act === "add-box") addBoxAtCenter();
    else if (act === "move-kept") pressKey("m");
    else if (act === "finish-next-set") { const id = S.finish && S.finish.next.setId; if (id) { $("setSelect").value = id; openSet(id); focusEditor(); } }
    else if (act === "finish-close") { hideFinish(); focusEditor(); }
    else if (act === "finish-project") goToProject();
    else if (act === "finish-switch") { const pass = S.finish && S.finish.next.pass; if (pass) switchTo(pass); }
  }

  function setKeyText(el, text) {
    el.textContent = "";
    for (const p of U.parts(text)) {
      if (p.key) { const k = document.createElement("kbd"); k.textContent = p.key; el.appendChild(k); } else el.appendChild(document.createTextNode(p.text));
    }
  }

  // A target as uistate.js reads it. `inWalk`: the Names pass, where an unknown card is complete
  // without the answer on reading it (the server's rule).
  function answerView(t, inWalk) {
    if (!t) return null;
    const named = t.outcome === "card" && !!t.identity;
    return { outcome: t.outcome || null, identity: t.identity || null, name: named && t.identity !== "unknown" ? cardName(t.identity) : null,
      eligible: t.eligible || null, asks: named && !t.eligible && !(inWalk && t.identity === "unknown"),
      complete: complete(t) || !!(inWalk && named && t.identity === "unknown") };
  }

  // The page's state, as plain values: what uistate.js turns into words.
  function uiState() {
    const f = currentFrame(), row = rowFor(f), m = mode();
    const st = { mode: m, readOnly: S.readOnly || null, otherRun: !!S.otherRun, imageFailed: S.imgFailed ? { name: S.imgFailed.name } : null,
      frame: { index: S.frameIdx + 1, count: S.frames.length, done: !!row.done, last: S.frameIdx === S.frames.length - 1 },
      search: searchState() };
    const ts = row.targets || [];
    if (m === "box") {
      const pend = ts.filter((t) => t.pending && t.prefill);
      const sugg = pend.filter((t) => t.suggestion).length;
      const kept = row.done ? [] : ts.filter((t) => t.labelSource === "carried" && !S.prov.has(t.id));
      const from = kept.length && kept[0].carriedFrom ? S.frames.findIndex((x) => x.name === kept[0].carriedFrom.frame) + 1 : 0;
      const sel = selected();
      const moved = movedPairsOf(row);
      st.box = { total: ts.length, model: pend.length - sugg, suggestions: sugg, kept: kept.length, keptFrom: from || null,
        moved: moved.length, movedSel: !!sel && moved.some((q) => q.kept === sel.id || q.suggestion === sel.id),
        fit: sel && !isMulti() ? fitStateOf(sel).reason || "ok" : "none", fitHint: !!sel && !isMulti() && !G.isQuad(sel) && G.needsFit(sel, fitRecord(sel), ...frameSize()),
        quad: !!sel && !isMulti() && G.isQuad(sel),
        held: row.done ? 0 : (row.prefillSuppressed || []).length, backs: ts.filter((t) => t.outcome === "card-back").length,
        multi: selectedIds().length, placing: !!S.newBoxMode, flagged: ts.some((t) => t.boxFix), prefill: prefillActive(),
        selected: !sel ? null : sel.pending && sel.prefill ? (sel.suggestion ? "suggestion" : "model") : S.prov.has(sel.id) ? "adjusting" : "box",
        review: reviewOn() ? { box: !!sel } : null,
        undo: (S.undo.get(row.name) || []).length, redo: (S.redo.get(row.name) || []).length };
    } else if (m === "identify") {
      const open = S.idq.filter((e) => needsIdentity(e)).length;
      st.names = { count: S.idq.length, index: S.qIdx + 1, open, target: answerView(selected(), true), turns: identifyTurnsShown(),
        undo: (S.undo.get(row.name) || []).length, redo: (S.redo.get(row.name) || []).length };
    } else if (m === "point") {
      const pts = row.points || [];
      st.point = { index: S.pIdx + 1, count: pts.length, answered: pts.filter(complete).length, target: answerView(pts[S.pIdx], false) };
    } else if (m === "center") {
      const n = C ? C.counts(row.centers) : { faces: 0, backs: 0 };
      st.center = { faces: n.faces, backs: n.backs, selected: !!(C && centerById(row, S.csel)),
        undo: (S.cundo.get(row.name) || []).length, redo: (S.credo.get(row.name) || []).length };
    } else if (m === "verify") {
      const it = vItem(), c = vCenter(it), info = vInfo(it);
      const stale = !!c && V.isStale(c, info.sha);
      st.verify = { count: S.vq.length, index: S.vIdx + 1, center: !!c, back: !!c && c.kind === "back", blind: !!info.blind, stale,
        readability: !!c && !!V.readability(c), needsReadability: !!c && V.needsReadability(c) && !stale, complete: !!c && V.isVerified(c, info.sha),
        revealed: vRevealed(it), proposals: !!info.proposals, name: c && c.identity && c.identity !== "unknown" ? cardWho(c.identity) : null,
        arms: verifyArms().map((arm) => { const a = (info.arms && info.arms[arm]) || {}; return { label: arm, name: a.name || null, id: a.printingId || a.artId || null }; }) };
    } else {
      st.corner = { total: ts.length, incomplete: ts.filter((t) => !complete(t)).length, placing: S.placing ? S.placing.corners.length : null,
        target: answerView(selected(), false), snap: !!S.snapOn, undo: (S.undo.get(row.name) || []).length };
    }
    return st;
  }

  // The short status at the top of the side panel: what is on this frame, or which card this is.
  function panelStatus(st) {
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    if (st.imageFailed) return "No picture for this frame";
    if (st.box) {
      if (st.box.review) return reviewProgress();
      const b = st.box;
      const parts = [b.model + b.suggestions ? `${b.model + b.suggestions} from the model to check` : null, b.kept ? `${b.kept} kept` : null,
        b.backs ? plural(b.backs, "card back", "card backs") : null].filter(Boolean);
      return `${plural(b.total, "box", "boxes")} on this frame${parts.length ? ": " + parts.join(", ") : ""}`;
    }
    if (st.names) return st.names.count ? `Card ${st.names.index} of ${st.names.count}` : "No cards to name";
    if (st.point) return st.point.count ? `Point ${st.point.index} of ${st.point.count} · ${st.point.answered} answered on this frame` : "No points";
    if (st.center) return `${plural(st.center.faces, "face", "faces")} · ${plural(st.center.backs, "back", "backs")} on this frame`;
    if (st.verify) {
      if (!st.verify.count) return "No cards to check";
      const how = st.verify.back ? "a card back" : st.verify.blind ? "no suggestion (blind check)" : verifyArms().length ? `with ${verifyArms().join(" and ")}'s suggestion` : "no suggestion";
      return `Card ${st.verify.index} of ${st.verify.count} · ${how}`;
    }
    return `${plural(st.corner.total, "card", "cards")} on this frame · snap to edges ${st.corner.snap ? "on" : "off"}`;
  }

  // The everyday actions of a state: [[group title, [{label, key, mods, cap, act, off}]]].
  // `key` is the key the button stands for (pressKey), `cap` what is printed on it when the key's
  // own name would not read well, `act` an action that has no key of its own.
  function actionGroups(st) {
    const A = (label, key, o) => Object.assign({ label, key }, o || {});
    const undoRedo = (u, r) => [A("Undo", "z", { mods: "meta", cap: `${CMD}+Z`, off: !u }), A("Redo", "z", { mods: "meta shift", cap: `${CMD}+Shift+Z`, off: !r })];
    if (st.imageFailed || st.readOnly) return [];
    if (st.box && st.box.review) {
      const has = st.box.review.box;
      return [["The box shown", [A("Turn the top a quarter", "w", { off: !has }), A("Card back", "b", { off: !has }), A("Too hidden: ignore", "h", { off: !has, title: IGNORE_HELP }),
        A("Remove", "Delete", { off: !has }), A("Previous box", "ArrowLeft", { cap: "←" }), A("Next flagged box", "j"),
        A("Back to the frame", "Escape", { cap: "Esc" })].concat(undoRedo(st.box.undo, st.box.redo))]];
    }
    if (st.box) {
      const b = st.box, one = !!b.selected, any = one || b.multi > 1, model = b.selected === "model" || b.selected === "suggestion";
      const frame = [A("Add a box", null, { act: "add-box", cap: "N, click" })];
      if (b.prefill || b.flagged) frame.push(A("Next box to check", "j"));
      if (b.moved) frame.push(A("Move the kept box to its card", "m", { cap: "M" }));
      return [["Selected box", [A("Accept, then next", "a", { off: !model }), A("Card back", "b", { off: !any }), A("Too hidden: ignore", "h", { off: !any, title: IGNORE_HELP }),
        A("Turn a quarter", "w", { off: !one })].concat(b.quad ? [A("Snap the corners", "s"), A("A rectangle again", "e")] : [], b.prefill && !b.quad ? [A("Fit to the tilted card", "e", { off: b.fit !== "ok", title: b.fit === "ok" ? U.NOTES.fitHelp : U.NOTES.fitWhy[b.fit] })] : [], [A("Tilt +5°", "R", { off: !one, cap: "Shift+R" }), A("Tilt −1°", "r", { off: !one }),
        A("Remove", "Delete", { off: !any })])], ["This frame", frame.concat(undoRedo(b.undo, b.redo))]];
    }
    const other = [A("Card back", "b"), A("Not a card", "x"), A("Cannot be read", "u")];
    if (st.names) {
      const w = st.names, has = !!w.target;
      return [["Other answers", other.concat([A("Unknown card", null, { act: "unknown", title: "A card whose name you cannot tell. Better than a guess." }),
        A("Clear this card's name", "Backspace")]).map((a) => Object.assign(a, { off: !has }))],
        ["Move on", [A("Previous card", "ArrowLeft", { cap: "←" }), A("Next card", "Enter"), A("Next card without a name", " ", { cap: "Space", wide: true })]],
        ["This box, the frame", [A("Turn the top edge", "w", { off: !has || !w.turns }), A("Flag it to fix later", "f", { off: !has })].concat(undoRedo(w.undo, w.redo),
          [A("Zoom the card", "z"), A("Zoom back", "Z", { cap: "Shift+Z" })])]];
    }
    if (st.point) {
      return [["Other answers", other], ["Move on", [A("Previous point", "ArrowLeft", { cap: "←" }), A("Next point", "Enter"),
        A("Next frame with points left", " ", { cap: "Space", wide: true }), A("Clear the answer", "Backspace", { wide: true }), A("Wider view", "z")]]];
    }
    if (st.center) {
      return [["Selected marker", [A("Face or back", "b", { off: !st.center.selected }), A("Remove", "Delete", { off: !st.center.selected })]],
        ["This frame", undoRedo(st.center.undo, st.center.redo)]];
    }
    if (st.verify) {
      const v = st.verify, named = v.readability, arms = v.revealed ? v.arms : [];
      const accept = arms.map((a, i) => A(`Accept ${a.label}'s name`, String(i + 1), { off: !a.name }));
      if (arms.length === 2) accept.push(A("Accept both", "a", { off: !(arms[0].name && arms[1].name) }));
      return [["Answers", accept.concat([A("Pick another card", "/", { off: !named }), A("Unknown card", "u"), A("Not a card", "x"), A("A card back", "b"),
        A("Clear the answer", "Backspace")])],
        ["Move on", [A("Previous card", "ArrowLeft", { cap: "←" }), A("Next card", "ArrowRight", { cap: "→" }), A("Wider or closer crop", "z", { wide: true, cap: "Z / Shift+Z" })]]];
    }
    const has = !!st.corner.target;
    return [["Selected card", other.map((a) => Object.assign(a, { off: !has })).concat([A("Turn the corner order", "r", { off: !has }),
      A("Snap to edges now", "s", { off: !has }), A("Remove", "Delete", { off: !has })])],
    ["This frame", [A("Next card to answer", "j"), A("Snap to edges on or off", "f"), A("Undo", "z", { mods: "meta", cap: `${CMD}+Z`, off: !st.corner.undo })]]];
  }

  // labeler/FORMAT.md, "Three kinds of box"
  const IGNORE_HELP = "Too hidden to learn from: a card that is there but not worth learning from (more than about half covered, its picture and name hidden, heavy motion blur, or cut off by the frame's edge). Box only the visible part.";

  function keyButton(a) {
    const b = document.createElement("button");
    b.type = "button"; b.className = a.wide ? "act wide" : "act"; b.disabled = !!a.off;
    if (a.title) b.title = a.title;
    if (a.act) b.dataset.act = a.act; else { b.dataset.key = a.key; if (a.mods) b.dataset.mods = a.mods; }
    const s = document.createElement("span"); s.textContent = a.label; b.appendChild(s);
    const cap = a.cap || (a.key && a.key.length === 1 ? a.key.toUpperCase() : a.key);
    if (cap) { const k = document.createElement("kbd"); k.textContent = cap; b.appendChild(k); }
    return b;
  }

  // The answers that need no search (card back, not a card ...) sit with the list of names,
  // above it; the other groups come after the list.
  function renderActions(st) {
    const el = $("actions"), top = $("otherAnswers");
    // a button in focus (reached by keyboard) keeps the focus when the buttons are drawn again
    const had = document.activeElement && (el.contains(document.activeElement) || top.contains(document.activeElement)) ? document.activeElement.dataset : null;
    const same = had ? (b) => b.dataset.act === had.act && b.dataset.key === had.key && b.dataset.mods === had.mods : null;
    el.textContent = ""; top.textContent = "";
    for (const [title, list] of actionGroups(st)) {
      if (title === "Other answers" || title === "Answers") { for (const a of list) top.appendChild(keyButton(a)); continue; }
      const g = document.createElement("div"); g.className = "group";
      const h = document.createElement("h2"); h.textContent = title; g.appendChild(h);
      for (const a of list) g.appendChild(keyButton(a));
      el.appendChild(g);
    }
    if (same) { const b = Array.from(el.querySelectorAll("button")).concat(Array.from(top.querySelectorAll("button"))).find(same); if (b && !b.disabled) b.focus(); }
  }

  // The question about reading the card, in the place of the search: the card just picked (with
  // a way to change it), the question, its rule, and the three answers.
  function renderQuestion(d, st) {
    const el = $("question");
    const show = !!d.question && !st.search.focused;
    const inPlace = show && d.question === "frame" && mode() !== "box";
    $("names").classList.toggle("back", inPlace);
    $("searchBox").hidden = inPlace;
    el.hidden = !show;
    if (!show) { el.textContent = ""; return; }
    el.textContent = "";
    const t = mode() === "verify" ? vCenter(vItem()) : selected();
    const card = t && t.identity && t.identity !== "unknown" ? S.byId.get(t.identity) : null;
    if (card) {
      const p = document.createElement("div"); p.className = "picked";
      const img = document.createElement("img"); img.alt = ""; setArt(img, (mode() !== "verify" && t.printing) || card.id); // the printing on screen
      const who = document.createElement("div"); who.className = "who";
      who.innerHTML = `<div class="name"></div><div class="muted"></div>`;
      who.children[0].textContent = cardWho(card.id); who.children[1].textContent = cardKind(card, t.printing);
      p.append(img, who);
      if (mode() !== "verify") p.appendChild(keyButton({ label: "Change", key: "/" }));
      el.appendChild(p);
    }
    const q = U.QUESTIONS[d.question];
    const ask = document.createElement("div"); ask.className = "ask"; ask.textContent = q.title;
    const help = document.createElement("div"); help.className = "help"; help.textContent = q.help;
    const row = document.createElement("div"); row.className = "answers";
    for (const a of U.ANSWERS) row.appendChild(keyButton({ label: a.label, key: a.key.toLowerCase() }));
    el.append(ask, help, row);
  }

  // On the frame: the boxes kept from the frame before, with the action that clears them.
  function renderKept(st) {
    const b = st.box, show = !!b && !b.review && b.kept > 0 && !st.imageFailed;
    $("keptBar").hidden = !show;
    if (!show) return;
    $("keptText").textContent = `${b.kept} ${b.kept === 1 ? "box" : "boxes"} kept from frame ${b.keptFrom || "before"}: check their positions.`
      + (b.held ? ` ${b.held} model ${b.held === 1 ? "box is" : "boxes are"} held back under them.` : "");
  }

  // Under the frame: what each line means (the same lines drawBox draws).
  function renderLegend(st) {
    const el = $("legend");
    const show = !!st.box && !st.box.review && !st.imageFailed;
    el.hidden = !show;
    if (!show) return;
    const kinds = [st.box.prefill ? "model" : null, carryAllowed() ? "kept" : null, "confirmed", "back", "adjusting", "ignored"].filter(Boolean);
    if (el.dataset.sig === kinds.join()) return;
    el.dataset.sig = kinds.join();
    el.textContent = "";
    for (const k of kinds) {
      const s = document.createElement("span"); s.className = "key";
      const c = document.createElement("canvas");
      const ctx = sizeCanvas(c, 34, 12);
      ctx.setLineDash(BOX_LINES[k].dash); ctx.lineWidth = k === "back" ? 3 : 2; ctx.strokeStyle = BOX_LINES[k].color();
      ctx.beginPath(); ctx.moveTo(1, 6); ctx.lineTo(33, 6); ctx.stroke();
      if (k === "ignored") { ctx.setLineDash([]); ctx.strokeStyle = T.cross; ctx.beginPath(); ctx.moveTo(13, 2); ctx.lineTo(21, 10); ctx.moveTo(21, 2); ctx.lineTo(13, 10); ctx.stroke(); }
      s.append(c, document.createTextNode(k === "back" ? `${BOX_LINES[k].label}, marked “back”` : k === "model" ? `${BOX_LINES[k].label}, marked “model”` : BOX_LINES[k].label));
      el.appendChild(s);
    }
  }

  // Everything around the editor, redrawn only when what it shows has changed.
  function renderChrome() {
    if (!S.set || !currentFrame()) return;
    const st = uiState();
    const d = U.describe(st);
    const status = panelStatus(st);
    const sig = JSON.stringify([st, status, S.selId, mode() === "verify" ? vItem() : null, S.connected]);
    if (sig === S.chromeSig) return;
    S.chromeSig = sig;
    setKeyText($("guideText"), d.text);
    $("panelStatus").textContent = status;
    const pb = $("primaryBtn");
    pb.hidden = !d.primary || !!S.finish;
    if (d.primary) {
      pb.dataset.act = d.primary.act;
      pb.textContent = "";
      const s = document.createElement("span"); s.textContent = d.primary.label; pb.appendChild(s);
      if (d.primary.key) { const k = document.createElement("kbd"); k.textContent = d.primary.key; pb.appendChild(k); }
    }
    renderQuestion(d, st);
    renderActions(st);
    renderKept(st);
    renderLegend(st);
    const walk = zoomStage() || reviewOn();
    for (const b of $("frameNav").querySelectorAll("button")) b.title = `${b.dataset.key === "[" ? "Previous" : "Next"} ${walk ? (mode() === "point" ? "point" : reviewOn() ? "frame with boxes" : "card") : "frame"}`;
  }

  // ---- nothing to label ------------------------------------------------------------------------

  function scriptDir() {
    const w = ((S.config && S.config.launch) || []).find((a) => /(^|\/)serve\.py$/.test(String(a)));
    return w ? String(w).replace(/serve\.py$/, "") : "labeler/";
  }

  // An empty sample (or a set without frames): one message with what to do; the editor is hidden.
  function showNoWork(what) {
    document.body.classList.add("no-work");
    $("frameStrip").hidden = true;
    for (const id of ["pointStage", "cornerStage", "legend", "keptBar", "finishCard"]) $(id).hidden = true;
    $("frameInfo").textContent = ""; $("progress").textContent = "";
    const el = $("notice");
    el.innerHTML = `<h1>There is nothing to label yet</h1><p class="what"></p><p>Write a sample from folders of frames, one folder per video:</p><pre class="a"></pre><p>Then open the new sample on the start screen (<a href="/start">all projects</a>), where the toy game is too.</p>`;
    el.querySelector(".what").textContent = what || "The sample file is the list of frames to label, and this one lists no video with frames.";
    el.querySelector(".a").textContent = `${U.shellWord(((S.config && S.config.launch) || ["python3"])[0])} ${scriptDir()}make_sample.py --out sample.json --frames-root FOLDER_OF_FRAME_FOLDERS --n 8`;
    el.hidden = false;
  }

  // ---- the finish card: what was done, and what is next ---------------------------------------

  function workLeft(s) {
    const c = setCounts(s);
    return c.total === null ? 1 : Math.max(0, c.total - c.done);
  }

  function finishStats() {
    const rows = S.frames.map((f) => S.rows.get(f.name) || {});
    const done = rows.filter((r) => r.done).length;
    if (mode() === "identify") { const open = S.idq.filter((e) => needsIdentity(e)).length; return { named: S.idq.length - open, total: S.idq.length }; }
    if (mode() === "verify") { const c = verifyCounts(); return { checked: c.verified, total: c.total }; }
    if (mode() === "center") {
      const n = rows.reduce((a, r) => { const c = C.counts(r.centers); return { faces: a.faces + c.faces, backs: a.backs + c.backs }; }, { faces: 0, backs: 0 });
      return { frames: done, total: S.frames.length, faces: n.faces, backs: n.backs };
    }
    if (mode() === "point") return { frames: done, total: S.frames.length, points: rows.reduce((a, r) => a + (r.points || []).filter(complete).length, 0) };
    return { frames: done, total: S.frames.length, boxes: rows.reduce((a, r) => a + (r.targets || []).length, 0) };
  }

  async function showFinish() {
    if (!S.set) return;
    const setId = S.set.setId, m = mode();
    try { // the other sets' counts as they are on disk (the open set's are live)
      const fresh = await getJSON("/api/sets");
      for (const s of S.sets) {
        const now = fresh.find((x) => x.setId === s.setId);
        if (now && s !== S.set) Object.assign(s, { labeled: now.labeled, verify: now.verify, readOnly: now.readOnly });
      }
      await loadNamedCounts();
    } catch (e) { /* the counts from the start of the session */ }
    let after = null;
    try { // what the project's screen says comes next, and the command of that pass for scripts
      const r = await fetch("/api/project", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const p = await r.json();
      if (p && p.ok && p.next) after = { pass: p.next.pass, startable: !!p.next.startable, scripts: p.next.pass && p.passes[p.next.pass] ? p.passes[p.next.pass].command.text : "" };
    } catch (e) { /* the card then leads to the project screen */ }
    if (!S.set || S.set.setId !== setId) return;
    syncCounts(); refreshSetMenu();
    S.finish = U.finish({ mode: m, setId, stats: finishStats(), after,
      sets: S.sets.map((s) => ({ setId: s.setId, readOnly: !!s.readOnly, left: s === S.set ? 0 : workLeft(s) })) });
    renderFinish();
  }

  function hideFinish() {
    if (!S.finish && $("finishCard").hidden) return;
    S.finish = null;
    $("finishCard").hidden = true;
    S.chromeSig = null;
    renderChrome();
  }

  function renderFinish() {
    const el = $("finishCard"), f = S.finish;
    if (!f) { el.hidden = true; return; }
    el.innerHTML = `<h1><span class="mark" aria-hidden="true">✓</span> <span class="t"></span></h1><p class="d"></p>`;
    el.querySelector(".t").textContent = f.title;
    el.querySelector(".d").textContent = f.detail;
    const p = (text, cls) => { const x = document.createElement("p"); if (cls) x.className = cls; x.textContent = text; el.appendChild(x); return x; };
    const row = document.createElement("div"); row.className = "row";
    const btn = (label, act, primary, cap) => {
      const b = document.createElement("button"); b.type = "button"; b.dataset.act = act; if (primary) b.className = "primary";
      const s = document.createElement("span"); s.textContent = label; b.appendChild(s);
      if (cap) { const k = document.createElement("kbd"); k.textContent = cap; b.appendChild(k); }
      row.appendChild(b); return b;
    };
    let main = null;
    if (f.next.kind === "set") main = btn(f.next.label, "finish-next-set", true, "Enter");
    else if (f.next.kind === "switch") { p(f.next.lead); main = btn(f.next.label, "finish-switch", true, "Enter"); }
    else p(f.next.kind === "project" ? f.next.lead : f.next.text);
    // the way back to the project screen: the primary action when nothing else is
    const back = btn(f.next.kind === "project" ? f.next.label : "Back to the project", "finish-project", !main, main ? null : "Enter");
    const close = btn("Keep looking at this set", "finish-close", false, "Esc");
    el.appendChild(row);
    if (f.note) p(f.note, "warn");
    if (f.next.kind === "switch" && f.next.scripts) p(`For scripts, the same pass as one command: ${f.next.scripts}`, "scripts");
    el.hidden = false;
    S.chromeSig = null;
    renderChrome();
    (main || back || close).focus();
  }

  // The tool switches to the next pass of this project, here, with no new start: everything on
  // this page is saved first, and the server refuses while anything of this run is not
  // (savegate.js says why). The switch is a new run: this page then loads what the tool runs.
  async function switchTo(pass) {
    if (S.switching) return;
    S.switching = true;
    try { await flushSave(); await flushTiming(); } catch (e) { /* said below */ }
    let j;
    if (SG.unsavedCount({ failed: S.failed.size, pending: !!S.pendingSave, saving: S.saveKind === "saving" })) j = { problem: "unsaved" };
    else {
      try {
        const r = await fetch("/api/switch", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ run: S.config.run, tab: TAB, unsaved: 0, pass }) });
        j = await r.json();
      } catch (e) { j = { problem: "no-answer" }; }
    }
    S.switching = false;
    if (j.ok) { window.location.href = "/"; return; }
    if (S.finish) { S.finish.note = SG.switchText(j, U.passName(pass)); renderFinish(); }
    else setStatus(SG.switchText(j, U.passName(pass)));
  }

  // The project screen: its passes, and how to start the next one. What is not saved yet goes
  // out first.
  async function goToProject() {
    try { await flushSave(); await flushTiming(); } catch (e) { /* the page's own unload sends what is left */ }
    window.location.href = "/project";
  }

  // ---- removing a frame from the project (README, "Removing a frame") ------------------------------

  // why the frame on the page cannot be removed (uistate.js), as the server refuses it
  function removeRefusal() {
    if (!S.set || !S.frames || !S.frames.length) return null;
    const f = currentFrame(), row = f && S.rows ? S.rows.get(f.name) : null;
    return U.removeRefusal({ setId: S.set.setId, frameAsset: S.set.frameAsset, mode: mode(), centers: row && row.centers });
  }

  async function openRemove() {
    if (!S.set || !editable() || S.busy || S.remove || !currentFrame()) return;
    if (removeRefusal()) { setStatus(removeRefusal()); return; }
    hideFinish();
    if (mode() === "box") confirmBox();
    try { await flushSave(); } catch (e) { /* said below */ }
    if (unsavedNow()) { setStatus(U.REMOVE_TEXT.unsaved); return; }
    const f = currentFrame(), setId = S.set.setId;
    const row = S.rows.get(f.name);
    S.remove = { setId, name: f.name, idx: S.frameIdx, labeled: !!row && (row.done || items(row).length > 0 || (row.centers || []).length > 0),
      reason: null, pick: null, nearby: null, suggestions: false, error: null, sending: false };
    renderRemove();
    try {
      const r = await fetch(`/api/nearby/${encodeURIComponent(setId)}/${encodeURIComponent(f.name)}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!S.remove || S.remove.name !== f.name) return;
      if (r.ok) { S.remove.nearby = j.frames || []; S.remove.suggestions = !!j.suggestions; S.remove.measuring = j.measuring || null; }
      else { S.remove.nearby = []; S.remove.error = j.error || `The server answered ${r.status}.`; }
    } catch (e) { if (S.remove) { S.remove.nearby = []; S.remove.error = "The server did not answer."; } }
    renderRemove();
  }

  // Tab goes round the question's controls; the reasons are one stop (the arrows move in them)
  function cycleRemoveFocus(dir) {
    const sheet = $("removeSheet"), on = sheet.querySelector("input:checked") || sheet.querySelector("input");
    const all = [...sheet.querySelectorAll("button:not(:disabled), input")].filter((x) => x.type !== "radio" || x === on);
    if (!all.length) return;
    const at = all.indexOf(document.activeElement);
    all[(at + dir + all.length) % all.length].focus();
  }

  function closeRemove() {
    S.remove = null;
    $("removeFrame").hidden = true;
    focusEditor();
  }

  function renderRemove() {
    const st = S.remove, box = $("removeFrame"), sheet = $("removeSheet");
    if (!st) { box.hidden = true; return; }
    const v = U.removeDialog(st);
    const el = (tag, props, text, focus) => {
      const x = Object.assign(document.createElement(tag), props || {});
      if (text !== undefined) x.textContent = text;
      if (focus) x.dataset.focus = focus;
      return x;
    };
    const had = sheet.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    sheet.textContent = "";
    sheet.append(el("h2", { id: "removeTitle" }, v.title), el("p", {}, v.lead));
    const fs = el("fieldset");
    fs.appendChild(el("legend", { className: "muted" }, v.reasonTitle));
    for (const r of v.reasons) {
      const input = el("input", { type: "radio", name: "removeReason", value: r.value, checked: st.reason === r.value }, undefined, `reason:${r.value}`);
      input.addEventListener("change", () => { st.reason = r.value; });
      fs.appendChild(el("label")).append(input, ` ${r.label}`);
    }
    sheet.appendChild(fs);
    if (st.nearby === null) sheet.appendChild(el("p", { className: "muted" }, v.looking));
    if (v.nearby) {
      const strip = el("div", { className: "nearby" });
      for (const f of v.nearby.frames) {
        const b = el("button", { type: "button", title: f.label }, undefined, `near:${f.name}`);
        b.setAttribute("aria-pressed", String(st.pick === f.name));
        b.append(el("img", { alt: "", loading: "lazy", src: `/frames/${encodeURIComponent(S.set.frameAsset)}/${encodeURIComponent(f.name)}` }), el("span", {}, f.label));
        b.addEventListener("click", () => { st.pick = st.pick === f.name ? null : f.name; renderRemove(); });
        strip.appendChild(b);
      }
      sheet.append(el("h2", {}, v.nearby.title), el("p", { className: "muted" }, v.nearby.note), strip);
      if (v.nearby.unknownTime) sheet.appendChild(el("p", { className: "warn" }, v.nearby.unknownTime));
    } else if (v.none) sheet.appendChild(el("p", { className: "muted" }, v.none));
    if (st.error) sheet.appendChild(el("p", { className: "warn", role: "alert" }, st.error));
    const yes = el("button", { type: "button", className: "primary danger", disabled: st.sending }, st.pick ? v.nearby.yes : v.yes, "yes");
    const no = el("button", { type: "button" }, undefined, "no");
    yes.dataset.act = "remove-confirm"; no.dataset.act = "remove-cancel";
    no.append(el("span", {}, v.no), el("kbd", {}, "Esc"));
    sheet.appendChild(el("div", { className: "row" })).append(yes, no);
    box.hidden = false;
    (had && sheet.querySelector(`[data-focus="${CSS.escape(had)}"]`) || no).focus();
  }

  async function doRemove() {
    const st = S.remove;
    if (!st || st.sending || !S.set || S.set.setId !== st.setId) return;
    st.sending = true; st.error = null;
    renderRemove();
    const unsaved = SG.unsavedCount({ failed: S.failed.size, pending: !!S.pendingSave, saving: S.saveKind === "saving" });
    let r, j = {};
    try {
      r = await fetch(`/api/remove-frame/${encodeURIComponent(st.setId)}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: saveBody({ frame: st.name, reason: st.reason, replaceWith: st.pick, unsaved }) });
      j = await r.json().catch(() => ({}));
    } catch (e) { st.sending = false; st.error = U.REMOVE_TEXT.noAnswer; renderRemove(); return; }
    if (SG.isOtherRun(r.status, j)) { closeRemove(); await checkRun(); setStatus(U.REMOVE_TEXT.otherRun); return; }
    if (!r.ok) { st.sending = false; st.error = `Nothing was removed: ${j.error || `the server answered ${r.status}`}`; renderRemove(); return; }
    const setId = st.setId, idx = st.idx, added = j.added ? j.added.name : null;
    closeRemove();
    await reopenAfterRemove(setId, idx, added);
    setStatus(U.removedStatus(st.name, added));
  }

  // the set as the server now lists it, at the frame chosen instead or the one in its place
  async function reopenAfterRemove(setId, idx, added) {
    try { S.sets = await getJSON("/api/sets"); } catch (e) { return; }
    refreshSetMenu();
    await openSet(setId);
    if (!S.set || S.set.setId !== setId || !S.frames.length || mode() === "identify" || mode() === "verify") return;
    const at = added ? S.frames.findIndex((f) => f.name === added) : -1;
    await gotoFrame(at >= 0 ? at : Math.min(idx, S.frames.length - 1));
  }

  // ---- the keys overlay --------------------------------------------------------------------------

  function toggleHelp(on) {
    S.helpOpen = on === undefined ? !S.helpOpen : !!on;
    if (S.helpOpen) { renderKeys(); $("keysTitle").textContent = `Keys of the ${S.set ? U.passName(mode()) : U.passName(S.config.mode)} pass`; }
    $("keys").hidden = !S.helpOpen;
    if (!S.helpOpen) focusEditor();
  }

  // ---- save state and connection state: two indicators ----------------------------------------

  function renderSaveState() {
    const v = U.saveLabel({ failed: Array.from(S.failed.keys()), pending: S.saveKind === "unsaved" || !!S.pendingSave, saving: S.saveKind === "saving", connected: S.connected,
      otherRun: S.otherRun });
    for (const [el, x] of [[$("saveState"), v.save], [$("connState"), v.conn]]) {
      el.className = `pill ${x.kind}`;
      el.innerHTML = `<span aria-hidden="true"></span><span class="word"></span>`;
      el.children[0].textContent = x.mark; el.children[1].textContent = x.text;
      el.setAttribute("aria-label", x.text);
    }
  }

  // Every few seconds: does the server still answer? An ordinary GET of /api/config (the server
  // leaves these out of its request log). A server that is gone shows within one beat.
  async function heartbeat() {
    let ok = false;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), HEARTBEAT_MS - 500);
    let now = null;
    try {
      const r = await fetch("/api/config?ping=1", { cache: "no-store", signal: ctl.signal });
      ok = r.ok;
      if (ok) now = await r.json();
    } catch (e) { ok = false; }
    clearTimeout(t);
    // The tool was started again: this page is of the run before. The same work goes on under
    // the new run; other work loads the page again when nothing waits here, and else stops the
    // page's saves, with a banner that says what waits (checkRun, savegate.js).
    let act = "go-on";
    if (now) {
      act = await checkRun(now);
      if (act === "reload") return;
      reportUnsaved(true);
    }
    if (ok === S.connected) {
      if (act === "adopt" && ok) { await retryFailed(); flushTiming(); } // what waited for this run goes out now
      return;
    }
    S.connected = ok;
    renderSaveState(); renderSaveBanner();
    if (ok) { // back again: what waited goes out now
      await retryFailed();
      flushTiming();
      if (S.imgFailed && !S.busy) reloadFrame();
    }
  }

  // ---- input --------------------------------------------------------------------------------

  function canvasPos(ev) {
    const r = $("frameCanvas").getBoundingClientRect();
    return { x: (ev.clientX - r.left) / S.view.s, y: (ev.clientY - r.top) / S.view.s };
  }

  function hitHandle(p) {
    const t = selected();
    if (!t || mode() === "point") return null;
    const tol = 9 / S.view.s;
    let best = null, bd = tol;
    t.corners.forEach((c, i) => { const d = Math.hypot(c[0] - p.x, c[1] - p.y); if (d <= bd) { bd = d; best = i; } });
    return best;
  }

  function insidePoly(q, p) { return G.pointInQuad(q, p); }

  function wireUi() {
    $("pickerInput").addEventListener("input", () => { S.picker.fresh = true; renderPicker(); renderChrome(); });
    $("pickerInput").addEventListener("focus", () => { S.pickerOpenedAt = S.pickerOpenedAt || Date.now(); renderChrome(); });
    $("pickerInput").addEventListener("blur", (ev) => { if (!(ev.relatedTarget && ev.relatedTarget.closest("#kindChips"))) S.pickerOpenedAt = null; renderChrome(); });
    // A click on a control does not take the keyboard focus from the frame (a text field and a
    // menu do take it): the keys that follow a click act as they did before it.
    document.addEventListener("mousedown", (ev) => {
      const ctl = ev.target.closest && ev.target.closest("button, summary, label, input[type=checkbox]");
      if (ctl && !ev.target.closest("select, input:not([type=checkbox]), textarea")) ev.preventDefault();
    });
    // Every button that stands for a key sends that key to the editor; one with an action of its
    // own runs it. With the focus in a text field, the click leaves the field first.
    document.addEventListener("click", (ev) => {
      const b = ev.target.closest && ev.target.closest("button[data-key], button[data-act]");
      const menu = $("frameMenu");
      if (menu.open && !(ev.target.closest && ev.target.closest("#frameMenu > summary"))) menu.open = false;
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      const searching = ["pick", "search", "search-all"].includes(act) || b.dataset.key === "/";
      const typing = KR.focusKind(document.activeElement ? { tag: document.activeElement.tagName, type: document.activeElement.type } : null) === "text";
      if (typing && !searching && !(act || "").startsWith("finish")) focusEditor();
      if (S.finish && !(act || "").startsWith("finish")) hideFinish();
      if (act) runAct(act); else pressKey(b.dataset.key, b.dataset.mods);
    });
    $("helpBtn").addEventListener("click", () => toggleHelp());
    $("keysClose").addEventListener("click", () => toggleHelp(false));
    $("keys").addEventListener("mousedown", (ev) => { if (ev.target === $("keys")) toggleHelp(false); });
    $("searchFirstToggle").addEventListener("change", (ev) => {
      S.searchFirst = ev.target.checked; lsSet(LS.searchFirst, S.searchFirst ? "on" : "off");
      setStatus(S.searchFirst ? "Each card now starts in the search box. The letter keys type there: Esc leaves the search." : "Each card starts with the keys on the frame again. / opens the search.");
    });
    $("overview").addEventListener("mouseenter", showFrameEnlarge);
    NF.wire(); // the Names pass and Check names: the thumbnail opens the whole frame
    // the Names pass: on the card's view the wheel zooms at the pointer, a drag on the box changes
    // it (box sets), a drag elsewhere pans
    const zv = $("zoomView"), card = () => mode() === "identify" && !reviewOn() && !!S.idView;
    const redraw = () => { if (!S.fvRaf) S.fvRaf = requestAnimationFrame(() => { S.fvRaf = 0; render(); }); };
    const drag = (move, end) => { const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); if (end) end(); }; addEventListener("mousemove", move); addEventListener("mouseup", up); };
    zv.addEventListener("wheel", (ev) => {
      if (!card()) return;
      ev.preventDefault();
      const r = zv.getBoundingClientRect();
      S.cv = Names.zoomAt(S.cv, cropDims(), Math.exp(-ev.deltaY / 300), ev.clientX - r.left, ev.clientY - r.top); redraw();
    }, { passive: false });
    $("overview").addEventListener("mouseleave", hideFrameEnlarge);
    $("pickerInput").addEventListener("keydown", pickerKey);
    $("scopeDeck").addEventListener("click", () => { S.picker.scope = "decklist"; renderPicker(); });
    $("scopeAll").addEventListener("click", () => { S.picker.scope = "all"; renderPicker(); });
    $("clearFiltersBtn").addEventListener("click", () => clearFilters());
    $("printingInput").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { commitPrinting(); ev.preventDefault(); }
      else if (ev.key === "Escape") { closePrintingEditor(); closePicker(); ev.preventDefault(); }
      ev.stopPropagation();
    });
    $("confirmedToggle").addEventListener("change", (ev) => {
      if (ev.target.checked) confirmFrame({ advance: false }); else unconfirmFrame();
    });
    $("clearFrameBtn").addEventListener("click", () => pressKey("X", "shift"));
    $("carryToggle").addEventListener("change", (ev) => {
      S.carryOn = ev.target.checked; lsSet(LS.carry, S.carryOn ? "on" : "off");
      if (S.carryOn && mode() === "box") { tryCarryOver(S.frameIdx); render(); }
    });
    $("snapToggle").addEventListener("change", (ev) => setBoxSnap(ev.target.checked));
    $("stackViewToggle").addEventListener("change", (ev) => setStackView(ev.target.checked));
    $("hoverToggle").addEventListener("change", (ev) => setHoverArt(ev.target.checked));
    $("boxesOnlyToggle").addEventListener("change", (ev) => setBoxesOnly(ev.target.checked));
    $("verifyBacksToggle").addEventListener("change", (ev) => setVerifyBacks(ev.target.checked));
    $("reviewToggle").addEventListener("change", (ev) => setReview(ev.target.checked));
    $("reviewIgnoreToggle").addEventListener("change", (ev) => {
      S.review.includeIgnore = ev.target.checked;
      if (reviewOn()) { setStatus(`Card backs and ignored boxes are ${S.review.includeIgnore ? "checked too, last on each frame." : "left out of the check."}`); render(); }
    });
    const dbInput = () => setDefaultBox(parseFloat($("defaultBoxW").value), parseFloat($("defaultBoxH").value));
    for (const id of ["defaultBoxW", "defaultBoxH"]) {
      $(id).addEventListener("input", dbInput);
      $(id).addEventListener("change", () => { dbInput(); renderDefaultBox(); });
      $(id).addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === "Escape") { ev.target.blur(); ev.preventDefault(); } ev.stopPropagation(); });
    }
    $("newBoxChange").addEventListener("click", () => {
      $("options").open = true; $("defaultBox").open = true;
      $("defaultBoxW").focus(); $("defaultBoxW").select();
    });
    $("defaultFromSel").addEventListener("click", defaultFromSelected);
    $("defaultToSel").addEventListener("click", defaultToSelected);
    renderFilters();
    renderPicker();
    const c = $("frameCanvas");
    c.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0 || S.imgFailed) return;
      if (S.finish) hideFinish();
      c.focus();
      const p = canvasPos(ev);
      if (mode() === "box") { boxMouseDown(p, ev); ev.preventDefault(); return; }
      if (mode() === "center") { if (C) centerMouseDown(p, ev); ev.preventDefault(); return; }
      if (!S.placing) {
        const h = hitHandle(p);
        if (h !== null && editable()) {
          S.selCorner = h;
          const row = rowFor(currentFrame());
          S.drag = { corner: h, before: JSON.stringify(row.targets), moved: false };
          render(); return;
        }
        if (!ev.altKey && !ev.shiftKey) {
          const ts = rowFor(currentFrame()).targets || [];
          const hit = ts.slice().reverse().find((t) => insidePoly(t.corners, p));
          if (hit && hit.id !== S.selId) { S.selId = hit.id; S.selCorner = null; render(); return; }
          if (hit && hit.id === S.selId) { return; } // Alt+click starts a new target on top of a card
        }
      }
      placeCorner(p, ev.shiftKey);
    });
    c.addEventListener("dblclick", (ev) => {
      if (mode() !== "box" || !editable()) return;
      if (Date.now() - S.lastCreateAt < 600) return; // the first click just made a box (snap / n)
      const hit = topBoxAt(canvasPos(ev));
      if (!hit) return; // double-click on empty frame does nothing
      confirmBox();
      selectOnly(hit.id);
      tapSel(1);
      ev.preventDefault();
    });
    c.addEventListener("mouseleave", () => {
      hideHoverPreview();
      if (mode() === "box" && !S.bdrag) { S.mouse = null; render(); }
      if (mode() === "center" && !S.cdrag) { S.mouse = null; S.chover = null; render(); }
    });
    window.addEventListener("mousemove", (ev) => {
      if (zoomStage() || $("cornerStage").hidden || !S.set) return;
      const p = canvasPos(ev);
      S.mouse = p;
      if (mode() === "box") { boxMouseMove(p, ev); return; }
      if (mode() === "center") { if (C) centerMouseMove(p, ev); return; }
      if (S.drag) {
        const t = selected();
        if (t) { t.corners[S.drag.corner] = [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]; S.drag.moved = true; }
        render(); return;
      }
      if (S.placing) render(); else renderLoupe();
    });
    window.addEventListener("mouseup", (ev) => {
      if (S.set && mode() === "box") { boxMouseUp(ev); return; }
      if (S.set && mode() === "center") { if (C) centerMouseUp(ev); return; }
      if (!S.drag) return;
      const d = S.drag; S.drag = null;
      if (d.moved) {
        const row = rowFor(currentFrame());
        pushUndo(row, d.before);
        const t = selected();
        if (t) {
          if (t.cornerSource === "snap") t.cornerSource = "snap-edited";
          else if (t.cornerSource === "prefill") t.cornerSource = "prefill-edited";
          afterChange(row, t);
        }
      }
      render();
    });
    // identify mode: hover art over the zoom view
    $("zoomView").addEventListener("mousemove", (ev) => {
      if (reviewOn()) {
        S.review.mouse = reviewViewPos(ev);
        setReviewAlt(ev.altKey && !ev.shiftKey ? reviewEdgeAt(S.review.mouse) : null);
        return;
      }
      if (!card()) { hideHoverPreview(); return; }
      S.idMouse = idViewPos(ev);
      setIdAlt(ev.altKey && !ev.shiftKey ? idEdgeAt(S.idMouse) : null);
      const h = S.ndrag || ev.altKey ? null : namesHit(ev).hit; // the cursor says what a drag will do
      if (!ev.altKey) zv.style.cursor = h && h.mode !== "empty" ? (namesEditBlocked() ? "not-allowed" : CURSORS[h.handle || h.mode]) : "grab";
      const p = G.viewToFrame(S.idView, S.idMouse.x, S.idMouse.y);
      const ts = rowFor(currentFrame()).targets || [];
      const curT = selected();
      let hit = curT && G.pointInQuad(curT.corners, p) ? curT : null; // the walk's target first
      if (!hit) for (const i of G.orderDesc(ts)) if (G.pointInQuad(ts[i].corners, p)) { hit = ts[i]; break; }
      showHoverPreview(hit, ev.clientX, ev.clientY, false, true); // beside the crop, never over the grid
    });
    $("zoomView").addEventListener("mouseleave", () => { hideHoverPreview(); S.review.mouse = null; setReviewAlt(null); S.idMouse = null; setIdAlt(null); });
    // review walk: Option/Alt+click an edge of the box in the zoom view makes it the card's top
    $("zoomView").addEventListener("mousedown", (ev) => {
      // identify mode, box sets: Option/Alt+click an edge = that edge is the top
      if (!reviewOn() && mode() === "identify" && ev.button === 0 && ev.altKey && !ev.shiftKey) {
        ev.preventDefault(); identifyEdgeClick(idViewPos(ev)); return;
      }
      if (card() && ev.button === 0) {
        ev.preventDefault();
        if (namesEditStart(ev)) { drag(namesEditMove, namesEditEnd); return; } // the current box: move, resize or rotate it
        let x = ev.clientX, y = ev.clientY;
        drag((e) => { S.cv = Names.panBy(S.cv, cropDims(), e.clientX - x, e.clientY - y); x = e.clientX; y = e.clientY; redraw(); });
        return;
      }
      if (!reviewOn() || ev.button !== 0) return;
      ev.preventDefault();
      if (ev.altKey && !ev.shiftKey) reviewEdgeClick(reviewViewPos(ev));
      else setStatus("To set the top here, hold Option/Alt and click the edge. Esc goes back to the frame.");
    });
    window.addEventListener("resize", render);
    document.addEventListener("keydown", onKey);
    const altKey = (ev) => {
      if (ev.key === "Alt" && S.set && mode() === "identify") { setIdAlt(ev.type === "keydown" && !ev.shiftKey ? idEdgeAt(S.idMouse) : null); return; }
      if (ev.key !== "Alt" || !S.set || mode() !== "box" || S.bdrag) return;
      if (reviewOn()) { setReviewAlt(ev.type === "keydown" && !ev.shiftKey ? reviewEdgeAt(S.review.mouse) : null); return; }
      setAltEdge(ev.type === "keydown" && !ev.shiftKey ? altEdgeAt(S.mouse) : null);
    };
    document.addEventListener("keydown", altKey);
    document.addEventListener("keyup", altKey);
    window.addEventListener("blur", () => { setAltEdge(null); setReviewAlt(null); setIdAlt(null); });
  }

  // ---- box-mode mouse: a drag on empty frame draws, a click there deselects; a click
  // selects the topmost box; a drag on a box moves it (the selection when it is part of one);
  // corner handles and edges resize, the knob rotates; Shift+click / Shift+drag multi-select.

  // `scale`: screen px per frame px (the Names pass's frame view); `only`: the selected box alone
  function boxHit(p, ev, scale, only) {
    const row = rowFor(currentFrame());
    const s = scale || S.view.s;
    const t = selected();
    if (t && editable() && !ev.altKey) {
      const h = G.handleAt(t, p, KNOB_PX / s, HANDLE_PX / s, EDGE_PX / s);
      if (h) return Object.assign(h, { t });
    }
    if (!ev.altKey) {
      const hit = only ? (t && G.pointInQuad(t.corners, p) ? t : null) : topBoxAt(p);
      if (hit) return { mode: "move", t: hit };
    }
    return { mode: "empty", row };
  }

  const CURSORS = { rotate: "grab", move: "move", empty: "crosshair", t: "ns-resize", b: "ns-resize", l: "ew-resize", r: "ew-resize",
    tl: "nwse-resize", br: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize" };

  const QUAD_DRAGS = ["move", "resize", "rotate", "corner", "edge", "qrotate"];

  function boxMouseDown(p, ev) {
    if (!S.img || !S.img.naturalWidth || S.busy) return;
    S.besideArmed = null; // a click after D cancels it: the next arrow moves the box as usual
    hideHoverPreview();
    const row = rowFor(currentFrame());
    const hit = boxHit(p, ev);
    const base = { start: p, cur: p, x: ev.clientX, y: ev.clientY, moved: false, before: JSON.stringify(row.targets) };
    const edge = ev.altKey && !ev.shiftKey ? altEdgeAt(p) : null;
    if (edge) { // Alt+click an edge: set the top on release; a drag instead draws (Alt+drag)
      S.bdrag = Object.assign(base, { mode: "topEdge", k: edge.k, id: edge.id });
    } else if (BE.quadDragStart(hit, p, ev.shiftKey)) { // a box with free corners, or Shift+drag a corner
      S.bdrag = Object.assign(base, BE.quadDragStart(hit, p, ev.shiftKey));
    } else if (hit.mode === "rotate" || hit.mode === "resize") {
      const r = hit.mode === "rotate" ? turnedRect(hit.t, rectOf(hit.t).angle) : rectOf(hit.t);
      S.bdrag = Object.assign(base, { mode: hit.mode, id: hit.t.id, handle: hit.handle, orig: r, startAngle: G.angleFromCenter({ x: r.cx, y: r.cy }, p) });
    } else if (hit.mode === "move") {
      if (ev.shiftKey) { toggleInSelection(hit.t.id); return; }
      const sel = selectedIds();
      const group = sel.length > 1 && sel.includes(hit.t.id) ? sel : [hit.t.id];
      if (group.length === 1 && hit.t.id !== S.selId) { confirmBox(); selectOnly(hit.t.id); render(); }
      if (!editable()) return;
      S.bdrag = Object.assign(base, { mode: "move", id: hit.t.id, group,
        origs: group.map((id) => targetById(row, id).corners.map((q) => [q[0], q[1]])) });
    } else {
      S.bdrag = Object.assign(base, { mode: ev.shiftKey ? "marquee" : "draw" });
    }
  }

  function boxMouseMove(p, ev) {
    const c = $("frameCanvas");
    const d = S.bdrag;
    if (!d) {
      if (ev.target !== c) { if (S.newBoxMode) render(); setAltEdge(null); return; }
      const ae = ev.altKey && !ev.shiftKey ? altEdgeAt(p) : null;
      setAltEdge(ae);
      if (ae) { c.style.cursor = "cell"; hideHoverPreview(); return; }
      const hit = boxHit(p, ev);
      c.style.cursor = S.newBoxMode ? "copy" : CURSORS[hit.handle || hit.mode] || "crosshair";
      showHoverPreview(hit.mode === "move" || hit.mode === "resize" || hit.mode === "rotate" ? hit.t : null, ev.clientX, ev.clientY);
      if (S.newBoxMode) render();
      return;
    }
    d.cur = p;
    if (!d.moved) {
      if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) <= DRAG_PX) return;
      d.moved = true;
      if (d.mode === "topEdge") { d.mode = "draw"; setAltEdge(null); }
      if (d.mode === "draw") logEvent({ ev: "started" });
      if (QUAD_DRAGS.includes(d.mode)) reopen(d.group || [d.id]);
    }
    const row = rowFor(currentFrame());
    const [W, H] = frameSize();
    if (d.mode === "move") {
      d.group.forEach((id, k) => {
        const t = targetById(row, id);
        if (t) t.corners = G.translateCorners(d.origs[k], p.x - d.start.x, p.y - d.start.y, W, H, true);
      });
    } else if (d.mode === "resize") {
      const t = targetById(row, d.id);
      if (t) resizeTo(t, G.resizeWithin(d.orig, d.handle, p, W, H, G.MIN_BOX));
    } else if (d.mode === "rotate") {
      const t = targetById(row, d.id);
      const a = G.angleFromCenter({ x: d.orig.cx, y: d.orig.cy }, p);
      if (t) turnTo(t, Object.assign({}, d.orig, { angle: G.normalizeAngle(d.orig.angle + (a - d.startAngle)) }));
    } else if (d.center) BE.quadDragMove(d, targetById(row, d.id), p);
    render();
  }

  function boxMouseUp(ev) {
    const d = S.bdrag;
    if (!d) return;
    S.bdrag = null;
    const row = rowFor(currentFrame());
    if (d.mode === "topEdge") {
      if (isMulti() || d.id !== S.selId) { confirmBox(); selectOnly(d.id); }
      setTopEdgeSel(d.k); render(); return;
    }
    if (QUAD_DRAGS.includes(d.mode)) {
      if (d.moved && JSON.stringify(row.targets) !== d.before) {
        pushUndo(row, d.before);
        afterChange(row, targetById(row, d.id) || row.targets[0]);
      } else if (!d.moved && d.mode === "move" && d.group.length > 1) {
        confirmBox(); selectOnly(d.id); render(); // a plain click on a selected box narrows the selection
      } else render();
      return;
    }
    if (d.mode === "marquee") {
      if (!d.moved && S.boxSnap) { snapClickAt(d.start, true); return; } // Shift+click in snap mode: sideways
      if (d.moved) selectInRect(d.start, d.cur); else render();
      return;
    }
    // draw
    if (d.moved) {
      if (!editable()) { render(); return; }
      const [W, H] = frameSize();
      const q = G.boxCorners(d.start.x, d.start.y, d.cur.x, d.cur.y, W, H);
      S.newBoxMode = false;
      createBoxRect({ cx: (q[0][0] + q[2][0]) / 2, cy: (q[0][1] + q[2][1]) / 2, w: q[1][0] - q[0][0], h: q[3][1] - q[0][1], angle: 0 });
      return;
    }
    // a click on the frame where there is no box (boxsize.js): a box of the new-box size there, a
    // box snapped to the card's edges (snap on), or, with a box selected, letting go of it
    const click = BS.clickOnFrame({ editable: editable(), placing: S.newBoxMode, snap: S.boxSnap, selected: !!S.selId || S.extraSel.size > 0 });
    if (click === "place") { S.newBoxMode = false; placeDefaultAt(d.start); return; }
    if (click === "snap") { snapClickAt(d.start, false); return; }
    confirmBox();
    S.selId = null; S.extraSel = new Set(); S.selCorner = null;
    render();
  }

  function onBoxKey(ev) {
    const k = ev.key;
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (S.besideArmed && !KR.stillArmed(S.besideArmed, besideContext())) S.besideArmed = null; // armed elsewhere: gone
    if (S.besideArmed) {
      S.besideArmed = null;
      const side = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[k];
      if (side) { besideSel(side); return true; }
      if (k === "Escape") { setStatus("Canceled."); return true; }
      setStatus(""); // any other key does what it always does
    }
    if (arrows[k]) {
      const step = ev.shiftKey ? 10 : 1;
      if (selectedIds().length) nudgeBox(arrows[k][0] * step, arrows[k][1] * step, ev.altKey);
      else if (k === "ArrowLeft") gotoFrame(S.frameIdx - 1);
      else if (k === "ArrowRight") gotoFrame(S.frameIdx + 1);
      return true;
    }
    if (k === "Enter") {
      if (ev.shiftKey) { unconfirmFrame(); return true; }
      // a selected detector box (prefill): Enter accepts it as is (an edited one: as edited)
      const prow = rowFor(currentFrame());
      const pend = selectedIds().filter((id) => { const t = targetById(prow, id); return t && t.pending && t.prefill; });
      if (pend.length) {
        const n = acceptPrefill(pend, "enter");
        confirmBox(); S.selId = null; S.extraSel = new Set(); S.selCorner = null;
        const left = pendingPrefill(prow).length;
        setStatus(`Accepted ${n}.${left ? ` ${left} model ${left === 1 ? "box" : "boxes"} left on this frame.` : ""}`);
        render(); return true;
      }
      // Enter confirms and lets go of the box(es) (their handles no longer catch the next clicks);
      // a selected box is let go first, so a stray Enter never confirms the frame by surprise
      if (confirmBox() || S.selId) { S.selId = null; S.extraSel = new Set(); S.selCorner = null; setStatus(""); render(); }
      else confirmFrame();
      return true;
    }
    if (k === "Escape") {
      if (S.bdrag) { const d = S.bdrag; S.bdrag = null; if (d.moved && d.mode !== "draw" && d.mode !== "marquee") { rowFor(currentFrame()).targets = JSON.parse(d.before); } setStatus("Canceled."); }
      else if (S.newBoxMode) { S.newBoxMode = false; setStatus(""); }
      else { confirmBox(); S.selId = null; S.extraSel = new Set(); S.selCorner = null; }
      render(); return true;
    }
    const map = {
      b: () => toggleKind("back"), B: () => toggleKind("back"),
      h: () => toggleKind("ignore"), H: () => toggleKind("ignore"),
      e: fitSel, E: fitSel, u: namesGuard(setUnknown), a: acceptKey, j: jumpPrefill, x: clearCarried, X: clearFrame, m: moveKept, M: moveKept,
      r: () => rotateSel(-1), R: () => rotateSel(5),
      w: () => tapSel(1), W: () => tapSel(-1),
      ".": () => reorderSel(1), ",": () => reorderSel(-1), ">": () => reorderSel("front"), "<": () => reorderSel("back"),
      N: () => map.n(), G: () => distributeSel(), L: () => sameLayout(), P: () => setHoverArt(!S.hoverArt),
      n: () => { S.newBoxMode = true; setStatus(""); render(); },
      f: () => setBoxSnap(!S.boxSnap), F: () => setBoxSnap(!S.boxSnap),
      s: () => (ev.shiftKey ? defaultToSelected() : G.isQuad(selected()) && !isMulti() ? snapQuadSel() : S.boxSnap && selected() ? resnapSel() : defaultFromSelected()),
      S: defaultToSelected,
      g: distributeSel, "+": insertIntoRow, "=": insertIntoRow, "-": removeFromRow, l: sameLayout,
      p: () => setHoverArt(!S.hoverArt),
      o: () => setStackView(!S.stackView), O: () => setStackView(!S.stackView),
      d: () => armBeside(), D: () => armBeside(),
      v: () => setReview(true), V: () => setReview(true),
      Backspace: deleteTarget, Delete: deleteTarget,
      Tab: () => cycleTarget(ev.shiftKey ? -1 : 1),
      "]": () => gotoFrame(S.frameIdx + 1), PageDown: () => gotoFrame(S.frameIdx + 1),
      "[": () => gotoFrame(S.frameIdx - 1), PageUp: () => gotoFrame(S.frameIdx - 1),
      "/": namesGuard(openPicker), i: namesGuard(openPicker), I: namesGuard(openPicker),
    };
    if (map[k]) { map[k](); return true; }
    if (onFilterKey(k)) return true;
    // box mode owns the printable keys: none falls through to another mode's meaning (x, y, c…)
    return k.length === 1;
  }

  function onIdentifyKey(ev) {
    const k = ev.key;
    if (k === "Enter" || k === "ArrowRight" || k === "]") { nextInQueue(false); return true; }
    if (k === "ArrowLeft" || k === "[") { gotoQueue(S.qIdx - 1); return true; }
    if (k === " ") { nextInQueue(true); return true; }
    if (k === "Backspace") { clearAnswer(); return true; }
    if (k === "PageDown" || k === "}" || k === "PageUp" || k === "{") {
      const dir = k === "PageDown" || k === "}" ? 1 : -1;
      const cur = S.idq[S.qIdx] && S.idq[S.qIdx].frame;
      const n = dir > 0 ? S.idq.findIndex((e, i) => i > S.qIdx && e.frame !== cur)
        : S.idq.map((e, i) => (i < S.qIdx && e.frame !== cur ? i : -1)).filter((i) => i >= 0).pop();
      if (n !== undefined && n >= 0) gotoQueue(n);
      return true;
    }
    if (k === "a") { openPrintingEditor(); return true; }
    if (k === "p") { setHoverArt(!S.hoverArt); return true; }
    if (k === "z" || k === "Z") { zoomCard(k === "Z"); return true; } // the card's view: the next / previous zoom, round
    // box sets: the top is the next edge clockwise / counter-clockwise; the box stays
    if (k === "w" || k === "W") { identifyTurn(k === "w" ? 1 : 3, k); return true; }
    // f: flag the box for a geometry fix in a later box-mode pass (the identity pass never moves a
    // box); saved as `boxFix: true`, an answer field, not geometry
    if (k === "f") {
      const t = selected();
      if (t) { mutate((x) => { if (x.boxFix) delete x.boxFix; else x.boxFix = true; }); setStatus(t.boxFix ? "Flagged: this box is to be fixed later in the Boxes pass. F again takes the flag off." : "Flag taken off."); render(); }
      return true;
    }
    if (onFilterKey(k)) return true;
    return false;
  }

  // A key pressed anywhere on the page: who handles it depends on where the focus is
  // (keyroute.js). A text field keeps every key; Enter and Space on a focused button act on that
  // button only; every other key is the editor's, whatever control has the focus.
  function onKey(ev) {
    if (S.remove) { // the removal question: no key reaches the frame
      if (ev.key === "Escape") { closeRemove(); ev.preventDefault(); }
      else if (ev.key === "Tab") { cycleRemoveFocus(ev.shiftKey ? -1 : 1); ev.preventDefault(); }
      else if (!["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)) ev.preventDefault();
      return;
    }
    if (NF.key(ev)) return; // the whole frame, open: Esc closes it
    const el = document.activeElement;
    const focus = KR.focusKind(el && el !== document.body ? { tag: el.tagName, type: el.type, editable: el.isContentEditable } : null);
    const where = KR.route({ key: ev.key, meta: ev.metaKey, ctrl: ev.ctrlKey, focus, helpOpen: S.helpOpen, finishOpen: !!S.finish });
    if (where === "field" || where === "control" || where === "browser") return;
    if (where === "help") { toggleHelp(); ev.preventDefault(); return; }
    if (where === "panel") { focusPanel(); ev.preventDefault(); return; }
    if (where === "finish") { hideFinish(); focusEditor(); ev.preventDefault(); return; }
    if (where === "leave") { focusEditor(); ev.preventDefault(); return; }
    // work goes on under the finish card: it steps aside (the modifier keys alone do not count)
    if (S.finish && !["Shift", "Alt", "Control", "Meta"].includes(ev.key)) hideFinish();
    editorKey(ev);
  }

  // The shortcuts of the pass in use. The keydown listener ends here, and so does every button
  // that stands for a key (pressKey).
  function editorKey(ev) {
    if (!S.set) return;
    if (S.busy) { ev.preventDefault(); return; } // a frame is loading: keys would act on the old one
    const k = ev.key;
    const meta = ev.metaKey || ev.ctrlKey;
    // a frame whose picture did not load takes no label: only the keys that move on
    if (S.imgFailed && (meta || !FRAME_KEYS.includes(k) || (reviewOn() && k.startsWith("Arrow")))) {
      if (!meta && (k.length === 1 || ["Enter", "Tab", "Backspace", "Delete"].includes(k))) ev.preventDefault();
      return;
    }
    const pointMode = mode() === "point";
    let handled = true;
    if (reviewOn()) {
      // the review walk owns the keys; of the shortcuts only undo / redo (this frame)
      if (meta) {
        const lk = k.toLowerCase();
        if (lk === "z" && ev.shiftKey) redo();
        else if (lk === "z") undo();
        else if (lk === "y") redo();
        else if (["c", "v", "d"].includes(lk)) setStatus("Copy and paste work on the frame: Esc goes back to it.");
        else return; // other shortcuts stay the browser's
        ev.preventDefault(); return;
      }
      if (onReviewKey(ev)) ev.preventDefault();
      return;
    }
    if (meta && mode() === "box") {
      const lk = k.toLowerCase();
      if (!editable()) return;
      if (lk === "z" && ev.shiftKey) redo();
      else if (lk === "z") undo();
      else if (lk === "y") redo();
      else if (lk === "c") copyBox();
      else if (lk === "v") pasteBox("paste");
      else if (lk === "d") duplicateBox();
      else return; // other shortcuts stay the browser's
      ev.preventDefault(); return;
    }
    if (!meta && mode() === "box" && editable() && onBoxKey(ev)) { ev.preventDefault(); return; }
    if (mode() === "verify") {
      if (meta) return; // no shortcuts of its own: the browser's stay
      if (onVerifyKey(ev)) ev.preventDefault();
      return;
    }
    if (mode() === "center") {
      if (!C) return;
      if (meta) {
        const lk = k.toLowerCase();
        if (!editable()) return;
        if (lk === "z" && ev.shiftKey) centerRedo();
        else if (lk === "z") centerUndo();
        else if (lk === "y") centerRedo();
        else return; // other shortcuts stay the browser's
        ev.preventDefault(); return;
      }
      if (onCenterKey(ev)) ev.preventDefault();
      return;
    }
    if (meta && mode() === "identify") {
      // undo / redo (this frame): answers and top-edge turns alike
      const lk = k.toLowerCase();
      if (!editable()) return;
      if (lk === "z" && ev.shiftKey) redo();
      else if (lk === "z") undo();
      else if (lk === "y") redo();
      else return; // other shortcuts stay the browser's
      ev.preventDefault(); return;
    }
    if (!meta && mode() === "identify" && onIdentifyKey(ev)) { ev.preventDefault(); return; }
    if (meta && (k === "z" || k === "Z")) { if (!pointMode && mode() !== "identify") undo(); }
    else if (meta) handled = false;
    else if (pointMode && (k === "z" || k === "Z")) cyclePointZoom(k === "Z");
    else if (k === "/" || k === "i") openPicker();
    else if (k === "x") setOutcome("not-card");
    else if (k === "b") setOutcome("card-back");
    else if (k === "u") setOutcome("unreadable");
    else if (k === "y") setEligible("yes");
    else if (k === "n") setEligible("no");
    else if (k === "m") setEligible("uncertain");
    else if (k === "o") cycleSource();
    else if (k === "c") cycleBool("faceUp");
    else if (k === "l") cycleBool("blur");
    else if (k === "g") cycleBool("glare");
    else if (k === "k") cycleBool("sleeveOrFoil");
    else if (k === "v") cycleVis();
    else if (pointMode) {
      const row = rowFor(currentFrame());
      if (k === "ArrowRight" || k === "]" || k === "Enter") {
        if (S.pIdx < row.points.length - 1) { S.pIdx++; render(); markShown(); } else gotoFrame(S.frameIdx + 1, "first");
      } else if (k === "ArrowLeft" || k === "[") {
        if (S.pIdx > 0) { S.pIdx--; render(); markShown(); } else gotoFrame(S.frameIdx - 1, "last");
      } else if (k === "PageDown" || k === "}") gotoFrame(S.frameIdx + 1);
      else if (k === "PageUp" || k === "{") gotoFrame(S.frameIdx - 1);
      else if (k === " ") nextUnlabeled();
      else if (k === "Backspace") clearAnswer();
      else handled = false;
    } else if (mode() === "identify") {
      handled = false; // geometry keys do nothing in the identity pass
    } else if (mode() === "box") {
      // a read-only box set: frames only
      if (k === "]" || k === "PageDown" || k === "ArrowRight") gotoFrame(S.frameIdx + 1);
      else if (k === "[" || k === "PageUp" || k === "ArrowLeft") gotoFrame(S.frameIdx - 1);
      else handled = false;
    } else {
      if (k === "Escape") { if (S.placing) { S.placing = null; setStatus(""); } else { S.selId = null; S.selCorner = null; } render(); }
      else if (k === "Backspace" && S.placing) { S.placing.corners.pop(); S.placing.estimated.pop(); if (!S.placing.corners.length) S.placing = null; render(); }
      else if (k === "Backspace" || k === "Delete") deleteTarget();
      else if (k === "e") toggleEstimated();
      else if (k === "r") rotateOrder();
      else if (k === "f") { S.snapOn = !S.snapOn; setStatus(S.snapOn ? "Snap is on: new corners move to the card's edges." : "Snap is off."); render(); }
      else if (k === "s") resnap();
      else if (k === "Tab") cycleTarget(ev.shiftKey ? -1 : 1);
      else if (k === "j") nextPending();
      else if (k === "Enter") confirmFrame();
      else if (k === "ArrowRight" || k === "]") gotoFrame(S.frameIdx + 1);
      else if (k === "ArrowLeft" || k === "[") gotoFrame(S.frameIdx - 1);
      else handled = false;
    }
    if (handled) ev.preventDefault();
  }

  // exposed for scripted checks in the browser console
  window.Labeler = { state: S, uiState, pressKey, gotoFrame, setOutcome, setEligible, placeCorner, choose, flushSave, flushTiming, scheduleSave,
    createBoxRect, confirmBox, nudgeBox, toggleKind, confirmFrame, unconfirmFrame, gotoQueue, nextInQueue, openPicker,
    undo, redo, copyBox, pasteBox, saveFrame, setTopEdgeSel, identifyTurn, duplicateBox, rotateSel, tapSel, reorderSel, clearCarried, setFilter, render,
    acceptKey, jumpPrefill, acceptPrefill, deleteTarget, clearFrame,
    addCenterAt, deleteCenter, toggleCenterKind, confirmCenterFrame, centerUndo, centerRedo,
    verifyGo, verifyAnswer, verifyReveal, verifyReadability, verifyClear, setVerifyBacks };
  boot().catch((e) => { const b = $("banner"); b.hidden = false; b.textContent = `The page could not start: ${e.message}. Is the server running? Reload when it is.`; });
})(window);
