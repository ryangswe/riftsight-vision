// SPDX-License-Identifier: Apache-2.0
// The hover browser test's times: what a run measured, by name, and the comparison with a saved
// run's times (--baseline), so that a build that got slower fails before anyone feels it. A run
// writes its times to timings.json beside report.json; a product keeps the file of its last
// release and passes it with --baseline.

/** How much slower than the saved time a time may be: factor × saved + slackMs. CI runners vary
 *  from run to run, so the margin is wide: it catches a step change, not a drift. */
export const TIMING_DEFAULTS = { factor: 1.5, slackMs: 750 };

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
    if (!(key in now)) {
      onlySaved.push(key);
      continue;
    }
    const limit = Math.round(base * factor + slackMs);
    compared.push(key);
    if (now[key] > limit) slower.push({ key, saved: base, now: now[key], limit });
  }
  const onlyNow = Object.keys(now).filter((key) => !(key in saved));
  return { compared, slower, onlySaved, onlyNow };
}

/** The reasons a saved timings file cannot be used, or an empty list. Its shape is what a run
 *  writes: { timings: { name: ms }, measuredOn: { ... } }. */
export function timingsFileProblems(doc) {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return ["it is not a JSON object"];
  const { timings } = /** @type {Record<string, any>} */ (doc);
  if (typeof timings !== "object" || timings === null || Array.isArray(timings)) return ["it has no timings object"];
  const problems = [];
  for (const [key, ms] of Object.entries(timings)) if (!(typeof ms === "number" && Number.isFinite(ms) && ms >= 0)) problems.push(`timings.${key} is not a time in ms`);
  if (Object.keys(timings).length === 0) problems.push("its timings object is empty");
  return problems;
}
