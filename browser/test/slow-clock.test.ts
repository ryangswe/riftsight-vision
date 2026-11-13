// SPDX-License-Identifier: Apache-2.0
// The slow-clock harness (test/support/slow-clock.ts) and what it finds in the look scheduling.
// Four behaviors of today's code (the blink, the relook spacing, the stale threshold and the back-off bypass) are written as expected failures under the rule "current": each
// states the old value and the intended one, and flips to a failure of the test when the code is
// fixed (then the test is turned into a plain assertion). The empty-spot rest is intended and is
// an ordinary invariant. Nothing here reaches a network or a real clock.
import { describe, expect, it } from "vitest";

import {
  ABC,
  budgetedSpacingMs,
  renderReport,
  ruleSpacingsMs,
  RULES,
  runScenario,
  type Rule,
  type Scenario,
  type ScenarioEvent,
  scenarioNamed,
  type SlowClockConfig,
  VARYING_WORKER_MS,
} from "./support/slow-clock.js";

const mv = (at: number, px: number, py: number): ScenarioEvent => ({ at, kind: "move", px, py });
const custom = (over: Partial<Scenario> & Pick<Scenario, "durationMs" | "events">): Scenario => ({ name: "custom", summary: "", layout: ABC, startReady: true, ...over });
const jiggleOnA = (every: number, to: number): ScenarioEvent[] => {
  const out: ScenarioEvent[] = [];
  for (let t = 0, i = 0; t <= to; t += every, i++) out.push(mv(t, 200 + (i % 2) * 4, 250));
  return out;
};

