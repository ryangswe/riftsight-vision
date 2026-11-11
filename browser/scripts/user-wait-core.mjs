// SPDX-License-Identifier: Apache-2.0
// The parts of the wait measurement (scripts/user-wait.mjs) that need no browser: how one rest
// is scored from the session's readings, the summary of a run, the rest script's checks, the
// request policy and the median of a calibration. They start nothing and read no file, so
// test/user-wait.test.ts runs them on scripted readings.

/** How long to wait for the session to be ready before the run fails, in ms. It is not part of any rest. */
export const DEFAULT_READY_TIMEOUT_MS = 120_000;

/** How long a rest waits for the right name before it counts as a miss, in ms. */
export const DEFAULT_LIMIT_MS = 10_000;

/**
 * Score one rest. `readings` are the changes of what `session.atPointer()` returned, in time
 * order: `{ t, cardId }` with `t` in ms since the pointer came to rest and `cardId` null while
 * nothing shows. `movedAtMs` is when the pointer moved again (null: it did not before the rest
 * ended).
 *
 * - The right card shows: `answered: true`, `waitMs` is the time of its first reading, and
 *   `wrongFirst` says that another card showed before it.
 * - The pointer moved again before any name showed: `leftBeforeAnswer: true`. It is neither a
 *   wait nor a miss. (If a wrong name was showing, the viewer did see a name: that is a miss.)
 * - Otherwise a miss: `answered: false`, and `waitMs` is the limit, so the median keeps it.
 *
 * A reading at or after the move, or after the limit, does not count.
 */
export function scoreRest({ expect, readings, movedAtMs = null, limitMs = DEFAULT_LIMIT_MS }) {
  const end = movedAtMs === null ? limitMs : Math.min(limitMs, movedAtMs);
  let wrongFirst = false;
  for (const { t, cardId } of readings) {
    if (t > end || (movedAtMs !== null && t >= movedAtMs)) break;
    if (cardId === null || cardId === undefined) continue;
    if (cardId === expect) return { expect, answered: true, wrongFirst, leftBeforeAnswer: false, waitMs: round(t) };
    wrongFirst = true;
  }
  if (movedAtMs !== null && movedAtMs < limitMs && !wrongFirst) return { expect, answered: false, wrongFirst: false, leftBeforeAnswer: true, waitMs: null };
  return { expect, answered: false, wrongFirst, leftBeforeAnswer: false, waitMs: limitMs };
}

const round = (value) => Math.round(value * 100) / 100;

