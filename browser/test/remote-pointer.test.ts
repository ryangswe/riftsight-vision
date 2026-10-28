// SPDX-License-Identifier: Apache-2.0
// The remote release pointer: the field's rules, the decision before any fetch (rules 1-5), the
// skip-list (rule 2.1), and what a worker refusal means for it (rule 10).
import { describe, expect, it } from "vitest";

import { clearStaleSkip, compareVersions, decide, parsePointer, readSkip, refusalRecorded, SKIP_KEY, SKIP_TTL_MS, type SkipStorage, writeSkip } from "../src/remote/pointer.js";

const ID = "0123456789abcdef";
const SHA = "a".repeat(64);
const ok = { id: ID, path: `vision/releases/${ID}/release.json`, sha256: SHA, minimumExtensionVersion: "0.3.0" };

function memory(initial: Record<string, unknown> = {}): SkipStorage & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: async (k: string) => (k in data ? { [k]: data[k] } : {}),
    set: async (items: Record<string, unknown>) => void Object.assign(data, items),
    remove: async (k: string) => void delete data[k],
  };
}

describe("compareVersions", () => {
  it.each([
    ["0.1.0", "0.2.0", -1],
    ["0.10.0", "0.9.9", 1],
    ["1.0.0", "1.0.0", 0],
    ["1.0", "1.0.0", 0],
    ["1.0.0.1", "1.0.0", 1],
  ])("%s vs %s", (a, b, d) => expect(compareVersions(a, b)).toBe(d));
});

describe("parsePointer", () => {
  it("reads a well-formed field, with or without a maximum; unknown keys and `geometric` are ignored", () => {
    expect(parsePointer(ok)).toEqual({ kind: "pointer", pointer: { ...ok, maximumExtensionVersion: null } });
    expect(parsePointer({ ...ok, maximumExtensionVersion: "0.5.0", geometric: { path: "x" }, later: 1 })).toEqual({
      kind: "pointer",
      pointer: { ...ok, maximumExtensionVersion: "0.5.0" },
    });
  });

  it("treats null and a missing field as absent", () => {
    expect(parsePointer(null)).toEqual({ kind: "absent" });
    expect(parsePointer(undefined)).toEqual({ kind: "absent" });
  });

  it.each([
    ["not an object", [ok], "release"],
    ["an id that is not 16 hex", { ...ok, id: "0123456789ABCDEF" }, "id"],
    ["another folder", { ...ok, path: "vision/releases/ffffffffffffffff/release.json" }, "path"],
    ["a path with ..", { ...ok, path: `vision/releases/${ID}/../x/release.json` }, "path"],
    ["another host", { ...ok, path: `https://evil.example/vision/releases/${ID}/release.json` }, "path"],
    ["a query", { ...ok, path: `vision/releases/${ID}/release.json?x=1` }, "path"],
    ["an encoded dot", { ...ok, path: `vision/releases/${ID}/%2e%2e/release.json` }, "path"],
    ["a short sha256", { ...ok, sha256: "abc" }, "sha256"],
    ["no minimum version", { id: ok.id, path: ok.path, sha256: ok.sha256 }, "minimumExtensionVersion"],
    ["a malformed maximum", { ...ok, maximumExtensionVersion: "1.0" }, "maximumExtensionVersion"],
  ])("refuses %s", (_, raw, key) => {
    expect(parsePointer(raw)).toEqual({ kind: "malformed", key });
  });
});

describe("decide (rules 1-5)", () => {
  const pointer = (over = {}) => parsePointer({ ...ok, ...over });
  const base = { running: "0.3.0", bundledId: "ffffffffffffffff", skip: null };

  it("1: no field is the bundled release", () => {
    expect(decide({ ...base, field: { kind: "absent" } })).toEqual({ source: "bundled", reason: "absent", pointer: null });
  });
  it("2: a malformed field is the bundled release, with the key", () => {
    expect(decide({ ...base, field: parsePointer({ ...ok, id: "x" }) })).toMatchObject({ source: "bundled", reason: "malformed:id" });
  });
  it("3: a version below the minimum, or at or above the maximum, is the bundled release", () => {
    expect(decide({ ...base, running: "0.2.1", field: pointer() })).toMatchObject({ source: "bundled", reason: "version" });
    expect(decide({ ...base, running: "0.5.0", field: pointer({ maximumExtensionVersion: "0.5.0" }) })).toMatchObject({ source: "bundled", reason: "version" });
    expect(decide({ ...base, running: "0.4.9", field: pointer({ maximumExtensionVersion: "0.5.0" }) })).toMatchObject({ source: "remote" });
  });
  it("4: the bundled id downloads nothing", () => {
    expect(decide({ ...base, bundledId: ID, field: pointer() })).toMatchObject({ source: "bundled", reason: "same-as-bundled" });
  });
  it("5: a skip entry for the same (id, sha256) is the bundled release; another sha256 is tried", () => {
    const skip = { id: ID, sha256: SHA, reason: "doc-sha", at: 0 };
    expect(decide({ ...base, skip, field: pointer() })).toMatchObject({ source: "bundled", reason: "skipped:doc-sha" });
    expect(decide({ ...base, skip: { ...skip, sha256: "b".repeat(64) }, field: pointer() })).toMatchObject({ source: "remote" });
  });
});

describe("the skip-list (rule 2.1)", () => {
  it("keeps an entry for 24 h, then deletes it on read; a malformed or future entry is deleted too", async () => {
    const s = memory();
    await writeSkip(s, { id: ID, sha256: SHA, reason: "doc-sha", at: 1000 });
    expect(await readSkip(s, 1000 + SKIP_TTL_MS - 1)).toMatchObject({ id: ID });
    expect(await readSkip(s, 1000 + SKIP_TTL_MS)).toBeNull();
    expect(SKIP_KEY in s.data).toBe(false);
    const m = memory({ [SKIP_KEY]: { id: 3 } });
    expect(await readSkip(m, 0)).toBeNull();
    expect(SKIP_KEY in m.data).toBe(false);
    const f = memory({ [SKIP_KEY]: { id: ID, sha256: SHA, reason: "x", at: 5000 } });
    expect(await readSkip(f, 1000)).toBeNull();
  });

  it("is cleared when the field goes, or names another (id, sha256): a later rollback to it is retried", async () => {
    const entry = { id: ID, sha256: SHA, reason: "doc-sha", at: 0 };
    const s = memory({ [SKIP_KEY]: entry });
    expect(await clearStaleSkip(s, parsePointer(ok), entry)).toEqual(entry);
    expect(await clearStaleSkip(s, parsePointer({ ...ok, sha256: "b".repeat(64) }), entry)).toBeNull();
    expect(SKIP_KEY in s.data).toBe(false);
    const t = memory({ [SKIP_KEY]: entry });
    expect(await clearStaleSkip(t, { kind: "absent" }, entry)).toBeNull();
  });

  it("records a worker refusal only before 'preparing', never the catch-all or the frame's own errors (rule 10, A3)", () => {
    expect(refusalRecorded("bank: sha256 of bank.json does not match the release", false)).toBe(true);
    expect(refusalRecorded("detector: the model did not initialize", true)).toBe(false);
    expect(refusalRecorded("unexpected: TypeError: x", false)).toBe(false);
    expect(refusalRecorded("the worker did not start (boom)", false)).toBe(false);
    expect(refusalRecorded("unexpected error while loading (x)", false)).toBe(false);
  });
});
