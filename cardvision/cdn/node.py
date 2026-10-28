# SPDX-License-Identifier: Apache-2.0
"""The runtime's own check of a release, in Node: the product's vendored verify script
(``runtime.dir``/``runtime.verifyScript`` in cdn.config.json). With ``--sessions`` it also starts
both ONNX Runtime sessions. One JSON line out; anything else is a refusal."""

from __future__ import annotations

import json
from typing import Callable

from cardvision.cdn.config import CdnConfig

# What a check is: arguments in (--dir DIR | --url URL, --expect-id ID, [--sessions]), a result out
# ({ok, id, bankEntries, bankCards, catalogCards, sessions, reason}).
NodeCheck = Callable[[list[str]], dict]


def node_verify(product: CdnConfig, args: list[str], run=None) -> dict:
    import subprocess

    run = run or subprocess.run
    extra = ["--user-agent", product.node_user_agent] if product.node_user_agent else []
    r = run(["node", str(product.verify_script), *args, *extra], capture_output=True, text=True)
    lines = [l for l in (r.stdout or "").splitlines() if l.startswith("{")]
    try:
        out = json.loads(lines[-1]) if lines else {}
    except json.JSONDecodeError:
        out = {}
    if not out:
        out = {"ok": False, "reason": f"{product.verify_script.name} gave no result: {(r.stderr or '').strip()[-300:]}"}
    return out


def node_check(product: CdnConfig) -> NodeCheck:
    """The product's check, as publish-release and verify-release-live call it."""
    return lambda args: node_verify(product, args)
