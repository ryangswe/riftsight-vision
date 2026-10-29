// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { activeAnalyzeIntervalMs, analyzeIntervalMs, cadenceMs, isSlowDevice } from "../src/cadence.js";
import {
  ANALYSIS_WATCHDOG_MS,
  type AnalysisState,
  DRIVER_TICK_MS,
  FrameScheduler,
  HOVER_MAX_AGE_MS,
  HOVER_TRIGGER_MIN_GAP_MS,
  type LiveTemporalState,
  LOOK_RETRY_MS,
  POINTER_GRACE_MS,
  READING_LINGER_MS,
  rejectionAnswersInFlight,
  REPEAT_INTERVAL_MS,
  replyRejection,
  STALE_FRAME_MS,
} from "../src/frame-scheduler.js";
import type { FrameEnvelope } from "../src/messages.js";
import { CONFIRM_FRAMES } from "../src/temporal-gate.js";

/** Drive a scheduler as a session does: a tick every DRIVER_TICK_MS, frames presented as told. */
function run(s: FrameScheduler, untilMs: number, presentedAt: (t: number) => boolean, fromMs = 0): number[] {
  const starts: number[] = [];
  for (let t = fromMs; t <= untilMs; t += DRIVER_TICK_MS) {
    for (let f = Math.max(0, t - DRIVER_TICK_MS + 1); f <= t; f += 1) if (presentedAt(f)) s.framePresented();
    if (s.due(t)) {
      s.started(t);
      starts.push(t);
    }
  }
  return starts;
}

const playing = (): boolean => true;
const pointerScheduler = (ep: "webgpu" | "wasm" | null = "webgpu"): FrameScheduler =>
  new FrameScheduler(cadenceMs(ep, "pointer"), CONFIRM_FRAMES, "pointer", analyzeIntervalMs(ep));

describe("cadence", () => {
  it("the slow cadence is one analysis a second on WebGPU and one every two seconds on WebAssembly", () => {
    expect([analyzeIntervalMs("webgpu"), analyzeIntervalMs("wasm"), analyzeIntervalMs(null)]).toEqual([1000, 2000, 1000]);
  });

  it("the fast cadence is twice that", () => {
    expect([activeAnalyzeIntervalMs("webgpu"), activeAnalyzeIntervalMs("wasm"), activeAnalyzeIntervalMs(null)]).toEqual([500, 1000, 500]);
  });

  it("pointer mode is armed with the fast cadence, always-on with the slow one", () => {
    expect([cadenceMs("webgpu", "pointer"), cadenceMs("wasm", "pointer"), cadenceMs("webgpu", "always-on"), cadenceMs("wasm", "always-on")]).toEqual([500, 1000, 1000, 2000]);
    expect([isSlowDevice("wasm"), isSlowDevice("webgpu"), isSlowDevice(null)]).toEqual([true, false, false]);
  });
});

