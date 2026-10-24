// SPDX-License-Identifier: Apache-2.0
// Tests for uistate.js: the instruction line and the primary button of each state, the progress
// counts, the save and connection indicators and the finish card.
// Run: node test_uistate.js (also run by test_serve.py)
"use strict";
const assert = require("assert");
const U = require("./uistate.js");

const frame = (o) => Object.assign({ index: 2, count: 5, done: false, last: false }, o || {});
const idle = { focused: false, query: "", matches: 6, scope: "decklist", highlight: "Jade Ring" };
const d = (s) => U.describe(Object.assign({ frame: frame(), search: idle }, s));
const box = (b, f) => d({ mode: "box", box: Object.assign({ total: 0, model: 0, suggestions: 0, kept: 0, multi: 0 }, b), frame: frame(f) });
const enter = (label) => ({ label, key: "Enter", act: "enter" });

// ---- key caps -------------------------------------------------------------------------------
assert.deepStrictEqual(U.parts("Press {{Enter}} now"), [{ text: "Press " }, { key: "Enter" }, { text: " now" }]);
assert.deepStrictEqual(U.parts("{{[}} and {{]}}"), [{ key: "[" }, { text: " and " }, { key: "]" }]);
assert.deepStrictEqual(U.parts("plain"), [{ text: "plain" }]);

// ---- the Boxes pass: the primary button says what Enter will do -----------------------------
{
  let r = box({ total: 6, model: 6 });
  assert.deepStrictEqual(r.primary, enter("Accept 6 model boxes and finish frame"));
  assert.ok(r.text.startsWith("6 boxes suggested by the model."), r.text);
  assert.ok(r.text.includes("{{Enter}} accepts them all and finishes the frame"));
  assert.deepStrictEqual(box({ total: 1, model: 1 }).primary, enter("Accept 1 model box and finish frame"));

  // a suggestion beside kept boxes is never accepted by Enter: the button says "review"
  r = box({ total: 7, kept: 6, suggestions: 1, keptFrom: 2 });
  assert.deepStrictEqual(r.primary, enter("Review 1 suggestion"));
  assert.ok(r.text.startsWith("1 model suggestion, marked ?"), r.text);
  assert.deepStrictEqual(box({ total: 8, kept: 6, suggestions: 2 }).primary, enter("Review 2 suggestions"));

  // a card that moved: its kept box and the model's ? box for it are paired; M moves the kept box
  const move = { label: "Move the kept box to its card", key: "M", act: "move-kept" };
  r = box({ total: 8, kept: 6, suggestions: 2, moved: 1, keptFrom: 2 });
  assert.deepStrictEqual(r.primary, move, "a pair comes before the suggestions");
  assert.ok(r.text.startsWith("A card has moved: the arrow goes from its kept box"), r.text);
  assert.ok(r.text.includes("{{M}} moves the kept box there and removes the suggestion"), r.text);
  r = box({ total: 9, kept: 6, suggestions: 3, moved: 2 });
  assert.ok(r.text.startsWith("2 cards have moved: each arrow"), r.text);
  assert.deepStrictEqual(r.primary, move);
  // selected: one of the pair says so, any other box as before
  r = box({ total: 8, kept: 6, suggestions: 2, moved: 1, selected: "suggestion", movedSel: true, multi: 1 });
  assert.deepStrictEqual(r.primary, move);
  assert.ok(r.text.includes("the card has moved. {{M}} moves the kept box onto the model's box"), r.text);
  r = box({ total: 8, kept: 6, suggestions: 2, moved: 1, selected: "box", movedSel: true, multi: 1 });
  assert.deepStrictEqual(r.primary, move);
  assert.deepStrictEqual(box({ total: 8, kept: 6, suggestions: 2, moved: 1, selected: "suggestion", multi: 1 }).primary, enter("Accept this box"));
  // a done frame has no pair to offer
  assert.deepStrictEqual(box({ total: 8, kept: 0, moved: 1 }, { done: true }).primary, enter("Go to the next frame"));

  r = box({ total: 7, kept: 7, keptFrom: 1 });
  assert.deepStrictEqual(r.primary, enter("Finish frame"));
  assert.ok(r.text.startsWith("7 boxes kept from frame 1."), r.text);

  r = box({ total: 0 });
  assert.deepStrictEqual(r.primary, enter("Finish frame with no cards"));
  assert.ok(r.text.startsWith("No boxes yet. Click a card for a box of the new-box size, or drag across it."), r.text);

  r = box({ total: 3 });
  assert.deepStrictEqual(r.primary, enter("Finish frame"));

  // a selected box: Enter acts on the box, never on the frame
  assert.deepStrictEqual(box({ total: 6, model: 6, selected: "model", multi: 1 }).primary, enter("Accept this box"));
  assert.deepStrictEqual(box({ total: 7, suggestions: 1, selected: "suggestion", multi: 1 }).primary, enter("Accept this box"));
  assert.deepStrictEqual(box({ total: 1, selected: "adjusting", multi: 1 }).primary, enter("Confirm this box"));
  assert.deepStrictEqual(box({ total: 1, selected: "box", multi: 1 }).primary, enter("Done with this box"));
  // a selected box: the instruction line names the box that is too hidden to learn from, with its key
  for (const selected of ["model", "adjusting", "box"]) assert.ok(box({ total: 1, selected, multi: 1 }).text.includes("{{H}} too hidden to learn from: ignore"), selected);
  assert.ok(box({ total: 2, review: { box: true } }).text.includes("{{H}} too hidden to learn from: ignore"));
  r = box({ total: 3, multi: 3 });
  assert.deepStrictEqual(r.primary, enter("Done with these boxes"));
  assert.ok(r.text.startsWith("3 boxes selected."));

  // a finished frame, and the last one of the set
  assert.deepStrictEqual(box({ total: 7 }, { done: true }).primary, enter("Go to the next frame"));
  assert.deepStrictEqual(box({ total: 7 }, { done: true, last: true }).primary, enter("See what is next"));

  assert.strictEqual(box({ total: 2, placing: true }).primary, null);
  assert.deepStrictEqual(box({ total: 2, review: { box: true } }).primary, enter("Top edge is right: next box"));
}

