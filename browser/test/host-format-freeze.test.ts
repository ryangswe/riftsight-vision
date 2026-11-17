// SPDX-License-Identifier: Apache-2.0
// The stored format is frozen: a build that changes a key name or a value's shape would strand the
// choices already stored in an installed browser. Every key and shape the host writes or reads is
// pinned here; changing one is a break that needs a migration.
import { describe, expect, it } from "vitest";

import { createSettingsCore, DISMISSED_UPDATE_KEY, LAST_ATTEMPT_KEY, LAST_GOOD_KEY, SETTINGS_REFRESH_MS } from "../src/host/settings-core.js";
import { createSwitches, ENABLED_KEY, KEEP_CARD_KEY } from "../src/host/switches.js";
import { changeBus, memoryStorage } from "./support/host-storage.js";
import { DEFAULT_RAW, schema, URL_UNDER_TEST } from "./support/host-settings-schema.js";

describe("the stored format", () => {
  it("keeps the key names", () => {
    expect([ENABLED_KEY, KEEP_CARD_KEY, LAST_GOOD_KEY, LAST_ATTEMPT_KEY, DISMISSED_UPDATE_KEY]).toEqual([
      "enabled",
      "keepCard",
      "settings.lastGood",
      "settings.lastAttemptAt",
      "update.dismissed",
    ]);
  });

  it("keeps the refresh interval at one hour", () => expect(SETTINGS_REFRESH_MS).toBe(3_600_000));

  it("writes exactly two keys on a refresh: the attempt time and the file with its time", async () => {
    const s = memoryStorage();
    const body = { ...DEFAULT_RAW, updatedAt: "2026-11-01T00:00:00Z" };
    const f = (async () => new Response(JSON.stringify(body))) as typeof fetch;
    await createSettingsCore(schema(), s).refresh({ fetch: f, now: () => 1234, force: true });
    expect(Object.keys(s.data).sort()).toEqual(["settings.lastAttemptAt", "settings.lastGood"]);
    expect(s.data).toEqual({ "settings.lastAttemptAt": 1234, "settings.lastGood": { raw: body, fetchedAt: 1234 } });
    expect(URL_UNDER_TEST).toMatch(/^https:/);
  });

  it("reads the switches from plain booleans under their keys, and writes none", async () => {
    const s = memoryStorage({ enabled: false, keepCard: false });
    const sw = createSwitches(s, changeBus());
    expect([await sw.enabled(), await sw.keepCard()]).toEqual([false, false]);
    expect(s.data).toEqual({ enabled: false, keepCard: false });
  });

  it("reads the settings copy as an object with `raw` and a numeric `fetchedAt`", async () => {
    const s = memoryStorage({ "settings.lastGood": { raw: DEFAULT_RAW, fetchedAt: 42 } });
    expect((await createSettingsCore(schema(), s).read()).fetchedAt).toBe(42);
  });
});
