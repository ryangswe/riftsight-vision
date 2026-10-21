// SPDX-License-Identifier: Apache-2.0
// The game picker of the hosted demo (scripts/pages.mjs, demo/page.ts): the games a build can
// offer, the list the page is given and how it reads it, the policy a page with a picker runs
// under, and the built site with the toy game bundled. The toy game's folder is made up here
// (a few bytes per file); no page is opened and nothing is fetched.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error: a script of this folder, in JavaScript with no declarations.
import * as pages from "../scripts/pages.mjs";
import { artPath, artUrls, GAMES_META, gameArtUrls, hostedRelease, latestRequest, parseGames, RELEASE_META } from "../demo/page.js";
import { aboutSize, demoView, gameSource, modelOf } from "../demo/view.js";

const { buildPages, copyToy, gameNames, gamesPolicy, hostedPage, HOSTED_GAMES, ONE_PIECE_PAGE, pickerGames, REPOSITORY_URL, siteFiles, TOY_SITE } = pages;
const read = (name: string): string => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf-8");

const ONE_PIECE_RELEASE = "https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece/resolve/5526f531863381745780f4377f1cae767077ca77/release.json";
const ONE_PIECE_FOLDER = "https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece/resolve/5526f531863381745780f4377f1cae767077ca77/";
const PAGE = "https://example.github.io/project/";

/** The content of a meta element as a browser reads it: the build's escapes undone. */
const unescape = (text: string): string => text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const metaContent = (html: string, name: string): string | null => {
  const found = new RegExp(`<meta name="${name}" content="([^"]*)">`).exec(html);
  return found ? unescape(found[1]!) : null;
};
const docWith = (metas: Record<string, string>) => ({
  querySelector: (selector: string) => {
    const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
    return name !== undefined && name in metas ? { content: metas[name] } : null;
  },
}) as unknown as Pick<Document, "querySelector">;

describe("the games a hosted build can offer", () => {
  it("are the toy game and the One Piece Card Game, and --games names them in the picker's order", () => {
    expect(Object.keys(HOSTED_GAMES)).toEqual(["toy", "one-piece"]);
    expect(gameNames("toy,one-piece")).toEqual({ games: ["toy", "one-piece"] });
    expect(gameNames(" one-piece , toy ")).toEqual({ games: ["one-piece", "toy"] });
    expect(gameNames("").problem).toBe("--games names no game: give one or more of toy, one-piece, separated by commas");
    expect(gameNames("toy,chess").problem).toBe("--games toy,chess: chess is not a game this build knows (toy, one-piece)");
    expect(gameNames("toy,toy").problem).toBe("--games toy,toy: a game is named twice");
    expect(gameNames("constructor").problem).toContain("constructor is not a game this build knows");
  });

  it("give the toy game its bundled release, its card images and the two example files", () => {
    const [toy] = pickerGames(["toy"]);
    expect(toy).toEqual({
      id: "toy",
      label: "Toy game (practice)",
      models: "the toy game's models",
      release: "games/toy/release/release.json",
      images: "games/toy/images/",
      examples: [
        { label: "Load the example table", path: "games/toy/table.png" },
        { label: "Load the example video", path: "games/toy/table.webm" },
      ],
      notes: [expect.stringContaining("stand-ins with no skill")],
      credit: null,
    });
    expect(toy.notes[0]).toContain("learn how hovering works");
    expect(TOY_SITE).toBe("games/toy/");
  });

  it("give the One Piece Card Game its release on Hugging Face, names only, with its credit", () => {
    const [onePiece] = pickerGames(["one-piece"]);
    expect(onePiece).toEqual({
      id: "one-piece",
      label: "One Piece Card Game (Kenbunshoku models)",
      models: "the One Piece models",
      release: ONE_PIECE_RELEASE,
      images: null,
      examples: [],
      notes: [expect.stringContaining("Names only"), "Unofficial fan project, not affiliated with Bandai."],
      credit: { text: "Models: Kenbunshoku One Piece release B2.1 (Apache-2.0)", href: ONE_PIECE_PAGE },
    });
    expect(ONE_PIECE_PAGE).toBe("https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece");
  });
});

