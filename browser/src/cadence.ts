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
