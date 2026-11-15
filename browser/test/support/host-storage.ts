// SPDX-License-Identifier: Apache-2.0
// Stand-ins for chrome.storage.local and chrome.storage.onChanged, for the host's settings tests.
import type { KeyValueStorage, StorageChange, StorageChanges } from "../../src/host/settings-core.js";

export type MemoryStorage = KeyValueStorage & { data: Record<string, unknown> };

export function memoryStorage(data: Record<string, unknown> = {}): MemoryStorage {
  return {
    data,
    async get(keys: string | string[]) {
      const out: Record<string, unknown> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, structuredClone(items));
    },
  };
}

export type ChangeBus = StorageChanges & {
  emit(changes: Record<string, StorageChange | undefined>, area?: string): void;
  listeners: number;
};

export function changeBus(): ChangeBus {
  const fns = new Set<(changes: Record<string, StorageChange | undefined>, area: string) => void>();
  return {
    addListener: (fn) => void fns.add(fn),
    removeListener: (fn) => void fns.delete(fn),
    emit: (changes, area = "local") => {
      for (const fn of [...fns]) fn(changes, area);
    },
    get listeners() {
      return fns.size;
    },
  };
}
