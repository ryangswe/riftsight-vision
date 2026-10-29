// SPDX-License-Identifier: Apache-2.0
// The messages between a page and the analysis worker.
//
// The page sends frames; the worker answers each with what it found. Pixels go in and numbers
// come out: a frame never leaves the worker, and the worker never opens a connection other
// than to fetch the release it was told to load. A release given as files (the load request's
// `files`) is read from them, and nothing is fetched for it.

import type { IdentityRule } from "./identity.js";
import type { FrameAnalysis } from "./pipeline.js";
import type { ExecutionProvider } from "./providers.js";
import type { AcceptRule } from "./recognizer.js";

/**
 * What a frame request was taken from. The worker echoes it unchanged on the reply and never
 * interprets it; the session uses it to decide whether the reply still describes the picture
 * on screen (frame-scheduler.ts `replyRejection`).
 */
export interface FrameEnvelope {
  /** The session's request number, strictly increasing. */
  requestId: number;
  /** Media time of the captured picture, in seconds. */
  mediaTimeSec: number;
  /** Raised on every seek, new source and detected cut: a reply from an older generation
   *  describes a picture that is gone. */
  generation: number;
  /** Which source the frame came from: it changes when the element is given another file. */
  videoKey: string;
}

/** What the worker reports once a release has loaded, or failed to. */
export interface ReleaseStatus {
  kind: "release-status";
  ok: boolean;
  /** Why nothing loaded. A release is all-or-nothing: with a reason set, no frame is analyzed. */
  error: string | null;
  /** The release in effect; null when none loaded. */
  release: {
    id: string;
    game: string;
    locale: string;
    detector: { version: string; ep: ExecutionProvider };
    recognizer: { version: string; ep: ExecutionProvider };
    bankCards: number;
    catalogCards: number;
    /** The identity rule the release states: which catalog entries count as the same card. */
    identityLevel: IdentityRule;
    /** The detector's operating point and the smallest crop, as the release states them. */
    decode: { threshold: number; nmsIou: number; maxProposals: number; minCropPx: number };
    /** The accept rule, as the release states it. */
    accept: AcceptRule;
    hoverSelection: string;
    hoverMaxAgeMs: number;
    analysisWidth: { min: number; max: number };
    ortWeb: string;
  } | null;
  /** Card id to name and image path (null for a card without art), from the release's catalog;
   *  empty when none loaded. */
  cards: Array<{ id: string; name: string; art: string | null }>;
}

/**
 * The address under which a release given as files is read (the load request's `files`). A
 * file's address is this base and its path relative to the release document's folder; it is only
 * ever looked up among the files given, never fetched. A `file:` base, since every browser
 * resolves a relative path against it the same way.
 */
export const RELEASE_FILES_BASE = "file:///";

/** The key of a file among a release's files: its path relative to the release document's folder,
 *  resolved as the loader resolves it (a `./` segment dropped, as the URL parser does). */
export function releaseFileKey(path: string): string {
  const key = new URL(path, RELEASE_FILES_BASE).href.slice(RELEASE_FILES_BASE.length);
  try {
    return decodeURIComponent(key);
  } catch {
    // A lone `%` is kept as written, on both sides.
    return key;
  }
}

export type WorkerRequest =
  | { kind: "ping" }
  /** Load a release. `wasmPaths` is the folder that holds ONNX Runtime's `.wasm` files (default:
   *  the folder of the worker script); `providers`, when given, replaces the release's list of
   *  execution providers. A second load is ignored. */
  | {
      kind: "load";
      /** The release document's address; with `files`, its path among them (`release.json`). */
      releaseUrl: string;
      /** The release's files, by path relative to the release document's folder
       *  (`releaseFileKey`), when they come from the page and not from a server: a folder the
       *  visitor chose. Nothing is then fetched for the release; each file is checked against the
       *  size and SHA-256 the document pins, as a fetched one is. */
      files?: Record<string, Blob>;
      wasmPaths?: string;
      providers?: ExecutionProvider[];
      /** The geometric stage's settings document (it names the packed index). When given, the
       *  stage loads after the release and joins between frames; until then, and whenever it
       *  cannot run, frames are analyzed without it. */
      geometricUrl?: string;
      /** Ask the geometric stage for its debug record of every crop (geometric/debug.ts), which
       *  each verified face then carries in `geometric.debug`. For a scoring run; it decides
       *  nothing. */
      geometricDebug?: boolean;
      /** The SHA-256 the packed index's manifest.json must have. When given, a manifest with
       *  other bytes is refused and the stage is off: the manifest, and through it every shard,
       *  is pinned. */
      geometricManifestSha256?: string;
      /** False turns the geometric watchdog off (default: on). For a scoring run, which measures
       *  the stage on every frame and times it separately; a session that shows cards keeps it. */
      geometricWatchdog?: boolean;
    }
  | {
      kind: "frame";
      /** The picture, already at analysis size (capture.ts). The worker closes it. */
      bitmap: ImageBitmap;
      /** Time of the picture in the video, in seconds. */
      videoTimeSec: number;
      envelope: FrameEnvelope;
    };

/** A frame result's `error` when the frame arrived while another was still being analyzed. */
export const BUSY_ERROR = "busy";

/** The worker's answer to one frame. Every frame gets one. */
export interface FrameResult {
  kind: "frame-result";
  /** The request's envelope, echoed unchanged. */
  envelope: FrameEnvelope;
  /** Set when the frame was not analyzed (nothing is loaded, the analysis threw, or another
   *  analysis was still running). `analysis` is then null and nothing is shown. */
  error?: string;
  videoTimeSec: number;
  /** Size of the analyzed frame, in pixels. */
  width: number;
  height: number;
  /** Time the worker spent on the frame: reading the pixels back and analyzing them, in ms. */
  workerMs: number;
  analysis: FrameAnalysis | null;
}

/**
 * The geometric stage's state, reported when it changes: `loading` while its parts load,
 * `ready` once frames are verified with it, `off` when it does not run (this browser lacks
 * WebGPU, it failed to load, it failed during a frame, its GPU device was lost, or the watchdog
 * turned it off; the last three for the rest of the session). `reason` says why it is off;
 * `bytes` is the size of the descriptor index once loaded; `note`, with `ready`, warns that the
 * index was taken by another OpenCV version than the one running (keypoints may differ).
 */
export interface GeometricStatus {
  kind: "geometric-status";
  state: "loading" | "ready" | "off";
  reason: string | null;
  bytes: number | null;
  note?: string | null;
}

/** Where the load of the release is, sent while it loads (`LoadProgress` in load.ts): downloading
 *  the files it pins (`bytes`: their sum, null until the release document is read), or preparing
 *  the models. A release-status reply ends it. */
export interface ReleaseProgress {
  kind: "release-progress";
  phase: "downloading" | "preparing";
  bytes: number | null;
}

export type WorkerReply = { kind: "pong" } | ReleaseStatus | ReleaseProgress | FrameResult | GeometricStatus;
