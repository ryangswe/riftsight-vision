// SPDX-License-Identifier: Apache-2.0
// The hover browser test's shared part (harness/): its check list and clause table, the shape a
// product module must have, and that the harness starts from the example module and says what it
// still needs. It runs no browser and reaches no network.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { CHECKS, CLAUSES, IDLE_CHECKS } from "../harness/clauses.mjs";
import example from "../harness/example/product.mjs";
import { LIMIT_DEFAULTS, productProblems, SLOTS } from "../harness/product-shape.mjs";
import { cardBox, clipArgs, type ClipProduct, enableOf } from "../harness/clip.mjs";
import { stillMoves } from "../harness/steady.mjs";
import { artAfterShownOf, compareTimings, prefetchedPaths, REPORTED_ONLY, TIMING_DEFAULTS, timingsFileProblems, timingsOf } from "../harness/timings.mjs";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** The check list in run order: the checks of each product's own copy of the harness, taken from
 *  a read of both copies, with paused-names-each, arrives-under-rest, still-card-no-blink and
 *  still-outline-steady added since. A change to this list is a change to what the runs report. */
const EXPECTED_CLAUSES: Array<[string, string]> = [
  ["frames-at-play", "S-A1"],
  ["no-capture-before-pointer", "S-B7"],
  ["art-visible", "S-W1"],
  ["outline-shows", "S-F1"],
  ["move-off-clears", "S-W4"],
  ["paused-names-each", "S-C15"],
  ["arrives-under-rest", "S-C14"],
  ["covered-kept", "S-W5"],
  ["held-outline-hides", "S-F4"],
  ["switch-flips", "S-H2"],
  ["still-card-no-blink", "S-W6"],
  ["still-outline-steady", "S-W8"],
  ["fake-pointer-ignored", "S-A2"],
  ["off-means-off", "S-B11"],
  ["on-while-playing-loads", "S-A7"],
  ["second-tab-names-card", "S-B13"],
  ["cached-reload", "no clause"],
  ["idle-unloads", "S-A4"],
  ["loop-no-reload", "S-A6"],
  ["idle-reload-on-hover", "S-A6"],
  ["switch-on-after-idle-reloads", "S-A7"],
];

describe("the hover browser test's checks", () => {
  it("keeps the check list, its order and its clauses", () => {
    expect(Object.entries(CLAUSES)).toEqual(EXPECTED_CLAUSES);
    expect(CHECKS).toEqual(EXPECTED_CLAUSES.map(([id]) => id));
    expect(IDLE_CHECKS).toEqual(["idle-unloads", "loop-no-reload", "idle-reload-on-hover", "switch-on-after-idle-reloads"]);
  });
});

describe("the product module", () => {
  it("accepts the example", () => {
    expect(productProblems(example, CHECKS)).toEqual([]);
  });

  it("names what is missing or wrong", () => {
    const { frames: _frames, ...noFrames } = example;
    expect(productProblems(noFrames, CHECKS)).toEqual(["frames needs compute and tooltip file names"]);
    expect(productProblems({ ...example, cards: { A: "x", B: "y" } }, CHECKS)).toEqual(["cards needs exactly A, B, C, D, each a catalog id"]);
    expect(productProblems({ ...example, places: { ...example.places, D: { x: 1 } } }, CHECKS)).toEqual(["places needs exactly A, B, C, D, each with x and y"]);
    expect(productProblems({ ...example, expectedFail: { "no-such-check": {} } }, CHECKS)).toEqual(["expectedFail names no check no-such-check"]);
    expect(productProblems({ ...example, config: "file.json" }, CHECKS)).toEqual(["config is not a URL (the product's config file)"]);
    expect(productProblems(null, CHECKS)).toEqual(["the module's default export is not an object"]);
  });

  it("takes unsupported checks only with a reason, for a check that exists and is not also an expected failure", () => {
    expect(productProblems({ ...example, unsupported: { "cached-reload": "no picture request can be made" } }, CHECKS)).toEqual([]);
    expect(productProblems({ ...example, unsupported: { "no-such-check": "x" } }, CHECKS)).toEqual(["unsupported names no check no-such-check"]);
    expect(productProblems({ ...example, unsupported: { "cached-reload": "" } }, CHECKS)).toEqual(["unsupported cached-reload has no reason"]);
    expect(productProblems({ ...example, unsupported: "cached-reload" }, CHECKS)).toEqual(["unsupported is not an object"]);
    expect(productProblems({ ...example, expectedFail: { "cached-reload": {} }, unsupported: { "cached-reload": "x" } }, CHECKS)).toEqual(["cached-reload is both unsupported and an expected failure"]);
  });
});

