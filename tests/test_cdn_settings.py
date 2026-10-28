# SPDX-License-Identifier: Apache-2.0
"""``cardvision cdn``: the config.json contract, data files, pages and the release pointer."""

from __future__ import annotations

import hashlib
import json

import pytest

from cardvision.cdn.settings import (
    data_config_problem,
    load_config,
    load_data_file,
    load_data_files,
    load_page,
    release_pointer_problems,
    serialize_config,
    validate_config,
)
from support_cdn import BASE, EXAMPLE_SETTINGS, GEO_CONFIG, PANEL_CONFIG, RID, product, refused

GOOD = EXAMPLE_SETTINGS
OK_PTR = {"id": RID, "path": f"vision/releases/{RID}/release.json", "sha256": "a" * 64, "minimumExtensionVersion": "0.3.0"}
GEO_PTR = {"path": f"vision/releases/{RID}/geometric.json", "sha256": "b" * 64, "manifestSha256": "c" * 64}


@pytest.fixture
def panel(tmp_path):
    return product(PANEL_CONFIG, tmp_path)


@pytest.fixture
def geo(tmp_path):
    return product(GEO_CONFIG, tmp_path)


@pytest.mark.parametrize("which", ["panel", "geo"])
def test_the_example_settings_are_valid(request, which):
    p = request.getfixturevalue(which)
    assert validate_config(p, GOOD, None) == []
    assert validate_config(p, GOOD, BASE) == []
    assert validate_config(p, GOOD, "https://other.example.org"), "primary must be on our base"
    assert validate_config(p, GOOD | {"primary": None, "namesOnly": True, "fallbacks": [], "cardLink": None}, BASE) == []
    no_primary = dict(GOOD)
    del no_primary["primary"]
    assert validate_config(p, no_primary, None), "primary required"


@pytest.mark.parametrize("which", ["panel", "geo"])
@pytest.mark.parametrize("mutate", [
    {"schemaVersion": 2}, {"schemaVersion": True}, {"namesOnly": "no"}, {"updatedAt": 1},
    {"fallbacks": None}, {"fallbacks": [{"id": "c", "template": "http://x/{cardId}"}]},
    {"fallbacks": [{"id": "c", "template": "https://x/{name}"}]},
    {"fallbacks": [{"id": "c", "template": "https://assets.otherproject.example/{cardId}"}]},
    {"fallbacks": [{"id": "c", "template": "HTTP://Assets.OtherProject.example/{cardId}"}]},
    {"primary": {"template": "https://x/{art}"}},
    {"primary": {"id": "cdn", "template": "https://cdn.example.org/art/{sourceFile}"}},
    {"release": {**OK_PTR, "path": "x"}},
])
def test_a_broken_config_is_refused(request, which, mutate):
    p = request.getfixturevalue(which)
    assert validate_config(p, GOOD | {"cardLink": None} | mutate, None), mutate


def test_source_file_is_a_fallback_placeholder_only(panel, geo):
    fallback = {"fallbacks": [{"id": "src", "template": "https://images.example.net/{sourceFile}"}], "cardLink": None}
    assert validate_config(geo, GOOD | fallback, BASE) == []
    assert validate_config(panel, GOOD | fallback, BASE), "not a placeholder of this product"
    errs = validate_config(geo, GOOD | {"primary": {"id": "cdn", "template": BASE + "/art/{sourceFile}"}}, BASE)
    assert any("cannot use {sourceFile}" in e for e in errs)


def test_the_obsolete_card_link_warns_but_another_project_refuses(geo, panel):
    assert validate_config(geo, GOOD | {"cardLink": "https://x.example/?q={printedId}"}, None) == []
    warned: list[str] = []
    assert validate_config(geo, GOOD, None, warned) == [] and warned, "absent: a warning, not a refusal"
    warned = []
    assert validate_config(geo, GOOD | {"cardLink": "http://x.example/{cardId}"}, None, warned) == [] and warned
    for foreign in ("https://assets.otherproject.example/{cardId}", "http://assets.otherproject.example/{cardId}",
                    "HTTPS://Assets.OtherProject.example/{cardId}"):
        assert validate_config(geo, GOOD | {"cardLink": foreign}, None, []), foreign
    warned = []
    assert validate_config(panel, GOOD | {"cardLink": "anything"}, None, warned) == [] and not warned, "not checked"


