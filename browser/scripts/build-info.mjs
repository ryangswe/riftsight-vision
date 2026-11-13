// SPDX-License-Identifier: Apache-2.0
// Which commit a build is of, and whether the tree had changes: written to dist/build-info.json by
// scripts/build.mjs, read by scripts/vendor.mjs. Not a git checkout: { commit: null, dirty: true }.

import { execFileSync } from "node:child_process";

/** { commit, dirty } for the git checkout that holds `root`. */
export function buildInfoOf(root) {
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
  } catch {
    return { commit: null, dirty: true };
  }
}