describe("the clip's layer order", () => {
  it("draws the slots A, B, C, D in that order whatever order a module lists its places", () => {
    expect(SLOTS).toEqual(["A", "B", "C", "D"]);
    const { A, B, C, D } = example.places;
    expect(productProblems({ ...example, places: { D, C, B, A } }, CHECKS)).toEqual([]);
  });
});

describe("a product module's time limits and baseline margin", () => {
  it("takes known limits and a margin, and names what is wrong with others", () => {
    expect(LIMIT_DEFAULTS).toEqual({ pausedMs: 1000, arrivalMs: 3000 });
    expect(productProblems({ ...example, limits: { pausedMs: 3000 }, baseline: { factor: 2, slackMs: 0 } }, CHECKS)).toEqual([]);
    expect(productProblems({ ...example, limits: { restMs: 1 } }, CHECKS)).toEqual(["limits has no restMs (it takes pausedMs, arrivalMs)"]);
    expect(productProblems({ ...example, limits: { arrivalMs: 0 } }, CHECKS)).toEqual(["limits.arrivalMs is not a positive number of ms"]);
    expect(productProblems({ ...example, limits: [] }, CHECKS)).toEqual(["limits is not an object"]);
    expect(productProblems({ ...example, baseline: { factor: 0.9 } }, CHECKS)).toEqual(["baseline.factor is not a number of 1 or more"]);
    expect(productProblems({ ...example, baseline: { slackMs: -1 } }, CHECKS)).toEqual(["baseline.slackMs is not a number of ms, 0 or more"]);
    expect(productProblems({ ...example, baseline: { margin: 1 } }, CHECKS)).toEqual(["baseline has no margin (it takes factor, slackMs)"]);
  });

  it("checks the clip times of a place: from, until and back", () => {
    const at = (C: object) => ({ ...example, places: { ...example.places, C } });
    expect(productProblems(at({ x: 0, y: 0, until: 12, back: 16 }), CHECKS)).toEqual([]);
    expect(productProblems(at({ x: 0, y: 0, back: 16 }), CHECKS)).toEqual(["places.C.back needs an until before it"]);
    expect(productProblems(at({ x: 0, y: 0, until: 16, back: 12 }), CHECKS)).toEqual(["places.C.back needs an until before it"]);
    expect(productProblems(at({ x: 0, y: 0, from: 2, until: 4, back: 8 }), CHECKS)).toEqual(["places.C has both from and back"]);
    expect(productProblems(at({ x: 0, y: 0, until: "12" }), CHECKS)).toEqual(["places.C.until is not a time in seconds"]);
  });
});

