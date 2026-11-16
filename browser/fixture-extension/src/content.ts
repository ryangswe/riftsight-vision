// SPDX-License-Identifier: Apache-2.0
// The fixture's content script: the host's content realm with the fixture's adapter.

import { startHostContent } from "@cardvision/host-content";

import { createAdapter } from "./adapter.js";
import { CONFIG } from "./config.js";

startHostContent({
  config: CONFIG,
  win: window,
  doc: document,
  extensionUrl: (path) => chrome.runtime.getURL(path),
  storage: chrome.storage.local,
  storageChanges: chrome.storage.onChanged,
  view: createAdapter(),
});
