// SPDX-License-Identifier: Apache-2.0
// The zip an extension's package step writes, and its layout. Three kinds:
//   - a release-page zip (the manifest carries a key): <packageName>-<version>.zip holding one
//     folder of the same name, which is what a user selects in a browser's "Load unpacked";
//   - a Chrome Web Store zip (no key): <packageName>-<version>-store.zip with manifest.json and
//     every other file at the top level, as the store requires;
//   - a Firefox zip (a manifest with a gecko ID): <packageName>-<version>-firefox.zip, also with
//     everything at the top level, for addons.mozilla.org.
//
//   node package-zip.mjs --dist DIR --package-name NAME --out DIR
//
// reads DIR/manifest.json, writes the zip into the --out folder (an older zip of the same name is
// replaced) and prints its path. It needs the `zip` program on the PATH.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The parts of an extension manifest that decide the zip's name and layout. */
export interface ZipManifest {
  version: string;
  key?: unknown;
  browser_specific_settings?: { gecko?: unknown };
}

/** The zip's file name and the folder its files sit in (null: at the top level). */
export interface ZipLayout {
  file: string;
  folder: string | null;
  store: boolean;
  firefox?: true;
}

export function zipLayout(packageName: string, manifest: ZipManifest): ZipLayout {
  const base = `${packageName}-${manifest.version}`;
  if (manifest.browser_specific_settings?.gecko) return { file: `${base}-firefox.zip`, folder: null, store: true, firefox: true };
  const store = !manifest.key;
  return store ? { file: `${base}-store.zip`, folder: null, store } : { file: `${base}.zip`, folder: base, store };
}

/** Zip the folder `dist` into `zipPath` with the layout's folder (or none). Replaces an older zip. */
export function writeZip(dist: string, zipPath: string, folder: string | null): void {
  const work = mkdtempSync(join(tmpdir(), "package-"));
  try {
    const top = join(work, folder ?? "package");
    cpSync(dist, top, { recursive: true });
    rmSync(zipPath, { force: true });
    if (folder) execFileSync("zip", ["-r", "-X", "-q", zipPath, folder], { cwd: work, stdio: "inherit" });
    else execFileSync("zip", ["-r", "-X", "-q", zipPath, "."], { cwd: top, stdio: "inherit" });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const USAGE = "usage: node package-zip.mjs --dist DIR --package-name NAME --out DIR";

function main(argv: string[]): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { dist: { type: "string" }, "package-name": { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h", default: false } },
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(`${USAGE}\n\nWrites <NAME>-<version>[-store|-firefox].zip from DIR (which holds manifest.json) into --out and prints its path.`);
    return 0;
  }
  if (!values.dist || !values["package-name"] || !values.out) {
    console.error(USAGE);
    return 2;
  }
  const dist = resolve(values.dist);
  let manifest: ZipManifest;
  try {
    manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf-8")) as ZipManifest;
  } catch (error) {
    console.error(`cannot read ${join(dist, "manifest.json")}: ${(error as Error).message}`);
    return 2;
  }
  if (typeof manifest?.version !== "string") {
    console.error(`${join(dist, "manifest.json")} has no version`);
    return 2;
  }
  const layout = zipLayout(values["package-name"], manifest);
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const zipPath = join(out, layout.file);
  writeZip(dist, zipPath, layout.folder);
  console.log(zipPath);
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
