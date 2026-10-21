// SPDX-License-Identifier: Apache-2.0
// The hosted demo: the demo page as a static site, for a host that serves files and nothing else
// (GitHub Pages). It is the same page as `npm run demo` serves, told at build time where the
// release lives: the address of a release document, whose files are fetched from beside it and
// checked against their SHA-256 as everywhere else. The scoring page is not part of it.
//
//   index.html           the demo page, with a Content-Security-Policy and the release address
//   demo.js, *.css       the page's script and style sheets
//   lib/worker.js        the analysis worker
//   lib/ort-wasm-*       the one pair of ONNX Runtime Web files the worker loads
//   *.LEGAL.txt          the license comments of the bundled third-party code
//   THIRD-PARTY-NOTICES.txt  the full license texts of that code (scripts/notices.mjs), linked
//                        from the page's header
//   games/toy/           with a game picker that offers the toy game: its release, its 20 card
//                        images (colored shapes) and the example table.png and table.webm
//
// Built with `--release-url` the page loads that one release. Built with `--games` it opens with
// a game picker instead (HOSTED_GAMES below; README.md, "The hosted demo"). `npm run build:pages`
// writes it (scripts/build-pages.mjs), and `npm run preview:pages` builds it and serves it on
// this machine (scripts/pages-preview.mjs). The functions above `copyToy` read and write no
// file, so the rules can be tested without a build.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { NOTICES_NAME, noticesFor } from "./notices.mjs";

/** The repository the hosted page links to. */
export const REPOSITORY_URL = "https://github.com/ryangswe/riftsight-vision";

/** The name of the meta element that carries the release address. The page is in hosted mode
 *  when it has one, even an empty one (a build with no address). */
export const RELEASE_META = "cardvision-release";

/**
 * Where a model host keeps the files that a URL on it redirects to. A browser checks every hop
 * of a redirect against the policy, so a release on such a host needs its storage allowed as
 * well. Hugging Face answers a `/resolve/` URL of a large file with a redirect to its file
 * storage, on a subdomain of hf.co (us.aws.cdn.hf.co, as checked on 2026-10-17, and a regional
 * host of the same domain elsewhere). A small file answers with a redirect on huggingface.co
 * itself, which the release's folder already allows: a browser ignores the path of a source for
 * a request that was redirected.
 */
