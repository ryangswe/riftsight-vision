// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

import { computeProtocol, MAX_FRAME_SIDE, MAX_OTHER_BOXES, MAX_TEXT_LENGTH, PROTOCOL_VERSION } from "../src/compute-messages.js";

const { tag, parseComputeIn, parseComputeOut } = computeProtocol("example");

describe("compute message checks", () => {
  it("tags messages with the protocol's own tag, cardvision by default", () => {
    expect(tag({ kind: "leave" })).toEqual({ kind: "leave", example: 1 });
    expect(computeProtocol().tag({ kind: "leave" })).toEqual({ kind: "leave", cardvision: 1 });
    expect(computeProtocol().name).toBe("cardvision");
    // Another protocol's messages are not this one's.
    expect(computeProtocol("other").parseComputeIn(tag({ kind: "leave" }))).toBeNull();
  });

  it("refuses a tag that is not lowercase letters, digits and hyphens, or that is a field of the messages", () => {
    for (const ok of ["cardvision", "example", "my-ext2"]) expect(computeProtocol(ok).name).toBe(ok);
    for (const bad of ["", "Example", "2fast", "-x", "my_ext", "a b", "kind", "x", "y", "touch", "bitmap", "reason", "retry", "state", "error", "backend", "card", "mediaTime", "requestId", "version", "instance"]) {
      expect(() => computeProtocol(bad)).toThrow(TypeError);
    }
  });

  it("round-trips every compute message the content script sends (bitmap aside)", () => {
    for (const m of [
      { kind: "pointer", x: 0.1, y: 1, mediaTime: 3.2, touch: false },
      { kind: "leave" },
      { kind: "presented", mediaTime: 0 },
      { kind: "discontinuity", newSource: true },
      { kind: "cut" },
      { kind: "capture-failed", requestId: 3, reason: "no picture", retry: true },
      { kind: "capture-failed", requestId: 3, reason: "no pointer over the player", retry: false },
    ] as const) {
      expect(parseComputeIn(tag(m))).toEqual(m);
    }
  });

  it("refuses untagged, malformed or out-of-range messages", () => {
    expect(parseComputeIn({ kind: "leave" })).toBeNull();
    expect(parseComputeIn(tag({ kind: "pointer", x: 1.2, y: 0, mediaTime: 0, touch: false }))).toBeNull();
    expect(parseComputeIn(tag({ kind: "pointer", x: 0.5, y: 0.5, mediaTime: Number.NaN, touch: false }))).toBeNull();
    expect(parseComputeIn(tag({ kind: "frame", requestId: 1, bitmap: {}, mediaTime: 0 }))).toBeNull();
    expect(parseComputeIn(tag({ kind: "capture-failed", requestId: 0, reason: "x" }))).toBeNull();
    expect(parseComputeIn(tag({ kind: "eval" }))).toBeNull();
    expect(parseComputeIn("leave")).toBeNull();
  });

  it("cuts a long capture-failed reason to 200 characters, and reads a missing retry as false", () => {
    const parsed = parseComputeIn(tag({ kind: "capture-failed", requestId: 1, reason: "x".repeat(500) }));
    expect(parsed).toEqual({ kind: "capture-failed", requestId: 1, reason: "x".repeat(200), retry: false });
  });

  it("checks the compute frame's replies", () => {
    const shown = { kind: "shown", card: { cardId: "T-001", name: "Example Card", box: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 } } };
    expect(parseComputeOut(tag(shown))).toEqual({ kind: "shown", card: { ...shown.card, others: [] } });
    const withOthers = { kind: "shown", card: { ...shown.card, others: [{ x: 0.5, y: 0.5, width: 0.1, height: 0.1 }, { x: 0, y: 0, width: 0, height: 1 }] } };
    expect(parseComputeOut(tag(withOthers))).toEqual({ kind: "shown", card: { ...shown.card, others: [{ x: 0.5, y: 0.5, width: 0.1, height: 0.1 }] } });
    expect(parseComputeOut(tag({ kind: "shown", card: null }))).toEqual({ kind: "shown", card: null });
    expect(parseComputeOut(tag({ kind: "shown", card: { cardId: "", name: "x", box: shown.card.box } }))).toBeNull();
    expect(parseComputeOut(tag({ kind: "shown", card: { ...shown.card, box: { x: 0, y: 0, width: 0, height: 1 } } }))).toBeNull();
    expect(parseComputeOut(tag({ kind: "capture", requestId: 2, analysisWidth: { min: 720, max: 1920 } }))).toEqual({
      kind: "capture",
      requestId: 2,
      analysisWidth: { min: 720, max: 1920 },
    });
    expect(parseComputeOut(tag({ kind: "capture", requestId: 2, analysisWidth: { min: 900, max: 720 } }))).toBeNull();
    expect(parseComputeOut(tag({ kind: "status", state: "failed", error: "x", backend: null }))).toEqual({ kind: "status", state: "failed", error: "x", backend: null });
    expect(parseComputeOut(tag({ kind: "status", state: "weird", error: null, backend: null }))).toBeNull();
    expect(parseComputeOut(tag({ kind: "ready", version: 1, instance: "0123456789abcdef" }))).toEqual({ kind: "ready", version: 1, instance: "0123456789abcdef" });
  });

  it("keeps at most 40 other boxes, and a release id only in its own shape", () => {
    const box = { x: 0.1, y: 0.2, width: 0.2, height: 0.3 };
    const many = Array.from({ length: 60 }, () => box);
    const parsed = parseComputeOut(tag({ kind: "shown", card: { cardId: "a", name: "b", box, others: many, releaseId: "0123456789abcdef" } }));
    expect(MAX_OTHER_BOXES).toBe(40);
    expect(parsed?.kind === "shown" && parsed.card?.others).toHaveLength(40);
    expect(parsed?.kind === "shown" && parsed.card?.releaseId).toBe("0123456789abcdef");
    const odd = parseComputeOut(tag({ kind: "shown", card: { cardId: "a", name: "b", box, releaseId: "../x" } }));
    expect(odd).toEqual({ kind: "shown", card: { cardId: "a", name: "b", box, others: [] } });
    expect(parseComputeOut(tag({ kind: "shown", card: { cardId: "x".repeat(201), name: "b", box } }))).toBeNull();
  });
});