// ---- states that come before any pass ------------------------------------------------------
assert.strictEqual(U.describe({ noSets: true }).primary, null);
assert.ok(U.describe({ noSets: true }).text.includes("no frames"));
{
  const r = d({ mode: "box", imageFailed: { name: "f00002.png" }, box: { total: 0 } });
  assert.deepStrictEqual(r.primary, { label: "Try loading the picture again", key: null, act: "reload-frame" });
  assert.ok(r.text.includes("did not load") && r.text.includes("cannot be labeled"), r.text);
  const ro = d({ mode: "box", readOnly: "It was made in another mode.", box: { total: 3 } });
  assert.strictEqual(ro.primary, null);
  assert.ok(ro.text.startsWith("You can look at this set but not change it."));
}

// ---- the Names pass ---------------------------------------------------------------------------
{
  const names = (w, search) => d({ mode: "identify", names: Object.assign({ count: 29, index: 3, open: 27 }, w), search: search || idle });
  const open = { outcome: "card", identity: null, eligible: null, asks: false, complete: false };
  let r = names({ target: open });
  assert.strictEqual(r.text, "Which card is this? {{/}} then type to search, or click it in the list.");
  assert.deepStrictEqual(r.primary, { label: "Search for the card", key: "/", act: "search" });

  // a card is picked: the question about reading it, three answers, no single primary button
  r = names({ target: { outcome: "card", identity: "TOY-010", name: "Jade Ring", eligible: null, asks: true, complete: false } });
  assert.strictEqual(r.question, "frame");
  assert.strictEqual(r.primary, null);
  assert.ok(r.text.startsWith("Jade Ring · TOY-010. Can you read this card from this frame alone?"), r.text);
  assert.strictEqual(U.QUESTIONS.frame.title, "Can you read this card from this frame alone?");
  assert.strictEqual(U.QUESTIONS.frame.help, "Using only what this frame shows: not other frames, the deck list or what you know of the game.");
  assert.deepStrictEqual(U.ANSWERS.map((a) => [a.key, a.value]), [["Y", "yes"], ["M", "uncertain"], ["N", "no"]]);

  // the search in use: Enter picks the highlighted card; no match says so and offers all cards
  r = names({ target: open }, { focused: true, query: "ja", matches: 2, scope: "decklist", highlight: "Jade Ring · TOY-010", highlightName: "Jade Ring", sameName: 1 });
  assert.deepStrictEqual(r.primary, { label: "Pick Jade Ring · TOY-010", key: "Enter", act: "pick" });
  assert.ok(r.text.startsWith("Type to search the deck list."), r.text);
  // different cards of one name: the line says so once, and the id is part of what Enter picks
  r = names({ target: open }, { focused: true, query: "jade ring", matches: 5, scope: "all", highlight: "Jade Ring · TOY-022", highlightName: "Jade Ring", sameName: 3 });
  assert.ok(r.text.startsWith("3 cards are called “Jade Ring”. Check the picture and the id."), r.text);
  assert.ok(r.text.includes("{{Enter}} picks Jade Ring · TOY-022"), r.text);
  assert.deepStrictEqual(r.primary, { label: "Pick Jade Ring · TOY-022", key: "Enter", act: "pick" });
  r = names({ target: open }, { focused: true, query: "zzz", matches: 0, scope: "decklist", highlight: null });
  assert.ok(r.text.startsWith("No card matches “zzz” in the deck list."), r.text);
  assert.deepStrictEqual(r.primary, { label: "Search all cards", key: "Tab", act: "search-all" });
  r = names({ target: open }, { focused: true, query: "zzz", matches: 0, scope: "all", highlight: null });
  assert.ok(r.text.startsWith("No card matches “zzz”."), r.text);
  assert.strictEqual(r.primary, null);

  // answered cards: each outcome keeps its own words; Enter goes on
  const done = (t) => names({ target: Object.assign({ complete: true, asks: false }, t) });
  r = done({ outcome: "card", identity: "TOY-010", name: "Jade Ring", eligible: "uncertain" });
  assert.ok(r.text.startsWith("Jade Ring · TOY-010, readable: unsure."), r.text);
  assert.deepStrictEqual(r.primary, enter("Next card"));
  assert.ok(done({ outcome: "card", identity: "unknown" }).text.startsWith("Marked as an unknown card."));
  assert.ok(done({ outcome: "unreadable" }).text.startsWith("Marked as a card that cannot be read."));
  assert.ok(done({ outcome: "not-card" }).text.startsWith("Marked as not a card."));
  assert.ok(done({ outcome: "card-back" }).text.startsWith("Marked as a card back."));

  // the last card of the set: what is next, or the cards still open
  const last = { outcome: "not-card", complete: true, asks: false };
  assert.deepStrictEqual(names({ index: 29, open: 0, target: last }).primary, enter("See what is next"));
  assert.deepStrictEqual(names({ index: 29, open: 2, target: last }).primary, { label: "Go to the next card without a name", key: "Space", act: "space" });
  assert.strictEqual(names({ count: 0 }).primary, null);
  assert.ok(names({ count: 0 }).text.startsWith("Nothing to name in this set"));
}

