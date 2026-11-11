// SPDX-License-Identifier: Apache-2.0
// The geometric vote's reference voter against a naive count. The GPU voter is checked
// against this one in a browser: `npm run test:webgpu` (scripts/webgpu-test.mjs).

import { afterEach, describe, expect, it, vi } from "vitest";

import { cpuVoter, DESCRIPTOR_BYTES, gpuVoter, NO_DISTANCE, NO_ROW, writeInPieces, type KnnResult } from "../src/geometric/vote.js";
import { queriesFrom, randomDescriptors, tiedDescriptors } from "./vote-fixtures.js";

/** The two nearest rows by sorting every row by (distance, row), bit by bit. */
function naive(desc: Uint8Array, queries: Uint8Array): KnnResult {
  const rows = desc.length / DESCRIPTOR_BYTES;
  const q = queries.length / DESCRIPTOR_BYTES;
  const out: KnnResult = {
    best: new Uint32Array(q), second: new Uint32Array(q), dBest: new Uint16Array(q), dSecond: new Uint16Array(q),
  };
  for (let j = 0; j < q; j += 1) {
    const ranked: [number, number][] = [];
    for (let r = 0; r < rows; r += 1) {
      let d = 0;
      for (let b = 0; b < DESCRIPTOR_BYTES; b += 1) {
        const x = desc[r * DESCRIPTOR_BYTES + b]! ^ queries[j * DESCRIPTOR_BYTES + b]!;
        for (let bit = 0; bit < 8; bit += 1) d += (x >> bit) & 1;
      }
      ranked.push([d, r]);
    }
    ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    out.best[j] = ranked[0]?.[1] ?? NO_ROW;
    out.dBest[j] = ranked[0]?.[0] ?? NO_DISTANCE;
    out.second[j] = ranked[1]?.[1] ?? NO_ROW;
    out.dSecond[j] = ranked[1]?.[0] ?? NO_DISTANCE;
  }
  return out;
}

describe("cpuVoter", () => {
  it("finds the two nearest rows of random descriptors", async () => {
    const desc = randomDescriptors(3000, 1);
    const queries = queriesFrom(desc, 60, 2);
    expect(await cpuVoter(desc).knn2(queries)).toEqual(naive(desc, queries));
  });

  it("orders equal distances by the lower row", async () => {
    for (const distinct of [1, 2, 5]) {
      const desc = tiedDescriptors(800, distinct, 3 + distinct);
      const queries = queriesFrom(desc, 80, 4 + distinct);
      const got = await cpuVoter(desc).knn2(queries);
      expect(got).toEqual(naive(desc, queries));
      // Every row equal: the first two rows, at the same distance.
      if (distinct === 1) {
        expect([...got.best].every((r) => r === 0)).toBe(true);
        expect([...got.second].every((r) => r === 1)).toBe(true);
        expect(got.dSecond).toEqual(got.dBest);
      }
    }
  });

  it("gives the hand-checked answer of a tiny index", async () => {
    const desc = new Uint8Array(4 * DESCRIPTOR_BYTES);
    desc[0 * 32] = 0b1111; // row 0: 4 bits from zero
    desc[1 * 32] = 0b0001; // row 1: 1 bit
    desc[2 * 32 + 31] = 0b1000_0000; // row 2: 1 bit, the last of the descriptor
    desc.fill(0xff, 3 * 32, 4 * 32); // row 3: 256 bits
    const got = await cpuVoter(desc).knn2(new Uint8Array(32));
    expect([got.best[0], got.dBest[0], got.second[0], got.dSecond[0]]).toEqual([1, 1, 2, 1]);
    const far = await cpuVoter(desc).knn2(new Uint8Array(32).fill(0xff));
    expect([far.best[0], far.dBest[0], far.second[0], far.dSecond[0]]).toEqual([3, 0, 0, 252]);
  });

  it("says when there is no second row, or no row", async () => {
    const one = await cpuVoter(randomDescriptors(1, 9)).knn2(randomDescriptors(2, 10));
    expect([...one.best]).toEqual([0, 0]);
    expect([...one.second]).toEqual([NO_ROW, NO_ROW]);
    expect([...one.dSecond]).toEqual([NO_DISTANCE, NO_DISTANCE]);
    const none = await cpuVoter(new Uint8Array(0)).knn2(randomDescriptors(1, 11));
    expect([none.best[0], none.dBest[0]]).toEqual([NO_ROW, NO_DISTANCE]);
    expect((await cpuVoter(randomDescriptors(4, 12)).knn2(new Uint8Array(0))).best.length).toBe(0);
  });

  it("reads descriptors at any byte offset", async () => {
    const desc = randomDescriptors(200, 13);
    const queries = queriesFrom(desc, 20, 14);
    const shifted = new Uint8Array(desc.length + 3);
    shifted.set(desc, 3);
    const shiftedQueries = new Uint8Array(queries.length + 1);
    shiftedQueries.set(queries, 1);
    expect(await cpuVoter(shifted.subarray(3)).knn2(shiftedQueries.subarray(1))).toEqual(naive(desc, queries));
  });

  it("refuses a length that is not whole descriptors", async () => {
    expect(() => cpuVoter(new Uint8Array(33))).toThrow(/32-byte/);
    await expect(cpuVoter(new Uint8Array(32)).knn2(new Uint8Array(31))).rejects.toThrow(/32-byte/);
  });
});

