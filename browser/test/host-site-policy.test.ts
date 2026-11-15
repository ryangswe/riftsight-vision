// SPDX-License-Identifier: Apache-2.0
// The shared hover host's site policy. The address tables and examples are read out of
// docs/hover-spec.md (S-G1 to S-G3), so an edit to the spec that breaks a row fails here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allowedParentOrigin,
  pagePolicy,
  ROUTES,
  TWITCH_RESERVED,
  TWITCH_SIDE_PAGES,
} from "../src/host/site-policy.js";

const SPEC = readFileSync(fileURLToPath(new URL("../../docs/hover-spec.md", import.meta.url)), "utf8");
const BOTH = { sites: { youtube: true, twitch: true }, dev: false };
const DEV = { sites: { youtube: true, twitch: true }, dev: true };

function section(id: string): string {
  const start = SPEC.indexOf(`### ${id} `);
  expect(start, `spec section ${id}`).toBeGreaterThanOrEqual(0);
  const next = SPEC.indexOf("\n### ", start + 4);
  return SPEC.slice(start, next < 0 ? undefined : next);
}
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
const twitch = (path: string) => pagePolicy(new URL(`https://www.twitch.tv${path}`), BOTH);
const youtube = (path: string) => pagePolicy(new URL(`https://www.youtube.com${path}`), BOTH);
const loadOf = (p: ReturnType<typeof pagePolicy>) => (p.active ? p.load : "inactive");

/** A placeholder in a spec address becomes a concrete one. */
const concrete = (address: string) => address.replace(/…/g, "x");

interface Row { cell: string; loads: "play" | "pointer"; addresses: string[] }
function g3Rows(): Row[] {
  const lines = section("S-G3").split("\n");
  const head = lines.findIndex((l) => l.startsWith("| Address | Loads |"));
  expect(head).toBeGreaterThanOrEqual(0);
  const rows: Row[] = [];
  for (const line of lines.slice(head + 2)) {
    if (!line.startsWith("|")) break;
    const [cell, loads] = line.split("|").slice(1, 3).map((c) => c.trim()) as [string, string];
    expect(["at play", "at a hover"]).toContain(loads);
    // Backticks inside the parenthetical remarks are prose, not addresses.
    const addresses = ticks(cell.replace(/\([^)]*\)/g, "")).filter((a) => a.startsWith("/"));
    rows.push({ cell, loads: loads === "at play" ? "play" : "pointer", addresses });
  }
  return rows;
}

