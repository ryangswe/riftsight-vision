// SPDX-License-Identifier: Apache-2.0
// A session: recognition running on one <video> or image element of the page.
//
// The session owns everything that touches the page: it listens to the element and to the
// pointer over it, captures the frame the session core asks for, and answers, for a pointer
// position, with the card that would be shown there, or nothing. When a frame is analyzed, which
// reply may be shown and the worker's lifecycle are the session core's and the worker session's
// (session-core.ts, worker-session.ts): this file adapts them to an element of its own document.
//
//   - the video's events (video-events.ts) and, where there is one, its video-frame callback,
//     report presented frames, seeks and new sources; an image's `load` is a new source;
//   - the pointer over the element is reported in fractions of the picture (`pictureBox`);
//   - a capture is a video's `grabFrame` (page-capture.ts) or an image's `captureFrame`;
//   - a cut (the picture under a shown card changed without a seek) is detected here, since it
//     needs the element: a WebGL2 signature sampler (capture.ts) while a card shows.
//
// It draws nothing. Whoever creates the session decides how a box and a name are displayed.
//
// What is never shown:
//   - a result from before a seek, a new file or a cut (`replyRejection`);
//   - a result whose frame is further from the picture on screen, in video time, than the
//     release's `hover.maxAgeMs`;
//   - anything for a box that was detected and not accepted.

import { type AABB } from "./boxes.js";
import { type SessionMode } from "./cadence.js";
import {
  type AnalysisWidth,
  captureFrame,
  type ClientBox,
  createSignatureSampler,
  CUT_SAMPLE_MIN_INTERVAL_MS,
  CutReference,
  fractionIn,
  type FrameSource,
  pictureBox,
  type SignatureSampler,
  type SignatureTicket,
  sourceSize,
} from "./capture.js";
import { type AnalysisState, DRIVER_TICK_MS } from "./frame-scheduler.js";
import type { GeometricStatus, ReleaseStatus } from "./messages.js";
import { type Grab, type GrabDeps, grabFrame, NO_CONTEXT, NO_PICTURE } from "./page-capture.js";
import type { FrameAnalysis } from "./pipeline.js";
import type { ExecutionProvider } from "./providers.js";
import type { LoadRequest } from "./remote/choose.js";
import type { SessionCore, Shown as CoreShown } from "./session-core.js";
import { type VideoWatch, watchVideo } from "./video-events.js";
import { createWorkerSession, type WorkerLike } from "./worker-session.js";

export { type ClientBox, pictureBox };
export { WORKER_RESTARTS } from "./worker-session.js";

export interface SessionOptions {
  /** URL of the release document. Its paths are relative to it. With `releaseFiles`, the
   *  document's path among those files (`release.json`). */
  releaseUrl: string | URL;
  /** The release's files, by path relative to the release document's folder, when they come from
   *  the page (a folder the visitor chose) and not from a server. They are handed to the worker,
   *  which reads the release from them and fetches nothing for it; each file is checked against
   *  the size and SHA-256 the document pins, as a fetched one is. */
  releaseFiles?: Record<string, Blob>;
  /** URL of the worker script (the built `worker.js`). Default: `worker.js` beside this module. */
  workerUrl?: string | URL;
  /** URL of the folder that holds ONNX Runtime's `.wasm` files. Default: the worker's folder. */
  wasmPaths?: string;
  /** The execution providers to try, in order, in place of the release's own list. */
  providers?: ExecutionProvider[];
  /** "pointer" (the default): analyze only around pointer activity. "always-on": analyze for as
   *  long as the session runs. */
  mode?: SessionMode;
  /** URL of the geometric stage's settings document (it names the packed index). Optional and
   *  off by default: without it recognition is the embedding's alone. With it the stage loads
   *  after the release and joins between frames; `status().geometric` says where it is. */
  geometricUrl?: string | URL;
  /** The SHA-256 the packed index's manifest.json must have: a manifest with other bytes is
   *  refused and the stage is off. */
  geometricManifestSha256?: string;
  /** False turns the geometric watchdog off (default: on). Meant for measuring the stage, not
   *  for showing cards: with it off, a slow stage is never turned off. */
  geometricWatchdog?: boolean;
  /** Called whenever the status or what would be shown may have changed. */
  onUpdate?: () => void;
}

/** What would be shown for a pointer position. */
export interface Shown {
  name: string;
  cardId: string;
  /** The card's box on the page, in CSS pixels of the viewport. */
  box: ClientBox;
  /** The card's box in pixels of the analyzed frame. */
  frameBox: AABB;
}

