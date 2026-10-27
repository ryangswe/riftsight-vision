// SPDX-License-Identifier: Apache-2.0
// The packed descriptor index of the geometric stage: every card's ORB keypoints, as the Python
// package's `cardvision pack-features` lays them out (cardvision/geometric/pack.py, which holds
// the full description of the format).
//
// A manifest names its shards: eight from a plain pack in one step, fewer with
// `--content-names` (which leaves out empty shards), and more when `pack-features --base` added
// cards (the old shards unchanged, new ones named by content after them). Any number loads the
// same way. A shard holds the rows of whole cards: descriptors first
// (rows x 32 bytes), then positions (rows x 2 little-endian float32). The shards in order hold
// the rows in order, so a card's global row is the rows of the shards before its own plus its
// offset. Positions are the index's own float32 values, the ones the Python stage reads.
//
// Loading checks everything: the manifest's shape, every shard's SHA-256 (at each start, not
// only when it is downloaded), and that the index serves the bank the release loaded (same
// bank SHA-256, and a row for every bank card). Any failure is a `GeometricIndexError`; the
// caller turns the stage off. Nothing is loaded in part.

export const PACKED_KIND = "geometric-index-packed";
export const PACKED_SCHEMA_VERSION = 1;
export const DESCRIPTOR_BYTES = 32;
export const SHARD_PARALLELISM = 2;
export const INDEX_CACHE_NAME = "cardvision-geometric-index";

/** One card of the index. `start` is its first row in the whole index; its `n` rows follow. */
export interface PackedCard {
  cardId: string;
  artV: string;
  width: number;
  height: number;
  start: number;
  n: number;
}

export interface PackedIndex {
  cards: PackedCard[];
  /** rows x 32 descriptor bytes, row-major. */
  desc: Uint8Array;
  /** rows x 2 keypoint positions (x, y), in the card image scaled to `width` x `height`. */
  xy: Float32Array;
  /** Row to the position of its card in `cards`. */
  rowCard: Uint32Array;
  rows: number;
  sourceSha256: string;
  bankSha256: string;
  opencv: string;
  /** The `features` block the keypoints were taken with (the index's own). */
  features: Readonly<Record<string, unknown>>;
}

export type GeometricIndexErrorCode = "manifest" | "manifest-sha" | "shard" | "hash" | "bank-sha" | "bank-ids";

/** Why a packed index cannot be used. The stage maps every one to "off". */
export class GeometricIndexError extends Error {
  readonly code: GeometricIndexErrorCode;
  constructor(code: GeometricIndexErrorCode, message: string) {
    super(message);
    this.name = "GeometricIndexError";
    this.code = code;
  }
}

const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ROW_BYTES = DESCRIPTOR_BYTES + 8;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const bad = (message: string): never => {
  throw new GeometricIndexError("manifest", message);
};

interface ShardInfo {
  path: string;
  sha256: string;
  rows: number;
}
interface Manifest {
  sourceSha256: string;
  bankSha256: string;
  opencv: string;
  features: Readonly<Record<string, unknown>>;
  cards: PackedCard[];
  shards: ShardInfo[];
  /** Global row of the first row of each shard. */
  shardStart: number[];
  rows: number;
}

