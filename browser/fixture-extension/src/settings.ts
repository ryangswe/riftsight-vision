// SPDX-License-Identifier: Apache-2.0
// The toy settings file: a version and a date, nothing else. It exists so that the background
// refreshes a file from the settings host, as a product does, and the pages read the last good copy.

import type { SettingsSchema } from "@cardvision/host-settings";

import { SETTINGS_URL } from "./config.js";

export interface ToySettings {
  updatedAt: string;
}

export const SCHEMA: SettingsSchema<ToySettings> = {
  validate(raw) {
    const doc = raw as { schemaVersion?: unknown; updatedAt?: unknown } | null;
    if (doc === null || typeof doc !== "object") return { settings: null, problems: ["the settings are not an object"] };
    if (doc.schemaVersion !== 1) return { settings: null, problems: ["schemaVersion is not 1"] };
    if (typeof doc.updatedAt !== "string") return { settings: null, problems: ["updatedAt is not a text"] };
    return { settings: { updatedAt: doc.updatedAt }, problems: [] };
  },
  defaultRaw: { schemaVersion: 1, updatedAt: "2026-01-01T00:00:00Z" },
  url: SETTINGS_URL,
};
