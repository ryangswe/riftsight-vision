# SPDX-License-Identifier: Apache-2.0
"""``cardvision cdn``: the geometric index folder (publish-geo, verify-geo, one layout per
folder) and a release's binding to it (index on this CDN, manifest pinned, bound to the bank)."""

from __future__ import annotations

import hashlib
import json

import pytest

from cardvision.cdn.config import Refused
from cardvision.cdn.geo import GEO_CACHE, geo_index_key, geo_layout_problem, geo_plan, geo_series_plan, publish_geo
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


# ------------------------------------------------------------------ a series: only new shards are uploaded
SERIES = "vision/geo/0123456789abcdef/"
M1, M2 = "manifest-1111111111111111.json", "manifest-2222222222222222.json"


def write_series(folder, manifest_name, blobs, base_shards=()):
    """A packed series folder: content-named shards (`base_shards` kept first) and the manifest.
    Returns (manifest sha256, [shard names])."""
    folder.mkdir(parents=True, exist_ok=True)
    entries = list(base_shards)
    for blob in blobs:
        sha = hashlib.sha256(blob).hexdigest()
        (folder / f"shard-{sha[:16]}.bin").write_bytes(blob)
        entries.append({"path": f"shard-{sha[:16]}.bin", "sha256": sha, "rows": len(blob)})
    man = {"schemaVersion": 1, "kind": "geometric-index-packed", "source": {"sha256": SRC}, "shards": entries}
    mbytes = json.dumps(man).encode()
    (folder / manifest_name).write_bytes(mbytes)
    return hashlib.sha256(mbytes).hexdigest(), entries


@pytest.fixture
def series(tmp_path):
    """A live series (set 1) and a pack that appends one shard (set 2): (live dir, next dir, shas, entries)."""
    live, nxt = tmp_path / "live", tmp_path / "next"
    sha1, ents1 = write_series(live, M1, [b"\x01" * 64, b"\x02" * 96])
    sha2, ents2 = write_series(nxt, M2, [b"\x03" * 40], base_shards=ents1)
    for e in ents1:
        (nxt / e["path"]).write_bytes((live / e["path"]).read_bytes())
    return live, nxt, (sha1, sha2), (ents1, ents2)


def snapshot(s3):
    return {k: dict(v) for k, v in s3.objects.items()}


def test_a_series_pack_uploads_only_new_shards_then_the_manifest(series, tmp_path):
    live, nxt, (sha1, sha2), (ents1, ents2) = series
    folder, files1 = geo_series_plan(live, M1, "0123456789abcdef", sha1)
    assert folder == SERIES and [f.name for f in files1] == [e["path"] for e in ents1] + [M1]
    s3, lines = FakeS3(), []
    assert publish_geo(s3, "b", folder, files1, series=True, new_series=True, log=lines.append) == 0
    assert len(s3.puts) == 3 and s3.put_keys[-1] == folder + M1, "the first set: everything, manifest last"
    first = snapshot(s3)

    folder, files2 = geo_series_plan(nxt, M2, "0123456789abcdef", sha2)
    assert [f.name for f in files2] == [e["path"] for e in ents2] + [M2]
    s3.puts.clear()
    lines.clear()
    assert publish_geo(s3, "b", folder, files2, series=True, log=lines.append) == 0
    assert s3.put_keys == [folder + ents2[-1]["path"], folder + M2], "only the new shard, then the manifest"
    assert {k: v for k, v in snapshot(s3).items() if k in first} == first, "old objects untouched"
    assert s3.copies == []
    assert any("uploaded 40 of 200 shard bytes (20.0% of the index)" in line for line in lines), lines

    p = product(GEO_CONFIG, tmp_path)
    served = {f"{BASE}/{folder}{f.name}": f.data for f in files2}

    def get(url, origin=None):
        body = served.get(url)
        if body is None:
            return 404, {}, b""
        t = "application/json" if url.endswith(".json") else "application/octet-stream"
        return 200, {"cache-control": GEO_CACHE, "access-control-allow-origin": "*", "content-type": t}, body

    assert verify_geo(p, BASE, folder, files2, get=get) == 0, "verify-geo --series reads every file back"
    assert verify_geo(p, BASE, folder, files2, get=lambda u, origin=None: (404, {}, b"")) == len(files2)

    s3.puts.clear()
    assert publish_geo(s3, "b", folder, files2, series=True, log=quiet) == 0 and s3.puts == [], "a re-run writes nothing"


