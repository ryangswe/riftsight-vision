// SPDX-License-Identifier: Apache-2.0
// The checks a store release runs before anything goes up, and the two files a product keeps for
// it:
//
//   store/store.config.json   which store items the product has, and the names its workflow must
//                             never mention (its CDN credentials and pointer or flag tools)
//   store/releases/<v>.json   one per release: how Chrome submits, the notes files, and what must
//                             be true before upload
//
// plus store/permissions.json, the permission surface of this release, per browser. The packages
// must have exactly that surface; a surface that differs from the previous release's file fails
// unless the release file says the change is acknowledged (the store's justification fields are
// filled by hand first).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { StoreError } from "./store-chrome.js";

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export interface StoreConfig {
  chrome?: { publisherId: string; itemId: string };
  firefox?: { addon: string };
  /** Extra text the workflow and the upload job's environment must never contain (case
   *  insensitive): the product's CDN secret names and its pointer or flag commands. */
  deny?: string[];
}

export interface ReleaseFile {
  version: string;
  chrome?: {
    /** "auto": submit for review after the upload. "upload-only": the listing text changes, so
     *  the account holder pastes it in the dashboard and submits. */
    submit: "auto" | "upload-only";
    /** "default": live once approved. "staged": waits for a manual publish after approval. */
    publish: "default" | "staged";
  };
  firefox?: {
    /** Paths relative to the release file, each a locale's text. */
    releaseNotes?: Record<string, string>;
    approvalNotes?: string;
  };
  /** The permission surface changed and the store's justification fields were updated. */
  permissionsChanged?: boolean;
  /** Addresses that must answer 200 (and match a sha256 when given) before upload. */
  before?: Array<{ url: string; sha256?: string; why?: string }>;
}

function fail(message: string): never {
  throw new StoreError(message);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    fail(`cannot read ${path}: ${(error as Error).message}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${where}: unknown key "${k}"`);
}

export function readStoreConfig(path: string): StoreConfig {
  const o = readJson(path);
  if (!isObj(o)) fail(`${path}: must be an object`);
  onlyKeys(o, ["chrome", "firefox", "deny"], path);
  const out: StoreConfig = {};
  if (o.chrome !== undefined) {
    if (!isObj(o.chrome) || !isStr(o.chrome.publisherId) || !isStr(o.chrome.itemId)) fail(`${path}: chrome needs publisherId and itemId`);
    onlyKeys(o.chrome, ["publisherId", "itemId"], `${path} chrome`);
    out.chrome = { publisherId: o.chrome.publisherId, itemId: o.chrome.itemId };
  }
  if (o.firefox !== undefined) {
    if (!isObj(o.firefox) || !isStr(o.firefox.addon)) fail(`${path}: firefox needs addon (its id, slug or guid)`);
    onlyKeys(o.firefox, ["addon"], `${path} firefox`);
    out.firefox = { addon: o.firefox.addon };
  }
  if (o.deny !== undefined) {
    if (!Array.isArray(o.deny) || !o.deny.every(isStr)) fail(`${path}: deny must be a list of strings`);
    out.deny = o.deny as string[];
  }
  if (!out.chrome && !out.firefox) fail(`${path}: names no store item`);
  return out;
}

