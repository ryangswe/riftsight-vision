# SPDX-License-Identifier: Apache-2.0
"""Hover outcomes recorded in a web browser, read back and scored here.

The scoring page of ``browser/`` runs the browser runtime on video files: for each manifest row
it finds the labeled frame in the video, analyzes it, and records what the hover rule shows at
every labeled point and at the center of every labeled box. It writes one JSON Lines file,
the *events file*. This module reads that file and scores it with the scorer and the bootstrap
that ``cardvision evaluate hover`` uses for frames it analyzes itself
(``cardvision.evaluate.events``): nothing about what is right or wrong is decided in the page.

**The file.** The first line says what ran: the release id and its settings as the browser read
them, its identity rule among them, the runtime's name and version, the browser's user agent,
the backend each model ran on, the role scored and the manifests read. Every other line is one
manifest row of that role, with a ``status``:

==============  ===============================================================================
``kept``        the row's frame was found and analyzed; ``points`` and ``centers`` hold one
                outcome per labeled point and per box, in manifest order
``unreachable`` no frame within a second of the row's time was near enough to its fingerprint
                (``frame.distance`` is the nearest found); the row was not analyzed
``no-video``    no video file was given for the row
``frame-shape`` the video has another shape than the frame the labels were made on
``failed``      the frame could not be read or analyzed; ``reason`` says why
==============  ===============================================================================

**The frame-selection check.** Reading the file refuses it when what it records about the
choice of frames cannot be what this package would have chosen:

- a ``kept`` row whose ``frame.distance`` is above the ``frameSelection.maxHamming`` of the
  file's own header, or above this package's own limit (``SAME_FRAME_MAX_HAMMING``);
- a ``kept`` row whose ``frame.offset`` puts the frame after the window of the header's
  ``frameSelection.windowSeconds`` either side of the row's time. Where the browser did not
  report frame times (``frame.exactTime`` false) a frame before the window is refused too.
  Where it did, a frame that starts before the window is accepted: the frame on screen at the
  start of the window belongs to the window, however long before it started;
- a header whose ``frameSelection`` is not this package's (``FINGERPRINT_WINDOW_SECONDS``
  and ``SAME_FRAME_MAX_HAMMING``).

**The identity rule.** The header records the identity rule of the release the browser ran
(``release.identity.level``, ``name`` or ``printing``). That rule decided every margin, and so
which cards were shown. The outcomes are scored under the same rule: a catalog that states
another is refused (``open_browser_configuration``), because the counts would be of one rule's
answers judged by the other's. A file written before the rule was recorded has no such field
and is read as ``name``, the only rule there was.

**The correspondence check.** The file must describe exactly the rows being scored: the same
role, one line for every manifest row of that role and no other line, the same number of points
and boxes in each, and every recorded position equal to the manifest's. Anything else is
refused, because outcomes would be scored against labels they were not recorded for.

**The manifests' hashes.** The header records the SHA-256 of each manifest the browser read. A
manifest given for scoring that is not one of them, byte for byte, is a warning and not a
refusal (``manifest_warnings``): the correspondence check above is what guards the rows.

**The account.** A ``kept`` row is *used*. A row with any other status is *unusable* with its
status as the reason, listed with what it would have contributed, exactly as a row whose frame
is missing is listed by the other measures.

**Boxes.** The page records a shown box in pixels of the frame it analyzed. It is brought to
pixels of the decoded video here, which is where ``cardvision evaluate hover`` has its boxes.
"""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from cardvision.core.catalog import IDENTITY_NAME, IDENTITY_RULES, Catalog
from cardvision.data.dhash import SAME_FRAME_MAX_HAMMING
from cardvision.data.extract import FINGERPRINT_WINDOW_SECONDS
from cardvision.data.schema import Row, RowKey
from cardvision.evaluate.config import file_sha256
from cardvision.evaluate.events import (
    Event,
    Scored,
    named_face_centers,
    row_events,
    score_event,
    shown_identity,
    truth_identity,
)
from cardvision.evaluate.hover import ACCEPTED_NMS, ACCEPTED_NMS_IOU, SELECTIONS, Shown
from cardvision.evaluate.rows import Account

EVENTS_KIND = "cardvision-browser-events"
EVENTS_VERSION = 1
KEPT = "kept"
STATUSES = (KEPT, "unreachable", "no-video", "frame-shape", "failed")

