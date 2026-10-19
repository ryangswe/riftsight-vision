<!-- SPDX-License-Identifier: Apache-2.0 -->

# The commands

`cardvision --help` lists them; each has its own `--help`.

| Command | What it does |
| --- | --- |
| `cardvision infer` | Detect and name the cards in images or video, with the models from a release document (`--release`) or from separate files. Can also write annotated frames, crops, a contact sheet, and a pre-fill file for the labeling tool. |
| `cardvision build-bank` | Build the bank and its identity groups from card images, or extend an existing bank (`--base`): rows whose image changed are embedded again in place, new cards are added. |
| `cardvision check-refresh` | Check that a new bank only adds to an old one, and changes a row only where its image changed. |
| `cardvision check-bank-art` | Report which rows of a bank were embedded from the images now in your folder, and which were not. With no bank, look at the image of every card of a catalog. Either way it lists the images that deserve a second look: not a picture, a placeholder, or one file under different cards. |
| `cardvision build-release` | Pin models, bank, identity groups, catalog and settings in one release document. |
| `cardvision verify-release` | Check a release document and every file it pins. |
| `cardvision evaluate` | Score a configuration on labeled frames: `hover`, `crops`, `detector`, or `compare` two configurations. `hover --browser-events FILE` scores outcomes that the browser runtime's scoring page recorded on video files. `--scenes DIR` scores scenes that `make-composites` generated, by their exact labels: a first look, not a measurement on real video. |
| `cardvision calibrate` | Choose the accept rule's `tau` and `delta` on labeled frames: score a grid of pairs from one analysis of each frame, and recommend one under a limit on wrong names that you set. |
| `cardvision validate-manifest` | Check label manifests: format, ranges, duplicates, groups, card ids, and that no image is present. |
| `cardvision fetch` | Obtain a manifest's frames from video files you have, or by downloading if you ask. `--keep-video DIR` keeps the downloaded video files, and reads the ones already there. |
| `cardvision record-reachable` | Set a manifest's `reachable` fields from the index of a fetch run that downloaded. |
| `cardvision assign-roles` | Give new recording groups a role by a seeded shuffle. |
| `cardvision make-composites` | Generate labeled training scenes from card images. |
| `cardvision fetch-textures` | Download and verify the CC0 background scans the generator can use. |
| `cardvision train-recognizer` | Train the recognizer from a config file. Needs the training environment. |
| `cardvision train-detector` | Fine-tune the detector from a config file. Needs the training environment and YOLOX. |
| `cardvision export` | Export a checkpoint to ONNX and safetensors, with a parity check. |
| `python3 labeler/serve.py` | The labeling tool. Started with no arguments, its page asks what to label. [labeler/README.md](../labeler/README.md) |
| `python3 labeler/export.py` | Export labels as COCO, or as a label manifest. |

Nothing reaches the network unless you ask for it by flag: `fetch --download`,
`fetch-textures`, `train-detector --download-pretrained`, and `train-recognizer` when it
starts from torchvision's pretrained weights.

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
