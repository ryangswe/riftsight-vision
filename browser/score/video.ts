// SPDX-License-Identifier: Apache-2.0
// The page side of a scoring run: a <video> element read frame by frame, and the analysis
// worker asked about the frame on screen.
//
// Reading a frame. The video stays paused. To show the frame on screen at a time, the element
// is sought to that time and the page waits for the browser to present the frame. Where the
// browser has `requestVideoFrameCallback`, the callback's `mediaTime` is, in some browsers, the
// frame's own time in the video. In others it is the time that was asked for. Which it is, is
// found out once for each file (`reportsFrameTimes` of select.ts); without the callback, and
// where it only repeats the time asked for, the page knows that time and no more. The frame
// is then drawn into a canvas at the video's own size and fingerprinted (dhash.ts).
//
// A hidden page. A browser may present no video frame to a page that is not visible. So no
// frame is read while the page is hidden: the read waits until the page is visible again, and
// a read that failed while the page was hidden is made again. A run is paused by this and
// loses no row. A headless browser's page counts as visible.
//
// Analyzing a frame. The frame on screen goes the way every frame of a session goes
// (src/session.ts): `captureFrame` draws it at analysis size and makes a bitmap of it, and
// the analysis worker (src/worker.ts) answers with what the pipeline found. Nothing is
// scheduled and no pointer is involved: one frame in, one answer out.

import { captureFrame } from "../src/capture.js";
import type { FrameResult, GeometricStatus, ReleaseStatus, WorkerReply, WorkerRequest } from "../src/messages.js";
import type { FrameAnalysis } from "../src/pipeline.js";
import type { ExecutionProvider } from "../src/providers.js";
import { dhash } from "./dhash.js";
import type { ScoringVideo } from "./run.js";
import { type DecodedFrame, reportsFrameTimes } from "./select.js";

/** How long the page waits for a seek to finish, and then for the frame to be presented. */
const SEEK_TIMEOUT_MS = 15_000;
const PRESENT_TIMEOUT_MS = 3_000;
/** Two times this close are the same time to the browser, which keeps them to the microsecond. */
const SAME_TIME_SEC = 2e-6;
/** How long the worker may take over one frame. */
const ANALYSIS_TIMEOUT_MS = 60_000;

/** The analysis worker with one release loaded: frames in, analyses out, one at a time. */
export interface Analyzer {
  /** The release in effect, with the backend each model runs on. */
  readonly release: NonNullable<ReleaseStatus["release"]>;
  /** Capture the element's current picture and analyze it. */
  analyze(video: HTMLVideoElement): Promise<FrameAnalysis>;
  /** Analyze a picture at its own size, with no resize: its width must lie in the release's
   *  analysis range. The bitmap is handed to the worker, which closes it. */
  analyzeBitmap(bitmap: ImageBitmap, timeSec: number): Promise<FrameAnalysis>;
  /** The geometric stage's state as the worker last reported it; null when none was asked for. */
  geometric(): Omit<GeometricStatus, "kind"> | null;
  /** Resolves once the geometric stage is ready or off (at once without one asked for). */
  geometricSettled(): Promise<Omit<GeometricStatus, "kind"> | null>;
  stop(): void;
}

export interface AnalyzerOptions {
  releaseUrl: string | URL;
  workerUrl: string | URL;
  /** The execution providers to try, in order, in place of the release's own list. */
  providers?: ExecutionProvider[];
  /** The geometric stage's settings document, when the run is to use the stage. */
  geometricUrl?: string | URL;
  /** Ask the stage for its debug record of every crop (src/geometric/debug.ts). */
  geometricDebug?: boolean;
  /** The SHA-256 the packed index's manifest.json must have (a manifest with other bytes is
   *  refused and the stage is off). */
  geometricManifestSha256?: string;
  /** False turns the geometric watchdog off (default: on), so that a scoring run analyzes every
   *  frame with the stage; the run's header should record it. */
  geometricWatchdog?: boolean;
}