describe("writeInPieces", () => {
  /** A queue that records each write's bytes and where they land, and each wait between them. */
  function recordingQueue(size: number) {
    const target = new Uint8Array(size);
    const log: string[] = [];
    const queue = {
      writeBuffer(_buffer: GPUBuffer, at: number, data: Uint8Array, dataOffset: number, bytes: number): void {
        log.push(`write ${at} ${bytes}`);
        target.set(data.subarray(dataOffset, dataOffset + bytes), at);
      },
      async onSubmittedWorkDone(): Promise<void> {
        log.push("wait");
      },
    };
    return { target, log, queue: queue as unknown as Pick<GPUQueue, "writeBuffer" | "onSubmittedWorkDone"> };
  }
  const buffer = {} as GPUBuffer;

  it("copies the same bytes in pieces of at most the piece size, waiting after each", async () => {
    const src = randomDescriptors(100, 31);
    const { target, log, queue } = recordingQueue(70 * DESCRIPTOR_BYTES);
    await writeInPieces(queue, buffer, src, 30 * DESCRIPTOR_BYTES, 70 * DESCRIPTOR_BYTES, 32 * DESCRIPTOR_BYTES);
    expect(target).toEqual(src.subarray(30 * DESCRIPTOR_BYTES, 100 * DESCRIPTOR_BYTES));
    expect(log).toEqual(["write 0 1024", "wait", "write 1024 1024", "wait", "write 2048 192", "wait"]);
  });

  it("writes once when the bytes fit in one piece, and not at all for none", async () => {
    const src = randomDescriptors(4, 32);
    const one = recordingQueue(src.length);
    await writeInPieces(one.queue, buffer, src, 0, src.length, 4 * 1024 * 1024);
    expect(one.target).toEqual(src);
    expect(one.log).toEqual([`write 0 ${src.length}`, "wait"]);
    const none = recordingQueue(0);
    await writeInPieces(none.queue, buffer, src, 0, 0, 1024);
    expect(none.log).toEqual([]);
  });

  it("refuses a piece size that is not a positive integer", async () => {
    const { queue } = recordingQueue(64);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(writeInPieces(queue, buffer, new Uint8Array(64), 0, 64, bad)).rejects.toThrow("positive integer");
    }
  });

  it("does not start the next piece before the wait resolves", async () => {
    const src = randomDescriptors(8, 33);
    const log: string[] = [];
    let release: () => void = () => undefined;
    const queue = {
      writeBuffer(_b: GPUBuffer, at: number): void { log.push(`write ${at}`); },
      onSubmittedWorkDone: () => new Promise<void>((done) => { release = done; }),
    } as unknown as Pick<GPUQueue, "writeBuffer" | "onSubmittedWorkDone">;
    const writing = writeInPieces(queue, buffer, src, 0, src.length, 4 * DESCRIPTOR_BYTES);
    await new Promise((done) => setTimeout(done, 0));
    expect(log).toEqual(["write 0"]);
    release();
    await new Promise((done) => setTimeout(done, 0));
    expect(log).toEqual(["write 0", "write 128"]);
    release();
    await writing;
  });
});

