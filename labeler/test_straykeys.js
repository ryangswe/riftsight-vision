// SPDX-License-Identifier: Apache-2.0
// Tests for straykeys.js: a key that is not an answer never moves the work on.
// Run: node test_straykeys.js (also run by test_serve.py)
"use strict";
const assert = require("assert");
const S = require("./straykeys.js");

// point pass: Enter and Space stay on a point with no answer, and go on from one that has it
assert.strictEqual(S.pointMove("Enter", false), "stay");
assert.strictEqual(S.pointMove(" ", false), "stay");
assert.strictEqual(S.pointMove("Enter", true), "go");
assert.strictEqual(S.pointMove(" ", true), "go");
// the arrow keys, brackets and Page keys are the explicit way to move: they go either way
for (const key of ["ArrowRight", "ArrowLeft", "]", "[", "PageDown", "PageUp"]) {
  assert.strictEqual(S.pointMove(key, false), "go", key);
  assert.strictEqual(S.pointMove(key, true), "go", key);
}
// any other key is no movement at all: it never asks to stay or go anywhere beyond what it does itself
assert.deepStrictEqual([...S.SOFT].sort(), [" ", "Enter"]);

// after an answer: the last answer of a frame leaves the frame (the confirmation), else the next point
assert.strictEqual(S.afterAnswer(3, 16, true), "frame");
assert.strictEqual(S.afterAnswer(15, 16, true), "frame");
assert.strictEqual(S.afterAnswer(0, 16, false), "point");
assert.strictEqual(S.afterAnswer(14, 16, false), "point");
assert.strictEqual(S.afterAnswer(15, 16, false), "open", "the last point with others open: the next one still open");
assert.strictEqual(S.afterAnswer(0, 1, false), "open");

// verify pass: Enter and Space never leave an answered card, never skip one with no answer
assert.strictEqual(S.verifyEnter("done"), "stay");
assert.strictEqual(S.verifyEnter("read"), "prompt");
assert.strictEqual(S.verifyEnter("name"), "reveal");

// the name search: Enter picks only a card that was chosen
assert.strictEqual(S.mayPick({ query: "", touched: false }), false, "an untouched list: the first tile is nobody's choice");
assert.strictEqual(S.mayPick({ query: "   ", touched: false }), false);
assert.strictEqual(S.mayPick({ query: "jade", touched: false }), true);
assert.strictEqual(S.mayPick({ query: "", touched: true }), true, "moved by the arrow keys, or a filter is on");
assert.strictEqual(S.mayPick(null), false);

console.log("straykeys: ok");
