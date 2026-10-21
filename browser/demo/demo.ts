// SPDX-License-Identifier: Apache-2.0
// The demo page. It shows a video or an image from the user's disk, runs a session on it, and
// draws what the session reports for the pointer: the box of the card under it and a tooltip
// with the card's name.
//
// It is a way to look at the pipeline, not a product: it does not attach to any website, and
// it shows only what the pipeline would display on the file it was given.
//
// There is no Start button. The stage is the drop zone, and choosing or dropping a file starts:
// the page shows the file, loads the model if it has not, and says in words what it is doing.
// What it says is decided in view.ts from two things it keeps apart, the state of the model and
// the state of the file, so that "Ready" is said only when a model has loaded and the file
// decoded to a picture. This file does the rest: it holds the session, moves the file into
// the page, and writes what view.ts decided.
//
// Details shows what the session reports as a diagnostics view, decided in details.ts and
// written by details-dom.ts. The text panel at its end (the element `panel`, under Raw text) is
// written from `panelLines` as it always was, open or closed: scripts read it, and Copy
// diagnostics copies it.
//
// A session is given one file. Another file, another model address, another backend or
// another schedule each start a new session, so nothing of the one before is left on screen.
// A session that has been given no file yet takes the next one: the page starts such a session
// when it opens, to load the model before any file is chosen.
//
// The page makes three kinds of request and no other: for the release document and the files it
// pins (none when the release is a folder chosen on this computer, below); for the image of the card under the pointer, only if a base for card images is set (it
// is set to the local server's own image folder when the server has one); and, only if the
// page's address names it, for the one file the local server was started with. It keeps
// nothing and sends nothing.
//
// The same page is also built as a static site (scripts/pages.mjs, the hosted demo). A meta
// element then gives it its release address, and it is in hosted mode: it asks no server what
// it offers and follows nothing in its own address, it shows no card images, its release address
// cannot be changed, and its worker is started so that it runs under the page's
// Content-Security-Policy (`hostedWorkerScript` in page.ts). Its only requests are then for the
// release, and for its own scripts and ONNX Runtime's files.
//
// A hosted build can instead offer a choice of games (a game picker: `GAMES_META` in page.ts,
// HOSTED_GAMES in scripts/pages.mjs). The page then loads the release of the game chosen; choosing
// another stops the session of the one before, with its worker and its models, and puts the file
// on show away. A game bundled with the site may show its card images, from the site, and offer
// example files that a button opens from the site, as if they had been chosen. A game whose
// release is elsewhere is names only.
//
// The file comes from the file chooser, from a drop, or from the page's address. A program
// that drives a browser cannot use a file chooser, so the local server can be started with
// `--file PATH`: it serves that one file and prints an address, `/?file=/file/NAME`, and the page
// at that address opens the file as if it had been chosen. The address can name that file and
// the server's own image folder, and nothing else (`addressRequest` in page.ts).
//
// A release can also be a folder on this computer, chosen with a folder button: the hosted page's
// "Your game" choice (a game with `local` in the picker) and the local server's page offer it. The
// page finds the release document in the files chosen and hands the worker that document and the
// files it pins, as they are; the worker checks each against the size and SHA-256 the document
// pins, as it does a fetched one, and fetches nothing. Card images come from an `images/` or
// `art/` folder beside the release, or from a second folder button, and are shown from blob: URLs
// made for them, which are revoked when the images or the game change. No address is typed for
// either, and nothing is uploaded.

import { sourceSize } from "../src/capture.js";
import { type FrameAnalysis, hoverAt } from "../src/pipeline.js";
import { createSession, pictureBox, type Session, type Shown } from "../src/session.js";
import { boxAtPoint, type DetailsFile, detailsView, type DetailsView, SPARK_FRAMES } from "./details.js";
import { renderDetails } from "./details-dom.js";
import {
  addressRequest, byId, chosenBackend, findReleaseDocument, type Game, artUrls, gameArtUrls, hostedRelease, imagesForAddress, imagesForRelease, imagesFrom, latestRequest, hostedWorkerScript,
  localArt, type LocalImages, type PickedFile, pickedFiles, RELEASE_DOCUMENT, releaseFilesFrom, SERVED_IMAGES_BASE, SERVED_RELEASE_URL, serverConfig, WORKER_URL,
} from "./page.js";
import { demoView, gameSource, HOSTED, hostedNote, isVideoType, MARK, type MediaState, modelOf, type ModelState, NO_FACTS, type PanelFrame, panelLines, type RunFacts } from "./view.js";

/** Whether this page is a hosted build, and its release address: null for the local server's page. */
const hosted = hostedRelease(document);

