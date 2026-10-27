// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { binaryBankVersion, decodeFp16Base64, type EmbeddingBank, isBinaryBank, parseBank, parseBankBinary } from "../src/bank.js";
import { groupsByName, IdentityMap, parseIdentityGroups } from "../src/identity.js";
import { DEFAULT_ACCEPT, EmbeddingRecognizer, NO_OTHER_IDENTITY } from "../src/recognizer.js";
import { axis, blend, contract, float32FromHex, sha } from "./support.js";

const fixture = contract.bank;
const FULL128 = { id: "full128", size: 128, centerMask: false, poolVersion: 2, crop: "truncate" };

function bankDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, kind: "embedding-bank", version: 3, model: "some-recognizer", dim: fixture.dim, preprocessing: FULL128, centerMask: false, entries: fixture.entries, ...overrides };
}

function groupsDoc(groups: string[][], representative: Record<string, string>): unknown {
  return { schemaVersion: 1, kind: "identity-groups", version: 1, groups, representative };
}

/** A bank of unit rows along chosen axes, for margins worked by hand. */
function handBank(ids: string[], rows: Float32Array[]): EmbeddingBank {
  const dim = rows[0]!.length;
  const matrix = new Float32Array(ids.length * dim);
  rows.forEach((row, i) => matrix.set(row, i * dim));
  return { ids, matrix, dim, version: 1, model: "hand", preprocessing: "full128", tau: null };
}

describe("the bank file", () => {
  it("decodes half floats: zero, one, a fraction, a negative, the smallest subnormal", () => {
    const bytes = Uint8Array.from([0x00, 0x00, 0x00, 0x3c, 0x00, 0x38, 0x00, 0xc0, 0x01, 0x00]);
    const text = Buffer.from(bytes).toString("base64");
    expect(Array.from(decodeFp16Base64(text, 5)!)).toEqual([0, 1, 0.5, -2, 2 ** -24]);
    expect(decodeFp16Base64(text, 4)).toBeNull();
    expect(decodeFp16Base64("not base64!", 5)).toBeNull();
  });

  it("reads the Python package's bank to the same float32 matrix, bit for bit", () => {
    const bank = parseBank(bankDoc())!;
    expect(bank.ids).toEqual(fixture.ids);
    expect([bank.dim, bank.version, bank.model, bank.preprocessing, bank.tau]).toEqual([128, 3, "some-recognizer", "full128", null]);
    expect(sha(bank.matrix)).toBe(fixture.matrixSha256);
  });

  it("renormalizes every row to unit length", () => {
    const bank = parseBank(bankDoc())!;
    for (let r = 0; r < bank.ids.length; r++) {
      let norm = 0;
      for (let k = 0; k < bank.dim; k++) norm += bank.matrix[r * bank.dim + k]! ** 2;
      expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
    }
  });

  it("takes the contract as an id or written out, and records tau when the file does", () => {
    expect(parseBank(bankDoc({ preprocessing: "full128" }))!.preprocessing).toBe("full128");
    expect(parseBank(bankDoc({ tau: 0.62 }))!.tau).toBe(0.62);
  });

  it("refuses the whole file on anything it cannot read", () => {
    const entries = fixture.entries as Array<{ cardId: string; vec: string }>;
    const zero = Buffer.alloc(fixture.dim * 2).toString("base64");
    const bad: Array<Record<string, unknown>> = [
      { kind: "something-else" },
      { version: "3" },
      { model: 7 },
      { dim: 0 },
      { dim: 64 },
      { entries: [] },
      { preprocessing: "another-contract" },
      { preprocessing: { ...FULL128, size: 96 } },
      { preprocessing: undefined },
      { centerMask: true },
      { tau: "0.62" },
      { entries: [...entries.slice(0, 2), { cardId: 5, vec: entries[0]!.vec }] },
      { entries: [...entries.slice(0, 2), { cardId: "X", vec: entries[0]!.vec.slice(4) }] },
      { entries: [...entries.slice(0, 2), { cardId: "X", vec: zero }] },
      { entries: [entries[0], null] },
    ];
    for (const change of bad) expect(parseBank(bankDoc(change)), JSON.stringify(change).slice(0, 80)).toBeNull();
    expect(parseBank(null)).toBeNull();
    expect(parseBank(bankDoc())).not.toBeNull();
  });
});

