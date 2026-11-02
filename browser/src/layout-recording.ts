// SPDX-License-Identifier: Apache-2.0
// Recordings for measuring layout registration (`layout-recording/1`), and a replay driver.
//
// A recording is one JSON file per session: the frames a recorder captured, each with the
// analysis the recognizer produced for it (how long it took, the card faces, the accepted
// cards), the candidate layouts the product's source delivered (when each was produced and
// when it arrived), and scenes with their true placement where one is known. All times are in
// milliseconds.
//
// The reader enforces the causal rule: a frame is offered only candidates that had arrived when
// it was captured. The truth for scoring is the candidate produced nearest before the frame's
// decoded stream clock (the recorder decodes the clock; the reader trusts its result). Everything
// but the clocks and the truths must be well formed, or the file is refused: times, analyses,
// candidates, and also each scene's id, class and span and each frame's image. Clocks and
// truths are checked more gently: a frame whose clock is malformed counts as having none, and a
// scene whose truth is malformed has none; both are listed in `problems`. A truth that is absent
// or null is simply no truth, not a problem. Frames without a decoded clock are left out of
// time-dependent measurements, and counted. A negative scene (no layout to place) has a truth
// with `region: null`. A truth is usable only when its region and all its solves agree at five
// fiducial points within 2 px. A candidate's layout may carry its `aspect`; replay then passes
// the recording's frame aspect, which turns on the aspect prior. Keys the reader does not know
// are ignored, so a recorder may add its own.
//
// The driver replays a recording through a scheduler policy and the state machine: each
// frame is presented to the scheduler, an analysis starts when the scheduler says it is due and
// none is in flight, finishes `durationMs` later, and its result reaches the state machine
// then. The verdict is recorded at every frame, analyzed or not. The scheduler is passed in, so
// a product can replay through its own.

import type { Box, Layout, LayoutCard, Observation, Region, Transform } from "./layout-fit.js";
import {
  type FrameInput,
  type LayoutConfig,
  LayoutRegistration,
  type LayoutSource,
  type Verdict,
} from "./layout-state.js";

export const LAYOUT_RECORDING_SCHEMA = "layout-recording/1";

/** A scene's true placement is unusable when a solve's marker error exceeds this many pixels,
 *  or two solves disagree by more at a fiducial point. */
export const MAX_TRUTH_RESIDUAL_PX = 2;

/** Where solves are compared: points of the layout's unit square (corners inset by 0.05, and the
 *  center). */
export const FIDUCIAL_POINTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0.05, y: 0.05 },
  { x: 0.95, y: 0.05 },
  { x: 0.5, y: 0.5 },
  { x: 0.05, y: 0.95 },
  { x: 0.95, y: 0.95 },
];

export const SCENE_CLASSES = [
  "supported-game",
  "two-region",
  "negative-no-faces",
  "negative-gallery",
  "negative-other-layout",
  "transition",
] as const;
export type SceneClass = (typeof SCENE_CLASSES)[number];

export interface SceneTruth {
  /** The layout's unit square in the frame (frame fractions); null for a scene with no layout to
   *  place (a negative scene). */
  region: Region | null;
  /** The largest marker error of the solve, in pixels. */
  residualPx: number;
  /** The visible captured area, frame fractions. */
  mask: Box;
  /** Areas painted over the picture, frame fractions. */
  blockers: Box[];
  /** Repeated solves during the scene, each with the placement it found (null in a negative
   *  scene). */
  solves: Array<{ atMs: number; residualPx: number; region: Region | null }>;
}

export interface Scene {
  id: string;
  class: SceneClass;
  startMs: number;
  endMs: number;
  truth?: SceneTruth;
}

export type ClockStatus = "ok" | "undecodable" | "missing";

export interface RecordedFrame {
  index: number;
  capturedAtMs: number;
  image: string;
  clock: { status: ClockStatus; streamTimeMs?: number };
  analysis: { durationMs: number; faces: number; observations: Observation[] };
}

export interface LayoutCandidate {
  key: string;
  producedAtMs: number;
  arrivedAtMs: number;
  layout: Layout;
}

