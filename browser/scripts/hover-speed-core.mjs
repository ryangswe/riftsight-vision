// SPDX-License-Identifier: Apache-2.0
// The parts of the hover-speed measurement (scripts/hover-speed.mjs) that need no browser: the
// script check, how one hover is scored from the page's readings, the summaries, the hard gates
// and the report's shape. They start nothing and read no file, so test/hover-speed.test.ts runs
// them on scripted readings.
//
// Every time here is in ms on one clock: the page's `performance.now()`, read in the parent
// document. A reading from another context is never subtracted from one of the page's; the
// compute frame only reports what it received (which request, which stage state), never a time.

/** How long a hover waits for the expected card before it counts as a timeout, in ms. */
export const DEFAULT_LIMIT_MS = 10_000;
/** How long H5 keeps watching after a pointer move for a picture request, in ms. */
export const DEFAULT_OBSERVE_MS = 1000;
/** A picture request arriving this soon after the pointer left the picture is not counted as
 *  asked while off the picture: it was already on its way when the frame learned of the leave. */
export const OFF_PICTURE_GRACE_MS = 50;
/** With the entry look expected: the longest from the pointer move to the picture request, in ms. */
export const DEFAULT_ENTRY_MS = 50;
/** The shortest off-picture gap, in ms, after which a return is expected to be stale. */
export const STALE_GAP_MS = 1000;
export const DEFAULT_GAPS_MS = [1000, 3000, 12_000];
export const DEFAULT_COUNT = 20;
export const SCENARIOS = ["H1", "H2", "H2P", "H5", "H6"];
export const STAGE_STATES = ["none", "ready", "off", "failed"];

const round = (value) => Math.round(value * 100) / 100;

/** The nearest-rank percentile (p in 1 to 100); null for no numbers. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]);
}

/** Count, median, 90th percentile and maximum. */
export function stats(values) {
  return { n: values.length, medianMs: percentile(values, 50), p90Ms: percentile(values, 90), maxMs: values.length ? round(Math.max(...values)) : null };
}

/** The script: points to hover, each with the card expected there (and optionally a scene). */
export function scriptProblem(script) {
  if (typeof script !== "object" || script === null || Array.isArray(script)) return "the script must be an object";
  const { hovers, slowPoint, pairs } = script;
  if (!Array.isArray(hovers) || hovers.length === 0) return "the script needs a non-empty hovers list";
  const point = (p, where) => {
    if (typeof p !== "object" || p === null) return `${where}: not an object`;
    for (const key of ["x", "y"]) if (!(typeof p[key] === "number" && p[key] >= 0 && p[key] <= 1)) return `${where}: ${key} must be a fraction from 0 to 1`;
    if (typeof p.expect !== "string" || p.expect === "") return `${where}: expect must be a card id`;
    if (p.scene !== undefined && typeof p.scene !== "string") return `${where}: scene must be a name`;
    return null;
  };
  for (let i = 0; i < hovers.length; i += 1) {
    const problem = point(hovers[i], `hovers[${i}]`);
    if (problem) return problem;
  }
  if (slowPoint !== undefined) {
    const problem = point(slowPoint, "slowPoint");
    if (problem) return problem;
  }
  if (pairs !== undefined) {
    if (!Array.isArray(pairs) || pairs.length === 0) return "pairs must be a non-empty list";
    for (let i = 0; i < pairs.length; i += 1) {
      const pair = pairs[i];
      if (typeof pair !== "object" || pair === null) return `pairs[${i}]: not an object`;
      for (const key of ["a", "b"]) {
        const problem = point(pair[key], `pairs[${i}].${key}`);
        if (problem) return problem;
        if ("limitMs" in pair[key]) return "limitMs is not a point field: the one limit is --limit";
        if (pair[key].scene !== undefined) return `pairs[${i}].${key}: name the scene on the pair`;
      }
      if (pair.a.expect === pair.b.expect) return `pairs[${i}]: a and b must expect different cards`;
      if (pair.scene !== undefined && typeof pair.scene !== "string") return `pairs[${i}]: scene must be a name`;
    }
  }
  if ("limitMs" in script) return "limitMs is not a script field: the one limit is --limit";
  for (const h of [...hovers, ...(slowPoint ? [slowPoint] : [])]) if ("limitMs" in h) return "limitMs is not a point field: the one limit is --limit";
  return null;
}

