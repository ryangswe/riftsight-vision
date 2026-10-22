<!-- SPDX-License-Identifier: Apache-2.0 -->

# The labeling tool

A local tool for labeling trading cards in frames of video: where each card is, which way up
it lies, and which card it is. It is what you use to make training data for a card detector
and a card recognizer, and to make the held-out labels you measure them on.

**Video:** [Label frames with the labeling tool](https://www.youtube.com/watch?v=eL0gChfpS_w) labels the toy game's frames
with it.

It is a small Python server and one web page. It needs Python 3.11 or later and a browser,
nothing else: no package to install, no build step, no account, and no network. The server
listens on `127.0.0.1` only and never opens a connection itself. Every label is a line of JSON
in a folder you choose.

On Windows, run it in Ubuntu under WSL: see "Which computer?" in the
[quickstart](../docs/quickstart.md).

It knows nothing about any particular game. The cards come from a catalog file that you give
it, and their pictures from a folder (or a URL base) that you give it.

What it does:

- **Boxes.** Draw a box around every card on a frame. Boxes can be rotated, and each records
  which edge is the card's own top.
- **Model pre-fill.** Start from a model's boxes and names, then accept, correct or reject each.
  Correcting is several times faster than drawing.
- **Names.** A second pass walks every box and asks which card it is, with the cards of the
  deck lists first.
- **Quads.** Four exact corners per card, for footage where a rectangle does not fit.
- **Labels for measuring a model**, made without showing any model's output: a census of card
  centers that is named afterwards under rules that stop a model's guess from steering the
  answer, and seeded random points.
- **Checks on the labeling itself**: a walk that reviews every box, a repeat set to measure
  how consistent a labeler is, and a report of labels per hour from the tool's own timing log.

The label format is described in [FORMAT.md](FORMAT.md); what gets a box, and which kind, in
[How to label](../docs/labeling.md).

## Five-minute start

No footage and no card art are needed for a first try, and no flag. Start the tool. Paste this
into the terminal, from the repository's root (the folder above `labeler/`):

```
python3 labeler/serve.py
```

It prints an address (`http://127.0.0.1:8090/` unless you pass `--port`) and runs until you stop
it with Ctrl+C. Open the address. The start screen lists the samples it finds in the folder you
started it in, and offers a toy example: a made-up game of thirteen silly cards and ten frames of
two "videos" of it being played, drawn by the tool itself. Press **Make the toy game and open
it**. The page names the folder before it writes it: `toy/` in the folder you started the tool in
(`work/toy/` when that folder is this repository's own checkout, so that git never sees it), or
`toy-2/` when
that name is taken.

You are now on the project's screen. It says where the project's files are, asks what the labels
will be used for (the toy example comes set to Training, because it brings a pretend model's
boxes), and lists the passes in order: Boxes, Names, Export. The button with the focus is the
next thing to do. **Enter** starts the Boxes pass.

You are in the Boxes pass, on the first frame of the set `table-a`. The line under the top bar
always says what to do next, and the button at the top of the panel on the right says what
**Enter** will do. Here they read "5 boxes suggested by the model. Check each one and click any
card it missed, then Enter accepts them all and finishes the frame." and "Accept 5 model boxes
and finish frame". (For a card the model missed, you drag a box around it, as in step 2.)

1. The dash-dot boxes marked `model` are the pretend model's. Look at each. Click one to move,
   resize or remove it; **Esc** lets go of it.
2. The model never finds the face-down card: the striped one on the right, with an emblem and
   no name. **Drag** a box around it and press **b** (card back), then **Enter** to confirm the
   box.
3. A toy card's top is the edge with its name banner, and the white tick on a box marks the
   top the box says. The Sock Thief is tilted, and the model's box is an upright box around it,
   larger than the card: click its box and drag the knob above it to turn it with the card.
   Turning never changes a box's size, so the box is still too large: press **e** (or the
   button **Fit to the tilted card**) and it shrinks, at its angle, to fit inside the model's
   upright box; the line under the top bar says so ("Turned. E fits the box to the tilted
   card."). If an edge is still off, drag that corner onto the card. The Polite Dragon
   across the table lies upside down, and the model put its top on the wrong side: click its
   box and press **w** twice (a quarter turn each). **Enter** accepts the box.
4. **Enter** with nothing selected accepts the model boxes you did not touch, finishes the
   frame and goes to the next. That frame starts with your own boxes, marked `kept`: fix what
   moved and press **Enter** again. Where the model has a box for a card that none of yours
   covers, it is offered as a suggestion marked `?`: **a** accepts it, Delete removes it.

The table changes as the game goes on, and the model makes the mistakes a real one makes. In
frame 2 a token is played and the model misses it, and it puts a box on the die, which is not a
card: remove that one. Frame 3 needs four fixes. The line above the frame says "... 5 model
boxes are held back under them": where one of your kept boxes already covers a card, the
model's box for that card is not shown.

- The Sock Thief has moved across the table. An arrow joins its kept box, now on empty table,
  to the model's `?` box at its new place, and the line under the top bar says "A card has
  moved". Press **m** (or the button **Move the kept box to its card**): the kept box goes to
  the new place and the suggestion goes away. Then turn it with the knob and press **e**, as in
  step 3.
- Sir Wobbleton is turned sideways: click his kept box and press **w**. The box turns a quarter
  about its center, to his new shape.
- The Grumbly Teapot lands on the Nap Attack so that only a strip of the Nap Attack shows. The
  model's box for the Teapot is offered as a `?` suggestion on top of the kept Nap Attack box,
  a little off the card: click it, drag it onto the Teapot, and press **Enter**. Then click the
  kept Nap Attack box, drag its corners in to the strip that still shows, and press **h**
  (ignore).

The Overdue Library at the left edge runs off the frame, but most of it shows, so it is a card.
(**x** is the other way to see held-back boxes: it removes every kept box you have not edited
on this frame and shows the model's boxes that were under them.)

Every one of these keys is also a button with the key printed on it, so the same work can be
done with the pointer alone. After the last frame of `table-a` a card says what was done and
offers the next set, `table-b`. After the last frame of `table-b` it offers **Continue to
Names**: **Enter** switches the tool to the Names pass, in the same tab. There is no terminal
step and no new start of the tool.

The Names pass shows one box at a time and asks "Which card is this?". Press **/**, type a few
letters, **Enter** picks the card. The search starts in the set's deck list, which for
`table-a` has one Sock Thief. Two different cards of the toy game are both called Sock Thief:
press **Tab** to search all cards, and the line says so ("2 cards are called “Sock Thief”.
Check the picture and the id."); the picture and the id tell them apart. Under the search box, the
rows of filters narrow the list by Type, Color, Cost and Set (the toy catalog's); they clear
when you move to the next card. The same place then asks
"Can you read this card from this frame alone?": **y** yes, **m** unsure, **n** no, and it moves
on. When no box is left, the card leads back to the project, where the Export row is next:
**Enter** writes `toy/boxes.json`, the file a detector is trained on, and the row says what it
wrote.

Your labels are in `toy/labels/`. `toy/truth.json` has the right answers, if you want to
compare: the box a careful labeler draws for every card of every frame, and the mistakes the
pretend model made on purpose. Neither the tool nor the export reads it.

**The same with commands alone**, as a script or a coding agent starts it. One script draws the
toy game into a folder that does not exist yet, and each pass is one start of the server with
flags; it opens straight into that pass. The server runs until you press Ctrl+C, so paste the
four blocks one at a time, each when the one before has finished. Paste this into the
terminal, from the repository's root:

```
python3 labeler/make_toy_data.py work/toy2
```

Then this, which starts the box pass; press Ctrl+C in the terminal when you are done with it:

```
python3 labeler/serve.py --mode box --role training --sample work/toy2/sample.json \
    --catalog work/toy2/catalog.json --art work/toy2/art --prefill work/toy2/prefill.jsonl
```

Then this, which starts the identify pass; again Ctrl+C when you are done:

```
python3 labeler/serve.py --mode identify --role training --sample work/toy2/sample.json \
    --catalog work/toy2/catalog.json --art work/toy2/art
```

Then this, which writes the boxes as a COCO file:

```
python3 labeler/export.py coco --labels-dir work/toy2/labels --out work/toy2/boxes.json \
    --catalog work/toy2/catalog.json
```

(`work/` is ignored by git in this repository: what these commands write never shows up among
its files.)

## Starting the tool, and a project's screen

A **project** is one sample file (the list of frames to label) and what lies beside it. The
three ways to start the tool, from the repository's root (not a block to paste: each line
shows a form, with what it does beside it):

```
python3 labeler/serve.py                    choose on the page
python3 labeler/serve.py FOLDER-OR-SAMPLE   one project's screen: a sample file, or the folder
                                             that holds a sample.json
python3 labeler/serve.py --mode ... --role ... --sample ...   one pass, at once ("What you give it")
```

**The start screen** offers three paths, side by side, each with one line on what it is for and
its own button. The instruction line says which one fits what the tool found, and that one is
open:

- **Label my frames**: the project you opened last (**Resume**, one button that goes on with
  its next pass), the other projects you opened (one whose sample has moved or was deleted
  says so, and can be removed from the list), the samples found in the folder the tool was
  started in and up to three folders below it (a `.json` file with "sample" in its name that
  lists videos; hidden folders are skipped), and **Open a sample by its path**: a sample file
  or a folder that holds a `sample.json`. The tool checks it and shows the project, or says
  what is wrong with the path and what to do.
- **Learn on a toy game**: makes the toy example and opens it ("Five-minute start").
- **I have a video, not frames**: what is needed first, and the two commands that turn a video
  into frames and a sample, with the parts to fill in marked ("From a video to frames").

Where something is missing (no sample found, a folder the tool may not write to), the page says
what is missing, the one step back, and links to the part of this guide that says more.

**A project's screen** has:

- **Its files.** The folder, how many recordings and frames, one frame, and where the labels
  are written. Everything is looked for beside the sample without asking: `frames/`, `labels/`,
  `catalog.json`, `art/`, `decklists/`, and a model's suggestions as `prefill.jsonl` or
  `prefill.json`. **Change locations** shows each place, whether something is there and what
  needs it, and takes another path. What is missing is named at the top, each with the one
  step back and a link to this guide: frames that are not on disk, a labels folder that
  cannot be written, a catalog that is not there or cannot be read.
- **What will these labels be used for?** Training, Development or Test ("Roles", below). Once
  a label is saved the answer is read from the labels and cannot be changed, because a label
  set keeps its role.
- **The passes, in order**, which follow what the labels are for:
  - Training: **Boxes**, **Names**, then **Export** of `boxes.json`, the file a detector is
    trained on. Under Boxes, **Start from the model's boxes** is ticked when a suggestions
    file is found.
  - Development and Test: **Centers** (a click on every card), **Check names** (each center
    named, with no model's proposal shown), then **Export** of a manifest, the file
    `cardvision evaluate` reads. One line on the screen says why: it is fast, and it is how
    this project's own figures were measured, as a census of card centers together with
    seeded random points. **Points** is shown as the other measuring protocol, and Boxes,
    Names and Corners under **Other ways to label** ("Labels for measuring a model").

  A project whose labels were already made another way goes on that way. Each row has one line
  on what the pass is, how far it is ("4 of 10 frames", "28 cards left to name", "Done"), and
  one button: Start, Continue or Review. A pass that cannot be started is shown with the reason
  in one sentence, such as "Needs a catalog: a JSON list of the game's cards." The next pass
  also shows, in small print, the same start as one command with flags, for scripts. It
  starts with `python3` when that name runs the same Python as the tool; otherwise it names
  the Python that runs the tool by its full path (on a Mac, for example
  `/Library/Frameworks/Python.framework/Versions/3.12/bin/python3 labeler/serve.py ...`).
  Either form works. The tool decides this once, when it starts, so every command it shows
  begins the same way: the passes, the export, the start screen's.
- **Export** writes the file from the page and says what it wrote (frames, boxes or points,
  and the path). A file that is there already is replaced only after you say so. For a
  manifest the row asks for a credit (the name to show for the labels), and for the kind of
  footage when no recording says it; anything else it needs, such as where each video is
  hosted, is said in one sentence with what to fill in. The command for scripts is under it.
- **Other ways to label**: the passes that do not lead to this purpose's export, such as
  Corners and Corners from the model for Training.

**Switching passes, with no new start.** A tool started without `--mode` runs no pass, and the
page starts one. When a pass is finished, its card offers the next one (**Continue to Names**),
and on the project's screen the next pass's button does the same: the running tool switches to
that pass, of this project or of another, and the page opens it. Nothing is typed in a
terminal, and the terminal prints one line for each switch. A run started with `--mode` may be
switched in the same way; the flags it was started with keep belonging to its project. The
switch waits for nothing to be lost: the page saves what is pending first, and the tool refuses
to switch while a save is being written or another open labeling tab says it holds changes
that are not saved yet (the refusal says which and what to do). Every other open tab follows
the rules of a tool started again ("Good to know"). **← Project** at the top left of every
labeling screen leads back to the project's screen.

**What the tool remembers.** Two small files, both written when you act on a project on the
page: open it from the start screen, choose what its labels are for, change a location, or
start a pass. Looking at a project's screen by its address alone (a link, a bookmark) writes
nothing, and neither does a start with `--mode` alone:

- `labeler-project.json` in the project's labels folder: what the labels are for, and the
  locations that are not found beside the sample anyway. [FORMAT.md](FORMAT.md) describes it.
  A script or an agent can write it to prepare a project.
- `recent.json`, the list of projects you opened, in a folder of your user account:
  `Library/Application Support/card-labeler/` in your home folder on macOS,
  `$XDG_STATE_HOME/card-labeler/` on Linux (`.local/state/card-labeler/` in your home folder
  when that variable is not set), and `%APPDATA%\card-labeler\` on native Windows. Under
  WSL the tool runs in Linux and uses the Linux location, in Ubuntu's home folder. Set
  `LABELER_STATE_DIR` to keep it in another folder.

Deleting either is harmless: the tool then finds what lies beside the sample, and asks again
what the labels are for if none is saved yet. Flags given on the command line win over both.
A flag belongs to the project named with it (`python3 labeler/serve.py toy --zoom 2`): another
project opened on the page is started with none of them. The command a row shows for a pass
says every setting the pass runs with, so a start with it behaves the same.

## The screen

Every pass has the same parts:

- **The top bar**: the pass and the set (a menu, with each set's progress), the frames as
  numbered squares (a finished one has a tick), "Frame 2 of 5", the progress of the set, and
  two indicators: whether the server still runs, and whether every change is saved.
- **The instruction line** under it: one sentence that says what to do in the state the page
  is in, with the keys drawn as keys.
- **The frame**, or one card of it enlarged, in the middle. In the Boxes pass a legend under the
  frame says what each kind of line means.
- **The panel on the right**: a short status, one **primary button** whose words say what it
  will do now and which key does the same, the everyday actions as buttons with their keys on
  them, then **Options** (the switches used less often) and **About this recording** (optional
  notes on the footage; labeling never waits for them).
- **`?`** (or the Keys button) shows every key of the pass. **F6** moves the keyboard focus to
  the panel's controls, Tab goes on from there, and Esc comes back to the frame.

Keys and buttons run the same code, and no key means anything else than before. Where the
focus is decides who takes a key: a text field keeps every key, so letters type there; Enter
and Space on a focused button act on that button only; every other key is a shortcut of the
pass, whatever control has the focus. A click on a button does not move the focus.

When a set is finished, a card says what was done and what is next: the next set that still
has work, or, when none has, the way back to the project's screen, which says how to start the
next pass. **← Project** in the top bar leads there at any time.

Things that can go wrong say so on the page. A stopped server shows "Server stopped" within a
few seconds, and a change that could not be saved stays on the page, is named in a banner and
is saved when the server runs again. A frame whose picture does not load says which file the
server looked for; such a frame cannot be labeled or confirmed. A sample without frames shows
how to make one.

The look is in one file, `theme.css`: the colors, the spacing and the corner radii, as CSS
custom properties. Change a value there and the page and the drawing on the frame follow.

## What you give it

A start with flags runs one mode with one role: `--mode` needs `--role` and `--sample` (or
the project as `FOLDER-OR-SAMPLE`), and the page then opens straight into that pass. Without
`--mode` the page asks ("Starting the tool, and a project's screen", above); the flags below
that describe a project may then go with `FOLDER-OR-SAMPLE`, and fill in its screen. The page
names the modes as passes: Boxes (`box`), Names (`identify`), Corners (`corner`), Corners from
the model (`training`), Points (`point`), Centers (`center`) and Check names (`verify`).
Everything else has a default beside the sample file. With `--mode`, a catalog, card images
and a model's suggestions are used when their flag is given, and not otherwise.

| Flag | What it is | Default |
| --- | --- | --- |
| `FOLDER-OR-SAMPLE` | the project: a sample file, or the folder that holds a `sample.json` | none: the start screen |
| `--mode`, `--role` | the pass to start at once, and what the labels are for | none: the page asks |
| `--sample FILE` | which frames to label | needed with `--mode`, unless `FOLDER-OR-SAMPLE` is given |
| `--labels-dir DIR` | where the labels are written | `labels/` beside the sample |
| `--frames-dir DIR` | frames as `<DIR>/<asset id>/<frame name>` | `frames/` beside the sample |
| `--catalog FILE` | the game's cards | none: boxes can be drawn, no card can be named |
| `--art DIR_OR_URL_BASE` | where the card images are | none: previews show card names only |
| `--decklists-dir DIR` | deck lists per video | `decklists/` beside the sample |
| `--decklist [SET=]FILE` | a deck list for one set or for all (repeatable) | |
| `--prefill [SET=]FILE` | a model's proposals (see "Model pre-fill") | |
| `--port N` | the port on 127.0.0.1; `0` picks a free one | 8090 |
| `--zoom`, `--k`, `--seed`, `--snap` | settings for new sets (see the modes) | 3, 12, 1, off |

### The sample

The list of frames to label:

```json
{"assets": [{"assetId": "table-a", "framesDir": "frames/table-a",
             "frames": [{"t": 0.0, "name": "f00001.png"}, {"t": 1.0, "name": "f00002.png"}]}]}
```

Each asset is one video and becomes one label set of the same id. `t` is the frame's time in
seconds and orders the frames. An asset or a frame record may also say where its video is
hosted (`platform`, `videoId`), or that it is a recording of your own (`"platform": "local"`);
only the manifest export reads that (see "Exports"). `framesDir` is optional (absolute, or
relative to the sample file); without it the frames are looked for in
`--frames-dir/<asset id>/`. An asset may carry a `channel` text, shown in the set menu, and a
`title`, `uploadDate` and `language`, shown in the Names pass (FORMAT.md). Frame
files are `.jpg`, `.jpeg` or `.png`; their names may use letters, digits, `_`, `-` and `.`;
asset ids letters, digits, `_` and `-`.

`make_sample.py` writes a sample from folders of frames. Paste this into the terminal, from the
repository's root:

```
python3 labeler/make_sample.py --out sample.json --frames-root extracted/ --n 8
```

This takes eight frames spread evenly over each sub-folder of `extracted/` (`--all` takes every
frame). The choice depends on the file names and `--seed` only; no image is opened. `--local`
says the frames come from recordings of your own, which are on no video platform: each asset
then records `"platform": "local"` and its own id as `"videoId"` (see "A recording of your
own"). `--title ID=TEXT`, `--upload-date ID=YYYY-MM-DD` and `--language ID=TAG` record what you
know of a video; nothing is looked up.

### The catalog

The one file that describes a game's cards. The labeler reads the same file the rest of this
repository uses (`games/<game>/catalog.json`; `cardvision/core/catalog.py` documents it):

```json
{"cards": [{"id": "TOY-001", "name": "Sir Wobbleton", "kind": "unit", "printingOf": null, "art": "TOY-001.png"},
           {"id": "TOY-001A", "name": "Sir Wobbleton", "kind": "unit", "printingOf": "TOY-001", "art": "TOY-001A.png"},
           {"id": "TOY-T01", "name": "Pocket Pebble", "kind": "unit", "printingOf": null, "art": "TOY-T01.png", "token": true}],
 "kinds": {"landscape": ["site"]}}
```

- `id` and `name` are needed. Cards may share a name, as printings of one card or as different
  cards: each has its own id, and a label stores the id. An id is 1 to 64 characters with no
  space or other whitespace and no control character, the rule a label manifest holds card ids
  to (`data/SCHEMA.md`). The server will not start on a catalog with an id that breaks it,
  and says which entry it is.
- `kind` is the card's type in the game's own words. The first row of filters above the
  card list, Type, is the kinds the catalog contains.
- `facets` (optional) adds a row of filters per facet after Type: a top-level list such as
  `"facets": [{"key": "color", "label": "Color"}, {"key": "cost", "label": "Cost", "type": "number"}]`,
  and on each card `"facets": {"color": ["Red", "Blue"], "cost": 3}` (a list when the card has
  several values). `cardvision/core/catalog.py` ("Facets") has the rules; the server will not
  start on a catalog that breaks them. One value per row is active at a time, a card must match
  every active row, and a card with several values matches any of them. A row of more than 12
  values is a drop-down. A long label or value is cut with … (pointing at it shows it whole), a
  row wider than the panel scrolls sideways, and many rows scroll inside the filters, so the
  list of cards keeps its room. Every filter clears when you go to another card or frame, since the
  next card can be anything, and filters are not kept when the page is reloaded.
- `printingOf` marks an alternate printing of another card.
- `identity` (optional, at the top) says which entries are one card. `"name"`, the rule when it
  is left out: entries that share a name are printings of one card. `"printing"`: an entry and
  the entries whose `printingOf` names it are one card, and entries that only share a name are
  different cards. Check names follows it: `a` (both models agree) and an accept hold only for
  the same card by this rule. The server will not start on another value.
- `art` is the image: a path inside the `--art` folder (or appended to the `--art` URL base), or
  a full `http(s)` URL. `"art": null` marks a card without art, a card known by its id and name
  with no picture yet: it is listed and searched like any card, its tile in the grid says "No
  picture yet" with its name and id, and picking it saves its id.
- `kinds.landscape` (optional) lists the kinds whose cards are wider than tall when upright. It
  is used for the measured shape of a quad, nothing else.
- **Tokens** are read from the catalog and from nowhere else: every card marked
  `"token": true`, which is how the repository's catalogs say it, and every card whose `kind`
  contains the word "token". They can be picked like any card.
- The labeler also takes an optional top-level `tokens` list, for tokens that have no entry
  among the cards: `"tokens": ["Spark", {"name": "Ember Shard", "id": "X-EMB", "art":
  "tokens/ember.png"}]` (a name, or an object with `name` and optionally `id`, `kind` and
  `art`). An entry that is a card already is skipped, and one without an id gets
  `TOK-<its name>`. That key is the labeler's own: the `cardvision` tools refuse a catalog
  that has it, so keep such a file for labeling.

The labeler otherwise reads the catalog leniently: keys it does not know are ignored. It is read again
whenever the file changes, so you can add a card while the server runs.

### Card art

`--art` is a folder or an `http(s)` URL base. With a folder, the server serves the images from
it (and from nowhere outside it). With a URL base, your browser loads `<base>/<art>` directly;
the server still opens no connection. Without `--art` the card list and the previews show the
card's name, id and kind and no picture, and nothing else changes.

This repository contains no card art. Use images you are allowed to use.

### Deck lists

A deck list puts the cards that can be on the table first in the card list, which makes naming much
faster. One card id or exact name per line, with an optional count (`3 Sir Wobbleton`,
`3x TOY-001`, `Sir Wobbleton x2`, `Sir Wobbleton (2)`); `#` starts a comment. A name that several
printings share lists all of them. A line that matches nothing is shown in a banner; nothing is
guessed.

Put `<video id>.txt`, or one file per player `<video id>.<label>.txt`, in the deck-lists folder
and they load for that video. A `# label: Player A` line names a list. `--decklist FILE`
overrides the folder. `decklist_from_text.py` turns pasted text into such a file and reports
every line it could not match. Paste this into the terminal, from the repository's root:

```
python3 labeler/decklist_from_text.py --catalog catalog.json --out-dir decklists \
    --video table-a --label "Player A" --in pasted.txt
```

## Roles

Every label set has a role, fixed when its first label is saved:

| Role | What the labels are for | What the tool allows |
| --- | --- | --- |
| `training` | training a model | model pre-fill; your own boxes kept from frame to frame (carry-over) |
| `development` | measuring a model while you work on it | no pre-fill; carry-over; the verify pass may show model proposals under its rules |
| `test` | the final measurement | no model output of any kind, no carry-over: every label is made from the frame alone |

The page calls the roles Training, Development and Test (Final test, on the labeling
screens), and the project's screen asks for one before it offers a model's suggestions. A
pass that does not go with a role is not offered there as a button: its row says why. A start
with flags that cannot work, such as pre-fill with `--role test`, ends in one sentence that
says why.

A model's guess shown while you label pulls your answer towards it. That is fine for training
data, where it only saves time, and wrong for the labels a model is scored against. So the
server refuses pre-fill outside `training` sets, in its flags and again on every save.

A set's mode and role never change. Opened by a run with another mode or role, a set is
read-only. A folder in the labels root that this tool did not write is read-only too, and so
is a set with a label file that cannot be read in full (a line of `frames.jsonl` that is not
JSON, say after a crash of another program): a save writes the whole file again and would
drop that line. The project's screen and the export name the file and the line; correct or
remove the line in a text editor, and the set opens as before.

## Modes

### `box`: a box around every card

The first pass for training data. Drag to draw a box, or click a card that has none: the click
puts a box of the **new-box size** there, centered on the click, so a card the model missed is
one click (with a box selected, the click only lets go of it). A new box is dashed while you
adjust it; **Enter** confirms it, and **Enter** with nothing selected finishes the frame ("every
card on it is boxed") and goes on. A frame finished with no boxes means "no card here", and the
primary button then reads "Finish frame with no cards".

- **The new-box size** is shown in the side panel ("New box: 86 × 126 px · Change"). Unless you
  set one for the set (Change, or `s` on a box of the right size), it is the middle width and
  height of the model's boxes on that set, else of the boxes finished so far, else the size you
  set last. It is a preference of the page, kept in the browser; no label file holds it.
- **Three kinds of box**: a card face (the default), a card back (`b`), and **Too hidden:
  ignore** (`h`, red X): a card that is there but is not worth learning from, such as a face
  more than about half covered, so it should neither count as found nor as missed. The
  instruction line for a selected box names it, with its key.
- **Rotation and the card's top.** The knob above a box rotates it; `r` / `R` turn it by −1° /
  +5°, `w` / `W` by a quarter turn. The side with the white tick is the card's own top.
  Turning never changes a box's size. A model's upright box around a tilted card is larger than
  the card: turn it to the card's angle, then `e` (**Fit to the tilted card**) shrinks it, at
  that angle, to fit inside the model's box. It works on a model's box that has only been
  turned (not moved or resized), and on a kept box just moved with `m`; the button says why
  when it does not (a box drawn or changed by hand, a model's box cut by the frame's edge).
  Option/Alt+click an edge of any box to make that edge the top without moving the box.
- **Kept boxes (carry-over).** Entering an empty frame after a finished one copies that frame's
  boxes, so you adjust what moved. They are drawn with long dashes and marked `kept`, and a bar
  on the frame says how many there are and which frame they came from. `x` clears the ones you
  have not touched. Not in `test` sets. Turn it off or on with **Keep boxes from the previous frame** under
  Options (on at start, remembered by the browser): when you label 1 to 3 frames from each video,
  as is usual, the next frame is often from another video, and an empty start is easier.
- **Editing.** Undo and redo per frame, copy / paste / duplicate (also across frames), multi-
  select, stacking order, a default box size (`n` then click places one), and row tools that
  space a fan of cards evenly.
- **Snap** (`f`, off at start): a click on a card places a box snapped to its edges. It helps
  rough clicks and is a little worse than careful ones.
- **Hide names** (Options, on at start): the list of names is hidden and names are left to the
  Names pass. Untick it to name cards while boxing.
- **Saving.** Every edit saves by itself; the top bar shows "Saved", "Saving…" or "Not saved"
  with the frame's name. A save that fails stays on the page, is named in a banner and is
  tried again.
- **Removing a frame.** A frame that turns out too blurry, too small, empty of cards or nearly
  the same as another can be left out without starting over: the frame menu (`⋯` in the top
  bar, in every pass) has **Remove this frame from the project…**. It asks once, with an
  optional reason, and the frame is then skipped by the frame list, the counts, carry-over and
  every export (which says how many removed frames it skipped). Nothing is deleted: the frame's
  labels stay in the label files, and the project's screen lists the removed frames with a
  **Restore** button each, which brings a frame back with its labels as they were. When the
  video's folder holds frames the sample does not list (the frames every 2 seconds of "From a
  video to frames" when the sample lists only some of them), the question also offers **Use a
  nearby frame instead**: a strip of up to six neighbors, and the one you pick joins the project
  and is labeled like any other (with the model's boxes only where the suggestions file has
  them). A nearby frame's time comes from the suggestions file, else from its `fNNNNN` number
  and the times of the sample's frames; when neither gives it, the question says so, and such
  a frame can go into the boxes export but not into a measuring one. The record is one file in
  the labels folder, `removed-frames.json` (FORMAT.md); the sample file is never rewritten. It
  is written only once the page has saved everything. In a set for measuring (Development or
  Test) no nearby frame is offered, since a frame picked by hand is a selection: add frames by
  drawing a new sample. A frame whose answers have been shown in Check names cannot be removed,
  and nothing is removed in Check names itself. A repeat set's frames are removed in the video's
  own set, and the repeat-set tools (`make_repeat_set.py`, `compare_repeat.py`) do not read the
  list of removed frames.

With `--role training --prefill FILE` the frame starts with the model's boxes as pending boxes
(dash-dot, marked `model` and the score when the file has one). `a` or Enter accepts the
selected one, any edit corrects it, Delete rejects it, and Enter on the frame accepts every
untouched one and finishes the frame; the primary button then reads "Accept 6 model boxes and
finish frame". Each box records what happened to it (`prefill-accepted` or
`prefill-corrected`), and a rejected box never comes back. Where your carried-over boxes
already cover a card, the model's box for it is held back. A model's box that names another
card than the kept box under it is offered as a `?` suggestion instead, when the kept box has
a model's box of its own there: a card played onto another. A kept box on empty table, where
the model sees no card any more, is joined by an arrow to the `?` suggestion of the same card
elsewhere: the card has moved, and `m` moves the kept box there.

**Checking top edges** (`v`, or Options) goes through every box of the set one at a time,
enlarged, with the card's top drawn as a thick yellow bar: Enter if it is right, `w` / `W` or Option/Alt+click an
edge if the top is wrong, `b` / `h` / Delete as in the editor.

### `identify`: naming the boxes

A pass over an existing box, corner or training set of the same role. It walks every target
that is a card and has no name yet, one at a time, and asks "Which card is this?".

**The screen** has two panes, and the page itself does not scroll (at 1280 × 720 and larger;
in a smaller window the panes stack and the page scrolls):

- **Left**: the card being named, large: its box with a quarter of the box's size around it
  on each side (less at the frame's edge), as large as the pane allows. `z` steps its zoom
  through 1×, 2× and 4× and after 4× back to 1×; Shift+Z steps the other way (round, as the
  Points zoom goes). The wheel zooms at the pointer and a drag off the box moves the picture;
  the next card keeps the zoom. Under it a strip: the whole frame as a small picture with every box drawn and the
  current one thick, Options under it, and beside them the less used buttons (moving on, this
  box, zoom), the box's details and **About this recording**. A click on the small picture
  opens the whole frame large over the page, every box drawn and the current one thick; there
  the wheel zooms, a drag moves it and `z` / Shift+Z step, and Esc, a click outside it or its
  Close button closes it.
- **Right**: a fixed top with the answers, each a button with its key (Card back `b`, Not a
  card `x`, Cannot be read `u`, Unknown card, and **Clear this card's name**, Backspace), the
  deck list / all cards switch, the search and the filters; under it the cards, the only part
  that scrolls.

`/` puts the keys in the search (it does not undo a name: Backspace or the Clear button
does): the deck list first, Tab for all cards. A search with no match says so and offers "Search
all cards". After a name, the place of the search shows the picked card and asks "Can you read
this card from this frame alone?", with the rule under it: "Using only what this frame shows:
not other frames, the deck list or what you know of the game." `y` / `m` / `n` answers yes /
unsure / no (stored as `yes`, `uncertain`, `no`) and moves on. A card you can only name because
you know the deck gets its name and `n`. Every answer (a name, Unknown, `b`, `x`, `u`, a clear)
empties the search and the filters, so the next card starts with nothing typed.

The cards are a grid of pictures, one group per card: every printing of a card is a tile of
its own (its art and its id), and a card's alternate printings (entries whose `printingOf`
names it, followed to the card that is a printing of none) sit together in its group, under a
thin header such as "TOY-003 · Polite Dragon · 2 printings". A search or a filter
shows a card's group when the card or any of its printings matches; cards that only share a
name are separate groups, and the header's id tells them apart. ↑ ↓ move between groups, ← →
between the tiles of one, Enter picks the highlighted tile, and a click picks the tile clicked.
The card's own tile names the card with no printing; an alternate's tile names the card and
records that printing. Both are right answers: the exact printing is optional. A printing's
full id typed in the search shows its card's group with that printing highlighted. Pointing
at a tile's picture shows the card enlarged on the left pane, beside the card being named;
nothing else in the grid does. The pictures load as they scroll into view. The grid shows 60 cards at a
time; when more match, it says so ("60 of 230 cards shown"), and "Show 60 more" after the last
card, or ↓ on it, adds the next 60, until the search, the filters or the card change.

The top bar counts names in this pass ("12 named · 17 left"), the set menu says how many boxes
of each set are left to name, and a frame's square is ticked when every box on it has its
answer.

**Where the frame comes from.** About this recording shows what the sample says of the video,
when it says it: its title, the day it was published and its language, and, for a YouTube
video, a link that opens the video at this frame's time in your browser. Nothing is fetched by
the tool. It helps with a card the list does not have: a video from before a set's release
cannot show that set's cards. `make_sample.py --title`, `--upload-date` and `--language` write
these into the sample (FORMAT.md, "What a sample says about a video"). A value the sample gives
in another form is not used, and the line says which.

**Fixing a box.** In a box set you may fix which edge is the card's top (`w` / `W`, or
Option/Alt+click an edge): the four corners stay where they are, only their order turns. In a
box set made for training or development you may also fix the current box itself, on the
card's view: drag a corner or an edge to resize it, the knob above its top to rotate it, or the
inside to move it (a drag anywhere else moves the picture). The view stays where it is while
you change the box; a box made larger than the view's margin is taken in, so 1× shows it all.
Past the frame's edge the view shows a little empty space, so a box that runs off the frame
can still be reached. The edit is saved as the same edit
in the Boxes pass would be, with the box's id, name and answers; a model's box becomes
`prefill-corrected` and a kept box `carried-corrected`, as there. Cmd/Ctrl+Z takes it back:
the box returns to its place, and once the edit was saved, a kept box stays `carried-corrected`
(the server cannot tell an undo from an edit); a model's box back on its proposal is
`prefill-accepted` again.
Boxes are not added, removed, ignored or restacked here: that stays in the Boxes pass. In a
test set boxes are not moved, resized or rotated here; the top edge can still be turned. In a
corner set only the answers change. The server refuses anything else.

### `corner`: four exact corners

For footage where a rotated rectangle does not fit the card (a steep camera angle). Click the
four corners in a fixed order: the card's own top-left, top-right, bottom-right, bottom-left. A
corner hidden under something is placed where it must be with Shift+click and stored as
estimated. The server measures each quad on every save: its bounding box, side lengths, size on
screen, rotation and how strongly it is foreshortened.

### `training`: corners with pre-fill

Corner mode starting from a model's proposals, names included (`--role training` only).
Completing a target records whether its name and corners stayed as proposed.

### `point`: seeded points (Points)

For labels that no box and no model has touched. Each frame gets K points (`--k`, default 12)
whose positions depend on the frame number and `--seed` only, never on the picture: the first K
points of a Halton sequence, shifted by an offset hashed from the seed and the frame number.
Each point is shown alone at a fixed zoom, and gets one answer: a card (and which), a card
back, not a card, or a card that cannot be read. This gives an unbiased sample of "what is under
a pointer" on that footage. Started from the page, a set gets 12 points a frame placed by seed
1; for other numbers, start it with flags.

**The screen** has the Names pass's two panes, and the page itself does not scroll (at
1280 × 720 and larger; in a smaller window the panes stack and the page scrolls):

- **Left**: the point's crop, the point at the center of the ring, with a line under it that
  says how much it is enlarged. Its size is the size it had before the two panes, a square of
  320 to 640 px (as large as the pane's height allows, 60 px kept for the line), so the crop
  shows as much of the frame around the point as in earlier sittings: what the answer was
  judged on stays the same. Only in a pane too narrow for it and the strip beside it is it
  smaller. `z` shows more around the point (the set's zoom, then a half, then a quarter of it)
  and after that goes back; Shift+Z steps the other way. Beside the crop a strip: the whole
  frame as a small picture with every point (answered ones in their answer's color) and the
  crop's window, the less used buttons (moving on, clear, zoom), the point's details, **About
  this recording** and Options. A click on the small picture opens the whole frame large over
  the page, the point and the window marked; there the wheel zooms, a drag moves it and `z` /
  Shift+Z step, and Esc, a click outside it or its Close button closes it.
- **Right**: a fixed top with the answers, each a button with its key (Card back `b`, Not a
  card `x`, Cannot be read `u`), the deck list / all cards switch, the search and the filters;
  under it the grid of cards, as in the Names pass, the only part that scrolls, 60 cards at a
  time with "Show 60 more".

`/` puts the keys in the search; Enter or a click picks a card, and `y` / `m` / `n` then say
whether it can be read from this frame alone and move on. Every answer (a card, `b`, `x`, `u`,
a clear) empties the search and the filters, and the next point starts with none.

### `center`: a census of card centers (Centers)

Click the center of every card face on the frame, Shift+click the center of every card back,
Enter to confirm. On a frame with no marker the primary button reads "Confirm no cards in this
frame": that is what Enter does there. A loupe shows the pixels under the pointer. No names, no model output;
`development` and `test` sets only. It is a fast way to count and locate every card on
held-out frames.

### `verify`: naming a census (Check names)

A pass over a census that names every face center, built so that a model's proposal cannot
steer the answer more than it should. Started from the page, it names every center with no
proposal at all (the `--all-blind` form below); with models' proposals it is a start with flags.

1. **The crop.** A fixed window around the click, no names. The page asks "Is the name legible
   in this crop?", with the rule "Knowing the card from its art, the catalog or the game does
   not count.": `y` / `m` / `n`.
2. **The reveal.** Only after that answer is saved does the server release the proposals of the
   run's model **arms**, side by side: each arm's crop, the name it gives or "nothing shown",
   its scores and the card's art. `1` accepts the first arm's name, `2` the second's, `a` both
   when they agree (show the same card, by the catalog's `identity` rule), `/` picks another card, `u` is Unknown, `x` "not a card" and `b` "this is a
   back" (two corrections that leave the click itself as it was).

The page has the Names pass's two panes: the crop (`z` / Shift+Z its size, round; on screen 180
to 420 px as in earlier sittings, since how much it is enlarged is part of what the readability
answer is judged on), the whole frame as a small picture (a click opens it large) and the
models' proposals on the left; the answers with their keys, the search, the
filters and the grid of cards on the right. Every answer empties the search and the filters.

The readability cannot be changed after the reveal. A **blind subsample** (`--blind FILE`) is
named with no proposals at all, so you can measure how much the proposals move the answers.
On such a card the search takes the keyboard focus once step 1 is answered, and not before:
from then on letters type into it, and Esc leaves it for `u`, `x` or `b`. Paste this into the
terminal, from the repository's root:

```
python3 labeler/serve.py --mode verify --role development --sample sample.json \
    --catalog catalog.json --arm new=new-model.jsonl --arm old=old-model.jsonl --blind blind.json
```

- `--arm NAME=FILE`, once or twice: a name of your choosing (lower-case letters, digits, `_`)
  and that model's pre-fill file for the same frames. For each clicked center an arm proposes
  the box of its file that the click falls in. An accept is stored as `accept-<NAME>` (or
  `accept-both`).
- `--blind FILE`: a JSON list of centers such as `["table-a/f00001.png/C004"]`, or the same
  grouped by video and frame. Optional.
- `--all-blind`: no arms at all; every center is named without proposals. This is the only way
  to name a `test` set.

The server checks the files before it starts and refuses, listing every problem (also into
`--problems-report FILE`): a malformed record, a frame with face centers that an arm's file has
no record for, a card id the catalog lacks, a blind entry that names no center or more than
one. If a center is moved later, or an arm's file changes, the answers given before are marked
stale and asked again.

## Keyboard shortcuts

**`?`** on the page (or its Keys button) lists the keys of the pass you are in. No key does two
things in one pass. Every everyday action is also a button with its key printed on it. In
every pass, `?` opens that list and **F6** moves the keyboard focus to the panel's controls.

Box mode:

| Key | Effect |
| --- | --- |
| drag on empty frame | draw a box (Alt+drag: also on top of another box) |
| click | select the topmost box under the pointer; where there is no box, a box of the new-box size there (with a box selected: let go of it) |
| Shift+click / Shift+drag | add or remove a box / select every box whose center is inside |
| drag a box, a corner, an edge | move it / resize it in its own rotated frame |
| drag the knob above the top | rotate about the center |
| Option/Alt+click an edge | that edge is the card's top (the box does not move) |
| double-click a box | as `w` |
| `n` then click | place a box of the new-box size |
| Enter | confirm the box being adjusted; again, with nothing selected: finish the frame and go on |
| Shift+Enter | reopen a finished frame |
| Esc | cancel a drag or `n`; else deselect |
| arrows | move the selection 1 px (Shift: 10 px); with nothing selected, ← → change frame |
| Alt+arrows | move the selected box's own right / bottom edge |
| `[` `]`, PageUp / PageDown | previous / next frame |
| Tab / Shift+Tab | next / previous box |
| Delete / Backspace | remove the selected box(es) |
| `b` · `h` | card back on / off · too hidden to learn from (ignore) on / off |
| `r` / `R` · `w` / `W` | rotate −1° / +5° · turn a quarter clockwise / counter-clockwise (the size stays) |
| `e` | fit a turned model's box to the tilted card, inside the model's upright box |
| `.` `,` · `>` `<` | one layer forward / back · to the front / back |
| `x` · Shift+X | clear the kept (carried-over) boxes you have not touched · clear the whole frame (asks first) |
| `m` | a card that moved: the kept box joined by an arrow goes onto the model's `?` box for the same card, which goes away |
| `f` | snap on / off |
| `s` · `S` | snap on: re-snap the box; snap off: new-box size = this box · resize the box to the new-box size |
| `g` · `+` · `-` · `l` | row tools: distribute · insert · remove · same layout as another frame |
| `i` or `/` · `u` · `a` | search for the name · Unknown · printing (with Hide names unticked) |
| `t` / `0` | show one kind of card only / all kinds |
| `p` | card previews on / off |
| `v` | checking top edges on / off |
| Cmd/Ctrl+Z · Shift+Z or Y | undo · redo (this frame) |
| Cmd/Ctrl+C / V / D | copy / paste / duplicate |

With pre-fill: `a` accept the selected model box and go to the next · Enter on a selected one
accepts it · Enter with nothing selected **accepts every untouched model box** and confirms the
frame · Delete rejects · `j` next unreviewed one.

Checking top edges: Enter, → or Space: fine, next box · ← previous · `w` / `W` or Option/Alt+click an
edge: fix the top · `b` / `h` / Delete · `j` next flagged box · `]` / `[` next / previous frame ·
`v` or Esc leave.

Identify mode: `/` or `i` the keys to the search (↑ ↓ cards, ← → their printings, Enter picks,
Tab deck list ↔ all cards, Esc; it does not undo a name) · `x` not a card · `b` back · `u`
unreadable · `y` / `n` / `m` readable from this frame alone: yes / no / unsure · Enter, → or `]`
next · ← or `[` previous · Space next one still open · Backspace clear this card's name (also a
button) · `w` / `W` or Option/Alt+click an edge: the card's top · drag the box's corners, edges,
knob or inside on the card's view: resize, rotate, move it (training and development box sets)
· `f` flag the box to fix later · `z` / Shift+Z the card's zoom, next / previous of 1×, 2×, 4×,
round (the wheel zooms, a drag off the box moves it) · a click on the small frame: the whole
frame (Esc closes it) · `a` printing · `o`
where the name came from · `c` `l` `g` `k` face up, blur, glare, sleeve or foil · `v` visible
share · `t` / `0` filter · `p` card previews · Cmd/Ctrl+Z undo. Every answer empties the search.
While the whole frame is open only Esc, `z` and Shift+Z act.

Corner and training mode: click four corners · Shift+click a hidden corner · drag a handle ·
`e` estimated on / off · `r` rotate the corner order · `f` snap on / off · `s` snap now ·
Tab next target · `j` next incomplete · Delete · Enter confirm the frame · ← → frames · the
answer keys of identify mode.

Point mode: the answer keys of identify mode · Enter, → next point · ← previous · Space next
frame with points left · PageDown / PageUp frames · `z` zoom out and back · Backspace clear ·
a click on the whole frame opens it large (Esc closes it).

Center mode: click a face center · Shift+click a back center · click or drag a marker to select
or move it · `b` face ↔ back · Delete · Tab next marker · Enter confirm the frame · Shift+Enter
unconfirm · Cmd/Ctrl+Z undo.

Verify mode: `y` / `m` / `n` the name is legible in the crop (first) · Space or Enter show the proposals,
or go to the next open center · `1` / `2` accept that arm · `a` accept both · `/` or `i` another
card · `u` Unknown · `x` not a card · `b` a back · ← → previous / next · Backspace clear · `z` /
Shift+Z the next / previous crop size, round.

## From a video to frames

The tool labels frames and not videos. Cut frames from the video first, then list them in a
sample. With this repository installed (its `cardvision` command) and a release of its models
for your game, paste this into the terminal, from the repository's root:

```
cardvision infer my-video.mp4 --release release.json --every 2 --frame-format png \
    --frames work/frames/my-video --prefill-out work/prefill.jsonl
python3 labeler/make_sample.py --out work/sample.json --asset my-video=work/frames/my-video \
    --all --times work/prefill.jsonl --local
```

The first saves one frame every 2 seconds with its time, and the model's boxes for each; the
second lists those frames as a recording of your own (`--local`, "A recording of your own").
Then open `work/sample.json` on the start screen. Without a model, any program that saves
frames of a video as `.png` or `.jpg` files into a folder will do: run the second command
alone, without `--times` and its file. The start screen's third path shows the same commands.

## Labels for measuring a model

The census of centers and the points are the two protocols for labels a model is measured on,
and the project's screen leads to them for Development and Test. A census (Centers, then Check
names) is a click on every card and then one name each, the fastest way to label every card of
a frame for measuring; seeded points (Points) are random positions, each answered, which add
the off-card positions a measurement needs. This project's own figures were measured on both
together: a census of card centers and seeded random points on the same frames. Both export as
`points` rows of a manifest ("Exports"), which `cardvision evaluate` reads; keep the two in two
labels folders (a recording keeps one way of labeling in a folder) and give both to the export.

## Model pre-fill

The pre-fill file is what the reference inference command of this repository writes with
`--prefill-out`: JSON lines, one object per frame. To make one and label with it, paste this
into the terminal, from the repository's root:

```
cardvision infer my-video.mp4 --detector detector.onnx --recognizer recognizer.onnx \
    --bank bank.json --catalog catalog.json --every 2 \
    --frames work/frames/my-video --prefill-out work/prefill.jsonl
python3 labeler/make_sample.py --out work/sample.json --asset my-video=work/frames/my-video \
    --all --times work/prefill.jsonl
python3 labeler/serve.py --mode box --role training --sample work/sample.json \
    --catalog catalog.json --prefill work/prefill.jsonl
```

The first command writes the frames it analyzed and one record for each; the second lists
those frames (with their times, read from the same file); the third labels them. Use one frames
folder per video.

A record:

```json
{"t": 44.017, "name": "my-video-f00023.jpg", "frameW": 1920, "frameH": 1080,
 "boxes": [{"box": [612, 301, 118, 164], "cardId": "TOY-001", "sim": 0.81, "margin": 0.12,
            "top5": [{"id": "TOY-001", "sim": 0.81}], "rot": 0, "flag": null}]}
```

- `name` is the frame's file name. A record may also carry `set` (the asset id): it then
  applies to that set only, which lets one file hold several videos whose frame names repeat.
- `box` is `[x, y, width, height]` **in the record's own `frameW` × `frameH` pixel space**. The
  tool scales it to the frame it actually shows, so a model that ran on smaller frames than the
  ones you label still lines up. A record without `frameW` / `frameH` is taken to be in the
  frame's own pixels.
- `rot` is the orientation the model matched the card in, in quarter turns (0 to 3); 90, 180
  and 270 are read as degrees. It sets which edge of the box starts as the card's top.
- `cardId`, `sim`, `margin`, `top5` and `flag` are the model's name for the card and how sure it
  was. Training mode starts each target with that name; box mode ignores it and leaves names to
  the identity pass. Verify mode shows them at the reveal.
- A box may also carry `outcome` (`card` or `card-back`) and `score`, or `corners` (four points)
  in place of `box`. A file may also be JSON: `{"frames": [...]}`.

The tool never runs a model. Pre-fill is a file, and it is refused outside `training` sets.

## Exports

The tool's own format is the source of truth (see [FORMAT.md](FORMAT.md)). `export.py` writes
copies for other programs. Paste this into the terminal, from the repository's root (the part
in brackets is optional: type it without the brackets, or leave it out):

```
python3 labeler/export.py coco --labels-dir labels --out boxes.json [--catalog catalog.json]
```

This writes a COCO-style detection file of every confirmed frame of the box, corner and training
sets (the Export row of the project's screen writes the same file, `boxes.json` beside the
sample, from the page): categories `card` and `card-back`, `bbox` the upright box around each card, the four
corners as `segmentation`, `iscrowd: 1` on ignored boxes, and the card's id, name, angle and
provenance under `attributes`. `--set`, `--role` and `--include-unconfirmed` choose what goes in.
A frame removed from the project (`removed-frames.json` in the labels folder) is skipped by
both exports, with a note such as "table-a: 1 removed frame skipped"; the manifest export's
summary line also counts them by reason.

### Offering labels: the manifest export

Paste this into the terminal, from the repository's root:

```
python3 labeler/export.py manifest --labels-dir labels --sample sample.json \
    --credit "Your Name" --out offer/labels.manifest.jsonl
```

This writes the same sets in the repository's public label-manifest format (`data/SCHEMA.md`): one
line per confirmed frame, naming a video and a time, every coordinate a fraction of the frame.
That is the form in which labels are offered to the project (`data/README.md`, "Offer labels"),
and every row is written as an offer: `role` is `extra`, `trained_on` is false, and `reachable`
is null. Nobody chooses a role; it is dealt out when the labels are accepted.

The Export row of the project's screen writes it from the page, to `manifest/labels.manifest.jsonl`
beside the sample, and asks there for the credit and, when no recording says it, the kind of
footage.

A manifest names videos and not files, so the export needs a few things the labeling did not:

- **Where each video is hosted.** Add `"platform"` (`"youtube"` or `"twitch"`) and `"videoId"`
  to each asset of the sample file, or to single frame records where frames of one asset come
  from different videos:

  ```json
  {"assets": [{"assetId": "table-a", "platform": "youtube", "videoId": "EXAMPLE0001",
               "frames": [{"t": 754.517, "name": "f00001.png"}]}]}
  ```

  A recording of your own is on no platform: its platform is `"local"` and its video id a name
  you choose. The next section has that route.

- **The frame's time in the video.** A frame record's `t` is written as the row's `t`, so it
  must be the time, in seconds, at which that frame is on screen in the video, and not merely
  a number that orders the frames. `data/SCHEMA.md` says which frame a time stands for.
- **The kind of footage.** `--source-type physical/webcam` (or `physical/tournament`,
  `physical/phone`, `digital`, or a game's own such as `digital/<client>`), for every set or
  as `SET=TYPE` for one. Left out, it comes from what you said under About this recording in
  the tool.
- **Which videos belong together.** `--group ID` (or `SET=ID`) names the recording group:
  videos of one channel or one event share a group. Left out, each video is a group of its
  own.
- **A credit**, `--credit`: the name to show for the labels.

Write the manifest into a folder of its own, away from frames and card images: a manifest's
folder holds text only, and the check below refuses one that holds a picture. Then check it
with the repository's validator (the labeler itself imports nothing from that package). Paste
this into the terminal, from the repository's root:

```
cardvision validate-manifest offer/labels.manifest.jsonl --catalog catalog.json --contribution
```

(Add `--sources` with the game's sources file when a source type is one the game adds, such
as a digital client's. The validator reads the catalog strictly: it wants the repository's
own catalog file, without the labeler-only `tokens` list.)

What the export does with the labels:

- Only confirmed frames are written, because a row says that every card on the frame has a
  box. A frame with a box the format cannot hold (an outline that is not convex, or one that
  lies wholly off the frame) is left out and listed.
- A card is a `face`, a card back a `back`; "unreadable" and "not a card" keep their names.
  A box with no name yet is written as `unlabeled`; `eligible: uncertain` becomes
  `readable: maybe`. Where a printing is recorded, it is the card id written.
- Repeat sets are skipped. A set with a label file that cannot be read in full is left out
  whole, and the export says which file and which line.
- **Censuses and points** are written as `points` rows (`completeness: "points"`): a center
  is a point with `origin` `center`, a seeded point one with `origin` `seeded`. Only a
  confirmed census frame is written, and one with no center is left out (there is no point to
  write) and counted in a note. A face that Check names has not answered in full, or whose
  answer is stale, is written as `unlabeled`, and a note says how many. `readable` is Check
  names' first answer, whether the name is legible in the crop, and such a point says so with
  `attributes.readable_from` `crop`; a face named with no proposal shown carries
  `attributes.blind` true. `--labels-dir` may be given twice: a census and a point set of the
  same frame then share one row. [FORMAT.md](FORMAT.md) lists the mapping.
- **The frame fingerprint** (`attributes.frame_dhash`, which lets a frame be found again by
  its content when the time is a little off) is written for frames stored as 8-bit PNG files.
  It is **not written for JPEG frames**: the standard library, which is all this tool uses,
  cannot decode them. Rows without it are found by `t` alone, so for JPEG frames the times in
  the sample matter all the more. `--no-fingerprint` leaves it out for every frame.

### A recording of your own

A phone or screen recording of your own play can be labeled and written to a manifest too.
Its rows have `platform` set to `local` and a video id that is a name you choose: 1 to 64
letters, digits, `_` and `-`, starting with a letter or a digit (`data/SCHEMA.md`, "Recordings
of your own"). The name identifies no file. You say which file it is when you get the frames.

The route, from the video file to a manifest:

1. **Cut frames from the recording, with their times.** `cardvision infer` does both. The
   time it writes for a frame is a time at which that frame is on screen in the video, which
   is what a manifest row needs. Paste this into the terminal, from the repository's root:

   ```
   cardvision infer my-recording.mp4 --every 5 --frame-format png --release release.json \
       --frames own/frames/kitchen-table-01 --prefill-out own/times.jsonl
   ```

   `--frame-format png` stores the frames as PNG files, which this tool can fingerprint.

2. **List the frames as a recording of your own.** The asset id is the name of the recording,
   and `--local` records it as such. Paste this into the terminal, from the repository's root:

   ```
   python3 labeler/make_sample.py --out own/sample.json \
       --asset kitchen-table-01=own/frames/kitchen-table-01 --all --times own/times.jsonl --local
   ```

3. **Label the frames** in the tool, in the role the labels are for (`--role test` for labels
   you will measure a model on: no model output is shown).
4. **Export**, as above. `--source-type` says what kind of footage it is, unless you said
   so under About this recording in the tool. Paste this into the terminal, from the
   repository's root:

   ```
   python3 labeler/export.py manifest --labels-dir own/labels --sample own/sample.json \
       --credit "Your Name" --source-type physical/phone --out own/manifest/own.manifest.jsonl
   ```

5. **Check it and get the frames**, giving the recording's file under its name. Paste this
   into the terminal, from the repository's root:

   ```
   cardvision validate-manifest own/manifest/own.manifest.jsonl --catalog catalog.json
   cardvision fetch own/manifest/own.manifest.jsonl --out own/fetched \
       --video-file kitchen-table-01=my-recording.mp4
   ```

Good to know:

- **Such rows are for your own use.** They cannot be offered to the project, because nobody
  else can obtain the video, and `validate-manifest --contribution` refuses them. The export
  says so, and names the check without `--contribution`.
- **The rows are written as `extra`**, like every exported row. `cardvision evaluate` scores
  the role you name: pass `--role extra`, or deal roles first with `cardvision assign-roles`
  when you have several recordings.
- **Use PNG frames.** A row made from a PNG frame carries the frame's fingerprint, and
  `cardvision fetch` then finds the frame by its content. Without `--frame-format png` the
  frames are JPEG files, which this tool cannot fingerprint, and `fetch` finds each row's
  frame by its time alone. That time is one at which the frame is on screen: halfway
  between the frame's own timestamp and the next frame's, to the millisecond.
- **What the time alone gives.** From the same file, `fetch` finds the very frame that was
  cut, by its time. Both commands read each frame's own timestamp from the file, so this
  holds at a constant frame rate and at a variable one, as phones and screen recorders often
  record. It is tested at 23.976, 24, 25, 29.97, 30, 50, 59.94 and 60 frames a second, and on
  generated recordings of variable frame rate, in two file formats, whose frames stay on
  screen from a sixtieth of a second to seconds. `--every 5` is five seconds of video at
  either kind of rate.
- **What the fingerprint adds.** A check by content. `fetch` keeps a frame only if it looks
  like the one that was cut, and it still finds that picture in a copy of the recording that
  was cut or encoded again, where the times can be a little off. So keep PNG frames. Where
  the frames next to it look the same, because nothing moved, the frame kept can be one of
  those: it shows the same picture.
- `docs/measure.md` (tier 2 of the adapt guide) runs this route on a toy game and shows the output of
  every step.

## Labels written by a script

If you already know where the cards are on your frames, from another tool or because you
drew the scenes yourself, a script can write the label files. Nothing is clicked and the
server need not run. The files are plain JSON, and `export.py` reads them as it reads the
tool's own.

Mind what this is for. The tool checks every label it saves; a file you write yourself is
checked only by the export, and only for what the export needs. Such labels are as right as
their source and no more. Labels you measure a model with must not come from a model.

**Where the files are.** Each label set has a folder of its own in the labels folder, named
by the set's id. A set is the labels of one video in one mode, and its id is the id of that
video's asset in the sample file:

```
work/
  sample.json               which frames, and which video they come from
  labels/
    kitchen-table-01/
      meta.json             one for the set: what the set is
      frames.jsonl          one line for each frame: the frame's record, with its boxes
```

**`sample.json`** lists the frames ("The sample", above). For the manifest export each asset
also says where its video is. Here it is a recording of your own:

```json
{"assets": [{"assetId": "kitchen-table-01", "platform": "local", "videoId": "kitchen-table-01",
             "frames": [{"t": 12.5, "name": "f00001.png"}]}]}
```

**`meta.json`** says what the set is:

```json
{"schemaVersion": 2, "tool": "labeler", "setId": "kitchen-table-01",
 "frameAsset": "kitchen-table-01", "mode": "box", "role": "training"}
```

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `tool` | `2` and `"labeler"` |
| `setId` | the set's id: the name of its folder |
| `frameAsset` | the id of the asset in the sample whose frames the set labels |
| `mode` | `box`, `corner` or `training`. These are the modes whose sets the manifest export writes. The mode decides what shape a box may have (below). |
| `role` | `training`, `development` or `test`: what the labels are for ("Roles", above) |
| `recording` | optional: `{"source": "physical", "physicalGroup": "phone"}`, or `{"source": "digital"}`. The export takes the kind of footage from it when you do not pass `--source-type`. |

**`frames.jsonl`** has one frame's record on each line. The record is shown here on several
lines; in the file it is one line:

```json
{"name": "f00001.png", "t": 12.5, "frameW": 1280, "frameH": 720, "done": true,
 "targets": [
  {"id": "B001", "corners": [[412, 96], [530, 96], [530, 261], [412, 261]],
   "outcome": "card", "identity": "TOY-001", "eligible": "yes"},
  {"id": "B002", "corners": [[765, 300], [765, 418], [600, 418], [600, 300]],
   "outcome": "card", "identity": "unknown", "eligible": "no"},
  {"id": "B003", "corners": [[900, 96], [1018, 96], [1018, 261], [900, 261]],
   "outcome": "card-back"}]}
```

A frame's record:

| Field | Meaning |
| --- | --- |
| `name` | the frame's file name, as the sample gives it |
| `t` | the frame's time in the video, in seconds. The export writes the time the sample gives for the frame, so keep the two equal. |
| `frameW`, `frameH` | the frame's size, in whole pixels |
| `done` | `true`: every card on the frame has a box. The export writes only such frames, because a manifest row says exactly that. A frame with no card on it is `done` with an empty `targets`. |
| `targets` | the boxes, one object each |

A box:

| Field | Meaning |
| --- | --- |
| `id` | optional: a short name, unique in the frame. It becomes the box's `id` in the manifest. |
| `corners` | four `[x, y]` in pixels of the frame, in the card's own order: its top-left, top-right, bottom-right, bottom-left. The edge from the first corner to the second is the card's top, so the order says which way up the card lies. The second box above lies on its side. |
| `outcome` | `card` (a card face), `card-back`, `unreadable` (a card whose face cannot be read) or `not-card`. Left out, it is `card`. |
| `identity` | for a `card`: its id in the catalog, or `"unknown"`. Left out, the box is written as not yet named. |
| `printing` | optional: the id of the alternate printing on screen. When it is given, it is the card id written. |
| `eligible` | for a `card`: whether it can be read from this frame alone: `yes`, `uncertain` or `no` |
| `ignore` | optional, `true`: a card that is there and should count neither as found nor as missed |
| `conditions` | optional: `{"visibleShare": "full"}`, or `most`, `half`, `little` |
| `labelSource` | optional: how the box was made, in the tool's own words ([FORMAT.md](FORMAT.md)). It becomes the box's `origin`. Leave it out for a box that a script wrote. |
| `cornerSource` | optional: in a `corner` or `training` set, `"box"` says that the four corners are a rectangle |

What the mode changes:

- **`box`**: every box is a rectangle, upright or turned. It is written with the shape
  `rotated-box`.
- **`corner`** and **`training`**: a box may be any four-cornered outline that is convex, as
  a card looks under a camera at an angle. It is written with the shape `quad`, or
  `rotated-box` when it has `"cornerSource": "box"`.

In every mode an outline must be convex, with every edge at least one pixel long and not
wholly off the frame, and two boxes of a frame may not have the same outline. A frame with a
box that breaks one of these is left out of the manifest and listed.

Then export, check and use the manifest as for any other labels ("Offering labels" and "A
recording of your own", above). With the three files under `work/` in the repository's root,
paste this into the terminal, from the repository's root:

```
python3 labeler/export.py manifest --labels-dir work/labels --sample work/sample.json \
    --credit "Your Name" --source-type physical/phone --out work/manifest/scripted.manifest.jsonl
```

You should see something like:

```
wrote .../work/manifest/scripted.manifest.jsonl: 1 rows, 3 boxes, 0 rows with a frame fingerprint
  1 row(s) have no fingerprint: only 8-bit PNG frames can be fingerprinted here
check it: cardvision validate-manifest .../work/manifest/scripted.manifest.jsonl
  rows of your own recordings (platform local) cannot be offered: nobody else can obtain the video
```

(`...` stands for the folder you ran it in: the export prints full paths.) The row has no fingerprint because the example has no frame file: the export fingerprints a
frame only when it finds the PNG file the sample names.

These three files are all the export reads. [FORMAT.md](FORMAT.md) lists every field the tool
itself writes: when it saves a set it adds measured values, provenance and times. A test
(`tests/test_labeler_readme_example.py`) writes the three examples above as they stand
here and runs the export on them.

## Checking the labeling

Paste this into the terminal, from the repository's root:

```
python3 labeler/make_repeat_set.py --labels-dir labels --src table-a --n 40
python3 labeler/compare_repeat.py --labels-dir labels --repeat table-a-rep1
python3 labeler/report_throughput.py table-a --labels-dir labels
```

`make_repeat_set.py` draws a seeded sample of labeled points or targets into a new set with
every answer removed. Label it again some days later; `compare_repeat.py` reports how often the
two passes agree on the outcome, the name and the readability (with Cohen's kappa), and lists
the disagreements.

The page logs what you do and when (`timing.jsonl` beside the labels: a box drawn, corrected,
deleted, a frame confirmed). `report_throughput.py` turns that into labels per active hour,
with gaps longer than `--idle` seconds (default 120) counted as a break, the correction rate,
and for pre-fill how many model boxes were accepted, corrected and rejected and the time per
box. Nothing limits or judges the labeler's time; the log is there so that you can tell
whether a change to the workflow helped.

**How long will labeling take?** This page gives no figure: it depends on the footage, on
how many cards a frame holds and on the labeler. Boxing and naming are two separate passes
over the frames, box mode and then identify mode, and each has a rate of its own. To know
yours, label a few frames in each pass and run `report_throughput.py` on the set. It reports
boxes and identities for each active hour from your own timing log.

## Files in this folder

| File | What it is |
| --- | --- |
| `serve.py` | the server |
| `labelcore.py` | the label format's rules: validation, geometry, modes and roles |
| `labelfiles.py` | how the tool reads a sample and a label set from disk: one reader for the server, the project's screen and the export |
| `project.py` | what a project holds, worked out from its files: its locations, its role, how far each pass is |
| `index.html`, `sources.js`, `sources.css` | the labeling page |
| `hub.html`, `hub.js`, `hub.css` | the start screen and the project's screen |
| `theme.css` | the page's look: colors, spacing and corner radii, in one place |
| `boxgeom.js`, `boxsize.js`, `labeltools.js`, `snap.js`, `quadsnap.js`, `picker.js`, `names.js`, `filters.js`, `centergeom.js`, `verifycore.js`, `timinglog.js`, `uistate.js`, `hubstate.js`, `keyroute.js`, `savegate.js` | the pages' helpers, each tested under Node |
| `make_sample.py`, `decklist_from_text.py` | prepare a sample and deck lists |
| `export.py` | the COCO export and the manifest export |
| `make_repeat_set.py`, `compare_repeat.py`, `report_throughput.py` | checks on the labeling |
| `make_toy_data.py` | the toy game for trying the tool |
| `test_*.py`, `test_*.js` | the tests |

## Tests

Paste this into the terminal, from the repository's root:

```
python3 -m unittest discover -s labeler
```

This runs everything, the JavaScript tests included when `node` is installed (they are skipped
without it). The tests use made-up cards and frames generated on the spot, write only to
temporary folders, and start the real server on a free port to check that the page loads.

## Good to know

- One person, one browser tab per server. Two tabs on the same set overwrite each other.
- A tab left open while the tool is switched to another pass, or stopped and started again:
  on the same sample, labels folder, pass and role, the tab goes on and saves what waited in it.
  On anything else, the tab saves nothing more: with nothing waiting it loads again as what the
  tool runs now, and else it says which frames were not saved and how to save them (switch the
  tool back to that pass from the project's screen in another tab).
- Started in this repository's own checkout, the tool makes the toy example under `work/`,
  which git ignores. The commands of this guide write there too.
- A frame whose picture does not load cannot be labeled or marked done, and nothing is saved
  for it until the picture loads.
- The server binds `127.0.0.1` and has no login. Do not expose its port to a network. It
  answers a request only when its `Host` header is `127.0.0.1:<port>` or `localhost:<port>`.
  A request that changes anything (a save, a start or a switch of a pass, the toy example, an
  export) must be a POST
  with `Content-Type: application/json`, and when the browser names the page it comes from,
  that page must be the tool's own. It sends no CORS header. So another site open in your
  browser can neither read from the tool nor make it write. A link on another site that
  leads to a project's address ends on the start screen, and remembers nothing.
- From the page, the tool reads the path you give it and says what it found. It reads only a
  regular file of at most 20 MB there (a sample, a catalog, a suggestions file, a deck
  list); a start with flags reads a file of any size. It lists no folder, and its search for
  samples stays in the folder it was started in.
- The server prints one line per request; set `LABELER_QUIET=1` in its environment to silence
  that. The page asks the server every few seconds whether it still runs; those requests are
  left out.
- A label file records the names of the files it was made with (a deck list, a pre-fill file)
  and their checksums, never their full paths, so a labels folder can be shared as it is.
- Cards are taken to have the standard 63 × 88 mm shape when a quad's foreshortening is
  measured. Nothing else depends on the card's size.
