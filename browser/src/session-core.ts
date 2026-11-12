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
// What is never shown: a result from before a seek, a new source or a cut (a card the reading hold
// keeps outlives a cut); a result further than
// the release's `hover.maxAgeMs` of video time from the picture on screen; anything for a box that
// was detected and not named. With the optional hold (`SHOWN_HOLD`), a shown card survives short
// gaps; with the reading hold (`READING_HOLD`), it stays until the pointer leaves the spot where
// it was; without either (the default), what is shown is exactly the newest result at the pointer.

import { type AABB, iou } from "./boxes.js";
import type { AnalysisWidth } from "./capture.js";
import { analyzeIntervalMs, cadenceMs, type GeometricScope, MeasuredPacer, resolveGeometricScope, type MeasuredPacingOption, resolveMeasuredPacing, type SessionMode } from "./cadence.js";
import { ANALYSIS_WATCHDOG_MS, FIRST_ANALYSIS_WATCHDOG_MS, FrameScheduler, HOVER_MAX_AGE_MS, rejectionAnswersInFlight, replyRejection, withinMaxAge } from "./frame-scheduler.js";
import { ANALYSIS_FAILED, BUSY_ERROR, type FrameEnvelope, type FrameResult, type GeometricStatus, type ReleaseProgress, type ReleaseStatus, type TiltedStatus, type WorkerReply, type WorkerRequest } from "./messages.js";
import { type FractionBox, MAX_OTHER_BOXES } from "./compute-messages.js";
import { hoverAt } from "./hover-at.js";
import { ACCEPTED_NMS_IOU, focusGroup } from "./recognition.js";
import type { LayerCard } from "./hover-geometry.js";
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
  /** The card's outline when it is turned (session option `rotatedOutlines`): its tilt in
   *  degrees in (-45, 45], positive clockwise like CSS `rotate()`, and its own sides in fractions
   *  of the picture, about the center of `box`. All three or none; absent for an upright card. */
  rotation?: number;
  localWidth?: number;
  localHeight?: number;
  /** Under a reading hold only: true when the kept card's outline should not be drawn. `box`,
   *  with the outline fields, is where the card was last seen. It is set when an analysis shows the
   *  card gone from there (another card named there, or nothing named or detected there), and when
   *  no recent analysis is left and none is coming (a resting pointer past its grace period on a
   *  playing video). It stays set until an analysis sees the card there again. Absent while the
   *  card is seen or its box is still detected there. */
  held?: true;
}

/** The shown card's hold: how long it survives analyses that do not see it at the pointer. */
export interface ShownHold {
  /** Analyses in a row with nothing there before it goes. A reply with no analysis, or one too
   *  old for the picture on screen when it comes back, is not one. */
  misses: number;
  /** Time with no analysis seeing it before it goes, in ms. */
  maxMs: number;
  /** A box detected at the pointer is the held card's box when they overlap at least this much
   *  (intersection over union); a box overlapping less is another card, and ends the hold. */
  sameBoxIou: number;
  /** True: a reading hold. Once a card is shown it stays while the pointer stays on the area it
   *  was seen in at the pointer (the union of its boxes since it was first shown), with no time
   *  limit: `misses` and `maxMs` do not end it, and a cut does not. Another card at the pointer
   *  replaces it only when the viewer moved onto it: a card in about the same box (the same card,
   *  or one not named then) overlapped the kept one in one of the last few analyses that saw the
   *  kept card at the pointer, and the pointer has since moved into that box from outside it. A card that arrived
   *  since, one that slid under a pointer at rest, or one uncovered under a pointer that only
   *  trembles inside its box, does not. The pointer leaving that
   *  area or the picture, a seek, a new source, a stop or a lost worker end it. It is marked
   *  `held` once an analysis shows it gone, or once no recent analysis is left and none is coming
   *  (`Shown.held`). In pointer mode, while it shows a card, a resting pointer is not analyzed
   *  after its grace period. */
  untilPointerLeaves?: boolean;
}

/** The hold that keeps a tooltip from flickering on a live stream. Counted in analyses because a
 *  resting pointer is analyzed at the slow cadence (1-2 s apart): a short time limit would hide the
 *  card on every single miss. */
export const SHOWN_HOLD: Readonly<ShownHold> = Object.freeze({ misses: 2, maxMs: 5_000, sameBoxIou: 0.5 });

/** The reading hold: a shown card stays until the pointer leaves the spot where it was, so that a
 *  viewer can read it after the card has moved ("ShownHold.untilPointerLeaves"). */
