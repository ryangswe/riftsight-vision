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
// `browser/src` is unchanged and "current" is today's code untouched. Notation: F is the fixed
// fast cadence of the backend (`activeAnalyzeIntervalMs`: 500 ms WebGPU, 1000 ms WebAssembly); A is
// the release's max age (2000 ms); P is the paced interval (`pacedIntervalMs` over the worker
// times when measured pacing is on: max(F, min(4000, median of the last 5 worker times / share)),
// and F while fewer than 3 times are known or pacing is off); R is the median of the last 5 round
// trips (capture asked for to reply, ms); M is the margin, one driver tick (250 ms).
//
//   current:  stale threshold = max(400, cadence in effect); re-look spacing = max(250, 4 x median
//             worker time, up to 4000), as the code does today. Nothing is replaced.
//   strict:   stale threshold = max(400, F); re-look spacing = F.
//   budgeted: B = max(F, min(P, A - R - M)); stale threshold = max(400, B); re-look spacing = B.
//             Warm-up (no round trip yet): B = F. A negative A - R - M gives B = F. A floor F
//             above the ceiling P gives B = F (the floor wins, as in `pacedIntervalMs`). With
//             pacing off, P = F, so B = F.
//
// Both candidates keep every other limit: one look in flight, at least 250 ms between looks a
// pointer asks for, the back-off of an unanswered look, and the paced cadence of looks nobody is
// waiting on (the empty-spot rest, reading looks, always-on mode).

import { activeAnalyzeIntervalMs, MEASURED_PACING_ACTIVE_CEILING_MS, MEASURED_PACING_MIN_SAMPLES, MEASURED_PACING_SHARE, MEASURED_PACING_WINDOW } from "../../src/cadence.js";
import { DRIVER_TICK_MS, HOVER_MAX_AGE_MS, STALE_FRAME_MS } from "../../src/frame-scheduler.js";
import { ANALYSIS_FAILED, type FrameResult, type ReleaseStatus, type WorkerRequest } from "../../src/messages.js";
import type { FrameAnalysis } from "../../src/pipeline.js";
import { focusGroup } from "../../src/recognition.js";
import { READING_HOLD, SessionCore, type SessionCoreOptions, type Shown, SHOWN_HOLD } from "../../src/session-core.js";

export type Rule = "current" | "strict" | "budgeted";
export type HoldMode = "none" | "shown" | "reading";
export type Backend = "webgpu" | "wasm";