describe("the policy of a page with a game picker", () => {
  it("allows the site, the One Piece release's folder and Hugging Face's storage, and the site's toy images", () => {
    expect(gamesPolicy(pickerGames(["toy", "one-piece"]))).toBe([
      "default-src 'none'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "worker-src 'self' blob:",
      `connect-src 'self' ${ONE_PIECE_FOLDER} https://*.hf.co`,
      "img-src 'self' blob: data:",
      "media-src blob:",
      "style-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "));
  });

  it("allows no image from the site without a game that has images, and nothing remote without a remote game", () => {
    expect(gamesPolicy(pickerGames(["one-piece"]))).toContain("; img-src blob: data:; ");
    const toyOnly = gamesPolicy(pickerGames(["toy"]));
    expect(toyOnly).toContain("; connect-src 'self'; ");
    expect(toyOnly).toContain("; img-src 'self' blob: data:; ");
    for (const policy of [toyOnly, gamesPolicy(pickerGames(["toy", "one-piece"]))]) {
      expect(policy).not.toMatch(/'unsafe-eval'|'unsafe-inline'|frame-ancestors|\*(?!\.hf\.co)/);
    }
  });

  it("refuses a game whose release is not an https address", () => {
    expect(() => gamesPolicy([{ id: "x", label: "X", models: "x", release: "http://example.org/release.json", images: null, examples: [], notes: [], credit: null }])).toThrow(/must be served over https/);
  });
});

