// SPDX-License-Identifier: Apache-2.0
// The wait measurement's scoring, summary, rest script checks and request policy
// (scripts/user-wait-core.mjs), on scripted session readings. No browser is started here; the
// run itself is `npm run user-wait` (README.md, "Measuring the wait").
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const fileOf = (name: string): string => fileURLToPath(new URL(`../${name}`, import.meta.url));
const core = (await import(pathToFileURL(fileOf("scripts/user-wait-core.mjs")).href)) as {
  scoreRest: (input: { expect: string; readings: { t: number; cardId: string | null }[]; movedAtMs?: number | null; limitMs?: number }) => Record<string, unknown>;
  summarize: (lines: Record<string, unknown>[]) => Record<string, unknown>;
  median: (values: number[]) => number | null;
  percentile: (values: number[], p: number) => number | null;
  measuredFactor: (baseline: number[], slowed: number[]) => number | null;
  cycleSummary: (cycles: { workerMs: number; roundTripMs: number }[]) => Record<string, unknown>;
  buildReport: (input: { profile: object; lines: Record<string, unknown>[]; analysis: object }) => { profile: object; rests: unknown[]; summary: Record<string, unknown>; analysis: object };
  restScriptProblem: (script: unknown) => string | null;
  restDelay: (rest: { pauseMs?: number; pauseAfterPreviousBeginMs?: number }, previousBegin: number | null, now: number) => { waitMs: number; lateMs: number | null };
  pointGroup: (boxes: { box: number[]; score: number; cls: number; className: string; face: Record<string, unknown> | null }[], point: { x: number; y: number } | null) => { index: number; holdsPoint: boolean; box: number[]; face: Record<string, unknown> | null }[];
  framePoint: (fraction: { fx: number; fy: number } | null, width: number, height: number) => { x: number; y: number } | null;
  requestAllowed: (url: string, origin: string) => boolean;
  byteRange: (header: string | undefined, size: number) => { start: number; end: number } | "unsatisfiable" | null;
  createRequestGuard: (origin: string) => { violations: string[]; handle: (request: FakeRequest) => unknown };
  architectureNote: (input: { machine: string; binary: string[]; page: { architecture: string | null } | null }) => Record<string, unknown>;
  scenesProblem: (spec: unknown, rests?: { scene?: string }[]) => string | null;
  describeRest: (scored: Record<string, unknown>, extra?: { scene?: string | null; framesStart?: number | null; framesEnd?: number | null; readings?: { t: number; cardId: string | null }[] }) => Record<string, unknown>;
  scenesWarnings: (spec: unknown, rests?: { scene?: string; expect: string }[]) => string[];
  answeredWithoutNewAnalysis: (lines: Record<string, unknown>[]) => number[];
  analysisShare: (reportedMs: number[], wallMs: number) => Record<string, unknown>;
  chooseCorrection: (given: number | undefined | null, baseline: number | null, throttled: number | null) => { c: number; source: string };
  correctionProblem: (value: number) => string | null;
  correction: (baseline: number | null, throttled: number | null) => number;
  settleAnalyses: (cold: boolean, count: number) => number;
  emulatedTime: (rawMs: number, rate: number, c: number) => { reportedMs: number; holdMs: number };
  geometricFlagsProblem: (flags: { scope?: string; settings?: string; gpu?: boolean }) => string | null;
  geometricGate: (status: { state: string; reason: string | null } | null, backend: string | null) => { ok: boolean; problem: string | null };
  geometricSummary: (cycles: { geometricMs?: number | null; verified?: number | null }[]) => Record<string, number | null>;
  loadHold: (rawLoadMs: number, rate: number, c: number) => { rawMs: number; emulatedMs: number; holdMs: number };
  runMode: (input: { cold: boolean; loadOnHover: boolean }) => string;
  loadOnHoverProblem: (input: { loadOnHover: boolean; correction?: number; measuredPacing: boolean }) => string | null;
  loadRest: (scored: Record<string, unknown>, input: { createdAtMs: number; readyAtMs: number | null }) => Record<string, unknown>;
  loadSummary: (messages: { rawMs: number; reportedMs: number; heldMs: number }[]) => Record<string, unknown>;
  DEFAULT_LIMIT_MS: number;
  DEFAULT_READY_TIMEOUT_MS: number;
};
interface FakeRequest {
  url: () => string;
  continue: () => string;
  abort: (reason: string) => string;
}
const { scoreRest, summarize } = core;
const LIMIT = core.DEFAULT_LIMIT_MS;

