// SPDX-License-Identifier: Apache-2.0
// Registering a layout onto video: when to trust the fit, frame after frame.
//
// layout-fit.ts fits one frame. This file turns a sequence of frame fits into a display
// verdict the product draws by:
//
//   fitted  draw the layout through `region`, leaving out the `suppressed` instances;
//   today   the product's behavior without registration;
//   vision  the layout is known to be wrong for this picture: draw the recognizer's own cards;
//   hidden  draw nothing (the picture shows no cards).
//
// A placement is *confirmed* by `confirmFits` compatible frame-verified fits in a row, each
// within `confirmWindowMs` of the one before. A confirmed placement is *held* for `holdMs`
// across analyses that do not confirm, and withdrawn when no analysis has arrived for
// `freshnessMs`. Evidence against it (an incompatible verified fit, two analyses in a row in
// which no two names agree on any placement, the membership monitor tripping) withdraws it at
// once and marks the generation *contradicted*: a contradicted generation shows `vision`, never
// `today`, until a new placement is confirmed.
//
// Every analysis carries a `generation` the product increments on a navigation, a new source or
// an eligibility change; a reply from any other generation is dropped unprocessed.
//
// The rows below are the precedence table; for each analysis the first matching row applies.
//
//   1  eligibility lost                                   -> off           today
//   2  generation reset                                   -> unverified    today
//   3  the monitor trips                                  -> mismatch      vision
//   4  in mismatch, the monitor recovers                  -> unverified    vision
//   5  a verified fit incompatible with the confirmed one -> contradicted  vision
//   6  a second analysis in a row with n >= 3 and no two
//      names agreeing, while verified or held             -> contradicted  vision
//   7  no card faces, a layout of 3+ cards, a fit has
//      been verified in this generation, not in mismatch  -> no-faces      hidden
//   8  an ambiguous fit                                   -> as 10 or 12, the run unchanged
//   9  a verified fit completes the run                   -> verified      fitted
//  10  otherwise, after verified, held or no-faces, while
//      the hold lasts                                     -> held          fitted
//  11  (a timer) the hold or the freshness ran out        -> unverified    today / vision
//  12  otherwise                                          -> unverified    today / vision
//   0  a timer with nothing to withdraw, or an analysis while off: no change
//
// While the monitor stays tripped, rows 11 and 12 lead to `mismatch` rather than `unverified`,
// so that row 4 can still end it; a `mismatch` page shown a frame without faces stays in
// `mismatch` (it draws nothing there either). When row 9 clears a trip, the monitor forgets the
// identities behind it. The hold runs only while a placement is confirmed: rows 3, 5, 6 and
// 11 stop it. An analysis that arrives after the hold or the freshness ran out, with no timer
// in between, first applies row 11; it reports 11 unless its own row changes something more
// (an ambiguous frame reports 11 there too, since it changes nothing).
// The clock the host passes must stop while the video is paused, so the hold and the
// freshness pause too.

import {
  compatible,
  correspondences,
  fitFrame,
  type FitParams,
  type FrameFitOutcome,
  iou,
  type Layout,
  LAYOUT_FIT_DEFAULTS,
  layoutExtent,
  type Observation,
  project,
  type Region,
  toRegion,
  type Transform,
} from "./layout-fit.js";
import { MismatchMonitor, MONITOR_DEFAULTS } from "./mismatch-monitor.js";

