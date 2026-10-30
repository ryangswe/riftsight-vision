// SPDX-License-Identifier: Apache-2.0
// The compute frame's side of the two-frame contract: its origin rule, the messages it takes and
// the pictures it closes, `ready` and the status it posts, and the shown card (its details first,
// then the card, with the remote release's id once the worker confirmed it).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startComputeFrame, type ComputeFrameEnv } from "../src/compute-frame.js";
import { computeProtocol, MAX_TEXT_LENGTH, PROTOCOL_VERSION, type ShownCard } from "../src/compute-messages.js";
import type { ReleaseStatus, WorkerReply, WorkerRequest } from "../src/messages.js";
import type { FrameAnalysis } from "../src/pipeline.js";
import type { LoadRequest, ReleaseDecision, RemoteReleaseChoice } from "../src/remote/choose.js";
import type { ReleasePointer } from "../src/remote/pointer.js";
import type { ReleaseInEffect, WorkerLike } from "../src/worker-session.js";

const SITE_ORIGIN = "https://video.example";
const LOCAL_ORIGIN = "http://127.0.0.1:8770";
const TAG = "example";
const protocol = computeProtocol(TAG);
const tag = protocol.tag;

/** An extension's list: its video site, and the local test page in a dev build only. */
const allowedIn = (dev: boolean) => (origin: string) => origin === SITE_ORIGIN || (dev && origin === LOCAL_ORIGIN);

const ID = "0123456789abcdef";
const OTHER = "ffffffffffffffff";
const pointer: ReleasePointer = { id: ID, path: `vision/releases/${ID}/release.json`, sha256: "a".repeat(64), minimumExtensionVersion: "0.3.0", maximumExtensionVersion: null };
const releaseOf = (id: string) =>
  ({
    id, game: "toy-game", locale: "en",
    detector: { version: "d", ep: "wasm" }, recognizer: { version: "r", ep: "wasm" },
    bankCards: 1, catalogCards: 1, identityLevel: "name",
    decode: { threshold: 0.3, nmsIou: 0.45, maxProposals: 80, minCropPx: 24 },
    accept: { tau: 0.68, delta: 0.06 }, hoverSelection: "accepted-nms", hoverMaxAgeMs: 2000,
    analysisWidth: { min: 720, max: 1920 }, ortWeb: "1.29.0",
  }) as unknown as NonNullable<ReleaseStatus["release"]>;

class FakeWorker implements WorkerLike {
  posted: Array<Record<string, unknown>> = [];
  terminated = false;
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  postMessage(message: unknown) {
    this.posted.push(message as Record<string, unknown>);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent<WorkerReply>);
  }
  fail(message = "boom") {
    this.onerror?.({ message } as ErrorEvent);
  }
}

/** Stands in for ImageBitmap (stubbed as the global, so `instanceof ImageBitmap` holds). */
class FakeBitmap {
  closed = false;
  constructor(
    readonly width = 1000,
    readonly height = 500,
  ) {}
  close() {
    this.closed = true;
  }
}
beforeEach(() => vi.stubGlobal("ImageBitmap", FakeBitmap));
afterEach(() => vi.unstubAllGlobals());

const BUNDLED_URL = "extension://x/release/release.json";
const bundledLoad: LoadRequest = { kind: "load", releaseUrl: BUNDLED_URL, wasmPaths: "w/" };
const isBundled = (w: FakeWorker) => w.posted[0]?.releaseUrl === BUNDLED_URL;

const remoteChoice = (): RemoteReleaseChoice => ({
  source: "remote",
  pointer,
  request: { kind: "load", releaseUrl: "release.json", files: {}, wasmPaths: "w/" },
  facts: { "T-999": ["New Card", null, "full/T-999.jpg"] },
  reused: 2,
  downloaded: 4_400_000,
  ms: 12,
});

/** A hit test with one card in the box x 100..300, y 100..400 of a 1000 x 500 frame. */
const hitWith = (cardId: string, name: string) => (_: FrameAnalysis, x: number, y: number) =>
  x >= 100 && x <= 300 && y >= 100 && y <= 400
    ? { card: null, boxIndex: 0, box: { x: 100, y: 100, width: 200, height: 300 }, cardId, name }
    : { card: null, boxIndex: null, box: null, cardId: null, name: null };
