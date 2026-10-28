# SPDX-License-Identifier: Apache-2.0
"""Read-only checks over public HTTPS, as an extension sees the CDN: ``verify`` (config.json, its
data files, the pages, the art index and sampled images), ``verify-release-live`` (a release folder
and its pointer) and ``verify-geo`` (a geometric index folder).

Every fetch goes through a ``get(url, origin=None, method="GET", headers=None) -> (status, headers,
body)`` callable; ``http_get`` is the real one. Every URL of ``verify`` and ``verify-release-live``
carries a cache-busting query, so that no check ever leaves a cached 404 at the edge under a real
address. ``verify-geo`` reads each file at its own address, with no query."""

from __future__ import annotations

import functools
import hashlib
import json
import os
import random
import urllib.error
import urllib.parse
import urllib.request
from pathlib import PurePosixPath
from typing import Callable, Optional

from cardvision.cdn.config import CONFIG_CACHE, CONFIG_KEY, CONTENT_TYPES, PAGE_CACHE, CdnConfig, Refused
from cardvision.cdn.geo import GEO_CACHE, GeoFile, geo_binding_problems, geo_cover_problem, geo_index_key
from cardvision.cdn.node import NodeCheck, node_check
from cardvision.cdn.release import LEGAL_TYPES, RELEASE_CACHE, pinned_content_type, pinned_refs
from cardvision.cdn.settings import RELEASE_ID, release_pointer_problems, validate_config

Get = Callable[..., tuple[int, dict, bytes]]

_SSL_CONTEXT = None


def ssl_context():
    """Trust roots that do not depend on how Python was installed: python.org's macOS builds
    ship with an empty store until "Install Certificates.command" is run. Prefer certifi, then
    the bundle botocore ships (boto3 is installed for publishing), then the system default."""
    global _SSL_CONTEXT
    if _SSL_CONTEXT is None:
        import ssl

        cafile = None
        try:
            import certifi
            cafile = certifi.where()
        except ImportError:
            try:
                from botocore.httpsession import DEFAULT_CA_BUNDLE
                cafile = DEFAULT_CA_BUNDLE if os.path.exists(DEFAULT_CA_BUNDLE) else None
            except ImportError:
                pass
        _SSL_CONTEXT = ssl.create_default_context(cafile=cafile)
    return _SSL_CONTEXT


def http_get(url: str, origin: Optional[str] = None, method: str = "GET", headers: Optional[dict] = None,
             *, user_agent: str) -> tuple[int, dict, bytes]:
    hdrs = {"User-Agent": user_agent, **(headers or {})}
    if origin:
        hdrs["Origin"] = origin
    req = urllib.request.Request(url, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30, context=ssl_context()) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, b""
    except (urllib.error.URLError, OSError) as e:  # DNS, TLS, refused: no HTTP status at all
        reason = getattr(e, "reason", e)
        return 0, {"x-error": f"{type(reason).__name__}: {reason}"}, b""


def product_get(product: CdnConfig) -> Get:
    """The real fetch, with the product's user agent."""
    return functools.partial(http_get, user_agent=product.user_agent)


def cache_bust() -> str:
    return f"cb={random.getrandbits(32):x}"


def nel_problem(h: dict) -> Optional[str]:
    """Cloudflare's Network Error Logging makes every viewer's browser send reports to a third
    party (a.nel.cloudflare.com). The zone must not send `NEL` or `Report-To`."""
    found = [name for name in ("nel", "report-to") if name in h]
    return f"sends {' and '.join(n.upper() if n == 'nel' else 'Report-To' for n in found)} (turn off Network Error Logging for the zone)" if found else None