function isRelativePath(path: unknown): path is string {
  if (typeof path !== "string" || path.trim() === "" || path.includes("\\") || path.includes("://")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").includes("..");
}

/** Check a manifest's shape and that its cards tile its shards exactly. */
function checkManifest(doc: unknown): Manifest {
  if (!isObj(doc)) return bad("the manifest is not an object");
  if (doc.kind !== PACKED_KIND) return bad(`the manifest's kind is not ${PACKED_KIND}`);
  if (doc.schemaVersion !== PACKED_SCHEMA_VERSION) return bad(`schemaVersion ${String(doc.schemaVersion)} is not ${PACKED_SCHEMA_VERSION}`);
  const source = doc.source;
  const bank = doc.bank;
  if (!isObj(source) || typeof source.sha256 !== "string" || !HEX64.test(source.sha256)) return bad("source.sha256 must be 64 hex digits");
  if (!isObj(bank) || typeof bank.sha256 !== "string" || !HEX64.test(bank.sha256)) return bad("bank.sha256 must be 64 hex digits");
  if (typeof doc.opencv !== "string") return bad("opencv must be a version string");
  const features = doc.features;
  if (!isObj(features) || features.type !== "orb") return bad("features.type must be orb: only ORB indexes are packed");
  if (!Array.isArray(doc.shards) || doc.shards.length === 0) return bad("shards must be a non-empty list");
  if (!Array.isArray(doc.cards)) return bad("cards must be a list");

  const shards: ShardInfo[] = [];
  const shardStart: number[] = [];
  let rows = 0;
  for (const [i, raw] of doc.shards.entries()) {
    if (!isObj(raw) || !isRelativePath(raw.path) || typeof raw.sha256 !== "string" || !HEX64.test(raw.sha256) || !isCount(raw.rows)) {
      return bad(`shards[${i}] must have a relative path, a 64-hex sha256 and a row count`);
    }
    shards.push({ path: raw.path, sha256: raw.sha256, rows: raw.rows });
    shardStart.push(rows);
    rows += raw.rows;
  }

  const used = shards.map(() => 0);
  const ids = new Set<string>();
  const cards: PackedCard[] = [];
  let lastShard = 0;
  for (const [i, raw] of doc.cards.entries()) {
    if (!isObj(raw) || typeof raw.cardId !== "string" || raw.cardId === "" || ids.has(raw.cardId)) return bad(`cards[${i}] has a missing or repeated cardId`);
    const where = `cards[${i}] (${raw.cardId})`;
    if (typeof raw.artV !== "string" || !HEX16.test(raw.artV)) return bad(`${where}: artV must be 16 lowercase hex digits`);
    if (!isCount(raw.width) || !isCount(raw.height) || !isCount(raw.n) || !isCount(raw.shard) || !isCount(raw.offset)) {
      return bad(`${where}: width, height, n, shard and offset must be whole numbers`);
    }
    const { shard, offset, n } = raw;
    if (shard >= shards.length) return bad(`${where}: shard ${shard} does not exist`);
    if (shard < lastShard) return bad(`${where}: cards must be in the shards' order`);
    if (offset !== used[shard]) return bad(`${where}: offset ${offset} is not where the shard's cards leave off (${used[shard]})`);
    lastShard = shard;
    used[shard] = offset + n;
    ids.add(raw.cardId);
    cards.push({ cardId: raw.cardId, artV: raw.artV, width: raw.width, height: raw.height, start: (shardStart[shard] as number) + offset, n });
  }
  for (const [i, shard] of shards.entries()) {
    if (used[i] !== shard.rows) return bad(`shards[${i}] has ${shard.rows} rows but its cards hold ${used[i]}`);
  }
  return { sourceSha256: source.sha256, bankSha256: bank.sha256, opencv: doc.opencv, features, cards, shards, shardStart, rows };
}

/** The index being filled shard by shard, so a shard's bytes can be dropped once copied. */
class Assembly {
  readonly desc: Uint8Array;
  readonly xy: Float32Array;
  constructor(readonly manifest: Manifest) {
    this.desc = new Uint8Array(manifest.rows * DESCRIPTOR_BYTES);
    this.xy = new Float32Array(manifest.rows * 2);
  }

  place(shard: number, bytes: ArrayBuffer): void {
    const info = this.manifest.shards[shard] as ShardInfo;
    if (bytes.byteLength !== info.rows * ROW_BYTES) {
      throw new GeometricIndexError("shard", `${info.path}: ${bytes.byteLength} bytes is not ${info.rows} rows of ${ROW_BYTES}`);
    }
    const first = this.manifest.shardStart[shard] as number;
    this.desc.set(new Uint8Array(bytes, 0, info.rows * DESCRIPTOR_BYTES), first * DESCRIPTOR_BYTES);
    // The positions are little-endian float32; every browser's typed arrays are little-endian.
    this.xy.set(new Float32Array(bytes, info.rows * DESCRIPTOR_BYTES, info.rows * 2), first * 2);
  }

  finish(): PackedIndex {
    const { manifest } = this;
    const rowCard = new Uint32Array(manifest.rows);
    for (const [position, card] of manifest.cards.entries()) rowCard.fill(position, card.start, card.start + card.n);
    return {
      cards: manifest.cards,
      desc: this.desc,
      xy: this.xy,
      rowCard,
      rows: manifest.rows,
      sourceSha256: manifest.sourceSha256,
      bankSha256: manifest.bankSha256,
      opencv: manifest.opencv,
      features: manifest.features,
    };
  }
}

/** Build the index from a parsed manifest document and its shards' bytes, in the manifest's
 *  order. Pure: it checks shapes and sizes, not hashes (`loadPackedIndex` does). */
export function parsePackedIndex(manifest: unknown, shards: ArrayBuffer[]): PackedIndex {
  const checked = checkManifest(manifest);
  if (shards.length !== checked.shards.length) {
    throw new GeometricIndexError("shard", `${shards.length} shards given, the manifest names ${checked.shards.length}`);
  }
  const assembly = new Assembly(checked);
  for (const [i, bytes] of shards.entries()) assembly.place(i, bytes);
  return assembly.finish();
}

export interface LoadOptions {
  /** The SHA-256 of the bank of the release that is loaded. */
  bankSha256: string;
  /** The card ids of that bank. Every one must have an entry in the index. */
  bankIds: string[];
  fetch?: typeof fetch;
  /** Where shards are kept between starts; omitted when the page has no Cache API. */
  cache?: CacheStorage;
  /** When given, the SHA-256 the manifest file's bytes must have: the manifest is pinned, and
   *  through it every shard. */
  manifestSha256?: string;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether an index serves a bank: same SHA-256 and a row for every bank card (the Python
 *  package's `bank_mismatch`, for the case of a bank the index records). */
export function checkBankBinding(manifest: { bankSha256: string; cards: { cardId: string }[] }, bankSha256: string, bankIds: string[]): void {
  if (manifest.bankSha256 !== bankSha256) {
    throw new GeometricIndexError("bank-sha", `the index was built for bank ${manifest.bankSha256.slice(0, 16)}, the release's is ${bankSha256.slice(0, 16)}`);
  }
  const have = new Set(manifest.cards.map((card) => card.cardId));
  const missing = bankIds.filter((id) => !have.has(id));
  if (missing.length > 0) {
    throw new GeometricIndexError("bank-ids", `the index has no entry for ${missing.length} card(s) of the bank (e.g. ${missing.slice(0, 3).join(", ")})`);
  }
}

/** Fetch the manifest and its shards (two at a time), check every shard's SHA-256 against the
 *  manifest, and return the index. Shards are kept in the Cache API (by URL, immutable) and
 *  hashed again each time they are read from it; one that no longer matches is fetched again
 *  once. The bank binding is checked from the manifest alone, before any shard is downloaded.
 *  When a shard fails, the other lane stops and its download is aborted. After a load that
 *  succeeds, the cache keeps only entries under the manifest's folder: the shards of an index
 *  no longer in use are deleted.
 *
 *  The loader does not ask for persistent storage: `navigator.storage.persist()` exists in a
 *  page, not in a worker, so the page that hosts the worker may call it. */
export async function loadPackedIndex(manifestUrl: string, opts: LoadOptions): Promise<PackedIndex> {
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const storage = opts.cache ?? (typeof caches === "undefined" ? undefined : caches);
  const abort = typeof AbortController === "undefined" ? null : new AbortController();

  const get = async (url: string, what: string): Promise<Response> => {
    let response: Response;
    try {
      response = await doFetch(url, abort ? { signal: abort.signal } : undefined);
    } catch (error) {
      throw new GeometricIndexError("shard", `${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new GeometricIndexError("shard", `${what}: HTTP ${response.status}`);
    return response;
  };

  let doc: unknown;
  const manifestBytes = await (await get(manifestUrl, "manifest")).arrayBuffer().catch((error: unknown) => {
    throw new GeometricIndexError("shard", `manifest: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (opts.manifestSha256 !== undefined) {
    const actual = await sha256Hex(manifestBytes);
    if (actual !== opts.manifestSha256.toLowerCase()) {
      throw new GeometricIndexError("manifest-sha", `the manifest's SHA-256 ${actual.slice(0, 16)} is not the pinned ${opts.manifestSha256.slice(0, 16)}`);
    }
  }
  try {
    doc = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (error) {
    throw new GeometricIndexError("manifest", `the manifest is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = checkManifest(doc);
  const manifestBase = new URL(manifestUrl, (globalThis as { location?: { href: string } }).location?.href).href;
  checkBankBinding(manifest, opts.bankSha256, opts.bankIds);

  const cache = storage ? await storage.open(INDEX_CACHE_NAME).catch(() => undefined) : undefined;
  const assembly = new Assembly(manifest);

  const shardBytes = async (i: number): Promise<ArrayBuffer> => {
    const info = manifest.shards[i] as ShardInfo;
    const absolute = new URL(info.path, manifestBase).href;
    const cached = cache ? await cache.match(absolute).catch(() => undefined) : undefined;
    if (cached) {
      const bytes = await cached.arrayBuffer();
      if ((await sha256Hex(bytes)) === info.sha256) return bytes;
      await cache?.delete(absolute).catch(() => false);
    }
    const bytes = await (await get(absolute, info.path)).arrayBuffer();
    const actual = await sha256Hex(bytes);
    if (actual !== info.sha256) throw new GeometricIndexError("hash", `${info.path}: SHA-256 ${actual.slice(0, 16)} is not the manifest's ${info.sha256.slice(0, 16)}`);
    await cache?.put(absolute, new Response(bytes.slice(0))).catch(() => undefined);
    return bytes;
  };

  let next = 0;
  let failed = false;
  const lane = async (): Promise<void> => {
    try {
      for (;;) {
        if (failed) return;
        const i = next++;
        if (i >= manifest.shards.length) return;
        const bytes = await shardBytes(i);
        if (failed) return;
        assembly.place(i, bytes);
      }
    } catch (error) {
      // The first failure stops the other lane: no further shard is started, and the one it is
      // downloading is aborted.
      if (!failed) {
        failed = true;
        abort?.abort();
        throw error;
      }
    }
  };
  const lanes = Array.from({ length: Math.min(SHARD_PARALLELISM, manifest.shards.length) }, lane);
  const settled = await Promise.allSettled(lanes);
  const rejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (rejected) throw rejected.reason;
  const index = assembly.finish();
  if (cache) await pruneCache(cache, new URL(".", manifestBase).href);
  return index;
}

/** Delete every cached entry outside `folder` (the current manifest's): an index no longer in use. */
async function pruneCache(cache: Cache, folder: string): Promise<void> {
  try {
    const keys = await cache.keys();
    await Promise.all(keys.filter((request) => !request.url.startsWith(folder)).map((request) => cache.delete(request)));
  } catch {
    // Best effort: a cache that cannot be listed keeps its entries.
  }
}
