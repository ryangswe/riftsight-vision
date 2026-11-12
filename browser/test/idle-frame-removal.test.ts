// SPDX-License-Identifier: Apache-2.0
// Dropping the whole compute frame when it goes idle (`whenIdle`, row 8) and the frame's `state`
// getter (row 9). Stand-in window, video and frames; no network.
import { describe, expect, it, vi } from "vitest";

import { createCaptureControl, loadWhen, type CaptureControlOptions } from "../src/capture-control.js";
import { startComputeFrame, type ComputeFrameEnv } from "../src/compute-frame.js";
import { computeProtocol, PROTOCOL_VERSION } from "../src/compute-messages.js";
import type { ReleaseStatus, WorkerReply } from "../src/messages.js";
import type { LoadRequest } from "../src/remote/choose.js";
import type { WorkerLike } from "../src/worker-session.js";

const ORIGIN = "chrome-extension://abcdefghijklmnop";
const protocol = computeProtocol("example");
const tag = protocol.tag;
const OLD_ID = "0123456789abcdef";
const NEW_ID = "fedcba9876543210";
const RANGE = { min: 720, max: 1920 };

type Listener = (event: unknown) => void;
function fakeTarget() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, fn: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    fire(type: string, event: unknown = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
  };
}

const RELEASE = { id: "r0", recognizer: { version: "r", ep: "wasm" }, hoverMaxAgeMs: 2000, analysisWidth: RANGE } as unknown as NonNullable<ReleaseStatus["release"]>;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A stand-in iframe window: what was posted to it, in order. */
function fakeFrame() {
  const got: Array<Record<string, unknown>> = [];
  return { got, postMessage: (m: Record<string, unknown>) => void got.push(m), kinds: () => got.map((m) => m.kind) };
}

function page(options: Partial<Omit<CaptureControlOptions, "whenIdle">> & { whenIdle?: "on" | "off"; keepWindow?: boolean } = {}) {
  const { whenIdle: mode = "on", keepWindow = false, ...rest } = options;
  let t = 1_000;
  const frames = [fakeFrame()];
  let current: ReturnType<typeof fakeFrame> | null = frames[0]!;
  const calls: string[] = [];
  const bitmaps: Array<(b: unknown) => void> = [];
  const whenIdle = {
    remove: vi.fn(() => {
      calls.push("remove");
      // A product may leave its reference to the dead iframe's window in place.
      if (!keepWindow) current = null;
    }),
    make: vi.fn(() => {
      calls.push("make");
      current = fakeFrame();
      frames.push(current);
    }),
  };
  const control = createCaptureControl({
    protocol,
    frame: () => current as unknown as Window | null,
    frameOrigin: ORIGIN,
    now: () => t,
    timers: { set: () => 0, clear: () => {} },
    grab: {
      createCanvas: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }) }) as unknown as HTMLCanvasElement,
      createImageBitmap: () => new Promise((resolve) => bitmaps.push(resolve)) as unknown as Promise<ImageBitmap>,
    },
    ...(mode === "on" ? { whenIdle } : {}),
    ...rest,
  });
  const win = fakeTarget();
  control.listen(win as unknown as Window, Object.assign(fakeTarget(), { documentElement: {}, visibilityState: "visible" }) as unknown as Document);
  const video = Object.assign(fakeTarget(), {
    isConnected: true, videoWidth: 1280, videoHeight: 720, readyState: 4, paused: false, ended: false, currentTime: 1,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ objectFit: "contain" }) } },
  });
  control.attach(video as unknown as HTMLVideoElement);
  const from = () => current;
  const say = (data: object, source = from()) => control.onMessage({ isTrusted: true, source, origin: ORIGIN, data: tag(data) } as unknown as MessageEvent);
  const ready = (instance: string, source = from()) => say({ kind: "ready", version: PROTOCOL_VERSION, instance }, source);
  const status = (state: string, source = from()) => say({ kind: "status", state, error: null, backend: null }, source);
  ready(OLD_ID);
  const move = (over: { isTrusted?: boolean; x?: number; y?: number } = {}) =>
    win.fire("pointermove", { type: "pointermove", isTrusted: over.isTrusted ?? true, pointerType: "mouse", pointerId: 1, clientX: over.x ?? 640, clientY: over.y ?? 360, target: {} });
  frames[0]!.got.length = 0;
  return { win, setCurrent: (f: ReturnType<typeof fakeFrame> | null) => void (current = f), control, frames, whenIdle, calls, move, ready, status, say, video, bitmaps, advance: (ms: number) => void (t += ms), current: () => current };
}

