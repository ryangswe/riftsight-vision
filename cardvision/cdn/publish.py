# SPDX-License-Identifier: Apache-2.0
"""The publishing orders and the gates in front of them.

``plan``/``publish``: images, the art index, data files, a page, config.json last. Before anything
is written (a dry run too): a config's release pointer must verify live (``pointer_gate``), and
every data file it names must be published by this run or already live with those bytes
(``data_file_gate``).

``publish-release``: every check first (the local seal, the runtime table, the models against what
installs run and ``--sessions``, the runtime's own check in Node, the geometric settings and its
index on the CDN, the data files, the config it would write, the data-file gate, the remote state
through the S3 API); then the folder (pinned and legal files, geometric.json, release.json last),
the release index, a live verification of the folder, the data files, config.json last and
``verify``. A dry run makes every check and writes nothing.

Both runs that check a release folder live (``publish-release``, and ``publish --config`` with a
pointer that is not the live one) refuse at once when ``_EXTENSION_IDS`` is not set, a dry run
too: the live check needs it.

Every function here takes its S3 client (``s3``), its HTTPS fetch (``get``) and its Node check
(``node``) as arguments, so that a harness can run them against fakes."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Callable, Optional, Sequence

from cardvision.cdn.art import catalog_art_paths, execute, make_plan, print_plan, read_live_index, scan_images
from cardvision.cdn.config import CONFIG_KEY, CdnConfig, Refused
from cardvision.cdn.geo import check_release_geometric
from cardvision.cdn.node import NodeCheck, node_check
from cardvision.cdn.release import (
    ReleaseFile,
    bundled_release_id,
    load_local_release,
    load_runtimes,
    pointer_block,
    remote_state,
    runtime_problems,
    upload_release,
    version_tuple,
    write_release_index,
)
from cardvision.cdn.settings import (
    VERSION_RE,
    DataFile,
    data_config_problem,
    load_config,
    load_data_files,
    load_page,
    release_pointer_problems,
    serialize_config,
    validate_config,
)
from cardvision.cdn.target import Target, r2_client
from cardvision.cdn.verify import Get, cache_bust, missing_extension_ids, product_get, verify, verify_release_live


def live_models(product: CdnConfig, public_base: str, runtimes: dict, min_v: str, max_v: Optional[str],
                get: Optional[Get] = None) -> list[tuple[str, str, str]]:
    """The models installs run now: the live pointer's release, else the release bundled in each
    extension version the new pointer would reach (the runtime table). (label, detector sha256,
    recognizer sha256) each."""
    get = get or product_get(product)
    status, _, body = get(f"{public_base}/{CONFIG_KEY}?{cache_bust()}")
    rel = json.loads(body).get("release") if status == 200 else None
    if rel and not release_pointer_problems(product, rel):
        s2, _, doc_bytes = get(f"{public_base}/{rel['path']}?{cache_bust()}")
        if s2 == 200:
            doc = json.loads(doc_bytes)
            return [(f"live release {rel['id']}", doc["detector"]["sha256"], doc["recognizer"]["sha256"])]
    out = []
    for v, row in runtimes.items():
        if not VERSION_RE.match(v) or version_tuple(v) < version_tuple(min_v) or (max_v and version_tuple(v) >= version_tuple(max_v)):
            continue
        b = row.get("bundledRelease") or {}
        out.append((f"{v}'s bundled release {b.get('id')}", b.get("detectorSha256", ""), b.get("recognizerSha256", "")))
    return out


def planned_config(product: CdnConfig, args, block: dict, data_files: Sequence[DataFile], public_base: str) -> Optional[bytes]:
    """The config.json this run would publish, checked before anything is uploaded. None: no
    --config (the folder is published, the pointer not moved). With --set-pointer the release field
    is set, then each data file's field."""
    if not args.config:
        return None
    cfg = json.loads(Path(args.config).read_text())
    if args.set_pointer:
        cfg["release"] = block
        for d in data_files:
            cfg[d.kind.name] = d.entry
    elif cfg.get("release") != block:
        raise Refused(f"{args.config}: its release field is not this release's pointer; set it to\n{json.dumps(block, indent=2)}\n(or pass --set-pointer)")
    errs = validate_config(product, cfg, public_base)
    if errs:
        raise Refused("; ".join(errs))
    data = serialize_config(cfg)
    problem = data_config_problem(product, data, data_files)
    if problem:
        raise Refused(problem + " (pass --set-pointer to write it)")
    return data


