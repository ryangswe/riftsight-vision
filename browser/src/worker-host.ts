// SPDX-License-Identifier: Apache-2.0
// What the analysis worker does with each request, apart from the worker's globals so that it
// can be tested: worker.ts gives it the real loaders and `postMessage`.
//
// The worker loads one release when told to, then answers each frame it is sent with what the
// pipeline found. The geometric stage loads after the release, while frames are already
// analyzed without it, and joins between two frames. It stays off where WebGPU is missing and
// when any part fails to load; it is turned off for the rest of the session when it fails
// during a frame (that frame is answered without it), when its GPU device is lost, and when the
// watchdog trips.

import { type GeometricStage, GeometricWatchdog } from "./geometric/stage.js";
import type { LoadedRelease, LoadOptions } from "./load.js";
import { ReleaseError } from "./load.js";
import { BUSY_ERROR, type FrameEnvelope, type FrameResult, type GeometricStatus, type ReleaseStatus, type WorkerReply, type WorkerRequest } from "./messages.js";
import type { FrameAnalysis } from "./pipeline.js";

/** The pixels of a frame, as the pipeline takes them. */
export interface FramePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A WebGPU device, as far as the worker uses it: to learn of its loss. */
export interface VoteDevice {
  readonly lost: Promise<{ reason: string; message: string }>;
}