/** The product's tuned values. None has a default: a product cannot run on an unexamined one. */
export interface LayoutConfig {
  /** Fit: a correspondence supports a placement at this IoU or more (0.5 to 1). */
  fitMinIoU: number;
  /** Fit: the inliers spread over at least this share of the layout's extent per axis (0 to 1). */
  minSpan: number;
  /** Compatible frame-verified fits in a row that confirm a placement (1 to 3). */
  confirmFits: number;
  /** Two fits in a run are at most this far apart; at least 3 × `intervalMs`. */
  confirmWindowMs: number;
  /** A confirmed placement survives analyses that do not confirm for this long; at least
   *  `freshnessMs`. */
  holdMs: number;
  /** A fitted page is withdrawn when no analysis arrived for this long; at least 2 × `intervalMs`. */
  freshnessMs: number;
  /** The host's probe interval (see `AnalysisMode` "layout"). */
  intervalMs: number;
  /** Optional: a second, incompatible placement with this many supporters of its own makes a
   *  frame ambiguous (2 or 3; 2 when absent). */
  ambiguityMin?: number;
  /** Optional: with the aspect prior (a layout's `aspect` and an analysis's `frameAspect`), a
   *  placement whose sy / sx is off the layout's proportions by more than this share is set
   *  aside (above 0, at most 0.25; 0.03 when absent). */
  scaleRatioTol?: number;
  /** A layout card whose placed box overlaps a recognized card of another identity at this IoU
   *  or more is not drawn (0 to 1). */
  suppressionIoU: number;
}

const CONFIG_KEYS: ReadonlyArray<keyof LayoutConfig> = [
  "fitMinIoU",
  "minSpan",
  "confirmFits",
  "confirmWindowMs",
  "holdMs",
  "freshnessMs",
  "intervalMs",
  "suppressionIoU",
];

/** Why a configuration is refused, or null when it is valid. */
export function layoutConfigError(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return "the layout configuration must be an object";
  const c = config as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    if (typeof c[key] !== "number" || !Number.isFinite(c[key])) return `${key} must be a finite number`;
  }
  for (const key of Object.keys(c)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key) && key !== "ambiguityMin" && key !== "scaleRatioTol") {
      return `unknown layout configuration key: ${key}`;
    }
  }
  if (c.ambiguityMin !== undefined && (c.ambiguityMin !== 2 && c.ambiguityMin !== 3)) return "ambiguityMin must be 2 or 3";
  if (
    c.scaleRatioTol !== undefined &&
    !(typeof c.scaleRatioTol === "number" && Number.isFinite(c.scaleRatioTol) && c.scaleRatioTol > 0 && c.scaleRatioTol <= 0.25)
  ) {
    return "scaleRatioTol must be above 0 and at most 0.25";
  }
  const v = c as unknown as LayoutConfig;
  if (v.fitMinIoU < 0.5 || v.fitMinIoU > 1) return "fitMinIoU must be between 0.5 and 1";
  if (v.minSpan < 0 || v.minSpan > 1) return "minSpan must be between 0 and 1";
  if (!Number.isInteger(v.confirmFits) || v.confirmFits < 1 || v.confirmFits > 3) {
    return "confirmFits must be 1, 2 or 3";
  }
  if (v.suppressionIoU <= 0 || v.suppressionIoU > 1) return "suppressionIoU must be above 0 and at most 1";
  if (v.intervalMs <= 0) return "intervalMs must be positive";
  if (v.confirmWindowMs < 3 * v.intervalMs) return "confirmWindowMs must be at least 3 × intervalMs";
  if (v.freshnessMs < 2 * v.intervalMs) return "freshnessMs must be at least 2 × intervalMs";
  if (v.holdMs < v.freshnessMs) return "holdMs must be at least freshnessMs";
  return null;
}

export interface FrameInput {
  /** The product's generation for this analysis; a different one than the current is dropped. */
  generation: number;
  /** When the analyzed picture was captured, on the host clock that stops while paused. */
  capturedAtMs: number;
  /** Card faces the detector found in the picture, named or not. */
  faces: number;
  /** The recognizer's accepted cards, frame units. */
  observations: Observation[];
  /** The candidate layout in force at `capturedAtMs`; null when there is none. */
  layout: Layout | null;
  /** The analyzed picture's width / height in pixels. With the layout's `aspect`, it turns on
   *  the aspect prior; absent, a placement scales each axis freely. */
  frameAspect?: number;
  /** Identities the product's source offers around this instant (the monitor; empty: not
   *  counted). */
  windowIdentities: ReadonlySet<string>;
}

