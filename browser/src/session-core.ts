// SPDX-License-Identifier: Apache-2.0
// The session's policy, without a page: when a picture is captured and analyzed, which reply may
// be shown, and what is shown at the pointer.
//
// `createSession` runs on a <video> of its own document. An extension often cannot: the video is
// in a page it does not own, and the worker runs in a frame of its own. This core is the part of
// a session that needs neither. Whoever hosts it reports what happens to the picture and the
// pointer, and does what the core asks:
//
//   - in: the pointer over the picture (in fractions of the picture), the pointer leaving, a frame
//     presented, a seek or a new source, a cut, a captured picture or a failed capture, the
//     worker's replies, the worker stopping (`workerStopped`) or being replaced before it loaded
//     (`reloading`), and a regular `tick` (every
//     `DRIVER_TICK_MS`);
//   - out: "capture the picture now" (`capture`), a request for the worker (`toWorker`), the card
//     shown at the pointer when it changes (`onShown`), and the status when it changes
//     (`onStatus`).
//
// It holds no timers and touches no element: the clock is passed in (`now`), and the watchdog of a
// look with no reply is checked in `tick`, counted from the capture request.
//
// A look has two phases: the capture is asked for, then the picture arrives and goes to the
// worker. One look is in flight at a time. A picture for a look given up on, or never asked for,
// is closed and never analyzed. Replies are judged by `replyRejection`.
//
// Retries are the scheduler's (frame-scheduler.ts), with one back-off counter: a capture that
// failed for want of a picture is retried promptly (`lookUnanswered(now, { prompt: true })`); a
// look answered busy or given up on is retried at the cadence (`lookUnanswered(now)`); after a
// failed capture a picture received starts the back-off over (`pictureReceived`), and an analysis
// always does (`lookAnswered`). A refused capture (not about the picture: the page's privacy
// gate, an unreadable video) is retried by nothing (`lookRefused`); the next pointer move over
// the picture looks again, at the cadence.
//
// What is never shown: a result from before a seek, a new source or a cut; a result further than
// the release's `hover.maxAgeMs` of video time from the picture on screen; anything for a box that
// was detected and not named. With the optional hold (`SHOWN_HOLD`), a shown card survives short
// gaps; without it (the default), what is shown is exactly the newest result at the pointer.

import type { AABB } from "./boxes.js";
import type { AnalysisWidth } from "./capture.js";
import { type AnalysisMode, analyzeIntervalMs, cadenceMs } from "./cadence.js";
import { ANALYSIS_WATCHDOG_MS, FrameScheduler, HOVER_MAX_AGE_MS, rejectionAnswersInFlight, replyRejection, withinMaxAge } from "./frame-scheduler.js";
import { BUSY_ERROR, type FrameEnvelope, type FrameResult, type GeometricStatus, type ReleaseProgress, type ReleaseStatus, type WorkerReply, type WorkerRequest } from "./messages.js";
import { type FractionBox, MAX_OTHER_BOXES } from "./compute-messages.js";
import { hoverAt } from "./hover-at.js";
import type { FrameAnalysis } from "./pipeline.js";
import type { SessionStatus } from "./session.js";
import { CONFIRM_FRAMES } from "./temporal-gate.js";

export type { FractionBox };

/** The card shown at a position. */
export interface Shown {
  cardId: string;
  name: string;
  /** The card's box, in fractions of the picture. */
  box: FractionBox;
  /** The card's box in pixels of the analyzed frame. */
  frameBox: AABB;
  /** The boxes of the other cards of the same analysis, in fractions, for placing a tooltip off
   *  them (at most `maxOtherBoxes`). */
  others: FractionBox[];
}

/** The shown card's hold: how long it survives analyses that do not see it at the pointer. */
export interface ShownHold {
  /** Analyses in a row with nothing there before it goes. */
  misses: number;
  /** Time with no analysis seeing it before it goes, in ms. */
  maxMs: number;
  /** A box detected at the pointer is the held card's box when they overlap at least this much
   *  (intersection over union); a box overlapping less is another card, and ends the hold. */
  sameBoxIou: number;
}

