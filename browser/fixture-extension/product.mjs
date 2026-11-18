// SPDX-License-Identifier: Apache-2.0
// The toy fixture extension as a product module for the hover browser test (harness/hover-browser.mjs,
// --product). The extension is a stand-in: recognition is simulated by the toy release's models,
// whose detector returns fixed boxes whatever the picture, and the cards are the toy game's colored
// shapes. The clip puts them on the detector's boxes (the toy table of tests/test_browser_fixtures.py
// --demo): slot A is the first card of that table, B and C are two others, and D is laid exactly
// over A from 8 s. No official card art is used and nothing is fetched.

export default {
  name: "Toy fixture",
  /** The settings address in config.json is served by the harness's local stand-in. */
  config: new URL("./config.json", import.meta.url),
  settingsUrl: (config) => config.settingsUrl,
  /** The repository's root: --art must be outside it. The builds are given with --dist and
   *  --dist-idle (scripts/build-fixture.mjs writes them to a folder outside the checkout). */
  root: new URL("../../", import.meta.url),
  /** The compute page's debug global (src/compute.ts). */
  debugGlobal: "__toyDebug",
  outlineSelector: '[data-toy="outline"]',
  /** The view frame plays the part of a tooltip frame: view.html holds #img, #art and #pill. */
  frames: { compute: "compute.html", tooltip: "view.html" },
  wakePage: "wake.html",
  tooltipIds: { img: "img", art: "art", pill: "pill" },
  /** The settings file the stand-in serves: the toy schema (src/settings.ts). */
  testSettings: () => ({ schemaVersion: 1, updatedAt: "2026-01-01T00:00:00Z" }),
  /** The pictures ship inside the extension, so the settings host serves none: this path is only
   *  where the harness would look for them on it. */
  artPath: (art) => `/art/${art}`,
  keys: { enabled: "enabled", keepCard: "keepCard" },
  /** Toy cards: Amber Circle, Azure Circle, Slate Stripes, and Coral Triangle over the first. */
  cards: { A: "TOY-001", B: "TOY-007", C: "TOY-011", D: "TOY-003" },
  /** The toy cards are 240 x 336 and the detector's boxes are those of the toy table. */
  cardWidth: 240,
  cardAspect: 336 / 240,
  clip: { width: 1280, height: 720, fps: 15, seconds: 20 },
  places: {
    A: { x: 40, y: 40 },
    B: { x: 700, y: 40 },
    C: { x: 980, y: 40, until: 12 },
    D: { x: 40, y: 40, from: 8 },
  },
  expectedFail: {},
  /** Checks this stand-in cannot support, each with the reason. They are not run, and the product
   *  suites cover them. */
  unsupported: {
    "arrives-under-rest": "the toy detector returns its fixed boxes whatever the picture, so it names a card on C's empty place, and under the reading hold that card is kept and not looked at again: the card that comes back is never named; a product's stand-in with a real detector runs it",
    "cached-reload": "the fixture's card pictures ship inside the extension, so no request for one can reach the settings host and the \"no picture request\" half would pass without testing anything; the reopen half (the card named again in a new tab) still runs, and its result is in the report's counts.cachedReload",
  },
};
