// SPDX-License-Identifier: Apache-2.0
// How fast the first tooltip comes on the two-frame path: a page on 127.0.0.1 plays a clip, a
// stand-in content script (dist/page-capture.js, createCaptureControl) watches the video, and a
// compute frame on another local origin (dist/compute-session.js) runs the real worker on a
// release. The pointer is moved through the browser's input, so its events are trusted. Time runs
// from the trusted move, read in the page, to `onShown` with the expected card.
//
//   npm run hover-speed -- --release FOLDER --clip FILE --rests FILE [--load play|hover]
//        [--options FILE] [--scenes FILE --art FOLDER] [--scenarios H1,H2,H2P,H5,H6] [--count 20]
//        [--h5-count N] [--gaps 1000,3000,12000] [--backend auto|wasm] [--smoke]
//        [--expect-entry-look] [--entry-ms 50] [--limit 10000] [--out REPORT.json] [--chrome PATH]
//
// README.md, "Measuring hover speed", has the scenarios, the definition of cold and the gates.
// Exit code: 0 for a completed run, 1 when a hard gate fails, 2 on an error. Elapsed times are
// evidence to read, never thresholds.
//
// Chrome is driven with puppeteer-core, as in user-wait.mjs (PUPPETEER_CORE_DIR, or installed in
// this folder). Chrome is started by this script and only it is ended. A request to anything but
// 127.0.0.1 fails the run: it is refused by the page's request interception, the browser's
// host-resolver rules and, for workers, the rules alone; every refusal found is listed.

import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { arch, cpus, platform, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inside, TYPES } from "./demo-paths.mjs";
import { requestAllowed } from "./user-wait-core.mjs";
import { buildReport, DEFAULT_COUNT, entryLookProblem, DEFAULT_ENTRY_MS, DEFAULT_GAPS_MS, DEFAULT_LIMIT_MS, DEFAULT_OBSERVE_MS, intendedStage, optionsProblem, requestsOffPicture, SCENARIOS, scenarioProblem, scoreHover, scriptProblem, tally } from "./hover-speed-core.mjs";

const USAGE = `Usage: npm run hover-speed -- --release FOLDER --clip FILE --rests FILE [options]

  --release FOLDER   a release folder (a release document and the files it pins)
  --clip FILE        an image (drawn as a 15 frames a second stream) or a video file
  --rests FILE       the script: { "hovers": [{ "x", "y", "expect", "scene"? }], "slowPoint"?: {...},
                     "pairs"?: [{ "a": {...}, "b": {...}, "scene"? }] } (pairs are for H6)
  --load play|hover  when the frame is made for H2 and H5: at the video's play (default) or at the
                     first trusted move. H1 always makes it at the hover. With hover, H2 is skipped
  --options FILE     { "frame": {...}, "load": {...}, "stage": "none|ready|off|failed" }: extra
                     startComputeFrame options and load-request fields (geometricUrl, ...)
  --scenes FILE --art FOLDER   scenes drawn over an image clip (README.md, "Measuring the wait")
  --scenarios LIST   which of H1,H2,H2P,H5,H6 to run (default: H1,H2,H2P,H5 as --load allows; H6 only when named,
                     with --load play, pairs in the script and a stage ready with focus scope in --options)
  --count N          hovers per H1 and H2 (default ${DEFAULT_COUNT}); H2P runs at most 5
  --h5-count N       hovers per gap in H5 (default --count)
  --rest-ms MS       H6: how long the pointer rests on card A before it moves to card B (default 2000)
  --gaps LIST        H5 gaps off the picture in ms (default ${DEFAULT_GAPS_MS.join(",")})
  --backend B        auto (the release picks; default) or wasm (forced WebAssembly)
  --smoke            the forced WebAssembly smoke run: --backend wasm, 3 hovers, gaps 1000,3000
  --expect-entry-look  enforce the gates for the entry look (no picture requests while the pointer
                     is off the picture; a request within --entry-ms of the entry move)
  --entry-ms MS      default ${DEFAULT_ENTRY_MS}
  --limit MS         how long a hover waits for the card (default ${DEFAULT_LIMIT_MS})
  --out FILE         also write the report here
  --chrome PATH      the Chrome to drive (or CHROME in the environment)
  --headed           show the window
`;

