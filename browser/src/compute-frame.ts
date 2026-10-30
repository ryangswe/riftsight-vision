// SPDX-License-Identifier: Apache-2.0
// The compute frame's side of the two-frame contract (compute-messages.ts,
// docs/extension-session.md): a hidden extension frame inside the video page hosts the session
// core and its worker (worker-session.ts), and talks to the content script in that page.
//
//   - It starts only inside a page the extension serves (`allowedParentOrigin`, the extension's
//     own list), and then acts only on messages from that page's window, from that origin. It
//     posts only to that window, with that origin.
//   - It says `ready` (its `PROTOCOL_VERSION` and its `instance`) once on its own, as soon as a
//     session core can take the content script's messages (so the first `presented` is not lost);
//     never again on its own, not on a fallback or a restart. A core that could not even start its
//     worker counts: `ready` is followed by the `failed` status.
//   - It answers each `hello` from its parent, once a core exists, with `ready`, the current
//     status and the current shown card, whatever the hello's version (the content script
//     compares). A hello changes nothing else: no worker or core is made again. A hello while it
//     chooses a release is ignored: the unsolicited `ready` follows once the core exists.
//   - A picture it does not take is closed here, never kept: one in a message from elsewhere, one
//     that arrives while it has no core or is off, and one attached to any message but `frame`,
//     even when the core or a product hook throws. A `frame`'s picture belongs to the core from
//     the moment `core.frame` is called: the core closes it or sends it to the worker.
//   - The status it posts is the state, the error and, once ready, the backend (null while
//     loading, a restarted worker included, and when failed), the error and the backend cut to
//     `MAX_TEXT_LENGTH`. A status is posted when one of these changes, "loading" whenever a remote
//     release's files start to download, and on a hello.
//   - A shown card goes to `onShown` first, then to the content script: an extension that sends a
//     card's details by a channel of its own (from `release.table`) has them out before the card.
//     A card of a remote release whose id the worker confirmed carries that id (`releaseId`).
//
// Nothing here runs on its own: the caller calls `tick()` every `DRIVER_TICK_MS`.

import { type ComputeIn, type ComputeOut, type ComputeProtocol, MAX_FRAME_SIDE, MAX_TEXT_LENGTH, PROTOCOL_VERSION, type ShownCard } from "./compute-messages.js";
import type { SessionCore, Shown } from "./session-core.js";
import type { SessionStatus } from "./session.js";
import { createWorkerSession, type ReleaseInEffect, type WorkerSession, type WorkerSessionEnv } from "./worker-session.js";

