# SPDX-License-Identifier: Apache-2.0
"""Building a bank and its identity groups from the toy game."""

from __future__ import annotations

import functools
import http.server
import json
import shutil
import threading

import numpy as np
import pytest

import toy_game
from cardvision import cli
from cardvision.bank import build as BB
from cardvision.bank.documents import DocumentExistsError, canonical_bytes, read_json, sha256_hex
from cardvision.bank.views import card_views
from cardvision.core import bank as B
from cardvision.core.catalog import load_catalog, parse_catalog
from cardvision.core.images import load_rgb
from cardvision.core.onnx import create_session, embed, run_batched
from cardvision.core.preprocess import full128
from helpers import EMBEDDING_WIDTH

ALL_IDS = [card_id for card_id, *_ in toy_game.CARDS]


def sub_catalog(ids):
    """The toy catalog restricted to ``ids``, in the order given."""
    by_id = {card["id"]: card for card in toy_game.catalog_document()["cards"]}
    cards = [dict(by_id[card_id]) for card_id in ids]
    for card in cards:
        if card["printingOf"] not in ids:
            card["printingOf"] = None
    return parse_catalog({"game": "toy", "locale": "en", "cards": cards})


@pytest.fixture(scope="module")
def session(tiny_model):
    return create_session(tiny_model)


@pytest.fixture(scope="module")
def catalog(toy):
    return load_catalog(toy[0])


@pytest.fixture(scope="module")
def full(toy, catalog, session):
    """A bank of the whole toy game."""
    return BB.build_bank(catalog, toy[1], session, model="tiny")


def vec_of(bank, card_id):
    return next(entry["vec"] for entry in bank["entries"] if entry["cardId"] == card_id)


def test_the_bank_document(full, catalog):
    bank = full.bank
    assert list(bank) == ["schemaVersion", "kind", "game", "locale", "version", "model", "dim", "dtype",
                          "preprocessing", "centerMask", "views", "aggregation", "cardCount", "entryCount", "entries"]
    assert {key: value for key, value in bank.items() if key != "entries"} == {
        "schemaVersion": 1, "kind": "embedding-bank", "game": "toy", "locale": "en", "version": 1,
        "model": "tiny", "dim": EMBEDDING_WIDTH, "dtype": "fp16",
        "preprocessing": {"id": "full128", "size": 128, "centerMask": False, "poolVersion": 2, "crop": "truncate"},
        "centerMask": False, "views": 16, "aggregation": "mean", "cardCount": 20, "entryCount": 20,
    }
    assert [entry["cardId"] for entry in bank["entries"]] == catalog.ids()  # catalog order
    assert all(list(entry) == ["cardId", "vec", "artV"] for entry in bank["entries"])
    assert full.embedded == catalog.ids() and full.reused == [] and full.skipped == []
    assert full.reembedded == [] and full.unrecorded == [] and full.art_missing == []


def test_a_row_is_the_normalized_mean_of_the_normalized_view_embeddings(full, toy, session):
    art = load_rgb(toy[1] / "TOY-005.png")
    embeddings = run_batched(session, [full128(view) for view in card_views(art, "TOY-005")])
    unit = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)
    mean = unit.mean(0)
    row = B.fp16_roundtrip(mean / np.linalg.norm(mean))
    assert B.encode_vector(row) == vec_of(full.bank, "TOY-005")
    # What is stored is already what a reader decodes: a second round trip changes nothing.
    stored = B.decode_vector(vec_of(full.bank, "TOY-005"))
    assert B.encode_vector(B.fp16_roundtrip(stored.astype(np.float32))) == vec_of(full.bank, "TOY-005")


def test_build_then_decode_then_match(full, toy, catalog, session, tmp_path):
    bank_path, groups_path = BB.write_bank(full.bank, catalog, tmp_path / "bank.json")
    ids, matrix, doc = B.load_bank(bank_path)
    assert ids == catalog.ids() and matrix.shape == (20, EMBEDDING_WIDTH) and doc == full.bank
    assert np.allclose(np.linalg.norm(matrix, axis=1), 1.0, atol=1e-6)
    identity = B.IdentityGroups(read_json(groups_path)["groups"], ids, known=catalog.ids())

    art = {card_id: load_rgb(catalog.art_location(card_id, toy[1])) for card_id in ids}
    # The clean image of every card finds its own row.
    clean = B.l2_normalize(embed(session, [art[card_id] for card_id in ids], full128))
    assert [ids[column] for column in (clean @ matrix.T).argmax(axis=1)] == ids
    # A damaged view of every card finds the card's identity.
    damaged = B.l2_normalize(embed(session, [card_views(art[card_id], card_id)[5] for card_id in ids], full128))
    best = (damaged @ matrix.T).argmax(axis=1)
    assert [identity.of(ids[column]) for column in best] == [identity.of(card_id) for card_id in ids]