# A recorded position may differ from the manifest's by this much, in fractions of the frame.
POSITION_TOLERANCE = 1e-9
# How many mismatches a refusal spells out.
LISTED_PROBLEMS = 8
# The page records a frame's offset to the millisecond.
OFFSET_TOLERANCE = 0.001


class BrowserEventsError(ValueError):
    """An events file is malformed, or does not describe the rows being scored."""


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value


def _need(doc: Any, path: str, kind: type | tuple[type, ...], where: str) -> Any:
    """``doc[a][b]...`` for a dotted ``path``, checked to be of ``kind``."""
    value = doc
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            raise BrowserEventsError(f"{where}: {path} is missing")
        value = value[part]
    if not isinstance(value, kind) or isinstance(value, bool) and kind is not bool:
        raise BrowserEventsError(f"{where}: {path} is not of the expected form")
    return value


def _outcomes(line: Mapping[str, Any], name: str, count: int, where: str) -> list[dict[str, Any]]:
    found = line.get(name)
    if not isinstance(found, list) or len(found) != count:
        raise BrowserEventsError(f"{where}: {name} must list {count} outcome(s), one per label")
    for index, outcome in enumerate(found):
        at = f"{where}: {name}[{index}]"
        if not isinstance(outcome, dict) or outcome.get("index") != index:
            raise BrowserEventsError(f"{at} must be an object with index {index}")
        if not _is_number(outcome.get("x")) or not _is_number(outcome.get("y")):
            raise BrowserEventsError(f"{at} must give x and y")
        shown = (outcome.get("cardId"), outcome.get("name"))
        if not (shown == (None, None) or all(isinstance(text, str) and text for text in shown)):
            raise BrowserEventsError(f"{at} must give a cardId and a name, or null for both")
        box = outcome.get("box")
        if box is not None and not (isinstance(box, list) and len(box) == 4 and all(_is_number(v) for v in box)):
            raise BrowserEventsError(f"{at}: box must be four numbers or null")
        if shown[0] is not None and box is None:
            raise BrowserEventsError(f"{at} shows a card without a box")
    return found


def _check_kept_frame(line: Mapping[str, Any], header: Mapping[str, Any], where: str) -> None:
    """Refuse a kept row whose frame cannot be one the stated frame selection keeps (the
    module's "frame-selection check")."""
    offset = _need(line, "frame.offset", (int, float), where)
    exact = _need(line, "frame.exactTime", bool, where)
    frame = line["frame"]
    if "distance" not in frame:
        raise BrowserEventsError(f"{where}: frame.distance is missing")
    distance = frame["distance"]
    if distance is not None and (isinstance(distance, bool) or not isinstance(distance, int) or distance < 0):
        raise BrowserEventsError(f"{where}: frame.distance must be a whole number of bits, or null")
    row = f"the row {line['platform']} {line['video_id']} t={line['t']}"
    window, limit = header["frameSelection"]["windowSeconds"], header["frameSelection"]["maxHamming"]
    if distance is not None and distance > limit:
        raise BrowserEventsError(f"{where}: {row} was kept on a frame {distance} bits from its fingerprint, and the "
                                 f"file's own header gives {limit:g} bits as the most")
    if distance is not None and distance > SAME_FRAME_MAX_HAMMING:
        raise BrowserEventsError(f"{where}: {row} was kept on a frame {distance} bits from its fingerprint, and this "
                                 f"package keeps a frame at most {SAME_FRAME_MAX_HAMMING} bits away")
    if offset > window + OFFSET_TOLERANCE or (not exact and offset < -window - OFFSET_TOLERANCE):
        raise BrowserEventsError(f"{where}: {row} was kept on a frame {offset:g} s from its time, outside the window of "
                                 f"{window:g} s either side that the file's own header gives")


@dataclass(frozen=True)
class BrowserRow:
    """One row line of an events file.

    Attributes:
        key: the row's platform, video id and time.
        status: see the module's table.
        points, boxes: how many of each the browser read from the manifest row.
        line: the whole line, as read.
    """

    key: RowKey
    status: str
    points: int
    boxes: int
    line: Mapping[str, Any] = field(compare=False, repr=False)

    @property
    def detail(self) -> str | None:
        """A few words on why a row that was not kept was not, for the report."""
        frame = self.line.get("frame") or {}
        if self.status == "unreachable":
            return f"the nearest frame was {frame.get('distance')} bits from the row's fingerprint"
        if self.status == "frame-shape":
            video = self.line.get("video") or {}
            return f"the video is {video.get('width')} x {video.get('height')}"
        if self.status == "failed":
            return str(self.line.get("reason") or "no reason recorded")
        return None


