// SPDX-License-Identifier: Apache-2.0
// From a frame to boxes, names and two layers. In Python: cardvision/infer/pipeline.py.
//
// One `analyze` call, in a fixed order, because the accept rule was calibrated on crops made
// exactly this way:
//   1. the detector runs once on the analysis frame (capture.ts brings a picture to that size);
//   2. a detection whose crop would be under the minimum size on either side is dropped;
//   3. each remaining box is clipped to the frame: this is the reported box;
//   4. a face is cut out with the truncation convention and recognized (recognition.ts); a
//      back is reported and never cropped;
//   5. two layers are built from the result:
//      - the hover layer: this frame's own looks, no history (hover-layer.ts). It is what a
//        tooltip answers from.
//      - the track layer: the tracker's cards with pooled identities (tracker.ts), shown only
//        while the temporal gate holds (temporal-gate.ts). It is for steady outlines.
//
// A pipeline holds state between frames (the tracker, the gate, the hover ids), so it expects
// the frames of one video in order, one at a time. `reset` forgets that state.

import type { AABB, Candidate } from "./boxes.js";
import type { EmbeddingBank } from "./bank.js";
import { clipToFrame, DEFAULT_MIN_CROP_PX, FACE_CLASS, splitByClass, validBox } from "./detector/decode.js";
import type { Frame, FrameDetector } from "./detector/detector.js";
import type { BatchEmbedder } from "./embedder.js";
import type { GeometricEvidence } from "./geometric/fusion.js";
import type { GeometricStage } from "./geometric/stage.js";
import type { LayerCard, StageSize } from "./hover-geometry.js";
import {
  DEFAULT_HOVER_SELECTION,
  hoverEntriesToCards,
  HoverIdAssigner,
  type HoverSelection,
  selectHoverLayer,
} from "./hover-layer.js";
export { hoverAt, hoverCardsOf } from "./hover-at.js";
import { type IdentityDisplay, type IdentityGroups, IdentityMap } from "./identity.js";
import { recognizeFrame, type Orientation, type ScoredFrame, type TiltedEvidence } from "./recognition.js";
import { type AcceptRule, DEFAULT_ACCEPT, EmbeddingRecognizer } from "./recognizer.js";
import { type SceneContext, toLayerCards } from "./scene.js";
import { CONFIRM_FRAMES, TemporalGate } from "./temporal-gate.js";
import type { TiltedRetrySettings } from "./tilt.js";
import { type Detection, Tracker } from "./tracker.js";

/** What the recognizer concluded about one face. */
export interface FaceResult {
  /** The chosen look's best bank row: its card id and name, whether or not it was accepted. */
  topId: string;
  topName: string | null;
  /** The chosen look's score. */
  similarity: number;
  /** The chosen look's margin over the best differently named card. */
  margin: number;
  /** The chosen orientation: 0 upright, k quarter turns counter-clockwise. */
  look: Orientation;
  /** Whether the three turned looks were computed. */
  retried: boolean;
  /** Whether the score reaches tau. */
  tauPassed: boolean;
  /** Whether the accept rule passed: whether a card is named. */
  accepted: boolean;
  /** The card id and name when a card is named, else null. */
  cardId: string | null;
  name: string | null;
  /** Whether the box is among those that reach tau and survive the suppression (the members of
   *  the "accepted-nms" hover selection, and, without a geometric stage, the tracker's input;
   *  with one, the tracker is given the cosine looks that would be kept without it). */
  kept: boolean;
  /** True on a face the geometric stage applies to that was not verified on this frame
   *  (`geometricScope: "focus"`): it is not named, whatever its cosine look. Absent otherwise. */
  unverified?: true;
  /** With a geometric stage that ran on this face: what it found and what the embedding alone
   *  answered (Python: `GeometricOutcome.to_json`). The fields above are the fused look's. */
  geometric?: GeometricEvidence;
  /** With the tilted retry, on a face it was tried on: the tilt, the rectangle that named the
   *  card (or none: `scale` null) and the answer before it (Python: `TiltedOutcome.to_json`).
   *  When a rectangle named the card, the fields above are its look's. */
  tilted?: TiltedEvidence;
}

