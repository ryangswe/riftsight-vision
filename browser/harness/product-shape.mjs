// SPDX-License-Identifier: Apache-2.0
// What the hover browser test needs from a product module (the default export given with
// --product). `productProblems` returns the reasons a module cannot be used, or an empty list.
// It checks the shape only; whether the values fit the product is what the run shows.

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v) => typeof v === "string" && v.length > 0;
const isNumber = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
/** The time limits a product module may set, in ms, and their defaults. A paused picture's card is
 *  "at once": 1000 ms, where the products' CI shows it in 250 to 370 ms. A card that arrives
 *  under a resting pointer waits for the next look of the 2 s empty-spot cadence (S-C14), then a
 *  look and its picture: 3000 ms. */
export const LIMIT_DEFAULTS = { pausedMs: 1000, arrivalMs: 3000 };
const LIMIT_KEYS = Object.keys(LIMIT_DEFAULTS);
/** The card slots, in the order the clip draws them: a later slot is laid over an earlier one. */
export const SLOTS = ["A", "B", "C", "D"];

/** @param {unknown} product @param {readonly string[]} checkIds the shared check ids */
export function productProblems(product, checkIds) {
  if (!isObject(product)) return ["the module's default export is not an object"];
  const p = /** @type {Record<string, any>} */ (product);
  const problems = [];
  for (const key of ["name", "debugGlobal", "outlineSelector", "wakePage"]) if (!isString(p[key])) problems.push(`${key} is not a text`);
  if (!(p.config instanceof URL)) problems.push("config is not a URL (the product's config file)");
  for (const key of ["settingsUrl", "testSettings", "artPath"]) if (typeof p[key] !== "function") problems.push(`${key} is not a function`);
  if (!isObject(p.frames) || !isString(p.frames.compute) || !isString(p.frames.tooltip)) problems.push("frames needs compute and tooltip file names");
  if (!isObject(p.tooltipIds) || !["img", "art", "pill"].every((k) => isString(p.tooltipIds[k]))) problems.push("tooltipIds needs img, art and pill");
  if (!isObject(p.keys) || !isString(p.keys.enabled) || !isString(p.keys.keepCard)) problems.push("keys needs enabled and keepCard");
  if (!isObject(p.cards) || !SLOTS.every((k) => isString(p.cards[k])) || Object.keys(p.cards).length !== SLOTS.length) problems.push(`cards needs exactly ${SLOTS.join(", ")}, each a catalog id`);
  if (!isNumber(p.cardWidth) || !isNumber(p.cardAspect)) problems.push("cardWidth and cardAspect are not positive numbers");
  if (!isObject(p.clip) || !["width", "height", "fps", "seconds"].every((k) => isNumber(p.clip[k]))) problems.push("clip needs width, height, fps and seconds");
  if (!isObject(p.places) || !SLOTS.every((k) => isObject(p.places[k]) && Number.isFinite(p.places[k].x) && Number.isFinite(p.places[k].y)) || Object.keys(p.places).length !== SLOTS.length) {
    problems.push(`places needs exactly ${SLOTS.join(", ")}, each with x and y`);
  } else {
    // `from`, `until` and `back` are clip seconds: shown from, shown until, and shown again from
    // (a card that leaves and comes back with no seek).
    for (const slot of SLOTS) {
      const q = p.places[slot];
      for (const key of ["from", "until", "back"]) if (q[key] !== undefined && !(Number.isFinite(q[key]) && q[key] >= 0)) problems.push(`places.${slot}.${key} is not a time in seconds`);
      if (q.back !== undefined && !(Number.isFinite(q.until) && q.back > q.until)) problems.push(`places.${slot}.back needs an until before it`);
      if (q.back !== undefined && q.from !== undefined) problems.push(`places.${slot} has both from and back`);
    }
  }
  if (!isObject(p.expectedFail)) problems.push("expectedFail is not an object");
  else for (const id of Object.keys(p.expectedFail)) if (!checkIds.includes(id)) problems.push(`expectedFail names no check ${id}`);
  if (!(p.root instanceof URL)) problems.push("root is not a URL (the product's repository root: --art must be outside it)");
  if (p.unsupported !== undefined) {
    if (!isObject(p.unsupported)) problems.push("unsupported is not an object");
    else {
      for (const [id, reason] of Object.entries(p.unsupported)) {
        if (!checkIds.includes(id)) problems.push(`unsupported names no check ${id}`);
        else if (!isString(reason)) problems.push(`unsupported ${id} has no reason`);
        else if (isObject(p.expectedFail) && id in p.expectedFail) problems.push(`${id} is both unsupported and an expected failure`);
      }
    }
  }
  if (p.dist !== undefined && !(p.dist instanceof URL)) problems.push("dist is not a URL");
  // Optional: the time limits of the timed checks, and the margin of the --baseline comparison.
  if (p.limits !== undefined) {
    if (!isObject(p.limits)) problems.push("limits is not an object");
    else {
      for (const [key, value] of Object.entries(p.limits)) {
        if (!LIMIT_KEYS.includes(key)) problems.push(`limits has no ${key} (it takes ${LIMIT_KEYS.join(", ")})`);
        else if (!isNumber(value)) problems.push(`limits.${key} is not a positive number of ms`);
      }
    }
  }
  if (p.baseline !== undefined) {
    if (!isObject(p.baseline)) problems.push("baseline is not an object");
    else {
      for (const [key, value] of Object.entries(p.baseline)) {
        const finite = typeof value === "number" && Number.isFinite(value);
        if (key === "factor") {
          if (!(finite && value >= 1)) problems.push("baseline.factor is not a number of 1 or more");
        } else if (key === "slackMs") {
          if (!(finite && value >= 0)) problems.push("baseline.slackMs is not a number of ms, 0 or more");
        } else problems.push(`baseline has no ${key} (it takes factor, slackMs)`);
      }
    }
  }
  return problems;
}
