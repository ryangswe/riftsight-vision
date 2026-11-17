// SPDX-License-Identifier: Apache-2.0
// The hover browser test: a product's extension, loaded unpacked in headless Chrome for Testing,
// on a local page that plays a clip rendered at run time from card pictures. It asserts the
// hover behaviors listed in clauses.mjs and fails (exit 1) when one breaks. It is not part of
// `npm test`; a product's CI runs it in its own job.
//
// The shared part is here. What is specific to one product (its names, its cards, its settings
// file, the places of the cards in the clip, its expected failures) is a module given with
// --product (see example/product.mjs for the fields).
//
//   <build the extension twice: once as it ships, once with a short idle unload>
//   npm install --no-save --prefix <dir> puppeteer-core     (or set PUPPETEER_CORE_DIR to <dir>)
//   node hover-browser.mjs --product <product module> --chrome <Chrome for Testing>
//        --release <release folder> --art <folder for the card pictures named in the product module,
//        outside the product's repository> [--fetch-art] [--dist <build>] [--dist-idle <build>]
//        [--out <folder for the report and logs>] [--only <check id,...>]
//
// ffmpeg (with libvpx) and openssl must be on the PATH.
//
// What runs where. The page is http://127.0.0.1:<port>/ (serve.mjs) with a VP8 clip rendered by
// ffmpeg from the pictures in --art (the product module says where each card goes). The settings
// host is a local HTTPS stand-in with a throwaway certificate that Chrome trusts by its key's
// hash. Chrome resolves the settings host to it and every other host to nothing
// (--host-resolver-rules), and writes a NetLog of every request any of its processes made: the
// page, the extension's frames, its workers and its background. A request that leaves 127.0.0.1
// fails the test. One exception: Chrome's own background traffic, which starts in the browser with
// no origin as its initiator, to Google's hosts (sign-in, updates). It resolves to nothing here,
// and the report lists it.
//
// Recognition is real (the release's own models, on WebAssembly or WebGPU, whichever the browser
// offers); the clip is synthetic. A product's test settings should turn off any geometric stage,
// because CI runners have no accelerated WebGPU.
//
// Each check names the clause it covers in the toolkit's hover spec (docs/hover-spec.md), in the
// table in clauses.mjs. An expected failure is listed in the product module with the old value,
// the intended value and what removes it, and, where it fails only under a timing condition, that
// condition (it must pass when the condition does not hold).
// A check the product's stand-in cannot support is listed in the module's `unsupported` with the
// reason: it is recorded as `unsupported`, not run as a check, and the run's output and report.json
// give the reason. It has no unexpected-pass signal, so the list is reviewed with the
// stand-in; a part of it that the stand-in can run is run as a diagnostic under `counts`. A setup
// failure, a timeout, a crash, a missing NetLog, a network violation or a content-security-policy
// violation is never an expected failure or an unsupported check.
// `frames-at-play` covers two clauses: S-A1 (the frames at play) and, in its made-up `playing` step,
// S-A10 (frames the page removed come back at a real play). A product that expects only the second
// to fail lists it with a `when` that leaves the first covered, for example
// `when: (d) => d.atPlay && d.beforePlay.length === 0`, so that a failure of S-A1 is not hidden.
// A listed expected failure that passes is an unexpected pass and fails the run, so the
// list is reviewed. Without --only, every check must have run.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { CHECKS, CLAUSES, IDLE_CHECKS } from "./clauses.mjs";
import { watchConsole } from "./console-watch.mjs";
import { classify, netlogRequests } from "./netlog.mjs";
import { productProblems, SLOTS } from "./product-shape.mjs";
import { startServer } from "./serve.mjs";

/** The whole run's deadline: past it the run stops, fails and still writes its report. */
const RUN_DEADLINE_MS = 12 * 60_000;