describe("S-G3 address table, read from the spec", () => {
  const rows = g3Rows();

  it("has the rows the table is expected to carry", () => {
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(rows.flatMap((r) => r.addresses).length).toBeGreaterThanOrEqual(40);
  });

  for (const row of g3Rows()) {
    for (const address of row.addresses) {
      it(`${address} loads ${row.loads === "play" ? "at play" : "at a hover"}`, () => {
        const policy = twitch(concrete(address));
        expect(policy.active).toBe(true);
        expect(loadOf(policy)).toBe(row.loads);
      });
    }
  }

  it("covers the rows that carry no address in backticks", () => {
    const find = (text: string) => rows.find((r) => r.cell.includes(text));
    expect(find("26-character name")?.loads).toBe("pointer");
    expect(loadOf(twitch(`/${"a".repeat(25)}`))).toBe("play");
    expect(loadOf(twitch(`/${"a".repeat(26)}`))).toBe("pointer");
    expect(loadOf(twitch("/a-b"))).toBe("pointer");
    expect(loadOf(twitch("/a.b"))).toBe("pointer");
    expect(find("moving inside Twitch")?.loads).toBe("pointer");
    // The channel page and the side page are told apart by the address alone, at each event.
    expect(loadOf(twitch("/name"))).toBe("play");
    expect(loadOf(twitch("/following"))).toBe("pointer");
  });

  it("names exactly the side pages the policy lists", () => {
    const prose = section("S-G3").match(/exactly these seven:([^.]*)\./s);
    expect(prose).not.toBeNull();
    const fromProse = ticks(prose![1]!).map((a) => a.replace(/^\//, ""));
    expect([...fromProse].sort()).toEqual([...TWITCH_SIDE_PAGES].sort());
    expect(TWITCH_SIDE_PAGES).toHaveLength(7);
    const sideRow = rows.find((r) => r.addresses.includes("/following"))!;
    expect(sideRow.addresses.map((a) => a.slice(1)).sort()).toEqual([...TWITCH_SIDE_PAGES].sort());
  });

  it("keeps the reserved list at 28 distinct lowercase names that contain the side pages", () => {
    expect(TWITCH_RESERVED).toHaveLength(28);
    expect(new Set(TWITCH_RESERVED).size).toBe(28);
    for (const name of TWITCH_RESERVED) expect(name).toBe(name.toLowerCase());
    for (const side of TWITCH_SIDE_PAGES) expect(TWITCH_RESERVED).toContain(side);
    for (const name of TWITCH_RESERVED) {
      expect(loadOf(twitch(`/${name}`))).toBe("pointer");
      expect(loadOf(twitch(`/${name.toUpperCase()}`))).toBe("pointer");
      expect(loadOf(twitch(`/${name}/clip/slug`))).toBe("pointer");
    }
  });

  it("ignores a query and a # part", () => {
    expect(loadOf(twitch("/name?x=1#top"))).toBe("play");
    expect(loadOf(twitch("/following?x=1"))).toBe("pointer");
    expect(loadOf(twitch("/videos/123?t=5s"))).toBe("play");
  });

  it("does not serve embeds on other sites, m.twitch.tv or http", () => {
    expect(pagePolicy(new URL("https://m.twitch.tv/name"), BOTH)).toEqual({ active: false });
    expect(pagePolicy(new URL("http://www.twitch.tv/name"), BOTH)).toEqual({ active: false });
    expect(pagePolicy(new URL("https://example.com/name"), BOTH)).toEqual({ active: false });
  });

  it("names the route that matched", () => {
    expect(twitch("/videos/1")).toMatchObject({ site: "twitch", route: "tw-video" });
    expect(twitch("/name/clip/a-B_1")).toMatchObject({ route: "tw-clip" });
    expect(twitch("/name")).toMatchObject({ route: "tw-channel" });
    expect(twitch("/")).toMatchObject({ route: "tw-other" });
  });
});

describe("S-G1 and S-G2 examples, read from the spec", () => {
  it("S-G1: /@name/live is active, /@name/videos is not, m.youtube.com is not", () => {
    const example = section("S-G1").split("Example:")[1]!;
    const [site, live, videos, watch, host] = ticks(example);
    expect([site, live, videos, watch, host]).toEqual(["www.youtube.com", "/@name/live", "/@name/videos", "/watch", "m.youtube.com"]);
    expect(youtube(live!).active).toBe(true);
    expect(youtube(videos!).active).toBe(false);
    expect(pagePolicy(new URL(`https://${host}${watch}`), BOTH).active).toBe(false);
  });

  it("S-G1: the listed YouTube pages are active", () => {
    const list = section("S-G1").split("Active pages:")[1]!.split("Elsewhere")[0]!;
    expect(ticks(list)).toEqual(expect.arrayContaining(["/watch", "/embed/…", "/live/…", "/@name/live", "/channel/…/live", "/c/…/live", "/user/…/live"]));
    // A bare `/live` names the channel form, not a page of its own.
    for (const a of ticks(list).filter((t) => t.startsWith("/") && t !== "/live")) expect(youtube(concrete(a)).active, a).toBe(true);
    for (const path of ["/", "/results", "/@name", "/@name/videos", "/live", "/shorts/x", "/watch/x", "/@name/live/x"]) {
      expect(youtube(path).active, path).toBe(false);
    }
  });

  it("S-G1: every Twitch page is active", () => {
    for (const path of ["/", "/directory", "/anything/at/all", "/following"]) expect(twitch(path).active).toBe(true);
  });

  it("S-G2: /watch loads at play, /embed/x waits for a hover", () => {
    const example = section("S-G2").split("Example:")[1]!;
    const [watch, embed] = ticks(example);
    expect([watch, embed]).toEqual(["/watch?v=x", "/embed/x"]);
    expect(youtube(watch!)).toEqual({ active: true, site: "youtube", load: "play", route: "yt-watch" });
    expect(youtube(embed!)).toEqual({ active: true, site: "youtube", load: "pointer", route: "yt-embed" });
    expect(youtube("/live/abc")).toMatchObject({ load: "play", route: "yt-live" });
    expect(youtube("/@name/live/")).toMatchObject({ load: "play", route: "yt-channel-live" });
  });

  it("S-G3: the example addresses", () => {
    const example = section("S-G3").split("Example:")[1]!.split("Today:")[0]!;
    expect(ticks(example)).toEqual(["www.twitch.tv", "/name/clip/AbC-123", "/following", "/videos/123", "/Videos/123"]);
    expect(loadOf(twitch("/name/clip/AbC-123"))).toBe("play");
    expect(loadOf(twitch("/following"))).toBe("pointer");
    expect(loadOf(twitch("/videos/123"))).toBe("play");
    expect(loadOf(twitch("/Videos/123"))).toBe("pointer");
  });
});

describe("sites, development and parents", () => {
  it("a site the config turns off is not active", () => {
    const yt = { sites: { youtube: true, twitch: false }, dev: false };
    const tw = { sites: { youtube: false, twitch: true }, dev: false };
    expect(pagePolicy(new URL("https://www.twitch.tv/name"), yt).active).toBe(false);
    expect(pagePolicy(new URL("https://www.youtube.com/watch"), tw).active).toBe(false);
    expect(pagePolicy(new URL("https://www.twitch.tv/name"), tw).active).toBe(true);
  });

  it("the local hosts are served in a development build only, at play, on any path", () => {
    for (const url of ["http://127.0.0.1/x", "http://localhost:8080/a/b?c=1", "http://127.0.0.1:3000/"]) {
      expect(pagePolicy(new URL(url), DEV)).toEqual({ active: true, site: "local", load: "play", route: "local" });
      expect(pagePolicy(new URL(url), BOTH)).toEqual({ active: false });
    }
    expect(pagePolicy(new URL("https://localhost/x"), DEV).active).toBe(false);
    expect(pagePolicy(new URL("http://localhost.evil.com/x"), DEV).active).toBe(false);
  });

  it("route ids are unique and the table has one array, first match wins", () => {
    expect(new Set(ROUTES.map((r) => r.id)).size).toBe(ROUTES.length);
    expect(ROUTES.map((r) => r.id)).toEqual([
      "yt-watch", "yt-live", "yt-channel-live", "yt-embed", "tw-video", "tw-clip", "tw-channel", "tw-other", "local",
    ]);
  });

  it("allowedParentOrigin: exact origins, per site, plus the local hosts in development", () => {
    expect(allowedParentOrigin("https://www.youtube.com", BOTH)).toBe(true);
    expect(allowedParentOrigin("https://www.twitch.tv", BOTH)).toBe(true);
    for (const o of ["https://youtube.com", "https://m.youtube.com", "http://www.youtube.com", "https://www.youtube.com/", "https://www.twitch.tv.evil.com", "null", ""]) {
      expect(allowedParentOrigin(o, BOTH), o).toBe(false);
    }
    expect(allowedParentOrigin("https://www.twitch.tv", { sites: { youtube: true, twitch: false }, dev: false })).toBe(false);
    expect(allowedParentOrigin("https://www.youtube.com", { sites: { youtube: false, twitch: true }, dev: false })).toBe(false);
    expect(allowedParentOrigin("http://127.0.0.1:8080", BOTH)).toBe(false);
    for (const o of ["http://127.0.0.1", "http://localhost", "http://localhost:3000", "http://127.0.0.1:8080"]) {
      expect(allowedParentOrigin(o, DEV), o).toBe(true);
    }
    for (const o of ["https://localhost", "http://localhost.evil.com", "http://localhost:abc", "http://127.0.0.1:"]) {
      expect(allowedParentOrigin(o, DEV), o).toBe(false);
    }
  });
});

// The two products' current site rules, ported as written (read from each product's main branch),
// run beside the host's policy over one set of addresses. Where the host differs from a product,
// the difference is listed and is one the spec sets (S-G3 "Today").
const YT_CHANNEL_LIVE = /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/live\/?$/;
function productYoutube(path: string): "play" | "pointer" | "inactive" {
  if (!(path === "/watch" || path.startsWith("/embed/") || path.startsWith("/live/") || YT_CHANNEL_LIVE.test(path))) return "inactive";
  return path.startsWith("/embed/") ? "pointer" : "play";
}

// Kenbunshoku rules: a first-segment list and one address regex.
const KB_SITE_PAGES = new Set([
  "bits", "broadcast", "collections", "directory", "downloads", "drops", "friends", "inventory", "jobs", "messages", "moderator",
  "p", "payments", "popout", "prime", "privacy", "products", "search", "settings", "store", "subscriptions", "team", "turbo", "u",
  "videos", "wallet",
]);
const KB_PLAYER_PAGE = /^\/(?:videos\/\d+|([A-Za-z0-9_]{1,25})(?:\/clip\/[A-Za-z0-9_-]+)?)\/?$/;
function kenbunshokuTwitch(path: string): "play" | "pointer" {
  const page = KB_PLAYER_PAGE.exec(path);
  return page !== null && (page[1] === undefined || !KB_SITE_PAGES.has(page[1].toLowerCase())) ? "play" : "pointer";
}

// DuelSight rules: path parts with empty parts dropped, and a shorter list.
const DS_NOT_CHANNEL = new Set([
  "directory", "search", "settings", "subscriptions", "inventory", "wallet", "drops", "downloads", "jobs", "p", "turbo",
  "prime", "friends", "messages", "following", "videos", "u", "store", "bits", "creatorcamp", "broadcast", "moderator", "popout",
]);
function duelsightTwitch(path: string): "play" | "pointer" {
  const parts = path.split("/").filter((p) => p !== "");
  if (parts[0]?.toLowerCase() === "videos") return parts.length === 2 && /^\d+$/.test(parts[1]!) ? "play" : "pointer";
  if (parts.length === 0 || !/^[A-Za-z0-9_]{1,25}$/.test(parts[0]!) || DS_NOT_CHANNEL.has(parts[0]!.toLowerCase())) return "pointer";
  return parts.length === 1 || (parts.length === 3 && parts[1] === "clip") ? "play" : "pointer";
}

const CORPUS = [
  "/", "/name", "/name/", "/Name", "/a_b9", "/name/clip/AbC-123", "/name/clip/AbC-123/", "/videos/123", "/videos/123/",
  "/videos/abc", "/videos", "/videos/", "/name/videos", "/name/about", "/name/schedule", "/name/clip", "/name/clip/slug/extra",
  "/name/Clip/slug", "/a-b", "/a.b", `/${"a".repeat(25)}`, `/${"a".repeat(26)}`,
  ...TWITCH_RESERVED.flatMap((n) => [`/${n}`, `/${n}/`, `/${n}/x`, `/${n.toUpperCase()}`, `/${n}/clip/slug`]),
  "/Videos/123", "/VIDEOS/123", "//name", "/name//", "/videos//123", "/name/clip/a.b", "/name/clip/a%20b", "/name//clip/slug",
  "/Following", "/Collections/x",
];

describe("each product's current site rules give the same answers through the host's policy", () => {
  it("Kenbunshoku: YouTube pages and every Twitch address, bar the two side pages it lacks", () => {
    for (const path of CORPUS) {
      const host = loadOf(twitch(path));
      const product = kenbunshokuTwitch(path);
      if (host !== product) {
        expect(path, `${path}: host ${host}, product ${product}`).toMatch(/^\/(following|creatorcamp)(\/?|\/clip\/slug)$/i);
        expect([host, product]).toEqual(["pointer", "play"]);
      }
    }
    // The one difference in the list: following and creatorcamp wait for a hover now.
    expect(kenbunshokuTwitch("/following")).toBe("play");
    expect(loadOf(twitch("/following"))).toBe("pointer");
    expect(kenbunshokuTwitch("/creatorcamp")).toBe("play");
    expect(loadOf(twitch("/creatorcamp"))).toBe("pointer");
    for (const path of ["/watch", "/embed/x", "/live/x", "/@n/live", "/channel/c/live/", "/c/c/live", "/user/u/live", "/", "/results", "/@n/videos", "/live"]) {
      expect(loadOf(youtube(path)), path).toBe(productYoutube(path));
    }
  });

  it("DuelSight: YouTube pages and every Twitch address, bar the differences S-G3 names", () => {
    const seen = new Set<string>();
    for (const path of CORPUS) {
      const host = loadOf(twitch(path));
      const product = duelsightTwitch(path);
      if (host === product) continue;
      seen.add(path);
      // Only ever the product loading at play where S-G3 now waits for a hover.
      expect([host, product], path).toEqual(["pointer", "play"]);
      expect(
        /^\/(collections|payments|privacy|products|team)(\/?|\/clip\/slug)$/i.test(path) || // the five side pages it lacks
          /^\/Videos\/|^\/VIDEOS\//.test(path) || // /videos/ is lowercase only
          /\/\//.test(path) || // repeated slashes
          /\/clip\/[^/]*[^A-Za-z0-9_/-][^/]*$/.test(path), // a clip slug character Twitch does not use
        path,
      ).toBe(true);
    }
    for (const path of ["/collections", "/payments", "/privacy", "/products", "/team", "/Videos/123", "//name", "/name/clip/a.b"]) {
      expect(seen.has(path), path).toBe(true);
    }
    for (const path of ["/watch", "/embed/x", "/live/x", "/@n/live", "/channel/c/live/", "/c/c/live", "/user/u/live", "/", "/results", "/@n/videos", "/live"]) {
      expect(loadOf(youtube(path)), path).toBe(productYoutube(path));
    }
  });

  it("both products' parent-origin rules give the same answers", () => {
    // Both: exact https origins per enabled site, and the local hosts with an optional port in dev.
    const product = (origin: string, dev: boolean) =>
      origin === "https://www.youtube.com" || origin === "https://www.twitch.tv" || (dev && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin));
    for (const origin of ["https://www.youtube.com", "https://www.twitch.tv", "https://youtube.com", "http://localhost:5173", "http://127.0.0.1", "null", "https://localhost"]) {
      for (const dev of [false, true]) expect(allowedParentOrigin(origin, { sites: { youtube: true, twitch: true }, dev }), `${origin} ${dev}`).toBe(product(origin, dev));
    }
  });
});
