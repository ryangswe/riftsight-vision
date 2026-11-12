// SPDX-License-Identifier: Apache-2.0
// Idle unload in the compute frame (`idleUnloadMs`, status `idle`, message `intent`), the page
// side's `intent: "page"`, and `loadWhen`.
import v8 from "node:v8";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCaptureControl, INTENT_INTERVAL_MS, loadWhen } from "../src/capture-control.js";
import { startComputeFrame, type ComputeFrameEnv } from "../src/compute-frame.js";
import { computeProtocol, PROTOCOL_VERSION } from "../src/compute-messages.js";
import type { ReleaseStatus, WorkerReply, WorkerRequest } from "../src/messages.js";
import type { FrameAnalysis } from "../src/pipeline.js";
import type { LoadRequest, RemoteReleaseChoice } from "../src/remote/choose.js";
import type { ReleasePointer } from "../src/remote/pointer.js";
import { plainLoad, WORKER_RESTARTS, type WorkerLike } from "../src/worker-session.js";

const SITE = "https://video.example";
const protocol = computeProtocol("example");
const tag = protocol.tag;
const IDLE_MS = 10_000;
const ID = "0123456789abcdef";

const pointerRelease: ReleasePointer = { id: ID, path: `vision/releases/${ID}/release.json`, sha256: "a".repeat(64), minimumExtensionVersion: "0.3.0", maximumExtensionVersion: null };
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
  terminated = 0;
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  postMessage(message: unknown) {
    this.posted.push(message as Record<string, unknown>);
  }
  terminate() {
    this.terminated += 1;
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent<WorkerReply>);
  }
  fail(message = "boom") {
    this.onerror?.({ message } as ErrorEvent);
  }
}

class FakeBitmap {
  width = 1000;
  height = 500;
  close() {}
}
beforeEach(() => vi.stubGlobal("ImageBitmap", FakeBitmap));
afterEach(() => vi.unstubAllGlobals());

const BUNDLED_URL = "extension://x/release/release.json";
const bundledLoad: LoadRequest = { kind: "load", releaseUrl: BUNDLED_URL, wasmPaths: "w/" };
const remoteRequest: LoadRequest = { kind: "load", releaseUrl: "remote-release.json", files: {}, wasmPaths: "w/" };
const remoteChoice = (): RemoteReleaseChoice => ({
  source: "remote",
  pointer: pointerRelease,
  request: remoteRequest,
  facts: { "T-999": ["New Card", null, "full/T-999.jpg"] },
  reused: 0,
  downloaded: 0,
  ms: 1,
});

const hit = (_: FrameAnalysis, x: number, y: number) =>
  x >= 100 && x <= 300 && y >= 100 && y <= 400
    ? { card: null, boxIndex: 0, box: { x: 100, y: 100, width: 200, height: 300 }, cardId: "T-001", name: "Card One" }
    : { card: null, boxIndex: null, box: null, cardId: null, name: null };
const analysis = (): FrameAnalysis => ({ frame: { width: 1000, height: 500 }, hover: { selection: "accepted-nms", cards: [] }, boxes: [] }) as unknown as FrameAnalysis;

