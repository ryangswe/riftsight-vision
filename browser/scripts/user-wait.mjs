// SPDX-License-Identifier: Apache-2.0
// How long a viewer waits for the right name: the built runtime in a headless Chrome plays a
// clip, the pointer is rested at scripted places, and for each rest the time from the pointer
// coming to rest to `session.atPointer()` returning the expected card id is recorded.
//
//   npm run user-wait -- --release RELEASE_FOLDER --clip FILE --rests FILE [--throttle 4]
//                        [--scenes FILE --art FOLDER] [--cold | --load-on-hover] [--limit 10000]
//                        [--ready-timeout 120000] [--out REPORT.json] [--chrome PATH] [--headed]
//
// The numbers are a report, not a pass or fail. README.md, "Measuring the wait", says how to
// give it a clip and a rest script, and what the slowdown is.
//
// The slowdown is emulated, in two parts (README.md says the same):
//   - the page is slowed by Chrome (`Emulation.setCPUThrottlingRate`), which reaches the main
//     thread only, never a worker, and has no getter, so the rate is read back by timing a fixed
//     loop in the page with and without it;
//   - the analysis worker is loaded through a wrapper this script serves (workerWrapper below).
//     After each frame the real worker analyzes, the wrapper reports `workerMs` as rate x c x
//     the raw analysis time, which is what the session shows as `lastWorkerMs`, and holds the
//     reply for the difference. `c` corrects a side effect of the page throttle: with the page
//     throttled, the worker's own analysis runs faster (measured: the same frames take about
//     16 ms against about 29 ms). The run first measures the raw time with the page unthrottled
//     (B0), then throttled (B1), and c = B0 / B1; per-frame differences still show. `--cold`
//     skips this: c is 1. Nothing under src/ changes. The wrapper also measures the factor it
//     really applied. With --load-on-hover the wrapper also holds the worker's release-loaded
//     reply by (rate x c - 1) x the raw load time it measured, the rule it uses for an analysis.
//
// Chrome is driven with the package puppeteer-core, which is not a dependency of this folder:
//   npm install --no-save --prefix "$PUPPETEER_CORE_DIR" puppeteer-core
// (found there when PUPPETEER_CORE_DIR is set, so that browser/node_modules, which the linter
// reads, stays without it; otherwise `npm install --no-save puppeteer-core@25.17.0` in this folder).
// Name a Chrome with --chrome PATH or CHROME=PATH (Chrome for Testing works). The page is served
// from this machine (127.0.0.1); any other request fails the run, with its URL. The clip is an
// image or a video file; an image is drawn on a canvas and played as a 15 frames a second
// stream with a small moving mark in its bottom right corner, so nothing is committed as video.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inside, TYPES } from "./demo-paths.mjs";
import { analysisShare, architectureNote, chooseCorrection, correctionProblem, buildReport, byteRange, settleAnalyses, createRequestGuard, cycleSummary, DEFAULT_LIMIT_MS, DEFAULT_READY_TIMEOUT_MS, describeRest, emulatedTime, loadOnHoverProblem, loadRest, loadSummary, measuredFactor, median, restScriptProblem, runMode, scenesProblem, scenesWarnings, scoreRest } from "./user-wait-core.mjs";

// Analyses at the emulated speed before the rests begin, in a run with pacing on or off alike.
const PACER_SETTLE_ANALYSES = 5;

