// SPDX-License-Identifier: Apache-2.0
// Realm marks: string literals that say "this module's code is in this file". A page, a worker
// or a background holds one copy of the runtime; a second copy (the capture control twice in
// one content script, say) would run two capture loops. A built file survives minifying with
// its string literals unchanged, so a count of each mark in a built file counts the copies of
// its module. node/realm-check.ts counts them in a product's build; test/realm-marks.test.ts
// proves, on the toolkit's own build, that each mark occurs once in every output that holds its
// module and nowhere else.
//
// Pick a mark that sits in code the module always keeps (an error text that a function the
// module always runs throws), long enough to occur nowhere else, and a text no product has reason
// to write: never a documented reason, a message kind or a storage key, which a product's own
// code repeats (a product that bundles its own copy of one beside the runtime would fail the
// check). Name the module's file (relative to browser/); give the text base64-encoded
// (`btoa(text)`), and keep the text out of the id and the comments of this file.

/** @typedef {{ id: string, module: string, text: string }} RealmMark */

// A mark's text is stored encoded (base64) and decoded when the list is made, so a built copy of
// the check, which holds this list, never holds a mark verbatim and does not count itself when
// it is pointed at a folder that holds it. An id never contains its text, for the same reason.
const mark = (id, module, encoded) => ({ id, module, text: atob(encoded) });

/** @type {readonly RealmMark[]} */
export const REALM_MARKS = [
  // The capture control: the text of the reason a second capture request is refused with. The one
  // exception to the rule above: it is a documented refusal reason, kept because the capture
  // control's runtime file must not change and every text it holds is such a reason. A bundle
  // beside the host's content file should not import that constant from the page-capture file
  // (doing so keeps a second copy of the text and fails the check). Move the mark to an internal
  // text when that runtime file next changes for another reason.
  mark("capture-control.ts:CAPTURE_PENDING_REASON", "src/capture-control.ts", "YSBjYXB0dXJlIGlzIGFscmVhZHkgcGVuZGluZw=="),
  // The compute frame: the text of the error a bad instance id throws, in the function that starts the frame.
  mark("compute-frame.ts:INSTANCE_REFUSAL", "src/compute-frame.ts", "c3RhcnRDb21wdXRlRnJhbWU6IG5vdCBhbiBpbnN0YW5jZSBpZA=="),
  // The settings core: the text of the error invalid bundled defaults throw, in the function that makes the core.
  mark("settings-core.ts:DEFAULTS_INVALID", "src/host/settings-core.ts", "Y3JlYXRlU2V0dGluZ3NDb3JlOiB0aGUgc2NoZW1hJ3MgZGVmYXVsdCBzZXR0aW5ncyBkbyBub3QgdmFsaWRhdGU="),
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
