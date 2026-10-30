// SPDX-License-Identifier: Apache-2.0
// A session core and its workers: the worker's lifecycle (one restart after loading, without the
// geometric stage), and a remote release (docs/remote-releases.md, rules 10 to 12, 2.4 and 4).
import { describe, expect, it } from "vitest";

import type { AnalysisWidth } from "../src/capture.js";
import { DRIVER_TICK_MS } from "../src/frame-scheduler.js";
import type { GeometricStatus, ReleaseStatus, WorkerReply, WorkerRequest } from "../src/messages.js";
import type { FrameAnalysis } from "../src/pipeline.js";
import type { LoadRequest, ReleaseDecision, RemoteReleaseChoice } from "../src/remote/choose.js";
import { chosenBeforeFetch, fallbackRequest, parseGeometricPointer } from "../src/remote/geometric.js";
import type { ReleasePointer } from "../src/remote/pointer.js";
import type { Shown } from "../src/session-core.js";
import type { SessionStatus } from "../src/session.js";
import { createWorkerSession, plainLoad, WORKER_RESTARTS, type WorkerLike, type WorkerSessionEnv } from "../src/worker-session.js";

// A real Worker is a WorkerLike (checked by the compiler only).
export const workerIsWorkerLike = (w: Worker): WorkerLike => w;

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

const BUNDLED_URL = "extension://x/release/release.json";
const bundledLoad: LoadRequest = { kind: "load", releaseUrl: BUNDLED_URL, wasmPaths: "w/" };

const remoteChoice = (): RemoteReleaseChoice => ({
  source: "remote",
  pointer,
  request: { kind: "load", releaseUrl: "release.json", files: {}, wasmPaths: "w/" },
  facts: { "T-999": ["New Card", null, "full/T-999.jpg"] },
  reused: 2,
  downloaded: 4_400_000,
  ms: 12,
});

/** A hit test with one card, T-001, in the box x 100..300, y 100..400 of a 1000 x 500 frame. */
const hit = (_: FrameAnalysis, x: number, y: number) =>
  x >= 100 && x <= 300 && y >= 100 && y <= 400
    ? { card: null, boxIndex: 0, box: { x: 100, y: 100, width: 200, height: 300 }, cardId: "T-001", name: "Card One" }
    : { card: null, boxIndex: null, box: null, cardId: null, name: null };
const analysis = (): FrameAnalysis => ({ frame: { width: 1000, height: 500 }, hover: { selection: "accepted-nms", cards: [] }, boxes: [] }) as unknown as FrameAnalysis;

const bitmap = () => {
  const b = { closed: false, close() { this.closed = true; } };
  return b as unknown as ImageBitmap & { closed: boolean };
};

function harness(over: Partial<WorkerSessionEnv> = {}) {
  const out = {
    workers: [] as FakeWorker[],
    statuses: [] as SessionStatus[],
    shown: [] as Array<Shown | null>,
    geometric: [] as GeometricStatus[],
    skips: [] as string[],
    decisions: [] as ReleaseDecision[],
    captures: [] as Array<{ requestId: number; analysisWidth: AnalysisWidth }>,
    /** Every event in order, for the cases where order matters. */
    order: [] as string[],
  };
  const clock = { now: 1_000 };
  const env: WorkerSessionEnv = {
    createWorker: () => {
      const w = new FakeWorker();
      const post = w.postMessage.bind(w);
      w.postMessage = (m: unknown) => (out.order.push(`worker${out.workers.indexOf(w)}:${(m as { kind: string }).kind}`), post(m));
      out.workers.push(w);
      return w;
    },
    loadRequest: bundledLoad,
    now: () => clock.now,
    capture: (requestId, analysisWidth) => out.captures.push({ requestId, analysisWidth }),
    onShown: (card) => (out.shown.push(card), out.order.push(`shown:${card ? card.cardId : "null"}`)),
    onStatus: (s) => (out.statuses.push(s), out.order.push(`status:${s.state}`)),
    onGeometricStatus: (g) => (out.geometric.push(g), out.order.push(`geometric:${g.state}:${g.reason}`)),
    recordSkip: (_, reason) => out.skips.push(reason),
    onDecision: (d) => out.decisions.push(d),
    hoverAt: hit as never,
    ...over,
  };
  const session = createWorkerSession(env);
  return { session, out, clock, env };
}

