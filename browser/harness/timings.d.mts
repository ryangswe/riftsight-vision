// SPDX-License-Identifier: Apache-2.0
export interface TimingMargin {
  factor?: number;
  slackMs?: number;
}
export interface TimingComparison {
  compared: string[];
  slower: Array<{ key: string; saved: number; now: number; limit: number }>;
  onlySaved: string[];
  onlyNow: string[];
}
export const TIMING_DEFAULTS: { factor: number; slackMs: number };
export const REPORTED_ONLY: string[];
export function timingsOf(counts: Record<string, any>): Record<string, number>;
export function compareTimings(saved: Record<string, number>, now: Record<string, number>, margin?: TimingMargin): TimingComparison;
export function timingsFileProblems(doc: unknown): string[];
export function artAfterShownOf(timings: unknown, cardIds: Record<string, string>): Record<string, number | null>;
export function prefetchedPaths(prefetched: unknown): string[] | null;
