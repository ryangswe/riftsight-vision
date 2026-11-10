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
    medianMs: median(timed),
    p90Ms: percentile(timed, 90),
  };
}

/** The analysis time per cycle: the median of the times the session reported, with the count. */
export function cycleSummary(cycles) {
  return { cycles: cycles.length, medianWorkerMs: median(cycles.map((c) => c.workerMs)), medianRoundTripMs: median(cycles.map((c) => c.roundTripMs)) };
}

/** The slowdown a calibration read: the slowed time over the unslowed one, each the median of its runs. */
export function measuredFactor(baselineMs, slowedMs) {
  const base = median(baselineMs);
  const slow = median(slowedMs);
  return base === null || slow === null || base <= 0 ? null : round(slow / base);
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
