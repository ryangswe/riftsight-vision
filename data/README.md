<!-- SPDX-License-Identifier: Apache-2.0 -->

# Data

Labels for frames of public videos, as text. **There are no frames, images or videos here, and
none may be added.**

| File | What it is |
| --- | --- |
| `SCHEMA.md` | The label manifest format, field by field, and the extraction contract: how a row's frame is obtained from its video. |
| `manifest.schema.json` | The JSON Schema of one manifest row. |
| `example.manifest.jsonl` | A small made-up manifest showing every kind of label. Its video ids are placeholders and name no video. |

## License

**Label manifests are licensed under the Creative Commons Attribution 4.0 International license
(CC BY 4.0).** To give credit, name this repository; each row also carries the credit its
contributor chose, in `credit`.

- **The license covers the annotations only**: the boxes, points, card ids and flags that the
  labelers made. **It does not cover the videos.** Every video stays with whoever holds its
  rights, and nothing here grants any permission to copy, download or reuse one.
- **A video id identifies its channel.** Channel names are left out of the manifests as a
  courtesy; that is not anonymity, and the manifests should not be treated as if it were.
- A channel that wants its rows taken out can ask, and the rows are removed from this
  repository. A CC BY 4.0 grant cannot be withdrawn, so copies already taken elsewhere are
  beyond reach.

The schema, this page and the code that reads manifests are licensed under Apache-2.0, like the
rest of the repository.

## Check a manifest

```
cardvision validate-manifest data/example.manifest.jsonl --catalog games/_template/catalog.json
```

The check reads files and nothing else: it opens no network connection and decodes no image.
It refuses, among other things, any file in the manifest's folder that is not plain text.
`SCHEMA.md` lists everything it checks.

## Get the frames

A manifest row points at a frame; it does not contain one. To work with the pixels you need
the video.

**From video files you already have:**

```
cardvision fetch MANIFEST --out /path/to/frames --video-file EXAMPLE0001=/path/to/video.mp4
```

`--video-file` may be repeated, once per video. Each file must be the whole video from its
beginning. This is also how to get the frames of a recording of your own (a row whose
`platform` is `local`; `SCHEMA.md`, "Recordings of your own"): give `ID` as the name the
manifest uses for it. Reading video needs the optional `video` extra. The package is installed
from this repository, not from a package index, so run this in the repository folder:
`python -m pip install -e ".[video]"`.

**By downloading** (the first line is run in the repository folder):

```
python -m pip install -e ".[video,download]"
cardvision fetch MANIFEST --out /path/to/frames --download
```

**Downloading is your own act.** Nothing is downloaded unless you pass `--download`, and a
recording of your own (`local`) is never downloaded. The platform's terms of service apply to
you, and they may restrict downloading and automated access; handing the step to a tool does
not change that. Videos are fetched one at a time, never in parallel, with a pause between
them, and each downloaded file is deleted once its frames have been read.

The `download` extra brings the downloader and `certifi`, a bundle of CA certificates. It needs
Python 3.11 or later, like the rest of the package.

**If the first download fails with `CERTIFICATE_VERIFY_FAILED`**, your Python has no CA
certificates of its own. The macOS installer from python.org ships none. Nothing reached the
platform. The command stops and says what to install: the `download` extra as above, which
brings `certifi`, or `python -m pip install certifi` alone. `cardvision fetch-textures`,
`cardvision train-detector --download-pretrained`, `cardvision build-bank` and
`cardvision check-bank-art` with an `https` art address, and the `cardvision infer` contact
sheet with one, use the same certificates and give the same message.

