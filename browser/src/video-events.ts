// SPDX-License-Identifier: Apache-2.0
// What a content script reports about its video to the compute frame (docs/extension-session.md).
//
// `watchVideo` listens to one <video> and turns its events into the contract's messages:
//   - `seeking`: a discontinuity in the same source;
//   - `emptied`, `loadeddata`: another source;
//   - `timeupdate`, `seeked`: a presented picture (and, while it plays, the time it last played);
//   - `canplay`, `playing`: a presented picture too, since a video that becomes ready re-arms
//     analysis (a paused one presents no other picture).
//
// It alone keeps the time the video showed while it last played, which dates the
// picture of a frozen (paused live) video: date pointer messages with `watch.mediaTime()` and
// grab pictures with `grabFrame(watch, …)` (page-capture.ts). A new source forgets that time and starts a new canvas (a
// canvas that drew a picture it may not read stays unreadable); so does a new watch.

import { type CaptureSource, createSourceCanvas, mediaTimeOf, type SourceCanvas } from "./page-capture.js";

export interface VideoSink {
  /** The video presented a picture at this time (see `mediaTimeOf`). */
  presented(mediaTime: number): void;
  /** A seek started (`newSource` false), or the video was given another source (true). */
  discontinuity(newSource: boolean): void;
}

export interface VideoWatch extends CaptureSource {
  /** The video watched. */
  readonly video: HTMLVideoElement;
  /** The time the video showed while it last played; null before it played, and after a new
   *  source. */
  readonly lastPlayingTime: number | null;
  /** The canvas record for the current source: replaced on a new source. */
  readonly source: SourceCanvas;
  /** The time of the picture on screen now (`mediaTimeOf` with this watch). */
  mediaTime(): number;
  /** Stop listening. */
  detach(): void;
}

/** Follow one video. Attaching does not report anything: the caller reports a new video as a
 *  new source itself (it may also have no video at all). */
export function watchVideo(video: HTMLVideoElement, sink: VideoSink): VideoWatch {
  let lastPlayingTime: number | null = null;
  let source = createSourceCanvas();
  const watch: VideoWatch = {
    video,
    get lastPlayingTime() {
      return lastPlayingTime;
    },
    get source() {
      return source;
    },
    mediaTime: () => mediaTimeOf(video, watch),
    detach,
  };
  const seeking = (): void => sink.discontinuity(false);
  const newSource = (): void => {
    source = createSourceCanvas();
    // Another source: the time it last played is not this picture's.
    lastPlayingTime = null;
    sink.discontinuity(true);
  };
  const presented = (): void => {
    if (!video.paused && video.readyState >= 2) lastPlayingTime = video.currentTime;
    sink.presented(watch.mediaTime());
  };
  const ready = (): void => sink.presented(watch.mediaTime());
  const listeners: Array<[string, () => void]> = [
    ["seeking", seeking],
    ["emptied", newSource],
    ["loadeddata", newSource],
    ["timeupdate", presented],
    ["seeked", presented],
    ["canplay", ready],
    ["playing", ready],
  ];
  for (const [type, listener] of listeners) video.addEventListener(type, listener);
  let attached = true;
  function detach(): void {
    if (!attached) return;
    attached = false;
    for (const [type, listener] of listeners) video.removeEventListener(type, listener);
  }
  return watch;
}