const args = process.argv.slice(2);
const flags = new Set(["--smoke", "--expect-entry-look", "--headed", "--help"]);
const known = new Set(["--release", "--clip", "--rests", "--load", "--options", "--scenes", "--art", "--scenarios", "--count", "--h5-count", "--rest-ms", "--gaps", "--backend", "--entry-ms", "--limit", "--out", "--chrome"]);
const given = {};
function usageError(problem) {
  console.error(`${problem}\n\n${USAGE}`);
  process.exit(2);
}
for (let at = 0; at < args.length; at += 1) {
  const name = args[at];
  if (flags.has(name)) given[name.slice(2)] = true;
  else if (known.has(name) && args[at + 1] !== undefined) given[name.slice(2)] = args[++at];
  else usageError(known.has(name) ? `${name} needs a value` : `unknown option ${name}`);
}
if (given.help) {
  console.log(USAGE);
  process.exit(0);
}
for (const name of ["release", "clip", "rests"]) if (given[name] === undefined) usageError(`--${name} is required`);
const chrome = given.chrome ?? process.env.CHROME;
if (!chrome) usageError("Needs a Chrome (--chrome PATH or CHROME=PATH).");
const loadMode = given.load ?? "play";
if (!["play", "hover"].includes(loadMode)) usageError(`--load ${given.load}: play or hover`);
const smoke = given.smoke === true;
const backend = smoke ? "wasm" : (given.backend ?? "auto");
if (!["auto", "wasm"].includes(backend)) usageError(`--backend ${given.backend}: auto or wasm`);
const positive = (name, fallback) => {
  const value = given[name] === undefined ? fallback : Number(given[name]);
  if (!(Number.isInteger(value) && value > 0)) usageError(`--${name} ${given[name]}: not a whole number above 0`);
  return value;
};
const count = smoke && given.count === undefined ? 3 : positive("count", DEFAULT_COUNT);
const h5Count = smoke && given["h5-count"] === undefined ? 3 : positive("h5-count", count);
const restMs = positive("rest-ms", 2000);
const gaps = (given.gaps ?? (smoke ? "1000,3000" : DEFAULT_GAPS_MS.join(","))).split(",").map(Number);
if (gaps.some((g) => !(g >= 0))) usageError(`--gaps ${given.gaps}: not a list of ms`);
const limitMs = Number(given.limit ?? DEFAULT_LIMIT_MS);
const entryMs = Number(given["entry-ms"] ?? DEFAULT_ENTRY_MS);
if (!(limitMs > 0) || !(entryMs > 0)) usageError("--limit and --entry-ms must be positive");
const entryLook = given["expect-entry-look"] === true;
const allowed = loadMode === "play" ? SCENARIOS : SCENARIOS.filter((s) => s !== "H2" && s !== "H2P" && s !== "H6");
const scenarios = given.scenarios === undefined ? allowed.filter((s) => s !== "H6") : given.scenarios.split(",");
for (const s of scenarios) if (!SCENARIOS.includes(s)) usageError(`--scenarios ${s}: not a scenario (${SCENARIOS.join(", ")})`);
if (!existsSync(join(given.release, "release.json"))) usageError(`--release ${given.release}: no release.json in it`);
for (const name of ["clip", "rests"]) if (!existsSync(given[name]) || !statSync(given[name]).isFile()) usageError(`--${name} ${given[name]}: no such file`);
function readJson(path, name) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    return usageError(`${name} ${path}: ${error.message}`);
  }
}
const script = readJson(given.rests, "--rests");
{
  const problem = scriptProblem(script);
  if (problem) usageError(`--rests: ${problem}`);
}
const options = given.options === undefined ? {} : readJson(given.options, "--options");
{
  const problem = optionsProblem(options);
  if (problem) usageError(`--options: ${problem}`);
}
const stageIntended = intendedStage(options);
{
  const problem = entryLook ? entryLookProblem({ scenarios, gaps }) : null;
  if (problem) usageError(problem);
}
let sceneSpec = null;
if ((given.scenes === undefined) !== (given.art === undefined)) usageError("--scenes and --art go together");
if (given.scenes !== undefined) sceneSpec = readJson(given.scenes, "--scenes");
const clipFile = resolve(given.clip);
const isImage = /^image\//.test(TYPES[extname(clipFile).toLowerCase()] ?? "");
if (sceneSpec !== null && !isImage) usageError("--scenes draws over an image clip, not a video");
{
  const problem = scenarioProblem({ script, scenarios, loadMode, haveScenes: sceneSpec !== null });
  if (problem) usageError(problem);
  for (const s of scenarios) if (!allowed.includes(s) && s !== "H6") usageError(`--scenarios ${s}: not available with --load ${loadMode}`);
}
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
if (!existsSync(join(dist, "compute-session.js")) || !existsSync(join(dist, "page-capture.js"))) usageError("dist/ is missing: run `npm run build` first");

