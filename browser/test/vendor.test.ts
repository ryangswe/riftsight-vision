// SPDX-License-Identifier: Apache-2.0
// Vendoring a built runtime into a product (scripts/vendor-lib.mjs, vendor.mjs, vendor-check.mjs) and
// checking it. Fixtures only: a made-up toolkit checkout with a made-up build, no network, no real build.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error: a plain .mjs script without declarations
import * as lib from "../scripts/vendor-lib.mjs";
// @ts-expect-error: a plain .mjs script without declarations
import { buildInfoOf } from "../scripts/build-info.mjs";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const scriptsDir = fileURLToPath(new URL("../scripts/", import.meta.url));

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

type Kit = { root: string; dist: string };

/** A made-up toolkit checkout and build; `tag` changes every built file, as another commit would. */
function fakeToolkit(tag: string, { opencv = true, spec = true } = {}): Kit {
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
    "THIRD-PARTY-NOTICES.txt": `notices ${tag}`,
    "cardvision.d.ts": `export * from "./types/index.js"; // ${tag}`,
    "compute-session.d.ts": `export * from "./types/compute-session.js"; // ${tag}`,
    "page-capture.d.ts": `export * from "./types/page-capture-entry.js"; // ${tag}`,
    "remote-release.d.ts": `export * from "./types/remote/index.js"; // ${tag}`,
    "types/index.d.ts": `export {}; // ${tag}`,
    "types/compute-session.d.ts": `export {}; // ${tag}`,
    "types/page-capture-entry.d.ts": `export {}; // ${tag}`,
    "types/remote/index.d.ts": `export {}; // ${tag}`,
    ...(opencv ? { "opencv.mjs": "cvjs", "opencv_js.wasm": "cvwasm", "opencv.mjs.LEGAL.txt": "cv license" } : {}),
  };
  for (const [name, text] of Object.entries(built)) put(join(dist, name), text);
  put(join(root, "LICENSE"), "Apache");
  put(join(root, "NOTICE"), "notice");
  put(join(root, "pyproject.toml"), `[project]\nversion = "0.14.0"\n`);
  put(join(root, "browser", "package.json"), JSON.stringify({ dependencies: { "onnxruntime-web": "1.29.0" } }));
  if (spec) put(join(root, "docs", "hover-spec.json"), `{"clauses":"${tag}"}`);
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

const vendor = (kit: Kit, into: string, commit = COMMIT_A, extra: Record<string, unknown> = {}) => lib.vendorInto({ root: kit.root, dist: kit.dist, into, commit, ...extra });
const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, lib.MANIFEST), "utf-8"));
const writeManifest = (dir: string, manifest: unknown): void => writeFileSync(join(dir, lib.MANIFEST), JSON.stringify(manifest));
const safeRead = (path: string): string => {
  try {
    return readFileSync(path).toString("hex");
  } catch {
    return "(folder)";
  }
};
const snapshot = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir, { recursive: true }).map(String).sort().map((n) => [n, safeRead(join(dir, n))]));
const toolkitOf = (kit: Kit, commit = COMMIT_A) => ({ root: kit.root, dist: kit.dist, commit });
const throwing = (message: string) => () => {
  throw new Error(message);
};

