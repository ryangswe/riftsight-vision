// SPDX-License-Identifier: Apache-2.0
// The recognizer's model: preprocessed crops in, one embedding per crop out.

import { createSession, float32Tensor, type InferenceSession, type SessionSetup } from "./ort.js";
import type { ExecutionProvider } from "./providers.js";

/**
 * Most crops one model run takes. A frame can ask for every proposal at once (up to the
 * detector's maximum) and then for three turned looks of each one retried; in a single run that
 * would be tens of megabytes of input and its activations, on a GPU that may be integrated. An
 * embedding depends on its own crop alone, so running in parts gives the same values.
 */
export const EMBED_MAX_BATCH = 32;

/** What the frame recognition needs from an embedding model. Tests supply their own. */
export interface BatchEmbedder {
  /** `n` preprocessed crops, concatenated, to `n` embeddings, concatenated in the same order. */
  embedBatch(data: Float32Array, n: number): Promise<Float32Array>;
}

/**
 * Run `n` concatenated crops through `run`, at most `maxBatch` at a time, and concatenate the
 * outputs in crop order (`n * dim` values). A batch that fits is one run.
 */
export async function embedInChunks(
  run: (data: Float32Array, n: number) => Promise<Float32Array>,
  data: Float32Array,
  n: number,
  dim: number,
  maxBatch: number = EMBED_MAX_BATCH,
): Promise<Float32Array> {
  if (n <= maxBatch) return run(data, n);
  const plane = data.length / n;
  const out = new Float32Array(n * dim);
  for (let start = 0; start < n; start += maxBatch) {
    const count = Math.min(maxBatch, n - start);
    // A copy, not a view: each run gets a tensor that starts at the start of its own buffer.
    const part = await run(data.slice(start * plane, (start + count) * plane), count);
    if (part.length !== count * dim) throw new Error(`unexpected embedding size ${part.length} for ${count} crops`);
    out.set(part, start * dim);
  }
  return out;
}

/** The recognizer's tensor names and sizes, as a release document states them. */
export interface EmbedderSettings {
  inputName: string;
  outputName: string;
  /** Side of the square input, in pixels (the preprocessing contract's size). */
  inputSize: number;
  /** Length of one embedding. */
  dim: number;
}

export class Embedder implements BatchEmbedder {
  private constructor(
    private readonly session: InferenceSession,
    /** The execution provider that initialized. */
    readonly ep: ExecutionProvider,
    private readonly settings: EmbedderSettings,
    /** How long the session took to create and to run once, on `ep`. */
    readonly setup: SessionSetup,
  ) {}

  /**
   * Create a session on the first of `providers` that initializes and returns embeddings of
   * the stated size for one blank crop. That first run also pays the one-off allocation and
   * shader compilation, away from the first real frame. Returns null when no provider does.
   */
  static async create(modelBytes: Uint8Array, settings: EmbedderSettings, providers: readonly ExecutionProvider[]): Promise<Embedder | null> {
    const n = settings.inputSize;
    const opened = await createSession(modelBytes, providers, async (session) => {
      const out = await session.run({ [settings.inputName]: float32Tensor(new Float32Array(3 * n * n), [1, 3, n, n]) });
      return out[settings.outputName]?.data.length === settings.dim;
    });
    return opened ? new Embedder(opened.session, opened.ep, settings, { createMs: opened.createMs, firstRunMs: opened.firstRunMs }) : null;
  }

  /** Embed `n` preprocessed crops (concatenated channel-first tensors). The model normalizes
   *  its output to unit length. */
  async embedBatch(data: Float32Array, n: number): Promise<Float32Array> {
    return embedInChunks((chunk, count) => this.run(chunk, count), data, n, this.settings.dim);
  }

  private async run(data: Float32Array, n: number): Promise<Float32Array> {
    const { inputName, outputName, inputSize, dim } = this.settings;
    const out = await this.session.run({ [inputName]: float32Tensor(data, [n, 3, inputSize, inputSize]) });
    const embeddings = out[outputName]!.data as Float32Array;
    if (embeddings.length !== n * dim) throw new Error(`unexpected embedding size ${embeddings.length} for ${n} crops`);
    return embeddings;
  }

  async release(): Promise<void> {
    await this.session.release().catch(() => undefined);
  }
}