const page = byId<HTMLElement>("page");
const stage = byId<HTMLElement>("stage");
const dropzone = byId<HTMLDivElement>("dropzone");
const fileInput = byId<HTMLInputElement>("file");
const chooseLabel = byId<HTMLLabelElement>("choose");
const openingLine = byId<HTMLParagraphElement>("opening");
const fileProblem = byId<HTMLParagraphElement>("file-problem");
const addressProblem = byId<HTMLParagraphElement>("address-problem");
const picture = byId<HTMLDivElement>("picture");
const video = byId<HTMLVideoElement>("video");
const image = byId<HTMLImageElement>("image");
const outlines = byId<HTMLCanvasElement>("outlines");
const hint = byId<HTMLParagraphElement>("hint");
const box = byId<HTMLDivElement>("box");
const tooltip = byId<HTMLDivElement>("tooltip");
const tooltipArt = byId<HTMLImageElement>("tooltip-art");
const tooltipName = byId<HTMLDivElement>("tooltip-name");
const tooltipId = byId<HTMLDivElement>("tooltip-id");
const fileBar = byId<HTMLDivElement>("file-bar");
const fileName = byId<HTMLSpanElement>("file-name");
const fileNote = byId<HTMLSpanElement>("file-note");
const changeFile = byId<HTMLButtonElement>("change-file");
const allBoxes = byId<HTMLInputElement>("all-boxes");
const modelBlock = byId<HTMLElement>("model");
const modelIntro = byId<HTMLDivElement>("model-intro");
const modelIntroTitle = byId<HTMLHeadingElement>("model-intro-title");
const modelIntroText = byId<HTMLParagraphElement>("model-intro-text");
const hostedLine = byId<HTMLParagraphElement>("hosted-note");
const imageLabel = byId<HTMLLabelElement>("image-label");
const imageField = byId<HTMLDivElement>("image-field");
const modelLine = byId<HTMLParagraphElement>("model-line");
const modelText = byId<HTMLSpanElement>("model-text");
const changeModel = byId<HTMLButtonElement>("change-model");
const modelProblem = byId<HTMLParagraphElement>("model-problem");
const modelForm = byId<HTMLFormElement>("model-form");
const releaseInput = byId<HTMLInputElement>("release-url");
const loadModel = byId<HTMLButtonElement>("load-model");
const modelCommand = byId<HTMLDivElement>("model-command");
const statusLine = byId<HTMLParagraphElement>("status");
const stateLine = byId<HTMLSpanElement>("state");
const stateMark = byId<HTMLSpanElement>("state-mark");
const stateText = byId<HTMLSpanElement>("state-text");
const strip = byId<HTMLSpanElement>("strip");
const backendSelect = byId<HTMLSelectElement>("backend");
const imageBaseInput = byId<HTMLInputElement>("image-base");
const imageNote = byId<HTMLParagraphElement>("image-note");
const alwaysOn = byId<HTMLInputElement>("always-on");
const panel = byId<HTMLPreElement>("panel");
const raw = byId<HTMLDetailsElement>("raw");
const copyButton = byId<HTMLButtonElement>("copy-diagnostics");
const copyNote = byId<HTMLSpanElement>("copy-note");
const gamesBlock = byId<HTMLElement>("games");
const gameChoices = byId<HTMLFieldSetElement>("game-choices");
const gameSourceLine = byId<HTMLParagraphElement>("game-source");
const gameNotes = byId<HTMLDivElement>("game-notes");
const gameCredit = byId<HTMLParagraphElement>("game-credit");
const gameCreditLink = byId<HTMLAnchorElement>("game-credit-link");
const gameExamples = byId<HTMLDivElement>("game-examples");
const gameState = byId<HTMLParagraphElement>("game-state");
const gameStateMark = byId<HTMLSpanElement>("game-state-mark");
const gameStateText = byId<HTMLSpanElement>("game-state-text");
const localBlock = byId<HTMLDivElement>("local-release");
const localIntro = byId<HTMLParagraphElement>("local-intro");
const releaseFolderInput = byId<HTMLInputElement>("release-folder");
const imagesFolderInput = byId<HTMLInputElement>("images-folder");
const localProblem = byId<HTMLParagraphElement>("local-problem");
const localNote = byId<HTMLParagraphElement>("local-note");

type Kind = "video" | "image";

/** The release address in effect: what the model is loaded from. Empty when none is known. */
let address = "";
let model: ModelState = { kind: "none" };
let media: MediaState = { kind: "none" };
/** The file chosen, dropped or named by the page's address (`servedAt`: its path on the local server). */
let chosen: { blob: Blob; name: string; servedAt: string | null } | null = null;
/** What the page's address asked for and did not get. */
let refused: string[] = [];
/** The game chosen in a hosted page's picker; null without a picker, or before a choice. */
let game: Game | null = null;

let session: Session | null = null;
let sessionOn: Kind = "image";
/** Whether the session has been given a file. A session is given one. */
let sessionSpent = false;
/** Ends the wait for the file that was opening when another is opened. */
let opening: AbortController | null = null;
let objectUrl: string | null = null;
let artByCard = new Map<string, string>();
let shownCard: string | null = null;
/** Whether a name has been shown since the page opened: the hint goes away with the first one. */
let named = false;
/** Whether the release address field is open under the model line. */
let formOpen = false;
/** Whether the stage holds a picture's place: kept while another file opens, so the page does not jump. */
let placeKept = false;
/** The worker's time for each frame the session analyzed, newest last, for the sparkline in
 *  Details; and the session's count of frames when the last one was taken. */