export interface SessionStatus {
  /** "loading" until the release has loaded; "failed" when it did not, or when the worker
   *  stopped twice after loading (see `error`). A worker that stops after loading is restarted
   *  once, without the geometric stage, and the state is "loading" again meanwhile. */
  state: "loading" | "ready" | "failed" | "stopped";
  error: string | null;
  /** The release in effect, once loaded (kept while a restarted worker loads it again). */
  release: ReleaseStatus["release"];
  /** The execution provider the recognizer runs on. */
  backend: ExecutionProvider | null;
  /** What the scheduler is doing: "fast", "reading", "idle" or "always-on". */
  schedule: AnalysisState;
  /** Frames analyzed and shown so far. */
  frames: number;
  /** The worker's time for the newest frame (reading the pixels back and analyzing them), and
   *  the time from capture to result as the page saw it, in ms. */
  lastWorkerMs: number | null;
  lastRoundTripMs: number | null;
  /** Why the newest frame was not analyzed, when it was not. */
  lastFrameError: string | null;
  /** The geometric stage's state as the worker last reported it, or off with the reason
   *  `worker-restarted` after a restart; null when none was asked for. */
  geometric?: { state: GeometricStatus["state"]; reason: string | null; bytes: number | null } | null;
  /** The tilted retry: on when the release turns it on, off with the worker's reason once it is
   *  turned off for the session; null when the release does not turn it on. */
  tilted?: { state: "on" | "off"; reason: string | null } | null;
  /** While the release loads: downloading its files (`bytes`, their sum once known) or preparing
   *  the models. Null once it has loaded or failed, and before the worker has said. */
  loading?: { phase: "downloading" | "preparing"; bytes: number | null } | null;
}

export interface Session {
  status(): SessionStatus;
  /** What would be shown for a pointer at these viewport coordinates, or null for nothing. */
  at(clientX: number, clientY: number): Shown | null;
  /** The same for the pointer's current position over the element; null when it is elsewhere. */
  atPointer(): Shown | null;
  /** The newest result that still describes the picture on screen, or null. */
  analysis(): FrameAnalysis | null;
  /** The catalog's cards (id, name, art path), once the release has loaded. */
  cards(): ReleaseStatus["cards"];
  /** Stop analyzing, end the worker and remove every listener. */
  stop(): void;
}

/** A same-document session reads its own video: unlike a content script answering a compute
 *  frame, it analyzes a video out of the page and a frame of any size, as 0.5 did. */
const SAME_DOCUMENT: GrabDeps = { requireConnected: false, maxSide: Infinity };

/**
 * Start a session on an element. The release loads in the background (`status().state`); until
 * then, and whenever nothing can be said, `at` returns null.
 */
