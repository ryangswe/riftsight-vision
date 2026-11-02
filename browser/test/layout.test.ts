// SPDX-License-Identifier: Apache-2.0
// Layout registration beyond the contract cases: the correspondence cap, order independence,
// the recording reader and the replay driver.

import { describe, expect, it } from "vitest";

import { FrameScheduler } from "../src/frame-scheduler.js";
import { correspondences, fitFrame, type Layout, LAYOUT_FIT_DEFAULTS, type Observation, project, type Transform } from "../src/layout-fit.js";
import {
  latestOffered,
  type LayoutRecording,
  offeredCandidates,
  readLayoutRecording,
  recordingSource,
  replayRecording,
  sceneAt,
  timedFrames,
  truthCandidate,
  truthUsable,
} from "../src/layout-recording.js";
import { type LayoutConfig, LayoutRegistration } from "../src/layout-state.js";

const CONFIG: LayoutConfig = {
  fitMinIoU: 0.7,
  minSpan: 0.3,
  confirmFits: 2,
  confirmWindowMs: 15_000,
  holdMs: 30_000,
  freshnessMs: 12_000,
  intervalMs: 3_000,
  suppressionIoU: 0.3,
};
const PARAMS = { ...LAYOUT_FIT_DEFAULTS, fitMinIoU: 0.7, minSpan: 0.3 };
const T: Transform = { sx: 0.6, sy: 0.6, tx: 0.2, ty: 0.1 };

/** A grid of `cols` × `rows` cards with identities c0, c1, … */
function grid(cols: number, rows: number): Layout {
  const cards = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      cards.push({ instance: `i${k}`, identity: `c${String(k).padStart(2, "0")}`, bounds: { x: i / cols + 0.01, y: j / rows + 0.01, w: 0.8 / cols, h: 0.8 / rows } });
    }
  }
  return { key: `grid${cols}x${rows}`, cards };
}
const placed = (layout: Layout, t: Transform): Observation[] =>
  layout.cards.map((c) => ({ identity: c.identity!, bounds: project(t, c.bounds) }));

describe("the fit", () => {
  it("scores at most 40 correspondences, the largest frame boxes first", () => {
    const layout = grid(10, 5);
    const obs = placed(layout, T).map((o, k) => ({ ...o, bounds: { ...o.bounds, w: o.bounds.w * (k < 10 ? 0.5 : 1) } }));
    const cs = correspondences(obs, layout);
    expect(cs).toHaveLength(40);
    // The ten halved boxes are the smallest: left out.
    expect(cs.map((c) => c.identity)).not.toContain("c00");
    expect(cs.map((c) => c.identity)).toEqual([...cs.map((c) => c.identity)].sort());
  });

  it("does not depend on the order of the observations or the layout's cards", () => {
    const layout = grid(4, 3);
    const obs = placed(layout, T);
    obs[5] = { identity: obs[5]!.identity, bounds: { x: 0.01, y: 0.9, w: 0.05, h: 0.05 } };
    const a = fitFrame(obs, layout, PARAMS);
    const b = fitFrame([...obs].reverse(), { ...layout, cards: [...layout.cards].reverse() }, PARAMS);
    expect(b).toEqual(a);
    expect(a.kind).toBe("verified");
  });

  it("fits 40 correspondences quickly", () => {
    const layout = grid(8, 5);
    const obs = placed(layout, T);
    const start = performance.now();
    for (let k = 0; k < 50; k++) fitFrame(obs, layout, PARAMS);
    // About 2 ms an analysis is the target on a laptop core; this only guards against a blow-up.
    expect((performance.now() - start) / 50).toBeLessThan(20);
  });
});

describe("the state machine", () => {
  it("drops a reply from another generation and before the first reset", () => {
    const m = new LayoutRegistration(CONFIG);
    const layout = grid(3, 2);
    const input = { generation: 1, capturedAtMs: 0, faces: 6, observations: placed(layout, T), layout, windowIdentities: new Set<string>() };
    expect(m.analyze(input, 0)).toBeNull();
    m.reset(7, 0);
    expect(m.analyze(input, 0)).toBeNull();
    expect(m.analyze({ ...input, generation: 7 }, 0)).not.toBeNull();
  });

  it("freezes its configuration", () => {
    const m = new LayoutRegistration(CONFIG);
    expect(Object.isFrozen(m.config)).toBe(true);
  });
});

