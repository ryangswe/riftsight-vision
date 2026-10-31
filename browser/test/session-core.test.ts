// SPDX-License-Identifier: Apache-2.0
// The session core: the policy between a page that captures pictures and the analysis worker,
// with the real scheduler and a stand-in hit test. `HostLike` stands for the host that relays
// messages between a content script and the core (an extension's compute frame); the cases
// under "HostSession" are written against it.
import { beforeEach, describe, expect, it } from "vitest";

import type { AnalysisWidth } from "../src/capture.js";
import { ANALYSIS_WATCHDOG_MS, DRIVER_TICK_MS, FIRST_ANALYSIS_WATCHDOG_MS, LOOK_RETRY_MS, POINTER_GRACE_MS } from "../src/frame-scheduler.js";
import type { FrameResult, GeometricStatus, ReleaseStatus, WorkerReply, WorkerRequest } from "../src/messages.js";
import type { FrameAnalysis } from "../src/pipeline.js";
import { neighborBoxes, SessionCore, type SessionCoreDeps, type SessionCoreOptions, type Shown, SHOWN_HOLD } from "../src/session-core.js";
import type { SessionStatus } from "../src/session.js";

/** What a host posts to the content script. */
type ComputeOut =
  | { kind: "status"; state: SessionStatus["state"]; error: string | null; backend: SessionStatus["backend"] }
  | { kind: "capture"; requestId: number; analysisWidth: AnalysisWidth }
  | { kind: "shown"; card: Shown | null };
/** What the content script posts to a host. */
type ComputeIn =
  | { kind: "pointer"; x: number; y: number; mediaTime: number; touch: boolean }
  | { kind: "leave" }
  | { kind: "presented"; mediaTime: number }
  | { kind: "discontinuity"; newSource: boolean }
  | { kind: "frame"; requestId: number; bitmap: ImageBitmap; mediaTime: number }
  | { kind: "capture-failed"; requestId: number; reason: string; retry?: boolean };

interface HostDeps {
  now(): number;
  toWorker(request: WorkerRequest, transfer?: Transferable[]): void;
  toContent(message: ComputeOut): void;
  onGeometricStatus?(status: GeometricStatus): void;
  hoverAt?: unknown;
}

/** A host over the core: messages in, messages out; status posted when state, error or backend
 *  change. */
class HostLike {
  readonly core: SessionCore;
  private lastStatus = "";
  constructor(deps: HostDeps, options: SessionCoreOptions = { hold: SHOWN_HOLD }) {
    this.core = new SessionCore(
      {
        now: deps.now,
        toWorker: deps.toWorker,
        capture: (requestId, analysisWidth) => deps.toContent({ kind: "capture", requestId, analysisWidth }),
        onShown: (card) => deps.toContent({ kind: "shown", card }),
        onStatus: (s) => {
          const key = JSON.stringify([s.state, s.error, s.backend]);
          if (key === this.lastStatus) return;
          this.lastStatus = key;
          deps.toContent({ kind: "status", state: s.state, error: s.error, backend: s.backend });
        },
        ...(deps.onGeometricStatus ? { onGeometricStatus: deps.onGeometricStatus } : {}),
        ...(deps.hoverAt ? { hoverAt: deps.hoverAt as never } : {}),
      },
      options,
    );
    this.lastStatus = JSON.stringify(["loading", null, null]);
  }
  get scheduler() {
    return this.core.scheduler;
  }
  get lastFrameError(): string | null {
    return this.core.status().lastFrameError;
  }
  get framesAnalyzed(): number {
    return this.core.status().frames;
  }
  get geometric() {
    return this.core.status().geometric;
  }
  fresh(): Shown | null {
    return this.core.fresh();
  }
  tick(): void {
    this.core.tick();
  }
  fromWorker(reply: WorkerReply): void {
    this.core.fromWorker(reply);
  }
  fromContent(m: ComputeIn): void {
    switch (m.kind) {
      case "pointer":
        return this.core.pointer(m.x, m.y, m.mediaTime, m.touch);
      case "leave":
        return this.core.pointerLeft();
      case "presented":
        return this.core.presented(m.mediaTime);
      case "discontinuity":
        return this.core.discontinuity(m.newSource);
      case "frame":
        return this.core.frame(m.requestId, m.bitmap, m.mediaTime);
      case "capture-failed":
        return this.core.captureFailed(m.requestId, m.reason, m.retry);
    }
  }
}

const release: NonNullable<ReleaseStatus["release"]> = {
  id: "r",
  game: "toy-game",
  locale: "en",
  detector: { version: "d", ep: "wasm" },
  recognizer: { version: "r", ep: "wasm" },
  bankCards: 2,
  catalogCards: 2,
  identityLevel: "printing",
  decode: { threshold: 0.3, nmsIou: 0.45, maxProposals: 80, minCropPx: 24 },
  accept: { tau: 0.62, delta: 0.05 } as never,
  hoverSelection: "accepted-nms",
  hoverMaxAgeMs: 2000,
  analysisWidth: { min: 720, max: 1920 },
  ortWeb: "1.29.0",
};

/** What the detector finds in the next analyses: the card's own box, another box at the same
 *  place that barely overlaps it, or nothing. */
const detected: { box: "card" | "other" | "none" } = { box: "card" };
const analysisNow = (): FrameAnalysis =>
  ({
    frame: { width: 1000, height: 500 },
    hover: { selection: "accepted-nms", cards: [] },
    boxes:
      detected.box === "card" ? [{ box: [100, 100, 200, 300] }] : detected.box === "other" ? [{ box: [150, 200, 60, 80] }] : [],
  }) as unknown as FrameAnalysis;

/** A hit test with one card: by default T-001 in the box x 100..300, y 100..400 of a
 *  1000 x 500 frame. `scene.card` changes what the next analyses see there (null: nothing). */
const scene: { card: { cardId: string; name: string } | null } = { card: { cardId: "T-001", name: "Card One" } };
const hit = (_: FrameAnalysis, x: number, y: number) =>
  scene.card && x >= 100 && x <= 300 && y >= 100 && y <= 400
    ? { card: null, boxIndex: 0, box: { x: 100, y: 100, width: 200, height: 300 }, ...scene.card }
    : { card: null, boxIndex: null, box: null, cardId: null, name: null };

let clock = 0;
let toWorker: Array<{ request: WorkerRequest; transfer?: Transferable[] }>;
let toContent: ComputeOut[];
let session: HostLike;

const bitmap = () => {
  const b = { closed: false, close() { this.closed = true; } };
  return b as unknown as ImageBitmap & { closed: boolean };
};
const captures = () => toContent.filter((m): m is Extract<ComputeOut, { kind: "capture" }> => m.kind === "capture");
const shownMessages = () => toContent.filter((m): m is Extract<ComputeOut, { kind: "shown" }> => m.kind === "shown");
const lastShown = () => shownMessages().at(-1)?.card ?? null;

function reply(request: WorkerRequest, result: Partial<FrameResult> = {}): FrameResult {
  if (request.kind !== "frame") throw new Error("not a frame request");
  return { kind: "frame-result", envelope: request.envelope, videoTimeSec: request.videoTimeSec, width: 1000, height: 500, workerMs: 5, analysis: analysisNow(), ...result };
}

function ready(): void {
  session.fromWorker({ kind: "release-status", ok: true, error: null, release, cards: [] });
}

/** Pointer at (x, y) in fractions; runs the capture → frame → reply round trip it starts. */
function analyzeAt(x: number, y: number, mediaTime = 1): void {
  session.fromContent({ kind: "pointer", x, y, mediaTime, touch: false });
  const capture = captures().at(-1)!;
  session.fromContent({ kind: "frame", requestId: capture.requestId, bitmap: bitmap(), mediaTime });
  session.fromWorker(reply(toWorker.at(-1)!.request));
}

beforeEach(() => {
  scene.card = { cardId: "T-001", name: "Card One" };
  detected.box = "card";
  clock = 1_000;
  toWorker = [];
  toContent = [];
  session = new HostLike({
    now: () => clock,
    toWorker: (request, transfer) => toWorker.push({ request, transfer }),
    toContent: (m) => toContent.push(m),
    hoverAt: hit as never,
  });
});

