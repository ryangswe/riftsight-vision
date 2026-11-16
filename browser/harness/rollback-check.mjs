// SPDX-License-Identifier: Apache-2.0
// The rollback check: build A, then build B in its place on the same browser profile, as a store
// update or its rollback does, and check that the hovers still work and the viewer's choices stay.
// Run it with a product's candidate as A and its rollback build as B (and the other way round for
// the update), each an unpacked development build, with the same --product module the hover
// browser test takes. It is not part of `npm test`.
//
//   node rollback-check.mjs --product <product module> --chrome <Chrome for Testing>
//        --release <release folder> --art <folder with the card pictures, outside the product's
//        repository> --a <build A> --b <build B> [--out <folder for the report and NetLogs>]
//
// puppeteer-core is found as the hover browser test finds it (PUPPETEER_CORE_DIR), and ffmpeg and
// openssl must be on the PATH. The page, the settings host and the network scope are the hover
// browser test's: a local page with a clip, a local HTTPS stand-in for the settings host, every
// other host resolved to nothing.
//
// What it does. The extension folder and the profile stay the same for both builds (an unpacked
// extension's id comes from its folder, and the stored choices live under that id); only the
// folder's contents change.
// The two builds must differ in their manifest's version: each session first reads the version the
// extension runs (`chrome.runtime.getManifest()`), so that a run that never loaded B cannot pass.
//   build A: the video plays and the two frames appear; the pointer rests on a card and its
//            picture shows; the viewer turns hovers off and the held-card choice off, and the frames go.
//   build B: the stored choices are the ones A left (hovers off, held card off, the last good
//            settings file); the video plays and no frames appear (off is kept); turned on, the
//            frames appear at once, and the card's picture shows.
// A build that reads A's storage differently fails here, at the check that names it. Nothing but
// the local servers may be reached, and no content-security-policy violation may be logged.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { watchConsole } from "./console-watch.mjs";
import { classify, netlogRequests } from "./netlog.mjs";
import { productProblems, SLOTS } from "./product-shape.mjs";
import { CHECKS } from "./clauses.mjs";
import { startServer } from "./serve.mjs";

const RUN_DEADLINE_MS = 6 * 60_000;
const { values } = parseArgs({
  options: { chrome: { type: "string" }, release: { type: "string" }, art: { type: "string" }, product: { type: "string" }, a: { type: "string" }, b: { type: "string" }, out: { type: "string" } },
});
const usage = (problem) => {
  console.error(`${problem}\nusage: node rollback-check.mjs --product <product module> --chrome <Chrome for Testing> --release <release folder> --art <card pictures> --a <build A> --b <build B> [--out folder]`);
  process.exit(2);
};
if (!values.product) usage("missing --product");
const productModule = await import(pathToFileURL(resolve(values.product)).href).catch((error) => usage(`--product: cannot load ${values.product}: ${error?.message ?? error}`));
const PRODUCT = productModule.default;
const problems = productProblems(PRODUCT, CHECKS);
if (problems.length > 0) usage(`--product ${values.product}: ${problems.join("; ")}`);
for (const flag of ["chrome", "release", "art", "a", "b"]) if (!values[flag]) usage(`missing --${flag}`);
for (const flag of ["a", "b"]) if (!existsSync(join(resolve(values[flag]), "manifest.json"))) usage(`--${flag}: no manifest.json in ${values[flag]}`);
if (!relative(fileURLToPath(PRODUCT.root), resolve(values.art)).startsWith("..")) usage("--art must be outside the product's repository: card art is never committed");

const manifestVersion = (build) => JSON.parse(readFileSync(join(resolve(build), "manifest.json"), "utf-8")).version;
const versionA = manifestVersion(values.a);
const versionB = manifestVersion(values.b);
if (versionA === versionB) usage(`--a and --b have the same manifest version (${versionA}): give build B another version, or the check cannot tell which build is running`);

const { clip: CLIP, places: PLACES } = PRODUCT;
const puppeteerDir = process.env.PUPPETEER_CORE_DIR;
const puppeteerModule = await import(puppeteerDir ? createRequire(join(resolve(puppeteerDir), "index.js")).resolve("puppeteer-core") : "puppeteer-core");
const puppeteer = puppeteerModule.default?.launch ? puppeteerModule.default : puppeteerModule;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = resolve(values.out ?? mkdtempSync(join(tmpdir(), "rollback-check-out-")));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "rollback-check-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const startedAt = Date.now();
const log = (kind, detail = {}) => console.log(`${String(Date.now() - startedAt).padStart(6)} ${kind} ${Object.keys(detail).length ? JSON.stringify(detail) : ""}`);