describe("the run's times and the baseline comparison", () => {
  it("names each measured time and leaves out what was not measured", () => {
    expect(
      timingsOf({
        namedCard: { artVisibleMs: 300 },
        pausedMs: { A: 250, C: 260 },
        arrival: { ms: 400, restedMs: 5800 },
        secondTab: { artVisibleMs: 10_000 },
        cachedReload: { artVisibleMs: null },
        idleReloadMs: 450,
      }),
    ).toEqual({ artVisibleMs: 300, pausedAMs: 250, pausedCMs: 260, arrivalMs: 400, secondTabMs: 10_000, idleReloadMs: 450 });
    expect(timingsOf({})).toEqual({});
  });

  it("fails a time only past factor x saved + slack, and lists times in one file only apart", () => {
    expect(TIMING_DEFAULTS).toEqual({ factor: 2, slackMs: 250 });
    // 1000 ms saved: the limit is 1000 x 2 + 250 = 2250 ms.
    expect(compareTimings({ a: 1000 }, { a: 2250 }).slower).toEqual([]);
    expect(compareTimings({ a: 1000 }, { a: 2251 }).slower).toEqual([{ key: "a", saved: 1000, now: 2251, limit: 2250 }]);
    // The second tab's and the arrival's times vary by design: reported, never compared.
    expect(REPORTED_ONLY).toEqual(["secondTabMs", "arrivalMs"]);
    expect(compareTimings({ secondTabMs: 1000, arrivalMs: 100 }, { secondTabMs: 15_000, arrivalMs: 2900 })).toEqual({ compared: [], slower: [], onlySaved: [], onlyNow: [] });
    expect(compareTimings({ a: 1000, b: 5 }, { a: 1001, c: 9 }, { factor: 1, slackMs: 0 })).toEqual({
      compared: ["a"],
      slower: [{ key: "a", saved: 1000, now: 1001, limit: 1000 }],
      onlySaved: ["b"],
      onlyNow: ["c"],
    });
  });

  it("reads a saved file only in the shape a run writes", () => {
    expect(timingsFileProblems({ passed: true, timings: { artVisibleMs: 300 }, measuredOn: { platform: "linux x64" } })).toEqual([]);
    expect(timingsFileProblems({ passed: false, timings: { artVisibleMs: 300 } })).toEqual(["it is from a failed run"]);
    // A run whose pictures were held: its times include the delay.
    expect(timingsFileProblems({ passed: true, timings: { artVisibleMs: 800 }, measuredOn: { artDelayMs: 500 } })).toEqual([
      "it is from a run with --art-delay-ms 500, whose picture times include that delay",
    ]);
    expect(timingsFileProblems({ passed: true, timings: { artVisibleMs: 300 }, measuredOn: { artDelayMs: 0 } })).toEqual([]);
    expect(timingsFileProblems([])).toEqual(["it is not a JSON object"]);
    expect(timingsFileProblems({ artVisibleMs: 300 })).toEqual(["it has no timings object"]);
    expect(timingsFileProblems({ timings: {} })).toEqual(["its timings object is empty"]);
    expect(timingsFileProblems({ timings: { a: "300", b: -1 } })).toEqual(["timings.a is not a time in ms", "timings.b is not a time in ms"]);
  });
});

