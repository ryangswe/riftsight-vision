// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): which pages are active, and which parents may frame the
// compute page. Types are frozen here; the route table and the bodies are not written yet.

import type { ProductConfig } from "./config.js";

export type Site = "youtube" | "twitch" | "local";
export type PagePolicy = { active: false } | { active: true; site: Site; load: "play" | "pointer"; route: string };
export interface Route {
  id: string;
  site: Site;
  load: "play" | "pointer";
  test(path: string): boolean;
}

/** One array, first match wins, path only. Empty until the table is written. */
export const ROUTES: readonly Route[] = [];
/** The Twitch side pages (seven). Empty until written. */
export const TWITCH_SIDE_PAGES: readonly string[] = [];
/** The side pages and the rest of the shared reserved list (28). Empty until written. */
export const TWITCH_RESERVED: readonly string[] = [];

export function pagePolicy(_url: URL, _config: Pick<ProductConfig, "sites" | "dev">): PagePolicy {
  throw new Error("not implemented yet");
}

export function allowedParentOrigin(_origin: string, _config: Pick<ProductConfig, "sites" | "dev">): boolean {
  throw new Error("not implemented yet");
}