const OFF_PICTURE = { x: 5000, y: 5000 };

describe("whenIdle (row 8)", () => {
  it("calls remove once on the idle status, and sends nothing more to that frame", () => {
    const p = page({ intent: "page" });
    const old = p.frames[0]!;
    p.status("idle");
    expect(p.whenIdle.remove).toHaveBeenCalledTimes(1);
    expect(p.control.connected).toBe(false);
    // A second idle (a repeat from a frame being torn down) does not remove again.
    p.status("idle", old);
    expect(p.whenIdle.remove).toHaveBeenCalledTimes(1);
    // Nothing the control would send reaches the removed frame: attach, intent, a pointer over it.
    p.control.attach(null);
    expect(old.got).toEqual([]);
    expect(p.whenIdle.make).not.toHaveBeenCalled();
  });

  it("sends nothing to the removed frame even if the product still returns its window", () => {
    const p = page({ intent: "page", keepWindow: true });
    const old = p.frames[0]!;
    p.status("idle");
    p.status("idle");
    expect(p.whenIdle.remove).toHaveBeenCalledTimes(1);
    p.control.attach(null);
    expect(old.got).toEqual([]);
    p.say({ kind: "capture", requestId: 1, analysisWidth: RANGE });
    expect(old.got).toEqual([]);
  });

  it("makes a new frame once on a trusted move over the video, and connects to it", () => {
    const p = page();
    p.status("idle");
    p.move({ isTrusted: false });
    p.move(OFF_PICTURE);
    expect(p.whenIdle.make).not.toHaveBeenCalled();
    p.move();
    expect(p.whenIdle.make).toHaveBeenCalledTimes(1);
    expect(p.calls).toEqual(["remove", "make"]);
    // The control said hello to the new frame, not the old one.
    expect(p.frames[0]!.got).toEqual([]);
    expect(p.frames[1]!.kinds()).toEqual(["hello"]);
  });

  it("does not make twice while the new frame is still connecting", () => {
    const p = page();
    p.status("idle");
    p.move();
    p.move();
    p.advance(5000);
    p.move();
    expect(p.whenIdle.make).toHaveBeenCalledTimes(1);
    expect(p.frames).toHaveLength(2);
  });

  it("reconnects to the new frame, tells it the pointer, and captures resume", async () => {
    const p = page();
    p.status("idle");
    p.move();
    const next = p.frames[1]!;
    p.ready(NEW_ID);
    expect(p.control.connected).toBe(true);
    expect(next.kinds()).toContain("pointer");
    // The new frame's capture request is served from the new frame.
    p.say({ kind: "capture", requestId: 1, analysisWidth: RANGE });
    await flush();
    const bitmap = { width: 1280, height: 720, close: vi.fn() };
    p.bitmaps.shift()?.(bitmap);
    await flush();
    expect(next.kinds()).toContain("frame");
    expect(p.frames[0]!.got).toEqual([]);
    // It can go idle again: removed once more, then made once more.
    p.status("idle");
    expect(p.whenIdle.remove).toHaveBeenCalledTimes(2);
    p.move();
    expect(p.whenIdle.make).toHaveBeenCalledTimes(2);
  });

  it("a frame the product made and connected itself ends the removed state: no make, and the next idle removes it", () => {
    const p = page();
    p.status("idle");
    const mine = fakeFrame();
    p.frames.push(mine);
    p.setCurrent(mine);
    p.control.connect();
    p.ready(NEW_ID);
    p.move();
    expect(p.whenIdle.make).not.toHaveBeenCalled();
    p.status("idle");
    expect(p.whenIdle.remove).toHaveBeenCalledTimes(2);
    p.move();
    expect(p.whenIdle.make).toHaveBeenCalledTimes(1);
  });

  it("frameRemoved reads false at start, true after idle, false after make and ready, false after a product-made frame connects", () => {
    const p = page();
    expect(p.control.frameRemoved).toBe(false);
    p.status("idle");
    expect(p.control.frameRemoved).toBe(true);
    p.move();
    expect(p.control.frameRemoved).toBe(true); // still connecting
    p.ready(NEW_ID);
    expect(p.control.frameRemoved).toBe(false);
    p.status("idle");
    expect(p.control.frameRemoved).toBe(true);
    const mine = fakeFrame();
    p.frames.push(mine);
    p.setCurrent(mine);
    p.control.connect();
    p.ready(OLD_ID);
    expect(p.control.frameRemoved).toBe(false);
    expect(page({ whenIdle: "off" }).control.frameRemoved).toBe(false);
  });

  it("a make that throws leaves the control removed: the next trusted move tries again", () => {
    const p = page();
    p.status("idle");
    p.whenIdle.make.mockImplementationOnce(() => {
      throw new Error("no iframe");
    });
    expect(() => p.move()).not.toThrow();
    expect(p.frames).toHaveLength(1);
    p.move();
    expect(p.whenIdle.make).toHaveBeenCalledTimes(2);
    expect(p.frames).toHaveLength(2);
    expect(p.frames[1]!.kinds()).toEqual(["hello"]);
    p.move();
    expect(p.whenIdle.make).toHaveBeenCalledTimes(2);
  });

  it("a trusted pointerdown over the picture (a tap) makes the frame; an untrusted one or one off the picture does not", () => {
    const p = page();
    p.status("idle");
    const down = (over: { isTrusted?: boolean; x?: number; y?: number }) =>
      p.win.fire("pointerdown", { type: "pointerdown", isTrusted: over.isTrusted ?? true, pointerType: "touch", pointerId: 7, clientX: over.x ?? 640, clientY: over.y ?? 360, target: {} });
    down({ isTrusted: false });
    down({ ...OFF_PICTURE });
    expect(p.whenIdle.make).not.toHaveBeenCalled();
    down({});
    expect(p.whenIdle.make).toHaveBeenCalledTimes(1);
  });

  it("with intent: page, a page-wide move while the video plays does not remake a dropped frame; a move over the picture does", () => {
    const p = page({ intent: "page" });
    p.status("idle");
    p.video.paused = false;
    p.move(OFF_PICTURE);
    p.advance(1500);
    p.move(OFF_PICTURE);
    expect(p.whenIdle.make).not.toHaveBeenCalled();
    expect(p.frames.flatMap((f) => f.got)).toEqual([]);
    p.move();
    expect(p.whenIdle.make).toHaveBeenCalledTimes(1);
    // Once the new frame is connected, an intent is sent to it as usual.
    p.ready(NEW_ID);
    p.advance(1500);
    p.move(OFF_PICTURE);
    expect(p.frames[1]!.kinds()).toContain("intent");
    expect(p.whenIdle.make).toHaveBeenCalledTimes(1);
  });

  it("on a paused video, a page-wide move does nothing after remove, and a move over the picture makes the frame", () => {
    const p = page({ intent: "page" });
    p.status("idle");
    p.video.paused = true;
    p.move(OFF_PICTURE);
    expect(p.whenIdle.make).not.toHaveBeenCalled();
    expect(p.frames.flatMap((f) => f.got)).toEqual([]);
    p.move();
    expect(p.whenIdle.make).toHaveBeenCalledTimes(1);
  });

  it("without intent: page, a move away from the video does not make a frame", () => {
    const p = page();
    p.status("idle");
    p.move(OFF_PICTURE);
    expect(p.whenIdle.make).not.toHaveBeenCalled();
  });

  it("stop() after remove makes nothing; stop() during make connects nothing", () => {
    const a = page();
    a.status("idle");
    a.control.stop();
    a.move();
    expect(a.whenIdle.make).not.toHaveBeenCalled();

    const b = page();
    b.status("idle");
    b.whenIdle.make.mockImplementationOnce(() => {
      b.control.stop();
    });
    b.move();
    expect(b.whenIdle.make).toHaveBeenCalledTimes(1);
    expect(b.frames).toHaveLength(1);
    expect(b.frames[0]!.got).toEqual([]);
  });

  it("stop() during remove makes nothing afterwards", () => {
    const p = page();
    p.whenIdle.remove.mockImplementationOnce(() => {
      p.control.stop();
    });
    p.status("idle");
    p.move();
    expect(p.whenIdle.make).not.toHaveBeenCalled();
  });

  it("without the option nothing changes: idle is reported, the frame stays, an intent is sent to it", () => {
    const seen: unknown[] = [];
    const p = page({ whenIdle: "off", intent: "page", onStatus: (s) => void seen.push(s) });
    const old = p.frames[0]!;
    p.status("idle");
    expect(seen).toHaveLength(1);
    expect(p.control.connected).toBe(true);
    p.move(OFF_PICTURE);
    expect(old.kinds()).toContain("intent");
    expect(p.whenIdle.remove).not.toHaveBeenCalled();
    expect(p.whenIdle.make).not.toHaveBeenCalled();
  });
});

