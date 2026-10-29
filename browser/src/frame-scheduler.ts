// SPDX-License-Identifier: Apache-2.0
// When to analyze a frame.
//
// The host reports every frame the element presents (playback, a seek, a new file) and asks,
// on a regular tick, one question: analyze the current picture now?
//
//   - A presented frame is analyzed once the cadence allows it (cadence.ts). A playing video
//     presents frames continuously, so this is a fixed-rate loop; a paused video presents
//     nothing, so it costs nothing.
//   - A still picture (nothing newer presented since it was analyzed: a paused seek, an image)
//     is analyzed a few more times at `REPEAT_INTERVAL_MS`, because the tracker and the
//     temporal gate count analyzed frames and a still picture never produces another. Then
//     nothing runs until the next presented frame, or the retry of a look that came back with
//     the picture not analyzed (below).
//
// In "pointer" mode none of that runs unless the pointer says so:
//   - "fast": within `POINTER_GRACE_MS` of the last pointer activity over the picture: a move,
//     a press or tap, or the pointer leaving. A pointer that rests on the picture is not
//     activity; otherwise a parked pointer would keep analysis running for ever. The fast
//     cadence applies.
//   - "reading": the grace period is over, the pointer rests on the picture, and a tooltip is
//     showing, or was showing less than `READING_LINGER_MS` ago. Analysis continues at the slow
//     cadence so that the tooltip keeps up with the picture. The linger lets it survive a short
//     loss (one frame in which the card is not recognized); it never starts analysis for a
//     pointer resting on nothing, and the pointer leaving ends it.
//   - "idle": otherwise. Nothing is analyzed. Any pointer activity returns to "fast" at once.
// "always-on" mode has no such states: the cadence alone decides.
//
// The staleness rule. On top of the cadence, a pointer moving over the picture asks for an
// analysis at once when the newest analyzed frame is stale: more than `staleFrameMs` of video
// time away from the picture on screen, or from before a seek or a new source. This happens at
// most once per `HOVER_TRIGGER_MIN_GAP_MS` and never while an analysis is in flight.
//
// Replies. Every frame request carries an envelope (messages.ts) and `replyRejection` decides
// whether its reply may still be shown. A look that comes back with the picture not analyzed
// (the worker was still busy with an earlier picture, or no reply came in time) has still used
// up the presented frame or a repeat, and a paused video presents no other: `lookUnanswered`
// makes the same picture due again after a back-off (`LOOK_RETRY_MS`), until a look comes back
// analyzed (`lookAnswered`). When the picture under a showing tooltip changes
// without a seek (a cut), `requestLook` asks for a look at once, whatever the cadence.
//
// This file holds no timers and touches no element: the policy is a pure function of the
// events and times it is given, so it can be tested with a made-up clock.

import type { AnalysisMode } from "./cadence.js";
import type { FrameEnvelope } from "./messages.js";
import { CONFIRM_FRAMES } from "./temporal-gate.js";

/** Spacing of the repeated analyses of a still picture. */
export const REPEAT_INTERVAL_MS = 250;
/** How often the host should ask `due`: fine enough for the repeats; the cadence gates the rest. */
export const DRIVER_TICK_MS = 250;
/** Pointer mode: analysis keeps running this long after the pointer's last activity. */
export const POINTER_GRACE_MS = 10_000;
/** Pointer mode: the "reading" state outlasts the tooltip's last showing by this long. */
export const READING_LINGER_MS = 5_000;
/** The least the stale-frame threshold can be: a moving pointer asks for a fresh analysis when
 *  the newest analyzed frame is more than this much video time away, or more than the cadence
 *  in effect if that is longer. */
export const STALE_FRAME_MS = 400;
/** A result older than this, in video time, against a playing video shows no tooltip. It is
 *  above the time an analysis takes on a slow device, so ordinary delay never hides a tooltip.
 *  A release document states its own value (`hover.maxAgeMs`). */
