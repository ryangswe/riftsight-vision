// SPDX-License-Identifier: Apache-2.0
// The packed descriptor index of the geometric stage, against the toy index the Python package
// packed (the "geometricIndex" section of fixtures/contract.json, written and checked by
// tests/test_browser_fixtures.py at the top of the repository).

import { describe, expect, it } from "vitest";

import {
  checkBankBinding,
  GeometricIndexError,
  INDEX_CACHE_NAME,
  loadPackedIndex,
  type PackedIndex,
  parsePackedIndex,
  sha256Hex,
} from "../src/geometric/index.js";
import { contract } from "./support.js";

const BASE = "https://cdn.example.test/vision/geo/0123456789abcdef/";
const MANIFEST_URL = `${BASE}manifest.json`;
const section = contract.geometricIndex;

const manifestText = `${JSON.stringify(section.manifest, null, 1)}\n`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manifest = (): any => JSON.parse(manifestText);
const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const unhex = (text: string): Uint8Array => new Uint8Array((text.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)));
const shardFile = (i: number): ArrayBuffer => toBuffer(unhex(section.shards[i]));
const shards = (): ArrayBuffer[] => Array.from({ length: 8 }, (_, i) => shardFile(i));
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bankIds: string[] = section.cards.map((card: { cardId: string }) => card.cardId);

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof GeometricIndexError) return error.code;
    throw error;
  }
  return "none";
}
async function rejectionCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof GeometricIndexError) return error.code;
    throw error;
  }
  return "none";
}

describe("parsePackedIndex", () => {
  const index = parsePackedIndex(manifest(), shards());

  it("unpacks every card's descriptors and positions exactly as Python holds them", () => {
    expect(index.rows).toBe(section.rows);
    expect(index.cards.map((card) => card.cardId)).toEqual(bankIds);
    for (const [position, expected] of section.cards.entries()) {
      const card = index.cards[position] as PackedIndex["cards"][number];
      expect(card.n).toBe(expected.n);
      expect(card.artV).toBe(expected.artV);
      expect(hex(index.desc.subarray(card.start * 32, (card.start + card.n) * 32))).toBe(expected.desc);
      const xy = index.xy.subarray(card.start * 2, (card.start + card.n) * 2);
      expect(hex(new Uint8Array(xy.buffer, xy.byteOffset, xy.byteLength))).toBe(expected.xy);
    }
  });

  it("numbers rows in the index's order and maps each row back to its card", () => {
    let start = 0;
    for (const [position, card] of index.cards.entries()) {
      expect(card.start).toBe(start);
      for (let row = card.start; row < card.start + card.n; row++) expect(index.rowCard[row]).toBe(position);
      start += card.n;
    }
    expect(start).toBe(index.rows);
    expect(index.desc.length).toBe(index.rows * 32);
    expect(index.xy.length).toBe(index.rows * 2);
  });

  it("carries the source, the bank and the OpenCV version", () => {
    expect(index.sourceSha256).toBe(section.sourceSha256);
    expect(index.bankSha256).toBe(section.bankSha256);
    expect(index.opencv).toBe("5.0.0");
  });

  it("is the file the contract names, shard by shard", async () => {
    expect(await sha256Hex(toBuffer(new TextEncoder().encode(manifestText)))).toBe(section.manifestSha256);
    for (const [i, expected] of section.shardSha256.entries()) expect(await sha256Hex(shardFile(i))).toBe(expected);
  });

  it("gives the nearest and second nearest rows Python found, a tie to the lowest row", () => {
    const queries = new Uint8Array(section.queries.match(/../g).map((byte: string) => Number.parseInt(byte, 16)));
    const count = queries.length / 32;
    const knn = section.knn;
    const popcount = (v: number): number => {
      let n = 0;
      for (let x = v; x; x &= x - 1) n++;
      return n;
    };
    for (let q = 0; q < count; q++) {
      let best = -1;
      let second = -1;
      let dBest = 1e9;
      let dSecond = 1e9;
      for (let row = 0; row < index.rows; row++) {
        let d = 0;
        for (let k = 0; k < 32; k++) d += popcount((queries[q * 32 + k] as number) ^ (index.desc[row * 32 + k] as number));
        if (d < dBest) {
          [second, dSecond] = [best, dBest];
          [best, dBest] = [row, d];
        } else if (d < dSecond) {
          [second, dSecond] = [row, d];
        }
      }
      expect([best, second, dBest, dSecond]).toEqual([knn.best[q], knn.second[q], knn.dBest[q], knn.dSecond[q]]);
    }
  });

  it("refuses a manifest or shards that do not fit", () => {
    expect(errorCode(() => parsePackedIndex(manifest(), shards().slice(1)))).toBe("shard");
    const short = shards();
    short[0] = short[0]!.slice(0, short[0]!.byteLength - 1);
    expect(errorCode(() => parsePackedIndex(manifest(), short))).toBe("shard");
    for (const change of [
      (m: any) => (m.kind = "other"),
      (m: any) => (m.schemaVersion = 2),
      (m: any) => (m.bank.sha256 = "xyz"),
      (m: any) => (m.features.type = "sift"),
      (m: any) => (m.shards[0].path = "../shard-0.bin"),
      (m: any) => (m.cards[1].offset += 1),
      (m: any) => (m.cards[0].artV = "ABC"),
      (m: any) => (m.cards[1].cardId = m.cards[0].cardId),
      (m: any) => (m.cards[0].n += 1),
      (m: any) => (m.cards[2].shard = 99),
      (m: any) => m.cards.reverse(),
    ]) {
      const doc = manifest();
      change(doc);
      expect(errorCode(() => parsePackedIndex(doc, shards())), String(change)).toBe("manifest");
    }
    expect(errorCode(() => parsePackedIndex("nope", shards()))).toBe("manifest");
  });
});

