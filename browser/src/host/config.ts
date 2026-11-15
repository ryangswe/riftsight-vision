// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental, not part of the public API): what a product tells the host
// about itself. Types are frozen here; the bodies that are not written yet throw.

export interface ProductConfig {
  /** Tag of the two-frame messages and of the outline's marker (data-<tag>="outline"). */
  tag: string;
  /** Shown in console lines only. */
  name: string;
  sites: { youtube: boolean; twitch: boolean };
  /** A development build: also serves http://127.0.0.1 and http://localhost. */
  dev: boolean;
  /** The extension's two pages, as paths inside it. */
  frames: { compute: string; view: string };
  outline: { edgeColor: string; glowColor: string };
  capabilities: {
    /** The product's releases can carry a geometric stage: focus scope, and the stage loads at
     *  the earliest pointer. False: a load request with geometric fields is refused at start. */
    geometricStage: boolean;
  };
}

/** What is wrong with a raw config, as one message; null when it is a valid ProductConfig. */
export function productConfigError(_raw: unknown): string | null {
  throw new Error("not implemented yet");
}
