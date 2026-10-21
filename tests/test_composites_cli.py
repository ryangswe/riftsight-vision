# SPDX-License-Identifier: Apache-2.0
"""The make-composites and fetch-textures subcommands, and the Riftbound kinds settings."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from cardvision import cli
from cardvision.composites import KindSettings, load_kinds, read_labels
from cardvision.core.catalog import load_catalog, parse_catalog
from test_composites_fetch import Site, asset, tiny_jpeg
from test_composites_scene import KINDS, tree, write_scans

ROOT = Path(__file__).resolve().parents[1]


def make(toy, out, *extra):
    return cli.main(["make-composites", "--catalog", str(toy[0]), "--art", str(toy[1]), "--out", str(out),
                     "--n", "2", "--seed", "8", *extra])


def test_the_subcommands_are_registered():
    assert {"make-composites", "fetch-textures"} <= set(cli.SUBCOMMANDS)
    listing = cli.available_subcommands()
    # Column width follows the longest registered name, so compare name and summary, not spacing.
    line = next(row for row in listing.splitlines() if row.split()[:1] == ["make-composites"])
    assert line.split(None, 1)[1] == "Generate labeled training scenes from card images."
    assert "fetch-textures" in listing and "CC0" in listing


def test_make_composites_writes_a_folder_and_repeats(toy, tmp_path, capsys):
    assert make(toy, tmp_path / "a") == 0
    said = capsys.readouterr()
    assert "wrote 2 scenes" in said.out and "2 / 2 scenes" in said.err
    assert make(toy, tmp_path / "b") == 0
    a, b = tree(tmp_path / "a"), tree(tmp_path / "b")
    assert sorted(a) == ["images/00000.jpg", "images/00001.jpg", "labels.jsonl", "manifest.json"]
    assert a == b
    manifest = json.loads(a["manifest.json"])
    assert (manifest["seed"], manifest["split"], manifest["scenes"]) == (8, "train", 2)
    assert manifest["labelsSha256"] == hashlib.sha256(a["labels.jsonl"]).hexdigest()
    assert manifest["kinds"]["landscape"] == ["site"] and manifest["kinds"]["dice"] == []  # the catalog's own


def test_cards_without_art_are_left_out_and_said_apart(toy, tmp_path, capsys):
    # "art": null: no picture of the card is drawn; the note counts it apart from missing images
    document = json.loads(Path(toy[0]).read_text(encoding="utf-8"))
    for card in document["cards"]:
        if card["id"] == "TOY-002":
            card["art"] = None
    document["cards"].append({"id": "TOY-NEW", "name": "Lantern Moth", "kind": "unit", "printingOf": None, "art": None})
    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text(json.dumps(document), encoding="utf-8")
    out = tmp_path / "scenes"
    assert cli.main(["make-composites", "--catalog", str(catalog_path), "--art", str(toy[1]), "--out", str(out),
                     "--n", "3", "--seed", "1"]) == 0
    said = capsys.readouterr().err
    assert 'note: 2 catalog cards have no art ("art": null) and were left out' in said
    assert "have no image in" not in said
    assert not {"TOY-002", "TOY-NEW"} & {o["cardId"] for record in read_labels(out) for o in record["objects"]}
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert (manifest["catalog"]["cards"], manifest["catalog"]["cardsWithArt"], manifest["catalog"]["cardsWithoutArt"]) == (21, 19, 2)
    # a catalog of cards without art only: the refusal says why
    for card in document["cards"]:
        card["art"] = None
    catalog_path.write_text(json.dumps(document), encoding="utf-8")
    assert cli.main(["make-composites", "--catalog", str(catalog_path), "--art", str(toy[1]), "--out",
                     str(tmp_path / "none"), "--n", "1", "--seed", "1"]) == 1
    assert "(21 of the cards have no art)" in capsys.readouterr().err


def test_the_summary_says_what_each_number_counts(toy, tmp_path, capsys):
    """Positive faces, the different cards among those, the faces marked as ignore regions and
    the backs: each from the labels themselves. The cards are counted among the positive faces
    only, which is fewer than the manifest's count over every face."""
    out = tmp_path / "scenes"
    assert cli.main(["make-composites", "--catalog", str(toy[0]), "--art", str(toy[1]), "--out", str(out),
                     "--n", "3", "--seed", "1", "--split", "val"]) == 0
    said = capsys.readouterr().out
    faces = [o for record in read_labels(out) for o in record["objects"] if o["kind"] == "face"]
    positive = [o for o in faces if o["positive"]]
    backs = sum(o["kind"] == "back" for record in read_labels(out) for o in record["objects"])
    assert (len(positive), len({o["cardId"] for o in positive}), len(faces) - len(positive), backs) == (25, 14, 10, 3)
    assert said == (f"wrote 3 scenes to {out}: 25 positive faces showing 14 different cards, 10 more faces marked as "
                    "ignore regions (too hidden or too small), 3 backs\n")
    counts = json.loads((out / "manifest.json").read_text())["counts"]
    assert counts["distinctCards"] == len({o["cardId"] for o in faces}) == 16      # over every face, ignored ones included
    assert all((o["ignore"] is None) == o["positive"] for o in faces)


