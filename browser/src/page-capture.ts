// SPDX-License-Identifier: Apache-2.0
// Taking the picture a compute frame asked for, in a content script (docs/extension-session.md).
//
// `grabFrame` draws the video's current picture at analysis size and makes a transferable
// ImageBitmap of it, or says why it could not and whether asking again is worth it. It does not
// check whether a picture may be given at all: that is the capture gate's (capture-gate.ts),
// checked by the caller first.
//
// A paused live stream may reset its <video> (no current frame, time 0) while its last frame
// stays on screen, and that frame can still be drawn. While a video is paused that way
// ("frozen"), pictures are taken from it anyway, dated at the time it showed while it last
// played. That time is kept in one place, `watchVideo` (video-events.ts), and `grabFrame` takes
// the watch itself (its video, its canvas, its time), so a pointer message dated with
// `watch.mediaTime()` and a picture of the same frozen frame carry the same time.
//
// The pixels stay in the page's memory until the caller transfers the bitmap to its own compute
// frame. Nothing is stored or sent here.

import { type AnalysisWidth, analysisSize } from "./capture.js";
import { MAX_FRAME_SIDE } from "./compute-messages.js";

/** The time the video showed while it last played, as `watchVideo` keeps it; null for none. */
export interface PlayingClock {
  readonly lastPlayingTime: number | null;
}

/** The canvas pictures of one source are drawn into. A canvas that once drew a picture it may
 *  not read stays unreadable, so a new source gets a new one (`createSourceCanvas`); the canvas
 *  itself is made at the first grab. */
export interface SourceCanvas {
  canvas: HTMLCanvasElement | null;
  /** Whether this canvas was shown to be readable (checked once per canvas: a read-back is not
   *  free). */
  readable: boolean;
}

/** What `grabFrame` reads: a video with its canvas and the time it last played. `watchVideo`'s
 *  watch is one; `source` is read at every grab, since a new source replaces it. */
export interface CaptureSource extends PlayingClock {
  readonly video: HTMLVideoElement;
  readonly source: SourceCanvas;
}

export type Grab =
  | { kind: "frame"; bitmap: ImageBitmap; mediaTime: number }
  /** `retry`: the picture itself could not be had (not ready yet, or blank): worth asking again. */
  | { kind: "failed"; reason: string; retry: boolean };

export interface GrabDeps {
  /** Makes a canvas; default `document.createElement("canvas")`. */
  createCanvas?: () => HTMLCanvasElement;
  /** Makes the bitmap; default the global `createImageBitmap`. */
  createImageBitmap?: (canvas: HTMLCanvasElement) => Promise<ImageBitmap>;
  /** Refuse a video that is not in the page ("no picture", retry). Default true: a content
   *  script's video can be replaced under it. */
  requireConnected?: boolean;
  /** The largest side of a frame taken ("the picture is too large" above it). Default
   *  `MAX_FRAME_SIDE`, what a compute frame accepts; a same-document session has no such limit. */
  maxSide?: number;
}

/** The reasons `grabFrame` gives. */
export const NO_PICTURE = "no picture";
export const BLANK_PICTURE = "no picture (the paused video draws nothing)";
export const NO_CONTEXT = "no 2d context";
export const UNREADABLE = "the video may not be read";
export const TOO_LARGE = "the picture is too large";

/** The side of the reduction `blankFrame` looks at, and the luminance variance under which a
 *  picture counts as blank. */
const BLANK_SIDE = 16;
const BLANK_VARIANCE = 9;

const defaultCanvas = (): HTMLCanvasElement => document.createElement("canvas");
const defaultBitmap = (canvas: HTMLCanvasElement): Promise<ImageBitmap> => createImageBitmap(canvas);

/** A new canvas record for a source (see `SourceCanvas`). */
export function createSourceCanvas(): SourceCanvas {
  return { canvas: null, readable: false };
}

/** A paused live stream whose <video> was reset (no current frame) while its last frame stays
 *  on screen. */
export function isFrozen(video: HTMLVideoElement): boolean {
  return video.paused && video.readyState < 2 && video.videoWidth > 0;
}