describe("HostSession", () => {
  it("reports the release status to the content script", () => {
    ready();
    expect(toContent[0]).toEqual({ kind: "status", state: "ready", error: null, backend: "wasm" });
    session.fromWorker({ kind: "release-status", ok: false, error: "release: HTTP 404", release: null, cards: [] });
    expect(toContent[1]).toEqual({ kind: "status", state: "failed", error: "release: HTTP 404", backend: "wasm" });
  });

  it("asks for nothing before the release has loaded", () => {
    session.fromContent({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false });
    clock += 2000;
    session.tick();
    expect(captures()).toEqual([]);
  });

  it("asks for a picture when the pointer moves over a stale picture, at the release's analysis width", () => {
    ready();
    session.fromContent({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false });
    expect(captures()).toEqual([{ kind: "capture", requestId: 1, analysisWidth: { min: 720, max: 1920 } }]);
  });

  it("transfers the captured picture to the worker with its envelope", () => {
    ready();
    session.fromContent({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1.5, touch: false });
    const b = bitmap();
    session.fromContent({ kind: "frame", requestId: 1, bitmap: b, mediaTime: 1.5 });
    expect(toWorker).toHaveLength(1);
    expect(toWorker[0]!.request).toEqual({ kind: "frame", bitmap: b, videoTimeSec: 1.5, envelope: { requestId: 1, mediaTimeSec: 1.5, generation: 0, videoKey: "source-0" } });
    expect(toWorker[0]!.transfer).toEqual([b]);
  });

  it("closes a picture it did not ask for", () => {
    ready();
    const b = bitmap();
    session.fromContent({ kind: "frame", requestId: 9, bitmap: b, mediaTime: 1 });
    expect(b.closed).toBe(true);
    expect(toWorker).toEqual([]);
  });

  it("names the card under the pointer, with its box in fractions of the frame", () => {
    ready();
    analyzeAt(0.2, 0.5);
    expect(lastShown()).toMatchObject({ cardId: "T-001", name: "Card One", box: { x: 0.1, y: 0.2, width: 0.2, height: 0.6 } });
    session.fromContent({ kind: "pointer", x: 0.8, y: 0.5, mediaTime: 1, touch: false });
    expect(lastShown()).toBeNull();
    session.fromContent({ kind: "pointer", x: 0.25, y: 0.5, mediaTime: 1, touch: false });
    expect(lastShown()?.cardId).toBe("T-001");
  });

  it("does not repeat an unchanged answer", () => {
    ready();
    analyzeAt(0.2, 0.5);
    const n = shownMessages().length;
    session.fromContent({ kind: "pointer", x: 0.21, y: 0.5, mediaTime: 1, touch: false });
    expect(shownMessages().length).toBe(n);
  });

  it("clears the answer when the pointer leaves", () => {
    ready();
    analyzeAt(0.2, 0.5);
    session.fromContent({ kind: "leave" });
    expect(lastShown()).toBeNull();
  });

  it("shows nothing for a reply from before a seek", () => {
    ready();
    session.fromContent({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false });
    session.fromContent({ kind: "frame", requestId: 1, bitmap: bitmap(), mediaTime: 1 });
    session.fromContent({ kind: "discontinuity", newSource: false });
    session.fromWorker(reply(toWorker[0]!.request));
    expect(lastShown()).toBeNull();
    // The request is finished: the next one can go, and the seek made the picture stale.
    clock += 300;
    session.fromContent({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false });
    expect(captures().length).toBe(2);
  });

  it("clears what is shown on a new source", () => {
    ready();
    analyzeAt(0.2, 0.5);
    session.fromContent({ kind: "discontinuity", newSource: true });
    expect(lastShown()).toBeNull();
  });

  it("holds a card past hover.maxAgeMs only briefly, and then shows nothing", () => {
    ready();
    analyzeAt(0.2, 0.5, 1);
    session.fromContent({ kind: "presented", mediaTime: 2.9 });
    expect(session.fresh()?.cardId).toBe("T-001");
    session.fromContent({ kind: "presented", mediaTime: 3.1 });
    // The result is too old to name anything itself; the shown card is held until the next
    // analysis, at most SHOWN_HOLD.maxMs.
    expect(session.fresh()).toBeNull();
    expect(lastShown()?.cardId).toBe("T-001");
    clock += SHOWN_HOLD.maxMs;
    session.fromContent({ kind: "presented", mediaTime: 3.2 });
    expect(lastShown()).toBeNull();
  });

  it("shows nothing when the worker could not analyze the frame", () => {
    ready();
    session.fromContent({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false });
    session.fromContent({ kind: "frame", requestId: 1, bitmap: bitmap(), mediaTime: 1 });
    session.fromWorker(reply(toWorker[0]!.request, { analysis: null, error: "busy" }));
    expect(lastShown()).toBeNull();
    expect(session.lastFrameError).toBe("busy");
  });

  it("keeps one request in flight, and gives up on it after the watchdog", () => {
    ready();
    session.fromContent({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false });
    clock += 600;
    session.fromContent({ kind: "pointer", x: 0.3, y: 0.5, mediaTime: 5, touch: false });
    session.tick();
    expect(captures().length).toBe(1);
    // The first look waits FIRST_ANALYSIS_WATCHDOG_MS (no analysis yet since the release loaded).
    clock += ANALYSIS_WATCHDOG_MS + 1;
    session.tick();
    expect(session.lastFrameError).toBeNull();
    clock += FIRST_ANALYSIS_WATCHDOG_MS - ANALYSIS_WATCHDOG_MS;
    // A move just before the give-up, so the pointer is not at rest (POINTER_GRACE_MS).
    session.fromContent({ kind: "pointer", x: 0.31, y: 0.5, mediaTime: 5, touch: false });
    session.tick();
    expect(session.lastFrameError).toBe("no reply");
    // Changed from the product test (2 in the same tick): the given-up look drops the still
    // picture's other repeats (one back-off counter, the scheduler's), so the next look is the
    // retry, one back-off later.
    expect(captures().length).toBe(1);
    clock += LOOK_RETRY_MS[0]!;
    session.tick();
    expect(captures().length).toBe(2);
    // The late picture of the first request is dropped, never analyzed.
    const late = bitmap();
    session.fromContent({ kind: "frame", requestId: 1, bitmap: late, mediaTime: 1 });
    expect(late.closed).toBe(true);
  });

  it("frees the request when the picture could not be read", () => {
    ready();
    session.fromContent({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false });
    session.fromContent({ kind: "capture-failed", requestId: 1, reason: "the video may not be read" });
    expect(session.lastFrameError).toBe("capture-failed: the video may not be read");
    // The still picture is looked at again on the next tick.
    clock += 300;
    session.tick();
    expect(captures().length).toBe(2);
  });

  /** The content script's answer when the picture itself could not be had. */
  const noPicture = (requestId = captures().at(-1)!.requestId) =>
    session.fromContent({ kind: "capture-failed", requestId, reason: "no picture", retry: true });
  const at = (ms: number) => {
    clock += ms;
    session.tick();
  };

  it("keeps trying a paused video whose picture is not ready, with a back-off", () => {
    ready();
    session.fromContent({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false });
    noPicture();
    // Exhaust the scheduler's own repeats (before the fix the video then stalled for good).
    for (let i = 0; i < 4; i += 1) {
      const n = captures().length;
      at(260);
      if (captures().length > n) noPicture();
    }
    // Retries keep coming on the back-off (at most 2 s apart) while the pointer moved recently.
    const n = captures().length;
    for (let i = 0; i < 40; i += 1) {
      const before = captures().length;
      at(100);
      if (captures().length > before) noPicture();
    }
    expect(captures().length - n).toBeGreaterThanOrEqual(2);
    expect(LOOK_RETRY_MS.at(-1)).toBe(2_000);
    // When the video becomes readable, the picture is analyzed and named.
    at(2_010);
    const capture = captures().at(-1)!;
    session.fromContent({ kind: "frame", requestId: capture.requestId, bitmap: bitmap(), mediaTime: 1 });
    session.fromWorker(reply(toWorker.at(-1)!.request));
    expect(lastShown()?.cardId).toBe("T-001");
  });

  it("does not retry a refusal that is not about the picture", () => {
    ready();
    session.fromContent({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false });
    session.fromContent({ kind: "capture-failed", requestId: 1, reason: "no pointer over the player", retry: false });
    // Past the scheduler's own repeats, nothing more is asked.
    for (let i = 0; i < 6; i += 1) {
      const n = captures().length;
      at(260);
      if (captures().length > n) session.fromContent({ kind: "capture-failed", requestId: captures().at(-1)!.requestId, reason: "no pointer over the player", retry: false });
    }
    const n = captures().length;
    for (let i = 0; i < 10; i += 1) at(1_000);
    expect(captures().length).toBe(n);
  });

  it("stops retrying once the pointer has rested for the grace period", () => {
    ready();
    session.fromContent({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false });
    noPicture();
    for (let i = 0; i < 12; i += 1) {
      const n = captures().length;
      at(1_000);
      if (captures().length > n) noPicture();
    }
    const n = captures().length;
    for (let i = 0; i < 10; i += 1) at(2_000);
    expect(captures().length).toBe(n);
    // Moving the pointer again asks once more.
    session.fromContent({ kind: "pointer", x: 0.21, y: 0.5, mediaTime: 1, touch: false });
    at(260);
    expect(captures().length).toBeGreaterThan(n);
  });

  it("stops trying when the pointer leaves, and starts the back-off over on a seek", () => {
    ready();
    session.fromContent({ kind: "pointer", x: 0.2, y: 0.5, mediaTime: 1, touch: false });
    noPicture(1);
    session.fromContent({ kind: "leave" });
    for (let i = 0; i < 12; i += 1) at(1_000);
    const n = captures().length;
    for (let i = 0; i < 20; i += 1) at(1_000);
    expect(captures().length).toBe(n);
  });

  it("goes idle 10 s after the last pointer activity when nothing is shown", () => {
    ready();
    session.fromContent({ kind: "pointer", x: 0.8, y: 0.5, mediaTime: 1, touch: false });
    session.fromContent({ kind: "frame", requestId: 1, bitmap: bitmap(), mediaTime: 1 });
    session.fromWorker(reply(toWorker[0]!.request));
    const before = captures().length;
    for (let t = 0; t < 30; t += 1) {
      clock += 1000;
      session.fromContent({ kind: "presented", mediaTime: 1 + t + 1 });
      session.tick();
    }
    const during = captures().length - before;
    expect(session.scheduler.analysisState(clock)).toBe("idle");
    const idleSince = captures().length;
    for (let t = 0; t < 10; t += 1) {
      clock += 1000;
      session.fromContent({ kind: "presented", mediaTime: 40 + t });
      session.tick();
    }
    expect(captures().length).toBe(idleSince);
    expect(during).toBeGreaterThan(0);
  });
});

