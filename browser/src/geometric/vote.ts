// SPDX-License-Identifier: Apache-2.0
// The geometric stage's vote: for each crop descriptor, its two nearest index descriptors by
// Hamming distance over the whole index. In Python: cardvision/geometric/stage.py, the vote
// matcher (`_build_vote`, `votes`): OpenCV's BFMatcher(NORM_HAMMING).knnMatch(k=2).
//
// Both voters here are exact: they return the same rows and distances as that matcher. The
// order is by distance, and between equal distances by the lower row, which is the order in
// which a brute-force matcher meets them (a later row replaces a kept one only when it is
// strictly nearer). The second-nearest row may be as near as the nearest.
//
// A descriptor is 32 bytes (256 bits, as ORB's). The stage applies the ratio test and maps
// rows to cards; this file only finds the neighbours.
//
// `cpuVoter` is the reference, in TypeScript. `gpuVoter` is the one the stage runs, as WebGPU
// compute shaders: the index is held on the GPU, each query's two nearest are found per chunk
// of rows, the chunks are merged on the GPU, and the result is read back once per dispatch.
// Without WebGPU the stage is off: the CPU reference is far too slow for a whole index.

/** Bytes in one descriptor. */
export const DESCRIPTOR_BYTES = 32;
const WORDS = DESCRIPTOR_BYTES / 4;

/** The row and distance given when there is no such neighbour (an index of fewer than two rows). */
export const NO_ROW = 0xffffffff;
export const NO_DISTANCE = 0xffff;

/** The two nearest index rows of each query, in query order. */
export interface KnnResult {
  best: Uint32Array;
  second: Uint32Array;
  dBest: Uint16Array;
  dSecond: Uint16Array;
}

export interface Voter {
  /** `queries` holds `q` descriptors of 32 bytes each. */
  knn2(queries: Uint8Array): Promise<KnnResult>;
  dispose(): void;
}

function queryCount(queries: Uint8Array): number {
  if (queries.length % DESCRIPTOR_BYTES !== 0) {
    throw new Error(`queries: ${queries.length} bytes is not a whole number of ${DESCRIPTOR_BYTES}-byte descriptors`);
  }
  return queries.length / DESCRIPTOR_BYTES;
}

function rowCount(desc: Uint8Array): number {
  if (desc.length % DESCRIPTOR_BYTES !== 0) {
    throw new Error(`descriptors: ${desc.length} bytes is not a whole number of ${DESCRIPTOR_BYTES}-byte descriptors`);
  }
  return desc.length / DESCRIPTOR_BYTES;
}

/** The bytes as 32-bit words (the platform's byte order; Hamming distance does not depend on it). */
function wordsOf(bytes: Uint8Array): Uint32Array {
  if (bytes.byteOffset % 4 === 0) return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  return new Uint32Array(bytes.slice().buffer);
}

function emptyResult(q: number): KnnResult {
  return {
    best: new Uint32Array(q).fill(NO_ROW),
    second: new Uint32Array(q).fill(NO_ROW),
    dBest: new Uint16Array(q).fill(NO_DISTANCE),
    dSecond: new Uint16Array(q).fill(NO_DISTANCE),
  };
}

function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/** The reference voter: a plain loop over every row for every query. Exact; slow on a large index. */
export function cpuVoter(desc: Uint8Array): Voter {
  const rows = rowCount(desc);
  const index = wordsOf(desc);
  return {
    async knn2(queries: Uint8Array): Promise<KnnResult> {
      const q = queryCount(queries);
      const words = wordsOf(queries);
      const result = emptyResult(q);
      for (let j = 0; j < q; j += 1) {
        const at = j * WORDS;
        const q0 = words[at]!, q1 = words[at + 1]!, q2 = words[at + 2]!, q3 = words[at + 3]!;
        const q4 = words[at + 4]!, q5 = words[at + 5]!, q6 = words[at + 6]!, q7 = words[at + 7]!;
        let d1 = NO_DISTANCE, r1 = NO_ROW, d2 = NO_DISTANCE, r2 = NO_ROW;
        for (let r = 0, w = 0; r < rows; r += 1, w += WORDS) {
          const d =
            popcount32(q0 ^ index[w]!) + popcount32(q1 ^ index[w + 1]!) + popcount32(q2 ^ index[w + 2]!) +
            popcount32(q3 ^ index[w + 3]!) + popcount32(q4 ^ index[w + 4]!) + popcount32(q5 ^ index[w + 5]!) +
            popcount32(q6 ^ index[w + 6]!) + popcount32(q7 ^ index[w + 7]!);
          // Strictly nearer only: between equal distances the lower row stays ahead.
          if (d < d1) {
            d2 = d1; r2 = r1; d1 = d; r1 = r;
          } else if (d < d2) {
            d2 = d; r2 = r;
          }
        }
        result.best[j] = r1; result.dBest[j] = d1; result.second[j] = r2; result.dSecond[j] = d2;
      }
      return result;
    },
    dispose(): void {},
  };
}

