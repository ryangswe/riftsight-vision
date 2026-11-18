// SPDX-License-Identifier: Apache-2.0
// The toy fixture extension (fixture-extension/): its manifest carries the strict policy the
// browser test relies on, and its product module has the shape the hover browser test takes. The
// browser run itself is the "Host browser test" job; this test starts no browser and reaches no network.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CHECKS } from "../harness/clauses.mjs";
import { productProblems } from "../harness/product-shape.mjs";
import product from "../fixture-extension/product.mjs";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(here(path), "utf-8")) as Record<string, any>;

describe("the fixture extension's manifest", () => {
  const manifest = json("../fixture-extension/manifest.json");
  const config = json("../fixture-extension/config.json");

  it("is Manifest V3, with the content script on the two local origins only", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0].matches).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
    expect(manifest.web_accessible_resources).toEqual([{ resources: ["compute.html", "view.html"], matches: ["http://127.0.0.1/*", "http://localhost/*"] }]);
    expect(manifest.host_permissions).toBeUndefined();
  });

  it("carries the strict policy, with the settings host as the one address beyond the extension itself", () => {
    const host = new URL(config.settingsUrl).origin;
    expect(manifest.content_security_policy.extension_pages).toBe(`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' ${host}; img-src 'self' blob: data:`);
  });
});

describe("the fixture extension's product module", () => {
  it("has the shape the hover browser test takes", () => {
    expect(productProblems(product, CHECKS)).toEqual([]);
  });

  it("names a reason for every check it does not support", () => {
    expect(Object.keys(product.unsupported)).toEqual(["arrives-under-rest", "cached-reload"]);
    for (const reason of Object.values(product.unsupported)) expect(String(reason).length).toBeGreaterThan(20);
    expect(product.unsupported["cached-reload"]).toContain("reopen half");
    expect(product.unsupported["arrives-under-rest"]).toContain("real detector");
  });

  it("puts card D exactly over card A, and the cards on the toy table's boxes", () => {
    expect(product.places.D).toMatchObject({ x: product.places.A.x, y: product.places.A.y });
    expect(product.places.A).toEqual({ x: 40, y: 40 });
    expect(product.places.B).toEqual({ x: 700, y: 40 });
    expect(product.places.C.x).toBe(980);
  });
});

describe("the fixture build command", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [here("../scripts/build-fixture.mjs"), ...args], { encoding: "utf-8", timeout: 30_000 });

  it("needs the release, the card pictures and an output folder", () => {
    const none = run();
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("--release-dir");
    const noOut = run("--release-dir", "x", "--art-dir", "y");
    expect(noOut.status).toBe(2);
    expect(noOut.stderr).toContain("--out FOLDER");
  });

  it("refuses an output folder inside the checkout or above it, and a version that is not three numbers", () => {
    for (const inside of [here("../fixture-extension"), here("../src"), here("../../docs/new-folder"), here("../../..")]) {
      const own = run("--release-dir", "x", "--art-dir", "y", "--out", inside);
      expect(own.status).toBe(2);
      expect(own.stderr).toContain("inside this checkout or holds it");
    }
    const bad = run("--release-dir", "x", "--art-dir", "y", "--out", "z", "--version", "2");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--version");
  });

  it("refuses a folder outside the checkout that is not empty and is not an earlier build of the fixture", () => {
    const other = mkdtempSync(join(tmpdir(), "fixture-out-"));
    try {
      writeFileSync(join(other, "notes.txt"), "keep me");
      const refused = run("--release-dir", "x", "--art-dir", "y", "--out", other);
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain("is not an earlier build of this fixture");
      expect(existsSync(join(other, "notes.txt"))).toBe(true);
      // An earlier build of the fixture passes the folder check (and then stops on the missing release).
      writeFileSync(join(other, "manifest.json"), JSON.stringify({ name: "Toy hover host fixture" }));
      const earlier = run("--release-dir", join(other, "no-release"), "--art-dir", "y", "--out", other);
      expect(earlier.status).toBe(2);
      expect(earlier.stderr).not.toContain("--out");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses an idle time that is not a positive whole number", () => {
    const bad = run("--release-dir", "x", "--art-dir", "y", "--out", "z", "--idle-unload-ms", "0");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("positive whole number");
  });
});
