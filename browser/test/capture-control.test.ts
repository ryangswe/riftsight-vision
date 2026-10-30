// SPDX-License-Identifier: Apache-2.0
// The page-side capture controller with a stand-in window, document, video, compute frame,
// pointer events and clock (no DOM): trusted input only, hover and tap authority, full resets,
// revalidation at capture time, the message guard, the handshake, and bitmap ownership.
import { describe, expect, it, vi } from "vitest";

import {
  acceptComputeOut,
  CAPTURE_PENDING,
  type CaptureControlOptions,
  createCaptureControl,
  fromExtensionFrame,
  NOT_POINTING,
  PICTURE_CHANGED,
  postWithTransfer,
} from "../src/capture-control.js";
import { MAX_REST_MS, POINTER_GRACE_MS, READING_LINGER_MS } from "../src/capture-gate.js";
import { type ComputeOut, computeProtocol, PROTOCOL_VERSION } from "../src/compute-messages.js";

const ORIGIN = "chrome-extension://abcdefghijklmnop";
const TAG = "test-ext";
const INSTANCE_A = "0123456789abcdef";
const INSTANCE_B = "fedcba9876543210";
const RANGE = { min: 720, max: 1920 };

const protocol = computeProtocol(TAG);

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
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

function fakeVideo() {
  const target = fakeTarget();
  const rect = { left: 0, top: 0, width: 1280, height: 720 };
  return Object.assign(target, {
    rect,
    isConnected: true,
    videoWidth: 1280,
    videoHeight: 720,
    readyState: 4,
    paused: false,
    currentTime: 12.5,
    getBoundingClientRect: () => ({ ...rect }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ objectFit: "contain" }) } },
  });
}
type FakeVideo = ReturnType<typeof fakeVideo>;
const asVideo = (v: FakeVideo) => v as unknown as HTMLVideoElement;

function fakeBitmap() {
  return { width: 1280, height: 720, close: vi.fn() };
}
type FakeBitmap = ReturnType<typeof fakeBitmap>;

const fakeCanvas = (): HTMLCanvasElement =>
  ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }),
  }) as unknown as HTMLCanvasElement;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(options: Partial<Pick<CaptureControlOptions, "helloRetries" | "eligible" | "limits">> = {}) {
  let t = 1_000;
  const sent: Array<Record<string, unknown>> = [];
  const transfers: unknown[][] = [];
  let throwOnTransfer = false;
  const frameWindow = {
    postMessage: vi.fn((message: Record<string, unknown>, origin: string, transfer: unknown[] = []) => {
      expect(origin).toBe(ORIGIN);
      if (transfer.length && throwOnTransfer) throw new DOMException("could not clone", "DataCloneError");
      sent.push(message);
      transfers.push(transfer);
    }),
  };
  let frame: unknown = frameWindow;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const pendingBitmaps: Array<(b: FakeBitmap) => void> = [];
  const shown: unknown[] = [];
  const problems: unknown[] = [];
  const statuses: unknown[] = [];
  const control = createCaptureControl({
    protocol,
    frame: () => frame as Window | null,
    frameOrigin: ORIGIN,
    now: () => t,
    onShown: (card) => void shown.push(card),
    onProblem: (p) => void problems.push(p),
    onStatus: (s) => void statuses.push(s),
    timers: {
      set: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clear: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
    grab: {
      createCanvas: fakeCanvas,
      createImageBitmap: () => new Promise((resolve) => pendingBitmaps.push(resolve as (b: FakeBitmap) => void)) as unknown as Promise<ImageBitmap>,
    },
    ...options,
  });
  const win = fakeTarget();
  const root = { tagName: "HTML" };
  const doc = Object.assign(fakeTarget(), { documentElement: root, visibilityState: "visible" as string });
  const detach = control.listen(win as unknown as Window, doc as unknown as Document);
  const video = fakeVideo();

  const message = (data: object, over: Partial<{ isTrusted: boolean; source: unknown; origin: string }> = {}) =>
    ({ isTrusted: true, source: frame, origin: ORIGIN, data: protocol.tag(data), ...over }) as unknown as MessageEvent;
  const pointer = (type: string, over: Partial<{ x: number; y: number; pointerType: string; pointerId: number; isTrusted: boolean; target: unknown }> = {}) =>
    win.fire(type, {
      type,
      isTrusted: over.isTrusted ?? true,
      pointerType: over.pointerType ?? "mouse",
      pointerId: over.pointerId ?? 1,
      clientX: over.x ?? 640,
      clientY: over.y ?? 360,
      target: over.target ?? {},
    });

  const h = {
    control,
    video,
    win,
    doc,
    root,
    sent,
    transfers,
    shown,
    problems,
    statuses,
    timers,
    pendingBitmaps,
    frameWindow,
    detach,
    kinds: () => sent.map((m) => m.kind),
    clear: () => {
      sent.length = 0;
      transfers.length = 0;
    },
    advance: (ms: number) => {
      t += ms;
    },
    setFrame: (f: unknown) => {
      frame = f;
    },
    throwOnTransfer: (v: boolean) => {
      throwOnTransfer = v;
    },
    message,
    deliver: (data: object, over?: Parameters<typeof message>[1]) => control.onMessage(message(data, over)),
    ready: (instance = INSTANCE_A, version: unknown = PROTOCOL_VERSION) => control.onMessage(message({ kind: "ready", version, instance })),
    pointer,
    hover: (x = 640, y = 360) => pointer("pointermove", { x, y }),
    tap: (pointerId = 7, x = 640, y = 360) => pointer("pointerdown", { pointerType: "touch", pointerId, x, y }),
    request: (requestId = 1) => control.onMessage(message({ kind: "capture", requestId, analysisWidth: RANGE })),
    show: (cardId: string | null) =>
      control.onMessage(message({ kind: "shown", card: cardId ? { cardId, name: cardId, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 } } : null })),
    /** The last capture answer sent. */
    answer: () => sent.filter((m) => m.kind === "frame" || m.kind === "capture-failed").at(-1),
  };
  return h;
}

