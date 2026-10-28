# SPDX-License-Identifier: Apache-2.0
"""Apply a frozen refresh rule to a replay (gate R) or a new-card check (gate N).

::

    cardvision refresh verdict replay  REPLAY_DIR  --rule RULE.txt [--sha-file RULE.SHA256] [--rehearsal]
    cardvision refresh verdict newcard NEWCARD_DIR --rule RULE.txt [--sha-file RULE.SHA256] [--reference DIR]

The rule is a text file written from ``docs/refresh-rule-template.md`` and frozen by its
SHA-256, kept in a file beside it (``RULE.SHA256`` for ``RULE.txt``; its first word is the
hash). Its numbers are read from its one ``PARAMETERS: {...}`` line, which must follow the
schema ``refresh-rule/1`` (``rule_schema.json`` in this package), so the text a person approved
and the check cannot drift apart. A rule whose hash is not the frozen one, or whose PARAMETERS
line is missing or does not match the schema, is refused: nothing is judged, exit 3.

Gate R reads, from REPLAY_DIR, ``diff-<dataset>[-<arm>].json`` (``cardvision refresh diff
--json``) for every dataset and arm; with ``canary``, the canary file; with ``cumulative``,
``<baseRun>/evaluate-hover.json`` and ``diff-cum-<dataset>[-<arm>].json``; with
``realFacesBySource``, the base runs it names. Gate N reads, from NEWCARD_DIR,
``scenes/manifest.json`` and ``scenes/labels.jsonl`` (``cardvision make-composites``), and the
runs ``cand[-<arm>]/`` and ``old[-<arm>]/``; the reference run is ``newcard.referenceDir``,
relative to the rule file's folder, or ``--reference``.

Prints the verdict (PASS, FAIL or INVALID) with every number it used and writes
``VERDICT-R.json`` or ``VERDICT-N.json`` into the folder. Exit 0 PASS, 1 FAIL, 3 INVALID.
An input that is missing or not shaped as the tools write it gives INVALID, never FAIL or a
traceback. A folder that does not exist gives INVALID and nothing is written; a verdict file
that cannot be written turns the verdict into INVALID, so that no PASS goes unrecorded.

``realFacesBySource`` counts, for each source, the readable faces of every source type that
equals one of its ``types`` or starts with one of its ``prefixes``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Mapping
from importlib import resources
from pathlib import Path
from typing import Any

SCHEMA_ID = "refresh-rule/1"
DEFAULT_REHEARSAL_ENV = "REFRESH_REHEARSAL"
DEFAULT_TOLERANCE_PT = 1e-9
GATES = {"replay": "R", "newcard": "N"}
EXIT = {"PASS": 0, "FAIL": 1, "INVALID": 3}
PARAMETERS_LINE = re.compile(r"^PARAMETERS: (\{.*\})$", re.M)
# Reading a JSON input of another shape than expected ([] for an object, null for a block)
# raises one of these; each is an INVALID input, never a FAIL.
INPUT_ERRORS = (OSError, LookupError, TypeError, ValueError, AttributeError)
N3_LABEL = {"fewerWrong": "N3 fewer wrong than the old bank",
            "notWorseOneBetter": "N3 better than the old bank on these cards"}


class RuleError(Exception):
    """The rule cannot be used: another hash than the frozen one, or a bad PARAMETERS line."""


# ------------------------------------------------------------------------------ the schema
def rule_schema() -> dict[str, Any]:
    """The JSON Schema of a PARAMETERS line, ``refresh-rule/1``."""
    return json.loads(resources.files("cardvision.refresh").joinpath("rule_schema.json").read_text(encoding="utf-8"))


def _type_ok(value: Any, kind: str) -> bool:
    if kind == "object":
        return isinstance(value, dict)
    if kind == "array":
        return isinstance(value, list)
    if kind == "string":
        return isinstance(value, str)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    raise ValueError(f"schema type {kind!r} is not supported here")


def schema_errors(value: Any, schema: Mapping[str, Any] | None = None, root: Mapping[str, Any] | None = None,
                  where: str = "PARAMETERS") -> list[str]:
    """What is wrong with ``value`` under ``schema`` (default: the rule schema).

    A small validator for the keywords ``rule_schema.json`` uses, so that ``verdict`` needs no
    library; the tests check it agrees with a full JSON Schema validator.
    """
    if schema is None:
        schema = root = rule_schema()
    root = schema if root is None else root
    if "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/$defs/"):
            raise ValueError(f"schema reference {ref!r} is not supported here")
        return schema_errors(value, root["$defs"][ref.split("/")[-1]], root, where)
    errors: list[str] = []
    if "const" in schema and value != schema["const"]:
        return [f"{where}: must be {json.dumps(schema['const'])}"]
    if "enum" in schema and value not in schema["enum"]:
        return [f"{where}: must be one of {', '.join(json.dumps(x) for x in schema['enum'])}"]
    if "type" in schema and not _type_ok(value, schema["type"]):
        return [f"{where}: must be of type {schema['type']}"]
    if "not" in schema and not schema_errors(value, schema["not"], root, where):
        return [f"{where}: {json.dumps(value)} is not allowed here"]
    if "anyOf" in schema and all(schema_errors(value, branch, root, where) for branch in schema["anyOf"]):
        errors.append(f"{where}: matches none of its allowed forms ({schema.get('description', 'see the schema')})")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{where}: must not be empty")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{where}: {value!r} does not match {schema['pattern']}")
    if _type_ok(value, "number"):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{where}: must be at least {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{where}: must be at most {schema['maximum']}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{where}: must hold at least {schema['minItems']} item(s)")
        if schema.get("uniqueItems") and len({json.dumps(x, sort_keys=True) for x in value}) != len(value):
            errors.append(f"{where}: items must be unique")
        if "items" in schema:
            for i, item in enumerate(value):
                errors += schema_errors(item, schema["items"], root, f"{where}[{i}]")
    if isinstance(value, dict):
        if len(value) < schema.get("minProperties", 0):
            errors.append(f"{where}: must hold at least {schema['minProperties']} key(s)")
        errors += [f"{where}: {key!r} is required" for key in schema.get("required", []) if key not in value]
        properties = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        for key, item in value.items():
            if "propertyNames" in schema:
                errors += schema_errors(key, schema["propertyNames"], root, f"{where} key {key!r}")
            if key in properties:
                errors += schema_errors(item, properties[key], root, f"{where}.{key}")
            elif extra is False:
                errors.append(f"{where}: unknown key {key!r}")
            elif isinstance(extra, dict):
                errors += schema_errors(item, extra, root, f"{where}.{key}")
    return errors


def parameter_errors(p: Any) -> list[str]:
    """The schema's errors, then what the schema cannot say: the per-dataset tables name
    exactly the datasets listed."""
    errors = schema_errors(p)
    if errors:
        return errors
    datasets = set(p["datasets"])
    tables = [("validity", p["validity"]), ("regressions", p["regressions"])]
    if "cumulative" in p:
        tables.append(("cumulative.regressions", p["cumulative"]["regressions"]))
    for name, table in tables:
        if set(table) != datasets:
            errors.append(f"PARAMETERS.{name}: must name exactly the datasets {sorted(datasets)}, names {sorted(table)}")
    return errors


# ------------------------------------------------------------------------------- the rule
def sha_file_for(rule: str | Path) -> Path:
    """The frozen-hash file of a rule: ``RULE.SHA256`` beside ``RULE.txt``."""
    rule = Path(rule)
    return rule.with_suffix(".SHA256") if rule.suffix else rule.with_name(rule.name + ".SHA256")


def load_rule(rule: str | Path, sha_file: str | Path | None = None) -> tuple[dict[str, Any], str]:
    """The rule's parameters and its SHA-256, or ``RuleError`` saying why it is refused."""
    rule = Path(rule)
    sha_file = sha_file_for(rule) if sha_file is None else Path(sha_file)
    try:
        body = rule.read_bytes()
    except OSError as error:
        raise RuleError(f"cannot read the rule: {error}") from None
    got = hashlib.sha256(body).hexdigest()
    try:
        words = sha_file.read_text(encoding="utf-8").split()
    except OSError as error:
        raise RuleError(f"no frozen hash: {error}") from None
    want = words[0] if words else ""
    if got != want:
        raise RuleError(f"{rule.name} sha256 {got} is not the frozen {want or '(empty)'}")
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RuleError(f"{rule.name} is not UTF-8 text: {error}") from None
    found = PARAMETERS_LINE.findall(text)
    if len(found) != 1:
        raise RuleError(f"{rule.name}: expected one 'PARAMETERS: {{...}}' line, found {len(found)}")
    try:
        p = json.loads(found[0])
    except json.JSONDecodeError as error:
        raise RuleError(f"{rule.name}: PARAMETERS is not JSON: {error}") from None
    errors = parameter_errors(p)
    if errors:
        raise RuleError(f"{rule.name}: PARAMETERS does not follow {SCHEMA_ID}: " + "; ".join(errors))
    return p, got


