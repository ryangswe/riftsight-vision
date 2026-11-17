// SPDX-License-Identifier: Apache-2.0
// A local page with one plain <video>, for checking the extension by hand (or headlessly) on a
// video file of your own. No footage is kept in the toolkit: you name the file.
//
//   node serve.mjs --video /path/to/clip.mp4 [--port 8770]
//
// It listens on 127.0.0.1 only and serves two things: the page (/) and the file (/video, with
// range requests so the video can seek). Only a dev build of the extension runs on this page.

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const TYPES = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".ogv": "video/ogg" };

// The page: one video element with the same styles as the products' manual page, with neutral text.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Manual test page</title>
<style>
  body { margin: 0; padding: 16px; font: 14px/1.4 system-ui, sans-serif; background: #111; color: #ddd; }
  video { display: block; width: min(1280px, 100%); background: #000; }
  p { max-width: 1280px; }
</style>
</head>
<body>
<p>Manual test page. Load a dev build of the extension, then rest the pointer on a face-up card in the video.</p>
<video id="video" src="/video" controls muted loop playsinline></video>
</body>
</html>
`;

export function startServer({ video, port = 8770 }) {
  const page = PAGE;
  const size = statSync(video).size;
  const type = TYPES[extname(video).toLowerCase()] ?? "application/octet-stream";
  const server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page);
      return;
    }
    if (path !== "/video") {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (!(start >= 0 && start <= end)) {
        res.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
      if (req.method === "HEAD") res.end();
      else createReadStream(video, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
    if (req.method === "HEAD") res.end();
    else createReadStream(video).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { video: { type: "string" }, port: { type: "string", default: "8770" } } });
  if (!values.video) {
    console.error("usage: node serve.mjs --video /path/to/clip.mp4 [--port 8770]");
    process.exit(2);
  }
  const server = await startServer({ video: values.video, port: Number(values.port) });
  const { port } = server.address();
  console.log(`test page: http://127.0.0.1:${port}/ (video: ${values.video})`);
}
