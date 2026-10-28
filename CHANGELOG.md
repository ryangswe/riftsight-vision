<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows the
versioning rule in [docs/stability.md](docs/stability.md). Before 1.0, a minor version may
break the public surface; this file names each break and how to migrate.

## [Unreleased]

## [0.4.0] - 2026-10-28

The geometric stage's index can take new cards without changing what was there, and a release
can be converted to a binary bank whose files each stay under a browser add-on store's 5 MiB
limit on text files. It is release candidate 0.4.0rc2, listed below it, unchanged; that
candidate added the binary bank to 0.4.0rc1. Nothing in the public surface breaks. The
released models are unchanged: release `201478a00d6ef6ba`.

### Added

- `cardvision build-features --base OLD` and `pack-features --base MANIFEST` add new cards to the
  geometric stage's index without changing what was there. `build-features --base` copies the
  old index's cards unchanged and in order and takes keypoints only for the new cards, after
  them; over a bank extended with `build-bank --base` it writes the same bytes as a full build.
  `pack-features --base` keeps the old pack's shards byte for byte and puts the new cards in new
  shards named by content (`shard-<16 hex>.bin`), so a page that keeps the index downloads only
  the new shards. Both refuse an old index or pack built with other `features` settings or
  another OpenCV version. `build-features --base` also refuses an old card whose image changed or
  that the bank (or, without one, the catalog) no longer lists; `pack-features --base` also
  refuses a base pack whose shards are named by position. `pack-features --content-names` starts
  such a series, and `--manifest-name` lets successive manifests share one folder. The manifest
  format is unchanged (`schemaVersion` 1), and so is a pack made without the new flags.
