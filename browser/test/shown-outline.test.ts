// SPDX-License-Identifier: Apache-2.0
// The shown card carries its turned outline (session option `rotatedOutlines`), so a caller can
// draw what the hit test uses: in-process, over the compute frame's message, and through the
// content side's parser, with older parsers and malformed outlines.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeProtocol, type ShownCard } from "../src/compute-messages.js";
import { startComputeFrame, type ComputeFrameEnv } from "../src/compute-frame.js";
import type { LayerCard } from "../src/hover-geometry.js";
import { READING_HOLD, SessionCore, type Shown } from "../src/session-core.js";
import type { ReleaseStatus, WorkerReply, WorkerRequest } from "../src/messages.js";
import type { FrameAnalysis } from "../src/pipeline.js";
import type { WorkerLike } from "../src/worker-session.js";
import { computeProtocol as oldProtocol } from "./fixtures/compute-messages-0.10.0.js";

const protocol = computeProtocol("example");
const tag = protocol.tag;
const ORIGIN = "https://video.example";

class FakeBitmap {
  closed = false;
  readonly width = 1000;
  readonly height = 500;
  close() {
    this.closed = true;
  }
}
beforeEach(() => vi.stubGlobal("ImageBitmap", FakeBitmap));
afterEach(() => vi.unstubAllGlobals());

/** A card in the box x 100..300, y 100..400 of a 1000 x 500 frame, optionally turned about its
 *  center with its own sides. */
const card = (turn: { rotation: number; localWidth: number; localHeight: number } | null): LayerCard => ({
  instanceId: "c0",
  bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.6 },
  rotation: turn?.rotation ?? 0,
  localWidth: turn?.localWidth ?? 0.2,
  localHeight: turn?.localHeight ?? 0.6,
  landscape: false,
  cardId: "T-001",
  name: "Card One",
  boxIndex: 0,
});
const analysisOf = (c: LayerCard | null): FrameAnalysis =>
  ({ frame: { width: 1000, height: 500 }, hover: { selection: "accepted-nms", cards: c ? [c] : [] }, boxes: c ? [{ box: [100, 100, 200, 300] }] : [] }) as unknown as FrameAnalysis;

const TURN = { rotation: 12, localWidth: 0.15, localHeight: 0.5 };

function run(c: LayerCard, extra: Partial<ComputeFrameEnv> = {}) {
  const clock = { now: 1_000 };
  let moves = 0;
  const posted: Array<Record<string, unknown>> = [];
  const worker: WorkerLike & { sent: Array<Record<string, unknown>> } = {
    sent: [],
    onmessage: null,
    onerror: null,
    postMessage(m: unknown) {
      this.sent.push(m as Record<string, unknown>);
    },
    terminate() {},
  };
  let listener: ((event: MessageEvent) => void) | null = null;
  const parent = { postMessage: (m: unknown) => void posted.push(m as Record<string, unknown>) };
  const env: ComputeFrameEnv = {
    win: {
      parent,
      addEventListener: (_: "message", l: (event: MessageEvent) => void) => void (listener = l),
      removeEventListener: () => {},
    },
    framed: true,
    parentOrigin: ORIGIN,
    allowedParentOrigin: (o: string) => o === ORIGIN,
    protocol,
    createWorker: () => worker,
    loadRequest: { kind: "load", releaseUrl: "r.json", wasmPaths: "w/" },
    now: () => clock.now,
    ...extra,
  };
  const frame = startComputeFrame(env)!;
  const reply = (data: unknown) => worker.onmessage?.({ data } as MessageEvent<WorkerReply>);
  const send = (data: unknown) => listener?.({ data, source: parent, origin: ORIGIN } as unknown as MessageEvent);
  reply({
    kind: "release-status", ok: true, error: null, cards: [],
    release: {
      id: "r0", game: "toy-game", locale: "en", detector: { version: "d", ep: "wasm" }, recognizer: { version: "r", ep: "wasm" },
      bankCards: 1, catalogCards: 1, identityLevel: "name", decode: { threshold: 0.3, nmsIou: 0.45, maxProposals: 80, minCropPx: 24 },
      accept: { tau: 0.68, delta: 0.06 }, hoverSelection: "accepted-nms", hoverMaxAgeMs: 2000, analysisWidth: { min: 720, max: 1920 }, ortWeb: "1.29.0",
    } as unknown as NonNullable<ReleaseStatus["release"]>,
  });
  /** The pointer on the card, a picture taken, and an analysis holding `next` back. */
  const step = (next: LayerCard | null) => {
    const before = posted.filter((m) => m.kind === "capture").length;
    // The scheduler asks for a picture after a pointer move over a stale one; move until it does.
    for (let i = 0; i < 4 && posted.filter((m) => m.kind === "capture").length === before; i += 1) {
      clock.now += 5_000;
      moves += 1;
      send(tag({ kind: "pointer", x: 0.2 + moves * 0.001, y: 0.5, mediaTime: moves, touch: false }));
      send(tag({ kind: "presented", mediaTime: moves }));
    }
    const capture = posted.filter((m) => m.kind === "capture").pop() as { requestId: number };
    expect(posted.filter((m) => m.kind === "capture")).toHaveLength(before + 1);
    send(tag({ kind: "frame", requestId: capture.requestId, bitmap: new FakeBitmap(), mediaTime: moves }));
    const request = worker.sent.at(-1) as { envelope: unknown };
    reply({ kind: "frame-result", envelope: request.envelope, videoTimeSec: moves, width: 1000, height: 500, workerMs: 5, analysis: analysisOf(next) });
  };
  step(c);
  const shown = posted.filter((m) => m.kind === "shown").pop()!;
  return { frame, shown, step, shownMessages: () => posted.filter((m) => m.kind === "shown") };
}

