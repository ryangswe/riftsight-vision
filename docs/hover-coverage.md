<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hover spec coverage

Generated from [hover-spec.md](hover-spec.md) by `python tests/support_hover_spec.py`, which
also writes `hover-spec.json`. Do not edit it by hand; `--check` fails when it is out of date.

- **Status**: the clause's mark in the spec (`current` when it has none).
- **Unit tests**: how many `file:line` tests the clause's Test paragraph lists.
- **Browser checks**: the hover browser test checks it cites (`harness check <name>`).
- **Pending**: the parts a test does not check yet, as the spec marks them.

71 clauses; 70 with unit tests; 19 with browser checks; 1 pending only; 4 partial (a test or check, and a pending mark).

| Clause | Title | Status | Unit tests | Browser checks | Pending |
| --- | --- | --- | --- | --- | --- |
| S-A1 | On a load-at-play page, the frames are made when the main video plays | current | 5 | frames-at-play | - |
| S-A2 | Elsewhere, the opening trusted pointer over the picture makes the frames | current | 3 | fake-pointer-ignored | - |
| S-A3 | The geometric stage loads at the earliest pointer, not at play | current | 2 | - | - |
| S-A4 | After 10 idle minutes, the worker ends and both frames are removed | current | 3 | idle-unloads | - |
| S-A5 | A pointer, a shown card or a look in flight keeps the model loaded | current | 3 | - | - |
| S-A6 | After an idle unload, a trusted move or tap over the video makes the frames again | current | 4 | loop-no-reload, idle-reload-on-hover | - |
| S-A7 | Turning hovers back on while the video plays loads at once in the tab in front | changes in a product release | 6 | on-while-playing-loads, switch-on-after-idle-reloads | - |
| S-A8 | A background tab waits for the front before it loads | changes in a product release | 3 | - | - |
| S-A9 | A worker that stops is restarted once; a second stop turns recognition off | current | 2 | - | - |
| S-A10 | A frame the page deletes is made again at the next trusted play or pointer move, or when a card on show is placed again | changes in a product release | 9 | frames-at-play | - |
| S-B1 | Pictures are taken on trusted pointer events alone | current | 1 | - | - |
| S-B2 | A hover gives pictures for 10 s, then while a card shows and 5 s after | current | 3 | - | - |
| S-B3 | Nothing is captured more than 60 s after the last trusted pointer event | current | 2 | - | - |
| S-B13 | A frame that becomes ready late gets one picture for a pointer that still rests | current | 48 | second-tab-names-card | real-browser test |
| S-B4 | A tap gives pictures for 10 s and no longer | current | 3 | - | - |
| S-B5 | Before every capture, the last trusted point is checked against the picture now | current | 1 | - | - |
| S-B6 | Leaving, hiding the page or changing the video clears all authority | current | 1 | - | - |
| S-B7 | No picture is asked for before a pointer is over the video | current | 2 | no-capture-before-pointer | - |
| S-B8 | A frame made at play holds no capture authority | current | 3 | - | - |
| S-B9 | Messages count when trusted and from the right window and origin | current | 3 | - | - |
| S-B10 | A late reply after a reset revives nothing | current | 2 | - | - |
| S-B11 | Off means off | current | 2 | off-means-off | real-browser test |
| S-B12 | A product's privacy page states the gate's timings as the code has them | current | 0 | - | real-browser test |
| S-C1 | Looks follow the pointer: the fast cadence while it is active | current | 2 | - | - |
| S-C2 | A pointer resting on a shown card is looked at on the slow cadence | current | 2 | - | - |
| S-C3 | Under the reading hold, a resting pointer on a kept card gets no looks | current | 2 | - | - |
| S-C4 | Nothing is asked for while the pointer is off the picture | current | 2 | - | - |
| S-C5 | A pointer message over a stale picture asks for a look on that message | current | 7 | - | - |
| S-C6 | When a load ends with the pointer active, the look is asked at once | current | 6 | - | - |
| S-C7 | A pointer on an unverified card of a playing video asks for a look at once | current | 9 | - | - |
| S-C8 | A pointer on an unverified card of a still picture asks for a look again | current | 1 | - | - |
| S-C9 | In an in-page session, a cut under a shown card asks for a look at once | current | 2 | - | - |
| S-C10 | A look that comes back unanswered is retried after 250, 500, 1000, then 2000 ms | current | 4 | - | - |
| S-C11 | A waiting retry holds every look but the one a move or tap onto a different card starts | current | 38 | - | - |
| S-C12 | A refused capture is not retried; the next pointer move asks again | current | 3 | - | - |
| S-C13 | A look with no reply is given up on after 5 s, or 15 s before the opening analysis | current | 2 | - | - |
| S-C14 | A pointer resting on an empty spot is looked at every 2 s | current | 4 | arrives-under-rest | - |
| S-C15 | A still picture is analyzed three times, then not again until it changes | current | 2 | paused-names-each | - |
| S-C16 | A repeat of an unchanged still picture reuses the look before it | current | 1 | - | - |
| S-C17 | One look in flight | current | 3 | - | - |
| S-C18 | Pointer-started looks are at least 250 ms apart | current | 2 | - | - |
| S-P1 | Keep-fresh looks are paced from the measured analysis time | current | 4 | - | - |
| S-P5 | A stale picture is looked at early enough that the answer stays within its lifetime | current | 23 | - | - |
| S-P2 | Looks a viewer waits for are not slowed by pacing | current | 5 | - | - |
| S-P3 | Under the shown hold, a reading look comes before the card's hold runs out | current | 11 | - | - |
| S-P4 | The pacer learns from analyses that were not reused | current | 2 | - | - |
| S-W1 | A card is shown when it is named; a box detected and not named shows nothing | current | 2 | art-visible | - |
| S-W2 | A result more than 2000 ms of video from the picture on screen is not shown | current | 2 | - | - |
| S-W3 | Nothing from before a seek or a new source is shown | current | 3 | - | - |
| S-W4 | With keep-card on, a card stays while the pointer stays where it was seen | current | 5 | move-off-clears | - |
| S-W5 | Under the reading hold, moving onto an overlapping card shows it | current | 3 | covered-kept | - |
| S-W6 | With keep-card off, a card is kept through short gaps | current | 5 | still-card-no-blink | - |
| S-W7 | A kept card seen gone is marked held until it is seen again | current | 4 | - | - |
| S-W8 | A shown card is reported again when it changes, not for a look's wobble | current | 3 | still-outline-steady | - |
| S-W9 | In focus scope, nothing is shown where an unverified card overlaps the pointer | current | 1 | - | - |
| S-F1 | The outline is the shown card's box on the picture, shown with the tooltip | current | 8 | outline-shows | - |
| S-F2 | A turned card is hovered and outlined along its own edges | current | 3 | - | - |
| S-F3 | A turned outline is always turned, and never reaches past the picture | changes in a product release | 3 | - | - |
| S-F4 | A held card keeps its tooltip and loses its outline | current | 1 | held-outline-hides | real-browser test |
| S-G1 | Hovers run on watch, live and embed pages on YouTube, and on Twitch | changes in a product release | 4 | - | - |
| S-G2 | On YouTube, watch and live pages load at play; embeds wait for a hover | current | 1 | - | - |
| S-G3 | On Twitch, channel, video and clip pages load at play; seven side pages wait for a hover | changes in a product release | 5 | - | - |
| S-G4 | The main video is the largest one on show | current | 7 | - | - |
| S-G5 | After in-page navigation off an active page, a shrunk player is not captured | changes in a product release | 3 | - | - |
| S-H1 | One switch turns hovers on and off, at once, in every tab | current | 9 | - | - |
| S-H2 | Keep-card picks the hold: on by default | current | 4 | switch-flips | - |
| S-H3 | A keep-card change remakes the compute frame: now in front, later behind | current | 9 | - | - |
| S-X1 | Scheduling never changes what an analysis answers | current | 1 | - | slow-clock test |
| S-X2 | The two halves come from one release of the contract | current | 1 | - | - |
| S-X3 | Pictures go to the extension's compute frame and nowhere else | current | 2 | - | - |
| S-X4 | A product vendors the runtime from one toolkit commit | changes in a product release | 3 | - | - |