function setup(over: Partial<ComputeFrameEnv> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (m: unknown) => void sent.push(m as Record<string, unknown>) };
  let listener: ((event: MessageEvent) => void) | null = null;
  const workers: FakeWorker[] = [];
  const clock = { now: 1_000 };
  const env: ComputeFrameEnv = {
    win: {
      parent,
      addEventListener: (_: "message", l: (event: MessageEvent) => void) => void (listener = l),
      removeEventListener: () => void (listener = null),
    },
    framed: true,
    parentOrigin: SITE,
    allowedParentOrigin: (o) => o === SITE,
    protocol,
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    loadRequest: bundledLoad,
    now: () => clock.now,
    hoverAt: hit as never,
    idleUnloadMs: IDLE_MS,
    ...over,
  };
  const frame = startComputeFrame(env)!;
  const send = (data: unknown) => listener?.({ data, source: parent, origin: SITE } as unknown as MessageEvent);
  const states = () => sent.filter((m) => m.kind === "status").map((m) => m.state);
  const captures = () => sent.filter((m) => m.kind === "capture");
  const pointer = (x = 0.2) => send(tag({ kind: "pointer", x, y: 0.5, mediaTime: 1, touch: false }));
  /** Advance the clock and tick once per step, as a driver would. */
  const run = (ms: number, step = 500, answering = false) => {
    for (let left = ms; left > 0; left -= step) {
      clock.now += Math.min(step, left);
      frame.tick();
      // A host that answers every look, as a live one does.
      if (answering && frame.core?.analysisInFlight() && workers.length) answerLook(workers[workers.length - 1]!);
    }
  };
  /** Answer the newest capture with a picture and the worker with an analysis. */
  const answerLook = (w: FakeWorker) => {
    const capture = captures().at(-1) as { requestId: number };
    send(tag({ kind: "frame", requestId: capture.requestId, bitmap: new FakeBitmap(), mediaTime: 1 }));
    const request = w.posted.at(-1) as unknown as Extract<WorkerRequest, { kind: "frame" }>;
    w.reply({ kind: "frame-result", envelope: request.envelope, videoTimeSec: 1, width: 1000, height: 500, workerMs: 5, analysis: analysis() });
  };
  const loaded = (w: FakeWorker, id = "r0") => w.reply({ kind: "release-status", ok: true, error: null, release: releaseOf(id), cards: [] });
  return { frame, sent, workers, clock, send, states, captures, pointer, run, answerLook, loaded };
}

describe("idle unload (rows 1 and 6)", () => {
  it("ends the worker once after the idle time, reports idle, and stops asking for pictures", () => {
    const t = setup();
    t.loaded(t.workers[0]!);
    expect(t.states()).toEqual(["ready"]);
    t.run(IDLE_MS - 500);
    expect(t.workers[0]!.terminated).toBe(0);
    t.run(500);
    expect(t.workers[0]!.terminated).toBe(1);
    expect(t.states()).toEqual(["ready", "idle"]);
    const captures = t.captures().length;
    t.run(IDLE_MS * 3);
    expect(t.workers[0]!.terminated).toBe(1);
    expect(t.captures().length).toBe(captures);
    expect(t.workers).toHaveLength(1);
    expect(t.frame.stopped).toBe(false);
  });

  it("keeps the handshake: a hello while idle is answered with ready and the idle status", () => {
    const t = setup();
    t.loaded(t.workers[0]!);
    t.run(IDLE_MS);
    t.sent.length = 0;
    t.send(tag({ kind: "hello", version: PROTOCOL_VERSION }));
    expect(t.sent.map((m) => m.kind)).toEqual(["ready", "status", "shown"]);
    expect(t.sent[1]).toMatchObject({ state: "idle" });
    expect(t.workers).toHaveLength(1);
  });

  it("does nothing without idleUnloadMs", () => {
    const t = setup({ idleUnloadMs: undefined });
    t.loaded(t.workers[0]!);
    t.run(IDLE_MS * 100, 5_000);
    expect(t.workers[0]!.terminated).toBe(0);
    expect(t.states()).toEqual(["ready"]);
  });

  it("counts from the moment it is ready, not from the start", () => {
    const t = setup();
    t.run(IDLE_MS * 3);
    expect(t.workers[0]!.terminated).toBe(0);
    t.loaded(t.workers[0]!);
    t.run(IDLE_MS - 500);
    expect(t.workers[0]!.terminated).toBe(0);
    t.run(500);
    expect(t.workers[0]!.terminated).toBe(1);
  });

  it.each([0, -1, NaN, Infinity, "10" as unknown as number])("refuses idleUnloadMs %s at start", (value) => {
    expect(() => setup({ idleUnloadMs: value })).toThrow(RangeError);
  });
});