// ---- the Centers pass: Enter on a frame with no marker is not a plain "next" ------------------
{
  const center = (c, f) => d({ mode: "center", center: Object.assign({ faces: 0, backs: 0 }, c), frame: frame(f) });
  let r = center({});
  assert.deepStrictEqual(r.primary, enter("Confirm no cards in this frame"));
  assert.ok(r.text.includes("No cards in this frame? {{Enter}} confirms it as empty."), r.text);
  assert.deepStrictEqual(center({ faces: 6, backs: 1 }).primary, enter("Confirm frame: 6 faces, 1 back"));
  assert.deepStrictEqual(center({ faces: 1, backs: 0 }).primary, enter("Confirm frame: 1 face, 0 backs"));
  assert.deepStrictEqual(center({ faces: 2 }, { done: true }).primary, enter("Go to the next frame to do"));
  assert.ok(center({ faces: 2, selected: true }).text.startsWith("Marker selected."));
}

// ---- the Corners passes and the Points pass ------------------------------------------------
{
  const corner = (c, mode, f) => d({ mode: mode || "corner", corner: Object.assign({ total: 0, incomplete: 0, placing: null }, c), frame: frame(f) });
  assert.deepStrictEqual(corner({}).primary, enter("Finish frame with no cards"));
  assert.ok(corner({ placing: 0 }).text.startsWith("Corner 1 of 4: click the card's own top-left corner."));
  assert.ok(corner({ placing: 3 }).text.startsWith("Corner 4 of 4: click the card's own bottom-left corner."));
  assert.strictEqual(corner({ placing: 2 }).primary, null);
  assert.deepStrictEqual(corner({ total: 6, incomplete: 5 }, "training").primary, enter("Show the next card that needs an answer"));
  assert.ok(corner({ total: 6, incomplete: 5 }, "training").text.startsWith("5 cards from the model still need checking"));
  assert.deepStrictEqual(corner({ total: 2, incomplete: 0 }).primary, enter("Finish frame"));
  assert.strictEqual(corner({ total: 1, incomplete: 1, target: { outcome: "card", identity: "TOY-010", asks: true } }).question, "frame");
  assert.deepStrictEqual(corner({ total: 1, incomplete: 1, target: { outcome: null, asks: false, complete: false } }).primary.act, "search");

  const point = (p) => d({ mode: "point", point: Object.assign({ index: 1, count: 12, answered: 0 }, p) });
  assert.ok(point({ target: { outcome: null, asks: false, complete: false } }).text.startsWith("What is under the ring?"));
  assert.deepStrictEqual(point({ target: { outcome: "not-card", asks: false, complete: true } }).primary, enter("Next point"));
}