export const READING_HOLD: Readonly<ShownHold> = Object.freeze({ ...SHOWN_HOLD, untilPointerLeaves: true });


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
  /** The tilted retry was turned off for the session. */
  onTiltedStatus?(status: TiltedStatus): void;
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
  mode?: SessionMode;
  /** Hold a shown card through short gaps. Off when absent; `SHOWN_HOLD` is the usual value. */
  hold?: ShownHold;
  /** Other cards' boxes reported with a shown card (default `MAX_OTHER_BOXES`). */
  maxOtherBoxes?: number;
  /** The geometric stage was asked for: its status starts as "loading" (null otherwise). */
  geometric?: boolean;
  /** True: named cards follow their outline on every frame (`SessionOptions.rotatedOutlines`).
   *  Default false. */
  rotatedOutlines?: boolean;
  /** "focus": each frame asks the geometric stage to verify only the faces at the pointer
   *  (`SessionOptions.geometricScope`). Throws unless the mode is "pointer". Default "all". */
  geometricScope?: GeometricScope;
  /** Pace analysis from the measured analysis time (`SessionOptions.measuredPacing`). Off when
   *  absent. */
  measuredPacing?: MeasuredPacingOption;
}

/** What `status().loading` becomes on a release-progress reply: the reply's phase while the
 *  release loads; `undefined` (no change) once it has loaded or failed, or the session has
 *  stopped, so a reply that arrives late changes nothing. */
export function progressUpdate(state: SessionStatus["state"], reply: ReleaseProgress): SessionStatus["loading"] | undefined {
  return state === "loading" ? { phase: reply.phase, bytes: reply.bytes } : undefined;
}

/** The hovered card's outline, only when the card is turned: an upright card (or one without an
 *  outline) gives nothing, never `rotation: 0`. */
function turnedOutline(card: LayerCard | null): { rotation: number; localWidth: number; localHeight: number } | Record<string, never> {
  if (!card || !Number.isFinite(card.rotation) || card.rotation === 0) return {};
  const { rotation, localWidth, localHeight } = card;
  return rotation > -45 && rotation <= 45 && localWidth > 0 && localWidth <= 1 && localHeight > 0 && localHeight <= 1 ? { rotation, localWidth, localHeight } : {};
}

/** The boxes of an analysis's named and unnamed hover cards other than `box`, in fractions. */
export function neighborBoxes(analysis: FrameAnalysis, box: FractionBox, limit = MAX_OTHER_BOXES): FractionBox[] {
  return (analysis.hover?.cards ?? [])
    .map((c) => c.bounds)
    .filter((b) => b && !(Math.abs(b.x - box.x) < 1e-6 && Math.abs(b.y - box.y) < 1e-6 && Math.abs(b.width - box.width) < 1e-6))
    .slice(0, limit)
    .map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height }));
}

/** `neighborBoxes` for focus scope. A frame with no unverified face is listed exactly as a full
 *  analysis lists it. Otherwise, every face of each overlap group (boxes joined by an IoU of
 *  `ACCEPTED_NMS_IOU` or more, as the suppression joins them) that holds an unverified face is
 *  listed, kept, suppressed, verified or not, since nobody knows which a full analysis would
 *  have kept. Those come first and are not cut by the limit; the layer's other boxes follow, in
 *  its stacking order, up to the room the limit leaves. */
function neighborFaceBoxes(analysis: FrameAnalysis, box: FractionBox, limit: number): FractionBox[] {
  const own = neighborBoxes(analysis, box, Infinity);
  const groups = unverifiedGroupBoxesOf(analysis);
  if (groups.length === 0) return own.slice(0, limit);
  const same = (a: FractionBox, b: FractionBox): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.width - b.width) < 1e-6;
  const first = groups.filter((b) => !same(b, box));
  const rest = own.filter((o) => !first.some((g) => same(g, o)));
  return [...first, ...rest.slice(0, Math.max(0, limit - first.length))];
}

/** The boxes of every face in the overlap groups that hold a face the stage applies to and did
 *  not verify, in fractions of the frame, clamped as the layer's are. */
function unverifiedGroupBoxesOf(analysis: FrameAnalysis): FractionBox[] {
  const { width, height } = analysis.frame;
  const clamp = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
  const faces = (analysis.boxes ?? []).filter((b) => b.face !== null);
  const aabbs = faces.map((b) => ({ x: b.box[0], y: b.box[1], width: b.box[2], height: b.box[3] }));
  const seen = new Set<number>();
  const taken: number[] = [];
  faces.forEach((f, start) => {
    if (f.face!.unverified !== true || seen.has(start)) return;
    const queue = [start];
    seen.add(start);
    for (let q = 0; q < queue.length; q++) {
      aabbs.forEach((b, i) => {
        if (!seen.has(i) && iou(aabbs[queue[q]!]!, b) >= ACCEPTED_NMS_IOU) {
          seen.add(i);
          queue.push(i);
        }
      });
    }
    taken.push(...queue);
  });
  return [...new Set(taken)].sort((a, b) => a - b).map((i) => {
    const [x, y, w, h] = faces[i]!.box;
    return { x: clamp(x / width), y: clamp(y / height), width: clamp(w / width), height: clamp(h / height) };
  });
}

/** Whether, in this analysis, the pointer at (px, py) in the frame's pixels is on a group of
 *  overlapping faces (`focusGroup`) that holds a face the stage applies to and did not verify
 *  (geometricScope "focus"). Such a group is not answered: the analysis was taken with the
 *  pointer elsewhere, and a verified face beside an unverified one could be the card beneath. */