@dataclass(frozen=True)
class BrowserRun:
    """An events file, read and checked for form.

    Attributes:
        path: the file.
        header: its first line.
        rows: its row lines by row key, in file order.
    """

    path: Path
    header: Mapping[str, Any]
    rows: Mapping[RowKey, BrowserRow]

    @property
    def role(self) -> str:
        return self.header["role"]

    @property
    def identity_recorded(self) -> bool:
        """Whether the header records the identity rule of the release the browser ran."""
        return self.header["release"].get("identity") is not None

    @property
    def identity(self) -> str:
        """The identity rule the outcomes were recorded under: the header's
        ``release.identity.level``, or ``name`` for a file written before it was recorded."""
        return self.header["release"]["identity"]["level"] if self.identity_recorded else IDENTITY_NAME


def read_browser_events(path: str | Path) -> BrowserRun:
    """Read an events file. Raises ``BrowserEventsError`` naming the file and what is wrong:
    its form, or what it records about the choice of frames (the module's "frame-selection
    check")."""
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"{path}: no such events file")
    name = path.name
    docs: list[tuple[int, Any]] = []
    with open(path, encoding="utf-8") as handle:
        for number, text in enumerate(handle, start=1):
            if not text.strip():
                continue
            try:
                docs.append((number, json.loads(text)))
            except ValueError:
                raise BrowserEventsError(f"{name}: line {number} is not valid JSON") from None
    if not docs:
        raise BrowserEventsError(f"{name}: the file is empty")
    _, header = docs[0]
    if not isinstance(header, dict) or header.get("kind") != EVENTS_KIND:
        raise BrowserEventsError(f"{name}: the first line is not the header of a {EVENTS_KIND} file")
    if header.get("version") != EVENTS_VERSION:
        raise BrowserEventsError(f"{name}: version {header.get('version')!r} is not one this package reads ({EVENTS_VERSION})")
    where = f"{name}: header"
    for item in ("release.id", "release.game", "release.ortWeb", "runtime.name", "runtime.version", "userAgent",
                 "backend.asked", "backend.detector", "backend.recognizer", "role", "release.hover.selection"):
        _need(header, item, str, where)
    for item in ("release.accept.tau", "release.accept.delta", "release.detector.threshold", "release.detector.nmsIou",
                 "release.detector.maxProposals", "release.detector.minCropPx", "release.analysisWidth.min",
                 "release.analysisWidth.max", "frameSelection.windowSeconds", "frameSelection.maxHamming"):
        _need(header, item, (int, float), where)
    _need(header, "release.accept.rotationRetry", bool, where)
    if header["release"]["hover"]["selection"] not in SELECTIONS:
        raise BrowserEventsError(f"{where}: unknown hover selection {header['release']['hover']['selection']!r}")
    if header["release"].get("identity") is not None and _need(header, "release.identity.level", str, where) not in IDENTITY_RULES:
        raise BrowserEventsError(f"{where}: release.identity.level must be one of {list(IDENTITY_RULES)}, not "
                                 f"{header['release']['identity']['level']!r}")

    rows: dict[RowKey, BrowserRow] = {}
    for number, line in docs[1:]:
        where = f"{name}: line {number}"
        if not isinstance(line, dict):
            raise BrowserEventsError(f"{where} is not a JSON object")
        platform, video_id = _need(line, "platform", str, where), _need(line, "video_id", str, where)
        t = _need(line, "t", (int, float), where)
        status = _need(line, "status", str, where)
        if status not in STATUSES:
            raise BrowserEventsError(f"{where}: unknown status {status!r}")
        points, boxes = _need(line, "labels.points", int, where), _need(line, "labels.boxes", int, where)
        if status == KEPT:
            _outcomes(line, "points", points, where)
            _outcomes(line, "centers", boxes, where)
            for item in ("video.width", "video.height", "analyzed.width", "analyzed.height"):
                if _need(line, item, (int, float), where) <= 0:
                    raise BrowserEventsError(f"{where}: {item} must be above 0")
            _check_kept_frame(line, header, where)
        key = (platform, video_id, float(t))
        if key in rows:
            raise BrowserEventsError(f"{where}: the row {platform} {video_id} t={t} is given twice")
        rows[key] = BrowserRow(key=key, status=status, points=points, boxes=boxes, line=line)
    window, limit = header["frameSelection"]["windowSeconds"], header["frameSelection"]["maxHamming"]
    if (window, limit) != (FINGERPRINT_WINDOW_SECONDS, SAME_FRAME_MAX_HAMMING):
        raise BrowserEventsError(
            f"{name}: header: the frames were chosen within {window:g} s of each row's time and {limit:g} bits of its "
            f"fingerprint, and this package chooses within {FINGERPRINT_WINDOW_SECONDS:g} s and {SAME_FRAME_MAX_HAMMING} bits")
    return BrowserRun(path=path, header=header, rows=rows)