/** The hold that keeps a tooltip from flickering on a live stream. Counted in analyses because a
 *  resting pointer is analyzed at the slow cadence (1-2 s apart): a short time limit would hide the
 *  card on every single miss. */
export const SHOWN_HOLD: Readonly<ShownHold> = Object.freeze({ misses: 2, maxMs: 5_000, sameBoxIou: 0.5 });


export interface SessionCoreDeps {
  /** The clock, in ms (`performance.now()` in a page). */
  now(): number;
  /** Send a request to the analysis worker, transferring `transfer`. */
  toWorker(request: WorkerRequest, transfer?: Transferable[]): void;
  /** Capture the picture on screen now, at a width within `analysisWidth`, and answer with
   *  `frame(requestId, …)` or `captureFailed(requestId, …)`. */
  capture(requestId: number, analysisWidth: AnalysisWidth): void;
  /** What is shown at the pointer changed (the card, or its box). */
  onShown?(card: Shown | null): void;
  /** Any field of the status changed. */
  onStatus?(status: SessionStatus): void;
  /** A frame was analyzed. */
  onAnalysis?(analysis: FrameAnalysis): void;
  /** The geometric stage's state changed. */
  onGeometricStatus?(status: GeometricStatus): void;
  /** Replaceable for tests; `hoverAt` by default. */
  hoverAt?: typeof hoverAt;
  /** The time of the picture on screen now, in seconds, for a host that can read it at any
   *  moment (`createSession`: its own video). The max-age rule, the staleness rule and a look's
   *  date then use it; without it, the time last reported by `pointer` or `presented` (a paused
   *  video reports none, so a host that can read the time should give it). */
  mediaTimeNow?(): number;
}

export interface SessionCoreOptions {
  /** "pointer" (the default): analyze only around pointer activity. "always-on": analyze for as
   *  long as the session runs. */
  mode?: AnalysisMode;
  /** Hold a shown card through short gaps. Off when absent; `SHOWN_HOLD` is the usual value. */
  hold?: ShownHold;
  /** Other cards' boxes reported with a shown card (default `MAX_OTHER_BOXES`). */
  maxOtherBoxes?: number;
  /** The geometric stage was asked for: its status starts as "loading" (null otherwise). */
  geometric?: boolean;
}

/** What `status().loading` becomes on a release-progress reply: the reply's phase while the
 *  release loads; `undefined` (no change) once it has loaded or failed, or the session has
 *  stopped, so a reply that arrives late changes nothing. */
export function progressUpdate(state: SessionStatus["state"], reply: ReleaseProgress): SessionStatus["loading"] | undefined {
  return state === "loading" ? { phase: reply.phase, bytes: reply.bytes } : undefined;
}

/** The boxes of an analysis's named and unnamed hover cards other than `box`, in fractions. */
export function neighborBoxes(analysis: FrameAnalysis, box: FractionBox, limit = MAX_OTHER_BOXES): FractionBox[] {
  return (analysis.hover?.cards ?? [])
    .map((c) => c.bounds)
    .filter((b) => b && !(Math.abs(b.x - box.x) < 1e-6 && Math.abs(b.y - box.y) < 1e-6 && Math.abs(b.width - box.width) < 1e-6))
    .slice(0, limit)
    .map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height }));
}

interface InFlight {
  requestId: number;
  /** When the capture was asked for: the watchdog and the round trip count from here. */
  sentAt: number;
  generation: number;
  videoKey: string;
  /** Set once the picture went to the worker. */
  analyzing: boolean;
}

export class SessionCore {
  readonly scheduler: FrameScheduler;
  private readonly mode: AnalysisMode;
  private readonly hold: ShownHold | null;
  private readonly maxOtherBoxes: number;
  private readonly hitTest: typeof hoverAt;

  private readonly st: SessionStatus;
  private cardList: ReleaseStatus["cards"] = [];
  private analysisWidth: AnalysisWidth = { min: 720, max: 1920 };
  private maxAgeMs = HOVER_MAX_AGE_MS;
  private nextRequestId = 1;
  private inFlight: InFlight | null = null;
  private lastAcceptedRequestId = 0;
  private generation = 0;
  private sourceCount = 0;
  private result: { analysis: FrameAnalysis; videoTimeSec: number } | null = null;
  private pointerAt: { x: number; y: number } | null = null;
  private mediaTime = 0;
  private lastShownKey = "null";
  private lastStatusKey = "";
  private held: { card: Shown; misses: number; seenAt: number } | null = null;

