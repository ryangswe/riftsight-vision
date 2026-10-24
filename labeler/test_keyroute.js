// SPDX-License-Identifier: Apache-2.0
// Tests for keyroute.js: who handles a key press, by where the focus is.
// Run: node test_keyroute.js (also run by test_serve.py)
"use strict";
const assert = require("assert");
const K = require("./keyroute.js");

// the kind of the focused element
assert.strictEqual(K.focusKind(null), "none");
assert.strictEqual(K.focusKind({ tag: "CANVAS" }), "none");
assert.strictEqual(K.focusKind({ tag: "BODY" }), "none");
assert.strictEqual(K.focusKind({ tag: "INPUT", type: "search" }), "text");
assert.strictEqual(K.focusKind({ tag: "INPUT", type: "text" }), "text");
assert.strictEqual(K.focusKind({ tag: "INPUT", type: "number" }), "text");
assert.strictEqual(K.focusKind({ tag: "input", type: "" }), "text", "an input without a type is a text field");
assert.strictEqual(K.focusKind({ tag: "TEXTAREA" }), "text");
assert.strictEqual(K.focusKind({ tag: "DIV", editable: true }), "text");
assert.strictEqual(K.focusKind({ tag: "SELECT", type: "select-one" }), "select");
assert.strictEqual(K.focusKind({ tag: "INPUT", type: "checkbox" }), "checkbox");
assert.strictEqual(K.focusKind({ tag: "INPUT", type: "radio" }), "checkbox");
assert.strictEqual(K.focusKind({ tag: "INPUT", type: "submit" }), "button");
assert.strictEqual(K.focusKind({ tag: "BUTTON", type: "button" }), "button");
assert.strictEqual(K.focusKind({ tag: "SUMMARY" }), "summary");
assert.strictEqual(K.focusKind({ tag: "A" }), "link");

// the Boxes pass's keys for a box with free corners (S snaps them, E makes it a rectangle again)
// reach the editor from the frame and from a focused button alike; a text field keeps them
for (const key of ["s", "e", "E"]) {
  assert.strictEqual(K.route({ key, focus: "none" }), "editor", key);
  assert.strictEqual(K.route({ key, focus: "button" }), "editor", key);
  assert.strictEqual(K.route({ key, focus: "checkbox" }), "editor", key);
  assert.strictEqual(K.route({ key, focus: "text" }), "field", key);
}

// after a set was chosen in the menu: where the next Tab starts
assert.strictEqual(K.tabFrom({ focus: "none", onFrame: false }), "menu", "nothing holds the focus: the place stays at the menu");
assert.strictEqual(K.tabFrom({ focus: "none", onFrame: true }), "as-is", "the frame has the focus");
assert.strictEqual(K.tabFrom({ focus: "text", onFrame: false }), "as-is", "the pass put the focus in the search box");
assert.strictEqual(K.tabFrom({ focus: "button", onFrame: false }), "as-is", "the finish card's button, or one the person went to meanwhile");
assert.strictEqual(K.tabFrom({ focus: "select", onFrame: false }), "as-is");
assert.strictEqual(K.tabFrom(null), "menu");

const r = (key, focus, more) => K.route(Object.assign({ key, focus }, more || {}));
const LETTERS = ["x", "b", "u", "y", "n", "m", "a", "w", "j", "W", "/", "0", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "[", "]"];

// with the focus on the frame, every key is the editor's
for (const k of LETTERS.concat(["Enter", " ", "Tab", "Escape"])) assert.strictEqual(r(k, "none"), "editor", k);

// a text field keeps every key: letters type, Enter and Esc are the field's own
for (const k of LETTERS.concat(["Enter", " ", "Tab", "Escape", "?"])) assert.strictEqual(r(k, "text"), "field", k);
assert.strictEqual(r("z", "text", { meta: true }), "field", "undo in a text field is the field's undo");
// and so does the set menu
for (const k of ["x", "ArrowDown", "Enter", " "]) assert.strictEqual(r(k, "select"), "field", k);