export const HOVER_MAX_AGE_MS = 2_000;
/** The least time between two analyses asked for by the staleness rule. */
export const HOVER_TRIGGER_MIN_GAP_MS = 250;
/** An analysis with no reply after this long is given up on, so that the next frame can go. */
export const ANALYSIS_WATCHDOG_MS = 5_000;
/** After a look comes back with the picture not analyzed, the same picture is due again after
 *  these delays, one per unanswered look in a row, then the last one each time. */
export const LOOK_RETRY_MS: readonly number[] = [250, 500, 1_000, 2_000];

/** Why an analysis ran: the cadence (a newly presented frame), a repeat of a still picture, the
 *  staleness rule, or a cut under a showing tooltip. */
export type AnalysisTrigger = "cadence" | "repeat" | "hover" | "cut";

/** Why a reply is not shown. */
export type ReplyRejection =
  /** Not the request in flight (it was given up on, or nothing is in flight). */
  | "stale-request"
  /** Older than, or the same as, a reply already shown. */
  | "superseded"
  /** From another source than the one on screen. */
  | "video-key"
  /** Sent before a seek, a new source or a cut. */
  | "generation";

/** What a reply is judged against. */
export interface LiveTemporalState {
  /** The request in flight; null when there is none. */
  inFlightRequestId: number | null;
  /** The newest request whose reply was shown (0 before the first). */
  lastAcceptedRequestId: number;
  generation: number;
  videoKey: string;
}

/**
 * May this reply be shown? Null means yes; otherwise the reason it may not. A reply is shown
 * only when its request is the one in flight and newer than any reply already shown, and its
 * source and generation both match the live state. A "stale-request" or "superseded" reply is
 * not the answer to the request in flight, which stays in flight; a "video-key" or
 * "generation" reply is (the request is finished, and nothing is shown).
 */
export function replyRejection(envelope: FrameEnvelope | undefined, live: LiveTemporalState): ReplyRejection | null {
  if (envelope === undefined) return "stale-request";
  if (envelope.requestId <= live.lastAcceptedRequestId) return "superseded";
  if (envelope.requestId !== live.inFlightRequestId) return "stale-request";
  if (envelope.videoKey !== live.videoKey) return "video-key";
  if (envelope.generation !== live.generation) return "generation";
  return null;
}

/** Does a rejected reply still finish the request in flight? */
export function rejectionAnswersInFlight(reason: ReplyRejection): boolean {
  return reason === "video-key" || reason === "generation";
}

/** Which analysis policy applies right now. */
export type AnalysisState = "always-on" | "fast" | "reading" | "idle";

export interface StartedInfo {
  /** Time of the analyzed picture in the video, in seconds: what staleness is measured from. */
  videoTimeSec?: number;
  /** Set when the staleness rule (`hoverTriggerDue`) or a cut (`requestLook`) started it. */
  trigger?: "hover" | "cut";
}

export class FrameScheduler {
  private pending = false;
  private repeatsLeft = 0;
  private lastStartedAt = -Infinity;

  private pointerInside = false;
  /** The last pointer activity: a move, press or tap over the picture, or the pointer leaving. */
  private lastPointerAt = -Infinity;
  private tooltipShowing = false;
  /** The last time a showing tooltip was reported while the pointer was inside. */
  private lastTooltipAt = -Infinity;
  private lastHoverTriggerAt = -Infinity;
  private lastVideoTimeSec: number | null = null;
  private discontinuitySinceLast = false;
  private lastTriggerKind: AnalysisTrigger | null = null;
  /** A look was asked for at once: `due` ignores the cadence until the next start. */
  private lookRequested = false;
  /** Looks in a row that came back with the picture not analyzed. */
  private unanswered = 0;
  /** When the picture counts as newly presented again after an unanswered look; null if not. */
  private retryAt: number | null = null;

  /**
   * @param intervalMs The cadence of the mode: the fast cadence in pointer mode, the slow one
   *   in always-on mode (cadence.ts `cadenceMs`).
   * @param confirmFrames How many times a still picture is analyzed in all.
   * @param mode Defaults to "always-on": the cadence alone decides.
   * @param readingIntervalMs The slow cadence of the "reading" state. Defaults to `intervalMs`.
   */
  constructor(
    private intervalMs: number,
    private readonly confirmFrames = CONFIRM_FRAMES,
    private mode: AnalysisMode = "always-on",
    private readingIntervalMs: number = intervalMs,
  ) {}

