<!-- SPDX-License-Identifier: Apache-2.0 -->

# A card update for a product's own host

This playbook adds new cards to a browser extension that is already in a store and reads its
release from a host of its own ([docs/remote-releases.md](../docs/remote-releases.md)). The
models and the accept rule stay as they are; the bank and the catalog grow at their end; the
update goes out by moving the settings file's pointer, with no store release. It assumes set-up
done ([setup.md](setup.md)), a host set up as in [docs/cdn.md](../docs/cdn.md), and the rules in
[AGENTS.md](../AGENTS.md).

The commands here are [experimental](../docs/stability.md#experimental). Check each flag
against the installed version's `--help` before the first update.

**Not for:** a new detector, recognizer or accept rule, or a card's image embedded again. Those
make a model release, measured again on held-out data ([measure.md](measure.md)), and shipped
bundled in a store release first.

## Who does what

Steps marked **(maintainer)** need the product's maintainer: say what you need and wait.

- **The first two pointer moves of a product.** The first points at the release the store
  build already bundles (nothing is downloaded: it proves the path). The second is the first
  real update. The maintainer publishes both.
- **Any update that is not bank-only** (`refresh check` says `"bankOnly": false`): a near
  duplicate reported, a catalog entry edited, a model or the accept rule changed. Also every
  rollback, and every change of `namesOnly` or `primary`.
- **The eye check** of each update: a handful of the new cards' images, looked at by a person.

You publish one of the other updates only when the maintainer has told you, in this session,
that you may publish that kind of update, and every one of these holds (tell them the same day):
- the first two moves are done;
- `refresh check` says `"ok": true` and `"bankOnly": true`;
- both gates say PASS under the frozen rule;
- `cardvision cdn publish-release --dry-run` is clean and `verify-release-live` passes;
- the maintainer answered the eye check with OK.

Otherwise stop and ask the maintainer, as [AGENTS.md](../AGENTS.md) says, and publish nothing.

## Names used below

```
LIVE=...      # the live release's folder as you kept it: the previous update's $UPD/cand, or for the
              # first update the folder the store build's bundled release was built in. A copy
              # fetched from the host will not do: it has no accept.json
LIVE_GEO=...  # geometric stage only: the live geometric settings, the previous update's $UPD/geo/geo.json
LIVE_BANK="$LIVE/bank.json"   # or "$LIVE/bank.bin" when the live release's bank is binary
UPD=...       # this update's folder, outside the repository: a new one for every update
IMAGES=...    # the card images folder; catalog art paths are relative to it
RULE=...      # the frozen refresh rule (RULE.txt, with RULE.SHA256 beside it)
REPO=...      # the product's repository (it holds cdn/cdn.config.json, cdn/config.json, release-legal/)
ENV=...       # the product's environment file (docs/cdn.md, "The environment"); never print it
```

Keep `UPD` whole after the update: it is the record of what went out, and the next update's
base.

## 1. Decide

**1.1 The rule.** A refresh rule must exist before the update's data is seen: written from
[docs/refresh-rule-template.md](../docs/refresh-rule-template.md), every gate made to trip
once, signed off by the maintainer and frozen by its SHA-256. If there is none, stop: writing
one is its own task, and the maintainer signs it off.

```
(cd "$(dirname "$RULE")" && shasum -a 256 -c "$(basename "${RULE%.txt}").SHA256")
```

- **Expect:** `RULE.txt: OK`. A changed rule is void: stop and tell the maintainer.

**1.2 The environment.** The rule names how runs are pinned (toolkit version, Python
environment, inputs). Check each as it says, and run the live and the candidate on one machine,
in one environment, one after the other.

**1.3 The live pointer and the base.**

```
cd "$REPO"
mkdir -p "$UPD/cand"
cardvision cdn verify-release-live --env-file "$ENV"
cp cdn/config.json "$UPD/live-config.json"
```

- **Expect:** the live pointer's id is `LIVE`'s (`release.json`'s `id`), or the settings file
  has no `release` and `LIVE` is the bundled release. The repository's `cdn/config.json` must
  be the one that is live; if `verify-release-live` and the file disagree, stop.

## 2. Data

**2.1 The new cards (maintainer).** The card list and the images come from the maintainer,
from a source they are entitled to use. Never download card art yourself. A set is added once
its official list is out; nothing provisional.

**2.2 The candidate catalog.** Make the folder if it is not there (`mkdir -p "$UPD/cand"`), then
add the new cards' entries at the end of `LIVE/catalog.json`, with their art paths under
`IMAGES`, into `$UPD/cand/catalog.json`. Existing entries stay byte
for byte; a printing points at its card as the catalog's identity rule says.

```
cardvision check-catalog "$UPD/cand/catalog.json" --art "$IMAGES"
```

- **If an existing entry must change** (a rename, an erratum): the update is not bank-only;
  tell the maintainer before going on.

**2.3 The eye check (maintainer).** Copy a handful of the new cards' images (spread through the
set, plus both cards of any near duplicate `refresh check` reports later) to a folder the
maintainer can open, with a note: is each the right card, the expected language and layout,
real art and not a placeholder? Wait for OK.

**2.4 Bank and release.**

```
mkdir -p "$UPD/cand"
cardvision build-bank --catalog "$UPD/cand/catalog.json" --art "$IMAGES" \
    --recognizer "$LIVE/recognizer.onnx" --base "$LIVE_BANK" --out "$UPD/cand/bank.json"
cardvision check-refresh "$LIVE_BANK" "$UPD/cand/bank.json"
cardvision check-bank-art "$UPD/cand/bank.json" --catalog "$UPD/cand/catalog.json" --art "$IMAGES"
cp "$LIVE/detector.onnx" "$LIVE/recognizer.onnx" "$LIVE/accept.json" "$UPD/cand/"
cardvision build-release --detector "$UPD/cand/detector.onnx" --recognizer "$UPD/cand/recognizer.onnx" \
    --bank "$UPD/cand/bank.json" --catalog "$UPD/cand/catalog.json" --accept "$UPD/cand/accept.json" \
    --out "$UPD/cand/release.json"
cardvision verify-release "$UPD/cand/release.json"
```

- **Expect:** `check-refresh` reports every old row byte-identical, none embedded again, and
  identity groups that only grew; `verify-release` ok. Note the new id as `ID`.
- **If a row is embedded again:** stop. That is not a card update.

**2.5 Preconditions.**

```
cardvision refresh check "$UPD/cand/release.json" --base "$LIVE/release.json" \
    --live-config "$UPD/live-config.json" --json "$UPD/check.json"
```

Add `--bundled-id ID` when the live settings name no release, `--editable FIELDS` when the rule
allows edits, and for a product with the geometric stage, after step 3.1,
`--geometric "$UPD/geo/geo.json" --base-geometric "$LIVE_GEO"`. The candidate's settings must be
`$UPD/geo/geo.json`, whose index is the file beside it with `packed/` next to it, not
`$UPD/geometric.json`, whose index is an address on the host.

- **Expect:** exit 0 and `"ok": true`. Any check false makes the update INVALID: fix the step it
  names and run it again; do not score.
- **Read `"bankOnly"`.** `false` sends publishing to the maintainer (near duplicates are listed
  with their pair: show both pictures).

## 3. The geometric index (only for a product with the stage)

**3.1 Build, pin and pack.** Start from a copy of the live geometric settings,
`$UPD/geo/geo.json`; `--pin` sets its `index` to the new index file beside it.

```
mkdir -p "$UPD/geo" && cp "$LIVE_GEO" "$UPD/geo/geo.json"
cardvision build-features --config "$UPD/geo/geo.json" --catalog "$UPD/cand/catalog.json" --art "$IMAGES" \
    --bank "$UPD/cand/bank.json" --out "$UPD/geo/index.features.json" --pin
cardvision pack-features --index "$UPD/geo/index.features.json" --config "$UPD/geo/geo.json" --out "$UPD/geo/packed"
shasum -a 256 "$UPD/geo/packed/manifest.json"
```

- **Expect:** `round trip: ok`; the manifest's `bank.sha256` is the SHA-256 of
  `$UPD/cand/bank.json`; its card count is the bank's; the settings are the live ones apart from
  `index`. Note the manifest's SHA-256 as `MANIFEST_SHA`.
- **Know:** `cardvision cdn publish-geo` writes a flat folder, so pack without `--base`.
  `build-features --base` may save time; it writes the same bytes.

**3.2 The pointer's settings file.** Copy `$UPD/geo/geo.json` to `$UPD/geometric.json` and set
its `index.path` to the manifest's address on the host,
`https://cdn.example.org/vision/geo/<first 16 hex of the manifest's source.sha256>/manifest.json`.
Leave `index.sha256` as `--pin` wrote it.

## 4. Gate R: the replay

The rule names the development sets and arms. For each, score the live and the candidate
release on the same inputs, then compare them event by event:

```
cardvision evaluate hover --scenes DEV_SCENES --release "$LIVE/release.json" --out "$UPD/replay/live-generated"
cardvision evaluate hover --scenes DEV_SCENES --release "$UPD/cand/release.json" --out "$UPD/replay/cand-generated"
cardvision refresh diff "$UPD/replay/live-generated" "$UPD/replay/cand-generated" --json "$UPD/replay/diff-generated.json"
cardvision refresh verdict replay "$UPD/replay" --rule "$RULE"
```

Use `--manifest FILE --frames DIR` instead of `--scenes` for a labeled set of real frames, and
the bootstrap, seed and geometric options the rule names. Add the files the rule asks for
(a canary, a cumulative run) as its template's table says.

- **Expect:** `"verdict": "PASS"`, exit 0.
- **Data:** development sets only. Never a held-out or test set.

## 5. Gate N: the new cards

```
mkdir -p "$UPD/newcard"
cardvision refresh subset "$UPD/cand/catalog.json" "$UPD/newcard/catalog.json" --new-vs "$LIVE/catalog.json"
cardvision make-composites --catalog "$UPD/newcard/catalog.json" --art "$IMAGES" --out "$UPD/newcard/scenes" \
    --n SCENES --seed SEED --split val --check
cardvision evaluate hover --scenes "$UPD/newcard/scenes" --release "$UPD/cand/release.json" --out "$UPD/newcard/cand"
cardvision evaluate hover --scenes "$UPD/newcard/scenes" --detector "$LIVE/detector.onnx" \
    --recognizer "$LIVE/recognizer.onnx" --bank "$LIVE_BANK" --catalog "$UPD/cand/catalog.json" \
    --accept "$LIVE/accept.json" --out "$UPD/newcard/old"
cardvision refresh verdict newcard "$UPD/newcard" --rule "$RULE"
```

`SCENES` and `SEED` are the rule's. `cand` is the candidate; `old` is the live bank with the new
catalog, which is what installs show on these cards today. With arms, each run's folder ends in
`-<arm>`.

- **Expect:** `"verdict": "PASS"`, exit 0.

**Outcomes, both gates.** INVALID: repair the input the verdict names and run again; it is
neither a FAIL nor a retry. FAIL: write down one remedy first (for example, leave the new cards
behind the counted events out of the bank: their catalog art set to `null`, then steps 2.4 to 5 again),
and rerun only the gate that failed, once. A second FAIL: publish nothing for this update, and
tell the maintainer. Thresholds, data, seeds and settings never change after a result.

## 6. Publish

Run from `REPO`, with every step's dry run first. **(maintainer)** for the first two moves and
any update that is not bank-only; otherwise as the maintainer has allowed (above).

**6.1 Legal files.** Copy `release-legal/` (`LICENSE`, `NOTICE`, `PROVENANCE.md`) to
`$UPD/legal`, put `ID` on `NOTICE`'s first line, and say in `NOTICE` and `PROVENANCE.md` what
this update added (cards, their source and date; models unchanged). Do not reword sentences
the maintainer approved.

**6.2 The release folder,** named after its id:

```
mkdir -p "$UPD/rel" && cp -R "$UPD/cand" "$UPD/rel/$ID"
```

**6.3 Pictures.** Only the new cards' images are new; none is changed.

```
cardvision cdn plan --offline --catalog "$UPD/cand/catalog.json" --images "$IMAGES"
cardvision cdn publish --env-file "$ENV" --catalog "$UPD/cand/catalog.json" --images "$IMAGES" --dry-run
cardvision cdn publish --env-file "$ENV" --catalog "$UPD/cand/catalog.json" --images "$IMAGES"
cardvision cdn verify --env-file "$ENV"
```

- **Expect:** the dry run lists the new paths as new and 0 changed; both exit 0. Do not publish
  `config.json` here.

**6.4 The index** (geometric stage only; before the release, which checks it is there):

```
cardvision cdn publish-geo --env-file "$ENV" --dir "$UPD/geo/packed" --expect-sha256 "$MANIFEST_SHA" --dry-run
cardvision cdn publish-geo --env-file "$ENV" --dir "$UPD/geo/packed" --expect-sha256 "$MANIFEST_SHA"
cardvision cdn verify-geo --env-file "$ENV" --dir "$UPD/geo/packed" --expect-sha256 "$MANIFEST_SHA"
```

Older folders stay: a rollback and older installs need them.

**6.5 The release and the pointer.** `MINV` is the live pointer's `minimumExtensionVersion`,
else the first version of the product that reads a pointer.

```
cp "$UPD/live-config.json" "$UPD/config.json"
cardvision cdn publish-release --env-file "$ENV" --release "$UPD/rel/$ID" --legal "$UPD/legal" \
    --min-version "$MINV" --config "$UPD/config.json" --set-pointer --dry-run
```

Add `--geometric "$UPD/geometric.json" --geo-manifest-sha256 "$MANIFEST_SHA"` for the stage, a
`--data-file` for each data file the product publishes with a release, and `--sessions` when the
tool asks for it.

- **Expect:** the seal, the runtimes, the remote state and the pointer it would write, exit 0.
  For a maintainer step, show them this output and wait for OK.

Then the same command without `--dry-run`, and:

```
cardvision cdn verify --env-file "$ENV"
cardvision cdn verify-release-live --env-file "$ENV" --expect-id "$ID"
```

- **Expect:** both exit 0. Copy `$UPD/config.json` to the repository's `cdn/config.json` and
  commit it, signed off by the maintainer (`git commit -s`). An update never moves the
  extension's version.

## 7. Check

After the pickup time (the extension's settings read interval plus the file's 5-minute cache):

- `cardvision cdn verify-release-live --env-file "$ENV" --expect-id "$ID"` and `verify` again.
- **(maintainer)** for the first two moves and any update that was not bank-only: one hover on
  a new card in a real video. Other updates: the product's own smoke check of a page that loads
  the live pointer, if it has one.

## Rollback (maintainer)

Prepare it; the maintainer runs it.

```
cardvision cdn publish --env-file "$ENV" --config "$UPD/live-config.json" --dry-run
cardvision cdn publish --env-file "$ENV" --config "$UPD/live-config.json"
cardvision cdn verify --env-file "$ENV"
cardvision cdn verify-release-live --env-file "$ENV" --expect-id PREVIOUS_ID
```

- `live-config.json` is the settings file as it was before this update. Without a `release`
  field, installs return to their bundled release.
- `publish --config` checks the release it names live before writing it, so a rollback is
  checked too. Folders are never deleted.
- Faster stops, maintainer only: `namesOnly: true` (names, no pictures) or `primary: null`.
- The next update starts from the release the settings file names after the rollback.

## Notes

1. Record the update: date, base id, new id, the SHA-256 of `release.json` as served, the
   index manifest's SHA-256, the verdicts, `bankOnly`, and who published.
2. Tell the maintainer the same day: what was added, what was left out and why, the eye check.
3. The next store build bundles the release the pointer names then, so that a fresh install
   downloads nothing.
4. Accuracy figures that describe the models stay as they are: the models did not change.
   The gates are the update's check, not a new figure.

## Stop conditions

- The rule file, a pinned input or the environment changed: INVALID, stop.
- `refresh check` says `"ok": false`: fix the named step, or stop. `"bankOnly": false`: the
  maintainer decides.
- Gate R or N fails twice: publish nothing; tell the maintainer.
- The card source answers with errors or a rate limit: stop; never retry in a loop.
- `cardvision cdn` refuses (exit 3): read the reason and never work around a check. A folder
  with other bytes, or an index that is not bound to the bank: tell the maintainer.