describe("checkBankBinding", () => {
  const doc = { bankSha256: section.bankSha256, cards: bankIds.map((cardId) => ({ cardId })) };
  it("accepts the bank the index records, with every card present, and an index with more cards", () => {
    expect(() => checkBankBinding(doc, section.bankSha256, bankIds)).not.toThrow();
    expect(() => checkBankBinding(doc, section.bankSha256, bankIds.slice(1))).not.toThrow();
  });
  it("refuses another bank, or a bank card the index lacks", () => {
    expect(errorCode(() => checkBankBinding(doc, "c".repeat(64), bankIds))).toBe("bank-sha");
    expect(errorCode(() => checkBankBinding(doc, section.bankSha256, [...bankIds, "TOY-Z"]))).toBe("bank-ids");
  });
});

/** An in-memory stand-in for the page's `CacheStorage`. */
function memoryCaches(): { storage: CacheStorage; entries: Map<string, ArrayBuffer>; opened: string[] } {
  const entries = new Map<string, ArrayBuffer>();
  const opened: string[] = [];
  const cache = {
    match: async (url: string) => (entries.has(url) ? new Response(entries.get(url)!.slice(0)) : undefined),
    put: async (url: string, response: Response) => void entries.set(url, await response.arrayBuffer()),
    delete: async (url: string | Request) => entries.delete(typeof url === "string" ? url : url.url),
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
  };
  const storage = {
    open: async (name: string) => {
      opened.push(name);
      return cache;
    },
  };
  return { storage: storage as unknown as CacheStorage, entries, opened };
}

/** A fetch over the toy folder that counts requests and how many shard downloads overlap. */
function serve(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const log: string[] = [];
  let active = 0;
  let peak = 0;
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    log.push(url);
    if (overrides[url]) return overrides[url]();
    const name = url.slice(BASE.length);
    if (name === "manifest.json") return new Response(manifestText);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    const match = /^shard-(\d)\.bin$/.exec(name);
    return match ? new Response(shardFile(Number(match[1]))) : new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, log, peak: () => peak };
}

const options = (fetchFn: typeof fetch, cache?: CacheStorage) => ({ bankSha256: section.bankSha256, bankIds, fetch: fetchFn, cache });