describe("scoring one rest", () => {
  it("is the time of the first reading of the expected card", () => {
    const line = scoreRest({ expect: "A", readings: [{ t: 3, cardId: null }, { t: 420.5, cardId: "A" }] });
    expect(line).toEqual({ expect: "A", answered: true, wrongFirst: false, leftBeforeAnswer: false, waitMs: 420.5 });
  });

  it("runs the wait to the right name when a wrong one showed first, and says so", () => {
    const line = scoreRest({ expect: "A", readings: [{ t: 0, cardId: null }, { t: 300, cardId: "B" }, { t: 900, cardId: "A" }] });
    expect(line).toMatchObject({ answered: true, wrongFirst: true, waitMs: 900 });
  });

  it("is a miss at the limit when the right name never shows, and the wrong name is noted", () => {
    expect(scoreRest({ expect: "A", readings: [{ t: 0, cardId: null }] })).toEqual({ expect: "A", answered: false, wrongFirst: false, leftBeforeAnswer: false, waitMs: LIMIT });
    expect(scoreRest({ expect: "A", readings: [{ t: 200, cardId: "B" }] })).toMatchObject({ answered: false, wrongFirst: true, waitMs: LIMIT });
  });

  it("does not count a right name that shows after the limit", () => {
    expect(scoreRest({ expect: "A", readings: [{ t: 10_500, cardId: "A" }] })).toMatchObject({ answered: false, waitMs: LIMIT });
    expect(scoreRest({ expect: "A", readings: [{ t: 900, cardId: "A" }], limitMs: 500 })).toMatchObject({ answered: false, waitMs: 500 });
  });

  it("is `left before answer` when the pointer moves again before any name shows", () => {
    const line = scoreRest({ expect: "A", readings: [{ t: 0, cardId: null }, { t: 800, cardId: "A" }], movedAtMs: 500 });
    expect(line).toEqual({ expect: "A", answered: false, wrongFirst: false, leftBeforeAnswer: true, waitMs: null });
  });

  it("counts an answer that arrived before the pointer moved", () => {
    expect(scoreRest({ expect: "A", readings: [{ t: 200, cardId: "A" }], movedAtMs: 500 })).toMatchObject({ answered: true, waitMs: 200 });
  });

  it("is a miss, not a departure, when a wrong name showed before the pointer moved", () => {
    expect(scoreRest({ expect: "A", readings: [{ t: 100, cardId: "B" }], movedAtMs: 500 })).toMatchObject({ answered: false, wrongFirst: true, leftBeforeAnswer: false, waitMs: LIMIT });
  });
});

describe("the summary", () => {
  const answered = (waitMs: number) => scoreRest({ expect: "A", readings: [{ t: waitMs, cardId: "A" }] });
  const miss = scoreRest({ expect: "A", readings: [] });
  const left = scoreRest({ expect: "A", readings: [], movedAtMs: 10 });

  it("keeps a miss in the median at the limit, and counts a departure apart", () => {
    const summary = summarize([answered(100), answered(200), answered(300), miss, left]);
    expect(summary).toEqual({ rests: 5, answered: 3, missed: 1, wrongFirst: 0, leftBeforeAnswer: 1, answeredFromOldAnalysis: 0, medianMs: 250, p90Ms: LIMIT });
  });

  it("uses the nearest-rank 90th percentile", () => {
    const waits = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
    expect(summarize(waits.map(answered))).toMatchObject({ medianMs: 550, p90Ms: 900 });
  });

  it("has no median when nothing was timed", () => {
    expect(summarize([left])).toMatchObject({ rests: 1, answered: 0, missed: 0, leftBeforeAnswer: 1, medianMs: null, p90Ms: null });
    expect(summarize([])).toMatchObject({ rests: 0, medianMs: null });
  });

  it("counts the rests that had a wrong name first", () => {
    const wrong = scoreRest({ expect: "A", readings: [{ t: 1, cardId: "B" }, { t: 5, cardId: "A" }] });
    expect(summarize([wrong, answered(10)])).toMatchObject({ answered: 2, wrongFirst: 1 });
  });
});

describe("the report", () => {
  it("has a line per rest, the summary, the profile and the analysis time per cycle", () => {
    const lines = [scoreRest({ expect: "A", readings: [{ t: 5, cardId: "A" }] })];
    const profile = { slowdown: { kind: "emulated", asked: 4 }, backend: "wasm" };
    const report = core.buildReport({ profile, lines, analysis: core.cycleSummary([{ workerMs: 10, roundTripMs: 12 }, { workerMs: 30, roundTripMs: 40 }]) });
    expect(Object.keys(report)).toEqual(["profile", "rests", "summary", "analysis"]);
    expect(report.rests).toHaveLength(1);
    expect(report.profile).toBe(profile);
    expect(report.summary).toMatchObject({ rests: 1, answered: 1, medianMs: 5, p90Ms: 5 });
    expect(report.analysis).toEqual({ cycles: 2, medianWorkerMs: 20, medianRoundTripMs: 26 });
  });

  it("gives the share of the run's wall time spent analyzing, and carries the pacing profile", () => {
    expect(core.analysisShare([900, 1100, 1000], 12_000)).toEqual({ runWallMs: 12_000, runAnalyses: 3, runAnalyzedMs: 3000, analyzingShare: 0.25 });
    expect(core.analysisShare([], 0)).toMatchObject({ runAnalyses: 0, analyzingShare: null });
    const profile = { measuredPacing: { on: true, share: 0.25 } };
    expect(core.buildReport({ profile, lines: [], analysis: core.analysisShare([1], 4) }).profile).toEqual(profile);
  });

  it("reads a slowdown as the slowed calibration over the unslowed one", () => {
    expect(core.measuredFactor([100, 102, 98], [610, 590, 600])).toBe(6);
    expect(core.measuredFactor([], [1])).toBeNull();
  });
});