/** The options file: what the frame and the load request get on top of the harness's own. */
export function optionsProblem(options) {
  if (typeof options !== "object" || options === null || Array.isArray(options)) return "the options file must be an object";
  for (const key of Object.keys(options)) if (!["frame", "load", "stage"].includes(key)) return `unknown key ${key} (frame, load and stage are the only ones)`;
  for (const key of ["frame", "load"]) if (options[key] !== undefined && (typeof options[key] !== "object" || options[key] === null || Array.isArray(options[key]))) return `${key} must be an object`;
  if (options.stage !== undefined && !STAGE_STATES.includes(options.stage)) return `stage must be one of ${STAGE_STATES.join(", ")}`;
  for (const key of ["kind", "releaseUrl", "wasmPaths"]) if (options.load && key in options.load) return `load.${key} is set by the harness`;
  for (const key of ["win", "framed", "parentOrigin", "allowedParentOrigin", "protocol", "createWorker", "loadRequest", "now"]) if (options.frame && key in options.frame) return `frame.${key} is set by the harness`;
  return null;
}

/** The intended stage state: the options' `stage`, else "ready" when the load asks for a stage. */
export function intendedStage(options) {
  if (options?.stage) return options.stage;
  return options?.load?.geometricUrl ? "ready" : "none";
}

/**
 * Score one hover from the page's readings, in time order, `t` in ms on the page's clock:
 *   { t, kind: "move", over, trusted }       a pointer move the page saw
 *   { t, kind: "capture", requestId, allowedNow, outstanding }   a picture request arrived
 *   { t, kind: "answered", requestId }       the frame received the picture or the refusal
 *   { t, kind: "shown", cardId }             `onShown` (cardId null: nothing)
 * The hover starts at the first trusted move over the picture. The result is one row; a hover
 * with no such move is a harness error (`row.error`), never a miss.
 */
export function scoreHover({ events, expect, limitMs = DEFAULT_LIMIT_MS, observeMs = 0, before = [] }) {
  const start = events.find((e) => e.kind === "move" && e.trusted === true && e.over === true);
  if (!start) return { error: "no trusted move over the picture was seen", expect };
  const t0 = start.t;
  const after = events.filter((e) => e.t >= t0 && e.t <= t0 + Math.max(limitMs, observeMs));
  const within = (e) => e.t - t0 <= limitMs;
  const shown = after.filter((e) => e.kind === "shown" && within(e));
  const match = shown.find((e) => e.cardId === expect);
  const captures = after.filter((e) => e.kind === "capture");
  const firstCapture = captures[0] ?? null;
  const firstShown = shown[0] ?? null;
  const shownNonNull = shown.filter((e) => e.cardId !== null);
  let outcome;
  if (match) outcome = "match";
  else if (shownNonNull.length > 0) outcome = "wrong";
  else if (shown.length > 0) outcome = "miss";
  else outcome = "timeout";
  const shownAt = match ? match.t : null;
  // Whether the match came from a picture asked for after the move, or from an earlier result.
  let shownVia = null;
  if (match) shownVia = captures.some((c) => c.t <= match.t) ? "request" : "reused";
  // From everything the context saw before the move (`before`), not only from this hover's readings.
  const history = [...before, ...events];
  const outstandingAtMove = history.filter((e) => e.kind === "capture" && e.t < t0).some((c) => !history.some((a) => a.kind === "answered" && a.requestId === c.requestId && a.t < t0));
  return {
    expect,
    outcome,
    // The first card shown was not the expected one (a match after it shows a race or a stale card).
    wrongFirst: shownNonNull.length > 0 && shownNonNull[0].cardId !== expect,
    firstShownCardId: shownNonNull[0]?.cardId ?? null,
    shownCardId: match ? match.cardId : (shownNonNull.at(-1)?.cardId ?? null),
    shownMs: shownAt === null ? null : round(shownAt - t0),
    firstShownMs: firstShown ? round(firstShown.t - t0) : null,
    shownVia,
    askedMs: firstCapture ? round(firstCapture.t - t0) : null,
    requestsAfterMove: captures.length,
    outstandingAtMove,
    movedAtMs: round(t0),
  };
}

/** Time to the expected card with every non-match counted at the limit. */
export function timeToCard(row, limitMs = DEFAULT_LIMIT_MS) {
  return row.outcome === "match" ? row.shownMs : limitMs;
}

/**
 * The picture requests that arrived while the pointer was off the picture, between a trusted
 * move off it and the next trusted move over it, ignoring the first `graceMs` after the leave.
 * `events` are the whole run's readings of one pointer session, in time order.
 */
export function requestsOffPicture(events, graceMs = OFF_PICTURE_GRACE_MS) {
  let offSince = null;
  let count = 0;
  for (const e of events) {
    if (e.kind === "move" && e.trusted === true) offSince = e.over ? null : (offSince ?? e.t);
    else if (e.kind === "capture" && offSince !== null && e.t - offSince > graceMs) count += 1;
  }
  return count;
}