describe("the page with a game picker", () => {
  const html = read("demo/index.html");
  const games = pickerGames(["toy", "one-piece"]);
  const hosted = hostedPage(html, null, games);

  it("carries the policy and the games, and no single release address", () => {
    const head = hosted.slice(0, hosted.indexOf("<title>"));
    expect(head).toContain(`<meta http-equiv="Content-Security-Policy" content="${gamesPolicy(games)}">`);
    expect(head).not.toContain(`name="${RELEASE_META}"`);
    expect(JSON.parse(metaContent(hosted, GAMES_META) ?? "")).toEqual(games);
    expect(hosted).not.toContain("score.html");
  });

  it("has a hidden place for the picker, which the local server's page leaves hidden", () => {
    expect(html).toMatch(/<section id="games" class="games" aria-label="The game" hidden>\s*<fieldset id="game-choices" class="choices">\s*<legend>Choose a game<\/legend>/);
    for (const id of ["game-state", "game-state-text", "game-source", "game-notes", "game-credit", "game-credit-link", "game-examples"]) expect(html.match(new RegExp(`id="${id}"`, "g")), id).toHaveLength(1);
    // The picker comes before the stage.
    expect(html.indexOf('id="games"')).toBeLessThan(html.indexOf('id="stage"'));
  });

  it("reads its games from the meta element, as the build wrote them", () => {
    const content = metaContent(hosted, GAMES_META) ?? "";
    expect(hostedRelease(docWith({ [GAMES_META]: content }), PAGE)).toEqual({ release: null, games });
    // Without the page's address nothing can be checked, so no game is offered.
    expect(hostedRelease(docWith({ [GAMES_META]: content }), "")).toEqual({ release: null, games: [] });
    // The games win over a release address, and a page with neither is the local server's.
    expect(hostedRelease(docWith({ [GAMES_META]: content, [RELEASE_META]: ONE_PIECE_RELEASE }), PAGE)?.games).toHaveLength(2);
    expect(hostedRelease(docWith({}))).toBeNull();
  });

  it("leaves out a game that is not in the shape the build writes", () => {
    const [toy, onePiece] = games;
    const one = (game: unknown) => parseGames(JSON.stringify([game]), PAGE);
    expect(one(toy)).toEqual([toy]);
    expect(parseGames("not json", PAGE)).toEqual([]);
    expect(parseGames("{}", PAGE)).toEqual([]);
    expect(parseGames(JSON.stringify([toy, toy]), PAGE)).toEqual([toy]);
    // Images and examples come from the site only; a release is the site's or an https address.
    expect(one({ ...toy, images: "https://elsewhere.example/images/" })).toEqual([]);
    expect(one({ ...toy, images: "/images/" })).toEqual([]);
    expect(one({ ...toy, images: "../images/" })).toEqual([]);
    expect(one({ ...toy, examples: [{ label: "x", path: "https://elsewhere.example/table.png" }] })).toEqual([]);
    expect(one({ ...toy, examples: [{ label: "x", path: "games/toy/table.png?x=1" }] })).toEqual([]);
    expect(one({ ...onePiece, release: "http://huggingface.co/release.json" })).toEqual([]);
    expect(one({ ...onePiece, release: "javascript:alert(1)" })).toEqual([]);
    expect(one({ ...onePiece, credit: { text: "x", href: "javascript:alert(1)" } })).toEqual([]);
    expect(one({ ...onePiece, id: "Has Spaces" })).toEqual([]);
    expect(one({ ...onePiece, notes: [1] })).toEqual([]);
    expect(one({ ...onePiece, models: "" })).toEqual([]);
    // Judged by where a value leads once resolved against the page, and refused outright when it
    // holds whitespace or a control character, which a URL parser would drop.
    for (const bad of [" https://evil.example/i/", "\t//evil.example/i/", "ht\ttps://evil.example/i/", " //evil.example/release.json", "//evil.example/i/",
      "games/%2e%2e/%2e%2e/", "games/%2E%2E/%2e%2e/elsewhere/", "games/toy/../../../i/", "https://example.github.io/other/i/", "games/to\u0000y/"]) {
      expect(one({ ...toy, images: bad }), JSON.stringify(bad)).toEqual([]);
      expect(one({ ...toy, examples: [{ label: "x", path: bad }] }), JSON.stringify(bad)).toEqual([]);
      // A release may be any https address (the policy limits what is fetched), but nothing else off the site.
      if (!bad.startsWith("https://example.github.io/")) expect(one({ ...toy, release: bad }), JSON.stringify(bad)).toEqual([]);
    }
    expect(one({ ...toy, examples: [{ label: "x", path: "\n//evil.example/t.png" }] })).toEqual([]);
    expect(one({ ...onePiece, release: " //evil.example/release.json" })).toEqual([]);
    expect(one({ ...onePiece, release: `${ONE_PIECE_RELEASE} ` })).toEqual([]);
    expect(one({ ...onePiece, credit: { text: "x", href: " https://evil.example/" } })).toEqual([]);
    // A dot segment that stays inside the page's folder, and the page's own origin spelled out, are the site's.
    expect(one({ ...toy, images: "games/toy/x/../images/" })).toHaveLength(1);
    expect(one({ ...toy, images: "https://example.github.io/project/games/toy/images/" })).toHaveLength(1);
    // What is kept is what the page uses, and nothing else.
    expect(one({ ...onePiece, extra: "ignored" })).toEqual([onePiece]);
  });

  it("finds a toy card's image in the game's folder, and none for a game with no images", () => {
    const [toy, onePiece] = games;
    const images = `${PAGE}games/toy/images/`;
    expect(gameArtUrls(toy, "TOY-001.png", PAGE)).toEqual([`${images}TOY-001.png`]);
    // A path with a folder is tried as the Python tools read it, then as a bare name, for a flat folder.
    expect(gameArtUrls(toy, "art/TOY-003A.png", PAGE)).toEqual([`${images}art/TOY-003A.png`, `${images}TOY-003A.png`]);
    expect(gameArtUrls(toy, undefined, PAGE)).toEqual([]);
    expect(gameArtUrls(toy, "art/", PAGE)).toEqual([]);
    expect(gameArtUrls(onePiece, "OP01-001.png", PAGE)).toEqual([]);
  });

  it("resolves a card's image path as the Python tools do, folders kept, and refuses what they refuse", () => {
    expect(artPath("SET-001.png")).toBe("SET-001.png");
    expect(artPath("HD/SET-001.jpg")).toBe("HD/SET-001.jpg");
    expect(artPath("./HD//SET-001.jpg")).toBe("HD/SET-001.jpg");
    expect(artPath("https://example.com/cards/SET%20001.png")).toBe("SET 001.png");
    for (const refused of ["", "  ", "HD/", "../SET-001.png", "HD/../../x.png", "/etc/x.png", "C:x.png", "c:/x.png", "1:x.png", "é:x.png",
                           "HD\\SET-001.png", "..\\x.png", "ftp://example.com/x.png", "file:///x.png", "https://example.com/"]) {
      expect(artPath(refused), refused).toBeNull();
    }
    const base = "http://127.0.0.1:8765/images/";
    expect(artUrls("/images/", "HD/SET 001.jpg", "http://127.0.0.1:8765/")).toEqual([`${base}HD/SET%20001.jpg`, `${base}SET%20001.jpg`]);
    expect(artUrls("/images", "SET-001.png", "http://127.0.0.1:8765/")).toEqual([`${base}SET-001.png`]);
    expect(artUrls("", "SET-001.png", "http://127.0.0.1:8765/")).toEqual([]);
    expect(artUrls("/images/", "../secret.png", "http://127.0.0.1:8765/")).toEqual([]);
  });

  it("says where each game's model comes from", () => {
    expect(gameSource("games/toy/release/release.json", PAGE)).toBe("The model comes with this page.");
    expect(gameSource(ONE_PIECE_RELEASE, PAGE)).toBe("The model is downloaded from huggingface.co when this game is chosen.");
  });

  it("says, while a game's models load, whether they are downloading (and how much) or being prepared", () => {
    const report = (loading: { phase: "downloading" | "preparing"; bytes: number | null } | null) => ({ state: "loading" as const, error: null, release: null, loading });
    const text = (loading: Parameters<typeof report>[0], name?: string) => demoView(modelOf(ONE_PIECE_RELEASE, report(loading), name), { kind: "none" }, undefined, false, [], true).state;
    expect(text(null, "the One Piece models")).toEqual({ tone: "busy", text: "Loading the One Piece models…", word: "loading the model" });
    expect(text({ phase: "downloading", bytes: null }, "the One Piece models").text).toBe("Downloading the One Piece models…");
    expect(text({ phase: "downloading", bytes: 11_740_196 }, "the One Piece models").text).toBe("Downloading the One Piece models (about 12 MB)…");
    expect(text({ phase: "preparing", bytes: null }, "the One Piece models")).toEqual({ tone: "busy", text: "Preparing the One Piece models…", word: "loading the model" });
    // Without a name, as on the local server's page.
    expect(text({ phase: "downloading", bytes: 268_000 }).text).toBe("Downloading the model (about 268 KB)…");
    expect(text({ phase: "preparing", bytes: null }).text).toBe("Preparing the model…");
    expect([aboutSize(400), aboutSize(1_499_999), aboutSize(2_600_000)]).toEqual(["about 1 KB", "about 1 MB", "about 3 MB"]);
  });

  it("drops an example fetch that another example, a file or a game switch has outrun", () => {
    const examples = latestRequest();
    const table = examples.start();
    expect([table.current(), table.signal.aborted]).toEqual([true, false]);
    // A second click ends the first: whatever the first brings back, success or failure, is dropped.
    const video = examples.start();
    expect([table.current(), table.signal.aborted, video.current()]).toEqual([false, true, true]);
    // A game switch (closeFile) or a file chosen ends the one in flight too.
    examples.cancel();
    expect([video.current(), video.signal.aborted]).toEqual([false, true]);
    expect(examples.start().current()).toBe(true);
  });

  it("says that an example it could not fetch came from this site", () => {
    const media = { kind: "unfetched", name: "table.png", reason: "the site answered 404" } as const;
    expect(demoView({ kind: "none" }, media, undefined, false, [], true).fileProblem).toBe("table.png could not be loaded from this site (the site answered 404). Choose a file here instead.");
    expect(demoView({ kind: "none" }, media).fileProblem).toContain("from the local server");
  });
});

