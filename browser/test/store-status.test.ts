// SPDX-License-Identifier: Apache-2.0
// node/store-status.ts and the daily status workflow template: the newest release file against what
// each store shows the public. Every answer of a store is a fake in this file; nothing here reaches
// the network, and every id, version and address is made up.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { denyFindings, readReleaseFile, sha256 } from "../node/store-checks.js";
import { amoPublicVersion, chromePublicVersion, compareVersions, newestRelease } from "../node/store-status.js";
import { type Deps, main } from "../node/store-upload.js";

const TEMPLATES = join(fileURLToPath(new URL(".", import.meta.url)), "..", "templates");
const ITEM = "abcdefghijklmnopabcdefghijklmnop";
const LIVE = readFileSync(join(TEMPLATES, "store/releases/1.0.0/live-config.json"));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The template's store/ folder in a scratch folder, plus more release files named by version. */
function workspace(extraVersions: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "store-status-test-"));
  dirs.push(dir);
  cpSync(join(TEMPLATES, "store"), join(dir, "store"), { recursive: true });
  for (const v of extraVersions) {
    const release = JSON.parse(readFileSync(join(dir, "store/releases/1.0.0.json"), "utf-8")) as Record<string, unknown>;
    writeFileSync(join(dir, `store/releases/${v}.json`), JSON.stringify({ ...release, version: v, firefox: undefined, expect: undefined }));
  }
  return dir;
}

interface Stores {
  chrome?: string | null | "down" | "error" | "other";
  amo?: string | null | "down" | "error" | 401 | 403;
  config?: Buffer | number;
  /** Statuses answered, in order, before the real answer (a rate limit, a restart). */
  chromeFirst?: number[];
  configFirst?: number[];
}

