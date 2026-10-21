// SPDX-License-Identifier: Apache-2.0
// A release and card images from folders chosen on this computer (demo/page.ts, "a release from
// files"): finding the release document in the files of a folder, the files handed to the worker,
// the card images beside the release or in a folder of their own, a card's image found as on a
// server, and what the page says while such a release loads or fails. No page is opened.

import { describe, expect, it } from "vitest";

import { findReleaseDocument, imagesBeside, imagesForAddress, imagesForRelease, imagesFrom, localArt, type PickedFile, pinnedReleasePaths, releaseFilesFrom } from "../demo/page.js";
import { demoView, modelOf } from "../demo/view.js";

const DOCUMENT = JSON.stringify({
  id: "x", detector: { path: "detector.onnx" }, recognizer: { path: "recognizer.onnx" }, bank: { path: "bank.json" },
  identity: { groups: { path: "bank.identity-groups.json" } }, catalog: { path: "./catalog.json" },
});
const PINNED = ["detector.onnx", "recognizer.onnx", "bank.json", "bank.identity-groups.json", "catalog.json"];

/** The files of a chosen folder, each a Blob of its own path. */
const folder = (...paths: string[]): PickedFile[] => paths.map((path) => ({ path, file: new Blob([path]) }));
const release = (at: string, extra: string[] = []): PickedFile[] => folder(...["release.json", ...PINNED].map((name) => `${at}${name}`), ...extra);

describe("the release document in a chosen folder", () => {
  it("is found in the folder itself, or up to two folders below it, the nearest", () => {
    expect(findReleaseDocument(release("release/"))).toMatchObject({ document: { path: "release/release.json" }, folder: "release/" });
    expect(findReleaseDocument(release("my-game/release/", ["my-game/video.mp4"]))).toMatchObject({ document: { path: "my-game/release/release.json" }, folder: "my-game/release/" });
    expect(findReleaseDocument(release("out/try/release/"))).toMatchObject({ folder: "out/try/release/" });
    // The nearest wins over one deeper down.
    expect(findReleaseDocument([...release("my-game/release/"), ...folder("my-game/old/a/release.json")])).toMatchObject({ folder: "my-game/release/" });
  });

  it("is refused, in words, when there is none within reach or two are equally near", () => {
    const none = findReleaseDocument(folder("my-game/cards.csv", "my-game/a/b/c/release.json"));
    expect(none).toEqual({ problem: "No release.json was found in my-game/ or in the folders up to 2 levels below it. Choose the folder that holds release.json, the release folder that cardvision build-release wrote." });
    expect(findReleaseDocument([])).toMatchObject({ problem: expect.stringContaining("in the folder chosen") });
    // A file chosen alone, with no folder, is not a folder's.
    expect(findReleaseDocument(folder("release.json"))).toMatchObject({ problem: expect.stringContaining("No release.json") });
    expect(findReleaseDocument([...release("work/a/"), ...release("work/b/")])).toEqual({
      problem: "The folder chosen holds more than one release.json (work/a/release.json, work/b/release.json). Choose the release folder itself.",
    });
  });
});

