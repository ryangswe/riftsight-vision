<!-- SPDX-License-Identifier: Apache-2.0 -->

# The commands

`cardvision` with no arguments lists them in these four groups, and `cardvision --help` ends with
the same list; each command has its own `--help`.

### Start here

| Command | What it does |
| --- | --- |
| `cardvision next` | Look at your game folder and say what is done and the next step: the command to paste, with your real paths, and the page to read. It only looks: it writes nothing and needs no network. [Below](#cardvision-next). |
| `cardvision try` | Steps 1 to 6 of [your-game.md](your-game.md) in one command: import your card list, check the images, build a bank and a release folder, run the released models on your video, and write `report.html` with what came out and what to do next. [Below](#cardvision-try). |
| `cardvision import-catalog` | Write a catalog from a card list you already have: a spreadsheet saved as CSV or TSV, or a JSON list. Reports duplicate ids, names under several ids, the identity rule it suggests and the cards without art. With `--download`, downloads the images the list links to. |
| `cardvision check-catalog` | Load a catalog as every other command does, and print its card count, how many cards have no art, its identity rule and its game. A bad catalog exits 1 with the loader's message (the card id and position). With `--art DIR`, also look at the image of every card, as `check-bank-art` does with no bank. |
| `cardvision check-bank-art` | With no bank, look at the image of every card of a catalog and list the cards whose image is missing or needs a look. With `--bank`, report which rows of the bank were embedded from the images now in your folder, and which were not. Either way it lists the images that deserve a second look: not a picture, a placeholder, or one file under different cards. |
| `cardvision build-bank` | Build the bank and its identity groups from card images, or extend an existing bank (`--base`): rows whose image changed are embedded again in place, new cards are added. |
| `cardvision infer` | Detect and name the cards in images or video, with the models from a release document (`--release`) or from separate files. Can also write annotated frames, crops, a contact sheet, and a pre-fill file for the labeling tool. |
| `cardvision build-release` | Pin models, bank, identity groups, catalog and settings in one release document. |
| `cardvision verify-release` | Check a release document and every file it pins. |
| `cardvision fetch-weights` | Download this repository's released weights (the eight files of v0.1.0) into a folder, check each against its pinned SHA-256, then run `verify-release`. `--list` shows the files and addresses without a request; `--overwrite` replaces a file that differs. An empty DIR, or one inside the repository, is refused. See [release-files.md](release-files.md). |

### Train

| Command | What it does |
| --- | --- |
| `cardvision make-composites` | Generate labeled training scenes from card images. `--card-size WxH` gives the card size in millimeters (default `63x88`); for cards of another size, such as 59 x 86 mm, pass `--card-size 59x86`. `--closeups SHARE` draws that share of the scenes (0 to 1; default 0, none) as close-ups: one large card, sometimes two, tilted 15 to 45 degrees toward the camera, in train and val scenes, never probe ones. They are meant to teach a detector the summon or activation shot of a digital client and a webcam held close over the table; the other scenes stay the same, and recognizer training leaves close-up scenes out. |
| `cardvision fetch-textures` | Download and verify the CC0 background scans the generator can use. |
| `cardvision train-recognizer` | Train the recognizer from a config file. Needs the training environment. |
| `cardvision train-detector` | Fine-tune the detector from a config file. Needs the training environment and YOLOX. |
| `cardvision export` | Export a checkpoint to ONNX and safetensors, with a parity check. |

### Measure

| Command | What it does |
| --- | --- |
| `cardvision evaluate` | Score a configuration on labeled frames: `hover`, `crops`, `detector`, or `compare` two configurations. `hover --browser-events FILE` scores outcomes that the browser runtime's scoring page recorded on video files. `--scenes DIR` scores scenes that `make-composites` generated, by their exact labels: a first look, not a measurement on real video. |
| `cardvision calibrate` | Choose the accept rule's `tau` and `delta` on labeled frames: score a grid of pairs from one analysis of each frame, and recommend one under a limit on wrong names that you set. |
| `cardvision check-refresh` | Check that a new bank only adds to an old one, and changes a row only where its image changed. |
| `cardvision build-features` | Build the geometric stage's descriptor index from card images. Optional; see [how-it-works.md](how-it-works.md). |
| `cardvision pack-features` | Repack a pinned descriptor index into a manifest and shards for the browser runtime. Optional. |

### Data

| Command | What it does |
| --- | --- |
| `cardvision validate-manifest` | Check label manifests: format, ranges, duplicates, groups, card ids, and that no image is present. |
| `cardvision fetch` | Obtain a manifest's frames from video files you have, or by downloading if you ask. `--keep-video DIR` keeps the downloaded video files, and reads the ones already there. |
| `cardvision record-reachable` | Set a manifest's `reachable` fields from the index of a fetch run that downloaded. |
| `cardvision assign-roles` | Give new recording groups a role by a seeded shuffle. |
| `python3 labeler/serve.py` | The labeling tool. Started with no arguments, its page asks what to label. [labeler/README.md](../labeler/README.md) |
| `python3 labeler/export.py` | Export labels as COCO, or as a label manifest. |

Nothing reaches the network unless you ask for it by flag: `fetch --download`,
`fetch-weights`, `try --download`, `fetch-textures`, `import-catalog --download`, `train-detector --download-pretrained`, and
`train-recognizer` when it starts from torchvision's pretrained weights.

## `cardvision next`

```
cardvision next "$GAME"
cardvision next "$GAME" --images "$GAME/card-art"
```

It looks at your game folder and says, line by line, what is done, then the one next step:
a sentence, the commands to paste (with your real paths, quoted for the shell) and the page
to read. It only looks: it writes, creates and downloads nothing, runs no other command and
loads no model, so it is quick and safe to run at any time. Coding agents run it first.

- **Where it looks.** `GAME` is the argument, else `$GAME`, else `~/Downloads/my-game`;
  `--weights DIR`, else `$WEIGHTS`, else `~/Downloads/cardvision-weights`; `--images DIR`
  names the card images' folder as `try --images` does, wherever it is (it wins over the
  last `try`'s log and the folders below; an empty value, `/`, the home folder or a folder
  holding the game folder is refused with exit code 2). When it is not the folder the last
  `try` used, the `try` check is `changed` and the next step is the `try` line with
  `--overwrite`. The first line says
  which folder it looked at and why. When the weights folder lacks the files and the last
  `try --download` put them in `cardvision-try/weights`, that folder is taken. A `GAME`
  written the Windows way (`C:\...`) gets a hint about WSL paths; a folder the terminal may not
  read (on macOS, the Files and Folders permission) is said so, with how to allow it.
- **What it checks, in order:** the folder; a card list at its top (`.csv`, `.tsv`, or a
  `.json` catalog or list of rows; a `catalog.json` beside another list is taken for the one
  the step-by-step page wrote); the card images (the folder the last `try` used, as its
  `try.log` records for this run's own catalog, while it holds image files and is neither `/`,
  the home folder nor a folder holding the game folder; else, with no `--images`, `images/` or
  `art/`, else the one folder holding image files); a video, a picture or a folder of
  pictures at the top (any folder but the card images' one); the three files
  `try` needs in the weights folder, each by its size and SHA-256 against the table
  `fetch-weights` checks its downloads against (read from disk, about 7.7 MB, no network),
  unless the folder's `release.json` is not the released one but a JSON document with a
  `schemaVersion`: then it is your own release folder, its models are yours, and the check is `done` ("your own release folder; its models
  are not checked"); a completed run of `try` in `cardvision-try/` (its
  `.cardvision-try` names `report.html`), and whether the card list, the newest file under the
  images folder or the video is newer than its report (edited, or only copied again: the time
  alone can't tell); then the run's verdict and its cards
  with no image.
- **The next step** is the first of these not done: what to put where; `fetch-weights`. When a file is there but is not the released one, the step names it:
  in a download of the release (the pinned `release.json` is there) it is `fetch-weights DIR
  --overwrite`, which replaces files that differ (without it, `fetch-weights` stops); with
  no `release.json` the files may be yours, so it is `fetch-weights` into a new, empty folder
  to give with `--weights`, never `--overwrite`; `fetch-weights` is never suggested into your
  own release folder, so a file missing from it is yours to copy in; a file the terminal can't read gets a step
  to check its permissions; the
  `try` line (with `--overwrite` when a run is there); then, by the verdict, a clearer view
  ([your-game.md](your-game.md), step 5), [train.md](train.md), the images to add, or the
  demo line and [extension.md](extension.md). Labeling, training, measuring and extension
  builds are not tracked.
- When several card lists or videos are there, it takes the one named `cards` (or `video`),
  or for card lists the one CSV or TSV among them, and says so; when none stands out, the next
  step is to choose. When several folders hold image files and none is `images/` or `art/`,
  the next step is to rename the card images' folder to `images/` or name it with `--images`.
- **`STOP (coding agents: ask the person first):`** follows the `Next:` line when the step
  needs the person: a download, files only they have, a choice, a permission, or training's
  cost and time. **`Playbook (for coding agents):`**, last, names the page in `playbooks/` an
  agent loads for the step.
- Names are shown with control characters escaped (`\r`, `\x1b`). A command that holds such a
  name is not printed: the step is to rename it (`--json` still gives the command as it is).
- Exit codes: 0 whenever it could look, whatever it found; 2 for a usage error, such as a
  `GAME` that is a file.

**`--json`** prints one object instead, for agents and tools. Its shape is kept stable
([stability.md](stability.md)); a change of shape changes `schemaVersion`:

| Field | Holds |
| --- | --- |
| `schemaVersion` | `1` |
| `game`, `weights` | `{path, chosen}`: the absolute path, and `argument`, `environment` or `default` |
| `checks` | In this order, one `{id, state, detail, paths, taken, blocks, source}` each, with the ids `folder`, `cards`, `images`, `video`, `weights`, `try`, `verdict` and `no-image`. `state` is `done`, `missing`, `choice` (several found) or `changed` (inputs newer than the last try's report, or `--images` naming another folder than the last try's); `detail` is the line for people; `paths`, the absolute paths it is about; `taken`, the path a choice took when one stood out, else `null`; `blocks`, `true` for a choice none stood out in; `source`, on `images` and `weights` only (else `null`): `game-folder`, `last-try`, `last-try-download`, `argument`, `environment` or `default` |
| `next` | `{id, say, stop, notes, commands, doc, after, playbook}`, below |
| `verdict` | `null` before a run, else `{kind, frames, framesWithFaces, faces, backs, named, distinct}`, `kind` being `named`, `few` or `none` |
| `noImage` | `null` before a run, else `{none, own, total}`: the cards that can't be named for want of an image, those with no image of their own, and the list's count |

`next.id` is one of `folder`, `folder-access` (the folder can't be read), `cards`, `images`,
`video` (put it there, or choose), `weights`, `try`, `add-images`, `clearer-view`, `train` and
`demo`. `say` is the sentence;
`notes`, lines that go with it; `commands`, the lines to paste, in order; `doc`, the page to
read from the repository's root, with an anchor when it is a section; `after`, the lines that
follow. `playbook` is `playbooks/try-my-game.md` up to and including the try and its report
(and adding images), `playbooks/make-extension.md` after a `named` verdict, and
`playbooks/train.md` after `few` or `none`. `stop` is `null`, or `{reason, say}` with
`reason` one of `download` (fetch-weights), `persons-file` (the card list, the images or
the video are not there, or a clearer video is needed: they come from the person, never from
a download by the agent), `persons-choice` (several card lists, image folders or videos),
`persons-permission` (the folder, or a weights file, can't be read until the person allows it) and
`spend-or-time` (the verdict points to training: a GPU and labeling time). Running `try` and
opening the demo carry no stop.

## `cardvision try`

```
cardvision try "$GAME/cards.csv" --images "$GAME/images" --video "$GAME/video.mp4" --weights "$WEIGHTS"
```

It runs the commands of [your-game.md](your-game.md), steps 1 to 6, one after the other, and
writes their files where that page does, in `--out DIR` (default: `cardvision-try/` beside the
card list, never inside the repository): `catalog.json`, `bank.json`,
`bank.identity-groups.json`, `out/` (`annotated/`, `crops/`, `sheet.png`, `results.jsonl`) and
`release/`. Beside them it writes `import-report.txt` and `import-report.json` (the
importer's report, as text and as JSON), `try.log` (every command and what it printed),
`report.html`, and `.cardvision-try`, the list of the names this run wrote.

- **The card list** is passed to `import-catalog` with `--map`, `--identity`, `--facets` and
  `--delimiter` as given; when it stops, `try` stops with its message. A file that is already a
  catalog is used as it is.
- **The weights**: `--weights DIR` is any folder holding `detector.onnx`, `recognizer.onnx` and
  `accept.json` (the one `fetch-weights` fills, or a release folder). Without it, `OUT/weights`
  is used; when that is empty it stops with the `fetch-weights` line, and `--download` runs
  `fetch-weights` there first.
- **The video** may be a video, a picture or a folder of images. Without `--every`, frames are
  taken so that at most `--max-frames` (default 60) are analyzed, never more than one a second
  (a video that does not state its length is read once to measure it); a folder of more images
  is thinned to that many.
- **The report page** says which of three outcomes it was: found and named, found but few
  named (fewer than half the faces), or no cards found. It holds the summary, the contact
  sheet, the annotated frames, the importer's notes and the accept rule in use. The command
  ends with three lines: the verdict, the page's path and the line that opens the
  [demo page](../browser/README.md) on this run, which starts with `npm ci` when the page's
  packages are not installed yet (no `browser/node_modules`). For a video in a codec browsers may not play
  (such as mp4v), a line before them says: if the video does not play in the demo, convert it
  first, with the ffmpeg command for it.
- **Before you share a report:** `report.html`, `try.log` and the demo line hold absolute paths,
  which name your home folder and so often your user name.
- **Again**: each run is built in a staging folder inside `--out` (`.try-new-` and a number)
  and moved into place only when every step succeeded. A run that fails, or is interrupted,
  deletes its staging folder and changes nothing else. `--overwrite` replaces what an earlier
  run of `try` wrote, as its `.cardvision-try` lists, and only once the new run has succeeded;
  without it, such a folder is refused. A file or folder under one of the names above that
  `try` did not write, such as a `catalog.json` you made with the step-by-step page, is never
  replaced: the run is refused, even with `--overwrite`, and names it.

## `cardvision import-catalog`

```
cardvision import-catalog cards.csv --out my-game/catalog.json --game my-game \
    --facets Color,Cost --split 'Color=;' --images my-game/images
```

The card list is a `.csv`, a `.tsv` or a `.json` file (a list of rows, or `{"cards": [...]}`),
in UTF-8 with or without a byte-order mark. One card a row.

- **From a spreadsheet.** A `.xlsx`, `.xls`, `.numbers` or `.ods` file is refused with the
  advice to export it as CSV (UTF-8) first. If your spreadsheet program saves CSV with
  semicolons between the cells, the importer says so when it sees one, and
  `--delimiter ';'` reads it. `--delimiter CHAR` is for CSV only; a TSV always uses tabs.

- **Columns.** The catalog's fields are found by their header, without case. In order of
  preference:
  - `id`: id, card id, card no, card no., card #, card number, number, collector number, collector
    no, code, card code, set code, serial.
  - `name`: name, card name, title, card title.
  - `kind`: kind, type, card type, category.
  - `printing_of`: printing_of, printingOf, reprint of, reprint, alternate of.
  - `image`: image, art, image url, image file, picture, image link, art url, img, image path.

  When a sheet has more than one header for a field, the first in that order is taken and
  the report says so, for example `id column: "Number" (also matched: "Set Code"; --map
  id=HEADER to choose)`. The report always lists which header fed each field. `--map
  FIELD=HEADER` names a column the headers do not give away, or picks another one of
  several. `id` and `name` are needed.
- **The other columns.** `--facets COL,...` makes columns into facets, the labeling tool's
  filters; a column whose every value is a number, none with a leading zero (`008` stays
  text), becomes a number facet, and the report says which. `--split COL=SEP`
  splits cells that hold several values (quote it: `';'` means something to the shell). By
  default every other column goes to each card's `extra` object, which nothing reads, and the
  report lists them so that you can choose: `--extra COL,...` keeps only those, `--no-extra`
  none. An empty cell is left out.
- **Images.** A file path is relative to `--images DIR`, which is also where they are
  checked. A URL stays a URL in the catalog, and nothing is downloaded, unless you pass
  `--download`: it is then downloaded into `--art-out DIR` (by default `art/` beside `--out`),
  one request at a time with `--delay` seconds between them (default 1). Only JPEG, PNG and WebP
  files of at most 5 MB are kept, by their first bytes; a download that fails leaves the card
  without art, with the reason in the report. A request is made once more, and only once,
  after a server error (HTTP 5xx), HTTP 429, a timeout, or a dropped connection or a body
  cut short; never after any other failure. Redirects go only to http(s), never from https
  to http. A file already there is not downloaded again, so a run
  that stopped can be run again with `--overwrite`.
- **Checks.** A row without an id or a name, an id used twice, and a `printing_of` that names
  no card are errors, and nothing is written. The report also lists names under several ids,
  one image file under several cards, the cards without art and the shapes of the ids. It
  suggests an identity rule: `printing` when the list uses `printing_of`, `name` otherwise,
  and writes it unless `--identity` says which. The catalog is then read back by the
  catalog's loader, and its images are looked at as `check-bank-art` does, when every image
  is a local file.
- **Output.** `--out` is not replaced unless `--overwrite` (`--force` still works, under its old name). `--report FILE` also writes the
  report as JSON. The exit code is 1 when nothing was written.

**Download only images you are allowed to.** Some publishers' sites forbid automated
downloading in their terms. Prefer the source's own bulk download, or a folder of images you
already have (`--images`), and leave out `--download` when in doubt.

**Tests:** paste this into the terminal, from the repository's root:

```
python -m pytest
```

To spread them over every processor core, which is what CI does, add `-n auto --dist loadfile`
(the lock files include `pytest-xdist`). On an Apple M3 Max with four workers this took the run
from about seven minutes to about two. `--dist loadfile` keeps each test file on one worker, so
the setup a file shares between its tests runs once.

In the environment of the [quickstart](quickstart.md) (its step 1, Install), when this page
was written, this ran about 2,500 tests in about six minutes, with 9 skipped because they need
PyTorch. `requirements-lock-train.txt` says how to build the training environment that runs
those too. One more is skipped, the comparison with the browser runtime, until `npm ci` has been
run in `browser/`. On a machine without the `ffmpeg` program, the tests that need it are
skipped as well: one test of `tests/test_data_extract.py`, in its four cases, and the tests of
`tests/test_data_frame_times.py` that read a recording of variable frame rate, in 38 cases.
