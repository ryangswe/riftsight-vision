# SPDX-License-Identifier: Apache-2.0
"""Where a product publishes: its R2 account, bucket and public base, read from
``<envPrefix>_*`` variables, with the guards that keep it off another project's account."""

from __future__ import annotations

import os
import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from cardvision.cdn.config import CdnConfig, Refused


def load_env_file(product: CdnConfig, path: Path) -> None:
    """Read ``<envPrefix>_*`` entries of a .env file into the environment; every other line is ignored."""
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        if key.startswith(product.env_prefix + "_"):
            os.environ[key] = value.strip().strip('"').strip("'")


@dataclass
class Target:
    account: str
    key_id: str
    secret: str
    bucket: str
    public_base: str


def target_from_env(product: CdnConfig, env: Optional[dict[str, str]] = None, need_secrets: bool = True) -> Target:
    env = dict(os.environ) if env is None else env
    wanted = product.env_keys if need_secrets else (product.env("PUBLIC_BASE"),)
    missing = [k for k in wanted if not env.get(k)]
    if missing:
        raise Refused(f"missing environment: {', '.join(missing)} (docs/cdn.md, 'The environment')")
    t = Target(
        account=env.get(product.env("R2_ACCOUNT_ID"), ""),
        key_id=env.get(product.env("R2_ACCESS_KEY_ID"), ""),
        secret=env.get(product.env("R2_SECRET_ACCESS_KEY"), ""),
        bucket=env.get(product.env("BUCKET"), ""),
        public_base=env[product.env("PUBLIC_BASE")].rstrip("/"),
    )
    check_target(product, t, env)
    if need_secrets:
        problems = credential_problems(product, t)
        if problems:
            raise Refused("credentials in the wrong format (values not shown):\n  " + "\n  ".join(problems))
    return t


def credential_problems(product: CdnConfig, t: Target) -> list[str]:
    """Format checks that never echo a value: a wrong account id builds a hostname Cloudflare has
    no certificate for, which surfaces as an opaque TLS handshake failure."""

    def shape(v: str) -> str:
        return f"{len(v)} characters" + (", contains spaces or quotes" if re.search(r"[\s'\"]", v) else "")

    out = []
    if not re.fullmatch(r"[0-9a-f]{32}", t.account):
        hint = ""
        if "cloudflarestorage" in t.account or "://" in t.account:
            hint = " It looks like the endpoint URL: keep only the 32-character part before .r2.cloudflarestorage.com."
        out.append(f"{product.env('R2_ACCOUNT_ID')} should be 32 lowercase hex characters (the id in dash.cloudflare.com/<id>/…); "
                   f"it has {shape(t.account)}.{hint}")
    if not re.fullmatch(r"[0-9a-f]{32}", t.key_id):
        out.append(f"{product.env('R2_ACCESS_KEY_ID')} should be the token's 32-character Access Key ID; it has {shape(t.key_id)}")
    if not re.fullmatch(r"[0-9a-f]{64}", t.secret):
        out.append(f"{product.env('R2_SECRET_ACCESS_KEY')} should be the token's 64-character Secret Access Key (not the "
                   f"'Token value'); it has {shape(t.secret)}")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", t.bucket):
        out.append(f"{product.env('BUCKET')} should be the bucket's name only (lowercase letters, digits, hyphens); it has {shape(t.bucket)}")
    return out


def check_target(product: CdnConfig, t: Target, env: dict[str, str]) -> None:
    """The decoupling guard: this tool must never touch another project's account, bucket or domain
    (the R2_* credentials of another project, if present in the environment; forbiddenWords)."""
    if t.account and env.get("R2_ACCOUNT_ID") and t.account == env["R2_ACCOUNT_ID"]:
        raise Refused(f"{product.env('R2_ACCOUNT_ID')} equals the environment's R2_ACCOUNT_ID (another project's): "
                      "this tool only publishes to the project's own account")
    if t.key_id and env.get("R2_ACCESS_KEY_ID") and t.key_id == env["R2_ACCESS_KEY_ID"]:
        raise Refused(f"{product.env('R2_ACCESS_KEY_ID')} equals the environment's R2_ACCESS_KEY_ID (another project's)")
    for label, value in ((product.env("BUCKET"), t.bucket), (product.env("PUBLIC_BASE"), t.public_base)):
        if any(w in value.lower() for w in product.forbidden_words):
            raise Refused(f"{label} names another project ({value!r}); this CDN is a separate service")
    if not t.public_base.startswith("https://"):
        raise Refused(f"{product.env('PUBLIC_BASE')} must be an https:// URL")
    base = urllib.parse.urlsplit(t.public_base)
    if not base.netloc or base.path or base.query or base.fragment:
        raise Refused(f"{product.env('PUBLIC_BASE')} must be the host's address only, https://<host> with no path "
                      f"({t.public_base!r}): the extension reads its files at the host's root")


def r2_client(t: Target):
    """The S3 client for the target's R2 account. boto3 is imported here only (the ``cdn`` extra):
    plan --offline, verify and the tests need none."""
    try:
        import boto3
    except ImportError:
        raise Refused('publishing needs boto3, the "cdn" extra: python -m pip install -e ".[cdn]" in a checkout of '
                      "the toolkit, or python -m pip install boto3")

    return boto3.client(
        "s3",
        endpoint_url=f"https://{t.account}.r2.cloudflarestorage.com",
        aws_access_key_id=t.key_id,
        aws_secret_access_key=t.secret,
        region_name="auto",
    )
