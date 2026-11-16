# SPDX-License-Identifier: Apache-2.0
"""The image each bank row records (``artV``): written by a build, compared by a refresh, reported
by ``check-bank-art``, and not needed by anything that reads a bank."""

from __future__ import annotations

import contextlib
import copy
import functools
import hashlib
import http.server
import json
import shutil
import threading
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

import toy_game
from cardvision import cli
from cardvision.bank import art as BA
from cardvision.bank import build as BB
from cardvision.bank.documents import read_json
from cardvision.bank.refresh import check_refresh
from cardvision.core import bank as B
from cardvision.core.catalog import load_catalog, parse_catalog
from cardvision.core.onnx import create_session
from test_evaluate_cli import Evaluation
from test_infer_toy_models import ToySetup

ALL_IDS = [card_id for card_id, *_ in toy_game.CARDS]
# The base bank of the refresh tests: 15 cards, deliberately not in catalog order.
BASE_IDS = [*ALL_IDS[5:15], *ALL_IDS[:5]]
NEW_IDS = [card_id for card_id in ALL_IDS if card_id not in BASE_IDS]


def sub_catalog(ids):
    """The toy catalog restricted to ``ids``, in the order given."""
    by_id = {card["id"]: card for card in toy_game.catalog_document()["cards"]}
    cards = [dict(by_id[card_id]) for card_id in ids]
    for card in cards:
        if card["printingOf"] not in ids:
            card["printingOf"] = None
    return parse_catalog({"game": "toy", "locale": "en", "cards": cards})


def file_hash(path: Path) -> str:
    """The documented ``artV`` of a file, computed here without the package."""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16]


def redraw(path: Path) -> None:
    """Change a card's image: the same card with a white band painted across it."""
    with Image.open(path) as image:
        image = image.convert("RGB")
    ImageDraw.Draw(image).rectangle((0, 40, image.width, 120), fill=(255, 255, 255))
    image.save(path)


def save_again(path: Path) -> None:
    """Write the same pixels as another file: the PNG without compression."""
    with Image.open(path) as image:
        image = image.convert("RGB")
    image.save(path, compress_level=0)


def without_records(bank: dict, ids=None) -> dict:
    """A copy of a bank as an earlier version wrote it: no ``artV`` (on the rows in ``ids``, or on all)."""
    bank = copy.deepcopy(bank)
    for entry in bank["entries"]:
        if ids is None or entry["cardId"] in ids:
            del entry["artV"]
    return bank


def entry_of(bank: dict, card_id: str) -> dict:
    return next(entry for entry in bank["entries"] if entry["cardId"] == card_id)