/** Where a layout comes from. A product implements it over its own feed; the recording reader
 *  (layout-recording.ts) implements it over a recording. */
export interface LayoutSource {
  /** The candidate layout in force for a picture captured at `capturedAtMs`; null for none. */
  layoutAt(capturedAtMs: number): Layout | null;
  /** The identities the source offers around that instant. */
  windowIdentitiesAt(capturedAtMs: number): ReadonlySet<string>;
}

export type State = "off" | "unverified" | "verified" | "held" | "contradicted" | "mismatch" | "no-faces";
export type Display = "fitted" | "today" | "vision" | "hidden";

/** Which row of the precedence table produced a verdict; 0: a timer with nothing to withdraw. */
export type Row = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface Verdict {
  display: Display;
  /** Present exactly when `display` is "fitted". */
  region?: Region;
  /** Layout instances not to draw; empty unless fitted. */
  suppressed: string[];
  state: State;
  /** Evidence went against the layout in this generation, and no placement was confirmed since. */
  contradicted: boolean;
  /** The last analysis's fit ("no-layout" before the first). */
  frame: FrameFitOutcome;
  diagnostics: {
    /** Time since the last analysis arrived (0 before the first). */
    elapsedSinceLastAnalysisMs: number;
    runLength: number;
    monitorShare: number | null;
    row: Row;
  };
}

/**
 * The layout instances not to draw through a placement: (a) a correspondence the placement does
 * not put on its recognized card (the recognizer saw that card somewhere else), and (b) a card
 * whose placed box overlaps a recognized card of another identity at `suppressionIoU` or more.
 * In layout order.
 */
export function suppressedInstances(
  layout: Layout,
  observations: readonly Observation[],
  t: Transform,
  fitMinIoU: number,
  suppressionIoU: number,
  maxCorrespondences: number = LAYOUT_FIT_DEFAULTS.maxCorrespondences,
): string[] {
  const out = new Set<string>();
  for (const c of correspondences(observations, layout, maxCorrespondences)) {
    if (iou(project(t, c.r), c.v) < fitMinIoU) out.add(c.instance);
  }
  for (const card of layout.cards) {
    const placed = project(t, card.bounds);
    for (const o of observations) {
      if (o.identity !== card.identity && iou(placed, o.bounds) >= suppressionIoU) {
        out.add(card.instance);
        break;
      }
    }
  }
  return layout.cards.map((c) => c.instance).filter((id) => out.has(id));
}

interface Run {
  latest: Transform;
  capturedAtMs: number;
  length: number;
}

export class LayoutRegistration {
  readonly config: Readonly<LayoutConfig>;
  private readonly fitParams: FitParams;
  private readonly monitor: MismatchMonitor;

  private generationValue: number | null = null;
  private stateValue: State = "off";
  private contradicted = false;
  private verifiedThisGen = false;
  private run: Run | null = null;
  private confirmed: Transform | null = null;
  private holdStart: number | null = null;
  private lastAnalysisAt: number | null = null;
  private zeroStreak = 0;
  private lastFrame: FrameFitOutcome = { kind: "no-layout" };
  private suppressed: string[] = [];
  private current: Verdict;

  /**
   * @param config The product's tuned values; checked here (a bad one throws).
   * @param options.exclude Identities the monitor leaves out (card types every layout shares).
   */
  constructor(config: LayoutConfig, options: { exclude?: (identity: string) => boolean } = {}) {
    const error = layoutConfigError(config);
    if (error) throw new Error(error);
    this.config = Object.freeze({ ...config });
    this.fitParams = {
      ...LAYOUT_FIT_DEFAULTS,
      fitMinIoU: config.fitMinIoU,
      minSpan: config.minSpan,
      ambiguityMin: config.ambiguityMin ?? LAYOUT_FIT_DEFAULTS.ambiguityMin,
      scaleRatioTol: config.scaleRatioTol ?? LAYOUT_FIT_DEFAULTS.scaleRatioTol,
    };
    this.monitor = new MismatchMonitor({ exclude: options.exclude, params: MONITOR_DEFAULTS });
    this.current = this.build(0, 0);
  }

