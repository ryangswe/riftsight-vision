<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows the
versioning rule in [docs/stability.md](docs/stability.md). Before 1.0, a minor version may
break the public surface; this file names each break and how to migrate.

## [Unreleased]

## [0.7.0] - 2026-10-31

A release load reports where its time went, so that an extension can see why the first card is
slow on some machine without a patched build. It is release candidate 0.7.0rc2, listed below
it, which split reading the files from fetching them and the providers that failed from the one
that worked; that candidate built on 0.7.0rc1. One sentence of documentation is added: the
load's total also holds the short steps between its parts. Nothing in the public surface breaks.
The contract's `PROTOCOL_VERSION` stays 1. The released models are unchanged: release
`201478a00d6ef6ba`.

### Added

- `loadRelease` reports where a load's time went, in whole ms: `LoadedRelease.timings`
  (`LoadTimings`): `startedAtMs`; `filesMs`, fetching and reading the release document, then
  fetching the files it pins and checking their sizes and SHA-256; `readMs`, reading those
  files (decoding the bank, parsing the catalog and the identity groups, checking that they
  belong together); `recognizer` and `detector` (`ModelLoadTimings`: `createMs`, `firstRunMs`,
  `failedProvidersMs` and `totalMs`); and `totalMs`. `Embedder.setup` and `Detector.setup`
  (`SessionSetup`) hold a model's create and first run. All exported from
  `browser/src/index.ts`.
- The worker passes the timings on in the release status (`release.loadTimings`, optional), so
  an extension reads them in the compute frame (`frame.core?.status().release?.loadTimings`).
  Measured only; nothing decides on them, and nothing in them leaves the compute frame.
- `ReleaseLoadOptions.onFetched`, for `loadReleaseData`: called once every pinned file is
  fetched and checked, before any is read. Advisory: what it throws is ignored.

## [0.7.0rc2] - 2026-10-31

From running 0.7.0rc1 in the first extension: the timings now tell reading the files apart from
fetching them, and the providers that failed apart from the one that worked. No break from
0.6.2; rc1's `filesMs` narrows.

### Changed

- `LoadTimings.filesMs` is now fetching and reading the release document, then fetching the
  files it pins and checking their sizes and SHA-256, only. Reading those files (decoding the
  bank, parsing the catalog and the identity groups, checking that they belong together) is the
  new `LoadTimings.readMs`. On an emulated slow machine 0.7.0rc1's `filesMs` was 5.2 s, of which
  about 3.2 s was this reading, not the files.

### Added

- `ModelLoadTimings.failedProvidersMs`: the time spent on providers tried before the one that
  worked, which failed. When WebGPU is listed first and fails, ONNX Runtime's backend start is
  in it (5.3 s of the recognizer's total on that machine).
- `ReleaseLoadOptions.onFetched`, for `loadReleaseData`: called once every pinned file is
  fetched and checked, before any is read. Advisory: what it throws is ignored.

## [0.7.0rc1] - 2026-10-31

A load reports where its time went, so that an extension can see why the first card is slow on
some machine. Additive only: no change to the contract between the frames (`PROTOCOL_VERSION`
stays 1), nothing in the public surface breaks, and the released models are unchanged.

### Added

- `loadRelease` reports where a load's time went (`LoadedRelease.timings`, `LoadTimings` and
  `ModelLoadTimings`; `Embedder.setup` and `Detector.setup`, of type `SessionSetup`; all
  exported from `browser/src/index.ts`): the release's files, then each
  model's session create, first run and total, in whole ms. The worker passes it on in the
  release status (`release.loadTimings`, optional), so an extension can read it in the compute
  frame (`frame.core?.status().release?.loadTimings`) and see why the first card is slow on some
  machine. Measured only; nothing decides on it, and nothing in it leaves the compute frame.

## [0.6.2] - 2026-10-31

The first analysis after a release loads gets 15 s before it is given up on. No change to the
contract between the frames (`PROTOCOL_VERSION` stays 1) or to any stable surface.

### Fixed

- `SessionCore`, and so `createSession` and `createWorkerSession`: the first analysis after a
  worker's release loads (also after a restart) is given up on after 15 s
  (`FIRST_ANALYSIS_WATCHDOG_MS`), not 5 s; later ones keep 5 s. The first analysis warms the
  models up, and on a slow machine it took longer than 5 s: the look was given up on, its late
  card dropped, and the busy worker's answers delayed the first card further. A paused video
  under a resting pointer could show nothing until the pointer moved again. A first analysis of
  6 s now shows its card at 6 s; 0.6.1 dropped it and showed the card at 6.5 s.

## [0.6.1] - 2026-10-31

From moving the second extension onto 0.6.0: one less layout read per pointer move in the
content script, and a sentence on why the frame checks `isTrusted`. No change to the contract
between the frames (`PROTOCOL_VERSION` stays 1) or to any stable surface.

### Changed

- `createCaptureControl` measures the picture once per trusted pointer event, not twice: the
  pointer it sends reuses the point just checked with `eligible`. Each measure reads the video's
  box and style, a forced layout on every move.
- `docs/extension-session.md`: Chrome lets a page build a `MessageEvent` with an extension
  frame's window as its `source`, and the `isTrusted` check is what stops it; Firefox refuses to
  build one.

## [0.6.0] - 2026-10-31

A session's policy, apart from the page, so that a browser extension can run it across two
frames: a content script in the video page and a frame of the extension's own. `createSession`
is now built on the same parts. It is release candidate 0.6.0rc2, listed below it, which fixed
the handshake with a newly added compute frame and the shown card's hold on a slow machine; that
candidate built on 0.6.0rc1. Every new module and entry is experimental. Nothing in the public
surface breaks. The contract's `PROTOCOL_VERSION` is 1. The released models are unchanged:
release `201478a00d6ef6ba`.

### Added

- `browser/src/session-core.ts`: `SessionCore`, a session's policy without a page: when a
  picture is captured and analyzed, which reply may be shown, and what is shown at the pointer.
  Its host reports what happens and calls `tick()`; it holds no timers. An optional hold
  (`SHOWN_HOLD`) keeps a shown card through short gaps; `neighborBoxes` gives the other cards'
  boxes. A miss is an analysis of the picture on screen with nothing at the pointer; a reply
  that analyzed nothing (busy, or an error), or an analysis older than `hover.maxAgeMs` when it
  comes back, is not one.
- `browser/src/worker-session.ts`: `createWorkerSession`, a `SessionCore` with the analysis
  workers that serve it: the one restart of a worker that stops after loading, and, with
  `chooseRelease`, rules 10 to 12 of [docs/remote-releases.md](docs/remote-releases.md).
- `browser/src/compute-frame.ts`: `startComputeFrame`, the extension frame's side of the
  two-frame contract: the origin and source rule, the messages, and the pictures it closes.
