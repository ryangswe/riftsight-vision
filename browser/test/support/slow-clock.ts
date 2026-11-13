// SPDX-License-Identifier: Apache-2.0
// A slow-clock harness for the browser runtime's look scheduling.
//
// It drives the real `SessionCore` (and through it the real `FrameScheduler` and `MeasuredPacer`)
// on a virtual clock. Only three things are stand-ins: the clock, the picture capture and the
// worker. The worker takes a configured time per look, the capture a configured delay, and the
// video plays at a configured rate. Nothing here reads a real clock or the network, so a run is
// a pure function of its configuration and scenario.
//
// It is a model of the scheduling policy, not a measurement of a browser: the times a real
// computer takes are inputs here, not outputs.
//
// Candidate rules (internal, for the comparison table only; the product has no option for them).
// The rules apply to the looks a viewer is waiting on: the stale-picture look a pointer move asks
// for (`FrameScheduler.hoverTriggerDue`) and the focus re-look of a playing picture
// (`FrameScheduler.relookDue`). They are installed on the scheduler instance of a run, so
// `browser/src` is unchanged and "current" is the code untouched. The code now runs the budgeted
// rule, so "current" and "budgeted" give the same runs (a test checks it); the other rules are kept
// for comparison. Notation: F is the fixed
// fast cadence of the backend (`activeAnalyzeIntervalMs`: 500 ms WebGPU, 1000 ms WebAssembly); A is
// the release's max age (2000 ms); P is the paced interval (`pacedIntervalMs` over the worker
// times when measured pacing is on: max(F, min(4000, median of the last 5 worker times / share)),
// and F while fewer than 3 times are known or pacing is off); R is the median of the last 5 round
// trips (capture asked for to reply, ms); M is the margin, one driver tick (250 ms).
//
//   current:  the code as it is: the budgeted rule below (session-core.ts `staleBudgetMs`, the
//             re-look at F). Nothing is replaced. (Before the budgeted rule the code had stale
//             threshold = max(400, cadence in effect) and re-look spacing = max(250, 4 x median
//             worker time, up to 4000).)
//   strict:   stale threshold = max(400, F); re-look spacing = F.
//   budgeted: B = max(F, min(P, L - R - M)) with L = A / playback rate, the answer's lifetime in
//             wall ms; stale threshold = max(400, B); re-look spacing = F (as strict).
//             Warm-up (no round trip yet): B = F. A negative L - R - M gives B = F. A floor F
//             above the ceiling P gives B = F (the floor wins, as in `pacedIntervalMs`). With
//             pacing off, P = F, so B = F. Limitation: the threshold is compared with video age
//             (as the code compares the cadence today), while B is in wall ms.
//   budgeted+relook: as budgeted, and the re-look spacing is also B.
//
// Every rule runs on the code's own entry looks (first load, re-entry, idle reload), reading wait
// (with the shown hold's deadline), empty-spot rest and retries, and keeps every other limit: one
// look in flight, at least 250 ms between looks a pointer asks for, the back-off of an unanswered
// look on every path, and the paced cadence of looks nobody is waiting on (the empty-spot rest,
// reading looks, always-on mode).
//
// The host gives the core the video's playback rate (`SessionCoreDeps.playbackRate`), as
// `createSession` does; an extension's compute frame measures it from the times it is sent.

import { activeAnalyzeIntervalMs, MEASURED_PACING_ACTIVE_CEILING_MS, MEASURED_PACING_MIN_SAMPLES, MEASURED_PACING_SHARE, MEASURED_PACING_WINDOW } from "../../src/cadence.js";
import { DRIVER_TICK_MS, HOVER_MAX_AGE_MS, STALE_FRAME_MS } from "../../src/frame-scheduler.js";
import { ANALYSIS_FAILED, type FrameResult, type ReleaseStatus, type WorkerRequest } from "../../src/messages.js";
import type { FrameAnalysis } from "../../src/pipeline.js";
import { focusGroup } from "../../src/recognition.js";
import { READING_HOLD, SessionCore, type SessionCoreOptions, type Shown, SHOWN_HOLD } from "../../src/session-core.js";

export type Rule = "current" | "strict" | "budgeted" | "budgeted+relook";
export type HoldMode = "none" | "shown" | "reading";
export type Backend = "webgpu" | "wasm";

export const RULES: readonly Rule[] = ["current", "strict", "budgeted", "budgeted+relook"];

/** One run's configuration. */
export interface SlowClockConfig {
  rule: Rule;
  backend: Backend;
  /** The worker's analysis time per look, in ms: a number, or a sequence used in turn (and
   *  repeated). A reused-detections reply (`reuseOf`) takes `REUSE_MS`. */
  workerMs: number | readonly number[];
  /** Time to get the picture after a look is asked for, in ms. */
  captureDelayMs: number;
  /** Video seconds per wall second while playing. */
  playbackRate: number;
  hold: HoldMode;
  measuredPacing: boolean;
  /** The geometric stage is on, with focus scope: a look verifies only the pointer's group. */
  focus: boolean;
}

export const DEFAULT_CONFIG: Readonly<SlowClockConfig> = Object.freeze({
  rule: "current", backend: "webgpu", workerMs: 500, captureDelayMs: 0, playbackRate: 1, hold: "shown", measuredPacing: true, focus: false,
});

/** The time a reply that feeds the previous detections to the tracker takes. */
export const REUSE_MS = 5;
/** The release's max age, in ms of video time. */
export const MAX_AGE_MS = HOVER_MAX_AGE_MS;
/** The virtual step, in ms. Every time in a scenario is a multiple of it. */
export const STEP_MS = 5;
const FRAME_EVERY_MS = 20;
const W = 1000;
const H = 500;
/** The stale and re-look margin of the budgeted rule. */
const MARGIN_MS = DRIVER_TICK_MS;

// ------------------------------------------------------------------ the world

