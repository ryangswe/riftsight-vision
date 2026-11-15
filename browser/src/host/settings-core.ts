// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): the settings store, one per product. Types and keys are
// frozen here; the bodies that are not written yet throw.

export interface KeyValueStorage {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
export type StorageChange = { oldValue?: unknown; newValue?: unknown };
export interface StorageChanges {
  addListener(fn: (changes: Record<string, StorageChange | undefined>, area: string) => void): void;
  removeListener(fn: (changes: Record<string, StorageChange | undefined>, area: string) => void): void;
}

export const LAST_GOOD_KEY = "settings.lastGood";
export const LAST_ATTEMPT_KEY = "settings.lastAttemptAt";
export const DISMISSED_UPDATE_KEY = "update.dismissed";
export const SETTINGS_REFRESH_MS = 3_600_000;

export interface SettingsSchema<S> {
  validate(raw: unknown): { settings: S | null; problems: string[] };
  /** The built-in default as raw JSON; it must pass `validate`. */
  defaultRaw: unknown;
  /** The settings file's address; null: nothing is ever fetched. */
  url: string | null;
}
export interface EffectiveSettings<S> {
  settings: S;
  origin: "fetched" | "default";
  fetchedAt: number | null;
}
export type RefreshOutcome = { kind: "skipped" } | { kind: "updated"; problems: string[] } | { kind: "kept"; reason: string };
export interface SettingsCore<S> {
  defaults(): S;
  /** The last good copy, validated again on every read; else the default. */
  read(): Promise<EffectiveSettings<S>>;
  refresh(options: { fetch: typeof fetch; now: () => number; force?: boolean; timeoutMs?: number }): Promise<RefreshOutcome>;
  /** Same contents, whatever the key order: an hourly re-store with a new fetchedAt is not a change. */
  same(a: S, b: S): boolean;
}

export function createSettingsCore<S>(_schema: SettingsSchema<S>, _storage: KeyValueStorage): SettingsCore<S> {
  throw new Error("not implemented yet");
}

export function compareVersions(_a: string, _b: string): number {
  throw new Error("not implemented yet");
}

export function updateNotice<U extends { latest: string }>(_update: U | null, _running: string, _dismissed: string | null): U | null {
  throw new Error("not implemented yet");
}
