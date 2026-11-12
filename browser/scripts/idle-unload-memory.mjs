// SPDX-License-Identifier: Apache-2.0
// What an idle unload gives back: a compute frame (built dist/compute-session.js) hosts the real
// worker on a release in a headless Chrome. The page's renderer and GPU process memory is read
// (resident set size, `ps`) for the same page with no frame, with a ready frame, after the frame
// unloaded when idle, and after an `intent` loaded it again; the time from the intent to the
// status `ready` is reported too.
//
//   npm run build && node scripts/idle-unload-memory.mjs --release FOLDER [--chrome PATH]
//                         [--idle-ms 15000] [--settle-ms 4000] [--gc 1] [--late-ms 30000] [--removed 1] [--out REPORT.json]
//                         [--geometric PATH [--geometric-load start|pointer] --gpu 1]
//
// `--removed 1` adds a phase that removes the frame's iframe and reads again, to tell memory the
// frame held from memory the allocator keeps. `--late-ms` is the wait after the pressure notification.
//
// `--geometric PATH` loads the geometric stage too: PATH is its settings document, relative to the
// release folder (`geometric/settings.json`). The stage needs WebGPU, so pass `--gpu 1` with it:
// Chrome then starts with WebGPU instead of `--disable-gpu` (without it the stage reports itself
// off). `--geometric-load pointer` passes `geometricLoad: "pointer"`, sends one `pointer` and a
// `leave` after each `ready` (the stage then loads after the pointer), and refuses the pictures the
// frame asks for, as a content script does once the pointer has left. With the default `start` no
// pointer is sent. With `--geometric`, each ready phase is read once the stage has settled: its
// newest status is `ready`, or `off` for a reason other than `idle-unload` (that one is left over
// from the unload, and a resume does not clear it); with `pointer`, a status reported after the
// pointer was sent. The report gives the stage's status at each phase and every status it
// reported (`stage`: when the phase starts and after its read; `stageLog`, with the `pointer` and
// `intent` messages the frame got, on the same clock). Without these options nothing changes.
//
// The ready reads (`ready`, `reloaded`) must be taken on a ready frame, so the unload must not come
// first. Each read waits `--settle-ms` and then reads for about 1.5 s, so `--idle-ms` must be at
// least `--settle-ms` plus 1.5 s plus a 3 s margin (`MIN_IDLE_MARGIN_MS`), or the script refuses
// to start (exit 2). Both ready reads are also checked when they start and when they end: the
// last status is `ready` and the worker target is there. A ready read that fails the check ends
// the run with exit 2 and no figures: a read taken after the unload never counts. A stage that is
// slow to load uses up that margin; raise `--idle-ms` then.
//
// Chrome is driven with puppeteer-core, as in user-wait.mjs (PUPPETEER_CORE_DIR, or installed in
// this folder). Chrome is started by this script and only its own process tree is measured and
// ended. The page is served from 127.0.0.1 and nothing else is requested. Numbers from a toy
// release are not a measure of accuracy; they show what ending the worker gives back for the
// models in that release.
//
// The toy release shows the drop. On an arm64 Mac with Chrome for Testing 152, `node
// scripts/idle-unload-memory.mjs --release FOLDER --chrome PATH` on the toy release, with the
// other options at their defaults, read a ready frame at 105 MB of footprint over the page with no
// frame, and 16 MB right after the unload. A real release holds larger models, so it has more to
// free. The report prints `readyMinusNoFrameFootprintMb` beside the pass figure to show how much
// there was to free.
//
// The pass is one metric, named in advance: the physical footprint right after the unload, within
// 30 MB of the same page with no frame. The footprint after a memory-pressure purge and a wait
// (the no-frame page gets the same purge and wait) is reported beside it, and the resident sizes
// are reported, not judged. Exit code 0 when the headline passes, 1 when not, 2 on an error.
//
// Two figures are read, both from this Chrome's own renderer and GPU processes: the resident
// size (`ps`) and, on macOS, the physical footprint (`footprint`). "Memory" below is the sum of the resident sizes of the renderer and GPU processes in Chrome's own
// process tree, in MB. A resident size can lag a release of memory, so each phase waits
// `--settle-ms` and takes the median of five reads (`--gc 1` collects the page's garbage first).