export const STORAGE_HOSTS = {
  "huggingface.co": ["https://*.hf.co"],
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The release address a build is given, checked: `{ release: null }` for none (an empty value),
 * `{ release: { url, folder } }` for an address, or `{ problem }` in words. An address is an https
 * URL of a release document, or an http one on this machine for a preview. It has no user name,
 * no query and no fragment, and no character that would end a source of the policy.
 */
export function releaseAddress(text) {
  const given = (text ?? "").trim();
  if (given === "") return { release: null };
  let url;
  try {
    url = new URL(given);
  } catch {
    return { problem: `${given} is not an absolute URL` };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    return { problem: `${given}: the release must be served over https (http only on this machine, for a preview)` };
  }
  if (url.username !== "" || url.password !== "") return { problem: `${given}: an address with a user name or a password is refused` };
  if (url.search !== "" || url.hash !== "" || given.includes("?") || given.includes("#")) return { problem: `${given}: an address with a query or a fragment is refused` };
  if (url.pathname.endsWith("/")) return { problem: `${given}: give the address of the release document itself, such as .../release.json` };
  if (/[\s;,'"<>\\]/.test(url.href)) return { problem: `${given}: the address holds a character a policy source cannot` };
  return { release: { url: url.href, folder: url.href.slice(0, url.href.lastIndexOf("/") + 1) } };
}

/**
 * The Content-Security-Policy of the hosted page. The page and its worker run under it (the
 * worker is started from a blob: URL, so it inherits the page's policy).
 *
 * - script-src 'self': the page's script, the worker and ONNX Runtime's loader, all from the site;
 *   'wasm-unsafe-eval' lets ONNX Runtime compile its WebAssembly, and allows no JavaScript eval.
 * - worker-src 'self' blob:: the worker's starting script, made by the page (blob:), and
 *   lib/worker.js, which it imports (a worker's own imports are checked against worker-src).
 * - connect-src: the site (ONNX Runtime's .wasm file), the folder of the release document, and
 *   the storage its host redirects to (STORAGE_HOSTS). Nothing else can be fetched.
 * - img-src, media-src: the file chosen or dropped, which the page shows from a blob: URL, and the
 *   page's empty icon (data:). With `images` (a game of the picker whose card images are bundled
 *   with the site, the toy game) img-src allows the site too, for those images in the tooltip.
 * - style-src 'self': the two style sheets.
 *
 * `release` is the release a page loads, null for none, or a list of releases (the picker's
 * games): each one not on the site adds its folder and its host's storage.
 */
export function contentSecurityPolicy(release, { images = false } = {}) {
  const connect = ["'self'"];
  for (const one of Array.isArray(release) ? release : release ? [release] : []) {
    for (const source of [one.folder, ...(STORAGE_HOSTS[new URL(one.url).hostname] ?? [])]) {
      if (!connect.includes(source)) connect.push(source);
    }
  }
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    `connect-src ${connect.join(" ")}`,
    images ? "img-src 'self' blob: data:" : "img-src blob: data:",
    "media-src blob:",
    "style-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

const attribute = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Replace one exact piece of the page, which must be there once: a page that has changed shape
 *  stops the build instead of being published half-changed. */
function replaceOnce(html, piece, by) {
  const at = html.indexOf(piece);
  if (at < 0 || html.indexOf(piece, at + 1) >= 0) throw new Error(`demo/index.html: expected one ${JSON.stringify(piece)}`);
  return html.slice(0, at) + by + html.slice(at + piece.length);
}

export const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">\n';
export const SCORE_LINK = '<a class="quiet" href="score.html">Scoring page</a>';
export const REPOSITORY_LINK = `<a class="quiet" href="${REPOSITORY_URL}">Source code and documentation</a>`;
export const NOTICES_LINK = `<a class="quiet" href="${NOTICES_NAME}">Third-party notices</a>`;
/** What the hosted page's header carries in place of the link to the scoring page. */
export const HOSTED_LINKS = `<span class="page-links">${REPOSITORY_LINK}${NOTICES_LINK}</span>`;

/** The demo page as the hosted site serves it: the policy and the release address after the
 *  viewport, and the links to the repository and to the third-party notices in place of the link
 *  to the scoring page. With
 *  `games` (a picker, `pickerGames`) the page carries the list of games in place of one release
 *  address, and the policy allows what every game of the list needs. */
export function hostedPage(html, release, games = null) {
  const head = games === null
    ? [
      `<meta http-equiv="Content-Security-Policy" content="${attribute(contentSecurityPolicy(release))}">`,
      `<meta name="${RELEASE_META}" content="${attribute(release?.url ?? "")}">`,
    ]
    : [
      `<meta http-equiv="Content-Security-Policy" content="${attribute(gamesPolicy(games))}">`,
      `<meta name="${GAMES_META}" content="${attribute(JSON.stringify(games))}">`,
    ];
  return replaceOnce(replaceOnce(html, VIEWPORT, `${VIEWPORT}${head.join("\n")}\n`), SCORE_LINK, HOSTED_LINKS);
}

// ---------------------------------------------------------------------------------------------
// The game picker. A hosted build can offer more than one game: the page then opens with a choice
// of games, loads the release of the one chosen, and drops the session of the one before. Each
// game is one entry of HOSTED_GAMES; `--games` names the entries a build offers, in the order the
// picker shows them, and the first is chosen when the page opens.
//
// A game's release is either bundled with the site (copied in at build time from a folder on
// disk, and fetched from the site itself) or at an https address (fetched from there, with its
// folder and its host's storage allowed by the policy). Card images are shown only for a bundled
// game that has them; a game at an address is names only. The `local` choice has neither: its
// release, and its card images if any, are folders the visitor chooses on their computer, read by
// the page (demo/page.ts, "a release from files"), so it adds nothing to the policy.

/** The name of the meta element that carries the picker's games, as JSON. */
export const GAMES_META = "cardvision-games";

/** Where the toy game's files are in the built site. */
export const TOY_SITE = "games/toy/";

/** The Hugging Face page of the One Piece release, linked from its credit line. */
export const ONE_PIECE_PAGE = "https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece";

/** The commit of that repository the page loads (release f80d5b56cd907f03, B2.1): a later commit
 *  to the repository does not change what the published page loads. */
export const ONE_PIECE_REVISION = "5526f531863381745780f4377f1cae767077ca77";

/**
 * The games a build can offer, by the name `--games` gives them. `bundled` games are copied into
 * the site from a folder given at build time (`--toy FOLDER` for the toy game); the others load
 * their release from `release`. To add a game, add an entry here (and, for a bundled one, the
 * option that names its folder): the page needs no change.
 */
export const HOSTED_GAMES = {
  toy: {
    label: "Toy game (practice)",
    models: "the toy game's models",
    bundled: true,
    notes: [
      "The toy game's models are stand-ins with no skill, and its 20 cards are colored shapes. It is here to learn how hovering works: load the example table, then move the pointer over a card.",
    ],
    credit: null,
  },
  "one-piece": {
    label: "One Piece Card Game (Kenbunshoku models)",
    models: "the One Piece models",
    bundled: false,
    release: `${ONE_PIECE_PAGE}/resolve/${ONE_PIECE_REVISION}/release.json`,
    notes: [
      "Drop a screenshot or a video of your own game. Names only: no card image is shown or downloaded.",
      "Unofficial fan project, not affiliated with Bandai.",
    ],
    credit: { text: "Models: Kenbunshoku One Piece release B2.1 (Apache-2.0)", href: ONE_PIECE_PAGE },
  },
  local: {
    label: "Your game (files on this computer)",
    models: "your models",
    bundled: false,
    local: true,
    notes: [
      "Files you choose are read on this computer by this page; nothing is uploaded, and this page makes no request for them.",
    ],
    credit: null,
  },
};

/** The games `--games` names, checked: `{ games: [name, ...] }` or `{ problem }` in words. */
export function gameNames(text) {
  const names = (text ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
  if (names.length === 0) return { problem: `--games names no game: give one or more of ${Object.keys(HOSTED_GAMES).join(", ")}, separated by commas` };
  for (const name of names) {
    if (!Object.hasOwn(HOSTED_GAMES, name)) return { problem: `--games ${text}: ${name} is not a game this build knows (${Object.keys(HOSTED_GAMES).join(", ")})` };
  }
  if (new Set(names).size !== names.length) return { problem: `--games ${text}: a game is named twice` };
  return { games: names };
}

/**
 * The games as the page is given them (the GAMES_META element), in the picker's order. Each has
 * an id, the label of its choice, the address of its release (relative to the page for a
 * bundled one), the folder of its card images relative to the page (or null: names only), the
 * example files a button opens, the lines that say what it is, and a credit line with a link.
 */
export function pickerGames(names) {
  return names.map((id) => {
    const game = HOSTED_GAMES[id];
    if (game.bundled) {
      return {
        id, label: game.label, models: game.models, release: `${TOY_SITE}release/release.json`, images: `${TOY_SITE}images/`,
        examples: [
          { label: "Load the example table", path: `${TOY_SITE}table.png` },
          { label: "Load the example video", path: `${TOY_SITE}table.webm` },
        ],
        notes: game.notes, credit: game.credit,
      };
    }
    if (game.local) return { id, label: game.label, models: game.models, release: null, local: true, images: null, examples: [], notes: game.notes, credit: game.credit };
    return { id, label: game.label, models: game.models, release: game.release, images: null, examples: [], notes: game.notes, credit: game.credit };
  });
}

/** The policy of a page with a picker: what each of its games needs, and nothing more. The local
 *  choice needs nothing: the page reads the folders chosen, and shows its card images from blob:
 *  URLs, which the policy allows for the file on show already. */
export function gamesPolicy(games) {
  const remote = games.filter((game) => typeof game.release === "string" && /^https?:/.test(game.release)).map((game) => {
    const checked = releaseAddress(game.release);
    if (!checked.release) throw new Error(`game ${game.id}: ${checked.problem}`);
    return checked.release;
  });
  return contentSecurityPolicy(remote, { images: games.some((game) => game.images !== null) });
}

/** A plain file name, as a release pins its files and a catalog names its images: no folder. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Every `path` a release document pins. */
function pinnedPaths(document) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "path" && typeof inner === "string") found.push(inner);
        else walk(inner);
      }
    }
  };
  walk(document);
  return found;
}