function pointerGroupUnverified(analysis: FrameAnalysis, px: number, py: number): boolean {
  const faces = (analysis.boxes ?? []).filter((b) => b.face !== null);
  const group = focusGroup(
    faces.map((b) => ({ x: b.box[0], y: b.box[1], width: b.box[2], height: b.box[3] })),
    { x: px, y: py },
  );
  return [...group].some((i) => faces[i]!.face!.unverified === true);
}

/** Whether the pointer's group needs a look of its own in focus scope: a face there was not
 *  verified, or, with `skipped` (a ready stage, whose focus look retries the group uncapped),
 *  the tilted retry's cap left a face there out (`tiltedSkipped`). */
function pointerGroupNeedsLook(analysis: FrameAnalysis, px: number, py: number, skipped: boolean): boolean {
  const faces = (analysis.boxes ?? []).filter((b) => b.face !== null);
  const group = focusGroup(
    faces.map((b) => ({ x: b.box[0], y: b.box[1], width: b.box[2], height: b.box[3] })),
    { x: px, y: py },
  );
  return [...group].some((i) => faces[i]!.face!.unverified === true || (skipped && faces[i]!.face!.tiltedSkipped === true));
}

interface InFlight {
  requestId: number;
  /** When the capture was asked for: the watchdog and the round trip count from here. */
  sentAt: number;
  generation: number;
  videoKey: string;
  /** Set once the picture went to the worker. */
  analyzing: boolean;
  /** The pointer, in fractions of the picture, when the capture was asked for. */
  pointer: { x: number; y: number } | null;
  /** The scheduler started this look as a repeat of a still picture. Whether the picture is
   *  still is decided when it arrives (`frame`): in focus scope a repeat of an unchanged picture
   *  is analyzed as scope "all", which checks every face for the next card. */
  repeat: boolean;
  /** Set when the picture goes to the worker: whether the analysis is of every face. */
  full: boolean;
}

/** The newest look that came back analyzed: its picture's time, generation and source. A repeat
 *  whose captured picture has the same time, in the same generation and source, is of a picture
 *  whose clock stood still (paused, frozen, stalled, ended, an image). */
interface LastLook {
  /** The request that analyzed the picture (not a reuse of it): what `reuseOf` names. */
  requestId: number;
  /** Whether that look verified every face (scope "all", or a full pass in focus scope). A focus
   *  look verifies the pointer's group, and what it leaves unmarked is not known to match "all". */
  full: boolean;
  mediaTime: number;
  generation: number;
  videoKey: string;
}

/** Two video times closer than this are the same time. */
const SAME_TIME_SEC = 0.001;

export class SessionCore {
  readonly scheduler: FrameScheduler;
  private readonly mode: SessionMode;
  private readonly hold: ShownHold | null;
  private readonly maxOtherBoxes: number;
  private readonly rotatedOutlines: boolean;
  private readonly focusScope: boolean;
  private readonly hitTest: typeof hoverAt;
  private readonly pacer: MeasuredPacer | null;

  private readonly st: SessionStatus;
  private cardList: ReleaseStatus["cards"] = [];
  private analysisWidth: AnalysisWidth = { min: 720, max: 1920 };
  private maxAgeMs = HOVER_MAX_AGE_MS;
  private nextRequestId = 1;
  private inFlight: InFlight | null = null;
  private lastAcceptedRequestId = 0;
  /** Whether the worker answered a look with an analysis since its release loaded: until then
   *  the watchdog waits `FIRST_ANALYSIS_WATCHDOG_MS`. */
  private analyzedSinceLoad = false;
  private generation = 0;
  private sourceCount = 0;
  private result: { analysis: FrameAnalysis; videoTimeSec: number } | null = null;
  private pointerAt: { x: number; y: number } | null = null;
  private mediaTime = 0;
  private lastShownKey = "null";
  private lastStatusKey = "";
  /** The card the hold keeps. Under a reading hold, `area` is the rectangle enclosing every box it
   *  was seen in at the pointer since it was first shown, which the pointer must stay on, and the
   *  `reading` fields hold the rest (see `readingHold`). */
  private held: { card: Shown; misses: number; seenAt: number; area: FractionBox; reading?: ReadingState } | null = null;

