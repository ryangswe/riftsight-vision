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
import { productProblems, SLOTS } from "../harness/product-shape.mjs";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** The check list as each product's own copy of the harness had it, in run order, taken from a
 *  read of both copies. A change to this list is a change to what the products' runs report. */
const EXPECTED_CLAUSES: Array<[string, string]> = [
  ["frames-at-play", "S-A1"],
  ["no-capture-before-pointer", "S-B7"],
  ["art-visible", "S-W1"],
  ["outline-shows", "S-F1"],
  ["move-off-clears", "S-W4"],
  ["covered-kept", "S-W5"],
  ["held-outline-hides", "S-F4"],
  ["switch-flips", "S-H2"],
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
});

describe("the clip's layer order", () => {
  it("draws the slots A, B, C, D in that order whatever order a module lists its places", () => {
    expect(SLOTS).toEqual(["A", "B", "C", "D"]);
    const { A, B, C, D } = example.places;
    expect(productProblems({ ...example, places: { D, C, B, A } }, CHECKS)).toEqual([]);
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