export function createSession(source: FrameSource, options: SessionOptions): Session {
  const video = source instanceof HTMLVideoElement ? source : null;
  const element: HTMLElement = source;
  const workerUrl = options.workerUrl ?? new URL("./worker.js", import.meta.url);
  const now = (): number => performance.now();

  // ------------------------------------------------------------------- onUpdate
  // The core reports a change of status and of what is shown separately; one input to it (a
  // pointer move, a worker message, a tick) calls `onUpdate` once, as 0.5 did. Never while
  // `createSession` runs (the caller has no session yet), never after `stop`.
  let live = false;
  let depth = 0;
  let changed = false;
  const changedNow = (): void => {
    if (depth > 0) changed = true;
    else if (live) options.onUpdate?.();
  };
  /** Run one input to the core. `always`: call `onUpdate` even if nothing it reports changed
   *  (a pointer move, a seek: 0.5 called it for those). */
  const input = (run: () => void, always = false): void => {
    depth += 1;
    try {
      run();
    } finally {
      depth -= 1;
    }
    if (always) changed = true;
    if (depth === 0 && changed) {
      changed = false;
      if (live) options.onUpdate?.();
    }
  };

  // ------------------------------------------------------------------- cut detection
  // Only while a card shows over a video. The analyzed frame's own signature (sampled when its
  // capture was asked for) seeds the reference a cut is measured from.
  let sampler: SignatureSampler | null = null;
  const cutReference = new CutReference();
  let lookTicket: SignatureTicket | null = null;
  let liveTicket: SignatureTicket | null = null;
  let lastSampleAt = -Infinity;

  const onAnalysis = (): void => {
    const signature = lookTicket && sampler ? sampler.read(lookTicket) : null;
    if (signature) cutReference.seed(signature);
    else {
      sampler?.release(lookTicket);
      cutReference.reset();
    }
    lookTicket = null;
  };

  // ------------------------------------------------------------------- capture
  const canvas = video ? null : document.createElement("canvas");
  const ctx = canvas?.getContext("2d") ?? null;
  /** An image: drawn whole, at time 0. */
  const grabImage = async (range: AnalysisWidth): Promise<Grab> => {
    if (!canvas || !ctx) return { kind: "failed", reason: NO_CONTEXT, retry: false };
    const size = sourceSize(source);
    if (size.width === 0 || size.height === 0) return { kind: "failed", reason: NO_PICTURE, retry: true };
    try {
      const frame = await captureFrame(source, canvas, ctx, range);
      return { kind: "frame", bitmap: frame.bitmap, mediaTime: frame.videoTimeSec };
    } catch (error) {
      // The picture cannot be read (a file from another origin without permission).
      return { kind: "failed", reason: String(error), retry: false };
    }
  };

  const capture = (requestId: number, range: AnalysisWidth): void => {
    // The ticket of a look that ended without an analysis is not needed any more.
    sampler?.release(lookTicket);
    lookTicket = sampler?.usable ? sampler.sample(source) : null;
    void (watch ? grabFrame(watch, range, SAME_DOCUMENT) : grabImage(range)).then((grab) =>
      input(() => {
        if (grab.kind === "frame") core.frame(requestId, grab.bitmap, grab.mediaTime);
        else core.captureFailed(requestId, grab.reason, grab.retry);
      }, grab.kind === "failed"),
    );
  };

  // ------------------------------------------------------------------- the worker
  // The first worker that cannot be made (a cross-origin `workerUrl`, no module workers) makes
  // `createSession` throw, as it always has. A restarted worker that cannot be made fails the
  // session instead (`status().error`): nothing would catch a throw then.
  let made = 0;
  let firstError: { error: unknown } | null = null;
  const createWorker = (): WorkerLike => {
    made += 1;
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, { type: "module" });
    } catch (error) {
      if (made === 1) firstError = { error };
      throw error;
    }
    const like: WorkerLike = {
      postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
      terminate: () => worker.terminate(),
      onmessage: null,
      onerror: null,
    };
    worker.onmessage = (event) => input(() => like.onmessage?.(event));
    worker.onerror = (event) => input(() => like.onerror?.(event));
    return like;
  };

  const loadRequest: LoadRequest = {
    kind: "load",
    releaseUrl: options.releaseFiles ? String(options.releaseUrl) : new URL(options.releaseUrl, location.href).href,
    ...(options.releaseFiles ? { files: options.releaseFiles } : {}),
    ...(options.wasmPaths !== undefined ? { wasmPaths: options.wasmPaths } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
    ...(options.geometricUrl !== undefined ? { geometricUrl: new URL(options.geometricUrl, location.href).href } : {}),
    ...(options.geometricManifestSha256 !== undefined ? { geometricManifestSha256: options.geometricManifestSha256 } : {}),
    ...(options.geometricWatchdog === false ? { geometricWatchdog: false } : {}),
  };

  // The video's events, before the worker session that `capture` and `mediaTimeNow` serve. Its
  // sink fires only on later events, once `core` exists.
  const watch: VideoWatch | null = video
    ? watchVideo(video, {
        presented: (time) => input(() => core.presented(time)),
        discontinuity: (newSource) =>
          input(() => {
            cutReference.reset();
            core.discontinuity(newSource);
          }, true),
      })
    : null;
  const mediaTime = (): number => watch?.mediaTime() ?? 0;

  const workers = createWorkerSession({
    createWorker,
    loadRequest,
    now,
    ...(options.mode ? { mode: options.mode } : {}),
    capture,
    // The max-age rule, the staleness rule and a look's date read the video's time when they
    // run, as 0.5 did: a paused video reports no frame, and its time is still known.
    mediaTimeNow: () => mediaTime(),
    onShown: changedNow,
    onStatus: changedNow,
    onAnalysis,
  });
  if (firstError) {
    watch?.detach();
    workers.stop();
    throw (firstError as { error: unknown }).error;
  }
  // Without `chooseRelease` the core is made at once.
  const core: SessionCore = workers.core!;

  // ------------------------------------------------------------------- the picture
  /** The card at these viewport coordinates, with the picture's box it was found in. */
  const hitAt = (clientX: number, clientY: number): { hit: CoreShown; picture: ClientBox } | null => {
    const picture = pictureBox(source.getBoundingClientRect(), sourceSize(source), getComputedStyle(source).objectFit);
    if (picture.width <= 0 || picture.height <= 0) return null;
    const hit = core.hitAt((clientX - picture.left) / picture.width, (clientY - picture.top) / picture.height);
    return hit ? { hit, picture } : null;
  };

  const at = (clientX: number, clientY: number): Shown | null => {
    const found = hitAt(clientX, clientY);
    if (!found) return null;
    const { hit, picture } = found;
    return {
      name: hit.name,
      cardId: hit.cardId,
      box: {
        left: picture.left + hit.box.x * picture.width,
        top: picture.top + hit.box.y * picture.height,
        width: hit.box.width * picture.width,
        height: hit.box.height * picture.height,
      },
      frameBox: hit.frameBox,
    };
  };
  let pointer: { x: number; y: number } | null = null;
  const atPointer = (): Shown | null => (pointer ? at(pointer.x, pointer.y) : null);

  /** A live signature sample, compared with the reference over the box of the shown card. */
  const sampleForCut = (sampledAt: number): void => {
    const bounds = pointer ? hitAt(pointer.x, pointer.y)?.hit.box ?? null : null;
    if (!bounds) {
      sampler?.release(liveTicket);
      liveTicket = null;
      return;
    }
    if (!sampler) sampler = createSignatureSampler();
    if (!sampler?.usable) return;
    if (liveTicket) {
      const live = sampler.read(liveTicket);
      if (live) {
        liveTicket = null;
        if (cutReference.observe(live, bounds).cut) {
          cutReference.reset();
          core.cut();
          changed = true;
          return;
        }
      }
    }
    if (!liveTicket && sampledAt - lastSampleAt >= CUT_SAMPLE_MIN_INTERVAL_MS) {
      lastSampleAt = sampledAt;
      liveTicket = sampler.sample(source);
    }
  };

  // ------------------------------------------------------------------- the element

  let frameCallback: number | null = null;
  const onVideoFrame = (): void => {
    if (!live || !video) return;
    input(() => {
      core.presented(mediaTime());
      sampleForCut(now());
    });
    frameCallback = video.requestVideoFrameCallback(onVideoFrame);
  };
  const onImageLoad = (): void =>
    input(() => {
      cutReference.reset();
      core.discontinuity(true);
    }, true);

  const onPointerMove = (event: PointerEvent): void =>
    input(() => {
      pointer = { x: event.clientX, y: event.clientY };
      const picture = pictureBox(source.getBoundingClientRect(), sourceSize(source), getComputedStyle(source).objectFit);
      // Over a bar beside the picture the pointer still counts as activity, outside [0, 1].
      const f = fractionIn(picture, event.clientX, event.clientY) ?? {
        x: (event.clientX - picture.left) / picture.width,
        y: (event.clientY - picture.top) / picture.height,
      };
      core.pointer(f.x, f.y, mediaTime(), event.pointerType === "touch");
    }, true);
  const onPointerLeave = (): void =>
    input(() => {
      pointer = null;
      core.pointerLeft();
    }, true);

  if (video && "requestVideoFrameCallback" in video) frameCallback = video.requestVideoFrameCallback(onVideoFrame);
  if (!video) source.addEventListener("load", onImageLoad);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerdown", onPointerMove);
  element.addEventListener("pointerleave", onPointerLeave);

  const driver = setInterval(() => input(() => workers.tick()), DRIVER_TICK_MS);
  live = true;

  return {
    status: () => core.status(),
    at,
    atPointer,
    analysis: () => core.analysis(),
    cards: () => core.cards(),
    stop: () => {
      if (!live) return;
      live = false;
      clearInterval(driver);
      if (frameCallback !== null && video && "cancelVideoFrameCallback" in video) video.cancelVideoFrameCallback(frameCallback);
      frameCallback = null;
      watch?.detach();
      source.removeEventListener("load", onImageLoad);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerdown", onPointerMove);
      element.removeEventListener("pointerleave", onPointerLeave);
      sampler?.release(lookTicket);
      sampler?.release(liveTicket);
      sampler?.dispose();
      cutReference.reset();
      workers.stop();
    },
  };
}
