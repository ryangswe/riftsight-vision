// SPDX-License-Identifier: Apache-2.0
// Card detection and recognition for trading-card game video, in a web browser.
//
// Three entry points, from the highest level down:
//
//   createSession(element, { releaseUrl })   recognition on a <video> or image element of the
//                                            page; `session.at(x, y)` says what would be shown
//                                            for a pointer position (name, card id, box), or
//                                            null for nothing.
//   loadRelease(url)                         fetch and check a release and start its models, in
//                                            the calling thread (a page, a worker, Node).
//   analyzeFrame(loaded, frame)              one frame of RGBA pixels in; boxes, classes, each
//                                            face's best match with its score and margin, the
//                                            accept decision and the hover layer out.
//                                            `hoverAt(analysis, x, y)` resolves a pointer.
//
// The modules behind them are exported too, for callers that want one step on its own.

export { analyzeFrame, type LoadedRelease, type LoadOptions, type LoadProgress, type LoadTimings, loadRelease, type ModelLoadTimings, ReleaseError } from "./load.js";
export type { SessionSetup } from "./ort.js";
export { type ClientBox, createSession, type Session, type SessionOptions, type SessionStatus, type Shown } from "./session.js";
export { type BoxResult, type FaceResult, type FrameAnalysis, hoverAt, hoverCardsOf, Pipeline, type PipelineOptions } from "./pipeline.js";

export { type AABB, type Candidate, iou, nonMaxSuppression, type Rect } from "./boxes.js";
export { type EmbeddingBank, parseBank } from "./bank.js";
export { type AnalysisMode, cadenceMs } from "./cadence.js";
export { analysisSize, captureFrame, type FrameSource, MAX_ANALYSIS_WIDTH, MIN_ANALYSIS_WIDTH } from "./capture.js";
export { type DecodeSettings, decodeDetections, DEFAULT_DECODE, validBox } from "./detector/decode.js";
export { Detector, type DetectorSettings, type Frame, type FrameDetector } from "./detector/detector.js";
export { DEFAULT_LETTERBOX, letterboxBgr, letterboxGeometry, type LetterboxSettings, toDetectorTensor } from "./detector/letterbox.js";
export { type BatchEmbedder, Embedder, type EmbedderSettings } from "./embedder.js";
export { type AnalysisState, FrameScheduler, HOVER_MAX_AGE_MS, replyRejection } from "./frame-scheduler.js";
export { computeCardQuad, type LayerCard, type NormalizedBounds, pointInConvexQuad, resolveHoveredCard } from "./hover-geometry.js";
export { HOVER_SELECTIONS, type HoverOutcome, type HoverSelection, hoverOrder, resolveHover, selectHoverLayer } from "./hover-layer.js";
export { type IdentityDisplay, type IdentityGroups, IdentityMap, type IdentityRule, parseIdentityGroups } from "./identity.js";
export type { FrameEnvelope, FrameResult, ReleaseProgress, ReleaseStatus, WorkerReply, WorkerRequest } from "./messages.js";
export { boxAverageRgb, PREPROCESSING, type PreprocessingContract, rotateTensor90, toContractTensor } from "./preprocess.js";
export { EXECUTION_PROVIDERS, type ExecutionProvider } from "./providers.js";
export { chooseLook, cropRgba, lookAccepted, recognizeFrame, type ScoredFrame, type ScoredProposal } from "./recognition.js";
export { type AcceptRule, DEFAULT_ACCEPT, EmbeddingRecognizer, type ScoredMatch } from "./recognizer.js";
export { type CatalogCard, loadReleaseData, parseRelease, type ReleaseData, type VisionRelease } from "./release.js";
export { resizeBilinearRgb } from "./resize.js";
export { TemporalGate } from "./temporal-gate.js";
export { poolEmbeddings, Tracker } from "./tracker.js";
