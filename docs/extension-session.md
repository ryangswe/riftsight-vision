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
| `dist/compute-session.js` | compute frame | `startComputeFrame`, `computeProtocol`, `PROTOCOL_VERSION`, `DRIVER_TICK_MS`, `SHOWN_HOLD`, `READING_HOLD`; `createWorkerSession` and `SessionCore` for a product that hosts them itself |

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
| `intent` | none | the viewer is probably about to want recognition; sent only with the controller's `intent: "page"` (below). A frame that unloaded its worker when idle loads it again; otherwise it counts as activity. Added in version 2. |
| `presented` | `mediaTime` | a finite number |
| `discontinuity` | `newSource` | a boolean: `false` for a seek, `true` for another source |
| `cut` | none | reserved: no page helper sends it yet |
| `frame` | `requestId`, `bitmap`, `mediaTime` | `requestId` a positive integer; `bitmap` an `ImageBitmap` of 1 to `MAX_FRAME_SIDE` (4096) pixels a side; `mediaTime` a finite number. A refused frame's bitmap is closed. |
| `capture-failed` | `requestId`, `reason`, `retry` | `requestId` a positive integer; `reason` a string, cut to `MAX_REASON_LENGTH` (200) characters; `retry` counts only when it is `true` |

**Compute frame to content script** (`ComputeOut`):

| `kind` | Fields | Checked on arrival |
| --- | --- | --- |
| `ready` | `version`, `instance` | `version` a positive integer: the frame's `PROTOCOL_VERSION`; `instance` 16 lowercase hexadecimal characters |
| `status` | `state`, `error`, `backend` | `state` is `loading`, `ready`, `failed` or `idle` (version 2: the worker was ended on purpose, see "Idle unload"); `error` and `backend` a string, cut to `MAX_TEXT_LENGTH` (200) characters, or `null` |
| `capture` | `requestId`, `analysisWidth` | `requestId` a positive integer; `analysisWidth` `{ min, max }`, whole numbers from 1 to `MAX_FRAME_SIDE` (4096), `max` at least `min` |
| `shown` | `card` | `null`, or `{ cardId, name, box, others, releaseId?, held? }`: `cardId` and `name` 1 to `MAX_TEXT_LENGTH` (200) characters; `box` four finite numbers (`x`, `y`, `width`, `height`), width and height above 0; at most `MAX_OTHER_BOXES` (40) `others`, a malformed one dropped; a `releaseId` other than 16 lowercase hexadecimal characters dropped; `held` kept only when `true` |

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
- `shown` is what a tooltip shows for the pointer's position now, sent when it changes: another
  card or none, `held`, or a box or outline that moved more than a look's own wobble (an edge
  more than 5 % of the card's size, a tilt more than 2 degrees), so `box` can be that much off
  the newest look. `others` are the boxes of the other cards of the same analysis, for placing a
  tooltip off them. `held: true` (a reading hold only) says to draw no outline for the card:
  two analyses in a row showed it gone from where it was last seen (`box`; one on a still
  picture), or no recent analysis is left to show it there. Keep the tooltip.
- `status`: the content script assumes `loading` until told otherwise. `backend` is set only
  while `ready`. A status is posted when the state, the error or the backend changes, `loading`
  again whenever a remote release's files start to download, and in every answer to a `hello`.
