# SPDX-License-Identifier: Apache-2.0
"""``cardvision cdn``: credentials from ``<envPrefix>_*`` and the guards that keep a product off
another project's account, bucket and domain."""

from __future__ import annotations

import os

import pytest

from cardvision.cdn.config import Refused
from cardvision.cdn.target import load_env_file, r2_client, target_from_env
from support_cdn import BASE, PANEL_CONFIG, env_for, product, refused


@pytest.fixture
def p(tmp_path):
    return product(PANEL_CONFIG, tmp_path)


def test_a_complete_environment_is_a_target(p):
    t = target_from_env(p, env_for(p))
    assert (t.public_base, t.bucket) == (BASE, "example-bucket")
    assert target_from_env(p, env_for(p, PUBLIC_BASE=BASE + "/")).public_base == BASE


def test_the_same_account_as_another_project_is_refused(p):
    assert refused(lambda: target_from_env(p, env_for(p) | {"R2_ACCOUNT_ID": "a" * 32}))
    assert refused(lambda: target_from_env(p, env_for(p) | {"R2_ACCESS_KEY_ID": "b" * 32}))


@pytest.mark.parametrize("key,value", [
    ("R2_ACCOUNT_ID", "https://" + "a" * 32 + ".r2.cloudflarestorage.com"),
    ("R2_ACCOUNT_ID", "a" * 32 + " "),
    ("R2_ACCOUNT_ID", "A" * 32),
    ("R2_ACCESS_KEY_ID", "x" * 40),
    ("R2_SECRET_ACCESS_KEY", "tokenvalue"),
    ("BUCKET", "s3://example-bucket"),
    ("BUCKET", "otherproject-assets"),
    ("PUBLIC_BASE", "https://assets.otherproject.example"),
    ("PUBLIC_BASE", "http://cdn.example.org"),
    ("PUBLIC_BASE", "https://cdn.example.org/assets"),
    ("PUBLIC_BASE", "https://cdn.example.org/assets/"),
    ("PUBLIC_BASE", "https://cdn.example.org?x=1"),
    ("PUBLIC_BASE", "https://"),
])
def test_wrong_credentials_and_foreign_targets_are_refused(p, key, value):
    assert refused(lambda: target_from_env(p, env_for(p, **{key: value})))


def test_a_credential_is_never_echoed(p):
    with pytest.raises(Refused) as e:
        target_from_env(p, env_for(p, R2_SECRET_ACCESS_KEY="dummy-s3cr3t-value"))
    assert "s3cr3t" not in str(e.value) and "EXAMPLECDN_R2_SECRET_ACCESS_KEY" in str(e.value)


def test_reading_needs_only_the_public_base(p):
    assert refused(lambda: target_from_env(p, {p.env("PUBLIC_BASE"): BASE}))
    assert target_from_env(p, {p.env("PUBLIC_BASE"): BASE}, need_secrets=False).public_base == BASE
    with pytest.raises(Refused, match="EXAMPLECDN_PUBLIC_BASE"):
        target_from_env(p, {}, need_secrets=False)
    with pytest.raises(Refused, match="no path"):
        target_from_env(p, {p.env("PUBLIC_BASE"): BASE + "/vision"}, need_secrets=False)
    with pytest.raises(Refused, match=r"docs/cdn\.md"):
        target_from_env(p, {}, need_secrets=False)


def test_the_env_file_reads_only_the_product_prefix(p, tmp_path, monkeypatch):
    envf = tmp_path / ".env"
    envf.write_text("export EXAMPLECDN_BUCKET='example-bucket'\nR2_SECRET_ACCESS_KEY=nope\nOTHERCDN_BUCKET=x\n# c\n")
    for k in ("EXAMPLECDN_BUCKET", "R2_SECRET_ACCESS_KEY", "OTHERCDN_BUCKET"):
        monkeypatch.delenv(k, raising=False)
    load_env_file(p, envf)
    assert os.environ["EXAMPLECDN_BUCKET"] == "example-bucket"
    assert "R2_SECRET_ACCESS_KEY" not in os.environ and "OTHERCDN_BUCKET" not in os.environ
    monkeypatch.delenv("EXAMPLECDN_BUCKET")


def test_without_boto3_publishing_says_what_to_install(p, monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "boto3", None)
    with pytest.raises(Refused, match=r"boto3, the \"cdn\" extra"):
        r2_client(target_from_env(p, env_for(p)))
