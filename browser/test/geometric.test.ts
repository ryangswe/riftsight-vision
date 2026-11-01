// SPDX-License-Identifier: Apache-2.0
// The geometric stage against the Python package: `fixtures/geometric.json` holds inputs and
// the answers cardvision.geometric gives for them (written and checked by
// tests/test_browser_geometric_fixtures.py at the top of the repository).
//
// The end-to-end scenes need OpenCV.js: this runtime's build in vendor/opencv/ (written by
// scripts/build-opencv.mjs), or the module CARDVISION_OPENCV_JS names (opencv.mjs, or another
// build's opencv.js). Without one they are skipped.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import type { EmbeddingBank } from "../src/bank.js";
import { rectOf } from "../src/boxes.js";
import type { BatchEmbedder } from "../src/embedder.js";
import { DEFAULTS, GeometricConfigError, parseGeometric } from "../src/geometric/config.js";
import { resizeDirection, ROW_HASH_DIGITS, rowHashes, sha256Hex } from "../src/geometric/debug.js";
import { type CropFeatures, type Cv, extractOrb, pyRoundHalfEven, scaledGrey, scaledSize, strongestFirst } from "../src/geometric/features.js";
import { baselineOf, evidenceOf, evidenceToJson, fusedScore, fuseRow, median, pyRound, type StageResult, type Verified } from "../src/geometric/fusion.js";
import { countVotes, type KnnPairs, NO_ROW } from "../src/geometric/match.js";
import { loadOpenCV } from "../src/geometric/opencv.js";
import { cpuVoter } from "../src/geometric/vote.js";
import { fnmatchcase, GeometricStage, opencvNote, sameFeatures, GeometricWatchdog, openGeometricStage, type StageIndex, type StageVoter, type VerifyItem, voteIdentities } from "../src/geometric/stage.js";
import { IdentityMap, parseIdentityGroups } from "../src/identity.js";
import type { FrameDetector } from "../src/detector/detector.js";
import { Pipeline } from "../src/pipeline.js";
import { recognizeFrame } from "../src/recognition.js";
import { type AcceptRule, EmbeddingRecognizer } from "../src/recognizer.js";
import { evidenceLine, rgbSha256 } from "../score/evidence.js";
import { positionOutcome } from "../score/run.js";
import { runScene, SCENE_TIMES, sceneFrame, scenePipeline } from "./no-stage-scene.js";
import { FIXTURES, Stream, solidFrame } from "./support.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixture: any = JSON.parse(readFileSync(`${FIXTURES}geometric.json`, "utf-8"));

/** A double from the hexadecimal text of its big-endian bytes. */
function fromHex(hex: string): number {
  return Buffer.from(hex, "hex").readDoubleBE(0);
}

function hexOf(x: number): string {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return b.toString("hex");
}

describe("the settings", () => {
  it("are read as Python reads them: the full settings, or every error", () => {
    for (const c of fixture.config) {
      if (c.errors) {
        let caught: unknown = null;
        try {
          parseGeometric(c.doc);
        } catch (error) {
          caught = error;
        }
        expect(caught, JSON.stringify(c.doc)).toBeInstanceOf(GeometricConfigError);
        expect((caught as GeometricConfigError).errors).toEqual(c.errors);
      } else {
        const config = parseGeometric(c.doc);
        expect(config.toJson()).toEqual(c.settings);
        expect(JSON.stringify(config.toJson())).toBe(JSON.stringify(c.settings)); // the same keys in the same order
        expect([config.indexPath, config.indexSha256]).toEqual([c.indexPath, c.indexSha256]);
      }
    }
  });

  it("round-trip: the full settings read again give themselves", () => {
    for (const c of fixture.config.filter((x: { errors?: unknown }) => !x.errors)) {
      const once = parseGeometric(c.doc).toJson();
      expect(parseGeometric(once).toJson()).toEqual(once);
    }
  });

  it("toJson is a copy: changing it changes nothing loaded", () => {
    const config = parseGeometric({});
    config.toJson().fusion.weight = 9;
    expect(config.settings.fusion.weight).toBe(DEFAULTS.fusion.weight);
  });

  it("the loaded settings are frozen, to the innermost value, and a copy of what was given", () => {
    const config = parseGeometric({ features: { mask: [[0, 0, 0.5, 0.5]] } });
    const settings = config.settings as unknown as { fusion: { weight: number }; features: { mask: number[][]; params: Record<string, number> } };
    expect(() => { settings.fusion.weight = 9; }).toThrow(TypeError);
    expect(() => { settings.features.mask[0]![0] = 1; }).toThrow(TypeError);
    expect(() => { settings.features.params.nLevels = 1; }).toThrow(TypeError);
    expect(Object.isFrozen(config.settings)).toBe(true);
  });

  it("a relative index path is resolved against the settings' URL", () => {
    const config = parseGeometric({ index: { path: "index/manifest.json", sha256: "a".repeat(64) } }, "https://cdn.example/geo/settings.json");
    expect(config.indexPath).toBe("https://cdn.example/geo/index/manifest.json");
  });
});

