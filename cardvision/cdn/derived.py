# SPDX-License-Identifier: Apache-2.0
"""Derived art sets: smaller pictures made from the catalog's art at publish time.

A product lists sets in ``art.derived`` (``cdn.config.json``); each is one file per card with art,
``<art prefix><name>/<cardId>.webp``, with an index of its own beside it,
``<art prefix><name>/index.json``::

    {"schemaVersion": 1, "updatedAt": ..., "spec": {name, width, format, quality}, "specHash": ...,
     "files": {"art/tooltip/AB-001.webp": {sha256, bytes, contentType, cardId, sourceSha256}}}

What counts as changed is the source's sha256 and the set's ``specHash``, never the derived bytes:
a Pillow update that encodes a little differently re-uploads nothing. Nothing is ever deleted.

A product's settings may point at a set only when every catalog card with art is listed at the
current ``specHash`` (``derived_switch_problem``): a viewer's tooltip gives up on a source after a
few misses, so a switch to a partial set would send everyone to the full art.
"""

from __future__ import annotations

import hashlib
import io
import json
from dataclasses import dataclass
from typing import Callable, Optional, Sequence

from cardvision.cdn import config as _config
from cardvision.cdn.config import INDEX_CACHE, CdnConfig, DerivedSet, Refused


def check_card_id(card_id: str) -> Optional[str]:
    """Why a card id cannot name a derived file, or None. The same clean-path rule as an art path,
    and one path segment: the file sits directly in its set's folder."""
    if (not isinstance(card_id, str) or not card_id or card_id.startswith("/") or "\\" in card_id
            or "/" in card_id or card_id in (".", "..")):
        return f"{card_id!r} is not a clean file name"
    if any(ord(c) < 33 or ord(c) == 127 or c in "?#%" for c in card_id):
        return f"{card_id!r} holds a space, control or URL character"
    return None