export interface CardSpec {
  id: string;
  /** In pixels of the 1000 x 500 picture. Later cards are on top. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Three separate cards. */
export const ABC: readonly CardSpec[] = [
  { id: "A", x: 100, y: 100, w: 200, h: 300 },
  { id: "C", x: 350, y: 100, w: 200, h: 300 },
  { id: "B", x: 600, y: 100, w: 200, h: 300 },
];
/** A fan of five cards, each partly under the next. */
export const FAN: readonly CardSpec[] = [1, 2, 3, 4, 5].map((i) => ({ id: `F${i}`, x: 100 + 120 * (i - 1), y: 100, w: 150, h: 300 }));

export type ScenarioEvent =
  | { at: number; kind: "move"; px: number; py: number }
  | { at: number; kind: "leave" }
  | { at: number; kind: "pause" }
  | { at: number; kind: "resume" }
  | { at: number; kind: "seek"; bySec: number }
  /** The picture changes under the pointer without a seek; the host reports a cut when a card shows,
   *  unless `cut` is false (an extension's content script detects no cuts). */
  | { at: number; kind: "layout"; cards: readonly CardSpec[]; cut?: boolean }
  /** The worker is ended on purpose (idle unload). */
  | { at: number; kind: "unload" }
  /** The release is installed (the session becomes ready). */
  | { at: number; kind: "load" };

export interface Scenario {
  name: string;
  summary: string;
  durationMs: number;
  layout: readonly CardSpec[];
  /** False: the session loads at the first `load` event, not before the run. */
  startReady: boolean;
  events: readonly ScenarioEvent[];
  /** 1-based numbers of the looks whose analysis fails (retryable), in order of asking. */
  failLooks?: readonly number[];
  /** The video presents a frame this often, in ms (default 20, about 50 frames a second). A slow
   *  source presents rarely; a newly presented frame makes a cadence look due. */
  frameEveryMs?: number;
}

const topAt = (cards: readonly CardSpec[], px: number, py: number): CardSpec | null => {
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i]!;
    if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) return c;
  }
  return null;
};

// ------------------------------------------------------------------ results

export interface Gap {
  card: string;
  startMs: number;
  endMs: number;
  lengthMs: number;
  /** A schedule exists that keeps the card fresh at this look time: 2W <= lifetime of an answer. */
  avoidable: boolean;
}

export interface Look {
  at: number;
  trigger: string | null;
}

export interface Metrics {
  /** Residences of the pointer on a card, and how many were named at all. */
  residences: number;
  /** Visits with a dwell of at least one capture + analysis (the only ones that can be named). */
  eligible: number;
  /** Eligible visits never named. */
  unnamed: number;
  latencyAvgMs: number | null;
  latencyMaxMs: number | null;
  /** Time-weighted mean and max age (video ms) of the answer on screen while the pointer is on a card it names correctly. */
  ageAvgMs: number | null;
  ageMaxMs: number | null;
  /** The time on screen that mean is over, and the integral of the age over it (for pooling runs). */
  shownMs: number;
  ageIntegralMs: number;
  gapTotalMs: number;
  gapMaxMs: number;
  gapAvoidableMs: number;
  gapUnavoidableMs: number;
  looks: number;
  looksPerMinute: number;
  busyShare: number;
}

export interface RunResult {
  scenario: string;
  config: SlowClockConfig;
  metrics: Metrics;
  gaps: Gap[];
  looks: Look[];
  /** Every analysis the stand-in worker ran: when it started and how long it took. */
  busy: Array<{ at: number; ms: number }>;
  /** Per residence: the card, its arrival, and the latency to the first correct name (null: never). */
  residences: Array<{ card: string; startMs: number; dwellMs: number; latencyMs: number | null }>;
  /** Every change of the card displayed: when, and its id (null: nothing). */
  shown: Array<{ at: number; cardId: string | null }>;
}

// ------------------------------------------------------------------ the run

