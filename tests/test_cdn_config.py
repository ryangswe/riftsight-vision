# SPDX-License-Identifier: Apache-2.0
"""``cardvision cdn``: a product's cdn.config.json, the command's arguments, and what the package
imports (no boto3, no network)."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import pytest

from cardvision.cdn import commands
from cardvision.cdn.config import (
    CdnConfigError,
    DEFAULT_CONFIG_PATH,
    cdn_config_from_dict,
    load_cdn_config,
)
from support_cdn import GEO_CONFIG, PANEL_CONFIG, product

ROOT = Path(__file__).resolve().parents[1]


MINIMAL = {"schemaVersion": 1, "product": "example", "envPrefix": "EXAMPLECDN", "forbiddenWords": [], "dataFiles": {},
           "pages": [], "geometric": False, "settings": {"obsoleteCardLink": False}}


def test_the_defaults_are_todays_values(tmp_path):
    p = product(MINIMAL, tmp_path)
    assert (p.art_prefix, p.index_key, p.art_cache, p.max_image_bytes) == (
        "art/", "art/index.json", "public, max-age=86400", 5 * 1024 * 1024)
    assert p.placeholders == ("{art}", "{file}", "{cardId}", "{printedId}") 
    assert p.cors_origin == "https://www.youtube.com" and not p.obsolete_card_link
    assert p.data_files == () and p.pages == () and p.geometric is False and p.forbidden_words == ()
    assert p.releases_prefix == "vision/releases/" and p.releases_index_key == "vision/releases/index.json"
    assert p.legal_dir == tmp_path / "release-legal" and p.runtimes_path == tmp_path / "cdn" / "RUNTIMES.json"
    assert p.bundled_document == tmp_path / "dist" / "release" / "release.json" and p.max_document_bytes == 262144
    assert p.verify_script == tmp_path / "vendor" / "cardvision-browser" / "node" / "verify-release.mjs"
    assert p.user_agent == "example-cdn-verify/1" and p.node_user_agent == "example-cdn-verify/1"


def test_the_environment_names_come_from_the_prefix(tmp_path):
    p = product(PANEL_CONFIG, tmp_path)
    assert p.env_keys == ("EXAMPLECDN_R2_ACCOUNT_ID", "EXAMPLECDN_R2_ACCESS_KEY_ID", "EXAMPLECDN_R2_SECRET_ACCESS_KEY",
                          "EXAMPLECDN_BUCKET", "EXAMPLECDN_PUBLIC_BASE")
    assert p.env("EXTENSION_IDS") == "EXAMPLECDN_EXTENSION_IDS"


def test_a_data_file_kind_is_read(tmp_path):
    p = product(PANEL_CONFIG, tmp_path)
    (kind,) = p.data_files
    assert (kind.name, kind.prefix, kind.schema_version, kind.required_object_keys) == ("details", "data/", 1, ("cards",))
    assert kind.name_regex.match("details-0a1b2c3d.json") and not kind.name_regex.match("details-0A1B2C3D.json")
    assert not kind.name_regex.match("details.json") and not kind.name_regex.match("xdetails-0a1b2c3d.json")
    assert kind.cache_control == "public, max-age=31536000, immutable"


def test_the_config_file_sits_in_the_repository_cdn_folder(tmp_path):
    (tmp_path / "cdn").mkdir()
    (tmp_path / "cdn" / "cdn.config.json").write_text(json.dumps(GEO_CONFIG))
    p = load_cdn_config(tmp_path / "cdn" / "cdn.config.json")
    assert p.root == tmp_path.resolve() and p.geometric and p.user_agent == "example-geo-verify/1"
    assert DEFAULT_CONFIG_PATH == Path("cdn") / "cdn.config.json"
    with pytest.raises(CdnConfigError, match="no such file"):
        load_cdn_config(tmp_path / "missing.json")
    (tmp_path / "bad.json").write_text("{")
    with pytest.raises(CdnConfigError, match="not JSON"):
        load_cdn_config(tmp_path / "bad.json")


@pytest.mark.parametrize("change", [
    {"schemaVersion": 2},
    {"schemaVersion": True},
    {"product": "Example"},
    {"product": ""},
    {"envPrefix": "example"},
    {"envPrefix": "R2"},
    {"envPrefix": "EXAMPLE_CDN"},
    {"unknownSwitch": True},
    {"art": {"prefixx": "art/"}},
    {"art": {"prefix": "art"}},
    {"art": {"prefix": "../art/"}},
    {"art": {"maxImageBytes": 0}},
    {"settings": {"obsoleteCardLink": "yes"}},
    {"settings": {"obsoleteCardLink": False, "primaryOnCdn": False}},
    {"releases": {"maxDocumentBytes": 100}},
    {"releases": {"maxDocumentBytes": 262144}},
    {"releases": {"prefix": "other/releases/"}},
    {"releases": {"prefix": "vision/releases/"}},
    {"settings": {"placeholders": ["art"]}},
    {"settings": {"corsOrigin": "http://www.example.org"}},
    {"forbiddenWords": ["UPPER"]},
    {"forbiddenWords": "otherproject"},
    {"dataFiles": {"release": {"namePattern": "r-<sha8>.json"}}},
    {"dataFiles": {"details": {"namePattern": "details.json"}}},
    {"dataFiles": {"details": {"namePattern": "details-<sha8>.txt"}}},
    {"dataFiles": {"details": {"namePattern": "sub/details-<sha8>.json"}}},
    {"dataFiles": {"details": {"namePattern": "d-<sha8>.json", "cache": "x"}}},
    {"dataFiles": {"a": {"namePattern": "d-<sha8>.json"}, "b": {"namePattern": "d-<sha8>.json"}}},
    {"pages": ["../privacy.html"]},
    {"pages": ["privacy.txt"]},
    {"geometric": "yes"},
    {"releases": {"legalDir": "/abs/legal"}},
    {"releases": {"runtimes": "../RUNTIMES.json"}},
    {"runtime": {"verifyScript": "../x.mjs"}},
])
def test_a_malformed_config_is_refused(tmp_path, change):
    raw = {**PANEL_CONFIG, **change}
    with pytest.raises(CdnConfigError):
        cdn_config_from_dict(raw, tmp_path)


@pytest.mark.parametrize("key", ["product", "envPrefix", "forbiddenWords", "dataFiles", "pages", "geometric", "settings"])
def test_a_key_that_switches_a_check_is_required(tmp_path, key):
    raw = {k: v for k, v in MINIMAL.items() if k != key}
    with pytest.raises(CdnConfigError, match="required key"):
        cdn_config_from_dict(raw, tmp_path)


def test_the_card_link_switch_is_required_inside_settings(tmp_path):
    with pytest.raises(CdnConfigError, match=r"required key\(s\) missing: settings.obsoleteCardLink"):
        cdn_config_from_dict({**MINIMAL, "settings": {"corsOrigin": "https://www.example.net"}}, tmp_path)


def test_a_product_config_without_data_files_is_refused_at_load(tmp_path, capsys):
    """Leaving dataFiles out must not turn the data-file gate off: the command refuses before it
    reads anything else (exit 3)."""
    raw = {k: v for k, v in PANEL_CONFIG.items() if k != "dataFiles"}
    (tmp_path / "cdn").mkdir()
    (tmp_path / "cdn" / "cdn.config.json").write_text(json.dumps(raw))
    parser = argparse.ArgumentParser()
    commands.add_arguments(parser)
    args = parser.parse_args(["publish", "--cdn-config", str(tmp_path / "cdn" / "cdn.config.json"), "--config", "x.json"])
    assert commands.run(args) == 3
    assert "required key(s) missing: dataFiles" in capsys.readouterr().err


def test_a_comment_is_allowed(tmp_path):
    p = product({**PANEL_CONFIG, "$comment": "notes", "art": {"$comment": "x"}}, tmp_path)
    assert p.product == "examplepanel"


def test_the_command_lists_its_actions_and_registers_like_the_others():
    parser = argparse.ArgumentParser(prog="cardvision")
    sub = parser.add_subparsers(dest="command")
    for name, (summary, add_arguments, run) in commands.COMMANDS.items():
        child = sub.add_parser(name, help=summary, description=summary)
        add_arguments(child)
        child.set_defaults(_run=run)
    assert set(commands.COMMANDS) == {"cdn"}
    usage = sub.choices["cdn"].format_help()
    for action in ("plan", "publish", "verify", "publish-geo", "verify-geo", "publish-release", "verify-release-live"):
        assert action in usage
    assert "selftest" not in usage
    args = parser.parse_args(["cdn", "publish", "--data-file", "a.json", "--data-file", "b.json", "--dry-run"])
    assert args.data_files == ["a.json", "b.json"] and args.dry_run and args._run is commands.run


def test_a_missing_product_config_is_a_refusal(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    parser = argparse.ArgumentParser()
    commands.add_arguments(parser)
    assert commands.run(parser.parse_args(["verify"])) == 3
    assert "REFUSED" in capsys.readouterr().err


def test_geo_actions_are_refused_without_the_stage(tmp_path, capsys):
    (tmp_path / "cdn").mkdir()
    (tmp_path / "cdn" / "cdn.config.json").write_text(json.dumps(PANEL_CONFIG))
    parser = argparse.ArgumentParser()
    commands.add_arguments(parser)
    args = parser.parse_args(["publish-geo", "--cdn-config", str(tmp_path / "cdn" / "cdn.config.json"), "--dir", "x"])
    assert commands.run(args) == 3
    assert "no geometric stage" in capsys.readouterr().err


def test_importing_the_package_imports_no_boto3_and_opens_nothing():
    code = ("import sys, urllib.request\n"
            "urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(AssertionError('network'))\n"
            "import cardvision.cdn, cardvision.cdn.commands, cardvision.cdn.publish, cardvision.cdn.verify, "
            "cardvision.cdn.geo, cardvision.cdn.art, cardvision.cdn.release, cardvision.cdn.settings, "
            "cardvision.cdn.target, cardvision.cdn.node, cardvision.cdn.config\n"
            "assert 'boto3' not in sys.modules and 'botocore' not in sys.modules, 'boto3 imported'\n")
    subprocess.run([sys.executable, "-c", code], check=True, cwd=ROOT)


def test_the_cdn_extra_names_boto3():
    text = (ROOT / "pyproject.toml").read_text()
    assert 'cdn = [\n    "boto3>=1.34",\n]' in text
