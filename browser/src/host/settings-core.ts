// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): the settings store, one per product. Types and keys are
// frozen here.

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

/** The value as JSON with every object's keys in sorted order, so key order never matters. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function createSettingsCore<S>(schema: SettingsSchema<S>, storage: KeyValueStorage): SettingsCore<S> {
  const defaults = (): S => {
    const { settings } = schema.validate(schema.defaultRaw);
    if (!settings) throw new Error("createSettingsCore: the schema's default settings do not validate");
    return settings;
  };

  async function read(): Promise<EffectiveSettings<S>> {
    const stored = (await storage.get(LAST_GOOD_KEY))[LAST_GOOD_KEY] as { raw?: unknown; fetchedAt?: unknown } | undefined;
    if (stored && typeof stored === "object" && typeof stored.fetchedAt === "number") {
      // Validated again on every read: a copy stored by an older version is held to today's rules.
      const { settings } = schema.validate(stored.raw);
      if (settings) return { settings, origin: "fetched", fetchedAt: stored.fetchedAt };
    }
    return { settings: defaults(), origin: "default", fetchedAt: null };
  }

  async function refresh(options: { fetch: typeof fetch; now: () => number; force?: boolean; timeoutMs?: number }): Promise<RefreshOutcome> {
    const url = schema.url;
    // A build with no settings address uses its bundled copy only, and never fetches.
    if (url === null) return { kind: "skipped" };
    const now = options.now();
    if (!options.force) {
      const last = (await storage.get(LAST_ATTEMPT_KEY))[LAST_ATTEMPT_KEY];
      if (typeof last === "number" && now - last < SETTINGS_REFRESH_MS && now >= last) return { kind: "skipped" };
    }
    // The attempt is recorded before the request, so a burst of callers makes one request.
    await storage.set({ [LAST_ATTEMPT_KEY]: now });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    let raw: unknown;
    try {
      const response = await options.fetch(url, {
        signal: controller.signal,
        cache: "no-cache",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) return { kind: "kept", reason: `HTTP ${response.status}` };
      raw = JSON.parse(await response.text());
    } catch (error) {
      return { kind: "kept", reason: error instanceof SyntaxError ? "malformed JSON" : `unreachable (${String(error)})` };
    } finally {
      clearTimeout(timer);
    }
    const { settings, problems } = schema.validate(raw);
    if (!settings) return { kind: "kept", reason: problems.join("; ") };
    // Stored even when the file has not changed: the new `fetchedAt` tells open pages that the
    // settings were read again. They compare the contents themselves (`same`).
    await storage.set({ [LAST_GOOD_KEY]: { raw, fetchedAt: options.now() } });
    return { kind: "updated", problems };
  }

  return { defaults, read, refresh, same: (a, b) => a === b || canonical(a) === canonical(b) };
}

/** Compare two `x.y.z` versions (a manifest may also say `x.y` or `x.y.z.w`); missing parts are 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The notice to show, or null: none named, not newer than the running version, or dismissed. */
export function updateNotice<U extends { latest: string }>(update: U | null, running: string, dismissed: string | null): U | null {
  if (!update) return null;
  if (compareVersions(running, update.latest) >= 0) return null;
  if (dismissed !== null && compareVersions(dismissed, update.latest) >= 0) return null;
  return update;
}
