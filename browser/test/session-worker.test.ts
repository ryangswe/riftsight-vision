// SPDX-License-Identifier: Apache-2.0
// The session's analysis worker: what happens when it stops with an error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameSource } from "../src/capture.js";
import { DRIVER_TICK_MS } from "../src/frame-scheduler.js";
import type { WorkerReply, WorkerRequest } from "../src/messages.js";
import type { FrameAnalysis } from "../src/pipeline.js";
import { createSession, type Session, WORKER_RESTARTS } from "../src/session.js";
import { plainLoad } from "../src/worker-session.js";

class FakeWorker {
  static all: FakeWorker[] = [];
  readonly posted: WorkerRequest[] = [];
  terminated = false;
  onmessage: ((event: { data: WorkerReply }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: WorkerReply): void {
    this.onmessage?.({ data });
  }
  fail(message: string): void {
    this.onerror?.({ message });
  }
}

const loaded: WorkerReply = { kind: "release-status", ok: true, error: null, release: null, cards: [] };
const source = { addEventListener: () => {}, removeEventListener: () => {} } as unknown as FrameSource;
let session: Session | null = null;

function start(withGeometric = true): Session {
  session = createSession(source, {
    releaseUrl: "release.json",
    workerUrl: "https://example.test/worker.js",
    ...(withGeometric ? { geometricUrl: "geometric/settings.json", geometricManifestSha256: "ab".repeat(32) } : {}),
  });
  return session;
}
const workers = (): FakeWorker[] => FakeWorker.all;

beforeEach(() => {
  FakeWorker.all = [];
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("HTMLVideoElement", class {});
  vi.stubGlobal("location", { href: "https://example.test/demo/" });
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => ({}) }) });
});

