// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): which video on the page is the main one (S-G4), and
// where its picture sits.
//
// The main video is the largest `<video>` by its box's area, at least 320 CSS px wide and with a
// picture (`videoWidth` above 0). It is picked again on a trusted pointer move (at most once a
// second) and on each trusted `playing` event; a page script's made-up event never counts.

import { type ClientBox, pictureBox } from "../capture.js";

/** The narrowest video that can be the main one, in CSS pixels. */
export const MIN_VIDEO_WIDTH = 320;
/** A pick is kept this long before a pointer move picks again. */
export const VIDEO_RECHECK_MS = 1_000;

/** The page, as the pick needs it: its videos, in page order. A `Document` fits. */
export interface VideoSource {
  querySelectorAll(selector: "video"): Iterable<HTMLVideoElement>;
}

/** The main video of `doc` now: the largest by area among those wide enough and with a picture;
 *  the first of equals. Null when there is none. */
export function pickMainVideo(doc: VideoSource): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const v of doc.querySelectorAll("video")) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (r.width >= MIN_VIDEO_WIDTH && v.videoWidth > 0 && area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

/** Where the video's picture sits on the page, for its `object-fit`. */
export function pictureOf(video: HTMLVideoElement): ClientBox {
  const view = video.ownerDocument?.defaultView;
  const fit = view ? view.getComputedStyle(video).objectFit : "contain";
  return pictureBox(video.getBoundingClientRect(), { width: video.videoWidth, height: video.videoHeight }, fit);
}

export interface VideoPickEnv {
  doc: VideoSource;
  now?: () => number;
  /** The main video changed (to another video, or to none). Called after the pick is stored. */
  onChange(video: HTMLVideoElement | null): void;
}

export interface VideoPick {
  /** The main video: the kept pick while it is connected and was made less than a second ago,
   *  otherwise a new pick. A result of "no video" is kept for up to a second too: this differs from
   *  products that scan again on every call while no video exists, and follows S-G4's "at most
   *  once a second", which has no exception for none. A trusted `playing` always picks again at
   *  once. Call it on a trusted pointer move or whenever the pick is wanted. */
  current(): HTMLVideoElement | null;
  /** A `playing` event: picks again now when the event is trusted, whatever its target. Returns
   *  the main video; an untrusted event changes nothing and returns the kept pick. */
  onPlaying(event: Pick<Event, "isTrusted">): HTMLVideoElement | null;
  /** Forget the pick without calling `onChange` (the host is stopping or the page is not active). */
  clear(): void;
}

export function createVideoPick(env: VideoPickEnv): VideoPick {
  const now = env.now ?? ((): number => performance.now());
  let video: HTMLVideoElement | null = null;
  let pickedAt = -Infinity;

  const pick = (): HTMLVideoElement | null => {
    pickedAt = now();
    const best = pickMainVideo(env.doc);
    if (best !== video) {
      video = best;
      env.onChange(best);
    }
    return best;
  };

  return {
    current() {
      if ((video === null || video.isConnected) && now() - pickedAt < VIDEO_RECHECK_MS) return video;
      return pick();
    },
    onPlaying(event) {
      if (event.isTrusted !== true) return video;
      return pick();
    },
    clear() {
      video = null;
      pickedAt = -Infinity;
    },
  };
}
