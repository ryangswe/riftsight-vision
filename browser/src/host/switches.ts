// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): the two switches every product has, on and keep-card.
// Types and keys are frozen here; the bodies that are not written yet throw.

import type { KeyValueStorage, StorageChanges } from "./settings-core.js";

export const ENABLED_KEY = "enabled";
export const KEEP_CARD_KEY = "keepCard";

export interface Switches {
  /** On unless stored `false`; a missing or unreadable value reads as on. */
  enabled(): Promise<boolean>;
  keepCard(): Promise<boolean>;
  /** Calls back for real flips only: a write of the same state calls nothing. Returns the stop. */
  watch(on: { enabled?(on: boolean): void; keepCard?(on: boolean): void }): () => void;
}

export function createSwitches(_storage: Pick<KeyValueStorage, "get">, _changes: StorageChanges): Switches {
  throw new Error("not implemented yet");
}