- `idle`: the frame has ended its worker to give the memory back and is waiting for a `pointer`
  or an `intent` (see "Idle unload"). `error` and `backend` are `null`.
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
content side enforces the version: a content script from before version 1 beside a frame of
version 1 or later still works, with no check. The contract is at version 2 (version 1 had no
`idle` state and no `intent` message); a product vendors both halves together, and a content
script and a frame of different versions report the mismatch above. A hello changes nothing else: no worker or session is made
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
- **Slow start** (hover only): when the compute frame's `status` becomes `ready` (its model
  loaded; the handshake is not the moment) while a mouse rests over the picture past its grace
  period, the next capture the frame asks for is given, as long as the last trusted point is still
  over the picture and within `MAX_REST_MS` (60 s) of the last trusted event. It is one picture:
  that capture spends the grant whatever it brings, except a capture that failed for want of a
  picture (`retry: true`), whose prompt retry is part of the same picture. If the look finds a
  card, the card keeps the gate open under the hover rule above; if not, nothing more is given
  until the pointer moves. A new trusted move, a full reset and a new frame instance drop the
  grant; a `ready` status repeated (with no other status between) grants nothing. The frame posts
  its `ready` status before the capture the load asks for, so the grant is there when the request
  arrives. A tap gets none.
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
bounded time after a tap, once when the model finishes loading under a resting mouse, and, while a
card shows and for a few seconds after one last showed (`READING_LINGER_MS`), only as long as the
last trusted point is still over the picture; never more than 60 s (`MAX_REST_MS`) after the last
trusted pointer event.

`captureAllowed(state, now, limits)` (`capture-gate.ts`) is the pure rule, the 60 s cap
included, that the controller applies to its four fields (`inside`, `lastTrustedPointerAt`,
`tooltipShowing`, `lastTooltipAt`; `gateState()` returns them); `slowStartAllowed` is the slow
start's check (inside, within the 60 s cap), which the controller applies once per grant. A product
that keeps its own bookkeeping can use them, and must then do everything above itself.

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
shortens a back-off still waiting, and no look of any kind starts while one waits: not the
cadence on a playing video, not a pointer move over a stale picture, not a relook, not a cut, not
the look when a load ends. A seek or a new source drops the retry with its picture. A refusal (`retry: false`: the gate, an unreadable video, a
picture too large, no 2D context) is retried by nothing and grows no back-off; the next pointer
move over the picture asks again, at the cadence, as it does when a retry was used up with no
answer. So a viewer who leaves a paused video and comes back gets a look. After failed captures,
a picture that arrives starts the back-off over: if the worker then answers busy, the retry
comes after 250 ms. A worker that stays busy is backed off from up to 2 s, whatever pictures
reach it. An analyzed answer, a seek or a new source start the back-off over; the pointer
leaving does not.

## Pointer entry

In the `"pointer"` mode the compute frame asks for no picture while the pointer is off it: from a
`leave` until the next `pointer` message, the core sends no `capture`. Everything else goes on
while the pointer is outside: the watchdog, the replies, what is shown. A leave changes no retry
state (a back-off still waiting keeps counting) and is not a seek.

When the pointer comes back, the existing staleness rule decides, in video time. The newest look
is stale when

```text
abs(now - lastStarted) * 1000 > max(400, B)
B = max(F, min(P, L - R - M))
```

where `now` is the video time of the picture on screen, `lastStarted` the video time of the
newest look asked for, both in seconds, F the fast cadence (500 ms on WebGPU, 1000 ms on
WebAssembly), P the paced wait of an active pointer (F with pacing off, and until 3 analyses are
measured), L the answer's lifetime in wall time (the release's `hover.maxAgeMs` divided by the
playback rate, which the compute frame measures from the video times it is sent), R the median
round trip of the last 5 analyses that were not reused, and M one driver tick (250 ms). B is F until
a round trip is known. A stale look is asked for on that `pointer` message itself, when the session
is ready, nothing is in flight, no retry is waiting out its back-off and the last look started by
the pointer is at least 250 ms (`HOVER_TRIGGER_MIN_GAP_MS`) old. Without this, the frame went on asking at the cadence for the
10 s after a leave, the content script refused each request, and each refused request counted as
the newest look: a pointer that came back within those 10 s waited for the cadence.

A tap counts as a pointer over the picture until the content script sends `leave`, which
`createCaptureControl` does for a touch that moves outside, a tap elsewhere, a canceled touch,
a hidden page and a replaced video. A tap after a mouse leave asks as a mouse move does.