  constructor(
    private readonly deps: SessionCoreDeps,
    options: SessionCoreOptions = {},
  ) {
    this.mode = options.mode ?? "pointer";
    this.hold = options.hold ?? null;
    this.maxOtherBoxes = options.maxOtherBoxes ?? MAX_OTHER_BOXES;
    this.hitTest = deps.hoverAt ?? hoverAt;
    this.scheduler = new FrameScheduler(cadenceMs(null, this.mode), CONFIRM_FRAMES, this.mode, analyzeIntervalMs(null));
    this.st = {
      state: "loading", error: null, release: null, backend: null, schedule: "idle", frames: 0,
      lastWorkerMs: null, lastRoundTripMs: null, lastFrameError: null,
      geometric: options.geometric ? { state: "loading", reason: null, bytes: null } : null,
      loading: null,
    };
    this.lastStatusKey = this.statusKey();
  }

  private get videoKey(): string {
    return `source-${this.sourceCount}`;
  }

  // ------------------------------------------------------------------ the page
  /** The pointer moved over the picture (or touched it) at (x, y) in fractions of the picture,
   *  with the video at `mediaTime` seconds. Report real movement only. */
  pointer(x: number, y: number, mediaTime: number, touch = false): void {
    if (this.st.state === "stopped") return;
    const now = this.deps.now();
    this.pointerAt = { x, y };
    this.mediaTime = mediaTime;
    if (touch) this.scheduler.tapped(now);
    else this.scheduler.pointerMoved(now);
    if (this.st.state === "ready" && this.scheduler.hoverTriggerDue(now, this.videoTime(), this.inFlight !== null)) this.requestCapture("hover");
    this.publish();
  }

  /** The pointer left the picture. */
  pointerLeft(): void {
    if (this.st.state === "stopped") return;
    this.pointerAt = null;
    this.scheduler.pointerLeft(this.deps.now());
    this.publish();
  }

  /** The video presented a frame (playback, a seek ended, a re-arm on canplay/playing). */
  presented(mediaTime: number): void {
    if (this.st.state === "stopped") return;
    this.mediaTime = mediaTime;
    this.scheduler.framePresented();
    this.publish();
  }

  /** A seek, or a new source: nothing analyzed before it is shown again. */
  discontinuity(newSource: boolean): void {
    if (this.st.state === "stopped") return;
    this.generation += 1;
    if (newSource) this.sourceCount += 1;
    this.scheduler.discontinuity();
    this.result = null;
    this.held = null;
    if (newSource) this.scheduler.framePresented();
    this.publish();
  }

  /** The picture under the shown card changed without a seek: look again at once. */
  cut(): void {
    if (this.st.state === "stopped") return;
    this.generation += 1;
    this.result = null;
    this.held = null;
    this.scheduler.requestLook();
    this.publish();
  }

  /** The picture captured for `requestId`, taken at `mediaTime`. Closed when it is not the
   *  picture of the look in flight (late, given up on, or never asked for), or when a seek, a new
   *  source or a cut came since the capture was asked for (that look is then finished). */
  frame(requestId: number, bitmap: ImageBitmap, mediaTime: number): void {
    const sent = this.inFlight;
    if (this.st.state === "stopped" || !sent || sent.requestId !== requestId || sent.analyzing) {
      bitmap.close();
      return;
    }
    this.scheduler.pictureReceived();
    if (sent.generation !== this.generation || sent.videoKey !== this.videoKey) {
      // A seek, a new source or a cut since the capture was asked for: the picture may be from
      // before it. The look is finished as a reply from before it would finish it, and nothing
      // is analyzed.
      this.inFlight = null;
      bitmap.close();
      this.publish();
      return;
    }
    sent.analyzing = true;
    const envelope: FrameEnvelope = { requestId: sent.requestId, mediaTimeSec: mediaTime, generation: sent.generation, videoKey: sent.videoKey };
    try {
      this.deps.toWorker({ kind: "frame", bitmap, videoTimeSec: mediaTime, envelope }, [bitmap]);
    } catch (error) {
      // Not transferred, so still ours: close it, and ask again as for a look given up on.
      bitmap.close();
      this.inFlight = null;
      this.st.lastFrameError = `analysis-failed: ${String(error)}`;
      this.scheduler.lookUnanswered(this.deps.now());
    }
    this.publish();
  }