  constructor(
    private readonly deps: SessionCoreDeps,
    options: SessionCoreOptions = {},
  ) {
    this.mode = options.mode ?? "pointer";
    this.hold = options.hold ?? null;
    this.maxOtherBoxes = options.maxOtherBoxes ?? MAX_OTHER_BOXES;
    this.rotatedOutlines = options.rotatedOutlines === true;
    this.focusScope = resolveGeometricScope(options.geometricScope, this.mode) === "focus";
    this.hitTest = deps.hoverAt ?? hoverAt;
    const share = resolveMeasuredPacing(options.measuredPacing);
    this.pacer = share === null ? null : new MeasuredPacer(share);
    this.scheduler = new FrameScheduler(cadenceMs(null, this.mode), CONFIRM_FRAMES, this.mode, analyzeIntervalMs(null));
    this.st = {
      state: "loading", error: null, release: null, backend: null, schedule: "idle", frames: 0,
      lastWorkerMs: null, lastRoundTripMs: null, lastFrameError: null,
      geometric: options.geometric ? { state: "loading", reason: null, bytes: null } : null,
      loading: null,
      tilted: null,
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
    else this.relookForUnverified();
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
    // A reading hold that showed a card: the viewer is still at that spot, so the usual reading
    // linger runs from now and the new picture is looked at, whatever the rest so far.
    if (this.hold?.untilPointerLeaves && this.held && this.pointerAt) this.scheduler.setTooltipShowing(true, this.deps.now());
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
    // A reading hold survives a cut: the viewer is still reading the card.
    if (!this.hold?.untilPointerLeaves) this.held = null;
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
    // Pointer mode, a repeat of a still picture, and nothing unverified in the newest result:
    // the picture is not analyzed again, but the worker is asked to feed the newest analyzed
    // frame's detections to the tracker and the temporal gate once more (`reuseOf`), so that the
    // track layer fills on a paused picture as it always did. It takes milliseconds. A worker
    // that cannot vouch for the frame (a reset, a stage that joined since) analyzes the picture.
    sent.analyzing = true;
    const envelope: FrameEnvelope = { requestId: sent.requestId, mediaTimeSec: mediaTime, generation: sent.generation, videoKey: sent.videoKey };
    // The pointer as it was when the picture was asked for, in the picture's pixels (the bitmap
    // is already at analysis size). Sent only with the option on.
    const focus = sent.pointer ? { x: sent.pointer.x * bitmap.width, y: sent.pointer.y * bitmap.height } : null;
    // A repeat of a picture whose time has not moved since the previous analyzed look (same
    // generation and source) is analyzed as scope "all". Times are the captured pictures' own
    // (`mediaTimeOf`), two captures at least REPEAT_INTERVAL_MS apart, so an equal time means the
    // clock stood still. The presented events, which a seek reports two or three times, are not
    // consulted.
    const still = this.isStillRepeat(sent, mediaTime);
    // The pointer's own card comes first: when the pointer's group is not verified in the newest
    // result (a seek's look was asked for with the old pointer, and the pointer has moved since),
    // this repeat is a focus look at the pointer, and the full pass follows on the next repeat.
    const yields = this.focusScope && still && focus !== null && this.result !== null && pointerGroupNeedsLook(this.result.analysis, focus.x, focus.y, this.stageReady());
    const full = still && !yields;
    const reuseOf = this.mode === "pointer" && !yields && this.lastLook !== null && this.lastLook.full && this.stillNeedsNothing(sent, mediaTime) ? this.lastLook.requestId : undefined;
    // With no ready stage the worker analyzes every face whatever the scope: the look is full.
    sent.full = !this.focusScope || full || !this.stageReady();
    try {
      this.deps.toWorker(
        {
          kind: "frame",
          bitmap,
          videoTimeSec: mediaTime,
          envelope,
          // A full pass in focus scope with the stage ready still sends the pointer, without the
          // scope: the stage verifies every face, and the pointer only puts the faces holding it
          // first in the tilted retry's order, so that its cap (`maxFacesPerFrame`) does not leave
          // out the card at the pointer. Without a ready stage nothing is sent, as with the option off.
          ...(this.focusScope && !full
            ? { geometricScope: "focus" as const, focus }
            : this.focusScope && focus !== null && this.stageReady()
              ? { focus }
              : {}),
          ...(this.rotatedOutlines ? { rotatedOutlines: true } : {}),
          ...(reuseOf !== undefined ? { reuseOf } : {}),
        },
        [bitmap],
      );
    } catch (error) {
      // Not transferred, so still ours: close it, and ask again as for a look given up on.
      bitmap.close();
      this.inFlight = null;
      this.st.lastFrameError = `analysis-failed: ${String(error)}`;
      this.scheduler.lookUnanswered(this.deps.now());
    }
    this.publish();
  }

  /** Is this capture a repeat of the picture the newest analyzed look was taken at? */
  private isStillRepeat(sent: InFlight, mediaTime: number): boolean {
    const last = this.lastLook;
    return sent.repeat && last !== null && last.generation === sent.generation && last.videoKey === sent.videoKey && Math.abs(last.mediaTime - mediaTime) < SAME_TIME_SEC;
  }

  /** A still repeat with no unverified face in the newest result has nothing to add. */
  private stillNeedsNothing(sent: InFlight, mediaTime: number): boolean {
    if (!this.isStillRepeat(sent, mediaTime) || this.result === null) return false;
    return !(this.result.analysis.boxes ?? []).some((b) => b.face?.unverified === true);
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
      case "tilted-status":
        this.st.tilted = { state: "off", reason: reply.reason };
        this.deps.onTiltedStatus?.(reply);
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
        this.analyzedSinceLoad = false;
        this.st.error = reply.error;
        this.st.release = reply.release;
        this.st.loading = null;
        this.st.tilted = reply.release?.tiltedRetry ? { state: "on", reason: null } : null;
        this.cardList = reply.cards;
        if (reply.release) {
          this.st.backend = reply.release.recognizer.ep;
          this.maxAgeMs = reply.release.hoverMaxAgeMs;
          this.analysisWidth = { ...reply.release.analysisWidth };
          this.applyCadence();
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

  /** Arm the scheduler with the cadence for the backend: today's fixed rates, or the measured
   *  ones with `measuredPacing`. */
  private applyCadence(): void {
    const ep = this.st.backend;
    this.scheduler.setIntervalMs(this.pacer ? this.pacer.intervalMs(ep, this.mode) : cadenceMs(ep, this.mode));
    this.scheduler.setReadingIntervalMs(this.pacer ? this.pacer.readingMs(ep, this.maxAgeMs) : analyzeIntervalMs(ep));
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
    const reused = reply.analysis?.reused === true;
    if (reply.analysis && !reused) this.lastLook = { requestId: reply.envelope.requestId, full: sent.full, mediaTime: reply.envelope.mediaTimeSec, generation: reply.envelope.generation, videoKey: reply.envelope.videoKey };
    this.st.lastFrameError = reply.error ?? null;
    if (!reused) this.st.lastWorkerMs = reply.workerMs;
    this.st.lastRoundTripMs = +(now - sent.sentAt).toFixed(2);
    if (reply.analysis) {
      this.analyzedSinceLoad = true;
      // A reused reply took milliseconds: it says nothing of how fast the worker analyzes, and
      // it is no analysis to count.
      if (this.pacer && !reused) {
        this.pacer.record(reply.workerMs);
        this.applyCadence();
      }
      this.scheduler.lookAnswered();
      if (!reused) this.st.frames += 1;
      this.result = { analysis: reply.analysis, videoTimeSec: reply.videoTimeSec };
      this.deps.onAnalysis?.(reply.analysis);
    } else {
      this.result = null;
      // The worker busy, or the analysis failed (a model or GPU error, which may pass): asked
      // again after a back-off. A refusal that will not pass (no release, no 2D context) is not.
      if (reply.error === BUSY_ERROR || reply.error?.startsWith(ANALYSIS_FAILED) === true) this.scheduler.lookUnanswered(now);
    }
    // A miss is an analysis of the picture on screen without the card at the pointer. A reply that
    // analyzed nothing (busy, an error), or one already older than hover.maxAgeMs when it came
    // back (a slow analysis of a playing video), judged nothing: only hold.maxMs ends the hold.
    if (this.held && this.pointerAt && this.current() && !this.fresh()) this.held.misses += 1;
    const showing = this.reportShown(now);
    if (reply.analysis && !showing) this.scheduler.lookFoundNoCard();
    this.publish();
  }

  // ------------------------------------------------------------------ the driver
  /** Call every `DRIVER_TICK_MS`. */
  tick(): void {
    if (this.st.state === "stopped") return;
    const now = this.deps.now();
    const watchdogMs = this.analyzedSinceLoad ? ANALYSIS_WATCHDOG_MS : FIRST_ANALYSIS_WATCHDOG_MS;
    if (this.inFlight && now - this.inFlight.sentAt >= watchdogMs) {
      // No answer: give up on this look so that the next one can go. A late picture is closed; a
      // late reply is recognized by its request number and dropped. Before the worker's first
      // analysis the wait is longer: that one warms the models up.
      this.inFlight = null;
      this.st.lastFrameError = "no reply";
      this.scheduler.lookUnanswered(now);
    }
    this.reportShown(now);
    if (this.st.state === "ready" && !this.inFlight && this.scheduler.due(now)) this.requestCapture(this.scheduler.lookPending ? "cut" : undefined);
    else this.relookForUnverified();
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
   * status only when a stage was asked for). `{ idle: true }`: the worker was ended on purpose
   * (worker-session.ts `suspend`): as a restart, but not a loss; a running stage is reported off
   * with the reason `idle-unload`. `{ error }`: recognition is off ("failed").
   * Ignored once stopped or failed.
   */
  workerStopped(next: { restart: true } | { idle: true } | { error: string }): void {
    if (this.st.state === "stopped" || this.st.state === "failed") return;
    this.inFlight = null;
    this.result = null;
    this.held = null;
    this.st.loading = null;
    this.publishShown();
    if ("idle" in next) {
      // The worker was ended on purpose, not lost: loading again, the release in effect kept. A
      // stage that was running is reported off with the reason `idle-unload` (to `onGeometricStatus`
      // too), so that no host keeps showing it as on; a resume that loads it again sets it loading
      // (`reloading`). One that was off, or never asked for, is left as it was.
      if (this.st.geometric && this.st.geometric.state !== "off") {
        const off: GeometricStatus = { kind: "geometric-status", state: "off", reason: "idle-unload", bytes: null };
        this.st.geometric = { state: off.state, reason: off.reason, bytes: off.bytes };
        this.deps.onGeometricStatus?.(off);
      }
      this.st.state = "loading";
      this.analyzedSinceLoad = false;
      this.st.error = null;
    } else if ("restart" in next) {
      const off: GeometricStatus = { kind: "geometric-status", state: "off", reason: "worker-restarted", bytes: null };
      if (this.st.geometric) this.st.geometric = { state: off.state, reason: off.reason, bytes: off.bytes };
      this.deps.onGeometricStatus?.(off);
      this.st.state = "loading";
      this.analyzedSinceLoad = false;
      this.st.error = null;
    } else {
      this.st.state = "failed";
      this.st.error = next.error;
    }
    this.publishStatus();
  }

  /** Whether a look is out: asked for, or being analyzed. */
  analysisInFlight(): boolean {
    return this.inFlight !== null;
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

  /**
   * Focus scope: the pointer is on a face the stage applies to that the newest analysis did not
   * verify (or in a group with one), so the picture is analyzed again with the pointer there,
   * as a look started by the pointer: at most once per `HOVER_TRIGGER_MIN_GAP_MS`, never while
   * one is in flight, with the repeats a newly presented picture gets. It stops by itself: that
   * look verifies the pointer's group, so nothing is unverified there any more.
   */
  private relookForUnverified(): void {
    if (!this.focusScope || this.st.state !== "ready" || !this.pointerAt || !this.result) return;
    const { analysis } = this.result;
    const { width, height } = analysis.frame;
    if (!(width > 0 && height > 0)) return;
    if (!pointerGroupNeedsLook(analysis, this.pointerAt.x * width, this.pointerAt.y * height, this.stageReady())) return;
    if (this.scheduler.relookDue(this.deps.now(), this.inFlight !== null)) this.requestCapture("hover");
  }

  /** Whether the geometric stage is ready: only then does a focus look retry the pointer's group
   *  uncapped (without a stage the worker ignores the scope). */
  private stageReady(): boolean {
    return this.st.geometric?.state === "ready";
  }

  /** The newest look that came back analyzed (`LastLook`). */
  private lastLook: LastLook | null = null;

  private requestCapture(trigger?: "hover" | "cut"): void {
    if (this.st.state !== "ready" || this.inFlight) return;
    const now = this.deps.now();
    const requestId = this.nextRequestId++;
    this.inFlight = { requestId, sentAt: now, generation: this.generation, videoKey: this.videoKey, analyzing: false, pointer: this.pointerAt ? { ...this.pointerAt } : null, repeat: false, full: true };
    this.scheduler.started(now, { videoTimeSec: this.videoTime(), ...(trigger ? { trigger } : {}) });
    this.inFlight.repeat = this.scheduler.lastTrigger === "repeat";
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
    // Focus scope: a result is valid where its faces were verified, so nothing is named in a
    // group that holds a face it did not verify (the card beneath could show through).
    if (this.focusScope && pointerGroupUnverified(result.analysis, x, y)) return null;
    const hit = this.hitTest(result.analysis, x, y);
    if (!hit.box || hit.cardId === null || hit.name === null) return null;
    const box = { x: hit.box.x / width, y: hit.box.y / height, width: hit.box.width / width, height: hit.box.height / height };
    const frameBox = { x: hit.box.x, y: hit.box.y, width: hit.box.width, height: hit.box.height };
    return { cardId: hit.cardId, name: hit.name, box, frameBox, others: this.focusScope ? neighborFaceBoxes(result.analysis, box, this.maxOtherBoxes) : neighborBoxes(result.analysis, box, this.maxOtherBoxes), ...turnedOutline(hit.card) };
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
   * at once; the pointer leaving its box, a seek, a new source or a cut end it at once. A reading
   * hold (`untilPointerLeaves`) keeps it on other terms: see `ShownHold.untilPointerLeaves`.
   */
  shown(): Shown | null {
    const fresh = this.fresh();
    const hold = this.hold;
    if (!hold) return fresh;
    if (hold.untilPointerLeaves) return this.readingHold(fresh);
    if (!fresh && this.focusScope && this.pointerGroupHoldsUnverified()) {
      // The pointer is on a group the newest result did not fully verify: a held card ends too.
      this.held = null;
      return null;
    }
    const now = this.deps.now();
    if (fresh) {
      this.held = { card: fresh, misses: 0, seenAt: now, area: fresh.box };
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

  /** Tell the scheduler what is shown. Returns whether the newest analysis sees a card at the
   *  pointer (with the usual hold or none: whether a card is shown). Under a reading hold the
   *  scheduler hears both: a card it keeps stops the looks of a resting pointer, and a pointer on
   *  a spot the newest analysis finds empty is looked at as an empty spot. */
  private reportShown(now: number): boolean {
    const shown = this.shown();
    if (!this.hold?.untilPointerLeaves) {
      this.scheduler.setTooltipShowing(shown !== null, now);
      return shown !== null;
    }
    const seen = this.fresh() !== null;
    this.scheduler.setTooltipShowing(seen, now);
    this.scheduler.setReadingHoldShowing(shown !== null);
    return seen;
  }

  /**
   * `shown()` under a reading hold (`ShownHold.untilPointerLeaves`). `shown()` is called several
   * times per tick, so what an analysis tells is taken once, the first time it is read
   * (`reading.evidence`): the overlapping cards (`neighbors`, merged from the last few analyses
   * that saw the kept card at the pointer, and capped) and whether the card is gone
   * (`gone`, kept between analyses). With no recent analysis left and none coming, the card is
   * taken as gone too, until an analysis sees it again.
   */
  private readingHold(fresh: Shown | null): Shown | null {
    const held = this.held;
    const reading = held?.reading;
    if (!held || !reading || !this.pointerAt || !inside(held.area, this.pointerAt)) {
      this.held = fresh ? this.newReadingHold(fresh) : null;
      return fresh;
    }
    const evidence = this.takeEvidence(reading);
    if (fresh && fresh.cardId === held.card.cardId) {
      held.card = fresh;
      held.seenAt = this.deps.now();
      held.area = union(held.area, fresh.box);
      reading.gone = false;
      reading.at = { ...this.pointerAt };
      reading.atFrom = this.current()?.analysis ?? null;
      if (evidence) {
        reading.sightings += 1;
        reading.neighbors = this.mergeNeighbors(reading, this.neighborsIn(held.area, fresh));
      }
      return fresh;
    }
    // Another card at the pointer that overlapped the kept card when it was last seen, whose box the
    // pointer has since moved into: the viewer went to it, as on a fan of overlapping cards, so it
    // is shown. A card that arrived since, one that slid under a pointer at rest, or one uncovered
    // under a pointer that only trembles inside its box, is not: the kept card stays.
    if (fresh && this.movedOnto(reading, fresh)) {
      this.held = this.newReadingHold(fresh);
      return fresh;
    }
    if (evidence) reading.gone = this.missing(held.card);
    else if (!reading.gone && this.current() === null && !this.scheduler.analysisActive(this.deps.now())) {
      reading.gone = true;
    }
    return reading.gone ? { ...held.card, held: true } : held.card;
  }

  private newReadingHold(card: Shown): NonNullable<SessionCore["held"]> {
    const analysis = this.current()?.analysis ?? null;
    const neighbors = this.neighborsIn(card.box, card).map((n) => ({ ...n, sighting: 0 }));
    const reading: ReadingState = { neighbors, sightings: 0, evidence: analysis, gone: false, at: { ...this.pointerAt! }, atFrom: analysis };
    return { card, misses: 0, seenAt: this.deps.now(), area: card.box, reading };
  }

  /** The newest analysis, if recent, analyzed afresh (not a reuse) and not yet taken: taken now. */
  private takeEvidence(reading: ReadingState): boolean {
    const analysis = this.current()?.analysis;
    if (!analysis || analysis.reused === true || analysis === reading.evidence) return false;
    reading.evidence = analysis;
    return true;
  }

  /** Whether `fresh` is one of the kept card's neighbors (in about the same box, and the same card,
   *  or one that was not named then) and the pointer moved into that box from outside it since the
   *  kept card was last seen at the pointer. */
  private movedOnto(reading: ReadingState, fresh: Shown): boolean {
    const now = this.pointerAt;
    if (!now) return false;
    const sameBoxIou = this.hold?.sameBoxIou ?? SHOWN_HOLD.sameBoxIou;
    return reading.neighbors.some(
      (n) =>
        sameCard(n, fresh.cardId, n.box, fresh.box, sameBoxIou) &&
        inside(n.box, now) &&
        // The pointer was in this box when the kept card was last seen there, and that analysis
        // listed this card: the kept card lay over it at that point, and a pointer still in the
        // box has only trembled. A card that analysis did not list tells nothing of that.
        !(inside(n.box, reading.at) && listedIn(reading.atFrom, n, sameBoxIou)),
    );
  }

  /** The kept card's neighbors after another analysis saw it at the pointer: `current`'s, merged
   *  with those of the last `NEIGHBOR_SIGHTINGS` such analyses (a card missed by one look is not
   *  forgotten), newest first, at most `MAX_NEIGHBORS`. */
  private mergeNeighbors(reading: ReadingState, current: Array<{ cardId: string | null; box: FractionBox }>): Neighbor[] {
    const sameBoxIou = this.hold?.sameBoxIou ?? SHOWN_HOLD.sameBoxIou;
    const s = reading.sightings;
    const out = reading.neighbors.filter((n) => n.sighting > s - NEIGHBOR_SIGHTINGS).map((n) => ({ ...n }));
    for (const c of current) {
      const same = out.find((n) => sameCard(n, c.cardId, n.box, c.box, sameBoxIou));
      if (same) {
        same.box = c.box;
        same.cardId = c.cardId ?? same.cardId;
        same.sighting = s;
      } else {
        out.push({ ...c, sighting: s });
      }
    }
    return out.sort((a, b) => b.sighting - a.sighting).slice(0, MAX_NEIGHBORS);
  }

  /** The cards in the newest result (named or not) whose boxes overlap `area`, but `card` itself. */
  private neighborsIn(area: FractionBox, card: Shown): Array<{ cardId: string | null; box: FractionBox }> {
    const cards = this.current()?.analysis.hover?.cards ?? [];
    const out: Array<{ cardId: string | null; box: FractionBox }> = [];
    for (const c of cards) {
      const b = c.bounds;
      if (!b || (c.cardId === card.cardId && iouOf(b, card.box) >= 0.9)) continue;
      if (b.x < area.x + area.width && area.x < b.x + b.width && b.y < area.y + area.height && area.y < b.y + b.height) {
        out.push({ cardId: c.cardId, box: { x: b.x, y: b.y, width: b.width, height: b.height } });
      }
    }
    return out;
  }

  /** Whether the newest analysis names `card` anywhere in the box it was last seen in: at any of a
   *  grid of points across it, so that a card partly covered (a fan, a stack) still counts. */
  private seenAt(card: Shown): boolean {
    const b = card.box;
    for (const fy of [0.1, 0.5, 0.9]) {
      for (const fx of [0.05, 0.25, 0.5, 0.75, 0.95]) {
        if (this.hitAt(b.x + fx * b.width, b.y + fy * b.height)?.cardId === card.cardId) return true;
      }
    }
    return false;
  }

  /** Whether a recent analysis positively shows `card` gone from where it was last seen: there is
   *  a result for the picture on screen, and it names another card at the center of the card's
   *  box, or names none there and detects no box overlapping the card's box (a card detected but
   *  not named this time is still there). With no recent result nothing is known, and the card is
   *  not called missing. */
  private missing(card: Shown): boolean {
    const result = this.current();
    if (result === null) return false;
    if (this.seenAt(card)) return false;
    const center = this.hitAt(card.box.x + card.box.width / 2, card.box.y + card.box.height / 2);
    if (center !== null) return true;
    // Not named: still there if a box the analysis detected overlaps the card's last box.
    const { width, height } = result.analysis.frame;
    if (!(width > 0 && height > 0)) return false;
    const last = { x: card.box.x * width, y: card.box.y * height, width: card.box.width * width, height: card.box.height * height };
    const sameBoxIou = this.hold?.sameBoxIou ?? SHOWN_HOLD.sameBoxIou;
    return !(result.analysis.boxes ?? []).some((d) => {
      const [x, y, w, h] = d.box;
      return iouOf(last, { x, y, width: w, height: h }) >= sameBoxIou;
    });
  }

  /** Whether the pointer is, in the newest result, on a group that holds an unverified face. */
  private pointerGroupHoldsUnverified(): boolean {
    const result = this.current();
    if (!result || !this.pointerAt) return false;
    const { width, height } = result.analysis.frame;
    return width > 0 && height > 0 && pointerGroupUnverified(result.analysis, this.pointerAt.x * width, this.pointerAt.y * height);
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

  /** Report what is shown when it changed (the card, its box, or its outline). */
  private publishShown(): void {
    const card = this.shown();
    const key = card ? `${card.cardId}|${card.box.x}|${card.box.y}|${card.box.width}|${card.box.height}|${card.rotation ?? ""}|${card.localWidth ?? ""}|${card.localHeight ?? ""}|${card.held ? "held" : ""}` : "null";
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

/** A card overlapping a reading hold's kept card when an analysis last saw it; `cardId` null when
 *  that analysis detected it without naming it (a face outside a focus look's group, or one whose
 *  recognition came and went). */
interface Neighbor {
  cardId: string | null;
  box: FractionBox;
  /** `ReadingState.sightings` when an analysis last listed it. */
  sighting: number;
}

/** How many of the latest analyses that saw a reading hold's card at the pointer its neighbors are
 *  kept from, and at most how many: a card one look missed is not forgotten, and the list stays
 *  bounded however long the pointer rests. */
const NEIGHBOR_SIGHTINGS = 3;
const MAX_NEIGHBORS = 16;

/** Whether a neighbor (`id`, `box`) is the card `otherId` in `other`: about the same box, and the
 *  same card unless either was not named. */
function sameCard(n: { cardId: string | null }, otherId: string | null, box: FractionBox, other: FractionBox, sameBoxIou: number): boolean {
  return (n.cardId === null || otherId === null || n.cardId === otherId) && iouOf(box, other) >= sameBoxIou;
}

/** Whether `analysis` lists the neighbor `n` in its hover layer. */
function listedIn(analysis: FrameAnalysis | null, n: Neighbor, sameBoxIou: number): boolean {
  return (analysis?.hover?.cards ?? []).some((c) => c.bounds !== undefined && sameCard(n, c.cardId, n.box, c.bounds, sameBoxIou));
}

/** A reading hold's state beyond the card and its area (`SessionCore.readingHold`). */
interface ReadingState {
  neighbors: Neighbor[];
  /** The analysis last taken as evidence: each is taken once. */
  evidence: FrameAnalysis | null;
  /** Whether the card is taken as gone: its outline is not drawn (`Shown.held`). */
  gone: boolean;
  /** Analyses that saw the kept card at the pointer since the hold began. */
  sightings: number;
  /** Where the pointer was when the kept card was last seen at it, and in which analysis: a
   *  neighbor that analysis listed is moved onto from outside its box. */
  at: { x: number; y: number };
  atFrom: FrameAnalysis | null;
}

/** The rectangle enclosing both boxes. */
function union(a: FractionBox, b: FractionBox): FractionBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function inside(box: FractionBox, p: { x: number; y: number }): boolean {
  return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
}
