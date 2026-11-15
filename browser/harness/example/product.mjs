// SPDX-License-Identifier: Apache-2.0
// A neutral example of the module that hover-browser.mjs takes with --product. A product copies
// this file next to its own tests and changes the values; the harness checks its shape before it
// starts. The names, files and cards here are placeholders: no real product, catalog or picture.

export default {
  name: "Example",
  /** The product's config file, and the settings address in it (the stand-in serves that host). */
  config: new URL("./config.json", import.meta.url),
  settingsUrl: (config) => config.settingsUrl,
  /** The product's repository root (required): --art must be outside it. And the folder of the
   *  unpacked build the run loads by default (optional; --dist overrides it). */
  root: new URL("../../../", import.meta.url),
  dist: new URL("../../../dist", import.meta.url),
  /** The dev builds' debug global in the compute frame: { state, analyzed, ... }. */
  debugGlobal: "__exampleDebug",
  /** The outline's wrapper in the page. */
  outlineSelector: '[data-example="outline"]',
  /** The extension's two frames, and the tooltip frame's picture, picture box and name pill. */
  frames: { compute: "compute.html", tooltip: "tooltip.html" },
  /** An extension page that starts the background worker again when Chrome has stopped it. */
  wakePage: "popup.html",
  tooltipIds: { img: "img", art: "art", pill: "pill" },
  /** The settings file the stand-in serves, in the product's schema: no release pointer (the
   *  bundled release only), only the given picture address, no update notice, and any geometric
   *  stage off. */
  testSettings: (artTemplate) => ({
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00Z",
    primary: { id: "cdn", template: artTemplate },
    fallbacks: [],
  }),
  /** Where the settings file puts card pictures, relative to the settings host. */
  artPath: (art) => `/art/${art}`,
  /** The storage keys of the popup's switches. */
  keys: { enabled: "enabled", keepCard: "keepCard" },
  /** The cards of the clip: catalog ids, each with its picture file named in the release catalog. */
  cards: { A: "EX-001", B: "EX-002", C: "EX-003", D: "EX-004" },
  /** Card width in the clip, in pixels, and the card's height over its width. */
  cardWidth: 158,
  cardAspect: 88 / 63,
  /** The clip: seconds at frames a second, looping, and the card places inside it. Slot A is on
   *  show for the whole clip, and D is laid on top of it from 8 s (a card covering the hovered
   *  one). B is on show for the whole clip. C is on show until 12 s, then picked up. */
  clip: { width: 1280, height: 720, fps: 15, seconds: 20 },
  places: {
    A: { x: 140, y: 250 },
    B: { x: 430, y: 250 },
    C: { x: 720, y: 250, until: 12 },
    D: { x: 152, y: 262, from: 8 },
  },
  /** Checks expected to fail on this product's code, each until the change named fixes it:
   *  { condition, old, intended, clearedBy } and an optional `when(detail, ok)` that limits it. */
  expectedFail: {},
};