/** A fake of the two public reads and the expected address. */
function fakeStores(s: Stores) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    // Every read has a timeout.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (init?.method && init.method !== "GET") return new Response("no", { status: 405 });
    if (url.startsWith("https://update.test/")) {
      expect(decodeURIComponent(url)).toContain(`id=${ITEM}&uc`);
      expect(url).not.toMatch(/%26v%3D/);
      const early = s.chromeFirst?.shift();
      if (early !== undefined) return new Response("busy", { status: early });
      if (s.chrome === "down") return new Response("down", { status: 503 });
      if (s.chrome === "error") throw new Error("connection reset");
      const id = s.chrome === "other" ? "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" : ITEM;
      if (s.chrome === null) return new Response(`<gupdate><app appid="${id}" status="error-unknownApplication"/></gupdate>`);
      return new Response(`<?xml version="1.0"?><gupdate protocol="2.0"><app appid="${id}" status="ok"><updatecheck codebase="https://x.test/a.crx" status="ok" version="${s.chrome ?? "1.0.0"}"/></app></gupdate>`);
    }
    if (url.startsWith("https://amo.test/api/v5/addons/addon/")) {
      expect(url).toBe("https://amo.test/api/v5/addons/addon/example-addon/");
      if (s.amo === "down") return new Response("down", { status: 502 });
      if (s.amo === 401 || s.amo === 403) return new Response("{}", { status: s.amo });
      if (s.amo === null) return new Response('{"detail":"Not found."}', { status: 404 });
      return new Response(JSON.stringify({ slug: "example-addon", status: "public", current_version: { version: s.amo ?? "1.0.0", file: { status: "public" } } }), { status: 200 });
    }
    if (url === "https://cdn.example.org/data/config.json") {
      const early = s.configFirst?.shift();
      if (early !== undefined) return new Response("busy", { status: early });
      if (typeof s.config === "number") return new Response("gone", { status: s.config });
      return new Response(new Uint8Array(s.config ?? LIVE), { status: 200 });
    }
    return new Response("no fake", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const slept: number[] = [];

function deps(stores: Stores, log: string[] = []): Deps & { calls: string[] } {
  const { fetchFn, calls } = fakeStores(stores);
  return {
    env: { CWS_ACCESS_TOKEN: "token" },
    fetchFn,
    readFile: (p) => new Uint8Array(readFileSync(p)),
    zipManifest: () => {
      throw new Error("status reads no package");
    },
    log: (line) => log.push(line),
    sleep: async (ms) => {
      slept.push(ms);
    },
    chromeUpdateBase: "https://update.test/crx",
    amoBase: "https://amo.test",
    calls,
  };
}

const argv = (dir: string, extra: string[] = []): string[] => ["status", "--config", join(dir, "store/store.config.json"), "--releases", join(dir, "store/releases"), ...extra];

async function run(dir: string, stores: Stores, extra: string[] = []): Promise<{ code: number; text: string; calls: string[] }> {
  const log: string[] = [];
  const d = deps(stores, log);
  const code = await main(argv(dir, extra), d);
  return { code, text: log.join("\n"), calls: d.calls };
}

describe("status", () => {
  it("passes when both stores show the newest release file's version, and the live file is the repository's", async () => {
    const r = await run(workspace(), {});
    expect(r.code, r.text).toBe(0);
    expect(r.text).toMatch(/Chrome Web Store: public 1\.0\.0/);
    expect(r.text).toMatch(/addons\.mozilla\.org: public 1\.0\.0/);
    expect(r.text).toMatch(/expect: https:\/\/cdn\.example\.org\/data\/config\.json .* matches/);
    expect(r.text).toMatch(/No fault found/);
    // Only reads, and nothing of the environment's credentials reaches a request.
    expect(r.calls.every((c) => c.startsWith("GET "))).toBe(true);
    expect(r.calls.length).toBe(3);
  });

  it("'in review' exits 0 with a note: the stores show an older version than the newest release file", async () => {
    const r = await run(workspace(["1.1.0"]), { chrome: "1.0.0", amo: "1.0.0" });
    expect(r.code, r.text).toBe(0);
    expect(r.text).toMatch(/Note: Chrome Web Store: 1\.1\.0 is not public yet \(public: 1\.0\.0\)\. In review, or not submitted\./);
    expect(r.text).toMatch(/Note: addons\.mozilla\.org: 1\.1\.0 is not public yet/);
  });

  it("a first release the stores do not list yet is a note; with earlier releases and no saved state it is a fault, with saved state a note", async () => {
    const first = await run(workspace(), { chrome: null, amo: null });
    expect(first.code, first.text).toBe(0);
    expect(first.text).toMatch(/Chrome Web Store: no public version yet/);
    // No saved state at all (a first run, or a lost cache): earlier release files say it should be listed.
    const later = await run(workspace(["1.1.0"]), { chrome: null, amo: "1.0.0" });
    expect(later.code).toBe(1);
    expect(later.text).toMatch(/Chrome Web Store: lists no public version, though earlier releases exist/);
    // The saved state was read and has no public version for the store: it is waiting for its initial review.
    const dir = workspace(["1.1.0"]);
    const state = join(dir, "state.json");
    writeFileSync(state, JSON.stringify({ schemaVersion: 1, highWater: { chrome: "1.0.0" } }));
    const waiting = await run(dir, { chrome: "1.0.0", amo: null }, ["--state-in", state, "--state-out", state]);
    expect(waiting.code, waiting.text).toBe(0);
    expect(waiting.text).toMatch(/addons\.mozilla\.org: no public version yet/);
    // The same on every later day, and the takedown rule is unchanged for a store that had a version.
    expect((await run(dir, { chrome: "1.0.0", amo: null }, ["--state-in", state])).code).toBe(0);
    expect((await run(dir, { chrome: null, amo: null }, ["--state-in", state])).code).toBe(1);
    // An unreadable state is no state.
    writeFileSync(state, "not json");
    expect((await run(dir, { chrome: "1.0.0", amo: null }, ["--state-in", state])).code).toBe(1);
  });

  it("a mismatch exits 1: a store newer than the newest release file", async () => {
    const r = await run(workspace(), { chrome: "1.2.0" });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/Chrome Web Store: public 1\.2\.0 is newer than the newest release file 1\.0\.0/);
    expect((await run(workspace(), { amo: "1.0.1" })).code).toBe(1);
  });

  it("a version going backward exits 1, against the previous run's state", async () => {
    const dir = workspace(["1.1.0"]);
    const state = join(dir, "state.json");
    const first = await run(dir, { chrome: "1.1.0", amo: "1.1.0" }, ["--state-out", state]);
    expect(first.code, first.text).toBe(0);
    expect(JSON.parse(readFileSync(state, "utf-8"))).toEqual({ schemaVersion: 1, highWater: { chrome: "1.1.0", firefox: "1.1.0" } });
    const back = await run(dir, { chrome: "1.0.0", amo: "1.1.0" }, ["--state-in", state, "--state-out", state]);
    expect(back.code).toBe(1);
    expect(back.text).toMatch(/Chrome Web Store: the public version went back from 1\.1\.0 to 1\.0\.0/);
    // The high-water mark is not lowered by the bad reading.
    expect(JSON.parse(readFileSync(state, "utf-8")).highWater.chrome).toBe("1.1.0");
    // A rise moves it up; a missing state file is a note, not a fault.
    const same = await run(dir, { chrome: "1.1.0", amo: "1.1.0" }, ["--state-in", state]);
    expect(same.code).toBe(0);
    const none = await run(dir, { chrome: "1.1.0", amo: "1.1.0" }, ["--state-in", join(dir, "nope.json")]);
    expect(none.code).toBe(0);
    expect(none.text).toMatch(/No earlier run's versions/);
  });

  it("exits 1 when the live file differs from the repository's, answers 404, or a hash is wrong", async () => {
    const dir = workspace();
    const differ = await run(dir, { config: Buffer.from('{"example":"changed"}') });
    expect(differ.code).toBe(1);
    expect(differ.text).toMatch(/the live settings file\): the live bytes .* are not live-config\.json/);
    expect((await run(dir, { config: 404 })).text).toMatch(/HTTP 404/);
    const file = join(dir, "store/releases/1.0.0.json");
    const release = JSON.parse(readFileSync(file, "utf-8")) as { expect: Array<Record<string, unknown>> };
    release.expect = [{ url: "https://cdn.example.org/data/config.json", sha256: sha256(new Uint8Array(LIVE)) }];
    writeFileSync(file, JSON.stringify(release));
    expect((await run(dir, {})).code).toBe(0);
    release.expect = [{ url: "https://cdn.example.org/data/config.json", sha256: "0".repeat(64) }];
    writeFileSync(file, JSON.stringify(release));
    expect((await run(dir, {})).code).toBe(1);
  });

  it("checks an expect entry marked 'published' only once the version is public", async () => {
    const dir = workspace(["1.1.0"]);
    const file = join(dir, "store/releases/1.1.0.json");
    writeFileSync(file, JSON.stringify({ version: "1.1.0", expect: [{ url: "https://cdn.example.org/data/config.json", sha256: "0".repeat(64), when: "published" }] }));
    const waiting = await run(dir, { chrome: "1.0.0", amo: "1.0.0", config: Buffer.from("other") });
    expect(waiting.code, waiting.text).toBe(0);
    expect(waiting.text).toMatch(/not checked until 1\.1\.0 is public/);
    expect((await run(dir, { chrome: "1.1.0", amo: "1.1.0" })).code).toBe(1);
  });

  it("exits 1 when a store cannot be read, after three tries, and when the answer is for another item", async () => {
    const down = await run(workspace(), { chrome: "down" });
    expect(down.code).toBe(1);
    expect(down.text).toMatch(/Chrome Web Store: cannot read the public version: HTTP 503 after 3 tries/);
    expect(down.calls.filter((c) => c.includes("update.test")).length).toBe(3);
    expect((await run(workspace(), { amo: "down" })).text).toMatch(/addons\.mozilla\.org: cannot read the public version/);
    expect((await run(workspace(), { chrome: "error" })).text).toMatch(/connection reset after 3 tries/);
    expect((await run(workspace(), { chrome: "other" })).text).toMatch(/answered for another item/);
  });

  it("retries a rate limit and a restart, waiting 30 s and then 2 min, for a store and for an expect address", async () => {
    slept.length = 0;
    const r = await run(workspace(), { chromeFirst: [429, 503], configFirst: [503, 429] });
    expect(r.code, r.text).toBe(0);
    expect(slept).toEqual([30_000, 120_000, 30_000, 120_000]);
    expect(r.calls.filter((c) => c.includes("update.test")).length).toBe(3);
    expect(r.calls.filter((c) => c.includes("config.json")).length).toBe(3);
    const stuck = await run(workspace(), { configFirst: [503, 503, 503] });
    expect(stuck.code).toBe(1);
    expect(stuck.text).toMatch(/HTTP 503 after 3 tries/);
  });

  it("treats addons.mozilla.org 401 and 403 as no public version: a note for a first release, a fault later", async () => {
    for (const code of [401, 403] as const) {
      const first = await run(workspace(), { amo: code });
      expect(first.code, first.text).toBe(0);
      expect(first.text).toMatch(/addons\.mozilla\.org: no public version yet/);
      const later = await run(workspace(["1.1.0"]), { chrome: "1.0.0", amo: code });
      expect(later.code).toBe(1);
      expect(later.text).toMatch(/addons\.mozilla\.org: lists no public version, though earlier releases exist/);
    }
  });

  it("a store that listed a public version and now lists none is a fault, even with one release file", async () => {
    const dir = workspace();
    const state = join(dir, "state.json");
    expect((await run(dir, {}, ["--state-out", state])).code).toBe(0);
    const gone = await run(dir, { chrome: null }, ["--state-in", state, "--state-out", state]);
    expect(gone.code).toBe(1);
    expect(gone.text).toMatch(/Chrome Web Store: lists no public version, though 1\.0\.0 was public on an earlier run \(taken down\?\)/);
    expect(JSON.parse(readFileSync(state, "utf-8")).highWater.chrome).toBe("1.0.0");
    // Without that history, the same answer is a first release in review.
    expect((await run(workspace(), { chrome: null })).code).toBe(0);
  });

  it("orders versions as dotted numbers, and names a version it cannot order", async () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0rc1", "1.0.0")).toBeNull();
    const dir = workspace();
    expect((await run(dir, { amo: "1.0.0rc1" })).text).toMatch(/cannot be ordered against 1\.0\.0, and is not equal to it/);
  });

  it("reads its answers through the two public reads", async () => {
    const d = deps({ chrome: "2.3.4", amo: null });
    expect(await chromePublicVersion(ITEM, d)).toBe("2.3.4");
    expect(await amoPublicVersion("example-addon", d)).toBeNull();
  });

  it("takes the newest release file by version, not by name, and wants each file named for its version", () => {
    const dir = workspace(["1.9.0", "1.10.0"]);
    expect(newestRelease(join(dir, "store/releases")).release.version).toBe("1.10.0");
    writeFileSync(join(dir, "store/releases/2.0.0.json"), JSON.stringify({ version: "2.0.1" }));
    expect(() => newestRelease(join(dir, "store/releases"))).toThrow(/named for its version/);
  });

  it("uses no credential, refuses an env file, and needs its two arguments", async () => {
    const dir = workspace();
    const log: string[] = [];
    expect(await main([...argv(dir), "--env-file", join(dir, "e")], deps({}, log))).toBe(2);
    expect(await main(["status", "--config", join(dir, "store/store.config.json")], deps({}))).toBe(2);
    const r = await run(dir, {});
    expect(r.text).not.toMatch(/CWS_|AMO_|Bearer|token/i);
    expect(r.calls.join("\n")).not.toMatch(/Authorization|JWT/);
  });

  it("writes its lines to the run page and carries no local path", async () => {
    const dir = workspace(["1.1.0"]);
    const summary = join(dir, "summary.md");
    const r = await run(dir, { chrome: "1.0.0", amo: "1.0.0" }, ["--summary", summary]);
    expect(r.code).toBe(0);
    const text = readFileSync(summary, "utf-8");
    expect(text).toMatch(/## Store status: newest release file 1\.1\.0/);
    expect(`${text}${r.text}`).not.toContain(dir);
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });
});

