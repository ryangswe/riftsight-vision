// SPDX-License-Identifier: Apache-2.0
// Realm marks (scripts/realm-marks.mjs) and the check that counts them (node/realm-check.ts):
// each mark occurs once in every built output that holds its module and nowhere else, and a
// build that bundles the capture entry beside the shared host's content entry fails the check,
// naming the mark and the file. The outputs are built here with the pinned esbuild and the same
// options as scripts/build.mjs, in memory or in a temp folder; no dist/ and no network.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realmFindings } from "../node/realm-check.js";
// @ts-expect-error: a plain .mjs script without declarations
import { countMark, REALM_MARKS } from "../scripts/realm-marks.mjs";

interface Mark {
  id: string;
  module: string;
  text: string;
}
const marks = REALM_MARKS as readonly Mark[];

const root = fileURLToPath(new URL("..", import.meta.url));
const shared = { bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, sourcemap: false, logLevel: "silent", legalComments: "none", absWorkingDir: root } as const;
// The entries of scripts/build.mjs that bundle toolkit modules for the browser.
const entries: Record<string, string> = {
  cardvision: "src/index.ts",
  worker: "src/worker.ts",
  "remote-release": "src/remote/index.ts",
  "compute-session": "src/compute-session.ts",
  "page-capture": "src/page-capture-entry.ts",
  "host-content": "src/host/content-entry.ts",
  "host-compute": "src/host/compute-entry.ts",
  "host-settings": "src/host/settings-entry.ts",
};

const temps: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "realm-marks-test-"));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Each output's text, and the modules (relative to browser/) that put code in it. */
let outputs: Record<string, { text: string; modules: Set<string> }> = {};
beforeAll(async () => {
  const result = await build({ ...shared, entryPoints: Object.fromEntries(Object.entries(entries)), outdir: "out", write: false, metafile: true });
  outputs = {};
  for (const file of result.outputFiles) {
    const name = file.path.replace(/^.*\/out\//, "");
    const meta = result.metafile.outputs[`out/${name}`];
    const modules = new Set(Object.entries(meta?.inputs ?? {}).filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path));
    outputs[name] = { text: file.text, modules };
  }
}, 120_000);

describe("realm marks", () => {
  it("lists distinct marks, each tied to a module that exists", () => {
    expect(marks.length).toBeGreaterThan(2);
    expect(new Set(marks.map((mark) => mark.id)).size).toBe(marks.length);
    expect(new Set(marks.map((mark) => mark.text)).size).toBe(marks.length);
    for (const mark of marks) {
      expect(mark.id.startsWith(`${mark.module.split("/").pop()}:`), mark.id).toBe(true);
      expect(readFileSync(join(root, mark.module), "utf-8"), mark.id).toContain(mark.text);
    }
  });

  it("builds every output it checks", () => {
    expect(Object.keys(outputs).sort()).toEqual(Object.keys(entries).map((name) => `${name}.js`).sort());
  });

  for (const mark of marks) {
    it(`${mark.id} occurs once in each output that holds its module and in no other`, () => {
      const holders: string[] = [];
      for (const [name, output] of Object.entries(outputs)) {
        const count = countMark(output.text, mark.text);
        if (output.modules.has(mark.module)) {
          holders.push(name);
          expect(count, `${mark.id} in ${name}`).toBe(1);
        } else expect(count, `${mark.id} in ${name}`).toBe(0);
      }
      // A mark no output holds would pass vacuously.
      expect(holders.length, mark.id).toBeGreaterThan(0);
    });
  }

  it("marks the capture control in both the capture entry and the host's content file, and in neither of the others", () => {
    const holders = (id: string): string[] => Object.entries(outputs).filter(([, output]) => countMark(output.text, marks.find((mark) => mark.id === id)?.text ?? "\0") > 0).map(([name]) => name);
    expect(holders("capture-control.ts:CAPTURE_PENDING_REASON").sort()).toEqual(["host-content.js", "page-capture.js"]);
  });
});