// ------------------------------------------------------------------ fixtures
const settingsUrl = new URL(PRODUCT.settingsUrl(JSON.parse(readFileSync(PRODUCT.config, "utf-8"))));
const cdnHost = settingsUrl.host;
const catalog = JSON.parse(readFileSync(join(resolve(values.release), "catalog.json"), "utf-8"));
const byId = new Map((catalog.cards ?? catalog).map((c) => [c.id, c]));
const cards = {};
for (const [slot, id] of Object.entries(PRODUCT.cards)) {
  const card = byId.get(id);
  if (!card) throw new Error(`setup: ${id} is not in the release's catalog`);
  const file = join(resolve(values.art), card.art);
  if (!existsSync(file)) throw new Error(`setup: no picture ${file} for ${id}`);
  cards[slot] = { id, name: card.name, art: card.art, file };
}
const box = (slot) => ({ x: PLACES[slot].x, y: PLACES[slot].y, w: PRODUCT.cardWidth, h: Math.round(PRODUCT.cardWidth * PRODUCT.cardAspect) });

/** The clip: the cards of the product module's places, over a noisy table (VP8: Chrome for Testing plays no H.264). */
function renderClip() {
  const clip = join(work, "clip.webm");
  const inputs = SLOTS.flatMap((s) => ["-loop", "1", "-i", cards[s].file]);
  const scaled = SLOTS.map((s, i) => `[${i + 1}]scale=${box(s).w}:${box(s).h}[${s}]`);
  let last = "bg";
  const layered = SLOTS.map((s, i) => {
    const p = PLACES[s];
    const when = p.from !== undefined ? `:enable='gte(t,${p.from})'` : p.until !== undefined ? `:enable='lt(t,${p.until})'` : "";
    const next = i === SLOTS.length - 1 ? "v" : `l${i}`;
    const step = `[${last}][${s}]overlay=${p.x}:${p.y}${when}:shortest=1[${next}]`;
    last = next;
    return step;
  });
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x1d4a2e:s=${CLIP.width}x${CLIP.height}:r=${CLIP.fps}:d=${CLIP.seconds}`, ...inputs,
    "-filter_complex", [`[0]noise=alls=10:allf=t[bg]`, ...scaled, ...layered].join(";"), "-map", "[v]", "-t", String(CLIP.seconds), "-c:v", "libvpx", "-b:v", "2M", "-an", clip]);
  return clip;
}

/** The local stand-in for the settings host, with a throwaway certificate Chrome trusts by its key's hash. */
function startStandIn() {
  const certDir = join(work, "cert");
  mkdirSync(certDir);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
    "-subj", `/CN=${cdnHost}`, "-addext", `subjectAltName=DNS:${cdnHost}`], { stdio: "ignore" });
  const spki = execFileSync("sh", ["-c", `openssl x509 -pubkey -noout -in "${join(certDir, "cert.pem")}" | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`], { encoding: "utf-8" }).trim();
  const art = new Map(Object.values(cards).map((c) => [PRODUCT.artPath(c.art), readFileSync(c.file)]));
  const settings = JSON.stringify(PRODUCT.testSettings(`https://${cdnHost}${PRODUCT.artPath("{art}")}`));
  const server = createServer({ key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) }, (req, res) => {
    const path = new URL(req.url ?? "/", `https://${cdnHost}`).pathname;
    const send = (status, body, type) => res.writeHead(status, { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*" }).end(body);
    if (path === settingsUrl.pathname) send(200, settings, "application/json");
    else if (art.has(path)) send(200, art.get(path), "image/jpeg");
    else send(404, "", "text/plain");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port, spki })));
}

// ------------------------------------------------------------------ the browser
const browsers = new Set();
/** Browser messages about a content-security-policy violation (fails the run) and a refused postMessage. */
const policyViolations = [];
const originMismatches = [];

const clipPath = renderClip();
const server = await startServer({ video: clipPath, port: 0 });
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const standIn = await startStandIn();
const profile = join(work, "profile");
/** The one folder both builds are unpacked into: the extension's id comes from it. */
const installed = join(work, "extension");
const netlogs = [];

async function session(name, build, body) {
  rmSync(installed, { recursive: true, force: true });
  cpSync(resolve(build), installed, { recursive: true });
  const netlog = join(out, `netlog-${name}.json`);
  netlogs.push(netlog);
  const browser = await puppeteer.launch({
    executablePath: values.chrome,
    headless: true,
    pipe: true,
    enableExtensions: [installed],
    userDataDir: profile,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      `--host-resolver-rules=MAP ${cdnHost} 127.0.0.1:${standIn.port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${standIn.spki}`,
      `--log-net-log=${netlog}`,
      "--net-log-capture-mode=Default",
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
  try {
    const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 20_000 });
    // The worker is let settle: an extension whose files changed since the profile's last run is
    // started, and its background worker replaced, within the first moments.
    await sleep(2000);
    return await body({ browser, origin: sw.url().split("/").slice(0, 3).join("/") });
  } finally {
    await browser.close();
    browsers.delete(browser);
  }
}