describe("the correction", () => {
  it("uses the one given, else the measured ratio", () => {
    expect(core.chooseCorrection(1.06, null, null)).toEqual({ c: 1.06, source: "given" });
    expect(core.chooseCorrection(undefined, 300, 200)).toEqual({ c: 1.5, source: "measured" });
    expect(core.chooseCorrection(undefined, null, null)).toEqual({ c: 1, source: "measured" });
  });
  it("accepts only a number above 0", () => {
    expect(core.correctionProblem(1.06)).toBeNull();
    for (const bad of [0, -1, Number.NaN, Infinity]) expect(core.correctionProblem(bad)).not.toBeNull();
  });
});

describe("the rest script", () => {
  it("accepts the toy script, and names what is wrong with another", () => {
    const toy = JSON.parse(readFileSync(fileOf("test/fixtures/user-wait-toy-rests.json"), "utf-8")) as { rests: unknown[] };
    expect(core.restScriptProblem(toy)).toBeNull();
    expect(toy.rests).toHaveLength(8);
    expect(core.restScriptProblem({})).toMatch(/needs a `rests` list/);
    expect(core.restScriptProblem({ rests: [{ x: 0.5, y: 2, expect: "A" }] })).toMatch(/rest 1 needs/);
    expect(core.restScriptProblem({ rests: [{ x: 0.5, y: 0.5, expect: "A", leaveAfterMs: "soon" }] })).toMatch(/leaveAfterMs/);
  });
});

describe("a rest after a scene change", () => {
  const scored = (waitMs: number, first: string) => scoreRest({ expect: "B", readings: [{ t: 5, cardId: first }, { t: waitMs, cardId: "B" }] });

  it("records the scene, the analyses between the rest and the answer, and the first card shown", () => {
    const line = core.describeRest(scored(1200, "A"), { scene: "B", framesStart: 7, framesEnd: 9, readings: [{ t: 5, cardId: "A" }, { t: 1200, cardId: "B" }] });
    expect(line).toMatchObject({ answered: true, wrongFirst: true, waitMs: 1200, scene: "B", analysesBetween: 2, firstShown: "A" });
  });

  it("has no count when the frames were not counted, and no first card when nothing showed", () => {
    expect(core.describeRest(scoreRest({ expect: "B", readings: [] }), { readings: [] })).toMatchObject({ scene: null, analysesBetween: null, firstShown: null });
  });

  it("finds an answer that came with no new analysis, from scripted frame counts", () => {
    const lines = [
      { index: 1, ...core.describeRest(scored(1200, "A"), { framesStart: 3, framesEnd: 4, readings: [{ t: 5, cardId: "A" }] }) },
      { index: 2, ...core.describeRest(scored(9, "B"), { framesStart: 4, framesEnd: 4, readings: [{ t: 9, cardId: "B" }] }) },
      { index: 3, ...core.describeRest(scoreRest({ expect: "B", readings: [] }), { framesStart: 4, framesEnd: 4 }) },
    ];
    expect(core.answeredWithoutNewAnalysis(lines)).toEqual([2]);
    expect(lines[0]).toMatchObject({ analysesBetween: 1 });
  });

  it("counts the answered rests that had no new analysis in the summary", () => {
    const old = { index: 1, ...core.describeRest(scored(9, "B"), { framesStart: 4, framesEnd: 4 }) };
    const fresh = { index: 2, ...core.describeRest(scored(1200, "A"), { framesStart: 4, framesEnd: 5 }) };
    const missed = { index: 3, ...core.describeRest(scoreRest({ expect: "B", readings: [] }), { framesStart: 4, framesEnd: 4 }) };
    expect(summarize([old, fresh, missed])).toMatchObject({ answered: 2, answeredFromOldAnalysis: 1 });
  });

  it("warns, and does not refuse, when a rest's card is already there in the scene before", () => {
    const spec = { start: "A", scenes: { A: [{ card: "X", x: 0, y: 0 }, { card: "Y", x: 9, y: 9 }], B: [{ card: "X", x: 0, y: 0 }, { card: "Z", x: 9, y: 9 }] } };
    const rests = [{ scene: "B", expect: "X" }, { scene: "B", expect: "Z" }, { scene: "A", expect: "Y" }];
    expect(core.scenesProblem(spec, rests)).toBeNull();
    expect(core.scenesWarnings(spec, rests)).toEqual([
      "rest 1 expects X, which is already there in scene A: it can be answered from an old analysis",
      "rest 2 expects Z, which is already there in scene B: it can be answered from an old analysis",
    ]);
    const toy = JSON.parse(readFileSync(fileOf("test/fixtures/user-wait-toy-scenes.json"), "utf-8")) as { scenes: unknown };
    const toyRests = JSON.parse(readFileSync(fileOf("test/fixtures/user-wait-toy-rests.json"), "utf-8")) as { rests: { scene: string; expect: string }[] };
    expect(core.scenesWarnings(toy, toyRests.rests)).toEqual([]);
  });

  it("accepts the toy scenes, whose names the toy rests use, and says what is wrong with others", () => {
    const spec = JSON.parse(readFileSync(fileOf("test/fixtures/user-wait-toy-scenes.json"), "utf-8")) as { scenes: Record<string, unknown[]> };
    const toy = JSON.parse(readFileSync(fileOf("test/fixtures/user-wait-toy-rests.json"), "utf-8")) as { rests: { scene: string }[] };
    expect(core.scenesProblem(spec, toy.rests)).toBeNull();
    expect(toy.rests.map((rest) => rest.scene)).toEqual(["B", "C", "A", "B", "C", "A", "B", "C"]);
    expect(core.scenesProblem({}, [])).toMatch(/needs a `scenes` object/);
    expect(core.scenesProblem({ scenes: { A: [{ card: "../x", x: 0, y: 0 }] } })).toMatch(/scene A, card 1 needs/);
    expect(core.scenesProblem(spec, [{ scene: "Z" }])).toMatch(/rest 1 names a scene/);
  });
});