describe("the arithmetic", () => {
  it("rounds to 6 decimals as Python's round does, ties to even", () => {
    for (const c of fixture.round) expect(hexOf(pyRound(fromHex(c.x), 6)), String(fromHex(c.x))).toBe(c.rounded);
  });

  it("rounds a size as Python's round does", () => {
    expect([0.5, 1.5, 2.5, 3.5, 2.4999, -0.5].map(pyRoundHalfEven)).toEqual([0, 2, 2, 4, 2, -0]);
    expect(scaledSize(114, 160, 160)).toEqual({ size: [114, 160], scale: 1 });
    expect(scaledSize(260, 340, 160).size).toEqual([122, 160]);
  });

  it("frees every matrix it made when OpenCV throws while scaling", () => {
    let live = 0;
    class Mat {
      data = new Uint8Array(64 * 4);
      rows = 0;
      cols = 0;
      constructor() { live += 1; }
      delete() { live -= 1; }
    }
    const cv = {
      Mat, CV_8UC4: 24, COLOR_RGBA2GRAY: 11, INTER_AREA: 3, INTER_LINEAR: 1,
      Size: class { constructor(readonly width: number, readonly height: number) {} },
      cvtColor: () => {},
      resize: () => { throw new Error("OpenCV abort"); },
    } as unknown as Cv;
    expect(() => scaledGrey(cv, new Uint8Array(8 * 8 * 4), 8, 8, 4)).toThrow("OpenCV abort");
    expect(live).toBe(0);
  });

  it("fuses bit for bit, at the floor and the cap of the inliers", () => {
    const fusion = fixture.fusion.fusion;
    for (const c of fixture.fusion.cases) {
      const evidence = evidenceOf(c.inliers, 0);
      expect(hexOf(fusedScore(fromHex(c.cosine), evidence, fusion)), `inliers ${c.inliers}`).toBe(c.fused);
    }
    const inliers = fixture.fusion.cases.map((c: { inliers: number }) => c.inliers);
    expect(new Set(inliers)).toEqual(new Set([0, 1, 14, 15, 16, 30, 49, 50, 51, 200]));
  });

  it("takes the median baseline as NumPy does", () => {
    const { fusion, cases } = fixture.fusion.median;
    for (const c of cases) {
      const baseline = baselineOf(c.inliers, fusion);
      expect(hexOf(baseline)).toBe(c.baseline);
      c.inliers.forEach((n: number, k: number) => {
        const evidence = evidenceOf(n, baseline);
        expect(hexOf(evidence)).toBe(c.evidence[k]);
        expect(hexOf(fusedScore(fromHex(c.cosine), evidence, fusion))).toBe(c.fused[k]);
      });
    }
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(baselineOf([4, 1], { ...fusion, baseline: "none" })).toBe(0);
  });

  it("moves every row of a verified card by its fused score less its cosine", () => {
    const row = new Float64Array([0.5, 0.25, 0.75]);
    const found: Verified = { cardId: "A", cosine: 0.5, foundBy: "embedding", votes: 0, matches: 20, inliers: 20, evidence: 20, fused: 1.1, indexed: true };
    const fused = fuseRow(row, [found], (id) => (id === "A" ? [0, 2] : []));
    expect(Array.from(fused)).toEqual([0.5 + (1.1 - 0.5), 0.25, 0.75 + (1.1 - 0.5)]);
    expect(Array.from(row)).toEqual([0.5, 0.25, 0.75]);
  });
});

describe("the vote", () => {
  it("counts as Python does: the ratio test, waived for one card, one identity, one image", () => {
    const v = fixture.vote;
    const n = v.pairs.length;
    const knn: KnnPairs = { best: new Uint32Array(n), second: new Uint32Array(n), dBest: new Uint16Array(n), dSecond: new Uint16Array(n) };
    v.pairs.forEach((pair: number[][], q: number) => {
      knn.best[q] = pair[0]![0]!;
      knn.dBest[q] = pair[0]![1]!;
      knn.second[q] = pair.length > 1 ? pair[1]![0]! : NO_ROW;
      knn.dSecond[q] = pair.length > 1 ? pair[1]![1]! : 0xffff;
    });
    const identity = v.ids.map((id: string) => v.identities[id] ?? id);
    const image = v.ids.map((id: string) => v.images[id]);
    const counts = countVotes(knn, n, 0, Uint32Array.from(v.rowCard), identity, image, v.ratio);
    const named = Object.fromEntries([...counts].map(([position, count]) => [v.ids[position], count]));
    expect(named).toEqual(v.votes);
    expect(Object.keys(named)).toEqual(Object.keys(v.votes)); // in the order Python's dictionary has them
  });

  it("counts a range of queries only, and skips a query without a neighbour", () => {
    const knn: KnnPairs = {
      best: Uint32Array.from([0, NO_ROW, 1]),
      second: Uint32Array.from([NO_ROW, NO_ROW, NO_ROW]),
      dBest: Uint16Array.from([1, 0xffff, 1]),
      dSecond: Uint16Array.from([0xffff, 0xffff, 0xffff]),
    };
    expect([...countVotes(knn, 2, 1, Uint32Array.from([0, 1]), ["a", "b"], ["x", "y"], 0.8)]).toEqual([[1, 1]]);
  });
});

describe("the stage's gate, identities and watchdog", () => {
  it("runs below the accept rule only when asked, and on matching sources only when a list is given", () => {
    const stage = Object.create(GeometricStage.prototype) as GeometricStage;
    const withGate = (gate: object): GeometricStage => Object.assign(Object.create(stage), { config: parseGeometric({ gate }) });
    expect(withGate({}).applies(null, true)).toBe(true);
    expect(withGate({ belowAccept: true }).applies(null, true)).toBe(false);
    expect(withGate({ belowAccept: true }).applies(null, false)).toBe(true);
    expect(withGate({ sources: ["physical/*"] }).applies(null, false)).toBe(false);
    expect(withGate({ sources: ["physical/*"] }).applies("physical/table", false)).toBe(true);
    expect([fnmatchcase("a.b", "a?b"), fnmatchcase("ab", "a[!b]"), fnmatchcase("ac", "a[!b]"), fnmatchcase("A", "a")]).toEqual([true, false, true, false]);
  });

  it("keys identities as Python's evaluation does: the catalog's rule, the groups over it", () => {
    const groups = parseIdentityGroups({ schemaVersion: 1, kind: "identity-groups", version: 1, groups: [["A-1", "A-1A"]], representative: { "A-1A": "A-1" } })!;
    const cards = [
      { id: "A-1", name: "Alder", printingOf: null },
      { id: "A-1A", name: "Alder", printingOf: "A-1" },
      { id: "B-1", name: "Birch", printingOf: null },
      { id: "B-2", name: "Birch", printingOf: null },
    ];
    expect(Object.fromEntries(voteIdentities(cards, "name", groups))).toEqual({ "A-1": "group:A-1", "A-1A": "group:A-1", "B-1": "Birch", "B-2": "Birch" });
    expect(voteIdentities(cards, "printing", null).get("A-1A")).toBe("A-1");
  });

  it("the watchdog trips on two frames in a row over the limit, not on one", () => {
    const dog = new GeometricWatchdog();
    expect([dog.observe(1600), dog.observe(100), dog.observe(1501), dog.observe(1500), dog.observe(1600), dog.observe(1700)]).toEqual([false, false, false, false, false, true]);
  });
});