export function readReleaseFile(path: string): ReleaseFile {
  const o = readJson(path);
  if (!isObj(o)) fail(`${path}: must be an object`);
  onlyKeys(o, ["version", "chrome", "firefox", "permissionsChanged", "before"], path);
  if (!isStr(o.version)) fail(`${path}: version is required`);
  const out: ReleaseFile = { version: o.version };
  if (o.chrome !== undefined) {
    if (!isObj(o.chrome)) fail(`${path}: chrome must be an object`);
    onlyKeys(o.chrome, ["submit", "publish"], `${path} chrome`);
    if (o.chrome.submit !== "auto" && o.chrome.submit !== "upload-only") fail(`${path}: chrome.submit must be "auto" or "upload-only"`);
    if (o.chrome.publish !== "default" && o.chrome.publish !== "staged") fail(`${path}: chrome.publish must be "default" or "staged"`);
    out.chrome = { submit: o.chrome.submit, publish: o.chrome.publish };
  }
  if (o.firefox !== undefined) {
    if (!isObj(o.firefox)) fail(`${path}: firefox must be an object`);
    onlyKeys(o.firefox, ["releaseNotes", "approvalNotes"], `${path} firefox`);
    const f: NonNullable<ReleaseFile["firefox"]> = {};
    if (o.firefox.releaseNotes !== undefined) {
      if (!isObj(o.firefox.releaseNotes) || !Object.values(o.firefox.releaseNotes).every(isStr)) {
        fail(`${path}: firefox.releaseNotes maps locales to files`);
      }
      f.releaseNotes = o.firefox.releaseNotes as Record<string, string>;
    }
    if (o.firefox.approvalNotes !== undefined) {
      if (!isStr(o.firefox.approvalNotes)) fail(`${path}: firefox.approvalNotes is a file path`);
      f.approvalNotes = o.firefox.approvalNotes;
    }
    out.firefox = f;
  }
  if (o.permissionsChanged !== undefined) {
    if (typeof o.permissionsChanged !== "boolean") fail(`${path}: permissionsChanged must be true or false`);
    out.permissionsChanged = o.permissionsChanged;
  }
  if (o.before !== undefined) {
    if (!Array.isArray(o.before)) fail(`${path}: before must be a list`);
    out.before = o.before.map((b, i) => {
      if (!isObj(b) || !isStr(b.url) || !/^https:\/\//.test(b.url)) fail(`${path}: before[${i}] needs an https url`);
      onlyKeys(b, ["url", "sha256", "why"], `${path} before[${i}]`);
      if (b.sha256 !== undefined && !(isStr(b.sha256) && /^[0-9a-f]{64}$/.test(b.sha256))) fail(`${path}: before[${i}].sha256 must be 64 hex`);
      return { url: b.url, ...(b.sha256 ? { sha256: b.sha256 as string } : {}), ...(isStr(b.why) ? { why: b.why } : {}) };
    });
  }
  return out;
}

/** A notes file's text without a leading license comment (`<!-- SPDX-License-Identifier: … -->`),
 *  which a repository may require in every Markdown file but which is not part of the notes. */
export function notesText(raw: string): string {
  return raw.replace(/^\s*<!--\s*SPDX-License-Identifier:[^>]*-->\s*/, "").trim();
}

/** The notes a release file names, read from files beside it. */
export function readNotes(releasePath: string, release: ReleaseFile): { releaseNotes?: Record<string, string>; approvalNotes?: string } {
  const dir = dirname(resolve(releasePath));
  const read = (p: string): string => {
    const text = notesText(readFileSync(join(dir, p), "utf-8"));
    if (!text) fail(`${p} is empty`);
    return text;
  };
  const out: { releaseNotes?: Record<string, string>; approvalNotes?: string } = {};
  if (release.firefox?.releaseNotes) {
    out.releaseNotes = Object.fromEntries(Object.entries(release.firefox.releaseNotes).map(([locale, p]) => [locale, read(p)]));
  }
  if (release.firefox?.approvalNotes) out.approvalNotes = read(release.firefox.approvalNotes);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The permission surface
// ---------------------------------------------------------------------------------------------

export interface PermissionSurface {
  permissions: string[];
  optional_permissions: string[];
  host_permissions: string[];
  optional_host_permissions: string[];
  content_script_matches: string[];
  web_accessible_matches: string[];
  externally_connectable: string[];
  data_collection: string[];
}

const sorted = (values: Iterable<unknown>): string[] => [...new Set([...values].filter((v): v is string => typeof v === "string"))].sort();

/** What a store asks justification for, from a manifest. */
export function permissionSurface(manifest: Record<string, unknown>): PermissionSurface {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const cs = arr(manifest.content_scripts).flatMap((c) => (isObj(c) ? arr(c.matches) : []));
  const war = arr(manifest.web_accessible_resources).flatMap((w) => (isObj(w) ? arr(w.matches) : []));
  const ec = isObj(manifest.externally_connectable) ? arr(manifest.externally_connectable.matches) : [];
  const gecko = isObj(manifest.browser_specific_settings) && isObj(manifest.browser_specific_settings.gecko) ? manifest.browser_specific_settings.gecko : {};
  const dc = isObj(gecko.data_collection_permissions)
    ? Object.entries(gecko.data_collection_permissions).flatMap(([k, v]) => arr(v).map((x) => `${k}:${String(x)}`))
    : [];
  return {
    permissions: sorted(arr(manifest.permissions)),
    optional_permissions: sorted(arr(manifest.optional_permissions)),
    host_permissions: sorted(arr(manifest.host_permissions)),
    optional_host_permissions: sorted(arr(manifest.optional_host_permissions)),
    content_script_matches: sorted(cs),
    web_accessible_matches: sorted(war),
    externally_connectable: sorted(ec),
    data_collection: sorted(dc),
  };
}

/** Lines naming each entry added or removed between two surfaces (empty: unchanged). */
export function surfaceChanges(before: PermissionSurface, after: PermissionSurface): string[] {
  const out: string[] = [];
  for (const key of Object.keys(after) as Array<keyof PermissionSurface>) {
    const was = new Set(before[key] ?? []);
    const now = new Set(after[key]);
    for (const v of now) if (!was.has(v)) out.push(`${key}: + ${v}`);
    for (const v of was) if (!now.has(v)) out.push(`${key}: - ${v}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// No CDN access
// ---------------------------------------------------------------------------------------------

/** Phrases a store job must never mention: the remote flag and the toolkit's CDN tool. */
export const DENY_PATTERNS: RegExp[] = [
  /\bfeatureFlags\b/,
  /\bcardvision\s+cdn\b/i,
  /\bwrangler\b/i,
  /toJSON\(\s*secrets\s*\)/,
  /\bsecrets:\s*inherit\b/,
];

/** Whether an identifier names an object-store or CDN credential: one of its underscore-separated
 *  parts names an object store (Cloudflare's, Amazon's S3) or Cloudflare, it combines CDN or AWS
 *  with KEY, SECRET, TOKEN or ACCESS, or it is a CF_ name with KEY, TOKEN, ACCOUNT or SECRET. */
export function credentialName(identifier: string): boolean {
  const parts = identifier.toUpperCase().split("_").filter(Boolean);
  if (parts.some((p) => p === "R2" || p === "S3" || p === "CLOUDFLARE")) return true;
  const secretish = parts.some((p) => ["KEY", "SECRET", "TOKEN", "ACCESS", "SESSION"].includes(p));
  if (secretish && parts.some((p) => p === "CDN" || p === "AWS")) return true;
  return parts[0] === "CF" && parts.some((p) => ["KEY", "TOKEN", "ACCOUNT", "SECRET"].includes(p));
}

/** The places a text mentions a denied name, as "line N: match". */
export function denyFindings(text: string, extra: string[] = []): string[] {
  const out: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const id of line.match(/[A-Za-z0-9_]+/g) ?? []) if (id.includes("_") && credentialName(id)) out.push(`line ${i + 1}: ${id}`);
    for (const re of DENY_PATTERNS) {
      const m = line.match(re);
      if (m) out.push(`line ${i + 1}: ${m[0]}`);
    }
    for (const word of extra) {
      if (word && line.toLowerCase().includes(word.toLowerCase())) out.push(`line ${i + 1}: ${word}`);
    }
  });
  return out;
}

/** Environment variable names a store job must not have. */
export function deniedEnvNames(env: Record<string, string | undefined>, extra: string[] = []): string[] {
  return Object.keys(env).filter((name) => denyFindings(name, extra).length > 0).sort();
}

// ---------------------------------------------------------------------------------------------
// Before upload
// ---------------------------------------------------------------------------------------------

/** Each `before` address that does not answer 200, or whose bytes do not match. */
export async function beforeProblems(release: ReleaseFile, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const out: string[] = [];
  for (const b of release.before ?? []) {
    try {
      const res = await fetchFn(b.url, { method: "GET", cache: "no-store" });
      if (res.status !== 200) {
        out.push(`${b.url}: HTTP ${res.status}${b.why ? ` (${b.why})` : ""}`);
        continue;
      }
      if (b.sha256) {
        const got = createHash("sha256").update(new Uint8Array(await res.arrayBuffer())).digest("hex");
        if (got !== b.sha256) out.push(`${b.url}: sha256 ${got.slice(0, 16)}… is not ${b.sha256.slice(0, 16)}…`);
      }
    } catch (error) {
      out.push(`${b.url}: ${(error as Error).message}`);
    }
  }
  return out;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
