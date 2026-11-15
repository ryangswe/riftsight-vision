// SPDX-License-Identifier: Apache-2.0
// The release record: the machine facts of one store release (versions, hashes, the vendored
// toolkit commit, the permission surface, the lint result) as JSON and Markdown, written by
// `store-upload.mjs check --record-out`, and the assets a release carries (`assets`). Nothing
// here holds a secret or a path outside the release: file names only, and the record is refused
// when its text names a credential or looks like a local path.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { credentialName, denyFindings, type PermissionSurface, sha256 } from "./store-checks.js";
import { StoreError } from "./store-chrome.js";

export const RECORD_SCHEMA = 1;
export const RECORD_JSON = "release-record.json";
export const RECORD_MARKDOWN = "release-record.md";
export const SUMS_FILE = "SHA256SUMS";

export interface PackageFact {
  file: string;
  bytes: number;
  sha256: string;
  /** The `version` in the package's manifest.json (not for the source archive). */
  manifestVersion?: string;
  /** How many files the package holds, and one digest over them: the SHA-256 of the lines
   *  `<sha256>  <name>` of every file, sorted by name. Absent when the package was not unpacked. */
  files?: number;
  contentsSha256?: string;
}

export interface CiResult {
  name: string;
  status: string;
  conclusion: string | null;
  /** The Actions run behind the check, from its details address; null for another kind of check. */
  runId: string | null;
}

export interface ReleaseRecord {
  schemaVersion: number;
  version: string;
  tag: string;
  commit: string | null;
  runId: string | null;
  toolkit: { version: string; commit: string } | null;
  ort: string | null;
  /** The model release the package bundles (the product's `modelRelease` fact). */
  modelRelease: string | null;
  /** The commit's check runs, other than this run's own, when a result file was given. */
  ci: CiResult[] | null;
  opencv: { tag: string; commit: string } | null;
  packages: {
    chrome?: PackageFact;
    firefox?: PackageFact;
    firefoxSource?: PackageFact;
    loadUnpacked?: PackageFact;
  };
  permissions: Partial<Record<"chrome" | "firefox", PermissionSurface>>;
  permissionsChanged: boolean;
  chrome: { submit: string; publish: string } | null;
  lint: { errors: number; warnings: number; inBaseline: number } | null;
  beforeUpload: { checked: number };
  facts: Record<string, string | number | boolean>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const HEX40 = /^[0-9a-f]{40}$/;

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new StoreError(`cannot read the ${what} ${basename(path)}: ${(error as Error).message}`);
  }
}

/** The toolkit facts of a product's `cardvision-vendor.json`. */
export function readVendorFacts(path: string): Pick<ReleaseRecord, "toolkit" | "ort" | "opencv"> {
  const m = readJson(path, "vendor manifest");
  if (!isObj(m) || m.schemaVersion !== 1 || !isObj(m.toolkit) || typeof m.toolkit.commit !== "string" || !HEX40.test(m.toolkit.commit)) {
    throw new StoreError(`${basename(path)} is not a version 1 vendor manifest with a toolkit commit`);
  }
  const version = typeof m.toolkit.version === "string" ? m.toolkit.version : "";
  const ort = isObj(m.ort) && typeof m.ort.version === "string" ? m.ort.version : null;
  const opencv = isObj(m.opencv) && typeof m.opencv.tag === "string" && typeof m.opencv.commit === "string" ? { tag: m.opencv.tag, commit: m.opencv.commit } : null;
  return { toolkit: { version, commit: m.toolkit.commit }, ort, opencv };
}

/** The product's own facts: `{"facts": {"name": "text" | number | true}}`, names that are plain words. */
export function readFactsFile(path: string): Record<string, string | number | boolean> {
  const o = readJson(path, "facts file");
  if (!isObj(o) || !isObj(o.facts) || Object.keys(o).some((k) => k !== "facts")) throw new StoreError(`${basename(path)} must be {"facts": {...}}`);
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(o.facts).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k)) throw new StoreError(`${basename(path)}: "${k}" is not a plain name (letters and digits)`);
    if (typeof v === "string" ? v.length === 0 || v.length > 200 : typeof v !== "number" && typeof v !== "boolean") {
      throw new StoreError(`${basename(path)}: "${k}" must be a short text, a number or true or false`);
    }
    out[k] = v as string | number | boolean;
  }
  return out;
}