When a load ends (the first load, a fallback, a restart or an idle resume) with the pointer
eligible, the frame asks for a look at once, instead of waiting up to `DRIVER_TICK_MS` for the
next tick or for the cadence: the viewer is waiting on it, so the paced wait does not hold it back.
Only a retry waiting out its back-off does. Eligible means over the picture with pointer activity
within the grace period (10 s, `POINTER_GRACE_MS`) for a mouse, or a tap whose window (the same
10 s from the tap) is still open. A pointer that left is not eligible. No pointer activity is made
up for it, and the content script's gate still decides on the capture.

A mouse that rests over the picture past the grace period, within `MAX_REST_MS` (60 s) of its last
activity, gets a slow start instead: one look when the load ends, and its failed capture's prompt
retry, but nothing else. If that look finds a card, the card keeps analysis going under the usual
rules (the reading state, and the gate's card-showing branch); if it finds nothing, nothing more is
asked until the pointer moves. A tap whose window closed gets none. The frame posts the `ready`
status before that look's `capture` ("Who may make the extension take a picture").

Limits:

- A capture or analysis in flight when the pointer leaves stays in flight. A return before it
  finishes asks no second one. If the page refuses that capture, the refused look still counts
  as the newest one, so a return soon after it can wait for the cadence; no time is rolled back.
- Staleness is measured in video time, not wall-clock time. A video that plays slowly or
  buffers, or a long budget B (WebAssembly, measured pacing with a short round trip), may not
  pass it after a given time away, and the return then waits for the cadence as before.
- A paused picture with a current result is not stale: a return asks for no new analysis. A
  face left unverified in focus scope (`geometricScope: "focus"`) still gets its relook, and
  repeats scheduled before the leave run after the return.
- The `"always-on"` mode is unchanged: the option has no effect there.
- `startComputeFrame` turns it on; pass `entryLook: false` to turn it off. A `SessionCore` made
  directly, and `createWorkerSession`, have it off unless given `entryLook: true`, so a host that
  drives the core itself keeps its behavior until it opts in. The core is made once per frame,
  so the setting holds through a fallback, a restart and an idle resume.

No message is added and `PROTOCOL_VERSION` stays 2.

## An unverified face on a playing video

In focus scope (`geometricScope: "focus"`) with the geometric stage ready, a look verifies the
faces at the pointer as it was when the look was asked for and leaves the other faces
unverified, and nothing is named on them. A pointer that reaches such a face on a playing video
used to wait for the next cadence look: the relook for an unverified face was limited to a still
picture, and the staleness rule above needs `max(400, B)` ms of video time.

Now a pointer on a face the newest analysis left unverified (or on a group of overlapping faces
that holds one, which is where nothing is named) gets a look with the pointer there as soon as
all of these hold:

- the session is ready and the geometric stage is ready;
- the pointer is active over the picture: a move within the grace period (10 s,
  `POINTER_GRACE_MS`), or a tap whose window is still open;
- the picture is playing on from the newest analyzed frame: a newly presented frame waits and
  its video time has moved since that frame;
- nothing is in flight, no retry is waiting out its back-off, and no capture was refused since
  the picture was last answered;
- the last look of any kind started at least F ago, start to start: the fast cadence, 500 ms on
  WebGPU and 1000 ms on WebAssembly. The viewer waits on this look, so it is not paced: with
  `measuredPacing` the spacing is still F, not the paced wait.

It is checked on each `pointer` message, on the reply of a look, and on each tick. So a pointer
that lands on the face while a look is in flight, and rests there, gets its look when that look
returns, or F after that look started if the reply came sooner (on the next message or tick).
The page's gate still decides on the capture, and with `entryLook` nothing is asked while the
pointer is off the picture. A pointer on a named face, or on no face, asks nothing extra. A sweep
across several unverified faces asks at most one look per F, and never a second while one is in
flight.

Limits:

- A pointer that rests past the grace period asks nothing more, as for a still picture's relook.
- A pointer that sweeps across unnamed cards on a playing video asks up to one look per F, where
  it used to wait for the cadence. With measured pacing on a slow computer that is more analysis
  than the pacer's share while the sweep lasts.
- A still picture, scope `"all"`, a session with no stage or a stage still loading, and the
  `"always-on"` mode are unchanged.
- It changes when a look is asked for, not what a look answers.

No message is added and `PROTOCOL_VERSION` stays 2.

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
- A bundled release that does not load (the worker stops before loading, or answers that the
  release did not load, the restarted worker included) turns recognition off for good: the
  worker is ended, `stopped` is true, and the status stays `failed` with the reason. The compute
  frame then closes the pictures it is sent and still answers `hello` with that status.
- Messages and errors from a worker that was replaced are ignored.

With `chooseRelease`, the frame may load a remote release, and `createWorkerSession` applies
rules 10 to 12 to the worker's answer: a refusal, another id or a worker that never starts falls
back to the bundled release without using up the restart, and a remote worker that stops after
loading restarts once on the bundled release.
[remote-releases.md](remote-releases.md#rules-10-to-12-the-workers-answer) has the rules, the
skip-list and the log reasons. While the release is chosen there is no session: messages are
dropped and a picture is closed.

### The geometric stage

With a `geometricUrl` in the load request, the worker loads the geometric stage after the
release. Frames are analyzed without it until it is ready, and it joins between two frames; its
status (`onGeometricStatus`, `status().geometric`) reads `loading`, then `ready` or `off`. The
option `geometricLoad` says when it loads:

- `"start"` (the default, and the behavior before the option): with the release. Its status reads
  `loading` from the start.
- `"pointer"`: the worker loads the release without the stage, and the first `pointer` message
  has the worker load it: at once when the release is ready, or as soon as it is when the
  `pointer` arrived while it loaded (a pointer resting over the video through the load). A frame
  made when a video plays then neither downloads nor holds the stage's index until the viewer
  points at the picture. Until then its status is `null` (or stays `off` with the reason
  `idle-unload` after a resume); it reads `loading` once the worker has the request. An
  `intent`, a `presented` or a `hello` never counts, and a `pointer` kept for a load is dropped
  when the frame stops.
- With `"pointer"`, the looks after that `pointer` run without the stage for as long as it takes
  to load, as looks do whenever it is still loading. A look the worker is analyzing when the
  request arrives is answered without the stage, and the stage joins after it.
- `startComputeFrame` reports each `pointer` message to its session. A host that runs
  `createWorkerSession` directly with `"pointer"` calls `session.pointed()` on each pointer over
  the picture; otherwise the stage never loads.
- The request is the worker's own `load-stage` message, between the compute frame and its worker,
  which are vendored together. No message is added between the two frames, and `PROTOCOL_VERSION`
  is unchanged.
- Once ready, the stage behaves the same with either value: its watchdog (and the load request's
  `geometricWatchdog`), `geometricScope: "focus"`, and its turning off for the rest of the session.
- A restarted worker loads no stage with either value (`plainLoad`).
- A value other than `"start"` or `"pointer"` throws a `RangeError` when the frame starts.

### Idle unload

A ready session holds the models' memory, and WebAssembly memory never shrinks, so only ending
the worker gives it back. `startComputeFrame({ idleUnloadMs })` (a positive finite number of
milliseconds; any other value throws a `RangeError`; off when absent, which is the behavior of
version 1) ends the worker when, for that long, there has been no `pointer` message, no `intent`
message, no card shown and no look in flight. Time is counted from `ready`, by `now()`, on each
`tick()`.

- The frame stays, with its handshake. The status is `idle`, the driver tick does nothing and no
  picture is asked for. A `hello` is answered with `ready` and the `idle` status.
- A `pointer` or an `intent` message loads a new worker with exactly the load request in effect
  (a remote release included, with nothing chosen or read again). The status goes `loading`, then
  `ready`.
- It is not a crash: the restart is not used up (`restarts` is unchanged), the bundled release is
  not substituted, and a crash after a successful resume still gets its one restart.
- If the resumed load itself fails (the worker refuses the release, or stops while it loads), that
  takes the one restart, as a crash after `ready` does: the frame loads the bundled release with
  the plain request, `release` reads `bundled` with the reason `worker-restart` (and the decision
  line is logged for a remote release), nothing is skip-listed, and nothing is chosen again. Only
  with the restart already used is recognition off for the page.
- A geometric stage the worker had turned off stays off for the rest of the session: the resume
  loads the request without the stage. A stage that was running is reported off with the reason
  `idle-unload` while idle (to the status and to `onGeometricStatus`), and loading again on resume.
  With `geometricLoad: "pointer"` it stays reported off on resume: the resumed worker loads the
  release without it, and waits for a new `pointer` message to load it again. A `pointer` that
  resumes the frame counts (the stage loads once the resumed release is ready); an `intent` that
  resumes it does not, and a `pointer` from before the unload never carries over.
  The tilted retry is a setting of the release, not of the request: the new worker starts with it
  on, as after any restart.
- The frame keeps the load request in effect while idle, so a remote release's files (its Blobs)
  stay held in memory; they are a small part of what the worker held. With `idleUnloadMs` off the
  request is not kept, as before.
- In the `"always-on"` mode, each look the cadence asks for counts as activity, so a video that
  keeps presenting frames never unloads there. A paused or stalled video presents none, and the
  frame unloads after `idleUnloadMs`.
- The object `startComputeFrame` returns has a `state`: `idle` while idle, else `loading`, `ready`
  or `failed`, as the posted status says (the core's own status reads `loading` while idle).
- `createWorkerSession` has the calls for it, `suspend()` and `resume()`, and `suspended`; its
  `keepLoadRequest` option (set by the compute frame when `idleUnloadMs` is) keeps the request.
  With `geometricLoad: "pointer"` it also has `pointed()`, which a host that runs it directly
  calls on each pointer over the picture; otherwise the stage never loads.
- The idle clock runs from `ready`, not from the moment the frame was made. A frame made at play
  (see "When to make the frame") spends its load time before the clock starts, and then waits
  `idleUnloadMs` for a pointer. If none comes, the worker ends and the status reads `idle`.
- A first hover after the unload is cold: the worker loads again, which takes as long as any
  load, and the look waits for it. Making the frame at play moves that cost ahead of a hover
  only while the frame has not yet gone idle.
- A product's own triggers must respect `control.frameRemoved`. After `whenIdle.remove()` the
  next frame is made by the trusted move or tap over the video, or by the viewer turning the
  product's hovers back on, not by a load trigger of the product's own; see "Dropping the frame
  when idle".

### Where a load's time goes

Once a release loads, the session's status says where the time went:
`frame.core?.status().release?.loadTimings` in the compute frame (`LoadTimings` in
`browser/src/load.ts`, whole ms). It holds:

- `startedAtMs`: when the load began on the worker's clock, so it counts loading the worker's
  script and ONNX Runtime's module;
- `filesMs`: fetching and reading the release document, then fetching every file it pins and
  checking their sizes and SHA-256 (for a remote release, whose files `chooseRelease`
  downloaded before, only the checks);
- `readMs`: reading them once checked: decoding the bank, parsing the catalog and the identity
  groups, and checking that they belong together. It is plain script, so its CPU cost shows
  here and not in `filesMs`;
- `recognizer` and `detector`: each model's session create (`createMs`), first run
  (`firstRunMs`), providers tried before that failed (`failedProvidersMs`), and total;
- `totalMs`: the whole load, a little more than its parts: it also holds the short steps
  between them.

ONNX Runtime starts a backend on the first session created on it. The recognizer is prepared
first, so that time is in its `createMs`, or in its `failedProvidersMs` when a provider before
failed (WebGPU listed first on a machine where it fails, for example). A first run pays
one-off allocation and, on WebGPU, shader compilation, so on a slow machine it can take many
times longer than the runs after it.

`totalMs` is not the time to the first card. Before the load comes making the compute frame and
starting the worker; after it, the first analysis (its `FrameAnalysis.timings`). It is measured
only, never used to decide anything, and nothing in it leaves the compute frame. A worker older
than 0.7.0 leaves it out.

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
- **The reading hold.** `hold: READING_HOLD` keeps a shown card for as long as the pointer stays
  on the area the card was seen in, so that a viewer can read it after a player has moved the
  card. The area is every box the card was seen in at the pointer since it was first shown, so
  a small move that follows the card does not end it.
  - **No limit.** There is no time limit and no count of misses, and a cut does not end it.
  - **What ends it:** the pointer leaving that area or the picture, a seek, a new source, or a
    worker that stops.
  - **Another card.** A card the pointer moves onto replaces the kept one, as on a fan of
    overlapping cards, when a card in about the same box (the same card, or one not named then)
    overlapped the kept card in one of the last few analyses that saw the kept card at the
    pointer, and the pointer has since moved into that box from outside it. A card that arrived since (laid on the
    kept card's spot, even partly, or after it moved away), one that slid under a pointer at
    rest, or one uncovered under a pointer that only trembles inside its box, does not.
  - **The outline.** `shown` carries `held: true` once two analyses in a row show the card gone
    from where it was (another card named there, or nothing named or detected there; one on a
    still picture), and once no recent analysis is left and none is coming (a rest past the
    grace period on a playing video). It stays until an analysis sees the card there again, so it does not come and go between looks.
    Hide the outline while it is set, and keep the tooltip. A card whose box is still detected
    there is not marked, and on a paused picture the newest analysis stays recent.
  - **Analysis.** In pointer mode, once the pointer has rested for its grace period (10 s) on a
    card the hold shows, nothing is analyzed and no picture is asked for until it moves. A
    pointer resting where the kept card was found gone is looked at every 2 s within the grace
    period, as any empty spot is.
  - **Touch.** A tapped card stays until a tap elsewhere, since touch sends no `leave`.
  - **Memory.** A shown card keeps the worker loaded: `idleUnloadMs` counts it as activity, so a
    pointer left on a kept card keeps the memory in use until it moves.

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

**Intent.** With `intent: "page"`, a trusted pointer move anywhere in the document, while the
watched video is playing (not paused, not ended), sends an `intent` message, at most once a
second (`INTENT_INTERVAL_MS`). An untrusted move, a paused or ended video, or the option off sends
nothing. It gives no capture authority. Pair it with the frame's `idleUnloadMs`.

**Dropping the frame when idle.** Ending the worker keeps the frame, and the frame's renderer
process with it: on a real release that is about 90 MB of footprint more than a page with no frame,
and a reload in place is no faster than a new frame. A product that wants the memory back passes
`whenIdle: { remove, make }`. When the frame reports the status `idle`, the control calls
`remove()` once (delete the iframe) and sends nothing more to that frame. The next trusted pointer
move over the watched video calls `make()` once (create a new iframe; the function given to
`loadWhen` works). An `intent` moment (with `intent: "page"`, a trusted move anywhere while the
video plays) does not make it, and sends nothing while the frame is removed: rebuilding on any
page move cost more than it saved for viewers who don't hover. `frame()` must return the new
window once `make()` returns. The control then connects as it does for any replaced iframe: it
says `hello`, takes the new `ready`, and tells the frame the pointer again. A second `make()`
waits until the new frame has itself gone idle and been removed; `stop()` during either call
leaves nothing sent. A trusted `pointerdown` over the picture (a touch tap) makes the frame too.
After `make()` the usual `no-answer` problem can fire, and the product handles it as it does for
its first frame. If `make()` throws, the control stays in the removed state and only the next trusted
move or tap over the video tries again (a move elsewhere on the page does not); the throw is not reported. A frame the product makes and connects itself ends
the removed state, so the next `idle` removes it. For that reason a product must not make the
frame on its own load triggers while `control.frameRemoved` (true from `remove()` until the next
accepted handshake) is true: `loadWhen` fires once, so it is safe, but a reload on every `playing`
event (a looping clip fires one) would quietly undo the unload. The viewer turning the product's
card hovers back on (a switch in its popup, say) is not one of those triggers: it is the viewer's
own choice to use them, so the product may make the frame at once, on a playing video, as a
hover would. Without the option nothing changes: the frame stays and reloads in place.

**Making the frame at play.** `loadWhen(video, "play", make)` calls `make` once: at once if the
video is already playing, else at its next trusted `playing` event; never for a paused or ended video.
`stop()` on the result removes the listener.

```js
const handle = loadWhen(video, "play", () => document.documentElement.append(iframe));
```

### When to make the frame

Recommended: make the compute frame when the video plays, not at the first pointer move.
`loadWhen(video, "play", make)` does that (see "Making the frame at play" above).

- The load then happens before the first hover. The viewer who points at a playing video finds a
  ready frame, instead of waiting for the frame and the models to load behind the pointer.
- Make the tooltip frame with it. A product that shows a card in a frame of its own should create
  that frame in the same `make`, so the first card does not wait on a second load.
- The idle clock runs from `ready`. A frame made at play and never pointed at reports `idle`
  `idleUnloadMs` after it is ready (pointer mode, no `intent`; see "Idle unload"). A first hover after that is cold, as it
  is without this recommendation.
- A frame made at play holds no capture authority. In pointer mode it sends no `capture` request
  until a `pointer` message arrives, and the page still decides each capture: a `capture`
  request that reaches the content script with no trusted pointer behind it is refused with
  `NOT_POINTING`. A request from anywhere else, or an untrusted one, is ignored before the gate
  with no reply (`fromExtensionFrame`). In `"always-on"` mode there is no such wait: the frame can ask
  for pictures, and the page refuses them without a pointer. "No requests before a pointer"
  holds in pointer mode only.
- A product's own triggers must respect `control.frameRemoved`. Once `whenIdle.remove()` has
  run, the next frame comes from the trusted move or tap over the video; a trigger of the
  product's own (a `playing` event, a route change) must not make it. The viewer turning the
  product's hovers back on is the viewer's choice, not such a trigger, and may make it at once.
- `loadWhen(video, "play")` waits for a trusted `playing` event, not `play`, and runs `make()` at
  once for a video that is already playing when it is registered. A `playing` event a page script
  dispatches (`isTrusted` false) is ignored. It checks once when registered, then
  waits for `playing`. Register it when you pick the main video. If you register earlier, or use
  your own `playing` listener, a video already playing when it becomes the main one (a mini
  player growing back) loads only at its next `playing` event (a seek or a stall) or at your own
  pointer trigger.

## Wiring: the compute frame

The extension page in the iframe. `startComputeFrame` takes the options of
`createWorkerSession` too (`mode`, `hold`, `chooseRelease`, `recordSkip`, `onDecision`,
`onGeometricStatus`, `geometricLoad`, ...), `idleUnloadMs` and `entryLook` (on unless `false`;
see "Pointer entry").

**Verifying only the faces at the pointer.** `geometricScope: "focus"` is one of those options
(`"all"` is the default): the geometric stage then verifies only the faces at the pointer, and a
face it applies to and did not verify is not named until an analysis verifies it
([browser/README.md](../browser/README.md), "Verifying the faces at the pointer"). It needs no new
message and does not change `PROTOCOL_VERSION`. The pointer reaches the frame as it does today:
the content script keeps sending `pointer` (fractions of the picture) and `leave`; when the frame
asks for a picture, it notes the pointer, and when the picture arrives it sends the worker that
point in the picture's pixels with the frame. A host that wants this option sends `pointer`
messages for real movement only, as the contract already says, and `leave` when the pointer goes.
The option is refused (the frame throws when it starts) in any mode but `"pointer"`.

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
