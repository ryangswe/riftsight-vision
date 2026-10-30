// SPDX-License-Identifier: Apache-2.0
// An experimental entry that an extension vendors, not part of the public API. Its import graph
// holds no ONNX Runtime, no WebAssembly and no OpenCV: the build and test/bundle-purity.test.ts
// keep it that way.

export { analysisSize, type ClientBox, pictureBox } from "./capture.js";
export { fractionIn } from "./capture.js";
export {
  BLANK_PICTURE,
  blankFrame,
  type CaptureSource,
  createSourceCanvas,
  type Grab,
  type GrabDeps,
  grabFrame,
  isFrozen,
  mediaTimeOf,
  NO_CONTEXT,
  NO_PICTURE,
  type PlayingClock,
  type SourceCanvas,
  TOO_LARGE,
  UNREADABLE,
} from "./page-capture.js";
export { type VideoSink, type VideoWatch, watchVideo } from "./video-events.js";
export { captureAllowed, type GateLimits, type GateState, MAX_REST_MS, POINTER_GRACE_MS, READING_LINGER_MS } from "./capture-gate.js";
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
  PROTOCOL_VERSION,
  type ShownCard,
  type Tagged,
} from "./compute-messages.js";
export {
  acceptComputeOut,
  CAPTURE_PENDING,
  type CaptureControl,
  type CaptureControlOptions,
  type CaptureProblem,
  createCaptureControl,
  fromExtensionFrame,
  NOT_POINTING,
  PICTURE_CHANGED,
  postWithTransfer,
} from "./capture-control.js";