/** Digest over a package's unpacked files: the sha256 of the sorted `<sha256>  <name>` lines. */
export function contentsDigest(files: Array<{ name: string; sha256: string }>): { files: number; contentsSha256: string } {
  const lines = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((f) => `${f.sha256}  ${f.name}\n`);
  return { files: files.length, contentsSha256: sha256(new TextEncoder().encode(lines.join(""))) };
}

/**
 * The check runs of the commit, from `gh api repos/<repository>/commits/SHA/check-runs --paginate
 * --jq '.check_runs[]'` (one object per line) or the whole answer (an object with `check_runs`, or
 * a list). The run being recorded (`ownRunId`) is left out: it has not finished.
 */
export function readCiResults(path: string, ownRunId?: string): CiResult[] {
  const text = readFileSync(path, "utf-8").trim();
  const items: unknown[] = [];
  const add = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(add);
    else if (isObj(v) && Array.isArray(v.check_runs)) v.check_runs.forEach(add);
    else items.push(v);
  };
  try {
    add(JSON.parse(text));
  } catch {
    for (const line of text.split("\n").filter((l) => l.trim() !== "")) {
      try {
        add(JSON.parse(line));
      } catch {
        throw new StoreError(`${basename(path)} is not check-run JSON`);
      }
    }
  }
  const out: CiResult[] = [];
  for (const o of items) {
    if (!isObj(o) || typeof o.name !== "string" || o.name.length === 0 || o.name.length > 200) throw new StoreError(`${basename(path)}: a check run has no name`);
    const url = typeof o.details_url === "string" ? o.details_url : "";
    const runId = url.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null;
    if (runId !== null && runId === ownRunId) continue;
    out.push({ name: o.name, status: typeof o.status === "string" ? o.status : "unknown", conclusion: typeof o.conclusion === "string" ? o.conclusion : null, runId });
  }
  return out.sort((a, b) => (a.name + (a.runId ?? "") < b.name + (b.runId ?? "") ? -1 : 1));
}

/** The row of a product's `cdn/RUNTIMES.json` for a version: `{ortWeb, bundledRelease: {id, ...}}`. */
export function readRuntimesRow(path: string, version: string): { ortWeb: string | null; releaseId: string } {
  const o = readJson(path, "runtime table");
  if (!isObj(o)) throw new StoreError(`${basename(path)} must be an object of versions`);
  const row = o[version];
  if (!isObj(row)) throw new StoreError(`${basename(path)} has no row for version ${version}`);
  const id = isObj(row.bundledRelease) && typeof row.bundledRelease.id === "string" ? row.bundledRelease.id : null;
  if (!id) throw new StoreError(`${basename(path)}: the row for ${version} names no bundledRelease id`);
  return { ortWeb: typeof row.ortWeb === "string" ? row.ortWeb : null, releaseId: id };
}

/** Keys of an object in sorted order, to the bottom, so the JSON is the same every run. */
function sortedDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedDeep);
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedDeep(v[k])]));
}

export function recordJson(record: ReleaseRecord): string {
  return `${JSON.stringify(sortedDeep(record), null, 2)}\n`;
}

const ROLE_NAMES: Array<[keyof ReleaseRecord["packages"], string]> = [
  ["chrome", "Chrome Web Store package"],
  ["firefox", "Firefox package"],
  ["firefoxSource", "Firefox source archive (not attached to the release)"],
  ["loadUnpacked", "Load-unpacked package"],
];

