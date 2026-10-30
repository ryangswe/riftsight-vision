// SPDX-License-Identifier: Apache-2.0
// The worker's handling of the geometric stage (worker-host.ts), with a real pipeline on fake
// models and fake stages: off without WebGPU or when a part fails to load, off for the session
// when it fails during a frame (that frame answered exactly as without a stage), when its
// device is lost and when the watchdog trips, and a stage that loads during a frame joining
// after it.

import { describe, expect, it } from "vitest";

import { rectOf } from "../src/boxes.js";
import type { FrameDetector } from "../src/detector/detector.js";
import { GeometricWatchdog, type GeometricStage } from "../src/geometric/stage.js";
import type { LoadedRelease } from "../src/load.js";
import { BUSY_ERROR, type FrameResult, type GeometricStatus, type WorkerReply } from "../src/messages.js";
import { Pipeline } from "../src/pipeline.js";
import { createWorkerHost, type VoteDevice } from "../src/worker-host.js";
import { solidFrame } from "./support.js";

const FRAME = solidFrame(200, 150, [9, 9, 9]);
const box = { aabb: { x: 10, y: 10, width: 60, height: 84 }, rect: rectOf({ x: 10, y: 10, width: 60, height: 84 }), score: 0.9, cls: 0 };

/** A pipeline on fake models; `gate`, when given, holds the detector until it resolves. */
function makePipeline(gate?: () => Promise<void>): Pipeline {
  const matrix = new Float32Array(9);
  for (let r = 0; r < 3; r++) matrix[r * 3 + r] = 1;
  return new Pipeline({
    detector: { lastTimings: null, propose: async () => { await gate?.(); return [box]; } } as unknown as FrameDetector,
    embedder: { embedBatch: async (_d: Float32Array, n: number) => { const out = new Float32Array(n * 3); for (let i = 0; i < n; i++) out.set([0.7, 0.1, 0.1], i * 3); return out; } },
    bank: { ids: ["A", "B", "C"], matrix, dim: 3, version: 1, model: "fake", preprocessing: "full128", tau: null },
    names: new Map([["A", "Alder"], ["B", "Birch"], ["C", "Cedar"]]),
    accept: { tau: 0.62, delta: 0.05, rotationRetry: true },
    now: () => 0,
    minCropPx: 1,
  });
}

function loadedRelease(pipeline: Pipeline): LoadedRelease {
  return {
    release: {
      id: "r", game: "toy", locale: "en",
      detector: { version: "d", settings: { decode: { threshold: 0.5, nmsIou: 0.5, maxProposals: 10 }, minCropPx: 1 } },
      recognizer: { version: "e" },
      bank: { cardCount: 3 }, catalog: { cardCount: 3 }, identity: { level: "printing" },
      accept: { tau: 0.62, delta: 0.05, rotationRetry: true },
      hover: { selection: "accepted-nms", maxAgeMs: 2000 },
      runtime: { analysisWidth: { min: 1, max: 4000 }, ortWeb: "1.29.0" },
    },
    pipeline,
    backend: { detector: "wasm", recognizer: "wasm" },
    cards: [],
    names: new Map(),
    stageInputs: { bankSha256: "0".repeat(64), bankIds: ["A", "B", "C"], identities: new Map() },
    dispose: async () => {},
  } as unknown as LoadedRelease;
}

/** A stage that verifies B with many inliers, or throws when `fail` says so. */
function fakeStage(fail: () => boolean = () => false): GeometricStage & { disposed: number } {
  const stage = {
    disposed: 0,
    reorder: true,
    applies: () => true,
    verifyBatch: async (items: Array<{ ranked: Array<{ cardId: string; cosine: number }> }>) => {
      if (fail()) throw new Error("boom");
      return items.map((item) => {
        const cosine = item.ranked.find((r) => r.cardId === "B")!.cosine;
        return { cropKeypoints: 0, ms: 0, candidates: [{ cardId: "B", cosine, foundBy: "embedding", votes: 0, matches: 50, inliers: 50, evidence: 50, fused: cosine + 1.5, indexed: true }] };
      });
    },
    dispose() {
      stage.disposed += 1;
    },
  };
  return stage as unknown as GeometricStage & { disposed: number };
}