def test_the_geometric_switch_is_checked_only_with_the_stage(geo, panel):
    for value in (True, False, None):
        assert validate_config(geo, GOOD | {"geometric": value, "cardLink": None}, None) == [], value
    for value in ("false", 0, 1, {}):
        assert validate_config(geo, GOOD | {"geometric": value, "cardLink": None}, None), value
    assert validate_config(panel, GOOD | {"geometric": "false"}, None) == []


def test_load_config_prints_warnings_and_refuses_errors(geo, tmp_path, capsys):
    f = tmp_path / "config.json"
    f.write_text(json.dumps(GOOD))
    assert load_config(geo, f, BASE) == f.read_bytes()
    assert "warning: config: cardLink is absent" in capsys.readouterr().err
    f.write_text(json.dumps(GOOD | {"namesOnly": "x"}))
    assert refused(lambda: load_config(geo, f, BASE))
    f.write_text("{")
    assert refused(lambda: load_config(geo, f, BASE))


def test_release_pointer_rules(panel, geo):
    for p in (panel, geo):
        assert release_pointer_problems(p, None) == [] and release_pointer_problems(p, OK_PTR) == []
        for bad in ({**OK_PTR, "path": f"vision/releases/{RID}/../x/release.json"}, {**OK_PTR, "id": "ABC"},
                    {**OK_PTR, "sha256": "x"}, {k: v for k, v in OK_PTR.items() if k != "minimumExtensionVersion"},
                    {**OK_PTR, "maximumExtensionVersion": "1"}, {**OK_PTR, "geometric": {}}, [OK_PTR]):
            assert release_pointer_problems(p, bad), bad
        assert not validate_config(p, {**GOOD, "cardLink": None, "release": OK_PTR}, None)
    assert release_pointer_problems(geo, {**OK_PTR, "geometric": GEO_PTR}) == []
    assert release_pointer_problems(geo, {**OK_PTR, "geometric": None}) == []
    for bad_geo in ({**GEO_PTR, "path": "vision/releases/ffffffffffffffff/geometric.json"}, {**GEO_PTR, "sha256": "B" * 64},
                    {k: v for k, v in GEO_PTR.items() if k != "manifestSha256"}, "x"):
        assert release_pointer_problems(geo, {**OK_PTR, "geometric": bad_geo}), bad_geo
    # Without the stage, any geometric field is refused, even null.
    assert release_pointer_problems(panel, {**OK_PTR, "geometric": GEO_PTR})
    assert release_pointer_problems(panel, {**OK_PTR, "geometric": None})


def test_the_serializer_is_byte_stable():
    cfg = {"schemaVersion": 1, "namesOnly": False, "note": "café", "release": {"id": RID, "path": "p", "sha256": "s",
                                                                              "minimumExtensionVersion": "0.3.0"}}
    assert serialize_config(cfg) == (json.dumps(cfg, indent=2) + "\n").encode()
    assert b"caf\\u00e9" in serialize_config(cfg) and serialize_config(cfg).endswith(b"}\n")


# ---------------------------------------------------------------------------- data files

def _details(tmp_path, doc: dict, name: str | None = None):
    data = json.dumps(doc).encode()
    sha = hashlib.sha256(data).hexdigest()
    path = tmp_path / (name or f"details-{sha[:8]}.json")
    path.write_bytes(data)
    return path, data, sha