/** One detected card of a frame. */
export interface BoxResult {
  /** `[x, y, width, height]` in pixels of the analyzed frame, clipped to the frame. */
  box: [number, number, number, number];
  /** The detector's score. */
  score: number;
  /** The detector's class index and its name. */
  cls: number;
  className: string;
  /** The recognizer's conclusion, for a face; null for any other class. */
  face: FaceResult | null;
}

/** Everything found in one analyzed frame. Plain data: it can be sent between threads. */
export interface FrameAnalysis {
  /** Size of the analyzed frame, in pixels. */
  frame: StageSize;
  /** The valid detections, best detector score first. */
  boxes: BoxResult[];
  /** The hover layer under the release's selection, bottom of the stack first. */
  hover: { selection: HoverSelection; cards: LayerCard[] };
  /** The track layer. `cards` is empty while `shown` is false. */
  tracks: { shown: boolean; cards: LayerCard[] };
  /** The picture was not continuous with the previous one: the state between frames was reset
   *  before this frame was analyzed. */
  discontinuity: boolean;
  /** How many faces had their turned looks computed, and how many embeddings were computed. */
  retried: number;
  embeddings: number;
  /** True when this is not a new analysis: the previous frame's detections were fed to the
   *  tracker and the temporal gate again (`Pipeline.reuse`). `tracks` and `timings` are new,
   *  `discontinuity` is false, `retried` and `embeddings` are 0; every other field is the
   *  previous analysis's. Absent on an analyzed frame. */
  reused?: true;
  /** Where the time went, in ms. `geometricMs` and `tiltedMs`, parts of `recognizeMs`, are
   *  there only while a geometric stage is set and while the tilted retry runs. */
  timings: { detectorMs: number; recognizeMs: number; analyzeMs: number; geometricMs?: number; tiltedMs?: number };
}

/** What a caller says about one frame (`Pipeline.analyze`). */
export interface AnalyzeOptions {
  /** False skips the tilted retry on this frame: the caller's own condition, such as the kind
   *  of footage. Default true. */
  tilted?: boolean;
  /** A point in the frame's pixels, such as the pointer: the tilted retry takes the faces whose
   *  box holds it first. */
  focus?: { x: number; y: number } | null;
  /** "focus" verifies with the geometric stage only the faces whose box holds `focus`
   *  and those joined to them by overlapping boxes (recognition.ts `focusGroup`), and names no
   *  face the stage applies to and did not verify; no `focus` then means no face is verified. Default "all": every face the stage applies to. */
  geometricScope?: "all" | "focus";
  /** True gives each named card on this frame its outline (tilt.ts `outlineRect`): `rotation`,
   *  `localWidth` and `localHeight` follow a tilted card, `bounds` stays the box. Default false:
   *  every card's outline is its box, as before. */
  rotatedOutlines?: boolean;
}

export interface PipelineOptions {
  detector: FrameDetector;
  embedder: BatchEmbedder;
  bank: EmbeddingBank;
  accept?: AcceptRule;
  identityGroups?: IdentityGroups | null;
  identityDisplay?: IdentityDisplay;
  /** Card id to name, from the catalog. Every bank id should be in it. */
  names: ReadonlyMap<string, string>;
  hoverSelection?: HoverSelection;
  /** Names of the detector's classes, by class index. */
  classNames?: readonly string[];
  faceClass?: number;
  minCropPx?: number;
  /** A clock in ms, for the timings. */
  now?: () => number;
  /** The optional geometric stage (geometric/stage.ts). Without it the pipeline is exactly what
   *  it was before the stage existed. `setGeometric` sets or removes it between frames. */
  geometric?: GeometricStage | null;
  /** The release's `tiltedRetry` settings (tilt.ts), or null: the retry is off. `setTiltedRetry`
   *  turns it off between frames. */
  tiltedRetry?: TiltedRetrySettings | null;
}

/** Video time moving back by more than this is a break in continuity (a seek back, a new still). */
export const DISCONTINUITY_BACK_SEC = 0.25;
/** Video time jumping forward by more than this is one too (a seek forward). It is generous
 *  against the slowest cadence, a stall, or double-speed playback. */
export const DISCONTINUITY_FORWARD_SEC = 5;

/** Whether the picture at `currentSec` breaks continuity with the one at `previousSec`. With
 *  no previous time, or no time at all, it does not. */
