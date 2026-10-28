// SPDX-License-Identifier: Apache-2.0
// Which release a page loads, once, when its compute frame starts (docs/remote-releases.md, "Load
// sequence"): the settings in effect are read once; rules 1-5 (pointer.ts) need no network; a
// remote release is then fetched and checked (remote-load.ts), and its card facts are built from
// the catalog it hands the worker. Anything that fails gives the bundled release.

import type { WorkerRequest } from "../messages.js";
import type { CardTable } from "./card-table.js";
import { clearStaleSkip, decide, parsePointer, readSkip, type SkipStorage, writeSkip } from "./pointer.js";
import type { ReleasePointer } from "./pointer.js";
import { loadRemoteRelease, type RemoteLoadDeps } from "./remote-load.js";

/** The runtime worker's `load` request. */
export type LoadRequest = Extract<WorkerRequest, { kind: "load" }>;

/** What `chooseRelease` decided for this page. */
export type RemoteReleaseChoice =
  | {
      source: "bundled";
      reason: string;
      pointer: ReleasePointer | null;
      downloaded: number;
      ms: number;
      /** The bundled request to use instead of the page's own (a fallback from a remote release
       *  may load it with the geometric stage off, geometric.ts). */
      request?: LoadRequest;
    }
  | {
      source: "remote";
      pointer: ReleasePointer;
      /** The load request with the release's files. */
      request: LoadRequest;
      /** The bundled request a fallback from this release uses (rules 10-11). */
      fallback?: LoadRequest;
      /** The card facts of that release's catalog, built before the load (docs/remote-releases.md, "Card facts"). */
      facts: CardTable;
      reused: number;
      downloaded: number;
      ms: number;
    };

/** One decision, for the log line (docs/remote-releases.md, "Logging"). */
export interface ReleaseDecision {
  source: "remote" | "bundled";
  reason: string;
  pointer: string | null;
  reused: number;
  downloaded: number;
  ms: number;
}

export interface ChooseDeps extends Omit<RemoteLoadDeps, "onDownloading"> {
  storage: SkipStorage;
  /** The settings in effect: their `release` field as written. */
  readReleaseField(): Promise<unknown>;
  /** The running extension's version. */
  running: string;
  now(): number;
  /** The bundled release's request (wasmPaths reused for a remote load). */
  bundled: LoadRequest;
  /** The card facts table for a catalog (the build's rule). */
  buildCardTable(catalog: unknown): CardTable;
}

/** The bundled release's id, from its document inside the extension. */
async function bundledId(deps: ChooseDeps): Promise<string> {
  const response = await deps.fetch(deps.extensionUrl("release/release.json"));
  const doc = (await response.json()) as { id?: unknown };
  if (typeof doc.id !== "string") throw new Error("the bundled release has no id");
  return doc.id;
}

export async function chooseRelease(deps: ChooseDeps, hooks: { onDownloading(): void }): Promise<RemoteReleaseChoice> {
  const t0 = deps.now();
  const ms = (): number => Math.round(deps.now() - t0);
  const field = parsePointer(await deps.readReleaseField());
  const skip = await clearStaleSkip(deps.storage, field, await readSkip(deps.storage, Date.now()));
  const d = decide({ field, running: deps.running, bundledId: await bundledId(deps), skip });
  if (d.source === "bundled") return { source: "bundled", reason: d.reason, pointer: d.pointer, downloaded: 0, ms: ms() };

  const loaded = await loadRemoteRelease(d.pointer, { ...deps, onDownloading: hooks.onDownloading });
  if (!loaded.ok) {
    if (loaded.record) await recordSkip(deps.storage, d.pointer, loaded.reason);
    return { source: "bundled", reason: loaded.reason, pointer: d.pointer, downloaded: loaded.downloaded, ms: ms() };
  }
  // The facts are built now, from the very bytes the worker gets (docs/remote-releases.md, "Card facts"); the frame adopts
  // them only if the worker confirms this release.
  let facts: CardTable;
  try {
    facts = deps.buildCardTable(JSON.parse(await loaded.catalog.text()));
  } catch {
    // The runtime would refuse it too (and that would be recorded); here it is only logged.
    return { source: "bundled", reason: "catalog-unreadable", pointer: d.pointer, downloaded: loaded.downloaded, ms: ms() };
  }
  const request: LoadRequest = {
    kind: "load",
    releaseUrl: "release.json",
    files: loaded.files,
    ...(deps.bundled.wasmPaths !== undefined ? { wasmPaths: deps.bundled.wasmPaths } : {}),
  };
  return { source: "remote", pointer: d.pointer, request, facts, reused: loaded.reused, downloaded: loaded.downloaded, ms: ms() };
}

/** Record a release not to try again for 24 h (docs/remote-releases.md, "The skip-list"). */
export async function recordSkip(storage: SkipStorage, pointer: ReleasePointer, reason: string): Promise<void> {
  await writeSkip(storage, { id: pointer.id, sha256: pointer.sha256, reason, at: Date.now() });
}

/** The log line of one decision (docs/remote-releases.md, "Logging"): no page, channel, video, frame or card. */
export function decisionLine(name: string, d: { source: string; reason: string; pointer: string | null; reused: number; downloaded: number; ms: number }, bundled: string): string {
  return `[${name}] release source=${d.source} reason=${d.reason} pointer=${d.pointer ?? "-"} bundled=${bundled} reused=${d.reused}/5 downloaded=${d.downloaded} ms=${d.ms}`;
}