def verify(product: CdnConfig, public_base: str, samples: int, get: Optional[Get] = None) -> int:
    """config.json, the data files it names, the pages, the art index and `samples` images."""
    get = get or product_get(product)
    bad = 0

    def fail(msg: str) -> None:
        nonlocal bad
        bad += 1
        print(f"FAIL {msg}")

    bust = cache_bust()
    origin = product.cors_origin
    status, h, body = get(f"{public_base}/{CONFIG_KEY}?{bust}", origin=origin)
    if status == 0:
        host = urllib.parse.urlsplit(public_base).hostname
        err = h.get("x-error", "")
        if "gaierror" in err:
            hint = (f"Is the bucket's custom domain connected and Active (R2 → bucket → Settings → Custom Domains), "
                    f"and does `dig +short {host}` return addresses? A Mac may cache 'no such host' for up to "
                    f"30 minutes: sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder")
        elif "CERTIFICATE" in err.upper():
            hint = "This Python trusts no certificate authority: python -m pip install certifi, then re-run."
        else:
            hint = "Check the network (VPN, firewall) and re-run."
        fail(f"cannot reach {host} ({err}). {hint}")
        print("verify: 1 failure(s)")
        return bad
    if status != 200:
        fail(f"config.json: HTTP {status}")
    else:
        try:
            errs = validate_config(product, json.loads(body), public_base)
        except json.JSONDecodeError:
            errs = ["config: not JSON"]
        for e in errs:
            fail(e)
        if "application/json" not in h.get("content-type", ""):
            fail(f"config.json content-type {h.get('content-type')!r}")
        if h.get("cache-control") != CONFIG_CACHE:
            fail(f"config.json cache-control {h.get('cache-control')!r}, want {CONFIG_CACHE!r}")
        if h.get("access-control-allow-origin") not in ("*", origin):
            fail(f"config.json: no CORS header for the {origin} origin (bucket CORS policy)")
        if nel_problem(h):
            fail(f"config.json: {nel_problem(h)}")
        if not errs:
            cfg = json.loads(body)
            print(f"ok   config.json: namesOnly={cfg['namesOnly']}, primary={'on' if cfg['primary'] else 'off'}, {len(cfg['fallbacks'])} fallback(s)")
            for kind in product.data_files:
                named = cfg.get(kind.name)
                if not named:
                    continue
                d_status, d_h, d_body = get(f"{public_base}/{named['path']}?{bust}")
                if d_status != 200:
                    fail(f"{named['path']}: HTTP {d_status} (config.json names it: publish it with --data-file)")
                elif hashlib.sha256(d_body).hexdigest() != named["sha256"]:
                    fail(f"{named['path']}: sha256 differs from config.json's {kind.name}.sha256")
                elif "application/json" not in d_h.get("content-type", ""):
                    fail(f"{named['path']}: content-type {d_h.get('content-type')!r}")
                elif d_h.get("cache-control") != kind.cache_control:
                    fail(f"{named['path']}: cache-control {d_h.get('cache-control')!r}, want {kind.cache_control!r}")
                elif nel_problem(d_h):
                    fail(f"{named['path']}: {nel_problem(d_h)}")
                else:
                    print(f"ok   {named['path']}: {len(d_body)} bytes, sha256 as config.json names it")

    for name in product.pages:
        p_status, p_h, p_body = get(f"{public_base}/{name}?{bust}")
        if p_status == 404:
            print(f"note {name}: not on the CDN (publish it with --page)")
        elif p_status != 200:
            fail(f"{name}: HTTP {p_status}")
        elif not p_h.get("content-type", "").startswith("text/html"):
            fail(f"{name}: content-type {p_h.get('content-type')!r}")
        elif p_h.get("cache-control") != PAGE_CACHE:
            fail(f"{name}: cache-control {p_h.get('cache-control')!r}, want {PAGE_CACHE!r}")
        elif nel_problem(p_h):
            fail(f"{name}: {nel_problem(p_h)}")
        else:
            print(f"ok   {name}: {len(p_body)} bytes")

    status, _, body = get(f"{public_base}/{product.index_key}?{bust}")
    if status != 200:
        fail(f"{product.index_key}: HTTP {status}")
        return bad
    files = json.loads(body).get("files", {})
    print(f"ok   {product.index_key}: {len(files)} paths")
    for path in random.sample(sorted(files), min(samples, len(files))):
        url = f"{public_base}/{product.art_prefix}{urllib.parse.quote(path)}?{bust}"
        status, h, data = get(url)
        want_type = files[path].get("contentType") or CONTENT_TYPES[PurePosixPath(path).suffix.lower()]
        if status != 200:
            fail(f"{path}: HTTP {status}")
        elif hashlib.sha256(data).hexdigest() != files[path]["sha256"]:
            fail(f"{path}: sha256 differs from the index")
        elif h.get("content-type") != want_type:
            fail(f"{path}: content-type {h.get('content-type')!r}, want {want_type}")
        elif h.get("cache-control") != product.art_cache:
            fail(f"{path}: cache-control {h.get('cache-control')!r}, want {product.art_cache!r}")
        elif nel_problem(h):
            fail(f"{path}: {nel_problem(h)}")
        else:
            print(f"ok   {path}")
    print("verify: " + ("all checks passed" if not bad else f"{bad} failure(s)"))
    return bad


