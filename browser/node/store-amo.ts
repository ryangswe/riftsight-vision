// SPDX-License-Identifier: Apache-2.0
// The addons.mozilla.org API (v5) calls a listed release needs: whether a listed version is still
// awaiting review, an upload, and a new version with its source code, release notes and notes to
// reviewers. Authentication is a JWT signed with the account's API key (issuer) and secret.

import { createHmac, randomUUID } from "node:crypto";

import { type Decision, StoreError } from "./store-chrome.js";

export const AMO_API = "https://addons.mozilla.org";

export interface AmoAddon {
  /** The add-on's id, slug or guid. */
  addon: string;
  issuer: string;
  secret: string;
  base?: string;
  fetchFn?: typeof fetch;
  /** Seconds since the epoch (tests). */
  now?: () => number;
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/** A JWT for one request: HS256, issued now, valid 60 s (the API allows at most five minutes). */
export function amoJwt(issuer: string, secret: string, nowSeconds: number, jti: string = randomUUID()): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: issuer, jti, iat: nowSeconds, exp: nowSeconds + 60 }));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function call(a: AmoAddon, method: string, path: string, body?: BodyInit, contentType?: string): Promise<unknown> {
  const fetchFn = a.fetchFn ?? fetch;
  const now = a.now ? a.now() : Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { Authorization: `JWT ${amoJwt(a.issuer, a.secret, now)}` };
  if (contentType) headers["Content-Type"] = contentType;
  const res = await fetchFn(`${a.base ?? AMO_API}/api/v5/${path}`, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new StoreError(`addons.mozilla.org ${method} ${path}: HTTP ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

const addonPath = (a: AmoAddon): string => `addons/addon/${encodeURIComponent(a.addon)}`;

export interface AmoVersion {
  id: number;
  version: string;
  channel: string;
  file?: { status?: string };
}

/** The add-on's listed versions, with their review status (`file.status`). The next pages
 *  are read from the same host: only the path of a `next` link is kept. */
export async function amoListed(a: AmoAddon): Promise<AmoVersion[]> {
  const out: AmoVersion[] = [];
  let path: string | null = `${addonPath(a)}/versions/?filter=all_without_unlisted&page_size=50`;
  for (let page = 0; path && page < 20; page++) {
    const res = (await call(a, "GET", path)) as { results?: AmoVersion[]; next?: string | null };
    for (const v of res.results ?? []) if (v.channel === "listed") out.push(v);
    path = res.next ? res.next.replace(/^.*\/api\/v5\//, "") : null;
  }
  return out;
}

/** "skip": this version is already on AMO (a re-run). "block": another listed version is
 *  awaiting review. */
export function amoDecision(listed: AmoVersion[], version: string): Decision {
  const same = listed.find((v) => v.version === version);
  if (same) return { kind: "skip", reason: `version ${version} is already submitted (${same.file?.status ?? "status not reported"})`, versionId: same.id };
  const pending = listed.filter((v) => v.file?.status === "unreviewed");
  if (pending.length > 0) return { kind: "block", reason: `listed version ${pending.map((v) => v.version).join(", ")} is awaiting review` };
  return { kind: "go" };
}

export interface AmoSubmission {
  zip: Uint8Array;
  zipName: string;
  /** The source code archive for reviewers (required for minified or generated code). */
  source?: { bytes: Uint8Array; name: string };
  /** Locale-keyed, e.g. {"en-US": "…"}. */
  releaseNotes?: Record<string, string>;
  approvalNotes?: string;
  pollMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AmoSubmitResult {
  uploadUuid: string;
  versionId: number;
  version: string;
}

/** Upload the package to the listed channel and wait until it has passed validation. Creates no
 *  version: an upload that is never submitted changes nothing on the listing. */
export async function amoValidate(a: AmoAddon, s: AmoSubmission): Promise<string> {
  const form = new FormData();
  form.append("upload", new Blob([s.zip as BlobPart], { type: "application/zip" }), s.zipName);
  form.append("channel", "listed");
  let upload = (await call(a, "POST", "addons/upload/", form)) as { uuid: string; processed?: boolean; valid?: boolean; validation?: unknown };
  const sleep = s.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let k = 0; !upload.processed && k < (s.maxPolls ?? 180); k++) {
    await sleep(s.pollMs ?? 5000);
    upload = (await call(a, "GET", `addons/upload/${encodeURIComponent(upload.uuid)}/`)) as typeof upload;
  }
  if (!upload.processed) throw new StoreError("addons.mozilla.org did not finish validating the upload");
  if (!upload.valid) throw new StoreError(`addons.mozilla.org validation failed: ${JSON.stringify(upload.validation).slice(0, 800)}`);
  return upload.uuid;
}

/** Create the listed version from a validated upload, with its source. Its notes are set by
 *  `amoSetNotes`. */
export async function amoCreateVersion(a: AmoAddon, uploadUuid: string, s: AmoSubmission): Promise<AmoSubmitResult> {
  const create = new FormData();
  create.append("upload", uploadUuid);
  if (s.source) create.append("source", new Blob([s.source.bytes as BlobPart], { type: "application/zip" }), s.source.name);
  const version = (await call(a, "POST", `${addonPath(a)}/versions/`, create)) as { id: number; version: string };
  return { uploadUuid, versionId: version.id, version: version.version };
}

/** Set a version's release notes and notes to reviewers (setting them again is harmless).
 *  Returns false when there are none to set. */
export async function amoSetNotes(a: AmoAddon, versionId: number, s: Pick<AmoSubmission, "releaseNotes" | "approvalNotes">): Promise<boolean> {
  const notes: Record<string, unknown> = {};
  if (s.releaseNotes) notes.release_notes = s.releaseNotes;
  if (s.approvalNotes) notes.approval_notes = s.approvalNotes;
  if (Object.keys(notes).length === 0) return false;
  await call(a, "PATCH", `${addonPath(a)}/versions/${versionId}/`, JSON.stringify(notes), "application/json");
  return true;
}