describe("realm check", () => {
  /** The check built as scripts/build.mjs builds the other Node tools, into `dir`. */
  async function buildCheck(dir: string): Promise<string> {
    const out = join(dir, "realm-check.mjs");
    await build({
      entryPoints: [join(root, "node/realm-check.ts")],
      outfile: out,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["onnxruntime-web", "onnxruntime-web/*"],
      logLevel: "silent",
    });
    return out;
  }
  const run = (tool: string, ...args: string[]) => spawnSync(process.execPath, [tool, ...args], { encoding: "utf-8" });

  it("passes a build with the capture entry and the host's content file as two files", async () => {
    const dir = temp();
    mkdirSync(join(dir, "product"));
    await build({ ...shared, entryPoints: { "page-capture": entries["page-capture"] as string, "host-content": entries["host-content"] as string }, outdir: join(dir, "product") });
    const result = run(await buildCheck(dir), join(dir, "product"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no realm mark twice");
  }, 60_000);

  it("fails a toy build that bundles the capture entry beside the host's content entry in one file", async () => {
    const dir = temp();
    const parts = join(dir, "parts");
    const product = join(dir, "product");
    mkdirSync(parts);
    mkdirSync(join(product, "sub"), { recursive: true });
    mkdirSync(join(dir, "ignored", "node_modules"), { recursive: true });
    await build({ ...shared, entryPoints: { "page-capture": entries["page-capture"] as string, "host-content": entries["host-content"] as string }, outdir: parts });
    // The toy content script: imports both built files, as a product that kept its own capture would.
    writeFileSync(join(dir, "content.js"), `import * as capture from "./parts/page-capture.js";\nimport * as host from "./parts/host-content.js";\nglobalThis.toy = [capture, host];\n`);
    await build({ ...shared, entryPoints: { content: join(dir, "content.js") }, outdir: join(product, "sub"), absWorkingDir: dir });
    const bundled = readFileSync(join(product, "sub", "content.js"), "utf-8");
    expect(realmFindings("content.js", bundled)).toEqual([{ file: "content.js", id: "capture-control.ts:CAPTURE_PENDING_REASON", count: 2 }]);
    const tool = await buildCheck(dir);
    // A duplicate under node_modules is not walked.
    copyFileSync(join(product, "sub", "content.js"), join(dir, "ignored", "node_modules", "x.js"));
    const ignored = run(tool, join(dir, "ignored"));
    expect(ignored.status, "only node_modules held a duplicate, so nothing is read").toBe(2);
    const result = run(tool, product);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join("sub", "content.js"));
    expect(result.stderr).toContain("capture-control.ts:CAPTURE_PENDING_REASON");
    expect(result.stderr).toContain("occurs 2 times");
    expect(result.stderr).toContain("may hold that module's code twice");
  }, 60_000);

  it("exits 2 on no arguments and on a path that is not there", async () => {
    const tool = await buildCheck(temp());
    expect(run(tool).status).toBe(2);
    const missing = run(tool, join(tmpdir(), "realm-marks-no-such-folder"));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("cannot read");
  }, 60_000);

  it("ignores node_modules when a duplicate sits beside real files", async () => {
    const dir = temp();
    mkdirSync(join(dir, "node_modules"));
    await build({ ...shared, entryPoints: { "page-capture": entries["page-capture"] as string, "host-content": entries["host-content"] as string }, outdir: join(dir, "p") });
    writeFileSync(join(dir, "node_modules", "x.js"), readFileSync(join(dir, "p", "page-capture.js"), "utf-8") + readFileSync(join(dir, "p", "host-content.js"), "utf-8"));
    copyFileSync(join(dir, "p", "host-content.js"), join(dir, "host-content.js"));
    const result = run(await buildCheck(dir), dir);
    expect(result.status, result.stderr).toBe(0);
  }, 60_000);

  it("exits 2 when it read nothing: an empty folder, only .html files, a folder named like a script", async () => {
    const dir = temp();
    const tool = await buildCheck(dir);
    mkdirSync(join(dir, "empty"));
    mkdirSync(join(dir, "pages"));
    writeFileSync(join(dir, "pages", "index.html"), "<p>no script</p>");
    mkdirSync(join(dir, "x.js"));
    for (const target of ["empty", "pages", "x.js"]) {
      const result = run(tool, join(dir, target));
      expect(result.status, target).toBe(2);
      expect(result.stderr, target).toContain("no .js or .mjs file to check");
    }
  }, 60_000);

  it("exits 2 naming a file it cannot read (a link to nothing)", async () => {
    const dir = temp();
    const tool = await buildCheck(dir);
    mkdirSync(join(dir, "p"));
    writeFileSync(join(dir, "p", "ok.js"), "export {};\n");
    symlinkSync(join(dir, "p", "gone.js"), join(dir, "p", "dangling.js"));
    const result = run(tool, join(dir, "p"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("cannot read");
    expect(result.stderr).toContain("dangling.js");
    expect(result.stderr).not.toContain("at ");
  }, 60_000);

  it("says in how many files each mark was found", async () => {
    const dir = temp();
    await build({ ...shared, entryPoints: { "page-capture": entries["page-capture"] as string, "host-content": entries["host-content"] as string }, outdir: join(dir, "p") });
    const result = run(await buildCheck(dir), join(dir, "p"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("capture-control.ts:CAPTURE_PENDING_REASON in 2");
    expect(result.stdout).toContain("settings-core.ts:DEFAULTS_INVALID in 0");
  }, 60_000);

  // Values a product writes in its own code: documented reasons, message kinds and storage keys. A
  // product that bundles its own copy of one beside a built runtime file must pass.
  it("passes a product that bundles its own copy of a public value beside each built file", async () => {
    const dir = temp();
    const parts = join(dir, "parts");
    mkdirSync(parts);
    await build({ ...shared, entryPoints: Object.fromEntries(Object.entries(entries).filter(([name]) => name.startsWith("host-") || name === "compute-session" || name === "page-capture")), outdir: parts });
    const publicValues = ["worker-restarted", "settings.lastGood", "not pointing at the video", "the bundled default settings are not valid", "update.dismissed", "capture-failed", "analysis-failed", "enabled", "keepCard"];
    const tool = await buildCheck(dir);
    for (const name of ["compute-session", "host-compute", "host-settings", "host-content", "page-capture"]) {
      const out = join(dir, `product-${name}`);
      mkdirSync(out);
      writeFileSync(join(dir, `${name}-entry.js`), `import * as runtime from "./parts/${name}.js";\nglobalThis.product = [runtime, ${JSON.stringify(publicValues)}];\nif (globalThis.product[1][0] !== "worker-restarted") console.log("worker-restarted", "settings.lastGood");\n`);
      await build({ ...shared, entryPoints: { bundle: join(dir, `${name}-entry.js`) }, outdir: out, absWorkingDir: dir });
      const bundled = readFileSync(join(out, "bundle.js"), "utf-8");
      expect(bundled, name).toContain("worker-restarted");
      const result = run(tool, out);
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  }, 120_000);

  it("a built copy of the check holds no mark verbatim, so it never counts itself", async () => {
    const tool = readFileSync(await buildCheck(temp()), "utf-8");
    for (const mark of marks) {
      expect(tool, mark.id).not.toContain(mark.text);
      expect(countMark(tool, mark.text), mark.id).toBe(0);
    }
  }, 60_000);

  it("a copy of the check inside a scanned folder does not change the result", async () => {
    const dir = temp();
    const product = join(dir, "product");
    mkdirSync(join(product, "node"), { recursive: true });
    await build({ ...shared, entryPoints: { "page-capture": entries["page-capture"] as string, "host-content": entries["host-content"] as string }, outdir: product });
    const tool = await buildCheck(dir);
    const before = run(tool, product);
    copyFileSync(tool, join(product, "node", "realm-check.mjs"));
    copyFileSync(tool, join(product, "realm-check-copy.js"));
    const after = run(tool, product);
    expect(before.status, before.stderr).toBe(0);
    expect(after.status, after.stderr).toBe(0);
    expect(after.stderr).toBe("");
  }, 60_000);
});

// The toolkit's own build, with its Node tools: the built check over all of dist/ passes.
const builtDist = existsSync(join(root, "dist", "node", "realm-check.mjs")) && existsSync(join(root, "dist", "host-content.js"));
describe("the built realm check over the toolkit's dist/", () => {
  if (!builtDist && process.env.CARDVISION_REQUIRE_BROWSER !== "1") {
    it.skip("needs a current dist/ (run npm run build)", () => {});
    return;
  }
  it("exits 0 over the whole of dist/, its own file included", () => {
    expect(builtDist).toBe(true);
    const result = spawnSync(process.execPath, [join(root, "dist", "node", "realm-check.mjs"), join(root, "dist")], { encoding: "utf-8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