/** Counters over a whole context's readings, for the hard gates. */
export function tally(events) {
  let sawPointer = false;
  let beforeAnyPointer = 0;
  let unauthorized = 0;
  let duplicates = 0;
  const unauthorizedIds = new Set();
  for (const e of events) {
    if (e.kind === "move" && e.trusted === true && e.over === true) sawPointer = true;
    if (e.kind === "capture") {
      if (!sawPointer) beforeAnyPointer += 1;
      if (e.outstanding > 0) duplicates += 1;
      if (e.allowedNow === false) unauthorizedIds.add(e.requestId);
    }
    if (e.kind === "answered" && e.how === "frame" && unauthorizedIds.has(e.requestId)) unauthorized += 1;
  }
  return { capturesBeforeAnyPointer: beforeAnyPointer, unauthorizedFramesDelivered: unauthorized, duplicateInFlight: duplicates, requestsOffPicture: requestsOffPicture(events) };
}

/** One scenario's summary. Every hover is counted; the timing is also given for matches alone. */
export function summarizeRows(rows, limitMs = DEFAULT_LIMIT_MS) {
  const counts = { hovers: rows.length, match: 0, wrong: 0, miss: 0, timeout: 0 };
  for (const row of rows) counts[row.outcome] += 1;
  const matched = rows.filter((row) => row.outcome === "match");
  return {
    ...counts,
    matchRate: rows.length ? round(counts.match / rows.length) : null,
    wrongFirst: rows.filter((row) => row.wrongFirst === true).length,
    reused: matched.filter((row) => row.shownVia === "reused").length,
    requested: matched.filter((row) => row.shownVia === "request").length,
    noRequestAfterMove: rows.filter((row) => row.askedMs === null).length,
    limitMs,
    allHoversMs: stats(rows.map((row) => timeToCard(row, limitMs))),
    matchedOnlyMs: stats(matched.map((row) => row.shownMs)),
    askedMs: stats(rows.filter((row) => row.askedMs !== null).map((row) => row.askedMs)),
  };
}

/** Group H5 rows by gap. */
export function summarizeByGap(rows, limitMs = DEFAULT_LIMIT_MS) {
  const gaps = [...new Set(rows.map((row) => row.gapMs))].sort((a, b) => a - b);
  return gaps.map((gapMs) => {
    const own = rows.filter((row) => row.gapMs === gapMs);
    return { gapMs, ...summarizeRows(own, limitMs), requestsOffPicture: own.reduce((sum, row) => sum + row.requestsOffPicture, 0) };
  });
}

/** Group H6 rows by pair: the pairs behave differently, and a pooled median hides that. */
export function summarizeByPair(rows, limitMs = DEFAULT_LIMIT_MS) {
  const pairs = [...new Set(rows.map((row) => row.pair))].sort((a, b) => a - b);
  return pairs.map((pair) => ({ pair, ...summarizeRows(rows.filter((row) => row.pair === pair), limitMs) }));
}

/**
 * The hard gates. Each is { id, ok, detail, enforced }. A gate that is not enforced is reported
 * and never fails the run. `entryLook` is the expectation that the frame asks for no picture
 * while the pointer is off the picture and asks on the entry move itself.
 */
export function evaluateGates({ tallies, loopbackViolations, h5Rows, entryLook, entryMs = DEFAULT_ENTRY_MS, schemaProblems = [] }) {
  const sum = (key) => tallies.reduce((total, t) => total + t[key], 0);
  const gates = [];
  gates.push({ id: "no-unauthorized-capture", ok: sum("capturesBeforeAnyPointer") === 0 && sum("unauthorizedFramesDelivered") === 0, detail: { beforeAnyPointer: sum("capturesBeforeAnyPointer"), framesDeliveredWithoutAuthority: sum("unauthorizedFramesDelivered") }, enforced: true });
  gates.push({ id: "no-duplicate-in-flight", ok: sum("duplicateInFlight") === 0, detail: { duplicates: sum("duplicateInFlight") }, enforced: true });
  gates.push({ id: "loopback-only", ok: loopbackViolations.length === 0, detail: { requests: loopbackViolations }, enforced: true });
  gates.push({ id: "complete-schema", ok: schemaProblems.length === 0, detail: { problems: schemaProblems }, enforced: true });
  const off = sum("requestsOffPicture");
  const applicable = h5Rows.length > 0;
  const na = { applicable: false, status: "not applicable: H5 did not run" };
  gates.push({ id: "no-requests-off-picture", ok: applicable ? off === 0 : true, detail: applicable ? { requests: off } : { ...na, requests: off }, enforced: entryLook });
  const eligible = h5Rows.filter((row) => row.gapMs >= STALE_GAP_MS && !row.outstandingAtMove && row.sceneChanged !== false);
  const late = eligible.filter((row) => row.askedMs === null || row.askedMs > entryMs);
  gates.push({ id: "entry-look-same-call", ok: applicable ? eligible.length > 0 && late.length === 0 : true, detail: applicable ? { eligible: eligible.length, notAskedWithin: late.length, entryMs } : { ...na, entryMs }, enforced: entryLook });
  return gates;
}