describe("a frame made at play and dropped when idle", () => {
  it("remove() runs once, the play trigger does not fire again, and the next trusted move over the video makes the frame", () => {
    const p = page();
    // The video the control watches: registered while paused, then it plays.
    const playVideo = p.video;
    playVideo.paused = true;
    const trigger = vi.fn();
    loadWhen(playVideo as unknown as HTMLVideoElement, "play", trigger);
    playVideo.paused = false;
    playVideo.fire("playing");
    expect(trigger).toHaveBeenCalledTimes(1);
    p.status("idle");
    expect(p.whenIdle.remove).toHaveBeenCalledTimes(1);
    expect(p.control.frameRemoved).toBe(true);
    // A stall, a seek or a loop fires `playing` again; the trigger is spent and the control makes nothing.
    playVideo.fire("playing");
    playVideo.fire("playing");
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(p.whenIdle.make).not.toHaveBeenCalled();
    expect(p.frames).toHaveLength(1);
    p.move({ isTrusted: false });
    expect(p.whenIdle.make).not.toHaveBeenCalled();
    p.move();
    expect(p.whenIdle.make).toHaveBeenCalledTimes(1);
    expect(p.frames[1]!.kinds()).toEqual(["hello"]);
  });
});

describe("the frame's state (row 9)", () => {
  class FakeWorker implements WorkerLike {
    onmessage: WorkerLike["onmessage"] = null;
    onerror: WorkerLike["onerror"] = null;
    postMessage() {}
    terminate() {}
    reply(data: unknown) {
      this.onmessage?.({ data } as MessageEvent<WorkerReply>);
    }
  }
  const request: LoadRequest = { kind: "load", releaseUrl: "extension://x/release/release.json", wasmPaths: "w/" };

  function frameSetup() {
    const workers: FakeWorker[] = [];
    const clock = { now: 1_000 };
    const parent = { postMessage: () => {} };
    let listener: ((event: MessageEvent) => void) | null = null;
    const env: ComputeFrameEnv = {
      win: {
        parent,
        addEventListener: (_: "message", l: (event: MessageEvent) => void) => void (listener = l),
        removeEventListener: () => void (listener = null),
      },
      framed: true,
      parentOrigin: "https://video.example",
      allowedParentOrigin: (o) => o === "https://video.example",
      protocol,
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      loadRequest: request,
      now: () => clock.now,
      idleUnloadMs: 10_000,
    };
    const frame = startComputeFrame(env)!;
    const send = (data: unknown) => listener?.({ data, source: parent, origin: "https://video.example" } as unknown as MessageEvent);
    return { frame, workers, clock, send };
  }

  it("reads loading, ready, idle, loading, ready", () => {
    const t = frameSetup();
    expect(t.frame.state).toBe("loading");
    t.workers[0]!.reply({ kind: "release-status", ok: true, error: null, release: RELEASE, cards: [] });
    expect(t.frame.state).toBe("ready");
    for (let i = 0; i < 25; i++) {
      t.clock.now += 500;
      t.frame.tick();
    }
    expect(t.frame.state).toBe("idle");
    // The core still reads `loading` while idle: `state` is how a product tells idle from loading.
    expect(t.frame.core?.status().state).toBe("loading");
    t.send(tag({ kind: "intent" }));
    expect(t.frame.state).toBe("loading");
    t.workers[1]!.reply({ kind: "release-status", ok: true, error: null, release: RELEASE, cards: [] });
    expect(t.frame.state).toBe("ready");
  });
});
