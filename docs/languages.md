<!-- SPDX-License-Identifier: Apache-2.0 -->

# Showing cards in the viewer's language

A card game is often printed in several languages. An extension built on this runtime can
show the hovered card in the viewer's language (its picture, its text, or both) while
recognition stays exactly as it is. This page is a recipe, not a module: the toolkit publishes
and checks the files, and the extension picks what to show. It is written from work on two
extensions built on this runtime, one adding translated card text and one translated card
pictures.

## What changes and what doesn't

- **Recognition doesn't change.** The release, the bank and the catalog stay in one language,
  and recognition names a card by its catalog id as before. Only what the hover shows changes.
- **Each language is a set of files keyed by the catalog's card ids:** a text file, a set of
  pictures with a list of the cards that have one, or both. A card that is not in the catalog is
  never added through a language.
- **What has no translation stays in the catalog's language.** This applies to each part
  separately: a card can show translated text over the original picture.
- **Adding a language later needs no new version of the extension** when it reads languages
  generically; update any store or privacy text that lists the languages. An extension that
  doesn't know about languages ignores the new fields.

## The rules we follow

- **Only the publisher's own art and translations.** No fan translations and no unofficial
  scans. Before a language ships, check a sample from each source word for word against the
  publisher's own wording, and rank the sources by the result. Take each card from the
  best-ranked source that has it. Drop a row your checks can show is wrong (for example, text
  in the catalog's language left inside a translated row) to the next source, or to the
  catalog's language. Differences no check can catch card by card, such as older wording or
  typos, are a reason to rank a source lower, never to patch a card by hand. A publisher's
  database can show a field differently from the printed card (a type line split into an icon
  and a word, for example): compare against what is printed, and note which fields the check
  covered.
- **The language comes from the browser.** There is no setting. Take the first entry of
  `navigator.languages`, keep its base subtag, and fall back to the catalog's language when that
  language isn't offered:

  ```ts
  function viewerLanguage(offered: readonly string[], fallback = "en"): string {
    const first = (navigator.languages || []).find((l) => l) || navigator.language || fallback;
    const base = first.toLowerCase().split(/[-_]/)[0];
    return offered.includes(base) ? base : fallback;
  }
  ```

  `"fr-CA"` gives `fr`. It works the same in Chrome and Firefox. The catalog's own language is
  never one of the offered translations.
- **Credit every source** in the extension's notices and store listing. If a source's license
  is share-alike, keep its data in its own files with that license named inside them, apart
  from the extension's code. Read the publisher's terms for its pictures and text before you
  use them, and don't fetch from a site that blocks automated access. Fetch one request at a
  time with a pause between requests, and stop on a refusal or a rate-limit response. Where a
  site publishes rules for automated access, follow them: name the tool and a contact in the
  User-Agent, stay within its rate, and cache for as long as it asks.

## Publishing with `cardvision cdn`

Each language's files are published like any other data, and the settings file names them by
path and SHA-256 ([cdn.md](cdn.md)). An install only reads data files the settings file
vouches for. Pictures are trusted through the pinned list of which cards have one, not byte by
byte: `cardvision cdn publish` replaces a picture in place under the same path. A product that
wants the picture bytes pinned too can give each picture a content-addressed name (such as
`<id>.<sha8>.webp`), serve it immutable and put the names in the list; that is outside
`cardvision cdn` today.

**Text.** Add one data file kind per language to the CDN config, next to the original:

```json
"dataFiles": {
  "details":   {"prefix": "data/", "namePattern": "details-<sha8>.json",    "schemaVersion": 1,
                "requiredObjectKeys": ["cards"], "maxBytes": 33554432},
  "detailsFr": {"prefix": "data/", "namePattern": "details-fr-<sha8>.json", "schemaVersion": 1,
                "requiredObjectKeys": ["cards", "names"], "maxBytes": 33554432}
}
```

`cardvision cdn publish --data-file details-fr-<sha8>.json` publishes it, and the settings file
names it as `"detailsFr": {"path": "data/details-fr-<sha8>.json", "sha256": "…"}`. Put the
language code and the source's credit inside the file too, so the file explains itself.

To add languages without a new version of the extension, name the settings keys by one pattern
(`detailsFr`, `detailsDe`, …) and have the extension read every key that matches. Put any words
the panel needs (stat labels, headings) in the language's file, so the extension needs no
strings per language. A new language is then its file, one `dataFiles` entry in the CDN config
and its entry in the settings file.

**Pictures.** Publish each language's pictures under a prefix of their own, with a second CDN
config whose `art.prefix` and `art.indexKey` are, for example, `art/fr/` and
`art/fr/index.json`, and a catalog that lists only the cards that have a picture in that
language:

```
cardvision cdn publish --cdn-config cdn/cdn.fr.json --catalog catalog-fr.json --images pictures-fr --dry-run
cardvision cdn publish --cdn-config cdn/cdn.fr.json --catalog catalog-fr.json --images pictures-fr
```

Leave `--config` off that run: the settings file is published once, last, from the main config.
Then publish the list of cards that have a picture in that language as a data file of its own
(for example a kind `artListFr`), so the settings file can pin it by SHA-256. The order matters:
the pictures, then the list, then the settings file that names the list.

`cardvision cdn` checks the data files the settings file names. A product's own fields in the
settings file, such as a template for the localized pictures, are passed through unchecked:
check them in the product's own tests and publish step. Before the settings file goes out, the
publish step should check that the list it names is live with the pinned SHA-256, and refuse
otherwise.

## In the extension

- **The kill switch comes first.** When the settings file turns pictures off (`namesOnly`),
  no localized picture is shown and no list is fetched.
- **Check the list before any request.** The localized pictures go first in the picture
  sources, and a card that isn't in that language's list is skipped there without a request.
  Never find out by trying the URL and falling back on a 404: if the extension switches a source
  off after repeated failures, missing translations would count as failures and switch the
  language off for everyone.
- **Check the hash.** Verify the list's and the text file's SHA-256 against the settings file
  before using them, as for any data file. If the list fails to load or its hash doesn't match,
  show the original language, and don't count it as a source failure either.
- **Drop old pictures when the list changes.** When the settings file names a different list or
  template, clear cached localized pictures before showing new ones.
- **Fall back per part.** A card with translated text and no translated picture shows the
  translated text over the original picture, and the reverse.

## Alternate arts

Card numbers usually match across a game's language editions, but not always for alternate
arts (parallels, reprints with new artwork). The same number in another language can be a
different artwork, so a number alone is not enough. Compare the artwork itself, leaving out the
text box, and match each printing in three steps:

1. **Same number, confirmed by the artwork.** Take the printing with the same number in that
   language when its artwork scores above a high threshold.
2. **Otherwise, search by artwork alone.** This finds art that moved to another number. Accept
   a match only when all three hold: the best score clears a threshold, it beats the runner-up
   by a clear margin, and the match holds both ways (that candidate's own best match is this
   card). The both-ways check stops two near-identical alternate arts from swapping.
3. **Otherwise, leave the card in the original language.**

The number comes first because a publisher often prints the same artwork more than once in a
language (a reprint, a starter-deck copy). Those pictures score almost the same, so a search by
artwork alone sees no clear winner and refuses a correct match. In one game, checking the
number first matched a fifth more printings than artwork alone, and a hand-checked sample had
no wrong pair.

Pick the thresholds from your own game's scores. Compare the highest score any two different
artworks reach with the scores of the same artwork, and put the step 1 threshold between them.
In that game, different artworks never scored above 0.90; the step 1 threshold was set at
0.98, and the same artwork usually scored above it. Same-artwork pairs below it (a slightly
different crop or print) were mostly matched by step 2. Check the match rate on one set before trusting alternate arts for that language at all.

## Upkeep

Each language adds a step to every card update: fetch that set's translations, check them, and
publish the files. Everything above fails toward the original language, so a step that is late
or skipped shows untranslated cards, never broken ones.