describe("resume (row 2)", () => {
  it.each(["a pointer message", "an intent message"])("%s loads the same request: loading, then ready, captures resume", (how) => {
    const t = setup();
    t.loaded(t.workers[0]!);
    t.run(IDLE_MS);
    t.sent.length = 0;
    if (how === "a pointer message") t.pointer();
    else t.send(tag({ kind: "intent" }));
    expect(t.workers).toHaveLength(2);
    expect(t.workers[1]!.posted[0]).toEqual(t.workers[0]!.posted[0]);
    expect(t.states()).toEqual(["loading"]);
    expect(t.captures()).toEqual([]);
    t.loaded(t.workers[1]!);
    expect(t.states()).toEqual(["loading", "ready"]);
    t.pointer();
    expect(t.captures().length).toBeGreaterThan(0);
    expect(t.frame.restarts).toBe(0);
  });

  it("reloads a remote release as it was: same request and id, no fallback, restart not used", async () => {
    const t = setup({ chooseRelease: async () => remoteChoice() });
    await new Promise((r) => setTimeout(r, 0));
    t.loaded(t.workers[0]!, ID);
    expect(t.frame.release).toMatchObject({ source: "remote", id: ID });
    t.run(IDLE_MS);
    expect(t.workers[0]!.terminated).toBe(1);
    t.pointer();
    expect(t.workers).toHaveLength(2);
    expect(t.workers[1]!.posted[0]).toEqual(remoteRequest);
    t.loaded(t.workers[1]!, ID);
    expect(t.frame.release).toMatchObject({ source: "remote", id: ID, reason: "ok" });
    expect(t.frame.restarts).toBe(0);
    expect(t.states().at(-1)).toBe("ready");
    // A later crash still gets its one restart, on the bundled release; a second one ends it.
    t.workers[1]!.fail();
    expect(t.frame.restarts).toBe(WORKER_RESTARTS);
    expect(t.workers[2]!.posted[0]).toEqual(plainLoad(bundledLoad));
    t.loaded(t.workers[2]!);
    t.workers[2]!.fail();
    expect(t.frame.stopped).toBe(true);
    expect(t.workers).toHaveLength(3);
  });

  it("a crash before an unload does not give the restart back, and a resume does not use another", () => {
    const t = setup();
    t.loaded(t.workers[0]!);
    t.workers[0]!.fail();
    expect(t.frame.restarts).toBe(1);
    t.loaded(t.workers[1]!);
    t.run(IDLE_MS);
    expect(t.workers[1]!.terminated).toBe(1);
    t.pointer();
    // The reload is the request now in effect: the restarted worker's.
    expect(t.workers[2]!.posted[0]).toEqual(t.workers[1]!.posted[0]);
    expect(t.frame.restarts).toBe(1);
  });

  it("only a pointer or an intent resumes: presented, discontinuity, leave and cut do not", () => {
    const t = setup();
    t.loaded(t.workers[0]!);
    t.run(IDLE_MS);
    t.send(tag({ kind: "presented", mediaTime: 2 }));
    t.send(tag({ kind: "discontinuity", newSource: false }));
    t.send(tag({ kind: "leave" }));
    t.send(tag({ kind: "cut" }));
    t.run(IDLE_MS);
    expect(t.workers).toHaveLength(1);
    expect(t.states().at(-1)).toBe("idle");
  });

  describe("a resumed load that fails takes the one restart", () => {
    const remoteFrame = async (over: Partial<ComputeFrameEnv> = {}) => {
      const skips: string[] = [];
      const decisions: string[] = [];
      const t = setup({ chooseRelease: async () => remoteChoice(), recordSkip: (_, r) => void skips.push(r), onDecision: (d) => void decisions.push(`${d.source}:${d.reason}`), ...over });
      await new Promise((r) => setTimeout(r, 0));
      t.loaded(t.workers[0]!, ID);
      t.run(IDLE_MS);
      t.pointer();
      return { ...t, skips, decisions };
    };
    const expectRestarted = (t: Awaited<ReturnType<typeof remoteFrame>>) => {
      expect(t.workers).toHaveLength(3);
      expect(t.workers[1]!.terminated).toBeGreaterThanOrEqual(1);
      expect(t.workers[2]!.posted[0]).toEqual(plainLoad(bundledLoad));
      expect(t.frame.restarts).toBe(WORKER_RESTARTS);
      expect(t.frame.release).toMatchObject({ source: "bundled", reason: "worker-restart" });
      expect(t.decisions.at(-1)).toBe("bundled:worker-restart");
      expect(t.skips).toEqual([]); // no refusal: nothing skip-listed
      expect(t.frame.stopped).toBe(false);
      expect(t.states().at(-1)).toBe("loading");
      t.loaded(t.workers[2]!);
      expect(t.states().at(-1)).toBe("ready");
    };

    it("(a) a remote release refused on resume restarts on the bundled release", async () => {
      const t = await remoteFrame();
      t.workers[1]!.reply({ kind: "release-status", ok: false, error: "refused", release: null, cards: [] });
      expectRestarted(t);
    });

    it("(b) a crash during the resumed load does the same", async () => {
      const t = await remoteFrame();
      t.workers[1]!.fail();
      expectRestarted(t);
    });

    it("with the restart already used, a failed resumed load turns recognition off", () => {
      const t = setup();
      t.loaded(t.workers[0]!);
      t.workers[0]!.fail(); // the restart
      t.loaded(t.workers[1]!);
      t.run(IDLE_MS);
      t.pointer();
      t.workers[2]!.reply({ kind: "release-status", ok: false, error: "refused", release: null, cards: [] });
      expect(t.frame.stopped).toBe(true);
      expect(t.states().at(-1)).toBe("failed");
      expect(t.workers).toHaveLength(3);
    });

    it("after a good resume a later crash still gets its restart", async () => {
      const t = await remoteFrame();
      t.loaded(t.workers[1]!, ID);
      t.workers[1]!.fail();
      expect(t.workers).toHaveLength(3);
      expect(t.frame.restarts).toBe(1);
    });
  });

  it("ignores a late reply from the ended worker", () => {
    const t = setup();
    t.loaded(t.workers[0]!);
    t.run(IDLE_MS);
    t.workers[0]!.reply({ kind: "release-status", ok: false, error: "late", release: null, cards: [] });
    expect(t.frame.stopped).toBe(false);
    expect(t.states().at(-1)).toBe("idle");
  });
});