async function loadPuppeteer() {
  const folder = process.env.PUPPETEER_CORE_DIR;
  if (folder) {
    try {
      return createRequire(join(resolve(folder), "x.js"))("puppeteer-core");
    } catch {
      // fall through
    }
  }
  try {
    return (await import("puppeteer-core")).default;
  } catch {
    return null;
  }
}
const puppeteer = await loadPuppeteer();
if (puppeteer === null) {
  console.error("Needs the package puppeteer-core (PUPPETEER_CORE_DIR, or npm install --no-save puppeteer-core in this folder).");
  process.exit(2);
}

// ---- the two pages ---------------------------------------------------------------------------

const PAGE = `<!doctype html><meta charset="utf-8"><title>hover speed</title>
<style>body{margin:0;background:#222}video{display:block;width:1280px;max-height:768px;object-fit:contain}</style>
<video id="v" muted playsinline></video><script type="module" src="/page.js"></script>`;

const pageJs = (config) => `
import { computeProtocol, createCaptureControl, loadWhen } from "/lib/page-capture.js";
const CONFIG = ${JSON.stringify(config)};
const video = document.getElementById("v");
const protocol = computeProtocol("hs");
const events = [];
const log = (kind, extra = {}) => events.push({ t: performance.now(), kind, ...extra });
let iframe = null;
const outstanding = new Set();
let madeFrames = 0;

const art = {};
let scene = CONFIG.scenes ? (CONFIG.scenes.start ?? Object.keys(CONFIG.scenes.scenes)[0]) : null;

function makeFrame() {
  if (iframe) return;
  iframe = document.createElement("iframe");
  iframe.hidden = true;
  const frameConfig = { parentOrigin: location.origin, frame: CONFIG.frame, load: CONFIG.load };
  iframe.src = CONFIG.frameOrigin + "/frame.html?c=" + encodeURIComponent(JSON.stringify(frameConfig));
  document.body.append(iframe);
  madeFrames += 1;
  log("frame-made");
  control.connect();
}

const control = createCaptureControl({
  protocol,
  frame: () => (iframe ? iframe.contentWindow : null),
  frameOrigin: CONFIG.frameOrigin,
  onShown: (card) => log("shown", { cardId: card ? card.cardId : null }),
  onStatus: (s) => log("status", { state: s.state, backend: s.backend, error: s.error }),
  onProblem: (p) => log("problem", { problem: p }),
});
control.listen(window, document);

const overPicture = (e) => document.elementFromPoint(e.clientX, e.clientY) === video;
window.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") return;
  const over = overPicture(e);
  log("move", { over, trusted: e.isTrusted === true });
  if (e.isTrusted && over && CONFIG.makeAt === "hover") makeFrame();
}, true);

window.addEventListener("message", (e) => {
  const fromFrame = iframe !== null && e.source === iframe.contentWindow && e.origin === CONFIG.frameOrigin;
  if (fromFrame && e.data && e.data.hsprobe === 1) {
    if (e.data.kind === "answered") { outstanding.delete(e.data.requestId); log("answered", { requestId: e.data.requestId, how: e.data.how }); }
    else if (e.data.kind === "stage") log("stage", { state: e.data.state, reason: e.data.reason });
    else if (e.data.kind === "worker-out") log("worker-out", { what: e.data.what });
    else if (e.data.kind === "pointer-in") log("pointer-in");
    return;
  }
  const out = fromFrame ? protocol.parseComputeOut(e.data) : null;
  if (out && out.kind === "capture") {
    log("capture", { requestId: out.requestId, allowedNow: control.captureAllowedNow(), outstanding: outstanding.size });
    outstanding.add(out.requestId);
  }
  control.onMessage(e);
});

async function playClip() {
  if (CONFIG.image) {
    const image = new Image();
    image.src = "/clip";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    let n = 0;
    const SCENES = CONFIG.scenes ? CONFIG.scenes.scenes : null;
    if (SCENES) {
      for (const card of new Set(Object.values(SCENES).flat().map((c) => c.card))) {
        art[card] = new Image();
        art[card].src = "/art/" + card + ".png";
        await art[card].decode();
      }
    }
    const drawCard = (card) => {
      const im = art[card.card];
      const w = im.naturalWidth;
      const h = im.naturalHeight;
      context.save();
      if (card.turns === 1) { context.translate(card.x, card.y + w); context.rotate(-Math.PI / 2); }
      else if (card.turns === 2) { context.translate(card.x + w, card.y + h); context.rotate(Math.PI); }
      else if (card.turns === 3) { context.translate(card.x + h, card.y); context.rotate(Math.PI / 2); }
      else context.translate(card.x, card.y);
      context.drawImage(im, 0, 0);
      context.restore();
    };
    const draw = () => {
      context.drawImage(image, 0, 0);
      if (SCENES) for (const card of SCENES[scene]) drawCard(card);
      context.fillStyle = "hsl(" + ((n++ * 37) % 360) + " 60% 40%)";
      context.fillRect(canvas.width - 24, canvas.height - 24, 16, 16);
    };
    draw();
    setInterval(draw, 1000 / 15);
    video.srcObject = canvas.captureStream(15);
  } else {
    video.loop = true;
    video.src = "/clip";
  }
  await video.play();
  while (video.videoWidth === 0 || video.readyState < 2) await new Promise((r) => setTimeout(r, 20));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
window.hs = {
  async begin() {
    await playClip();
    control.attach(video);
    if (CONFIG.makeAt === "play") loadWhen(video, "play", makeFrame);
    const r = video.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  },
  setScene(name) { scene = name; },
  // A picture drawn after the scene changed has been presented: a frame callback, and 300 ms as a floor.
  async afterFrame() {
    const frame = new Promise((r) => { video.requestVideoFrameCallback(() => r()); setTimeout(r, 1000); });
    await Promise.all([frame, sleep(300)]);
  },
  pause() { video.pause(); },
  mark: () => events.length,
  slice: (from) => events.slice(from),
  events: () => events,
  frames: () => madeFrames,
  last(kind) { for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === kind) return events[i]; return null; },
  async waitFor(test, timeoutMs, what) {
    const began = performance.now();
    while (!test()) {
      if (performance.now() - began > timeoutMs) throw new Error("timed out waiting for " + what + "; saw " + JSON.stringify(events.filter((e) => e.kind !== "move").slice(-12)));
      await sleep(10);
    }
    return performance.now();
  },
  async waitReady(timeoutMs) {
    await this.waitFor(() => { const s = this.last("status"); return s && s.state === "ready"; }, timeoutMs, "the frame to be ready");
    return this.last("status");
  },
  async waitStage(intended, timeoutMs) {
    if (intended === "none") return { state: "none", reason: null };
    const want = intended === "ready" ? ["ready"] : ["off"];
    await this.waitFor(() => { const s = this.last("stage"); return s && want.includes(s.state); }, timeoutMs, "the stage to be " + intended);
    return this.last("stage");
  },
  // Wait until the card is shown after the move at index \`from\`, or the limit passes; then until
  // \`observeMs\` after the move (to see a request the card did not need).
  async settle(from, expect, limitMs, observeMs) {
    const move = () => events.slice(from).find((e) => e.kind === "move" && e.trusted && e.over);
    await this.waitFor(move, 2000, "the trusted move");
    const t0 = move().t;
    while (performance.now() - t0 < limitMs) {
      const done = events.slice(from).some((e) => e.kind === "shown" && e.cardId === expect && e.t >= t0);
      if (done && performance.now() - t0 >= observeMs) break;
      await sleep(5);
    }
    return events.slice(from);
  },
};
`;

