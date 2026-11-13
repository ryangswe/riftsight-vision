// SPDX-License-Identifier: Apache-2.0
// Budgeted pacing (session-core.ts `applyCadence`): the stale-picture look starts within the
// answer's lifetime (B = max(F, min(P, L - R - M))), the looks a viewer waits on are not paced,
// the shown hold's reading wait comes before the card's hold runs out, and no look starts while a
// retry waits out its back-off. A core on a made-up clock; nothing here reaches a network.
import { describe, expect, it } from "vitest";

import { FrameScheduler, LOOK_RETRY_MS, STALE_FRAME_MS } from "../src/frame-scheduler.js";
import type { FrameResult, ReleaseStatus, WorkerRequest } from "../src/messages.js";
import type { FrameAnalysis } from "../src/pipeline.js";
import { SessionCore, type SessionCoreDeps, type SessionCoreOptions } from "../src/session-core.js";

const release = (ep: "webgpu" | "wasm") =>
  ({ id: "r", recognizer: { version: "r", ep }, detector: { version: "d", ep }, hoverMaxAgeMs: 2000, analysisWidth: { min: 720, max: 1920 } }) as unknown as NonNullable<ReleaseStatus["release"]>;
const analysis = { frame: { width: 1000, height: 500 }, hover: { selection: "accepted-nms", cards: [] }, boxes: [] } as unknown as FrameAnalysis;
const bitmap = () => ({ width: 1000, height: 500, close() {} }) as unknown as ImageBitmap;
const nothing = () => ({ card: null, boxIndex: null, box: null, cardId: null, name: null });

interface Bench {
  core: SessionCore;
  clock: () => number;
  /** One look: the clock moves 5 s (the video with it, at `rate`), a move asks a look on a stale
   *  picture, its picture arrives, and the worker answers `workerMs` after the ask (the round trip). */
  look(workerMs: number, roundTripMs?: number): void;
  captures: number[];
}

function bench(options: SessionCoreOptions, ep: "webgpu" | "wasm" = "webgpu", deps: Partial<Pick<SessionCoreDeps, "playbackRate">> & { rate?: number } = {}): Bench {
  let now = 1_000;
  const rate = deps.rate ?? 1;
  let media = 100;
  const requests: WorkerRequest[] = [];
  const captures: number[] = [];
  let lastRequestId = 0;
  const core = new SessionCore(
    {
      now: () => now,
      toWorker: (r) => void requests.push(r),
      capture: (requestId) => {
        captures.push(now);
        lastRequestId = requestId;
      },
      hoverAt: nothing as never,
      ...(deps.playbackRate ? { playbackRate: deps.playbackRate } : {}),
    },
    { mode: "pointer", entryLook: true, ...options },
  );
  core.fromWorker({ kind: "release-status", ok: true, error: null, release: release(ep), cards: [] });
  const advance = (ms: number) => {
    // The video's time is reported every 250 ms, as a content script's `timeupdate` would.
    for (let left = ms; left > 0; left -= Math.min(250, left)) {
      const step = Math.min(250, left);
      now += step;
      media += (step * rate) / 1000;
      core.presented(media);
    }
  };
  const look = (workerMs: number, roundTripMs = workerMs): void => {
    advance(5_000);
    const n = captures.length;
    core.pointer(0.5 + (captures.length % 2) * 0.01, 0.5, media);
    if (captures.length === n) throw new Error("no look was asked");
    const request = (): Extract<WorkerRequest, { kind: "frame" }> => requests.at(-1) as Extract<WorkerRequest, { kind: "frame" }>;
    const before = requests.length;
    core.frame(lastRequestId, bitmap(), media);
    if (requests.length === before) throw new Error("the picture was not sent");
    now += roundTripMs;
    const r = request();
    const reply: FrameResult = { kind: "frame-result", envelope: r.envelope, videoTimeSec: r.videoTimeSec, width: 1000, height: 500, workerMs, analysis };
    core.fromWorker(reply);
  };
  return { core, clock: () => now, look, captures };
}

/** B as the scheduler holds it: the stale-frame threshold before its 400 ms floor. */
const budget = (r: Bench): number => r.core.scheduler.staleFrameMs(r.clock());