def test_split_textures_kinds_and_check(toy, tmp_path, capsys):
    scans = write_scans(tmp_path / "scans")
    (tmp_path / "kinds.json").write_text(json.dumps({"kinds": KINDS}), encoding="utf-8")
    assert make(toy, tmp_path / "val", "--split", "val", "--textures", str(scans), "--kinds",
                str(tmp_path / "kinds.json"), "--check") == 0
    out = capsys.readouterr().out
    report = json.loads(out[out.index("{"):])
    assert report["scenes"] == 2 and report["problemCount"] == 0
    manifest = json.loads((tmp_path / "val" / "manifest.json").read_text())
    assert manifest["split"] == "val" and manifest["textures"] == {"scans": 2, "surfaceLike": 1}
    assert manifest["kinds"]["dice"] == ["spell"] and manifest["settings"]["background"] == "mix"
    assert all(record["split"] == "val" for record in read_labels(tmp_path / "val"))
    assert make(toy, tmp_path / "train") == 0
    assert tree(tmp_path / "val")["labels.jsonl"] != tree(tmp_path / "train")["labels.jsonl"]


def test_the_card_size_sets_the_aspect_and_its_default_changes_nothing(toy, tmp_path, capsys):
    assert make(toy, tmp_path / "plain") == 0
    assert make(toy, tmp_path / "given", "--card-size", "63x88") == 0
    assert tree(tmp_path / "plain") == tree(tmp_path / "given")
    assert make(toy, tmp_path / "small", "--card-size", "59x86", "--check") == 0
    out = capsys.readouterr().out
    assert json.loads(out[out.rindex("\n{"):])["problemCount"] == 0
    manifest = json.loads((tmp_path / "small" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["parameters"]["cardAspect"] == 0.686
    assert tree(tmp_path / "small")["labels.jsonl"] != tree(tmp_path / "plain")["labels.jsonl"]


@pytest.mark.parametrize(("size", "message"), [("59", "as WxH"), ("59x86mm", "as WxH"), ("0x86", "positive"),
                                               ("88x63", "outside 0.5 to 1"), ("30x86", "outside 0.5 to 1")])
def test_a_card_size_that_is_not_a_card_is_refused(toy, tmp_path, capsys, size, message):
    assert make(toy, tmp_path / "out", "--card-size", size) == 1
    said = capsys.readouterr().err
    assert "cardvision make-composites: failed" in said and message in said
    assert not (tmp_path / "out").exists()


def test_make_composites_reports_what_is_wrong(toy, tmp_path, capsys):
    assert make(toy, tmp_path / "out") == 0
    capsys.readouterr()
    cases = [
        (make(toy, tmp_path / "out"), "already holds generated scenes"),
        (cli.main(["make-composites", "--catalog", str(toy[0]), "--art", str(tmp_path / "no-art"), "--out",
                   str(tmp_path / "x"), "--n", "1", "--seed", "1"]), "no such folder of card images"),
        (cli.main(["make-composites", "--catalog", str(tmp_path / "no.json"), "--art", str(toy[1]), "--out",
                   str(tmp_path / "x"), "--n", "1", "--seed", "1"]), "no.json"),
        (make(toy, tmp_path / "x", "--textures", str(tmp_path / "no-scans")), "fetch-textures"),
        (make(toy, tmp_path / "x", "--workers", "0"), "workers"),
    ]
    errors = capsys.readouterr().err
    for code, message in cases:
        assert code == 1 and message in errors
    assert not (tmp_path / "x" / "labels.jsonl").exists()
    assert make(toy, tmp_path / "out", "--overwrite") == 0
    with pytest.raises(SystemExit):
        make(toy, tmp_path / "y", "--split", "probe")  # the command offers train and val


def test_fetch_textures_through_the_command_line(tmp_path, capsys):
    site = Site()
    try:
        good, other = tiny_jpeg(11), tiny_jpeg(12)
        site.pages["/a.jpg"] = good
        index = tmp_path / "assets.json"
        index.write_text(json.dumps([asset("cloth", good, category="fabric", url=f"{site.base}/a.jpg")]))
        assert cli.main(["fetch-textures", "--index", str(index), "--out", str(tmp_path / "scans"), "--delay", "0"]) == 0
        assert "1 downloaded, 0 already there, 0 failed, of 1 scans" in capsys.readouterr().out
        assert (tmp_path / "scans/train/toy__cloth.jpg").read_bytes() == good
        index.write_text(json.dumps([asset("cloth", good, category="fabric", url=f"{site.base}/a.jpg"),
                                     asset("wall", other, category="plaster", url=f"{site.base}/missing.jpg")]))
        assert cli.main(["fetch-textures", "--index", str(index), "--out", str(tmp_path / "scans"), "--delay", "0"]) == 1
        said = capsys.readouterr()
        assert "0 downloaded, 1 already there, 1 failed, of 2 scans" in said.out and "toy wall" in said.err
        index.write_text(json.dumps([{"source": "toy", "assetId": "cloth", "license": "all rights reserved"}]))
        assert cli.main(["fetch-textures", "--index", str(index), "--out", str(tmp_path / "other")]) == 1
        assert "64 lower-case hex digits" in capsys.readouterr().err and not (tmp_path / "other").exists()
    finally:
        site.close()


def test_the_riftbound_kinds_settings_fit_the_riftbound_catalog():
    catalog_path = ROOT / "games" / "riftbound" / "catalog.json"
    assert not (ROOT / "games" / "riftbound" / "kinds.json").exists()   # the settings live in the catalog
    kinds = load_catalog(catalog_path).kinds
    # A catalog file also serves as a --kinds file: its "kinds" block is what is read.
    assert load_kinds(catalog_path) == kinds
    settings = KindSettings.from_kinds(kinds)
    assert settings.landscape == ("Battlefield",) and settings.dice == ("Legend",)
    assert settings.foil == {"Legend": 0.6, "Rune": 0.1}
    assert settings.board == {"leader": ("Legend",), "unit": ("Unit",), "attachment": ("Gear",), "resource": ("Rune",)}
    catalog = load_catalog(catalog_path)
    named = {*settings.landscape, *settings.dice, *settings.foil, *(k for names in settings.board.values() for k in names)}
    assert named <= {card.kind for card in catalog}
    # The same object is a valid "kinds" block of a catalog.
    document = json.loads(catalog_path.read_text(encoding="utf-8"))
    assert parse_catalog({**document, "kinds": kinds}).kinds == kinds