export const RULES: readonly Rule[] = ["current", "strict", "budgeted"];

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
  /** The picture changes under the pointer without a seek; the host reports a cut when a card shows. */
  | { at: number; kind: "layout"; cards: readonly CardSpec[] }
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
  unnamed: number;
  latencyAvgMs: number | null;
  latencyMaxMs: number | null;
  ageAvgMs: number | null;
  ageMaxMs: number | null;
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
  /** Per residence: the card, its arrival, and the latency to the first correct name (null: never). */
  residences: Array<{ card: string; startMs: number; latencyMs: number | null }>;
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
  let lastResultSec = mediaSec;

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
    const analysis = failing ? null : reused ? ({ ...previous, reused: true } as FrameAnalysis) : buildAnalysis(request);
    if (analysis && !reused) analyses.set(requestId, analysis);
    const sentAt = clock;
    const reply: FrameResult = {
      kind: "frame-result", envelope: request.envelope, videoTimeSec: request.videoTimeSec, width: W, height: H, workerMs,
      analysis, ...(failing ? { error: `${ANALYSIS_FAILED}: stand-in` } : {}),
    };
    schedule(clock + workerMs, () => {
      if (analysis) lastResultSec = reply.videoTimeSec;
      core.fromWorker(reply);
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
      },
      hoverAt: hit as never,
    },
    options,
  );

  installRule(core, cfg.rule, {
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
          if (displayed) core.cut();
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
  const ages: number[] = [];
  const lifetimeMs = MAX_AGE_MS / cfg.playbackRate;
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
    gaps.push({ card: r.card, startMs: r.gapStart, endMs: end, lengthMs: end - r.gapStart, avoidable: 2 * cycleNear(r.gapStart) <= lifetimeMs });
    r.gapStart = null;
  };
  const closeResidence = (end: number): void => {
    if (!res) return;
    closeGap(res, end);
    residences.push({ card: res.card, startMs: res.startMs, latencyMs: res.firstNamedAt === null ? null : res.firstNamedAt - res.startMs });
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
      if (correct && !now.wasCorrect) ages.push((mediaSec - lastResultSec) * 1000);
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

  const named = residences.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs!);
  const sum = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0);
  const gapTotal = sum(gaps.map((g) => g.lengthMs));
  const metrics: Metrics = {
    residences: residences.length,
    unnamed: residences.length - named.length,
    latencyAvgMs: named.length ? sum(named) / named.length : null,
    latencyMaxMs: named.length ? Math.max(...named) : null,
    ageAvgMs: ages.length ? sum(ages) / ages.length : null,
    ageMaxMs: ages.length ? Math.max(...ages) : null,
    gapTotalMs: gapTotal,
    gapMaxMs: gaps.length ? Math.max(...gaps.map((g) => g.lengthMs)) : 0,
    gapAvoidableMs: sum(gaps.filter((g) => g.avoidable).map((g) => g.lengthMs)),
    gapUnavoidableMs: sum(gaps.filter((g) => !g.avoidable).map((g) => g.lengthMs)),
    looks: looks.length,
    looksPerMinute: (looks.length * 60_000) / scenario.durationMs,
    busyShare: busyMs / scenario.durationMs,
  };
  return { scenario: scenario.name, config: cfg, metrics, gaps, looks, residences };
}

// ------------------------------------------------------------------ the candidate rules

interface RuleInputs {
  fastCadence: number;
  /** P: the paced interval for a pointer-waiting look. */
  pacedMs(): number;
  /** R: the median recent round trip, or null before one is known. */
  roundTripMs(): number | null;
}

/** The "budgeted" rule's B: max(F, min(P, A - R - M)), and F while no round trip is known
 *  (`roundTripMs` null). F is the fixed fast cadence, P the paced interval, R the median round
 *  trip, A the max age and M the margin (one driver tick). A negative A - R - M gives F; so does
 *  an F above P, since the floor is applied last. */
export function budgetedSpacingMs(fastCadence: number, pacedMs: number, roundTripMs: number | null, maxAgeMs: number = MAX_AGE_MS): number {
  if (roundTripMs === null) return fastCadence;
  return Math.max(fastCadence, Math.min(pacedMs, maxAgeMs - roundTripMs - MARGIN_MS));
}