class FakeDevice implements VoteDevice {
  readonly lost: Promise<{ reason: string; message: string }>;
  lose!: (info: { reason: string; message: string }) => void;
  released = 0;
  constructor() {
    this.lost = new Promise((resolve) => (this.lose = resolve));
  }
}

interface Setup {
  device?: FakeDevice | null;
  open?: (manifestSha256: string | undefined) => Promise<{ stage: GeometricStage; bytes: number; note: string | null }>;
  gate?: () => Promise<void>;
  watchdog?: GeometricWatchdog;
}

function host(setup: Setup) {
  const replies: WorkerReply[] = [];
  const pipeline = makePipeline(setup.gate);
  const device = setup.device === undefined ? new FakeDevice() : setup.device;
  const h = createWorkerHost<FakeDevice>({
    post: (reply) => replies.push(reply),
    loadRelease: async () => loadedRelease(pipeline),
    wasmPaths: "/",
    voteDevice: async () => device,
    openStage: async (_loaded, _url, _device, manifestSha256) => (setup.open ? setup.open(manifestSha256) : { stage: fakeStage(), bytes: 1, note: null }),
    releaseDevice: (d) => (d.released += 1),
    readBitmap: () => FRAME,
    ...(setup.watchdog ? { watchdog: setup.watchdog } : {}),
  });
  let request = 0;
  const frame = async (t: number): Promise<FrameResult> => {
    const id = request++;
    await h.handle({ kind: "frame", bitmap: { width: 200, height: 150, close() {} } as ImageBitmap, videoTimeSec: t, envelope: { requestId: id, mediaTimeSec: t, generation: 0, videoKey: "v" } });
    return replies.filter((r): r is FrameResult => r.kind === "frame-result").find((r) => r.envelope.requestId === id)!;
  };
  const statuses = (): GeometricStatus[] => replies.filter((r): r is GeometricStatus => r.kind === "geometric-status");
  const load = (pin?: string, watchdog?: boolean) =>
    h.handle({
      kind: "load", releaseUrl: "https://x/release.json", geometricUrl: "https://x/geo.json",
      ...(pin ? { geometricManifestSha256: pin } : {}), ...(watchdog !== undefined ? { geometricWatchdog: watchdog } : {}),
    });
  return { h, replies, frame, statuses, load, device, pipeline };
}

/** What a pipeline without a stage gives for the same frame at the same time. */
async function withoutStage(t: number): Promise<string> {
  return JSON.stringify(await makePipeline().analyze(FRAME, t));
}

