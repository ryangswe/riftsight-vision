<!-- SPDX-License-Identifier: Apache-2.0 -->

# Getting the released weights

The weights, the bank and the release document are release assets of
[v0.1.0](https://github.com/ryangswe/riftsight-vision/releases/tag/v0.1.0), release
`201478a00d6ef6ba`. Each file's address is
`https://github.com/ryangswe/riftsight-vision/releases/download/v0.1.0/` followed by its name:

| File | What it is | SHA-256 |
| --- | --- | --- |
| `release.json` | The release document | `5054fc41bc3d85a66d934e494ef9f114a7b27ac08eca0a6328c95750428e0a73` |
| `detector.onnx` | The detector | `dd9dc32b74756d83316bf8347784f09fad69d6f54c55384c1d093cb312727185` |
| `recognizer.onnx` | The recognizer | `a65ee03103893c39f8a0bbde9b3d18b8540130205df7883c4467b2673c47fd3b` |
| `bank.json` | The bank | `8dd173a237a19bcd86c52b3cdb88b54f726e690c1d9e19f1bec6d75e63ce969e` |
| `identity-groups.json` | The identity groups | `1c4cf595abc76aa71a338e4ca16344f7a652b8023416d7cd57a1555148cefc61` |
| `catalog.json` | The catalog | `75e563c8aa39cda85e6f24b683dbb1311cc7c4c18d809df2808a5f36fbfc855d` |
| `accept.json` | The accept rule, for commands that take `--accept` | `b3a3ec47fcfdaafc0923707218eeb056684e5b1407611a6e716c47fdb8b26dc3` |
| `SHA256SUMS` | The other seven files' SHA-256, in the form `shasum -c` reads | `c8e5555b2aa6d11dbd78962e2502eac010ead82804c78233d9f5699f91d5b126` |

The release document pins the first six by SHA-256 and size, and holds the accept rule too.
The eighth asset, `SHA256SUMS`, lists the other files' SHA-256 in the form `shasum -c` reads.

**One command.** `cardvision fetch-weights "$HOME/Downloads/cardvision-weights"` does what the
block below does. It prints what it fetches and from where before the first request, downloads
one file at a time, refuses to keep a file whose size or SHA-256 differs from the pins in
`cardvision/release_assets.py` (the table above) or from `SHA256SUMS`, skips a file that is
already there with the right hash, and finishes with `verify-release`. It leaves a file that
differs alone unless you add `--overwrite`. `--list` prints the files, sizes and addresses
without making a request.

**Download and check them by hand.** This block does the same without `fetch-weights`. It puts the eight files in one folder outside the
repository, `cardvision-weights` in your Downloads folder. It checks the release document
against the hash in the table above, every file against `SHA256SUMS`, and then has
`verify-release` compare every file with the hash the release document pins; it refuses the
release whole if anything differs. On Linux and in WSL, write `sha256sum` in place of
`shasum -a 256` if `shasum` is missing. (Checked, not run here: it needs the network.) Paste
this into the terminal, from the repository's root:

```
export WEIGHTS="$HOME/Downloads/cardvision-weights"
mkdir -p "$WEIGHTS"
for name in release.json detector.onnx recognizer.onnx bank.json identity-groups.json catalog.json accept.json SHA256SUMS; do
    curl -fL --proto '=https' -o "$WEIGHTS/$name" "https://github.com/ryangswe/riftsight-vision/releases/download/v0.1.0/$name"
done
(cd "$WEIGHTS" && echo "5054fc41bc3d85a66d934e494ef9f114a7b27ac08eca0a6328c95750428e0a73  release.json" | shasum -a 256 -c - && shasum -a 256 -c SHA256SUMS)
cardvision verify-release "$WEIGHTS/release.json"
```

Every file should be reported `OK`, and the last line should read
`release 201478a00d6ef6ba: ok`, followed by what the release holds. Anything else: delete the
folder and download again.

Then run the released models on a video of the released game (not run here: it needs the
release assets):

```
cardvision infer YOUR-VIDEO.mp4 --release "$WEIGHTS/release.json" --annotate "$WEIGHTS/annotated"
```

For another game, take three of these files, the detector, the recognizer and the accept rule,
and build a bank of your own cards: `cardvision try` does it from your card list
([Your game](your-game.md)).

`--release` checks the release the same way `verify-release` does, and takes the detector,
recognizer, bank, catalog, accept rule and every other setting from it. The separate files
also work (`--detector`, `--recognizer`, `--bank`, `--catalog` and `--accept`), but not
together with `--release`.

Reading video needs OpenCV, which `requirements-lock.txt` installs. The weights of v0.1.0 are
published as ONNX only: no PyTorch checkpoint and no pickle.

Nothing needs card art to run the released models: the bank and the card names are enough.
