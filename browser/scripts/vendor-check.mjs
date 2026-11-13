// SPDX-License-Identifier: Apache-2.0
// Check a product's vendored runtime against its manifest:
//
//   npm run vendor-check -- FOLDER [--no-build-compare]
//
// Exit 0 when the folder is whole and consistent, 1 with one line per problem, 2 for bad usage.
// When this checkout's HEAD is the manifest's commit and dist/ was built from it (dist/build-info.json),
// every file is also compared with that build. Otherwise the comparison is skipped, and said so.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { MANIFEST, checkVendor } from "./vendor-lib.mjs";

const USAGE = "Usage: npm run vendor-check -- FOLDER [--no-build-compare]";
let parsed;
try {
  parsed = parseArgs({ options: { "no-build-compare": { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } }, allowPositionals: true });
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
const dir = resolve(parsed.positionals[0]);
const here = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(here, "..");

let toolkit;
let note = "";
if (!parsed.values["no-build-compare"]) {
  try {
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const infoPath = join(here, "dist", "build-info.json");
    const info = existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, "utf-8")) : null;
    if (info && info.commit === head && !info.dirty) toolkit = { root, dist: join(here, "dist"), commit: head };
  } catch {
    // No git: nothing to compare with.
  }
  note = toolkit ? "" : "note: no clean local build of this checkout at hand, so files were not compared with a build";
}
const problems = checkVendor(dir, toolkit);
if (problems.length > 0) {
  console.error(`${dir} does not match ${MANIFEST}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`${dir} matches ${MANIFEST}${toolkit ? " and the local build of its commit" : ""}`);
if (note) console.log(note);