- `browser/src/compute-messages.ts`: `computeProtocol(tag)`, the contract's messages under an
  extension's own tag, with their parsers and limits (`MAX_FRAME_SIDE`, `MAX_OTHER_BOXES`,
  `MAX_REASON_LENGTH`, `MAX_TEXT_LENGTH`). A `status`'s `error` and `backend` are cut to 200
  characters, by `startComputeFrame` before posting and by the parser; a `capture`'s
  `analysisWidth` must be whole numbers from 1 to `MAX_FRAME_SIDE` (4096); `startComputeFrame`
  asks for at most that width, whatever the release allows.
- The content script's side: `grabFrame` (`browser/src/page-capture.ts`) takes the picture the
  frame asked for, `watchVideo` (`video-events.ts`) turns a video's events into messages,
  `captureAllowed` (`capture-gate.ts`) is the capture gate (never more than `MAX_REST_MS`, 60 s,
  after the last trusted pointer event, a card showing or not; `GateLimits.restMs`), and
  `fractionIn` (`capture.ts`) gives a point in fractions of the picture.
- `GrabDeps.requireConnected` and `GrabDeps.maxSide`, options of `grabFrame`: a same-document
  host analyzes a video out of the page, and a frame of any size.
- Two entries, `dist/compute-session.js` and `dist/page-capture.js`, built from them with no ONNX
  Runtime, WebAssembly or OpenCV inside (`browser/test/bundle-purity.test.ts` checks it). They
  are [experimental](docs/stability.md#experimental) and not part of `browser/src/index.ts`.
- `createCaptureControl` (`browser/src/capture-control.ts`), the content script's half in one
  place: pictures only on the authority of trusted pointer events (hover, or a tap for a bounded
  time that a card showing never extends; at most 60 s after the last trusted pointer event),
  the last trusted point checked against the picture before every capture, full resets when the
  viewer is gone, one capture at a time, stale pictures closed, and the handshake with the
  compute frame. Nothing is sent while the iframe still holds its first `about:blank` page; after
  a minute of that it reports `no-answer`.
- `fromExtensionFrame` and `acceptComputeOut` (`browser/src/capture-control.ts`): a `message`
  event is taken from one of the extension's frames only when it is trusted and comes from that
  frame and the extension's origin; a made-up event that a page dispatches is refused.
  `postWithTransfer` closes a bitmap that could not be posted.
- `PROTOCOL_VERSION` (`browser/src/compute-messages.ts`), the contract's version (1): a `hello
  {version}` message, and `ready` carries `version` and `instance` (16 lowercase hexadecimal
  characters, one per compute frame). `startComputeFrame` answers each `hello` with `ready`, the
  current status and the current shown card, and makes nothing again.
- `startComputeFrame` closes every picture of a message it does not take, even when the session
  or a product hook throws while the message is handled. `SessionCore.frame` closes a picture
  the worker cannot take (posting it throws) and looks again after the back-off.
- [docs/extension-session.md](docs/extension-session.md): the two-frame contract, its messages
  and limits, the handshake, the content script's capture rule, retries, the worker's
  lifecycle, and a sketch of each side. A tap needs the picture to receive pointer events
  (Firefox's native video controls take the touch), and a tap made during a cold start on a slow
  machine may show nothing.
- `FrameScheduler.lookUnanswered(now, { prompt: true })`, `FrameScheduler.pictureReceived()` and
  `FrameScheduler.lookRefused()`: a capture that failed for want of a picture is retried as soon
  as its back-off runs out; a picture received after failed captures starts the back-off over; a
  refused capture is asked again on the next pointer move.

### Changed

- `createSession` (`browser/src/session.ts`) is built on `SessionCore` and
  `createWorkerSession`, and captures a video with `grabFrame` and `watchVideo`. Its options,
  its methods and `SessionStatus` are unchanged. The lines below are what a caller may notice.
- `createSession`, a video the page may not read: `status().lastFrameError` is
  `capture-failed: the video may not be read` and no picture goes to the worker (0.5: the
  worker's `analysis-failed: SecurityError`). It is asked again on the next pointer move.
- `createSession`, a video not ready to draw (`readyState` below 2): reported `capture-failed:
  no picture` and looked at again after a back-off, where 0.5 analyzed an empty frame. A paused
  one is drawn anyway, dated at the time it showed while it last played; if it draws nothing it
  is reported `capture-failed: no picture (the paused video draws nothing)` and looked at again
  after 250 ms.
- `createSession` counts a video's `canplay` and `playing` events as presented frames, so a
  video that becomes ready is looked at.
- `createSession`, a video with no picture size yet (`videoWidth` 0): reported `capture-failed:
  no picture` and retried with the back-off, where 0.5 skipped the look.
- `createSession`, an `<img>` that cannot be captured: no longer retried after a back-off. Once
  the still picture's repeats are used up, it is asked again on the next pointer move in pointer
  mode, and after the image's next `load` in always-on mode.
- `createSession` closes a picture captured for a look asked before a seek; it is never
  analyzed.
- `createSession` checks the 5 s watchdog on its driver tick (every 250 ms), counted from the
  capture request.
- `createSession`'s `onUpdate` is called at most once for each event the session handles; a
  pointer move, the pointer leaving and a seek still call it every time. A presented frame or the
  driver tick now calls it when it changes what is shown at the pointer, for example when a result
  passes the release's `hover.maxAgeMs`.
- `createSession`'s `status().schedule` is computed when `status()` is read.
- `FrameScheduler.pointerMoved` makes the picture due again, at the cadence, when a retry was
  used up without an answer or a capture was refused, and never shortens a back-off still
  waiting. A paused picture whose look was refused while the pointer was outside is looked at
  when the pointer comes back and moves.
- `analysisSize` gives a frame at least one row high: a very wide, very short picture no longer
  gives a height of 0.

### Fixed

- `createSession`: a restarted worker that cannot be made now fails the session
  (`status().state` "failed", error "the recognition worker could not start"); 0.5.1 threw from
  the worker's error handler and stayed "loading". A first worker that cannot be made still makes
  `createSession` throw, as before.

## [0.6.0rc2] - 2026-10-29

Fixes from moving the first extension onto 0.6.0rc1. No change to the contract between the
frames (`PROTOCOL_VERSION` stays 1) or to any stable surface.

### Changed

- `docs/extension-session.md`: a tap needs the picture to receive pointer events (Firefox's
  native video controls take the touch), and a tap made during a cold start on a slow machine
  may show nothing.

### Fixed

- `createCaptureControl` (`browser/src/capture-control.ts`) sends nothing to the compute frame
  while the iframe still holds its first `about:blank` page. 0.6.0rc1 said `hello` to it at once
  when `connect()` was called right after the iframe was appended, and the browser logged an
  error in the video page's console for the message it dropped. It waits for at most a minute,
  then reports `no-answer`.
- The shown card's hold (`SHOWN_HOLD`) no longer counts a reply with nothing analyzed (busy, or an
  error), or an analysis that came back older than `hover.maxAgeMs`, as an analysis with nothing
  at the pointer. On a slow machine two slow analyses of a playing video in a row hid the card for
  a moment while it was still there; the hold now ends for those only after its 5 s.

## [0.6.0rc1] - 2026-10-29

A session's policy, apart from the page, so that a browser extension can run it across two
frames: a content script in the video page and a frame of the extension's own. `createSession`
is now built on the same parts. Every new module and entry is experimental. Nothing in the
public surface breaks. The released models are unchanged: release `201478a00d6ef6ba`.

### Added

- `browser/src/session-core.ts`: `SessionCore`, a session's policy without a page: when a
  picture is captured and analyzed, which reply may be shown, and what is shown at the pointer.
  Its host reports what happens and calls `tick()`; it holds no timers. An optional hold
  (`SHOWN_HOLD`) keeps a shown card through short gaps; `neighborBoxes` gives the other cards'
  boxes.
- `browser/src/worker-session.ts`: `createWorkerSession`, a `SessionCore` with the analysis
  workers that serve it: the one restart of a worker that stops after loading, and, with
  `chooseRelease`, rules 10 to 12 of [docs/remote-releases.md](docs/remote-releases.md).
- `browser/src/compute-frame.ts`: `startComputeFrame`, the extension frame's side of the
  two-frame contract: the origin and source rule, the messages, and the pictures it closes.
- `browser/src/compute-messages.ts`: `computeProtocol(tag)`, the contract's messages under an
  extension's own tag, with their parsers and limits (`MAX_FRAME_SIDE`, `MAX_OTHER_BOXES`,
  `MAX_REASON_LENGTH`, `MAX_TEXT_LENGTH`). A `status`'s `error` and `backend` are cut to 200
  characters, by `startComputeFrame` before posting and by the parser; a `capture`'s
  `analysisWidth` must be whole numbers from 1 to `MAX_FRAME_SIDE` (4096); `startComputeFrame`
  asks for at most that width, whatever the release allows.
- The content script's side: `grabFrame` (`browser/src/page-capture.ts`) takes the picture the
  frame asked for, `watchVideo` (`video-events.ts`) turns a video's events into messages,
  `captureAllowed` (`capture-gate.ts`) is the capture gate (never more than `MAX_REST_MS`, 60 s,
  after the last trusted pointer event, a card showing or not; `GateLimits.restMs`), and
  `fractionIn` (`capture.ts`) gives a point in fractions of the picture.
- `GrabDeps.requireConnected` and `GrabDeps.maxSide`, options of `grabFrame`: a same-document
  host analyzes a video out of the page, and a frame of any size.
- Two entries, `dist/compute-session.js` and `dist/page-capture.js`, built from them with no ONNX
  Runtime, WebAssembly or OpenCV inside (`browser/test/bundle-purity.test.ts` checks it). They
  are [experimental](docs/stability.md#experimental) and not part of `browser/src/index.ts`.
- `createCaptureControl` (`browser/src/capture-control.ts`), the content script's half in one
  place: pictures only on the authority of trusted pointer events (hover, or a tap for a bounded
  time that a card showing never extends; at most 60 s after the last trusted pointer event),
  the last trusted point checked against the picture before every capture, full resets when the
  viewer is gone, one capture at a time, stale pictures closed, and the handshake with the
  compute frame.
- `fromExtensionFrame` and `acceptComputeOut` (`browser/src/capture-control.ts`): a `message`
  event is taken from one of the extension's frames only when it is trusted and comes from that
  frame and the extension's origin; a made-up event that a page dispatches is refused.
  `postWithTransfer` closes a bitmap that could not be posted.
- `PROTOCOL_VERSION` (`browser/src/compute-messages.ts`), the contract's version (1): a `hello
  {version}` message, and `ready` carries `version` and `instance` (16 lowercase hexadecimal
  characters, one per compute frame). `startComputeFrame` answers each `hello` with `ready`, the
  current status and the current shown card, and makes nothing again.
- `startComputeFrame` closes every picture of a message it does not take, even when the session
  or a product hook throws while the message is handled. `SessionCore.frame` closes a picture
  the worker cannot take (posting it throws) and looks again after the back-off.
- [docs/extension-session.md](docs/extension-session.md): the two-frame contract, its messages
  and limits, the handshake, the content script's capture rule, retries, the worker's
  lifecycle, and a sketch of each side.
- `FrameScheduler.lookUnanswered(now, { prompt: true })`, `FrameScheduler.pictureReceived()` and
  `FrameScheduler.lookRefused()`: a capture that failed for want of a picture is retried as soon
  as its back-off runs out; a picture received after failed captures starts the back-off over; a
  refused capture is asked again on the next pointer move.

### Changed

- `createSession` (`browser/src/session.ts`) is built on `SessionCore` and
  `createWorkerSession`, and captures a video with `grabFrame` and `watchVideo`. Its options,
  its methods and `SessionStatus` are unchanged. The lines below are what a caller may notice.
- `createSession`, a video the page may not read: `status().lastFrameError` is
  `capture-failed: the video may not be read` and no picture goes to the worker (0.5: the
  worker's `analysis-failed: SecurityError`). It is asked again on the next pointer move.
- `createSession`, a video not ready to draw (`readyState` below 2): reported `capture-failed:
  no picture` and looked at again after a back-off, where 0.5 analyzed an empty frame. A paused
  one is drawn anyway, dated at the time it showed while it last played; if it draws nothing it
  is reported `capture-failed: no picture (the paused video draws nothing)` and looked at again
  after 250 ms.
- `createSession` counts a video's `canplay` and `playing` events as presented frames, so a
  video that becomes ready is looked at.
- `createSession`, a video with no picture size yet (`videoWidth` 0): reported `capture-failed:
  no picture` and retried with the back-off, where 0.5 skipped the look.
- `createSession`, an `<img>` that cannot be captured: no longer retried after a back-off. Once
  the still picture's repeats are used up, it is asked again on the next pointer move in pointer
  mode, and after the image's next `load` in always-on mode.
- `createSession` closes a picture captured for a look asked before a seek; it is never
  analyzed.
- `createSession` checks the 5 s watchdog on its driver tick (every 250 ms), counted from the
  capture request.
- `createSession`'s `onUpdate` is called at most once for each event the session handles; a
  pointer move, the pointer leaving and a seek still call it every time. A presented frame or the
  driver tick now calls it when it changes what is shown at the pointer, for example when a result
  passes the release's `hover.maxAgeMs`.
- `createSession`'s `status().schedule` is computed when `status()` is read.
- `FrameScheduler.pointerMoved` makes the picture due again, at the cadence, when a retry was
  used up without an answer or a capture was refused, and never shortens a back-off still
  waiting. A paused picture whose look was refused while the pointer was outside is looked at
  when the pointer comes back and moves.
- `analysisSize` gives a frame at least one row high: a very wide, very short picture no longer
  gives a height of 0.

### Fixed

- `createSession`: a restarted worker that cannot be made now fails the session
  (`status().state` "failed", error "the recognition worker could not start"); 0.5.1 threw from
  the worker's error handler and stayed "loading". A first worker that cannot be made still makes
  `createSession` throw, as before.

## [0.5.1] - 2026-10-29

A patch: `createSession` recovers from an analysis worker that stops after the release has
loaded. Nothing in the public surface breaks. The released models are unchanged: release
`201478a00d6ef6ba`.

### Fixed

- A session whose analysis worker stopped with an error after the release had loaded kept
  reporting "ready" and analyzed nothing more: every look timed out and was retried about every
  2 s. The session now restarts the worker once on the same release, without the geometric
  stage, and clears what it was showing; `status().state` is "loading" until the restarted worker
  has loaded, and `status().geometric` reports the stage off with the reason `worker-restarted`.
  If the restarted worker stops too, the state becomes "failed" with the error "the recognition
  worker stopped". A worker that stops before the release has loaded fails the session as before.

## [0.5.0] - 2026-10-29

A maintenance kit for browser extensions built on this runtime: the code that loads a newer
release from a product's own host, the tools that publish and check one, and the gate for a card
update. Every part of the kit is experimental. It is release candidate 0.5.0rc2, listed below
it, which fixed a paused video that could stay unanalyzed after a slow first analysis and added
a guide to showing cards in the viewer's language; that candidate built on 0.5.0rc1. Nothing in
the public surface breaks. The released models are unchanged: release `201478a00d6ef6ba`.

### Added

- A maintenance kit for a browser extension built on this runtime, which serves new cards from
  a host of its own. Every part is [experimental](docs/stability.md#experimental): it may change
  in a minor release.
- `browser/src/remote/`, built to `dist/remote-release.js`: which release a page loads when the
  extension's settings file points to a newer one, the fetch and check of that release, the
  geometric stage under it, and the card table built from its catalog. Anything wrong loads the
  bundled release. [docs/remote-releases.md](docs/remote-releases.md) is the contract it follows.
- `dist/node/verify-release.mjs` checks a release folder or address with the runtime's own
  loader, and with `--sessions` starts both models in Node. `dist/node/package-zip.mjs` writes an
  extension's store or release-page zip in the layout each one needs.
- `cardvision cdn` publishes a product's card pictures, data files, pages, settings file,
  geometric index and releases to its own Cloudflare bucket, and checks what is served. One file,
  `cdn/cdn.config.json`, describes the product; a key that turns a check on is required. A pointer
  only moves to a release that verifies live, and a release folder or a geometric index folder is
  never overwritten; a publish replaces only changed images, `art/index.json`, the page,
  `config.json` and the record of published releases. Publishing needs the new `cdn` extra
  (`boto3`). [docs/cdn.md](docs/cdn.md).
- `cardvision refresh` judges a card update before it goes out: `check` for the preconditions,
  `diff` of two `evaluate hover` runs, `subset` for the new cards' scenes, and `verdict` by a
  rule frozen before the update's data was seen, in the schema `refresh-rule/1`.
  [docs/refresh-rule-template.md](docs/refresh-rule-template.md) is the template, and
  [playbooks/refresh-set.md](playbooks/refresh-set.md) the procedure for each update.
- [docs/languages.md](docs/languages.md): how an extension shows the hovered card in the
  viewer's language (translated text, pictures or both) with the files `cardvision cdn` already
  publishes. Recognition is unchanged. Documentation only.
- `FrameScheduler.lookUnanswered(now)` and `FrameScheduler.lookAnswered()`: a host reports a
  look that came back with the picture not analyzed, and one that came back analyzed (see Fixed).

### Changed

- The package is on PyPI as `cardvision` from 0.4.0: `python -m pip install cardvision`
  installs the command-line tools.
- None of the public surface breaks. The runtime's API (`browser/src/index.ts`), the existing
  commands and the release files are unchanged.

### Fixed

- A paused video could stay unanalyzed after a slow first analysis. When an analysis took
  longer than the session waits for it, the looks sent meanwhile were answered "busy" and the
  late answer was dropped. They used up the paused picture's looks, and a paused video presents
  no new frame, so nothing was analyzed until the video moved. A failed capture could do the
  same. A look given up on, answered "busy" or not captured now makes the same picture due again
  after a back-off (250 ms, 500 ms, 1 s, then about one look every 2 s) while analysis may run.
  An analyzed answer, a seek or a new source starts the back-off over; the pointer leaving does
  not.

## [0.5.0rc2] - 2026-10-29

Second release candidate for 0.5.0. On top of rc1 it fixes a paused video that could stay
unanalyzed after a slow first analysis, and adds a guide to showing cards in the viewer's
language. Nothing in the public surface breaks. The released models are unchanged: release
`201478a00d6ef6ba`.

### Added

- [docs/languages.md](docs/languages.md): how an extension shows the hovered card in the
  viewer's language (translated text, pictures or both) with the files `cardvision cdn` already
  publishes. Recognition is unchanged. Documentation only.
- `FrameScheduler.lookUnanswered(now)` and `FrameScheduler.lookAnswered()`: a host reports a
  look that came back with the picture not analyzed, and one that came back analyzed (see Fixed).

### Fixed

- A paused video could stay unanalyzed after a slow first analysis. When an analysis took
  longer than the session waits for it, the looks sent meanwhile were answered "busy" and the
  late answer was dropped. They used up the paused picture's looks, and a paused video presents
  no new frame, so nothing was analyzed until the video moved. A failed capture could do the
  same. A look given up on, answered "busy" or not captured now makes the same picture due again
  after a back-off (250 ms, 500 ms, 1 s, then about one look every 2 s) while analysis may run.
  An analyzed answer, a seek or a new source starts the back-off over; the pointer leaving does
  not.

## [0.5.0rc1] - 2026-10-28

First release candidate for 0.5.0. It adds a maintenance kit for browser extensions built on
this runtime: the code that loads a newer release from a product's own host, the tools that
publish and check one, and the gate for a card update. Every new part is experimental. Nothing
in the public surface breaks, and the browser runtime behaves exactly as in 0.4.0. The released
models are unchanged: release `201478a00d6ef6ba`.

### Added

- A maintenance kit for a browser extension built on this runtime, which serves new cards from
  a host of its own. Every part is [experimental](docs/stability.md#experimental): it may change
  in a minor release.
- `browser/src/remote/`, built to `dist/remote-release.js`: which release a page loads when the
  extension's settings file points to a newer one, the fetch and check of that release, the
  geometric stage under it, and the card table built from its catalog. Anything wrong loads the
  bundled release. [docs/remote-releases.md](docs/remote-releases.md) is the contract it follows.
- `dist/node/verify-release.mjs` checks a release folder or address with the runtime's own
  loader, and with `--sessions` starts both models in Node. `dist/node/package-zip.mjs` writes an
  extension's store or release-page zip in the layout each one needs.
- `cardvision cdn` publishes a product's card pictures, data files, pages, settings file,
  geometric index and releases to its own Cloudflare bucket, and checks what is served. One file,
  `cdn/cdn.config.json`, describes the product; a key that turns a check on is required. A pointer
  only moves to a release that verifies live, and a release folder or a geometric index folder is
  never overwritten; a publish replaces only changed images, `art/index.json`, the page,
  `config.json` and the record of published releases. Publishing needs the new `cdn` extra
  (`boto3`). [docs/cdn.md](docs/cdn.md).
- `cardvision refresh` judges a card update before it goes out: `check` for the preconditions,
  `diff` of two `evaluate hover` runs, `subset` for the new cards' scenes, and `verdict` by a
  rule frozen before the update's data was seen, in the schema `refresh-rule/1`.
  [docs/refresh-rule-template.md](docs/refresh-rule-template.md) is the template, and
  [playbooks/refresh-set.md](playbooks/refresh-set.md) the procedure for each update.

### Changed

- The package is on PyPI as `cardvision` from 0.4.0: `python -m pip install cardvision`
  installs the command-line tools.
- None of the public surface breaks. The runtime's API (`browser/src/index.ts`), the existing
  commands and the release files are unchanged.

## [0.4.0] - 2026-10-28

The geometric stage's index can take new cards without changing what was there, and a release
can be converted to a binary bank whose files each stay under a browser add-on store's 5 MiB
limit on text files. It is release candidate 0.4.0rc2, listed below it, with one fix to the
quickstart's steps for Windows; that candidate added the binary bank to 0.4.0rc1. Nothing in
the public surface breaks. The released models are unchanged: release `201478a00d6ef6ba`.

### Added

- `cardvision build-features --base OLD` and `pack-features --base MANIFEST` add new cards to the
  geometric stage's index without changing what was there. `build-features --base` copies the
  old index's cards unchanged and in order and takes keypoints only for the new cards, after
  them; over a bank extended with `build-bank --base` it writes the same bytes as a full build.
  `pack-features --base` keeps the old pack's shards byte for byte and puts the new cards in new
  shards named by content (`shard-<16 hex>.bin`), so a page that keeps the index downloads only
  the new shards. Both refuse an old index or pack built with other `features` settings or
  another OpenCV version. `build-features --base` also refuses an old card whose image changed or
  that the bank (or, without one, the catalog) no longer lists; `pack-features --base` also
  refuses a base pack whose shards are named by position. `pack-features --content-names` starts
  such a series, and `--manifest-name` lets successive manifests share one folder. The manifest
  format is unchanged (`schemaVersion` 1), and so is a pack made without the new flags.
- `bank.bin`, a binary form of the bank, and `cardvision convert-release RELEASE --out DIR`,
  which writes a release with smaller files and the same values. The bank becomes `bank.bin`:
  the same fp16 bytes as the JSON bank's base64 text, after a JSON header that holds the bank's
  other fields and its card ids. The catalog is written as compact JSON. The converted release
  has a new id and scores exactly as the original. Every reader of a release, `verify-release`,
  `infer --release`, `evaluate`, the other bank commands and the browser runtime, takes either
  form of the bank, and refuses a `bank.bin` of a format version it does not know. The JSON bank
  is unchanged and stays the default. A geometric index records the SHA-256 of the bank it
  serves, so build it again against the converted release. A converted release needs
  cardvision 0.4.0rc2 or later, in Python and in the browser; older readers refuse it.
  [docs/release-files.md](docs/release-files.md#the-binary-bank-bankbin) has the format.

### Changed

- NOTICE says that its statements describe this repository and its own Riftbound release. A
  product built on this code for another game carries its own notice for that game's data; the
  Riot Games statements do not apply to it.
- `browser/` is type-checked with TypeScript 7.0.2 and tested with vitest 5.0.5. The runtime's
  JavaScript is built as before and does not change. A product that vendors the runtime and
  emits its declaration files with TypeScript 7 sets `rootDir` to `"src"` in that `tsc` run;
  without it, TypeScript 7 stops with error TS5011.

### Fixed

- The quickstart's steps for Windows install Node 24 (`nvm install 24`), the version the checks
  run on. `nvm install --lts` now installs Node 26, which does not start in a fresh Ubuntu 24.04
  under WSL: it needs `libatomic.so.1`, which that Ubuntu does not have.

### Security

- The training lock (`requirements-lock-train.txt`) pins filelock 4.2.4. The 4.1.0 it pinned
  before has six published advisories, all fixed in 4.2.1. Only the training environment
  installs filelock.

## [0.4.0rc2] - 2026-10-27

Second release candidate for 0.4.0. It adds a binary form of the bank, so a browser add-on can
ship a release whose files each stay under a store's 5 MiB limit on text files. Everything
0.4.0rc1 added is unchanged.

### Added

- `bank.bin`, a binary form of the bank, and `cardvision convert-release RELEASE --out DIR`,
  which writes a release with smaller files and the same values. The bank becomes `bank.bin`:
  the same fp16 bytes as the JSON bank's base64 text, after a JSON header that holds the bank's
  other fields and its card ids. The catalog is written as compact JSON. Both files get smaller,
  and the bank is no longer a text file, which a browser add-on store's 5 MiB limit on text
  files needs. The converted release has a new id and scores exactly as the original.
  Every reader of a release, `verify-release`, `infer --release`, `evaluate`, the other bank
  commands and the browser runtime, takes either form of the bank, and refuses a `bank.bin` of a
  format version it does not know. The JSON bank is unchanged and stays the default. A geometric
  index records the SHA-256 of the bank it serves, so build it again against the converted
  release. A converted release needs this version or later, in Python and in the browser;
  older readers refuse it. [docs/release-files.md](docs/release-files.md#the-binary-bank-bankbin)
  has the format.

## [0.4.0rc1] - 2026-10-27

First release candidate for 0.4.0. The geometric stage's index can take new cards without
changing what was there, so a page that keeps the index downloads only the new cards' shards.
Nothing in the public surface breaks, and the browser runtime behaves exactly as in 0.3.0. The
released models are unchanged: release `201478a00d6ef6ba`.

### Added

- `cardvision build-features --base OLD` and `pack-features --base MANIFEST` add new cards to the
  geometric stage's index without changing what was there. `build-features --base` copies the
  old index's cards unchanged and in order and takes keypoints only for the new cards, after
  them; over a bank extended with `build-bank --base` it writes the same bytes as a full build.
  `pack-features --base` keeps the old pack's shards byte for byte and puts the new cards in new
  shards named by content (`shard-<16 hex>.bin`), so a page that keeps the index downloads only
  the new shards. Both refuse an old index or pack built with other `features` settings or
  another OpenCV version. `build-features --base` also refuses an old card whose image changed or
  that the bank (or, without one, the catalog) no longer lists; `pack-features --base` also
  refuses a base pack whose shards are named by position. `pack-features --content-names` starts
  such a series, and `--manifest-name` lets successive manifests share one folder. The manifest
  format is unchanged (`schemaVersion` 1), and so is a pack made without the new flags.

### Changed

- NOTICE says that its statements describe this repository and its own Riftbound release. A
  product built on this code for another game carries its own notice for that game's data; the
  Riot Games statements do not apply to it.

### Security

- The training lock (`requirements-lock-train.txt`) pins filelock 4.2.4. The 4.1.0 it pinned
  before has six published advisories, all fixed in 4.2.1. Only the training environment
  installs filelock.

## [0.3.0] - 2026-10-26

The labeling tool handles cards seen at an angle and stacked cards, `make-composites` can draw
close-ups, and `cardvision next` checks the downloaded models. It is release candidate
0.3.0rc1, listed below it, unchanged. Nothing in the public surface breaks. The released models
are unchanged: release `201478a00d6ef6ba`.

### Added

- The labeling tool's Boxes pass labels a card seen at an angle: Shift+drag a corner of a box and
  its corners come free, so each one moves onto the card's own corner. `s` snaps them to the
  card's edges, and `e` makes the box a rectangle again. The card's top stays where it was. The
  manifest export writes such a box with the shape `quad`; every other box is written as
  before. The labeling guide no longer says to mark a steeply angled card ignore.
- `make-composites --closeups SHARE` draws that share of the scenes as close-ups: one large card,
  sometimes two, tilted 15 to 45 degrees toward the camera and filling 25 to 80 % of the frame's
  height, often with a glow around it, as in a digital client's summon or activation shot or a
  webcam close over a table. Each card's corners and homography are exact, and its `pose` gives
  the tilt. The manifest records the share and ranges under `parameters.closeups`, and `--check`
  checks that each close-up holds a positive face with a convex, clockwise quad. The default, 0,
  draws none: a run without the flag writes the same bytes as before, and with it the scenes
  that are not close-ups stay the same.
- `cardvision export detector --no-fp16-weights` writes and checks the float32 file only, with
  no half-precision copy (`<name>-fp16w.onnx`) and no parity check for one.
- `cardvision next --images DIR` takes the card images' folder from you, as `try --images` does,
  for art kept outside the game folder before a first `try`. It wins over `images/`, `art/` and
  the last `try`'s log, and the `try` line it prints carries the folder. `--json` gives
  `source: "argument"` for it. An empty value, `/`, the home folder or a folder holding the game
  folder is refused. When the folder is not the one the last `try` used, `next` says to run `try`
  again with `--overwrite`.
- The labeling tool's stacking view (`o`, or Options) shades the part of each box that no box
  above it covers and numbers its layer within its stack, to check a stack's order at a glance.
  Nothing it shows is saved.
- In the Boxes pass, `d` then an arrow adds a box of the same size and angle against that side of
  the selected box, for the next card of a stack or a row: only its far edge is left to fit.
- Copy, paste and duplicate (Cmd/Ctrl+C, V, D) take several selected boxes; a group keeps its
  spacing.

### Changed

- `cardvision next` checks the weights' size and SHA-256 against the table `fetch-weights` uses,
  instead of taking the files' presence for done. A file of the wrong size or contents is named
  in the check's `detail` and the step's `notes`. In a download of the release the next step is
  `cardvision fetch-weights DIR --overwrite`; in a folder with no released `release.json` it is a
  download into a new, empty folder, never `--overwrite`; a file that can't be read gets a step
  to check its permissions. A folder whose `release.json` is another JSON document with a
  `schemaVersion` is your own release folder and is not checked; a file missing from it is yours to
  copy in, and `fetch-weights` is never suggested into it or into a folder holding other files with
  the released names. Nothing is downloaded and about 7.7 MB are read, so it stays quick.
- The labeling tool's layer keys `.` and `,` move a box one layer up or down among the boxes it
  overlaps, rather than through every box in the frame. A turned box may run past the frame's
  edge, as a card cut off by the picture's edge does, within the range the export accepts.
- After you update the toolkit, a labeling page newer than the running `labeler/serve.py` says so
  and waits for you to restart the tool, rather than half working.
- [What we tried](docs/what-we-tried.md) has a section on finding a card's four corners with a
  model, and why both attempts were set aside.

### Fixed

- `cardvision next` no longer calls a partial or corrupted weights download done: a file of the
  wrong size or contents now reads `missing`, with the file named.
- The labeling tool's Boxes pass no longer lets a turn or a fit push a turned box's corner more
  than a whole frame outside the picture, where the export would have left the frame out: `r`,
  `R`, `w`, `W`, `e` and the turning knob stop with a word why and leave the box as it was. A box
  already past that limit can now be resized or turned back toward the picture; a change that
  puts a corner further out is still refused.

## [0.3.0rc1] - 2026-10-24

First release candidate for 0.3.0. The labeling tool handles cards seen at an angle and stacked
cards, `make-composites` can draw close-ups, and `cardvision next` checks the downloaded models.
Nothing in the public surface breaks. The released models are unchanged: release
`201478a00d6ef6ba`.

### Added

- The labeling tool's Boxes pass labels a card seen at an angle: Shift+drag a corner of a box and
  its corners come free, so each one moves onto the card's own corner. `s` snaps them to the
  card's edges, and `e` makes the box a rectangle again. The card's top stays where it was. The
  manifest export writes such a box with the shape `quad`; every other box is written as
  before. The labeling guide no longer says to mark a steeply angled card ignore.
- `make-composites --closeups SHARE` draws that share of the scenes as close-ups: one large card,
  sometimes two, tilted 15 to 45 degrees toward the camera and filling 25 to 80 % of the frame's
  height, often with a glow around it, as in a digital client's summon or activation shot or a
  webcam close over a table. Each card's corners and homography are exact, and its `pose` gives
  the tilt. The manifest records the share and ranges under `parameters.closeups`, and `--check`
  checks that each close-up holds a positive face with a convex, clockwise quad. The default, 0,
  draws none: a run without the flag writes the same bytes as before, and with it the scenes
  that are not close-ups stay the same.
- `cardvision export detector --no-fp16-weights` writes and checks the float32 file only, with
  no half-precision copy (`<name>-fp16w.onnx`) and no parity check for one.
- `cardvision next --images DIR` takes the card images' folder from you, as `try --images` does,
  for art kept outside the game folder before a first `try`. It wins over `images/`, `art/` and
  the last `try`'s log, and the `try` line it prints carries the folder. `--json` gives
  `source: "argument"` for it. An empty value, `/`, the home folder or a folder holding the game
  folder is refused. When the folder is not the one the last `try` used, `next` says to run `try`
  again with `--overwrite`.
- The labeling tool's stacking view (`o`, or Options) shades the part of each box that no box
  above it covers and numbers its layer within its stack, to check a stack's order at a glance.
  Nothing it shows is saved.
- In the Boxes pass, `d` then an arrow adds a box of the same size and angle against that side of
  the selected box, for the next card of a stack or a row: only its far edge is left to fit.
- Copy, paste and duplicate (Cmd/Ctrl+C, V, D) take several selected boxes; a group keeps its
  spacing.

### Changed

- `cardvision next` checks the weights' size and SHA-256 against the table `fetch-weights` uses,
  instead of taking the files' presence for done. A file of the wrong size or contents is named
  in the check's `detail` and the step's `notes`. In a download of the release the next step is
  `cardvision fetch-weights DIR --overwrite`; in a folder with no released `release.json` it is a
  download into a new, empty folder, never `--overwrite`; a file that can't be read gets a step
  to check its permissions. A folder whose `release.json` is another JSON document with a
  `schemaVersion` is your own release folder and is not checked; a file missing from it is yours to
  copy in, and `fetch-weights` is never suggested into it or into a folder holding other files with
  the released names. Nothing is downloaded and about 7.7 MB are read, so it stays quick.
- The labeling tool's layer keys `.` and `,` move a box one layer up or down among the boxes it
  overlaps, rather than through every box in the frame. A turned box may run past the frame's
  edge, as a card cut off by the picture's edge does, within the range the export accepts.
- After you update the toolkit, a labeling page newer than the running `labeler/serve.py` says so
  and waits for you to restart the tool, rather than half working.
- [What we tried](docs/what-we-tried.md) has a section on finding a card's four corners with a
  model, and why both attempts were set aside.

### Fixed

- `cardvision next` no longer calls a partial or corrupted weights download done: a file of the
  wrong size or contents now reads `missing`, with the file named.
- The labeling tool's Boxes pass no longer lets a turn or a fit push a turned box's corner more
  than a whole frame outside the picture, where the export would have left the frame out: `r`,
  `R`, `w`, `W`, `e` and the turning knob stop with a word why and leave the box as it was. A box
  already past that limit can now be resized or turned back toward the picture; a change that
  puts a corner further out is still refused.

## [0.2.0] - 2026-10-24

The newcomer release: try the toolkit on your own game in one command, ask it for the next step,
and label with a guide. It collects release candidates 0.2.0rc1 to 0.2.0rc4, listed below it.
The released models are unchanged: the v0.1.0 files, release `201478a00d6ef6ba`.

### Added

- `cardvision try CARDS --images DIR --video FILE`: the steps of the your-game guide in one command
  (import, image check, bank, release folder, `infer`), ending in a `report.html` with the outcome,
  the contact sheet, the annotated frames and the line that opens the demo page (with `npm ci`
  first when `browser/node_modules` is missing). A `No image:` line before the verdict, and a list
  in the report, name the cards in your list that have no image.
- `cardvision next [GAME]`: looks at the game folder, the weights folder and the last `try` run,
  and says what is done and the one next step, with the exact command, the doc to read, the
  playbook for a coding agent, and a `STOP:` line when the step needs the person. `--json` prints
  the same as a stable object. It only reads.
- `cardvision fetch-weights DIR`: download the released model files, check each one's size and
  SHA-256 against the pins, resume, and finish with `verify-release`; `--list` makes no request.
- `cardvision import-catalog`: write a catalog from a CSV, TSV or JSON card list, recognizing
  common header names without `--map`; images are downloaded only with `--download`.
- `cardvision check-catalog`: load a catalog and report its card count, cards without art,
  identity rule and game.
- `cardvision make-composites --card-size WxH`: the card size in millimeters (default `63x88`),
  recorded in the manifest as `parameters.cardAspect`.
- A per-card `extra` object in the catalog, kept as given and read by nothing.
- The Riftbound catalog declares three facets, Domain, Energy and Set, so the labeling tool's
  Names pass filters by them; the labeling tool says when a catalog declares none.
- Newcomer documentation: a start-here page, a guide for your own game, the guide split into
  train, measure and extension pages, and [How to label](docs/labeling.md) with pictures of real
  labeled frames.
- `CHANGELOG.md`, `RELEASING.md` and `docs/stability.md`; a monthly grouped Dependabot update.

### Changed

- `AGENTS.md` is a short router (start with `cardvision next`, one playbook per job, when to stop
  and ask the person); the step-by-step tiers moved into `playbooks/`.
- The quickstart and the setup playbook check `python3 --version` first and say what to do when it
  is older than 3.11.
- `cardvision` with no arguments, and the end of `--help`, list the commands in groups.
- `composites`: a generated folder's manifest that is not a JSON object, or not valid JSON, is
  reported as an error naming the file.
- Runs of `make-composites` without `--card-size` lay out the same scenes as 0.1.0; Pillow 13.0.0
  changes a few pixels of a few composites, which is harmless for training.
- CI runs the Python tests on every core with pytest-xdist; the sign-off check skips commits
  authored by Dependabot.

### Security

- Pillow 13.0.0, which fixes flaws in reading JPEG, TIFF, GIF, EPS and PDF files, is pinned in
  both lock files for every supported Python.

### Removed

- **Breaking:** Python 3.10 is no longer supported; use 3.11 or 3.12. `requires-python` is now
  `>=3.11`. To migrate, create a new virtual environment with Python 3.11 or 3.12 and reinstall.
  On Windows, use Ubuntu 24.04 under WSL (22.04 has Python 3.10).

### Fixed

- `games/riftbound/catalog.json` holds the same cards as the released models' catalog: 20 cards
  it lacked, most of them from Radiance, and the English names of RAD-053, RAD-078 and RAD-123.
- `import-catalog` refuses an id that holds a space, and an import in which none of the listed
  images is found, naming a path it looked for; nothing is written.
- `build-bank` and `build-release` name `--overwrite` when they refuse to replace a different file.
- The demo finds an image whose path has a folder (`HD/x.jpg`), and a video it cannot open gets
  the `ffmpeg` command that converts it to H.264.

## [0.2.0rc4] - 2026-10-22

Fourth release candidate for 0.2.0. The Riftbound catalog gets the released models' cards and
the labeling tool's filters. The released models are unchanged: release `201478a00d6ef6ba`.

### Added

- The Riftbound catalog (`games/riftbound/catalog.json`) declares three facets, Domain, Energy
  and Set, so the labeling tool's Names pass filters by them. The labeling tool says when a
  catalog declares no facets, and where to read how to add them.

### Fixed

- `games/riftbound/catalog.json` now holds the same cards as the released models' `catalog.json`
  (release `201478a00d6ef6ba`): 20 cards it lacked, most of them from Radiance, and the English
  names of RAD-053, RAD-078 and RAD-123, which it had under their Chinese preview names. Labels
  can now name those cards.

## [0.2.0rc3] - 2026-10-22

Third release candidate for 0.2.0. It adds `cardvision next`, a short `AGENTS.md` with one
playbook per job, and a labeling guide. The released models are unchanged: release
`201478a00d6ef6ba`.

### Added

- `cardvision next [GAME]`: looks at the game folder, the weights folder and the last `try` run,
  and says what is done and the one next step, with the exact command, the doc to read, the
  playbook for a coding agent, and a `STOP:` line when the step needs the person (a download,
  their own files, a choice, money or time). `--json` prints the same as a stable object. It
  only reads.
- [How to label](docs/labeling.md): what gets a box and which kind, by one rule (about half or
  more hidden → an ignore box on the visible part), with the cases that make people hesitate and
  links to pictures of real labeled frames. It replaces the rules section of
  `labeler/FORMAT.md`.

### Changed

- `AGENTS.md` is a short router (start with `cardvision next`, one playbook per job, when to stop
  and ask the person). Its step-by-step tiers moved into `playbooks/`: `setup.md`,
  `try-my-game.md`, `make-extension.md`, `train.md` and `measure.md`. A test keeps the agent
  files short and checks that every command and flag they show exists.

## [0.2.0rc2] - 2026-10-21

Second release candidate for 0.2.0, with fixes from the first one's soak. The released models are
unchanged: release `201478a00d6ef6ba`.

### Fixed

- `cardvision try` says when cards in your list have no image: a `No image:` line before the
  verdict, and a list in the report. It tells cards that can't be named (no printing of them has an
  image) from printings with no image of their own (named only where they look like another
  printing). Before, only `import-report.txt` and `try.log` said so.
- From a newcomer's run of the docs: start-here.md says how to write a card list with another name
  and where images go when the image column names a folder; the import's "none of the images"
  error also offers moving the images; the report says the demo runs until Control-C.
- The quickstart and AGENTS.md check `python3 --version` first and say what to do when it is older
  than 3.11 (a Mac with an older python.org installer, for one).
- The 0.2.0rc1 notes said runs of `make-composites` without `--card-size` write the same files as
  0.1.0. They lay out the same scenes; Pillow 13.0.0 changes a few pixels of a few composites.

## [0.2.0rc1] - 2026-10-21

Release candidate for 0.2.0. The released models are unchanged: the v0.1.0 files, release
`201478a00d6ef6ba`.

### Added

- `cardvision make-composites --card-size WxH`: the card size in millimeters (default `63x88`),
  which sets the shape of the layouts, generated backs and card-shaped distractors; the manifest
  records it as `parameters.cardAspect`, and the label check reads it from there. Without the
  flag, a run lays out the same scenes as before with the same library versions. Pillow 13.0.0
  (pinned for every supported Python, see Security) resizes images slightly differently, so a few
  pixels of a few composites differ from 0.1.0's with Pillow 12.3.0, which is harmless for
  training.
- `cardvision try CARDS --images DIR --video FILE`: the steps of the your-game guide in one command
  (import, image check, bank, release folder, `infer`), ending in a `report.html` with the outcome,
  the contact sheet, the annotated frames and the line that opens the demo page (with `npm ci`
  first when `browser/node_modules` is missing).
- `cardvision fetch-weights DIR`: download the released model files, check each one's size and
  SHA-256 against the pins, resume, and finish with `verify-release`; `--list` makes no request.
  An empty DIR, or one inside the repository, is refused.
- `cardvision import-catalog`: write a catalog from a CSV, TSV or JSON card list, with
  `--overwrite` and `--delimiter`; images are downloaded only with `--download`.
- `cardvision check-catalog`: load a catalog and report its card count, cards without art,
  identity rule and game.
- `import-catalog` recognizes more header names without `--map` (such as `Card No.`, `Set Code`,
  `Card #`, `Card Title`, `Picture`); when several match a field, the first in order wins and the report
  names the others.
- A per-card `extra` object in the catalog, kept as given and read by nothing.
- Newcomer documentation: a start-here page, a guide for your own game, and the guide split into
  train, measure and extension pages.
- `CHANGELOG.md`, `RELEASING.md` and `docs/stability.md`; a monthly grouped Dependabot update.

### Changed

- `composites`: a generated folder's manifest that is not a JSON object, or not valid JSON, is
  reported as an error naming the file.
- `cardvision` with no arguments, and the end of `--help`, list the commands in groups.
- CI runs the Python tests on every core with pytest-xdist.
- The sign-off check skips commits authored by Dependabot.

### Security

- Pillow 13.0.0, which fixes flaws in reading JPEG, TIFF, GIF, EPS and PDF files, is now pinned
  in both lock files for every supported Python.

### Removed

- **Breaking:** Python 3.10 is no longer supported; use 3.11 or 3.12. `requires-python` is now
  `>=3.11`. Python 3.10 reaches end of life in October 2026, and Pillow's security fix needs 3.11.
  To migrate, create a new virtual environment with Python 3.11 or 3.12 and reinstall.
  On Windows, use Ubuntu 24.04 under WSL (22.04 has Python 3.10).

### Fixed

- `import-catalog` refuses an id that holds a space, and an import in which none of the listed
  images is found, naming a path it looked for; nothing is written.
- `build-bank` and `build-release` name `--overwrite` when they refuse to replace a different file.
- The demo finds an image whose path has a folder (`HD/x.jpg`), and a video it cannot open gets
  the `ffmpeg` command that converts it to H.264.

## [0.1.0] - 2026-10-19

Initial public release.

- The `cardvision` command-line tools: catalog, bank and release-document building, inference,
  training, evaluation and label-manifest tools.
- The released detector and recognizer (ONNX), the bank, the identity groups, the catalog and the
  accept rule, pinned by one release document (release `201478a00d6ef6ba`).
- The browser runtime, the labeling tool and a hosted demo.
- Apache-2.0 code and weights, CC BY 4.0 labels.

[Unreleased]: https://github.com/ryangswe/riftsight-vision/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/ryangswe/riftsight-vision/compare/v0.6.2...v0.7.0
[0.7.0rc2]: https://github.com/ryangswe/riftsight-vision/compare/v0.7.0rc1...v0.7.0rc2
[0.7.0rc1]: https://github.com/ryangswe/riftsight-vision/compare/v0.6.2...v0.7.0rc1
[0.6.2]: https://github.com/ryangswe/riftsight-vision/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/ryangswe/riftsight-vision/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/ryangswe/riftsight-vision/compare/v0.5.1...v0.6.0
[0.6.0rc2]: https://github.com/ryangswe/riftsight-vision/compare/v0.6.0rc1...v0.6.0rc2
[0.6.0rc1]: https://github.com/ryangswe/riftsight-vision/compare/v0.5.1...v0.6.0rc1
[0.5.1]: https://github.com/ryangswe/riftsight-vision/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ryangswe/riftsight-vision/compare/v0.4.0...v0.5.0
[0.5.0rc2]: https://github.com/ryangswe/riftsight-vision/compare/v0.5.0rc1...v0.5.0rc2
[0.5.0rc1]: https://github.com/ryangswe/riftsight-vision/compare/v0.4.0...v0.5.0rc1
[0.4.0]: https://github.com/ryangswe/riftsight-vision/compare/v0.3.0...v0.4.0
[0.4.0rc2]: https://github.com/ryangswe/riftsight-vision/compare/v0.4.0rc1...v0.4.0rc2
[0.4.0rc1]: https://github.com/ryangswe/riftsight-vision/compare/v0.3.0...v0.4.0rc1
[0.3.0]: https://github.com/ryangswe/riftsight-vision/compare/v0.2.0...v0.3.0
[0.3.0rc1]: https://github.com/ryangswe/riftsight-vision/compare/v0.2.0...v0.3.0rc1
[0.2.0]: https://github.com/ryangswe/riftsight-vision/compare/v0.1.0...v0.2.0
[0.2.0rc4]: https://github.com/ryangswe/riftsight-vision/compare/v0.2.0rc3...v0.2.0rc4
[0.2.0rc3]: https://github.com/ryangswe/riftsight-vision/compare/v0.2.0rc2...v0.2.0rc3
[0.2.0rc2]: https://github.com/ryangswe/riftsight-vision/compare/v0.2.0rc1...v0.2.0rc2
[0.2.0rc1]: https://github.com/ryangswe/riftsight-vision/compare/v0.1.0...v0.2.0rc1
[0.1.0]: https://github.com/ryangswe/riftsight-vision/releases/tag/v0.1.0
