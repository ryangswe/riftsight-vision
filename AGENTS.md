<!-- SPDX-License-Identifier: Apache-2.0 -->

# Instructions for coding agents

You are helping a person use this toolkit on their own card game, most often with a request like
"make this work for my game". This file is short on purpose: it says where to start, which
playbook to load and when to stop and ask. The exact steps are in [playbooks/](playbooks/).
Load only the playbook you need; don't read the others.

## What this repository is

Card detection and recognition for trading-card game video: two small models, a bank of
reference vectors computed from card images, an accept rule, label manifests, and the tools that
train, label and evaluate. The command is `cardvision`. `browser/` runs the same pipeline in a
web page. [docs/how-it-works.md](docs/how-it-works.md) describes it.

## Start here, every time

Run every command from the repository's root, in a POSIX shell: macOS, Linux, or Ubuntu under
WSL 2 on Windows (PowerShell is not covered).

1. **Find the person's game folder.** It holds their card list, a folder of card images and a
   video, outside this repository, usually `~/Downloads/my-game`. If you don't know it, ask.
   Set `GAME` to it and `WEIGHTS` to the folder for the released models (usually
   `~/Downloads/cardvision-weights`).
2. **If `cardvision --version` fails,** nothing is installed yet: do step S1 of
   [playbooks/setup.md](playbooks/setup.md) first.
3. **Run `cardvision next "$GAME"`.** It reads the folders and prints what is done, the one
   next step with its exact command, the playbook for it, and a `STOP:` line when the step needs
   the person. Do what it says. Run it again after every step: it checks the files, not your
   memory of what you did. `cardvision next "$GAME" --json` prints the same as JSON.
   If the card images are not in the game folder, add `--images DIR`, as for `try`.
4. **Load the playbook it names,** and follow its steps in order. Each step says what to run,
   what to expect and what to do if it fails. If a step uses `$WORK` and it is not set, do step
   S2 of [playbooks/setup.md](playbooks/setup.md) first.

`cardvision next` follows the person's game up to a first report and the demo page. After that
it names the playbook (extension, training or measuring), and the playbook's steps take over.

## Which playbook

| The person wants to… | Load |
| --- | --- |
| install the toolkit, or check the tools on a toy game first | [playbooks/setup.md](playbooks/setup.md) |
| see their cards named on their own video | [playbooks/try-my-game.md](playbooks/try-my-game.md) |
| give viewers a browser extension that shows the cards | [playbooks/make-extension.md](playbooks/make-extension.md) |
| name more of their cards, or fix wrong names (labeling and training) | [playbooks/train.md](playbooks/train.md) |
| know how accurate it is, add new cards, or score new recordings | [playbooks/measure.md](playbooks/measure.md) |

## Stop and ask the person

Every time, even in the middle of a playbook:

- **Before anything that costs money,** such as renting or starting a GPU. Say roughly how
  many hours.
- **Before any download.** Say what and from where. These reach the network:
  `cardvision fetch --download`, `fetch-weights`, `try --download`, `fetch-textures`,
  `import-catalog --download` and `train-detector --download-pretrained`. Downloading video is
  the person's own act under the platform's terms. The released weights pinned in
  [docs/release-files.md](docs/release-files.md) may be fetched with `cardvision fetch-weights`
  once you have told the person. Installing the toolkit's own packages as the steps say
  (`pip install` from the lock file, `npm ci` in `browser/`) needs no extra question.
- **Before asking for their time,** such as labeling frames. Say how many and roughly how long.
- **Before publishing anything:** a release, a store upload, a push to a public repository.
- **When a step fails twice:** show the person the command and its full output. Don't edit the
  package to get past a step.
- **When something must come from them:** their card list, card images they are entitled to
  use, their video. Never fetch card art or video for them.

## Talking to the person

They may never have used a terminal. Before you run a command, say in one plain sentence what it
does. Ask one question at a time. Give paths they can open, and say where their files are. Never
ask them to paste a password or a token into the chat.

## Rules you must follow here

1. **Never commit an image, a video, a frame, a crop, a screenshot or a model file.** Not card
   art, not test images, not weights. A check refuses them.
2. **Keep their files and yours outside the repository,** in the game folder or a work folder
   (`$WORK`). Steps that install, test or build make `.venv`, `.pytest_cache`,
   `cardvision.egg-info`, `browser/node_modules` and `browser/dist` inside the checkout, and git
   ignores them. In a git checkout, `git status --short` must show only files you meant to
   change.
3. **Copy nothing from elsewhere.** No code, weights, data or labels from other
   card-recognition projects, and nothing under the GPL or the AGPL. Reading a public write-up
   for ideas is fine. See [CONTRIBUTING.md](CONTRIBUTING.md).
4. **Another game's catalog, bank or weights don't belong in this repository.** Keep them in
   the person's own folder, repository or fork.
5. **Report what you measured, with the command.** A toy run proves that commands work; it is
   not evidence of accuracy. Never state a number you did not produce, and say when a result
   comes from stand-in models.
6. **Run the validator on every label manifest you touch:**
   `cardvision validate-manifest FILE --catalog CATALOG` (add `--sources FILE` when the game has
   a sources file, and `--contribution` for labels being offered).
7. **Before you propose a code change,** run `python -m pytest` and make sure it passes. New files in `cardvision/`, `tests/`,
   `labeler/`, `examples/`, `games/`, `data/`, `browser/`, `docs/`, `playbooks/`, `.github/` and
   at the top level start with the license line (`SPDX-License-Identifier: Apache-2.0` as a
   comment of that file type); JSON and CSV files are the exception.
8. **Commits are signed off by the person, not by you** (`git commit -s`, with the git identity
   of the person you work for). The sign-off is their statement under the Developer Certificate
   of Origin. Don't invent one. If you can't tell whose identity git is using, ask.

## Before you finish

```
git status --short
python -m pytest -q
```

- **Expect:** `git status --short` lists only files you meant to change, and no image, video or
  model file (skip it if the folder is not a git checkout, and list the files you created or
  changed instead). The tests pass. In the base environment the tests that need PyTorch, the
  browser comparison when `npm ci` has not been run in `browser/`, and a few video tests when
  the `ffmpeg` program is missing are skipped.
- **Tell the person** which steps ran on the toy game, which ran on their data, which you could
  not run, and every number you measured with its command.

The same guide for people, with more explanation:
[docs/start-here.md](docs/start-here.md), [docs/your-game.md](docs/your-game.md),
[docs/extension.md](docs/extension.md), [docs/train.md](docs/train.md) and
[docs/measure.md](docs/measure.md).