// ------------------------------------------------------------------------------------- seam

/** A fake stage: the verified cards and inlier counts it is given, fused with the settings. */
function fakeStage(reorder: boolean, verified: Array<{ cardId: string; inliers: number }>, calls: Array<{ ranked: unknown; width: number }> = []): GeometricStage {
  const config = parseGeometric({ ...fixture.config[1].doc, fusion: { ...fixture.config[1].doc.fusion, reorder } });
  return {
    reorder,
    applies: () => true,
    verifyBatch: async (items: Array<{ ranked: Array<{ cardId: string; cosine: number }>; width: number }>): Promise<StageResult[]> =>
      items.map((item) => {
        calls.push({ ranked: item.ranked, width: item.width });
        const cosineOf = new Map(item.ranked.map((r) => [r.cardId, r.cosine]));
        return {
          cropKeypoints: 0,
          ms: 0,
          candidates: verified.map(({ cardId, inliers }) => {
            const cosine = cosineOf.get(cardId)!;
            return { cardId, cosine, foundBy: "embedding", votes: 0, matches: inliers, inliers, evidence: inliers, fused: fusedScore(cosine, inliers, config.settings.fusion), indexed: true } as Verified;
          }),
        };
      }),
  } as unknown as GeometricStage;
}

/** A recognizer whose bank rows are the axes, so an embedding's values are its cosines. */
function axisRecognizer(ids: string[], identities: Record<string, string>, rule: AcceptRule): EmbeddingRecognizer {
  const dim = ids.length;
  const matrix = new Float32Array(dim * dim);
  for (let r = 0; r < dim; r++) matrix[r * dim + r] = 1;
  const bank: EmbeddingBank = { ids, matrix, dim, version: 1, model: "fake", preprocessing: "full128", tau: null };
  const reps = new Map<string, string[]>();
  for (const [member, rep] of Object.entries(identities)) reps.set(rep, [...(reps.get(rep) ?? [rep]), member]);
  const groups = parseIdentityGroups({ schemaVersion: 1, kind: "identity-groups", version: 1, groups: [...reps.values()], representative: identities });
  return new EmbeddingRecognizer(bank, rule, new IdentityMap(groups, undefined, "best-printing"));
}

class ConstantEmbedder implements BatchEmbedder {
  constructor(private readonly looks: Float32Array[]) {}
  batches = 0;
  async embedBatch(_data: Float32Array, n: number): Promise<Float32Array> {
    const dim = this.looks[0]!.length;
    const out = new Float32Array(n * dim);
    // The first batch is upright (look 0); a second holds the three turns of each retried crop.
    const first = this.batches++ === 0;
    for (let i = 0; i < n; i++) out.set(this.looks[first ? 0 : 1 + (i % 3)]!, i * dim);
    return out;
  }
}

const face = { aabb: { x: 0, y: 0, width: 40, height: 56 }, rect: rectOf({ x: 0, y: 0, width: 40, height: 56 }), score: 0.9, cls: 0 };

describe("the seam in the recognizer", () => {
  it("the fused look replaces the answer as Python's recognizer gives it, re-ranking and boosting", async () => {
    expect(fixture.seam.length).toBeGreaterThanOrEqual(8);
    for (const c of fixture.seam) {
      const rule: AcceptRule = { tau: c.rule.tau, delta: c.rule.delta, rotationRetry: false };
      const recognizer = axisRecognizer(c.ids, c.identities, rule);
      const cosines = Float32Array.from(c.cosines.map(fromHex));
      const frame = await recognizeFrame(solidFrame(40, 56), new ConstantEmbedder([cosines]), recognizer, [face], 1, fakeStage(c.reorder, c.verified));
      const p = frame.proposals[0]!;
      const label = `${c.reorder ? "reorder" : "boost"} ${JSON.stringify(c.verified)}`;
      expect(p.topId, label).toBe(c.expected.topId);
      expect(hexOf(p.score), label).toBe(c.expected.similarity);
      expect(hexOf(p.margin), label).toBe(c.expected.margin);
      expect([p.tauPassed, p.accepted], label).toEqual([c.expected.tauPassed, c.expected.accepted]);
      expect(p.geometric, label).toEqual(c.expected.geometric);
      expect(p.embedding !== null).toBe(p.tauPassed);
    }
  });

  it("gives the stage each card once by its best row, best first, and the raw upright crop", async () => {
    const ids = ["A", "B", "A", "C"];
    const recognizer = axisRecognizer(ids, {}, { tau: 0.62, delta: 0.05, rotationRetry: false });
    const calls: Array<{ ranked: unknown; width: number }> = [];
    await recognizeFrame(solidFrame(40, 56), new ConstantEmbedder([Float32Array.from([0.25, 0.5, 0.75, 0.5])]), recognizer, [face], 1, fakeStage(true, [], calls));
    expect(calls).toEqual([{ ranked: [{ cardId: "A", cosine: 0.75 }, { cardId: "B", cosine: 0.5 }, { cardId: "C", cosine: 0.5 }], width: 40 }]);
  });

  it("keeps the orientation the cosines chose, and fuses that look's row", async () => {
    const ids = ["A", "B", "C"];
    const rule: AcceptRule = { tau: 0.62, delta: 0.05, rotationRetry: true };
    const recognizer = axisRecognizer(ids, {}, rule);
    const looks = [Float32Array.from([0.1, 0.1, 0.1]), Float32Array.from([0.2, 0.1, 0]), Float32Array.from([0.3, 0.5, 0.2]), Float32Array.from([0.1, 0, 0])];
    const frame = await recognizeFrame(solidFrame(40, 56), new ConstantEmbedder(looks), recognizer, [face], 1, fakeStage(true, [{ cardId: "C", inliers: 50 }]));
    const p = frame.proposals[0]!;
    expect([p.orientation, p.retried, p.topId, p.accepted]).toEqual([2, true, "C", true]);
    expect(p.score).toBe(Math.fround(0.2) + (Math.fround(0.2) + 1.5 - Math.fround(0.2)));
    expect(p.geometric!.before).toEqual({ topId: "B", similarity: 0.5, margin: pyRound(0.5 - Math.fround(0.3), 6), accepted: false });
    expect(Array.from(p.embedding!)).toEqual(Array.from(looks[2]!));
    expect(frame.geometricMs).toBeGreaterThanOrEqual(0);
  });

  it("without a stage the frame's recognition is exactly what it was", async () => {
    const ids = ["A", "B", "C"];
    const rule: AcceptRule = { tau: 0.62, delta: 0.05, rotationRetry: true };
    const looks = [Float32Array.from([0.7, 0.1, 0.1]), Float32Array.from([0.2, 0.1, 0]), Float32Array.from([0.3, 0.5, 0.2]), Float32Array.from([0.1, 0, 0])];
    const run = (stage?: GeometricStage | null) => recognizeFrame(solidFrame(40, 56), new ConstantEmbedder(looks), axisRecognizer(ids, {}, rule), [face], 1, stage);
    const plain = await run();
    expect(JSON.stringify(await run(null))).toBe(JSON.stringify(plain));
    expect(Object.keys(plain)).toEqual(["proposals", "kept", "retried", "embeddings"]);
    expect("geometric" in plain.proposals[0]!).toBe(false);
  });
});