def manifest_warnings(run: BrowserRun, manifests: Sequence[Mapping[str, Any]]) -> list[str]:
    """What to say about each manifest given for scoring that is not, byte for byte, a manifest
    the browser read; empty when every one is.

    ``manifests`` are the manifests being scored, each with its ``file`` name and ``sha256``
    (``Account.manifests``). They are compared with the ``manifests`` of the file's header. A
    difference is not a refusal: ``check_correspondence`` is what guards the rows.
    """
    recorded = [entry for entry in run.header.get("manifests") or [] if isinstance(entry, dict)]
    hashes = {entry.get("sha256") for entry in recorded}
    by_name = {entry.get("file"): entry.get("sha256") for entry in recorded}
    warnings = []
    for manifest in manifests:
        if manifest["sha256"] in hashes:
            continue
        if manifest["file"] in by_name:
            warnings.append(f"{manifest['file']}: its SHA-256 is {manifest['sha256']}, and {run.path.name} recorded "
                            f"{by_name[manifest['file']]} for the manifest of that name; the file has changed since "
                            "the browser read it")
        else:
            names = ", ".join(str(entry.get("file")) for entry in recorded) or "none"
            warnings.append(f"{manifest['file']}: its SHA-256 is {manifest['sha256']}, and {run.path.name} recorded no "
                            f"manifest of that name or content (it recorded: {names})")
    return warnings


# ------------------------------------------------------------------------- the correspondence
def _center(quad: Sequence[Sequence[float]]) -> tuple[float, float]:
    """The center of a box as ``cardvision.evaluate.events`` computes it: the mean of its corners."""
    points = np.asarray(quad, dtype=np.float64).reshape(-1, 2)
    return float(points[:, 0].mean()), float(points[:, 1].mean())


def _positions(row: Row) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """The positions the page asks about for a row: its points, and its boxes' centers."""
    return [(point.x, point.y) for point in row.points or ()], [_center(box.quad) for box in row.boxes or ()]


def _describe(row: Row) -> str:
    return f"{row.platform} {row.video_id} t={row.t}"


def correspondence_problems(rows: Sequence[Row], run: BrowserRun, role: str) -> list[str]:
    """Why the events file does not describe ``rows`` (the manifest rows of ``role``); empty
    when it does."""
    problems: list[str] = []
    if run.role != role:
        return [f"it holds the rows of role {run.role!r}, and the role being scored is {role!r}"]
    wanted = {row.key for row in rows}
    for row in rows:
        found = run.rows.get(row.key)
        if found is None:
            problems.append(f"it has no line for the row {_describe(row)}")
            continue
        points, centers = _positions(row)
        if (found.points, found.boxes) != (len(points), len(centers)):
            problems.append(f"the row {_describe(row)} has {len(points)} point(s) and {len(centers)} box(es) in the "
                            f"manifest, and {found.points} and {found.boxes} in the events file")
            continue
        if found.status != KEPT:
            continue
        for name, expected in (("points", points), ("centers", centers)):
            for index, ((x, y), outcome) in enumerate(zip(expected, found.line[name])):
                if abs(outcome["x"] - x) > POSITION_TOLERANCE or abs(outcome["y"] - y) > POSITION_TOLERANCE:
                    problems.append(f"the row {_describe(row)}: {name}[{index}] was recorded at ({outcome['x']}, "
                                    f"{outcome['y']}), and the manifest puts it at ({x}, {y})")
                    break
    for key in run.rows:
        if key not in wanted:
            problems.append(f"its row {key[0]} {key[1]} t={key[2]} is not a row of role {role!r} in the manifests")
    return problems


