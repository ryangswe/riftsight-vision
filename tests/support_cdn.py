# SPDX-License-Identifier: Apache-2.0
"""Fakes shared by the ``cardvision cdn`` tests: two made-up products, a bucket, a public CDN and
a release folder.

Nothing here is real: the products, their environment prefixes and their host (cdn.example.org)
are placeholders, the credentials are repeated letters, and every file is a few made-up bytes. No
test reaches the network: S3 is ``FakeS3``, HTTPS a ``get`` callable over a dict, and Node a
``node`` callable; ``no_urlopen`` fails a test that fetches without an injected ``get``.
"""

from __future__ import annotations

import hashlib
import io
import json
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

import pytest

from cardvision.cdn.config import CdnConfig, cdn_config_from_dict

BASE = "https://cdn.example.org"
RID = "0123456789abcdef"
FORBIDDEN = ["otherproject", "anotherbrand"]

# A product with a data file and a page, and no geometric stage.
PANEL_CONFIG = {
    "schemaVersion": 1,
    "product": "examplepanel",
    "envPrefix": "EXAMPLECDN",
    "forbiddenWords": FORBIDDEN,
    "settings": {"obsoleteCardLink": False},
    "dataFiles": {"details": {"prefix": "data/", "namePattern": "details-<sha8>.json", "schemaVersion": 1,
                              "requiredObjectKeys": ["cards"], "maxBytes": 33554432}},
    "pages": ["privacy.html"],
    "geometric": False,
}
# A product with the geometric stage, the {sourceFile} placeholder and the obsolete cardLink check.
GEO_CONFIG = {
    "schemaVersion": 1,
    "product": "examplegeo",
    "envPrefix": "EXAMPLEGEO",
    "userAgent": "example-geo-verify/1",
    "forbiddenWords": FORBIDDEN,
    "settings": {"placeholders": ["{art}", "{file}", "{cardId}", "{printedId}", "{sourceFile}"], "obsoleteCardLink": True},
    "dataFiles": {},
    "pages": [],
    "geometric": True,
}
# The settings file both products start from (a primary on cdn.example.org, no fallback).
EXAMPLE_SETTINGS = {
    "schemaVersion": 1,
    "updatedAt": "2026-01-01T00:00:00Z",
    "namesOnly": False,
    "primary": {"id": "cdn", "template": "https://cdn.example.org/art/{art}"},
    "fallbacks": [],
}


def product(raw: dict, root: Path) -> CdnConfig:
    return cdn_config_from_dict(json.loads(json.dumps(raw)), root)


def env_for(p: CdnConfig, **overrides) -> dict:
    env = {p.env("R2_ACCOUNT_ID"): "a" * 32, p.env("R2_ACCESS_KEY_ID"): "b" * 32,
           p.env("R2_SECRET_ACCESS_KEY"): "c" * 64, p.env("PUBLIC_BASE"): BASE, p.env("BUCKET"): "example-bucket"}
    env.update({p.env(k): v for k, v in overrides.items()})
    return env


def refused(fn) -> bool:
    from cardvision.cdn.config import Refused
    try:
        fn()
    except Refused:
        return True
    return False


@pytest.fixture
def no_urlopen(monkeypatch):
    """A fetch without an injected `get` fails the test instead of trying the network."""
    def refuse(*a, **k):
        raise AssertionError("urllib.request.urlopen called: every test injects its get=")
    monkeypatch.setattr(urllib.request, "urlopen", refuse)


class NoKey(Exception):
    response = {"Error": {"Code": "404"}}