// ---- Check names: the crop first, with the rule in plain words -------------------------------
{
  const verify = (v, search) => d({ mode: "verify", verify: Object.assign({ count: 24, index: 1, center: true, arms: [{ label: "new", name: null }] }, v), search: search || idle });
  let r = verify({ readability: false });
  assert.strictEqual(r.question, "crop");
  assert.ok(r.text.startsWith("Step 1 of 2: is the name legible in this crop?"), r.text);
  assert.strictEqual(U.QUESTIONS.crop.title, "Is the name legible in this crop?");
  assert.strictEqual(U.QUESTIONS.crop.help, "Knowing the card from its art, the catalog or the game does not count.");
  // a card without suggestions says, before step 1, that the search comes after the answer
  r = verify({ readability: false, blind: true });
  assert.ok(r.text.includes("after your answer you search for its name"), r.text);
  r = verify({ readability: true, blind: true });
  assert.ok(r.text.startsWith("Step 2 of 2: no suggestion for this card."), r.text);
  r = verify({ readability: true, revealed: true, proposals: true, arms: [{ label: "new", name: "Jade Ring" }] });
  assert.ok(r.text.startsWith("Step 2 of 2: is this Jade Ring? {{1}} accepts the suggestion"), r.text);
  r = verify({ readability: true, revealed: true, proposals: true, arms: [{ label: "new", name: "Jade Ring", id: "TOY-022" }] });
  assert.ok(r.text.startsWith("Step 2 of 2: is this Jade Ring · TOY-022? {{1}} accepts the suggestion"), r.text);
  r = verify({ readability: true, revealed: true, proposals: true, arms: [{ label: "new", name: "Jade Ring" }, { label: "old", name: "Plum Ring" }] });
  assert.ok(r.text.includes("{{1}} new's · {{2}} old's · {{A}} both"), r.text);
  r = verify({ readability: true, proposals: true });
  assert.deepStrictEqual(r.primary, { label: "Show the suggestion", key: "Space", act: "space" });
  r = verify({ complete: true, readability: true });
  assert.deepStrictEqual(r.primary, { label: "Next card still open", key: "Space", act: "space" });
  assert.ok(verify({ stale: true, readability: false }).text.startsWith("This card was answered for another position"));
}