import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inside, TYPES } from "./demo-paths.mjs";

const args = process.argv.slice(2);
const given = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.replace(/^--/, "");
  if (!key || args[i + 1] === undefined) {
    console.error("Usage: node scripts/idle-unload-memory.mjs --release FOLDER [--chrome PATH] [--idle-ms N] [--settle-ms N] [--out FILE] [--geometric PATH [--geometric-load start|pointer] --gpu 1]");
    process.exit(2);
  }
  given[key] = args[i + 1];
}
const chrome = given.chrome ?? process.env.CHROME;
if (!given.release || !chrome) {
  console.error("Needs --release FOLDER and a Chrome (--chrome PATH or CHROME=PATH).");
  process.exit(2);
}
const GEOMETRIC = given.geometric ?? null;
if (
  GEOMETRIC !== null &&
  (GEOMETRIC.startsWith("/") ||
    GEOMETRIC.includes("%") ||
    GEOMETRIC.split(/[\\/]/).includes("..") ||
    !new URL("/release/" + GEOMETRIC, "http://127.0.0.1").pathname.startsWith("/release/") ||
    !inside(resolve(given.release), GEOMETRIC))
) {
  console.error("--geometric must be a path inside the release folder, relative to it.");
  process.exit(2);
}
const GEOMETRIC_LOAD = given["geometric-load"] ?? "start";
if (GEOMETRIC_LOAD !== "start" && GEOMETRIC_LOAD !== "pointer") {
  console.error("--geometric-load must be start or pointer.");
  process.exit(2);
}
if (given["geometric-load"] !== undefined && GEOMETRIC === null) {
  console.error("--geometric-load needs --geometric.");
  process.exit(2);
}
if (given.gpu !== undefined && given.gpu !== "0" && given.gpu !== "1") {
  console.error("--gpu must be 0 or 1.");
  process.exit(2);
}
const POINTER = GEOMETRIC_LOAD === "pointer";
const IDLE_MS = Number(given["idle-ms"] ?? 15_000);
const SETTLE_MS = Number(given["settle-ms"] ?? 4000);
/** How long a read takes after its settle wait (five reads, 300 ms apart), and the margin a ready
 *  read keeps before the unload may come. */
const READ_MS = 1500;
const MIN_IDLE_MARGIN_MS = 3000;
if (!(SETTLE_MS >= 0) || !(IDLE_MS >= SETTLE_MS + READ_MS + MIN_IDLE_MARGIN_MS)) {
  console.error(`--idle-ms must be at least --settle-ms + ${READ_MS + MIN_IDLE_MARGIN_MS} (${SETTLE_MS + READ_MS + MIN_IDLE_MARGIN_MS}), so that a ready read ends before the unload.`);
  process.exit(2);
}
const LATE_MS = Number(given["late-ms"] ?? 30_000);
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
if (!existsSync(join(dist, "compute-session.js"))) {
  console.error("dist/ is missing: run `npm run build` first");
  process.exit(2);
}

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

const PARENT = `<!doctype html><meta charset="utf-8"><title>parent</title><script>
window.log = [];
window.addEventListener("message", (e) => { if (e.data && e.data.probe === 1 && e.data.kind === "status") window.log.push({ state: e.data.state, error: e.data.error, at: performance.now() }); });
window.addFrame = () => { const f = document.createElement("iframe"); f.src = "/frame.html"; f.hidden = true; document.body.append(f); window.frameEl = f; };
window.say = (message) => window.frameEl.contentWindow.postMessage({ probe: 1, ...message }, location.origin);${
  POINTER
    ? `
// As a content script does once the pointer has left: every picture the frame asks for is refused.
window.addEventListener("message", (e) => { if (e.data && e.data.probe === 1 && e.data.kind === "capture") window.say({ kind: "capture-failed", requestId: e.data.requestId, reason: "not-pointing" }); });`
    : ""
}
</script>`;

