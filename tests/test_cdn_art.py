# SPDX-License-Identifier: Apache-2.0
"""``cardvision cdn``: card pictures (catalog, images, plan, upload order) and ``verify`` over a
fake public CDN."""

from __future__ import annotations

import hashlib
import json

import pytest

from cardvision.cdn import config as cdn_config
from cardvision.cdn.art import catalog_art_paths, execute, make_plan, read_live_index, scan_images
from cardvision.cdn.config import CONFIG_CACHE, CONFIG_KEY, PAGE_CACHE
from cardvision.cdn.settings import load_data_file, load_page
from cardvision.cdn.verify import verify
from support_cdn import BASE, EXAMPLE_SETTINGS, GEO_CONFIG, PANEL_CONFIG, FakeS3, no_urlopen, product, quiet, refused, store_get

pytestmark = pytest.mark.usefixtures("no_urlopen")

JPG = b"\xff\xd8\xff\xe0" + b"x" * 100
PNG = b"\x89PNG\r\n\x1a\n" + b"y" * 100
ART_CACHE = "public, max-age=86400"
INDEX_KEY = "art/index.json"
GOOD_HERE = EXAMPLE_SETTINGS | {"primary": {"id": "cdn", "template": BASE + "/art/{art}"}}


@pytest.fixture
def panel(tmp_path):
    return product(PANEL_CONFIG, tmp_path)


@pytest.fixture
def images(tmp_path):
    root = tmp_path / "images"
    (root / "jp").mkdir(parents=True)
    (root / "EX-001.jpg").write_bytes(JPG)
    (root / "jp" / "EX-002.png").write_bytes(PNG)
    (root / "fake.png").write_bytes(b"<html>not found</html>")
    (root / "png-named.jpg").write_bytes(PNG)
    (tmp_path / "outside.jpg").write_bytes(JPG)
    return root


PATHS = {"EX-001.jpg": ["EX-001"], "jp/EX-002.png": ["EX-002"]}


@pytest.mark.parametrize("shape", [
    [{"id": "EX-001", "art": "EX-001.jpg"}, {"id": "X", "art": None}],
    {"cards": [{"cardId": "EX-001", "art": "EX-001.jpg"}, {"cardId": "X", "art": None}]},
    {"cards": {"EX-001": {"art": "EX-001.jpg"}, "X": {"art": None}}},
])
def test_catalog_shapes(shape):
    paths, artless = catalog_art_paths(shape)
    assert paths == {"EX-001.jpg": ["EX-001"]} and artless == 1


@pytest.mark.parametrize("bad", ["../x.jpg", "/x.jpg", "a//b.jpg", "x.gif", "a\\b.jpg", ""])
def test_unclean_art_paths_are_refused(bad):
    assert refused(lambda: catalog_art_paths([{"id": "A", "art": bad}]))


def test_the_art_field_is_required_and_paths_may_be_shared():
    assert refused(lambda: catalog_art_paths([{"id": "A"}]))
    assert refused(lambda: catalog_art_paths("x"))
    shared, _ = catalog_art_paths([{"id": "A", "art": "s.png"}, {"id": "B", "art": "s.png"}])
    assert shared == {"s.png": ["A", "B"]}


def test_images_are_scanned_by_their_bytes(images, tmp_path):
    files = scan_images(PATHS, images, 5 * 1024 * 1024)
    assert [f.path for f in files] == ["EX-001.jpg", "jp/EX-002.png"]
    assert refused(lambda: scan_images({"missing.jpg": ["M"]}, images, 5 * 1024 * 1024))
    assert refused(lambda: scan_images({"fake.png": ["F"]}, images, 5 * 1024 * 1024)), "not an image"
    assert refused(lambda: scan_images(PATHS, images, 50)), "over the size limit"
    renamed = scan_images({"png-named.jpg": ["R"]}, images, 5 * 1024 * 1024)
    assert renamed[0].content_type == "image/png", "type comes from the bytes"
    assert make_plan(renamed, {}, 0, 1).mismatched == {".jpg holding image/png": 1}
    (images / "escape.jpg").symlink_to(tmp_path / "outside.jpg")
    assert refused(lambda: scan_images({"escape.jpg": ["E"]}, images, 5 * 1024 * 1024)), "symlink escape"


def test_a_renamed_image_is_served_with_the_type_of_its_bytes(panel, images):
    renamed = scan_images({"png-named.jpg": ["R"]}, images, 5 * 1024 * 1024)
    s3 = FakeS3()
    execute(panel, s3, "b", make_plan(renamed, {}, 0, 1), None, workers=1, log=quiet)
    assert s3.puts[0][:2] == ("art/png-named.jpg", "image/png")


