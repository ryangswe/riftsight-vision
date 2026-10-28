# SPDX-License-Identifier: Apache-2.0
"""The structural preconditions of a refresh: a candidate release against the live (base) one.

::

    cardvision refresh check CANDIDATE/release.json --base LIVE/release.json
        [--live-config CONFIG.json [--bundled-id ID]] [--editable name,facets] [--near 0.90]
        [--duplicate-vectors refuse|same-identity|report]
        [--geometric CAND_GEO.json --base-geometric BASE_GEO.json] [--cardvision "COMMAND"] [--json OUT.json]

Read-only. Either release may hold its bank in either form, JSON or binary (``bank.bin``,
``cardvision convert-release``); the checks read both as the same document. A refresh appends new cards to a release and changes nothing else; these checks say
so before anything is scored. Any failed check makes the rule's verdict INVALID.

P0 (with ``--live-config``)
    the base is the release the live settings file names; read that file when the session
    starts. When it names none, the base must be the release shipped with the extension,
    ``--bundled-id`` (which needs ``--live-config``). Without ``--live-config`` P0 is listed as
    not checked (``"ok": null``), and the candidate is never reported bank-only: bank-only says
    that the candidate only adds to what users have now, which P0 establishes.
P1
    the candidate's models and accept rule equal the base's, byte for byte; so do its other
    settings blocks (identity settings, hover, runtime, game, locale).
P2
    existing bank rows are untouched and in their order, new rows only follow them, one for each
    added catalog entry with an image; the header is unchanged and the version higher (also
    ``cardvision check-refresh``: additive, 0 re-embedded); no added row repeats the vector of
    another row, which would point to a placeholder or a copied image. ``--duplicate-vectors``
    sets how strict that last check is: ``refuse`` (the default) fails on any repeated vector;
    ``same-identity`` allows a repeat between two ids of one identity in the candidate's
    identity groups (a reprint given a new id with the very same picture) and fails on any
    other; ``report`` lists repeats and passes. Every mode records the mode and the pairs
    (``duplicateVectors``).
P2b (reported, not checked)
    each added row's closest row of another identity, with their cosine. Rows at ``--near`` or
    closer are listed with that pair, and the candidate is then not bank-only, so a person
    publishes it. Two cards may share a picture legitimately, which is why this asks a person
    instead of failing.
P3
    the catalog header is unchanged and every existing entry is still there, changing only in the
    fields of ``--editable`` (listed as edits; any edit means not bank-only); an added entry's
    ``printingOf`` is null or a root; existing ids that shared an identity still share one and
    those that did not still do not; an added printing ends up in the identity of the existing
    card it reprints; the identity groups belong to the candidate's bank.
P4
    ``cardvision verify-release`` accepts both releases. With ``--geometric``: the geometric
    settings equal ``--base-geometric`` except for ``index``; the index file hashes to the pinned
    SHA-256 and names the candidate's bank; ``packed/manifest.json`` next to the settings is a
    packing of that index.

Prints one JSON verdict (``ok``, ``bankOnly``, ``p0Checked``, ``newCards``, ``catalogEdits``,
``nearDuplicates``, ``checks``); exit 0 only when every check that ran holds.
``--cardvision`` is the command that runs cardvision for ``check-refresh`` and
``verify-release`` (default: this Python with ``-m cardvision``).
"""

from __future__ import annotations

import base64
import hashlib
import json
import subprocess
import sys
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path
from typing import Any

DEFAULT_NEAR = 0.90
DUPLICATE_MODES = ("refuse", "same-identity", "report")
_BANK_COUNTS = ("entries", "version", "cardCount", "entryCount")


def _sha(path: str | Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _read(path: str | Path) -> Any:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def _read_bank(path: str | Path) -> Any:
    """A bank file in either form, JSON or binary (``bank.bin``), as its JSON document."""
    from cardvision.core.bank_binary import read_bank_file

    return read_bank_file(path)


def _identity_of(groups: dict[str, Any]) -> Callable[[str], str]:
    rep = groups["representative"]
    return lambda card_id: rep.get(card_id, card_id)


def default_cardvision() -> list[str]:
    """The command that runs cardvision: this Python, ``-m cardvision``."""
    return [sys.executable, "-m", "cardvision"]


def near_duplicates(base_entries: Sequence[dict[str, Any]], appended: Sequence[dict[str, Any]],
                    representative: dict[str, str]) -> list[dict[str, Any]]:
    """For each appended row, its nearest base row of another identity and their cosine."""
    if not appended:
        return []
    import numpy as np

    def vector(entry):
        return np.frombuffer(base64.b64decode(entry["vec"]), dtype=np.float16).astype(np.float32)

    matrix = np.stack([vector(e) for e in base_entries])
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True)
    ids = [e["cardId"] for e in base_entries]
    reps = np.array([representative.get(i, i) for i in ids])
    near = []
    for entry in appended:
        v = vector(entry)
        v /= np.linalg.norm(v)
        sims = matrix @ v
        sims[reps == representative.get(entry["cardId"], entry["cardId"])] = -1.0  # same identity: no collision
        j = int(np.argmax(sims))
        near.append({"cardId": entry["cardId"], "nearest": ids[j], "cosine": round(float(sims[j]), 4)})
    return near


