// SPDX-License-Identifier: Apache-2.0
// The comparison of the five runtime files between two builds (scripts/runtime-hashes.mjs).
// Fixtures only; no build, no network.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error: a plain .mjs script without declarations
import { runtimeDifferences } from "../scripts/runtime-hashes.mjs";

const script = fileURLToPath(new URL("../scripts/runtime-hashes.mjs", import.meta.url));
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dist = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-hashes-"));
  temps.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};
const five = { "cardvision.js": "a", "worker.js": "b", "compute-session.js": "c", "page-capture.js": "d", "remote-release.js": "e" };

describe("the runtime hash comparison", () => {
  it("passes for identical files, whatever else the builds hold", () => {
    const base = dist({ ...five, "cardvision.js.LEGAL.txt": "l" });
    const head = dist({ ...five, "cardvision.js.LEGAL.txt": "l", "host-content.js": "new" });
    expect(runtimeDifferences(base, head)).toEqual([]);
    const done = spawnSync(process.execPath, [script, base, head], { encoding: "utf-8" });
    expect([done.status, done.stdout]).toEqual([0, expect.stringContaining("byte-identical")]);
  });

  it("names a file that changed, one that is missing from a side, and a license text that appeared", () => {
    const base = dist(five);
    expect(runtimeDifferences(base, dist({ ...five, "worker.js": "changed" })).join("\n")).toMatch(/^worker\.js: base /);
    const { "page-capture.js": _gone, ...rest } = five;
    expect(runtimeDifferences(base, dist(rest)).join("\n")).toMatch(/page-capture\.js: .*head \(missing\)/);
    expect(runtimeDifferences(base, dist({ ...five, "worker.js.LEGAL.txt": "l" })).join("\n")).toMatch(/worker\.js\.LEGAL\.txt: base \(missing\)/);
    const done = spawnSync(process.execPath, [script, base, dist({ ...five, "worker.js": "changed" })], { encoding: "utf-8" });
    expect(done.status).toBe(1);
    expect(spawnSync(process.execPath, [script, base], { encoding: "utf-8" }).status).toBe(2);
  });

  it("compares the WebAssembly-only build too when both builds have it, and not when only one does", () => {
    const wasm = { "wasm/cardvision.js": "wa", "wasm/worker.js": "wb" };
    const base = dist({ ...five, ...wasm });
    expect(runtimeDifferences(base, dist({ ...five, ...wasm }))).toEqual([]);
    expect(runtimeDifferences(base, dist({ ...five, ...wasm, "wasm/worker.js": "changed" })).join("\n")).toMatch(/^wasm\/worker\.js: base /);
    // A merge base from before the folder existed: only the five are compared.
    expect(runtimeDifferences(dist(five), dist({ ...five, ...wasm, "wasm/worker.js": "changed" }))).toEqual([]);
  });
});
