// SPDX-License-Identifier: Apache-2.0
// chooseRelease: the settings read once, rules 1-5, the remote load, the skip-list, and the facts.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { chooseRelease, decisionLine } from "../src/remote/choose.js";
import { SKIP_KEY } from "../src/remote/pointer.js";
import { buildCardTable } from "../src/remote/card-table.js";

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array | ArrayBuffer) => createHash("sha256").update(Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b))).digest("hex");
const ID = "0123456789abcdef";
const BUNDLED_ID = "ffffffffffffffff";
const ref = (path: string, b: Uint8Array) => ({ path, sha256: hex(b), bytes: b.byteLength });
const files = { "detector.onnx": enc("d"), "recognizer.onnx": enc("r"), "bank.json": enc("{}"), "identity-groups.json": enc("{}"), "catalog.json": enc('{"cards":[{"id":"999","name":"New Card","art":"full/999.jpg"}]}') };
const docOf = (id: string, f: Record<string, Uint8Array>) =>
  enc(JSON.stringify({ id, detector: ref("detector.onnx", f["detector.onnx"]!), recognizer: ref("recognizer.onnx", f["recognizer.onnx"]!), bank: ref("bank.json", f["bank.json"]!), identity: { groups: ref("identity-groups.json", f["identity-groups.json"]!) }, catalog: ref("catalog.json", f["catalog.json"]!) }));
const DOC = docOf(ID, files);
const BUNDLED = docOf(BUNDLED_ID, { ...files, "bank.json": enc('{"old":1}'), "catalog.json": enc('{"cards":[]}') });
const pointer = { id: ID, path: `vision/releases/${ID}/release.json`, sha256: hex(DOC), minimumExtensionVersion: "0.3.0" };

function setup(over: { field?: unknown; routes?: Record<string, () => Response>; stored?: Record<string, unknown> } = {}) {
  const data: Record<string, unknown> = { ...(over.stored ?? {}) };
  const calls: string[] = [];
  const routes: Record<string, () => Response> = {
    "ext://release/release.json": () => new Response(BUNDLED),
    [`https://cdn.test/vision/releases/${ID}/release.json`]: () => new Response(DOC),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`https://cdn.test/vision/releases/${ID}/${k}`, () => new Response(v as unknown as BodyInit)])),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`ext://release/${k}`, () => new Response(v as unknown as BodyInit)])),
    ...(over.routes ?? {}),
  };
  const deps = {
    storage: {
      get: async (k: string) => (k in data ? { [k]: data[k] } : {}),
      set: async (items: Record<string, unknown>) => void Object.assign(data, items),
      remove: async (k: string) => void delete data[k],
    },
    readReleaseField: async () => ("field" in over ? over.field : pointer),
    running: "0.3.0",
    now: () => 0,
    bundled: { kind: "load" as const, releaseUrl: "ext://release/release.json", wasmPaths: "ext://runtime/" },
    buildCardTable: (c: unknown) => buildCardTable(c),
    fetch: (async (u: RequestInfo | URL) => {
      calls.push(String(u));
      const r = routes[String(u)];
      return r ? r() : new Response("no", { status: 404 });
    }) as typeof fetch,
    sha256Hex: async (b: ArrayBuffer) => hex(b),
    settingsUrl: "https://cdn.test/config.json",
    extensionUrl: (p: string) => `ext://${p}`,
  };
  return { deps, data, calls };
}
const hooks = { onDownloading: () => undefined };

describe("chooseRelease", () => {
  it("builds the remote request with the release's files and the card facts of its catalog", async () => {
    const t = setup();
    const c = await chooseRelease(t.deps, hooks);
    expect(c.source).toBe("remote");
    if (c.source !== "remote") return;
    expect(c.request).toMatchObject({ kind: "load", releaseUrl: "release.json", wasmPaths: "ext://runtime/" });
    expect(Object.keys(c.request.files ?? {}).sort()).toEqual(["bank.json", "catalog.json", "detector.onnx", "identity-groups.json", "recognizer.onnx", "release.json"]);
    expect(c.facts["999"]).toEqual(["New Card", null, "full/999.jpg"]);
    expect(c.reused).toBe(4); // both models and the identity groups are the same as the bundled ones
  });

  it("is the bundled release with no field, and fetches nothing from the CDN", async () => {
    const t = setup({ field: null });
    expect(await chooseRelease(t.deps, hooks)).toMatchObject({ source: "bundled", reason: "absent" });
    expect(t.calls.filter((u) => u.startsWith("https://"))).toEqual([]);
  });

  it("records a failure that will fail again, and is then skipped without a fetch", async () => {
    const t = setup({ routes: { [`https://cdn.test/vision/releases/${ID}/release.json`]: () => new Response("{}") } });
    expect(await chooseRelease(t.deps, hooks)).toMatchObject({ source: "bundled", reason: "doc-sha" });
    expect(t.data[SKIP_KEY]).toMatchObject({ id: ID, sha256: pointer.sha256, reason: "doc-sha" });
    const before = t.calls.length;
    expect(await chooseRelease(t.deps, hooks)).toMatchObject({ source: "bundled", reason: "skipped:doc-sha" });
    expect(t.calls.slice(before).filter((u) => u.startsWith("https://"))).toEqual([]);
  });

  it("does not record a network failure", async () => {
    const t = setup({ routes: { [`https://cdn.test/vision/releases/${ID}/release.json`]: () => new Response("x", { status: 503 }) } });
    expect(await chooseRelease(t.deps, hooks)).toMatchObject({ source: "bundled", reason: "http-503" });
    expect(t.data[SKIP_KEY]).toBeUndefined();
  });

  it("clears a stale skip entry before deciding, so a pointer moved back is tried again", async () => {
    const t = setup({ stored: { [SKIP_KEY]: { id: ID, sha256: "b".repeat(64), reason: "doc-sha", at: Date.now() } } });
    expect(await chooseRelease(t.deps, hooks)).toMatchObject({ source: "remote" });
    expect(t.data[SKIP_KEY]).toBeUndefined();
  });

  it("is the bundled release when the catalog cannot be read for the facts, unrecorded", async () => {
    const t = setup({ field: pointer });
    t.deps.buildCardTable = () => {
      throw new Error("bad");
    };
    expect(await chooseRelease(t.deps, hooks)).toMatchObject({ source: "bundled", reason: "catalog-unreadable" });
    expect(t.data[SKIP_KEY]).toBeUndefined();
  });

  it("fails (and the frame then loads the bundled release) when the bundled document has no id", async () => {
    const t = setup({ routes: { "ext://release/release.json": () => new Response("{}") } });
    await expect(chooseRelease(t.deps, hooks)).rejects.toThrow(/no id/);
  });

  it("logs one line with no page data", () => {
    expect(decisionLine("ExampleGame", { source: "remote", reason: "ok", pointer: ID, reused: 2, downloaded: 10, ms: 5 }, BUNDLED_ID)).toBe(
      `[ExampleGame] release source=remote reason=ok pointer=${ID} bundled=${BUNDLED_ID} reused=2/5 downloaded=10 ms=5`,
    );
  });
});