const FRAME = `<!doctype html><meta charset="utf-8"><script type="module">
import { computeProtocol, DRIVER_TICK_MS, startComputeFrame } from "/lib/compute-session.js";
const config = JSON.parse(new URLSearchParams(location.search).get("c"));
const protocol = computeProtocol("hs");
const parentOrigin = location.ancestorOrigins[0] ?? null;
const tell = (message) => window.parent.postMessage({ hsprobe: 1, ...message }, parentOrigin);
// First, so that the report of an answered request goes out before anything the core posts next.
window.addEventListener("message", (e) => {
  const d = e.data;
  if (e.source === window.parent && d && d.hs === 1 && d.kind === "pointer") tell({ kind: "pointer-in" });
  if (e.source === window.parent && d && d.hs === 1 && (d.kind === "frame" || d.kind === "capture-failed")) tell({ kind: "answered", requestId: d.requestId, how: d.kind });
});
const frame = startComputeFrame({
  win: window,
  framed: window.parent !== window,
  parentOrigin,
  allowedParentOrigin: (origin) => origin === config.parentOrigin,
  protocol,
  createWorker: () => {
    const worker = new Worker("/lib/worker.js", { type: "module" });
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message, ...rest) => {
      if (message && (message.kind === "load" || message.kind === "load-stage")) tell({ kind: "worker-out", what: message.kind });
      return post(message, ...rest);
    };
    return worker;
  },
  loadRequest: { kind: "load", releaseUrl: location.origin + "/release/release.json", wasmPaths: location.origin + "/lib/", ...config.load, ...(config.load.geometricUrl ? { geometricUrl: new URL(config.load.geometricUrl, location.origin + "/release/").href } : {}) },
  now: () => performance.now(),
  onGeometricStatus: (s) => tell({ kind: "stage", state: s.state, reason: s.reason }),
  ...config.frame,
});
setInterval(() => frame && frame.tick(), DRIVER_TICK_MS);
</script>`;

