// SPDX-License-Identifier: Apache-2.0
// Focus scope with a ready geometric stage, on a playing video: an active pointer on a face the
// newest analysis left unverified gets a look at once (on its pointer message, on the reply of a
// look that was in flight, or on a tick), instead of waiting for the next cadence look
// (frame-scheduler.ts `relookDue` with the picture's time). Everything else asks exactly when it
// asked before: the ask times of the comparison scenarios below were recorded on the code before
// the change.

import { describe, expect, it } from "vitest";

import { ACTIVE_ANALYZE_INTERVAL_MS, MEASURED_PACING_SHARE } from "../src/cadence.js";
import { DRIVER_TICK_MS, FrameScheduler, HOVER_TRIGGER_MIN_GAP_MS, POINTER_GRACE_MS } from "../src/frame-scheduler.js";
import type { WorkerRequest } from "../src/messages.js";
import type { FrameAnalysis } from "../src/pipeline.js";
import { focusGroup } from "../src/recognition.js";
import { SessionCore, type SessionCoreOptions } from "../src/session-core.js";

/** A 1000 x 500 picture: card A (x 100..300), B (x 600..800) and C (x 350..550). A is always
 *  verified; B and C only when an analysis verified them. */
const SPEC: Array<[string, number]> = [["A", 100], ["B", 600], ["C", 350]];
type Box = { box: number[]; face: { unverified?: true; cardId: string | null } };
const analysisOf = (verified: ReadonlySet<string>): FrameAnalysis =>
  ({
    frame: { width: 1000, height: 500 },
    hover: { selection: "accepted-nms", cards: [] },
    boxes: SPEC.map(([id, x]): Box => ({ box: [x, 100, 200, 300], face: verified.has(id) ? { cardId: id } : { unverified: true, cardId: null } })),
  }) as unknown as FrameAnalysis;
const hit = (a: { boxes: Box[] }, x: number, y: number) => {
  const i = a.boxes.findIndex((b) => x >= b.box[0]! && x <= b.box[0]! + b.box[2]! && y >= b.box[1]! && y <= b.box[1]! + b.box[3]!);
  const face = i < 0 ? null : a.boxes[i]!.face;
  const b = i < 0 ? null : { x: a.boxes[i]!.box[0]!, y: a.boxes[i]!.box[1]!, width: a.boxes[i]!.box[2]!, height: a.boxes[i]!.box[3]! };
  return { card: null, boxIndex: i < 0 ? null : i, box: face?.cardId ? b : null, cardId: face?.cardId ?? null, name: face?.cardId ?? null };
};
/** The pointer x for each card, at y 0.5. */
const X = { A: 0.2, B: 0.7, C: 0.45 } as const;

interface Setup {
  /** Session options; the stage is asked for unless `stage` is "none". */
  options?: SessionCoreOptions;
  /** "ready": the stage reports ready after the release; "loading": it never does; "none": not asked for. */
  stage: "ready" | "loading" | "none";
  /** How long the worker takes to answer a look, in ms. */
  latencyMs?: number;
  /** A look with the focus scope verifies nothing beyond A. The worker does not answer so today
   *  (a focus look verifies the pointer's group); this stands in for a face that stays unnamed. */
  neverVerify?: boolean;
  /** The recognizer's execution provider (default "webgpu"). */
  ep?: "webgpu" | "wasm";
}

/**
 * A session over a video whose clock follows the wall clock while it plays. Every look is
 * answered `latencyMs` after it is asked. A look sent with the focus scope verifies the faces in
 * the pointer's group; any other look (a full pass, or no ready stage) verifies only A, so that
 * unverified faces are there for the new trigger to see whenever it is not gated.
 */
