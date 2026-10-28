<!-- SPDX-License-Identifier: Apache-2.0 -->

# A refresh rule: the template

A product that serves its release from a host of its own keeps adding cards after launch. The
detector, the recognizer and the accept rule stay as they are; the bank gains rows at its end
and the catalog gains entries. Before such a candidate takes the place of the live release, two
questions need an answer. Gate R: is every hover that used to be right still right? Gate N: are
the added cards recognized roughly as often as cards that were left out of training? A
**refresh rule** fixes, while none of the added cards' data exists yet, how each question is
answered. `cardvision refresh` applies it.

The rule is for bank refreshes only. Swapping a model or the accept rule, or embedding an
existing card again, makes a model release instead: preconditions P1 or P2 catch it, and it is
measured again on held-out data, outside this rule.

## The procedure

1. **Write it first.** Fill in the text below on development data, before you have looked at
   any card of the update it will judge. Every data set and every number is named.
2. **Make every gate trip once.** Before freezing, show each gate failing on purpose: for R, a
   made-up card that carries an existing card's vector; for N, the old bank judged as if it were
   the candidate; for INVALID, an altered input or a run left out; for the cumulative limit, if
   present, two small steps that only fail together. Also show a rehearsal passing: cards the
   base already has, taken out and put back. Section 8 records the commands and figures. A gate
   nobody has seen fail is not known to work; section 7 says what would make it fail for real.
3. **Review and sign-off.** Someone other than the author reads the rule and its evidence, and
   the maintainer of the product signs it off. Limits come from the rehearsals plus headroom,
   never from a result of the update they judge.
4. **Freeze.** Store the rule's SHA-256 next to it, in a file with the rule's name and the
   suffix `.SHA256` (`RULE.txt` gets `RULE.SHA256`):

   ```
   shasum -a 256 RULE.txt > RULE.SHA256
   ```

   `cardvision refresh verdict` stops with exit 3, judging nothing, when the hash no longer
   matches or the PARAMETERS line breaks the schema below. Once frozen, the file never changes;
   one changed byte and it is void. A different rule is a new file and goes through steps 1–4.
5. **Apply it.** For every update, in this order: `refresh check` for the preconditions; the
   replay runs and their `refresh diff` files; `refresh verdict replay`; the scenes of the added
   cards (`refresh subset`, then `make-composites`) and their runs; `refresh verdict newcard`.
   The update goes out only when both gates say PASS.

## The commands

```
cardvision refresh check CANDIDATE/release.json --base LIVE/release.json --live-config SETTINGS.json --bundled-id 0123456789abcdef --editable name --json CHECK.json
cardvision refresh diff LIVE_RUN CANDIDATE_RUN --json REPLAY/diff-real.json
cardvision refresh verdict replay REPLAY --rule RULE.txt
cardvision refresh subset CANDIDATE/catalog.json ADDED/catalog.json --new-vs LIVE/catalog.json
cardvision make-composites --catalog ADDED/catalog.json --art ART --out NEWCARD/scenes --n 150 --seed 12345 --split val
cardvision refresh verdict newcard NEWCARD --rule RULE.txt
```

`check` exits 0 only when every check it ran holds. Its JSON says whether the candidate is
**bank-only**: P0 was checked, no catalog entry was edited and the near-duplicate report listed
nothing. A product's runbook can use that to decide who publishes. `--live-config` reads the
settings file the extension reads (P0: the base must be the release it names, or `--bundled-id`
when it names none; `--bundled-id` needs `--live-config`). Without `--live-config`, P0 is listed
as not checked and the candidate is never bank-only. `--editable` names the catalog fields an
existing entry may change; `--near` sets the cosine of the near-duplicate report (default 0.90);
`--duplicate-vectors` says what an added row whose vector repeats another row's means (P2):
`refuse`, the default, for games whose new cards always bring new pictures, where a repeat is a
placeholder or a copied image; `same-identity` for games that reprint a card under a new id with
the same picture, where a repeat inside one identity is expected and a repeat across identities
is still refused; `report` to list repeats without failing, for a game where the identity
groups cannot tell those cases apart and a person looks at the list. The output records the mode
and every repeated pair.
With `--geometric`, `--base-geometric` adds the checks of the optional geometric stage. `diff`
takes `--exclude-truth-prefix` or `--exclude-truth-ids` for rehearsals only. `verdict` exits 0
PASS, 1 FAIL, 3 INVALID, and writes `VERDICT-R.json` or `VERDICT-N.json` into the folder it
judged. A missing or oddly shaped input is INVALID; a folder that does not exist is INVALID and
gets no file; a verdict file that cannot be written turns the verdict into INVALID.