describe("the harness", () => {
  it("is deterministic: two runs of a scenario give the same result, and so does the report", () => {
    const cfg: Partial<SlowClockConfig> = { workerMs: VARYING_WORKER_MS, focus: true, rule: "budgeted", playbackRate: 0.5 };
    expect(runScenario(scenarioNamed("viewer-session"), cfg)).toEqual(runScenario(scenarioNamed("viewer-session"), cfg));
    expect(renderReport()).toBe(renderReport());
  });

  it("first load: the name comes one analysis after the release loads (entry look)", () => {
    const run = runScenario(scenarioNamed("first-load"), { workerMs: 500 });
    expect(run.residences).toEqual([{ card: "A", startMs: 0, dwellMs: 20_000, latencyMs: 1500 + 500 }]);
    expect(run.looks[0]).toEqual({ at: 1500, trigger: expect.anything() });
  });

  it("starts at most one look at a time, whatever the rule", () => {
    for (const rule of RULES) {
      for (const workerMs of [200, 1200, 1700]) {
        const run = runScenario(scenarioNamed("viewer-session"), { workerMs, focus: true, rule });
        const starts = run.looks.map((l) => l.at);
        const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
        expect(Math.min(...gaps), `${rule} W=${workerMs}`).toBeGreaterThanOrEqual(workerMs);
      }
    }
  });

  it("a pointer move never asks for looks closer than 250 ms", () => {
    for (const rule of RULES) {
      const hovers = runScenario(scenarioNamed("sweep-fan"), { workerMs: 200, focus: true, rule }).looks.filter((l) => l.trigger === "hover").map((l) => l.at);
      const gaps = hovers.slice(1).map((t, i) => t - hovers[i]!);
      expect(Math.min(...gaps), rule).toBeGreaterThanOrEqual(250);
    }
  });

  it("classifies a gap by whether 2 x (capture + analysis) fits the answer's lifetime", () => {
    const fits = runScenario(scenarioNamed("seek"), { workerMs: 400 }); // the seek drops the name until the next look
    expect(fits.gaps.length).toBeGreaterThan(0);
    expect(fits.gaps.every((g) => g.avoidable)).toBe(true);
    const tooSlow = runScenario(scenarioNamed("rest-past-grace"), { workerMs: 1700, hold: "none" });
    expect(tooSlow.gaps.length).toBeGreaterThan(0);
    expect(tooSlow.gaps.every((g) => !g.avoidable)).toBe(true);
  });

  it("under SHOWN_HOLD a gap is judged against the hold's lifetime: the W = 1700 blink is avoidable", () => {
    const run = runScenario(scenarioNamed("rest-past-grace"), { workerMs: 1700, hold: "shown" });
    expect(run.gaps.length).toBeGreaterThan(0);
    expect(run.gaps.every((g) => g.avoidable)).toBe(true);
  });

  it("counts a visit as eligible only when its dwell lasts one capture plus analysis, and censors unnamed ones at their dwell", () => {
    const run = runScenario(scenarioNamed("sweep-fan"), { workerMs: 1700, focus: true });
    expect(run.metrics.residences).toBe(5);
    expect(run.residences.map((r) => r.dwellMs)).toEqual([600, 1100, 1000, 1100, 1400]);
    expect(run.metrics.eligible).toBe(0); // every dwell is shorter than 1700 ms
    const slow = runScenario(scenarioNamed("viewer-session"), { workerMs: 1200, focus: true });
    expect(slow.metrics.eligible).toBe(3);
  });

  it("at 2x playback an analysis longer than the answer's lifetime in wall time names nothing", () => {
    const run = runScenario(scenarioNamed("rest-past-grace"), { workerMs: 1200, playbackRate: 2 });
    expect(run.metrics.unnamed).toBe(run.metrics.residences);
    // A visit never named is counted at its dwell, not dropped: one visit of 45 s.
    expect(run.metrics.eligible).toBe(1);
    expect(run.metrics.latencyAvgMs).toBe(45_000);
    expect(run.metrics.latencyMaxMs).toBe(45_000);
  });

  it("the displayed age is time-weighted and counts the time the name is on screen", () => {
    const run = runScenario(scenarioNamed("pointer-moving"), { workerMs: 500, rule: "strict", focus: true });
    expect(run.metrics.ageAvgMs!).toBeGreaterThan(500);
    expect(run.metrics.ageMaxMs!).toBeGreaterThan(run.metrics.ageAvgMs!);
    expect(run.metrics.shownMs).toBeGreaterThan(10_000);
  });

  it("a gap beside a look slower than the answer's life is unavoidable", () => {
    const run = runScenario(scenarioNamed("rest-past-grace"), { workerMs: [300, 300, 300, 2500], hold: "none" });
    expect(run.gaps.length).toBeGreaterThan(0);
    expect(run.gaps.every((g) => !g.avoidable)).toBe(true);
  });
});

describe("the candidate rules' spacings", () => {
  const inputs = { fastCadence: 500, lifetimeMs: 2000, pacedMs: () => 4000, roundTripMs: () => 1200 };
  it("current has none; strict is F for both; budgeted budgets the stale threshold only; budgeted+relook budgets both", () => {
    expect(ruleSpacingsMs("current", inputs)).toBeNull();
    expect(ruleSpacingsMs("strict", inputs)).toEqual({ staleMs: 500, relookMs: 500 });
    expect(ruleSpacingsMs("budgeted", inputs)).toEqual({ staleMs: 550, relookMs: 500 });
    expect(ruleSpacingsMs("budgeted+relook", inputs)).toEqual({ staleMs: 550, relookMs: 550 });
  });
  it("the budget uses the wall lifetime: 1000 ms at 2x", () => {
    expect(ruleSpacingsMs("budgeted", { ...inputs, lifetimeMs: 1000, roundTripMs: () => 100 })!.staleMs).toBe(650);
  });
});