function session(setup: Setup) {
  const start = 10_000;
  let now = start;
  let pausedAt: number | null = null;
  const t = (): number => pausedAt ?? now / 1000;
  const captures: Array<{ requestId: number; at: number; inFlightBefore: boolean }> = [];
  const sent: Array<Extract<WorkerRequest, { kind: "frame" }>> = [];
  /** `unverifyA`: answers leave A unverified as well, whatever the focus (a stand-in reply the
   *  worker does not give today, to reach a guard). */
  const fake = { unverifyA: false };
  /** The look in flight: its request and when it was asked; null when none. */
  let open: { requestId: number; at: number } | null = null;
  const options: SessionCoreOptions = { ...(setup.stage === "none" ? {} : { geometric: true }), ...setup.options };
  const core = new SessionCore(
    {
      now: () => now,
      mediaTimeNow: t,
      toWorker: (r) => {
        if (r.kind === "frame") sent.push(r);
      },
      capture: (requestId) => {
        captures.push({ requestId, at: now - start, inFlightBefore: open !== null });
        open = { requestId, at: now };
      },
      hoverAt: hit as never,
    },
    options,
  );
  core.fromWorker({ kind: "release-status", ok: true, error: null, release: { analysisWidth: { min: 720, max: 1920 }, hoverMaxAgeMs: 2000, recognizer: { ep: setup.ep ?? "webgpu" } } as never, cards: [] });
  if (setup.stage === "ready") core.fromWorker({ kind: "geometric-status", state: "ready", reason: null, bytes: 10 });
  const bitmap = { width: 1000, height: 500, close() {} } as unknown as ImageBitmap;

  /** Answer the look in flight now. */
  const answer = (): void => {
    if (!open) return;
    const { requestId } = open;
    open = null;
    const before = sent.length;
    core.frame(requestId, bitmap, t());
    if (sent.length === before) return; // the picture was dropped (a seek): the look is finished
    const request = sent.at(-1)!;
    const verified = new Set<string>();
    if (!fake.unverifyA) verified.add("A");
    if (request.geometricScope === "focus" && request.focus && !setup.neverVerify) {
      const boxes = SPEC.map(([, x]) => ({ x, y: 100, width: 200, height: 300 }));
      for (const i of focusGroup(boxes, request.focus)) verified.add(SPEC[i]![0]);
    }
    if (fake.unverifyA) verified.delete("A");
    core.fromWorker({ kind: "frame-result", envelope: request.envelope, videoTimeSec: t(), width: 1000, height: 500, workerMs: setup.latencyMs ?? 50, analysis: analysisOf(verified) });
  };

  /** Run `ms` of time in 10 ms steps: a frame presented every 20 ms while playing, the look in
   *  flight answered once its latency is up, the scripted pointer moves (at ms from the start),
   *  and a tick every DRIVER_TICK_MS. */
  const run = (ms: number, moves: ReadonlyArray<readonly [number, number]> = [], pauseAt?: number): void => {
    const from = now;
    for (let e = 10; e <= ms; e += 10) {
      now = from + e;
      if (pauseAt !== undefined && now - start >= pauseAt && pausedAt === null) pausedAt = t();
      if (pausedAt === null && e % 20 === 0) core.presented(t());
      if (open && now - open.at >= (setup.latencyMs ?? 50)) answer();
      for (const [at, x] of moves) if (at === now - start) core.pointer(x, 0.5, t());
      if ((now - start) % DRIVER_TICK_MS === 0) core.tick();
    }
  };
  /** The pointer at x now; true when a capture was asked in this very call. */
  const point = (x: number): boolean => {
    const n = captures.length;
    core.pointer(x, 0.5, t());
    return captures.length > n;
  };
  const asked = (): number[] => captures.map((c) => c.at);
  /** Run 10 ms at a time until a look is asked, and stop there (the look still in flight). */
  const untilAsk = (): void => {
    const n = captures.length;
    for (let i = 0; i < 1_000 && captures.length === n; i++) run(10);
    if (captures.length === n) throw new Error("no look was asked");
  };
  return { core, run, point, answer, asked, untilAsk, captures, sent, fake, clock: () => now, elapsed: () => now - start, isOpen: () => open !== null };
}

/** Moves every `every` ms from `from` to `to`, cycling through `xs`. */
const sweep = (from: number, to: number, every: number, xs: readonly number[]): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let at = from, i = 0; at <= to; at += every, i++) out.push([at, xs[i % xs.length]!]);
  return out;
};

const READY_FOCUS: Setup = { stage: "ready", options: { geometricScope: "focus" } };

