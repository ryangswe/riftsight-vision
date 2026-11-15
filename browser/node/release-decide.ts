// SPDX-License-Identifier: Apache-2.0
// Decides what a push to the main branch does about an extension release, from facts it is given.
//
//   node release-decide.mjs --package-json FILE --releases-dir DIR --changelog FILE --commit SHA
//        --tags-file FILE --release-exists true|false --store-runs N --notes FILE
//        [--tag-prefix v] [--output FILE] [--summary FILE]
//
// The workflow (templates/extension-release.yml) gathers the facts, runs this, and then creates the
// tag and release and starts the store workflow only as the outputs say. The decision reads no
// network and no git: --tags-file holds the output of `git ls-remote --tags origin`, and the
// version, the release file and the changelog are read from the checkout.
//
// A release happens only when all three hold: the version in package.json has no tag, the folder
// --releases-dir holds `<version>.json`, and the changelog has a non-empty section for the version.
// Otherwise nothing happens (exit 0), except that a version lower than the newest version tag is
// refused (exit 1). When the tag is already on this commit (a re-run) only what is still missing
// is done. A tag on another commit means the version was not raised: nothing happens. Exit 2 for a
// bad command line.
//
// Outputs (to --output, a GitHub Actions output file): tag, create, prerelease, dispatch.

import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const TAG_REF = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/;

/** Orders two semantic versions: negative when a is lower. A pre-release is lower than its release. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const m = Number(x[i]);
    const n = Number(y[i]);
    if (m !== n) return m < n ? -1 : 1;
  }
  if (x[4] === undefined || y[4] === undefined) return x[4] === y[4] ? 0 : x[4] === undefined ? 1 : -1;
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    const m = p[i];
    const n = q[i];
    if (m === undefined) return -1;
    if (n === undefined) return 1;
    const mNumeric = /^\d+$/.test(m);
    const nNumeric = /^\d+$/.test(n);
    if (mNumeric && nNumeric && Number(m) !== Number(n)) return Number(m) < Number(n) ? -1 : 1;
    if (mNumeric !== nNumeric) return mNumeric ? -1 : 1;
    if (!mNumeric && m !== n) return m < n ? -1 : 1;
  }
  return 0;
}

/** From `git ls-remote --tags`: each tag's commit (a peeled entry wins), and the versions of the tags with this prefix. */
export function tagsOf(listing: string, prefix: string): { commits: Map<string, string>; versions: string[] } {
  const commits = new Map<string, string>();
  for (const line of listing.split("\n")) {
    const m = TAG_REF.exec(line.trim());
    if (m?.[1] && m[2] && (m[3] || !commits.has(m[2]))) commits.set(m[2], m[1]);
  }
  const versions = [...commits.keys()].filter((t) => t.startsWith(prefix) && SEMVER.test(t.slice(prefix.length))).map((t) => t.slice(prefix.length));
  return { commits, versions };
}

/** The body of the changelog's section for a version (`## [1.2.0] - date`, `## 1.2.0`, `## v1.2.0`), or null when absent or empty. */
export function notesFor(changelog: string, version: string): string | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^##[ \\t]+\\[?v?${escaped}\\]?(?:[ \\t].*)?$`, "m");
  const found = heading.exec(changelog);
  if (!found) return null;
  const rest = changelog.slice(found.index + found[0].length);
  const next = /^## /m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  return body === "" ? null : `${body}\n`;
}

export interface Facts {
  version: string;
  tagPrefix: string;
  /** The pushed commit. */
  commit: string;
  /** The output of `git ls-remote --tags origin`. */
  tags: string;
  /** Whether `<releases-dir>/<version>.json` exists. */
  releaseFile: boolean;
  changelog: string;
  /** Whether the GitHub release for the tag exists. */
  releaseExists: boolean;
  /** Store release runs already started on the tag. */
  storeRuns: number;
}

export interface Plan {
  action: "nothing" | "release" | "refuse";
  reason: string;
  tag: string;
  create: boolean;
  prerelease: boolean;
  dispatch: boolean;
  notes: string;
}

function plan(action: Plan["action"], reason: string, tag: string, rest: Partial<Plan> = {}): Plan {
  return { action, reason, tag, create: false, prerelease: false, dispatch: false, notes: "", ...rest };
}