def test_a_series_dry_run_prints_the_byte_figure_and_writes_nothing(series):
    live, nxt, (sha1, sha2), _ = series
    s3 = FakeS3()
    folder, files1 = geo_series_plan(live, M1, "0123456789abcdef", sha1)
    publish_geo(s3, "b", folder, files1, series=True, new_series=True, log=quiet)
    before, lines = snapshot(s3), []
    _, files2 = geo_series_plan(nxt, M2, "0123456789abcdef", sha2)
    assert publish_geo(s3, "b", folder, files2, dry_run=True, series=True, log=lines.append) == 0
    assert len(s3.puts) == 3 and snapshot(s3) == before, "a dry run writes nothing"
    assert any("would upload 40 of 200 shard bytes (20.0% of the index)" in line for line in lines), lines


def test_a_series_never_overwrites(series):
    live, _, (sha1, _), _ = series
    folder, files = geo_series_plan(live, M1, "0123456789abcdef", sha1)
    s3 = FakeS3()
    publish_geo(s3, "b", folder, files, series=True, new_series=True, log=quiet)
    s3.objects[folder + M1]["Body"] = b"{}"
    n = len(s3.puts)
    with pytest.raises(Refused, match="already on the CDN with other bytes"):
        publish_geo(s3, "b", folder, files, series=True, log=quiet)
    assert len(s3.puts) == n and s3.copies == []


def test_a_series_is_refused_in_a_flat_folder_or_a_stranger_folder(series):
    live, _, (sha1, _), _ = series
    folder, files = geo_series_plan(live, M1, "0123456789abcdef", sha1)
    for flat_name in ("manifest.json", "shard-0.bin"):
        s3 = FakeS3({folder + flat_name: (b"x", {})})
        before = snapshot(s3)
        with pytest.raises(Refused, match="holds a flat index") as e:
            publish_geo(s3, "b", folder, files, series=True, new_series=True, log=quiet)
        assert flat_name in str(e.value)
        assert s3.puts == [] and s3.copies == [] and snapshot(s3) == before, "nothing written"
        s3.puts.clear()
        with pytest.raises(Refused, match="holds a flat index"):
            publish_geo(s3, "b", folder, files, dry_run=True, series=True, log=quiet)

    stranger = FakeS3({folder + "shard-ffffffffffffffff.bin": (b"x", {}), folder + "manifest-ffffffffffffffff.json": (b"{}", {})})
    before = snapshot(stranger)
    for new in (False, True):
        with pytest.raises(Refused, match="holds none of this manifest's shards" if not new else "is not empty; --new-series needs an empty folder"):
            publish_geo(stranger, "b", folder, files, series=True, new_series=new, log=quiet)
        assert stranger.puts == [] and snapshot(stranger) == before, "nothing written"

    empty = FakeS3()
    with pytest.raises(Refused, match="a new series needs --new-series and an empty folder"):
        publish_geo(empty, "b", folder, files, series=True, log=quiet)
    assert empty.puts == [] and empty.objects == {}, "an empty folder without --new-series: nothing written"
    assert publish_geo(empty, "b", folder, files, series=True, new_series=True, log=quiet) == 0, "--new-series into an empty folder"
    assert len(empty.puts) == 3
    other_empty = FakeS3()
    other_folder = "vision/geo/fedcba9876543210/"
    with pytest.raises(Refused, match="needs --new-series and an empty folder"):
        publish_geo(other_empty, "b", other_folder, files, series=True, log=quiet)
    assert other_empty.puts == [], "an empty folder of another name is refused too"

    grown = FakeS3()
    publish_geo(grown, "b", folder, files, series=True, new_series=True, log=quiet)
    with pytest.raises(Refused, match="is not empty; --new-series"):
        publish_geo(grown, "b", folder, files, series=True, new_series=True, log=quiet)


def test_a_content_name_of_digits_does_not_make_a_folder_flat(tmp_path):
    digits = None
    for i in range(200000):
        blob = str(i).encode() * 3
        if hashlib.sha256(blob).hexdigest()[:16].isdigit():
            digits = blob
            break
    assert digits is not None
    sha1, ents = write_series(tmp_path / "d", M1, [b"\x01" * 64])
    sha2, ents2 = write_series(tmp_path / "d", M2, [digits], base_shards=ents)
    folder, files = geo_series_plan(tmp_path / "d", M2, "0123456789abcdef", sha2)
    assert ents2[-1]["path"][6:-4].isdigit()
    s3 = FakeS3()
    publish_geo(s3, "b", folder, geo_series_plan(tmp_path / "d", M1, "0123456789abcdef", sha1)[1], series=True, new_series=True, log=quiet)
    assert publish_geo(s3, "b", folder, files, series=True, log=quiet) == 0, "the digit-named shard is a series shard"
    assert folder + ents2[-1]["path"] in s3.objects
    puts = len(s3.puts)
    assert publish_geo(s3, "b", folder, files, series=True, log=quiet) == 0 and len(s3.puts) == puts, \
        "a re-run into a folder that holds the digit-named shard is not refused and writes nothing"
    shared = ents[0]["path"]
    ok = ("application/octet-stream", GEO_CACHE)
    held = FakeS3({folder + ents2[-1]["path"]: (digits, {}, *ok), folder + shared: ((tmp_path / "d" / shared).read_bytes(), {}, *ok)})
    assert publish_geo(held, "b", folder, files, series=True, log=quiet) == 0, "a folder with a 16-digit shard and a shared one"
    flat = FakeS3({folder + "shard-123456789012345.bin": (b"x", {})})
    with pytest.raises(Refused, match="holds a flat index"):
        publish_geo(flat, "b", folder, files, series=True, log=quiet)