describe("the worker and the geometric stage", () => {
  it("without WebGPU the stage is off and frames are analyzed without it", async () => {
    const w = host({ device: null });
    await w.load();
    expect(w.statuses().map((s) => [s.state, s.reason])).toEqual([["loading", null], ["off", "no-webgpu"]]);
    const r = await w.frame(0);
    expect(JSON.stringify(r.analysis)).toBe(await withoutStage(0));
  });

  it("a part that fails to load turns the stage off, and frees the device", async () => {
    const w = host({ open: async () => { throw new Error("index: HTTP 404"); } });
    await w.load();
    expect(w.statuses().map((s) => [s.state, s.reason])).toEqual([["loading", null], ["off", "load-failed: index: HTTP 404"]]);
    expect(w.device!.released).toBe(1);
    expect(JSON.stringify((await w.frame(0)).analysis)).toBe(await withoutStage(0));
  });

  it("passes the pinned manifest SHA-256 on to the index loader", async () => {
    const seen: Array<string | undefined> = [];
    const w = host({ open: async (pin) => { seen.push(pin); throw new Error("the manifest's SHA-256 is not the pinned one"); } });
    await w.load("f".repeat(64));
    expect(seen).toEqual(["f".repeat(64)]);
    expect(w.statuses().at(-1)!.reason).toBe("load-failed: the manifest's SHA-256 is not the pinned one");
  });

  it("reports ready with the index's size and the OpenCV note", async () => {
    const w = host({ open: async () => ({ stage: fakeStage(), bytes: 1234, note: "built with OpenCV 4.9.0" }) });
    await w.load();
    expect(w.statuses().at(-1)).toEqual({ kind: "geometric-status", state: "ready", reason: null, bytes: 1234, note: "built with OpenCV 4.9.0" });
    const r = await w.frame(0);
    expect(r.analysis!.boxes[0]!.face!.topId).toBe("B");
    expect(r.analysis!.timings.geometricMs).toBeDefined();
  });

  it("a stage that throws during a frame is off for the session; that frame is answered exactly as without a stage", async () => {
    let fail = true;
    const stage = fakeStage(() => fail);
    const w = host({ open: async () => ({ stage, bytes: 1, note: null }) });
    await w.load();
    expect(w.statuses().at(-1)!.state).toBe("ready");
    const failed = await w.frame(0);
    expect(failed.error).toBeUndefined();
    expect(JSON.stringify(failed.analysis)).toBe(await withoutStage(0));
    expect(w.statuses().at(-1)).toEqual({ kind: "geometric-status", state: "off", reason: "runtime: boom", bytes: null });
    expect(stage.disposed).toBe(1);
    expect(w.pipeline.geometricStage).toBe(null);
    fail = false;
    const after = await w.frame(0.5);
    expect([after.analysis!.boxes[0]!.face!.topId, "geometricMs" in after.analysis!.timings]).toEqual(["A", false]);
    expect(w.statuses().filter((s) => s.state === "off").length).toBe(1);
  });

  it("a lost device turns the stage off and disposes of it; a destroyed one does not", async () => {
    const stage = fakeStage();
    const w = host({ open: async () => ({ stage, bytes: 1, note: null }) });
    await w.load();
    w.device!.lose({ reason: "unknown", message: "GPU reset" });
    await Promise.resolve();
    await Promise.resolve();
    expect(w.statuses().at(-1)!.reason).toBe("device-lost: GPU reset");
    expect(stage.disposed).toBe(1);
    expect(w.pipeline.geometricStage).toBe(null);
    expect((await w.frame(0)).analysis!.boxes[0]!.face!.topId).toBe("A");

    const other = fakeStage();
    const v = host({ open: async () => ({ stage: other, bytes: 1, note: null }) });
    await v.load();
    v.device!.lose({ reason: "destroyed", message: "" });
    await Promise.resolve();
    expect(v.statuses().at(-1)!.state).toBe("ready");
    expect(other.disposed).toBe(0);
  });

  it("the watchdog turns the stage off and disposes of it after the frame", async () => {
    const stage = fakeStage();
    const w = host({ open: async () => ({ stage, bytes: 1, note: null }), watchdog: new GeometricWatchdog(-1, 2) });
    await w.load();
    await w.frame(0);
    expect(stage.disposed).toBe(0);
    await w.frame(0.5);
    expect(w.statuses().at(-1)!.reason).toMatch(/^watchdog: /);
    expect(stage.disposed).toBe(1);
    expect(w.pipeline.geometricStage).toBe(null);
    expect("geometricMs" in (await w.frame(1)).analysis!.timings).toBe(false);
  });

  it("with the watchdog turned off by the load request, a slow stage stays on", async () => {
    const stage = fakeStage();
    const w = host({ open: async () => ({ stage, bytes: 1, note: null }), watchdog: new GeometricWatchdog(-1, 2) });
    await w.load(undefined, false);
    for (let t = 0; t < 4; t++) expect("geometricMs" in (await w.frame(t / 2)).analysis!.timings).toBe(true);
    expect(w.statuses().at(-1)!.state).toBe("ready");
    expect(stage.disposed).toBe(0);
  });

  it("a stage that loads while a frame is analyzed joins after that frame", async () => {
    let release!: () => void;
    let held = false;
    const gate = () => (held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve());
    let opened!: (value: { stage: GeometricStage; bytes: number; note: string | null }) => void;
    const stage = fakeStage();
    const w = host({ gate, open: () => new Promise((resolve) => (opened = resolve)) });
    const loading = w.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    held = true;
    const first = w.frame(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    opened({ stage, bytes: 1, note: null });
    await loading;
    expect(w.statuses().at(-1)!.state).toBe("ready");
    expect(w.pipeline.geometricStage).toBe(null);
    held = false;
    release();
    const r1 = await first;
    expect("geometric" in r1.analysis!.boxes[0]!.face!).toBe(false);
    expect(w.pipeline.geometricStage).toBe(stage);
    const r2 = await w.frame(0.5);
    expect(r2.analysis!.boxes[0]!.face!.topId).toBe("B");
  });
});

describe("a frame that arrives while another is analyzed", () => {
  it("is answered at once with the busy error, and the first is still answered with its analysis", async () => {
    let release!: () => void;
    let held = false;
    const gate = () => (held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve());
    const w = host({ gate, device: null });
    await w.load();
    held = true;
    const first = w.frame(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    held = false;
    const second = await w.frame(0);
    expect([second.error, second.analysis]).toEqual([BUSY_ERROR, null]);
    release();
    const r1 = await first;
    expect([r1.error, r1.analysis !== null]).toEqual([undefined, true]);
    expect((await w.frame(0)).error).toBeUndefined();
  });
});

describe("the progress of a load", () => {
  it("is passed on as release-progress replies, before the release-status", async () => {
    const replies: WorkerReply[] = [];
    const h = createWorkerHost<FakeDevice>({
      post: (reply) => replies.push(reply),
      loadRelease: async (_url, options) => {
        options.onProgress?.({ phase: "downloading", bytes: null });
        options.onProgress?.({ phase: "downloading", bytes: 12_000_000 });
        options.onProgress?.({ phase: "preparing" });
        return loadedRelease(makePipeline());
      },
      wasmPaths: "/",
      voteDevice: async () => null,
      openStage: async () => ({ stage: fakeStage(), bytes: 1, note: null }),
      releaseDevice: () => undefined,
      readBitmap: () => FRAME,
    });
    await h.handle({ kind: "load", releaseUrl: "/release.json" });
    expect(replies.map((reply) => reply.kind === "release-progress" ? [reply.phase, reply.bytes] : reply.kind)).toEqual([
      ["downloading", null], ["downloading", 12_000_000], ["preparing", null], "release-status",
    ]);
  });

  it("hands the loader the release's files when the page gives them, and nothing of the kind otherwise", async () => {
    const given: Array<[string, Record<string, Blob> | undefined]> = [];
    const make = () => createWorkerHost<FakeDevice>({
      post: () => undefined,
      loadRelease: async (url, options) => {
        given.push([url, options.files]);
        return loadedRelease(makePipeline());
      },
      wasmPaths: "/",
      voteDevice: async () => null,
      openStage: async () => ({ stage: fakeStage(), bytes: 1, note: null }),
      releaseDevice: () => undefined,
      readBitmap: () => FRAME,
    });
    const files = { "release.json": new Blob(["{}"]), "detector.onnx": new Blob(["d"]) };
    await make().handle({ kind: "load", releaseUrl: "release.json", files });
    await make().handle({ kind: "load", releaseUrl: "/release.json" });
    expect(given).toEqual([["release.json", files], ["/release.json", undefined]]);
    expect(given[0]![1]).toBe(files);
  });

  it("is taken by a session only while its release loads: a late reply after it loaded, failed or stopped changes nothing", async () => {
    const { progressUpdate } = await import("../src/session-core.js");
    const reply = { kind: "release-progress", phase: "preparing", bytes: null } as const;
    expect(progressUpdate("loading", reply)).toEqual({ phase: "preparing", bytes: null });
    expect(progressUpdate("loading", { ...reply, phase: "downloading", bytes: 12 })).toEqual({ phase: "downloading", bytes: 12 });
    for (const state of ["ready", "failed", "stopped"] as const) expect(progressUpdate(state, reply), state).toBeUndefined();
  });
});
