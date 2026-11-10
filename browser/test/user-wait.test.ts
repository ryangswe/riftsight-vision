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
  requestAllowed: (url: string, origin: string) => boolean;
  createRequestGuard: (origin: string) => { violations: string[]; handle: (request: FakeRequest) => unknown };
  architectureNote: (input: { machine: string; binary: string[]; page: { architecture: string | null } | null }) => Record<string, unknown>;
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
    expect(summary).toEqual({ rests: 5, answered: 3, missed: 1, wrongFirst: 0, leftBeforeAnswer: 1, medianMs: 250, p90Ms: LIMIT });
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

  it("reads a slowdown as the slowed calibration over the unslowed one", () => {
    expect(core.measuredFactor([100, 102, 98], [610, 590, 600])).toBe(6);
    expect(core.measuredFactor([], [1])).toBeNull();
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