// ------------------------------------------------------------------ arguments
const { values } = parseArgs({
  options: {
    chrome: { type: "string" },
    release: { type: "string" },
    art: { type: "string" },
    product: { type: "string" },
    dist: { type: "string" },
    "dist-idle": { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    "fetch-art": { type: "boolean", default: false },
    headful: { type: "boolean", default: false },
  },
});
const usage = (problem) => {
  console.error(`${problem}\nusage: node hover-browser.mjs --product <product module> --chrome <Chrome for Testing> --release <release folder> --art <card pictures> [--fetch-art] [--dist <build>] [--dist-idle <build>] [--out folder] [--only ids]`);
  process.exit(2);
};
if (!values.product) usage("missing --product");
const productModule = await import(pathToFileURL(resolve(values.product)).href).catch((error) => usage(`--product: cannot load ${values.product}: ${error?.message ?? error}`));
const PRODUCT = productModule.default;
const productProblem = productProblems(PRODUCT, CHECKS);
if (productProblem.length > 0) usage(`--product ${values.product}: ${productProblem.join("; ")}`);
const { clip: CLIP, places: PLACES } = PRODUCT;
if (!values.chrome || !values.release || !values.art) usage("missing --chrome, --release or --art");
const distDir = values.dist ?? (PRODUCT.dist ? fileURLToPath(PRODUCT.dist) : null);
if (!distDir) usage("missing --dist (the product module names no default build folder)");
const only = values.only ? new Set(values.only.split(",")) : null;
if (only) for (const id of only) if (!CHECKS.includes(id)) usage(`--only: no check ${id}`);
const unsupported = PRODUCT.unsupported ?? {};
const want = (id) => (!only || only.has(id)) && !(id in unsupported);
if (!values["dist-idle"] && IDLE_CHECKS.some(want)) usage("--dist-idle is needed for the idle checks (or leave them out with --only)");
const repoRoot = fileURLToPath(PRODUCT.root);
if (!relative(repoRoot, resolve(values.art)).startsWith("..")) usage("--art must be outside the product's repository: card art is never committed");

const puppeteerDir = process.env.PUPPETEER_CORE_DIR;
// puppeteer-core is not a dependency of the toolkit or of a product: it is installed beside it (PUPPETEER_CORE_DIR)
// or into it with --no-save.
const puppeteerModule = await import(puppeteerDir ? createRequire(join(resolve(puppeteerDir), "index.js")).resolve("puppeteer-core") : "puppeteer-core");
const puppeteer = puppeteerModule.default?.launch ? puppeteerModule.default : puppeteerModule;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = resolve(values.out ?? mkdtempSync(join(tmpdir(), "hover-browser-out-")));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "hover-browser-"));
// The rendered clip (the card pictures), the profiles and the throwaway key go, however the run ends.
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const startedAt = Date.now();
const eventsFile = join(out, "events.jsonl");
writeFileSync(eventsFile, "");
/** One line of the event log, written as it happens so a hung run keeps it. */
const log = (kind, detail = {}) => {
  const line = { t: Date.now() - startedAt, kind, ...detail };
  appendFileSync(eventsFile, JSON.stringify(line) + "\n");
  console.log(`${String(line.t).padStart(6)} ${kind} ${Object.keys(detail).length ? JSON.stringify(detail) : ""}`);
};

// ------------------------------------------------------------------ fixtures
const productConfig = JSON.parse(readFileSync(PRODUCT.config, "utf-8"));
const settingsUrl = new URL(PRODUCT.settingsUrl(productConfig));
const cdnHost = settingsUrl.host;
const releaseDoc = JSON.parse(readFileSync(join(resolve(values.release), "release.json"), "utf-8"));
const catalog = JSON.parse(readFileSync(join(resolve(values.release), "catalog.json"), "utf-8"));
const byId = new Map((catalog.cards ?? catalog).map((c) => [c.id, c]));
// --fetch-art: download the pictures that are missing from the settings host, before the browser
// starts (card art is never kept in the product's repository).
mkdirSync(resolve(values.art), { recursive: true });
const cards = {};
for (const [slot, id] of Object.entries(PRODUCT.cards)) {
  const card = byId.get(id);
  if (!card) throw new Error(`setup: ${id} is not in the release's catalog`);
  const file = join(resolve(values.art), card.art);
  if (!existsSync(file) && values["fetch-art"]) {
    mkdirSync(dirname(file), { recursive: true });
    const response = await fetch(`https://${cdnHost}${PRODUCT.artPath(card.art)}`);
    if (!response.ok) throw new Error(`setup: ${id}'s picture: HTTP ${response.status}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  if (!existsSync(file)) throw new Error(`setup: no picture ${file} for ${id} (add --fetch-art)`);
  cards[slot] = { id, name: card.name, art: card.art, file };
}

/** The clip, rendered with ffmpeg: VP8 in WebM (Chrome for Testing plays no H.264). */
function renderClip() {
  const clip = join(work, "clip.webm");
  const slots = SLOTS; // fixed order: a later slot is drawn over an earlier one (D over A)
  const inputs = slots.flatMap((s) => ["-loop", "1", "-i", cards[s].file]);
  const scaled = slots.map((s, i) => `[${i + 1}]scale=${box(s).w}:${box(s).h}[${s}]`);
  let last = "bg";
  const layered = slots.map((s, i) => {
    const p = PLACES[s];
    const when = p.from !== undefined ? `:enable='gte(t,${p.from})'` : p.until !== undefined ? `:enable='lt(t,${p.until})'` : "";
    const next = i === slots.length - 1 ? "v" : `l${i}`;
    const step = `[${last}][${s}]overlay=${p.x}:${p.y}${when}:shortest=1[${next}]`;
    last = next;
    return step;
  });
  const graph = [`[0]noise=alls=10:allf=t[bg]`, ...scaled, ...layered].join(";");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x1d4a2e:s=${CLIP.width}x${CLIP.height}:r=${CLIP.fps}:d=${CLIP.seconds}`, ...inputs,
    "-filter_complex", graph, "-map", "[v]", "-t", String(CLIP.seconds), "-c:v", "libvpx", "-b:v", "2M", "-an", clip]);
  return clip;
}

/** The card's box in the clip, in clip pixels (the picture is scaled to it). */
function box(slot) {
  const p = PLACES[slot];
  return { x: p.x, y: p.y, w: PRODUCT.cardWidth, h: Math.round(PRODUCT.cardWidth * PRODUCT.cardAspect) };
}

const testSettings = PRODUCT.testSettings(`https://${cdnHost}${PRODUCT.artPath("{art}")}`);

