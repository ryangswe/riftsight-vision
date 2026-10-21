// SPDX-License-Identifier: Apache-2.0
// The options of the local server (scripts/demo-server.mjs), of the hosted demo's build and
// preview (scripts/build-pages.mjs, scripts/pages-preview.mjs) and of the headless example
// (examples/score-headless.mjs). No browser is started here.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const fileOf = (name: string): string => fileURLToPath(new URL(`../${name}`, import.meta.url));
const run = (script: string, ...args: string[]) => spawnSync(process.execPath, [fileOf(script), ...args], { encoding: "utf-8" });

describe("the local server", () => {
  const SERVER = "scripts/demo-server.mjs";

  it("prints its options for --help and exits with 0", () => {
    const done = run(SERVER, "--help");
    expect(done.status).toBe(0);
    expect(done.stderr).toBe("");
    expect(done.stdout).toContain("Usage: npm run demo -- [--release FOLDER] [--images FOLDER] [--port N]");
    for (const name of ["--release FOLDER", "--images FOLDER", "--port N", "--help"]) expect(done.stdout).toContain(`\n  ${name}`);
    expect(run(SERVER, "--release", "somewhere", "-h").status).toBe(0);
  });

  it("refuses an option it does not know, with its options, and does not start", () => {
    const done = run(SERVER, "--verbose");
    expect(done.status).toBe(2);
    expect(done.stdout).toBe("");
    expect(done.stderr).toMatch(/^unknown option --verbose\n\nUsage: npm run demo/);
    expect(run(SERVER, "release", "somewhere").stderr).toMatch(/^unknown option release\n/);
  });

  it("refuses an option without a value, and a port that is not one", () => {
    expect(run(SERVER, "--port").stderr).toMatch(/^--port needs a value\n/);
    for (const port of ["abc", "-1", "8765.5", "70000"]) {
      const done = run(SERVER, "--port", port);
      expect([done.status, done.stderr.split("\n")[0]], port).toEqual([2, `--port ${port}: not a port number (0 to 65535)`]);
    }
    expect(run(SERVER, "--release", fileOf("no-such-folder")).stderr).toContain("no such folder");
  });

  it("listens on the port it is given, and on a free one for --port 0", async () => {
    if (!existsSync(fileOf("dist/demo/index.html"))) {
      // Not built: the server says so and does not start. (`npm run demo` builds first.)
      expect(run(SERVER, "--port", "0").stderr).toContain("dist/demo is missing: run `npm run build` first");
      return;
    }
    const server = spawn(process.execPath, [fileOf(SERVER), "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const said = await new Promise<string>((resolve, reject) => {
        let text = "";
        server.stdout.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          if (text.includes("no --release folder")) resolve(text);
        });
        server.on("exit", () => reject(new Error(`the server stopped: ${text}`)));
      });
      const port = Number(/^demo: http:\/\/127\.0\.0\.1:(\d+)\/$/m.exec(said)?.[1]);
      expect(port).toBeGreaterThan(0);
      expect(said).toContain(`scoring page: http://127.0.0.1:${port}/score.html`);
      const config = await (await fetch(`http://127.0.0.1:${port}/config.json`)).json();
      expect(config).toEqual({ release: false, images: false });
      expect((await fetch(`http://127.0.0.1:${port}/score.html`)).status).toBe(200);
    } finally {
      server.kill();
    }
  });

  /** A folder with a made-up picture, a release folder and an image folder. No real image is needed: the server reads names. */
  const madeUp = (): { root: string; picture: string; release: string; images: string } => {
    const root = mkdtempSync(join(tmpdir(), "cardvision-demo-"));
    const made = { root, picture: join(root, "my table.png"), release: join(root, "release"), images: join(root, "art") };
    mkdirSync(made.release);
    mkdirSync(made.images);
    writeFileSync(made.picture, "not really a picture");
    writeFileSync(join(made.release, "release.json"), "{}");
    writeFileSync(join(made.release, "table.png"), "another file");
    writeFileSync(join(root, "notes.txt"), "not a picture by its name");
    return made;
  };

  it("refuses a --geometric file that is not there, and serves the folder of one that is", async () => {
    const made = madeUp();
    try {
      const missing = run(SERVER, "--geometric", join(made.root, "none.json"));
      expect([missing.status, missing.stderr.trimEnd()]).toEqual([2, `--geometric ${join(made.root, "none.json")}: no such file`]);
      expect(run(SERVER, "--help").stdout).toContain("\n  --geometric FILE");
      if (!existsSync(fileOf("dist/demo/index.html"))) return; // Not built: see the test of --port above.
      const stageFolder = join(made.root, "stage");
      mkdirSync(join(stageFolder, "packed"), { recursive: true });
      writeFileSync(join(stageFolder, "settings.json"), "{}");
      writeFileSync(join(stageFolder, "packed", "manifest.json"), "[]");
      const server = spawn(process.execPath, [fileOf(SERVER), "--release", made.release, "--geometric", join(stageFolder, "settings.json"), "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
      try {
        const said = await new Promise<string>((resolveSaid, reject) => {
          let text = "";
          server.stdout.on("data", (chunk: Buffer) => {
            text += chunk.toString();
            if (text.includes("geometric stage: ")) resolveSaid(text);
          });
          server.on("exit", () => reject(new Error(`the server stopped: ${text}`)));
        });
        const origin = `http://127.0.0.1:${/^demo: http:\/\/127\.0\.0\.1:(\d+)\/$/m.exec(said)?.[1]}`;
        expect(await (await fetch(`${origin}/config.json`)).json()).toEqual({ release: true, images: false, geometric: "/geometric/settings.json" });
        expect(await (await fetch(`${origin}/geometric/packed/manifest.json`)).text()).toBe("[]");
        expect((await fetch(`${origin}/geometric/..%2Frelease%2Frelease.json`)).status).toBe(404);
      } finally {
        server.kill();
      }
    } finally {
      rmSync(made.root, { recursive: true, force: true });
    }
  });

  it("lists --file among its options", () => {
    const done = run(SERVER, "--help");
    expect(done.stdout).toContain("Usage: npm run demo -- [--release FOLDER] [--images FOLDER] [--port N] [--file PATH]");
    expect(done.stdout).toContain("\n  --file PATH");
  });

  it("refuses a --file it cannot serve, and one without a release, before it starts", () => {
    const made = madeUp();
    try {
      const refused = (...args: string[]): string => {
        const done = run(SERVER, ...args);
        expect([done.status, done.stdout], args.join(" ")).toEqual([2, ""]);
        return done.stderr.trimEnd();
      };
      expect(refused("--file")).toMatch(/^--file needs a value\n/);
      expect(refused("--release", made.release, "--file", join(made.root, "none.png"))).toBe(`--file ${join(made.root, "none.png")}: no such file`);
      expect(refused("--release", made.release, "--file", made.images)).toBe(`--file ${made.images}: no such file`);
      expect(refused("--release", made.release, "--file", join(made.root, "notes.txt"))).toMatch(/notes\.txt: not a video or image file by its name \(the page shows \.png, .*\.mp4, .*\)$/);
      expect(refused("--release", made.release, "--file", join(made.release, "release.json"))).toContain("not a video or image file by its name");
      expect(refused("--file", made.picture)).toBe(`--file ${made.picture}: needs --release, since the page cannot start on a file without a release`);
    } finally {
      rmSync(made.root, { recursive: true, force: true });
    }
  });

  it("serves a --file at one path of its own, and nothing else there", async () => {
    const paths = await import(pathToFileURL(fileOf("scripts/demo-paths.mjs")).href);
    const served = paths.servedFile("some/folder/my table.png");
    expect(served).toEqual({ file: resolve("some/folder/my table.png"), name: "my table.png", path: "/file/my%20table.png", type: "image/png" });
    expect(paths.servedFile("clip.WEBM").type).toBe("video/webm");
    for (const name of ["notes.txt", "release.json", "worker.js", "page.html", "no-extension"]) expect(paths.servedFile(name).problem, name).toContain("not a video or image file");
    // The path is compared after the request's path is percent-decoded, as the server does.
    expect(paths.fileAt(served, "/file/my table.png")).toBe(served.file);
    const others = [
      "/file/", "/file", "/file/other.png", "/file/my table.png/", "/file/my table.png/x", "/file/../my table.png", "/file/./my table.png",
      "/file/my%20table.png", "/file//my table.png", "/file/MY TABLE.PNG", "/my table.png", "/release/my table.png", `/file/${served.file}`,
    ];
    for (const path of others) expect(paths.fileAt(served, path), path).toBeNull();
    expect(paths.fileAt(null, "/file/my table.png")).toBeNull();
    // A folder keeps a request inside itself; the one file has no folder to leave.
    expect(paths.inside("/srv/release", "release.json")).toBe(resolve("/srv/release/release.json"));
    for (const path of ["../secret", "a/../../secret"]) expect(paths.inside("/srv/release", path), path).toBeNull();
    // The image folder alike: a card image's folders are kept, and a path that leaves it is refused.
    const image = (path: string) => paths.inside("/srv/images", path.slice(paths.IMAGES_BASE.length));
    expect(image("/images/HD/SET-001.jpg")).toBe(resolve("/srv/images/HD/SET-001.jpg"));
    for (const path of ["/images/../release/release.json", "/images/HD/../../secret", "/images/..\\secret", "/images//etc/passwd"]) {
      const file = image(path);
      expect(file === null || file.startsWith(resolve("/srv/images") + sep), path).toBe(true);
    }
    expect(image("/images/../release/release.json")).toBeNull();
    expect(paths.fileAddress("http://127.0.0.1:8765", served, true)).toBe("http://127.0.0.1:8765/?file=/file/my%20table.png&images=/images/");
    expect(paths.fileAddress("http://127.0.0.1:8765", served, false)).toBe("http://127.0.0.1:8765/?file=/file/my%20table.png");
  });

  it("started with --file, prints the address that opens it and answers for that file only", async () => {
    if (!existsSync(fileOf("dist/demo/index.html"))) return; // Not built: see the test of --port above.
    const made = madeUp();
    const server = spawn(process.execPath, [fileOf(SERVER), "--release", made.release, "--images", made.images, "--file", made.picture, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const said = await new Promise<string>((resolveSaid, reject) => {
        let text = "";
        server.stdout.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          if (text.includes("open the file in the demo: ")) resolveSaid(text);
        });
        server.on("exit", () => reject(new Error(`the server stopped: ${text}`)));
      });
      const origin = /^demo: (http:\/\/127\.0\.0\.1:\d+)\/$/m.exec(said)?.[1];
      expect(said.trimEnd().split("\n").slice(2)).toEqual([
        `release folder: ${resolve(made.release)} (served at /release/)`,
        `image folder: ${resolve(made.images)} (served at /images/; the demo page shows card images from it)`,
        `file: ${resolve(made.picture)} (served at /file/my%20table.png)`,
        `open the file in the demo: ${origin}/?file=/file/my%20table.png&images=/images/`,
      ]);
      expect(await (await fetch(`${origin}/config.json`)).json()).toEqual({ release: true, images: true, file: "/file/my%20table.png" });
      const page = await fetch(`${origin}/?file=/file/my%20table.png&images=/images/`);
      expect([page.status, page.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
      const file = await fetch(`${origin}/file/my%20table.png`);
      expect([file.status, file.headers.get("content-type"), await file.text()]).toEqual([200, "image/png", "not really a picture"]);
      // Nothing else is under /file/: not another name, not the folder the file is in, not a way out of it.
      const others = ["/file/", "/file/other.png", "/file/notes.txt", "/file/my%20table.png/x", "/file/..%2Fnotes.txt", "/file/%2e%2e/notes.txt", "/file/table.png", "/file/release/release.json"];
      for (const path of others) expect([(await fetch(`${origin}${path}`)).status, path]).toEqual([404, path]);
      expect((await fetch(`${origin}/file/my%20table.png`, { method: "POST" })).status).toBe(405);
    } finally {
      server.kill();
      rmSync(made.root, { recursive: true, force: true });
    }
  });
});

describe("the headless example", () => {
  const EXAMPLE = "examples/score-headless.mjs";

  it("is a script Node can read", () => {
    const done = spawnSync(process.execPath, ["--check", fileOf(EXAMPLE)], { encoding: "utf-8" });
    expect([done.status, done.stderr]).toEqual([0, ""]);
  });

  it("prints its options for --help and exits with 0, whether or not puppeteer-core is installed", () => {
    const done = run(EXAMPLE, "--help");
    expect(done.status).toBe(0);
    expect(done.stderr).toBe("");
    expect(done.stdout).toContain("Usage: node examples/score-headless.mjs --chrome PATH --release FOLDER");
    for (const name of ["--chrome PATH", "--release FOLDER", "--manifest FILE", "--video FILE", "--video-index FILE", "--role ROLE", "--backend NAME", "--out FILE", "--chrome-arg ARG", "--help"]) {
      expect(done.stdout).toContain(`\n  ${name}`);
    }
    expect(done.stdout).toContain("npm install --no-save puppeteer-core");
  });

  it("refuses what it cannot run, with its options, before it starts anything", () => {
    const refused = (...args: string[]): string => {
      const done = run(EXAMPLE, ...args);
      expect([done.status, done.stdout], args.join(" ")).toEqual([2, ""]);
      expect(done.stderr).toContain("\n\nUsage: node examples/score-headless.mjs");
      return done.stderr.split("\n")[0]!;
    };
    const here = fileOf("package.json");
    const folder = fileOf("examples");
    expect(refused("--headed")).toBe("unknown option --headed");
    expect(refused("--chrome")).toBe("--chrome needs a value");
    expect(refused("--release", folder, "--manifest", here, "--video", here)).toBe("--chrome is required");
    expect(refused("--chrome", here, "--release", folder, "--manifest", here)).toBe("--video is required");
    expect(refused("--chrome", here, "--release", folder, "--manifest", here, "--video", here, "--role", "test")).toBe("--role test: choose evaluation, train or extra");
    expect(refused("--chrome", here, "--release", folder, "--manifest", here, "--video", here, "--backend=cuda")).toBe("--backend cuda: choose webgpu or wasm");
    expect(refused("--chrome", here, "--release", here, "--manifest", here, "--video", here)).toBe(`--release ${here}: no such folder`);
    expect(refused("--chrome", fileOf("no-such-chrome"), "--release", folder, "--manifest", here, "--video", here)).toBe(`${fileOf("no-such-chrome")}: no such file`);
  });
});

describe("the hosted demo's build and preview", () => {
  const BUILD = "scripts/build-pages.mjs";
  const PREVIEW = "scripts/pages-preview.mjs";

  it("print their options for --help, and refuse what they cannot run before they start", () => {
    for (const script of [BUILD, PREVIEW]) {
      const done = run(script, "--help");
      expect([done.status, done.stderr], script).toEqual([0, ""]);
      expect(done.stdout).toMatch(/^Usage: npm run (build|preview):pages -- /);
      expect(run(script, "--verbose").stderr, script).toMatch(/^unknown option --verbose\n\nUsage: /);
    }
    expect(run(BUILD).stderr).toMatch(/^give one of --release-url \(the address of a release document, or "" for a page with no model\) and --games\n/);
    expect(run(BUILD, "--release-url", "", "--games", "toy").stderr).toMatch(/^give one of --release-url .* and --games\n/);
    expect(run(BUILD, "--release-url").stderr).toMatch(/^--release-url needs a value\n/);
    const refused = run(BUILD, "--release-url", "http://example.org/release.json", "--out", join(tmpdir(), "never-built"));
    expect([refused.status, refused.stderr]).toEqual([2, "--release-url http://example.org/release.json: the release must be served over https (http only on this machine, for a preview)\n"]);
    expect(existsSync(join(tmpdir(), "never-built"))).toBe(false);
    expect(run(PREVIEW).stderr).toMatch(/^give one of --release FOLDER, --release-url URL and --games LIST\n/);
    expect(run(PREVIEW, "--release", "a", "--release-url", "b").stderr).toMatch(/^give one of --release FOLDER, --release-url URL and --games LIST\n/);
    expect(run(PREVIEW, "--games", "toy", "--release-url", "b").stderr).toMatch(/^give one of --release FOLDER, --release-url URL and --games LIST\n/);
    // A game picker that names the toy game needs its folder, and names only games the build knows.
    const noToy = run(BUILD, "--games", "toy,one-piece", "--out", join(tmpdir(), "never-built"));
    expect([noToy.status, noToy.stderr]).toEqual([2, "--games names toy: give --toy FOLDER, the toy game's folder. python tests/test_browser_fixtures.py --demo FOLDER (run from the repository's root) writes it\n"]);
    expect(run(BUILD, "--games", "toy,chess", "--toy", "x").stderr).toBe("--games toy,chess: chess is not a game this build knows (toy, one-piece, local)\n");
    expect(existsSync(join(tmpdir(), "never-built"))).toBe(false);
    expect(run(PREVIEW, "--release", fileOf("no-such-folder")).stderr).toContain("no such folder");
    expect(run(PREVIEW, "--release-url", "", "--release-port", "x").stderr).toMatch(/^--release-port x: not a port number/);
  });

  it("serve the built site as it is, and the release folder on another origin as a model host does", async () => {
    const root = mkdtempSync(join(tmpdir(), "cardvision-pages-"));
    const release = join(root, "release");
    const out = join(root, "site");
    mkdirSync(release);
    writeFileSync(join(release, "release.json"), '{"made":"up"}');
    const server = spawn(process.execPath, [fileOf(PREVIEW), "--release", release, "--port", "0", "--release-port", "0", "--out", out], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const said = await new Promise<string>((resolveSaid, reject) => {
        let text = "";
        server.stdout.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          if (text.includes("the page loads its model from")) resolveSaid(text);
        });
        server.on("exit", () => reject(new Error(`the preview stopped: ${text}`)));
      });
      const releaseOrigin = /^release folder: .* \(served at (http:\/\/127\.0\.0\.1:\d+)\/, with Access-Control-Allow-Origin: \*\)$/m.exec(said)?.[1];
      const pageOrigin = /^hosted demo: (http:\/\/127\.0\.0\.1:\d+)\/ /m.exec(said)?.[1];
      expect(releaseOrigin && pageOrigin && releaseOrigin !== pageOrigin).toBeTruthy();
      expect(said).toContain(`as npm run build:pages -- --release-url ${releaseOrigin}/release.json writes them)`);
      expect(said.trimEnd().split("\n").at(-1)).toBe(`the page loads its model from ${releaseOrigin}/release.json`);
      // The site, byte for byte as built; the page names the release folder's document.
      const page = await fetch(`${pageOrigin}/`);
      const html = await page.text();
      expect([page.status, page.headers.get("access-control-allow-origin")]).toEqual([200, null]);
      expect(html).toBe(readFileSync(join(out, "index.html"), "utf-8"));
      expect(html).toContain(`<meta name="cardvision-release" content="${releaseOrigin}/release.json">`);
      const worker = await fetch(`${pageOrigin}/lib/worker.js`);
      expect(Buffer.from(await worker.arrayBuffer()).equals(readFileSync(join(out, "lib", "worker.js")))).toBe(true);
      for (const path of ["/score.html", "/config.json", "/release/release.json", "/../release/release.json"]) expect([(await fetch(`${pageOrigin}${path}`)).status, path]).toEqual([404, path]);
      // The release, from another origin, with the header a model host sends.
      const document = await fetch(`${releaseOrigin}/release.json`);
      expect([document.status, document.headers.get("access-control-allow-origin"), await document.text()]).toEqual([200, "*", '{"made":"up"}']);
      expect((await fetch(`${releaseOrigin}/release.json`, { method: "POST" })).status).toBe(405);
    } finally {
      server.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
