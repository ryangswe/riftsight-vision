// SPDX-License-Identifier: Apache-2.0
// A session: recognition running on one <video> or image element of the page.
//
// The session owns everything that touches the page: it listens to the element and to the
// pointer over it, decides when a frame is analyzed (frame-scheduler.ts), captures that frame
// (capture.ts), hands it to the analysis worker (worker.ts), and keeps the newest result that
// still describes the picture on screen. Asked about a pointer position, it answers from that
// result: the card that would be shown there, or nothing.
//
// It draws nothing. Whoever creates the session decides how a box and a name are displayed.
//
// What is never shown:
//   - a result from before a seek, a new file or a cut (`replyRejection`);
//   - a result whose frame is further from the picture on screen, in video time, than the
//     release's `hover.maxAgeMs`;
//   - anything for a box that was detected and not accepted.

import { type AABB } from "./boxes.js";
import { type AnalysisMode, analyzeIntervalMs, cadenceMs } from "./cadence.js";
import {
  type AnalysisWidth,
  captureFrame,
  createSignatureSampler,
  CUT_SAMPLE_MIN_INTERVAL_MS,
  CutReference,
  type FrameSource,
  type SignatureSampler,
  type SignatureTicket,
  sourceSize,
  sourceTimeSec,
} from "./capture.js";
import {
  ANALYSIS_WATCHDOG_MS,
  type AnalysisState,
  DRIVER_TICK_MS,
  FrameScheduler,
  HOVER_MAX_AGE_MS,
  rejectionAnswersInFlight,
  replyRejection,
} from "./frame-scheduler.js";
import type { NormalizedBounds } from "./hover-geometry.js";
import { BUSY_ERROR, type FrameResult, type GeometricStatus, type ReleaseProgress, type ReleaseStatus, type WorkerReply, type WorkerRequest } from "./messages.js";
import { type FrameAnalysis, hoverAt } from "./pipeline.js";
import type { ExecutionProvider } from "./providers.js";
import { CONFIRM_FRAMES } from "./temporal-gate.js";

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
  mode?: AnalysisMode;
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