# ------------------------------------------------------------------------------- the runs
def _read(path: str | Path) -> Any:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def overall(run_dir: str | Path) -> dict[str, Any]:
    """The overall counts and rates of an ``evaluate hover --out`` folder."""
    d = _read(Path(run_dir) / "evaluate-hover.json")
    o = d["results"]["overall"]
    c = o["counts"]
    return {"events": o["events"], "faces": c["faceRight"] + c["faceWrong"] + c["faceNothing"], "right": c["faceRight"],
            "wrong": c["faceWrong"], "nothing": c["faceNothing"], "namedRight": o["namedRight"]["value"],
            "wrongOfShown": o["wrongOfShown"]["value"], "release": d["configuration"].get("release")}


def source_faces(run_dir: str | Path) -> dict[str, int]:
    """Readable faces per source type of an ``evaluate hover --out`` folder."""
    d = _read(Path(run_dir) / "evaluate-hover.json")
    out = {}
    for name, part in d["results"].get("bySourceType", {}).items():
        c = part["counts"]
        out[name] = c["faceRight"] + c["faceWrong"] + c["faceNothing"]
    return out


def _arms(p: Mapping[str, Any]) -> list[str | None]:
    return list(p.get("arms") or []) or [None]


def _suffix(arm: str | None) -> str:
    return "" if arm is None else f"-{arm}"