describe("a pointer onto an unverified face on a playing video, with the stage ready in focus scope", () => {
  /** Playing, the pointer on A from the start, run until a cadence look has been answered and
   *  DRIVER_TICK_MS more have passed: the frame is not stale yet and the next cadence look is
   *  not due. */
  const between = (setup: Setup) => {
    const s = session(setup);
    s.run(1_000, [[10, X.A]]);
    s.untilAsk(); // a cadence look
    s.run(HOVER_TRIGGER_MIN_GAP_MS + 10);
    expect(s.isOpen()).toBe(false);
    return s;
  };
  /** As `between`, then on to 10 ms short of the fast cadence (F, 500 ms on WebGPU) after that
   *  look's start: a tick, and so the next cadence look, is 10 ms away. */
  const nearF = (setup: Setup) => {
    const s = session(setup);
    s.run(1_000, [[10, X.A]]);
    s.untilAsk(); // a cadence look, at a tick
    const started = s.elapsed();
    s.run(ACTIVE_ANALYZE_INTERVAL_MS - 10);
    expect(s.isOpen()).toBe(false);
    expect(s.elapsed() - started).toBe(ACTIVE_ANALYZE_INTERVAL_MS - 10);
    return { s, started };
  };

  it.each([["entry look off", {}], ["entry look on", { entryLook: true }]] as const)("%s: asks for a look on the pointer message F after the last start, focused on the face, before the tick", (_, extra) => {
    const { s, started } = nearF({ ...READY_FOCUS, options: { ...READY_FOCUS.options, ...extra } });
    expect(s.core.hitAt(X.B, 0.5)).toBeNull(); // B is unverified: not named
    expect(s.point(X.B)).toBe(false); // 490 ms since the last start: under F
    s.run(10, [[started + ACTIVE_ANALYZE_INTERVAL_MS, X.B]]);
    expect(s.asked().at(-1)).toBe(started + ACTIVE_ANALYZE_INTERVAL_MS);
    expect(s.core.scheduler.lastTrigger).toBe("hover"); // the move's, not the tick's
    s.answer();
    expect(s.sent.at(-1)).toMatchObject({ geometricScope: "focus", focus: { x: 700, y: 250 } });
    expect(s.core.hitAt(X.B, 0.5)?.cardId).toBe("B");
  });

  it("the same move with no ready stage waits for the cadence look (the behavior before)", () => {
    for (const stage of ["loading", "none"] as const) {
      const s = between({ stage, options: { geometricScope: "focus" } });
      expect(s.point(X.B), stage).toBe(false);
    }
    const all = between({ stage: "ready" });
    expect(all.point(X.B)).toBe(false);
  });

  it("a move under F after the last start asks nothing: the spacing is F, not the 250 ms minimum (S-C7)", () => {
    const s = between(READY_FOCUS);
    expect(s.point(X.B)).toBe(false);
  });

  it("asks nothing extra while the pointer moves on a named face", () => {
    const s = between(READY_FOCUS);
    expect(s.point(X.A)).toBe(false);
    expect(s.point(X.A + 0.01)).toBe(false);
  });

  it("asks nothing for a pointer over no face", () => {
    const s = between(READY_FOCUS);
    expect(s.point(0.95)).toBe(false);
  });

  it("keeps the minimum gap: a move inside HOVER_TRIGGER_MIN_GAP_MS of the last look asks nothing", () => {
    const s = session(READY_FOCUS);
    s.run(1_000, [[10, X.A]]);
    s.untilAsk();
    s.run(100);
    expect(s.isOpen()).toBe(false);
    expect(s.point(X.B)).toBe(false);
  });

  it("asks nothing while a look is in flight, and waits out a retry's back-off", () => {
    const busy = session({ ...READY_FOCUS, latencyMs: 400 });
    busy.run(1_000, [[10, X.A]]);
    expect(busy.isOpen()).toBe(true);
    expect(busy.point(X.B)).toBe(false);

    const retry = session(READY_FOCUS);
    retry.run(1_000, [[10, X.A]]);
    // The next cadence look's capture fails for want of a picture, and so does its retry: the
    // next retry waits out a longer back-off, past the minimum gap.
    for (let i = 0; i < 2; i++) {
      retry.untilAsk();
      retry.core.captureFailed(retry.captures.at(-1)!.requestId, "no picture yet", true);
    }
    retry.run(HOVER_TRIGGER_MIN_GAP_MS + 50);
    expect(retry.captures.at(-1)!.at).toBeLessThanOrEqual(retry.elapsed() - HOVER_TRIGGER_MIN_GAP_MS);
    expect(retry.point(X.B)).toBe(false);
  });

  // The pointer lands on B while a look is in flight (asked with the pointer on A) and rests:
  // the relook comes when that look returns, or F (500 ms on WebGPU) after it started if later.
  // Before the relook, the resting pointer waited for the next scheduled look (2 s here: that look
  // found no named card at the pointer, so the empty-spot gap applied).
  it.each([
    ["returns after F: on the reply", 600, 600],
    ["returns inside F: at F, the next tick", 100, ACTIVE_ANALYZE_INTERVAL_MS],
  ] as const)("a pointer that lands during a look in flight and rests; the look %s", (_, latencyMs, after) => {
    const s = session({ ...READY_FOCUS, latencyMs });
    s.run(1_000, [[10, X.A]]);
    s.untilAsk();
    const inFlight = s.asked().at(-1)!;
    expect(s.point(X.B)).toBe(false); // a look is in flight
    s.run(2_000);
    const later = s.asked().filter((a) => a > inFlight);
    expect(later[0]).toBe(inFlight + after);
    expect(s.sent.find((r) => r.focus?.x === 700)).toMatchObject({ geometricScope: "focus", focus: { x: 700, y: 250 } });
    expect(s.core.hitAt(X.B, 0.5)?.cardId).toBe("B");
  });

  it("a resting pointer on a face that stays unverified asks nothing once its grace period is over", () => {
    const s = session({ ...READY_FOCUS, neverVerify: true });
    s.run(1_000, [[10, X.A]]);
    s.untilAsk();
    s.point(X.B);
    s.run(POINTER_GRACE_MS + 2_000);
    const atRest = s.asked().filter((a) => a > s.elapsed() - 1_500);
    // Past the grace period nothing is analyzed at all (no card shows, so no reading state).
    expect(atRest).toEqual([]);
  });

  it("with measured pacing, a sweep's relooks are not paced: a 900 ms worker looks again F after the last start, not the paced 3600 ms (S-C7, S-P2)", () => {
    const paced: Setup = { stage: "ready", options: { geometricScope: "focus", measuredPacing: true }, latencyMs: 900 };
    const s = session(paced);
    const from = 3_000;
    const to = 9_000;
    s.run(to + 1_000, [[10, X.A], ...sweep(from, to, 30, [X.B, X.C])]);
    const all = s.asked().filter((a) => a >= from && a < to);
    // By then 3 or more analyses have been measured: the cadence is paced at 900 / 0.25 = 3600 ms.
    expect(s.core.scheduler.intervalInEffectMs(s.clock())).toBe(900 / MEASURED_PACING_SHARE);
    // The relooks are spaced at least F and at least one look apart (one in flight), and closer
    // than the paced wait.
    for (let i = 1; i < all.length; i++) {
      expect(all[i]! - all[i - 1]!).toBeGreaterThanOrEqual(Math.max(ACTIVE_ANALYZE_INTERVAL_MS, 900));
      expect(all[i]! - all[i - 1]!).toBeLessThan(900 / MEASURED_PACING_SHARE);
    }
    expect(all.length).toBeGreaterThan((to - from) / (900 / MEASURED_PACING_SHARE) + 1);
  });

  it("with measured pacing, the relook waits F from the last start, on WebAssembly 1000 ms", () => {
    // In a session on WebAssembly (a fixed 1000 ms cadence until 3 analyses are measured, so the
    // staleness rule needs 1000 ms of video): the first look, asked at 10 ms, replies at 910 ms.
    // Moves onto the unverified faces right after it, before the frame is stale or the cadence is
    // due, ask nothing: the playing relook waits F (1000 ms) after the first look, not the bare
    // HOVER_TRIGGER_MIN_GAP_MS.
    const s = session({ stage: "ready", options: { geometricScope: "focus", measuredPacing: true }, latencyMs: 900, ep: "wasm" });
    s.run(980, [[10, X.A], ...sweep(920, 980, 10, [X.B, X.C])]);
    expect(s.asked()).toEqual([10]);
    const relooks = s.sent.filter((r) => r.focus && r.focus.x !== 200);
    expect(relooks).toEqual([]);
  });

  it("with measured pacing and a fast worker, the move at F still asks in the same call", () => {
    const { s, started } = nearF({ stage: "ready", options: { geometricScope: "focus", measuredPacing: true }, latencyMs: 20 });
    s.run(10, [[started + ACTIVE_ANALYZE_INTERVAL_MS, X.B]]);
    expect(s.asked().at(-1)).toBe(started + ACTIVE_ANALYZE_INTERVAL_MS);
    expect(s.core.scheduler.lastTrigger).toBe("hover");
  });

  it("a pointer past its grace period, with the reading state held by a card shown at it, gets no playing relook", () => {
    const s = session({ ...READY_FOCUS, latencyMs: 50 });
    s.run(1_000, [[10, X.A]]);
    s.run(POINTER_GRACE_MS + 500); // the pointer rests on A, named: the reading state
    expect(s.core.scheduler.analysisState(s.clock())).toBe("reading");
    // A reply that leaves the pointer's own group unverified (a stand-in: the worker verifies the
    // group of a look asked at a resting pointer) makes the group need a look while reading.
    s.fake.unverifyA = true;
    s.untilAsk();
    s.run(60);
    expect(s.core.hitAt(X.A, 0.5)).toBeNull();
    expect(s.core.scheduler.analysisState(s.clock())).toBe("reading");
    const at = s.elapsed();
    s.run(700); // inside the reading cadence: nothing but the playing relook could ask
    expect(s.asked().filter((a) => a > at)).toEqual([]);
  });

  it("a sweep across unverified faces asks at most one look per F, never two in flight", () => {
    for (const latencyMs of [20, 100, 300]) {
      const moves: Array<[number, number]> = [[10, X.A], ...sweep(1_000, 5_000, 30, [X.B, X.C])];
      const s = session({ ...READY_FOCUS, latencyMs });
      s.run(6_000, moves);
      const at = s.asked().filter((a) => a >= 1_000);
      // Unpaced, F is the cadence: the trigger asks no more looks than the same sweep while the
      // stage loads (no trigger), only sooner after a reply that leaves the pointer's face unverified.
      const loading = session({ stage: "loading", options: { geometricScope: "focus" }, latencyMs });
      loading.run(6_000, moves);
      expect(at.length, `latency ${latencyMs}`).toBeGreaterThanOrEqual(loading.asked().filter((a) => a >= 1_000).length);
      for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!, `latency ${latencyMs}, look ${i}`).toBeGreaterThanOrEqual(ACTIVE_ANALYZE_INTERVAL_MS);
      expect(s.captures.some((c) => c.inFlightBefore), `latency ${latencyMs}`).toBe(false);
    }
  });
});

