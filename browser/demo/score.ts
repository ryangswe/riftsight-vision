// SPDX-License-Identifier: Apache-2.0
// The scoring page. It measures this runtime on real video decoding and canvas capture: for
// each labeled frame of a manifest it finds that frame in a video file from the user's disk
// (score/select.ts), analyzes it through the capture path and the worker a session uses
// (score/video.ts), and records what the hover rule shows at each labeled position
// (score/run.ts). The result is a JSON Lines file that `cardvision evaluate hover
// --browser-events` scores with the scorer it uses for its own frames.
//
// A video file holds a whole video, or one section of it: the few seconds that `cardvision
// fetch --download --keep-video` keeps, named `<platform>-<video id>+<start seconds>`. Which file
// serves which row is decided in score/manifest.ts, and a section is read on the video's own
// timeline (score/run.ts).
//
// It is a measuring tool for files on your own disk. It does not attach to any website, and
// it is not the harness that ran the private test described in docs/method.md.
//
// The page makes one kind of request: for the release document and the files it pins. The
// manifests and videos are read in the page and never uploaded.
//
// A run needs the page to be visible: a browser may present no video frame to a hidden page.
// While the page is hidden a run is paused (score/video.ts reads no frame then), and the page
// says so at once, above the run and in its title. The run goes on when the page is visible
// again. A headless browser's page counts as visible.
//
// Before a run the page says how many rows of the chosen role the manifests hold and how many
// of them have a matching video, and Start starts nothing when that is none (score-view.ts).
// When a run ends it shows what the run kept, the events file to download and the command
// that scores it. The panel under "Details" holds the lines the page has always printed.
//
// For a tool that drives the page: `window.cardvisionScore()` starts a run with the inputs
// chosen on the page, or joins the run in progress, and resolves with the lines of the events
// file (an array of strings, the header first). It rejects with the reason when a run cannot
// start. examples/score-headless.mjs is such a tool. The check before a run is for a person
// who presses Start: it does not hold this function back.

import type { ExecutionProvider } from "../src/providers.js";
import { type IndexedVideo, matchVideos, parseManifest, parseVideoIndex, readChosen, rowsOfRole, type ScoreRow } from "../score/manifest.js";
import { eventLines, onVideoTimeline, type RowLine, runHeader, scoreRows, type ScoringVideo, summarize } from "../score/run.js";
import { focusChecked, focusCheckLines, type FocusCheckReport } from "../score/focus-check.js";
import { type Analyzer, createAnalyzer, openVideo } from "../score/video.js";
import { byId, chosenBackend, prefillRelease, servedGeometric, serverConfig, WORKER_URL } from "./page.js";
import { coverage, type Input, type PreRun, preRun, resultView, scoringCommand } from "./score-view.js";

const form = byId<HTMLFormElement>("controls");
const releaseInput = byId<HTMLInputElement>("release-url");
const manifestInput = byId<HTMLInputElement>("manifests");
const videoInput = byId<HTMLInputElement>("videos");
const videoIndexInput = byId<HTMLInputElement>("video-index");
const roleSelect = byId<HTMLSelectElement>("role");
const backendSelect = byId<HTMLSelectElement>("backend");
const startButton = byId<HTMLButtonElement>("start");
const video = byId<HTMLVideoElement>("video");
const panel = byId<HTMLPreElement>("panel");
const notice = byId<HTMLParagraphElement>("notice");
const download = byId<HTMLAnchorElement>("download");
const before = byId<HTMLParagraphElement>("before");
const problemOf: Record<Input, HTMLParagraphElement> = {
  model: byId<HTMLParagraphElement>("model-problem"),
  labels: byId<HTMLParagraphElement>("labels-problem"),
  videos: byId<HTMLParagraphElement>("videos-problem"),
};
const runCard = byId<HTMLElement>("run");
const runTitle = byId<HTMLHeadingElement>("run-title");
const progress = byId<HTMLProgressElement>("progress");
const runLine = byId<HTMLParagraphElement>("run-line");
const runProblem = byId<HTMLParagraphElement>("run-problem");
const resultCard = byId<HTMLElement>("result");
const resultTitle = byId<HTMLHeadingElement>("result-title");
const counts = byId<HTMLDListElement>("counts");
const resultNotes = byId<HTMLDivElement>("result-notes");
const scoreIt = byId<HTMLDivElement>("score-it");
const command = byId<HTMLPreElement>("command");
const copy = byId<HTMLButtonElement>("copy");

let running: Promise<string[]> | null = null;
let downloadUrl: string | null = null;

const TITLE = document.title;
const PAUSED = "Paused: this page is hidden, and a browser may present no video frame to a hidden page. No frame is read until the page is visible again. No row is lost.";

