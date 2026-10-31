// SPDX-License-Identifier: Apache-2.0
// createSession, the same-document adapter, end to end with stand-ins for the <video> and <img>
// elements, the worker, the 2D canvas, the cut sampler and the clock: what it shows, when it
// looks, its status, its 0.5.1 worker restart, and the two documented differences from 0.5.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FrameSignature, FrameSource } from "../src/capture.js";
import { DRIVER_TICK_MS } from "../src/frame-scheduler.js";
import type { FrameResult, ReleaseStatus, WorkerReply, WorkerRequest } from "../src/messages.js";
import type { FrameAnalysis } from "../src/pipeline.js";
import { createSession, type Session } from "../src/session.js";
import { plainLoad } from "../src/worker-session.js";

// The cut sampler is WebGL2 in a browser; here a stand-in, off (no WebGL2) unless a test sets it.
const fakes = vi.hoisted(() => ({ sampler: null as null | (() => unknown) }));
vi.mock("../src/capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/capture.js")>();
  return { ...actual, createSignatureSampler: () => (fakes.sampler ? fakes.sampler() : null) };
});

// ------------------------------------------------------------------ stand-ins
type Listener = (event: unknown) => void;

class FakeElement {
  readonly listeners = new Map<string, Set<Listener>>();
  rect = { left: 100, top: 50, width: 960, height: 540 };
  objectFit = "contain";
  isConnected = true;
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string, event: unknown = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
  getBoundingClientRect() {
    return { ...this.rect };
  }
}

/** A video without video-frame callbacks (`timeupdate` and `seeked` report its frames). */
class FakePlainVideo extends FakeElement {
  videoWidth = 1920;
  videoHeight = 1080;
  readyState = 4;
  paused = true;
  currentTime = 3;
}

class FakeVideo extends FakePlainVideo {
  private readonly callbacks = new Map<number, () => void>();
  private nextCallback = 1;
  readonly cancelled: number[] = [];
  requestVideoFrameCallback(cb: () => void): number {
    const id = this.nextCallback++;
    this.callbacks.set(id, cb);
    return id;
  }
  cancelVideoFrameCallback(id: number): void {
    this.cancelled.push(id);
    this.callbacks.delete(id);
  }
  get pendingCallbacks(): number[] {
    return [...this.callbacks.keys()];
  }
  get pendingFunctions(): Array<() => void> {
    return [...this.callbacks.values()];
  }
  /** The browser presents a frame: the pending video-frame callbacks run. */
  present(): void {
    const due = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const cb of due) cb();
  }
}

class FakeImage extends FakeElement {
  naturalWidth = 1920;
  naturalHeight = 1080;
}

class FakeWorker {
  static all: FakeWorker[] = [];
  /** Called with each frame request, at the time it is posted. */
  static onFrame: ((request: Extract<WorkerRequest, { kind: "frame" }>) => void) | null = null;
  readonly posted: WorkerRequest[] = [];
  terminated = false;
  onmessage: ((event: { data: WorkerReply }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
    if (message.kind === "frame") FakeWorker.onFrame?.(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: WorkerReply): void {
    this.onmessage?.({ data });
  }
  fail(message: string): void {
    this.onerror?.({ message });
  }
  frames(): Array<Extract<WorkerRequest, { kind: "frame" }>> {
    return this.posted.filter((m): m is Extract<WorkerRequest, { kind: "frame" }> => m.kind === "frame");
  }
}

/** The 2D canvas: what was drawn, and whether the picture may be read or is blank. */
const canvasState = { unreadable: false, blankChecks: 0, bitmaps: 0 };
function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: (kind: string) =>
      kind === "2d"
        ? {
            drawImage: () => {},
            getImageData: (_x: number, _y: number, w: number, h: number) => {
              if (canvasState.unreadable) throw new DOMException("The canvas has been tainted", "SecurityError");
              if (w === 16 && h === 16) canvasState.blankChecks += 1;
              // A uniform picture: blank when the blank check reads it.
              return { data: new Uint8ClampedArray(w * h * 4) };
            },
          }
        : null,
  };
  return canvas;
}