describe("HostSession and the geometric stage", () => {
  it("records the stage's state and passes it on, without touching what is shown", () => {
    const seen: unknown[] = [];
    const s = new HostLike({ now: () => 0, toWorker: () => undefined, toContent: (m) => toContent.push(m), onGeometricStatus: (g) => seen.push(g) });
    toContent = [];
    s.fromWorker({ kind: "geometric-status", state: "loading", reason: null, bytes: null });
    s.fromWorker({ kind: "geometric-status", state: "off", reason: "no-webgpu", bytes: null });
    // The status's geometric field also carries the index size (null here).
    expect(s.geometric).toEqual({ state: "off", reason: "no-webgpu", bytes: null });
    expect(seen).toHaveLength(2);
    expect(toContent).toEqual([]);
  });
});

describe("HostSession without an onGeometricStatus hook", () => {
  it("ignores a geometric-status reply, without touching what is shown", () => {
    const s = new HostLike({ now: () => 0, toWorker: () => undefined, toContent: (m) => toContent.push(m) });
    toContent = [];
    s.fromWorker({ kind: "geometric-status", state: "off", reason: "no-webgpu", bytes: null });
    expect(toContent).toEqual([]);
  });
});

describe("HostSession hysteresis (a live stream)", () => {
  /** One more analysis of the picture, as the scheduler would start it. */
  function analyzeAgain(mediaTime: number): void {
    const n = captures().length;
    // At the slow cadence of a resting pointer (2 s on WebAssembly), the gap that used to blink.
    clock += 2100;
    session.fromContent({ kind: "presented", mediaTime });
    session.tick();
    expect(captures().length).toBe(n + 1);
    const capture = captures().at(-1)!;
    session.fromContent({ kind: "frame", requestId: capture.requestId, bitmap: bitmap(), mediaTime });
    session.fromWorker(reply(toWorker.at(-1)!.request));
  }

  it("does not hide on a single analysis with nothing there; hides after SHOWN_HOLD.misses in a row", () => {
    ready();
    analyzeAt(0.2, 0.5, 1);
    expect(lastShown()?.cardId).toBe("T-001");
    scene.card = null;
    analyzeAgain(1.3);
    expect(lastShown()?.cardId).toBe("T-001");
    for (let i = 1; i < SHOWN_HOLD.misses; i += 1) analyzeAgain(1.3 + i * 0.3);
    expect(lastShown()).toBeNull();
  });

  it("does not count a reply that analyzed nothing as a miss", () => {
    ready();
    analyzeAt(0.2, 0.5, 1);
    for (let i = 0; i < SHOWN_HOLD.misses; i += 1) {
      clock += 1000;
      session.fromContent({ kind: "presented", mediaTime: 1.3 + i * 0.3 });
      session.tick();
      const capture = captures().at(-1)!;
      session.fromContent({ kind: "frame", requestId: capture.requestId, bitmap: bitmap(), mediaTime: 1.3 + i * 0.3 });
      session.fromWorker(reply(toWorker.at(-1)!.request, { analysis: null, error: "busy" }));
    }
    expect(lastShown()?.cardId).toBe("T-001");
  });

  it("does not count a slow analysis that comes back older than hover.maxAgeMs as a miss", () => {
    ready();
    analyzeAt(0.2, 0.5, 1);
    let t = 1;
    for (let i = 0; i < SHOWN_HOLD.misses; i += 1) {
      const n = captures().length;
      clock += 2100;
      t += 0.3;
      session.fromContent({ kind: "presented", mediaTime: t });
      session.tick();
      expect(captures().length).toBe(n + 1);
      const capture = captures().at(-1)!;
      session.fromContent({ kind: "frame", requestId: capture.requestId, bitmap: bitmap(), mediaTime: t });
      // The video plays on while the worker is slow: the card's analysis is too old to show itself.
      t += 2.2;
      session.fromContent({ kind: "presented", mediaTime: t });
      session.fromWorker(reply(toWorker.at(-1)!.request));
      expect(session.fresh()).toBeNull();
    }
    expect(lastShown()?.cardId).toBe("T-001");
    // Still bounded by SHOWN_HOLD.maxMs with no analysis seeing it.
    clock += SHOWN_HOLD.maxMs;
    session.tick();
    expect(lastShown()).toBeNull();
  });

  it("hides once no analysis has seen the card for SHOWN_HOLD.maxMs", () => {
    ready();
    analyzeAt(0.2, 0.5, 1);
    scene.card = null;
    analyzeAgain(1.3);
    expect(lastShown()?.cardId).toBe("T-001");
    clock += SHOWN_HOLD.maxMs;
    session.tick();
    expect(lastShown()).toBeNull();
  });

  it("never flickers when acceptance toggles from one analysis to the next", () => {
    ready();
    analyzeAt(0.2, 0.5, 1);
    const before = shownMessages().length;
    for (let i = 0; i < 10; i += 1) {
      scene.card = i % 2 ? { cardId: "T-001", name: "Card One" } : null;
      analyzeAgain(1.3 + i * 0.3);
    }
    expect(shownMessages().slice(before).filter((m) => m.card === null)).toEqual([]);
    expect(lastShown()?.cardId).toBe("T-001");
  });

  it("replaces the card at once when another one is accepted there", () => {
    ready();
    analyzeAt(0.2, 0.5, 1);
    scene.card = { cardId: "T-002", name: "Card Two" };
    analyzeAgain(1.3);
    expect(lastShown()?.cardId).toBe("T-002");
  });

  it("ends at once when the pointer leaves the shown card's box", () => {
    ready();
    analyzeAt(0.2, 0.5, 1);
    scene.card = null;
    analyzeAgain(1.3);
    expect(lastShown()?.cardId).toBe("T-001");
    session.fromContent({ kind: "pointer", x: 0.8, y: 0.5, mediaTime: 1.3, touch: false });
    expect(lastShown()).toBeNull();
  });

  it("drops the hold at once when another box is detected at the pointer", () => {
    ready();
    analyzeAt(0.2, 0.5, 1);
    scene.card = null;
    detected.box = "other";
    analyzeAgain(1.3);
    expect(lastShown()).toBeNull();
  });

  it("counts no box at the pointer as a miss: held once, gone after SHOWN_HOLD.misses", () => {
    ready();
    analyzeAt(0.2, 0.5, 1);
    scene.card = null;
    detected.box = "none";
    analyzeAgain(1.3);
    expect(lastShown()?.cardId).toBe("T-001");
    for (let i = 1; i < SHOWN_HOLD.misses; i += 1) analyzeAgain(1.3 + i * 0.3);
    expect(lastShown()).toBeNull();
  });

  it("holds while the same box is detected there but not accepted this time", () => {
    ready();
    analyzeAt(0.2, 0.5, 1);
    scene.card = null;
    detected.box = "card";
    analyzeAgain(1.3);
    expect(lastShown()?.cardId).toBe("T-001");
  });

  it("ends at once on a seek", () => {
    ready();
    analyzeAt(0.2, 0.5, 1);
    session.fromContent({ kind: "discontinuity", newSource: false });
    expect(lastShown()).toBeNull();
  });
});