- `bank.bin`, a binary form of the bank, and `cardvision convert-release RELEASE --out DIR`,
  which writes a release with smaller files and the same values. The bank becomes `bank.bin`:
  the same fp16 bytes as the JSON bank's base64 text, after a JSON header that holds the bank's
  other fields and its card ids. The catalog is written as compact JSON. The converted release
  has a new id and scores exactly as the original. Every reader of a release, `verify-release`,
  `infer --release`, `evaluate`, the other bank commands and the browser runtime, takes either
  form of the bank, and refuses a `bank.bin` of a format version it does not know. The JSON bank
  is unchanged and stays the default. A geometric index records the SHA-256 of the bank it
  serves, so build it again against the converted release. A converted release needs
  cardvision 0.4.0rc2 or later, in Python and in the browser; older readers refuse it.
  [docs/release-files.md](docs/release-files.md#the-binary-bank-bankbin) has the format.

### Changed

- NOTICE says that its statements describe this repository and its own Riftbound release. A
  product built on this code for another game carries its own notice for that game's data; the
  Riot Games statements do not apply to it.
- `browser/` is type-checked with TypeScript 7.0.2 and tested with vitest 5.0.5. The runtime's
  JavaScript is built as before and does not change. A product that vendors the runtime and
  emits its declaration files with TypeScript 7 sets `rootDir` to `"src"` in that `tsc` run;
  without it, TypeScript 7 stops with error TS5011.

### Security

- The training lock (`requirements-lock-train.txt`) pins filelock 4.2.4. The 4.1.0 it pinned
  before has six published advisories, all fixed in 4.2.1. Only the training environment
  installs filelock.

## [0.4.0rc2] - 2026-10-27

Second release candidate for 0.4.0. It adds a binary form of the bank, so a browser add-on can
ship a release whose files each stay under a store's 5 MiB limit on text files. Everything
0.4.0rc1 added is unchanged.

### Added

- `bank.bin`, a binary form of the bank, and `cardvision convert-release RELEASE --out DIR`,
  which writes a release with smaller files and the same values. The bank becomes `bank.bin`:
  the same fp16 bytes as the JSON bank's base64 text, after a JSON header that holds the bank's
  other fields and its card ids. The catalog is written as compact JSON. Both files get smaller,
  and the bank is no longer a text file, which a browser add-on store's 5 MiB limit on text
  files needs. The converted release has a new id and scores exactly as the original.
  Every reader of a release, `verify-release`, `infer --release`, `evaluate`, the other bank
  commands and the browser runtime, takes either form of the bank, and refuses a `bank.bin` of a
  format version it does not know. The JSON bank is unchanged and stays the default. A geometric
  index records the SHA-256 of the bank it serves, so build it again against the converted
  release. A converted release needs this version or later, in Python and in the browser;
  older readers refuse it. [docs/release-files.md](docs/release-files.md#the-binary-bank-bankbin)
  has the format.

## [0.4.0rc1] - 2026-10-27

First release candidate for 0.4.0. The geometric stage's index can take new cards without
changing what was there, so a page that keeps the index downloads only the new cards' shards.
Nothing in the public surface breaks, and the browser runtime behaves exactly as in 0.3.0. The
released models are unchanged: release `201478a00d6ef6ba`.

### Added

- `cardvision build-features --base OLD` and `pack-features --base MANIFEST` add new cards to the
  geometric stage's index without changing what was there. `build-features --base` copies the
  old index's cards unchanged and in order and takes keypoints only for the new cards, after
  them; over a bank extended with `build-bank --base` it writes the same bytes as a full build.
  `pack-features --base` keeps the old pack's shards byte for byte and puts the new cards in new
  shards named by content (`shard-<16 hex>.bin`), so a page that keeps the index downloads only
  the new shards. Both refuse an old index or pack built with other `features` settings or
  another OpenCV version. `build-features --base` also refuses an old card whose image changed or
  that the bank (or, without one, the catalog) no longer lists; `pack-features --base` also
  refuses a base pack whose shards are named by position. `pack-features --content-names` starts
  such a series, and `--manifest-name` lets successive manifests share one folder. The manifest
  format is unchanged (`schemaVersion` 1), and so is a pack made without the new flags.

### Changed

- NOTICE says that its statements describe this repository and its own Riftbound release. A
  product built on this code for another game carries its own notice for that game's data; the
  Riot Games statements do not apply to it.

### Security

- The training lock (`requirements-lock-train.txt`) pins filelock 4.2.4. The 4.1.0 it pinned
  before has six published advisories, all fixed in 4.2.1. Only the training environment
  installs filelock.

## [0.3.0] - 2026-10-26

The labeling tool handles cards seen at an angle and stacked cards, `make-composites` can draw
close-ups, and `cardvision next` checks the downloaded models. It is release candidate
0.3.0rc1, listed below it, unchanged. Nothing in the public surface breaks. The released models
are unchanged: release `201478a00d6ef6ba`.

### Added

- The labeling tool's Boxes pass labels a card seen at an angle: Shift+drag a corner of a box and
  its corners come free, so each one moves onto the card's own corner. `s` snaps them to the
  card's edges, and `e` makes the box a rectangle again. The card's top stays where it was. The
  manifest export writes such a box with the shape `quad`; every other box is written as
  before. The labeling guide no longer says to mark a steeply angled card ignore.
- `make-composites --closeups SHARE` draws that share of the scenes as close-ups: one large card,
  sometimes two, tilted 15 to 45 degrees toward the camera and filling 25 to 80 % of the frame's
  height, often with a glow around it, as in a digital client's summon or activation shot or a
  webcam close over a table. Each card's corners and homography are exact, and its `pose` gives
  the tilt. The manifest records the share and ranges under `parameters.closeups`, and `--check`
  checks that each close-up holds a positive face with a convex, clockwise quad. The default, 0,
  draws none: a run without the flag writes the same bytes as before, and with it the scenes
  that are not close-ups stay the same.
- `cardvision export detector --no-fp16-weights` writes and checks the float32 file only, with
  no half-precision copy (`<name>-fp16w.onnx`) and no parity check for one.
- `cardvision next --images DIR` takes the card images' folder from you, as `try --images` does,
  for art kept outside the game folder before a first `try`. It wins over `images/`, `art/` and
  the last `try`'s log, and the `try` line it prints carries the folder. `--json` gives
  `source: "argument"` for it. An empty value, `/`, the home folder or a folder holding the game
  folder is refused. When the folder is not the one the last `try` used, `next` says to run `try`
  again with `--overwrite`.
- The labeling tool's stacking view (`o`, or Options) shades the part of each box that no box
  above it covers and numbers its layer within its stack, to check a stack's order at a glance.
  Nothing it shows is saved.
- In the Boxes pass, `d` then an arrow adds a box of the same size and angle against that side of
  the selected box, for the next card of a stack or a row: only its far edge is left to fit.
- Copy, paste and duplicate (Cmd/Ctrl+C, V, D) take several selected boxes; a group keeps its
  spacing.

### Changed

- `cardvision next` checks the weights' size and SHA-256 against the table `fetch-weights` uses,
  instead of taking the files' presence for done. A file of the wrong size or contents is named
  in the check's `detail` and the step's `notes`. In a download of the release the next step is
  `cardvision fetch-weights DIR --overwrite`; in a folder with no released `release.json` it is a
  download into a new, empty folder, never `--overwrite`; a file that can't be read gets a step
  to check its permissions. A folder whose `release.json` is another JSON document with a
  `schemaVersion` is your own release folder and is not checked; a file missing from it is yours to
  copy in, and `fetch-weights` is never suggested into it or into a folder holding other files with
  the released names. Nothing is downloaded and about 7.7 MB are read, so it stays quick.
- The labeling tool's layer keys `.` and `,` move a box one layer up or down among the boxes it
  overlaps, rather than through every box in the frame. A turned box may run past the frame's
  edge, as a card cut off by the picture's edge does, within the range the export accepts.
- After you update the toolkit, a labeling page newer than the running `labeler/serve.py` says so
  and waits for you to restart the tool, rather than half working.
- [What we tried](docs/what-we-tried.md) has a section on finding a card's four corners with a
  model, and why both attempts were set aside.

### Fixed

- `cardvision next` no longer calls a partial or corrupted weights download done: a file of the
  wrong size or contents now reads `missing`, with the file named.
- The labeling tool's Boxes pass no longer lets a turn or a fit push a turned box's corner more
  than a whole frame outside the picture, where the export would have left the frame out: `r`,
  `R`, `w`, `W`, `e` and the turning knob stop with a word why and leave the box as it was. A box
  already past that limit can now be resized or turned back toward the picture; a change that
  puts a corner further out is still refused.

## [0.3.0rc1] - 2026-10-24

First release candidate for 0.3.0. The labeling tool handles cards seen at an angle and stacked
cards, `make-composites` can draw close-ups, and `cardvision next` checks the downloaded models.
Nothing in the public surface breaks. The released models are unchanged: release
`201478a00d6ef6ba`.

### Added

- The labeling tool's Boxes pass labels a card seen at an angle: Shift+drag a corner of a box and
  its corners come free, so each one moves onto the card's own corner. `s` snaps them to the
  card's edges, and `e` makes the box a rectangle again. The card's top stays where it was. The
  manifest export writes such a box with the shape `quad`; every other box is written as
  before. The labeling guide no longer says to mark a steeply angled card ignore.
- `make-composites --closeups SHARE` draws that share of the scenes as close-ups: one large card,
  sometimes two, tilted 15 to 45 degrees toward the camera and filling 25 to 80 % of the frame's
  height, often with a glow around it, as in a digital client's summon or activation shot or a
  webcam close over a table. Each card's corners and homography are exact, and its `pose` gives
  the tilt. The manifest records the share and ranges under `parameters.closeups`, and `--check`
  checks that each close-up holds a positive face with a convex, clockwise quad. The default, 0,
  draws none: a run without the flag writes the same bytes as before, and with it the scenes
  that are not close-ups stay the same.
- `cardvision export detector --no-fp16-weights` writes and checks the float32 file only, with
  no half-precision copy (`<name>-fp16w.onnx`) and no parity check for one.
- `cardvision next --images DIR` takes the card images' folder from you, as `try --images` does,
  for art kept outside the game folder before a first `try`. It wins over `images/`, `art/` and
  the last `try`'s log, and the `try` line it prints carries the folder. `--json` gives
  `source: "argument"` for it. An empty value, `/`, the home folder or a folder holding the game
  folder is refused. When the folder is not the one the last `try` used, `next` says to run `try`
  again with `--overwrite`.
- The labeling tool's stacking view (`o`, or Options) shades the part of each box that no box
  above it covers and numbers its layer within its stack, to check a stack's order at a glance.
  Nothing it shows is saved.
- In the Boxes pass, `d` then an arrow adds a box of the same size and angle against that side of
  the selected box, for the next card of a stack or a row: only its far edge is left to fit.
- Copy, paste and duplicate (Cmd/Ctrl+C, V, D) take several selected boxes; a group keeps its
  spacing.

### Changed

- `cardvision next` checks the weights' size and SHA-256 against the table `fetch-weights` uses,
  instead of taking the files' presence for done. A file of the wrong size or contents is named
  in the check's `detail` and the step's `notes`. In a download of the release the next step is
  `cardvision fetch-weights DIR --overwrite`; in a folder with no released `release.json` it is a
  download into a new, empty folder, never `--overwrite`; a file that can't be read gets a step
  to check its permissions. A folder whose `release.json` is another JSON document with a
  `schemaVersion` is your own release folder and is not checked; a file missing from it is yours to
  copy in, and `fetch-weights` is never suggested into it or into a folder holding other files with
  the released names. Nothing is downloaded and about 7.7 MB are read, so it stays quick.
- The labeling tool's layer keys `.` and `,` move a box one layer up or down among the boxes it
  overlaps, rather than through every box in the frame. A turned box may run past the frame's
  edge, as a card cut off by the picture's edge does, within the range the export accepts.
- After you update the toolkit, a labeling page newer than the running `labeler/serve.py` says so
  and waits for you to restart the tool, rather than half working.
- [What we tried](docs/what-we-tried.md) has a section on finding a card's four corners with a
  model, and why both attempts were set aside.

### Fixed

- `cardvision next` no longer calls a partial or corrupted weights download done: a file of the
  wrong size or contents now reads `missing`, with the file named.
- The labeling tool's Boxes pass no longer lets a turn or a fit push a turned box's corner more
  than a whole frame outside the picture, where the export would have left the frame out: `r`,
  `R`, `w`, `W`, `e` and the turning knob stop with a word why and leave the box as it was. A box
  already past that limit can now be resized or turned back toward the picture; a change that
  puts a corner further out is still refused.

## [0.2.0] - 2026-10-24

The newcomer release: try the toolkit on your own game in one command, ask it for the next step,
and label with a guide. It collects release candidates 0.2.0rc1 to 0.2.0rc4, listed below it.
The released models are unchanged: the v0.1.0 files, release `201478a00d6ef6ba`.

### Added

- `cardvision try CARDS --images DIR --video FILE`: the steps of the your-game guide in one command
  (import, image check, bank, release folder, `infer`), ending in a `report.html` with the outcome,
  the contact sheet, the annotated frames and the line that opens the demo page (with `npm ci`
  first when `browser/node_modules` is missing). A `No image:` line before the verdict, and a list
  in the report, name the cards in your list that have no image.
- `cardvision next [GAME]`: looks at the game folder, the weights folder and the last `try` run,
  and says what is done and the one next step, with the exact command, the doc to read, the
  playbook for a coding agent, and a `STOP:` line when the step needs the person. `--json` prints
  the same as a stable object. It only reads.
- `cardvision fetch-weights DIR`: download the released model files, check each one's size and
  SHA-256 against the pins, resume, and finish with `verify-release`; `--list` makes no request.
- `cardvision import-catalog`: write a catalog from a CSV, TSV or JSON card list, recognizing
  common header names without `--map`; images are downloaded only with `--download`.
- `cardvision check-catalog`: load a catalog and report its card count, cards without art,
  identity rule and game.
- `cardvision make-composites --card-size WxH`: the card size in millimeters (default `63x88`),
  recorded in the manifest as `parameters.cardAspect`.
- A per-card `extra` object in the catalog, kept as given and read by nothing.
- The Riftbound catalog declares three facets, Domain, Energy and Set, so the labeling tool's
  Names pass filters by them; the labeling tool says when a catalog declares none.
- Newcomer documentation: a start-here page, a guide for your own game, the guide split into
  train, measure and extension pages, and [How to label](docs/labeling.md) with pictures of real
  labeled frames.
- `CHANGELOG.md`, `RELEASING.md` and `docs/stability.md`; a monthly grouped Dependabot update.

### Changed

- `AGENTS.md` is a short router (start with `cardvision next`, one playbook per job, when to stop
  and ask the person); the step-by-step tiers moved into `playbooks/`.
- The quickstart and the setup playbook check `python3 --version` first and say what to do when it
  is older than 3.11.
- `cardvision` with no arguments, and the end of `--help`, list the commands in groups.
- `composites`: a generated folder's manifest that is not a JSON object, or not valid JSON, is
  reported as an error naming the file.
- Runs of `make-composites` without `--card-size` lay out the same scenes as 0.1.0; Pillow 13.0.0
  changes a few pixels of a few composites, which is harmless for training.
- CI runs the Python tests on every core with pytest-xdist; the sign-off check skips commits
  authored by Dependabot.

### Security

- Pillow 13.0.0, which fixes flaws in reading JPEG, TIFF, GIF, EPS and PDF files, is pinned in
  both lock files for every supported Python.

### Removed

- **Breaking:** Python 3.10 is no longer supported; use 3.11 or 3.12. `requires-python` is now
  `>=3.11`. To migrate, create a new virtual environment with Python 3.11 or 3.12 and reinstall.
  On Windows, use Ubuntu 24.04 under WSL (22.04 has Python 3.10).

### Fixed

- `games/riftbound/catalog.json` holds the same cards as the released models' catalog: 20 cards
  it lacked, most of them from Radiance, and the English names of RAD-053, RAD-078 and RAD-123.
- `import-catalog` refuses an id that holds a space, and an import in which none of the listed
  images is found, naming a path it looked for; nothing is written.
- `build-bank` and `build-release` name `--overwrite` when they refuse to replace a different file.
- The demo finds an image whose path has a folder (`HD/x.jpg`), and a video it cannot open gets
  the `ffmpeg` command that converts it to H.264.

## [0.2.0rc4] - 2026-10-22

Fourth release candidate for 0.2.0. The Riftbound catalog gets the released models' cards and
the labeling tool's filters. The released models are unchanged: release `201478a00d6ef6ba`.

### Added

- The Riftbound catalog (`games/riftbound/catalog.json`) declares three facets, Domain, Energy
  and Set, so the labeling tool's Names pass filters by them. The labeling tool says when a
  catalog declares no facets, and where to read how to add them.

### Fixed

- `games/riftbound/catalog.json` now holds the same cards as the released models' `catalog.json`
  (release `201478a00d6ef6ba`): 20 cards it lacked, most of them from Radiance, and the English
  names of RAD-053, RAD-078 and RAD-123, which it had under their Chinese preview names. Labels
  can now name those cards.

## [0.2.0rc3] - 2026-10-22

Third release candidate for 0.2.0. It adds `cardvision next`, a short `AGENTS.md` with one
playbook per job, and a labeling guide. The released models are unchanged: release
`201478a00d6ef6ba`.

### Added

- `cardvision next [GAME]`: looks at the game folder, the weights folder and the last `try` run,
  and says what is done and the one next step, with the exact command, the doc to read, the
  playbook for a coding agent, and a `STOP:` line when the step needs the person (a download,
  their own files, a choice, money or time). `--json` prints the same as a stable object. It
  only reads.
- [How to label](docs/labeling.md): what gets a box and which kind, by one rule (about half or
  more hidden → an ignore box on the visible part), with the cases that make people hesitate and
  links to pictures of real labeled frames. It replaces the rules section of
  `labeler/FORMAT.md`.

### Changed

- `AGENTS.md` is a short router (start with `cardvision next`, one playbook per job, when to stop
  and ask the person). Its step-by-step tiers moved into `playbooks/`: `setup.md`,
  `try-my-game.md`, `make-extension.md`, `train.md` and `measure.md`. A test keeps the agent
  files short and checks that every command and flag they show exists.

## [0.2.0rc2] - 2026-10-21

Second release candidate for 0.2.0, with fixes from the first one's soak. The released models are
unchanged: release `201478a00d6ef6ba`.

### Fixed

- `cardvision try` says when cards in your list have no image: a `No image:` line before the
  verdict, and a list in the report. It tells cards that can't be named (no printing of them has an
  image) from printings with no image of their own (named only where they look like another
  printing). Before, only `import-report.txt` and `try.log` said so.
- From a newcomer's run of the docs: start-here.md says how to write a card list with another name
  and where images go when the image column names a folder; the import's "none of the images"
  error also offers moving the images; the report says the demo runs until Control-C.
- The quickstart and AGENTS.md check `python3 --version` first and say what to do when it is older
  than 3.11 (a Mac with an older python.org installer, for one).
- The 0.2.0rc1 notes said runs of `make-composites` without `--card-size` write the same files as
  0.1.0. They lay out the same scenes; Pillow 13.0.0 changes a few pixels of a few composites.

## [0.2.0rc1] - 2026-10-21

Release candidate for 0.2.0. The released models are unchanged: the v0.1.0 files, release
`201478a00d6ef6ba`.

### Added

- `cardvision make-composites --card-size WxH`: the card size in millimeters (default `63x88`),
  which sets the shape of the layouts, generated backs and card-shaped distractors; the manifest
  records it as `parameters.cardAspect`, and the label check reads it from there. Without the
  flag, a run lays out the same scenes as before with the same library versions. Pillow 13.0.0
  (pinned for every supported Python, see Security) resizes images slightly differently, so a few
  pixels of a few composites differ from 0.1.0's with Pillow 12.3.0, which is harmless for
  training.
- `cardvision try CARDS --images DIR --video FILE`: the steps of the your-game guide in one command
  (import, image check, bank, release folder, `infer`), ending in a `report.html` with the outcome,
  the contact sheet, the annotated frames and the line that opens the demo page (with `npm ci`
  first when `browser/node_modules` is missing).
- `cardvision fetch-weights DIR`: download the released model files, check each one's size and
  SHA-256 against the pins, resume, and finish with `verify-release`; `--list` makes no request.
  An empty DIR, or one inside the repository, is refused.
- `cardvision import-catalog`: write a catalog from a CSV, TSV or JSON card list, with
  `--overwrite` and `--delimiter`; images are downloaded only with `--download`.
- `cardvision check-catalog`: load a catalog and report its card count, cards without art,
  identity rule and game.
- `import-catalog` recognizes more header names without `--map` (such as `Card No.`, `Set Code`,
  `Card #`, `Card Title`, `Picture`); when several match a field, the first in order wins and the report
  names the others.
- A per-card `extra` object in the catalog, kept as given and read by nothing.
- Newcomer documentation: a start-here page, a guide for your own game, and the guide split into
  train, measure and extension pages.
- `CHANGELOG.md`, `RELEASING.md` and `docs/stability.md`; a monthly grouped Dependabot update.

### Changed

- `composites`: a generated folder's manifest that is not a JSON object, or not valid JSON, is
  reported as an error naming the file.
- `cardvision` with no arguments, and the end of `--help`, list the commands in groups.
- CI runs the Python tests on every core with pytest-xdist.
- The sign-off check skips commits authored by Dependabot.

### Security

- Pillow 13.0.0, which fixes flaws in reading JPEG, TIFF, GIF, EPS and PDF files, is now pinned
  in both lock files for every supported Python.

### Removed

- **Breaking:** Python 3.10 is no longer supported; use 3.11 or 3.12. `requires-python` is now
  `>=3.11`. Python 3.10 reaches end of life in October 2026, and Pillow's security fix needs 3.11.
  To migrate, create a new virtual environment with Python 3.11 or 3.12 and reinstall.
  On Windows, use Ubuntu 24.04 under WSL (22.04 has Python 3.10).

### Fixed

- `import-catalog` refuses an id that holds a space, and an import in which none of the listed
  images is found, naming a path it looked for; nothing is written.
- `build-bank` and `build-release` name `--overwrite` when they refuse to replace a different file.
- The demo finds an image whose path has a folder (`HD/x.jpg`), and a video it cannot open gets
  the `ffmpeg` command that converts it to H.264.

## [0.1.0] - 2026-10-19

Initial public release.

- The `cardvision` command-line tools: catalog, bank and release-document building, inference,
  training, evaluation and label-manifest tools.
- The released detector and recognizer (ONNX), the bank, the identity groups, the catalog and the
  accept rule, pinned by one release document (release `201478a00d6ef6ba`).
- The browser runtime, the labeling tool and a hosted demo.
- Apache-2.0 code and weights, CC BY 4.0 labels.

[Unreleased]: https://github.com/ryangswe/riftsight-vision/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/ryangswe/riftsight-vision/compare/v0.3.0...v0.4.0
[0.4.0rc2]: https://github.com/ryangswe/riftsight-vision/compare/v0.4.0rc1...v0.4.0rc2
[0.4.0rc1]: https://github.com/ryangswe/riftsight-vision/compare/v0.3.0...v0.4.0rc1
[0.3.0]: https://github.com/ryangswe/riftsight-vision/compare/v0.2.0...v0.3.0
[0.3.0rc1]: https://github.com/ryangswe/riftsight-vision/compare/v0.2.0...v0.3.0rc1
[0.2.0]: https://github.com/ryangswe/riftsight-vision/compare/v0.1.0...v0.2.0
[0.2.0rc4]: https://github.com/ryangswe/riftsight-vision/compare/v0.2.0rc3...v0.2.0rc4
[0.2.0rc3]: https://github.com/ryangswe/riftsight-vision/compare/v0.2.0rc2...v0.2.0rc3
[0.2.0rc2]: https://github.com/ryangswe/riftsight-vision/compare/v0.2.0rc1...v0.2.0rc2
[0.2.0rc1]: https://github.com/ryangswe/riftsight-vision/compare/v0.1.0...v0.2.0rc1
[0.1.0]: https://github.com/ryangswe/riftsight-vision/releases/tag/v0.1.0