export function isDiscontinuity(previousSec: number | null, currentSec: number | undefined): boolean {
  if (previousSec === null || currentSec === undefined) return false;
  const delta = currentSec - previousSec;
  return delta < -DISCONTINUITY_BACK_SEC || delta > DISCONTINUITY_FORWARD_SEC;
}

function boxOf(b: AABB): [number, number, number, number] {
  return [b.x, b.y, b.width, b.height];
}

export class Pipeline {
  readonly hoverSelection: HoverSelection;
  private readonly detector: FrameDetector;
  private readonly embedder: BatchEmbedder;
  private readonly recognizer: EmbeddingRecognizer;
  private readonly names: ReadonlyMap<string, string>;
  private readonly classNames: readonly string[];
  private readonly faceClass: number;
  private readonly minCropPx: number;
  private readonly now: () => number;
  private readonly tracker: Tracker;
  private readonly gate = new TemporalGate(CONFIRM_FRAMES);
  private readonly hoverIds = new HoverIdAssigner();
  /** The last track layer shown: it is shown again on a frame that recognized nothing while
   *  the gate still holds, since the tracker returns only the tracks matched on that frame. */
  private heldCards: LayerCard[] = [];
  private lastVideoTimeSec: number | null = null;
  private geometric: GeometricStage | null;
  /** The stage that failed during the last frame, and why; taken by `takeGeometricFailure`. */
  private geometricFailure: { stage: GeometricStage; error: unknown } | null = null;
  private tiltedRetry: TiltedRetrySettings | null;
  /** Why the tilted retry failed during the last frame; taken by `takeTiltedFailure`. */
  private tiltedFailure: { error: unknown } | null = null;
  /** What the newest analyzed frame left for `reuse`; null once anything that could change an
   *  answer happened since (a reset, a stage or retry set, removed or failed). */
  private lastRun: { analysis: FrameAnalysis; detections: Detection[]; recognized: boolean; ctx: SceneContext } | null = null;

  constructor(options: PipelineOptions) {
    this.detector = options.detector;
    this.embedder = options.embedder;
    this.names = options.names;
    this.classNames = options.classNames ?? ["face", "back"];
    this.faceClass = options.faceClass ?? FACE_CLASS;
    this.minCropPx = options.minCropPx ?? DEFAULT_MIN_CROP_PX;
    this.hoverSelection = options.hoverSelection ?? DEFAULT_HOVER_SELECTION;
    this.now = options.now ?? (() => performance.now());
    this.geometric = options.geometric ?? null;
    this.tiltedRetry = options.tiltedRetry ?? null;
    const identity = new IdentityMap(options.identityGroups ?? null, (id) => this.names.has(id), options.identityDisplay ?? "best-printing");
    this.recognizer = new EmbeddingRecognizer(options.bank, options.accept ?? DEFAULT_ACCEPT, identity);
    this.tracker = new Tracker((pooled) => this.recognizer.matchPooled(pooled).cardId);
  }

  /** Rows in the bank. */
  get size(): number {
    return this.recognizer.size;
  }

  /** The stage that failed during a frame since the last call, and its error, or null. The
   *  pipeline has already removed it; the caller disposes of it and reports why. */
  takeGeometricFailure(): { stage: GeometricStage; error: unknown } | null {
    const failure = this.geometricFailure;
    this.geometricFailure = null;
    return failure;
  }

  /** The tilted retry's error during a frame since the last call, or null. The pipeline has
   *  already turned the retry off. */
  takeTiltedFailure(): { error: unknown } | null {
    const failure = this.tiltedFailure;
    this.tiltedFailure = null;
    return failure;
  }

  /** The tilted retry's settings in use, or null when it is off. */
  get tiltedSettings(): TiltedRetrySettings | null {
    return this.tiltedRetry;
  }

  /** Set or remove the tilted retry's settings. Call it between frames. */
  setTiltedRetry(settings: TiltedRetrySettings | null): void {
    this.tiltedRetry = settings;
    this.tiltedFailure = null;
    this.lastRun = null;
  }

  /** The geometric stage in use, or null. */
  get geometricStage(): GeometricStage | null {
    return this.geometric;
  }

  /** Set or remove the geometric stage. Call it between frames: a frame being analyzed keeps
   *  the stage it started with. */
  setGeometric(stage: GeometricStage | null): void {
    this.geometric = stage;
    this.geometricFailure = null;
    this.lastRun = null;
  }