/** A rectangle in CSS pixels of the viewport, like `getBoundingClientRect`. */
export interface ClientBox {
  left: number;
  top: number;
  width: number;
  height: number;
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

/**
 * Where the picture sits inside an element's box, for the element's `object-fit`. A video is
 * fitted inside its box by default, leaving bars; an image fills its box by default.
 */
export function pictureBox(element: ClientBox, picture: { width: number; height: number }, fit: string): ClientBox {
  // Field by field: a DOMRect's fields are not its own properties, so spreading one copies nothing.
  const whole = { left: element.left, top: element.top, width: element.width, height: element.height };
  if (picture.width <= 0 || picture.height <= 0 || fit === "fill") return whole;
  const scaleX = element.width / picture.width;
  const scaleY = element.height / picture.height;
  let scale: number;
  if (fit === "cover") scale = Math.max(scaleX, scaleY);
  else if (fit === "none") scale = 1;
  else if (fit === "scale-down") scale = Math.min(1, scaleX, scaleY);
  else scale = Math.min(scaleX, scaleY);
  const width = picture.width * scale;
  const height = picture.height * scale;
  return { left: element.left + (element.width - width) / 2, top: element.top + (element.height - height) / 2, width, height };
}

/** Whether a result whose frame was taken at `resultSec` may still be shown against a picture
 *  at `nowSec`: their distance in video time is at most `maxAgeMs`. */
export function withinMaxAge(resultSec: number, nowSec: number, maxAgeMs: number): boolean {
  return Math.abs(nowSec - resultSec) * 1000 <= maxAgeMs;
}

interface ShownResult {
  analysis: FrameAnalysis;
  videoTimeSec: number;
}

/** How many times a worker that stops after the release has loaded is started again. */
export const WORKER_RESTARTS = 1;

/** The same load request without the geometric stage: what a restarted worker loads. */
export function withoutGeometric(request: WorkerRequest): WorkerRequest {
  if (request.kind !== "load") return request;
  const { geometricUrl: _url, geometricManifestSha256: _sha, geometricWatchdog: _watchdog, ...plain } = request;
  return plain;
}

/** What `status().loading` becomes on a release-progress reply: the reply's phase while the
 *  release loads; `undefined` (no change) once it has loaded or failed, or the session has
 *  stopped, so a reply that arrives late changes nothing. */
export function progressUpdate(state: SessionStatus["state"], reply: ReleaseProgress): SessionStatus["loading"] | undefined {
  return state === "loading" ? { phase: reply.phase, bytes: reply.bytes } : undefined;
}

/**
 * Start a session on an element. The release loads in the background (`status().state`); until
 * then, and whenever nothing can be said, `at` returns null.
 */
export function createSession(source: FrameSource, options: SessionOptions): Session {
  const mode: AnalysisMode = options.mode ?? "pointer";
  const scheduler = new FrameScheduler(cadenceMs(null, mode), CONFIRM_FRAMES, mode, analyzeIntervalMs(null));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const isVideo = source instanceof HTMLVideoElement;
  const workerUrl = options.workerUrl ?? new URL("./worker.js", import.meta.url);
  let worker: Worker;
  let restarts = 0;
  const notify = (): void => options.onUpdate?.();

  const status: SessionStatus = {
    state: "loading", error: null, release: null, backend: null, schedule: "idle", frames: 0,
    lastWorkerMs: null, lastRoundTripMs: null, lastFrameError: null,
    geometric: options.geometricUrl !== undefined ? { state: "loading", reason: null, bytes: null } : null,
    loading: null,
  };
  let cards: ReleaseStatus["cards"] = [];
  let maxAgeMs = HOVER_MAX_AGE_MS;
  let analysisWidth: AnalysisWidth | undefined;

  // What a reply is judged against.
  let nextRequestId = 1;
  let inFlight: { requestId: number; sentAt: number; ticket: SignatureTicket | null } | null = null;
  let lastAcceptedRequestId = 0;
  let generation = 0;
  let sourceCount = 0;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  let result: ShownResult | null = null;
  let pointer: { x: number; y: number } | null = null;

  // Cut detection: only while a tooltip shows over a video.
  let sampler: SignatureSampler | null = null;
  const cutReference = new CutReference();
  let liveTicket: SignatureTicket | null = null;
  let lastSampleAt = -Infinity;

  const clearResult = (): void => {
    result = null;
    cutReference.reset();
  };

  /** A seek, a new file or a cut: results from before it describe a picture that is gone. */
  const breakContinuity = (newSource: boolean): void => {
    generation += 1;
    if (newSource) sourceCount += 1;
    scheduler.discontinuity();
    clearResult();
    notify();
  };

  const currentResult = (): ShownResult | null => {
    if (!result) return null;
    return withinMaxAge(result.videoTimeSec, sourceTimeSec(source), maxAgeMs) ? result : null;
  };

  const at = (clientX: number, clientY: number): Shown | null => {
    const current = currentResult();
    if (!current) return null;
    const picture = pictureBox(source.getBoundingClientRect(), sourceSize(source), getComputedStyle(source).objectFit);
    if (picture.width <= 0 || picture.height <= 0) return null;
    const frame = current.analysis.frame;
    const x = ((clientX - picture.left) / picture.width) * frame.width;
    const y = ((clientY - picture.top) / picture.height) * frame.height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const hit = hoverAt(current.analysis, x, y);
    if (!hit.box || hit.cardId === null || hit.name === null) return null;
    return {
      name: hit.name,
      cardId: hit.cardId,
      box: {
        left: picture.left + (hit.box.x / frame.width) * picture.width,
        top: picture.top + (hit.box.y / frame.height) * picture.height,
        width: (hit.box.width / frame.width) * picture.width,
        height: (hit.box.height / frame.height) * picture.height,
      },
      frameBox: hit.box,
    };
  };
  const atPointer = (): Shown | null => (pointer ? at(pointer.x, pointer.y) : null);

  /** The box under the pointer in fractions of the frame, when something is shown there. */
  const shownBounds = (): NormalizedBounds | null => {
    const shown = atPointer();
    const frame = result?.analysis.frame;
    if (!shown || !frame) return null;
    const b = shown.frameBox;
    return { x: b.x / frame.width, y: b.y / frame.height, width: b.width / frame.width, height: b.height / frame.height };
  };

  const analyze = async (trigger?: "hover"): Promise<void> => {
    if (status.state !== "ready" || inFlight || !ctx) return;
    const size = sourceSize(source);
    if (size.width === 0 || size.height === 0) return;
    const now = performance.now();
    const requestId = nextRequestId++;
    // Claimed before the first await, so that a second call cannot start beside this one.
    inFlight = { requestId, sentAt: now, ticket: sampler?.usable ? sampler.sample(source) : null };
    const cut = scheduler.lookPending;
    scheduler.started(now, { videoTimeSec: sourceTimeSec(source), ...(trigger ? { trigger } : cut ? { trigger: "cut" as const } : {}) });
    const envelope = { requestId, mediaTimeSec: sourceTimeSec(source), generation, videoKey: `source-${sourceCount}` };
    try {
      const frame = await captureFrame(source, canvas, ctx, analysisWidth);
      const request: WorkerRequest = { kind: "frame", bitmap: frame.bitmap, videoTimeSec: frame.videoTimeSec, envelope };
      worker.postMessage(request, [frame.bitmap]);
    } catch (error) {
      // The picture cannot be read (a file from another origin without permission).
      sampler?.release(inFlight?.ticket ?? null);
      inFlight = null;
      scheduler.lookUnanswered(performance.now());
      status.lastFrameError = `capture-failed: ${String(error)}`;
      notify();
      return;
    }
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (inFlight?.requestId !== requestId) return;
      // No reply: give up on this request so that the next frame can go. A late reply is
      // recognized by its request number and dropped.
      sampler?.release(inFlight.ticket);
      inFlight = null;
      scheduler.lookUnanswered(performance.now());
      status.lastFrameError = "no reply";
      notify();
    }, ANALYSIS_WATCHDOG_MS);
  };

  const onFrameResult = (reply: FrameResult): void => {
    const rejection = replyRejection(reply.envelope, {
      inFlightRequestId: inFlight?.requestId ?? null,
      lastAcceptedRequestId,
      generation,
      videoKey: `source-${sourceCount}`,
    });
    if (rejection !== null && !rejectionAnswersInFlight(rejection)) return;
    const sent = inFlight;
    inFlight = null;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    if (rejection !== null || !sent) {
      sampler?.release(sent?.ticket ?? null);
      return;
    }
    lastAcceptedRequestId = reply.envelope.requestId;
    status.lastWorkerMs = reply.workerMs;
    status.lastRoundTripMs = +(performance.now() - sent.sentAt).toFixed(2);
    status.lastFrameError = reply.error ?? null;
    if (!reply.analysis) {
      sampler?.release(sent.ticket);
      clearResult();
      if (reply.error === BUSY_ERROR) scheduler.lookUnanswered(performance.now());
    } else {
      scheduler.lookAnswered();
      status.frames += 1;
      result = { analysis: reply.analysis, videoTimeSec: reply.videoTimeSec };
      // The analyzed frame's own signature becomes the reference a cut is measured from.
      const signature = sent.ticket && sampler ? sampler.read(sent.ticket) : null;
      if (signature) cutReference.seed(signature);
      else {
        sampler?.release(sent.ticket);
        cutReference.reset();
      }
    }
    scheduler.setTooltipShowing(atPointer() !== null, performance.now());
    notify();
  };

  const onWorkerMessage = (reply: WorkerReply): void => {
    if (reply.kind === "frame-result") {
      onFrameResult(reply);
    } else if (reply.kind === "release-progress") {
      const loading = progressUpdate(status.state, reply);
      if (loading === undefined) return;
      status.loading = loading;
      notify();
    } else if (reply.kind === "release-status") {
      if (status.state !== "loading") return;
      status.loading = null;
      status.state = reply.ok ? "ready" : "failed";
      status.error = reply.error;
      status.release = reply.release;
      cards = reply.cards;
      if (reply.release) {
        status.backend = reply.release.recognizer.ep;
        maxAgeMs = reply.release.hoverMaxAgeMs;
        analysisWidth = reply.release.analysisWidth;
        scheduler.setIntervalMs(cadenceMs(status.backend, mode));
        scheduler.setReadingIntervalMs(analyzeIntervalMs(status.backend));
        scheduler.framePresented();
      }
      notify();
    } else if (reply.kind === "geometric-status") {
      status.geometric = { state: reply.state, reason: reply.reason, bytes: reply.bytes };
      notify();
    }
  };

  /** The worker stopped with an error. Before the release has loaded the session fails, as a
   *  release that does not load would. After it has loaded, the worker is restarted once on the
   *  same release without the geometric stage; a second stop ends recognition ("failed"). */
  const onWorkerError = (message: string): void => {
    if (status.state === "stopped" || status.state === "failed") return;
    worker.terminate();
    if (inFlight) sampler?.release(inFlight.ticket);
    inFlight = null;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    clearResult();
    status.loading = null;
    if (status.state === "loading" && restarts === 0) {
      status.state = "failed";
      status.error = `the worker did not start (${message})`;
    } else if (restarts < WORKER_RESTARTS) {
      restarts += 1;
      status.state = "loading";
      status.error = null;
      if (status.geometric) status.geometric = { state: "off", reason: "worker-restarted", bytes: null };
      startWorker(plainLoad);
    } else {
      status.state = "failed";
      status.error = `the recognition worker stopped (${message})`;
    }
    notify();
  };

  const startWorker = (request: WorkerRequest): void => {
    const started = new Worker(workerUrl, { type: "module" });
    worker = started;
    // A worker that was replaced may still deliver a message or an error: it is ignored.
    started.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (started === worker) onWorkerMessage(event.data);
    };
    started.onerror = (event) => {
      if (started === worker) onWorkerError(event.message || "see the console");
    };
    started.postMessage(request);
  };

  const load: WorkerRequest = {
    kind: "load",
    releaseUrl: options.releaseFiles ? String(options.releaseUrl) : new URL(options.releaseUrl, location.href).href,
    ...(options.releaseFiles ? { files: options.releaseFiles } : {}),
    ...(options.wasmPaths !== undefined ? { wasmPaths: options.wasmPaths } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
    ...(options.geometricUrl !== undefined ? { geometricUrl: new URL(options.geometricUrl, location.href).href } : {}),
    ...(options.geometricManifestSha256 !== undefined ? { geometricManifestSha256: options.geometricManifestSha256 } : {}),
    ...(options.geometricWatchdog === false ? { geometricWatchdog: false } : {}),
  };
  const plainLoad = withoutGeometric(load);
  startWorker(load);

  // ------------------------------------------------------------------------- the element
  /** A live signature sample, compared with the reference over the box of the shown card. */
  const sampleForCut = (now: number): void => {
    if (!isVideo) return;
    const bounds = shownBounds();
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
          generation += 1;
          clearResult();
          scheduler.requestLook();
          notify();
          return;
        }
      }
    }
    if (!liveTicket && now - lastSampleAt >= CUT_SAMPLE_MIN_INTERVAL_MS) {
      lastSampleAt = now;
      liveTicket = sampler.sample(source);
    }
  };

  let frameCallback: number | null = null;
  const onPresented = (): void => {
    scheduler.framePresented();
    sampleForCut(performance.now());
    if (isVideo && "requestVideoFrameCallback" in source) frameCallback = source.requestVideoFrameCallback(onPresented);
  };
  const onDiscontinuity = (): void => breakContinuity(false);
  const onNewSource = (): void => {
    breakContinuity(true);
    scheduler.framePresented();
  };
  const onTimeUpdate = (): void => scheduler.framePresented();

  const onPointerMove = (event: PointerEvent): void => {
    pointer = { x: event.clientX, y: event.clientY };
    const now = performance.now();
    if (event.pointerType === "touch") scheduler.tapped(now);
    else scheduler.pointerMoved(now);
    if (scheduler.hoverTriggerDue(now, sourceTimeSec(source), inFlight !== null)) void analyze("hover");
    notify();
  };
  const onPointerLeave = (): void => {
    pointer = null;
    scheduler.pointerLeft(performance.now());
    notify();
  };

  if (isVideo) {
    source.addEventListener("seeking", onDiscontinuity);
    source.addEventListener("emptied", onNewSource);
    source.addEventListener("loadeddata", onNewSource);
    if ("requestVideoFrameCallback" in source) frameCallback = source.requestVideoFrameCallback(onPresented);
    else (source as HTMLVideoElement).addEventListener("timeupdate", onTimeUpdate);
    source.addEventListener("seeked", onTimeUpdate);
  } else {
    source.addEventListener("load", onNewSource);
  }
  const element: HTMLElement = source;
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerdown", onPointerMove);
  element.addEventListener("pointerleave", onPointerLeave);

  const tick = setInterval(() => {
    const now = performance.now();
    scheduler.setTooltipShowing(atPointer() !== null, now);
    const state = scheduler.analysisState(now);
    if (state !== status.schedule) {
      status.schedule = state;
      notify();
    }
    if (!inFlight && scheduler.due(now)) void analyze();
  }, DRIVER_TICK_MS);

  return {
    status: () => ({ ...status }),
    at,
    atPointer,
    analysis: () => currentResult()?.analysis ?? null,
    cards: () => cards,
    stop: () => {
      status.state = "stopped";
      status.loading = null;
      clearInterval(tick);
      if (watchdog) clearTimeout(watchdog);
      if (frameCallback !== null && isVideo && "cancelVideoFrameCallback" in source) source.cancelVideoFrameCallback(frameCallback);
      source.removeEventListener("seeking", onDiscontinuity);
      source.removeEventListener("emptied", onNewSource);
      source.removeEventListener("loadeddata", onNewSource);
      source.removeEventListener("timeupdate", onTimeUpdate);
      source.removeEventListener("seeked", onTimeUpdate);
      source.removeEventListener("load", onNewSource);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerdown", onPointerMove);
      element.removeEventListener("pointerleave", onPointerLeave);
      sampler?.dispose();
      worker.terminate();
      clearResult();
    },
  };
}
