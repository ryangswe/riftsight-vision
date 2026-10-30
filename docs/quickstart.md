<!-- SPDX-License-Identifier: Apache-2.0 -->

# Quickstart on a toy game

This runs the whole pipeline on a toy card game that the repository draws from colored
shapes. It needs no card art, no video and no download beyond the Python packages. Every
command here was run as written, on macOS with Python 3.12; the output shown is real. A
workflow, `.github/workflows/quickstart.yml`, runs the same steps on Linux and on Windows in
WSL.

You need Python 3.11 or later, and a copy of the repository: step 0 below gets it. Run
everything from the repository's root, the folder that holds `README.md`.

**Video:** [Try the toy game: quickstart and demo page](https://www.youtube.com/watch?v=Xq8Dwal1f6E) follows this page.

**How to read the steps.** A block after "Paste this into the terminal" holds commands: copy
the whole block, paste it into the terminal and press Return. A block after "You should see
something like" is what the commands print: you do not type it. Your timings and folder names
will differ.

**Which computer?** The commands are the same on macOS and Linux. On Windows they run in
Ubuntu under WSL 2 (the Windows Subsystem for Linux), where every step applies word for word.
A Windows terminal such as PowerShell is not supported. What was checked on which platform,
GPU training included, is in the [adapt guide](adapt-your-game.md#before-you-start).

- **macOS:** as written. For the browser part, install Node 22 or later: the installer from
  <https://nodejs.org>, or `brew install node` if you use Homebrew.
- **Linux:** install Python 3.11 or later, with its `venv` module, and Node 22 or later (for
  the browser part) with your package manager. Where a step says `open`, use `xdg-open`.
- **Windows:** open PowerShell with "Run as administrator", type
  `wsl --install -d Ubuntu-24.04` (the Ubuntu the checks run on) and restart the computer.
  Then open **Ubuntu 24.04** from the Start menu; a plain "Ubuntu" entry, if you have one from
  before, may open Ubuntu 22.04, whose Python 3.10 is too old. The first time, it asks you to
  choose a user name and a password. Everything from here on happens in Ubuntu's terminal;
  `python3 --version` there must say 3.11 or later (24.04 has 3.12).

On Windows, in Ubuntu, paste this into the terminal (`sudo` asks for that password):

```
sudo apt update
sudo apt install --yes python3-venv git curl
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
```

Then close Ubuntu, open it again, and paste this into the terminal to install Node 24, the
version the checks run on:

```
nvm install 24
```

Put the repository in your Linux home folder (`cd ~`, then step 0 below), not under `/mnt/c`:
Ubuntu is much slower with files on the Windows drive. To see the current folder in File
Explorer, paste `explorer.exe .` into the terminal. A page that a step serves in Ubuntu, such as
the demo at `http://127.0.0.1:8765/`, opens in your Windows browser with `localhost` in place of
`127.0.0.1`: `http://localhost:8765/`.

**Ran the README's Quickstart block?** It is steps 0 to 2 below: skip to step 3.

**0. Get the code.** The toy walkthrough uses files in the source tree (`examples/` and
`tests/`), so it needs the whole repository, not just the Python package. (The command-line
tools alone are on PyPI: `python -m pip install cardvision` installs them without a checkout.)
With `git`, paste
this into the terminal, in the folder that is to hold the repository (on Windows, in Ubuntu,
after `cd ~`):

```
git clone https://github.com/ryangswe/riftsight-vision.git
cd riftsight-vision
```

That makes the folder `riftsight-vision` and moves into it. It is the repository's root, where
every command below runs. Without `git`: on the repository's page on GitHub, press **Code**,
then **Download ZIP**. Unpack it, and `cd` into the unpacked folder (GitHub names it after the
branch, such as `riftsight-vision-main`). On Windows, unpack it in Ubuntu's home folder, not on
the Windows drive.

**1. Install.** First check the Python version: `python3 --version` must say 3.11 or later. If it
says 3.10 or older (a Mac with an older installer from python.org, for one), install a newer
Python (`brew install python@3.12`, or the installer from <https://www.python.org>) and type
`python3.12` where the first line below says `python3`. Then paste this into the terminal, from
the repository's root:

```
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-lock.txt
python -m pip install --no-deps -e .
cardvision --version
```

pip prints many lines while it installs (a notice that a newer pip exists is harmless). You
should see something like this as the last line:

```
cardvision 0.6.0rc2
```

**2. Run the toy quickstart.** One script draws the toy game (20 card images and a
catalog) into a work folder, builds two stand-in models, and runs the pipeline on a frame it
generates. The work folder is `cardvision-toy` in your Downloads folder. It is outside the
repository on purpose, because the repository must hold no images and no model files, and you
can delete it when you are done.

Paste this into the terminal, from the repository's root:

```
export WORK="$HOME/Downloads/cardvision-toy"
mkdir -p "$WORK"
python examples/toy_quickstart.py "$WORK/toy"
```

You should see something like:

```
wrote $WORK/toy/catalog.json and 20 images in $WORK/toy/art
wrote stand-in models, a staged bank and a test scene in $WORK/toy
table.png: 7 boxes
  0  face  named Amber Circle    best match TOY-001 Amber Circle, similarity 1.000, margin 0.139, look 0
  1  face  named Coral Triangle  best match TOY-003 Coral Triangle, similarity 1.000, margin 0.172, look 3
  2  face  named nothing         best match TOY-001 Amber Circle, similarity 0.842, margin 0.108, look 0
  3  face  named nothing         best match TOY-015 Plum Triangle, similarity 1.000, margin 0.000, look 0
  4  face  named Amber Stripes   best match TOY-017 Amber Stripes, similarity 1.000, margin 0.139, look 0
  5  back  never named
  6  face  named nothing         best match TOY-005 Plum Stripes, similarity 0.785, margin 0.040, look 3
1 frame, 6 faces, 3 named
```

Here `$WORK` stands for your folder: the terminal prints the full path,
`/Users/YOU/Downloads/cardvision-toy/toy/...` on a Mac. To see the files, paste `open "$WORK"`
into the terminal on macOS, `xdg-open "$WORK"` on Linux, and `(cd "$WORK" && explorer.exe .)`
in Ubuntu on Windows.

**If you open a new terminal,** it forgets `$WORK` and the Python environment. Paste this
into the terminal again first, from the repository's root:

```
. .venv/bin/activate
export WORK="$HOME/Downloads/cardvision-toy"
```

Running a step again replaces the files it wrote, so you can repeat any step. To start over
from nothing, delete the whole folder with `rm -rf "$HOME/Downloads/cardvision-toy"`. That
deletes everything in it at once and does not ask, so keep nothing of your own in it.

The released weights are release assets ([release-files.md](release-files.md)), so the
quickstart uses two tiny stand-ins. They and the toy game belong to the test suite: the script
imports them from `tests/`.

The stand-ins have no skill. The recognizer is an average pool and a random projection,
enough to tell the toy cards apart. **The detector does not look at the image**: it returns
the boxes of the cards in the test scene, `table.png`. They show what the tools do, not how
well the released models work.

What the output shows:

- **A card lying sideways is still named.** Box 1 has `look 3`: it was not accepted upright,
  so the three other orientations were tried.
- **A card back is reported and never named.** That is box 5.
- **Saying nothing is a normal result.** The script's bank, `bank.json`, is staged to show
  it: one card is left out of the bank and two cards share a row. Box 2 is the card the bank
  lacks: its best match scores too low. Box 3 matches two rows equally, so its margin is
  zero. Box 6 is cut in half by the frame's edge, and its best match scores too low.

**3. Build a bank** from all the card images. This is the real command; for a real game you
pass the released recognizer. Paste this into the terminal, from the repository's root:

```
cardvision build-bank --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" \
    --recognizer "$WORK/toy/recognizer.onnx" --out "$WORK/toy/bank-all.json"
```

You should see something like:

```
  20 / 20 cards
bank: $WORK/toy/bank-all.json (20 rows of 128 values; 20 embedded, 0 kept from the base bank)
identity groups: $WORK/toy/bank-all.identity-groups.json
```

**4. Detect and name the cards** in the test scene, with the real command and the full bank.
Paste this into the terminal, from the repository's root:

```
cardvision infer "$WORK/toy/table.png" \
    --detector "$WORK/toy/detector.onnx" --recognizer "$WORK/toy/recognizer.onnx" \
    --bank "$WORK/toy/bank-all.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/toy/accept.json" --annotate "$WORK/out"
```

It prints one JSON object per frame, as one long line. You should see something like this at
its start (wrapped here for reading):

```
{"source": "$WORK/toy/table.png", "frame": "table.png", "t": 0.0,
 "frameW": 1280, "frameH": 768, "analysisW": 1280, "analysisH": 768,
 "boxes": [
  {"i": 0, "box": [40.0, 40.0, 240.0, 336.0], "score": 0.95, "class": "face",
   "outcome": "named", "name": "Amber Circle", "cardId": "TOY-001",
   "topId": "TOY-001", "topName": "Amber Circle", "similarity": 0.995918, "margin": 0.12566,
   "look": 0, "retried": false, "tauPassed": true, "accepted": true},
  {"i": 1, "box": [320.0, 40.0, 336.0, 240.0], "score": 0.9, "class": "face",
   "outcome": "named", "name": "Coral Triangle", "cardId": "TOY-003",
   "topId": "TOY-003", "topName": "Coral Triangle", "similarity": 0.997997, "margin": 0.157303,
   "look": 3, "retried": true, "tauPassed": true, "accepted": true},
  ...
```

Each `box` is `[x, y, width, height]`: the card's top-left corner and size, in pixels of the
original frame (`frameW` by `frameH`).
[What `cardvision infer` prints](how-it-works.md#what-cardvision-infer-prints) describes every
field.

After it, on standard error, you should see something like:

```
cardvision infer: 1 frame(s), 6 face(s), 1 back(s), 5 named
```

When the detector keeps no box in a frame, it says so before this line and gives the
highest score the detector saw, so that you can tell a near miss from nothing at all
([your-game.md](your-game.md), step 5).

What that shows:

- **Six faces, five named.** With every card in the bank, boxes 2 and 3 are named. Box 6,
  the card cut in half, is still named nothing.
- The sideways card has `"look": 3` and `"retried": true`, and the card back has
  `"class": "back"` and no name.
- `$WORK/out/table.jpg` is the frame with the boxes and names drawn on it. On macOS,
  `open "$WORK/out/table.jpg"` shows it.

**Next:** [your-game.md](your-game.md) takes you from here to your own game, with your card
list, your card images and a video. [how-it-works.md](how-it-works.md) explains each step, and
[start-here.md](start-here.md) lists where else to go.

## In a browser

`browser/` runs the same pipeline in a web page, from the release folder that
`cardvision build-release` writes. Its demo page shows the card under the pointer on a video or
image file from your disk. It is not a browser extension, and it attaches to no website.

**Try it with nothing to install:** <https://ryangswe.github.io/riftsight-vision/>. The page
offers three choices. The **toy game (practice)** comes with the page: press **Load the
example table** and move the pointer over a card to see how hovering works (its models are
stand-ins with no skill, and its cards are colored shapes). The **One Piece Card Game** loads
the Kenbunshoku models from Hugging Face: drop a screenshot or a video of your own game and
hover the cards to see their names. It shows names only, no card image. **Your game (files on
this computer)** loads a release folder you choose, such as the `release/` that
`cardvision try` writes ([your-game.md](your-game.md)), with an optional folder of card images.
Whichever you pick, the models run in your browser. Files you select are processed locally by
this demo; its code does not upload their contents. Selecting One Piece downloads model files
from Hugging Face; Your game downloads nothing.

**On your computer,** with Node 22 or later, two blocks do it: one writes a toy release, and
one starts the demo page on the toy table. They are steps 1 to 3 of
["The demo page"](../browser/README.md#the-demo-page) in `browser/README.md`: follow them from
there, in this terminal, and open the address the demo prints. Its step 2 runs `npm ci`, which
may print `npm warn install-scripts ... not yet covered by allowScripts` for esbuild, fsevents
and protobufjs: harmless. Its step 1 prints a note,
`OpenCV: FFMPEG: tag 0x30385056/'VP80' is not supported ...`: it is harmless, and the toy video
is written. If the page says it cannot open a video of yours, convert it to H.264:
`ffmpeg -i in.mp4 -c:v libx264 -pix_fmt yuv420p video.mp4`
(install ffmpeg with `brew install ffmpeg`, `sudo apt install ffmpeg` or `winget install ffmpeg`, or export an H.264 MP4 from your video editor). The rest of that file is for
integrators.
