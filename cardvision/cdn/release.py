# SPDX-License-Identifier: Apache-2.0
"""Remote releases: the local seal of a release folder, the runtime table, the remote state through
the S3 API, the upload order within the folder, and the pointer block config.json carries."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from cardvision.cdn import config as _config
from cardvision.cdn.config import IMMUTABLE_CACHE, INDEX_CACHE, CdnConfig, Refused
from cardvision.cdn.settings import RELEASE_ID, VERSION_RE

RELEASE_CACHE = IMMUTABLE_CACHE
# Published beside the weights: the release's license, notice and provenance.
LEGAL_TYPES = {"LICENSE": "text/plain; charset=utf-8", "NOTICE": "text/plain; charset=utf-8",
               "PROVENANCE.md": "text/markdown; charset=utf-8"}
FLAT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
# Pinned files served as bytes: the models and a bank in binary form (bank.bin). The rest are JSON.
BINARY_SUFFIXES = (".onnx", ".bin")


def pinned_content_type(path: str) -> str:
    """The Content-Type a pinned file is uploaded and served with."""
    return "application/octet-stream" if path.endswith(BINARY_SUFFIXES) else "application/json"


def version_tuple(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


@dataclass
class ReleaseFile:
    key: str
    data: bytes
    sha256: str
    content_type: str


@dataclass
class LocalRelease:
    id: str
    doc: dict
    doc_bytes: bytes
    pinned: list[ReleaseFile]
    legal: list[ReleaseFile]
    prefix: str = "vision/releases/"
    # The geometric stage's settings file, published as <prefix><id>/geometric.json.
    geometric: Optional[ReleaseFile] = None

    @property
    def doc_file(self) -> ReleaseFile:
        return ReleaseFile(f"{self.prefix}{self.id}/release.json", self.doc_bytes,
                           hashlib.sha256(self.doc_bytes).hexdigest(), "application/json")


def pinned_refs(doc: dict) -> list[dict]:
    return [doc.get("detector"), doc.get("recognizer"), doc.get("bank"), (doc.get("identity") or {}).get("groups"), doc.get("catalog")]


def load_local_release(product: CdnConfig, folder: Path, legal_dir: Path) -> LocalRelease:
    """The local seal: the document parses, its id is the folder's name, every pinned file is a flat
    name present with its size and SHA-256, and the legal files name this release."""
    folder, legal_dir = Path(folder), Path(legal_dir)
    prefix = product.releases_prefix
    doc_path = folder / "release.json"
    if not doc_path.is_file():
        raise Refused(f"{doc_path}: no release document")
    doc_bytes = doc_path.read_bytes()
    if len(doc_bytes) > product.max_document_bytes:
        raise Refused(f"{doc_path}: {len(doc_bytes)} bytes; the extension reads a release document only up to {product.max_document_bytes}")
    try:
        doc = json.loads(doc_bytes)
    except json.JSONDecodeError:
        raise Refused(f"{doc_path}: not JSON")
    rid = doc.get("id") if isinstance(doc, dict) else None
    if not isinstance(rid, str) or not RELEASE_ID.match(rid):
        raise Refused(f"{doc_path}: no 16-hex release id")
    if folder.resolve().name != rid:
        raise Refused(f"the release folder is named {folder.resolve().name!r}; name it after its id ({rid}) so that the "
                      "CDN folder and the local one are the same")
    pinned = []
    for ref in pinned_refs(doc):
        if not isinstance(ref, dict) or not isinstance(ref.get("path"), str):
            raise Refused(f"{doc_path}: a pinned file is missing")
        path = ref["path"]
        if not FLAT_NAME_RE.match(path):
            raise Refused(f"{doc_path}: pinned path {path!r} is not a flat name (letters, digits, '.', '_', '-')")
        f = folder / path
        if not f.is_file():
            raise Refused(f"{f}: missing")
        data = f.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        if len(data) != ref.get("bytes") or sha != ref.get("sha256"):
            raise Refused(f"{f}: size or sha256 differs from the release document")
        pinned.append(ReleaseFile(f"{prefix}{rid}/{path}", data, sha, pinned_content_type(path)))
    legal = []
    for name, ctype in LEGAL_TYPES.items():
        f = legal_dir / name
        if not f.is_file():
            raise Refused(f"{f}: missing (the release's license files go beside its weights)")
        data = f.read_bytes()
        legal.append(ReleaseFile(f"{prefix}{rid}/{name}", data, hashlib.sha256(data).hexdigest(), ctype))
    notice_first = legal[1].data.decode("utf-8").split("\n", 1)[0]
    if rid not in notice_first:
        raise Refused(f"{legal_dir / 'NOTICE'}: its first line does not name release {rid}; update NOTICE and PROVENANCE.md "
                      "for this release (as for a build) before publishing it")
    return LocalRelease(rid, doc, doc_bytes, pinned, legal, prefix)


def load_runtimes(product: CdnConfig) -> dict:
    return json.loads(product.runtimes_path.read_text())


def runtime_problems(doc: dict, min_v: str, max_v: Optional[str], runtimes: dict,
                     runtimes_label: str = "cdn/RUNTIMES.json") -> list[str]:
    """Every pointer-aware version the pointer would reach can load the release (ONNX Runtime
    major.minor). A version it would not reach is fine; none at all is refused."""
    want = str((doc.get("runtime") or {}).get("ortWeb", ""))
    mm = lambda v: ".".join(v.split(".")[:2])
    reached = [v for v in runtimes if VERSION_RE.match(v) and version_tuple(v) >= version_tuple(min_v) and (max_v is None or version_tuple(v) < version_tuple(max_v))]
    if not reached:
        return [f"no extension version in {runtimes_label} is in [{min_v}, {max_v or '∞'}): nothing would load it"]
    return [f"extension {v} runs onnxruntime-web {runtimes[v]['ortWeb']}, the release needs {want} (major.minor): raise --min-version"
            for v in reached if mm(runtimes[v]["ortWeb"]) != mm(want)]


def remote_state(s3, bucket: str, files: list[ReleaseFile], fix_metadata: bool) -> tuple[list[ReleaseFile], list[ReleaseFile]]:
    """Through the S3 API only (never the public URL, so that no 404 is cached at the edge before
    the upload). Returns (to upload, already there). Another file's bytes under one of the keys
    refuses the whole run before anything is uploaded."""
    upload, there = [], []
    for f in files:
        try:
            head = s3.head_object(Bucket=bucket, Key=f.key)
        except Exception as e:
            code = str(getattr(e, "response", {}).get("Error", {}).get("Code", ""))
            if code in ("404", "NoSuchKey", "NotFound"):
                upload.append(f)
                continue
            raise
        meta = (head.get("Metadata") or {}).get("sha256")
        headers_ok = head.get("ContentType") == f.content_type and head.get("CacheControl") == RELEASE_CACHE
        if meta == f.sha256 and head.get("ContentLength") == len(f.data) and headers_ok:
            there.append(f)
            continue
        if meta != f.sha256 or head.get("ContentLength") != len(f.data):
            body = s3.get_object(Bucket=bucket, Key=f.key)["Body"].read()
            if hashlib.sha256(body).hexdigest() != f.sha256:
                raise Refused(f"{f.key} is already on the CDN with other bytes: release folders are never overwritten "
                              "(a changed release is a new id)")
        if not fix_metadata:
            raise Refused(f"{f.key}: same bytes, but its sha256 metadata, Content-Type or Cache-Control is not what "
                          "the contract says; re-run with --fix-metadata")
        upload.append(f)
    return upload, there


def upload_release(s3, bucket: str, lr: LocalRelease, todo: list[ReleaseFile], log: Callable[[str], None] = print) -> int:
    """The pinned and legal files, then geometric.json, then release.json last within the folder;
    each one HEAD-checked. Stops at the first failure: nothing after it is written."""
    doc = lr.doc_file
    geo_key = lr.geometric.key if lr.geometric else None
    order = ([f for f in todo if f.key not in (doc.key, geo_key)] + [f for f in todo if f.key == geo_key]
             + [f for f in todo if f.key == doc.key])
    for f in order:
        try:
            s3.put_object(Bucket=bucket, Key=f.key, Body=f.data, ContentType=f.content_type,
                          CacheControl=RELEASE_CACHE, Metadata={"sha256": f.sha256})
            head = s3.head_object(Bucket=bucket, Key=f.key)
            if head.get("ContentLength") != len(f.data) or (head.get("Metadata") or {}).get("sha256") != f.sha256:
                raise RuntimeError("the uploaded object does not match")
        except Exception as e:
            log(f"FAILED {f.key}: {e}; nothing after it was written. Re-run to retry.")
            return 1
        log(f"release: {f.key} written ({len(f.data)} bytes)")
    return 0


def write_release_index(product: CdnConfig, s3, bucket: str, lr: LocalRelease, log: Callable[[str], None] = print) -> None:
    """The tool's own record of what was published (not part of the contract)."""
    key = product.releases_index_key
    try:
        idx = json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
    except Exception:
        idx = {"schemaVersion": 1, "releases": {}}
    idx.setdefault("releases", {})[lr.id] = {"publishedAt": _config.utc_now(), "bytes": {f.key.rsplit("/", 1)[1]: len(f.data) for f in lr.pinned}}
    s3.put_object(Bucket=bucket, Key=key, Body=json.dumps(idx, indent=1).encode(),
                  ContentType="application/json", CacheControl=INDEX_CACHE)
    log(f"index: {key} written")


def pointer_block(lr: LocalRelease, min_v: str, max_v: Optional[str], geo_manifest_sha: Optional[str] = None) -> dict:
    """The config's `release` field for this release. Key order is part of the bytes:
    id, path, sha256, minimumExtensionVersion[, maximumExtensionVersion][, geometric]."""
    block = {"id": lr.id, "path": f"{lr.prefix}{lr.id}/release.json", "sha256": hashlib.sha256(lr.doc_bytes).hexdigest(),
             "minimumExtensionVersion": min_v}
    if max_v:
        block["maximumExtensionVersion"] = max_v
    if lr.geometric is not None and geo_manifest_sha:
        block["geometric"] = {"path": lr.geometric.key, "sha256": lr.geometric.sha256, "manifestSha256": geo_manifest_sha}
    return block


def bundled_release_id(product: CdnConfig) -> Optional[str]:
    """The id of the release the current build bundles, when there is one."""
    try:
        return json.loads(product.bundled_document.read_text()).get("id")
    except Exception:
        return None