describe("vendoring a runtime", () => {
  it("copies the runtime, declarations, licenses, ONNX Runtime files, OpenCV.js and the spec flat, and records them", () => {
    const kit = fakeToolkit("one");
    const into = join(temp(), "vendor", "cardvision-browser");
    const manifest = vendor(kit, into);
    expect(Object.keys(manifest.files)).toEqual(
      [
        "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.txt", "cardvision-vendor-check.mjs", "cardvision.d.ts", "cardvision.js", "compute-session.d.ts", "compute-session.js",
        "hover-spec.json", "opencv.mjs", "opencv.mjs.LEGAL.txt", "opencv_js.wasm", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm",
        "page-capture.d.ts", "page-capture.js", "remote-release.d.ts", "remote-release.js", "types/compute-session.d.ts", "types/index.d.ts", "types/page-capture-entry.d.ts", "types/remote/index.d.ts", "worker.js", "worker.js.LEGAL.txt",
      ].sort((a, b) => (a < b ? -1 : 1)),
    );
    expect(manifest.toolkit).toEqual({ version: "0.14.0", commit: COMMIT_A });
    expect(manifest.options).toEqual({ opencv: true, ortWasm: true, nodeTools: false });
    expect(manifest.ort).toEqual({ version: "1.29.0", files: ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"] });
    expect(manifest.files["worker.js"].sha256).toBe(sha(readFileSync(join(kit.dist, "worker.js"), "utf-8")));
    expect(manifest.opencv.tag).toBe("5.0.0");
    expect(manifestOf(into)).toEqual(manifest);
    expect(lib.checkVendor(into)).toEqual([]);
    expect(lib.checkVendor(into, toolkitOf(kit))).toEqual([]);
  });

  it("adds the Node tools on request; leaves ONNX Runtime and OpenCV.js out but still names the ORT pin", () => {
    const kit = fakeToolkit("one");
    const into = join(temp(), "v");
    const manifest = vendor(kit, into, COMMIT_A, { nodeTools: true, opencv: false, ortWasm: false });
    expect(Object.keys(manifest.files)).toContain("node/store-upload.mjs");
    expect(Object.keys(manifest.files).some((n) => n.startsWith("ort-wasm") || n.startsWith("opencv"))).toBe(false);
    expect(manifest.opencv).toBeNull();
    expect(manifest.ort.files).toHaveLength(2);
    expect(lib.checkVendor(into)).toEqual([]);
    expect(lib.checkVendor(into, toolkitOf(kit))).toEqual([]);
  });

  it("leaves the hover spec out when the commit has none, and the build comparison agrees", () => {
    const kit = fakeToolkit("one", { spec: false });
    const into = join(temp(), "v");
    expect(Object.keys(vendor(kit, into).files)).not.toContain("hover-spec.json");
    expect(lib.checkVendor(into, toolkitOf(kit))).toEqual([]);
  });

  it("keeps the files the product names as its own across a re-vendor, and leaves no staging folder", () => {
    const parent = temp();
    const into = join(parent, "v");
    const own = { unmanaged: ["notes/", "README.md"] };
    vendor(fakeToolkit("one"), into);
    put(join(into, "notes", "a.txt"), "mine");
    put(join(into, "README.md"), "mine too");
    vendor(fakeToolkit("two"), into, COMMIT_B, own);
    expect(readFileSync(join(into, "notes", "a.txt"), "utf-8")).toBe("mine");
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

  it("a build with no license notices or no declarations cannot be vendored", () => {
    const noNotices = fakeToolkit("one");
    rmSync(join(noNotices.dist, "THIRD-PARTY-NOTICES.txt"));
    expect(() => vendor(noNotices, join(temp(), "v"))).toThrow(/THIRD-PARTY-NOTICES\.txt is missing/);
    const noTypes = fakeToolkit("one");
    rmSync(join(noTypes.dist, "types"), { recursive: true });
    expect(() => vendor(noTypes, join(temp(), "v"))).toThrow(/has no declarations/);
  });
});

describe("what a run will not delete", () => {
  it("refuses a non-empty folder with no manifest, naming the way out, and changes nothing", () => {
    const into = temp();
    put(join(into, ".git", "HEAD"), "ref");
    put(join(into, "src", "main.js"), "mine");
    const before = snapshot(into);
    expect(() => vendor(fakeToolkit("one"), into)).toThrow(/not empty and has no cardvision-vendor\.json.*--adopt/);
    expect(snapshot(into)).toEqual(before);
  });

  it("refuses files in a vendored folder that no manifest or rule covers, hidden ones too, and lists them", () => {
    const into = join(temp(), "v");
    vendor(fakeToolkit("one"), into);
    put(join(into, ".git", "config"), "x");
    put(join(into, "mine.txt"), "x");
    const before = snapshot(into);
    expect(() => vendor(fakeToolkit("two"), into, COMMIT_B)).toThrow(/2 file\(s\).*\.git\/config, mine\.txt/);
    expect(snapshot(into)).toEqual(before);
    expect(() => vendor(fakeToolkit("two"), into, COMMIT_B, { unmanaged: [".git/", "mine.txt"] })).not.toThrow();
    expect(readFileSync(join(into, "mine.txt"), "utf-8")).toBe("x");
  });

  it("--adopt replaces a hand-vendored runtime (VENDOR.json, old types) but still refuses hidden and unknown files", () => {
    const into = join(temp(), "v");
    put(join(into, "VENDOR.json"), "{}");
    put(join(into, "types", "old.d.ts"), "x");
    put(join(into, "worker.js"), "old");
    put(join(into, "node", "package-zip.mjs"), "old");
    vendor(fakeToolkit("one"), into, COMMIT_A, { adopt: true });
    expect(existsSync(join(into, "VENDOR.json"))).toBe(false);
    expect(existsSync(join(into, "types", "old.d.ts"))).toBe(false);
    expect(lib.checkVendor(into)).toEqual([]);
    const other = join(temp(), "w");
    put(join(other, ".git", "HEAD"), "ref");
    expect(() => vendor(fakeToolkit("one"), other, COMMIT_A, { adopt: true })).toThrow(/\.git\/HEAD/);
  });

  it("accepts an empty existing folder", () => {
    expect(() => vendor(fakeToolkit("one"), temp())).not.toThrow();
  });

  it("refuses a target inside the toolkit checkout, one that holds it, and a symbolic link", () => {
    const kit = fakeToolkit("one");
    expect(() => vendor(kit, join(kit.root, "vendor"))).toThrow(/inside the toolkit checkout/);
    expect(() => vendor(kit, join(kit.root, "browser", "dist", "x"))).toThrow(/inside the toolkit checkout/);
    expect(() => vendor(kit, dirname(kit.root))).toThrow(/inside the toolkit checkout/);
    const real = join(temp(), "real");
    mkdirSync(real);
    const link = join(temp(), "link");
    symlinkSync(real, link);
    expect(() => vendor(kit, link)).toThrow(/symbolic link/);
    // Through a link to the checkout:
    const toRoot = join(temp(), "to-root");
    symlinkSync(kit.root, toRoot);
    expect(() => vendor(kit, join(toRoot, "inside"))).toThrow(/inside the toolkit checkout/);
  });

  it("refuses unmanaged rules that are suffixes, wildcards, escapes, or cover vendored files", () => {
    const kit = fakeToolkit("one");
    for (const rule of [".js", ".mjs", ".d.ts", ".wasm", ".json", "../x", "/abs", "", "a\\b"]) {
      expect(() => vendor(kit, join(temp(), "v"), COMMIT_A, { unmanaged: [rule] }), rule).toThrow(/unmanaged rule/);
    }
    for (const rule of ["worker-newer.js", "a/b.mjs", "x.wasm"]) {
      expect(() => vendor(kit, join(temp(), "v"), COMMIT_A, { unmanaged: [rule] }), rule).toThrow(/names a runtime file/);
    }
    expect(() => vendor(kit, join(temp(), "v"), COMMIT_A, { unmanaged: ["types/"] })).toThrow(/cover files the tool vendors/);
    expect(() => vendor(kit, join(temp(), "v"), COMMIT_A, { unmanaged: ["worker.js"] })).toThrow(/names a runtime file/);
    expect(() => vendor(kit, join(temp(), "v"), COMMIT_A, { unmanaged: ["THIRD-PARTY-NOTICES.txt"] })).toThrow(/cover files the tool vendors/);
  });
});

describe("declaration shims", () => {
  it("fail the vendor step when a shim points at a declaration the build lacks", () => {
    const kit = fakeToolkit("one");
    put(join(kit.dist, "page-capture.d.ts"), `export * from "./types/page-capture-wrong.js";`);
    expect(() => vendor(kit, join(temp(), "v"))).toThrow(/page-capture\.d\.ts points at types\/page-capture-wrong\.js, but dist\/types has no page-capture-wrong\.d\.ts/);
    const ok = fakeToolkit("one");
    rmSync(join(ok.dist, "types", "compute-session.d.ts"));
    expect(() => vendor(ok, join(temp(), "v"))).toThrow(/compute-session\.d\.ts points at/);
  });
});

describe("an interrupted or failing swap", () => {
  it("a failure before the swap leaves the old folder and manifest as they were, and no staging folder", () => {
    const parent = temp();
    const into = join(parent, "v");
    vendor(fakeToolkit("one"), into);
    const before = snapshot(into);
    expect(() => vendor(fakeToolkit("two"), into, COMMIT_B, { hooks: { beforeSwap: throwing("power cut") } })).toThrow(/power cut/);
    expect(snapshot(into)).toEqual(before);
    expect(manifestOf(into).toolkit.commit).toBe(COMMIT_A);
    expect(readdirSync(parent)).toEqual(["v"]);
  });

  it("a failure between the two renames puts the old folder back", () => {
    const parent = temp();
    const into = join(parent, "v");
    vendor(fakeToolkit("one"), into);
    const before = snapshot(into);
    expect(() => vendor(fakeToolkit("two"), into, COMMIT_B, { hooks: { betweenRenames: throwing("crash") } })).toThrow(/crash/);
    expect(snapshot(into)).toEqual(before);
    expect(readdirSync(parent)).toEqual(["v"]);
    expect(lib.checkVendor(into)).toEqual([]);
  });

  it("an interrupted first run leaves no folder at all", () => {
    const parent = temp();
    expect(() => vendor(fakeToolkit("one"), join(parent, "v"), COMMIT_A, { hooks: { beforeSwap: throwing("power cut") } })).toThrow(/power cut/);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("the next run restores a folder left missing by a killed run, and says so", () => {
    const parent = temp();
    const into = join(parent, "v");
    vendor(fakeToolkit("one"), into);
    // A killed run: the target moved aside, nothing moved in.
    const left = join(parent, ".v-stage-abc123-old");
    renameSync(into, left);
    const warnings: string[] = [];
    vendor(fakeToolkit("two"), into, COMMIT_B, { warn: (m: string) => warnings.push(m) });
    expect(warnings[0]).toMatch(/was restored from \.v-stage-abc123-old/);
    expect(manifestOf(into).toolkit.commit).toBe(COMMIT_B);
    expect(readdirSync(parent)).toEqual(["v"]);
  });

  it("refuses, with instructions, when several previous copies are left and the folder is missing", () => {
    const parent = temp();
    mkdirSync(join(parent, ".v-stage-aaaaaa-old"));
    mkdirSync(join(parent, ".v-stage-bbbbbb-old"));
    expect(() => vendor(fakeToolkit("one"), join(parent, "v"))).toThrow(/previous copies are left.*by hand/);
  });

  it("a previous copy that cannot be removed after the swap is a warning, and the run still succeeds", () => {
    const parent = temp();
    const into = join(parent, "v");
    vendor(fakeToolkit("one"), into);
    // A read-only folder inside the product's own files: the old copy cannot be emptied.
    put(join(into, "notes", "sub", "a.txt"), "mine");
    chmodSync(join(into, "notes", "sub"), 0o500);
    const warnings: string[] = [];
    try {
      const manifest = vendor(fakeToolkit("two"), into, COMMIT_B, { unmanaged: ["notes/"], warn: (m: string) => warnings.push(m) });
      expect(manifest.toolkit.commit).toBe(COMMIT_B);
      expect(manifestOf(into).toolkit.commit).toBe(COMMIT_B);
      expect(lib.checkVendor(into)).toEqual([]);
      expect(warnings).toEqual([expect.stringMatching(/is updated, but the previous copy .*-old could not be removed/)]);
    } finally {
      for (const n of readdirSync(parent)) if (n.endsWith("-old")) chmodSync(join(parent, n, "notes", "sub"), 0o700);
    }
  });

  it("clears stale staging folders left by an earlier run, with a warning for each", () => {
    const parent = temp();
    const into = join(parent, "v");
    vendor(fakeToolkit("one"), into);
    mkdirSync(join(parent, ".v-stage-zzzzzz-old"));
    mkdirSync(join(parent, ".v-stage-yyyyyy"));
    const warnings: string[] = [];
    vendor(fakeToolkit("two"), into, COMMIT_B, { warn: (m: string) => warnings.push(m) });
    expect(readdirSync(parent)).toEqual(["v"]);
    expect(warnings).toHaveLength(2);
  });
});

describe("checking a vendored runtime", () => {
  const vendored = () => {
    const kit = fakeToolkit("one");
    const into = join(temp(), "v");
    vendor(kit, into);
    return { kit, into, toolkit: toolkitOf(kit) };
  };

  it("fails on a changed file", () => {
    const { into } = vendored();
    writeFileSync(join(into, "worker.js"), "tampered");
    expect(lib.checkVendor(into)).toEqual([expect.stringMatching(/^worker\.js differs from the SHA-256/)]);
  });

  it("fails on a missing file and on an extra one, hidden ones and the product's old types included", () => {
    const { into } = vendored();
    rmSync(join(into, "page-capture.js"));
    put(join(into, "extra.js"), "x");
    put(join(into, ".hidden"), "x");
    put(join(into, "types", "stray.d.ts"), "x");
    put(join(into, "node", "extra.mjs"), "x");
    const problems = lib.checkVendor(into) as string[];
    expect(problems).toContain("page-capture.js is listed in cardvision-vendor.json but missing");
    for (const n of ["extra.js", ".hidden", "types/stray.d.ts", "node/extra.mjs"]) expect(problems).toContain(`${n} is in the folder but not in cardvision-vendor.json`);
  });

  it("fails when two files come from a newer commit and the rest stay (the spec's example)", () => {
    const { into, toolkit } = vendored();
    const newer = fakeToolkit("two");
    for (const name of ["worker.js", "compute-session.js"]) writeFileSync(join(into, name), readFileSync(join(newer.dist, name)));
    const problems = lib.checkVendor(into) as string[];
    expect(problems.filter((p) => p.includes("differs from the SHA-256"))).toHaveLength(2);
    // With the manifest rewritten to match the mixed folder, the build of the commit still disagrees:
    const manifest = manifestOf(into);
    for (const name of ["worker.js", "compute-session.js"]) manifest.files[name].sha256 = sha(readFileSync(join(into, name), "utf-8"));
    writeManifest(into, manifest);
    const mixed = lib.checkVendor(into, toolkit) as string[];
    expect(mixed).toHaveLength(2);
    expect(mixed).toEqual(expect.arrayContaining([`worker.js differs from the build of commit ${COMMIT_A.slice(0, 12)}`, `compute-session.js differs from the build of commit ${COMMIT_A.slice(0, 12)}`]));
  });

  it("compares with a build only when it is the manifest's commit", () => {
    const { into, kit } = vendored();
    const other = fakeToolkit("two");
    // Another commit's build is not compared, however different it is...
    expect(lib.checkVendor(into, toolkitOf(other, COMMIT_B))).toEqual([]);
    // ...and the same different build, claiming the manifest's commit, is.
    const claimed = lib.checkVendor(into, toolkitOf(other, COMMIT_A)) as string[];
    expect(claimed.length).toBeGreaterThan(5);
    expect(claimed).toContain(`worker.js differs from the build of commit ${COMMIT_A.slice(0, 12)}`);
    expect(lib.checkVendor(into, toolkitOf(kit))).toEqual([]);
  });

  it("fails on a missing or empty license file, listed or not", () => {
    const { into } = vendored();
    rmSync(join(into, "NOTICE"));
    writeFileSync(join(into, "opencv.mjs.LEGAL.txt"), "");
    const manifest = manifestOf(into);
    manifest.files["opencv.mjs.LEGAL.txt"].sha256 = sha("");
    writeManifest(into, manifest);
    const problems = lib.checkVendor(into) as string[];
    expect(problems).toContain("NOTICE is listed in cardvision-vendor.json but missing");
    expect(problems).toContain("license file opencv.mjs.LEGAL.txt is empty");
    rmSync(join(into, "THIRD-PARTY-NOTICES.txt"));
    delete manifest.files["THIRD-PARTY-NOTICES.txt"];
    writeManifest(into, manifest);
    expect(lib.checkVendor(into)).toContain("THIRD-PARTY-NOTICES.txt is not listed in cardvision-vendor.json");
  });

  it("fails when files are dropped from the folder and the manifest together", () => {
    const { into, kit } = vendored();
    const manifest = manifestOf(into);
    for (const name of ["worker.js", "types/index.d.ts", "hover-spec.json"]) {
      rmSync(join(into, name));
      delete manifest.files[name];
    }
    writeManifest(into, manifest);
    const problems = lib.checkVendor(into) as string[];
    expect(problems).toContain("worker.js is not listed in cardvision-vendor.json");
    expect(problems).toContain("types/index.d.ts is not listed in cardvision-vendor.json");
    // The spec is only knowable from the commit's checkout:
    expect(lib.checkVendor(into, toolkitOf(kit))).toContain(`hover-spec.json is in the build of commit ${COMMIT_A.slice(0, 12)} for these options but not in cardvision-vendor.json`);
  });

  it("fails when the OpenCV files do not match the lock, even with the manifest rewritten to match", () => {
    const { into, toolkit } = vendored();
    writeFileSync(join(into, "opencv_js.wasm"), "other build");
    const manifest = manifestOf(into);
    manifest.files["opencv_js.wasm"].sha256 = sha("other build");
    writeManifest(into, manifest);
    expect(lib.checkVendor(into)).toContain("opencv_js.wasm does not match the OpenCV lock recorded in cardvision-vendor.json");
    expect(lib.checkVendor(into, toolkit)).toContain("opencv_js.wasm does not match opencv.lock.json of the toolkit");
  });

  it("requires the opencv lock whenever an OpenCV file is listed, and options that agree", () => {
    const { into } = vendored();
    const manifest = manifestOf(into);
    manifest.opencv = null;
    writeManifest(into, manifest);
    expect(lib.checkVendor(into)).toContain("OpenCV files are listed but cardvision-vendor.json has no opencv lock");
  });

  it("fails when the toolkit's lock is not the one recorded (the lock hash)", () => {
    const { into, toolkit, kit } = vendored();
    appendFileSync(join(kit.root, "browser", "opencv.lock.json"), "\n");
    expect(lib.checkVendor(into, toolkit)).toContain(`the OpenCV lock of commit ${COMMIT_A.slice(0, 12)} differs from the one recorded in cardvision-vendor.json`);
  });

  it("requires the ORT pin, and the ORT files when they are vendored", () => {
    const { into } = vendored();
    const manifest = manifestOf(into);
    delete manifest.ort;
    writeManifest(into, manifest);
    expect(lib.checkVendor(into)).toContain("cardvision-vendor.json has no ort pin (version and files)");
    manifest.ort = { version: "1.29.0", files: ["ort-wasm-gone.wasm"] };
    writeManifest(into, manifest);
    expect(lib.checkVendor(into)).toContain("ONNX Runtime file ort-wasm-gone.wasm is not listed in cardvision-vendor.json");
  });

  it("fails when the pin or the file set differs from the build for the manifest's options", () => {
    const { into, toolkit } = vendored();
    const manifest = manifestOf(into);
    manifest.ort.version = "1.30.0";
    writeManifest(into, manifest);
    expect(lib.checkVendor(into, toolkit)).toContain(`the ONNX Runtime pin in cardvision-vendor.json differs from the build of commit ${COMMIT_A.slice(0, 12)}`);
  });

  it("refuses a manifest whose unmanaged rules hide runtime files", () => {
    const { into } = vendored();
    const manifest = manifestOf(into);
    manifest.unmanaged = [".js"];
    writeManifest(into, manifest);
    expect((lib.checkVendor(into) as string[]).some((p) => p.includes('unmanaged rule ".js"'))).toBe(true);
    manifest.unmanaged = ["worker.js"];
    writeManifest(into, manifest);
    expect(lib.checkVendor(into)).toContain("worker.js is listed in cardvision-vendor.json and also covered by an unmanaged rule");
  });

  it("reports a runtime file hidden by an unmanaged folder or file rule", () => {
    const { into } = vendored();
    put(join(into, "notes", "x.js"), "hidden");
    put(join(into, "worker-newer.mjs"), "hidden");
    put(join(into, "notes", "ok.txt"), "fine");
    const manifest = manifestOf(into);
    manifest.unmanaged = ["notes/", "worker-newer.mjs"];
    writeManifest(into, manifest);
    const problems = lib.checkVendor(into) as string[];
    expect(problems.filter((p) => p.includes("hidden by an unmanaged rule")).sort()).toEqual([
      expect.stringMatching(/^notes\/x\.js is a runtime file/),
      expect.stringMatching(/^worker-newer\.mjs is a runtime file/),
    ]);
    expect(problems.some((p) => p.includes("ok.txt"))).toBe(false);
  });

  it("fails without a manifest, and with one that is not a manifest", () => {
    const { into } = vendored();
    writeManifest(into, {});
    expect(lib.checkVendor(into)[0]).toMatch(/not a version 1 manifest/);
    rmSync(join(into, lib.MANIFEST));
    expect(lib.checkVendor(into)[0]).toMatch(/is missing from/);
  });
});

describe("the stand-alone checker in the vendored folder", () => {
  const vendored = () => {
    const kit = fakeToolkit("one");
    const into = join(temp(), "v");
    vendor(kit, into);
    return { kit, into, toolkit: toolkitOf(kit) };
  };
  const runChecker = (dir: string) => spawnSync(process.execPath, [join(dir, "cardvision-vendor-check.mjs"), dir], { encoding: "utf-8" });

  it("is listed in the manifest, imports nothing but Node built-ins, and passes on a good folder", () => {
    const { into, toolkit } = vendored();
    expect(manifestOf(into).files["cardvision-vendor-check.mjs"].sha256).toBe(sha(readFileSync(join(into, "cardvision-vendor-check.mjs"), "utf-8")));
    const imports = [...readFileSync(join(into, "cardvision-vendor-check.mjs"), "utf-8").matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((name) => (name ?? "").startsWith("node:"))).toBe(true);
    const done = runChecker(into);
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("Checked: file hashes, file set, licenses, OpenCV lock as recorded. Not checked: the build of the commit.");
    expect(lib.checkVendor(into, toolkit)).toEqual([]);
  });

  it("fails on a tampered file", () => {
    const { into } = vendored();
    appendFileSync(join(into, "worker.js"), "x");
    const done = runChecker(into);
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/worker\.js differs from the SHA-256/);
  });

  it("is itself checked: a changed checker fails its own run and the toolkit's check", () => {
    const { into, toolkit } = vendored();
    appendFileSync(join(into, "cardvision-vendor-check.mjs"), "\n// quiet\n");
    const done = runChecker(into);
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/cardvision-vendor-check\.mjs differs from the SHA-256/);
    expect((lib.checkVendor(into, toolkit) as string[]).some((p) => p.startsWith("cardvision-vendor-check.mjs differs from the SHA-256"))).toBe(true);
  });

  it("differs from the checker of the commit even when the manifest hash was rewritten to match", () => {
    const { into, toolkit } = vendored();
    appendFileSync(join(into, "cardvision-vendor-check.mjs"), "\n// quiet\n");
    const manifest = manifestOf(into);
    manifest.files["cardvision-vendor-check.mjs"].sha256 = sha(readFileSync(join(into, "cardvision-vendor-check.mjs"), "utf-8"));
    writeManifest(into, manifest);
    expect(lib.checkVendor(into)).toEqual([]);
    expect(lib.checkVendor(into, toolkit)).toEqual([`cardvision-vendor-check.mjs differs from the build of commit ${COMMIT_A.slice(0, 12)}`]);
  });

  it("takes exactly one folder argument", () => {
    const { into } = vendored();
    expect(spawnSync(process.execPath, [join(into, "cardvision-vendor-check.mjs")], { encoding: "utf-8" }).status).toBe(2);
  });
});

describe("choosing the build to compare with", () => {
  const dist = (info: string | null): string => {
    const dir = temp();
    if (info !== null) put(join(dir, "build-info.json"), info);
    return dir;
  };
  const pick = (d: string, head: string | null = COMMIT_A) => lib.selectBuild({ root: "/r", dist: d, head, manifestCommit: COMMIT_A });

  it("takes a clean build of the manifest's commit", () => {
    const d = dist(JSON.stringify({ commit: COMMIT_A, dirty: false }));
    expect(pick(d).toolkit).toEqual({ root: "/r", dist: d, commit: COMMIT_A });
  });

  it("says why it does not: another HEAD, no git, a stale, missing, broken or dirty build-info", () => {
    expect(pick(dist(JSON.stringify({ commit: COMMIT_A, dirty: false })), COMMIT_B).reason).toMatch(/checkout is at bbbbbbbbbbbb, the manifest is for aaaaaaaaaaaa/);
    expect(pick(dist(JSON.stringify({ commit: COMMIT_A, dirty: false })), null).reason).toMatch(/not a git checkout/);
    expect(pick(dist(JSON.stringify({ commit: COMMIT_B, dirty: false }))).reason).toMatch(/built from bbbbbbbbbbbb/);
    expect(pick(dist(null)).reason).toMatch(/build-info\.json is missing/);
    expect(pick(dist("{")).reason).toMatch(/not valid JSON/);
    expect(pick(dist(JSON.stringify({ commit: COMMIT_A, dirty: true }))).reason).toMatch(/changes/);
  });

  it("is what the build writer returns for a git checkout: the commit, then whether the tree has changes", () => {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: ["t", "invalid"].join("@"), GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: ["t", "invalid"].join("@"), GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (cwd: string, ...args: string[]): string => {
      const done = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8", env });
      if (done.status !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
      return done.stdout.trim();
    };
    const repo = temp();
    git(repo, "init", "-q");
    put(join(repo, "a.txt"), "a");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "one");
    const head = git(repo, "rev-parse", "HEAD");
    expect(buildInfoOf(repo)).toEqual({ commit: head, dirty: false });
    put(join(repo, "a.txt"), "changed");
    expect(buildInfoOf(repo)).toEqual({ commit: head, dirty: true });
    expect(buildInfoOf(temp())).toEqual({ commit: null, dirty: true });
  });
});

describe("the commands, in a fake git checkout", () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: ["t", "invalid"].join("@"), GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: ["t", "invalid"].join("@"), GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (cwd: string, ...args: string[]): string => {
    const done = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8", env });
    if (done.status !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
    return done.stdout.trim();
  };

  /** A git checkout of a made-up toolkit with the real scripts and a "build" of it. */
  function checkout(tag = "one"): { root: string; head: string } {
    const kit = fakeToolkit(tag);
    const root = kit.root;
    rmSync(join(root, "browser", "dist"), { recursive: true });
    put(join(root, ".gitignore"), "dist/\n");
    for (const name of ["vendor-lib.mjs", "vendor.mjs", "vendor-check.mjs"]) {
      mkdirSync(join(root, "browser", "scripts"), { recursive: true });
      copyFileSync(join(scriptsDir, name), join(root, "browser", "scripts", name));
    }
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "toolkit");
    const head = git(root, "rev-parse", "HEAD");
    const built = fakeToolkit(tag);
    cpSync(built.dist, join(root, "browser", "dist"), { recursive: true });
    put(join(root, "browser", "dist", "build-info.json"), JSON.stringify({ commit: head, dirty: false }));
    return { root, head };
  }
  const run = (root: string, script: string, caller: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(root, "browser", "scripts", script), ...args], { cwd: join(root, "browser"), encoding: "utf-8", env: { ...env, INIT_CWD: caller } });

  it("vendors into a folder relative to the caller's directory, not browser/, and checks it with the build", () => {
    const { root } = checkout();
    const caller = temp();
    const done = run(root, "vendor.mjs", caller, "--into", "product/vendor");
    expect(done.status, done.stderr).toBe(0);
    expect(existsSync(join(caller, "product", "vendor", "cardvision-vendor.json"))).toBe(true);
    expect(existsSync(join(root, "browser", "product"))).toBe(false);
    const check = run(root, "vendor-check.mjs", caller, "product/vendor");
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain("Checked: file hashes, file set, licenses, OpenCV lock, build of commit");
    expect(check.stdout).not.toContain("Skipped");
  });

  it("refuses a tree with changes, a stale or dirty build-info, and a --commit that is not HEAD", () => {
    const { root, head } = checkout();
    const caller = temp();
    const into = join(caller, "v");
    const info = join(root, "browser", "dist", "build-info.json");

    put(info, JSON.stringify({ commit: COMMIT_B, dirty: false }));
    expect(run(root, "vendor.mjs", caller, "--into", into).stderr).toMatch(/dist\/ was built from bbbbbbbbbbbb.*not clean HEAD/);
    put(info, JSON.stringify({ commit: head, dirty: true }));
    expect(run(root, "vendor.mjs", caller, "--into", into).stderr).toMatch(/with changes/);
    rmSync(info);
    expect(run(root, "vendor.mjs", caller, "--into", into).stderr).toMatch(/build-info\.json is missing/);
    put(info, JSON.stringify({ commit: head, dirty: false }));

    git(root, "commit", "-q", "--allow-empty", "-m", "later");
    put(info, JSON.stringify({ commit: git(root, "rev-parse", "HEAD"), dirty: false }));
    const old = run(root, "vendor.mjs", caller, "--into", into, "--commit", head);
    expect(old.stderr).toMatch(/is not HEAD/);

    appendFileSync(join(root, "NOTICE"), "edited");
    expect(run(root, "vendor.mjs", caller, "--into", into).stderr).toMatch(/uncommitted changes/);
    expect(existsSync(into)).toBe(false);
  });

  it("refuses a folder inside the checkout and a folder with files it did not make", () => {
    const { root } = checkout();
    const caller = temp();
    expect(run(root, "vendor.mjs", caller, "--into", join(root, "browser", "x")).stderr).toMatch(/inside the toolkit checkout/);
    put(join(caller, "product", ".git", "HEAD"), "ref");
    const done = run(root, "vendor.mjs", caller, "--into", "product");
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/no cardvision-vendor\.json/);
    expect(existsSync(join(caller, "product", ".git", "HEAD"))).toBe(true);
  });

  it("does not claim a build comparison it skipped: another HEAD, a dirty or missing build-info", () => {
    const { root, head } = checkout();
    const caller = temp();
    expect(run(root, "vendor.mjs", caller, "--into", "v").status).toBe(0);
    const info = join(root, "browser", "dist", "build-info.json");

    put(info, JSON.stringify({ commit: head, dirty: true }));
    const dirty = run(root, "vendor-check.mjs", caller, "v");
    expect(dirty.status, dirty.stderr).toBe(0);
    expect(dirty.stdout).toMatch(/Checked: file hashes, file set, licenses, OpenCV lock\. Skipped: comparison with a build \(.*changes/);
    expect(dirty.stdout).not.toContain("build of commit");

    rmSync(info);
    expect(run(root, "vendor-check.mjs", caller, "v").stdout).toMatch(/Skipped: comparison with a build \(dist\/build-info\.json is missing/);

    // HEAD moves on: the manifest is for the earlier commit.
    git(root, "commit", "-q", "--allow-empty", "-m", "later");
    put(info, JSON.stringify({ commit: git(root, "rev-parse", "HEAD"), dirty: false }));
    const later = run(root, "vendor-check.mjs", caller, "v");
    expect(later.status).toBe(0);
    expect(later.stdout).toMatch(/Skipped: comparison with a build \(this checkout is at .*, the manifest is for /);
    expect(later.stdout).not.toContain("build of commit");
  });

  it("fails on a file changed against the build when the build is at hand, and on a tampered file when it is not", () => {
    const { root, head } = checkout();
    const caller = temp();
    expect(run(root, "vendor.mjs", caller, "--into", "v").status).toBe(0);
    appendFileSync(join(caller, "v", "worker.js"), "x");
    const check = run(root, "vendor-check.mjs", caller, "v");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("worker.js differs from the SHA-256");
    expect(check.stderr).toContain(`worker.js differs from the build of commit ${head.slice(0, 12)}`);
    expect(check.stderr).toContain("Checked: file hashes, file set, licenses, OpenCV lock, build of commit");
    expect(run(root, "vendor-check.mjs", caller).status).toBe(2);
  });
});
