// SPDX-License-Identifier: Apache-2.0
// Decides what a push to the main branch does about an extension release, from facts it is given.
//
//   node release-decide.mjs --package-json FILE --releases-dir DIR --changelog FILE --commit SHA
//        --tags-api FILE [--tag-objects FILE] --release-exists true|false --store-runs N --notes FILE
//        [--tag-prefix v] [--output FILE] [--summary FILE]
//
// The workflow (templates/extension-release.yml) gathers the facts, runs this, and then creates the
// tag and release and starts the store workflow only as the outputs say. The decision reads no
// network and no git: --tags-api holds the repository's tag references as the GitHub API lists
// them (`git/matching-refs/tags/<prefix>`, one JSON object per line), --tag-objects the API's answer
// for each annotated tag (`git/tags/<sha>`, one JSON object per line). The version, the release
// file and the changelog are read from the checkout.
//
// A release happens only when all three hold: the version in package.json has no tag, the folder
// --releases-dir holds `<version>.json`, and the changelog has a dated section for the version
// (`## [1.2.0] - 2026-11-13` or `## 1.2.0 (2026-11-14)`) with something in it. Otherwise nothing
// happens (exit 0). Two are refused (exit 1): a version with a pre-release suffix (store versions
// are numeric), and a version lower than the newest final version tag. When the tag is already on this commit (a re-run) only what is still missing
// is done. A tag on another commit means the version was not raised: nothing happens. Exit 2 for a
// bad command line.
//
// Outputs (to --output, a GitHub Actions output file): tag, create, dispatch.

import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const TAG_REF = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;

/** Orders two final versions (X.Y.Z): negative when a is lower. */
export function compareVersions(a: string, b: string): number {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const m = Number(x[i]);
    const n = Number(y[i]);
    if (m !== n) return m < n ? -1 : 1;
  }
  return 0;
}

/**
 * Tag references as the GitHub API lists them, in the shape of `git ls-remote --tags`. `refs` is one
 * JSON object per line from `git/matching-refs/tags/<prefix>` (`{ref, object: {type, sha}}`);
 * `objects` is one object per line from `git/tags/<sha>` for each annotated tag (`{sha, object: {type,
 * sha}}`). An annotated tag is followed to the commit it names; one that cannot be followed is left
 * out, so it is never taken for a tag on this commit.
 */
export function tagsFromApi(refs: string, objects = ""): string {
  const lines = (text: string): unknown[] =>
    text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as unknown);
  const tagObjects = new Map<string, { type: string; sha: string }>();
  for (const entry of lines(objects) as Array<{ sha?: string; object?: { type?: string; sha?: string } }>) {
    if (entry.sha && entry.object?.sha && entry.object.type) tagObjects.set(entry.sha, { type: entry.object.type, sha: entry.object.sha });
  }
  const out: string[] = [];
  for (const entry of lines(refs) as Array<{ ref?: string; object?: { type?: string; sha?: string } }>) {
    if (!entry.ref?.startsWith("refs/tags/") || !entry.object?.sha || !entry.object.type) continue;
    let { type, sha } = entry.object;
    for (let hops = 0; type === "tag" && hops < 5; hops++) {
      const next = tagObjects.get(sha);
      if (!next) break;
      ({ type, sha } = next);
    }
    if (type === "commit") out.push(`${sha}\t${entry.ref}`);
  }
  return out.join("\n");
}

/** From `git ls-remote --tags`: each tag's commit (a peeled entry wins), and the versions of the final-version tags with this prefix (a pre-release tag is left out). */
export function tagsOf(listing: string, prefix: string): { commits: Map<string, string>; versions: string[] } {
  const commits = new Map<string, string>();
  for (const line of listing.split("\n")) {
    const m = TAG_REF.exec(line.trim());
    if (m?.[1] && m[2] && (m[3] || !commits.has(m[2]))) commits.set(m[2], m[1]);
  }
  const versions = [...commits.keys()].filter((t) => t.startsWith(prefix) && VERSION.test(t.slice(prefix.length))).map((t) => t.slice(prefix.length));
  return { commits, versions };
}

/**
 * The body of the changelog's section for a version, or null when it is absent, undated or empty. The
 * heading carries the version and a YYYY-MM-DD date: `## [1.2.0] - 2026-11-13`, `## 1.2.0 (2026-11-14)`.
 * `## [1.2.0] - Unreleased` is no section.
 */
