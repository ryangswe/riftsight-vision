// SPDX-License-Identifier: Apache-2.0
// Fetch and check a remote release before the worker sees it (docs/remote-releases.md, rules 6-9b).
//
//   1. The release document, from the settings host (10 s for all of it): its SHA-256 must be the
//      pointer's, it must be a release with that id, and every file it pins must be a flat name.
//   2. The bundled release document, from inside the extension. Each file the remote document pins
//      with the same SHA-256 and size as a bundled file is taken from the extension (a card-only
//      update reuses both models); every other file is downloaded from the release's folder, read
//      as a stream that may not stall for 30 s, and checked against its size and SHA-256.
//   3. The files go to the worker as its `files` map, keyed by the document's own paths; the runtime
//      checks every one of them again, reused or downloaded.
//
// A document or file whose SHA-256 is wrong is fetched once more past the HTTP cache before the
// release is given up on and recorded (a stale or broken cache entry is not the release's fault).
// Network failures are never recorded: the next page tries again.

import type { ReleasePointer } from "./pointer.js";

/** A pinned file's name: no folder, no `..`, nothing but letters, digits, `.`, `_` and `-`. */
export const FLAT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const DOCUMENT_TIMEOUT_MS = 10_000;
/** The release document is a few KB; a body past this is not read further (it fails its SHA-256). */
export const DOCUMENT_MAX_BYTES = 256 * 1024;
export const STALL_MS = 30_000;

export interface PinnedFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface RemoteLoadDeps {
  fetch: typeof fetch;
  sha256Hex(bytes: ArrayBuffer): Promise<string>;
  /** The settings file's address: the pointer's path and the release folder resolve against it. */
  settingsUrl: string;
  /** A file inside the extension (in an extension, chrome.runtime.getURL). */
  extensionUrl(path: string): string;
  /** Called before the release document is asked for (the frame shows its loading state). */
  onDownloading?(): void;
  documentTimeoutMs?: number;
  stallMs?: number;
}

export type RemoteLoad =
  | {
      ok: true;
      /** The worker's `files`: "release.json" and each pinned path. */
      files: Record<string, Blob>;
      /** The catalog, as handed to the worker (the card facts are built from it). */
      catalog: Blob;
      /** How many of the five pinned files came from the extension. */
      reused: number;
      /** Bytes received over the network (the document and the downloaded files), decoded. */
      downloaded: number;
    }
  | { ok: false; reason: string; record: boolean; downloaded: number };

const FETCH_OPTIONS: RequestInit = { credentials: "omit", referrerPolicy: "no-referrer", cache: "default" };

class Failure extends Error {
  constructor(
    readonly reason: string,
    readonly record: boolean,
  ) {
    super(reason);
  }
}

/** The five files a release pins, from a parsed document; null when one is missing or malformed. */
export function pinnedFiles(doc: unknown): PinnedFile[] | null {
  if (typeof doc !== "object" || doc === null) return null;
  const d = doc as Record<string, unknown>;
  const identity = d.identity as Record<string, unknown> | undefined;
  const refs = [d.detector, d.recognizer, d.bank, identity && typeof identity === "object" ? identity.groups : undefined, d.catalog];
  const out: PinnedFile[] = [];
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null) return null;
    const { path, sha256, bytes } = ref as Record<string, unknown>;
    if (typeof path !== "string" || typeof sha256 !== "string" || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return null;
    out.push({ path, sha256, bytes });
  }
  return out;
}

/**
 * Read a response's body as a stream: with `stallMs`, abort when no bytes arrive for that long; never
 * more than `maxBytes` + 1 bytes (a longer body is cut there and then fails its size and SHA-256
 * check, so a server cannot make the frame read without end).
 */
async function readBody(response: Response, controller: AbortController, stallMs: number | null, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.body) {
    const all = await response.arrayBuffer();
    return all.byteLength > maxBytes ? all.slice(0, maxBytes + 1) : all;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    if (stallMs === null) return;
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), stallMs);
  };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        break;
      }
      arm();
    }
  } finally {
    clearTimeout(timer);
  }
  const size = Math.min(total, maxBytes + 1);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    if (at >= size) break;
    const part = c.byteLength <= size - at ? c : c.subarray(0, size - at);
    out.set(part, at);
    at += part.byteLength;
  }
  return out.buffer;
}