describe("the correction of the throttle's effect on the worker", () => {
  it("is the unthrottled raw time over the throttled one, and 1 when either is missing", () => {
    expect(core.correction(29, 16)).toBeCloseTo(1.813, 3);
    expect(core.correction(null, 16)).toBe(1);
    expect(core.correction(29, null)).toBe(1);
    expect(core.correction(0, 16)).toBe(1);
  });

  it("reports rate x c x the raw time and holds the reply for the difference, never less than 0", () => {
    const { reportedMs, holdMs } = core.emulatedTime(16, 6, core.correction(29, 16));
    expect(reportedMs).toBeCloseTo(174, 0);
    expect(holdMs).toBeCloseTo(reportedMs - 16, 6);
    expect(core.emulatedTime(30, 1, 0.5)).toEqual({ reportedMs: 15, holdMs: 0 });
  });

  it("keeps a frame that costs more than the others costing more, as the raw time does", () => {
    const c = core.correction(29, 16);
    expect(core.emulatedTime(32, 6, c).reportedMs / core.emulatedTime(16, 6, c).reportedMs).toBe(2);
  });

  it("makes 6x six times the 1x figure when the raw time is the baseline's", () => {
    const one = core.emulatedTime(29, 1, 1).reportedMs;
    const six = core.emulatedTime(16, 6, core.correction(29, 16)).reportedMs;
    expect(six / one).toBeCloseTo(6, 2);
  });
});

describe("start-up and architecture", () => {
  it("waits 120 s for the session by default, apart from the rest limit", () => {
    expect(core.DEFAULT_READY_TIMEOUT_MS).toBe(120_000);
    expect(core.DEFAULT_READY_TIMEOUT_MS).not.toBe(core.DEFAULT_LIMIT_MS);
  });

  it("says a browser is translated when it runs as another architecture than the machine", () => {
    expect(core.architectureNote({ machine: "arm64", binary: ["x86_64"], page: { architecture: "x86" } })).toEqual({ machineArch: "arm64", binaryArch: ["x86_64"], pageArch: "x86", translated: true });
    expect(core.architectureNote({ machine: "arm64", binary: ["x86_64", "arm64"], page: { architecture: "arm" } })).toMatchObject({ translated: false });
    expect(core.architectureNote({ machine: "x64", binary: [], page: { architecture: "x86" } })).toMatchObject({ translated: false });
    expect(core.architectureNote({ machine: "x64", binary: [], page: null })).toMatchObject({ pageArch: null, translated: null });
  });
});