export interface LayoutRecording {
  schema: typeof LAYOUT_RECORDING_SCHEMA;
  frame: { width: number; height: number };
  cadenceProfiles: Array<{ name: string; intervalMs: number }>;
  scenes: Scene[];
  frames: RecordedFrame[];
  candidates: LayoutCandidate[];
  /** What the reader set aside: a malformed clock or truth, by its path. */
  problems: string[];
}

// -------------------------------------------------------------------------------------------
// Reading
// -------------------------------------------------------------------------------------------

class RecordingError extends Error {}

function fail(path: string, message: string): never {
  throw new RecordingError(`${path}: ${message}`);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "must be an object");
  return v as Record<string, unknown>;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "must be an array");
  return v;
}

function num(v: unknown, path: string, opts: { min?: number; integer?: boolean } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "must be a finite number");
  if (opts.integer && !Number.isInteger(v)) fail(path, "must be an integer");
  if (opts.min !== undefined && v < opts.min) fail(path, `must be at least ${opts.min}`);
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string") fail(path, "must be a string");
  return v;
}

function box(v: unknown, path: string): Box {
  const o = obj(v, path);
  return {
    x: num(o.x, `${path}.x`),
    y: num(o.y, `${path}.y`),
    w: num(o.w, `${path}.w`, { min: 0 }),
    h: num(o.h, `${path}.h`, { min: 0 }),
  };
}

function region(v: unknown, path: string): Region {
  const o = obj(v, path);
  return {
    x: num(o.x, `${path}.x`),
    y: num(o.y, `${path}.y`),
    width: num(o.width, `${path}.width`, { min: 0 }),
    height: num(o.height, `${path}.height`, { min: 0 }),
  };
}

function layout(v: unknown, path: string): Layout {
  const o = obj(v, path);
  const cards = arr(o.cards, `${path}.cards`).map((c, i): LayoutCard => {
    const p = `${path}.cards[${i}]`;
    const co = obj(c, p);
    const card: LayoutCard = { instance: str(co.instance, `${p}.instance`), bounds: box(co.bounds, `${p}.bounds`) };
    if (co.identity !== undefined) card.identity = str(co.identity, `${p}.identity`);
    if (co.rotated !== undefined) {
      if (typeof co.rotated !== "boolean") fail(`${p}.rotated`, "must be a boolean");
      card.rotated = co.rotated;
    }
    return card;
  });
  const out: Layout = { key: str(o.key, `${path}.key`), cards };
  if (o.blocking !== undefined) out.blocking = box(o.blocking, `${path}.blocking`);
  if (o.aspect !== undefined) {
    out.aspect = num(o.aspect, `${path}.aspect`);
    if (!(out.aspect > 0)) fail(`${path}.aspect`, "must be positive");
  }
  return out;
}

/** A truth as read, or the reason it is set aside. */
function readTruth(v: unknown, path: string): SceneTruth | string {
  try {
    const t = obj(v, path);
    const placed = t.region !== null;
    return {
      region: placed ? region(t.region, `${path}.region`) : null,
      residualPx: placed ? num(t.residualPx, `${path}.residualPx`, { min: 0 }) : typeof t.residualPx === "number" ? t.residualPx : 0,
      mask: box(t.mask, `${path}.mask`),
      blockers: t.blockers === undefined ? [] : arr(t.blockers, `${path}.blockers`).map((b, j) => box(b, `${path}.blockers[${j}]`)),
      solves:
        t.solves === undefined
          ? []
          : arr(t.solves, `${path}.solves`).map((sv, j) => {
              const so = obj(sv, `${path}.solves[${j}]`);
              return {
                atMs: num(so.atMs, `${path}.solves[${j}].atMs`),
                residualPx: num(so.residualPx, `${path}.solves[${j}].residualPx`, { min: 0 }),
                region: placed ? region(so.region, `${path}.solves[${j}].region`) : null,
              };
            }),
    };
  } catch (e) {
    if (e instanceof RecordingError) return e.message;
    throw e;
  }
}

