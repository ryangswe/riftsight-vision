<!-- SPDX-License-Identifier: Apache-2.0 -->

# Set-up

This playbook covers the three set-up steps: install the package, make a work folder outside the repository, and get the released weights or the toy stand-ins. It assumes nothing: do this first. The rules in [AGENTS.md](../AGENTS.md) apply to every step here.

Run every command from the repository's root, in a POSIX shell: macOS or Linux, or Ubuntu under WSL 2 on Windows ([docs/quickstart.md](../docs/quickstart.md), "Which computer?"). A native Windows shell such as PowerShell is not covered.

## S1. Install

Check `python3 --version` first: the toolkit needs Python 3.11 or later. If it is older, find a newer
one (`python3.12 --version`, `python3.11 --version`) and use it for the first line; if there is none,
tell the person and ask before installing one (`brew install python@3.12` on macOS).

```
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-lock.txt
python -m pip install --no-deps -e .
cardvision --version
```

- **Expect:** `cardvision 0.7.0`.
- **If it fails:** check `python3 --version` is 3.11 or later. If a pinned version has no
  build for this machine, use `python -m pip install -e ".[dev]"` in place of the two install
  lines and tell the person the lock file was not used. (This fallback was not run when this
  file was checked.)

## S2. A work folder outside the repository

```
export WORK="$HOME/Downloads/cardvision-toy"
mkdir -p "$WORK"
echo "$WORK"
```

- **Expect:** a path that is not inside the checkout, ending in `Downloads/cardvision-toy`.
  The folder is outside the repository on purpose, and visible so that the person can find
  its files; it can be deleted afterwards.
- **Note:** a new shell loses `WORK`. Set it again to the same path.
- **Note:** running a step again replaces what it wrote, except where a step refuses to
  (`... already holds generated scenes` and the like: add `--overwrite`, or delete that step's
  output folder). To start over from nothing: `rm -rf "$HOME/Downloads/cardvision-toy"`. It
  deletes everything in the folder without asking: run it only when the person agrees, and
  never while the folder holds files of theirs, such as their own catalog.

## S3. The released weights, or the toy stand-ins

**The released weights** are release assets of v0.1.0: [`docs/release-files.md`](../docs/release-files.md), "Getting the
released weights", lists each file with its address and SHA-256. For the person's game you need
them. If the person has given you the files, put them in `$WEIGHTS`; otherwise tell the person
what you are about to fetch (see "Stop and ask the person" in [AGENTS.md](../AGENTS.md#stop-and-ask-the-person)) and run:

```
export WEIGHTS="$HOME/Downloads/cardvision-weights"
mkdir -p "$WEIGHTS"
cardvision fetch-weights "$WEIGHTS"
```

`--list` shows the files and addresses without a request. By hand, the block of
[`docs/release-files.md`](../docs/release-files.md), "Download and check them by hand", does the same, in the same
`$WEIGHTS`:

```
for name in release.json detector.onnx recognizer.onnx bank.json identity-groups.json catalog.json accept.json SHA256SUMS; do
    curl -fL --proto '=https' -o "$WEIGHTS/$name" "https://github.com/ryangswe/riftsight-vision/releases/download/v0.1.0/$name"
done
(cd "$WEIGHTS" && echo "5054fc41bc3d85a66d934e494ef9f114a7b27ac08eca0a6328c95750428e0a73  release.json" | shasum -a 256 -c - && shasum -a 256 -c SHA256SUMS)
cardvision verify-release "$WEIGHTS/release.json"
```

- **Expect:** every file reported `OK`, then `release 201478a00d6ef6ba: ok` and what the
  release holds. (Not run when this file was checked: it needs the network.)
- **If it fails:** a checksum that is not `OK`, or a refused release: delete `$WEIGHTS` and
  run the block once more. If it fails again, stop and show the person the output. Never skip
  or edit a check. On Linux, use `sha256sum` in place of `shasum -a 256` if `shasum` is missing.
- **Use** `$WEIGHTS/detector.onnx`, `$WEIGHTS/recognizer.onnx` and `$WEIGHTS/accept.json`
  wherever a command takes `--detector`, `--recognizer` and `--accept`. The released bank,
  catalog, identity groups and release document belong to the released game, Riftbound.
- **Note:** a new shell loses `WEIGHTS`. Set it again to the same path.

**The toy game and two stand-in models** let you check every command without the released
weights:

```
python examples/toy_quickstart.py "$WORK/toy"
ls "$WORK/toy"
```

- **Expect:** `wrote .../toy/catalog.json and 20 images in .../toy/art`, then `wrote
  stand-in models, a staged bank and a test scene in .../toy`, then `table.png: 7 boxes`,
  seven lines (one per box) and `1 frame, 6 faces, 3 named`. `ls` prints `accept.json art
  bank.json catalog.json detector.onnx recognizer.onnx table.png`.
- **Know:** the stand-ins have no skill. The detector returns the same boxes for any image.
  The script imports them and the toy game from `tests/`. Its bank, `bank.json`, is staged:
  one card is left out and two cards share a row, so three faces are named nothing. Say so
  in anything you report.
- **If it fails** with a message about the onnx package: S1 did not use
  `requirements-lock.txt`.
- **If it fails** with `lies inside the repository`: `WORK` is not set, or points into the
  checkout. Do S2 again.
