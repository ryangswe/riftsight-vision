<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security

## Reporting a problem

Do not open a public issue for a security problem. Write to
<riftsight.support@gmail.com>.

Say what you found, how to reproduce it and which version or commit you used. You get an
answer within 7 days. One person maintains this repository, so a fix can take longer than the
answer.

## Known issues

- On Python 3.10, `requirements-lock.txt` installs Pillow 12.3.0, which has known flaws in
  reading JPEG, TIFF, GIF, EPS and PDF files. The fixed Pillow (13.0.0) needs Python 3.11, and
  3.11 or later gets it. Use Python 3.11 or later; v0.2.0 ends support for 3.10.

## What counts

- Code in this repository that can be made to run something it should not, read or write
  outside the folders it was given, or open a network connection it does not announce.
- A released file (weights, bank, release document) that does not match its published
  SHA-256.

## What the tools do, so that you can judge a report

- **Network.** Nothing is downloaded unless you ask for it by flag: `cardvision fetch
  --download`, `cardvision fetch-textures`, `cardvision train-detector --download-pretrained`,
  and `cardvision train-recognizer` with ImageNet starting weights (torchvision downloads them
  on first use). `cardvision build-bank --art` and `cardvision infer --art` read card images
  from a URL only when you pass one. Every other command reads local files only.
- **The labeling tool** listens on `127.0.0.1` only, has no login and opens no connection
  itself. Do not expose its port to a network.
- **Checkpoints.** A PyTorch checkpoint is a pickle, and unpickling a file can run code.
  The released weights are ONNX only; no PyTorch checkpoint is published. The tools read a
  pickle checkpoint in PyTorch's restricted mode; `--trust-checkpoint` lifts that and is only
  for a file you made yourself.
- **Downloaded files are checked.** The public pretrained detector weights and every
  background scan are compared with a pinned SHA-256 before use.
- **Release documents** pin every file by SHA-256 and size. `cardvision verify-release`
  checks them, and a release that fails any check is refused whole.

## Supported versions

The latest release only.
