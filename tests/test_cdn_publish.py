# SPDX-License-Identifier: Apache-2.0
"""``cardvision cdn``: publish-release and publish --config end to end against a fake bucket, a fake
public CDN and a fake Node check: every check before the first write, the upload order, the gates
(the pointer gate and the data-file gate, a dry run included), the config bytes it writes, and a
replay of the incident the data-file gate exists for."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from cardvision.cdn.config import CONFIG_KEY
from cardvision.cdn.publish import data_file_gate, plan_or_publish, pointer_gate, publish_release
from cardvision.cdn.release import RELEASE_CACHE, load_local_release, pointer_block
from cardvision.cdn.settings import load_data_file
from cardvision.cdn.target import Target
from cardvision.cdn.verify import verify_release_live
from support_cdn import (
    BASE, EXAMPLE_SETTINGS, GEO_CONFIG, PANEL_CONFIG, RID, FakeS3, new_models, no_urlopen, node_ok, product, quiet,
    refused, release_args, same_models, write_release,
)

pytestmark = pytest.mark.usefixtures("no_urlopen", "extension_ids")
PREFIX = "vision/releases/"
TGT = Target("a" * 32, "b" * 32, "c" * 64, "example-bucket", BASE)
CFG = EXAMPLE_SETTINGS


@pytest.fixture
def extension_ids(monkeypatch):
    """Both products' extension ids, as a maintainer's environment file sets them."""
    for product_config in (PANEL_CONFIG, GEO_CONFIG):
        monkeypatch.setenv(f"{product_config['envPrefix']}_EXTENSION_IDS", "e" * 32)


def no_pointer(url, **k):
    """A live CDN whose config.json has no release pointer and nothing else."""
    return (200, {}, json.dumps(CFG).encode()) if url.split("?")[0].endswith(CONFIG_KEY) else (404, {}, b"")


def details_file(tmp_path: Path, cards: dict) -> Path:
    data = json.dumps({"schemaVersion": 1, "cards": cards}).encode()
    path = tmp_path / f"details-{hashlib.sha256(data).hexdigest()[:8]}.json"
    path.write_bytes(data)
    return path


@pytest.fixture
def setup(tmp_path):
    folder, legal, doc, refs = write_release(tmp_path)
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps(CFG))
    return SimpleNamespace(tmp=tmp_path, folder=folder, legal=legal, doc=doc, refs=refs, cfg_file=cfg_file,
                           args=release_args(folder, legal, cfg_file))


def pr(p, args, s3, refs, **k):
    return publish_release(p, args, TGT, s3=s3, node=k.pop("node", node_ok), log=quiet, get=k.pop("get", no_pointer),
                           runtimes=k.pop("runtimes", same_models(refs)), verify_after=k.pop("verify_after", lambda b, s: 0), **k)


@pytest.mark.parametrize("config", [PANEL_CONFIG, GEO_CONFIG])
def test_every_check_comes_before_any_write(config, setup):
    p = product(config, setup.tmp)
    a, refs = setup.args, setup.refs
    assert refused(lambda: pr(p, a, FakeS3(), refs)), "dry run: a config without the pointer is refused before anything"
    s3 = FakeS3()
    assert pr(p, SimpleNamespace(**{**vars(a), "set_pointer": True}), s3, refs) == 0 and not s3.puts, "dry run writes nothing"
    assert setup.cfg_file.read_text() == json.dumps(CFG), "a dry run leaves the config file as it was"
    assert refused(lambda: pr(p, SimpleNamespace(**{**vars(a), "min_version": None}), FakeS3(), refs))
    assert refused(lambda: pr(p, SimpleNamespace(**{**vars(a), "min_version": "1.0"}), FakeS3(), refs))
    assert refused(lambda: pr(p, a, FakeS3(), refs, node=lambda x: {"ok": False, "reason": "x"})), "the runtime's check refuses"
    assert refused(lambda: pr(p, SimpleNamespace(**{**vars(a), "set_pointer": True}), FakeS3(), refs, runtimes=new_models(refs))), "a new model needs --sessions"
    assert pr(p, SimpleNamespace(**{**vars(a), "set_pointer": True, "sessions": True}), FakeS3(), refs, runtimes=new_models(refs)) == 0
    assert refused(lambda: pr(p, SimpleNamespace(**{**vars(a), "set_pointer": True}), FakeS3(), refs,
                              runtimes={"0.3.0": {"ortWeb": "1.30.0"}})), "another ORT minor"


def test_a_new_model_is_noticed_against_the_live_pointer(setup):
    p = product(PANEL_CONFIG, setup.tmp)
    live_doc = json.dumps({"detector": {"sha256": "9" * 64}, "recognizer": {"sha256": "9" * 64}}).encode()
    live_ptr = {"id": "f" * 16, "path": f"{PREFIX}{'f' * 16}/release.json", "sha256": "0" * 64, "minimumExtensionVersion": "0.3.0"}

    def get(url, **k):
        path = url.split("cdn.example.org/", 1)[1].split("?")[0]
        if path == CONFIG_KEY:
            return 200, {}, json.dumps({**CFG, "release": live_ptr}).encode()
        return (200, {}, live_doc) if path == live_ptr["path"] else (404, {}, b"")
    with pytest.raises(Exception, match="live release ffffffffffffffff"):
        pr(p, SimpleNamespace(**{**vars(setup.args), "set_pointer": True}), FakeS3(), setup.refs, get=get)


def test_the_node_check_is_asked_for_the_folder(setup):
    p = product(PANEL_CONFIG, setup.tmp)
    asked = []
    pr(p, SimpleNamespace(**{**vars(setup.args), "set_pointer": True, "sessions": True}), FakeS3(), setup.refs,
       node=lambda a: (asked.append(a), node_ok(a))[1])
    assert asked == [["--dir", str(setup.folder), "--expect-id", RID, "--sessions"]]


def test_a_folder_that_does_not_verify_live_moves_nothing(setup):
    p = product(PANEL_CONFIG, setup.tmp)
    s3 = FakeS3()
    args = SimpleNamespace(**{**vars(setup.args), "dry_run": False, "set_pointer": True})
    assert pr(p, args, s3, setup.refs, verify_live=lambda *a, **k: 1) == 1, "not live: stop"
    assert CONFIG_KEY not in s3.objects and setup.cfg_file.read_text() == json.dumps(CFG), "nothing written to the config"
    assert f"{PREFIX}{RID}/release.json" in s3.objects, "the folder itself is published"


def test_without_config_the_pointer_does_not_move(setup):
    p = product(PANEL_CONFIG, setup.tmp)
    s3 = FakeS3()
    args = SimpleNamespace(**{**vars(setup.args), "dry_run": False, "config": None})
    assert pr(p, args, s3, setup.refs, verify_live=lambda *a, **k: 0) == 0
    assert CONFIG_KEY not in s3.objects and f"{PREFIX}index.json" in s3.objects


def test_release_then_data_file_then_config_with_the_exact_bytes(setup):
    p = product(PANEL_CONFIG, setup.tmp)
    details = details_file(setup.tmp, {})
    s3 = FakeS3()
    after = []
    args = SimpleNamespace(**{**vars(setup.args), "dry_run": False, "set_pointer": True, "data_files": [str(details)]})
    seen_live = []
    assert pr(p, args, s3, setup.refs, verify_live=lambda *a, **k: (seen_live.append(k), 0)[1],
              verify_after=lambda b, s: (after.append((b, s)), 0)[1]) == 0
    keys = s3.put_keys
    doc_key = f"{PREFIX}{RID}/release.json"
    assert keys[-1] == CONFIG_KEY and keys.index(doc_key) < keys.index(f"data/{details.name}") < keys.index(CONFIG_KEY)
    assert keys[:5] == [f"{PREFIX}{RID}/{n}" for n in ("detector.onnx", "recognizer.onnx", "bank.json", "identity-groups.json", "catalog.json")]
    assert keys[5:9] == [f"{PREFIX}{RID}/{n}" for n in ("LICENSE", "NOTICE", "PROVENANCE.md")] + [doc_key]
    assert keys[9] == f"{PREFIX}index.json"
    assert after == [(BASE, 4)], "verify after config.json"
    assert seen_live[0]["candidate"] == RID and seen_live[0]["geometric"] is None
    lr = load_local_release(p, setup.folder, setup.legal)
    want = dict(CFG)
    want["release"] = pointer_block(lr, "0.3.0", None)
    want["details"] = {"path": f"data/{details.name}", "sha256": hashlib.sha256(details.read_bytes()).hexdigest()}
    want_bytes = (json.dumps(want, indent=2) + "\n").encode()
    assert setup.cfg_file.read_bytes() == want_bytes, "the config file: indent 2, key order kept, one newline"
    assert s3.objects[CONFIG_KEY]["Body"] == want_bytes, "the same bytes on the CDN"
    assert list(json.loads(want_bytes)) == [*CFG, "release", "details"]
    assert s3.objects[CONFIG_KEY]["CacheControl"] == "public, max-age=300"


def test_an_existing_pointer_keeps_its_place_in_the_file(setup):
    p = product(PANEL_CONFIG, setup.tmp)
    lr = load_local_release(p, setup.folder, setup.legal)
    cfg = {"schemaVersion": 1, "release": {"id": "f" * 16}, "updatedAt": "x", "namesOnly": False,
           "primary": None, "fallbacks": [], "zeta": "é"}
    setup.cfg_file.write_text(json.dumps(cfg))
    args = SimpleNamespace(**{**vars(setup.args), "dry_run": False, "set_pointer": True, "max_version": "0.9.0"})
    assert pr(p, args, FakeS3(), setup.refs, verify_live=lambda *a, **k: 0) == 0
    want = dict(cfg)
    want["release"] = pointer_block(lr, "0.3.0", "0.9.0")
    assert setup.cfg_file.read_bytes() == (json.dumps(want, indent=2) + "\n").encode()
    assert b"\\u00e9" in setup.cfg_file.read_bytes()


def test_a_pointer_already_in_the_config_needs_no_set_pointer(setup):
    p = product(PANEL_CONFIG, setup.tmp)
    lr = load_local_release(p, setup.folder, setup.legal)
    setup.cfg_file.write_text(json.dumps({**CFG, "release": pointer_block(lr, "0.3.0", None)}))
    assert pr(p, setup.args, FakeS3(), setup.refs) == 0


def test_a_data_file_the_config_does_not_name_is_refused_before_uploads(setup):
    p = product(PANEL_CONFIG, setup.tmp)
    details = details_file(setup.tmp, {})
    s3 = FakeS3()
    assert refused(lambda: pr(p, SimpleNamespace(**{**vars(setup.args), "data_files": [str(details)]}), s3, setup.refs))
    assert not s3.puts


def test_geometric_needs_the_stage(setup):
    p = product(PANEL_CONFIG, setup.tmp)
    g = setup.tmp / "geometric.json"
    g.write_text("{}")
    assert refused(lambda: pr(p, SimpleNamespace(**{**vars(setup.args), "geometric": str(g), "geo_manifest_sha256": "c" * 64}),
                              FakeS3(), setup.refs))


# ---------------------------------------------------------------------------- the geometric release

@pytest.fixture
def geo_setup(setup):
    p = product(GEO_CONFIG, setup.tmp)
    bank_bytes = json.dumps({"entries": [{"cardId": "EX-001"}, {"cardId": "EX-002"}]}).encode()
    (setup.folder / "bank.json").write_bytes(bank_bytes)
    d2 = {**setup.doc, "bank": {"path": "bank.json", "sha256": hashlib.sha256(bank_bytes).hexdigest(), "bytes": len(bank_bytes)}}
    (setup.folder / "release.json").write_text(json.dumps(d2))
    mkey = "vision/geo/cd676903704f456d/manifest.json"
    manifest = {"kind": "geometric-index-packed", "bank": {"sha256": d2["bank"]["sha256"]}, "cards": [{"cardId": "EX-001"}, {"cardId": "EX-002"}]}
    mbytes = json.dumps(manifest).encode()
    gfile = setup.tmp / "geometric.json"
    gfile.write_text(json.dumps({"seed": 0, "index": {"path": f"{BASE}/{mkey}", "sha256": "e" * 64}}))
    gargs = SimpleNamespace(**{**vars(setup.args), "geometric": str(gfile), "geo_manifest_sha256": hashlib.sha256(mbytes).hexdigest(),
                               "set_pointer": True})
    with_index = lambda m=mbytes: FakeS3({mkey: (m, {"sha256": hashlib.sha256(m).hexdigest()})})
    return SimpleNamespace(p=p, gargs=gargs, with_index=with_index, manifest=manifest, mkey=mkey, mbytes=mbytes, gfile=gfile)


def test_the_geometric_index_must_be_there_pinned_and_bound(setup, geo_setup):
    p, gargs, refs = geo_setup.p, geo_setup.gargs, setup.refs
    ok = lambda *a, **k: 0
    assert refused(lambda: pr(p, gargs, FakeS3(), refs, verify_live=ok)), "the index is not on the CDN yet"
    assert refused(lambda: pr(p, SimpleNamespace(**{**vars(gargs), "geo_manifest_sha256": "f" * 64}), geo_setup.with_index(), refs, verify_live=ok)), "another manifest"
    assert refused(lambda: pr(p, SimpleNamespace(**{**vars(gargs), "geo_manifest_sha256": None}), geo_setup.with_index(), refs, verify_live=ok)), "no manifest pin"
    unbound = json.dumps({**geo_setup.manifest, "bank": {"sha256": "0" * 64}}).encode()
    assert refused(lambda: pr(p, SimpleNamespace(**{**vars(gargs), "geo_manifest_sha256": hashlib.sha256(unbound).hexdigest()}),
                              geo_setup.with_index(unbound), refs, verify_live=ok)), "bound to another bank"
    short = json.dumps({**geo_setup.manifest, "cards": [{"cardId": "EX-001"}]}).encode()
    assert refused(lambda: pr(p, SimpleNamespace(**{**vars(gargs), "geo_manifest_sha256": hashlib.sha256(short).hexdigest()}),
                              geo_setup.with_index(short), refs, verify_live=ok)), "a bank card without a row"
    mixed = geo_setup.with_index()
    mixed.objects["vision/geo/cd676903704f456d/manifest-0123456789abcdef.json"] = {"Body": b"{}", "Metadata": {}}
    assert refused(lambda: pr(p, gargs, mixed, refs, verify_live=ok)) and not mixed.puts, "a flat index whose folder also holds a series"
    big = setup.tmp / "big.json"
    big.write_text(json.dumps({"index": {"path": f"{BASE}/{geo_setup.mkey}"}, "pad": "x" * 262144}))
    assert refused(lambda: pr(p, SimpleNamespace(**{**vars(gargs), "geometric": str(big)}), geo_setup.with_index(), refs, verify_live=ok))


def test_geometric_then_release_then_config(setup, geo_setup):
    p, refs = geo_setup.p, setup.refs
    s3 = geo_setup.with_index()
    seen_geo = []
    args = SimpleNamespace(**{**vars(geo_setup.gargs), "dry_run": False})
    assert pr(p, args, s3, refs, verify_live=lambda *a, **k: (seen_geo.append(k.get("geometric")), 0)[1]) == 0
    keys = s3.put_keys
    gkey = f"{PREFIX}{RID}/geometric.json"
    assert keys.index(gkey) < keys.index(f"{PREFIX}{RID}/release.json") < keys.index(CONFIG_KEY), "geometric.json, then release.json, then config"
    assert s3.objects[gkey]["CacheControl"] == RELEASE_CACHE
    written = json.loads(setup.cfg_file.read_text())
    assert written["release"]["geometric"] == {"path": gkey, "sha256": hashlib.sha256(geo_setup.gfile.read_bytes()).hexdigest(),
                                               "manifestSha256": hashlib.sha256(geo_setup.mbytes).hexdigest()}
    assert list(written["release"]) == ["id", "path", "sha256", "minimumExtensionVersion", "geometric"]
    assert seen_geo == [written["release"]["geometric"]], "verified live with its geometric pointer"


def test_no_geometric_no_geometric_block(setup):
    p = product(GEO_CONFIG, setup.tmp)
    args = SimpleNamespace(**{**vars(setup.args), "dry_run": False, "set_pointer": True})
    assert pr(p, args, FakeS3(), setup.refs, verify_live=lambda *a, **k: 0) == 0
    assert "geometric" not in json.loads(setup.cfg_file.read_text())["release"]


def test_verify_release_live_follows_the_geometric_pointer(setup, capsys):
    p = product(GEO_CONFIG, setup.tmp)
    gbank = json.dumps({"entries": [{"cardId": "EX-001"}]}).encode()
    gman = json.dumps({"kind": "geometric-index-packed", "bank": {"sha256": hashlib.sha256(gbank).hexdigest()}, "cards": [{"cardId": "EX-001"}]}).encode()
    gset = json.dumps({"index": {"path": f"{BASE}/vision/geo/cd676903704f456d/manifest.json"}}).encode()
    gdoc = {**setup.doc, "bank": {"path": "bank.json", "sha256": hashlib.sha256(gbank).hexdigest(), "bytes": len(gbank)}}
    gdoc_bytes = json.dumps(gdoc).encode()
    gptr = {"path": f"{PREFIX}{RID}/geometric.json", "sha256": hashlib.sha256(gset).hexdigest(), "manifestSha256": hashlib.sha256(gman).hexdigest()}
    others = {f"{PREFIX}{RID}/{n}": (setup.folder / n).read_bytes() for n in ("detector.onnx", "recognizer.onnx", "identity-groups.json", "catalog.json")}
    others |= {f"{PREFIX}{RID}/{n}": (setup.legal / n).read_bytes() for n in ("LICENSE", "NOTICE", "PROVENANCE.md")}

    def geo_get(url, origin=None, method="GET", headers=None, man=gman):
        path = url.split("cdn.example.org/", 1)[1].split("?")[0]
        body = {f"{PREFIX}{RID}/release.json": gdoc_bytes, f"{PREFIX}{RID}/bank.json": gbank,
                f"{PREFIX}{RID}/geometric.json": gset, "vision/geo/cd676903704f456d/manifest.json": man, **others}.get(path)
        if body is None:
            return 404, {}, b""
        ctype = "application/octet-stream" if path.endswith(".onnx") else (
            "text/plain; charset=utf-8" if path.endswith(("LICENSE", "NOTICE")) else
            "text/markdown; charset=utf-8" if path.endswith(".md") else "application/json")
        h = {"content-type": ctype, "cache-control": RELEASE_CACHE, **({"access-control-allow-origin": origin} if origin else {})}
        return 200, h, body
    vl = lambda **k: verify_release_live(p, BASE, candidate=RID, expect_sha=hashlib.sha256(gdoc_bytes).hexdigest(), node=node_ok,
                                         extension_ids=["e" * 32], **k)
    assert vl(get=geo_get, geometric=gptr) == 0, "geometric pointer verifies"
    assert vl(get=geo_get, geometric={**gptr, "manifestSha256": "0" * 64}) > 0, "another manifest"
    wrong_bank = json.dumps({"kind": "geometric-index-packed", "bank": {"sha256": "0" * 64}, "cards": [{"cardId": "EX-001"}]}).encode()
    assert vl(get=lambda *a, **k: geo_get(*a, **k, man=wrong_bank), geometric={**gptr, "manifestSha256": hashlib.sha256(wrong_bank).hexdigest()}) > 0, "unbound index"
    assert vl(get=geo_get, geometric={**gptr, "sha256": "0" * 64}) > 0, "geometric.json changed"
    short_man = json.dumps({"kind": "geometric-index-packed", "bank": {"sha256": hashlib.sha256(gbank).hexdigest()}, "cards": []}).encode()
    assert vl(get=lambda *a, **k: geo_get(*a, **k, man=short_man), geometric={**gptr, "manifestSha256": hashlib.sha256(short_man).hexdigest()}) > 0, "a bank card without a row"
    capsys.readouterr()
    vl(get=geo_get)
    assert "geometric stage off" in capsys.readouterr().out


def binary_bank() -> bytes:
    """A two-card bank in binary form (bank.bin), as ``cardvision convert-release`` writes it."""
    import numpy as np

    from cardvision.core import bank as B
    from cardvision.core.bank_binary import encode

    doc = {"kind": "embedding-bank", "version": 1, "dim": 4, "preprocessing": {"size": 4}, "entryCount": 2,
           "dtype": "fp16", **B.encode_bank(["EX-001", "EX-002"], np.eye(2, 4, dtype=np.float32))}
    return encode(doc)


@pytest.fixture
def bin_setup(setup, geo_setup):
    """The geometric release of ``geo_setup`` with its bank as bank.bin, and an index bound to it."""
    body = binary_bank()
    (setup.folder / "bank.json").unlink()
    (setup.folder / "bank.bin").write_bytes(body)
    bank = {"path": "bank.bin", "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body)}
    doc = {**setup.doc, "bank": bank}
    (setup.folder / "release.json").write_text(json.dumps(doc))
    manifest = {**geo_setup.manifest, "bank": {"sha256": bank["sha256"]}}
    mbytes = json.dumps(manifest).encode()
    gargs = SimpleNamespace(**{**vars(geo_setup.gargs), "geo_manifest_sha256": hashlib.sha256(mbytes).hexdigest()})
    with_index = lambda m=mbytes: FakeS3({geo_setup.mkey: (m, {"sha256": hashlib.sha256(m).hexdigest()})})
    return SimpleNamespace(body=body, doc=doc, manifest=manifest, gargs=gargs, with_index=with_index)


def test_a_release_with_a_binary_bank_publishes_as_bytes_with_its_geometric_cover_checked(setup, geo_setup, bin_setup):
    p, refs = geo_setup.p, setup.refs
    ok = lambda *a, **k: 0
    dry = bin_setup.with_index()
    assert pr(p, bin_setup.gargs, dry, refs, verify_live=ok) == 0 and not dry.puts, "the dry run passes and writes nothing"
    short = json.dumps({**bin_setup.manifest, "cards": [{"cardId": "EX-001"}]}).encode()
    for dry_run in (True, False):
        args = SimpleNamespace(**{**vars(bin_setup.gargs), "dry_run": dry_run,
                                  "geo_manifest_sha256": hashlib.sha256(short).hexdigest()})
        s3 = bin_setup.with_index(short)
        assert refused(lambda: pr(p, args, s3, refs, verify_live=ok)) and not s3.puts, ("a bank card without a row", dry_run)
    wet = bin_setup.with_index()
    assert pr(p, SimpleNamespace(**{**vars(bin_setup.gargs), "dry_run": False}), wet, refs, verify_live=ok) == 0
    stored = wet.objects[f"{PREFIX}{RID}/bank.bin"]
    assert stored["Body"] == bin_setup.body and stored["ContentType"] == "application/octet-stream"
    assert stored["CacheControl"] == RELEASE_CACHE
    assert wet.objects[f"{PREFIX}{RID}/catalog.json"]["ContentType"] == "application/json"
    again = FakeS3({k: (v["Body"], v["Metadata"], v["ContentType"], v["CacheControl"]) for k, v in wet.objects.items()})
    assert pr(p, SimpleNamespace(**{**vars(bin_setup.gargs), "dry_run": False}), again, refs, verify_live=ok) == 0
    assert f"{PREFIX}{RID}/bank.bin" not in again.put_keys, "already there with the binary type: not uploaded again"


def test_verify_release_live_wants_a_binary_bank_served_as_bytes(setup, geo_setup, bin_setup, capsys):
    p = geo_setup.p
    doc_bytes = json.dumps(bin_setup.doc).encode()
    gset = geo_setup.gfile.read_bytes()
    mbytes = json.dumps(bin_setup.manifest).encode()
    gptr = {"path": f"{PREFIX}{RID}/geometric.json", "sha256": hashlib.sha256(gset).hexdigest(),
            "manifestSha256": hashlib.sha256(mbytes).hexdigest()}
    files = {f"{PREFIX}{RID}/{n}": (setup.folder / n).read_bytes()
             for n in ("release.json", "detector.onnx", "recognizer.onnx", "bank.bin", "identity-groups.json", "catalog.json")}
    files |= {f"{PREFIX}{RID}/{n}": (setup.legal / n).read_bytes() for n in ("LICENSE", "NOTICE", "PROVENANCE.md")}
    files |= {f"{PREFIX}{RID}/release.json": doc_bytes, f"{PREFIX}{RID}/geometric.json": gset, geo_setup.mkey: mbytes}

    def served(bank_type):
        def get(url, origin=None, method="GET", headers=None):
            path = url.split("cdn.example.org/", 1)[1].split("?")[0]
            body = files.get(path)
            if body is None:
                return 404, {}, b""
            ctype = ("application/octet-stream" if path.endswith(".onnx") else bank_type if path.endswith(".bin") else
                     "text/plain; charset=utf-8" if path.endswith(("LICENSE", "NOTICE")) else
                     "text/markdown; charset=utf-8" if path.endswith(".md") else "application/json")
            return 200, {"content-type": ctype, "cache-control": RELEASE_CACHE,
                         **({"access-control-allow-origin": origin} if origin else {})}, body
        return get

    vl = lambda get: verify_release_live(p, BASE, candidate=RID, expect_sha=hashlib.sha256(doc_bytes).hexdigest(), node=node_ok,
                                         extension_ids=["e" * 32], get=get, geometric=gptr)
    assert vl(served("application/octet-stream")) == 0, "bank.bin as bytes, with the geometric cover read from it"
    assert "bound to the release's bank, 2 cards" in capsys.readouterr().out
    assert vl(served("application/json")) > 0, "bank.bin served as JSON"
    assert "bank.bin: content-type 'application/json', want 'application/octet-stream'" in capsys.readouterr().out


# ---------------------------------------------------------------------------- the publish --config gates

@pytest.fixture
def gate(setup):
    p = product(PANEL_CONFIG, setup.tmp)
    lr = load_local_release(p, setup.folder, setup.legal)
    ptr = pointer_block(lr, "0.3.0", None)
    doc_bytes = (setup.folder / "release.json").read_bytes()

    def cdn(url, pointer=True, **k):
        path = url.split("cdn.example.org/", 1)[1].split("?")[0]
        if path == CONFIG_KEY:
            return 200, {}, json.dumps({**CFG, **({"release": ptr} if pointer else {})}).encode()
        return (200, {}, doc_bytes) if path == ptr["path"] else (404, {}, b"")
    return SimpleNamespace(p=p, ptr=ptr, cdn=cdn, off=lambda url, **k: cdn(url, pointer=False, **k), refs=setup.refs)


def test_the_pointer_gate(gate):
    p, ptr, rt = gate.p, gate.ptr, same_models(gate.refs)
    assert pointer_gate(p, BASE, ptr, get=gate.cdn, runtimes=rt, verify_live=lambda *a, **k: 1) is None, "the live pointer again: not re-checked"
    seen = []
    pointer_gate(p, BASE, ptr, get=lambda url, **k: (seen.append(url), gate.off(url, **k))[1], runtimes=rt, verify_live=lambda *a, **k: 0)
    assert seen and all("?cb=" in u for u in seen), "the gate never asks for a bare public URL"
    assert pointer_gate(p, BASE, ptr, get=gate.off, runtimes=rt, verify_live=lambda *a, **k: 0) is None
    assert pointer_gate(p, BASE, ptr, get=gate.off, runtimes=rt, verify_live=lambda *a, **k: 1), "a new pointer that does not verify"
    assert pointer_gate(p, BASE, ptr, get=gate.off, runtimes={"0.3.0": {"ortWeb": "1.30.0"}}, verify_live=lambda *a, **k: 0), "another ORT minor"
    other = {**ptr, "id": "f" * 16, "path": f"{PREFIX}{'f' * 16}/release.json"}
    assert pointer_gate(p, BASE, other, get=gate.off, runtimes=rt, verify_live=lambda *a, **k: 0), "no document"


def test_the_pointer_gate_verifies_the_geometric_part_too(setup, gate):
    p = product(GEO_CONFIG, setup.tmp)
    gptr = {"path": f"{PREFIX}{RID}/geometric.json", "sha256": "b" * 64, "manifestSha256": "c" * 64}
    seen = []
    pointer_gate(p, BASE, {**gate.ptr, "geometric": gptr}, get=gate.off, runtimes=same_models(gate.refs),
                 verify_live=lambda *a, **k: (seen.append(k.get("geometric")), 0)[1])
    assert seen == [gptr]


@pytest.fixture
def data_cdn(setup):
    p = product(PANEL_CONFIG, setup.tmp)
    live_d = json.dumps({"schemaVersion": 1, "cards": {"1": ["A", None, None]}}).encode()
    live_entry = {"path": f"data/details-{hashlib.sha256(live_d).hexdigest()[:8]}.json", "sha256": hashlib.sha256(live_d).hexdigest()}
    stale_entry = {"path": "data/details-2442d28d.json", "sha256": "2442d28d" + "0" * 56}
    live_cfg = json.dumps(CFG | {"details": live_entry}).encode()

    def cdn(url, **k):
        path = url.split("?")[0].removeprefix(BASE + "/")
        if path == CONFIG_KEY:
            return 200, {}, live_cfg
        return (200, {}, live_d) if path == live_entry["path"] else (404, {}, b"")
    return SimpleNamespace(p=p, cdn=cdn, live_entry=live_entry, stale_entry=stale_entry)


def test_the_data_file_gate(setup, data_cdn):
    p = data_cdn.p
    gate = lambda entry, files=(), get=data_cdn.cdn: data_file_gate(
        p, BASE, json.dumps(CFG | ({"details": entry} if entry else {})).encode(), files, get=get)
    assert gate(None) is None, "no data file named"
    assert data_file_gate(p, BASE, None, ()) is None, "no config"
    assert gate(data_cdn.live_entry) is None, "the live file, same bytes"
    msg = gate(data_cdn.stale_entry)
    assert msg and "HTTP 404" in msg and data_cdn.live_entry["path"] in msg, "a file never published: refused, naming the live entry"
    assert gate({**data_cdn.live_entry, "sha256": "0" * 64}), "the live path with other bytes"
    assert gate(data_cdn.stale_entry, get=lambda url, **k: (0, {"x-error": "offline"}, b"")), "cannot confirm: refused"
    mine = load_data_file(p, details_file(setup.tmp, {}))
    asked = []
    assert gate(mine.entry, [mine], get=lambda url, **k: asked.append(url)) is None and not asked, \
        "the file this run publishes first: no fetch"


def test_the_incident_replayed(setup, data_cdn):
    """publish-release --set-pointer, no data file, from a config that names a data file that was
    never published: the dry run refuses it, nothing is written, the config is untouched; with the
    live entry copied in, it goes ahead."""
    p = data_cdn.p
    stale_file = setup.tmp / "stale-config.json"
    stale_file.write_text(json.dumps(CFG | {"details": data_cdn.stale_entry}))
    replay = SimpleNamespace(**{**vars(setup.args), "config": str(stale_file), "data_files": None, "set_pointer": True, "dry_run": True})
    s3 = FakeS3()
    with pytest.raises(Exception, match="not on the CDN"):
        publish_release(p, replay, TGT, s3=s3, node=node_ok, log=quiet, get=data_cdn.cdn, runtimes=same_models(setup.refs))
    assert not s3.puts and json.loads(stale_file.read_text())["details"] == data_cdn.stale_entry, "nothing written, config untouched"
    fixed = SimpleNamespace(**{**vars(replay), "config": str(setup.tmp / "fixed-config.json")})
    Path(fixed.config).write_text(json.dumps(CFG | {"details": data_cdn.live_entry}))
    assert publish_release(p, fixed, TGT, s3=FakeS3(), node=node_ok, log=quiet, get=data_cdn.cdn, runtimes=same_models(setup.refs)) == 0, \
        "with the live entry it goes ahead"


# ---------------------------------------------------------------------------- publish (art, data files, config)

def publish_args(**k):
    base = dict(command="publish", catalog=None, images=None, config=None, data_files=None, page=None, dry_run=False, offline=False)
    return SimpleNamespace(**{**base, **k})


def test_publish_config_runs_both_gates_even_in_a_dry_run(setup, data_cdn, capsys):
    p = data_cdn.p
    lr = load_local_release(p, setup.folder, setup.legal)
    cfg_file = setup.tmp / "publish-config.json"
    cfg_file.write_text(json.dumps(CFG | {"details": data_cdn.stale_entry}))
    s3 = FakeS3()
    with pytest.raises(Exception, match="not on the CDN"):
        plan_or_publish(p, publish_args(config=str(cfg_file), dry_run=True), TGT, s3=s3, get=data_cdn.cdn)
    assert not s3.puts
    cfg_file.write_text(json.dumps(CFG | {"details": data_cdn.live_entry, "release": pointer_block(lr, "0.3.0", None)}))
    checked = []
    with pytest.raises(Exception, match="does not verify"):
        plan_or_publish(p, publish_args(config=str(cfg_file), dry_run=True), TGT, s3=s3, get=data_cdn.cdn,
                        pointer_check=lambda base, rel: (checked.append(rel), "release x: does not verify")[1])
    assert checked and not s3.puts
    assert plan_or_publish(p, publish_args(config=str(cfg_file), dry_run=True), TGT, s3=s3, get=data_cdn.cdn,
                           pointer_check=lambda base, rel: None) == 0 and not s3.puts
    assert plan_or_publish(p, publish_args(config=str(cfg_file)), TGT, s3=s3, get=data_cdn.cdn,
                           pointer_check=lambda base, rel: None, log=quiet) == 0
    assert s3.put_keys == [CONFIG_KEY] and s3.objects[CONFIG_KEY]["Body"] == cfg_file.read_bytes(), "the file's own bytes"


def test_a_dry_run_needs_the_extension_ids_the_live_check_will_need(setup, gate, monkeypatch):
    """publish-release and publish --config with a new pointer check a folder live, which needs
    _EXTENSION_IDS: without it, the dry run is refused as the run itself would be, before anything."""
    monkeypatch.delenv("EXAMPLECDN_EXTENSION_IDS", raising=False)
    p, rt = gate.p, same_models(gate.refs)
    for dry_run in (True, False):
        s3 = FakeS3()
        args = SimpleNamespace(**{**vars(setup.args), "dry_run": dry_run})
        with pytest.raises(Exception, match="EXAMPLECDN_EXTENSION_IDS is not set"):
            publish_release(p, args, TGT, s3=s3, node=node_ok, log=quiet, get=no_pointer, runtimes=rt)
        assert not s3.puts
    assert "EXAMPLECDN_EXTENSION_IDS is not set" in pointer_gate(p, BASE, gate.ptr, get=gate.off, runtimes=rt)
    assert pointer_gate(p, BASE, gate.ptr, get=gate.cdn, runtimes=rt) is None, "the live pointer again: no live check, no ids"
    cfg_file = setup.tmp / "pointer-config.json"
    cfg_file.write_text(json.dumps(CFG | {"release": gate.ptr}))
    s3 = FakeS3()
    with pytest.raises(Exception, match="EXAMPLECDN_EXTENSION_IDS is not set"):
        plan_or_publish(p, publish_args(config=str(cfg_file), dry_run=True), TGT, s3=s3, get=gate.off)
    assert not s3.puts
    monkeypatch.setenv("EXAMPLECDN_EXTENSION_IDS", "e" * 32)
    args = SimpleNamespace(**{**vars(setup.args), "set_pointer": True})
    assert publish_release(p, args, TGT, s3=FakeS3(), node=node_ok, log=quiet, get=no_pointer, runtimes=rt) == 0


def test_plan_runs_no_gate_and_writes_nothing(setup, data_cdn):
    cfg_file = setup.tmp / "plan-config.json"
    cfg_file.write_text(json.dumps(CFG | {"details": data_cdn.stale_entry}))
    s3 = FakeS3()
    assert plan_or_publish(data_cdn.p, publish_args(command="plan", config=str(cfg_file)), TGT, s3=s3,
                           get=lambda *a, **k: pytest.fail("plan fetched")) == 0
    assert not s3.puts


def test_publish_data_file_page_and_config(setup):
    p = product(PANEL_CONFIG, setup.tmp)
    details = details_file(setup.tmp, {"1": []})
    d = load_data_file(p, details)
    cfg_file = setup.tmp / "c.json"
    cfg_file.write_text(json.dumps(CFG | {"details": d.entry}))
    page = setup.tmp / "privacy.html"
    page.write_bytes(b"<!doctype html><p>policy</p>")
    s3 = FakeS3()
    assert plan_or_publish(p, publish_args(config=str(cfg_file), data_files=[str(details)], page=str(page)), TGT, s3=s3,
                           get=lambda *a, **k: pytest.fail("the gate fetched for the file this run publishes"), log=quiet) == 0
    assert s3.put_keys == [d.key, "privacy.html", CONFIG_KEY]
    other = setup.tmp / "c2.json"
    other.write_text(json.dumps(CFG))
    assert refused(lambda: plan_or_publish(p, publish_args(config=str(other), data_files=[str(details)]), TGT, s3=FakeS3()))
    assert refused(lambda: plan_or_publish(p, publish_args(), TGT, s3=FakeS3())), "nothing to do"
    assert refused(lambda: plan_or_publish(p, publish_args(catalog="c.json"), TGT, s3=FakeS3())), "--catalog needs --images"


def test_publish_art_with_the_index(setup):
    p = product(GEO_CONFIG, setup.tmp)
    images = setup.tmp / "images"
    images.mkdir()
    (images / "EX-001.jpg").write_bytes(b"\xff\xd8\xff\xe0" + b"x" * 10)
    catalog = setup.tmp / "catalog.json"
    catalog.write_text(json.dumps([{"id": "EX-001", "art": "EX-001.jpg"}, {"id": "EX-002", "art": None}]))
    s3 = FakeS3()
    args = publish_args(catalog=str(catalog), images=str(images), dry_run=True)
    assert plan_or_publish(p, args, TGT, s3=s3) == 0 and not s3.puts
    args.dry_run = False
    assert plan_or_publish(p, args, TGT, s3=s3, log=quiet) == 0
    assert s3.put_keys == ["art/EX-001.jpg", "art/index.json"]