// ---- no internal words in anything a state says ---------------------------------------------
{
  const texts = [];
  const walk = (v) => { if (typeof v === "string") texts.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  for (const b of [{ total: 6, model: 6 }, { total: 7, kept: 6, suggestions: 1 }, { total: 7, kept: 7 }, {}, { total: 1, selected: "model" },
    { total: 8, kept: 6, suggestions: 2, moved: 1 }, { total: 9, kept: 6, suggestions: 3, moved: 2 }, { total: 8, moved: 1, selected: "box", movedSel: true }]) walk(box(b));
  walk(d({ mode: "center", center: {} }));
  walk(d({ mode: "verify", verify: { count: 2, center: true, readability: false, blind: true, arms: [] } }));
  walk(U.finish({ mode: "box", setId: "a", stats: { frames: 5, total: 5, boxes: 3 }, sets: [] }));
  for (const t of texts) assert.ok(!/\b(det|prefill|carry-over|carried|arms?|eligible|detector)\b/i.test(t), t);
}

// ---- the fit hint: a model's box turned and larger than its fit ---------------------------------
{
  let r = box({ total: 6, model: 6, selected: "model", multi: 1, fitHint: true, fit: "ok" });
  assert.ok(r.text.startsWith("Turned. {{E}} fits the box to the tilted card. This box is the model's suggestion."), r.text);
  assert.deepStrictEqual(r.primary, enter("Accept this box"), "the primary is the selected state's");
  r = box({ total: 6, kept: 6, selected: "adjusting", multi: 1, fitHint: true, fit: "ok" });
  assert.ok(r.text.startsWith("Turned. {{E}} fits the box to the tilted card. Adjust the box"), r.text);
  assert.ok(!box({ total: 6, model: 6, selected: "model", multi: 1, fit: "ok" }).text.includes("{{E}}"), "no hint when it fits");
  assert.ok(!box({ total: 6, model: 6, fitHint: true }).text.includes("{{E}}"), "nothing selected: no hint");
}

// ---- status notes, the keys overlay's model rows, a command's interpreter -----------------------
{
  assert.ok(U.NOTES.fitted.startsWith("Fitted to the tilted card"));
  for (const r of ["none", "edited", "edge", "upright"]) assert.ok(U.NOTES.fitWhy[r] && U.NOTES.fitWhy[r].length < 120, r);
  assert.ok(!U.NOTES.moved.includes("stays inside"), "turning never fits by itself");
  assert.ok(U.NOTES.moved.includes("Enter confirms it"));
  assert.ok(U.NOTES.noMove.startsWith("No card here has moved"));
  assert.ok(U.NOTES.notPaired.startsWith("The selected box is not one of a card that moved"));
  assert.ok(U.NOTES.noModel.startsWith("This set has no model's boxes"), "no model boxes: not \"the model sees no card\"");
  assert.ok(U.NOTES.busy.includes("then M"));
  const keys = U.KEYS_PREFILL.map((r) => r[0]);
  assert.ok(keys.includes("M") && keys.includes("X") && keys.includes("E"), keys.join());
  for (const t of Object.values(U.NOTES).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v))).concat(U.KEYS_PREFILL.map((r) => r[1]))) assert.ok(!/\b(det|prefill|carry-over|carried|detector)\b/i.test(t), t);
  assert.strictEqual(U.shellWord("python3"), "python3");
  assert.strictEqual(U.shellWord("/usr/local/bin/python3.12"), "/usr/local/bin/python3.12");
  assert.strictEqual(U.shellWord("/Users/me/my tools/python3"), "'/Users/me/my tools/python3'");
  assert.strictEqual(U.shellWord("/o'k/python"), "'/o'\\''k/python'");
}