const FRAME = `<!doctype html><meta charset="utf-8"><script type="module">
window.stageLog = [];
// The pointer and intent messages the frame gets, on the same clock as the stage's statuses.
window.addEventListener("message", (e) => { if (e.data && e.data.probe === 1 && (e.data.kind === "pointer" || e.data.kind === "intent")) window.stageLog.push({ message: e.data.kind, at: performance.now() }); });
import { computeProtocol, DRIVER_TICK_MS, startComputeFrame } from "/lib/compute-session.js";
const frame = startComputeFrame({
  win: window,
  framed: window.parent !== window,
  parentOrigin: location.ancestorOrigins[0] ?? null,
  allowedParentOrigin: (origin) => origin === location.origin,
  protocol: computeProtocol("probe"),
  createWorker: () => new Worker("/lib/worker.js", { type: "module" }),
  loadRequest: { kind: "load", releaseUrl: location.origin + "/release/release.json", wasmPaths: location.origin + "/lib/"${
    GEOMETRIC !== null ? `, geometricUrl: location.origin + "/release/" + ${JSON.stringify(GEOMETRIC)}` : ""
  } },
  now: () => performance.now(),
  idleUnloadMs: ${IDLE_MS},${POINTER ? `
  geometricLoad: "pointer",` : ""}
  onGeometricStatus: (s) => window.stageLog.push({ state: s.state, reason: s.reason, bytes: s.bytes, at: performance.now() }),
});
window.stage = () => frame.core?.status().geometric ?? null;
setInterval(() => frame.tick(), DRIVER_TICK_MS);
</script>`;

const server = createServer((request, response) => {
  let path = "/";
  try {
    path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    // keep "/"
  }
  if (request.method !== "GET") return response.writeHead(405).end();
  const text = (type, body) => response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
  if (path === "/favicon.ico") return response.writeHead(204).end();
  if (path === "/") return text(TYPES[".html"], PARENT);
  if (path === "/frame.html") return text(TYPES[".html"], FRAME);
  let file = null;
  if (path.startsWith("/release/")) file = inside(resolve(given.release), path.slice("/release/".length));
  else if (path.startsWith("/lib/")) file = inside(dist, path.slice("/lib/".length));
  if (!file || !existsSync(file) || !statSync(file).isFile()) return response.writeHead(404).end("not found\n");
  // With its size: a body sent without one (chunked) sometimes never finished reaching a worker
  // in headless Chrome, and the release load waited until the run timed out.
  response.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store", "content-length": statSync(file).size });
  createReadStream(file).pipe(response);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

/** Resident MB of the renderer and GPU processes among `rootPid` and its descendants. */
function memoryMb(rootPid) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf-8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), kb: Number(m[3]), command: m[4] }));
  const tree = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) (tree.add(r.pid), (grew = true));
  }
  let renderer = 0;
  let gpu = 0;
  let footprint = 0;
  for (const r of rows) {
    if (!tree.has(r.pid)) continue;
    const isRenderer = r.command.includes("--type=renderer");
    const isGpu = r.command.includes("--type=gpu-process");
    if (isRenderer) renderer += r.kb;
    else if (isGpu) gpu += r.kb;
    if (isRenderer || isGpu) footprint += footprintMb(r.pid);
  }
  return { renderer: renderer / 1024, gpu: gpu / 1024, total: (renderer + gpu) / 1024, footprint };
}

/** macOS physical footprint (what Activity Monitor calls Memory) of one process, in MB; 0 when
 *  the tool is missing or refuses. It counts memory the system has compressed, and not memory
 *  freed but still resident, which the resident size does. */
