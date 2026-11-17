// SPDX-License-Identifier: Apache-2.0
// The hover browser test's checks: each one with the clause of the toolkit's hover spec
// (docs/hover-spec.md) that it covers, "no clause" where none does. The table is shared by every
// product, so a product's report names the same checks in the same order.

/** Every check, in the order they run, with the hover-spec clause it covers. The last four need
 *  the second build (--dist-idle). */
export const CLAUSES = {
  "frames-at-play": "S-A1",
  "no-capture-before-pointer": "S-B7",
  "art-visible": "S-W1",
  "outline-shows": "S-F1",
  "move-off-clears": "S-W4",
  "covered-kept": "S-W5",
  "held-outline-hides": "S-F4",
  "switch-flips": "S-H2",
  "fake-pointer-ignored": "S-A2",
  "off-means-off": "S-B11",
  "on-while-playing-loads": "S-A7",
  "second-tab-names-card": "S-B13",
  "cached-reload": "no clause",
  "idle-unloads": "S-A4",
  "loop-no-reload": "S-A6",
  "idle-reload-on-hover": "S-A6",
  "switch-on-after-idle-reloads": "S-A7",
};
export const CHECKS = Object.keys(CLAUSES);
export const IDLE_CHECKS = CHECKS.slice(-4);
