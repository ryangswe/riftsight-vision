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
//  - Slow start (hover only): when the compute frame's status becomes `ready` (its model loaded)
//    while a mouse rests over the picture, the next capture it asks for is given even past the
//    grace period, within `MAX_REST_MS` of the last trusted event, the point still over the
//    picture. One picture: the grant is spent by that capture, unless it failed for want of a
//    picture and may be retried. A new trusted move, any reset and a new frame drop it.
//
// Everything that means the viewer is gone clears all of it, the record of a card showing
// included: the pointer leaving the picture or the document, the page hidden, a canceled
// pointer, another source in the video, another video (or none). A new compute frame instance
// clears the record of a card showing and drops a pending capture, and keeps a pointer only if
// it is still within its window over the picture.
//
// With `intent: "page"` the controller also tells the frame, at most once a second, that the
// viewer is active while the watched video plays: a trusted pointer move anywhere in the page.
// It gives no capture authority; it only lets a frame that unloaded its worker when idle load it
// again before the pointer reaches the picture. `loadWhen` is the same idea for making the frame.
//
// A product still picks the video (`attach`), draws the card (`onShown`), and may narrow where
// a pointer counts (`eligible`: its own overlays and controls).

import { pictureBox, fractionIn } from "./capture.js";
import { captureAllowed, type GateLimits, type GateState, slowStartAllowed } from "./capture-gate.js";
import { type ComputeIn, type ComputeOut, type ComputeProtocol, PROTOCOL_VERSION, type ShownCard } from "./compute-messages.js";
import { type GrabDeps, type Grab, grabFrame } from "./page-capture.js";
import { type VideoWatch, watchVideo } from "./video-events.js";

/** What a frame's `ready` must carry: 16 lowercase hexadecimal characters, one per frame. */
const INSTANCE = /^[0-9a-f]{16}$/;

/** How long `connect` waits for the iframe to leave its first `about:blank`, in ms, looking every
 *  `HELLO_LOAD_STEP_MS`. The waits do not count against `helloRetries`; when they run out, the
 *  controller reports `no-answer`. */
const HELLO_LOAD_MS = 60_000;
const HELLO_LOAD_STEP_MS = 250;

/** The reasons the controller refuses a capture with. */
export const NOT_POINTING = "not pointing at the video";
export const CAPTURE_PENDING = "a capture is already pending";
export const PICTURE_CHANGED = "the video changed during the capture";

/** Why the controller cannot work with the compute frame. */
export type CaptureProblem =
  /** The frame speaks another version of the contract: nothing is captured until a frame that
   *  speaks this one says `ready`. Reloading the page (or the extension) usually mends it. */
  | { kind: "version"; expected: number; received: unknown }
  /** No `ready` came after every `hello`, or the iframe kept its first `about:blank` for a minute
   *  (nothing loaded in it). A `ready` that comes later is still taken. */
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
  /** "page": a trusted pointer move anywhere in the document, while the watched video plays and
   *  at most once a second, sends an `intent` message to the frame. Off when absent. */
  intent?: "page";
  /** Opt in to dropping the whole compute frame when it goes idle. When the frame reports the
   *  status `idle` (start it with `idleUnloadMs`), the control calls `remove()` once and sends
   *  nothing more to that frame. The next trusted pointer move over the watched video calls
   *  `make()` once. An `intent` moment (a trusted move anywhere while the video plays, with
   *  `intent: "page"`) does not: while the frame is removed it does nothing and sends nothing,
   *  because rebuilding on any page move cost more than it saved for viewers who do not hover. The control then connects
   *  to the new frame as it does for any replaced iframe, so `frame()` must return the new frame's
   *  window once `make()` returns. A trusted `pointerdown` over the picture (a touch tap) makes the
   *  frame too. After `make()` the usual `no-answer` problem can fire if the frame never answers;
   *  the product handles it as it does for its first frame. If `make()` throws, the control stays
   *  in the removed state (the throw is not reported: no problem kind fits) and only the next
   *  trusted move or tap over the video tries again (a move elsewhere on the page does not). A frame the product makes and connects itself also ends the removed state,
   *  so do not make the frame on your own load triggers while `control.frameRemoved` is true:
   *  `loadWhen` fires once, so it is safe, but a reload on every `playing` event (a looping clip
   *  fires one) would quietly undo the unload.
   *
   *  The product deletes the iframe in `remove` and creates a new one in `make`: the same function
   *  it gives `loadWhen` works. Dropping the frame frees its renderer (about 90 MB on a real
   *  release) that keeping the frame and ending only its worker does not. Without this option an
   *  idle frame stays and reloads in place when a pointer or intent message reaches it. */
  whenIdle?: { remove(): void; make(): void };
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
  /** With `whenIdle`: true from the call to `remove()` until the next accepted handshake, so a
   *  product can check it before making a frame of its own. Always false without the option. */
  readonly frameRemoved: boolean;
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