/** A clock as read: a malformed one counts as missing. */
function readClock(v: unknown, path: string, problems: string[]): RecordedFrame["clock"] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    problems.push(`${path}: no clock`);
    return { status: "missing" };
  }
  const c = v as Record<string, unknown>;
  if (c.status !== "ok" && c.status !== "undecodable" && c.status !== "missing") {
    problems.push(`${path}.status: unknown status ${JSON.stringify(c.status)}`);
    return { status: "missing" };
  }
  if (c.status !== "ok") return { status: c.status };
  if (typeof c.streamTimeMs !== "number" || !Number.isFinite(c.streamTimeMs)) {
    problems.push(`${path}.streamTimeMs: an ok clock without a finite time`);
    return { status: "missing" };
  }
  return { status: "ok", streamTimeMs: c.streamTimeMs };
}

/** Read and check a `layout-recording/1` document; throws naming the first bad field that
 *  replay needs. */
export function readLayoutRecording(json: unknown): LayoutRecording {
  const problems: string[] = [];
  const root = obj(json, "recording");
  if (root.schema !== LAYOUT_RECORDING_SCHEMA) fail("recording.schema", `must be "${LAYOUT_RECORDING_SCHEMA}"`);
  const f = obj(root.frame, "recording.frame");
  const frame = { width: num(f.width, "recording.frame.width", { min: 1 }), height: num(f.height, "recording.frame.height", { min: 1 }) };

  const cadenceProfiles = arr(root.cadenceProfiles, "recording.cadenceProfiles").map((p, i) => {
    const o = obj(p, `recording.cadenceProfiles[${i}]`);
    const intervalMs = num(o.intervalMs, `recording.cadenceProfiles[${i}].intervalMs`);
    if (!(intervalMs > 0)) fail(`recording.cadenceProfiles[${i}].intervalMs`, "must be positive");
    return { name: str(o.name, `recording.cadenceProfiles[${i}].name`), intervalMs };
  });

  const scenes = arr(root.scenes, "recording.scenes").map((s, i): Scene => {
    const p = `recording.scenes[${i}]`;
    const o = obj(s, p);
    const cls = str(o.class, `${p}.class`);
    if (!(SCENE_CLASSES as readonly string[]).includes(cls)) fail(`${p}.class`, `unknown scene class "${cls}"`);
    const scene: Scene = {
      id: str(o.id, `${p}.id`),
      class: cls as SceneClass,
      startMs: num(o.startMs, `${p}.startMs`),
      endMs: num(o.endMs, `${p}.endMs`),
    };
    if (scene.endMs < scene.startMs) fail(`${p}.endMs`, "must not be before startMs");
    if (o.truth !== undefined && o.truth !== null) {
      const truth = readTruth(o.truth, `${p}.truth`);
      if (typeof truth === "string") problems.push(truth);
      else scene.truth = truth;
    }
    return scene;
  });

  let lastCaptured = -Infinity;
  const frames = arr(root.frames, "recording.frames").map((fr, i): RecordedFrame => {
    const p = `recording.frames[${i}]`;
    const o = obj(fr, p);
    const capturedAtMs = num(o.capturedAtMs, `${p}.capturedAtMs`);
    if (capturedAtMs < lastCaptured) fail(`${p}.capturedAtMs`, "frames must be in capture order");
    lastCaptured = capturedAtMs;
    const clock = readClock(o.clock, `${p}.clock`, problems);
    const a = obj(o.analysis, `${p}.analysis`);
    return {
      index: num(o.index, `${p}.index`, { integer: true, min: 0 }),
      capturedAtMs,
      image: str(o.image, `${p}.image`),
      clock,
      analysis: {
        durationMs: num(a.durationMs, `${p}.analysis.durationMs`, { min: 0 }),
        faces: num(a.faces, `${p}.analysis.faces`, { integer: true, min: 0 }),
        observations: arr(a.observations, `${p}.analysis.observations`).map((ob, j) => {
          const op = `${p}.analysis.observations[${j}]`;
          const oo = obj(ob, op);
          return { identity: str(oo.identity, `${op}.identity`), bounds: box(oo.bounds, `${op}.bounds`) };
        }),
      },
    };
  });

  const candidates = arr(root.candidates, "recording.candidates").map((cv, i): LayoutCandidate => {
    const p = `recording.candidates[${i}]`;
    const o = obj(cv, p);
    return {
      key: str(o.key, `${p}.key`),
      producedAtMs: num(o.producedAtMs, `${p}.producedAtMs`),
      arrivedAtMs: num(o.arrivedAtMs, `${p}.arrivedAtMs`),
      layout: layout(o.layout, `${p}.layout`),
    };
  });

  return { schema: LAYOUT_RECORDING_SCHEMA, frame, cadenceProfiles, scenes, frames, candidates, problems };
}