describe("frame size cap", () => {
  class FakeBitmap {
    closed = false;
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    close() {
      this.closed = true;
    }
  }
  afterEach(() => vi.unstubAllGlobals());

  it("takes a picture up to the cap, and refuses a larger or empty one", () => {
    vi.stubGlobal("ImageBitmap", FakeBitmap);
    const frame = (w: number, h: number) => parseComputeIn(tag({ kind: "frame", requestId: 1, bitmap: new FakeBitmap(w, h), mediaTime: 0 }));
    expect(MAX_FRAME_SIDE).toBe(4096);
    expect(frame(1920, 1080)?.kind).toBe("frame");
    expect(frame(MAX_FRAME_SIDE, MAX_FRAME_SIDE)?.kind).toBe("frame");
    expect(frame(MAX_FRAME_SIDE + 1, 100)).toBeNull();
    expect(frame(100, MAX_FRAME_SIDE + 1)).toBeNull();
    expect(frame(0, 100)).toBeNull();
  });

  it("closes the bitmap of a frame it refuses, and leaves a taken one open", () => {
    vi.stubGlobal("ImageBitmap", FakeBitmap);
    const big = new FakeBitmap(MAX_FRAME_SIDE + 1, 100);
    expect(parseComputeIn(tag({ kind: "frame", requestId: 1, bitmap: big, mediaTime: 0 }))).toBeNull();
    expect(big.closed).toBe(true);
    const badId = new FakeBitmap(100, 100);
    expect(parseComputeIn(tag({ kind: "frame", requestId: 0, bitmap: badId, mediaTime: 0 }))).toBeNull();
    expect(badId.closed).toBe(true);
    const ok = new FakeBitmap(100, 100);
    expect(parseComputeIn(tag({ kind: "frame", requestId: 1, bitmap: ok, mediaTime: 0 }))).toMatchObject({ kind: "frame", bitmap: ok });
    expect(ok.closed).toBe(false);
  });
});

