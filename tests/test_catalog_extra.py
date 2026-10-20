# SPDX-License-Identifier: Apache-2.0
"""A card's optional ``extra`` object: the game's own data, kept with the card and read by
nothing. The three readers agree on it: this package (``cardvision.core.catalog``), the browser
runtime (``browser/test/extra.test.ts``) and the labeling tool (``labeler/labelcore.py`` refuses
a bad catalog at start). The cases are the ``extra`` section of the browser's contract file,
written by ``tests/test_browser_fixtures.py``."""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

from cardvision.core import catalog as C

ROOT = Path(__file__).resolve().parents[1]
LABELER = ROOT / "labeler"
FIXTURE = json.loads((ROOT / "browser" / "test" / "fixtures" / "contract.json").read_text(encoding="utf-8"))["extra"]


def _labelcore():
    sys.path.insert(0, str(LABELER))
    try:
        return __import__("labelcore")
    finally:
        sys.path.remove(str(LABELER))


def test_a_cards_extra_is_kept_as_the_file_gives_it():
    catalog = C.parse_catalog(FIXTURE["accepted"][0]["doc"])
    assert catalog.card("GEN-001").extra == {"text": "Draw a card.", "rarity": "common",
                                             "upstream": {"id": 1001, "tags": ["a", "b"]}}
    assert catalog.card("GEN-002").extra == {}
    assert catalog.card("GEN-003").extra == {}, "a card without extra has an empty one"
    assert len({catalog.card("GEN-001"), catalog.card("GEN-002")}) == 2, "a card stays hashable"


def test_the_extra_is_a_copy_and_validation_does_not_change_the_document():
    doc = copy.deepcopy(FIXTURE["accepted"][0]["doc"])
    catalog = C.parse_catalog(doc)
    assert doc == FIXTURE["accepted"][0]["doc"]
    doc["cards"][0]["extra"]["upstream"]["tags"].append("c")
    assert catalog.card("GEN-001").extra["upstream"]["tags"] == ["a", "b"]


def test_extra_changes_no_identity():
    doc = copy.deepcopy(FIXTURE["accepted"][0]["doc"])
    plain = {**doc, "cards": [{key: value for key, value in card.items() if key != "extra"} for card in doc["cards"]]}
    for rule in C.IDENTITY_RULES:
        assert C.parse_catalog({**doc, "identity": rule}).identities() == \
            C.parse_catalog({**plain, "identity": rule}).identities()


def test_any_other_unknown_card_key_is_still_refused():
    doc = copy.deepcopy(FIXTURE["accepted"][0]["doc"])
    doc["cards"][0]["extras"] = {}
    with pytest.raises(C.CatalogError, match="unknown key"):
        C.parse_catalog(doc)


def test_a_catalog_file_with_extra_loads(tmp_path):
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps(FIXTURE["accepted"][0]["doc"]), encoding="utf-8")
    assert C.load_catalog(path).card("GEN-001").extra["rarity"] == "common"


@pytest.mark.parametrize("case", FIXTURE["accepted"], ids=lambda case: case["what"])
def test_the_package_gives_each_cards_extra_as_the_contract_says(case):
    catalog = C.parse_catalog(case["doc"])
    for card_id, extra in case["cards"].items():
        assert catalog.card(card_id).extra == extra


@pytest.mark.parametrize("case", FIXTURE["refused"], ids=lambda case: case["what"])
def test_the_package_refuses_an_extra_that_is_not_an_object(case):
    with pytest.raises(C.CatalogError) as error:
        C.parse_catalog(case["doc"])
    for fragment in case["mentions"]:
        assert fragment in str(error.value)


@pytest.mark.parametrize("case", FIXTURE["accepted"], ids=lambda case: case["what"])
def test_the_labeling_tool_accepts_what_this_package_accepts(case):
    assert _labelcore().extra_problem(case["doc"]) is None


@pytest.mark.parametrize("case", FIXTURE["refused"], ids=lambda case: case["what"])
def test_the_labeling_tool_refuses_what_this_package_refuses(case):
    problem = _labelcore().extra_problem(case["doc"])
    assert problem is not None
    for fragment in case["mentions"]:
        assert fragment in problem, problem