const USAGE = `Usage: npm run user-wait -- --release FOLDER --clip FILE --rests FILE [--throttle N]
                            [--limit MS] [--out FILE] [--chrome PATH] [--headed] [--measured-pacing [--share S]]

  --release FOLDER  a release folder (a release document and the files it pins)
  --clip FILE       an image or a video file to play
  --rests FILE      the rest script (README.md, "Measuring the wait")
  --throttle N      the slowdown to emulate, 1 or more (default 4)
  --limit MS        how long a rest waits for the right name (default ${DEFAULT_LIMIT_MS})
  --ready-timeout MS  how long to wait for the session to be ready (default ${DEFAULT_READY_TIMEOUT_MS}); the
                    time it took is in the profile (readyMs) and in no rest's wait
  --scenes FILE     scenes drawn over the clip (an image): README.md, "Measuring the wait". Needs --art
  --art FOLDER      the card images the scenes draw, named CARD.png; served at /art/
  --measured-pacing  run the session with the measuredPacing option on (default off). Warm runs, paced
                    or not, first analyze ${PACER_SETTLE_ANALYSES} frames at the emulated speed, so a paced run's rests begin after its pacer has
                    measured slowed analyses; the report says so (analysis.pacerSettle)
  --share S         with --measured-pacing: the share of time analysis may take, above 0 and at most 1 (default 0.25)
  --correction C    use this correction c (a number above 0) and skip measuring it. For an on/off comparison
                    of --measured-pacing, measure c in the off run (analysis.correction) and pass it to the
                    on run, so both emulate the same computer. Not with --cold
  --cold            no warm-up and no correction of the throttle's effect on the worker
  --load-on-hover   a cold run that does not open the session before the rests: at rest 1 the pointer
                    comes to rest, the clock starts, and the session is created then, so rest 1's wait
                    includes the load (release fetch, runtime start-up, model compile, first analysis).
                    The worker's load reply is held like an analysis, so the load is slowed too (an
                    estimate: README.md). Not with --correction or --measured-pacing
  --out FILE        also write the report here
  --chrome PATH     the Chrome to drive (or CHROME in the environment)
  --headed          show the window
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const flags = new Set(["--headed", "--cold", "--measured-pacing", "--load-on-hover"]);
const known = new Set(["--release", "--clip", "--rests", "--throttle", "--limit", "--ready-timeout", "--scenes", "--art", "--out", "--chrome", "--share", "--correction"]);
const given = {};
for (let at = 0; at < args.length; at += 1) {
  const name = args[at];
  if (flags.has(name)) given[name.slice(2)] = true;
  else if (known.has(name) && args[at + 1] !== undefined) given[name.slice(2)] = args[++at];
  else usageError(known.has(name) ? `${name} needs a value` : `unknown option ${name}`);
}
function usageError(problem) {
  console.error(`${problem}\n\n${USAGE}`);
  process.exit(2);
}
for (const name of ["release", "clip", "rests"]) if (given[name] === undefined) usageError(`--${name} is required`);
const rate = Number(given.throttle ?? 4);
const pacing = { on: given["measured-pacing"] === true, share: given["measured-pacing"] === true ? Number(given.share ?? 0.25) : null };
if (given.share !== undefined && !pacing.on) usageError("--share needs --measured-pacing");
if (pacing.on && !(pacing.share > 0 && pacing.share <= 1)) usageError(`--share ${given.share}: not a number above 0 and at most 1`);
const givenCorrection = given.correction === undefined ? undefined : Number(given.correction);
if (givenCorrection !== undefined) {
  const problem = correctionProblem(givenCorrection);
  if (problem) usageError(`--correction ${given.correction}: ${problem}`);
  if (given.cold) usageError("--correction cannot be used with --cold");
}
const loadOnHover = given["load-on-hover"] === true;
const loadProblem = loadOnHoverProblem({ loadOnHover, correction: givenCorrection, measuredPacing: pacing.on });
if (loadProblem) usageError(loadProblem);
const limitMs = Number(given.limit ?? DEFAULT_LIMIT_MS);
const readyTimeoutMs = Number(given["ready-timeout"] ?? DEFAULT_READY_TIMEOUT_MS);
if (!(readyTimeoutMs > 0)) usageError(`--ready-timeout ${given["ready-timeout"]}: not a number of ms`);
if (!(rate >= 1)) usageError(`--throttle ${given.throttle}: not a number of 1 or more`);
if (!(limitMs > 0)) usageError(`--limit ${given.limit}: not a number of ms`);
if (!existsSync(join(given.release, "release.json"))) usageError(`--release ${given.release}: no release.json in it`);
for (const name of ["clip", "rests"]) if (!existsSync(given[name]) || !statSync(given[name]).isFile()) usageError(`--${name} ${given[name]}: no such file`);
const script = JSON.parse(readFileSync(given.rests, "utf-8"));
let sceneSpec = null;
if ((given.scenes === undefined) !== (given.art === undefined)) usageError("--scenes and --art go together");
if (given.scenes !== undefined) {
  if (!existsSync(given.scenes) || !existsSync(given.art) || !statSync(given.art).isDirectory()) usageError("--scenes: no such file, or --art: no such folder");
  sceneSpec = JSON.parse(readFileSync(given.scenes, "utf-8"));
}
const problem = restScriptProblem(script);
if (problem) usageError(`--rests ${given.rests}: ${problem}`);
if (sceneSpec === null && script.rests.some((rest) => rest.scene !== undefined)) usageError("a rest names a scene: give --scenes and --art");
if (sceneSpec !== null) {
  const sceneProblem = scenesProblem(sceneSpec, script.rests);
  if (sceneProblem) usageError(`--scenes ${given.scenes}: ${sceneProblem}`);
}
const warnings = sceneSpec === null ? [] : scenesWarnings(sceneSpec, script.rests);
for (const warning of warnings) console.error(`warning: ${warning}`);
const chrome = given.chrome ?? process.env.CHROME;
if (!chrome) usageError("Name a Chrome with --chrome PATH or CHROME=PATH (Chrome for Testing works).");
/** puppeteer-core from PUPPETEER_CORE_DIR when that is set, otherwise from this folder. */
async function loadPuppeteer() {
  const folder = process.env.PUPPETEER_CORE_DIR;
  if (folder) {
    try {
      return createRequire(join(resolve(folder), "x.js"))("puppeteer-core");
    } catch {
      // fall through to the normal import
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
  console.error('Needs the package puppeteer-core: npm install --no-save puppeteer-core@25.17.0 (or, with PUPPETEER_CORE_DIR set, npm install --no-save --prefix "$PUPPETEER_CORE_DIR" puppeteer-core@25.17.0)');
  process.exit(2);
}
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
if (!existsSync(join(dist, "cardvision.js"))) {
  console.error("dist/ is missing: run `npm run build` first (`npm run user-wait` does)");
  process.exit(2);
}
const clipFile = resolve(given.clip);
const isImage = /^image\//.test(TYPES[extname(clipFile).toLowerCase()] ?? "");
if (sceneSpec !== null && !isImage) usageError("--scenes draws over an image clip, not a video");
if (isImage && script.rests.some((rest) => rest.atSec !== undefined)) usageError("atSec seeks a video clip; this clip is an image");

// ---- what the page runs ------------------------------------------------------------------

/** The worker the session is given: the built worker, behind the setup that slows it. */
const workerWrapper = (factor, slowLoad) => `import "/slow-setup.js?rate=${factor}&load=${slowLoad ? 1 : 0}";\nimport "/lib/worker.js";\n`;

/**
 * Runs before the built worker, in the same thread. It sees each frame request come in and
 * reports for the frame `workerMs` = rate x c x the raw analysis time (which the session shows
 * as `lastWorkerMs`), holding the reply for the difference. The page sets `rate` and `c` on a
 * second BroadcastChannel (c corrects the page throttle's effect on the worker's speed; see the
 * top of this file). Only frame results change, and only that one number in them. It tells the
 * page what it did on the first channel.
 */
const workerSetup = (factor, slowLoad) => `
let rate = ${factor};
let c = 1;
const tell = new BroadcastChannel("user-wait");
new BroadcastChannel("user-wait-control").onmessage = (event) => { rate = event.data.rate; c = event.data.c; };
const post = self.postMessage.bind(self);
const arrivals = [];
let loadArrived = null;
self.addEventListener("message", (event) => {
  if (event.data && event.data.kind === "frame") arrivals.push(performance.now());
  if (event.data && event.data.kind === "load" && loadArrived === null) loadArrived = performance.now();
});
self.postMessage = (message, ...rest) => {
  if (${slowLoad} && message && message.kind === "release-status" && message.ok && loadArrived !== null) {
    // The load: the same rule as an analysis, over the time from the load request to this reply.
    const arrived = loadArrived;
    loadArrived = null;
    const rawMs = performance.now() - arrived;
    const reportedMs = rate * c * rawMs;
    setTimeout(() => {
      tell.postMessage({ kind: "load", rawMs: +rawMs.toFixed(2), reportedMs: +reportedMs.toFixed(2), heldMs: performance.now() - arrived });
      post(message, ...rest);
    }, Math.max(0, reportedMs - rawMs));
    return;
  }
  if (!message || message.kind !== "frame-result") return post(message, ...rest);
  const arrived = arrivals.shift() ?? performance.now();
  const rawMs = message.workerMs;
  const reportedMs = rate * c * rawMs;
  const wait = Math.max(0, reportedMs - rawMs);
  setTimeout(() => {
    tell.postMessage({ rawMs, reportedMs: +reportedMs.toFixed(2), heldMs: performance.now() - arrived });
    post({ ...message, workerMs: +reportedMs.toFixed(2) }, ...rest);
  }, wait);
};
`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>user wait</title>
<style>body{margin:0;background:#222}video{display:block;width:1280px;max-height:768px;object-fit:contain}</style>
<video id="v" muted playsinline></video><script type="module" src="/page.js"></script>`;

