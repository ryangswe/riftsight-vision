# SPDX-License-Identifier: Apache-2.0
"""The result of an evaluation as a JSON document and as a Markdown report.

Both say exactly what was scored before they say how it scored: the SHA-256 of each model, the
bank, the identity groups, the catalog and every manifest; the accept rule and the hover
selection; the package version; how many rows were read, used, skipped and unusable, with
reasons; and how many frames were present. A rate is always printed with its unreduced counts
and with both of its intervals, each labeled with what it assumes.

When the rows are generated scenes and not footage (``cardvision.evaluate.scenes``), the report
says so in its first lines, before anything else.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from cardvision import __version__
from cardvision.core.catalog import IDENTITY_DEFINITION, IDENTITY_NAME
from cardvision.evaluate import crops as crops_module
from cardvision.evaluate import detector as detector_module
from cardvision.evaluate.browser import BrowserConfiguration
from cardvision.evaluate.config import Configuration
from cardvision.evaluate.events import (
    ADJACENT_DEFINITION,
    CENTER_INSIDE_ANOTHER_BOX_DEFINITION,
    NAMED_RIGHT_DEFINITION,
    WRONG_OF_SHOWN_DEFINITION,
)
from cardvision.evaluate.rows import Account
from cardvision.evaluate.stats import BOOTSTRAP_NOTE, FEW_GROUPS, INDEPENDENCE_NOTE, caution

RESULT_KIND = "cardvision-evaluation"
RESULT_VERSION = 1
MEASURES = ("hover", "crops", "detector", "compare")
LISTED_ROWS = 50

INTERVAL_DEFINITIONS = {
    "exact95": "exact bound = a one-sided 95 % exact binomial (Clopper-Pearson) bound on the unfavorable side; "
               f"{INDEPENDENCE_NOTE}",
    "groupBootstrap95": "group bootstrap interval = the 2.5th to 97.5th percentile of the rate over resampled "
                        "recording groups (whole groups drawn with replacement, ratio of summed counts); it "
                        "accounts for dependence within recordings. With few groups or sparse errors it can be "
                        "unstable or misleadingly narrow, including 0 to 0 when no errors were observed: such "
                        f"intervals, and any over fewer than {FEW_GROUPS} groups, are marked to be read as descriptive",
}
HOVER_DEFINITIONS = {"namedRight": NAMED_RIGHT_DEFINITION, "wrongOfShown": WRONG_OF_SHOWN_DEFINITION,
                     "adjacent": ADJACENT_DEFINITION, "centerInsideAnotherBox": CENTER_INSIDE_ANOTHER_BOX_DEFINITION}
COMPARE_DEFINITIONS = {
    **HOVER_DEFINITIONS,
    "transition": "each event's outcome under the base and under the candidate, as right, wrong or nothing "
                  "(an adjacent name on an off-card position counts as nothing); events of readable faces, backs "
                  "and off-card positions only",
    "regression": "right -> nothing, right -> wrong and nothing -> wrong are regressions; every other "
                  "transition is not",
    "paired": "candidate minus base, both evaluated on the same resampled recording groups in every replicate",
}
DEFINITIONS = {"hover": HOVER_DEFINITIONS, "crops": crops_module.DEFINITIONS, "detector": detector_module.DEFINITIONS,
               "compare": COMPARE_DEFINITIONS}


def identity_definition(*configurations: Any) -> dict[str, str]:
    """One more definition for a report whose catalog states another identity rule than
    ``name``: the definitions speak of a card's name, and this line says how to read them.
    Nothing under the ``name`` rule, where a name is the identity."""
    rules = {config.catalog.identity for config in configurations}
    return {} if rules == {IDENTITY_NAME} else {"identity": IDENTITY_DEFINITION}


def build_result(
    measure: str,
    configurations: Mapping[str, Configuration | BrowserConfiguration],
    account: Account,
    results: Any,
    *,
    seed: int,
    replicates: int,
) -> dict[str, Any]:
    """The JSON document of one evaluation.

    ``configurations`` is ``{"configuration": c}`` for one configuration, or ``{"base": a,
    "candidate": b}`` for a comparison. A configuration whose outcomes were recorded in a web
    browser (``cardvision.evaluate.browser``) describes itself with a ``browser`` block, and the
    report says so.
    """
    if measure not in MEASURES:
        raise ValueError(f"unknown measure {measure!r}")
    by_identity = identity_definition(*configurations.values()) if measure != "detector" else {}
    return {
        "kind": RESULT_KIND,
        "version": RESULT_VERSION,
        "measure": measure,
        "package": {"name": "cardvision", "version": __version__},
        **{label: config.describe() for label, config in configurations.items()},
        "inputs": account.to_json(),
        "bootstrap": {"seed": seed, "replicates": replicates, "unit": "recording group",
                      "interval": "2.5th to 97.5th percentile"},
        "definitions": {**DEFINITIONS[measure], **by_identity, **INTERVAL_DEFINITIONS},
        "results": results,
    }


# ----------------------------------------------------------------------------------- Markdown
def percent(value: float | None, digits: int = 2) -> str:
    """A fraction as the report prints it, ``42.86 %``, or ``undefined``."""
    return "undefined" if value is None else f"{100 * value:.{digits}f} %"


def _points(value: float | None) -> str:
    return "undefined" if value is None else f"{100 * value:+.2f} points"


def _interval(found: Mapping[str, Any] | None, formatter=percent) -> str:
    if not found:
        return ""
    if found.get("low") is None:
        return f"; group bootstrap: no interval ({found.get('undefinedReason', 'undefined')})"
    extra = f", {found['undefinedReplicates']} of {found['replicates']} replicates undefined and left out" \
        if found.get("undefinedReplicates") else ""
    warning = caution(found, difference=formatter is _points)
    return (f"; group bootstrap 95 % interval {formatter(found['low'])} to {formatter(found['high'])} "
            f"({found['groups']} groups, {BOOTSTRAP_NOTE}{extra})"
            + (f". **Read as descriptive:** {warning}" if warning else ""))


def format_rate(found: Mapping[str, Any], per_frame: bool = False) -> str:
    """A rate as the report prints it: counts, value, exact bound, bootstrap interval."""
    value = found.get("value")
    formatter = (lambda v: "undefined" if v is None else f"{v:.3f}") if per_frame else percent
    text = f"{found['numerator']} / {found['denominator']} = {formatter(value)}"
    exact = found.get("exact95")
    if exact and exact.get("value") is not None:
        text += f"; exact one-sided 95 % {exact['side']} bound {percent(exact['value'])} ({exact['note']})"
    return text + _interval(found.get("groupBootstrap95"), formatter)


def _browser_lines(browser: Mapping[str, Any] | None) -> list[str]:
    """What a result scored from a browser's outcomes says about where they came from."""
    if not browser:
        return []
    runtime, backend, chosen = browser["runtime"], browser["backend"], browser["frameSelection"]
    asked = "the release's own order" if backend["asked"] == "release" else f"{backend['asked']} only"
    rows = ", ".join(f"{status} {count}" for status, count in browser["rows"].items())
    distances = ", ".join(f"{bits} bit{'' if bits == '1' else 's'} on {count} row{'' if count == 1 else 's'}"
                          for bits, count in browser["fingerprintDistances"].items()) or "none"
    return [
        f"- **the outcomes come from a browser run**: {runtime['name']} {runtime['version']} on ONNX Runtime Web "
        f"{browser['ortWeb']} recorded what was shown at each labeled position, on frames the browser decoded "
        "from video files. This package ran no model and read no frame; it scored the recorded outcomes",
        f"- backend: detector on {backend['detector']}, recognizer on {backend['recognizer']} (asked for: {asked})",
        f"- user agent: `{browser['userAgent']}`",
        f"- frames: for a row with a fingerprint, the frame within {chosen['windowSeconds']:g} s of the row's time "
        f"whose fingerprint is nearest, kept when at most {chosen['maxHamming']} bits away. Rows in the events "
        f"file: {rows}. Fingerprint distance of the kept rows that have one: {distances}",
        "- release id: as the browser recorded it, "
        + ("and equal to the release document's" if browser["releaseChecked"] else "not checked against a release document"),
        "- the settings below are the ones the browser recorded from the release it loaded",
    ]


