<!-- SPDX-License-Identifier: Apache-2.0 -->

# Extension sessions: the two-frame contract

A session decides when a picture is analyzed, which answer may be shown, and what is shown at
the pointer. `createSession` runs one on a `<video>` or `<img>` of its own page
([browser/README.md](../browser/README.md#createsessionelement-options)). A browser extension
often cannot: the video is in a page it does not own. This page describes how an extension
runs the same session across two frames, with the modules the toolkit builds for it.

**Experimental.** The two entries below, their exports and the messages on this page may change
in a minor release ([stability.md](stability.md#experimental)). The changelog names each change.

## Two hosts, one session

The session's policy is one class, `SessionCore` (`browser/src/session-core.ts`). It holds no
timers and touches no element: its host reports what happens to the picture and the pointer,
and does what it asks. `createWorkerSession` (`browser/src/worker-session.ts`) adds the
analysis workers that serve it. Two hosts use them:

- **The same document: `createSession`.** It listens to its own element, captures the picture
  itself and starts its own worker. Nothing on this page is needed for it.
- **Two frames: an extension.** A **content script** runs in the video page. It watches the
  video and the pointer, and takes a picture when asked. A **compute frame**, a hidden page of
  the extension embedded in the video page, runs the session and the worker. The two talk by
  `window.postMessage`, with the messages below.

Each side vendors one entry from `browser/dist/` ([extension.md](extension.md#the-maintenance-kit)):

| Entry | Side | Main exports |
| --- | --- | --- |
| `dist/page-capture.js` | content script | `createCaptureControl`, `fromExtensionFrame`, `acceptComputeOut`, `postWithTransfer`; the parts it is built from: `watchVideo`, `grabFrame`, `captureAllowed`, `pictureBox`, `fractionIn`; `computeProtocol`, `PROTOCOL_VERSION` |
| `dist/compute-session.js` | compute frame | `startComputeFrame`, `computeProtocol`, `PROTOCOL_VERSION`, `DRIVER_TICK_MS`, `SHOWN_HOLD`; `createWorkerSession` and `SessionCore` for a product that hosts them itself |

Neither entry contains ONNX Runtime, WebAssembly or OpenCV; `browser/test/bundle-purity.test.ts`
checks it. The compute frame also vendors `dist/worker.js` and the files the worker loads:
ONNX Runtime's `ort-wasm-*` files, and OpenCV.js when the geometric stage is on.

## The messages

Every message is a plain object `{ [tag]: 1, kind, ... }`. The tag is the extension's own:
`computeProtocol(tag)` returns `tag(message)`, which adds it, and the two parsers,
`parseComputeIn` and `parseComputeOut`, which return the checked message or `null`. A tag is
lowercase letters, digits and hyphens, starts with a letter, and is not a field name of the
messages; another throws a `TypeError`. The default is `"cardvision"`. Both sides use the same
tag. A parser keeps only the fields it knows: extra fields are ignored.

**Content script to compute frame** (`ComputeIn`):

| `kind` | Fields | Checked on arrival |
| --- | --- | --- |
| `hello` | `version` | a positive integer: the content script's `PROTOCOL_VERSION` |
| `pointer` | `x`, `y`, `mediaTime`, `touch` | `x` and `y` in fractions of the picture, from 0 to 1; `mediaTime` a finite number of seconds; `touch` a boolean |
| `leave` | none | |
| `presented` | `mediaTime` | a finite number |
| `discontinuity` | `newSource` | a boolean: `false` for a seek, `true` for another source |
| `cut` | none | reserved: no page helper sends it yet |
| `frame` | `requestId`, `bitmap`, `mediaTime` | `requestId` a positive integer; `bitmap` an `ImageBitmap` of 1 to `MAX_FRAME_SIDE` (4096) pixels a side; `mediaTime` a finite number. A refused frame's bitmap is closed. |
| `capture-failed` | `requestId`, `reason`, `retry` | `requestId` a positive integer; `reason` a string, cut to `MAX_REASON_LENGTH` (200) characters; `retry` counts only when it is `true` |

**Compute frame to content script** (`ComputeOut`):

| `kind` | Fields | Checked on arrival |
| --- | --- | --- |
| `ready` | `version`, `instance` | `version` a positive integer: the frame's `PROTOCOL_VERSION`; `instance` 16 lowercase hexadecimal characters |
| `status` | `state`, `error`, `backend` | `state` is `loading`, `ready` or `failed`; `error` and `backend` a string, cut to `MAX_TEXT_LENGTH` (200) characters, or `null` |
| `capture` | `requestId`, `analysisWidth` | `requestId` a positive integer; `analysisWidth` `{ min, max }`, whole numbers from 1 to `MAX_FRAME_SIDE` (4096), `max` at least `min` |
| `shown` | `card` | `null`, or `{ cardId, name, box, others, releaseId? }`: `cardId` and `name` 1 to `MAX_TEXT_LENGTH` (200) characters; `box` four finite numbers (`x`, `y`, `width`, `height`), width and height above 0; at most `MAX_OTHER_BOXES` (40) `others`, a malformed one dropped; a `releaseId` other than 16 lowercase hexadecimal characters dropped |

A message with another tag, an unknown `kind` or a field out of range parses to `null`.

What the limits mean:
- Text lengths are counted as JavaScript counts them, in UTF-16 code units. A card id or name
  over 200 refuses the whole `shown`: check your catalog's names before a release.
- `MAX_FRAME_SIDE` bounds the analysis frame, the picture after it is scaled to the analysis
  width, not the source video. A very tall portrait picture can still exceed it, and is then
  refused page-side (`grabFrame`: "the picture is too large"). The compute frame asks for an
  `analysisWidth` of at most `MAX_FRAME_SIDE`, whatever the release allows.
- `box` and `others` are not clamped to 0..1: a card at the edge can reach past the picture.
  Clip them for drawing.
- `releaseId` and `instance` are lowercase only. They are identifiers, not secrets.
- The limits keep each message well formed. They do not bound what a hostile page can make the
  browser receive or copy before a message is checked.

What the messages mean:
- `hello` asks the frame to say `ready` again, with its current status and shown card (see
  [the handshake](#the-handshake)).
- `pointer` is real movement only: a pointer resting on the picture is not activity. With
  `touch`, a tap opens the active window and leaves no resting pointer.
- `presented`: the video showed a new picture (playback, a seek ended, the video became ready).
- `capture` asks for the picture on screen now, at a width within `analysisWidth`. The content
  script answers with `frame` or `capture-failed`, with the same `requestId`. `retry: true`
  means the picture itself could not be had (not ready yet, or blank) and is worth asking again.
- `shown` is what a tooltip shows for the pointer's position now, sent when it changes. `others`
  are the boxes of the other cards of the same analysis, for placing a tooltip off them.
- `status`: the content script assumes `loading` until told otherwise. `backend` is set only
  while `ready`. A status is posted when the state, the error or the backend changes, `loading`
  again whenever a remote release's files start to download, and in every answer to a `hello`.
- `ready` says the frame can take messages, not that the model has loaded: `status` says that.

## The handshake

The frame posts `ready {version, instance}` once on its own, as soon as its session can take
messages, so the first `presented` is not lost. A session whose first worker cannot be made
counts: `ready` is then followed by a `failed` status. `instance` is made once per frame, so a
content script can tell a reloaded or replaced frame from the one it spoke to.

The content script may also ask, with `hello {version}`, any number of times: after it made or
replaced the iframe, or when it starts late beside a frame that is already running. Once a
session exists, the frame answers each `hello` with `ready`, the current status and the current
shown card, whatever the hello's version, and calls `onShown` again before that card. Only the
content side enforces the version: a content script from before version 1 beside a version 1
frame still works, with no check. A hello changes nothing else: no worker or session is made
again. While the frame chooses a release it
ignores a hello; its own `ready` follows once the session exists. It answers after it has
failed, with the `failed` status.

The controller below says `hello` from `connect()` until a `ready` comes (`helloRetries`, 10 by
default, about 16 s), and compares versions. It sends nothing while the iframe still holds its
first `about:blank` page, which has the video page's origin: a message for the extension's origin
would only be dropped there, with an error in the page's console. Those waits (up to a minute)
do not count as tries, so `connect()` may be called as soon as the iframe is appended. An iframe
still on `about:blank` after that minute (nothing loaded in it) is reported as `no-answer`.
- **Another version:** nothing is captured, and `onProblem` hears
  `{ kind: "version", expected, received }`. Reloading the page or the extension usually mends it.
- **A frame from before contract version 1** neither parses `hello` nor sends a `ready` that
  parses: nothing answers, and `onProblem` hears `{ kind: "no-answer" }` once the hellos run out.
  A `ready` that comes later still counts.
- **A new instance:** the record of a card showing is cleared, a pointer is kept only if it is
  still within its window over the picture, and the picture's time and that pointer are sent
  again. The same instance again changes nothing.

## The origin and source rule

`startComputeFrame` returns `null` unless the frame is inside another page (`framed`) whose
origin (`parentOrigin`) the extension's own predicate allows (`allowedParentOrigin`). It then
acts only on messages whose `event.source` is its parent window and whose `event.origin` is
that origin, and it posts only to that window, with that origin.

That is not enough to trust a message. The page itself runs in the parent window, so it can post
to the frame as well as the content script can, and it can read the frame's replies. Nothing in
the messages is secret: pictures are what the page already shows, replies are card names and
boxes. What the page must not be able to do is make the extension take pictures when the viewer
is not pointing at the video. That is the content script's job, below.

## The content script: `createCaptureControl`

`createCaptureControl` (`browser/src/capture-control.ts`) is the content script's half in one
place: the capture gate, the handshake, the video's events and the transfer of pictures. A
product picks the video (`attach`), draws the card (`onShown`) and may narrow where a pointer
counts (`eligible`: its own overlays and controls; by default, the video's picture).

### Who may make the extension take a picture

The page shares the window with the content script. It can post messages to the compute frame,
dispatch made-up events, and move or swap the video under a resting pointer. It cannot make a
pointer event that the browser marks as trusted. So the controller gives pictures only on the
authority of trusted pointer events (`event.isTrusted`), and checks again at each capture:

- **Hover** (mouse, pen): within `POINTER_GRACE_MS` (10 s) of the last trusted event over the
  picture, or while a card shows and for `READING_LINGER_MS` (5 s) after one last showed, and in
  every case only while that last trusted point is still over the picture.
- **At most `MAX_REST_MS` (60 s)** after the last trusted event, whatever else holds: a card
  showing, or the linger after one, never stretches authority past it. A fresh trusted move
  starts it again. `GateLimits.restMs` (the controller's `limits`) changes it.
- **Tap** (touch): `POINTER_GRACE_MS` from the tap, and no longer. A card showing never extends
  it. The finger lifting does not end it (the picture the tap asked for is taken after the
  finger is up); a canceled touch does, and another pointer inherits nothing. A tap needs the
  picture to receive pointer events: on a `<video controls>` element, Firefox's native controls
  take the touch and the page sees only `pointerleave`. And the window is not stretched for a
  cold start: on a slow machine, a tap made while the models still load may show nothing, and
  the next tap works.
- **Before every capture**, the last trusted point is checked again against the picture as it is
  laid out now, with `eligible`. A video that moved away under a resting pointer clears the gate
  and refuses the capture. The default `eligible` checks geometry only: something laid over the
  video is caught only by a product `eligible` that hit-tests (for example with
  `document.elementsFromPoint`).
- **Full resets** clear all of it, the record of a card showing included, and send `leave` when
  a pointer held authority: the pointer leaving the picture or the document, the page hidden, a
  canceled pointer, another source in the video, another video (or none).
- **A new compute frame instance** is not a full reset: it clears the record of a card showing
  and drops a pending capture, keeps a pointer only if it is still within its window over the
  picture, and sends no `leave` (see the handshake above).
- **One capture at a time.** A second request while one is pending is refused (`CAPTURE_PENDING`).
- **Stale pictures are closed.** A picture whose capture began before a reset, a change of video
  or source, or a new frame instance is closed, never sent; the same frame hears
  `PICTURE_CHANGED`.
- **Transfer is exception-safe.** `postWithTransfer` closes the bitmap when posting throws or
  the frame is gone, and never touches one it transferred.

A refused capture is answered `capture-failed` with `retry: false` and the reason
(`NOT_POINTING`, `CAPTURE_PENDING` or `PICTURE_CHANGED`).

The page can still steer what the frame reports as `shown` (it can post `pointer` to the frame),
so the "card showing" branch is only as strong as the hover it rests on: it never starts
capture, and it ends with any reset or failed check of the last trusted point. That is the
promise to describe, and no more: pictures are taken on a trusted hover over the picture, for a
bounded time after a tap, and, while a card shows and for a few seconds after one last showed
(`READING_LINGER_MS`), only as long as the last trusted point is still over the picture; never
more than 60 s (`MAX_REST_MS`) after the last trusted pointer event.

`captureAllowed(state, now, limits)` (`capture-gate.ts`) is the pure rule, the 60 s cap
included, that the controller applies to its four fields (`inside`, `lastTrustedPointerAt`,
`tooltipShowing`, `lastTooltipAt`; `gateState()` returns them). A product that keeps its own
bookkeeping can use it, and must then do everything above itself.

**Listening.** `listen(window, document)` takes pointer events and `visibilitychange` on
`window`, in the capture phase (`visibilitychange`, fired at the document, reaches the window
first). Call it as early as the content script runs. That helps, but it does not make the events
impossible to hide: a page listener registered earlier can call `stopImmediatePropagation`, and
a frame the page lays over the document takes the pointer events itself. A page that hides the
events that end authority can keep the last trusted point in place after the pointer has gone,
and with it the authority above, a card showing included, for at most 60 s (`MAX_REST_MS`) after
the last real movement. It cannot create authority: that takes a trusted event the controller
saw.

### Messages from your own frames

Check every `message` event from one of the extension's frames before reading its data.
`fromExtensionFrame(event, frame, origin)` is true only for a trusted event (`event.isTrusted`)
whose `source` is that frame's window and whose `origin` is the extension's. Source and origin
alone are not enough: a page script can make a `MessageEvent` with both set and dispatch it on
the window it shares with the content script, and such an event is not trusted. (Chrome lets a
page build such an event, and the `isTrusted` check is what stops it; Firefox refuses to build one
with an extension frame's window as its `source`.) Use it for every
frame of yours, a tooltip frame too. `acceptComputeOut(event, { frame, origin, protocol })` adds
the parse for the compute frame, and the controller's `onMessage` uses it.

### Old replies after a switch

A `shown` the frame posted before it handled a `discontinuity` can arrive just after the switch;
when a card was showing, the frame follows it with `shown` `null`. The controller passes every
`shown` from its frame to `onShown`, but notes a card for the gate only while a pointer holds
authority, so a late card revives nothing. A product that wants no stale tooltip even for that
moment draws a card only while `gateState().inside` is true.

## Retries

There is one back-off counter, the scheduler's (`browser/src/frame-scheduler.ts`). A look that
comes back with the picture not analyzed (answered busy, given up on by the watchdog, or a
capture that failed with `retry: true`) makes the same picture due again after 250 ms, 500 ms,
1 s, then every 2 s. The watchdog gives up on a look after 5 s, or after 15 s until the worker's
first analysis since its release loaded: that one warms the models up, and on a slow machine it
can take several times as long. A failed capture is retried promptly: once its back-off runs out, the look is
due whatever the cadence; the other retries also wait for the cadence. A pointer move never
shortens a back-off still waiting. A refusal (`retry: false`: the gate, an unreadable video, a
picture too large, no 2D context) is retried by nothing and grows no back-off; the next pointer
move over the picture asks again, at the cadence, as it does when a retry was used up with no
answer. So a viewer who leaves a paused video and comes back gets a look. After failed captures,
a picture that arrives starts the back-off over: if the worker then answers busy, the retry
comes after 250 ms. A worker that stays busy is backed off from up to 2 s, whatever pictures
reach it. An analyzed answer, a seek or a new source start the back-off over; the pointer
leaving does not.

## The worker

`createWorkerSession`, which `startComputeFrame` runs, owns the worker's lifecycle:

- A worker that stops before the release has loaded fails the session ("the worker did not
  start").
- A worker that stops after the release has loaded is ended and what it found is cleared
  (`shown` with `null`, when a card was showing). The status is `loading` (the compute frame
  posts it with no backend), `onGeometricStatus` hears the geometric stage turned off with the
  reason `worker-restarted`, and a new worker loads the bundled release once, without the
  geometric stage (`plainLoad`).
- If the restarted worker stops too, the session fails ("the recognition worker stopped").
- A worker that cannot even be made fails it at once ("the recognition worker could not start").
- Messages and errors from a worker that was replaced are ignored.

With `chooseRelease`, the frame may load a remote release, and `createWorkerSession` applies
rules 10 to 12 to the worker's answer: a refusal, another id or a worker that never starts falls
back to the bundled release without using up the restart, and a remote worker that stops after
loading restarts once on the bundled release.
[remote-releases.md](remote-releases.md#rules-10-to-12-the-workers-answer) has the rules, the
skip-list and the log reasons. While the release is chosen there is no session: messages are
dropped and a picture is closed.

### Where a load's time goes

Once a release loads, the session's status says where the time went:
`frame.core?.status().release?.loadTimings` in the compute frame (`LoadTimings` in
`browser/src/load.ts`, whole ms). It holds:

- `startedAtMs`: when the load began on the worker's clock, so it counts loading the worker's
  script and ONNX Runtime's module;
- `filesMs`: fetching, checking and reading the release's files (for a remote release, whose
  files `chooseRelease` downloaded before, only the checks and reads);
- `recognizer` and `detector`: each model's session create, first run and total, the total
  counting any provider tried before that failed;
- `totalMs`: the whole load.

ONNX Runtime starts a backend on the first session created on it. The recognizer is prepared
first, so that time is in its `createMs`, or in its `totalMs` when a provider before failed.
A first run pays one-off allocation and, on WebGPU, shader compilation, so on a slow machine it
can take many times longer than the runs after it. It is measured only, never used to decide
anything, and nothing in it leaves the compute frame. A worker older than 0.7.0 leaves it out.

## What each side must do

- **The driver tick.** Nothing in the compute frame runs on its own. Call `tick()` every
  `DRIVER_TICK_MS` (250 ms): the cadence, the repeats of a still picture and the watchdog are
  checked there. Keep the interval's handle and clear it when the frame shuts down:
  `frame.stop()` does not. `createSession` runs its own.
- **Bitmaps.** In the compute frame, the window's `message` channel belongs to this contract:
  every `ImageBitmap` posted to it as a top-level field of a message is taken or closed, whatever
  its tag or sender, until `frame.stop()` removes the listener. Bitmaps nested deeper in a
  message are not looked for. Do not add a second `message` listener there that keeps a received
  bitmap. A `frame`'s bitmap belongs to the session from the moment it is handed over: the
  session closes it or sends it to the worker, and when sending throws it closes it and asks
  again later. On the page side, `grabFrame`'s caller owns the bitmap it returns: the controller
  transfers it with `postWithTransfer` or closes it.
- **`releaseId`.** A `shown` card carries `releaseId` when it was recognized with a remote
  release whose id the worker confirmed, and not for the bundled release. It names the release
  the card came from; it does not promise that you have details for it. A tooltip without a row
  for the card falls back to its own table.
- **The `onShown` card.** `startComputeFrame` calls `onShown(card, release)` before it posts
  `shown`, the answer to a `hello` included, with the object it then posts. Read it; do not
  change it. Details you send from there by another channel leave first, but nothing makes them
  arrive first: join them to the card by `cardId` and `releaseId`, or fall back to your own table.
- **The hold.** `hold: SHOWN_HOLD` keeps a shown card through short gaps: until two analyses in
  a row have nothing there, or 5 s pass with no analysis seeing it. A reply with nothing analyzed
  (busy, or an error), or an analysis that comes back older than `hover.maxAgeMs` (slow, on a playing video),
  is not one of the two: only the 5 s end the hold then. Another card at the pointer,
  or the pointer leaving the card's box, ends it at once. It keeps a tooltip from flickering on a
  live stream, and is off when absent.

Without the controller, a content script built from `watchVideo` and `grabFrame` must also:
- **send `discontinuity` with `newSource: true` on every switch of video,** a switch to no video
  included: `watchVideo` reports seeks, new sources and presented pictures of the video it
  watches, but not that it started watching;
- **date pointer messages with `watch.mediaTime()`** and capture with `grabFrame(watch, ...)`.
  The watch owns the time a paused live stream last played, so a frozen picture and the pointer
  over it carry the same time. The compute frame judges a result's age (the release's
  `hover.maxAgeMs`) against the time last reported by `pointer` or `presented`; a paused video
  presents nothing, so pointer messages keep that time current.

## What stays yours

The toolkit has the session's two halves, not the extension around them:

- **Drawing:** the tooltip, the outline, their placement (`box` and `others` are in fractions of
  the picture; `pictureBox` gives the picture's box on the page).
- **The site:** which pages the extension runs on, which video is the main one (`attach`), and
  where over the video a pointer counts (`eligible`).
- **Card details:** a channel of your own from `release.table` in `onShown`
  ([remote-releases.md](remote-releases.md#card-facts) says how they must be checked); the
  viewer's language ([languages.md](languages.md)).
- **Store wording:** what you tell a store's reviewers and your users about when a picture is
  taken. Describe the rule above, no more.

## Wiring: the content script

A sketch, not a product: one video, no drawing, no picking of the main video.

```js
import { computeProtocol, createCaptureControl } from "./vendor/cardvision-browser/page-capture.js";

const frameUrl = new URL(COMPUTE_FRAME_URL);   // the extension page that hosts the session
const iframe = Object.assign(document.createElement("iframe"), { src: frameUrl.href, hidden: true });

const control = createCaptureControl({
  protocol: computeProtocol("my-extension"),
  frame: () => iframe.contentWindow,
  frameOrigin: frameUrl.origin,
  onShown: (card) => draw(card),               // yours: the tooltip and the outline
  onProblem: (problem) => console.warn("compute frame:", problem.kind),
});
control.listen(window, document);              // as early as the content script runs
window.addEventListener("message", (event) => control.onMessage(event));

document.documentElement.append(iframe);       // after the message listener
control.connect();                             // hello until the frame says ready
control.attach(document.querySelector("video"));   // again on every switch of video
```

`control.stop()` removes the listeners, the watch and the timers.

## Wiring: the compute frame

The extension page in the iframe. `startComputeFrame` takes the options of
`createWorkerSession` too (`mode`, `hold`, `chooseRelease`, `recordSkip`, `onDecision`,
`onGeometricStatus`, ...).

```js
import { computeProtocol, DRIVER_TICK_MS, SHOWN_HOLD, startComputeFrame }
  from "./vendor/cardvision-browser/compute-session.js";

const ancestor = location.ancestorOrigins?.[0] ?? null;
const frame = startComputeFrame({
  win: window,
  framed: window.parent !== window,
  parentOrigin: ancestor === "null" ? null : ancestor,                  // see below
  allowedParentOrigin: (origin) => VIDEO_SITE_ORIGINS.includes(origin),  // exact origins
  protocol: computeProtocol("my-extension"),
  createWorker: () => new Worker(new URL("./vendor/cardvision-browser/worker.js", import.meta.url), { type: "module" }),
  loadRequest: { kind: "load", releaseUrl: new URL("./release/release.json", location.href).href },
  now: () => performance.now(),
  hold: SHOWN_HOLD,
  onShown: (card, release) => {
    // Card details for your tooltip, from release.table, by your own channel.
  },
});
const ticker = frame ? setInterval(() => frame.tick(), DRIVER_TICK_MS) : null;
addEventListener("pagehide", () => {
  clearInterval(ticker);
  frame?.stop();
});
```

**The parent's origin.** Chrome and Firefox 148 or later provide `location.ancestorOrigins`; a
Firefox extension should set `browser_specific_settings.gecko.strict_min_version` to at least
"148.0". It may be missing, or be the string "null": `??` does not catch the string, so turn it
into `null` as above, or make sure `allowedParentOrigin` refuses it. A referrer policy that
hides the parent's origin from the frame makes it "null": `referrerpolicy="no-referrer"` on the
iframe, and also `same-origin` (the extension frame is of another origin). A policy the iframe
inherits from the page can do the same. Do not set such a policy on the compute frame, and
expect a page's own policy to stop it in some cases: the address fallback below covers those.
With no usable origin, `startComputeFrame` returns `null` without an error.

Where the origin is missing, the content script can pass it in the frame's address. That value
is a claim, not proof of who embedded the frame: accept only an exact origin your list allows,
refuse "null", and leave the source and origin check on every message to `startComputeFrame`. A
page that lies in the address still cannot send a message with an allowed origin. It can make
the frame start, though, so a product that minds can wait to call `startComputeFrame` until a
checked message (a `hello`) has arrived from that origin.

`frame.release` says which release is in effect (`source`, `id`, `reason`, `table`), and
`frame.core?.status()` (no core while a release is chosen) gives the same fields as
`createSession`'s `status()`.
