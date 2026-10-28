# SPDX-License-Identifier: Apache-2.0
"""``cardvision cdn``: a release folder's local seal, the runtime table, the remote state, the
upload order, the pointer block, the Node check and ``verify-release-live``."""

from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace

import pytest

from cardvision.cdn import config as cdn_config
from cardvision.cdn.config import CONFIG_KEY
from cardvision.cdn.node import node_verify
from cardvision.cdn.release import (
    RELEASE_CACHE,
    bundled_release_id,
    load_local_release,
    pointer_block,
    remote_state,
    runtime_problems,
    upload_release,
    write_release_index,
)
from cardvision.cdn.verify import verify_release_live
from support_cdn import (
    BASE, EXAMPLE_SETTINGS, GEO_CONFIG, PANEL_CONFIG, RID, FakeS3, no_urlopen, node_ok, product, quiet, refused, write_release,
)

pytestmark = pytest.mark.usefixtures("no_urlopen")
PREFIX = "vision/releases/"


@pytest.fixture
def panel(tmp_path):
    return product(PANEL_CONFIG, tmp_path)


@pytest.fixture
def geo(tmp_path):
    return product(GEO_CONFIG, tmp_path)


def test_runtime_table():
    runtimes = {"$comment": "x", "0.3.0": {"ortWeb": "1.29.0"}, "0.4.0": {"ortWeb": "1.30.1"}}
    doc = {"runtime": {"ortWeb": "1.29.0"}}
    assert runtime_problems(doc, "0.3.0", "0.4.0", runtimes) == []
    assert runtime_problems(doc, "0.3.0", None, runtimes), "0.4.0 runs another ORT minor"
    (nothing,) = runtime_problems(doc, "9.0.0", None, runtimes, "cdn/RUNTIMES.json")
    assert "nothing would load it" in nothing and "cdn/RUNTIMES.json" in nothing


def test_the_local_seal(panel, tmp_path):
    folder, legal, doc, refs = write_release(tmp_path)
    lr = load_local_release(panel, folder, legal)
    assert [f.key.rsplit("/", 1)[1] for f in lr.pinned] == ["detector.onnx", "recognizer.onnx", "bank.json", "identity-groups.json", "catalog.json"]
    assert lr.pinned[0].content_type == "application/octet-stream" and lr.pinned[2].content_type == "application/json"
    assert [f.content_type for f in lr.legal] == ["text/plain; charset=utf-8", "text/plain; charset=utf-8", "text/markdown; charset=utf-8"]
    assert lr.doc_file.key == f"{PREFIX}{RID}/release.json"
    other = tmp_path / "elsewhere"
    other.mkdir()
    for f in folder.iterdir():
        (other / f.name).write_bytes(f.read_bytes())
    assert refused(lambda: load_local_release(panel, other, legal)), "folder not named after its id"
    (legal / "NOTICE").write_text("Example models (release ffffffffffffffff)")
    assert refused(lambda: load_local_release(panel, folder, legal)), "NOTICE names another release"
    (legal / "NOTICE").write_text(f"Example models (release {RID})")
    (legal / "LICENSE").unlink()
    assert refused(lambda: load_local_release(panel, folder, legal)), "a legal file is missing"
    (legal / "LICENSE").write_text("license")
    (folder / "bank.json").write_bytes(b"changed")
    assert refused(lambda: load_local_release(panel, folder, legal)), "a pinned file changed"
    (folder / "bank.json").write_text("bank.json-bytes")
    bad_doc = json.loads((folder / "release.json").read_text())
    bad_doc["catalog"] = {**refs["catalog"], "path": "sub/catalog.json"}
    (folder / "release.json").write_text(json.dumps(bad_doc))
    assert refused(lambda: load_local_release(panel, folder, legal)), "a pinned path is not a flat name"
    (folder / "release.json").write_text(json.dumps({**doc, "padding": "x" * 262144}))
    assert refused(lambda: load_local_release(panel, folder, legal)), "a document the extension would not read whole"
    (folder / "release.json").write_text("{")
    assert refused(lambda: load_local_release(panel, folder, legal))
    (folder / "release.json").write_text(json.dumps(doc))
    assert load_local_release(panel, folder, legal).id == RID


def test_the_document_limit_is_the_extensions(panel):
    assert panel.max_document_bytes == 262144