describe("unchanged: the ask times recorded before the change", () => {
  // Each scenario's ask times (ms from the start) were recorded on the code before the change and
  // must not move. The moves cross the unverified faces B and C, which the new trigger would look
  // at if it applied.
  const crossing = (from: number, to: number) => sweep(from, to, 70, [X.B, X.C, X.A]);

  it("a still picture in focus scope with a ready stage (a slow worker, so a move can land while repeats wait)", () => {
    const s = session({ ...READY_FOCUS, latencyMs: 400 });
    s.run(6_000, [[10, X.A], ...crossing(1_500, 5_000)], 1_000);
    expect(s.asked()).toEqual(STILL_FOCUS_READY);
  });

  it("scope all with a ready stage, playing", () => {
    const s = session({ stage: "ready" });
    s.run(4_000, [[10, X.A], ...crossing(500, 3_500)]);
    expect(s.asked()).toEqual(PLAYING_ALL_READY);
  });

  it("focus scope with no stage, playing", () => {
    const s = session({ stage: "none", options: { geometricScope: "focus" } });
    s.run(4_000, [[10, X.A], ...crossing(500, 3_500)]);
    expect(s.asked()).toEqual(PLAYING_FOCUS_NO_STAGE);
  });

  it("focus scope with the stage still loading, playing", () => {
    const s = session({ stage: "loading", options: { geometricScope: "focus" } });
    s.run(4_000, [[10, X.A], ...crossing(500, 3_500)]);
    expect(s.asked()).toEqual(PLAYING_FOCUS_LOADING);
  });

  it("always-on mode with a ready stage, playing", () => {
    const s = session({ stage: "ready", options: { mode: "always-on" } });
    s.run(4_000, [[10, X.A], ...crossing(500, 3_500)]);
    expect(s.asked()).toEqual(PLAYING_ALWAYS_ON);
  });

  it("focus scope with a ready stage, playing, the pointer moving on a named face only", () => {
    const s = session(READY_FOCUS);
    s.run(4_000, sweep(10, 3_500, 40, [X.A, X.A + 0.01]));
    expect(s.asked()).toEqual(PLAYING_FOCUS_READY_NAMED);
  });
});