/** What the chosen scenarios need from the script and the other options; null when it fits. */
export function scenarioProblem({ script, scenarios, loadMode, haveScenes }) {
  if (scenarios.includes("H6")) {
    if (loadMode !== "play") return "H6 needs --load play: its frame is made at play and its stage is pinned before the first hover";
    if (!script.pairs) return "H6 needs pairs in the script";
  }
  const withScene = [...script.hovers, ...(script.slowPoint ? [script.slowPoint] : []), ...(script.pairs ?? [])];
  if (withScene.some((h) => h.scene !== undefined) && !haveScenes) return "the script names scenes: give --scenes and --art";
  return null;
}

/** `--expect-entry-look` needs evidence: H5 run with at least one gap long enough to be stale. */
export function entryLookProblem({ scenarios, gaps }) {
  if (!scenarios.includes("H5")) return "--expect-entry-look needs the H5 scenario";
  if (!gaps.some((g) => g >= STALE_GAP_MS)) return `--expect-entry-look needs a gap of at least ${STALE_GAP_MS} ms in --gaps`;
  return null;
}

/** The exit code: 1 when an enforced gate fails, else 0. */
export function exitCodeFor(gates) {
  return gates.some((gate) => gate.enforced && !gate.ok) ? 1 : 0;
}

const REQUIRED = ["schema", "profile", "options", "scenarios", "gates", "rows", "passed"];
const REQUIRED_PROFILE = ["machine", "chrome", "backend", "backendForced", "stageIntended", "load", "cold", "toolkitCommit", "startedAt"];

/** What is missing from a report, as a list of problems; empty when it is complete. */
export function reportProblems(report) {
  const problems = [];
  for (const key of REQUIRED) if (!(key in report)) problems.push(`missing ${key}`);
  const profile = report.profile ?? {};
  for (const key of REQUIRED_PROFILE) if (!(key in profile)) problems.push(`profile: missing ${key}`);
  for (const [name, summary] of Object.entries(report.scenarios ?? {})) {
    if (summary === null) continue;
    for (const key of ["hovers", "match", "wrong", "miss", "timeout", "allHoversMs", "matchedOnlyMs"]) {
      if (!(key in summary) && !(Array.isArray(summary.byGap) || Array.isArray(summary.byPair))) problems.push(`scenario ${name}: missing ${key}`);
    }
  }
  for (const row of report.rows ?? []) {
    for (const key of ["scenario", "trial", "outcome", "shownMs", "askedMs", "stage", "backend"]) if (!(key in row)) problems.push(`row ${row.scenario}#${row.trial}: missing ${key}`);
  }
  return problems;
}

export const REPORT_SCHEMA = "hover-speed/1";

/** Assemble the report from the run's pieces. */
export function buildReport({ profile, options, rows, tallies, loopbackViolations, entryLook, entryMs, limitMs = DEFAULT_LIMIT_MS, notes = [] }) {
  const scenarios = {};
  for (const name of SCENARIOS) {
    const own = rows.filter((row) => row.scenario === name);
    if (own.length === 0) {
      scenarios[name] = null;
      continue;
    }
    if (name === "H5") scenarios[name] = { byGap: summarizeByGap(own, limitMs), ...summarizeRows(own, limitMs) };
    else if (name === "H6") scenarios[name] = { byPair: summarizeByPair(own, limitMs), ...summarizeRows(own, limitMs) };
    else scenarios[name] = summarizeRows(own, limitMs);
  }
  const report = { schema: REPORT_SCHEMA, profile, options, scenarios, gates: [], rows, notes, passed: false };
  const gates = evaluateGates({ tallies, loopbackViolations, h5Rows: rows.filter((row) => row.scenario === "H5"), entryLook, entryMs, schemaProblems: [] });
  report.gates = gates;
  const problems = reportProblems(report);
  if (problems.length > 0) {
    report.gates = evaluateGates({ tallies, loopbackViolations, h5Rows: rows.filter((row) => row.scenario === "H5"), entryLook, entryMs, schemaProblems: problems });
  }
  report.passed = exitCodeFor(report.gates) === 0;
  return report;
}