  setIntervalMs(ms: number): void {
    this.intervalMs = ms;
  }

  setReadingIntervalMs(ms: number): void {
    this.readingIntervalMs = ms;
  }

  /** Is a tooltip showing at the resting pointer? Report it before each evaluation and after
   *  each result. `now` is remembered as the last showing, for `READING_LINGER_MS`. */
  setTooltipShowing(showing: boolean, now: number): void {
    this.tooltipShowing = showing;
    if (showing && this.pointerInside) this.lastTooltipAt = now;
  }

  setMode(mode: AnalysisMode): void {
    this.mode = mode;
  }

  get analysisMode(): AnalysisMode {
    return this.mode;
  }

  /** The element presented a new frame (playback, a seek, a new file). */
  framePresented(): void {
    this.pending = true;
    this.repeatsLeft = 0;
  }

  /** A seek or a new source: the newest analyzed frame no longer describes the picture. */
  discontinuity(): void {
    this.discontinuitySinceLast = true;
    // A new picture: the back-off of unanswered looks starts over, and a retry waiting for the
    // old picture is dropped. The pointer leaving resets neither, so that a pointer coming back
    // finds the retry still due, and a still busy worker is still backed off from.
    this.unanswered = 0;
    this.retryAt = null;
  }

  /** The picture under a showing tooltip changed without a seek: look at the current picture as
   *  soon as nothing is in flight, whatever the cadence (still only while analysis may run). */
  requestLook(): void {
    this.discontinuitySinceLast = true;
    this.pending = true;
    this.repeatsLeft = 0;
    this.lookRequested = true;
  }

  /**
   * A look came back with the picture not analyzed: the picture could not be captured, the
   * worker was still busy with an earlier picture, or no reply came within
   * `ANALYSIS_WATCHDOG_MS`. The still picture's other repeats are dropped, and the same picture
   * counts as newly presented again after a back-off, so that a paused video is looked at again
   * (with its repeats). This is not `requestLook`, which would also make the picture stale and
   * let every pointer move look again at once, past the back-off.
   */
  lookUnanswered(now: number): void {
    this.repeatsLeft = 0;
    this.retryAt = now + LOOK_RETRY_MS[Math.min(this.unanswered, LOOK_RETRY_MS.length - 1)]!;
    this.unanswered += 1;
  }

  /** A look came back analyzed: no retry is waiting, and the back-off starts over (as after
   *  `discontinuity`). */
  lookAnswered(): void {
    this.unanswered = 0;
    this.retryAt = null;
  }

  /** Has the back-off of an unanswered look run out? */
  private retryReady(now: number): boolean {
    return this.retryAt !== null && now >= this.retryAt;
  }

  /** Is a look asked for by `requestLook` still waiting to start? */
  get lookPending(): boolean {
    return this.lookRequested;
  }

  /** The pointer moved over the picture, or was pressed on it. Call it for real movement only:
   *  a pointer resting on the picture is not activity. */
  pointerMoved(now: number): void {
    this.pointerInside = true;
    this.lastPointerAt = now;
  }

  /** The pointer left the picture. The grace period starts now, and with the pointer outside
   *  there is no "reading" state after it. */
  pointerLeft(now: number): void {
    if (this.pointerInside) this.lastPointerAt = now;
    this.pointerInside = false;
    this.lastTooltipAt = -Infinity;
  }

  /** A touch on the picture. Touch has no resting pointer, so a tap only opens the grace period. */
  tapped(now: number): void {
    this.lastPointerAt = now;
  }

  /** Is the grace period of the last pointer activity still running? */
  pointerActive(now: number): boolean {
    return now - this.lastPointerAt < POINTER_GRACE_MS;
  }

  analysisState(now: number): AnalysisState {
    if (this.mode === "always-on") return "always-on";
    if (this.pointerActive(now)) return "fast";
    if (!this.pointerInside) return "idle";
    return this.tooltipShowing || now - this.lastTooltipAt < READING_LINGER_MS ? "reading" : "idle";
  }

