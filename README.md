<!-- SPDX-License-Identifier: Apache-2.0 -->

# riftsight-vision

Open weights, labels and tools for recognizing trading cards in gameplay video: built for
Riftbound, laid out so you can point it at your own game.

This is the card recognition that the RiftSight browser extension ships. Two small models
find the cards in a video frame and name them, so that a viewer can rest the pointer on a
card and read it.

**A fan project. Not endorsed by Riot Games.** Riftbound, the card names and the card art
belong to Riot Games.

**It reads cards. It cannot draw them.** This is recognition, not image generation.

**Try it with nothing to install:** <https://ryangswe.github.io/riftsight-vision/>. Move the
pointer over the toy game's example table, or drop a screenshot or a video of your own One Piece
Card Game match. The models run in your browser.

**New here? Start with [the process at a glance](docs/overview.md):** two diagrams, one of
what you do and one of how the pipeline works.

## What it does

- **Finds and names cards in a frame of video.** A detector boxes card faces and card backs,
  a recognizer matches each face against a bank built from card images, and an accept rule
  shows nothing when a match is not trusted.
- **Runs in Python and in a web page.** The `cardvision` command line, and a TypeScript runtime
  on ONNX Runtime Web that says which card would be shown under the pointer.
- **Can be pointed at your own game.** A bank built from your card images needs no
  retraining; where that falls short, both models can be fine-tuned with the published trainers
  and a labeling tool that runs on your own machine.
- **Publishes its labels and its method.** Label manifests for frames of public videos, and the
  evaluation tools that score what a viewer would see under the pointer.

## How well it works

