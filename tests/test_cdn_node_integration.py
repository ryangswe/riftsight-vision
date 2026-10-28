# SPDX-License-Identifier: Apache-2.0
"""``cardvision cdn`` and the real Node script: ``node_verify`` runs ``browser/dist/node/verify-release.mjs``
on the toy release and reads its answer.

The other ``cdn`` tests give the tool a fake ``node`` callable. This one runs the script that
``npm run build`` writes in ``browser/``, through the same function ``publish-release`` and
``verify-release-live`` call, so that the two sides cannot drift apart: the arguments the tool
passes (``--dir``, ``--expect-id``, ``--user-agent``) and the JSON line the script prints.

The release is the toy release of ``browser/test/fixtures/toy-release/``, with two stand-in byte
strings pinned in place of its model files (no model file is kept in this repository), as the
browser's own ``verify-release.test.ts`` does. Without ``--sessions`` no model is started, so
the stand-ins are enough. Nothing reaches the network.

The test is skipped when Node, ``browser/node_modules`` or ``browser/dist/node/verify-release.mjs``
is missing (run ``npm ci`` and ``npm run build`` in ``browser/``). With
``CARDVISION_REQUIRE_BROWSER=1`` set, as ``.github/workflows/browser.yml`` sets it, that skip is a
failure instead.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path

import pytest

from cardvision.bank.release import release_id
from cardvision.cdn.config import cdn_config_from_dict
from cardvision.cdn.node import node_verify

ROOT = Path(__file__).resolve().parents[1]
BROWSER = ROOT / "browser"
SCRIPT = BROWSER / "dist" / "node" / "verify-release.mjs"
FIXTURE = BROWSER / "test" / "fixtures" / "toy-release"
NODE = shutil.which("node")

REQUIRED = os.environ.get("CARDVISION_REQUIRE_BROWSER") == "1"
MISSING = ("Node is not installed" if NODE is None
           else "browser/node_modules is missing: run npm ci in browser/" if not (BROWSER / "node_modules").is_dir()
           else "browser/dist/node/verify-release.mjs is missing: run npm run build in browser/" if not SCRIPT.is_file()
           else None)

needs_script = pytest.mark.skipif(MISSING is not None and not REQUIRED,
                                  reason=f"the real verify script is not run: {MISSING}")

# A product whose vendored runtime is this repository's own browser/dist.
PRODUCT = {
    "schemaVersion": 1,
    "product": "exampletoy",
    "envPrefix": "EXAMPLECDN",
    "forbiddenWords": ["otherproject"],
    "settings": {"obsoleteCardLink": False},
    "dataFiles": {},
    "pages": [],
    "geometric": False,
    "runtime": {"dir": "browser/dist", "verifyScript": "node/verify-release.mjs"},
}


def toy_release(folder: Path) -> str:
    """The toy release with stand-in models in ``folder``; returns its id."""
    folder.mkdir()
    for name in ("bank.json", "bank.identity-groups.json", "catalog.json", "accept.json"):
        shutil.copyfile(FIXTURE / name, folder / name)
    doc = json.loads((FIXTURE / "release.json").read_text(encoding="utf-8"))
    for block, body in ((doc["detector"], b"stand-in detector bytes"),
                        (doc["recognizer"], b"stand-in recognizer bytes, a little longer")):
        (folder / block["path"]).write_bytes(body)
        block["sha256"] = hashlib.sha256(body).hexdigest()
        block["bytes"] = len(body)
    doc["id"] = release_id(doc)
    (folder / "release.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    return doc["id"]


@needs_script
def test_the_real_script_is_there_to_run():
    assert MISSING is None, f"CARDVISION_REQUIRE_BROWSER is set and {MISSING}"


@needs_script
def test_node_verify_runs_the_built_script_on_the_toy_release(tmp_path):
    product = cdn_config_from_dict(PRODUCT, ROOT)
    assert product.verify_script == SCRIPT
    rid = toy_release(tmp_path / "release")
    out = node_verify(product, ["--dir", str(tmp_path / "release"), "--expect-id", rid])
    assert out == {"ok": True, "id": rid, "bankEntries": 20, "bankCards": 20, "catalogCards": 20,
                   "sessions": "skipped", "reason": None}


@needs_script
def test_node_verify_reads_the_scripts_refusal(tmp_path):
    product = cdn_config_from_dict(PRODUCT, ROOT)
    rid = toy_release(tmp_path / "release")
    out = node_verify(product, ["--dir", str(tmp_path / "release"), "--expect-id", "0000000000000000"])
    assert out["ok"] is False and out["reason"] == f"id {rid} is not the expected 0000000000000000"
    (tmp_path / "release" / "catalog.json").write_text("{}", encoding="utf-8")
    out = node_verify(product, ["--dir", str(tmp_path / "release"), "--expect-id", rid])
    assert out["ok"] is False and out["reason"]