def test_building_twice_gives_the_same_bytes(full, toy, catalog, session):
    again = BB.build_bank(catalog, toy[1], session, model="tiny")
    assert canonical_bytes(again.bank) == canonical_bytes(full.bank)


def test_a_row_depends_on_its_own_card_only(full, toy, session):
    few = BB.build_bank(sub_catalog(["TOY-012", "TOY-003A", "TOY-001"]), toy[1], session, model="tiny")
    assert [entry["cardId"] for entry in few.bank["entries"]] == ["TOY-012", "TOY-003A", "TOY-001"]
    for entry in few.bank["entries"]:
        assert entry["vec"] == vec_of(full.bank, entry["cardId"])


def test_tau_is_recorded_only_when_given(toy, session):
    small = sub_catalog(ALL_IDS[:2])
    assert "tau" not in BB.build_bank(small, toy[1], session, model="tiny").bank
    assert BB.build_bank(small, toy[1], session, model="tiny", tau=0.62).bank["tau"] == 0.62
    for bad in (0, 1.5, True, "0.62"):
        with pytest.raises(BB.BankBuildError, match="tau"):
            BB.build_bank(small, toy[1], session, model="tiny", tau=bad)


def test_a_bank_needs_a_label_and_a_whole_version(toy, session):
    small = sub_catalog(ALL_IDS[:2])
    with pytest.raises(BB.BankBuildError, match='"model" label'):
        BB.build_bank(small, toy[1], session)
    for bad in (0, -1, 1.5, True):
        with pytest.raises(BB.BankBuildError, match="version"):
            BB.build_bank(small, toy[1], session, model="tiny", version=bad)
    assert BB.build_bank(small, toy[1], session, model="tiny", version=7).bank["version"] == 7


# ------------------------------------------------------------------------------ extending
@pytest.fixture(scope="module")
def base(toy, session):
    """A bank of 15 cards, deliberately not in catalog order."""
    ids = [*ALL_IDS[5:15], *ALL_IDS[:5]]
    return BB.build_bank(sub_catalog(ids), toy[1], session, model="tiny", tau=0.62).bank


def test_extending_keeps_every_base_entry_and_appends_the_rest(base, full, toy, catalog, session):
    extended = BB.build_bank(catalog, toy[1], session, base=base)
    base_ids = [entry["cardId"] for entry in base["entries"]]
    assert extended.reused == base_ids
    assert extended.embedded == [card_id for card_id in catalog.ids() if card_id not in base_ids]
    # The base entries come first, unchanged and in the base bank's order, not the catalog's.
    assert extended.bank["entries"][:15] == base["entries"]
    assert [entry["cardId"] for entry in extended.bank["entries"][15:]] == extended.embedded
    # The header carries on from the base bank.
    assert extended.bank["version"] == 2 and extended.bank["model"] == "tiny" and extended.bank["tau"] == 0.62
    assert extended.bank["cardCount"] == extended.bank["entryCount"] == 20
    # Every row equals the row of a build from scratch: a row depends on its own card only.
    for entry in extended.bank["entries"]:
        assert entry["vec"] == vec_of(full.bank, entry["cardId"])


def test_extending_keeps_a_base_row_whose_image_is_not_there_to_compare(base, toy, catalog, session, tmp_path):
    art = tmp_path / "art"
    art.mkdir()
    base_ids = [entry["cardId"] for entry in base["entries"]]
    for card_id in ALL_IDS:
        if card_id not in base_ids:
            shutil.copy(toy[1] / f"{card_id}.png", art / f"{card_id}.png")
    # A folder that holds the new cards' images only: every base row is kept, and said to be unchecked.
    extended = BB.build_bank(catalog, art, session, base=base)
    assert extended.bank["entries"][:15] == base["entries"]
    assert extended.reused == base_ids == extended.art_missing
    assert extended.reembedded == [] and extended.unrecorded == []


def test_extending_carries_other_keys_of_a_base_entry_through(base, toy, catalog, session):
    marked = {**base, "entries": [{**entry, "note": "kept"} for entry in base["entries"]]}
    extended = BB.build_bank(catalog, toy[1], session, base=marked)
    assert all(entry["note"] == "kept" for entry in extended.bank["entries"][:15])
    assert all("note" not in entry for entry in extended.bank["entries"][15:])