describe("the geometric stage across an unload", () => {
  const staged: LoadRequest = { ...bundledLoad, geometricUrl: "geometric.json" };
  const stageReply = (state: "ready" | "off", reason: string | null = null) => ({ kind: "geometric-status", state, reason, bytes: null });

  it("a running stage is reported off for the idle time and loads again with the request", () => {
    const heard: Array<[string, string | null]> = [];
    const t = setup({ loadRequest: staged, onGeometricStatus: (s) => void heard.push([s.state, s.reason]) });
    t.workers[0]!.reply(stageReply("ready"));
    t.loaded(t.workers[0]!);
    heard.length = 0;
    t.run(IDLE_MS);
    expect(heard).toEqual([["off", "idle-unload"]]);
    expect(t.frame.core!.status().geometric).toMatchObject({ state: "off", reason: "idle-unload" });
    t.pointer();
    expect(t.workers[1]!.posted[0]).toEqual(staged);
    expect(t.frame.core!.status().geometric).toMatchObject({ state: "loading" });
  });

  it("a stage the worker turned off stays off: resume loads the plain request and says nothing new", () => {
    const heard: Array<[string, string | null]> = [];
    const t = setup({ loadRequest: staged, onGeometricStatus: (s) => void heard.push([s.state, s.reason]) });
    t.workers[0]!.reply(stageReply("off", "watchdog"));
    t.loaded(t.workers[0]!);
    heard.length = 0;
    t.run(IDLE_MS);
    t.pointer();
    expect(t.workers[1]!.posted[0]).toEqual(plainLoad(staged));
    expect(t.workers[1]!.posted[0]).not.toHaveProperty("geometricUrl");
    expect(t.frame.core!.status().geometric).toMatchObject({ state: "off", reason: "watchdog" });
    expect(heard).toEqual([]);
  });
});