// ---- the keys overlay's tables: rows of [keys, what they do] ------------------------------------
{
  // a box with free corners: Shift+drag a corner frees them, S snaps them, E makes a rectangle again
  const box = new Map(U.KEYS_BOX);
  assert.ok(/free the selected box's corners/.test(box.get("Shift+drag a corner")));
  assert.ok(/snap its corners/.test(box.get("S")) && /rectangle again/.test(box.get("E")));
  assert.strictEqual(U.KEYS_BOX.length, box.size, "no key is listed twice in the Boxes pass");
  for (const k of ["fold", "names", "arrows", "rect", "snapped", "snapKept", "noPicture", "beside"]) assert.ok(U.NOTES.quad[k], k);
}
for (const n of ["KEYS_BOX", "KEYS_REVIEW", "KEYS_IDENTIFY", "KEYS_ANSWER", "KEYS_POINT", "KEYS_CORNER", "KEYS_CENTER", "KEYS_VERIFY", "KEYS_PREFILL"]) {
  assert.ok(Array.isArray(U[n]) && U[n].length > 0, n);
  for (const row of U[n]) assert.ok(row.length === 2 && row.every((x) => typeof x === "string" && x), `${n}: ${row}`);
}

// ---- progress: one set of counts for the top bar and the set menu ----------------------------
assert.strictEqual(U.progress({ counts: { unit: "frames", done: 2, total: 5 } }), "2 of 5 frames done");
assert.strictEqual(U.progress({ counts: { unit: "frames", done: 2, total: 5 }, needFix: 1 }), "2 of 5 frames done · 1 needs a fix");
assert.strictEqual(U.progress({ counts: { unit: "named", done: 12, total: 29 } }), "12 named · 17 left");
assert.strictEqual(U.progress({ counts: { unit: "checked", done: 3, total: 24 } }), "3 of 24 checked · 21 left");
assert.strictEqual(U.setLabel({ setId: "table-a", counts: { unit: "frames", done: 5, total: 5 } }), "table-a · 5 of 5 frames");
assert.strictEqual(U.setLabel({ setId: "table-a", channel: "Club night", counts: { unit: "named", done: 12, total: 29 } }), "table-a · Club night · 17 left to name");
assert.strictEqual(U.setLabel({ setId: "table-a", counts: { unit: "named", done: 29, total: 29 } }), "table-a · all named");
assert.strictEqual(U.setLabel({ setId: "t", counts: { unit: "checked", done: 3, total: 24 } }), "t · 3 of 24 checked");
assert.strictEqual(U.setLabel({ setId: "old", readOnly: "x", counts: { unit: "frames", done: 1, total: 2 } }), "old · 1 of 2 frames · read-only");
assert.strictEqual(U.setLabel({ setId: "b", counts: { unit: "named", done: 0, total: null } }), "b");
assert.strictEqual(U.frameLabel(2, 5), "Frame 2 of 5");
assert.strictEqual(U.passName("identify"), "Names");
assert.strictEqual(U.passName("verify"), "Check names");
assert.strictEqual(U.roleName("test"), "Final test");

// ---- save state and connection state are two things ------------------------------------------
{
  let v = U.saveLabel({ failed: [], connected: true });
  assert.deepStrictEqual([v.save.text, v.save.kind, v.conn.text, v.conn.kind], ["Saved", "ok", "Server running", "ok"]);
  v = U.saveLabel({ failed: [], pending: true, connected: true });
  assert.strictEqual(v.save.text, "Saving…");
  v = U.saveLabel({ failed: ["f00002.png"], connected: true });
  assert.deepStrictEqual([v.save.text, v.save.kind], ["Not saved: f00002.png", "error"]);
  assert.strictEqual(U.saveLabel({ failed: ["a", "b"], connected: false }).save.text, "Not saved: 2 frames");
  // a page of another run (the tool was started again on other work): never "Saved", whatever else holds
  for (const more of [{}, { failed: ["f00001.png"] }, { pending: true }, { saving: true }, { connected: false }, { failed: ["a"], connected: false }]) {
    const o = U.saveLabel(Object.assign({ failed: [], connected: true, otherRun: true }, more));
    assert.ok(!/^Saved/.test(o.save.text) && o.save.kind === "error", JSON.stringify([more, o.save]));
    assert.notStrictEqual(o.conn.text, "Server running");
  }
  assert.deepStrictEqual(U.saveLabel({ failed: [], connected: true, otherRun: true }), { save: { text: "Not saving", kind: "error", mark: "!" }, conn: { text: "Tool on other work", kind: "error", mark: "×" } });
  assert.strictEqual(U.saveLabel({ failed: ["f00001.png"], connected: true, otherRun: true }).save.text, "Not saved: f00001.png");
  assert.ok(U.describe({ mode: "box", otherRun: true, frame: { index: 1, count: 5 } }).text.startsWith("The tool now runs other work (another pass or project)"));
  assert.strictEqual(U.describe({ mode: "box", otherRun: true, frame: { index: 1, count: 5 } }).primary, null);
  // the server is gone: never a plain "Saved" as if all were well
  v = U.saveLabel({ failed: [], connected: false });
  assert.deepStrictEqual([v.conn.text, v.conn.kind], ["Server stopped", "error"]);
  assert.notStrictEqual(v.save.text, "Saved");
  assert.strictEqual(v.save.kind, "stale");
  // every state has a mark as well as a word: never a color alone
  for (const s of [{ connected: true }, { connected: false }, { failed: ["x"] }, { pending: true }]) { const x = U.saveLabel(s); assert.ok(x.save.mark && x.conn.mark); }
}

// ---- the finish card ---------------------------------------------------------------------------
{
  const sets = [{ setId: "table-a", left: 0 }, { setId: "table-b", left: 5 }];
  let f = U.finish({ mode: "box", setId: "table-a", stats: { frames: 5, total: 5, boxes: 36 }, sets });
  assert.strictEqual(f.title, "table-a: 5 of 5 frames, 36 boxes");
  assert.deepStrictEqual(f.next, { kind: "set", setId: "table-b", label: "Next set: table-b" });
  // no set left: the project says what is next. A pass the page can start: the card switches
  // the tool to it, here, with the command for scripts as small print
  const both = [{ setId: "table-a", left: 0 }, { setId: "table-b", left: 0 }];
  const cmd = "python3 labeler/serve.py --mode identify --role training --sample toy/sample.json";
  f = U.finish({ mode: "box", setId: "table-b", stats: { frames: 5, total: 5, boxes: 34 }, sets: both, after: { pass: "identify", startable: true, scripts: cmd } });
  assert.deepStrictEqual(f.next, { kind: "switch", pass: "identify", lead: "All sets have their boxes. Next: name each box, in the Names pass.", label: "Continue to Names", scripts: cmd });
  f = U.finish({ mode: "center", setId: "t", stats: { frames: 5, total: 5, faces: 24, backs: 1 }, sets: [], after: { pass: "verify", startable: true, scripts: "" } });
  assert.deepStrictEqual([f.next.kind, f.next.label, f.next.lead], ["switch", "Continue to Check names", "All sets have their centers. Next: name each clicked center, in the Check names pass."]);
  // a next pass that cannot be started yet (no catalog): the project screen says what it needs
  f = U.finish({ mode: "box", setId: "table-b", stats: { frames: 5, total: 5, boxes: 34 }, sets: both, after: { pass: "identify", startable: false } });
  assert.deepStrictEqual(f.next, { kind: "project", lead: "All sets have their boxes. Next: Names. The project screen says what it needs first.", label: "Back to the project: Names is next" });
  // the export is next: written on the project screen
  f = U.finish({ mode: "identify", setId: "table-b", stats: { named: 3, total: 3 }, sets: both, after: { pass: "export", startable: false } });
  assert.deepStrictEqual(f.next, { kind: "project", lead: "All sets are named. Next: write the labels to a file, on the project screen.", label: "Back to the project: Export is next" });
  // nothing is next
  f = U.finish({ mode: "box", setId: "table-b", stats: { frames: 5, total: 5, boxes: 34 }, sets: both, after: { pass: null, startable: false } });
  assert.deepStrictEqual(f.next.label, "Back to the project");
  // the project could not be asked: the pass's own next step, from the project screen
  f = U.finish({ mode: "box", setId: "table-b", stats: { frames: 5, total: 5, boxes: 34 }, sets: both });
  assert.deepStrictEqual(f.next, { kind: "project", lead: "All sets have their boxes. Next: Names, from the project screen.", label: "Back to the project: Names is next" });
  // a set before the finished one still has work: it is offered too (the menu wraps round)
  f = U.finish({ mode: "box", setId: "table-b", stats: { frames: 5, total: 5, boxes: 1 }, sets: [{ setId: "table-a", left: 2 }, { setId: "table-b", left: 0 }] });
  assert.deepStrictEqual(f.next, { kind: "set", setId: "table-a", label: "Next set: table-a" });
  // a read-only set is never the next one
  f = U.finish({ mode: "box", setId: "table-a", stats: { frames: 5, total: 5, boxes: 1 }, sets: [{ setId: "table-a", left: 0 }, { setId: "old", left: 3, readOnly: true }] });
  assert.strictEqual(f.next.kind, "project");
  f = U.finish({ mode: "identify", setId: "table-b", stats: { named: 36, total: 36 }, sets: [] });
  assert.strictEqual(f.title, "table-b: 36 boxes answered, none left to name");
  assert.deepStrictEqual([f.next.kind, f.next.label], ["project", "Back to the project: Export is next"]);
  assert.ok(f.next.lead.startsWith("All sets are named. Next: write the labels to a file"));
  for (const mode of ["corner", "training"]) {
    f = U.finish({ mode, setId: "t", stats: { frames: 5, total: 5, boxes: 7 }, sets: [] });
    assert.deepStrictEqual([f.title, f.next.label], ["t: 5 of 5 frames, 7 cards", "Back to the project: Export is next"]);
  }
  f = U.finish({ mode: "center", setId: "t", stats: { frames: 5, total: 5, faces: 24, backs: 1 }, sets: [] });
  assert.strictEqual(f.title, "t: 5 of 5 frames, 24 faces and 1 back");
  assert.deepStrictEqual([f.next.kind, f.next.label], ["project", "Back to the project: Check names is next"]);
  f = U.finish({ mode: "verify", setId: "t", stats: { checked: 24, total: 24 }, sets: [] });
  assert.strictEqual(f.title, "t: 24 of 24 cards checked");
  assert.deepStrictEqual([f.next.kind, f.next.label], ["project", "Back to the project: Export is next"], "the census, named: the manifest is next");
  // without the project's answer no card shows a command or a flag
  for (const mode of ["box", "identify", "corner", "training", "center", "point", "verify"]) {
    const text = JSON.stringify(U.finish({ mode, setId: "t", stats: { frames: 1, total: 1 }, sets: [] }));
    assert.ok(!/--|serve\.py|python/.test(text), text);
  }
}

// ---- removing a frame from the project: the question, and the nearby frames ----
{
  // a set whose every frame was removed says so in the set menu
  assert.strictEqual(U.setLabel({ setId: "t", removed: 3, counts: { unit: "frames", done: 0, total: 0 } }), "t · every frame removed");
  assert.strictEqual(U.setLabel({ setId: "t", removed: 1, counts: { unit: "frames", done: 2, total: 4 } }), "t · 2 of 4 frames", "with frames left: the counts, without the removed one");
  let d = U.removeDialog({ name: "f00002.png", labeled: true, nearby: null });
  assert.strictEqual(d.title, "Remove f00002.png from this project?");
  assert.strictEqual(d.lead, "It is then skipped: in the passes, in the counts and in the export. Its labels stay in the label files, and the project screen can restore it.");
  assert.deepStrictEqual(d.reasons.map((r) => r.label), ["Too blurry or too small", "No cards on it", "Nearly the same as another frame", "Another reason"]);
  assert.deepStrictEqual([d.nearby, d.none, d.yes, d.no], [null, null, "Remove this frame", "Keep it"], "while the nearby frames are asked for: neither");
  d = U.removeDialog({ name: "f00002.png", labeled: false, nearby: [] });
  assert.ok(d.lead.includes("Nothing is deleted"), d.lead);
  assert.strictEqual(d.none, "No other frame of this video is in its folder. To have some to choose from, cut more frames from the video: the commands under “I have a video, not frames” on the start screen.");
  d = U.removeDialog({ name: "f00002.png", nearby: [{ name: "f00001.png", t: 0.5, modelBoxes: true }, { name: "f00003.png", t: null, modelBoxes: false }], suggestions: true });
  assert.strictEqual(d.nearby.title, "Or use a nearby frame instead");
  assert.deepStrictEqual(d.nearby.frames.map((f) => f.label), ["f00001.png · 0.5 s · model's boxes", "f00003.png · time unknown"]);
  assert.strictEqual(d.nearby.unknownTime, null, "nothing picked yet");
  const unknown = U.removeDialog({ name: "f00002.png", nearby: [{ name: "f00003.png", t: null }], pick: "f00003.png" });
  assert.strictEqual(unknown.nearby.unknownTime, "The time of f00003.png in the video is unknown, so it cannot go into a measuring export.");
  assert.strictEqual(U.removeDialog({ name: "f00002.png", nearby: [{ name: "f00001.png", t: 1 }], pick: "f00001.png" }).nearby.unknownTime, null);
  // a measuring set: no nearby frame, the server's one line instead
  const measuring = U.removeDialog({ name: "f00002.png", nearby: [], measuring: "In a measuring set, add frames by drawing a new sample, not by picking one." });
  assert.deepStrictEqual([measuring.nearby, measuring.none], [null, "In a measuring set, add frames by drawing a new sample, not by picking one."]);
  assert.strictEqual(U.removedStatus("f1.png", "f2.png"), "Removed f1.png; f2.png is used instead. The project screen can restore f1.png.");
  assert.strictEqual(U.removedStatus("f1.png", null), "Removed f1.png. The project screen can restore it.");
  // when a frame cannot be removed: the same refusals as the server's
  assert.strictEqual(U.removeRefusal({ setId: "t", frameAsset: "t", mode: "box", centers: undefined }), null);
  assert.strictEqual(U.removeRefusal({ setId: "t-rep1", frameAsset: "t", mode: "box" }), "This is a repeat set: remove the frame from the set t instead.");
  assert.strictEqual(U.removeRefusal({ setId: "t", frameAsset: "t", mode: "verify" }), "Frames are not removed in Check names: that would change which answers are measured.");
  assert.strictEqual(U.removeRefusal({ setId: "t", frameAsset: "t", mode: "center", centers: [{ id: "C001" }, { id: "C002", revealedAt: "x" }] }),
    "This frame's answers have been shown; removing it now would bias the measurement.");
  assert.ok(d.nearby.note.includes("only where the suggestions file has them"), d.nearby.note);
  assert.strictEqual(U.removeDialog({ name: "x.png", nearby: [{ name: "y.png", t: 1 }] }).nearby.note, "A frame chosen here is labeled like any other, from scratch.");
  assert.strictEqual(U.removedText({ assetId: "v", name: "f1.png", reason: "near-duplicate", replacedBy: null }), "v · f1.png · Nearly the same as another frame");
  for (const t of JSON.stringify(U.removeDialog({ name: "a.png", nearby: [{ name: "b.png", t: 1 }], suggestions: true })).split('"')) {
    assert.ok(!/\b(prefill|mode|role|drop|replacement)\b/.test(t), t);
  }
}

console.log("test_uistate.js: all assertions passed");
