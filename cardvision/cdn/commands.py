# SPDX-License-Identifier: Apache-2.0
"""The ``cardvision cdn`` subcommand: publish and verify a product's card pictures, data files,
pages, settings file and remote releases on its own Cloudflare R2 bucket.

::

    cardvision cdn plan    --catalog C --images DIR [--data-file F] [--page F] [--config F] [--offline]
    cardvision cdn publish --catalog C --images DIR [--data-file F] [--page F] [--config F] [--dry-run]
    cardvision cdn publish --config F                    # config.json only
    cardvision cdn verify  [--samples N]
    cardvision cdn publish-geo --dir PACKED --expect-sha256 SHA [--dry-run] [--fix-metadata]
    cardvision cdn verify-geo  --dir PACKED --expect-sha256 SHA
    cardvision cdn publish-release --release DIR --min-version X [--max-version Y] [--legal DIR]
                   [--geometric FILE --geo-manifest-sha256 SHA] [--data-file F]
                   [--config F [--set-pointer]] [--sessions] [--fix-metadata] [--dry-run]
    cardvision cdn verify-release-live [--candidate ID | --config-url U] [--expect-id ID] [--sessions]

Each takes ``--cdn-config FILE``, the product's ``cdn/cdn.config.json`` (``cardvision.cdn.config``;
by default the one under the current folder), and ``--env-file FILE``, whose ``<envPrefix>_*``
entries are read: ``_R2_ACCOUNT_ID``, ``_R2_ACCESS_KEY_ID``, ``_R2_SECRET_ACCESS_KEY``,
``_BUCKET``, ``_PUBLIC_BASE`` (https://<host>, no path) and ``_EXTENSION_IDS`` (the store and
unpacked extension ids, comma-separated). ``plan --offline`` reads ``_PUBLIC_BASE`` when it is set;
``verify`` and ``verify-geo`` need ``_PUBLIC_BASE``; ``verify-release-live`` needs it and
``_EXTENSION_IDS``; every other action needs the four credentials and ``_PUBLIC_BASE``, and
``publish-release``, and ``publish --config`` with a new pointer, need ``_EXTENSION_IDS`` too, a
dry run included.

``publish-geo``/``verify-geo`` and ``--geometric`` need ``"geometric": true``. ``--sessions``
also starts both ONNX Runtime sessions of the release in Node: use it whenever the detector or
recognizer differs from what installs run. A refusal exits 3 and writes nothing; a failure after
the first upload exits 1. Publishing needs the ``cdn`` extra (boto3).

This module only describes the command; the work is imported when it runs.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SUMMARY = "Publish and verify a product's card art, settings and remote releases on its own CDN."
ACTIONS = ("plan", "publish", "verify", "publish-geo", "verify-geo", "publish-release", "verify-release-live")


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Declare the subcommand's arguments."""
    parser.add_argument("action", choices=ACTIONS, help="what to do")
    parser.add_argument("--cdn-config", type=Path, metavar="FILE",
                        help="the product's cdn.config.json (default: cdn/cdn.config.json under the current folder)")
    parser.add_argument("--env-file", help="read <envPrefix>_* entries from this file")
    parser.add_argument("--catalog", help="catalog JSON (entries with an id and an `art` path or null)")
    parser.add_argument("--images", help="directory the `art` paths are relative to")
    parser.add_argument("--config", help="config.json to publish; uploaded last")
    parser.add_argument("--data-file", dest="data_files", action="append", metavar="FILE",
                        help="a data file to publish before config.json (one of the product's dataFiles, named "
                             "by its content hash); may be given once per kind")
    parser.add_argument("--page", help="a page to publish at the CDN's root (one of the product's pages)")
    parser.add_argument("--offline", action="store_true", help="plan: no credentials, treat the CDN as empty")
    parser.add_argument("--dry-run", action="store_true", help="publish, publish-geo, publish-release: every check, nothing written")
    parser.add_argument("--samples", type=int, default=8, help="verify: images to fetch")
    parser.add_argument("--dir", help="publish-geo/verify-geo: the packed geometric index (manifest.json, shard-N.bin)")
    parser.add_argument("--expect-sha256", help="publish-geo/verify-geo: the manifest's SHA-256 the extension pins")
    parser.add_argument("--fix-metadata", action="store_true",
                        help="publish-geo/publish-release: rewrite the metadata of objects already there with the right "
                             "bytes (bytes never change)")
    parser.add_argument("--release", help="publish-release: the release folder (named after its id; cardvision build-release)")
    parser.add_argument("--min-version", help="publish-release: the pointer's minimumExtensionVersion (x.y.z)")
    parser.add_argument("--max-version", help="publish-release: maximumExtensionVersion (exclusive); leave it out unless needed")
    parser.add_argument("--legal", help="publish-release: LICENSE, NOTICE, PROVENANCE.md for this release "
                                        "(default: releases.legalDir)")
    parser.add_argument("--geometric", help="publish-release: the release's geometric settings file (index.path on this CDN)")
    parser.add_argument("--geo-manifest-sha256", help="publish-release: the SHA-256 of that index's manifest")
    parser.add_argument("--set-pointer", action="store_true",
                        help="publish-release: write the pointer (and the data files' entries) into --config first")
    parser.add_argument("--sessions", action="store_true", help="also start the ONNX Runtime sessions in Node (a new model)")
    parser.add_argument("--candidate", help="verify-release-live: a release id on the CDN, without a pointer")
    parser.add_argument("--config-url", help="verify-release-live: read the pointer from this config.json")
    parser.add_argument("--expect-id", help="verify-release-live: the id the pointer must name")