const median = (values: readonly number[]): number => {
  const sorted = values.slice(-MEASURED_PACING_WINDOW).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const release = (backend: Backend): NonNullable<ReleaseStatus["release"]> =>
  ({
    id: "slow-clock", game: "toy-game", locale: "en",
    detector: { version: "d", ep: backend }, recognizer: { version: "r", ep: backend },
    bankCards: 8, catalogCards: 8, identityLevel: "printing",
    decode: { threshold: 0.3, nmsIou: 0.45, maxProposals: 80, minCropPx: 24 },
    accept: { tau: 0.62, delta: 0.05 }, hoverSelection: "accepted-nms", hoverMaxAgeMs: MAX_AGE_MS,
    analysisWidth: { min: 720, max: 1920 }, ortWeb: "1.29.0",
  }) as unknown as NonNullable<ReleaseStatus["release"]>;

interface BoxRecord {
  box: [number, number, number, number];
  face: { cardId: string | null; unverified?: true } | null;
  cardId: string | null;
}

/** The stand-in for `hoverAt`: the top box under the point, named when it was verified. */
const hit = (analysis: { boxes: BoxRecord[] }, x: number, y: number) => {
  for (let i = analysis.boxes.length - 1; i >= 0; i--) {
    const b = analysis.boxes[i]!;
    if (x < b.box[0] || x > b.box[0] + b.box[2] || y < b.box[1] || y > b.box[1] + b.box[3]) continue;
    const cardId = b.face ? b.face.cardId : b.cardId;
    const box = cardId ? { x: b.box[0], y: b.box[1], width: b.box[2], height: b.box[3] } : null;
    return { card: null, boxIndex: i, box, cardId, name: cardId };
  }
  return { card: null, boxIndex: null, box: null, cardId: null, name: null };
};

/** The key a run is stepped by: queued work at a virtual time, in order of asking. */
interface Queued {
  at: number;
  seq: number;
  run: () => void;
}

export function runScenario(scenario: Scenario, partial: Partial<SlowClockConfig> = {}): RunResult {
  const cfg: SlowClockConfig = { ...DEFAULT_CONFIG, ...partial };
  const workerTimes = typeof cfg.workerMs === "number" ? [cfg.workerMs] : [...cfg.workerMs];
  if (workerTimes.length === 0) throw new RangeError("workerMs needs a time");
  const fastCadence = activeAnalyzeIntervalMs(cfg.backend);

  let clock = 0;
  let mediaSec = 600;
  let playing = true;
  let layout = scenario.layout;
  let pointerPx = null as { x: number; y: number } | null;
  let seq = 0;
  const queue: Queued[] = [];
  const schedule = (at: number, run: () => void): void => {
    queue.push({ at, seq: seq++, run });
  };

  const looks: Look[] = [];
  const analyses = new Map<number, FrameAnalysis>();
  let analysisCount = 0;
  let busyMs = 0;
  let displayed: Shown | null = null;
  const roundTrips: number[] = [];
  const workerSamples: number[] = [];
  /** Wall time at which a reply was delivered and the time it spent in the loop (capture + worker). */
  const answers: Array<{ at: number; cycleMs: number }> = [];
  /** The video time of the newest result that named each card: the age of the name on screen. */
  const namedAtSec = new Map<string, number>();
  const busy: Array<{ at: number; ms: number }> = [];
  const shownLog: Array<{ at: number; cardId: string | null }> = [];
  let ageIntegral = 0;
  let shownMs = 0;
  let ageMax = 0;

  const hold = cfg.hold === "shown" ? SHOWN_HOLD : cfg.hold === "reading" ? READING_HOLD : undefined;
  const options: SessionCoreOptions = {
    mode: "pointer",
    entryLook: true,
    ...(hold ? { hold } : {}),
    ...(cfg.measuredPacing ? { measuredPacing: true } : {}),
    ...(cfg.focus ? { geometric: true, geometricScope: "focus" as const } : {}),
  };

  // eslint-disable-next-line prefer-const
  let core: SessionCore;
  const bitmap = { width: W, height: H, close() {} } as unknown as ImageBitmap;

  const buildAnalysis = (request: Extract<WorkerRequest, { kind: "frame" }>): FrameAnalysis => {
    const verifiedAll = !(cfg.focus && request.geometricScope === "focus" && request.focus);
    const boxes: BoxRecord[] = layout.map((c) => ({ box: [c.x, c.y, c.w, c.h], face: null, cardId: c.id }));
    if (cfg.focus) {
      const group = verifiedAll ? null : focusGroup(boxes.map((b) => ({ x: b.box[0], y: b.box[1], width: b.box[2], height: b.box[3] })), request.focus!);
      boxes.forEach((b, i) => {
        b.face = group === null || group.has(i) ? { cardId: b.cardId } : { cardId: null, unverified: true };
      });
    }
    const named = boxes.filter((b) => (b.face ? b.face.cardId : b.cardId) !== null);
    const cards = named.map((b) => ({ cardId: b.face ? b.face.cardId : b.cardId, bounds: { x: b.box[0] / W, y: b.box[1] / H, width: b.box[2] / W, height: b.box[3] / H } }));
    return { frame: { width: W, height: H }, hover: { selection: "accepted-nms", cards }, boxes } as unknown as FrameAnalysis;
  };

  const toWorker = (request: WorkerRequest): void => {
    if (request.kind !== "frame") return;
    const requestId = request.envelope.requestId;
    const failing = (scenario.failLooks ?? []).includes(requestId);
    const previous = request.reuseOf !== undefined ? analyses.get(request.reuseOf) : undefined;
    const reused = previous !== undefined && !failing;
    const workerMs = failing ? workerTimes[analysisCount++ % workerTimes.length]! : reused ? REUSE_MS : workerTimes[analysisCount++ % workerTimes.length]!;
    busyMs += Math.min(workerMs, scenario.durationMs - clock);
    busy.push({ at: clock, ms: workerMs });
    const analysis = failing ? null : reused ? ({ ...previous, reused: true } as FrameAnalysis) : buildAnalysis(request);
    if (analysis && !reused) analyses.set(requestId, analysis);
    const sentAt = clock;
    const reply: FrameResult = {
      kind: "frame-result", envelope: request.envelope, videoTimeSec: request.videoTimeSec, width: W, height: H, workerMs,
      analysis, ...(failing ? { error: `${ANALYSIS_FAILED}: stand-in` } : {}),
    };
    schedule(clock + workerMs, () => {
      core.fromWorker(reply);
      if (analysis) for (const c of (analysis as unknown as { hover: { cards: Array<{ cardId: string | null }> } }).hover.cards) if (c.cardId) namedAtSec.set(c.cardId, reply.videoTimeSec);
      if (analysis && !reused) {
        workerSamples.push(workerMs);
        roundTrips.push(core.status().lastRoundTripMs ?? workerMs);
        answers.push({ at: clock, cycleMs: clock - (sentAt - cfg.captureDelayMs) });
      }
    });
  };

  core = new SessionCore(
    {
      now: () => clock,
      mediaTimeNow: () => mediaSec,
      toWorker,
      capture: (requestId) => {
        looks.push({ at: clock, trigger: core.scheduler.lastTrigger });
        schedule(clock + cfg.captureDelayMs, () => core.frame(requestId, bitmap, mediaSec));
      },
      onShown: (card) => {
        displayed = card;
        if ((shownLog.at(-1)?.cardId ?? null) !== (card?.cardId ?? null)) shownLog.push({ at: clock, cardId: card?.cardId ?? null });
      },
      // The host reads its video's rate, as `createSession` does (an extension's compute frame
      // measures it from the times it is sent instead).
      playbackRate: () => cfg.playbackRate,
      hoverAt: hit as never,
    },
    options,
  );

  installRule(core, cfg.rule, {
    lifetimeMs: MAX_AGE_MS / cfg.playbackRate,
    fastCadence,
    pacedMs: () => (cfg.measuredPacing && workerSamples.length >= MEASURED_PACING_MIN_SAMPLES ? Math.max(fastCadence, Math.min(MEASURED_PACING_ACTIVE_CEILING_MS, median(workerSamples) / MEASURED_PACING_SHARE)) : fastCadence),
    roundTripMs: () => (roundTrips.length === 0 ? null : median(roundTrips)),
  });

  const install = (): void => {
    core.fromWorker({ kind: "release-status", ok: true, error: null, release: release(cfg.backend), cards: [] });
    if (cfg.focus) core.fromWorker({ kind: "geometric-status", state: "ready", reason: null, bytes: 10 });
  };
  if (scenario.startReady) install();

  for (const e of scenario.events) {
    schedule(e.at, () => {
      switch (e.kind) {
        case "move":
          pointerPx = { x: e.px, y: e.py };
          core.pointer(e.px / W, e.py / H, mediaSec);
          return;
        case "leave":
          pointerPx = null;
          core.pointerLeft();
          return;
        case "pause":
          playing = false;
          return;
        case "resume":
          playing = true;
          return;
        case "seek":
          mediaSec += e.bySec;
          core.discontinuity(false);
          core.presented(mediaSec);
          return;
        case "layout":
          layout = e.cards;
          if (displayed && e.cut !== false) core.cut();
          return;
        case "unload":
          core.workerStopped({ idle: true });
          return;
        case "load":
          install();
          return;
      }
    });
  }

  // Metrics state.
  interface Residence { card: string; startMs: number; firstNamedAt: number | null; gapStart: number | null; wasCorrect: boolean }
  let res: Residence | null = null;
  const gaps: Gap[] = [];
  const residences: RunResult["residences"] = [];
  // A hold keeps what is displayed beyond the answer's own life: the lifetime a gap is judged against.
  const holdMs = cfg.hold === "shown" ? SHOWN_HOLD.maxMs : cfg.hold === "reading" ? Infinity : 0;
  // The hold's limit is wall time (`SHOWN_HOLD.maxMs`); the answer's own life is video time.
  const answerLifeMs = MAX_AGE_MS / cfg.playbackRate;
  const lifetimeMs = answerLifeMs + holdMs;
  const cycleNear = (t: number): number => {
    // The look time around a gap: the latest answer before it and the first after, whichever is longer.
    let before = 0;
    let after = 0;
    for (const a of answers) {
      if (a.at <= t) before = a.cycleMs;
      else {
        after = a.cycleMs;
        break;
      }
    }
    return Math.max(before, after);
  };
  const closeGap = (r: Residence, end: number): void => {
    if (r.gapStart === null) return;
    gaps.push({ card: r.card, startMs: r.gapStart, endMs: end, lengthMs: end - r.gapStart, avoidable: 2 * cycleNear(r.gapStart) <= lifetimeMs && cycleNear(r.gapStart) <= answerLifeMs });
    r.gapStart = null;
  };
  const closeResidence = (end: number): void => {
    if (!res) return;
    closeGap(res, end);
    residences.push({ card: res.card, startMs: res.startMs, dwellMs: end - res.startMs, latencyMs: res.firstNamedAt === null ? null : res.firstNamedAt - res.startMs });
    res = null;
  };

  const drain = (): void => {
    for (;;) {
      let best = -1;
      for (let i = 0; i < queue.length; i++) {
        const q = queue[i]!;
        if (q.at <= clock && (best < 0 || q.at < queue[best]!.at || (q.at === queue[best]!.at && q.seq < queue[best]!.seq))) best = i;
      }
      if (best < 0) return;
      queue.splice(best, 1)[0]!.run();
    }
  };

  for (clock = 0; clock <= scenario.durationMs; clock += STEP_MS) {
    if (clock > 0 && playing) mediaSec += (STEP_MS * cfg.playbackRate) / 1000;
    drain();
    if (playing && clock > 0 && clock % (scenario.frameEveryMs ?? FRAME_EVERY_MS) === 0) core.presented(mediaSec);
    if (clock % DRIVER_TICK_MS === 0) core.tick();
    drain();

    const truth = pointerPx ? topAt(layout, pointerPx.x, pointerPx.y) : null;
    const truthId = truth ? truth.id : null;
    const cur = res as Residence | null;
    if ((cur ? cur.card : null) !== truthId) {
      closeResidence(clock);
      if (truthId !== null) res = { card: truthId, startMs: clock, firstNamedAt: null, gapStart: null, wasCorrect: false };
    }
    const now = res as Residence | null;
    if (now) {
      const shown = displayed as Shown | null;
      const correct = shown !== null && shown.cardId === now.card;
      if (correct) {
        const age = (mediaSec - (namedAtSec.get(now.card) ?? mediaSec)) * 1000;
        ageIntegral += age * STEP_MS;
        shownMs += STEP_MS;
        ageMax = Math.max(ageMax, age);
      }
      if (now.firstNamedAt === null) {
        if (correct) now.firstNamedAt = clock;
      } else if (!correct) {
        now.gapStart ??= clock;
      } else {
        closeGap(now, clock);
      }
      now.wasCorrect = correct;
    }
  }
  closeResidence(scenario.durationMs);

  // Only visits long enough to be named count; one never named is censored at its dwell.
  const typicalCycleMs = median(workerTimes) + cfg.captureDelayMs;
  const eligible = residences.filter((r) => r.dwellMs >= typicalCycleMs);
  const named = eligible.map((r) => r.latencyMs ?? r.dwellMs);
  const sum = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0);
  const gapTotal = sum(gaps.map((g) => g.lengthMs));
  const metrics: Metrics = {
    residences: residences.length,
    eligible: eligible.length,
    unnamed: eligible.filter((r) => r.latencyMs === null).length,
    latencyAvgMs: named.length ? sum(named) / named.length : null,
    latencyMaxMs: named.length ? Math.max(...named) : null,
    ageAvgMs: shownMs ? ageIntegral / shownMs : null,
    ageMaxMs: shownMs ? ageMax : null,
    shownMs,
    ageIntegralMs: ageIntegral,
    gapTotalMs: gapTotal,
    gapMaxMs: gaps.length ? Math.max(...gaps.map((g) => g.lengthMs)) : 0,
    gapAvoidableMs: sum(gaps.filter((g) => g.avoidable).map((g) => g.lengthMs)),
    gapUnavoidableMs: sum(gaps.filter((g) => !g.avoidable).map((g) => g.lengthMs)),
    looks: looks.length,
    looksPerMinute: (looks.length * 60_000) / scenario.durationMs,
    busyShare: busyMs / scenario.durationMs,
  };
  return { scenario: scenario.name, config: cfg, metrics, gaps, looks, busy, residences, shown: shownLog };
}