def configuration_lines(title: str, described: Mapping[str, Any]) -> list[str]:
    """The report's lines about one configuration: its files and hashes, then its settings."""
    lines = [f"### {title}", ""]
    if described.get("release"):
        lines += [f"- release document id: `{described['release']}`", ""]
    lines += ["| Part | File | SHA-256 |", "| --- | --- | --- |"]
    for label, entry in described["files"].items():
        lines.append(f"| {label} | `{entry['file']}` | `{entry['sha256']}` |")
    accept, hover, det = described["accept"], described["hover"], described["detector"]
    lines += ["", *_browser_lines(described.get("browser"))]
    lines += [
        f"- identity: {described['identity']}",
        f"- accept rule: tau {accept['tau']}, delta {accept['delta']}, "
        + ("the turned looks retried" if accept["rotationRetry"] else "the turned looks not tried (upright looks only)"),
        f"- hover selection: {hover['selection']}" + (f" (suppression overlap {hover['nmsIou']})" if "nmsIou" in hover else ""),
        f"- detector: score threshold {det['threshold']}, suppression overlap {det['nmsIou']}, at most "
        f"{det['maxDetections']} detections, smallest crop {det['minCropPx']} px",
        f"- analysis width: {described['analysisWidth']['min']} to {described['analysisWidth']['max']} px",
        "",
    ]
    if described.get("geometric"):
        geometric = described["geometric"]
        lines[-1:] = [f"- geometric stage: `{json.dumps(geometric, separators=(',', ':'))}`"]
        if geometric.get("indexOpencv") != geometric.get("opencv"):
            lines.append(f"- **warning**: the descriptor index was built with OpenCV {geometric.get('indexOpencv')} "
                         f"and the stage ran with OpenCV {geometric.get('opencv')}")
        lines.append("")
    return lines