afterEach(() => {
  session?.stop();
  session = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a worker that stops with an error", () => {
  it("fails the session when it stops before the release has loaded, without a restart", () => {
    const s = start();
    workers()[0]!.fail("no module");
    expect(s.status()).toMatchObject({ state: "failed", error: "the worker did not start (no module)" });
    expect(workers()).toHaveLength(1);
    expect(workers()[0]!.terminated).toBe(true);
  });

  it("is restarted once after the release has loaded, on the same release without the geometric stage", () => {
    const s = start();
    const first = workers()[0]!;
    expect(first.posted[0]).toMatchObject({ kind: "load", geometricUrl: "https://example.test/demo/geometric/settings.json" });
    first.reply(loaded);
    first.reply({ kind: "geometric-status", state: "ready", reason: null, bytes: 10 });
    expect(s.status().state).toBe("ready");

    first.fail("out of memory");
    expect(first.terminated).toBe(true);
    expect(workers()).toHaveLength(2);
    const second = workers()[1]!;
    expect(second.posted).toEqual([plainLoad(first.posted[0] as Extract<WorkerRequest, { kind: "load" }>)]);
    expect(second.posted[0]).not.toHaveProperty("geometricUrl");
    expect(second.posted[0]).not.toHaveProperty("geometricManifestSha256");
    expect(second.posted[0]).toMatchObject({ kind: "load", releaseUrl: "https://example.test/demo/release.json" });
    expect(s.status()).toMatchObject({ state: "loading", error: null, geometric: { state: "off", reason: "worker-restarted", bytes: null } });
    expect(s.analysis()).toBeNull();

    second.reply(loaded);
    expect(s.status().state).toBe("ready");
  });

  it("ends recognition when the restarted worker stops too", () => {
    const s = start();
    workers()[0]!.reply(loaded);
    workers()[0]!.fail("first");
    workers()[1]!.reply(loaded);
    workers()[1]!.fail("second");
    expect(s.status()).toMatchObject({ state: "failed", error: "the recognition worker stopped (second)" });
    expect(workers()).toHaveLength(1 + WORKER_RESTARTS);
    expect(workers()[1]!.terminated).toBe(true);
  });

  it("ends recognition when the restarted worker stops before it has loaded", () => {
    const s = start();
    workers()[0]!.reply(loaded);
    workers()[0]!.fail("first");
    workers()[1]!.fail("second");
    expect(s.status()).toMatchObject({ state: "failed", error: "the recognition worker stopped (second)" });
    expect(workers()).toHaveLength(2);
  });

  it("drops the shown result and the look in flight when the worker stops", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({}));
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => ({ drawImage: () => {} }) }) });
    const image = { ...source, naturalWidth: 640, naturalHeight: 360 } as unknown as FrameSource;
    const s = (session = createSession(image, { releaseUrl: "release.json", workerUrl: "https://example.test/worker.js", mode: "always-on" }));
    const first = workers()[0]!;
    const release = { recognizer: { ep: "wasm" }, hoverMaxAgeMs: 1_000 } as unknown as NonNullable<Extract<WorkerReply, { kind: "release-status" }>["release"]>;
    first.reply({ ...loaded, release } as WorkerReply);
    await vi.advanceTimersByTimeAsync(DRIVER_TICK_MS);
    const look = first.posted.find((m) => m.kind === "frame");
    expect(look).toBeDefined();
    const envelope = (look as Extract<WorkerRequest, { kind: "frame" }>).envelope;
    const analysis = { hover: { cards: [] } } as unknown as FrameAnalysis;
    first.reply({ kind: "frame-result", envelope, videoTimeSec: 0, width: 640, height: 360, workerMs: 5, analysis });
    expect(s.analysis()).toBe(analysis);

    await vi.advanceTimersByTimeAsync(DRIVER_TICK_MS * 4);
    expect(first.posted.filter((m) => m.kind === "frame").length).toBeGreaterThan(1);
    first.fail("crashed during a look");
    expect(s.analysis()).toBeNull();
    const second = workers()[1]!;
    second.reply({ ...loaded, release } as WorkerReply);
    // The restarted worker gets looks again (at the release's cadence).
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second.posted.some((m) => m.kind === "frame")).toBe(true);
  });

  it("ignores what a replaced worker still sends", () => {
    const s = start();
    const first = workers()[0]!;
    first.reply(loaded);
    first.fail("first");
    first.reply(loaded);
    first.fail("late");
    expect(s.status().state).toBe("loading");
    expect(workers()).toHaveLength(2);
  });

  it("restarts without a geometric status when no stage was asked for", () => {
    const s = start(false);
    workers()[0]!.reply(loaded);
    workers()[0]!.fail("first");
    expect(s.status().geometric).toBeNull();
    expect(workers()[1]!.posted[0]).toEqual(workers()[0]!.posted[0]);
  });

  it("ends the restarted worker when the session stops", () => {
    const s = start();
    workers()[0]!.reply(loaded);
    workers()[0]!.fail("first");
    s.stop();
    expect(workers()[1]!.terminated).toBe(true);
    expect(s.status().state).toBe("stopped");
  });

  it("is not made ready again by a load answer that arrives after it failed", () => {
    const s = start();
    workers()[0]!.reply(loaded);
    workers()[0]!.fail("first");
    workers()[1]!.fail("second");
    workers()[1]!.reply(loaded);
    expect(s.status()).toMatchObject({ state: "failed", error: "the recognition worker stopped (second)" });
  });

  it("fails with the worker's reason when the restarted worker cannot load the release", () => {
    const s = start();
    workers()[0]!.reply(loaded);
    workers()[0]!.fail("first");
    workers()[1]!.reply({ kind: "release-status", ok: false, error: "the bank did not load", release: null, cards: [] });
    expect(s.status()).toMatchObject({ state: "failed", error: "the bank did not load" });
  });

  it("changes nothing after the session has stopped", () => {
    const s = start();
    workers()[0]!.reply(loaded);
    s.stop();
    workers()[0]!.fail("after stop");
    expect(s.status().state).toBe("stopped");
    expect(workers()).toHaveLength(1);
  });
});