describe("HostSession on a paused video when the first analysis is slow", () => {
  /** The pointer moves over the paused picture (video time 3 s) and the session runs a tick. */
  const wiggle = (i: number) => {
    session.fromContent({ kind: "pointer", x: 0.2 + (i % 2) * 0.001, y: 0.5, mediaTime: 3, touch: false });
    session.tick();
  };
  /** Hands the worker the picture of the newest capture, if it was not handed over yet. */
  const handOver = (): WorkerRequest | null => {
    const capture = captures().at(-1);
    if (!capture || toWorker.some((w) => w.request.kind === "frame" && w.request.envelope.requestId === capture.requestId)) return null;
    session.fromContent({ kind: "frame", requestId: capture.requestId, bitmap: bitmap(), mediaTime: 3 });
    return toWorker.at(-1)!.request;
  };

  it("looks again after busy answers and a late answer, and shows the card", () => {
    ready();
    session.fromContent({ kind: "presented", mediaTime: 3 });
    // The worker takes 18 s for the first picture (past FIRST_ANALYSIS_WATCHDOG_MS); each picture
    // sent meanwhile is answered busy.
    let slow: WorkerRequest | null = null;
    let busyUntil = 0;
    for (let i = 0; i < 100; i += 1) {
      wiggle(i);
      const sent = handOver();
      if (sent && slow === null) {
        slow = sent;
        busyUntil = clock + 18_000;
      } else if (sent && clock < busyUntil) {
        session.fromWorker(reply(sent, { analysis: null as never, error: "busy" }));
      } else if (sent) {
        session.fromWorker(reply(sent));
      }
      if (slow && clock >= busyUntil && busyUntil > 0) {
        // The slow answer arrives after the session gave up on it, and is dropped.
        session.fromWorker(reply(slow));
        busyUntil = 0;
      }
      clock += 250;
    }
    expect(toWorker.filter((w) => w.request.kind === "frame").length).toBeGreaterThan(3);
    expect(session.framesAnalyzed).toBeGreaterThan(0);
    expect(lastShown()).toMatchObject({ cardId: "T-001" });
  });

  it("backs off between looks while the worker stays busy", () => {
    ready();
    session.fromContent({ kind: "presented", mediaTime: 3 });
    const sentAt: number[] = [];
    for (let i = 0; i < 120; i += 1) {
      wiggle(i);
      const sent = handOver();
      if (sent) {
        sentAt.push(clock);
        // The first picture never comes back; every later one is answered busy.
        if (sentAt.length > 1) session.fromWorker(reply(sent, { analysis: null as never, error: "busy" }));
      }
      clock += 250;
    }
    const gaps = sentAt.slice(1).map((t, i) => t - sentAt[i]!);
    // Each retry gives the still picture its usual looks a tick apart, then waits 2 s: about
    // one look a second while the worker is busy, not one every tick.
    expect(Math.max(...gaps.slice(-3))).toBeGreaterThanOrEqual(2_000);
    const lastTen = sentAt.filter((t) => t > clock - 10_000).length;
    expect(lastTen).toBeGreaterThan(0);
    expect(lastTen).toBeLessThanOrEqual(15);
  });

  it("looks again when the pointer leaves during the retries and comes back", () => {
    ready();
    session.fromContent({ kind: "presented", mediaTime: 3 });
    // The first picture is slow: given up on at FIRST_ANALYSIS_WATCHDOG_MS, then the still picture's
    // other looks are answered busy.
    let slow: WorkerRequest | null = null;
    let busy = 0;
    for (let i = 0; busy < 2; i += 1) {
      wiggle(i);
      const sent = handOver();
      if (sent && slow === null) slow = sent;
      else if (sent) {
        session.fromWorker(reply(sent, { analysis: null as never, error: "busy" }));
        busy += 1;
      }
      clock += 250;
    }
    // The slow answer comes late and is dropped; the pointer leaves, then comes back.
    session.fromWorker(reply(slow!));
    expect(session.framesAnalyzed).toBe(0);
    session.fromContent({ kind: "leave" });
    clock += 3_000;
    session.tick();
    let shown = false;
    for (let i = 0; i < 12 && !shown; i += 1) {
      wiggle(i);
      const sent = handOver();
      if (sent) session.fromWorker(reply(sent));
      shown = lastShown()?.cardId === "T-001";
      clock += 250;
    }
    expect(shown).toBe(true);
  });

  it("looks again when the pointer leaves after failed captures and comes back (only the captures asked after the return are answered)", () => {
    ready();
    session.fromContent({ kind: "presented", mediaTime: 3 });
    // Every capture fails for want of a picture until the still picture's looks are used up.
    let failed = 0;
    for (let i = 0; i < 40; i += 1) {
      wiggle(i);
      const capture = captures().at(-1);
      if (capture && capture.requestId > failed) {
        session.fromContent({ kind: "capture-failed", requestId: capture.requestId, reason: "no picture", retry: true });
        failed = capture.requestId;
      }
      clock += 250;
    }
    expect(failed).toBeGreaterThan(0);
    session.fromContent({ kind: "leave" });
    clock += 3_000;
    session.tick();
    const lastFailed = failed;
    let shown = false;
    for (let i = 0; i < 12 && !shown; i += 1) {
      wiggle(i);
      const capture = captures().at(-1);
      if (capture && capture.requestId > lastFailed) {
        const sent = handOver();
        if (sent) session.fromWorker(reply(sent));
      }
      shown = lastShown()?.cardId === "T-001";
      clock += 250;
    }
    expect(shown).toBe(true);
  });

  it("stops looking once the pointer has rested past the grace period, and starts again when it moves", () => {
    ready();
    session.fromContent({ kind: "presented", mediaTime: 3 });
    wiggle(0);
    const first = handOver()!;
    clock += FIRST_ANALYSIS_WATCHDOG_MS + 1;
    session.tick();
    expect(session.lastFrameError).toBe("no reply");
    // The pointer rests: no move for a long time.
    for (let i = 0; i < 200; i += 1) {
      clock += 250;
      session.tick();
      const sent = handOver();
      if (sent) session.fromWorker(reply(sent, { analysis: null as never, error: "busy" }));
    }
    const before = captures().length;
    for (let i = 0; i < 40; i += 1) {
      clock += 250;
      session.tick();
    }
    expect(captures().length).toBe(before);
    session.fromWorker(reply(first));
    wiggle(1);
    clock += 250;
    session.tick();
    const sent = handOver();
    expect(sent).not.toBeNull();
    session.fromWorker(reply(sent!));
    expect(lastShown()).toMatchObject({ cardId: "T-001" });
  });

  it("looks again when the pointer leaves after failed captures and comes back", () => {
    ready();
    session.fromContent({ kind: "presented", mediaTime: 3 });
    // Every capture fails for want of a picture until the pointer leaves.
    const failed = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      wiggle(i);
      const c = captures().at(-1);
      if (c && !failed.has(c.requestId)) {
        failed.add(c.requestId);
        session.fromContent({ kind: "capture-failed", requestId: c.requestId, reason: "no picture", retry: true });
      }
      clock += 250;
    }
    session.fromContent({ kind: "leave" });
    clock += 3_000;
    session.tick();
    // Added to the product test: analysis runs through the grace period after the pointer leaves,
    // so the retry may ask for a capture while the pointer is outside; the content script's gate
    // refuses it, as it would.
    const outside = captures().at(-1)!;
    if (!failed.has(outside.requestId)) session.fromContent({ kind: "capture-failed", requestId: outside.requestId, reason: "no pointer over the player", retry: false });
    const before = captures().length;
    let shown = false;
    for (let i = 0; i < 12 && !shown; i += 1) {
      wiggle(i);
      const sent = captures().length > before ? handOver() : null;
      if (sent) session.fromWorker(reply(sent));
      shown = lastShown()?.cardId === "T-001";
      clock += 250;
    }
    expect(shown).toBe(true);
  });
});