const analysis = (): FrameAnalysis => ({ frame: { width: 1000, height: 500 }, hover: { selection: "accepted-nms", cards: [] }, boxes: [] }) as unknown as FrameAnalysis;

type Posted = { message: Record<string, unknown>; origin: string };

function setup(over: Partial<ComputeFrameEnv> = {}) {
  const toParent: Posted[] = [];
  const order: string[] = [];
  const parent = {
    postMessage: (message: unknown, origin: string) => {
      toParent.push({ message: message as Record<string, unknown>, origin });
      order.push(`content:${(message as { kind: string }).kind}`);
    },
  };
  let listener: ((event: MessageEvent) => void) | null = null;
  const workers: FakeWorker[] = [];
  const clock = { now: 1_000 };
  const env: ComputeFrameEnv = {
    win: {
      parent,
      addEventListener: (_: "message", l: (event: MessageEvent) => void) => void (listener = l),
      removeEventListener: (_: "message", l: (event: MessageEvent) => void) => void (listener === l && (listener = null)),
    },
    framed: true,
    parentOrigin: SITE_ORIGIN,
    allowedParentOrigin: allowedIn(false),
    protocol,
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    loadRequest: bundledLoad,
    now: () => clock.now,
    hoverAt: hitWith("T-001", "Card One") as never,
    ...over,
  };
  const frame = startComputeFrame(env);
  const send = (data: unknown, source: unknown = parent, origin = SITE_ORIGIN) => listener?.({ data, source, origin } as unknown as MessageEvent);
  const messages = () => toParent.map((p) => p.message);
  const kinds = () => messages().map((m) => m.kind);
  return { frame, toParent, messages, kinds, order, workers, send, parent, clock, hasListener: () => listener !== null };
}

/** With a `chooseRelease` that answers `choice`; resolved after the choice has been taken. */
async function setupChoosing(choice: RemoteReleaseChoice | Promise<RemoteReleaseChoice>, over: Partial<ComputeFrameEnv> = {}) {
  const skips: string[] = [];
  const decisions: ReleaseDecision[] = [];
  const t = setup({ chooseRelease: async () => choice, recordSkip: (_, reason) => skips.push(reason), onDecision: (d) => decisions.push(d), ...over });
  await new Promise((r) => setTimeout(r, 0));
  return { ...t, skips, decisions };
}

const statusOk = (id: string) => ({ kind: "release-status", ok: true, error: null, release: releaseOf(id), cards: [] });
const statusFail = (error: string) => ({ kind: "release-status", ok: false, error, release: null, cards: [] });
const loaded = (w: FakeWorker, id = "r0") => w.reply(statusOk(id));

/** Point at the card, answer the capture with a picture, and the worker with an analysis. */
function showCard(t: ReturnType<typeof setup>, w: FakeWorker): void {
  t.send(tag({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false }));
  const capture = t.messages().filter((m) => m.kind === "capture").pop() as { requestId: number };
  t.send(tag({ kind: "frame", requestId: capture.requestId, bitmap: new FakeBitmap(), mediaTime: 1 }));
  const request = w.posted.at(-1) as unknown as Extract<WorkerRequest, { kind: "frame" }>;
  w.reply({ kind: "frame-result", envelope: request.envelope, videoTimeSec: 1, width: 1000, height: 500, workerMs: 5, analysis: analysis() });
}
const lastShown = (t: ReturnType<typeof setup>) => t.messages().filter((m) => m.kind === "shown").pop() as { card: ShownCard | null } | undefined;
const statuses = (t: ReturnType<typeof setup>) => t.messages().filter((m) => m.kind === "status");
const readyOf = (instance: string) => tag({ kind: "ready", version: PROTOCOL_VERSION, instance });

