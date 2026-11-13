// SPDX-License-Identifier: Apache-2.0
// Vendoring a built runtime into a product (scripts/vendor-lib.mjs) and checking it. Fixtures only:
// a made-up toolkit checkout with a made-up build, no network, no real build.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error: a plain .mjs script without declarations
import * as lib from "../scripts/vendor-lib.mjs";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const temps: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A made-up toolkit checkout and build; `tag` changes every built file, as another commit would. */
function fakeToolkit(tag: string, { opencv = true, license = true } = {}): { root: string; dist: string } {
  const root = temp();
  const dist = join(root, "browser", "dist");
  const built: Record<string, string> = {
    "cardvision.js": `cv ${tag}`,
    "worker.js": `worker ${tag} ort-wasm-simd-threaded.jsep.mjs ort-wasm-simd-threaded.jsep.wasm`,
    "compute-session.js": `cs ${tag}`,
    "page-capture.js": `pc ${tag}`,
    "remote-release.js": `rr ${tag}`,
    "worker.js.LEGAL.txt": `legal ${tag}`,
    "ort-wasm-simd-threaded.jsep.mjs": `ortjs ${tag}`,
    "ort-wasm-simd-threaded.jsep.wasm": `ortwasm ${tag}`,
    "node/verify-release.mjs": `v ${tag}`,
    "node/package-zip.mjs": `p ${tag}`,
    "node/store-upload.mjs": `s ${tag}`,
    ...(license ? { "THIRD-PARTY-NOTICES.txt": `notices ${tag}` } : {}),
    ...(opencv ? { "opencv.mjs": "cvjs", "opencv_js.wasm": "cvwasm", "opencv.mjs.LEGAL.txt": "cv license" } : {}),
  };
  for (const [name, text] of Object.entries(built)) put(join(dist, name), text);
  put(join(root, "LICENSE"), "Apache");
  put(join(root, "NOTICE"), "notice");
  put(join(root, "pyproject.toml"), `[project]\nversion = "0.14.0"\n`);
  put(join(root, "docs", "hover-spec.json"), `{"clauses":"${tag}"}`);
  put(
    join(root, "browser", "opencv.lock.json"),
    JSON.stringify({
      opencv: { tag: "5.0.0", commit: "c1" },
      emsdk: { tag: "4.0.20" },
      built: { files: { "opencv.mjs": { bytes: 4, sha256: sha("cvjs") }, "opencv_js.wasm": { bytes: 6, sha256: sha("cvwasm") } } },
    }),
  );
  return { root, dist };
}

const vendor = (kit: { root: string; dist: string }, into: string, commit = COMMIT_A, extra = {}) => lib.vendorInto({ root: kit.root, dist: kit.dist, into, commit, ...extra });
const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, lib.MANIFEST), "utf-8"));
const safeRead = (path: string): string => {
  try {
    return readFileSync(path).toString("hex");
  } catch {
    return "(folder)";
  }
};
const listing = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort();

