// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): the compute realm. Types and the two option sets are
// frozen here; the body is not written yet.

import type { ComputeFrame, ComputeFrameEnv, ComputeFrameWindow } from "../compute-frame.js";
import type { LoadRequest } from "../remote/choose.js";
import type { ReleaseInEffect, WorkerLike } from "../worker-session.js";
import type { ProductConfig } from "./config.js";
import type { KeyValueStorage } from "./settings-core.js";

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
  /** Read-only observers; they cannot change what is posted. Called synchronously, before each
   *  shown card is posted, as startComputeFrame does. */
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
export function startHostCompute(_env: HostComputeEnv): Promise<HostCompute | null> {
  throw new Error("not implemented yet");
}

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