describe("a release file's expect entries", () => {
  it("need an https address and exactly one of file and sha256, a file beside the release", () => {
    const dir = workspace();
    const read = (expectList: unknown): unknown => {
      const f = join(dir, "r.json");
      writeFileSync(f, JSON.stringify({ version: "1.0.0", expect: expectList }));
      return readReleaseFile(f).expect;
    };
    expect(read([{ url: "https://x.example.org/a", file: "a.json", when: "published", why: "w" }])).toEqual([{ url: "https://x.example.org/a", file: "a.json", when: "published", why: "w" }]);
    expect(() => read([{ url: "http://x.example.org/a", file: "a" }])).toThrow(/https url/);
    expect(() => read([{ url: "https://x.example.org/a" }])).toThrow(/exactly one of file and sha256/);
    expect(() => read([{ url: "https://x.example.org/a", file: "a", sha256: "0".repeat(64) }])).toThrow(/exactly one/);
    expect(() => read([{ url: "https://x.example.org/a", file: "../a" }])).toThrow(/beside the release file/);
    expect(() => read([{ url: "https://x.example.org/a", file: "a", when: "never" }])).toThrow(/"always" or "published"/);
    expect(() => read([{ url: "https://x.example.org/a", sha256: "xyz" }])).toThrow(/64 hex/);
  });
});

