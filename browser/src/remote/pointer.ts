// SPDX-License-Identifier: Apache-2.0
// The remote release pointer (docs/remote-releases.md, "The pointer"): which release a page loads.
//
// The settings file may name a release published on the settings host, under
// vision/releases/<id>/. A qualifying install loads it instead of the release bundled in the
// extension; anything wrong with it, at any step, loads the bundled one. This file holds the rules
// that need no network (rules 1-5) and the skip-list (docs/remote-releases.md, "Rules 1 to 5" and
// "The skip-list"); remote-load.ts fetches and checks the files (rules 6-9b), and the product's
// compute frame handles the worker's answer (rules 10-12).

/** Compare two `x.y.z` versions (a manifest may also say `x.y` or `x.y.z.w`); missing parts are 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface ReleasePointer {
  id: string;
  path: string;
  sha256: string;
  minimumExtensionVersion: string;
  maximumExtensionVersion: string | null;
}

export type PointerField =
  | { kind: "absent" }
  | { kind: "malformed"; key: string }
  | { kind: "pointer"; pointer: ReleasePointer };

const ID = /^[0-9a-f]{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `release` field of the settings file, as written (null or undefined: absent). Unknown keys
 *  inside it are ignored; `geometric` is read by geometric.ts and is ignored here. */
export function parsePointer(raw: unknown): PointerField {
  if (raw === null || raw === undefined) return { kind: "absent" };
  if (!isObject(raw)) return { kind: "malformed", key: "release" };
  const { id, path, sha256, minimumExtensionVersion: min, maximumExtensionVersion: max } = raw;
  if (typeof id !== "string" || !ID.test(id)) return { kind: "malformed", key: "id" };
  // Exactly this path, so always the settings host's own folder for this id.
  if (typeof path !== "string" || path !== `vision/releases/${id}/release.json`) return { kind: "malformed", key: "path" };
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return { kind: "malformed", key: "sha256" };
  if (typeof min !== "string" || !VERSION.test(min)) return { kind: "malformed", key: "minimumExtensionVersion" };
  if (max !== undefined && (typeof max !== "string" || !VERSION.test(max))) return { kind: "malformed", key: "maximumExtensionVersion" };
  return { kind: "pointer", pointer: { id, path, sha256, minimumExtensionVersion: min, maximumExtensionVersion: typeof max === "string" ? max : null } };
}

// ------------------------------------------------------------------ the skip-list ("The skip-list")

/** One release that failed in a way that will fail again (a bad document or file, a refusal by
 *  the runtime before it prepared the models): it is not tried again for SKIP_TTL_MS. */
export interface SkipEntry {
  id: string;
  sha256: string;
  reason: string;
  /** When it was recorded, ms since the epoch. */
  at: number;
}

export const SKIP_KEY = "releaseSkip";
export const SKIP_TTL_MS = 24 * 60 * 60 * 1000;

/** The part of an extension's own local storage used here. */
export interface SkipStorage {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}

function skipShape(value: unknown): SkipEntry | null {
  if (!isObject(value)) return null;
  const { id, sha256, reason, at } = value;
  if (typeof id !== "string" || typeof sha256 !== "string" || typeof reason !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null;
  return { id, sha256, reason, at };
}

/** The skip entry in effect, or null. An entry 24 h old or more, from the future, or malformed is
 *  deleted on read. */
export async function readSkip(storage: SkipStorage, now: number): Promise<SkipEntry | null> {
  const raw = (await storage.get(SKIP_KEY))[SKIP_KEY];
  if (raw === undefined) return null;
  const entry = skipShape(raw);
  if (!entry || now - entry.at >= SKIP_TTL_MS || entry.at > now) {
    await storage.remove(SKIP_KEY);
    return null;
  }
  return entry;
}

/** Record a release not to try again; it replaces any entry. */
export async function writeSkip(storage: SkipStorage, entry: SkipEntry): Promise<void> {
  await storage.set({ [SKIP_KEY]: entry });
}

// ------------------------------------------------------------------ the decision (rules 1-5)

export type Decision =
  | { source: "bundled"; reason: string; pointer: ReleasePointer | null }
  | { source: "remote"; pointer: ReleasePointer };

export interface DecideInput {
  field: PointerField;
  /** The running extension's version (manifest). */
  running: string;
  /** The bundled release's id. */
  bundledId: string;
  /** The skip entry in effect (readSkip), or null. */
  skip: SkipEntry | null;
}

/** Which release to load, before anything is fetched. */
export function decide({ field, running, bundledId, skip }: DecideInput): Decision {
  if (field.kind === "absent") return { source: "bundled", reason: "absent", pointer: null };
  if (field.kind === "malformed") return { source: "bundled", reason: `malformed:${field.key}`, pointer: null };
  const p = field.pointer;
  if (compareVersions(running, p.minimumExtensionVersion) < 0) return { source: "bundled", reason: "version", pointer: p };
  if (p.maximumExtensionVersion !== null && compareVersions(running, p.maximumExtensionVersion) >= 0) return { source: "bundled", reason: "version", pointer: p };
  if (p.id === bundledId) return { source: "bundled", reason: "same-as-bundled", pointer: p };
  if (skip && skip.id === p.id && skip.sha256 === p.sha256) return { source: "bundled", reason: `skipped:${skip.reason}`, pointer: p };
  return { source: "remote", pointer: p };
}

/**
 * The skip-list's clearing: the entry goes when the field is absent, or when the pointer names another
 * (id, sha256), so that a later move back to the skipped release is tried again. Returns the entry
 * still in effect.
 */
export async function clearStaleSkip(storage: SkipStorage, field: PointerField, skip: SkipEntry | null): Promise<SkipEntry | null> {
  if (!skip) return null;
  const keep = field.kind === "pointer" && field.pointer.id === skip.id && field.pointer.sha256 === skip.sha256;
  if (keep || field.kind === "malformed") return skip;
  await storage.remove(SKIP_KEY);
  return null;
}

// ------------------------------------------------------------------ what the worker's refusal means

/** Reasons from the frame itself, never the runtime's verdict on the files: not recorded. */
const FRAME_REASONS = [/^the worker did not start/, /^unexpected error while loading/];

/**
 * Whether a worker refusal (rule 10) goes on the skip-list: only a refusal that came before the
 * worker said it was preparing the models (the files and their bindings were judged), and never
 * the runtime's catch-all (`unexpected:`, a transient read, crypto or memory failure) or the
 * frame's own errors.
 */
export function refusalRecorded(reason: string, sawPreparing: boolean): boolean {
  if (sawPreparing) return false;
  if (reason.startsWith("unexpected:")) return false;
  return !FRAME_REASONS.some((re) => re.test(reason));
}
