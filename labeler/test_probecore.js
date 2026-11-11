// SPDX-License-Identifier: Apache-2.0
// Tests for probecore.js: the card height and angle class of a center frame.
// Run: node test_probecore.js (also run by test_serve.py)
"use strict";
const assert = require("assert");
const P = require("./probecore.js");

// the keys 7, 8, 9 set the angle class; nothing else does, and a modifier cancels it
assert.strictEqual(P.classForKey({ key: "7" }), "<=30");
assert.strictEqual(P.classForKey({ key: "8" }), "30-45");
assert.strictEqual(P.classForKey({ key: "9" }), ">45");
for (const key of ["0", "1", "6", "a", "Enter", " ", "constructor", "toString"]) assert.strictEqual(P.classForKey({ key }), null, key);
for (const mod of ["shiftKey", "altKey", "ctrlKey", "metaKey"]) assert.strictEqual(P.classForKey({ key: "8", [mod]: true }), null, mod);
assert.strictEqual(P.classForKey(null), null);

// a drag measures a whole number of frame pixels; a slip measures nothing
assert.strictEqual(P.heightOfDrag({ x: 10, y: 10 }, { x: 10, y: 150 }), 140);
assert.strictEqual(P.heightOfDrag({ x: 0, y: 0 }, { x: 30, y: 40 }), 50);
assert.strictEqual(P.heightOfDrag({ x: 0, y: 0 }, { x: 3.4, y: 4.2 }), null);
assert.strictEqual(P.heightOfDrag({ x: 5, y: 5 }, { x: 5, y: 5 }), null);
assert.strictEqual(P.heightOfDrag({ x: 0, y: 0 }, { x: 0, y: P.MIN_DRAG_PX }), P.MIN_DRAG_PX);

// a full probe holds both values, valid
assert.strictEqual(P.isFull({ cardHeightPx: 140, angleClass: "<=30" }), true);
assert.strictEqual(P.isFull({ cardHeightPx: 140 }), false);
assert.strictEqual(P.isFull({ angleClass: ">45" }), false);
assert.strictEqual(P.isFull({ cardHeightPx: 0, angleClass: ">45" }), false);
assert.strictEqual(P.isFull({ cardHeightPx: 12.5, angleClass: ">45" }), false);
assert.strictEqual(P.isFull({ cardHeightPx: 140, angleClass: "45" }), false);
assert.strictEqual(P.isFull(undefined), false);

// what is missing, in the words of the page
assert.strictEqual(P.missing({ cardHeightPx: 140, angleClass: "<=30" }).length, 0);
assert.strictEqual(P.missing({ cardHeightPx: 140 }).length, 1);
assert.ok(/angle class/.test(P.missing({ cardHeightPx: 140 })[0]));
assert.strictEqual(P.missing(null).length, 2);

// the header line
assert.strictEqual(P.text(null), "card height not set · angle class not set");
assert.strictEqual(P.text({ cardHeightPx: 140 }), "card height 140 px · angle class not set");
assert.strictEqual(P.text({ cardHeightPx: 140, angleClass: "30-45" }), "card height 140 px · angle class 30-45°");

console.log("probecore: ok");
