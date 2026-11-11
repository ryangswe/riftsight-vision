// SPDX-License-Identifier: Apache-2.0
// Session option `geometricScope: "focus"`: the geometric stage verifies only the faces at the
// pointer (the boxes holding it, and the ones joined to them by overlaps the suppression would
// act on), and a face the stage applies to and did not verify is not named.
//
// The pipeline here is the real one on fake models: a crop's first red value says which
// embedding it gets, and the fake stage answers by the same value, so a test says what each
// face is and what verifying it finds.

import { describe, expect, it } from "vitest";

import type { EmbeddingBank } from "../src/bank.js";
import { type AABB, type Candidate, iou, rectOf } from "../src/boxes.js";
import { resolveGeometricScope } from "../src/cadence.js";
import type { Frame, FrameDetector } from "../src/detector/detector.js";
import type { BatchEmbedder } from "../src/embedder.js";
import { parseGeometric } from "../src/geometric/config.js";
import type { CropFeatures, Cv } from "../src/geometric/features.js";
import type { StageResult, Verified } from "../src/geometric/fusion.js";
import { GeometricStage, type StageIndex, type VerifyItem } from "../src/geometric/stage.js";
import { cpuVoter } from "../src/geometric/vote.js";
import type { WorkerRequest } from "../src/messages.js";
import { hoverAt, Pipeline } from "../src/pipeline.js";
import { focusChecked, type FocusCheckReport, focusCheckLines } from "../score/focus-check.js";
import type { Analyzer } from "../score/video.js";
import { ACCEPTED_NMS_IOU, focusGroup } from "../src/recognition.js";
import { SessionCore } from "../src/session-core.js";
import { createSession } from "../src/session.js";
import { createWorkerSession, type WorkerLike } from "../src/worker-session.js";
import { axis, solidFrame, Stream } from "./support.js";

const DIM = 4;
const SIZE = 128;
const PLANE = 3 * SIZE * SIZE;
const IDS = ["A", "B", "C", "D"];
const NAMES = new Map([["A", "Alder"], ["B", "Birch"], ["C", "Cedar"], ["D", "Dogwood"]]);

/** red 250: exactly A (accepted). Any other red: an ambiguous look (A 0.5, the rest 0.4). */
class FakeEmbedder implements BatchEmbedder {
  async embedBatch(data: Float32Array, n: number): Promise<Float32Array> {
    const out = new Float32Array(n * DIM);
    for (let i = 0; i < n; i++) {
      const red = Math.round(((data[i * PLANE]! + 1) / 2) * 255);
      out.set(red === 250 ? axis(DIM, 0) : Float32Array.from([0.5, 0.4, 0.4, 0.4]), i * DIM);
    }
    return out;
  }
}

/** What verifying a crop finds, by its first red value: the card and its inliers. */
const FINDS: Record<number, { cardId: string; inliers: number }> = {
  100: { cardId: "B", inliers: 20 },
  110: { cardId: "C", inliers: 40 },
  120: { cardId: "D", inliers: 80 },
  250: { cardId: "A", inliers: 10 },
};

/** A stage that applies to a face whose look is not accepted, counts the crops it is given, and
 *  answers each by its red value. */
function fakeStage(): GeometricStage & { crops: number[]; batches: number } {
  const stage = {
    crops: [] as number[],
    batches: 0,
    reorder: true,
    applies: (_source: string | null, accepted: boolean) => !accepted,
    verifyBatch: async (items: VerifyItem[]): Promise<StageResult[]> => {
      stage.batches += 1;
      return items.map((item) => {
        const red = item.rgba[0]!;
        stage.crops.push(red);
        const find = FINDS[red]!;
        const cosine = item.ranked.find((r) => r.cardId === find.cardId)!.cosine;
        const candidate = { cardId: find.cardId, cosine, foundBy: "embedding", votes: 0, matches: find.inliers, inliers: find.inliers, evidence: find.inliers, fused: cosine + find.inliers / 50, indexed: true } as Verified;
        return { cropKeypoints: 0, ms: 0, candidates: [candidate] };
      });
    },
    dispose() {},
  };
  return stage as unknown as GeometricStage & { crops: number[]; batches: number };
}

function bank(): EmbeddingBank {
  const matrix = new Float32Array(IDS.length * DIM);
  IDS.forEach((_, i) => matrix.set(axis(DIM, i), i * DIM));
  return { ids: IDS, matrix, dim: DIM, version: 1, model: "fake", preprocessing: "full128", tau: null };
}

function box(x: number, y: number, score = 0.9): Candidate {
  const aabb = { x, y, width: 100, height: 140 };
  return { aabb, rect: rectOf(aabb), score, cls: 0 };
}