// ------------------------------------------------------------------ the candidate rules

export interface RuleInputs {
  fastCadence: number;
  /** The answer's lifetime in wall ms: the max age over the playback rate. */
  lifetimeMs: number;
  /** P: the paced interval for a pointer-waiting look. */
  pacedMs(): number;
  /** R: the median recent round trip, or null before one is known. */
  roundTripMs(): number | null;
}

/** The "budgeted" rule's B: max(F, min(P, L - R - M)), and F while no round trip is known
 *  (`roundTripMs` null). F is the fixed fast cadence, P the paced interval, R the median round
 *  trip, L the answer's lifetime in wall ms (the max age over the playback rate) and M the margin
 *  (one driver tick). A negative L - R - M gives F; so does
 *  an F above P, since the floor is applied last. */
export function budgetedSpacingMs(fastCadence: number, pacedMs: number, roundTripMs: number | null, maxAgeMs: number = MAX_AGE_MS): number {
  if (roundTripMs === null) return fastCadence;
  return Math.max(fastCadence, Math.min(pacedMs, maxAgeMs - roundTripMs - MARGIN_MS));
}

/** What a rule makes of the two spacings, in ms: the stale-picture threshold (before the 400 ms
 *  floor) and the focus re-look spacing. "current" has none (null: the code's own). */