describe("the files handed to the worker", () => {
  it("are the document and each file it pins, by path relative to the document's folder, and nothing else", () => {
    const files = release("my-game/release/", ["my-game/release/notes.txt", "my-game/video.mp4", "my-game/images/A.png"]);
    const found = findReleaseDocument(files);
    if ("problem" in found) throw new Error(found.problem);
    const taken = releaseFilesFrom(files, found, DOCUMENT);
    if ("problem" in taken) throw new Error(taken.problem);
    expect(Object.keys(taken.files).sort()).toEqual(["release.json", ...PINNED].sort());
    expect(taken.files["release.json"]).toBe(found.document.file);
    // `./catalog.json` is read as the loader reads it, under the key `catalog.json`.
    expect(taken.files["catalog.json"]).toBe(files.find((file) => file.path === "my-game/release/catalog.json")!.file);
  });

  it("name the file the document pins that the folder lacks", () => {
    const files = release("my-game/release/").filter((file) => !file.path.endsWith("recognizer.onnx") && !file.path.endsWith("bank.json"));
    const found = findReleaseDocument(files);
    if ("problem" in found) throw new Error(found.problem);
    expect(releaseFilesFrom(files, found, DOCUMENT)).toEqual({
      problem: "release.json pins recognizer.onnx, bank.json, which are not in my-game/release/. Choose the folder that holds the release document and every file it pins.",
    });
    const one = release("r/").filter((file) => !file.path.endsWith("detector.onnx"));
    const at = findReleaseDocument(one);
    if ("problem" in at) throw new Error(at.problem);
    expect(releaseFilesFrom(one, at, DOCUMENT)).toMatchObject({ problem: "release.json pins detector.onnx, which is not in r/. Choose the folder that holds the release document and every file it pins." });
  });

  it("hold a file pinned as __proto__ as a file like any other, and name it when it is missing", () => {
    const document = JSON.stringify({ ...JSON.parse(DOCUMENT), bank: { path: "__proto__" } });
    const pinned = PINNED.map((name) => (name === "bank.json" ? "__proto__" : name));
    const files = folder(...["release.json", ...pinned].map((name) => `r/${name}`));
    const found = findReleaseDocument(files);
    if ("problem" in found) throw new Error(found.problem);
    const taken = releaseFilesFrom(files, found, document);
    if ("problem" in taken) throw new Error(taken.problem);
    expect(Object.getPrototypeOf(taken.files)).toBe(Object.prototype);
    expect(Object.hasOwn(taken.files, "__proto__")).toBe(true);
    expect(Object.keys(taken.files).sort()).toEqual(["release.json", ...pinned].sort());
    expect(Object.getOwnPropertyDescriptor(taken.files, "__proto__")?.value).toBe(files.find((file) => file.path === "r/__proto__")!.file);
    const without = files.filter((file) => file.path !== "r/__proto__");
    expect(releaseFilesFrom(without, found, document)).toEqual({
      problem: "release.json pins __proto__, which is not in r/. Choose the folder that holds the release document and every file it pins.",
    });
  });

  it("are not taken from a document that is not JSON or names no file for a part", () => {
    expect(pinnedReleasePaths("{ not json")).toEqual({ problem: "release.json is not JSON" });
    expect(pinnedReleasePaths(JSON.stringify({ detector: { path: "d.onnx" } }))).toEqual({ problem: "release.json names no file for recognizer" });
    expect(pinnedReleasePaths(DOCUMENT)).toEqual({ paths: ["detector.onnx", "recognizer.onnx", "bank.json", "bank.identity-groups.json", "./catalog.json"] });
  });
});