def check_correspondence(rows: Sequence[Row], run: BrowserRun, role: str) -> None:
    """Refuse an events file that does not describe ``rows``. Raises ``BrowserEventsError``."""
    problems = correspondence_problems(rows, run, role)
    if problems:
        listed = "; ".join(problems[:LISTED_PROBLEMS])
        more = f"; and {len(problems) - LISTED_PROBLEMS} more" if len(problems) > LISTED_PROBLEMS else ""
        raise BrowserEventsError(f"{run.path.name} does not correspond to the manifests: {listed}{more}")


# ------------------------------------------------------------------------------------ scoring
def _outcome_of(event: Event, row: Row, found: BrowserRow) -> Mapping[str, Any]:
    """The recorded outcome at an event's position: by the label's place in the row."""
    if event.kind == "point":
        labels, outcomes, prefix = row.points or (), found.line["points"], "p"
        places = [(point.x, point.y) for point in labels]
    else:
        labels, outcomes, prefix = row.boxes or (), found.line["centers"], "b"
        places = [_center(box.quad) for box in labels]
    named = [index for index, label in enumerate(labels) if (label.id or f"{prefix}{index}") == event.label]
    exact = [index for index in named if places[index] == (event.x, event.y)]
    return outcomes[(exact or named)[0]]


def _shown(outcome: Mapping[str, Any], scale_x: float, scale_y: float) -> Shown:
    box = outcome["box"]
    if box is not None:
        box = (box[0] * scale_x, box[1] * scale_y, box[2] * scale_x, box[3] * scale_y)
    return Shown(index=None, box=box, name=outcome["name"], card_id=outcome["cardId"])


def run_browser_hover(rows: Sequence[Row], run: BrowserRun, names: Mapping[str, str], account: Account,
                      identities: Mapping[str, str] | None = None) -> list[Scored]:
    """Score every hover event of ``rows`` from the outcomes a browser recorded.

    ``rows`` are the manifest rows of the role (``cardvision.evaluate.rows.read_rows``) and
    ``names`` maps card id to name. ``identities`` maps card id to identity key
    (``Catalog.identities()``): a shown card is right when it has the labeled card's
    identity. Left out, the shown name and the labeled name are compared. The file is first
    checked against the rows (``check_correspondence``). The account is filled as
    ``scorable_rows`` fills it: a row without a label for this measure is skipped, a row the
    browser did not keep is unusable.
    """
    check_correspondence(rows, run, account.role)
    scored: list[Scored] = []
    for row in rows:
        found = run.rows[row.key]
        wanted = Counter(event.role for event in row_events(row, names))
        if not sum(wanted.values()):
            account.skipped["no-labels"] += 1
            continue
        if found.status != KEPT:
            account.unusable[found.status] += 1
            account.labels_lost.update(wanted)
            entry = {"platform": row.platform, "video_id": row.video_id, "t": row.t, "group": row.group,
                     "source_type": row.source_type, "reason": found.status, "lost": dict(sorted(wanted.items()))}
            if found.detail is not None:
                entry["detail"] = found.detail
            account.not_scored.append(entry)
            continue
        account.frames_present += 1
        account.used += 1
        line = found.line
        width, height = line["video"]["width"], line["video"]["height"]
        scale_x, scale_y = width / line["analyzed"]["width"], height / line["analyzed"]["height"]
        keys = names if identities is None else identities
        faces_px = [(x * width, y * height, key) for x, y, key in named_face_centers(row, keys)]
        for event in row_events(row, names, account.labels_skipped):
            shown = _shown(_outcome_of(event, row, found), scale_x, scale_y)
            scored.append(score_event(event, shown, faces_px, shown_identity(shown, names, identities),
                                      truth_identity(event, identities)))
    return scored


