// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { activeAnalyzeIntervalMs, analyzeIntervalMs, cadenceMs, isSlowDevice } from "../src/cadence.js";
import {
  ANALYSIS_WATCHDOG_MS,
  FIRST_ANALYSIS_WATCHDOG_MS,
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
 * (FIRST_ANALYSIS_WATCHDOG_MS until the first analysis; its late reply dropped), and a worker that answers "busy" while it is still analyzing an
 * earlier picture. The first picture takes `firstMs`; later ones 100 ms.
 */
function pausedWithSlowFirstLook(opts: {
  firstMs: number;
  endMs: number;
  pointerAt: (t: number) => boolean;
  retry?: boolean;
  /** Captures fail before this time (the look is used up and nothing reaches the worker). */
  captureFailsUntil?: number;
  /** A failed capture reports a prompt retry (`lookUnanswered(t, { prompt: true })`). */
  prompt?: boolean;
  /** A picture that reaches the worker is reported (`pictureReceived`), as a session core does. */
  pictureReceived?: boolean;
}): { sent: number[]; analyzed: number[] } {
  const s = pointerScheduler("wasm");
  const retry = opts.retry ?? true;
  const sent: number[] = [];
  const analyzed: number[] = [];
  let workerFreeAt = -Infinity;
  let analyzedOnce = false;
  type Look = { sentAt: number; replyAt: number; analyzed: boolean };
  // Set inside `send`, so the declared type keeps TypeScript from narrowing it to null.
  let inFlight = null as Look | null;
  const send = (t: number, trigger?: "hover"): void => {
    s.started(t, { videoTimeSec: 3, ...(trigger ? { trigger } : {}) });
    sent.push(t);
    if (t < (opts.captureFailsUntil ?? -Infinity)) {
      if (retry) s.lookUnanswered(t, opts.prompt ? { prompt: true } : {});
      return;
    }
    if (opts.pictureReceived) s.pictureReceived();
    if (t < workerFreeAt) {
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
        analyzedOnce = true;
        s.lookAnswered();
        analyzed.push(t);
      } else if (retry) s.lookUnanswered(t);
    }
    if (inFlight && t - inFlight.sentAt >= (analyzedOnce ? ANALYSIS_WATCHDOG_MS : FIRST_ANALYSIS_WATCHDOG_MS)) {
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

/** `pausedWithSlowFirstLook` with pictures received, first look 6 s and 12 s (to 20 s) and 18 s
 *  (to 30 s). */
const PINNED_SLOW_FIRST_LOOK: Record<number, { sent: number[]; analyzed: number[] }> = {
  6_000: { sent: [0, 6_000, 6_250], analyzed: [6_000, 6_250, 6_500] },
  12_000: { sent: [0, 12_000, 12_250], analyzed: [12_000, 12_250, 12_500] },
  // Given up on at 15 s (FIRST_ANALYSIS_WATCHDOG_MS); the worker answers busy until 18 s.
  18_000: {
    sent: [0, 15_250, 16_250, 17_500, 19_750, 20_000, 20_250],
    analyzed: [20_000, 20_250, 20_500],
  },
};

describe("a paused picture whose first look is slow", () => {
  const moving = (): boolean => true;

  it("without a retry, nothing is analyzed again until the video moves", () => {
    // Past FIRST_ANALYSIS_WATCHDOG_MS, so the first look is given up on.
    const { analyzed } = pausedWithSlowFirstLook({ firstMs: 18_000, endMs: 60_000, pointerAt: moving, retry: false });
    expect(analyzed).toEqual([]);
  });

  it("is looked at again after the busy answers and the given-up look, and gets analyzed", () => {
    const { analyzed } = pausedWithSlowFirstLook({ firstMs: 18_000, endMs: 60_000, pointerAt: moving });
    expect(analyzed.length).toBeGreaterThan(0);
    // The worker is free at 18 s; the back-off is at most 2 s, plus the cadence.
    expect(analyzed[0]).toBeGreaterThanOrEqual(18_000);
    expect(analyzed[0]).toBeLessThanOrEqual(18_000 + 2_000 + 1_000);
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

describe("a prompt retry (a capture that failed for want of a picture)", () => {
  /** A still picture whose three looks were all started; nothing is due until something happens. */
  const usedUp = (s: FrameScheduler, t = 0): void => {
    s.framePresented();
    s.started(t);
    s.started(t);
    s.started(t);
  };

  it("is due once the back-off runs out, whatever the cadence", () => {
    const s = new FrameScheduler(1_000);
    usedUp(s);
    s.lookUnanswered(100, { prompt: true });
    expect([s.due(100 + LOOK_RETRY_MS[0]! - 1), s.due(100 + LOOK_RETRY_MS[0]!)]).toEqual([false, true]);
  });

  it("without prompt the retry also waits for the cadence (rc2)", () => {
    const s = new FrameScheduler(1_000);
    usedUp(s);
    s.lookUnanswered(100);
    expect([s.due(350), s.due(999), s.due(1_000)]).toEqual([false, false, true]);
  });

  it("is used up by the start, which is reported as a cadence look, not a cut", () => {
    const s = new FrameScheduler(1_000);
    usedUp(s);
    s.lookUnanswered(100, { prompt: true });
    s.started(350);
    expect(s.lastTrigger).toBe("cadence");
    // The started look gets the still picture's repeats, at the repeat spacing, not at once.
    expect([s.due(351), s.due(350 + REPEAT_INTERVAL_MS)]).toEqual([false, true]);
    s.started(600);
    s.started(850);
    expect([s.due(10_000), s.idle]).toEqual([false, true]);
  });

  it("a pointer move still cannot skip the back-off: nothing is marked stale", () => {
    const s = pointerScheduler("wasm");
    s.pointerMoved(0);
    s.framePresented();
    s.started(0, { videoTimeSec: 3 });
    s.lookUnanswered(100, { prompt: true });
    s.pointerMoved(200);
    expect(s.hoverTriggerDue(200, 3, false)).toBe(false);
    expect([s.lookPending, s.due(200), s.due(349), s.due(350)]).toEqual([false, false, false, true]);
  });

  it("grows the back-off with each failure in a row, as other unanswered looks do", () => {
    const s = new FrameScheduler(60_000);
    usedUp(s);
    const delays: number[] = [];
    let t = 10_000;
    for (let i = 0; i < 6; i += 1) {
      s.lookUnanswered(t, { prompt: true });
      let wait = 0;
      while (wait <= 10_000 && !s.due(t + wait)) wait += 1;
      delays.push(wait);
      t += wait;
      s.started(t);
    }
    expect(delays).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000]);
  });

  it("runs only while analysis may run", () => {
    const s = pointerScheduler("wasm");
    s.pointerMoved(0);
    s.framePresented();
    s.started(0, { videoTimeSec: 3 });
    s.lookUnanswered(100, { prompt: true });
    expect(s.due(POINTER_GRACE_MS + 1)).toBe(false);
    s.pointerMoved(POINTER_GRACE_MS + 2);
    expect(s.due(POINTER_GRACE_MS + 2)).toBe(true);
  });
});

describe("a picture received for the look in flight", () => {
  it("starts the back-off over: a busy answer then retries after the first delay", () => {
    const s = new FrameScheduler(0);
    s.framePresented();
    s.started(0);
    s.started(0);
    s.started(0);
    // Three captures failed in a row: the next retry would be 1 s away.
    s.lookUnanswered(0, { prompt: true });
    s.lookUnanswered(0, { prompt: true });
    s.lookUnanswered(0, { prompt: true });
    s.started(1_000);
    s.pictureReceived();
    expect(s.idle).toBe(false); // the repeats of the started look are still to come
    s.lookUnanswered(1_100); // answered busy
    expect([s.due(1_100 + LOOK_RETRY_MS[0]! - 1), s.due(1_100 + LOOK_RETRY_MS[0]!)]).toEqual([false, true]);
  });

  it("after a failed capture, drops a retry still waiting", () => {
    const s = new FrameScheduler(0);
    s.framePresented();
    s.started(0);
    s.started(0);
    s.started(0);
    s.lookUnanswered(0, { prompt: true });
    expect(s.idle).toBe(false);
    s.pictureReceived();
    expect([s.idle, s.due(10_000)]).toEqual([true, false]);
  });

  it("after a busy answer or a given-up look, changes nothing", () => {
    const s = new FrameScheduler(0);
    s.framePresented();
    s.started(0);
    s.started(0);
    s.started(0);
    s.lookUnanswered(0);
    s.pictureReceived();
    expect([s.idle, s.due(249), s.due(250)]).toEqual([false, false, true]);
    // A failed capture, then a busy answer: the newest is the busy one, so a picture keeps it.
    s.started(250);
    s.lookUnanswered(300, { prompt: true });
    s.lookUnanswered(400);
    s.pictureReceived();
    expect([s.due(400 + LOOK_RETRY_MS[2]! - 1), s.due(400 + LOOK_RETRY_MS[2]!)]).toEqual([false, true]);
  });

  it("a worker that stays busy is backed off from up to 2 s, though every picture reaches it", () => {
    const s = new FrameScheduler(0);
    s.framePresented();
    s.started(0);
    s.started(0);
    s.started(0);
    const delays: number[] = [];
    let t = 10_000;
    for (let i = 0; i < 6; i += 1) {
      s.lookUnanswered(t); // answered busy
      let wait = 0;
      while (wait <= 10_000 && !s.due(t + wait)) wait += 1;
      delays.push(wait);
      t += wait;
      s.started(t);
      s.pictureReceived();
    }
    expect(delays).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000]);
  });

  it("a reset by an analyzed look or a seek also forgets the failed capture", () => {
    for (const reset of ["lookAnswered", "discontinuity"] as const) {
      const s = new FrameScheduler(0);
      s.framePresented();
      s.started(0);
      s.started(0);
      s.started(0);
      s.lookUnanswered(0, { prompt: true });
      s[reset]();
      s.lookUnanswered(1_000);
      s.started(1_250);
      s.pictureReceived();
      s.lookUnanswered(1_300);
      // Second busy answer in a row: 500 ms, not reset to 250 by the picture.
      expect([s.due(1_300 + 499), s.due(1_300 + 500)]).toEqual([false, true]);
    }
  });

  it("leaves the reset by an analyzed look or a seek as it was, and idle as it was", () => {
    for (const reset of ["lookAnswered", "discontinuity"] as const) {
      const s = new FrameScheduler(0);
      s.framePresented();
      s.started(0);
      s.started(0);
      s.started(0);
      s.lookUnanswered(0, { prompt: true });
      s.lookUnanswered(0, { prompt: true });
      s[reset]();
      expect([s.idle, s.due(10_000)]).toEqual([true, false]);
      s.lookUnanswered(10_000, { prompt: true });
      expect([s.idle, s.due(10_000 + 249), s.due(10_000 + 250)]).toEqual([false, false, true]);
    }
  });
});

describe("a retry used up without an answer (a refused capture)", () => {
  /** A paused picture whose capture failed while the pointer was over it; the pointer leaves,
   *  the retry starts a look while the pointer is outside, and that look is refused (reported
   *  to nobody: a refusal calls nothing). */
  const refusedWhileOutside = (): FrameScheduler => {
    const s = pointerScheduler("wasm");
    s.pointerMoved(0);
    s.framePresented();
    s.started(0, { videoTimeSec: 3 });
    s.lookUnanswered(100, { prompt: true });
    s.pointerLeft(200);
    // Still fast (the grace period of the leave): the retry and its repeats start, all refused.
    for (const t of [350, 350 + REPEAT_INTERVAL_MS, 350 + 2 * REPEAT_INTERVAL_MS]) {
      expect(s.due(t)).toBe(true);
      s.started(t, { videoTimeSec: 3 });
    }
    return s;
  };

  it("is due again when the pointer comes back and moves", () => {
    const s = refusedWhileOutside();
    expect([s.idle, s.due(5_000)]).toEqual([true, false]);
    s.pointerMoved(5_000);
    expect(s.due(5_000)).toBe(true);
  });

  it("without a move nothing is due: the pointer is the trigger", () => {
    const s = refusedWhileOutside();
    expect(s.due(30_000)).toBe(false);
  });

  it("a pointer move never shortens a retry still waiting", () => {
    const s = pointerScheduler("wasm");
    s.pointerMoved(0);
    s.framePresented();
    s.started(0, { videoTimeSec: 3 });
    s.lookUnanswered(100);
    s.lookUnanswered(100);
    s.pointerMoved(200);
    // Second unanswered look: 500 ms back-off, then the 1 s cadence of the last start at 0.
    expect([s.due(599), s.due(1_000)]).toEqual([false, true]);
  });

  it("nothing is due after an analyzed look, however the pointer moves", () => {
    const s = pointerScheduler("wasm");
    s.pointerMoved(0);
    s.framePresented();
    s.started(0, { videoTimeSec: 3 });
    s.started(250, { videoTimeSec: 3 });
    s.started(500, { videoTimeSec: 3 });
    s.lookAnswered();
    s.pointerMoved(5_000);
    expect([s.idle, s.due(5_000)]).toEqual([true, false]);
  });
});

describe("a refused look (lookRefused)", () => {
  /** Pointer mode on WebAssembly (1 s cadence): a paused picture whose look and repeats were all
   *  started at 0, 250 and 500 and refused; the pointer left at 0. */
  const allRefused = (): FrameScheduler => {
    const s = pointerScheduler("wasm");
    s.pointerMoved(0);
    s.pointerLeft(0);
    s.framePresented();
    for (const t of [0, 250, 500]) {
      expect(s.due(t)).toBe(true);
      s.started(t, { videoTimeSec: 3 });
      s.lookRefused();
    }
    return s;
  };

  it("leaves nothing due until the pointer moves; a move makes it due at the cadence", () => {
    const s = allRefused();
    expect([s.idle, s.due(5_000), s.due(30_000)]).toEqual([true, false, false]);
    const r = allRefused();
    r.pointerMoved(600);
    expect([r.due(600), r.due(1_499), r.due(1_500)]).toEqual([false, false, true]);
  });

  it("is not forgotten by a new look: refused again, the next move asks again", () => {
    const s = allRefused();
    s.pointerMoved(5_000);
    expect(s.due(5_000)).toBe(true);
    // The look and its repeats, all refused again.
    for (const t of [5_000, 5_250, 5_500]) {
      expect(s.due(t)).toBe(true);
      s.started(t, { videoTimeSec: 3 });
      s.lookRefused();
    }
    expect(s.due(8_000)).toBe(false);
    s.pointerMoved(8_000);
    expect(s.due(8_000)).toBe(true);
  });

  it("is forgotten by an analyzed look, a picture received or a new picture", () => {
    for (const forget of ["lookAnswered", "pictureReceived", "discontinuity"] as const) {
      const s = allRefused();
      s[forget]();
      s.pointerMoved(5_000);
      expect(s.due(5_000)).toBe(false);
      // After a seek the picture is stale: the staleness rule asks, not the refusal.
      expect(s.hoverTriggerDue(5_000, 3, false)).toBe(forget === "discontinuity");
    }
  });

  it("grows no back-off, and a move never shortens a back-off still waiting", () => {
    const s = allRefused();
    s.lookUnanswered(600);
    expect([s.due(849), s.due(1_499), s.due(1_500)]).toEqual([false, false, true]);
    const w = pointerScheduler("wasm");
    w.pointerMoved(0);
    w.framePresented();
    w.started(0, { videoTimeSec: 3 });
    w.lookUnanswered(100);
    w.lookUnanswered(100);
    w.lookRefused();
    w.pointerMoved(200);
    expect([w.due(599), w.due(1_000)]).toEqual([false, true]);
  });
});

describe("the session loop with prompt retries and pictures received", () => {
  const moving = (): boolean => true;

  it("a failed capture is looked at again after the back-off, not after the cadence", () => {
    const { sent } = pausedWithSlowFirstLook({ firstMs: 100, endMs: 3_000, pointerAt: moving, captureFailsUntil: 1, prompt: true });
    // Sent at 0 (the pointer), failed; the retry 250 ms later, not at the 1 s cadence.
    expect(sent.slice(0, 2)).toEqual([0, 250]);
    const plain = pausedWithSlowFirstLook({ firstMs: 100, endMs: 3_000, pointerAt: moving, captureFailsUntil: 1 });
    expect(plain.sent.slice(0, 2)).toEqual([0, 1_000]);
  });

  // Pinned: the session core (session-core.test.ts) must give the same times.
  it("a slow first look, pictures received: the times a session core must reproduce", () => {
    const six = pausedWithSlowFirstLook({ firstMs: 6_000, endMs: 20_000, pointerAt: moving, pictureReceived: true });
    expect(six).toEqual(PINNED_SLOW_FIRST_LOOK[6_000]);
    const twelve = pausedWithSlowFirstLook({ firstMs: 12_000, endMs: 20_000, pointerAt: moving, pictureReceived: true });
    expect(twelve).toEqual(PINNED_SLOW_FIRST_LOOK[12_000]);
    const eighteen = pausedWithSlowFirstLook({ firstMs: 18_000, endMs: 30_000, pointerAt: moving, pictureReceived: true });
    expect(eighteen).toEqual(PINNED_SLOW_FIRST_LOOK[18_000]);
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
