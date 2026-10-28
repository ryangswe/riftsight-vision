<!-- SPDX-License-Identifier: Apache-2.0 -->

# Remote releases: the settings contract

A browser extension built on this runtime bundles one release. New cards can reach installed
copies without a store update: the extension's settings file may name another release,
published on the same host, and an install that qualifies loads it instead. This page is that
contract. The browser module `browser/src/remote/` (built to `dist/remote-release.js`) carries
the extension's side, and [`cardvision cdn`](cdn.md) the publishing side.

**Experimental.** The module, the Node tools and `cardvision cdn` may change in a minor
release ([stability.md](stability.md#experimental)).

A release is data only: JSON and ONNX files. Code stays in the extension's package. Anything
wrong with a remote release, at any step, loads the bundled one.

## The settings file

The settings file is `config.json` at the root of the product's own host, for example
`https://cdn.example.org/config.json`. The extension reads it and keeps the last good copy.
How often it reads it, and what the image fields mean for its tooltip, is the product's own
contract. The fields that `cardvision cdn` checks before it publishes the file:

| Field | Rule |
| --- | --- |
| `schemaVersion` | exactly `1`; a later field is added without changing it |
| `updatedAt` | a string (ISO 8601) |
| `namesOnly` | `true` or `false`; `true` shows names and no picture |
| `primary` | `{id, template}` or `null`; the template is an `https://` address under `<public base>/<art prefix>` |
| `fallbacks` | a list of `{id, template}`, may be empty |
| `cardLink` | only for a product with `settings.obsoleteCardLink` ([cdn.md](cdn.md#cdnconfigjson)) |
| `geometric` | `true`, `false` or `null`, for a product with the geometric stage; `false` turns the stage off |
| `release` | the pointer, below; optional |
| a data file's key | `{path, sha256}` of a data file on the host ([cdn.md](cdn.md#data-files-and-pages)) |

A template is an `https://` address with placeholders from the product's list (for example
`{art}`, `{file}`, `{cardId}`). An address that names another project in the product's
`forbiddenWords` is refused. The file is served with `Content-Type: application/json` and
`Cache-Control: public, max-age=300`, with a CORS header.

## The pointer

```json
"release": {
  "id": "0123456789abcdef",
  "path": "vision/releases/0123456789abcdef/release.json",
  "sha256": "<64 hex: the SHA-256 of release.json as served>",
  "minimumExtensionVersion": "1.2.0",
  "geometric": {
    "path": "vision/releases/0123456789abcdef/geometric.json",
    "sha256": "<64 hex: the SHA-256 of geometric.json>",
    "manifestSha256": "<64 hex: the SHA-256 of the packed index's manifest>"
  }
}
```

| Field | Rule | Meaning |
| --- | --- | --- |
| `release` | an object, optional; absent or `null`: no pointer | The release a qualifying install runs instead of its bundled one. |
| `id` | `^[0-9a-f]{16}$` | The release id, the hash of its document (the runtime checks it). |
| `path` | exactly `vision/releases/<id>/release.json` | Resolved against the settings file's address, so always the same host. |
| `sha256` | `^[0-9a-f]{64}$` | The SHA-256 of the document's bytes, checked before the worker starts. |
| `minimumExtensionVersion` | `x.y.z`, required | A running version below it ignores the whole field. |
| `maximumExtensionVersion` | `x.y.z`, optional, exclusive | A running version at or above it ignores the whole field. Leave it out unless a downgrade needs it. |
| `geometric` | an object, optional | The geometric stage for this release ([rules G1 to G3](#rules-g1-to-g3-the-geometric-stage-under-a-release)). Only for a product with the stage. |
| other keys | ignored | Room for later fields. |

`parsePointer` reads the field and `parseGeometricPointer` its `geometric` part. A store build
should bundle the release the pointer names when it is built, so that a fresh install
downloads nothing ([rule 4](#rules-1-to-5-decided-before-any-request)).

## Load sequence

A page decides once, when its compute frame starts (the first hover on a page with card hovers
on; nothing happens at install). If the page removes the frame, a new frame decides again.
`chooseRelease` runs the steps:

1. Read the settings in effect once, and their `release` field (`parsePointer`).
2. Read [the skip-list](#the-skip-list) and clear a stale entry.
3. Apply [rules 1 to 5](#rules-1-to-5-decided-before-any-request). They need no network.
4. Fetch and check the remote release ([rules 6 to 9b](#rules-6-to-9b-fetching-and-checking-the-release)).
5. Build the [card facts](#card-facts) from the catalog the worker will get.
6. Hand the files to the worker. Its answer is handled by
   [rules 10 to 12](#rules-10-to-12-the-workers-answer).

**A page tries the remote release at most once.** Every fallback goes to the bundled release
and never back.

## Rules 1 to 5: decided before any request

`decide` applies them, in this order.

| # | Condition | Outcome | Log reason |
| --- | --- | --- | --- |
| 1 | `release` absent or `null` | bundled | `absent` |
| 2 | malformed (a rule of [the pointer](#the-pointer) broken, `id` not the one in `path` included) | the field is ignored: bundled | `malformed:<key>` |
| 3 | the running version is below the minimum, or at or above the maximum | bundled | `version` |
| 4 | `id` is the bundled release's id | bundled, nothing downloaded | `same-as-bundled` |
| 5 | the skip-list holds this `(id, sha256)` | bundled | `skipped:<reason>` |

Versions compare part by part as numbers (`compareVersions`). The bundled release's id comes
from its document inside the extension (`release/release.json`).

## The skip-list

One entry `{id, sha256, reason, at}` in the extension's local storage under the key
`releaseSkip` (`SKIP_KEY`), or none. While it is there, rule 5 keeps the page on the bundled
release.

- **Recorded** for rules 7, 8, 9b and 11, and for rule 10 only as `refusalRecorded` says: a
  refusal that came before the worker said it was preparing the models. Never for network
  failures (rules 6 and 9), a refusal after that point, the runtime's catch-all reason
  (`unexpected:`), the frame's own errors (a worker that did not start) or a worker crash.
- **Replaced** by a new entry: there is never more than one.
- **Cleared** when the field is absent, when the pointer names another `(id, sha256)` (so that
  a later move back to it is tried again), and on read when it is 24 hours old (`SKIP_TTL_MS`),
  dated in the future or malformed. A malformed field leaves it as it is.

## Rules 6 to 9b: fetching and checking the release

`loadRemoteRelease` fetches from the settings host, with no cookies, no referrer and the
browser's usual cache (`credentials: "omit"`, `referrerPolicy: "no-referrer"`,
`cache: "default"`). The release's files never change, so a later page reads them from the
browser's cache.

| # | Condition | Outcome | Log reason |
| --- | --- | --- | --- |
| 6 | the document: a network error, a non-2xx answer, or 10 s for all of it | bundled | `unreachable` / `http-<n>` |
| 7 | the document's SHA-256 is not `sha256`, after one more fetch past the cache | bundled; skip-listed | `doc-sha` |
| 8 | the document is not JSON, does not pin its five files (each with `path`, `sha256`, `bytes`), its `id` is not `id`, or a pinned path is not a flat name `^[A-Za-z0-9][A-Za-z0-9._-]*$` (or is `release.json`) | bundled; skip-listed | `doc-shape` |
| 9 | a file: a network error, a non-2xx answer, or a stall (30 s with no bytes; no limit on the total) | bundled | `unreachable:<file>` |
| 9b | a downloaded file's size or SHA-256 is not the document's, after one more fetch past the cache | bundled; skip-listed | `file-sha:<file>` |

- **Reading limits.** The document is read no further than 256 KB (`DOCUMENT_MAX_BYTES`), and
  a file no further than its pinned size. A longer body fails its SHA-256.
- **One more fetch.** Before a document or file SHA-256 failure counts, that address is fetched
  once more with `cache: "reload"`: a stale or broken cache entry is not the release's fault.
- **File reuse.** The five pinned files are the detector, the recognizer, the bank, the identity
  groups and the catalog. Each one with the same SHA-256 and size as a file of the bundled
  release is taken from the extension, under the remote document's name. Every other file is
  downloaded from `vision/releases/<id>/<path>`. The runtime checks every file again, reused or
  downloaded. A card-only update reuses both models.
- **Other failures.** A catalog that cannot be read while the card facts are built gives the
  bundled release (`catalog-unreadable`), not recorded. Any other error gives
  `unexpected:<error>`, not recorded.

## Rules 10 to 12: the worker's answer

The product's compute frame owns its worker, so these rules are the product's to apply. The
module gives it `refusalRecorded` (rule 10's skip-list question), `recordSkip`,
`fallbackRequest` and `chosenBeforeFetch`.

| # | Condition | Outcome | Log reason |
| --- | --- | --- | --- |
| 10 | the worker refuses the release | a new worker, bundled; skip-listed only as [the skip-list](#the-skip-list) says | `runtime:<reason>` |
| 11 | the worker loaded another id than the pointer's | that worker ends, a new one loads the bundled release; skip-listed | `id-mismatch` |
| 12 | the worker fails after loading a remote release | its one restart loads the bundled release | `worker-restart` |

The fallback of rules 10 and 11 is a planned replacement, not a restart: the bundled worker
then has its usual budget.

## Rules G1 to G3: the geometric stage under a release

For a product whose releases carry the geometric stage. The stage's settings file
(`geometric.json`) pins the index the stage reads, so a release with new cards needs its own.
The pointer's `geometric` names it. `checkRemoteGeometric` applies G1 and G2 before the worker
sees the release.

| # | Condition | Outcome | Log reason |
| --- | --- | --- | --- |
| G1 | the settings say `geometric: false`, or the build has no stage | remote release, stage off | `geo-setting` |
| G1 | the pointer's `geometric` is absent or malformed | remote release, stage off | `geo-absent` / `geo-malformed:<key>` |
| G2 | `geometric.json` is unreachable or non-2xx (10 s) | remote release, stage off | `geo-unreachable` |
| G2 | it is over 256 KB or its SHA-256 is not `geometric.sha256` | remote release, stage off | `geo-sha` |
| G2 | it is not JSON, or its `index.path` is not a manifest on the settings host's origin at `/vision/geo/<16 hex>/manifest.json` or `/vision/geo/<16 hex>/manifest-<16 hex>.json`, with no user, query or fragment | remote release, stage off | `geo-shape` |
| G3 | the runtime refuses the index (its manifest, the bank binding, a bank card without a row, a shard) | remote release, stage off for the page; never a failed release | `geo-runtime:<reason>` (the product's) |

`index.path` may be relative; it resolves against `geometric.json`'s address.

**Fallbacks and the index cache.** The runtime keeps the index's shards in the browser's cache
and, after a load, deletes what lies outside the loaded manifest's folder. So a page that falls
back from a remote release (rules 6 to 12) loads the bundled release with the stage off, unless
the pointer's `manifestSha256` is the bundled index's (`fallbackRequest`). Otherwise loading
the bundled index would delete the remote one, and the next page would download it again. A
page decided before anything was fetched (rules 1 to 5, `chosenBeforeFetch`) loads the bundled
release with its stage as usual.

### Index folders

An index lives in a folder of its own under `vision/geo/<16 hex>/`, in one of two layouts:

- **Flat:** `manifest.json` and `shard-N.bin`. Written once and never added to.
- **Series:** `manifest-<16 hex>.json` for each version, and shards named by content
  (`shard-<16 hex>.bin`) that keep their names. A later version adds a few shards instead of a
  whole new index (`cardvision pack-features --base`, `--content-names`, `--manifest-name`).

A folder holds one layout only: the cache would keep the other kind's shards. A new folder
starts when the features settings, the OpenCV version or an existing card's art change. Moving
between folders deletes the old folder's cached shards on the first load of the new one.

## Card facts

The tooltip's table of card names is built from the bundled catalog, so a card new in a remote
release would be recognized and then shown as nothing. `chooseRelease` therefore builds the
same table (`buildCardTable`, the build's own rule) from the catalog it hands the worker, before
the load. The frame adopts it only when the worker confirms that release's id.

The table is `{"<card id>": [name, set, art path]}`, with the printed number as a fourth value
when the product asks for it. Names come from the release's own catalog only. How the facts
reach the tooltip is the product's. They must be checked on arrival, and a web page must not be
able to supply them.

## Logging

One line per decision in the compute frame, kept local and never sent:

```
[<Product>] release source=remote|bundled reason=<code> pointer=<id|-> bundled=<id> reused=<k>/5 downloaded=<bytes> ms=<n>
[<Product>] geometric source=remote|off reason=<code> pointer=<id> [manifest=<16 hex>]
```

`decisionLine` and `geometricLine` write them. `downloaded` counts decoded bytes. A line never
holds the page's address, the video, a frame or a card.

## The release folder on the host

`cardvision cdn publish-release` writes it ([cdn.md](cdn.md#publish-release)):

| Key | Content-Type | Cache-Control |
| --- | --- | --- |
| `vision/releases/<id>/release.json`, written last in the folder | `application/json` | `public, max-age=31536000, immutable` |
| `vision/releases/<id>/<detector and recognizer>.onnx` | `application/octet-stream` | the same |
| `vision/releases/<id>/bank.bin`, a bank in binary form (`cardvision convert-release`) | `application/octet-stream` | the same |
| `vision/releases/<id>/<bank, identity groups, catalog>.json`, by the document's own names | `application/json` | the same |
| `vision/releases/<id>/LICENSE`, `NOTICE`, `PROVENANCE.md` | `text/plain; charset=utf-8`, `text/markdown; charset=utf-8` | the same |
| `vision/releases/<id>/geometric.json`, before `release.json` | `application/json` | the same |
| `vision/releases/index.json`, the tool's own record, not part of this contract | `application/json` | `no-cache` |

Every object carries its SHA-256 in its metadata. The whole pinned set is uploaded, even the
files an extension would reuse. A folder is never overwritten or deleted: a changed release is
a new id. Serve JSON compressed: the bank and the catalog are most of a card-only update.

**Pickup.** A running browser sees a pointer move once it reads the settings file again, plus
the file's 5-minute cache. Rolling back is pointing back to an earlier release, or removing
the field.

## What the pins do not guard against

The SHA-256 pins guard against corruption, stale caches and partial uploads. They do not guard
against someone who controls the bucket or the host's zone, who could publish a folder and a
pointer that agree with each other. Such a person can only choose among folders on that host
(the path rule and the extension's content security policy fix the host), and can change data,
never code: scripts and WebAssembly are in the package. Keep the host's tokens narrow (one
bucket, object read and write) and on the maintainer's machine.