/** A frame with each card painted flat in its red, later cards over earlier ones. */
function scene(cards: Array<{ box: Candidate; red: number }>): Frame {
  const frame = solidFrame(800, 450, [5, 5, 5]);
  for (const { box: b, red } of cards) {
    const { x, y, width, height } = b.aabb;
    for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) frame.data[(py * 800 + px) * 4] = red;
  }
  return frame;
}

function pipelineOf(boxes: Candidate[], stage: GeometricStage): Pipeline {
  return new Pipeline({
    detector: { lastTimings: null, propose: async () => boxes } as unknown as FrameDetector,
    embedder: new FakeEmbedder(),
    bank: bank(),
    names: NAMES,
    accept: { tau: 0.62, delta: 0.05, rotationRetry: false },
    now: () => 0,
    geometric: stage,
  });
}

const named = (a: Awaited<ReturnType<Pipeline["analyze"]>>): Array<string | null> => a.boxes.map((b) => b.face!.cardId);
const keptOf = (a: Awaited<ReturnType<Pipeline["analyze"]>>): boolean[] => a.boxes.map((b) => b.face!.kept);

describe("focusGroup", () => {
  const b = (x: number): AABB => ({ x, y: 20, width: 100, height: 140 });
  it("holds the boxes at the point and, transitively, those overlapping them by the suppression's IoU", () => {
    const boxes = [b(20), b(60), b(100), b(500)];
    expect(iou(boxes[0]!, boxes[1]!)).toBeGreaterThanOrEqual(ACCEPTED_NMS_IOU);
    expect(iou(boxes[0]!, boxes[2]!)).toBeLessThan(ACCEPTED_NMS_IOU);
    expect([...focusGroup(boxes, { x: 30, y: 100 })].sort()).toEqual([0, 1, 2]);
    expect([...focusGroup(boxes, { x: 520, y: 100 })]).toEqual([3]);
    // The edge holds; outside every box, and no point, hold nothing.
    expect([...focusGroup(boxes, { x: 600, y: 160 })]).toEqual([3]);
    expect(focusGroup(boxes, { x: 400, y: 100 }).size).toBe(0);
    expect(focusGroup(boxes, null).size).toBe(0);
  });
});

describe("row 1: the stage is given the faces at the pointer", () => {
  const cards = [{ box: box(20, 20), red: 100 }, { box: box(300, 20), red: 110 }, { box: box(560, 20), red: 120 }];
  const boxes = cards.map((c) => c.box);

  it("verifies one crop for the pointer over one face, in the frame's pixels", async () => {
    const stage = fakeStage();
    await pipelineOf(boxes, stage).analyze(scene(cards), 0, { geometricScope: "focus", focus: { x: 350, y: 90 } });
    expect(stage.crops).toEqual([110]);
  });

  it("does no work with the pointer over no face, or no pointer", async () => {
    for (const focus of [{ x: 200, y: 300 }, null, undefined]) {
      const stage = fakeStage();
      const analysis = await pipelineOf(boxes, stage).analyze(scene(cards), 0, { geometricScope: "focus", ...(focus !== undefined ? { focus } : {}) });
      expect(stage.batches, JSON.stringify(focus)).toBe(0);
      expect(named(analysis)).toEqual([null, null, null]);
    }
  });

  it("verifies every face that applies, in one batch, with the default scope, whatever the focus", async () => {
    for (const options of [{}, { focus: { x: 350, y: 90 } }, { geometricScope: "all" as const, focus: { x: 350, y: 90 } }]) {
      const stage = fakeStage();
      await pipelineOf(boxes, stage).analyze(scene(cards), 0, options);
      expect([stage.batches, stage.crops.sort()]).toEqual([1, [100, 110, 120]]);
    }
  });

  it("the face verified gets the same answer as with every face verified", async () => {
    const all = await pipelineOf(boxes, fakeStage()).analyze(scene(cards), 0);
    const focus = await pipelineOf(boxes, fakeStage()).analyze(scene(cards), 0, { geometricScope: "focus", focus: { x: 350, y: 90 } });
    expect(focus.boxes[1]).toEqual(all.boxes[1]);
    expect(named(all)).toEqual(["B", "C", "D"]);
  });

  it("verifies the crops of the faces joined to the pointer's by overlaps, however many", async () => {
    const chain = [{ box: box(20, 20), red: 100 }, { box: box(60, 20), red: 110 }, { box: box(100, 20), red: 120 }, { box: box(500, 20), red: 100 }];
    const stage = fakeStage();
    await pipelineOf(chain.map((c) => c.box), stage).analyze(scene(chain), 0, { geometricScope: "focus", focus: { x: 30, y: 100 } });
    expect(stage.crops.sort()).toEqual([100, 110, 120]);
  });
});

