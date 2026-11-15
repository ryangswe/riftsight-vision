// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): the content realm. Types are frozen here; the body is not
// written yet.

import type { ProductConfig } from "./config.js";
import type { KeyValueStorage, StorageChanges } from "./settings-core.js";
import type { ViewAdapter } from "./view.js";

/** The time the shown card stays after the pointer leaves it. */
export const HIDE_DELAY_MS = 120;

export interface HostContentEnv {
  config: ProductConfig;
  win: Window;
  doc: Document;
  extensionUrl(path: string): string;
  storage: Pick<KeyValueStorage, "get">;
  storageChanges: StorageChanges;
  view: ViewAdapter;
  now?: () => number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export interface HostContent {
  /** The adapter's own inputs changed (card size, language): place the shown card again. */
  relayout(): void;
  readonly state: "off" | "waiting" | "owed" | "live" | "idle";
  stop(): void;
}

export function startHostContent(_env: HostContentEnv): HostContent {
  throw new Error("not implemented yet");
}