/** Install a candidate rule on a core's scheduler (see the header). "current" changes nothing. */
function installRule(core: SessionCore, rule: Rule, inputs: RuleInputs): void {
  if (rule === "current") return;
  const sched = core.scheduler;
  const F = inputs.fastCadence;
  const budget = (): number => budgetedSpacingMs(F, inputs.pacedMs(), inputs.roundTripMs());
  const spacing = rule === "strict" ? (): number => F : budget;
  sched.staleFrameMs = (): number => Math.max(STALE_FRAME_MS, spacing());
  const relook = sched.relookDue.bind(sched);
  sched.relookDue = (now: number, inFlight: boolean, videoTimeSec?: number): boolean => {
    sched.setRelookSpacingMs(spacing());
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
    name: "first-load", summary: "the pointer is on card A before the release has loaded (1500 ms)", durationMs: 20_000, layout: ABC, startReady: false,
    events: [mv(0, 200, 250), { at: LOAD_MS, kind: "load" }],
  },
  ...[1_000, 3_000, 12_000].map(
    (gap): Scenario => ({
      name: `reentry-${gap / 1000}s`, summary: `the pointer leaves a warm session and returns to card A after ${gap / 1000} s`, durationMs: 8_000 + gap + 8_000, layout: ABC, startReady: true,
      events: [...warmA(), { at: 8_000, kind: "leave" }, mv(8_000 + gap, 200, 250)],
    }),
  ),
  {
    name: "idle-reload", summary: "the worker is unloaded while the pointer is away; the pointer returns and the release loads again (1500 ms)", durationMs: 30_000, layout: ABC, startReady: true,
    events: [...warmA(), { at: 8_000, kind: "leave" }, { at: 9_000, kind: "unload" }, mv(20_000, 200, 250), { at: 20_000 + LOAD_MS, kind: "load" }],
  },
  {
    name: "move-onto-card", summary: "the pointer wanders over an empty spot, then moves onto card A", durationMs: 14_000, layout: ABC, startReady: true,
    events: [...jiggle(0, 6000, 400, EMPTY.px, EMPTY.py), mv(6_500, 200, 250)],
  },
  {
    name: "sweep-fan", summary: "the pointer sweeps across a fan of five cards in 3 s", durationMs: 12_000, layout: FAN, startReady: true,
    events: [...jiggle(0, 4000, 400, 40, 450), ...sweep(5_000, 8_000, 100, 160, 740, 250)],
  },
  {
    name: "rest-past-grace", summary: "the pointer arrives on card A and rests 43 s, past the 10 s grace", durationMs: 45_000, layout: ABC, startReady: true,
    events: jiggle(0, 2000, 400, 200, 250),
  },
  {
    name: "card-covered", summary: "card A covers card B; at 10 s A is moved away and B is under the pointer", durationMs: 25_000, layout: [{ id: "B", x: 100, y: 100, w: 200, h: 300 }, { id: "A", x: 110, y: 110, w: 180, h: 280 }], startReady: true,
    events: [...jiggle(0, 3000, 400, 200, 250), { at: 10_000, kind: "layout", cards: [{ id: "B", x: 100, y: 100, w: 200, h: 300 }] }],
  },
  {
    name: "empty-spot", summary: "the pointer rests on an empty spot; a card appears there at 8 s", durationMs: 30_000, layout: ABC, startReady: true,
    events: [...jiggle(0, 3000, 400, EMPTY.px, EMPTY.py), { at: 8_000, kind: "layout", cards: [...ABC, { id: "E", x: 830, y: 350, w: 150, h: 140 }] }],
  },
  {
    name: "retry-backoff", summary: "a look fails at W, its retry is due 250 ms later, and a trusted move arrives at 600 ms (the video presents a frame a second)", durationMs: 4_000, layout: ABC, startReady: true,
    events: [mv(0, 200, 250), mv(600, 205, 250)], failLooks: [1], frameEveryMs: 1_000,
  },
  {
    name: "pause-resume", summary: "the pointer rests on card A; the video pauses at 6 s and resumes at 12 s", durationMs: 20_000, layout: ABC, startReady: true,
    events: [...warmA(), { at: 6_000, kind: "pause" }, { at: 12_000, kind: "resume" }],
  },
  {
    name: "seek", summary: "the pointer rests on card A; the video seeks 30 s ahead at 8 s", durationMs: 20_000, layout: ABC, startReady: true,
    events: [...warmA(), { at: 8_000, kind: "seek", bySec: 30 }],
  },
];

/** A viewer session of one minute on a fan of cards: the scenario of the report's tables. */
export const VIEWER_SESSION: Scenario = {
  name: "viewer-session", summary: "wander, point at a card and rest past the grace, sweep the fan, rest, an empty spot, another card", durationMs: 60_000, layout: FAN, startReady: true,
  events: [
    ...jiggle(0, 2000, 400, 40, 450),
    ...jiggle(2_500, 4_500, 400, 270, 250),
    ...sweep(20_000, 23_000, 100, 160, 740, 250),
    mv(30_000, EMPTY.px, EMPTY.py),
    mv(45_000, 420, 250),
  ],
};

export function scenarioNamed(name: string): Scenario {
  const found = name === VIEWER_SESSION.name ? VIEWER_SESSION : SCENARIOS.find((s) => s.name === name);
  if (!found) throw new RangeError(`no scenario ${name}`);
  return found;
}