/** Say that the run is paused while the page is hidden and a run is in progress. */
function showPause(): void {
  const paused = running !== null && document.hidden;
  notice.textContent = paused ? PAUSED : "";
  notice.hidden = !paused;
  document.title = paused ? `Paused (page hidden): ${TITLE}` : TITLE;
}
document.addEventListener("visibilitychange", showPause);

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A reason as a sentence: with a full stop, unless it ends in one. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Show a line of words, or hide it when there is nothing to say. Beside an input it is a
 *  problem, or with `todo` something that is still to choose. */
function say(element: HTMLElement, text: string | undefined, todo = false): void {
  element.textContent = text ?? "";
  element.hidden = text === undefined;
  element.classList.toggle("problem", !todo);
  element.classList.toggle("todo", todo);
}

/**
 * Count what a run would read from what is chosen now (score-view.ts). A chosen file that
 * cannot be read as what it should be is reported with the input it was chosen in.
 */
async function inspect(): Promise<PreRun> {
  const manifestFiles = Array.from(manifestInput.files ?? []);
  const videoFiles = Array.from(videoInput.files ?? []);
  const chosen = { release: releaseInput.value.trim(), manifests: manifestFiles.length, videos: videoFiles.length };
  if (manifestFiles.length === 0 || videoFiles.length === 0) return preRun(chosen, null);
  const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  const manifests = [];
  try {
    for (const file of manifestFiles) manifests.push({ name: file.name, rows: parseManifest(await readChosen(file, () => file.text()), file.name) });
  } catch (error) {
    return preRun(chosen, null, { where: "labels", text: `${sentence(reason(error))} Choose label manifests: the .manifest.jsonl files.` });
  }
  try {
    const indexFile = videoIndexInput.files?.[0];
    const indexed: IndexedVideo[] = indexFile ? parseVideoIndex(await readChosen(indexFile, () => indexFile.text()), indexFile.name) : [];
    return preRun(chosen, coverage(manifests, roleSelect.value, videoFiles.map((file) => file.name), indexed));
  } catch (error) {
    // A row given twice is a fault of the manifests; anything else here is one of the video files or their index.
    const where: Input = /is given twice$/.test(reason(error)) ? "labels" : "videos";
    return preRun(chosen, null, { where, text: sentence(reason(error)) });
  }
}

let inspected = 0;
/** Say beside Start what a run would read, and beside each input what is wrong with it. With
 *  `pressed`, also what is not chosen yet. Resolves with the check, or null when a later one
 *  has replaced it. */
async function showCheck(pressed = false): Promise<PreRun | null> {
  const mine = (inspected += 1);
  const check = await inspect();
  if (mine !== inspected) return null;
  for (const where of Object.keys(problemOf) as Input[]) {
    const problem = check.problems[where];
    say(problemOf[where], problem ?? (pressed ? check.missing[where] : undefined), problem === undefined);
  }
  before.textContent = check.summary;
  return check;
}

/** The run card: what the run is doing now, in words and as a bar. */
function showRun(line: string, done = 0, total = 0): void {
  runCard.hidden = false;
  runTitle.textContent = "Running";
  runProblem.hidden = true;
  runLine.textContent = line;
  // An empty bar until the rows are counted: it never moves by itself.
  progress.max = Math.max(total, 1);
  progress.value = done;
}

/** The result card: what the run kept, the events file, and the command that scores it.
 *  `role` is the role the run read, which the command must name to score the same rows. */
function showResult(lines: readonly RowLine[], manifestNames: readonly string[], releaseUrl: string, role: string): void {
  const result = resultView(summarize(lines));
  runCard.hidden = true;
  resultCard.hidden = false;
  resultCard.dataset.result = result.usable ? "ready" : "empty";
  resultTitle.textContent = result.title;
  counts.replaceChildren(...result.counts.map((count) => {
    const item = document.createElement("div");
    const label = document.createElement("dt");
    const rows = document.createElement("dd");
    label.textContent = count.label;
    rows.textContent = String(count.rows);
    item.append(label, rows);
    return item;
  }));
  resultNotes.replaceChildren(...result.notes.map((note) => {
    const line = document.createElement("p");
    line.textContent = note;
    return line;
  }));
  download.textContent = result.download;
  download.classList.toggle("primary", result.usable);
  scoreIt.hidden = !result.usable;
  command.replaceChildren(...scoringCommand(manifestNames, releaseUrl, role).map((part) => {
    if (!part.placeholder) return document.createTextNode(part.text);
    const mark = document.createElement("em");
    mark.className = "placeholder";
    mark.title = "A placeholder: replace it with the folder on your disk";
    mark.textContent = part.text;
    return mark;
  }));
  copy.textContent = "Copy";
  resultCard.scrollIntoView({ block: "nearest" });
}