describe("the request policy", () => {
  const origin = "http://127.0.0.1:4100";
  const fake = (url: string): FakeRequest => ({ url: () => url, continue: () => "continued", abort: (reason) => `aborted:${reason}` });

  it("lets the local server, data and blob URLs through, and refuses any other host", () => {
    for (const url of [`${origin}/`, `${origin}/lib/worker.js`, "data:text/plain,x", "blob:http://127.0.0.1:4100/abc", "about:blank"]) expect(core.requestAllowed(url, origin), url).toBe(true);
    for (const url of ["https://example.com/x.js", "http://127.0.0.1:4101/", "http://localhost:4100/", `${origin}.evil.test/`, "not a url"]) expect(core.requestAllowed(url, origin), url).toBe(false);
  });

  it("aborts a request to an outside URL and keeps the URL, so the run fails with it", () => {
    const guard = core.createRequestGuard(origin);
    expect(guard.handle(fake(`${origin}/page.js`))).toBe("continued");
    expect(guard.violations).toEqual([]);
    expect(guard.handle(fake("https://cdn.example.org/model.onnx"))).toBe("aborted:blockedbyclient");
    expect(guard.handle(fake("https://tracker.example.net/ping"))).toBe("aborted:blockedbyclient");
    expect(guard.violations).toEqual(["https://cdn.example.org/model.onnx", "https://tracker.example.net/ping"]);
  });

  it("is wired into the script: its guard decides every request and a violation exits 1", () => {
    const source = readFileSync(fileOf("scripts/user-wait.mjs"), "utf-8");
    expect(source).toContain('tab.on("request", (request) => guard.handle(request))');
    expect(source).toMatch(/guard\.violations\.length > 0[\s\S]*?code = 1/);
  });
});

describe("the script", () => {
  it("prints its options for --help and refuses what it does not know, with no browser", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [fileOf("scripts/user-wait.mjs"), ...args], { encoding: "utf-8" });
    const help = run("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: npm run user-wait --");
    expect(run("--verbose").status).toBe(2);
    expect(run("--verbose").stderr).toMatch(/^unknown option --verbose/);
    expect(run().stderr).toContain("--release is required");
  });
});

describe("byteRange: the local server answers range requests, so a video can seek past what it buffered", () => {
  const size = 1000;
  it("reads the three single-range forms", () => {
    expect(core.byteRange("bytes=0-99", size)).toEqual({ start: 0, end: 99 });
    expect(core.byteRange("bytes=500-", size)).toEqual({ start: 500, end: 999 });
    expect(core.byteRange("bytes=-100", size)).toEqual({ start: 900, end: 999 });
  });
  it("clips an end past the file and a suffix longer than the file", () => {
    expect(core.byteRange("bytes=900-5000", size)).toEqual({ start: 900, end: 999 });
    expect(core.byteRange("bytes=-5000", size)).toEqual({ start: 0, end: 999 });
  });
  it("answers 416 for a start past the end or an empty suffix", () => {
    expect(core.byteRange("bytes=1000-", size)).toBe("unsatisfiable");
    expect(core.byteRange("bytes=2000-3000", size)).toBe("unsatisfiable");
    expect(core.byteRange("bytes=-0", size)).toBe("unsatisfiable");
  });
  it("sends the whole file for no header or one it does not read", () => {
    for (const header of [undefined, "", "bytes=-", "bytes=0-99,200-299", "items=0-9", "bytes=99-0"]) expect(core.byteRange(header, size), String(header)).toBeNull();
  });
});

describe("settleAnalyses: a cold run has no settle analyses before its first rest", () => {
  it("settles a warm run and never a cold one", () => {
    expect(core.settleAnalyses(false, 5)).toBe(5);
    expect(core.settleAnalyses(true, 5)).toBe(0);
  });
});

describe("a paused rest", () => {
  it("accepts `pause` as a boolean and refuses another value", () => {
    const rest = { x: 0.1, y: 0.2, expect: "TOY-001" };
    expect(core.restScriptProblem({ rests: [{ ...rest, pause: true }, { ...rest, pause: false }] })).toBeNull();
    expect(core.restScriptProblem({ rests: [{ ...rest, pause: "yes" }] })).toMatch(/`pause` must be true or false/);
  });

  it("is wired into the script: paused before the seek and the move, and recorded per rest", () => {
    const source = readFileSync(fileOf("scripts/user-wait.mjs"), "utf-8");
    expect(source).toMatch(/rest\.pause === true\) pausedAtSec = \(await tab\.evaluate\(\(\) => window\.harness\.pause\(\)\)\)[\s\S]*?window\.harness\.seek\(sec\), rest\.atSec\)[\s\S]*?tab\.mouse\.move\(\.\.\.at\(rest\.x, rest\.y\)\)/);
    expect(source).toContain("paused: rest.pause === true");
    expect(readFileSync(fileOf("README.md"), "utf-8")).toContain('`"pause": true`');
  });
});

