// SPDX-License-Identifier: Apache-2.0
// Focus scope with a tilted retry whose cap binds, on a paused picture: the still picture's full
// pass must keep the card at the pointer that the focus look named. The full pass sends the
// pointer (without the scope), so the retry takes the faces there first, inside its cap.
import { describe, expect, it } from "vitest";

import { rectOf } from "../src/boxes.js";
import type { GeometricStage } from "../src/geometric/stage.js";
import { Pipeline } from "../src/pipeline.js";
import { SessionCore } from "../src/session-core.js";

const DIM = 4;
const SIZE = 128;
const PLANE = 3 * SIZE * SIZE;
const IDS = ["A", "B", "C", "D"];
const NAMES = new Map([["A", "Alder"], ["B", "Birch"], ["C", "Cedar"], ["D", "Dogwood"]]);
const axis = (dim: number, k: number): Float32Array => { const v = new Float32Array(dim); v[k] = 1; return v; };
function solidFrame(width: number, height: number, rgb: number[]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = rgb[0]!; data[i + 1] = rgb[1]!; data[i + 2] = rgb[2]!; data[i + 3] = 255; }
  return { data, width, height };
}
function bank() {
  const matrix = new Float32Array(IDS.length * DIM);
  IDS.forEach((_, i) => matrix.set(axis(DIM, i), i * DIM));
  return { ids: IDS, matrix, dim: DIM, version: 1, model: "fake", preprocessing: "full128" as const, tau: null };
}
function box(x: number, y: number, score = 0.9) {
  const aabb = { x, y, width: 100, height: 140 };
  return { aabb, rect: rectOf(aabb), score, cls: 0 };
}
function scene(cards: Array<{ box: any; red: number }>) {
  const frame = solidFrame(800, 450, [5, 5, 5]);
  for (const { box: b, red } of cards) {
    const { x, y, width, height } = b.aabb;
    for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) frame.data[(py * 800 + px) * 4] = red;
  }
  return frame;
}
/** Every analysis here makes exactly two batches: the upright crops, then the tilted retry's. */
class RetryEmbedder {
  calls = 0;
  constructor(private readonly upright: Record<number, number>, private readonly retried: Record<number, number[]>) {}
  async embedBatch(data: Float32Array, n: number): Promise<Float32Array> {
    const retry = this.calls++ % 2 === 1;
    const out = new Float32Array(n * DIM);
    for (let i = 0; i < n; i++) {
      const red = Math.round(((data[i * PLANE]! + 1) / 2) * 255);
      out.set(retry ? Float32Array.from(this.retried[red] ?? [0, 0, 0, 0]) : Float32Array.from([this.upright[red] ?? 0, 0, 0, 0]), i * DIM);
    }
    return out;
  }
}
const idleStage = (): GeometricStage =>
  ({ reorder: true, applies: (_s: string | null, accepted: boolean) => !accepted, verifyBatch: async (items: unknown[]) => items.map(() => ({ cropKeypoints: 0, ms: 0, candidates: [] })), dispose() {} }) as unknown as GeometricStage;