What `verdict` reads, for one arm (with arms, every name ends in `-<arm>`):

| Gate | File | Written by |
| --- | --- | --- |
| R | `diff-<dataset>.json` | `refresh diff --json` on the live and the candidate run of the dataset |
| R | the canary file (with `canary`) | the product's replay script: `{"ok": true}` when the baseline release, run again in this session, gives its pinned events |
| R | `<baseRun>/evaluate-hover.json`, `diff-cum-<dataset>.json` (with `cumulative`) | `evaluate hover --out`; `refresh diff` of the baseline run against the candidate |
| R | the runs named by `realFacesBySource` | `evaluate hover --out` |
| N | `scenes/manifest.json`, `scenes/labels.jsonl` | `make-composites` on the subset catalog |
| N | `cand/`, `old/` | `evaluate hover --scenes --out`: the candidate; the live bank with the candidate's catalog |
| N | `newcard.referenceDir` (next to the rule) | the same scene recipe on cards kept out of training, scored with the live release, frozen with the rule |

## The PARAMETERS schema, `refresh-rule/1`

The rule ends with `PARAMETERS: ` and one line of JSON. The schema is
`cardvision/refresh/rule_schema.json`. Its keys:

| Key | Required | Meaning |
| --- | --- | --- |
| `schema` | yes | `"refresh-rule/1"` |
| `datasets` | yes | gate R's development sets, in the order they are judged (lowercase names; `canary`, `drawn` and `runs` are taken) |
| `validity` | yes | for each dataset, `minCompared` and `minFaces`; fewer means INVALID |
| `regressions` | yes | for each dataset, the step limits `maxEvents`, `maxNamedRightDropPt`, `maxWrongOfShownRisePt` |
| `newcard` | yes | gate N, below |
| `arms` | no | configurations run on every dataset, for example with and without an optional stage; each limit holds for each arm (same naming rules as datasets) |
| `canary` | no | `{"file": "CANARY.json"}`: without `"ok": true` in that file, gate R is INVALID |
| `cumulative` | no | `baselineRelease` (an id), `baseRun` (the run folder that names the live release), `regressions` (per dataset): when the live release is not the baseline, the candidate must also stay within these limits against the baseline, so small losses cannot pile up across updates |
| `realFacesBySource` | no | `minFaces` and `sources`; each source adds up the readable faces of its `runs` over every source type listed in its `types` (exact names) or beginning with one of its `prefixes` (one of the two at least); below `minFaces`, INVALID |
| `tolerancePt` | no | slack in points on the rate limits, for rounding (default `1e-9`; `0` compares exactly) |
| `rehearsalEnv` | no | the environment variable that marks a rehearsal (default `REFRESH_REHEARSAL`; `verdict --rehearsal` has the same effect) |