describe("row 3: a face not verified is not named", () => {
  const cards = [{ box: box(20, 20), red: 100 }, { box: box(300, 20), red: 110 }, { box: box(560, 20), red: 250 }];
  const boxes = cards.map((c) => c.box);

  it("shows nothing for it until an analysis verifies it; a face the stage does not apply to is named as today", async () => {
    const pipeline = pipelineOf(boxes, fakeStage());
    const frame = scene(cards);
    const first = await pipeline.analyze(frame, 0, { geometricScope: "focus", focus: { x: 50, y: 50 } });
    expect(named(first)).toEqual(["B", null, "A"]);
    expect(first.boxes[1]!.face).toMatchObject({ unverified: true, accepted: false, tauPassed: false, kept: false });
    expect(first.boxes[0]!.face!.unverified).toBeUndefined();
    expect(first.boxes[2]!.face!.unverified).toBeUndefined();
    // What is at the pointer, and what is drawn.
    expect(hoverAt(first, 70, 100)?.cardId).toBe("B");
    expect(hoverAt(first, 350, 100)?.cardId ?? null).toBeNull();
    expect(first.hover.cards.filter((c) => c.cardId !== null).map((c) => c.cardId).sort()).toEqual(["A", "B"]);
    expect(first.tracks.cards.every((c) => c.cardId !== "C")).toBe(true);

    // The pointer moves to the other face: its name appears with the next analysis, and the
    // first face is the one not named now.
    const second = await pipeline.analyze(frame, 0.5, { geometricScope: "focus", focus: { x: 350, y: 90 } });
    expect(named(second)).toEqual([null, "C", "A"]);
    expect(hoverAt(second, 350, 100)?.cardId).toBe("C");
    expect(hoverAt(second, 70, 100)?.cardId ?? null).toBeNull();
  });

  it("is not named by the tilted retry either", async () => {
    const stage = fakeStage();
    const pipeline = pipelineOf(boxes, stage);
    pipeline.setTiltedRetry({ scales: [1], maxFacesPerFrame: 4, budgetMs: 1000 } as never);
    const analysis = await pipeline.analyze(scene(cards), 0, { geometricScope: "focus", focus: { x: 50, y: 50 } });
    expect(analysis.boxes[1]!.face!.unverified).toBe(true);
    expect(analysis.boxes[1]!.face!.tilted).toBeUndefined();
  });
});

describe("row 7: the suppression among overlapping boxes is the same", () => {
  it("the box that wins after the check wins with focus, and the pointer's group reads the same", async () => {
    // Two boxes overlapping by IoU 0.43; the second finds more after the check and wins.
    const cards = [{ box: box(20, 20), red: 100 }, { box: box(60, 20), red: 110 }, { box: box(500, 20), red: 120 }];
    const boxes = cards.map((c) => c.box);
    const all = await pipelineOf(boxes, fakeStage()).analyze(scene(cards), 0);
    expect(keptOf(all)).toEqual([false, true, true]); // precondition: the overlapping box wins
    const stage = fakeStage();
    const focus = await pipelineOf(boxes, stage).analyze(scene(cards), 0, { geometricScope: "focus", focus: { x: 30, y: 100 } });
    expect(stage.crops.sort()).toEqual([100, 110]);
    for (const i of [0, 1]) expect(focus.boxes[i], `box ${i}`).toEqual(all.boxes[i]);
    expect(named(focus).slice(0, 2)).toEqual(named(all).slice(0, 2));
    expect(hoverAt(focus, 30, 100)).toEqual(hoverAt(all, 30, 100));
    // The third face is outside the group: not verified, not named.
    expect(focus.boxes[2]!.face).toMatchObject({ unverified: true, cardId: null });
  });

  it("holds through a chain: A overlaps B, B overlaps C, the pointer on A only", async () => {
    // C beats B, so B drops and A stays. Verifying only A and B would drop A.
    const cards = [{ box: box(20, 20), red: 100 }, { box: box(60, 20), red: 110 }, { box: box(100, 20), red: 120 }];
    const boxes = cards.map((c) => c.box);
    const all = await pipelineOf(boxes, fakeStage()).analyze(scene(cards), 0);
    expect(keptOf(all)).toEqual([true, false, true]); // precondition: A survives only through C
    const pointer = { x: 30, y: 100 }; // inside A alone
    const stage = fakeStage();
    const focus = await pipelineOf(boxes, stage).analyze(scene(cards), 0, { geometricScope: "focus", focus: pointer });
    expect(stage.crops.sort()).toEqual([100, 110, 120]);
    expect(focus.boxes).toEqual(all.boxes);
    expect(hoverAt(focus, 30, 100)).toEqual(hoverAt(all, 30, 100));
    expect(hoverAt(focus, 30, 100)?.cardId).toBe("B");
    // A one-hop group would have given a different answer at the pointer.
    const twoOnly = await pipelineOf(boxes.slice(0, 2), fakeStage()).analyze(scene(cards.slice(0, 2)), 0);
    expect(keptOf(twoOnly)).toEqual([false, true]);
  });
});

