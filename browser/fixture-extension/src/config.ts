// SPDX-License-Identifier: Apache-2.0
// What the fixture tells the host about itself. A development build: the fixture serves the
// harness's local page and nothing else.

import type { ProductConfig } from "@cardvision/host-content";

export const CONFIG: ProductConfig = {
  tag: "toy",
  name: "Toy fixture",
  sites: { youtube: false, twitch: false },
  dev: true,
  frames: { compute: "compute.html", view: "view.html" },
  outline: { edgeColor: "#ffffff", glowColor: "#7a5cff" },
  capabilities: { geometricStage: false },
};

/** Where the toy settings file is fetched from (the build puts the address in). */
declare const __SETTINGS_URL__: string;
export const SETTINGS_URL = __SETTINGS_URL__;
