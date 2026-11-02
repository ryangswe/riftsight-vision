// SPDX-License-Identifier: Apache-2.0
// Runs test/fixtures/layout-contract.json against the layout registration modules. The file
// is built by scripts/layout-contract.mjs with hand-written expectations; this checks the
// implementation against it, and that the file is current.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FrameScheduler } from "../src/frame-scheduler.js";
import { compatible, fitFrame, fitFrameDetail, type Layout, LAYOUT_FIT_DEFAULTS, layoutExtent, type Observation, project, toRegion, type Transform } from "../src/layout-fit.js";
import { classifyAccept, classifyHitbox, coverage, exitLatency, fitError } from "../src/layout-metrics.js";
import { clockUsable, latestOffered, offeredCandidates, readLayoutRecording, truthCandidate, truthUsable } from "../src/layout-recording.js";
import { type FrameInput, type LayoutConfig, LayoutRegistration, type Verdict } from "../src/layout-state.js";
import { MismatchMonitor } from "../src/mismatch-monitor.js";
// @ts-expect-error: a plain script without types
import { layoutContractText } from "../scripts/layout-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, "fixtures", "layout-contract.json"), "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const contract: any = JSON.parse(text);
const TOL: number = contract.tolerance;
// Cases written against the same definition by a second, independent implementation, with
// hand-written expectations (same step format): running them here shows the two agree.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const shared: any = JSON.parse(readFileSync(join(here, "fixtures", "layout-shared-cases.json"), "utf8"));

type LayoutRef = string | Layout | null;
const layoutOf = (ref: LayoutRef): Layout | null =>
  typeof ref === "string" ? (contract.layouts[ref] ?? shared.layouts[ref]) : ref;

function expectTransform(actual: Transform, want: Transform, tol = TOL): void {
  for (const k of ["sx", "sy", "tx", "ty"] as const) expect(Math.abs(actual[k] - want[k])).toBeLessThanOrEqual(tol);
}

interface Step {
  op: "reset" | "lost" | "analyze" | "tick";
  now: number;
  generation?: number;
  input?: Omit<FrameInput, "layout" | "windowIdentities"> & { layout: LayoutRef; windowIdentities: string[] };
  expect?: Partial<{
    state: string;
    display: string;
    contradicted: boolean;
    row: number;
    dropped: boolean;
    runLength: number;
    region: object;
    suppressed: string[];
    frameKind: string;
    frameReason: string;
    n: number;
    transform: Transform;
    monitorShare: number | null;
  }>;
}

function play(machine: LayoutRegistration, step: Step): Verdict | null {
  switch (step.op) {
    case "reset":
      return machine.reset(step.generation!, step.now);
    case "lost":
      return machine.eligibilityLost(step.now);
    case "tick":
      return machine.tick(step.now);
    case "analyze": {
      const i = step.input!;
      return machine.analyze({ ...i, layout: layoutOf(i.layout), windowIdentities: new Set(i.windowIdentities) }, step.now);
    }
  }
}

