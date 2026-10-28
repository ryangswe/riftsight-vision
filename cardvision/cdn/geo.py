# SPDX-License-Identifier: Apache-2.0
"""The geometric stage's index on the CDN (products with ``"geometric": true``): the packed index
folder (``publish-geo``, ``verify-geo``), its one-layout-per-folder rule, and a release's binding to
it (the settings file's index on this CDN, the manifest pinned, bound to the release's bank)."""

from __future__ import annotations

import hashlib
import json
import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from cardvision.cdn.config import IMMUTABLE_CACHE, Refused

GEO_PREFIX = "vision/geo/"
GEO_CACHE = IMMUTABLE_CACHE
GEO_SHARD = re.compile(r"shard-[0-9]+\.bin")
HEX64 = re.compile(r"[0-9a-f]{64}")
# Where a pointer's geometric index manifest may be: a flat folder, written once (manifest.json,
# cardvision pack-features), or a series folder that grows (manifest-<16 hex>.json).
GEO_MANIFEST_PATH = re.compile(r"^/vision/geo/[0-9a-f]{16}/(manifest\.json|manifest-[0-9a-f]{16}\.json)$")
GEO_SERIES_FILE = re.compile(r"(manifest|shard)-[0-9a-f]{16}\.(json|bin)")
MAX_GEOMETRIC_BYTES = 256 * 1024


def geo_index_key(settings: object, public_base: str) -> str:
    """A geometric settings file (parsed): its index manifest is on the settings host, in a flat or
    a series folder under vision/geo/. Returns the manifest's bucket key; refuses otherwise."""
    path = settings.get("index", {}).get("path") if isinstance(settings, dict) and isinstance(settings.get("index"), dict) else None
    if not isinstance(path, str):
        raise Refused("the geometric settings file has no index.path")
    u = urllib.parse.urlsplit(path)
    base = urllib.parse.urlsplit(public_base)
    if (u.scheme, u.netloc) != (base.scheme, base.netloc) or u.query or u.fragment or not GEO_MANIFEST_PATH.match(u.path):
        raise Refused(f"index.path {path!r} is not a manifest on {public_base} under vision/geo/<16 hex>/ "
                      "(manifest.json or manifest-<16 hex>.json): installs would run the release with the stage off")
    return u.path.lstrip("/")


def geo_binding_problems(manifest: object, bank: object) -> list[str]:
    """The packed index serves the release's bank: the same SHA-256."""
    if not isinstance(manifest, dict) or manifest.get("kind") != "geometric-index-packed":
        return ["the index manifest is not a packed geometric index"]
    problems = []
    if (manifest.get("bank") or {}).get("sha256") != (bank or {}).get("sha256"):
        problems.append(f"the index is bound to bank {(manifest.get('bank') or {}).get('sha256')}, the release's bank is {(bank or {}).get('sha256')}")
    return problems


def geo_cover_problem(manifest: dict, bank_bytes: bytes) -> Optional[str]:
    """A row in the index for every bank card. The bank may be in either form, JSON or binary."""
    from cardvision.core.bank_binary import read_bank_bytes

    try:
        ids = {e["cardId"] for e in read_bank_bytes(bank_bytes)["entries"]}
    except Exception:
        return "the release's bank could not be read for its card ids"
    missing = ids - {c.get("cardId") for c in manifest.get("cards", []) if isinstance(c, dict)}
    return f"the index has no row for {len(missing)} bank card(s), e.g. {sorted(missing)[:3]}" if missing else None


@dataclass
class GeoFile:
    name: str           # file name in the folder (manifest.json, shard-N.bin)
    data: bytes
    sha256: str
    content_type: str