On the public evaluation set, a small one (53 frames, 20 recording groups), the released models
named 92.5 % of readable card faces right, and 1.6 % of the names shown in that evaluation were
wrong. Parts of the set were looked at during development, and some of its digital identity
labels were assigned with model suggestions, so it flatters the models somewhat: it is a small
development benchmark, not an independent test of generalization. The
[model card](docs/model-card.md#evaluation) has the figures by source, a private held-out test,
and the limits.

## Quickstart

This runs the whole pipeline on a toy card game that the repository draws from colored shapes:
no card art, no video and no download beyond the Python packages. You need Python 3.10 or
later, on macOS, Linux, or Ubuntu under WSL 2 on Windows. Paste this into the terminal:

```
git clone https://github.com/ryangswe/riftsight-vision.git
cd riftsight-vision
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-lock.txt
python -m pip install --no-deps -e .
export WORK="$HOME/Downloads/cardvision-toy"
mkdir -p "$WORK"
python examples/toy_quickstart.py "$WORK/toy"
```

The last line it prints should be `1 frame, 6 faces, 3 named`. The toy's models are stand-ins
with no skill: they show what the tools do, not how well the released models work.

**[docs/quickstart.md](docs/quickstart.md) is the full walkthrough:** setting up Windows,
downloading without `git`, what each line of output means, building a bank, naming the cards
with the real commands, and the browser runtime. The released weights are release assets:
[docs/release-files.md](docs/release-files.md) lists them with their SHA-256 hashes.

**In a browser:** [browser/README.md](browser/README.md) runs the same pipeline in a web page,
with a demo page for a video or image file on your own disk.

## Documentation

| I want to… | Read |
| --- | --- |
| See the whole process at a glance, in two diagrams | [docs/overview.md](docs/overview.md) |
| Run the pipeline on a toy game, step by step, and the browser runtime | [docs/quickstart.md](docs/quickstart.md) |
| Know what this repository holds, and what it does not | [docs/whats-included.md](docs/whats-included.md) |
| Get the released weights, bank and catalog, and check them | [docs/release-files.md](docs/release-files.md) |
| Look up a command of `cardvision` or of the labeling tool, and run the tests | [docs/commands.md](docs/commands.md) |
| Understand the detector, recognizer, bank, accept rule, rotation retry, hover rule, and the catalog file a game supplies | [docs/how-it-works.md](docs/how-it-works.md) |
| Point it at another card game, in three tiers: try it, make it yours, ship it | [docs/adapt-your-game.md](docs/adapt-your-game.md) |
| Have a coding agent run those tiers as steps it can run and check, with the rules it must follow here | [AGENTS.md](AGENTS.md) |
| Know what the models are, what they were trained on, what they were measured to do, and their limits | [docs/model-card.md](docs/model-card.md) |
| Know what the label manifests contain, how they were made, what a video id reveals, and how to have rows removed | [docs/data-card.md](docs/data-card.md) |
| Evaluate honestly, and see how the released models were tested and chosen | [docs/method.md](docs/method.md) |
| Read what was tried and dropped, and what we would do differently | [docs/what-we-tried.md](docs/what-we-tried.md) |
| Know who built this, with what help, and how it was checked | [docs/how-this-was-built.md](docs/how-this-was-built.md) |
| Find answers on AI use, the pretrained starting points, commercial use, the private test set, card art, rebuilding the weights and other games | [docs/faq.md](docs/faq.md) |
| Read the label manifests and their format | [data/README.md](data/README.md), [data/SCHEMA.md](data/SCHEMA.md) |
| Use the labeling tool, read its label format, and learn how to label | [labeler/README.md](labeler/README.md), [labeler/FORMAT.md](labeler/FORMAT.md) |
| Run the browser runtime, its demo and scoring pages, and its API, and see where it and the Python package differ | [browser/README.md](browser/README.md) |
| See the files that describe a game | [games/riftbound/README.md](games/riftbound/README.md), [games/_template/README.md](games/_template/README.md) |
| Know where everything comes from, and what each model started from | [PROVENANCE.md](PROVENANCE.md) |
| Take part, get help, report a security problem, and know what to expect | [CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| Read the licenses, notices and names, and cite this | [LICENSE](LICENSE), [LICENSE-DATA](LICENSE-DATA), [NOTICE](NOTICE), [TRADEMARK.md](TRADEMARK.md), [CITATION.cff](CITATION.cff) |

## Built with this

Catalogs, banks and weights for other games live in their authors' own repositories, not
here. If you have built something with this, open an issue and it is listed.

- **[Kenbunshoku](https://github.com/ryangswe/kenbunshoku)**, a browser extension for One
  Piece Card Game videos, built on the browser runtime. Its catalog, bank, fine-tuned weights
  and labels are on Hugging Face, the
  [models](https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece) and the
  [labels](https://huggingface.co/datasets/JuicyKaraageNo1/kenbunshoku-onepiece-labels), and
  their measurements are in the
  [adapt guide](docs/adapt-your-game.md#measured-on-another-game-the-one-piece-card-game) and
  [the FAQ](docs/faq.md#does-it-work-on-my-game).

## How this was built

I'm a solo software engineer with some machine learning experience; computer vision isn't my
core competency. I built this with heavy use of AI coding tools.

It was checked with tests, with comparisons of the code here against the code that trained the
released models, with a private held-out test that was scored once (historical, on release
`5cd3a4bf37154976`), and with outside reviews, which were reviews by other AI models and by
fresh AI sessions, not by people. [docs/how-this-was-built.md](docs/how-this-was-built.md) says
what each check does and does not show. The method is in the repository so that you can judge
it, and there is a public evaluation set you can run yourself.

## Support

One person maintains this. Issues are read once a week, and removal and security requests are
handled within 7 days. This repository is a maintained snapshot of what shipped, not a
development trunk. [SUPPORT.md](SUPPORT.md) has the details. To report a card named wrong, see
[Reporting a wrong card](docs/model-card.md#reporting-a-wrong-card): a video id and a time,
never a frame or a screenshot.

If this is useful to you, you can support the work on [Ko-fi](https://ko-fi.com/ryangdev1). A
donation is a thank-you: it does not buy support beyond what is promised above.

## License

- **Code and weights:** Apache-2.0 ([LICENSE](LICENSE)), for this project's own work.
- **Bank, identity groups and catalog:** Apache-2.0 for this project's own work in the bank and
  identity groups, and for the catalog's selection and arrangement; the card names, ids and
  other card data in the catalog are not licensed here ([NOTICE](NOTICE)).
- **Label manifests:** CC BY 4.0, for the annotations only ([LICENSE-DATA](LICENSE-DATA)).
- **Starting points and attributions:** [NOTICE](NOTICE). The detector starts from YOLOX-Nano
  weights by Megvii; the recognizer from torchvision's MobileNetV3-Small weights.
- **What the grant covers:** this project's own work. The bank and the weights derive from
  card images that this repository does not contain and does not license. [NOTICE](NOTICE)
  says so, and [docs/faq.md](docs/faq.md) says what that means for your use.
- **Artifact by artifact:** the [license table](PROVENANCE.md#licenses-by-artifact) gives the
  grant, provenance, notices and unsettled rights of the code, weights, bank, identity groups,
  catalog and labels.

## Trademark

The Apache license does not cover the RiftSight name or logo. A fork or a product built on
this must use its own name and logo, and may say "based on RiftSight's open vision model".
[TRADEMARK.md](TRADEMARK.md)

## Not endorsed

RiftSight is a fan project and is not endorsed by Riot Games. Riftbound, the card names and
the card art belong to Riot Games.
