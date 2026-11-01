// SPDX-License-Identifier: Apache-2.0
// Where a load's time goes (LoadTimings in load.ts), with ONNX Runtime stood in for and a clock
// that moves only when the stand-ins say: creating a session and its first run each take a set
// time, and a provider tried first fails after a set time.

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadReleaseData, parseRelease, releaseIdOf, type ReleaseDeps, sha256HexWebCrypto } from "../src/release.js";
import { FIXTURES } from "./support.js";

let clock = 0;
/** How the WebGPU provider fails: it throws at create, or it creates a session whose output is
 *  not the model the release describes (its warm-up check fails). */
let webgpuFailure: "throws" | "wrong-output" = "throws";
let fetches = 0;
/** What JSON.parse took after every file was fetched and checked: the read time. */
let readParses = 0;
/** JSON.parse calls before then, and SHA-256 digests: both file time. */
let fileParses = 0;
let digests = 0;
const STEP = { webgpuFails: 1000, wrongOutput: { create: 200, run: 300 }, fetch: 5, hash: 3, parse: 7, create: { recognizer: 30, detector: 20 }, firstRun: { recognizer: 45, detector: 25 } };

vi.mock("onnxruntime-web/all", () => {
  class Tensor {
    constructor(readonly type: string, readonly data: Float32Array, readonly dims: number[]) {}
  }
  return {
    env: { versions: { web: "1.29.0" }, wasm: {} },
    Tensor,
    InferenceSession: {
      create: async (bytes: ArrayBuffer, options: { executionProviders: string[] }) => {
        const model = new TextDecoder().decode(bytes).includes("detector") ? "detector" : "recognizer";
        const webgpu = options.executionProviders[0] === "webgpu";
        if (webgpu && webgpuFailure === "throws") {
          clock += STEP.webgpuFails;
          throw new Error("no WebGPU here");
        }
        if (webgpu) {
          clock += STEP.wrongOutput.create;
          return {
            run: async () => {
              clock += STEP.wrongOutput.run;
              return {};
            },
            release: async () => undefined,
          };
        }
        clock += STEP.create[model];
        return {
          run: async (feeds: Record<string, Tensor>) => {
            clock += STEP.firstRun[model];
            const dims = Object.values(feeds)[0]!.dims;
            return model === "detector"
              ? { [DETECTOR_OUTPUT]: { dims: [1, ANCHORS, COLUMNS], data: new Float32Array(0) } }
              : { [RECOGNIZER_OUTPUT]: { data: new Float32Array(DIM), dims: [dims[0], DIM] } };
          },
          release: async () => undefined,
        };
      },
    },
  };
});

const FOLDER = `${FIXTURES}toy-release/`;
const BASE = "https://example.test/releases/toy/";
const text = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === "string" ? value : `${JSON.stringify(value, null, 1)}\n`);
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc: any = JSON.parse(readFileSync(`${FOLDER}release.json`, "utf-8"));
const parsed = parseRelease(doc);
if (!("release" in parsed)) throw new Error(parsed.error);
const DIM = parsed.release.recognizer.dim;
const ANCHORS = parsed.release.detector.settings.anchors;
const COLUMNS = 5 + parsed.release.detector.settings.classes.length;
const RECOGNIZER_OUTPUT = parsed.release.recognizer.outputName;
const DETECTOR_OUTPUT = parsed.release.detector.settings.outputName;

/** The toy release with stand-in model bytes, pinned, under the id its content has. */
async function toyFiles(): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const name of ["bank.json", "bank.identity-groups.json", "catalog.json"]) files.set(name, new Uint8Array(readFileSync(`${FOLDER}${name}`)));
  files.set("detector.onnx", text("stand-in detector bytes"));
  files.set("recognizer.onnx", text("stand-in recognizer bytes, a little longer"));
  const d = structuredClone(doc);
  for (const block of [d.detector, d.recognizer]) {
    const body = files.get(block.path)!;
    block.sha256 = await sha256HexWebCrypto(buffer(body));
    block.bytes = body.length;
  }
  d.id = await releaseIdOf(JSON.stringify(d), sha256HexWebCrypto);
  files.set("release.json", text(d));
  return files;
}

function deps(files: Map<string, Uint8Array>): ReleaseDeps {
  return {
    digestSha256Hex: async (bytes) => {
      digests += 1;
      clock += STEP.hash;
      return sha256HexWebCrypto(bytes);
    },
    fetchFn: async (url) => {
      fetches += 1;
      clock += STEP.fetch;
      const body = url.startsWith(BASE) ? files.get(url.slice(BASE.length)) : undefined;
      return { ok: body !== undefined, status: body ? 200 : 404, arrayBuffer: async () => (body ? buffer(body) : new ArrayBuffer(0)) };
    },
  };
}