describe("the harness command", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [here("../harness/hover-browser.mjs"), ...args], { encoding: "utf-8", timeout: 30_000 });

  it("needs --product, and loads the example before it asks for the rest", () => {
    const none = run();
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("missing --product");
    const some = run("--product", here("../harness/example/product.mjs"));
    expect(some.status).toBe(2);
    expect(some.stderr).toContain("missing --chrome, --release or --art");
  });

  it("needs a build folder from --dist or the module", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-product-"));
    try {
      const file = join(dir, "product.mjs");
      const exampleUrl = pathToFileURL(here("../harness/example/product.mjs")).href;
      writeFileSync(file, `import example from ${JSON.stringify(exampleUrl)};\nconst { dist, ...rest } = example;\nexport default rest;\n`);
      const none = run("--product", file, "--chrome", "x", "--release", "x", "--art", "/nowhere/art");
      expect(none.status).toBe(2);
      expect(none.stderr).toContain("missing --dist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a --baseline file it cannot use", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-baseline-"));
    try {
      const args = ["--product", here("../harness/example/product.mjs"), "--chrome", "x", "--release", "x", "--art", "/nowhere/art", "--dist", "x", "--only", "art-visible"];
      const missing = run(...args, "--baseline", join(dir, "none.json"));
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain("--baseline: cannot read");
      writeFileSync(join(dir, "empty.json"), JSON.stringify({ timings: {} }));
      const empty = run(...args, "--baseline", join(dir, "empty.json"));
      expect(empty.status).toBe(2);
      expect(empty.stderr).toContain("its timings object is empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips arrives-under-rest when C never comes back, and refuses a return out of range or a covered place", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-product-"));
    try {
      const exampleUrl = pathToFileURL(here("../harness/example/product.mjs")).href;
      const args = ["--chrome", "x", "--release", "x", "--art", "/nowhere/art", "--dist", "x", "--only", "arrives-under-rest"];
      writeFileSync(join(dir, "stays.mjs"), `import e from ${JSON.stringify(exampleUrl)};\nexport default { ...e, places: { ...e.places, C: { x: e.places.C.x, y: e.places.C.y } } };\n`);
      // No return time while the module expects the check to fail: a usage error, not a lost entry.
      writeFileSync(join(dir, "expected.mjs"), `import e from ${JSON.stringify(exampleUrl)};\nexport default { ...e, places: { ...e.places, C: { x: e.places.C.x, y: e.places.C.y } }, expectedFail: { "arrives-under-rest": { condition: "x", old: "x", intended: "x", clearedBy: "x" } } };\n`);
      const expected = run("--product", join(dir, "expected.mjs"), ...args);
      expect(expected.status).toBe(2);
      expect(expected.stderr).toContain("arrives-under-rest is listed in expectedFail, but places.C has no back");
      // No return time: the check is unsupported (the report gives the reason), not a setup error,
      // so the run goes on to load puppeteer-core, which this test has not installed.
      const noPuppeteer = { ...process.env, PUPPETEER_CORE_DIR: join(dir, "no-puppeteer") };
      const stays = spawnSync(process.execPath, [here("../harness/hover-browser.mjs"), "--product", join(dir, "stays.mjs"), ...args], { encoding: "utf-8", timeout: 30_000, env: noPuppeteer });
      expect(stays.stderr).not.toContain("arrives-under-rest needs");
      expect(stays.status).toBe(1);
      expect(stays.stderr).toContain("puppeteer-core");
      // Back too soon (1 s), too late in the pointer's 10 s (7 s), or too near the clip's end for
      // the 3000 ms limit (17 + 3 + 0.5 > 20).
      const cases: Array<[string, number, number]> = [["soon", 12, 13], ["slow", 10, 17], ["end", 12, 17]];
      for (const [name, until, back] of cases) {
        writeFileSync(join(dir, `${name}.mjs`), `import e from ${JSON.stringify(exampleUrl)};\nexport default { ...e, places: { ...e.places, C: { ...e.places.C, until: ${until}, back: ${back} } } };\n`);
        const bad = run("--product", join(dir, `${name}.mjs`), ...args);
        expect(bad.status, name).toBe(2);
        expect(bad.stderr, name).toContain("2 to 6 s apart, and back + the 3000 ms limit + 0.5 s within the 20 s clip");
      }
      writeFileSync(join(dir, "covered.mjs"), `import e from ${JSON.stringify(exampleUrl)};\nexport default { ...e, places: { ...e.places, B: { x: e.places.C.x + 10, y: e.places.C.y } } };\n`);
      const covered = run("--product", join(dir, "covered.mjs"), ...args);
      expect(covered.status).toBe(2);
      expect(covered.stderr).toContain("B overlap it");
      // Listed as unsupported, the check is not run, and its needs are not asked.
      writeFileSync(join(dir, "unsupported.mjs"), `import e from ${JSON.stringify(exampleUrl)};\nexport default { ...e, places: { ...e.places, C: { x: e.places.C.x, y: e.places.C.y } }, unsupported: { "arrives-under-rest": "no card leaves this clip" } };\n`);
      // It goes on to load puppeteer-core, which this test has not installed.
      const skipped = spawnSync(process.execPath, [here("../harness/hover-browser.mjs"), "--product", join(dir, "unsupported.mjs"), ...args], {
        encoding: "utf-8",
        timeout: 30_000,
        env: { ...process.env, PUPPETEER_CORE_DIR: join(dir, "no-puppeteer") },
      });
      expect(skipped.stderr).not.toContain("arrives-under-rest needs");
      expect(skipped.status).toBe(1);
      expect(skipped.stderr).toContain("puppeteer-core");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs the module to name its repository root", () => {
    expect(productProblems({ ...example, root: undefined }, CHECKS)).toEqual(["root is not a URL (the product's repository root: --art must be outside it)"]);
  });

  it("refuses a module that is not a product, and a check it does not know", () => {
    const bad = run("--product", here("../harness/clauses.mjs"));
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--product");
    const inside = run("--product", here("../harness/example/product.mjs"), "--chrome", "x", "--release", "x", "--art", here("../harness/example/art"), "--only", "frames-at-play");
    expect(inside.status).toBe(2);
    expect(inside.stderr).toContain("--art must be outside");
    const unknown = run("--product", here("../harness/example/product.mjs"), "--chrome", "x", "--release", "x", "--art", "/nowhere/art", "--only", "no-such-check");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("--only: no check no-such-check");
  });
});

describe("still-outline-steady's judgment", () => {
  const box = (left: number, top = 100, angle = 0) => ({ left, top, width: 100, height: 140, angle });
  const tip = (left: number) => ({ left, top: 50 });
  // 5 % of a 100 x 140 card: 5 px across, 7 px down.
  const limits = { xLimitPx: 5, yLimitPx: 7 };

  it("passes a still outline and sub-pixel noise", () => {
    expect(stillMoves([{ outline: box(10), tip: tip(0) }, { outline: box(10.4), tip: tip(0.3) }, { outline: box(10), tip: tip(0) }], limits)).toEqual({ wobbles: [], rereports: [], tipWobbles: [] });
  });

  it("calls a move within the report threshold a wobble, and one past it a re-report", () => {
    const r = stillMoves([{ outline: box(10), tip: null }, { outline: box(13), tip: null }, { outline: box(20), tip: null }, { outline: box(20, 108), tip: null }], limits);
    expect(r.wobbles).toEqual([{ poll: 1, x: 3, y: 0, tilt: 0 }]);
    expect(r.rereports).toEqual([
      { poll: 2, x: 7, y: 0, tilt: 0 },
      { poll: 3, x: 0, y: 8, tilt: 0 },
    ]);
  });

  it("judges y edges against the card's height, and a tilt past 2 degrees as a re-report", () => {
    expect(stillMoves([{ outline: box(10, 100), tip: null }, { outline: box(10, 106), tip: null }], limits).wobbles).toHaveLength(1);
    const tilted = stillMoves([{ outline: box(10, 100, 0), tip: null }, { outline: box(12, 100, 3), tip: null }], limits);
    expect(tilted.wobbles).toEqual([]);
    expect(tilted.rereports).toEqual([{ poll: 1, x: 2, y: 0, tilt: 3 }]);
    expect(stillMoves([{ outline: box(10, 100, 0), tip: null }, { outline: box(10, 100, 1), tip: null }], limits).wobbles).toEqual([{ poll: 1, x: 0, y: 0, tilt: 1 }]);
  });

  it("lets the tooltip move only beside an outline re-report", () => {
    const withReport = stillMoves([{ outline: box(10), tip: tip(0) }, { outline: box(20), tip: tip(0) }, { outline: box(20), tip: tip(10) }], limits);
    expect(withReport.tipWobbles).toEqual([]);
    const alone = stillMoves([{ outline: box(10), tip: tip(0) }, { outline: box(10), tip: tip(0) }, { outline: box(10), tip: tip(4) }], limits);
    expect(alone.tipWobbles).toEqual([{ poll: 2, px: 4 }]);
  });
});

describe("the clip both browser checks render", () => {
  it("shows a place from `from`, until `until`, and again from `back`", () => {
    expect(enableOf({ x: 0, y: 0 })).toBe("");
    expect(enableOf({ x: 0, y: 0, from: 8 })).toBe(":enable='gte(t,8)'");
    expect(enableOf({ x: 0, y: 0, until: 12 })).toBe(":enable='lt(t,12)'");
    expect(enableOf({ x: 0, y: 0, until: 12, back: 16 })).toBe(":enable='lt(t,12)+gte(t,16)'");
  });

  it("draws the slots in order, scaled to the card box, with the real-time encoder", () => {
    const files = { A: "a.png", B: "b.png", C: "c.png", D: "d.png" };
    const product = example as unknown as ClipProduct;
    const args = clipArgs(product, files, "/out/clip.webm");
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    const { w, h } = cardBox(product, "A");
    expect(graph).toContain(`[1]scale=${w}:${h}[A]`);
    expect(graph).toContain(`overlay=${example.places.C.x}:${example.places.C.y}:enable='lt(t,12)+gte(t,16)'`);
    expect(graph.indexOf("[A]overlay")).toBeLessThan(graph.indexOf("[D]overlay"));
    expect(args).toEqual(expect.arrayContaining(["-deadline", "realtime", "-cpu-used", "8", "-c:v", "libvpx"]));
    expect(args.at(-1)).toBe("/out/clip.webm");
  });

  it("is the one clip of the hover browser test and the rollback check", () => {
    for (const file of ["../harness/hover-browser.mjs", "../harness/rollback-check.mjs"]) {
      const text = readFileSync(here(file), "utf-8");
      expect(text, file).toContain('import { cardBox, renderClip } from "./clip.mjs";');
      expect(text, file).not.toContain("overlay=");
    }
  });
});

describe("the product diagnostics", () => {
  it("takes an optional tooltip debug global", () => {
    expect(productProblems({ ...example, tooltipDebugGlobal: "__tooltipDebug" }, CHECKS)).toEqual([]);
    expect(productProblems({ ...example, tooltipDebugGlobal: "" }, CHECKS)).toEqual(["tooltipDebugGlobal is not a text"]);
  });

  const args = ["--product", here("../harness/example/product.mjs"), "--chrome", "x", "--release", "x", "--art", "/nowhere/art", "--dist", "x", "--only", "art-visible"];
  const run = (...more: string[]) => spawnSync(process.execPath, [here("../harness/hover-browser.mjs"), ...args, ...more], { encoding: "utf-8", timeout: 30_000 });

  it("refuses an --art-delay-ms that is not a whole number of ms from 0 to 10000", () => {
    for (const bad of ["-1", "10001", "1.5", "soon", "", " ", "1e3", "0x10", "+5", " 7 "]) {
      const r = run(`--art-delay-ms=${bad}`);
      expect(r.status, JSON.stringify(bad)).toBe(2);
      expect(r.stderr, JSON.stringify(bad)).toContain("--art-delay-ms must be a whole number of ms from 0 to 10000");
    }
  });

  it("takes an --art-delay-ms of 0 to 10000, and never with --baseline", () => {
    // Past the delay's own check, the run stops at the next one: the saved file cannot be read.
    for (const good of ["0", "10000"]) {
      const r = run(`--art-delay-ms=${good}`, "--baseline", "/nowhere/timings.json");
      expect(r.status, good).toBe(2);
      expect(r.stderr, good).not.toContain("--art-delay-ms must be");
    }
    expect(run("--art-delay-ms=0", "--baseline", "/nowhere/timings.json").stderr).toContain("--baseline: cannot read");
    expect(run("--art-delay-ms=10000", "--baseline", "/nowhere/timings.json").stderr).toContain("--baseline cannot be used with --art-delay-ms");
  });

  it("pairs each card's first picture with the latest show before it", () => {
    const ids = { A: "a1", B: "b1", C: "c1", D: "d1" };
    const timings = [
      { event: "show", cardId: "a1", at: 100 },
      { event: "show", cardId: "b1", at: 150 },
      { event: "art", cardId: "b1", at: 120 }, // before B's show: not B's picture
      { event: "show", cardId: "a1", at: 400 }, // A shown again before its picture came
      { event: "art", cardId: "b1", at: 410.6 },
      { event: "art", cardId: "a1", at: 650 },
      { event: "art", cardId: "a1", at: 900 }, // a later picture of A: not counted
      { event: "art", cardId: "c1", at: 700 }, // C never shown
      null,
      { event: "show", cardId: "d1", at: Number.NaN },
      { event: "art", cardId: "d1", at: 50 },
    ];
    expect(artAfterShownOf(timings, ids)).toEqual({ A: 250, B: 261, C: null, D: null });
    expect(artAfterShownOf(null, ids)).toEqual({ A: null, B: null, C: null, D: null });
    expect(artAfterShownOf({ timings: [] }, ids)).toEqual({ A: null, B: null, C: null, D: null });
  });

  it("gives the paths of the prefetched pictures", () => {
    expect(prefetchedPaths(["https://cdn.example/art/a1.jpg?v=2", "not an address", 7, null])).toEqual(["/art/a1.jpg", "not an address"]);
    expect(prefetchedPaths(undefined)).toBeNull();
    expect(prefetchedPaths("https://cdn.example/a.jpg")).toBeNull();
    expect(prefetchedPaths([])).toEqual([]);
  });
});
