# SPDX-License-Identifier: Apache-2.0
"""The product's ``config.json`` (schema 1), and the files it may name: data files and pages.

Every check refuses here what an extension would ignore, so that it is never published.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

from cardvision.cdn.config import MAX_PAGE_BYTES, CdnConfig, DataFileKind, Refused

RELEASE_ID = re.compile(r"^[0-9a-f]{16}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
HEX64_RE = re.compile(r"[0-9a-f]{64}")
DATA_PATH = re.compile(r"^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$")


def release_pointer_problems(product: CdnConfig, rel: object) -> list[str]:
    """The config's `release` field (schema 1, additive). The extension ignores a malformed one
    (and loads its bundled release); refused here so that it is never published."""
    if rel is None:
        return []
    if not isinstance(rel, dict):
        return ["config: release must be an object or null"]
    prefix = product.releases_prefix
    errs = []
    rid = rel.get("id")
    if not isinstance(rid, str) or not RELEASE_ID.match(rid):
        errs.append("config: release.id must be 16 lowercase hex digits")
    elif rel.get("path") != f"{prefix}{rid}/release.json":
        errs.append(f"config: release.path must be exactly {prefix}{rid}/release.json")
    if not isinstance(rel.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", rel["sha256"]):
        errs.append("config: release.sha256 must be 64 lowercase hex digits")
    if not isinstance(rel.get("minimumExtensionVersion"), str) or not VERSION_RE.match(rel["minimumExtensionVersion"]):
        errs.append("config: release.minimumExtensionVersion is required, x.y.z")
    if "maximumExtensionVersion" in rel and (not isinstance(rel["maximumExtensionVersion"], str) or not VERSION_RE.match(rel["maximumExtensionVersion"])):
        errs.append("config: release.maximumExtensionVersion must be x.y.z (or left out)")
    if not product.geometric:
        if "geometric" in rel:
            errs.append("config: release.geometric is another product's field; this product has no geometric stage "
                        "(cdn.config.json geometric: false)")
        return errs
    geo = rel.get("geometric")
    if geo is not None:
        if not isinstance(geo, dict):
            errs.append("config: release.geometric must be an object (or left out)")
        else:
            if isinstance(rid, str) and geo.get("path") != f"{prefix}{rid}/geometric.json":
                errs.append(f"config: release.geometric.path must be exactly {prefix}{rid}/geometric.json")
            for k in ("sha256", "manifestSha256"):
                if not isinstance(geo.get(k), str) or not re.fullmatch(r"[0-9a-f]{64}", geo[k]):
                    errs.append(f"config: release.geometric.{k} must be 64 lowercase hex digits")
    return errs


def validate_config(product: CdnConfig, cfg: object, public_base: Optional[str],
                    warnings: Optional[list[str]] = None) -> list[str]:
    """Errors against the config.json contract (schema 1). `public_base`, when given, must host
    `primary`. Problems that do not stop a publish (the obsolete `cardLink`) go to `warnings`."""
    errs: list[str] = []
    warn = warnings if warnings is not None else []
    if not isinstance(cfg, dict):
        return ["config: not a JSON object"]
    if cfg.get("schemaVersion") != 1 or isinstance(cfg.get("schemaVersion"), bool):
        errs.append("config: schemaVersion must be exactly 1")
    if not isinstance(cfg.get("namesOnly"), bool):
        errs.append("config: namesOnly must be true or false")
    if not isinstance(cfg.get("updatedAt"), str):
        errs.append("config: updatedAt must be an ISO-8601 string")

    def check_template(label: str, tpl: object, into: Optional[list[str]] = None) -> None:
        out = errs if into is None else into
        # Another project's address is refused whatever its scheme or case (checked first, so an
        # http:// or HTTPS:// link to it is not merely "not https").
        if isinstance(tpl, str) and any(w in tpl.lower() for w in product.forbidden_words):
            out.append(f"config: {label} points at another project ({tpl})")
            return
        if not isinstance(tpl, str) or not tpl.startswith("https://"):
            out.append(f"config: {label} must be an https:// template")
            return
        rest = tpl
        for ph in product.placeholders:
            rest = rest.replace(ph, "")
        if "{" in rest or "}" in rest:
            out.append(f"config: {label} has an unknown placeholder ({tpl})")

    def check_source(label: str, src: object) -> None:
        if not isinstance(src, dict) or not isinstance(src.get("id"), str) or not src.get("id"):
            errs.append(f"config: {label} must be {{id, template}}")
            return
        check_template(f"{label}.template", src.get("template"))

    if "primary" not in cfg:
        errs.append("config: primary is required (null skips our CDN)")
    elif cfg["primary"] is not None:
        check_source("primary", cfg["primary"])
        tpl = cfg["primary"].get("template") if isinstance(cfg["primary"], dict) else None
        if "{sourceFile}" in product.placeholders and isinstance(tpl, str) and "{sourceFile}" in tpl:
            errs.append("config: primary.template cannot use {sourceFile} (our CDN is keyed by {art})")
        if (public_base and isinstance(tpl, str)
                and not tpl.startswith(public_base.rstrip("/") + "/" + product.art_prefix)):
            errs.append(f"config: primary.template must start with {public_base.rstrip('/')}/{product.art_prefix} "
                        f"({product.env('PUBLIC_BASE')})")
    fallbacks = cfg.get("fallbacks")
    if not isinstance(fallbacks, list):
        errs.append("config: fallbacks must be an array (may be empty)")
    else:
        for i, src in enumerate(fallbacks):
            check_source(f"fallbacks[{i}]", src)
    if product.geometric and "geometric" in cfg and cfg["geometric"] is not None and not isinstance(cfg["geometric"], bool):
        errs.append("config: geometric must be true, false or null (or absent)")
    if product.obsolete_card_link:
        # cardLink is obsolete (current extensions ignore it; earlier development builds required a
        # template or null), so it is only warned about; pointing at another project still refuses.
        if "cardLink" not in cfg:
            warn.append("config: cardLink is absent; current extensions ignore it, earlier development builds refuse the file without it")
        elif cfg["cardLink"] is not None:
            link_errs: list[str] = []
            check_template("cardLink", cfg["cardLink"], link_errs)
            for e in link_errs:
                (errs if "another project" in e else warn).append(e)
    for kind in product.data_files:
        named = cfg.get(kind.name)
        if named is None:
            continue
        # The extension ignores a malformed one; refused here so that it is never published.
        if not isinstance(named, dict) or not isinstance(named.get("path"), str) or not isinstance(named.get("sha256"), str):
            errs.append(f"config: {kind.name} must be {{path, sha256}} or absent")
        else:
            path = named["path"]
            if not DATA_PATH.match(path) or any(part in (".", "..") for part in path.split("/")):
                errs.append(f"config: {kind.name}.path {path!r} is not a clean relative path to a .json file")
            if not re.fullmatch(r"[0-9a-f]{64}", named["sha256"]):
                errs.append(f"config: {kind.name}.sha256 must be 64 lowercase hex digits")
    errs += release_pointer_problems(product, cfg.get("release"))
    return errs


def load_config(product: CdnConfig, path: Path, public_base: Optional[str]) -> bytes:
    raw = Path(path).read_bytes()
    try:
        cfg = json.loads(raw)
    except json.JSONDecodeError as e:
        raise Refused(f"config: {path} is not JSON ({e})")
    warnings: list[str] = []
    errs = validate_config(product, cfg, public_base, warnings)
    if errs:
        raise Refused("\n".join(errs))
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    return raw


def serialize_config(cfg: dict) -> bytes:
    """The bytes this tool writes for a config.json it changed: two-space indent, ASCII escapes,
    keys in their order, one trailing newline."""
    return (json.dumps(cfg, indent=2) + "\n").encode()


# ---------------------------------------------------------------------------- data files

@dataclass
class DataFile:
    kind: DataFileKind
    key: str        # <prefix><name>
    data: bytes
    sha256: str
    entries: int    # objects in the first required key (for the log)

    @property
    def entry(self) -> dict:
        """What config.json names it by."""
        return {"path": self.key, "sha256": self.sha256}


def data_kind_for(product: CdnConfig, name: str) -> Optional[DataFileKind]:
    return next((k for k in product.data_files if k.name_regex.match(name)), None)


def load_data_file(product: CdnConfig, path: Path) -> DataFile:
    """A data file as the product's builder wrote it: a versioned name whose hex is the start of its
    own SHA-256, and a JSON object of the kind's schema version with its required objects."""
    path = Path(path)
    kind = data_kind_for(product, path.name)
    if kind is None:
        names = ", ".join(k.name_pattern for k in product.data_files) or "none"
        raise Refused(f"data file: {path.name} is not named as a data file this CDN serves ({names}; <sha8> = 8 hex digits)")
    m = kind.name_regex.match(path.name)
    data = path.read_bytes()
    if len(data) > kind.max_bytes:
        raise Refused(f"{kind.name}: {len(data)} bytes, over {kind.max_bytes}")
    sha = hashlib.sha256(data).hexdigest()
    if not sha.startswith(m.group(1)):
        raise Refused(f"{kind.name}: {path.name} does not match its contents (sha256 starts {sha[:8]}); rebuild it")
    try:
        doc = json.loads(data)
    except json.JSONDecodeError as e:
        raise Refused(f"{kind.name}: not JSON ({e})")
    if (not isinstance(doc, dict) or doc.get("schemaVersion") != kind.schema_version or isinstance(doc.get("schemaVersion"), bool)
            or not all(isinstance(doc.get(k), dict) for k in kind.required_object_keys)):
        objects = "".join(f", {k}: {{...}}" for k in kind.required_object_keys)
        raise Refused(f"{kind.name}: expected {{schemaVersion: {kind.schema_version}{objects}}}")
    entries = len(doc[kind.required_object_keys[0]]) if kind.required_object_keys else 0
    return DataFile(kind, kind.prefix + path.name, data, sha, entries)