/** With a `chooseRelease` that answers `choice`; resolved after the choice has been taken. */
async function setup(choice: RemoteReleaseChoice | Promise<RemoteReleaseChoice>, over: Partial<WorkerSessionEnv> = {}) {
  const h = harness({ chooseRelease: async () => choice, ...over });
  await new Promise((r) => setTimeout(r, 0));
  return h;
}

const statusOk = (id: string) => ({ kind: "release-status", ok: true, error: null, release: releaseOf(id), cards: [] });
const statusFail = (error: string) => ({ kind: "release-status", ok: false, error, release: null, cards: [] });
const loaded = (w: FakeWorker) => w.reply(statusOk("r"));
const isBundled = (w: FakeWorker) => w.posted[0]?.releaseUrl === BUNDLED_URL;
const made: FakeWorker[] = [];

/** Pointer over T-001, then the capture → picture → analysis round trip it starts. */
function showCard(h: ReturnType<typeof harness>, w: FakeWorker): void {
  const core = h.session.core!;
  core.pointer(0.2, 0.5, 1);
  const c = h.out.captures.at(-1)!;
  core.frame(c.requestId, bitmap(), 1);
  const request = w.posted.at(-1) as unknown as Extract<WorkerRequest, { kind: "frame" }>;
  w.reply({ kind: "frame-result", envelope: request.envelope, videoTimeSec: 1, width: 1000, height: 500, workerMs: 5, analysis: analysis() });
}

// ---------------------------------------------------------------------------------------------
// Ported from both products' compute-frame.test.ts (the worker's lifecycle).
describe("worker lifecycle", () => {
  it("loads the release it is given", () => {
    const { session, out } = harness();
    expect(session.core).not.toBeNull();
    expect(out.workers[0]!.posted[0]).toMatchObject({ kind: "load" });
  });

  it("reports a worker that fails before loading", () => {
    const { out } = harness();
    out.workers[0]!.fail("no wasm");
    expect(out.statuses.at(-1)).toMatchObject({ state: "failed", error: "the worker did not start (no wasm)" });
    expect(out.workers).toHaveLength(1);
  });

  it("restarts a worker that fails after loading once, then turns off", () => {
    const h = harness();
    const { session, out } = h;
    loaded(out.workers[0]!);
    showCard(h, out.workers[0]!);
    expect(out.shown.at(-1)?.cardId).toBe("T-001");
    out.workers[0]!.fail();
    expect(out.workers[0]!.terminated).toBe(true);
    expect(out.workers).toHaveLength(2);
    expect(out.workers[1]!.posted[0]).toMatchObject({ kind: "load" });
    expect(out.shown.at(-1)).toBeNull();
    expect(session.restarts).toBe(1);
    // A late message from the old worker is ignored.
    out.workers[0]!.reply({ kind: "release-status", ok: false, error: "late", release: null, cards: [] });
    expect(session.core!.status().state).toBe("loading");
    loaded(out.workers[1]!);
    expect(session.core!.status().state).toBe("ready");
    out.workers[1]!.fail("again");
    expect(out.workers).toHaveLength(2);
    expect(session.stopped).toBe(true);
    expect(out.statuses.at(-1)).toMatchObject({ state: "failed", error: "the recognition worker stopped (again)" });
    // Off: pictures are closed, not analyzed.
    const b = bitmap();
    session.core!.frame(1, b, 0);
    expect(b.closed).toBe(true);
  });

  it("sends the load request it is given, and reports the stage's state", () => {
    const loadRequest: LoadRequest = { kind: "load", releaseUrl: "r", wasmPaths: "w", geometricUrl: "extension://x/data/geometric.json", geometricManifestSha256: "7".repeat(64) };
    const { out } = harness({ loadRequest });
    expect(out.workers[0]!.posted[0]).toEqual(loadRequest);
    loaded(out.workers[0]!);
    out.workers[0]!.reply({ kind: "geometric-status", state: "ready", reason: null, bytes: 60_000_000 });
    expect(out.geometric).toEqual([{ kind: "geometric-status", state: "ready", reason: null, bytes: 60_000_000 }]);
  });

  it("sends the plain load to a restarted worker, and reports the stage off", () => {
    const loadRequest: LoadRequest = { kind: "load", releaseUrl: "r", wasmPaths: "w", geometricUrl: "g", geometricManifestSha256: "s" };
    const { out } = harness({ loadRequest });
    expect(out.workers[0]!.posted[0]).toEqual(loadRequest);
    loaded(out.workers[0]!);
    out.workers[0]!.fail();
    expect(out.workers[1]!.posted[0]).toEqual({ kind: "load", releaseUrl: "r", wasmPaths: "w" });
    expect(out.geometric).toContainEqual({ kind: "geometric-status", state: "off", reason: "worker-restarted", bytes: null });
  });

  it("sends the same plain load to the restarted worker (a build without the stage)", () => {
    const { out } = harness();
    expect(out.workers[0]!.posted[0]).toMatchObject({ kind: "load" });
    loaded(out.workers[0]!);
    out.workers[0]!.fail();
    expect(out.workers[1]!.posted[0]).toEqual(out.workers[0]!.posted[0]);
  });
});

