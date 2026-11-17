// SPDX-License-Identifier: Apache-2.0
// Compare the five runtime files of two builds, byte for byte:
//
//   node scripts/runtime-hashes.mjs BASE_DIST HEAD_DIST
//
// The files are cardvision.js, worker.js, compute-session.js, page-capture.js and
// remote-release.js, with their license texts. Build the two commits to compare (a change and its
// merge base, say) in two folders and run this, so a change that moves the runtime shows up in review.
// Exit 0: identical. Exit 1: a file differs or is missing from one side. Exit 2: usage.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_FILES, sha256 } from "./vendor-lib.mjs";

/** What differs between two build folders, as messages; an empty list when the files are identical. */
export function runtimeDifferences(baseDist, headDist) {
  const problems = [];
  for (const name of RUNTIME_FILES) {
    const [base, head] = [join(baseDist, name), join(headDist, name)].map((p) => (existsSync(p) ? sha256(readFileSync(p)) : null));
    if (base === null && head === null && name.endsWith(".LEGAL.txt")) continue; // present only when the bundle had license comments
    if (base !== head) problems.push(`${name}: base ${base?.slice(0, 12) ?? "(missing)"}, head ${head?.slice(0, 12) ?? "(missing)"}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error("Usage: node scripts/runtime-hashes.mjs BASE_DIST HEAD_DIST");
    process.exit(2);
  }
  const problems = runtimeDifferences(process.argv[2], process.argv[3]);
  if (problems.length > 0) {
    console.error(`The runtime files differ from the merge base's:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("The five runtime files and their license texts are byte-identical to the merge base's.");
}
