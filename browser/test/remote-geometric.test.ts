// SPDX-License-Identifier: Apache-2.0
// The geometric stage under a remote release (src/remote/geometric.ts): the pointer's
// `geometric` field, rule G2's checks (flat and series index folders, and nothing else), and which
// bundled request a fallback uses.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { LoadRequest } from "../src/remote/choose.js";
import {
  checkRemoteGeometric,
  chosenBeforeFetch,
  fallbackRequest,
  GEO_MANIFEST_PATH,
  type GeometricField,
  geometricLine,
  parseGeometricPointer,
} from "../src/remote/geometric.js";

const ID = "0123456789abcdef";
const SETTINGS_URL = "https://cdn.example.test/config.json";
const GEO_URL = `https://cdn.example.test/vision/releases/${ID}/geometric.json`;
const MANIFEST_SHA = "b".repeat(64);
const sha = (bytes: ArrayBuffer | Uint8Array): string => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => sha(bytes);

/** A geometric.json naming `indexPath`, and a pointer field pinning its bytes. */
function fixture(indexPath: unknown, extra: Record<string, unknown> = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify({ seed: 0, index: { path: indexPath, sha256: "c".repeat(64) }, ...extra }));
  const release = { id: ID, geometric: { path: `vision/releases/${ID}/geometric.json`, sha256: sha(bytes), manifestSha256: MANIFEST_SHA } };
  return { bytes, release, field: parseGeometricPointer(release) };
}

function server(body: Uint8Array | null, status = 200) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    if (body === null) throw new TypeError("offline");
    return new Response(body as BodyInit, { status });
  }) as typeof fetch;
  return { fetchFn, requests };
}

const check = (field: GeometricField, fetchFn: typeof fetch, stageOn = true) => checkRemoteGeometric(field, stageOn, { fetch: fetchFn, sha256Hex, settingsUrl: SETTINGS_URL });

describe("parseGeometricPointer (G1)", () => {
  it("reads a well-formed field", () => {
    const { field } = fixture("https://cdn.example.test/vision/geo/fedcba9876543210/manifest.json");
    expect(field.kind).toBe("pointer");
  });
  it("is absent when the release has none", () => {
    expect(parseGeometricPointer({ id: ID })).toEqual({ kind: "absent" });
    expect(parseGeometricPointer({ id: ID, geometric: null })).toEqual({ kind: "absent" });
    expect(parseGeometricPointer(null)).toEqual({ kind: "absent" });
  });
  it.each([
    ["geometric", "x"],
    ["path", { path: `vision/releases/${"f".repeat(16)}/geometric.json`, sha256: "a".repeat(64), manifestSha256: MANIFEST_SHA }],
    ["path", { path: `vision/releases/${ID}/../geometric.json`, sha256: "a".repeat(64), manifestSha256: MANIFEST_SHA }],
    ["path", { path: `https://cdn.example.test/vision/releases/${ID}/geometric.json`, sha256: "a".repeat(64), manifestSha256: MANIFEST_SHA }],
    ["sha256", { path: `vision/releases/${ID}/geometric.json`, sha256: "A".repeat(64), manifestSha256: MANIFEST_SHA }],
    ["manifestSha256", { path: `vision/releases/${ID}/geometric.json`, sha256: "a".repeat(64) }],
  ])("is malformed (%s)", (key, geometric) => {
    expect(parseGeometricPointer({ id: ID, geometric })).toEqual({ kind: "malformed", key });
  });
});