/** The candidates a picture captured at `capturedAtMs` may be offered: those that had arrived,
 *  in arrival order. */
export function offeredCandidates(rec: LayoutRecording, capturedAtMs: number): LayoutCandidate[] {
  return rec.candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.arrivedAtMs <= capturedAtMs)
    .sort((a, b) => a.c.arrivedAtMs - b.c.arrivedAtMs || a.i - b.i)
    .map(({ c }) => c);
}

/** The newest candidate that had arrived by `capturedAtMs`; null for none. */
export function latestOffered(rec: LayoutRecording, capturedAtMs: number): LayoutCandidate | null {
  const offered = offeredCandidates(rec, capturedAtMs);
  return offered.length > 0 ? offered[offered.length - 1]! : null;
}

/** The truth state of a frame: the candidate produced nearest before (or at) its decoded stream
 *  time. Null when its clock was not decoded or nothing was produced by then. */
export function truthCandidate(rec: LayoutRecording, frame: RecordedFrame): LayoutCandidate | null {
  if (!clockUsable(frame.clock)) return null;
  const at = frame.clock.streamTimeMs!;
  let best: LayoutCandidate | null = null;
  for (const c of rec.candidates) {
    if (c.producedAtMs <= at && (best === null || c.producedAtMs > best.producedAtMs)) best = c;
  }
  return best;
}

/** Can a frame's clock time it: decoded, with a finite stream time? */
export function clockUsable(clock: RecordedFrame["clock"] | null | undefined): boolean {
  return clock?.status === "ok" && typeof clock.streamTimeMs === "number" && Number.isFinite(clock.streamTimeMs);
}

/** Frames usable for time-dependent measurements (clock decoded), and how many were left out. */
export function timedFrames(rec: LayoutRecording): { frames: RecordedFrame[]; excluded: number } {
  const frames = rec.frames.filter((f) => clockUsable(f.clock));
  return { frames, excluded: rec.frames.length - frames.length };
}

/** The scene a time falls in (start inclusive, end exclusive); null when none. */
export function sceneAt(rec: LayoutRecording, atMs: number): Scene | null {
  return rec.scenes.find((s) => atMs >= s.startMs && atMs < s.endMs) ?? null;
}

/**
 * Is a scene's true placement usable? It must be present, its residual and every solve's within
 * `MAX_TRUTH_RESIDUAL_PX`, and the region and every solve must agree: no two of them may put a
 * fiducial point more than that many pixels apart (on either axis, in a frame of
 * `frame.width` × `frame.height`). Null for a scene with no placement to judge
 * (`region: null`, a negative scene); false for a scene without a truth.
 */
export function truthUsable(scene: Scene, frame: { width: number; height: number }): boolean | null {
  const t = scene.truth;
  if (!t) return false;
  if (t.region === null) return null;
  if (!(t.residualPx <= MAX_TRUTH_RESIDUAL_PX)) return false;
  if (!t.solves.every((s) => s.residualPx <= MAX_TRUTH_RESIDUAL_PX)) return false;
  const regions: Region[] = [t.region];
  for (const s of t.solves) {
    if (!s.region) return false;
    regions.push(s.region);
  }
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (!regionsAgree(regions[i]!, regions[j]!, frame)) return false;
    }
  }
  return true;
}

/** Whether two regions put every fiducial point within `MAX_TRUTH_RESIDUAL_PX` of each other. */
function regionsAgree(a: Region, b: Region, frame: { width: number; height: number }): boolean {
  for (const p of FIDUCIAL_POINTS) {
    const dx = Math.abs(a.x + p.x * a.width - (b.x + p.x * b.width)) * frame.width;
    const dy = Math.abs(a.y + p.y * a.height - (b.y + p.y * b.height)) * frame.height;
    if (dx > MAX_TRUTH_RESIDUAL_PX || dy > MAX_TRUTH_RESIDUAL_PX) return false;
  }
  return true;
}

/** A region as the placement it stands for. */
export function regionToTransform(r: Region): Transform {
  return { sx: r.width, sy: r.height, tx: r.x, ty: r.y };
}