/** The local stand-in for the settings host: the settings file and the card pictures. */
function startStandIn() {
  const certDir = join(work, "cert");
  mkdirSync(certDir);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
    "-subj", `/CN=${cdnHost}`, "-addext", `subjectAltName=DNS:${cdnHost}`], { stdio: "ignore" });
  const spki = execFileSync("sh", ["-c", `openssl x509 -pubkey -noout -in "${join(certDir, "cert.pem")}" | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`], { encoding: "utf-8" }).trim();
  const art = new Map(Object.values(cards).map((c) => [PRODUCT.artPath(c.art), readFileSync(c.file)]));
  const requests = [];
  const server = createServer({ key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) }, (req, res) => {
    const path = new URL(req.url ?? "/", `https://${cdnHost}`).pathname;
    const send = (status, body, type, cache) => {
      requests.push({ t: Date.now() - startedAt, path, status });
      res.writeHead(status, { "content-type": type, "cache-control": cache, "access-control-allow-origin": "*" }).end(body);
    };
    if (path === settingsUrl.pathname) send(200, JSON.stringify(testSettings), "application/json", "no-cache");
    else if (art.has(path)) send(200, art.get(path), "image/jpeg", "public, max-age=86400");
    else send(404, "", "text/plain", "no-store");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port, spki, requests })));
}

// ------------------------------------------------------------------ the browser
let chromeVersion = null;
async function launch(dist, profile, netlog) {
  const browser = await puppeteer.launch({
    executablePath: values.chrome,
    headless: !values.headful,
    pipe: true,
    enableExtensions: [resolve(dist)],
    userDataDir: profile,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      `--host-resolver-rules=MAP ${cdnHost} 127.0.0.1:${standIn.port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${standIn.spki}`,
      `--log-net-log=${netlog}`,
      "--net-log-capture-mode=Default",
      // Chrome's own background traffic (sync, updates, sign-in), which is not the extension's.
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--window-size=1400,1000",
    ],
    defaultViewport: { width: 1360, height: 900 },
  });
  browsers.add(browser);
  watchConsole(browser, { policy: policyViolations, origin: originMismatches });
  chromeVersion = await browser.version();
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 20_000 });
  return { browser, ext: { browser, origin: sw.url().split("/").slice(0, 3).join("/") } };
}

/** Browser messages about a content-security-policy violation (any page, frame or worker; one fails
 *  the run) and about a postMessage refused for its target origin (reported), from console-watch.mjs. */
const policyViolations = [];
const originMismatches = [];

/** Open the test page with the clip paused at the start. */
async function openPage(browser) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => log("page-error", { message: String(e.message ?? e) }));
  await page.goto(pageUrl);
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2, { timeout: 30_000 });
  await page.evaluate(() => document.querySelector("video").pause());
  return page;
}

const video = {
  async seek(page, t, play) {
    await page.evaluate(async (t, play) => {
      const v = document.querySelector("video");
      v.pause();
      v.currentTime = t;
      await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
      if (play) await v.play();
    }, t, play);
  },
  time: (page) => page.evaluate(() => document.querySelector("video").currentTime),
  rect: (page) =>
    page.evaluate(() => {
      const r = document.querySelector("video").getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }),
};

/** The page point at the middle of a card of the clip. */
async function pointOf(page, slot) {
  const r = await video.rect(page);
  const b = box(slot);
  return { x: r.left + ((b.x + b.w / 2) / CLIP.width) * r.width, y: r.top + ((b.y + b.h / 2) / CLIP.height) * r.height };
}

/** A point below the video, off its picture. */
async function offVideo(page) {
  const r = await video.rect(page);
  return { x: r.left + r.width / 2, y: r.top + r.height + 60 };
}

async function extensionFrames(page) {
  return page.evaluate((names) => [...document.querySelectorAll("iframe")].map((f) => f.src.split("/").at(-1)).filter((n) => names.includes(n)), Object.values(PRODUCT.frames));
}

async function computeDebug(page) {
  const f = page.frames().find((fr) => fr.url().startsWith("chrome-extension://") && fr.url().endsWith(`/${PRODUCT.frames.compute}`));
  if (!f) return null;
  return f.evaluate((g) => window[g]?.() ?? null, PRODUCT.debugGlobal).catch(() => null);
}

/** The tooltip as the viewer sees it: visible or not, the card's name, whether its picture shows. */
async function tooltip(page) {
  const visible = await page.evaluate((name) => {
    const f = [...document.querySelectorAll("iframe")].find((i) => i.src.endsWith(`/${name}`));
    return Boolean(f && getComputedStyle(f).visibility === "visible");
  }, PRODUCT.frames.tooltip);
  if (!visible) return { visible: false };
  const f = page.frames().find((fr) => fr.url().startsWith("chrome-extension://") && fr.url().endsWith(`/${PRODUCT.frames.tooltip}`));
  const s = f
    ? await f
        .evaluate((ids) => {
          const img = document.getElementById(ids.img);
          const art = document.getElementById(ids.art);
          const pill = document.getElementById(ids.pill);
          return { name: art.hidden ? pill.textContent : img.alt, art: !art.hidden && !art.classList.contains("loading") && img.complete && img.naturalWidth > 0 };
        }, PRODUCT.tooltipIds)
        .catch(() => null)
    : null;
  return { visible: true, name: s?.name ?? null, art: s?.art ?? false };
}