def geo_plan(folder: Path, expect_sha256: str) -> tuple[str, list[GeoFile]]:
    """The packed index of `cardvision pack-features` in `folder`: its manifest must have the
    SHA-256 the extension pins (`expect_sha256`), and every shard the manifest names must be
    present with its SHA-256. Returns the CDN folder, `vision/geo/<first 16 hex of the source
    index's sha256>/`, and the files to upload, shards first and the manifest last."""
    folder = Path(folder)
    if not HEX64.fullmatch(expect_sha256 or ""):
        raise Refused("--expect-sha256 must be 64 lowercase hex digits (the manifest's SHA-256 the extension pins)")
    mpath = folder / "manifest.json"
    if not mpath.is_file():
        raise Refused(f"{mpath}: missing")
    mbytes = mpath.read_bytes()
    msha = hashlib.sha256(mbytes).hexdigest()
    if msha != expect_sha256:
        raise Refused(f"manifest.json has SHA-256 {msha}, not the expected {expect_sha256}")
    try:
        m = json.loads(mbytes)
    except json.JSONDecodeError as e:
        raise Refused(f"manifest.json is not JSON ({e})")
    if not isinstance(m, dict) or m.get("schemaVersion") != 1 or m.get("kind") != "geometric-index-packed":
        raise Refused("manifest.json is not a packed geometric index (schemaVersion 1, kind geometric-index-packed)")
    source = (m.get("source") or {}).get("sha256") if isinstance(m.get("source"), dict) else None
    if not isinstance(source, str) or not HEX64.fullmatch(source):
        raise Refused("manifest.json: source.sha256 must be 64 lowercase hex digits")
    shards = m.get("shards")
    if not isinstance(shards, list) or not shards:
        raise Refused("manifest.json: shards must be a non-empty list")
    files: list[GeoFile] = []
    seen: set[str] = set()
    for i, sh in enumerate(shards):
        name = sh.get("path") if isinstance(sh, dict) else None
        sha = sh.get("sha256") if isinstance(sh, dict) else None
        if not isinstance(name, str) or not GEO_SHARD.fullmatch(name) or name in seen:
            raise Refused(f"manifest.json: shards[{i}].path must be a distinct shard-N.bin name")
        if not isinstance(sha, str) or not HEX64.fullmatch(sha):
            raise Refused(f"manifest.json: shards[{i}].sha256 must be 64 lowercase hex digits")
        seen.add(name)
        p = folder / name
        if not p.is_file():
            raise Refused(f"{p}: missing")
        data = p.read_bytes()
        got = hashlib.sha256(data).hexdigest()
        if got != sha:
            raise Refused(f"{name}: SHA-256 {got}, the manifest says {sha}")
        files.append(GeoFile(name, data, sha, "application/octet-stream"))
    files.append(GeoFile("manifest.json", mbytes, msha, "application/json"))
    return f"{GEO_PREFIX}{source[:16]}/", files


