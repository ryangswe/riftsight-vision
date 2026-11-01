// SPDX-License-Identifier: Apache-2.0
// The detector's model: one analysis frame in, the valid boxes of that frame out.

import type { Candidate } from "../boxes.js";
import { createSession, float32Tensor, type InferenceSession, type SessionSetup } from "../ort.js";
import type { ExecutionProvider } from "../providers.js";
import { BOX_COLUMNS, type DecodeSettings, validDetections } from "./decode.js";
import { type LetterboxSettings, toDetectorTensor } from "./letterbox.js";

/** An RGBA frame: row-major, four bytes per pixel. */
export interface Frame {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** Everything a release document states about its detector that the runtime acts on. */
export interface DetectorSettings {
  inputName: string;
  outputName: string;
  letterbox: LetterboxSettings;
  /** Rows the model emits for one frame. */
  anchors: number;
  /** Class names, in the order of the model's class scores. */
  classes: readonly string[];
  decode: DecodeSettings;
  /** The class whose boxes go to the recognizer. */
  faceClass: number;
  /** The shortest side a box's crop may have, in pixels of the analyzed frame. */
  minCropPx: number;
}

/** What the pipeline needs from a detector. Tests supply their own. */
export interface FrameDetector {
  /** Every valid box of one analysis frame at the detector's operating point, best first. */
  propose(frame: Frame): Promise<Candidate[]>;
  /** How long the last `propose` spent preparing the input and running the model, in ms. */
  readonly lastTimings: { preprocessMs: number; inferMs: number } | null;
}

export class Detector implements FrameDetector {
  lastTimings: { preprocessMs: number; inferMs: number } | null = null;
  private readonly columns: number;

  private constructor(
    private readonly session: InferenceSession,
    /** The execution provider that initialized. */
    readonly ep: ExecutionProvider,
    private readonly settings: DetectorSettings,
    /** How long the session took to create and to run once, on `ep`. */
    readonly setup: SessionSetup,
  ) {
    this.columns = BOX_COLUMNS + settings.classes.length;
  }

  /**
   * Create a session on the first of `providers` that initializes and, for one blank frame,
   * returns rows of the stated layout: `[1, anchors, 5 + classes]`. Returns null when no
   * provider does, which includes a model of another layout.
   */
  static async create(modelBytes: Uint8Array, settings: DetectorSettings, providers: readonly ExecutionProvider[]): Promise<Detector | null> {
    const { width, height } = settings.letterbox;
    const columns = BOX_COLUMNS + settings.classes.length;
    const opened = await createSession(modelBytes, providers, async (session) => {
      const out = await session.run({ [settings.inputName]: float32Tensor(new Float32Array(3 * width * height), [1, 3, height, width]) });
      const dims = out[settings.outputName]?.dims ?? [];
      return dims.length === 3 && dims[0] === 1 && dims[1] === settings.anchors && dims[2] === columns;
    });
    return opened ? new Detector(opened.session, opened.ep, settings, { createMs: opened.createMs, firstRunMs: opened.firstRunMs }) : null;
  }

  async propose(frame: Frame): Promise<Candidate[]> {
    const { letterbox, inputName, outputName, decode, minCropPx } = this.settings;
    const t0 = performance.now();
    const { tensor, ratio } = toDetectorTensor(frame.data, frame.width, frame.height, letterbox);
    const t1 = performance.now();
    const out = await this.session.run({ [inputName]: float32Tensor(tensor, [1, 3, letterbox.height, letterbox.width]) });
    this.lastTimings = { preprocessMs: t1 - t0, inferMs: performance.now() - t1 };
    return validDetections(out[outputName]!.data as Float32Array, this.columns, ratio, frame.width, frame.height, decode, minCropPx);
  }

  async release(): Promise<void> {
    await this.session.release().catch(() => undefined);
  }
}