  /** Forget everything carried between frames: tracks, the gate's run, the hover ids. Models
   *  and the bank stay. */
  reset(): void {
    this.tracker.reset();
    this.gate.reset();
    this.heldCards = [];
    this.hoverIds.reset();
    this.lastVideoTimeSec = null;
    this.lastRun = null;
  }

  /**
   * The newest analyzed frame again, for a picture that did not change: its detections go to the
   * tracker and the temporal gate once more, as an analysis of the same picture would, and the
   * result is the previous analysis with six fields set: `tracks` (this step of the tracker and
   * the gate), `timings` (detector and recognize 0, `analyzeMs` the time of the reuse, no
   * stage or retry times), `discontinuity: false`, `retried: 0`, `embeddings: 0` (no work was
   * done) and `reused: true`. Every other field is the previous analysis's, and the nested
   * objects (`boxes`, `hover`, `frame`) are shared with it, not cloned: do not modify them.
   * No detector, recognizer or stage runs. Null (analyze instead) when nothing was analyzed
   * since the last reset, or a stage or the tilted retry was set, removed or failed since.
   */
  reuse(videoTimeSec?: number): FrameAnalysis | null {
    const last = this.lastRun;
    if (last === null) return null;
    const tStart = this.now();
    if (videoTimeSec !== undefined) this.lastVideoTimeSec = videoTimeSec;
    const tracks = this.trackLayer(last.detections, last.recognized, last.ctx);
    const { geometricMs: _g, tiltedMs: _t, ...rest } = last.analysis.timings;
    return {
      ...last.analysis,
      tracks,
      discontinuity: false,
      retried: 0,
      embeddings: 0,
      reused: true,
      timings: { ...rest, detectorMs: 0, recognizeMs: 0, analyzeMs: this.now() - tStart },
    };
  }

  /** One step of the tracker and the gate: the track layer for these detections. */
  private trackLayer(detections: Detection[], recognized: boolean, ctx: SceneContext): { shown: boolean; cards: LayerCard[] } {
    const tracks = this.tracker.update(detections);
    const step = this.gate.observe(recognized);
    let trackCards: LayerCard[];
    if (!step.confirmed) {
      this.heldCards = [];
      trackCards = [];
    } else if (!recognized) {
      trackCards = this.heldCards;
    } else {
      trackCards = toLayerCards(
        tracks.map((t) => ({
          instanceId: t.instanceId,
          aabb: t.detection.aabb,
          rect: t.detection.rect,
          ...(t.detection.outline ? { outline: t.detection.outline } : {}),
          identity: t.identity,
        })),
        ctx,
      );
      this.heldCards = trackCards;
    }
    return { shown: step.confirmed, cards: trackCards };
  }

