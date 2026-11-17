// SPDX-License-Identifier: Apache-2.0
// One runtime per realm: counts the realm marks (scripts/realm-marks.mjs) in a product's built
// files and fails when a mark occurs more than once in a single file, which means a module's code
// is in that file twice (a content script that bundles the capture control beside the shared
// host's content file, for example).
//
//   node realm-check.mjs FILE_OR_DIR...
//
// It counts per file: two runtimes loaded as two separate files in one realm pass.
//
// A folder is searched for .js and .mjs files, without entering node_modules. Exit code 0: no
// file holds a mark twice; 1: at least one does (each is named with its mark and count); 2: bad
// arguments, an unreadable path or file, or no .js or .mjs file to check (a check that read nothing
// proves nothing).

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error: a plain .mjs script without declarations
import { countMarks, REALM_MARKS } from "../scripts/realm-marks.mjs";

/** One mark found more than once in one file. */
export interface RealmFinding {
  file: string;
  id: string;
  count: number;
}

/** Marks that occur more than once in `source`, as findings for `file`. */
export function realmFindings(file: string, source: string): RealmFinding[] {
  return (countMarks(source) as { id: string; count: number }[]).filter((found) => found.count > 1).map((found) => ({ file, id: found.id, count: found.count }));
}

/** The .js and .mjs files under `path` (the file itself when it is one). */
export function scriptFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) files.push(...scriptFiles(full));
    else if (/\.m?js$/.test(entry.name)) files.push(full);
  }
  return files.sort();
}

const USAGE = "usage: node realm-check.mjs FILE_OR_DIR...";

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`${USAGE}\n\nFails when a built file holds a realm mark more than once (one runtime per realm).`);
    return 0;
  }
  if (argv.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const findings: RealmFinding[] = [];
  const holders = new Map<string, number>();
  let checked = 0;
  for (const arg of argv) {
    let files: string[];
    try {
      files = scriptFiles(resolve(arg));
    } catch (error) {
      console.error(`cannot read ${arg}: ${(error as Error).message}`);
      return 2;
    }
    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(file, "utf-8");
      } catch (error) {
        console.error(`cannot read ${file}: ${(error as Error).message}`);
        return 2;
      }
      checked += 1;
      for (const found of countMarks(source) as { id: string; count: number }[]) holders.set(found.id, (holders.get(found.id) ?? 0) + 1);
      findings.push(...realmFindings(file, source));
    }
  }
  for (const finding of findings) {
    console.error(`${finding.file}: the realm mark ${finding.id} occurs ${finding.count} times; one runtime per realm allows once, so this file may hold that module's code twice`);
  }
  if (checked === 0) {
    console.error("no .js or .mjs file to check: nothing was read");
    return 2;
  }
  const held = (REALM_MARKS as { id: string }[]).map((mark) => `${mark.id} in ${holders.get(mark.id) ?? 0}`).join(", ");
  if (findings.length > 0) return 1;
  console.log(`realm check: ${checked} file${checked === 1 ? "" : "s"}, no realm mark twice in one file (files holding each mark: ${held})`);
  return 0;
}

/** True when this module is the script Node was started on (not imported by a test or `node -`). */
function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) process.exit(main(process.argv.slice(2)));
