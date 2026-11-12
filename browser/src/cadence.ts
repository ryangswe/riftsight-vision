// SPDX-License-Identifier: Apache-2.0
// How often a frame is analyzed.
//
// Three analysis modes:
//  - "pointer" (the default): analysis runs only around pointer activity over the picture
//    (frame-scheduler.ts). While the pointer is active the fast cadence applies: 2 analyses a
//    second on WebGPU, 1 on the WebAssembly fallback. A pointer resting on a showing tooltip
//    keeps analysis going at the slow cadence below; otherwise nothing is analyzed.
//  - "always-on": analysis runs for as long as the session does, at the slow cadence: 1 analysis
//    a second on WebGPU, one every 2 seconds on WebAssembly.
//  - "layout": a probe for layout registration (layout-state.ts). One analysis every probe
//    interval the product configures, whatever the pointer does, and one per picture while
//    paused. While the host also wants pointer-driven analysis (`setPointerAnalysis`), the
//    pointer rules above apply on top, in the same single slot. Only the scheduler runs it; a
//    session runs "pointer" or "always-on".
//
// On WebAssembly a frame costs many times what it costs on WebGPU, so the loop slows down on
// such a device instead of switching recognition off.
//
// Measured pacing (option `measuredPacing`, off by default): the wait between analyses comes
// from the time recent analyses took on this device, so a slow device spends a bounded share of
// its time on analysis. See `pacedIntervalMs`.

import { DRIVER_TICK_MS, READING_LINGER_MS } from "./frame-scheduler.js";
import type { ExecutionProvider } from "./providers.js";

export type AnalysisMode = "pointer" | "always-on" | "layout";

/** The modes a session runs. */
export type SessionMode = Exclude<AnalysisMode, "layout">;

/** The slow cadence on WebGPU, and before the execution provider is known. */
export const DEFAULT_ANALYZE_INTERVAL_MS = 1_000;
/** The slow cadence on WebAssembly. */
export const WASM_ANALYZE_INTERVAL_MS = 2_000;

/** The fast cadence on WebGPU, and before the execution provider is known. */
export const ACTIVE_ANALYZE_INTERVAL_MS = 500;
/** The fast cadence on WebAssembly. */
export const ACTIVE_WASM_ANALYZE_INTERVAL_MS = 1_000;

/** The slow interval for the recognizer's execution provider (null: not known yet). */
export function analyzeIntervalMs(ep: ExecutionProvider | null): number {
  return ep === "wasm" ? WASM_ANALYZE_INTERVAL_MS : DEFAULT_ANALYZE_INTERVAL_MS;
}

/** The fast interval for the recognizer's execution provider (null: not known yet). */
export function activeAnalyzeIntervalMs(ep: ExecutionProvider | null): number {
  return ep === "wasm" ? ACTIVE_WASM_ANALYZE_INTERVAL_MS : ACTIVE_ANALYZE_INTERVAL_MS;
}

/** The interval a scheduler is armed with for an execution provider in an analysis mode. In
 *  "layout" mode this is the pointer's fast cadence; the probe interval is the product's. */
export function cadenceMs(ep: ExecutionProvider | null, mode: AnalysisMode): number {
  return mode === "always-on" ? analyzeIntervalMs(ep) : activeAnalyzeIntervalMs(ep);
}

/** Whether this device runs the slower cadences. */
export function isSlowDevice(ep: ExecutionProvider | null): boolean {
  return ep === "wasm";
}

/** Measured pacing: the share of time spent analyzing, by default. */
export const MEASURED_PACING_SHARE = 0.25;
/** Measured pacing: the longest wait while the pointer is active. */
export const MEASURED_PACING_ACTIVE_CEILING_MS = 4_000;
/** Measured pacing: the longest wait in always-on mode. */
export const MEASURED_PACING_SLOW_CEILING_MS = 8_000;

/** Measured pacing: the longest wait while the pointer rests ("reading"). A name stops showing
 *  `hoverMaxAgeMs` after its frame and the reading state ends `READING_LINGER_MS` after that, so a
 *  longer wait would never come due and analysis would stop until the pointer moved. */
export function readingCeilingMs(hoverMaxAgeMs: number): number {
  return hoverMaxAgeMs + READING_LINGER_MS - DRIVER_TICK_MS;
}
/** Measured pacing: analyses measured before the measured wait applies. */
export const MEASURED_PACING_MIN_SAMPLES = 3;
/** Measured pacing: how many of the latest analyses the median is taken over. */
export const MEASURED_PACING_WINDOW = 5;

/** The `measuredPacing` option: `true` for the default share, or the share of time analysis may
 *  take, in (0, 1]. */
export type MeasuredPacingOption = boolean | { share?: number };

