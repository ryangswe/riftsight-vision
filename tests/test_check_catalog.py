# SPDX-License-Identifier: Apache-2.0
"""``cardvision check-catalog``."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

from cardvision import cli


def _catalog(tmp_path: Path, cards: list[dict], **extra) -> Path:
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps({"game": "toy", "locale": "en", "cards": cards, **extra}), encoding="utf-8")
    return path


def test_it_counts_the_cards_and_states_the_rule_and_game(tmp_path, capsys):
    path = _catalog(tmp_path, [{"id": "A", "name": "One", "art": "a.png"}, {"id": "B", "name": "Two", "art": None}])
    assert cli.main(["check-catalog", str(path)]) == 0
    assert capsys.readouterr().out.strip() == "2 cards (1 without art), identity rule: name, game: toy"


def test_a_bad_catalog_exits_1_with_the_loaders_message(tmp_path, capsys):
    path = _catalog(tmp_path, [{"id": "A", "name": "One"}, {"id": "A", "name": "Two"}])
    assert cli.main(["check-catalog", str(path)]) == 1
    err = capsys.readouterr().err
    assert "check-catalog: failed" in err and "A" in err and "import-catalog" in err


def test_a_missing_or_unparseable_file_exits_1(tmp_path, capsys):
    assert cli.main(["check-catalog", str(tmp_path / "none.json")]) == 1
    assert "check the path" in capsys.readouterr().err
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")
    assert cli.main(["check-catalog", str(bad)]) == 1
    assert "not valid JSON" in capsys.readouterr().err


def test_art_adds_the_image_listing(tmp_path, capsys):
    art = tmp_path / "art"
    art.mkdir()
    pixels = np.random.default_rng(0).integers(0, 256, (40, 40, 3), dtype=np.uint8)
    Image.fromarray(pixels).save(art / "a.png")
    path = _catalog(tmp_path, [{"id": "A", "name": "One", "art": "a.png"}, {"id": "B", "name": "Two", "art": "b.png"}])
    assert cli.main(["check-catalog", str(path), "--art", str(art)]) == 0
    out = capsys.readouterr().out
    assert "2 cards (0 without art)" in out and "(2 catalog cards; 1 with a usable image)" in out
    assert "1 with no image under --art" in out
