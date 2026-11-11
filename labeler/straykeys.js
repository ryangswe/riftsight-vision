// SPDX-License-Identifier: Apache-2.0
// Keys that are not answers, in the point and verify passes. Pure: no DOM. Shared by the page
// (window.LabelerStrayKeys) and Node (test_straykeys.js).
//
// The rule: only an answer moves the work on to the next point, the next card to name, the next
// frame or the next set. Enter and Space are the keys most often hit by accident, so they never
// skip an unanswered point or a card, and never leave an answered card behind; the arrow keys and
// brackets are the explicit way to move, and say where they go.
(function (root) {
  "use strict";

  const SOFT = new Set(["Enter", " "]);

  // Point pass. `answered`: the current point has its answer.
  // → "go" (move as asked) or "stay" (do nothing but say why)
  function pointMove(key, answered) {
    if (SOFT.has(key) && !answered) return "stay";
    return "go";
  }

  // Where the point pass goes once a point was answered.
  // → "frame"  every point of the frame is answered: it is finished, on to the next frame with points left
  //   "point"  the next point of this frame
  //   "open"   the last point: the next point still open (this frame or another)
  function afterAnswer(idx, count, allAnswered) {
    if (allAnswered) return "frame";
    return idx < count - 1 ? "point" : "open";
  }

  // Verify pass: Enter or Space on a card. `step`: "read" (readability not answered), "name"
  // (readable, no name yet), "done" (the card has its answer).
  // → "prompt" (say what to answer), "reveal" (show the suggestions: the card is waiting for
  //   them), "stay" (answered already: Enter and Space do not move on)
  function verifyEnter(step) {
    if (step === "done") return "stay";
    if (step === "read") return "prompt";
    return "reveal";
  }

  // Name search of the name-check pass: does Enter pick the highlighted card? Only one the person
  // chose: the query was typed in (or a filter is on), or the highlight was moved by the arrow
  // keys. An untouched list shows every card, and its first tile is nobody's choice.
  function mayPick(s) {
    return !!s && (String(s.query || "").trim().length > 0 || !!s.touched);
  }

  const api = { SOFT, pointMove, afterAnswer, verifyEnter, mayPick };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LabelerStrayKeys = api;
})(typeof window !== "undefined" ? window : globalThis);