const PAGE_JS = `
import { createSession } from "/lib/cardvision.js";
const video = document.getElementById("v");
const IS_IMAGE = ${JSON.stringify(isImage)};
const LOAD_ON_HOVER = ${JSON.stringify(loadOnHover)};
const MEASURED_PACING = ${JSON.stringify(pacing.on ? { share: pacing.share } : null)};
const SCENES = ${JSON.stringify(sceneSpec === null ? null : sceneSpec.scenes)};
let scene = ${JSON.stringify(sceneSpec === null ? null : (sceneSpec.start ?? Object.keys(sceneSpec.scenes)[0]))};
let session = null;
let current = null;
const cycles = [];
const worker = [];
const loads = [];
let lastFrames = -1;
let sessionRate = 1;
let createdAt = null;
new BroadcastChannel("user-wait").onmessage = (event) => (event.data.kind === "load" ? loads : worker).push(event.data);

// A fixed loop, timed: the minimum of several runs, so a busy moment does not count.
function calibrate() {
  const run = () => {
    const start = performance.now();
    let x = 1;
    for (let i = 0; i < 5e6; i++) x = (x * 1103515245 + 12345) | 0;
    return performance.now() - start + (x === 0.5 ? 1 : 0);
  };
  for (let k = 0; k < 3; k++) run();
  let best = Infinity;
  for (let k = 0; k < 7; k++) best = Math.min(best, run());
  return best;
}

async function playClip() {
  if (IS_IMAGE) {
    const image = new Image();
    image.src = "/clip";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    let n = 0;
    const art = {};
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
      // A quarter turn counter-clockwise per turn, the card's top-left corner at x, y once turned.
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

/** Create the session over the playing clip, as a product does. */
function create() {
  createdAt = performance.now();
  session = createSession(video, {
    releaseUrl: location.origin + "/release/release.json",
    workerUrl: "/slow-worker.js?rate=" + sessionRate + "&load=" + (LOAD_ON_HOVER ? 1 : 0),
    wasmPaths: location.origin + "/lib/",
    providers: ["wasm"],
    mode: "pointer",
    ...(MEASURED_PACING ? { measuredPacing: MEASURED_PACING } : {}),
  });
  setInterval(() => {
    const s = session.status();
    if (s.frames !== lastFrames && s.lastWorkerMs !== null) {
      lastFrames = s.frames;
      cycles.push({ workerMs: s.lastWorkerMs, roundTripMs: s.lastRoundTripMs });
    }
  }, 20);
}

/** Wait until the session is ready, and say how long it took from its creation. */
async function ready(readyTimeoutMs) {
  for (;;) {
    const s = session.status();
    if (s.state === "ready") return { backend: s.backend, release: s.release?.id ?? null, readyMs: Math.round(performance.now() - createdAt) };
    if (performance.now() - createdAt > readyTimeoutMs) throw new Error("session not ready after " + readyTimeoutMs + " ms (state " + s.state + ")");
    if (s.state === "failed" || s.state === "stopped") throw new Error("session " + s.state + ": " + s.error);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function open(rate, readyTimeoutMs) {
  sessionRate = rate;
  await playClip();
  create();
  return ready(readyTimeoutMs);
}

// One rest: armed before the pointer moves; the first pointer move after that is where the
// pointer comes to rest, a second one is the pointer leaving.
function arm(expect, limitMs) {
  return new Promise((resolve) => {
    current = { expect, limitMs, start: null, movedAt: null, readings: [], last: undefined, createdAt: null, readyAt: null, resolve };
  });
}
function finish() {
  const rest = current;
  current = null;
  rest.resolve({ readings: rest.readings, movedAtMs: rest.movedAt, framesStart: rest.framesStart, framesEnd: session ? session.status().frames : 0, createdAtMs: rest.createdAt, readyAtMs: rest.readyAt });
}
function poll() {
  const rest = current;
  if (!rest) return;
  const t = performance.now() - rest.start;
  const cardId = session ? session.atPointer()?.cardId ?? null : null;
  if (session && rest.createdAt !== null && rest.readyAt === null && session.status().state === "ready") rest.readyAt = t;
  if (cardId !== rest.last) {
    rest.readings.push({ t, cardId });
    rest.last = cardId;
  }
  if (cardId === rest.expect || t >= rest.limitMs) return finish();
  setTimeout(poll, 4);
}
document.addEventListener("pointermove", (event) => {
  // The session's own pointer replay below is not the pointer leaving.
  if (!current || !event.isTrusted) return;
  if (current.start === null) {
    current.start = event.timeStamp;
    if (session === null) {
      // The first hover of a load-on-hover run: the clock has started, now the session is made, and
      // it is told where the pointer is, as the next move of a real pointer would.
      create();
      current.createdAt = createdAt - event.timeStamp;
      current.framesStart = 0;
      video.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: event.clientX, clientY: event.clientY, pointerType: "mouse" }));
    } else {
      current.framesStart = session.status().frames;
    }
    poll();
  } else {
    current.movedAt = event.timeStamp - current.start;
    finish();
  }
});

window.harness = {
  calibrate,
  open,
  play: async (rate) => { sessionRate = rate; await playClip(); },
  ready,
  architecture: async () => {
    const high = (await navigator.userAgentData?.getHighEntropyValues(["architecture", "bitness", "platform"])) ?? {};
    return { architecture: high.architecture ?? null, bitness: high.bitness ?? null, platform: high.platform ?? null };
  },
  box: () => { const r = video.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; },
  scene: (name) => { scene = name; },
  seek: async (sec) => { video.currentTime = sec; await new Promise((r) => video.addEventListener("seeked", r, { once: true })); },
  control: (rate, c) => new BroadcastChannel("user-wait-control").postMessage({ rate, c }),
  begin: (expect, limitMs) => { window.__rest = arm(expect, limitMs); },
  result: () => window.__rest,
  status: () => session.status(),
  cycles: () => cycles,
  reset: () => { cycles.length = 0; worker.length = 0; },
  worker: () => worker,
  loads: () => loads,
};
`;

