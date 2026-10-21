# SPDX-License-Identifier: Apache-2.0
"""The report page of ``cardvision try``: one hand-written HTML file with no script, no style
sheet from elsewhere and no image from elsewhere. Every link and picture is relative to the
page's folder. Every piece of text that comes from your files (card names, ids, file names,
paths, the commands' messages) is escaped."""

from __future__ import annotations

import datetime
import json
import os
import re
import statistics
from dataclasses import dataclass, field
from html import escape
from pathlib import Path
from typing import Any
from urllib.parse import quote

# A run is "found, few named" when fewer than this share of the faces found were named.
NAMED_SHARE = 0.5

STYLE = """
body { font-family: system-ui, sans-serif; max-width: 72rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.45; }
code, pre { font-family: ui-monospace, monospace; background: #f3f3f3; }
pre { padding: .6rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: .25rem .6rem; text-align: left; }
.verdict { font-size: 1.2rem; padding: .8rem; border-left: .4rem solid #888; background: #fafafa; }
.warning { padding: .8rem; border-left: .4rem solid #b45309; background: #fffbeb; }
.strip { display: flex; flex-wrap: wrap; gap: .5rem; } .strip img { height: 8rem; border: 1px solid #ccc; }
.sheet img { max-width: 100%; border: 1px solid #ccc; margin-bottom: 1rem; }
"""


@dataclass
class Verdict:
    """What the run found, in one of three outcomes: ``named``, ``few`` or ``none``."""
    kind: str
    sentence: str
    frames: int
    frames_with_faces: int
    faces: int
    backs: int
    named: int
    distinct: int
    faces_per_frame: list[int]
    backs_per_frame: list[int]


@dataclass
class NoImage:
    """The catalog's cards with no bank row, in catalog order. ``none``: no card of their identity
    has an image, so they can never be named. ``own``: another printing has one, so they are named
    only where they look like it (an alternate art usually does not)."""
    none: list[tuple[str, str]] = field(default_factory=list)
    own: list[tuple[str, str]] = field(default_factory=list)
    total: int = 0


@dataclass
class Facts:
    """Everything the page shows."""
    out: Path        # where the files are as the page is written
    final: Path      # where they end up: the folder the page's links into the docs start from
    cards: Path
    images: Path
    video: Path
    weights: Path
    sampling_note: str
    verdict: Verdict
    infer_lines: list[str]
    import_report: dict[str, Any] | None
    from_catalog: bool
    demo_line: str
    codec_hint: str | None
    no_image: NoImage = field(default_factory=lambda: NoImage())


def read_results(path: Path) -> list[dict[str, Any]]:
    """The frames ``infer`` printed, one JSON object a line."""
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def cards_without_image(catalog: Path, bank: Path) -> NoImage:
    from cardvision.core.catalog import load_catalog

    loaded = load_catalog(catalog)
    rows = {row["cardId"] for row in json.loads(bank.read_text(encoding="utf-8"))["entries"]}
    known = {loaded.identity_of(card.id) for card in loaded.cards if card.id in rows}
    found = NoImage(total=len(loaded.cards))
    for card in loaded.cards:
        if card.id not in rows:
            (found.own if loaded.identity_of(card.id) in known else found.none).append((card.id, card.name))
    return found


def _examples(cards: list[tuple[str, str]], shown: int) -> str:
    listed = ", ".join(f"{card_id} ({name})" if name else card_id for card_id, name in cards[:shown])
    return listed + (f" and {len(cards) - shown} more" if len(cards) > shown else "")


def no_image_sentence(found: NoImage, where: str = "the report lists them all", shown: int = 5) -> str | None:
    """What a run says when cards have no image: how many, a few of them, where the rest are,
    what to do."""
    none, own = found.none, found.own
    if not none and not own:
        return None
    said = []
    if none:
        one = len(none) == 1
        said.append(f"{len(none)} of the {found.total} cards in your list can't be named, since "
                    f"{'it has' if one else 'they have'} no image: {_examples(none, shown)}.")
    if own:
        one = len(own) == 1
        said.append(f"{len(own)} {'more' if none else f'of the {found.total} cards in your list'} "
                    f"{'has' if one else 'have'} no image of {'its' if one else 'their'} own: "
                    f"{_examples(own, shown)}; {'it is' if one else 'they are'} named only where "
                    f"{'it looks' if one else 'they look'} like another printing that has one.")
    many = len(none) + len(own) > 1
    return (f"No image: {' '.join(said)} Add {'their images' if many else 'its image'}, or fix the image column, "
            f"then run cardvision try again with --overwrite ({where}).")


