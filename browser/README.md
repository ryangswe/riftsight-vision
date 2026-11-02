<!-- SPDX-License-Identifier: Apache-2.0 -->
# cardvision in a browser

**Newcomers:** steps 1 to 3 of [The demo page](#the-demo-page) are all you need. The rest of
this file is for integrators: the tests and build, the hosted demo, the scoring page and the API.

The recognition pipeline of this repository as a TypeScript package that runs in a web page:
the same detector, recognizer, bank, accept rule and hover rule as the Python package
`cardvision`, loaded from the same release document, on ONNX Runtime Web (WebGPU, with a
WebAssembly fallback).

It answers one question: **with the pointer at this position over a video or an image, which
card would be shown?** The answer is a name, a card id and a box, or nothing.

**What this is not.** It is not a browser extension and it does not attach to any website. The
demo page shows what the pipeline would display under the pointer on a video or image file from
your own disk, and that is all it does. The scoring page measures the same thing on labeled
frames of video files from your own disk. Figures measured with the Python package are not
figures for this runtime: see "Python and the browser" below.

No model, no card image and no video is kept here. You bring a release folder (a release
document and the files it pins, as `cardvision build-release` writes them) and a file to look at.

## Run it

Node 22 or later. On Windows, everything here runs in Ubuntu under WSL: see "Which computer?"
in the [quickstart](../docs/quickstart.md). Everything below is run in this
folder (`browser/`), unless a step says otherwise. A block after "Paste this into the terminal"
holds commands to copy and paste whole; a block after "You should see something like" is what
they print, which you do not type.

Paste this into the terminal, in `browser/`:

```
npm ci
npm test
npm run build
```

Among other lines, you should see something like:

```
added 58 packages, and audited 59 packages in 4s
 Test Files  N passed (N)
      Tests  N passed | 6 skipped (N)
dist/cardvision.js 902 KB, dist/worker.js 920 KB, dist/demo/demo.js 44 KB, dist/demo/score.js 30 KB, 8 ONNX Runtime files copied
OpenCV.js NOT copied: vendor/opencv/ lacks opencv.mjs, opencv_js.wasm, opencv.mjs.LEGAL.txt (build it with node scripts/build-opencv.mjs --work FOLDER). This build runs without the geometric stage: asked for, it reports itself off.
```

The counts grow as tests are added: what matters is that the `Test Files` and `Tests` lines
say `passed` with no `failed`. That run had no OpenCV.js built: the six tests that need it are skipped, with the reason in
their name, and the build says `OpenCV.js NOT copied` and builds the rest. With OpenCV.js built
into `vendor/opencv/` (see "The geometric stage"), those tests run and the build copies it,
`OpenCV.js copied: dist/opencv.mjs, dist/opencv_js.wasm 3326 KB, dist/opencv.mjs.LEGAL.txt`.
npm also prints lines of its own, such as `npm warn install-scripts 3 packages have install
scripts not yet covered by allowScripts` (esbuild, fsevents, protobufjs; npm 11) and an
`npm notice` that a new major version of npm is available: both are harmless. Times and sizes
may differ a little on your machine.

`npm test` type-checks (TypeScript, strict) and runs the tests with vitest. `npm run build`
bundles with esbuild into `dist/`, which is not kept in the repository:

| File | What it is |
| --- | --- |
| `dist/cardvision.js` | The public API, one ES module, ONNX Runtime Web included |
| `dist/worker.js` | The analysis worker a session starts |
| `dist/compute-session.js`, `dist/page-capture.js` | The two halves of a session for a browser extension (experimental, not part of the public API): see "For an extension" below. No ONNX Runtime, WebAssembly or OpenCV inside |
| `dist/remote-release.js` | Remote releases for a browser extension (experimental, not part of the public API): [docs/remote-releases.md](../docs/remote-releases.md) |
| `dist/ort-wasm-*` | ONNX Runtime Web's WebAssembly files and their loaders, copied from `node_modules` |
| `dist/opencv.mjs`, `dist/opencv_js.wasm`, `dist/opencv.mjs.LEGAL.txt` | OpenCV.js for the geometric stage and its licenses, copied from `vendor/opencv/` when it has been built; the worker imports it only when a stage is asked for |
| `dist/demo/` | The demo page, the scoring page beside it (`score.html`), and their style sheets |
| `dist/pages/` | The hosted demo, a static site, when `npm run build:pages` has been run: see "The hosted demo" |
| `dist/*.LEGAL.txt` | The license comments of the bundled third-party code |
| `dist/THIRD-PARTY-NOTICES.txt` | The full license texts of that code: ONNX Runtime Web (MIT), and the Apache-2.0 code inside it |

## The demo page

The demo needs a release folder. To try it without trained models, the test suite can write a
toy one into a work folder, `cardvision-toy` in your Downloads folder. It is outside the
repository on purpose, because the repository must hold no images and no model files, and you
can delete it when you are done. It is the same folder as the [quickstart](../docs/quickstart.md)'s.

**1. Write the toy release.** This needs the Python environment of the
[quickstart](../docs/quickstart.md) (its step 1, Install). From the repository's root (if you are in `browser/`, run
`cd ..` first), paste this into the terminal:

```
. .venv/bin/activate
export WORK="$HOME/Downloads/cardvision-toy"
mkdir -p "$WORK"
python tests/test_browser_fixtures.py --demo "$WORK/demo"
```

You should see something like:

```
wrote $WORK/demo/release/release.json, $WORK/demo/art and $WORK/demo/table.png
the cards on the table: Amber Circle, Coral Triangle, Azure Circle, Slate Stripes, Amber Stripes, and a card back
OpenCV: FFMPEG: tag 0x30385056/'VP80' is not supported with codec id 139 and format 'webm / WebM'
for the scoring page: $WORK/demo/table.webm and $WORK/demo/labels/table.manifest.jsonl (3 rows)
```

The `OpenCV: FFMPEG` line is a harmless note from the video writer: the video is written. The
terminal shows the full path where this page writes `$WORK`,
`/Users/YOU/Downloads/cardvision-toy/demo/...` on a Mac. To look at the folder, paste
`open "$WORK/demo"` into the terminal on macOS, `xdg-open "$WORK/demo"` on Linux, and
`(cd "$WORK/demo" && explorer.exe .)` in Ubuntu on Windows. Running this step again replaces the
files it wrote.
To start over from nothing, delete the whole folder with
`rm -rf "$HOME/Downloads/cardvision-toy"`: that deletes everything in it at once and does not
ask, so keep nothing of your own in it.

Its models are stand-ins with no skill, as in `examples/toy_quickstart.py`: the detector does
not look at the image, it returns the boxes of the cards in `table.png`. It shows that the
page works, not how well the released models do.

**2. Start the demo on the toy table.** Paste this into the same terminal, from the
repository's root (the first line moves into `browser/`, the second installs the
packages, which takes a few seconds):

```
cd browser
npm ci
npm run demo -- --release "$WORK/demo/release" --images "$WORK/demo/art" --file "$WORK/demo/table.png"
```

After npm's own lines, you should see something like:

```
> cardvision-browser@0.1.0 demo
> node scripts/build.mjs && node scripts/demo-server.mjs --release $WORK/demo/release --images $WORK/demo/art --file $WORK/demo/table.png

dist/cardvision.js 902 KB, dist/worker.js 920 KB, dist/demo/demo.js 44 KB, dist/demo/score.js 30 KB, 8 ONNX Runtime files copied
OpenCV.js NOT copied: vendor/opencv/ lacks opencv.mjs, opencv_js.wasm, opencv.mjs.LEGAL.txt (build it with node scripts/build-opencv.mjs --work FOLDER). This build runs without the geometric stage: asked for, it reports itself off.
demo: http://127.0.0.1:8765/
scoring page: http://127.0.0.1:8765/score.html
release folder: $WORK/demo/release (served at /release/)
image folder: $WORK/demo/art (served at /images/; the demo page shows card images from it)
file: $WORK/demo/table.png (served at /file/table.png)
open the file in the demo: http://127.0.0.1:8765/?file=/file/table.png&images=/images/
```

The `OpenCV.js NOT copied` line is expected: OpenCV.js is an optional build, for the geometric
stage. npm also prints lines of its own, such as `npm warn install-scripts` notes (esbuild,
fsevents, protobufjs) and an `npm notice` that a new major version of npm is available: both are
harmless. If it says `port 8765 is in use`, a demo server is already running in another
terminal: stop that one first. The server keeps running, and the terminal stays busy until you
stop it: press Control-C in the terminal when you are done.

**3. Open the address on the last line,**
`http://127.0.0.1:8765/?file=/file/table.png&images=/images/`, in Chrome, Edge or another
browser (on a Mac, ⌘-click it in the terminal). The page opens the toy table at once, with no
file to find: under the picture it says `table.png` and
`opened from this page's address (/file/table.png on the local server)`, and the state line
says `Ready. Move over a face-up card.` Under it one line names the model,
`Model: toy · 20 cards`.

**Without `--file`**, the server prints no last line, and the page at `http://127.0.0.1:8765/`
is one large drop zone, `Drop a video or image here`, with one button, `Choose a file…`. The
state line says `Model loaded. Choose a file.` There is no Start button: drop a picture or a
video of your own on the drop zone, or choose it with the button, and the page says
`Ready. Move over a face-up card.`

Move the pointer over a card. Its box is outlined, and a tooltip shows its image, its name and
its id. Over the card back, and over the bare table, nothing is shown. That is a normal answer,
and the page says nothing more about it. With the pointer on the first card, you should see
something like this on the line under the picture:

```
Ready. Move over a face-up card. · WebGPU · 41 ms per frame · 6 cards found
```

That is the state, the backend, the worker's time for the newest frame, and how many cards
that frame holds, faces and backs. `Details`, below it, opens the same facts at length, laid
out to be read at a glance:

- one line that says what the page is doing: nothing loaded yet, loading the model, model
  loaded with no file, running, or what went wrong;
- four figures of the newest analyzed frame: the cards found (named, not named, backs), the
  worker's time per frame with its detect and recognize parts and a line of the last 30
  frames' times, the backend, and the frames analyzed;
- the frame's detections in a table: each box's card name and id (for a face that is not
  named, the nearest card), the score and the margin the accept rule compared, and its
  answer. The row of the card under the pointer is marked;