describe("the geometric flags (--gpu, --geometric, --geometric-scope)", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [fileOf("scripts/user-wait.mjs"), ...args], { encoding: "utf-8" });

  it("lists them in --help, and keeps today's default: GPU off, no stage", () => {
    const help = run("--help").stdout;
    for (const flag of ["--gpu", "--geometric FILE", "--geometric-scope S"]) expect(help).toContain(flag);
    const source = readFileSync(fileOf("scripts/user-wait.mjs"), "utf-8");
    expect(source).toContain('given.gpu ? ["--enable-unsafe-webgpu"] : ["--disable-gpu"]');
    expect(source).toContain('...(GPU ? {} : { providers: ["wasm"] })');
  });

  it("accepts the scopes all and focus, with a stage and the GPU, and refuses the rest", () => {
    const ok = { settings: "geometric/settings.json", gpu: true };
    expect(core.geometricFlagsProblem({})).toBeNull();
    expect(core.geometricFlagsProblem({ ...ok })).toBeNull();
    for (const scope of ["all", "focus"]) expect(core.geometricFlagsProblem({ ...ok, scope })).toBeNull();
    expect(core.geometricFlagsProblem({ ...ok, scope: "some" })).toMatch(/not one of all, focus/);
    expect(core.geometricFlagsProblem({ scope: "focus", gpu: true })).toMatch(/needs --geometric/);
    expect(core.geometricFlagsProblem({ settings: "g.json" })).toMatch(/needs --gpu/);
  });

  it("the script refuses a bad combination with status 2 before it starts a browser", () => {
    const base = ["--release", ".", "--clip", fileOf("package.json"), "--rests", fileOf("package.json")];
    const scope = run(...base, "--geometric-scope", "focus");
    expect([scope.status, scope.stderr]).toEqual([2, expect.stringContaining("--geometric-scope needs --geometric")]);
    const bad = run(...base, "--geometric", "g.json", "--gpu", "--geometric-scope", "some");
    expect([bad.status, bad.stderr]).toEqual([2, expect.stringContaining("not one of all, focus")]);
    expect(run(...base, "--geometric-scope").stderr).toContain("--geometric-scope needs a value");
  });

  it("takes --load-on-hover with the GPU and the stage: the flags are accepted, and the stage is gated at rest 1's load", () => {
    const base = ["--release", ".", "--clip", fileOf("package.json"), "--rests", fileOf("package.json")];
    const r = run(...base, "--load-on-hover", "--gpu", "--geometric", "package.json", "--geometric-scope", "focus");
    // Past every flag check; it stops at the release folder, which has no release.json.
    expect([r.status, r.stderr]).toEqual([2, expect.stringContaining("no release.json in it")]);
    const source = readFileSync(fileOf("scripts/user-wait.mjs"), "utf-8");
    expect(source).toMatch(/window\.harness\.ready\(ms\), readyTimeoutMs\);\s*checkOpened\(\);/);
  });

  it("calls a run usable only when the stage is ready, and says why otherwise", () => {
    expect(core.geometricGate({ state: "ready", reason: null }, "webgpu")).toEqual({ ok: true, problem: null });
    expect(core.geometricGate({ state: "off", reason: "no WebGPU" }, "wasm")).toEqual({ ok: false, problem: "the geometric stage is off (no WebGPU); backend wasm" });
    expect(core.geometricGate({ state: "loading", reason: null }, "webgpu").ok).toBe(false);
    expect(core.geometricGate(null, "wasm").ok).toBe(false);
  });

  it("summarizes the stage's time over all analyses and over those that verified a crop", () => {
    const cycles = [{ geometricMs: 0, verified: 0 }, { geometricMs: 10, verified: 1 }, { geometricMs: 30, verified: 3 }, { geometricMs: null }, {}];
    expect(core.geometricSummary(cycles)).toEqual({ geometricCycles: 3, medianGeometricMs: 10, verifyingCycles: 2, medianGeometricMsVerifying: 20, medianCropsVerified: 1, p90CropsVerified: 3, maxCropsVerified: 3 });
    expect(core.geometricSummary([{}])).toEqual({ geometricCycles: 0, medianGeometricMs: null, verifyingCycles: 0, medianGeometricMsVerifying: null, medianCropsVerified: null, p90CropsVerified: null, maxCropsVerified: null });
  });
});

