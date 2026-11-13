<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hover behavior

**Draft.** This page states how card hovers behave in a browser extension built on the toolkit's
browser runtime: when the model loads and unloads, when a picture may be taken, when a picture is
analyzed, what is shown at the pointer, and how a viewer's settings apply. Each clause is one
behavior, with an example and the test that checks it. It states the behavior; the mechanism is
in [extension-session.md](extension-session.md) (the two-frame contract) and
[browser/README.md](../browser/README.md) (the session, pacing, the geometric stage).

## What "standard" means

The standard is the behavior a product gets when it runs the toolkit's runtime with the standard
options below. Two extensions for two different card games should behave the same way, except
where a game needs something else.

- **Deviations.** A product lists each place it differs in a `HOVER-DEVIATIONS.md` file at its
  root: the clause id, what it does instead, and one reason:
  - `game`: its card game needs it (for example, a release with no geometric stage);
  - `temporary`: the difference goes away with a named change or release.
  A difference that is not listed is a defect.
- **Changes.** A change to a behavior that has shipped is decided once, by the maintainer. It
  lands here before the runtime, then in each product through a vendor update. A clause
  id keeps its meaning; a removed clause's id is not reused.
- **Clause format.** `S-<group><n> — <rule>`, a short statement, `Example:` one case with
  numbers, and `Test:` the toolkit test that checks it (`path:line`, under `browser/test/`). A
  part not checked yet says what will check it: `pending (slow-clock test)` a test that drives the
  real scheduler and session on a virtual clock, `pending (real-browser test)` a test that runs
  the extension in a browser, `pending (vendoring check)` the check that a product's vendored
  files match one toolkit commit.
- **Marks.** A clause with no mark is met by the code today.
  - `Status: changes in 0.14.0` marks a clause that states the behavior of toolkit 0.14.0, which
    the toolkit's code does not meet yet.
  - `Status: changes in a product release` marks a clause whose code lives in the product hosts.
    The hosts take the change in their next release, and once the shared host exists it carries it.
  - A clause with either mark states the rule after the change, and a `Today:` paragraph says what
    happens now (without naming a product: "one product ..."). A test that pins the target is
    marked "target" in the clause.
  - `Status: open decision` marks a choice not made yet. The clause says what the code does
    today, or states the options, and picks none.
- **Order.** A clause id keeps its meaning, so a clause added later takes the next number of its
  group and sits where it reads naturally. The ids in a group need not run in order on the page.

### Terms

- **Look:** one picture asked for, captured and analyzed. **W:** the median measured analysis
  time of the last 5 looks on this computer.
- **Video age:** the distance in video time between the picture on screen and the picture a
  result came from.
- **Active pointer:** a mouse or pen move over the picture within the last 10 s
  (`POINTER_GRACE_MS`), or a tap within the last 10 s.
- **Fast cadence (F):** 500 ms on WebGPU, 1000 ms on WebAssembly. **Slow cadence:** 1000 ms and
  2000 ms.
- **Max age (A):** 2000 ms of video time by default (S-W2). **Lifetime (L):** A divided by the
  playback rate, in milliseconds of wall time: how long an answer can stay on screen.
- **Round trip (R):** the median of the last 5 times from a picture being asked for to its reply,
  over the analyzed replies that were not reused (S-P4).
  **Margin (M):** one driver tick, 250 ms (`DRIVER_TICK_MS`).
- **Keep-fresh look:** a look that keeps the card on screen current while the viewer is not
  waiting on an answer. The stale-picture look a pointer move asks for is one; a resting active
  pointer's cadence look is another, and the budget of S-P5 bounds the former, not the latter. **Viewer-waiting look:** a look that starts because the viewer arrived or
  asked for something (S-P2).

### The standard options

| Option | Standard | Clauses |
| --- | --- | --- |
| `mode` | `"pointer"` | S-C1 |
| `hold` | `READING_HOLD` with keep-card on (the default), `SHOWN_HOLD` with it off | S-W4 to S-W7, S-H2 |
| `rotatedOutlines` | `true` | S-F2 |
| `measuredPacing` | `true` (share 0.25) | S-P1 to S-P5 |
| `entryLook` | on | S-C4 to S-C6 |
| `idleUnloadMs` | 600000 (10 min) | S-A4 |
| `whenIdle` | on: both frames are removed when idle | S-A4, S-A6 |
| `intent` | off | S-A6 |
| `geometricLoad`, `geometricScope` | `"pointer"` and `"focus"`, when the release has a geometric stage | S-A3, S-C7, S-C8, S-W9 |
| `limits` (the capture gate) | the defaults | S-B2 to S-B4, S-B13 |

Out of scope here: the tooltip's look, size and placement, card details, card language and the
popup's layout. They stay with each product.

## A. When the model loads and unloads