function check(machine: LayoutRegistration, step: Step, result: Verdict | null, where: string): void {
  const want = step.expect;
  if (!want) return;
  if (want.dropped !== undefined) expect(result === null, `${where}: dropped`).toBe(want.dropped);
  const v = result ?? machine.verdict;
  if (want.state !== undefined) expect(v.state, `${where}: state`).toBe(want.state);
  if (want.display !== undefined) expect(v.display, `${where}: display`).toBe(want.display);
  if (want.contradicted !== undefined) expect(v.contradicted, `${where}: contradicted`).toBe(want.contradicted);
  if (want.row !== undefined) expect(v.diagnostics.row, `${where}: row`).toBe(want.row);
  if (want.runLength !== undefined) expect(v.diagnostics.runLength, `${where}: runLength`).toBe(want.runLength);
  if (want.suppressed !== undefined) expect(v.suppressed, `${where}: suppressed`).toEqual(want.suppressed);
  const frame = v.frame as { kind: string; reason?: string; n?: number; transform?: Transform };
  if (want.frameKind !== undefined) expect(frame.kind, `${where}: frame`).toBe(want.frameKind);
  if (want.frameReason !== undefined) expect(frame.reason, `${where}: frame reason`).toBe(want.frameReason);
  if (want.n !== undefined) expect(frame.n, `${where}: n`).toBe(want.n);
  if (want.transform !== undefined) expectTransform(frame.transform!, want.transform);
  if (want.monitorShare !== undefined) {
    if (want.monitorShare === null) expect(v.diagnostics.monitorShare, `${where}: monitorShare`).toBeNull();
    else expect(Math.abs(v.diagnostics.monitorShare! - want.monitorShare), `${where}: monitorShare`).toBeLessThanOrEqual(TOL);
  }
  if (want.region !== undefined) {
    const r = v.region!;
    const w = want.region as Record<string, number>;
    for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(r[k] - w[k]!), `${where}: region.${k}`).toBeLessThanOrEqual(TOL);
  }
  expect(v.region !== undefined, `${where}: region iff fitted`).toBe(v.display === "fitted");
}

function runSteps(steps: Step[], config: LayoutConfig, exclude?: string[]): LayoutRegistration {
  const machine = new LayoutRegistration(config, exclude ? { exclude: (id) => exclude.includes(id) } : {});
  steps.forEach((step, k) => check(machine, step, play(machine, step), `step ${k} (${step.op} @${step.now})`));
  return machine;
}

describe("layout contract fixture", () => {
  it("is what scripts/layout-contract.mjs builds", () => {
    expect(text).toBe(layoutContractText());
  });
});

describe("G1, G2: frame fits", () => {
  const params = { ...LAYOUT_FIT_DEFAULTS, fitMinIoU: contract.config.fitMinIoU, minSpan: contract.config.minSpan };
  for (const c of contract.fits) {
    it(c.name, () => {
      const detail = fitFrameDetail(c.observations as Observation[], layoutOf(c.layout), { ...params, ...(c.config ?? {}) }, c.frameAspect);
      const out = detail.outcome;
      if (c.expect.aspectRejected) {
        expect(detail.aspectRejected.map((i) => detail.correspondences[i]!.identity)).toEqual(c.expect.aspectRejected);
      }
      const want = c.expect;
      expect(out.kind).toBe(want.kind);
      if (out.kind === "no-layout") return;
      expect(out.n).toBe(want.n);
      if (out.kind === "insufficient") {
        expect(out.reason).toBe(want.reason);
        expect(out.inliers).toBe(want.inliers);
        return;
      }
      expect(out.inliers).toEqual(want.inliers);
      if (want.transform) expectTransform(out.transform, want.transform);
      if (out.kind === "ambiguous") expect(out.runnerUp).toEqual(want.runnerUp);
      if (out.kind === "verified") {
        if (want.minIoU !== undefined) expect(Math.abs(out.minIoU - want.minIoU)).toBeLessThanOrEqual(TOL);
        if (want.span) for (const k of [0, 1]) expect(Math.abs(out.span[k]! - want.span[k])).toBeLessThanOrEqual(TOL);
      }
    });
  }
});

describe("G3vi: every state and event takes the intended row", () => {
  it("covers every pair once", () => {
    expect(contract.intent.length).toBe(contract.states.length * contract.events.length);
    const keys = new Set(contract.intent.map((c: { state: string; event: string }) => `${c.state}|${c.event}`));
    expect(keys.size).toBe(contract.intent.length);
  });
  for (const c of contract.intent) {
    if (c.na) continue;
    it(`${c.state} × ${c.event} → ${c.row === "dropped" ? "dropped" : `row ${c.row}`}`, () => {
      const machine = runSteps(contract.setups[c.setup], contract.config);
      expect(machine.state, "the setup reaches the state").toBe(c.machineState);
      for (const [k, step] of (c.steps as Step[]).entries()) {
        const verdict = play(machine, step);
        const last = k === c.steps.length - 1;
        // Steps before the event keep the state.
        if (!last) expect(machine.state, `step ${k} keeps the state`).toBe(c.machineState);
        check(machine, step, verdict, `event step ${k}`);
      }
    });
  }
});

