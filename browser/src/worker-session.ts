// SPDX-License-Identifier: Apache-2.0
// A session core and the analysis workers that serve it, for a host that owns no page: an
// extension's compute frame, or `createSession` itself.
//
// The worker's lifecycle:
//   - A worker that stops before the release has loaded fails the session ("the worker did not
//     start"). One that stops after it has loaded is ended, what it found is no longer shown, and
//     a new worker loads the bundled release once, without the geometric stage (`plainLoad`); a
//     second stop turns recognition off ("the recognition worker stopped"). A worker that cannot
//     even be made turns it off at once.
//   - Messages and errors from a worker that was replaced are ignored.
//
// With `chooseRelease` (remote/choose.ts) the page may run a remote release
// (docs/remote-releases.md, rules 10 to 12). It is tried at most once: when the worker refuses it
// (rule 10), loads another id (rule 11) or never starts, a new worker loads the bundled release
// (the choice's `fallback`, else `loadRequest`) without using up the restart; the refusal is
// skip-listed only as `refusalRecorded` says, another id always is. A remote worker that stops
// after loading restarts once, on the bundled release (rule 12). The card table built for the
// remote release is in effect (`release.table`) only once the worker has confirmed its id.

import type { AnalysisWidth } from "./capture.js";
import type { AnalysisMode } from "./cadence.js";
import type { GeometricStatus, WorkerReply, WorkerRequest } from "./messages.js";
import type { FrameAnalysis } from "./pipeline.js";
import type { CardTable } from "./remote/card-table.js";
import type { LoadRequest, ReleaseDecision, RemoteReleaseChoice } from "./remote/choose.js";
import { refusalRecorded, type ReleasePointer } from "./remote/pointer.js";
import { SessionCore, type SessionCoreDeps, type Shown, type ShownHold } from "./session-core.js";
import type { SessionStatus } from "./session.js";

/** The part of a Worker used here. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** How many times a worker that stops after the release has loaded is started again. */
export const WORKER_RESTARTS = 1;

/** The load request without the geometric stage: what a restarted worker loads. */
export function plainLoad(request: LoadRequest): LoadRequest {
  const { geometricUrl: _url, geometricManifestSha256: _sha, geometricWatchdog: _watchdog, ...plain } = request;
  return plain;
}

/** The release in effect. */
export interface ReleaseInEffect {
  /** "choosing" while `chooseRelease` decides. */
  source: "remote" | "bundled" | "choosing";
  /** The remote release's id once the worker confirmed it; null otherwise. */
  id: string | null;
  /** Why this source: the choice's reason, "ok", a fallback's reason or "worker-restart". */
  reason: string | null;
  /** The card table of the remote release, once the worker confirmed it; null otherwise. */
  table: CardTable | null;
}

export interface WorkerSessionEnv {
  /** Make an analysis worker (it may throw). */
  createWorker(): WorkerLike;
  /** The bundled release's load request, sent as is. */
  loadRequest: LoadRequest;
  /** The clock, in ms. */
  now(): number;
  mode?: AnalysisMode;
  /** Hold a shown card through short gaps (`SHOWN_HOLD`); off when absent. */
  hold?: ShownHold;
  /** Capture the picture now and answer the core with `frame` or `captureFailed`. */
  capture(requestId: number, analysisWidth: AnalysisWidth): void;
  onShown?(card: Shown | null): void;
  onStatus?(status: SessionStatus): void;
  onAnalysis?(analysis: FrameAnalysis): void;
  /** The geometric stage's state changed; also called with off / `worker-restarted` before a
   *  restarted worker loads, so that a restart can be told from the runtime turning the stage off. */
  onGeometricStatus?(status: GeometricStatus): void;
  /** Which release this page loads; absent: the bundled one, at once. A rejection loads the
   *  bundled one, with the reason `unexpected:<error>`. */
  chooseRelease?(hooks: { onDownloading(): void }): Promise<RemoteReleaseChoice>;
  /** Passed to `chooseRelease` as its `onDownloading` hook: a remote release's files are being
   *  fetched. */
  onDownloading?(): void;
  /** A remote release failed in a way that will fail again: do not try it for a while. */
  recordSkip?(pointer: ReleasePointer, reason: string): void;
  /** One decision per release chosen or left, for the log line (`decisionLine`). */
  onDecision?(decision: ReleaseDecision): void;
  /** Replaceable for tests (the core's `hoverAt`). */
  hoverAt?: SessionCoreDeps["hoverAt"];
  /** The time of the picture on screen now, when the host can read it (the core's
   *  `mediaTimeNow`). */
  mediaTimeNow?(): number;
}