export async function loadRemoteRelease(pointer: ReleasePointer, deps: RemoteLoadDeps): Promise<RemoteLoad> {
  let downloaded = 0;
  const docTimeout = deps.documentTimeoutMs ?? DOCUMENT_TIMEOUT_MS;
  const stallMs = deps.stallMs ?? STALL_MS;

  /** Fetch a URL on the settings host with the rules' options. `whole`: one deadline for the
   *  whole body (the document); otherwise the stall rule (files). */
  const get = async (url: string, label: string, opts: { whole: boolean; reload: boolean; maxBytes: number }): Promise<ArrayBuffer> => {
    const controller = new AbortController();
    // The document: one deadline for all of it. A file: the stall rule from the request on (a server
    // that never answers is a stall too), re-armed per chunk once the body comes.
    const deadline = setTimeout(() => controller.abort(), opts.whole ? docTimeout : stallMs);
    try {
      let response: Response;
      try {
        response = await deps.fetch(url, { ...FETCH_OPTIONS, ...(opts.reload ? { cache: "reload" } : {}), signal: controller.signal });
      } catch {
        throw new Failure(label === "release.json" ? "unreachable" : `unreachable:${label}`, false);
      }
      if (!opts.whole) clearTimeout(deadline);
      if (!response.ok) throw new Failure(label === "release.json" ? `http-${response.status}` : `unreachable:${label}`, false);
      try {
        const body = await readBody(response, controller, opts.whole ? null : stallMs, opts.maxBytes);
        downloaded += body.byteLength;
        return body;
      } catch {
        throw new Failure(label === "release.json" ? "unreachable" : `unreachable:${label}`, false);
      }
    } finally {
      clearTimeout(deadline);
    }
  };

  try {
    // ---------------------------------------------------------------- 1. the document
    const docUrl = new URL(pointer.path, deps.settingsUrl).href;
    deps.onDownloading?.();
    let docBytes = await get(docUrl, "release.json", { whole: true, reload: false, maxBytes: DOCUMENT_MAX_BYTES });
    if ((await deps.sha256Hex(docBytes)) !== pointer.sha256) {
      docBytes = await get(docUrl, "release.json", { whole: true, reload: true, maxBytes: DOCUMENT_MAX_BYTES });
      if ((await deps.sha256Hex(docBytes)) !== pointer.sha256) throw new Failure("doc-sha", true);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(docBytes));
    } catch {
      throw new Failure("doc-shape", true);
    }
    const remote = pinnedFiles(doc);
    // Flat names, and none of them the document's own key among the worker's files.
    const flat = (f: PinnedFile): boolean => FLAT_NAME.test(f.path) && f.path !== "release.json";
    if (!remote || (doc as { id?: unknown }).id !== pointer.id || !remote.every(flat)) throw new Failure("doc-shape", true);

    // ---------------------------------------------------------------- 2. reuse, then downloads
    let bundled: PinnedFile[] = [];
    try {
      const r = await deps.fetch(deps.extensionUrl("release/release.json"));
      bundled = pinnedFiles(await r.json()) ?? [];
    } catch {
      bundled = [];
    }
    const files: Record<string, Blob> = { "release.json": new Blob([docBytes], { type: "application/json" }) };
    let reused = 0;
    for (const file of remote) {
      const same = bundled.find((b) => b.sha256 === file.sha256 && b.bytes === file.bytes);
      if (same) {
        const r = await deps.fetch(deps.extensionUrl(`release/${same.path}`));
        if (r.ok) {
          files[file.path] = await r.blob();
          reused += 1;
          continue;
        }
      }
      const url = new URL(`vision/releases/${pointer.id}/${file.path}`, deps.settingsUrl).href;
      let bytes = await get(url, file.path, { whole: false, reload: false, maxBytes: file.bytes });
      const ok = async (b: ArrayBuffer): Promise<boolean> => b.byteLength === file.bytes && (await deps.sha256Hex(b)) === file.sha256;
      if (!(await ok(bytes))) {
        bytes = await get(url, file.path, { whole: false, reload: true, maxBytes: file.bytes });
        if (!(await ok(bytes))) throw new Failure(`file-sha:${file.path}`, true);
      }
      files[file.path] = new Blob([bytes]);
    }
    const catalogPath = remote[4]!.path;
    return { ok: true, files, catalog: files[catalogPath]!, reused, downloaded };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, reason: error.reason, record: error.record, downloaded };
    return { ok: false, reason: `unexpected:${String(error)}`, record: false, downloaded };
  }
}