describe("the candidate rules' budget", () => {
  it("B = max(F, min(P, A - R - M)) with A = 2000, M = 250", () => {
    expect(budgetedSpacingMs(500, 4000, 1200)).toBe(550);
    expect(budgetedSpacingMs(500, 4000, 200)).toBe(1550);
    expect(budgetedSpacingMs(500, 800, 200)).toBe(800); // the paced interval caps it
  });
  it("warm-up: with no round trip known it is the fixed fast cadence", () => {
    expect(budgetedSpacingMs(500, 4000, null)).toBe(500);
    expect(budgetedSpacingMs(1000, 4000, null)).toBe(1000);
  });
  it("a negative budget gives the fixed fast cadence", () => {
    expect(budgetedSpacingMs(500, 4000, 2500)).toBe(500);
  });
  it("a floor above the ceiling gives the floor", () => {
    expect(budgetedSpacingMs(1000, 500, 100)).toBe(1000);
  });
});

describe("pacing: an empty spot rests max(interval, 2000) (intended)", () => {
  // One move onto empty ground, then nothing: the grace period (10 s) runs, looks are cadence looks.
  const rest = custom({ durationMs: 9_500, events: [mv(0, 900, 450)] });
  const spacings = (rule: Rule, cfg: Partial<SlowClockConfig>): number[] => {
    const starts = runScenario(rest, { rule, ...cfg }).looks.map((l) => l.at);
    return starts.slice(1).map((t, i) => t - starts[i]!);
  };

  for (const rule of RULES) {
    it(`${rule}: pacing off, 500 ms cadence: 2000 ms between looks`, () => {
      const gaps = spacings(rule, { workerMs: 200, measuredPacing: false });
      expect(gaps.length).toBeGreaterThan(2);
      for (const g of gaps) expect(g).toBe(2000);
    });
    it(`${rule}: W = 200 paced to 800 ms: still 2000 ms`, () => {
      for (const g of spacings(rule, { workerMs: 200 })) expect(g).toBeGreaterThanOrEqual(2000);
      for (const g of spacings(rule, { workerMs: 200 })) expect(g).toBeLessThanOrEqual(2250);
    });
    it(`${rule}: W = 1200 paced to 4000 ms: the paced wait wins once measured`, () => {
      const gaps = spacings(rule, { workerMs: 1200 });
      expect(gaps.length).toBeGreaterThan(1);
      for (const g of gaps) expect(g).toBeGreaterThanOrEqual(2000);
      expect(gaps.at(-1)!).toBeGreaterThanOrEqual(4000);
      expect(gaps.at(-1)!).toBeLessThanOrEqual(4250);
    });
  }
});