function fakeBitmap() {
  canvasState.bitmaps += 1;
  return { width: 1920, height: 1080, closed: false, close() { this.closed = true; } };
}

/** A signature sampler whose samples read back as the given signatures, in order. */
function fakeSampler(signatures: FrameSignature[]) {
  let next = 1;
  const sampler = {
    usable: true,
    disposed: false,
    sample: () => ({ id: next++ }),
    read: () => signatures.shift() ?? null,
    release: () => {},
    dispose() {
      this.disposed = true;
    },
  };
  return sampler;
}
const signature = (level: number): FrameSignature => ({ width: 128, height: 72, luma: new Uint8Array(128 * 72).fill(level) });

// ------------------------------------------------------------------ fixtures
const release: NonNullable<ReleaseStatus["release"]> = {
  id: "toy-release",
  game: "toy-game",
  locale: "en",
  detector: { version: "d", ep: "wasm" },
  recognizer: { version: "r", ep: "wasm" },
  bankCards: 2,
  catalogCards: 2,
  identityLevel: "printing",
  decode: { threshold: 0.3, nmsIou: 0.45, maxProposals: 80, minCropPx: 24 },
  accept: { tau: 0.62, delta: 0.05 } as never,
  hoverSelection: "accepted-nms",
  hoverMaxAgeMs: 2000,
  analysisWidth: { min: 720, max: 1920 },
  ortWeb: "1.29.0",
};
const loaded: ReleaseStatus = { kind: "release-status", ok: true, error: null, release, cards: [{ id: "T-001", name: "Card One", art: null }] as never };

/** One card in the x 0.25..0.375, y 0.25..0.5 part of a 1920 x 1080 frame: pixels x 480..720,
 *  y 270..540. Dyadic fractions, so every product below is exact. */
const CARD = { cardId: "T-001", name: "Card One", bounds: { x: 0.25, y: 0.25, width: 0.125, height: 0.25 } };

function analysisWith(cards: Array<typeof CARD>): FrameAnalysis {
  return {
    frame: { width: 1920, height: 1080 },
    boxes: [],
    hover: {
      selection: "accepted-nms",
      cards: cards.map((c, i) => ({
        instanceId: `c${i}`,
        bounds: c.bounds,
        rotation: 0,
        localWidth: c.bounds.width,
        localHeight: c.bounds.height,
        landscape: true,
        cardId: c.cardId,
        name: c.name,
        boxIndex: i,
      })),
    },
  } as unknown as FrameAnalysis;
}

function resultFor(request: Extract<WorkerRequest, { kind: "frame" }>, over: Partial<FrameResult> = {}): FrameResult {
  return { kind: "frame-result", envelope: request.envelope, videoTimeSec: request.videoTimeSec, width: 1920, height: 1080, workerMs: 5, analysis: analysisWith([CARD]), ...over };
}

// ------------------------------------------------------------------ the harness
let clock = 0;
let updates = 0;
let session: Session | null = null;

function start(element: FakeElement, options: { mode?: "pointer" | "always-on"; geometric?: boolean } = {}): Session {
  session = createSession(element as unknown as FrameSource, {
    releaseUrl: "release.json",
    workerUrl: "https://example.test/worker.js",
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.geometric ? { geometricUrl: "geometric/settings.json" } : {}),
    onUpdate: () => {
      updates += 1;
    },
  });
  return session;
}
const worker = (): FakeWorker => FakeWorker.all.at(-1)!;

/** Let the pictures being taken arrive (they resolve in microtasks). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
/** One driver tick, at the current `clock`. */
async function tick(): Promise<void> {
  vi.advanceTimersByTime(DRIVER_TICK_MS);
  await flush();
}
async function move(element: FakeElement, clientX: number, clientY: number): Promise<void> {
  element.fire("pointermove", { clientX, clientY, pointerType: "mouse" });
  await flush();
}