def pointer_gate(product: CdnConfig, public_base: str, rel: dict, get: Optional[Get] = None, runtimes: Optional[dict] = None,
                 verify_live=None) -> Optional[str]:
    """`publish --config` with a pointer: why it may not go out, or None. The same pointer as the live
    config's needs no new check (an emergency `namesOnly` must not wait on it); a new one must verify
    live and be loadable by every extension version it reaches."""
    get = get or product_get(product)
    status, _, body = get(f"{public_base}/{CONFIG_KEY}?{cache_bust()}")
    if status == 200 and json.loads(body).get("release") == rel:
        print(f"note: the pointer is the live one ({rel['id']}); not checked again")
        return None
    if verify_live is None:
        missing = missing_extension_ids(product, "a new pointer in config.json")
        if missing:
            return missing
    # Cache-busted: never leave a cached 404 at the edge under a release's real URL.
    s2, _, doc_bytes = get(f"{public_base}/{rel['path']}?{cache_bust()}")
    if s2 != 200:
        return f"release {rel['id']}: its document is not on the CDN (HTTP {s2})"
    runtimes = runtimes if runtimes is not None else load_runtimes(product)
    problems = runtime_problems(json.loads(doc_bytes), rel["minimumExtensionVersion"], rel.get("maximumExtensionVersion"),
                                runtimes, product.runtimes_label)
    if problems:
        return "; ".join(problems)
    live = verify_live or (lambda *a, **k: verify_release_live(product, *a, **k))
    if live(public_base, candidate=rel["id"], expect_sha=rel["sha256"], geometric=rel.get("geometric")):
        return f"config.json points at release {rel['id']}, which does not verify live"
    return None


def data_file_gate(product: CdnConfig, public_base: str, cfg_bytes: Optional[bytes], data_files: Sequence[DataFile] = (),
                   get: Optional[Get] = None) -> Optional[str]:
    """A config.json about to be published: why a data file it names may not go out, or None. Each
    entry must name the file this run publishes (before the config), or one already on the CDN with
    exactly those bytes. Otherwise every viewer's extension would ask for a file that is not there
    (the incident this gate exists for: a stale repository config named a data file that was never
    published)."""
    if cfg_bytes is None:
        return None
    cfg = json.loads(cfg_bytes)
    mine = {d.kind.name: d.entry for d in data_files}
    for kind in product.data_files:
        named = cfg.get(kind.name)
        if not named:
            continue
        if mine.get(kind.name) == named:
            continue
        get = get or product_get(product)
        # Cache-busted: never leave a cached 404 at the edge under a real URL.
        status, _, body = get(f"{public_base}/{named['path']}?{cache_bust()}")
        if status == 200 and hashlib.sha256(body).hexdigest() == named["sha256"]:
            continue
        why = f"HTTP {status}" if status != 200 else "other bytes than its sha256"
        hint = "publish that file with --data-file, or name the one that is live"
        s2, _, live_body = get(f"{public_base}/{CONFIG_KEY}?{cache_bust()}")
        try:
            live = json.loads(live_body).get(kind.name) if s2 == 200 else None
        except (json.JSONDecodeError, AttributeError):
            live = None
        if live and live != named:
            hint = (f"the live config.json names {json.dumps(live)}: copy that entry into the config, "
                    f"or publish {named['path']} with --data-file")
        return f"config.json names {named['path']} ({kind.name}), which is not on the CDN ({why}); {hint}"
    return None