describe("known behaviors of today's code, under the rule current (expected failures)", () => {
  // Blink: a resting pointer, SHOWN_HOLD, pacing on, playing, W between 1400 and 2000.
  // The reading wait (up to 6750 ms) outlasts what the hold keeps (5000 ms) plus a name's life.
  const rest1700 = () => runScenario(scenarioNamed("rest-past-grace"), { workerMs: 1700, hold: "shown", measuredPacing: true, rule: "current" });

  it("blink today: W = 1700, rest 45 s: 4 gaps of 1450 ms, 5800 ms in all", () => {
    const run = rest1700();
    expect(run.gaps.map((g) => g.lengthMs)).toEqual([1450, 1450, 1450, 1450]);
    expect(run.metrics.gapTotalMs).toBe(5800);
  });
  it("blink: the run has gaps to compare", () => {
    expect(rest1700().gaps.length).toBeGreaterThan(0);
  });
  it.fails("blink: old 5800 ms of gap, intended 0 (SHOWN_HOLD keeps the name through a rest)", () => {
    expect(rest1700().metrics.gapTotalMs).toBe(0);
  });

  // Relook spacing, no floor: a pointer arrives on an unverified card while a look is in
  // flight; the paced spacing (4 x W up to 4000) holds the focus re-look back.
  const warmed = (rule: Rule) => {
    const events: ScenarioEvent[] = [];
    for (let t = 0, i = 0; t <= 4000; t += 400, i++) events.push(mv(t, 200 + (i % 2) * 4, 250));
    events.push(mv(5400, 700, 250));
    return runScenario(custom({ durationMs: 14_000, events }), { workerMs: 800, focus: true, rule });
  };
  const latencyOnB = (rule: Rule): number => warmed(rule).residences.find((r) => r.card === "B")?.latencyMs ?? Infinity;

  it("relook spacing today: B, reached during a look, is named after 3900 ms", () => {
    const run = warmed("current");
    expect(run.looks.some((l) => l.at === 5250)).toBe(true); // a look is in flight when the pointer arrives
    expect(latencyOnB("current")).toBe(3900);
  });
  it.fails("relook spacing: old 3900 ms, intended at most 1600 ms (rest of the look + one re-look)", () => {
    expect(latencyOnB("current")).toBeLessThanOrEqual(1600);
  });
  it("relook spacing: under strict the same arrival is named within 1600 ms", () => {
    expect(latencyOnB("strict")).toBeLessThanOrEqual(1600);
  });

  // Stale threshold: the newest answer is older than 2000 ms but younger than the paced
  // interval (4000 ms): a move asks for nothing until the cadence.
  const staleMove = (rule: Rule) => {
    const events: ScenarioEvent[] = [];
    for (let t = 0, i = 0; t <= 2800; t += 400, i++) events.push(mv(t, 200 + (i % 2) * 4, 250));
    events.push(mv(4750, 700, 250));
    return runScenario(custom({ durationMs: 14_000, events }), { workerMs: 1200, focus: false, rule });
  };
  const staleLatency = (rule: Rule): number => staleMove(rule).residences.find((r) => r.card === "B")?.latencyMs ?? Infinity;

  it("stale threshold today: a move at video age 2250 ms names B after 2950 ms", () => {
    const run = staleMove("current");
    const lastBefore = Math.max(...run.looks.map((l) => l.at).filter((t) => t < 4750));
    expect(4750 - lastBefore).toBe(2250); // older than the 2000 ms max age, younger than the 4000 ms paced interval
    expect(staleLatency("current")).toBe(2950);
  });
  it.fails("stale threshold: old 2950 ms, intended at most 1400 ms (a look starts at the move)", () => {
    expect(staleLatency("current")).toBeLessThanOrEqual(1400);
  });
  it("stale threshold: under strict the same move is named in 1200 ms", () => {
    expect(staleLatency("strict")).toBe(1200);
  });

  // The back-off bypass: a look fails at 500, its retry is due at 750, a trusted move at 600. The
  // video presents a frame a second, so the cadence has no frame waiting.
  const backoff = (rule: Rule) => runScenario(scenarioNamed("retry-backoff"), { workerMs: 500, measuredPacing: false, rule });
  it("back-off bypass today: the move at 600 ms starts the second look", () => {
    expect(backoff("current").looks.slice(0, 2).map((l) => l.at)).toEqual([0, 600]);
  });
  it("back-off bypass: the run has a second look", () => {
    expect(backoff("current").looks.length).toBeGreaterThan(1);
  });
  it.fails("back-off bypass: old 600 ms, intended not before 750 ms (a move never shortens a back-off)", () => {
    expect(backoff("current").looks[1]?.at ?? -1).toBeGreaterThanOrEqual(750);
  });

  // The same bypass on the cadence path at a normal frame rate: `due()` starts a look on the
  // newly presented frame while the retry (due 250 ms after the failure) is still waiting.
  const backoff50 = () => runScenario(scenarioNamed("retry-backoff-50fps"), { workerMs: 500, measuredPacing: false, rule: "current" });
  it("back-off bypass at 50 fps today: the cadence starts the second look at 500 ms, 250 ms before the retry", () => {
    const run = backoff50();
    expect(run.looks.slice(0, 2).map((l) => [l.at, l.trigger])).toEqual([[0, "hover"], [500, "cadence"]]);
  });
  it("back-off bypass at 50 fps: the run has a second look", () => {
    expect(backoff50().looks.length).toBeGreaterThan(1);
  });
  it.fails("back-off bypass at 50 fps: old 500 ms, intended no look of any kind before a due retry (750 ms)", () => {
    expect(backoff50().looks[1]?.at ?? -1).toBeGreaterThanOrEqual(750);
  });
});