def test_a_data_file_is_named_after_its_contents(panel, tmp_path):
    path, data, sha = _details(tmp_path, {"schemaVersion": 1, "cards": {"1": ["spell", "Invented text."]}})
    d = load_data_file(panel, path)
    assert (d.key, d.sha256, d.entries, d.kind.name) == (f"data/{path.name}", sha, 1, "details")
    assert d.entry == {"path": f"data/{path.name}", "sha256": sha}
    wrong, _, _ = _details(tmp_path, {"schemaVersion": 1, "cards": {}}, "details-00000000.json")
    assert refused(lambda: load_data_file(panel, wrong)), "the name must match the contents"
    plain, _, _ = _details(tmp_path, {"schemaVersion": 1, "cards": {}}, "details.json")
    assert refused(lambda: load_data_file(panel, plain)), "a versioned name is required"
    v2, _, _ = _details(tmp_path, {"schemaVersion": 2, "cards": {}})
    assert refused(lambda: load_data_file(panel, v2)), "schema version"
    vb, _, _ = _details(tmp_path, {"schemaVersion": True, "cards": {}})
    assert refused(lambda: load_data_file(panel, vb)), "a boolean is not 1"
    nocards, _, _ = _details(tmp_path, {"schemaVersion": 1, "cards": []})
    assert refused(lambda: load_data_file(panel, nocards)), "cards is an object"


def test_a_product_without_data_files_refuses_one(geo, tmp_path):
    path, _, _ = _details(tmp_path, {"schemaVersion": 1, "cards": {}})
    assert refused(lambda: load_data_file(geo, path))


def test_a_data_file_over_its_limit_is_refused(tmp_path):
    p = product({**PANEL_CONFIG, "dataFiles": {"details": {**PANEL_CONFIG["dataFiles"]["details"], "maxBytes": 10}}}, tmp_path)
    path, _, _ = _details(tmp_path, {"schemaVersion": 1, "cards": {}})
    assert refused(lambda: load_data_file(p, path))


def test_two_files_of_one_kind_are_refused(panel, tmp_path):
    a, _, _ = _details(tmp_path, {"schemaVersion": 1, "cards": {}})
    b, _, _ = _details(tmp_path, {"schemaVersion": 1, "cards": {"x": []}})
    assert refused(lambda: load_data_files(panel, [a, b]))
    assert [d.kind.name for d in load_data_files(panel, [a])] == ["details"]


def test_the_config_must_name_the_data_file_it_is_published_with(panel, tmp_path):
    path, _, sha = _details(tmp_path, {"schemaVersion": 1, "cards": {}})
    d = load_data_file(panel, path)
    named = GOOD | {"details": d.entry}
    assert validate_config(panel, named, BASE) == []
    for wrong in ({"path": "../x.json", "sha256": sha}, {"path": "/data/x.json", "sha256": sha},
                  {"path": "data/x.json", "sha256": "ABC"}, {"path": "data/x.js", "sha256": sha}, "data/x.json"):
        assert validate_config(panel, GOOD | {"details": wrong}, BASE), wrong
    assert data_config_problem(panel, json.dumps(named).encode(), [d]) is None
    assert data_config_problem(panel, json.dumps(GOOD).encode(), [d]), "the config must name the file"
    assert data_config_problem(panel, json.dumps(GOOD | {"details": {**d.entry, "sha256": "0" * 64}}).encode(), [d])
    assert data_config_problem(panel, None, [d]) is None


# ---------------------------------------------------------------------------- pages

def test_pages_are_listed_plain_html(panel, geo, tmp_path):
    good = b"<!doctype html>\n<html><body><h1>Privacy</h1></body></html>\n"
    pg = tmp_path / "privacy.html"
    pg.write_bytes(good)
    page = load_page(panel, pg)
    assert (page.key, page.sha256) == ("privacy.html", hashlib.sha256(good).hexdigest())
    assert refused(lambda: load_page(geo, pg)), "a product without pages"
    other = tmp_path / "index.html"
    other.write_bytes(good)
    assert refused(lambda: load_page(panel, other)), "only the listed page names"
    for bad in (b"<!doctype html><script>x()</script>", b"<!doctype html><a href='javascript:x()'>a</a>",
                b"<!doctype html><body onload=x()>", b"{\"not\": \"html\"}"):
        pg.write_bytes(bad)
        assert refused(lambda: load_page(panel, pg)), bad