  /** The capture for `requestId` failed. `retry`: the picture could not be had (not ready yet, or
   *  blank) and is looked at again after a back-off; otherwise a refusal, retried by nothing. */
  captureFailed(requestId: number, reason: string, retry = false): void {
    const sent = this.inFlight;
    if (this.st.state === "stopped" || !sent || sent.requestId !== requestId || sent.analyzing) return;
    this.inFlight = null;
    this.st.lastFrameError = `capture-failed: ${reason}`;
    if (retry) this.scheduler.lookUnanswered(this.deps.now(), { prompt: true });
    else this.scheduler.lookRefused();
    this.publish();
  }

  // ------------------------------------------------------------------ the worker
  fromWorker(reply: WorkerReply): void {
    if (this.st.state === "stopped") return;
    switch (reply.kind) {
      case "geometric-status":
        this.st.geometric = { state: reply.state, reason: reply.reason, bytes: reply.bytes };
        this.deps.onGeometricStatus?.(reply);
        this.publishStatus();
        return;
      case "release-progress": {
        const loading = progressUpdate(this.st.state, reply);
        if (loading !== undefined) this.st.loading = loading;
        this.publishStatus();
        return;
      }
      case "release-status":
        this.st.state = reply.ok ? "ready" : "failed";
        this.st.error = reply.error;
        this.st.release = reply.release;
        this.st.loading = null;
        this.cardList = reply.cards;
        if (reply.release) {
          this.st.backend = reply.release.recognizer.ep;
          this.maxAgeMs = reply.release.hoverMaxAgeMs;
          this.analysisWidth = { ...reply.release.analysisWidth };
          this.scheduler.setIntervalMs(cadenceMs(this.st.backend, this.mode));
          this.scheduler.setReadingIntervalMs(analyzeIntervalMs(this.st.backend));
          this.scheduler.framePresented();
        }
        this.publish();
        return;
      case "frame-result":
        this.onFrameResult(reply);
        return;
      default:
        return;
    }
  }

  private onFrameResult(reply: FrameResult): void {
    const now = this.deps.now();
    const rejection = replyRejection(reply.envelope, {
      inFlightRequestId: this.inFlight?.requestId ?? null,
      lastAcceptedRequestId: this.lastAcceptedRequestId,
      generation: this.generation,
      videoKey: this.videoKey,
    });
    // A reply to another request than the one in flight leaves that one in flight; a reply from
    // before a seek, another source or a cut finishes it, and shows nothing.
    if (rejection !== null && !rejectionAnswersInFlight(rejection)) return;
    const sent = this.inFlight!;
    this.inFlight = null;
    if (rejection !== null) {
      this.publish();
      return;
    }
    this.lastAcceptedRequestId = reply.envelope.requestId;
    this.st.lastFrameError = reply.error ?? null;
    this.st.lastWorkerMs = reply.workerMs;
    this.st.lastRoundTripMs = +(now - sent.sentAt).toFixed(2);
    if (reply.analysis) {
      this.scheduler.lookAnswered();
      this.st.frames += 1;
      this.result = { analysis: reply.analysis, videoTimeSec: reply.videoTimeSec };
      this.deps.onAnalysis?.(reply.analysis);
    } else {
      this.result = null;
      if (reply.error === BUSY_ERROR) this.scheduler.lookUnanswered(now);
    }
    if (this.held && this.pointerAt && !this.fresh()) this.held.misses += 1;
    this.scheduler.setTooltipShowing(this.shown() !== null, now);
    this.publish();
  }