describe("the first hover with the load included", () => {
  it("holds the load reply by (rate x c - 1) x the raw load time, as an analysis is", () => {
    expect(core.loadHold(500, 4, 1)).toEqual({ rawMs: 500, emulatedMs: 2000, holdMs: 1500 });
    expect(core.loadHold(500, 1, 1)).toEqual({ rawMs: 500, emulatedMs: 500, holdMs: 0 });
    expect(core.loadHold(500, 4, 1).emulatedMs).toBe(core.emulatedTime(500, 4, 1).reportedMs);
    expect(core.loadHold(200, 1, 0.5).holdMs).toBe(0);
  });

  it("names the mode in the profile", () => {
    expect(core.runMode({ cold: false, loadOnHover: false })).toBe("warm");
    expect(core.runMode({ cold: true, loadOnHover: false })).toBe("cold");
    expect(core.runMode({ cold: true, loadOnHover: true })).toBe("cold, load on the first hover");
  });

  it("refuses --correction and --measured-pacing with it, and allows the rest", () => {
    expect(core.loadOnHoverProblem({ loadOnHover: true, correction: 1.5, measuredPacing: false })).toMatch(/--correction/);
    expect(core.loadOnHoverProblem({ loadOnHover: true, measuredPacing: true })).toMatch(/--measured-pacing/);
    expect(core.loadOnHoverProblem({ loadOnHover: true, measuredPacing: false })).toBeNull();
    expect(core.loadOnHoverProblem({ loadOnHover: false, correction: 1.5, measuredPacing: true })).toBeNull();
  });

  it("splits rest 1's wait into the load and what came after it", () => {
    const scored = scoreRest({ expect: "A", readings: [{ t: 0, cardId: null }, { t: 2650, cardId: "A" }] });
    const line = core.loadRest(scored, { createdAtMs: 3, readyAtMs: 2103.4 });
    expect(line).toMatchObject({ answered: true, waitMs: 2650, loadIncluded: true, readyMs: 2100.4, afterReadyMs: 546.6 });
  });

  it("gives no split for a rest that was not ready or not answered", () => {
    const missed = scoreRest({ expect: "A", readings: [], limitMs: 1000 });
    expect(core.loadRest(missed, { createdAtMs: 2, readyAtMs: null })).toMatchObject({ answered: false, readyMs: null, afterReadyMs: null });
    expect(core.loadRest(missed, { createdAtMs: 2, readyAtMs: 800 })).toMatchObject({ readyMs: 798, afterReadyMs: null });
  });

  it("summarizes the load as the wrapper applied it", () => {
    expect(core.loadSummary([{ rawMs: 500, reportedMs: 2000, heldMs: 2004 }])).toEqual({ loads: 1, rawMs: 500, emulatedMs: 2000, heldMs: 2004, appliedFactor: 4.01 });
    expect(core.loadSummary([])).toEqual({ loads: 0, rawMs: null, emulatedMs: null, heldMs: null, appliedFactor: null });
  });
});