def _counts(found: Mapping[str, int]) -> str:
    return ", ".join(f"{key} {value}" for key, value in found.items()) if found else "none"


def scenes_opening(scenes: Mapping[str, Any] | None) -> list[str]:
    """The report's first lines when the rows are generated scenes: what they are, and what a
    figure on them does and does not say. Nothing for rows read from manifests."""
    if not scenes:
        return []
    return [f"**These rows are generated scenes, not footage.** `{scenes['generator']}` drew them from card images: "
            f"{scenes['scenes']} scenes, split `{scenes['split']}`, seed {scenes['seed']}. {scenes['note']}", ""]


def _scenes_lines(scenes: Mapping[str, Any]) -> list[str]:
    """How the labels of generated scenes were read as rows (``cardvision.evaluate.scenes``)."""
    boxes = scenes["boxes"]
    return [
        "- rows: one generated scene each. The generator labels every card it draws, so every scene is an "
        "exhaustively boxed frame, and hover events are the centers of its boxes",
        f"- cards: faces {boxes['faces']}, backs {boxes['backs']}. A card that shows less than "
        f"{percent(scenes['visibleMin'], 0)} of itself, or whose short side is under {scenes['shortSideMinPx']:g} px, "
        f"by the generator's own figures, is an ignore region (here: faces {boxes['ignoredFaces']}, backs "
        f"{boxes['ignoredBacks']}). An ignore region gives no hover event and no crop, and a detection on it is "
        "neither a card found nor a false positive",
        "- everything else the generator draws (distractors, dice, hands, broadcast graphics) has no box and is "
        "background",
        "- role evaluated: none. Generated scenes have no role, and all of them are one recording group, so no rate "
        "below has a group bootstrap interval",
    ]


def input_lines(inputs: Mapping[str, Any]) -> list[str]:
    """The report's ``Rows`` section: the manifests, and what became of every row."""
    scenes = inputs.get("scenes")
    lines = ["## Rows", "", "| Labels of the generated scenes | SHA-256 | Scenes |" if scenes else "| Manifest | SHA-256 | Rows |",
             "| --- | --- | --- |"]
    for manifest in inputs["manifests"]:
        lines.append(f"| `{manifest['file']}` | `{manifest['sha256']}` | {manifest['rows']} |")
    lines += [
        "",
        *(_scenes_lines(scenes) if scenes else [f"- role evaluated: `{inputs['role']}`"]),
        f"- rows read: {inputs['rowsRead']}",
        f"- rows used: {inputs['rowsUsed']}",
        f"- rows skipped: {_counts(inputs['rowsSkipped'])}",
        f"- rows unusable (not scored): {_counts(inputs['rowsUnusable'])}",
        f"- frames present: {inputs['framesPresent']}",
        f"- labels left out of used rows: {_counts(inputs['labelsLeftOut'])}",
        f"- labels not scored because their row was unusable: {_counts(inputs['labelsNotScored'])}",
        "",
    ]
    missing = inputs["rowsNotScored"]
    if missing:
        lines += ["Rows not scored. They are in no numerator and no denominator below:", ""]
        lines += [f"- {row['platform']} {row['video_id']} t={row['t']} ({row['source_type']}, group {row['group']}): "
                  f"{row['reason']}{' (' + row['detail'] + ')' if row.get('detail') else ''}; "
                  f"would have given {_counts(row['lost'])}" for row in missing[:LISTED_ROWS]]
        if len(missing) > LISTED_ROWS:
            lines.append(f"- and {len(missing) - LISTED_ROWS} more, listed in the JSON result")
        lines.append("")
    return lines