export function ruleSpacingsMs(rule: Rule, inputs: RuleInputs): { staleMs: number; relookMs: number } | null {
  if (rule === "current") return null;
  const F = inputs.fastCadence;
  const B = budgetedSpacingMs(F, inputs.pacedMs(), inputs.roundTripMs(), inputs.lifetimeMs);
  return { staleMs: rule === "strict" ? F : B, relookMs: rule === "budgeted+relook" ? B : F };
}

/** Install a candidate rule on a core's scheduler (see the header). "current" changes nothing. */
function installRule(core: SessionCore, rule: Rule, inputs: RuleInputs): void {
  if (rule === "current") return;
  const sched = core.scheduler;
  sched.staleFrameMs = (): number => Math.max(STALE_FRAME_MS, ruleSpacingsMs(rule, inputs)!.staleMs);
  const relook = sched.relookDue.bind(sched);
  sched.relookDue = (now: number, inFlight: boolean, videoTimeSec?: number): boolean => {
    sched.setRelookSpacingMs(ruleSpacingsMs(rule, inputs)!.relookMs);
    return relook(now, inFlight, videoTimeSec);
  };
}

// ------------------------------------------------------------------ scenarios

const frac = (px: number): number => px;

/** Moves of a pointer that stays about at (px, py): `every` ms apart from `from` to `to`. */
function jiggle(from: number, to: number, every: number, px: number, py: number): ScenarioEvent[] {
  const out: ScenarioEvent[] = [];
  for (let t = from, i = 0; t <= to; t += every, i++) out.push({ at: t, kind: "move", px: px + (i % 2 === 0 ? 0 : 4), py });
  return out;
}

/** A straight sweep along y from x0 to x1 over [from, to], a move every `every` ms. */
function sweep(from: number, to: number, every: number, x0: number, x1: number, py: number): ScenarioEvent[] {
  const out: ScenarioEvent[] = [];
  for (let t = from; t <= to; t += every) out.push({ at: t, kind: "move", px: frac(x0 + ((x1 - x0) * (t - from)) / (to - from)), py });
  return out;
}

const mv = (at: number, px: number, py: number): ScenarioEvent => ({ at, kind: "move", px, py });
const EMPTY = { px: 900, py: 450 } as const;
const LOAD_MS = 1500;