@contextlib.contextmanager
def served(directory: Path):
    """The URL prefix of a local HTTP server over ``directory``; the test is skipped without a socket."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    handler.log_message = lambda *args: None
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    except OSError:
        pytest.skip("cannot open a local socket here")
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture(scope="module")
def session(tiny_model):
    return create_session(tiny_model)


@pytest.fixture(scope="module")
def catalog(toy):
    return load_catalog(toy[0])


@pytest.fixture(scope="module")
def full(toy, catalog, session):
    """A bank of the whole toy game, built from the toy art as drawn."""
    return BB.build_bank(catalog, toy[1], session, model="tiny").bank


@pytest.fixture(scope="module")
def base(toy, session):
    return BB.build_bank(sub_catalog(BASE_IDS), toy[1], session, model="tiny").bank


@pytest.fixture()
def art(toy, tmp_path) -> Path:
    """A copy of the toy art for one test, free to be changed."""
    return Path(shutil.copytree(toy[1], tmp_path / "art"))


# ------------------------------------------------------------------------------- the field
def test_the_hash_is_the_first_16_hex_digits_of_the_sha256_of_the_file_bytes(toy):
    assert B.art_version(b"") == "e3b0c44298fc1c14"
    assert B.art_version(b"abc") == "ba7816bf8f01cfea"
    body = (toy[1] / "TOY-005.png").read_bytes()
    assert B.art_version(body) == hashlib.sha256(body).hexdigest()[:16] == file_hash(toy[1] / "TOY-005.png")
    assert B.is_art_version("ba7816bf8f01cfea")
    for bad in ("BA7816BF8F01CFEA", "ba7816bf8f01cfe", "ba7816bf8f01cfea0", "ba7816bf8f01cfeg", "ba7816bf8f01cfea\n", "", None, 7):
        assert not B.is_art_version(bad)


def test_a_full_build_records_the_image_of_every_row(full, toy, catalog):
    assert [entry["cardId"] for entry in full["entries"]] == catalog.ids()
    for entry in full["entries"]:
        assert list(entry) == ["cardId", "vec", "artV"]
        assert entry["artV"] == file_hash(toy[1] / f"{entry['cardId']}.png")
    assert B.stored_art_versions(full) == [entry["artV"] for entry in full["entries"]]


def test_recording_the_image_leaves_the_stored_vectors_alone(full):
    stripped = without_records(full)
    assert [entry["vec"] for entry in stripped["entries"]] == [entry["vec"] for entry in full["entries"]]
    ids, stored = B.stored_vectors(full)
    assert (ids, stored.tobytes()) == (B.stored_vectors(stripped)[0], B.stored_vectors(stripped)[1].tobytes())
    assert np.array_equal(B.decode_bank(full)[1], B.decode_bank(stripped)[1])
    assert B.stored_art_versions(stripped) == [None] * 20


def test_encode_bank_writes_the_field_only_where_a_value_is_given():
    rows = B.l2_normalize(np.random.default_rng(0).normal(size=(3, 8)))
    ids = ["AB-001", "AB-002", "AB-003"]
    doc = B.encode_bank(ids, rows, art_versions=["0123456789abcdef", None, "fedcba9876543210"])
    assert [list(entry) for entry in doc["entries"]] == [["cardId", "vec", "artV"], ["cardId", "vec"],
                                                         ["cardId", "vec", "artV"]]
    assert B.stored_art_versions(doc) == ["0123456789abcdef", None, "fedcba9876543210"]
    assert [entry["vec"] for entry in doc["entries"]] == [entry["vec"] for entry in B.encode_bank(ids, rows)["entries"]]
    with pytest.raises(ValueError, match="one artV per id"):
        B.encode_bank(ids, rows, art_versions=["0123456789abcdef"])
    with pytest.raises(ValueError, match="card 'AB-002': artV 'nope' is not 16 lower-case hexadecimal digits"):
        B.encode_bank(ids, rows, art_versions=["0123456789abcdef", "nope", None])


def test_a_malformed_record_is_an_error_only_where_the_field_is_read():
    doc = B.encode_bank(["AB-001"], np.ones((1, 4), np.float32))
    doc["entries"][0]["artV"] = "0123"
    with pytest.raises(ValueError, match=r"card 'AB-001' \(entries\[0\]\): artV '0123' is not 16"):
        B.stored_art_versions(doc)
    assert B.decode_bank(doc)[0] == ["AB-001"]  # scoring never looks at it
    with pytest.raises(ValueError, match='"entries" list'):
        B.stored_art_versions({})


def test_art_from_a_url_prefix_records_the_hash_of_the_bytes_fetched(full, toy, session):
    with served(toy[1]) as base_url:
        few = sub_catalog(["TOY-002", "TOY-017"])
        fetched = BB.build_bank(few, base_url, session, model="tiny").bank
        for entry in fetched["entries"]:
            assert entry == entry_of(full, entry["cardId"])
        # A refresh against the same server finds nothing changed and embeds only the new card.
        more = sub_catalog(["TOY-002", "TOY-017", "TOY-004"])
        extended = BB.build_bank(more, base_url, session, base=fetched)
        assert extended.reused == ["TOY-002", "TOY-017"] and extended.embedded == ["TOY-004"]
        assert extended.reembedded == [] and extended.bank["entries"][:2] == fetched["entries"]


# ----------------------------------------------------------------- the incremental build
def test_an_unchanged_image_keeps_its_row_byte_for_byte_and_in_place(base, full, art, catalog, session):
    extended = BB.build_bank(catalog, art, session, base=base)
    assert extended.bank["entries"][:15] == base["entries"]
    assert json.dumps(extended.bank["entries"][:15]) == json.dumps(base["entries"])
    assert extended.reused == BASE_IDS and extended.reembedded == [] and extended.art_versions == {}
    assert extended.unrecorded == [] and extended.art_missing == []
    # New ids are appended in catalog order, each with its image recorded.
    assert extended.embedded == NEW_IDS == [entry["cardId"] for entry in extended.bank["entries"][15:]]
    assert extended.bank["entries"][15:] == [entry_of(full, card_id) for card_id in NEW_IDS]
    assert check_refresh(base, extended.bank).ok


def test_a_changed_image_is_embedded_again_in_the_same_position(base, art, catalog, session):
    redraw(art / "TOY-001.png")
    redraw(art / "TOY-009.png")
    extended = BB.build_bank(catalog, art, session, base=base)
    assert [entry["cardId"] for entry in extended.bank["entries"]] == [*BASE_IDS, *NEW_IDS]  # nothing moved
    assert extended.reembedded == ["TOY-009", "TOY-001"]  # in row order
    assert extended.reused == [card_id for card_id in BASE_IDS if card_id not in ("TOY-001", "TOY-009")]
    for card_id in ("TOY-001", "TOY-009"):
        before, after = entry_of(base, card_id), entry_of(extended.bank, card_id)
        assert after["vec"] != before["vec"]
        assert after["artV"] == file_hash(art / f"{card_id}.png") != before["artV"]
        assert extended.art_versions[card_id] == (before["artV"], after["artV"])
        # The new row is the row a build from scratch gives for the image there now.
        fresh = BB.build_bank(sub_catalog([card_id]), art, session, model="tiny").bank["entries"][0]
        assert after == fresh
    for card_id in extended.reused:
        assert entry_of(extended.bank, card_id) == entry_of(base, card_id)
    report = check_refresh(base, extended.bank)
    assert report.ok and [row[0] for row in report.reembedded] == ["TOY-009", "TOY-001"]
    assert (report.shared, report.identical, len(report.added)) == (15, 13, 5)


def test_the_same_picture_in_another_file_is_another_image(base, art, catalog, session):
    save_again(art / "TOY-007.png")
    extended = BB.build_bank(catalog, art, session, base=base)
    assert extended.reembedded == ["TOY-007"]
    before, after = entry_of(base, "TOY-007"), entry_of(extended.bank, "TOY-007")
    assert after["vec"] == before["vec"] and after["artV"] == file_hash(art / "TOY-007.png") != before["artV"]
    assert check_refresh(base, extended.bank).ok


def test_a_base_row_that_records_no_image_is_kept_and_listed(base, art, catalog, session):
    old = without_records(base)
    redraw(art / "TOY-001.png")  # the build cannot know: the row is kept all the same
    extended = BB.build_bank(catalog, art, session, base=old)
    assert extended.bank["entries"][:15] == old["entries"]
    assert all("artV" not in entry for entry in extended.bank["entries"][:15])
    assert extended.reused == BASE_IDS == extended.unrecorded and extended.reembedded == []
    assert all("artV" in entry for entry in extended.bank["entries"][15:])
    assert check_refresh(old, extended.bank).ok
    # A bank that records some rows and not others: each row by its own record.
    mixed = without_records(base, ids=["TOY-002", "TOY-006"])
    extended = BB.build_bank(catalog, art, session, base=mixed)
    assert extended.unrecorded == ["TOY-006", "TOY-002"] and extended.reembedded == ["TOY-001"]


def test_unrecorded_base_rows_are_embedded_again_when_asked(base, art, catalog, session):
    old = without_records(base)
    again = BB.build_bank(catalog, art, session, base=old, reembed_unrecorded=True)
    assert again.reembedded == BASE_IDS and again.reused == [] and again.unrecorded == []
    assert [entry["cardId"] for entry in again.bank["entries"]] == [*BASE_IDS, *NEW_IDS]
    assert all(again.art_versions[card_id] == (None, file_hash(art / f"{card_id}.png")) for card_id in BASE_IDS)
    # The images did not change and the machine is the same: the rows come back as they were,
    # now with their image recorded.
    assert again.bank["entries"][:15] == base["entries"]
    report = check_refresh(old, again.bank)
    assert report.ok and report.identical == 15 and report.notes[0].startswith(
        "15 shared row(s) keep their vector and now record their image (artV)")
    # Where an image did change, the row moves. Only the build that was asked may say so.
    redraw(art / "TOY-001.png")
    moved = BB.build_bank(catalog, art, session, base=old, reembed_unrecorded=True)
    assert entry_of(moved.bank, "TOY-001")["vec"] != entry_of(old, "TOY-001")["vec"]
    assert check_refresh(old, moved.bank).errors == [
        "1 shared row(s) are not byte-identical, and the old bank records no image (artV) for them: TOY-001"]
    assert check_refresh(old, moved.bank, reembedded_unrecorded=moved.reembedded).unverified == ["TOY-001"]


def test_the_flag_leaves_rows_that_record_their_image_alone(base, art, catalog, session):
    extended = BB.build_bank(catalog, art, session, base=base, reembed_unrecorded=True)
    assert extended.reembedded == [] and extended.reused == BASE_IDS
    assert extended.bank["entries"][:15] == base["entries"]


def test_a_base_row_without_an_image_to_compare_is_kept_and_listed(base, art, catalog, session):
    (art / "TOY-003.png").unlink()
    extended = BB.build_bank(catalog, art, session, base=base)
    assert extended.art_missing == ["TOY-003"] and extended.reembedded == [] and extended.reused == BASE_IDS
    assert entry_of(extended.bank, "TOY-003") == entry_of(base, "TOY-003")
    # Asked to embed unrecorded rows again, a row with no image stays unrecorded.
    again = BB.build_bank(catalog, art, session, base=without_records(base), reembed_unrecorded=True)
    assert again.unrecorded == ["TOY-003"] and "TOY-003" not in again.reembedded
    assert "artV" not in entry_of(again.bank, "TOY-003")


def test_a_changed_image_that_cannot_be_read_stops_the_build(base, art, catalog, session):
    (art / "TOY-001.png").write_bytes(b"not an image")
    with pytest.raises(BB.BankBuildError, match="the image of card 'TOY-001' at .* cannot be read"):
        BB.build_bank(catalog, art, session, base=base)


def test_removed_ids_are_refused_and_the_base_order_is_kept(base, art, catalog, session):
    without = sub_catalog([card_id for card_id in ALL_IDS if card_id != "TOY-007"])
    redraw(art / "TOY-007.png")
    with pytest.raises(BB.BankBuildError, match=r"1 card id\(s\) of the base bank are not in the catalog.*TOY-007"):
        BB.build_bank(without, art, session, base=base)
    # The catalog's order never reorders the base rows, changed images or not.
    redraw(art / "TOY-001.png")
    extended = BB.build_bank(sub_catalog(list(reversed(ALL_IDS))), art, session, base=base)
    assert [entry["cardId"] for entry in extended.bank["entries"]] == [*BASE_IDS, *reversed(NEW_IDS)]
    # A bank with the shared rows in another order is refused, whatever it records.
    reordered = copy.deepcopy(extended.bank)
    reordered["entries"][0], reordered["entries"][1] = reordered["entries"][1], reordered["entries"][0]
    assert check_refresh(base, reordered).errors[0].startswith("the shared card ids are not in the same order")
    for entry in reordered["entries"]:
        entry["artV"] = B.art_version(entry["cardId"].encode())
    assert check_refresh(base, reordered).errors[0].startswith("the shared card ids are not in the same order")


def test_identity_groups_are_rebuilt_by_name_after_a_refresh(base, art, catalog, session, tmp_path):
    redraw(art / "TOY-003.png")
    extended = BB.build_bank(catalog, art, session, base=base)
    _, groups_path = BB.write_bank(extended.bank, catalog, tmp_path / "bank.json")
    assert read_json(groups_path)["groups"] == [["TOY-003", "TOY-003A"], ["TOY-010", "TOY-P01"]]


# ----------------------------------------------------------------------- build-bank command
@pytest.fixture()
def files(toy, tiny_model, art, tmp_path, capsys):
    """The catalog of the base cards, a base bank built by the command, and the common arguments."""
    fifteen = tmp_path / "fifteen.json"
    document = toy_game.catalog_document()
    by_id = {card["id"]: card for card in document["cards"]}
    document["cards"] = [{**by_id[card_id], "printingOf": None} for card_id in BASE_IDS]
    fifteen.write_text(json.dumps(document), encoding="utf-8")
    common = ["--art", str(art), "--recognizer", str(tiny_model)]
    old = tmp_path / "old.json"
    assert cli.main(["build-bank", "--catalog", str(fifteen), *common, "--out", str(old)]) == 0
    capsys.readouterr()
    return old, ["build-bank", "--catalog", str(toy[0]), *common, "--base", str(old)]


def test_build_bank_command_lists_the_rows_it_embedded_again(files, art, tmp_path, capsys):
    old, arguments = files
    before = {card_id: file_hash(art / f"{card_id}.png") for card_id in ("TOY-001", "TOY-009")}
    redraw(art / "TOY-001.png")
    redraw(art / "TOY-009.png")
    new = tmp_path / "new.json"
    assert cli.main([*arguments, "--out", str(new)]) == 0
    assert capsys.readouterr().out.splitlines() == [
        "  7 / 7 cards",
        f"bank: {new} (20 rows of 128 values; 5 embedded, 2 re-embedded, 13 kept from the base bank)",
        "re-embedded, image changed (2):",
        f"  TOY-009  artV {before['TOY-009']} -> {file_hash(art / 'TOY-009.png')}",
        f"  TOY-001  artV {before['TOY-001']} -> {file_hash(art / 'TOY-001.png')}",
        f"identity groups: {tmp_path / 'new.identity-groups.json'}",
    ]
    assert cli.main(["check-refresh", str(old), str(new)]) == 0
    printed = capsys.readouterr().out.splitlines()
    assert printed[0] == ("ok: 15 shared rows, in the same order: 13 byte-identical, 2 re-embedded (image changed); "
                          "5 card id(s) added; identity groups only grew")
    assert printed[1:] == ["re-embedded (image changed) (2):",
                           f"  TOY-009  artV {before['TOY-009']} -> {file_hash(art / 'TOY-009.png')}",
                           f"  TOY-001  artV {before['TOY-001']} -> {file_hash(art / 'TOY-001.png')}"]


def test_build_bank_command_with_a_base_that_records_no_image(files, art, tmp_path, capsys):
    old, arguments = files
    old.write_text(json.dumps(without_records(read_json(old))), encoding="utf-8")
    kept = tmp_path / "kept.json"
    assert cli.main([*arguments, "--out", str(kept)]) == 0
    assert capsys.readouterr().out.splitlines() == [
        "  5 / 5 cards",
        f"bank: {kept} (20 rows of 128 values; 5 embedded, 15 kept from the base bank)",
        f"image not recorded, reused (15): {', '.join(BASE_IDS)}",
        f"identity groups: {tmp_path / 'kept.identity-groups.json'}",
    ]
    assert read_json(kept)["entries"][:15] == read_json(old)["entries"]

    redraw(art / "TOY-001.png")
    again = tmp_path / "again.json"
    assert cli.main([*arguments, "--out", str(again), "--reembed-unrecorded"]) == 0
    assert capsys.readouterr().out.splitlines() == [
        "  20 / 20 cards",
        f"bank: {again} (20 rows of 128 values; 5 embedded, 15 re-embedded, 0 kept from the base bank)",
        f"re-embedded, image not recorded (15): {', '.join(BASE_IDS)}",
        "of those, the new row differs from the base row (1): TOY-001",
        "  check-refresh reports these rows as errors: the base bank records no image that explains the change",
        f"identity groups: {tmp_path / 'again.identity-groups.json'}",
    ]
    assert all("artV" in entry for entry in read_json(again)["entries"])
    # check-refresh is the judge, and it names the row.
    assert cli.main(["check-refresh", str(old), str(again), "--bank-only"]) == 1
    assert "the old bank records no image (artV) for them: TOY-001" in capsys.readouterr().err


def test_build_bank_command_lists_base_rows_it_could_not_compare(files, art, tmp_path, capsys):
    _, arguments = files
    (art / "TOY-003.png").unlink()
    assert cli.main([*arguments, "--out", str(tmp_path / "new.json")]) == 0
    printed = capsys.readouterr().out
    assert "5 embedded, 15 kept from the base bank" in printed
    assert "image not found, not compared, reused (1): TOY-003" in printed


def test_the_flag_needs_a_base(toy, tiny_model, tmp_path, capsys):
    assert cli.main(["build-bank", "--catalog", str(toy[0]), "--art", str(toy[1]), "--recognizer", str(tiny_model),
                     "--out", str(tmp_path / "bank.json"), "--reembed-unrecorded"]) == 1
    assert "--reembed-unrecorded needs --base" in capsys.readouterr().err
    assert not (tmp_path / "bank.json").exists()


# ---------------------------------------------------------------------------- check-bank-art
@pytest.fixture()
def staged(full, art):
    """A bank with rows of every kind, against the art folder as it is now."""
    redraw(art / "TOY-002.png")
    save_again(art / "TOY-011.png")
    (art / "TOY-004.png").unlink()
    (art / "TOY-P01.png").unlink()
    return without_records(full, ids=["TOY-005", "TOY-006", "TOY-004"])


def test_check_bank_art_sorts_every_row(staged, full, art, catalog):
    report = BA.check_bank_art(staged, catalog, art)
    assert report.rows == 20 and report.recorded == 17
    assert report.changed == [
        ("TOY-002", entry_of(full, "TOY-002")["artV"], file_hash(art / "TOY-002.png")),
        ("TOY-011", entry_of(full, "TOY-011")["artV"], file_hash(art / "TOY-011.png")),
    ]
    assert report.unrecorded == ["TOY-004", "TOY-005", "TOY-006"]  # no record wins over no image
    assert report.missing == ["TOY-P01"]
    assert report.unreadable == [] and report.unknown == []
    others = [card_id for card_id in ALL_IDS
              if card_id not in ("TOY-002", "TOY-011", "TOY-004", "TOY-005", "TOY-006", "TOY-P01")]
    assert report.matching == others
    assert report.rows == len(report.matching) + len(report.changed) + len(report.unrecorded) + len(report.missing)


def test_check_bank_art_reads_and_changes_nothing(staged, art, catalog):
    before = copy.deepcopy(staged)
    listing = sorted((path.name, path.read_bytes()) for path in art.iterdir())
    BA.check_bank_art(staged, catalog, art)
    assert staged == before and sorted((path.name, path.read_bytes()) for path in art.iterdir()) == listing


def test_cards_without_art_are_listed_apart_by_both_checks(full, art, capsys):
    doc = toy_game.catalog_document()
    for card in doc["cards"]:
        if card["id"] == "TOY-010":
            card["art"] = None
    doc["cards"].append({"id": "TOY-NEW", "name": "Lantern Moth", "kind": "unit", "printingOf": None, "art": None})
    catalog = parse_catalog(doc)
    # With no bank: no image is looked for, and none is called missing.
    report = BA.check_art(catalog, art)
    assert (report.cards, report.no_art, report.missing) == (21, ["TOY-010", "TOY-NEW"], [])
    assert len(report.usable) == 19
    # With a bank that has a row for a card the catalog now lists without art.
    bank_report = BA.check_bank_art(full, catalog, art)
    assert bank_report.no_art == ["TOY-010"] and bank_report.missing == []
    assert len(bank_report.matching) == 19 and bank_report.rows == 20
    catalog_path = art.parent / "no-art-catalog.json"
    catalog_path.write_text(json.dumps(doc), encoding="utf-8")
    assert cli.main(["check-bank-art", "--catalog", str(catalog_path), "--art", str(art)]) == 0
    assert '2 without art in the catalog ("art": null), so not in a bank built from it: TOY-010, TOY-NEW' in (
        capsys.readouterr().out)
    bank_path = art.parent / "no-art-bank.json"
    bank_path.write_text(json.dumps(full), encoding="utf-8")
    assert cli.main(["check-bank-art", str(bank_path), "--catalog", str(catalog_path), "--art", str(art)]) == 0
    assert "1 for a card the catalog now lists without art: TOY-010" in capsys.readouterr().out


def test_check_bank_art_counts_a_row_whose_card_the_catalog_lacks(full, art):
    report = BA.check_bank_art(full, sub_catalog(ALL_IDS[:18]), art)
    assert report.unknown == ["TOY-003A", "TOY-P01"] and len(report.matching) == 18
    with pytest.raises(ValueError, match='a bank document needs an "entries" list'):
        BA.check_bank_art({"kind": "identity-groups"}, sub_catalog(ALL_IDS[:18]), art)
    # A bank with no header, as the storage module alone writes it, is read like any other.
    bare = {"entries": full["entries"]}
    assert len(BA.check_bank_art(bare, sub_catalog(ALL_IDS), art).matching) == 20


def test_check_bank_art_command(staged, full, toy, art, tmp_path, capsys):
    bank_path = tmp_path / "bank.json"
    bank_path.write_text(json.dumps(staged), encoding="utf-8")
    arguments = ["check-bank-art", str(bank_path), "--catalog", str(toy[0])]
    assert cli.main([*arguments, "--art", str(art)]) == 0
    assert capsys.readouterr().out.splitlines() == [
        f"bank: {bank_path} (20 rows; 17 record their source image)",
        "  14 embedded from the image now under --art",
        "  2 embedded from a different image",
        "  3 with no recorded image",
        "  1 with no image under --art",
        "embedded from a different image (2):",
        f"  TOY-002  artV {entry_of(full, 'TOY-002')['artV']}, the image now is {file_hash(art / 'TOY-002.png')}",
        f"  TOY-011  artV {entry_of(full, 'TOY-011')['artV']}, the image now is {file_hash(art / 'TOY-011.png')}",
        "no image under --art, for example: TOY-P01",
    ]
    assert json.loads(bank_path.read_text(encoding="utf-8")) == staged  # read only
    # It reports and does not judge: a folder with no image at all is still exit code 0.
    assert cli.main([*arguments, "--art", str(tmp_path / "nowhere")]) == 0
    printed = capsys.readouterr().out
    assert "  17 with no image under --art" in printed and "  0 embedded from a different image" in printed
    assert "for example: TOY-001, TOY-002, TOY-003, TOY-007, TOY-008, and 12 more" in printed
    # A bank written before rows recorded their image: every row is of unknown image.
    bank_path.write_text(json.dumps(without_records(full)), encoding="utf-8")
    assert cli.main([*arguments, "--art", str(art)]) == 0
    printed = capsys.readouterr().out.splitlines()
    assert printed == [f"bank: {bank_path} (20 rows; 0 record their source image)",
                       "  0 embedded from the image now under --art", "  0 embedded from a different image",
                       "  20 with no recorded image", "  0 with no image under --art"]


def test_check_bank_art_command_fails_only_when_the_bank_or_the_catalog_cannot_be_read(full, toy, tmp_path, capsys):
    bank_path = tmp_path / "bank.json"
    bank_path.write_text(json.dumps(full), encoding="utf-8")
    assert cli.main(["check-bank-art", str(tmp_path / "absent.json"), "--catalog", str(toy[0]),
                     "--art", str(toy[1])]) == 1
    assert "cardvision check-bank-art: failed" in capsys.readouterr().err
    (tmp_path / "text.json").write_text("not json", encoding="utf-8")
    assert cli.main(["check-bank-art", str(tmp_path / "text.json"), "--catalog", str(toy[0]),
                     "--art", str(toy[1])]) == 1
    assert "text.json: not valid JSON" in capsys.readouterr().err
    assert cli.main(["check-bank-art", str(toy[0]), "--catalog", str(toy[0]), "--art", str(toy[1])]) == 1
    assert 'a bank document needs an "entries" list' in capsys.readouterr().err
    broken = tmp_path / "broken.json"
    broken.write_text('{"game": "toy"}', encoding="utf-8")
    assert cli.main(["check-bank-art", str(bank_path), "--catalog", str(broken), "--art", str(toy[1])]) == 1
    assert '"locale" must be a non-empty string' in capsys.readouterr().err
    marred = copy.deepcopy(full)
    marred["entries"][0]["artV"] = "xyz"
    bank_path.write_text(json.dumps(marred), encoding="utf-8")
    assert cli.main(["check-bank-art", str(bank_path), "--catalog", str(toy[0]), "--art", str(toy[1])]) == 1
    assert "artV 'xyz' is not 16 lower-case hexadecimal digits" in capsys.readouterr().err


def test_check_bank_art_against_a_url_prefix(staged, full, art, catalog):
    with served(art) as base_url:
        report = BA.check_bank_art(staged, catalog, base_url)
    assert [row[0] for row in report.changed] == ["TOY-002", "TOY-011"] and report.missing == ["TOY-P01"]
    assert len(report.matching) == 14 and report.unreadable == []


def test_check_bank_art_stops_at_a_certificate_failure_and_says_what_to_install(staged, toy, tmp_path, capsys, monkeypatch):
    import ssl
    import urllib.error
    import urllib.request

    from cardvision.core.tls import CERTIFICATE_HELP, CertificatesMissing

    asked = []

    def unverified(request, timeout=None, context=None):
        asked.append(request.full_url)
        raise urllib.error.URLError(ssl.SSLCertVerificationError(1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"))

    monkeypatch.setattr(urllib.request, "urlopen", unverified)
    with pytest.raises(CertificatesMissing, match="the server's TLS certificate could not be verified"):
        BA.check_bank_art(staged, load_catalog(toy[0]), "https://cards.example/art/")
    assert len(asked) == 1                                       # not one failed image after another
    bank_path = tmp_path / "bank.json"
    bank_path.write_text(json.dumps(staged), encoding="utf-8")
    assert cli.main(["check-bank-art", str(bank_path), "--catalog", str(toy[0]), "--art", "https://cards.example/art/"]) == 1
    assert CERTIFICATE_HELP in capsys.readouterr().err


# ------------------------------------------------ a bank written before rows recorded their image
@pytest.fixture(scope="module")
def evaluation(tmp_path_factory, toy) -> Evaluation:
    return Evaluation(tmp_path_factory.mktemp("bank-art-evaluate"), *toy)


@pytest.fixture(scope="module")
def two_banks(evaluation, toy, tmp_path_factory) -> tuple[Path, Path]:
    """One bank as the build writes it now, and the same bank as an earlier version wrote it."""
    folder = tmp_path_factory.mktemp("bank-art-banks")
    catalog = load_catalog(toy[0])
    bank = BB.build_bank(catalog, toy[1], create_session(evaluation.toy.recognizer), model="toy").bank
    new_path, _ = BB.write_bank(bank, catalog, folder / "new" / "bank.json")
    old_path, _ = BB.write_bank(without_records(bank), catalog, folder / "old" / "bank.json")
    assert "artV" in new_path.read_text(encoding="utf-8") and "artV" not in old_path.read_text(encoding="utf-8")
    return new_path, old_path


def test_inference_reads_a_bank_without_the_field_and_names_the_same_cards(evaluation, two_banks, capsys):
    setup: ToySetup = evaluation.toy
    printed = []
    for bank_path in two_banks:
        code = cli.main(["infer", str(setup.image), "--detector", str(setup.detector), "--recognizer",
                         str(setup.recognizer), "--bank", str(bank_path), "--catalog", str(setup.catalog),
                         "--accept", str(setup.accept)])
        captured = capsys.readouterr()
        assert code == 0, captured.err
        printed.append((json.loads(captured.out)["boxes"], captured.err.strip().splitlines()[-1]))
    assert printed[0] == printed[1] and printed[0][1].endswith("1 frame(s), 6 face(s), 1 back(s), 5 named")


def test_evaluation_reads_a_bank_without_the_field_and_scores_the_same(evaluation, two_banks, capsys, tmp_path):
    setup: ToySetup = evaluation.toy
    results = []
    for number, bank_path in enumerate(two_banks):
        out = tmp_path / str(number)
        code = cli.main(["evaluate", "hover", "--manifest", str(evaluation.manifest), "--frames",
                         str(evaluation.frames), "--detector", str(setup.detector), "--recognizer",
                         str(setup.recognizer), "--bank", str(bank_path), "--catalog", str(setup.catalog),
                         "--accept", str(setup.accept), "--out", str(out), "--bootstrap", "20"])
        captured = capsys.readouterr()
        assert code == 0, captured.err
        results.append(json.loads((out / "evaluate-hover.json").read_text())["results"]["overall"])
    assert results[0] == results[1] and results[0]["namedRight"]["denominator"] == 7
    # The two banks compared with each other: no event changes.
    code = cli.main(["evaluate", "compare", "--manifest", str(evaluation.manifest), "--frames",
                     str(evaluation.frames), "--detector", str(setup.detector), "--recognizer",
                     str(setup.recognizer), "--bank", str(two_banks[1]), "--catalog", str(setup.catalog),
                     "--accept", str(setup.accept), "--other-bank", str(two_banks[0]), "--bootstrap", "20"])
    captured = capsys.readouterr()
    assert code == 0, captured.err
    assert "- **regressions**: 0" in captured.out


def test_a_refresh_of_a_bank_without_the_field_is_checked_as_before(two_banks, capsys):
    new_path, old_path = two_banks
    later = old_path.with_name("later.json")
    document = read_json(old_path)
    later.write_text(json.dumps({**document, "version": 2}), encoding="utf-8")
    assert cli.main(["check-refresh", str(old_path), str(later), "--bank-only"]) == 0
    assert capsys.readouterr().out.strip() == (
        "ok: 20 shared rows, in the same order: 20 byte-identical, 0 re-embedded (image changed); 0 card id(s) added")
