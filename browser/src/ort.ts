// SPDX-License-Identifier: Apache-2.0
// The one place ONNX Runtime Web is configured and a model session is created.
//
// A session is tried on each execution provider in the order given (a release document lists
// them: WebGPU first, then WebAssembly) and the first that initializes is used. WebAssembly
// runs on one thread: more threads need a cross-origin isolated page, which a page embedding
// this runtime cannot be assumed to be.

import * as ort from "onnxruntime-web/all";

import type { ExecutionProvider } from "./providers.js";

/** The version of onnxruntime-web this build runs on. */
export function ortWebVersion(): string {
  return ort.env.versions.web ?? "";
}

/**
 * Set the runtime's global options. `wasmPaths` is the URL of the folder that holds ONNX
 * Runtime's `.wasm` files (in a browser they are fetched from there; under Node, leave it out
 * and the package's own files are used).
 */
export function configureOrt(options: { wasmPaths?: string; wasmThreads?: number } = {}): void {
  ort.env.wasm.numThreads = options.wasmThreads ?? 1;
  if (options.wasmPaths !== undefined) ort.env.wasm.wasmPaths = options.wasmPaths;
}

/** Why sessions failed to start since the list was last taken: one line per provider tried. */
let failures: string[] = [];

/** The reasons collected since the last call, for an error message; the list is emptied. */
export function takeSessionFailures(): string[] {
  const taken = failures;
  failures = [];
  return taken;
}

/** How long a model took to become ready on the provider that worked, in ms: creating its
 *  session, then its first run (the warm-up check, which also pays one-off allocation and, on
 *  WebGPU, shader compilation). Providers tried before it and failed are not counted here. */
export interface SessionSetup {
  createMs: number;
  firstRunMs: number;
}

export interface OpenSession extends SessionSetup {
  session: ort.InferenceSession;
  /** The execution provider that initialized. */
  ep: ExecutionProvider;
}

/**
 * Create a session from model bytes on the first provider of `providers` that initializes and
 * passes `check` (a warm-up run that also verifies the model's shapes). Returns null when none
 * does. A session that fails its check is released before the next provider is tried.
 */
export async function createSession(
  modelBytes: Uint8Array,
  providers: readonly ExecutionProvider[],
  check: (session: ort.InferenceSession) => Promise<boolean>,
): Promise<OpenSession | null> {
  for (const ep of providers) {
    let session: ort.InferenceSession | null = null;
    try {
      const created = performance.now();
      session = await ort.InferenceSession.create(modelBytes.slice().buffer, { executionProviders: [ep] });
      const checked = performance.now();
      if (await check(session)) return { session, ep, createMs: checked - created, firstRunMs: performance.now() - checked };
      failures.push(`${ep}: the model does not have the inputs and outputs the release describes`);
    } catch (error) {
      // This provider cannot run the model here: note why, and try the next one.
      failures.push(`${ep}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    }
    await session?.release().catch(() => undefined);
  }
  return null;
}

export function float32Tensor(data: Float32Array, dims: readonly number[]): ort.Tensor {
  return new ort.Tensor("float32", data, dims);
}

export type { InferenceSession } from "onnxruntime-web/all";
export type { ExecutionProvider };