def extension_ids_from_env(product: CdnConfig) -> list[str]:
    return [x.strip() for x in os.environ.get(product.env("EXTENSION_IDS"), "").split(",") if x.strip()]


def missing_extension_ids(product: CdnConfig, why: str) -> Optional[str]:
    """Why a run that will check a release folder live cannot (no ``_EXTENSION_IDS``), or None.
    A dry run asks too, so that it fails where the run itself would."""
    if extension_ids_from_env(product):
        return None
    return (f"{product.env('EXTENSION_IDS')} is not set: {why} checks the release folder live, and the CORS "
            "check needs each real extension id (store and unpacked)")


def verify_release_live(product: CdnConfig, public_base: str, candidate: Optional[str] = None, expect_id: Optional[str] = None,
                        sessions: bool = False, expect_sha: Optional[str] = None, extension_ids: Optional[list[str]] = None,
                        get: Optional[Get] = None, node: Optional[NodeCheck] = None, config_url: Optional[str] = None,
                        expect_files: Optional[dict[str, str]] = None, geometric: Optional[dict] = None) -> int:
    """The pointer (or a candidate id), its document, the runtime's own checks over https, every
    file's headers and CORS for each extension id, and the geometric index the pointer binds.
    Returns failures."""
    get = get or product_get(product)
    node = node or node_check(product)
    prefix = product.releases_prefix
    bad = 0

    def fail(msg: str) -> None:
        nonlocal bad
        bad += 1
        print(f"FAIL {msg}")

    bust = cache_bust()
    if candidate:
        if not RELEASE_ID.match(candidate):
            fail(f"--candidate {candidate!r} is not a 16-hex id")
            return bad
        rid = candidate
    else:
        url = config_url or f"{public_base}/{CONFIG_KEY}"
        status, h, body = get(f"{url}{'&' if '?' in url else '?'}{bust}")
        if status == 0:
            err = h.get("x-error", "")
            hint = " This Python trusts no certificate authority: python -m pip install certifi." if "CERTIFICATE" in err.upper() else ""
            fail(f"config.json: no answer ({err}).{hint}")
            return bad
        if status != 200:
            fail(f"config.json: HTTP {status}")
            return bad
        cfg = json.loads(body)
        pointer = cfg.get("release")
        if pointer is None:
            if expect_id:
                fail(f"config.json has no release pointer, and {expect_id} was expected")
                return bad
            print("ok   config.json: no release pointer (installs run their bundled release)")
            return 0
        errs = release_pointer_problems(product, pointer)
        for e in errs:
            fail(e)
        if errs:
            return bad
        rid = pointer["id"]
        expect_sha = pointer["sha256"]
        geometric = pointer.get("geometric")
    if expect_id and rid != expect_id:
        fail(f"release {rid} is not the expected {expect_id}")
    doc_url = f"{public_base}/{prefix}{rid}/release.json"
    status, h, doc_bytes = get(f"{doc_url}?{bust}")
    if status != 200:
        fail(f"release.json: HTTP {status}")
        return bad
    sha = hashlib.sha256(doc_bytes).hexdigest()
    if expect_sha and sha != expect_sha:
        fail(f"release.json: sha256 {sha} is not the pointer's {expect_sha}")
    result = node(["--url", doc_url, "--expect-id", rid, *(["--sessions"] if sessions else [])])
    if not result.get("ok"):
        fail(f"runtime check: {result.get('reason')}")
    else:
        print(f"ok   runtime check: release {result['id']}, bank {result['bankEntries']} entries / {result['bankCards']} cards, "
              f"catalog {result['catalogCards']} cards, sessions {result['sessions']}")
    doc = json.loads(doc_bytes)
    ids = extension_ids if extension_ids is not None else extension_ids_from_env(product)
    if not ids:
        fail(f"{product.env('EXTENSION_IDS')} is not set: the CORS check needs each real extension id (store and unpacked)")
    checks = [("release.json", "application/json", sha)] + [(r["path"], pinned_content_type(r["path"]), r["sha256"]) for r in pinned_refs(doc)]
    checks += [(name, ctype, (expect_files or {}).get(name)) for name, ctype in LEGAL_TYPES.items()]
    if geometric:
        checks.append(("geometric.json", "application/json", geometric.get("sha256")))
    bodies: dict[str, bytes] = {}
    for name, ctype, want_sha in checks:
        url = f"{public_base}/{prefix}{rid}/{name}"
        status, h, data = get(f"{url}?{bust}", origin=f"chrome-extension://{ids[0]}" if ids else None)
        if status != 200:
            fail(f"{name}: HTTP {status}")
            continue
        problems = []
        if want_sha and hashlib.sha256(data).hexdigest() != want_sha:
            problems.append("sha256 differs from the release document")
        if h.get("content-type") != ctype:
            problems.append(f"content-type {h.get('content-type')!r}, want {ctype!r}")
        if h.get("cache-control") != RELEASE_CACHE:
            problems.append(f"cache-control {h.get('cache-control')!r}, want {RELEASE_CACHE!r}")
        if nel_problem(h):
            problems.append(nel_problem(h))
        for ext in ids:
            origin = f"chrome-extension://{ext}"
            _, ch, _ = get(f"{url}?{bust}", origin=origin, method="HEAD")
            if ch.get("access-control-allow-origin") not in ("*", origin):
                problems.append(f"no CORS header for {origin}")
        if problems:
            fail(f"{name}: " + "; ".join(problems))
            continue
        bodies[name] = data
        note = ""
        if ctype == "application/json":
            # A GET: a CDN may leave content-encoding off a HEAD answer. The body is not decoded or used.
            _, eh, _ = get(f"{url}?{bust}", headers={"Accept-Encoding": "gzip, br, zstd"})
            enc = eh.get("content-encoding")
            note = f", content-encoding {enc}" if enc else ", WARNING: served uncompressed"
        print(f"ok   {name}: {len(data)} bytes{note}")
    if geometric and "geometric.json" in bodies:
        try:
            key = geo_index_key(json.loads(bodies["geometric.json"]), public_base)
            status, h, mbytes = get(f"{public_base}/{key}?{bust}")
            if status != 200:
                fail(f"geometric index {key}: HTTP {status}")
            elif hashlib.sha256(mbytes).hexdigest() != geometric.get("manifestSha256"):
                fail(f"geometric index {key}: sha256 is not the pointer's manifestSha256")
            else:
                m = json.loads(mbytes)
                gp = geo_binding_problems(m, doc.get("bank"))
                bank_name = (doc.get("bank") or {}).get("path")
                cover = geo_cover_problem(m, bodies[bank_name]) if bank_name in bodies else "the bank was not fetched"
                for p in gp + ([cover] if cover else []):
                    fail(f"geometric index {key}: {p}")
                if not gp and not cover:
                    print(f"ok   geometric index {key}: bound to the release's bank, {len(m.get('cards', []))} cards")
        except (Refused, json.JSONDecodeError) as e:
            fail(f"geometric.json: {e}")
    elif not geometric and product.geometric:
        print("note: no geometric pointer: installs run this release with the geometric stage off")
    print(f"verify-release-live {rid}: " + ("all checks passed" if not bad else f"{bad} failure(s)"))
    return bad