def test_the_plan_is_additive(images):
    files = scan_images(PATHS, images, 5 * 1024 * 1024)
    live = {"schemaVersion": 1, "files": {
        "EX-001.jpg": {"sha256": files[0].sha256, "bytes": files[0].bytes},
        "jp/EX-002.png": {"sha256": "0" * 64, "bytes": 1},
        "OLD-001.jpg": {"sha256": "1" * 64, "bytes": 1}}}
    plan = make_plan(files, live, 0, 2)
    assert (len(plan.new), len(plan.changed), plan.unchanged, plan.live_only) == (0, 1, 1, 1)
    assert "OLD-001.jpg" in plan.index["files"], "uploads are additive"
    fresh = make_plan(files, {}, 0, 2)
    assert len(fresh.new) == 2 and fresh.live_only == 0


def test_the_index_time_stamp_comes_from_one_place(images, monkeypatch):
    monkeypatch.setattr(cdn_config, "utc_now", lambda: "2026-01-02T03:04:05Z")
    plan = make_plan(scan_images(PATHS, images, 5 * 1024 * 1024), {}, 0, 2)
    assert plan.index["updatedAt"] == "2026-01-02T03:04:05Z"


def test_images_then_index_then_config(panel, images):
    files = scan_images(PATHS, images, 5 * 1024 * 1024)
    cfg_bytes = json.dumps(GOOD_HERE).encode()
    s3 = FakeS3()
    assert execute(panel, s3, "b", make_plan(files, {}, 0, 2), cfg_bytes, workers=1, log=quiet) == 0
    keys = s3.put_keys
    assert set(keys[:2]) == {"art/EX-001.jpg", "art/jp/EX-002.png"}
    assert keys[2:] == [INDEX_KEY, CONFIG_KEY]
    assert {p[0]: (p[1], p[2]) for p in s3.puts}["art/jp/EX-002.png"] == ("image/png", ART_CACHE)
    assert s3.puts[-1][2] == CONFIG_CACHE and s3.puts[2][2] == "no-cache"
    index = json.loads(s3.puts[2][3])
    assert s3.puts[2][3] == json.dumps(index, indent=1).encode(), "the index is written with indent 1"


def test_no_config_after_a_failed_image(panel, images):
    files = scan_images(PATHS, images, 5 * 1024 * 1024)
    s3 = FakeS3(fail={"art/jp/EX-002.png"})
    assert execute(panel, s3, "b", make_plan(files, {}, 0, 2), b"{}", workers=1, log=quiet) == 1
    assert CONFIG_KEY not in s3.put_keys
    index = json.loads(next(p[3] for p in s3.puts if p[0] == INDEX_KEY))
    assert "jp/EX-002.png" not in index["files"] and "EX-001.jpg" in index["files"], "the index records what landed"


def test_nothing_changed_writes_only_the_index_and_config_alone_leaves_it(panel, images):
    files = scan_images(PATHS, images, 5 * 1024 * 1024)
    s3 = FakeS3()
    live = {"schemaVersion": 1, "files": {f.path: {"sha256": f.sha256, "bytes": f.bytes} for f in files}}
    assert execute(panel, s3, "b", make_plan(files, live, 0, 2), None, workers=1, log=quiet) == 0
    assert s3.put_keys == [INDEX_KEY]
    s3 = FakeS3()
    assert execute(panel, s3, "b", None, b"{}", log=quiet) == 0
    assert s3.put_keys == [CONFIG_KEY]


def test_the_live_index_is_read_or_refused(panel):
    assert read_live_index(panel, FakeS3(), "b") == {}
    good = {"schemaVersion": 1, "files": {}}
    assert read_live_index(panel, FakeS3({INDEX_KEY: (json.dumps(good).encode(), {})}), "b") == good
    assert refused(lambda: read_live_index(panel, FakeS3({INDEX_KEY: (b'{"files": []}', {})}), "b"))


def test_data_file_then_page_then_config(panel, tmp_path):
    doc = json.dumps({"schemaVersion": 1, "cards": {}}).encode()
    path = tmp_path / f"details-{hashlib.sha256(doc).hexdigest()[:8]}.json"
    path.write_bytes(doc)
    d = load_data_file(panel, path)
    pg = tmp_path / "privacy.html"
    pg.write_bytes(b"<!doctype html><p>x</p>")
    page = load_page(panel, pg)
    s3 = FakeS3()
    assert execute(panel, s3, "b", None, b"{}", log=quiet, data_files=[d], page=page) == 0
    assert s3.put_keys == [d.key, "privacy.html", CONFIG_KEY]
    assert s3.puts[0][1:3] == ("application/json", "public, max-age=31536000, immutable")
    assert s3.puts[1][1:3] == ("text/html; charset=utf-8", PAGE_CACHE)
    for fail in (d.key, "privacy.html"):
        s3 = FakeS3(fail={fail})
        assert execute(panel, s3, "b", None, b"{}", log=quiet, data_files=[d], page=page) == 1
        assert CONFIG_KEY not in s3.put_keys, f"no config after a failed {fail}"
    s3 = FakeS3()
    assert execute(panel, s3, "b", None, None, log=quiet, page=page) == 0 and s3.put_keys == ["privacy.html"]