  /**
   * Analyze one frame, already at analysis size. `videoTimeSec` is its time in the video; when
   * it moves backwards, or jumps further forward than any cadence explains, the state between
   * frames is reset first: after a seek the new picture's cards sit where the old ones were,
   * and without a reset the tracker would carry the old identities for a few frames. A detector
   * or model error rejects the call, and that frame shows nothing. `options` says whether the
   * tilted retry runs on this frame and where its focus is.
   */
  async analyze(frame: Frame, videoTimeSec?: number, options: AnalyzeOptions = {}): Promise<FrameAnalysis> {
    const tStart = this.now();
    const discontinuity = isDiscontinuity(this.lastVideoTimeSec, videoTimeSec);
    if (discontinuity) {
      this.reset();
    }
    if (videoTimeSec !== undefined) this.lastVideoTimeSec = videoTimeSec;

    const proposed = await this.detector.propose(frame);
    const detectorMs = this.now() - tStart;
    const valid = proposed.filter((c) => validBox(c.aabb, frame.width, frame.height, this.minCropPx)).map((c) => clipToFrame(c, frame));
    const { faces } = splitByClass(valid, this.faceClass);

    const tRecognize = this.now();
    // Focus scope needs a stage: without one (none set, or one a failure removed) the request's
    // scope and focus are ignored, and the frame is analyzed exactly as with the option off.
    const asked = options.geometricScope === "focus";
    const focusScope = asked && this.geometric !== null;
    const focus = asked && !focusScope ? null : (options.focus ?? null);
    const tilted = this.tiltedRetry && options.tilted !== false ? { settings: this.tiltedRetry, focus } : null;
    const scored = await recognizeFrame(frame, this.embedder, this.recognizer, faces, this.minCropPx, this.geometric, tilted, options.rotatedOutlines === true, focusScope ? focus : undefined);
    const recognizeMs = this.now() - tRecognize;
    if (scored.tiltedError !== undefined && this.tiltedRetry) {
      // The retry failed on this frame: the frame is answered without it, and it is off.
      this.tiltedFailure = { error: scored.tiltedError };
      this.tiltedRetry = null;
    }
    if (scored.geometricError !== undefined && this.geometric) {
      // The stage failed on this frame: the frame is answered without it (recognizeFrame fell
      // back to the cosine looks), and the stage is removed. The caller disposes of it.
      this.geometricFailure = { stage: this.geometric, error: scored.geometricError };
      this.geometric = null;
    }
    if (scored.proposals.length !== faces.length) throw new Error("pipeline: a valid face box was not recognized");

    const ctx: SceneContext = { frameWidth: frame.width, frameHeight: frame.height, names: this.names };
    const entries = selectHoverLayer(scored, this.hoverSelection);
    const boxIndexOfFace = faces.map((face) => valid.indexOf(face));
    const hoverCards = hoverEntriesToCards(entries, this.hoverIds.assign(entries), ctx, (i) => boxIndexOfFace[i]!);

    // The tracker pools the cosine looks, with or without the geometric stage: the stage may
    // change a face's answer, not what the tracks are built from.
    const tracked = scored.base ?? scored;
    const detections: Detection[] = tracked.kept.map((i) => {
      const p = tracked.proposals[i]!;
      return { aabb: p.aabb, rect: p.rect, cardId: p.topId, embedding: p.embedding!, ...(p.outline ? { outline: p.outline } : {}) };
    });
    const recognized = detections.length > 0;
    const tracks = this.trackLayer(detections, recognized, ctx);

    const analysis: FrameAnalysis = {
      frame: { width: frame.width, height: frame.height },
      boxes: this.boxResults(valid, faces, scored),
      hover: { selection: this.hoverSelection, cards: hoverCards },
      tracks,
      discontinuity,
      retried: scored.retried,
      embeddings: scored.embeddings,
      timings: {
        detectorMs,
        recognizeMs,
        analyzeMs: this.now() - tStart,
        ...(scored.geometricMs !== undefined ? { geometricMs: scored.geometricMs } : {}),
        ...(scored.tiltedMs !== undefined ? { tiltedMs: scored.tiltedMs } : {}),
      },
    };
    // A frame on which the stage or the retry failed is not reusable: its answers are the
    // fallback's, and the next frame is a real one.
    this.lastRun = this.geometricFailure === null && this.tiltedFailure === null ? { analysis, detections, recognized, ctx } : null;
    return analysis;
  }

  private boxResults(valid: readonly Candidate[], faces: readonly Candidate[], scored: ScoredFrame): BoxResult[] {
    const faceIndex = new Map<Candidate, number>(faces.map((c, i) => [c, i]));
    const kept = new Set(scored.kept);
    return valid.map((c) => {
      const i = faceIndex.get(c);
      let face: FaceResult | null = null;
      if (i !== undefined) {
        const p = scored.proposals[i]!;
        const shown = p.accepted && this.names.has(p.displayId) ? p.displayId : null;
        face = {
          topId: p.topId,
          topName: this.names.get(p.topId) ?? null,
          similarity: p.score,
          margin: p.margin,
          look: p.orientation,
          retried: p.retried,
          tauPassed: p.tauPassed,
          accepted: p.accepted,
          cardId: shown,
          name: shown === null ? null : (this.names.get(shown) ?? null),
          kept: kept.has(i),
          ...(p.unverified ? { unverified: true as const } : {}),
          ...(p.geometric ? { geometric: p.geometric } : {}),
          ...(p.tilted ? { tilted: p.tilted } : {}),
        };
      }
      return { box: boxOf(c.aabb), score: c.score, cls: c.cls, className: this.classNames[c.cls] ?? String(c.cls), face };
    });
  }
}