def test_extending_refuses_a_base_card_the_catalog_no_longer_has(base, toy, session):
    without = sub_catalog([card_id for card_id in ALL_IDS if card_id != "TOY-007"])
    with pytest.raises(BB.BankBuildError, match=r"1 card id\(s\) of the base bank are not in the catalog.*TOY-007"):
        BB.build_bank(without, toy[1], session, base=base)


def test_extending_refuses_a_base_made_differently(base, toy, catalog, session):
    def build(changed, **more):
        return BB.build_bank(catalog, toy[1], session, base={**base, **changed}, **more)

    with pytest.raises(BB.BankBuildError, match='"model" \'tiny\', this build uses \'other\''):
        build({}, model="other")
    with pytest.raises(BB.BankBuildError, match='"views" 8'):
        build({"views": 8})
    with pytest.raises(BB.BankBuildError, match='"preprocessing"'):
        build({"preprocessing": {**base["preprocessing"], "poolVersion": 1}})
    with pytest.raises(BB.BankBuildError, match='"game" \'other\''):
        build({"game": "other"})
    with pytest.raises(BB.BankBuildError, match="greater than the base bank's 1"):
        build({}, version=1)
    with pytest.raises(BB.BankBuildError, match="not an \"embedding-bank\" document"):
        build({"kind": "something-else"})
    with pytest.raises(BB.BankBuildError, match="more than one row for 1 card id"):
        build({"entries": [*base["entries"], base["entries"][0]]})
    half = B.encode_bank(["TOY-001"], np.ones((1, EMBEDDING_WIDTH // 2), np.float32))["entries"]
    with pytest.raises(BB.BankBuildError, match=f"rows have {EMBEDDING_WIDTH // 2} values, the recognizer outputs"):
        build({"entries": half})
    with pytest.raises(BB.BankBuildError, match="cannot be read"):
        build({"entries": [{"cardId": "TOY-001", "vec": "not base64!"}]})


# ---------------------------------------------------------------------------- missing art
def test_a_missing_image_stops_the_build_and_names_the_card(toy, catalog, session, tmp_path):
    art = tmp_path / "art"
    shutil.copytree(toy[1], art)
    (art / "TOY-004.png").unlink()
    (art / "TOY-009.png").unlink()
    with pytest.raises(BB.BankBuildError, match=r"no image for 2 card\(s\), for example 'TOY-004'"):
        BB.build_bank(catalog, art, session, model="tiny")
    skipping = BB.build_bank(catalog, art, session, model="tiny", skip_missing_art=True)
    assert skipping.skipped == ["TOY-004", "TOY-009"]
    assert [entry["cardId"] for entry in skipping.bank["entries"]] == [c for c in ALL_IDS if c not in skipping.skipped]
    assert skipping.bank["cardCount"] == 18


def test_an_unreadable_image_stops_the_build(toy, session, tmp_path):
    art = tmp_path / "art"
    art.mkdir()
    (art / "TOY-001.png").write_bytes(b"not an image")
    with pytest.raises(BB.BankBuildError, match="the image of card 'TOY-001' at .* cannot be read"):
        BB.build_bank(sub_catalog(["TOY-001"]), art, session, model="tiny", skip_missing_art=True)


def test_art_can_come_from_a_url_prefix(full, toy, catalog, session):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(toy[1]))
    handler.log_message = lambda *args: None
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    except OSError:
        pytest.skip("cannot open a local socket here")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base_url = f"http://127.0.0.1:{server.server_address[1]}/"
        few = sub_catalog(["TOY-002", "TOY-017"])
        fetched = BB.build_bank(few, base_url, session, model="tiny")
        for entry in fetched.bank["entries"]:
            assert entry["vec"] == vec_of(full.bank, entry["cardId"])
        ghost = parse_catalog({"game": "toy", "locale": "en",
                               "cards": [{"id": "TOY-404", "name": "Ghost", "art": "TOY-404.png"}]})
        with pytest.raises(BB.BankBuildError, match="the image of card 'TOY-404' at http://127.0.0.1.* not found"):
            BB.build_bank(ghost, base_url, session, model="tiny")
    finally:
        server.shutdown()
        server.server_close()


# ------------------------------------------------------------------------ identity groups
def test_identity_groups_are_by_name_and_include_alternate_printings(full, catalog):
    body = canonical_bytes(full.bank)
    groups = BB.identity_groups_document(full.bank, sha256_hex(body), catalog)
    assert groups == {
        "schemaVersion": 1, "kind": "identity-groups", "game": "toy", "locale": "en", "version": 1,
        "bank": {"version": 1, "sha256": sha256_hex(body)},
        "rule": {"level": "name"},
        "identityCount": 18,
        "groups": [["TOY-003", "TOY-003A"], ["TOY-010", "TOY-P01"]],
        "representative": {"TOY-003A": "TOY-003", "TOY-P01": "TOY-010"},
    }


def test_a_group_is_written_only_for_a_name_with_two_ids_in_the_bank(toy, session):
    ids = ["TOY-001", "TOY-003", "TOY-P01", "TOY-010"]  # TOY-003A, the other printing of TOY-003, is absent
    catalog = load_catalog(toy[0])
    bank = BB.build_bank(sub_catalog(ids), toy[1], session, model="tiny").bank
    groups = BB.identity_groups_document(bank, "0" * 64, catalog)
    assert groups["groups"] == [["TOY-010", "TOY-P01"]] and groups["identityCount"] == 3
    assert groups["representative"] == {"TOY-P01": "TOY-010"}


def test_names_group_cards_however_different_they_look(toy, session):
    # Two cards that share nothing but a name are one identity; no similarity enters the rule.
    doc = toy_game.catalog_document()
    for card in doc["cards"]:
        if card["id"] in ("TOY-001", "TOY-018"):
            card["name"] = "Shared Name"
    renamed = parse_catalog(doc)
    bank = BB.build_bank(renamed, toy[1], session, model="tiny").bank
    ids, rows = B.decode_bank(bank)
    assert float(rows[ids.index("TOY-001")] @ rows[ids.index("TOY-018")]) < 0.95
    assert ["TOY-001", "TOY-018"] in BB.identity_groups_document(bank, "0" * 64, renamed)["groups"]


def test_identity_groups_need_every_bank_id_in_the_catalog(full):
    with pytest.raises(BB.BankBuildError, match=r"2 bank id\(s\) are not in the catalog.*TOY-003A"):
        BB.identity_groups_document(full.bank, "0" * 64, sub_catalog(ALL_IDS[:18]))


# -------------------------------------------------------------------- cards without art
def without_art(rule="name"):
    """The toy catalog with three cards without art: a printing (TOY-003A), a card whose printing
    has art (TOY-010, printed as TOY-P01), and a card that is in no bank yet (TOY-NEW)."""
    doc = toy_game.catalog_document()
    doc["identity"] = rule
    for card in doc["cards"]:
        if card["id"] in ("TOY-003A", "TOY-010"):
            card["art"] = None
    doc["cards"].append({"id": "TOY-NEW", "name": "Lantern Moth", "kind": "unit", "printingOf": None, "art": None})
    return parse_catalog(doc)


NO_ART = ["TOY-010", "TOY-003A", "TOY-NEW"]  # catalog order


@pytest.mark.parametrize("rule", ["name", "printing"])
def test_a_card_without_art_gets_no_row_and_is_listed(full, toy, session, rule):
    catalog = without_art(rule)
    build = BB.build_bank(catalog, toy[1], session, model="tiny")
    ids = [card_id for card_id in catalog.ids() if card_id not in NO_ART]
    assert build.no_art == NO_ART and build.skipped == [] and build.embedded == ids
    assert [entry["cardId"] for entry in build.bank["entries"]] == ids
    assert (build.bank["cardCount"], build.bank["entryCount"]) == (18, 18)
    for card_id in ids:  # the other rows are those of a bank of the whole game
        assert vec_of(build.bank, card_id) == vec_of(full.bank, card_id)
    # The identity groups speak of the bank's ids: each of the two pairs lost the member without art.
    groups = BB.identity_groups_document(build.bank, "0" * 64, catalog)
    assert (groups["rule"], groups["groups"], groups["representative"], groups["identityCount"]) == (
        {"level": rule}, [], {}, 18)


def test_a_card_without_art_needs_no_image_and_skipping_is_not_needed(toy, session, tmp_path):
    art = tmp_path / "art"
    shutil.copytree(toy[1], art)
    (art / "TOY-010.png").unlink()      # the card has no art in the catalog: its file is not looked for
    build = BB.build_bank(without_art(), art, session, model="tiny")
    assert build.no_art == NO_ART and build.skipped == []


def test_a_bank_of_cards_without_art_only_is_refused(toy, session):
    catalog = parse_catalog({"game": "toy", "locale": "en", "cards": [{"id": "TOY-NEW", "name": "Moth", "art": None}]})
    with pytest.raises(BB.BankBuildError, match=r"the bank would be empty \(1 card\(s\) have no art\)"):
        BB.build_bank(catalog, toy[1], session, model="tiny")


def test_extending_keeps_a_base_row_whose_card_now_has_no_art(full, toy, session):
    # A card the base bank holds, listed without art now: its row is kept as it is, and listed
    # apart, not as an image that was not found.
    build = BB.build_bank(without_art(), toy[1], session, model="tiny", base=full.bank)
    assert build.reused == ALL_IDS and build.no_art_kept == ["TOY-010", "TOY-003A"]
    assert build.art_missing == [] and build.unrecorded == [] and build.reembedded == []
    assert build.no_art == ["TOY-NEW"] and build.embedded == []
    assert build.bank["entries"] == full.bank["entries"]
    # the same rows recording no image: still kept and listed apart, not as unrecorded
    bare = {**full.bank, "entries": [{key: value for key, value in entry.items() if key != "artV"}
                                     for entry in full.bank["entries"]]}
    again = BB.build_bank(without_art(), toy[1], session, model="tiny", base=bare, reembed_unrecorded=True)
    assert again.no_art_kept == ["TOY-010", "TOY-003A"]
    assert "TOY-010" not in again.unrecorded + again.reembedded + again.art_missing


def test_build_bank_command_lists_the_rows_kept_for_cards_now_without_art(toy, tiny_model, tmp_path, capsys):
    common = ["--art", str(toy[1]), "--recognizer", str(tiny_model)]
    old, new = tmp_path / "old.json", tmp_path / "new.json"
    assert cli.main(["build-bank", "--catalog", str(toy[0]), *common, "--out", str(old)]) == 0
    document = toy_game.catalog_document()
    for card in document["cards"]:
        if card["id"] == "TOY-010":
            card["art"] = None
    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text(json.dumps(document), encoding="utf-8")
    capsys.readouterr()
    assert cli.main(["build-bank", "--catalog", str(catalog_path), *common, "--out", str(new), "--base", str(old)]) == 0
    printed = capsys.readouterr().out
    assert ("1 row(s) kept for cards the catalog now lists without art: TOY-010; build without --base to drop them "
            "(not an additive refresh)") in printed
    assert "image not found" not in printed
    assert read_json(new)["entries"] == read_json(old)["entries"]
    # built without a base, the card has no row
    assert cli.main(["build-bank", "--catalog", str(catalog_path), *common, "--out", str(tmp_path / "fresh.json")]) == 0
    assert "TOY-010" not in [entry["cardId"] for entry in read_json(tmp_path / "fresh.json")["entries"]]


def test_build_bank_command_says_how_many_cards_have_no_art(toy, tiny_model, tmp_path, capsys):
    catalog_path = tmp_path / "catalog.json"
    document = toy_game.catalog_document()
    document["cards"].append({"id": "TOY-NEW", "name": "Lantern Moth", "kind": "unit", "printingOf": None, "art": None})
    catalog_path.write_text(json.dumps(document), encoding="utf-8")
    out = tmp_path / "bank.json"
    assert cli.main(["build-bank", "--catalog", str(catalog_path), "--art", str(toy[1]),
                     "--recognizer", str(tiny_model), "--out", str(out)]) == 0
    printed = capsys.readouterr().out
    assert "20 rows of 128 values; 20 embedded" in printed
    assert "1 card(s) have no art and are not in the bank: TOY-NEW" in printed
    assert "TOY-NEW" not in [entry["cardId"] for entry in read_json(out)["entries"]]


# ---------------------------------------------------------------------------------- files
def test_write_bank_puts_the_groups_beside_the_bank(full, catalog, tmp_path):
    bank_path, groups_path = BB.write_bank(full.bank, catalog, tmp_path / "out" / "toy-bank.json")
    assert groups_path == tmp_path / "out" / "toy-bank.identity-groups.json" == BB.groups_path_for(bank_path)
    assert bank_path.read_bytes() == canonical_bytes(full.bank) and bank_path.read_bytes().endswith(b"\n")
    assert read_json(groups_path)["bank"]["sha256"] == sha256_hex(bank_path.read_bytes())
    # Writing the same content again is fine; other content is refused, and neither file changes.
    BB.write_bank(full.bank, catalog, bank_path)
    other = {**full.bank, "version": 2}
    before = (bank_path.read_bytes(), groups_path.read_bytes())
    with pytest.raises(DocumentExistsError, match="already exists with different content; write to another path, or pass --overwrite to replace it"):
        BB.write_bank(other, catalog, bank_path)
    assert (bank_path.read_bytes(), groups_path.read_bytes()) == before
    BB.write_bank(other, catalog, bank_path, overwrite=True)
    assert read_json(bank_path)["version"] == 2 and read_json(groups_path)["version"] == 2
    elsewhere = BB.write_bank(full.bank, catalog, tmp_path / "b.json", groups_out=tmp_path / "g.json")
    assert elsewhere == (tmp_path / "b.json", tmp_path / "g.json")


def test_preprocessing_descriptor():
    assert BB.preprocessing_descriptor("full128") == {
        "id": "full128", "size": 128, "centerMask": False, "poolVersion": 2, "crop": "truncate"}
    with pytest.raises(ValueError, match="unknown preprocessing contract"):
        BB.preprocessing_descriptor("something-else")


# ----------------------------------------------------------------------------- command line
def test_build_bank_command(full, toy, tiny_model, tmp_path, capsys):
    out = tmp_path / "bank.json"
    arguments = ["build-bank", "--catalog", str(toy[0]), "--art", str(toy[1]), "--recognizer", str(tiny_model),
                 "--out", str(out)]
    assert cli.main(arguments) == 0
    printed = capsys.readouterr().out
    assert "20 rows of 128 values; 20 embedded, 0 kept from the base bank" in printed
    bank = read_json(out)
    assert bank["model"] == "tiny" and bank["entries"] == full.bank["entries"]  # the label is the file's name
    groups = read_json(tmp_path / "bank.identity-groups.json")
    assert groups["groups"] == [["TOY-003", "TOY-003A"], ["TOY-010", "TOY-P01"]]
    # A second run with the same inputs is a no-op; a different bank at the same path is refused.
    assert cli.main(arguments) == 0
    assert cli.main([*arguments, "--version", "3"]) == 1
    assert "already exists with different content" in capsys.readouterr().err
    assert cli.main([*arguments, "--version", "3", "--tau", "0.62", "--overwrite"]) == 0
    assert read_json(out)["version"] == 3 and read_json(out)["tau"] == 0.62


def test_build_bank_command_extends_a_base_and_refuses_removals(toy, tiny_model, tmp_path, capsys):
    fifteen = tmp_path / "fifteen.json"
    document = toy_game.catalog_document()
    document["cards"] = [card for card in document["cards"] if card["printingOf"] is None][:15]
    fifteen.write_text(json.dumps(document), encoding="utf-8")
    common = ["--art", str(toy[1]), "--recognizer", str(tiny_model)]
    old, new = tmp_path / "old.json", tmp_path / "new.json"
    assert cli.main(["build-bank", "--catalog", str(fifteen), *common, "--out", str(old)]) == 0
    assert cli.main(["build-bank", "--catalog", str(toy[0]), *common, "--out", str(new), "--base", str(old)]) == 0
    assert "5 embedded, 15 kept from the base bank" in capsys.readouterr().out
    assert read_json(new)["entries"][:15] == read_json(old)["entries"] and read_json(new)["version"] == 2
    # The other way round, the base bank holds cards the catalog lacks.
    assert cli.main(["build-bank", "--catalog", str(fifteen), *common, "--out", str(tmp_path / "x.json"),
                     "--base", str(new)]) == 1
    assert "5 card id(s) of the base bank are not in the catalog" in capsys.readouterr().err
    assert not (tmp_path / "x.json").exists()


def test_build_bank_command_reports_bad_inputs(toy, tiny_model, tmp_path, capsys):
    out = tmp_path / "bank.json"
    assert cli.main(["build-bank", "--catalog", str(toy[0]), "--art", str(tmp_path / "nowhere"),
                     "--recognizer", str(tiny_model), "--out", str(out)]) == 1
    assert "no image for 20 card(s)" in capsys.readouterr().err
    broken = tmp_path / "broken.json"
    broken.write_text('{"game": "toy"}', encoding="utf-8")
    assert cli.main(["build-bank", "--catalog", str(broken), "--art", str(toy[1]),
                     "--recognizer", str(tiny_model), "--out", str(out)]) == 1
    assert '"locale" must be a non-empty string' in capsys.readouterr().err
    assert not out.exists()