export function recordMarkdown(r: ReleaseRecord): string {
  const out: string[] = [`# Release record ${r.version}`, "", `Machine facts only. Tag \`${r.tag}\`${r.commit ? `, commit \`${r.commit}\`` : ""}${r.runId ? `, run ${r.runId}` : ""}.`, ""];
  out.push("## Packages", "", "| Package | File | Bytes | SHA-256 | Files | Contents SHA-256 |", "| --- | --- | ---: | --- | ---: | --- |");
  for (const [role, label] of ROLE_NAMES) {
    const p = r.packages[role];
    if (p) out.push(`| ${label} | \`${p.file}\` | ${p.bytes} | \`${p.sha256}\` | ${p.files ?? ""} | ${p.contentsSha256 ? `\`${p.contentsSha256}\`` : ""} |`);
  }
  out.push("", "## Build", "");
  out.push(r.toolkit ? `- Vendored toolkit: version ${r.toolkit.version || "(not named)"}, commit \`${r.toolkit.commit}\`` : "- Vendored toolkit: not recorded");
  if (r.ort) out.push(`- ONNX Runtime: ${r.ort}`);
  if (r.opencv) out.push(`- OpenCV: ${r.opencv.tag}, commit \`${r.opencv.commit}\``);
  if (r.modelRelease) out.push(`- Bundled model release: ${r.modelRelease}`);
  out.push(r.lint ? `- Firefox lint: ${r.lint.errors} errors, ${r.lint.warnings} warnings (${r.lint.inBaseline} in the baseline)` : "- Firefox lint: not run");
  out.push(`- Addresses checked before upload: ${r.beforeUpload.checked}`);
  if (r.chrome) out.push(`- Chrome: submit ${r.chrome.submit}, publish ${r.chrome.publish}`);
  for (const [k, v] of Object.entries(r.facts)) out.push(`- ${k}: ${String(v)}`);
  if (r.ci) {
    out.push("", "## Checks on the commit", "");
    if (r.ci.length === 0) out.push("No other check runs.");
    for (const c of r.ci) out.push(`- ${c.name}: ${c.conclusion ?? c.status}${c.runId ? ` (run ${c.runId})` : ""}`);
  }
  out.push("", "## Permissions", "", r.permissionsChanged ? "The permission surface changed since the previous release." : "No permission change is recorded for this release.", "");
  for (const target of ["chrome", "firefox"] as const) {
    const s = r.permissions[target];
    if (!s) continue;
    out.push(`### ${target}`, "");
    for (const key of Object.keys(s) as Array<keyof PermissionSurface>) out.push(`- ${key}: ${s[key].length === 0 ? "none" : s[key].map((x) => `\`${x}\``).join(", ")}`);
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** Where a text names a path on someone's machine: a home, temporary or runner folder, a drive
 *  letter (either slash), a network share or a path under the user's home shorthand. A `file:///*`
 *  match pattern (a permission) is not a path. */
const LOCAL_PATH = /(?:^|[\s"'`(=])(?:\/(?:Users|home|tmp|var|private|opt|etc|root|runner|mnt|Volumes|github|__w)\/|~[/]|[A-Za-z]:[\\/]|\\{2,}[^\s\\"]+\\|file:\/\/\/(?:Users|home|tmp|var|private|opt|etc|root|runner|mnt|Volumes|github|__w)\/)/m;

/** The store, publisher and release credential names: a record never holds one. */
const STORE_CREDENTIAL = /\b(?:AMO|CWS)_[A-Z0-9_]+\b|\bG(?:ITHUB|H)_TOKEN\b/;

/** Problems that keep a record from being written: a credential name or a local path in its
 *  text. `deny` is the product's list of denied words. */
export function recordProblems(texts: string[], deny: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    if (LOCAL_PATH.test(text)) out.push("the release record names a local path");
    const store = text.match(STORE_CREDENTIAL);
    if (store) out.push(`the release record names a credential (${store[0]})`);
    for (const f of denyFindings(text, deny)) out.push(`the release record names a denied name (${f.replace(/^line \d+: /, "")})`);
    for (const id of text.match(/[A-Za-z0-9_]+/g) ?? []) if (id.includes("_") && credentialName(id)) out.push(`the release record names a credential (${id})`);
  }
  return [...new Set(out)];
}

