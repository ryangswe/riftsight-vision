<!-- SPDX-License-Identifier: Apache-2.0 -->

# Riftbound

The files that describe Riftbound to the tools in this repository.

| File | What it is |
| --- | --- |
| `README.md` | This page. |
| `catalog.json` | Every card the tools know: its id, name, kind, the card it is an alternate printing of (if any), the file name of its image, a `token` mark on the cards that are made during play, and its domains, energy cost and set as facets: the labeling tool's filters. English names. Its `kinds` block says how the card kinds are treated when training images are generated: which are landscape, how often a kind is foil, which carry dice, and which fill the slots of a generated board. The format is documented in `cardvision/core/catalog.py`. |
| `accept.json` | The accept rule's settings: a match must reach similarity `tau` (0.62) and keep a margin of `delta` (0.05) over the best match of any other card name; `rotationRetry` says that a crop not accepted upright is tried again in its three other quarter-turn orientations. [What reads it, and how strictly](#the-accept-file) is below. |
| `sources.json` | The kinds of footage the label manifests name beyond the built-in ones: the two digital clients, as `digital/rift-atlas` and `digital/tcg-arena`. Its `handRow` says that the second draws the cards in hand cut off along the bottom of the screen, from 0.85 of the way down the frame; the label conversions then keep those cards as faces. The format is documented in `data/SCHEMA.md` (source types). Pass it to `cardvision validate-manifest --sources`. |
| `train-detector.toml` | The recipe of the released detector, as a config for `cardvision train-detector`. It names an extra stream that is not public, so it does not run as it stands; its header says how to complete it and which file trains on public inputs only. |
| `train-recognizer.toml` | The recipe of the released recognizer, as a config for `cardvision train-recognizer`, with public data in place of the streams that are not public. |

Both recipes read `data/riftbound-train.manifest.jsonl`, the label manifest of the training
frames, and this folder's `sources.json`. In `train-detector.toml` paths are relative to the
folder the command is run from (the repository's root); in `train-recognizer.toml` they are
relative to this folder.

## The accept file

`accept.json` is strict. It is a JSON object with **exactly three keys**:

```json
{"tau": 0.62, "delta": 0.05, "rotationRetry": true}
```

- All three keys are required. Any other key is an error, and so is a key in another spelling
  or case (`rotationretry`, `Tau`). A misspelled setting is refused, not ignored.
- `tau` is a number above 0 and at most 1. `delta` is a number from 0 to below 1.
  `rotationRetry` is `true` or `false`.
- JSON has no comments, so the file carries none.

Every reader of the file goes through one piece of code, `cardvision/recognize/accept.py`, and
applies the same check. The readers are:

- **`cardvision infer --accept`** uses the rule to decide which cards are named.
- **`cardvision evaluate hover`, `crops`, `detector` and `compare`, with `--accept`**, use the
  rule for the configuration being scored. The report states the three values and the file's
  SHA-256.
- **`cardvision evaluate compare --other-accept`** uses the rule for the candidate
  configuration.
- **`cardvision build-release --accept`** copies the three settings into the release
  document's `accept` block.
- **`cardvision calibrate --accept`** starts from the rule: its `tau` and `delta` join the
  pairs that are scored, and its `rotationRetry` is kept for every pair. The command writes
  the pair it recommends to a new `accept.json` and never replaces this one.

Nothing else reads it: not the trainers, not `build-bank`, not the labeling tool.

After `build-release`, the release document carries the rule. `cardvision verify-release` and
`cardvision evaluate --release` read the document's `accept` block, with the same check, and do
not open `accept.json` again. `cardvision evaluate` refuses `--release` and `--accept` together.

When `infer` or `evaluate` is run without `--accept` and without `--release`, the values above
are used, with the rotation retry on.

## No card art is included

Card names and card ids are Riot Games'. This repository holds no card art, and the catalog
holds no link to any: `art` is a bare file name, `<id>.webp`.

To build a bank or to train, put your own copies of the card images in one folder, each named
after its card id (`OGN-001.webp`, and so on), and pass that folder to the tool:

```
cardvision build-bank --catalog games/riftbound/catalog.json --art /path/to/your/images \
    --recognizer recognizer.onnx --out bank.json
```

A card whose image you do not have can be left out with `--skip-missing-art`. A bank may hold
fewer cards than the catalog; it may not hold a card the catalog lacks.

Each row records the image it was computed from (`artV`, a hash of the image file's bytes).
When cards are added, `build-bank --base bank.json` keeps a row whose image is the same and
computes again a row whose image has changed. A bank written before rows recorded their image
has none, so its rows are kept as they are. `cardvision check-bank-art bank.json --catalog
games/riftbound/catalog.json --art /path/to/your/images` reports how each row compares with
your images. The hash is of the file, not of the picture: another copy of the same picture,
in another format or compressed again, counts as a different image, and a refresh from such
copies computes those rows again and lists them.

## Notes on the catalog

- `kind` is the card's type as the game names it (`Unit`, `Spell`, `Gear`, `Legend`,
  `Battlefield`, `Rune`, ...).
- Printings that share a name are one identity for recognition, whatever their ids. Names are
  compared exactly, so two printings whose names differ by a single character are two
  identities.
- `printingOf` points an alternate printing at the card it reprints. Recognition does not read
  it: identity goes by name.

This project is not endorsed by Riot Games.