describe("loadPackedIndex", () => {
  it("loads the index, two shards at a time, and fills the cache", async () => {
    const server = serve();
    const { storage, entries, opened } = memoryCaches();
    const index = await loadPackedIndex(MANIFEST_URL, options(server.fetchFn, storage));
    expect(index.rows).toBe(section.rows);
    expect(index.sourceSha256).toBe(section.sourceSha256);
    expect(server.log.filter((url) => url.endsWith(".bin")).length).toBe(8);
    expect(server.peak()).toBe(2);
    expect([...entries.keys()].sort()).toEqual(Array.from({ length: 8 }, (_, i) => `${BASE}shard-${i}.bin`));
    expect(opened).toEqual([INDEX_CACHE_NAME]);
    expect(hex(index.desc)).toBe(hex(parsePackedIndex(manifest(), shards()).desc));
  });

  it("works without a cache", async () => {
    const index = await loadPackedIndex(MANIFEST_URL, options(serve().fetchFn));
    expect(index.rows).toBe(section.rows);
  });

  it("reads cached shards on the next start, and hashes them again", async () => {
    const { storage, entries } = memoryCaches();
    await loadPackedIndex(MANIFEST_URL, options(serve().fetchFn, storage));
    const second = serve();
    await loadPackedIndex(MANIFEST_URL, options(second.fetchFn, storage));
    expect(second.log).toEqual([MANIFEST_URL]);
    // A cached shard that no longer hashes is fetched again, and the cache is mended.
    const key = `${BASE}shard-3.bin`;
    const spoiled = new Uint8Array(entries.get(key)!.slice(0));
    spoiled[0] = (spoiled[0] as number) ^ 0xff;
    entries.set(key, toBuffer(spoiled));
    const third = serve();
    const index = await loadPackedIndex(MANIFEST_URL, options(third.fetchFn, storage));
    expect(third.log).toEqual([MANIFEST_URL, key]);
    expect(await sha256Hex(entries.get(key)!)).toBe(manifest().shards[3].sha256);
    expect(index.rows).toBe(section.rows);
  });

  it("refuses a downloaded shard whose hash is not the manifest's, and caches nothing of it", async () => {
    const wrong = new Uint8Array(shardFile(2));
    wrong[5] = (wrong[5] as number) ^ 1;
    const { storage, entries } = memoryCaches();
    const server = serve({ [`${BASE}shard-2.bin`]: () => new Response(wrong) });
    expect(await rejectionCode(() => loadPackedIndex(MANIFEST_URL, options(server.fetchFn, storage)))).toBe("hash");
    expect(entries.has(`${BASE}shard-2.bin`)).toBe(false);
  });

  it("checks the bank binding before it downloads a shard", async () => {
    const server = serve();
    expect(await rejectionCode(() => loadPackedIndex(MANIFEST_URL, { ...options(server.fetchFn), bankSha256: "d".repeat(64) }))).toBe("bank-sha");
    expect(await rejectionCode(() => loadPackedIndex(MANIFEST_URL, { ...options(server.fetchFn), bankIds: [...bankIds, "TOY-Z"] }))).toBe("bank-ids");
    expect(server.log).toEqual([MANIFEST_URL, MANIFEST_URL]);
  });

  it("maps a missing file, a failed request and a bad manifest to typed errors", async () => {
    expect(await rejectionCode(() => loadPackedIndex(MANIFEST_URL, options(serve({ [`${BASE}shard-1.bin`]: () => new Response("", { status: 404 }) }).fetchFn)))).toBe("shard");
    expect(await rejectionCode(() => loadPackedIndex(MANIFEST_URL, options(serve({ [MANIFEST_URL]: () => new Response("", { status: 500 }) }).fetchFn)))).toBe("shard");
    expect(await rejectionCode(() => loadPackedIndex(MANIFEST_URL, options(serve({ [MANIFEST_URL]: () => Promise.reject(new TypeError("offline")) }).fetchFn)))).toBe("shard");
    expect(await rejectionCode(() => loadPackedIndex(MANIFEST_URL, options(serve({ [MANIFEST_URL]: () => new Response("not json") }).fetchFn)))).toBe("manifest");
    expect(await rejectionCode(() => loadPackedIndex(MANIFEST_URL, options(serve({ [MANIFEST_URL]: () => new Response("{}") }).fetchFn)))).toBe("manifest");
  });

  it("refuses a manifest whose bytes are not the pinned SHA-256, and accepts the pinned one", async () => {
    const pinned = await sha256Hex(toBuffer(new TextEncoder().encode(manifestText)));
    const index = await loadPackedIndex(MANIFEST_URL, { ...options(serve().fetchFn), manifestSha256: pinned });
    expect(index.rows).toBe(section.rows);
    const server = serve();
    expect(await rejectionCode(() => loadPackedIndex(MANIFEST_URL, { ...options(server.fetchFn), manifestSha256: "e".repeat(64) }))).toBe("manifest-sha");
    expect(server.log).toEqual([MANIFEST_URL]);
  });

  it("after a load, deletes cached entries outside the manifest's folder and keeps its own", async () => {
    const { storage, entries } = memoryCaches();
    const old = "https://cdn.example.test/vision/geo/fedcba9876543210/shard-0.bin";
    entries.set(old, new ArrayBuffer(4));
    await loadPackedIndex(MANIFEST_URL, options(serve().fetchFn, storage));
    expect(entries.has(old)).toBe(false);
    expect([...entries.keys()].sort()).toEqual(Array.from({ length: 8 }, (_, i) => `${BASE}shard-${i}.bin`));
    // A load that fails deletes nothing.
    entries.set(old, new ArrayBuffer(4));
    const bad = serve({ [`${BASE}shard-0.bin`]: () => new Response("", { status: 404 }) });
    entries.delete(`${BASE}shard-0.bin`);
    await expect(loadPackedIndex(MANIFEST_URL, options(bad.fetchFn, storage))).rejects.toThrow();
    expect(entries.has(old)).toBe(true);
  });

  it("when one shard fails, aborts the other lane's download and starts no other shard", async () => {
    const log: string[] = [];
    let aborted = false;
    const wrong = new Uint8Array(shardFile(0));
    wrong[0] = (wrong[0] as number) ^ 1;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      log.push(url.slice(BASE.length));
      if (url === MANIFEST_URL) return new Response(manifestText);
      if (url.endsWith("shard-0.bin")) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(wrong);
      }
      // Every other shard hangs until it is aborted.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    expect(await rejectionCode(() => loadPackedIndex(MANIFEST_URL, options(fetchFn)))).toBe("hash");
    expect(aborted).toBe(true);
    expect(log).toEqual(["manifest.json", "shard-0.bin", "shard-1.bin"]);
  });
});

