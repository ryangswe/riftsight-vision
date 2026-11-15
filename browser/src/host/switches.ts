// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): the two switches every product has, on and keep-card.
// Types and keys are frozen here.

import type { KeyValueStorage, StorageChange, StorageChanges } from "./settings-core.js";

export const ENABLED_KEY = "enabled";
export const KEEP_CARD_KEY = "keepCard";

export interface Switches {
  /** On unless stored `false`; a missing or unreadable value reads as on. */
  enabled(): Promise<boolean>;
  keepCard(): Promise<boolean>;
  /** Calls back for real flips only: a write of the same state calls nothing. Returns the stop. */
  watch(on: { enabled?(on: boolean): void; keepCard?(on: boolean): void }): () => void;
}

type Changes = Record<string, StorageChange | undefined>;

/** A stored value as the switch's state: anything but `false` is on. */
const isOn = (value: unknown): boolean => value !== false;

/** Whether a change turns the switch over; a missing value counts as on, so missing to true, a
 *  removed true and a same-state write are not flips. */
const flipped = (change: StorageChange | undefined): boolean => change !== undefined && isOn(change.newValue) !== isOn(change.oldValue);

export function createSwitches(storage: Pick<KeyValueStorage, "get">, changes: StorageChanges): Switches {
  // The change listener is attached before the read starts. A flip that arrives while the read is
  // pending is newer than the read's answer, so it wins.
  async function read(key: string): Promise<boolean> {
    let latest: boolean | undefined;
    const listener = (c: Changes, area: string) => {
      if (area === "local" && key in c) latest = isOn(c[key]?.newValue);
    };
    changes.addListener(listener);
    try {
      let stored: boolean;
      try {
        stored = isOn((await storage.get(key))[key]);
      } catch {
        stored = true;
      }
      return latest ?? stored;
    } finally {
      changes.removeListener(listener);
    }
  }

  return {
    enabled: () => read(ENABLED_KEY),
    keepCard: () => read(KEEP_CARD_KEY),
    watch(on) {
      const listener = (c: Changes, area: string) => {
        if (area !== "local") return;
        if (on.enabled && ENABLED_KEY in c && flipped(c[ENABLED_KEY])) on.enabled(isOn(c[ENABLED_KEY]?.newValue));
        if (on.keepCard && KEEP_CARD_KEY in c && flipped(c[KEEP_CARD_KEY])) on.keepCard(isOn(c[KEEP_CARD_KEY]?.newValue));
      };
      changes.addListener(listener);
      return () => changes.removeListener(listener);
    },
  };
}
