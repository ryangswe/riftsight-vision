// SPDX-License-Identifier: Apache-2.0
// Realm marks: string literals that say "this module's code is in this file". A page, a worker
// or a background holds one copy of the runtime; a second copy (the capture control twice in
// one content script, say) would run two capture loops. A built file survives minifying with
// its string literals unchanged, so a count of each mark in a built file counts the copies of
// its module. node/realm-check.ts counts them in a product's build; test/realm-marks.test.ts
// proves, on the toolkit's own build, that each mark occurs once in every output that holds its
// module and nowhere else.
//
// Pick a mark that sits in code the module always keeps (an exported constant, an error text
// that a used function throws), is long enough to occur nowhere else, and is not a name the
// minifier could shorten. Add the module's file (relative to browser/) and the constant or
// function the text belongs to; the text is the literal as it appears in the source.

/** @typedef {{ id: string, module: string, text: string }} RealmMark */

/** @type {readonly RealmMark[]} */
export const REALM_MARKS = [
  // The capture control: the content realm's side of a frame capture.
  { id: "capture-control.ts:NOT_POINTING", module: "src/capture-control.ts", text: "not pointing at the video" },
  // The session core: the compute realm's state machine (the reason it reports after a worker restart).
  { id: "session-core.ts:worker-restarted", module: "src/session-core.ts", text: "worker-restarted" },
  // The settings core: the settings and background realm's stored values.
  { id: "settings-core.ts:LAST_GOOD_KEY", module: "src/host/settings-core.ts", text: "settings.lastGood" },
];

/** How many times `text` occurs in `source` (overlaps are not counted). */
export function countMark(source, text) {
  let count = 0;
  for (let at = source.indexOf(text); at !== -1; at = source.indexOf(text, at + text.length)) count += 1;
  return count;
}

/** Each mark's count in `source`, for the marks that occur at all: `[{ id, count }]`. */
export function countMarks(source, marks = REALM_MARKS) {
  const found = [];
  for (const mark of marks) {
    const count = countMark(source, mark.text);
    if (count > 0) found.push({ id: mark.id, count });
  }
  return found;
}
