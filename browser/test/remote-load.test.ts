// SPDX-License-Identifier: Apache-2.0
// Fetching and checking a remote release (rules 6-9b, 2.2 file reuse, 2.3 stalls).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DOCUMENT_MAX_BYTES, loadRemoteRelease, type RemoteLoadDeps } from "../src/remote/remote-load.js";
import type { ReleasePointer } from "../src/remote/pointer.js";

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer | Uint8Array) => createHash("sha256").update(Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b))).digest("hex");

const MODELS = { "detector.onnx": enc("detector-bytes"), "recognizer.onnx": enc("recognizer-bytes") };
const OLD = { "bank.json": enc('{"old":1}'), "identity-groups.json": enc('{"g":1}'), "catalog.json": enc('{"cards":[]}') };
const NEW = { "bank.json": enc('{"new":2}'), "identity-groups.json": enc('{"g":2}'), "catalog.json": enc('{"cards":[{"id":"1","name":"A","art":null}]}') };
const ref = (path: string, b: Uint8Array) => ({ path, sha256: hex(b), bytes: b.byteLength });
const docFor = (id: string, files: Record<string, Uint8Array>) => ({
  id,
  detector: ref("detector.onnx", files["detector.onnx"]!),
  recognizer: ref("recognizer.onnx", files["recognizer.onnx"]!),
  bank: ref("bank.json", files["bank.json"]!),
  identity: { groups: ref("identity-groups.json", files["identity-groups.json"]!) },
  catalog: ref("catalog.json", files["catalog.json"]!),
});
const ID = "0123456789abcdef";
const BUNDLED = enc(JSON.stringify(docFor("ffffffffffffffff", { ...MODELS, ...OLD })));
const REMOTE = { ...MODELS, ...NEW };
const DOC = enc(JSON.stringify(docFor(ID, REMOTE)));
const pointer: ReleasePointer = { id: ID, path: `vision/releases/${ID}/release.json`, sha256: hex(DOC), minimumExtensionVersion: "0.3.0", maximumExtensionVersion: null };
const BASE = "https://cdn.test/";

type Route = (init: RequestInit, n: number) => Response | Promise<Response> | "network";
function server(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const counts: Record<string, number> = {};
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    counts[url] = (counts[url] ?? 0) + 1;
    const route = routes[url];
    if (!route) return new Response("nope", { status: 404 });
    const r = await route(init, counts[url]!);
    if (r === "network") throw new TypeError("Failed to fetch");
    return r;
  }) as typeof globalThis.fetch;
  return { fetch, calls, counts };
}
const body = (b: Uint8Array) => () => new Response(b as unknown as BodyInit);
function defaultRoutes(): Record<string, Route> {
  const r: Record<string, Route> = {
    [`${BASE}vision/releases/${ID}/release.json`]: body(DOC),
    "ext://release/release.json": body(BUNDLED),
  };
  for (const [name, b] of Object.entries({ ...MODELS, ...OLD })) r[`ext://release/${name}`] = body(b);
  for (const [name, b] of Object.entries(REMOTE)) r[`${BASE}vision/releases/${ID}/${name}`] = body(b);
  return r;
}
const deps = (fetch: typeof globalThis.fetch, over: Partial<RemoteLoadDeps> = {}): RemoteLoadDeps => ({
  fetch,
  sha256Hex: async (b) => hex(b),
  settingsUrl: `${BASE}config.json`,
  extensionUrl: (p) => `ext://${p}`,
  ...over,
});

