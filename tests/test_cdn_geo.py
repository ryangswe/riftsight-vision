# SPDX-License-Identifier: Apache-2.0
"""``cardvision cdn``: the geometric index folder (publish-geo, verify-geo, one layout per
folder) and a release's binding to it (index on this CDN, manifest pinned, bound to the bank)."""

from __future__ import annotations

import hashlib
import json

import pytest

from cardvision.cdn.geo import GEO_CACHE, geo_index_key, geo_layout_problem, geo_plan, publish_geo
from cardvision.cdn.verify import verify_geo
from support_cdn import BASE, GEO_CONFIG, FakeS3, no_urlopen, product, quiet, refused

pytestmark = pytest.mark.usefixtures("no_urlopen")
SRC = "cd676903704f456d" + "e" * 48
FOLDER = "vision/geo/cd676903704f456d/"


@pytest.fixture
def packed(tmp_path):
    g = tmp_path / "packed"
    g.mkdir()
    shard0, shard1 = b"\x01" * 64, b"\x02" * 96
    man = {"schemaVersion": 1, "kind": "geometric-index-packed", "source": {"sha256": SRC},
           "shards": [{"path": "shard-0.bin", "sha256": hashlib.sha256(shard0).hexdigest(), "rows": 2},
                      {"path": "shard-1.bin", "sha256": hashlib.sha256(shard1).hexdigest(), "rows": 3}]}
    (g / "shard-0.bin").write_bytes(shard0)
    (g / "shard-1.bin").write_bytes(shard1)
    mbytes = json.dumps(man).encode()
    (g / "manifest.json").write_bytes(mbytes)
    return g, man, mbytes, hashlib.sha256(mbytes).hexdigest(), shard1


def test_the_plan_pins_the_manifest(packed):
    g, man, mbytes, msha, shard1 = packed
    assert refused(lambda: geo_plan(g, "0" * 64)), "manifest sha must be the pinned one"
    assert refused(lambda: geo_plan(g, "")), "the pin is required"
    folder, files = geo_plan(g, msha)
    assert folder == FOLDER
    assert [f.name for f in files] == ["shard-0.bin", "shard-1.bin", "manifest.json"], "shards first, manifest last"
    assert [f.content_type for f in files] == ["application/octet-stream"] * 2 + ["application/json"]
    (g / "shard-1.bin").write_bytes(b"\x09" * 96)
    assert refused(lambda: geo_plan(g, msha)), "a shard that does not match the manifest"
    (g / "shard-1.bin").write_bytes(shard1)
    bad_man = json.dumps(man | {"shards": [{"path": "../shard-0.bin", "sha256": man["shards"][0]["sha256"]}]}).encode()
    (g / "manifest.json").write_bytes(bad_man)
    assert refused(lambda: geo_plan(g, hashlib.sha256(bad_man).hexdigest())), "shard names are plain"
    for broken in (man | {"kind": "other"}, man | {"source": {"sha256": "x"}}, man | {"shards": []}):
        data = json.dumps(broken).encode()
        (g / "manifest.json").write_bytes(data)
        assert refused(lambda: geo_plan(g, hashlib.sha256(data).hexdigest())), broken


def test_publish_geo(packed):
    g, _, _, msha, _ = packed
    folder, files = geo_plan(g, msha)
    s3 = FakeS3()
    assert publish_geo(s3, "b", folder, files, dry_run=True, log=quiet) == 0 and s3.puts == [], "dry run uploads nothing"
    assert publish_geo(s3, "b", folder, files, log=quiet) == 0
    assert s3.put_keys == [folder + "shard-0.bin", folder + "shard-1.bin", folder + "manifest.json"]
    o = s3.objects[folder + "manifest.json"]
    assert o["ContentType"] == "application/json" and o["CacheControl"] == GEO_CACHE == "public, max-age=31536000, immutable"
    assert s3.objects[folder + "shard-0.bin"]["ContentType"] == "application/octet-stream"
    assert publish_geo(s3, "b", folder, files, log=quiet) == 0 and len(s3.puts) == 3, "a re-run keeps what is there"
    s3.objects[folder + "shard-1.bin"]["Metadata"] = {}
    assert publish_geo(s3, "b", folder, files, log=quiet) == 0 and len(s3.puts) == 3, "same bytes without metadata: read and kept"
    s3.objects[folder + "shard-1.bin"]["Body"] = b"\x03" * 96
    assert refused(lambda: publish_geo(s3, "b", folder, files, log=quiet)), "never overwrite other bytes"
    assert len(s3.puts) == 3, "a conflict uploads nothing"
    corrupt = FakeS3(corrupt=True)
    assert publish_geo(corrupt, "b", folder, files, log=quiet) == 2, "the HEAD check catches bad shards"
    assert folder + "manifest.json" not in corrupt.objects, "no manifest before every shard checks out"
    broken = FakeS3(fail={"shard-1.bin"})
    assert publish_geo(broken, "b", folder, files, log=quiet) == 1, "a PUT that throws mid-run"
    assert folder + "manifest.json" not in broken.objects and folder + "shard-0.bin" in broken.objects