  /** The current generation; null while off. */
  get generation(): number | null {
    return this.generationValue;
  }

  get state(): State {
    return this.stateValue;
  }

  /** The verdict after the last event. */
  get verdict(): Verdict {
    return this.current;
  }

  /** Row 1: the product's mode is no longer eligible. Everything is cleared and every reply
   *  dropped until `reset`. */
  eligibilityLost(nowMs: number): Verdict {
    this.clear();
    this.generationValue = null;
    this.stateValue = "off";
    return (this.current = this.build(1, nowMs));
  }

  /** Row 2: a new generation (a navigation, a new source, eligibility regained). */
  reset(generation: number, nowMs: number): Verdict {
    this.clear();
    this.generationValue = generation;
    this.stateValue = "unverified";
    return (this.current = this.build(2, nowMs));
  }

  /** A timer event: withdraw a placement whose hold or freshness ran out (row 11). */
  tick(nowMs: number): Verdict {
    if (this.expired(nowMs)) {
      this.expire();
      return (this.current = this.build(11, nowMs));
    }
    return (this.current = this.build(0, nowMs));
  }

  /** An analysis arrived. Null when it belongs to another generation (dropped unprocessed). */
  analyze(input: FrameInput, nowMs: number): Verdict | null {
    if (this.generationValue === null || input.generation !== this.generationValue) return null;
    const expiredFirst = this.expired(nowMs);
    if (expiredFirst) this.expire();

    const prev = this.stateValue;
    const fit = fitFrame(input.observations, input.layout, this.fitParams, input.frameAspect);
    this.lastFrame = fit;
    const step = this.monitor.observe({
      windowIdentities: input.windowIdentities,
      accepted: input.observations.map((o) => o.identity),
    });
    this.lastAnalysisAt = nowMs;
    this.zeroStreak = fit.kind === "insufficient" && fit.reason === "zero-inliers" ? this.zeroStreak + 1 : 0;

    const extent = input.layout ? layoutExtent(input.layout) : null;
    const verified = fit.kind === "verified" && extent !== null ? fit : null;
    const tol = this.fitParams.compatTol;
    const incompatible =
      verified !== null && this.confirmed !== null && !compatible(verified.transform, this.confirmed, extent!, tol);
    // The run this fit would make, unless row 5 starts a new one.
    let nextRun = this.run;
    if (verified) {
      const extends_ =
        this.run !== null &&
        compatible(verified.transform, this.run.latest, extent!, tol) &&
        input.capturedAtMs - this.run.capturedAtMs <= this.config.confirmWindowMs;
      nextRun = {
        latest: verified.transform,
        capturedAtMs: input.capturedAtMs,
        length: extends_ ? this.run!.length + 1 : 1,
      };
    }

    let row: Row;
    if (step.event === "trip") {
      row = 3;
      this.run = nextRun;
      this.stateValue = "mismatch";
      this.confirmed = null;
      this.holdStart = null;
      this.contradicted = true;
    } else if (prev === "mismatch" && step.event === "recover") {
      row = 4;
      this.run = nextRun;
      this.stateValue = "unverified";
    } else if (incompatible) {
      row = 5;
      this.run = { latest: verified!.transform, capturedAtMs: input.capturedAtMs, length: 1 };
      this.stateValue = "contradicted";
      this.confirmed = null;
      this.holdStart = null;
      this.contradicted = true;
      this.verifiedThisGen = true;
    } else if (this.zeroStreak >= 2 && (prev === "verified" || prev === "held")) {
      row = 6;
      this.stateValue = "contradicted";
      this.confirmed = null;
      this.holdStart = null;
      this.contradicted = true;
      this.verifiedThisGen = true;
    } else if (
      input.faces === 0 &&
      input.layout !== null &&
      input.layout.cards.length >= 3 &&
      this.verifiedThisGen &&
      prev !== "mismatch"
    ) {
      row = 7;
      this.run = nextRun;
      this.stateValue = "no-faces";
    } else if (verified && nextRun!.length >= this.config.confirmFits) {
      row = 9;
      this.run = nextRun;
      this.stateValue = "verified";
      this.confirmed = verified.transform;
      this.contradicted = false;
      this.holdStart = nowMs;
      this.verifiedThisGen = true;
      this.monitor.clearTrip();
    } else {
      this.run = nextRun;
      const holding =
        (prev === "verified" || prev === "held" || prev === "no-faces") &&
        this.confirmed !== null &&
        this.holdStart !== null &&
        nowMs - this.holdStart < this.config.holdMs;
      if (holding) {
        row = 10;
        this.stateValue = "held";
        this.verifiedThisGen = true;
      } else {
        row = expiredFirst ? 11 : 12;
        this.stateValue = this.monitor.tripped ? "mismatch" : "unverified";
      }
      if (fit.kind === "ambiguous" && row !== 11) row = 8;
    }

    if ((this.stateValue === "verified" || this.stateValue === "held") && this.confirmed && input.layout) {
      this.suppressed = suppressedInstances(
        input.layout,
        input.observations,
        this.confirmed,
        this.fitParams.fitMinIoU,
        this.config.suppressionIoU,
        this.fitParams.maxCorrespondences,
      );
    } else {
      this.suppressed = [];
    }
    return (this.current = this.build(row, nowMs));
  }