// ---------------------------------------------------------------------------------------------
// Ported from both products' compute-frame.test.ts.
describe("origin rule", () => {
  it.each([
    ["a page that is not a video site", { parentOrigin: "https://evil.example" }],
    ["the local test page in a release build", { parentOrigin: LOCAL_ORIGIN }],
    ["no embedding page", { parentOrigin: null }],
    ["a top-level tab", { framed: false }],
  ])("does not start inside %s", (_, over) => {
    const { frame, workers, hasListener, toParent } = setup(over as Partial<ComputeFrameEnv>);
    expect(frame).toBeNull();
    expect(workers).toEqual([]);
    expect(hasListener()).toBe(false);
    expect(toParent).toEqual([]);
  });

  it("starts inside the local test page when the extension's list allows it (a dev build)", () => {
    const { frame, toParent } = setup({ parentOrigin: LOCAL_ORIGIN, allowedParentOrigin: allowedIn(true) });
    expect(frame).not.toBeNull();
    expect(toParent).toEqual([{ message: readyOf(frame!.instance), origin: LOCAL_ORIGIN }]);
  });

  it("starts inside a video site, loads the release, and says ready to that origin only", () => {
    const { frame, workers, toParent } = setup();
    expect(frame).not.toBeNull();
    expect(workers[0]!.posted[0]).toMatchObject({ kind: "load" });
    expect(toParent).toEqual([{ message: readyOf(frame!.instance), origin: SITE_ORIGIN }]);
    expect(frame!.instance).toMatch(/^[0-9a-f]{16}$/);
  });

  it("acts only on messages from its parent window and origin", () => {
    const { frame, workers, send, parent, clock } = setup();
    loaded(workers[0]!);
    const message = tag({ kind: "pointer", x: 0.5, y: 0.5, mediaTime: 1, touch: false });
    send(message, {}, SITE_ORIGIN);
    send(message, parent, "https://evil.example");
    expect(frame!.core!.scheduler.pointerActive(clock.now)).toBe(false);
    send(message, parent);
    expect(frame!.core!.scheduler.pointerActive(clock.now)).toBe(true);
  });

  it("closes a picture in a message it does not take", () => {
    const { send, parent } = setup();
    const bitmap = new FakeBitmap();
    send({ [TAG]: 1, kind: "frame", requestId: 1, bitmap, mediaTime: 0 }, parent);
    expect(bitmap.closed).toBe(true);
  });
});

describe("pictures", () => {
  it("closes a picture in a message from its parent that does not parse", () => {
    const { send, parent } = setup();
    const picture = new FakeBitmap();
    send({ [TAG]: 1, kind: "nonsense", picture }, parent);
    expect(picture.closed).toBe(true);
  });

  it("closes a picture in a message from another window or origin", () => {
    const { workers, send, parent } = setup();
    loaded(workers[0]!);
    const a = new FakeBitmap();
    const b = new FakeBitmap();
    send(tag({ kind: "frame", requestId: 1, bitmap: a, mediaTime: 0 }), {}, SITE_ORIGIN);
    send(tag({ kind: "frame", requestId: 1, bitmap: b, mediaTime: 0 }), parent, "https://evil.example");
    expect([a.closed, b.closed]).toEqual([true, true]);
  });

  it("closes a picture attached to a message it takes that is not a frame", () => {
    const { frame, workers, send, clock } = setup();
    loaded(workers[0]!);
    const stray = new FakeBitmap();
    send({ ...tag({ kind: "pointer", x: 0.5, y: 0.5, mediaTime: 1, touch: false }), bitmap: stray, extra: new FakeBitmap() });
    expect(frame!.core!.scheduler.pointerActive(clock.now)).toBe(true);
    expect(stray.closed).toBe(true);
    const presented = new FakeBitmap();
    send({ ...tag({ kind: "presented", mediaTime: 2 }), picture: presented });
    expect(presented.closed).toBe(true);
  });

  it("passes the picture it asked for to the worker, open", () => {
    const t = setup();
    loaded(t.workers[0]!);
    t.send(tag({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false }));
    const capture = t.messages().find((m) => m.kind === "capture") as { requestId: number };
    const bitmap = new FakeBitmap();
    const stray = new FakeBitmap();
    t.send({ ...tag({ kind: "frame", requestId: capture.requestId, bitmap, mediaTime: 1 }), other: stray });
    expect(t.workers[0]!.posted.at(-1)).toMatchObject({ kind: "frame", bitmap });
    expect(bitmap.closed).toBe(false);
    expect(stray.closed).toBe(true);
  });

  it("stops the worker and stops listening", () => {
    const t = setup();
    loaded(t.workers[0]!);
    t.frame!.stop();
    expect(t.workers[0]!.terminated).toBe(true);
    expect(t.hasListener()).toBe(false);
  });
});

