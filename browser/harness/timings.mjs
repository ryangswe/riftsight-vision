// SPDX-License-Identifier: Apache-2.0
// The hover browser test's times: what a run measured, by name, and the comparison with a saved
// run's times (--baseline), so that a build that got slower fails before anyone feels it. A run
// writes its times to timings.json beside report.json; a product keeps the file of its last
// release and passes it with --baseline.

/** How much slower than the saved time a time may be: factor × saved + slackMs. Set from 16 CI runs
 *  of two products' hover browser tests (Linux x64, WebAssembly): the named card's picture took
 *  250 to 369 ms and the cached reload 1091 to 2143 ms; in the same runs the reload after an idle
 *  unload took 976 to 1917 ms. So a time may double from run to run. It
 *  catches a step change, not a drift. */
export const TIMING_DEFAULTS = { factor: 2, slackMs: 250 };
/** Times that are reported but not compared, because they vary by design: the second tab's waits
 *  for a model load that may end before or after the pointer's 10 s (1.1 to 15.1 s in the same
 *  runs), and a card's arrival lands anywhere in a 2 s look cadence (S-C14). Their own checks
 *  bound them. */
export const REPORTED_ONLY = ["secondTabMs", "arrivalMs"];

/** The named times (ms) in a run's counts. A time the run did not measure is left out. */
export function timingsOf(counts) {
  const times = {};
  const put = (key, value) => {
    if (Number.isFinite(value)) times[key] = value;
  };
  put("artVisibleMs", counts.namedCard?.artVisibleMs);
  for (const [slot, ms] of Object.entries(counts.pausedMs ?? {})) put(`paused${slot}Ms`, ms);
  put("arrivalMs", counts.arrival?.ms);
  put("secondTabMs", counts.secondTab?.artVisibleMs);
  put("cachedReloadMs", counts.cachedReload?.artVisibleMs);
  put("idleReloadMs", counts.idleReloadMs);
  return times;
}

/** Each time slower than its saved one by more than the margin. A time in only one of the two is
 *  listed apart and fails nothing: a check that did not measure it fails on its own. */
export function compareTimings(saved, now, { factor = TIMING_DEFAULTS.factor, slackMs = TIMING_DEFAULTS.slackMs } = {}) {
  const compared = [];
  const slower = [];
  const onlySaved = [];
  for (const [key, base] of Object.entries(saved)) {
    if (REPORTED_ONLY.includes(key)) continue;
    if (!(key in now)) {
      onlySaved.push(key);
      continue;
    }
    const limit = Math.round(base * factor + slackMs);
    compared.push(key);
    if (now[key] > limit) slower.push({ key, saved: base, now: now[key], limit });
  }
  const onlyNow = Object.keys(now).filter((key) => !(key in saved) && !REPORTED_ONLY.includes(key));
  return { compared, slower, onlySaved, onlyNow };
}

/** The reasons a saved timings file cannot be used, or an empty list. Its shape is what a run
 *  writes: { passed, timings: { name: ms }, measuredOn: { ... } }. A failed run's file is refused. */
export function timingsFileProblems(doc) {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return ["it is not a JSON object"];
  const { timings } = /** @type {Record<string, any>} */ (doc);
  if (typeof timings !== "object" || timings === null || Array.isArray(timings)) return ["it has no timings object"];
  const problems = [];
  if (/** @type {Record<string, any>} */ (doc).passed === false) problems.push("it is from a failed run");
  for (const [key, ms] of Object.entries(timings)) if (!(typeof ms === "number" && Number.isFinite(ms) && ms >= 0)) problems.push(`timings.${key} is not a time in ms`);
  if (Object.keys(timings).length === 0) problems.push("its timings object is empty");
  return problems;
}
