// SPDX-License-Identifier: Apache-2.0
// The embedding bank: the reference embeddings a crop is compared against.
// In Python: cardvision/core/bank.py (the storage format), cardvision/core/bank_binary.py (its
// binary form) and cardvision/bank/build.py.
//
// A bank file is one JSON document. Each entry holds a card id and its embedding as base64 of
// little-endian IEEE half floats (fp16). A card may have several entries. Half floats keep the
// file small, at the cost that a stored row is no longer exactly unit length, so every reader
// renormalizes: each stored row is widened to double precision, its norm is taken in double
// precision, and the quotient is narrowed to float32. Every runtime then scores against the
// same matrix.
//
// The same bank can also be a binary file (`bank.bin`) holding the same fp16 bytes: the magic
// "CVBANK", a 0x00 byte and the format version (1); a u32 little-endian length H; H bytes of
// UTF-8 JSON, the bank document with its entries replaced by `cardIds` (and `artVs`, which
// scoring does not read); then entryCount x dim fp16 values, row by row. Both forms parse to
// the same EmbeddingBank.

import { contractOf, isPreprocessingId, PREPROCESSING, type PreprocessingId } from "./preprocess.js";

export const BANK_KIND = "embedding-bank";
/** The first seven bytes of a binary bank, before its format version byte: "CVBANK\0". */
const BINARY_PREFIX = [0x43, 0x56, 0x42, 0x41, 0x4e, 0x4b, 0x00];
/** The binary bank format version this runtime reads. */
export const BANK_BINARY_VERSION = 1;
const BINARY_HEADER_START = BINARY_PREFIX.length + 1 + 4;

/** A parsed bank: row `i` of `matrix` (`dim` values, unit length) belongs to `ids[i]`. */
export interface EmbeddingBank {
  ids: string[];
  /** `ids.length * dim` values, row-major. */
  matrix: Float32Array;
  dim: number;
  /** The bank's own version number. */
  version: number;
  /** The label of the recognizer that made the rows. */
  model: string;
  /** The preprocessing contract the rows were made with. */
  preprocessing: PreprocessingId;
  /** The accept threshold the file records, when it records one. */
  tau: number | null;
}

/** Widen `dim` little-endian half floats, starting at `offset` of `bytes`, to float32. This is
 *  the runtime's one fp16 decode: both forms of the bank go through it. */
export function decodeFp16(bytes: Uint8Array, offset: number, dim: number): Float32Array {
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const h = bytes[offset + i * 2]! | (bytes[offset + i * 2 + 1]! << 8);
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    if (exp === 0) out[i] = sign * frac * 2 ** -24;
    else if (exp === 31) out[i] = frac ? NaN : sign * Infinity;
    else out[i] = sign * (1 + frac / 1024) * 2 ** (exp - 15);
  }
  return out;
}

/** Decode base64 text of `dim` little-endian half floats; null when it is anything else. */
export function decodeFp16Base64(b64: string, dim: number): Float32Array | null {
  let raw: string;
  try {
    raw = atob(b64);
  } catch {
    return null;
  }
  if (raw.length !== dim * 2) return null;
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return decodeFp16(bytes, 0, dim);
}

/** The contract a bank's `preprocessing` field names: an id, or the contract written out as an
 *  object that equals it field for field. Null for anything this runtime cannot reproduce. */
function bankContract(raw: unknown): PreprocessingId | null {
  return isPreprocessingId(raw) ? raw : contractOf(raw);
}

type BankHeader = Omit<EmbeddingBank, "ids" | "matrix">;

/** The fields every bank document carries, checked; null when one is wrong. Both forms. */
function bankHeader(obj: Record<string, unknown>): BankHeader | null {
  if (
    obj.kind !== BANK_KIND ||
    typeof obj.version !== "number" ||
    !Number.isInteger(obj.version) ||
    typeof obj.model !== "string" ||
    typeof obj.dim !== "number" ||
    !Number.isInteger(obj.dim) ||
    obj.dim <= 0
  ) {
    return null;
  }
  const preprocessing = bankContract(obj.preprocessing);
  if (preprocessing === null) return null;
  if (obj.centerMask !== undefined && obj.centerMask !== PREPROCESSING[preprocessing].centerMask) return null;
  if (obj.tau !== undefined && typeof obj.tau !== "number") return null;
  return { dim: obj.dim, version: obj.version, model: obj.model, preprocessing, tau: typeof obj.tau === "number" ? obj.tau : null };
}