describe("loadRemoteRelease", () => {
  it("reuses the bundled models and downloads only the bank, groups and catalog (a card-only update)", async () => {
    const s = server(defaultRoutes());
    let announced = 0;
    const r = await loadRemoteRelease(pointer, deps(s.fetch, { onDownloading: () => (announced += 1) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reused).toBe(2);
    expect(Object.keys(r.files).sort()).toEqual(["bank.json", "catalog.json", "detector.onnx", "identity-groups.json", "recognizer.onnx", "release.json"]);
    expect(hex(new Uint8Array(await r.files["detector.onnx"]!.arrayBuffer()))).toBe(hex(MODELS["detector.onnx"]));
    expect(await r.catalog.text()).toBe(new TextDecoder().decode(NEW["catalog.json"]));
    const remote = s.calls.filter((c) => c.url.startsWith(BASE)).map((c) => c.url.split("/").pop());
    expect(remote).toEqual(["release.json", "bank.json", "identity-groups.json", "catalog.json"]);
    expect(r.downloaded).toBe(DOC.byteLength + NEW["bank.json"].byteLength + NEW["identity-groups.json"].byteLength + NEW["catalog.json"].byteLength);
    expect(announced).toBe(1);
    for (const c of s.calls.filter((c) => c.url.startsWith(BASE))) {
      expect(c.init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", cache: "default" });
    }
  });

  it("downloads every file when the models changed (a retrain)", async () => {
    const routes = defaultRoutes();
    routes["ext://release/release.json"] = body(enc(JSON.stringify(docFor("ffffffffffffffff", { "detector.onnx": enc("old-d"), "recognizer.onnx": enc("old-r"), ...OLD }))));
    const r = await loadRemoteRelease(pointer, deps(server(routes).fetch));
    expect(r).toMatchObject({ ok: true, reused: 0 });
  });

  it.each([
    ["6: the document unreachable", { doc: (): "network" => "network" }, "unreachable"],
    ["6: the document non-2xx", { doc: () => new Response("x", { status: 503 }) }, "http-503"],
    ["8: the document not JSON", { doc: () => new Response("not json"), sha: true }, "doc-shape"],
  ])("%s → bundled", async (_, over, reason) => {
    const routes = defaultRoutes();
    routes[`${BASE}vision/releases/${ID}/release.json`] = over.doc as Route;
    const p = "sha" in over && over.sha ? { ...pointer, sha256: hex(enc("not json")) } : pointer;
    const r = await loadRemoteRelease(p, deps(server(routes).fetch));
    expect(r).toMatchObject({ ok: false, reason, record: reason === "doc-shape" });
  });

  it("6: a document that takes longer than its deadline is unreachable, not recorded", async () => {
    const routes = defaultRoutes();
    routes[`${BASE}vision/releases/${ID}/release.json`] = (init) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const r = await loadRemoteRelease(pointer, deps(server(routes).fetch, { documentTimeoutMs: 20 }));
    expect(r).toMatchObject({ ok: false, reason: "unreachable", record: false });
  });

  it("7: a document whose sha256 is wrong is fetched once more past the cache; still wrong, it is recorded", async () => {
    const routes = defaultRoutes();
    routes[`${BASE}vision/releases/${ID}/release.json`] = body(enc("{}"));
    const s = server(routes);
    expect(await loadRemoteRelease(pointer, deps(s.fetch))).toMatchObject({ ok: false, reason: "doc-sha", record: true });
    const docCalls = s.calls.filter((c) => c.url.endsWith("release.json") && c.url.startsWith(BASE));
    expect(docCalls.map((c) => c.init.cache)).toEqual(["default", "reload"]);
  });

  it("7: a stale cache entry corrected by the reload is fine", async () => {
    const routes = defaultRoutes();
    routes[`${BASE}vision/releases/${ID}/release.json`] = (_, n) => new Response(n === 1 ? enc("{}") : DOC);
    expect(await loadRemoteRelease(pointer, deps(server(routes).fetch))).toMatchObject({ ok: true });
  });

  it.each([
    ["another id", { ...JSON.parse(new TextDecoder().decode(DOC)), id: "ffffffffffffffff" }],
    ["a path with a folder", { ...JSON.parse(new TextDecoder().decode(DOC)), bank: { ...docFor(ID, REMOTE).bank, path: "sub/bank.json" } }],
    ["a path with ..", { ...JSON.parse(new TextDecoder().decode(DOC)), bank: { ...docFor(ID, REMOTE).bank, path: "../bank.json" } }],
    ["a missing pin", { ...JSON.parse(new TextDecoder().decode(DOC)), catalog: undefined }],
  ])("8: a document with %s is recorded", async (_, doc) => {
    const bytes = enc(JSON.stringify(doc));
    const routes = defaultRoutes();
    routes[`${BASE}vision/releases/${ID}/release.json`] = body(bytes);
    const r = await loadRemoteRelease({ ...pointer, sha256: hex(bytes) }, deps(server(routes).fetch));
    expect(r).toMatchObject({ ok: false, reason: "doc-shape", record: true });
  });

  it("9: a file that fails to download is unreachable, not recorded", async () => {
    const routes = defaultRoutes();
    routes[`${BASE}vision/releases/${ID}/bank.json`] = () => new Response("x", { status: 500 });
    expect(await loadRemoteRelease(pointer, deps(server(routes).fetch))).toMatchObject({ ok: false, reason: "unreachable:bank.json", record: false });
    routes[`${BASE}vision/releases/${ID}/bank.json`] = () => "network";
    expect(await loadRemoteRelease(pointer, deps(server(routes).fetch))).toMatchObject({ ok: false, reason: "unreachable:bank.json", record: false });
  });

  it("9: a download that stalls is given up on (no bytes for the stall time), not recorded", async () => {
    const routes = defaultRoutes();
    routes[`${BASE}vision/releases/${ID}/catalog.json`] = (init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc("{"));
            init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
          },
        }),
      );
    const r = await loadRemoteRelease(pointer, deps(server(routes).fetch, { stallMs: 30 }));
    expect(r).toMatchObject({ ok: false, reason: "unreachable:catalog.json", record: false });
  });

  it("9: a server that never answers a file's request is a stall too (no headers within the stall time)", async () => {
    const routes = defaultRoutes();
    routes[`${BASE}vision/releases/${ID}/bank.json`] = (init) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const r = await loadRemoteRelease(pointer, deps(server(routes).fetch, { stallMs: 30 }));
    expect(r).toMatchObject({ ok: false, reason: "unreachable:bank.json", record: false });
  });

  it("8: a pinned file named release.json (the document's own key) is refused", async () => {
    const doc = { ...JSON.parse(new TextDecoder().decode(DOC)), catalog: { ...docFor(ID, REMOTE).catalog, path: "release.json" } };
    const bytes = enc(JSON.stringify(doc));
    const routes = defaultRoutes();
    routes[`${BASE}vision/releases/${ID}/release.json`] = body(bytes);
    expect(await loadRemoteRelease({ ...pointer, sha256: hex(bytes) }, deps(server(routes).fetch))).toMatchObject({ ok: false, reason: "doc-shape", record: true });
  });

  it("2.2: a bundled file that cannot be read from the extension is downloaded instead", async () => {
    const routes = defaultRoutes();
    routes["ext://release/detector.onnx"] = () => new Response("gone", { status: 404 });
    const s = server(routes);
    const r = await loadRemoteRelease(pointer, deps(s.fetch));
    expect(r).toMatchObject({ ok: true, reused: 1 });
    expect(s.calls.some((c) => c.url === `${BASE}vision/releases/${ID}/detector.onnx`)).toBe(true);
  });

  it("2.2: no readable bundled document: every file is downloaded", async () => {
    const routes = defaultRoutes();
    routes["ext://release/release.json"] = () => "network";
    expect(await loadRemoteRelease(pointer, deps(server(routes).fetch))).toMatchObject({ ok: true, reused: 0 });
  });

  it("9b: a file that streams without end is read no further than its pinned size, then fails and is recorded", async () => {
    const routes = defaultRoutes();
    let served = 0;
    routes[`${BASE}vision/releases/${ID}/bank.json`] = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            served += 1024;
            c.enqueue(new Uint8Array(1024));
          },
        }),
      );
    const r = await loadRemoteRelease(pointer, deps(server(routes).fetch));
    expect(r).toMatchObject({ ok: false, reason: "file-sha:bank.json", record: true });
    expect(served).toBeLessThan(64 * 1024);
    expect(r.downloaded).toBeLessThanOrEqual(DOC.byteLength * 2 + 2 * (NEW["bank.json"].byteLength + 1024));
  });

  it("7: a document past 256 KB is read no further, fails its SHA-256 and is recorded", async () => {
    const routes = defaultRoutes();
    routes[`${BASE}vision/releases/${ID}/release.json`] = () => new Response(new Uint8Array(DOCUMENT_MAX_BYTES * 4) as unknown as BodyInit);
    const r = await loadRemoteRelease(pointer, deps(server(routes).fetch));
    expect(r).toMatchObject({ ok: false, reason: "doc-sha", record: true });
    expect(r.downloaded).toBe(2 * (DOCUMENT_MAX_BYTES + 1));
  });

  it("shows the loading state before the document is asked for", async () => {
    const order: string[] = [];
    const s = server(defaultRoutes());
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) => (order.push(String(input).split("/").pop()!), s.fetch(input, init))) as typeof globalThis.fetch;
    await loadRemoteRelease(pointer, deps(fetch, { onDownloading: () => order.push("loading") }));
    expect(order[0]).toBe("loading");
  });

  it("9b: a file whose size or sha256 is wrong twice is recorded; once (a stale cache entry) is fine", async () => {
    const routes = defaultRoutes();
    routes[`${BASE}vision/releases/${ID}/identity-groups.json`] = body(enc('{"g":9}'));
    const s = server(routes);
    expect(await loadRemoteRelease(pointer, deps(s.fetch))).toMatchObject({ ok: false, reason: "file-sha:identity-groups.json", record: true });
    expect(s.calls.filter((c) => c.url.endsWith("identity-groups.json") && c.url.startsWith(BASE)).map((c) => c.init.cache)).toEqual([undefined, "reload"].map((x) => x ?? "default"));
    routes[`${BASE}vision/releases/${ID}/identity-groups.json`] = (_, n) => new Response(n === 1 ? enc('{"g":9}') : NEW["identity-groups.json"]);
    expect(await loadRemoteRelease(pointer, deps(server(routes).fetch))).toMatchObject({ ok: true });
  });
});
