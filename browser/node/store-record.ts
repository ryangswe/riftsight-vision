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
}

export interface ReleaseRecord {
  schemaVersion: number;
  version: string;
  tag: string;
  commit: string | null;
  runId: string | null;
  toolkit: { version: string; commit: string } | null;
  ort: string | null;
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
  out.push("## Packages", "", "| Package | File | Bytes | SHA-256 |", "| --- | --- | ---: | --- |");
  for (const [role, label] of ROLE_NAMES) {
    const p = r.packages[role];
    if (p) out.push(`| ${label} | \`${p.file}\` | ${p.bytes} | \`${p.sha256}\` |`);
  }
  out.push("", "## Build", "");
  out.push(r.toolkit ? `- Vendored toolkit: version ${r.toolkit.version || "(not named)"}, commit \`${r.toolkit.commit}\`` : "- Vendored toolkit: not recorded");
  if (r.ort) out.push(`- ONNX Runtime: ${r.ort}`);
  if (r.opencv) out.push(`- OpenCV: ${r.opencv.tag}, commit \`${r.opencv.commit}\``);
  out.push(r.lint ? `- Firefox lint: ${r.lint.errors} errors, ${r.lint.warnings} warnings (${r.lint.inBaseline} in the baseline)` : "- Firefox lint: not run");
  out.push(`- Addresses checked before upload: ${r.beforeUpload.checked}`);
  if (r.chrome) out.push(`- Chrome: submit ${r.chrome.submit}, publish ${r.chrome.publish}`);
  for (const [k, v] of Object.entries(r.facts)) out.push(`- ${k}: ${String(v)}`);
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

/** Where a text names a path on someone's machine: a home or temporary folder, a drive letter, a
 *  `file:` address or a path under the user's home shorthand. */
const LOCAL_PATH = /(?:^|[\s"'`(=])(?:\/(?:Users|home|tmp|var|private|opt|etc|root|runner|mnt|Volumes|__w)\/|~[/]|[A-Za-z]:\\|file:\/\/)/m;

/** Problems that keep a record from being written: a credential name or a local path in its
 *  text. `deny` is the product's list of denied words. */
export function recordProblems(texts: string[], deny: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    if (LOCAL_PATH.test(text)) out.push("the release record names a local path");
    for (const f of denyFindings(text, deny)) out.push(`the release record names a denied name (${f.replace(/^line \d+: /, "")})`);
    for (const id of text.match(/[A-Za-z0-9_]+/g) ?? []) if (id.includes("_") && credentialName(id)) out.push(`the release record names a credential (${id})`);
  }
  return [...new Set(out)];
}

/** Whether a workflow job that can write to the repository's releases also names
 *  an environment: such a job must never run in `store`. Returns each offending job's name. */
export function writeJobsInEnvironments(workflowText: string): string[] {
  const lines = workflowText.split(/\r?\n/);
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt < 0) return [];
  const blocks: Array<{ name: string; lines: string[] }> = [];
  for (const line of lines.slice(jobsAt + 1)) {
    if (/^\S/.test(line) && line.trim() !== "") break;
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) blocks.push({ name: m[1]!, lines: [] });
    else blocks.at(-1)?.lines.push(line);
  }
  return blocks
    .filter((b) => b.lines.some((l) => /^ {4,}contents:\s*write\b|^ {4,}permissions:\s*write-all\b/.test(l)) && b.lines.some((l) => /^ {4}environment:/.test(l)))
    .map((b) => b.name);
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
