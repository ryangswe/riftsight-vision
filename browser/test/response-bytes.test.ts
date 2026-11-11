// SPDX-License-Identifier: Apache-2.0
// The shared byte reader (src/response-bytes.ts): through `blob()` when the response has one,
// through `arrayBuffer()` otherwise, the same bytes either way.

import { describe, expect, it } from "vitest";

import { readResponseBytes } from "../src/response-bytes.js";

const BYTES = new Uint8Array([1, 2, 3, 250, 251, 0, 7]);

/** A response that counts which reader was used. `withBlob: false` has no `blob` at all. */
export function spyResponse(bytes: Uint8Array, withBlob: boolean) {
  const calls = { blob: 0, arrayBuffer: 0 };
  const copy = (): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const response: { arrayBuffer(): Promise<ArrayBuffer>; blob?(): Promise<Blob> } = {
    arrayBuffer: async () => (calls.arrayBuffer++, copy()),
  };
  if (withBlob) response.blob = async () => (calls.blob++, new Blob([copy()]));
  return { response, calls };
}

describe("readResponseBytes", () => {
  it("reads through blob() when the response has one, and never through arrayBuffer()", async () => {
    const { response, calls } = spyResponse(BYTES, true);
    expect(new Uint8Array(await readResponseBytes(response))).toEqual(BYTES);
    expect(calls).toEqual({ blob: 1, arrayBuffer: 0 });
  });

  it("falls back to arrayBuffer() when the response has no blob()", async () => {
    const { response, calls } = spyResponse(BYTES, false);
    expect(new Uint8Array(await readResponseBytes(response))).toEqual(BYTES);
    expect(calls).toEqual({ blob: 0, arrayBuffer: 1 });
  });

  it("gives the same bytes from a real Response", async () => {
    const real = new Response(BYTES);
    expect(typeof real.blob).toBe("function");
    expect(new Uint8Array(await readResponseBytes(real))).toEqual(BYTES);
  });
});