describe("vendoring a runtime", () => {
  it("copies the runtime, licenses, ONNX Runtime files, OpenCV.js and the spec flat, and records them", () => {
    const kit = fakeToolkit("one");
    const into = join(temp(), "vendor", "cardvision-browser");
    const manifest = vendor(kit, into);
    expect(Object.keys(manifest.files)).toEqual([
      "LICENSE",
      "NOTICE",
      "THIRD-PARTY-NOTICES.txt",
      "cardvision.js",
      "compute-session.js",
      "hover-spec.json",
      "ort-wasm-simd-threaded.jsep.mjs",
      "ort-wasm-simd-threaded.jsep.wasm",
      "opencv.mjs",
      "opencv.mjs.LEGAL.txt",
      "opencv_js.wasm",
      "page-capture.js",
      "remote-release.js",
      "worker.js",
      "worker.js.LEGAL.txt",
    ].sort((a, b) => (a < b ? -1 : 1)));
    expect(manifest.toolkit).toEqual({ version: "0.14.0", commit: COMMIT_A });
    expect(manifest.files["worker.js"].sha256).toBe(sha(readFileSync(join(kit.dist, "worker.js"), "utf-8")));
    expect(manifest.opencv.tag).toBe("5.0.0");
    expect(manifestOf(into)).toEqual(manifest);
    expect(lib.checkVendor(into)).toEqual([]);
    expect(lib.checkVendor(into, { root: kit.root, dist: kit.dist, commit: COMMIT_A })).toEqual([]);
  });

  it("adds the Node tools on request and leaves out what is switched off", () => {
    const kit = fakeToolkit("one");
    const into = join(temp(), "v");
    const manifest = vendor(kit, into, COMMIT_A, { nodeTools: true, opencv: false, ortWasm: false });
    expect(Object.keys(manifest.files)).toContain("node/store-upload.mjs");
    expect(Object.keys(manifest.files).some((n) => n.startsWith("ort-wasm") || n.startsWith("opencv"))).toBe(false);
    expect(manifest.opencv).toBeNull();
    expect(lib.checkVendor(into)).toEqual([]);
  });

  it("keeps the product's own files (types) across a re-vendor, and leaves no staging folder", () => {
    const kit = fakeToolkit("one");
    const parent = temp();
    const into = join(parent, "v");
    vendor(kit, into);
    put(join(into, "types", "index.d.ts"), "export {};");
    put(join(into, "cardvision.d.ts"), "export {};");
    vendor(fakeToolkit("two"), into, COMMIT_B);
    expect(readFileSync(join(into, "types", "index.d.ts"), "utf-8")).toBe("export {};");
    expect(manifestOf(into).toolkit.commit).toBe(COMMIT_B);
    expect(readdirSync(parent)).toEqual(["v"]);
    expect(lib.checkVendor(into)).toEqual([]);
  });

  it("refuses a short commit and an OpenCV.js file the lock does not pin", () => {
    const kit = fakeToolkit("one");
    expect(() => vendor(kit, join(temp(), "v"), "abc123")).toThrow(/40-character/);
    put(join(kit.dist, "opencv.mjs"), "tampered");
    expect(() => vendor(kit, join(temp(), "v"))).toThrow(/opencv\.mjs in the build does not match opencv\.lock\.json/);
  });

  it("an interrupted run leaves the old folder and manifest as they were, and no staging folder", () => {
    const parent = temp();
    const into = join(parent, "v");
    vendor(fakeToolkit("one"), into);
    const snapshot = () => Object.fromEntries(listing(into).map((n) => [n, safeRead(join(into, n))]));
    const before = snapshot();
    const hooks = {
      beforeSwap: () => {
        throw new Error("power cut");
      },
    };
    expect(() => vendor(fakeToolkit("two"), into, COMMIT_B, { hooks })).toThrow(/power cut/);
    const after = snapshot();
    expect(after).toEqual(before);
    expect(manifestOf(into).toolkit.commit).toBe(COMMIT_A);
    expect(readdirSync(parent)).toEqual(["v"]);
    expect(lib.checkVendor(into)).toEqual([]);
  });

  it("an interrupted first run leaves no folder at all", () => {
    const parent = temp();
    const hooks = { beforeSwap: () => { throw new Error("power cut"); } };
    expect(() => vendor(fakeToolkit("one"), join(parent, "v"), COMMIT_A, { hooks })).toThrow(/power cut/);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("a build with no license notices cannot be vendored", () => {
    expect(() => vendor(fakeToolkit("one", { license: false }), join(temp(), "v"))).toThrow(/THIRD-PARTY-NOTICES\.txt is missing/);
  });
});

describe("checking a vendored runtime", () => {
  const vendored = () => {
    const kit = fakeToolkit("one");
    const into = join(temp(), "v");
    vendor(kit, into);
    return { kit, into, toolkit: { root: kit.root, dist: kit.dist, commit: COMMIT_A } };
  };

  it("fails on a changed file", () => {
    const { into } = vendored();
    writeFileSync(join(into, "worker.js"), "tampered");
    expect(lib.checkVendor(into)).toEqual([expect.stringMatching(/^worker\.js differs from the SHA-256/)]);
  });

  it("fails on a missing file and on an extra one, but not on the product's own types", () => {
    const { into } = vendored();
    rmSync(join(into, "page-capture.js"));
    put(join(into, "extra.js"), "x");
    put(join(into, "types", "a.d.ts"), "x");
    put(join(into, "node", "extra.mjs"), "x");
    const problems = lib.checkVendor(into) as string[];
    expect(problems).toContain("page-capture.js is listed in cardvision-vendor.json but missing");
    expect(problems).toContain("extra.js is in the folder but not in cardvision-vendor.json");
    expect(problems).toContain("node/extra.mjs is in the folder but not in cardvision-vendor.json");
    expect(problems.some((p) => p.includes("types/"))).toBe(false);
  });

  it("fails when two files come from a newer commit and the rest stay (the spec's example)", () => {
    const { into, toolkit } = vendored();
    const newer = fakeToolkit("two");
    for (const name of ["worker.js", "compute-session.js"]) writeFileSync(join(into, name), readFileSync(join(newer.dist, name)));
    // Against the manifest alone:
    const problems = lib.checkVendor(into) as string[];
    expect(problems.filter((p) => p.includes("differs from the SHA-256"))).toHaveLength(2);
    // And with the manifest rewritten to match the mixed folder, the build of the commit still disagrees:
    const manifest = manifestOf(into);
    for (const name of ["worker.js", "compute-session.js"]) manifest.files[name].sha256 = sha(readFileSync(join(into, name), "utf-8"));
    writeFileSync(join(into, lib.MANIFEST), JSON.stringify(manifest));
    const mixed = lib.checkVendor(into, toolkit) as string[];
    expect(mixed).toContain(`worker.js differs from the build of commit ${COMMIT_A.slice(0, 12)}`);
    expect(mixed).toContain(`compute-session.js differs from the build of commit ${COMMIT_A.slice(0, 12)}`);
    expect(mixed).toHaveLength(2);
  });

  it("does not compare with a build of another commit", () => {
    const { into, kit } = vendored();
    expect(lib.checkVendor(into, { root: kit.root, dist: kit.dist, commit: COMMIT_B })).toEqual([]);
  });

  it("fails on a missing or empty license file", () => {
    const { into } = vendored();
    rmSync(join(into, "NOTICE"));
    writeFileSync(join(into, "opencv.mjs.LEGAL.txt"), "");
    const manifest = manifestOf(into);
    manifest.files["opencv.mjs.LEGAL.txt"].sha256 = sha("");
    writeFileSync(join(into, lib.MANIFEST), JSON.stringify(manifest));
    const problems = lib.checkVendor(into) as string[];
    expect(problems).toContain("NOTICE is listed in cardvision-vendor.json but missing");
    expect(problems).toContain("license file opencv.mjs.LEGAL.txt is empty");
  });

  it("fails when a license file was dropped from the manifest as well", () => {
    const { into } = vendored();
    rmSync(join(into, "THIRD-PARTY-NOTICES.txt"));
    const manifest = manifestOf(into);
    delete manifest.files["THIRD-PARTY-NOTICES.txt"];
    writeFileSync(join(into, lib.MANIFEST), JSON.stringify(manifest));
    expect(lib.checkVendor(into)).toEqual(["license file THIRD-PARTY-NOTICES.txt is not listed in cardvision-vendor.json"]);
  });

  it("fails when the OpenCV files do not match the lock, even with the manifest rewritten to match", () => {
    const { into, toolkit } = vendored();
    writeFileSync(join(into, "opencv_js.wasm"), "other build");
    const manifest = manifestOf(into);
    manifest.files["opencv_js.wasm"].sha256 = sha("other build");
    writeFileSync(join(into, lib.MANIFEST), JSON.stringify(manifest));
    expect(lib.checkVendor(into)).toContain("opencv_js.wasm does not match the OpenCV lock recorded in cardvision-vendor.json");
    expect(lib.checkVendor(into, toolkit)).toContain("opencv_js.wasm does not match opencv.lock.json of the toolkit");
  });

  it("fails without a manifest, and with one that is not a manifest", () => {
    const { into } = vendored();
    writeFileSync(join(into, lib.MANIFEST), "{}");
    expect(lib.checkVendor(into)[0]).toMatch(/not a version 1 manifest/);
    rmSync(join(into, lib.MANIFEST));
    expect(lib.checkVendor(into)[0]).toMatch(/is missing from/);
  });
});