describe("messages to the core", () => {
  it("asks for at most MAX_FRAME_SIDE, whatever width the release allows", () => {
    const t = setup();
    const wide = { ...releaseOf("r0"), analysisWidth: { min: 5000, max: 8000 } };
    t.workers[0]!.reply({ kind: "release-status", ok: true, error: null, release: wide, cards: [] });
    t.send(tag({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false }));
    const capture = t.messages().find((m) => m.kind === "capture") as { analysisWidth: { min: number; max: number } };
    expect(capture.analysisWidth).toEqual({ min: 4096, max: 4096 });
    expect(protocol.parseComputeOut(tag(capture))).not.toBeNull();
  });

  it("asks for a capture, and posts the shown card without its frame box or a release id", () => {
    const t = setup();
    loaded(t.workers[0]!);
    showCard(t, t.workers[0]!);
    expect(t.messages().find((m) => m.kind === "capture")).toEqual(tag({ kind: "capture", requestId: 1, analysisWidth: { min: 720, max: 1920 } }));
    expect(lastShown(t)).toEqual(tag({ kind: "shown", card: { cardId: "T-001", name: "Card One", box: { x: 0.1, y: 0.2, width: 0.2, height: 0.6 }, others: [] } }));
    expect(protocol.parseComputeOut(lastShown(t))).not.toBeNull();
    expect(t.toParent.every((p) => p.origin === SITE_ORIGIN)).toBe(true);
  });

  it("maps each content message onto the core", () => {
    const t = setup();
    loaded(t.workers[0]!);
    const core = t.frame!.core!;
    const calls: unknown[][] = [];
    for (const name of ["pointer", "pointerLeft", "presented", "discontinuity", "cut", "frame", "captureFailed"] as const) {
      vi.spyOn(core, name).mockImplementation((...args: unknown[]) => void calls.push([name, ...args]));
    }
    const bitmap = new FakeBitmap();
    t.send(tag({ kind: "pointer", x: 0.25, y: 0.75, mediaTime: 3, touch: true }));
    t.send(tag({ kind: "leave" }));
    t.send(tag({ kind: "presented", mediaTime: 4 }));
    t.send(tag({ kind: "discontinuity", newSource: true }));
    t.send(tag({ kind: "cut" }));
    t.send(tag({ kind: "frame", requestId: 7, bitmap, mediaTime: 5 }));
    t.send(tag({ kind: "capture-failed", requestId: 8, reason: "no picture", retry: true }));
    t.send(tag({ kind: "capture-failed", requestId: 9, reason: "the video may not be read" }));
    expect(calls).toEqual([
      ["pointer", 0.25, 0.75, 3, true],
      ["pointerLeft"],
      ["presented", 4],
      ["discontinuity", true],
      ["cut"],
      ["frame", 7, bitmap, 5],
      ["captureFailed", 8, "no picture", true],
      ["captureFailed", 9, "the video may not be read", false],
    ]);
  });

  it("runs the core's driver on tick", () => {
    const t = setup();
    const tick = vi.spyOn(t.frame!.core!, "tick");
    t.frame!.tick();
    expect(tick).toHaveBeenCalledTimes(1);
  });
});