Mechanism: [When to make the frame](extension-session.md#when-to-make-the-frame),
[Idle unload](extension-session.md#idle-unload).

### S-A1 — On a load-at-play page, the frames are made when the main video plays

The compute frame and the tooltip frame are made together when the main video plays: at once if it
is already playing, else at its next `playing` event. A paused or ended video makes nothing. A
`playing` event that the page makes (not trusted) is ignored. The pages are in S-G2 and S-G3.

Status: changes in 0.14.0.

Example: a watch page opens with its video playing: both frames are made at once. A watch page
opens paused: they are made at the `playing` event when the viewer presses play. A page script
dispatches `playing` on a video that is already playing: nothing is made.

Today: `loadWhen` takes any `playing` event, trusted or not.

Test: `idle-unload.test.ts:719`, `idle-unload.test.ts:729`, `idle-unload.test.ts:742`,
`capture-control.test.ts:836`

### S-A2 — Elsewhere, the opening trusted pointer over the picture makes the frames

On a page that does not load at play, and for a video that has not played, the frames are made by
the earliest trusted pointer move or tap over the main video's picture.

Example: an embedded player plays muted on its own: nothing loads. The viewer moves the mouse over
its picture: both frames are made, and the model loads.

Test: pending (real-browser test)

### S-A3 — The geometric stage loads at the earliest pointer, not at play

With a geometric stage, the release loads without it, and the earliest `pointer` message has the
worker load it. An `intent`, a presented picture or a `hello` never does. Looks before it is
ready run without it.

Example: a video plays for 5 minutes with no pointer: the stage's index is never downloaded. The
viewer points at the picture: the stage starts loading.

Test: `compute-frame.test.ts:924`, `compute-frame.test.ts:973`

### S-A4 — After 10 idle minutes, the worker ends and both frames are removed

The compute frame ends its worker after `idleUnloadMs` (600000 ms) with no `pointer` message, no
card shown and no look in flight, counted from `ready`. It reports `idle`, and the content script
removes both frames.

Example: a frame becomes ready at 12:00:00 and nobody points at the video: at 12:10:00 the status
reads `idle` and both frames are gone.

Test: `idle-unload.test.ts:134`, `idle-unload.test.ts:170`, `idle-frame-removal.test.ts:101`

### S-A5 — A pointer, a shown card or a look in flight keeps the model loaded

Each `pointer` message restarts the idle time. A card shown and a look in flight hold it off; it
starts again from the moment the last card went.

Example: the pointer rests on a kept card for 30 minutes: the model stays loaded. The card goes at
12:30:00: the frames go at 12:40:00 if nothing else happens.

Test: `idle-unload.test.ts:508`, `idle-unload.test.ts:522`, `idle-unload.test.ts:537`

### S-A6 — After an idle unload, a trusted move or tap over the video makes the frames again

While the frames are removed, the next trusted move or tap over the video makes them again. A
`playing` event, a route change and a pointer move elsewhere on the page do not.

Example: a looping 30 s clip plays on after the unload: each loop fires `playing`, and nothing is
made. The viewer moves over the picture: both frames are made and connect.

Test: `idle-frame-removal.test.ts:128`, `idle-frame-removal.test.ts:228`,
`idle-frame-removal.test.ts:240`, `idle-frame-removal.test.ts:320`

### S-A7 — Turning hovers back on while the video plays loads at once in the tab in front

When the viewer turns hovers on and the main video is playing on a load-at-play page, both frames
are made at once in the tab in front, also after an idle unload. A background tab whose frames were
unloaded waits until it comes to the front, as a keep-card change does (S-H3).

Status: changes in a product release.

Example: the frames were removed for idleness; the viewer switches hovers off and on in the popup
while the video plays: in the tab in front both frames are made at once, before any pointer move.
In a second tab that is behind, nothing is made until the viewer brings it to the front.

Today: one product already does this; the other makes the frames in every tab at once, with no wait
for the front tab.

Test: pending (real-browser test)

### S-A8 — A background tab loads at play but takes no picture

A video that plays in a background tab makes the frames as a visible one does (S-A1). No picture
is taken while the page is hidden (S-B6).

Status: open decision.

This clause states what the code does today. Whether a background tab should wait for the front
(as in S-A7 and S-H3) is not decided.

Example: a watch page is open in a tab behind the front tab, and the page changes in place to the
next video: the frames are made when that video plays. No picture is taken until the tab is shown
and the viewer points at the video. A background tab that was never in front may not play its
video at all; the real-browser test settles that.

Test: pending (real-browser test)

### S-A9 — A worker that stops is restarted once; a second stop turns recognition off

A worker that stops after its release loaded is replaced once, by the bundled release with no
geometric stage. What was shown is cleared, and the status reads `loading` until it is ready. If
that worker stops too, recognition is off for the page.

Example: the worker crashes while a card shows: the card goes, a new worker loads, and
hovers work again. A second crash leaves the status `failed`.

Test: `compute-frame.test.ts:324`, `session-core.test.ts:2238`

### S-A10 — A frame the page deletes is made again at the next trusted play or pointer move

When a page script removes the compute frame or the tooltip frame, both are made again at the next
trusted `playing` event of the main video or the next trusted pointer move over its picture, as
after an idle unload (S-A6). Nothing is made again on a timer or on an untrusted event.

Status: changes in a product release.

Example: a page deletes the hover frames while the viewer watches: nothing happens until the viewer
moves the mouse over the picture, and then both frames are made and connect.

Today: the toolkit makes frames again after an idle unload and at no other time. The products check at some events
whether their frames are still in the page, and the two do not make them again at the same moments.

Test: pending (real-browser test)

## B. Capture authority and privacy

Mechanism: [Who may make the extension take a picture](extension-session.md#who-may-make-the-extension-take-a-picture),
[The origin and source rule](extension-session.md#the-origin-and-source-rule).

### S-B1 — Pictures are taken on trusted pointer events alone

Capture authority comes from pointer events the browser marks as trusted. A page script's made-up
events give none.

Example: a page dispatches a synthetic `pointermove` over the video every 100 ms: every capture is
refused with `NOT_POINTING`.

Test: `capture-control.test.ts:299`

### S-B2 — A hover gives pictures for 10 s, then while a card shows and 5 s after

A mouse or pen gives pictures within 10 s (`POINTER_GRACE_MS`) of its last trusted event over the
picture, then while a card shows and for 5 s (`READING_LINGER_MS`) after one last showed. In
every case the last trusted point must still be over the picture.

From 0.14.0, a frame that becomes ready after the 10 s gives one more picture (S-B13, which is
changing in 0.14.0).

Example: the pointer stops over the video at 0 s with no card: pictures are given until 10 s. It
stops on a shown card that goes at 14 s: pictures are given until 19 s.

Test: `capture-gate.test.ts:15`, `capture-gate.test.ts:26`, `capture-control.test.ts:318`

### S-B3 — Nothing is captured more than 60 s after the last trusted pointer event

No branch of S-B2 gives a picture past 60 s (`MAX_REST_MS`) after the last trusted pointer event.
A new trusted move starts it again.

Example: a card stays shown under a resting pointer for 2 minutes: no picture is given after 60 s.

Test: `capture-gate.test.ts:41`, `capture-control.test.ts:371`

### S-B13 — A frame that becomes ready late gets one picture for a pointer that still rests

When the compute frame becomes ready (the model is loaded; the handshake is not the moment) after
the 10 s of S-B2 have passed, and a trusted pointer still rests over the picture, one picture is
taken at that moment, and never later than 60 s (`MAX_REST_MS`) after the last trusted pointer
move. If that look finds a card, the card keeps showing under the rules of S-B2 and S-B3. If it
finds nothing, no further picture is taken until the pointer moves. A capture that fails and is
retried promptly (S-C10) is part of the one picture, not a second one. A tap gets no such picture:
S-B4 is unchanged for a cold start.

Status: changes in 0.14.0.

Example: the viewer rests the pointer on a card at 0 s and the model finishes loading at 25 s: one
picture is taken at 25 s. A card is found: it shows and is kept by the rules of S-B2. Had the model
finished at 70 s, or had the pointer left the picture, no picture would be taken.

Today: the 10 s have passed, so no picture is asked for or given, and the card shows after
the viewer moves the pointer again, and not before.

Test: pending (real-browser test)

### S-B4 — A tap gives pictures for 10 s and no longer

A tap gives pictures for 10 s from the tap. A card showing never extends it, and another pointer
inherits nothing. A canceled touch ends it.

Example: a tap at 0 s on a card that stays shown: the last picture is given before 10 s.

Test: `capture-control.test.ts:513`, `capture-control.test.ts:524`, `capture-control.test.ts:552`

### S-B5 — Before every capture, the last trusted point is checked against the picture now

The content script checks the last trusted point against the picture as laid out at capture time.
A video that moved away under a resting pointer clears the gate and refuses the capture.

Example: the page scrolls the player 400 px up under a resting mouse: the next capture is refused.

Test: `capture-control.test.ts:331`

### S-B6 — Leaving, hiding the page or changing the video clears all authority

The pointer leaving the picture or the document, the page hidden, a canceled pointer, a new source
or another video (or none) clear the gate, the record of a card showing included, and send
`leave`.

Example: the viewer switches tabs while a card shows: the gate is cleared, and returning to the tab
gives no picture until the pointer moves over the video.

Test: `capture-control.test.ts:445`

### S-B7 — No picture is asked for before a pointer is over the video

In pointer mode the compute frame asks for no picture before a `pointer` message, and a page that
was never hovered gives none.

Example: a video plays for 10 minutes and the viewer never points at it: no `capture` request is
made.

Test: `capture-control.test.ts:291`, `session-core.test.ts:1786`

### S-B8 — A frame made at play holds no capture authority

Making the frame at play loads the model and takes no picture. A `capture` request with no trusted
pointer behind it is refused with `NOT_POINTING`.

Example: the frames are made at play at 0 s and the viewer points at nothing until the idle unload:
no picture is asked for or taken in those 10 minutes.

Test: `capture-control.test.ts:249`, `capture-control.test.ts:276`, `idle-unload.test.ts:678`

### S-B9 — Messages count when trusted and from the right window and origin

The content script takes a message from one of its frames when the event is trusted, comes from
that frame's window and has the extension's origin; it does not read the data of any other. The
compute frame acts on messages from its parent window with an allowed origin.

Example: a page script builds a `MessageEvent` with the compute frame as its source and the
extension's origin, carrying a `shown` card: it is ignored and its data is not read.

Test: `capture-control.test.ts:208`, `capture-control.test.ts:227`, `compute-frame.test.ts:187`

### S-B10 — A late reply after a reset revives nothing

A `shown` card that arrives after a reset reaches the product, but the gate notes a card while a
pointer holds authority, and not otherwise, so a late card does not extend capture.

Example: the pointer leaves at 0 s and a `shown` card posted before the leave arrives at 0.05 s:
no picture is given for the linger.

Test: `capture-control.test.ts:416`, `capture-control.test.ts:470`

### S-B11 — Off means off

With hovers off, both frames are removed, nothing is captured, analyzed or downloaded for hovers,
and a reply that arrives after off shows nothing.

Example: the viewer switches hovers off while a look is in flight: the frames go at once, no card
is drawn when the analysis would have answered, and moving over the video loads nothing.

Test: `capture-control.test.ts:793`, `session-core.test.ts:1883`; in a product: pending (real-browser test)

### S-B12 — A product's privacy page states the gate's timings as the code has them

A product's privacy page gives the windows of S-B2 to S-B4, from 0.14.0 the one-picture rule of S-B13 and the idle time of S-A4, and a test
fails when a constant and the page disagree.

Example: `MAX_REST_MS` changes from 60000 to 45000 and the page still says 60 seconds: the test
fails.

Test: pending (real-browser test)

## C. When a look happens

Mechanism: [Retries](extension-session.md#retries), [Pointer entry](extension-session.md#pointer-entry),
[An unverified face on a playing video](extension-session.md#an-unverified-face-on-a-playing-video),
[A still picture in pointer mode](../browser/README.md#a-still-picture-in-pointer-mode).

### S-C1 — Looks follow the pointer: the fast cadence while it is active

In pointer mode nothing is analyzed without pointer activity. While the pointer is active, a
playing video is looked at on the fast cadence (or the paced wait, S-P1).

Example: WebGPU, unpaced, the pointer moving over cards on a playing video: a look about every
500 ms (1000 ms on WebAssembly). No pointer activity for 10 s and no card shown: no look.

Test: `scheduler.test.ts:101`, `scheduler.test.ts:107`

### S-C2 — A pointer resting on a shown card is looked at on the slow cadence

Under `SHOWN_HOLD` or no hold, a pointer that rests past its 10 s on a shown card is looked at on
the slow cadence while the card shows and for 5 s after it last showed.

Example: WebGPU, unpaced: the pointer rests on a card from 0 s: looks every 500 ms to 10 s, then
every 1000 ms while the card shows.

Test: `scheduler.test.ts:177`, `scheduler.test.ts:195`

### S-C3 — Under the reading hold, a resting pointer on a kept card gets no looks

Under `READING_HOLD`, once the pointer has rested past its 10 s on a card the hold shows, nothing
is analyzed and no picture is asked for until it moves.

Example: the pointer rests on a kept card from 0 s: no look starts after 10 s, for as long as it
rests.

Test: `scheduler.test.ts:163`, `session-core.test.ts:1369`

### S-C4 — Nothing is asked for while the pointer is off the picture

From a `leave` until the next `pointer` message, the compute frame asks for no picture. A look in
flight at the leave stays in flight, and the back-off keeps counting.

Example: the pointer leaves at 0 s and comes back at 3 s: no `capture` request is made between.

Test: `compute-frame.test.ts:776`, `session-core.test.ts:2555`

### S-C5 — A pointer message over a stale picture asks for a look on that message

A `pointer` message asks for a look at once when the session is ready, nothing is in flight, no
retry is waiting (S-C11), the last pointer-started look began at least 250 ms ago, and the newest
look's picture is stale: more than `max(400, B)` ms of video time away, where B is the budget of
S-P5.

Status: changes in 0.14.0.

Example: WebGPU, unpaced, a round trip of 100 ms: B is 500 ms. The pointer leaves at video 10.0 s and
returns at 13.0 s: 3000 ms is more than 500 ms, so the return asks on that message.

Today: the threshold is `max(400, interval in effect)`. Paced at W = 800 ms the interval is
3200 ms; a return at video age 2500 ms asks nothing, and the card (older than 2000 ms) shows
nothing until the next cadence look.

Test: `scheduler.test.ts:258`, `scheduler.test.ts:268`, `session-core.test.ts:2543`; today's
threshold on a slow computer: `slow-clock.test.ts:238`; the target: `slow-clock.test.ts:244`

### S-C6 — When a load ends with the pointer active, the look is asked at once

When a load ends (the opening load, a fallback, a restart or an idle resume) with an active pointer
over the picture, the frame decides at once, as the next tick would. A pointer that left or rested
past 10 s asks nothing.

Example: the viewer points at a video whose model is still loading; the load ends at 4.2 s: the
capture is asked at 4.2 s, not at the next 250 ms tick.

Test: `session-core.test.ts:2694`, `session-core.test.ts:2706`, `session-core.test.ts:2746`,
`compute-frame.test.ts:765`

### S-C7 — A pointer on an unverified card of a playing video asks for a look at once

With a ready geometric stage in focus scope, an active pointer on a card the newest look left
unverified gets a look with the pointer there when the picture's time has moved, nothing is in
flight, no retry waits, no capture was refused, and the last look of any kind began at least F
ago (500 ms on WebGPU, 1000 ms on WebAssembly). The spacing is fixed: it is not the budget of S-P5
and not the paced interval.

Status: changes in 0.14.0.

Example: WebGPU, a look began 300 ms ago and answered: the pointer moves onto an unverified card and
the look is asked at 500 ms after the last start, on the next pointer message or tick.

Today: the spacing is `max(250, median worker time of the last 5 looks divided by the share,
up to 4000)`. Paced at W = 900 ms it is 3600 ms from the last look.

Test: `relook-playing.test.ts:160`, `relook-playing.test.ts:198`, `relook-playing.test.ts:248`;
today's spacing: `slow-clock.test.ts:216`; the target:
`slow-clock.test.ts:221`

### S-C8 — A pointer on an unverified card of a still picture asks for a look again

On a still picture in focus scope, a pointer on an unverified card asks for another look at most
once per 250 ms, after the picture's repeats and retries, never after a refused capture, and not
past the pointer's 10 s.

Example: a paused picture was looked at with the pointer on card A; the pointer moves to unverified
card B 1 s later: one look is asked with the pointer on B.

Test: `geometric-focus.test.ts:927`

### S-C9 — In an in-page session, a cut under a shown card asks for a look at once

In a session made with `createSession`, when the picture under a shown card changes without a seek
(a cut), the result is cleared and a look is asked as soon as nothing is in flight, whatever the
cadence. An extension built on the two-frame contract does not detect cuts: `cut` is a reserved
message that no page helper sends, so this clause does not apply there.

Example: a broadcast cuts from the table to a player's face while a card shows: the next look
starts at the next tick, not after the cadence.

Test: `session-core.test.ts:1908`, `session.test.ts:616`

### S-C10 — A look that comes back unanswered is retried after 250, 500, 1000, then 2000 ms

A look answered busy, failed, or given up on, or a capture that failed for want of a picture,
makes the same picture due again after 250 ms, 500 ms, 1000 ms, then every 2000 ms. A failed
capture is retried when its back-off runs out; the others also wait for the cadence. An analyzed
answer, a seek or a new source start the back-off over; the pointer leaving does not.

Example: WebGPU, a paused picture's look comes back busy at once: the retry is due 250 ms later,
and as a retry that is not prompt it also waits for the cadence, so it starts 500 ms after the look
started. Three busy answers in a row make the next three due 250, 500 and 1000 ms after each.

Test: `scheduler.test.ts:472`, `scheduler.test.ts:558`, `scheduler.test.ts:565`,
`session-core.test.ts:1947`

### S-C11 — No look of any kind starts before a waiting retry is due

A retry that is waiting (S-C10) has a not-before time. No look starts before it, whatever path asks:
the cadence on a playing video, a pointer move over a stale picture (S-C5), the unverified-card
looks (S-C7, S-C8), a cut (S-C9) and a load that ends (S-C6). A pointer move never shortens it. A
seek or a new source drops the retry with the picture it belonged to.

Status: changes in 0.14.0.

Example: a retry is due at 750 ms; at 600 ms the pointer moves over a stale picture, and at 650 ms
the cadence comes due on a playing video: no look starts before 750 ms.

Today: the paths that wait for the retry are the cadence of a still picture, the refusal path and the
playing relook. The cadence on a playing video (`due`), the stale-picture path (`hoverTriggerDue`)
and a cut can start a look before the retry's time.

Test: `scheduler.test.ts:539`, `scheduler.test.ts:757`, `scheduler.test.ts:832`; today's start
before the retry (the stale-picture path, then the cadence at 50 frames per second):
`slow-clock.test.ts:254`, `slow-clock.test.ts:267`; the target: `slow-clock.test.ts:260`,
`slow-clock.test.ts:274`; the cut path: pending (slow-clock test)

### S-C12 — A refused capture is not retried; the next pointer move asks again

A capture refused for a reason other than the picture (the gate, an unreadable video) is retried by
nothing and grows no back-off. It blocks the unverified-card looks until a picture is received or
answered, or a seek or a new source; the next pointer move asks again, at the cadence.

Example: a capture is refused while the pointer is outside; the pointer comes back and rests
without moving: nothing is asked. It moves: one look is asked.

Test: `scheduler.test.ts:798`, `scheduler.test.ts:806`, `relook-playing.test.ts:383`

### S-C13 — A look with no reply is given up on after 5 s, or 15 s before the opening analysis

A look with no reply is given up on 5 s after its capture was asked for, or 15 s while the worker
has not analyzed a picture since its release loaded.

Example: a slow computer's opening analysis takes 12 s: it is waited for and its card shown. A later
analysis takes 6 s: it is given up on at 5 s and retried.

Test: `session-core.test.ts:1988`, `session-core.test.ts:2002`

### S-C14 — A pointer resting on an empty spot is looked at every 2 s

When the newest look, begun after the pointer's last activity, found no card at the pointer, the
cadence looks are 2000 ms apart (`EMPTY_SPOT_INTERVAL_MS`), or the paced wait if longer. A move, a
card found, a seek, a new source or a cut return to the fast cadence.

Example: WebGPU, the pointer rests on an empty spot for its 10 s: 5 looks, where the fast cadence
would make 20.

Test: `scheduler.test.ts:892`, `scheduler.test.ts:919`, `scheduler.test.ts:961`,
`session-core.test.ts:2429`

### S-C15 — A still picture is analyzed three times, then not again until it changes

A paused picture or an image is analyzed when presented and twice more, 250 ms apart, then not
again until a new picture is presented.

Example: the viewer pauses at 0 s with the pointer active: looks at about 0, 250 and 500 ms, then
none while the picture stays.

Test: `scheduler.test.ts:64`, `scheduler.test.ts:71`

### S-C16 — A repeat of an unchanged still picture reuses the look before it

In pointer mode, a repeat whose picture has the same video time as the newest analyzed look, with
no unverified card and a fully verified newest look, is answered from that look without the
models.

Example: scope `"all"`, a paused hover: one analysis and two reused repeats.

Test: `geometric-focus.test.ts:1316`

### S-C17 — One look in flight

At most one look is asked for or analyzed at a time, and the content script holds at most one
capture.

Example: a pointer sweeps across five unverified cards while a look is in flight: no second look
starts until it answers or is given up on.

Test: `session-core.test.ts:328`, `capture-control.test.ts:739`, `relook-playing.test.ts:304`

### S-C18 — Pointer-started looks are at least 250 ms apart

Looks started by the pointer (S-C5, S-C7, S-C8) begin at least 250 ms
(`HOVER_TRIGGER_MIN_GAP_MS`) after the one before. S-C5 counts from the last pointer-started look;
S-C7 counts from the last look of any kind and can require a longer spacing.

Example: a pointer crosses a stale picture with moves at 0, 100 and 200 ms: one look, at 0 ms.

Test: `scheduler.test.ts:274`, `relook-playing.test.ts:189`

## P. Pacing

Mechanism: [Measured pacing](../browser/README.md#measured-pacing). Pacing sets how often looks that
nobody is waiting on start (keep-fresh looks, S-P1 and S-P5). Looks a viewer is waiting on are not
slowed by it (S-P2).

### S-P1 — Keep-fresh looks are paced from the measured analysis time

With pacing on (standard), the wait between keep-fresh looks is P = max(Q, min(C, W / 0.25)). The
floor Q and the ceiling C depend on the state:

- pointer active: Q is F, C is 4000 ms;
- pointer resting on a shown card: Q is the slow cadence (1000 ms on WebGPU, 2000 ms on
  WebAssembly), C is 6750 ms (A + 5000 − 250);
- always-on mode: Q is the slow cadence, C is 8000 ms.

P is Q until 3 looks have been measured, and when pacing is off. Keep-fresh looks are the cadence
looks, the reading looks, the empty-spot rest (S-C14), always-on looks, the retries that are not
prompt and the stale-picture look. From 0.14.0 the start of the stale-picture look is also bounded
by S-P5.

Example: WebAssembly, pointer active, W = 900 ms: the wait is 3600 ms. WebGPU, pointer active,
W = 50 ms: 200 ms is under F, so the wait stays 500 ms. WebGPU, pointer resting, W = 200 ms: 800 ms
is under the slow cadence, so the wait is 1000 ms.

Test: `measured-pacing.test.ts:29`, `measured-pacing.test.ts:43`, `measured-pacing.test.ts:64`,
`scheduler.test.ts:961`

### S-P5 — A stale picture is looked at early enough that the answer stays within its lifetime

The stale-picture look (S-C5) starts when the newest look's picture is more than `max(400, B)` ms of
video time from the picture on screen, where

B = max(F, min(P, L − R − M))

with F the fast cadence, P the paced interval of the active pointer (S-P1, ceiling 4000 ms),
L the lifetime (A divided by the playback rate), R the round trip and M the 250 ms margin. So a
look starts as late as keeps the answer on screen for the whole of its lifetime, and no later than
the paced wait. It does not start at the fixed fast cadence when that is earlier than needed.
B bounds the stale-picture look that a pointer move asks for, and no other look. The cadence look of a pointer
that is active and resting stays at P.

- **Floor.** B is never below F. When L − R − M is under F (the computer is too slow to keep a card
  fresh), B is F.
- **Warm-up.** Until a round trip is known, and until 3 looks have been measured, B is F.
- **Saturation.** B is never above P. When L − R − M reaches P, B is P (at most 4000 ms).
- **Pacing off.** P is F, so B is F.
- **Units.** B is in wall milliseconds and is compared with video age, as the cadence is: at a
  playback rate other than 1 the two differ, and the rule keeps this limit.

The focus re-look is not spaced by B: it keeps its fixed spacing F (S-C7).

Status: changes in 0.14.0.

Example: WebGPU (F = 500 ms), W = 800 ms so P = 3200 ms, R = 850 ms, rate 1: L − R − M = 900 ms, so
B = 900 ms and the look starts when the picture is more than 900 ms of video away. With W = 200 ms
and R = 250 ms: P = 800 ms and L − R − M = 1500 ms, so B = 800 ms. WebAssembly (F = 1000 ms),
W = 800 ms, R = 900 ms: L − R − M = 850 ms is under F, so B = 1000 ms.

Today: the threshold is `max(400, interval in effect)`, which is P without the lifetime bound.

Test: today's threshold on a slow computer: `slow-clock.test.ts:238`; the target:
`slow-clock.test.ts:244`

### S-P2 — Looks a viewer waits for are not slowed by pacing

Looks that start because the viewer arrived or asked are not held back by the paced wait: the
unverified-card looks, the look when a load ends (S-C6), a prompt retry (S-C10) and a cut in an
in-page session (S-C9). The focus re-look of a playing picture (S-C7) is spaced F from start to
start; the re-look of a still picture (S-C8) stays 250 ms from the last pointer-started look. The
others add no gap of their own. Each keeps one look in flight and the back-off (S-C11). Keep-fresh looks (S-P1, S-P5) stay paced, so the empty-spot
rest, the reading looks, always-on looks and the retries that are not prompt are not changed by this
clause.

Status: changes in 0.14.0.

Example: W = 800 ms, pacing on, a model load ends 1 s after the last look while the pointer is
active: the look is asked at once, where the paced wait is 3200 ms.

Today: the focus re-look of a playing picture is spaced by the paced interval (S-C7), and the look
when a load ends goes through the cadence (`due`), which the paced wait holds back when the last
look was recent.

Test: pending (slow-clock test)

### S-P3 — Under the shown hold, a reading look comes before the card's hold runs out

With `SHOWN_HOLD`, once a round trip is known the reading wait is at most L + 5000 − R − M, where L
is A divided by the playback rate, in place of the 6750 ms ceiling, so the next answer lands before the card's age plus the hold run out and a
card that stays where it is does not go between two looks. The wait is not below the slow cadence,
and not above the paced wait of S-P1.

Status: changes in 0.14.0.

Example: W = 1600 ms, R = 1600 ms, pacing on, the pointer resting on a card past its 10 s: the wait is
min(6400, 2000 + 5000 − 1600 − 250) = 5150 ms, and the next answer lands 6750 ms after the last
look's picture, inside the 7000 ms of the card's age plus the hold. At 1.25 times playback, L is
1600 ms: with W = R = 1500 ms the wait is min(6000, 1600 + 5000 − 1500 − 250) = 4850 ms, and the
answer lands 6350 ms after the last look's picture, inside the card's life of 6600 ms.

Today: the reading ceiling is 6750 ms (2000 + 5000 − 250). At W = 1600 ms the wait is 6400 ms and
the next answer lands 8000 ms after the last look's picture, so the card is gone for about 1 s.

Test: today's gap: `slow-clock.test.ts:194`; the target: `slow-clock.test.ts:202`

### S-P4 — The pacer learns from analyses that were not reused

Pacing records each analysis's worker time (`workerMs`), not the round trip, and records no reused
repeat (S-C16) and no busy or failed reply. It learns within the session and stores nothing.

Example: a paused hover makes one analysis of 600 ms and two reused repeats of 3 ms: the pacer
records one sample, 600 ms.

Test: `geometric-focus.test.ts:1424`, `measured-pacing.test.ts:181`

## W. What is shown

Mechanism: [The hold and the reading hold](extension-session.md#what-each-side-must-do),
[Verifying the faces at the pointer](../browser/README.md#verifying-the-faces-at-the-pointer).

### S-W1 — A card is shown when it is named; a box detected and not named shows nothing

What is shown at the pointer is the named card of the newest result there. A box that was detected
and not accepted shows nothing and still takes the pointer.

Example: two cards overlap and the one on top fails the margin: the pointer over it shows nothing,
not the card beneath.

Test: `hover.test.ts:116`, `session-core.test.ts:1813`

### S-W2 — A result more than 2000 ms of video from the picture on screen is not shown

A result whose video age is over the release's `hover.maxAgeMs` (2000 ms by default) names
nothing, unless a hold keeps the card.

Example: with no hold, a look of the picture at video 20.0 s: at 22.1 s its card is no longer
shown.

Test: `session.test.ts:453`, `session-core.test.ts:304`

### S-W3 — Nothing from before a seek or a new source is shown

A result from before a seek, a new source or a cut is never shown, and a seek or a new source ends
any hold.

Example: a card shows; the viewer seeks 30 s ahead; the reply of the look in flight comes 200 ms
later: nothing is shown until a look of the new picture answers.

Test: `session-core.test.ts:284`, `session-core.test.ts:297`, `scheduler.test.ts:996`

### S-W4 — With keep-card on, a card stays while the pointer stays where it was seen

Under the reading hold, a shown card stays while the pointer stays on the area it was seen in, with
no time limit, after the card moves or is covered. A cut does not end it. Leaving the area or the
picture, a seek, a new source or a stopped worker end it.

Example: the pointer rests on a card; a player picks it up 3 s later: the tooltip stays until the
pointer leaves that spot.

Test: `session-core.test.ts:696`, `session-core.test.ts:834`, `session-core.test.ts:849`,
`session-core.test.ts:856`, `session-core.test.ts:1362`

### S-W5 — Under the reading hold, moving onto an overlapping card shows it

A card the pointer moves onto replaces the kept card when it overlapped the kept card in one of the
last 3 looks that saw it there. A card laid on the spot later, one that slides under a resting
pointer, or one uncovered under a trembling pointer does not.

Example: a fan of three cards: the pointer moves from the left card to the middle card: the middle card shows. A
new card is laid on the left card while the pointer rests: the left card stays.

Test: `session-core.test.ts:886`, `session-core.test.ts:974`, `session-core.test.ts:1169`

### S-W6 — With keep-card off, a card is kept through short gaps

Under the shown hold, a card stays until two analyses in a row have nothing there, or 5 s pass
after the card was last named (a naming counts up to A after its picture). Another card at the pointer, or the pointer leaving the card's box, end
it at once. A reply that analyzed nothing, or that came back older than 2000 ms of video, is not a
miss.

Example: on a live stream one analysis misses the card and the next sees it: the tooltip does not
flicker. Two misses in a row: it goes.

Test: `session-core.test.ts:508`, `session-core.test.ts:519`, `session-core.test.ts:570`,
`session-core.test.ts:596`, `session-core.test.ts:627`

### S-W7 — A kept card seen gone is marked held until it is seen again

Under the reading hold, `held: true` is set when two analyses in a row show the card gone from
where it was (one on a still picture), or when no recent analysis is left and none is coming. It
stays until an analysis sees the card there again. On a paused picture the newest analysis stays
recent, so a long rest alone never marks it.

Example: a player picks up the kept card; the next two looks show the spot empty: `held` is set.
One look that misses a card still there does not set it.

Test: `session-core.test.ts:723`, `session-core.test.ts:769`, `session-core.test.ts:1014`,
`session-core.test.ts:1075`

### S-W8 — A shown card is reported again when it changes, not for a look's wobble

The frame reports a shown card again when it is another card, when `held` changes, or when an edge
of its box or its outline's sides moved more than 5 % of the card's size, or its tilt more than 2
degrees, since the last report. Small moves add up.

Example: a 100 px wide card's box moves 3 px between looks: no new report. It moves 6 px, or 3 px
twice in the same direction: a new report.

Test: `shown-outline.test.ts:185`, `session-core.test.ts:744`, `session-core.test.ts:802`

### S-W9 — In focus scope, nothing is shown where an unverified card overlaps the pointer

With a ready geometric stage in focus scope, nothing is named at a point whose group of
overlapping boxes holds a card the stage has not verified, and a card kept by the shown hold ends
there, until a look verifies it (S-C7, S-C8).

Example: the pointer moves from a verified card onto a strip where an unverified card overlaps it:
the tooltip goes until the next look answers.

Test: `geometric-focus.test.ts:1090`

## F. Outline

Mechanism: [Outlines of tilted cards](../browser/README.md#outlines-of-tilted-cards). The outline
is drawn by the product today.

### S-F1 — The outline is the shown card's box on the picture, shown with the tooltip

The outline is drawn around the shown card's box mapped onto the picture on screen (letterboxing,
full screen, resizing), clipped to the picture. It is not drawn for a box mostly off the picture or
under 4 px a side. It shows and hides with the tooltip and never takes the pointer.

Example: a card's box reaches 10 % past the right edge: the outline stops at the edge. A box 70 %
off the picture: no outline.

Test: pending (real-browser test)

### S-F2 — A turned card is hovered and outlined along its own edges

With `rotatedOutlines`, a named card turned 1 degree or more carries its outline (`rotation`,
`localWidth`, `localHeight`), and the hit test follows it. An upright card carries none of the
three fields.

Example: a card turned 12 degrees: the outline is turned 12 degrees clockwise, and a point inside
its box but outside the card shows nothing.

Test: `shown-outline.test.ts:112`, `shown-outline.test.ts:121`, `tilt.test.ts:405`

### S-F3 — A turned outline near the picture's edge

Status: open decision.

Both options:

- **Upright-box fallback.** A turned outline that would reach past the picture is drawn as the
  card's box clipped to the picture, upright. The box can cover pixels where a hover does not count.
- **Always turned.** The turned outline is drawn about the box's center, also where it reaches past
  the picture, unclipped.

A third shape, the turned outline clipped to the picture, would match where a hover counts; it is
not built.

Example: a card turned 20 degrees whose corner reaches 8 px past the bottom edge: drawn upright and
clipped under the upright-box option, turned and reaching past the edge under the other.

Test: pending (real-browser test)

### S-F4 — A held card keeps its tooltip and loses its outline

While a shown card carries `held: true`, the product draws no outline and keeps the tooltip.

Example: the kept card is seen gone: the outline disappears and the tooltip stays; the card comes
back to the spot: the outline returns.

Test: `shown-outline.test.ts:264` (the message); the drawing: pending (real-browser test)

## G. Site rules

The products hold these today ([What stays yours](extension-session.md#what-stays-yours)).

### S-G1 — Hovers run on watch, live and embed pages on YouTube, and on Twitch

Active pages: on `www.youtube.com`, `/watch`, `/embed/…`, `/live/…` and a channel's `/live`
(`/@name/live`, `/channel/…/live`, `/c/…/live`, `/user/…/live`); every page on `www.twitch.tv`.
Elsewhere a pointer counts for nothing, at each event and at each capture.

Status: changes in a product release.

Example: on `www.youtube.com`, the path `/@name/live` is active and `/@name/videos` is not. A
`/watch` page on the host `m.youtube.com` is not.

Today: one product checks the page at each event and at each capture; the other checks it at a
pointer move and not at a capture.

Test: pending (real-browser test)

### S-G2 — On YouTube, watch and live pages load at play; embeds wait for a hover

An active YouTube page loads at play (S-A1) except an embedded player, which loads at the earliest
pointer (S-A2).

Example: `/watch?v=x` playing: loads at once. `/embed/x` on another site, playing muted: loads at
the earliest pointer move over it.

Test: pending (real-browser test)

### S-G3 — On Twitch, channel, video and clip pages load at play; seven side pages wait for a hover

A channel's page, a past broadcast (`/videos/<digits>`) and a clip (`/<channel>/clip/<slug>`) load
at play. The side-page list is exactly these seven: `/following`, `/creatorcamp`, `/collections`,
`/payments`, `/privacy`, `/products` and `/team`. On them hovers load at a hover, not at play.
Other addresses that are not a channel, video or clip, such as the front page, directories, search
and settings, wait for a hover too. The list and the address check are one shared list and one
strict check, shared by the products: an address that is not one of the load-at-play forms waits
for a hover. The details of the address rule may change when its route table is reviewed.
In-page navigation with no new `playing` event loads at the earliest pointer.

Status: changes in a product release.

Example: on `www.twitch.tv`, the path `/name/clip/AbC-123` playing loads at once. The path
`/following` playing loads at the earliest pointer move over the picture.

Today: the two products keep different lists of site pages and different address rules. They
differ on these seven pages, on repeated slashes, on the case of `/videos/` and on the characters
a clip slug may have.

Test: pending (real-browser test)

### S-G4 — The main video is the largest one on show

The main video is the largest `<video>` in the page, by its box's area, at least 320 CSS px wide
and with a picture (`videoWidth` above 0). It is picked again on a trusted pointer move (at most
once a second) and on each `playing` event. Another main video clears the gate and is a new source
to the frame.

Example: a 1280 px player and a 300 px preview both play: the player is watched. A theater-mode
switch makes no other video larger: nothing changes.

Test: `capture-control.test.ts:490` (the switch); the pick: pending (real-browser test)

### S-G5 — After in-page navigation off an active page, a shrunk player is not captured

When the page's address is no longer an active page (S-G1), a pointer over the player counts for
nothing, at each event and at each capture, also under a resting pointer. The check runs at every
capture, and not at a pointer move alone.

Status: changes in a product release.

Example: the viewer leaves a watch page for the home page and the video goes on in a miniplayer:
moving or resting over it takes no picture.

Today: one product checks the page at each event and at each capture; the other checks it at a
pointer move and not at a capture.

Test: pending (real-browser test)

## H. Settings

### S-H1 — One switch turns hovers on and off, at once, in every tab

Hovers are on unless the viewer switches them off; a missing or unreadable value reads as on. Off
applies at once in every tab (S-B11); on applies as S-A7. There is no switch per channel or per
video.

Example: the viewer switches off with three tabs open: the frames go in all three.

Test: pending (real-browser test)

### S-H2 — Keep-card picks the hold: on by default

"Keep the card I'm pointing at" on (the default, also for a missing or unreadable value) gives the
reading hold (S-W4); off gives the shown hold (S-W6).

Example: a fresh install: a card stays while the pointer stays on its spot.

Test: pending (real-browser test)

### S-H3 — A keep-card change remakes the compute frame: now in front, later behind

The hold is fixed for a compute frame's life. A change remakes a running compute frame at once in
the visible tab, and in a background tab when it next comes to the front. The card shown goes. A
tab with no compute frame does nothing; its next frame reads the new value. A write of the same
value changes nothing.

Example: the viewer turns keep-card off with three tabs, one in front: that tab's compute frame is
made again at once, the other two when each is brought to the front.

Test: pending (real-browser test)

## X. Invariants

These hold across every clause. Others are stated in their groups: one look in flight (S-C17),
the 250 ms gap (S-C18), no look before a due retry (S-C11), a refused capture blocks looks
(S-C12), no picture asked while the pointer is off it (S-C4), no reading looks under the reading
hold (S-C3), capture authority (S-B1 to S-B10), off means off (S-B11, S-B12), and what the pacer
records (S-P4).

### S-X1 — Scheduling never changes what an analysis answers

For the same picture and options, the answer is the same whichever rule asked for the look.
Displayed cards change because other pictures are sampled, and for no other reason.

Example: a paused picture is answered by one analysis and two reuses; the card named is the one a
third full analysis would name.

Test: `geometric-focus.test.ts:1316`; across the pacing rules: pending (slow-clock test)

### S-X2 — The two halves come from one release of the contract

The content script and the compute frame speak the same `PROTOCOL_VERSION`. With another version
nothing is captured and the product hears a version problem.

Example: the content script is at version 2 and a stale compute frame answers with version 1: no
capture, and a version problem is reported.

Test: `capture-control.test.ts:662`

### S-X3 — Pictures go to the extension's compute frame and nowhere else

A picture is transferred to the compute frame or closed, never sent over the network. A picture in
a message the compute frame does not take is closed.

Example: a page posts a message with an `ImageBitmap` to the compute frame from another origin: the
bitmap is closed.

Test: `compute-frame.test.ts:214`, `capture-control.test.ts:784`

### S-X4 — A product vendors the runtime from one toolkit commit

Every runtime file a product ships, this clause index included, comes from one toolkit commit,
recorded with each file's hash in one manifest and checked against that commit's built files.

Status: changes in 0.14.0.

Example: a product updates two files from a newer commit and leaves the rest: the check fails.

Today: one product records the hashes of its vendored files and checks them; the other has no
check.

Test: pending (vendoring check)