# ---------------------------------------------------------------------------- verify

def _store(files, cfg_bytes, cors=True):
    head = {"content-type": "application/json", "cache-control": CONFIG_CACHE}
    if cors:
        head["access-control-allow-origin"] = "*"
    index_body = json.dumps({"schemaVersion": 1, "files": {f.path: {"sha256": f.sha256, "bytes": f.bytes,
                                                                    "contentType": f.content_type} for f in files}}).encode()
    return {
        CONFIG_KEY: (200, head, cfg_bytes),
        INDEX_KEY: (200, {"content-type": "application/json"}, index_body),
        "art/EX-001.jpg": (200, {"content-type": "image/jpeg", "cache-control": ART_CACHE}, JPG),
        "art/jp/EX-002.png": (200, {"content-type": "image/png", "cache-control": ART_CACHE}, PNG),
    }


@pytest.mark.parametrize("config", [PANEL_CONFIG, GEO_CONFIG])
def test_verify_reads_config_index_and_images(config, tmp_path, images, capsys):
    p = product(config, tmp_path)
    files = scan_images(PATHS, images, 5 * 1024 * 1024)
    cfg_bytes = json.dumps(GOOD_HERE | {"cardLink": None}).encode()
    store = _store(files, cfg_bytes)
    get = store_get(store)
    assert verify(p, BASE, 5, get=get) == 0
    good = store[CONFIG_KEY]
    store[CONFIG_KEY] = (200, {**good[1], "nel": '{"report_to":"cf-nel"}', "report-to": "{}"}, cfg_bytes)
    assert verify(p, BASE, 5, get=get) == 1, "NEL/Report-To on the zone"
    store[CONFIG_KEY] = good
    store["art/jp/EX-002.png"] = (200, {"content-type": "image/png", "cache-control": ART_CACHE}, PNG + b"!")
    assert verify(p, BASE, 5, get=get) == 1, "sha mismatch"
    store[CONFIG_KEY] = _store(files, cfg_bytes, cors=False)[CONFIG_KEY]
    assert verify(p, BASE, 5, get=get) == 2, "missing CORS"
    assert verify(p, BASE, 5, get=lambda url, origin=None: (0, {"x-error": "gaierror: no such host"}, b"")) == 1
    out = capsys.readouterr().out
    assert "cannot reach cdn.example.org" in out


def test_verify_asks_with_the_product_origin_and_cache_busts(tmp_path, images):
    p = product({**PANEL_CONFIG, "settings": {"corsOrigin": "https://www.example.net", "obsoleteCardLink": False}}, tmp_path)
    files = scan_images(PATHS, images, 5 * 1024 * 1024)
    store = _store(files, json.dumps(GOOD_HERE).encode(), cors=False)
    store[CONFIG_KEY][1]["access-control-allow-origin"] = "https://www.example.net"
    seen = []
    inner = store_get(store)

    def get(url, origin=None, **k):
        seen.append((url, origin))
        return inner(url, origin=origin, **k)
    assert verify(p, BASE, 5, get=get) == 0
    assert seen[0][1] == "https://www.example.net"
    assert all("?cb=" in url for url, _ in seen), "never a bare public URL"


def test_verify_checks_the_named_data_file_and_the_pages(panel, tmp_path, capsys):
    doc = json.dumps({"schemaVersion": 1, "cards": {"1": ["x"]}}).encode()
    path = tmp_path / f"details-{hashlib.sha256(doc).hexdigest()[:8]}.json"
    path.write_bytes(doc)
    d = load_data_file(panel, path)
    cfg_named = json.dumps(GOOD_HERE | {"details": d.entry}).encode()
    store = {CONFIG_KEY: (200, {"content-type": "application/json", "cache-control": CONFIG_CACHE,
                                "access-control-allow-origin": "*"}, cfg_named),
             INDEX_KEY: (200, {"content-type": "application/json"}, json.dumps({"schemaVersion": 1, "files": {}}).encode()),
             d.key: (200, {"content-type": "application/json", "cache-control": "public, max-age=31536000, immutable"}, doc)}
    get = store_get(store)
    assert verify(panel, BASE, 0, get=get) == 0
    assert "note privacy.html: not on the CDN" in capsys.readouterr().out
    store["privacy.html"] = (200, {"content-type": "text/html; charset=utf-8", "cache-control": PAGE_CACHE}, b"<!doctype html>")
    assert verify(panel, BASE, 0, get=get) == 0
    store["privacy.html"] = (200, {"content-type": "text/html", "cache-control": "no-cache"}, b"<!doctype html>")
    assert verify(panel, BASE, 0, get=get) == 1, "a page with the wrong caching"
    del store["privacy.html"]
    store[d.key] = (200, store[d.key][1], doc + b" ")
    assert verify(panel, BASE, 0, get=get) == 1, "data file sha mismatch"
    del store[d.key]
    assert verify(panel, BASE, 0, get=get) == 1, "data file named but missing"