// A small recording: 10 frames a second for 20 s, the six-card layout placed by T throughout,
// one candidate arriving at 500 ms.
function recording(durationMs = 400): LayoutRecording {
  const layout = grid(3, 2);
  const frames = [];
  for (let k = 0; k < 200; k++) {
    frames.push({
      index: k,
      capturedAtMs: k * 100,
      image: `frames/${String(k).padStart(6, "0")}.png`,
      clock: k % 50 === 7 ? { status: "undecodable" } : { status: "ok", streamTimeMs: 90_000 + k * 100 },
      analysis: { durationMs, faces: 6, observations: placed(layout, T) },
    });
  }
  return readLayoutRecording({
    schema: "layout-recording/1",
    frame: { width: 1920, height: 1080 },
    cadenceProfiles: [
      { name: "fast", intervalMs: 3000 },
      { name: "slow", intervalMs: 4000 },
    ],
    scenes: [
      {
        id: "s1",
        class: "supported-game",
        startMs: 0,
        endMs: 20_000,
        truth: { region: { x: 0.2, y: 0.1, width: 0.6, height: 0.6 }, residualPx: 0.8, mask: { x: 0, y: 0, w: 1, h: 1 }, blockers: [], solves: [{ atMs: 0, residualPx: 0.8, region: { x: 0.2, y: 0.1, width: 0.6, height: 0.6 } }] },
      },
    ],
    frames,
    candidates: [
      { key: "k1", producedAtMs: 89_000, arrivedAtMs: 500, layout },
      { key: "k2", producedAtMs: 95_000, arrivedAtMs: 6000, layout },
    ],
  });
}

describe("the recording reader", () => {
  it("reads a recording and enforces the causal rule", () => {
    const rec = recording();
    expect(offeredCandidates(rec, 400)).toEqual([]);
    expect(latestOffered(rec, 500)?.key).toBe("k1");
    expect(latestOffered(rec, 6000)?.key).toBe("k2");
    // Truth: produced nearest before the frame's stream clock.
    expect(truthCandidate(rec, rec.frames[0]!)?.key).toBe("k1");
    expect(truthCandidate(rec, rec.frames[60]!)?.key).toBe("k2");
    expect(truthCandidate(rec, rec.frames[7]!)).toBeNull();
    expect(timedFrames(rec).excluded).toBe(4);
    expect(sceneAt(rec, 19_999)?.id).toBe("s1");
    expect(sceneAt(rec, 20_000)).toBeNull();
    expect(truthUsable(rec.scenes[0]!, rec.frame)).toBe(true);
    expect(rec.problems).toEqual([]);
  });

  it("marks truth unusable over 2 px, or when two solves disagree by more", () => {
    const rec = recording();
    const scene = rec.scenes[0]!;
    const t = scene.truth!;
    const r = t.region!;
    const solve = (dx: number, residualPx = 1) => ({ atMs: 5, residualPx, region: { ...r, x: r.x + dx / 1920 } });
    expect(truthUsable({ ...scene, truth: { ...t, residualPx: 2.5 } }, rec.frame)).toBe(false);
    expect(truthUsable({ ...scene, truth: { ...t, solves: [solve(0, 3)] } }, rec.frame)).toBe(false);
    expect(truthUsable({ ...scene, truth: { ...t, solves: [solve(0), solve(1.9)] } }, rec.frame)).toBe(true);
    expect(truthUsable({ ...scene, truth: { ...t, solves: [solve(0), solve(2.1)] } }, rec.frame)).toBe(false);
    expect(truthUsable({ ...scene, truth: undefined }, rec.frame)).toBe(false);
  });

  it("sets aside a malformed clock or truth, and says so", () => {
    const base = { schema: "layout-recording/1", frame: { width: 1920, height: 1080 }, cadenceProfiles: [], candidates: [] };
    const analysis = { durationMs: 1, faces: 0, observations: [] };
    const rec = readLayoutRecording({
      ...base,
      scenes: [{ id: "s", class: "transition", startMs: 0, endMs: 1, truth: { region: { x: 0 }, residualPx: 1, mask: { x: 0, y: 0, w: 1, h: 1 } } }],
      frames: [
        { index: 0, capturedAtMs: 0, image: "a", clock: null, analysis },
        { index: 1, capturedAtMs: 1, image: "b", clock: { status: "garbled", streamTimeMs: 5 }, analysis },
        { index: 2, capturedAtMs: 2, image: "c", clock: { status: "ok", streamTimeMs: null }, analysis },
        { index: 3, capturedAtMs: 3, image: "d", clock: { status: "ok", streamTimeMs: 7 }, analysis },
      ],
    });
    expect(rec.scenes[0]!.truth).toBeUndefined();
    expect(rec.frames.map((f) => f.clock.status)).toEqual(["missing", "missing", "missing", "ok"]);
    expect(timedFrames(rec).excluded).toBe(3);
    expect(rec.problems).toHaveLength(4);
    expect(rec.problems[0]).toContain("recording.scenes[0].truth.region.y");
  });

  it("ignores keys it does not know, at every level", () => {
    const rs = { rs: { anything: [1, 2] } };
    const rec = readLayoutRecording({
      ...rs,
      schema: "layout-recording/1",
      frame: { width: 1920, height: 1080, ...rs },
      cadenceProfiles: [{ name: "fast", intervalMs: 3000, ...rs }],
      scenes: [{ id: "s", class: "negative-gallery", startMs: 0, endMs: 1, truth: { region: null, residualPx: null, mask: { x: 0, y: 0, w: 1, h: 1 }, ...rs }, ...rs }],
      frames: [{ index: 0, capturedAtMs: 0, image: "f", clock: { status: "ok", streamTimeMs: 5, ...rs }, analysis: { durationMs: 1, faces: 0, observations: [], ...rs }, ...rs }],
      candidates: [{ key: "k", producedAtMs: 0, arrivedAtMs: 0, layout: { key: "l", cards: [{ instance: "i", bounds: { x: 0, y: 0, w: 0.1, h: 0.1 }, ...rs }], ...rs }, ...rs }],
    });
    expect(rec.problems).toEqual([]);
    expect(truthUsable(rec.scenes[0]!, rec.frame)).toBeNull();
    expect(JSON.stringify(rec)).not.toContain("anything");
  });

  it.each([
    [{ schema: "layout-recording/2" }, "recording.schema"],
    [{ scenes: [{ id: "s", class: "unknown", startMs: 0, endMs: 1 }] }, "recording.scenes[0].class"],
    [{ frames: [{ index: 0, capturedAtMs: 5, image: "a", clock: { status: "missing" }, analysis: { durationMs: 1, faces: 0, observations: [] } }, { index: 1, capturedAtMs: 4, image: "b", clock: { status: "missing" }, analysis: { durationMs: 1, faces: 0, observations: [] } }] }, "recording.frames[1].capturedAtMs"],
    [{ frames: [{ index: 0, capturedAtMs: 0, image: "a", clock: { status: "missing" }, analysis: { durationMs: -1, faces: 0, observations: [] } }] }, "recording.frames[0].analysis.durationMs"],
    [{ candidates: [{ key: "k", producedAtMs: 0, arrivedAtMs: 0, layout: { key: "l", cards: [{ instance: "i", bounds: { x: 0, y: 0, w: -1, h: 1 } }] } }] }, "recording.candidates[0].layout.cards[0].bounds.w"],
  ] as Array<[Record<string, unknown>, string]>)("names the first bad field: %j", (patch, path) => {
    const base = { schema: "layout-recording/1", frame: { width: 1920, height: 1080 }, cadenceProfiles: [], scenes: [], frames: [], candidates: [] };
    expect(() => readLayoutRecording({ ...base, ...patch })).toThrow(path);
  });
});

