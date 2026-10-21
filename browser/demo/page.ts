// SPDX-License-Identifier: Apache-2.0
// What the demo page and the scoring page share: finding their elements, asking the local
// server what it offers, and the choice of backend. And what the demo page's own address may
// ask of it (`addressRequest`).

import { releaseFileKey } from "../src/messages.js";
import type { ExecutionProvider } from "../src/providers.js";

export const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Where the local server (scripts/demo-server.mjs) puts the built worker, a release folder and
 *  an image folder. The worker's path is relative to the page, so that it is found on a hosted
 *  site that lives in a folder of its host as well (scripts/pages.mjs puts it in lib/ too). */
export const WORKER_URL = "lib/worker.js";
export const SERVED_RELEASE_URL = "/release/release.json";
export const SERVED_IMAGES_BASE = "/images/";

/** What the server this page came from offers: a release folder, an image folder, and the path
 *  of the one file it was started with (`--file`), if any. */
export interface ServerConfig {
  release?: boolean;
  images?: boolean;
  file?: string;
  /** The path of the geometric stage's settings document, when the server was started with one
   *  (`--geometric`): the scoring page then runs with the stage. */
  geometric?: string;
}

/** Where the server serves the folder of the geometric stage's settings document. */
export const SERVED_GEOMETRIC_BASE = "/geometric/";

/** The geometric settings the server offers, or null: only a path under its own folder is taken. */
export function servedGeometric(config: ServerConfig): string | null {
  const path = config.geometric;
  return typeof path === "string" && path.startsWith(SERVED_GEOMETRIC_BASE) && !path.includes("..") ? path : null;
}

/** What the server this page came from offers. Nothing when the page is served by something else. */
export async function serverConfig(): Promise<ServerConfig> {
  try {
    return (await (await fetch("config.json")).json()) as ServerConfig;
  } catch {
    return {};
  }
}

/** What the demo page's address asks for, after the rules of `addressRequest`. */
export interface AddressRequest {
  /** The served file to open: its address on this page's own server, its path there and its name. */
  file: { url: string; path: string; name: string } | null;
  /** Whether to fill in the card-images field with the server's own image folder. */
  images: boolean;
  /** Each parameter that was not followed, and why, in words. */
  refused: string[];
}