// ---------------------------------------------------------------------------- the core itself

/** A core driven directly, with the stand-in hit test and recorders for every output. */
function directCore(options: SessionCoreOptions = {}, extra: Pick<SessionCoreDeps, "mediaTimeNow"> = {}) {
  const out = {
    captures: [] as Array<{ requestId: number; at: number; analysisWidth: AnalysisWidth }>,
    requests: [] as Array<{ request: WorkerRequest; transfer?: Transferable[] }>,
    shown: [] as Array<Shown | null>,
    statuses: [] as SessionStatus[],
    geometric: [] as GeometricStatus[],
  };
  const core = new SessionCore(
    {
      now: () => clock,
      toWorker: (request, transfer) => out.requests.push({ request, ...(transfer ? { transfer } : {}) }),
      capture: (requestId, analysisWidth) => out.captures.push({ requestId, at: clock, analysisWidth }),
      onShown: (card) => out.shown.push(card),
      onStatus: (s) => out.statuses.push(s),
      onGeometricStatus: (g) => out.geometric.push(g),
      hoverAt: hit as never,
      ...extra,
    },
    options,
  );
  const ready = () => core.fromWorker({ kind: "release-status", ok: true, error: null, release, cards: [] });
  /** Answers the newest capture with a picture and the worker's analysis of it. */
  const answer = (mediaTime = 1, result: Partial<FrameResult> = {}) => {
    const c = out.captures.at(-1)!;
    core.frame(c.requestId, bitmap(), mediaTime);
    core.fromWorker(reply(out.requests.at(-1)!.request, result));
  };
  return { core, out, ready, answer };
}

describe("SessionCore: a capture refused while the pointer was outside", () => {
  it("looks again when the pointer returns over the paused picture, and shows the card", () => {
    const { core, out, ready, answer } = directCore({ hold: SHOWN_HOLD });
    ready();
    core.presented(3);
    // The pointer moves over the paused picture; every capture fails for want of a picture.
    for (let i = 0; i < 8; i += 1) {
      core.pointer(0.2 + (i % 2) * 0.001, 0.5, 3);
      core.tick();
      const c = out.captures.at(-1);
      if (c && c.at === clock) core.captureFailed(c.requestId, "no picture", true);
      clock += 250;
    }
    const failedSoFar = out.captures.length;
    expect(failedSoFar).toBeGreaterThan(0);
    core.pointerLeft();
    // Outside, analysis still runs (the grace period of the leave): the retry asks for a capture,
    // and the content script's gate refuses it. So are the looks that follow it.
    let refused = 0;
    for (let i = 0; i < 16; i += 1) {
      clock += 250;
      core.tick();
      const c = out.captures.at(-1)!;
      if (out.captures.length > failedSoFar && c.at === clock) {
        core.captureFailed(c.requestId, "no pointer over the player", false);
        refused += 1;
      }
    }
    expect(refused).toBeGreaterThan(0);
    const beforeReturn = out.captures.length;
    // Nothing more is asked while the pointer stays outside.
    for (let i = 0; i < 4; i += 1) {
      clock += 250;
      core.tick();
    }
    expect(out.captures.length).toBe(beforeReturn);
    // The pointer comes back over the paused picture (nothing presented, nothing stale).
    core.pointer(0.2, 0.5, 3);
    core.tick();
    expect(out.captures.length).toBe(beforeReturn + 1);
    answer(3);
    expect(out.shown.at(-1)?.cardId).toBe("T-001");
  });
});

/**
 * The session loop of scheduler.test.ts (`pausedWithSlowFirstLook`, pictures received) driven
 * through the core: a paused picture under a moving pointer, a tick every DRIVER_TICK_MS, a page
 * that answers every capture at once, and a worker that takes `firstMs` for the first picture and
 * 100 ms for later ones, answering "busy" while it works.
 */
function slowFirstLookThroughCore(firstMs: number, endMs: number): { sent: number[]; analyzed: number[] } {
  const sent: number[] = [];
  const analyzed: number[] = [];
  let workerFreeAt = -Infinity;
  let pictures = 0;
  const replies: Array<{ at: number; reply: FrameResult }> = [];
  const worker = (request: WorkerRequest): void => {
    if (request.kind !== "frame") return;
    const t = clock;
    const base = { kind: "frame-result" as const, envelope: request.envelope, videoTimeSec: request.videoTimeSec, width: 1000, height: 500, workerMs: 5 };
    if (t < workerFreeAt) {
      replies.push({ at: t, reply: { ...base, analysis: null, error: "busy" } });
    } else {
      pictures += 1;
      workerFreeAt = t + (pictures === 1 ? firstMs : 100);
      replies.push({ at: workerFreeAt, reply: { ...base, analysis: analysisNow() } });
    }
  };
  const pending: number[] = [];
  const core = new SessionCore({
    now: () => clock,
    toWorker: worker,
    capture: (requestId) => {
      sent.push(clock);
      pending.push(requestId);
    },
    hoverAt: hit as never,
  });
  const answerCaptures = () => {
    while (pending.length) core.frame(pending.shift()!, bitmap(), 3);
  };
  clock = 0;
  core.fromWorker({ kind: "release-status", ok: true, error: null, release, cards: [] });
  for (let t = 0; t <= endMs; t += DRIVER_TICK_MS) {
    clock = t;
    // Replies due by now, all sent before this tick (as the scheduler's loop delivers them).
    for (let i = 0; i < replies.length; ) {
      if (replies[i]!.at <= t) {
        const { reply } = replies.splice(i, 1)[0]!;
        const before = core.status().frames;
        core.fromWorker(reply);
        if (core.status().frames > before) analyzed.push(t);
      } else i += 1;
    }
    core.pointer(0.2, 0.5, 3);
    answerCaptures();
    core.tick();
    answerCaptures();
  }
  return { sent, analyzed };
}

describe("SessionCore reproduces the scheduler's session loop", () => {
  // The same times as scheduler.test.ts (PINNED_SLOW_FIRST_LOOK).
  it("a first look of 6 s", () => {
    expect(slowFirstLookThroughCore(6_000, 20_000)).toEqual({ sent: [0, 6_000, 6_250], analyzed: [6_000, 6_250, 6_500] });
  });

  it("a first look of 12 s", () => {
    expect(slowFirstLookThroughCore(12_000, 20_000)).toEqual({ sent: [0, 12_000, 12_250], analyzed: [12_000, 12_250, 12_500] });
  });

  it("a first look of 18 s, given up on at FIRST_ANALYSIS_WATCHDOG_MS", () => {
    expect(slowFirstLookThroughCore(18_000, 30_000)).toEqual({
      sent: [0, 15_250, 16_250, 17_500, 19_750, 20_000, 20_250],
      analyzed: [20_000, 20_250, 20_500],
    });
  });
});

