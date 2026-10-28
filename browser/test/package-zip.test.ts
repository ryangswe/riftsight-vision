// SPDX-License-Identifier: Apache-2.0
// node/package-zip.ts: the zip an extension's package step writes. A Chrome Web Store build has
// manifest.json at the zip's top level (the store refuses a zip that nests it); a release-page
// build keeps one folder for "Load unpacked". Made-up files only. The writing tests need the
// `zip` and `unzip` programs and skip, saying so, where they are missing.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { writeZip, zipLayout } from "../node/package-zip.js";

function hasTool(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const MISSING = ["zip", "unzip"].filter((tool) => !hasTool(tool));
const SKIP_REASON = MISSING.length > 0 ? `the ${MISSING.join(" and ")} program is not on the PATH` : "";
if (SKIP_REASON) console.warn(`package-zip: writeZip tests skipped, ${SKIP_REASON}`);
const NEEDS_ZIP = MISSING.length === 0;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "package-zip-test-"));
  dirs.push(dir);
  return dir;
};

/** A made-up dist/: a manifest, a script and one nested file. */
function fakeDist(manifest: Record<string, unknown>): string {
  const dir = scratch();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "content.js"), "// content\n");
  mkdirSync(join(dir, "release"));
  writeFileSync(join(dir, "release", "release.json"), "{}\n");
  return dir;
}

function entries(zipPath: string): string[] {
  return execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf-8" }).split("\n").filter(Boolean).sort();
}

describe("zipLayout", () => {
  it("names a Web Store build's zip -store and puts its files at the top level", () => {
    expect(zipLayout("example", { version: "0.1.0" })).toEqual({ file: "example-0.1.0-store.zip", folder: null, store: true });
  });

  it("names a Firefox build's zip -firefox and puts its files at the top level", () => {
    const layout = zipLayout("example", { version: "0.3.0", browser_specific_settings: { gecko: { id: "example@example.org" } } });
    expect(layout).toEqual({ file: "example-0.3.0-firefox.zip", folder: null, store: true, firefox: true });
  });

  it("keeps a release-page build in one folder named like the zip", () => {
    expect(zipLayout("example", { version: "0.2.0", key: "MIIB…" })).toEqual({ file: "example-0.2.0.zip", folder: "example-0.2.0", store: false });
  });
});

describe.skipIf(!NEEDS_ZIP)("writeZip", () => {
  it("writes a Web Store zip with manifest.json at the top level", () => {
    const dist = fakeDist({ name: "Example", version: "0.1.0" });
    const out = scratch();
    const layout = zipLayout("example", { version: "0.1.0" });
    writeZip(dist, join(out, layout.file), layout.folder);
    const files = entries(join(out, layout.file));
    expect(files).toContain("manifest.json");
    expect(files).toContain("release/release.json");
    expect(files.filter((f) => !f.endsWith("/")).every((f) => !f.startsWith("example-"))).toBe(true);
    const manifest = execFileSync("unzip", ["-p", join(out, layout.file), "manifest.json"], { encoding: "utf-8" });
    expect(JSON.parse(manifest)).toEqual({ name: "Example", version: "0.1.0" });
  });

  it("writes a release-page zip with every file inside its one folder", () => {
    const dist = fakeDist({ name: "Example", version: "0.2.0", key: "MIIB…" });
    const out = scratch();
    const layout = zipLayout("example", { version: "0.2.0", key: "MIIB…" });
    writeZip(dist, join(out, layout.file), layout.folder);
    const files = entries(join(out, layout.file)).filter((f) => !f.endsWith("/"));
    expect(files).toEqual(["example-0.2.0/content.js", "example-0.2.0/manifest.json", "example-0.2.0/release/release.json"]);
  });

  it("replaces an older zip of the same name instead of adding to it", () => {
    const out = scratch();
    const zipPath = join(out, "example-0.1.0-store.zip");
    const first = fakeDist({ name: "Example", version: "0.1.0" });
    writeFileSync(join(first, "old.js"), "// only in the first build\n");
    writeZip(first, zipPath, null);
    expect(entries(zipPath)).toContain("old.js");
    writeZip(fakeDist({ name: "Example", version: "0.1.0" }), zipPath, null);
    expect(entries(zipPath)).not.toContain("old.js");
    expect(readFileSync(zipPath).length).toBeGreaterThan(0);
  });
});

// The built script's command line. Needs `npm run build` to have written dist/.
const SCRIPT = fileURLToPath(new URL("../dist/node/package-zip.mjs", import.meta.url));
it.runIf(process.env.CARDVISION_REQUIRE_BROWSER === "1")("has the build these script tests need", () => {
  expect(existsSync(SCRIPT)).toBe(true);
});
describe.skipIf(!existsSync(SCRIPT))("the built script", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8" });

  it("--help says how to call it and exits 0", () => {
    const done = run("--help");
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("--dist DIR --package-name NAME --out DIR");
  });

  it("exits 2 when an option is missing", () => {
    expect(run("--dist", ".").status).toBe(2);
  });

  it("exits 2 with a one-line message for an unknown option or a missing manifest", () => {
    const unknown = run("--nope");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).not.toContain("    at ");
    const empty = scratch();
    const missing = run("--dist", empty, "--package-name", "example", "--out", scratch());
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("manifest.json");
    expect(missing.stderr).not.toContain("    at ");
  });

  it("can be imported from stdin (`node -`, where argv[1] is \"-\") without throwing", () => {
    expect(spawnSync(process.execPath, ["--input-type=module", "-"], { input: `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});\n`, encoding: "utf-8" }).status).toBe(0);
  });

  it.skipIf(!NEEDS_ZIP)("writes the zip into --out and prints its path", () => {
    const dist = fakeDist({ name: "Example", version: "1.2.3" });
    const out = join(scratch(), "nested", "out");
    const done = run("--dist", dist, "--package-name", "example", "--out", out);
    expect(done.status).toBe(0);
    const zipPath = join(out, "example-1.2.3-store.zip");
    expect(done.stdout.trim()).toBe(zipPath);
    expect(entries(zipPath)).toContain("manifest.json");
  });
});