/** A warm session: the pointer works on card A for 4 s and rests until 8 s. */
const warmA = (): ScenarioEvent[] => jiggle(0, 4000, 400, 200, 250);

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "first-load", summary: "the pointer is on card A from 0 to 20 s, before the release has loaded (1500 ms); dwell 20 s", durationMs: 20_000, layout: ABC, startReady: false,
    events: [mv(0, 200, 250), { at: LOAD_MS, kind: "load" }],
  },
  ...[1_000, 3_000, 12_000].map(
    (gap): Scenario => ({
      name: `reentry-${gap / 1000}s`, summary: `the pointer rests on card A 8 s (dwell 8 s), leaves, and returns to card A after ${gap / 1000} s (dwell 8 s)`, durationMs: 8_000 + gap + 8_000, layout: ABC, startReady: true,
      events: [...warmA(), { at: 8_000, kind: "leave" }, mv(8_000 + gap, 200, 250)],
    }),
  ),
  {
    name: "idle-reload", summary: "the worker is unloaded while the pointer is away; the pointer returns and the release loads again (1500 ms); dwell 8 s then 10 s", durationMs: 30_000, layout: ABC, startReady: true,
    events: [...warmA(), { at: 8_000, kind: "leave" }, { at: 9_000, kind: "unload" }, mv(20_000, 200, 250), { at: 20_000 + LOAD_MS, kind: "load" }],
  },
  {
    name: "move-onto-card", summary: "the pointer wanders over an empty spot 6.5 s, then moves onto card A (dwell 7.5 s)", durationMs: 14_000, layout: ABC, startReady: true,
    events: [...jiggle(0, 6000, 400, EMPTY.px, EMPTY.py), mv(6_500, 200, 250)],
  },
  {
    name: "sweep-fan", summary: "the pointer sweeps across a fan of five cards, dwells 0.6, 1.1, 1.0, 1.1 and 1.4 s", durationMs: 14_000, layout: FAN, startReady: true,
    events: [...jiggle(0, 4000, 400, 40, 450), ...sweep(5_000, 10_200, 100, 160, 740, 250)],
  },
  {
    name: "rest-past-grace", summary: "the pointer arrives on card A and rests, past the 10 s grace (dwell 45 s)", durationMs: 45_000, layout: ABC, startReady: true,
    events: jiggle(0, 2000, 400, 200, 250),
  },
  {
    name: "card-covered", summary: "card A covers card B; at 10 s A is moved away and B is under the pointer (dwell 10 s on A, 15 s on B)", durationMs: 25_000, layout: [{ id: "B", x: 100, y: 100, w: 200, h: 300 }, { id: "A", x: 110, y: 110, w: 180, h: 280 }], startReady: true,
    events: [...jiggle(0, 3000, 400, 200, 250), { at: 10_000, kind: "layout", cards: [{ id: "B", x: 100, y: 100, w: 200, h: 300 }] }],
  },
  {
    name: "empty-spot", summary: "the pointer rests on an empty spot; a card appears there at 8 s (dwell on it 22 s)", durationMs: 30_000, layout: ABC, startReady: true,
    events: [...jiggle(0, 3000, 400, EMPTY.px, EMPTY.py), { at: 8_000, kind: "layout", cards: [...ABC, { id: "E", x: 830, y: 350, w: 150, h: 140 }] }],
  },
  {
    name: "retry-backoff", summary: "a look fails at W, its retry is due 250 ms later, and a trusted move arrives at 600 ms (the video presents a frame a second); dwell 4 s", durationMs: 4_000, layout: ABC, startReady: true,
    events: [mv(0, 200, 250), mv(600, 205, 250)], failLooks: [1], frameEveryMs: 1_000,
  },
  {
    name: "retry-backoff-50fps", summary: "as retry-backoff with the video presenting 50 frames a second; no move; dwell 4 s", durationMs: 4_000, layout: ABC, startReady: true,
    events: [mv(0, 200, 250)], failLooks: [1],
  },
  {
    name: "pause-resume", summary: "the pointer rests on card A; the video pauses at 6 s and resumes at 12 s (dwell 20 s)", durationMs: 20_000, layout: ABC, startReady: true,
    events: [...warmA(), { at: 6_000, kind: "pause" }, { at: 12_000, kind: "resume" }],
  },
  {
    name: "seek", summary: "the pointer rests on card A; the video seeks 30 s ahead at 8 s (dwell 20 s)", durationMs: 20_000, layout: ABC, startReady: true,
    events: [...warmA(), { at: 8_000, kind: "seek", bySec: 30 }],
  },
];

/** A viewer session of one minute on a fan of cards: the scenario of the report's tables. */
export const VIEWER_SESSION: Scenario = {
  name: "viewer-session", summary: "wander over empty ground 2 s; card F2 for 17.5 s (dwell 17.5 s); card F4 for 10 s (dwell 10 s); an empty spot 15 s; card F3 for 15 s (dwell 15 s)", durationMs: 60_000, layout: FAN, startReady: true,
  events: [
    ...jiggle(0, 2000, 400, 40, 450),
    ...jiggle(2_500, 4_500, 400, 270, 250),
    ...jiggle(20_000, 21_500, 400, 500, 250),
    mv(30_000, EMPTY.px, EMPTY.py),
    mv(45_000, 420, 250),
  ],
};

/** The fan swept at 20 phases: phase i starts i x 50 ms later (0, 50, ..., 950 ms: against the ticks
 *  and the cadence) and, independently, ((7 i) mod 20) x 6 px to the right (the same 0, 6, ..., 114 px
 *  in another order, one card pitch: against the card edges), so that the two shifts do not cancel. */
export const SWEEP_PHASES: readonly number[] = Array.from({ length: 20 }, (_, i) => i);
export const SWEEP_START_MS = 5_000;
export const SWEEP_LENGTH_MS = 5_200;
export function sweepScenario(phase: number): Scenario {
  const at = phase * 50;
  const dx = ((phase * 7) % 20) * 6;
  return {
    name: `sweep-${phase}`, summary: "wander 5 s, then sweep five cards", durationMs: 12_000 + at, layout: FAN, startReady: true,
    events: [...jiggle(0, 4000, 400, 40, 450), ...sweep(SWEEP_START_MS + at, SWEEP_START_MS + SWEEP_LENGTH_MS + at, 100, 160 + dx, 740 + dx, 250)],
  };
}

/** One card, the pointer moving on it every 100 ms for 12 s. */
export const MOVING_POINTER: Scenario = {
  name: "pointer-moving", summary: "the pointer moves every 100 ms on card A for 12 s (dwell 12 s)", durationMs: 12_000, layout: ABC, startReady: true,
  events: jiggle(0, 12_000, 100, 200, 250),
};

export function scenarioNamed(name: string): Scenario {
  const found = name === VIEWER_SESSION.name ? VIEWER_SESSION : name === MOVING_POINTER.name ? MOVING_POINTER : SCENARIOS.find((s) => s.name === name);
  if (!found) throw new RangeError(`no scenario ${name}`);
  return found;
}

// ------------------------------------------------------------------ the report