/** The share the option asks for, or null when pacing is off. Throws on a share outside (0, 1]. */
export function resolveMeasuredPacing(option: MeasuredPacingOption | undefined): number | null {
  if (option === undefined || option === false) return null;
  if (option !== true && (typeof option !== "object" || option === null)) {
    throw new RangeError("measuredPacing must be a boolean or an object with a share");
  }
  const share = option === true ? MEASURED_PACING_SHARE : (option.share ?? MEASURED_PACING_SHARE);
  if (!(share > 0 && share <= 1)) throw new RangeError("measuredPacing.share must be above 0 and at most 1");
  return share;
}

/** Which faces the geometric stage verifies: "all" (the default) or "focus", the faces at the
 *  pointer (`SessionOptions.geometricScope`). */
export type GeometricScope = "all" | "focus";

/** The scope a session runs. Throws on a value that is not a scope, and on "focus" outside
 *  pointer mode (it needs the pointer to say which faces to verify). */
export function resolveGeometricScope(scope: GeometricScope | undefined, mode: AnalysisMode | undefined): GeometricScope {
  if (scope === undefined || scope === "all") return "all";
  if (scope !== "focus") throw new RangeError('geometricScope must be "all" or "focus"');
  if (mode !== undefined && mode !== "pointer") {
    throw new RangeError(`geometricScope "focus" needs pointer mode, not ${JSON.stringify(mode)}: it verifies the faces at the pointer`);
  }
  return "focus";
}

/** The median of the last `MEASURED_PACING_WINDOW` values. */
function recentMedian(timesMs: readonly number[]): number {
  const sorted = timesMs.slice(-MEASURED_PACING_WINDOW).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The wait between analyses under measured pacing.
 * @param fixedMs Today's fixed interval for the mode and backend: the wait is never shorter, and
 *   it is the wait until `MEASURED_PACING_MIN_SAMPLES` analyses have been measured.
 * @param ceilingMs The longest wait: `MEASURED_PACING_ACTIVE_CEILING_MS` while the pointer is
 *   active, `readingCeilingMs` while it rests, `MEASURED_PACING_SLOW_CEILING_MS` in always-on mode.
 * @param timesMs Measured analysis times, oldest first.
 * @param share The share of time analysis may take.
 */
export function pacedIntervalMs(fixedMs: number, ceilingMs: number, timesMs: readonly number[], share: number): number {
  if (timesMs.length < MEASURED_PACING_MIN_SAMPLES) return fixedMs;
  return Math.max(fixedMs, Math.min(ceilingMs, recentMedian(timesMs) / share));
}

/** Learns the analysis time within one session (nothing is stored) and gives the waits. */
export class MeasuredPacer {
  private times: number[] = [];

  constructor(private readonly share: number) {}

  /** Record one analysis's measured time (the reply's `workerMs`); not a number: ignored. */
  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.times.push(ms);
    if (this.times.length > MEASURED_PACING_WINDOW) this.times.shift();
  }

  /** The wait in force: the fast cadence in pointer mode, the slow one in always-on mode. */
  intervalMs(ep: ExecutionProvider | null, mode: AnalysisMode): number {
    return mode === "always-on" ? this.slowMs(ep) : this.activeMs(ep);
  }

  /** The wait while the pointer rests on a showing tooltip, capped by `readingCeilingMs`. */
  readingMs(ep: ExecutionProvider | null, hoverMaxAgeMs: number): number {
    return pacedIntervalMs(analyzeIntervalMs(ep), readingCeilingMs(hoverMaxAgeMs), this.times, this.share);
  }

  /** The wait while the pointer is active. */
  activeMs(ep: ExecutionProvider | null): number {
    return pacedIntervalMs(activeAnalyzeIntervalMs(ep), MEASURED_PACING_ACTIVE_CEILING_MS, this.times, this.share);
  }

  /** The wait in always-on mode. */
  slowMs(ep: ExecutionProvider | null): number {
    return pacedIntervalMs(analyzeIntervalMs(ep), MEASURED_PACING_SLOW_CEILING_MS, this.times, this.share);
  }

  /** The least spacing between looks that keeps analysis within the share: the median of the
   *  measured times divided by the share, at most `MEASURED_PACING_ACTIVE_CEILING_MS`, with no fixed
   *  rate under it. It applies from the first measured analysis (0 before), because the looks it
   *  spaces (the playing relook, `FrameScheduler.setRelookSpacingMs`) have no fixed rate to fall
   *  back on. */
  spacingMs(): number {
    if (this.times.length === 0) return 0;
    return Math.min(MEASURED_PACING_ACTIVE_CEILING_MS, recentMedian(this.times) / this.share);
  }
}