describe("the status workflow template", () => {
  const text = readFileSync(join(TEMPLATES, "store-status.yml"), "utf-8");
  const config = JSON.parse(readFileSync(join(TEMPLATES, "store/store.config.json"), "utf-8")) as { deny: string[] };

  it("runs daily with contents: read, no environment, no secret and no identity token", () => {
    expect(text).toMatch(/\n {2}schedule:\n {4}- cron: "\d+ \d+ \* \* \*"\n/);
    expect(text).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(text).not.toMatch(/\n\s+permissions:\n\s+\S+: write|write-all/);
    expect(text).not.toMatch(/environment:|id-token|secrets\.|vars\.|inputs\./);
    // No credential is named anywhere in the file's code (its comments say there is none).
    const code = text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n").replace("persist-credentials: false", "");
    expect(code).not.toMatch(/CWS_|AMO_|_TOKEN|TOKEN\b|JWT|credential|secret/i);
    expect(denyFindings(text, config.deny)).toEqual([]);
    expect(text).toMatch(/status --config store\/store\.config\.json --releases store\/releases/);
  });
  it("saves the state even when the run is red, so a day without state does not repeat", () => {
    expect(text).toMatch(/- uses: actions\/cache\/restore@[0-9a-f]{40} /);
    expect(text).toMatch(/- uses: actions\/cache\/save@[0-9a-f]{40} [^\n]*\n {8}if: always\(\)\n/);
    expect(text).not.toMatch(/- uses: actions\/cache@/);
  });

  it("pins each `uses:` to a full commit", () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1]!);
    expect(uses.length).toBe(4);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });
});