def verify_geo(product: CdnConfig, public_base: str, folder: str, files: list[GeoFile], get: Optional[Get] = None) -> int:
    """Read the index back over HTTPS: every file's bytes, its Cache-Control, and the CORS header
    an extension's request gets."""
    get = get or product_get(product)
    origin = f"chrome-extension://{product.product}"
    bad = 0
    for f in files:
        url = f"{public_base}/{folder}{f.name}"
        status, h, body = get(url, origin=origin)
        problems = []
        if status != 200:
            problems.append(f"HTTP {status} {h.get('x-error', '')}".strip())
        else:
            if hashlib.sha256(body).hexdigest() != f.sha256:
                problems.append("bytes differ from the local file")
            if h.get("cache-control") != GEO_CACHE:
                problems.append(f"cache-control {h.get('cache-control')!r}, want {GEO_CACHE!r}")
            if (h.get("content-type") or "").split(";")[0].strip() != f.content_type:
                problems.append(f"content-type {h.get('content-type')!r}, want {f.content_type!r}")
            if nel_problem(h):
                problems.append(nel_problem(h))
            if h.get("access-control-allow-origin") not in ("*", origin):
                problems.append("no CORS header for an extension origin")
        if problems:
            bad += 1
            print(f"FAIL {url}: {'; '.join(problems)}")
        else:
            print(f"ok   {url} ({len(body)} bytes)")
    return bad
