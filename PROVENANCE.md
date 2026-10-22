<!-- SPDX-License-Identifier: Apache-2.0 -->

# Provenance

Where everything in this repository and its release assets comes from, and what it started
from.

## What is here and what is not

- **Code.** Written for this release. It is a rewrite of the private code that trained the
  released models, laid out as one package. [docs/how-this-was-built.md](docs/how-this-was-built.md)
  says how the rewrite was checked against that code.
- **No images.** The repository contains no card art, no video frames and no images from any
  game. The tools take a folder of card images that you are entitled to use.
- **Labels.** Text only: a video id, a time, and the annotations made on that frame.
- **Weights, bank and release document.** Release assets, not files in git.

## Licenses by artifact

What this project grants for each thing it publishes, where the thing comes from, which
notices travel with it, and which third-party rights it does not settle. The table restates
[LICENSE](LICENSE), [LICENSE-DATA](LICENSE-DATA), [NOTICE](NOTICE) and the register below; it
adds no grant of its own. We are not lawyers and this is not legal advice.

| Artifact | This project's grant | Provenance | Notices to keep with it | Third-party rights not settled here |
| --- | --- | --- | --- | --- |
| Code and documentation (git) | Apache-2.0 ([LICENSE](LICENSE)) | Written for this release. Two files adapt YOLOX code; one re-implements a Pillow routine ("Code adapted from YOLOX" below; [NOTICE](NOTICE)) | [LICENSE](LICENSE), [NOTICE](NOTICE), and the change notes at the top of the adapted files | None beyond the upstream licenses that [NOTICE](NOTICE) reproduces |
| Detector and recognizer weights (release assets) | Apache-2.0, for this project's own work: [NOTICE](NOTICE) says the grant covers "what this project's training added to the model weights". The files are whole models, not a separate set of changes | Fine-tuned from Megvii's YOLOX-Nano COCO weights and from torchvision's MobileNetV3-Small ImageNet weights; trained further on card images, labeled public footage and private images ("Detector weights", "Recognizer weights" and "Training data" below) | [LICENSE](LICENSE), [NOTICE](NOTICE) (its YOLOX and torchvision sections) | The starting checkpoints' terms, including whether the COCO and ImageNet image terms reach a fine-tuned model (not settled). The card images, which belong to Riot Games and are not licensed by this repository. The gameplay footage it was trained on |
| Bank (release asset) | Apache-2.0, for this project's own work in it ([NOTICE](NOTICE), "What the license grant covers"). [NOTICE](NOTICE) also says the bank derives from card images it does not license | Computed by the released recognizer from card images that belong to Riot Games ("Bank and identity groups" below) | [NOTICE](NOTICE) ("What the license grant covers") | The card images it is computed from |
| Identity groups (release asset) | Apache-2.0, for this project's own work in them ([NOTICE](NOTICE)) | Written by `cardvision build-bank` from the catalog: printings that share a card name are one group | [NOTICE](NOTICE) | Card names, which belong to Riot Games |
| Catalog (`games/riftbound/catalog.json`, and its copy in a release) | Apache-2.0 for this project's own selection and arrangement ([NOTICE](NOTICE)); the card data in it is not licensed here | Card ids, names, kinds and a bare image file name per card, with no link to any image; the repository's copy also gives each card's domains, energy cost and set, the labeling tool's filters ([games/riftbound/README.md](games/riftbound/README.md)) | [NOTICE](NOTICE) ("What the license grant covers", "Not endorsed") | Card names, card ids and card data, which are Riot Games' ([games/riftbound/README.md](games/riftbound/README.md), [LICENSE-DATA](LICENSE-DATA)) |
| Annotations: the label manifests (`data/*.manifest.jsonl`) | CC BY 4.0, for the annotations only ([LICENSE-DATA](LICENSE-DATA)) | Made by this project, and by the contributors named in each row's `credit`, on frames of public videos ("Labels" below; [docs/data-card.md](docs/data-card.md)) | [LICENSE-DATA](LICENSE-DATA)'s notice, the `credit` fields, and an attribution as below | The videos, which stay with whoever holds their rights; anyone's privacy or publicity rights; card names, ids and art ([LICENSE-DATA](LICENSE-DATA)) |

Neither this table nor the Developer Certificate of Origin that contributions are signed under
creates a right that the project does not hold.

**Crediting the labels.** CC BY 4.0 (section 3 of its legal code) asks, among other things,
that you name the creator, keep the copyright notice, refer to the license with its link, link
to the source where you reasonably can, and say whether you changed the material. A complete
attribution, for a copy that keeps a subset of the rows and converts them, could read:

> Labels: riftsight-vision label manifests (`data/riftbound-train.manifest.jsonl`), © 2026
> Raymond Yang and the contributors named in each row's `credit` field,
> https://github.com/ryangswe/riftsight-vision, licensed under CC BY 4.0
> (https://creativecommons.org/licenses/by/4.0/). Changed: the physical-play rows are kept,
> the others dropped, and converted to COCO. The videos the rows point at are not covered by
> this license.

Name the files you used, keep the rows' `credit` fields (or list their credits), and write
"Unchanged" when you change nothing.

## Acknowledgment

Design choices and some generator settings were informed by publicly available write-ups of
other open card-recognition projects; no code, weights, data or labels from them are included.

The settings of the scene generator (`cardvision/composites/`) are described in the code by
what they do. Nothing in this repository says they were derived here, with one exception: the
strength of the photometric effects was fitted to real crops, as
[docs/model-card.md](docs/model-card.md) describes.

## Artifact register

Each row is something published here or as a release asset, and what it starts from.

### Detector weights

| | |
| --- | --- |
| Starts from | YOLOX-Nano, pretrained on COCO by Megvii |
| Exact file | `yolox_nano.pth`, from the YOLOX release `0.1.1rc0` |
| SHA-256 | `cd28f55fbbc1829f99d9ac9b38a16d259a22889739c8728ea877610201feff7b` |
| Source | `https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.pth` |
| Code used with it | The YOLOX package at commit `6ddff4824372906469a7fae2dc3206c7aa4bbaee` |
| Terms as published upstream | The repository's license is Apache-2.0. The weights file has no separate statement. |
| What was changed | The class-prediction layers were replaced by two classes, card face and card back. The network was then trained further in three stages: two intermediate fine-tunes on private data, then the released fine-tune on labeled public footage. The intermediate checkpoints are not published. |
| Open questions | The COCO images carry their own terms. Whether those reach a model trained on them is not settled. |
| Released files | `detector.onnx` of release v0.1.0 (`201478a00d6ef6ba`), SHA-256 `dd9dc32b74756d83316bf8347784f09fad69d6f54c55384c1d093cb312727185`, at `https://github.com/ryangswe/riftsight-vision/releases/download/v0.1.0/detector.onnx` |

`cardvision train-detector --download-pretrained` fetches the file above and checks it
against this hash before use (`cardvision/train_detector/model.py`).

### Recognizer weights

| | |
| --- | --- |
| Starts from | torchvision's `MobileNet_V3_Small_Weights.IMAGENET1K_V1`: MobileNetV3-Small pretrained on ImageNet-1k by torchvision's authors |
| Exact file | `mobilenet_v3_small-047dcff4.pth`, as served by torchvision 0.20.1 |
| SHA-256 | `047dcff4addef86ea5bc2eff13c9614dc11f47ab1160d0a71a25e7db994f4e1f` |
| Terms as published upstream | torchvision's code is BSD-3-Clause. Its documentation says pretrained weights may carry terms from the dataset they were trained on. ImageNet's images are offered for non-commercial research. |
| What was changed | The classifier was removed, a projection to 128 values was added, and the network was trained further. The model card lists what it was trained on. |
| Open questions | Whether the terms of ImageNet's images reach a model fine-tuned from these weights is not settled. |
| Released files | `recognizer.onnx` of release v0.1.0 (`201478a00d6ef6ba`), SHA-256 `a65ee03103893c39f8a0bbde9b3d18b8540130205df7883c4467b2673c47fd3b`, at `https://github.com/ryangswe/riftsight-vision/releases/download/v0.1.0/recognizer.onnx` |

`cardvision train-recognizer --init random` trains without this starting point.

### Bank and identity groups

| | |
| --- | --- |
| Derived from | Card images, which belong to Riot Games, embedded by the recognizer |
| Version | One per release. The published one: `bank.json` of release `201478a00d6ef6ba`, version 1, 1,492 cards, SHA-256 `8dd173a237a19bcd86c52b3cdb88b54f726e690c1d9e19f1bec6d75e63ce969e`. At `https://github.com/ryangswe/riftsight-vision/releases/download/v0.1.0/bank.json`, with `identity-groups.json` (SHA-256 `1c4cf595abc76aa71a338e4ca16344f7a652b8023416d7cd57a1555148cefc61`) beside it. |
| Terms | The card images are not in this repository and are not licensed by it. [NOTICE](NOTICE) says so. |
| What it is | One 128-value vector per card, computed from card images. The bank stores these embeddings, not image files. It is not an image codec and does not preserve the original image bytes. We have not evaluated reconstruction or information leakage from the embeddings. |

### Labels

| | |
| --- | --- |
| Derived from | Annotations made by this project on public videos that belong to others |
| Version | Manifest format version 1. At release: `data/riftbound-train.manifest.jsonl`, SHA-256 `85b724f71de22d50a4e5bc685ce3f65a2ed6b79fac482d6792811a1da9f813ee`; `data/riftbound-evaluation.manifest.jsonl`, SHA-256 `6abaa3c6b59680dd7cffa61becbd597f1a25fe1f9fef966344927d5682a9f823`; `data/riftbound-extra.manifest.jsonl`, SHA-256 `60b6f241088832e4d57371212b633dd5db75b4a8fad00fb58970eff33e876cfa` |
| Terms | CC BY 4.0, for the rights held in the annotations only ([LICENSE-DATA](LICENSE-DATA)). The videos stay with whoever holds their rights. |

### Code adapted from YOLOX

| | |
| --- | --- |
| Files | `cardvision/train_detector/loss.py`, `cardvision/train_detector/augment.py` |
| Adapted from | `yolox/models/yolo_head.py`, `yolox/data/datasets/mosaicdetection.py` and `yolox/data/data_augment.py` at commit `6ddff4824372906469a7fae2dc3206c7aa4bbaee` |
| Terms | Apache-2.0, Copyright (c) Megvii Inc. |
| What was changed | Stated at the top of each file and in [NOTICE](NOTICE). |

### Background scans for generated scenes

| | |
| --- | --- |
| What | 207 material scans from Poly Haven (183 for training scenes, 24 for validation scenes), listed in `cardvision/composites/cc0_textures.json` with each file's page, size and SHA-256 |
| Terms | CC0 1.0, as published by the source |
| In this repository | The list only. `cardvision fetch-textures` downloads the files and checks each hash. |

Poly Haven is not affiliated with this project.

### Training data of the released models

Not published as files. [docs/model-card.md](docs/model-card.md) and
[docs/data-card.md](docs/data-card.md) describe it by kind:

- labeled frames of public gameplay footage (published as label manifests, never as frames);
- generated scenes made from images of cards;
- images of cards;
- images from our own private games on a digital client.

The last kind and the card images are why the released weights cannot be rebuilt exactly from
what is public.