const fmt = (v: number | null, digits = 0): string => (v === null ? "-" : v.toFixed(digits));
const pad = (s: string, n: number, left = false): string => (left ? s.padEnd(n) : s.padStart(n));

const COLUMNS: Array<[string, number, (r: RunResult) => string]> = [
  ["lat avg", 7, (r) => fmt(r.metrics.latencyAvgMs)],
  ["lat max", 7, (r) => fmt(r.metrics.latencyMaxMs)],
  ["unnamed", 7, (r) => `${r.metrics.unnamed}/${r.metrics.eligible}`],
  ["age mean", 8, (r) => fmt(r.metrics.ageAvgMs)],
  ["age max", 7, (r) => fmt(r.metrics.ageMaxMs)],
  ["gap tot", 7, (r) => fmt(r.metrics.gapTotalMs)],
  ["gap max", 7, (r) => fmt(r.metrics.gapMaxMs)],
  ["gap avoid", 9, (r) => fmt(r.metrics.gapAvoidableMs)],
  ["gap unavoid", 11, (r) => fmt(r.metrics.gapUnavoidableMs)],
  ["looks/min", 9, (r) => fmt(r.metrics.looksPerMinute, 1)],
  ["busy %", 6, (r) => fmt(r.metrics.busyShare * 100, 1)],
];

export interface TableRow {
  label: string[];
  run: RunResult;
}

/** A fixed-width table: label columns, then the metrics of every run. */
export function renderTable(title: string, labelHeads: readonly string[], rows: readonly TableRow[]): string {
  const widths = labelHeads.map((h, i) => Math.max(h.length, ...rows.map((r) => r.label[i]!.length)));
  const head = [...labelHeads.map((h, i) => pad(h, widths[i]!, true)), ...COLUMNS.map(([h, w]) => pad(h, w))].join("  ");
  const lines = [title, head, "-".repeat(head.length)];
  for (const row of rows) lines.push([...row.label.map((l, i) => pad(l, widths[i]!, true)), ...COLUMNS.map(([, w, f]) => pad(f(row.run), w))].join("  "));
  return lines.join("\n");
}

const LEGEND = `Columns (ms unless noted). lat: from the pointer arriving on a card to a displayed answer naming it
(avg and max over the visits long enough to be named, i.e. a dwell of at least one capture plus
analysis; a visit never named counts at its dwell; unnamed = such visits never named / such visits). age: the age, in video ms, of the
answer on screen, time-weighted over the time the pointer is on a card the screen names correctly (mean and max). gap: time with the pointer on a card already named once and
nothing (or another card) displayed; avoid / unavoid split it by whether 2 x (capture + analysis)
fits in the lifetime, and the look cycle (capture + analysis) is at most the answer's life, since a
slower answer expires on arrival. The answer's life is the max age (2000 ms) divided by the playback
rate; a hold lengthens what is displayed, so under SHOWN_HOLD the lifetime is that answer life plus the
hold's 5000 ms (wall time, not divided), and under the reading hold it is unbounded. looks/min: looks
started per minute. busy: share of the run the worker spends analyzing.
The rules: current (the code as it is, which runs the budgeted rule: its rows equal budgeted's); strict (a
look the viewer waits on starts at the backend's fixed fast cadence); budgeted (the stale-picture threshold
only is max(F, min(paced interval, answer lifetime - round trip - 250)), the focus re-look at F);
budgeted+relook (the re-look spacing also gets that budget). The budget uses the
answer's wall lifetime, 2000 ms over the playback rate (1000 ms at 2x), but is compared with video age as
the code compares its cadence, which is a limitation that applies to strict too: its threshold
(500 ms on WebGPU, 1000 ms on WebAssembly) refreshes every 250 ms (WebGPU) or 500 ms (WebAssembly) of
wall time at 2x, and every 1000 ms (WebGPU) or 2000 ms (WebAssembly) at 0.5x. Entry looks, the reading wait
(with the shown hold's deadline), the empty-spot rest and retries are the same under every rule.
This is a model of the scheduling policy on a virtual clock, not a browser measurement.`;

const FOOTNOTE_2X = `Footnote. At 2x playback an answer lives 1000 ms of wall time, so rows with W of 1200 or more name nothing under any rule.`;

const FOOTNOTE = `Footnote. Under SHOWN_HOLD the reading wait has a deadline that includes the hold (at most the answer lifetime
+ 5000 - round trip - 250 ms), so a resting pointer on a card that stays keeps its name between two
looks; it is the same under every rule.`;

export const TABLE_WORKER_MS = [200, 500, 800, 1200, 1700] as const;
export const BOUNDARY_WORKER_MS = [125, 400, 1000, 1400, 2000] as const;
/** A worker time that changes from look to look. */
export const VARYING_WORKER_MS: readonly number[] = [400, 1700, 300, 1200, 600, 2000, 500, 900];

const BACKENDS: readonly Backend[] = ["webgpu", "wasm"];

function matrix(title: string, workerMs: ReadonlyArray<number | readonly number[]>, extra: Partial<SlowClockConfig>, namer: (w: number | readonly number[]) => string = String): string {
  const rows: TableRow[] = [];
  for (const w of workerMs) {
    for (const backend of BACKENDS) {
      for (const rule of RULES) {
        const cfg = { ...extra, workerMs: w, backend, rule };
        rows.push({ label: [rule, namer(w), backend, String(cfg.playbackRate ?? 1)], run: runScenario(VIEWER_SESSION, cfg) });
      }
    }
  }
  return renderTable(title, ["rule", "W", "backend", "rate"], rows);
}