/** What a failed check records about the tooltip, to tell where its picture stopped: the frame's
 *  visibility, which of the picture box and the name pill shows, whether the box is still in its
 *  loading state, and whether the picture element has a source, finished loading and decoded. */
async function tooltipState(page) {
  const shown = await tooltip(page);
  const f = page.frames().find((fr) => fr.url().startsWith("chrome-extension://") && fr.url().endsWith(`/${PRODUCT.frames.tooltip}`));
  const inner = f
    ? await f
        .evaluate((ids) => {
          const img = document.getElementById(ids.img);
          const art = document.getElementById(ids.art);
          const pill = document.getElementById(ids.pill);
          const src = img.getAttribute("src");
          return {
            artHidden: art.hidden,
            loading: art.classList.contains("loading"),
            src: src === null ? "none" : src.startsWith("blob:") ? "blob" : "other",
            complete: img.complete,
            naturalWidth: img.naturalWidth,
            pillHidden: pill.hidden,
            frameSize: { width: innerWidth, height: innerHeight },
          };
        }, PRODUCT.tooltipIds)
        .catch((error) => ({ error: String(error?.message ?? error) }))
    : null;
  return { ...shown, frame: Boolean(f), inner };
}

/** The compute frame's own account, for a check's record: its load state, its last error, the
 *  last look's error and how long the worker took on it, whether it stopped or restarted, and how
 *  many looks it analyzed. */
const computeState = (d) =>
  d ? { state: d.state, error: d.error, lastFrameError: d.lastFrameError, lastWorkerMs: d.lastWorkerMs, analyzed: d.analyzed, restarts: d.restarts, stopped: d.stopped } : null;

async function outline(page) {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el || getComputedStyle(el).display === "none") return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, PRODUCT.outlineSelector);
}

/** Poll until `probe` returns a truthy value or the time runs out; returns it, or null. */
async function until(probe, ms, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

/** Point at a card with one pointer move and rest there, until the tooltip names the card with its
 *  picture shown; returns the tooltip and the time, or null. With `wiggle`, the pointer moves a
 *  few pixels now and then while it waits, as a hand does (for steps where the resting pointer is
 *  not what is checked). */
async function hoverCard(page, slot, ms, { wiggle: moveNowAndThen = false } = {}) {
  const p = await pointOf(page, slot);
  const moved = Date.now();
  await page.mouse.move(p.x, p.y, { steps: 4 });
  let wiggle = 0;
  const shown = await until(async () => {
    const s = await tooltip(page);
    if (s.visible && s.name === cards[slot].name && s.art) return s;
    wiggle += 1;
    if (moveNowAndThen && wiggle % 4 === 0) await page.mouse.move(p.x + (wiggle % 8 === 0 ? 3 : -3), p.y);
    return null;
  }, ms);
  return shown ? { ...shown, ms: Date.now() - moved } : null;
}

/** The extension's background worker as it is now. Chrome stops an idle worker and starts a new
 *  one later, so a worker found earlier may be gone. When none is running, opening one of the
 *  extension's pages starts it again. */
async function extensionWorker(ext) {
  const isOurs = (t) => t.type() === "service_worker" && t.url().startsWith(`${ext.origin}/`);
  let target = ext.browser.targets().find(isOurs);
  if (!target) {
    // In the background, so the test page stays in front: a hidden page treats some settings
    // differently.
    const page = await ext.browser.newPage({ background: true });
    try {
      await page.goto(`${ext.origin}/${PRODUCT.wakePage}`);
      target = await ext.browser.waitForTarget(isOurs, { timeout: 10_000 });
      log("worker-woken", {});
    } finally {
      await page.close();
    }
  }
  return target.worker();
}

/** Set a stored setting as the popup does (the extension's local storage area), from the extension's background.
 *  If the worker stops between finding it and using it, the next one is tried once. */
async function setStored(ext, key, value) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const worker = await extensionWorker(ext);
      if (!worker) throw new Error("setup: the extension's background worker is not running");
      await worker.evaluate((k, v) => chrome.storage.local.set({ [k]: v }), key, value);
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      log("worker-retry", { error: String(error?.message ?? error) });
    }
  }
  await sleep(1000);
}

// ------------------------------------------------------------------ the checks
const results = [];
function record(id, ok, detail) {
  const clause = CLAUSES[id];
  const listed = PRODUCT.expectedFail[id];
  const xf = listed && (!listed.when || listed.when(detail, ok)) ? { ...listed, when: listed.condition } : null;
  const outcome = ok ? (xf ? "unexpected-pass" : "pass") : xf ? "expected-fail" : "fail";
  results.push({ id, clause, outcome, detail, ...(xf ? { expected: xf } : {}) });
  log(`check ${outcome}`, { id, clause, ...detail });
}

for (const [id, reason] of Object.entries(unsupported)) {
  if (only && !only.has(id)) continue;
  results.push({ id, clause: CLAUSES[id], outcome: "unsupported", detail: { reason } });
  log("check unsupported", { id, clause: CLAUSES[id], reason });
}

