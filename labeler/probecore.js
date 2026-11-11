// SPDX-License-Identifier: Apache-2.0
// The optional probe of a center-mode frame (the tool started with --probe): the height of a
// typical card face on the frame, measured by Alt+drag along its long edge, and the angle class
// of the camera, set with the keys 7, 8 and 9. Pure: no DOM. Shared by the page
// (window.LabelerProbe) and Node (test_probecore.js). The server keeps the values in probes.json
// (probes.py); the label rows never hold them.
(function (root) {
  "use strict";

  const CLASS_KEYS = { "7": "<=30", "8": "30-45", "9": ">45" };
  const MIN_DRAG_PX = 8; // a shorter drag is a slip, not a measurement

  // The angle class a key sets, or null. A key with Shift, Alt or Ctrl held sets nothing.
  function classForKey(ev) {
    if (!ev || ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return null;
    return Object.prototype.hasOwnProperty.call(CLASS_KEYS, ev.key) ? CLASS_KEYS[ev.key] : null;
  }

  // The measured height, in whole frame pixels, of a drag from a to b (frame pixels); null when too short.
  function heightOfDrag(a, b) {
    const len = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
    return len >= MIN_DRAG_PX ? len : null;
  }

  function isFull(p) {
    return !!p && Number.isInteger(p.cardHeightPx) && p.cardHeightPx > 0 && Object.values(CLASS_KEYS).includes(p.angleClass);
  }

  function missing(p) {
    const out = [];
    if (!p || !(Number.isInteger(p.cardHeightPx) && p.cardHeightPx > 0)) out.push("card height (Alt+drag along a card's long edge)");
    if (!p || !Object.values(CLASS_KEYS).includes(p.angleClass)) out.push("angle class (7, 8 or 9)");
    return out;
  }

  // The header line.
  function text(p) {
    const h = p && p.cardHeightPx ? `${p.cardHeightPx} px` : "not set";
    const a = p && p.angleClass ? `${p.angleClass}°` : "not set";
    return `card height ${h} · angle class ${a}`;
  }

  const api = { CLASS_KEYS, MIN_DRAG_PX, classForKey, heightOfDrag, isFull, missing, text };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LabelerProbe = api;
})(typeof window !== "undefined" ? window : globalThis);