/** A binary bank's parts: its header object and the fp16 bytes after it. */
function splitBinary(bytes: Uint8Array): { header: Record<string, unknown>; values: Uint8Array } {
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  return { header: JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length))), values: bytes.subarray(12 + length) };
}

/** A binary bank put together from a header object and fp16 bytes, with the given magic. */
function joinBinary(header: unknown, values: Uint8Array, magic: number[] = [0x43, 0x56, 0x42, 0x41, 0x4e, 0x4b, 0x00, 0x01]): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(12 + text.length + values.length);
  out.set(magic, 0);
  new DataView(out.buffer).setUint32(8, text.length, true);
  out.set(text, 12);
  out.set(values, 12 + text.length);
  return out;
}

describe("the bank's binary form (bank.bin)", () => {
  const python = new Uint8Array(Buffer.from(fixture.binary as string, "base64"));

  it("reads the Python package's binary bank to the same ids and float32 matrix as its JSON form, bit for bit", () => {
    expect(isBinaryBank(python)).toBe(true);
    const fromJson = parseBank(bankDoc())!;
    const fromBinary = parseBankBinary(python)!;
    expect(fromBinary.ids).toEqual(fromJson.ids);
    expect(sha(fromBinary.matrix)).toBe(sha(fromJson.matrix));
    expect(sha(fromBinary.matrix)).toBe(fixture.matrixSha256);
    expect(fromBinary).toEqual(fromJson);
    expect(parseBankBinary(python.buffer.slice(python.byteOffset, python.byteOffset + python.byteLength) as ArrayBuffer)).toEqual(fromJson);
  });

  it("holds the bytes the JSON form's base64 text decodes to, after a header with the card ids", () => {
    const { header, values } = splitBinary(python);
    expect(header.cardIds).toEqual(fixture.ids);
    expect("entries" in header).toBe(false);
    const entries = fixture.entries as Array<{ vec: string }>;
    expect(Buffer.from(values).equals(Buffer.concat(entries.map((e) => Buffer.from(e.vec, "base64"))))).toBe(true);
  });

  it("refuses the whole file on anything it cannot read", () => {
    const { header, values } = splitBinary(python);
    expect(parseBankBinary(joinBinary(header, values))).not.toBeNull();
    const versionTwo = python.slice();
    versionTwo[7] = 2;
    expect(binaryBankVersion(versionTwo)).toBe(2);
    expect(parseBankBinary(versionTwo)).toBeNull();
    expect(parseBankBinary(joinBinary(header, values, [0x43, 0x56, 0x42, 0x41, 0x4e, 0x4c, 0x00, 0x01]))).toBeNull();
    expect(parseBankBinary(python.subarray(0, python.length - 1))).toBeNull();
    expect(parseBankBinary(python.subarray(0, python.length - 256))).toBeNull();
    expect(parseBankBinary(joinBinary(header, new Uint8Array([...values, 0, 0])))).toBeNull();
    expect(parseBankBinary(python.subarray(0, 20))).toBeNull();
    expect(parseBankBinary(python.subarray(0, 10))).toBeNull();
    const bad: Array<Record<string, unknown>> = [
      { entryCount: (header.entryCount as number) - 1 },
      { kind: "something-else" },
      { version: "3" },
      { dim: 64 },
      { dim: 0 },
      { dtype: "fp32" },
      { preprocessing: "another-contract" },
      { preprocessing: undefined },
      { cardIds: [...(header.cardIds as string[]).slice(1), 5] },
      { artVs: [null] },
      { entries: [] },
    ];
    for (const change of bad) expect(parseBankBinary(joinBinary({ ...header, ...change }, values)), JSON.stringify(change)).toBeNull();
    const zero = values.slice();
    zero.fill(0, 0, (header.dim as number) * 2);
    expect(parseBankBinary(joinBinary(header, zero))).toBeNull();
    expect(parseBankBinary(new TextEncoder().encode(JSON.stringify(bankDoc())))).toBeNull();
  });
});