describe("SessionCore modes and options", () => {
  it("always-on needs no pointer", () => {
    const { core, out, ready } = directCore({ mode: "always-on" });
    ready();
    core.tick();
    expect(out.captures).toHaveLength(1);
    expect(core.status().schedule).toBe("always-on");
  });

  it("pointer mode asks for nothing without a pointer", () => {
    const { core, out, ready } = directCore();
    ready();
    for (let i = 0; i < 8; i += 1) {
      clock += 250;
      core.presented(1 + i);
      core.tick();
    }
    expect(out.captures).toEqual([]);
  });

  it("without a hold, what is shown is the newest result at the pointer: no hysteresis", () => {
    const { core, out, ready, answer } = directCore();
    ready();
    core.pointer(0.2, 0.5, 1);
    answer(1);
    expect(out.shown.at(-1)).toMatchObject({ cardId: "T-001", box: { x: 0.1, y: 0.2, width: 0.2, height: 0.6 }, frameBox: { x: 100, y: 100, width: 200, height: 300 } });
    // One analysis with nothing named there hides it at once (a hold would keep it).
    scene.card = null;
    clock += 2_100;
    core.presented(1.3);
    core.tick();
    answer(1.3);
    expect(out.shown.at(-1)).toBeNull();
    expect(core.shown()).toBeNull();
  });

  it("without a hold, the card shown is hitAt at the pointer, and too old a result names nothing", () => {
    const { core, ready, answer } = directCore();
    ready();
    core.pointer(0.2, 0.5, 1);
    answer(1);
    expect(core.shown()).toEqual(core.hitAt(0.2, 0.5));
    // Any position, as createSession's at() answers it: in the box, outside it, not a number.
    expect(core.hitAt(0.29, 0.79)?.cardId).toBe("T-001");
    expect(core.hitAt(0.31, 0.5)).toBeNull();
    expect(core.hitAt(Number.NaN, 0.5)).toBeNull();
    core.presented(1 + release.hoverMaxAgeMs / 1000 + 0.01);
    expect([core.hitAt(0.2, 0.5), core.shown(), core.analysis()]).toEqual([null, null, null]);
  });

  it("the hold is off by default and SHOWN_HOLD is 2 misses, 5 s, an overlap of one half", () => {
    expect(SHOWN_HOLD).toEqual({ misses: 2, maxMs: 5_000, sameBoxIou: 0.5 });
    expect(Object.isFrozen(SHOWN_HOLD)).toBe(true);
  });

  it("a geometric stage asked for starts as loading; its reports reach the status and the hook", () => {
    const { core, out } = directCore({ geometric: true });
    expect(core.status().geometric).toEqual({ state: "loading", reason: null, bytes: null });
    core.fromWorker({ kind: "geometric-status", state: "ready", reason: null, bytes: 1234 });
    expect(core.status().geometric).toEqual({ state: "ready", reason: null, bytes: 1234 });
    expect(out.geometric).toHaveLength(1);
    expect(out.statuses.at(-1)?.geometric).toEqual({ state: "ready", reason: null, bytes: 1234 });
    expect(directCore().core.status().geometric).toBeNull();
  });
});

describe("SessionCore status", () => {
  it("has createSession's shape and is reported on every change", () => {
    const { core, out, ready, answer } = directCore();
    expect(core.status()).toEqual({
      state: "loading", error: null, release: null, backend: null, schedule: "idle", frames: 0,
      lastWorkerMs: null, lastRoundTripMs: null, lastFrameError: null, geometric: null, loading: null,
    });
    core.fromWorker({ kind: "release-progress", phase: "downloading", bytes: 10 });
    expect(out.statuses.at(-1)?.loading).toEqual({ phase: "downloading", bytes: 10 });
    const n = out.statuses.length;
    core.fromWorker({ kind: "release-progress", phase: "downloading", bytes: 10 });
    expect(out.statuses.length).toBe(n);
    ready();
    expect(out.statuses.at(-1)).toMatchObject({ state: "ready", loading: null, backend: "wasm", release: { id: "r" } });
    // A late progress reply changes nothing once loaded.
    core.fromWorker({ kind: "release-progress", phase: "preparing", bytes: null });
    expect(core.status().loading).toBeNull();
    core.pointer(0.2, 0.5, 1);
    expect(out.statuses.at(-1)?.schedule).toBe("fast");
    clock += 40;
    answer(1);
    expect(out.statuses.at(-1)).toMatchObject({ frames: 1, lastWorkerMs: 5, lastRoundTripMs: 40, lastFrameError: null });
    clock += POINTER_GRACE_MS;
    core.tick();
    expect(out.statuses.at(-1)?.schedule).not.toBe("fast");
  });

  it("stop ends everything: nothing is asked or shown, a late picture is closed", () => {
    const { core, out, ready, answer } = directCore();
    ready();
    core.pointer(0.2, 0.5, 1);
    answer(1);
    expect(out.shown.at(-1)?.cardId).toBe("T-001");
    core.pointer(0.21, 0.5, 5);
    const c = out.captures.at(-1)!;
    core.stop();
    expect(out.shown.at(-1)).toBeNull();
    expect(core.status()).toMatchObject({ state: "stopped", loading: null });
    const late = bitmap();
    core.frame(c.requestId, late, 5);
    expect(late.closed).toBe(true);
    const n = out.captures.length;
    for (let i = 0; i < 8; i += 1) {
      clock += 1_000;
      core.pointer(0.2, 0.5, 6 + i);
      core.tick();
    }
    expect(out.captures.length).toBe(n);
  });
});

describe("SessionCore looks", () => {
  it("a cut clears what is shown and looks again at once, whatever the cadence", () => {
    const { core, out, ready, answer } = directCore();
    ready();
    core.pointer(0.2, 0.5, 1);
    answer(1);
    const n = out.captures.length;
    clock += 10;
    core.cut();
    expect(out.shown.at(-1)).toBeNull();
    core.tick();
    expect(out.captures.length).toBe(n + 1);
    expect(core.scheduler.lastTrigger).toBe("cut");
  });

  it("a capture failure for another request, or after the picture arrived, changes nothing", () => {
    const { core, out, ready } = directCore();
    ready();
    core.pointer(0.2, 0.5, 1);
    const c = out.captures.at(-1)!;
    core.captureFailed(c.requestId + 1, "no picture", true);
    core.frame(c.requestId, bitmap(), 1);
    core.captureFailed(c.requestId, "no picture", true);
    expect(core.status().lastFrameError).toBeNull();
    expect(out.requests).toHaveLength(1);
    expect(out.requests[0]!.transfer).toHaveLength(1);
  });

  it("a picture for a capture that failed is closed, never analyzed", () => {
    const { core, out, ready } = directCore();
    ready();
    core.pointer(0.2, 0.5, 1);
    const c = out.captures.at(-1)!;
    core.captureFailed(c.requestId, "no picture", true);
    const late = bitmap();
    core.frame(c.requestId, late, 1);
    expect(late.closed).toBe(true);
    expect(out.requests).toEqual([]);
  });

  it("a failed capture is retried after the first back-off, not at the cadence", () => {
    const { core, out, ready } = directCore();
    ready();
    core.pointer(0.2, 0.5, 1);
    core.tick();
    // Use up the still picture's repeats with failures that are not about the picture.
    for (let i = 0; i < 3; i += 1) {
      const c = out.captures.at(-1)!;
      core.captureFailed(c.requestId, i < 2 ? "refused" : "no picture", i === 2);
      clock += 250;
      core.tick();
    }
    const failedAt = clock - 250;
    expect(out.captures.at(-1)!.at).toBe(failedAt + LOOK_RETRY_MS[0]!);
  });

  it("the watchdog counts from the capture request, also while no picture came", () => {
    const { core, out, ready } = directCore();
    ready();
    core.pointer(0.2, 0.5, 1);
    clock += FIRST_ANALYSIS_WATCHDOG_MS - 1;
    core.tick();
    expect(core.status().lastFrameError).toBeNull();
    clock += 1;
    core.tick();
    expect(core.status().lastFrameError).toBe("no reply");
    const late = bitmap();
    core.frame(out.captures[0]!.requestId, late, 1);
    expect(late.closed).toBe(true);
  });
});