// ---- the local servers and the guard ---------------------------------------------------------

function handler(role) {
  return (request, response) => {
    let path = "/";
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      // keep "/"
    }
    if (request.method !== "GET") return response.writeHead(405).end();
    const text = (type, body) => response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
    if (path === "/favicon.ico") return response.writeHead(204).end();
    if (role === "page" && path === "/") return text(TYPES[".html"], PAGE);
    if (role === "page" && path === "/page.js") return text(TYPES[".js"], currentPageJs);
    if (role === "frame" && path === "/frame.html") return text(TYPES[".html"], FRAME);
    let file = null;
    if (role === "page" && path === "/clip") file = clipFile;
    else if (role === "page" && path.startsWith("/art/") && given.art) file = inside(given.art, path.slice("/art/".length));
    else if (role === "frame" && path.startsWith("/release/")) file = inside(resolve(given.release), path.slice("/release/".length));
    else if (path.startsWith("/lib/")) file = inside(dist, path.slice("/lib/".length));
    if (!file || !existsSync(file) || !statSync(file).isFile()) return response.writeHead(404).end("not found\n");
    response.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(response);
  };
}
let currentPageJs = "";
const pageServer = createServer(handler("page"));
const frameServer = createServer(handler("frame"));
await Promise.all([pageServer, frameServer].map((s) => new Promise((done) => s.listen(0, "127.0.0.1", done))));
const pageOrigin = `http://127.0.0.1:${pageServer.address().port}`;
const frameOrigin = `http://127.0.0.1:${frameServer.address().port}`;
const loopbackViolations = [];
const inRun = (url) => requestAllowed(url, pageOrigin) || requestAllowed(url, frameOrigin);

const basePageJs = pageJs({
  frameOrigin,
  makeAt: "play",
  image: isImage,
  scenes: sceneSpec,
  frame: options.frame ?? {},
  load: { ...(options.load ?? {}), ...(backend === "wasm" ? { providers: ["wasm"] } : {}) },
});
const pageJsFor = (makeAt) => basePageJs.replace('"makeAt":"play"', `"makeAt":"${makeAt}"`);

// ---- the run ---------------------------------------------------------------------------------

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const READY_TIMEOUT_MS = 120_000;
const STAGE_TIMEOUT_MS = 120_000;
const PARK = [10, 885];

const toolkitCommit = (() => {
  try {
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "."], { cwd, encoding: "utf-8" }).trim() !== "";
    return dirty ? `${commit}+uncommitted` : commit;
  } catch {
    return "unknown";
  }
})();