export interface WorkerHostDeps<D extends VoteDevice = GPUDevice> {
  post(reply: WorkerReply): void;
  loadRelease(url: string, options: LoadOptions): Promise<LoadedRelease>;
  /** The folder of ONNX Runtime's `.wasm` files when the request does not say. */
  wasmPaths: string;
  /** A WebGPU device for the vote, or null when this browser has none. */
  voteDevice(): Promise<D | null>;
  /** Open the stage on `device`. The stage owns the device: disposing of it frees both. */
  openStage(
    loaded: LoadedRelease,
    settingsUrl: string,
    device: D,
    manifestSha256: string | undefined,
  ): Promise<{ stage: GeometricStage; bytes: number; note: string | null }>;
  /** Free a device the stage never took (its load failed). */
  releaseDevice(device: D): void;
  /** The frame's pixels, or null when they cannot be read. */
  readBitmap(bitmap: ImageBitmap): FramePixels | null;
  now?: () => number;
  watchdog?: GeometricWatchdog;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The request handler of one worker. */
export function createWorkerHost<D extends VoteDevice>(deps: WorkerHostDeps<D>): { handle(request: WorkerRequest): Promise<void> } {
  const now = deps.now ?? (() => performance.now());
  const watchdog = deps.watchdog ?? new GeometricWatchdog();
  let loaded: LoadedRelease | null = null;
  let loadStarted = false;
  /** True while a frame is being analyzed. A session keeps one frame in flight, but after giving
   *  up on a slow one it may send the next; that frame is answered at once with an error, so
   *  that two analyses never interleave in the pipeline's state. */
  let busy = false;
  /** A geometric stage that has loaded and waits for the end of the frame in flight. */
  let pendingStage: GeometricStage | null = null;
  /** Once off for the session, the stage never comes back. */
  let geometricOff = false;
  /** Whether the watchdog may turn the stage off (the load request's `geometricWatchdog`). */
  let watchdogOn = true;

  function geometricStatus(state: GeometricStatus["state"], reason: string | null = null, bytes: number | null = null, note: string | null = null): void {
    deps.post({ kind: "geometric-status", state, reason, bytes, ...(note !== null ? { note } : {}) });
  }

  /** Set a loaded stage on the pipeline now if no frame is in flight, else after it; remove it
   *  for good once the stage is off. */
  function settleStage(): void {
    if (busy || !loaded) return;
    if (geometricOff) {
      const current = loaded.pipeline.geometricStage;
      if (current) {
        loaded.pipeline.setGeometric(null);
        current.dispose();
      }
      pendingStage?.dispose();
      pendingStage = null;
      return;
    }
    if (pendingStage === null) return;
    loaded.pipeline.setGeometric(pendingStage);
    pendingStage = null;
  }

  /** Turn the stage off for the rest of the session, once. */
  function turnOff(reason: string): void {
    if (geometricOff) return;
    geometricOff = true;
    settleStage();
    geometricStatus("off", reason);
  }

  async function loadStage(result: LoadedRelease, url: string, manifestSha256: string | undefined, debug = false): Promise<void> {
    geometricStatus("loading");
    let device: D | null = null;
    let owned = false;
    try {
      device = await deps.voteDevice();
      if (device === null) {
        geometricOff = true;
        geometricStatus("off", "no-webgpu");
        return;
      }
      void device.lost.then((info) => {
        // A device destroyed on purpose (the stage disposed of) is not a loss.
        if (info.reason !== "destroyed") turnOff(`device-lost: ${info.message || info.reason}`);
      });
      const { stage, bytes, note } = await deps.openStage(result, url, device, manifestSha256);
      owned = true;
      if (geometricOff) {
        stage.dispose();
        return;
      }
      // The debug record (geometric/debug.ts) is a scoring run's; it decides nothing.
      stage.debug = debug;
      pendingStage = stage;
      settleStage();
      geometricStatus("ready", null, bytes, note);
    } catch (error) {
      if (device !== null && !owned) deps.releaseDevice(device);
      if (!geometricOff) {
        geometricOff = true;
        geometricStatus("off", `load-failed: ${message(error)}`);
      }
    }
  }

  /** After each analyzed frame: a stage that failed during it is off for the session; the
   *  watchdog turns it off when its share of a frame is too long twice in a row. */
  function watch(analysis: FrameAnalysis): void {
    if (!loaded) return;
    const failure = loaded.pipeline.takeGeometricFailure();
    if (failure) {
      failure.stage.dispose();
      turnOff(`runtime: ${message(failure.error)}`);
      return;
    }
    const ms = analysis.timings.geometricMs;
    if (ms === undefined || !watchdogOn) return;
    if (watchdog.observe(ms)) {
      turnOff(`watchdog: the stage took over ${watchdog.limitMs} ms of a frame on ${watchdog.frames} frames in a row`);
    }
  }

  function failed(error: string): ReleaseStatus {
    return { kind: "release-status", ok: false, error, release: null, cards: [] };
  }

  function load(request: Extract<WorkerRequest, { kind: "load" }>): Promise<void> {
    if (loadStarted) return Promise.resolve();
    loadStarted = true;
    watchdogOn = request.geometricWatchdog !== false;
    const wasmPaths = request.wasmPaths ?? deps.wasmPaths;
    return deps
      .loadRelease(request.releaseUrl, {
        wasmPaths,
        ...(request.providers ? { providers: request.providers } : {}),
        ...(request.files ? { files: request.files } : {}),
        onProgress: (progress) => deps.post({ kind: "release-progress", phase: progress.phase, bytes: progress.phase === "downloading" ? progress.bytes : null }),
      })
      .then(async (result) => {
        loaded = result;
        const r = result.release;
        deps.post({
          kind: "release-status",
          ok: true,
          error: null,
          release: {
            id: r.id,
            game: r.game,
            locale: r.locale,
            detector: { version: r.detector.version, ep: result.backend.detector },
            recognizer: { version: r.recognizer.version, ep: result.backend.recognizer },
            bankCards: r.bank.cardCount,
            catalogCards: r.catalog.cardCount,
            identityLevel: r.identity.level,
            decode: { ...r.detector.settings.decode, minCropPx: r.detector.settings.minCropPx },
            accept: { ...r.accept },
            hoverSelection: r.hover.selection,
            hoverMaxAgeMs: r.hover.maxAgeMs,
            analysisWidth: r.runtime.analysisWidth,
            ortWeb: r.runtime.ortWeb,
            ...(result.timings ? { loadTimings: result.timings } : {}),
          },
          cards: result.cards,
        });
        if (request.geometricUrl !== undefined) await loadStage(result, request.geometricUrl, request.geometricManifestSha256, request.geometricDebug === true);
      })
      .catch((error: unknown) => {
        if (loaded) return;
        deps.post(failed(error instanceof ReleaseError ? error.reason : `unexpected error while loading (${String(error)})`));
      });
  }

  function frameResult(
    analysis: FrameAnalysis | null,
    meta: { envelope: FrameEnvelope; error?: string; videoTimeSec: number; width: number; height: number; t0: number },
  ): FrameResult {
    const { envelope, error, videoTimeSec, width, height, t0 } = meta;
    return {
      kind: "frame-result",
      envelope,
      ...(error !== undefined ? { error } : {}),
      videoTimeSec,
      width,
      height,
      workerMs: +(now() - t0).toFixed(2),
      analysis,
    };
  }

  async function frame(request: Extract<WorkerRequest, { kind: "frame" }>): Promise<void> {
    const { bitmap, videoTimeSec, envelope } = request;
    const t0 = now();
    const { width, height } = bitmap;
    // Every frame gets an answer: the session waits for one before it sends the next.
    const fail = (error: string): void => deps.post(frameResult(null, { envelope, error, videoTimeSec, width, height, t0 }));
    if (busy) {
      bitmap.close();
      fail(BUSY_ERROR);
      return;
    }
    busy = true;
    try {
      if (!loaded) {
        fail("no-release");
        return;
      }
      const image = deps.readBitmap(bitmap);
      if (!image) {
        fail("no-2d-context");
        return;
      }
      const analysis = await loaded.pipeline.analyze({ data: image.data, width: image.width, height: image.height }, videoTimeSec);
      watch(analysis);
      deps.post(frameResult(analysis, { envelope, videoTimeSec, width: image.width, height: image.height, t0 }));
    } catch (error) {
      fail(`analysis-failed: ${String(error)}`);
    } finally {
      bitmap.close();
      busy = false;
      settleStage();
    }
  }

  return {
    async handle(request: WorkerRequest): Promise<void> {
      if (request.kind === "ping") deps.post({ kind: "pong" });
      else if (request.kind === "load") await load(request);
      else if (request.kind === "frame") await frame(request);
    },
  };
}