def titled_slices(results: Mapping[str, Any]) -> list[tuple[str, Any]]:
    """The slices of a result, each with its heading: overall, by source type, by source family."""
    out = [("Overall", results["overall"])]
    out += [(f"Source type `{name}`", part) for name, part in results["bySourceType"].items()]
    out += [(f"Source family `{name}`", part) for name, part in results["bySourceFamily"].items()]
    return out


def hover_slice(part: Mapping[str, Any]) -> list[str]:
    """The report's lines for the hover figures of one slice: the counts and the two rates."""
    c = part["counts"]
    return [
        f"- events: {part['events']} in {part['groups']} recording groups",
        f"- readable faces: right {c['faceRight']}, wrong {c['faceWrong']}, nothing {c['faceNothing']}",
        f"- backs: name shown {c['backShown']}, nothing {c['backNothing']}",
        f"- off-card positions: name shown, not adjacent {c['offCardShownNonAdjacent']}; name shown, adjacent "
        f"{c['offCardShownAdjacent']}; nothing {c['offCardNothing']}",
        f"- outside every rate: faces labeled unreadable {c['faceUnreadableShown'] + c['faceUnreadableNothing']} "
        f"(name shown on {c['faceUnreadableShown']}), faces nobody named "
        f"{c['faceUnnamedShown'] + c['faceUnnamedNothing']} (name shown on {c['faceUnnamedShown']}), unreadable "
        f"points {c['unreadableShown'] + c['unreadableNothing']} (name shown on {c['unreadableShown']})",
        f"- **named right**: {format_rate(part['namedRight'])}",
        f"- **wrong of shown**: {format_rate(part['wrongOfShown'])}",
    ]


def _crops_slice(part: Mapping[str, Any]) -> list[str]:
    lines = [f"- crops: {part['crops']} in {part['groups']} recording groups"]
    for key, label in (("top1Right", "top-1 right"), ("namedRight", "named right"), ("namedWrong", "named wrong"),
                       ("rejected", "rejected"), ("wrongOfNamed", "wrong of named")):
        lines.append(f"- **{label}**: {format_rate(part[key])}")
    looks = part.get("byLook")
    if looks:
        names = {"0": "upright", "1": "one quarter turn", "2": "two", "3": "three", "tilted": "tilted retry"}
        lines.append("- named by look (right / wrong): " + "; ".join(
            f"{names.get(key, key)} {counts['namedRight']} / {counts['namedWrong']}" for key, counts in looks.items()))
    return lines


def _detector_slice(part: Mapping[str, Any]) -> list[str]:
    lines = [f"- frames: {part['frames']}; face targets {part['faceTargets']}, back targets {part['backTargets']}, "
             f"ignore regions {part['ignoreRegions']}, not-card boxes {part['notCardBoxes']}"]
    set_aside = part.get("facesIgnoredForProportions", 0)
    if set_aside:
        # Said only when there are some, so that these faces are not looked for among the targets.
        lines.append(f"  - of the ignore regions, {set_aside} are faces set aside because their outline does not have a "
                     "whole card's proportions; `evaluate crops` and `evaluate hover` count them as faces")
    for name, point in part["points"].items():
        if point["threshold"] is None:
            lines.append(f"- at `{name}`: {point['note']}")
            continue
        # A cap's threshold is found on all frames together, so the cap holds for all of them
        # taken together and not for each source: say so where one source's figures are shown.
        pooled = ("" if name == detector_module.OPERATING_POINT
                  else "; found on all sources together, so one source alone can be above the cap")
        lines += [
            f"- at `{name}` (score threshold {point['threshold']:.6g}{pooled}):",
            f"  - **recall**: {format_rate(point['recall'])}",
            f"  - recall at 0.3: {format_rate(point['recallLoose'])}",
            f"  - false positives per frame: {format_rate(point['falsePositivesPerFrame'], per_frame=True)}",
            f"  - of those, on backs: {point['falsePositivesOnBacks']}; neutral detections (in ignore regions, "
            f"not counted): {point['neutralDetections']}",
            f"  - back recall: {format_rate(point['backRecall'])}",
        ]
    for cls in ("face", "back"):
        found = part["ap50"][cls]
        value = "undefined (no target)" if found["ap"] is None else f"{found['ap']:.4f}"
        lines.append(f"- **AP@0.5, {cls}**: {value} ({found['targets']} targets, {found['detections']} detections: "
                     f"{found['truePositives']} true positives, {found['falsePositives']} false positives, "
                     f"{found['leftOut']} left out)")
    return lines