// ------------------------------------------------------------------------------------- WebGPU

/**
 * A row and its distance as one 32-bit key: the distance (at most 256, 9 bits) above the row
 * (23 bits). Keys order as (distance, row), so the smaller key is the nearer row, and between
 * equal distances the lower row: the brute-force matcher's order. An index on the GPU holds
 * fewer than 2^23 rows (8.4 million).
 */
const ROW_BITS = 23;
const ROW_MASK = (1 << ROW_BITS) - 1;
export const GPU_MAX_ROWS = ROW_MASK; // the all-ones key is "no row"
const EMPTY_SLOT = 0xffffffff;

/** Tuning of the GPU voter. The defaults suit an Apple M-series GPU; any value gives the same result. */
export interface GpuVoterOptions {
  /** Invocations per workgroup; each holds `queriesPerInvocation` queries. */
  workgroupSize?: number;
  queriesPerInvocation?: number;
  /** Rows staged in workgroup memory at a time. */
  tileRows?: number;
  /** Rows one workgroup scans; each chunk gives every query a partial result. */
  chunkRows?: number;
  /** Most queries in one dispatch; a larger call is split. */
  maxQueriesPerDispatch?: number;
  /** Most rows in one storage buffer (at most the device's limit allows). For tests of the split. */
  maxRowsPerBuffer?: number;
  /** Bytes the index is copied to the GPU in at a time, a multiple of 32 ("writeInPieces"). */
  uploadPieceBytes?: number;
}

const DEFAULTS: Required<Omit<GpuVoterOptions, "maxRowsPerBuffer">> = {
  workgroupSize: 64,
  queriesPerInvocation: 2,
  tileRows: 256,
  chunkRows: 8192,
  maxQueriesPerDispatch: 6144,
  uploadPieceBytes: 4 * 1024 * 1024,
};

/**
 * Copies `bytes` bytes of `src`, from byte `srcOffset`, to the start of `buffer`, at most
 * `pieceBytes` at a time, and waits for the queue after each piece. Chrome stages a write in
 * memory mapped by both the page and the GPU process, and that memory stays after the write is
 * done. One write of a whole index kept about its size in each process (about 50 MB each for a
 * 52 MB index); 4 MiB pieces with a wait kept about a piece and took no longer.
 */
export async function writeInPieces(
  queue: Pick<GPUQueue, "writeBuffer" | "onSubmittedWorkDone">,
  buffer: GPUBuffer,
  src: Uint8Array,
  srcOffset: number,
  bytes: number,
  pieceBytes: number,
): Promise<void> {
  for (let done = 0; done < bytes; done += pieceBytes) {
    queue.writeBuffer(buffer, done, src as Uint8Array<ArrayBuffer>, srcOffset + done, Math.min(pieceBytes, bytes - done));
    await queue.onSubmittedWorkDone();
  }
}

/**
 * The device limits to ask for when creating the device the vote runs on: the adapter's own
 * storage-buffer limits, so that a large index fits in few buffers. Pass the result as
 * `requiredLimits` to `adapter.requestDevice`. The voter works within any limits: a smaller
 * limit only splits the index into more buffers.
 */
export function voteDeviceLimits(adapter: GPUAdapter): Record<string, number> {
  return {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
  };
}

function scanShader(workgroupSize: number, qpi: number, tileRows: number): string {
  const per = (f: (i: number) => string): string => Array.from({ length: qpi }, (_, i) => f(i)).join("\n");
  return /* wgsl */ `
struct Params { queries: u32, rows: u32, base: u32, chunkRows: u32, firstChunk: u32, chunks: u32 }
@group(0) @binding(0) var<storage, read> desc: array<vec4<u32>>;
@group(0) @binding(1) var<storage, read> queries: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read_write> partial: array<vec2<u32>>;
@group(0) @binding(3) var<uniform> p: Params;
var<workgroup> tile: array<vec4<u32>, ${tileRows * 2}>;

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let first = (wg.y * ${workgroupSize}u + li) * ${qpi}u;
${per((i) => `  let qi${i} = min(first + ${i}u, max(p.queries, 1u) - 1u);
  let qa${i} = queries[qi${i} * 2u];
  let qb${i} = queries[qi${i} * 2u + 1u];
  var b${i} = 0xffffffffu;
  var s${i} = 0xffffffffu;`)}
  let start = wg.x * p.chunkRows;
  let end = min(start + p.chunkRows, p.rows);
  for (var t = start; t < end; t += ${tileRows}u) {
    let n = min(${tileRows}u, end - t);
    workgroupBarrier();
    for (var i = li; i < n * 2u; i += ${workgroupSize}u) {
      tile[i] = desc[t * 2u + i];
    }
    workgroupBarrier();
    let row0 = p.base + t;
    for (var r = 0u; r < n; r++) {
      let a = tile[r * 2u];
      let b = tile[r * 2u + 1u];
      let row = row0 + r;
${per((i) => `      {
        let c = countOneBits(qa${i} ^ a) + countOneBits(qb${i} ^ b);
        let k = ((c.x + c.y + c.z + c.w) << ${ROW_BITS}u) | row;
        s${i} = min(s${i}, max(b${i}, k));
        b${i} = min(b${i}, k);
      }`)}
    }
  }
${per((i) => `  if (first + ${i}u < p.queries) {
    partial[(first + ${i}u) * p.chunks + p.firstChunk + wg.x] = vec2<u32>(b${i}, s${i});
  }`)}
}
`;
}