describe("an index with cards added (pack-features --base)", () => {
  const added = contract.geometricAppend;
  const FOLDER = "https://cdn.example.test/vision/geo/series/";
  const BASE_URL = `${FOLDER}base.json`;
  const NEXT_URL = `${FOLDER}next.json`;
  const text = (doc: unknown): string => `${JSON.stringify(doc, null, 1)}\n`;
  const shardOf = (path: string): ArrayBuffer => toBuffer(unhex(added.shards[path]));
  const shardsOf = (doc: { shards: { path: string }[] }): ArrayBuffer[] => doc.shards.map((entry) => shardOf(entry.path));
  const files: Record<string, string> = { "base.json": text(added.baseManifest), "next.json": text(added.manifest) };
  const host = () => {
    const log: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      log.push(url.slice(FOLDER.length));
      const name = url.slice(FOLDER.length);
      if (files[name] !== undefined) return new Response(files[name]);
      return added.shards[name] !== undefined ? new Response(shardOf(name)) : new Response("", { status: 404 });
    }) as typeof fetch;
    return { fetchFn, log };
  };
  const nextIds: string[] = added.manifest.cards.map((card: { cardId: string }) => card.cardId);
  const baseIds: string[] = added.baseManifest.cards.map((card: { cardId: string }) => card.cardId);

  it("is the bytes the contract names", async () => {
    expect(await sha256Hex(toBuffer(new TextEncoder().encode(files["base.json"]!)))).toBe(added.baseManifestSha256);
    expect(await sha256Hex(toBuffer(new TextEncoder().encode(files["next.json"]!)))).toBe(added.manifestSha256);
  });

  it("assembles exactly the rows of the same index packed in one step, in the same order", () => {
    const appended = parsePackedIndex(JSON.parse(files["next.json"]!), shardsOf(added.manifest));
    const whole = parsePackedIndex(manifest(), shards());
    expect(appended.rows).toBe(whole.rows);
    expect(appended.cards.map((card) => [card.cardId, card.start, card.n])).toEqual(whole.cards.map((card) => [card.cardId, card.start, card.n]));
    expect(hex(appended.desc)).toBe(hex(whole.desc));
    expect(hex(new Uint8Array(appended.xy.buffer))).toBe(hex(new Uint8Array(whole.xy.buffer)));
    expect(Array.from(appended.rowCard)).toEqual(Array.from(whole.rowCard));
  });

  it("is bound to the new bank, and the base to the old one", () => {
    const next = { bankSha256: added.manifest.bank.sha256, cards: added.manifest.cards };
    expect(next.bankSha256).toBe(added.bankSha256);
    expect(() => checkBankBinding(next, added.bankSha256, nextIds)).not.toThrow();
    expect(errorCode(() => checkBankBinding(next, added.baseBankSha256, nextIds))).toBe("bank-sha");
    const base = { bankSha256: added.baseManifest.bank.sha256, cards: added.baseManifest.cards };
    expect(errorCode(() => checkBankBinding(base, added.bankSha256, nextIds))).toBe("bank-sha");
  });

  it("downloads only the new shards after the base was loaded, and keeps both in the cache", async () => {
    const { storage, entries } = memoryCaches();
    const first = host();
    const base = await loadPackedIndex(BASE_URL, { bankSha256: added.baseBankSha256, bankIds: baseIds, fetch: first.fetchFn, cache: storage, manifestSha256: added.baseManifestSha256 });
    expect(base.cards.map((card) => card.cardId)).toEqual(baseIds);
    expect(first.log).toEqual(["base.json", ...added.baseManifest.shards.map((entry: { path: string }) => entry.path)]);
    const second = host();
    const next = await loadPackedIndex(NEXT_URL, { bankSha256: added.bankSha256, bankIds: nextIds, fetch: second.fetchFn, cache: storage, manifestSha256: added.manifestSha256 });
    expect(second.log).toEqual(["next.json", ...added.newShards]);
    expect(added.newShards.length).toBeGreaterThan(0);
    expect(hex(next.desc)).toBe(hex(parsePackedIndex(manifest(), shards()).desc));
    expect([...entries.keys()].sort()).toEqual(added.manifest.shards.map((entry: { path: string }) => `${FOLDER}${entry.path}`).sort());
  });
});
