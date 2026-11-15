// SPDX-License-Identifier: Apache-2.0
// The host's settings core: the settings in effect, the hourly refresh, same-contents compare and
// the update notice. The cases come from the two extensions' own store, same-settings and update
// tests; the schema is a stand-in for a product's validation.
import { describe, expect, it } from "vitest";

import {
  compareVersions,
  createSettingsCore,
  DISMISSED_UPDATE_KEY,
  LAST_ATTEMPT_KEY,
  LAST_GOOD_KEY,
  SETTINGS_REFRESH_MS,
  updateNotice,
} from "../src/host/settings-core.js";
import { memoryStorage } from "./support/host-storage.js";
import { DEFAULT_RAW, schema, type TestSettings, URL_UNDER_TEST, validate } from "./support/host-settings-schema.js";

const json = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

function fetchReturning(...answers: Array<Response | Error>): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const a = answers.shift();
    if (!a) throw new Error("unexpected request");
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch & { urls: string[] };
  fn.urls = urls;
  return fn;
}

/** A newer settings file: the default, changed, with an update notice. */
const live = { ...DEFAULT_RAW, updatedAt: "2026-11-01T00:00:00Z", namesOnly: true, update: { latest: "0.2.0", url: "https://example.test/releases/tag/v0.2.0" } };

describe("the default", () => {
  it("is the validated built-in default", () => {
    expect(createSettingsCore(schema(), memoryStorage()).defaults()).toEqual(validate(DEFAULT_RAW).settings);
  });

  it("throws when the built-in default does not pass its own validation", () => {
    const bad = { ...schema(), defaultRaw: { schemaVersion: 2 } };
    expect(() => createSettingsCore(bad, memoryStorage()).defaults()).toThrow(/not valid/);
  });
});

describe("read", () => {
  it("uses the built-in default when nothing was ever fetched", async () => {
    const core = createSettingsCore(schema(), memoryStorage());
    const r = await core.read();
    expect(r.origin).toBe("default");
    expect(r.fetchedAt).toBeNull();
    expect(r.settings).toEqual(core.defaults());
  });

  it("uses the last good copy", async () => {
    const s = memoryStorage({ [LAST_GOOD_KEY]: { raw: live, fetchedAt: 5 } });
    const r = await createSettingsCore(schema(), s).read();
    expect(r.origin).toBe("fetched");
    expect(r.settings.namesOnly).toBe(true);
    expect(r.fetchedAt).toBe(5);
  });

  it("falls back to the default when the stored copy is no longer valid", async () => {
    const s = memoryStorage({ [LAST_GOOD_KEY]: { raw: { ...live, schemaVersion: 2 }, fetchedAt: 5 } });
    expect((await createSettingsCore(schema(), s).read()).origin).toBe("default");
  });

  it("falls back to the default when the stored copy has no time or is not an object", async () => {
    for (const stored of [{ raw: live }, { raw: live, fetchedAt: "5" }, "text", 7, null]) {
      const s = memoryStorage({ [LAST_GOOD_KEY]: stored });
      expect((await createSettingsCore(schema(), s).read()).origin).toBe("default");
    }
  });

  it("validates the stored copy again on every read", async () => {
    const s = memoryStorage({ [LAST_GOOD_KEY]: { raw: live, fetchedAt: 5 } });
    let calls = 0;
    const counting = { ...schema(), validate: (raw: unknown) => (calls++, validate(raw)) };
    const core = createSettingsCore(counting, s);
    await core.read();
    await core.read();
    expect(calls).toBe(2);
  });
});