def test_remote_state_never_overwrites(panel, tmp_path):
    folder, legal, _, _ = write_release(tmp_path)
    lr = load_local_release(panel, folder, legal)
    files = lr.pinned + lr.legal + [lr.doc_file]
    todo, there = remote_state(FakeS3(), "b", files, False)
    assert len(todo) == 9 and not there
    f0 = lr.pinned[0]
    good = (f0.data, {"sha256": f0.sha256}, f0.content_type, RELEASE_CACHE)
    todo, there = remote_state(FakeS3({f0.key: good}), "b", files, False)
    assert len(todo) == 8 and there == [f0], "same bytes, metadata and headers: skipped"
    assert refused(lambda: remote_state(FakeS3({f0.key: (b"other", {"sha256": "x"}, f0.content_type, RELEASE_CACHE)}), "b", files, True)), "other bytes refuse the run"
    assert refused(lambda: remote_state(FakeS3({f0.key: (f0.data, {}, f0.content_type, RELEASE_CACHE)}), "b", files, False)), "missing metadata"
    assert refused(lambda: remote_state(FakeS3({f0.key: (f0.data, {"sha256": f0.sha256}, "text/plain", RELEASE_CACHE)}), "b", files, False)), "wrong type"
    assert refused(lambda: remote_state(FakeS3({f0.key: (f0.data, {"sha256": f0.sha256}, f0.content_type, "no-cache")}), "b", files, False)), "wrong cache"
    todo, _ = remote_state(FakeS3({f0.key: (f0.data, {}, f0.content_type, RELEASE_CACHE)}), "b", files, True)
    assert f0 in todo, "--fix-metadata re-uploads it"


def test_release_json_is_uploaded_last_and_nothing_after_a_failure(panel, tmp_path):
    folder, legal, _, _ = write_release(tmp_path)
    lr = load_local_release(panel, folder, legal)
    files = lr.pinned + lr.legal + [lr.doc_file]
    s3 = FakeS3()
    assert upload_release(s3, "b", lr, list(reversed(files)), log=quiet) == 0
    assert s3.put_keys[-1] == lr.doc_file.key, "release.json last within the folder"
    assert all(p[2] == RELEASE_CACHE for p in s3.puts)
    assert all(o["Metadata"] == {"sha256": hashlib.sha256(o["Body"]).hexdigest()} for o in s3.objects.values())
    s3 = FakeS3(fail={lr.pinned[2].key})
    assert upload_release(s3, "b", lr, files, log=quiet) == 1
    assert lr.doc_file.key not in s3.objects, "nothing after a failure, release.json above all"
    s3 = FakeS3(corrupt=True)
    assert upload_release(s3, "b", lr, files, log=quiet) == 1, "the HEAD check after each put"
    assert len(s3.puts) == 1


def test_the_release_index_is_the_tools_own_record(panel, tmp_path, monkeypatch):
    monkeypatch.setattr(cdn_config, "utc_now", lambda: "2026-01-02T03:04:05Z")
    folder, legal, _, _ = write_release(tmp_path)
    lr = load_local_release(panel, folder, legal)
    s3 = FakeS3()
    write_release_index(panel, s3, "b", lr, log=quiet)
    (key, ctype, cache, body) = s3.puts[0]
    assert (key, ctype, cache) == (f"{PREFIX}index.json", "application/json", "no-cache")
    idx = json.loads(body)
    assert idx["releases"][RID]["publishedAt"] == "2026-01-02T03:04:05Z"
    assert body == json.dumps(idx, indent=1).encode()


def test_the_pointer_block_key_order_is_fixed(panel, tmp_path):
    folder, legal, _, _ = write_release(tmp_path)
    lr = load_local_release(panel, folder, legal)
    block = pointer_block(lr, "0.3.0", None)
    assert list(block) == ["id", "path", "sha256", "minimumExtensionVersion"]
    assert block["sha256"] == hashlib.sha256((folder / "release.json").read_bytes()).hexdigest()
    assert list(pointer_block(lr, "0.3.0", "0.5.0")) == ["id", "path", "sha256", "minimumExtensionVersion", "maximumExtensionVersion"]
    assert "geometric" not in pointer_block(lr, "0.3.0", None, "c" * 64), "no geometric file: no geometric block"
    from cardvision.cdn.release import ReleaseFile
    lr.geometric = ReleaseFile(f"{PREFIX}{RID}/geometric.json", b"{}", hashlib.sha256(b"{}").hexdigest(), "application/json")
    block = pointer_block(lr, "0.3.0", "0.5.0", "c" * 64)
    assert list(block) == ["id", "path", "sha256", "minimumExtensionVersion", "maximumExtensionVersion", "geometric"]
    assert list(block["geometric"]) == ["path", "sha256", "manifestSha256"]


def test_the_bundled_release_is_read_from_the_build(panel, tmp_path):
    assert bundled_release_id(panel) is None
    (tmp_path / "dist" / "release").mkdir(parents=True)
    (tmp_path / "dist" / "release" / "release.json").write_text(json.dumps({"id": RID}))
    assert bundled_release_id(panel) == RID