// ----------------------------------------------------------------------------------- scenes
const CARD_W = 120;
const CARD_H = 168;

/** A toy card, as tests/test_browser_geometric_fixtures.py draws it (RGB). */
function cardRgb(seed: number): Uint8Array {
  const s = new Stream(seed);
  const image = new Uint8Array(CARD_W * CARD_H * 3);
  const bg = [s.below(256), s.below(256), s.below(256)];
  for (let i = 0; i < CARD_W * CARD_H; i++) image.set(bg, i * 3);
  for (let k = 0; k < 40; k++) {
    const x0 = s.below(CARD_W);
    const y0 = s.below(CARD_H);
    const w = 4 + s.below(Math.floor(CARD_W / 3));
    const h = 4 + s.below(Math.floor(CARD_H / 3));
    const color = [s.below(256), s.below(256), s.below(256)];
    for (let y = y0; y < Math.min(CARD_H, y0 + h); y++) for (let x = x0; x < Math.min(CARD_W, x0 + w); x++) image.set(color, (y * CARD_W + x) * 3);
  }
  return image;
}

/** A toy crop, as the Python side makes it, in RGBA. */
function sceneRgba(card: Uint8Array | null, [width, height]: number[], [ox, oy, sw, sh]: number[], seed: number, turned: boolean): Uint8ClampedArray {
  const s = new Stream(seed);
  const image = new Uint8ClampedArray(width! * height! * 4);
  for (let by = 0; by < height!; by += 8) {
    for (let bx = 0; bx < width!; bx += 8) {
      const color = [s.below(256), s.below(256), s.below(256), 255];
      for (let y = by; y < Math.min(height!, by + 8); y++) for (let x = bx; x < Math.min(width!, bx + 8); x++) image.set(color, (y * width! + x) * 4);
    }
  }
  if (card) {
    for (let y = Math.max(0, oy!); y < Math.min(height!, oy! + sh!); y++) {
      for (let x = Math.max(0, ox!); x < Math.min(width!, ox! + sw!); x++) {
        let sx = Math.floor(((x - ox!) * CARD_W) / sw!);
        let sy = Math.floor(((y - oy!) * CARD_H) / sh!);
        if (turned) {
          sx = CARD_W - 1 - sx;
          sy = CARD_H - 1 - sy;
        }
        const at = (sy * CARD_W + sx) * 3;
        image.set([card[at]!, card[at + 1]!, card[at + 2]!, 255], (y * width! + x) * 4);
      }
    }
  }
  return image;
}

/** The two nearest rows by Hamming distance, nearest first, the lower row on a tie. */
/** The vote's CPU reference (vote.ts), as the stage's voter. */
function cpuKnn(desc: Uint8Array): StageVoter {
  return cpuVoter(desc);
}

function packedIndex(cards: Array<{ cardId: string; artV: string; width: number; height: number; n: number; xy: string; desc: string }>): StageIndex {
  const rows = cards.reduce((sum, c) => sum + c.n, 0);
  const desc = new Uint8Array(rows * 32);
  const xy = new Float32Array(rows * 2);
  const rowCard = new Uint32Array(rows);
  let start = 0;
  const packed = cards.map((c, position) => {
    const d = Buffer.from(c.desc, "base64");
    const p = Buffer.from(c.xy, "base64");
    desc.set(d, start * 32);
    xy.set(new Float32Array(p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength)), start * 2);
    rowCard.fill(position, start, start + c.n);
    const card = { cardId: c.cardId, artV: c.artV, width: c.width, height: c.height, start, n: c.n };
    start += c.n;
    return card;
  });
  return {
    cards: packed, desc, xy, rowCard, rows, sourceSha256: "0".repeat(64), bankSha256: "0".repeat(64), opencv: "test",
    features: parseGeometric({}).settings.features,
  };
}

/** OpenCV.js from `path`: this runtime's build (an ES module, `opencv.mjs`) through opencv.ts,
 *  or another build's classic `opencv.js`. */
