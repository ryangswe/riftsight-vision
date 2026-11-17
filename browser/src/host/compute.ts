// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): the compute realm. It starts the compute frame with the
// standard options (hover spec, "The standard options"), checks the embedding page's origin first,
// and owns the driver tick and the page-hide stop.

import { type ComputeFrame, type ComputeFrameEnv, type ComputeFrameWindow, startComputeFrame } from "../compute-frame.js";
import { computeProtocol } from "../compute-messages.js";
import { DRIVER_TICK_MS } from "../frame-scheduler.js";
import type { LoadRequest } from "../remote/choose.js";
import { READING_HOLD, SHOWN_HOLD } from "../session-core.js";
import type { ReleaseInEffect, WorkerLike } from "../worker-session.js";
import type { ProductConfig } from "./config.js";
import type { KeyValueStorage, StorageChanges } from "./settings-core.js";
import { allowedParentOrigin } from "./site-policy.js";
import { createSwitches } from "./switches.js";

export type { ComputeFrame, LoadRequest, ReleaseInEffect, WorkerLike };

export interface HostComputeEnv {
  config: ProductConfig;
  /** The host works out `framed` (`parent !== win`) and `parentOrigin` (`location.ancestorOrigins?.[0]`,
   *  with "null" or none meaning none) itself. No parent: start is refused.
   *  No fallback to document.referrer or parent.location. */
  win: ComputeFrameWindow & { parent: unknown; location: { ancestorOrigins?: ArrayLike<string> } };
  storage: Pick<KeyValueStorage, "get">;
  createWorker(): WorkerLike;
  /** Called once, after the origin check passes; never for a page that gives null. */
  loadRequest: () => LoadRequest | Promise<LoadRequest>;
  release?: Pick<ComputeFrameEnv, "chooseRelease" | "recordSkip" | "onDecision" | "onGeometricStatus">;
  /** Read-only observers. `onShown` is called synchronously, before each shown card is posted, and
   *  receives the card that will be posted: it must not modify it. */
  observe?: Pick<ComputeFrameEnv, "onShown" | "onAnalysis">;
  now?: () => number;
  /** Development builds only (config.dev): a shorter idle unload. Refused otherwise. */
  devIdleUnloadMs?: number;
}

export interface HostCompute {
  readonly frame: ComputeFrame;
  stop(): void;
}

/** Null when the page is not framed by an allowed origin. Owns the driver tick and pagehide. */
export async function startHostCompute(env: HostComputeEnv): Promise<HostCompute | null> {
  const { config, win } = env;
  if (env.devIdleUnloadMs !== undefined && !config.dev) {
    throw new Error("startHostCompute: devIdleUnloadMs is for development builds only");
  }
  const framed = (win.parent as unknown) !== win;
  // A referrer policy that hides the parent makes it the string "null": that is no origin.
  const ancestor = win.location.ancestorOrigins?.[0];
  const parentOrigin = ancestor === undefined || ancestor === "null" ? null : ancestor;
  if (!framed || parentOrigin === null || !allowedParentOrigin(parentOrigin, config)) return null;

  // Past the origin check: the product reads its settings and builds the request, once.
  const loadRequest = await env.loadRequest();
  if (!config.capabilities.geometricStage) {
    const field = Object.entries(loadRequest).find(([key, value]) => key.startsWith("geometric") && value !== undefined)?.[0];
    if (field !== undefined) throw new Error(`startHostCompute: the load request has ${field}, but this product has no geometric stage`);
  }
  const keepCard = await createSwitches(env.storage, NO_CHANGES).keepCard();

  const frame = startComputeFrame({
    win,
    framed,
    parentOrigin,
    allowedParentOrigin: (origin) => allowedParentOrigin(origin, config),
    protocol: computeProtocol(config.tag),
    ...STANDARD_PRESET,
    ...(config.capabilities.geometricStage ? GEOMETRIC_OPTIONS : {}),
    hold: keepCard ? READING_HOLD : SHOWN_HOLD,
    idleUnloadMs: env.devIdleUnloadMs ?? STANDARD_PRESET.idleUnloadMs,
    // By name, so a stray field on either object can never replace an option set above.
    ...defined({
      chooseRelease: env.release?.chooseRelease,
      recordSkip: env.release?.recordSkip,
      onDecision: env.release?.onDecision,
      onGeometricStatus: env.release?.onGeometricStatus,
      onShown: env.observe?.onShown,
      onAnalysis: env.observe?.onAnalysis,
    }),
    createWorker: env.createWorker,
    loadRequest,
    now: env.now ?? (() => performance.now()),
  });
  if (!frame) return null;

  const ticker = setInterval(() => frame.tick(), DRIVER_TICK_MS);
  const pageWindow = win as unknown as { addEventListener(type: "pagehide", fn: () => void): void; removeEventListener(type: "pagehide", fn: () => void): void };
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(ticker);
    pageWindow.removeEventListener("pagehide", stop);
    frame.stop();
  };
  pageWindow.addEventListener("pagehide", stop);
  return { frame, stop };
}

/** The entries whose value is not undefined, so an absent hook stays absent rather than set to undefined. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** No switch changes are watched here: the hold is fixed for the frame's life (a flip remakes the frame). */
const NO_CHANGES: StorageChanges = { addListener: () => undefined, removeListener: () => undefined };

export const STANDARD_PRESET: Readonly<{ mode: "pointer"; rotatedOutlines: true; measuredPacing: true; idleUnloadMs: 600_000 }> = Object.freeze({
  mode: "pointer",
  rotatedOutlines: true,
  measuredPacing: true,
  idleUnloadMs: 600_000,
});

/** What `capabilities.geometricStage: true` adds to the preset: exactly these two, nothing else. */
export const GEOMETRIC_OPTIONS: Readonly<{ geometricScope: "focus"; geometricLoad: "pointer" }> = Object.freeze({
  geometricScope: "focus",
  geometricLoad: "pointer",
});