let frameTimes: number[] = [];
let framesSeen = 0;
/** The release read from a folder chosen on this computer, while it is the one in effect: the
 *  files handed to the worker, by path relative to the release document's folder. */
let localRelease: { files: Record<string, Blob> } | null = null;
/** Card images chosen on this computer, by path in their folder, that folder's path, and whether
 *  they were taken from beside a release folder (`auto`) rather than chosen. */
let localImages: LocalImages | null = null;
/** The blob: URL made for each local card image shown, by its path; revoked with the images. */
let localArtUrls = new Map<string, string>();
/** The path of the local card image the tooltip shows, and the card whose image was not found. */
let localArtPath: string | null = null;
let localArtMissing: string | null = null;
/** The path of a local card image that the browser could not show. */
let localArtBroken: string | null = null;
/** Why the folder chosen holds no release the page can hand over; null when there is no problem. */
let localProblemText: string | null = null;
/** Counts folder choices: a document still being read when another folder is chosen is dropped. */
let localChoice = 0;
/** Where the pointer is over the picture, in viewport coordinates; null when it is elsewhere. */
let pointer: { x: number; y: number } | null = null;
/** What Details shows now: it is written again only when it changes. */
let detailsShown: DetailsView | null = null;

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** Show or hide a line of words: hidden when there is nothing to say. */
function say(element: HTMLElement, text: string | null): void {
  setText(element, text ?? "");
  element.hidden = text === null;
}

/** Where a card's image may be under the base in the options, in the order to try (`artUrls`):
 *  the catalog's path with its folders, then the bare file name. None when the base is empty,
 *  so that nothing is fetched. */
function artCandidates(cardId: string): string[] {
  localArtPath = null;
  localArtBroken = null;
  if (localImages) {
    // Found as on a server (`localArt`): the path with its folders, then the bare name.
    const found = localArt(localImages.images, artByCard.get(cardId));
    localArtMissing = found === null ? cardId : null;
    if (found === null) return [];
    localArtPath = found.path;
    let url = localArtUrls.get(found.path);
    if (url === undefined) {
      url = URL.createObjectURL(found.file);
      localArtUrls.set(found.path, url);
    }
    return [url];
  }
  return hosted ? (game ? gameArtUrls(game, artByCard.get(cardId), location.href) : [])
    : artUrls(imageBaseInput.value.trim(), artByCard.get(cardId), location.href);
}

/** Free the blob: URLs of the local card images, and forget the images when `forget` says so. */
function revokeLocalArt(forget: boolean): void {
  for (const url of localArtUrls.values()) URL.revokeObjectURL(url);
  localArtUrls = new Map();
  localArtPath = null;
  localArtMissing = null;
  localArtBroken = null;
  if (forget) localImages = null;
  // The image of the card on show is looked up again.
  shownCard = null;
}

/** What the page says about the card images chosen on this computer, or null for none. */
function localImagesText(): string | null {
  if (!localImages) return null;
  const count = localImages.images.size;
  const said = `Card images: ${count} ${count === 1 ? "file" : "files"} from ${localImages.folder === "" ? "the folder chosen" : localImages.folder}.`;
  if (localArtBroken !== null) return `${said} ${localArtBroken} could not be shown as an image; the tooltip shows the name alone.`;
  if (localArtMissing === null) return said;
  const art = artByCard.get(localArtMissing);
  return `${said} No image for ${localArtMissing}${art === undefined ? "" : ` (${art})`} is there; the tooltip shows the name alone.`;
}

/** Whether a bare file name has loaded where the path with its folders did not: the image folder
 *  holds every image flat, and the bare name is tried first from then on, until the release or
 *  the image folder changes. */
let flatImages = false;

/** The addresses of the shown card's image: all of them, and those not tried yet. */
let artAll: string[] = [];
/** The bare-name address of the shown card's image, when it has a path with folders too. */
let artBare: string | null = null;
let artLeft: string[] = [];

function draw(shown: Shown | null): void {
  if (!shown) {
    box.hidden = true;
    tooltip.hidden = true;
    shownCard = null;
    return;
  }
  box.hidden = false;
  box.style.left = `${shown.box.left}px`;
  box.style.top = `${shown.box.top}px`;
  box.style.width = `${shown.box.width}px`;
  box.style.height = `${shown.box.height}px`;
  tooltipName.textContent = shown.name;
  tooltipId.textContent = shown.cardId;
  if (shownCard !== shown.cardId) {
    shownCard = shown.cardId;
    const candidates = artCandidates(shown.cardId);
    artBare = candidates.length > 1 ? (candidates[candidates.length - 1] ?? null) : null;
    artAll = flatImages ? [...candidates].reverse() : candidates;
    const [url = null, ...rest] = artAll;
    artLeft = rest;
    tooltipArt.hidden = url === null;
    if (url !== null) tooltipArt.src = url;
    else tooltipArt.removeAttribute("src");
  }
  tooltip.hidden = false;
  const right = shown.box.left + shown.box.width + 8;
  const fits = right + tooltip.offsetWidth <= window.innerWidth;
  tooltip.style.left = `${Math.max(4, fits ? right : shown.box.left - tooltip.offsetWidth - 8)}px`;
  tooltip.style.top = `${Math.max(4, Math.min(shown.box.top, window.innerHeight - tooltip.offsetHeight - 4))}px`;
}