/** Start the worker and load a release. Rejects with the reason when the release does not load. */
export function createAnalyzer(options: AnalyzerOptions): Promise<Analyzer> {
  const worker = new Worker(options.workerUrl, { type: "module" });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  let nextRequestId = 1;
  const waiting = new Map<number, (reply: FrameResult) => void>();
  let geometric: Omit<GeometricStatus, "kind"> | null = options.geometricUrl !== undefined ? { state: "loading", reason: null, bytes: null } : null;
  const settledWaiters: Array<() => void> = [];
  /** Why the worker turned the tilted retry off, once it has. A scoring run never continues
   *  without it: the frame it failed on, and every later one, is refused. */
  let tiltedOff: string | null = null;

  return new Promise<Analyzer>((resolve, reject) => {
    worker.onerror = (event) => reject(new Error(`the worker did not start (${event.message || "see the console"})`));
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.kind === "frame-result") {
        waiting.get(reply.envelope.requestId)?.(reply);
        waiting.delete(reply.envelope.requestId);
        return;
      }
      if (reply.kind === "tilted-status") {
        tiltedOff = reply.reason;
        return;
      }
      if (reply.kind === "geometric-status") {
        geometric = { state: reply.state, reason: reply.reason, bytes: reply.bytes };
        if (reply.state !== "loading") settledWaiters.splice(0).forEach((done) => done());
        return;
      }
      if (reply.kind !== "release-status") return;
      if (!reply.ok || !reply.release) {
        worker.terminate();
        reject(new Error(`the release could not be loaded: ${reply.error ?? "no reason given"}`));
        return;
      }
      const analysisWidth = reply.release.analysisWidth;
      /** Send one bitmap to the worker and wait for its analysis. */
      const send = async (bitmap: ImageBitmap, timeSec: number, videoKey: string): Promise<FrameAnalysis> => {
        const requestId = nextRequestId++;
        const answered = new Promise<FrameResult>((done, fail) => {
          const timer = setTimeout(() => {
            waiting.delete(requestId);
            fail(new Error("the analysis worker gave no reply"));
          }, ANALYSIS_TIMEOUT_MS);
          waiting.set(requestId, (result) => {
            clearTimeout(timer);
            done(result);
          });
        });
        const request: WorkerRequest = {
          kind: "frame",
          bitmap,
          videoTimeSec: timeSec,
          envelope: { requestId, mediaTimeSec: timeSec, generation: 0, videoKey },
        };
        worker.postMessage(request, [bitmap]);
        const result = await answered;
        if (tiltedOff !== null) throw new Error(`the tilted retry was turned off, so the run stops: ${tiltedOff}`);
        if (!result.analysis) throw new Error(`the frame was not analyzed: ${result.error ?? "no reason given"}`);
        return result.analysis;
      };
      resolve({
        release: reply.release,
        async analyze(video) {
          if (!ctx) throw new Error("this browser gives no 2D canvas");
          const frame = await captureFrame(video, canvas, ctx, analysisWidth);
          return send(frame.bitmap, frame.videoTimeSec, video.currentSrc);
        },
        analyzeBitmap(bitmap, timeSec) {
          if (bitmap.width < analysisWidth.min || bitmap.width > analysisWidth.max) {
            bitmap.close();
            return Promise.reject(new Error(`a picture ${bitmap.width} px wide is outside the analysis range ${analysisWidth.min} to ${analysisWidth.max}`));
          }
          return send(bitmap, timeSec, "bitmap");
        },
        geometric: () => geometric,
        geometricSettled: () =>
          geometric === null || geometric.state !== "loading"
            ? Promise.resolve(geometric)
            : new Promise((done) => settledWaiters.push(() => done(geometric))),
        stop: () => worker.terminate(),
      });
    };
    const load: WorkerRequest = {
      kind: "load",
      releaseUrl: new URL(options.releaseUrl, location.href).href,
      ...(options.providers ? { providers: options.providers } : {}),
      ...(options.geometricUrl !== undefined ? { geometricUrl: new URL(options.geometricUrl, location.href).href } : {}),
      ...(options.geometricDebug ? { geometricDebug: true } : {}),
      ...(options.geometricManifestSha256 !== undefined ? { geometricManifestSha256: options.geometricManifestSha256 } : {}),
      ...(options.geometricWatchdog === false ? { geometricWatchdog: false } : {}),
      // A scoring run measures the tilted retry on every frame; its time is not what is scored.
      tiltedWatchdog: false,
    };
    worker.postMessage(load);
  });
}

/** How often the page has become hidden since it was loaded. */
let timesHidden = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) timesHidden += 1;
});

/** Resolves when the page is visible: at once if it is. */
function whenVisible(): Promise<void> {
  if (!document.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    const seen = (): void => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", seen);
      resolve();
    };
    document.addEventListener("visibilitychange", seen);
  });
}

