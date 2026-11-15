// SPDX-License-Identifier: Apache-2.0
// The daily status check: no credentials, no writes. It compares the newest release file's version
// with the version each store shows the public (the extension update service for Chrome, the public
// add-on API for Firefox) and checks the release file's `expect` entries (addresses that must
// answer 200 with the bytes of a repository file or a sha256, such as a live settings file).
//
//   same version             passes
//   store older              passes with a note: in review, or not submitted yet (no credential
//                            can tell the two apart)
//   store newer, or a version that went back since the last run, or an address that differs,
//   or a store that cannot be read   fails
//
// "Went back" needs the previous run's high-water mark (--state-in, --state-out).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { AMO_API } from "./store-amo.js";
import { type ReleaseFile, readReleaseFile, sha256, type StoreConfig } from "./store-checks.js";
import { StoreError } from "./store-chrome.js";

export const CHROME_UPDATE_API = "https://clients2.google.com/service/update2/crx";
type Target = "chrome" | "firefox";

export interface StatusDeps {
  fetchFn: typeof fetch;
  readFile: (path: string) => Uint8Array;
  sleep?: (ms: number) => Promise<void>;
  /** Origins of the two public reads (tests). */
  chromeUpdateBase?: string;
  amoBase?: string;
}

const NUMERIC = /^\d+(?:\.\d+){0,3}$/;

/** Negative, zero or positive; null when either is not a dotted number (a pre-release name). */
export function compareVersions(a: string, b: string): number | null {
  if (!NUMERIC.test(a) || !NUMERIC.test(b)) return null;
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest release file of a folder, and how many there are. A file is named for its version. */
export function newestRelease(dir: string): { path: string; release: ReleaseFile; count: number } {
  const found = readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => ({ path: join(dir, n), release: readReleaseFile(join(dir, n)) }));
  if (found.length === 0) throw new StoreError(`${basename(dir)} holds no release file`);
  for (const f of found) {
    if (basename(f.path) !== `${f.release.version}.json`) throw new StoreError(`${basename(f.path)} names version ${f.release.version}: a release file is named for its version`);
  }
  let best = found[0]!;
  for (const f of found.slice(1)) {
    const c = compareVersions(f.release.version, best.release.version);
    if (c === null) throw new StoreError(`cannot order the release versions ${f.release.version} and ${best.release.version}`);
    if (c > 0) best = f;
  }
  return { ...best, count: found.length };
}

/** Waits before the second and third try: a store that rate-limits or restarts needs minutes. */
export const BACKOFF_MS = [30_000, 120_000];
const TIMEOUT_MS = 20_000;

async function get(fetchFn: typeof fetch, url: string, sleep?: (ms: number) => Promise<void>): Promise<Response> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await (sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(BACKOFF_MS[attempt - 1]!);
    try {
      const res = await fetchFn(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status < 500 && res.status !== 429) return res;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = (error as Error).message;
    }
  }
  throw new StoreError(`${last} after 3 tries`);
}

const attr = (tag: string, name: string): string | null => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;

/** The public version of a Chrome Web Store item, or null when the store does not list it. */
export async function chromePublicVersion(itemId: string, deps: StatusDeps): Promise<string | null> {
  const url = `${deps.chromeUpdateBase ?? CHROME_UPDATE_API}?response=updatecheck&prodversion=999.0&acceptformat=crx3&x=${encodeURIComponent(`id=${itemId}&uc`)}`;
  const res = await get(deps.fetchFn, url, deps.sleep);
  if (res.status !== 200) throw new StoreError(`Chrome Web Store update service: HTTP ${res.status}`);
  const xml = await res.text();
  const app = xml.match(/<app\s[^>]*>/)?.[0];
  if (!app) throw new StoreError("Chrome Web Store update service: an answer with no app element");
  if (attr(app, "appid") !== itemId) throw new StoreError("Chrome Web Store update service: answered for another item");
  const status = attr(app, "status");
  if (status === "error-unknownApplication") return null;
  if (status !== "ok") throw new StoreError(`Chrome Web Store update service: item status ${status ?? "missing"}`);
  const check = xml.match(/<updatecheck\s[^>]*>/)?.[0];
  const version = check ? attr(check, "version") : null;
  if (!check || attr(check, "status") !== "ok" || !version) throw new StoreError("Chrome Web Store update service: no version for the item");
  return version;
}

/** The newest public listed version of an add-on, or null when it has none (or is unknown). */
export async function amoPublicVersion(addon: string, deps: StatusDeps): Promise<string | null> {
  const res = await get(deps.fetchFn, `${deps.amoBase ?? AMO_API}/api/v5/addons/addon/${encodeURIComponent(addon)}/`, deps.sleep);
  // A listing with no public version answers 404, or 401 or 403 for a draft the API hides.
  if (res.status === 404 || res.status === 401 || res.status === 403) return null;
  if (res.status !== 200) throw new StoreError(`addons.mozilla.org: HTTP ${res.status}`);
  const body = (await res.json()) as { current_version?: { version?: unknown } | null };
  const v = body.current_version?.version;
  return typeof v === "string" && v ? v : null;
}