  // ------------------------------------------------------------------ the driver
  /** Call every `DRIVER_TICK_MS`. */
  tick(): void {
    if (this.st.state === "stopped") return;
    const now = this.deps.now();
    if (this.inFlight && now - this.inFlight.sentAt >= ANALYSIS_WATCHDOG_MS) {
      // No answer: give up on this look so that the next one can go. A late picture is closed; a
      // late reply is recognized by its request number and dropped.
      this.inFlight = null;
      this.st.lastFrameError = "no reply";
      this.scheduler.lookUnanswered(now);
    }
    this.scheduler.setTooltipShowing(this.shown() !== null, now);
    if (this.st.state === "ready" && !this.inFlight && this.scheduler.due(now)) this.requestCapture(this.scheduler.lookPending ? "cut" : undefined);
    this.publish();
  }

  /** Stop: nothing is asked or shown any more, and every later input is ignored (a picture is
   *  still closed). */
  stop(): void {
    if (this.st.state === "stopped") return;
    this.st.state = "stopped";
    this.st.loading = null;
    this.inFlight = null;
    this.result = null;
    this.held = null;
    this.pointerAt = null;
    this.publishShown();
    this.publishStatus();
  }

  /**
   * The worker serving this core stopped. The look in flight and the newest result are dropped,
   * so nothing is shown. `{ restart: true }`: another worker loads the release, the state is
   * "loading" again (the release in effect is kept until it answers), the geometric stage is
   * reported off with the reason `worker-restarted` (to `onGeometricStatus` in any case, in the
   * status only when a stage was asked for). `{ error }`: recognition is off ("failed").
   * Ignored once stopped or failed.
   */
  workerStopped(next: { restart: true } | { error: string }): void {
    if (this.st.state === "stopped" || this.st.state === "failed") return;
    this.inFlight = null;
    this.result = null;
    this.held = null;
    this.st.loading = null;
    this.publishShown();
    if ("restart" in next) {
      const off: GeometricStatus = { kind: "geometric-status", state: "off", reason: "worker-restarted", bytes: null };
      if (this.st.geometric) this.st.geometric = { state: off.state, reason: off.reason, bytes: off.bytes };
      this.deps.onGeometricStatus?.(off);
      this.st.state = "loading";
      this.st.error = null;
    } else {
      this.st.state = "failed";
      this.st.error = next.error;
    }
    this.publishStatus();
  }

  /** Another worker now loads a release in place of one that never loaded (a fallback): the
   *  geometric stage's status starts again ("loading" when this load asks for a stage, null
   *  otherwise), and the previous load's progress is dropped. Nothing else changes. */
  reloading(next: { geometric: boolean }): void {
    if (this.st.state !== "loading") return;
    this.st.geometric = next.geometric ? { state: "loading", reason: null, bytes: null } : null;
    this.st.loading = null;
    this.publishStatus();
  }

  private requestCapture(trigger?: "hover" | "cut"): void {
    if (this.st.state !== "ready" || this.inFlight) return;
    const now = this.deps.now();
    const requestId = this.nextRequestId++;
    this.inFlight = { requestId, sentAt: now, generation: this.generation, videoKey: this.videoKey, analyzing: false };
    this.scheduler.started(now, { videoTimeSec: this.videoTime(), ...(trigger ? { trigger } : {}) });
    this.deps.capture(requestId, { ...this.analysisWidth });
  }

  // ------------------------------------------------------------------ reads
  status(): SessionStatus {
    return { ...this.st, schedule: this.scheduler.analysisState(this.deps.now()) };
  }

  /** The newest result that still describes the picture on screen, or null. */
  analysis(): FrameAnalysis | null {
    return this.current()?.analysis ?? null;
  }

  /** The catalog's cards (id, name, art path), once the release has loaded. */
  cards(): ReleaseStatus["cards"] {
    return this.cardList;
  }

  /** The card at (fx, fy), in fractions of the picture, in the newest result that may still be
   *  shown; null for nothing. No hold. */
  hitAt(fx: number, fy: number): Shown | null {
    const result = this.current();
    if (!result) return null;
    const { width, height } = result.analysis.frame;
    if (!(width > 0 && height > 0)) return null;
    const x = fx * width;
    const y = fy * height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const hit = this.hitTest(result.analysis, x, y);
    if (!hit.box || hit.cardId === null || hit.name === null) return null;
    const box = { x: hit.box.x / width, y: hit.box.y / height, width: hit.box.width / width, height: hit.box.height / height };
    const frameBox = { x: hit.box.x, y: hit.box.y, width: hit.box.width, height: hit.box.height };
    return { cardId: hit.cardId, name: hit.name, box, frameBox, others: neighborBoxes(result.analysis, box, this.maxOtherBoxes) };
  }