describe("the stale-picture budget B = max(F, min(P, L - R - M)) (S-C5, S-P5)", () => {
  it("WebGPU, W = 800 ms (P 3200), R = 850 ms, 1x: B is 900 ms", () => {
    const r = bench({ measuredPacing: true });
    for (let i = 0; i < 3; i++) r.look(800, 850);
    expect(budget(r)).toBe(900);
  });

  it("W = 200 ms, R = 250 ms: P (800 ms) caps it", () => {
    const r = bench({ measuredPacing: true });
    for (let i = 0; i < 3; i++) r.look(200, 250);
    expect(budget(r)).toBe(800);
  });

  it("WebAssembly, W = 800 ms, R = 900 ms: L - R - M (850 ms) is under F, so B is F (1000 ms)", () => {
    const r = bench({ measuredPacing: true }, "wasm");
    for (let i = 0; i < 3; i++) r.look(800, 900);
    expect(budget(r)).toBe(1_000);
  });

  it("warm-up: F until a round trip is known and 3 looks are measured", () => {
    const r = bench({ measuredPacing: true });
    expect(budget(r)).toBe(500);
    r.look(800, 850);
    expect(budget(r)).toBe(500);
    r.look(800, 850);
    expect(budget(r)).toBe(500);
    r.look(800, 850);
    expect(budget(r)).toBe(900);
  });

  it("pacing off: P is F, so B is F, whatever the round trip", () => {
    const r = bench({});
    for (let i = 0; i < 4; i++) r.look(100, 100);
    expect(budget(r)).toBe(500);
  });

  it("saturation: B is never above P (4000 ms at most)", () => {
    const r = bench({ measuredPacing: true });
    for (let i = 0; i < 3; i++) r.look(2_000, 100);
    expect(budget(r)).toBe(1_650); // P = 4000, L - R - M = 1650
    const capped = bench({ measuredPacing: true });
    for (let i = 0; i < 3; i++) capped.look(300, 100);
    expect(budget(capped)).toBe(1_200); // P = 1200 < 1650
  });

  it("the 400 ms floor of the threshold stays", () => {
    const s = new FrameScheduler(500, 3, "pointer");
    s.setStaleBudgetMs(100);
    expect(s.staleFrameMs(0)).toBe(STALE_FRAME_MS);
  });

  it("a host's playback rate shortens the lifetime: at 2x, W = 200 ms and R = 250 ms give B = F", () => {
    const one = bench({ measuredPacing: true }, "webgpu", { playbackRate: () => 1.25, rate: 1.25 });
    for (let i = 0; i < 3; i++) one.look(200, 250);
    expect(budget(one)).toBe(800); // L 1600: L - R - M = 1100, capped by P 800
    const two = bench({ measuredPacing: true }, "webgpu", { playbackRate: () => 2, rate: 2 });
    for (let i = 0; i < 3; i++) two.look(400, 600);
    expect(budget(two)).toBe(500); // L 1000: L - R - M = 150, under F
  });

  it("without a host rate, the rate is measured from the reported video times: 2x makes the same B", () => {
    const measured = bench({ measuredPacing: true }, "webgpu", { rate: 2 });
    for (let i = 0; i < 3; i++) measured.look(1_000, 400);
    const given = bench({ measuredPacing: true }, "webgpu", { playbackRate: () => 2, rate: 2 });
    for (let i = 0; i < 3; i++) given.look(1_000, 400);
    expect(budget(measured)).toBe(budget(given));
    expect(budget(measured)).toBe(500); // L 1000 - 400 - 250 = 350, under F
    const normal = bench({ measuredPacing: true }, "webgpu", { rate: 1 });
    for (let i = 0; i < 3; i++) normal.look(1_000, 400);
    expect(budget(normal)).toBe(1_350);
  });

  it("always-on mode keeps the cadence in effect as its threshold: it stays paced", () => {
    let now = 0;
    const core = new SessionCore({ now: () => now, toWorker: () => {}, capture: () => {}, hoverAt: nothing as never }, { mode: "always-on", measuredPacing: true });
    core.fromWorker({ kind: "release-status", ok: true, error: null, release: release("webgpu"), cards: [] });
    now = 10;
    expect(core.scheduler.staleFrameMs(now)).toBe(core.scheduler.intervalInEffectMs(now));
  });
});

