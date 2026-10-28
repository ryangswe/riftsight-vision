# SPDX-License-Identifier: Apache-2.0
"""Card pictures: the catalog's art paths, the local images, the plan against the live index, and
the upload order (images, the index of what landed, data files, a page, config.json last)."""

from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Optional, Sequence

from cardvision.cdn import config as _config
from cardvision.cdn.config import CONFIG_CACHE, CONFIG_KEY, CONTENT_TYPES, INDEX_CACHE, PAGE_CACHE, CdnConfig, Refused
from cardvision.cdn.settings import DataFile, PageFile


def catalog_art_paths(catalog: object) -> tuple[dict[str, list[str]], int]:
    """Map art path -> card ids, and count art-less cards. Accepts a list of entries, or an
    object whose `cards` is a list or an id-keyed object."""
    if isinstance(catalog, dict) and "cards" in catalog:
        catalog = catalog["cards"]
    if isinstance(catalog, dict):
        entries = [(k, v) for k, v in catalog.items()]
    elif isinstance(catalog, list):
        entries = [(None, v) for v in catalog]
    else:
        raise Refused("catalog: expected a list of entries or an object with `cards`")
    paths: dict[str, list[str]] = {}
    artless = 0
    for key, entry in entries:
        if not isinstance(entry, dict):
            raise Refused(f"catalog: entry {key!r} is not an object")
        card_id = entry.get("id") or entry.get("cardId") or key
        if not isinstance(card_id, str) or not card_id:
            raise Refused(f"catalog: entry without an id: {json.dumps(entry)[:120]}")
        if "art" not in entry:
            raise Refused(f"catalog: {card_id} has no `art` field (null means no art)")
        art = entry["art"]
        if art is None:
            artless += 1
            continue
        check_art_path(art, card_id)
        paths.setdefault(art, []).append(card_id)
    return paths, artless


def check_art_path(art: object, card_id: str) -> None:
    if not isinstance(art, str) or not art:
        raise Refused(f"catalog: {card_id} art is not a non-empty string")
    p = PurePosixPath(art)
    if art.startswith("/") or "\\" in art or any(part in ("", ".", "..") for part in art.split("/")):
        raise Refused(f"catalog: {card_id} art path {art!r} is not a clean relative path")
    if p.suffix.lower() not in CONTENT_TYPES:
        raise Refused(f"catalog: {card_id} art {art!r} is not jpg/png/webp")


