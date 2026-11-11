// SPDX-License-Identifier: Apache-2.0
// The vote's WebGPU checks, run in a browser page by scripts/webgpu-test.mjs: the GPU voter
// must give exactly what the CPU voter gives, and a timing of the whole-index vote.

import { cpuVoter, gpuVoter, voteDeviceLimits, type GpuVoterOptions, type KnnResult } from "../../src/geometric/vote.js";
import { queriesFrom, randomDescriptors, tiedDescriptors } from "../vote-fixtures.js";

async function device(): Promise<GPUDevice> {
  if (!navigator.gpu) throw new Error("this browser has no WebGPU");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no WebGPU adapter");
  return adapter.requestDevice({ requiredLimits: voteDeviceLimits(adapter) });
}

function firstDifference(a: KnnResult, b: KnnResult): string | null {
  for (const key of ["best", "second", "dBest", "dSecond"] as const) {
    if (a[key].length !== b[key].length) return `${key}: length ${a[key].length} vs ${b[key].length}`;
    for (let i = 0; i < a[key].length; i += 1) {
      if (a[key][i] !== b[key][i]) return `${key}[${i}]: ${a[key][i]} vs ${b[key][i]}`;
    }
  }
  return null;
}

interface Case { name: string; desc: Uint8Array; queries: Uint8Array; options?: GpuVoterOptions }

function cases(): Case[] {
  const list: Case[] = [];
  const add = (name: string, desc: Uint8Array, queries: Uint8Array, options?: GpuVoterOptions): void => {
    list.push(options ? { name, desc, queries, options } : { name, desc, queries });
  };
  add("no rows", new Uint8Array(0), randomDescriptors(5, 1));
  add("one row", randomDescriptors(1, 2), randomDescriptors(9, 3));
  add("two rows", randomDescriptors(2, 4), randomDescriptors(9, 5));
  add("no queries", randomDescriptors(100, 6), new Uint8Array(0));
  const odd = randomDescriptors(1000 + 37, 7);
  add("rows not a multiple of the tile", odd, queriesFrom(odd, 333, 8));
  const tied = tiedDescriptors(20_000 + 13, 6, 9);
  add("ties everywhere", tied, queriesFrom(tied, 500, 10));
  add("ties, small tiles and chunks", tied, queriesFrom(tied, 129, 11), { tileRows: 32, chunkRows: 96 });
  add("ties, several queries per invocation", tied, queriesFrom(tied, 501, 12), { queriesPerInvocation: 4 });
  const same = tiedDescriptors(5000, 1, 13);
  add("every row equal", same, queriesFrom(same, 64, 14));
  const big = randomDescriptors(65_536, 15);
  add("65,536 rows x 500 queries", big, queriesFrom(big, 500, 16));
  const split = tiedDescriptors(65_536 + 999, 40, 17);
  add("index split over buffers", split, queriesFrom(split, 300, 18), { chunkRows: 2048, maxRowsPerBuffer: 10_000 });
  add("queries split over dispatches", odd, queriesFrom(odd, 1000, 19), { maxQueriesPerDispatch: 300 });
  add("index uploaded in small pieces", odd, queriesFrom(odd, 200, 21), { uploadPieceBytes: 32 * 100 });
  add("index split over buffers, uploaded in pieces that do not divide a buffer", split, queriesFrom(split, 300, 22), {
    chunkRows: 2048, maxRowsPerBuffer: 10_000, uploadPieceBytes: 32 * 3001,
  });
  const unaligned = new Uint8Array(32 * 50 + 1).subarray(1);
  unaligned.set(queriesFrom(odd, 50, 20));
  add("queries at an unaligned offset", odd, unaligned);
  return list;
}

async function checks(): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const gpu = await device();
  const out: { name: string; ok: boolean; detail: string }[] = [];
  for (const c of cases()) {
    try {
      const expected = await cpuVoter(c.desc).knn2(c.queries);
      const voter = await gpuVoter(gpu, c.desc, c.options);
      const got = await voter.knn2(c.queries);
      const again = await voter.knn2(c.queries);
      voter.dispose();
      const diff = firstDifference(got, expected) ?? firstDifference(again, expected);
      out.push({ name: c.name, ok: diff === null, detail: diff ?? `${c.queries.length / 32} queries agree` });
    } catch (error) {
      out.push({ name: c.name, ok: false, detail: String(error) });
    }
  }
  gpu.destroy();
  return out;
}

async function bench(rows: number, queryCounts: number[], runs: number, options?: GpuVoterOptions): Promise<Record<string, unknown>> {
  const gpu = await device();
  const desc = randomDescriptors(rows, 101);
  const started = performance.now();
  const voter = await gpuVoter(gpu, desc, options);
  const setupMs = performance.now() - started;
  const timings: Record<string, unknown> = { rows, setupMs: Math.round(setupMs), options: options ?? {} };
  for (const q of queryCounts) {
    const queries = queriesFrom(desc, q, 200 + q);
    const ms: number[] = [];
    for (let i = 0; i < runs + 1; i += 1) {
      const t = performance.now();
      await voter.knn2(queries);
      ms.push(performance.now() - t);
    }
    const first = ms.shift()!;
    ms.sort((a, b) => a - b);
    timings[`q${q}`] = { firstMs: +first.toFixed(1), medianMs: +ms[Math.floor(ms.length / 2)]!.toFixed(1), minMs: +ms[0]!.toFixed(1), maxMs: +ms[ms.length - 1]!.toFixed(1) };
  }
  voter.dispose();
  const info = gpu.adapterInfo;
  timings.adapter = `${info.vendor} ${info.architecture} ${info.description}`.trim();
  gpu.destroy();
  return timings;
}

declare global {
  interface Window {
    voteChecks: typeof checks;
    voteBench: typeof bench;
  }
}
window.voteChecks = checks;
window.voteBench = bench;