/** Attached and connected, nothing sent yet. */
function connected(options?: Parameters<typeof setup>[0]) {
  const h = setup(options);
  h.control.attach(asVideo(h.video));
  h.ready();
  h.clear();
  return h;
}

/** Ask for a picture and let the grab finish with a fresh bitmap. */
async function captureNow(h: ReturnType<typeof setup>, requestId = 1) {
  h.request(requestId);
  await flush();
  const bitmap = fakeBitmap();
  h.pendingBitmaps.shift()?.(bitmap);
  await flush();
  return bitmap;
}

describe("the message guard", () => {
  const frame = {} as Window;
  const data = protocol.tag({ kind: "shown", card: null });

  it("rejects an untrusted event with a forged source and origin, without reading its data", () => {
    const read = vi.fn(() => data);
    const forged = { isTrusted: false, source: frame, origin: ORIGIN, get data() {
      return read();
    } } as unknown as MessageEvent;
    expect(fromExtensionFrame(forged, frame, ORIGIN)).toBe(false);
    expect(acceptComputeOut(forged, { frame, origin: ORIGIN, protocol })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects another source, another origin or no frame, and takes a trusted one from the frame", () => {
    const ev = (over: object) => ({ isTrusted: true, source: frame, origin: ORIGIN, data, ...over }) as unknown as MessageEvent;
    expect(fromExtensionFrame(ev({ source: {} }), frame, ORIGIN)).toBe(false);
    expect(fromExtensionFrame(ev({ origin: "https://page.example" }), frame, ORIGIN)).toBe(false);
    expect(fromExtensionFrame(ev({ source: null }), null, ORIGIN)).toBe(false);
    expect(fromExtensionFrame(ev({}), frame, ORIGIN)).toBe(true);
    expect(acceptComputeOut(ev({}), { frame, origin: ORIGIN, protocol })).toEqual({ kind: "shown", card: null });
  });

  it("makes the controller ignore forged ready, shown and capture", async () => {
    const h = setup();
    h.control.attach(asVideo(h.video));
    expect(h.deliver({ kind: "ready", version: 1, instance: INSTANCE_A }, { isTrusted: false })).toBe(false);
    expect(h.control.connected).toBe(false);
    h.ready();
    h.hover();
    h.clear();
    expect(h.deliver({ kind: "shown", card: null }, { isTrusted: false })).toBe(false);
    expect(h.deliver({ kind: "capture", requestId: 1, analysisWidth: RANGE }, { isTrusted: false })).toBe(false);
    expect(h.deliver({ kind: "capture", requestId: 1, analysisWidth: RANGE }, { source: {} })).toBe(false);
    expect(h.deliver({ kind: "capture", requestId: 1, analysisWidth: RANGE }, { origin: "https://page.example" })).toBe(false);
    await flush();
    expect(h.shown).toEqual([]);
    expect(h.sent).toEqual([]);
    // The real frame's capture still works.
    await captureNow(h);
    expect(h.answer()).toMatchObject({ kind: "frame", requestId: 1 });
  });
});

describe("capture authority", () => {
  it("refuses a never-hovered page, whatever the frame asks", async () => {
    const h = connected();
    h.show("card");
    await captureNow(h);
    expect(h.answer()).toMatchObject({ kind: "capture-failed", requestId: 1, reason: NOT_POINTING, retry: false });
    expect(h.pendingBitmaps).toEqual([]);
  });

  it("ignores untrusted pointer events", async () => {
    const h = connected();
    h.pointer("pointermove", { isTrusted: false });
    h.pointer("pointerdown", { isTrusted: false, pointerType: "touch" });
    expect(h.sent).toEqual([]);
    await captureNow(h);
    expect(h.answer()).toMatchObject({ kind: "capture-failed", reason: NOT_POINTING });
  });

  it("gives a picture after a trusted hover, with the pointer message dated by the watch", async () => {
    const h = connected();
    h.hover(320, 180);
    expect(h.sent).toEqual([expect.objectContaining({ kind: "pointer", x: 0.25, y: 0.25, mediaTime: 12.5, touch: false })]);
    const bitmap = await captureNow(h, 3);
    expect(h.answer()).toMatchObject({ kind: "frame", requestId: 3, mediaTime: 12.5 });
    expect(h.transfers.at(-1)).toEqual([bitmap]);
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it("keeps a resting hover while a card shows and for the linger after, then stops", () => {
    const h = connected();
    h.hover();
    h.show("card");
    h.advance(POINTER_GRACE_MS + 1);
    expect(h.control.captureAllowedNow()).toBe(true);
    h.show(null);
    h.advance(READING_LINGER_MS - 1);
    expect(h.control.captureAllowedNow()).toBe(true);
    h.advance(2);
    expect(h.control.captureAllowedNow()).toBe(false);
  });

  it("revalidates the resting point: a video moved away under a still pointer is refused", async () => {
    const h = connected();
    h.hover();
    h.show("card");
    h.clear();
    // A keyboard scroll moves the video; the pointer does not move.
    h.video.rect.top = -2000;
    await captureNow(h);
    expect(h.answer()).toMatchObject({ kind: "capture-failed", reason: NOT_POINTING, retry: false });
    expect(h.kinds()).toEqual(["leave", "capture-failed"]);
    // Moving it back does not revive anything: the gate was cleared.
    h.video.rect.top = 0;
    expect(h.control.gateState()).toEqual({ inside: false, lastTrustedPointerAt: -Infinity, tooltipShowing: false, lastTooltipAt: -Infinity });
    expect(h.control.captureAllowedNow()).toBe(false);
  });

  it("uses the product's eligible rule", () => {
    const h = setup();
    const eligible = vi.fn((x: number) => (x < 100 ? null : { x: 0.5, y: 0.5 }));
    const control = createCaptureControl({ protocol, frame: () => null, frameOrigin: ORIGIN, now: () => 0, eligible });
    const win = fakeTarget();
    control.listen(win as unknown as Window, h.doc as unknown as Document);
    control.attach(asVideo(h.video));
    win.fire("pointermove", { type: "pointermove", isTrusted: true, pointerType: "mouse", pointerId: 1, clientX: 50, clientY: 50 });
    expect(control.gateState().inside).toBe(false);
    win.fire("pointermove", { type: "pointermove", isTrusted: true, pointerType: "mouse", pointerId: 1, clientX: 150, clientY: 50 });
    expect(control.gateState().inside).toBe(true);
    expect(eligible).toHaveBeenLastCalledWith(150, 50, h.video);
  });

  it("ends a resting hover MAX_REST_MS after the last trusted event, even while a card shows", () => {
    const h = connected();
    h.hover();
    h.show("card");
    h.advance(MAX_REST_MS - 1);
    // Forged pointer messages to the frame keep the card showing; the point is still valid.
    h.show("card");
    expect(h.control.captureAllowedNow()).toBe(true);
    h.advance(1);
    h.show("card");
    expect(h.control.captureAllowedNow()).toBe(false);
    // A fresh trusted move restores it.
    h.hover(600, 300);
    expect(h.control.captureAllowedNow()).toBe(true);
  });

  it("passes another rest cap through", () => {
    const h = connected({ limits: { restMs: 20_000 } });
    h.hover();
    h.show("card");
    h.advance(19_999);
    expect(h.control.captureAllowedNow()).toBe(true);
    h.advance(1);
    expect(h.control.captureAllowedNow()).toBe(false);
  });

  it("refuses, with nothing in flight, when the product's eligible throws at capture", async () => {
    let fail = false;
    const h = connected({
      eligible: () => {
        if (fail) throw new Error("eligible broke");
        return { x: 0.5, y: 0.5 };
      },
    });
    h.hover();
    fail = true;
    h.request(1);
    await flush();
    expect(h.answer()).toMatchObject({ kind: "capture-failed", requestId: 1, reason: "Error: eligible broke", retry: false });
    expect(h.pendingBitmaps).toEqual([]);
    fail = false;
    await captureNow(h, 2);
    expect(h.answer()).toMatchObject({ kind: "frame", requestId: 2 });
  });

  it("does not let a late shown card revive the reading state after a reset", () => {
    const h = connected();
    h.hover();
    h.hover(-5, -5);
    h.show("late");
    expect(h.shown).toEqual([expect.objectContaining({ cardId: "late" })]);
    h.hover();
    h.advance(POINTER_GRACE_MS + 1);
    expect(h.control.captureAllowedNow()).toBe(false);
  });
});

describe("full resets clear all four fields", () => {
  const cleared = { inside: false, lastTrustedPointerAt: -Infinity, tooltipShowing: false, lastTooltipAt: -Infinity };
  const triggers: Array<[string, (h: ReturnType<typeof connected>) => void]> = [
    ["the pointer leaves the picture", (h) => h.hover(2000, 2000)],
    ["the pointer leaves the document", (h) => h.win.fire("pointerleave", { type: "pointerleave", isTrusted: true, pointerType: "mouse", pointerId: 1, target: h.root })],
    [
      "the page is hidden",
      (h) => {
        h.doc.visibilityState = "hidden";
        h.win.fire("visibilitychange");
      },
    ],
    ["pointercancel", (h) => h.pointer("pointercancel")],
    ["a new source in the same video", (h) => h.video.fire("emptied")],
    ["another video", (h) => h.control.attach(asVideo(fakeVideo()))],
    ["no video", (h) => h.control.attach(null)],
  ];
  it.each(triggers)("%s", (_name, trigger) => {
    const h = connected();
    h.hover();
    h.show("card");
    expect(h.control.gateState()).toMatchObject({ inside: true, tooltipShowing: true });
    h.clear();
    trigger(h);
    expect(h.control.gateState()).toEqual(cleared);
    expect(h.control.captureAllowedNow()).toBe(false);
    expect(h.kinds()[0]).toBe("leave");
  });

  it("takes visibilitychange on the window in the capture phase, not on the document", () => {
    const h = connected();
    h.hover();
    h.doc.visibilityState = "hidden";
    expect(h.doc.count()).toBe(0);
    h.doc.fire("visibilitychange");
    expect(h.control.gateState().inside).toBe(true);
    h.win.fire("visibilitychange");
    expect(h.control.gateState().inside).toBe(false);
    h.detach();
    expect(h.win.count()).toBe(0);
  });

  it("a late card after a switch reaches onShown while gateState().inside is false", () => {
    for (const change of [(h: ReturnType<typeof connected>) => h.control.attach(asVideo(fakeVideo())), (h: ReturnType<typeof connected>) => h.video.fire("emptied")]) {
      const h = connected();
      h.hover();
      change(h);
      h.show("late");
      expect(h.shown.at(-1)).toMatchObject({ cardId: "late" });
      expect(h.control.gateState()).toMatchObject({ inside: false, tooltipShowing: false });
    }
  });

  it("a new source is reset before it is reported", () => {
    const h = connected();
    h.hover();
    h.clear();
    h.video.fire("loadeddata");
    expect(h.kinds()).toEqual(["leave", "discontinuity"]);
    expect(h.sent[1]).toMatchObject({ newSource: true });
  });

  it("a switch of video stops watching the old one and reports a new source", () => {
    const h = connected();
    const other = fakeVideo();
    h.control.attach(asVideo(other));
    expect(h.video.count()).toBe(0);
    expect(h.control.watch?.video).toBe(other);
    expect(h.sent.at(-1)).toMatchObject({ kind: "discontinuity", newSource: true });
    h.clear();
    h.control.attach(asVideo(other));
    expect(h.sent).toEqual([]);
  });

  it("an untrusted leave or another pointer's cancel resets nothing", () => {
    const h = connected();
    h.hover();
    h.win.fire("pointerleave", { type: "pointerleave", isTrusted: false, pointerType: "mouse", pointerId: 1, target: h.root });
    h.win.fire("pointerleave", { type: "pointerleave", isTrusted: true, pointerType: "mouse", pointerId: 1, target: {} });
    h.pointer("pointercancel", { pointerId: 9 });
    expect(h.control.gateState().inside).toBe(true);
  });
});

describe("taps", () => {
  it("get their capture after the finger is up, within the window", async () => {
    const h = connected();
    h.tap(7);
    expect(h.sent).toEqual([expect.objectContaining({ kind: "pointer", touch: true })]);
    h.pointer("pointerup", { pointerType: "touch", pointerId: 7 });
    h.win.fire("pointerleave", { type: "pointerleave", isTrusted: true, pointerType: "touch", pointerId: 7, target: h.root });
    h.advance(1_000);
    await captureNow(h);
    expect(h.answer()).toMatchObject({ kind: "frame" });
  });

  it("never get the reading linger: a card showing does not extend the window", () => {
    const h = connected();
    h.tap();
    h.show("card");
    h.advance(POINTER_GRACE_MS - 1);
    expect(h.control.captureAllowedNow()).toBe(true);
    h.advance(1);
    expect(h.control.captureAllowedNow()).toBe(false);
    h.show("card");
    expect(h.control.captureAllowedNow()).toBe(false);
  });

  it("a finger moving on the picture does not extend the window", () => {
    const h = connected();
    h.tap(7);
    h.advance(POINTER_GRACE_MS - 10);
    h.pointer("pointermove", { pointerType: "touch", pointerId: 7, x: 600 });
    h.advance(10);
    expect(h.control.captureAllowedNow()).toBe(false);
  });

  it("end on their own pointercancel", () => {
    const h = connected();
    h.tap(7);
    h.pointer("pointercancel", { pointerType: "touch", pointerId: 7 });
    expect(h.control.captureAllowedNow()).toBe(false);
  });

  it("are not inherited by another pointer", () => {
    const h = connected();
    // A second touch that moves over the picture without tapping it gets nothing.
    h.pointer("pointermove", { pointerType: "touch", pointerId: 8 });
    expect(h.control.captureAllowedNow()).toBe(false);
    h.tap(7);
    h.clear();
    h.pointer("pointermove", { pointerType: "touch", pointerId: 8, x: 100 });
    h.pointer("pointerup", { pointerType: "touch", pointerId: 8 });
    expect(h.sent).toEqual([]);
    // Its cancel does not end the tap's window, nor does the tap's lift.
    h.pointer("pointercancel", { pointerType: "touch", pointerId: 8 });
    expect(h.control.captureAllowedNow()).toBe(true);
    // A new tap outside the picture ends the last tap's window.
    h.tap(9, 5000, 5000);
    expect(h.control.captureAllowedNow()).toBe(false);
  });
});

describe("the handshake", () => {
  it("says hello until ready, then stops", () => {
    const h = setup();
    h.control.connect();
    expect(h.sent).toEqual([expect.objectContaining({ kind: "hello", version: PROTOCOL_VERSION, [TAG]: 1 })]);
    h.timers.at(-1)!.fn();
    h.timers.at(-1)!.fn();
    expect(h.kinds()).toEqual(["hello", "hello", "hello"]);
    expect(h.timers.map((t) => t.ms)).toEqual([250, 500, 1000]);
    h.ready();
    expect(h.timers.at(-1)!.cleared).toBe(true);
    expect(h.control.connected).toBe(true);
    // A late timer (cleared, but run anyway) sends nothing more.
    h.clear();
    h.timers.at(-1)!.fn();
    expect(h.sent).toEqual([]);
  });

  it("gives up after helloRetries and reports no answer; a later ready still counts", () => {
    const h = setup({ helloRetries: 2 });
    h.control.connect();
    h.timers.at(-1)!.fn();
    h.timers.at(-1)!.fn();
    expect(h.kinds()).toEqual(["hello", "hello"]);
    expect(h.problems).toEqual([{ kind: "no-answer" }]);
    h.ready();
    expect(h.control.connected).toBe(true);
  });

  it("sends nothing before ready, then the picture's time and the still-valid pointer", () => {
    const h = setup();
    h.control.attach(asVideo(h.video));
    h.hover();
    h.video.fire("timeupdate");
    expect(h.sent).toEqual([]);
    h.advance(1_000);
    h.ready();
    expect(h.sent).toEqual([
      expect.objectContaining({ kind: "presented", mediaTime: 12.5 }),
      expect.objectContaining({ kind: "pointer", x: 0.5, y: 0.5, touch: false }),
    ]);
  });

  it("never captures with another version", async () => {
    const h = setup();
    h.control.attach(asVideo(h.video));
    h.hover();
    h.control.connect();
    h.ready(INSTANCE_A, 2);
    expect(h.problems).toEqual([{ kind: "version", expected: PROTOCOL_VERSION, received: 2 }]);
    expect(h.control.connected).toBe(false);
    expect(h.timers.at(-1)!.cleared).toBe(true);
    h.clear();
    h.request(1);
    h.show("card");
    await flush();
    expect(h.pendingBitmaps).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.shown).toEqual([]);
    // A ready with no version (a frame from before contract v1) does not parse: not connected.
    const before = h.problems.length;
    h.deliver({ kind: "ready", instance: INSTANCE_A });
    expect(h.control.connected).toBe(false);
    expect(h.problems.length).toBe(before);
  });

  it("a new instance resets the reading state and resends; the same instance again does nothing", () => {
    const h = connected();
    h.hover();
    h.show("card");
    h.ready(INSTANCE_A);
    h.clear();
    h.ready(INSTANCE_A);
    expect(h.sent).toEqual([]);
    expect(h.control.gateState().tooltipShowing).toBe(true);
    h.ready(INSTANCE_B);
    expect(h.control.gateState()).toMatchObject({ inside: true, tooltipShowing: false, lastTooltipAt: -Infinity });
    expect(h.kinds()).toEqual(["presented", "pointer"]);
  });

  it("a new instance does not replay an expired tap or a hover kept only by the old card", () => {
    const tapped = connected();
    tapped.tap();
    tapped.advance(POINTER_GRACE_MS + 1);
    tapped.clear();
    tapped.ready(INSTANCE_B);
    expect(tapped.kinds()).toEqual(["presented"]);
    expect(tapped.control.gateState().inside).toBe(false);

    const reading = connected();
    reading.hover();
    reading.show("card");
    reading.advance(POINTER_GRACE_MS + 1);
    expect(reading.control.captureAllowedNow()).toBe(true);
    reading.clear();
    reading.ready(INSTANCE_B);
    expect(reading.kinds()).toEqual(["presented"]);
    expect(reading.control.captureAllowedNow()).toBe(false);
  });

  it("a replaced iframe is not connected until it says ready", () => {
    const h = connected();
    h.hover();
    const next = { postMessage: vi.fn() };
    h.setFrame(next);
    expect(h.control.connected).toBe(false);
    h.hover(600, 300);
    expect(next.postMessage).not.toHaveBeenCalled();
    h.ready(INSTANCE_B);
    expect(next.postMessage.mock.calls.map(([m]) => (m as { kind: string }).kind)).toEqual(["presented", "pointer"]);
  });

  it("passes the status on", () => {
    const h = connected();
    h.deliver({ kind: "status", state: "ready", error: null, backend: "wasm" });
    expect(h.statuses).toEqual([{ kind: "status", state: "ready", error: null, backend: "wasm" }]);
  });
});

describe("captures in flight", () => {
  it("one at a time", async () => {
    const h = connected();
    h.hover();
    h.request(1);
    h.request(2);
    await flush();
    expect(h.answer()).toMatchObject({ kind: "capture-failed", requestId: 2, reason: CAPTURE_PENDING, retry: false });
    h.pendingBitmaps.shift()!(fakeBitmap());
    await flush();
    expect(h.answer()).toMatchObject({ kind: "frame", requestId: 1 });
    await captureNow(h, 3);
    expect(h.answer()).toMatchObject({ kind: "frame", requestId: 3 });
  });

  it.each([
    ["a new source", (h: ReturnType<typeof connected>) => h.video.fire("emptied")],
    ["another video", (h: ReturnType<typeof connected>) => h.control.attach(asVideo(fakeVideo()))],
    ["the pointer leaving", (h: ReturnType<typeof connected>) => h.hover(-1, -1)],
  ])("%s while the grab is pending: the bitmap is closed, never sent", async (_name, change) => {
    const h = connected();
    h.hover();
    h.request(1);
    await flush();
    change(h);
    const bitmap = fakeBitmap();
    h.pendingBitmaps.shift()!(bitmap);
    await flush();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(h.sent.some((m) => m.kind === "frame")).toBe(false);
    expect(h.answer()).toMatchObject({ kind: "capture-failed", requestId: 1, reason: PICTURE_CHANGED, retry: false });
  });

  it("a new instance while the grab is pending: closed, and the old request is not answered", async () => {
    const h = connected();
    h.hover();
    h.request(1);
    await flush();
    h.ready(INSTANCE_B);
    const bitmap = fakeBitmap();
    h.pendingBitmaps.shift()!(bitmap);
    await flush();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(h.answer()).toBeUndefined();
  });

  it("a throwing postMessage closes the still-owned bitmap", async () => {
    const h = connected();
    h.hover();
    h.throwOnTransfer(true);
    const bitmap = await captureNow(h);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(h.answer()).toBeUndefined();
  });

  it("stop: nothing listens, nothing is sent, a pending grab is closed", async () => {
    const h = connected();
    h.hover();
    h.request(1);
    await flush();
    h.control.stop();
    expect(h.win.count() + h.doc.count() + h.video.count()).toBe(0);
    h.clear();
    const bitmap = fakeBitmap();
    h.pendingBitmaps.shift()!(bitmap);
    await flush();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([]);
  });
});

describe("postWithTransfer", () => {
  it("does not touch a transferred bitmap", () => {
    const bitmap = fakeBitmap();
    const target = { postMessage: vi.fn() };
    expect(postWithTransfer(target as unknown as Window, { kind: "frame" }, ORIGIN, bitmap as unknown as ImageBitmap)).toBe(true);
    expect(target.postMessage).toHaveBeenCalledWith({ kind: "frame" }, ORIGIN, [bitmap]);
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it("closes the bitmap when posting throws or there is no target", () => {
    const thrown = fakeBitmap();
    const target = {
      postMessage: () => {
        throw new Error("gone");
      },
    };
    expect(postWithTransfer(target as unknown as Window, {}, ORIGIN, thrown as unknown as ImageBitmap)).toBe(false);
    expect(thrown.close).toHaveBeenCalledTimes(1);
    const orphan = fakeBitmap();
    expect(postWithTransfer(null, {}, ORIGIN, orphan as unknown as ImageBitmap)).toBe(false);
    expect(orphan.close).toHaveBeenCalledTimes(1);
  });
});