def derive_webp(data: bytes, width: Optional[int], quality: int) -> bytes:
    """The source image as WebP: EXIF turn applied, alpha kept, at most `width` wide (never
    enlarged; None keeps the size), LANCZOS, `quality`, method 6. The same source and spec give the
    same bytes with one Pillow version."""
    from PIL import Image, ImageOps

    with Image.open(io.BytesIO(data)) as opened:
        img = ImageOps.exif_transpose(opened)  # first frame of an animation; a copy
        img.load()
        has_alpha = img.mode in ("RGBA", "LA", "PA", "RGBa", "La") or "transparency" in img.info
        img = img.convert("RGBA" if has_alpha else "RGB")
        if width is not None and img.width > width:
            height = max(1, round(img.height * width / img.width))
            img = img.resize((width, height), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        img.save(out, "WEBP", quality=quality, method=6)
        return out.getvalue()


@dataclass
class DerivedFile:
    card_id: str
    key: str
    source: object      # the art LocalFile: .file, .sha256, .path


@dataclass
class DerivedPlan:
    spec: DerivedSet
    index_key: str
    new: list[DerivedFile]
    changed: list[DerivedFile]      # source or spec differs from the live index
    unchanged: int
    kept: dict                      # live records that stay listed (same spec only)
    respec: bool                    # the live index was made at another spec

    @property
    def todo(self) -> list[DerivedFile]:
        return self.new + self.changed

    def planned_keys(self) -> set[str]:
        """What the index will list when every upload lands."""
        return set(self.kept) | {d.key for d in self.todo}


def read_live_derived(product: CdnConfig, spec: DerivedSet, s3, bucket: str) -> dict:
    key = spec.index_key(product.art_prefix)
    try:
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    except Exception as e:  # botocore's NoSuchKey; anything else is a real error
        code = getattr(e, "response", {}).get("Error", {}).get("Code")
        if code in ("NoSuchKey", "404"):
            return {}
        raise
    idx = json.loads(body)
    if not isinstance(idx, dict) or idx.get("schemaVersion") != 1 or not isinstance(idx.get("files"), dict):
        raise Refused(f"live {key} is malformed; refusing to merge into it")
    return idx


def plan_derived(product: CdnConfig, files: Sequence, read_live: Callable[[DerivedSet], dict]) -> list[DerivedPlan]:
    """The sets to make: one file per card with art, new or redone against each set's live index.
    `files` are the scanned art files, each knowing its cards."""
    if not product.derived:
        return []
    sources: dict[str, object] = {}
    bad: list[str] = []
    for f in files:
        for card_id in f.cards:
            problem = check_card_id(card_id)
            if problem:
                bad.append(f"card id {problem}")
            elif card_id in sources and sources[card_id] is not f:
                bad.append(f"card {card_id} has two different art paths ({sources[card_id].path}, {f.path})")
            else:
                sources[card_id] = f
    if bad:
        shown = "\n  ".join(bad[:20])
        more = f"\n  … and {len(bad) - 20} more" if len(bad) > 20 else ""
        raise Refused(f"{len(bad)} card id problem(s) for the derived sets:\n  {shown}{more}")
    plans = []
    for spec in product.derived:
        clash = next((f.path for f in files if f.path.startswith(spec.name + "/")), None)
        if clash:
            raise Refused(f"art path {clash} is inside the derived set folder {product.art_prefix}{spec.name}/")
        live = read_live(spec) or {}
        respec = bool(live) and live.get("specHash") != spec.spec_hash
        live_files = {} if respec or not live else dict(live.get("files", {}))
        new, changed, unchanged = [], [], 0
        for card_id in sorted(sources):
            src = sources[card_id]
            d = DerivedFile(card_id, spec.key(product.art_prefix, card_id), src)
            rec = live_files.get(d.key)
            if rec is None:
                (changed if respec else new).append(d)
            elif rec.get("sourceSha256") != src.sha256:
                changed.append(d)
            else:
                unchanged += 1
        plans.append(DerivedPlan(spec, spec.index_key(product.art_prefix), new, changed, unchanged, live_files, respec))
    return plans


def make_derived_file(product: CdnConfig, plan: DerivedPlan, d: DerivedFile) -> tuple[bytes, dict]:
    """The bytes to upload and the record the index keeps. Raises when the source changed since it
    was scanned, cannot be read as an image, or the result is not under the size limit."""
    raw = d.source.file.read_bytes()
    if hashlib.sha256(raw).hexdigest() != d.source.sha256:
        raise RuntimeError("the source changed since it was scanned")
    try:
        data = derive_webp(raw, plan.spec.width, plan.spec.quality)
    except Exception as e:
        raise RuntimeError(f"cannot derive from {d.source.path}: {type(e).__name__}: {e}") from e
    if len(data) >= product.max_image_bytes:
        raise RuntimeError(f"{len(data)} bytes, not under {product.max_image_bytes}")
    return data, {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "contentType": plan.spec.content_type,
                  "cardId": d.card_id, "sourceSha256": d.source.sha256}


def derived_index(plan: DerivedPlan, landed: dict) -> dict:
    """The set's index: the kept records and what landed, in key order."""
    files = {**plan.kept, **landed}
    return {"schemaVersion": 1, "updatedAt": _config.utc_now(), "spec": plan.spec.spec, "specHash": plan.spec.spec_hash,
            "files": dict(sorted(files.items()))}


def write_derived_index(product: CdnConfig, plan: DerivedPlan, landed: dict, s3, bucket: str) -> int:
    idx = derived_index(plan, landed)
    s3.put_object(Bucket=bucket, Key=plan.index_key, Body=json.dumps(idx, indent=1).encode(),
                  ContentType="application/json", CacheControl=INDEX_CACHE)
    return len(idx["files"])


def sets_in_config(product: CdnConfig, cfg: dict, public_base: str) -> list[DerivedSet]:
    """The derived sets that `primary` or a fallback points under."""
    templates = []
    for src in [cfg.get("primary"), *(cfg.get("fallbacks") or [])]:
        if isinstance(src, dict) and isinstance(src.get("template"), str):
            templates.append(src["template"])
    base = public_base.rstrip("/") + "/" + product.art_prefix
    return [s for s in product.derived if any(t.startswith(f"{base}{s.name}/") for t in templates)]


def derived_switch_problem(product: CdnConfig, cfg_bytes: Optional[bytes], public_base: str,
                           card_ids: Optional[set], listed: Callable[[DerivedSet], tuple[Optional[str], set]]) -> Optional[str]:
    """Why a settings file may not be published, or None. When `primary` or a fallback points
    under a derived set, every catalog card with art must be listed by that set at its current
    specHash. `card_ids` is None when no catalog was given; `listed(spec)` is (specHash, keys)."""
    if cfg_bytes is None:
        return None
    used = sets_in_config(product, json.loads(cfg_bytes), public_base)
    if not used:
        return None
    names = ", ".join(s.name for s in used)
    if card_ids is None:
        return (f"config: primary or a fallback points at the derived set {names}; give --catalog (and --images to "
                "publish the set in the same run) so that the set can be checked for every card")
    for spec in used:
        spec_hash, keys = listed(spec)
        folder = f"{product.art_prefix}{spec.name}/"
        if spec_hash is None:
            return f"config: points at the derived set {folder}, which has no index on the CDN; publish the set first"
        if spec_hash != spec.spec_hash:
            return (f"config: points at the derived set {folder}, whose files were made at another spec "
                    "(width, format or quality changed); publish the set again first")
        missing = [c for c in sorted(card_ids) if spec.key(product.art_prefix, c) not in keys]
        if missing:
            return (f"config: points at the derived set {folder}, which lacks {len(missing)} of {len(card_ids)} "
                    f"catalog card(s) (for example {', '.join(missing[:3])}); publish the whole set first")
    return None