// ---- the local server and the guard ---------------------------------------------------------

const server = createServer((request, response) => {
  let path;
  try {
    path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    path = "/";
  }
  const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
  const factor = Number(query.get("rate") ?? 1);
  const text = (type, body) => response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
  if (request.method !== "GET") return response.writeHead(405).end();
  if (path === "/favicon.ico") return response.writeHead(204).end();
  if (path === "/") return text(TYPES[".html"], PAGE);
  if (path === "/page.js") return text(TYPES[".js"], PAGE_JS);
  const slowLoad = query.get("load") === "1";
  if (path === "/slow-worker.js") return text(TYPES[".js"], workerWrapper(factor, slowLoad));
  if (path === "/slow-setup.js") return text(TYPES[".js"], workerSetup(factor, slowLoad));
  let file = null;
  if (path === "/clip") file = clipFile;
  else if (path.startsWith("/release/")) file = inside(given.release, path.slice("/release/".length));
  else if (path.startsWith("/art/") && given.art) file = inside(given.art, path.slice("/art/".length));
  else if (path.startsWith("/lib/")) file = inside(dist, path.slice("/lib/".length));
  if (!file || !existsSync(file) || !statSync(file).isFile()) return response.writeHead(404).end("not found\n");
  const size = statSync(file).size;
  const headers = { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "accept-ranges": "bytes", "cache-control": "no-store" };
  const range = byteRange(request.headers.range, size);
  if (range === "unsatisfiable") return response.writeHead(416, { ...headers, "content-range": `bytes */${size}` }).end();
  if (range) {
    response.writeHead(206, { ...headers, "content-length": range.end - range.start + 1, "content-range": `bytes ${range.start}-${range.end}/${size}` });
    return createReadStream(file, { start: range.start, end: range.end }).pipe(response);
  }
  response.writeHead(200, { ...headers, "content-length": size });
  createReadStream(file).pipe(response);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const guard = createRequestGuard(origin);

/** The longest a warm-up may take, in ms. */
const WARM_UP_MAX_MS = 180_000;

// ---- the run ---------------------------------------------------------------------------------

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

/** The architectures in the Chrome binary, from `file` (several for a universal one). */
function binaryArchitectures(path) {
  try {
    return [...new Set([...execFileSync("file", [path], { encoding: "utf-8" }).matchAll(/\b(x86_64|arm64)\b/g)].map((m) => m[1]))];
  } catch {
    return [];
  }
}

const profileDir = mkdtempSync(join(tmpdir(), "user-wait-chrome-"));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: !given.headed,
  userDataDir: profileDir,
  defaultViewport: { width: 1300, height: 900 },
  args: ["--disable-gpu", "--no-first-run", "--autoplay-policy=no-user-gesture-required", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
});
let code = 0;
try {
  const tab = await browser.newPage();
  tab.on("console", (message) => { if (message.type() === "error") console.error(`[page] ${message.text()}`); });
  tab.on("pageerror", (error) => console.error(`[page] ${error.message}`));
  await tab.setRequestInterception(true);
  tab.on("request", (request) => guard.handle(request));
  await tab.goto(`${origin}/`);
  await tab.waitForFunction(() => typeof window.harness === "object");

  // The page's slowdown, read back: the same loop without the throttle and with it.
  const cdp = await tab.createCDPSession();
  const calibrations = async () => {
    const times = [];
    for (let k = 0; k < 3; k++) times.push(await tab.evaluate(() => window.harness.calibrate()));
    return times;
  };
  const warmUpCycles = given.cold || loadOnHover ? 0 : (script.warmUpCycles ?? 3);
  const cold = warmUpCycles === 0;
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const unslowed = await calibrations();
  let slowed = null;
  if (cold) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    slowed = await calibrations();
  }

  // A cold run is throttled from the start; a warm one runs unthrottled first (the worker's
  // wrapper at rate 1, c 1) and is throttled once the baseline is known. A load-on-hover run only
  // plays the clip: its session is made at rest 1.
  let opened = { backend: null, release: null, readyMs: null };
  if (loadOnHover) await tab.evaluate((r) => window.harness.play(r), rate);
  else opened = await tab.evaluate((r, ms) => window.harness.open(r, ms), cold ? rate : 1, readyTimeoutMs);
  const box = await tab.evaluate(() => window.harness.box());
  const at = (x, y) => [box.x + x * box.width, box.y + y * box.height];
  const park = [10, 885];
  await tab.mouse.move(...park);

  // Small pointer moves over the first rest until `count` more frames have been analyzed.
  const jitter = async (count) => {
    const began = Date.now();
    await tab.evaluate(() => window.harness.reset());
    for (let n = 0; (await tab.evaluate(() => window.harness.worker().length)) < count; n += 1) {
      if (Date.now() - began > WARM_UP_MAX_MS) throw new Error(`warm-up: ${count} analyses did not finish in ${WARM_UP_MAX_MS / 1000} s`);
      await tab.mouse.move(...at(script.rests[0].x + (n % 2 ? 0.01 : -0.01), script.rests[0].y));
      await new Promise((done) => setTimeout(done, 250));
    }
    await tab.mouse.move(...park);
    return tab.evaluate(() => window.harness.worker().map((h) => h.rawMs));
  };
  let baselineRawMs = null;
  let throttledRawMs = null;
  let c = 1;
  if (!cold && givenCorrection === undefined && pacing.on) {
    const warning = "the correction was measured with pacing on, which spaces analyses and can change it; for an on/off comparison pass --correction from the off run";
    warnings.push(warning);
    console.error(`warning: ${warning}`);
  }
  if (!cold) {
    // Unthrottled: the first analysis (the models' first run) is dropped from the baseline.
    baselineRawMs = median((await jitter(warmUpCycles + 1)).slice(1));
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    slowed = await calibrations();
    if (givenCorrection !== undefined) {
      c = chooseCorrection(givenCorrection, null, null).c;
    } else if (rate > 1) {
      throttledRawMs = median(await jitter(Math.max(3, warmUpCycles)));
      c = chooseCorrection(undefined, baselineRawMs, throttledRawMs).c;
    } else {
      throttledRawMs = baselineRawMs;
    }
    await tab.evaluate((r, k) => window.harness.control(r, k), rate, c);
    await new Promise((done) => setTimeout(done, 1500));
  }
  // Warm runs, paced or not: analyses at the emulated speed before the rests begin, so a paced
  // run's pacer has measured slowed analyses (the warm-up ones were not slowed). A cold run has
  // none: its first rest meets the models' first analysis.
  const settle = settleAnalyses(cold, PACER_SETTLE_ANALYSES);
  if (settle > 0) await jitter(settle);
  await tab.evaluate(() => window.harness.reset());
  const runBegan = Date.now();

  const lines = [];
  for (const [index, rest] of script.rests.entries()) {
    await new Promise((done) => setTimeout(done, rest.pauseMs ?? 1000));
    const limit = rest.limitMs ?? limitMs;
    if (rest.scene !== undefined) await tab.evaluate((name) => window.harness.scene(name), rest.scene);
    if (rest.atSec !== undefined) await tab.evaluate((sec) => window.harness.seek(sec), rest.atSec);
    await tab.evaluate((expect, ms) => window.harness.begin(expect, ms), rest.expect, limit);
    await tab.mouse.move(...at(rest.x, rest.y));
    let left = null;
    if (rest.leaveAfterMs !== undefined) left = setTimeout(() => void tab.mouse.move(...park).catch(() => {}), rest.leaveAfterMs);
    const measured = await tab.evaluate(() => window.harness.result());
    if (left !== null) clearTimeout(left);
    const scored = scoreRest({ expect: rest.expect, readings: measured.readings, movedAtMs: measured.movedAtMs, limitMs: limit });
    const described = describeRest(scored, { scene: rest.scene ?? null, framesStart: measured.framesStart, framesEnd: measured.framesEnd, readings: measured.readings });
    lines.push({ index: index + 1, x: rest.x, y: rest.y, ...(loadOnHover && index === 0 ? loadRest(described, { createdAtMs: measured.createdAtMs, readyAtMs: measured.readyAtMs }) : described) });
    // Later rests meet a session that is ready, as in a cold run.
    if (loadOnHover && index === 0) opened = await tab.evaluate((ms) => window.harness.ready(ms), readyTimeoutMs);
  }

  const wallMs = Date.now() - runBegan;
  const cycles = await tab.evaluate(() => window.harness.cycles());
  const held = await tab.evaluate(() => window.harness.worker());
  const loadMessages = await tab.evaluate(() => window.harness.loads());
  const raw = held.map((h) => h.rawMs);
  const real = held.map((h) => h.heldMs);
  const report = buildReport({
    profile: {
      slowdown: {
        kind: "emulated",
        asked: rate,
        page: { how: "Chrome CPU throttle on the page's main thread", measured: measuredFactor(unslowed, slowed), calibrationMs: { unslowed, slowed } },
        worker: {
          how: "a wrapper reports workerMs as rate x c x the raw analysis time and holds each frame reply for the difference; c corrects the page throttle's effect on the worker (analysis.correction)",
          // The time the wrapper really took per frame, over c x the raw time: about the rate asked.
          measured: raw.length === 0 ? null : measuredFactor([raw.reduce((a, b) => a + b, 0) * c], [real.reduce((a, b) => a + b, 0)]),
          frames: held.length,
          ...(loadOnHover
            ? {
                load: {
                  how: "the wrapper holds the worker's release-loaded reply by (rate x c - 1) x the raw load time it measured, the rule it uses for an analysis (c is 1: a cold run)",
                  ...loadSummary(loadMessages),
                  note: "an estimate: a slower computer may differ; the network is not slowed; the release files come from the local server, so this is a cached-download case",
                },
              }
            : {}),
        },
      },
      mode: runMode({ cold, loadOnHover }),
      loadOnHover,
      measuredPacing: pacing,
      backendAsked: "wasm",
      backend: opened.backend,
      chrome: {
        version: await browser.version(),
        ...architectureNote({ machine: process.arch, binary: binaryArchitectures(chrome), page: await tab.evaluate(() => window.harness.architecture()) }),
      },
      warmUpCycles,
      correctionMeasured: !cold && givenCorrection === undefined,
      warnings,
      // Seconds-scale load inside rest 1 in a load-on-hover run, before the rests otherwise.
      readyMs: loadOnHover ? (lines[0]?.readyMs ?? null) : opened.readyMs,
      readyMsCounted: loadOnHover ? "inside rest 1's wait" : "in no rest's wait",
      readyTimeoutMs,
      toolkitCommit,
      release: opened.release,
      clip: basename(clipFile),
      rests: basename(given.rests),
      scenes: given.scenes === undefined ? null : basename(given.scenes),
      limitMs,
    },
    lines,
    analysis: {
      ...cycleSummary(cycles),
      ...analysisShare(held.map((h) => h.reportedMs), wallMs),
      pacerSettle: { analyses: settle, note: cold ? "none: a cold run's first rest meets the models' first analysis" : "before the rests begin, in warm runs with pacing on and off alike" },
      medianRawMs: median(raw),
      baselineRawMs,
      throttledRawMs,
      correction: c,
      correctionSource: givenCorrection !== undefined ? "given" : "measured",
      correctionMeasured: !cold && givenCorrection === undefined,
      warmUpCycles,
      note: cold ? "cold run: no warm-up, and the page throttle's effect on the worker was not measured (correction 1)" : givenCorrection !== undefined ? "the correction was given (--correction); the throttled raw time was not measured" : "baseline and throttled raw analysis times measured after the warm-up",
    },
  });
  const json = JSON.stringify(report, null, 2);
  if (given.out) writeFileSync(given.out, `${json}\n`);
  console.log(json);
  if (guard.violations.length > 0) {
    console.error(`FAILED: the page requested outside the local server:\n${guard.violations.map((url) => `  ${url}`).join("\n")}`);
    code = 1;
  }
} catch (error) {
  console.error(error);
  if (guard.violations.length > 0) console.error(`The page requested outside the local server:\n${guard.violations.map((url) => `  ${url}`).join("\n")}`);
  code = 1;
} finally {
  await browser.close();
  server.close();
  rmSync(profileDir, { recursive: true, force: true });
}
process.exit(code);
