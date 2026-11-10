// SPDX-License-Identifier: Apache-2.0
// Measured pacing: the wait between analyses from the measured analysis time.
import { describe, expect, it } from "vitest";

import {
  ACTIVE_ANALYZE_INTERVAL_MS,
  ACTIVE_WASM_ANALYZE_INTERVAL_MS,
  activeAnalyzeIntervalMs,
  analyzeIntervalMs,
  MeasuredPacer,
  pacedIntervalMs,
  resolveMeasuredPacing,
} from "../src/cadence.js";
import type { FrameResult, ReleaseStatus, WorkerRequest } from "../src/messages.js";
import type { FrameAnalysis } from "../src/pipeline.js";
import { SessionCore, type SessionCoreOptions } from "../src/session-core.js";

const ACTIVE_CEILING = 4_000;
const SLOW_CEILING = 8_000;

describe("pacedIntervalMs", () => {
  it("row 2: a fast computer is never paced faster than the fixed rate", () => {
    const fast = [50, 50, 50, 50, 50];
    expect(pacedIntervalMs(ACTIVE_ANALYZE_INTERVAL_MS, ACTIVE_CEILING, fast, 0.25)).toBe(500);
    expect(pacedIntervalMs(ACTIVE_WASM_ANALYZE_INTERVAL_MS, ACTIVE_CEILING, fast, 0.25)).toBe(1_000);
  });

  it("row 3: 900 ms analyses at the default share wait 3600 ms, and the ceilings hold", () => {
    const slow = [900, 900, 900, 900, 900];
    expect(pacedIntervalMs(1_000, ACTIVE_CEILING, slow, 0.25)).toBe(3_600);
    const slower = [2_000, 2_000, 2_000];
    expect(pacedIntervalMs(1_000, ACTIVE_CEILING, slower, 0.25)).toBe(4_000);
    expect(pacedIntervalMs(2_000, SLOW_CEILING, slower, 0.25)).toBe(8_000);
    expect(pacedIntervalMs(2_000, SLOW_CEILING, [10_000, 10_000, 10_000], 0.25)).toBe(8_000);
  });

  it("row 4: one long cycle among short ones does not move the wait", () => {
    expect(pacedIntervalMs(500, ACTIVE_CEILING, [200, 200, 3_000, 200, 200], 0.25)).toBe(800);
    expect(pacedIntervalMs(500, ACTIVE_CEILING, [200, 200, 200, 200, 200], 0.25)).toBe(800);
  });

  it("row 4: the fixed rate holds until 3 analyses were measured", () => {
    expect(pacedIntervalMs(1_000, ACTIVE_CEILING, [], 0.25)).toBe(1_000);
    expect(pacedIntervalMs(1_000, ACTIVE_CEILING, [900, 900], 0.25)).toBe(1_000);
    expect(pacedIntervalMs(1_000, ACTIVE_CEILING, [900, 900, 900], 0.25)).toBe(3_600);
  });

  it("takes the median of the last 5 only", () => {
    expect(pacedIntervalMs(500, ACTIVE_CEILING, [3_000, 3_000, 3_000, 100, 100, 100, 100, 100], 0.25)).toBe(500);
    expect(pacedIntervalMs(500, ACTIVE_CEILING, [100, 100, 600, 700, 800, 900], 0.5)).toBe(1_400);
  });

  it("a larger share waits less", () => {
    expect(pacedIntervalMs(500, ACTIVE_CEILING, [900, 900, 900], 0.5)).toBe(1_800);
  });
});

describe("MeasuredPacer", () => {
  it("row 3: WebAssembly at 900 ms: 3600 ms active, 3600 ms resting", () => {
    const pacer = new MeasuredPacer(0.25);
    expect(pacer.activeMs("wasm")).toBe(1_000);
    for (let i = 0; i < 3; i += 1) pacer.record(900);
    expect(pacer.activeMs("wasm")).toBe(3_600);
    expect(pacer.slowMs("wasm")).toBe(3_600);
    expect(pacer.intervalMs("wasm", "pointer")).toBe(3_600);
    expect(pacer.intervalMs("wasm", "always-on")).toBe(3_600);
  });

  it("keeps the fixed floor per backend", () => {
    const pacer = new MeasuredPacer(0.25);
    for (let i = 0; i < 3; i += 1) pacer.record(50);
    expect(pacer.activeMs("webgpu")).toBe(activeAnalyzeIntervalMs("webgpu"));
    expect(pacer.slowMs(null)).toBe(analyzeIntervalMs(null));
    expect(pacer.slowMs("wasm")).toBe(2_000);
  });

  it("ignores values that are not times", () => {
    const pacer = new MeasuredPacer(0.25);
    for (const bad of [Number.NaN, -1, Infinity]) pacer.record(bad);
    for (let i = 0; i < 2; i += 1) pacer.record(900);
    expect(pacer.activeMs("wasm")).toBe(1_000);
  });
});