/** The median of numbers (the mean of the middle two for an even count); null for none. */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return round(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/** The nearest-rank percentile (p in 1 to 100); null for no numbers. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]);
}

/**
 * The summary of a run's scored rests. Median and 90th percentile run over the rests that were
 * answered and the ones that were missed (a miss counts as the limit). Rests that were left
 * before an answer are counted apart and are in neither.
 */
export function summarize(lines) {
  const timed = lines.filter((line) => !line.leftBeforeAnswer).map((line) => line.waitMs);
  return {
    rests: lines.length,
    answered: lines.filter((line) => line.answered).length,
    missed: lines.filter((line) => !line.answered && !line.leftBeforeAnswer).length,
    wrongFirst: lines.filter((line) => line.wrongFirst).length,
    leftBeforeAnswer: lines.filter((line) => line.leftBeforeAnswer).length,
    answeredFromOldAnalysis: answeredWithoutNewAnalysis(lines).length,
    medianMs: median(timed),
    p90Ms: percentile(timed, 90),
  };
}

/** The analysis time per cycle: the median of the times the session reported, with the count. */
export function cycleSummary(cycles) {
  return { cycles: cycles.length, medianWorkerMs: median(cycles.map((c) => c.workerMs)), medianRoundTripMs: median(cycles.map((c) => c.roundTripMs)) };
}

/**
 * The share of the measured run's wall time spent analyzing: the summed reported analysis times
 * (`reportedMs`, slowed and corrected as the per-cycle numbers are) over the run's wall time.
 */
export function analysisShare(reportedMs, wallMs) {
  const analyzedMs = reportedMs.reduce((a, b) => a + b, 0);
  return { runWallMs: wallMs, runAnalyses: reportedMs.length, runAnalyzedMs: round(analyzedMs), analyzingShare: wallMs > 0 ? round(analyzedMs / wallMs) : null };
}

/** The slowdown a calibration read: the slowed time over the unslowed one, each the median of its runs. */
export function measuredFactor(baselineMs, slowedMs) {
  const base = median(baselineMs);
  const slow = median(slowedMs);
  return base === null || slow === null || base <= 0 ? null : round(slow / base);
}

/** The values of `--geometric-scope`: the session option's (README.md, "Measuring the wait"). */
export const GEOMETRIC_SCOPES = ["all", "focus"];

/**
 * The error text of the geometric flags of a run, or null. `scope` is `--geometric-scope`,
 * `settings` is `--geometric` (the stage's settings document, a path inside the release folder)
 * and `gpu` is `--gpu`. A scope without a stage would measure nothing, so it is refused.
 */
export function geometricFlagsProblem({ scope, settings, gpu }) {
  if (scope !== undefined && !GEOMETRIC_SCOPES.includes(scope)) return `--geometric-scope ${scope}: not one of ${GEOMETRIC_SCOPES.join(", ")}`;
  if (scope !== undefined && settings === undefined) return "--geometric-scope needs --geometric (the stage's settings document, inside the release folder)";
  if (settings !== undefined && gpu !== true) return "--geometric needs --gpu: the stage's vote runs on WebGPU, which the default headless Chrome turns off";
  return null;
}

/**
 * What a session's geometric status means for a run that asked for the stage: `ok` only when it
 * is ready, else `problem` says why the numbers would not be the stage's. `status` is
 * `session.status().geometric` (null when no stage was asked for), `backend` the session's.
 */
export function geometricGate(status, backend) {
  if (status === null || status === undefined) return { ok: false, problem: "the session reports no geometric stage" };
  if (status.state === "ready") return { ok: true, problem: null };
  const why = status.reason ? ` (${status.reason})` : "";
  return { ok: false, problem: `the geometric stage is ${status.state}${why}; backend ${backend ?? "unknown"}` };
}

/**
 * The stage's time and work over the cycles. `geometricMs` is the stage's time in an analysis
 * and `verified` the number of faces it verified in it (faces with geometric evidence). The
 * median time is given over all analyses that have one and over those that verified at least
 * one crop, since in focus scope an analysis with the pointer over no face verifies none.
 */
export function geometricSummary(cycles) {
  const timed = cycles.filter((c) => typeof c.geometricMs === "number");
  const counted = timed.filter((c) => typeof c.verified === "number").map((c) => c.verified);
  const verifying = timed.filter((c) => typeof c.verified === "number" && c.verified >= 1);
  return {
    geometricCycles: timed.length,
    medianGeometricMs: median(timed.map((c) => c.geometricMs)),
    verifyingCycles: verifying.length,
    medianGeometricMsVerifying: median(verifying.map((c) => c.geometricMs)),
    medianCropsVerified: median(counted),
    p90CropsVerified: percentile(counted, 90),
    maxCropsVerified: counted.length === 0 ? null : Math.max(...counted),
  };
}

/** The report of a run. `profile` says how it was run; `lines` are scored rests. */
export function buildReport({ profile, lines, analysis }) {
  return { profile, rests: lines, summary: summarize(lines), analysis };
}

/** The error text of a rest script that is not one, or null. The format is in README.md. */
export function restScriptProblem(script) {
  if (script === null || typeof script !== "object" || !Array.isArray(script.rests) || script.rests.length === 0) return "needs a `rests` list with at least one rest";
  if (script.warmUpCycles !== undefined && !(Number.isInteger(script.warmUpCycles) && script.warmUpCycles >= 0)) return "`warmUpCycles` must be a whole number";
  for (const [at, rest] of script.rests.entries()) {
    const fraction = (v) => typeof v === "number" && v >= 0 && v <= 1;
    if (!rest || typeof rest.expect !== "string" || !fraction(rest.x) || !fraction(rest.y)) return `rest ${at + 1} needs \`expect\` (a card id) and \`x\`, \`y\` (fractions of the picture, 0 to 1)`;
    if (rest.pause !== undefined && typeof rest.pause !== "boolean") return `rest ${at + 1}: \`pause\` must be true or false`;
    for (const key of ["pauseMs", "leaveAfterMs", "limitMs"]) if (rest[key] !== undefined && !(typeof rest[key] === "number" && rest[key] >= 0)) return `rest ${at + 1}: \`${key}\` must be a number of ms`;
  }
  return null;
}

/**
 * Whether a page may make this request: only to the harness's own local server (`origin`), and
 * for the page's own `data:` and `blob:` URLs, which leave nothing. Anything else is refused.
 */
export function requestAllowed(url, origin) {
  if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The guard on a run's requests: give each request the page makes to `handle` (a puppeteer
 * request: `url()`, `abort()`, `continue()`). A request outside `requestAllowed` is aborted and
 * its URL kept in `violations`, and the run fails with them.
 */
export function createRequestGuard(origin) {
  const violations = [];
  return {
    violations,
    handle(request) {
      const url = request.url();
      if (requestAllowed(url, origin)) return request.continue();
      violations.push(url);
      return request.abort("blockedbyclient");
    },
  };
}

/**
 * The byte range a `Range` request header asks of a file of `size` bytes, for the local server.
 * Without range answers a browser can seek a video only inside what it has buffered, and a seek
 * past that lands at the start with no error. One range only (`bytes=a-b`, `bytes=a-` or the
 * last `bytes=-n`): `null` means send the whole file (no header, or one this does not read, such
 * as several ranges), `"unsatisfiable"` means answer 416.
 */
export function byteRange(header, size) {
  if (typeof header !== "string") return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== "" && Number(m[2]) < start) return null;
  }
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