describe("FrameScheduler.relookDue with the picture's time", () => {
  /** A playing picture: analyzed at 1.0 s of video, then a newer frame presented. */
  const playing = () => {
    const s = new FrameScheduler(500, 3, "pointer", 1000);
    s.framePresented();
    s.pointerMoved(0);
    s.started(0, { videoTimeSec: 1 });
    s.framePresented();
    s.pointerMoved(300);
    return s;
  };

  it("is due on a playing picture once HOVER_TRIGGER_MIN_GAP_MS has passed since the last look, and not without the time", () => {
    const s = playing();
    expect(s.relookDue(300, false)).toBe(false); // without the time: as before, a still picture only
    expect(s.relookDue(300, false, 1.3)).toBe(true);
    expect(s.relookDue(300, true, 1.3)).toBe(false); // one in flight
    expect(s.relookDue(HOVER_TRIGGER_MIN_GAP_MS - 1, false, 1.3)).toBe(false);
  });

  it("is not due when the picture's time has not moved since the last look, or a retry waits, or a capture was refused", () => {
    expect(playing().relookDue(300, false, 1)).toBe(false);
    const retry = playing();
    retry.lookUnanswered(300);
    expect(retry.relookDue(400, false, 1.4)).toBe(false);
    const refused = playing();
    refused.lookRefused();
    expect(refused.relookDue(300, false, 1.3)).toBe(false);
  });

  it("is not due after a seek or a new source until the next look starts", () => {
    const s = playing();
    s.discontinuity();
    s.framePresented();
    expect(s.relookDue(300, false, 1.3)).toBe(false);
  });

  it("with a relook spacing, waits the longer of it and HOVER_TRIGGER_MIN_GAP_MS", () => {
    const s = playing();
    s.setRelookSpacingMs(600);
    expect(s.relookDue(599, false, 1.3)).toBe(false);
    expect(s.relookDue(600, false, 1.3)).toBe(true);
    s.setRelookSpacingMs(100);
    expect(s.relookDue(HOVER_TRIGGER_MIN_GAP_MS - 1, false, 1.3)).toBe(false);
    expect(s.relookDue(HOVER_TRIGGER_MIN_GAP_MS, false, 1.3)).toBe(true);
  });

  it("is not due while repeats of a still picture wait, whatever the time given", () => {
    const s = new FrameScheduler(500, 3, "pointer", 1000);
    s.framePresented();
    s.pointerMoved(0);
    s.started(0, { videoTimeSec: 1 }); // repeats left, nothing newly presented
    s.pointerMoved(300);
    expect(s.idle).toBe(false);
    expect(s.relookDue(300, false, 1)).toBe(false);
    expect(s.relookDue(300, false, 1.3)).toBe(false);
  });
});

// Recorded on the code before the change (see the describe above).
const STILL_FOCUS_READY: number[] = [10, 750, 1250, 1750, 2250, 2760, 3250, 3750, 4230, 4750, 5250];
const PLAYING_ALL_READY: number[] = [10, 570, 1130, 1690, 2250, 2750, 3250, 3750];
const PLAYING_FOCUS_NO_STAGE: number[] = [10, 570, 1130, 1690, 2250, 2750, 3250, 3750];
const PLAYING_FOCUS_LOADING: number[] = [10, 570, 1130, 1690, 2250, 2750, 3250, 3750];
const PLAYING_ALWAYS_ON: number[] = [10, 1060, 2110, 3160];
const PLAYING_FOCUS_READY_NAMED: number[] = [10, 530, 1050, 1570, 2090, 2610, 3130, 3750];