describe("gpuVoter's upload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A device that does nothing but record each write into an index buffer, with the queue's
   *  waits between them. Large limits, so the whole index is one buffer unless the test splits it. */
  function fakeDevice() {
    vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, UNIFORM: 8, MAP_READ: 16 });
    const log: string[] = [];
    const indexBuffers = new Set<object>();
    const pipeline = { getBindGroupLayout: () => ({}) };
    const device = {
      limits: {
        maxStorageBufferBindingSize: 2 ** 31, maxBufferSize: 2 ** 31, maxComputeWorkgroupsPerDimension: 65_535,
        maxComputeWorkgroupStorageSize: 32_768, maxComputeInvocationsPerWorkgroup: 256,
      },
      pushErrorScope: () => undefined,
      popErrorScope: async () => null,
      createShaderModule: () => ({}),
      createComputePipelineAsync: async () => pipeline,
      createBindGroup: () => ({}),
      createBuffer: (d: { size: number; usage: number }) => {
        const b = { size: d.size, destroy: () => undefined };
        if (d.usage === (1 | 2)) indexBuffers.add(b);
        return b;
      },
      queue: {
        writeBuffer: (b: object, at: number, _data: Uint8Array, _from: number, bytes: number) => {
          if (indexBuffers.has(b)) log.push(`write ${at} ${bytes}`);
        },
        onSubmittedWorkDone: async () => {
          log.push("wait");
        },
      },
    };
    return { device: device as unknown as GPUDevice, log };
  }

  it("copies a large index 4 MiB at a time by default, waiting after each piece", async () => {
    const { device, log } = fakeDevice();
    const rows = (9 * 1024 * 1024) / DESCRIPTOR_BYTES + 5;
    await gpuVoter(device, new Uint8Array(rows * DESCRIPTOR_BYTES));
    const mib = 4 * 1024 * 1024;
    expect(log).toEqual([`write 0 ${mib}`, "wait", `write ${mib} ${mib}`, "wait", `write ${2 * mib} ${1024 * 1024 + 5 * 32}`, "wait"]);
  });

  it("uses uploadPieceBytes, and an explicit undefined is the default", async () => {
    const small = fakeDevice();
    await gpuVoter(small.device, new Uint8Array(10 * DESCRIPTOR_BYTES), { uploadPieceBytes: 4 * DESCRIPTOR_BYTES });
    expect(small.log).toEqual(["write 0 128", "wait", "write 128 128", "wait", "write 256 64", "wait"]);
    const unset = fakeDevice();
    await gpuVoter(unset.device, new Uint8Array(10 * DESCRIPTOR_BYTES), { uploadPieceBytes: undefined });
    expect(unset.log).toEqual(["write 0 320", "wait"]);
  });

  it("refuses a piece size that is not a positive multiple of 32", async () => {
    for (const bad of [48, 31]) {
      await expect(gpuVoter(fakeDevice().device, new Uint8Array(32), { uploadPieceBytes: bad })).rejects.toThrow("multiple of 32");
    }
    for (const bad of [0, -32, 1.5]) {
      await expect(gpuVoter(fakeDevice().device, new Uint8Array(32), { uploadPieceBytes: bad })).rejects.toThrow("positive integer");
    }
  });
});