def load_data_files(product: CdnConfig, paths: Iterable[Path]) -> list[DataFile]:
    """Several data files, at most one of each kind, in the order of the product's dataFiles."""
    files = [load_data_file(product, Path(p)) for p in paths]
    seen: set[str] = set()
    for f in files:
        if f.kind.name in seen:
            raise Refused(f"{f.kind.name}: two files given; a run publishes one of each kind")
        seen.add(f.kind.name)
    order = [k.name for k in product.data_files]
    return sorted(files, key=lambda f: order.index(f.kind.name))


def data_config_problem(product: CdnConfig, cfg_bytes: Optional[bytes], files: Iterable[DataFile]) -> Optional[str]:
    """A config.json published with data files must name each of them, path and sha256."""
    if cfg_bytes is None:
        return None
    cfg = json.loads(cfg_bytes)
    for f in files:
        named = cfg.get(f.kind.name)
        if named != f.entry:
            return (f"config: {f.kind.name} must be {json.dumps(f.entry)} for the file being published "
                    f"(it is {json.dumps(named)})")
    return None


# ---------------------------------------------------------------------------- pages

@dataclass
class PageFile:
    key: str        # e.g. privacy.html
    data: bytes
    sha256: str


def load_page(product: CdnConfig, path: Path) -> PageFile:
    """A page for the CDN's root: one of the product's pages, an HTML document with no script."""
    path = Path(path)
    if path.name not in product.pages:
        raise Refused(f"page: {path.name} is not a page this CDN serves ({', '.join(product.pages) or 'none'})")
    data = path.read_bytes()
    if len(data) > MAX_PAGE_BYTES:
        raise Refused(f"page: {len(data)} bytes, over {MAX_PAGE_BYTES}")
    if not data.lstrip().lower().startswith(b"<!doctype html>"):
        raise Refused(f"page: {path.name} is not an HTML document")
    if re.search(rb"<script|\son[a-z]+\s*=|javascript:", data, re.I):
        raise Refused(f"page: {path.name} holds a script; the CDN's pages are plain HTML")
    return PageFile(path.name, data, hashlib.sha256(data).hexdigest())
