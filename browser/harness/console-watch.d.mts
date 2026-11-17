// SPDX-License-Identifier: Apache-2.0
// Types of console-watch.mjs, for test/console-watch.test.ts.
export function logProblem(text: unknown): "policy" | "origin" | null;
export function watchConsole(browser: unknown, sinks: { policy: unknown[]; origin: unknown[] }): void;
