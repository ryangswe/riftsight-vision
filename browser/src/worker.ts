// SPDX-License-Identifier: Apache-2.0
// The analysis worker. It loads one release when told to, then answers each frame it is sent
// with what the pipeline found. Frames never leave the worker: pixels in, numbers out. The only
// requests it makes are for the release document and the files that document pins (none when the
// page hands it the release's files), and, when
// the load request names a geometric stage, its settings, its descriptor index and OpenCV.js.
// What it does with each request is in worker-host.ts; this file gives it the browser's parts.
// It must be loaded as an ES module (`new Worker(url, { type: "module" })`, or imported from one):
// it finds its own files from `import.meta.url`.

import { loadPackedIndex } from "./geometric/index.js";
import { loadOpenCV } from "./geometric/opencv.js";
import type { StageVoter } from "./geometric/stage.js";
import { gpuVoter, voteDeviceLimits } from "./geometric/vote.js";
import { loadGeometric, loadRelease } from "./load.js";
import type { WorkerReply, WorkerRequest } from "./messages.js";
import { createWorkerHost, type FramePixels } from "./worker-host.js";

/** OpenCV.js, the build of scripts/build-opencv.mjs that `npm run build` copies beside this
 *  worker (opencv.mjs, which fetches opencv_js.wasm from its own folder). It is found, like the
 *  folder of ONNX Runtime's files below, from this module's own address and not the worker's: a
 *  hosted page starts the worker from a blob: URL that imports this module (`hostedWorkerScript`
 *  in demo/page.ts), and no relative address resolves against a blob: URL. */
const OPENCV_URL = new URL("./opencv.mjs", import.meta.url).href;

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

/** Draw a transferred bitmap into the worker's canvas and read its pixels back. */
function readBitmap(bitmap: ImageBitmap): FramePixels | null {
  const { width, height } = bitmap;
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, width, height);
}

/** A WebGPU device made for the vote, or null when this browser has none. The stage never
 *  votes on the CPU in a page: without WebGPU it is off. */
async function voteDevice(): Promise<GPUDevice | null> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  return adapter.requestDevice({ requiredLimits: voteDeviceLimits(adapter) });
}

const host = createWorkerHost<GPUDevice>({
  post: (reply: WorkerReply) => (self as unknown as Worker).postMessage(reply),
  loadRelease,
  wasmPaths: new URL("./", import.meta.url).href,
  voteDevice,
  openStage: (loaded, settingsUrl, device, manifestSha256) =>
    loadGeometric(loaded, settingsUrl, {
      loadIndex: (url, opts) => loadPackedIndex(url, { ...opts, ...(manifestSha256 !== undefined ? { manifestSha256 } : {}) }),
      loadCv: () => loadOpenCV(OPENCV_URL),
      makeVoter: async (desc: Uint8Array): Promise<StageVoter> => {
        const voter = await gpuVoter(device, desc);
        // The device is the voter's alone: disposing of the stage frees both.
        return { knn2: (queries) => voter.knn2(queries), dispose: () => { voter.dispose(); device.destroy(); } };
      },
    }),
  releaseDevice: (device) => device.destroy(),
  readBitmap,
});

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void host.handle(event.data);
};