function summaryLines(lines: readonly RowLine[], total: number): string[] {
  const s = summarize(lines);
  const distances = Object.entries(s.distances).sort(([a], [b]) => Number(a) - Number(b));
  return [
    `rows done: ${s.rows} of ${total}`,
    `  kept ${s.kept}, unreachable ${s.unreachable}, no video ${s.noVideo}, another shape ${s.frameShape}, failed ${s.failed}`,
    `positions answered: ${s.positions}; a card shown at ${s.shown}`,
    `fingerprint distance of the kept rows: ${distances.length === 0 ? "none yet" : distances.map(([bits, rows]) => `${plural(Number(bits), "bit")} on ${plural(rows, "row")}`).join(", ")}`,
  ];
}

async function run(): Promise<string[]> {
  const releaseUrl = releaseInput.value.trim();
  const manifestFiles = Array.from(manifestInput.files ?? []);
  const videoFiles = Array.from(videoInput.files ?? []);
  if (releaseUrl === "" || manifestFiles.length === 0 || videoFiles.length === 0) {
    throw new Error("Give the URL of a release document, and choose one or more manifest files and their video files.");
  }
  const role = roleSelect.value;
  const asked: ExecutionProvider | null = chosenBackend(backendSelect);
  download.hidden = true;
  resultCard.hidden = true;
  showRun("Reading the manifests…");

  const manifests = [];
  for (const file of manifestFiles) {
    const text = await readChosen(file, () => file.text());
    manifests.push({ name: file.name, sha256: await readChosen(file, () => sha256(file)), rows: parseManifest(text, file.name) });
  }
  const rows = rowsOfRole(manifests, role);
  // The index of kept video files is optional: without it a section is known by its name alone.
  const indexFile = videoIndexInput.files?.[0];
  const indexed: IndexedVideo[] = indexFile ? parseVideoIndex(await readChosen(indexFile, () => indexFile.text()), indexFile.name) : [];
  const { fileOf, startOf, unused } = matchVideos(rows, videoFiles.map((file) => file.name), indexed);
  /** The file that serves each row, and where that file starts in the video (null: a whole video). */
  const fileOfRow = new Map<ScoreRow, { file: File; start: number | null }>(
    rows.flatMap((row, index) => (fileOf[index] === null ? [] : [[row, { file: videoFiles[fileOf[index]!]!, start: startOf[index]! }]])),
  );
  const filesUsed = new Set([...fileOfRow.values()].map((served) => served.file));
  const sectionsUsed = new Set([...fileOfRow.values()].filter((served) => served.start !== null).map((served) => served.file));
  const head = [
    `role: ${role}; ${plural(rows.length, "row")} in ${plural(manifests.length, "manifest")}`,
    `videos: ${plural(filesUsed.size, "file")} used` +
      (sectionsUsed.size > 0 ? ` (${plural(sectionsUsed.size, "section")})` : "") +
      `, ${plural(rows.length - fileOfRow.size, "row")} without a video` +
      (unused.length > 0 ? `; not used: ${unused.join(", ")}` : ""),
  ];
  panel.textContent = [...head, "loading the release"].join("\n");
  showRun("Loading the model…");

  let analyzer: Analyzer | null = null;
  // The video file now open in the element: rows of one video follow each other in a manifest,
  // so a file is opened once. `seen` is what a run reads: the file itself for a whole video, the
  // file on the video's timeline for a section.
  const open: { file: File | null; video: (ScoringVideo & { close(): void }) | null; seen: ScoringVideo | null } = { file: null, video: null, seen: null };
  try {
    // With a geometric stage offered by the server, the run waits for it and refuses to score
    // without it: a run asked to measure the stage never measures the embedding alone.
    const geometricPath = servedGeometric(await serverConfig());
    analyzer = await createAnalyzer({
      releaseUrl,
      workerUrl: new URL(WORKER_URL, location.href),
      ...(asked === null ? {} : { providers: [asked] }),
      ...(geometricPath === null ? {} : { geometricUrl: new URL(geometricPath, location.href) }),
    });
    const created = analyzer;
    // Development only: `?focusCheck` also analyzes each face in focus scope and compares.
    const checking = new URLSearchParams(location.search).has("focusCheck");
    const focusReport: FocusCheckReport = { frames: 0, faces: 0, differing: 0, details: [] };
    const loaded = checking ? focusChecked(created, focusReport) : created;
    const release = loaded.release;
    const stage = geometricPath === null ? null : await loaded.geometricSettled();
    if (stage !== null && stage.state !== "ready") throw new Error(`the geometric stage did not start: ${stage.reason ?? "no reason given"}`);
    const geometric = stage === null || geometricPath === null ? undefined : { settings: geometricPath, ...stage };
    if (geometric) head.unshift(`geometric stage: ${geometric.settings}, ready (${((geometric.bytes ?? 0) / 1e6).toFixed(1)} MB index)`);
    const backend = { detector: release.detector.ep, recognizer: release.recognizer.ep };
    head.unshift(
      `release: ${release.id} (${release.game}, ${release.bankCards} cards in the bank)`,
      `backend: detector on ${backend.detector}, recognizer on ${backend.recognizer}`,
    );
    const done: RowLine[] = [];
    const lines = await scoreRows({
      rows,
      backend,
      videoOf: async (row) => {
        const served = fileOfRow.get(row) ?? null;
        if (served === null) return null;
        if (served.file !== open.file) {
          open.video?.close();
          open.video = null;
          open.file = null;
          open.seen = null;
          open.video = await openVideo(video, served.file, loaded);
          open.seen = served.start === null ? open.video : onVideoTimeline(open.video, served.start);
          open.file = served.file;
        }
        return open.seen;
      },
      onRow: (line, _count, total) => {
        done.push(line);
        const last = `last row: ${line.platform} ${line.video_id} t=${line.t}: ${line.status}${line.reason ? ` (${line.reason})` : ""}`;
        panel.textContent = [...head, last, ...summaryLines(done, total)].join("\n");
        showRun(`Row ${done.length} of ${total} done. The last one: ${line.platform} ${line.video_id} at ${line.t} s, ${line.status}.`, done.length, total);
      },
    });
    const header = runHeader(release, {
      userAgent: navigator.userAgent,
      asked: asked ?? "release",
      role,
      manifests: manifests.map((manifest) => ({ file: manifest.name, sha256: manifest.sha256, rows: manifest.rows.length })),
      ...(geometric ? { geometric } : {}),
    });
    if (checking) {
      (window as unknown as { cardvisionFocusCheck?: FocusCheckReport }).cardvisionFocusCheck = focusReport;
      head.push(...focusCheckLines(focusReport));
      console.log("cardvision focus check", JSON.stringify(focusReport));
    }
    const text = eventLines(header, lines);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([text.join("\n") + "\n"], { type: "application/x-ndjson" }));
    download.href = downloadUrl;
    download.hidden = false;
    panel.textContent = [...head, "done", ...summaryLines(lines, rows.length)].join("\n");
    showResult(lines, manifests.map((manifest) => manifest.name), releaseUrl, role);
    return text;
  } finally {
    open.video?.close();
    analyzer?.stop();
  }
}