/** The one form a served file's path has: `/file/` and one name, with nothing after it. */
const SERVED_FILE_PATH = /^\/file\/[^/\\?#]+$/;

/**
 * What the address of the demo page asks for: `?file=/file/NAME` to open the file the local
 * server was started with, and `&images=/images/` to show card images from its image folder.
 *
 * Neither parameter is ever used as an address. `file` is followed only when it is exactly the
 * path the server itself reports for its one file (`config.file`), and what is then fetched is
 * that path on this page's own origin. `images` is followed only when it is exactly `/images/`
 * and the server has an image folder. So a link cannot make the page fetch from another host,
 * from another path, or anything the server was not told to serve. Anything else is refused,
 * with the reason, and nothing is fetched for it.
 */
export function addressRequest(search: string, config: ServerConfig, origin: string): AddressRequest {
  const params = new URLSearchParams(search);
  const request: AddressRequest = { file: null, images: false, refused: [] };
  const images = params.get("images");
  if (images !== null) {
    if (images === SERVED_IMAGES_BASE && config.images === true) request.images = true;
    else if (images === SERVED_IMAGES_BASE) request.refused.push(`images=${images}: this page's server has no image folder (it was started without --images)`);
    else request.refused.push(`images=${images}: only ${SERVED_IMAGES_BASE}, the image folder of this page's own server, can be named in the address`);
  }
  const file = params.get("file");
  if (file === null) return request;
  const offered = typeof config.file === "string" && SERVED_FILE_PATH.test(config.file) ? config.file : null;
  let name: string | null = null;
  let url: URL | null = null;
  try {
    name = offered === null ? null : decodeURIComponent(offered.slice("/file/".length));
    url = offered === null ? null : new URL(offered, origin);
  } catch {
    name = null;
  }
  if (offered === null || name === null || url === null || url.origin !== origin || url.pathname !== offered) {
    request.refused.push(`file=${file}: this page's server offers no file (it was started without --file)`);
  } else if (file !== `/file/${name}`) {
    request.refused.push(`file=${file}: this page's server offers one file, /file/${name}, and the address can name no other`);
  } else {
    request.file = { url: url.href, path: `/file/${name}`, name };
  }
  return request;
}

/** The name of the meta element by which a hosted build (scripts/pages.mjs) gives the page its
 *  release address. */
export const RELEASE_META = "cardvision-release";

/** The name of the meta element by which a hosted build with a game picker gives the page its
 *  games, as JSON (scripts/pages.mjs, `pickerGames`). */
export const GAMES_META = "cardvision-games";

/** A game of a hosted page's picker. */
export interface Game {
  id: string;
  /** The label of its choice in the picker. */
  label: string;
  /** What the page calls its models while they load: "Downloading the One Piece models…". */
  models: string;
  /** The address of its release document: relative to the page for a release bundled with the
   *  site, or an https address. Null for the choice whose release is a folder the visitor
   *  chooses on their computer (`local`). */
  release: string | null;
  /** True for that choice: its release, and its card images if any, are files the visitor
   *  chooses, read in the page. It has no images on the site and no examples. */
  local?: true;
  /** The folder of its card images, relative to the page, or null: the tooltip shows names only. */
  images: string | null;
  /** Files bundled with the site that a button opens, as if they had been chosen. */
  examples: { label: string; path: string }[];
  /** What the page says about the game when it is chosen. */
  notes: string[];
  /** Whose models these are, with a link. */
  credit: { text: string; href: string } | null;
}

/** What a hosted build of the page was told: the address of its release document, or null when
 *  it was built with none; or, for a build with a game picker, its games (`release` is then
 *  null until a game is chosen). */
export interface Hosted {
  release: string | null;
  games: Game[];
}

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Whitespace or a control character anywhere: a URL parser drops some of them silently (a tab
 *  or a newline inside a scheme, a space before it), so a value that holds one is refused before
 *  it is resolved. */
const UNSAFE_CHARACTERS = /[\s\u0000-\u001f\u007f-\u009f]/;

/** A value resolved against the page, or null when it does not resolve. */
function resolved(value: string, pageUrl: string): URL | null {
  try {
    return new URL(value, pageUrl);
  } catch {
    return null;
  }
}

/**
 * Whether a value is a file or folder of this site: once resolved against the page, it is on the
 * page's origin and inside the page's folder, with no query and no fragment. The check is made on
 * the resolved address, so dot segments in any spelling (`..`, `%2e%2e`) and a scheme-relative
 * `//host/` are judged by where they lead.
 */
export function isSitePath(value: unknown, pageUrl: string): value is string {
  if (!isText(value) || UNSAFE_CHARACTERS.test(value) || /[?#\\]/.test(value)) return false;
  const page = resolved(pageUrl, pageUrl);
  const url = resolved(value, pageUrl);
  if (!page || !url) return false;
  const folder = new URL("./", page).pathname;
  return url.origin === page.origin && url.pathname.startsWith(folder) && url.search === "" && url.hash === "";
}

/** Whether a value is an https address with no user name or password, as it stands. */
function isHttps(value: unknown): value is string {
  if (!isText(value) || UNSAFE_CHARACTERS.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "";
}

/**
 * The games a hosted page's meta element gives, checked against the page's address `pageUrl`. A
 * game whose fields do not have the shape the build writes is left out. Its release must be an
 * https address or a file of this site (`isSitePath`); its card images and example files must be
 * files of this site, so that the page asks no other origin for an image or an example; its
 * credit link must be an https address. What the page then fetches is still held to the page's
 * Content-Security-Policy; this check does not replace it.
 */
export function parseGames(text: string, pageUrl: string): Game[] {
  let given: unknown;
  try {
    given = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(given) || resolved(pageUrl, pageUrl) === null) return [];
  const games: Game[] = [];
  for (const item of given as Record<string, unknown>[]) {
    if (item === null || typeof item !== "object") continue;
    const { id, label, models, release, images, examples, notes, credit, local } = item;
    if (!isText(id) || !/^[a-z0-9-]+$/.test(id) || games.some((game) => game.id === id) || !isText(label) || !isText(models)) continue;
    if (local !== undefined && local !== true) continue;
    // The visitor's own folder: no release address, no images on the site, no examples.
    if (local === true ? release !== null || images !== null || !Array.isArray(examples) || examples.length > 0 : !(isHttps(release) || isSitePath(release, pageUrl))) continue;
    if (images !== null && !isSitePath(images, pageUrl)) continue;
    if (!Array.isArray(examples) || !examples.every((one) => one !== null && typeof one === "object" && isText(one.label) && isSitePath(one.path, pageUrl))) continue;
    if (!Array.isArray(notes) || !notes.every(isText)) continue;
    const linked = credit !== null && typeof credit === "object" ? credit as Record<string, unknown> : null;
    if (credit !== null && !(linked && isText(linked.text) && isHttps(linked.href))) continue;
    games.push({
      id, label, models, release: release as string | null, ...(local === true ? { local } : {}), images: images as string | null,
      examples: (examples as { label: string; path: string }[]).map(({ label, path }) => ({ label, path })),
      notes: [...(notes as string[])],
      credit: linked ? { text: linked.text as string, href: linked.href as string } : null,
    });
  }
  return games;
}

/**
 * Whether the page is a hosted build, and with which release address or games: `null` for the
 * page the local server serves, which has neither meta element. A hosted page asks no server what
 * it offers and follows nothing in its own address: it loads the release it was built with, or
 * the release of the game chosen, and opens only a file chosen or dropped, or an example the
 * build bundled.
 */
export function hostedRelease(doc: Pick<Document, "querySelector">, pageUrl: string = typeof location !== "undefined" ? location.href : ""): Hosted | null {
  const games = doc.querySelector<HTMLMetaElement>(`meta[name="${GAMES_META}"]`);
  if (games) return { release: null, games: parseGames(games.content, pageUrl) };
  const meta = doc.querySelector<HTMLMetaElement>(`meta[name="${RELEASE_META}"]`);
  if (!meta) return null;
  const release = meta.content.trim();
  return { release: release === "" ? null : release, games: [] };
}

/** A request that can be outrun: the page fetches one example at a time. */
export interface LatestRequest {
  /** Start a request. The one before it is ended: its signal aborts, and its `current()` is false. */
  start(): { signal: AbortSignal; current: () => boolean };
  /** End the request in flight, if any, without starting another. */
  cancel(): void;
}

/**
 * The latest of a run of requests. What a request brings back is used only while `current()` is
 * true after its await: a request that another one, a game switch or a file chosen meanwhile has
 * ended is dropped, success or failure alike.
 */
export function latestRequest(): LatestRequest {
  let controller: AbortController | null = null;
  return {
    start() {
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      return { signal: mine.signal, current: () => controller === mine && !mine.signal.aborted };
    },
    cancel() {
      controller?.abort();
      controller = null;
    },
  };
}

/**
 * The path of a card's image inside an image folder, as the Python tools resolve a catalog's
 * `art` against `--art`: relative, its folders kept (`HD/SET-001.jpg`). Null for an `art` those
 * tools refuse, so that nothing is requested for it: blank, a backslash, an absolute path or a
 * drive, a `..` segment, a scheme other than http(s), or a folder (a trailing `/`). An http(s)
 * URL gives its last path segment, and that is a guess: `cardvision import-catalog --download`
 * names the files it fetches by card id and writes those names into the catalog, so a catalog
 * that still holds a URL was not downloaded by it. The guess serves images fetched by hand under
 * their own names.
 */
export function artPath(art: string): string | null {
  if (art.trim() === "" || art.endsWith("/")) return null;
  if (/^https?:\/\//i.test(art)) {
    let last: string;
    try {
      last = decodeURIComponent(new URL(art).pathname.split("/").pop() ?? "");
    } catch {
      return null;
    }
    return last === "" || /[/\\]/.test(last) || last === ".." ? null : last;
  }
  if (art.includes("://") || art.includes("\\") || art.startsWith("/") || /^[^/]:/.test(art)) return null;
  const parts = art.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return null;
  return parts.join("/");
}

/**
 * The addresses to try, in order, for a card's image under an image folder `base`: the `art`
 * path with its folders, as the Python tools read it, and then, when that has a folder, the bare
 * file name, for a folder that holds every image flat. Empty when there is nothing to request.
 */
export function artUrls(base: string, art: string | undefined, pageUrl: string): string[] {
  const path = art === undefined ? null : artPath(art);
  if (path === null || base.trim() === "") return [];
  const root = new URL(base.endsWith("/") ? base : `${base}/`, pageUrl);
  const urls = [new URL(path.split("/").map(encodeURIComponent).join("/"), root).href];
  const name = path.split("/").pop() ?? "";
  if (name !== path) urls.push(new URL(encodeURIComponent(name), root).href);
  return urls;
}

/** The addresses to try for a game's card image in the game's image folder on the site
 *  (`artUrls`); none for a game with no images. */
export function gameArtUrls(game: Pick<Game, "images">, art: string | undefined, pageUrl: string): string[] {
  return game.images === null ? [] : artUrls(game.images, art, pageUrl);
}

/**
 * The script a hosted page starts its worker with, from a blob: URL: one import of the built
 * worker. A worker started from its own URL runs under the policy of the answer that served it,
 * and a host of plain files sends none; a worker started from a blob: URL runs under the page's
 * policy. So the worker, which fetches the release and compiles ONNX Runtime's WebAssembly, is
 * held to the page's Content-Security-Policy too.
 */
export function hostedWorkerScript(pageUrl: string): string {
  return `import ${JSON.stringify(new URL(WORKER_URL, pageUrl).href)};\n`;
}

/** Fill in the release field when the server was started with a release folder. */
export async function prefillRelease(input: HTMLInputElement): Promise<ServerConfig> {
  const config = await serverConfig();
  if (config.release && input.value === "") input.value = SERVED_RELEASE_URL;
  return config;
}

/** The backend chosen in a page's "Backend" list: one provider, or null for the release's order. */
export function chosenBackend(select: HTMLSelectElement): ExecutionProvider | null {
  return select.value === "" ? null : (select.value as ExecutionProvider);
}

// ------------------------------------------------------------------------- a release from files
// The visitor's own release, read from a folder they choose on this computer (`<input type=file
// webkitdirectory>`): no address is typed and nothing is fetched or uploaded. The page finds the
// release document in the files chosen, hands the files it pins to the worker as they are, and
// the worker checks each against the size and SHA-256 the document pins, as it does a fetched
// one (src/load.ts, `filesFetch`).

/** A file of a folder chosen on this computer, at its path in that folder: the browser's
 *  `webkitRelativePath`, which begins with the chosen folder's own name (`my-game/release/x`). */
export interface PickedFile {
  path: string;
  file: Blob;
}

/** The files of a folder input, at their paths. */
export function pickedFiles(list: Iterable<File>): PickedFile[] {
  return [...list].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
}

/** The name of a release document. */
export const RELEASE_DOCUMENT = "release.json";

/** How many folders below the chosen one a release document is looked for. */
export const RELEASE_DEPTH = 2;

/** The folder part of a path, with its trailing `/` (`""` for none). */
const folderOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);

/**
 * The release document among the files of a chosen folder: a `release.json` in the folder itself
 * or in a folder at most `RELEASE_DEPTH` levels below it, the nearest one. Its `folder` is the
 * path its files are relative to. Refused, in words, when there is none, or when two are equally
 * near (the visitor then chooses the one folder meant).
 */
export function findReleaseDocument(files: readonly PickedFile[]): { document: PickedFile; folder: string } | { problem: string } {
  const found = files.filter(({ path }) => {
    const parts = path.split("/");
    // The first part is the chosen folder's own name; a path with no folder is a file chosen alone.
    const below = parts.length - 2;
    return parts.at(-1) === RELEASE_DOCUMENT && below >= 0 && below <= RELEASE_DEPTH;
  });
  const root = files[0]?.path.split("/")[0] ?? "";
  if (found.length === 0) {
    return { problem: `No ${RELEASE_DOCUMENT} was found in ${root === "" ? "the folder chosen" : `${root}/`} or in the folders up to ${RELEASE_DEPTH} levels below it. Choose the folder that holds ${RELEASE_DOCUMENT}, the release folder that cardvision build-release wrote.` };
  }
  const depth = (file: PickedFile): number => file.path.split("/").length;
  const nearest = Math.min(...found.map(depth));
  const tied = found.filter((file) => depth(file) === nearest).sort((a, b) => (a.path < b.path ? -1 : 1));
  if (tied.length > 1) {
    return { problem: `The folder chosen holds more than one ${RELEASE_DOCUMENT} (${tied.map((file) => file.path).join(", ")}). Choose the release folder itself.` };
  }
  const document = tied[0]!;
  return { document, folder: folderOf(document.path) };
}

/**
 * The paths a release document pins: the files the loader reads beside it (the detector, the
 * recognizer, the bank, the identity groups and the catalog). A document that is not JSON, or
 * that lacks one of them, is said so; the worker reads the document again and refuses what it
 * cannot honor, with its own reason.
 */
export function pinnedReleasePaths(text: string): { paths: string[] } | { problem: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { problem: `${RELEASE_DOCUMENT} is not JSON` };
  }
  const at = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((inner, key) => (inner !== null && typeof inner === "object" ? (inner as Record<string, unknown>)[key] : undefined), value);
  const paths: string[] = [];
  for (const keys of [["detector"], ["recognizer"], ["bank"], ["identity", "groups"], ["catalog"]]) {
    const path = at(doc, ...keys, "path");
    if (!isText(path)) return { problem: `${RELEASE_DOCUMENT} names no file for ${keys.join(".")}` };
    paths.push(path);
  }
  return { paths };
}

/**
 * The files to hand the worker for a release document found in a chosen folder: the document and
 * each file it pins, by path relative to the document's folder (the worker's `files`). Refused,
 * with the missing file named, when the folder lacks a file the document pins. Nothing else of the
 * folder is handed over.
 */
export function releaseFilesFrom(files: readonly PickedFile[], found: { document: PickedFile; folder: string }, documentText: string): { files: Record<string, Blob> } | { problem: string } {
  const pinned = pinnedReleasePaths(documentText);
  if ("problem" in pinned) return pinned;
  const inFolder = new Map<string, Blob>();
  for (const { path, file } of files) {
    if (!path.startsWith(found.folder)) continue;
    const key = keyOf(path.slice(found.folder.length));
    if (key !== null) inFolder.set(key, file);
  }
  // Each file is defined as an own property: a path such as `__proto__` is a key like any other,
  // and assigning it would set the record's prototype instead.
  const out: Record<string, Blob> = {};
  const put = (key: string, file: Blob): void => {
    Object.defineProperty(out, key, { value: file, enumerable: true, writable: true, configurable: true });
  };
  put(RELEASE_DOCUMENT, found.document.file);
  const missing: string[] = [];
  for (const path of pinned.paths) {
    const key = keyOf(path);
    const file = key === null ? undefined : inFolder.get(key);
    if (file === undefined) missing.push(path);
    else put(key!, file);
  }
  if (missing.length > 0) {
    const where = found.folder === "" ? "the folder chosen" : found.folder;
    return { problem: `${RELEASE_DOCUMENT} pins ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in ${where}. Choose the folder that holds the release document and every file it pins.` };
  }
  return { files: out };
}

/** A path's key among a release's files (`releaseFileKey`), or null for one that does not resolve. */
function keyOf(path: string): string | null {
  try {
    return releaseFileKey(path);
  } catch {
    return null;
  }
}

/** The names of the folders that hold card images, beside a release or at the top of the folder
 *  chosen. */
export const IMAGE_FOLDERS = ["images", "art"] as const;

/**
 * The card images among the files of a chosen folder: those under an `images/` or `art/` folder
 * beside the release document, or else at the top of the folder chosen, the first that holds a
 * file. Each is keyed by its path inside that folder. Null when there is none: the visitor may
 * choose an image folder of its own (`imagesFrom`).
 */
export function imagesBeside(files: readonly PickedFile[], releaseFolder: string): { folder: string; images: Map<string, Blob> } | null {
  const root = files[0]?.path.split("/")[0];
  const places = [...IMAGE_FOLDERS.map((name) => `${releaseFolder}${name}/`), ...(root === undefined ? [] : IMAGE_FOLDERS.map((name) => `${root}/${name}/`))];
  for (const place of new Set(places)) {
    const images = new Map<string, Blob>();
    for (const { path, file } of files) if (path.startsWith(place)) images.set(path.slice(place.length), file);
    if (images.size > 0) return { folder: place, images };
  }
  return null;
}

/** Card images chosen on this computer, by path in their folder, and that folder's path. `auto`
 *  when they were taken from beside a release folder, not chosen with the images button. */
export interface LocalImages { folder: string; images: Map<string, Blob>; auto: boolean }

/**
 * The card images in effect once a release folder is chosen. Images the visitor chose with the
 * images button stay. Images taken from beside an earlier release give way to those beside this
 * one, or to none: they belong to the release they came with.
 */
export function imagesForRelease(current: LocalImages | null, files: readonly PickedFile[], releaseFolder: string): LocalImages | null {
  if (current !== null && !current.auto) return current;
  const beside = imagesBeside(files, releaseFolder);
  return beside === null ? null : { ...beside, auto: true };
}

/** The card images in effect once a release address is typed: those taken from beside a release
 *  folder go with it, and those the visitor chose stay. */
export function imagesForAddress(current: LocalImages | null): LocalImages | null {
  return current?.auto ? null : current;
}

/** The card images of a folder chosen for them alone, keyed by their path inside it. */
export function imagesFrom(files: readonly PickedFile[]): { folder: string; images: Map<string, Blob> } {
  const images = new Map<string, Blob>();
  let folder = "";
  for (const { path, file } of files) {
    const cut = path.indexOf("/");
    if (cut >= 0 && folder === "") folder = path.slice(0, cut + 1);
    images.set(cut >= 0 ? path.slice(cut + 1) : path, file);
  }
  return { folder, images };
}

/**
 * A card's image among images chosen on this computer, found as on a server (`artUrls`): the
 * catalog's `art` path with its folders, as the Python tools read it, then its bare file name, for
 * a folder that holds every image flat. Null when neither is there, or for an `art` those tools
 * refuse (`artPath`).
 */
export function localArt(images: ReadonlyMap<string, Blob>, art: string | undefined): { path: string; file: Blob } | null {
  const path = art === undefined ? null : artPath(art);
  if (path === null) return null;
  const name = path.split("/").pop() ?? path;
  for (const key of name === path ? [path] : [path, name]) {
    const file = images.get(key);
    if (file !== undefined) return { path: key, file };
  }
  return null;
}