/** Wait until the browser has drawn the page twice, or 200 ms: a frame that was on its way to
 *  the screen has been presented by then. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }),
    );
  });
}

function once(target: EventTarget, name: string, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(name, done);
      reject(new Error(what));
    }, timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    target.addEventListener(name, done, { once: true });
  });
}

/**
 * Open a video file in the element and return it as a `ScoringVideo`. The element is left
 * paused and muted. Rejects when the browser cannot play the file.
 */
export async function openVideo(video: HTMLVideoElement, file: File, analyzer: Analyzer): Promise<ScoringVideo & { close(): void }> {
  const url = URL.createObjectURL(file);
  video.muted = true;
  video.pause();
  const listening = new AbortController();
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${file.name}: the video did not load`)), SEEK_TIMEOUT_MS);
    const settled = (): void => {
      clearTimeout(timer);
      listening.abort();
    };
    video.addEventListener("loadeddata", () => (settled(), resolve()), { signal: listening.signal });
    video.addEventListener("error", () => (settled(), reject(new Error(`${file.name}: this browser cannot play the file (${video.error?.message || "no reason given"})`))), {
      signal: listening.signal,
    });
  });
  video.src = url;
  try {
    await loaded;
  } catch (error) {
    listening.abort();
    URL.revokeObjectURL(url);
    throw error;
  }
  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("this browser gives no 2D canvas");
  const hasCallback = "requestVideoFrameCallback" in video;
  /** What is on screen: the time the element was sought to, and the frame. Null when that is
   *  not known: for a new file, and after a seek that failed. */
  let shown: { target: number; frame: DecodedFrame } | null = null;
  /** Whether a seek has been made that is known to have ended. Until one has, and after one
   *  that failed, the element is first moved away from the wanted time. */
  let settled = false;

  const present = (timeSec: number): Promise<number> =>
    new Promise((resolve, reject) => {
      let handle = 0;
      const timer = setTimeout(() => {
        video.cancelVideoFrameCallback(handle);
        reject(new Error(`the browser presented no frame at ${timeSec} s`));
      }, PRESENT_TIMEOUT_MS);
      handle = video.requestVideoFrameCallback((_now, metadata) => {
        clearTimeout(timer);
        resolve(metadata.mediaTime);
      });
    });
  const seek = async (target: number): Promise<void> => {
    const seeked = once(video, "seeked", SEEK_TIMEOUT_MS, `the seek to ${target} s did not finish`);
    video.currentTime = target;
    await seeked;
  };

  /** Show the frame on screen at `target` and give the time the browser reports for it: the
   *  callback's `mediaTime`, or without the callback the time asked for. Waits while the page
   *  is hidden, and asks again when the page was hidden while it asked. */
  const show = async (target: number): Promise<number> => {
    for (;;) {
      await whenVisible();
      const hiddenBefore = timesHidden;
      shown = null;
      try {
        if (!settled) {
          // Move away from the wanted time first, in case the element is already at it, and let
          // any frame on its way to the screen pass, so that it cannot answer the seek below.
          await seek(target > video.duration / 2 ? 0 : video.duration);
          await settle();
        }
        settled = false;
        const presented = hasCallback ? present(target) : null;
        presented?.catch(() => undefined);
        await seek(target);
        const reported = presented ? await presented : target;
        settled = true;
        return reported;
      } catch (error) {
        if (timesHidden === hiddenBefore && !document.hidden) throw error;
      }
    }
  };
  // The callback's time is taken as the frame's own only on evidence.
  const exactTimes = hasCallback && (await reportsFrameTimes(show, video.duration));

  return {
    file: file.name,
    width,
    height,
    durationSec: video.duration,
    exactTimes,
    async frameAt(timeSec) {
      const target = Math.min(Math.max(0, timeSec), video.duration);
      // Asking for the time already on screen starts no seek and presents no frame.
      if (shown !== null && Math.abs(shown.target - target) <= SAME_TIME_SEC) return { ...shown.frame, seekSec: timeSec };
      const reported = await show(target);
      ctx.drawImage(video, 0, 0, width, height);
      const fingerprint = dhash(ctx.getImageData(0, 0, width, height).data, width, height);
      shown = { target, frame: { timeSec: exactTimes ? reported : target, seekSec: timeSec, fingerprint } };
      return { ...shown.frame };
    },
    analyzeShown: () => analyzer.analyze(video),
    close: () => {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}