def check_release(release: str | Path, base: str | Path, *, live_config: str | Path | None = None,
                  bundled_id: str | None = None, editable: Iterable[str] = (), near: float = DEFAULT_NEAR,
                  geometric: str | Path | None = None, base_geometric: str | Path | None = None,
                  cardvision: Sequence[str] | None = None, duplicate_vectors: str = "refuse") -> dict[str, Any]:
    """The verdict document of ``refresh check`` (see the module's description)."""
    if duplicate_vectors not in DUPLICATE_MODES:
        raise ValueError(f"duplicate_vectors must be one of {', '.join(DUPLICATE_MODES)}")
    if (geometric is None) != (base_geometric is None):
        raise ValueError("geometric and base_geometric go together")
    if bundled_id is not None and live_config is None:
        raise ValueError("bundled_id needs live_config")
    command = list(cardvision) if cardvision else default_cardvision()
    editable = list(dict.fromkeys(editable))
    out: dict[str, dict[str, Any]] = {}
    ok = True

    def check(name: str, cond: Any, detail: str = "") -> None:
        nonlocal ok
        out[name] = {"ok": bool(cond), "detail": detail}
        ok = ok and bool(cond)

    def cv(*words: str) -> subprocess.CompletedProcess:
        return subprocess.run([*command, *words], capture_output=True, text=True)

    new, old = _read(release), _read(base)
    live_id = None
    if live_config is not None:
        cfg = _read(live_config)
        live_id = cfg.get("release", {}).get("id") if isinstance(cfg.get("release"), dict) else None
        want_base = live_id or bundled_id
        check("P0 base is the live release", want_base is not None and old["id"] == want_base,
              f"config release {live_id or f'absent (bundled {bundled_id})'}; base {old['id']}")
    else:
        out["P0 live configuration (not checked)"] = {"ok": None, "detail": "no live settings file given"}
    nd, bd = Path(release).resolve().parent, Path(base).resolve().parent
    for part in ("detector", "recognizer"):
        check(f"P1 {part}", new[part] == old[part] and _sha(nd / new[part]["path"]) == old[part]["sha256"],
              old[part]["sha256"][:16])
    check("P1 accept", new["accept"] == old["accept"], json.dumps(new["accept"]))
    for key in ("game", "locale", "hover", "runtime"):
        check(f"P1 {key}", new.get(key) == old.get(key))
    check("P1 identity settings", {k: v for k, v in new["identity"].items() if k != "groups"}
          == {k: v for k, v in old["identity"].items() if k != "groups"})

    nb, bb = _read_bank(nd / new["bank"]["path"]), _read_bank(bd / old["bank"]["path"])
    check("P2 bank header", {k: v for k, v in nb.items() if k not in _BANK_COUNTS}
          == {k: v for k, v in bb.items() if k not in _BANK_COUNTS} and nb["version"] > bb["version"],
          f"version {bb['version']} -> {nb['version']}")
    shared = nb["entries"][:len(bb["entries"])]
    same = len(nb["entries"]) >= len(bb["entries"]) and all(
        json.dumps(x, sort_keys=True) == json.dumps(y, sort_keys=True) for x, y in zip(shared, bb["entries"]))
    appended = nb["entries"][len(bb["entries"]):]
    check("P2 base rows kept, in order", same, f"{len(bb['entries'])} base rows, {len(appended)} appended")
    r = cv("check-refresh", str(bd / old["bank"]["path"]), str(nd / new["bank"]["path"]),
           "--old-groups", str(bd / old["identity"]["groups"]["path"]),
           "--new-groups", str(nd / new["identity"]["groups"]["path"]))
    text = (r.stdout + r.stderr).strip()
    check("P2 check-refresh: additive, 0 re-embedded", r.returncode == 0 and " 0 re-embedded" in text, text[-300:])
    appended_ids = {x["cardId"] for x in appended}
    by_vector: dict[str, list[str]] = {}
    for entry in nb["entries"]:
        by_vector.setdefault(entry["vec"], []).append(entry["cardId"])
    dup = sorted({tuple(v) for v in by_vector.values() if len(v) > 1 and any(i in appended_ids for i in v)})
    ng = _read(nd / new["identity"]["groups"]["path"])
    nid_rep = _identity_of(ng)
    pairs = [{"ids": [a, b], "sameIdentity": nid_rep(a) == nid_rep(b)}
             for group in dup for i, a in enumerate(group) for b in group[i + 1:]
             if a in appended_ids or b in appended_ids]
    if duplicate_vectors == "refuse":
        dup_ok = not pairs
    elif duplicate_vectors == "same-identity":
        dup_ok = all(pair["sameIdentity"] for pair in pairs)
    else:
        dup_ok = True
    check("P2 no appended row duplicates another row's vector", dup_ok,
          f"mode {duplicate_vectors}; {len(pairs)} pair(s): {dup[:10]}")

    found_near = near_duplicates(bb["entries"], appended, ng["representative"])
    flagged = [x for x in found_near if x["cosine"] >= near]
    out["P2b near-duplicate report (not a check)"] = {
        "ok": True, "detail": f"{len(flagged)} of {len(found_near)} appended rows >= {near}; "
                              f"max {max([x['cosine'] for x in found_near], default=None)}"}

    nc, bc = _read(nd / new["catalog"]["path"]), _read(bd / old["catalog"]["path"])
    check("P3 catalog header", {k: v for k, v in nc.items() if k not in ("cards", "facets")}
          == {k: v for k, v in bc.items() if k not in ("cards", "facets")})
    ncm, bcm = {c["id"]: c for c in nc["cards"]}, {c["id"]: c for c in bc["cards"]}
    dropped = sorted(set(bcm) - set(ncm))
    check("P3 no base entry dropped", not dropped and len(ncm) == len(nc["cards"]), f"{dropped[:10]}")
    edits, bad_edits = {}, []
    for card_id, card in bcm.items():
        now = ncm.get(card_id)
        if now is None or now == card:
            continue
        changed = sorted(k for k in set(card) | set(now) if card.get(k) != now.get(k))
        if set(changed) <= set(editable):
            edits[card_id] = changed
        else:
            bad_edits.append((card_id, changed))
    check(f"P3 base entries change {'/'.join(editable)} only" if editable else "P3 base entries kept unchanged",
          not bad_edits, f"{bad_edits[:10]}")
    added = [c for c in nc["cards"] if c["id"] not in bcm]
    with_art = sorted(c["id"] for c in added if c.get("art"))
    check("P2 appended rows = new entries with art", sorted(e["cardId"] for e in appended) == with_art,
          f"{len(appended)} rows, {len(with_art)} new entries with art, {len(added) - len(with_art)} without art")
    roots_ok = all(c.get("printingOf") is None or (c["printingOf"] in ncm and ncm[c["printingOf"]].get("printingOf") is None)
                   for c in added)
    check("P3 printingOf names a root", roots_ok)

    bg = _read(bd / old["identity"]["groups"]["path"])
    nid, bid = _identity_of(ng), _identity_of(bg)
    forward, back, broken = {}, {}, []
    for card_id in bcm:
        x, y = bid(card_id), nid(card_id)
        if forward.setdefault(x, y) != y or back.setdefault(y, x) != x:
            broken.append(card_id)
    check("P3 base identities unchanged (none merged or split)", not broken, f"{broken[:10]}")
    orphan = [c["id"] for c in added if c.get("printingOf") in bcm and nid(c["id"]) != nid(c["printingOf"])]
    check("P3 new printings of base cards join their identity", not orphan, f"{orphan[:10]}")
    check("P3 groups bound to the candidate bank",
          ng["bank"]["sha256"] == new["bank"]["sha256"] == _sha(nd / new["bank"]["path"]))

    for label, path in (("candidate", release), ("base", base)):
        r = cv("verify-release", str(path))
        said = (r.stdout + r.stderr).strip()
        check(f"P4 verify-release {label}", r.returncode == 0, said.splitlines()[0] if said else "")

    if geometric is not None:
        g, gb = _read(geometric), _read(base_geometric)

        def settings(doc):
            return {k: v for k, v in doc.items() if k != "index"}

        check("P4 same geometric settings", settings(g) == settings(gb))
        gd = Path(geometric).resolve().parent
        index_path = gd / g["index"]["path"]
        index_sha = _sha(index_path)
        check("P4 index pinned", index_sha == g["index"]["sha256"], index_sha)
        with open(index_path, encoding="utf-8") as handle:
            head = handle.read(4096)
        check("P4 index bound to the candidate bank", new["bank"]["sha256"] in head)
        manifest = gd / "packed" / "manifest.json"
        if manifest.exists():
            m = _read(manifest)
            check("P4 packed manifest repacks the index",
                  m["source"]["sha256"] == index_sha and m["bank"]["sha256"] == new["bank"]["sha256"],
                  f"manifest sha256 {_sha(manifest)}")
        else:
            check("P4 packed manifest present", False, str(manifest))

    return {"release": new["id"], "base": old["id"], "ok": ok,
            "newCards": {"withArt": len(with_art), "withoutArt": len(added) - len(with_art)},
            "catalogEdits": {"count": len(edits), "ids": dict(list(edits.items())[:50])},
            "liveConfigRelease": live_id,
            "nearDuplicates": sorted(flagged, key=lambda x: -x["cosine"]),
            "duplicateVectors": {"mode": duplicate_vectors, "pairs": pairs},
            "bankOnly": ok and live_config is not None and not edits and not flagged,
            "p0Checked": live_config is not None,
            "checks": out}