describe("the answering analysis, hold and the shown timeline", () => {
  const source = readFileSync(fileOf("scripts/user-wait.mjs"), "utf-8");

  it("records the analysis before a rest's record is read: on update and when the rest finishes", () => {
    expect(source).toContain("onUpdate: () => { if (session) record(); }");
    expect(source).toMatch(/function finish\(\) \{[\s\S]*?if \(session\) record\(\);[\s\S]*?rest\.resolve\(/);
    expect(source).toContain("setInterval(record, 20)");
  });

  it("holds for holdMs after the answer, scores what was read up to it, and reports the timeline", () => {
    expect(source).toMatch(/rest\.answeredAt = t;\s*rest\.scored = rest\.readings\.slice\(\);/);
    expect(source).toContain("t >= rest.answeredAt + rest.holdMs");
    expect(source).toContain("window.harness.begin(expect, ms, hold), rest.expect, limit, rest.holdMs ?? 0");
    expect(source).toContain("shown: measured.timeline");
  });

  it("accepts holdMs as a number of ms and refuses another value", () => {
    const rest = { x: 0.1, y: 0.2, expect: "TOY-001" };
    expect(core.restScriptProblem({ rests: [{ ...rest, holdMs: 1500 }] })).toBeNull();
    expect(core.restScriptProblem({ rests: [{ ...rest, holdMs: "long" }] })).toMatch(/`holdMs` must be a number of ms/);
  });

  it("the README documents holdMs, shown and the analyses record", () => {
    const readme = readFileSync(fileOf("README.md"), "utf-8");
    for (const word of ["`holdMs`", "`shown`", "`analyses`"]) expect(readme).toContain(word);
  });
});

describe("moveAfterMs", () => {
  it("accepts a whole number of ms, 0 or more, and refuses the rest", () => {
    const rest = { x: 0.1, y: 0.2, expect: "TOY-001" };
    for (const ok of [0, 100]) expect(core.restScriptProblem({ rests: [{ ...rest, moveAfterMs: ok }] })).toBeNull();
    for (const bad of [-1, 1.5, "100"]) expect(core.restScriptProblem({ rests: [{ ...rest, moveAfterMs: bad }] })).toMatch(/`moveAfterMs` must be a whole number/);
  });

  it("is wired in after the seek and before the move, which is where the wait counts from", () => {
    const source = readFileSync(fileOf("scripts/user-wait.mjs"), "utf-8");
    expect(source).toMatch(/window\.harness\.seek\(sec\), rest\.atSec\)[\s\S]*?setTimeout\(done, rest\.moveAfterMs\)[\s\S]*?tab\.mouse\.move\(\.\.\.at\(rest\.x, rest\.y\)\)/);
    expect(readFileSync(fileOf("README.md"), "utf-8")).toContain("`moveAfterMs`");
  });
});

describe("pauseAfterPreviousBeginMs and the rest records", () => {
  it("accepts ms after a previous rest, in place of pauseMs, and refuses the rest", () => {
    const rest = { x: 0.1, y: 0.2, expect: "TOY-001" };
    expect(core.restScriptProblem({ rests: [rest, { ...rest, pauseAfterPreviousBeginMs: 1800 }] })).toBeNull();
    for (const bad of [-1, "1800"]) expect(core.restScriptProblem({ rests: [rest, { ...rest, pauseAfterPreviousBeginMs: bad }] })).toMatch(/must be a number of ms/);
    expect(core.restScriptProblem({ rests: [rest, { ...rest, pauseAfterPreviousBeginMs: 1800, pauseMs: 300 }] })).toMatch(/not both/);
    expect(core.restScriptProblem({ rests: [{ ...rest, pauseAfterPreviousBeginMs: 1800 }] })).toMatch(/needs a previous rest/);
  });

  it("starts pauseMs after the previous rest, or pauseAfterPreviousBeginMs after its begin, late when it ran past", () => {
    expect(core.restDelay({}, 5000, 6000)).toEqual({ waitMs: 1000, lateMs: null });
    expect(core.restDelay({ pauseMs: 300 }, 5000, 6000)).toEqual({ waitMs: 300, lateMs: null });
    expect(core.restDelay({ pauseAfterPreviousBeginMs: 1800 }, 5000, 6000)).toEqual({ waitMs: 800, lateMs: 0 });
    expect(core.restDelay({ pauseAfterPreviousBeginMs: 1800 }, 5000, 7250.4)).toEqual({ waitMs: 0, lateMs: 450 });
    // A rest with no previous begin (the first) falls back to pauseMs' default.
    expect(core.restDelay({ pauseAfterPreviousBeginMs: 1800 }, null, 6000)).toEqual({ waitMs: 1000, lateMs: null });
  });

  it("groups the boxes holding the point and, transitively, those overlapping them by IoU 0.3", () => {
    const face = (id: string) => ({ topId: id, accepted: false, geometric: { verified: false, debug: { big: [1, 2, 3] } } });
    const boxes = [
      { box: [0, 0, 100, 100], score: 0.9, cls: 0, className: "face", face: face("A") }, // holds the point
      { box: [40, 0, 100, 100], score: 0.8, cls: 0, className: "face", face: face("B") }, // IoU 60/140 = 0.43 with A
      { box: [80, 0, 100, 100], score: 0.7, cls: 0, className: "face", face: face("C") }, // IoU 60/140 = 0.43 with B, 20/180 = 0.11 with A: joins through B
      { box: [175, 0, 100, 100], score: 0.6, cls: 0, className: "face", face: null }, // IoU 500/19500 = 0.03 with C: out
      { box: [500, 500, 50, 50], score: 0.5, cls: 1, className: "back", face: null }, // far away: out
    ];
    const group = core.pointGroup(boxes, { x: 10, y: 10 });
    expect(group.map((g) => [g.index, g.holdsPoint])).toEqual([[0, true], [1, false], [2, false]]);
    expect(group[0]!.face).toMatchObject({ topId: "A", accepted: false, geometric: { verified: false, debug: "(left out)" } });
    expect(boxes[0]!.face!.geometric.debug).toEqual({ big: [1, 2, 3] });
    expect(core.pointGroup(boxes, null)).toEqual([]);
    expect(core.pointGroup(boxes, { x: 400, y: 400 })).toEqual([]);
    expect(core.framePoint({ fx: 0.5, fy: 0.25 }, 1920, 1080)).toEqual({ x: 960, y: 270 });
    expect(core.framePoint(null, 1920, 1080)).toBeNull();
    // The worker wrapper is given their source text: they must run with nothing else in scope.
    const isolated = new Function(`${core.pointGroup.toString()}; ${core.framePoint.toString()}; return { pointGroup, framePoint };`)() as Pick<typeof core, "pointGroup" | "framePoint">;
    expect(isolated.pointGroup(boxes, { x: 10, y: 10 })).toEqual(group);
    expect(isolated.framePoint({ fx: 0.5, fy: 0.25 }, 1920, 1080)).toEqual({ x: 960, y: 270 });
  });

  it("records frames only with --record-frames, after the reply, with the core's group rule", () => {
    const source = readFileSync(fileOf("scripts/user-wait.mjs"), "utf-8");
    expect(source).toContain('"--record-frames"');
    expect(source).toContain("${pointGroup.toString()}");
    expect(source).toMatch(/post\(\{ \.\.\.message, workerMs[^\n]*\n[\s\S]{0,200}?if \(RECORD_FRAMES\)/);
    expect(source).toMatch(/restDelay\(rest, previousBegin, performance\.now\(\)\)[\s\S]*?window\.harness\.pause\(\)[\s\S]*?window\.harness\.begin\([\s\S]*?previousBegin = performance\.now\(\)/);
    const readme = readFileSync(fileOf("README.md"), "utf-8");
    for (const word of ["`pauseAfterPreviousBeginMs`", "`timing`", "`polled`", "`frames`", "--record-frames"]) expect(readme).toContain(word);
  });
});
