// SPDX-License-Identifier: Apache-2.0
// The tilted retry (tilt.ts and its use in recognition.ts, pipeline.ts and worker-host.ts):
// the estimate, the rectangle solve and the sampler against the answers the Python package
// gives (the "tilt" section of fixtures/contract.json), the release block, and the retry on a
// stand-in model that accepts a crop only when it is almost all card.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { EmbeddingBank } from "../src/bank.js";
import { rectOf } from "../src/boxes.js";
import type { FrameDetector } from "../src/detector/detector.js";
import type { BatchEmbedder } from "../src/embedder.js";
import { GeometricWatchdog } from "../src/geometric/stage.js";
import type { LoadedRelease } from "../src/load.js";
import type { FrameResult, TiltedStatus, WorkerReply } from "../src/messages.js";
import { Pipeline } from "../src/pipeline.js";
import type { GeometricStage } from "../src/geometric/stage.js";
import { rotateTensor90, toContractTensor } from "../src/preprocess.js";
import { nmsPreOrder, recognizeFrame, tiltedOrder } from "../src/recognition.js";
import { EmbeddingRecognizer } from "../src/recognizer.js";
import { parseRelease } from "../src/release.js";
import { DEFAULT_TILTED_RETRY, estimateTilt, fold, rectFromAabb, roundHalfEven, sampleRect, tiltedRects } from "../src/tilt.js";
import { createWorkerHost } from "../src/worker-host.js";
import { contract, FIXTURES, sha, syntheticRgba } from "./support.js";

const TILT = contract.tilt;

/** The contract's synthetic card (tests/test_browser_fixtures.py `tilt_card`), as RGB. */
function tiltCard(theta: number): { data: Uint8Array; width: number; height: number; channels: 3 } {
  const { size, width: cardW, height: cardH } = TILT.card;
  const center = size / 2;
  const a = (theta * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const cover = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0;
      for (let j = 0; j < 4; j++) {
        const Y = y + (j + 0.5) / 4 - center;
        for (let i = 0; i < 4; i++) {
          const X = x + (i + 0.5) / 4 - center;
          const u = X * c + Y * s;
          const v = -X * s + Y * c;
          if (Math.abs(u) <= cardW / 2 && Math.abs(v) <= cardH / 2) inside++;
        }
      }
      cover[y * size + x] = inside / 16;
    }
  }
  let x0 = size, y0 = size, x1 = -1, y1 = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (cover[y * size + x]! > 0) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
  }
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.fill(Math.floor(cover[(y + y0) * size + x + x0]! * 255 + 0.5), (y * width + x) * 3, (y * width + x) * 3 + 3);
  }
  return { data, width, height, channels: 3 };
}

describe("the estimate, the solve and the sampler give the Python package's answers", () => {
  it.each(TILT.cards as any[])("a synthetic card turned by $theta degrees", (card: any) => {
    const crop = tiltCard(card.theta);
    expect([crop.width, crop.height]).toEqual([card.width, card.height]);
    // The same arithmetic on both sides (tilt.ts); 1e-6 leaves room for a math library's last bit.
    expect(Math.abs(estimateTilt(crop) - card.estimate)).toBeLessThan(1e-6);
  });

  it.each(TILT.noise as any[])("noise of seed $seed", (item: any) => {
    const crop = { data: syntheticRgba(item.seed, item.width, item.height), width: item.width, height: item.height };
    expect(Math.abs(estimateTilt(crop) - item.estimate)).toBeLessThan(1e-6);
  });

  it("the rectangle solve", () => {
    for (const r of TILT.rects) {
      const found = rectFromAabb(r.width, r.height, r.tilt);
      expect(found.how).toBe(r.how);
      expect(found.w).toBeCloseTo(r.w, 9);
      expect(found.h).toBeCloseTo(r.h, 9);
    }
  });

  it("the sampler, byte for byte", () => {
    const { seed, width, height } = TILT.frame;
    const frame = { data: syntheticRgba(seed, width, height), width, height };
    for (const sample of TILT.samples) {
      const out = sampleRect(frame, sample.cx, sample.cy, sample.w, sample.h, sample.tilt);
      expect([out.width, out.height]).toEqual([sample.width, sample.height]);
      const rgb = new Uint8Array(out.width * out.height * 3);
      for (let p = 0; p < out.width * out.height; p++) rgb.set(out.rgba.subarray(p * 4, p * 4 + 3), p * 3);
      expect(sha(rgb)).toBe(sample.sha256);
    }
  });

  it("folds, and rounds sides as Python does", () => {
    expect([0, 44.9, 45, 45.1, -45, 90, 135].map(fold).map((v) => +v.toFixed(9))).toEqual([0, 44.9, 45, -44.9, 45, 0, 45]);
    expect([0.5, 1.5, 2.5, 2.4999, -0.5, 3.5000001].map(roundHalfEven)).toEqual([0, 2, 2, 2, 0, 4]);
  });
});