describe("FrameScheduler on the cadence alone", () => {
  it("a playing video is analyzed at the cadence, never faster, with no repeats", () => {
    expect(run(new FrameScheduler(1000), 5000, playing)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    expect(run(new FrameScheduler(2000), 6000, playing)).toEqual([0, 2000, 4000, 6000]);
  });

  it("a paused video presents nothing and costs nothing", () => {
    const s = new FrameScheduler(1000);
    expect(run(s, 5000, () => false)).toEqual([]);
    expect(s.idle).toBe(true);
    expect([s.lastTrigger, s.msSinceLastAnalysis(100)]).toEqual([null, null]);
  });

  it("one presented frame is analyzed three times at the repeat spacing, then nothing", () => {
    const s = new FrameScheduler(1000);
    expect(run(s, 5000, (t) => t === 1000)).toEqual([1000, 1000 + REPEAT_INTERVAL_MS, 1000 + 2 * REPEAT_INTERVAL_MS]);
    expect(s.idle).toBe(true);
    expect(s.lastTrigger).toBe("repeat");
  });

  it("a newer frame during the repeats starts again and still respects the cadence", () => {
    const s = new FrameScheduler(1000);
    expect(run(s, 5000, (t) => t === 1000 || t === 1300)).toEqual([1000, 1250, 2250, 2500, 2750]);
  });

  it("a change of cadence applies to the next presented frame", () => {
    const s = new FrameScheduler(1000);
    expect(run(s, 2000, playing)).toEqual([0, 1000, 2000]);
    s.setIntervalMs(2000);
    expect(run(s, 8000, playing, 2250)).toEqual([4000, 6000, 8000]);
  });

  it("always-on mode needs no pointer, and switching modes gates and ungates analysis", () => {
    const s = new FrameScheduler(1000, CONFIRM_FRAMES, "always-on");
    expect([s.analysisMode, s.analysisState(0), s.analysisActive(0)]).toEqual(["always-on", "always-on", true]);
    s.setMode("pointer");
    expect(run(s, 3000, playing)).toEqual([]);
    s.setMode("always-on");
    expect(run(s, 5000, playing, 3250)).toEqual([3250, 4250]);
  });
});

describe("FrameScheduler in pointer mode", () => {
  it("without pointer activity nothing is analyzed, even while the video plays", () => {
    const s = pointerScheduler();
    expect(run(s, 5000, playing)).toEqual([]);
    expect(s.analysisState(5000)).toBe("idle");
  });

  it("pointer activity runs the fast cadence: 500 ms on WebGPU, 1 s on WebAssembly", () => {
    const gpu = pointerScheduler("webgpu");
    gpu.pointerMoved(0);
    expect(run(gpu, 2000, playing)).toEqual([0, 500, 1000, 1500, 2000]);
    const wasm = pointerScheduler("wasm");
    wasm.pointerMoved(0);
    expect(run(wasm, 3000, playing)).toEqual([0, 1000, 2000, 3000]);
  });

  it("keeps analyzing for the grace period after the pointer left, then stops", () => {
    const s = pointerScheduler();
    s.pointerMoved(0);
    s.pointerLeft(1000);
    const starts = run(s, 20_000, playing);
    expect(starts[0]).toBe(0);
    expect(Math.max(...starts)).toBe(1000 + POINTER_GRACE_MS - 500);
    expect([s.analysisState(1000 + POINTER_GRACE_MS - 1), s.analysisState(1000 + POINTER_GRACE_MS)]).toEqual(["fast", "idle"]);
  });

  it("the pointer coming back, or a tap, starts analysis again at once", () => {
    const s = pointerScheduler();
    s.pointerMoved(0);
    expect(s.analysisActive(POINTER_GRACE_MS + 5000)).toBe(false);
    s.pointerMoved(POINTER_GRACE_MS + 5000);
    expect(s.analysisState(POINTER_GRACE_MS + 5000)).toBe("fast");
    const touch = pointerScheduler();
    touch.tapped(100);
    expect([touch.analysisState(100), touch.analysisState(100 + POINTER_GRACE_MS)]).toEqual(["fast", "idle"]);
  });

  it("the pointer leaving without having been over the picture opens no grace period", () => {
    const s = pointerScheduler();
    s.pointerLeft(0);
    expect(s.analysisActive(1)).toBe(false);
  });

  it("a paused picture is analyzed three times per new picture while the pointer is active", () => {
    const s = pointerScheduler();
    s.pointerMoved(0);
    expect(run(s, 5000, (t) => t === 0)).toEqual([0, REPEAT_INTERVAL_MS, 2 * REPEAT_INTERVAL_MS]);
  });
});

describe("FrameScheduler with a resting pointer", () => {
  for (const ep of ["webgpu", "wasm"] as const) {
    const slow = analyzeIntervalMs(ep);
    const states = (s: FrameScheduler, times: number[]): AnalysisState[] => times.map((t) => s.analysisState(t));

    describe(`${ep}`, () => {
      it("resting with no tooltip goes idle when the grace period ends", () => {
        const s = pointerScheduler(ep);
        s.pointerMoved(0);
        s.setTooltipShowing(false, 5000);
        expect(states(s, [POINTER_GRACE_MS - 1, POINTER_GRACE_MS])).toEqual(["fast", "idle"]);
      });

      it("resting on a showing tooltip continues at the slow cadence, never the fast one", () => {
        const s = pointerScheduler(ep);
        s.pointerMoved(0);
        s.setTooltipShowing(true, POINTER_GRACE_MS);
        expect(s.analysisState(POINTER_GRACE_MS)).toBe("reading");
        expect(s.intervalInEffectMs(POINTER_GRACE_MS)).toBe(slow);
        const starts: number[] = [];
        for (let t = POINTER_GRACE_MS; t <= POINTER_GRACE_MS + 3 * slow; t += DRIVER_TICK_MS) {
          s.framePresented();
          s.setTooltipShowing(true, t);
          if (s.due(t)) {
            s.started(t);
            starts.push(t - POINTER_GRACE_MS);
          }
        }
        expect(starts).toEqual([0, slow, 2 * slow, 3 * slow]);
      });

      it("a tooltip lost for a short while keeps the reading state; lost for good, it ends after the linger", () => {
        const s = pointerScheduler(ep);
        s.pointerMoved(0);
        s.setTooltipShowing(true, POINTER_GRACE_MS + 1000);
        s.setTooltipShowing(false, POINTER_GRACE_MS + 1250);
        expect(states(s, [POINTER_GRACE_MS + 1250, POINTER_GRACE_MS + 1000 + READING_LINGER_MS - 1, POINTER_GRACE_MS + 1000 + READING_LINGER_MS])).toEqual(["reading", "reading", "idle"]);
        s.setTooltipShowing(true, POINTER_GRACE_MS + 3000);
        expect(s.analysisState(POINTER_GRACE_MS + 3000 + READING_LINGER_MS - 1)).toBe("reading");
      });

      it("a pointer resting on nothing after the grace period is idle at once", () => {
        const s = pointerScheduler(ep);
        s.pointerMoved(0);
        expect(s.analysisState(POINTER_GRACE_MS)).toBe("idle");
      });

      it("the linger continues the tail of a fast period in which a tooltip was showing", () => {
        const s = pointerScheduler(ep);
        s.pointerMoved(0);
        s.setTooltipShowing(true, POINTER_GRACE_MS - 2000);
        s.setTooltipShowing(false, POINTER_GRACE_MS - 1000);
        expect(states(s, [POINTER_GRACE_MS, POINTER_GRACE_MS - 2000 + READING_LINGER_MS])).toEqual(["reading", "idle"]);
      });

      it("the pointer leaving ends reading whatever the tooltip flag says", () => {
        const s = pointerScheduler(ep);
        s.pointerMoved(0);
        s.setTooltipShowing(true, POINTER_GRACE_MS + 1000);
        s.pointerLeft(POINTER_GRACE_MS + 2000);
        s.setTooltipShowing(true, POINTER_GRACE_MS + 2500);
        expect(states(s, [POINTER_GRACE_MS + 2500, 2 * POINTER_GRACE_MS + 1999, 2 * POINTER_GRACE_MS + 2000])).toEqual(["fast", "fast", "idle"]);
      });

      it("movement while reading or idle returns to the fast cadence at once", () => {
        const s = pointerScheduler(ep);
        s.pointerMoved(0);
        s.setTooltipShowing(true, POINTER_GRACE_MS + 1000);
        s.pointerMoved(POINTER_GRACE_MS + 1500);
        expect(s.analysisState(POINTER_GRACE_MS + 1500)).toBe("fast");
        expect(s.intervalInEffectMs(POINTER_GRACE_MS + 1500)).toBe(cadenceMs(ep, "pointer"));
      });

      it("a tap has no resting pointer: idle after the grace period even with the tooltip flag set", () => {
        const s = pointerScheduler(ep);
        s.tapped(0);
        s.setTooltipShowing(true, 100);
        expect(s.analysisState(POINTER_GRACE_MS)).toBe("idle");
      });
    });
  }
});

describe("the staleness rule", () => {
  const armed = (ep: "webgpu" | "wasm" = "webgpu"): FrameScheduler => {
    const s = pointerScheduler(ep);
    s.pointerMoved(0);
    return s;
  };

  it("the first pointer move with nothing analyzed yet asks for an analysis", () => {
    expect(armed().hoverTriggerDue(0, 12, false)).toBe(true);
  });

  it("asks only when the newest analyzed frame is more than the cadence in effect away in video time", () => {
    const s = armed();
    s.started(0, { videoTimeSec: 10, trigger: "hover" });
    expect(s.staleFrameMs(1000)).toBe(500);
    expect([s.hoverTriggerDue(1000, 10.5, false), s.hoverTriggerDue(1000, 10.501, false), s.hoverTriggerDue(1000, 9.4, false)]).toEqual([false, true, true]);
    const wasm = armed("wasm");
    wasm.started(0, { videoTimeSec: 10, trigger: "hover" });
    expect([wasm.hoverTriggerDue(1000, 10.9, false), wasm.hoverTriggerDue(1000, 11.01, false)]).toEqual([false, true]);
  });

  it("the threshold never drops below its floor", () => {
    const s = new FrameScheduler(100, CONFIRM_FRAMES, "pointer", 100);
    s.pointerMoved(0);
    expect(s.staleFrameMs(0)).toBe(STALE_FRAME_MS);
  });

  it("never asks while an analysis is in flight, while idle, or twice within the minimum gap", () => {
    const s = armed();
    expect(s.hoverTriggerDue(0, 5, true)).toBe(false);
    s.started(0, { videoTimeSec: 5, trigger: "hover" });
    expect(s.hoverTriggerDue(HOVER_TRIGGER_MIN_GAP_MS - 1, 50, false)).toBe(false);
    expect(s.hoverTriggerDue(HOVER_TRIGGER_MIN_GAP_MS, 50, false)).toBe(true);
    expect(pointerScheduler().hoverTriggerDue(0, 5, false)).toBe(false);
  });

  it("a seek makes the newest frame stale at the same video time, until the next analysis", () => {
    const s = armed();
    s.started(0, { videoTimeSec: 5 });
    expect(s.frameStale(5, 1000)).toBe(false);
    s.discontinuity();
    expect(s.frameStale(5, 1000)).toBe(true);
    s.started(1000, { videoTimeSec: 5 });
    expect(s.frameStale(5, 1500)).toBe(false);
  });

  it("an analysis started this way uses up the pending frame, and is reported", () => {
    const s = armed();
    s.framePresented();
    s.started(100, { videoTimeSec: 1, trigger: "hover" });
    expect([s.lastTrigger, s.due(100 + DRIVER_TICK_MS), s.msSinceLastAnalysis(350)]).toEqual(["hover", true, 250]); // the repeat of a still
    expect(s.idle).toBe(false);
  });

  it("a pointer moving over a playing video never analyzes faster than the cadence", () => {
    const s = armed();
    const starts: number[] = [];
    for (let t = 0; t <= 3000; t += 50) {
      s.framePresented();
      s.pointerMoved(t);
      const videoSec = t / 1000;
      if (s.hoverTriggerDue(t, videoSec, false)) {
        s.started(t, { videoTimeSec: videoSec, trigger: "hover" });
        starts.push(t);
      } else if (t % DRIVER_TICK_MS === 0 && s.due(t)) {
        s.started(t, { videoTimeSec: videoSec });
        starts.push(t);
      }
    }
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(500);
    expect(starts.length).toBeGreaterThanOrEqual(6);
  });
});

describe("a look asked for after a cut", () => {
  it("is due at once whatever the cadence, is reported as a cut, and is used up by the start", () => {
    const s = new FrameScheduler(1000);
    s.framePresented();
    s.started(0, { videoTimeSec: 1 });
    expect(s.due(100)).toBe(false);
    s.requestLook();
    expect([s.lookPending, s.due(100), s.frameStale(1, 100)]).toEqual([true, true, true]);
    s.started(100, { videoTimeSec: 1.1 });
    expect([s.lastTrigger, s.lookPending, s.due(200)]).toEqual(["cut", false, false]);
  });

  it("never runs while pointer-mode analysis is idle", () => {
    const s = pointerScheduler();
    s.requestLook();
    expect(s.due(0)).toBe(false);
  });
});

/**
 * A paused video under the pointer, driven as session.ts drives it: a tick every
 * DRIVER_TICK_MS, one look in flight at a time, a look given up on after ANALYSIS_WATCHDOG_MS
 * (its late reply dropped), and a worker that answers "busy" while it is still analyzing an
 * earlier picture. The first picture takes `firstMs`; later ones 100 ms.
 */
function pausedWithSlowFirstLook(opts: {
  firstMs: number;
  endMs: number;
  pointerAt: (t: number) => boolean;
  retry?: boolean;
  /** Captures fail before this time (the look is used up and nothing reaches the worker). */
  captureFailsUntil?: number;
}): { sent: number[]; analyzed: number[] } {
  const s = pointerScheduler("wasm");
  const retry = opts.retry ?? true;
  const sent: number[] = [];
  const analyzed: number[] = [];
  let workerFreeAt = -Infinity;
  type Look = { sentAt: number; replyAt: number; analyzed: boolean };
  // Set inside `send`, so the declared type keeps TypeScript from narrowing it to null.
  let inFlight = null as Look | null;
  const send = (t: number, trigger?: "hover"): void => {
    s.started(t, { videoTimeSec: 3, ...(trigger ? { trigger } : {}) });
    sent.push(t);
    if (t < (opts.captureFailsUntil ?? -Infinity)) {
      if (retry) s.lookUnanswered(t);
    } else if (t < workerFreeAt) {
      inFlight = { sentAt: t, replyAt: t, analyzed: false };
    } else {
      workerFreeAt = t + (sent.length === 1 ? opts.firstMs : 100);
      inFlight = { sentAt: t, replyAt: workerFreeAt, analyzed: true };
    }
  };
  s.framePresented();
  for (let t = 0; t <= opts.endMs; t += DRIVER_TICK_MS) {
    if (inFlight && inFlight.replyAt <= t) {
      const reply = inFlight;
      inFlight = null;
      if (reply.analyzed) {
        s.lookAnswered();
        analyzed.push(t);
      } else if (retry) s.lookUnanswered(t);
    }
    if (inFlight && t - inFlight.sentAt >= ANALYSIS_WATCHDOG_MS) {
      inFlight = null;
      if (retry) s.lookUnanswered(t);
    }
    if (opts.pointerAt(t)) {
      s.pointerMoved(t);
      if (s.hoverTriggerDue(t, 3, inFlight !== null)) send(t, "hover");
    }
    if (!inFlight && s.due(t)) send(t);
  }
  return { sent, analyzed };
}

describe("a paused picture whose first look is slow", () => {
  const moving = (): boolean => true;

  it("without a retry, nothing is analyzed again until the video moves", () => {
    const { analyzed } = pausedWithSlowFirstLook({ firstMs: 9_000, endMs: 60_000, pointerAt: moving, retry: false });
    expect(analyzed).toEqual([]);
  });

  it("is looked at again after the busy answers and the given-up look, and gets analyzed", () => {
    const { analyzed } = pausedWithSlowFirstLook({ firstMs: 9_000, endMs: 60_000, pointerAt: moving });
    expect(analyzed.length).toBeGreaterThan(0);
    // The worker is free at 9 s; the back-off is at most 2 s, plus the cadence.
    expect(analyzed[0]).toBeGreaterThanOrEqual(9_000);
    expect(analyzed[0]).toBeLessThanOrEqual(9_000 + 2_000 + 1_000);
  });

  it("backs off while the worker stays busy: one look every 2 s or so, never one every tick", () => {
    const { sent, analyzed } = pausedWithSlowFirstLook({ firstMs: Infinity, endMs: 60_000, pointerAt: moving });
    expect(analyzed).toEqual([]);
    const lastTen = sent.filter((t) => t > 50_000);
    expect(lastTen.length).toBeGreaterThanOrEqual(4);
    expect(lastTen.length).toBeLessThanOrEqual(5);
    const gaps = sent.slice(1).map((t, i) => t - sent[i]!);
    expect(Math.min(...gaps.slice(-5))).toBeGreaterThanOrEqual(LOOK_RETRY_MS.at(-1)!);
  });

  it("looks again after failed captures when the pointer leaves and comes back", () => {
    const run = (retry: boolean) =>
      pausedWithSlowFirstLook({
        firstMs: 100,
        endMs: 30_000,
        // Captures fail through the grace period of the last move, so the retry waits for the pointer.
        captureFailsUntil: 1_000 + POINTER_GRACE_MS + 1_000,
        pointerAt: (t) => t <= 1_000 || (t >= 15_000 && t <= 18_000),
        retry,
      });
    expect(run(false).analyzed).toEqual([]);
    const { analyzed } = run(true);
    expect(analyzed.length).toBeGreaterThan(0);
    expect(analyzed[0]).toBeGreaterThanOrEqual(15_000);
    expect(analyzed[0]).toBeLessThanOrEqual(15_000 + 1_000 + DRIVER_TICK_MS);
  });

  it("stops once the pointer rests past the grace period, and looks again when it moves", () => {
    const { sent } = pausedWithSlowFirstLook({
      firstMs: Infinity,
      endMs: 40_000,
      pointerAt: (t) => t <= 1_000 || t === 30_000,
    });
    expect(sent.filter((t) => t > 1_000 + POINTER_GRACE_MS && t < 30_000)).toEqual([]);
    expect(sent.some((t) => t >= 30_000 && t <= 30_000 + LOOK_RETRY_MS.at(-1)! + 1_000)).toBe(true);
  });

  it("the back-off grows with each unanswered look and starts over after an analyzed one", () => {
    const s = new FrameScheduler(0);
    s.framePresented();
    s.started(0);
    s.started(1);
    s.started(2);
    expect(s.due(10_000)).toBe(false);
    const delays: number[] = [];
    let t = 10_000;
    for (let i = 0; i < 6; i += 1) {
      s.lookUnanswered(t);
      let wait = 0;
      while (wait <= 10_000 && !s.due(t + wait)) wait += 1;
      delays.push(wait);
      t += wait;
      s.started(t);
      s.started(t);
      s.started(t);
    }
    expect(delays).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000]);
    s.lookAnswered();
    expect(s.due(t + 5_000)).toBe(false);
    s.lookUnanswered(t);
    expect([s.due(t + 249), s.due(t + 250)]).toEqual([false, true]);
    // A seek or a new source starts it over too; the pointer leaving does not.
    s.lookUnanswered(t);
    s.lookUnanswered(t);
    s.discontinuity();
    s.lookUnanswered(t);
    expect([s.due(t + 249), s.due(t + 250)]).toEqual([false, true]);
    const p = pointerScheduler("wasm");
    p.pointerMoved(0);
    p.framePresented();
    p.started(0, { videoTimeSec: 3 });
    p.started(0, { videoTimeSec: 3 });
    p.started(0, { videoTimeSec: 3 });
    p.lookUnanswered(0);
    p.lookUnanswered(0);
    p.pointerLeft(100);
    p.pointerMoved(200);
    p.lookUnanswered(1_000);
    expect([p.due(1_999), p.due(2_000)]).toEqual([false, true]);
  });

  it("a waiting retry keeps the scheduler from idle; a seek drops it", () => {
    const s = new FrameScheduler(0);
    s.framePresented();
    s.started(0);
    s.started(1);
    s.started(2);
    expect(s.idle).toBe(true);
    s.lookUnanswered(10);
    expect(s.idle).toBe(false);
    s.discontinuity();
    expect([s.idle, s.due(10_000)]).toEqual([true, false]);
  });

  it("an unanswered look drops the still picture's other repeats until the retry", () => {
    const s = new FrameScheduler(0);
    s.framePresented();
    s.started(0);
    expect(s.due(REPEAT_INTERVAL_MS)).toBe(true);
    // Unanswered 100 ms after the start: the repeat would be due at 250 ms, the retry is at 350.
    s.lookUnanswered(100);
    expect([s.due(REPEAT_INTERVAL_MS), s.due(100 + LOOK_RETRY_MS[0]! - 1), s.due(100 + LOOK_RETRY_MS[0]!)]).toEqual([false, false, true]);
  });

  it("a pointer move does not skip the back-off: the paused picture is not stale", () => {
    const s = pointerScheduler("wasm");
    s.pointerMoved(0);
    s.framePresented();
    s.started(0, { videoTimeSec: 3 });
    s.lookUnanswered(100);
    expect(s.hoverTriggerDue(200, 3, false)).toBe(false);
  });
});

