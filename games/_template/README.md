<!-- SPDX-License-Identifier: Apache-2.0 -->

# Template for another game

**If your card list is a spreadsheet,** export it as CSV and let `cardvision import-catalog`
write the catalog: `cardvision try` runs it with the rest of the path
([docs/your-game.md](../../docs/your-game.md)), step 1 there runs it alone, and
[docs/commands.md](../../docs/commands.md#cardvision-import-catalog) has every option.
`cards.example.csv` here shows the columns it knows by their headers: `id`, `name`, `kind`,
`printing_of` and `image` (and the usual other names, such as `Card No.` or `Picture`); any
others become filters (`--facets`) or go to each card's `extra`, and `--map id=HEADER` names a
column under a header it does not know.

**To write the catalog by hand,** copy this folder into a folder of your own and fill in
`catalog.json` there. Copy it into a new folder, not into one that an import writes its
catalog into:

```
cp -r games/_template /path/to/my-game
```

**Your game's folder does not go into this repository's `games/`.** Keep it in a work folder
outside the checkout, or in a repository of your own (a fork counts, in a folder of its own).
Other games' catalogs, banks and weights are not taken into this repository; see
`CONTRIBUTING.md`. The commands below write `MY-GAME` for the path of your folder.

The catalog is the one file a game has to supply. `cardvision/core/catalog.py` documents
the format and checks it, and reports the first problem by card id and position.

## Decide what counts as the same card

Do this before you write a name. The tools have to know which entries are one card: naming
one of them for another is then right, and two of them scoring alike is not doubt. The
catalog states the rule in an optional top-level `identity`, beside `game` and `locale`.

- `"identity": "name"`, or no `identity` at all: entries with exactly the same `name` are one
  card. Use it when a name is one card in your game and its printings differ only in their
  picture. Example: `First Example Card` in two sets, with two pictures, is two entries with
  one name, and either answer is right for either.
- `"identity": "printing"`: an entry whose `printingOf` is `null` is a card of its own, and
  every entry whose `printingOf` is that entry's id is the same card. The same name joins
  nothing. Use it when different cards share a name in your game. Example: two cards are both
  called `First Example Card`, with their own ids, and each has an alternate printing. That is
  four entries: the two cards with `"printingOf": null`, and each alternate with the id of its
  own card. One `First Example Card` shown for the other is then a wrong answer. Under this
  rule a printing must point straight at its card: a printing of a printing is refused.

How to choose: two entries that a player would call different cards must be different
identities. If any name in your card list belongs to more than one such card, state
`"printing"`. Do not change a name to tell cards apart, by adding an id to it for instance:
the name is what a viewer is shown, and the id is reported beside it.

## Filling in the catalog

`game` is a short name for the game and `locale` the language of the card names (`en`, `fr`,
...). `cards` lists every card to recognize, in the order you want its rows to have in a bank.
The two entries in the template are placeholders; replace them. Each card has:

- `id`: unique, and what every tool reports. Use the game's own collector ids if it has them. It
  is 1 to 64 characters with no space or other whitespace and no control character in it.
  An id of the plain form `SET-123` is preferred over other forms (`SET-123A`, `SET-P01`) as
  the representative of its identity. Under `"identity": "printing"` the card the others are
  printings of represents them.
- `name`: the card's name. Under the default identity rule it is the card's identity: two
  entries with exactly the same name are treated as printings of one card, and recognizing one
  as the other is not an error. Keep
  spelling and punctuation consistent, since names are compared character for character.
- `kind`: a label of your choosing for the card's type (`creature`, `land`, ...), or `null`.
  It is used only by the tools that generate training images.
- `printingOf`: for an alternate printing, the `id` of the card it reprints; otherwise `null`.
  Under `"identity": "printing"` this is what makes two entries the same card.
- `art`: where the card's image is. Either a file path relative to a folder you pass on the
  command line (`SET-001.png`, or `set/001.png`), or a full `http(s)` URL. Any image format
  Pillow reads will do. Use the cleanest, most tightly cropped image of the card you have.
  The image should look like the card as it appears on screen: an overprint, a watermark or a
  border that the real cards do not have is a difference the models have to bridge, and only
  real footage will show how well they do. `null` for a card without art (below).
- `token` (optional): `true` for a card that is made during play and is in no deck. The
  labeling tool lists such cards in a table of their own. Leave it out for every other card.
- `extra` (optional): an object of anything else you want to keep with the card, with keys and
  values of your choosing: its rules text, its rarity, an id from another database.
  `{"text": "Draw a card.", "rarity": "common"}`. Nothing in this repository reads it, so it
  changes no model, bank, identity or answer; it stays in the catalog, and a release pins it
  with the file. It must be an object (`{...}`); any other key on a card is still an error.

A card that has no usable image (none at all yet, only a placeholder, or a vector file) is
listed with `"art": null`: a *card without art*. The key stays; leaving it out is an error.
Such a card keeps its id and its identity, so the labeling tool lists it and a label can name
it. A bank built from the catalog has no row for it (a bank extended from one that had a row
keeps it, and `build-bank` lists that row), so it is never named by its own row; a printing of
it that has art still names its identity. That is better than a row computed from the wrong
picture, which takes names away from other cards. `build-bank` says how many cards
have no art, and `cardvision check-bank-art --catalog MY-GAME/catalog.json --art
/path/to/images`, with no bank, lists them apart from the images that are missing, along with
every image file that different cards share. When the image appears, give the card its `art`
and extend the bank (`build-bank --base`).

A promotional card known by its id and name, with no picture yet, looks like this:

```json
{"id": "SET-P07", "name": "Seventh Promo Card", "kind": "creature", "printingOf": null, "art": null}
```

An alternate printing looks like this:

```json
{"id": "SET-001A", "name": "First Example Card", "kind": "creature", "printingOf": "SET-001", "art": "SET-001A.png"}
```

An optional top-level `kinds` object attaches settings for generated and augmented training
images to your `kind` labels: which kinds are landscape (`landscape`), how often a kind is foil
(`foilProbability`), which kinds carry dice (`dice`), which kinds fill the slots of a generated
game board (`board`), and a kind to give extra training rows (`boost`). The catalog module
documents each; `games/riftbound/catalog.json` has a filled-in example.

## Filters for the labeling tool (optional)

When the labeling tool asks which card a box holds, chips above its card list narrow the list.
The first row, Type, is your `kind` labels. A top-level `facets` list adds a row for each other
property a person would filter by, and each card gives its values under its own `facets`. The
template's `catalog.json` shows it with three facets; delete both `facets` keys if you do not
want them:

```json
"facets": [
  {"key": "color", "label": "Color", "values": ["Red", "Blue", "Green"]},
  {"key": "cost", "label": "Cost", "type": "number"},
  {"key": "set", "label": "Set"}
]
```

```json
{"id": "SET-001", "name": "First Example Card", "kind": "creature", "printingOf": null, "art": "SET-001.png",
 "facets": {"color": ["Red", "Blue"], "cost": 3, "set": "SET"}}
```

- `key` is a lowercase letter followed by letters and digits (`color`, `cost`, `subType`), and
  is not `kind`. `label` is what the row is called on screen.
- `values` (optional) lists the allowed values in the order the chips show them. Without it
  the chips are the values your cards carry: numbers from low to high, text in the order the
  cards first use it.
- `type` (optional) is `"text"` or `"number"`. Without it the facet takes the type of its
  first value. A number facet holds JSON numbers (`3`, not `"3"`).
- A card gives one value, or a list when it has several (a card of two colors lists both).
  A card may leave a facet out. A key that is not declared, a value of the wrong type, a value
  outside `values` and a value listed twice are errors.

Nothing but the labeling tool reads facets: they change no model, bank or measure.

## Then

1. Build a bank from your images, which also writes its identity groups beside it:

   ```
   cardvision build-bank --catalog MY-GAME/catalog.json --art /path/to/images \
       --recognizer recognizer.onnx --out MY-GAME/bank.json
   ```

   Read any lines it prints under `look at these before you rely on the bank:`. They name
   images that look wrong, and cards of different identities whose bank rows are nearly the
   same, which usually means one picture filed under two cards.

2. Write `accept.json` with the accept rule's three settings. `games/riftbound/accept.json`
   shows the shape, and `games/riftbound/README.md` says what reads the file and how strictly.
   The thresholds in it were chosen for that game's models and bank, so treat them as a
   starting point and calibrate your own with `cardvision calibrate`
   ([docs/measure.md](../../docs/measure.md), "Calibrate the accept rule").

3. Put the detector, the recognizer, the bank, its identity groups, the catalog and
   `accept.json` in one folder (subfolders are fine) and pin them together. From a downloaded
   release of another game take the detector, the recognizer and, as a starting point, the
   accept rule, and nothing else: its bank, its catalog, its identity groups and its release
   document belong to that game.

   ```
   cardvision build-release --detector detector.onnx --recognizer recognizer.onnx --bank bank.json \
       --catalog catalog.json --accept accept.json --out release.json
   cardvision verify-release release.json
   ```

When cards are added later, add them to the catalog and extend the bank with
`build-bank --base bank.json` instead of rebuilding it, then run `cardvision check-refresh`
on the old and the new bank.

Before publishing files for a game you do not own, check what its publisher allows you to
redistribute. This repository holds card names and ids only, and no card images.