describe("identity groups", () => {
  it("groups by exact name as the Python package does", () => {
    const names = new Map<string, string>(Object.entries(fixture.names));
    expect(groupsByName(fixture.ids, names)).toEqual(fixture.groups);
    // An id without a name is left alone; names differing in case are different names.
    expect(groupsByName(["B-2", "A-1", "A-1", "C-3", "D-4"], new Map([["A-1", "x"], ["B-2", "x"], ["C-3", "X"]]))).toEqual([["A-1", "B-2"]]);
  });

  it("reads a groups document and maps members to their representative", () => {
    const groups = parseIdentityGroups(groupsDoc(fixture.groups, fixture.representative))!;
    expect(groups.version).toBe(1);
    const map = new IdentityMap(groups);
    expect(map.collapsedCount).toBe(Object.keys(fixture.representative).length);
    // The identities, in the order of first appearance among the bank's rows.
    const identities: string[] = [];
    for (const id of fixture.ids as string[]) if (!identities.includes(map.of(id))) identities.push(map.of(id));
    expect(identities).toEqual(fixture.identityIds);
    expect(new IdentityMap().of("ANY-1")).toBe("ANY-1");
  });

  it("refuses the whole document on any inconsistency", () => {
    const ok = [["A-1", "A-1A"], ["B-1", "B-1A", "B-1B"]];
    const rep = { "A-1A": "A-1", "B-1A": "B-1", "B-1B": "B-1" };
    expect(parseIdentityGroups(groupsDoc(ok, rep))).not.toBeNull();
    const bad: unknown[] = [
      { ...(groupsDoc(ok, rep) as object), kind: "other" },
      { ...(groupsDoc(ok, rep) as object), schemaVersion: 2 },
      { ...(groupsDoc(ok, rep) as object), version: 1.5 },
      groupsDoc([["A-1"]], {}), // a group of one
      groupsDoc([["A-1", "A-1A"], ["A-1", "B-1"]], { "A-1A": "A-1", "B-1": "A-1" }), // an id in two groups
      groupsDoc(ok, { "A-1A": "A-1", "B-1A": "B-1" }), // a group with two representatives
      groupsDoc(ok, { ...rep, "A-1": "A-1A" }), // a group with none
      groupsDoc(ok, { ...rep, "B-1B": "B-1A" }), // a chain
      groupsDoc(ok, { ...rep, "A-1A": "B-1" }), // a representative from another group
      groupsDoc(ok, { ...rep, "Z-9": "A-1" }), // a member of no group
      null,
    ];
    for (const doc of bad) expect(parseIdentityGroups(doc)).toBeNull();
  });

  it("what is shown: the representative, or the printing that matched", () => {
    const groups = parseIdentityGroups(groupsDoc([["A-1", "A-1A"]], { "A-1A": "A-1" }));
    expect(new IdentityMap(groups).shown("A-1A")).toBe("A-1");
    const best = new IdentityMap(groups, undefined, "best-printing");
    expect([best.shown("A-1A"), best.of("A-1A")]).toEqual(["A-1A", "A-1"]);
  });

  it("sets aside a group whose representative cannot be shown, under the representative display only", () => {
    const groups = parseIdentityGroups(groupsDoc([["A-1", "A-1A"]], { "A-1A": "A-1" }));
    const known = (id: string) => id !== "A-1";
    expect(new IdentityMap(groups, known).of("A-1A")).toBe("A-1A");
    expect(new IdentityMap(groups, known, "best-printing").of("A-1A")).toBe("A-1");
  });
});

