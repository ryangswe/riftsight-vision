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
  /** `ms` of play at `rate`, the video's time reported every 250 ms. */
  play(ms: number, rate?: number): void;
  /** `ms` of a paused or stalled video that is still reported every 250 ms, with no advance. */
  still(ms: number): void;
  /** `ms` with no report at all, the video standing (a stall with no `timeupdate`). */
  silent(ms: number): void;
  /** A seek `bySec` ahead: a discontinuity, then the new time reported. */
  seek(bySec: number): void;
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
  const report = (ms: number, perMs: number): void => {
    for (let left = ms; left > 0; left -= Math.min(250, left)) {
      const step = Math.min(250, left);
      now += step;
      media += step * perMs;
      core.presented(media);
    }
  };
  return {
    core,
    clock: () => now,
    look,
    captures,
    play: (ms, r = rate) => report(ms, r / 1000),
    still: (ms) => report(ms, 0),
    silent: (ms) => {
      now += ms;
    },
    seek: (bySec) => {
      core.discontinuity(false);
      media += bySec;
      core.presented(media);
    },
  };
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

  it("a host's playback rate shortens the lifetime, and the threshold in video time is B x rate", () => {
    const one = bench({ measuredPacing: true }, "webgpu", { playbackRate: () => 1.25, rate: 1.25 });
    for (let i = 0; i < 3; i++) one.look(200, 250);
    expect(budget(one)).toBe(800 * 1.25); // L 1600: L - R - M = 1100, capped by P 800
    const two = bench({ measuredPacing: true }, "webgpu", { playbackRate: () => 2, rate: 2 });
    for (let i = 0; i < 3; i++) two.look(400, 600);
    expect(budget(two)).toBe(500 * 2); // L 1000: L - R - M = 150, under F
  });

  it("at 0.75x, B (wall) is 1000 ms and the threshold is 750 ms of video: the look is not late", () => {
    const slow = bench({ measuredPacing: true }, "webgpu", { playbackRate: () => 0.75, rate: 0.75 });
    for (let i = 0; i < 3; i++) slow.look(400, 400);
    // L 2667: L - R - M = 2017, capped by P 1600; in video time 1600 x 0.75 = 1200.
    expect(budget(slow)).toBe(1_200);
  });

  it("without a host rate, the rate is measured from the reported video times: 2x makes the same B", () => {
    const measured = bench({ measuredPacing: true }, "webgpu", { rate: 2 });
    for (let i = 0; i < 3; i++) measured.look(1_000, 400);
    const given = bench({ measuredPacing: true }, "webgpu", { playbackRate: () => 2, rate: 2 });
    for (let i = 0; i < 3; i++) given.look(1_000, 400);
    expect(budget(measured)).toBe(budget(given));
    expect(budget(measured)).toBe(500 * 2); // L 1000 - 400 - 250 = 350, under F; in video time x 2
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

describe("the measured playback rate (no rate from the host or the messages) counts continuous play only", () => {
  /** Warm at 1x: W = 1000 ms, R = 400 ms, so B = min(4000, 2000 - 400 - 250) = 1350 ms. */
  const warm = (): Bench => {
    const b = bench({ measuredPacing: true });
    for (let i = 0; i < 3; i++) b.look(1_000, 400);
    b.play(3_000);
    expect(budget(b)).toBe(1_350);
    return b;
  };

  it.each([1_000, 20_000])("a pause of %i ms, reported without advance, leaves the rate at 1x", (ms) => {
    const b = warm();
    b.play(500);
    b.still(ms);
    for (let i = 0; i < 8; i++) {
      b.play(500);
      expect(budget(b), `${i}`).toBe(1_350);
    }
  });

  it("a stall with no reports for 1 s leaves the rate at 1x", () => {
    const b = warm();
    b.play(500);
    b.silent(1_000);
    for (let i = 0; i < 8; i++) {
      b.play(500);
      expect(budget(b), `${i}`).toBe(1_350);
    }
  });

  it("a seek ahead within a measure leaves the rate at 1x (a new generation starts the measure over)", () => {
    const b = warm();
    b.play(1_000);
    b.seek(30);
    for (let i = 0; i < 8; i++) {
      b.play(500);
      expect(budget(b), `${i}`).toBe(1_350);
    }
  });

  it("a crawl far under the least rate is dropped, not taken as a rate", () => {
    const b = warm();
    b.still(500);
    b.play(3_000, 0.0004);
    expect(budget(b)).toBe(1_350);
  });

  it("a real change of rate over continuous play is taken", () => {
    const b = warm();
    b.play(4_500, 2);
    expect(budget(b)).toBe(1_000); // L 1000 - 400 - 250 < F: B = 500 ms of wall, 1000 ms of video
  });

  it("a rate the pointer or presented report carries is taken at once", () => {
    const b = warm();
    b.core.presented(1_000, 2);
    expect(budget(b)).toBe(1_000);
    b.core.pointer(0.5, 0.5, 1_000.1, false, 1);
    expect(budget(b)).toBe(1_350);
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