describe("focus scope, a tilted retry capped at 1, a paused picture", () => {
  it("keeps the card at the pointer through the full pass and its reuse, and after a small move", async () => {
    const cards = [{ box: box(20, 20), red: 100 }, { box: box(300, 20), red: 110 }];
    const boxes = cards.map((c) => c.box);
    const embedder = new RetryEmbedder({ 100: 0.5, 110: 0.55 }, { 100: [1, 0, 0, 0], 110: [0, 1, 0, 0] });
    const pipeline = new Pipeline({ detector: { lastTimings: null, propose: async () => boxes }, embedder, bank: bank(), names: NAMES, accept: { tau: 0.62, delta: 0.05, rotationRetry: false }, now: () => 0, geometric: idleStage() });
    pipeline.setTiltedRetry({ scales: [1], maxFacesPerFrame: 1, budgetMs: 10_000 });
    const frame = scene(cards);
    let now = 1_000;
    const sent: any[] = [];
    const pending: Promise<void>[] = [];
    let lastAnalyzedId: number | null = null;
    const kinds: string[] = [];
    let core: any;
    core = new SessionCore(
      {
        now: () => now,
        toWorker: (r: any) => {
          if (r.kind !== "frame") return;
          sent.push(r);
          const reused = r.reuseOf !== undefined && r.reuseOf === lastAnalyzedId && pipeline.reuse ? pipeline.reuse(r.videoTimeSec) : null;
          if (reused) {
            kinds.push("reused");
            pending.push(Promise.resolve().then(() => core.fromWorker({ kind: "frame-result", envelope: r.envelope, videoTimeSec: r.videoTimeSec, width: 800, height: 450, workerMs: 1, analysis: reused })));
            return;
          }
          kinds.push(r.geometricScope === "focus" ? "focus" : "full");
          pending.push(pipeline.analyze(frame, r.videoTimeSec, { ...(r.geometricScope ? { geometricScope: r.geometricScope } : {}), ...(r.focus !== undefined ? { focus: r.focus } : {}) }).then((analysis: any) => {
            lastAnalyzedId = r.envelope.requestId;
            core.fromWorker({ kind: "frame-result", envelope: r.envelope, videoTimeSec: r.videoTimeSec, width: 800, height: 450, workerMs: 5, analysis });
          }));
        },
        capture: (id: number) => core.frame(id, { width: 800, height: 450, close() {} }, 1),
      },
      { geometricScope: "focus", geometric: true },
    );
    core.fromWorker({ kind: "release-status", ok: true, error: null, release: { analysisWidth: { min: 720, max: 1920 }, hoverMaxAgeMs: 2000, recognizer: { ep: "wasm" } }, cards: [] });
    core.fromWorker({ kind: "geometric-status", state: "ready", reason: null, bytes: 1 });
    const flush = async () => { while (pending.length) await pending.shift(); };
    core.presented(1);
    core.pointer(40 / 800, 100 / 450, 1); // the pointer rests on the first card
    await flush();
    expect(core.fresh()?.cardId ?? null).toBe("A");
    for (let t = 0; t < 3_000; t += 50) { now += 50; core.tick(); await flush(); }
    // The full pass ran (retrying the pointer's card first, within the cap of 1) and was reused.
    expect(kinds).toEqual(["focus", "full", "reused"]);
    expect(sent[1].focus).toEqual({ x: 40, y: 100 });
    expect(sent[1].geometricScope).toBeUndefined();
    const looks = sent.length;
    expect(core.fresh()?.cardId ?? null).toBe("A");
    core.pointer(45 / 800, 105 / 450, 1);
    for (let t = 0; t < 3_000; t += 50) { now += 50; core.tick(); await flush(); }
    expect(core.fresh()?.cardId ?? null).toBe("A");
    expect(sent.length).toBe(looks); // a small move on the unchanged picture asks for nothing new
    // B, the other tilted card, was left out by the cap of 1: a move onto it looks there and names it.
    const b = core.analysis();
    expect(b?.boxes[1]?.face?.tiltedSkipped).toBe(true);
    const before = kinds.length;
    core.pointer(340 / 800, 100 / 450, 1);
    for (let t = 0; t < 3_000; t += 50) { now += 50; core.tick(); await flush(); }
    expect(core.fresh()?.cardId ?? null).toBe("B");
    expect(kinds[before]).toBe("focus"); // the look at B, then the picture's repeats
  });

  it("sends no pointer with the full pass while the stage is not ready, as with the option off", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let now = 1_000;
    let core: SessionCore;
    core = new SessionCore(
      {
        now: () => now,
        toWorker: (r) => {
          if (r.kind !== "frame") return;
          sent.push(r as unknown as Record<string, unknown>);
          const analysis = { frame: { width: 800, height: 450 }, hover: { selection: "accepted-nms", cards: [] }, tracks: { cards: [], shown: false }, boxes: [] };
          queueMicrotask(() => core.fromWorker({ kind: "frame-result", envelope: r.envelope, videoTimeSec: r.videoTimeSec, width: 800, height: 450, workerMs: 1, analysis } as never));
        },
        capture: (id: number) => core.frame(id, { width: 800, height: 450, close() {} } as unknown as ImageBitmap, 1),
      },
      { geometricScope: "focus", geometric: true },
    );
    core.fromWorker({ kind: "release-status", ok: true, error: null, release: { analysisWidth: { min: 720, max: 1920 }, hoverMaxAgeMs: 2000, recognizer: { ep: "wasm" } }, cards: [] } as never);
    core.presented(1);
    core.pointer(40 / 800, 100 / 450, 1);
    for (let t = 0; t < 2_000; t += 50) { now += 50; core.tick(); await Promise.resolve(); await Promise.resolve(); }
    const full = sent.filter((r) => r.geometricScope === undefined);
    expect(full.length).toBeGreaterThan(0);
    for (const r of full) expect("focus" in r).toBe(false);
  });

  /** The two-card scene, cap 1, with the pointer resting on A (x 40): the request kinds sent over
   *  `ms` of ticks. Without a stage the retry goes by cosine, B first, so A is the face left out. */
  async function restOnA(scope: "focus" | "all", stage: boolean, ms: number): Promise<string[]> {
    const cards = [{ box: box(20, 20), red: 100 }, { box: box(300, 20), red: 110 }];
    const boxes = cards.map((c) => c.box);
    const embedder = new RetryEmbedder({ 100: 0.5, 110: 0.55 }, { 100: [1, 0, 0, 0], 110: [0, 1, 0, 0] });
    const pipeline = new Pipeline({ detector: { lastTimings: null, propose: async () => boxes }, embedder, bank: bank(), names: NAMES, accept: { tau: 0.62, delta: 0.05, rotationRetry: false }, now: () => 0, ...(stage ? { geometric: idleStage() } : {}) });
    pipeline.setTiltedRetry({ scales: [1], maxFacesPerFrame: 1, budgetMs: 10_000 });
    const frame = scene(cards);
    let now = 1_000;
    const pending: Promise<void>[] = [];
    let lastAnalyzedId: number | null = null;
    const kinds: string[] = [];
    let core: SessionCore;
    core = new SessionCore(
      {
        now: () => now,
        toWorker: (r) => {
          if (r.kind !== "frame") return;
          const reused = r.reuseOf !== undefined && r.reuseOf === lastAnalyzedId ? pipeline.reuse(r.videoTimeSec) : null;
          if (reused) {
            kinds.push("reused");
            pending.push(Promise.resolve().then(() => core.fromWorker({ kind: "frame-result", envelope: r.envelope, videoTimeSec: r.videoTimeSec, width: 800, height: 450, workerMs: 1, analysis: reused })));
            return;
          }
          kinds.push(r.geometricScope === "focus" ? "focus" : "full");
          pending.push(
            pipeline.analyze(frame as never, r.videoTimeSec, { ...(r.geometricScope ? { geometricScope: r.geometricScope } : {}), ...(r.focus !== undefined ? { focus: r.focus } : {}) }).then((analysis) => {
              lastAnalyzedId = r.envelope.requestId;
              core.fromWorker({ kind: "frame-result", envelope: r.envelope, videoTimeSec: r.videoTimeSec, width: 800, height: 450, workerMs: 5, analysis });
            }),
          );
        },
        capture: (id: number) => core.frame(id, { width: 800, height: 450, close() {} } as unknown as ImageBitmap, 1),
      },
      { ...(scope === "focus" ? { geometricScope: "focus" as const } : {}), geometric: stage },
    );
    core.fromWorker({ kind: "release-status", ok: true, error: null, release: { analysisWidth: { min: 720, max: 1920 }, hoverMaxAgeMs: 2000, recognizer: { ep: "wasm" } }, cards: [] } as never);
    if (stage) core.fromWorker({ kind: "geometric-status", state: "ready", reason: null, bytes: 1 });
    const flush = async (): Promise<void> => {
      while (pending.length) await pending.shift();
    };
    core.presented(1);
    core.pointer(40 / 800, 100 / 450, 1);
    await flush();
    for (let t = 0; t < ms; t += 50) {
      now += 50;
      core.tick();
      await flush();
    }
    return kinds;
  }

  it("with no stage, a pointer resting on a face the cap left out does not look again and again", async () => {
    const kinds = await restOnA("focus", false, 12_000);
    expect(kinds).toEqual(["focus", "full", "reused"]);
  });

  it("scope all keeps the reuse of a still picture whose cap left a face out, with or without a stage", async () => {
    expect(await restOnA("all", true, 3_000)).toEqual(["full", "reused", "reused"]);
    expect(await restOnA("all", false, 3_000)).toEqual(["full", "reused", "reused"]);
  });
});