def remote_head(s3, bucket: str, key: str) -> Optional[dict]:
    """HEAD of an object, or None when there is none."""
    try:
        return s3.head_object(Bucket=bucket, Key=key)
    except Exception as e:  # botocore's ClientError 404; anything else is a real error
        code = str(getattr(e, "response", {}).get("Error", {}).get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound"):
            return None
        raise


def _remote_sha(s3, bucket: str, key: str, head: dict) -> str:
    """The object's SHA-256: from the metadata this tool writes, else by reading it."""
    meta = {k.lower(): v for k, v in (head.get("Metadata") or {}).items()}
    if HEX64.fullmatch(meta.get("sha256", "")):
        return meta["sha256"]
    return hashlib.sha256(s3.get_object(Bucket=bucket, Key=key)["Body"].read()).hexdigest()


def _metadata_problems(head: dict, f: GeoFile) -> list[str]:
    out = []
    if head.get("ContentType") != f.content_type:
        out.append(f"content-type {head.get('ContentType')!r}, want {f.content_type!r}")
    if head.get("CacheControl") != GEO_CACHE:
        out.append(f"cache-control {head.get('CacheControl')!r}, want {GEO_CACHE!r}")
    return out


def _check(s3, bucket: str, key: str, f: GeoFile) -> Optional[str]:
    """Why the object at `key` is not exactly `f` (bytes, type, caching), or None."""
    head = remote_head(s3, bucket, key)
    if head is None:
        return "missing"
    if head.get("ContentLength") != len(f.data) or _remote_sha(s3, bucket, key, head) != f.sha256:
        return "other bytes"
    problems = _metadata_problems(head, f)
    return "; ".join(problems) if problems else None


def geo_layout_problem(s3, bucket: str, folder: str, flat: bool) -> Optional[str]:
    """An index folder holds one layout only: a flat index (manifest.json and shard-N.bin, written
    once) or a series (manifest-<16 hex>.json and shard-<16 hex>.bin, grown by appending). Writing
    one kind into a folder that holds the other is refused: the browser's cache keeps everything
    under the loaded manifest's folder, so the other kind's shards would never be freed. Listed
    through the S3 API."""
    names, token = [], None
    while True:
        page = s3.list_objects_v2(Bucket=bucket, Prefix=folder, **({"ContinuationToken": token} if token else {}))
        names += [o["Key"][len(folder):] for o in page.get("Contents", [])]
        if not page.get("IsTruncated"):
            break
        token = page.get("NextContinuationToken")
    if flat:
        series = [n for n in names if GEO_SERIES_FILE.fullmatch(n)]
        return f"{folder} holds a series index ({series[0]}…); a flat index never goes into a series folder" if series else None
    return f"{folder} holds a flat index (manifest.json); a series never starts in a flat folder" if "manifest.json" in names else None


def publish_geo(s3, bucket: str, folder: str, files: list[GeoFile], dry_run: bool = False,
                fix_metadata: bool = False, log: Callable[[str], None] = print) -> int:
    """Upload the index under `folder`, shards first, then the manifest only once every shard is
    checked (size, SHA-256, Content-Type, Cache-Control). Nothing is ever overwritten with other
    bytes: such an object refuses the run before anything is uploaded. An object with the same
    bytes but the wrong Content-Type or Cache-Control refuses it too, unless `fix_metadata`,
    which rewrites its metadata in place (a copy onto itself; the bytes do not change). Returns
    the number of failures (0: all published and checked)."""
    layout = geo_layout_problem(s3, bucket, folder, flat=True)
    if layout:
        raise Refused(layout)
    todo: list[GeoFile] = []
    to_fix: list[GeoFile] = []
    wrong_meta: list[str] = []
    for f in files:
        key = folder + f.name
        head = remote_head(s3, bucket, key)
        if head is None:
            todo.append(f)
            continue
        if head.get("ContentLength") != len(f.data) or _remote_sha(s3, bucket, key, head) != f.sha256:
            raise Refused(f"{key} is already on the CDN with other bytes; an index folder is never overwritten")
        problems = _metadata_problems(head, f)
        if problems:
            wrong_meta.append(f"{key}: {'; '.join(problems)}")
            to_fix.append(f)
        else:
            log(f"same  {key} (already there)")
    if wrong_meta and not fix_metadata:
        raise Refused("already on the CDN with the right bytes but wrong metadata (re-run with --fix-metadata to "
                      "rewrite the metadata only): " + " | ".join(wrong_meta))
    for f in todo:
        log(f"{'would upload' if dry_run else 'upload'} {folder + f.name} ({len(f.data)} bytes)")
    for f in to_fix:
        log(f"{'would fix metadata of' if dry_run else 'fix metadata of'} {folder + f.name}")
    if dry_run:
        log(f"dry run: {len(todo)} to upload, {len(to_fix)} to fix, {len(files) - len(todo) - len(to_fix)} already there; nothing changed")
        return 0

    def put(f: GeoFile) -> Optional[str]:
        key = folder + f.name
        try:
            if f in to_fix:
                s3.copy_object(Bucket=bucket, Key=key, CopySource={"Bucket": bucket, "Key": key}, MetadataDirective="REPLACE",
                               ContentType=f.content_type, CacheControl=GEO_CACHE, Metadata={"sha256": f.sha256})
            elif f in todo:
                s3.put_object(Bucket=bucket, Key=key, Body=f.data, ContentType=f.content_type,
                              CacheControl=GEO_CACHE, Metadata={"sha256": f.sha256})
        except Exception as e:
            return f"upload failed: {e}"
        return _check(s3, bucket, key, f)

    shards = [f for f in files if f.name != "manifest.json"]
    manifest = [f for f in files if f.name == "manifest.json"]
    bad = 0
    for f in shards:
        problem = put(f)
        if problem:
            bad += 1
            log(f"FAILED {folder + f.name}: {problem}")
        else:
            log(f"ok    {folder + f.name}")
    if bad:
        # A manifest is never live before every shard it names is there and right.
        log(f"{bad} shard(s) failed; manifest.json NOT uploaded. Re-run to retry.")
        return bad
    for f in manifest:
        problem = put(f)
        if problem:
            bad += 1
            log(f"FAILED {folder + f.name}: {problem}")
        else:
            log(f"ok    {folder + f.name}")
    return bad


def check_release_geometric(s3, bucket: str, public_base: str, settings_bytes: bytes, manifest_sha: Optional[str],
                            bank_ref: object, bank_bytes: bytes) -> tuple[str, dict]:
    """publish-release --geometric, before anything is uploaded: the settings file is small JSON
    whose index is on this CDN (rule above), already published with publish-geo, in a folder of
    its own layout, with the pinned manifest SHA-256, bound to the release's bank and covering
    every bank card. Returns (manifest key, manifest)."""
    if not manifest_sha or not HEX64.fullmatch(manifest_sha):
        raise Refused("--geometric needs --geo-manifest-sha256 (64 lowercase hex: the packed index's manifest.json)")
    if len(settings_bytes) > MAX_GEOMETRIC_BYTES:
        raise Refused(f"the geometric settings file is over {MAX_GEOMETRIC_BYTES} bytes")
    try:
        settings = json.loads(settings_bytes)
    except json.JSONDecodeError:
        raise Refused("the geometric settings file is not JSON")
    mkey = geo_index_key(settings, public_base)
    # The index goes first (publish-geo), immutable; it must be there, pinned and bound to this bank.
    if remote_head(s3, bucket, mkey) is None:
        raise Refused(f"{mkey}: the index is not on the CDN; publish it first (publish-geo)")
    mfolder, mname = mkey.rsplit("/", 1)
    layout = geo_layout_problem(s3, bucket, mfolder + "/", flat=(mname == "manifest.json"))
    if layout:
        raise Refused(layout)
    mbytes = s3.get_object(Bucket=bucket, Key=mkey)["Body"].read()
    if hashlib.sha256(mbytes).hexdigest() != manifest_sha:
        raise Refused(f"{mkey}: its sha256 is not --geo-manifest-sha256")
    m = json.loads(mbytes)
    problems = geo_binding_problems(m, bank_ref)
    cover = geo_cover_problem(m, bank_bytes)
    if problems or cover:
        raise Refused("unbound: " + "; ".join(problems + ([cover] if cover else [])))
    return mkey, m