async function loadCv(path: string): Promise<Cv> {
  if (path.endsWith(".mjs")) return (await loadOpenCV(pathToFileURL(path).href)) as Cv;
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cv: any = require(path);
  if (cv instanceof Promise) cv = await cv;
  else if (!cv.Mat && typeof cv.then === "function") {
    // An Emscripten module is a thenable that calls back once its runtime is ready.
    cv = await new Promise((resolve) =>
      cv.then((ready: { then?: unknown }) => {
        delete ready.then;
        resolve(ready);
      }),
    );
  } else if (!cv.Mat) await new Promise<void>((resolve) => (cv.onRuntimeInitialized = resolve));
  return cv as Cv;
}

interface SceneCase {
  card: number | null;
  size: number[];
  place: number[];
  seed: number;
  turned: boolean;
  ranked: Array<[string, number]>;
  cropKeypoints: number;
  cropSize: number[];
  cropXy: string;
  cropDesc: string;
  candidates: Array<{ cardId: string; cosine: string; foundBy: string; votes: number; matches: number; inliers: number; evidence: string; fused: string; indexed: boolean }>;
}

/** CARDVISION_OPENCV_JS, else this runtime's build when scripts/build-opencv.mjs has written it. */
const VENDORED = fileURLToPath(new URL("../vendor/opencv/opencv.mjs", import.meta.url));
const OPENCV = process.env.CARDVISION_OPENCV_JS ?? (existsSync(VENDORED) ? VENDORED : undefined);
const haveCv = OPENCV !== undefined && existsSync(OPENCV);

describe("the stage end to end on toy scenes", () => {
  it("draws the toy cards and crops as Python does (no OpenCV needed)", () => {
    expect(strongestFirst([1, 3, 3, 2], 3)).toEqual([1, 2, 3]);
    expect(fixture.scenes.scenes.length).toBe(7);
  });

  /** The scenes' crops and the recognizer's rankings, as the stage is given them. */
  function sceneItems(): VerifyItem[] {
    return fixture.scenes.scenes.map((scene: SceneCase) => ({
      rgba: sceneRgba(scene.card === null ? null : cardRgb(1000 + scene.card), scene.size, scene.place, scene.seed, scene.turned),
      width: scene.size[0]!,
      height: scene.size[1]!,
      ranked: scene.ranked.map(([cardId, cosine]) => ({ cardId, cosine })),
    }));
  }

  function pythonFeatures(scene: SceneCase): CropFeatures {
    const desc = new Uint8Array(Buffer.from(scene.cropDesc, "base64"));
    const xyBytes = Buffer.from(scene.cropXy, "base64");
    const xy = new Float32Array(xyBytes.buffer.slice(xyBytes.byteOffset, xyBytes.byteOffset + xyBytes.byteLength));
    return { n: desc.length / 32, desc, xy, size: [scene.cropSize[0]!, scene.cropSize[1]!] };
  }

  /** A stage given the crops' keypoints as Python took them, in the order of the items. */
  class PythonKeypointsStage extends GeometricStage {
    private next = 0;
    protected override cropFeatures(): CropFeatures {
      return pythonFeatures(fixture.scenes.scenes[this.next++]);
    }
  }

  function expectSame(got: StageResult, scene: SceneCase, label: string, inlierTolerance: number): void {
    expect(got.candidates.map((c) => [c.cardId, c.foundBy, c.votes, c.matches, c.indexed]), label).toEqual(
      scene.candidates.map((c) => [c.cardId, c.foundBy, c.votes, c.matches, c.indexed]),
    );
    got.candidates.forEach((c, k) => {
      const want = scene.candidates[k]!;
      expect(hexOf(c.cosine), label).toBe(want.cosine);
      expect(Math.abs(c.inliers - want.inliers), `${label} ${c.cardId}: inliers ${c.inliers}, Python ${want.inliers}`).toBeLessThanOrEqual(inlierTolerance);
      if (c.inliers === want.inliers) expect(hexOf(c.fused), label).toBe(want.fused);
    });
  }

  it.skipIf(!haveCv)("given Python's crop keypoints, chooses, votes and matches exactly as Python, inliers close", async () => {
    const cv = await loadCv(OPENCV!);
    const s = fixture.scenes;
    const index = packedIndex(s.cards);
    const config = parseGeometric(s.config);
    expect(config.toJson()).toEqual(s.settings);
    const stage = new PythonKeypointsStage(config, index, cpuKnn(index.desc), cv, new Map(Object.entries(s.identities)));
    const results = await stage.verifyBatch(sceneItems(), new Set(s.known));
    s.scenes.forEach((scene: SceneCase, i: number) => expectSame(results[i]!, scene, `scene ${i}`, 3));
  });

  it.skipIf(!haveCv)("with its own keypoints, agrees with Python wherever this OpenCV takes the same keypoints", async () => {
    const cv = await loadCv(OPENCV!);
    const s = fixture.scenes;
    const index = packedIndex(s.cards);
    const stage = new GeometricStage(parseGeometric(s.config), index, cpuKnn(index.desc), cv, new Map(Object.entries(s.identities)));
    const items = sceneItems();
    const results = await stage.verifyBatch(items, new Set(s.known));
    let identical = 0;
    s.scenes.forEach((scene: SceneCase, i: number) => {
      const own = extractOrb(cv, items[i]!.rgba, items[i]!.width, items[i]!.height, s.settings.crop.longSide, s.settings.crop.maxFeatures, s.settings.features.params);
      const python = pythonFeatures(scene);
      expect([results[i]!.cropKeypoints, own.size], `scene ${i}`).toEqual([scene.cropKeypoints, python.size]);
      const same = Buffer.from(own.desc).equals(Buffer.from(python.desc)) && Buffer.from(own.xy.buffer).equals(Buffer.from(python.xy.buffer));
      if (same) {
        identical += 1;
        expectSame(results[i]!, scene, `scene ${i}`, 3);
      }
    });
    // Another OpenCV build may take slightly other keypoints (docs/how-it-works.md, section 10):
    // with CARDVISION_OPENCV_EXACT set, this build must take Python's on every scene.
    if (process.env.CARDVISION_OPENCV_EXACT) expect(identical).toBe(s.scenes.length);
    expect(identical).toBeGreaterThanOrEqual(1);
  });
});