describe("what the frame holds (item: remote files)", () => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;

  async function heldAfterLoad(idleUnloadMs: number | undefined): Promise<boolean> {
    let ref: WeakRef<object> | null = null;
    const t = setup({
      idleUnloadMs,
      chooseRelease: async () => {
        // Stands for the release's files (Blobs): held only through this load request.
        const files = { "model.onnx": new Blob([new Uint8Array(1024)]) };
        ref = new WeakRef(files);
        return { ...remoteChoice(), request: { kind: "load", releaseUrl: "r.json", files, wasmPaths: "w/" } } as RemoteReleaseChoice;
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    t.loaded(t.workers[0]!, ID);
    t.workers[0]!.posted.length = 0; // the fake worker's own record of what it was sent
    for (let k = 0; k < 5; k++) {
      await new Promise((r) => setTimeout(r, 5));
      gc();
    }
    expect(t.frame.stopped).toBe(false);
    return ref!.deref() !== undefined;
  }

  it("without idleUnloadMs the request, and so a remote release's files, is not kept", async () => {
    expect(await heldAfterLoad(undefined)).toBe(false);
  });

  it("with idleUnloadMs it is kept, to be loaded again", async () => {
    expect(await heldAfterLoad(IDLE_MS)).toBe(true);
  });
});

describe("what keeps it loaded (row 3)", () => {
  it("in always-on mode the looks asked for keep it loaded", () => {
    const t = setup({ mode: "always-on" });
    t.loaded(t.workers[0]!);
    // A playing video presents frames; the cadence asks for a look, the host answers it.
    for (let i = 0; i < (IDLE_MS * 6) / 250; i++) {
      t.send(tag({ kind: "presented", mediaTime: 1 + i * 0.25 }));
      t.run(250, 250, true);
    }
    expect(t.captures().length).toBeGreaterThan(10);
    expect(t.workers[0]!.terminated).toBe(0);
    // The video stops presenting: no more looks, and the timer runs out.
    t.run(IDLE_MS + 2_000, 250, true);
    expect(t.workers[0]!.terminated).toBe(1);
  });

  it("pointer messages over the picture restart the timer", () => {
    const t = setup();
    t.loaded(t.workers[0]!);
    for (let i = 0; i < 6; i++) {
      t.run(IDLE_MS - 1_000);
      t.pointer(0.9); // away from the card, over the picture
      t.answerLook(t.workers[0]!);
    }
    expect(t.workers[0]!.terminated).toBe(0);
    t.send(tag({ kind: "leave" }));
    t.run(IDLE_MS * 2, 500, true);
    expect(t.workers[0]!.terminated).toBe(1);
  });

  it("a card shown keeps it, and the timer starts again from the last card", () => {
    const t = setup();
    t.loaded(t.workers[0]!);
    t.pointer();
    t.answerLook(t.workers[0]!);
    expect(t.sent.filter((m) => m.kind === "shown").at(-1)).toMatchObject({ card: { cardId: "T-001" } });
    t.run(IDLE_MS * 5, 500, true);
    expect(t.workers[0]!.terminated).toBe(0);
    t.send(tag({ kind: "leave" })); // the card goes
    t.run(IDLE_MS - 500, 500, true);
    expect(t.workers[0]!.terminated).toBe(0);
    t.run(3_000, 500, true);
    expect(t.workers[0]!.terminated).toBe(1);
  });

  it("an analysis in flight keeps it", () => {
    const t = setup();
    t.loaded(t.workers[0]!);
    t.pointer(0.9);
    expect(t.captures()).toHaveLength(1); // a look is out, unanswered
    t.run(IDLE_MS - 500, 100); // the driver's watchdog has not given up on it yet
    expect(t.frame.core!.analysisInFlight()).toBe(true);
    expect(t.workers[0]!.terminated).toBe(0);
    t.answerLook(t.workers[0]!);
    expect(t.frame.core!.analysisInFlight()).toBe(false);
    t.run(IDLE_MS - 500);
    expect(t.workers[0]!.terminated).toBe(0);
    t.run(1_000);
    expect(t.workers[0]!.terminated).toBe(1);
  });

  it("an intent while loaded counts as activity", () => {
    const t = setup();
    t.loaded(t.workers[0]!);
    t.run(IDLE_MS - 500);
    t.send(tag({ kind: "intent" }));
    t.run(IDLE_MS - 500);
    expect(t.workers[0]!.terminated).toBe(0);
  });
});

describe("the messages (row 6)", () => {
  it("parses intent and the idle status, and refuses a status with another state", () => {
    expect(protocol.parseComputeIn(tag({ kind: "intent" }))).toEqual({ kind: "intent" });
    expect(protocol.parseComputeIn({ kind: "intent" })).toBeNull();
    expect(protocol.parseComputeOut(tag({ kind: "status", state: "idle", error: null, backend: null }))).toEqual({ kind: "status", state: "idle", error: null, backend: null });
    expect(protocol.parseComputeOut(tag({ kind: "status", state: "asleep", error: null, backend: null }))).toBeNull();
  });
});

// ------------------------------------------------------------------------ the page side
type Listener = (event: unknown) => void;
function fakeTarget() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, fn: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    fire(type: string, event: unknown = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe("intent: page (row 4)", () => {
  const ORIGIN = "chrome-extension://abcdefghijklmnop";

  function page(intent: "page" | null = "page") {
    let t = 1_000;
    const sent: Array<Record<string, unknown>> = [];
    const frameWindow = { postMessage: (m: Record<string, unknown>) => void sent.push(m) };
    const control = createCaptureControl({
      protocol,
      frame: () => frameWindow as unknown as Window,
      frameOrigin: ORIGIN,
      now: () => t,
      ...(intent ? { intent } : {}),
      timers: { set: () => 0, clear: () => {} },
    });
    const win = fakeTarget();
    control.listen(win as unknown as Window, Object.assign(fakeTarget(), { documentElement: {}, visibilityState: "visible" }) as unknown as Document);
    const video = Object.assign(fakeTarget(), {
      isConnected: true, videoWidth: 1280, videoHeight: 720, readyState: 4, paused: false, ended: false, currentTime: 1,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
      ownerDocument: { defaultView: { getComputedStyle: () => ({ objectFit: "contain" }) } },
    });
    control.attach(video as unknown as HTMLVideoElement);
    control.onMessage({ isTrusted: true, source: frameWindow, origin: ORIGIN, data: tag({ kind: "ready", version: PROTOCOL_VERSION, instance: ID }) } as unknown as MessageEvent);
    sent.length = 0;
    const move = (over: { isTrusted?: boolean; x?: number; y?: number } = {}) =>
      win.fire("pointermove", { type: "pointermove", isTrusted: over.isTrusted ?? true, pointerType: "mouse", pointerId: 1, clientX: over.x ?? 5000, clientY: over.y ?? 5000, target: {} });
    const intents = () => sent.filter((m) => m.kind === "intent");
    return { move, intents, video, advance: (ms: number) => void (t += ms), control };
  }

  it("a trusted move anywhere in the page, while the video plays, sends one intent", () => {
    const p = page();
    p.move(); // far outside the picture
    expect(p.intents()).toHaveLength(1);
    expect(p.intents()[0]).toMatchObject({ example: 1 });
  });

  it("at most one a second", () => {
    const p = page();
    p.move();
    p.advance(INTENT_INTERVAL_MS - 1);
    p.move();
    expect(p.intents()).toHaveLength(1);
    p.advance(1);
    p.move();
    expect(p.intents()).toHaveLength(2);
  });

  it("nothing for an untrusted move, a paused or ended video, or the option off", () => {
    const p = page();
    p.move({ isTrusted: false });
    p.video.paused = true;
    p.move();
    p.video.paused = false;
    p.video.ended = true;
    p.move();
    expect(p.intents()).toEqual([]);
    p.video.ended = false;
    p.move();
    expect(p.intents()).toHaveLength(1);
    const off = page(null);
    off.move();
    expect(off.intents()).toEqual([]);
  });

  it("a playing event, a stall or a loop sends no intent: only a trusted pointer move does", () => {
    const p = page();
    for (const type of ["playing", "waiting", "playing", "ended", "seeked", "seeking", "playing", "play", "canplay", "loadeddata"]) p.video.fire(type);
    p.advance(INTENT_INTERVAL_MS * 5);
    p.video.fire("playing");
    expect(p.intents()).toEqual([]);
    p.move();
    expect(p.intents()).toHaveLength(1);
  });

  it("a refused move does not use up the second", () => {
    const p = page();
    p.video.paused = true;
    p.move();
    p.video.paused = false;
    p.move();
    expect(p.intents()).toHaveLength(1);
  });
});

describe("a frame made by loadWhen at play, in pointer mode", () => {
  it("asks for no picture for its whole idle time without a pointer, then reports idle", () => {
    const video = Object.assign(fakeTarget(), { paused: true, ended: false });
    let t: ReturnType<typeof setup> | undefined;
    loadWhen(video as unknown as HTMLVideoElement, "play", () => {
      t = setup();
    });
    expect(t).toBeUndefined();
    video.paused = false;
    video.fire("playing");
    expect(t).toBeDefined();
    t!.loaded(t!.workers[0]!);
    expect(t!.states()).toEqual(["ready"]);
    // The video keeps presenting pictures the whole time (pointer mode is the default), and nobody points.
    const present = (ms: number) => {
      for (let left = ms; left > 0; left -= 250) {
        t!.send(tag({ kind: "presented", mediaTime: 1 + (ms - left) / 1000 }));
        t!.run(250, 250, true);
      }
    };
    present(IDLE_MS - 500);
    expect(t!.captures()).toEqual([]);
    expect(t!.states()).toEqual(["ready"]);
    present(500);
    expect(t!.states()).toEqual(["ready", "idle"]);
    present(IDLE_MS * 3);
    expect(t!.captures()).toEqual([]);
    expect(t!.sent.filter((m) => m.kind === "capture")).toEqual([]);
    expect(t!.workers[0]!.posted.filter((m) => m.kind === "frame")).toEqual([]);
  });

  it("in always-on mode the same frame can ask (the page's gate is what refuses)", () => {
    const t = setup({ mode: "always-on" });
    t.loaded(t.workers[0]!);
    t.run(2_000);
    expect(t.captures().length).toBeGreaterThan(0);
  });
});

describe("loadWhen (row 5)", () => {
  const video = (state: { paused: boolean; ended: boolean }) => Object.assign(fakeTarget(), state);

  it("calls make at once for a video already playing, once", () => {
    const v = video({ paused: false, ended: false });
    const make = vi.fn();
    loadWhen(v as unknown as HTMLVideoElement, "play", make);
    expect(make).toHaveBeenCalledTimes(1);
    v.fire("playing");
    expect(make).toHaveBeenCalledTimes(1);
    expect(v.count()).toBe(0);
  });

  it("waits for playing on a paused video, then calls make once", () => {
    const v = video({ paused: true, ended: false });
    const make = vi.fn();
    loadWhen(v as unknown as HTMLVideoElement, "play", make);
    expect(make).not.toHaveBeenCalled();
    v.fire("playing");
    v.paused = false;
    v.fire("playing");
    v.fire("playing");
    expect(make).toHaveBeenCalledTimes(1);
    expect(v.count()).toBe(0);
  });

  it("never fires for an ended video, even on a playing event", () => {
    const v = video({ paused: false, ended: true });
    const make = vi.fn();
    loadWhen(v as unknown as HTMLVideoElement, "play", make);
    v.fire("playing");
    expect(make).not.toHaveBeenCalled();
  });

  it.each([
    ["paused at the start", { paused: true, ended: false }],
    ["already playing", { paused: false, ended: false }],
  ])("calls make once through a stall and a loop (%s)", (_, state) => {
    const v = video(state);
    const make = vi.fn();
    loadWhen(v as unknown as HTMLVideoElement, "play", make);
    v.paused = false;
    v.fire("playing");
    v.fire("waiting");
    v.fire("playing");
    v.ended = true;
    v.fire("ended");
    v.ended = false;
    v.fire("seeked");
    v.fire("playing");
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("stop removes the listener, so make never runs", () => {
    const v = video({ paused: true, ended: false });
    const make = vi.fn();
    const handle = loadWhen(v as unknown as HTMLVideoElement, "play", make);
    expect(v.count()).toBe(1);
    handle.stop();
    expect(v.count()).toBe(0);
    v.paused = false;
    v.fire("playing");
    expect(make).not.toHaveBeenCalled();
  });
});