/** The outline of every detected box, when asked for. Each kind has a color and a line of its
 *  own: named faces solid, other faces dashed, anything else (a card back) dotted. */
function drawOutlines(ready: boolean): void {
  const area = outlines.getBoundingClientRect();
  outlines.width = Math.round(area.width);
  outlines.height = Math.round(area.height);
  const ctx = outlines.getContext("2d");
  const analysis = ready && allBoxes.checked ? session?.analysis() : null;
  if (!ctx || !analysis) return;
  const theme = getComputedStyle(document.documentElement);
  const color = (name: string): string => theme.getPropertyValue(name).trim();
  const sx = outlines.width / analysis.frame.width;
  const sy = outlines.height / analysis.frame.height;
  ctx.lineWidth = 2;
  for (const item of analysis.boxes) {
    ctx.strokeStyle = color(item.face === null ? "--muted" : item.face.accepted ? "--success" : "--warning");
    ctx.setLineDash(item.face === null ? [2, 4] : item.face.accepted ? [] : [8, 4]);
    ctx.strokeRect(item.box[0] * sx, item.box[1] * sy, item.box[2] * sx, item.box[3] * sy);
  }
}

/** What the newest frame says, for the status strip. */
function facts(): RunFacts {
  if (!session) return NO_FACTS;
  const status = session.status();
  return {
    detector: status.release?.detector.ep ?? null,
    recognizer: status.release?.recognizer.ep ?? null,
    frameMs: status.lastWorkerMs,
    cards: session.analysis()?.boxes.length ?? null,
    frameError: status.lastFrameError,
  };
}

function panelFrame(): PanelFrame | null {
  const analysis = session?.analysis();
  if (!analysis) return null;
  const faces = analysis.boxes.filter((item) => item.face !== null);
  return {
    width: analysis.frame.width, height: analysis.frame.height, boxes: analysis.boxes.length, faces: faces.length,
    named: faces.filter((item) => item.face?.accepted).length,
    detectorMs: analysis.timings.detectorMs, recognizeMs: analysis.timings.recognizeMs, embeddings: analysis.embeddings,
  };
}

/** Take the time of a frame the session analyzed since the last look, for the sparkline. */
function noteFrameTime(): void {
  const status = session?.status();
  if (!status || status.frames === framesSeen) return;
  if (status.frames > framesSeen && status.lastWorkerMs !== null) frameTimes = [...frameTimes, status.lastWorkerMs].slice(-SPARK_FRAMES);
  framesSeen = status.frames;
}

/** The index of the box under the pointer in a frame's list of boxes: the box of the card the
 *  pointer is on, named or not, found the way the session finds the card it names, or else a
 *  box that holds the pointer, such as a card back. */
function boxUnderPointer(analysis: FrameAnalysis | null): number | null {
  if (!analysis || !pointer) return null;
  const element = sessionOn === "video" ? video : image;
  const area = pictureBox(element.getBoundingClientRect(), sourceSize(element), getComputedStyle(element).objectFit);
  if (area.width <= 0 || area.height <= 0) return null;
  const x = ((pointer.x - area.left) / area.width) * analysis.frame.width;
  const y = ((pointer.y - area.top) / area.height) * analysis.frame.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return boxAtPoint(analysis, x, y, hoverAt(analysis, x, y).boxIndex);
}

/** The file as Details shows it: its size once the browser has decoded it, and a video's length. */
function detailsFile(): DetailsFile | null {
  if (!chosen || media.kind === "none") return null;
  const shownVideo = media.kind === "shown" && media.video;
  const shownImage = media.kind === "shown" && !media.video;
  const width = shownVideo ? video.videoWidth : shownImage ? image.naturalWidth : 0;
  const height = shownVideo ? video.videoHeight : shownImage ? image.naturalHeight : 0;
  return {
    name: chosen.name,
    servedAt: chosen.servedAt,
    video: shownVideo,
    width: width > 0 ? width : null,
    height: height > 0 ? height : null,
    durationSec: shownVideo && Number.isFinite(video.duration) ? video.duration : null,
  };
}

