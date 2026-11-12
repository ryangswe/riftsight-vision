// SPDX-License-Identifier: Apache-2.0
// The hover-speed measurement's script check, hover scoring, summaries, hard gates and report
// shape (scripts/hover-speed-core.mjs), on scripted page readings. No browser is started here;
// the run itself is `npm run hover-speed` (README.md, "Measuring hover speed").
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

type Ev = Record<string, unknown> & { t: number; kind: string };
type Row = Record<string, any>;
const core = (await import(pathToFileURL(fileURLToPath(new URL("../scripts/hover-speed-core.mjs", import.meta.url))).href)) as {
  percentile: (values: number[], p: number) => number | null;
  stats: (values: number[]) => Record<string, number | null>;
  scriptProblem: (script: unknown) => string | null;
  optionsProblem: (options: unknown) => string | null;
  intendedStage: (options: unknown) => string;
  scoreHover: (input: { events: Ev[]; expect: string; limitMs?: number; observeMs?: number; before?: Ev[] }) => Row;
  entryLookProblem: (input: { scenarios: string[]; gaps: number[] }) => string | null;
  scenarioProblem: (input: { script: Row; scenarios: string[]; loadMode: string; haveScenes: boolean }) => string | null;
  summarizeByPair: (rows: Row[], limitMs?: number) => Row[];
  requestsOffPicture: (events: Ev[], graceMs?: number) => number;
  tally: (events: Ev[]) => Record<string, number>;
  summarizeRows: (rows: Row[], limitMs?: number) => Row;
  summarizeByGap: (rows: Row[], limitMs?: number) => Row[];
  evaluateGates: (input: Row) => { id: string; ok: boolean; enforced: boolean; detail: Row }[];
  exitCodeFor: (gates: { ok: boolean; enforced: boolean }[]) => number;
  reportProblems: (report: Row) => string[];
  buildReport: (input: Row) => Row;
};

const move = (t: number, over = true): Ev => ({ t, kind: "move", over, trusted: true });
const capture = (t: number, requestId: number, extra: Row = {}): Ev => ({ t, kind: "capture", requestId, allowedNow: true, outstanding: 0, ...extra });
const answered = (t: number, requestId: number, how = "frame"): Ev => ({ t, kind: "answered", requestId, how });
const shown = (t: number, cardId: string | null): Ev => ({ t, kind: "shown", cardId });