def _within(x: Mapping[str, Any], lim: Mapping[str, Any], tolerance: float) -> tuple[bool, float, float]:
    b, c = x["rates"]["base"], x["rates"]["candidate"]
    dr = (c["namedRight"] - b["namedRight"]) * 100
    dw = (c["wrongOfShown"] - b["wrongOfShown"]) * 100
    ok = (x["regressionCount"] <= lim["maxEvents"] and dr >= -lim["maxNamedRightDropPt"] - tolerance
          and dw <= lim["maxWrongOfShownRisePt"] + tolerance)
    return ok, dr, dw


# ------------------------------------------------------------------------------- the gates
def gate_r(p: Mapping[str, Any], d: str | Path, rehearsal: bool) -> tuple[str, list[str], dict[str, Any]]:
    """Gate R on a replay folder: ``(verdict, notes, detail)``."""
    d = Path(d)
    verdict, notes, rows = "PASS", [], {}
    tolerance = p.get("tolerancePt", DEFAULT_TOLERANCE_PT)
    if "canary" in p:
        canary = d / p["canary"]["file"]
        if not (canary.exists() and _read(canary).get("ok")):
            return "INVALID", [f"no passing canary ({canary}): the baseline release must be re-run in this session "
                               "and equal its frozen events"], rows
        rows["canary"] = _read(canary)
    for data in p["datasets"]:
        need, lim = p["validity"][data], p["regressions"][data]
        for arm in _arms(p):
            name = f"{data}{_suffix(arm)}"
            f = d / f"diff-{name}.json"
            if not f.exists():
                return "INVALID", [f"missing {f}"], rows
            x = _read(f)
            if x["onlyBase"] or x["onlyCandidate"] or x["compared"] < need["minCompared"] or (x["excluded"] and not rehearsal):
                return "INVALID", [f"{name}: compared {x['compared']} (min {need['minCompared']}), only "
                                   f"{x['onlyBase']}/{x['onlyCandidate']}, excluded {x['excluded']}"], rows
            faces = x["rates"]["base"]["faces"]
            if faces < need["minFaces"]:
                return "INVALID", [f"{name}: {faces} readable faces (min {need['minFaces']})"], rows
            ok, dr, dw = _within(x, lim, tolerance)
            rows[name] = {"compared": x["compared"], "faces": faces, "regressions": x["regressionCount"],
                          "byType": x["regressionsByType"], "namedRightDeltaPt": round(dr, 3),
                          "wrongOfShownDeltaPt": round(dw, 3), "improvements": x["improvements"], "ok": ok,
                          "events": {k: v for k, v in x["regressions"].items() if v}}
            if not ok:
                verdict = "FAIL"
                notes.append(f"{name}: {x['regressionCount']} regression(s) (max {lim['maxEvents']}), "
                             f"named right {dr:+.2f} pt, wrong of shown {dw:+.2f} pt")
    if "cumulative" in p:
        cum = p["cumulative"]
        base_id = _read(d / cum["baseRun"] / "evaluate-hover.json")["configuration"].get("release")
        if base_id != cum["baselineRelease"]:
            for data in p["datasets"]:
                lim = cum["regressions"][data]
                for arm in _arms(p):
                    name = f"{data}{_suffix(arm)}"
                    f = d / f"diff-cum-{name}.json"
                    if not f.exists():
                        return "INVALID", [f"base {base_id} is not the baseline release and {f} is missing"], rows
                    x = _read(f)
                    if x["onlyBase"] or x["onlyCandidate"]:
                        return "INVALID", [f"cumulative {name}: events out of step with the baseline run"], rows
                    ok, dr, dw = _within(x, lim, tolerance)
                    rows[f"cumulative-{name}"] = {"regressions": x["regressionCount"], "namedRightDeltaPt": round(dr, 3),
                                                  "wrongOfShownDeltaPt": round(dw, 3), "ok": ok}
                    if not ok:
                        verdict = "FAIL"
                        notes.append(f"cumulative {name} vs the baseline: {x['regressionCount']} regression(s) "
                                     f"(max {lim['maxEvents']}), named right {dr:+.2f} pt, wrong of shown {dw:+.2f} pt")
    if "realFacesBySource" in p:
        real = p["realFacesBySource"]
        per = {}
        for label, source in real["sources"].items():
            exact, prefixes = set(source.get("types", [])), source.get("prefixes", [])
            per[label] = sum(v for run in source["runs"] for k, v in source_faces(d / run).items()
                             if k in exact or any(k.startswith(prefix) for prefix in prefixes))
        rows["realFacesBySource"] = per
        for label, v in per.items():
            if v < real["minFaces"]:
                return "INVALID", [f"real footage: {v} readable {label} faces (min {real['minFaces']})"], rows
    return verdict, notes, rows