describe("SessionCore: the first analysis gets a longer watchdog", () => {
  /** Asks a look on a playing video (a new frame each time) and returns its capture. */
  const look = (core: SessionCore, out: ReturnType<typeof directCore>["out"], at: number) => {
    core.presented(at);
    core.pointer(0.2 + at * 0.001, 0.5, at);
    core.tick();
    return out.captures.at(-1)!;
  };

  it("waits FIRST_ANALYSIS_WATCHDOG_MS for the first analysis, and shows its late card", () => {
    const { core, out, ready } = directCore();
    ready();
    const first = look(core, out, 1);
    core.frame(first.requestId, bitmap(), 1);
    clock += 9_000;
    core.pointer(0.2, 0.5, 1);
    core.tick();
    expect(core.status().lastFrameError).toBeNull();
    // A 9 s first analysis (a cold start on a slow machine) is shown, not dropped.
    core.fromWorker(reply(out.requests.at(-1)!.request, { videoTimeSec: 1 } as Partial<FrameResult>));
    expect(core.status().frames).toBe(1);
  });

  it("gives up after ANALYSIS_WATCHDOG_MS once the worker has analyzed a picture", () => {
    const { core, out, ready, answer } = directCore();
    ready();
    look(core, out, 1);
    answer(1);
    expect(core.status().frames).toBe(1);
    clock += 1_000;
    const second = look(core, out, 2);
    expect(second.requestId).toBeGreaterThan(out.captures[0]!.requestId);
    clock += ANALYSIS_WATCHDOG_MS - 1;
    core.pointer(0.2, 0.5, 2);
    core.tick();
    expect(core.status().lastFrameError).toBeNull();
    clock += 1;
    core.tick();
    expect(core.status().lastFrameError).toBe("no reply");
  });

  it("waits FIRST_ANALYSIS_WATCHDOG_MS again for the first analysis of a restarted worker", () => {
    const { core, out, ready, answer } = directCore();
    ready();
    look(core, out, 1);
    answer(1);
    core.workerStopped({ restart: true });
    ready();
    clock += 1_000;
    look(core, out, 2);
    clock += ANALYSIS_WATCHDOG_MS + 1;
    core.pointer(0.2, 0.5, 2);
    core.tick();
    expect(core.status().lastFrameError).toBeNull();
    clock += FIRST_ANALYSIS_WATCHDOG_MS - ANALYSIS_WATCHDOG_MS;
    core.pointer(0.21, 0.5, 2);
    core.tick();
    expect(core.status().lastFrameError).toBe("no reply");
  });
});

describe("neighborBoxes", () => {
  it("lists the other cards' boxes in fractions, without the shown one, up to the limit", () => {
    const card = (x: number) => ({ bounds: { x, y: 0.1, width: 0.1, height: 0.2 } });
    const analysis = { hover: { cards: [card(0.1), card(0.3), card(0.5), card(0.7)] } } as unknown as FrameAnalysis;
    expect(neighborBoxes(analysis, { x: 0.3, y: 0.1, width: 0.1, height: 0.2 })).toEqual([
      { x: 0.1, y: 0.1, width: 0.1, height: 0.2 },
      { x: 0.5, y: 0.1, width: 0.1, height: 0.2 },
      { x: 0.7, y: 0.1, width: 0.1, height: 0.2 },
    ]);
    expect(neighborBoxes(analysis, { x: 0.3, y: 0.1, width: 0.1, height: 0.2 }, 1)).toHaveLength(1);
  });
});

describe("SessionCore: looks refused by the page", () => {
  /** Refuses every capture not answered yet, as the content script's gate does with the pointer
   *  outside, or for a video that may not be read. Returns how many it refused. */
  const refuser = (core: SessionCore, out: ReturnType<typeof directCore>["out"]) => {
    let answered = 0;
    return (reason = "no pointer over the player"): number => {
      let n = 0;
      while (answered < out.captures.length) {
        core.captureFailed(out.captures[answered]!.requestId, reason, false);
        answered += 1;
        n += 1;
      }
      return n;
    };
  };
  /** Wiggles the pointer over the paused picture for up to `ms`, answering the first capture
   *  asked; true once the card is shown. */
  const wiggleUntilShown = (d: ReturnType<typeof directCore>, mediaTime: number, ms = 12_000): boolean => {
    const before = d.out.captures.length;
    for (let t = 0; t < ms; t += 250) {
      clock += 250;
      d.core.pointer(0.2 + ((t / 250) % 2) * 0.001, 0.5, mediaTime);
      d.core.tick();
      if (d.out.captures.length > before) {
        d.answer(mediaTime);
        return d.out.shown.at(-1)?.cardId === "T-001";
      }
    }
    return false;
  };

  it("a paused video: looks asked after the pointer crossed and left are refused; the return looks again", () => {
    const d = directCore({ hold: SHOWN_HOLD });
    const refuse = refuser(d.core, d.out);
    d.core.presented(3);
    d.core.pointer(0.2, 0.5, 3);
    clock += 250;
    d.core.pointerLeft();
    // The release loads within the grace period of the leave: the look and its repeats are asked
    // with the pointer outside, and all refused.
    clock += 750;
    d.ready();
    let refused = 0;
    for (let i = 0; i < 12; i += 1) {
      d.core.tick();
      refused += refuse();
      clock += 250;
    }
    expect(refused).toBe(3);
    expect(wiggleUntilShown(d, 3)).toBe(true);
  });

  it("a video paused during the grace period after the pointer left: the return looks again", () => {
    const d = directCore({ hold: SHOWN_HOLD });
    d.ready();
    d.core.pointer(0.2, 0.5, 1);
    d.answer(1);
    expect(d.out.shown.at(-1)?.cardId).toBe("T-001");
    const refuse = refuser(d.core, d.out);
    d.core.pointerLeft();
    // Playing for 3 s, then paused at 4 s; every look with the pointer outside is refused.
    let mediaTime = 1;
    for (let i = 0; i < 12; i += 1) {
      clock += 250;
      mediaTime += 0.25;
      d.core.presented(mediaTime);
      d.core.tick();
      refuse();
    }
    for (let i = 0; i < 60; i += 1) {
      clock += 250;
      d.core.tick();
      refuse();
    }
    expect(refuse()).toBe(0);
    expect(wiggleUntilShown(d, mediaTime)).toBe(true);
  });

  it("a video that may not be read: a pointer that rests asks for nothing more; a moving one once per cadence", () => {
    const d = directCore();
    const refuse = refuser(d.core, d.out);
    d.ready();
    d.core.pointer(0.2, 0.5, 3);
    for (let i = 0; i < 8; i += 1) {
      refuse("the video may not be read");
      clock += 250;
      d.core.tick();
    }
    refuse("the video may not be read");
    const resting = d.out.captures.length;
    expect(resting).toBe(3); // the look and its repeats
    for (let i = 0; i < 120; i += 1) {
      clock += 250;
      d.core.tick();
      refuse("the video may not be read");
    }
    expect(d.out.captures.length).toBe(resting);
    // Moving for 10 s: at most one look per second (the WebAssembly cadence), never one a tick.
    for (let i = 0; i < 40; i += 1) {
      clock += 250;
      d.core.pointer(0.2 + (i % 2) * 0.001, 0.5, 3);
      d.core.tick();
      refuse("the video may not be read");
    }
    const moving = d.out.captures.length - resting;
    expect(moving).toBeGreaterThan(0);
    expect(moving).toBeLessThanOrEqual(10);
    const at = d.out.captures.slice(resting).map((c) => c.at);
    expect(Math.min(...at.slice(1).map((t, i) => t - at[i]!))).toBeGreaterThanOrEqual(1_000);
  });
});

describe("SessionCore: a picture after failed captures", () => {
  it("starts the back-off over: answered busy, the next capture comes 250 ms later", () => {
    const { core, out, ready } = directCore();
    ready();
    core.presented(3);
    core.pointer(0.2, 0.5, 3);
    // Three captures in a row fail for want of a picture (the next retry would be 1 s away).
    let failures = 0;
    for (let i = 0; i < 40 && failures < 3; i += 1) {
      const c = out.captures.at(-1);
      if (c && c.at === clock) {
        core.captureFailed(c.requestId, "no picture", true);
        failures += 1;
      }
      clock += 250;
      core.tick();
    }
    expect(failures).toBe(3);
    // The next capture gets a picture; the worker answers it busy a second later.
    while (out.captures.at(-1)!.at !== clock) {
      clock += 250;
      core.tick();
    }
    const c = out.captures.at(-1)!;
    core.frame(c.requestId, bitmap(), 3);
    clock += 1_000;
    core.fromWorker(reply(out.requests.at(-1)!.request, { analysis: null, error: "busy" }));
    const busyAt = clock;
    const n = out.captures.length;
    while (out.captures.length === n && clock < busyAt + 5_000) {
      clock += 250;
      core.tick();
    }
    expect(out.captures.at(-1)!.at).toBe(busyAt + LOOK_RETRY_MS[0]!);
  });
});