describe("percentiles", () => {
  it("uses the nearest rank and keeps the maximum", () => {
    expect(core.percentile([], 90)).toBeNull();
    expect(core.stats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toEqual({ n: 10, medianMs: 50, p90Ms: 90, maxMs: 100 });
  });
});

describe("script and options checks", () => {
  const good = { hovers: [{ x: 0.1, y: 0.2, expect: "A" }] };
  it("accepts a script and names the first problem", () => {
    expect(core.scriptProblem(good)).toBeNull();
    expect(core.scriptProblem({ hovers: [] })).toMatch(/non-empty/);
    expect(core.scriptProblem({ hovers: [{ x: 2, y: 0, expect: "A" }] })).toMatch(/hovers\[0\]: x/);
    expect(core.scriptProblem({ hovers: [{ x: 0, y: 0 }] })).toMatch(/expect/);
    expect(core.scriptProblem({ ...good, slowPoint: { x: 0, y: 0 } })).toMatch(/slowPoint/);
    expect(core.scriptProblem({ ...good, limitMs: 500 })).toMatch(/--limit/);
    expect(core.scriptProblem({ hovers: [{ x: 0, y: 0, expect: "A", limitMs: 5 }] })).toMatch(/--limit/);
  });
  it("checks the A and B pairs of H6", () => {
    const a = { x: 0.1, y: 0.2, expect: "A" };
    const b = { x: 0.8, y: 0.2, expect: "B" };
    expect(core.scriptProblem({ ...good, pairs: [{ a, b, scene: "S" }] })).toBeNull();
    expect(core.scriptProblem({ ...good, pairs: [] })).toMatch(/non-empty/);
    expect(core.scriptProblem({ ...good, pairs: [{ a, b: a }] })).toMatch(/different cards/);
    expect(core.scriptProblem({ ...good, pairs: [{ a, b: { ...b, scene: "S" } }] })).toMatch(/name the scene on the pair/);
    expect(core.scriptProblem({ ...good, pairs: [{ a, b: { x: 2, y: 0, expect: "B" } }] })).toMatch(/pairs\[0\]\.b/);
  });
  it("refuses options the harness sets itself", () => {
    expect(core.optionsProblem({ frame: { idleUnloadMs: 5000 }, load: { geometricUrl: "x" }, stage: "ready" })).toBeNull();
    expect(core.optionsProblem({ stage: "maybe" })).toMatch(/stage/);
    expect(core.optionsProblem({ load: { releaseUrl: "x" } })).toMatch(/set by the harness/);
    expect(core.optionsProblem({ frame: { createWorker: 1 } })).toMatch(/set by the harness/);
    expect(core.optionsProblem({ other: 1 })).toMatch(/unknown key/);
  });
  it("pins the stage from the options", () => {
    expect(core.intendedStage({})).toBe("none");
    expect(core.intendedStage({ load: { geometricUrl: "g" } })).toBe("ready");
    expect(core.intendedStage({ load: { geometricUrl: "g" }, stage: "off" })).toBe("off");
  });
});

describe("scoring one hover", () => {
  it("times a match from the trusted move and tells a request from a reuse", () => {
    const withRequest = core.scoreHover({ events: [move(100), capture(105, 1), answered(120, 1), shown(300, "A")], expect: "A" });
    expect(withRequest).toMatchObject({ outcome: "match", shownMs: 200, askedMs: 5, shownVia: "request", requestsAfterMove: 1 });
    const reused = core.scoreHover({ events: [move(100), shown(101, "A"), capture(400, 2)], expect: "A", observeMs: 1000 });
    expect(reused).toMatchObject({ outcome: "match", shownMs: 1, shownVia: "reused", askedMs: 300 });
    const none = core.scoreHover({ events: [move(100), shown(101, "A")], expect: "A", observeMs: 1000 });
    expect(none).toMatchObject({ shownVia: "reused", askedMs: null });
  });
  it("counts wrong, miss and timeout, each in the denominator", () => {
    expect(core.scoreHover({ events: [move(0), shown(50, "B")], expect: "A", limitMs: 1000 }).outcome).toBe("wrong");
    expect(core.scoreHover({ events: [move(0), shown(50, null)], expect: "A", limitMs: 1000 }).outcome).toBe("miss");
    expect(core.scoreHover({ events: [move(0)], expect: "A", limitMs: 1000 }).outcome).toBe("timeout");
    expect(core.scoreHover({ events: [move(0), shown(2000, "A")], expect: "A", limitMs: 1000 }).outcome).toBe("timeout");
    const wrongFirst = core.scoreHover({ events: [move(0), shown(50, "B"), shown(90, "A")], expect: "A" });
    expect(wrongFirst).toMatchObject({ outcome: "match", wrongFirst: true });
  });
  it("is a harness error, not a miss, when no trusted move over the picture was seen", () => {
    expect(core.scoreHover({ events: [{ t: 1, kind: "move", over: true, trusted: false }], expect: "A" }).error).toMatch(/no trusted move/);
    expect(core.scoreHover({ events: [move(1, false)], expect: "A" }).error).toBeDefined();
  });
  it("notes a request still outstanding at the move, from the context's earlier readings", () => {
    const before = [capture(10, 7)];
    const events = [move(100), answered(150, 7, "capture-failed"), shown(200, "A")];
    expect(core.scoreHover({ before, events, expect: "A" }).outstandingAtMove).toBe(true);
    expect(core.scoreHover({ before: [capture(10, 7), answered(50, 7, "frame")], events, expect: "A" }).outstandingAtMove).toBe(false);
    expect(core.scoreHover({ events, expect: "A" }).outstandingAtMove).toBe(false);
  });
  it("marks a hover whose first card was not the expected one, even when the expected card follows", () => {
    expect(core.scoreHover({ events: [move(0), shown(60, "OLD"), shown(700, "A")], expect: "A" })).toMatchObject({ outcome: "match", wrongFirst: true, firstShownCardId: "OLD" });
    expect(core.scoreHover({ events: [move(0), shown(60, "A")], expect: "A" }).wrongFirst).toBe(false);
    expect(core.summarizeRows([core.scoreHover({ events: [move(0), shown(60, "OLD"), shown(700, "A")], expect: "A" })]).wrongFirst).toBe(1);
  });
});

describe("requests off the picture", () => {
  it("counts requests between a move off the picture and the next move over it, after the grace", () => {
    const events = [move(0), capture(100, 1), move(200, false), capture(220, 2), capture(500, 3), capture(750, 4), move(900), capture(950, 5)];
    expect(core.requestsOffPicture(events)).toBe(2);
    expect(core.requestsOffPicture(events, 400)).toBe(1);
    expect(core.requestsOffPicture([move(0), capture(10, 1)])).toBe(0);
  });
});

describe("summaries", () => {
  const rows = [
    { outcome: "match", shownMs: 100, askedMs: 5, shownVia: "request" },
    { outcome: "match", shownMs: 300, askedMs: null, shownVia: "reused" },
    { outcome: "timeout", shownMs: null, askedMs: null, shownVia: null },
    { outcome: "wrong", shownMs: null, askedMs: 40, shownVia: null },
  ];
  it("keeps every hover in the denominator, and gives the matched-only timing apart", () => {
    const s = core.summarizeRows(rows, 1000);
    expect(s).toMatchObject({ hovers: 4, match: 2, wrong: 1, miss: 0, timeout: 1, matchRate: 0.5, reused: 1, requested: 1, noRequestAfterMove: 2 });
    expect(s.allHoversMs).toEqual({ n: 4, medianMs: 300, p90Ms: 1000, maxMs: 1000 });
    expect(s.matchedOnlyMs).toEqual({ n: 2, medianMs: 100, p90Ms: 300, maxMs: 300 });
  });
  it("reports H5 per gap with their counts", () => {
    const h5 = [
      { ...rows[0], gapMs: 1000, requestsOffPicture: 3 },
      { ...rows[1], gapMs: 3000, requestsOffPicture: 0 },
      { ...rows[2], gapMs: 1000, requestsOffPicture: 2 },
    ];
    const gaps = core.summarizeByGap(h5, 1000);
    expect(gaps.map((g) => [g.gapMs, g.hovers, g.requestsOffPicture])).toEqual([[1000, 2, 5], [3000, 1, 0]]);
  });
});

describe("H6 by pair", () => {
  it("summarizes each pair apart, so a pooled median cannot hide a pair that waits", () => {
    const rows = [
      { pair: 0, outcome: "match", shownMs: 330, askedMs: 280, shownVia: "request", wrongFirst: false },
      { pair: 1, outcome: "match", shownMs: 36, askedMs: 0.1, shownVia: "request", wrongFirst: false },
      { pair: 0, outcome: "match", shownMs: 372, askedMs: 326, shownVia: "request", wrongFirst: true },
      { pair: 1, outcome: "match", shownMs: 5, askedMs: null, shownVia: "reused", wrongFirst: false },
    ];
    const pooled = core.summarizeRows(rows);
    const byPair = core.summarizeByPair(rows);
    expect(pooled.allHoversMs.medianMs).toBe(36);
    expect(byPair.map((p) => [p.pair, p.hovers, p.allHoversMs.medianMs, p.allHoversMs.maxMs, p.reused, p.wrongFirst])).toEqual([[0, 2, 330, 372, 0, 1], [1, 2, 5, 36, 1, 0]]);
    const report = core.buildReport({ profile: { machine: "m", chrome: "c", backend: "b", backendForced: null, stageIntended: "ready", load: "play", cold: "x", toolkitCommit: "t", startedAt: "n" }, options: {}, rows: rows.map((r, i) => ({ ...r, scenario: "H6", trial: i, stage: { state: "ready" }, backend: "b" })), tallies: [], loopbackViolations: [], entryLook: false, entryMs: 50 });
    expect(report.scenarios.H6.byPair).toHaveLength(2);
    expect(report.passed).toBe(true);
  });
});

describe("scenario and script usage problems", () => {
  const script = { hovers: [{ x: 0.1, y: 0.2, expect: "A" }] };
  const pairs = [{ a: { x: 0.1, y: 0.2, expect: "A" }, b: { x: 0.8, y: 0.2, expect: "B" } }];
  it("refuses H6 without pairs, and with --load hover", () => {
    expect(core.scenarioProblem({ script, scenarios: ["H6"], loadMode: "play", haveScenes: false })).toMatch(/pairs/);
    expect(core.scenarioProblem({ script: { ...script, pairs }, scenarios: ["H6"], loadMode: "hover", haveScenes: false })).toMatch(/--load play/);
    expect(core.scenarioProblem({ script: { ...script, pairs }, scenarios: ["H6"], loadMode: "play", haveScenes: false })).toBeNull();
    expect(core.scenarioProblem({ script, scenarios: ["H1", "H5"], loadMode: "hover", haveScenes: false })).toBeNull();
  });
  it("refuses a scene on a hover, a slow point or a pair without --scenes", () => {
    for (const bad of [{ hovers: [{ ...script.hovers[0], scene: "S" }] }, { ...script, slowPoint: { ...script.hovers[0], scene: "S" } }, { ...script, pairs: [{ ...pairs[0], scene: "S" }] }]) {
      expect(core.scenarioProblem({ script: bad, scenarios: ["H1"], loadMode: "play", haveScenes: false })).toMatch(/--scenes/);
      expect(core.scenarioProblem({ script: bad, scenarios: ["H1"], loadMode: "play", haveScenes: true })).toBeNull();
    }
  });
  it("reports the entry-look gates as not applicable when H5 did not run", () => {
    const clean = { capturesBeforeAnyPointer: 0, unauthorizedFramesDelivered: 0, duplicateInFlight: 0, requestsOffPicture: 0 };
    const gates = core.evaluateGates({ tallies: [clean], loopbackViolations: [], h5Rows: [], entryLook: false });
    for (const id of ["no-requests-off-picture", "entry-look-same-call"]) expect(gates.find((g) => g.id === id)).toMatchObject({ ok: true, detail: { applicable: false } });
  });
});

describe("hard gates", () => {
  const clean = { capturesBeforeAnyPointer: 0, unauthorizedFramesDelivered: 0, duplicateInFlight: 0, requestsOffPicture: 0 };
  const gate = (gates: ReturnType<typeof core.evaluateGates>, id: string) => gates.find((g) => g.id === id)!;
  it("finds a capture before any pointer, a frame delivered without authority and a duplicate", () => {
    expect(core.tally([capture(1, 1), move(5)]).capturesBeforeAnyPointer).toBe(1);
    expect(core.tally([move(1), capture(5, 1, { allowedNow: false }), answered(9, 1, "frame")]).unauthorizedFramesDelivered).toBe(1);
    expect(core.tally([move(1), capture(5, 1, { allowedNow: false }), answered(9, 1, "capture-failed")]).unauthorizedFramesDelivered).toBe(0);
    expect(core.tally([move(1), capture(5, 1), capture(6, 2, { outstanding: 1 })]).duplicateInFlight).toBe(1);
  });
  it("fails an enforced gate and only reports one that is not enforced", () => {
    const off = { ...clean, requestsOffPicture: 4 };
    const h5 = [{ gapMs: 500, outstandingAtMove: false, askedMs: 1 }];
    const report = core.evaluateGates({ tallies: [off], loopbackViolations: [], h5Rows: h5, entryLook: false });
    expect(gate(report, "no-requests-off-picture")).toMatchObject({ ok: false, enforced: false });
    expect(core.exitCodeFor(report)).toBe(0);
    const enforced = core.evaluateGates({ tallies: [off], loopbackViolations: [], h5Rows: h5, entryLook: true });
    expect(core.exitCodeFor(enforced)).toBe(1);
  });
  it("fails the run on an unauthorized capture or a request off 127.0.0.1 even without the entry-look flag", () => {
    expect(core.exitCodeFor(core.evaluateGates({ tallies: [{ ...clean, capturesBeforeAnyPointer: 1 }], loopbackViolations: [], h5Rows: [], entryLook: false }))).toBe(1);
    const loop = core.evaluateGates({ tallies: [clean], loopbackViolations: ["https://example.com/x"], h5Rows: [], entryLook: false });
    expect(gate(loop, "loopback-only")).toMatchObject({ ok: false, enforced: true });
  });
  it("does not pass the entry-look gates on no evidence", () => {
    const none = core.evaluateGates({ tallies: [clean], loopbackViolations: [], h5Rows: [{ gapMs: 500, outstandingAtMove: false, askedMs: 1 }], entryLook: true });
    expect(gate(none, "entry-look-same-call")).toMatchObject({ ok: false, enforced: true, detail: { eligible: 0 } });
    expect(core.exitCodeFor(none)).toBe(1);
    expect(core.entryLookProblem({ scenarios: ["H1", "H2"], gaps: [1000] })).toMatch(/H5/);
    expect(core.entryLookProblem({ scenarios: ["H5"], gaps: [500] })).toMatch(/gap/);
    expect(core.entryLookProblem({ scenarios: ["H5"], gaps: [500, 1000] })).toBeNull();
  });
  it("checks the same-call entry on eligible H5 hovers when expected", () => {
    const h5 = [
      { gapMs: 3000, outstandingAtMove: false, askedMs: 10 },
      { gapMs: 3000, outstandingAtMove: false, askedMs: 250 },
      { gapMs: 3000, outstandingAtMove: true, askedMs: null },
      { gapMs: 500, outstandingAtMove: false, askedMs: null },
    ];
    const g = gate(core.evaluateGates({ tallies: [clean], loopbackViolations: [], h5Rows: h5, entryLook: true, entryMs: 50 }), "entry-look-same-call");
    expect(g).toMatchObject({ ok: false, enforced: true, detail: { eligible: 2, notAskedWithin: 1 } });
  });
});

describe("report shape", () => {
  const profile = { machine: "m", chrome: "c", backend: "wasm", backendForced: null, stageIntended: "none", load: "play", cold: "x", toolkitCommit: "abc", startedAt: "now" };
  const row = { scenario: "H5", trial: 0, gapMs: 1000, outcome: "match", shownMs: 10, askedMs: 3, stage: { state: "none", reason: null }, backend: "wasm", requestsOffPicture: 0, outstandingAtMove: false };
  const tallies = [{ capturesBeforeAnyPointer: 0, unauthorizedFramesDelivered: 0, duplicateInFlight: 0, requestsOffPicture: 0 }];
  it("is complete for a run, and passes when no enforced gate fails", () => {
    const report = core.buildReport({ profile, options: {}, rows: [row], tallies, loopbackViolations: [], entryLook: false, entryMs: 50, limitMs: 1000 });
    expect(core.reportProblems(report)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.scenarios.H1).toBeNull();
    expect(report.scenarios.H5.byGap).toHaveLength(1);
  });
  it("fails the complete-schema gate when a row lacks a field", () => {
    const { stage: _stage, ...bad } = row;
    const report = core.buildReport({ profile, options: {}, rows: [bad], tallies, loopbackViolations: [], entryLook: false, entryMs: 50, limitMs: 1000 });
    expect(report.passed).toBe(false);
    expect(report.gates.find((g: any) => g.id === "complete-schema")?.detail.problems[0]).toMatch(/missing stage/);
  });
  it("names a missing profile field", () => {
    const { chrome: _chrome, ...thin } = profile;
    expect(core.reportProblems({ schema: "x", profile: thin, options: {}, scenarios: {}, gates: [], rows: [], passed: true })).toContain("profile: missing chrome");
  });
});