// ---------------------------------------------------------------------------------------------
// Ported from both products' compute-frame-remote.test.ts.
describe("a remote release", () => {
  it("loads the remote release; once the worker confirms its id, its card table is in effect", async () => {
    const t = await setup(remoteChoice());
    expect(t.out.workers).toHaveLength(1);
    expect(t.out.workers[0]!.posted[0]).toMatchObject({ kind: "load", releaseUrl: "release.json" });
    expect(t.session.release.table).toBeNull();
    t.out.workers[0]!.reply(statusOk(ID));
    expect(t.session.release).toEqual({ source: "remote", id: ID, reason: "ok", table: { "T-999": ["New Card", null, "full/T-999.jpg"] } });
    expect(t.out.decisions).toEqual([{ source: "remote", reason: "ok", pointer: ID, reused: 2, downloaded: 4_400_000, ms: 12 }]);
  });

  it("10: a refusal before 'preparing' is recorded; a new worker loads the bundled release, without using the restart", async () => {
    const t = await setup(remoteChoice());
    t.out.workers[0]!.reply({ kind: "release-progress", phase: "downloading", bytes: 1 });
    t.out.workers[0]!.reply(statusFail("bank: sha256 of bank.json does not match the release"));
    expect(t.out.skips).toEqual(["runtime:bank: sha256 of bank.json does not match the release"]);
    expect(t.out.workers[0]!.terminated).toBe(true);
    expect(isBundled(t.out.workers[1]!)).toBe(true);
    expect(t.session.restarts).toBe(0);
    expect(t.out.statuses.some((s) => s.state === "failed")).toBe(false);
    t.out.workers[1]!.reply(statusOk(OTHER));
    expect(t.session.core!.status().state).toBe("ready");
    expect(t.session.release).toMatchObject({ source: "bundled", id: null });
  });

  it("10: a refusal after 'preparing', or the runtime's catch-all, is not recorded", async () => {
    const a = await setup(remoteChoice());
    a.out.workers[0]!.reply({ kind: "release-progress", phase: "preparing" });
    a.out.workers[0]!.reply(statusFail("detector: the model did not initialize on any execution provider"));
    expect(a.out.skips).toEqual([]);
    expect(isBundled(a.out.workers[1]!)).toBe(true);
    const b = await setup(remoteChoice());
    b.out.workers[0]!.reply(statusFail("unexpected: RangeError: memory"));
    expect(b.out.skips).toEqual([]);
  });

  it("10: a worker that never started falls back, not recorded", async () => {
    const t = await setup(remoteChoice());
    t.out.workers[0]!.fail("script error");
    expect(t.out.skips).toEqual([]);
    expect(isBundled(t.out.workers[1]!)).toBe(true);
    expect(t.session.restarts).toBe(0);
  });

  it("11: another id than the pointer's ends that worker, records it, and loads the bundled release; no card table", async () => {
    const t = await setup(remoteChoice());
    t.out.workers[0]!.reply(statusOk(OTHER));
    expect(t.out.skips).toEqual(["id-mismatch"]);
    expect(t.out.workers[0]!.terminated).toBe(true);
    expect(isBundled(t.out.workers[1]!)).toBe(true);
    t.out.workers[1]!.reply(statusOk(OTHER));
    expect(t.session.release).toMatchObject({ source: "bundled", id: null, table: null });
  });

  it("12: a remote worker that crashes after loading restarts once, on the bundled release; then the normal budget", async () => {
    const t = await setup(remoteChoice());
    t.out.workers[0]!.reply(statusOk(ID));
    t.out.workers[0]!.fail("crash");
    expect(t.session.restarts).toBe(1);
    expect(isBundled(t.out.workers[1]!)).toBe(true);
    expect(t.session.release).toEqual({ source: "bundled", id: null, reason: "worker-restart", table: null });
    t.out.workers[1]!.reply(statusOk(OTHER));
    t.out.workers[1]!.fail("again");
    expect(t.session.stopped).toBe(true);
    expect(t.out.workers).toHaveLength(2);
  });

  it("a bundled choice starts the bundled release and logs its reason", async () => {
    const t = await setup({ source: "bundled", reason: "same-as-bundled", pointer, downloaded: 0, ms: 1 });
    expect(isBundled(t.out.workers[0]!)).toBe(true);
    expect(t.out.decisions).toEqual([{ source: "bundled", reason: "same-as-bundled", pointer: ID, reused: 0, downloaded: 0, ms: 1 }]);
    expect(t.session.release).toMatchObject({ source: "bundled", reason: "same-as-bundled" });
  });

  it("while it chooses, has no core and no worker", async () => {
    let resolve!: (c: RemoteReleaseChoice) => void;
    const t = await setup(new Promise<RemoteReleaseChoice>((r) => (resolve = r)));
    expect(t.session.core).toBeNull();
    expect(t.session.release.source).toBe("choosing");
    expect(t.out.workers).toEqual([]);
    t.session.tick();
    resolve(remoteChoice());
    await new Promise((r) => setTimeout(r, 0));
    expect(t.out.workers).toHaveLength(1);
    expect(t.session.core).not.toBeNull();
  });

  it("ignores late messages and errors from the remote worker it replaced", async () => {
    const t = await setup(remoteChoice());
    t.out.workers[0]!.reply(statusFail("bank: sha256 of bank.json does not match the release"));
    t.out.workers[0]!.reply(statusOk(ID));
    t.out.workers[0]!.fail("late");
    expect(t.out.workers).toHaveLength(2);
    expect(t.session.release.source).toBe("bundled");
    expect(t.session.restarts).toBe(0);
  });

  it("an error after 'preparing' falls back, not recorded", async () => {
    const t = await setup(remoteChoice());
    t.out.workers[0]!.reply({ kind: "release-progress", phase: "preparing" });
    t.out.workers[0]!.fail("out of memory");
    expect(t.out.skips).toEqual([]);
    expect(isBundled(t.out.workers[1]!)).toBe(true);
  });

  it("2.4: a bundled fallback that then fails to load turns recognition off, as today", async () => {
    const t = await setup(remoteChoice());
    t.out.workers[0]!.reply(statusOk(OTHER));
    t.out.workers[1]!.reply(statusFail("no execution provider to try"));
    expect(t.session.core!.status().state).toBe("failed");
    expect(t.out.statuses.some((s) => s.state === "failed")).toBe(true);
    expect(t.out.workers).toHaveLength(2);
  });

  it("a worker that cannot be made turns recognition off instead of hanging", async () => {
    const t = await setup(remoteChoice(), {
      createWorker: () => {
        throw new Error("blocked");
      },
    });
    expect(t.session.stopped).toBe(true);
    expect(t.out.statuses.some((s) => s.state === "failed")).toBe(true);
  });

  it("12: the restart's log line names the remote release it leaves", async () => {
    const t = await setup(remoteChoice());
    t.out.workers[0]!.reply(statusOk(ID));
    t.out.workers[0]!.fail("crash");
    expect(t.out.decisions.at(-1)).toMatchObject({ source: "bundled", reason: "worker-restart", pointer: ID });
  });

  it("release.table is set only after the worker confirms the release", async () => {
    let resolve!: (c: RemoteReleaseChoice) => void;
    const t = await setup(new Promise<RemoteReleaseChoice>((r) => (resolve = r)));
    expect(t.session.release.table).toBeNull();
    const table = { "T-999": ["New Card", null, "full/T-999.jpg"], "T-998": ["Never Shown", null, null] } as const;
    resolve({ ...(remoteChoice() as Extract<RemoteReleaseChoice, { source: "remote" }>), facts: table as never });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.session.release.table).toBeNull();
    t.out.workers[0]!.reply({ kind: "release-progress", phase: "preparing" });
    expect(t.session.release.table).toBeNull();
    t.out.workers[0]!.reply(statusOk(ID));
    expect(t.session.release.table).toEqual(table);
    // A copy of the release in effect: changing it changes nothing.
    t.session.release.id = "x";
    expect(t.session.release.id).toBe(ID);
  });

  it("with no pointer, the worker gets the bundled request exactly as before pointers", async () => {
    const t = await setup({ source: "bundled", reason: "absent", pointer: null, downloaded: 0, ms: 0 });
    expect(t.out.workers).toHaveLength(1);
    expect(t.out.workers[0]!.posted).toEqual([{ kind: "load", releaseUrl: BUNDLED_URL, wasmPaths: "w/" }]);
  });

  it("4: a fallback whose worker cannot be made turns recognition off", async () => {
    let n = 0;
    const t = await setup(remoteChoice(), {
      createWorker: () => {
        n += 1;
        if (n > 1) throw new Error("blocked");
        const w = new FakeWorker();
        made.push(w);
        return w;
      },
    });
    made[0]!.reply(statusFail("bank: sha256 of bank.json does not match the release"));
    expect(t.session.stopped).toBe(true);
    expect(t.out.statuses.some((s) => s.state === "failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The products' frame.ts behaviors the plan names (its K3 a-c).
describe("the bundled release's own request, the restart's stage report, a choice that throws", () => {
  const GEO_SHA = "c".repeat(64);
  const stagedLoad: LoadRequest = { ...bundledLoad, geometricUrl: "extension://x/data/geometric.json", geometricManifestSha256: GEO_SHA };
  const fieldWith = (manifestSha256: string) => ({ id: ID, geometric: { path: `vision/releases/${ID}/geometric.json`, sha256: "b".repeat(64), manifestSha256 } });

  /** A product's `chooseRelease` wrapper over the remote module's rules, as an extension builds it:
   *  chosen before anything was fetched, the choice as is; after a pointer was read, the bundled
   *  release with `fallbackRequest` (the stage off unless the pointer's index is the bundled one). */
  const wrapper = (choice: RemoteReleaseChoice, field: unknown) => async (): Promise<RemoteReleaseChoice> => {
    const geo = parseGeometricPointer(field);
    if (choice.source === "bundled") return chosenBeforeFetch(choice.reason) ? choice : { ...choice, request: fallbackRequest(stagedLoad, geo) };
    return { ...choice, fallback: fallbackRequest(stagedLoad, geo) };
  };

  it("a bundled choice loads its own request when it has one", async () => {
    const own: LoadRequest = { kind: "load", releaseUrl: BUNDLED_URL, wasmPaths: "own/" };
    const t = await setup({ source: "bundled", reason: "absent", pointer: null, downloaded: 0, ms: 0, request: own }, { loadRequest: stagedLoad });
    expect(t.out.workers[0]!.posted).toEqual([own]);
  });

  it("chosen before anything was fetched, the bundled release keeps its stage", async () => {
    const choice: RemoteReleaseChoice = { source: "bundled", reason: "version", pointer, downloaded: 0, ms: 0 };
    const t = harness({ loadRequest: stagedLoad, chooseRelease: wrapper(choice, fieldWith("d".repeat(64))) });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.out.workers[0]!.posted).toEqual([stagedLoad]);
  });

  it("after a pointer was read, the bundled release loads with the stage off, unless the pointer's index is the bundled one", async () => {
    const choice: RemoteReleaseChoice = { source: "bundled", reason: "document-sha", pointer, downloaded: 10, ms: 3 };
    const off = harness({ loadRequest: stagedLoad, chooseRelease: wrapper(choice, fieldWith("d".repeat(64))) });
    const same = harness({ loadRequest: stagedLoad, chooseRelease: wrapper(choice, fieldWith(GEO_SHA)) });
    await new Promise((r) => setTimeout(r, 0));
    expect(off.out.workers[0]!.posted).toEqual([bundledLoad]);
    expect(off.session.core!.status().geometric).toBeNull();
    expect(same.out.workers[0]!.posted).toEqual([stagedLoad]);
    expect(same.session.core!.status().geometric).toEqual({ state: "loading", reason: null, bytes: null });
  });

  it("a remote release refused falls back on the choice's fallback request", async () => {
    const t = harness({ loadRequest: stagedLoad, chooseRelease: wrapper(remoteChoice(), fieldWith("d".repeat(64))) });
    await new Promise((r) => setTimeout(r, 0));
    t.out.workers[0]!.reply(statusOk(OTHER));
    expect(t.out.workers[1]!.posted).toEqual([bundledLoad]);
  });

  it("on the one restart, reports the stage off as worker-restarted before the new worker loads", () => {
    const h = harness({ loadRequest: stagedLoad });
    loaded(h.out.workers[0]!);
    h.out.order.length = 0;
    h.out.workers[0]!.fail("crash");
    expect(h.out.order).toEqual(["geometric:off:worker-restarted", "status:loading", "worker1:load"]);
  });

  it("a choice that throws loads the bundled release, with the reason unexpected:<error>", async () => {
    const t = harness({
      chooseRelease: async () => {
        throw new Error("storage gone");
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.session.release).toEqual({ source: "bundled", id: null, reason: "unexpected:Error: storage gone", table: null });
    expect(t.out.decisions).toEqual([{ source: "bundled", reason: "unexpected:Error: storage gone", pointer: null, reused: 0, downloaded: 0, ms: 0 }]);
    expect(t.out.workers[0]!.posted).toEqual([bundledLoad]);
  });

  it("passes chooseRelease an onDownloading hook that reaches the host", async () => {
    let downloading = 0;
    const t = harness({
      onDownloading: () => (downloading += 1),
      chooseRelease: async (hooks) => {
        hooks.onDownloading();
        return remoteChoice();
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(downloading).toBe(1);
    expect(t.out.workers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Ported from session-worker.test.ts (the toolkit's 0.5.1 restart rule, there through createSession).
describe("a worker that stops with an error", () => {
  const staged: LoadRequest = { kind: "load", releaseUrl: "https://example.test/demo/release.json", geometricUrl: "https://example.test/demo/geometric/settings.json", geometricManifestSha256: "ab".repeat(32) };
  const start = (withGeometric = true) => harness({ loadRequest: withGeometric ? staged : plainLoad(staged) });
  const state = (h: ReturnType<typeof harness>) => h.session.core!.status();

  it("fails the session when it stops before the release has loaded, without a restart", () => {
    const h = start();
    h.out.workers[0]!.fail("no module");
    expect(state(h)).toMatchObject({ state: "failed", error: "the worker did not start (no module)" });
    expect(h.out.workers).toHaveLength(1);
    expect(h.out.workers[0]!.terminated).toBe(true);
  });

  it("is restarted once after the release has loaded, on the same release without the geometric stage", () => {
    const h = start();
    const first = h.out.workers[0]!;
    expect(first.posted[0]).toMatchObject({ kind: "load", geometricUrl: "https://example.test/demo/geometric/settings.json" });
    loaded(first);
    first.reply({ kind: "geometric-status", state: "ready", reason: null, bytes: 10 });
    expect(state(h).state).toBe("ready");

    first.fail("out of memory");
    expect(first.terminated).toBe(true);
    expect(h.out.workers).toHaveLength(2);
    const second = h.out.workers[1]!;
    expect(second.posted).toEqual([plainLoad(first.posted[0] as unknown as LoadRequest)]);
    expect(second.posted[0]).not.toHaveProperty("geometricUrl");
    expect(second.posted[0]).not.toHaveProperty("geometricManifestSha256");
    expect(second.posted[0]).toMatchObject({ kind: "load", releaseUrl: "https://example.test/demo/release.json" });
    expect(state(h)).toMatchObject({ state: "loading", error: null, geometric: { state: "off", reason: "worker-restarted", bytes: null } });
    expect(h.session.core!.analysis()).toBeNull();

    loaded(second);
    expect(state(h).state).toBe("ready");
  });

  it("ends recognition when the restarted worker stops too", () => {
    const h = start();
    loaded(h.out.workers[0]!);
    h.out.workers[0]!.fail("first");
    loaded(h.out.workers[1]!);
    h.out.workers[1]!.fail("second");
    expect(state(h)).toMatchObject({ state: "failed", error: "the recognition worker stopped (second)" });
    expect(h.out.workers).toHaveLength(1 + WORKER_RESTARTS);
    expect(h.out.workers[1]!.terminated).toBe(true);
  });

  it("ends recognition when the restarted worker stops before it has loaded", () => {
    const h = start();
    loaded(h.out.workers[0]!);
    h.out.workers[0]!.fail("first");
    h.out.workers[1]!.fail("second");
    expect(state(h)).toMatchObject({ state: "failed", error: "the recognition worker stopped (second)" });
    expect(h.out.workers).toHaveLength(2);
  });

  it("drops the shown result and the look in flight when the worker stops", () => {
    const h = harness({ mode: "always-on" });
    const first = h.out.workers[0]!;
    const core = h.session.core!;
    const release = { recognizer: { ep: "wasm" }, hoverMaxAgeMs: 1_000, analysisWidth: { min: 720, max: 1920 } } as unknown as NonNullable<ReleaseStatus["release"]>;
    first.reply({ kind: "release-status", ok: true, error: null, release, cards: [] });
    /** Ticks for `ms`, answering each capture with a picture. */
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += DRIVER_TICK_MS) {
        h.clock.now += DRIVER_TICK_MS;
        const before = h.out.captures.length;
        h.session.tick();
        if (h.out.captures.length > before) core.frame(h.out.captures.at(-1)!.requestId, bitmap(), 0);
      }
    };
    run(DRIVER_TICK_MS);
    const look = first.posted.find((m) => m.kind === "frame") as unknown as Extract<WorkerRequest, { kind: "frame" }> | undefined;
    expect(look).toBeDefined();
    const result = analysis();
    first.reply({ kind: "frame-result", envelope: look!.envelope, videoTimeSec: 0, width: 640, height: 360, workerMs: 5, analysis: result });
    expect(core.analysis()).toBe(result);

    run(DRIVER_TICK_MS * 4);
    expect(first.posted.filter((m) => m.kind === "frame").length).toBeGreaterThan(1);
    first.fail("crashed during a look");
    expect(core.analysis()).toBeNull();
    const second = h.out.workers[1]!;
    second.reply({ kind: "release-status", ok: true, error: null, release, cards: [] });
    // The restarted worker gets looks again (at the release's cadence).
    run(5_000);
    expect(second.posted.some((m) => m.kind === "frame")).toBe(true);
  });

  it("ignores what a replaced worker still sends", () => {
    const h = start();
    const first = h.out.workers[0]!;
    loaded(first);
    first.fail("first");
    loaded(first);
    first.fail("late");
    expect(state(h).state).toBe("loading");
    expect(h.out.workers).toHaveLength(2);
  });

  it("restarts without a geometric status when no stage was asked for", () => {
    const h = start(false);
    loaded(h.out.workers[0]!);
    h.out.workers[0]!.fail("first");
    expect(state(h).geometric).toBeNull();
    expect(h.out.workers[1]!.posted[0]).toEqual(h.out.workers[0]!.posted[0]);
  });

  it("ends the restarted worker when the session stops", () => {
    const h = start();
    loaded(h.out.workers[0]!);
    h.out.workers[0]!.fail("first");
    h.session.stop();
    expect(h.out.workers[1]!.terminated).toBe(true);
    expect(state(h).state).toBe("stopped");
  });

  it("is not made ready again by a load answer that arrives after it failed", () => {
    const h = start();
    loaded(h.out.workers[0]!);
    h.out.workers[0]!.fail("first");
    h.out.workers[1]!.fail("second");
    loaded(h.out.workers[1]!);
    expect(state(h)).toMatchObject({ state: "failed", error: "the recognition worker stopped (second)" });
  });

  it("fails with the worker's reason when the restarted worker cannot load the release", () => {
    const h = start();
    loaded(h.out.workers[0]!);
    h.out.workers[0]!.fail("first");
    h.out.workers[1]!.reply({ kind: "release-status", ok: false, error: "the bank did not load", release: null, cards: [] });
    expect(state(h)).toMatchObject({ state: "failed", error: "the bank did not load" });
  });

  it("changes nothing after the session has stopped", () => {
    const h = start();
    loaded(h.out.workers[0]!);
    h.session.stop();
    h.out.workers[0]!.fail("after stop");
    expect(state(h).state).toBe("stopped");
    expect(h.out.workers).toHaveLength(1);
  });
});

describe("plainLoad", () => {
  it("drops the geometric stage's fields and keeps the rest", () => {
    const load: LoadRequest = {
      kind: "load", releaseUrl: "r.json", providers: ["wasm"], geometricUrl: "g.json",
      geometricManifestSha256: "00", geometricWatchdog: false,
    };
    expect(plainLoad(load)).toEqual({ kind: "load", releaseUrl: "r.json", providers: ["wasm"] });
  });
});

// ---------------------------------------------------------------------------------------------
describe("the status across workers", () => {
  it("a remote release with a stage, refused after 'preparing', falls back without one: no stage status, no stale progress", async () => {
    const staged: RemoteReleaseChoice = {
      ...(remoteChoice() as Extract<RemoteReleaseChoice, { source: "remote" }>),
      request: { kind: "load", releaseUrl: "release.json", files: {}, wasmPaths: "w/", geometricUrl: "g", geometricManifestSha256: "e".repeat(64) },
    };
    const t = await setup(staged);
    expect(t.session.core!.status().geometric).toEqual({ state: "loading", reason: null, bytes: null });
    t.out.workers[0]!.reply({ kind: "release-progress", phase: "preparing", bytes: null });
    expect(t.session.core!.status().loading).toEqual({ phase: "preparing", bytes: null });
    t.out.workers[0]!.reply(statusFail("detector: the model did not initialize on any execution provider"));
    expect(t.out.workers[1]!.posted).toEqual([bundledLoad]);
    expect(t.session.core!.status()).toMatchObject({ state: "loading", geometric: null, loading: null });
    t.out.workers[1]!.reply(statusOk(OTHER));
    expect(t.session.core!.status()).toMatchObject({ state: "ready", geometric: null });
  });

  it("a fallback with a stage starts its stage status again as loading", async () => {
    const fallback: LoadRequest = { ...bundledLoad, geometricUrl: "g", geometricManifestSha256: "e".repeat(64) };
    const t = await setup({ ...(remoteChoice() as Extract<RemoteReleaseChoice, { source: "remote" }>), fallback });
    expect(t.session.core!.status().geometric).toBeNull();
    t.out.workers[0]!.reply(statusOk(OTHER));
    expect(t.out.workers[1]!.posted).toEqual([fallback]);
    expect(t.session.core!.status().geometric).toEqual({ state: "loading", reason: null, bytes: null });
  });

  it("a release-status after the release has loaded, or after it failed, is not applied", () => {
    const ready = harness();
    loaded(ready.out.workers[0]!);
    ready.out.workers[0]!.reply(statusFail("late refusal"));
    expect(ready.session.core!.status()).toMatchObject({ state: "ready", error: null });
    const failed = harness();
    failed.out.workers[0]!.reply(statusFail("release: HTTP 404"));
    failed.out.workers[0]!.reply(statusOk("r"));
    expect(failed.session.core!.status()).toMatchObject({ state: "failed", error: "release: HTTP 404" });
  });

  it("a worker that cannot be made on the restart turns recognition off, after logging the restart", async () => {
    let n = 0;
    const workers: FakeWorker[] = [];
    const t = await setup(remoteChoice(), {
      createWorker: () => {
        n += 1;
        if (n > 1) throw new Error("blocked");
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    workers[0]!.reply(statusOk(ID));
    workers[0]!.fail("crash");
    expect(t.session.stopped).toBe(true);
    expect(t.session.restarts).toBe(1);
    expect(t.session.core!.status()).toMatchObject({ state: "failed", error: "the recognition worker could not start (Error: blocked)" });
    expect(t.out.decisions.at(-1)).toMatchObject({ source: "bundled", reason: "worker-restart", pointer: ID });
  });

  it("a worker that cannot be made, with no chooseRelease, turns recognition off", () => {
    const h = harness({
      createWorker: () => {
        throw new Error("blocked");
      },
    });
    expect(h.session.stopped).toBe(true);
    expect(h.session.core!.status()).toMatchObject({ state: "failed", error: "the recognition worker could not start (Error: blocked)" });
    expect(h.out.statuses.at(-1)).toMatchObject({ state: "failed" });
    h.session.tick();
    h.session.stop();
  });
});

// ---------------------------------------------------------------------------------------------
describe("stopping", () => {
  it("stop ends the worker and the core; a later tick asks for nothing", () => {
    const h = harness();
    loaded(h.out.workers[0]!);
    h.session.stop();
    expect(h.out.workers[0]!.terminated).toBe(true);
    expect(h.session.stopped).toBe(true);
    expect(h.session.core!.status().state).toBe("stopped");
    h.session.core!.pointer(0.2, 0.5, 1);
    h.session.tick();
    expect(h.out.captures).toEqual([]);
  });

  it("stopped while it chooses, it starts no worker once the choice comes", async () => {
    let resolve!: (c: RemoteReleaseChoice) => void;
    const t = await setup(new Promise<RemoteReleaseChoice>((r) => (resolve = r)));
    t.session.stop();
    resolve(remoteChoice());
    await new Promise((r) => setTimeout(r, 0));
    expect(t.out.workers).toEqual([]);
    expect(t.session.core).toBeNull();
  });
});

describe("mediaTimeNow", () => {
  it("reaches the core: the max-age rule reads the host's live time", () => {
    let live = 1;
    const h = harness({ mediaTimeNow: () => live });
    const w = h.out.workers[0]!;
    loaded(w);
    showCard(h, w);
    expect(h.session.core!.analysis()).not.toBeNull();
    // Nothing reported: the live time alone moves the picture past hoverMaxAgeMs (2000).
    live = 4;
    expect(h.session.core!.analysis()).toBeNull();
  });
});
