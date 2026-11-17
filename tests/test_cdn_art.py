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


# ---------------------------------------------------------------------------- derived art sets

import io  # noqa: E402

from PIL import Image  # noqa: E402

from cardvision.cdn.derived import derive_webp, derived_switch_problem, plan_derived, read_live_derived  # noqa: E402

TOOLTIP = {"name": "tooltip", "width": 640, "format": "webp", "quality": 75}
TOOLTIP_PATH = "art/tooltip/AB-001.webp"
TOOLTIP_INDEX = "art/tooltip/index.json"


def encode(img: Image.Image, fmt: str, **kw) -> bytes:
    out = io.BytesIO()
    img.save(out, fmt, **kw)
    return out.getvalue()


def gradient(w: int, h: int, mode: str = "RGB") -> Image.Image:
    img = Image.new(mode, (w, h))
    img.putdata([(x * 7 % 256, y * 3 % 256, (x + y) % 256) + ((200,) if mode == "RGBA" else ()) for y in range(h) for x in range(w)])
    return img


def webp_of(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


def derived_product(tmp_path, *sets):
    return product({**PANEL_CONFIG, "art": {"derived": list(sets or [TOOLTIP])}}, tmp_path)


def card_images(tmp_path, specs: dict) -> tuple:
    """Images for cards AB-001...: {card: (width, height)} -> (folder, catalog entries)."""
    root = tmp_path / "pictures"
    root.mkdir(exist_ok=True)
    catalog = []
    for card, (w, h) in specs.items():
        (root / f"{card}.jpg").write_bytes(encode(gradient(w, h), "JPEG"))
        catalog.append({"id": card, "art": f"{card}.jpg"})
    return root, catalog


def scan(root, catalog):
    paths, _ = catalog_art_paths(catalog)
    return scan_images(paths, root, 5 * 1024 * 1024)


def test_a_derived_picture_is_the_exact_width_and_keeps_its_proportions():
    out = webp_of(derive_webp(encode(gradient(1000, 1400), "JPEG"), 640, 75))
    assert out.format == "WEBP" and out.size == (640, 896)


def test_a_narrower_source_is_never_enlarged():
    assert webp_of(derive_webp(encode(gradient(300, 420), "PNG"), 640, 75)).size == (300, 420)


def test_width_null_keeps_each_sources_own_size():
    assert webp_of(derive_webp(encode(gradient(1200, 1680), "PNG"), None, 75)).size == (1200, 1680)


def test_alpha_is_kept_for_an_rgba_png_and_for_a_palette_png_with_transparency():
    rgba = gradient(200, 280, "RGBA")
    rgba.paste((255, 0, 0, 0), (0, 0, 40, 40))  # the rounded-corner kind of transparency
    out = webp_of(derive_webp(encode(rgba, "PNG"), 100, 75))
    assert out.mode == "RGBA" and out.getpixel((0, 0))[3] == 0
    palette = gradient(200, 280).convert("P", palette=Image.Palette.ADAPTIVE, colors=64)
    palette.paste(0, (0, 0, 40, 40))
    data = encode(palette, "PNG", transparency=0)
    assert Image.open(io.BytesIO(data)).mode == "P" and "transparency" in Image.open(io.BytesIO(data)).info
    out = webp_of(derive_webp(data, None, 75))
    assert out.mode == "RGBA" and out.getpixel((0, 0))[3] == 0 and out.getpixel((150, 200))[3] == 255


def test_a_picture_without_alpha_stays_opaque_rgb_and_a_turned_jpeg_is_turned_upright():
    img = gradient(100, 64)
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees to view
    data = encode(img, "JPEG", exif=exif.tobytes())
    out = webp_of(derive_webp(data, None, 75))
    assert out.mode == "RGB" and out.size == (64, 100)


def test_deriving_twice_gives_the_same_bytes():
    src = encode(gradient(900, 1260), "JPEG")
    assert derive_webp(src, 640, 75) == derive_webp(src, 640, 75)


def test_the_plan_lists_each_card_once_and_reads_nothing_from_the_cdn_when_offline(tmp_path):
    root, catalog = card_images(tmp_path, {"AB-001": (800, 1120), "AB-002": (700, 980)})
    catalog.append({"id": "AB-003", "art": "AB-001.jpg"})  # a card that shares art gets its own file
    catalog.append({"id": "AB-004", "art": None})
    p = derived_product(tmp_path)
    plans = plan_derived(p, scan(root, catalog), lambda spec: {})
    assert [d.key for d in plans[0].new] == ["art/tooltip/AB-001.webp", "art/tooltip/AB-002.webp", "art/tooltip/AB-003.webp"]
    assert plans[0].index_key == TOOLTIP_INDEX and not plans[0].changed and plans[0].unchanged == 0


def run(p, files, s3, config=None, **k):
    plan = make_plan(files, read_live_index(p, s3, "b"), 0, len(files))
    plan.derived = plan_derived(p, files, lambda spec: read_live_derived(p, spec, s3, "b"))
    return plan, execute(p, s3, "b", plan, config, workers=1, log=quiet, **k)


def derived_index_of(s3) -> dict:
    return json.loads(s3.objects[TOOLTIP_INDEX]["Body"])


def test_full_images_then_derived_images_then_the_indexes_then_config(tmp_path):
    root, catalog = card_images(tmp_path, {"AB-001": (800, 1120), "AB-002": (700, 980)})
    p = derived_product(tmp_path)
    s3 = FakeS3()
    _, failed = run(p, scan(root, catalog), s3, config=b"{}")
    assert failed == 0
    assert s3.put_keys == ["art/AB-001.jpg", "art/AB-002.jpg", "art/tooltip/AB-001.webp", "art/tooltip/AB-002.webp",
                           INDEX_KEY, TOOLTIP_INDEX, CONFIG_KEY]
    by_key = {k: (t, c) for k, t, c, _ in s3.puts}
    assert by_key["art/tooltip/AB-001.webp"] == ("image/webp", ART_CACHE) and by_key[TOOLTIP_INDEX][1] == "no-cache"
    idx = derived_index_of(s3)
    assert idx["spec"] == TOOLTIP and idx["specHash"] == p.derived[0].spec_hash and idx["schemaVersion"] == 1
    rec = idx["files"][TOOLTIP_PATH]
    body = s3.objects[TOOLTIP_PATH]["Body"]
    src = scan(root, catalog)[0]
    assert rec == {"sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body), "contentType": "image/webp",
                   "cardId": "AB-001", "sourceSha256": src.sha256}
    assert webp_of(body).size == (640, 896)
    assert "tooltip" not in json.dumps(json.loads(s3.objects[INDEX_KEY]["Body"])), "art/index.json is unchanged in shape"


def test_a_changed_source_redoes_that_card_only(tmp_path):
    root, catalog = card_images(tmp_path, {"AB-001": (800, 1120), "AB-002": (700, 980)})
    p = derived_product(tmp_path)
    s3 = FakeS3()
    run(p, scan(root, catalog), s3)
    (root / "AB-002.jpg").write_bytes(encode(gradient(700, 980).transpose(Image.Transpose.FLIP_LEFT_RIGHT), "JPEG"))
    plan, _ = run(p, scan(root, catalog), s3)
    assert [d.key for d in plan.derived[0].changed] == ["art/tooltip/AB-002.webp"] and not plan.derived[0].new
    assert plan.derived[0].unchanged == 1
    s3.puts.clear()
    run(p, scan(root, catalog), s3)
    assert [k for k in s3.put_keys if k.endswith(".webp")] == [], "nothing changed: no derived upload"


def test_a_spec_change_redoes_every_card_and_lists_only_what_lands(tmp_path):
    root, catalog = card_images(tmp_path, {"AB-001": (800, 1120), "AB-002": (700, 980)})
    s3 = FakeS3()
    run(derived_product(tmp_path), scan(root, catalog), s3)
    narrower = derived_product(tmp_path, {**TOOLTIP, "width": 320})
    plan = plan_derived(narrower, scan(root, catalog), lambda spec: read_live_derived(narrower, spec, s3, "b"))[0]
    assert plan.respec and len(plan.changed) == 2 and not plan.new and plan.unchanged == 0
    s3.fail = {"art/tooltip/AB-002.webp"}
    run(narrower, scan(root, catalog), s3)
    idx = derived_index_of(s3)
    assert idx["specHash"] == narrower.derived[0].spec_hash
    assert list(idx["files"]) == [TOOLTIP_PATH], "the card that did not land is not listed at the new spec"
    assert webp_of(s3.objects[TOOLTIP_PATH]["Body"]).size == (320, 448)
    s3.fail = set()
    run(narrower, scan(root, catalog), s3)
    assert sorted(derived_index_of(s3)["files"]) == [TOOLTIP_PATH, "art/tooltip/AB-002.webp"]


def test_a_pillow_only_change_redoes_nothing(tmp_path, monkeypatch):
    root, catalog = card_images(tmp_path, {"AB-001": (800, 1120)})
    p = derived_product(tmp_path)
    s3 = FakeS3()
    run(p, scan(root, catalog), s3)
    import cardvision.cdn.derived as derived_mod
    monkeypatch.setattr(derived_mod, "derive_webp", lambda *a, **k: b"RIFF....WEBPdifferent bytes")
    plan, _ = run(p, scan(root, catalog), s3)
    assert not plan.derived[0].todo and plan.derived[0].unchanged == 1


def test_a_failed_derived_upload_stays_out_of_the_index_and_holds_back_config(tmp_path):
    root, catalog = card_images(tmp_path, {"AB-001": (800, 1120), "AB-002": (700, 980)})
    p = derived_product(tmp_path)
    s3 = FakeS3(fail={"art/tooltip/AB-002.webp"})
    _, failed = run(p, scan(root, catalog), s3, config=b"{}")
    assert failed == 1 and CONFIG_KEY not in s3.put_keys
    assert list(derived_index_of(s3)["files"]) == [TOOLTIP_PATH]
    s3.fail = set()
    _, failed = run(p, scan(root, catalog), s3, config=b"{}")
    assert failed == 0 and s3.put_keys[-1] == CONFIG_KEY and sorted(derived_index_of(s3)["files"]) == [
        TOOLTIP_PATH, "art/tooltip/AB-002.webp"]


def test_a_source_that_cannot_be_derived_is_a_failure_not_a_crash(tmp_path):
    root, catalog = card_images(tmp_path, {"AB-001": (800, 1120)})
    (root / "AB-001.jpg").write_bytes(b"\xff\xd8\xff\xe0" + b"not really a picture")
    s3 = FakeS3()
    _, failed = run(derived_product(tmp_path), scan(root, catalog), s3, config=b"{}")
    assert failed == 1 and CONFIG_KEY not in s3.put_keys


def test_a_derived_file_must_be_under_the_size_limit(tmp_path, monkeypatch):
    import cardvision.cdn.derived as derived_mod
    root, catalog = card_images(tmp_path, {"AB-001": (800, 1120)})
    s3 = FakeS3()
    monkeypatch.setattr(derived_mod, "derive_webp", lambda *a, **k: b"x" * (5 * 1024 * 1024))
    _, failed = run(derived_product(tmp_path), scan(root, catalog), s3, config=b"{}")
    assert failed == 1 and CONFIG_KEY not in s3.put_keys and "art/tooltip/AB-001.webp" not in s3.put_keys


@pytest.mark.parametrize("derived, field", [
    ("tooltip", "art.derived"),
    ([{"name": "Tooltip", "width": 640, "format": "webp", "quality": 75}], "art.derived[0].name"),
    ([{"name": "t", "width": 63, "format": "webp", "quality": 75}], "art.derived[0].width"),
    ([{"name": "t", "width": 4097, "format": "webp", "quality": 75}], "art.derived[0].width"),
    ([{"name": "t", "width": 640.5, "format": "webp", "quality": 75}], "art.derived[0].width"),
    ([{"name": "t", "width": 640, "format": "jpeg", "quality": 75}], "art.derived[0].format"),
    ([{"name": "t", "width": 640, "format": "webp", "quality": 0}], "art.derived[0].quality"),
    ([{"name": "t", "width": 640, "format": "webp", "quality": 101}], "art.derived[0].quality"),
    ([{"name": "t", "width": 640, "format": "webp"}], "art.derived[0] needs quality"),
    ([{"name": "t", "width": 640, "format": "webp", "quality": 75, "height": 9}], "art.derived[0]: height"),
    ([TOOLTIP, TOOLTIP], "art.derived[1].name"),
])
def test_a_bad_derived_config_is_refused_with_the_field_named(tmp_path, derived, field):
    with pytest.raises(cdn_config.CdnConfigError) as e:
        product({**PANEL_CONFIG, "art": {"derived": derived}}, tmp_path)
    assert field in str(e.value)


def test_no_derived_key_changes_nothing_and_null_width_is_allowed(tmp_path):
    assert product(PANEL_CONFIG, tmp_path).derived == ()
    p = derived_product(tmp_path, {**TOOLTIP, "width": None})
    assert p.derived[0].width is None and p.derived[0].spec_hash != derived_product(tmp_path).derived[0].spec_hash


@pytest.mark.parametrize("bad", ["a/b", "..", "a b", "a?b", "a#b", "a%2Fb", "a\\b", ""])
def test_a_card_id_that_is_not_a_clean_file_name_is_refused(tmp_path, bad):
    root = tmp_path / "pictures"
    root.mkdir()
    (root / "x.jpg").write_bytes(encode(gradient(100, 140), "JPEG"))
    files = scan_images({"x.jpg": [bad]}, root, 5 * 1024 * 1024)
    assert refused(lambda: plan_derived(derived_product(tmp_path), files, lambda spec: {}))
    assert plan_derived(product(PANEL_CONFIG, tmp_path), files, lambda spec: {}) == [], "no set, no check"


def test_a_card_with_two_art_paths_or_an_art_path_in_the_set_folder_is_refused(tmp_path):
    root = tmp_path / "pictures"
    (root / "tooltip").mkdir(parents=True)
    for n in ("a.jpg", "b.jpg", "tooltip/c.jpg"):
        (root / n).write_bytes(encode(gradient(100, 140), "JPEG"))
    p = derived_product(tmp_path)
    two = scan_images({"a.jpg": ["AB-001"], "b.jpg": ["AB-001"]}, root, 5 * 1024 * 1024)
    assert refused(lambda: plan_derived(p, two, lambda spec: {}))
    inside = scan_images({"tooltip/c.jpg": ["AB-002"]}, root, 5 * 1024 * 1024)
    assert refused(lambda: plan_derived(p, inside, lambda spec: {}))


def test_verify_checks_the_derived_files_the_index_lists(tmp_path, capsys):
    root, catalog = card_images(tmp_path, {"AB-001": (800, 1120)})
    p = derived_product(tmp_path)
    s3 = FakeS3()
    files = scan(root, catalog)
    run(p, files, s3)
    store = {
        CONFIG_KEY: (200, {"content-type": "application/json", "cache-control": CONFIG_CACHE, "access-control-allow-origin": "*"},
                     json.dumps(GOOD_HERE).encode()),
        INDEX_KEY: (200, {}, s3.objects[INDEX_KEY]["Body"]),
        "art/AB-001.jpg": (200, {"content-type": "image/jpeg", "cache-control": ART_CACHE}, files[0].file.read_bytes()),
    }
    head = {"content-type": "image/webp", "cache-control": ART_CACHE}
    store[TOOLTIP_INDEX] = (200, {"content-type": "application/json"}, s3.objects[TOOLTIP_INDEX]["Body"])
    store[TOOLTIP_PATH] = (200, head, s3.objects[TOOLTIP_PATH]["Body"])
    get = store_get(store)
    assert verify(p, BASE, 5, get=get) == 0
    assert f"ok   {TOOLTIP_PATH}" in capsys.readouterr().out
    store[TOOLTIP_PATH] = (200, head, s3.objects[TOOLTIP_PATH]["Body"] + b"!")
    assert verify(p, BASE, 5, get=get) == 1, "sha mismatch"
    store[TOOLTIP_PATH] = (200, {**head, "content-type": "image/jpeg"}, s3.objects[TOOLTIP_PATH]["Body"])
    assert verify(p, BASE, 5, get=get) == 1, "content type"
    del store[TOOLTIP_INDEX]
    assert verify(p, BASE, 5, get=get) == 0, "a set not yet published is a note"
    assert f"note {TOOLTIP_INDEX}: not on the CDN" in capsys.readouterr().out


def test_the_switch_rule_on_its_own(tmp_path):
    p = derived_product(tmp_path)
    spec = p.derived[0]
    cfg = json.dumps(GOOD_HERE | {"primary": {"id": "t", "template": BASE + "/art/tooltip/{cardId}.webp"},
                                  "fallbacks": [{"id": "full", "template": BASE + "/art/{art}"}]}).encode()
    cards = {"AB-001", "AB-002"}
    full = {TOOLTIP_PATH, "art/tooltip/AB-002.webp"}
    assert derived_switch_problem(p, json.dumps(GOOD_HERE).encode(), BASE, None, lambda s: (None, set())) is None, "not a derived set"
    assert derived_switch_problem(p, cfg, BASE, cards, lambda s: (spec.spec_hash, full)) is None
    assert "give --catalog" in derived_switch_problem(p, cfg, BASE, None, lambda s: (spec.spec_hash, full))
    assert "lacks 1 of 2" in derived_switch_problem(p, cfg, BASE, cards, lambda s: (spec.spec_hash, {TOOLTIP_PATH}))
    assert "another spec" in derived_switch_problem(p, cfg, BASE, cards, lambda s: ("0" * 64, full))
    assert "no index" in derived_switch_problem(p, cfg, BASE, cards, lambda s: (None, set()))
    as_fallback = json.dumps(GOOD_HERE | {"fallbacks": [{"id": "t", "template": BASE + "/art/tooltip/{cardId}.webp"}]}).encode()
    assert "lacks" in derived_switch_problem(p, as_fallback, BASE, cards, lambda s: (spec.spec_hash, set()))
