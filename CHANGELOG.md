<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows the
versioning rule in [docs/stability.md](docs/stability.md). Before 1.0, a minor version may
break the public surface; this file names each break and how to migrate.

## [Unreleased]

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

[Unreleased]: https://github.com/ryangswe/riftsight-vision/compare/v0.2.0rc2...HEAD
[0.2.0rc2]: https://github.com/ryangswe/riftsight-vision/compare/v0.2.0rc1...v0.2.0rc2
[0.2.0rc1]: https://github.com/ryangswe/riftsight-vision/compare/v0.1.0...v0.2.0rc1
[0.1.0]: https://github.com/ryangswe/riftsight-vision/releases/tag/v0.1.0