- the model (release id, game, cards, detector and recognizer versions, address) and the file
  (name, size in pixels, and a video's length);
- **Copy diagnostics**, which copies the text panel below, for a bug report;
- **Raw text**, closed: the text panel (the element `panel`), the lines the page has always
  printed.

A figure the session does not report is shown as a dash, never guessed. For a file chosen with
the button, you should see something like this in the text panel (with `--file`, its `file:`
line also says where the file came from, as in "Opening a file with no file chooser" below):

```
state: ready
file: table.png
model: /release/release.json
release: 176e5b5cfd5c89ef (toy, 20 cards in the bank)
backend: detector on webgpu, recognizer on webgpu
ONNX Runtime Web: the release was measured on 1.29.0
hover selection: accepted-nms; a result is shown for at most 2000 ms of video
schedule: fast
frames analyzed: 3
last frame: 40.9 ms in the worker, 41.6 ms from capture to result
analyzed at 1280 x 768: 6 boxes, 5 faces, 5 named
  detector 26.1 ms, recognizer 7.9 ms, 8 embeddings
under the pointer: Amber Circle (TOY-001)
```

Your release id will differ if your package versions do: it is a hash of the content. The times
are those of the stand-in models on one laptop, in headless Chrome 155, and say nothing about
real models.

A video starts playing without sound and repeats. Its own controls pause it, seek in it and
turn the sound on. Frames are analyzed around pointer activity. A seek takes the name off the
screen until the frame after it has been analyzed.

**What the page says, and when.** It keeps two things apart, the model and the file, so that
one cannot hide the other.

| The state line | When |
| --- | --- |
| `Loading the model…` | The release is loading. A file can be chosen meanwhile. |
| `Model loaded. Choose a file.` | A model has loaded and no file is open. |
| `Opening NAME…` | The browser is decoding the file. |
| `Ready. Move over a face-up card.` | A model has loaded **and** the file decoded to a picture. Nothing else reads as ready. |
| `The file did not open.` | The browser cannot decode the file as an image or a video. The drop zone says which file: `fake.png is not a picture or video this browser can open. Choose another file.`; for a video, it adds the `ffmpeg` command that converts that file to H.264. A video that OpenCV reads may still be in a codec browsers do not play (MPEG-4 Part 2, for one): convert it with `ffmpeg -i in.mp4 -c:v libx264 -pix_fmt yuv420p video.mp4` (install ffmpeg with `brew install ffmpeg`, `sudo apt install ffmpeg` or `winget install ffmpeg`, or export an H.264 MP4 from your video editor) |
| `The model did not load.` | The release did not load. Beside the model line the page gives the address and the reason, `Could not load the model at /release/nope.json (release: HTTP 404). Check the address, then press Retry.`, and opens the address field with a `Retry` button. The file stays on show. No name, no outline and no figure of the model before it stays on screen. |
| `No model loaded.` | The page knows no release address: see below. |
| `The last frame was not analyzed (REASON).` | The worker gave no result for the newest frame. |

Each state has a mark of its own shape before its words, so that none rests on color.

**Without a release folder** the server prints `no --release folder: the demo page asks for the
address of a release document`, and the page leads with `Load a model`: one sentence, a
`Release address` field, a `Load` button, the folder buttons of "Your game" below (**Choose the
release folder…** and **Choose the card images folder…**), and the command that starts the
server with a release folder, which is the simpler way. Once a model has loaded, that step folds
into the model line and the drop zone leads.

What the page's controls do:

- **Choose a file…**, and **Change file** once one is open: a file from your disk. It is
  shown and processed in the page; the demo's code does not upload its contents. A file
  dropped on the stage does the same. When the
  page's address names the server's `--file`, that file is open until you choose another.
- **Show detected boxes**: an outline on every detected box. Named faces have a solid green
  line, other faces a dashed amber one, backs a dotted gray one.
- **Model: … Change**: opens the `Release address` field and the folder buttons. `Load` starts
  again with the model at that address, on the file that is open; a folder chosen does the same
  with the release in it, read in the page as in "Your game" below. With `--release`, the server
  offers the folder at `/release/` and the page loads `/release/release.json` when it opens.
- **Options**, closed until you open it:
  - **Backend**: as the release lists them (WebGPU first, then WebAssembly), or one of the
    two. WebGPU is not always the faster of the two: that depends on the browser and the
    machine, so time both on yours. A headless browser may offer no WebGPU adapter, and the
    runtime then uses WebAssembly. If you choose WebGPU alone where there is no adapter,
    nothing runs: the model does not load, and the page gives the runtime's reason.
  - **Card images: folder or address**: the tooltip shows the image of the card under the
    pointer, fetched from this base under the file name the catalog gives. With `--images`
    the field holds `/images/`, the server's image folder, without your entering it. When it
    is empty, the tooltip shows the name alone and no image is requested. An image that is
    not found is left out of the tooltip, and a note under the field says which one.
  - **Analyze continuously**: by default frames are analyzed only around pointer activity.
- **Details**, closed until you open it: the diagnostics described above, with **Copy
  diagnostics** and, under **Raw text**, the text panel shown above.

A change of file starts a new session, and so does a change of model, backend or schedule.
Nothing of the session before it stays on screen.

**To change the look**, edit `demo/theme.css`. Its first block holds every color, radius and
spacing of the two pages. The labeling tool carries the same block.

### Opening a file with no file chooser

Step 2 of the demo above starts the server this way, and so can a program that drives a
browser, which cannot use a file chooser. Name the file when you start the server, and it
prints an address that opens it. Paste this into the terminal, in `browser/`:

```
npm run demo -- --release "$WORK/demo/release" --images "$WORK/demo/art" --file "$WORK/demo/table.png"
```

After the build's lines, you should see something like:

```
demo: http://127.0.0.1:8765/
scoring page: http://127.0.0.1:8765/score.html
release folder: $WORK/demo/release (served at /release/)
image folder: $WORK/demo/art (served at /images/; the demo page shows card images from it)
file: $WORK/demo/table.png (served at /file/table.png)
open the file in the demo: http://127.0.0.1:8765/?file=/file/table.png&images=/images/
```

The page at the last address opens the file as if you had chosen it. Under the picture you
should see something like this, which says what it opened, and from where:

```
table.png opened from this page's address (/file/table.png on the local server)
```

The text panel (`Details`, then `Raw text`) names the file too, and the File group of
`Details` says `From: the local server's /file/table.png`. With the pointer on the first card of
the toy table, you should see something like this in the panel (this was headless Chrome 155):

```
state: ready
file: table.png, from the local server's /file/table.png (named in this page's address)
model: /release/release.json
release: 176e5b5cfd5c89ef (toy, 20 cards in the bank)
backend: detector on webgpu, recognizer on webgpu
ONNX Runtime Web: the release was measured on 1.29.0
hover selection: accepted-nms; a result is shown for at most 2000 ms of video
schedule: fast
frames analyzed: 3
last frame: 39.6 ms in the worker, 40.6 ms from capture to result
analyzed at 1280 x 768: 6 boxes, 5 faces, 5 named
  detector 25.7 ms, recognizer 7.9 ms, 8 embeddings
under the pointer: Amber Circle (TOY-001)
```

A script that drives the page waits until the state line reads `Ready. Move over a face-up
card.`, or until the first line of the panel (the element `panel`) reads `state: ready`. It
then moves the pointer onto the picture and reads the tooltip, or the panel's last line. The
panel is filled in while `Details` and its `Raw text` are closed. The script sets no file field.
`window.demo.session` is the page's session (`status()`, `at(x, y)`, `analysis()`), for a
script that would rather ask it. Each new session replaces it.

**What the address may name.** Two things, and nothing else:

- `file=/file/NAME`: the one file the server was started with. The page follows it only when it
  is exactly the path the server itself reports for that file, and it then fetches that path
  from its own server. It never uses the value as an address. So a link cannot make the page
  fetch from another host or from another path.
- `images=/images/`: the server's own image folder, and only when the server was started with
  `--images`. The page shows card images from that folder in any case, so the parameter
  changes nothing; the address still carries it.

Any other value is refused: the drop zone says which one and why, the page fetches nothing for
it, and it opens no file. The server answers under `/file/` for that one file and for nothing
else. `--file` needs `--release`, and a file whose name ends in `.png`, `.jpg`, `.jpeg`,
`.webp`, `.gif`, `.avif`, `.mp4`, `.m4v`, `.webm`, `.mov`, `.mkv` or `.ogv`. A file with such a
name that is no picture is said so by name, as any other file is. The page reads the whole
file into memory before it shows it, so use the file chooser for a long video.

The server listens on 127.0.0.1 only, answers GET requests only, and serves four things: the
built pages and library, the `--release` folder, the `--images` folder and the one `--file`.
The pages request nothing else, and have no analytics. Its port is 8765; `--port N` takes
another, and `--port 0` any free one. `npm run demo -- --help` lists the options, and an option
it does not know is an error.

## The hosted demo

The demo page is also built as a static site: a practice site where anyone can hover cards with
nothing to install. The workflow publishes it on GitHub Pages at
<https://ryangswe.github.io/riftsight-vision/>. The page opens with a choice of games, loads the
chosen game's release, and lets a visitor hover the cards of a picture or a video. Files you
select are processed locally by this demo; its code does not upload their contents. Selecting
One Piece downloads model files from Hugging Face. Selecting "Your game" downloads nothing: the
release is a folder on your computer.

| Choice | Release | Card images | Example files |
| --- | --- | --- | --- |
| **Toy game (practice)** | Bundled with the site (`games/toy/release/`) | The toy game's 20 cards, colored shapes drawn by the test suite (`games/toy/images/`) | **Load the example table** opens `table.png`, **Load the example video** opens `table.webm`, with no file chooser |
| **One Piece Card Game (Kenbunshoku models)** | Fetched from Hugging Face when the game is chosen, pinned to one commit: `https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece/resolve/5526f531863381745780f4377f1cae767077ca77/release.json` | None. Names only: no One Piece card image is shown, fetched or bundled. | None: the visitor drops a screenshot or a video of their own |
| **Your game (files on this computer)** | A release folder the visitor chooses with **Choose the release folder…**, read by the page: nothing is fetched or uploaded. See "Your game" below. | An `images/` or `art/` folder beside the release, or a folder chosen with **Choose the card images folder…**; none otherwise | None: the visitor drops a screenshot or a video of their own |

The toy game is chosen when the page opens. Under the choices the page says what the chosen
game is. For the toy game: `The model comes with this page.` and that its models are stand-ins
with no skill, there to learn how hovering works. For the One Piece Card Game: `The model is
downloaded from huggingface.co when this game is chosen.`, `Names only`, `Unofficial fan
project, not affiliated with Bandai.`, and the credit line `Models: Kenbunshoku One Piece
release B2.1 (Apache-2.0)`, which links to
<https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece>.

While a game's models load, the line under the choices says where the load is, with a pulsing
mark: `Downloading the One Piece models…`, then `Downloading the One Piece models (about 12
MB)…` once the release document gives the sizes, then `Preparing the One Piece models…` while
ONNX Runtime starts the models, then `Model loaded. Choose a file.` In headless Chrome on this
machine the One Piece release took about 38 s: about 16 s to download the files (about 12 MB,
in 12 s) and check them, and about 22 s to prepare the models (that Chrome ran under emulation; a native browser
is faster).
A file can be dropped meanwhile.

Choosing another game stops the session of the game before (its worker is ended, and its
models with it), puts the file on show away, clears the tooltip, and loads the new game's
release. Every file of a release is checked against the SHA-256 and the size its release
document pins, for the bundled toy release as for the one on Hugging Face.

### Your game

The **Your game (files on this computer)** choice loads a release from a folder on the visitor's
computer: the `release` folder of [your-game.md](../docs/your-game.md), or another folder that
`cardvision verify-release` accepts and that was made for this page's ONNX Runtime version
(the release document's `runtime.ortWeb`). The page offers it when the build names `local` in
`--games`; the local server's page has the same folder buttons beside its `Release address`
field. Under the choices the page says `Files you choose are read on this computer by this
page; nothing is uploaded, and this page makes no request for them.`

1. **Choose the release folder…** opens the browser's folder chooser (an `<input type="file"
   webkitdirectory>`). Chrome then asks whether to "upload" the files to the site: that is its
   standard question for any folder chooser, and the page only reads them on this computer. The
   folder may be the release folder itself, or a folder up to two levels above it, such as
   `$GAME`: the page takes the nearest `release.json`, and refuses, with the paths, a folder
   that holds two at the same depth.
2. The page reads `release.json` and hands the worker that document and the five files it pins
   (detector, recognizer, bank, identity groups, catalog), and nothing else of the folder. A file
   the document pins that is not in the folder is named: `release.json pins recognizer.onnx,
   which is not in my-game/release/. ...`.
3. The worker checks every file against the size and the SHA-256 the document pins, and the
   document against its id, exactly as for a served release, and refuses a release with one
   changed byte: `Could not load the release in my-game/release/release.json (detector: sha256
   of detector.onnx does not match the release). Choose the release folder again.` While it
   loads the line says `Reading your models (about N MB)…`, then `Preparing your models…`.
4. Card images: an `images/` or `art/` folder beside `release.json`, or at the top of the folder
   chosen, is taken by itself; **Choose the card images folder…** takes another. Images taken
   by themselves belong to their release: choosing another release folder, or typing a release
   address on the local server's page, lets them go. Images chosen with the button stay. A card's image
   is found as on the local server: the catalog's `art` path with its folders, then its bare file
   name, for a folder that holds every image flat. The tooltip shows it from a `blob:` URL that
   the page makes for it; these are revoked when the images or the game change. The line under
   the buttons says how many image files were taken, and names a card whose image is not there.

How it stays inside the policy: the page posts the files to the worker as `Blob`s, the worker's
loader answers its own requests from them (`files` in `loadRelease`'s options, `releaseFiles`
in `createSession`'s), and no request leaves the page for them. A `file:///` address is used
inside the worker only as a key among the files given; it is never fetched. The card images
need `img-src blob:`, which the page has already for the file on show. So a build with `local`
has the same Content-Security-Policy, byte for byte, as the same build without it
(`test/games.test.ts`). Nothing is typed: the release address field stays read-only, and the
page follows nothing in its address. Choosing another game forgets the folders chosen.

Other ways the hosted page differs from the local one:

- The release address cannot be changed on the page. If a model does not load, the page gives
  the address and the reason, and `Retry`.
- The `Card images` option is not offered. The toy game shows its own images, from the site,
  and "Your game" shows images from a folder chosen on this computer.
- No scoring page. It is for people with labels of their own, who run it locally. The header
  links to this repository instead, and to `THIRD-PARTY-NOTICES.txt`, the full license texts
  of the third-party code in the site's scripts.
- Nothing in the page's address is followed (`file=`, `images=`): the page opens only a file
  you choose or drop, or an example of the toy game.

### Building it

The site bundles the toy folder of "The demo page" above (`$WORK/demo`, written by its step
1). Paste this into the terminal, in `browser/`, with `$WORK` set as there:

```
npm run build:pages -- --games toy,one-piece,local --toy "$WORK/demo"
```

After npm's own lines, you should see something like:

```
dist/pages: 37 files (THIRD-PARTY-NOTICES.txt, demo.css, demo.js, index.html, lib/ort-wasm-simd-threaded.jsep.mjs, lib/ort-wasm-simd-threaded.jsep.wasm, lib/worker.js, lib/worker.js.LEGAL.txt, theme.css, and 28 in games/)
game toy: Toy game (practice), its model from games/toy/release/release.json
game one-piece: One Piece Card Game (Kenbunshoku models), its model from https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece/resolve/5526f531863381745780f4377f1cae767077ca77/release.json
game local: Your game (files on this computer), its model from a folder the visitor chooses
```

The site is about 29 MB, 27.8 MB of it ONNX Runtime's WebAssembly file. From the toy folder the
build copies `release/release.json`, the files it pins, the image of each card its catalog
names, `table.png` and `table.webm`, and nothing else. It refuses a folder whose catalog is not
the toy game's, and stops if a file is missing. `--games` takes the games in the picker's order,
separated by commas; `--toy` is needed when the list names `toy`. Nothing of either release is
committed to this repository. The same inputs give the same bytes.

**One release, no picker.** `--release-url URL` in place of `--games` builds the page for one
release, with no picker, as before: the line under the title says where the model is
downloaded from, and no card image is offered. The address must be an https URL of a release
document, with no query and no fragment (an http one only on `127.0.0.1` or `localhost`, for a
preview). `--release-url ""` builds a page with no model, which says so.

### Adding a game

A game is one entry of `HOSTED_GAMES` in `scripts/pages.mjs`. The page needs no change: it
builds one choice per game from the list the build gives it, and the policy is computed from
the list.

1. Add an entry: its `label` (the text of its choice), `models` (what the loading line calls
   them, such as `the One Piece models`), `notes` (lines said under the picker), `credit`
   (`{ text, href }` with an https link, or `null`), and either `bundled: false` and `release`,
   the https address of its release document, at a commit (the game is names only); or
   `bundled: true`, and a folder option and a copy function of its own, written like `--toy`
   and `copyToy`. (`local: true` is the "Your game" choice: no release, read from the visitor's
   folders.)
2. Name it in `--games`, and in the workflow's build step.
3. Add it to `test/games.test.ts`: the entry, and the exact policy of a build that offers it.
4. For a release on a host not yet in `STORAGE_HOSTS`, check its CORS headers and redirects as
   in "The Content-Security-Policy" below, and add the hosts its files redirect to.

The toolkit's own released models are meant to become a third choice this way.

### The Content-Security-Policy

The page carries its policy in a meta element, since a host of plain files such as GitHub Pages
sends no headers of a page's choosing. Built with `--games toy,one-piece` it reads:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:;
connect-src 'self' https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece/resolve/5526f531863381745780f4377f1cae767077ca77/ https://*.hf.co;
img-src 'self' blob: data:; media-src blob:; style-src 'self'; base-uri 'none'; form-action 'none'
```

| Source | Why it is there |
| --- | --- |
| `script-src 'self'` | The page's script, the worker and ONNX Runtime's loader, all from the site. No inline script, no other origin. |
| `'wasm-unsafe-eval'` | ONNX Runtime compiles its WebAssembly. Without it the model does not load (`CompileError: WebAssembly.instantiate() ... violates the following Content Security policy directive`). It allows no JavaScript eval, and none is needed: `'unsafe-eval'` is not given, and both backends run. |
| `worker-src 'self' blob:` | The page starts its worker from a `blob:` URL that imports `lib/worker.js`. A worker started from its own URL runs under the policy of the answer that served it, which here is none; a worker started from a `blob:` URL runs under the page's. Chrome checks the worker's import of `lib/worker.js` against `worker-src`, hence `'self'`. The worker finds its own files from its module's address, since nothing resolves against a `blob:` URL. |
| `connect-src 'self'` | The site's own files: ONNX Runtime's `.wasm`, the toy release, and the toy examples (fetched, then shown from a `blob:` URL). |
| the One Piece release's folder | A folder prefix: any address under that folder, not just the files the release pins. The loader asks for the release document and the files it pins, and nothing else there. Hugging Face answers the small files (`release.json`, `bank.json`, `bank.identity-groups.json`, `catalog.json`) with a redirect to `/api/resolve-cache/...` on `huggingface.co` itself. A browser ignores the path of a source for a redirected request, so after a redirect this source allows any path on `huggingface.co`. |
| `https://*.hf.co` | Any host under `hf.co`, Hugging Face's file storage: the two `.onnx` files redirect to `us.aws.cdn.hf.co` (from this machine; elsewhere, possibly another regional host of the same domain). `STORAGE_HOSTS` in `scripts/pages.mjs` holds it, for any release on `huggingface.co`. |
| `img-src 'self'` | The toy game's card images in the tooltip. A build without a game that bundles images does not have it. |
| `img-src blob: data:`, `media-src blob:` | The picture or video on show, from a `blob:` URL, and the page's empty icon (`data:`). |
| `style-src 'self'` | The two style sheets. |

**What the policy does, and what it does not.** Three parts work together. The loader
requests the pinned artifacts: the release document, then each file it pins. The policy's
allowlist permits the destinations those requests need: `'self'`, a folder prefix on
`huggingface.co`, and the storage hosts. The integrity checker validates the bytes: every file
is checked against the SHA-256 and the size the release document pins, and a file that differs
is refused. The policy does not check a hash, and it governs where a request may go, not what
a request carries. That the demo does not upload a file you select is a property of its code,
not something the policy enforces.

A page built with `--release-url` has the same policy with that release's folder in
`connect-src` (and `https://*.hf.co` for a release on `huggingface.co`), and `img-src blob:
data:`. There is no analytics, no third-party script, and no font or other asset from another
origin. Tests (`test/hosted.test.ts`, `test/games.test.ts`) build the site and check the
policy, that the scoring page is not in it, and that the page and its scripts name no origin
other than the releases' and two links. WebGPU needs no source of its own.

A release's host must answer with `Access-Control-Allow-Origin`, since the page is on another
origin. Each file of the One Piece release was requested with
`curl -sIL -H "Origin: http://127.0.0.1:8080" URL` on 2026-10-17, following redirects, and
answered with it at every hop:

| Files | Hop 1, on huggingface.co | Hop 2 |
| --- | --- | --- |
| `release.json`, `bank.json`, `bank.identity-groups.json`, `catalog.json` | 307 to `/api/resolve-cache/...`, `access-control-allow-origin: http://127.0.0.1:8080` | 200 on huggingface.co, the same header |
| `detector.onnx`, `recognizer.onnx` | 302 to `https://us.aws.cdn.hf.co/xet-bridge-us/...`, the same header | 200, `access-control-allow-origin: *` |

### Previewing it

`npm run preview:pages` builds the site and serves `dist/pages` on this machine as a host of
plain files would: each file as it is, and nothing else. Paste this into the terminal, in
`browser/`, with `$WORK` set as above:

```
npm run preview:pages -- --games toy,one-piece,local --toy "$WORK/demo"
```

You should see something like:

```
hosted demo: http://127.0.0.1:8765/ (dist/pages, 37 files, as npm run build:pages -- --games toy,one-piece,local --toy "$WORK/demo" writes them)
game toy: Toy game (practice), its model from games/toy/release/release.json
game one-piece: One Piece Card Game (Kenbunshoku models), its model from https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece/resolve/5526f531863381745780f4377f1cae767077ca77/release.json
game local: Your game (files on this computer), its model from a folder the visitor chooses
```

Open `http://127.0.0.1:8765/`, press **Load the example table**, and hover a card: the
tooltip names it and shows its toy image. Choose **One Piece Card Game** to load that release
from Hugging Face (the toy game needs no network; this one does), then drop a screenshot of
your own game. Choose **Your game (files on this computer)**, then **Choose the release
folder…** and pick `$WORK/demo` to load the same toy release from disk. Stop the preview with
Ctrl+C.

To preview the **Your game** choice alone, `npm run preview:pages -- --games local` needs no
toy folder: it builds the page with that one choice (no `--toy`) and serves it the same way.

Two other forms: `--release "$WORK/demo/release"` builds the one-release page for a release
folder on disk, which it serves on a port of its own, on another origin than the page, with
`Access-Control-Allow-Origin: *` as a model host sends it; `--release-url URL` builds the
one-release page for that address and serves no folder. `--port N` and `--release-port N` take
other ports, `0` any free one. `npm run preview:pages -- --help` lists the options.

This was run in headless Chrome 152 with the picker: the toy game named `Amber Circle` on the
example table and on the example video, with its image; choosing the One Piece Card Game ended
the toy session and loaded release `f80d5b56cd907f03` (5489 cards in the bank) under the
policy, with no violation; the page reached `127.0.0.1`, `huggingface.co` and
`us.aws.cdn.hf.co`, and no One Piece image was requested. The only console messages were ONNX
Runtime's own warnings that some nodes are placed on the CPU. With `local` in the list, run in
headless Chrome 155: choosing **Your game** and picking the toy folder loaded its release from
disk (`Model: toy · 20 cards`, `Card images: 20 files from demo/art/.`), the tooltip named the
five cards on the example table with their images from `blob:` URLs, and the page requested
nothing for them; a copy with one changed byte in `detector.onnx` was refused with
`detector: sha256 of detector.onnx does not match the release`.

### Publishing the hosted demo

`.github/workflows/pages.yml` publishes the site. On a push to `main`, and when it is run by
hand, it runs this folder's tests, writes the toy folder with
`python tests/test_browser_fixtures.py --demo`, builds the site with
`--games toy,one-piece,local`, and deploys it with GitHub's own Pages actions. It reads no repository
variable and no secret. It deploys only from `main`, and only when the repository's Pages deploy
from GitHub Actions. Until then the tests and the build run, the deploy job is skipped, and the
run says so in a notice: nothing is published, and the run does not fail.

The maintainer's steps:

1. Check it here first: `npm run preview:pages -- --games toy,one-piece,local --toy "$WORK/demo"`,
   and try the games as in "Previewing it". This is the site that will be published.
2. In Settings, Pages, Build and deployment: set Source to `GitHub Actions`.
3. In Actions, run `Hosted demo` on `main`. Its deploy job gives the address,
   `https://ryangswe.github.io/riftsight-vision/`.
4. Open the address and repeat the check of step 1: the three choices show, the toy game names a
   card on the example table, the One Piece game says `Model: one-piece-tcg · 5489 cards`, "Your
   game" offers **Choose the release folder…**, and the browser console shows no
   Content-Security-Policy violation.

A repository variable `DEMO_RELEASE_URL` left from earlier is no longer read, and can be deleted.
To move the One Piece game to another release, change `ONE_PIECE_REVISION` in
`scripts/pages.mjs` (and the tests that name it), after checking the new commit's CORS as
above. To take the site down, unpublish it in Settings, Pages, and disable the workflow
(Actions, `Hosted demo`, Disable workflow): while Pages still deploy from GitHub Actions, the
next push to `main` would publish it again.

## The scoring page

The demo shows one pointer on one file. The scoring page answers for every labeled position
of a label manifest ([data/SCHEMA.md](../data/SCHEMA.md)), on video files from your own disk,
and writes the answers to a file. `cardvision evaluate hover --browser-events` then scores that
file with the scorer it uses for its own frames. [docs/method.md](../docs/method.md), "Scoring
the browser runtime on a video file", says what the result means and what it does not.

The same server offers it. Paste this into the terminal, in `browser/`, with your release
folder in place of `RELEASE-FOLDER`:

```
npm run demo -- --release RELEASE-FOLDER
```

Open `http://127.0.0.1:8765/score.html`. The page numbers its three inputs. Give them in
order, then press Start.

| Input | What to give |
| --- | --- |
| **1 Model** | The address of a release document. With `--release` the field holds `/release/release.json`. |
| **2 Labels (manifest files)** | One or more `.manifest.jsonl` files. |
| **3 Videos** | The videos of those manifests: whole videos, or sections of them. A file is found by its name: the rule is under the field, and at length below. |

`Options`, closed until you open it, holds the rest:

| Option | What it does |
| --- | --- |
| **Role to score** | `evaluation` (the default), `train` or `extra`. Only rows of that role are read. |
| **Backend** | As the release lists them, or WebGPU only, or WebAssembly only. |
| **Index of kept video files** | Optional. The `video-files.json` that `cardvision fetch --keep-video` writes beside the files it keeps. |

**Before a run** the page counts what it would read, beside the Start button. On the toy
inputs, you should see something like:

```
3 rows of the role evaluation in table.manifest.jsonl. All 3 have a matching video.
```

- With no row of the chosen role, Start starts nothing. The page says so under the labels
  input, with the roles the manifests do hold: `No row has the role train:
  table.manifest.jsonl holds 3 rows of the role evaluation. Choose another role under Options,
  or other manifest files.`
- With no video that matches a row, Start starts nothing. The page says so under the videos
  input, with the videos the rows are of: `No video file matches a row. The 3 rows of the role
  evaluation are of the video local-table. Give each video file the name of its video, as
  below, and choose it again. Not used: other-video.webm.`
- With a video for some rows and not for others, a run may start. The page says how many rows
  it will leave out, and says it again when the run has ended.
- A file that is not a manifest is said so under the labels input, with the file and the line.
- Start pressed with an input still empty marks that input: `Choose one or more manifest
  files.`

**During a run** a card says which row was done last, with a bar. The page has to be visible
to work: a browser may present no video frame to a page in the background. While the page is
hidden the run is paused, and the page says so at once, above the run and in its title. The
run goes on when the page is visible again, and no row is lost. A page in a headless browser
counts as visible while its tab is the one in front.

**When a run has ended** the page shows a card, `Events ready for scoring`: the rows kept,
unreachable and failed, a `Download browser-events.jsonl` button, and the command that scores
the file. The page fills in the names it knows. A browser gives a page the name of a chosen
file and not its folder, so each folder is a placeholder in capitals, framed, for you to
replace. `Copy` copies the command. After the toy run, you should see something like this
command. From the repository's root (if you are in `browser/`, run `cd ..` first), paste it into
the terminal once each folder in capitals is replaced:

```
cardvision evaluate hover --browser-events DOWNLOADS-FOLDER/browser-events.jsonl \
    --manifest LABELS-FOLDER/table.manifest.jsonl \
    --release RELEASE-FOLDER/release.json
```

After a run of the role `train` or `extra` the command ends with one more line, `--role train`
or `--role extra`: without it the command scores the `evaluation` rows, and refuses a file of
another role.

A run that kept no row is titled `No usable rows`. Its file has nothing to score. The page
still offers it, as `Download browser-events.jsonl (for diagnosis only)`, because it says why
each row was left out. `Details` holds the lines of the run, as "Running the scoring page from
a script" shows them.

**To try it on the toy game.** The toy release of the demo page comes with a toy video and
its labels: `python tests/test_browser_fixtures.py --demo "$WORK/demo"` (above) also writes
`$WORK/demo/table.webm`, six seconds of the toy table, and
`$WORK/demo/labels/table.manifest.jsonl`, three labeled rows of it. Start the server with
`--release "$WORK/demo/release"`, choose that manifest and that video, and press Start. The
card then reads `Kept 3`, `Unreachable 0`, `Failed 0`. "Running the scoring page from a
script", below, shows what the run gives.

**How a video file is matched to rows.** By its name without the extension: the video id, or
`<platform>-<video id>`, which is how `cardvision fetch` starts the name of a frame.
`EXAMPLE0001.mp4` serves the rows of the video `EXAMPLE0001`. Put the platform in front when
the same id exists on two platforms. These are the two forms `cardvision fetch --video-file
ID=PATH` takes, with a hyphen where that has a colon. Such a file must hold the whole video
from its start. The browser must be able to play every file you give.

A recording of your own, whose rows have the platform `local`
([data/SCHEMA.md](../data/SCHEMA.md), "Recordings of your own"), is matched the same way: by
the name the manifest gives it, or by `local-` and that name. `kitchen-table-01.mp4` and
`local-kitchen-table-01.mp4` both serve the rows of the recording `kitchen-table-01`.

**Sections of a video.** A file may hold a few seconds of a video and not the whole of it. Its
name then ends in `+<start>`, the time in the video, in seconds, at which the file starts:
`youtube-EXAMPLE0001+77.mp4` starts 77 seconds into the video `EXAMPLE0001`. These are the
files `cardvision fetch --download --keep-video DIR` keeps
([data/SCHEMA.md](../data/SCHEMA.md), "Kept video files"). Choose all the video files of
`DIR` as the video files.

- A section serves the rows whose time `t` lies inside it. The page looks for the row at
  `t - start` of the file.
- The window of one second either side of `t` ends where the file starts and ends, as it does
  at the start and the end of a whole video.
- A name gives the start of a section and not its end. The section that starts last at or
  before `t` is taken. If that file turns out to end before `t`, the row is recorded as
  `no-video`.
- If you also choose the index, `video-files.json`, a file listed there is known by its entry
  and not by its name. The entry gives the end of the section too, so a row past it is given no
  file at the start.
- **A whole-video file wins.** If a whole-video file and sections are given for one video, the
  whole-video file serves all its rows. The sections of that video are not used, and the page
  lists them as not used.
- Two files for the same section of a video are refused, as two files for one video are.

A section is cut only as precisely as a frame. A row with a fingerprint is found all the same.
A row without one can land one frame off in a section.

**What happens to each row.**

1. The page seeks the video to one second before the row's time `t` and walks to one second
   after it. A browser shows the frame on screen at a time and has no "next frame", so the
   walk goes in steps of time. A step is never longer than 16 ms. So no frame that is on
   screen for 16 ms or longer is passed over: every frame of a video of up to 60 frames a
   second, and also of a recording whose frame rate varies, as a phone's or a screen
   recorder's does. A step shorter than a frame shows that frame twice, which costs a seek
   and nothing else. For a faster video the step is the frame interval, measured at the start
   of each row's window. In a file that holds a section, every time is the time in the file
   plus the section's start.
2. Each frame is drawn to a canvas at the video's size and fingerprinted (`score/dhash.ts`).
   The frame nearest the row's `frame_dhash` is kept if it is at most 6 bits away: the rule and
   the threshold of `cardvision fetch`. A row without a fingerprint takes the frame on screen
   at `t`. A row whose window starts after the end of the file is recorded as `failed`.
3. The kept frame is shown again, captured by `captureFrame` at analysis size and analyzed by
   the worker. A video session captures with `grabFrame`, which draws the same picture at the
   same size.
4. For each labeled point, and for the center of each labeled box, the page records what the
   release's hover rule shows there. Each frame is judged alone.

**Frame times.** Some browsers report the time of the frame they show, through
`requestVideoFrameCallback`. Others report the time they were asked for, and some have no such
callback. The page finds out which, once for each file: it asks for three times 1.2 ms apart,
and takes the reported times as frame times only if two of them are equal. Three times that
close lie in one frame or in two, so a browser that reports frame times gives the same time
twice. A browser that repeats the time it was asked for gives three different times.

- Where the browser reports frame times, a frame that is shown twice is counted once.
  `frame.exactTime` is `true`, and `frame.mediaTime` is the frame's own time.
- Where it does not, the page cannot tell one frame from the next. It fingerprints every
  step, and each step counts as a look: about 126 for a row, whatever the video.
  `frame.exactTime` is `false`. `frame.mediaTime` is then the time the page asked for when it
  saw the frame it kept. That is a time at which the frame is on screen, up to one step after
  the frame starts, and not the frame's own time. In such a browser a video faster than 60
  frames a second can have frames passed over.

The step is 16 ms in such a browser, and it is not made longer where the picture stays the
same: an unchanged fingerprint does not show that the frame is the same frame.

The fingerprint is the Python package's, bit for bit, on the same pixels. A browser's video
decoder and its canvas do not give the pixels OpenCV gives for the same frame, so the two
fingerprints of one frame can differ by a few bits. That is what the 6-bit threshold is for.

**The events file.** `browser-events.jsonl`, offered as a download when the run ends. Its
form is unchanged by the page's new look. JSON Lines:

- The first line says what ran: the release id and the settings the runtime read from it, the
  runtime's name and version, the browser's user agent, the backend each model ran on and the
  one that was asked for, the role, and the name, SHA-256 and row count of each manifest.
  Among the release's settings is its identity rule, `release.identity.level` (`name` or
  `printing`): the rule that says which catalog entries are the same card.
- Every other line is one row of that role, in manifest order:

| Field | Meaning |
| --- | --- |
| `platform`, `video_id`, `t` | The row's key |
| `status` | `kept`; `unreachable` (no frame within 6 bits of the fingerprint: the row is not scored on another frame); `no-video` (no file was given for it, or the section given ends before its time); `frame-shape` (the video has another shape than the labeled frame); `failed` (the frame could not be read or analyzed, or the file ends before the row's window starts: see `reason`) |
| `labels` | How many points and boxes the row has |
| `video` | `file`: the file used. `width`, `height`: the size it decodes to. `start`: only for a file that holds a section, the time in the video at which the file starts; the row was looked for at `t - start` of the file |
| `frame` | `mediaTime`: the time in the video of the frame kept, or for `unreachable` of the nearest frame. For a section it is the frame's time in the file plus `video.start`. `offset`: that time minus `t`. `distance`: bits between its fingerprint and the row's, `null` for a row without one. `looked`: frames fingerprinted. `exactTime`: whether the browser reported the frame's own time. Where it is `false`, `mediaTime` is a time at which the frame was on screen and not the time it starts, and `looked` counts looks, of which a frame can have several ("Frame times", above) |
| `analyzed` | The size of the analyzed frame |
| `backend` | The backend each model ran on |
| `points`, `centers` | For a kept row: one outcome per labeled point and per box center |

An outcome holds `index` (the label's place in the row), `x` and `y` (fractions of the frame),
`cardId` and `name` (the card shown, or `null` twice for nothing), and the box the pointer is
on with its `similarity`, `margin` and `accepted`. `box` is `[x, y, width, height]` in pixels
of the analyzed frame, or `null` when the pointer is on no box of the hover layer.

Which boxes are in the hover layer depends on the release's hover selection. Under
`accepted-nms`, a box whose best match does not reach `tau` is not in the layer. A pointer on
such a box is recorded as on no box: `box` is `null`, and so are `similarity`, `margin` and
`accepted`. A box that reaches `tau` and fails the margin is in the layer: it is recorded,
with `accepted` false, and shows nothing. A box dropped by the suppression pass is not in the
layer either. Under the other two selections every box is in the layer, so every box under
the pointer is recorded. `cardvision evaluate hover` builds the layer the same way.

**Score it.** Paste this into the terminal, from the repository's root, in the Python
environment:

```
cardvision evaluate hover --browser-events browser-events.jsonl \
    --manifest EVAL.manifest.jsonl --release RELEASE-FOLDER/release.json
```

The report says the outcomes came from a browser run, and names the backend and the user agent.
The command checks the file before it scores it. [docs/method.md](../docs/method.md), "How to
score the file", lists what it refuses and what it only warns about.

The file is scored under the identity rule it was recorded under. With `--catalog` in place
of `--release`, a catalog that states another rule than the header records is refused: score
the file with the catalog of the release the page ran. A file written before the header
recorded the rule is read as `name`.

Compare such a figure with a Python figure with care. On footage where the picture barely
changes, several neighboring frames can be within the fingerprint limit, and the two sides
may keep different ones of them. A card that is found on one frame and missed on the next can
then make the figures differ.

**Running the scoring page from a script.** `window.cardvisionScore()` starts a run with the
inputs chosen on the page, or joins the run in progress. It returns a promise that resolves
with the lines of the events file, as an array of strings, header first. It rejects with the
reason when a run cannot start. Any tool that can set a file input and wait for a promise can
use it. The check before a run is for a person who presses Start, and does not hold this
function back: on inputs with no row of the role, or with no matching video, it resolves with
the lines for those inputs, as it always has, and the page titles the result `No usable rows`.

`examples/score-headless.mjs` is an example of such a tool. It starts the server on a free
port, opens the scoring page in a headless Chrome that you name, gives the page the manifests
and the videos, waits for the run, writes the events file, prints the page's summary, and
stops the browser and the server. It drives Chrome with the package `puppeteer-core`. That
package is not a dependency of this folder: you install it yourself, as below, and `npm ci`
removes it again. The tests cover the example's options and no more.

On the toy game, after `npm run build`, paste this into the terminal, in `browser/`, with the
path of your Chrome program in place of `/path/to/chrome`:

```
npm install --no-save puppeteer-core
node examples/score-headless.mjs --chrome "/path/to/chrome" --release "$WORK/demo/release" \
    --manifest "$WORK/demo/labels/table.manifest.jsonl" --video "$WORK/demo/table.webm" \
    --backend wasm --out "$WORK/demo/browser-events.jsonl"
```

You should see something like:

```
browser: Chrome/155.0.8059.40
release: 176e5b5cfd5c89ef (toy, 20 cards in the bank)
backend: detector on wasm, recognizer on wasm
role: evaluation; 3 rows in 1 manifest
videos: 1 file used, 0 rows without a video
done
rows done: 3 of 3
  kept 3, unreachable 0, no video 0, another shape 0, failed 0
positions answered: 18; a card shown at 12
fingerprint distance of the kept rows: 0 bits on 3 rows
wrote $WORK/demo/browser-events.jsonl: 3 row(s), in 7.6 s
```

`--chrome` names the Chrome program itself. `--manifest` and `--video` may be given more than
once. Without `--backend` the release's own order applies. `--chrome-arg=ARG` passes one more
argument to Chrome. `node examples/score-headless.mjs --help` lists every option. This run was
made with Node 24, puppeteer-core 25.13.0 and Chrome 155.

Then score the file. From the repository's root (if you are in `browser/`, run `cd ..` first),
in the Python environment, paste this into the terminal:

```
cardvision evaluate hover --browser-events "$WORK/demo/browser-events.jsonl" \
    --manifest "$WORK/demo/labels/table.manifest.jsonl" --release "$WORK/demo/release/release.json"
```

Among the report's lines, you should see something like:

```
- backend: detector on wasm, recognizer on wasm (asked for: wasm only)
- rows read: 3
- rows used: 3
- events: 18 in 1 recording groups
- readable faces: right 12, wrong 0, nothing 0
- backs: name shown 0, nothing 4
- **named right**: 12 / 12 = 100.00 %; exact one-sided 95 % lower bound 77.91 % (assumes independent events); group bootstrap: no interval (fewer than two recording groups)
- **wrong of shown**: 0 / 12 = 0.00 %; exact one-sided 95 % upper bound 22.09 % (assumes independent events); group bootstrap: no interval (fewer than two recording groups)
```

These toy figures mean nothing: the models are stand-ins. `cardvision fetch` and `cardvision
evaluate hover --frames` give the same counts on this video and this manifest.

**What to expect.** A row with a fingerprint costs about 130 seeks for a video of up to 60
frames a second: the two seconds of its window in steps of 16 ms, and a few more. How long
that takes depends on the browser and on the size of the frame. On the small toy videos, on
one laptop, a row took about 2 to 3 seconds in headless Chrome 154 and about 2 to 8 seconds in
headless Firefox 153. Larger frames take longer. A browser plays only the codecs it supports.

**Where the pages were run.** In headless Chrome 154, on WebGPU and on WebAssembly, and in
headless Firefox 153, on WebAssembly only: it offered no WebGPU adapter. Chrome reported frame
times. Firefox reported the times it was asked for. On toy videos of one frame rate (H.264 in
MP4, VP9 and VP8 in WebM) both kept the rows that `cardvision fetch` keeps, on the same frames.
No other browser was run.

The two pages as they look now were run on the toy release in headless Chrome 155, on WebGPU
and on WebAssembly, and in headless Firefox 157, on WebAssembly. What a run does is unchanged
since the runs above: on the toy inputs the events file is the same, byte for byte, as the one
the page wrote before its new look.

Since those runs the first line of the events file has gained one field, the release's
identity rule (`release.identity`), and the command the page shows names the role when it is
not `evaluation`. No browser was run for these two changes: the tests of this folder check the
line and the command.

## Use it in a page

After `npm run build`, serve `dist/` and import the module. A session draws nothing: it tells
you what would be shown, and you decide how to show it.

```js
import { createSession } from "./dist/cardvision.js";

const video = document.querySelector("video");
const label = document.querySelector("#label");
const session = createSession(video, { releaseUrl: "/release/release.json" });

video.addEventListener("pointermove", (event) => {
  const shown = session.at(event.clientX, event.clientY);   // { name, cardId, box } or null
  label.textContent = shown ? `${shown.name} (${shown.cardId})` : "";
});
```

`session.stop()` ends it.

### `createSession(element, options)`

Starts recognition on a `<video>` or `<img>` element and returns a `Session`. The file the
element shows must be readable by the page (same origin, a `blob:` URL, or served with
permission for cross-origin use).

| Option | Meaning |
| --- | --- |
| `releaseUrl` | URL of the release document. Its paths are relative to it. Required. With `releaseFiles`, the document's path among those files (`release.json`). |
| `releaseFiles` | The release's files as `Blob`s (from a folder input), by path relative to the release document's folder. The worker reads the release from them and fetches nothing for it; each file is checked against its pinned size and SHA-256 as a fetched one is. |
| `workerUrl` | URL of the built `worker.js`. Default: beside the module. The session starts it as an ES module (`type: "module"`); a script that starts it some other way must load it as a module too, since it finds its own files from `import.meta.url`. |
| `wasmPaths` | URL of the folder with ONNX Runtime's WebAssembly files. Default: the worker's folder. |
| `providers` | Execution providers to try, in order, in place of the release's list: `"webgpu"`, `"wasm"`. |
| `mode` | `"pointer"` (default): analyze only around pointer activity. `"always-on"`: analyze continuously. |
| `geometricUrl` | URL of the geometric stage's settings file, to verify candidates with it ("The geometric stage", below). Off without it. |
| `geometricManifestSha256` | The SHA-256 the packed index's `manifest.json` must have; another manifest turns the stage off. |
| `geometricWatchdog` | `false` turns the stage's watchdog off (default on). For measuring the stage only: a slow stage is then never turned off. |
| `onUpdate` | Called whenever the status or what would be shown may have changed. |

| Method | Returns |
| --- | --- |
| `session.at(clientX, clientY)` | `{ name, cardId, box, frameBox }` for the card that would be shown at these viewport coordinates, or `null`. `box` is in CSS pixels of the viewport, `frameBox` in pixels of the analyzed frame. |
| `session.atPointer()` | The same for the pointer's current position over the element. |
| `session.status()` | `state` (`loading`, `ready`, `failed`, `stopped`; a worker that stops after the release has loaded is restarted once without the geometric stage, `loading` meanwhile, and a second stop is `failed`), `error`, the release in effect, `backend`, what the scheduler is doing, frames analyzed, the last frame's times, and `loading`: while the release loads, `{ phase, bytes }` as `loadRelease`'s `onProgress` says it, otherwise `null`. |
| `session.analysis()` | The newest `FrameAnalysis` that still describes the picture on screen, or `null`. |
| `session.cards()` | The catalog's cards: id, name, art path (`null` for a card without art: a bank built from the catalog has no row for it, so it is never named by its own row, though a printing of it that has art still names its identity; a bank extended from one that had a row keeps it), `printingOf` (the card an entry is a printing of, or `null`), and `extra` when the catalog gives the card one (the game's own data, which the runtime never reads). |
| `session.stop()` | Stops analyzing, ends the worker, removes every listener. |

`at` returns `null` when nothing would be shown: the release has not loaded, no card is under
the point, the card under it was detected and not accepted, or the newest result is further
from the picture on screen than the release's `hover.maxAgeMs` of video time.

`createSession` is built on the session core: `SessionCore` (`src/session-core.ts`) decides when
a picture is analyzed and what may be shown, and `createWorkerSession` (`src/worker-session.ts`)
runs the worker that serves it. `createSession` adapts them to an element of its own page: it
listens to the element, captures the picture and runs the driver tick. Its options, methods and
status are the same as before; [CHANGELOG.md](../CHANGELOG.md) lists what a caller may notice.

### For an extension

An extension that cannot run a session in the video page splits it in two: a content script
that watches the video and captures pictures (`dist/page-capture.js`), and an extension frame
that runs the session and the worker (`dist/compute-session.js`, `startComputeFrame`). In the
content script, `createCaptureControl` holds the capture gate, the handshake with the frame and
the transfer of pictures. [docs/extension-session.md](../docs/extension-session.md) has the
messages between them, the controller's rule and a sketch of each side. Both entries are
[experimental](../docs/stability.md#experimental).

### `loadRelease(url, options)` and `analyzeFrame(loaded, frame)`

The lower level, without a worker or any scheduling. It runs in a page, in a worker, or under
Node.

```js
import { analyzeFrame, hoverAt, loadRelease } from "./dist/cardvision.js";

const loaded = await loadRelease("/release/release.json", { wasmPaths: "/dist/" });
const analysis = await analyzeFrame(loaded, imageData);       // RGBA pixels at analysis size
const hit = hoverAt(analysis, x, y);                          // x, y in pixels of that frame
```

`loadRelease` fetches the document and every file it pins, checks each against its SHA-256 and
size, checks that the components belong together, and starts both models. It is
**all-or-nothing**: any failure rejects with a `ReleaseError` that says why, and nothing stays
loaded. There is no fallback to another file. `options.onProgress`, when given, is told where
the load is: `{ phase: "downloading", bytes: null }`, then `bytes` the sum of the pinned files'
sizes once the document is read, then `{ phase: "preparing" }` while the models start (not said
when a file fails). It is advisory: what it throws is ignored. `options.files`, a record of
`Blob`s by path relative to the release document's folder, reads the release from them in place
of fetching it: `url` is then the document's path among them (`"release.json"`), and every check
is the same. `loaded.timings` says where the load's time went, in whole ms: fetching and checking the
files, reading them, then each model's session create, first run, failed providers and total
(`LoadTimings`; measured only).

`analyzeFrame` takes `{ data, width, height }` (an `ImageData` fits) whose width lies within
the release's analysis range (720 to 1920 by default; `analysisSize` gives the size for a
picture) and returns a `FrameAnalysis`:

| Field | Meaning |
| --- | --- |
| `frame` | Size of the analyzed frame |
| `boxes` | Every valid detection, best detector score first: `box` (`[x, y, width, height]`, clipped to the frame), `score`, `cls`, `className`, and `face` |
| `boxes[].face` | For a face: `topId`, `topName`, `similarity`, `margin`, `look` (0 upright, k quarter turns counter-clockwise), `retried`, `tauPassed`, `accepted`, `cardId`, `name`, `kept`; with the tilted retry, on a face it was tried on, `tilted` (`tilt`, `scale` or null, `before`). `null` for a back. |
| `hover` | The hover layer under the release's selection: the cards a pointer is resolved against, bottom of the stack first |
| `tracks` | The track layer: cards with ids that persist between frames and pooled identities, shown once the temporal gate holds |
| `discontinuity`, `retried`, `embeddings`, `timings` | Whether the state between frames was reset; how many faces were retried and embeddings computed; milliseconds per stage (`tiltedMs` while the tilted retry runs) |

`hoverAt(analysis, x, y, selection?)` resolves a pointer against an analyzed frame, under the
release's hover selection or any of the three.

A release with a `tiltedRetry` block gives each face that is still not accepted the tilted retry
([how it works](../docs/how-it-works.md#the-tilted-retry)). `Pipeline.analyze(frame, time,
{ tilted, focus })` skips it on a frame with `tilted: false` (a page's own condition, such as the
kind of footage) and takes the faces under `focus`, a point in the frame's pixels, first; a
worker's frame request carries the same two fields. The session sends neither yet. The worker
turns the retry off for the session when it fails during a frame or takes more than the block's
`budgetMs` on two frames in a row, and says why in a `tilted-status` reply; the session's
status shows it as `tilted`. A worker that is restarted loads the release again, with the retry
on. The default budget, 1500 ms, is a backstop; a product that analyzes at a steady pace sets
its own from measured `tiltedMs` ([choosing a budget](../docs/how-it-works.md#the-tilted-retry)). The scoring page turns the watchdog off and stops a run when the retry fails.

## What is in it

| Module (`src/`) | What it does | Python counterpart |
| --- | --- | --- |
| `detector/letterbox.ts`, `resize.ts` | The detector's input: letterbox, Pillow-exact bilinear resize | `cardvision/detect/letterbox.py` |
| `detector/decode.ts` | The detector's output: scores, threshold, suppression, valid boxes | `cardvision/detect/decode.py` |
| `detector/detector.ts`, `embedder.ts`, `ort.ts` | The two models on ONNX Runtime Web | `cardvision/core/onnx.py` |
| `preprocess.ts` | The `full128` crop contract and quarter turns | `cardvision/core/preprocess.py` |
| `bank.ts`, `identity.ts` | The bank file, and the identity groups under the rule the catalog states | `cardvision/core/bank.py`, `cardvision/core/catalog.py` |
| `recognizer.ts`, `recognition.ts` | Best match and margin; the accept rule; the rotation retry; suppression | `cardvision/recognize/` |
| `tilt.ts` | The tilted retry: the tilt estimate, the straightened rectangles; off unless the release's `tiltedRetry` block turns it on | `cardvision/recognize/tilt.py` |
| `hover-layer.ts`, `hover-geometry.ts`, `scene.ts` | The three hover selections and the hit test | `cardvision/evaluate/hover.py` |
| `tracker.ts`, `temporal-gate.ts` | Tracks with pooled identities; when the track layer is shown | none: the Python command judges each frame alone |
| `cadence.ts`, `frame-scheduler.ts` | When a frame is analyzed: fast around pointer activity, slow while a tooltip shows, idle otherwise; the staleness rule | none |
| `capture.ts` | Reading a frame from the element; cut detection under a shown card; where the picture sits in its element (`pictureBox`, `fractionIn`) | `cardvision/infer/frames.py` (the analysis size only) |
| `release.ts`, `load.ts` | The release document: parse, fetch, verify, build | `cardvision/bank/release.py` |
| `pipeline.ts` | One frame in, boxes, names and two layers out | `cardvision/infer/pipeline.py` |
| `worker.ts`, `worker-host.ts`, `messages.ts` | The worker (what it does with each request is in `worker-host.ts`) and its messages | none |
| `hover-at.ts` | The hit test of a pointer against an analyzed frame (`hoverAt`), apart from the models | none |
| `session-core.ts`, `worker-session.ts` | The session's policy without a page (`SessionCore`); the core with the workers that serve it, their restart and rules 10 to 12 (`createWorkerSession`) | none |
| `session.ts` | `createSession`: the session on an element of its own page | none |
| `compute-messages.ts`, `compute-frame.ts` | The two-frame contract's messages (`computeProtocol`); the compute frame's side of it (`startComputeFrame`) | none |
| `page-capture.ts`, `video-events.ts`, `capture-gate.ts` | The content script's side: the picture a compute frame asked for (`grabFrame`), the video's events (`watchVideo`), when a picture may be given (`captureAllowed`) | none |
| `capture-control.ts` | The content script's controller over them: capture authority from trusted pointer events, the handshake, the message guard (`createCaptureControl`, `fromExtensionFrame`, `acceptComputeOut`, `postWithTransfer`) | none |
| `compute-session.ts`, `page-capture-entry.ts` | The entries of `dist/compute-session.js` and `dist/page-capture.js` | none |
| `geometric/config.ts` | The geometric stage's settings: the same defaults, checks and messages | `cardvision/geometric/config.py` |
| `geometric/index.ts` | The packed descriptor index: fetch, cache, hash, bank binding | `cardvision/geometric/index.py`, `pack.py` |
| `geometric/features.ts`, `match.ts`, `ransac.ts` | A crop's ORB keypoints; the vote's ratio test and the candidate matches; OpenCV's affine fit and the plausibility check | `cardvision/geometric/features.py`, `stage.py` |
| `geometric/fusion.ts`, `stage.ts` | Fusing inliers with the cosine; the stage that verifies a frame's crops | `cardvision/geometric/stage.py`, `cardvision/recognize/recognizer.py` |
| `geometric/vote.ts` | The vote: each crop descriptor's two nearest index descriptors, on WebGPU | `cardvision/geometric/stage.py` (the vote matcher) |
| `geometric/debug.ts` | The stage's opt-in record of a crop: grey-image and keypoint-row hashes, the vote | `cardvision/geometric/stage.py` (`debug_record`) |
| `geometric/opencv.ts` | Loads OpenCV.js (built by `scripts/build-opencv.mjs`, not kept here) | `cardvision/geometric/features.py` (`cv2`) |

The scoring page's own code is in `score/`, apart from the runtime:

| Module (`score/`) | What it does | Python counterpart |
| --- | --- | --- |
| `dhash.ts` | The frame fingerprint and the distance between two | `cardvision/data/dhash.py` |
| `select.ts` | Which decoded frame stands for a manifest row; the step of the walk; whether a browser reports frame times | `cardvision/data/extract.py`, `fetch.py` |
| `manifest.ts` | What the page reads from a manifest; the names of video files and the index of kept ones; which file serves which row | `cardvision/data/manifest.py` (which also validates); `cardvision/data/fetch.py` (the names and the index) |
| `run.ts` | A run: every row to its line of the events file; a section file seen on the video's own timeline | `cardvision/evaluate/browser.py` reads the file and scores it |
| `video.ts` | A `<video>` element read frame by frame; one frame through capture and the worker; a picture at its own size through the worker | none |
| `evidence.ts` | A frame's faces and the outcome at each labeled position, in the format of `evaluate hover --evidence` | `cardvision/evaluate/evidence.py` |

The two pages are in `demo/`, apart from the runtime too:

| File (`demo/`) | What it does |
| --- | --- |
| `index.html`, `demo.ts` | The demo page: it holds the session, moves the file into the page, and draws the outline and the tooltip |
| `view.ts` | What the demo page says for each state of its model and of its file. It touches no page, so the tests cover every state |
| `score.html`, `score.ts` | The scoring page: it reads the inputs, runs `score/`, and shows the result |
| `score-view.ts` | What the scoring page says before a run and after it: the count of rows and matched videos, the result card, the command |
| `page.ts` | What the two pages share, and what the demo page's address may ask of it |
| `theme.css`, `demo.css` | The look: the colors, radii and spacing in `theme.css`, the rest in `demo.css` |

`scripts/pages.mjs` builds the hosted demo from the demo page (`npm run build:pages`), with its
games (`HOSTED_GAMES`), and `scripts/pages-preview.mjs` serves it on this machine
(`npm run preview:pages`).

`examples/score-headless.mjs` is an example of running the scoring page from a script. It is
not part of the runtime.

The settings a release document states are taken from it: the detector's input size, pad
value, tensor names, threshold, suppression overlap and box limit; the minimum crop size; the
recognizer's tensor names and embedding size; `tau`, `delta` and whether the rotation retry
runs; the hover selection and the maximum age of a shown result; the execution providers and
the analysis width. A document that names a contract this runtime does not implement (another
detector family, another preprocessing, another resize) is refused.

## The geometric stage

The optional stage of "An optional geometric stage" in `docs/how-it-works.md`, ported in
`src/geometric/`: for a face whose look the recognizer chose, ORB keypoints of the crop, the
candidates (the embedding's best cards and the cards the whole-index vote finds), OpenCV's
affine fit to each candidate's matches, and the inliers fused with the cosine. It is a port of
the one configuration that was measured (ORB, the exhaustive `bf` vote, `affine` or a model
this OpenCV build has); settings outside it are refused when the stage is opened.

**It is off by default.** A release does not name it, and nothing changes unless the worker's
`load` message carries `geometricUrl`, the address of a settings file (the Python package's
`--geometric` file). The stage then loads after the release, while frames are analyzed
without it, and joins between two frames; the worker reports `geometric-status` with `state`
`loading`, `ready` (with the index's `bytes`) or `off` and the `reason`. With `ready`, `note`
warns when the index was taken with another OpenCV version than the one loaded, as the Python
package does. `createSession` takes it as
the option `geometricUrl` (its `status().geometric` gives the state), and the scoring page
takes it from the local server: `npm run demo -- --release FOLDER --geometric FILE` serves the
settings file's folder, which must hold the packed index, at `/geometric/`. The page then waits
for the stage and refuses to score without it (no WebGPU, or a part that did not load), and the
events file's header records the settings and the stage's state. `examples/score-headless.mjs`
takes the same `--geometric FILE` (give Chrome what it needs for WebGPU with `--chrome-arg`).

**WebGPU only.** The vote runs on WebGPU, on a device the worker asks for with
`voteDeviceLimits(adapter)`. Without WebGPU the stage is off (`no-webgpu`) and recognition is
the embedding's alone: it never votes on the CPU in a page. It is also off when any part fails
to load (`load-failed: ...`), and for the rest of the session when it fails during a frame
(`runtime: ...`; that frame is answered exactly as without the stage), when its GPU device is
lost (`device-lost: ...`), and once it has taken more than 1.5 s of two frames in a row
(`watchdog: ...`). A session whose worker is restarted (see `session.status()`) reports it off
(`worker-restarted`). A face it verified carries `geometric` (the answer before the stage and
every candidate's evidence) and the frame's timings carry `geometricMs`. The stage changes the
answer a face shows, not what the tracker is given: the tracks are built from the cosine looks,
as without the stage.

**The packed index.** The settings file's `index.path` names the manifest of the index as
`cardvision pack-features` packs it, relative to the settings file; its `index.sha256` pins
the index the manifest repacks, and its `features` block must be the index's (as in Python,
another block is refused). The load message's `geometricManifestSha256`, when given, pins the
manifest file itself, and through its shard hashes every shard: a manifest with other bytes is
refused and the stage is off. The index is hosted apart from the code and the release, at
addresses that never change content, so a browser can keep it. A series of packs shares one
folder (for example `vision/geo/<series>/`): each manifest under its own name
(`manifest-<16 hex digits of its source SHA-256>.json`, written with `--manifest-name`) and
every shard beside them, named by content. Nothing there is ever overwritten; the folder only
grows. An index extended with `pack-features --base` keeps its older shards and adds new ones,
so a browser downloads only those. When `--base` refuses (another OpenCV, changed images), pack
again in one step, with `--content-names`, into a new series folder. `src/geometric/index.ts` fetches the manifest,
refuses an index built for another bank or lacking one of the bank's cards, then fetches the
shards the manifest names (eight from a pack in one step without `--content-names`, which leaves
out empty ones; more after `--base`) two at a time, keeps them in
the Cache API (`cardvision-geometric-index`), and checks every shard's SHA-256 each time it
starts. When one shard fails, the other download is aborted. After a load that succeeds,
cached entries outside the manifest's folder (an index no longer in use) are deleted. The
browser may evict the cache under storage pressure; `navigator.storage.persist()` asks it not
to, and exists only in a page, not in a worker, so the page that hosts the worker should call it
if it wants the index kept.

**Tests.** `npm test` runs the stage's tests on fakes, the packed index against the toy index
the Python package packed, and, when OpenCV.js has been built into `vendor/opencv/`, the
OpenCV tests and the stage end to end on toy scenes. Where `vendor/opencv/` is absent, as in
CI, those are skipped, with the reason in their name. The WebGPU vote is not part of
`npm test`: `npm run test:webgpu` (below) is a check run by hand in a Chrome with WebGPU, and
its output recorded.

**The debug record.** A scoring run can ask the worker for the stage's record of each crop (the
`load` message's `geometricDebug`; `createAnalyzer`'s option of that name): the SHA-256 and size
of the post-resize grey image ORB ran on, the resize direction, the crop's size, an id for every
keypoint row (the SHA-256 of its float32 position and descriptor) and the whole vote. A face then
carries it in `geometric.debug`. It decides nothing, and a session never asks for it. It is the
same record the Python package writes with `cardvision evaluate hover --evidence FILE`, and
`score/evidence.ts` writes a frame's faces and events in that command's line format, so that the
two runtimes can be compared crop by crop: same grey image, same keypoints, same vote.

### The vote, on WebGPU

The stage votes with every crop descriptor against every descriptor of the index: for each,
its two nearest by Hamming distance, as OpenCV's `BFMatcher(NORM_HAMMING).knnMatch(k=2)` finds
them. The vote is exact, not approximate: it returns the same rows and distances, and between
equal distances the lower row, which is the order a brute-force matcher keeps. `cpuVoter` is
the reference, in TypeScript, and `gpuVoter` runs the same search as WebGPU compute shaders,
with the index held on the GPU (split over several buffers when the device limits one
binding). On the CPU a whole index is far too slow, which is why the stage needs WebGPU;
`cpuVoter` serves the tests. `npm test` checks `cpuVoter`
against a naive count; `npm run test:webgpu -- --chrome PATH` checks in a headless Chrome
that `gpuVoter` returns exactly what `cpuVoter` returns (it needs `npm install --no-save
puppeteer-core`), and with `--bench` it times the vote on 1.5 million random rows. Paste this
into the terminal, in `browser/`, with `CHROME` set to the path of your Chrome program:

```
npm run test:webgpu -- --chrome "$CHROME" --bench --runs 20
```

You should see something like:

```
13 of 13 checks agree with the CPU voter
{"rows":1500000,"setupMs":12,"options":{},"q500":{"firstMs":13,"medianMs":5.2,"minMs":5.1,"maxMs":6.1},"q6000":{"firstMs":52.1,"medianMs":52.3,"minMs":51.6,"maxMs":52.8},"adapter":"apple metal-3"}
```

That is Chrome for Testing 155 on an Apple M3 Max, wall time per call including the read-back:
about 5 ms for 500 queries and 52 ms for 6,000. Random rows stand in for an index here.

### OpenCV.js

The stage calls OpenCV: grey conversion, resize, ORB, a Hamming matcher and
`estimateAffine2D`. In a browser it runs on OpenCV.js, built from OpenCV's own sources by
`scripts/build-opencv.mjs`. The build is not kept in the repository. It needs git, CMake 3
and python3 on the PATH, and a folder of yours outside the repository for the
sources and the compiler (here `$WORK/opencv-build`). Paste this into the terminal, in
`browser/`:

```
node scripts/build-opencv.mjs --work "$WORK/opencv-build"
```

The script clones OpenCV and the Emscripten SDK at the tag and commit that `opencv.lock.json`
pins, lets the SDK install its compiler, and builds with OpenCV's `platforms/js/build_js.py`.
It writes `vendor/opencv/`, which git ignores:

| File | What it is |
| --- | --- |
| `opencv.mjs` | An ES module; its default export is OpenCV's factory. `src/geometric/opencv.ts` loads it |
| `opencv_js.wasm` | The WebAssembly, fetched by the module from its own folder |
| `opencv.mjs.LEGAL.txt` | The licenses of what the two files hold: OpenCV, the zlib it bundles, and Emscripten's runtime, musl, libc++ and compiler-rt |

`opencv.lock.json` names everything the build depends on: OpenCV 5.0.0, the version the Python
package's index records in its `opencv` field; Emscripten 4.0.20; the list of exposed functions,
`scripts/opencv-whitelist.py`, by its SHA-256; and the options. The build has wasm SIMD and no
threads, so it needs no cross-origin isolation, and no JavaScript eval, so a page's CSP needs
`'wasm-unsafe-eval'` only. The lock also records the SHA-256 of the two files the build made. A
build is compared with it and the script fails on a difference; `--update-lock` records a new
build. No path of the machine is kept in the build: the script maps the work folder to
`opencv/` in the compiler's source paths and in OpenCV's build information, and fails if a
local path is left in either file. Two builds on this machine (macOS, arm64) from two different
work folders were byte-identical; on another machine or toolchain, compare with the lock.

`npm run build` copies the three files into `dist/`, beside `worker.js`, which imports
`opencv.mjs` from its own folder, and only when a stage is asked for. The tests in
`test/opencv.test.ts` and the end-to-end scenes of `test/geometric.test.ts` run on this build
when `vendor/opencv/` exists (or on the module `CARDVISION_OPENCV_JS` names) and are skipped
otherwise, with the reason in their name.

OpenCV.js is one more build of OpenCV, so the rule of the Python package holds here too: expect
the same rates, not the same keypoints for every crop. The compiled code paths differ from a
native build (NEON or SSE there, wasm SIMD here): `resize` can give pixels one level apart, and
ORB itself can take a few other keypoints from the same pixels. On the seven toy scenes of
`test/fixtures/geometric.json`, this build and the Python package's OpenCV 5.0.0 take the same
keypoints on the one crop that is not resized; on the others most descriptors are the same and
a few differ. Given Python's keypoints, the stage chooses, votes and matches exactly as Python.

## Python and the browser

The two implementations are pinned to each other in three ways.

1. **Fixtures.** `test/fixtures/contract.json` holds generated inputs and the answers the
   Python package gives: preprocessing tensors, detector canvases, decoded boxes, a decoded
   bank, look choices, hover outcomes, frame fingerprints, and the events file of a made-up
   scoring run, line for line. `npm test` checks the TypeScript against the file, and
   `tests/test_browser_fixtures.py` (pytest, at the top of the repository) checks the Python
   against it and can write it again. `test/fixtures/toy-release/` is a release of the toy game
   as `cardvision build-release` wrote it, without its model files; the loader's tests use it.
2. **Agreement on frames.** `tests/test_browser_agreement.py` builds toy releases, runs
   `cardvision infer` and this pipeline (under Node, on ONNX Runtime Web's WebAssembly
   backend) on the same generated frames, and compares boxes, decisions and hover outcomes.
   It is skipped without Node and `node_modules`; `.github/workflows/browser.yml` runs it.
   From the repository's root (if you are in `browser/`, run `cd ..` first), paste this into the
   terminal:

   ```
   python -m pytest tests/test_browser_fixtures.py tests/test_browser_agreement.py -q
   ```

   You should see something like:

   ```
   49 passed in 28.63s
   ```

3. **The same release document.** Both sides load the document `cardvision build-release`
   writes, and both refuse it when a file's hash or size is wrong or its id is not the hash of
   its content.

What does not agree bit for bit, and why:

- **Scores.** ONNX Runtime Web and the ONNX Runtime the Python package uses do not round
  alike, and the two sides add a dot product in a different order. Similarities agree to about
  five decimals. A score exactly at `tau` can fall either side. The agreement test requires
  detector scores and boxes to be equal to the last bit, which is a property of its toy model
  (the stand-in detector returns fixed rows); with real weights detector scores agree across
  the two runtimes to about 0.00001, and what must match is the boxes found, their classes,
  the names and the decisions.
- **The analysis frame.** In a page, a picture is brought to analysis size by the browser's
  canvas. The Python command resizes with Pillow. A picture that is already within the
  analysis range is not resized by either.
- **Video decoding.** A browser and OpenCV do not decode a video to the same pixels. The scoring
  page finds a labeled frame by its fingerprint, within the threshold `cardvision fetch` uses,
  and what it measures is the runtime on the browser's own pixels.
- **The frame kept.** Where the picture barely changes, several neighboring frames are within
  that threshold, and the page and `cardvision fetch` may keep different ones of them.

**The geometric stage, checked against Python.** With the One Piece example's release and stage
settings ([adapt-your-game.md](../docs/adapt-your-game.md#measured-on-another-game-the-one-piece-card-game)),
the port ran in Chrome with WebGPU, and the Python stage on the same inputs, on development
data only: 394 generated scenes and the 23 real training frames, never the held-out frames.
The rule, written before the run, compared rates on both and the stage's own steps face by
face.

- **Rates: matched.** On the generated scenes, named right 74.76 % in Python and 74.76 % in the
  browser (difference +0.00 points, 95 % paired interval −0.33 to +0.34), wrong of shown
  3.07 % and 2.94 % (−0.13 points, −0.50 to +0.20); the bars were −3.0 and +1.0 points. The
  stage's gain held in the browser: named right 61.62 % without it and 74.76 % with it (+13.15
  points, +11.35 to +15.10), wrong of shown 4.34 % and 2.94 % (−1.39 points, −2.22 to −0.59).
  On the real frames, named right was 94.08 % on both sides and wrong of shown 1.46 % in
  Python, 1.10 % in the browser.
- **Final answers: identical where the inputs were.** The face-by-face checks are decided on
  the 947 faces whose grayscale crop was byte-identical on both sides (most crops are upscaled,
  and the two `resize` builds differ there). On those faces the shown card or nothing was the
  same on all 622 hover events, with 0 disagreements, and the candidate set was identical on
  99.37 %.
- **Votes and matches: missed the bar.** The rule asked that the vote counts and the
  ratio-test matches be identical on at least 95 % of those faces. They were identical on
  78.04 % and 91.17 %. The cause was traced afterwards: keypoint positions and order agree, but
  ORB's keypoint angle, computed by OpenCV's `fastAtan2`, rounds differently in the native
  arm64 build and in OpenCV.js, by at most 0.0094 degrees on the faces examined. ORB turns its sampling pattern by
  that angle, so a descriptor changes only when a turned point crosses a rounding boundary: 1
  to 5 bits, on about 1 % of keypoints. That moves a vote or a match by one now and then. On
  the faces where every keypoint was identical, votes and matches were identical too.

So the check failed as written, on intermediate values, while every check of rates and
answers passed. The One Piece example's browser extension turns the stage on, where WebGPU
runs, by its maintainer's decision, with this disclosed. The claim that the stage helps on
held-out footage is a claim about the Python stage.

## Third-party code

| Package | Use | License |
| --- | --- | --- |
| `onnxruntime-web` 1.29.0 | Runs the models. The only runtime dependency from npm. | MIT |
| OpenCV 5.0.0, as OpenCV.js | The geometric stage. Built from source by `scripts/build-opencv.mjs`, not from npm and not kept here | Apache-2.0 |
| zlib 1.3.2, as bundled by OpenCV | Compiled into OpenCV.js with OpenCV's core | Zlib |
| Emscripten 4.0.20 | Compiles OpenCV.js; its runtime, musl, libc++ and compiler-rt are compiled into it | MIT or NCSA; musl MIT; LLVM parts Apache-2.0 WITH LLVM-exception |
| `esbuild` 0.28.2 | Bundles (development only) | MIT |
| `typescript` 5.9.3 | Type-checks (development only) | Apache-2.0 |
| `vitest` 5.0.3 | Runs the tests (development only) | MIT |
| `@types/node` 24.19.2 | Types for the scripts and tests (development only) | MIT |

The version of `onnxruntime-web` is the one a release's `runtime.ortWeb` names. A release
measured on another minor version is refused, because a minor version can change the numbers a
model produces. `src/resize.ts` follows the 8-bit resampling of Pillow so that the detector is
fed the pixels it was trained on; see the `NOTICE` file at the top of the repository.

Every build writes `THIRD-PARTY-NOTICES.txt` beside its scripts (`scripts/notices.mjs`): the
MIT License of ONNX Runtime Web in full, and the Apache License 2.0 terms for the code by Google
LLC and the long.js inside its bundle, which the `*.LEGAL.txt` files name. ONNX Runtime
publishes the notices of the libraries compiled into its WebAssembly files upstream.

The example `examples/score-headless.mjs` needs `puppeteer-core` (Apache-2.0), which is not
a dependency of this folder and is not installed by `npm ci`.

No package is installed from this folder by name: `private` is set in `package.json`, and the
folder is used from a checkout.