export interface WorkerSession {
  /** Null only while `chooseRelease` decides. */
  readonly core: SessionCore | null;
  /** Recognition is off for good: the restart was used up, a worker could not be made, or `stop`. */
  readonly stopped: boolean;
  readonly restarts: number;
  readonly release: ReleaseInEffect;
  /** Call every `DRIVER_TICK_MS`. */
  tick(): void;
  /** End the worker and the core. */
  stop(): void;
}

type RemoteChoice = Extract<RemoteReleaseChoice, { source: "remote" }>;

export function createWorkerSession(env: WorkerSessionEnv): WorkerSession {
  let worker: WorkerLike | null = null;
  let core: SessionCore | null = null;
  let restarts = 0;
  let stopped = false;
  /** The remote release the current worker is loading, until it is confirmed or given up on. */
  let trying: RemoteChoice | null = null;
  let sawPreparing = false;
  /** The pointer id of the remote release in effect (for the log line of a restart). */
  let remotePointer: string | null = null;
  const release: ReleaseInEffect = { source: env.chooseRelease ? "choosing" : "bundled", id: null, reason: null, table: null };

  const decision = (d: Pick<ReleaseDecision, "source" | "reason" | "pointer"> & Partial<ReleaseDecision>): void => {
    env.onDecision?.({ reused: 0, downloaded: 0, ms: 0, ...d });
  };

  const makeCore = (request: LoadRequest): SessionCore =>
    new SessionCore(
      {
        now: env.now,
        toWorker: (r, transfer) => worker?.postMessage(r, transfer ?? []),
        capture: env.capture,
        ...(env.onShown ? { onShown: env.onShown } : {}),
        ...(env.onStatus ? { onStatus: env.onStatus } : {}),
        ...(env.onAnalysis ? { onAnalysis: env.onAnalysis } : {}),
        ...(env.onGeometricStatus ? { onGeometricStatus: env.onGeometricStatus } : {}),
        ...(env.hoverAt ? { hoverAt: env.hoverAt } : {}),
        ...(env.mediaTimeNow ? { mediaTimeNow: env.mediaTimeNow } : {}),
      },
      {
        ...(env.mode ? { mode: env.mode } : {}),
        ...(env.hold ? { hold: env.hold } : {}),
        geometric: request.geometricUrl !== undefined,
      },
    );

  const onReply = (reply: WorkerReply): void => {
    if (stopped || !core) return;
    if (trying && reply.kind === "release-progress" && reply.phase === "preparing") sawPreparing = true;
    if (reply.kind === "release-status") {
      // Only the answer to a load in progress: a late one changes nothing once loaded or failed.
      if (core.status().state !== "loading") return;
      if (trying && !onRemoteStatus(reply)) return;
    }
    core.fromWorker(reply);
  };

  /** The worker's verdict on a remote release. True: pass it on to the core. */
  const onRemoteStatus = (reply: Extract<WorkerReply, { kind: "release-status" }>): boolean => {
    const t = trying!;
    if (reply.ok && reply.release?.id === t.pointer.id) {
      trying = null;
      remotePointer = t.pointer.id;
      release.source = "remote";
      release.id = t.pointer.id;
      release.reason = "ok";
      release.table = t.facts;
      decision({ source: "remote", reason: "ok", pointer: t.pointer.id, reused: t.reused, downloaded: t.downloaded, ms: t.ms });
      return true;
    }
    if (reply.ok) {
      env.recordSkip?.(t.pointer, "id-mismatch");
      fallBack("id-mismatch");
      return false;
    }
    const why = reply.error ?? "no reason given";
    if (refusalRecorded(why, sawPreparing)) env.recordSkip?.(t.pointer, `runtime:${why.slice(0, 120)}`);
    fallBack(`runtime:${why}`);
    return false;
  };

  /** Fall back to the bundled release: a planned replacement, not a restart. */
  const fallBack = (reason: string): void => {
    const t = trying!;
    trying = null;
    worker?.terminate();
    release.source = "bundled";
    release.id = null;
    release.reason = reason;
    release.table = null;
    decision({ source: "bundled", reason, pointer: t.pointer.id, reused: t.reused, downloaded: t.downloaded, ms: t.ms });
    const request = t.fallback ?? env.loadRequest;
    // The stage's status and the load's progress follow the request now loading.
    core?.reloading({ geometric: request.geometricUrl !== undefined });
    startOrFail(request);
  };

  const onWorkerError = (event: ErrorEvent): void => {
    if (stopped || !core) return;
    const state = core.status().state;
    if (state === "failed" || state === "stopped") return;
    const reason = event.message || "see the console";
    if (trying) {
      // A remote release whose worker never started (or stopped while loading) falls back as a
      // refusal would; `refusalRecorded` leaves it off the skip-list.
      onRemoteStatus({ kind: "release-status", ok: false, error: `the worker did not start (${reason})`, release: null, cards: [] });
      return;
    }
    worker?.terminate();
    if (state === "loading" && restarts === 0) {
      core.workerStopped({ error: `the worker did not start (${reason})` });
      return;
    }
    if (restarts < WORKER_RESTARTS) {
      restarts += 1;
      // Shown cleared, the stage reported off, status loading: then the new worker.
      core.workerStopped({ restart: true });
      // The one restart always loads the bundled release (rule 12): the remote one is not tried
      // again in this page.
      if (release.source === "remote") {
        release.source = "bundled";
        release.id = null;
        release.reason = "worker-restart";
        release.table = null;
        decision({ source: "bundled", reason: "worker-restart", pointer: remotePointer });
      }
      // A restarted worker gets the plain load: the stage is not tried again in this page.
      startOrFail(plainLoad(env.loadRequest));
      return;
    }
    stopped = true;
    core.workerStopped({ error: `the recognition worker stopped (${reason})` });
  };

  const startWorker = (request: LoadRequest): void => {
    const w = env.createWorker();
    w.onmessage = (event) => {
      if (w === worker) onReply(event.data);
    };
    w.onerror = (event) => {
      if (w === worker) onWorkerError(event);
    };
    worker = w;
    w.postMessage(request);
  };

  /** A worker that cannot even be made: recognition is off for this page, as when a load fails. */
  const startOrFail = (request: LoadRequest): void => {
    core ??= makeCore(request);
    try {
      startWorker(request);
    } catch (error) {
      worker = null;
      trying = null;
      stopped = true;
      core.workerStopped({ error: `the recognition worker could not start (${String(error)})` });
    }
  };

  if (!env.chooseRelease) {
    startOrFail(env.loadRequest);
  } else {
    void env
      .chooseRelease({ onDownloading: () => env.onDownloading?.() })
      .catch((error: unknown): RemoteReleaseChoice => ({ source: "bundled", reason: `unexpected:${String(error)}`, pointer: null, downloaded: 0, ms: 0 }))
      .then((choice) => {
        if (stopped) return;
        if (choice.source === "remote") {
          trying = choice;
          sawPreparing = false;
          startOrFail(choice.request);
          return;
        }
        release.source = "bundled";
        release.reason = choice.reason;
        decision({ source: "bundled", reason: choice.reason, pointer: choice.pointer?.id ?? null, downloaded: choice.downloaded, ms: choice.ms });
        startOrFail(choice.request ?? env.loadRequest);
      });
  }

  return {
    get core() {
      return core;
    },
    get stopped() {
      return stopped;
    },
    get restarts() {
      return restarts;
    },
    get release() {
      return { ...release };
    },
    tick() {
      if (!stopped) core?.tick();
    },
    stop() {
      stopped = true;
      trying = null;
      worker?.terminate();
      worker = null;
      core?.stop();
    },
  };
}