def test_the_node_check_runs_the_vendored_script(tmp_path):
    calls = []

    def run(cmd, **k):
        calls.append(cmd)
        return SimpleNamespace(stdout='log line\n{"ok": true, "id": "x"}\n', stderr="")
    p = product(PANEL_CONFIG, tmp_path)
    assert node_verify(p, ["--dir", "D", "--expect-id", RID], run=run) == {"ok": True, "id": "x"}
    assert calls[0] == ["node", str(tmp_path / "vendor" / "cardvision-browser" / "node" / "verify-release.mjs"),
                        "--dir", "D", "--expect-id", RID, "--user-agent", "examplepanel-cdn-verify/1"], "the product's agent"
    ua = product({**PANEL_CONFIG, "runtime": {"userAgent": "example-verify/1", "dir": "scripts", "verifyScript": "check.mjs"}}, tmp_path)
    node_verify(ua, ["--url", "U"], run=run)
    assert calls[1] == ["node", str(tmp_path / "scripts" / "check.mjs"), "--url", "U", "--user-agent", "example-verify/1"]
    none = product({**PANEL_CONFIG, "runtime": {"userAgent": False}}, tmp_path)
    node_verify(none, ["--url", "U"], run=run)
    assert calls[2][-2:] == ["--url", "U"], "userAgent false: no option"
    refusal = '{"ok": false, "id": null, "bankEntries": null, "bankCards": null, "catalogCards": null, "sessions": null, "reason": "bad url"}'
    out = node_verify(p, [], run=lambda cmd, **k: SimpleNamespace(stdout="x\n" + refusal + "\n", stderr=""))
    assert out["ok"] is False and out["reason"] == "bad url", "the full shape with nulls"
    out = node_verify(p, [], run=lambda cmd, **k: SimpleNamespace(stdout="", stderr="boom"))
    assert out["ok"] is False and "boom" in out["reason"]


# ---------------------------------------------------------------------------- verify-release-live

@pytest.fixture
def live(panel, tmp_path):
    folder, legal, doc, refs = write_release(tmp_path)
    lr = load_local_release(panel, folder, legal)
    files = lr.pinned + lr.legal + [lr.doc_file]
    served = {f"{PREFIX}{RID}/{f.key.rsplit('/', 1)[1]}": f for f in files}

    def fake_get(url, origin=None, method="GET", headers=None, cors=True, sha_ok=True, pointer=True, legal_ok=True):
        path = url.split("cdn.example.org/", 1)[1].split("?")[0]
        if path == CONFIG_KEY:
            return 200, {"content-type": "application/json"}, json.dumps({**EXAMPLE_SETTINGS, **({"release": pointer_block(lr, "0.3.0", None)} if pointer else {})}).encode()
        f = served.get(path)
        if not f:
            return 404, {}, b""
        h = {"content-type": f.content_type, "cache-control": RELEASE_CACHE}
        if cors and origin:
            h["access-control-allow-origin"] = origin
        if headers and f.content_type == "application/json":
            h["content-encoding"] = "zstd"
        data = f.data if sha_ok or not path.endswith("bank.json") else b"x"
        return 200, h, (b"changed" if not legal_ok and path.endswith("NOTICE") else data)
    return SimpleNamespace(lr=lr, get=fake_get, legal_shas={f.key.rsplit("/", 1)[1]: f.sha256 for f in lr.legal}, doc=doc)


def test_verify_release_live(panel, live, capsys):
    ids = ["e" * 32]
    vl = lambda **k: verify_release_live(panel, BASE, **{"get": live.get, "node": node_ok, "extension_ids": ids, **k})
    assert vl() == 0
    assert vl(candidate=RID, expect_files=live.legal_shas) == 0
    assert vl(candidate=RID, get=lambda *a, **k: live.get(*a, **k, legal_ok=False), expect_files=live.legal_shas) > 0, "a legal file changed"
    assert vl(extension_ids=[]) > 0, "no extension ids"
    assert vl(get=lambda *a, **k: live.get(*a, **k, cors=False)) > 0
    assert vl(get=lambda *a, **k: live.get(*a, **k, sha_ok=False)) > 0
    assert vl(node=lambda a: {"ok": False, "reason": "x"}) > 0
    assert vl(expect_id="ffffffffffffffff") > 0
    assert vl(expect_id=RID, get=lambda *a, **k: live.get(*a, **k, pointer=False)) > 0, "expected a pointer, none live"
    assert vl(get=lambda *a, **k: live.get(*a, **k, pointer=False)) == 0, "no pointer, none expected"
    assert vl(candidate="NOTANID") == 1
    assert "geometric stage off" not in capsys.readouterr().out, "no geometric note for a product without the stage"


def test_the_extension_ids_come_from_the_product_environment(panel, live, monkeypatch, capsys):
    monkeypatch.delenv("EXAMPLECDN_EXTENSION_IDS", raising=False)
    assert verify_release_live(panel, BASE, get=live.get, node=node_ok) > 0
    assert "EXAMPLECDN_EXTENSION_IDS is not set" in capsys.readouterr().out
    monkeypatch.setenv("EXAMPLECDN_EXTENSION_IDS", "e" * 32 + ", " + "f" * 32)
    assert verify_release_live(panel, BASE, get=live.get, node=node_ok) == 0


def test_the_node_check_is_asked_for_the_url_and_sessions(panel, live):
    asked = []
    verify_release_live(panel, BASE, get=live.get, node=lambda a: (asked.append(a), node_ok(a))[1], extension_ids=["e" * 32], sessions=True)
    assert asked == [["--url", f"{BASE}/{PREFIX}{RID}/release.json", "--expect-id", RID, "--sessions"]]