describe("row 5: the option needs pointer mode", () => {
  it("refuses focus with another mode, naming pointer mode, and accepts the rest", () => {
    for (const mode of ["always-on", "layout"] as const) {
      expect(() => resolveGeometricScope("focus", mode)).toThrow(/needs pointer mode/);
    }
    expect(resolveGeometricScope("focus", "pointer")).toBe("focus");
    expect(resolveGeometricScope("focus", undefined)).toBe("focus");
    expect(resolveGeometricScope("all", "always-on")).toBe("all");
    expect(resolveGeometricScope(undefined, "always-on")).toBe("all");
    expect(() => resolveGeometricScope("some" as never, "pointer")).toThrow(RangeError);
  });

  it("is refused when the session is made, by every entry point", () => {
    const deps = { now: () => 0, toWorker: () => {}, capture: () => {} };
    expect(() => new SessionCore(deps, { mode: "always-on", geometricScope: "focus" })).toThrow(/needs pointer mode/);
    expect(() => new SessionCore(deps, { mode: "layout" as never, geometricScope: "focus" })).toThrow(/needs pointer mode/);
    let workers = 0;
    const env = {
      createWorker: (): WorkerLike => {
        workers += 1;
        throw new Error("no worker");
      },
      loadRequest: {} as never,
      now: () => 0,
      capture: () => {},
    };
    expect(() => createWorkerSession({ ...env, mode: "always-on", geometricScope: "focus" })).toThrow(/needs pointer mode/);
    expect(() => createSession({} as never, { releaseUrl: "r.json", mode: "always-on", geometricScope: "focus" })).toThrow(/needs pointer mode/);
    expect(workers).toBe(0);
  });

  it("does nothing without a geometric stage", async () => {
    const cards = [{ box: box(20, 20), red: 250 }, { box: box(300, 20), red: 100 }];
    const plain = new Pipeline({
      detector: { lastTimings: null, propose: async () => cards.map((c) => c.box) } as unknown as FrameDetector,
      embedder: new FakeEmbedder(),
      bank: bank(),
      names: NAMES,
      accept: { tau: 0.62, delta: 0.05, rotationRetry: false },
      now: () => 0,
    });
    const frame = scene(cards);
    const a = await plain.analyze(frame, 0);
    const plain2 = await plain.analyze(frame, 0, { geometricScope: "focus", focus: { x: 350, y: 90 } });
    expect(plain2.boxes).toEqual(a.boxes);
    expect(plain2.boxes.some((b) => b.face!.unverified)).toBe(false);
  });
});

describe("the session core sends the pointer", () => {
  function core(options: ConstructorParameters<typeof SessionCore>[1]): { core: SessionCore; sent: WorkerRequest[] } {
    const sent: WorkerRequest[] = [];
    let now = 1_000;
    const c = new SessionCore({ now: () => now++, toWorker: (r) => sent.push(r), capture: () => {} }, options);
    c.fromWorker({ kind: "release-status", ok: true, error: null, release: { analysisWidth: { min: 720, max: 1920 }, hoverMaxAgeMs: 2000, recognizer: { ep: "wasm" } } as never, cards: [] });
    return { core: c, sent };
  }
  const bitmap = { width: 1000, height: 500, close() {} } as unknown as ImageBitmap;

  it("with the option on, sends the pointer at capture time in the picture's pixels, or null when it left", () => {
    const { core: c, sent } = core({ geometricScope: "focus" });
    c.pointer(0.25, 0.5, 1);
    c.pointer(0.9, 0.9, 1); // moves on after the capture was asked for: not the pointer of the picture
    c.frame(1, bitmap, 1);
    expect(sent[0]).toMatchObject({ kind: "frame", geometricScope: "focus", focus: { x: 250, y: 250 } });

    const { core: d, sent: sentD } = core({ geometricScope: "focus" });
    d.pointer(0.1, 0.1, 1);
    d.pointerLeft();
    d.frame(1, bitmap, 1);
    expect(sentD[0]).toMatchObject({ geometricScope: "focus", focus: { x: 100, y: 50 } }); // left after the request
  });

  it("with the option off, sends neither the scope nor a focus", () => {
    for (const options of [{}, { geometricScope: "all" as const }]) {
      const { core: c, sent } = core(options);
      c.pointer(0.25, 0.5, 1);
      c.frame(1, bitmap, 1);
      const request = sent[0]!;
      expect(request.kind).toBe("frame");
      expect(Object.keys(request).sort()).toEqual(["bitmap", "envelope", "kind", "videoTimeSec"]);
    }
  });
});