describe("the release block", () => {
  it("is optional, read when present and refused when malformed", () => {
    const raw = JSON.parse(readFileSync(`${FIXTURES}toy-release/release.json`, "utf-8"));
    const without = parseRelease(raw);
    expect("release" in without && without.release.tiltedRetry).toBeNull();
    const withBlock = parseRelease({ ...raw, tiltedRetry: { scales: [0.95, 1.0, 1.05], maxFacesPerFrame: 4, budgetMs: 300 } });
    expect("release" in withBlock && withBlock.release.tiltedRetry).toEqual({ scales: [0.95, 1.0, 1.05], maxFacesPerFrame: 4, budgetMs: 300 });
    for (const [block, reason] of [
      [[], "tiltedRetry must be an object"],
      [{ scales: [], maxFacesPerFrame: 1, budgetMs: 1 }, "tiltedRetry.scales must list 1 to 5 numbers from 0.5 to 1.5"],
      [{ scales: [1], maxFacesPerFrame: 0, budgetMs: 1 }, "tiltedRetry.maxFacesPerFrame must be a whole number above 0"],
      [{ scales: [1], maxFacesPerFrame: 1, budgetMs: 1.5 }, "tiltedRetry.budgetMs must be a whole number above 0"],
      [{ scales: [1], maxFacesPerFrame: 1, budgetMs: 1, extra: 1 }, "tiltedRetry has unknown key(s) extra"],
    ] as const) {
      expect(parseRelease({ ...raw, tiltedRetry: block })).toEqual({ error: reason });
    }
  });
});

// ------------------------------------------------------------- the retry, with a stand-in model
const TABLE = 0;
const CARD = 200;
const SIZE = 128;
const PLANE = 3 * SIZE * SIZE;

/** A card turned by `theta` on a plain table, and its bounding box (as the Python test makes it). */
function tiltedCardFrame(theta: number, width = 320, height = 260, at = { x: width / 2, y: height / 2 }) {
  const data = new Uint8ClampedArray(width * height * 4);
  const a = (theta * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const X = x + 0.5 - at.x;
      const Y = y + 0.5 - at.y;
      const inside = Math.abs(X * c + Y * s) <= 50 && Math.abs(-X * s + Y * c) <= 70;
      const v = inside ? CARD : TABLE;
      data.set([v, v, v, 255], (y * width + x) * 4);
      if (inside) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
  }
  const aabb = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  return { frame: { data, width, height }, aabb };
}

/** Bank: the card along axis 0, the other card along axis 1. */
function recognizer(): EmbeddingRecognizer {
  const bank: EmbeddingBank = { ids: ["CARD-1", "OTHER-1"], matrix: new Float32Array([1, 0, 0, 1]), dim: 2, version: 1, model: "fake", preprocessing: "full128", tau: null };
  return new EmbeddingRecognizer(bank, { tau: 0.99, delta: 0.05, rotationRetry: true });
}