describe("contract v1", () => {
  const INSTANCE = "0123456789abcdef";

  it("is version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("takes a hello with a positive whole version, and refuses any other", () => {
    expect(parseComputeIn(tag({ kind: "hello", version: 1 }))).toEqual({ kind: "hello", version: 1 });
    expect(parseComputeIn(tag({ kind: "hello", version: 7 }))).toEqual({ kind: "hello", version: 7 });
    for (const version of [undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
      expect(parseComputeIn(tag({ kind: "hello", version }))).toBeNull();
    }
    expect(parseComputeIn(tag({ kind: "hello" }))).toBeNull();
  });

  it("takes a ready only with a version and an instance of 16 lowercase hex characters", () => {
    expect(parseComputeOut(tag({ kind: "ready", version: 1, instance: INSTANCE }))).toEqual({ kind: "ready", version: 1, instance: INSTANCE });
    expect(parseComputeOut(tag({ kind: "ready", version: 2, instance: INSTANCE }))).toEqual({ kind: "ready", version: 2, instance: INSTANCE });
    expect(parseComputeOut(tag({ kind: "ready" }))).toBeNull();
    expect(parseComputeOut(tag({ kind: "ready", version: 1 }))).toBeNull();
    expect(parseComputeOut(tag({ kind: "ready", instance: INSTANCE }))).toBeNull();
    for (const version of [0, -1, 1.5, "1", null]) expect(parseComputeOut(tag({ kind: "ready", version, instance: INSTANCE }))).toBeNull();
    for (const instance of ["0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "0123456789abcdeg", "", 123, null]) {
      expect(parseComputeOut(tag({ kind: "ready", version: 1, instance }))).toBeNull();
    }
  });

  it("drops extra fields, never refusing a message for them", () => {
    expect(parseComputeOut({ ...tag({ kind: "ready", version: 1, instance: INSTANCE }), extra: "x" })).toEqual({ kind: "ready", version: 1, instance: INSTANCE });
    expect(parseComputeIn({ ...tag({ kind: "hello", version: 1 }), extra: "x" })).toEqual({ kind: "hello", version: 1 });
  });

  it("cuts a status's long error and backend to MAX_TEXT_LENGTH, and refuses one of another type", () => {
    const parsed = parseComputeOut(tag({ kind: "status", state: "failed", error: "e".repeat(500), backend: "b".repeat(300) }));
    expect(parsed).toEqual({ kind: "status", state: "failed", error: "e".repeat(MAX_TEXT_LENGTH), backend: "b".repeat(MAX_TEXT_LENGTH) });
    expect(parseComputeOut(tag({ kind: "status", state: "ready", error: null, backend: "wasm" }))).toEqual({ kind: "status", state: "ready", error: null, backend: "wasm" });
    expect(parseComputeOut(tag({ kind: "status", state: "ready", error: 3, backend: null }))).toBeNull();
    expect(parseComputeOut(tag({ kind: "status", state: "ready", error: null }))).toBeNull();
  });

  it("takes an analysis width only of whole numbers from 1 to MAX_FRAME_SIDE, max not below min", () => {
    const capture = (min: unknown, max: unknown) => parseComputeOut(tag({ kind: "capture", requestId: 1, analysisWidth: { min, max } }));
    expect(capture(1, MAX_FRAME_SIDE)).toEqual({ kind: "capture", requestId: 1, analysisWidth: { min: 1, max: MAX_FRAME_SIDE } });
    expect(capture(720, 720)).not.toBeNull();
    expect(capture(720, 1920)).not.toBeNull();
    for (const [min, max] of [
      [0, 720],
      [720.5, 1920],
      [720, 1920.5],
      [720, MAX_FRAME_SIDE + 1],
      [MAX_FRAME_SIDE + 1, MAX_FRAME_SIDE + 2],
      [1920, 720],
      [-1, 720],
      ["720", 1920],
      [720, Number.POSITIVE_INFINITY],
    ]) {
      expect(capture(min, max)).toBeNull();
    }
  });
});
