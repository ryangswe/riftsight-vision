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

- **New here?** [docs/start-here.md](docs/start-here.md) picks the page for you.
- **Have a spreadsheet of your cards?** [docs/your-game.md](docs/your-game.md) takes it, your
  card images and a video to card names on that video.
- **Prefer to watch?** [Six walkthrough videos](https://www.youtube.com/playlist?list=PLMxsDo8Cxri0)
  follow the same steps on the toy game, from the big picture to your own browser extension.

## How well it works

On a small public evaluation set used during development, which flatters them somewhat, the
released models named 92.5 % of readable card faces right, and 1.6 % of the names shown were
wrong. The [model card](docs/model-card.md#evaluation) has the figures by source and the limits.

## Quickstart

This runs the whole pipeline on a toy game drawn from colored shapes: no card art, no video,
no download beyond the Python packages. You need Python 3.10 or later (macOS, Linux, or Ubuntu
under WSL 2 on Windows), and Node 22 or later for the browser part. Paste this into the terminal:

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
**[docs/quickstart.md](docs/quickstart.md) is the full walkthrough:** Windows, what each line
means, building a bank, naming the cards, and the demo page in a browser.

## Documentation

| I want to… | Read |
| --- | --- |
| Start here: pick the page for me | [docs/start-here.md](docs/start-here.md) |
| Run the toy quickstart, step by step | [docs/quickstart.md](docs/quickstart.md) |
| Get names on my own game's video, from my card list and images | [docs/your-game.md](docs/your-game.md) |
| Make a browser extension for my game | [docs/extension.md](docs/extension.md) |
| Train the models for my game | [docs/train.md](docs/train.md) |
| Measure, with numbers I can state | [docs/measure.md](docs/measure.md) |

Everything else: [docs/reference.md](docs/reference.md). A coding agent starts with [AGENTS.md](AGENTS.md).

## Built with this

Catalogs, banks and weights for other games live in their authors' own repositories, not
here. If you have built something with this, open an issue and it is listed.

- **[Kenbunshoku](https://github.com/ryangswe/kenbunshoku)**, a browser extension for One Piece
  Card Game videos, built on the browser runtime. Its catalog, bank, weights and labels are on
  Hugging Face ([models](https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece),
  [labels](https://huggingface.co/datasets/JuicyKaraageNo1/kenbunshoku-onepiece-labels)); its measurements are in the
  [adapt guide](docs/adapt-your-game.md#measured-on-another-game-the-one-piece-card-game).

## How this was built

I'm a solo software engineer with some machine learning experience; computer vision isn't my
core competency. I built this with heavy use of AI coding tools. It was checked with tests, with
comparisons against the code that trained the released models, with a private held-out test
scored once, and with outside reviews by other AI models and fresh AI sessions, not by people.
[docs/how-this-was-built.md](docs/how-this-was-built.md) says what each check does and does not show.

## Support

One person maintains this. Issues are read once a week; removal and security requests are
handled within 7 days. This repository is a maintained snapshot of what shipped, not a
development trunk ([SUPPORT.md](SUPPORT.md)). To report a card named wrong, see
[Reporting a wrong card](docs/model-card.md#reporting-a-wrong-card): a video id and a time,
never a frame or a screenshot.

If this is useful to you, you can support the work on [Ko-fi](https://ko-fi.com/ryangdev1): a
thank-you that does not buy support beyond what is promised above.

## License

- **Code and weights:** Apache-2.0 ([LICENSE](LICENSE)), for this project's own work.
- **Bank, identity groups and catalog:** Apache-2.0 for this project's own work in the bank and
  identity groups, and for the catalog's selection and arrangement; the card names, ids and
  other card data in the catalog are not licensed here ([NOTICE](NOTICE)).
- **Label manifests:** CC BY 4.0, for the annotations only ([LICENSE-DATA](LICENSE-DATA)).
- **Starting points and attributions:** [NOTICE](NOTICE). The detector starts from YOLOX-Nano
  weights by Megvii; the recognizer from torchvision's MobileNetV3-Small weights.
- **What the grant covers:** this project's own work. The bank and the weights derive from
  card images that this repository does not contain and does not license ([NOTICE](NOTICE),
  [docs/faq.md](docs/faq.md), the [license table](PROVENANCE.md#licenses-by-artifact)).

## Trademark

The Apache license does not cover the RiftSight name or logo. A fork or a product built on this
must use its own, and may say "based on RiftSight's open vision model" ([TRADEMARK.md](TRADEMARK.md)).

## Not endorsed

RiftSight is a fan project and is not endorsed by Riot Games. Riftbound, the card names and
the card art belong to Riot Games.