// ------------------------------------------------------------------------------------ row 2

/** Just enough of OpenCV.js for the stage's matching and fitting, deterministic by construction:
 *  a brute-force Hamming matcher and a fit whose inliers are the matches that moved less than
 *  a threshold. It keeps a global generator, like OpenCV's, that nothing here reads. */
function toyCv(): Cv {
  class Mat {
    data: Uint8Array;
    constructor(public rows = 0, public cols = 0) {
      this.data = new Uint8Array(rows * cols);
    }
    empty(): boolean {
      return this.rows === 0 || this.cols === 0;
    }
    type(): number {
      return 0;
    }
    delete(): void {}
  }
  class PairVector {
    items: Array<Array<{ queryIdx: number; trainIdx: number; distance: number }>> = [];
    size(): number {
      return this.items.length;
    }
    get(i: number) {
      const pair = this.items[i]!;
      return { size: () => pair.length, get: (k: number) => pair[k]!, delete() {} };
    }
    delete(): void {}
  }
  const hamming = (a: Uint8Array, ai: number, b: Uint8Array, bi: number, width: number): number => {
    let d = 0;
    for (let k = 0; k < width; k++) {
      let x = a[ai * width + k]! ^ b[bi * width + k]!;
      while (x) {
        d += x & 1;
        x >>= 1;
      }
    }
    return d;
  };
  const cv = {
    Mat,
    CV_8UC1: 0,
    CV_32FC2: 13,
    NORM_HAMMING: 6,
    RANSAC: 8,
    matFromArray: (rows: number, cols: number, _type: number, data: ArrayLike<number>) => {
      const m = new Mat(rows, cols * 2);
      (m as unknown as { values: ArrayLike<number> }).values = data;
      return m;
    },
    BFMatcher: class {
      knnMatch(query: Mat, train: Mat, out: PairVector): void {
        const width = query.cols;
        for (let q = 0; q < query.rows; q++) {
          const all = [];
          for (let t = 0; t < train.rows; t++) all.push({ queryIdx: q, trainIdx: t, distance: hamming(query.data, q, train.data, t, width) });
          all.sort((a, b) => a.distance - b.distance || a.trainIdx - b.trainIdx);
          out.items.push(all.slice(0, 2));
        }
      }
      delete(): void {}
    },
    DMatchVectorVector: PairVector,
    setRNGSeed: (_seed: number) => {},
    estimateAffine2D: (from: Mat & { values: ArrayLike<number> }, to: Mat & { values: ArrayLike<number> }, mask: Mat) => {
      const count = from.rows;
      mask.rows = count;
      mask.cols = 1;
      mask.data = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const dx = to.values[2 * i]! - from.values[2 * i]!;
        const dy = to.values[2 * i + 1]! - from.values[2 * i + 1]!;
        mask.data[i] = Math.hypot(dx, dy) < 6 ? 1 : 0;
      }
      return new Mat(2, 3);
    },
  };
  return cv as unknown as Cv;
}

/** A toy index of three cards, and crops that show a part of one of them (the crop's first
 *  value picks the card). */
function toyStage(): { stage: GeometricStage; item: (card: number) => VerifyItem } {
  const cards = [0, 1, 2].map((c) => ({ cardId: `card${c}`, artV: `card${c}`, width: 100, height: 140, start: c * 40, n: 40 }));
  const s = new Stream(7);
  const desc = new Uint8Array(120 * 32).map(() => s.below(256));
  const xy = new Float32Array(120 * 2).map(() => s.below(100));
  const rowCard = new Uint32Array(120).map((_, i) => Math.floor(i / 40));
  const index: StageIndex = { cards, desc, xy, rowCard, rows: 120, sourceSha256: "0".repeat(64), bankSha256: "0".repeat(64), opencv: "toy", features: parseGeometric({}).settings.features };
  const config = parseGeometric({ candidates: { embeddingTopK: 3, voteTopN: 2 }, ransac: { model: "affine", minAreaRatio: 0, maxAreaRatio: 0 } });
  class Toy extends GeometricStage {
    protected override cropFeatures(item: VerifyItem): CropFeatures {
      const card = item.rgba[0]!;
      const n = 25 + 5 * card; // each crop shows a different part of its card
      const start = card * 40;
      return { n, desc: desc.slice(start * 32, (start + n) * 32), xy: xy.slice(start * 2, (start + n) * 2), size: [100, 140] };
    }
  }
  const stage = new Toy(config, index, cpuVoter(desc), toyCv());
  const item = (card: number): VerifyItem => ({
    rgba: Uint8ClampedArray.from([card, 0, 0, 255]),
    width: 1,
    height: 1,
    ranked: [{ cardId: "card0", cosine: 0.5 }, { cardId: "card1", cosine: 0.4 }, { cardId: "card2", cosine: 0.3 }],
  });
  return { stage, item };
}