describe("resolveMeasuredPacing", () => {
  it("is off unless asked for", () => {
    expect(resolveMeasuredPacing(undefined)).toBeNull();
    expect(resolveMeasuredPacing(false)).toBeNull();
  });
  it("gives the default share, or the product's", () => {
    expect(resolveMeasuredPacing(true)).toBe(0.25);
    expect(resolveMeasuredPacing({})).toBe(0.25);
    expect(resolveMeasuredPacing({ share: 0.5 })).toBe(0.5);
    expect(resolveMeasuredPacing({ share: 1 })).toBe(1);
  });
  it("refuses a share outside (0, 1]", () => {
    for (const share of [0, -0.1, 1.5, Number.NaN]) expect(() => resolveMeasuredPacing({ share })).toThrow(RangeError);
  });
});

// ------------------------------------------------------------------ in the session core

const release = {
  id: "r", game: "toy-game", locale: "en",
  detector: { version: "d", ep: "wasm" }, recognizer: { version: "r", ep: "wasm" },
  bankCards: 2, catalogCards: 2, identityLevel: "printing",
  decode: { threshold: 0.3, nmsIou: 0.45, maxProposals: 80, minCropPx: 24 },
  accept: { tau: 0.62, delta: 0.05 }, hoverSelection: "accepted-nms", hoverMaxAgeMs: 2000,
  analysisWidth: { min: 720, max: 1920 }, ortWeb: "1.29.0",
} as unknown as NonNullable<ReleaseStatus["release"]>;

function driven(options: SessionCoreOptions) {
  let clock = 0;
  const requests: WorkerRequest[] = [];
  const captures: number[] = [];
  const core = new SessionCore(
    {
      now: () => clock,
      toWorker: (r) => requests.push(r),
      capture: (id) => captures.push(id),
      hoverAt: (() => ({ card: null, boxIndex: null, box: null, cardId: null, name: null })) as never,
    },
    options,
  );
  core.fromWorker({ kind: "release-status", ok: true, error: null, release, cards: [] });
  /** One analysis that the worker reports as taking `workerMs`. */
  const analyze = (workerMs: number) => {
    clock += 10_000; // past any wait, so the next look is due
    core.presented(1);
    core.tick();
    const id = captures.at(-1)!;
    core.frame(id, { close() {} } as unknown as ImageBitmap, 1);
    const request = requests.at(-1)!;
    if (request.kind !== "frame") throw new Error("not a frame request");
    const result: FrameResult = {
      kind: "frame-result", envelope: request.envelope, videoTimeSec: 1, width: 1000, height: 500, workerMs,
      analysis: { frame: { width: 1000, height: 500 }, hover: { selection: "accepted-nms", cards: [] }, boxes: [] } as unknown as FrameAnalysis,
    };
    core.fromWorker(result);
  };
  return { core, analyze, now: () => clock };
}

describe("measured pacing in the session core", () => {
  it("row 1: off, the wait stays today's fixed rate however slow the analyses are", () => {
    const { core, analyze, now } = driven({ mode: "always-on" });
    for (let i = 0; i < 6; i += 1) {
      analyze(900);
    }
    expect(core.scheduler.intervalInEffectMs(now())).toBe(2_000);
  });

  it("on, the wait follows the measured time after 3 analyses", () => {
    const { core, analyze, now } = driven({ mode: "always-on", measuredPacing: true });
    for (let i = 0; i < 2; i += 1) {
      analyze(5_000);
      expect(core.scheduler.intervalInEffectMs(now())).toBe(2_000);
    }
    analyze(5_000);
    expect(core.scheduler.intervalInEffectMs(now())).toBe(8_000);
  });

  it("on, a custom share is used", () => {
    const { core, analyze, now } = driven({ mode: "always-on", measuredPacing: { share: 0.5 } });
    for (let i = 0; i < 3; i += 1) analyze(3_000);
    expect(core.scheduler.intervalInEffectMs(now())).toBe(6_000);
  });

  it("refuses a bad share", () => {
    expect(() => driven({ measuredPacing: { share: 2 } })).toThrow(RangeError);
  });
});
