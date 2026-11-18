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
   *  one). B is on show for the whole clip. C is on show until 12 s, then picked up, and laid back
   *  in its place at 16 s (a card that arrives under a resting pointer, with no seek). */
  clip: { width: 1280, height: 720, fps: 15, seconds: 20 },
  places: {
    A: { x: 140, y: 250 },
    B: { x: 430, y: 250 },
    C: { x: 720, y: 250, until: 12, back: 16 },
    D: { x: 152, y: 262, from: 8 },
  },
  /** Checks expected to fail on this product's code, each until the change named fixes it:
   *  { condition, old, intended, clearedBy } and an optional `when(detail, ok)` that limits it.
   *  `frames-at-play` checks S-A1 and, in its made-up `playing` step, S-A10: a product that expects
   *  only the S-A10 part to fail narrows it, e.g. `when: (d) => d.atPlay && d.beforePlay.length === 0`,
   *  so that a failure of S-A1 is not hidden. */
  expectedFail: {},
  /** Optional. Checks this product's stand-in cannot support, each with the reason: `{ "cached-reload":
   *  "why" }`. They are not run as checks; the run's output and report.json list each with its
   *  reason. An unsupported check has no unexpected-pass signal, so keep the list short and reviewed.
   *  A setup failure is never unsupported. */
  unsupported: {},
  /** Optional. The time limits of the timed checks, in ms: `pausedMs` for each card of a paused
   *  picture (paused-names-each) and `arrivalMs` for a card that comes under a resting pointer
   *  (arrives-under-rest). 1000 and 3000 by default (LIMIT_DEFAULTS in product-shape.mjs).
   *  arrives-under-rest runs when C leaves (`until`) and comes back (`back`) 2 to 6 s later, with
   *  back + arrivalMs + 0.5 s within the clip and no other card on C's place; without `back` it is
   *  unsupported. */
  // limits: { pausedMs: 1000, arrivalMs: 3000 },
  /** Optional. With --baseline, a time fails when it is more than factor x saved + slackMs.
   *  2 and 250 by default (TIMING_DEFAULTS in timings.mjs). */
  // baseline: { factor: 2, slackMs: 250 },
  /** Optional. The tooltip frame's dev debug global, a function returning { timings: [{ event:
   *  "show" | "art", cardId, at }] } (performance.now() times): the report's counts.artAfterShownMs
   *  gives, per slot, the time from the card shown to its picture on screen. `cardId` is the id the
   *  module's `cards` names (its catalog id), not a printing's. */
  // tooltipDebugGlobal: "__exampleTooltipDebug",
};