/** The stand-in: the embedding turns from the card toward the other row as the table's share grows. */
class CardShare implements BatchEmbedder {
  batches: number[] = [];
  readonly threshold: number;
  private calls = 0;
  /** `failOn`: the call (1 for the first) that throws. */
  constructor(readonly failOn: number | null = null) {
    const grey = new Uint8ClampedArray(8 * 8 * 4).fill((TABLE + CARD) / 2);
    this.threshold = toContractTensor(grey, 8, 8, { size: SIZE, poolVersion: 2 })[0]!;
  }
  async embedBatch(data: Float32Array, n: number): Promise<Float32Array> {
    if (++this.calls === this.failOn) throw new Error("boom");
    this.batches.push(n);
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      let card = 0;
      for (let p = 0; p < SIZE * SIZE; p++) if (data[i * PLANE + p]! > this.threshold) card++;
      const angle = (1 - card / (SIZE * SIZE)) * (Math.PI / 2);
      out.set([Math.cos(angle), Math.sin(angle)], i * 2);
    }
    return out;
  }
}

/** A stand-in that reads only the tensor's top-left quadrant, so the four looks of a tilted card's
 *  crop differ (the table's corners are not the same size); it keeps every batch it was given. */
class QuadrantShare extends CardShare {
  given: Float32Array[] = [];
  override async embedBatch(data: Float32Array, n: number): Promise<Float32Array> {
    this.given.push(data.slice());
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      let card = 0;
      for (let y = 0; y < SIZE / 2; y++) for (let x = 0; x < SIZE / 2; x++) if (data[i * PLANE + y * SIZE + x]! > this.threshold) card++;
      const angle = (1 - card / ((SIZE * SIZE) / 4)) * (Math.PI / 2);
      out.set([Math.cos(angle), Math.sin(angle)], i * 2);
    }
    return out;
  }
}

const face = (aabb: { x: number; y: number; width: number; height: number }) => ({ aabb, rect: rectOf(aabb), score: 0.9, cls: 0 });
const SETTINGS = { ...DEFAULT_TILTED_RETRY, scales: [...DEFAULT_TILTED_RETRY.scales] };

