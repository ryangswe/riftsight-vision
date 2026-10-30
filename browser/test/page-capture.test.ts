// SPDX-License-Identifier: Apache-2.0
// The page-side capture helper with a stand-in video and 2D context (no DOM): each branch of
// grabFrame in its order, the frozen (paused live) picture's date, and the per-canvas read check.
import { describe, expect, it } from "vitest";

import { analysisSize, fractionIn } from "../src/capture.js";
import {
  BLANK_PICTURE,
  blankFrame,
  createSourceCanvas,
  grabFrame,
  isFrozen,
  mediaTimeOf,
  NO_CONTEXT,
  NO_PICTURE,
  TOO_LARGE,
  UNREADABLE,
} from "../src/page-capture.js";
import { MAX_FRAME_SIDE } from "../src/compute-messages.js";
import { watchVideo } from "../src/video-events.js";

const RANGE = { min: 720, max: 1920 };

interface Media {
  isConnected: boolean;
  videoWidth: number;
  videoHeight: number;
  readyState: number;
  paused: boolean;
  currentTime: number;
}

/** A stand-in <video>: the fields grabFrame reads, and events for watchVideo. */
function fakeVideo(over: Partial<Media> = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const v = {
    isConnected: true,
    videoWidth: 1280,
    videoHeight: 720,
    readyState: 4,
    paused: false,
    currentTime: 12.5,
    ...over,
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
  return v;
}
type FakeVideo = ReturnType<typeof fakeVideo>;
const asVideo = (v: FakeVideo) => v as unknown as HTMLVideoElement;

interface CanvasOptions {
  /** No 2D context at all. */
  noContext?: boolean;
  /** The value every read-back pixel channel has (one color: blank). */
  fill?: number | "noise";
  /** What getImageData throws, if anything. */
  readThrows?: unknown;
  /** What drawImage throws, if anything. */
  drawThrows?: unknown;
}

/** Stand-in canvases that log every call, in order, into one shared log. */
function canvasFactory(log: string[], options: CanvasOptions = {}) {
  let made = 0;
  const create = (): HTMLCanvasElement => {
    const id = made++;
    const canvas = {
      width: 0,
      height: 0,
      getContext(kind: string) {
        log.push(`getContext#${id}(${kind})`);
        if (options.noContext) return null;
        return {
          canvas,
          drawImage(_src: unknown, _x: number, _y: number, w: number, h: number) {
            log.push(`drawImage#${id}(${w}x${h})`);
            if (options.drawThrows !== undefined) throw options.drawThrows;
          },
          getImageData(_x: number, _y: number, w: number, h: number) {
            log.push(`getImageData#${id}(${w}x${h})`);
            if (options.readThrows !== undefined) throw options.readThrows;
            const data = new Uint8ClampedArray(w * h * 4);
            if (options.fill === "noise") for (let i = 0; i < data.length; i += 1) data[i] = (i * 37) % 256;
            else data.fill(options.fill ?? 30);
            return { data };
          },
        };
      },
    };
    log.push(`createCanvas#${id}`);
    return canvas as unknown as HTMLCanvasElement;
  };
  return { create, made: () => made };
}

const noSink = { presented: () => {}, discontinuity: () => {} };
/** A watch over a stand-in video. */
const watchOf = (fake: FakeVideo) => watchVideo(asVideo(fake), noSink);

function deps(log: string[], options: CanvasOptions = {}) {
  const canvases = canvasFactory(log, options);
  const bitmap = { width: 1, height: 1, close() {} } as unknown as ImageBitmap;
  return {
    canvases,
    bitmap,
    deps: {
      createCanvas: canvases.create,
      createImageBitmap: async (canvas: HTMLCanvasElement) => {
        log.push(`createImageBitmap(${canvas.width}x${canvas.height})`);
        return bitmap;
      },
    },
  };
}

describe("grabFrame", () => {
  it("draws at analysis size, checks the canvas is readable, then makes the bitmap", async () => {
    const log: string[] = [];
    const { deps: d, bitmap } = deps(log, { fill: "noise" });
    const grab = await grabFrame(watchOf(fakeVideo()), RANGE, d);
    expect(grab).toEqual({ kind: "frame", bitmap, mediaTime: 12.5 });
    expect(log).toEqual(["createCanvas#0", "getContext#0(2d)", "drawImage#0(1280x720)", "getImageData#0(1x1)", "createImageBitmap(1280x720)"]);
  });

  it("checks a canvas is readable once", async () => {
    const log: string[] = [];
    const { deps: d } = deps(log, { fill: "noise" });
    const watch = watchOf(fakeVideo());
    await grabFrame(watch, RANGE, d);
    log.length = 0;
    await grabFrame(watch, RANGE, d);
    expect(log).toEqual(["getContext#0(2d)", "drawImage#0(1280x720)", "createImageBitmap(1280x720)"]);
  });

  it("after a new source, draws into a new canvas and checks it is readable again", async () => {
    const log: string[] = [];
    const { deps: d } = deps(log, { fill: "noise" });
    const fake = fakeVideo();
    const watch = watchOf(fake);
    await grabFrame(watch, RANGE, d);
    const before = watch.source;
    fake.fire("emptied");
    log.length = 0;
    await grabFrame(watch, RANGE, d);
    expect(log).toEqual(["createCanvas#1", "getContext#1(2d)", "drawImage#1(1280x720)", "getImageData#1(1x1)", "createImageBitmap(1280x720)"]);
    expect(watch.source).not.toBe(before);
    expect(watch.source.readable).toBe(true);
    expect(before.readable).toBe(true);
  });

  it("asks again for no watch, a video out of the page, or one with no picture size, before any canvas", async () => {
    for (const watch of [null, watchOf(fakeVideo({ isConnected: false })), watchOf(fakeVideo({ videoWidth: 0 }))]) {
      const log: string[] = [];
      const { deps: d } = deps(log);
      expect(await grabFrame(watch, RANGE, d)).toEqual({ kind: "failed", reason: NO_PICTURE, retry: true });
      expect(log).toEqual([]);
    }
  });

  it("asks again for a video not ready yet that is not frozen (still playing)", async () => {
    const log: string[] = [];
    const { deps: d } = deps(log);
    expect(await grabFrame(watchOf(fakeVideo({ readyState: 1, paused: false })), RANGE, d)).toEqual({ kind: "failed", reason: NO_PICTURE, retry: true });
    expect(log).toEqual([]);
  });

  it("refuses a frame larger than the compute frame takes, before drawing, without asking again", async () => {
    const log: string[] = [];
    const { deps: d } = deps(log, { fill: "noise" });
    // A very tall portrait video: 1080 x 7000 is analyzed 720 wide, 4667 tall.
    const tall = watchOf(fakeVideo({ videoWidth: 1080, videoHeight: 7000 }));
    expect(await grabFrame(tall, RANGE, d)).toEqual({ kind: "failed", reason: TOO_LARGE, retry: false });
    expect(log).toEqual([]);
    // At the cap exactly it is drawn.
    const edge = watchOf(fakeVideo({ videoWidth: 720, videoHeight: MAX_FRAME_SIDE }));
    expect((await grabFrame(edge, RANGE, d)).kind).toBe("frame");
    expect(log).toContain(`drawImage#0(720x${MAX_FRAME_SIDE})`);
  });

  it("takes a frozen picture anyway, dated at the time it showed while playing", async () => {
    const log: string[] = [];
    const { deps: d, bitmap } = deps(log, { fill: "noise" });
    const fake = fakeVideo();
    const video = asVideo(fake);
    const watch = watchOf(fake);
    fake.fire("timeupdate");
    Object.assign(fake, { paused: true, readyState: 1, currentTime: 0 });
    expect(isFrozen(video)).toBe(true);
    // The pointer message and the picture carry the same time.
    expect(mediaTimeOf(video, watch)).toBe(12.5);
    expect(watch.mediaTime()).toBe(12.5);
    const grab = await grabFrame(watch, RANGE, d);
    expect(grab).toEqual({ kind: "frame", bitmap, mediaTime: 12.5 });
    // The blank check ran on its own small canvas, then the readable check.
    expect(log).toEqual([
      "createCanvas#0",
      "getContext#0(2d)",
      "drawImage#0(1280x720)",
      "createCanvas#1",
      "getContext#1(2d)",
      "drawImage#1(16x16)",
      "getImageData#1(16x16)",
      "getImageData#0(1x1)",
      "createImageBitmap(1280x720)",
    ]);
  });

  it("refuses a frozen picture that draws nothing, and asks again", async () => {
    const log: string[] = [];
    const { deps: d } = deps(log, { fill: 30 });
    const fake = fakeVideo();
    const watch = watchOf(fake);
    fake.fire("timeupdate");
    Object.assign(fake, { paused: true, readyState: 1, currentTime: 0 });
    expect(await grabFrame(watch, RANGE, d)).toEqual({ kind: "failed", reason: BLANK_PICTURE, retry: true });
    expect(log.at(-1)).toBe("getImageData#1(16x16)");
    expect(log).not.toContain("getImageData#0(1x1)");
    // The blank check read the picture back: the canvas counts as readable.
    expect(watch.source.readable).toBe(true);
  });

  it("does not check a picture that is not frozen for blankness", async () => {
    const log: string[] = [];
    const { deps: d, bitmap } = deps(log, { fill: 0 });
    // Paused but ready (a paused video on demand): black is a picture like any other.
    const grab = await grabFrame(watchOf(fakeVideo({ paused: true })), RANGE, d);
    expect(grab).toEqual({ kind: "frame", bitmap, mediaTime: 12.5 });
    expect(log).not.toContain("drawImage#1(16x16)");
  });

  it("dates the picture at the time read before the bitmap is awaited", async () => {
    const log: string[] = [];
    const { deps: d, bitmap } = deps(log, { fill: "noise" });
    const fake = fakeVideo();
    const moving = {
      ...d,
      createImageBitmap: async () => {
        fake.currentTime = 99;
        return bitmap;
      },
    };
    expect(await grabFrame(watchOf(fake), RANGE, moving)).toEqual({ kind: "frame", bitmap, mediaTime: 12.5 });
  });

  it("gives up without a 2D context, without asking again", async () => {
    const log: string[] = [];
    const { deps: d } = deps(log, { noContext: true });
    expect(await grabFrame(watchOf(fakeVideo()), RANGE, d)).toEqual({ kind: "failed", reason: NO_CONTEXT, retry: false });
    expect(log).toEqual(["createCanvas#0", "getContext#0(2d)"]);
  });

  it("says a picture from another origin may not be read, without asking again, and never makes a bitmap", async () => {
    const log: string[] = [];
    const { deps: d } = deps(log, { readThrows: new DOMException("tainted", "SecurityError") });
    const watch = watchOf(fakeVideo());
    expect(await grabFrame(watch, RANGE, d)).toEqual({ kind: "failed", reason: UNREADABLE, retry: false });
    expect(log.some((l) => l.startsWith("createImageBitmap"))).toBe(false);
    expect(watch.source.readable).toBe(false);
  });

  it("says so too when a frozen picture's blank check finds it may not be read", async () => {
    const log: string[] = [];
    const { deps: d } = deps(log, { readThrows: new DOMException("tainted", "SecurityError") });
    expect(await grabFrame(watchOf(fakeVideo({ paused: true, readyState: 1 })), RANGE, d)).toEqual({ kind: "failed", reason: UNREADABLE, retry: false });
  });

  it("reports any other error as its text, without asking again", async () => {
    const log: string[] = [];
    const { deps: d } = deps(log, { drawThrows: new Error("boom") });
    expect(await grabFrame(watchOf(fakeVideo()), RANGE, d)).toEqual({ kind: "failed", reason: "Error: boom", retry: false });
    const other = new DOMException("x", "InvalidStateError");
    const { deps: d2 } = deps(log, { readThrows: other });
    expect(await grabFrame(watchOf(fakeVideo()), RANGE, d2)).toEqual({ kind: "failed", reason: String(other), retry: false });
    const { deps: d3 } = deps(log, { fill: "noise" });
    const failing = { ...d3, createImageBitmap: async () => Promise.reject(new Error("no memory")) };
    expect(await grabFrame(watchOf(fakeVideo()), RANGE, failing)).toEqual({ kind: "failed", reason: "Error: no memory", retry: false });
  });

  it("draws within the range asked for, at least one row tall", async () => {
    const log: string[] = [];
    const { deps: d } = deps(log, { fill: "noise" });
    await grabFrame(watchOf(fakeVideo({ videoWidth: 3840, videoHeight: 2160 })), { min: 320, max: 640 }, d);
    expect(log).toContain("drawImage#0(640x360)");
    expect(analysisSize(4000, 1, { min: 720, max: 1920 })).toEqual({ width: 1920, height: 1 });
    expect(analysisSize(100_000, 1, { min: 720, max: 1920 })).toEqual({ width: 1920, height: 1 });
  });

  it("dates a picture that is not frozen at the video's own time, whatever it last played at", () => {
    const video = asVideo(fakeVideo({ paused: true, readyState: 4, currentTime: 3 }));
    expect(mediaTimeOf(video, { lastPlayingTime: 9 })).toBe(3);
    expect(mediaTimeOf(asVideo(fakeVideo({ paused: true, readyState: 1, currentTime: 0 })), { lastPlayingTime: null })).toBe(0);
    expect(mediaTimeOf(asVideo(fakeVideo({ paused: true, readyState: 1, currentTime: 0 })), null)).toBe(0);
  });
});

describe("blankFrame", () => {
  it("is blank under a 16 x 16 variance of 9, and false with no context to tell", () => {
    const log: string[] = [];
    const picture = {} as HTMLCanvasElement;
    expect(blankFrame(picture, canvasFactory(log, { fill: 200 }).create)).toBe(true);
    expect(blankFrame(picture, canvasFactory(log, { fill: "noise" }).create)).toBe(false);
    expect(blankFrame(picture, canvasFactory(log, { noContext: true }).create)).toBe(false);
  });

  it("counts a variance just under 9 as blank, and 9 or over as a picture", () => {
    // 256 pixels around 100 (the mean stays 100): `wide` of them at +/-4, `narrow` at +/-3, the
    // rest at 100. The luminance variance is (16 wide + 9 narrow) / 256.
    const variance = (wide: number, narrow: number) => {
      const value = (p: number) => (p < wide ? (p % 2 ? 104 : 96) : p < wide + narrow ? (p % 2 ? 103 : 97) : 100);
      const create = (): HTMLCanvasElement =>
        ({
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage() {},
            getImageData: (_x: number, _y: number, w: number, h: number) => {
              const data = new Uint8ClampedArray(w * h * 4);
              for (let p = 0; p < w * h; p += 1) data.fill(value(p), p * 4, p * 4 + 4);
              return { data };
            },
          }),
        }) as unknown as HTMLCanvasElement;
      return blankFrame({} as HTMLCanvasElement, create);
    };
    expect(variance(0, 254)).toBe(true); // 8.93
    expect(variance(0, 256)).toBe(false); // 9
    expect(variance(2, 254)).toBe(false); // 9.05
  });
});

describe("fractionIn", () => {
  it("gives the point in fractions of a box, edges inside, null outside or for an empty box", () => {
    const box = { left: 100, top: 50, width: 200, height: 100 };
    expect(fractionIn(box, 200, 100)).toEqual({ x: 0.5, y: 0.5 });
    expect(fractionIn(box, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(fractionIn(box, 300, 150)).toEqual({ x: 1, y: 1 });
    expect(fractionIn(box, 99, 100)).toBeNull();
    expect(fractionIn(box, 200, 151)).toBeNull();
    expect(fractionIn({ ...box, width: 0 }, 100, 50)).toBeNull();
  });
});
