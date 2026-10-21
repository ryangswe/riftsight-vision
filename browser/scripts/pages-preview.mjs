// SPDX-License-Identifier: Apache-2.0
// Build the hosted demo and serve it on this machine only (127.0.0.1), as a host of plain files
// would. Run it with
//
//   npm run preview:pages -- --release FOLDER [--port 8765] [--release-port 8766]
//   npm run preview:pages -- --release-url URL [--port 8765]
//   npm run preview:pages -- --games toy,one-piece --toy FOLDER [--port 8765]
//
// With --release, the release folder stands in for the model host: it is served on a port of
// its own, a different origin from the page, with `Access-Control-Allow-Origin: *` as a model
// host sends it, and the site is built with the address of its release.json. With --release-url
// the site is built with that address, and nothing else is served. With --games the site is
// built with a game picker, as the workflow builds it (a game at an address is fetched from
// there), and nothing else is served either. Each way the site is the output of `npm run build:pages` for that address, byte for byte,
// and is served from dist/pages/ as it is: no file is added, changed or answered for by the
// server itself. It only answers GET requests, and makes no requests of its own.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";

import { inside, TYPES } from "./demo-paths.mjs";
import { buildPages, PAGES_DIST } from "./pages.mjs";

const USAGE = `Usage: npm run preview:pages -- (--release FOLDER | --release-url URL | --games LIST [--toy FOLDER]) [--port N] [--release-port N] [--out FOLDER]

Builds the hosted demo into dist/pages and serves it on this machine only (127.0.0.1).

  --release FOLDER    a release folder, served on its own port with
                      Access-Control-Allow-Origin: *, as a model host serves it.
                      The site is built with the address of its release.json.
  --release-url URL   build with this release address instead, and serve no release
                      folder.
  --games LIST        build with a game picker instead, as the workflow does: the
                      games, separated by commas (npm run build:pages -- --help).
  --toy FOLDER        the toy game's folder, when LIST names toy.
  --port N            the port of the page (default 8765). 0 takes any free port.
  --release-port N    the port of the release folder (default 8766). 0 takes any free port.
  --out FOLDER        where to build the site (default dist/pages). Emptied first.
  --help              print this and exit
`;

const KNOWN = ["--release", "--release-url", "--games", "--toy", "--port", "--release-port", "--out"];

function options(args) {
  const found = {};
  for (let at = 0; at < args.length; at += 2) {
    const name = args[at];
    if (name === "--help" || name === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    const value = args[at + 1];
    const problem = !KNOWN.includes(name) ? `unknown option ${name}` : value === undefined ? `${name} needs a value` : null;
    if (problem) fail(`${problem}\n\n${USAGE}`);
    found[name.slice(2)] = value;
  }
  return found;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function portOf(name, text) {
  if (!/^\d+$/.test(text) || Number(text) > 65535) fail(`--${name} ${text}: not a port number (0 to 65535)\n\n${USAGE}`);
  return Number(text);
}

const given = options(process.argv.slice(2));
const port = portOf("port", given.port ?? "8765");
const releasePort = portOf("release-port", given["release-port"] ?? "8766");
if ([given.release, given["release-url"], given.games].filter((value) => value !== undefined).length !== 1) fail(`give one of --release FOLDER, --release-url URL and --games LIST\n\n${USAGE}`);
if (given.release !== undefined && !(existsSync(given.release) && statSync(given.release).isDirectory())) fail(`--release ${given.release}: no such folder`);
if (given.release !== undefined && !existsSync(join(given.release, "release.json"))) fail(`--release ${given.release}: it holds no release.json`);

/** A server of one folder's files as they are. `headers` are added to every answer. */
function folderServer(folder, headers) {
  return createServer((request, response) => {
    let path = null;
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      path = null;
    }
    const file = request.method === "GET" && path !== null ? inside(folder, path.endsWith("/") ? `${path}index.html` : path) : null;
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(request.method === "GET" ? 404 : 405, { "content-type": TYPES[".txt"], ...headers });
      response.end(request.method === "GET" ? "not found\n" : "only GET is answered\n");
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": statSync(file).size,
      "cache-control": "no-store",
      ...headers,
    });
    createReadStream(file).pipe(response);
  });
}

function listen(server, at) {
  return new Promise((done) => {
    server.on("error", (error) => fail(error.code === "EADDRINUSE" ? `port ${at} is in use on 127.0.0.1: choose another, or 0 for any free one` : String(error)));
    server.listen(at, "127.0.0.1", () => done(server.address().port));
  });
}

let releaseUrl = given["release-url"];
if (given.release !== undefined) {
  const listening = await listen(folderServer(resolve(given.release), { "access-control-allow-origin": "*" }), releasePort);
  releaseUrl = `http://127.0.0.1:${listening}/release.json`;
  console.log(`release folder: ${resolve(given.release)} (served at http://127.0.0.1:${listening}/, with Access-Control-Allow-Origin: *)`);
}
const out = given.out === undefined ? PAGES_DIST : resolve(given.out);
let built;
try {
  built = await buildPages(given.games === undefined ? { releaseUrl, out } : { games: given.games, toy: given.toy === undefined ? undefined : resolve(given.toy), out });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const listening = await listen(folderServer(out, {}), port);
if (built.games) {
  console.log(`hosted demo: http://127.0.0.1:${listening}/ (${given.out === undefined ? "dist/pages" : out}, ${built.files.length} files, as npm run build:pages -- --games ${given.games}${given.toy === undefined ? "" : ` --toy "${resolve(given.toy)}"`} writes them)`);
  for (const game of built.games) console.log(`game ${game.id}: ${game.label}, ${game.release === null ? "its model from a folder the visitor chooses" : `its model from ${game.release}`}`);
} else {
  console.log(`hosted demo: http://127.0.0.1:${listening}/ (${given.out === undefined ? "dist/pages" : out}, ${built.files.length} files, as npm run build:pages -- --release-url ${releaseUrl === "" ? '""' : releaseUrl} writes them)`);
  console.log(built.release ? `the page loads its model from ${built.release.url}` : "no release address: the page says that no model is set");
}