// the reported defect: a shortcut pressed after a button took the focus still acts
for (const k of LETTERS) assert.strictEqual(r(k, "button"), "editor", `${k} with a button in focus`);
// Enter and Space on a focused button activate that button, and nothing else
assert.strictEqual(r("Enter", "button"), "control");
assert.strictEqual(r(" ", "button"), "control");
assert.strictEqual(r("Enter", "summary"), "control");
assert.strictEqual(r(" ", "summary"), "control");
assert.strictEqual(r("Enter", "link"), "control");
// a checkbox takes Space; Enter does nothing to a checkbox, so it stays the editor's
assert.strictEqual(r(" ", "checkbox"), "control");
assert.strictEqual(r("Enter", "checkbox"), "editor");
for (const k of LETTERS) assert.strictEqual(r(k, "checkbox"), "editor", `${k} with a checkbox in focus`);
// Tab moves on from a control as in any page; from the frame it is the editor's (next box)
for (const f of ["button", "checkbox", "summary", "link"]) assert.strictEqual(r("Tab", f), "browser", f);
// Esc gives the focus back to the frame
for (const f of ["button", "checkbox", "summary", "link"]) assert.strictEqual(r("Escape", f), "leave", f);

// undo, redo, copy and paste reach the editor from any control
for (const f of ["none", "button", "checkbox", "summary"]) {
  assert.strictEqual(r("z", f, { meta: true }), "editor", f);
  assert.strictEqual(r("z", f, { ctrl: true }), "editor", f);
}

// the keys overlay: ? opens it from anywhere but a text field; ? and Esc close it
for (const f of ["none", "button", "checkbox", "summary"]) assert.strictEqual(r("?", f), "help", f);
assert.strictEqual(r("Escape", "none", { helpOpen: true }), "help");
assert.strictEqual(r("Escape", "button", { helpOpen: true }), "help");
assert.strictEqual(r("?", "none", { helpOpen: true }), "help");
assert.strictEqual(r("b", "none", { helpOpen: true }), "editor", "the other keys go on working under the overlay");

// F6 moves the focus to the side panel's controls, from anywhere
for (const f of ["none", "button", "text", "select", "checkbox"]) assert.strictEqual(r("F6", f), "panel", f);

// the finish card: Enter on its focused button is the button's; Esc closes the card
assert.strictEqual(r("Enter", "button", { finishOpen: true }), "control");
assert.strictEqual(r("Escape", "button", { finishOpen: true }), "finish");
assert.strictEqual(r("Escape", "none", { finishOpen: true }), "finish");
assert.strictEqual(r("ArrowLeft", "button", { finishOpen: true }), "editor");

// the stacking view's key (O) and a box beside (D): letters like the others, so a text field or a
// menu keeps them
for (const k of ["o", "O", "d", "D"]) {
  assert.strictEqual(r(k, "text"), "field", `${k} types in a text field`);
  assert.strictEqual(r(k, "select"), "field", `${k} stays in a menu`);
  for (const f of ["none", "button", "checkbox", "summary", "link"]) assert.strictEqual(r(k, f), "editor", `${k} from ${f}`);
}

// D's "box beside" stays armed only where it was armed
{
  const ctx = { set: "s1", frame: 4, mode: "box", sel: ["B002", "B001"] };
  const armed = K.armedFor(ctx);
  assert.ok(K.stillArmed(armed, { set: "s1", frame: 4, mode: "box", sel: ["B001", "B002"] }), "same context, any order");
  assert.ok(!K.stillArmed(armed, Object.assign({}, ctx, { sel: ["B003"] })), "another box selected");
  assert.ok(!K.stillArmed(armed, Object.assign({}, ctx, { sel: [] })), "nothing selected");
  assert.ok(!K.stillArmed(armed, Object.assign({}, ctx, { frame: 5 })), "another frame");
  assert.ok(!K.stillArmed(armed, Object.assign({}, ctx, { mode: "identify" })), "another pass");
  assert.ok(!K.stillArmed(armed, Object.assign({}, ctx, { set: "s2" })), "another set");
  assert.ok(!K.stillArmed(null, ctx), "not armed");
}

console.log("test_keyroute.js: all assertions passed");