describe("ready and status", () => {
  it("reports a worker that fails before loading (ported)", () => {
    const t = setup();
    t.workers[0]!.fail("no wasm");
    expect(t.messages().at(-1)).toMatchObject({ kind: "status", state: "failed", error: "the worker did not start (no wasm)", backend: null });
    expect(t.workers).toHaveLength(1);
  });

  it("restarts a worker that fails after loading once, then turns off (ported)", () => {
    const t = setup();
    loaded(t.workers[0]!);
    showCard(t, t.workers[0]!);
    t.workers[0]!.fail();
    expect(t.workers[0]!.terminated).toBe(true);
    expect(t.workers).toHaveLength(2);
    expect(t.workers[1]!.posted[0]).toMatchObject({ kind: "load" });
    expect(lastShown(t)!.card).toBeNull();
    expect(t.frame!.restarts).toBe(1);
    // A late message from the old worker is ignored.
    t.workers[0]!.reply(statusFail("late"));
    expect(t.frame!.core!.status().state).toBe("loading");
    loaded(t.workers[1]!);
    expect(t.frame!.core!.status().state).toBe("ready");
    t.workers[1]!.fail("again");
    expect(t.workers).toHaveLength(2);
    expect(t.frame!.stopped).toBe(true);
    expect(t.messages().at(-1)).toMatchObject({ kind: "status", state: "failed", error: "the recognition worker stopped (again)", backend: null });
    // Off: pictures are closed, not analyzed.
    const bitmap = new FakeBitmap();
    t.send(tag({ kind: "frame", requestId: 1, bitmap, mediaTime: 0 }));
    expect(bitmap.closed).toBe(true);
  });

  it("tells a restart as loading with no backend, though the core keeps the old one until the new worker answers", () => {
    const t = setup();
    loaded(t.workers[0]!);
    expect(statuses(t).at(-1)).toEqual(tag({ kind: "status", state: "ready", error: null, backend: "wasm" }));
    showCard(t, t.workers[0]!);
    t.workers[0]!.fail("crash");
    expect(t.frame!.core!.status()).toMatchObject({ state: "loading", backend: "wasm" });
    expect(statuses(t).at(-1)).toEqual(tag({ kind: "status", state: "loading", error: null, backend: null }));
    // The shown card is cleared before the status, as the products did.
    expect(t.kinds().slice(-2)).toEqual(["shown", "status"]);
    loaded(t.workers[1]!);
    expect(statuses(t).at(-1)).toEqual(tag({ kind: "status", state: "ready", error: null, backend: "wasm" }));
  });

  it("posts a status only when its state, error or backend changes", () => {
    const t = setup();
    t.workers[0]!.reply({ kind: "release-progress", phase: "downloading", bytes: 10 });
    t.workers[0]!.reply({ kind: "release-progress", phase: "preparing", bytes: null });
    expect(statuses(t)).toEqual([]);
    loaded(t.workers[0]!);
    t.send(tag({ kind: "pointer", x: 0.9, y: 0.9, mediaTime: 1, touch: false }));
    t.frame!.tick();
    expect(statuses(t)).toHaveLength(1);
  });

  it("says ready once even when its first worker cannot be made, then that it failed", () => {
    const t = setup({
      createWorker: () => {
        throw new Error("blocked");
      },
    });
    expect(t.frame!.core).not.toBeNull();
    expect(t.frame!.stopped).toBe(true);
    expect(t.messages()).toEqual([
      readyOf(t.frame!.instance),
      tag({ kind: "status", state: "failed", error: "the recognition worker could not start (Error: blocked)", backend: null }),
    ]);
  });

  it("says ready once even when a chosen release's worker cannot be made", async () => {
    const t = await setupChoosing(remoteChoice(), {
      createWorker: () => {
        throw new Error("blocked");
      },
    });
    expect(t.kinds()).toEqual(["ready", "status"]);
    expect(t.messages()[1]).toMatchObject({ state: "failed" });
  });

  it("does not say ready again on a fallback or a restart", async () => {
    const t = await setupChoosing(remoteChoice());
    t.workers[0]!.reply(statusFail("bank: sha256 of bank.json does not match the release"));
    expect(t.workers).toHaveLength(2);
    loaded(t.workers[1]!, OTHER);
    t.workers[1]!.fail("crash");
    expect(t.workers).toHaveLength(3);
    expect(t.kinds().filter((k) => k === "ready")).toHaveLength(1);
  });

  it("posts loading when a remote release's files start to download, and still calls the hook", async () => {
    let downloading = 0;
    let resolve!: (c: RemoteReleaseChoice) => void;
    const t = await setupChoosing(new Promise<RemoteReleaseChoice>((r) => (resolve = r)), {
      chooseRelease: async (hooks) => {
        hooks.onDownloading();
        return new Promise<RemoteReleaseChoice>((r) => (resolve = r));
      },
      onDownloading: () => void (downloading += 1),
    });
    expect(t.messages()).toEqual([tag({ kind: "status", state: "loading", error: null, backend: null })]);
    expect(downloading).toBe(1);
    resolve(remoteChoice());
    await new Promise((r) => setTimeout(r, 0));
    expect(t.kinds()).toEqual(["status", "ready"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Ported from both products' compute-frame-remote.test.ts (the cases on the frame's side).
describe("remote release", () => {
  /** A product's details channel, on `onShown` and `release.table`. */
  const withFacts = () => {
    const facts: Array<{ releaseId: string; cardId: string; name: string }> = [];
    const shownTo: Array<[ShownCard | null, ReleaseInEffect]> = [];
    const onShown = (card: ShownCard | null, release: ReleaseInEffect) => {
      shownTo.push([card, release]);
      if (card && release.table && release.id && Object.hasOwn(release.table, card.cardId)) {
        facts.push({ releaseId: release.id, cardId: card.cardId, name: release.table[card.cardId]![0] });
      }
    };
    return { facts, shownTo, onShown };
  };

  it("loads the remote release; once the worker confirms its id, shown cards carry it and their details go out first", async () => {
    const f = withFacts();
    const t = await setupChoosing(remoteChoice(), { hoverAt: hitWith("T-999", "New Card") as never, onShown: (c, r) => (f.onShown(c, r), t.order.push("facts")) });
    expect(t.workers).toHaveLength(1);
    expect(t.workers[0]!.posted[0]).toMatchObject({ kind: "load", releaseUrl: "release.json" });
    t.workers[0]!.reply(statusOk(ID));
    expect(t.frame!.release).toMatchObject({ source: "remote", id: ID, reason: "ok" });
    expect(t.decisions).toEqual([{ source: "remote", reason: "ok", pointer: ID, reused: 2, downloaded: 4_400_000, ms: 12 }]);
    showCard(t, t.workers[0]!);
    expect(f.facts).toEqual([{ releaseId: ID, cardId: "T-999", name: "New Card" }]);
    expect(lastShown(t)!.card!.releaseId).toBe(ID);
    expect(t.order.slice(-2)).toEqual(["facts", "content:shown"]);
    // The hook saw the same card that was posted, and the release with its table.
    const [card, release] = f.shownTo.at(-1)!;
    expect(card).toEqual(lastShown(t)!.card);
    expect(release.table).toEqual({ "T-999": ["New Card", null, "full/T-999.jpg"] });
  });

  it("11: another id than the pointer's: no details go out and shown cards carry no release id", async () => {
    const f = withFacts();
    const t = await setupChoosing(remoteChoice(), { hoverAt: hitWith("T-999", "X") as never, onShown: f.onShown });
    t.workers[0]!.reply(statusOk(OTHER));
    expect(t.skips).toEqual(["id-mismatch"]);
    expect(isBundled(t.workers[1]!)).toBe(true);
    loaded(t.workers[1]!, OTHER);
    showCard(t, t.workers[1]!);
    expect(f.facts).toEqual([]);
    expect(lastShown(t)!.card!.cardId).toBe("T-999");
    expect(lastShown(t)!.card!.releaseId).toBeUndefined();
  });

  it("12: after a remote worker's restart, shown cards carry no release id", async () => {
    const f = withFacts();
    const t = await setupChoosing(remoteChoice(), { hoverAt: hitWith("T-999", "New Card") as never, onShown: f.onShown });
    t.workers[0]!.reply(statusOk(ID));
    t.workers[0]!.fail("crash");
    expect(isBundled(t.workers[1]!)).toBe(true);
    loaded(t.workers[1]!, OTHER);
    showCard(t, t.workers[1]!);
    expect(f.facts).toEqual([]);
    expect(lastShown(t)!.card!.releaseId).toBeUndefined();
  });

  it("while it chooses, has no core: content messages are dropped and a picture is closed", async () => {
    let resolve!: (c: RemoteReleaseChoice) => void;
    const t = await setupChoosing(new Promise<RemoteReleaseChoice>((r) => (resolve = r)));
    expect(t.frame!.core).toBeNull();
    expect(t.frame!.release.source).toBe("choosing");
    const bitmap = new FakeBitmap();
    t.send(tag({ kind: "frame", requestId: 1, mediaTime: 0, bitmap }));
    expect(bitmap.closed).toBe(true);
    t.frame!.tick();
    resolve(remoteChoice());
    await new Promise((r) => setTimeout(r, 0));
    expect(t.workers).toHaveLength(1);
    expect(t.frame!.core).not.toBeNull();
  });

  it("says ready only once a session can take messages, so the first `presented` is not lost", async () => {
    let resolve!: (c: RemoteReleaseChoice) => void;
    const t = await setupChoosing(new Promise<RemoteReleaseChoice>((r) => (resolve = r)));
    expect(t.kinds().includes("ready")).toBe(false);
    resolve({ source: "bundled", reason: "absent", pointer: null, downloaded: 0, ms: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.kinds().filter((k) => k === "ready")).toHaveLength(1);
    expect(t.frame!.core).not.toBeNull();
    // The first message after `ready` reaches the core.
    const presented = vi.spyOn(t.frame!.core!, "presented");
    t.send(tag({ kind: "presented", mediaTime: 1 }));
    expect(presented).toHaveBeenCalledWith(1);
    // A fallback or a restart does not say ready again.
    loaded(t.workers[0]!, OTHER);
    t.workers[0]!.fail("crash");
    expect(t.kinds().filter((k) => k === "ready")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Contract v1: hello, version and instance; pictures closed when something throws; status bounds.
describe("hello", () => {
  const hello = (version = PROTOCOL_VERSION) => tag({ kind: "hello", version });

  it("answers a hello with ready, the current status and the current shown card", () => {
    const t = setup({ instanceId: () => "00112233aabbccdd" });
    loaded(t.workers[0]!);
    showCard(t, t.workers[0]!);
    const card = lastShown(t)!.card;
    expect(card).not.toBeNull();
    const before = t.toParent.length;
    t.send(hello());
    expect(t.toParent.slice(before)).toEqual([
      { message: readyOf("00112233aabbccdd"), origin: SITE_ORIGIN },
      { message: tag({ kind: "status", state: "ready", error: null, backend: "wasm" }), origin: SITE_ORIGIN },
      { message: tag({ kind: "shown", card }), origin: SITE_ORIGIN },
    ]);
  });

  it("answers with nothing shown and the loading status before the release loads", () => {
    const t = setup();
    t.send(hello());
    expect(t.messages()).toEqual([readyOf(t.frame!.instance), readyOf(t.frame!.instance), tag({ kind: "status", state: "loading", error: null, backend: null }), tag({ kind: "shown", card: null })]);
  });

  it("is idempotent: repeated hellos make no worker or core again and keep the instance", () => {
    const t = setup();
    loaded(t.workers[0]!);
    const core = t.frame!.core;
    for (let i = 0; i < 3; i++) t.send(hello());
    expect(t.workers).toHaveLength(1);
    expect(t.workers[0]!.terminated).toBe(false);
    expect(t.workers[0]!.posted.filter((m) => m.kind === "load")).toHaveLength(1);
    expect(t.frame!.core).toBe(core);
    expect(t.frame!.restarts).toBe(0);
    const instances = t.messages().filter((m) => m.kind === "ready").map((m) => m.instance);
    expect(instances).toHaveLength(4);
    expect(new Set(instances)).toEqual(new Set([t.frame!.instance]));
    // The core still takes messages as before.
    t.send(tag({ kind: "pointer", x: 0.5, y: 0.5, mediaTime: 1, touch: false }));
    expect(t.frame!.core!.scheduler.pointerActive(t.clock.now)).toBe(true);
  });

  it("calls the product's hook before the shown card it answers a hello with", () => {
    const seen: Array<ShownCard | null> = [];
    const t = setup({ onShown: (card) => (seen.push(card), t.order.push("hook")) });
    loaded(t.workers[0]!);
    showCard(t, t.workers[0]!);
    t.send(hello());
    expect(t.order.slice(-2)).toEqual(["hook", "content:shown"]);
    expect(seen.at(-1)).toEqual(lastShown(t)!.card);
  });

  it("ignores a hello while it chooses a release; the unsolicited ready follows once the core exists", async () => {
    let resolve!: (c: RemoteReleaseChoice) => void;
    const t = await setupChoosing(new Promise<RemoteReleaseChoice>((r) => (resolve = r)));
    t.send(hello());
    expect(t.messages()).toEqual([]);
    resolve({ source: "bundled", reason: "absent", pointer: null, downloaded: 0, ms: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.messages()).toEqual([readyOf(t.frame!.instance)]);
    expect(t.workers).toHaveLength(1);
  });

  it("answers a hello of another version with its own ready, and acts no differently", () => {
    const t = setup();
    loaded(t.workers[0]!);
    const before = t.toParent.length;
    t.send(hello(PROTOCOL_VERSION + 1));
    expect(t.messages().slice(before).map((m) => m.kind)).toEqual(["ready", "status", "shown"]);
    expect(t.messages()[before]).toEqual(readyOf(t.frame!.instance));
    expect(t.workers).toHaveLength(1);
  });

  it("does not answer a malformed hello, or one from another window or origin", () => {
    const t = setup();
    const before = t.toParent.length;
    t.send(tag({ kind: "hello", version: 0 }));
    t.send(tag({ kind: "hello" }));
    t.send(hello(), {});
    t.send(hello(), t.parent, "https://evil.example");
    expect(t.toParent.length).toBe(before);
  });

  it("answers a hello after it turned off, with the failed status", () => {
    const t = setup({
      createWorker: () => {
        throw new Error("blocked");
      },
    });
    expect(t.frame!.stopped).toBe(true);
    t.send(hello());
    expect(t.messages().slice(-3)).toEqual([
      readyOf(t.frame!.instance),
      tag({ kind: "status", state: "failed", error: "the recognition worker could not start (Error: blocked)", backend: null }),
      tag({ kind: "shown", card: null }),
    ]);
  });

  it("makes a different random instance for each frame, and refuses an injected one of the wrong shape", () => {
    const a = setup();
    const b = setup();
    expect(a.frame!.instance).toMatch(/^[0-9a-f]{16}$/);
    expect(b.frame!.instance).toMatch(/^[0-9a-f]{16}$/);
    expect(a.frame!.instance).not.toBe(b.frame!.instance);
    expect(() => setup({ instanceId: () => "0123456789ABCDEF" })).toThrow(TypeError);
    expect(() => setup({ instanceId: () => "abc" })).toThrow(TypeError);
  });

  it("posts a ready that the content side's parser takes", () => {
    const t = setup();
    expect(protocol.parseComputeOut(t.messages()[0])).toEqual({ kind: "ready", version: PROTOCOL_VERSION, instance: t.frame!.instance });
  });
});

describe("pictures when something throws", () => {
  it("closes every other picture when the core throws on a frame, and leaves the frame's own to the core", () => {
    const t = setup();
    loaded(t.workers[0]!);
    vi.spyOn(t.frame!.core!, "frame").mockImplementation(() => {
      throw new Error("core broke");
    });
    const bitmap = new FakeBitmap();
    const stray = new FakeBitmap();
    expect(() => t.send({ ...tag({ kind: "frame", requestId: 1, bitmap, mediaTime: 1 }), other: stray })).toThrow("core broke");
    expect(stray.closed).toBe(true);
    // Passed to the core when `core.frame` was called: the frame does not close it.
    expect(bitmap.closed).toBe(false);
  });

  it("closes a stray picture when a product hook throws while a message is delivered", () => {
    const t = setup({
      onShown: (card) => {
        if (card === null) throw new Error("hook broke");
      },
    });
    loaded(t.workers[0]!);
    showCard(t, t.workers[0]!);
    const stray = new FakeBitmap();
    expect(() => t.send({ ...tag({ kind: "leave" }), picture: stray })).toThrow("hook broke");
    expect(stray.closed).toBe(true);
  });

  it("closes a stray picture on a hello whose answer throws", () => {
    const t = setup({
      onShown: () => {
        throw new Error("hook broke");
      },
    });
    const stray = new FakeBitmap();
    expect(() => t.send({ ...tag({ kind: "hello", version: PROTOCOL_VERSION }), picture: stray })).toThrow("hook broke");
    expect(stray.closed).toBe(true);
  });
});

describe("status bounds", () => {
  it("cuts a long error to MAX_TEXT_LENGTH before posting it", () => {
    const t = setup();
    t.workers[0]!.fail("x".repeat(500));
    const status = statuses(t).at(-1) as { error: string };
    expect(status.error).toHaveLength(MAX_TEXT_LENGTH);
    expect(status.error.startsWith("the worker did not start (xxx")).toBe(true);
    expect(protocol.parseComputeOut(status)).toMatchObject({ kind: "status", error: status.error });
  });
});
