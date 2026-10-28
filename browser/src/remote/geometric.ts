// SPDX-License-Identifier: Apache-2.0
// The geometric stage under a remote release (docs/remote-releases.md, rules G1-G3), for a
// product whose releases carry the geometric stage.
//
//   G1 the pointer's `geometric` is absent or malformed, or the settings say `geometric: false`:
//      the remote release runs, with the stage off.
//   G2 the stage's settings file (vision/releases/<id>/geometric.json) is fetched and checked: its
//      SHA-256 is the pointer's, it is JSON, and its index manifest is on the settings host under
//      /vision/geo/<16 hex>/, either `manifest.json` (a flat folder, written once) or
//      `manifest-<16 hex>.json` (a series folder that grows by appending). Anything else: stage off.
//   G3 the runtime checks the index itself (manifest, bank binding, shards); a refusal there turns
//      the stage off and never fails the release.
//
// The index cache: the runtime keeps the index's shards in the browser's cache and, after a load,
// drops what lies outside the loaded manifest's folder. So a page that fell back from a remote
// release (rules 6-12) loads the bundled release with the stage off, unless the pointer's index is
// the bundled one; otherwise loading the bundled index would evict the remote one and the next
// page would download it again (about 45 MB).

import type { LoadRequest } from "./choose.js";

export interface GeometricPointer {
  path: string;
  sha256: string;
  manifestSha256: string;
}

export type GeometricField = { kind: "absent" } | { kind: "malformed"; key: string } | { kind: "pointer"; geometric: GeometricPointer };

const ID = /^[0-9a-f]{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** Where an index manifest may be: a flat folder or a series folder (docs/remote-releases.md, "Index folders"). */
export const GEO_MANIFEST_PATH = /^\/vision\/geo\/[0-9a-f]{16}\/(manifest\.json|manifest-[0-9a-f]{16}\.json)$/;
export const GEOMETRIC_TIMEOUT_MS = 10_000;
/** The stage's settings file is a few KB; a body past this is not read (it fails its SHA-256). */
export const GEOMETRIC_MAX_BYTES = 256 * 1024;

const FETCH_OPTIONS: RequestInit = { credentials: "omit", referrerPolicy: "no-referrer", cache: "default" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `geometric` part of the settings file's `release` field, as written. */
export function parseGeometricPointer(release: unknown): GeometricField {
  if (!isObject(release)) return { kind: "absent" };
  const raw = release.geometric;
  if (raw === null || raw === undefined) return { kind: "absent" };
  if (!isObject(raw)) return { kind: "malformed", key: "geometric" };
  const id = release.id;
  if (typeof id !== "string" || !ID.test(id)) return { kind: "malformed", key: "id" };
  const { path, sha256, manifestSha256 } = raw;
  // Exactly this path, so always the settings host's own folder for this release.
  if (typeof path !== "string" || path !== `vision/releases/${id}/geometric.json`) return { kind: "malformed", key: "path" };
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return { kind: "malformed", key: "sha256" };
  if (typeof manifestSha256 !== "string" || !SHA256.test(manifestSha256)) return { kind: "malformed", key: "manifestSha256" };
  return { kind: "pointer", geometric: { path, sha256, manifestSha256 } };
}

export interface GeometricDeps {
  fetch: typeof fetch;
  sha256Hex(bytes: ArrayBuffer): Promise<string>;
  /** The settings file's address: the pointer's path resolves against it, and the index must be
   *  on its origin. */
  settingsUrl: string;
  timeoutMs?: number;
}

export type GeometricCheck =
  | { ok: true; url: string; manifestSha256: string }
  | { ok: false; reason: "geo-setting" | "geo-absent" | `geo-malformed:${string}` | "geo-unreachable" | "geo-sha" | "geo-shape" };

/** Rules G1 and G2: the stage's part of the load request for a remote release, or why it is off.
 *  `stageOn`: the build has the stage and the settings do not turn it off. */
export async function checkRemoteGeometric(field: GeometricField, stageOn: boolean, deps: GeometricDeps): Promise<GeometricCheck> {
  if (!stageOn) return { ok: false, reason: "geo-setting" };
  if (field.kind === "absent") return { ok: false, reason: "geo-absent" };
  if (field.kind === "malformed") return { ok: false, reason: `geo-malformed:${field.key}` };
  const g = field.geometric;
  const url = new URL(g.path, deps.settingsUrl).href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? GEOMETRIC_TIMEOUT_MS);
  let bytes: ArrayBuffer;
  try {
    const response = await deps.fetch(url, { ...FETCH_OPTIONS, signal: controller.signal });
    if (!response.ok) return { ok: false, reason: "geo-unreachable" };
    bytes = await response.arrayBuffer();
  } catch {
    return { ok: false, reason: "geo-unreachable" };
  } finally {
    clearTimeout(timer);
  }
  if (bytes.byteLength > GEOMETRIC_MAX_BYTES || (await deps.sha256Hex(bytes)) !== g.sha256) return { ok: false, reason: "geo-sha" };
  let settings: unknown;
  try {
    settings = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, reason: "geo-shape" };
  }
  const index = isObject(settings) && isObject(settings.index) ? settings.index : null;
  if (!index || typeof index.path !== "string") return { ok: false, reason: "geo-shape" };
  let manifest: URL;
  try {
    manifest = new URL(index.path, url);
  } catch {
    return { ok: false, reason: "geo-shape" };
  }
  const settingsOrigin = new URL(deps.settingsUrl).origin;
  if (manifest.origin !== settingsOrigin || manifest.username !== "" || manifest.password !== "" || manifest.search !== "" || manifest.hash !== "" || !GEO_MANIFEST_PATH.test(manifest.pathname)) {
    return { ok: false, reason: "geo-shape" };
  }
  return { ok: true, url, manifestSha256: g.manifestSha256 };
}

/** The bundled release chosen before anything was fetched (rules 1-5): its own request, stage
 *  included. Any other reason is a fallback from a remote release (rules 6-9). */
export function chosenBeforeFetch(reason: string): boolean {
  return reason === "absent" || reason === "version" || reason === "same-as-bundled" || reason.startsWith("malformed:") || reason.startsWith("skipped:");
}

/** The bundled release's request for a page that fell back from a remote release: the stage stays
 *  on only when the pointer's index is the bundled one, so the remote index stays in the cache. */
export function fallbackRequest(bundled: LoadRequest, field: GeometricField): LoadRequest {
  const pointerManifest = field.kind === "pointer" ? field.geometric.manifestSha256 : null;
  if (bundled.geometricManifestSha256 !== undefined && pointerManifest === bundled.geometricManifestSha256) return bundled;
  const { geometricUrl: _url, geometricManifestSha256: _sha, ...plain } = bundled;
  return plain;
}

/** The log line of the stage's decision for a remote release (no page, channel, video or card). */
export function geometricLine(name: string, pointer: string, check: GeometricCheck): string {
  return check.ok
    ? `[${name}] geometric source=remote reason=ok pointer=${pointer} manifest=${check.manifestSha256.slice(0, 16)}`
    : `[${name}] geometric source=off reason=${check.reason} pointer=${pointer}`;
}