async function until(probe, ms, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

async function openPage(browser) {
  const page = await browser.newPage();
  await page.goto(pageUrl);
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2, { timeout: 30_000 });
  await page.evaluate(() => document.querySelector("video").pause());
  return page;
}
const play = (page, t) =>
  page.evaluate(async (t) => {
    const v = document.querySelector("video");
    v.pause();
    v.currentTime = t;
    await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
    await v.play();
  }, t);
const extensionFrames = (page) =>
  page.evaluate((names) => [...document.querySelectorAll("iframe")].map((f) => f.src.split("/").at(-1)).filter((n) => names.includes(n)), Object.values(PRODUCT.frames));
const framesUp = async (page, ms) => Boolean(await until(async () => ((await extensionFrames(page)).length === 2 ? true : null), ms));

async function pointOn(page, slot) {
  const r = await page.evaluate(() => {
    const b = document.querySelector("video").getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  });
  const b = box(slot);
  return { x: r.left + ((b.x + b.w / 2) / CLIP.width) * r.width, y: r.top + ((b.y + b.h / 2) / CLIP.height) * r.height };
}

/** The view frame as the viewer sees it: its name and whether its picture shows. */
async function tooltip(page) {
  const visible = await page.evaluate((name) => {
    const f = [...document.querySelectorAll("iframe")].find((i) => i.src.endsWith(`/${name}`));
    return Boolean(f && getComputedStyle(f).visibility === "visible");
  }, PRODUCT.frames.tooltip);
  if (!visible) return null;
  const f = page.frames().find((fr) => fr.url().startsWith("chrome-extension://") && fr.url().endsWith(`/${PRODUCT.frames.tooltip}`));
  return f
    ? f
        .evaluate((ids) => {
          const img = document.getElementById(ids.img);
          const art = document.getElementById(ids.art);
          const pill = document.getElementById(ids.pill);
          return { name: art.hidden ? pill.textContent : img.alt, art: !art.hidden && !art.classList.contains("loading") && img.complete && img.naturalWidth > 0 };
        }, PRODUCT.tooltipIds)
        .catch(() => null)
    : null;
}

/** One pointer move onto a card, then rest until the view frame names it with its picture. */
async function hoverShowsArt(page, slot, ms) {
  const p = await pointOn(page, slot);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  return Boolean(await until(async () => {
    const s = await tooltip(page);
    return s && s.name === cards[slot].name && s.art ? true : null;
  }, ms));
}

async function worker(ext) {
  const ours = (t) => t.type() === "service_worker" && t.url().startsWith(`${ext.origin}/`);
  let target = ext.browser.targets().find(ours);
  if (!target) {
    const page = await ext.browser.newPage({ background: true });
    try {
      await page.goto(`${ext.origin}/${PRODUCT.wakePage}`);
      target = await ext.browser.waitForTarget(ours, { timeout: 10_000 });
    } finally {
      await page.close();
    }
  }
  return target.worker();
}
/** Run `fn` in the extension's background worker. A worker that is being replaced or stopped is
 *  found again, up to five tries: an unpacked extension whose files changed is loaded again soon
 *  after the browser starts. */
async function inWorker(ext, fn, arg) {
  let last;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await (await worker(ext)).evaluate(fn, arg);
    } catch (error) {
      last = error;
      log("worker-retry", { error: String(error?.message ?? error) });
      await sleep(700);
    }
  }
  throw last;
}
const runningVersion = (ext) => inWorker(ext, () => chrome.runtime.getManifest().version);
const storageRead = (ext, keys) => inWorker(ext, (k) => chrome.storage.local.get(k), keys);
async function storageWrite(ext, items) {
  await inWorker(ext, (i) => chrome.storage.local.set(i), items);
  await sleep(1000);
}

// ------------------------------------------------------------------ the checks
const results = [];
const check = (id, ok, detail = {}) => {
  results.push({ id, ok, detail });
  log(ok ? "pass" : "FAIL", { id, ...detail });
};
/** The checks the two sessions make below. */
const CHECK_COUNT = 12;
const LAST_GOOD = "settings.lastGood";
let fatal = null;
let finished = false;
const watchdog = setTimeout(() => {
  fatal = `timeout: the run passed its ${RUN_DEADLINE_MS / 60_000}-minute deadline`;
  log("fatal", { error: fatal });
  void Promise.allSettled([...browsers].map((b) => Promise.race([b.close(), sleep(10_000).then(() => b.process()?.kill("SIGKILL"))]))).then(finish);
}, RUN_DEADLINE_MS);

