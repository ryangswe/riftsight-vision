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
import { FrameScheduler, HOVER_TRIGGER_MIN_GAP_MS, POINTER_GRACE_MS, REPEAT_INTERVAL_MS } from "../src/frame-scheduler.js";
import { SessionCore, SHOWN_HOLD } from "../src/session-core.js";
import { watchVideo } from "../src/video-events.js";
import { CONFIRM_FRAMES } from "../src/temporal-gate.js";
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

// ------------------------------------------------------------ row 8: a paused picture
describe("row 8: a card reached on a paused picture is looked at again", () => {
  type Box = { box: number[]; face: { unverified?: true; cardId: string | null } };
  /** A 1000 x 500 analysis: card A (x 100..300) and card B (x 600..800), then C (x 350..550). A is
   *  always verified. `verified` lists the other cards the analysis verified (named). */
  const analysisOf = (verified: string[]): never => {
    const spec: Array<[string, number]> = [["A", 100], ["B", 600], ["C", 350]];
    const boxes: Box[] = spec.map(([id, x]) => ({
      box: [x, 100, 200, 300],
      face: id === "A" || verified.includes(id) ? { cardId: id } : { unverified: true, cardId: null },
    }));
    return { frame: { width: 1000, height: 500 }, hover: { selection: "accepted-nms", cards: [] }, boxes } as never;
  };
  const hit = (a: { boxes: Box[] }, x: number, y: number) => {
    const i = a.boxes.findIndex((b) => x >= b.box[0]! && x <= b.box[0]! + b.box[2]! && y >= b.box[1]! && y <= b.box[1]! + b.box[3]!);
    const face = i < 0 ? null : a.boxes[i]!.face;
    const b = i < 0 ? null : { x: a.boxes[i]!.box[0]!, y: a.boxes[i]!.box[1]!, width: a.boxes[i]!.box[2]!, height: a.boxes[i]!.box[3]! };
    return { card: null, boxIndex: i < 0 ? null : i, box: face?.cardId ? b : null, cardId: face?.cardId ?? null, name: face?.cardId ?? null };
  };

  function setup(options: ConstructorParameters<typeof SessionCore>[1]) {
    let now = 1_000;
    const sent: Array<Extract<WorkerRequest, { kind: "frame" }>> = [];
    let captured = 0;
    let answered = 0;
    let verified: string[] = [];
    let neverVerify = false;
    const core = new SessionCore({ now: () => now, toWorker: (r) => { if (r.kind === "frame") sent.push(r); }, capture: () => { captured += 1; }, hoverAt: hit as never }, options);
    core.fromWorker({ kind: "release-status", ok: true, error: null, release: { analysisWidth: { min: 720, max: 1920 }, hoverMaxAgeMs: 2000, recognizer: { ep: "wasm" } } as never, cards: [] });
    const bitmap = { width: 1000, height: 500, close() {} } as unknown as ImageBitmap;
    /** Answer the look in flight, if there is one: the picture, then an analysis that verified
     *  `verified` (plus the pointer's group, as the runtime does with the option on). */
    const answer = (): boolean => {
      const id = captured;
      if (answered >= id) return false;
      core.frame(id, bitmap, 1 + id * 0.01); // a clock that creeps: its repeats are not of an unchanged picture
      const request = sent.at(-1)!;
      const f = request.focus;
      if (options?.geometricScope === "focus" && f && !neverVerify) {
        for (const [card, x] of [["B", 600], ["C", 350]] as const) if (f.x >= x && f.x <= x + 200 && !verified.includes(card)) verified = [...verified, card];
      }
      if (!f && !neverVerify) verified = ["B", "C"]; // a look with no focus verifies every face, as the pipeline does
      core.fromWorker({ kind: "frame-result", envelope: request.envelope, videoTimeSec: 1, width: 1000, height: 500, workerMs: 5, analysis: analysisOf(verified) });
      answered = id;
      return true;
    };
    const step = (ms: number): void => {
      now += ms;
      core.tick();
    };
    return { core, sent, answer, step, captured: () => captured, clock: () => now, neverVerify: (v: boolean) => { neverVerify = v; } };
  }

  /** The picture is paused: presented once, then analyzed with its repeats, with the pointer on A. */
  function paused(options: ConstructorParameters<typeof SessionCore>[1]) {
    const t = setup(options);
    // The video was playing and is paused on its last frame: the repeats come within a second of
    // frames that were presented close together, so they keep the focus (a picture that is
    // still from the seek on gets full repeats instead, and has no unverified face to look for).
    for (let i = 0; i < 3; i++) {
      t.core.presented(1);
      t.step(30);
    }
    t.core.pointer(0.2, 0.5, 1); // on A
    for (let i = 0; i < 12; i++) {
      t.answer();
      t.step(260);
    }
    t.step(2_000); // nothing more runs on its own
    return t;
  }

  it("names a card reached 2 s after the pause, after one more look and its repeats", () => {
    const t = paused({ geometricScope: "focus" });
    const before = t.captured();
    expect(before).toBe(CONFIRM_FRAMES); // the presented picture and its repeats, then nothing
    expect(t.core.hitAt(0.7, 0.5)?.cardId ?? null).toBeNull(); // B is unverified: not named
    t.core.pointer(0.7, 0.5, 1); // the pointer reaches B
    expect(t.captured()).toBe(before + 1);
    t.answer();
    expect(t.core.hitAt(0.7, 0.5)?.cardId).toBe("B");
    expect(t.sent.at(-1)!.focus).toEqual({ x: 700, y: 250 });
    // The repeats of a newly presented picture follow.
    for (let i = 0; i < 6; i++) {
      t.step(260);
      t.answer();
    }
    expect(t.captured()).toBe(before + CONFIRM_FRAMES);
    // Verified now: moving about on B asks for nothing, and the card stays named.
    t.step(1_000);
    t.core.pointer(0.71, 0.5, 1);
    t.core.pointer(0.69, 0.5, 1);
    expect(t.captured()).toBe(before + CONFIRM_FRAMES);
    expect(t.core.hitAt(0.7, 0.5)?.cardId).toBe("B");
  });

  it("looks again at most once per HOVER_TRIGGER_MIN_GAP_MS, and never while one is in flight", () => {
    const t = paused({ geometricScope: "focus" });
    const before = t.captured();
    t.core.pointer(0.7, 0.5, 1); // B
    t.core.pointer(0.71, 0.5, 1); // in flight: nothing more
    expect(t.captured()).toBe(before + 1);
    t.answer();
    t.step(HOVER_TRIGGER_MIN_GAP_MS - 100);
    t.core.pointer(0.45, 0.5, 1); // C, too soon after the last look the pointer started
    expect(t.captured()).toBe(before + 1);
    t.step(HOVER_TRIGGER_MIN_GAP_MS);
    t.core.pointer(0.46, 0.5, 1);
    expect(t.captured()).toBe(before + 2);
  });

  it("does nothing in scope all, or on a face that is verified or not under the pointer", () => {
    const all = paused({});
    const n = all.captured();
    all.core.pointer(0.7, 0.5, 1);
    all.step(1_000);
    expect(all.captured()).toBe(n);
    const t = paused({ geometricScope: "focus" });
    const before = t.captured();
    t.core.pointer(0.5, 0.05, 1); // over no face
    t.core.pointer(0.2, 0.5, 1); // A, verified
    t.step(1_000);
    expect(t.captured()).toBe(before);
  });

  it("never looks again at a playing video: focus starts no more looks than scope all", async () => {
    const run = (options: ConstructorParameters<typeof SessionCore>[1]) => {
      const t = setup(options);
      for (let i = 0; i < 40; i++) {
        t.core.presented(1 + i * 0.15); // a playing video presents a frame every tick
        t.core.pointer([0.2, 0.7, 0.45][i % 3]!, 0.5, 1 + i * 0.15); // and the pointer crosses the cards
        t.answer();
        t.step(150);
        t.answer();
      }
      return t.captured();
    };
    const all = run({});
    expect(all).toBeGreaterThan(5);
    expect(run({ geometricScope: "focus" })).toBeLessThanOrEqual(all);
  });

  it("waits out a retry's back-off, and a refused capture asks for nothing at rest", () => {
    const t = paused({ geometricScope: "focus" });
    const before = t.captured();
    t.core.pointer(0.7, 0.5, 1); // B: the re-look
    const times: number[] = [t.clock()];
    let failed = before;
    for (let ms = 0; ms < 9_000 && times.length < 5; ms += 25) {
      if (t.captured() > failed) {
        failed = t.captured();
        if (times.length < 5) {
          if (failed !== before + 1) times.push(t.clock());
        }
        t.core.captureFailed(failed, "no picture yet", true);
      }
      t.step(25);
    }
    const gaps = times.slice(1).map((at, i) => at - times[i]!);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    // 250, 500, 1000 (then 2000): each at least its back-off, and within a tick of it.
    [250, 500, 1_000, 2_000].slice(0, gaps.length).forEach((want, i) => {
      expect(gaps[i]!, `gap ${i}`).toBeGreaterThanOrEqual(want);
      expect(gaps[i]!, `gap ${i}`).toBeLessThan(want + 300);
    });

    const r = paused({ geometricScope: "focus" });
    const n = r.captured();
    r.core.pointer(0.7, 0.5, 1);
    // Every capture is refused (the pointer was outside); the refused look's own repeats may
    // still run, and then the resting pointer asks for nothing more.
    let refusedUpTo = n;
    const refuseAll = (): void => {
      while (refusedUpTo < r.captured()) {
        refusedUpTo += 1;
        r.core.captureFailed(refusedUpTo, "the pointer was outside", false);
      }
    };
    refuseAll();
    for (let i = 0; i < 60; i++) {
      r.step(50);
      refuseAll();
    }
    const settled = r.captured();
    expect(settled).toBeLessThanOrEqual(n + CONFIRM_FRAMES);
    for (let i = 0; i < 100; i++) {
      r.step(50);
      refuseAll();
    }
    expect(r.captured()).toBe(settled);
  });

  it("looks again from tick when the pointer reached the face while the last repeat was in flight, and rests", () => {
    const t = paused({ geometricScope: "focus" });
    t.core.pointer(0.7, 0.5, 1); // B: the re-look, then its repeats
    t.answer();
    const begun = t.captured();
    // A picture that has been still for a second gets full repeats, which leave nothing for this
    // path to look for. This stands in for repeats that did not verify C (a stage that ran out of
    // time on them, say): the re-look remains the safety net.
    t.neverVerify(true);
    // Run to the last repeat and leave it in flight.
    for (let spins = 0; t.captured() < begun + CONFIRM_FRAMES - 1; spins++) {
      if (spins > 200) throw new Error(`the repeats did not run: ${t.captured() - begun} of ${CONFIRM_FRAMES - 1} after 200 steps`);
      t.step(50);
      if (t.captured() < begun + CONFIRM_FRAMES - 1) t.answer();
    }
    t.core.pointer(0.45, 0.5, 1); // C: a look is in flight, so nothing starts now
    expect(t.captured()).toBe(begun + CONFIRM_FRAMES - 1);
    t.answer(); // the repeat (which asked with the pointer on B) comes back; C is not verified
    expect(t.core.hitAt(0.45, 0.5)?.cardId ?? null).toBeNull();
    t.neverVerify(false);
    for (let i = 0; i < 20; i++) {
      t.step(50); // the pointer rests: only tick can look again
      t.answer();
    }
    expect(t.sent.filter((r) => r.focus).at(-1)!.focus).toEqual({ x: 450, y: 250 }); // the re-look; repeats send no focus
    expect(t.core.hitAt(0.45, 0.5)?.cardId).toBe("C");
  });

  it("does not look again for a pointer that has rested past the grace period", () => {
    const t = paused({ geometricScope: "focus" });
    t.neverVerify(true); // B stays unverified, so the re-look repeats while it is allowed
    t.core.pointer(0.7, 0.5, 1);
    const start = t.clock();
    let lastCapture = start;
    let seen = t.captured();
    for (let i = 0; i < 300; i++) {
      t.answer();
      t.step(50);
      if (t.captured() > seen) {
        seen = t.captured();
        lastCapture = t.clock();
      }
    }
    expect(lastCapture - start).toBeGreaterThan(1_000); // it did keep trying
    expect(lastCapture - start).toBeLessThanOrEqual(POINTER_GRACE_MS + 300); // and stopped with the grace period
  });
});