/** A result without its timing, which is the only field a batch changes by itself. */
const sansTime = (r: StageResult): Omit<StageResult, "ms"> => {
  const { ms: _ms, ...rest } = r;
  return rest;
};

describe("row 2: a crop verified alone gives the result it gives in a batch", () => {
  it("the same candidates, inliers, votes and evidence, field for field, with the stage's doubles", async () => {
    const { stage, item } = toyStage();
    const items = [item(0), item(1), item(2)];
    const batch = await stage.verifyBatch(items);
    // Not vacuous: each crop found its own card, with the inliers of the part it shows.
    expect(batch.map((r) => r.candidates.find((c) => c.inliers > 0)?.cardId)).toEqual(["card0", "card1", "card2"]);
    expect(batch.map((r) => r.cropKeypoints)).toEqual([25, 30, 35]);
    for (let i = 0; i < items.length; i++) {
      const alone = await stage.verifyBatch([items[i]!]);
      expect(sansTime(alone[0]!), `crop ${i} alone`).toEqual(sansTime(batch[i]!));
      expect(sansTime((await stage.verify(items[i]!))), `crop ${i} verify`).toEqual(sansTime(batch[i]!));
    }
    // And in another batch: in a different position, with other companions.
    const reordered = await stage.verifyBatch([items[2]!, items[0]!]);
    expect(sansTime(reordered[1]!)).toEqual(sansTime(batch[0]!));
    expect(sansTime(reordered[0]!)).toEqual(sansTime(batch[2]!));
  });

  it("the same fused answer through the pipeline: a face verified alone equals the face in the full batch", async () => {
    const cards = [{ box: box(20, 20), red: 100 }, { box: box(300, 20), red: 110 }, { box: box(560, 20), red: 120 }];
    const boxes = cards.map((c) => c.box);
    const all = await pipelineOf(boxes, fakeStage()).analyze(scene(cards), 0);
    for (let i = 0; i < 3; i++) {
      const at = { x: boxes[i]!.aabb.x + 50, y: 90 };
      const focused = await pipelineOf(boxes, fakeStage()).analyze(scene(cards), 0, { geometricScope: "focus", focus: at });
      expect(focused.boxes[i], `face ${i}`).toEqual(all.boxes[i]);
    }
  });
});

describe("the focus check (score/focus-check.ts)", () => {
  const cards = [{ box: box(20, 20), red: 100 }, { box: box(60, 20), red: 110 }, { box: box(100, 20), red: 120 }, { box: box(500, 20), red: 100 }];
  const boxes = cards.map((c) => c.box);

  /** An analyzer over the pipeline; `stage` is the one given to it. */
  function analyzer(stage: GeometricStage): Analyzer {
    const pipeline = pipelineOf(boxes, stage);
    const frame = scene(cards);
    return {
      analyze: (_video: unknown, focus?: { x: number; y: number }) => pipeline.analyze(frame, 0, focus ? { geometricScope: "focus", focus } : {}),
    } as unknown as Analyzer;
  }
  const run = async (stage: GeometricStage): Promise<FocusCheckReport> => {
    const report: FocusCheckReport = { frames: 0, faces: 0, differing: 0, details: [] };
    await focusChecked(analyzer(stage), report).analyze({} as never);
    return report;
  };

  it("finds no difference for a stage whose answer does not depend on the batch", async () => {
    const report = await run(fakeStage());
    expect([report.frames, report.faces, report.differing]).toEqual([1, 4, 0]);
    expect(focusCheckLines(report)[0]).toBe("focus check: 4 faces in 1 frames compared, 0 differ");
  });

  it("reports the field that differs for a stage whose answer depends on the batch", async () => {
    const stage = fakeStage();
    const verify = stage.verifyBatch.bind(stage);
    stage.verifyBatch = async (items, known) => {
      const results = await verify(items, known);
      // The inliers of a crop grow with the number of crops it is verified with.
      return results.map((r) => ({ ...r, candidates: r.candidates.map((c) => ({ ...c, inliers: c.inliers + items.length })) }));
    };
    const report = await run(stage);
    expect(report.differing).toBeGreaterThan(0);
    expect(report.details[0]!.differences.some((d) => /geometric\.candidates\[0\]\.inliers$/.test(d.path))).toBe(true);
  });
});

// ------------------------------------------------------------------- the tilted retry (row 7 v3)