  /** May anything be analyzed right now? */
  analysisActive(now: number): boolean {
    return this.analysisState(now) !== "idle";
  }

  /** The cadence in effect: the slow reading cadence while reading, else the mode's cadence. */
  intervalInEffectMs(now: number): number {
    return this.analysisState(now) === "reading" ? this.readingIntervalMs : this.intervalMs;
  }

  /** Should the current picture be analyzed now, by the cadence or as a repeat of a still? */
  due(now: number): boolean {
    if (!this.analysisActive(now)) return false;
    if (this.lookRequested) return true;
    const since = now - this.lastStartedAt;
    if (this.pending || this.retryReady(now)) return since >= this.intervalInEffectMs(now);
    return this.repeatsLeft > 0 && since >= REPEAT_INTERVAL_MS;
  }

  /** The stale-frame threshold in effect, in ms of video time: `STALE_FRAME_MS`, or the cadence
   *  in effect when that is longer. Below the cadence, a pointer moving over a playing video
   *  would ask for analyses faster than the cadence runs them. */
  staleFrameMs(now: number): number {
    return Math.max(STALE_FRAME_MS, this.intervalInEffectMs(now));
  }

  /** Is the newest analyzed frame stale against the picture on screen, or is there none yet? */
  frameStale(videoTimeSec: number, now: number): boolean {
    if (this.lastVideoTimeSec === null || this.discontinuitySinceLast) return true;
    return Math.abs(videoTimeSec - this.lastVideoTimeSec) * 1000 > this.staleFrameMs(now);
  }

  /**
   * The pointer moved over the picture: should the current picture be analyzed at once? Yes
   * when analysis may run, nothing is in flight, the last analysis started this way is at least
   * `HOVER_TRIGGER_MIN_GAP_MS` ago, and the newest analyzed frame is stale. The cadence is not
   * consulted.
   */
  hoverTriggerDue(now: number, videoTimeSec: number, inFlight: boolean): boolean {
    if (inFlight || !this.analysisActive(now)) return false;
    if (now - this.lastHoverTriggerAt < HOVER_TRIGGER_MIN_GAP_MS) return false;
    return this.frameStale(videoTimeSec, now);
  }

  /** An analysis of the current picture was started. */
  started(now: number, info: StartedInfo = {}): void {
    if (this.retryReady(now)) {
      // The retry's back-off ran out: this start uses it up as it would a presented frame.
      this.retryAt = null;
      this.pending = true;
      this.repeatsLeft = 0;
    }
    this.lastStartedAt = now;
    const hover = info.trigger === "hover";
    const cut = info.trigger === "cut" || this.lookRequested;
    this.lastTriggerKind = hover ? "hover" : cut ? "cut" : this.pending ? "cadence" : "repeat";
    if (hover) this.lastHoverTriggerAt = now;
    if (info.videoTimeSec !== undefined) this.lastVideoTimeSec = info.videoTimeSec;
    this.discontinuitySinceLast = false;
    this.lookRequested = false;
    if (this.pending || hover || cut) {
      // A look started by the pointer or by a cut uses up the pending frame just as a start by
      // the cadence does, and a still picture then gets its repeats.
      this.pending = false;
      this.repeatsLeft = this.confirmFrames - 1;
    } else if (this.repeatsLeft > 0) {
      this.repeatsLeft -= 1;
    }
  }

  /** Why the last analysis ran; null before the first. */
  get lastTrigger(): AnalysisTrigger | null {
    return this.lastTriggerKind;
  }

  /** Time since the last analysis was started, in ms; null before the first. */
  msSinceLastAnalysis(now: number): number | null {
    return this.lastStartedAt === -Infinity ? null : now - this.lastStartedAt;
  }

  /** Is there nothing left to do until a new frame is presented? False while the retry of an
   *  unanswered look is waiting. */
  get idle(): boolean {
    return !this.pending && this.repeatsLeft === 0 && this.retryAt === null;
  }
}