// ------------------------------------------------------------------------------ debug record
describe("the stage's debug record", () => {
  it("hashes as SHA-256 does", () => {
    const stream = new Stream(11);
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 1000, 25_600]) {
      const bytes = Uint8Array.from({ length }, () => stream.below(256));
      expect(sha256Hex(bytes), `${length} bytes`).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("ids a keypoint row by its float32 position and descriptor, as Python's row_hashes", () => {
    const stream = new Stream(12);
    const n = 5;
    const xy = Float32Array.from({ length: 2 * n }, () => stream.unit() * 160);
    const desc = Uint8Array.from({ length: 32 * n }, () => stream.below(256));
    const want = Array.from({ length: n }, (_, i) => {
      const row = Buffer.alloc(40);
      row.writeFloatLE(xy[2 * i]!, 0);
      row.writeFloatLE(xy[2 * i + 1]!, 4);
      Buffer.from(desc.subarray(32 * i, 32 * i + 32)).copy(row, 8);
      return createHash("sha256").update(row).digest("hex").slice(0, ROW_HASH_DIGITS);
    });
    expect(rowHashes(n, xy, desc)).toEqual(want);
    expect([resizeDirection(100, 140, 160), resizeDirection(114, 160, 160), resizeDirection(240, 336, 160)]).toEqual(["up", "none", "down"]);
  });

  it("is absent from the evidence of a stage that was not asked for it", () => {
    const result: StageResult = { candidates: [], cropKeypoints: 0, ms: 1 };
    const before = { topId: "A", similarity: 0.5, margin: 0.1, accepted: false };
    expect("debug" in evidenceToJson(before, result)).toBe(false);
    const debug = { grey: { sha256: "0".repeat(64), width: 1, height: 1 }, resize: "none" as const, source: [1, 1] as [number, number], keypoints: 0, rows: [], votes: {}, ms: 1 };
    expect(evidenceToJson(before, { ...result, debug }).debug).toEqual(debug);
  });

  it.skipIf(!haveCv)("changes no result, and records the grey image, every keypoint row and the whole vote", async () => {
    const cv = await loadCv(OPENCV!);
    const s = fixture.scenes;
    const index = packedIndex(s.cards);
    const items: VerifyItem[] = s.scenes.map((scene: SceneCase) => ({
      rgba: sceneRgba(scene.card === null ? null : cardRgb(1000 + scene.card), scene.size, scene.place, scene.seed, scene.turned),
      width: scene.size[0]!,
      height: scene.size[1]!,
      ranked: scene.ranked.map(([cardId, cosine]) => ({ cardId, cosine })),
    }));
    const make = (): GeometricStage => new GeometricStage(parseGeometric(s.config), index, cpuKnn(index.desc), cv, new Map(Object.entries(s.identities)));
    const plain = await make().verifyBatch(items, new Set(s.known));
    const stage = make();
    stage.debug = true;
    const debugged = await stage.verifyBatch(items, new Set(s.known));
    debugged.forEach((result, i) => {
      const item = items[i]!;
      expect(plain[i]!.debug).toBeUndefined();
      expect([result.candidates, result.cropKeypoints], `scene ${i}`).toEqual([plain[i]!.candidates, plain[i]!.cropKeypoints]);
      const record = result.debug!;
      const grey = scaledGrey(cv, item.rgba, item.width, item.height, s.settings.crop.longSide);
      const greySha = createHash("sha256").update(grey.data.subarray(0, grey.rows * grey.cols)).digest("hex");
      expect(record.grey, `scene ${i}`).toEqual({ sha256: greySha, width: grey.cols, height: grey.rows });
      grey.delete();
      const own = extractOrb(cv, item.rgba, item.width, item.height, s.settings.crop.longSide, s.settings.crop.maxFeatures, s.settings.features.params);
      expect(record.rows).toEqual(rowHashes(own.n, own.xy, own.desc));
      expect([record.keypoints, record.source, record.resize, record.ms]).toEqual([own.n, [item.width, item.height], resizeDirection(item.width, item.height, s.settings.crop.longSide), result.ms]);
      for (const found of result.candidates) if (found.votes > 0) expect(record.votes[found.cardId]).toBe(found.votes);
      expect(Object.keys(record.votes)).toEqual([...Object.keys(record.votes)].sort());
    });
  });
});

// --------------------------------------------------------------------------------- pipeline
describe("the stage in the pipeline", () => {
  const ids = ["A", "B", "C"];
  const looks = [Float32Array.from([0.7, 0.1, 0.1]), Float32Array.from([0.2, 0.1, 0]), Float32Array.from([0.3, 0.5, 0.2]), Float32Array.from([0.1, 0, 0])];
  const names = new Map([["A", "Alder"], ["B", "Birch"], ["C", "Cedar"]]);
  const box = { aabb: { x: 10, y: 10, width: 60, height: 84 }, rect: rectOf({ x: 10, y: 10, width: 60, height: 84 }), score: 0.9, cls: 0 };
  const bank = (): EmbeddingBank => {
    const matrix = new Float32Array(9);
    for (let r = 0; r < 3; r++) matrix[r * 3 + r] = 1;
    return { ids, matrix, dim: 3, version: 1, model: "fake", preprocessing: "full128", tau: null };
  };
  const pipeline = (geometric?: GeometricStage | null): Pipeline =>
    new Pipeline({
      detector: { lastTimings: null, propose: async () => [box] } as unknown as FrameDetector,
      embedder: { embedBatch: async (_d: Float32Array, n: number) => { const out = new Float32Array(n * 3); for (let i = 0; i < n; i++) out.set(looks[0]!, i * 3); return out; } },
      bank: bank(), names, accept: { tau: 0.62, delta: 0.05, rotationRetry: true }, now: () => 0, minCropPx: 1,
      ...(geometric !== undefined ? { geometric } : {}),
    });

  it("without a stage the analysis is byte for byte what the code before the stage gave (a stored golden)", async () => {
    const golden = JSON.parse(readFileSync(`${FIXTURES}no-stage-golden.json`, "utf-8"));
    expect(golden.times).toEqual(SCENE_TIMES);
    const now = await runScene();
    expect(now.length).toBe(golden.analyses.length);
    now.forEach((text, i) => expect(text, `frame ${i}`).toBe(JSON.stringify(golden.analyses[i])));
    // The same with the option given as null.
    const frame = sceneFrame();
    const withNull = scenePipeline();
    withNull.setGeometric(null);
    expect(JSON.stringify(await withNull.analyze(frame, 0))).toBe(JSON.stringify(golden.analyses[0]));
  });

  it("without a stage no geometric field appears anywhere", async () => {
    const frame = solidFrame(200, 150, [9, 9, 9]);
    const plain = await pipeline().analyze(frame, 0);
    expect(Object.keys(plain.timings)).toEqual(["detectorMs", "recognizeMs", "analyzeMs"]);
    expect(Object.keys(plain.boxes[0]!.face!)).not.toContain("geometric");
    expect(Object.keys(positionOutcome(plain, { index: 0, kind: "point", x: 0.2, y: 0.3 } as never))).not.toContain("geometric");
  });

  it("gives the evidence line of a frame in the Python package's format", async () => {
    const frame = solidFrame(200, 150, [9, 9, 9]);
    const p = pipeline();
    p.setGeometric(fakeStage(true, [{ cardId: "B", inliers: 50 }]));
    const analysis = await p.analyze(frame, 0);
    const row = { key: "local-x-t0000000000", platform: "local", video_id: "x", t: 0, group: "g", source_type: "generated" };
    const positions = [
      { key: "k/center/1", kind: "center", label: "1", role: "face", x: 40 / 200, y: 50 / 150, truthId: "B" },
      { key: "k/center/2", kind: "center", label: "2", role: "back", x: 150 / 200, y: 140 / 150, truthId: null },
    ];
    const line = evidenceLine(row, { width: 200, height: 150, pixelSha256: "f".repeat(64) }, analysis, positions, [[0.2, 0.33, "B"]]);
    expect(Object.keys(line)).toEqual(["key", "platform", "video_id", "t", "group", "source_type", "frame", "analyzed", "ms", "faces", "events", "namedFaces"]);
    expect(line.faces).toHaveLength(1);
    const face = line.faces[0]!;
    expect(Object.keys(face)).toEqual(["index", "box", "score", "topId", "similarity", "margin", "look", "accepted", "shownId", "geometric", "tilted"]);
    expect([face.index, face.box, face.topId, face.accepted, face.shownId]).toEqual([0, [10, 10, 60, 84], "B", true, "B"]);
    expect(face.geometric!.before.topId).toBe("A");
    expect(line.events.map((e) => [e.hit, e.shownId, e.box, e.outcome])).toEqual([[0, "B", [10, 10, 60, 84], null], [null, null, null, null]]);
    expect(line.ms.geometric).not.toBeNull();
    expect(line.analyzed).toEqual({ width: 200, height: 150 });
    const plain = evidenceLine(row, line.frame, await pipeline(null).analyze(frame, 0), positions);
    expect([plain.faces[0]!.geometric, plain.ms.geometric]).toEqual([null, null]);
    expect(await rgbSha256(Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]), async (b) => createHash("sha256").update(b).digest("hex"))).toBe(
      createHash("sha256").update(Uint8Array.from([1, 2, 3, 4, 5, 6])).digest("hex"),
    );
  });

  it("with a stage the faces carry its evidence and the timings its time; it can be set and removed between frames", async () => {
    const frame = solidFrame(200, 150, [9, 9, 9]);
    const p = pipeline();
    p.setGeometric(fakeStage(true, [{ cardId: "B", inliers: 50 }]));
    const fused = await p.analyze(frame, 0);
    const f = fused.boxes[0]!.face!;
    expect([f.topId, f.accepted, f.cardId]).toEqual(["B", true, "B"]);
    expect(f.geometric!.before.topId).toBe("A");
    expect(fused.timings.geometricMs).toBeGreaterThanOrEqual(0);
    const outcome = positionOutcome(fused, { index: 0, kind: "point", x: 0.2, y: 0.3 } as never);
    expect(outcome.geometric).toEqual(f.geometric);
    p.setGeometric(null);
    const again = await p.analyze(frame, 0.2);
    expect([again.boxes[0]!.face!.topId, "geometric" in again.boxes[0]!.face!, "geometricMs" in again.timings]).toEqual(["A", false, false]);
  });
});

