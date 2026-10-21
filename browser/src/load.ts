// SPDX-License-Identifier: Apache-2.0
// Load a release and analyze frames with it, in the thread that calls: a page, a worker, or
// Node. A session (session.ts) does the same inside a worker and adds the scheduling.

import type { Frame } from "./detector/detector.js";
import { Detector } from "./detector/detector.js";
import { Embedder } from "./embedder.js";
import { configureOrt, ortWebVersion, takeSessionFailures } from "./ort.js";
import type { Cv } from "./geometric/features.js";
import { type GeometricStage, openGeometricStage, type StageIndex, type StageVoter, voteIdentities } from "./geometric/stage.js";
import type { FrameAnalysis, Pipeline } from "./pipeline.js";
import { RELEASE_FILES_BASE, releaseFileKey } from "./messages.js";
import type { ExecutionProvider } from "./providers.js";
import {
  buildReleasePipeline,
  type CatalogCard,
  defaultReleaseDeps,
  loadReleaseData,
  type ReleaseDeps,
  type ReleaseModelFactories,
  type VisionRelease,
} from "./release.js";

/** A release could not be loaded. `reason` says why; nothing was loaded. */
export class ReleaseError extends Error {
  constructor(readonly reason: string) {
    super(`the release could not be loaded: ${reason}`);
    this.name = "ReleaseError";
  }
}

export interface LoadOptions {
  /** URL of the folder that holds ONNX Runtime's `.wasm` files. Needed in a browser unless
   *  they sit beside the script; leave it out under Node. */
  wasmPaths?: string;
  /** The execution providers to try, in order, in place of the release's own list. */
  providers?: readonly ExecutionProvider[];
  /** How bytes are fetched and hashed, in place of `fetch` and the Web Crypto API. */
  deps?: Partial<ReleaseDeps>;
  /** The release's files, by path relative to the release document's folder, in place of a
   *  server: `releaseUrl` is then the document's path among them (`release.json`), and nothing is
   *  fetched (`filesFetch`). Each file is checked against the size and SHA-256 the document pins,
   *  as a fetched one is. */
  files?: Record<string, Blob>;
  /** Told where the load is: downloading the files the release pins (`bytes`, their sum, once the
   *  release document is read), then preparing the models (starting the ONNX Runtime sessions).
   *  Advisory: what it throws is ignored, and the load goes on. A load that fails before the
   *  models are prepared says no "preparing". */
  onProgress?: (progress: LoadProgress) => void;
}

/** Where a load is, for a caller that shows it: downloading the release's files, whose sizes
 *  add up to `bytes` (null until the release document is read), or preparing the models. */
export type LoadProgress = { phase: "downloading"; bytes: number | null } | { phase: "preparing" };

/** A release that loaded whole: its document, its catalog and a pipeline ready for frames. */
export interface LoadedRelease {
  release: VisionRelease;
  pipeline: Pipeline;
  /** The execution provider each model runs on. */
  backend: { detector: ExecutionProvider; recognizer: ExecutionProvider };
  /** The catalog's cards, and card id to name. */
  cards: CatalogCard[];
  names: Map<string, string>;
  /** What a geometric stage must serve: the bank's SHA-256 and card ids, and card id to
   *  identity key for the vote (the catalog's rule with the release's groups over it). */
  stageInputs: { bankSha256: string; bankIds: string[]; identities: Map<string, string> };
  /** Free the models. */
  dispose(): Promise<void>;
}

/**
 * A `fetchFn` that answers from a release's files and never from a network: an address under
 * `RELEASE_FILES_BASE` gets the bytes of the file at that path relative to the release document's
 * folder, and any other address, or a path that is not among the files, is refused with the path
 * in words. What it answers is then checked like anything fetched.
 */
export function filesFetch(files: Record<string, Blob>): ReleaseDeps["fetchFn"] {
  return async (url: string) => {
    if (!url.startsWith(RELEASE_FILES_BASE)) throw new Error(`${url} is not one of the release's files`);
    const path = releaseFileKey(url.slice(RELEASE_FILES_BASE.length));
    const file = Object.hasOwn(files, path) ? files[path] : undefined;
    if (file === undefined) throw new Error(`no file ${path} among the release's files`);
    return { ok: true, status: 200, arrayBuffer: () => file.arrayBuffer() };
  };
}

const factories: ReleaseModelFactories = {
  embedder: (bytes, settings, providers) => Embedder.create(bytes, settings, providers),
  detector: (bytes, settings, providers) => Detector.create(bytes, settings, providers),
};

