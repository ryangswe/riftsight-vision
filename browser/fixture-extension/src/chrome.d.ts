// SPDX-License-Identifier: Apache-2.0
// The few extension APIs the fixture uses, declared here so that it needs no extra type package.

type StorageChange = { oldValue?: unknown; newValue?: unknown };
type StorageListener = (changes: Record<string, StorageChange | undefined>, area: string) => void;

declare const chrome: {
  runtime: {
    getURL(path: string): string;
    onMessage: { addListener(listener: (message: unknown) => void): void };
  };
  storage: {
    local: {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    onChanged: { addListener(listener: StorageListener): void; removeListener(listener: StorageListener): void };
  };
};