def publish_release(product: CdnConfig, args, t: Target, s3=None, verify_live=None, node: Optional[NodeCheck] = None,
                    log: Callable[[str], None] = print, get: Optional[Get] = None, runtimes: Optional[dict] = None,
                    verify_after=None) -> int:
    """publish-release. `args` carries release, legal, min_version, max_version, sessions,
    fix_metadata, dry_run, config, set_pointer, and optionally data_files (paths), geometric and
    geo_manifest_sha256. Returns 0 or 1; a refusal raises Refused before anything is written."""
    if verify_live is None:
        missing = missing_extension_ids(product, "publish-release")
        if missing:
            raise Refused(missing)
    node = node or node_check(product)
    legal = getattr(args, "legal", None)
    lr = load_local_release(product, Path(args.release), Path(legal) if legal else product.legal_dir)
    min_v, max_v = args.min_version, args.max_version
    if not min_v or not VERSION_RE.match(min_v) or (max_v and not VERSION_RE.match(max_v)):
        raise Refused("--min-version x.y.z is required (and --max-version, when given, is x.y.z)")
    runtimes = runtimes if runtimes is not None else load_runtimes(product)
    problems = runtime_problems(lr.doc, min_v, max_v, runtimes, product.runtimes_label)
    if problems:
        raise Refused("; ".join(problems))
    changed = [label for label, d, r in live_models(product, t.public_base, runtimes, min_v, max_v, get=get)
               if (d, r) != (lr.doc["detector"]["sha256"], lr.doc["recognizer"]["sha256"])]
    if changed and not args.sessions:
        raise Refused(f"the models differ from {', '.join(changed)}: re-run with --sessions (both ONNX Runtime sessions in Node)")
    local = node(["--dir", str(Path(args.release)), "--expect-id", lr.id, *(["--sessions"] if args.sessions else [])])
    if not local.get("ok"):
        raise Refused(f"the runtime's own check refused the release: {local.get('reason')}")
    log(f"seal: release {lr.id} ok (bank {local['bankEntries']} entries, catalog {local['catalogCards']} cards, sessions {local['sessions']})")

    geo_sha = None
    geometric_path = getattr(args, "geometric", None)
    if geometric_path:
        if not product.geometric:
            raise Refused("--geometric: this product has no geometric stage (cdn.config.json geometric: false)")
        geo_sha = getattr(args, "geo_manifest_sha256", None)
        s3 = s3 or r2_client(t)
        bank_bytes = next(f.data for f in lr.pinned if f.key.endswith("/" + lr.doc["bank"]["path"]))
        gbytes = Path(geometric_path).read_bytes()
        mkey, m = check_release_geometric(s3, t.bucket, t.public_base, gbytes, geo_sha, lr.doc.get("bank"), bank_bytes)
        lr.geometric = ReleaseFile(f"{lr.prefix}{lr.id}/geometric.json", gbytes, hashlib.sha256(gbytes).hexdigest(), "application/json")
        log(f"geometric: {mkey} is on the CDN, pinned and bound to the bank ({len(m.get('cards', []))} cards)")
    elif product.geometric:
        log("note: no --geometric: installs would run this release with the geometric stage off")

    data_files = load_data_files(product, getattr(args, "data_files", None) or [])
    block = pointer_block(lr, min_v, max_v, geo_sha)
    config = planned_config(product, args, block, data_files, t.public_base)
    problem = data_file_gate(product, t.public_base, config, data_files, get=get)
    if problem:
        raise Refused(problem + "; nothing written")
    s3 = s3 or r2_client(t)
    files = lr.pinned + lr.legal + ([lr.geometric] if lr.geometric else []) + [lr.doc_file]
    todo, there = remote_state(s3, t.bucket, files, args.fix_metadata)
    log(f"remote: {len(todo)} to upload, {len(there)} already there")
    for f in todo:
        log(f"  upload {f.key} ({len(f.data)} bytes)")
    for d in data_files:
        log(f"  then the {d.kind.name} file {d.key}")
    log("pointer: " + json.dumps(block) + ("" if config is not None else " (no --config: not moved)"))
    if bundled_release_id(product) == lr.id:
        log(f"note: {lr.id} is the release the current build bundles: a pointer to it downloads nothing (a no-op move)")
    if args.dry_run:
        return 0
    if upload_release(s3, t.bucket, lr, todo, log):
        return 1
    if todo:
        write_release_index(product, s3, t.bucket, lr, log)
    live = verify_live or (lambda *a, **k: verify_release_live(product, *a, **k))
    if live(t.public_base, candidate=lr.id, expect_sha=block["sha256"], sessions=args.sessions,
            expect_files={f.key.rsplit("/", 1)[1]: f.sha256 for f in lr.legal}, geometric=block.get("geometric")):
        log("the release folder did not verify live: config.json NOT written")
        return 1
    if data_files and execute(product, s3, t.bucket, None, None, data_files=data_files, log=log):
        return 1
    if config is None:
        log("no --config: the release folder is published; the pointer is not moved")
        return 0
    if args.set_pointer:
        Path(args.config).write_bytes(config)
        log(f"{args.config}: release" + (" and " + ", ".join(d.kind.name for d in data_files) if data_files else "") + " set")
    if execute(product, s3, t.bucket, None, config, log=log):
        return 1
    after = verify_after or (lambda base, samples: verify(product, base, samples))
    return 1 if after(t.public_base, 4) else 0


