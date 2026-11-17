// SPDX-License-Identifier: Apache-2.0
// A small settings schema for the host's tests: what a product's own validation stands in for.
import type { SettingsSchema } from "../../src/host/settings-core.js";

export interface TestSettings {
  schemaVersion: 1;
  updatedAt: string;
  namesOnly: boolean;
  update?: { latest: string; url: string } | null;
  [extra: string]: unknown;
}

export const DEFAULT_RAW = { schemaVersion: 1, updatedAt: "2026-10-01T00:00:00Z", namesOnly: false, update: null };
export const URL_UNDER_TEST = "https://settings.example/config.json";

/** Accepts schemaVersion 1 with a string `updatedAt` and a boolean `namesOnly`; refuses the rest. */
export function validate(raw: unknown): { settings: TestSettings | null; problems: string[] } {
  const problems: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { settings: null, problems: ["not an object"] };
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (typeof r.updatedAt !== "string") problems.push("updatedAt must be a string");
  if (typeof r.namesOnly !== "boolean") problems.push("namesOnly must be a boolean");
  return problems.length ? { settings: null, problems } : { settings: structuredClone(r) as TestSettings, problems };
}

export const schema = (url: string | null = URL_UNDER_TEST): SettingsSchema<TestSettings> => ({ validate, defaultRaw: DEFAULT_RAW, url });