class FakeS3:
    """A bucket in memory: key -> {Body, ContentType, CacheControl, Metadata}.

    `fail` keys (or key suffixes) raise on put; `corrupt` stores other bytes than were sent;
    list_objects_v2 returns two keys a page, so that paging is exercised."""

    def __init__(self, objects: Optional[dict] = None, fail=(), corrupt: bool = False):
        self.objects: dict[str, dict] = {}
        for k, v in (objects or {}).items():
            body, meta, *rest = v
            self.objects[k] = {"Body": body, "Metadata": meta, "ContentType": (rest + [None, None])[0],
                               "CacheControl": (rest + [None, None])[1]}
        self.fail = set(fail)
        self.corrupt = corrupt
        self.puts: list[tuple] = []
        self.copies: list[str] = []

    def _fails(self, key: str) -> bool:
        return any(key == f or key.endswith(f) for f in self.fail)

    def put_object(self, *, Bucket, Key, Body, ContentType, CacheControl, Metadata=None):
        if self._fails(Key):
            raise RuntimeError("boom")
        self.puts.append((Key, ContentType, CacheControl, Body))
        self.objects[Key] = {"Body": Body + b"!" if self.corrupt else Body, "ContentType": ContentType,
                             "CacheControl": CacheControl, "Metadata": Metadata or {}}

    def head_object(self, *, Bucket, Key):
        o = self.objects.get(Key)
        if o is None:
            raise NoKey()
        return {"ContentLength": len(o["Body"]), "Metadata": dict(o.get("Metadata") or {}),
                "ContentType": o.get("ContentType"), "CacheControl": o.get("CacheControl")}

    def get_object(self, *, Bucket, Key):
        if Key not in self.objects:
            raise NoKey()
        return {"Body": io.BytesIO(self.objects[Key]["Body"])}

    def list_objects_v2(self, *, Bucket, Prefix, ContinuationToken=None):
        keys = sorted(k for k in self.objects if k.startswith(Prefix))
        start = int(ContinuationToken or 0)
        page = keys[start:start + 2]
        more = start + 2 < len(keys)
        return {"Contents": [{"Key": k} for k in page], "IsTruncated": more,
                **({"NextContinuationToken": str(start + 2)} if more else {})}

    def copy_object(self, *, Bucket, Key, CopySource, MetadataDirective, ContentType, CacheControl, Metadata):
        assert CopySource == {"Bucket": Bucket, "Key": Key} and MetadataDirective == "REPLACE"
        self.copies.append(Key)
        self.objects[Key].update(ContentType=ContentType, CacheControl=CacheControl, Metadata=Metadata)

    @property
    def put_keys(self) -> list[str]:
        return [p[0] for p in self.puts]


def store_get(store: dict, base: str = BASE):
    """A public CDN over a dict: path -> (status, headers, body); anything else is a 404."""
    import urllib.parse

    def get(url, origin=None, method="GET", headers=None):
        key = urllib.parse.unquote(url[len(base) + 1:].split("?")[0])
        return store.get(key, (404, {}, b""))
    return get


def node_ok(args):
    return {"ok": True, "id": RID, "bankEntries": 1, "bankCards": 1, "catalogCards": 1, "sessions": "skipped"}


def write_release(tmp: Path, notice: Optional[str] = None) -> tuple[Path, Path, dict, dict]:
    """A release folder named after its id, its legal folder, its document and its pinned refs."""
    folder, legal = tmp / RID, tmp / "legal"
    folder.mkdir()
    legal.mkdir()
    refs = {}
    for key, name in (("detector", "detector.onnx"), ("recognizer", "recognizer.onnx"), ("bank", "bank.json"),
                      ("groups", "identity-groups.json"), ("catalog", "catalog.json")):
        data = f"{name}-bytes".encode()
        (folder / name).write_bytes(data)
        refs[key] = {"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    doc = {"id": RID, "detector": refs["detector"], "recognizer": refs["recognizer"], "bank": refs["bank"],
           "identity": {"groups": refs["groups"]}, "catalog": refs["catalog"], "runtime": {"ortWeb": "1.29.0"}}
    (folder / "release.json").write_text(json.dumps(doc))
    (legal / "LICENSE").write_text("license")
    (legal / "NOTICE").write_text(notice or f"Example models (release {RID})\nmore")
    (legal / "PROVENANCE.md").write_text("provenance")
    return folder, legal, doc, refs


def same_models(refs: dict) -> dict:
    return {"0.3.0": {"ortWeb": "1.29.0", "bundledRelease": {"id": "f" * 16, "detectorSha256": refs["detector"]["sha256"],
                                                             "recognizerSha256": refs["recognizer"]["sha256"]}}}


def new_models(refs: dict) -> dict:
    return {"0.3.0": {"ortWeb": "1.29.0", "bundledRelease": {"id": "f" * 16, "detectorSha256": "1" * 64,
                                                             "recognizerSha256": refs["recognizer"]["sha256"]}}}


def release_args(folder: Path, legal: Path, config: Optional[Path], **overrides) -> SimpleNamespace:
    args = dict(release=str(folder), legal=str(legal), min_version="0.3.0", max_version=None, sessions=False,
                fix_metadata=False, dry_run=True, data_files=None, geometric=None, geo_manifest_sha256=None,
                config=str(config) if config else None, set_pointer=False)
    args.update(overrides)
    return SimpleNamespace(**args)


def quiet(_message: str) -> None:
    pass