const TOY_HOW = "python tests/test_browser_fixtures.py --demo FOLDER (run from the repository's root) writes it";

/**
 * Copy the toy game into a site: its release (release.json and the files it pins), the image of
 * each card its catalog names, table.png and table.webm, from the folder that
 * `python tests/test_browser_fixtures.py --demo FOLDER` writes. Nothing else of that folder is
 * copied. Returns the paths written, relative to the site.
 */
export function copyToy(folder, out) {
  const need = (path, what) => {
    if (!existsSync(path)) throw new Error(`--toy ${folder}: no ${what} (${path}). ${TOY_HOW}`);
    return path;
  };
  const release = JSON.parse(readFileSync(need(join(folder, "release", "release.json"), "release/release.json"), "utf-8"));
  const target = join(out, ...TOY_SITE.split("/").filter(Boolean));
  mkdirSync(join(target, "release"), { recursive: true });
  mkdirSync(join(target, "images"), { recursive: true });
  const written = [];
  const copy = (from, ...to) => {
    copyFileSync(from, join(target, ...to));
    written.push(`${TOY_SITE}${to.join("/")}`);
  };
  copy(join(folder, "release", "release.json"), "release", "release.json");
  let catalog = null;
  for (const path of pinnedPaths(release)) {
    if (!PLAIN_NAME.test(path)) throw new Error(`--toy ${folder}: the release pins ${path}, which is not a plain file name beside it`);
    copy(need(join(folder, "release", path), `release/${path}`), "release", path);
    if (path === release.catalog?.path) catalog = JSON.parse(readFileSync(join(folder, "release", path), "utf-8"));
  }
  if (catalog?.game !== "toy") throw new Error(`--toy ${folder}: its release is not the toy game's (catalog game ${JSON.stringify(catalog?.game)}). ${TOY_HOW}`);
  for (const card of catalog.cards) {
    if (card.art === null || card.art === undefined) continue;
    if (!PLAIN_NAME.test(card.art) || !/\.png$/.test(card.art)) throw new Error(`--toy ${folder}: card ${card.id} names the image ${card.art}, not a plain .png name`);
    copy(need(join(folder, "art", card.art), `art/${card.art}`), "images", card.art);
  }
  copy(need(join(folder, "table.png"), "table.png"), "table.png");
  copy(need(join(folder, "table.webm"), "table.webm (it needs OpenCV when it is written)"), "table.webm");
  return written.sort();
}