describe("recognizeFrame with the tilted retry", () => {
  it("names a tilted card the crop misses with a straightened rectangle, at the crop's look", async () => {
    const { frame, aabb } = tiltedCardFrame(8);
    const plain = await recognizeFrame(frame, new CardShare(), recognizer(), [face(aabb)]);
    expect(plain.proposals[0]!.accepted).toBe(false);
    const embedder = new CardShare();
    const scored = await recognizeFrame(frame, embedder, recognizer(), [face(aabb)], 24, null, { settings: SETTINGS });
    const p = scored.proposals[0]!;
    expect([p.accepted, p.topId, p.orientation, p.retried]).toEqual([true, "CARD-1", plain.proposals[0]!.orientation, true]);
    expect(p.score).toBeGreaterThan(0.99);
    expect(Math.abs(p.tilted!.tilt - 8)).toBeLessThan(1);
    expect([0.95, 1.0]).toContain(p.tilted!.scale);
    expect(p.tilted!.before).toEqual({ topId: plain.proposals[0]!.topId, similarity: plain.proposals[0]!.score, margin: plain.proposals[0]!.margin });
    expect(embedder.batches).toEqual([1, 3, 3]);
    expect(scored.embeddings).toBe(7);
    expect(scored.tiltedMs).toBeGreaterThanOrEqual(0);
    // The tracker pools the cosine look: `base` holds the face as it was.
    expect(scored.base!.proposals[0]!.accepted).toBe(false);
  });

  it("embeds each rectangle at the crop's best look, turned as the turned looks are", async () => {
    const { frame, aabb } = tiltedCardFrame(8);
    const embedder = new QuadrantShare();
    const scored = await recognizeFrame(frame, embedder, recognizer(), [face(aabb)], 24, null, { settings: SETTINGS });
    const p = scored.proposals[0]!;
    expect(p.orientation).not.toBe(0); // the best look is a turned one
    expect(p.accepted).toBe(true);
    const shipped = (() => {
      const w = Math.floor(aabb.x + aabb.width) - Math.floor(aabb.x);
      const h = Math.floor(aabb.y + aabb.height) - Math.floor(aabb.y);
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) data.set(frame.data.subarray(((aabb.y + y) * frame.width + aabb.x) * 4, ((aabb.y + y) * frame.width + aabb.x + w) * 4), y * w * 4);
      return { data, width: w, height: h };
    })();
    const { rects } = tiltedRects(frame, aabb, shipped, SETTINGS.scales);
    const expected = new Float32Array(rects.length * PLANE);
    rects.forEach((r, q) => expected.set(rotateTensor90(toContractTensor(r.rgba, r.width, r.height, { size: SIZE, poolVersion: 2 }), p.orientation, SIZE), q * PLANE));
    expect(embedder.given).toHaveLength(3);
    expect(embedder.given[2]).toEqual(expected);
  });

  it("runs after the geometric stage, on what it left unaccepted, and keeps its record", async () => {
    const { frame, aabb } = tiltedCardFrame(8);
    // A stage that verifies nothing (the face stays unaccepted), or one that lifts the card above the accept rule.
    const stage = (lift: number) =>
      ({
        reorder: false,
        applies: () => true,
        verifyBatch: async (items: Array<{ ranked: Array<{ cardId: string; cosine: number }> }>) =>
          items.map((item) => {
            const cosine = item.ranked.find((r) => r.cardId === "CARD-1")!.cosine;
            return { cropKeypoints: 0, ms: 0, candidates: lift ? [{ cardId: "CARD-1", cosine, foundBy: "embedding", votes: 0, matches: 50, inliers: 50, evidence: 50, fused: cosine + lift, indexed: true }] : [] };
          }),
        dispose() {},
      }) as unknown as GeometricStage;
    const after = await recognizeFrame(frame, new CardShare(), recognizer(), [face(aabb)], 24, stage(0), { settings: SETTINGS });
    const p = after.proposals[0]!;
    expect([p.accepted, p.tilted?.scale !== null, p.geometric !== undefined]).toEqual([true, true, true]);
    expect(p.tilted!.before.similarity).toBeCloseTo(p.geometric!.before.similarity, 6); // the stage's record is rounded
    const lifted = await recognizeFrame(frame, new CardShare(), recognizer(), [face(aabb)], 24, stage(0.5), { settings: SETTINGS });
    expect([lifted.proposals[0]!.accepted, lifted.proposals[0]!.tilted, lifted.proposals[0]!.geometric !== undefined]).toEqual([true, undefined, true]);
  });

  it("leaves an accepted face alone, and records a try that named nothing", async () => {
    const upright = tiltedCardFrame(0);
    const none = await recognizeFrame(upright.frame, new CardShare(), recognizer(), [face(upright.aabb)], 24, null, { settings: SETTINGS });
    expect([none.proposals[0]!.accepted, none.proposals[0]!.tilted]).toEqual([true, undefined]);
    const half = new Uint8ClampedArray(200 * 200 * 4);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) half.set(x < 90 ? [CARD, CARD, CARD, 255] : [0, 0, 0, 255], (y * 200 + x) * 4);
    const tried = await recognizeFrame({ data: half, width: 200, height: 200 }, new CardShare(), recognizer(), [face({ x: 50, y: 50, width: 80, height: 100 })], 24, null, { settings: SETTINGS });
    const p = tried.proposals[0]!;
    expect([p.accepted, p.tilted!.scale]).toEqual([false, null]);
    expect([p.topId, p.score]).toEqual([p.tilted!.before.topId, p.tilted!.before.similarity]);
  });

  it("takes at most maxFacesPerFrame faces, those under the focus first", async () => {
    const left = tiltedCardFrame(8, 640, 260, { x: 160, y: 130 });
    const right = tiltedCardFrame(8, 640, 260, { x: 480, y: 130 });
    const data = new Uint8ClampedArray(left.frame.data);
    for (let i = 0; i < data.length; i++) data[i] = Math.max(left.frame.data[i]!, right.frame.data[i]!);
    const frame = { data, width: 640, height: 260 };
    const faces = [face(left.aabb), face(right.aabb)];
    const one = { settings: { ...SETTINGS, maxFacesPerFrame: 1 }, focus: { x: 480, y: 130 } };
    const scored = await recognizeFrame(frame, new CardShare(), recognizer(), faces, 24, null, one);
    expect(scored.proposals.map((p) => [p.accepted, p.tilted !== undefined])).toEqual([[false, false], [true, true]]);
  });

  it("orders faces under the focus by size, then the rest by score, and skips accepted ones", () => {
    const box = (x: number, size: number) => ({ x, y: 0, width: size, height: size });
    const faces = [
      { aabb: box(0, 50), similarity: 0.5, accepted: false },
      { aabb: box(0, 30), similarity: 0.4, accepted: false },
      { aabb: box(100, 10), similarity: 0.6, accepted: false },
      { aabb: box(200, 10), similarity: 0.7, accepted: false },
      { aabb: box(0, 20), similarity: 0.9, accepted: true },
    ];
    expect(tiltedOrder(faces, { x: 5, y: 5 })).toEqual([1, 0, 3, 2]);
    expect(tiltedOrder(faces, null)).toEqual([3, 2, 0, 1]);
  });

  it("a face a rectangle named enters the suppression with the turned looks", () => {
    const tilted = { tilt: 3, scale: 1, before: { topId: "X", similarity: 0.5, margin: 0 } };
    expect(nmsPreOrder([{ tauPassed: true, orientation: 0, tilted }, { tauPassed: true, orientation: 0 }])).toEqual([1, 0]);
    expect(nmsPreOrder([{ tauPassed: true, orientation: 0, tilted: { ...tilted, scale: null } }, { tauPassed: true, orientation: 0 }])).toEqual([0, 1]);
  });

  it("a failure answers the frame without the retry and says why", async () => {
    const { frame, aabb } = tiltedCardFrame(8);
    const scored = await recognizeFrame(frame, new CardShare(3), recognizer(), [face(aabb)], 24, null, { settings: SETTINGS });
    expect([scored.proposals[0]!.accepted, scored.proposals[0]!.tilted, scored.tiltedMs]).toEqual([false, undefined, undefined]);
    expect(String(scored.tiltedError)).toContain("boom");
    expect(scored.embeddings).toBe(4);
  });
});