describe("row 8: FrameScheduler.relookDue", () => {
  /** A paused picture analyzed with all its repeats, the pointer moved onto it at `moved`. */
  function still(moved: number) {
    const s = new FrameScheduler(500, 3, "pointer", 1000);
    s.framePresented();
    s.pointerMoved(0);
    s.started(0);
    s.started(250);
    s.started(500); // the presented picture and two repeats
    s.pointerMoved(moved);
    return s;
  }

  it("is due on a still picture the pointer moved onto, once the gap has passed", () => {
    const s = still(2_000);
    expect(s.relookDue(2_000, false)).toBe(true);
    expect(s.relookDue(2_000, true)).toBe(false); // one in flight
    s.started(2_000, { trigger: "hover" });
    expect(s.relookDue(2_000 + HOVER_TRIGGER_MIN_GAP_MS - 1, false)).toBe(false); // repeats waiting, and the gap
  });

  it("is not due while a frame is waiting, repeats are left, a retry waits or a capture was refused", () => {
    const presented = still(2_000);
    presented.framePresented();
    expect(presented.relookDue(2_000, false)).toBe(false);
    const retry = still(2_000);
    retry.lookUnanswered(2_000);
    expect(retry.relookDue(2_100, false)).toBe(false);
    const refused = still(2_000);
    refused.lookRefused();
    expect(refused.relookDue(2_000, false)).toBe(false);
  });

  it("is not due while the repeats of a look are left, with nothing else blocking", () => {
    const s = still(2_000);
    s.started(2_000, { trigger: "hover" }); // the re-look: it gets a presented picture's repeats
    expect(s.idle).toBe(false);
    expect(s.relookDue(2_300, false)).toBe(false);
    s.started(2_300); // repeat 1
    s.started(2_550); // repeat 2: none left
    expect(s.idle).toBe(true);
    expect(s.relookDue(2_800, false)).toBe(true);
  });

  it("is not due inside the minimum gap when nothing else blocks it", () => {
    const s = new FrameScheduler(500, 1, "pointer", 1000); // one analysis per picture: no repeats
    s.framePresented();
    s.pointerMoved(0);
    s.started(0);
    s.pointerMoved(2_000);
    s.started(2_000, { trigger: "hover" });
    expect(s.idle).toBe(true);
    expect(s.relookDue(2_000 + HOVER_TRIGGER_MIN_GAP_MS - 1, false)).toBe(false);
    expect(s.relookDue(2_000 + HOVER_TRIGGER_MIN_GAP_MS, false)).toBe(true);
  });

  it("is not due once the pointer's grace period is over", () => {
    const s = still(2_000);
    expect(s.relookDue(2_000 + POINTER_GRACE_MS - 1, false)).toBe(true);
    expect(s.relookDue(2_000 + POINTER_GRACE_MS + 1, false)).toBe(false);
  });
});