/** Start a run with the page's inputs, or join the one in progress. */
function cardvisionScore(): Promise<string[]> {
  if (running === null) {
    startButton.disabled = true;
    running = run().finally(() => {
      running = null;
      startButton.disabled = false;
      showPause();
    });
    showPause();
    running.catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      const stopped = `The run stopped: ${reason}`;
      panel.textContent = stopped;
      // A model that did not load is also said beside the model's address, where it is put right.
      const model = /^the release could not be loaded: (.*)$/s.exec(reason);
      if (model) say(problemOf.model, `Could not load the model at ${releaseInput.value.trim()} (${model[1]}). Check the address, then press Start.`);
      // The reason stays on the page, in the run's own card, with the bar at rest.
      runCard.hidden = false;
      runTitle.textContent = "Stopped";
      runLine.textContent = "";
      progress.value = 0;
      say(runProblem, sentence(stopped));
    });
  }
  return running;
}

(window as unknown as { cardvisionScore: typeof cardvisionScore }).cardvisionScore = cardvisionScore;
form.addEventListener("submit", (event) => {
  event.preventDefault();
  // A person's run starts only when there is something to score: see the top of this file.
  void showCheck(true).then((check) => {
    if (check?.start) void cardvisionScore().catch(() => undefined);
  });
});
for (const input of [releaseInput, manifestInput, videoInput, videoIndexInput, roleSelect]) input.addEventListener("change", () => void showCheck());
copy.addEventListener("click", () => {
  const text = command.textContent ?? "";
  // Without the clipboard, the command is selected so that it can be copied by hand.
  navigator.clipboard.writeText(text).then(
    () => { copy.textContent = "Copied"; },
    () => { getSelection()?.selectAllChildren(command); copy.textContent = "Selected: copy it by hand"; },
  );
});
void prefillRelease(releaseInput).then(() => showCheck());