const clipPath = renderClip();
const server = await startServer({ video: clipPath, port: 0 });
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const standIn = await startStandIn();
log("setup", { clip: clipPath, page: pageUrl, standIn: standIn.port, cards: Object.fromEntries(Object.entries(cards).map(([k, c]) => [k, `${c.id} ${c.name}`])) });

const netlogs = [];
const counts = {};
let fatal = null;
const browsers = new Set();
let finished = false;
// The run's deadline: whatever is still running is stopped, and the report says why.
const watchdog = setTimeout(() => {
  fatal = `timeout: the run passed its ${RUN_DEADLINE_MS / 60_000}-minute deadline`;
  log("fatal", { error: fatal });
  const closeOrKill = (b) => Promise.race([b.close(), sleep(10_000).then(() => b.process()?.kill("SIGKILL"))]);
  void Promise.allSettled([...browsers].map(closeOrKill)).then(() => finish());
}, RUN_DEADLINE_MS);

try {
  // ---------------- session 1: a fresh profile, the dev build
  {
    const netlog = join(out, "netlog-main.json");
    netlogs.push(netlog);
    const { browser, ext } = await launch(distDir, join(work, "profile-main"), netlog);
    try {
      let page = await openPage(browser);

      // Load at play, and no capture before a pointer.
      await sleep(1500);
      const beforePlay = await extensionFrames(page);
      await video.seek(page, 1, true);
      const atPlay = await until(async () => ((await extensionFrames(page)).length === 2 ? true : null), 10_000);
      const ready = await until(async () => ((await computeDebug(page))?.state === "ready" ? await computeDebug(page) : null), 60_000, 250);
      log("compute", { state: ready?.state ?? null, backend: ready?.backend ?? null });
      if (!ready) throw new Error("setup: the compute frame never became ready");
      counts.backend = ready.backend;
      // The compute page's own times (epoch ms), when its debug record has them: its load event, and
      // the first message from the page (the content script's hello).
      if (Number.isFinite(ready.loadedAt) && Number.isFinite(ready.helloAt)) counts.helloMinusLoadMs = Math.round(ready.helloAt - ready.loadedAt);
      await sleep(3000);
      const analyzedBeforePointer = (await computeDebug(page))?.analyzed ?? -1;
      // A page script removes both frames and then makes up `playing` events on the playing video:
      // nothing is made (S-A1). A real `playing` (a pause and a play) makes them again (S-A10).
      let fakePlay = null;
      if (want("frames-at-play") && atPlay) {
        // Early in the clip, so that its loop cannot make a real `playing` inside the window below;
        // any real `playing` there is a setup error.
        await video.seek(page, 1, true);
        await sleep(800);
        await page.evaluate(() => {
          window.__realPlays = 0;
          document.addEventListener("playing", (e) => (window.__realPlays += e.isTrusted ? 1 : 0), true);
        });
        await page.evaluate((names) => {
          for (const f of document.querySelectorAll("iframe")) if (names.includes(f.src.split("/").at(-1))) f.remove();
        }, Object.values(PRODUCT.frames));
        await page.evaluate(() => {
          const v = document.querySelector("video");
          for (let i = 0; i < 3; i += 1) v.dispatchEvent(new Event("playing"));
        });
        await sleep(1500);
        const afterFake = await extensionFrames(page);
        if ((await page.evaluate(() => window.__realPlays)) > 0) throw new Error("setup: a real `playing` event came inside the made-up one's window");
        await page.evaluate(async () => {
          const v = document.querySelector("video");
          v.pause();
          await v.play();
        });
        const remade = await until(async () => ((await extensionFrames(page)).length === 2 ? true : null), 10_000);
        if (remade) await until(async () => ((await computeDebug(page))?.state === "ready" ? true : null), 60_000, 250);
        fakePlay = { afterFake, remade: Boolean(remade) };
      }
      if (want("frames-at-play")) record("frames-at-play", beforePlay.length === 0 && atPlay === true && fakePlay?.afterFake.length === 0 && fakePlay.remade, { beforePlay, atPlay: Boolean(atPlay), fakePlay });
      if (want("no-capture-before-pointer")) record("no-capture-before-pointer", analyzedBeforePointer === 0, { analyzedBeforePointer });

      // A named card's picture, and its outline.
      await video.seek(page, 2, false);
      const a0 = (await computeDebug(page))?.analyzed ?? 0;
      const shownB = await hoverCard(page, "B", 30_000);
      const a1 = (await computeDebug(page))?.analyzed ?? 0;
      counts.namedCard = { analyses: a1 - a0, artVisibleMs: shownB?.ms ?? null };
      if (want("art-visible")) record("art-visible", Boolean(shownB), { want: cards.B.name, got: shownB ?? (await tooltip(page)), analyses: a1 - a0 });
      const ol = await outline(page);
      const pB = await pointOf(page, "B");
      if (want("outline-shows")) record("outline-shows", Boolean(ol && pB.x > ol.left && pB.x < ol.left + ol.width && pB.y > ol.top && pB.y < ol.top + ol.height), { outline: ol });

      // Moving off the video clears the tooltip and the outline.
      const off = await offVideo(page);
      await page.mouse.move(off.x, off.y, { steps: 4 });
      const cleared = await until(async () => (!(await tooltip(page)).visible && !(await outline(page)) ? true : null), 2000);
      if (want("move-off-clears")) record("move-off-clears", Boolean(cleared), {});

      // Point at A from 5 s, rest, and watch through 12.5 s while D is laid on top of it at 8 s.
      const covered = async () => {
        await video.seek(page, 5, true);
        const pA = await pointOf(page, "A");
        await page.mouse.move(pA.x, pA.y, { steps: 4 });
        const first = await until(async () => {
          const s = await tooltip(page);
          return s.visible && s.name ? s.name : null;
        }, 10_000);
        const names = new Set();
        let outlineBefore = false;
        let heldFrom = null;
        let outlineCameBack = false;
        const deadline = Date.now() + 25_000;
        for (;;) {
          const t = await video.time(page);
          if (t >= 12.5 || t < 4) break; // past the scene, or the clip looped
          if (Date.now() > deadline) throw new Error(`setup: the clip did not reach 12.5 s in 25 s (at ${t.toFixed(2)} s)`);
          const s = await tooltip(page);
          const o = await outline(page);
          if (s.visible && s.name) names.add(s.name);
          if (t < 7.8 && s.visible && s.name === cards.A.name && o) outlineBefore = true;
          if (t > 8.5 && s.visible && !o && heldFrom === null) heldFrom = t;
          if (heldFrom !== null && s.visible && o) outlineCameBack = true;
          await sleep(200);
        }
        const last = await tooltip(page);
        return { first, names: [...names], last: last.visible ? last.name : null, outlineBefore, heldFrom, outlineCameBack };
      };
      // The switch on (the default): the hovered card stays, and its outline goes once it is seen
      // gone and stays gone while the tooltip stays.
      const on = await covered();
      if (want("covered-kept")) record("covered-kept", on.first === cards.A.name && on.last === cards.A.name && !on.names.includes(cards.D.name), on);
      if (want("held-outline-hides")) record("held-outline-hides", on.outlineBefore && on.heldFrom !== null && !on.outlineCameBack && on.last === cards.A.name, on);

      // The switch off: the card on top replaces the hovered one with no pointer move.
      await page.mouse.move(off.x, off.y);
      await setStored(ext, PRODUCT.keys.keepCard, false);
      await page.bringToFront();
      await until(async () => ((await computeDebug(page))?.state === "ready" ? true : null), 60_000, 250);
      const offRun = await covered();
      if (want("switch-flips")) record("switch-flips", offRun.first === cards.A.name && offRun.last === cards.D.name, offRun);
      await page.mouse.move(off.x, off.y);
      await setStored(ext, PRODUCT.keys.keepCard, true);
      await page.bringToFront();

      // A page script's made-up pointer events: no frame, no capture.
      {
        const tab = await openPage(browser);
        const p = await pointOf(tab, "B");
        await tab.evaluate(({ x, y }) => {
          for (let i = 0; i < 5; i += 1) window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + i, clientY: y, bubbles: true }));
        }, p);
        await sleep(1500);
        const fake = await extensionFrames(tab);
        await tab.mouse.move(p.x, p.y, { steps: 3 });
        const real = await until(async () => ((await extensionFrames(tab)).length === 2 ? true : null), 5000);
        if (want("fake-pointer-ignored")) record("fake-pointer-ignored", fake.length === 0 && real === true, { framesAfterFake: fake, framesAfterReal: Boolean(real) });
        await tab.close();
      }

      // Off means off: no frames, and nothing captured or fetched for card hovers.
      await page.bringToFront();
      const reqBefore = standIn.requests.length;
      await setStored(ext, PRODUCT.keys.enabled, false);
      await page.bringToFront();
      const gone = await until(async () => ((await extensionFrames(page)).length === 0 ? true : null), 3000);
      await video.seek(page, 3, true);
      const pB2 = await pointOf(page, "B");
      await page.mouse.move(pB2.x, pB2.y, { steps: 4 });
      await sleep(2500);
      const framesOff = await extensionFrames(page);
      const fetchedOff = standIn.requests.slice(reqBefore).filter((r) => r.path !== settingsUrl.pathname);
      if (want("off-means-off")) record("off-means-off", gone === true && framesOff.length === 0 && fetchedOff.length === 0, { framesOff, fetchedOff });
      // A second tab plays the same page while hovers are off, then goes behind the first (S-A7).
      let behind = null;
      if (want("on-while-playing-loads")) {
        behind = await openPage(browser);
        await video.seek(behind, 3, true);
        await page.bringToFront();
        // Chrome may pause a video that goes behind: it plays on, behind the first tab, at switch-on.
        await behind.evaluate(() => document.querySelector("video").play());
      }
      await setStored(ext, PRODUCT.keys.enabled, true);
      await page.bringToFront();
      const back = await until(async () => ((await extensionFrames(page)).length === 2 ? true : null), 5000);
      if (behind) {
        // Switched on, the tab in front loads at once; the tab behind waits for the front and loads then.
        // The tab behind must really be hidden and its video really playing, or the check proves
        // nothing: a setup that is not so is a setup error, never part of the result.
        const hidden = (await behind.evaluate(() => document.visibilityState)) === "hidden";
        if (!hidden) throw new Error("setup: the second tab is not hidden at switch-on");
        const behindPlaying = await behind.evaluate(() => {
          const v = document.querySelector("video");
          return !v.paused && !v.ended;
        });
        if (!behindPlaying) throw new Error("setup: the video in the second tab is not playing at switch-on");
        await sleep(1500);
        const behindFrames = await extensionFrames(behind);
        await behind.bringToFront();
        const fronted = await until(async () => ((await extensionFrames(behind)).length === 2 ? true : null), 10_000);
        record("on-while-playing-loads", back === true && behindFrames.length === 0 && fronted === true, { front: back === true, hidden, behindPlaying, behindFrames, behindAtFront: Boolean(fronted) });
        await behind.close();
        await page.bringToFront();
      }

      // A second tab of the same page while the first plays on: one pointer move over its paused
      // video, then the pointer rests, and the card is named.
      // The first tab's model is ready before the second tab opens, so the two never load at once.
      // Both tabs' visibility, the first tab's state, and each change in the second tab's load
      // state, backend or restarts are logged with their times. The debug global reports a load as
      // one "loading" step, so this shows when a load ended, not where its time went.
      {
        const firstReady = await until(async () => ((await computeDebug(page))?.state === "ready" ? true : null), 30_000);
        const tab = await openPage(browser);
        const visibility = (p) => p.evaluate(() => document.visibilityState).catch(() => null);
        const atOpen = { firstReady: Boolean(firstReady), firstVisibility: await visibility(page), secondVisibility: await visibility(tab), first: await computeDebug(page) };
        log("second-tab-open", { ...atOpen, first: atOpen.first && { state: atOpen.first.state, analyzed: atOpen.first.analyzed, stopped: atOpen.first.stopped } });
        await video.seek(tab, 2, false);
        const hoverAt = Date.now();
        const steps = [];
        const readyWatch = until(async () => {
          const d = await computeDebug(tab);
          const step = d ? { state: d.state, backend: d.backend, restarts: d.restarts } : { state: "no frame" };
          const prev = steps.at(-1);
          if (!prev || prev.state !== step.state || prev.backend !== step.backend || prev.restarts !== step.restarts)
            steps.push({ ms: Date.now() - hoverAt, ...step, ...(d?.error ? { error: d.error } : {}) });
          const state = step.state;
          return state === "ready" ? Date.now() : null;
        }, 60_000, 100);
        const named = await hoverCard(tab, "B", 60_000);
        const readyAt = await readyWatch;
        const last = await computeDebug(tab);
        counts.secondTab = { artVisibleMs: named?.ms ?? null, readyMs: readyAt ? readyAt - hoverAt : null };
        if (want("second-tab-names-card"))
          record("second-tab-names-card", Boolean(named), {
            ...counts.secondTab,
            analyzed: last?.analyzed ?? null,
            // The first step after "no frame" is about when the compute frame started: a frame
            // that starts more than 10 s after the pointer's last move is not told of the pointer
            // when it connects, so it gets no slow-start look.
            steps,
            compute: computeState(last),
            release: last?.release ? { source: last.release.source, reason: last.release.reason ?? null } : null,
            firstReady: atOpen.firstReady,
            visibility: { first: atOpen.firstVisibility, second: atOpen.secondVisibility },
          });
        await tab.close();
      }

      // The cached reload: the page closed and opened again in a new tab, the same card again.
      {
        await page.close();
        page = null;
        const before = standIn.requests.length;
        const tab = await openPage(browser);
        await video.seek(tab, 2, false);
        const readyWatch = until(async () => ((await computeDebug(tab))?.state === "ready" ? Date.now() : null), 60_000, 100);
        const hoverAt = Date.now();
        const again = await hoverCard(tab, "B", 60_000);
        const readyAt = await readyWatch;
        counts.cachedReloadReadyMs = readyAt ? readyAt - hoverAt : null;
        const fetched = standIn.requests.slice(before).filter((r) => r.path.startsWith(PRODUCT.artPath("")));
        counts.cachedReload = { artRequests: fetched.length, artVisibleMs: again?.ms ?? null };
        if (want("cached-reload"))
          record("cached-reload", Boolean(again) && fetched.length === 0, {
            shown: Boolean(again),
            ms: again?.ms ?? null,
            artRequests: fetched.length,
            readyMs: counts.cachedReloadReadyMs,
            ...(again ? {} : { tooltip: await tooltipState(tab), compute: computeState(await computeDebug(tab)) }),
          });
        await tab.close();
      }
    } finally {
      await browser.close();
      browsers.delete(browser);
    }
  }

  // ---------------- session 2: the idle unload, with a short idle time (a separate dev build)
  if (values["dist-idle"] && IDLE_CHECKS.some(want)) {
    const netlog = join(out, "netlog-idle.json");
    netlogs.push(netlog);
    const { browser, ext } = await launch(values["dist-idle"], join(work, "profile-idle"), netlog);
    try {
      const page = await openPage(browser);
      const goIdle = async () => {
        await video.seek(page, 1, true);
        await until(async () => ((await extensionFrames(page)).length === 2 ? true : null), 10_000);
        await until(async () => ((await computeDebug(page))?.state === "ready" ? true : null), 60_000, 250);
        if (!(await hoverCard(page, "B", 30_000, { wiggle: true }))) throw new Error("setup: no card named before the idle unload");
        const off = await offVideo(page);
        await page.mouse.move(off.x, off.y, { steps: 4 });
        return until(async () => ((await extensionFrames(page)).length === 0 ? true : null), 30_000, 250);
      };
      const idle = await goIdle();
      if (want("idle-unloads")) record("idle-unloads", idle === true, {});
      // The video playing again (a pause and play, and the clip looping) makes nothing.
      await page.evaluate(async () => {
        const v = document.querySelector("video");
        v.pause();
        await v.play();
        v.currentTime = 19.5;
      });
      await sleep(3000);
      const afterLoop = await extensionFrames(page);
      if (want("loop-no-reload")) record("loop-no-reload", afterLoop.length === 0, { afterLoop });
      // The next pointer move over the video makes them again, and names the card.
      await video.seek(page, 2, true);
      const reloaded = await hoverCard(page, "B", 60_000);
      if (want("idle-reload-on-hover")) record("idle-reload-on-hover", Boolean(reloaded), { ms: reloaded?.ms ?? null });
      // Switched off and on after an idle unload, while the video plays.
      if (want("switch-on-after-idle-reloads")) {
        if (!(await goIdle())) throw new Error("setup: the second idle unload did not happen");
        await setStored(ext, PRODUCT.keys.enabled, false);
        await setStored(ext, PRODUCT.keys.enabled, true);
        await page.bringToFront();
        const atOnce = await until(async () => ((await extensionFrames(page)).length === 2 ? true : null), 5000);
        record("switch-on-after-idle-reloads", atOnce === true, {});
      }
      await page.close();
    } finally {
      await browser.close();
      browsers.delete(browser);
    }
  }
} catch (error) {
  fatal ??= String(error?.stack ?? error);
  log("fatal", { error: fatal });
}
finish();

