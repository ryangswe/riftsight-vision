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
// function the text belongs to; give the text base64-encoded (`btoa(text)`), and keep the text
// out of the id and the comments of this file.

/** @typedef {{ id: string, module: string, text: string }} RealmMark */

// A mark's text is stored encoded (base64) and decoded when the list is made, so a built copy of
// the check, which holds this list, never holds a mark verbatim and does not count itself when
// it is pointed at a folder that holds it. An id never contains its text, for the same reason.
const mark = (id, module, encoded) => ({ id, module, text: atob(encoded) });

/** @type {readonly RealmMark[]} */
export const REALM_MARKS = [
  // The capture control: the content realm's side of a frame capture.
  mark("capture-control.ts:NOT_POINTING", "src/capture-control.ts", "bm90IHBvaW50aW5nIGF0IHRoZSB2aWRlbw=="),
  // The session core: the compute realm's state machine (the reason it reports after a worker restart).
  mark("session-core.ts:WORKER_RESTART_REASON", "src/session-core.ts", "d29ya2VyLXJlc3RhcnRlZA=="),
  // The settings core: the settings and background realm's stored values.
  mark("settings-core.ts:LAST_GOOD_KEY", "src/host/settings-core.ts", "c2V0dGluZ3MubGFzdEdvb2Q="),
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