def sniff_type(data: bytes) -> Optional[str]:
    """The image's real content type from its bytes, whatever its file name says (mirrors keep
    upstream names, and a `.jpg` may hold PNG or WebP bytes). None = not an image we serve."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def head_repr(data: bytes) -> str:
    return repr(data[:16])[2:-1]


@dataclass
class LocalFile:
    path: str          # art path == key under the art prefix
    file: Path
    sha256: str
    bytes: int
    content_type: str  # from the bytes, not the name


def scan_images(paths: dict[str, list[str]], images: Path, max_bytes: int) -> list[LocalFile]:
    root = Path(images).resolve()
    problems: list[str] = []
    out: list[LocalFile] = []
    for art in sorted(paths):
        f = (root / art).resolve()
        if root not in f.parents:
            problems.append(f"{art}: resolves outside --images")
            continue
        if not f.is_file():
            problems.append(f"{art}: missing (cards {', '.join(paths[art][:3])})")
            continue
        data = f.read_bytes()
        if len(data) > max_bytes:
            problems.append(f"{art}: {len(data)} bytes, over {max_bytes}")
            continue
        ctype = sniff_type(data)
        if ctype is None:
            problems.append(f"{art}: not a JPEG/PNG/WebP image (starts {head_repr(data)})")
            continue
        out.append(LocalFile(art, f, hashlib.sha256(data).hexdigest(), len(data), ctype))
    if problems:
        shown = "\n  ".join(problems[:20])
        more = f"\n  … and {len(problems) - 20} more" if len(problems) > 20 else ""
        raise Refused(f"{len(problems)} image problem(s):\n  {shown}{more}")
    return out


@dataclass
class Plan:
    new: list[LocalFile]
    changed: list[LocalFile]
    unchanged: int
    live_only: int          # paths on the CDN no longer in the catalog (kept: uploads are additive)
    artless: int
    cards: int
    index: dict             # the merged index to write after the uploads
    mismatched: dict = None  # "<.ext> holding <type>" -> count


def make_plan(files: list[LocalFile], live_index: dict, artless: int, cards: int) -> Plan:
    live = live_index.get("files", {}) if isinstance(live_index, dict) else {}
    new, changed, unchanged = [], [], 0
    for f in files:
        rec = live.get(f.path)
        if rec is None:
            new.append(f)
        elif rec.get("sha256") != f.sha256:
            changed.append(f)
        else:
            unchanged += 1
    local_paths = {f.path for f in files}
    merged = dict(live)
    for f in files:
        merged[f.path] = {"sha256": f.sha256, "bytes": f.bytes, "contentType": f.content_type}
    index = {"schemaVersion": 1, "updatedAt": _config.utc_now(), "files": dict(sorted(merged.items()))}
    mismatched: dict[str, int] = {}
    for f in files:
        if CONTENT_TYPES[f.file.suffix.lower()] != f.content_type:
            k = f"{f.file.suffix.lower()} holding {f.content_type}"
            mismatched[k] = mismatched.get(k, 0) + 1
    return Plan(new, changed, unchanged, len(set(live) - local_paths), artless, cards, index, mismatched)


def print_plan(product: CdnConfig, plan: Plan, config: Optional[bytes], data_files: Sequence[DataFile] = ()) -> None:
    mb = sum(f.bytes for f in plan.new + plan.changed) / 1e6
    print(f"catalog: {plan.cards} cards with art, {plan.artless} without (nothing to host)")
    print(f"images: {len(plan.new)} new, {len(plan.changed)} changed, {plan.unchanged} unchanged ({mb:.1f} MB to upload)")
    if plan.changed:
        print("  changed: " + ", ".join(f.path for f in plan.changed[:15]) + (" …" if len(plan.changed) > 15 else ""))
        print("  (a changed image reaches viewers within a day, or at once after a Cloudflare purge)")
    if plan.live_only:
        print(f"note: {plan.live_only} path(s) on the CDN are no longer in the catalog; they are kept")
    if plan.mismatched:
        kinds = ", ".join(f"{n} {k}" for k, n in sorted(plan.mismatched.items()))
        print(f"note: file name and bytes disagree for {sum(plan.mismatched.values())} image(s) ({kinds});"
              " served with the type of the bytes")
    print(f"index: {product.index_key} ({len(plan.index['files'])} paths)")
    for d in data_files:
        print(f"{d.kind.name}: {d.key} ({d.entries} entries, {len(d.data) / 1e6:.1f} MB), after the index")
    print(f"config: {'config.json, uploaded last' if config is not None else 'not uploaded (no --config)'}")


def read_live_index(product: CdnConfig, s3, bucket: str) -> dict:
    try:
        body = s3.get_object(Bucket=bucket, Key=product.index_key)["Body"].read()
    except Exception as e:  # botocore's NoSuchKey; anything else is a real error
        code = getattr(e, "response", {}).get("Error", {}).get("Code")
        if code in ("NoSuchKey", "404"):
            return {}
        raise
    idx = json.loads(body)
    if not isinstance(idx, dict) or idx.get("schemaVersion") != 1 or not isinstance(idx.get("files"), dict):
        raise Refused(f"live {product.index_key} is malformed; refusing to merge into it")
    return idx


def execute(product: CdnConfig, s3, bucket: str, plan: Optional[Plan], config: Optional[bytes], workers: int = 8,
            log: Callable[[str], None] = print, data_files: Sequence[DataFile] = (),
            page: Optional[PageFile] = None) -> int:
    """Images, then the index (of what actually landed), then the data files, then a page, then
    config.json. Returns failures. `plan` None publishes the data files, the page and config.json alone."""
    if plan is None:
        plan = Plan([], [], 0, 0, 0, 0, {})
    todo = plan.new + plan.changed
    failed: list[str] = []

    def put(f: LocalFile) -> None:
        s3.put_object(Bucket=bucket, Key=product.art_prefix + f.path, Body=f.file.read_bytes(),
                      ContentType=f.content_type, CacheControl=product.art_cache)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(put, f): f for f in todo}
        for n, fut in enumerate(as_completed(futures), 1):
            f = futures[fut]
            try:
                fut.result()
            except Exception as e:
                failed.append(f.path)
                log(f"FAILED {f.path}: {e}")
            if n % 250 == 0 or n == len(todo):
                log(f"images: {n}/{len(todo)}")
    for path in failed:  # the index records only what is really on the CDN: a re-run retries the rest
        plan.index["files"].pop(path, None)
    if plan.index:
        s3.put_object(Bucket=bucket, Key=product.index_key, Body=json.dumps(plan.index, indent=1).encode(),
                      ContentType="application/json", CacheControl=INDEX_CACHE)
        log(f"index: {product.index_key} written ({len(plan.index['files'])} paths)")
    if failed:
        log(f"{len(failed)} upload(s) failed; config.json NOT written. Re-run to retry.")
        return len(failed)
    for d in data_files:
        try:
            s3.put_object(Bucket=bucket, Key=d.key, Body=d.data,
                          ContentType="application/json", CacheControl=d.kind.cache_control)
        except Exception as e:
            log(f"FAILED {d.key}: {e}; config.json NOT written. Re-run to retry.")
            return 1
        log(f"{d.kind.name}: {d.key} written")
    if page is not None:
        try:
            s3.put_object(Bucket=bucket, Key=page.key, Body=page.data,
                          ContentType="text/html; charset=utf-8", CacheControl=PAGE_CACHE)
        except Exception as e:
            log(f"FAILED {page.key}: {e}; config.json NOT written. Re-run to retry.")
            return 1
        log(f"page: {page.key} written")
    if config is not None:
        s3.put_object(Bucket=bucket, Key=CONFIG_KEY, Body=config,
                      ContentType="application/json", CacheControl=CONFIG_CACHE)
        log("config.json written")
    return 0
