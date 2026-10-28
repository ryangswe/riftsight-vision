# SPDX-License-Identifier: Apache-2.0
"""A catalog holding only some cards, for generating new-card scenes from their art.

::

    cardvision refresh subset CATALOG OUT --new-vs BASE_CATALOG   # the entries CATALOG adds to BASE_CATALOG
    cardvision refresh subset CATALOG OUT --ids IDS.json          # a JSON list of ids (e.g. a reference set)

``cardvision make-composites`` draws every card of the catalog it is given; gate N wants scenes
made of the new cards only. The scored release keeps its full catalog and bank: this file only
chooses which images the scenes are made of. Entries without art are left out (they cannot be
drawn). A chosen printing whose root is not chosen brings the root along with ``art`` null,
since a catalog's ``printingOf`` must name one of its own cards.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path



class SubsetError(ValueError):
    """A listed id is not in the catalog."""


def subset_catalog(catalog: str | Path, out: str | Path, *, new_vs: str | Path | None = None,
                   ids: Iterable[str] | None = None) -> tuple[int, int]:
    """Write the subset to ``out``; return ``(cards with art, roots without art)``.

    Exactly one of ``new_vs`` (the base catalog: keep the entries it lacks) and ``ids`` (keep
    these ids; every one must be in the catalog) is given.
    """
    if (new_vs is None) == (ids is None):
        raise ValueError("give exactly one of new_vs and ids")
    with open(catalog, encoding="utf-8") as handle:
        doc = json.load(handle)
    if new_vs is not None:
        with open(new_vs, encoding="utf-8") as handle:
            old = {c["id"] for c in json.load(handle)["cards"]}
        keep = [c for c in doc["cards"] if c["id"] not in old]
    else:
        want = set(ids)
        keep = [c for c in doc["cards"] if c["id"] in want]
        missing = want - {c["id"] for c in keep}
        if missing:
            raise SubsetError(f"{len(missing)} id(s) not in the catalog, e.g. {sorted(missing)[:5]}")
    keep = [c for c in keep if c.get("art")]
    by_id = {c["id"]: c for c in doc["cards"]}
    chosen = {c["id"] for c in keep}
    stubs = []
    for card in keep:
        root = card.get("printingOf")
        if root and root not in chosen:
            chosen.add(root)
            stubs.append(dict(by_id[root], art=None))
    written = dict(doc)
    written["cards"] = keep + stubs
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(written, handle, ensure_ascii=False, indent=1)
    return len(keep), len(stubs)
