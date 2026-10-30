// SPDX-License-Identifier: Apache-2.0
// watchVideo with a stand-in video (no DOM): its events become presented / discontinuity, and it
// alone keeps the time the video last played.
import { describe, expect, it } from "vitest";

import { watchVideo } from "../src/video-events.js";

function fakeVideo() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    videoWidth: 1280,
    videoHeight: 720,
    readyState: 4,
    paused: false,
    currentTime: 12.5,
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

function watched() {
  const video = fakeVideo();
  const events: Array<{ kind: "presented"; mediaTime: number } | { kind: "discontinuity"; newSource: boolean }> = [];
  const watch = watchVideo(video as unknown as HTMLVideoElement, {
    presented: (mediaTime) => void events.push({ kind: "presented", mediaTime }),
    discontinuity: (newSource) => void events.push({ kind: "discontinuity", newSource }),
  });
  return { video, events, watch };
}

describe("watchVideo", () => {
  it("reports nothing on attach, and starts with no playing time and a new canvas", () => {
    const { events, watch } = watched();
    expect(events).toEqual([]);
    expect(watch.lastPlayingTime).toBeNull();
    expect(watch.source).toEqual({ canvas: null, readable: false });
  });

  it("turns the video's events into the contract's messages", () => {
    const { video, events } = watched();
    for (const type of ["seeking", "seeked", "timeupdate", "canplay", "playing", "emptied", "loadeddata", "pause"]) video.fire(type);
    expect(events).toEqual([
      { kind: "discontinuity", newSource: false },
      { kind: "presented", mediaTime: 12.5 },
      { kind: "presented", mediaTime: 12.5 },
      { kind: "presented", mediaTime: 12.5 },
      { kind: "presented", mediaTime: 12.5 },
      { kind: "discontinuity", newSource: true },
      { kind: "discontinuity", newSource: true },
    ]);
  });

  it("keeps the time the video last played, only while it plays a ready picture", () => {
    const { video, watch } = watched();
    video.fire("timeupdate");
    expect(watch.lastPlayingTime).toBe(12.5);
    Object.assign(video, { paused: true, currentTime: 20 });
    video.fire("seeked");
    expect(watch.lastPlayingTime).toBe(12.5);
    Object.assign(video, { paused: false, readyState: 1, currentTime: 21 });
    video.fire("timeupdate");
    expect(watch.lastPlayingTime).toBe(12.5);
    // canplay / playing re-arm analysis but are not a playing time.
    Object.assign(video, { readyState: 4, currentTime: 22 });
    video.fire("playing");
    expect(watch.lastPlayingTime).toBe(12.5);
  });

  it("dates a paused live stream's frozen picture at the time it showed while playing", () => {
    const { video, events, watch } = watched();
    video.fire("timeupdate");
    Object.assign(video, { paused: true, readyState: 1, currentTime: 0 });
    // What the pointer message would carry, and what a ready event reports.
    expect(watch.mediaTime()).toBe(12.5);
    video.fire("canplay");
    expect(events.at(-1)).toEqual({ kind: "presented", mediaTime: 12.5 });
  });

  it("forgets the time a video last played, and its canvas, when its source changes", () => {
    for (const type of ["emptied", "loadeddata"]) {
      const { video, watch } = watched();
      video.fire("timeupdate");
      const before = watch.source;
      before.readable = true;
      video.fire(type);
      expect(watch.lastPlayingTime).toBeNull();
      expect(watch.source).not.toBe(before);
      expect(watch.source).toEqual({ canvas: null, readable: false });
      Object.assign(video, { paused: true, readyState: 1, currentTime: 0 });
      expect(watch.mediaTime()).toBe(0);
    }
  });

  it("stops listening on detach, once", () => {
    const { video, events, watch } = watched();
    expect(video.listenerCount()).toBe(7);
    watch.detach();
    watch.detach();
    expect(video.listenerCount()).toBe(0);
    video.fire("timeupdate");
    expect(events).toEqual([]);
  });
});