describe("row 8: the session's group is the recognizer's", () => {
  it("agrees on which faces are in the pointer's group, with backs, a too-small box and a clipped box in the frame", async () => {
    const back = { ...box(300, 20), cls: 1 };
    const tiny = box(450, 300);
    tiny.aabb = { x: 450, y: 300, width: 5, height: 5 };
    const cards = [
      { box: box(20, 20), red: 100 },
      { box: box(60, 20), red: 110 },
      { box: back, red: 120 },
      { box: box(560, 20), red: 120 },
      { box: box(720, 20), red: 100 }, // runs past the frame's right edge: clipped
    ];
    const boxes = [...cards.map((c) => c.box), tiny];
    for (const pointer of [{ x: 30, y: 100 }, { x: 600, y: 100 }, { x: 780, y: 100 }, { x: 350, y: 100 }]) {
      const analysis = await pipelineOf(boxes, fakeStage()).analyze(scene(cards.filter((c) => c.box.cls === 0)), 0, { geometricScope: "focus", focus: pointer });
      // The session's computation (session-core.ts relookForUnverified), over analysis.boxes.
      const faces = analysis.boxes.filter((b) => b.face !== null);
      const group = focusGroup(faces.map((b) => ({ x: b.box[0], y: b.box[1], width: b.box[2], height: b.box[3] })), pointer);
      faces.forEach((b, i) => {
        const inGroup = group.has(i);
        expect(b.face!.unverified === true, `pointer ${pointer.x}, face ${i}`).toBe(!inGroup);
      });
      expect(faces.length).toBe(4); // the back and the too-small box are not faces
    }
  });
});