export function notesFor(changelog: string, version: string): string | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^##[ \\t]+\\[?v?${escaped}\\]?([ \\t].*)?$`, "gm");
  for (const found of changelog.matchAll(heading)) {
    if (!DATE.test(found[1] ?? "")) continue;
    const rest = changelog.slice(found.index + found[0].length);
    const next = /^## /m.exec(rest);
    const body = (next ? rest.slice(0, next.index) : rest).trim();
    if (body !== "") return `${body}\n`;
  }
  return null;
}

export interface Facts {
  version: string;
  tagPrefix: string;
  /** The pushed commit. */
  commit: string;
  /** The tag references, in the shape of `git ls-remote --tags` (see `tagsFromApi`). */
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
  dispatch: boolean;
  notes: string;
}

function plan(action: Plan["action"], reason: string, tag: string, rest: Partial<Plan> = {}): Plan {
  return { action, reason, tag, create: false, dispatch: false, notes: "", ...rest };
}

export function decide(f: Facts): Plan {
  const tag = `${f.tagPrefix}${f.version}`;
  if (/^\d+\.\d+\.\d+-./.test(f.version)) {
    return plan("refuse", `The version ${f.version} has a pre-release suffix; store versions are numeric (X.Y.Z), so nothing was created.`, tag);
  }
  if (!VERSION.test(f.version)) return plan("refuse", `The version ${JSON.stringify(f.version)} in package.json is not X.Y.Z.`, tag);
  const { commits, versions } = tagsOf(f.tags, f.tagPrefix);
  const at = commits.get(tag);
  if (at !== undefined && at !== f.commit) return plan("nothing", `${tag} is already tagged on an earlier commit; the version is not raised.`, tag);
  const notes = notesFor(f.changelog, f.version);
  const missing: string[] = [];
  if (!f.releaseFile) missing.push(`the release file for ${f.version} does not exist`);
  if (notes === null) missing.push(`the changelog has no dated, non-empty section for ${f.version}`);

  if (at === undefined) {
    if (missing.length > 0) return plan("nothing", `${tag} is not released: ${missing.join(" and ")}.`, tag);
    const newest = versions.reduce<string | null>((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
    if (newest !== null && compareVersions(f.version, newest) < 0) {
      return plan("refuse", `${f.version} is lower than the newest final version tag, ${f.tagPrefix}${newest}; nothing was created.`, tag);
    }
    return plan("release", `Releasing ${tag}.`, tag, { create: true, dispatch: true, notes: notes ?? "" });
  }

  // A re-run: the tag is on this commit. Do only what is still missing, and only what its own condition allows.
  const create = !f.releaseExists && notes !== null;
  const dispatch = f.storeRuns === 0 && f.releaseFile;
  if (!create && !dispatch) {
    const why = missing.length > 0 && (!f.releaseExists || f.storeRuns === 0) ? `; ${missing.join(" and ")}` : "";
    return plan("nothing", `${tag} is already released and its store run already started${why}.`, tag);
  }
  const parts = [create ? "creating the release" : "", dispatch ? "starting the store run" : ""].filter(Boolean);
  return plan("release", `Finishing ${tag}: ${parts.join(" and ")}.`, tag, { create, dispatch, notes: create ? (notes ?? "") : "" });
}

const USAGE = `usage:
  node release-decide.mjs --package-json FILE --releases-dir DIR --changelog FILE --commit SHA
       --tags-api FILE [--tag-objects FILE] --release-exists true|false --store-runs N --notes FILE
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
        "tags-api": { type: "string" },
        "tag-objects": { type: "string" },
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
    for (const name of ["package-json", "releases-dir", "changelog", "commit", "tags-api", "release-exists", "store-runs", "notes"] as const) {
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
    const releaseFile = VERSION.test(version) && existsSync(join(values["releases-dir"] as string, `${version}.json`));
    const result = decide({
      version,
      tagPrefix: values["tag-prefix"] as string,
      commit: values.commit as string,
      tags: tagsFromApi(
        readFileSync(values["tags-api"] as string, "utf-8"),
        values["tag-objects"] ? readFileSync(values["tag-objects"], "utf-8") : "",
      ),
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
      appendFileSync(values.output, `tag=${result.tag}\ncreate=${result.create}\ndispatch=${result.dispatch}\n`);
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