function footprintMb(pid) {
  try {
    const out = execFileSync("footprint", ["-p", String(pid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/Footprint:\s+([\d.]+)\s+(KB|MB|GB|B)\b/);
    if (!m) return 0;
    return Number(m[1]) * { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]];
  } catch {
    return 0;
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let collect = async () => {};
async function read(pid) {
  await sleep(SETTLE_MS);
  await collect();
  const reads = [];
  for (let k = 0; k < 5; k++) {
    reads.push(memoryMb(pid));
    await sleep(300);
  }
  const round = (v) => Math.round(v * 10) / 10;
  return { renderer: round(median(reads.map((r) => r.renderer))), gpu: round(median(reads.map((r) => r.gpu))), total: round(median(reads.map((r) => r.total))), footprint: round(median(reads.map((r) => r.footprint))) };
}

const mb = (a, b) => Math.round((a - b) * 10) / 10;

/** A fresh Chrome of ours with a fresh profile, the page open; `run` gets what it needs, and the
 *  browser is closed (and, if it will not close, killed by its own pid) afterwards. */
async function withChrome(run) {
  const profileDir = mkdtempSync(join(tmpdir(), "idle-unload-"));
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: profileDir,
    args: [given.gpu === "1" ? "--enable-unsafe-webgpu" : "--disable-gpu", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  const pid = browser.process().pid;
  try {
    const browserCdp = await browser.target().createCDPSession();
    const tab = await browser.newPage();
    if (given.gc === "1") {
      const cdp = await tab.createCDPSession();
      collect = () => cdp.send("HeapProfiler.collectGarbage").catch(() => {});
    }
    tab.on("pageerror", (error) => console.error(`[page] ${error.message}`));
    await tab.goto(`${origin}/`);
    return await run({ browser, pid, browserCdp, tab });
  } finally {
    await browser.close().catch(() => {});
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(profileDir, { recursive: true, force: true });
  }
}
const purge = async (browserCdp) => {
  await browserCdp.send("Memory.simulatePressureNotification", { level: "critical" });
  await sleep(LATE_MS);
};

let code = 0;
try {
  // Run 1: the same page with no frame, read right away, then after the same pressure
  // notification and wait as the frame's reading after the purge. Run 2: the frame.
  const baseline = await withChrome(async ({ pid, browserCdp }) => {
    const right = await read(pid);
    await purge(browserCdp);
    return { right, purged: await read(pid) };
  });
  const run = await withChrome(async ({ browser, pid, browserCdp, tab }) => {
    const states = () => tab.evaluate(() => window.log.map((l) => l.state));
    const waitState = async (state, count, limit = 60_000) => {
      const began = Date.now();
      while ((await states()).filter((s) => s === state).length < count) {
        if (Date.now() - began > limit) throw new Error(`no status ${state} (#${count}) in ${limit} ms; saw ${JSON.stringify(await tab.evaluate(() => window.log))}`);
        await sleep(50);
      }
    };
    const targets = async () => (await browserCdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "worker" || t.type === "service_worker" || t.type === "shared_worker").length;
    const phases = {};
    // The stage's status in the frame (same origin): null when none was asked for.
    const stage = () => tab.evaluate(() => window.frameEl.contentWindow.stage?.() ?? null);
    const stageAt = {};
    /** A ready read counts only on a frame still ready, worker running, when it starts and ends. */
    const checkReady = async (name, when) => {
      const last = (await states()).at(-1);
      const workers = await targets();
      if (last !== "ready" || workers < 1) {
        throw new Error(`the ${name} read was not on a ready frame ${when} (status ${last}, worker targets ${workers}); it does not count. Raise --idle-ms.`);
      }
    };
    /** Read a phase, with the stage's status when the phase starts and after its read. */
    const phase = async (name, ready = false) => {
      if (ready) await checkReady(name, "when it started");
      const atStart = await stage();
      phases[name] = await read(pid);
      stageAt[name] = { atStart, afterRead: await stage() };
      if (ready) await checkReady(name, "when it ended");
    };
    /** With "pointer", one pointer over the picture and a leave; then, with a stage, wait until it
     *  is ready or off (or the frame went idle first, which the ready read's check then refuses). */
    const afterReady = async () => {
      // The stage's log before the pointer: with "pointer", only a status reported after it counts.
      const mark = await tab.evaluate(() => window.frameEl.contentWindow.stageLog.length);
      if (POINTER) await tab.evaluate(() => (window.say({ kind: "pointer", x: 0.5, y: 0.5, mediaTime: 0, touch: false }), window.say({ kind: "leave" })));
      if (GEOMETRIC === null) return;
      const began = Date.now();
      for (;;) {
        const log = await tab.evaluate(() => window.frameEl.contentWindow.stageLog);
        const at = log.findLastIndex((l) => l.state !== undefined);
        const s = at < 0 ? null : log[at];
        // `off` for the session (no WebGPU, a failed load, the watchdog) stays as it was: settled.
        const offForGood = s !== null && s.state === "off" && s.reason !== "idle-unload";
        if (offForGood || (s !== null && s.state === "ready" && (!POINTER || at >= mark))) return;
        // An unload first: the ready read's check refuses the run.
        if ((await states()).at(-1) === "idle") return;
        if (Date.now() - began > 180_000) throw new Error(`the stage did not settle in 180 s: ${JSON.stringify(s)}`);
        await sleep(100);
      }
    };
    await tab.evaluate(() => window.addFrame());
    await waitState("ready", 1);
    const workersWhileReady = await targets();
    await afterReady();
    await phase("ready", true);
    // Idle: the frame ends its worker after IDLE_MS with no pointer.
    await waitState("idle", 1);
    // Right after the unload (the settle wait only), then after a critical memory-pressure
    // notification and a wait: macOS hands freed memory back lazily.
    await phase("idleRightAfter");
    const workersAfterUnload = await targets();
    await purge(browserCdp);
    await phase("idle");
    // An intent loads it again; the time to ready is the page's clock from the message to the status.
    const sentAt = await tab.evaluate(() => {
      const at = performance.now();
      window.say({ kind: "intent" });
      return at;
    });
    await waitState("ready", 2);
    const readyAt = await tab.evaluate(() => window.log.filter((l) => l.state === "ready")[1].at);
    await afterReady();
    await phase("reloaded", true);
    const stageLog = await tab.evaluate(() => window.frameEl.contentWindow.stageLog.map((l) => ({ ...l, at: Math.round(l.at) })));
    if (given.removed === "1") {
      await tab.evaluate(() => window.frameEl.remove());
      phases.frameRemoved = await read(pid);
    }
    return { phases, workersWhileReady, workersAfterUnload, reloadMs: Math.round(readyAt - sentAt), statuses: await states(), version: await browser.version(), stageAt, stageLog };
  });
  const phases = { noFrame: baseline.right, noFramePurged: baseline.purged, ...run.phases };
  const headline = mb(phases.idleRightAfter.footprint, phases.noFrame.footprint);
  const purged = mb(phases.idle.footprint, phases.noFramePurged.footprint);
  const report = {
    chrome: run.version,
    idleUnloadMs: IDLE_MS,
    settleMs: SETTLE_MS,
    statuses: run.statuses,
    // Both ready reads were checked on a ready frame with its worker, when they started and ended.
    readyReadsChecked: true,
    ...(GEOMETRIC !== null ? { geometric: GEOMETRIC, geometricLoad: GEOMETRIC_LOAD, stage: run.stageAt, stageLog: run.stageLog } : {}),
    workerTargets: { whileReady: run.workersWhileReady, afterUnload: run.workersAfterUnload },
    pressureThenWaitMs: LATE_MS,
    memoryMb: phases,
    // The pass is decided on one metric, named before the run: the physical footprint right
    // after the unload against the no-frame page, at most 30 MB. The footprint after the pressure
    // purge and wait, against the no-frame page given the same purge and wait (in its own Chrome),
    // is reported with it. The resident sizes are reported, never judged: macOS releases them lazily.
    headlineFootprintRightAfterMinusNoFrameMb: headline,
    footprintAfterPurgeMinusNoFramePurgedMb: purged,
    readyMinusNoFrameFootprintMb: mb(phases.ready.footprint, phases.noFrame.footprint),
    residentRightAfterMinusNoFrameMb: mb(phases.idleRightAfter.total, phases.noFrame.total),
    residentAfterPurgeMinusNoFramePurgedMb: mb(phases.idle.total, phases.noFramePurged.total),
    // How much there was to free: a pass is meaningful only when this is well above 30.
    passFigureMb: headline,
    readyMinusNoFrameMb: mb(phases.ready.footprint, phases.noFrame.footprint),
    passed: headline <= 30 && phases.noFrame.footprint > 0,
    reloadToReadyMs: run.reloadMs,
    note: "renderer and GPU processes of each Chrome's own tree: macOS physical footprint (footprint) and resident size (ps), median of five reads after a settle wait. The no-frame page is read in its own Chrome run.",
  };
  console.log(JSON.stringify(report, null, 2));
  if (given.out) writeFileSync(given.out, JSON.stringify(report, null, 2) + "\n");
  if (!report.passed) code = 1;
} catch (error) {
  console.error(String(error?.stack ?? error));
  code = 2;
} finally {
  server.close();
}
process.exit(code);