// --------------------------------------------------------------- the pipeline and the worker
function makePipeline(failOn: number | null = null): { pipeline: Pipeline; frame: { data: Uint8ClampedArray; width: number; height: number } } {
  const { frame, aabb } = tiltedCardFrame(8);
  const pipeline = new Pipeline({
    detector: { lastTimings: null, propose: async () => [face(aabb)] } as unknown as FrameDetector,
    embedder: new CardShare(failOn),
    bank: { ids: ["CARD-1", "OTHER-1"], matrix: new Float32Array([1, 0, 0, 1]), dim: 2, version: 1, model: "fake", preprocessing: "full128", tau: null },
    names: new Map([["CARD-1", "Card"], ["OTHER-1", "Other"]]),
    accept: { tau: 0.99, delta: 0.05, rotationRetry: true },
    tiltedRetry: SETTINGS,
    now: () => 0,
  });
  return { pipeline, frame };
}

describe("the pipeline and the worker", () => {
  it("the pipeline reports the face, the time, and skips the retry on a frame that asks", async () => {
    const { pipeline, frame } = makePipeline();
    const analysis = await pipeline.analyze(frame);
    expect([analysis.boxes[0]!.face!.name, analysis.boxes[0]!.face!.tilted?.scale !== null]).toEqual(["Card", true]);
    expect(analysis.timings.tiltedMs).toBeGreaterThanOrEqual(0);
    const skipped = await pipeline.analyze(frame, undefined, { tilted: false });
    expect([skipped.boxes[0]!.face!.accepted, skipped.boxes[0]!.face!.tilted, skipped.timings.tiltedMs]).toEqual([false, undefined, undefined]);
  });

  function host(failOn: number | null, watchdog?: GeometricWatchdog) {
    const replies: WorkerReply[] = [];
    const { pipeline, frame } = makePipeline(failOn);
    const release = {
      id: "r", game: "toy", locale: "en",
      detector: { version: "d", settings: { decode: { threshold: 0.5, nmsIou: 0.5, maxProposals: 10 }, minCropPx: 24 } },
      recognizer: { version: "e" }, bank: { cardCount: 2 }, catalog: { cardCount: 2 }, identity: { level: "printing" },
      accept: { tau: 0.99, delta: 0.05, rotationRetry: true }, hover: { selection: "accepted-nms", maxAgeMs: 2000 },
      runtime: { analysisWidth: { min: 1, max: 4000 }, ortWeb: "1.29.0" }, tiltedRetry: SETTINGS,
    };
    const h = createWorkerHost({
      post: (reply) => replies.push(reply),
      loadRelease: async () => ({ release, pipeline, backend: { detector: "wasm", recognizer: "wasm" }, cards: [], names: new Map(), dispose: async () => {} }) as unknown as LoadedRelease,
      wasmPaths: "/",
      voteDevice: async () => null,
      openStage: async () => { throw new Error("no stage here"); },
      releaseDevice: () => {},
      readBitmap: () => frame,
      ...(watchdog ? { tiltedWatchdog: watchdog } : {}),
    });
    let id = 0;
    const send = async (extra: Record<string, unknown> = {}): Promise<FrameResult> => {
      const requestId = id++;
      await h.handle({ kind: "frame", bitmap: { width: 320, height: 260, close() {} } as ImageBitmap, videoTimeSec: requestId, envelope: { requestId, mediaTimeSec: requestId, generation: 0, videoKey: "v" }, ...extra });
      return replies.filter((r): r is FrameResult => r.kind === "frame-result").find((r) => r.envelope.requestId === requestId)!;
    };
    const tiltedStatuses = () => replies.filter((r): r is TiltedStatus => r.kind === "tilted-status");
    return { h, replies, send, tiltedStatuses, pipeline };
  }

  it("the worker reports the release's settings and passes a frame's switch and focus", async () => {
    const { h, replies, send } = host(null);
    await h.handle({ kind: "load", releaseUrl: "https://x/release.json" });
    const status = replies.find((r) => r.kind === "release-status");
    expect(status && status.kind === "release-status" && status.release!.tiltedRetry).toEqual(SETTINGS);
    expect((await send()).analysis!.boxes[0]!.face!.accepted).toBe(true);
    expect((await send({ tilted: false })).analysis!.boxes[0]!.face!.accepted).toBe(false);
    expect((await send({ focus: { x: 1, y: 1 } })).analysis!.boxes[0]!.face!.accepted).toBe(true);
  });

  it("a failure during a frame turns the retry off for the session, once", async () => {
    const { h, send, tiltedStatuses, pipeline } = host(3);
    await h.handle({ kind: "load", releaseUrl: "https://x/release.json" });
    const first = await send();
    expect([first.error, first.analysis!.boxes[0]!.face!.accepted]).toEqual([undefined, false]);
    expect(tiltedStatuses()).toEqual([{ kind: "tilted-status", state: "off", reason: "runtime: boom" }]);
    expect(pipeline.tiltedSettings).toBeNull();
    await send();
    expect(tiltedStatuses()).toHaveLength(1);
  });

  it("the watchdog turns it off after two frames over the budget", async () => {
    const { h, send, tiltedStatuses, pipeline } = host(null, new GeometricWatchdog(-1, 2));
    await h.handle({ kind: "load", releaseUrl: "https://x/release.json" });
    await send();
    expect(tiltedStatuses()).toEqual([]);
    await send();
    expect(tiltedStatuses()).toEqual([{ kind: "tilted-status", state: "off", reason: "watchdog: the tilted retry took over -1 ms of a frame on 2 frames in a row" }]);
    expect(pipeline.tiltedSettings).toBeNull();
    expect((await send()).analysis!.boxes[0]!.face!.accepted).toBe(false);
  });

  it("with tiltedWatchdog: false the budget is not watched", async () => {
    const { h, send, tiltedStatuses } = host(null, new GeometricWatchdog(-1, 1));
    await h.handle({ kind: "load", releaseUrl: "https://x/release.json", tiltedWatchdog: false });
    await send();
    await send();
    expect(tiltedStatuses()).toEqual([]);
  });
});