/** A clock that moves only when the stand-ins say, and a JSON.parse that takes STEP.parse,
 *  counted as read time once all six files were fetched. */
function standInClock(start: number): void {
  clock = start;
  fetches = 0;
  readParses = 0;
  fileParses = 0;
  digests = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const parse = JSON.parse.bind(JSON);
  vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    clock += STEP.parse;
    if (fetches === 6 && digests === 6) readParses += 1;
    else fileParses += 1;
    return parse(text, reviver);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  webgpuFailure = "throws";
});

describe("a load's timings", () => {
  it("say how long the files took, and each model's create and first run on the provider that worked", async () => {
    const { loadRelease } = await import("../src/load.js");
    const files = await toyFiles();
    standInClock(500);
    const loaded = await loadRelease(`${BASE}release.json`, { deps: deps(files), providers: ["webgpu", "wasm"] });
    expect(loaded.backend).toEqual({ detector: "wasm", recognizer: "wasm" });
    const t = loaded.timings!;
    // The files: six fetches, six digests (the document's id and five pinned files) and the
    // document's parses; reading: the parses once every file is fetched and hashed.
    expect([digests, readParses > 0, fileParses > 0]).toEqual([6, true, true]);
    expect(t.filesMs).toBe(6 * STEP.fetch + 6 * STEP.hash + fileParses * STEP.parse);
    expect(t.readMs).toBe(readParses * STEP.parse);
    // Each model's failed WebGPU attempt is apart from its create and first run.
    const recognizer = { createMs: STEP.create.recognizer, firstRunMs: STEP.firstRun.recognizer, failedProvidersMs: STEP.webgpuFails, totalMs: STEP.webgpuFails + STEP.create.recognizer + STEP.firstRun.recognizer };
    const detector = { createMs: STEP.create.detector, firstRunMs: STEP.firstRun.detector, failedProvidersMs: STEP.webgpuFails, totalMs: STEP.webgpuFails + STEP.create.detector + STEP.firstRun.detector };
    expect(t).toEqual({ startedAtMs: 500, filesMs: t.filesMs, readMs: t.readMs, recognizer, detector, totalMs: clock - 500 });
  });

  it("count a provider whose session started but failed its check in failedProvidersMs, not in its create or first run", async () => {
    const { loadRelease } = await import("../src/load.js");
    const files = await toyFiles();
    standInClock(0);
    webgpuFailure = "wrong-output";
    const loaded = await loadRelease(`${BASE}release.json`, { deps: deps(files), providers: ["webgpu", "wasm"] });
    const failed = STEP.wrongOutput.create + STEP.wrongOutput.run;
    expect(loaded.timings?.recognizer).toEqual({ createMs: STEP.create.recognizer, firstRunMs: STEP.firstRun.recognizer, failedProvidersMs: failed, totalMs: failed + STEP.create.recognizer + STEP.firstRun.recognizer });
    expect(loaded.timings?.detector).toEqual({ createMs: STEP.create.detector, firstRunMs: STEP.firstRun.detector, failedProvidersMs: failed, totalMs: failed + STEP.create.detector + STEP.firstRun.detector });
  });

  it("say no time went to failed providers when the first one works", async () => {
    const { loadRelease } = await import("../src/load.js");
    const files = await toyFiles();
    standInClock(0);
    const loaded = await loadRelease(`${BASE}release.json`, { deps: deps(files), providers: ["wasm"] });
    expect([loaded.timings?.recognizer.failedProvidersMs, loaded.timings?.detector.failedProvidersMs]).toEqual([0, 0]);
  });

  it("mark the end of the files with onFetched, once all six are fetched and hashed, which cannot stop the load", async () => {
    const files = await toyFiles();
    fetches = 0;
    digests = 0;
    const seen: number[] = [];
    const result = await loadReleaseData(`${BASE}release.json`, deps(files), {
      onFetched: () => {
        seen.push(fetches, digests);
        throw new Error("a display that broke");
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([6, 6]);
  });

  it("are whole milliseconds", async () => {
    const { loadRelease } = await import("../src/load.js");
    clock = 0.4;
    let calls = 0;
    // Every reading of the clock is a little later than the last, by a fraction of a ms.
    vi.spyOn(performance, "now").mockImplementation(() => clock + (calls++) * 0.3);
    const loaded = await loadRelease(`${BASE}release.json`, { deps: deps(await toyFiles()), providers: ["wasm"] });
    const t = loaded.timings!;
    const numbers = [t.startedAtMs, t.filesMs, t.readMs, t.totalMs, ...Object.values(t.recognizer), ...Object.values(t.detector)];
    expect(numbers.every((n) => Number.isInteger(n))).toBe(true);
  });
});