/** A recording as a layout source: the newest arrived candidate; the window is that candidate's
 *  identities. */
export function recordingSource(rec: LayoutRecording): LayoutSource {
  return {
    layoutAt: (at) => latestOffered(rec, at)?.layout ?? null,
    windowIdentitiesAt: (at) => identitiesOf(latestOffered(rec, at)?.layout ?? null),
  };
}

function identitiesOf(l: Layout | null): ReadonlySet<string> {
  const out = new Set<string>();
  for (const c of l?.cards ?? []) if (c.identity !== undefined) out.add(c.identity);
  return out;
}

// -------------------------------------------------------------------------------------------
// The replay driver
// -------------------------------------------------------------------------------------------

/** The scheduler policy the driver replays through: the toolkit's `FrameScheduler` in "layout"
 *  mode fits, and so does any product scheduler with these three calls. */
export interface ProbeScheduler {
  framePresented(): void;
  due(nowMs: number): boolean;
  started(nowMs: number): void;
}

export interface ReplayAnalysis {
  frameIndex: number;
  startedAtMs: number;
  endedAtMs: number;
  /** It ended after the next analysis was due. */
  late: boolean;
}

export interface ReplayStep {
  frameIndex: number;
  atMs: number;
  result: Verdict;
}

export interface Replay {
  /** The verdict at every frame, after any analysis that ended by then. */
  steps: ReplayStep[];
  analyses: ReplayAnalysis[];
}

export interface ReplayOptions {
  /** The product's configuration; its `intervalMs` is replaced by the profile's. */
  config: LayoutConfig;
  /** The cadence profile's name in the recording. */
  profile: string;
  /** Makes the scheduler for an interval, e.g. a `FrameScheduler` in "layout" mode. */
  scheduler: (intervalMs: number) => ProbeScheduler;
  /** Where layouts come from; the recording's own candidates by default. */
  source?: LayoutSource;
  exclude?: (identity: string) => boolean;
}

/** Replay a recording through a scheduler and the state machine (one generation). */
export function replayRecording(rec: LayoutRecording, options: ReplayOptions): Replay {
  const profile = rec.cadenceProfiles.find((p) => p.name === options.profile);
  if (!profile) throw new Error(`no cadence profile "${options.profile}" in the recording`);
  const config = { ...options.config, intervalMs: profile.intervalMs };
  const machine = new LayoutRegistration(config, { exclude: options.exclude });
  const scheduler = options.scheduler(profile.intervalMs);
  const source = options.source ?? recordingSource(rec);
  const steps: ReplayStep[] = [];
  const analyses: ReplayAnalysis[] = [];
  let inFlight: { frame: RecordedFrame; startedAtMs: number; endedAtMs: number } | null = null;
  const generation = 1;
  if (rec.frames.length > 0) machine.reset(generation, rec.frames[0]!.capturedAtMs);

  const finish = (): void => {
    const run = inFlight!;
    inFlight = null;
    const f = run.frame;
    const input: FrameInput = {
      generation,
      capturedAtMs: f.capturedAtMs,
      faces: f.analysis.faces,
      observations: f.analysis.observations,
      layout: source.layoutAt(f.capturedAtMs),
      windowIdentities: source.windowIdentitiesAt(f.capturedAtMs),
      frameAspect: rec.frame.width / rec.frame.height,
    };
    machine.analyze(input, run.endedAtMs);
    analyses.push({
      frameIndex: f.index,
      startedAtMs: run.startedAtMs,
      endedAtMs: run.endedAtMs,
      late: run.endedAtMs > run.startedAtMs + profile.intervalMs,
    });
  };

  for (const f of rec.frames) {
    const now = f.capturedAtMs;
    if (inFlight && inFlight.endedAtMs <= now) finish();
    scheduler.framePresented();
    if (!inFlight && scheduler.due(now)) {
      scheduler.started(now);
      inFlight = { frame: f, startedAtMs: now, endedAtMs: now + f.analysis.durationMs };
      if (f.analysis.durationMs === 0) finish();
    }
    steps.push({ frameIndex: f.index, atMs: now, result: machine.tick(now) });
  }
  if (inFlight) finish();
  return { steps, analyses };
}
