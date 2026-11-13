// SPDX-License-Identifier: Apache-2.0
// The slow-clock harness (test/support/slow-clock.ts) and what it finds in the look scheduling.
// Four behaviors the harness found (the blink, the relook spacing, the stale threshold and the
// back-off bypass) were fixed by budgeted pacing; each is checked here under the rule "current"
// (the code as it is), with the value before the fix in its title. The empty-spot rest is
// intended and is an ordinary invariant. Nothing here reaches a network or a real clock.
import { describe, expect, it } from "vitest";

import {
  ABC,
  type CardSpec,
  budgetedSpacingMs,
  MAX_AGE_MS,
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

  it("under SHOWN_HOLD a gap is judged against the hold's lifetime: a seek's gap at W = 1200 is avoidable, without a hold it is not", () => {
    // 2 x 1200 is more than the answer's 2000 ms, and less than 2000 + the hold's 5000 ms.
    const shown = runScenario(scenarioNamed("seek"), { workerMs: 1200, hold: "shown" });
    expect(shown.gaps.length).toBeGreaterThan(0);
    expect(shown.gaps.every((g) => g.avoidable)).toBe(true);
    const none = runScenario(scenarioNamed("seek"), { workerMs: 1200, hold: "none" });
    expect(none.gaps.length).toBeGreaterThan(0);
    expect(none.gaps.every((g) => !g.avoidable)).toBe(true);
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

  it("under SHOWN_HOLD at 2x with a look of 1200 ms the gaps are unavoidable by the cycle clause alone", () => {
    // 2 x 1200 fits the hold's lifetime (1000 + 5000 ms), but a 1200 ms answer is over 1000 ms old (wall) on arrival.
    const run = runScenario(scenarioNamed("rest-past-grace"), { workerMs: [300, 1200], hold: "shown", playbackRate: 2 });
    expect(run.gaps.length).toBeGreaterThan(0);
    expect(run.gaps.every((g) => !g.avoidable)).toBe(true);
  });

  it("without a hold no answer on screen is older than the max age (plus one frame of display)", () => {
    for (const rule of RULES) {
      for (const focus of [false, true]) {
        for (const workerMs of [200, 1200, 1700]) {
          const age = runScenario(scenarioNamed("viewer-session"), { workerMs, hold: "none", focus, rule }).metrics.ageMaxMs;
          expect(age ?? 0, `${rule} focus=${focus} W=${workerMs}`).toBeLessThanOrEqual(MAX_AGE_MS + 20);
        }
      }
    }
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

describe("the code runs the budgeted rule", () => {
  it("current and budgeted give the same runs over the report's configurations", () => {
    const scenarios = [scenarioNamed("viewer-session"), scenarioNamed("pointer-moving"), scenarioNamed("rest-past-grace"), scenarioNamed("retry-backoff-50fps"), scenarioNamed("card-covered")];
    for (const scenario of scenarios) {
      for (const workerMs of [200, 800, 1700, VARYING_WORKER_MS]) {
        for (const backend of ["webgpu", "wasm"] as const) {
          for (const playbackRate of [0.5, 1, 1.25, 2]) {
            for (const hold of ["none", "shown", "reading"] as const) {
              const cfg: Partial<SlowClockConfig> = { workerMs, backend, playbackRate, hold, focus: true };
              const current = runScenario(scenario, { ...cfg, rule: "current" });
              const budgeted = runScenario(scenario, { ...cfg, rule: "budgeted" });
              expect([current.looks, current.metrics], `${scenario.name} ${JSON.stringify(cfg)}`).toEqual([budgeted.looks, budgeted.metrics]);
            }
          }
        }
      }
    }
  });
});

describe("what budgeted pacing fixed, under the rule current", () => {
  // Blink: a resting pointer, SHOWN_HOLD, pacing on, playing, W between 1400 and 2000. The reading
  // wait (up to 6750 ms) outlasted what the hold keeps (5000 ms) plus a name's life; the reading
  // deadline (S-P3) brings the next answer in first.
  const rest1700 = () => runScenario(scenarioNamed("rest-past-grace"), { workerMs: 1700, hold: "shown", measuredPacing: true, rule: "current" });

  it("blink: W = 1700, rest 45 s: no gap (before: 4 gaps of 1450 ms, 5800 ms in all)", () => {
    const run = rest1700();
    expect(run.gaps).toEqual([]);
    expect(run.metrics.gapTotalMs).toBe(0);
    expect(run.residences).toHaveLength(1);
    expect(run.residences[0]!.latencyMs).not.toBeNull();
  });
  it("blink: the reading looks come at the deadline, 2000 + 5000 - 1700 - 250 = 5050 ms, on the next tick", () => {
    const starts = rest1700().looks.map((l) => l.at).filter((t) => t > 12_000);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
    expect(gaps.length).toBeGreaterThan(3);
    for (const g of gaps) expect(g).toBe(5_250);
  });

  // Relook spacing: a pointer arrives on an unverified card while a look is in flight; the paced
  // spacing (4 x W up to 4000) held the focus re-look back. It is F now (S-C7).
  const arriving = (rule: Rule, at: number) => {
    const events: ScenarioEvent[] = [];
    for (let t = 0, i = 0; t <= Math.min(4000, at - 100); t += 400, i++) events.push(mv(t, 200 + (i % 2) * 4, 250));
    events.push(mv(at, 700, 250));
    return runScenario(custom({ durationMs: 14_000, events }), { workerMs: 800, focus: true, rule });
  };
  const latencyOnB = (rule: Rule, at = 5400): number => arriving(rule, at).residences.find((r) => r.card === "B")?.latencyMs ?? Infinity;

  it("relook spacing: B, reached at 5400 ms, is named in 800 ms (before: 3900 ms); the move itself asks, the picture being older than B", () => {
    const run = arriving("current", 5400);
    expect(run.looks.find((l) => l.at === 5400)?.trigger).toBe("hover");
    expect(latencyOnB("current")).toBe(800);
  });
  it("relook spacing: B, reached during a look in flight, is looked at on that look's reply (F after its start), and named within 1600 ms", () => {
    const run = arriving("current", 3300);
    const inFlight = run.looks.find((l) => l.at === 3200);
    expect(inFlight).toBeDefined(); // a look is in flight when the pointer arrives
    expect(run.looks.some((l) => l.at === 4000)).toBe(true); // its reply, 800 ms after its start
    expect(latencyOnB("current", 3300)).toBeLessThanOrEqual(1600);
    expect(latencyOnB("current", 3300)).toBe(latencyOnB("strict", 3300));
  });

  // Stale threshold: the newest answer is older than 2000 ms but younger than the paced interval
  // (4000 ms): a move asked for nothing until the cadence. The budget B is 550 ms here.
  const staleMove = (rule: Rule) => {
    const events: ScenarioEvent[] = [];
    for (let t = 0, i = 0; t <= 2800; t += 400, i++) events.push(mv(t, 200 + (i % 2) * 4, 250));
    events.push(mv(4750, 700, 250));
    return runScenario(custom({ durationMs: 14_000, events }), { workerMs: 1200, focus: false, rule });
  };
  const staleLatency = (rule: Rule): number => staleMove(rule).residences.find((r) => r.card === "B")?.latencyMs ?? Infinity;

  it("stale threshold: a move at video age 2250 ms names B in 1200 ms, a look starting at the move (before: 2950 ms)", () => {
    const run = staleMove("current");
    const lastBefore = Math.max(...run.looks.map((l) => l.at).filter((t) => t < 4750));
    expect(4750 - lastBefore).toBe(2250); // older than the 2000 ms max age, younger than the 4000 ms paced interval
    expect(run.looks.find((l) => l.at === 4750)?.trigger).toBe("hover");
    expect(staleLatency("current")).toBe(1200);
  });
  it("stale threshold: as under strict", () => {
    expect(staleLatency("strict")).toBe(1200);
  });

  // The back-off bypass: a look fails at 500, its retry is due at 750, a trusted move at 600. The
  // video presents a frame a second, so the cadence has no frame waiting.
  const backoff = (rule: Rule) => runScenario(scenarioNamed("retry-backoff"), { workerMs: 500, measuredPacing: false, rule });
  it("back-off: the move at 600 ms starts nothing; the second look is the retry at 750 ms (before: 600 ms)", () => {
    expect(backoff("current").looks.slice(0, 2).map((l) => l.at)).toEqual([0, 750]);
  });

  // The same on the cadence path at a normal frame rate: `due()` started a look on the newly
  // presented frame while the retry (due 250 ms after the failure) was still waiting.
  const backoff50 = () => runScenario(scenarioNamed("retry-backoff-50fps"), { workerMs: 500, measuredPacing: false, rule: "current" });
  it("back-off at 50 fps: no look of any kind before the due retry, 750 ms (before: the cadence at 500 ms)", () => {
    expect(backoff50().looks.slice(0, 2).map((l) => [l.at, l.trigger])).toEqual([[0, "hover"], [750, "cadence"]]);
  });

  it("back-off on the cut path: a cut while a retry waits starts nothing before it is due", () => {
    // A look fails at 500 (the retry is due at 750); at 600 the picture under the shown card
    // changes and the host reports a cut. A card was shown by an earlier look.
    const events: ScenarioEvent[] = [mv(0, 200, 250), mv(1_100, 204, 250), { at: 1_850, kind: "layout", cards: [{ id: "A", x: 100, y: 100, w: 200, h: 300 }] }];
    const run = runScenario(custom({ durationMs: 4_000, events, failLooks: [2] }), { workerMs: 500, measuredPacing: false, rule: "current" });
    const failed = run.looks[1]!.at; // the second look fails 500 ms after it starts
    const retryAt = failed + 500 + 250;
    expect(run.looks.filter((l) => l.at > failed).every((l) => l.at >= retryAt)).toBe(true);
    expect(run.looks.some((l) => l.at === retryAt)).toBe(true);
  });
});

describe("the shown hold's reading deadline (S-P3), and the other holds", () => {
  const restSpacing = (cfg: Partial<SlowClockConfig>): number[] => {
    const starts = runScenario(scenarioNamed("rest-past-grace"), { measuredPacing: true, ...cfg }).looks.map((l) => l.at).filter((t) => t > 13_000);
    return starts.slice(1).map((t, i) => t - starts[i]!);
  };

  it("SHOWN_HOLD, W = R = 1600: the wait is min(6400, 2000 + 5000 - 1600 - 250) = 5150 ms, on the next tick", () => {
    const gaps = restSpacing({ workerMs: 1600, hold: "shown" });
    expect(gaps.length).toBeGreaterThan(3);
    for (const g of gaps) expect(g).toBe(5_250);
    expect(runScenario(scenarioNamed("rest-past-grace"), { workerMs: 1600, hold: "shown" }).gaps).toEqual([]);
  });

  it("SHOWN_HOLD at 1.25x, W = R = 1500: min(6000, 1600 + 5000 - 1500 - 250) = 4850 ms, on the next tick", () => {
    const gaps = restSpacing({ workerMs: 1500, hold: "shown", playbackRate: 1.25 });
    expect(gaps.length).toBeGreaterThan(3);
    for (const g of gaps) expect(g).toBe(5_000);
    expect(runScenario(scenarioNamed("rest-past-grace"), { workerMs: 1500, hold: "shown", playbackRate: 1.25 }).gaps).toEqual([]);
  });

  it("SHOWN_HOLD with a fast computer: the slow cadence (1000 ms) is the floor, the paced wait the cap", () => {
    for (const g of restSpacing({ workerMs: 200, hold: "shown" })) expect(g).toBe(1_000);
    for (const g of restSpacing({ workerMs: 600, hold: "shown" })) expect(g).toBe(2_500); // paced 2400, under 2000 + 5000 - 600 - 250
  });

  it("no hold keeps the paced reading wait: W = 1600 waits 6400 ms, on the next tick", () => {
    const gaps = restSpacing({ workerMs: 1600, hold: "none" });
    expect(gaps.length).toBeGreaterThan(2);
    for (const g of gaps) expect(g).toBe(6_500);
  });

  it("the reading hold: no look while the pointer rests on the kept card", () => {
    expect(restSpacing({ workerMs: 1600, hold: "reading" })).toEqual([]);
    expect(runScenario(scenarioNamed("rest-past-grace"), { workerMs: 1600, hold: "reading", measuredPacing: true }).looks.filter((l) => l.at > 13_000)).toEqual([]);
  });

  // The evidence changes under a resting pointer, with no cut reported (an extension's content
  // script reports none): the card at the pointer goes, or another takes its place.
  const changed = (hold: "none" | "shown" | "reading", cards: CardSpec[]) =>
    runScenario(custom({ durationMs: 40_000, events: [...jiggleOnA(400, 2000), { at: 20_000, kind: "layout", cards, cut: false }] }), { workerMs: 1600, hold, measuredPacing: true });
  const GONE: CardSpec[] = [{ id: "C", x: 350, y: 100, w: 200, h: 300 }];
  const REPLACED: CardSpec[] = [{ id: "D", x: 100, y: 100, w: 200, h: 300 }];

  it("SHOWN_HOLD: a card that goes stops showing within the hold: 5000 ms after the last answer that saw it expired (its picture + 2000 ms), plus a tick", () => {
    const run = changed("shown", GONE);
    const lastPicture = Math.max(...run.looks.map((l) => l.at).filter((t) => t < 20_000));
    const off = run.shown.find((c) => c.at >= 20_000 && c.cardId === null);
    expect(off).toBeDefined();
    expect(off!.at).toBeLessThanOrEqual(lastPicture + MAX_AGE_MS + 5_000 + 250);
    expect(run.shown.at(-1)!.cardId).toBeNull();
  });

  it("SHOWN_HOLD: a card replaced in place is named at the next look's answer", () => {
    const run = changed("shown", REPLACED);
    const next = run.looks.map((l) => l.at).find((t) => t >= 20_000)!;
    expect(run.shown.find((c) => c.at >= 20_000 && c.cardId === "D")?.at).toBe(next + 1600);
    expect(next - 20_000).toBeLessThanOrEqual(5_250);
  });

  it("no hold: a card that goes stops showing when its answer is too old, and a replacement is named at the next answer", () => {
    const gone = changed("none", GONE);
    expect(gone.shown.at(-1)!.cardId).toBeNull();
    const replaced = changed("none", REPLACED);
    expect(replaced.shown.some((c) => c.at >= 20_000 && c.cardId === "D")).toBe(true);
  });

  it("the reading hold: the kept card stays while the pointer rests (it is the viewer's to move), and leaving and coming back names the new card", () => {
    const run = changed("reading", REPLACED);
    expect(run.shown.filter((c) => c.at >= 20_000)).toEqual([]);
    const moved = runScenario(
      custom({ durationMs: 40_000, events: [...jiggleOnA(400, 2000), { at: 20_000, kind: "layout", cards: REPLACED, cut: false }, mv(25_000, 900, 450), mv(25_400, 200, 250)] }),
      { workerMs: 1600, hold: "reading", measuredPacing: true },
    );
    expect(moved.shown.some((c) => c.at >= 25_000 && c.cardId === "D")).toBe(true);
  });
});
