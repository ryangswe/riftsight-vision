# SPDX-License-Identifier: Apache-2.0
"""Event-by-event comparison of two ``cardvision evaluate hover --out`` runs on the same data.

::

    cardvision refresh diff BASE_DIR CANDIDATE_DIR [--exclude-truth-prefix P ...]
        [--exclude-truth-ids IDS.json] [--json OUT.json]

The base is the live release, the candidate the release with the new cards. Each folder holds
``evaluate-hover-events.jsonl`` (one line per scored event: ``key``, ``role``, ``outcome``,
``truth_id``, ``shown_id``) and ``evaluate-hover.json`` (for the release id). This module only
counts; the rule (``cardvision.refresh.verdict``) says what passes. The document it returns:

``compared``
    events present in both runs, matched by key.
``onlyBase`` / ``onlyCandidate``
    keys present in one run only (a replay is invalid unless both are 0).
``excluded``
    events left out because their labeled card is one of the added cards, by id prefix
    (``--exclude-truth-prefix``) or by a JSON list of ids (``--exclude-truth-ids``). For
    rehearsals only, where the "new" cards are cards the base had and the candidate adds back.
``transitions``
    counts of ``"<before> -> <after>"`` over the reduced outcomes.
``regressions``
    the events a rule counts against the candidate, by type, with their keys:
    ``right_to_wrong`` and ``right_to_nothing`` (a face named right before),
    ``nothing_to_wrong`` (a face that showed nothing now shows a wrong name),
    ``new_wrong_nonface`` (a back or off-card position that showed nothing now shows a name;
    adjacent off-card names excluded), and ``different_wrong`` (wrong before and after with
    another name: reported, not counted).
``improvements``
    ``wrong_to_right``, ``nothing_to_right``, ``wrong_to_nothing``, ``nonface_wrong_to_nothing``.
``rates``
    named right and wrong of shown, base and candidate, over the compared events.

The reduced outcome: a face is right, wrong or nothing; a back or off-card position is
``shown`` (a name was shown) or ``nothing``; ``adjacent`` counts as nothing, as cardvision's
compare does; unreadable and unnamed faces are outside every count, as in the rates.
"""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

FACE = "face"
NONFACE = ("back", "off-card")
EVENTS = "evaluate-hover-events.jsonl"
RESULT = "evaluate-hover.json"
REGRESSION_TYPES = ("right_to_wrong", "right_to_nothing", "nothing_to_wrong", "new_wrong_nonface", "different_wrong")


def load_run(folder: str | Path) -> tuple[dict[str, dict[str, Any]], str | None]:
    """The events of a run by key, and the release id it records (``None`` without one)."""
    folder = Path(folder)
    rows = {}
    for line in (folder / EVENTS).read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            rows[row["key"]] = row
    meta = json.loads((folder / RESULT).read_text(encoding="utf-8"))
    configuration = meta.get("configuration") or {}
    return rows, configuration.get("release") or configuration.get("releaseId")


def reduced(row: Mapping[str, Any]) -> str | None:
    """``right``/``wrong``/``nothing`` for a face, ``shown``/``nothing`` for a back or an
    off-card position, ``None`` for an event outside every count."""
    role, outcome = row["role"], row["outcome"]
    if role == FACE:
        return {"right": "right", "wrong": "wrong"}.get(outcome, "nothing")
    if role in NONFACE:
        if outcome == "adjacent":
            return "nothing"
        return "nothing" if outcome == "nothing" else "shown"
    return None


def rates(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Counts, named right and wrong of shown over some events."""
    count: Counter[tuple[bool, str]] = Counter()
    for row in rows:
        outcome = reduced(row)
        if outcome is None:
            continue
        count[(row["role"] == FACE, outcome)] += 1
    right, wrong, nothing = count[(True, "right")], count[(True, "wrong")], count[(True, "nothing")]
    nonface_shown = count[(False, "shown")]
    faces = right + wrong + nothing
    shown_bad = wrong + nonface_shown
    return {"faces": faces, "right": right, "wrong": wrong, "nothing": nothing, "nonfaceShown": nonface_shown,
            "namedRight": round(right / faces, 6) if faces else None,
            "wrongOfShown": round(shown_bad / (right + shown_bad), 6) if right + shown_bad else None}


def diff_runs(base: str | Path, candidate: str | Path, *, exclude_prefixes: Iterable[str] = (),
              exclude_ids: Iterable[str] = ()) -> dict[str, Any]:
    """The comparison document of two run folders (see the module's description)."""
    base_rows, base_id = load_run(base)
    cand_rows, cand_id = load_run(candidate)
    prefixes, ids = list(exclude_prefixes), set(exclude_ids)
    keys = sorted(set(base_rows) & set(cand_rows))
    excluded = [k for k in keys if str(base_rows[k].get("truth_id") or "") in ids
                or any(str(base_rows[k].get("truth_id") or "").startswith(p) for p in prefixes)]
    left_out = set(excluded)
    keys = [k for k in keys if k not in left_out]
    transitions: Counter[str] = Counter()
    regressions: dict[str, list[dict[str, Any]]] = {name: [] for name in REGRESSION_TYPES}
    improvements: Counter[str] = Counter()
    for key in keys:
        b, c = base_rows[key], cand_rows[key]
        before, after = reduced(b), reduced(c)
        if before is None or after is None:
            continue
        face = b["role"] == FACE
        transitions[f"{'' if face else 'nonface '}{before} -> {after}"] += 1
        item = {"key": key, "truth": b.get("truth_id"), "base": b.get("shown_id"), "cand": c.get("shown_id")}
        if face:
            if before == "right" and after == "wrong":
                regressions["right_to_wrong"].append(item)
            elif before == "right" and after == "nothing":
                regressions["right_to_nothing"].append(item)
            elif before == "nothing" and after == "wrong":
                regressions["nothing_to_wrong"].append(item)
            elif before == "wrong" and after == "wrong" and b.get("shown_id") != c.get("shown_id"):
                regressions["different_wrong"].append(item)
            elif before == "wrong" and after == "right":
                improvements["wrong_to_right"] += 1
            elif before == "nothing" and after == "right":
                improvements["nothing_to_right"] += 1
            elif before == "wrong" and after == "nothing":
                improvements["wrong_to_nothing"] += 1
        else:
            if before == "nothing" and after == "shown":
                regressions["new_wrong_nonface"].append(item)
            elif before == "shown" and after == "nothing":
                improvements["nonface_wrong_to_nothing"] += 1
    counted = sum(len(found) for name, found in regressions.items() if name != "different_wrong")
    return {
        "base": {"dir": str(base), "release": base_id}, "candidate": {"dir": str(candidate), "release": cand_id},
        "eventsBase": len(base_rows), "eventsCandidate": len(cand_rows),
        "onlyBase": len(set(base_rows) - set(cand_rows)), "onlyCandidate": len(set(cand_rows) - set(base_rows)),
        "excluded": len(excluded), "compared": len(keys),
        "regressionCount": counted,
        "regressionsByType": {name: len(found) for name, found in regressions.items()},
        "improvements": dict(improvements),
        "transitions": dict(sorted(transitions.items())),
        "rates": {"base": rates([base_rows[k] for k in keys]), "candidate": rates([cand_rows[k] for k in keys])},
        "regressions": regressions,
    }


def summary(document: Mapping[str, Any]) -> dict[str, Any]:
    """The part of a comparison printed to standard output."""
    out = {k: document[k] for k in ("compared", "onlyBase", "onlyCandidate", "excluded", "regressionCount",
                                    "regressionsByType", "improvements")}
    out["rates"] = document["rates"]
    return out