/** A made-up toy game's folder, laid out as `python tests/test_browser_fixtures.py --demo` writes it. */
function toyFolder(root: string, { game = "toy", webm = true } = {}): string {
  const folder = join(root, `toy-${game}-${webm}`);
  mkdirSync(join(folder, "release"), { recursive: true });
  mkdirSync(join(folder, "art"), { recursive: true });
  mkdirSync(join(folder, "labels"), { recursive: true });
  const catalog = { game, locale: "en", cards: [{ id: "TOY-001", name: "Amber Circle", art: "TOY-001.png" }, { id: "TOY-002", name: "Azure Square", art: "TOY-002.png" }, { id: "TOY-003", name: "No Art", art: null }] };
  writeFileSync(join(folder, "release", "catalog.json"), JSON.stringify(catalog));
  for (const name of ["detector.onnx", "recognizer.onnx", "bank.json", "bank.identity-groups.json", "accept.json"]) writeFileSync(join(folder, "release", name), name);
  writeFileSync(join(folder, "release", "release.json"), JSON.stringify({
    detector: { path: "detector.onnx" }, recognizer: { path: "recognizer.onnx" }, bank: { path: "bank.json" },
    identity: { groups: { path: "bank.identity-groups.json" } }, catalog: { path: "catalog.json" },
  }));
  for (const name of ["TOY-001.png", "TOY-002.png", "TOY-099.png"]) writeFileSync(join(folder, "art", name), name);
  writeFileSync(join(folder, "table.png"), "table.png");
  if (webm) writeFileSync(join(folder, "table.webm"), "table.webm");
  writeFileSync(join(folder, "labels", "table.manifest.jsonl"), "{}");
  return folder;
}