describe("checkRemoteGeometric (G1, G2)", () => {
  it("accepts a flat index folder (manifest.json): the request's URL and pinned manifest", async () => {
    const f = fixture("https://cdn.example.test/vision/geo/fedcba9876543210/manifest.json");
    const s = server(f.bytes);
    expect(await check(f.field, s.fetchFn)).toEqual({ ok: true, url: GEO_URL, manifestSha256: MANIFEST_SHA });
    // From the settings host only, with no cookies or referrer.
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.url).toBe(GEO_URL);
    expect(s.requests[0]!.init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("accepts a series index folder (manifest-<16 hex>.json), and a path relative to geometric.json", async () => {
    const f = fixture("https://cdn.example.test/vision/geo/0123456789abcdef/manifest-89abcdef01234567.json");
    expect((await check(f.field, server(f.bytes).fetchFn)).ok).toBe(true);
    const r = fixture("../../geo/0123456789abcdef/manifest.json");
    expect((await check(r.field, server(r.bytes).fetchFn)).ok).toBe(true);
  });

  it.each([
    ["a third manifest shape", "https://cdn.example.test/vision/geo/0123456789abcdef/manifest-x.json"],
    ["a manifest outside /vision/geo/", "https://cdn.example.test/vision/releases/0123456789abcdef/manifest.json"],
    ["a folder that is not 16 hex", "https://cdn.example.test/vision/geo/series-one/manifest.json"],
    ["a nested folder", "https://cdn.example.test/vision/geo/0123456789abcdef/x/manifest.json"],
    ["another host", "https://other.example.org/vision/geo/0123456789abcdef/manifest.json"],
    ["plain http", "http://cdn.example.test/vision/geo/0123456789abcdef/manifest.json"],
    ["a query", "https://cdn.example.test/vision/geo/0123456789abcdef/manifest.json?v=1"],
    ["a fragment", "https://cdn.example.test/vision/geo/0123456789abcdef/manifest.json#x"],
    ["user info", "https://user@cdn.example.test/vision/geo/0123456789abcdef/manifest.json"],
    ["no path", 7],
  ])("turns the stage off for %s (geo-shape)", async (_, path) => {
    const f = fixture(path);
    expect(await check(f.field, server(f.bytes).fetchFn)).toEqual({ ok: false, reason: "geo-shape" });
  });

  it("turns the stage off for bytes that are not the pinned ones, or not JSON", async () => {
    const f = fixture("https://cdn.example.test/vision/geo/0123456789abcdef/manifest.json");
    expect(await check(f.field, server(new TextEncoder().encode("{}")).fetchFn)).toEqual({ ok: false, reason: "geo-sha" });
    const junk = new TextEncoder().encode("not json");
    const field: GeometricField = { kind: "pointer", geometric: { path: `vision/releases/${ID}/geometric.json`, sha256: sha(junk), manifestSha256: MANIFEST_SHA } };
    expect(await check(field, server(junk).fetchFn)).toEqual({ ok: false, reason: "geo-shape" });
  });

  it("turns the stage off when the file cannot be fetched", async () => {
    const f = fixture("https://cdn.example.test/vision/geo/0123456789abcdef/manifest.json");
    expect(await check(f.field, server(null).fetchFn)).toEqual({ ok: false, reason: "geo-unreachable" });
    expect(await check(f.field, server(f.bytes, 404).fetchFn)).toEqual({ ok: false, reason: "geo-unreachable" });
  });

  it("fetches nothing when the settings turn the stage off, or the pointer has no usable field", async () => {
    const f = fixture("https://cdn.example.test/vision/geo/0123456789abcdef/manifest.json");
    const s = server(f.bytes);
    expect(await check(f.field, s.fetchFn, false)).toEqual({ ok: false, reason: "geo-setting" });
    expect(await check({ kind: "absent" }, s.fetchFn)).toEqual({ ok: false, reason: "geo-absent" });
    expect(await check({ kind: "malformed", key: "sha256" }, s.fetchFn)).toEqual({ ok: false, reason: "geo-malformed:sha256" });
    expect(s.requests).toHaveLength(0);
  });

  it("the path rule is exactly the union of Addenda 3 and 4", () => {
    expect(GEO_MANIFEST_PATH.test("/vision/geo/fedcba9876543210/manifest.json")).toBe(true);
    expect(GEO_MANIFEST_PATH.test("/vision/geo/fedcba9876543210/manifest-0123456789abcdef.json")).toBe(true);
    expect(GEO_MANIFEST_PATH.test("/vision/geo/fedcba9876543210/manifest-0123456789ABCDEF.json")).toBe(false);
    expect(GEO_MANIFEST_PATH.test("/vision/geo/fedcba9876543210/shard-0.bin")).toBe(false);
  });

  it("logs the decision without page, video or card", () => {
    expect(geometricLine("ExampleGame", ID, { ok: false, reason: "geo-sha" })).toBe(`[ExampleGame] geometric source=off reason=geo-sha pointer=${ID}`);
    expect(geometricLine("ExampleGame", ID, { ok: true, url: GEO_URL, manifestSha256: MANIFEST_SHA })).toBe(`[ExampleGame] geometric source=remote reason=ok pointer=${ID} manifest=${"b".repeat(16)}`);
  });
});

describe("which bundled request a page uses", () => {
  const BUNDLED_PIN = "d".repeat(64);
  const bundled: LoadRequest = { kind: "load", releaseUrl: "chrome-extension://x/release/release.json", wasmPaths: "w/", geometricUrl: "chrome-extension://x/data/geometric.json", geometricManifestSha256: BUNDLED_PIN };
  const pointer = (manifestSha256: string): GeometricField => ({ kind: "pointer", geometric: { path: `vision/releases/${ID}/geometric.json`, sha256: "a".repeat(64), manifestSha256 } });

  it("rules 1-5 (nothing fetched) keep the bundled request, stage included", () => {
    for (const reason of ["absent", "version", "same-as-bundled", "malformed:id", "skipped:doc-sha"]) expect(chosenBeforeFetch(reason)).toBe(true);
    for (const reason of ["unreachable", "http-404", "doc-sha", "doc-shape", "unreachable:bank.json", "file-sha:catalog.json", "catalog-unreadable", "unexpected:x"]) expect(chosenBeforeFetch(reason)).toBe(false);
  });

  it("a fallback from a remote release loads the bundled release with the stage off (the remote index stays cached)", () => {
    const plain = fallbackRequest(bundled, pointer(MANIFEST_SHA));
    expect(plain).toEqual({ kind: "load", releaseUrl: bundled.releaseUrl, wasmPaths: "w/" });
    expect(fallbackRequest(bundled, { kind: "absent" })).toEqual(plain);
  });

  it("unless the pointer's index is the bundled one", () => {
    expect(fallbackRequest(bundled, pointer(BUNDLED_PIN))).toBe(bundled);
  });
});