const WRITES = /\bcontents\s*:\s*["']?write["']?(?![\w-])|["']?write-all["']?/;

/**
 * Guard for the job that holds `contents: write`: it must never share a workflow's permissions
 * with a job that runs in an environment. Returns a message per finding; empty is a pass. Fails
 * closed: a workflow whose jobs it cannot read is a finding.
 *
 * Findings: a job with an environment and no `permissions:` of its own; a workflow-level write
 * permission while any job names an environment; a job with both a write permission and an
 * environment (block or `{ contents: write }` flow style, quoted or not, any indentation); a job
 * header with a trailing comment or one that is not a plain `name:` line; and a `jobs:` with no
 * job it recognizes.
 */
export function workflowGuardProblems(workflowText: string): string[] {
  const lines = workflowText.split(/\r?\n/);
  const live = (l: string): boolean => l.trim() !== "" && !l.trimStart().startsWith("#");
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  const jobsAt = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (jobsAt < 0) return ["the workflow has no `jobs:` block the check can read"];
  const problems: string[] = [];
  // Workflow-level permissions: the block at indentation 0 outside `jobs:`.
  const top: string[] = [];
  let inJobs = false;
  let topPerm = false;
  for (const l of lines) {
    if (/^jobs:/.test(l)) inJobs = true;
    else if (live(l) && indentOf(l) === 0) {
      inJobs = false;
      topPerm = /^permissions\s*:/.test(l);
      if (topPerm) top.push(l);
    } else if (!inJobs && topPerm) top.push(l);
  }
  const topWrites = top.some((l) => WRITES.test(l));

  const body = lines.slice(jobsAt + 1);
  const first = body.find(live);
  const jobIndent = first === undefined ? -1 : indentOf(first);
  const jobs: Array<{ name: string; lines: string[] }> = [];
  for (const l of body) {
    if (!live(l)) continue;
    const ind = indentOf(l);
    if (ind === 0) break;
    if (ind === jobIndent) {
      const m = l.match(/^\s*([A-Za-z0-9_-]+):\s*$/);
      const commented = l.match(/^\s*([A-Za-z0-9_-]+):\s*#/);
      if (commented) {
        problems.push(`the job ${commented[1]}: a comment on its header line hides what follows from this check; move the comment`);
        jobs.push({ name: commented[1]!, lines: [] });
      } else if (!m) {
        problems.push(`a line under jobs: is not a plain job header: ${l.trim().slice(0, 40)}`);
        jobs.push({ name: "(unreadable)", lines: [] });
      } else jobs.push({ name: m[1]!, lines: [] });
    } else jobs.at(-1)?.lines.push(l);
  }
  if (jobs.length === 0) problems.push("`jobs:` has no job the check recognizes");
  let anyEnvironment = false;
  for (const j of jobs) {
    const childIndent = j.lines.length > 0 ? Math.min(...j.lines.map(indentOf)) : 0;
    const keys = j.lines.filter((l) => indentOf(l) === childIndent);
    const hasEnv = keys.some((l) => /^\s*["']?environment["']?\s*:/.test(l));
    const permAt = j.lines.findIndex((l) => indentOf(l) === childIndent && /^\s*["']?permissions["']?\s*:/.test(l));
    if (hasEnv) anyEnvironment = true;
    let writes = false;
    if (permAt >= 0) {
      const block = [j.lines[permAt]!];
      for (const l of j.lines.slice(permAt + 1)) {
        if (indentOf(l) <= childIndent) break;
        block.push(l);
      }
      writes = block.some((l) => WRITES.test(l));
    }
    if (hasEnv && permAt < 0) problems.push(`the job ${j.name} names an environment and has no permissions of its own (it would inherit the workflow's)`);
    if (hasEnv && writes) problems.push(`the job ${j.name} can write to the repository and names an environment (a job with store access must not)`);
  }
  if (anyEnvironment && topWrites) problems.push("the workflow grants write permission at its top level while a job names an environment");
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The release's assets
// ---------------------------------------------------------------------------------------------

/**
 * Copy what a release carries into `outDir`: the load-unpacked, Chrome and Firefox packages the
 * record names (each checked against its recorded hash; the Firefox source archive is never
 * copied), the record in both forms and `SHA256SUMS` listing all of them. Returns the file names.
 */
export function releaseAssets(
  a: { recordJson: string; dir: string; outDir: string },
  readFile: (path: string) => Uint8Array = (p) => new Uint8Array(readFileSync(p)),
): string[] {
  const record = readJson(a.recordJson, "release record") as ReleaseRecord;
  if (!isObj(record) || record.schemaVersion !== RECORD_SCHEMA || !isObj(record.packages)) throw new StoreError(`${basename(a.recordJson)} is not a version ${RECORD_SCHEMA} release record`);
  mkdirSync(a.outDir, { recursive: true });
  const sums: string[] = [];
  const names: string[] = [];
  for (const role of ["loadUnpacked", "chrome", "firefox"] as const) {
    const p = record.packages[role];
    if (!p) continue;
    if (basename(p.file) !== p.file) throw new StoreError(`the record names ${role} as a path, not a file name`);
    if (sha256(readFile(join(a.dir, p.file))) !== p.sha256) throw new StoreError(`${p.file} is not the package the build job checked`);
    copyFileSync(join(a.dir, p.file), join(a.outDir, p.file));
    sums.push(`${p.sha256}  ${p.file}`);
    names.push(p.file);
  }
  if (names.length === 0) throw new StoreError("the record names no package to attach");
  for (const [name, text] of [
    [RECORD_JSON, readFileSync(a.recordJson, "utf-8")],
    [RECORD_MARKDOWN, readFileSync(a.recordJson.replace(/\.json$/, ".md"), "utf-8")],
  ] as const) {
    writeFileSync(join(a.outDir, name), text);
    sums.push(`${sha256(new TextEncoder().encode(text))}  ${name}`);
    names.push(name);
  }
  writeFileSync(join(a.outDir, SUMS_FILE), `${sums.join("\n")}\n`);
  return [...names, SUMS_FILE];
}
