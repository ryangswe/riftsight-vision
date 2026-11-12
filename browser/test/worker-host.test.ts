// SPDX-License-Identifier: Apache-2.0
// The worker's handling of the geometric stage (worker-host.ts), with a real pipeline on fake
// models and fake stages: off without WebGPU or when a part fails to load, off for the session
// when it fails during a frame (that frame answered exactly as without a stage), when its
// device is lost and when the watchdog trips, and a stage that loads during a frame joining
// after it; the stage asked for on its own request, and a compute frame that asks for it at the
// first pointer.

import { describe, expect, it, vi } from "vitest";

import { rectOf } from "../src/boxes.js";
import type { FrameDetector } from "../src/detector/detector.js";
import { GeometricWatchdog, type GeometricStage } from "../src/geometric/stage.js";
import type { LoadedRelease } from "../src/load.js";
import { startComputeFrame, type ComputeFrameEnv } from "../src/compute-frame.js";
import { computeProtocol } from "../src/compute-messages.js";
import { BUSY_ERROR, type FrameResult, type GeometricStatus, type WorkerReply, type WorkerRequest } from "../src/messages.js";
import { Pipeline } from "../src/pipeline.js";
import { createWorkerHost, type VoteDevice } from "../src/worker-host.js";
import type { WorkerLike } from "../src/worker-session.js";
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

  it("passes the load's timings on in the release-status, and says nothing of them when the loader has none", async () => {
    const timings = { startedAtMs: 900, filesMs: 40, readMs: 10, recognizer: { createMs: 300, firstRunMs: 700, failedProvidersMs: 0, totalMs: 1000 }, detector: { createMs: 100, firstRunMs: 200, failedProvidersMs: 0, totalMs: 300 }, totalMs: 1350 };
    const statusOf = async (withTimings: boolean) => {
      const replies: WorkerReply[] = [];
      const h = createWorkerHost<FakeDevice>({
        post: (reply) => replies.push(reply),
        loadRelease: async () => (withTimings ? { ...loadedRelease(makePipeline()), timings } : loadedRelease(makePipeline())),
        wasmPaths: "/",
        voteDevice: async () => null,
        openStage: async () => ({ stage: fakeStage(), bytes: 1, note: null }),
        releaseDevice: () => undefined,
        readBitmap: () => FRAME,
      });
      await h.handle({ kind: "load", releaseUrl: "/release.json" });
      const status = replies.find((reply) => reply.kind === "release-status");
      return status?.kind === "release-status" ? status.release : null;
    };
    expect((await statusOf(true))?.loadTimings).toEqual(timings);
    const without = await statusOf(false);
    expect(without).not.toBeNull();
    expect(without && "loadTimings" in without).toBe(false);
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

describe("the frame request's geometric scope", () => {
  const request = (extra: object) => ({ kind: "frame" as const, bitmap: { width: 200, height: 150, close() {} } as ImageBitmap, videoTimeSec: 0, envelope: { requestId: 1, mediaTimeSec: 0, generation: 0, videoKey: "v" }, ...extra });

  it("gives the pipeline the scope and the focus, and neither when the request has none", async () => {
    const w = host({});
    await w.load();
    const analyze = vi.spyOn(w.pipeline, "analyze");
    await w.h.handle(request({ geometricScope: "focus", focus: { x: 30, y: 40 } }));
    expect(analyze.mock.calls[0]![2]).toMatchObject({ geometricScope: "focus", focus: { x: 30, y: 40 } });
    await w.h.handle(request({ geometricScope: "focus", focus: null }));
    expect(analyze.mock.calls[1]![2]).toMatchObject({ geometricScope: "focus", focus: null });
    await w.h.handle(request({}));
    expect(Object.keys(analyze.mock.calls[2]![2]!)).toEqual([]);
  });
});

describe("the frame request's reuseOf", () => {
  const send = async (w: ReturnType<typeof host>, id: number, t: number, reuseOf?: number): Promise<FrameResult> => {
    await w.h.handle({
      kind: "frame", bitmap: { width: 200, height: 150, close() {} } as ImageBitmap, videoTimeSec: t,
      envelope: { requestId: id, mediaTimeSec: t, generation: 0, videoKey: "v" }, ...(reuseOf !== undefined ? { reuseOf } : {}),
    });
    return w.replies.filter((r): r is FrameResult => r.kind === "frame-result").find((r) => r.envelope.requestId === id)!;
  };
  const strip = (a: FrameResult["analysis"]) => JSON.stringify({ ...a, tracks: null, timings: null, reused: null, retried: null, embeddings: null, discontinuity: null });

  it("feeds the newest analyzed frame to the tracker and the gate again: the same analysis but tracks and timings, marked reused", async () => {
    const detector = vi.fn();
    const w = host({ gate: async () => detector() });
    await w.load();
    const first = await send(w, 1, 5);
    expect(first.analysis?.reused).toBeUndefined();
    expect(first.analysis?.tracks.shown).toBe(false);
    const second = await send(w, 2, 5, 1);
    const third = await send(w, 3, 5, 1); // the repeats name the analyzed frame, not each other
    expect(detector).toHaveBeenCalledTimes(1); // no detector, recognizer or stage ran for the reuses
    expect(second.analysis?.reused).toBe(true);
    expect(third.analysis?.reused).toBe(true);
    expect(strip(second.analysis)).toBe(strip(first.analysis));
    expect(strip(third.analysis)).toBe(strip(first.analysis));
    expect([first, second, third].map((r) => r.analysis!.tracks.shown)).toEqual([false, false, true]); // the gate counted three frames
  });

  it("is refused, and the picture analyzed, when it names another frame, or the pipeline was reset", async () => {
    const detector = vi.fn();
    const w = host({ gate: async () => detector() });
    await w.load();
    await send(w, 1, 5);
    const wrong = await send(w, 2, 5, 99);
    expect(wrong.analysis?.reused).toBeUndefined();
    expect(detector).toHaveBeenCalledTimes(2);
    w.pipeline.reset(); // a seek's discontinuity resets the pipeline
    const afterReset = await send(w, 3, 5, 2);
    expect(afterReset.analysis?.reused).toBeUndefined();
    expect(detector).toHaveBeenCalledTimes(3);
    const again = await send(w, 4, 5, 3);
    expect(again.analysis?.reused).toBe(true);
    expect(detector).toHaveBeenCalledTimes(3);
  });

  it("is refused after the geometric stage joined: the picture is analyzed with it", async () => {
    const w = host({});
    await w.h.handle({ kind: "load", releaseUrl: "https://x/release.json" }); // no stage requested
    await send(w, 1, 5);
    w.pipeline.setGeometric(fakeStage()); // what the worker does when a loaded stage joins between frames
    const joined = await send(w, 2, 5, 1);
    expect(joined.analysis?.reused).toBeUndefined();
    expect(joined.analysis?.timings.geometricMs).toBeDefined();
  });

  it("reports no work for a reuse: retried and embeddings 0, no discontinuity, the rest copied", async () => {
    const w = host({});
    await w.h.handle({ kind: "load", releaseUrl: "https://x/release.json" });
    const first = await send(w, 1, 5);
    expect(first.analysis!.embeddings).toBeGreaterThan(0);
    const again = await send(w, 2, 5, 1);
    expect(again.analysis).toMatchObject({ reused: true, retried: 0, embeddings: 0, discontinuity: false });
    expect(again.analysis!.timings).toMatchObject({ detectorMs: 0, recognizeMs: 0 });
    expect(again.analysis!.boxes).toEqual(first.analysis!.boxes);
  });

  it("is refused after the stage joined through the load (the worker's own path)", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    const w = host({ open: async () => { await opened; return { stage: fakeStage(), bytes: 1, note: null }; } });
    const loading = w.load(); // the release is up, the stage is still loading
    await new Promise((r) => setTimeout(r, 0));
    const first = await send(w, 1, 5);
    expect(first.analysis?.timings.geometricMs).toBeUndefined();
    open();
    await loading; // the stage joins between frames
    const second = await send(w, 2, 5, 1);
    expect(second.analysis?.reused).toBeUndefined();
    expect(second.analysis?.timings.geometricMs).toBeDefined();
  });

  it("is refused after a failed analysis: the failed frame left the pipeline's state moved", async () => {
    let calls = 0;
    const w = host({ gate: async () => { calls += 1; if (calls === 2) throw new Error("boom"); } });
    await w.h.handle({ kind: "load", releaseUrl: "https://x/release.json" });
    await send(w, 1, 5);
    const failed = await send(w, 2, 6);
    expect(failed.error).toMatch(/analysis-failed/);
    const next = await send(w, 3, 6, 1); // names the frame before the failure
    expect(next.analysis?.reused).toBeUndefined();
    expect(next.analysis).not.toBeNull();
  });

  it("is refused after the tilted retry was set or removed", async () => {
    const w = host({});
    await w.h.handle({ kind: "load", releaseUrl: "https://x/release.json" });
    await send(w, 1, 5);
    w.pipeline.setTiltedRetry(null); // what turnTiltedOff does after a failure or a watchdog trip
    const next = await send(w, 2, 5, 1);
    expect(next.analysis?.reused).toBeUndefined();
  });
});

describe("Pipeline.reuse after a stage failed on the frame", () => {
  it("returns null: the frame's answers are the fallback's, not the stage's", async () => {
    const pipeline = makePipeline();
    pipeline.setGeometric(fakeStage(() => true));
    await pipeline.analyze(FRAME, 5);
    expect(pipeline.takeGeometricFailure()).not.toBeNull();
    expect(pipeline.reuse(5)).toBeNull();
    pipeline.setGeometric(null);
    await pipeline.analyze(FRAME, 5);
    expect(pipeline.reuse(5)?.reused).toBe(true);
  });
});

describe("the geometric stage on its own request (load-stage)", () => {
  /** A host whose index loader counts its calls. */
  function counted(over: Setup = {}) {
    const pins: Array<string | undefined> = [];
    const w = host({ ...over, open: (pin) => (pins.push(pin), over.open ? over.open(pin) : Promise.resolve({ stage: fakeStage(), bytes: 1, note: null })) });
    const loadPlain = (watchdog?: boolean) => w.h.handle({ kind: "load", releaseUrl: "https://x/release.json", ...(watchdog !== undefined ? { geometricWatchdog: watchdog } : {}) });
    const loadStage = (pin?: string) => w.h.handle({ kind: "load-stage", geometricUrl: "https://x/geo.json", ...(pin ? { geometricManifestSha256: pin } : {}) });
    return { ...w, pins, loadPlain, loadStage };
  }

  it("a release loaded without the stage opens no index; load-stage opens it once, and the stage joins", async () => {
    const w = counted();
    await w.loadPlain();
    expect(w.pins).toEqual([]);
    expect(w.statuses()).toEqual([]);
    expect(JSON.stringify((await w.frame(0)).analysis)).toBe(await withoutStage(0));
    await w.loadStage("f".repeat(64));
    expect(w.pins).toEqual(["f".repeat(64)]);
    expect(w.statuses().map((s) => s.state)).toEqual(["loading", "ready"]);
    expect((await w.frame(0.5)).analysis!.boxes[0]!.face!.topId).toBe("B");
    await w.loadStage();
    expect(w.pins).toHaveLength(1);
    expect(w.statuses()).toHaveLength(2);
  });

  it("is ignored before the release has loaded, after a load that carried the stage, and once the stage is off", async () => {
    const early = counted();
    await early.loadStage();
    expect([early.pins.length, early.statuses().length]).toEqual([0, 0]);

    const carried = counted();
    await carried.load();
    await carried.loadStage();
    expect(carried.pins).toHaveLength(1);
    expect(carried.statuses().map((s) => s.state)).toEqual(["loading", "ready"]);

    const off = counted({ device: null });
    await off.loadPlain();
    await off.loadStage();
    await off.loadStage();
    expect(off.statuses().map((s) => [s.state, s.reason])).toEqual([["loading", null], ["off", "no-webgpu"]]);
  });

  it("a frame in flight when it arrives is answered without the stage; the stage joins after that frame", async () => {
    let release!: () => void;
    let held = false;
    const gate = () => (held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve());
    const stage = fakeStage();
    const w = counted({ gate, open: async () => ({ stage, bytes: 1, note: null }) });
    await w.loadPlain();
    held = true;
    const first = w.frame(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await w.loadStage();
    expect(w.statuses().at(-1)!.state).toBe("ready");
    expect(w.pipeline.geometricStage).toBe(null);
    held = false;
    release();
    const r1 = await first;
    expect(r1.error).toBeUndefined();
    expect(JSON.stringify(r1.analysis)).toBe(await withoutStage(0));
    expect(w.pipeline.geometricStage).toBe(stage);
    expect((await w.frame(0.5)).analysis!.boxes[0]!.face!.topId).toBe("B");
  });

  it("the load's watchdog setting applies: on by default, off when the load turned it off", async () => {
    const on = counted({ watchdog: new GeometricWatchdog(-1, 2) });
    await on.loadPlain();
    await on.loadStage();
    await on.frame(0);
    await on.frame(0.5);
    expect(on.statuses().at(-1)!.reason).toMatch(/^watchdog: /);

    const offByLoad = counted({ watchdog: new GeometricWatchdog(-1, 2) });
    await offByLoad.loadPlain(false);
    await offByLoad.loadStage();
    for (let t = 0; t < 4; t++) expect("geometricMs" in (await offByLoad.frame(t / 2)).analysis!.timings).toBe(true);
    expect(offByLoad.statuses().at(-1)!.state).toBe("ready");
  });
});

describe("a compute frame on a worker host", () => {
  const SITE = "https://video.example";
  const protocol = computeProtocol("example");

  /** A compute frame whose workers are worker hosts on fake models; counts the index loads. */
  function frameOnHost(over: Partial<ComputeFrameEnv>) {
    let opens = 0;
    class HostWorker implements WorkerLike {
      onmessage: WorkerLike["onmessage"] = null;
      onerror: WorkerLike["onerror"] = null;
      readonly host = createWorkerHost<FakeDevice>({
        post: (reply) => this.onmessage?.({ data: reply } as MessageEvent<WorkerReply>),
        loadRelease: async () => loadedRelease(makePipeline()),
        wasmPaths: "/",
        voteDevice: async () => new FakeDevice(),
        openStage: async () => (opens++, { stage: fakeStage(), bytes: 1, note: null }),
        releaseDevice: () => {},
        readBitmap: () => FRAME,
      });
      postMessage(message: WorkerRequest) {
        void this.host.handle(message);
      }
      terminate() {}
    }
    const parent = { postMessage: () => {} };
    let listener: ((event: MessageEvent) => void) | null = null;
    const clock = { now: 1_000 };
    const frame = startComputeFrame({
      win: { parent, addEventListener: (_: "message", l: (event: MessageEvent) => void) => void (listener = l), removeEventListener: () => void (listener = null) },
      framed: true,
      parentOrigin: SITE,
      allowedParentOrigin: (origin) => origin === SITE,
      protocol,
      createWorker: () => new HostWorker(),
      loadRequest: { kind: "load", releaseUrl: "https://x/release.json", geometricUrl: "https://x/geo.json" },
      now: () => clock.now,
      ...over,
    })!;
    const pointer = () => listener?.({ data: protocol.tag({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false }), source: parent, origin: SITE } as unknown as MessageEvent);
    const settle = async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { frame, pointer, settle, clock, opens: () => opens };
  }

  it("with \"pointer\", opens no index before the first pointer once ready, and one after it", async () => {
    const f = frameOnHost({ geometricLoad: "pointer" });
    f.pointer();
    await f.settle();
    expect(f.frame.state).toBe("ready");
    for (let i = 0; i < 8; i++) {
      f.clock.now += 250;
      f.frame.tick();
    }
    await f.settle();
    expect(f.opens()).toBe(0);
    expect(f.frame.core!.status().geometric).toBe(null);
    f.pointer();
    await f.settle();
    expect(f.opens()).toBe(1);
    expect(f.frame.core!.status().geometric).toMatchObject({ state: "ready" });
    f.pointer();
    await f.settle();
    expect(f.opens()).toBe(1);
  });

  it("by default opens the index with the release, before any pointer", async () => {
    const f = frameOnHost({});
    await f.settle();
    expect(f.opens()).toBe(1);
    expect(f.frame.core!.status().geometric).toMatchObject({ state: "ready" });
  });
});