/** Write to the page what view.ts decides for the model and the file as they are now. */
function render(): void {
  if (session) model = modelOf(address, session.status(), game?.models, localRelease !== null);
  const shown = model.kind === "loaded" && media.kind === "shown" ? session?.atPointer() ?? null : null;
  if (shown) named = true;
  // The "Your game" choice has no fixed address: it speaks as the local server's page does.
  const localGame = game?.local === true;
  const view = demoView(model, media, facts(), named, refused, hosted !== null && !localGame);

  // The model step leads the page while there is no model: it moves above the stage.
  if (page.dataset.step !== view.step) {
    page.dataset.step = view.step;
    if (view.step === "model") page.insertBefore(modelBlock, stage);
    else page.insertBefore(modelBlock, statusLine);
  }
  const leads = view.step === "model";
  // A hosted page with a release address has nothing to ask for: it says what went wrong, and offers Retry.
  modelIntro.hidden = !leads || (hosted !== null && (hosted.release !== null || (game !== null && !localGame)));
  modelCommand.hidden = !leads || hosted !== null;
  modelLine.hidden = view.modelLine === null;
  setText(modelText, view.modelLine ?? "");
  changeModel.hidden = leads || model.kind === "failed" || hosted !== null;
  say(modelProblem, view.modelProblem);
  // A model that did not load is put right where it is said: the address field opens under the
  // message, and its button tries again with whatever the field then holds. A hosted page's
  // address is fixed: the field shows it, and its button tries it again.
  const showForm = hosted ? model.kind === "failed" && !localGame : leads || formOpen || model.kind === "failed";
  modelForm.hidden = !showForm;
  // The folder buttons: always on the "Your game" choice, and beside the address field on the
  // local server's page. The hosted page's other choices have none.
  localBlock.hidden = !(localGame || (hosted === null && showForm));
  localIntro.hidden = localGame;
  say(localProblem, localProblemText);
  say(localNote, localImagesText());
  changeModel.setAttribute("aria-expanded", String(showForm));
  setText(loadModel, model.kind === "failed" ? "Retry" : "Load");
  loadModel.classList.toggle("primary", leads);
  chooseLabel.classList.toggle("primary", !leads);

  // While another file opens, the stage keeps the place of the picture it held.
  if (view.stage !== "opening") placeKept = view.stage === "file";
  stage.dataset.holds = view.stage;
  dropzone.hidden = placeKept;
  picture.hidden = !placeKept;
  video.hidden = !(media.kind === "shown" && media.video);
  image.hidden = !(media.kind === "shown" && !media.video);
  say(openingLine, view.stage === "opening" ? `Opening ${view.fileName}…` : null);
  say(fileProblem, view.fileProblem);
  say(addressProblem, view.addressProblem);
  hint.hidden = !view.hint;
  fileBar.hidden = !placeKept;
  setText(fileName, view.fileName ?? "");
  setText(fileNote, chosen?.servedAt ? `opened from this page's address (${chosen.servedAt} on the local server)` : "");

  stateLine.dataset.tone = view.state.tone;
  setText(stateMark, MARK[view.state.tone]);
  setText(stateText, view.state.text);
  if (game !== null) {
    gameState.dataset.tone = view.state.tone;
    setText(gameStateMark, MARK[view.state.tone]);
    setText(gameStateText, view.state.text);
  }
  setText(strip, view.strip.map((part) => ` · ${part}`).join(""));

  draw(view.ready ? shown : null);
  drawOutlines(view.ready);
  const file = chosen && media.kind !== "none" ? { name: chosen.name, servedAt: chosen.servedAt } : null;
  setText(panel, panelLines(view, model, file, session?.status() ?? null, view.ready ? panelFrame() : null, shown).join("\n"));

  noteFrameTime();
  const status = session?.status() ?? null;
  const analysis = view.ready ? session?.analysis() ?? null : null;
  const next = detailsView(view, model, media, detailsFile(), status, facts().frameError, analysis, frameTimes, view.ready ? boxUnderPointer(analysis) : null);
  if (detailsShown === null || JSON.stringify(next) !== JSON.stringify(detailsShown)) {
    detailsShown = next;
    renderDetails(next, MARK);
  }
}

/** Take a file out of an element, so that it shows nothing and holds nothing. */
function empty(kind: Kind): void {
  if (kind === "image") {
    image.removeAttribute("src");
    return;
  }
  video.pause();
  if (video.hasAttribute("src")) {
    video.removeAttribute("src");
    video.load();
  }
}

/** Start a session on the image or the video element. It loads the model at the address in
 *  effect. Whatever the session before it showed is gone. */
function startSession(kind: Kind): void {
  session?.stop();
  session = null;
  sessionOn = kind;
  sessionSpent = false;
  artByCard = new Map();
  localArtMissing = null;
  flatImages = false;
  frameTimes = [];
  framesSeen = 0;
  say(imageNote, null);
  if (address === "") {
    model = { kind: "none" };
    render();
    return;
  }
  model = { kind: "loading", address };
  const backend = chosenBackend(backendSelect);
  const started = createSession(kind === "video" ? video : image, {
    // A release from a folder on this computer is read from its files, and nothing is fetched.
    ...(localRelease ? { releaseUrl: RELEASE_DOCUMENT, releaseFiles: localRelease.files } : { releaseUrl: address }),
    ...(hosted ? { workerUrl: hostedWorkerUrl(), wasmPaths: new URL("lib/", location.href).href } : { workerUrl: new URL(WORKER_URL, location.href) }),
    mode: alwaysOn.checked ? "always-on" : "pointer",
    ...(backend === null ? {} : { providers: [backend] }),
    onUpdate: () => {
      if (session !== started) return;
      if (artByCard.size === 0) artByCard = new Map(started.cards().flatMap((card) => (card.art === null ? [] : [[card.id, card.art] as [string, string]])));
      render();
    },
  });
  session = started;
  // A handle for scripted checks of the page: `demo.session.at(x, y)`, `demo.session.status()`.
  (window as unknown as { demo: unknown }).demo = { session, game: game?.id ?? null };
  render();
}

