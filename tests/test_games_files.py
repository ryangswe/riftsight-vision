# SPDX-License-Identifier: Apache-2.0
"""The files under ``games/``: the Riftbound catalog, accept rule, sources file and training
recipes, and the template."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from cardvision.core import bank as B
from cardvision.core.catalog import is_url, load_catalog
from cardvision.recognize import AcceptRule, accept_errors, load_accept

GAMES = Path(__file__).resolve().parents[1] / "games"
RIFTBOUND = GAMES / "riftbound"
TEMPLATE = GAMES / "_template"


@pytest.fixture(scope="module")
def riftbound():
    return load_catalog(RIFTBOUND / "catalog.json")


def test_the_riftbound_catalog_is_valid(riftbound):
    assert (riftbound.game, riftbound.locale) == ("riftbound", "en")
    assert len(riftbound) >= 1400
    assert riftbound.kinds == {
        "landscape": ["Battlefield"],
        "foilProbability": {"Legend": 0.6, "Rune": 0.1},
        "dice": ["Legend"],
        "board": {"leader": "Legend", "unit": "Unit", "attachment": "Gear", "resource": "Rune"},
    }
    assert riftbound.ids() == sorted(riftbound.ids())  # one fixed order: by id
    assert all(card.kind for card in riftbound)


def test_the_riftbound_catalog_holds_no_url_and_no_art(riftbound):
    text = (RIFTBOUND / "catalog.json").read_text(encoding="utf-8")
    assert "://" not in text and "http" not in text.lower() and "www." not in text.lower()
    # Every image is a bare file name made of the card id; nothing else is said about the art.
    assert all(card.art == f"{card.id}.webp" and not is_url(card.art) for card in riftbound)
    document = json.loads(text)
    assert set(document) == {"game", "locale", "facets", "cards", "kinds"}
    keys = {"id", "name", "kind", "printingOf", "art"}
    assert all(set(card) - {"token", "facets"} == keys for card in document["cards"])
    # The facets are the labeling tool's filters, game facts only: domain, energy and set.
    assert [facet["key"] for facet in document["facets"]] == ["domain", "energy", "set"]
    assert all(set(card.get("facets", {})) <= {"domain", "energy", "set"} for card in document["cards"])
    assert all("energy" in card["facets"] and "set" in card["facets"] for card in document["cards"])
    assert all(card["token"] is True for card in document["cards"] if "token" in card)   # never written as false
    assert not re.search(r"\b[0-9a-f]{16,}\b", text)  # no hash of anything


def test_riftbound_tokens_are_the_cards_with_a_token_id(riftbound):
    """A token's id is three capitals, a hyphen, T and two digits; exactly those cards are marked."""
    shaped = [card.id for card in riftbound if re.fullmatch(r"[A-Z]{3}-T[0-9]{2}", card.id)]
    assert riftbound.token_ids() == shaped and len(shaped) >= 15
    assert riftbound.card("UNL-T01").token is True and riftbound.card("OGN-001").token is False


def test_the_riftbound_kind_settings_name_kinds_the_catalog_has(riftbound):
    kinds = riftbound.kinds
    named = {*kinds["landscape"], *kinds["dice"], *kinds["foilProbability"], *kinds["board"].values()}
    assert named <= {card.kind for card in riftbound}
    assert not (RIFTBOUND / "kinds.json").exists()


def test_riftbound_printings_point_at_cards_of_the_same_name(riftbound):
    printings = [card for card in riftbound if card.printing_of is not None]
    assert len(printings) > 200
    assert all(riftbound.name_of(card.printing_of) == card.name for card in printings)
    # No chains longer than the game has: an alternate of a reprint points at the reprint.
    assert all(card.printing_of != card.id for card in printings)


def test_riftbound_identities_follow_the_names(riftbound):
    groups = B.groups_by_name(riftbound.ids(), riftbound.names())
    assert len(groups) > 200 and all(len(group) >= 2 for group in groups)
    identity = B.IdentityGroups(groups, riftbound.ids(), known=riftbound.ids())
    assert identity.dropped == [] and len(identity.identity_ids) == len(riftbound.ids_by_name())
    assert identity.same("OGN-007", "OGN-007A") and not identity.same("OGN-007", "OGN-042")


def test_the_riftbound_accept_rule():
    rule = load_accept(RIFTBOUND / "accept.json")
    assert rule == AcceptRule(tau=0.62, delta=0.05, rotation_retry=True) == AcceptRule()
    assert rule.to_json() == {"tau": 0.62, "delta": 0.05, "rotationRetry": True}
    assert accept_errors(json.loads((RIFTBOUND / "accept.json").read_text(encoding="utf-8"))) == []


def test_the_riftbound_sources_file():
    from cardvision.data.schema import SOURCE_TYPES
    from cardvision.data.sources import load_source_config

    path = RIFTBOUND / "sources.json"
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "sourceTypes": ["digital/rift-atlas", "digital/tcg-arena"],
        "handRow": {"sourceTypes": ["digital/tcg-arena"], "minCenterY": 0.85},
    }
    config = load_source_config(path)
    assert config.source_types == (*SOURCE_TYPES, "digital/rift-atlas", "digital/tcg-arena")
    assert config.hand_row_source_types == ("digital/tcg-arena",) and config.hand_row_min_center_y == 0.85


