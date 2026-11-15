// SPDX-License-Identifier: Apache-2.0
// Old profiles: each file in test/fixtures/storage-profiles/ is the whole local extension storage of
// one real, older build of a product that uses the host. Both products' profiles must read
// correctly through the settings core and the switches.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createSettingsCore, DISMISSED_UPDATE_KEY, LAST_ATTEMPT_KEY, LAST_GOOD_KEY } from "../src/host/settings-core.js";
import { createSwitches, ENABLED_KEY, KEEP_CARD_KEY } from "../src/host/switches.js";
import { changeBus, memoryStorage } from "./support/host-storage.js";
import { schema } from "./support/host-settings-schema.js";

const DIR = join(__dirname, "fixtures", "storage-profiles");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

describe("old storage profiles", () => {
  it("are exactly two, one per product", () => expect(files).toHaveLength(2));

  describe.each(files)("%s", (file) => {
    const profile = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Record<string, unknown>;

    it("holds the host's keys in their frozen shapes", () => {
      const stored = profile[LAST_GOOD_KEY] as { raw?: unknown; fetchedAt?: unknown } | undefined;
      expect(stored, "settings.lastGood").toBeDefined();
      expect(typeof stored?.fetchedAt).toBe("number");
      expect(stored?.raw).toBeTypeOf("object");
      if (LAST_ATTEMPT_KEY in profile) expect(typeof profile[LAST_ATTEMPT_KEY]).toBe("number");
      if (DISMISSED_UPDATE_KEY in profile) expect(typeof profile[DISMISSED_UPDATE_KEY]).toBe("string");
      if ("cardSize" in profile) expect(typeof profile.cardSize).toBe("number");
      if ("cardLanguage" in profile) expect(typeof profile.cardLanguage).toBe("string");
      if ("details" in profile) expect(typeof profile.details).toBe("boolean");
      for (const key of [ENABLED_KEY, KEEP_CARD_KEY]) if (key in profile) expect(typeof profile[key]).toBe("boolean");
    });

    it("reads the last good copy through the settings core", async () => {
      // The profile's own copy is validated by the product's rules; here, by the host's test rules,
      // which accept any schemaVersion 1 file that names a date and `namesOnly`.
      const stored = profile[LAST_GOOD_KEY] as { raw: unknown; fetchedAt: number };
      const r = await createSettingsCore(schema(), memoryStorage(structuredClone(profile))).read();
      expect(r.origin).toBe("fetched");
      expect(r.fetchedAt).toBe(stored.fetchedAt);
      expect(r.settings).toEqual(stored.raw);
    });

    it("reads the switches as stored", async () => {
      const sw = createSwitches(memoryStorage(structuredClone(profile)), changeBus());
      expect(await sw.enabled()).toBe(profile[ENABLED_KEY] !== false);
      expect(await sw.keepCard()).toBe(profile[KEEP_CARD_KEY] !== false);
    });

    it("reads each switch as flipped from its default (both were exported switched off)", async () => {
      expect(profile[ENABLED_KEY]).toBe(false);
      expect(profile[KEEP_CARD_KEY]).toBe(false);
      const sw = createSwitches(memoryStorage(structuredClone(profile)), changeBus());
      expect(await sw.enabled()).toBe(false);
      expect(await sw.keepCard()).toBe(false);
    });
  });
});