let profileDir = null;
/** Remove the temp profile; Chrome's children may still be writing, so a failure is not an error. */
function removeProfile() {
  if (profileDir === null) return;
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // left for the system's temp cleanup
  }
}
let chromePid = null;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (chromePid !== null) {
      try {
        process.kill(chromePid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    removeProfile();
    process.exit(2);
  });
}
profileDir = mkdtempSync(join(tmpdir(), "hover-speed-"));
const startedAt = new Date().toISOString();
let browser;
try {
  browser = await puppeteer.launch({
  executablePath: chrome,
  headless: !given.headed,
  userDataDir: profileDir,
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
  defaultViewport: { width: 1300, height: 900 },
  args: [backend === "wasm" ? "--disable-gpu" : "--enable-unsafe-webgpu", "--no-first-run", "--autoplay-policy=no-user-gesture-required", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
});
} catch (error) {
  console.error(String(error?.stack ?? error));
  removeProfile();
  process.exit(2);
}
chromePid = browser.process().pid;

/** A fresh browser context (no shared HTTP cache, storage or code cache) with the page open. */
async function openContext(makeAt) {
  const context = await browser.createBrowserContext();
  const tab = await context.newPage();
  tab.on("pageerror", (error) => console.error(`[page] ${error.message}`));
  await tab.setRequestInterception(true);
  tab.on("request", (request) => {
    const url = request.url();
    if (inRun(url)) return request.continue();
    loopbackViolations.push(url);
    return request.abort("blockedbyclient");
  });
  tab.on("requestfailed", (request) => {
    const url = request.url();
    if (!inRun(url) && !loopbackViolations.includes(url)) loopbackViolations.push(url);
  });
  currentPageJs = pageJsFor(makeAt);
  await tab.goto(`${pageOrigin}/`);
  await tab.waitForFunction(() => typeof window.hs === "object");
  const box = await tab.evaluate(() => window.hs.begin());
  const at = (x, y) => [box.x + x * box.width, box.y + y * box.height];
  await tab.mouse.move(...PARK);
  return { context, tab, at, async close() { await context.close().catch(() => {}); } };
}

const contexts = [];
const tallies = [];
const rows = [];
let backendSeen = null;
const warnings = [];

async function stageAndBackend(tab) {
  const status = await tab.evaluate(() => window.hs.last("status"));
  if (status?.backend) backendSeen = status.backend;
  return status?.backend ?? null;
}

/** One hover: the move through the browser's input, then the page's readings, scored. */
async function hover(c, point, extra = {}) {
  if (point.scene !== undefined) {
    await c.tab.evaluate((s) => window.hs.setScene(s), point.scene);
    await c.tab.evaluate(() => window.hs.afterFrame());
  }
  const mark = await c.tab.evaluate(() => window.hs.mark());
  const stage = await c.tab.evaluate(() => window.hs.last("stage"));
  const frameReadyAt = await c.tab.evaluate(() => window.hs.last("status")?.t ?? null);
  await c.tab.mouse.move(...c.at(point.x, point.y));
  await c.tab.evaluate((m, e, l, o) => window.hs.settle(m, e, l, o), mark, point.expect, limitMs, extra.observeMs ?? 0);
  const row = scoreHover({ before: await c.tab.evaluate((m) => window.hs.events().slice(0, m), mark), events: await c.tab.evaluate((m) => window.hs.slice(m), mark), expect: point.expect, limitMs: limitMs, observeMs: extra.observeMs ?? 0 });
  if (row.error) throw new Error(`${extra.scenario}: ${row.error}`);
  const backendName = await stageAndBackend(c.tab);
  await sleep(150);
  // From this hover's mark: a context holds several hovers, and the first event of a kind may be an earlier one's.
  const all = await c.tab.evaluate((m) => window.hs.slice(m), mark);
  const sent = all.find((e) => e.kind === "worker-out" && e.what === "load-stage");
  const firstPointer = all.find((e) => e.kind === "pointer-in");
  const stageReady = all.find((e) => e.kind === "stage" && e.state === "ready");
  return { ...row, ...extra,
    loadStageSentMs: sent ? Math.round((sent.t - row.movedAtMs) * 100) / 100 : null,
    firstPointerInMs: firstPointer ? Math.round((firstPointer.t - row.movedAtMs) * 100) / 100 : null,
    stageReadyMs: stageReady ? Math.round((stageReady.t - row.movedAtMs) * 100) / 100 : null, stage: stage ? { state: stage.state, reason: stage.reason } : { state: "none", reason: null }, backend: backendName, frameAgeMsAtMove: frameReadyAt === null ? null : Math.round((row.movedAtMs + 0) - frameReadyAt) };
}

async function finish(c) {
  tallies.push(tally(await c.tab.evaluate(() => window.hs.events())));
  await c.close();
}

async function runH1() {
  for (let trial = 0; trial < count; trial += 1) {
    const c = await openContext("hover");
    try {
      const point = script.hovers[trial % script.hovers.length];
      const row = await hover(c, point, { scenario: "H1", trial, cold: "new browser context per trial; the frame, its worker and the models are new" });
      const ready = await c.tab.evaluate(() => window.hs.last("status"));
      const made = await c.tab.evaluate(() => window.hs.slice(0).find((e) => e.kind === "frame-made")?.t ?? null);
      rows.push({ ...row, frameMadeToReadyMs: made !== null && ready?.state === "ready" ? Math.round((ready.t - made) * 100) / 100 : null });
    } finally {
      await finish(c);
    }
  }
}

/** A context whose frame was made at play and has been ready, with the stage in its intended state, for at least 2 s. */
async function readyContext() {
  const c = await openContext("play");
  await c.tab.evaluate((ms) => window.hs.waitReady(ms), READY_TIMEOUT_MS);
  const stage = await c.tab.evaluate((s, ms) => window.hs.waitStage(s, ms), stageIntended, STAGE_TIMEOUT_MS);
  if (stage.state !== (stageIntended === "failed" ? "off" : stageIntended) && stageIntended !== "none") throw new Error(`the stage is ${stage.state}, not ${stageIntended}`);
  await sleep(2000);
  return c;
}

async function runH2() {
  for (let trial = 0; trial < count; trial += 1) {
    const c = await readyContext();
    try {
      await hover(c, script.hovers[trial % script.hovers.length], { scenario: "H2", trial, cold: "frame made at play and ready 2 s or more before the hover" }).then((row) => rows.push(row));
    } finally {
      await finish(c);
    }
  }
}

async function runH2P() {
  if (!script.slowPoint) {
    warnings.push("H2P skipped: the script has no slowPoint");
    return;
  }
  if (stageIntended === "none") warnings.push("H2P ran with no stage pinned (stageIntended none): the slow point is not a stage measurement");
  for (let trial = 0; trial < Math.min(5, count); trial += 1) {
    const c = await readyContext();
    try {
      if (script.slowPoint.scene !== undefined) {
        await c.tab.evaluate((s) => window.hs.setScene(s), script.slowPoint.scene);
        await c.tab.evaluate(() => window.hs.afterFrame());
      }
      await c.tab.evaluate(() => window.hs.pause());
      await sleep(300);
      rows.push(await hover(c, { ...script.slowPoint, scene: undefined }, { scenario: "H2P", trial, paused: true, cold: "frame made at play, stage pinned, then the video paused" }));
    } finally {
      await finish(c);
    }
  }
}

/** H6: on a playing video, with the stage ready, the pointer rests on card A and then moves to
 *  card B, which was in the scene during A's looks. Each B hover is a row. */
async function runH6() {
  if (!script.pairs) {
    warnings.push("H6 skipped: the script has no pairs");
    return;
  }
  if (stageIntended !== "ready") warnings.push(`H6 ran with stageIntended ${stageIntended}: it is meant for a ready stage`);
  if ((options.frame ?? {}).geometricScope !== "focus") warnings.push('H6 ran without frame.geometricScope "focus" in --options');
  const c = await readyContext();
  try {
    for (let trial = 0; trial < count; trial += 1) {
      const pair = script.pairs[trial % script.pairs.length];
      if (pair.scene !== undefined) {
        await c.tab.evaluate((sc) => window.hs.setScene(sc), pair.scene);
        await c.tab.evaluate(() => window.hs.afterFrame());
      }
      const aRow = await hover(c, pair.a, { scenario: "H6-A", trial });
      // The rest varies by up to 250 ms (the scheduler's tick) from trial to trial, so that the move to B
      // does not always land on the same phase of the look cadence.
      await sleep(restMs + ((trial * 97) % 250));
      const bRow = await hover(c, pair.b, { scenario: "H6", trial, pair: trial % script.pairs.length, aOutcome: aRow.outcome, aShownMs: aRow.shownMs, aMovedAtMs: aRow.movedAtMs, observeMs: DEFAULT_OBSERVE_MS, cold: "playing video, stage pinned, pointer rested on card A, then moved to card B" });
      rows.push({ ...bRow, restOnAMs: Math.round((bRow.movedAtMs - aRow.movedAtMs) * 100) / 100 });
    }
  } finally {
    await finish(c);
  }
}

async function runH5() {
  const c = loadMode === "play" ? await readyContext() : await (async () => {
    const warm = await openContext("hover");
    await warm.tab.mouse.move(...warm.at(script.hovers[0].x, script.hovers[0].y));
    await warm.tab.evaluate((ms) => window.hs.waitReady(ms), READY_TIMEOUT_MS);
    const stage = await warm.tab.evaluate((s, ms) => window.hs.waitStage(s, ms), stageIntended, STAGE_TIMEOUT_MS);
    if (stageIntended !== "none" && stage.state !== (stageIntended === "failed" ? "off" : stageIntended)) throw new Error(`the stage is ${stage.state}, not ${stageIntended}`);
    await sleep(2000);
    return warm;
  })();
  try {
    let n = 0;
    let previousScene = null;
    for (const gapMs of gaps) {
      // One unmeasured hover first, so that a look has been answered before the pointer leaves.
      const prime = script.hovers[n++ % script.hovers.length];
      if (prime.scene !== undefined) await c.tab.evaluate((s) => window.hs.setScene(s), prime.scene);
      previousScene = prime.scene ?? null;
      const primeMark = await c.tab.evaluate(() => window.hs.mark());
      await c.tab.mouse.move(...c.at(prime.x, prime.y));
      await c.tab.evaluate((m, e) => window.hs.settle(m, e, 5000, 0), primeMark, prime.expect);
      await sleep(1500);
      for (let trial = 0; trial < h5Count; trial += 1) {
        const point = script.hovers[n++ % script.hovers.length];
        const leaveMark = await c.tab.evaluate(() => window.hs.mark());
        await c.tab.mouse.move(...PARK);
        await sleep(gapMs);
        if (point.scene !== undefined) {
          await c.tab.evaluate((s) => window.hs.setScene(s), point.scene);
          await c.tab.evaluate(() => window.hs.afterFrame());
        }
        const row = await hover(c, { ...point, scene: undefined }, { scenario: "H5", trial, gapMs, observeMs: DEFAULT_OBSERVE_MS, sceneChanged: point.scene === undefined ? undefined : point.scene !== previousScene, cold: "frame ready; pointer off the picture for the gap" });
        const slice = await c.tab.evaluate((m) => window.hs.slice(m), leaveMark);
        const move = slice.findIndex((e) => e.kind === "move" && e.over === true);
        rows.push({ ...row, requestsOffPicture: requestsOffPicture(move < 0 ? slice : slice.slice(0, move)) });
        previousScene = point.scene ?? previousScene;
      }
    }
  } finally {
    await finish(c);
  }
}

let code = 0;
try {
  const runners = { H1: runH1, H2: runH2, H2P: runH2P, H5: runH5, H6: runH6 };
  for (const name of scenarios) await runners[name]();
  const chromeVersion = await browser.version();
  const profile = {
    machine: `${platform()} ${arch()}, ${cpus()[0]?.model ?? "unknown cpu"} x ${cpus().length}`,
    chrome: chromeVersion,
    backend: backendSeen,
    backendForced: backend === "wasm" ? "wasm" : null,
    smoke,
    stageIntended,
    load: loadMode,
    cold: "H1 uses a new browser context per hover: no shared HTTP cache, storage or code cache. The server sends no-store. The harness is loopback and bundled: it does not model a remote release download.",
    toolkitCommit,
    startedAt,
    release: resolve(given.release).split("/").slice(-2).join("/"),
    clip: resolve(given.clip).split("/").pop(),
    scenarios,
    counts: { count, h5Count, gaps },
    limitMs,
    expectEntryLook: entryLook,
  };
  const report = buildReport({ profile, options, rows, tallies, loopbackViolations: [...new Set(loopbackViolations)], entryLook, entryMs, limitMs, notes: warnings });
  console.log(JSON.stringify(report, null, 2));
  if (given.out) writeFileSync(given.out, JSON.stringify(report, null, 2) + "\n");
  code = report.passed ? 0 : 1;
} catch (error) {
  console.error(String(error?.stack ?? error));
  code = 2;
} finally {
  await browser.close().catch(() => {});
  try {
    process.kill(chromePid, 0);
    process.kill(chromePid, "SIGKILL");
  } catch {
    // already gone
  }
  removeProfile();
  pageServer.close();
  frameServer.close();
}
process.exit(code);