/** The part of the compute frame's window used here. */
export interface ComputeFrameWindow {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface ComputeFrameEnv extends Omit<WorkerSessionEnv, "capture" | "onShown" | "onStatus"> {
  /** The frame's own window (`window`). */
  win: ComputeFrameWindow;
  /** Whether the frame is inside another page at all (`window.parent !== window`). */
  framed: boolean;
  /** The embedding page's origin (`location.ancestorOrigins[0]`), or null. */
  parentOrigin: string | null;
  /** Whether the frame may serve a page of this origin (the extension's own list). */
  allowedParentOrigin(origin: string): boolean;
  /** The contract under the extension's tag (`computeProtocol(tag)`). */
  protocol: ComputeProtocol;
  /** A card is about to be posted as shown (null: nothing is shown), with the release in effect.
   *  Called before every post, the one answering a `hello` included. */
  onShown?(card: ShownCard | null, release: ReleaseInEffect): void;
  /** Makes the frame's `instance` (16 lowercase hex characters); random by default. For tests. */
  instanceId?(): string;
}

export interface ComputeFrame {
  /** Null only while `chooseRelease` decides. */
  readonly core: SessionCore | null;
  /** Recognition is off for good in this page. */
  readonly stopped: boolean;
  readonly restarts: number;
  readonly release: ReleaseInEffect;
  /** The `instance` this frame says in `ready`. */
  readonly instance: string;
  /** Call every `DRIVER_TICK_MS`. */
  tick(): void;
  /** End the worker and the core, and stop listening. */
  stop(): void;
}

const INSTANCE = /^[0-9a-f]{16}$/;

/** A random frame instance: 16 lowercase hex characters. */
function randomInstance(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Start the compute frame, or return null when it is not inside a page it may serve. */
export function startComputeFrame(env: ComputeFrameEnv): ComputeFrame | null {
  const parentOrigin = env.parentOrigin;
  if (!env.framed || parentOrigin === null || !env.allowedParentOrigin(parentOrigin)) return null;
  const { win, protocol } = env;
  const instance = (env.instanceId ?? randomInstance)();
  if (typeof instance !== "string" || !INSTANCE.test(instance)) throw new TypeError(`startComputeFrame: not an instance id: ${String(instance)}`);
  const post = (message: ComputeOut): void => win.parent.postMessage(protocol.tag(message), parentOrigin);
  const postReady = (): void => post({ kind: "ready", version: PROTOCOL_VERSION, instance });

  let readyPosted = false;
  const sayReady = (): void => {
    if (readyPosted) return;
    readyPosted = true;
    postReady();
  };

  type StatusState = "loading" | "ready" | "failed";
  /** What the content script was last told (it assumes "loading" until told otherwise). */
  let lastStatus: { state: StatusState; error: string | null; backend: string | null } = { state: "loading", error: null, backend: null };
  const cut = (text: string | null): string | null => (text === null ? null : text.slice(0, MAX_TEXT_LENGTH));
  const postStatus = (state: StatusState, error: string | null, backend: string | null, always = false): void => {
    const next = { state, error: cut(error), backend: cut(backend) };
    if (!always && next.state === lastStatus.state && next.error === lastStatus.error && next.backend === lastStatus.backend) return;
    lastStatus = next;
    post({ kind: "status", ...next });
  };
  const onStatus = (status: SessionStatus): void => {
    if (status.state === "stopped") return;
    // The backend only once ready: a restarted worker's core keeps the old one until it answers,
    // and the content script is told "loading" with none, as for the first load.
    postStatus(status.state, status.error, status.state === "ready" ? status.backend : null);
  };

  let session: WorkerSession | null = null;
  const releaseNow = (): ReleaseInEffect =>
    session?.release ?? { source: env.chooseRelease ? "choosing" : "bundled", id: null, reason: null, table: null };

  /** The card the content script was last told of (null: nothing). */
  let lastCard: ShownCard | null = null;
  const postShown = (card: ShownCard | null): void => {
    lastCard = card;
    env.onShown?.(card, releaseNow());
    post({ kind: "shown", card });
  };
  const onShown = (shown: Shown | null): void => {
    const release = releaseNow();
    const card: ShownCard | null = shown
      ? {
          cardId: shown.cardId,
          name: shown.name,
          ...(release.source === "remote" && release.id !== null ? { releaseId: release.id } : {}),
          box: { ...shown.box },
          others: shown.others.map((b) => ({ ...b })),
        }
      : null;
    postShown(card);
  };

  const {
    win: _win,
    framed: _framed,
    parentOrigin: _origin,
    allowedParentOrigin: _allowed,
    protocol: _protocol,
    onShown: _onShown,
    instanceId: _instanceId,
    ...rest
  } = env;
  const ws = createWorkerSession({
    ...rest,
    // The worker session makes its core before its first worker: a core exists from here on, so
    // the content script may send (a failed start still reports its status after `ready`).
    createWorker: () => {
      sayReady();
      return env.createWorker();
    },
    // A release may allow a wider frame than this contract carries: ask for at most MAX_FRAME_SIDE.
    capture: (requestId, analysisWidth) => {
      const max = Math.min(analysisWidth.max, MAX_FRAME_SIDE);
      post({ kind: "capture", requestId, analysisWidth: { min: Math.min(analysisWidth.min, max), max } });
    },
    onShown,
    onStatus,
    onDownloading: () => {
      postStatus("loading", null, null, true);
      env.onDownloading?.();
    },
  });
  session = ws;
  if (ws.core) sayReady();

  /** A hello: `ready`, then what the content script would have been told since. Nothing else
   *  changes. Always posted, whatever the hello's version. */
  const answerHello = (): void => {
    postReady();
    postStatus(lastStatus.state, lastStatus.error, lastStatus.backend, true);
    postShown(lastCard);
  };

  const deliver = (core: SessionCore, message: Exclude<ComputeIn, { kind: "hello" }>): void => {
    switch (message.kind) {
      case "pointer":
        core.pointer(message.x, message.y, message.mediaTime, message.touch);
        return;
      case "leave":
        core.pointerLeft();
        return;
      case "presented":
        core.presented(message.mediaTime);
        return;
      case "discontinuity":
        core.discontinuity(message.newSource);
        return;
      case "cut":
        core.cut();
        return;
      case "frame":
        core.frame(message.requestId, message.bitmap, message.mediaTime);
        return;
      case "capture-failed":
        core.captureFailed(message.requestId, message.reason, message.retry === true);
        return;
    }
  };

  const listener = (event: MessageEvent): void => {
    const fromParent = event.source === win.parent && event.origin === parentOrigin;
    const message = fromParent ? protocol.parseComputeIn(event.data) : null;
    const core = ws.core;
    let taken: unknown = null;
    try {
      if (message?.kind === "hello") {
        // Answered once a core exists, even when off: the content script learns it failed.
        if (core) answerHello();
      } else if (message && core && !ws.stopped) {
        // The frame's picture is the core's from this call on, even if it throws.
        if (message.kind === "frame") taken = message.bitmap;
        deliver(core, message);
      }
    } finally {
      // Any other picture in the message is closed here, never kept.
      closePictures(event.data, taken);
    }
  };
  win.addEventListener("message", listener);

  return {
    get core() {
      return ws.core;
    },
    get stopped() {
      return ws.stopped;
    },
    get restarts() {
      return ws.restarts;
    },
    get release() {
      return ws.release;
    },
    instance,
    tick() {
      ws.tick();
    },
    stop() {
      // The listener goes first: a product hook that throws while the session stops must not
      // leave it attached.
      win.removeEventListener("message", listener);
      ws.stop();
    },
  };
}

/** Close every picture (`ImageBitmap`) among the message's fields but `keep`. */
function closePictures(data: unknown, keep: unknown): void {
  if (typeof ImageBitmap === "undefined" || typeof data !== "object" || data === null) return;
  for (const value of Object.values(data)) {
    if (value !== keep && value instanceof ImageBitmap) value.close();
  }
}