let hostedWorker: string | null = null;

/** The blob: URL a hosted page starts its worker from, made once. */
function hostedWorkerUrl(): string {
  hostedWorker ??= URL.createObjectURL(new Blob([hostedWorkerScript(location.href)], { type: "text/javascript" }));
  return hostedWorker;
}

/**
 * Open a file: show it, and run a session on it. The file is on show only once the browser has
 * decoded it to a picture; a file it cannot decode is said so by name, and never reads as ready.
 */
function openFile(file: { blob: Blob; name: string; servedAt: string | null }): void {
  const kind: Kind = isVideoType(file.blob.type, file.name) ? "video" : "image";
  opening?.abort();
  opening = new AbortController();
  const { signal } = opening;
  chosen = file;
  media = { kind: "opening", name: file.name };
  empty("video");
  empty("image");
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file.blob);
  if (!session || sessionOn !== kind || sessionSpent || model.kind === "failed") startSession(kind);
  sessionSpent = true;

  const settle = (width: number, height: number): void => {
    const decoded = width > 0 && height > 0;
    media = decoded ? { kind: "shown", name: file.name, video: kind === "video" } : { kind: "undecodable", name: file.name, video: kind === "video" };
    if (decoded) picture.style.setProperty("--ratio", String(width / height));
    // A video starts without sound. It has its own controls for the rest.
    if (decoded && kind === "video") void video.play().catch(() => undefined);
    if (!decoded) empty(kind);
    render();
  };
  const refuse = (): void => {
    // The element took no file, so the session has seen none.
    sessionSpent = false;
    settle(0, 0);
  };
  if (kind === "video") {
    // A file with sound and no picture loads too: it has no frame to look at.
    video.addEventListener("loadeddata", () => settle(video.videoWidth, video.videoHeight), { once: true, signal });
    video.addEventListener("error", refuse, { once: true, signal });
    video.src = objectUrl;
  } else {
    image.addEventListener("load", () => settle(image.naturalWidth, image.naturalHeight), { once: true, signal });
    image.addEventListener("error", refuse, { once: true, signal });
    image.src = objectUrl;
  }
  render();
}

/** Start again with the model address, the backend and the schedule as they are now. The file
 *  on show stays where it is: the new session is started on the element that holds it. */
function restart(): void {
  const held = media.kind === "shown" || media.kind === "opening";
  startSession(held ? sessionOn : "image");
  sessionSpent = held;
}

/**
 * What the page does when it opens. The server it came from says whether it was started with a
 * release folder and an image folder: the model then loads at once, and the tooltip shows card
 * images. The page's address may name the server's one file to open (see the top of this file).
 */
async function begin(): Promise<void> {
  if (hosted) {
    beginHosted(hosted.release, hosted.games);
    return;
  }
  const config = await serverConfig();
  const asked = addressRequest(location.search, config, location.origin);
  refused = asked.refused;
  // Card images are on whenever the server has an image folder. The address's `images` asks for
  // the same folder, and is followed only when the server has it, so it adds nothing here.
  if (config.images) imageBaseInput.value = SERVED_IMAGES_BASE;
  if (config.release) {
    address = SERVED_RELEASE_URL;
    releaseInput.value = address;
    startSession("image");
  } else {
    render();
  }
  if (!asked.file) return;
  let blob: Blob;
  try {
    const response = await fetch(asked.file.url);
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    blob = await response.blob();
  } catch (error) {
    chosen = { blob: new Blob(), name: asked.file.name, servedAt: asked.file.path };
    media = { kind: "unfetched", name: asked.file.name, reason: error instanceof Error ? error.message : String(error) };
    render();
    return;
  }
  openFile({ blob, name: asked.file.name, servedAt: asked.file.path });
}

/** What a hosted page does when it opens: it loads the release it was built with, or the first
 *  game of its picker, or says that it has none. Nothing in its address is followed, and the
 *  Card images option is not offered. */
function beginHosted(release: string | null, games: Game[]): void {
  say(hostedLine, games.length > 0 ? null : hostedNote(release));
  imageLabel.hidden = true;
  imageField.hidden = true;
  releaseInput.readOnly = true;
  if (games.length > 0) {
    buildPicker(games);
    chooseGame(games[0]!);
    return;
  }
  if (release === null) {
    setText(modelIntroTitle, HOSTED.noModelTitle);
    setText(modelIntroText, HOSTED.noModelText);
    render();
    return;
  }
  address = release;
  releaseInput.value = address;
  startSession("image");
}

/** The example being fetched. Another example, a file chosen or dropped, and a game switch each
 *  end it, and what it brings back afterwards is dropped. */
const exampleRequest = latestRequest();