/** A table whose rows are plain cells; the first `left` columns are left-aligned. */
function plainTable(title: string, head: string[], lines: string[][], left: number): string {
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const row = (cells: string[]): string => cells.map((c, i) => (i < left ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [title, row(head), "-".repeat(row(head).length), ...lines.map(row)].join("\n");
}

/** The sweep table: the fan swept at 20 phases, pooled; looks and busy over the sweep window only. */
function sweepTable(): string {
  const head = ["rule", "W", "backend", "looks/min", "busy %", "visits", "unnamed", "lat mean", "age mean", "age max"];
  const lines: string[][] = [];
  for (const w of [500, 800]) {
    for (const backend of BACKENDS) {
      for (const rule of RULES) {
        let looks = 0;
        let busy = 0;
        let eligible = 0;
        let unnamed = 0;
        let latSum = 0;
        let shown = 0;
        let ageSum = 0;
        let ageMax = 0;
        for (const phase of SWEEP_PHASES) {
          const sc = sweepScenario(phase);
          const from = SWEEP_START_MS + phase * 50;
          const to = from + SWEEP_LENGTH_MS;
          const run = runScenario(sc, { hold: "shown", measuredPacing: true, focus: true, workerMs: w, backend, rule });
          looks += run.looks.filter((l) => l.at >= from && l.at <= to).length;
          for (const b of run.busy) busy += Math.max(0, Math.min(b.at + b.ms, to) - Math.max(b.at, from));
          eligible += run.metrics.eligible;
          unnamed += run.metrics.unnamed;
          latSum += (run.metrics.latencyAvgMs ?? 0) * run.metrics.eligible;
          shown += run.metrics.shownMs;
          ageSum += run.metrics.ageIntegralMs;
          ageMax = Math.max(ageMax, run.metrics.ageMaxMs ?? 0);
        }
        const window = SWEEP_LENGTH_MS * SWEEP_PHASES.length;
        lines.push([rule, String(w), backend, fmt((looks * 60_000) / window, 1), fmt((busy / window) * 100, 1), fmt(eligible / SWEEP_PHASES.length, 1), `${unnamed}/${eligible}`, eligible ? fmt(latSum / eligible) : "-", shown ? fmt(ageSum / shown) : "-", shown ? fmt(ageMax) : "-"]);
      }
    }
  }
  return plainTable("Table 1c: a sweep across the fan, dwells per card 0.6 to 1.4 s at phase 0 (0.6, 1.1, 1.0, 1.1, 1.4 s) and varying with the phase (geometric stage in focus scope, the only path with a re-look), pooled over 20 phases (start 0, 50, ..., 950 ms later and, independently, 0, 6, ..., 114 px to the right in another order: against the ticks and the card edges); looks and busy over the sweep window only; visits = eligible visits per sweep; unnamed = eligible visits never named / eligible visits; latency counts a card never named at its dwell", head, lines, 3);
}

/** The moving-pointer table: one card, the pointer moving every 100 ms for 12 s. */
function movingTable(): string {
  const rows: TableRow[] = [];
  for (const w of [500, 800]) {
    for (const backend of BACKENDS) {
      for (const rule of RULES) rows.push({ label: [rule, String(w), backend], run: runScenario(MOVING_POINTER, { hold: "shown", measuredPacing: true, focus: true, workerMs: w, backend, rule }) });
    }
  }
  return renderTable("Table 1d: " + MOVING_POINTER.summary, ["rule", "W", "backend"], rows);
}

/** The text `npm run slow-clock` prints. Deterministic. */
export function renderReport(): string {
  const base: Partial<SlowClockConfig> = { hold: "shown", measuredPacing: true, focus: true, captureDelayMs: 0, playbackRate: 1 };
  const parts: string[] = [];
  parts.push("Slow-clock report: look scheduling on a virtual clock");
  parts.push(`Scenario: ${VIEWER_SESSION.name} (${VIEWER_SESSION.summary}), ${VIEWER_SESSION.durationMs / 1000} s.`);
  parts.push("Configuration: measured pacing on, SHOWN_HOLD, geometric stage ready with focus scope, no capture delay, 1x playback, unless a column says otherwise.");
  parts.push(LEGEND);
  parts.push(matrix("Table 1: rule x analysis time W (ms) x backend, 1x playback", TABLE_WORKER_MS, base));
  parts.push(FOOTNOTE);
  for (const rate of [0.5, 2]) parts.push(matrix(`Table 1b: as Table 1 at ${rate}x playback`, TABLE_WORKER_MS, { ...base, playbackRate: rate }));
  parts.push(FOOTNOTE_2X);
  parts.push(sweepTable());
  parts.push(movingTable());
  parts.push(matrix("Table 2a: boundary analysis times, 1x playback", BOUNDARY_WORKER_MS, base));
  parts.push(FOOTNOTE);
  for (const rate of [1, 0.5, 2]) {
    parts.push(matrix(`Table 2b: W varies from look to look (${VARYING_WORKER_MS.join(",")}) at ${rate}x playback`, [VARYING_WORKER_MS], { ...base, playbackRate: rate }, () => "varying"));
  }
  parts.push(matrix("Table 2c: W = 1200 with a 400 ms delay in getting the picture", [1200], { ...base, captureDelayMs: 400 }));

  const variants: TableRow[] = [];
  for (const hold of ["none", "shown", "reading"] as const) {
    for (const focus of [false, true]) {
      for (const rule of RULES) variants.push({ label: [rule, hold, focus ? "focus" : "stage off"], run: runScenario(VIEWER_SESSION, { ...base, workerMs: 1200, hold, focus, rule }) });
    }
  }
  parts.push(renderTable("Table 3: W = 1200, WebGPU, 1x: hold mode and geometric stage", ["rule", "hold", "stage"], variants));

  const perScenario: TableRow[] = [];
  for (const s of [...SCENARIOS]) {
    for (const rule of RULES) perScenario.push({ label: [s.name, rule], run: runScenario(s, { ...base, workerMs: 1200, rule }) });
  }
  parts.push(renderTable("Table 4: each scenario, W = 1200, WebGPU, 1x", ["scenario", "rule"], perScenario));
  return parts.join("\n\n") + "\n";
}