describe("the replay driver", () => {
  const layoutScheduler = (intervalMs: number) => new FrameScheduler(500, 3, "layout", 1000, intervalMs);

  it("replays through the probe: fitted once the second analysis has ended", () => {
    const rec = recording();
    const replay = replayRecording(rec, { config: CONFIG, profile: "fast", scheduler: layoutScheduler });
    expect(replay.analyses.map((a) => a.startedAtMs).slice(0, 4)).toEqual([0, 3000, 6000, 9000]);
    expect(replay.analyses.every((a) => !a.late)).toBe(true);
    const at = (ms: number) => replay.steps.find((s) => s.atMs === ms)!.result;
    // No candidate had arrived for the frame at 0 ms; frames at 3000 and 6000 fit.
    expect(at(3300).display).toBe("today");
    expect(at(6300).display).toBe("today");
    expect(at(6400).display).toBe("fitted");
    expect(replay.steps).toHaveLength(200);
  });

  it("uses the profile's interval and marks late analyses", () => {
    const rec = recording(3500);
    const replay = replayRecording(rec, { config: CONFIG, profile: "slow", scheduler: layoutScheduler });
    // Each analysis takes 3.5 s: the next starts at the first frame after it ends that is due.
    expect(replay.analyses.map((a) => a.startedAtMs).slice(0, 3)).toEqual([0, 4000, 8000]);
    const fast = replayRecording(rec, { config: CONFIG, profile: "fast", scheduler: layoutScheduler });
    expect(fast.analyses[0]!.late).toBe(true);
    expect(fast.analyses.map((a) => a.startedAtMs).slice(0, 3)).toEqual([0, 3500, 7000]);
  });

  it("refuses an unknown profile", () => {
    expect(() => replayRecording(recording(), { config: CONFIG, profile: "medium", scheduler: layoutScheduler })).toThrow("medium");
  });

  it("takes layouts from the source it is given", () => {
    const rec = recording();
    const source = recordingSource(rec);
    expect(source.layoutAt(0)).toBeNull();
    expect([...source.windowIdentitiesAt(600)].sort()).toEqual(["c00", "c01", "c02", "c03", "c04", "c05"]);
    const none = replayRecording(rec, {
      config: CONFIG,
      profile: "fast",
      scheduler: layoutScheduler,
      source: { layoutAt: () => null, windowIdentitiesAt: () => new Set() },
    });
    expect(none.steps.every((s) => s.result.display === "today")).toBe(true);
  });
});