/** Every absolute http(s) address in a text. */
const addresses = (text: string): string[] => [...new Set(text.match(/https?:\/\/[^\s"'`)<>;\\&]+/g) ?? [])].sort();

describe("the built site with a game picker", () => {
  let root = "";
  let out = "";
  let again = "";
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pages-games-"));
    out = join(root, "site");
    again = join(root, "again");
    const toy = toyFolder(root);
    await buildPages({ games: "toy,one-piece", toy, out });
    await buildPages({ games: "toy,one-piece", toy, out: again });
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("bundles the toy game's release, the images its catalog names and the example table, and nothing else of its folder", () => {
    const toyFiles = siteFiles(out).filter((name: string) => name.startsWith("games/"));
    expect(toyFiles).toEqual([
      "games/toy/images/TOY-001.png", "games/toy/images/TOY-002.png",
      "games/toy/release/bank.identity-groups.json", "games/toy/release/bank.json", "games/toy/release/catalog.json",
      "games/toy/release/detector.onnx", "games/toy/release/recognizer.onnx", "games/toy/release/release.json",
      "games/toy/table.png", "games/toy/table.webm",
    ]);
    // Every image of the site is the toy game's.
    for (const name of siteFiles(out).filter((file: string) => /\.(png|jpe?g|webp|gif|avif|webm|mp4)$/i.test(file))) expect(name).toMatch(/^games\/toy\//);
    expect(siteFiles(out).filter((name: string) => !name.startsWith("games/"))).toEqual([
      "THIRD-PARTY-NOTICES.txt", "demo.css", "demo.js", "index.html", "lib/ort-wasm-simd-threaded.jsep.mjs", "lib/ort-wasm-simd-threaded.jsep.wasm",
      "lib/worker.js", "lib/worker.js.LEGAL.txt", "theme.css",
    ]);
  });

  it("refers to no origin but the One Piece release's, Hugging Face's storage and two links", () => {
    const html = readFileSync(join(out, "index.html"), "utf-8");
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${gamesPolicy(pickerGames(["toy", "one-piece"]))}">`);
    expect(addresses(html)).toEqual([ONE_PIECE_FOLDER, ONE_PIECE_RELEASE, ONE_PIECE_PAGE, REPOSITORY_URL, "https://*.hf.co"].sort());
  });

  it("has a worker that finds its own files from its module's address, since a hosted page starts it from a blob: URL", () => {
    // A relative address against the worker's blob: location throws as the module loads, and the
    // worker never starts.
    expect(readFileSync(join(out, "lib", "worker.js"), "utf-8")).not.toContain("self.location");
    expect(read("src/worker.ts")).not.toContain("self.location");
  });

  it("gives the same bytes for the same inputs", () => {
    expect(siteFiles(again)).toEqual(siteFiles(out));
    for (const name of siteFiles(out)) expect(readFileSync(join(again, name)).equals(readFileSync(join(out, name))), name).toBe(true);
  });

  it("refuses a toy folder that is not the toy game's, or lacks a file, and options that do not go together", async () => {
    const site = join(root, "refused");
    expect(() => copyToy(toyFolder(root, { game: "chess" }), site)).toThrow(/its release is not the toy game's/);
    expect(() => copyToy(toyFolder(root, { webm: false }), site)).toThrow(/no table\.webm/);
    expect(() => copyToy(join(root, "nowhere"), site)).toThrow(/no release\/release\.json.*test_browser_fixtures\.py --demo FOLDER/);
    await expect(buildPages({ games: "one-piece", toy: toyFolder(root), out: site })).rejects.toThrow("--toy is given, and --games does not name toy");
    await expect(buildPages({ games: "toy", out: site })).rejects.toThrow(/--games names toy: give --toy FOLDER/);
    await expect(buildPages({ games: "one-piece", releaseUrl: "", out: site })).rejects.toThrow("give --release-url or --games, not both");
  });
});