/** The least time between two `intent` messages, in ms. */
export const INTENT_INTERVAL_MS = 1000;

/** The part of a video `loadWhen` uses. */
export type PlayWatch = Pick<HTMLVideoElement, "paused" | "ended" | "addEventListener" | "removeEventListener">;

/**
 * Call `make` once when `video` is playing: at once if it already is (not paused, not ended),
 * else at its next trusted `playing` event (one the browser fired, not a page script). Never for a
 * paused or ended video, never twice. The result's `stop()` removes the listener (and is safe to
 * call after `make` ran). Use it to make the compute frame at play rather than at the first
 * pointer move.
 */
export function loadWhen(video: PlayWatch, when: "play", make: () => void): { stop(): void } {
  if (when !== "play") throw new TypeError(`loadWhen: not a supported moment: ${String(when)}`);
  let done = false;
  const onPlaying = (event: Event): void => {
    if (done || event.isTrusted !== true || video.paused || video.ended) return;
    stop();
    make();
  };
  const stop = (): void => {
    done = true;
    video.removeEventListener("playing", onPlaying);
  };
  if (!video.paused && !video.ended) {
    done = true;
    make();
  } else {
    video.addEventListener("playing", onPlaying);
  }
  return { stop };
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
  /** The frame's last status since the handshake (null: none yet), to tell when it becomes ready. */
  let frameState: Extract<ComputeOut, { kind: "status" }>["state"] | null = null;
  /** A slow start's grant: the next capture may be given past the grace period (see the top). */
  let slowStart = false;
  /** Counts full resets, so a capture begun before one is not sent after it. */
  let resets = 0;
  let handshake: Handshake | null = null;
  let helloTimer: unknown = null;
  let helloSent = 0;
  let loadSince: number | null = null;
  let captureInFlight = false;
  let lastIntentAt = -Infinity;
  let stopped = false;
  /** With `whenIdle`: the frame was dropped and no new one has been made. */
  let frameRemoved = false;
  /** True from `remove()` until the next accepted handshake (the public `frameRemoved`). */
  let dropped = false;
  const listening = new Set<() => void>();

  /** The frame we handshook with, if it is still the frame. */
  function connectedFrame(): Window | null {
    const target = options.frame();
    return handshake && target === handshake.window ? target : null;
  }

  /** Whether `target` may hold the extension's page yet. While the iframe is still on its first
   *  `about:blank` (the page's own origin, so its location can be read), a message for the
   *  extension's origin would only be dropped, with an error in the page's console. Once the
   *  extension's page is there, its location cannot be read from here, and that is the sign. */
  function atFrameOrigin(target: Window): boolean {
    try {
      return target.location.origin === frameOrigin;
    } catch {
      return true;
    }
  }

  function send(message: ComputeIn, target: Window | null = connectedFrame()): void {
    if (stopped || !target || !atFrameOrigin(target)) return;
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
    slowStart = false;
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
    const state = gateState();
    return captureAllowed(state, now(), options.limits) || (slowStart && authority.kind === "hover" && slowStartAllowed(state, now(), options.limits));
  }

  /** Send the trusted point, with `known` when the caller just measured it (one layout read per
   *  pointer event: `eligible` reads the video's box and style). */
  function sendPointer(known?: { x: number; y: number }): void {
    if (!authority || !watch) return;
    const at = known ?? where(authority.clientX, authority.clientY);
    if (at) send({ kind: "pointer", x: at.x, y: at.y, mediaTime: watch.mediaTime(), touch: authority.kind === "tap" });
  }

  /** The frame reported `idle`: drop it, once. Nothing is sent to it after this. */
  function removeFrame(): void {
    if (stopped || !options.whenIdle) return;
    frameRemoved = true;
    dropped = true;
    handshake = null;
    stopHello();
    options.whenIdle.remove();
  }

  /** Make the new frame, once, and connect to it. */
  function makeFrame(): void {
    if (stopped || !options.whenIdle || !frameRemoved) return;
    frameRemoved = false;
    try {
      options.whenIdle.make();
    } catch {
      // No new frame: stay removed, so the next trusted move tries again. The throw is not
      // reported: no problem kind fits it.
      frameRemoved = true;
      return;
    }
    connect();
  }

  // ------------------------------------------------------------ pointer events
  function onPointer(event: PointerEvent): void {
    if (stopped || event.isTrusted !== true || !watch) return;
    const kind = event.pointerType === "touch" ? "tap" : "hover";
    const id = event.pointerId;
    const at = where(event.clientX, event.clientY);
    if (frameRemoved && at && (event.type === "pointermove" || event.type === "pointerdown")) makeFrame();
    if (kind === "hover") {
      if (at) {
        authority = { kind, pointerId: id, clientX: event.clientX, clientY: event.clientY, at: now() };
        // A move: the grace period runs again, and a slow start is not owed.
        slowStart = false;
        sendPointer(at);
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
        sendPointer(at);
      } else if (authority?.kind === "tap") {
        // A new touch elsewhere ends the last tap's window.
        reset();
      }
    } else if (event.type === "pointermove" && own && authority) {
      if (!at) return reset();
      // The finger moved on the picture: a new point, the same window.
      authority.clientX = event.clientX;
      authority.clientY = event.clientY;
      sendPointer(at);
    }
    // pointerup: the tap's window outlives the finger; another pointer's move inherits nothing.
  }

  function onIntent(event: PointerEvent): void {
    if (stopped || options.intent !== "page" || event.isTrusted !== true || !watch) return;
    const video = watch.video;
    if (video.paused || video.ended) return;
    // A dropped frame is not rebuilt by a move elsewhere on the page: only a move or tap over the
    // picture does (onPointer). There is no frame to message either.
    if (frameRemoved) return;
    const target = connectedFrame();
    if (!target) return;
    const at = now();
    if (at - lastIntentAt < INTENT_INTERVAL_MS) return;
    lastIntentAt = at;
    send({ kind: "intent" }, target);
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
    const target = options.frame();
    if (target && !atFrameOrigin(target)) {
      // Not loaded yet: wait without spending a try, for at most HELLO_LOAD_MS.
      const at = now();
      loadSince ??= at;
      if (at - loadSince < HELLO_LOAD_MS) helloTimer = timers.set(hello, HELLO_LOAD_STEP_MS);
      else options.onProblem?.({ kind: "no-answer" });
      return;
    }
    if (helloSent >= helloRetries) {
      options.onProblem?.({ kind: "no-answer" });
      return;
    }
    send({ kind: "hello", version: PROTOCOL_VERSION }, target);
    helloTimer = timers.set(hello, delay(helloSent));
    helloSent++;
  }

  function connect(): void {
    if (stopped) return;
    stopHello();
    helloSent = 0;
    loadSince = null;
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
    // A frame the product made itself counts as the new frame: the next idle removes it.
    frameRemoved = false;
    dropped = false;
    // A new frame: it shows nothing and asked for nothing yet. What it showed before counts no
    // more; a capture still pending was for the old one (`captureFor` drops it). A pointer still
    // within its window is told again, with the picture's time; an expired one is not.
    const kept = authority;
    frameState = null;
    slowStart = false;
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
    // A slow start's grant is spent by this capture, whatever allowed it (one picture), unless it
    // fails for want of a picture and may be retried (below).
    const granted = slowStart;
    try {
      allowed = captureAllowedNow();
    } catch (error) {
      // A product `eligible` that throws: refuse, with nothing left in flight.
      slowStart = false;
      return refuse(String(error));
    }
    slowStart = false;
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
    if (grab.kind === "failed") {
      // No picture was taken: the frame's prompt retry is part of the slow start's one picture.
      if (granted && grab.retry) slowStart = true;
      return refuse(grab.reason, grab.retry);
    }
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
      case "status": {
        // The frame became ready (its model loaded): a mouse resting over the picture is owed one
        // picture (a slow start), however long it has rested within `MAX_REST_MS`.
        const was = frameState;
        frameState = message.state;
        if (message.state !== "ready") slowStart = false;
        else if (was !== "ready") slowStart = authority?.kind === "hover" && slowStartAllowed(gateState(), now(), options.limits);
        options.onStatus?.(message);
        if (message.state === "idle") removeFrame();
        break;
      }
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
    const intent = (event: Event): void => onIntent(event as PointerEvent);
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
      [win, "pointermove", intent],
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
    get frameRemoved() {
      return dropped;
    },
    get connected() {
      return connectedFrame() !== null;
    },
    gateState,
    captureAllowedNow,
    stop,
  };
}