# ------------------------------------------------------------------------- what the report says
@dataclass
class BrowserConfiguration:
    """What a browser run scored, in the shape ``cardvision.evaluate.report`` prints.

    Attributes:
        run: the events file.
        catalog: the catalog the labeled names come from.
        files: label to ``{"file": name, "sha256": ...}`` for the events file, the catalog and,
            when one was given, the release document.
        release_checked: whether the release id in the events file was checked against a
            release document.
    """

    run: BrowserRun
    catalog: Catalog
    files: dict[str, dict[str, str]]
    release_checked: bool = False

    def describe(self) -> dict[str, Any]:
        """What ran, as the browser recorded it. No model was opened by this package."""
        header = self.run.header
        release, detector = header["release"], header["release"]["detector"]
        selection = release["hover"]["selection"]
        rows = Counter(row.status for row in self.run.rows.values())
        distances = Counter(row.line["frame"]["distance"] for row in self.run.rows.values()
                            if row.status == KEPT and (row.line.get("frame") or {}).get("distance") is not None)
        return {
            "release": release["id"],
            "files": {label: dict(entry) for label, entry in self.files.items()},
            "identity": self.catalog.identity_description,
            "accept": {"tau": release["accept"]["tau"], "delta": release["accept"]["delta"],
                       "rotationRetry": release["accept"]["rotationRetry"]},
            **({"tiltedRetry": dict(release["tiltedRetry"])} if isinstance(release.get("tiltedRetry"), dict) else {}),
            "hover": {"selection": selection,
                      **({"nmsIou": release["hover"].get("nmsIou", ACCEPTED_NMS_IOU)} if selection == ACCEPTED_NMS else {})},
            "detector": {"threshold": detector["threshold"], "nmsIou": detector["nmsIou"],
                         "maxDetections": detector["maxProposals"], "minCropPx": detector["minCropPx"]},
            "analysisWidth": {"min": release["analysisWidth"]["min"], "max": release["analysisWidth"]["max"]},
            "browser": {
                "runtime": dict(header["runtime"]),
                "ortWeb": release["ortWeb"],
                "userAgent": header["userAgent"],
                "backend": dict(header["backend"]),
                "frameSelection": dict(header["frameSelection"]),
                "releaseChecked": self.release_checked,
                "manifestsRead": list(header.get("manifests") or []),
                "rows": {status: rows[status] for status in STATUSES},
                "fingerprintDistances": {str(distance): count for distance, count in sorted(distances.items())},
            },
        }


def open_browser_configuration(
    events: str | Path, *, catalog: str | Path | None = None, release: str | Path | None = None
) -> BrowserConfiguration:
    """Read an events file and the catalog its labels are named by.

    Give ``catalog``, or ``release``: a release document, whose catalog is used and whose id
    must be the one the browser recorded. The release's model files are not opened and need not
    be present. The catalog must state the identity rule the file was recorded under (the
    module's "identity rule"). Raises ``BrowserEventsError``, ``FileNotFoundError`` or
    ``ValueError``.
    """
    from cardvision.bank.documents import read_json
    from cardvision.bank.release import release_id
    from cardvision.core.catalog import load_catalog

    run = read_browser_events(events)
    files = {"browserEvents": {"file": run.path.name, "sha256": file_sha256(run.path)}}
    if release is not None:
        release = Path(release)
        if not release.is_file():
            raise FileNotFoundError(f"{release}: no such release file")
        doc = read_json(release)
        block = doc.get("catalog") if isinstance(doc, dict) else None
        if not isinstance(block, dict) or not isinstance(block.get("path"), str) or doc.get("id") != release_id(doc):
            raise ValueError(f"{release.name}: not a release document whose id is the hash of its content")
        if doc["id"] != run.header["release"]["id"]:
            raise BrowserEventsError(f"{run.path.name} was recorded with release {run.header['release']['id']}, and "
                                     f"{release.name} is release {doc['id']}")
        catalog = release.parent / block["path"]
        if not catalog.is_file():
            raise FileNotFoundError(f"{catalog}: no such catalog file")
        if file_sha256(catalog) != block.get("sha256"):
            raise ValueError(f"{catalog.name}: its SHA-256 is not the one {release.name} pins")
        files["release"] = {"file": release.name, "sha256": file_sha256(release)}
    elif catalog is None:
        raise ValueError("give --catalog, or --release, so that labeled card ids can be turned into names")
    catalog = Path(catalog)
    if not catalog.is_file():
        raise FileNotFoundError(f"{catalog}: no such catalog file")
    files["catalog"] = {"file": catalog.name, "sha256": file_sha256(catalog)}
    loaded = load_catalog(catalog)
    if run.identity != loaded.identity:
        if run.identity_recorded:
            raise BrowserEventsError(
                f'{run.path.name} was recorded under the identity rule "{run.identity}", and {catalog.name} states '
                f'"{loaded.identity}": score it with the catalog of the release it was recorded with, or record the '
                "events again with a release of this catalog")
        raise BrowserEventsError(
            f'{run.path.name} records no identity rule, so it is read as recorded under "{run.identity}", and '
            f'{catalog.name} states "{loaded.identity}": record the events again, with this version of the scoring '
            "page and a release of this catalog")
    return BrowserConfiguration(run=run, catalog=loaded, files=files, release_checked=release is not None)