  /** The card at the pointer in the newest result that may still be shown; null for nothing, or
   *  with the pointer elsewhere. No hold. */
  fresh(): Shown | null {
    return this.pointerAt ? this.hitAt(this.pointerAt.x, this.pointerAt.y) : null;
  }

  /**
   * The card shown at the pointer now, or null. Without a hold, `fresh()`. With one: once a card
   * is shown it stays while the pointer stays on its box and the analyses that follow do not name
   * another card there, until `hold.misses` analyses in a row have nothing there, or `hold.maxMs`
   * have passed with no analysis seeing it. A different card or box at the pointer replaces it
   * at once; the pointer leaving its box, a seek, a new source or a cut end it at once.
   */
  shown(): Shown | null {
    const fresh = this.fresh();
    const hold = this.hold;
    if (!hold) return fresh;
    const now = this.deps.now();
    if (fresh) {
      this.held = { card: fresh, misses: 0, seenAt: now };
      return fresh;
    }
    const held = this.held;
    if (!held || !this.pointerAt || !inside(held.card.box, this.pointerAt)) {
      this.held = null;
      return null;
    }
    const there = this.boxAtPointer(held.card.box, hold.sameBoxIou);
    if (there === "other" || held.misses >= hold.misses || now - held.seenAt >= hold.maxMs) {
      this.held = null;
      return null;
    }
    return held.card;
  }

  private current(): { analysis: FrameAnalysis; videoTimeSec: number } | null {
    const result = this.result;
    if (!result) return null;
    return withinMaxAge(result.videoTimeSec, this.videoTime(), this.maxAgeMs) ? result : null;
  }

  /** The time of the picture on screen: the host's live time when it gives one, else the time
   *  last reported. */
  private videoTime(): number {
    return this.deps.mediaTimeNow ? this.deps.mediaTimeNow() : this.mediaTime;
  }

  /** What the newest analysis has at the pointer compared with the held box: the same box, another
   *  one, none, or "unknown" when no analysis is recent enough to judge by. */
  private boxAtPointer(held: FractionBox, sameBoxIou: number): "same" | "other" | "none" | "unknown" {
    const result = this.current();
    if (!result || !this.pointerAt) return "unknown";
    const { width, height } = result.analysis.frame;
    if (!(width > 0 && height > 0)) return "unknown";
    const px = this.pointerAt.x * width;
    const py = this.pointerAt.y * height;
    const heldPx = { x: held.x * width, y: held.y * height, width: held.width * width, height: held.height * height };
    let best = 0;
    let any = false;
    for (const b of result.analysis.boxes ?? []) {
      const [x, y, w, h] = b.box;
      if (px < x || px > x + w || py < y || py > y + h) continue;
      any = true;
      best = Math.max(best, iouOf(heldPx, { x, y, width: w, height: h }));
    }
    if (!any) return "none";
    return best >= sameBoxIou ? "same" : "other";
  }

  // ------------------------------------------------------------------ outputs
  private publish(): void {
    this.publishShown();
    this.publishStatus();
  }

  /** Report what is shown when it changed (the card, or its box). */
  private publishShown(): void {
    const card = this.shown();
    const key = card ? `${card.cardId}|${card.box.x}|${card.box.y}|${card.box.width}|${card.box.height}` : "null";
    if (key === this.lastShownKey) return;
    this.lastShownKey = key;
    this.deps.onShown?.(card);
  }

  private statusKey(): string {
    const s = this.status();
    return JSON.stringify({ ...s, release: s.release ? s.release.id : null });
  }

  private publishStatus(): void {
    const key = this.statusKey();
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.deps.onStatus?.(this.status());
  }
}

function iouOf(a: FractionBox, b: FractionBox): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

function inside(box: FractionBox, p: { x: number; y: number }): boolean {
  return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
}