/** Put the file on show away: the stage goes back to the drop zone, holding nothing. */
function closeFile(): void {
  exampleRequest.cancel();
  opening?.abort();
  opening = null;
  chosen = null;
  media = { kind: "none" };
  empty("video");
  empty("image");
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  placeKept = false;
  named = false;
  pointer = null;
}

/** One choice of the picker for each game, as radio buttons with a label each. */
function buildPicker(games: Game[]): void {
  gamesBlock.hidden = false;
  for (const one of games) {
    const label = document.createElement("label");
    label.className = "choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "game";
    input.value = one.id;
    input.id = `game-${one.id}`;
    input.addEventListener("change", () => {
      if (input.checked) chooseGame(one);
    });
    const text = document.createElement("span");
    text.textContent = one.label;
    label.append(input, text);
    gameChoices.append(label);
  }
}

/** Open an example file of the game, from the site, as if it had been chosen. */
async function openExample(example: Game["examples"][number]): Promise<void> {
  const name = example.path.split("/").pop() ?? example.path;
  const request = exampleRequest.start();
  let blob: Blob;
  try {
    const response = await fetch(new URL(example.path, location.href), { signal: request.signal });
    if (!response.ok) throw new Error(`the site answered ${response.status}`);
    blob = await response.blob();
  } catch (error) {
    // A request that was ended says nothing: what is on the page now is not its business.
    if (!request.current()) return;
    chosen = { blob: new Blob(), name, servedAt: null };
    media = { kind: "unfetched", name, reason: error instanceof Error ? error.message : String(error) };
    render();
    return;
  }
  if (!request.current()) return;
  openFile({ blob, name, servedAt: null });
}

/** Choose a game of the picker: say what it is, stop the session of the game before (its worker
 *  and its models go with it), put the file on show away, and load the game's release. */
function chooseGame(chosenGame: Game): void {
  if (game?.id === chosenGame.id && session) return;
  game = chosenGame;
  // Nothing chosen on this computer for the game before is kept: its files, its images and their blob: URLs.
  forgetLocal();
  const radio = document.getElementById(`game-${chosenGame.id}`) as HTMLInputElement | null;
  if (radio) radio.checked = true;
  gameSourceLine.hidden = chosenGame.release === null;
  setText(gameSourceLine, chosenGame.release === null ? "" : gameSource(chosenGame.release, location.href));
  if (chosenGame.local) {
    setText(modelIntroTitle, LOCAL_GAME.title);
    setText(modelIntroText, LOCAL_GAME.text);
  }
  gameNotes.replaceChildren(...chosenGame.notes.map((note) => {
    const line = document.createElement("p");
    line.textContent = note;
    return line;
  }));
  gameCredit.hidden = chosenGame.credit === null;
  setText(gameCreditLink, chosenGame.credit?.text ?? "");
  if (chosenGame.credit) gameCreditLink.href = chosenGame.credit.href;
  else gameCreditLink.removeAttribute("href");
  gameExamples.replaceChildren(...chosenGame.examples.map((example) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.dataset.example = example.path;
    button.textContent = example.label;
    button.addEventListener("click", () => void openExample(example));
    return button;
  }));
  gameExamples.hidden = chosenGame.examples.length === 0;
  session?.stop();
  session = null;
  closeFile();
  // Nothing of the game before is left in the tooltip: not its name, not its card image.
  draw(null);
  tooltipArt.hidden = true;
  tooltipArt.removeAttribute("src");
  address = chosenGame.release === null ? "" : new URL(chosenGame.release, location.href).href;
  releaseInput.value = address;
  formOpen = false;
  startSession("image");
}

/** What the model step says on the "Your game" choice, before a folder is chosen. */
const LOCAL_GAME = {
  title: "Choose your release folder",
  text: `Choose the folder that holds ${RELEASE_DOCUMENT}, such as the release folder that cardvision build-release wrote, and, if you like, a folder of card images. This page reads them on this computer: nothing is uploaded, and it makes no request for them.`,
};

/** Forget the release and the card images chosen on this computer, and free their blob: URLs. */
function forgetLocal(): void {
  localChoice += 1;
  localRelease = null;
  localProblemText = null;
  revokeLocalArt(true);
}

/**
 * A release folder chosen on this computer: find its release document, hand the worker that
 * document and the files it pins, and load it. A folder with no document, or one that lacks a file
 * the document pins, is said so, and the model in effect stays. Card images in an `images/` or
 * `art/` folder beside the release are taken too, unless images were chosen with the images
 * button; images taken from beside an earlier release are let go (`imagesForRelease`).
 */