/**
 * Load the release whose document is at `releaseUrl`: fetch it and every file it pins, check
 * each against its size and SHA-256 and against the others, and start both models. The
 * document's paths are relative to it. With `options.files` the same is read from those files
 * instead, and nothing is fetched. All-or-nothing: any failure rejects with a `ReleaseError` and
 * nothing stays loaded.
 */
export async function loadRelease(releaseUrl: string | URL, options: LoadOptions = {}): Promise<LoadedRelease> {
  const base = options.files ? RELEASE_FILES_BASE : typeof location !== "undefined" ? location.href : undefined;
  const url = new URL(releaseUrl, base).href;
  const progress = (said: LoadProgress): void => {
    try {
      options.onProgress?.(said);
    } catch {
      // Advisory: a caller's display cannot stop the load.
    }
  };
  progress({ phase: "downloading", bytes: null });
  const deps: ReleaseDeps = { ...defaultReleaseDeps, ...options.deps, ...(options.files ? { fetchFn: filesFetch(options.files) } : {}) };
  const loaded = await loadReleaseData(url, deps, {
    ortWeb: ortWebVersion(),
    ...(options.onProgress ? { onDocument: (bytes: number) => progress({ phase: "downloading", bytes }) } : {}),
  });
  if (!loaded.ok) throw new ReleaseError(loaded.reason);
  progress({ phase: "preparing" });
  const { data } = loaded;
  configureOrt({ wasmThreads: data.release.runtime.wasmThreads, ...(options.wasmPaths !== undefined ? { wasmPaths: options.wasmPaths } : {}) });
  takeSessionFailures();
  const built = await buildReleasePipeline(data, factories, options.providers ?? data.release.runtime.executionProviders);
  if ("error" in built) {
    const causes = takeSessionFailures();
    throw new ReleaseError(causes.length > 0 ? `${built.error} (${causes.join("; ")})` : built.error);
  }
  return {
    release: data.release,
    pipeline: built.pipeline,
    backend: { detector: built.detector.ep, recognizer: built.embedder.ep },
    cards: data.cards,
    names: data.names,
    stageInputs: {
      bankSha256: data.release.bank.sha256,
      bankIds: [...new Set(data.bank.ids)],
      identities: voteIdentities(data.cards, data.release.identity.level, data.identityGroups),
    },
    dispose: async () => {
      await built.embedder.release?.();
      await built.detector.release?.();
    },
  };
}

/**
 * Analyze one frame with a loaded release. `frame` is RGBA pixels already at analysis size
 * (an `ImageData` fits; `analysisSize` in capture.ts gives the size for a picture). Frames of
 * one video are expected in order, one call at a time; pass `videoTimeSec` so that a seek
 * resets what is carried between frames.
 */
export function analyzeFrame(loaded: LoadedRelease, frame: Frame, videoTimeSec?: number): Promise<FrameAnalysis> {
  return loaded.pipeline.analyze(frame, videoTimeSec);
}

/** The loaders of a geometric stage's three parts. */
export interface GeometricLoaders {
  loadIndex(manifestUrl: string, opts: { bankSha256: string; bankIds: string[] }): Promise<StageIndex>;
  loadCv(): Promise<Cv>;
  makeVoter(desc: Uint8Array): Promise<StageVoter>;
  fetchText?: (url: string) => Promise<string>;
}

/**
 * Open the geometric stage whose settings document is at `settingsUrl` for a loaded release:
 * its packed index must serve the release's bank. It is not set on the pipeline: the caller
 * does that between frames (`Pipeline.setGeometric`). Rejects with the reason it cannot run.
 * `note` warns when the index was taken by another OpenCV version than the one loaded.
 */
export async function loadGeometric(
  loaded: Pick<LoadedRelease, "stageInputs">,
  settingsUrl: string | URL,
  loaders: GeometricLoaders,
): Promise<{ stage: GeometricStage; bytes: number; note: string | null }> {
  const base = typeof location !== "undefined" ? location.href : undefined;
  const url = new URL(settingsUrl, base).href;
  const fetchText =
    loaders.fetchText ??
    (async (u: string) => {
      const response = await fetch(u);
      if (!response.ok) throw new Error(`${u}: HTTP ${response.status}`);
      return response.text();
    });
  return openGeometricStage(url, { ...loaders, fetchText, ...loaded.stageInputs });
}