describe("G3, G4: traces", () => {
  for (const t of contract.traces) {
    it(t.name, () => {
      runSteps(t.steps, { ...contract.config, ...(t.config ?? {}) }, t.exclude);
    });
  }
});

describe("shared cases", () => {
  for (const t of shared.traces) {
    it(t.name, () => {
      runSteps(t.steps, contract.config);
    });
  }
  for (const c of shared.hitboxes) {
    it(`${c.name}: classifyHitbox`, () => {
      expect(classifyHitbox(c.h, c.truth, c.mask, c.blockers)).toBe(c.expect);
    });
  }
});

describe("configuration", () => {
  it("accepts the contract's configuration, with or without ambiguityMin", () => {
    expect(() => new LayoutRegistration(contract.config)).not.toThrow();
    expect(() => new LayoutRegistration({ ...contract.config, ambiguityMin: 3 })).not.toThrow();
    expect(() => new LayoutRegistration({ ...contract.config, scaleRatioTol: 0.03 })).not.toThrow();
  });
  for (const c of contract.configErrors) {
    it(`refuses ${c.name}`, () => {
      expect(() => new LayoutRegistration(c.config)).toThrow(c.error);
    });
  }
});

describe("G4: compatibility", () => {
  for (const c of contract.compat) {
    it(c.name, () => {
      expect(compatible(c.a, c.b, layoutExtent(layoutOf(c.layout)!)!)).toBe(c.compatible);
    });
  }
});

describe("G5: toRegion is the product's region mapping", () => {
  for (const t of contract.regions.transforms as Transform[]) {
    for (const b of contract.regions.boxes) {
      it(`${JSON.stringify(t)} ${JSON.stringify(b)}`, () => {
        const r = toRegion(t);
        const p = project(t, b);
        const q = { x: r.x + b.x * r.width, y: r.y + b.y * r.height, w: b.w * r.width, h: b.h * r.height };
        for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(p[k] - q[k])).toBeLessThanOrEqual(contract.regions.tolerance);
      });
    }
  }
});

describe("the mismatch monitor", () => {
  for (const c of contract.monitor) {
    it(c.name, () => {
      const m = new MismatchMonitor(c.exclude ? { exclude: (id: string) => c.exclude.includes(id) } : {});
      for (const s of c.steps) {
        const out = m.observe({ windowIdentities: new Set(s.window), accepted: s.accepted });
        for (const [k, v] of Object.entries(s.expect)) {
          if (k === "share") expect(Math.abs(out.share! - (v as number))).toBeLessThanOrEqual(TOL);
          else expect(out[k as keyof typeof out], k).toBe(v);
        }
      }
    });
  }
});