describe("the back-off holds on every path (S-C11)", () => {
  /** A scheduler with a retry due at 750 ms: a look started at 0 and came back busy at 500 ms. */
  const waiting = () => {
    const s = new FrameScheduler(500, 3, "pointer");
    s.pointerMoved(0);
    s.framePresented();
    s.started(0, { videoTimeSec: 0 });
    s.lookUnanswered(500);
    s.lookUnanswered(500); // the second in a row: 500 ms of back-off, due at 1000
    return s;
  };

  it("the cadence on a playing video: a newly presented frame waits for the retry", () => {
    const s = waiting();
    s.framePresented();
    expect(s.due(900)).toBe(false);
    expect(s.due(1_000)).toBe(true);
  });

  it("a pointer move over a stale picture never shortens it", () => {
    const s = waiting();
    s.pointerMoved(900);
    expect(s.hoverTriggerDue(900, 10, false)).toBe(false);
    expect(s.hoverTriggerDue(1_000, 10, false)).toBe(true);
  });

  it("a cut waits for it", () => {
    const s = waiting();
    s.requestLook();
    expect(s.due(900)).toBe(false);
    expect(s.due(1_000)).toBe(true);
  });

  it("a load that ends waits for it", () => {
    const s = waiting();
    expect(s.loadEndDue(900)).toBe(false);
    expect(s.loadEndDue(1_000)).toBe(true);
  });

  it("the playing relook waits for it", () => {
    const s = waiting();
    s.setRelookSpacingMs(250);
    s.framePresented();
    expect(s.relookDue(900, false, 5)).toBe(false);
  });

  it("a prompt retry is due when its back-off runs out, and not before", () => {
    const s = new FrameScheduler(500, 3, "pointer");
    s.pointerMoved(0);
    s.framePresented();
    s.started(0);
    s.lookUnanswered(100, { prompt: true });
    expect(s.due(100 + LOOK_RETRY_MS[0]! - 1)).toBe(false);
    expect(s.due(100 + LOOK_RETRY_MS[0]!)).toBe(true);
  });

  it("a seek drops the retry with its picture", () => {
    const s = waiting();
    s.discontinuity();
    expect(s.retryWaiting(900)).toBe(false);
    expect(s.hoverTriggerDue(900, 10, false)).toBe(true);
  });

  it("in a session, a cut while a retry waits asks nothing until the retry is due", () => {
    let now = 0;
    const captures: number[] = [];
    const requests: WorkerRequest[] = [];
    const core = new SessionCore({ now: () => now, toWorker: (r) => void requests.push(r), capture: () => void captures.push(now), hoverAt: nothing as never }, { entryLook: true });
    core.fromWorker({ kind: "release-status", ok: true, error: null, release: release("webgpu"), cards: [] });
    core.pointer(0.5, 0.5, 1);
    expect(captures).toEqual([0]);
    now = 100;
    core.captureFailed(1, "no picture yet", true); // a prompt retry due at 350
    now = 200;
    core.cut();
    core.tick();
    expect(captures).toEqual([0]);
    now = 350;
    core.tick();
    expect(captures).toEqual([0, 350]);
  });
});

describe("the looks a viewer waits on are not paced (S-P2)", () => {
  it("a load that ends under an active pointer asks at once, where the paced wait is 3200 ms", () => {
    const r = bench({ measuredPacing: true });
    for (let i = 0; i < 3; i++) r.look(800, 800);
    expect(r.core.scheduler.intervalInEffectMs(r.clock())).toBe(3_200);
    r.core.pointer(0.5, 0.5, 200);
    r.core.workerStopped({ restart: true });
    const n = r.captures.length;
    r.core.fromWorker({ kind: "release-status", ok: true, error: null, release: release("webgpu"), cards: [] });
    expect(r.captures.length).toBe(n + 1);
    expect(r.captures.at(-1)).toBe(r.clock());
  });

  it("a load with a pointer that left asks nothing", () => {
    const r = bench({ measuredPacing: true });
    r.look(800, 800);
    r.core.pointerLeft();
    r.core.workerStopped({ restart: true });
    const n = r.captures.length;
    r.core.fromWorker({ kind: "release-status", ok: true, error: null, release: release("webgpu"), cards: [] });
    expect(r.captures.length).toBe(n);
  });
});