describe("the stage and the tracker", () => {
  it("the tracker is given the cosine looks only, as without the stage, while the face shows the fused answer", async () => {
    const box = { aabb: { x: 10, y: 10, width: 60, height: 84 }, rect: rectOf({ x: 10, y: 10, width: 60, height: 84 }), score: 0.9, cls: 0 };
    // Cosine 0.61 with A: under tau, so without the stage nothing is tracked; the stage's
    // inliers lift B over tau.
    const look = [0.5, 0.45, 0.45];
    const make = (): Pipeline => {
      const matrix = new Float32Array(9);
      for (let r = 0; r < 3; r++) matrix[r * 3 + r] = 1;
      return new Pipeline({
        detector: { lastTimings: null, propose: async () => [box] } as unknown as FrameDetector,
        embedder: { embedBatch: async (_d: Float32Array, n: number) => { const out = new Float32Array(n * 3); for (let i = 0; i < n; i++) out.set(look, i * 3); return out; } },
        bank: { ids: ["A", "B", "C"], matrix, dim: 3, version: 1, model: "fake", preprocessing: "full128", tau: null },
        names: new Map([["A", "Alder"], ["B", "Birch"], ["C", "Cedar"]]),
        accept: { tau: 0.62, delta: 0.05, rotationRetry: true }, now: () => 0, minCropPx: 1,
      });
    };
    const frame = solidFrame(200, 150, [9, 9, 9]);
    const plain = make();
    const staged = make();
    staged.setGeometric(fakeStage(true, [{ cardId: "B", inliers: 50 }]));
    for (const t of [0, 0.5, 1, 1.5]) {
      const a = await plain.analyze(frame, t);
      const b = await staged.analyze(frame, t);
      expect([a.boxes[0]!.face!.topId, a.boxes[0]!.face!.tauPassed, b.boxes[0]!.face!.topId, b.boxes[0]!.face!.tauPassed]).toEqual(["A", false, "B", true]);
      expect(JSON.stringify(b.tracks), `t ${t}`).toBe(JSON.stringify(a.tracks));
    }
    const last = await staged.analyze(frame, 2);
    expect([last.tracks.shown, last.tracks.cards.length]).toEqual([false, 0]);
  });
});

