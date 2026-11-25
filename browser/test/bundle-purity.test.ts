// SPDX-License-Identifier: Apache-2.0
// The experimental entries an extension vendors carry no ONNX Runtime, no WebAssembly and
// no OpenCV, and the public bundle still exports the session API. The WebAssembly-only build
// (dist/wasm/) loads only ONNX Runtime's WebAssembly-only file. Needs dist/ (npm run build):
// skipped without it, required when CARDVISION_REQUIRE_BROWSER=1.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const dist = (name: string): string => fileURLToPath(new URL(`../dist/${name}`, import.meta.url));
const hostBundles = ["host-content.js", "host-compute.js", "host-settings.js"];
const bundles = ["cardvision.js", "compute-session.js", "page-capture.js", ...hostBundles, "wasm/cardvision.js", "wasm/worker.js"];
const built = bundles.every((name) => existsSync(dist(name)));
const required = process.env.CARDVISION_REQUIRE_BROWSER === "1";

describe("bundle purity", () => {
  if (!built && !required) {
    it.skip("needs a current dist/ (run npm run build)", () => {});
    return;
  }

  it("has been built", () => {
    expect(built).toBe(true);
  });

  for (const name of ["compute-session.js", "page-capture.js"]) {
    it(`${name} holds no ONNX Runtime, WebAssembly or OpenCV`, () => {
      const text = readFileSync(dist(name), "utf-8");
      expect(text.length).toBeGreaterThan(0);
      for (const word of ["onnxruntime", "ort-wasm", "WebAssembly", "opencv"]) expect(text, word).not.toContain(word);
    });
  }

  // The shared hover host: one self-contained file per realm, no model runtime, no dynamic code, no
  // extension API (ports are injected). The settings file also touches no page.
  for (const name of hostBundles) {
    it(`${name} holds no model runtime, dynamic code or extension API`, () => {
      const text = readFileSync(dist(name), "utf-8");
      expect(text.length).toBeGreaterThan(0);
      for (const word of ["onnxruntime", "ort-wasm", "WebAssembly", "opencv", "eval(", "new Function", "import(", "import.meta", "chrome."]) expect(text, word).not.toContain(word);
      if (name === "host-settings.js") for (const word of ["document.", "window."]) expect(text, word).not.toContain(word);
    });
  }

  // At least these names; the entries grow as the session modules land.
  const entryExports: Record<string, string[]> = {
    "compute-session.js": ["FrameScheduler", "replyRejection", "hoverAt", "cadenceMs", "computeProtocol", "SessionCore", "neighborBoxes", "createWorkerSession", "plainLoad", "startComputeFrame"],
    "page-capture.js": [
      "pictureBox",
      "fractionIn",
      "analysisSize",
      "grabFrame",
      "createSourceCanvas",
      "isFrozen",
      "mediaTimeOf",
      "blankFrame",
      "watchVideo",
      "captureAllowed",
      "computeProtocol",
      "createCaptureControl",
      "acceptComputeOut",
      "fromExtensionFrame",
      "postWithTransfer",
    ],
    "host-content.js": ["startHostContent", "pagePolicy"],
    "host-compute.js": ["startHostCompute", "createSettingsCore"],
    "host-settings.js": ["createSettingsCore", "createSwitches", "compareVersions", "updateNotice", "allowedParentOrigin", "pagePolicy", "productConfigError"],
  };
  for (const [name, names] of Object.entries(entryExports)) {
    it(`${name} exports ${names.join(", ")}`, async () => {
      const api = (await import(dist(name))) as Record<string, unknown>;
      for (const want of names) expect(typeof api[want], want).toBe("function");
    });
  }

  it("host-content.js does not export the capture control, and host-compute.js exports the standard option sets", async () => {
    const content = (await import(dist("host-content.js"))) as Record<string, unknown>;
    expect(content.createCaptureControl).toBeUndefined();
    expect(content.HIDE_DELAY_MS).toBe(120);
    const compute = (await import(dist("host-compute.js"))) as Record<string, unknown>;
    expect(compute.STANDARD_PRESET).toEqual({ mode: "pointer", rotatedOutlines: true, measuredPacing: true, idleUnloadMs: 600_000 });
    expect(compute.GEOMETRIC_OPTIONS).toEqual({ geometricScope: "focus", geometricLoad: "pointer" });
    expect(typeof compute.DRIVER_TICK_MS).toBe("number");
  });

  for (const name of ["cardvision.js", "wasm/cardvision.js"]) {
    it(`${name} still exports the session API`, async () => {
      const api = (await import(dist(name))) as Record<string, unknown>;
      for (const fn of ["createSession", "loadRelease", "analyzeFrame", "hoverAt"]) expect(typeof api[fn], fn).toBe("function");
    });
  }

  it("the WebAssembly-only build names only ONNX Runtime's WebAssembly-only files, and they are beside it", () => {
    const named = (name: string): string[] => [...new Set(readFileSync(dist(name), "utf-8").match(/ort-wasm-[a-z-]+(?:\.[a-z]+)*\.(?:wasm|mjs)/g) ?? [])].sort();
    for (const name of ["wasm/cardvision.js", "wasm/worker.js"]) expect(named(name), name).toEqual(["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]);
    // The default build names the file with WebGPU in it, which this build exists to leave out.
    expect(named("worker.js").some((n) => n.includes("jsep"))).toBe(true);
    const folder = readdirSync(dist("wasm")).sort();
    expect(folder.filter((n) => n.startsWith("ort-wasm"))).toEqual(["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]);
    // 25 MiB, a per-file limit some static hosts set: the reason for this build.
    for (const n of folder) expect(statSync(dist(`wasm/${n}`)).size, n).toBeLessThan(25 * 1024 * 1024);
  });
});
