// SPDX-License-Identifier: Apache-2.0
// The content script's half of the two-frame contract (docs/extension-session.md), in one place:
// who may make the extension take a picture, and how a picture reaches the compute frame.
//
// The page shares the window with the content script. It can post messages to the compute frame,
// dispatch made-up events, and move or swap the video under a resting pointer. It cannot make a
// pointer event the browser marks as trusted. So the controller gives pictures only on the
// authority of trusted pointer events, checked again against the picture at the moment of each
// capture:
//
//  - Hover (mouse, pen): while the last trusted point is over the picture, within the grace
//    period after it (`POINTER_GRACE_MS`), and while a card shows or for `READING_LINGER_MS`
//    after one showed, as long as that point is still over the picture; never more than
//    `MAX_REST_MS` (60 s) after the last trusted event.
//  - Tap (touch): `POINTER_GRACE_MS` from the tap, and no longer. A card showing never extends
//    it, and the finger lifting does not end it (the picture the tap asked for is taken after the
//    finger is up); a canceled touch does.
//
// Everything that means the viewer is gone clears all of it, the record of a card showing
// included: the pointer leaving the picture or the document, the page hidden, a canceled
// pointer, another source in the video, another video (or none). A new compute frame instance
// clears the record of a card showing and drops a pending capture, and keeps a pointer only if
// it is still within its window over the picture.
//
// A product still picks the video (`attach`), draws the card (`onShown`), and may narrow where
// a pointer counts (`eligible`: its own overlays and controls).

import { pictureBox, fractionIn } from "./capture.js";
import { captureAllowed, type GateLimits, type GateState } from "./capture-gate.js";
import { type ComputeIn, type ComputeOut, type ComputeProtocol, PROTOCOL_VERSION, type ShownCard } from "./compute-messages.js";
import { type GrabDeps, type Grab, grabFrame } from "./page-capture.js";
import { type VideoWatch, watchVideo } from "./video-events.js";

/** What a frame's `ready` must carry: 16 lowercase hexadecimal characters, one per frame. */
const INSTANCE = /^[0-9a-f]{16}$/;

/** The reasons the controller refuses a capture with. */
export const NOT_POINTING = "not pointing at the video";
export const CAPTURE_PENDING = "a capture is already pending";
export const PICTURE_CHANGED = "the video changed during the capture";

/** Why the controller cannot work with the compute frame. */
export type CaptureProblem =
  /** The frame speaks another version of the contract: nothing is captured until a frame that
   *  speaks this one says `ready`. Reloading the page (or the extension) usually mends it. */
  | { kind: "version"; expected: number; received: unknown }
  /** No `ready` came after every `hello`. A `ready` that comes later is still taken. */
  | { kind: "no-answer" };

