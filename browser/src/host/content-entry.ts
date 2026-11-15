// SPDX-License-Identifier: Apache-2.0
// The content realm's one import of the shared hover host (experimental, not part of the public
// API). The capture control is not exported: the host owns it.

export type { ClientBox } from "../capture.js";
export type { FractionBox, ShownCard } from "../compute-messages.js";
export { HIDE_DELAY_MS, type HostContent, type HostContentEnv, startHostContent } from "./content.js";
export { pagePolicy } from "./site-policy.js";
export type { KeyValueStorage, StorageChanges } from "./settings-core.js";
export type { ViewAdapter, ViewFrame, ViewLayout } from "./view.js";
export type { ProductConfig } from "./config.js";
