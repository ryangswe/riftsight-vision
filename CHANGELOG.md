<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows the
versioning rule in [docs/stability.md](docs/stability.md). Before 1.0, a minor version may
break the public surface; this file names each break and how to migrate.

## [Unreleased]

### Added

- `cardvision import-catalog`: write a catalog from a CSV, TSV or JSON card list, with
  `--overwrite` and `--delimiter`; images are downloaded only with `--download`.
- `cardvision check-catalog`: load a catalog and report its card count, cards without art,
  identity rule and game.
- A per-card `extra` object in the catalog, kept as given and read by nothing.
- Newcomer documentation: a start-here page, a guide for your own game, and the guide split into
  train, measure and extension pages.
- `CHANGELOG.md`, `RELEASING.md` and `docs/stability.md`; a monthly grouped Dependabot update.

### Changed

- `cardvision` with no arguments, and the end of `--help`, list the commands in groups.
- CI runs the Python tests on every core with pytest-xdist.
- The sign-off check skips commits authored by Dependabot.

### Security

- Pillow 13.0.0, which fixes flaws in reading JPEG, TIFF, GIF, EPS and PDF files, is pinned on
  Python 3.11 and later. Python 3.10 keeps 12.3.0 (see SECURITY.md).

### Deprecated

- Python 3.10. It is still supported in this release line; v0.2.0 drops it (Python 3.10 reaches
  end of life in October 2026, and Pillow's security fix needs 3.11). Use Python 3.11 or 3.12.

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

[Unreleased]: https://github.com/ryangswe/riftsight-vision/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ryangswe/riftsight-vision/releases/tag/v0.1.0
