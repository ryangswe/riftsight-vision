# SPDX-License-Identifier: Apache-2.0
"""``cardvision cdn publish-release``: the refresh gate in front of a pointer move (both refresh
verdicts, a PASS that is not a rehearsal, under one rule; or ``--no-refresh-gate`` with a reason),
and the release index (read before anything is uploaded, a failed read refused, a run after a
crash recorded). Against a fake bucket, a fake public CDN and a fake Node check; no network."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from cardvision.cdn import commands
from cardvision.cdn import config as cdn_config
from cardvision.cdn.config import CONFIG_KEY, Refused
from cardvision.cdn.publish import plan_or_publish, publish_release
from cardvision.cdn.target import Target
from support_cdn import (
    BASE, EXAMPLE_SETTINGS, PANEL_CONFIG, RID, FakeS3, NoKey, no_urlopen, node_ok, product, quiet, release_args,
    same_models, write_release,
)

pytestmark = pytest.mark.usefixtures("no_urlopen", "extension_ids")
TGT = Target("a" * 32, "b" * 32, "c" * 64, "example-bucket", BASE)
INDEX = "vision/releases/index.json"
RULE = "1" * 64
NULL = object()  # a JSON null in a verdict (None removes the key)


@pytest.fixture
def extension_ids(monkeypatch):
    monkeypatch.setenv(f"{PANEL_CONFIG['envPrefix']}_EXTENSION_IDS", "e" * 32)


def no_pointer(url, **k):
    """A live CDN whose config.json has no release pointer."""
    return (200, {}, json.dumps(EXAMPLE_SETTINGS).encode()) if url.split("?")[0].endswith(CONFIG_KEY) else (404, {}, b"")


def verdict(folder: Path, which: str, **over) -> Path:
    """A verdict file as ``cardvision refresh verdict`` writes it for gate `which`, with `over` applied
    (None removes a key)."""
    doc = {"gate": which, "rule": RULE, "verdict": "PASS", "notes": [], "detail": {}, "rehearsal": False}
    for key, value in over.items():
        if value is None:
            doc.pop(key, None)
        else:
            doc[key] = None if value is NULL else value
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"VERDICT-{which}.json"
    path.write_text(json.dumps(doc, indent=1) + "\n")
    return path


@pytest.fixture
def setup(tmp_path):
    folder, legal, _doc, refs = write_release(tmp_path)
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps(EXAMPLE_SETTINGS))
    r = verdict(tmp_path / "replay", "R")
    n = verdict(tmp_path / "newcard", "N")
    args = release_args(folder, legal, cfg_file, set_pointer=True, no_refresh_gate=None, verdict_r=str(r), verdict_n=str(n))
    return SimpleNamespace(tmp=tmp_path, folder=folder, legal=legal, refs=refs, cfg_file=cfg_file, r=r, n=n, args=args,
                           p=product(PANEL_CONFIG, tmp_path))


def run(s, args, s3, log=quiet, get=no_pointer, node=node_ok):
    return publish_release(s.p, args, TGT, s3=s3, node=node, log=log, get=get, runtimes=same_models(s.refs),
                           verify_live=lambda *a, **k: 0, verify_after=lambda b, n: 0)


def with_args(s, **k):
    return SimpleNamespace(**{**vars(s.args), **k})


def untouched(s, s3):
    """Nothing written: no object on the bucket, the config file as it was."""
    return not s3.puts and s.cfg_file.read_text() == json.dumps(EXAMPLE_SETTINGS)


# ---------------------------------------------------------------------------------- the gate
def test_two_passing_verdicts_publish_as_before_and_the_log_names_both_files(setup):
    lines: list[str] = []
    gated = FakeS3()
    assert run(setup, with_args(setup, dry_run=False), gated, log=lines.append) == 0
    plain = FakeS3()
    setup.cfg_file.write_text(json.dumps(EXAMPLE_SETTINGS))
    assert run(setup, with_args(setup, dry_run=False, verdict_r=None, verdict_n=None, no_refresh_gate="a first release"),
               plain) == 0
    assert gated.put_keys == plain.put_keys and gated.put_keys[-1] == CONFIG_KEY, "the same uploads, the pointer last"
    assert gated.objects[CONFIG_KEY]["Body"] == plain.objects[CONFIG_KEY]["Body"]
    for gate, path in (("R", setup.r), ("N", setup.n)):
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        assert f"refresh gate: {gate} PASS under rule {RULE}, {path} sha256 {sha}" in lines


BAD = [
    ("R FAIL", "R", {"verdict": "FAIL"}, "VERDICT-R.json: 'FAIL', not PASS"),
    ("N INVALID", "N", {"verdict": "INVALID"}, "VERDICT-N.json: 'INVALID', not PASS"),
    ("R rehearsal", "R", {"rehearsal": True}, "VERDICT-R.json: a rehearsal verdict"),
    ("N with no rehearsal field", "N", {"rehearsal": None}, "VERDICT-N.json: no rehearsal field"),
    ("R rehearsal not a boolean", "R", {"rehearsal": "no"}, "VERDICT-R.json: a rehearsal verdict"),
    ("N rehearsal null", "N", {"rehearsal": NULL}, "VERDICT-N.json: a rehearsal verdict \\(rehearsal None\\)"),
    ("R rehearsal 0", "R", {"rehearsal": 0}, "VERDICT-R.json: a rehearsal verdict \\(rehearsal 0\\)"),
    ("rules differ", "N", {"rule": "2" * 64}, "judged under different rules"),
    ("N with no rule", "N", {"rule": None}, "VERDICT-N.json: no rule SHA-256"),
    ("R with a rule and a newline", "R", {"rule": RULE + "\n"}, "VERDICT-R.json: no rule SHA-256"),
    ("an N verdict given as R", "R", {"gate": "N"}, "not a gate R verdict"),
]


@pytest.mark.parametrize("dry_run", [True, False])
@pytest.mark.parametrize("name,gate,over,reason", BAD, ids=[b[0] for b in BAD])
def test_a_verdict_that_does_not_allow_the_move_is_refused_before_anything(setup, name, gate, over, reason, dry_run):
    verdict(setup.tmp / ("replay" if gate == "R" else "newcard"), gate, **over)
    s3 = FakeS3()
    asked = []
    with pytest.raises(Refused, match=reason):
        run(setup, with_args(setup, dry_run=dry_run), s3, get=lambda *a, **k: asked.append(a) or no_pointer(*a, **k),
            node=lambda a: asked.append(a) or node_ok(a))
    assert untouched(setup, s3) and not asked, "refused before any read from the network, any check or any write"


@pytest.mark.parametrize("dry_run", [True, False])
def test_a_verdict_that_is_missing_or_not_a_verdict_is_refused(setup, dry_run):
    (setup.tmp / "junk.json").write_text("{not json")
    (setup.tmp / "deep.json").write_text("[" * 100_000 + "]" * 100_000)
    for over, reason in (({"verdict_n": str(setup.tmp / "nowhere.json")}, "--verdict-n .*nowhere.json: cannot be read"),
                         ({"verdict_r": str(setup.tmp / "junk.json")}, "--verdict-r .*junk.json: not a verdict file"),
                         ({"verdict_r": str(setup.cfg_file)}, "not a gate R verdict"),
                         ({"verdict_n": str(setup.tmp / "deep.json")}, "--verdict-n .*deep.json: not a verdict file"),
                         ({"verdict_r": str(setup.tmp)}, "--verdict-r .*: cannot be read")):
        s3 = FakeS3()
        with pytest.raises(Refused, match=reason):
            run(setup, with_args(setup, dry_run=dry_run, **over), s3)
        assert untouched(setup, s3)


@pytest.mark.parametrize("dry_run", [True, False])
def test_a_move_with_no_verdicts_or_a_bad_opt_out_is_refused(setup, dry_run):
    cases = [
        ({"verdict_r": None, "verdict_n": None}, "--verdict-r and --verdict-n missing.*--no-refresh-gate"),
        ({"verdict_n": None}, "needs the refresh verdicts: --verdict-n missing"),
        ({"verdict_r": None, "verdict_n": None, "no_refresh_gate": ""}, "--no-refresh-gate needs the reason"),
        ({"verdict_r": None, "verdict_n": None, "no_refresh_gate": "   "}, "--no-refresh-gate needs the reason"),
        ({"verdict_r": None, "verdict_n": None, "no_refresh_gate": f"x\nrefresh gate: R PASS under rule {RULE}"},
         "the reason is one line of printable text"),
        ({"no_refresh_gate": "a first release"}, "--no-refresh-gate and --verdict-r/--verdict-n"),
        ({"verdict_n": None, "no_refresh_gate": "a first release"}, "--no-refresh-gate and --verdict-r/--verdict-n"),
        ({"verdict_r": "", "verdict_n": None, "no_refresh_gate": "a first release"}, "--no-refresh-gate and --verdict-r/--verdict-n"),
    ]
    for over, reason in cases:
        s3 = FakeS3()
        with pytest.raises(Refused, match=reason):
            run(setup, with_args(setup, dry_run=dry_run, **over), s3)
        assert untouched(setup, s3), over


def test_the_opt_out_publishes_and_logs_its_reason(setup):
    lines: list[str] = []
    s3 = FakeS3()
    args = with_args(setup, dry_run=False, verdict_r=None, verdict_n=None, no_refresh_gate=" new models ")
    assert run(setup, args, s3, log=lines.append) == 0
    assert "refresh gate: none, new models" in lines
    assert s3.put_keys[-1] == CONFIG_KEY


def test_a_pointer_move_without_set_pointer_is_gated_too(setup):
    """--config whose release field already names this release moves the pointer as well."""
    s3 = FakeS3()
    assert run(setup, with_args(setup, dry_run=False), s3) == 0
    s3 = FakeS3()
    with pytest.raises(Refused, match="needs the refresh verdicts"):
        run(setup, with_args(setup, set_pointer=False, verdict_r=None, verdict_n=None), s3)
    assert not s3.puts


def test_no_gate_without_config_or_for_a_rollback(setup):
    """The folder alone (no --config) moves no pointer; a rollback is ``publish --config``."""
    s3 = FakeS3()
    args = with_args(setup, dry_run=False, config=None, set_pointer=False, verdict_r=None, verdict_n=None)
    assert run(setup, args, s3) == 0
    lines: list[str] = []
    assert run(setup, with_args(setup, config=None, set_pointer=False), FakeS3(), log=lines.append) == 0
    assert any("refresh gate: not needed, no --config" in line for line in lines), "verdicts given without --config: said so"
    assert CONFIG_KEY not in s3.objects and f"vision/releases/{RID}/release.json" in s3.objects
    rollback = setup.tmp / "live-config.json"
    rollback.write_text(json.dumps(EXAMPLE_SETTINGS))
    s3 = FakeS3()
    publish = SimpleNamespace(command="publish", catalog=None, images=None, config=str(rollback), data_files=None,
                              page=None, dry_run=False, offline=False)
    assert plan_or_publish(setup.p, publish, TGT, s3=s3, get=no_pointer, log=quiet) == 0
    assert s3.put_keys == [CONFIG_KEY]


# ------------------------------------------------------------------------------- the index
def test_a_run_after_a_crash_records_the_release_once(setup, monkeypatch):
    times = iter(["2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z"])
    monkeypatch.setattr(cdn_config, "utc_now", lambda: next(times))
    args = with_args(setup, dry_run=False)
    s3 = FakeS3(fail=("index.json",))
    with pytest.raises(RuntimeError, match="boom"):
        run(setup, args, s3)
    assert INDEX not in s3.objects and f"vision/releases/{RID}/release.json" in s3.objects, "the crash: files, no index"
    s3.fail = set()
    setup.cfg_file.write_text(json.dumps(EXAMPLE_SETTINGS))
    uploads = len(s3.puts)
    assert run(setup, args, s3) == 0
    assert [k for k, *_ in s3.puts[uploads:]][0] == INDEX, "nothing to upload, and the index is written"
    first = json.loads(s3.objects[INDEX]["Body"])["releases"][RID]["publishedAt"]
    setup.cfg_file.write_text(json.dumps(EXAMPLE_SETTINGS))
    again = len(s3.puts)
    assert run(setup, args, s3) == 0
    assert INDEX not in [k for k, *_ in s3.puts[again:]], "already recorded: the index is not written again"
    assert json.loads(s3.objects[INDEX]["Body"])["releases"][RID]["publishedAt"] == first


class BrokenIndex(FakeS3):
    """A bucket whose index read fails with `error`."""

    def __init__(self, error: Exception, **k):
        super().__init__(**k)
        self.error = error

    def get_object(self, *, Bucket, Key):
        if Key == INDEX:
            raise self.error
        return super().get_object(Bucket=Bucket, Key=Key)


class ServerError(Exception):
    response = {"Error": {"Code": "InternalError"}}


@pytest.mark.parametrize("dry_run", [True, False])
@pytest.mark.parametrize("make,reason", [
    (lambda: BrokenIndex(ServerError("We encountered an internal error")), "could not be read .*InternalError|could not be read .*ServerError"),
    (lambda: BrokenIndex(TimeoutError("read timed out")), "could not be read .*TimeoutError"),
    (lambda: FakeS3(objects={INDEX: (b"{not json", {})}), "not valid JSON"),
    (lambda: FakeS3(objects={INDEX: (b"[]", {})}), "not an object with a releases object"),
    (lambda: FakeS3(objects={INDEX: (b'{"releases": []}', {})}), "not an object with a releases object"),
], ids=["5xx", "timeout", "not JSON", "a list", "releases a list"])
def test_an_index_that_cannot_be_read_refuses_the_run_and_stays_as_it_was(setup, make, reason, dry_run):
    s3 = make()
    before = dict(s3.objects)
    with pytest.raises(Refused, match=reason):
        run(setup, with_args(setup, dry_run=dry_run), s3)
    assert untouched(setup, s3) and s3.objects == before


class NoSuchKey(Exception):
    """What botocore raises for a GET of a key that is not there (a HEAD gives "404")."""
    response = {"Error": {"Code": "NoSuchKey"}}


@pytest.mark.parametrize("make", [lambda: FakeS3(), lambda: BrokenIndex(NoSuchKey("The specified key does not exist."))],
                         ids=["404", "NoSuchKey"])
def test_no_index_yet_starts_one_with_this_release(setup, make):
    s3 = make()
    with pytest.raises((NoKey, NoSuchKey)):
        s3.get_object(Bucket="b", Key=INDEX)
    assert run(setup, with_args(setup, dry_run=False), s3) == 0
    assert list(json.loads(s3.objects[INDEX]["Body"])["releases"]) == [RID]


def test_an_index_with_other_releases_keeps_them(setup):
    old = {"schemaVersion": 1, "releases": {"f" * 16: {"publishedAt": "2026-01-01T00:00:00Z", "bytes": {}}}}
    s3 = FakeS3(objects={INDEX: (json.dumps(old).encode(), {})})
    assert run(setup, with_args(setup, dry_run=False), s3) == 0
    releases = json.loads(s3.objects[INDEX]["Body"])["releases"]
    assert set(releases) == {"f" * 16, RID} and releases["f" * 16] == old["releases"]["f" * 16]


def test_the_command_line_reaches_the_gate_by_those_names():
    parser = argparse.ArgumentParser()
    commands.add_arguments(parser)
    args = parser.parse_args(["publish-release", "--release", "r", "--min-version", "0.3.0", "--config", "c.json",
                              "--verdict-r", "a b/VERDICT-R.json", "--verdict-n", "VERDICT-N.json"])
    assert (args.verdict_r, args.verdict_n, args.no_refresh_gate) == ("a b/VERDICT-R.json", "VERDICT-N.json", None)
    args = parser.parse_args(["publish-release", "--release", "r", "--config", "c.json", "--no-refresh-gate", "new models"])
    assert (args.verdict_r, args.verdict_n, args.no_refresh_gate) == (None, None, "new models")
    assert parser.parse_args(["publish-release", "--no-refresh-gate", ""]).no_refresh_gate == ""


# ------------------------------------------------------- gate R alone: no new cards against the live release
LIVE_ID = "f" * 16


def catalog_bytes(ids, names=None) -> bytes:
    names = names or {}
    return json.dumps({"game": "toy", "cards": [{"id": i, "name": names.get(i, i.lower())} for i in ids]}).encode()


def candidate_catalog(s, ids, names=None) -> None:
    """Give the candidate release folder a real catalog (and re-pin it in release.json)."""
    data = catalog_bytes(ids, names)
    (s.folder / "catalog.json").write_bytes(data)
    doc = json.loads((s.folder / "release.json").read_text())
    doc["catalog"] = {"path": "catalog.json", "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    (s.folder / "release.json").write_text(json.dumps(doc))


def live_cdn(s, ids, *, names=None, catalog_status=200, catalog_body=None, catalog_pin=None):
    """A public CDN whose pointer names a release with the catalog `ids`; returns the `get` function."""
    cat = catalog_body if catalog_body is not None else catalog_bytes(ids, names)
    doc = json.dumps({"id": LIVE_ID, "detector": s.refs["detector"], "recognizer": s.refs["recognizer"],
                      "catalog": {"path": "catalog.json", "sha256": catalog_pin or hashlib.sha256(cat).hexdigest(),
                                  "bytes": len(cat)}}).encode()
    pointer = {"id": LIVE_ID, "path": f"vision/releases/{LIVE_ID}/release.json", "sha256": hashlib.sha256(doc).hexdigest(),
               "minimumExtensionVersion": "0.3.0"}
    store = {CONFIG_KEY: (200, {}, json.dumps({**EXAMPLE_SETTINGS, "release": pointer}).encode()),
             pointer["path"]: (200, {}, doc),
             f"vision/releases/{LIVE_ID}/catalog.json": (catalog_status, {}, cat)}
    from support_cdn import store_get
    return store_get(store)


def r_only(s, **k):
    return with_args(s, verdict_n=None, **k)


def test_r_alone_publishes_like_both_verdicts_when_the_candidate_adds_no_card(setup):
    ids = ["TOY-001", "TOY-002"]
    candidate_catalog(setup, ids, names={"TOY-001": "renamed"})  # a rename is not a new card
    get = live_cdn(setup, ids)
    lines: list[str] = []
    alone, both = FakeS3(), FakeS3()
    assert run(setup, r_only(setup, dry_run=False), alone, log=lines.append, get=get) == 0
    setup.cfg_file.write_text(json.dumps(EXAMPLE_SETTINGS))
    assert run(setup, with_args(setup, dry_run=False), both, get=get) == 0
    assert alone.put_keys == both.put_keys and alone.put_keys[-1] == CONFIG_KEY
    assert alone.objects[CONFIG_KEY]["Body"] == both.objects[CONFIG_KEY]["Body"]
    sha = hashlib.sha256(setup.r.read_bytes()).hexdigest()
    assert f"refresh gate: R PASS under rule {RULE}, {setup.r} sha256 {sha}" in lines
    assert f"refresh gate: N not needed: 0 new cards against the live release {LIVE_ID}" in lines
    assert not any("refresh gate: N PASS" in line for line in lines)


def test_r_alone_with_fewer_cards_than_live_is_still_no_new_card(setup):
    candidate_catalog(setup, ["TOY-001"])
    assert run(setup, r_only(setup, dry_run=True), FakeS3(), get=live_cdn(setup, ["TOY-001", "TOY-002"])) == 0


@pytest.mark.parametrize("dry_run", [True, False])
def test_r_alone_is_refused_when_the_candidate_adds_a_card(setup, dry_run):
    candidate_catalog(setup, ["TOY-001", "TOY-002", "TOY-003", "TOY-004"])
    s3 = FakeS3()
    with pytest.raises(Refused, match=r"adds 2 new card id\(s\).*e\.g\. TOY-003.*--verdict-n") as e:
        run(setup, r_only(setup, dry_run=dry_run), s3, get=live_cdn(setup, ["TOY-001", "TOY-002"]))
    assert "nothing written" in str(e.value) and untouched(setup, s3)


@pytest.mark.parametrize("dry_run", [True, False])
@pytest.mark.parametrize("name,gate,over,reason", [b for b in BAD if b[1] == "R" and b[0] != "rules differ"],
                         ids=[b[0] for b in BAD if b[1] == "R" and b[0] != "rules differ"])
def test_r_alone_still_needs_a_good_r(setup, name, gate, over, reason, dry_run):
    verdict(setup.tmp / "replay", "R", **over)
    s3 = FakeS3()
    asked = []
    with pytest.raises(Refused, match=reason):
        run(setup, r_only(setup, dry_run=dry_run), s3, get=lambda *a, **k: asked.append(a) or no_pointer(*a, **k))
    assert untouched(setup, s3) and not asked


UNREADABLE = [
    ("live catalog 503", dict(catalog_status=503), r"catalog cannot be read \(HTTP 503\)"),
    ("live catalog not JSON", dict(catalog_body=b"{nope"), "catalog cannot be read as cards"),
    ("live catalog without cards", dict(catalog_body=b"{}"), "catalog cannot be read as cards"),
    ("live catalog off its pin", dict(catalog_pin="0" * 64), "does not match its pin"),
]


@pytest.mark.parametrize("dry_run", [True, False])
@pytest.mark.parametrize("name,kw,reason", UNREADABLE, ids=[u[0] for u in UNREADABLE])
def test_r_alone_with_an_unreadable_live_catalog_is_refused_never_no_new_cards(setup, name, kw, reason, dry_run):
    candidate_catalog(setup, ["TOY-001"])
    s3 = FakeS3()
    with pytest.raises(Refused, match=reason):
        run(setup, r_only(setup, dry_run=dry_run), s3, get=live_cdn(setup, ["TOY-001"], **kw))
    assert untouched(setup, s3)


@pytest.mark.parametrize("dry_run", [True, False])
def test_r_alone_with_a_timeout_or_no_live_pointer_is_refused(setup, dry_run):
    candidate_catalog(setup, ["TOY-001"])
    real = live_cdn(setup, ["TOY-001"])

    def timeout(url, **k):
        if url.split("?")[0].endswith("/catalog.json"):
            raise TimeoutError("timed out")
        return real(url, **k)
    s3 = FakeS3()
    with pytest.raises(Refused, match="catalog cannot be read .TimeoutError"):
        run(setup, r_only(setup, dry_run=dry_run), s3, get=timeout)
    assert untouched(setup, s3)
    with pytest.raises(Refused, match="--verdict-n missing"):
        run(setup, r_only(setup, dry_run=dry_run), s3, get=no_pointer)
    assert untouched(setup, s3)


def test_verdict_n_alone_stays_refused_and_both_verdicts_never_read_the_live_catalog(setup):
    with pytest.raises(Refused, match="--verdict-r missing"):
        run(setup, with_args(setup, verdict_r=None), FakeS3(), get=live_cdn(setup, ["TOY-001"]))
    asked = []
    run(setup, with_args(setup, dry_run=True), FakeS3(),
        get=lambda url, **k: asked.append(url) or no_pointer(url, **k))
    assert not any("catalog" in u for u in asked)


R_ONLY_BAD = [
    ("R INVALID", {"verdict": "INVALID"}, "VERDICT-R.json: 'INVALID', not PASS"),
    ("R with no rehearsal field", {"rehearsal": None}, "VERDICT-R.json: no rehearsal field"),
]


@pytest.mark.parametrize("dry_run", [True, False])
@pytest.mark.parametrize("name,over,reason", R_ONLY_BAD, ids=[b[0] for b in R_ONLY_BAD])
def test_r_alone_refuses_an_invalid_r_and_one_with_no_rehearsal_field(setup, name, over, reason, dry_run):
    verdict(setup.tmp / "replay", "R", **over)
    s3 = FakeS3()
    asked = []
    with pytest.raises(Refused, match=reason):
        run(setup, r_only(setup, dry_run=dry_run), s3, get=lambda *a, **k: asked.append(a) or no_pointer(*a, **k))
    assert untouched(setup, s3) and not asked


@pytest.mark.parametrize("dry_run", [True, False])
def test_r_alone_refuses_a_verdict_file_that_is_missing_or_not_json(setup, dry_run):
    (setup.tmp / "junk.json").write_text("{not json")
    for path, reason in ((setup.tmp / "nowhere.json", "--verdict-r .*nowhere.json: cannot be read"),
                         (setup.tmp / "junk.json", "--verdict-r .*junk.json: not a verdict file")):
        s3 = FakeS3()
        asked = []
        with pytest.raises(Refused, match=reason):
            run(setup, r_only(setup, dry_run=dry_run, verdict_r=str(path)), s3,
                get=lambda *a, **k: asked.append(a) or no_pointer(*a, **k))
        assert untouched(setup, s3) and not asked


@pytest.mark.parametrize("dry_run", [True, False])
def test_r_alone_with_a_live_release_document_off_the_pointers_sha_is_refused(setup, dry_run):
    candidate_catalog(setup, ["TOY-001"])
    real = live_cdn(setup, ["TOY-001"])

    def other_document(url, **k):
        status, headers, body = real(url, **k)
        if url.split("?")[0].endswith(f"{LIVE_ID}/release.json"):
            body = body + b" "
        return status, headers, body
    s3 = FakeS3()
    with pytest.raises(Refused, match="release.json does not match the pointer's sha256.*nothing written"):
        run(setup, r_only(setup, dry_run=dry_run), s3, get=other_document)
    assert untouched(setup, s3)


# ------------------------------------------------------- the index records how a release cleared the gate
def entry_of(s3) -> dict:
    return json.loads(s3.objects[INDEX]["Body"])["releases"][RID]


def test_two_passing_verdicts_are_recorded_in_the_release_index(setup, monkeypatch):
    monkeypatch.setattr(cdn_config, "utc_now", lambda: "2026-11-01T00:00:00Z")
    s3 = FakeS3()
    assert run(setup, with_args(setup, dry_run=False), s3) == 0
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()  # noqa: E731
    assert entry_of(s3)["refreshGate"] == {"at": "2026-11-01T00:00:00Z", "rule": RULE, "r": sha(setup.r), "n": sha(setup.n)}
    assert json.loads(s3.objects[INDEX]["Body"])["schemaVersion"] == 1


def test_a_waiver_is_recorded_without_its_reason(setup, monkeypatch):
    monkeypatch.setattr(cdn_config, "utc_now", lambda: "2026-11-01T00:00:00Z")
    s3 = FakeS3()
    args = with_args(setup, dry_run=False, verdict_r=None, verdict_n=None, no_refresh_gate="new models, a private reason")
    assert run(setup, args, s3) == 0
    assert entry_of(s3)["refreshGate"] == {"at": "2026-11-01T00:00:00Z", "waived": True}
    assert "private reason" not in s3.objects[INDEX]["Body"].decode()


def test_r_alone_records_the_live_release_it_was_compared_with(setup):
    candidate_catalog(setup, ["TOY-001"])
    s3 = FakeS3()
    assert run(setup, r_only(setup, dry_run=False), s3, get=live_cdn(setup, ["TOY-001", "TOY-002"])) == 0
    rec = entry_of(s3)["refreshGate"]
    assert rec["n"] is None and rec["againstLive"] == LIVE_ID and rec["r"] == hashlib.sha256(setup.r.read_bytes()).hexdigest()


def folder_args(s, **k):
    """publish-release without --config: the folder is uploaded, the pointer does not move."""
    return with_args(s, **{"dry_run": False, "config": None, "set_pointer": False, "no_refresh_gate": None, **k})


def test_a_folder_uploaded_with_verdicts_and_no_config_records_them(setup):
    s3 = FakeS3()
    lines: list[str] = []
    assert run(setup, folder_args(setup), s3, log=lines.append) == 0
    assert CONFIG_KEY not in s3.objects
    assert entry_of(s3)["refreshGate"]["r"] == hashlib.sha256(setup.r.read_bytes()).hexdigest()
    assert any(line.startswith(f"refresh gate: R PASS under rule {RULE}") for line in lines)


def test_a_folder_uploaded_with_no_verdicts_is_recorded_as_such(setup):
    s3 = FakeS3()
    assert run(setup, folder_args(setup, verdict_r=None, verdict_n=None), s3) == 0
    assert entry_of(s3)["refreshGate"] is None


@pytest.mark.parametrize("dry_run", [True, False])
@pytest.mark.parametrize("gate,over,reason", [
    ("R", {"verdict": "FAIL"}, "VERDICT-R.json: 'FAIL', not PASS"),
    ("N", {"verdict": "FAIL"}, "VERDICT-N.json: 'FAIL', not PASS"),
    ("R", {"rehearsal": True}, "VERDICT-R.json: a rehearsal verdict"),
    ("N", {"rehearsal": True}, "VERDICT-N.json: a rehearsal verdict"),
], ids=["R FAIL", "N FAIL", "R rehearsal", "N rehearsal"])
def test_a_folder_upload_with_a_failing_or_rehearsal_verdict_is_refused_before_any_write(setup, gate, over, reason, dry_run):
    verdict(setup.tmp / ("replay" if gate == "R" else "newcard"), gate, **over)
    s3 = FakeS3()
    with pytest.raises(Refused, match=reason):
        run(setup, folder_args(setup, dry_run=dry_run), s3)
    assert not s3.puts and not s3.objects