describe("the shown card's outline", () => {
  it("row 1: a card turned 12 degrees gives rotation and sides in-process and over the message", () => {
    const { frame, shown } = run(card(TURN));
    expect(frame.core!.hitAt(0.2, 0.5)).toMatchObject(TURN);
    expect(shown).toStrictEqual(
      tag({ kind: "shown", card: { cardId: "T-001", name: "Card One", box: { x: 0.1, y: 0.2, width: 0.2, height: 0.6 }, others: [], ...TURN } }),
    );
    expect(protocol.parseComputeOut(shown)).toStrictEqual({ kind: "shown", card: { cardId: "T-001", name: "Card One", box: { x: 0.1, y: 0.2, width: 0.2, height: 0.6 }, others: [], ...TURN } });
  });

  it("row 2: an upright card (or the option off) carries none of the three fields, as before", () => {
    const { frame, shown } = run(card(null));
    const hit = frame.core!.hitAt(0.2, 0.5)!;
    expect(Object.keys(hit).sort()).toEqual(["box", "cardId", "frameBox", "name", "others"]);
    expect(shown).toStrictEqual(tag({ kind: "shown", card: { cardId: "T-001", name: "Card One", box: { x: 0.1, y: 0.2, width: 0.2, height: 0.6 }, others: [] } }));
    // Not a stand-in for "upright" either: a card of 0 degrees with sides of its own.
    expect(Object.keys(run(card({ rotation: 0, localWidth: 0.2, localHeight: 0.6 })).frame.core!.hitAt(0.2, 0.5)!)).not.toContain("rotation");
  });

  const base = { cardId: "T-001", name: "Card One", box: { x: 0.1, y: 0.2, width: 0.2, height: 0.6 } };
  const upright = { kind: "shown", card: { ...base, others: [] } };

  it.each([
    ["rotation 45.5", { ...TURN, rotation: 45.5 }],
    ["rotation -45", { ...TURN, rotation: -45 }],
    ["rotation not finite", { ...TURN, rotation: Number.NaN }],
    ["rotation a string", { ...TURN, rotation: "12" }],
    ["localWidth 0", { ...TURN, localWidth: 0 }],
    ["localHeight above 1", { ...TURN, localHeight: 1.2 }],
    ["only rotation", { rotation: 12 }],
    ["two of three", { rotation: 12, localWidth: 0.15 }],
    ["only the sides", { localWidth: 0.15, localHeight: 0.5 }],
  ])("row 3: %s drops the outline and keeps the card", (_, outline) => {
    expect(protocol.parseComputeOut(tag({ kind: "shown", card: { ...base, ...outline } }))).toStrictEqual(upright);
  });

  it("row 3: the edges of the range are kept", () => {
    for (const rotation of [45, -44.9, 0.5]) {
      const parsed = protocol.parseComputeOut(tag({ kind: "shown", card: { ...base, rotation, localWidth: 1, localHeight: 0.01 } })) as { card: ShownCard };
      expect(parsed.card).toMatchObject({ rotation, localWidth: 1, localHeight: 0.01 });
    }
  });

  it("row 4: 0.10.0's parser keeps the card from a message with an outline and ignores the fields", () => {
    const old = oldProtocol("example");
    const message = tag({ kind: "shown", card: { ...base, ...TURN, others: [] } });
    expect(old.parseComputeOut(message)).toStrictEqual({ kind: "shown", card: { ...base, others: [] } });
  });

  it("row 4: the new parser reads a message with no outline fields as an upright card", () => {
    const old = oldProtocol("example");
    const message = old.tag({ kind: "shown", card: { ...base, others: [] } });
    expect(protocol.parseComputeOut(message)).toStrictEqual(upright);
  });

  it("row 7: a change of outline at the same box is reported again, in both directions; no change is not", () => {
    const upright = card(null);
    const t = run(upright);
    const outlines = () => t.shownMessages().map((m) => (m.card as ShownCard | null)?.rotation);
    expect(outlines()).toEqual([undefined]);
    t.step(upright);
    expect(outlines()).toEqual([undefined]);
    t.step(card(TURN));
    expect(outlines()).toEqual([undefined, 12]);
    t.step(card(TURN));
    expect(outlines()).toEqual([undefined, 12]);
    t.step(card({ ...TURN, rotation: -7 }));
    expect(outlines()).toEqual([undefined, 12, -7]);
    t.step(upright);
    expect(outlines()).toEqual([undefined, 12, -7, undefined]);
    const last = t.shownMessages().at(-1)!.card as ShownCard;
    expect(Object.keys(last).sort()).toEqual(["box", "cardId", "name", "others"]);
  });

  it("row 7: SessionCore calls onShown once per outline change", () => {
    let turn: LayerCard = card(null);
    let now = 1_000;
    const calls: Array<Shown | null> = [];
    const requests: WorkerRequest[] = [];
    const captures: number[] = [];
    const core = new SessionCore({
      now: () => now,
      toWorker: (r) => requests.push(r),
      capture: (id) => captures.push(id),
      onShown: (c) => calls.push(c),
      hoverAt: ((_: unknown, x: number, y: number) =>
        x >= 100 && x <= 300 && y >= 100 && y <= 400
          ? { card: turn, boxIndex: 0, box: { x: 100, y: 100, width: 200, height: 300 }, cardId: "T-001", name: "Card One" }
          : { card: null, boxIndex: null, box: null, cardId: null, name: null }) as never,
    });
    core.fromWorker({
      kind: "release-status", ok: true, error: null, cards: [],
      release: {
        id: "r0", game: "toy-game", locale: "en", detector: { version: "d", ep: "wasm" }, recognizer: { version: "r", ep: "wasm" },
        bankCards: 1, catalogCards: 1, identityLevel: "name", decode: { threshold: 0.3, nmsIou: 0.45, maxProposals: 80, minCropPx: 24 },
        accept: { tau: 0.68, delta: 0.06 }, hoverSelection: "accepted-nms", hoverMaxAgeMs: 2000, analysisWidth: { min: 720, max: 1920 }, ortWeb: "1.29.0",
      } as unknown as NonNullable<ReleaseStatus["release"]>,
    });
    const step = (next: LayerCard) => {
      turn = next;
      now += 5_000;
      core.pointer(0.2, 0.5, 1);
      core.frame(captures.at(-1)!, new FakeBitmap() as unknown as ImageBitmap, 1);
      const r = requests.at(-1) as Extract<WorkerRequest, { kind: "frame" }>;
      core.fromWorker({ kind: "frame-result", envelope: r.envelope, videoTimeSec: 1, width: 1000, height: 500, workerMs: 5, analysis: analysisOf(next) });
    };
    step(card(null));
    const n = calls.length;
    expect(calls.at(-1)).not.toHaveProperty("rotation");
    step(card(null));
    expect(calls).toHaveLength(n);
    step(card(TURN));
    expect(calls).toHaveLength(n + 1);
    expect(calls.at(-1)).toMatchObject(TURN);
    step(card(TURN));
    expect(calls).toHaveLength(n + 1);
    step(card(null));
    expect(calls).toHaveLength(n + 2);
    expect(calls.at(-1)).not.toHaveProperty("rotation");
  });
});