export interface CaptureControlOptions {
  /** The messages' protocol, with the extension's tag (`computeProtocol(tag)`). */
  protocol: ComputeProtocol;
  /** The compute frame's window (the iframe's `contentWindow`), or null while there is none. */
  frame: () => Window | null;
  /** The compute frame's origin (the extension's). Messages go only there and are taken only
   *  from there. */
  frameOrigin: string;
  /** The clock, in ms; default `performance.now()`. */
  now?: () => number;
  /** Where a trusted point counts: its position in fractions of the picture, or null when it
   *  does not count (outside the picture, over the product's own controls). Asked on every
   *  pointer event and again before every capture. Default: inside the watched video's picture
   *  (`pictureBox` and `fractionIn`), geometry only: something laid over the video is caught
   *  only by an `eligible` that hit-tests (for example with `document.elementsFromPoint`). */
  eligible?: (clientX: number, clientY: number, video: HTMLVideoElement) => { x: number; y: number } | null;
  /** What a tooltip shows now (null: nothing). Called after the controller has noted it. */
  onShown?: (card: ShownCard | null) => void;
  /** The compute frame's status. */
  onStatus?: (status: Extract<ComputeOut, { kind: "status" }>) => void;
  /** The controller cannot work with the frame (see `CaptureProblem`). */
  onProblem?: (problem: CaptureProblem) => void;
  /** How many `hello`s `connect` sends at most; default 10 (about 16 s, see `helloDelayMs`). */
  helloRetries?: number;
  /** The wait before the n-th `hello` is sent again (n from 0); default 250 ms doubling up to 2 s. */
  helloDelayMs?: (attempt: number) => number;
  /** The gate's windows; default the scheduler's, and the `MAX_REST_MS` cap. */
  limits?: GateLimits;
  /** Passed to `grabFrame`. */
  grab?: GrabDeps;
  /** Timers; default the global `setTimeout` / `clearTimeout`. */
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export interface CaptureControl {
  /** Watch this video (null: none). Another video clears the gate and reports a new source to
   *  the frame; the same video again does nothing. */
  attach(video: HTMLVideoElement | null): void;
  /** Take trusted pointer events, and the document's `visibilitychange`, on this window in the
   *  capture phase (`doc` is the window's document). Call as early as the content script runs. Returns the call that stops listening. */
  listen(win: Window, doc: Document): () => void;
  /** Say `hello` to the compute frame until it says `ready` (at most `helloRetries` times). Call
   *  after making or replacing the iframe. */
  connect(): void;
  /** Hand every `message` event of the window here; returns whether it was the frame's. */
  onMessage(event: MessageEvent): boolean;
  /** The video watched now, or null. Date your own messages with `watch.mediaTime()`. */
  readonly watch: VideoWatch | null;
  /** Whether a compatible frame said `ready` (and is still the frame). */
  readonly connected: boolean;
  /** The gate's four fields now (a copy, for diagnostics). */
  gateState(): GateState;
  /** Whether a capture would be allowed now. A trusted point no longer over the picture clears
   *  the gate. */
  captureAllowedNow(): boolean;
  /** Stop: no listeners, no watch, no timers; nothing is sent after this. */
  stop(): void;
}

/** Who holds capture authority: one pointer, with its last trusted point. */
interface Authority {
  kind: "hover" | "tap";
  pointerId: number;
  clientX: number;
  clientY: number;
  /** For a hover, the last trusted event over the picture; for a tap, the tap (never moved). */
  at: number;
}

interface Handshake {
  window: Window;
  instance: string;
}

/**
 * Whether a `message` event comes from one of the extension's own frames: trusted (dispatched by
 * the browser, not made by a page script, which can forge `source` and `origin`), from `frame`
 * (the iframe's `contentWindow`) and from `origin` (the extension's). It does not read
 * `event.data`. Use it for every message from one of your own frames (the compute frame, a
 * tooltip frame) before reading its data.
 */
export function fromExtensionFrame(event: MessageEvent, frame: Window | null, origin: string): boolean {
  return event.isTrusted === true && frame !== null && event.source === frame && event.origin === origin;
}

/**
 * A `ComputeOut` from your own compute frame, or null: `fromExtensionFrame` first, and only then
 * is the data read and parsed.
 */
export function acceptComputeOut(event: MessageEvent, { frame, origin, protocol }: { frame: Window | null; origin: string; protocol: ComputeProtocol }): ComputeOut | null {
  if (!fromExtensionFrame(event, frame, origin)) return null;
  return protocol.parseComputeOut(event.data);
}

/**
 * Post a message that transfers `bitmap`, and own up to failure: when posting throws (the
 * target is gone, the bitmap cannot be cloned), the bitmap is still the caller's and is closed
 * here. A bitmap that was transferred is not touched. Returns whether it was sent.
 */
export function postWithTransfer(target: Window | null, message: unknown, targetOrigin: string, bitmap: ImageBitmap): boolean {
  if (target) {
    try {
      target.postMessage(message, targetOrigin, [bitmap]);
      return true;
    } catch {
      // Not transferred: still ours.
    }
  }
  try {
    bitmap.close();
  } catch {
    // Already closed or detached: nothing to free.
  }
  return false;
}

const defaultTimers = {
  set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The watched video's picture, as the page lays it out. */
function defaultEligible(clientX: number, clientY: number, video: HTMLVideoElement): { x: number; y: number } | null {
  const view = video.ownerDocument?.defaultView;
  const fit = view ? view.getComputedStyle(video).objectFit : "contain";
  return fractionIn(pictureBox(video.getBoundingClientRect(), { width: video.videoWidth, height: video.videoHeight }, fit), clientX, clientY);
}

const helloDelay = (attempt: number): number => Math.min(2000, 250 * 2 ** attempt);

/** The page side of the two-frame contract: see the top of this file. */
export function createCaptureControl(options: CaptureControlOptions): CaptureControl {
  const { protocol, frameOrigin } = options;
  const now = options.now ?? (() => performance.now());
  const eligible = options.eligible ?? defaultEligible;
  const timers = options.timers ?? defaultTimers;
  const helloRetries = options.helloRetries ?? 10;
  const delay = options.helloDelayMs ?? helloDelay;

  let watch: VideoWatch | null = null;
  let authority: Authority | null = null;
  let tooltipShowing = false;
  let lastTooltipAt = -Infinity;
  /** Counts full resets, so a capture begun before one is not sent after it. */
  let resets = 0;
  let handshake: Handshake | null = null;
  let helloTimer: unknown = null;
  let helloSent = 0;
  let captureInFlight = false;
  let stopped = false;
  const listening = new Set<() => void>();

  /** The frame we handshook with, if it is still the frame. */
  function connectedFrame(): Window | null {
    const target = options.frame();
    return handshake && target === handshake.window ? target : null;
  }

  function send(message: ComputeIn, target: Window | null = connectedFrame()): void {
    if (stopped || !target) return;
    try {
      target.postMessage(protocol.tag(message), frameOrigin);
    } catch {
      // A frame being torn down: the next handshake brings it up to date.
    }
  }

  function where(clientX: number, clientY: number): { x: number; y: number } | null {
    return watch ? eligible(clientX, clientY, watch.video) : null;
  }

  /** The viewer is gone: clear all four fields, and tell the frame. */
  function reset(): void {
    const had = authority !== null;
    authority = null;
    tooltipShowing = false;
    lastTooltipAt = -Infinity;
    resets++;
    if (had) send({ kind: "leave" });
  }

  function gateState(): GateState {
    if (!authority) return { inside: false, lastTrustedPointerAt: -Infinity, tooltipShowing, lastTooltipAt };
    // A tap's window is never extended by a card showing.
    return authority.kind === "tap"
      ? { inside: true, lastTrustedPointerAt: authority.at, tooltipShowing: false, lastTooltipAt: -Infinity }
      : { inside: true, lastTrustedPointerAt: authority.at, tooltipShowing, lastTooltipAt };
  }

  /** The gate, with the last trusted point checked against the picture as it is now. */
  function captureAllowedNow(): boolean {
    if (!authority || !watch) return false;
    if (!where(authority.clientX, authority.clientY)) {
      // The video moved under a resting pointer (or, with a product `eligible` that hit-tests,
      // something now covers it).
      reset();
      return false;
    }
    return captureAllowed(gateState(), now(), options.limits);
  }

  function sendPointer(): void {
    if (!authority || !watch) return;
    const at = where(authority.clientX, authority.clientY);
    if (at) send({ kind: "pointer", x: at.x, y: at.y, mediaTime: watch.mediaTime(), touch: authority.kind === "tap" });
  }

  // ------------------------------------------------------------ pointer events
  function onPointer(event: PointerEvent): void {
    if (stopped || event.isTrusted !== true || !watch) return;
    const kind = event.pointerType === "touch" ? "tap" : "hover";
    const id = event.pointerId;
    const at = where(event.clientX, event.clientY);
    if (kind === "hover") {
      if (at) {
        authority = { kind, pointerId: id, clientX: event.clientX, clientY: event.clientY, at: now() };
        sendPointer();
      } else if (authority?.kind === "hover") {
        reset();
      }
      return;
    }
    // Touch.
    const own = authority?.kind === "tap" && authority.pointerId === id;
    if (event.type === "pointerdown") {
      if (at) {
        authority = { kind, pointerId: id, clientX: event.clientX, clientY: event.clientY, at: now() };
        sendPointer();
      } else if (authority?.kind === "tap") {
        // A new touch elsewhere ends the last tap's window.
        reset();
      }
    } else if (event.type === "pointermove" && own && authority) {
      if (!at) return reset();
      // The finger moved on the picture: a new point, the same window.
      authority.clientX = event.clientX;
      authority.clientY = event.clientY;
      sendPointer();
    }
    // pointerup: the tap's window outlives the finger; another pointer's move inherits nothing.
  }

  function onCancel(event: PointerEvent): void {
    if (stopped || event.isTrusted !== true) return;
    if (authority && authority.pointerId === event.pointerId) reset();
  }

  function onVisibility(doc: Document): void {
    if (doc.visibilityState === "hidden") reset();
  }

  // ------------------------------------------------------------ the video
  function attach(video: HTMLVideoElement | null): void {
    if (stopped || (watch?.video ?? null) === video) return;
    reset();
    watch?.detach();
    watch = null;
    if (video) {
      const next = watchVideo(video, {
        presented: (mediaTime) => send({ kind: "presented", mediaTime }),
        discontinuity: (newSource) => {
          // Another source in the same element: nothing the viewer pointed at carries over.
          if (newSource) reset();
          send({ kind: "discontinuity", newSource });
        },
      });
      watch = next;
    }
    // Attaching reports nothing by itself: another video is another source.
    send({ kind: "discontinuity", newSource: true });
  }

  // ------------------------------------------------------------ the handshake
  function stopHello(): void {
    if (helloTimer !== null) timers.clear(helloTimer);
    helloTimer = null;
  }

  function hello(): void {
    helloTimer = null;
    if (stopped || connectedFrame()) return;
    if (helloSent >= helloRetries) {
      options.onProblem?.({ kind: "no-answer" });
      return;
    }
    send({ kind: "hello", version: PROTOCOL_VERSION }, options.frame());
    helloTimer = timers.set(hello, delay(helloSent));
    helloSent++;
  }

  function connect(): void {
    if (stopped) return;
    stopHello();
    helloSent = 0;
    hello();
  }

  function onReady(message: ComputeOut, from: Window): void {
    const { version, instance } = message as { version?: unknown; instance?: unknown };
    if (version !== PROTOCOL_VERSION) {
      handshake = null;
      stopHello();
      reset();
      options.onProblem?.({ kind: "version", expected: PROTOCOL_VERSION, received: version });
      return;
    }
    if (typeof instance !== "string" || !INSTANCE.test(instance)) return;
    stopHello();
    if (handshake && handshake.window === from && handshake.instance === instance) return; // an answer to a repeated hello
    handshake = { window: from, instance };
    // A new frame: it shows nothing and asked for nothing yet. What it showed before counts no
    // more; a capture still pending was for the old one (`captureFor` drops it). A pointer still
    // within its window is told again, with the picture's time; an expired one is not.
    const kept = authority;
    tooltipShowing = false;
    lastTooltipAt = -Infinity;
    resets++;
    if (kept && !(where(kept.clientX, kept.clientY) && captureAllowed(gateState(), now(), options.limits))) authority = null;
    if (watch) send({ kind: "presented", mediaTime: watch.mediaTime() });
    sendPointer();
  }

  // ------------------------------------------------------------ capture
  async function captureFor(requestId: number, range: { min: number; max: number }): Promise<void> {
    const refuse = (reason: string, retry = false): void => send({ kind: "capture-failed", requestId, reason, retry });
    if (captureInFlight) return refuse(CAPTURE_PENDING);
    let allowed: boolean;
    try {
      allowed = captureAllowedNow();
    } catch (error) {
      // A product `eligible` that throws: refuse, with nothing left in flight.
      return refuse(String(error));
    }
    if (!allowed) return refuse(NOT_POINTING);
    const begun = { watch, source: watch?.source, handshake, resets };
    captureInFlight = true;
    let grab: Grab;
    try {
      grab = await grabFrame(watch, range, options.grab);
    } catch (error) {
      grab = { kind: "failed", reason: String(error), retry: false };
    } finally {
      captureInFlight = false;
    }
    const sameFrame = !stopped && handshake === begun.handshake && connectedFrame() !== null;
    const sameVideo = watch === begun.watch && watch?.source === begun.source && resets === begun.resets;
    if (!sameFrame || !sameVideo) {
      if (grab.kind === "frame") grab.bitmap.close();
      // The old frame's request means nothing to a new one; the same frame hears the refusal.
      if (sameFrame) refuse(PICTURE_CHANGED);
      return;
    }
    if (grab.kind === "failed") return refuse(grab.reason, grab.retry);
    postWithTransfer(connectedFrame(), protocol.tag({ kind: "frame", requestId, bitmap: grab.bitmap, mediaTime: grab.mediaTime }), frameOrigin, grab.bitmap);
  }

  // ------------------------------------------------------------ messages
  function onMessage(event: MessageEvent): boolean {
    if (stopped) return false;
    const from = options.frame();
    const message = acceptComputeOut(event, { frame: from, origin: frameOrigin, protocol });
    if (!message || !from) return false;
    if (message.kind === "ready") {
      onReady(message, from);
      return true;
    }
    // Nothing but `ready` counts before a compatible frame said it.
    if (!connectedFrame()) return true;
    switch (message.kind) {
      case "status":
        options.onStatus?.(message);
        break;
      case "shown": {
        // A card noted only while someone points: a late answer after a reset revives nothing.
        if (authority) {
          if (tooltipShowing || message.card) lastTooltipAt = now();
          tooltipShowing = message.card !== null;
        }
        options.onShown?.(message.card);
        break;
      }
      case "capture":
        void captureFor(message.requestId, message.analysisWidth);
        break;
    }
    return true;
  }

  // ------------------------------------------------------------ listening
  function listen(win: Window, doc: Document): () => void {
    const capture = { capture: true, passive: true } as const;
    const pointer = (event: Event): void => onPointer(event as PointerEvent);
    const cancel = (event: Event): void => onCancel(event as PointerEvent);
    // The pointer left the document: `pointerleave` on the root, which does not bubble, so it is
    // seen here in the capture phase, before any page listener on the root. A touch's own
    // `pointerleave` after the finger lifts is not leaving: the tap's window stays.
    const leave = (event: Event): void => {
      const e = event as PointerEvent;
      if (stopped || e.isTrusted !== true || e.target !== doc.documentElement || e.pointerType === "touch") return;
      reset();
    };
    // `visibilitychange` reaches the window too (the document's parent in the event path): taken
    // there in the capture phase, before a page's own listener on the window or document.
    const visibility = (): void => onVisibility(doc);
    const added: Array<[EventTarget, string, (event: Event) => void]> = [
      [win, "pointermove", pointer],
      [win, "pointerdown", pointer],
      [win, "pointerup", pointer],
      [win, "pointercancel", cancel],
      [win, "pointerleave", leave],
      [win, "visibilitychange", visibility],
    ];
    for (const [target, type, fn] of added) target.addEventListener(type, fn, capture);
    let on = true;
    const detach = (): void => {
      if (!on) return;
      on = false;
      listening.delete(detach);
      for (const [target, type, fn] of added) target.removeEventListener(type, fn, capture);
    };
    listening.add(detach);
    return detach;
  }

  function stop(): void {
    if (stopped) return;
    reset();
    stopped = true;
    stopHello();
    for (const detach of [...listening]) detach();
    watch?.detach();
    watch = null;
    handshake = null;
  }

  return {
    attach,
    listen,
    connect,
    onMessage,
    get watch() {
      return watch;
    },
    get connected() {
      return connectedFrame() !== null;
    },
    gateState,
    captureAllowedNow,
    stop,
  };
}