export function decide(f: Facts): Plan {
  const tag = `${f.tagPrefix}${f.version}`;
  if (!SEMVER.test(f.version)) return plan("refuse", `The version ${JSON.stringify(f.version)} in package.json is not X.Y.Z or X.Y.Z-name.`, tag);
  const { commits, versions } = tagsOf(f.tags, f.tagPrefix);
  const at = commits.get(tag);
  if (at !== undefined && at !== f.commit) return plan("nothing", `${tag} is already tagged on an earlier commit; the version is not raised.`, tag);
  const notes = notesFor(f.changelog, f.version);
  const prerelease = f.version.includes("-");
  const missing: string[] = [];
  if (!f.releaseFile) missing.push(`the release file for ${f.version} does not exist`);
  if (notes === null) missing.push(`the changelog has no non-empty section for ${f.version}`);

  if (at === undefined) {
    if (missing.length > 0) return plan("nothing", `${tag} is not released: ${missing.join(" and ")}.`, tag);
    const newest = versions.reduce<string | null>((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
    if (newest !== null && compareVersions(f.version, newest) < 0) {
      return plan("refuse", `${f.version} is lower than the newest version tag, ${f.tagPrefix}${newest}; nothing was created.`, tag);
    }
    return plan("release", `Releasing ${tag}.`, tag, { create: true, prerelease, dispatch: true, notes: notes ?? "" });
  }

  // A re-run: the tag is on this commit. Do only what is still missing, and only what its own condition allows.
  const create = !f.releaseExists && notes !== null;
  const dispatch = f.storeRuns === 0 && f.releaseFile;
  if (!create && !dispatch) {
    const why = missing.length > 0 && (!f.releaseExists || f.storeRuns === 0) ? `; ${missing.join(" and ")}` : "";
    return plan("nothing", `${tag} is already released and its store run already started${why}.`, tag);
  }
  const parts = [create ? "creating the release" : "", dispatch ? "starting the store run" : ""].filter(Boolean);
  return plan("release", `Finishing ${tag}: ${parts.join(" and ")}.`, tag, { create, prerelease, dispatch, notes: create ? (notes ?? "") : "" });
}

const USAGE = `usage:
  node release-decide.mjs --package-json FILE --releases-dir DIR --changelog FILE --commit SHA
       --tags-file FILE --release-exists true|false --store-runs N --notes FILE
       [--tag-prefix v] [--output FILE] [--summary FILE]`;

class Usage extends Error {}

export function main(argv: string[], log: (line: string) => void = console.log): number {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        "package-json": { type: "string" },
        "releases-dir": { type: "string" },
        changelog: { type: "string" },
        commit: { type: "string" },
        "tags-file": { type: "string" },
        "release-exists": { type: "string" },
        "store-runs": { type: "string" },
        notes: { type: "string" },
        "tag-prefix": { type: "string", default: "v" },
        output: { type: "string" },
        summary: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help) {
      log(USAGE);
      return 0;
    }
    for (const name of ["package-json", "releases-dir", "changelog", "commit", "tags-file", "release-exists", "store-runs", "notes"] as const) {
      if (values[name] === undefined) throw new Usage(`--${name} is required`);
    }
    if (values["release-exists"] !== "true" && values["release-exists"] !== "false") throw new Usage("--release-exists is true or false");
    if (!/^\d+$/.test(values["store-runs"] as string)) throw new Usage("--store-runs is a count");
    if (!/^[0-9a-f]{40}$/.test(values.commit as string)) throw new Usage("--commit is a full commit hash");

    let version: unknown;
    try {
      version = (JSON.parse(readFileSync(values["package-json"] as string, "utf-8")) as { version?: unknown }).version;
    } catch (error) {
      throw new Error(`cannot read the version from ${values["package-json"]}: ${(error as Error).message}`);
    }
    if (typeof version !== "string") throw new Error(`${values["package-json"]} has no version`);
    // The version names a file: only a valid one is looked up.
    const releaseFile = SEMVER.test(version) && existsSync(join(values["releases-dir"] as string, `${version}.json`));
    const result = decide({
      version,
      tagPrefix: values["tag-prefix"] as string,
      commit: values.commit as string,
      tags: readFileSync(values["tags-file"] as string, "utf-8"),
      releaseFile,
      changelog: readFileSync(values.changelog as string, "utf-8"),
      releaseExists: values["release-exists"] === "true",
      storeRuns: Number(values["store-runs"]),
    });
    if (values.summary) appendFileSync(values.summary, `${result.action}: ${result.reason}\n`);
    log(result.reason);
    if (result.action === "refuse") return 1;
    if (result.create) writeFileSync(values.notes as string, result.notes);
    if (values.output) {
      appendFileSync(values.output, `tag=${result.tag}\ncreate=${result.create}\nprerelease=${result.prerelease}\ndispatch=${result.dispatch}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof Usage || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      log(`${(error as Error).message}\n${USAGE}`);
      return 2;
    }
    log(`refused: ${(error as Error).message}`);
    return 1;
  }
}

/** True when this module is the script Node was started on (not imported by a test). */
function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) process.exit(main(process.argv.slice(2)));