try {
  await session("a", values.a, async (ext) => {
    check("a-is-a", (await runningVersion(ext)) === versionA, { want: versionA });
    const page = await openPage(ext.browser);
    await play(page, 1);
    check("a-frames-at-play", await framesUp(page, 10_000));
    await play(page, 2);
    check("a-art-visible", await hoverShowsArt(page, "B", 60_000));
    // The settings file is read by the background at its start: the last good copy is stored.
    const stored = await until(async () => ((await storageRead(ext, [LAST_GOOD]))[LAST_GOOD] ? true : null), 10_000);
    check("a-settings-stored", Boolean(stored));
    await storageWrite(ext, { [PRODUCT.keys.keepCard]: false, [PRODUCT.keys.enabled]: false });
    await page.bringToFront();
    const gone = await until(async () => ((await extensionFrames(page)).length === 0 ? true : null), 5000);
    check("a-off-removes-frames", Boolean(gone));
    await page.close();
  });

  await session("b", values.b, async (ext) => {
    check("b-is-b", (await runningVersion(ext)) === versionB, { want: versionB });
    const kept = await storageRead(ext, [PRODUCT.keys.enabled, PRODUCT.keys.keepCard, LAST_GOOD]);
    check("b-switches-kept", kept[PRODUCT.keys.enabled] === false && kept[PRODUCT.keys.keepCard] === false, { enabled: kept[PRODUCT.keys.enabled], keepCard: kept[PRODUCT.keys.keepCard] });
    check("b-settings-kept", Boolean(kept[LAST_GOOD]));
    const page = await openPage(ext.browser);
    await play(page, 1);
    await sleep(2500);
    check("b-off-kept", (await extensionFrames(page)).length === 0, { frames: await extensionFrames(page) });
    await storageWrite(ext, { [PRODUCT.keys.enabled]: true });
    await page.bringToFront();
    check("b-frames-at-play", await framesUp(page, 10_000));
    await play(page, 2);
    check("b-art-visible", await hoverShowsArt(page, "B", 60_000));
    const after = await storageRead(ext, [PRODUCT.keys.keepCard]);
    check("b-held-card-choice-kept", after[PRODUCT.keys.keepCard] === false);
    await page.close();
  });
} catch (error) {
  fatal ??= String(error?.stack ?? error);
  log("fatal", { error: fatal });
}
finish();

function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  server.close();
  standIn.server.close();
  let violations = [];
  let exempt = [];
  let hosts = {};
  try {
    const all = [];
    for (const file of netlogs) {
      if (!existsSync(file)) throw new Error(`no NetLog at ${file}: the network scope cannot be checked`);
      const requests = netlogRequests(readFileSync(file, "utf-8"));
      if (!requests.some((r) => r.urls.some((u) => u.startsWith(pageUrl)))) throw new Error(`${file} holds no request to the test page: the NetLog is not trustworthy`);
      all.push(...requests);
    }
    ({ violations, exempt, hosts } = classify(all, { standInHost: cdnHost }));
    if (!(cdnHost in hosts)) throw new Error(`no request reached ${cdnHost} in the NetLogs: the network scope cannot be checked`);
  } catch (error) {
    fatal ??= `network scope: ${error?.message ?? error}`;
    log("fatal", { error: fatal });
  }
  const failed = results.filter((r) => !r.ok);
  const passed = !fatal && failed.length === 0 && results.length === CHECK_COUNT && violations.length === 0 && policyViolations.length === 0;
  const report = { product: PRODUCT.name, passed, fatal, results, violations, exemptChromeOwn: exempt, policyViolations, originMismatches, hosts, a: resolve(values.a), b: resolve(values.b), durationMs: Date.now() - startedAt };
  writeFileSync(join(out, "rollback-report.json"), JSON.stringify(report, null, 2));
  console.log(`\npolicy: ${policyViolations.length} content-security-policy violation(s); network: ${violations.length} violation(s), ${exempt.length} of Chrome's own exempt; hosts ${JSON.stringify(hosts)}`);
  console.log(`${passed ? "PASS" : "FAIL"}: ${results.filter((r) => r.ok).length} of ${results.length} checks (${CHECK_COUNT} expected) in ${((Date.now() - startedAt) / 1000).toFixed(0)} s; report ${join(out, "rollback-report.json")}`);
  process.exit(passed ? 0 : 1);
}