def test_a_series_shard_failure_leaves_the_manifest_out(series):
    live, _, (sha1, _), (ents1, _) = series
    folder, files = geo_series_plan(live, M1, "0123456789abcdef", sha1)
    lines = []
    broken = FakeS3(fail={ents1[1]["path"]})
    assert publish_geo(broken, "b", folder, files, series=True, new_series=True, log=lines.append) == 1
    assert folder + M1 not in broken.objects
    assert any(f"{M1} NOT uploaded" in line and "Re-run without --new-series" in line for line in lines), lines
    with pytest.raises(Refused, match="re-run without --new-series"):
        publish_geo(broken, "b", folder, files, series=True, new_series=True, log=quiet)
    broken.fail.clear()
    assert publish_geo(broken, "b", folder, files, series=True, log=quiet) == 0, "the retry without the flag finishes"
    assert folder + M1 in broken.objects
    corrupt = FakeS3(corrupt=True)
    assert publish_geo(corrupt, "b", folder, files, series=True, new_series=True, log=quiet) == 2
    assert folder + M1 not in corrupt.objects


def test_a_series_plan_takes_only_content_named_shards(series, tmp_path):
    live, _, (sha1, _), (ents1, _) = series
    refusals = [
        (lambda: geo_series_plan(live, M1, "0123456789abcdef", "0" * 64), "has SHA-256"),
        (lambda: geo_series_plan(live, M1, "0123", sha1), "--folder"),
        (lambda: geo_series_plan(live, "manifest.json", "0123456789abcdef", sha1), "--manifest"),
        (lambda: geo_series_plan(live, "manifest-3333333333333333.json", "0123456789abcdef", sha1), "missing"),
    ]
    for call, why in refusals:
        with pytest.raises(Refused, match=why):
            call()
    # flat-named shard
    flat, other = tmp_path / "flat", tmp_path / "other"
    flat.mkdir()
    blob = b"\x05" * 8
    (flat / "shard-0.bin").write_bytes(blob)
    man = {"schemaVersion": 1, "kind": "geometric-index-packed", "source": {"sha256": SRC},
           "shards": [{"path": "shard-0.bin", "sha256": hashlib.sha256(blob).hexdigest(), "rows": 1}]}
    (flat / M1).write_bytes(json.dumps(man).encode())
    with pytest.raises(Refused, match="content-named"):
        geo_series_plan(flat, M1, "0123456789abcdef", hashlib.sha256((flat / M1).read_bytes()).hexdigest())
    # a name that does not match its content
    other.mkdir()
    wrong = other / "shard-aaaaaaaaaaaaaaaa.bin"
    wrong.write_bytes(blob)
    man["shards"][0]["path"] = wrong.name
    (other / M1).write_bytes(json.dumps(man).encode())
    with pytest.raises(Refused, match="gives shard-"):
        geo_series_plan(other, M1, "0123456789abcdef", hashlib.sha256((other / M1).read_bytes()).hexdigest())


def test_the_series_flags_go_together(tmp_path, capsys):
    import argparse
    from cardvision.cdn import commands

    (tmp_path / "cdn").mkdir()
    (tmp_path / "cdn" / "cdn.config.json").write_text(json.dumps(GEO_CONFIG))
    parser = argparse.ArgumentParser()
    commands.add_arguments(parser)
    base = ["--cdn-config", str(tmp_path / "cdn" / "cdn.config.json"), "--dir", str(tmp_path)]
    for argv, why in ((["publish-geo", "--series", *base], "needs --folder and --manifest"),
                      (["publish-geo", "--folder", "0123456789abcdef", *base], "go with --series"),
                      (["verify-geo", "--series", "--new-series", "--folder", "0123456789abcdef", "--manifest", M1, *base],
                       "--new-series is for publish-geo")):
        assert commands.run(parser.parse_args(argv)) == 3
        assert why in capsys.readouterr().err
