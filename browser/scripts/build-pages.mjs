// SPDX-License-Identifier: Apache-2.0
// Build the hosted demo, a static site, into dist/pages/ (scripts/pages.mjs says what is in it):
//
//   npm run build:pages -- --release-url URL [--out FOLDER]
//   npm run build:pages -- --games toy,one-piece --toy FOLDER [--out FOLDER]
//
// With --release-url, URL is the address of a release document; its files are fetched from
// beside it. An empty URL (`--release-url ""`) builds a site with no model, and the page says so.
// With --games the page opens with a game picker (README.md, "The hosted demo"). The GitHub
// Pages workflow (.github/workflows/pages.yml) builds the picker: --games toy,one-piece.

import { resolve } from "node:path";

import { buildPages, HOSTED_GAMES, PAGES_DIST } from "./pages.mjs";

const USAGE = `Usage: npm run build:pages -- (--release-url URL | --games LIST [--toy FOLDER]) [--out FOLDER]

Builds the demo page as a static site, for GitHub Pages or any host of plain files.

  --release-url URL  the address of the release document the page loads, such as
                     https://huggingface.co/ACCOUNT/MODEL/resolve/REVISION/release.json.
                     Its files are fetched from beside it. Give "" to build a page
                     with no model, which says so.
  --games LIST       build a page with a game picker instead, offering these games in
                     this order, separated by commas: ${Object.keys(HOSTED_GAMES).join(", ")}.
                     The first is chosen when the page opens.
  --toy FOLDER       the toy game's folder, which the site bundles; needed when LIST
                     names toy. Write it with (from the repository's root)
                     python tests/test_browser_fixtures.py --demo FOLDER
  --out FOLDER       where to write the site (default dist/pages). Emptied first.
  --help             print this and exit
`;

const args = process.argv.slice(2);
const found = {};
for (let at = 0; at < args.length; at += 2) {
  const name = args[at];
  if (name === "--help" || name === "-h") {
    console.log(USAGE);
    process.exit(0);
  }
  const value = args[at + 1];
  const problem = !["--release-url", "--games", "--toy", "--out"].includes(name) ? `unknown option ${name}` : value === undefined ? `${name} needs a value` : null;
  if (problem) {
    console.error(`${problem}\n\n${USAGE}`);
    process.exit(2);
  }
  found[name.slice(2)] = value;
}
if ((found["release-url"] === undefined) === (found.games === undefined)) {
  console.error(`give one of --release-url (the address of a release document, or "" for a page with no model) and --games\n\n${USAGE}`);
  process.exit(2);
}

let built;
try {
  built = await buildPages({ releaseUrl: found["release-url"], games: found.games, toy: found.toy === undefined ? undefined : resolve(found.toy), out: found.out === undefined ? PAGES_DIST : resolve(found.out) });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const out = found.out === undefined ? "dist/pages" : resolve(found.out);
const page = built.files.filter((name) => !name.startsWith("games/"));
const bundled = built.files.length - page.length;
console.log(`${out}: ${built.files.length} files (${page.join(", ")}${bundled > 0 ? `, and ${bundled} in games/` : ""})`);
if (built.games) for (const game of built.games) console.log(`game ${game.id}: ${game.label}, ${game.release === null ? "its model from a folder the visitor chooses" : `its model from ${game.release}`}`);
else console.log(built.release ? `the page loads its model from ${built.release.url}` : "no release address: the page says that no model is set");
