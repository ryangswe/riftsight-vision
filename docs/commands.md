<!-- SPDX-License-Identifier: Apache-2.0 -->

# The commands

`cardvision` with no arguments lists them in these four groups, and `cardvision --help` ends with
the same list; each command has its own `--help`.

### Start here

| Command | What it does |
| --- | --- |
| `cardvision import-catalog` | Write a catalog from a card list you already have: a spreadsheet saved as CSV or TSV, or a JSON list. Reports duplicate ids, names under several ids, the identity rule it suggests and the cards without art. With `--download`, downloads the images the list links to. |
| `cardvision check-catalog` | Load a catalog as every other command does, and print its card count, how many cards have no art, its identity rule and its game. A bad catalog exits 1 with the loader's message (the card id and position). With `--art DIR`, also look at the image of every card, as `check-bank-art` does with no bank. |
| `cardvision check-bank-art` | Report which rows of a bank were embedded from the images now in your folder, and which were not. With no bank, look at the image of every card of a catalog. Either way it lists the images that deserve a second look: not a picture, a placeholder, or one file under different cards. |
| `cardvision build-bank` | Build the bank and its identity groups from card images, or extend an existing bank (`--base`): rows whose image changed are embedded again in place, new cards are added. |
| `cardvision infer` | Detect and name the cards in images or video, with the models from a release document (`--release`) or from separate files. Can also write annotated frames, crops, a contact sheet, and a pre-fill file for the labeling tool. |
| `cardvision build-release` | Pin models, bank, identity groups, catalog and settings in one release document. |
| `cardvision verify-release` | Check a release document and every file it pins. |

### Train

| Command | What it does |
| --- | --- |
| `cardvision make-composites` | Generate labeled training scenes from card images. |
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
`fetch-textures`, `import-catalog --download`, `train-detector --download-pretrained`, and
`train-recognizer` when it starts from torchvision's pretrained weights.

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

- **Columns.** The catalog's fields are found by their header, without case: `id` (id, card
  id, code), `name` (name, card name), `kind` (kind, type), `printing_of` (printing_of,
  printingOf, reprint of) and `image` (image, art, image url, image file). `--map
  FIELD=HEADER` names a column the headers do not give away. `id` and `name` are needed.
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
