// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): which pages are active, when each loads (at play or at the
// earliest pointer), and which parents may frame the compute page. Spec clauses S-G1 to S-G3.

import type { ProductConfig } from "./config.js";

export type Site = "youtube" | "twitch" | "local";
export type PagePolicy = { active: false } | { active: true; site: Site; load: "play" | "pointer"; route: string };
export interface Route {
  id: string;
  site: Site;
  load: "play" | "pointer";
  test(path: string): boolean;
}

/** The seven Twitch side pages: addresses that are not a channel and load at a hover (S-G3). */
export const TWITCH_SIDE_PAGES: readonly string[] = [
  "following", "creatorcamp", "collections", "payments", "privacy", "products", "team",
];

/** The side pages and the rest of the shared list of Twitch's own first path segments (28). None of
 *  them is a channel name. Lowercase; a name is lowercased before the lookup. */
export const TWITCH_RESERVED: readonly string[] = [
  ...TWITCH_SIDE_PAGES,
  "bits", "broadcast", "directory", "downloads", "drops", "friends", "inventory", "jobs", "messages",
  "moderator", "p", "popout", "prime", "search", "settings", "store", "subscriptions", "turbo", "u",
  "videos", "wallet",
];
const RESERVED = new Set(TWITCH_RESERVED);

/** A channel's live page, which holds the watch player while the channel is live. */
const CHANNEL_LIVE = /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/live\/?$/;
const TW_VIDEO = /^\/videos\/\d+\/?$/;
const TW_CLIP = /^\/([A-Za-z0-9_]{1,25})\/clip\/[A-Za-z0-9_-]+\/?$/;
const TW_CHANNEL = /^\/([A-Za-z0-9_]{1,25})\/?$/;

function notReserved(name: string | undefined): boolean {
  return name !== undefined && !RESERVED.has(name.toLowerCase());
}

/** One array, first match wins, path only (a query and a `#` part are not part of a path). A route
 *  is looked up only among the routes of the page's site. */
export const ROUTES: readonly Route[] = [
  { id: "yt-watch", site: "youtube", load: "play", test: (p) => p === "/watch" },
  { id: "yt-live", site: "youtube", load: "play", test: (p) => p.startsWith("/live/") },
  { id: "yt-channel-live", site: "youtube", load: "play", test: (p) => CHANNEL_LIVE.test(p) },
  { id: "yt-embed", site: "youtube", load: "pointer", test: (p) => p.startsWith("/embed/") },
  { id: "tw-video", site: "twitch", load: "play", test: (p) => TW_VIDEO.test(p) },
  { id: "tw-clip", site: "twitch", load: "play", test: (p) => notReserved(TW_CLIP.exec(p)?.[1]) },
  { id: "tw-channel", site: "twitch", load: "play", test: (p) => notReserved(TW_CHANNEL.exec(p)?.[1]) },
  { id: "tw-other", site: "twitch", load: "pointer", test: () => true },
  { id: "local", site: "local", load: "play", test: () => true },
];

function siteOf(url: URL, config: Pick<ProductConfig, "sites" | "dev">): Site | null {
  if (url.protocol === "https:" && url.hostname === "www.youtube.com") return config.sites.youtube ? "youtube" : null;
  if (url.protocol === "https:" && url.hostname === "www.twitch.tv") return config.sites.twitch ? "twitch" : null;
  if (config.dev && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return "local";
  return null;
}

/** Whether hovers run on this page, and when its video loads. Read at each event from the current
 *  address, so in-page navigation needs no extra code. */
export function pagePolicy(url: URL, config: Pick<ProductConfig, "sites" | "dev">): PagePolicy {
  const site = siteOf(url, config);
  if (site === null) return { active: false };
  for (const route of ROUTES) {
    if (route.site === site && route.test(url.pathname)) return { active: true, site, load: route.load, route: route.id };
  }
  return { active: false };
}

/** Whether a page at this origin may frame the compute page. */
export function allowedParentOrigin(origin: string, config: Pick<ProductConfig, "sites" | "dev">): boolean {
  if (config.sites.youtube && origin === "https://www.youtube.com") return true;
  if (config.sites.twitch && origin === "https://www.twitch.tv") return true;
  return config.dev && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}