`newcard` holds `seed` and `scenes` (the scenes must have been generated with both),
`minDrawnShare` (how many of the added cards must appear in some scene), `minNewCards`
(default 1), `maxEventCountDiffShare` (how far the candidate's event count may stray from the
reference's), `maxNamedRightBelowRefPt` (N1), `maxWrongOfShownAboveRefPt` (N2), `referenceDir`
(relative to the rule's folder; `{arm}` becomes the arm's name) and `n3`:

- `"fewerWrong"`: N3 holds when the candidate gets strictly fewer faces wrong than the old bank.
- `"notWorseOneBetter"`: N3 holds when the candidate gets no fewer faces right and no more
  wrong, and improves at least one of the two. Meant for games whose updates bring new artwork
  for cards the live bank already knows: the old bank may name those correctly already, and
  demanding strictly fewer wrong would reject a good update.

An example, with made-up numbers (yours come from your own rehearsals):

```json
{"schema": "refresh-rule/1", "datasets": ["real", "generated"], "validity": {"real": {"minCompared": 300, "minFaces": 200}, "generated": {"minCompared": 2000, "minFaces": 1800}}, "regressions": {"real": {"maxEvents": 0, "maxNamedRightDropPt": 0, "maxWrongOfShownRisePt": 0}, "generated": {"maxEvents": 8, "maxNamedRightDropPt": 0.2, "maxWrongOfShownRisePt": 0.12}}, "canary": {"file": "CANARY.json"}, "cumulative": {"baselineRelease": "0123456789abcdef", "baseRun": "base-generated", "regressions": {"real": {"maxEvents": 0, "maxNamedRightDropPt": 0, "maxWrongOfShownRisePt": 0}, "generated": {"maxEvents": 20, "maxNamedRightDropPt": 0.5, "maxWrongOfShownRisePt": 0.35}}}, "realFacesBySource": {"minFaces": 50, "sources": {"client": {"runs": ["base-real"], "types": ["digital/client"]}, "table": {"runs": ["base-real"], "prefixes": ["physical"]}}}, "newcard": {"seed": 12345, "scenes": 150, "maxEventCountDiffShare": 0.03, "maxNamedRightBelowRefPt": 8, "maxWrongOfShownAboveRefPt": 2, "minDrawnShare": 0.85, "referenceDir": "newcard-ref", "n3": "notWorseOneBetter"}}
```

## The rule text

Copy it, replace every `<...>`, drop the parts that do not apply (and their keys in
PARAMETERS), and keep the eight numbered sections in order.

```text
<PRODUCT>: RULE FOR ADDING CARDS TO THE BANK (<what it decides>)
Written <date> by <author>, on development data, before any card of the update was looked at.
Read by <reviewer>; signed off by <maintainer>. The file's SHA-256 is stored in <RULE>.SHA256,
and cardvision refresh verdict will not judge with a file that no longer hashes to it.

1. QUESTION
   Can the candidate (the live release with the added cards at the end of its bank and catalog)
   take the live release's place? "Live" means the release named by the settings file users
   read, or the release shipped inside the extension, <id>, while that file names none.
   Both gates must pass. Gate R: hovers that worked keep working. Gate N: the added cards are
   recognized about as often as cards that training never saw.
   Outside this rule: any change of model or accept rule, and any card embedded a second time.

2. PRECONDITIONS (cardvision refresh check; one failure makes the whole run INVALID, unscored)
   P0 The live release is the base (--live-config, with --bundled-id when it names none).
   P1 The candidate's models and accept rule are the base's, byte for byte; every other
      settings block matches.
   P2 Existing bank rows are untouched and keep their order; new rows only follow them, one for
      each added catalog entry that has an image; no added row repeats another row's vector.
   P2b Reported, not checked: added rows closer than <cosine> to a card of another identity.
      Any listed row means the candidate is not bank-only and <who> publishes it.
   P3 Every existing catalog entry is still there and changes only in <fields, or not at all>;
      an added printing points at a root and lands in its card's identity; existing identities
      neither merge nor split.
   P4 verify-release accepts both releases <and the geometric checks hold, if any>.
   P5 The pinned inputs still hash to <hash file>; the environment is <how it is pinned>. Live
      and candidate are run back to back, on one machine, in one environment. <Canary, if any.>

3. DATA (development sets only; pinned by <hash file>)
   <dataset>: <what it holds, how it was made or labeled, its events and readable faces>.
   Never used here: <each held-out or test set, by name>.

4. GATE R (cardvision refresh diff for each dataset, then cardvision refresh verdict replay)
   The live release and the candidate run on <datasets> <and arms> with evaluate hover <and the
   bootstrap settings>; refresh diff pairs their events by key. A face counts as right, wrong or
   empty; a back or an off-card point counts as showing a name or not; an "adjacent" name is
   treated as empty, and unreadable or unnamed faces are left out.
   Counted against the candidate: a right face that turns wrong or empty; an empty face that
   turns wrong; an empty back or off-card point that starts showing a name. A face that moves
   from one wrong name to another is listed but not counted.
   INVALID when: an event exists in only one run; events were excluded outside a rehearsal;
   fewer events or readable faces than <per dataset> <or per source> were compared.
   PASS when, per step: <for each dataset: counted events, drop in named right, rise in wrong of
   shown>. <The cumulative limits, if any.> Reasons for these limits: <rehearsal figures, headroom>.

5. GATE N (cardvision refresh subset, make-composites, cardvision refresh verdict newcard)
   Scenes: make-composites on a catalog holding only the added cards that have images, --n <n>
   --seed <seed> --split val <and the rest>. Two runs on them: "cand" uses the candidate; "old"
   uses the live bank with the candidate's catalog, which is what users see on these cards now.
   Reference, frozen <date> in <referenceDir>: the same scene recipe built from cards kept out
   of training, scored with the live release: <events, faces, named right, wrong of shown>.
   INVALID when: the seed or the scene count differ; fewer than <minNewCards> added cards, or
   fewer than <minDrawnShare> of them appear in the scenes; cand and old differ in events; the
   event count is further than <maxEventCountDiffShare> from the reference's.
   The gate passes if N1: its named right is no lower than the reference's minus <pt>; N2: its
   wrong of shown is no higher than the reference's plus <pt>; N3: <fewerWrong or
   notWorseOneBetter, and the reason>.

6. OUTCOMES
   Both gates PASS: publish as the runbook says.
   INVALID: repair the input the verdict names and run again; this is neither a FAIL nor a retry.
   FAIL: write down a single remedy first (for instance, drop the added cards behind the counted
   events), then rerun just the gate that failed, once. If it fails again, nothing goes out for
   this update; report the counted events instead. Thresholds, data, seeds, environment and
   settings stay as they are whatever a result shows, and no held-out set is ever scored.

7. HOW EACH GATE TRIPS IN PRACTICE (each one made to trip before freezing, see section 8)
   R: an added card that looks like an existing one, so the existing card's hover abstains or
      flips (<the likely cases for this game>).
   <R cumulative: several updates that each stay inside the step limits but add up past them.>
   N1/N2: card ids wired to the wrong images, images that do not decode, many added cards
      embedding to almost the same vector, a new card frame the recognizer handles poorly.
   N3: added rows that lose to existing cards.
   INVALID: altered inputs or environment, a missing run, events that do not line up, events
      left out when no rehearsal was declared.

8. EVIDENCE BEFORE FREEZING (<date>, <machine and environment>)
   a) Reproduction: <the live release rebuilt to the same bytes; a run repeated, same events>.
   b) Gate R rehearsal: <existing cards taken out and put back; events compared and counted>.
   c) Gate R trip: <a made-up card carrying an existing card's vector; counted events; FAIL>.
   d) Gate N reference: <the figures quoted in section 5>.
   e) Gate N rehearsal: <PASS, with its figures>.
   f) Gate N trip: <the live bank judged as the candidate; FAIL>.
   g) INVALID trips: <a rehearsal folder judged without the switch; the rule with one byte
      changed>.

PARAMETERS: {"schema": "refresh-rule/1", ...}
```