/** Upright: the red value picks a weak look of card A (a similarity under tau). Retry (every
 *  batch after the first): the same red value picks the look the retry finds. */
class RetryEmbedder implements BatchEmbedder {
  private calls = 0;
  constructor(
    private readonly upright: Record<number, number>,
    private readonly retried: Record<number, number[]>,
  ) {}
  async embedBatch(data: Float32Array, n: number): Promise<Float32Array> {
    const retry = this.calls++ > 0;
    const out = new Float32Array(n * DIM);
    for (let i = 0; i < n; i++) {
      const red = Math.round(((data[i * PLANE]! + 1) / 2) * 255);
      out.set(retry ? Float32Array.from(this.retried[red] ?? [0, 0, 0, 0]) : Float32Array.from([this.upright[red] ?? 0, 0, 0, 0]), i * DIM);
    }
    return out;
  }
}

/** A stage that applies to a look not yet accepted and finds nothing: the retry decides. */
function idleStage(): GeometricStage {
  return { reorder: true, applies: (_s: string | null, accepted: boolean) => !accepted, verifyBatch: async (items: VerifyItem[]) => items.map(() => ({ cropKeypoints: 0, ms: 0, candidates: [] })), dispose() {} } as unknown as GeometricStage;
}

function retryPipeline(boxes: Candidate[], embedder: BatchEmbedder, maxFacesPerFrame: number): Pipeline {
  const p = new Pipeline({
    detector: { lastTimings: null, propose: async () => boxes } as unknown as FrameDetector,
    embedder, bank: bank(), names: NAMES, accept: { tau: 0.62, delta: 0.05, rotationRetry: false }, now: () => 0, geometric: idleStage(),
  });
  p.setTiltedRetry({ scales: [1], maxFacesPerFrame, budgetMs: 10_000 } as never);
  return p;
}

/** What the pointer shows at a point: the card and its box (not the layer's stacking order,
 *  which counts the frame's named cards). */
const shownAt = (a: Awaited<ReturnType<Pipeline["analyze"]>>, x: number, y: number) => {
  const { cardId, name, boxIndex, box } = hoverAt(a, x, y);
  return { cardId, name, boxIndex, box };
};

describe("row 7 v3: the tilted retry in focus scope takes the pointer's whole group, uncapped", () => {
  it("A: a cap of 1 and a far face scoring higher does not take the retry from the pointer's face", async () => {
    const cards = [{ box: box(20, 20), red: 100 }, { box: box(300, 20), red: 110 }];
    const boxes = cards.map((c) => c.box);
    const make = (cap: number) => retryPipeline(boxes, new RetryEmbedder({ 100: 0.5, 110: 0.55 }, { 100: [1, 0, 0, 0], 110: [0, 1, 0, 0] }), cap);
    const uncapped = await make(2).analyze(scene(cards), 0);
    expect(named(uncapped)).toEqual(["A", "B"]);
    const focus = await make(1).analyze(scene(cards), 0, { geometricScope: "focus", focus: { x: 30, y: 100 } });
    expect(focus.boxes[0]).toEqual(uncapped.boxes[0]);
    expect(shownAt(focus, 30, 100)).toEqual(shownAt(uncapped, 30, 100));
    expect(focus.boxes[0]!.face!.tilted).toBeDefined();
    // The far face is outside the group: no retry, not named.
    expect(focus.boxes[1]!.face).toMatchObject({ cardId: null, unverified: true });
    expect(focus.boxes[1]!.face!.tilted).toBeUndefined();
  });

  it("B: an overlapping face that does not hold the pointer is retried and can win the suppression", async () => {
    const cards = [{ box: box(20, 20), red: 100 }, { box: box(60, 20), red: 110 }, { box: box(500, 20), red: 120 }];
    const boxes = cards.map((c) => c.box);
    const make = (cap: number) => retryPipeline(boxes, new RetryEmbedder({ 100: 0.5, 110: 0.45, 120: 0.55 }, { 100: [0.8, 0, 0, 0], 110: [1, 0, 0, 0], 120: [0, 1, 0, 0] }), cap);
    // Precondition: with the cap of 2, the far face takes the second slot and the pointer's face stays.
    const capped = await make(2).analyze(scene(cards), 0, { focus: { x: 30, y: 100 } });
    expect(keptOf(capped).slice(0, 2)).toEqual([true, false]);
    const uncapped = await make(3).analyze(scene(cards), 0);
    expect(keptOf(uncapped).slice(0, 2)).toEqual([false, true]);
    // The cap of 2 of the review, and a cap of 1: the group is taken whole either way.
    for (const cap of [2, 1]) {
      const focus = await make(cap).analyze(scene(cards), 0, { geometricScope: "focus", focus: { x: 30, y: 100 } });
      for (const i of [0, 1]) expect(focus.boxes[i], `cap ${cap} box ${i}`).toEqual(uncapped.boxes[i]);
      expect(shownAt(focus, 30, 100)).toEqual(shownAt(uncapped, 30, 100));
      expect(focus.boxes[2]!.face!.tilted).toBeUndefined();
    }
  });

  it("leaves the retry of scope all as it was: capped, in its own order", async () => {
    const cards = [{ box: box(20, 20), red: 100 }, { box: box(300, 20), red: 110 }];
    const boxes = cards.map((c) => c.box);
    const p = retryPipeline(boxes, new RetryEmbedder({ 100: 0.5, 110: 0.55 }, { 100: [1, 0, 0, 0], 110: [0, 1, 0, 0] }), 1);
    const all = await p.analyze(scene(cards), 0);
    expect(named(all)).toEqual([null, "B"]); // the higher face took the one slot
  });
});