def test_one_layout_per_folder(packed):
    g, _, _, msha, _ = packed
    folder, files = geo_plan(g, msha)
    mixed = FakeS3()
    for k in ("manifest-0123456789abcdef.json", "shard-0123456789abcdef.bin", "x.txt"):
        mixed.objects[folder + k] = {"Body": b"x"}
    assert refused(lambda: publish_geo(mixed, "b", folder, files, log=quiet)) and not mixed.puts, "flat into a series folder"
    s3 = FakeS3()
    publish_geo(s3, "b", folder, files, log=quiet)
    assert geo_layout_problem(s3, "b", folder, flat=False), "a series into the flat folder just published"
    assert geo_layout_problem(s3, "b", "vision/geo/0123456789abcdef/", flat=False) is None, "an empty folder takes either"


def test_wrong_metadata_is_refused_or_fixed_in_place(packed):
    g, _, _, msha, _ = packed
    folder, files = geo_plan(g, msha)
    meta = FakeS3()
    publish_geo(meta, "b", folder, files, log=quiet)
    meta.objects[folder + "shard-0.bin"]["CacheControl"] = "public, max-age=60"
    meta.objects[folder + "manifest.json"]["ContentType"] = "text/plain"
    before = {k: v["Body"] for k, v in meta.objects.items()}
    assert refused(lambda: publish_geo(meta, "b", folder, files, log=quiet)), "wrong metadata is reported, not kept"
    assert publish_geo(meta, "b", folder, files, dry_run=True, fix_metadata=True, log=quiet) == 0 and meta.copies == []
    assert publish_geo(meta, "b", folder, files, fix_metadata=True, log=quiet) == 0
    assert sorted(meta.copies) == sorted([folder + "shard-0.bin", folder + "manifest.json"]) and len(meta.puts) == 3
    assert {k: v["Body"] for k, v in meta.objects.items()} == before, "metadata fixes never change bytes"
    assert meta.objects[folder + "shard-0.bin"]["CacheControl"] == GEO_CACHE
    assert meta.objects[folder + "manifest.json"]["ContentType"] == "application/json"


def test_verify_geo(packed, tmp_path, capsys):
    p = product(GEO_CONFIG, tmp_path)
    g, _, _, msha, _ = packed
    folder, files = geo_plan(g, msha)
    served = {f"{BASE}/{folder}{f.name}": f.data for f in files}
    origins = []

    def geo_get(url, origin=None, cache=GEO_CACHE, cors="*", body=None, ctype=None, extra=None):
        origins.append(origin)
        if url not in served:
            return 404, {}, b""
        t = ctype or ("application/json" if url.endswith(".json") else "application/octet-stream")
        return 200, {"cache-control": cache, "access-control-allow-origin": cors, "content-type": t, **(extra or {})}, body if body is not None else served[url]

    assert verify_geo(p, BASE, folder, files, get=geo_get) == 0
    assert set(origins) == {"chrome-extension://examplegeo"}, "the product's extension origin"
    assert verify_geo(p, BASE, folder, files, get=lambda u, origin=None: geo_get(u, origin, cors="chrome-extension://examplegeo")) == 0
    for change in ({"cache": "public, max-age=60"}, {"cors": ""}, {"body": b"x"}, {"ctype": "text/plain"},
                   {"extra": {"nel": '{"report_to":"cf-nel"}'}}, {"extra": {"report-to": "{}"}}):
        assert verify_geo(p, BASE, folder, files, get=lambda u, origin=None, c=change: geo_get(u, origin, **c)) == 3, change
    assert verify_geo(p, BASE, folder, files, get=lambda u, origin=None: (404, {}, b"")) == 3


@pytest.mark.parametrize("bad_path", [
    "https://cdn.example.org/vision/geo/cd676903704f456d/manifest-x.json",
    "https://images.example.net/vision/geo/cd676903704f456d/manifest.json",
    "https://cdn.example.org/vision/releases/cd676903704f456d/manifest.json",
    "https://cdn.example.org/vision/geo/cd676903704f456d/manifest.json?v=1",
])
def test_the_index_must_be_on_this_cdn_under_vision_geo(bad_path):
    assert refused(lambda: geo_index_key({"index": {"path": bad_path}}, BASE))


def test_flat_and_series_manifests_are_both_accepted():
    assert geo_index_key({"index": {"path": f"{BASE}/{FOLDER}manifest.json"}}, BASE) == f"{FOLDER}manifest.json"
    series = "vision/geo/0123456789abcdef/manifest-89abcdef01234567.json"
    assert geo_index_key({"index": {"path": f"{BASE}/{series}"}}, BASE) == series
    assert refused(lambda: geo_index_key({}, BASE))
