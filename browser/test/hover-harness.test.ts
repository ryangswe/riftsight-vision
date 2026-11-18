// SPDX-License-Identifier: Apache-2.0
// The hover browser test's shared part (harness/): its check list and clause table, the shape a
// product module must have, and that the harness starts from the example module and says what it
// still needs. It runs no browser and reaches no network.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { CHECKS, CLAUSES, IDLE_CHECKS } from "../harness/clauses.mjs";
import example from "../harness/example/product.mjs";
import { LIMIT_DEFAULTS, productProblems, SLOTS } from "../harness/product-shape.mjs";
import { compareTimings, TIMING_DEFAULTS, timingsFileProblems, timingsOf } from "../harness/timings.mjs";

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
  ["paused-names-each", "S-C8"],
  ["arrives-under-rest", "S-B2"],
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
    expect(LIMIT_DEFAULTS).toEqual({ pausedMs: 2000, arrivalMs: 2000 });
    expect(productProblems({ ...example, limits: { pausedMs: 3000 }, baseline: { factor: 2, slackMs: 0 } }, CHECKS)).toEqual([]);
    expect(productProblems({ ...example, limits: { restMs: 1 } }, CHECKS)).toEqual(["limits has no restMs (it takes pausedMs, arrivalMs)"]);
    expect(productProblems({ ...example, limits: { arrivalMs: 0 } }, CHECKS)).toEqual(["limits.arrivalMs is not a positive number of ms"]);
    expect(productProblems({ ...example, limits: [] }, CHECKS)).toEqual(["limits is not an object"]);
    expect(productProblems({ ...example, baseline: { factor: 0.9 } }, CHECKS)).toEqual(["baseline.factor is not a number of 1 or more"]);
    expect(productProblems({ ...example, baseline: { slackMs: -1 } }, CHECKS)).toEqual(["baseline.slackMs is not a number of ms, 0 or more"]);
    expect(productProblems({ ...example, baseline: { margin: 1 } }, CHECKS)).toEqual(["baseline has no margin (it takes factor, slackMs)"]);
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
    expect(TIMING_DEFAULTS).toEqual({ factor: 1.5, slackMs: 750 });
    // 1000 ms saved: the limit is 1000 x 1.5 + 750 = 2250 ms.
    expect(compareTimings({ a: 1000 }, { a: 2250 }).slower).toEqual([]);
    expect(compareTimings({ a: 1000 }, { a: 2251 }).slower).toEqual([{ key: "a", saved: 1000, now: 2251, limit: 2250 }]);
    expect(compareTimings({ a: 1000, b: 5 }, { a: 1001, c: 9 }, { factor: 1, slackMs: 0 })).toEqual({
      compared: ["a"],
      slower: [{ key: "a", saved: 1000, now: 1001, limit: 1000 }],
      onlySaved: ["b"],
      onlyNow: ["c"],
    });
  });

  it("reads a saved file only in the shape a run writes", () => {
    expect(timingsFileProblems({ timings: { artVisibleMs: 300 }, measuredOn: { platform: "linux x64" } })).toEqual([]);
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

  it("refuses arrives-under-rest when C never leaves, or another card is on its place", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-product-"));
    try {
      const exampleUrl = pathToFileURL(here("../harness/example/product.mjs")).href;
      const args = ["--chrome", "x", "--release", "x", "--art", "/nowhere/art", "--dist", "x", "--only", "arrives-under-rest"];
      writeFileSync(join(dir, "stays.mjs"), `import e from ${JSON.stringify(exampleUrl)};\nexport default { ...e, places: { ...e.places, C: { x: e.places.C.x, y: e.places.C.y } } };\n`);
      const stays = run("--product", join(dir, "stays.mjs"), ...args);
      expect(stays.status).toBe(2);
      expect(stays.stderr).toContain("arrives-under-rest needs places.C.until");
      writeFileSync(join(dir, "covered.mjs"), `import e from ${JSON.stringify(exampleUrl)};\nexport default { ...e, places: { ...e.places, B: { x: e.places.C.x + 10, y: e.places.C.y } } };\n`);
      const covered = run("--product", join(dir, "covered.mjs"), ...args);
      expect(covered.status).toBe(2);
      expect(covered.stderr).toContain("B overlap it");
      // Listed as unsupported, the check is not run, and its needs are not asked.
      writeFileSync(join(dir, "unsupported.mjs"), `import e from ${JSON.stringify(exampleUrl)};\nexport default { ...e, places: { ...e.places, C: { x: e.places.C.x, y: e.places.C.y } }, unsupported: { "arrives-under-rest": "no card leaves this clip" } };\n`);
      const skipped = run("--product", join(dir, "unsupported.mjs"), ...args);
      expect(skipped.stderr).not.toContain("arrives-under-rest needs");
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