describe("opening a stage", () => {
  const sha = "a".repeat(64);
  const index = (sourceSha256: string): StageIndex => ({ ...packedIndex([]), sourceSha256 });
  const cv = { RANSAC: 8 } as unknown as Cv;
  const deps = (settings: object, sourceSha256 = sha, calls: string[] = []) => ({
    fetchText: async (url: string) => { calls.push(`settings ${url}`); return JSON.stringify(settings); },
    loadIndex: async (url: string, opts: { bankSha256: string; bankIds: string[] }) => { calls.push(`index ${url} ${opts.bankSha256} ${opts.bankIds.join(",")}`); return index(sourceSha256); },
    loadCv: async () => cv,
    makeVoter: async () => { calls.push("voter"); return { knn2: async () => { throw new Error("unused"); }, dispose: () => calls.push("disposed") }; },
    bankSha256: "b".repeat(64),
    bankIds: ["A", "B"],
    identities: new Map<string, string>(),
  });

  it("reads the settings, loads the index beside them for the bank, then OpenCV and the voter", async () => {
    const calls: string[] = [];
    const { stage, bytes } = await openGeometricStage("https://cdn.example/geo/settings.json", deps({ index: { path: "packed/manifest.json", sha256: sha }, ransac: { model: "affine" } }, sha, calls));
    expect(calls).toEqual(["settings https://cdn.example/geo/settings.json", `index https://cdn.example/geo/packed/manifest.json ${"b".repeat(64)} A,B`, "voter"]);
    expect([stage.reorder, bytes]).toEqual([true, 0]);
  });

  it("refuses an index whose features block is not the settings' (Python: same_features)", async () => {
    const settings = { index: { path: "m.json", sha256: sha }, ransac: { model: "affine" } };
    const other = { ...parseGeometric({}).settings.features, artLongSide: 160, params: { ...parseGeometric({}).settings.features.params, patchSize: 31 } };
    const d = { ...deps(settings), loadIndex: async () => ({ ...index(sha), features: other }) };
    await expect(openGeometricStage("https://x/s.json", d)).rejects.toThrow("the index was built with other features settings (differing: artLongSide, params)");
    expect(sameFeatures({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual([]);
    expect(sameFeatures({ a: 1, c: { x: 1 } }, { a: 1.0, c: { x: 2 }, d: null })).toEqual(["c", "d"]);
  });

  it("notes an index taken with another OpenCV version than the one loaded (Python: opencv_note)", async () => {
    const settings = { index: { path: "m.json", sha256: sha }, ransac: { model: "affine" } };
    const versioned = (version: string) => ({ RANSAC: 8, getBuildInformation: () => `General configuration for OpenCV ${version}\n  Version control: ${version}\n` }) as unknown as Cv;
    const run = (built: string, running: string) =>
      openGeometricStage("https://x/s.json", { ...deps(settings), loadIndex: async () => ({ ...index(sha), opencv: built }), loadCv: async () => versioned(running) });
    expect((await run("5.0.0", "5.0.0")).note).toBe(null);
    expect((await run("4.9.0", "5.0.0")).note).toBe(
      "the descriptor index was built with OpenCV 4.9.0 and OpenCV 5.0.0 is running; keypoints may differ slightly from the index's",
    );
    expect(opencvNote("", versioned("5.0.0"))).toMatch(/^the descriptor index was built with OpenCV of an unrecorded version and OpenCV 5.0.0/);
  });

  it("refuses an index that repacks another index than the settings pin, settings without an index, and unported settings", async () => {
    await expect(openGeometricStage("https://x/s.json", deps({ index: { path: "m.json", sha256: sha } }, "c".repeat(64)))).rejects.toThrow(/repacks/);
    await expect(openGeometricStage("https://x/s.json", deps({}))).rejects.toThrow(/index.path and index.sha256/);
    await expect(openGeometricStage("https://x/s.json", deps({ index: { path: "m.json", sha256: sha }, vote: { matcher: "flann" }, candidates: { voteTopN: 3 } }))).rejects.toThrow(/not ported/);
    await expect(openGeometricStage("https://x/s.json", deps({ index: { path: "m.json", sha256: sha }, ransac: { model: "similarity" } }))).rejects.toThrow(/estimateAffinePartial2D/);
    await expect(openGeometricStage("https://x/s.json", deps({ index: { path: "m.json", sha256: sha }, ransac: { model: "homography" } }))).rejects.toThrow(/findHomography/);
    await expect(openGeometricStage("https://x/s.json", deps({ index: { path: "m.json", sha256: sha }, fusion: { wieght: 1 } }))).rejects.toThrow(GeometricConfigError);
  });
});