def run(args: argparse.Namespace) -> int:
    """Run one action; 0 done, 1 failed, 3 refused (nothing written)."""
    from cardvision.cdn.config import DEFAULT_CONFIG_PATH, Refused, load_cdn_config
    from cardvision.cdn.geo import geo_plan, publish_geo
    from cardvision.cdn.publish import plan_offline, plan_or_publish, publish_release
    from cardvision.cdn.target import load_env_file, r2_client, target_from_env
    from cardvision.cdn.verify import verify, verify_geo, verify_release_live

    args.command = args.action
    try:
        product = load_cdn_config(args.cdn_config or DEFAULT_CONFIG_PATH)
        if args.env_file:
            load_env_file(product, Path(args.env_file))
        if args.action == "verify":
            return 1 if verify(product, target_from_env(product, need_secrets=False).public_base, args.samples) else 0
        if args.action == "verify-release-live":
            base = target_from_env(product, need_secrets=False).public_base
            return 1 if verify_release_live(product, base, candidate=args.candidate, expect_id=args.expect_id,
                                            sessions=args.sessions, config_url=args.config_url) else 0
        if args.action == "publish-release":
            if not args.release:
                raise Refused("publish-release needs --release DIR")
            return publish_release(product, args, target_from_env(product))
        if args.action in ("publish-geo", "verify-geo"):
            if not product.geometric:
                raise Refused(f"{args.action}: this product has no geometric stage (cdn.config.json geometric: false)")
            if not args.dir:
                raise Refused(f"{args.action} needs --dir")
            folder, files = geo_plan(Path(args.dir), args.expect_sha256 or "")
            if args.action == "verify-geo":
                return 1 if verify_geo(product, target_from_env(product, need_secrets=False).public_base, folder, files) else 0
            t = target_from_env(product)
            print(f"target: bucket {t.bucket}, served at {t.public_base}; folder {folder}")
            return 1 if publish_geo(r2_client(t), t.bucket, folder, files, dry_run=args.dry_run, fix_metadata=args.fix_metadata) else 0
        if args.action == "plan" and args.offline:
            return plan_offline(product, args)
        return plan_or_publish(product, args, target_from_env(product))
    except Refused as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 3


COMMANDS = {"cdn": (SUMMARY, add_arguments, run)}
