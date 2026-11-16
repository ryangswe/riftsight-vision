// SPDX-License-Identifier: Apache-2.0
// The fixture's background: it reads the toy settings file from the settings host when it starts,
// and again when a page asks (at most once an hour otherwise: the core's own rule).

import { createSettingsCore } from "@cardvision/host-settings";

import { SCHEMA } from "./settings.js";

const core = createSettingsCore(SCHEMA, chrome.storage.local);

function refresh(force: boolean): void {
  void core
    .refresh({ fetch: (input, init) => fetch(input, init), now: () => Date.now(), force })
    .then((outcome) => console.info("Toy fixture: settings", JSON.stringify(outcome)));
}

refresh(false);
chrome.runtime.onMessage.addListener((message) => {
  if ((message as { type?: unknown } | null)?.type === "settings:refresh") refresh(true);
});