/** Write stored row `v`, renormalized, as row `i` of `matrix`; false when it cannot be normalized. */
function putUnitRow(matrix: Float32Array, i: number, v: Float32Array): boolean {
  const dim = v.length;
  let norm = 0;
  for (let k = 0; k < dim; k++) norm += v[k]! * v[k]!;
  norm = Math.sqrt(norm);
  if (!(norm > 0) || !Number.isFinite(norm)) return false;
  for (let k = 0; k < dim; k++) matrix[i * dim + k] = v[k]! / norm;
  return true;
}

/**
 * Check and unpack a bank document. The whole document is refused (null) on any bad entry: a
 * bank with rows missing would name the wrong cards, which is worse than naming none.
 */
export function parseBank(raw: unknown): EmbeddingBank | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const header = bankHeader(obj);
  if (header === null || !Array.isArray(obj.entries) || obj.entries.length === 0) return null;
  const dim = header.dim;
  const ids: string[] = [];
  const matrix = new Float32Array(obj.entries.length * dim);
  for (let i = 0; i < obj.entries.length; i++) {
    const e = obj.entries[i] as Record<string, unknown> | null;
    if (typeof e !== "object" || e === null || typeof e.cardId !== "string" || typeof e.vec !== "string") return null;
    const v = decodeFp16Base64(e.vec, dim);
    if (!v || !putUnitRow(matrix, i, v)) return null;
    ids.push(e.cardId);
  }
  return { ids, matrix, ...header };
}

/** Whether bytes are a binary bank, of any format version: they start with "CVBANK\0". */
export function isBinaryBank(bytes: Uint8Array): boolean {
  return bytes.length >= BINARY_PREFIX.length && BINARY_PREFIX.every((b, i) => bytes[i] === b);
}

/** The format version of a binary bank (the byte after "CVBANK\0"); null for other bytes. */
export function binaryBankVersion(bytes: Uint8Array): number | null {
  return isBinaryBank(bytes) && bytes.length > BINARY_PREFIX.length ? bytes[BINARY_PREFIX.length]! : null;
}

/**
 * Check and unpack a binary bank (`bank.bin`). Refused (null) on anything wrong, as a JSON bank
 * is: another magic or format version, a header that is not a bank's, an entryCount that is not
 * the number of card ids, or a body that is not exactly entryCount x dim fp16 values.
 */
export function parseBankBinary(data: Uint8Array | ArrayBuffer): EmbeddingBank | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (binaryBankVersion(bytes) !== BANK_BINARY_VERSION || bytes.length < BINARY_HEADER_START) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(BINARY_PREFIX.length + 1, true);
  if (bytes.length < BINARY_HEADER_START + length) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(BINARY_HEADER_START, BINARY_HEADER_START + length)));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const doc = obj as Record<string, unknown>;
  const header = bankHeader(doc);
  if (header === null || "entries" in doc || (doc.dtype !== undefined && doc.dtype !== "fp16")) return null;
  const ids = doc.cardIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string") || doc.entryCount !== ids.length) return null;
  const artVs = doc.artVs;
  if (artVs !== undefined && (!Array.isArray(artVs) || artVs.length !== ids.length || !artVs.every((a) => a === null || typeof a === "string"))) return null;
  const dim = header.dim;
  const start = BINARY_HEADER_START + length;
  if (bytes.length - start !== ids.length * dim * 2) return null;
  const matrix = new Float32Array(ids.length * dim);
  for (let i = 0; i < ids.length; i++) {
    if (!putUnitRow(matrix, i, decodeFp16(bytes, start + i * dim * 2, dim))) return null;
  }
  return { ids: ids as string[], matrix, ...header };
}
