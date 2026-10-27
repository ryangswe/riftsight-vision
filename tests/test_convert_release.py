# SPDX-License-Identifier: Apache-2.0
"""``cardvision convert-release``: a release with the bank as ``bank.bin`` and a compact catalog
is a release this package accepts, and it scores exactly as the original."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cardvision import cli
from cardvision.bank import release as R
from cardvision.bank.convert import compact_json, convert_release
from cardvision.bank.documents import canonical_bytes, read_json, sha256_hex
from cardvision.core.bank_binary import decode, is_binary_bank
from test_infer_cli import release, run, setup  # noqa: F401  (the toy release and its fixtures)


@pytest.fixture(scope="module")
def converted(release, tmp_path_factory) -> Path:  # noqa: F811
    out = tmp_path_factory.mktemp("converted") / "release"
    convert_release(release / "release.json", out)
    return out


def test_the_converted_release_is_one_this_package_accepts(release, converted):  # noqa: F811
    old, new = read_json(release / "release.json"), R.verify_release(converted / "release.json")
    assert new["id"] != old["id"] and new["id"] == R.release_id(new)
    assert sorted(path.name for path in converted.iterdir()) == [
        "bank.bin", "bank.identity-groups.json", "catalog.json", "detector.onnx", "recognizer.onnx", "release.json"]
    assert new["bank"]["path"] == "bank.bin" and is_binary_bank((converted / "bank.bin").read_bytes())
    # Only the pinned files' seals and the id differ.
    for doc in (old, new):
        for block in (doc["bank"], doc["identity"]["groups"], doc["catalog"]):
            for key in ("path", "sha256", "bytes"):
                block.pop(key)
        doc.pop("id")
    assert json.dumps(new) == json.dumps(old)


def test_every_value_is_unchanged(release, converted):  # noqa: F811
    for name in ("detector.onnx", "recognizer.onnx"):
        assert (converted / name).read_bytes() == (release / name).read_bytes()
    assert canonical_bytes(decode((converted / "bank.bin").read_bytes())) == (release / "bank.json").read_bytes()
    catalog = (converted / "catalog.json").read_bytes()
    assert catalog == compact_json(read_json(release / "catalog.json")) and catalog.endswith(b"}\n")
    assert b"\n " not in catalog and json.loads(catalog) == read_json(release / "catalog.json")
    groups, old_groups = read_json(converted / "bank.identity-groups.json"), read_json(release / "bank.identity-groups.json")
    assert groups["bank"]["sha256"] == sha256_hex((converted / "bank.bin").read_bytes())
    old_groups["bank"]["sha256"] = groups["bank"]["sha256"]
    assert canonical_bytes(groups) == canonical_bytes(old_groups) == (converted / "bank.identity-groups.json").read_bytes()


def test_infer_gives_the_same_boxes_names_and_scores(setup, release, converted, capsys):  # noqa: F811
    code, original, _ = run(capsys, str(setup.image), "--release", str(release / "release.json"))
    assert code == 0
    code, after, err = run(capsys, str(setup.image), "--release", str(converted / "release.json"))
    assert code == 0, err
    assert after == original and any(box.get("name") for frame in after for box in frame["boxes"])


def test_converting_again_changes_nothing(converted, tmp_path):
    again = convert_release(converted / "release.json", tmp_path / "again")
    assert again.new == again.old
    for path in converted.iterdir():
        assert (tmp_path / "again" / path.name).read_bytes() == path.read_bytes()


def test_the_command_prints_both_ids_and_refuses_a_folder_that_is_not_empty(release, tmp_path, capsys):  # noqa: F811
    out = tmp_path / "out"
    out.mkdir()                     # an empty folder is fine
    assert cli.main(["convert-release", str(release / "release.json"), "--out", str(out)]) == 0
    printed = capsys.readouterr().out
    old_id, new_id = read_json(release / "release.json")["id"], read_json(out / "release.json")["id"]
    assert f"release {old_id} -> release {new_id}" in printed and "geometric index" in printed
    before = sorted(path.name for path in out.iterdir())
    assert cli.main(["convert-release", str(release / "release.json"), "--out", str(out)]) == 1
    assert "is not empty" in capsys.readouterr().err
    assert sorted(path.name for path in out.iterdir()) == before
    assert cli.main(["verify-release", str(out / "release.json")]) == 0
    assert f"release {new_id}: ok" in capsys.readouterr().out


def test_a_release_that_fails_its_checks_is_not_converted(release, tmp_path, capsys):  # noqa: F811
    import shutil

    broken = Path(shutil.copytree(release, tmp_path / "broken"))
    (broken / "catalog.json").write_bytes((broken / "catalog.json").read_bytes() + b"\n")
    assert cli.main(["convert-release", str(broken / "release.json"), "--out", str(tmp_path / "out")]) == 1
    assert "catalog" in capsys.readouterr().err and not (tmp_path / "out").exists()


def test_a_failure_after_writing_leaves_the_out_folder_as_it_was(release, tmp_path, monkeypatch):  # noqa: F811
    from cardvision.bank import convert

    monkeypatch.setattr(convert, "release_errors", lambda doc, root: ["forced"])
    fresh, empty = tmp_path / "fresh", tmp_path / "empty"
    empty.mkdir()
    for out in (fresh, empty):
        with pytest.raises(R.ReleaseError):
            convert_release(release / "release.json", out)
    assert not fresh.exists() and empty.is_dir() and not any(empty.iterdir())


def test_a_release_with_a_binary_bank_whose_bytes_changed_is_refused(converted, tmp_path):
    import shutil

    broken = Path(shutil.copytree(converted, tmp_path / "broken"))
    body = (broken / "bank.bin").read_bytes()
    (broken / "bank.bin").write_bytes(body + b"\x00\x00")
    doc = read_json(broken / "release.json")
    doc["bank"].update({"sha256": sha256_hex(body + b"\x00\x00"), "bytes": len(body) + 2})
    errors = R.release_errors(R.with_id(doc), broken)
    assert any(error.startswith("bank: the binary bank holds") for error in errors)