/** The time of the picture on screen: for a frozen video, its time when it last played. */
export function mediaTimeOf(video: HTMLVideoElement, clock: PlayingClock | null): number {
  const last = clock?.lastPlayingTime ?? null;
  return isFrozen(video) && last !== null ? last : video.currentTime;
}

/** Whether a drawn picture is empty: a 16 x 16 reduction of it with almost no variation. False
 *  when there is no 2D context to tell. Throws as `getImageData` does when the picture may not
 *  be read. */
export function blankFrame(picture: HTMLCanvasElement, createCanvas: () => HTMLCanvasElement = defaultCanvas): boolean {
  const n = BLANK_SIDE;
  const small = createCanvas();
  small.width = n;
  small.height = n;
  const s = small.getContext("2d");
  if (!s) return false;
  s.drawImage(picture, 0, 0, n, n);
  const d = s.getImageData(0, 0, n, n).data;
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
    sum += l;
    sum2 += l * l;
  }
  const mean = sum / (n * n);
  return sum2 / (n * n) - mean * mean < BLANK_VARIANCE;
}

function isSecurityError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "SecurityError";
}

/**
 * Draw the watched video's current picture into its source canvas at analysis size and make a
 * transferable bitmap of it. In this order: no watch, a video out of the page (unless
 * `requireConnected` is false) or with no picture size: "no picture" (retry); not ready and not
 * frozen: "no picture" (retry); a frame larger than `maxSide` (default `MAX_FRAME_SIDE`) on a
 * side: "the picture is too large" (no retry, nothing drawn); draw; frozen and blank: "no
 * picture (the paused video draws nothing)" (retry); the readable check, once per canvas; the
 * bitmap. A picture that may not be read: "the video may not be read" (no retry); any other
 * error: its text (no retry). The time is read before the draw and the first
 * await, so it belongs to the picture drawn.
 *
 * The caller owns the returned bitmap: it must transfer it (to its compute frame) or close it.
 */
export async function grabFrame(watch: CaptureSource | null, range: AnalysisWidth, deps: GrabDeps = {}): Promise<Grab> {
  const failed = (reason: string, retry = false): Grab => ({ kind: "failed", reason, retry });
  const video = watch?.video;
  if (!watch || !video || ((deps.requireConnected ?? true) && !video.isConnected) || video.videoWidth === 0) return failed(NO_PICTURE, true);
  const frozen = isFrozen(video);
  if (video.readyState < 2 && !frozen) return failed(NO_PICTURE, true);
  const createCanvas = deps.createCanvas ?? defaultCanvas;
  const size = analysisSize(video.videoWidth, video.videoHeight, range);
  // The compute frame refuses a larger picture (a very tall portrait video): say so here rather
  // than send one it drops.
  const maxSide = deps.maxSide ?? MAX_FRAME_SIDE;
  if (size.width > maxSide || size.height > maxSide) return failed(TOO_LARGE);
  const source = watch.source;
  if (!source.canvas) {
    source.canvas = createCanvas();
    source.readable = false;
  }
  const canvas = source.canvas;
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return failed(NO_CONTEXT);
  const mediaTime = mediaTimeOf(video, watch);
  try {
    ctx.drawImage(video, 0, 0, size.width, size.height);
    // A frozen video may draw nothing (black or one color): then there is no picture. The check
    // read the picture back, so the canvas is readable.
    if (frozen && blankFrame(canvas, createCanvas)) {
      source.readable = true;
      return failed(BLANK_PICTURE, true);
    }
    // Throws when the picture may not be read (a video from another origin): say so rather than
    // send a picture the worker cannot read.
    if (!source.readable) {
      ctx.getImageData(0, 0, 1, 1);
      source.readable = true;
    }
    const bitmap = await (deps.createImageBitmap ?? defaultBitmap)(canvas);
    return { kind: "frame", bitmap, mediaTime };
  } catch (error) {
    return failed(isSecurityError(error) ? UNREADABLE : String(error));
  }
}