def _no_image_warning(facts: Facts) -> str:
    said = no_image_sentence(facts.no_image, where="listed under The card list below")
    return f'<p class="warning">{escape(said)}</p>' if said else ""


def _no_image_list(facts: Facts) -> str:
    def items(cards: list[tuple[str, str]]) -> str:
        return "<ul>" + "".join(f"<li><code>{escape(card_id)}</code> {escape(name)}</li>"
                                for card_id, name in cards) + "</ul>"

    why = (f'The reasons are in <a href="{_href(facts.out / "import-report.txt", facts.out)}"><code>'
           f'import-report.txt</code></a> and <a href="{_href(facts.out / "try.log", facts.out)}"><code>try.log'
           "</code></a>.")
    parts = []
    if facts.no_image.none:
        parts.append("<h3>Cards that can't be named: no image</h3><p>Neither these cards nor another printing of "
                     f"them has an image, so the model has nothing to match them to. {why}</p>"
                     + items(facts.no_image.none))
    if facts.no_image.own:
        parts.append("<h3>Cards with no image of their own</h3><p>Another printing of each has an image, so they "
                     "are named only where they look like it; an alternate art usually does not. "
                     f"{why}</p>" + items(facts.no_image.own))
    return "".join(parts)


def _is_face(box: dict[str, Any]) -> bool:
    return "outcome" in box      # a face carries the recognizer's fields; a back does not


def verdict(rows: list[dict[str, Any]]) -> Verdict:
    """The outcome of a run, from the frames ``infer`` printed."""
    faces_per_frame = [sum(1 for box in row["boxes"] if _is_face(box)) for row in rows]
    backs_per_frame = [sum(1 for box in row["boxes"] if box.get("class") == "back") for row in rows]
    accepted = [box for row in rows for box in row["boxes"] if _is_face(box) and box.get("accepted")]
    frames, faces, named = len(rows), sum(faces_per_frame), len(accepted)
    with_faces = sum(1 for count in faces_per_frame if count)
    distinct = len({box.get("cardId") for box in accepted})
    if faces == 0:
        kind = "none"
        sentence = (f"No cards found: the detector found no card face in {frames} frame(s). Try a clearer, larger "
                    "view first; the report says more.")
    elif named < NAMED_SHARE * faces:
        kind = "few"
        sentence = (f"Found, few named: cards found in {with_faces} of {frames} frame(s); names show on {named} of "
                    f"{faces} face(s) ({distinct} distinct card(s)), but many cards stay unnamed. To name more, the "
                    "next step is training (docs/train.md); the demo line shows what is named now.")
    else:
        kind = "named"
        sentence = (f"Found and named: cards found in {with_faces} of {frames} frame(s), {named} of {faces} face(s) "
                    f"named, {distinct} distinct card(s). Next: open the demo with the last line.")
    return Verdict(kind, sentence, frames, with_faces, faces, sum(backs_per_frame), named, distinct,
                   faces_per_frame, backs_per_frame)


def _spread(counts: list[int]) -> str:
    return f"{min(counts)} / {statistics.median(counts):g} / {max(counts)}" if counts else "none"


def _href(path: Path, base: Path) -> str:
    return escape(quote(path.relative_to(base).as_posix()), quote=True)


def _doc_link(name: str, base: Path) -> str:
    """A relative link to a page of the repository's docs, or its name when there is no checkout."""
    from cardvision.try_game.run import repository_root

    root = repository_root()
    page = root / "docs" / name if root is not None else None
    if page is None or not page.is_file():
        return f"<code>docs/{escape(name)}</code>"
    try:
        relative = os.path.relpath(page, base)
    except ValueError:       # another drive, on Windows
        return f"<code>docs/{escape(name)}</code>"
    return f'<a href="{escape(quote(Path(relative).as_posix()), quote=True)}"><code>docs/{escape(name)}</code></a>'


def _sheet_pages(folder: Path) -> list[Path]:
    def number(path: Path) -> int:
        found = re.fullmatch(r"sheet-(\d+)\.png", path.name)
        return int(found.group(1)) if found else 0

    return sorted((p for p in folder.glob("sheet*.png") if re.fullmatch(r"sheet(-\d+)?\.png", p.name)), key=number)