describe("the recording reader", () => {
  const rec = contract.recording;
  const base = { schema: "layout-recording/1", frame: rec.frame, cadenceProfiles: [], candidates: [] };
  const analysis = { durationMs: 1, faces: 0, observations: [] };
  for (const c of rec.clocks) {
    it(`clock: ${c.name}`, () => {
      const r = readLayoutRecording({ ...base, scenes: [], frames: [{ index: 0, capturedAtMs: 0, image: "f", clock: c.clock, analysis }] });
      expect(r.frames[0]!.clock.status).toBe(c.status);
      expect(clockUsable(r.frames[0]!.clock)).toBe(c.usable);
      expect(r.problems.length).toBe(c.problem ? 1 : 0);
    });
  }
  for (const c of rec.scenes) {
    it(`scene: ${c.name}`, () => {
      const r = readLayoutRecording({ ...base, frames: [], scenes: [{ id: "s", class: "supported-game", startMs: 0, endMs: 1, truth: c.truth }] });
      expect(truthUsable(r.scenes[0]!, rec.frame)).toBe(c.usable);
      expect(r.problems.length).toBe(c.problem ? 1 : 0);
    });
  }
  it("offers a frame only the candidates that had arrived; the truth is the one produced nearest before its clock", () => {
    const layout = { key: "l", cards: [] };
    const r = readLayoutRecording({
      ...base,
      scenes: [],
      candidates: rec.causal.candidates.map((c: object) => ({ ...c, layout })),
      frames: rec.causal.frames.map((f: { capturedAtMs: number; streamTimeMs: number }, i: number) => ({
        index: i,
        capturedAtMs: f.capturedAtMs,
        image: "f",
        clock: { status: "ok", streamTimeMs: f.streamTimeMs },
        analysis,
      })),
    });
    rec.causal.frames.forEach((f: { capturedAtMs: number; offered: string[]; latest: string | null; truth: string }, i: number) => {
      expect(offeredCandidates(r, f.capturedAtMs).map((c) => c.key)).toEqual(f.offered);
      expect(latestOffered(r, f.capturedAtMs)?.key ?? null).toBe(f.latest);
      expect(truthCandidate(r, r.frames[i]!)?.key).toBe(f.truth);
    });
  });
});

describe("metric primitives", () => {
  for (const c of contract.metrics.fitError) {
    it(`fitError: ${c.name}`, () => {
      const e = fitError(c.t, c.truth, layoutExtent(layoutOf(c.layout)!)!, c.width, c.height);
      expect(Math.abs(e - c.expect)).toBeLessThanOrEqual(TOL);
    });
  }
  it("classifyAccept", () => {
    for (const c of contract.metrics.classifyAccept) expect(classifyAccept(c.errorPx, c.displayed)).toBe(c.expect);
  });
  for (const c of contract.metrics.classifyHitbox) {
    it(`classifyHitbox: ${c.name}`, () => {
      expect(classifyHitbox(c.h, c.truth, c.mask, c.blockers)).toBe(c.expect);
    });
  }
  for (const c of contract.metrics.coverage) {
    it(`coverage: ${c.name}`, () => {
      expect(coverage(c.truth, c.hitboxes, c.mask, c.blockers)).toBe(c.expect);
    });
  }
  for (const c of contract.metrics.exitLatency) {
    it(`exitLatency: ${c.name}`, () => {
      expect(exitLatency(c.trace, c.boundaries)).toEqual(c.expect);
    });
  }
});

describe("the probe in the scheduler's layout mode", () => {
  for (const c of contract.cadence) {
    it(c.name, () => {
      const s = c.scheduler;
      const make = () => new FrameScheduler(s.intervalMs, s.confirmFrames, s.mode, s.readingIntervalMs, s.probeIntervalMs);
      if (c.throws) {
        expect(make).toThrow();
        return;
      }
      const sched = make();
      for (const [k, step] of (c.steps as Array<Record<string, unknown>>).entries()) {
        const where = `step ${k} (${String(step.op)})`;
        const now = step.now as number;
        switch (step.op) {
          case "present":
            sched.framePresented();
            break;
          case "start":
            sched.started(now);
            break;
          case "pointerMoved":
            sched.pointerMoved(now);
            break;
          case "pointerAnalysis":
            sched.setPointerAnalysis(step.on as boolean);
            break;
          case "due":
            expect(sched.due(now), where).toBe(step.expect);
            break;
          case "state":
            expect(sched.analysisState(now), where).toBe(step.expect);
            break;
          case "hoverDue":
            expect(sched.hoverTriggerDue(now, step.videoTimeSec as number, step.inFlight as boolean), where).toBe(step.expect);
            break;
          default:
            throw new Error(`unknown op ${String(step.op)}`);
        }
      }
    });
  }
});