describe("card images chosen on this computer", () => {
  it("are taken from an images/ or art/ folder beside the release, or at the top of the folder chosen", () => {
    const beside = imagesBeside(release("g/release/", ["g/release/art/A.png", "g/images/B.png"]), "g/release/");
    expect(beside?.folder).toBe("g/release/art/");
    expect([...beside!.images.keys()]).toEqual(["A.png"]);
    const top = imagesBeside(release("g/release/", ["g/images/HD/B.png", "g/images/C.png"]), "g/release/");
    expect(top?.folder).toBe("g/images/");
    expect([...top!.images.keys()].sort()).toEqual(["C.png", "HD/B.png"]);
    expect(imagesBeside(release("g/release/", ["g/video.mp4"]), "g/release/")).toBeNull();
  });

  it("taken from beside a release go with it; images the visitor chose stay", () => {
    const a = release("a/release/", ["a/images/A.png"]);
    const b = release("b/release/", ["b/images/B.png"]);
    const plain = release("c/release/");
    const fromA = imagesForRelease(null, a, "a/release/");
    expect(fromA).toMatchObject({ folder: "a/images/", auto: true });
    expect([...fromA!.images.keys()]).toEqual(["A.png"]);
    // Release B: A's images give way to B's, and to none when B has none beside it.
    const fromB = imagesForRelease(fromA, b, "b/release/");
    expect(fromB).toMatchObject({ folder: "b/images/", auto: true });
    expect([...fromB!.images.keys()]).toEqual(["B.png"]);
    expect(imagesForRelease(fromA, plain, "c/release/")).toBeNull();
    // Images chosen with the images button stay, whatever release folder follows.
    const chosen = { ...imagesFrom(folder("cards/X.png")), auto: false };
    expect(imagesForRelease(chosen, b, "b/release/")).toBe(chosen);
    // A typed address: images taken from beside a folder go, chosen ones stay.
    expect(imagesForAddress(fromA)).toBeNull();
    expect(imagesForAddress(chosen)).toBe(chosen);
    expect(imagesForAddress(null)).toBeNull();
  });

  it("are keyed by their path in a folder chosen for them alone", () => {
    const chosen = imagesFrom(folder("cards/A.png", "cards/HD/B.png"));
    expect(chosen.folder).toBe("cards/");
    expect([...chosen.images.keys()]).toEqual(["A.png", "HD/B.png"]);
  });

  it("give a card its image as a server does: the path with its folders, then the bare name", () => {
    const { images } = imagesFrom(folder("cards/HD/SET-001.jpg", "cards/SET-002.jpg", "cards/SET 003.png"));
    expect(localArt(images, "HD/SET-001.jpg")?.path).toBe("HD/SET-001.jpg");
    // A catalog path with a folder, in a folder that holds every image flat: the bare name.
    expect(localArt(images, "art/SET-002.jpg")?.path).toBe("SET-002.jpg");
    expect(localArt(images, "./SET-002.jpg")?.path).toBe("SET-002.jpg");
    expect(localArt(images, "https://example.com/cards/SET%20003.png")?.path).toBe("SET 003.png");
    expect(localArt(images, "SET-001.jpg")).toBeNull();
    expect(localArt(images, undefined)).toBeNull();
    // What the Python tools refuse finds nothing.
    for (const refused of ["../SET-002.jpg", "/SET-002.jpg", "HD\\SET-001.jpg", "HD/"]) expect(localArt(images, refused), refused).toBeNull();
  });
});

describe("what the page says of a release read from this computer", () => {
  const report = (state: "loading" | "failed", loading: { phase: "downloading" | "preparing"; bytes: number | null } | null = null, error: string | null = null) => ({ state, error, release: null, loading });

  it("reads the files, it does not download them", () => {
    const text = (loading: Parameters<typeof report>[1]) => demoView(modelOf("my-game/release/release.json", report("loading", loading), "your models", true), { kind: "none" }).state.text;
    expect(text({ phase: "downloading", bytes: null })).toBe("Reading your models…");
    expect(text({ phase: "downloading", bytes: 3_200_000 })).toBe("Reading your models (about 3 MB)…");
    expect(text({ phase: "preparing", bytes: null })).toBe("Preparing your models…");
    // A release at an address is still downloaded.
    expect(demoView(modelOf("/release/release.json", report("loading", { phase: "downloading", bytes: null })), { kind: "none" }).state.text).toBe("Downloading the model…");
  });

  it("asks for the folder again when the release did not load, with the reason", () => {
    const failed = modelOf("my-game/release/release.json", report("failed", null, "detector: sha256 of detector.onnx does not match the release"), "your models", true);
    expect(failed).toEqual({ kind: "failed", address: "my-game/release/release.json", reason: "detector: sha256 of detector.onnx does not match the release", local: true });
    expect(demoView(failed, { kind: "none" }).modelProblem).toBe("Could not load the release in my-game/release/release.json (detector: sha256 of detector.onnx does not match the release). Choose the release folder again.");
  });
});