**If the platform refuses**, the command stops at once. These are refusals: a rate limit (an
HTTP 429, or the downloader's message that the session was rate-limited), a check for
automated access (a "sign in to confirm you're not a bot" message, a captcha), a blocked
address, and a redirect to a "sorry" page. Asking again makes a refusal last longer. The rows
already done keep their frames. The command says how many rows were not tried, and exits with
code 3. Wait before you run it again; it picks up where it stopped. A "sign in to confirm your
age" message is no refusal. It is about one video: that video's rows fail and the run goes on.

**A part that fails for another reason is asked for once more**, after the usual pause. Such
failures are often passing ones. `--retries N` changes how many more times (`0`: never). The
index records how many times each part was asked for, and why it failed in one word (`cause`).
One kind of failure is not tried again: the platform's statement that the video is private,
removed or missing (`unavailable`), or that this request may not have it (`restricted`). A
second request would get the same answer, and neither would a later part of the same video:
its rows are marked failed with the same cause, and nothing is asked for.

**If several downloads in a row fail, the command stops too.** A few seconds of a video are
cut by a helper program, and when the platform turns that program away, all the command
learns is that the program failed: a rate limit cannot be read from it. So when 3 parts in a
row have failed, each after its retry, for no stated reason, the command stops, says that this
may be a rate limit or a network problem and how many rows were not tried, and exits with
code 3. Check the connection and wait before you run it again. `--stop-after-failures N`
changes the number (`0`: never stop). A part that downloads sets the count back. A video that
the platform says is private, removed or restricted does not count: that is an answer about
one video.

`--keep-video DIR` keeps the downloaded files in `DIR` instead of deleting them, with an index
of them. Each file is the few seconds around one or more rows, and its name says where it
starts in the video. The scoring page of `browser/` reads such files. `SCHEMA.md`, "Kept video
files", gives the names and the index.

**Kept files are read again.** With `--keep-video DIR`, a row that a file already in `DIR`
covers gets its frame from that file, and nothing is asked of the platform for it. So a second
run with the same `DIR` downloads only what is missing. `--keep-video DIR` also works without
`--download`: the frames are then cut from the kept files alone, with no network. That is how
to get the frames again in another format (`--format png`) or into another folder.

Either way:

- the command can be stopped and run again; rows that already have a frame are skipped;
- a row whose video has a different shape from the labeled frame is reported as unusable and
  gets no frame;
- a frame of the labeled shape and another size is written, because labels are fractions of
  the frame. The command says how many frames have another size than their row records, and
  the index marks each (`other_size`). The stream asked for is the best one up to 1080 pixels
  high, whatever height the row records;
- a fetched frame is not byte-identical to the frame that was labeled (see `SCHEMA.md`);
- the output folder must be outside this folder, and so must the folder of `--keep-video`.

The exit code is 0 when every selected row has a frame, and 1 when the run went to its end and
some row was left without one. It is 3 when the run stopped early and rows were not tried: the
platform refused a download, or several downloads in a row failed.

`--rows 1-20,35` and `--role evaluation` narrow the rows; `--whole-video` downloads each video
whole instead of a few seconds around each frame, which is heavier and exact to the frame.
`--max-whole-minutes N` skips a whole video that the downloader reports as longer than `N`
minutes; its rows fail with the cause `error`, and nothing is downloaded.

## Offer labels

Labels are accepted as manifest files only.

1. Write rows in the format of `SCHEMA.md` with `role` set to `extra`, `trained_on` set to
   `false`, and `reachable` and `reachable_checked` set to `null`. Put the credit you want in
   `credit`. The labeling tool in `labeler/` writes such a file from its own labels
   (`python3 labeler/export.py manifest`; its README says what the export needs).
2. Run `cardvision validate-manifest YOUR.jsonl --catalog CATALOG --contribution`.
3. Do not add frames, crops or screenshots, in any form.
4. Offer rows of videos on a platform only. A row of a recording of your own (`platform` set
   to `local`) cannot be offered, because nobody else can obtain the video; the check in
   step 2 refuses it. Keep such a manifest in a folder of your own.

You cannot choose whether your labels train or evaluate: each new recording group is given its
role by a seeded shuffle when the labels are accepted (`cardvision assign-roles`; the rule is
described in `SCHEMA.md`). Accepted labels are public under CC BY 4.0.