// ------------------------------------------------------------------ the report

const fmt = (v: number | null, digits = 0): string => (v === null ? "-" : v.toFixed(digits));
const pad = (s: string, n: number, left = false): string => (left ? s.padEnd(n) : s.padStart(n));

const COLUMNS: Array<[string, number, (r: RunResult) => string]> = [
  ["lat avg", 7, (r) => fmt(r.metrics.latencyAvgMs)],
  ["lat max", 7, (r) => fmt(r.metrics.latencyMaxMs)],
  ["unnamed", 7, (r) => `${r.metrics.unnamed}/${r.metrics.residences}`],
  ["age avg", 7, (r) => fmt(r.metrics.ageAvgMs)],
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
(avg and max over cards named; unnamed = cards never named / cards visited). age: the age of the
answer when it first shows (video time). gap: time with the pointer on a card already named once and
nothing (or another card) displayed; avoid / unavoid split it by whether 2 x (capture + analysis)
fits in the answer's lifetime (max age 2000 ms, divided by the playback rate); a hold lengthens what
is displayed, so a gap under a hold can be avoidable although this test calls it unavoidable. looks/min: looks
started per minute. busy: share of the run the worker spends analyzing.
This is a model of the scheduling policy on a virtual clock, not a browser measurement.`;

export const OWNER_WORKER_MS = [200, 500, 800, 1200, 1700] as const;
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

/** The text `npm run slow-clock` prints. Deterministic. */
export function renderReport(): string {
  const base: Partial<SlowClockConfig> = { hold: "shown", measuredPacing: true, focus: true, captureDelayMs: 0, playbackRate: 1 };
  const parts: string[] = [];
  parts.push("Slow-clock report: look scheduling on a virtual clock");
  parts.push(`Scenario: ${VIEWER_SESSION.name} (${VIEWER_SESSION.summary}), ${VIEWER_SESSION.durationMs / 1000} s.`);
  parts.push("Configuration: measured pacing on, SHOWN_HOLD, geometric stage ready with focus scope, no capture delay, 1x playback, unless a column says otherwise.");
  parts.push(LEGEND);
  parts.push(matrix("Table 1: rule x analysis time W (ms) x backend, 1x playback", OWNER_WORKER_MS, base));
  parts.push(matrix("Table 2a: boundary analysis times, 1x playback", BOUNDARY_WORKER_MS, base));
  for (const rate of [1, 0.5, 2]) {
    parts.push(matrix(`Table 2b: W varies from look to look (${VARYING_WORKER_MS.join(",")}) at ${rate}x playback`, [VARYING_WORKER_MS], { ...base, playbackRate: rate }, () => "varying"));
  }
  for (const rate of [0.5, 2]) parts.push(matrix(`Table 2c: W = 1200 at ${rate}x playback`, [1200], { ...base, playbackRate: rate }));
  parts.push(matrix("Table 2d: W = 1200 with a 400 ms delay in getting the picture", [1200], { ...base, captureDelayMs: 400 }));

  const variants: TableRow[] = [];
  for (const hold of ["none", "shown", "reading"] as const) {
    for (const focus of [false, true]) {
      for (const rule of RULES) variants.push({ label: [rule, hold, focus ? "focus" : "all"], run: runScenario(VIEWER_SESSION, { ...base, workerMs: 1200, hold, focus, rule }) });
    }
  }
  parts.push(renderTable("Table 3: W = 1200, WebGPU, 1x: hold mode and geometric scope", ["rule", "hold", "scope"], variants));

  const perScenario: TableRow[] = [];
  for (const s of [...SCENARIOS]) {
    for (const rule of RULES) perScenario.push({ label: [s.name, rule], run: runScenario(s, { ...base, workerMs: 1200, rule }) });
  }
  parts.push(renderTable("Table 4: each scenario, W = 1200, WebGPU, 1x", ["scenario", "rule"], perScenario));
  return parts.join("\n\n") + "\n";
}