def _diagnosis(lines: list[str]) -> list[str]:
    """``infer``'s lines about frames with no box, as it printed them."""
    start = next((i for i, line in enumerate(lines) if "no box in " in line), None)
    if start is None:
        return []
    kept = []
    for line in lines[start:]:
        if re.search(r"\d+ frame\(s\), \d+ face\(s\)", line):
            break
        kept.append(line)
    return kept


def _list(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{item}</li>" for item in items) + "</ul>"


def _import_notes(facts: Facts) -> str:
    out = facts.out
    report_link = f'<a href="{_href(out / "import-report.txt", out)}"><code>import-report.txt</code></a>'
    if facts.from_catalog or facts.import_report is None:
        return (f"<p>{escape(str(facts.cards))} is a catalog already and was used as it is. The check of its images "
                f"is in {report_link}.</p>")
    data = facts.import_report
    items = []
    columns = data.get("columns") or {}
    if columns:
        items.append("Columns taken: " + ", ".join(f"<code>{escape(k)}</code> from <code>{escape(str(v))}</code>"
                                                   for k, v in columns.items()))
    for name, others in (data.get("alsoMatched") or {}).items():
        items.append(f"For <code>{escape(name)}</code>, also matched: "
                     + ", ".join(f"<code>{escape(str(o))}</code>" for o in others)
                     + f"; choose another with <code>--map {escape(name)}=HEADER</code>")
    identity = data.get("identity") or {}
    if identity:
        given = "as given" if identity.get("given") else "suggested; --identity to choose"
        items.append(f"Identity rule: <code>{escape(str(identity.get('rule')))}</code> ({escape(given)}). "
                     f"{escape(str(identity.get('reason') or ''))}")
    same = data.get("sameName") or []
    if same:
        listed = "".join(f"<li>{escape(str(group.get('name')))}: {escape(', '.join(map(str, group.get('ids', []))))}</li>"
                         for group in same[:20])
        more = f"<li>and {len(same) - 20} more</li>" if len(same) > 20 else ""
        items.append(f"One name under several ids ({len(same)}):<ul>{listed}{more}</ul>")
    without = data.get("withoutArt") or []
    if without:
        listed = "".join(f"<li>{escape(str(entry.get('id')))}: {escape(str(entry.get('reason')))}</li>"
                         for entry in without[:20])
        more = f"<li>and {len(without) - 20} more</li>" if len(without) > 20 else ""
        items.append(f"Cards without art ({len(without)}), so not in the bank:<ul>{listed}{more}</ul>")
    else:
        items.append("Cards without art: none.")
    for note in data.get("notes") or []:
        items.append(escape(str(note)))
    return _list(items) + f"<p>The importer's full report: {report_link}.</p>"


def _accept_rule(out: Path, final: Path) -> str:
    try:
        rule = json.loads((out / "release" / "accept.json").read_text(encoding="utf-8"))
        tau, delta = float(rule["tau"]), float(rule["delta"])
    except (OSError, ValueError, KeyError, TypeError):
        return "<p>The accept rule could not be read from <code>release/accept.json</code>.</p>"
    return (f"<p>A match is named when its similarity is at least <code>tau</code> {tau:g} and at least "
            f"<code>delta</code> {delta:g} ahead of the runner-up. These values were calibrated for the released "
            f"game, not for yours: treat the names as provisional until you measure ({_doc_link('measure.md', final)}).</p>")


def _hint(facts: Facts) -> str:
    if not facts.codec_hint:
        return ""
    return (f"<p>{escape(facts.codec_hint[0].upper() + facts.codec_hint[1:])} (install ffmpeg with "
            "<code>brew install ffmpeg</code>, <code>sudo apt install ffmpeg</code> or "
            "<code>winget install ffmpeg</code>).</p>")


def write_report(path: Path, facts: Facts) -> None:
    out, found = facts.out, facts.verdict
    when = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    parts = [
        "<!DOCTYPE html>",
        '<html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>cardvision try: {escape(facts.cards.name)}</title>",
        f"<style>{STYLE}</style></head><body>",
        f"<h1>cardvision try: {escape(facts.cards.name)}</h1>",
        f"<p>{escape(when)}. Video: <code>{escape(str(facts.video))}</code> ({escape(facts.sampling_note)}). "
        f"Card images: <code>{escape(str(facts.images))}</code>. Weights: <code>{escape(str(facts.weights))}</code>.</p>",
        f'<p class="verdict">{escape(found.sentence)}</p>',
        _no_image_warning(facts),
        _hint(facts),
    ]
    if found.kind == "named":
        parts += [
            "<h2>Next: see it in the demo page</h2>",
            "<p>From the repository's root, with Node 22 or later, paste this line"
            + (" (it installs the page's packages first, with <code>npm ci</code>)" if "npm ci" in facts.demo_line
               else "") + ". Open the address it prints, and rest the pointer on a card. It runs until you press "
            "Control-C in that terminal: use a new terminal for anything else.</p>",
            f"<pre>{escape(facts.demo_line)}</pre>",
            f"<p>Then make it a browser extension your viewers install: {_doc_link('extension.md', facts.final)}.</p>",
        ]
    elif found.kind == "few":
        parts += [
            "<h2>Next: train the recognizer to name more</h2>",
            "<p>Names do show, but many of your cards stay unnamed: the recognizer, trained on another game, does "
            "not tell most of yours apart. Look at the contact sheet below: is the right card among the three best "
            "matches? To name more, the next step is training, with a GPU and some labeled frames: "
            f"{_doc_link('train.md', facts.final)}.</p>",
            "<p>The demo page shows what is named now. From the repository's root, with Node 22 or later, paste "
            "this line"
            + (" (it installs the page's packages first, with <code>npm ci</code>)" if "npm ci" in facts.demo_line
               else "") + ". It runs until you press Control-C in that terminal.</p>",
            f"<pre>{escape(facts.demo_line)}</pre>",
        ]
    else:
        lines = _diagnosis(facts.infer_lines)
        parts += [
            "<h2>Next: a clearer view, then training</h2>",
            "<p>The released detector does not see the cards in this video. What it printed:</p>",
            f"<pre>{escape(chr(10).join(lines))}</pre>" if lines else "<p>(it found only card backs)</p>",
            "<p>Try a clearer, larger, more top-down view of the same cards first. If that does not help, the next "
            f"step is training the detector for your game: {_doc_link('train.md', facts.final)}.</p>",
        ]
    parts += [
        "<h2>Summary</h2>",
        "<table>",
        f"<tr><th>Frames analyzed</th><td>{found.frames}</td></tr>",
        f"<tr><th>Frames with a card face</th><td>{found.frames_with_faces}</td></tr>",
        f"<tr><th>Faces found</th><td>{found.faces}</td></tr>",
        f"<tr><th>Faces per frame, fewest / median / most</th><td>{_spread(found.faces_per_frame)}</td></tr>",
        f"<tr><th>Backs found</th><td>{found.backs}</td></tr>",
        f"<tr><th>Faces named</th><td>{found.named}</td></tr>",
        f"<tr><th>Distinct cards named</th><td>{found.distinct}</td></tr>",
        "</table>",
        f'<p>Every frame\'s boxes: <a href="{_href(out / "out" / "results.jsonl", out)}"><code>out/results.jsonl</code></a> '
        f"({_doc_link('how-it-works.md', facts.final)} names the fields). Every command this run ran, and what it printed: "
        f'<a href="{_href(out / "try.log", out)}"><code>try.log</code></a>.</p>',
    ]
    sheets = _sheet_pages(out / "out")
    if sheets and found.faces:
        parts.append("<h2>Contact sheet</h2><p>Each crop beside its three best matches.</p><div class=\"sheet\">")
        parts += [f'<a href="{_href(p, out)}"><img src="{_href(p, out)}" alt="{escape(p.name, quote=True)}"></a>'
                  for p in sheets]
        parts.append("</div>")
    frames = sorted((out / "out" / "annotated").glob("*.jpg"))
    if frames:
        parts.append("<h2>Annotated frames</h2><p>The boxes and names drawn on each analyzed frame.</p>"
                     '<div class="strip">')
        parts += [f'<a href="{_href(p, out)}"><img src="{_href(p, out)}" alt="{escape(p.name, quote=True)}" '
                  'loading="lazy"></a>' for p in frames]
        parts.append("</div>")
    parts += ["<h2>The card list</h2>", _import_notes(facts), _no_image_list(facts), "<h2>The accept rule</h2>", _accept_rule(out, facts.final),
              "</body></html>", ""]
    path.write_text("\n".join(part for part in parts if part), encoding="utf-8")
