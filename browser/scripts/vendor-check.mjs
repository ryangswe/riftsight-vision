// SPDX-License-Identifier: Apache-2.0
// Check a product's vendored runtime against its manifest:
//
//   npm run vendor-check -- FOLDER
//
// FOLDER is relative to the folder you ran npm in. Exit 0 when the folder is whole and consistent,
// 1 with one line per problem, 2 for bad usage. The last line says which checks ran. The comparison
// with a build runs only when this checkout's HEAD is the manifest's commit and dist/ was built from
// that commit with no changes; otherwise it is skipped, with the reason.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { MANIFEST, checkVendor, selectBuild } from "./vendor-lib.mjs";

const USAGE = "Usage: npm run vendor-check -- FOLDER";
let parsed;
try {
  parsed = parseArgs({ options: { help: { type: "boolean", short: "h", default: false } }, allowPositionals: true });
} catch (e) {
  console.error(`${e.message}\n\n${USAGE}`);
  process.exit(2);
}
if (parsed.values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.positionals.length !== 1) {
  console.error(USAGE);
  process.exit(2);
}
const dir = resolve(process.env.INIT_CWD || process.cwd(), parsed.positionals[0]);
const here = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(here, "..");

let manifestCommit = null;
let hasOpencv = false;
try {
  const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf-8"));
  manifestCommit = m.toolkit?.commit ?? null;
  hasOpencv = Boolean(m.opencv);
} catch {
  // checkVendor reports it.
}
let head = null;
try {
  head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  // Not a git checkout.
}
const build = manifestCommit ? selectBuild({ root, dist: join(here, "dist"), head, manifestCommit }) : { reason: "no manifest commit" };
const problems = checkVendor(dir, build.toolkit);
const ran = ["file hashes", "file set", "licenses", hasOpencv ? "OpenCV lock" : null, build.toolkit ? `build of commit ${manifestCommit?.slice(0, 12)}` : null].filter(Boolean).join(", ");
const skipped = build.toolkit ? "" : `Skipped: comparison with a build (${build.reason}).`;
if (problems.length > 0) {
  console.error(`${dir} does not match ${MANIFEST}:\n  ${problems.join("\n  ")}\nChecked: ${ran}. ${skipped}`.trimEnd());
  process.exit(1);
}
console.log(`${dir} matches ${MANIFEST}. Checked: ${ran}. ${skipped}`.trimEnd());