describe("a card shown by the hold is marked held over the message", () => {
  it("carries held: true while a reading hold keeps a card the newest analysis does not see, and drops it when seen again", () => {
    const t = run(card(TURN), { hold: READING_HOLD });
    expect((t.shown.card as ShownCard).held).toBeUndefined();
    t.step(null);
    const held = t.shownMessages().at(-1)!;
    expect(held).toStrictEqual(
      tag({ kind: "shown", card: { cardId: "T-001", name: "Card One", box: { x: 0.1, y: 0.2, width: 0.2, height: 0.6 }, others: [], ...TURN, held: true } }),
    );
    expect(protocol.parseComputeOut(held)).toStrictEqual({ kind: "shown", card: { cardId: "T-001", name: "Card One", box: { x: 0.1, y: 0.2, width: 0.2, height: 0.6 }, others: [], ...TURN, held: true } });
    t.step(card(TURN));
    expect((t.shownMessages().at(-1)!.card as ShownCard).held).toBeUndefined();
  });

  it("the parser keeps only held: true; 0.10.0's parser ignores the field", () => {
    const base = { cardId: "T-001", name: "Card One", box: { x: 0.1, y: 0.2, width: 0.2, height: 0.6 } };
    for (const odd of [false, "true", 1, null]) {
      expect(protocol.parseComputeOut(tag({ kind: "shown", card: { ...base, held: odd } }))).toStrictEqual({ kind: "shown", card: { ...base, others: [] } });
    }
    const old = oldProtocol("example");
    expect(old.parseComputeOut(old.tag({ kind: "shown", card: { ...base, held: true } }))).toMatchObject({ kind: "shown", card: { cardId: "T-001" } });
  });
});