beforeEach(() => {
  FakeWorker.all = [];
  FakeWorker.onFrame = null;
  fakes.sampler = null;
  clock = 0;
  updates = 0;
  Object.assign(canvasState, { unreadable: false, blankChecks: 0, bitmaps: 0 });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("HTMLVideoElement", FakePlainVideo);
  vi.stubGlobal("location", { href: "https://example.test/demo/" });
  vi.stubGlobal("document", { createElement: () => fakeCanvas() });
  vi.stubGlobal("getComputedStyle", (el: FakeElement) => ({ objectFit: el.objectFit }));
  vi.stubGlobal("createImageBitmap", async () => fakeBitmap());
});

afterEach(() => {
  session?.stop();
  session = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A ready session on a paused video showing CARD at (400, 250) (fractions 0.3125, 0.37). */
async function showing<V extends FakePlainVideo = FakeVideo>(video: V = new FakeVideo() as unknown as V): Promise<{ video: V; s: Session }> {
  const s = start(video);
  worker().reply(loaded);
  await move(video, 400, 250);
  const look = worker().frames().at(-1)!;
  worker().reply(resultFor(look));
  expect(s.atPointer()?.cardId).toBe("T-001");
  return { video, s };
}

// ------------------------------------------------------------------ (1) the rc2 sim
/**
 * The session loop of scheduler.test.ts (`pausedWithSlowFirstLook`, pictures received) driven
 * through createSession: a paused video under a moving pointer over a card, a tick every
 * DRIVER_TICK_MS, a worker that takes `firstMs` for the first picture and 100 ms for later ones
 * and answers "busy" while it works. Replies are delivered at the start of the tick they are due
 * by, then the pointer moves, then the driver ticks.
 */
async function slowFirstLook(firstMs: number, endMs: number): Promise<{ sent: number[]; analyzed: number[] }> {
  const video = new FakeVideo();
  const s = start(video);
  const sent: number[] = [];
  const analyzed: number[] = [];
  const replies: Array<{ at: number; reply: FrameResult }> = [];
  let workerFreeAt = -Infinity;
  let pictures = 0;
  FakeWorker.onFrame = (request) => {
    const t = clock;
    sent.push(t);
    if (t < workerFreeAt) {
      replies.push({ at: t, reply: resultFor(request, { analysis: null, error: "busy" }) });
    } else {
      pictures += 1;
      workerFreeAt = t + (pictures === 1 ? firstMs : 100);
      replies.push({ at: workerFreeAt, reply: resultFor(request) });
    }
  };
  worker().reply(loaded);
  // Deliver only the replies due before this tick's pointer move (a busy reply posted during a
  // tick arrives at the next one, as in the scheduler's loop).
  for (let t = 0; t <= endMs; t += DRIVER_TICK_MS) {
    clock = t;
    const due = replies.filter((r) => r.at <= t);
    for (const r of due) {
      replies.splice(replies.indexOf(r), 1);
      const before = s.status().frames;
      worker().reply(r.reply);
      if (s.status().frames > before) analyzed.push(t);
    }
    await move(video, 400, 250);
    await tick();
  }
  return { sent, analyzed };
}

describe("createSession reproduces the scheduler's session loop", () => {
  // The same times as scheduler.test.ts (PINNED_SLOW_FIRST_LOOK) and session-core.test.ts.
  it("a first look of 6 s", async () => {
    expect(await slowFirstLook(6_000, 20_000)).toEqual({ sent: [0, 6_000, 6_250], analyzed: [6_000, 6_250, 6_500] });
  });

  it("a first look of 12 s", async () => {
    expect(await slowFirstLook(12_000, 20_000)).toEqual({ sent: [0, 12_000, 12_250], analyzed: [12_000, 12_250, 12_500] });
  });

  it("a first look of 18 s, given up on at FIRST_ANALYSIS_WATCHDOG_MS", async () => {
    expect(await slowFirstLook(18_000, 30_000)).toEqual({
      sent: [0, 15_250, 16_250, 17_500, 19_750, 20_000, 20_250],
      analyzed: [20_000, 20_250, 20_500],
    });
  });
});

// ------------------------------------------------------------------ (2) at() in client pixels
describe("at() in client pixels", () => {
  // Hand-computed. A 1920 x 1080 picture in a 960 x 540 box at (100, 50) with object-fit
  // contain fills the box (scale 0.5). CARD's frame box is x 0.25 * 1920 = 480, y 0.25 * 1080 =
  // 270, 0.125 * 1920 = 240 wide, 0.25 * 1080 = 270 high; on the page: left 100 + 480 * 0.5 =
  // 340, top 50 + 270 * 0.5 = 185, 120 x 135. The pointer (400, 250) is frame pixel
  // ((400 - 100) * 2, (250 - 50) * 2) = (600, 400), inside the card.
  it("a 1920 x 1080 frame shown in a 960 x 540 box", async () => {
    const { s } = await showing();
    const expected = { name: "Card One", cardId: "T-001", box: { left: 340, top: 185, width: 120, height: 135 }, frameBox: { x: 480, y: 270, width: 240, height: 270 } };
    expect(s.at(400, 250)).toEqual(expected);
    expect(s.atPointer()).toEqual(expected);
    // The card's edges are inside; a pixel past them is not.
    expect(s.at(340, 185)?.cardId).toBe("T-001");
    expect(s.at(460, 320)?.cardId).toBe("T-001");
    expect(s.at(339, 250)).toBeNull();
    expect(s.at(461, 250)).toBeNull();
  });

  // The same picture in a 960 x 720 box: contain leaves 90 px bars above and below (the picture
  // is 960 x 540 at top 50 + 90 = 140). The card is at left 340, top 140 + 135 = 275, 120 x 135.
  it("with letterbox bars", async () => {
    const video = new FakeVideo();
    video.rect = { left: 100, top: 50, width: 960, height: 720 };
    const s = start(video);
    worker().reply(loaded);
    await move(video, 400, 340);
    worker().reply(resultFor(worker().frames().at(-1)!));
    expect(s.at(400, 340)).toEqual({ name: "Card One", cardId: "T-001", box: { left: 340, top: 275, width: 120, height: 135 }, frameBox: { x: 480, y: 270, width: 240, height: 270 } });
    // In the bar above the picture: nothing.
    expect(s.at(400, 100)).toBeNull();
  });
});

// ------------------------------------------------------------------ (3) what is never shown
describe("what is never shown", () => {
  it("a reply from before a seek", async () => {
    const video = new FakeVideo();
    const s = start(video);
    worker().reply(loaded);
    await move(video, 400, 250);
    const look = worker().frames().at(-1)!;
    video.fire("seeking");
    worker().reply(resultFor(look));
    expect(s.analysis()).toBeNull();
    expect(s.at(400, 250)).toBeNull();
    expect(s.atPointer()).toBeNull();
  });

  it("a picture taken for a look asked before a seek (it is closed, never analyzed)", async () => {
    const video = new FakeVideo();
    start(video);
    worker().reply(loaded);
    let bitmap: ReturnType<typeof fakeBitmap> | null = null;
    vi.stubGlobal("createImageBitmap", async () => (bitmap = fakeBitmap()));
    video.fire("pointermove", { clientX: 400, clientY: 250, pointerType: "mouse" });
    video.fire("seeking");
    await flush();
    expect(worker().frames()).toHaveLength(0);
    expect(bitmap!.closed).toBe(true);
  });

  it("a reply older than the release's hoverMaxAgeMs", async () => {
    const { video, s } = await showing();
    // 1.5 s of video time later: still shown (hoverMaxAgeMs 2000), and nothing to tell.
    const seen = updates;
    video.currentTime = 4.5;
    video.present();
    expect(s.at(400, 250)?.cardId).toBe("T-001");
    expect(updates).toBe(seen);
    // 2.5 s later: no longer, and onUpdate says so.
    video.currentTime = 5.5;
    video.present();
    expect(updates).toBe(seen + 1);
    expect(s.analysis()).toBeNull();
    expect(s.at(400, 250)).toBeNull();
    expect(s.atPointer()).toBeNull();
  });
});

// ------------------------------------------------------------------ (4) status
describe("status()", () => {
  it("goes loading -> ready with the backend, the release and the loading phases", () => {
    const s = start(new FakeVideo());
    expect(s.status()).toMatchObject({ state: "loading", error: null, release: null, backend: null, loading: null, geometric: null, frames: 0 });
    const seen = updates;
    worker().reply({ kind: "release-progress", phase: "downloading", bytes: 1234 });
    expect(s.status().loading).toEqual({ phase: "downloading", bytes: 1234 });
    worker().reply({ kind: "release-progress", phase: "preparing", bytes: null });
    expect(s.status().loading).toEqual({ phase: "preparing", bytes: null });
    worker().reply(loaded);
    expect(s.status()).toMatchObject({ state: "ready", error: null, backend: "wasm", loading: null });
    expect(s.status().release?.id).toBe("toy-release");
    expect(s.cards()).toEqual(loaded.cards);
    expect(updates).toBe(seen + 3);
    // A late progress reply changes nothing.
    worker().reply({ kind: "release-progress", phase: "downloading", bytes: 1 });
    expect(s.status().loading).toBeNull();
  });

  it("starts the geometric stage's status as loading when one is asked for", () => {
    const s = start(new FakeVideo(), { geometric: true });
    expect(s.status().geometric).toEqual({ state: "loading", reason: null, bytes: null });
    expect(worker().posted[0]).toMatchObject({ kind: "load", releaseUrl: "https://example.test/demo/release.json", geometricUrl: "https://example.test/demo/geometric/settings.json" });
  });

  it("fails on a refused release", () => {
    const s = start(new FakeVideo());
    worker().reply({ kind: "release-status", ok: false, error: "the bank does not match", release: null, cards: [] });
    expect(s.status()).toMatchObject({ state: "failed", error: "the bank does not match", backend: null });
  });

  it("is stopped after stop()", async () => {
    const { s } = await showing();
    s.stop();
    expect(s.status()).toMatchObject({ state: "stopped", loading: null });
    expect(s.analysis()).toBeNull();
    expect(s.atPointer()).toBeNull();
  });
});

// ------------------------------------------------------------------ (5) the 0.5.1 restart
describe("a worker that stops after the release has loaded (0.5.1)", () => {
  it("restarts once: what was shown is cleared, loading then ready; a second stop fails", async () => {
    const { video, s } = await showing();
    const first = worker();
    const seen = updates;
    first.fail("out of memory");
    expect(first.terminated).toBe(true);
    expect(FakeWorker.all).toHaveLength(2);
    expect(s.atPointer()).toBeNull();
    expect(s.analysis()).toBeNull();
    expect(s.status()).toMatchObject({ state: "loading", error: null });
    expect(updates).toBe(seen + 1);
    const second = worker();
    expect(second.posted).toEqual([plainLoad(first.posted[0] as Extract<WorkerRequest, { kind: "load" }>)]);

    second.reply(loaded);
    expect(s.status().state).toBe("ready");
    // It looks again, on the new worker (at the release's cadence).
    for (clock = 250; second.frames().length === 0 && clock <= 5_000; clock += DRIVER_TICK_MS) {
      await move(video, 401, 250);
      await tick();
    }
    expect(second.frames().length).toBeGreaterThan(0);

    second.fail("again");
    expect(s.status()).toMatchObject({ state: "failed", error: "the recognition worker stopped (again)" });
    expect(FakeWorker.all).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ (6) the documented differences
describe("the two documented differences from 0.5", () => {
  // (a) 0.5 posted the unreadable picture and the worker answered `analysis-failed: SecurityError`.
  it("an unreadable source: lastFrameError says so and no picture goes to the worker", async () => {
    canvasState.unreadable = true;
    const video = new FakeVideo();
    const s = start(video);
    worker().reply(loaded);
    await move(video, 400, 250);
    expect(s.status().lastFrameError).toBe("capture-failed: the video may not be read");
    expect(worker().frames()).toHaveLength(0);
    expect(canvasState.bitmaps).toBe(0);
  });

  // (b) 0.5 analyzed whatever a paused video not ready to draw gave (an empty frame).
  it("a paused video that cannot draw its picture (readyState < 2) is looked at again after 250 ms", async () => {
    const video = new FakeVideo();
    video.readyState = 1;
    const s = start(video);
    worker().reply(loaded);
    clock = 1_000;
    await move(video, 400, 250);
    expect(canvasState.blankChecks).toBe(1);
    expect(s.status().lastFrameError).toBe("capture-failed: no picture (the paused video draws nothing)");
    expect(worker().frames()).toHaveLength(0);
    clock = 1_250;
    await tick();
    expect(canvasState.blankChecks).toBe(2);
    // Once the picture can be drawn, the next try reaches the worker.
    video.readyState = 4;
    for (clock = 1_500; worker().frames().length === 0 && clock <= 4_000; clock += DRIVER_TICK_MS) await tick();
    expect(worker().frames()).toHaveLength(1);
    expect(clock - DRIVER_TICK_MS).toBeLessThanOrEqual(2_250);
  });
});

// ------------------------------------------------------------------ (7) stop
describe("stop()", () => {
  it("removes every listener, cancels the frame callback, ends the worker and the driver", async () => {
    const sampler = fakeSampler([]);
    fakes.sampler = () => sampler;
    const { video, s } = await showing();
    video.present(); // a tooltip shows: the sampler is made
    expect(video.listenerCount()).toBeGreaterThan(0);
    const pending = video.pendingCallbacks;
    expect(pending).toHaveLength(1);
    const seen = updates;
    s.stop();
    expect(video.listenerCount()).toBe(0);
    expect(video.cancelled).toEqual(pending);
    expect(worker().terminated).toBe(true);
    expect(sampler.disposed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(updates).toBe(seen);
    // Nothing moves it any more.
    video.fire("seeking");
    worker().reply(loaded);
    expect(s.status().state).toBe("stopped");
    expect(updates).toBe(seen);
  });

  it("on an image too", () => {
    const image = new FakeImage();
    const s = start(image);
    expect(image.listenerCount()).toBe(4); // load, pointermove, pointerdown, pointerleave
    s.stop();
    expect(image.listenerCount()).toBe(0);
    expect(worker().terminated).toBe(true);
  });
});

// ------------------------------------------------------------------ (8) a cut
describe("a cut from the sampler", () => {
  it("clears what is shown and looks again at once", async () => {
    const sampler = fakeSampler([signature(100), signature(200)]);
    fakes.sampler = () => sampler;
    clock = 0;
    const { video, s } = await showing();
    const looks = worker().frames().length;
    clock = 100;
    video.present(); // the first live sample is issued
    clock = 200;
    video.present(); // it reads 100: the reference; a second sample is issued
    expect(s.atPointer()?.cardId).toBe("T-001");
    const seen = updates;
    clock = 300;
    video.present(); // it reads 200: far from the reference over the card's box, a cut
    expect(s.analysis()).toBeNull();
    expect(s.atPointer()).toBeNull();
    expect(updates).toBeGreaterThan(seen);
    // At the next tick, long before the cadence would look again.
    await tick();
    expect(worker().frames()).toHaveLength(looks + 1);
  });
});

// ------------------------------------------------------------------ onUpdate, images
describe("onUpdate", () => {
  it("fires once per pointer move, leave and seek, and not for a presented frame that changes nothing", async () => {
    const { video } = await showing();
    let seen = updates;
    await move(video, 401, 250);
    expect(updates).toBe(seen + 1);
    seen = updates;
    video.present();
    expect(updates).toBe(seen);
    video.fire("pointerleave", {});
    expect(updates).toBe(seen + 1);
    video.fire("seeking");
    expect(updates).toBe(seen + 2);
  });
});

describe("an image", () => {
  it("is captured whole at time 0, and a new image clears the result", async () => {
    const image = new FakeImage();
    image.objectFit = "fill";
    const s = start(image);
    worker().reply(loaded);
    await move(image, 400, 250);
    const look = worker().frames().at(-1)!;
    expect(look.videoTimeSec).toBe(0);
    worker().reply(resultFor(look));
    expect(s.at(400, 250)).toMatchObject({ cardId: "T-001", box: { left: 340, top: 185, width: 120, height: 135 } });
    image.fire("load");
    expect(s.analysis()).toBeNull();
  });
});

// ------------------------------------------------------------------ review follow-ups
describe("a worker that cannot be made", () => {
  it("makes createSession throw the error, as 0.5 did, before anything is attached", () => {
    const refused = new DOMException("cross-origin worker", "SecurityError");
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw refused;
        }
      },
    );
    const video = new FakeVideo();
    expect(() => start(video)).toThrow(refused);
    session = null;
    expect(video.listenerCount()).toBe(0);
    expect(video.pendingCallbacks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(updates).toBe(0);
  });

  it("fails the session when the restarted worker cannot be made (0.5 threw from onerror and stayed loading)", async () => {
    const { s } = await showing();
    const first = worker();
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("no more workers");
        }
      },
    );
    expect(() => first.fail("out of memory")).not.toThrow();
    expect(s.status()).toMatchObject({ state: "failed", error: "the recognition worker could not start (Error: no more workers)" });
    expect(s.atPointer()).toBeNull();
  });
});

describe("what a same-document session still analyzes (refused only in the two-frame contract)", () => {
  it("a video out of the page", async () => {
    const video = new FakeVideo();
    video.isConnected = false;
    start(video);
    worker().reply(loaded);
    await move(video, 400, 250);
    expect(worker().frames()).toHaveLength(1);
  });

  it("a frame taller than MAX_FRAME_SIDE", async () => {
    const video = new FakeVideo();
    // Analyzed 1080 wide, so 8000 high: above the contract's 4096.
    video.videoWidth = 1080;
    video.videoHeight = 8000;
    const s = start(video);
    worker().reply(loaded);
    await move(video, 400, 250);
    expect(s.status().lastFrameError).toBeNull();
    expect(worker().frames()).toHaveLength(1);
  });
});

describe("after stop()", () => {
  it("a picture that arrives is closed and goes nowhere", async () => {
    const video = new FakeVideo();
    const s = start(video);
    worker().reply(loaded);
    let resolve: (() => void) | null = null;
    const bitmap = fakeBitmap();
    vi.stubGlobal("createImageBitmap", () => new Promise((r) => (resolve = () => r(bitmap))));
    await move(video, 400, 250);
    expect(resolve).not.toBeNull();
    s.stop();
    const seen = updates;
    resolve!();
    await flush();
    expect(bitmap.closed).toBe(true);
    expect(worker().frames()).toHaveLength(0);
    expect(updates).toBe(seen);
  });

  it("a video-frame callback that still runs does nothing and asks for no other", async () => {
    const { video, s } = await showing();
    const [callback] = video.pendingFunctions;
    s.stop();
    const seen = updates;
    callback!();
    expect(video.pendingCallbacks).toHaveLength(0);
    expect(updates).toBe(seen);
  });
});

describe("a video without video-frame callbacks", () => {
  it("reports its frames on timeupdate, and the age of a result is judged on the video's time now (as 0.5)", async () => {
    const { video, s } = await showing(new FakePlainVideo());
    expect(video.listeners.has("timeupdate")).toBe(true);
    video.currentTime = 4.5;
    video.fire("timeupdate");
    expect(s.at(400, 250)?.cardId).toBe("T-001");
    // The video moved on before any frame was reported: its time now counts.
    video.currentTime = 5.5;
    expect(s.at(400, 250)).toBeNull();
    expect(s.analysis()).toBeNull();
  });
});

describe("a video already paused when the session starts", () => {
  it("in always-on mode, its analyses are shown with no pointer move and no frame reported", async () => {
    const video = new FakeVideo();
    video.currentTime = 4;
    const s = start(video, { mode: "always-on" });
    FakeWorker.onFrame = (request) => worker().reply(resultFor(request));
    worker().reply(loaded);
    for (clock = 0; s.status().frames < 3 && clock <= 10_000; clock += DRIVER_TICK_MS) await tick();
    expect(s.status().frames).toBe(3);
    expect(worker().frames().every((f) => f.videoTimeSec === 4)).toBe(true);
    expect(s.analysis()).not.toBeNull();
    expect(s.at(400, 250)).toMatchObject({ cardId: "T-001", box: { left: 340, top: 185, width: 120, height: 135 } });
    expect(video.listeners.has("pointermove")).toBe(true);
  });
});