  /** Row 11's condition: a page showing a placement (or hiding the picture) whose hold or
   *  freshness ran out. */
  private expired(nowMs: number): boolean {
    const s = this.stateValue;
    if (s !== "verified" && s !== "held" && s !== "no-faces") return false;
    const holdOut = this.holdStart !== null && nowMs - this.holdStart >= this.config.holdMs;
    const stale = this.lastAnalysisAt !== null && nowMs - this.lastAnalysisAt >= this.config.freshnessMs;
    return holdOut || stale;
  }

  private expire(): void {
    this.stateValue = this.monitor.tripped ? "mismatch" : "unverified";
    this.confirmed = null;
    this.holdStart = null;
    this.suppressed = [];
  }

  private clear(): void {
    this.contradicted = false;
    this.verifiedThisGen = false;
    this.run = null;
    this.confirmed = null;
    this.holdStart = null;
    this.lastAnalysisAt = null;
    this.zeroStreak = 0;
    this.lastFrame = { kind: "no-layout" };
    this.suppressed = [];
    this.monitor.reset();
  }

  private display(): Display {
    switch (this.stateValue) {
      case "off":
        return "today";
      case "verified":
      case "held":
        return "fitted";
      case "no-faces":
        return "hidden";
      case "mismatch":
      case "contradicted":
        return "vision";
      case "unverified":
        return this.contradicted ? "vision" : "today";
    }
  }

  private build(row: Row, nowMs: number): Verdict {
    const display = this.display();
    const out: Verdict = {
      display,
      suppressed: display === "fitted" ? [...this.suppressed] : [],
      state: this.stateValue,
      contradicted: this.contradicted,
      frame: this.lastFrame,
      diagnostics: {
        elapsedSinceLastAnalysisMs: this.lastAnalysisAt === null ? 0 : nowMs - this.lastAnalysisAt,
        runLength: this.run?.length ?? 0,
        monitorShare: this.monitor.share,
        row,
      },
    };
    if (display === "fitted") out.region = toRegion(this.confirmed!);
    return out;
  }
}