// ------------------------------------------------------------------ the network scope and the report
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  server.close();
  standIn.server.close();
  let violations = [];
  let exempt = [];
  let hostsSeen = {};
  try {
    const all = [];
    for (const file of netlogs) {
      if (!existsSync(file)) throw new Error(`no NetLog at ${file}: the network scope cannot be checked`);
      const requests = netlogRequests(readFileSync(file, "utf-8"));
      if (!requests.some((r) => r.urls.some((u) => u.startsWith(pageUrl)))) throw new Error(`${file} holds no request to the test page: the NetLog is not trustworthy`);
      all.push(...requests);
    }
    ({ violations, exempt, hosts: hostsSeen } = classify(all, { standInHost: cdnHost }));
    if (netlogs.length > 0 && !(cdnHost in hostsSeen)) throw new Error(`no request reached ${cdnHost} in the NetLogs: the network scope cannot be checked`);
  } catch (error) {
    fatal ??= `network scope: ${error?.message ?? error}`;
    log("fatal", { error: fatal });
  }
  counts.standIn = standIn.requests.reduce((m, r) => ((m[`${r.status} ${r.path}`] = (m[`${r.status} ${r.path}`] ?? 0) + 1), m), {});
  counts.hosts = hostsSeen;
  const missing = only ? [] : CHECKS.filter((id) => !results.some((r) => r.id === id));
  const failed = results.filter((r) => r.outcome === "fail" || r.outcome === "unexpected-pass");
  counts.originMismatches = originMismatches.length;
  const manifest = JSON.parse(readFileSync(join(resolve(distDir), "manifest.json"), "utf-8"));
  const report = {
    product: PRODUCT.name,
    passed: !fatal && violations.length === 0 && policyViolations.length === 0 && failed.length === 0 && missing.length === 0 && results.length > 0,
    fatal,
    missing,
    violations,
    policyViolations,
    originMismatches,
    unsupported: Object.entries(unsupported).filter(([id]) => !only || only.has(id)).map(([id, reason]) => ({ id, clause: CLAUSES[id], reason })),
    exemptChromeOwn: exempt,
    results,
    counts,
    measuredOn: {
      chrome: chromeVersion,
      extensionVersion: manifest.version,
      release: releaseDoc.id ?? null,
      settings: testSettings,
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
    },
    durationMs: Date.now() - startedAt,
  };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\n${results.map((r) => `${r.outcome.padEnd(15)} ${r.id}${r.outcome === "unsupported" ? ` (${r.detail.reason})` : ""}`).join("\n")}`);
  if (missing.length) console.log(`missing (never ran): ${missing.join(", ")}`);
  console.log(`policy: ${policyViolations.length} content-security-policy violation(s); ${originMismatches.length} refused postMessage(s)`);
  console.log(`network: ${violations.length} violation(s), ${exempt.length} of Chrome's own exempt; hosts ${JSON.stringify(hostsSeen)}`);
  console.log(`counts: ${JSON.stringify(counts)}`);
  console.log(`${report.passed ? "PASS" : "FAIL"} in ${(report.durationMs / 1000).toFixed(0)} s on ${chromeVersion}; report ${join(out, "report.json")}`);
  process.exit(report.passed ? 0 : 1);
}