def build_inputs(product: CdnConfig, args, public_base: Optional[str]):
    """plan/publish: the config (checked), the data files, and the catalog's images.
    Returns (files, artless, cards, config bytes or None, data files)."""
    config = load_config(product, Path(args.config), public_base) if args.config else None
    data_files = load_data_files(product, getattr(args, "data_files", None) or [])
    problem = data_config_problem(product, config, data_files)
    if problem:
        raise Refused(problem)
    if config is not None and getattr(args, "offline", False):
        cfg = json.loads(config)
        mine = {d.kind.name for d in data_files}
        for kind in product.data_files:
            if cfg.get(kind.name) and kind.name not in mine:
                print(f"note: config.json names {cfg[kind.name]['path']}; it must already be on the CDN "
                      "(publish checks it before anything is written)")
    if not args.catalog:
        return [], 0, 0, config, data_files
    if not args.images:
        raise Refused("--catalog needs --images")
    paths, artless = catalog_art_paths(json.loads(Path(args.catalog).read_text()))
    files = scan_images(paths, Path(args.images), product.max_image_bytes)
    return files, artless, sum(len(v) for v in paths.values()), config, data_files


def plan_offline(product: CdnConfig, args) -> int:
    """plan --offline: no credentials, the CDN treated as empty."""
    base = os.environ.get(product.env("PUBLIC_BASE"))
    files, artless, cards, config, data_files = build_inputs(product, args, base.rstrip("/") if base else None)
    if getattr(args, "page", None):
        print(f"page: {load_page(product, Path(args.page)).key} (checked)")
    print_plan(product, make_plan(files, {}, artless, cards), config, data_files)
    return 0


def plan_or_publish(product: CdnConfig, args, t: Target, s3=None, get: Optional[Get] = None,
                    pointer_check=None, log: Callable[[str], None] = print) -> int:
    """plan (online) and publish. `args.command` is "plan" or "publish"; a publish --dry-run, like a
    plan, writes nothing, and a publish dry run passes every gate first."""
    page = load_page(product, Path(args.page)) if getattr(args, "page", None) else None
    if not args.catalog and not args.config and not getattr(args, "data_files", None) and page is None:
        raise Refused("nothing to do: give --catalog/--images, --data-file, --page and/or --config")
    files, artless, cards, config, data_files = build_inputs(product, args, t.public_base)
    if args.command == "publish":  # a dry run checks it too
        # A pointer only ever moves to a folder that verifies live (this covers rollbacks too).
        rel = json.loads(config).get("release") if config is not None else None
        if rel:
            problem = (pointer_check or (lambda base, r: pointer_gate(product, base, r, get=get)))(t.public_base, rel)
            if problem:
                raise Refused(problem + "; nothing written")
        problem = data_file_gate(product, t.public_base, config, data_files, get=get)
        if problem:
            raise Refused(problem + "; nothing written")
    s3 = s3 or r2_client(t)
    live = read_live_index(product, s3, t.bucket)
    plan = make_plan(files, live, artless, cards) if args.catalog else None
    print(f"target: bucket {t.bucket}, served at {t.public_base}")
    if plan:
        print_plan(product, plan, config, data_files)
    else:
        for d in data_files:
            print(f"{d.kind.name}: {d.key} ({d.entries} entries, {len(d.data) / 1e6:.1f} MB)")
        if page is not None:
            print(f"page: {page.key} ({len(page.data)} bytes, sha256 {page.sha256[:16]})")
        print("config: config.json" + (", uploaded last" if config is not None else " not uploaded (no --config)"))
    if args.command == "plan" or getattr(args, "dry_run", False):
        return 0
    return 1 if execute(product, s3, t.bucket, plan, config, data_files=data_files, page=page, log=log) else 0