def _card(event: Mapping[str, Any], key: str, none: str) -> str:
    """A card of a regressing event: its name, with its id where the event carries one (a
    catalog in which different cards share a name), or ``none`` when there is no card."""
    name, card_id = event[key], event.get(f"{key}Id")
    if not name:
        return none
    return f"{name} {card_id}" if card_id else name


def _compare_slice(part: Mapping[str, Any]) -> list[str]:
    moves, paired = part["transitions"], part["paired"]
    lines = [f"- events compared: {moves['events']}", "", "| Transition (base -> candidate) | Events |", "| --- | --- |"]
    lines += [f"| {name} | {count} |" for name, count in moves["table"].items()]
    lines += ["", f"- **regressions**: {moves['regressions']}"]
    lines += [f"  - `{event['key']}` ({event['role']}, labeled {_card(event, 'truth', 'no card')}): {event['transition']}; "
              f"base showed {_card(event, 'baseShown', 'nothing')}, candidate showed {_card(event, 'candidateShown', 'nothing')}"
              for event in moves["regressingEvents"][:LISTED_ROWS]]
    if len(moves["regressingEvents"]) > LISTED_ROWS:
        lines.append(f"  - and {len(moves['regressingEvents']) - LISTED_ROWS} more, listed in the JSON result")
    for key, label in (("namedRight", "named right"), ("wrongOfShown", "wrong of shown")):
        found = paired[key]
        lines.append(f"- **{label}, candidate minus base**: {_points(found['difference'])} (base "
                     f"{percent(found['base'])}, candidate {percent(found['candidate'])})"
                     + _interval(found["groupBootstrap95"], _points))
    for label in ("base", "candidate"):
        lines += [f"- {label}, named right: {format_rate(part[label]['namedRight'])}",
                  f"- {label}, wrong of shown: {format_rate(part[label]['wrongOfShown'])}"]
    return lines


_TITLES = {"hover": "hover events", "crops": "the recognizer on labeled crops", "detector": "the detector",
           "compare": "two configurations on the same hover events"}
_SLICE_LINES = {"hover": hover_slice, "crops": _crops_slice, "detector": _detector_slice, "compare": _compare_slice}


def to_markdown(result: Mapping[str, Any]) -> str:
    """The Markdown report of a result document."""
    measure = result["measure"]
    lines = [f"# Evaluation: {_TITLES[measure]}", "",
             f"cardvision {result['package']['version']}; result format {result['version']}.", "",
             *scenes_opening(result["inputs"].get("scenes")),
             "## What was scored", ""]
    for label, title in (("configuration", "Configuration"), ("base", "Base configuration"),
                         ("candidate", "Candidate configuration")):
        if label in result:
            lines += configuration_lines(title, result[label])
    lines += input_lines(result["inputs"])
    boot = result["bootstrap"]
    lines += ["## Definitions", ""]
    lines += [f"- {text}" for text in result["definitions"].values()]
    lines += [f"- bootstrap: {boot['replicates']} replicates, seed {boot['seed']}", ""]
    lines += ["## Results", ""]
    results = result["results"]
    if measure == "detector":
        lines += ["Detections were read with no minimum score: every box the detector's decode keeps. Score "
                  "thresholds, chosen on all frames: "
                  + ", ".join(f"`{name}` {'none' if value is None else format(value, '.6g')}"
                              for name, value in results["thresholds"].items()) + ".", "",
                  f"Overlap measures: recall and false positives on {results['overlap']['recall']} (the "
                  "detection's box against the upright box around the target's outline); AP@0.5 on the "
                  f"{results['overlap']['ap50']} (the detection's box against the outline itself).", ""]
    for title, part in titled_slices(results):
        lines += [f"### {title}", "", *_SLICE_LINES[measure](part), ""]
    return "\n".join(lines).rstrip() + "\n"


def write_result(
    out: str | Path, result: Mapping[str, Any], extra: Mapping[str, Sequence[Mapping[str, Any]]] | None = None
) -> list[Path]:
    """Write ``evaluate-<measure>.json`` and ``.md`` into a folder, plus one JSON-lines file per
    entry of ``extra`` (name to rows). Returns the paths written."""
    folder = Path(out)
    folder.mkdir(parents=True, exist_ok=True)
    stem = f"evaluate-{result['measure']}"
    written = [folder / f"{stem}.json", folder / f"{stem}.md"]
    written[0].write_text(json.dumps(result, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    written[1].write_text(to_markdown(result), encoding="utf-8")
    for name, rows in (extra or {}).items():
        path = folder / f"{stem}-{name}.jsonl"
        path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
        written.append(path)
    return written
