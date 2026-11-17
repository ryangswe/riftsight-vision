// SPDX-License-Identifier: Apache-2.0
// The one import of the shared hover host (experimental, not part of the public API) for the
// background, the view frame and the popup. It holds no DOM, so it runs in a service worker.

export { type ProductConfig, productConfigError } from "./config.js";
export {
  compareVersions,
  createSettingsCore,
  DISMISSED_UPDATE_KEY,
  type EffectiveSettings,
  type KeyValueStorage,
  LAST_ATTEMPT_KEY,
  LAST_GOOD_KEY,
  type RefreshOutcome,
  SETTINGS_REFRESH_MS,
  type SettingsCore,
  type SettingsSchema,
  type StorageChange,
  type StorageChanges,
  updateNotice,
} from "./settings-core.js";
export { allowedParentOrigin, type PagePolicy, pagePolicy, type Route, ROUTES, type Site, TWITCH_RESERVED, TWITCH_SIDE_PAGES } from "./site-policy.js";
export { createSwitches, ENABLED_KEY, KEEP_CARD_KEY, type Switches } from "./switches.js";