/** The files of a built site, as paths relative to it with forward slashes, sorted. */
export function siteFiles(folder) {
  const found = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(at, entry.name));
      else found.push(relative(folder, join(at, entry.name)).split(sep).join("/"));
    }
  };
  walk(folder);
  return found.sort();
}

const root = fileURLToPath(new URL("..", import.meta.url));
export const PAGES_DIST = join(root, "dist", "pages");

/**
 * Build the hosted site into `out` (default dist/pages/), emptied first. Either `releaseUrl`, the
 * address of a release document (empty for none), or `games`, the names of the picker's games
 * (HOSTED_GAMES), with `toy`, the folder the toy game is copied from when it is one of them. The
 * same inputs give the same bytes. Returns the release (or null), the games (or null) and the
 * files written.
 */
export async function buildPages({ releaseUrl, games: gamesText, toy, out = PAGES_DIST }) {
  let checked = { release: null };
  let games = null;
  if (gamesText !== undefined) {
    if (releaseUrl !== undefined) throw new Error("give --release-url or --games, not both");
    const named = gameNames(gamesText);
    if (named.problem) throw new Error(named.problem);
    if (named.games.includes("toy") && (toy === undefined || toy === "")) throw new Error(`--games names toy: give --toy FOLDER, the toy game's folder. ${TOY_HOW}`);
    if (!named.games.includes("toy") && toy !== undefined) throw new Error("--toy is given, and --games does not name toy");
    games = pickerGames(named.games);
    gamesPolicy(games);
  } else {
    checked = releaseAddress(releaseUrl);
    if (checked.problem) throw new Error(`--release-url ${checked.problem}`);
  }
  const { build } = await import("esbuild");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "lib"), { recursive: true });
  const shared = { bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, sourcemap: false, logLevel: "warning", legalComments: "linked" };
  await build({ ...shared, entryPoints: { demo: join(root, "demo/demo.ts") }, outdir: out });
  await build({ ...shared, entryPoints: { worker: join(root, "src/worker.ts") }, outdir: join(out, "lib") });
  for (const name of ["theme.css", "demo.css"]) copyFileSync(join(root, "demo", name), join(out, name));
  writeFileSync(join(out, NOTICES_NAME), noticesFor(root));
  writeFileSync(join(out, "index.html"), hostedPage(readFileSync(join(root, "demo", "index.html"), "utf-8"), checked.release, games));
  // The worker names the ONNX Runtime files it loads: those, and no other, are copied beside it.
  const ortDist = dirname(createRequire(import.meta.url).resolve("onnxruntime-web"));
  const named = new Set(readFileSync(join(out, "lib", "worker.js"), "utf-8").match(/ort-wasm-[a-z-]+(?:\.[a-z]+)*\.(?:wasm|mjs)/g) ?? []);
  if (named.size === 0) throw new Error("lib/worker.js names no ONNX Runtime file: the hosted build does not know which to copy");
  for (const name of [...named].sort()) copyFileSync(join(ortDist, name), join(out, "lib", name));
  if (games?.some((game) => game.id === "toy")) copyToy(toy, out);
  return { release: checked.release, games, files: siteFiles(out) };
}
