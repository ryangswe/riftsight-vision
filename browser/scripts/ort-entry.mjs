// SPDX-License-Identifier: Apache-2.0
// Which ONNX Runtime Web entry a build bundles. src/ort.ts imports `onnxruntime-web/all`: WebGPU
// and WebAssembly, in one WebAssembly file (ort-wasm-simd-threaded.jsep.wasm). The esbuild plugin
// here makes a build take `onnxruntime-web/wasm` in its place: WebAssembly only, with a file about
// half the size (ort-wasm-simd-threaded.wasm), for a page whose host has a per-file limit. The same
// source is built both ways; nothing in src/ changes.

/** The runtimes a build can bundle: the default, and WebAssembly only. */
export const RUNTIMES = ["all", "wasm"];

const WASM = "onnxruntime-web/wasm";

/** An esbuild plugin that resolves `onnxruntime-web/all` as `onnxruntime-web/wasm` (bundled or external, as the build says). */
export const wasmOnlyOrt = {
  name: "cardvision-wasm-only-ort",
  setup(build) {
    build.onResolve({ filter: /^onnxruntime-web\/all$/ }, async (args) => {
      if (args.pluginData?.wasmOnly) return undefined;
      const resolved = await build.resolve(WASM, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { wasmOnly: true } });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      return { path: resolved.path, external: resolved.external, namespace: resolved.namespace, sideEffects: resolved.sideEffects };
    });
  },
};

/** The esbuild plugins for a runtime: none for the default, the swap for `wasm`. */
export function pluginsFor(runtime) {
  if (!RUNTIMES.includes(runtime)) throw new Error(`runtime must be one of ${RUNTIMES.join(", ")}, not "${runtime}"`);
  return runtime === "wasm" ? [wasmOnlyOrt] : [];
}