const MERGE_SHADER = /* wgsl */ `
struct Params { queries: u32, chunks: u32 }
@group(0) @binding(0) var<storage, read> partial: array<vec2<u32>>;
@group(0) @binding(1) var<storage, read_write> merged: array<vec2<u32>>;
@group(0) @binding(2) var<uniform> p: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let q = id.x;
  if (q >= p.queries) { return; }
  var b = 0xffffffffu;
  var s = 0xffffffffu;
  for (var c = 0u; c < p.chunks; c++) {
    let k = partial[q * p.chunks + c];
    s = min(min(s, k.y), max(b, k.x));
    b = min(b, k.x);
  }
  merged[q] = vec2<u32>(b, s);
}
`;

interface Segment {
  buffer: GPUBuffer;
  rows: number;
  base: number;
  firstChunk: number;
  chunks: number;
  params: GPUBuffer;
}

/**
 * The voter on a WebGPU device. The index is copied to the GPU once, in pieces, split over
 * several storage buffers when it is larger than the device allows in one binding.
 */
export async function gpuVoter(device: GPUDevice, desc: Uint8Array, options: GpuVoterOptions = {}): Promise<Voter> {
  const rows = rowCount(desc);
  if (rows > GPU_MAX_ROWS) throw new Error(`descriptors: ${rows} rows; the GPU vote holds at most ${GPU_MAX_ROWS}`);
  const o = { ...DEFAULTS, ...options };
  for (const [name, value] of Object.entries(o)) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`gpuVoter: ${name} must be a positive integer`);
  }
  if (o.chunkRows % o.tileRows !== 0) throw new Error("gpuVoter: chunkRows must be a multiple of tileRows");
  if (o.uploadPieceBytes % DESCRIPTOR_BYTES !== 0) throw new Error(`gpuVoter: uploadPieceBytes must be a multiple of ${DESCRIPTOR_BYTES}`);
  const limits = device.limits;
  const bindingBytes = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
  // Whole chunks per buffer, so that a chunk never straddles two buffers.
  let rowsPerBuffer = Math.floor(bindingBytes / DESCRIPTOR_BYTES / o.chunkRows) * o.chunkRows;
  if (options.maxRowsPerBuffer !== undefined) rowsPerBuffer = Math.min(rowsPerBuffer, Math.floor(options.maxRowsPerBuffer / o.chunkRows) * o.chunkRows);
  // A buffer's chunks are one dispatch's workgroups along x.
  const maxGroups = limits.maxComputeWorkgroupsPerDimension;
  rowsPerBuffer = Math.min(rowsPerBuffer, maxGroups * o.chunkRows);
  if (rowsPerBuffer < o.chunkRows) throw new Error("gpuVoter: one chunk of rows does not fit in a storage buffer; lower chunkRows");
  const totalChunks = Math.max(1, Math.ceil(rows / o.chunkRows));
  const perGroup = o.workgroupSize * o.queriesPerInvocation;
  const partialLimit = Math.floor(bindingBytes / (totalChunks * 8));
  const maxQueries = Math.max(1, Math.min(o.maxQueriesPerDispatch, partialLimit, maxGroups * perGroup));
  if (o.tileRows * 2 * 16 > limits.maxComputeWorkgroupStorageSize) throw new Error("gpuVoter: tileRows exceeds the device's workgroup memory");
  if (o.workgroupSize > limits.maxComputeInvocationsPerWorkgroup) throw new Error("gpuVoter: workgroupSize exceeds the device's limit");

  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  const scan = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module: device.createShaderModule({ code: scanShader(o.workgroupSize, o.queriesPerInvocation, o.tileRows) }), entryPoint: "main" },
  });
  const merge = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module: device.createShaderModule({ code: MERGE_SHADER }), entryPoint: "main" },
  });

  const segments: Segment[] = [];
  for (let base = 0; base < rows || segments.length === 0; base += rowsPerBuffer) {
    const n = Math.min(rowsPerBuffer, rows - base);
    // A zero-row index still gets a (one-row, unread) buffer: a binding cannot be empty.
    const buffer = device.createBuffer({ size: Math.max(n, 1) * DESCRIPTOR_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    if (n > 0) await writeInPieces(device.queue, buffer, desc, base * DESCRIPTOR_BYTES, n * DESCRIPTOR_BYTES, o.uploadPieceBytes);
    const params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    segments.push({ buffer, rows: n, base, firstChunk: base / o.chunkRows, chunks: Math.max(1, Math.ceil(n / o.chunkRows)), params });
    if (n <= 0) break;
  }
  const queryBuffer = device.createBuffer({ size: maxQueries * DESCRIPTOR_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const partial = device.createBuffer({ size: maxQueries * totalChunks * 8, usage: GPUBufferUsage.STORAGE });
  const merged = device.createBuffer({ size: maxQueries * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: maxQueries * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const mergeParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const scanGroups = segments.map((s) =>
    device.createBindGroup({
      layout: scan.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: s.buffer } },
        { binding: 1, resource: { buffer: queryBuffer } },
        { binding: 2, resource: { buffer: partial } },
        { binding: 3, resource: { buffer: s.params } },
      ],
    }),
  );
  const mergeGroup = device.createBindGroup({
    layout: merge.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: partial } },
      { binding: 1, resource: { buffer: merged } },
      { binding: 2, resource: { buffer: mergeParams } },
    ],
  });
  const outOfMemory = await device.popErrorScope();
  const invalid = await device.popErrorScope();
  const failed = outOfMemory ?? invalid;
  if (failed) throw new Error(`gpuVoter: ${failed.message}`);

  let disposed = false;
  // One call at a time: the calls share the buffers.
  let queue: Promise<unknown> = Promise.resolve();

  async function dispatch(words: Uint8Array, q: number, into: KnnResult, offset: number): Promise<void> {
    device.queue.writeBuffer(queryBuffer, 0, words.buffer, words.byteOffset, q * DESCRIPTOR_BYTES);
    for (const s of segments) {
      device.queue.writeBuffer(s.params, 0, new Uint32Array([q, s.rows, s.base, o.chunkRows, s.firstChunk, totalChunks, 0, 0]));
    }
    device.queue.writeBuffer(mergeParams, 0, new Uint32Array([q, totalChunks, 0, 0]));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(scan);
    segments.forEach((s, i) => {
      pass.setBindGroup(0, scanGroups[i]!);
      pass.dispatchWorkgroups(s.chunks, Math.ceil(q / perGroup));
    });
    pass.setPipeline(merge);
    pass.setBindGroup(0, mergeGroup);
    pass.dispatchWorkgroups(Math.ceil(q / 64));
    pass.end();
    encoder.copyBufferToBuffer(merged, 0, readback, 0, q * 8);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ, 0, q * 8);
    const keys = new Uint32Array(readback.getMappedRange(0, q * 8).slice(0));
    readback.unmap();
    for (let j = 0; j < q; j += 1) {
      const b = keys[j * 2]!;
      const s = keys[j * 2 + 1]!;
      if (b !== EMPTY_SLOT) {
        into.best[offset + j] = b & ROW_MASK;
        into.dBest[offset + j] = b >>> ROW_BITS;
      }
      if (s !== EMPTY_SLOT) {
        into.second[offset + j] = s & ROW_MASK;
        into.dSecond[offset + j] = s >>> ROW_BITS;
      }
    }
  }

  return {
    knn2(queries: Uint8Array): Promise<KnnResult> {
      const run = async (): Promise<KnnResult> => {
        if (disposed) throw new Error("gpuVoter: used after dispose");
        const q = queryCount(queries);
        const result = emptyResult(q);
        if (rows === 0) return result;
        for (let at = 0; at < q; at += maxQueries) {
          const n = Math.min(maxQueries, q - at);
          // writeBuffer needs a 4-byte-aligned source offset.
          let part = queries.subarray(at * DESCRIPTOR_BYTES, (at + n) * DESCRIPTOR_BYTES);
          if (part.byteOffset % 4 !== 0) part = part.slice();
          await dispatch(part, n, result, at);
        }
        return result;
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      void queue.then(() => {
        for (const s of segments) {
          s.buffer.destroy();
          s.params.destroy();
        }
        for (const b of [queryBuffer, partial, merged, readback, mergeParams]) b.destroy();
      });
    },
  };
}