def reference_dir(p: Mapping[str, Any], rule: str | Path | None, reference: str | Path | None, arm: str | None) -> Path:
    """The reference run of one arm: ``reference`` (else ``newcard.referenceDir`` beside the
    rule), with ``{arm}`` replaced."""
    template = str(reference) if reference is not None else p["newcard"]["referenceDir"]
    path = Path(template.replace("{arm}", arm or ""))
    if reference is None and rule is not None and not path.is_absolute():
        path = Path(rule).resolve().parent / path
    return path


def gate_n(p: Mapping[str, Any], d: str | Path, rule: str | Path | None = None,
           reference: str | Path | None = None) -> tuple[str, list[str], dict[str, Any]]:
    """Gate N on a new-card folder: ``(verdict, notes, detail)``."""
    d = Path(d)
    q = p["newcard"]
    rows, notes, verdict = {}, [], "PASS"
    man = _read(d / "scenes" / "manifest.json")
    if man.get("seed") != q["seed"] or man.get("scenes") != q["scenes"]:
        return "INVALID", [f"scenes seed/count {man.get('seed')}/{man.get('scenes')}, rule {q['seed']}/{q['scenes']}"], rows
    drawn = set()
    with open(d / "scenes" / "labels.jsonl", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                drawn |= {o["cardId"] for o in json.loads(line)["objects"] if o.get("kind") == "face" and o.get("cardId")}
    with_art = man["catalog"]["cardsWithArt"]
    rows["drawn"] = {"cards": len(drawn), "withArt": with_art}
    if with_art < q.get("minNewCards", 1) or len(drawn) < q["minDrawnShare"] * with_art:
        return "INVALID", [f"only {len(drawn)} of {with_art} new cards drawn (min {q['minDrawnShare']:.0%})"], rows
    n3_label = N3_LABEL[q["n3"]]
    for arm in _arms(p):
        prefix = "" if arm is None else f"{arm}: "
        try:
            cand, old = overall(d / f"cand{_suffix(arm)}"), overall(d / f"old{_suffix(arm)}")
            ref = overall(reference_dir(p, rule, reference, arm))
        except FileNotFoundError as error:
            return "INVALID", [f"missing run: {error.filename}"], rows
        if abs(cand["events"] - ref["events"]) > q["maxEventCountDiffShare"] * ref["events"] or cand["events"] != old["events"]:
            return "INVALID", [f"{prefix}events cand {cand['events']} / old {old['events']} / reference {ref['events']}"], rows
        n1 = cand["namedRight"] >= ref["namedRight"] - q["maxNamedRightBelowRefPt"] / 100
        n2 = cand["wrongOfShown"] <= ref["wrongOfShown"] + q["maxWrongOfShownAboveRefPt"] / 100
        if q["n3"] == "fewerWrong":
            n3 = cand["wrong"] < old["wrong"]
        else:
            n3 = (cand["wrong"] <= old["wrong"] and cand["right"] >= old["right"]
                  and (cand["wrong"] < old["wrong"] or cand["right"] > old["right"]))
        rows["runs" if arm is None else arm] = {"candidate": cand, "oldBank": old, "reference": ref,
                                                "N1 named right": n1, "N2 wrong of shown": n2, n3_label: n3}
        if not (n1 and n2 and n3):
            verdict = "FAIL"
            notes.append(f"{prefix}named right {cand['namedRight']:.4f} vs ref {ref['namedRight']:.4f} (N1 {n1}); "
                         f"wrong of shown {cand['wrongOfShown']:.4f} vs ref {ref['wrongOfShown']:.4f} (N2 {n2}); "
                         f"right/wrong faces {cand['right']}/{cand['wrong']} vs old bank {old['right']}/{old['wrong']} "
                         f"(N3 {n3})")
    return verdict, notes, rows


# --------------------------------------------------------------------------- one entry point
def judge(gate: str, folder: str | Path, rule: str | Path, *, sha_file: str | Path | None = None,
          rehearsal: bool | None = None, reference: str | Path | None = None, write: bool = True) -> dict[str, Any]:
    """Judge ``folder`` by ``rule`` for ``gate`` (``"replay"`` or ``"newcard"``).

    Returns the verdict document (``gate``, ``rule``, ``verdict``, ``notes``, ``detail``,
    ``rehearsal``) and, with ``write``, writes it to ``VERDICT-<R|N>.json`` in the folder.
    ``rehearsal`` left as ``None`` reads the rule's ``rehearsalEnv`` variable. A refused rule
    raises ``RuleError`` and writes nothing. A missing folder, a malformed input or a verdict
    file that cannot be written gives INVALID (see the module's description).
    """
    if gate not in GATES:
        raise ValueError(f"gate must be one of {sorted(GATES)}")
    p, sha = load_rule(rule, sha_file)
    if rehearsal is None:
        rehearsal = os.environ.get(p.get("rehearsalEnv", DEFAULT_REHEARSAL_ENV)) == "1"
    present = Path(folder).is_dir()
    if not present:
        verdict, notes, rows = "INVALID", [f"no folder at {folder}"], {}
    else:
        try:
            if gate == "replay":
                verdict, notes, rows = gate_r(p, folder, rehearsal)
            else:
                verdict, notes, rows = gate_n(p, folder, rule, reference)
        except INPUT_ERRORS as error:
            # an input that is missing or not shaped as the tools write it: never a FAIL, never a PASS
            verdict, notes, rows = "INVALID", [f"unreadable input: {type(error).__name__}: {error}"], {}
    out = {"gate": GATES[gate], "rule": sha, "verdict": verdict, "notes": notes, "detail": rows,
           "rehearsal": rehearsal}
    if write and present:
        target = Path(folder, f"VERDICT-{out['gate']}.json")
        try:
            target.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
        except OSError as error:
            out["verdict"] = "INVALID"
            out["notes"] = [*out["notes"], f"could not write {target}: {error}"]
    return out


def verdict_exit(document: Mapping[str, Any]) -> int:
    """The exit code of a verdict document."""
    return EXIT[document["verdict"]]