def _toml(path: Path) -> dict:
    try:
        import tomllib
    except ImportError:
        tomllib = pytest.importorskip("tomli")
    return tomllib.loads(path.read_text(encoding="utf-8"))


def test_both_training_recipes_read_the_training_manifest_and_the_sources_file():
    """The detector's recipe states paths from the repository's root, the recognizer's from its
    own folder; both name ``data/riftbound-train.manifest.jsonl`` and this folder's sources file."""
    root = GAMES.parent
    manifest, sources = root / "data" / "riftbound-train.manifest.jsonl", RIFTBOUND / "sources.json"
    detector = _toml(RIFTBOUND / "train-detector.toml")["streams"]["real"]
    assert (root / detector["manifest"]).resolve() == manifest and (root / detector["sources"]).resolve() == sources
    recognizer = _toml(RIFTBOUND / "train-recognizer.toml")["data"]
    assert [(RIFTBOUND / item).resolve() for item in recognizer["manifests"]] == [manifest]
    assert (RIFTBOUND / recognizer["sources"]).resolve() == sources
    assert (RIFTBOUND / recognizer["catalog"]).resolve() == RIFTBOUND / "catalog.json" and "kinds" not in recognizer
    assert sources.is_file()


def test_the_riftbound_readme_lists_every_file_in_the_folder():
    readme = (RIFTBOUND / "README.md").read_text(encoding="utf-8")
    rows = re.findall(r"^\| `([^`]+)` \|", readme, flags=re.M)
    files = sorted(path.name for path in RIFTBOUND.iterdir() if path.is_file() and not path.name.startswith("."))
    assert sorted(rows) == files
    assert files == ["README.md", "accept.json", "catalog.json", "sources.json", "train-detector.toml",
                     "train-recognizer.toml"]


def test_the_template_is_a_valid_two_card_catalog():
    template = load_catalog(TEMPLATE / "catalog.json")
    assert len(template) == 2 and len(template.ids_by_name()) == 2
    assert all(not is_url(card.art) for card in template)


def test_each_game_folder_explains_itself():
    riftbound = (RIFTBOUND / "README.md").read_text(encoding="utf-8")
    assert "Riot Games" in riftbound and "No card art is included" in riftbound
    template = (TEMPLATE / "README.md").read_text(encoding="utf-8")
    assert all(key in template for key in ("`id`", "`name`", "`kind`", "`printingOf`", "`art`"))


def test_the_riftbound_readme_names_every_reader_of_the_accept_file_and_says_it_is_strict():
    """Every command-line option that takes an accept-rule file is named in the README, with
    the three keys and the statement that no other key is allowed."""
    import argparse

    from cardvision.cli import build_parser
    from cardvision.recognize.accept import ACCEPT_KEYS

    subparsers = next(action for action in build_parser()._actions if isinstance(action, argparse._SubParsersAction))
    readers = sorted((name, option) for name, child in subparsers.choices.items() for action in child._actions
                     for option in action.option_strings if "accept" in option)
    assert readers == [("build-release", "--accept"), ("calibrate", "--accept"), ("evaluate", "--accept"),
                       ("evaluate", "--other-accept"), ("infer", "--accept")]
    readme = (RIFTBOUND / "README.md").read_text(encoding="utf-8")
    section = readme[readme.index("## The accept file"):readme.index("## No card art is included")]
    for name, option in readers:
        assert re.search(rf"`cardvision {name}[^\n]*{option}", section), (name, option)
    assert "exactly three keys" in section and "Any other key is an error" in section
    assert all(f"`{key}`" in section for key in ACCEPT_KEYS)
    assert json.dumps(AcceptRule().to_json()) in section     # the example is the file's own content
    assert json.loads((RIFTBOUND / "accept.json").read_text(encoding="utf-8")) == AcceptRule().to_json()
    # What the page says is refused is refused, by the one reader.
    for wrong in ({"tau": 0.62, "delta": 0.05}, {"tau": 0.62, "delta": 0.05, "rotationRetry": True, "note": "x"},
                  {"Tau": 0.62, "delta": 0.05, "rotationRetry": True}, {"tau": 0.62, "delta": 0.05, "rotationretry": True}):
        assert accept_errors(wrong)


def test_the_template_readme_keeps_another_game_out_of_this_repository():
    template = (TEMPLATE / "README.md").read_text(encoding="utf-8")
    assert "does not go into this repository's `games/`" in template
    assert "games/<your-game>" not in template and "MY-GAME/catalog.json" in template


def test_the_games_folder_holds_no_image():
    files = sorted(path for path in GAMES.rglob("*") if path.is_file())
    assert files
    images = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".tif", ".tiff", ".svg"}
    assert [path.name for path in files if path.suffix.lower() in images] == []
    for path in files:
        if path.suffix in (".json", ".md", ".toml"):
            path.read_text(encoding="utf-8")  # decodes as text