async function chooseReleaseFolder(files: PickedFile[]): Promise<void> {
  const choice = ++localChoice;
  const refuse = (problem: string): void => {
    localProblemText = problem;
    render();
  };
  const found = findReleaseDocument(files);
  if ("problem" in found) return refuse(found.problem);
  let text: string;
  try {
    text = await found.document.file.text();
  } catch (error) {
    if (choice === localChoice) refuse(`${found.document.path} could not be read (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  // Another folder, another game or a typed address was chosen meanwhile.
  if (choice !== localChoice) return;
  const taken = releaseFilesFrom(files, found, text);
  if ("problem" in taken) return refuse(taken.problem);
  localProblemText = null;
  const images = imagesForRelease(localImages, files, found.folder);
  if (images !== localImages) {
    revokeLocalArt(true);
    localImages = images;
  }
  localRelease = { files: taken.files };
  address = found.document.path;
  formOpen = false;
  restart();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  // Emptied, so that choosing the same file again is a change too.
  fileInput.value = "";
  if (file) {
    exampleRequest.cancel();
    openFile({ blob: file, name: file.name, servedAt: null });
  }
});
changeFile.addEventListener("click", () => fileInput.click());

// The stage is the drop zone, with or without a file on show. A file dropped beside it is not
// opened by the browser in place of this page.
stage.addEventListener("dragover", (event) => {
  event.preventDefault();
  stage.dataset.drop = "over";
});
stage.addEventListener("dragleave", (event) => {
  if (!(event.relatedTarget instanceof Node) || !stage.contains(event.relatedTarget)) delete stage.dataset.drop;
});
stage.addEventListener("drop", (event) => {
  event.preventDefault();
  delete stage.dataset.drop;
  const file = event.dataTransfer?.files[0];
  if (file) {
    exampleRequest.cancel();
    openFile({ blob: file, name: file.name, servedAt: null });
  }
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

releaseFolderInput.addEventListener("change", () => {
  const files = pickedFiles(releaseFolderInput.files ?? []);
  // Emptied, so that choosing the same folder again is a change too.
  releaseFolderInput.value = "";
  if (files.length > 0) void chooseReleaseFolder(files);
});
imagesFolderInput.addEventListener("change", () => {
  const files = pickedFiles(imagesFolderInput.files ?? []);
  imagesFolderInput.value = "";
  if (files.length === 0) return;
  revokeLocalArt(true);
  localImages = { ...imagesFrom(files), auto: false };
  say(imageNote, null);
  render();
});

modelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  // An address typed on the local server's page takes the place of a folder chosen.
  localChoice += 1;
  localRelease = null;
  localProblemText = null;
  // Card images taken from beside that folder go with it; images chosen with the button stay.
  if (imagesForAddress(localImages) !== localImages) revokeLocalArt(true);
  address = releaseInput.value.trim();
  formOpen = false;
  restart();
});
changeModel.addEventListener("click", () => {
  formOpen = !formOpen;
  render();
  if (formOpen) releaseInput.focus();
});
backendSelect.addEventListener("change", restart);
alwaysOn.addEventListener("change", restart);
allBoxes.addEventListener("change", render);
imageBaseInput.addEventListener("change", () => {
  flatImages = false;
  // An image base typed takes the place of an image folder chosen.
  revokeLocalArt(true);
  // The image of the card on show is asked for again, under the new base.
  shownCard = null;
  say(imageNote, null);
  render();
});
// A card image that does not load is left out of the tooltip, and the options say so.
// The next address is tried first: a folder that holds every image flat has the bare file name.
tooltipArt.addEventListener("error", () => {
  const next = artLeft.shift();
  if (next !== undefined) {
    tooltipArt.src = next;
    return;
  }
  flatImages = false;
  tooltipArt.hidden = true;
  if (localArtPath !== null) {
    localArtBroken = localArtPath;
    say(localNote, localImagesText());
    return;
  }
  const tried = (artAll.length > 0 ? artAll : [tooltipArt.src]).map((url) => new URL(url).pathname);
  say(imageNote, `No image was found at ${tried.join(" or ")}. The tooltip shows the name alone.`);
});
tooltipArt.addEventListener("load", () => {
  // A bare name that loaded after the path with its folders failed: the folder is flat.
  if (artBare !== null) flatImages = tooltipArt.src === artBare;
  say(imageNote, null);
});

// The pointer over the picture, for the row of the box under it in Details.
for (const element of [video, image] as HTMLElement[]) {
  element.addEventListener("pointermove", (event) => {
    pointer = { x: event.clientX, y: event.clientY };
  });
  element.addEventListener("pointerleave", () => {
    pointer = null;
    render();
  });
}

// Copy diagnostics copies the text panel, whole, for a bug report. Where the browser refuses
// the clipboard, the text is opened and selected, to copy by hand.
let copyNoteTimer: ReturnType<typeof setTimeout> | undefined;
copyButton.addEventListener("click", () => {
  const text = panel.textContent ?? "";
  const done = (note: string): void => {
    setText(copyNote, note);
    clearTimeout(copyNoteTimer);
    copyNoteTimer = setTimeout(() => setText(copyNote, ""), 4000);
  };
  // `navigator.clipboard` is missing where the page is not a secure context.
  (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("no clipboard"))).then(
    () => done(`Copied ${text.split("\n").length} lines.`),
    () => {
      raw.open = true;
      getSelection()?.selectAllChildren(panel);
      done("The browser did not allow copying: the text is selected under Raw text.");
    },
  );
});

window.addEventListener("scroll", render, { passive: true });
window.addEventListener("resize", render);
// A video keeps moving under a resting pointer: follow it between the session's own updates.
setInterval(() => {
  if (session) render();
}, 250);
void begin();