/**
 * Whether the browser runs natively. `machine` is Node's `process.arch` ("arm64" or "x64"),
 * `binary` the architectures found in the Chrome file, `page` what the page's
 * `navigator.userAgentData` says it runs as (`architecture`: "arm" or "x86"). A binary running
 * as another architecture than the machine is translated (Rosetta on a Mac), which changes
 * every number.
 */
export function architectureNote({ machine, binary, page }) {
  const wanted = machine === "arm64" ? "arm" : machine === "x64" ? "x86" : machine;
  const seen = page?.architecture ?? null;
  return { machineArch: machine, binaryArch: binary, pageArch: seen, translated: seen === null ? null : seen !== wanted };
}

/** The error text of a scenes file that is not one, or null. The format is in README.md. */
export function scenesProblem(spec, rests = []) {
  if (spec === null || typeof spec !== "object" || spec.scenes === null || typeof spec.scenes !== "object" || Array.isArray(spec.scenes)) return "needs a `scenes` object";
  const names = Object.keys(spec.scenes);
  if (names.length === 0) return "needs at least one scene";
  for (const name of names) {
    const cards = spec.scenes[name];
    if (!Array.isArray(cards) || cards.length === 0) return `scene ${name} needs a list of cards`;
    for (const [at, card] of cards.entries()) {
      const bad = !card || typeof card.card !== "string" || !/^[A-Za-z0-9._-]+$/.test(card.card) || typeof card.x !== "number" || typeof card.y !== "number" || (card.turns !== undefined && ![0, 1, 2, 3].includes(card.turns));
      if (bad) return `scene ${name}, card ${at + 1} needs \`card\` (an image name without its extension), \`x\`, \`y\` (pixels) and optionally \`turns\` (0 to 3)`;
    }
  }
  if (spec.start !== undefined && !names.includes(spec.start)) return `start names no scene (${spec.start})`;
  for (const [at, rest] of rests.entries()) if (rest.scene !== undefined && !names.includes(rest.scene)) return `rest ${at + 1} names a scene that the scenes file does not have (${rest.scene})`;
  return null;
}

/**
 * A scored rest with what a scene change makes worth knowing: the scene, how many frames the
 * session analyzed from the rest to the end of it (`analysesBetween`; null when not counted) and
 * the first card it showed (`firstShown`; with `wrongFirst` it tells a stale answer).
 */
export function describeRest(scored, { scene = null, framesStart = null, framesEnd = null, readings = [] } = {}) {
  const first = readings.find((reading) => reading.cardId !== null && reading.cardId !== undefined);
  const counted = typeof framesStart === "number" && typeof framesEnd === "number";
  return { ...scored, scene, analysesBetween: counted ? Math.max(0, framesEnd - framesStart) : null, firstShown: first ? first.cardId : null };
}

/**
 * Warnings for a scenes file and a rest script that are valid but may not make a rest wait for a
 * new analysis: a rest whose expected card already sits at the same place in the scene before it
 * (the previous rest's scene, or the start scene for the first) can be answered from an old one.
 */
export function scenesWarnings(spec, rests = []) {
  const names = Object.keys(spec.scenes);
  let before = spec.start ?? names[0];
  const warnings = [];
  for (const [at, rest] of rests.entries()) {
    const now = rest.scene ?? before;
    const placed = (scene) => (spec.scenes[scene] ?? []).find((card) => card.card === rest.expect);
    const was = placed(before);
    const is = placed(now);
    if (was && is && was.x === is.x && was.y === is.y && (was.turns ?? 0) === (is.turns ?? 0)) warnings.push(`rest ${at + 1} expects ${rest.expect}, which is already there in scene ${before}: it can be answered from an old analysis`);
    before = now;
  }
  return warnings;
}

