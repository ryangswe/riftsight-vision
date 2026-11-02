// SPDX-License-Identifier: Apache-2.0
// An experimental entry that an extension vendors, not part of the public API. Its import graph
// holds no ONNX Runtime, no WebAssembly and no OpenCV: the build and test/bundle-purity.test.ts
// keep it that way.

export { type AnalysisMode, cadenceMs, type SessionMode } from "./cadence.js";
export { type AnalysisState, FrameScheduler, HOVER_MAX_AGE_MS, replyRejection } from "./frame-scheduler.js";
export { hoverAt } from "./hover-at.js";
export {
  type ComputeIn,
  type ComputeOut,
  type ComputeProtocol,
  computeProtocol,
  type FractionBox,
  MAX_FRAME_SIDE,
  MAX_OTHER_BOXES,
  MAX_REASON_LENGTH,
  MAX_TEXT_LENGTH,
  type ShownCard,
  type Tagged,
} from "./compute-messages.js";
export {
  neighborBoxes,
  SessionCore,
  type SessionCoreDeps,
  type SessionCoreOptions,
  SHOWN_HOLD,
  type Shown,
  type ShownHold,
} from "./session-core.js";
export {
  createWorkerSession,
  plainLoad,
  type ReleaseInEffect,
  WORKER_RESTARTS,
  type WorkerLike,
  type WorkerSession,
  type WorkerSessionEnv,
} from "./worker-session.js";
export { type ComputeFrame, type ComputeFrameEnv, type ComputeFrameWindow, startComputeFrame } from "./compute-frame.js";
export { DRIVER_TICK_MS } from "./frame-scheduler.js";
export { PROTOCOL_VERSION } from "./compute-messages.js";
