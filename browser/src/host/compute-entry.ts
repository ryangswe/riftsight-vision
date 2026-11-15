// SPDX-License-Identifier: Apache-2.0
// The compute realm's one import of the shared hover host (experimental, not part of the public API).

export { DRIVER_TICK_MS } from "../frame-scheduler.js";
export type { ProductConfig } from "./config.js";
export { type ComputeFrame, GEOMETRIC_OPTIONS, type HostCompute, type HostComputeEnv, type LoadRequest, type ReleaseInEffect, startHostCompute, STANDARD_PRESET, type WorkerLike } from "./compute.js";
export { createSettingsCore } from "./settings-core.js";