/** The numbers (1-based) of the rests that were answered with no analysis since the rest began. */
export function answeredWithoutNewAnalysis(lines) {
  return lines.filter((line) => line.answered && line.analysesBetween === 0).map((line) => line.index);
}

/**
 * The correction for the page throttle's side effect on the worker. With the page throttled, the
 * worker's own analysis runs faster (measured: the same work, 29 ms against 16 ms). `baseline`
 * is the median raw analysis time with the page unthrottled, `throttled` the same with it
 * throttled; the correction is their ratio (1 when either is missing, so nothing is corrected).
 */
export function correction(baseline, throttled) {
  return typeof baseline === "number" && typeof throttled === "number" && baseline > 0 && throttled > 0 ? Math.round((baseline / throttled) * 1000) / 1000 : 1;
}

/**
 * The correction a run uses: the one given (`--correction`), else the measured ratio. `source`
 * says which, for the report.
 */
export function chooseCorrection(given, baseline, throttled) {
  return given === undefined || given === null ? { c: correction(baseline, throttled), source: "measured" } : { c: given, source: "given" };
}

/** The error text of a `--correction` value that is not a number above 0, or null. */
export function correctionProblem(value) {
  return Number.isFinite(value) && value > 0 ? null : "not a number above 0";
}

/**
 * How many analyses at the emulated speed run before the rests: `count` in a warm run, so a paced
 * run's pacer has measured slowed analyses; none in a cold run, whose first rest must meet the
 * models' first analysis.
 */
export function settleAnalyses(cold, count) {
  return cold ? 0 : count;
}

/** What the wrapper reports and holds for one frame: `rate` x `c` x the raw time, held for the rest of it. */
export function emulatedTime(rawMs, rate, c) {
  const reportedMs = rate * c * rawMs;
  return { reportedMs, holdMs: Math.max(0, reportedMs - rawMs) };
}

/**
 * What the wrapper holds the worker's release-loaded reply for in a `--load-on-hover` run: the
 * same rule as an analysis. The emulated load is `rate` x `c` x the raw load time the wrapper
 * measured (from the load request to its reply), held for the difference.
 */
export function loadHold(rawLoadMs, rate, c) {
  const { reportedMs, holdMs } = emulatedTime(rawLoadMs, rate, c);
  return { rawMs: round(rawLoadMs), emulatedMs: round(reportedMs), holdMs: round(holdMs) };
}

/** How a run is started, for the report's profile. */
export function runMode({ cold, loadOnHover }) {
  return loadOnHover ? "cold, load on the first hover" : cold ? "cold" : "warm";
}

/** The error text of a `--load-on-hover` combination that is not allowed, or null. */
export function loadOnHoverProblem({ loadOnHover, correction: given, measuredPacing }) {
  if (!loadOnHover) return null;
  if (given !== undefined) return "--load-on-hover cannot be used with --correction (a load-on-hover run is cold: c is 1)";
  if (measuredPacing) return "--load-on-hover cannot be used with --measured-pacing (the pacer needs analyses before the first rest, which a load-on-hover run does not have)";
  return null;
}

/**
 * Rest 1 of a `--load-on-hover` run. `scored` is the scored rest, whose clock started when the
 * pointer came to rest. The session was created then, and was ready `readyAtMs` after the pointer
 * came to rest (null: not before the rest ended); `createdAtMs` is when it was created, on the
 * same clock. `waitMs` already includes the load. `readyMs` is the part that was the load, and
 * `afterReadyMs` what remained after the session was ready (the first analysis and the answer),
 * for a rest that was answered.
 */
export function loadRest(scored, { createdAtMs, readyAtMs }) {
  const ready = typeof readyAtMs === "number";
  const readyMs = ready ? round(Math.max(0, readyAtMs - createdAtMs)) : null;
  const afterReadyMs = ready && scored.answered ? round(Math.max(0, scored.waitMs - readyAtMs)) : null;
  return { ...scored, loadIncluded: true, readyMs, afterReadyMs };
}

/**
 * The load as the wrapper applied it, for the report: the raw and the emulated time, the time the
 * reply was really held, and the factor applied (the real time over the raw one). `messages` are
 * what the wrapper reported for each load (normally one).
 */
export function loadSummary(messages) {
  const sum = (key) => messages.reduce((total, m) => total + m[key], 0);
  if (messages.length === 0) return { loads: 0, rawMs: null, emulatedMs: null, heldMs: null, appliedFactor: null };
  const rawMs = sum("rawMs");
  return { loads: messages.length, rawMs: round(rawMs), emulatedMs: round(sum("reportedMs")), heldMs: round(sum("heldMs")), appliedFactor: rawMs > 0 ? round(sum("heldMs") / rawMs) : null };
}