// ---------------------------------------------- rows 9 and 10: reading a focus result
describe("rows 9 and 10: a focus result is read only where its group is verified", () => {
  const PX = (x: number) => x / 800;
  const PY = 100 / 450;

  /** The real Pipeline behind a SessionCore, frame by frame, with the clock stepped by hand. */
  function live(boxes: Candidate[], cards: Array<{ box: Candidate; red: number }>, options: ConstructorParameters<typeof SessionCore>[1], stage: GeometricStage = fakeStage(), mediaOf?: () => number) {
    const frame = scene(cards);
    let mediaSec = 1;
    const pipeline = pipelineOf(boxes, stage);
    let now = 1_000;
    const sent: Array<Extract<WorkerRequest, { kind: "frame" }>> = [];
    const pending: Promise<void>[] = [];
    let core!: SessionCore;
    core = new SessionCore(
      {
        now: () => now,
        toWorker: (r) => {
          if (r.kind !== "frame") return;
          sent.push(r);
          pending.push(
            pipeline.analyze(frame, r.videoTimeSec, { ...(r.geometricScope ? { geometricScope: r.geometricScope } : {}), ...(r.focus !== undefined ? { focus: r.focus } : {}) }).then((analysis) =>
              core.fromWorker({ kind: "frame-result", envelope: r.envelope, videoTimeSec: r.videoTimeSec, width: 800, height: 450, workerMs: 5, analysis }),
            ),
          );
        },
        capture: (id) => core.frame(id, { width: 800, height: 450, close() {} } as unknown as ImageBitmap, mediaOf ? mediaOf() : mediaSec),
      },
      options,
    );
    core.fromWorker({ kind: "release-status", ok: true, error: null, release: { analysisWidth: { min: 720, max: 1920 }, hoverMaxAgeMs: 2000, recognizer: { ep: "wasm" } } as never, cards: [] });
    const flush = async (): Promise<void> => {
      while (pending.length) await pending.shift();
    };
    /** Let the picture settle: its analyses and repeats run, with the clock stepping. */
    const settle = async (ms = 3_000): Promise<void> => {
      for (let t = 0; t < ms; t += 50) {
        now += 50;
        core.tick();
        await flush();
      }
    };
    const step = (ms: number): void => {
      now += ms;
      core.tick();
    };
    return { core, sent, flush, settle, step, clock: () => now, setMedia: (sec: number) => { mediaSec = sec; } };
  }

  // X at 20..120 and Y at 80..180: offset 60 % of a width, IoU 0.25, not one group.
  const fan = [{ box: box(20, 20), red: 100 }, { box: box(80, 20), red: 110 }];
  const fanBoxes = fan.map((c) => c.box);
  const strip = 100; // x inside both boxes

  it("never shows the card beneath in the strip: only Y or nothing, and Y after the re-look", async () => {
    const t = live(fanBoxes, fan, { geometricScope: "focus" });
    t.core.presented(1);
    t.core.pointer(PX(40), PY, 1); // on X only
    await t.flush(); // the focus look only: a still picture's repeats now check every card
    expect(t.core.fresh()?.cardId).toBe("B"); // X, verified with the pointer there
    expect(t.sent.at(-1)!.focus).toEqual({ x: 40, y: 100 });
    t.core.pointer(PX(strip), PY, 1); // into the strip
    expect(t.core.fresh()?.cardId ?? null).not.toBe("B"); // never X
    expect(t.core.hitAt(PX(strip), PY)).toBeNull();
    await t.flush();
    await t.settle(); // the next look is the full repeat, which verifies every card
    const allPipeline = pipelineOf(fanBoxes, fakeStage());
    const all = await allPipeline.analyze(scene(fan), 0);
    expect(t.core.fresh()?.cardId ?? null).toBe(hoverAt(all, strip, 100).cardId ?? null);
    expect(t.core.fresh()?.cardId).toBe("C"); // Y
  });

  it("ends a held tooltip when the pointer enters a strip with an unverified face", async () => {
    const t = live(fanBoxes, fan, { geometricScope: "focus", hold: SHOWN_HOLD });
    t.core.presented(1);
    t.core.pointer(PX(40), PY, 1);
    await t.flush(); // the focus look only: a still picture's repeats now check every card
    expect(t.core.shown()?.cardId).toBe("B");
    t.core.pointer(PX(strip), PY, 1);
    expect(t.core.shown()).toBeNull(); // not the held X
    expect(t.core.shown()).toBeNull();
    await t.flush();
    await t.settle(); // the next look is the full repeat, which verifies every card
    expect(t.core.shown()?.cardId).toBe("C");
  });

  it("does not name a face the stage does not apply to where a boosted neighbour would suppress it", async () => {
    // X is accepted (not applied), Y overlaps it by IoU 0.43 and is boosted; Z is far away.
    const cards = [{ box: box(20, 20), red: 250 }, { box: box(60, 20), red: 120 }, { box: box(500, 20), red: 100 }];
    const boxes = cards.map((c) => c.box);
    const t = live(boxes, cards, { geometricScope: "focus" });
    t.core.presented(1);
    t.core.pointer(PX(550), PY, 1); // the result is taken with the pointer on Z
    await t.flush(); // the focus look only: a still picture's repeats now check every card
    const named = (c: SessionCore) => c.hitAt(PX(30), PY)?.cardId ?? null;
    const all = await pipelineOf(boxes, fakeStage()).analyze(scene(cards), 0);
    expect(hoverAt(all, 30, 100).cardId ?? null).toBeNull(); // "all": the boosted neighbour suppresses X
    t.core.pointer(PX(30), PY, 1); // onto X alone, which Y overlaps
    expect(named(t.core)).toBeNull();
    await t.flush();
    await t.settle(); // the next look is the full repeat, which verifies every card
    expect(named(t.core)).toBe(hoverAt(all, 30, 100).cardId ?? null);
    // Not blocked for good: the group's faces were verified by the re-look, and the card Y
    // named is the one "all" names where it is not suppressed.
    const faces = t.core.analysis()!.boxes.map((b) => b.face!);
    expect([faces[0]!.unverified, faces[1]!.unverified]).toEqual([undefined, undefined]);
    expect(faces[2]!.unverified).toBeUndefined(); // the full repeat verified the far card too
    expect(t.core.hitAt(PX(150), PY)?.cardId ?? null).toBe(hoverAt(all, 150, 100).cardId ?? null);
    expect(t.core.hitAt(PX(150), PY)?.cardId).toBe("D");
  });

  it("leaves scope all as it was: the result is read at once wherever the pointer is", async () => {
    const t = live(fanBoxes, fan, {});
    t.core.presented(1);
    t.core.pointer(PX(40), PY, 1);
    await t.flush();
    await t.settle();
    t.core.pointer(PX(strip), PY, 1);
    const all = await pipelineOf(fanBoxes, fakeStage()).analyze(scene(fan), 0);
    expect(t.core.fresh()?.cardId ?? null).toBe(hoverAt(all, strip, 100).cardId ?? null);
    expect(t.core.fresh()).not.toBeNull();
  });

  /** The `others` of the card shown with the pointer at px, for a scope. */
  async function othersAt(cards: Array<{ box: Candidate; red: number }>, px: number, options: ConstructorParameters<typeof SessionCore>[1], stage: GeometricStage | null) {
    const t = live(cards.map((c) => c.box), cards, options, stage as GeometricStage);
    t.core.presented(1);
    t.core.pointer(PX(px), PY, 1);
    await t.flush(); // the focus look only: a still picture's repeats now check every card
    const shown = t.core.fresh();
    return { shown, others: shown?.others.map((b) => JSON.stringify(b)) ?? [] };
  }
  // Two boxes above the suppression threshold (IoU 0.43) and a far card.
  const dup = (red: number) => [{ box: box(300, 20), red }, { box: box(340, 20), red }, { box: box(600, 20), red: 250 }];

  it("row 10 v6: a frame with no unverified face lists exactly what all lists, duplicates suppressed", async () => {
    const all = await othersAt(dup(250), 650, {}, fakeStage());
    expect(all.shown?.cardId).toBe("A");
    expect(all.others).toHaveLength(1); // the pair's kept box, not its suppressed duplicate
    for (const stage of [fakeStage(), null]) {
      const focus = await othersAt(dup(250), 650, { geometricScope: "focus" }, stage);
      expect(focus.others, stage ? "a stage that applies to nothing" : "no stage").toEqual(all.others);
    }
  });

  it("row 10 v6: an unverified group is listed whole, so a tooltip avoids every face of it", async () => {
    const focus = await othersAt(dup(100), 650, { geometricScope: "focus" }, fakeStage());
    expect(focus.shown?.cardId).toBe("A");
    expect(focus.others).toHaveLength(2);
    const want = [box(300, 20), box(340, 20)].map((b) => JSON.stringify({ x: b.aabb.x / 800, y: b.aabb.y / 450, width: b.aabb.width / 800, height: b.aabb.height / 450 })).sort();
    expect([...focus.others].sort()).toEqual(want);
  });

  const fr = (b: Candidate) => JSON.stringify({ x: b.aabb.x / 800, y: b.aabb.y / 450, width: b.aabb.width / 800, height: b.aabb.height / 450 });

  it("row 10 v6: a group with an unverified face lists every face, one that focus suppresses and all keeps included", async () => {
    // U (unverified, boosted once verified) overlaps X, X overlaps Z, U and Z do not overlap. In
    // "all" the boosted U suppresses X and Z is kept; in focus U has no card, X wins and Z is
    // suppressed. F, far away, is the shown card.
    const cards = [{ box: box(100, 20), red: 120 }, { box: box(140, 20), red: 250 }, { box: box(180, 20), red: 250 }, { box: box(600, 20), red: 250 }];
    const all = await othersAt(cards, 650, {}, fakeStage());
    expect(all.others).toContain(fr(cards[2]!.box)); // "all" keeps Z
    expect(all.others).not.toContain(fr(cards[1]!.box)); // and suppresses X
    const focus = await othersAt(cards, 650, { geometricScope: "focus" }, fakeStage());
    expect(focus.shown?.cardId).toBe("A");
    expect([...focus.others].sort()).toEqual(cards.slice(0, 3).map((c) => fr(c.box)).sort());
  });

  it("row 10 v6: the limit does not cut a group's faces, and the layer's other boxes follow in the room left", async () => {
    // A chain of three faces with an unverified one, and the shown card.
    const group = [{ box: box(100, 20), red: 100 }, { box: box(140, 20), red: 250 }, { box: box(180, 20), red: 250 }];
    const cards = [...group, { box: box(600, 20), red: 250 }];
    const focus = await othersAt(cards, 650, { geometricScope: "focus", maxOtherBoxes: 1 }, fakeStage());
    expect(focus.others).toHaveLength(3); // the group, whole, past the limit of 1
    expect([...focus.others].sort()).toEqual(group.map((c) => fr(c.box)).sort());
  });

  it("the limit on others holds when no face is unverified", async () => {
    const cards = [100, 250, 400, 550].map((x) => ({ box: box(x, 20), red: 250 }));
    const full = await othersAt(cards, 130, {}, fakeStage());
    expect(full.others).toHaveLength(3);
    for (const options of [{ maxOtherBoxes: 2 }, { geometricScope: "focus" as const, maxOtherBoxes: 2 }]) {
      const capped = await othersAt(cards, 130, options, fakeStage());
      expect(capped.others).toEqual(full.others.slice(0, 2));
    }
  });

  it("row 10: the neighbours of a shown card are the same boxes as under all", async () => {
    const cards = [{ box: box(20, 20), red: 100 }, { box: box(300, 20), red: 110 }, { box: box(560, 20), red: 120 }];
    const boxes = cards.map((c) => c.box);
    const others = async (options: ConstructorParameters<typeof SessionCore>[1]) => {
      const t = live(boxes, cards, options);
      t.core.presented(1);
      t.core.pointer(PX(40), PY, 1);
      await t.flush(); // the focus look only: a still picture's repeats now check every card
      const shown = t.core.fresh()!;
      expect(shown.cardId).toBe("B");
      return shown.others.map((b) => JSON.stringify(b)).sort();
    };
    const all = await others({});
    expect(all).toHaveLength(2);
    expect(await others({ geometricScope: "focus" })).toEqual(all);
  });

  // ------------------------------------------------ the repeats of a still picture check every card
  const three = [{ box: box(20, 20), red: 100 }, { box: box(300, 20), red: 110 }, { box: box(560, 20), red: 120 }];
  const threeBoxes = three.map((c) => c.box);
  const cardAt = (core: SessionCore, x: number) => core.fresh() && core.hitAt(PX(x), PY)?.cardId;

  it("repeats: the look on a still picture runs focus, its one full pass runs scope all", async () => {
    const stage = fakeStage();
    const t = live(threeBoxes, three, { geometricScope: "focus" }, stage);
    t.core.presented(1);
    t.core.pointer(PX(40), PY, 1);
    await t.flush();
    expect(stage.crops).toHaveLength(1); // the look: the card at the pointer
    expect(t.sent[0]).toMatchObject({ geometricScope: "focus", focus: { x: 40, y: 100 } });
    await t.settle();
    const repeats = t.sent.slice(1);
    expect(repeats).toHaveLength(1); // the next repeat finds nothing unverified and is dropped
    for (const r of repeats) {
      expect("focus" in r).toBe(false);
      expect("geometricScope" in r).toBe(false);
    }
    expect(stage.crops).toHaveLength(1 + 3 * repeats.length); // every applicable face, per repeat
    // The answers at every face equal an all session's on the same picture.
    const all = live(threeBoxes, three, {}, fakeStage());
    all.core.presented(1);
    all.core.pointer(PX(40), PY, 1);
    await all.flush();
    await all.settle();
    for (const x of [40, 340, 600]) expect(cardAt(t.core, x), `x ${x}`).toBe(cardAt(all.core, x));
    expect(cardAt(t.core, 340)).toBe("C");
  });

  it("repeats: after the full repeat, a move to another card is named at once with no new look", async () => {
    const t = live(threeBoxes, three, { geometricScope: "focus" });
    t.core.presented(1);
    t.core.pointer(PX(40), PY, 1);
    await t.flush();
    await t.settle();
    t.step(1_000);
    const looks = t.sent.length;
    t.core.pointer(PX(340), PY, 1);
    expect(t.core.fresh()?.cardId).toBe("C");
    t.core.pointer(PX(600), PY, 1);
    expect(t.core.fresh()?.cardId).toBe("D");
    await t.flush();
    t.step(1_000);
    expect(t.sent.length).toBe(looks);
  });

  it("repeats: a move to an unverified card during the full repeat shows nothing until it answers, and queues no extra look", async () => {
    const t = live(threeBoxes, three, { geometricScope: "focus" });
    t.core.presented(1);
    t.core.pointer(PX(40), PY, 1);
    await t.flush();
    t.step(260); // the first repeat is asked for and left in flight
    const looks = t.sent.length;
    expect(looks).toBe(2);
    expect("focus" in t.sent[1]!).toBe(false);
    t.core.pointer(PX(340), PY, 1); // Y, unverified in the result on screen
    expect(t.core.fresh()).toBeNull();
    expect(t.sent.length).toBe(looks); // nothing added behind the repeat
    await t.flush(); // the repeat answers
    expect(t.core.fresh()?.cardId).toBe("C");
    await t.settle();
    expect(t.sent.length).toBe(2); // nothing followed the full pass: no re-look was queued
  });

  it("a paused picture still gets the full repeat", async () => {
    const t = live(threeBoxes, three, { geometricScope: "focus" });
    t.core.presented(1);
    t.core.pointer(PX(40), PY, 1);
    await t.flush();
    await t.settle();
    expect(t.sent.slice(1).every((r) => r.focus === undefined && r.geometricScope === undefined)).toBe(true);
    expect(t.sent).toHaveLength(2); // the focus look and one full pass
  });

  // ------------------------------------------------ pointer mode drops the repeats nothing reads
  const repeatSpan = CONFIRM_FRAMES * REPEAT_INTERVAL_MS + 500;

  it("still repeats: scope all, a paused hover is one analysis, the repeat is dropped and the answer is unchanged", async () => {
    const t = live(threeBoxes, three, {});
    t.core.presented(1);
    t.core.pointer(PX(40), PY, 1);
    await t.flush();
    expect(t.sent).toHaveLength(1);
    const answer = cardAt(t.core, 40);
    expect(answer).toBe("B");
    await t.settle(repeatSpan + 2_000);
    expect(t.sent).toHaveLength(1);
    expect(cardAt(t.core, 40)).toBe(answer);
    expect(cardAt(t.core, 340)).toBe("C");
    expect(t.core.status().lastFrameError).toBeNull();
  });

  it("still repeats: focus, a paused hover is the focus look and one full pass, then nothing", async () => {
    const t = live(threeBoxes, three, { geometricScope: "focus" });
    t.core.presented(1);
    t.core.pointer(PX(40), PY, 1);
    await t.flush();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ geometricScope: "focus" });
    await t.settle(repeatSpan + 2_000);
    expect(t.sent).toHaveLength(2);
    expect("geometricScope" in t.sent[1]!).toBe(false);
    const all = live(threeBoxes, three, {});
    all.core.presented(1);
    all.core.pointer(PX(40), PY, 1);
    await all.flush();
    await all.settle();
    for (const x of [40, 340, 600]) expect(cardAt(t.core, x), `x ${x}`).toBe(cardAt(all.core, x));
  });

  it("still repeats: a repeat whose picture differs in time is analyzed, until one finds the picture still", async () => {
    let media = 1;
    const t = live(threeBoxes, three, {}, fakeStage(), () => media);
    t.core.presented(1);
    t.core.pointer(PX(40), PY, 1);
    await t.flush();
    expect(t.sent).toHaveLength(1);
    media = 1.04; // the pause landed a frame after the look
    t.step(REPEAT_INTERVAL_MS + 10);
    await t.flush();
    expect(t.sent).toHaveLength(2); // different picture: analyzed
    await t.settle(repeatSpan + 2_000); // media stands at 1.04 now: the next repeat is dropped
    expect(t.sent).toHaveLength(2);
  });

  it("still repeats: always-on repeats a still picture as before", async () => {
    // Layout mode never repeats a still picture (scheduler.test.ts), and the drop is guarded by
    // `mode === "pointer"`.
    const t = live(threeBoxes, three, { mode: "always-on" });
    t.core.presented(1);
    await t.settle(8_000);
    expect(t.sent).toHaveLength(CONFIRM_FRAMES);
  });

  it("still repeats: a dropped repeat leaves no back-off or retry; a cut and a seek are due at once", async () => {
    const t = live(threeBoxes, three, {});
    t.core.presented(1);
    t.core.pointer(PX(40), PY, 1);
    await t.flush();
    await t.settle(repeatSpan);
    expect(t.sent).toHaveLength(1);
    expect(t.core.status().lastFrameError).toBeNull();
    t.core.cut(); // due at once
    t.step(0);
    await t.flush();
    expect(t.sent).toHaveLength(2);
    await t.settle(repeatSpan);
    expect(t.sent).toHaveLength(2); // the cut's own repeat is dropped too
    t.core.discontinuity(false);
    t.core.presented(2);
    t.core.pointer(PX(60), PY, 2);
    t.step(0);
    await t.flush();
    expect(t.sent).toHaveLength(3);
  });

  it("a first focus look at an accepted card gives all's answer wherever it is read, before any repeat", async () => {
    // X is accepted (the stage does not apply to it); Y overlaps it by IoU 0.43 and is boosted
    // once verified, which suppresses X in "all". The pointer is on X, so the look verifies Y.
    const cards = [{ box: box(20, 20), red: 250 }, { box: box(60, 20), red: 120 }, { box: box(500, 20), red: 100 }];
    const boxes = cards.map((c) => c.box);
    const t = live(boxes, cards, { geometricScope: "focus" });
    t.core.presented(1);
    t.core.pointer(PX(30), PY, 1);
    await t.flush(); // the focus look only
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ geometricScope: "focus", focus: { x: 30, y: 100 } });
    const all = await pipelineOf(boxes, fakeStage()).analyze(scene(cards), 0);
    for (const x of [30, 70, 100, 150]) {
      expect(t.core.hitAt(PX(x), PY)?.cardId ?? null, `x ${x}`).toBe(hoverAt(all, x, 100).cardId ?? null);
    }
    expect(t.core.hitAt(PX(30), PY)).toBeNull(); // the boosted neighbour suppresses X, as in "all"
    expect(t.core.hitAt(PX(150), PY)?.cardId).toBe("D"); // and is itself named
  });

  // ------------------------------------------------ a repeat is full when the clock stood still
  type Live = ReturnType<typeof live>;
  const isFull = (r: { geometricScope?: string; focus?: unknown }): boolean => r.geometricScope === undefined && r.focus === undefined;
  /** Run the clock for `ms` in 50 ms steps, answering what is asked. */
  const run = async (t: Live, ms: number): Promise<void> => {
    for (let k = 0; k < ms / 50; k++) {
      t.step(50);
      await t.flush();
    }
  };

  it("seek while paused: the seek reports three presented frames, and the first repeat is still full", async () => {
    const stage = fakeStage();
    const t = live(threeBoxes, three, { geometricScope: "focus" }, stage);
    t.core.presented(4);
    t.step(30);
    t.core.discontinuity(false);
    t.setMedia(5);
    for (let i = 0; i < 3; i++) t.core.presented(5); // rVFC, timeupdate and seeked, in the same ms
    t.core.pointer(PX(40), PY, 5);
    await t.flush();
    expect(t.sent[0]).toMatchObject({ geometricScope: "focus", focus: { x: 40, y: 100 } });
    expect(stage.crops).toHaveLength(1);
    await run(t, 300); // the first repeat
    expect(isFull(t.sent[1]!)).toBe(true);
    expect(stage.crops).toHaveLength(1 + 3);
    const looks = t.sent.length;
    t.core.pointer(PX(340), PY, 5);
    expect(t.core.fresh()?.cardId).toBe("C"); // a second card, named at once
    expect(t.sent.length).toBe(looks);
  });

  it("a seek to the time the video was at: its repeat is full", async () => {
    const t = live(threeBoxes, three, { geometricScope: "focus" });
    t.setMedia(5);
    t.core.presented(5);
    t.core.pointer(PX(40), PY, 5);
    await t.flush();
    t.core.discontinuity(false); // a seek to the same time
    t.core.presented(5);
    t.core.presented(5);
    await run(t, 1_500);
    const flags = t.sent.map((r) => (isFull(r) ? "full" : "focus"));
    expect(flags[0]).toBe("focus");
    expect(flags).toContain("full");
  });

  it("play, pause, seek, and a late stale report: a full look follows (the cadence look, then its repeat)", async () => {
    let frozenAt: number | null = null;
    let t0 = 0;
    const t: Live = live(threeBoxes, three, { geometricScope: "focus" }, fakeStage(), () => frozenAt ?? 4 + (t.clock() - t0) / 1000);
    t0 = t.clock();
    for (let i = 0; i < 6; i++) {
      t.core.presented(4 + i * 0.2); // playing: the clock moves
      t.step(200);
    }
    t.core.discontinuity(false);
    t.core.presented(5.489); // rVFC's stale time
    frozenAt = 5.5; // paused at the seek's frame
    t.core.presented(5.5);
    t.core.presented(5.5);
    t.core.pointer(PX(40), PY, 5.5);
    await t.flush();
    const before = t.sent.length;
    t.core.presented(5.489); // a late rVFC after the look
    await run(t, 2_000); // the cadence of the wasm backend is 1 s, then the repeat 250 ms on
    expect(t.sent.slice(before).some(isFull)).toBe(true);
  });

  it("a pause without a seek: the first repeat is full", async () => {
    let frozenAt: number | null = null;
    let t0 = 0;
    const t: Live = live(threeBoxes, three, { geometricScope: "focus" }, fakeStage(), () => frozenAt ?? 1 + (t.clock() - t0) / 1000);
    t0 = t.clock();
    for (let i = 0; i < 3; i++) {
      t.core.presented(1 + i * 0.03);
      t.step(30);
    }
    frozenAt = 1.09; // paused here: the clock stands still
    t.core.pointer(PX(40), PY, 1.09);
    await t.flush();
    await run(t, 300);
    expect(t.sent.length).toBeGreaterThanOrEqual(2);
    expect(isFull(t.sent[1]!)).toBe(true);
  });

  it("a video whose time moves between the looks keeps the focus on its repeats (a frame every 250 ms, and every 500 ms)", async () => {
    for (const every of [250, 500]) {
      let t0 = 0;
      const t: Live = live(threeBoxes, three, { geometricScope: "focus" }, fakeStage(), () => 1 + (t.clock() - t0) / 1000);
      t0 = t.clock();
      for (let i = 0; i < 16; i++) {
        t.core.presented(1 + (i * every) / 1000);
        t.core.pointer([0.05, 0.4, 0.7][i % 3]!, PY, 1 + (i * every) / 1000);
        await run(t, every);
      }
      expect(t.sent.length, `every ${every} ms`).toBeGreaterThanOrEqual(5);
      expect(t.sent.filter(isFull), `every ${every} ms`).toHaveLength(0);
    }
  });

  it("a seek between the look and its repeat, with equal times: the repeat is not full", async () => {
    const t = live(threeBoxes, three, { geometricScope: "focus" });
    t.setMedia(5);
    t.core.presented(5);
    t.core.pointer(PX(40), PY, 5);
    await t.flush();
    t.core.discontinuity(false); // the repeat that follows is of another generation
    await run(t, 300);
    expect(t.sent.length).toBeGreaterThanOrEqual(2);
    expect(isFull(t.sent[1]!)).toBe(false);
  });

  it("through watchVideo: one seek's duplicate events still give a full first repeat", async () => {
    type Listener = () => void;
    const listeners = new Map<string, Listener[]>();
    const video = {
      paused: true,
      readyState: 4,
      currentTime: 4,
      addEventListener: (type: string, l: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), l]),
      removeEventListener: () => {},
    };
    const fire = (type: string): void => (listeners.get(type) ?? []).forEach((l) => l());
    let core!: SessionCore;
    const watch = watchVideo(video as unknown as HTMLVideoElement, { presented: (t) => core.presented(t), discontinuity: (n) => core.discontinuity(n) });
    const t = live(threeBoxes, three, { geometricScope: "focus" }, fakeStage(), () => watch.mediaTime());
    core = t.core;
    video.currentTime = 5;
    fire("seeking");
    fire("timeupdate"); // the browser reports the same seek again and again
    fire("seeked");
    fire("canplay");
    t.core.pointer(PX(40), PY, watch.mediaTime());
    await t.flush();
    await run(t, 300);
    expect(t.sent.length).toBeGreaterThanOrEqual(2);
    expect(isFull(t.sent[1]!)).toBe(true);
  });

  it("a seek's look was asked for with the old pointer and the pointer moved: the next repeat is a focus look there, then the full pass", async () => {
    const stage = fakeStage();
    const t = live(threeBoxes, three, { geometricScope: "focus" }, stage);
    t.setMedia(5);
    t.core.discontinuity(false);
    t.core.presented(5);
    t.core.presented(5);
    t.core.pointer(PX(40), PY, 5); // the seek's look, asked for with this pointer
    t.step(100);
    t.core.pointer(PX(340), PY, 5); // and 100 ms later the pointer is on another card
    await t.flush(); // the look answers: only the old card is verified
    expect(t.sent[0]!.focus).toEqual({ x: 40, y: 100 });
    expect(t.core.fresh()).toBeNull(); // the new card is unverified: nothing shows
    await run(t, 300); // the next repeat
    expect(t.sent[1]).toMatchObject({ geometricScope: "focus", focus: { x: 340, y: 100 } });
    expect(t.core.fresh()?.cardId).toBe("C"); // named by that one focus look
    await run(t, 300); // the repeat after it is the full pass
    expect(isFull(t.sent[2]!)).toBe(true);
    const looks = t.sent.length;
    t.core.pointer(PX(600), PY, 5);
    expect(t.core.fresh()?.cardId).toBe("D"); // a later card needs no look
    expect(t.sent.length).toBe(looks);
  });

  it("a look that is not a repeat keeps the focus on a paused picture, even at the same video time", async () => {
    const t = live(threeBoxes, three, { geometricScope: "focus" });
    t.setMedia(5);
    t.core.presented(5);
    t.core.pointer(PX(40), PY, 5);
    await t.flush();
    const before = t.sent.length;
    t.core.presented(5); // a late report of the same picture: a look by the cadence, not a repeat
    await run(t, 1_500);
    const next = t.sent[before];
    expect(next).toBeDefined();
    expect(next).toMatchObject({ geometricScope: "focus" });
  });
});
