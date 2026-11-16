// SPDX-License-Identifier: Apache-2.0
// The fixture's compute page: the host's compute realm, over the toy release in the extension.
// The toy models are stand-ins: the detector returns fixed boxes whatever the picture, and the
// recognizer only tells the toy cards apart. Nothing here recognizes real cards.

import { createSettingsCore, type HostCompute, startHostCompute, type WorkerLike } from "@cardvision/host-compute";

import { CONFIG } from "./config.js";
import { SCHEMA } from "./settings.js";
import { STORE } from "./store.js";

/** A development build only: the idle unload in ms, from the build (`--idle-unload-ms`), or null. */
declare const __IDLE_UNLOAD_MS__: number | null;

/** The harness reads this: the page's state in the shape it expects of a development build. */
declare global {
  interface Window {
    __toyDebug?: () => Record<string, unknown>;
  }
}

const epochNow = (): number => performance.timeOrigin + performance.now();
let loadedAt: number | null = null;
let helloAt: number | null = null;
let analyzed = 0;
let host: HostCompute | null = null;
let settingsOrigin: string | null = null;

// When the page finished loading, and when the first message from the embedding page arrived
// (the content script's hello): the harness reports the difference.
window.addEventListener("load", () => (loadedAt ??= epochNow()));
window.addEventListener(
  "message",
  (event) => {
    if (helloAt === null && event.source === window.parent) helloAt = epochNow();
  },
  true,
);

window.__toyDebug = () => {
  const status = host?.frame.core?.status() ?? null;
  return {
    state: host?.frame.state ?? "loading",
    error: status?.error ?? null,
    lastFrameError: status?.lastFrameError ?? null,
    lastWorkerMs: status?.lastWorkerMs ?? null,
    backend: status?.backend ?? null,
    analyzed,
    restarts: host?.frame.restarts ?? 0,
    stopped: host?.frame.stopped ?? false,
    release: host?.frame.release ?? null,
    settingsOrigin,
    loadedAt,
    helloAt,
  };
};

const settings = createSettingsCore(SCHEMA, STORE);

host = await startHostCompute({
  config: CONFIG,
  win: window,
  storage: STORE,
  createWorker: () => new Worker(chrome.runtime.getURL("runtime/worker.js"), { type: "module" }) as unknown as WorkerLike,
  loadRequest: async () => {
    settingsOrigin = (await settings.read()).origin;
    return { kind: "load", releaseUrl: chrome.runtime.getURL("release/release.json") };
  },
  observe: { onAnalysis: () => (analyzed += 1) },
  ...(__IDLE_UNLOAD_MS__ === null ? {} : { devIdleUnloadMs: __IDLE_UNLOAD_MS__ }),
});
