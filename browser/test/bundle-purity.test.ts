// SPDX-License-Identifier: Apache-2.0
// The two experimental entries an extension vendors carry no ONNX Runtime, no WebAssembly and
// no OpenCV, and the public bundle still exports the session API. Needs dist/ (npm run build):
// skipped without it, required when CARDVISION_REQUIRE_BROWSER=1.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const dist = (name: string): string => fileURLToPath(new URL(`../dist/${name}`, import.meta.url));
const bundles = ["cardvision.js", "compute-session.js", "page-capture.js"];
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
  };
  for (const [name, names] of Object.entries(entryExports)) {
    it(`${name} exports ${names.join(", ")}`, async () => {
      const api = (await import(dist(name))) as Record<string, unknown>;
      for (const want of names) expect(typeof api[want], want).toBe("function");
    });
  }

  it("cardvision.js still exports the session API", async () => {
    const api = (await import(dist("cardvision.js"))) as Record<string, unknown>;
    for (const name of ["createSession", "loadRelease", "analyzeFrame", "hoverAt"]) expect(typeof api[name], name).toBe("function");
  });
});