describe("refresh", () => {
  it("fetches the schema's address and keeps a usable file", async () => {
    const s = memoryStorage();
    const f = fetchReturning(json(live));
    const core = createSettingsCore(schema(), s);
    const r = await core.refresh({ fetch: f, now: () => 1000, force: true });
    expect(r.kind).toBe("updated");
    expect(f.urls).toEqual([URL_UNDER_TEST]);
    expect(s.data[LAST_GOOD_KEY]).toEqual({ raw: live, fetchedAt: 1000 });
    expect((await core.read()).settings.update?.latest).toBe("0.2.0");
  });

  it("stores an unchanged file again, with the new time (open pages retry on that change)", async () => {
    const s = memoryStorage();
    const f = fetchReturning(json(live), json(live));
    const core = createSettingsCore(schema(), s);
    await core.refresh({ fetch: f, now: () => 1000, force: true });
    const r = await core.refresh({ fetch: f, now: () => 1000 + SETTINGS_REFRESH_MS, force: true });
    expect(r.kind).toBe("updated");
    expect(s.data[LAST_GOOD_KEY]).toEqual({ raw: live, fetchedAt: 1000 + SETTINGS_REFRESH_MS });
  });

  it("fetches nothing at all when the schema has no address", async () => {
    const s = memoryStorage();
    const f = fetchReturning(json(live));
    expect((await createSettingsCore(schema(null), s).refresh({ fetch: f, now: () => 1000, force: true })).kind).toBe("skipped");
    expect(f.urls).toEqual([]);
    expect(s.data).toEqual({});
  });

  it("fetches at most once an hour unless forced (start-up)", async () => {
    const f = fetchReturning(json(live), json(live), json(live));
    const core = createSettingsCore(schema(), memoryStorage());
    await core.refresh({ fetch: f, now: () => 0, force: true });
    expect((await core.refresh({ fetch: f, now: () => SETTINGS_REFRESH_MS - 1 })).kind).toBe("skipped");
    expect((await core.refresh({ fetch: f, now: () => SETTINGS_REFRESH_MS })).kind).toBe("updated");
    expect((await core.refresh({ fetch: f, now: () => SETTINGS_REFRESH_MS + 1, force: true })).kind).toBe("updated");
    expect(f.urls.length).toBe(3);
  });

  it("fetches when the clock has gone back past the last attempt", async () => {
    const s = memoryStorage({ [LAST_ATTEMPT_KEY]: 5_000_000 });
    const f = fetchReturning(json(live));
    expect((await createSettingsCore(schema(), s).refresh({ fetch: f, now: () => 1000 })).kind).toBe("updated");
  });

  it("records the attempt even when it fails, so a failing host is not hammered", async () => {
    const s = memoryStorage();
    const core = createSettingsCore(schema(), s);
    await core.refresh({ fetch: fetchReturning(new TypeError("offline")), now: () => 77, force: true });
    expect(s.data[LAST_ATTEMPT_KEY]).toBe(77);
    expect((await core.refresh({ fetch: fetchReturning(), now: () => 78 })).kind).toBe("skipped");
  });

  it("sends the request without credentials, a referrer or the cache", async () => {
    let init: RequestInit | undefined;
    const f = (async (_: RequestInfo | URL, i?: RequestInit) => ((init = i), json(live))) as typeof fetch;
    await createSettingsCore(schema(), memoryStorage()).refresh({ fetch: f, now: () => 1, force: true });
    expect(init).toMatchObject({ cache: "no-cache", credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it.each([
    ["unreachable", new TypeError("offline"), /unreachable/],
    ["non-2xx", json(live, 500), /HTTP 500/],
    ["malformed JSON", json("{ not json"), /malformed JSON/],
    ["schemaVersion 2", json({ ...live, schemaVersion: 2 }), /schemaVersion/],
    ["a required field missing", json({ schemaVersion: 1, namesOnly: false }), /updatedAt/],
  ])("keeps the last good copy when the file is %s", async (_, answer, reason) => {
    const s = memoryStorage({ [LAST_GOOD_KEY]: { raw: live, fetchedAt: 1 } });
    const core = createSettingsCore(schema(), s);
    const r = await core.refresh({ fetch: fetchReturning(answer), now: () => 2, force: true });
    expect(r.kind).toBe("kept");
    expect(r.kind === "kept" && r.reason).toMatch(reason);
    expect(s.data[LAST_GOOD_KEY]).toEqual({ raw: live, fetchedAt: 1 });
    expect((await core.read()).settings.namesOnly).toBe(true);
  });

  it("with no last good copy, a bad file leaves the built-in default in effect", async () => {
    const core = createSettingsCore(schema(), memoryStorage());
    await core.refresh({ fetch: fetchReturning(json("[]")), now: () => 2, force: true });
    expect((await core.read()).origin).toBe("default");
  });

  it("gives up on a request that does not answer", async () => {
    const hang = (async (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    const r = await createSettingsCore(schema(), memoryStorage()).refresh({ fetch: hang, now: () => 2, force: true, timeoutMs: 20 });
    expect(r.kind).toBe("kept");
  });
});

describe("same", () => {
  const same = createSettingsCore(schema(), memoryStorage()).same;
  const base = (): TestSettings => ({
    schemaVersion: 1,
    updatedAt: "2026-11-05T00:00:00Z",
    namesOnly: false,
    primary: { id: "art", template: "https://art.example/{art}" },
    fallbacks: [
      { id: "a", template: "https://a.example/{art}" },
      { id: "b", template: "https://b.example/{art}" },
    ],
    update: null,
    release: { id: "0123456789abcdef", minVersion: "0.3.0", files: ["x", "y"] },
    localized: { fr: { template: "https://fr.example/{file}", list: "https://fr.example/list.json", listSha256: "a".repeat(64) } },
  });

  it("is true for the same file read twice (two separate objects)", () => {
    const a = validate(JSON.parse(JSON.stringify(live))).settings!;
    const b = validate(JSON.parse(JSON.stringify(live))).settings!;
    expect(a).not.toBe(b);
    expect(same(a, b)).toBe(true);
  });

  it("ignores the order of keys, nested ones included", () => {
    const a = base();
    const b = Object.fromEntries(Object.entries(base()).reverse()) as unknown as TestSettings;
    b.release = { files: ["x", "y"], minVersion: "0.3.0", id: "0123456789abcdef" };
    expect(same(a, b)).toBe(true);
  });

  it("treats a key set to undefined as absent", () => {
    const a = base();
    delete a.release;
    expect(same(a, { ...a, release: undefined })).toBe(true);
  });

  it("tells null from absent, and false from absent", () => {
    const a = base();
    delete a.release;
    expect(same(a, { ...a, release: null })).toBe(false);
    expect(same(a, { ...a, release: false })).toBe(false);
  });

  it("sees a change anywhere: a flag, a nested value, the order of a list, the release", () => {
    expect(same(base(), { ...base(), namesOnly: true })).toBe(false);
    expect(same(base(), { ...base(), updatedAt: "2026-11-06T00:00:00Z" })).toBe(false);
    expect(same(base(), { ...base(), fallbacks: [...(base().fallbacks as unknown[])].reverse() })).toBe(false);
    expect(same(base(), { ...base(), localized: {} })).toBe(false);
    expect(same(base(), { ...base(), release: { id: "fedcba9876543210", minVersion: "0.3.0", files: ["x", "y"] } })).toBe(false);
    expect(same(base(), { ...base(), release: { id: "0123456789abcdef", minVersion: "0.3.0", files: ["y", "x"] } })).toBe(false);
    expect(same(base(), { ...base(), release: "0123456789abcdef" })).toBe(false);
  });

  it("does not mistake a string for the same characters as a number or an array", () => {
    expect(same({ ...base(), release: "1" }, { ...base(), release: 1 })).toBe(false);
    expect(same({ ...base(), release: ["a,b"] }, { ...base(), release: ["a", "b"] })).toBe(false);
    expect(same({ ...base(), release: {} }, { ...base(), release: [] })).toBe(false);
  });
});

describe("compareVersions", () => {
  it.each([
    ["0.1.0", "0.2.0", -1],
    ["0.10.0", "0.9.9", 1],
    ["1.0.0", "1.0.0", 0],
    ["1.0", "1.0.0", 0],
    ["1.0.0.256", "1.0.0", 1],
  ])("%s vs %s", (a, b, d) => expect(compareVersions(a, b)).toBe(d));
});

describe("updateNotice", () => {
  const update = { latest: "0.2.0", url: "https://example.test/releases" };
  it("shows nothing without the field", () => expect(updateNotice(null, "0.1.0", null)).toBeNull());
  it("shows the line when the running version is lower", () => expect(updateNotice(update, "0.1.0", null)).toEqual(update));
  it("shows nothing when the running version is the same or newer", () => {
    expect(updateNotice(update, "0.2.0", null)).toBeNull();
    expect(updateNotice(update, "0.3.0", null)).toBeNull();
  });
  it("shows nothing once dismissed for that version, and again for a newer one", () => {
    expect(updateNotice(update, "0.1.0", "0.2.0")).toBeNull();
    expect(updateNotice({ ...update, latest: "0.3.0" }, "0.1.0", "0.2.0")).not.toBeNull();
  });
  it("keeps its dismissal key", () => expect(DISMISSED_UPDATE_KEY).toBe("update.dismissed"));
});