describe("row 3: a face outside the group whose look is accepted", () => {
  it("is not named, kept, drawn or tracked when the stage applies to every face", async () => {
    const cards = [{ box: box(20, 20), red: 100 }, { box: box(300, 20), red: 250 }];
    const boxes = cards.map((c) => c.box);
    const everyFace = (): GeometricStage => {
      const s = fakeStage();
      (s as unknown as { applies: () => boolean }).applies = () => true;
      return s;
    };
    const frame = scene(cards);
    const run = async (options: object) => {
      const p = pipelineOf(boxes, everyFace());
      let last = await p.analyze(frame, 0, options);
      for (let t = 1; t < 5; t++) last = await p.analyze(frame, t * 0.1, options);
      return last;
    };
    // Precondition: with every face verified, the accepted face is named and tracked.
    const all = await run({});
    expect(named(all)).toEqual(["B", "A"]);
    expect(all.tracks.shown && all.tracks.cards.some((c) => c.cardId === "A")).toBe(true);

    const focus = await run({ geometricScope: "focus", focus: { x: 30, y: 100 } });
    expect(focus.boxes[0]!.face!.cardId).toBe("B");
    const face = focus.boxes[1]!.face!;
    expect([face.cardId, face.tauPassed, face.kept, face.unverified]).toEqual([null, false, false, true]);
    expect(focus.hover.cards.some((c) => c.cardId === "A")).toBe(false);
    expect(focus.tracks.cards.some((c) => c.cardId === "A")).toBe(false);
    expect(hoverAt(focus, 350, 90).cardId ?? null).toBeNull();
  });
});

describe("row 5: without a stage the option does nothing", () => {
  const cards = [{ box: box(20, 20), red: 100 }, { box: box(300, 20), red: 110 }];
  const boxes = cards.map((c) => c.box);
  const embedder = () => new RetryEmbedder({ 100: 0.5, 110: 0.55 }, { 100: [1, 0, 0, 0], 110: [0, 1, 0, 0] });
  const focusOn = { geometricScope: "focus" as const, focus: { x: 30, y: 100 } };

  it("no stage, a tilted retry with a cap of 1: focus on and off give the same frame", async () => {
    const make = (stage: GeometricStage | null) => {
      const p = retryPipeline(boxes, embedder(), 1);
      p.setGeometric(stage);
      return p;
    };
    const off = await make(null).analyze(scene(cards), 0);
    expect(named(off)).toEqual([null, "B"]); // the higher face takes the one slot
    const on = await make(null).analyze(scene(cards), 0, focusOn);
    expect(JSON.stringify(on.boxes)).toBe(JSON.stringify(off.boxes));
    expect(on.boxes.some((b) => b.face!.unverified)).toBe(false);
  });

  it("a stage that fails on frame 1 and is removed: frame 1 and frame 2 are answered as with the option off", async () => {
    const failing = (): GeometricStage => ({ reorder: true, applies: () => true, verifyBatch: async () => { throw new Error("boom"); }, dispose() {} }) as unknown as GeometricStage;
    const run = async (options: object) => {
      const p = retryPipeline(boxes, embedder(), 1);
      p.setGeometric(failing());
      const frames = [await p.analyze(scene(cards), 0, options)];
      expect(p.takeGeometricFailure()).not.toBeNull();
      expect(p.geometricStage).toBeNull();
      frames.push(await p.analyze(scene(cards), 0.1, options));
      return frames.map((f) => JSON.stringify(f.boxes));
    };
    const off = await run({});
    const on = await run(focusOn);
    expect(on).toEqual(off);
    expect(JSON.parse(off[0]!).map((b: { face: { cardId: string | null } }) => b.face.cardId)).toEqual([null, "B"]);
  });
});