describe("SessionCore: a seek between the capture and its picture", () => {
  it("closes the picture, analyzes nothing, and lets the next look go", () => {
    const { core, out, ready, answer } = directCore();
    ready();
    core.pointer(0.2, 0.5, 1);
    const c = out.captures.at(-1)!;
    core.discontinuity(false);
    const late = bitmap();
    core.frame(c.requestId, late, 1);
    expect(late.closed).toBe(true);
    expect(out.requests).toEqual([]);
    // The look is finished: the seek's frame is looked at, and its card shown.
    clock += 250;
    core.presented(7);
    core.pointer(0.2, 0.5, 7);
    expect(out.captures.length).toBe(2);
    answer(7);
    expect(out.shown.at(-1)?.cardId).toBe("T-001");
  });

  it("the same after a cut", () => {
    const { core, out, ready } = directCore();
    ready();
    core.pointer(0.2, 0.5, 1);
    const c = out.captures.at(-1)!;
    core.cut();
    const late = bitmap();
    core.frame(c.requestId, late, 1);
    expect([late.closed, out.requests.length]).toEqual([true, 0]);
    clock += 10;
    core.tick();
    expect(out.captures.length).toBe(2);
  });
});

describe("SessionCore: the worker stopped", () => {
  it("restarting: drops the look in flight and what is shown, reports loading, the stage off, and looks again once loaded", () => {
    const { core, out, ready, answer } = directCore({ geometric: true });
    ready();
    core.fromWorker({ kind: "geometric-status", state: "ready", reason: null, bytes: 10 });
    core.pointer(0.2, 0.5, 1);
    answer(1);
    expect(out.shown.at(-1)?.cardId).toBe("T-001");
    clock += 5_000;
    core.presented(1.5);
    core.pointer(0.21, 0.5, 1.5);
    core.tick();
    const inFlight = out.captures.at(-1)!;
    expect(out.captures).toHaveLength(2);
    core.workerStopped({ restart: true });
    expect(out.shown.at(-1)).toBeNull();
    expect(out.geometric.at(-1)).toEqual({ kind: "geometric-status", state: "off", reason: "worker-restarted", bytes: null });
    expect(core.status()).toMatchObject({ state: "loading", error: null, release: { id: "r" }, geometric: { state: "off", reason: "worker-restarted", bytes: null } });
    expect(core.analysis()).toBeNull();
    // The look in flight is gone: its picture is closed, and nothing is asked before the new worker has loaded.
    const late = bitmap();
    core.frame(inFlight.requestId, late, 1);
    expect(late.closed).toBe(true);
    clock += 2_000;
    core.pointer(0.2, 0.5, 1.5);
    core.tick();
    expect(out.captures).toHaveLength(2);
    ready();
    core.pointer(0.21, 0.5, 1.5);
    core.tick();
    expect(out.captures).toHaveLength(3);
  });

  it("restarting without a stage asked for: the status keeps no geometric state, the hook still hears of it", () => {
    const { core, out, ready } = directCore();
    ready();
    core.workerStopped({ restart: true });
    expect(core.status().geometric).toBeNull();
    expect(out.geometric).toEqual([{ kind: "geometric-status", state: "off", reason: "worker-restarted", bytes: null }]);
  });

  it("not restarting: failed with the error, and ignored once failed or stopped", () => {
    const { core, out, ready } = directCore();
    ready();
    core.workerStopped({ error: "the recognition worker stopped (x)" });
    expect(out.statuses.at(-1)).toMatchObject({ state: "failed", error: "the recognition worker stopped (x)" });
    core.workerStopped({ restart: true });
    expect(core.status().state).toBe("failed");
    expect(out.geometric).toEqual([]);
    core.stop();
    core.workerStopped({ error: "late" });
    expect(core.status()).toMatchObject({ state: "stopped", error: "the recognition worker stopped (x)" });
  });
});

describe("SessionCore: another worker loads", () => {
  it("restarts the stage's status for the new load and drops the old progress, nothing else", () => {
    const { core, out } = directCore({ geometric: true });
    core.fromWorker({ kind: "release-progress", phase: "preparing", bytes: null });
    expect(core.status().loading).toEqual({ phase: "preparing", bytes: null });
    core.reloading({ geometric: false });
    expect(core.status()).toMatchObject({ state: "loading", geometric: null, loading: null, error: null });
    expect(out.statuses.at(-1)).toMatchObject({ geometric: null, loading: null });
    expect(out.geometric).toEqual([]);
    core.reloading({ geometric: true });
    expect(core.status().geometric).toEqual({ state: "loading", reason: null, bytes: null });
  });

  it("changes nothing once loaded", () => {
    const { core, ready } = directCore({ geometric: true });
    ready();
    core.reloading({ geometric: false });
    expect(core.status()).toMatchObject({ state: "ready", geometric: { state: "loading", reason: null, bytes: null } });
  });
});

describe("SessionCore: the time a result is judged against", () => {
  it("without mediaTimeNow, the time last reported decides", () => {
    const { core, ready, answer } = directCore();
    ready();
    core.pointer(0.2, 0.5, 1);
    answer(1);
    expect(core.fresh()?.cardId).toBe("T-001");
    // However far the video has moved, nothing was reported: the result still stands.
    expect(core.analysis()).not.toBeNull();
    core.presented(3.5);
    expect(core.analysis()).toBeNull();
    expect(core.fresh()).toBeNull();
  });

  it("with mediaTimeNow, the live time decides, reported or not", () => {
    let live = 1;
    const { core, out, ready, answer } = directCore({}, { mediaTimeNow: () => live });
    ready();
    core.pointer(0.2, 0.5, 1);
    answer(1);
    expect(core.fresh()?.cardId).toBe("T-001");
    live = 3.5;
    expect(core.analysis()).toBeNull();
    expect(core.fresh()).toBeNull();
    // A reported time does not override it.
    core.presented(1);
    expect(core.analysis()).toBeNull();
    live = 1.5;
    expect(core.analysis()).not.toBeNull();
    // A look is dated at the live time (the staleness rule compares with it).
    expect(out.captures).toHaveLength(1);
  });

  it("with mediaTimeNow, a paused always-on picture is shown with nothing reported", () => {
    const { core, out, ready } = directCore({ mode: "always-on" }, { mediaTimeNow: () => 4 });
    ready();
    core.tick();
    const c = out.captures.at(-1)!;
    core.frame(c.requestId, bitmap(), 4);
    core.fromWorker(reply(out.requests.at(-1)!.request));
    expect(core.analysis()).not.toBeNull();
  });
});

describe("SessionCore: a picture the worker cannot take", () => {
  it("closes the picture, records the error and asks again after the back-off", () => {
    const captures: number[] = [];
    let failing = true;
    const core = new SessionCore(
      {
        now: () => clock,
        toWorker: (request) => {
          if (request.kind === "frame" && failing) throw new Error("DataCloneError");
        },
        capture: (requestId) => captures.push(requestId),
        onShown: () => {},
        onStatus: () => {},
        hoverAt: hit as never,
      },
      { mode: "always-on" },
    );
    core.fromWorker({ kind: "release-status", ok: true, error: null, release, cards: [] });
    core.presented(1);
    core.tick();
    expect(captures).toHaveLength(1);
    const b = bitmap();
    core.frame(captures[0]!, b, 1);
    expect(b.closed).toBe(true);
    expect(core.status().lastFrameError).toBe("analysis-failed: Error: DataCloneError");
    failing = false;
    // Retried as a look given up on: after the back-off, at the cadence.
    for (let i = 0; i < 12 && captures.length < 2; i += 1) {
      clock += 250;
      core.tick();
    }
    expect(captures).toHaveLength(2);
  });
});