describe("the recognizer's looks", () => {
  it("gives the Python package's best row, score and margin for generated queries", () => {
    const bank = parseBank(bankDoc())!;
    const identity = new IdentityMap(parseIdentityGroups(groupsDoc(fixture.groups, fixture.representative)), undefined, "best-printing");
    const recognizer = new EmbeddingRecognizer(bank, DEFAULT_ACCEPT, identity);
    const queries = float32FromHex(fixture.queries);
    const looks = fixture.looks as Array<{ top: number; score: number; margin: number }>;
    expect(queries.length).toBe(looks.length * bank.dim);
    looks.forEach((want, i) => {
      const got = recognizer.matchScored(queries, i * bank.dim);
      expect(got.topId, `query ${i}`).toBe(bank.ids[want.top]);
      // The two sides add the same 128 products in a different order.
      expect(got.similarity).toBeCloseTo(want.score, 12);
      expect(got.margin).toBeCloseTo(want.margin, 12);
      expect(got.displayId).toBe(bank.ids[want.top]);
      expect(got.identity).toBe(identity.of(bank.ids[want.top]!));
    });
  });

  it("the published accept rule is tau 0.62, delta 0.05, with the rotation retry", () => {
    expect(DEFAULT_ACCEPT).toEqual({ tau: 0.62, delta: 0.05, rotationRetry: true });
  });

  it("two printings of one identity do not narrow each other's margin", () => {
    // Rows: A-1 along axis 0, A-1A almost the same, B-1 along axis 2.
    const bank = handBank(["A-1", "A-1A", "B-1"], [axis(8, 0), blend(8, 0, 1, 0.999), axis(8, 2)]);
    const grouped = new IdentityMap(parseIdentityGroups(groupsDoc([["A-1", "A-1A"]], { "A-1A": "A-1" })));
    const query = blend(8, 0, 1, 0.9995);
    const one = new EmbeddingRecognizer(bank, DEFAULT_ACCEPT, grouped).matchScored(query, 0);
    expect([one.identity, one.displayId]).toEqual(["A-1", "A-1"]);
    expect(one.margin).toBeGreaterThan(0.9); // measured against B-1, not against the other printing
    const apart = new EmbeddingRecognizer(bank, DEFAULT_ACCEPT).matchScored(query, 0);
    expect(apart.margin).toBeLessThan(0.01); // without groups the two printings rival each other
  });

  it("the first row wins an exact tie, and tau alone decides cardId", () => {
    const bank = handBank(["A-1", "B-1"], [axis(4, 0), axis(4, 0)]);
    const recognizer = new EmbeddingRecognizer(bank, { tau: 0.9, delta: 0.05, rotationRetry: true });
    const hit = recognizer.matchScored(axis(4, 0), 0);
    expect([hit.topId, hit.cardId, hit.similarity, hit.margin]).toEqual(["A-1", "A-1", 1, 0]);
    const miss = recognizer.matchScored(blend(4, 0, 1, 0.8), 0);
    expect([miss.topId, miss.cardId]).toEqual(["A-1", null]);
  });

  it("reads the embedding at an offset", () => {
    const bank = handBank(["A-1", "B-1"], [axis(4, 0), axis(4, 1)]);
    const recognizer = new EmbeddingRecognizer(bank, DEFAULT_ACCEPT);
    const two = new Float32Array(8);
    two.set(axis(4, 0), 0);
    two.set(axis(4, 1), 4);
    expect([recognizer.matchScored(two, 0).topId, recognizer.matchScored(two, 4).topId]).toEqual(["A-1", "B-1"]);
  });

  it("a bank of one identity has a margin that never refuses", () => {
    const bank = handBank(["A-1"], [axis(4, 0)]);
    const look = new EmbeddingRecognizer(bank, DEFAULT_ACCEPT).matchScored(axis(4, 0), 0);
    expect(look.margin).toBe(1 - NO_OTHER_IDENTITY);
  });

  it("a pooled match needs both tau and the margin, and shows the display id", () => {
    const bank = handBank(["A-1", "A-1A", "B-1"], [axis(8, 0), blend(8, 0, 1, 0.999), axis(8, 2)]);
    const groups = parseIdentityGroups(groupsDoc([["A-1", "A-1A"]], { "A-1A": "A-1" }));
    const rule = { tau: 0.62, delta: 0.05, rotationRetry: true };
    const representative = new EmbeddingRecognizer(bank, rule, new IdentityMap(groups));
    expect(representative.matchPooled(blend(8, 0, 1, 0.999)).cardId).toBe("A-1");
    const printing = new EmbeddingRecognizer(bank, rule, new IdentityMap(groups, undefined, "best-printing"));
    expect(printing.matchPooled(blend(8, 0, 1, 0.999)).cardId).toBe("A-1A");
    // Torn between A and B: the score reaches tau, the margin does not.
    const torn = representative.matchPooled(blend(8, 0, 2, Math.SQRT1_2));
    expect(torn.cardId).toBeNull();
    expect(torn.similarity).toBeGreaterThan(0.62);
    expect(torn.margin).toBeLessThan(0.05);
    // Below tau.
    expect(representative.matchPooled(axis(8, 5)).cardId).toBeNull();
    // The margin test is inclusive, and the rule's delta is the default.
    expect(representative.matchPooled(blend(8, 0, 2, Math.SQRT1_2), 0).cardId).toBe("A-1");
  });
});