export interface StatusState {
  schemaVersion: 1;
  /** The highest public version seen per store. */
  highWater: Partial<Record<Target, string>>;
}

export function readState(path: string | undefined): { state: StatusState; note?: string } {
  const empty: StatusState = { schemaVersion: 1, highWater: {} };
  if (!path) return { state: empty };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { state: empty, note: "No earlier run's versions to compare with: a version that went back cannot be told this time." };
  }
  try {
    const o = JSON.parse(raw) as StatusState;
    const high: StatusState["highWater"] = {};
    for (const t of ["chrome", "firefox"] as const) if (typeof o.highWater?.[t] === "string") high[t] = o.highWater[t];
    return { state: { schemaVersion: 1, highWater: high } };
  } catch {
    return { state: empty, note: "The earlier run's versions could not be read and are ignored." };
  }
}

export interface StatusResult {
  problems: string[];
  notes: string[];
  lines: string[];
  state: StatusState;
}

export async function runStatus(a: { config: StoreConfig; releasesDir: string; state?: StatusState }, deps: StatusDeps): Promise<StatusResult> {
  const { release, path: releasePath, count } = newestRelease(a.releasesDir);
  const problems: string[] = [];
  const notes: string[] = [];
  const lines: string[] = [`## Store status: newest release file ${release.version}`, ""];
  const high: StatusState["highWater"] = { ...(a.state?.highWater ?? {}) };
  let allPublic = true;
  const names: Record<Target, string> = { chrome: "Chrome Web Store", firefox: "addons.mozilla.org" };

  for (const target of ["chrome", "firefox"] as const) {
    const item = a.config[target];
    if (!item) continue;
    let published: string | null;
    try {
      published = target === "chrome" ? await chromePublicVersion(a.config.chrome!.itemId, deps) : await amoPublicVersion(a.config.firefox!.addon, deps);
    } catch (error) {
      problems.push(`${names[target]}: cannot read the public version: ${(error as Error).message}`);
      allPublic = false;
      continue;
    }
    if (published === null) {
      allPublic = false;
      if (high[target] !== undefined) problems.push(`${names[target]}: lists no public version, though ${high[target]} was public on an earlier run (taken down?)`);
      else if (count > 1) problems.push(`${names[target]}: lists no public version, though earlier releases exist (${count - 1} earlier release file(s))`);
      else notes.push(`${names[target]}: no public version yet. ${release.version} is in review, or not submitted.`);
      lines.push(`- ${names[target]}: no public version`);
      continue;
    }
    lines.push(`- ${names[target]}: public ${published}`);
    const order = compareVersions(published, release.version);
    if (order === null) {
      if (published !== release.version) problems.push(`${names[target]}: public ${published} cannot be ordered against ${release.version}, and is not equal to it`);
    } else if (order > 0) {
      problems.push(`${names[target]}: public ${published} is newer than the newest release file ${release.version}`);
    } else if (order < 0) {
      allPublic = false;
      notes.push(`${names[target]}: ${release.version} is not public yet (public: ${published}). In review, or not submitted.`);
    }
    const seen = high[target];
    const back = seen === undefined ? null : compareVersions(published, seen);
    if (back !== null && back < 0) problems.push(`${names[target]}: the public version went back from ${seen} to ${published}`);
    else if (seen === undefined || back === null || back > 0) high[target] = published;
  }

  const dir = dirname(resolve(releasePath));
  for (const [i, e] of (release.expect ?? []).entries()) {
    if (e.when === "published" && !allPublic) {
      notes.push(`expect ${i + 1} (${e.url}): not checked until ${release.version} is public.`);
      continue;
    }
    const label = `${e.url}${e.why ? ` (${e.why})` : ""}`;
    try {
      const res = await get(deps.fetchFn, e.url, deps.sleep);
      if (res.status !== 200) {
        problems.push(`${label}: HTTP ${res.status}`);
        continue;
      }
      const got = sha256(new Uint8Array(await res.arrayBuffer()));
      const want = e.sha256 ?? sha256(deps.readFile(join(dir, e.file!)));
      if (got !== want) problems.push(`${label}: the live bytes (sha256 ${got.slice(0, 16)}…) are not ${e.file ? basename(e.file) : "the expected hash"} (${want.slice(0, 16)}…)`);
      else lines.push(`- expect: ${label} matches`);
    } catch (error) {
      problems.push(`${label}: ${(error as Error).message}`);
    }
  }

  for (const n of notes) lines.push("", `Note: ${n}`);
  lines.push("", problems.length === 0 ? "**No fault found.**" : `**${problems.length} problem(s):**`, ...problems.map((p) => `- ${p}`));
  return { problems, notes, lines, state: { schemaVersion: 1, highWater: high } };
}

export const writeState = (path: string, state: StatusState): void => writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