describe("replyRejection", () => {
  const live: LiveTemporalState = { inFlightRequestId: 7, lastAcceptedRequestId: 6, generation: 3, videoKey: "source-1" };
  const envelope = (over: Partial<FrameEnvelope> = {}): FrameEnvelope => ({ requestId: 7, mediaTimeSec: 12, generation: 3, videoKey: "source-1", ...over });

  it("shows only the reply to the request in flight, from the live source and generation", () => {
    expect(replyRejection(envelope(), live)).toBeNull();
    expect(replyRejection(envelope({ mediaTimeSec: 999 }), live)).toBeNull(); // the time plays no part here
  });

  it("gives the reason otherwise", () => {
    expect(replyRejection(undefined, live)).toBe("stale-request");
    expect(replyRejection(envelope({ requestId: 8 }), live)).toBe("stale-request");
    expect(replyRejection(envelope(), { ...live, inFlightRequestId: null })).toBe("stale-request");
    expect(replyRejection(envelope({ requestId: 6 }), live)).toBe("superseded");
    expect(replyRejection(envelope({ requestId: 2 }), live)).toBe("superseded");
    expect(replyRejection(envelope({ videoKey: "source-2" }), live)).toBe("video-key");
    expect(replyRejection(envelope({ generation: 2 }), live)).toBe("generation");
  });

  it("only a reply from another source or generation still finishes the request in flight", () => {
    expect((["stale-request", "superseded", "video-key", "generation"] as const).map(rejectionAnswersInFlight)).toEqual([false, false, true, true]);
  });

  it("the published maximum age of a shown result is two seconds", () => {
    expect(HOVER_MAX_AGE_MS).toBe(2000);
  });
});
