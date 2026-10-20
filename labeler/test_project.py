# SPDX-License-Identifier: Apache-2.0
"""Tests for the start screen and the project screen: what project.py works out from a
project's files (where each file is, what the labels are for, how far each pass has come, which
passes can be started, the commands), what the tool remembers and where, the routes serve.py
adds for the two screens, the first start of a pass from the page, the requests the server
turns away, and the command line with no arguments and with one project.

Toy data only, in temporary folders. The per-user list of projects is kept in a temporary
folder too (LABELER_STATE_DIR): no test reads or writes the real one.

Run: python3 -m unittest discover -s labeler
"""
from __future__ import annotations

import contextlib
import http.client
import io
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ["LABELER_QUIET"] = "1"
# never the real per-user folder: a test that forgets to name its own writes here, and nowhere else
os.environ["LABELER_STATE_DIR"] = str(Path(tempfile.gettempdir()) / "labeler-test-state")

import export  # noqa: E402
import labelcore as lc  # noqa: E402
import labelfiles as lf  # noqa: E402
import make_repeat_set  # noqa: E402
import make_toy_data  # noqa: E402
import project as pj  # noqa: E402
import serve  # noqa: E402

BOX = [[10, 10], [73, 10], [73, 98], [10, 98]]


def write_set(labels: Path, set_id: str, rows: list, mode: str = "box", role: str = "training", **meta) -> None:
    """A label set as the tool stores it: meta.json and one line per frame."""
    folder = labels / set_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "meta.json").write_text(json.dumps({"schemaVersion": lc.SCHEMA_VERSION, "tool": "labeler", "setId": set_id,
                                                  "frameAsset": set_id, "mode": mode, "role": role, **meta}))
    (folder / "frames.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))


def frame(n: int, done: bool = True, targets=None, **more) -> dict:
    return {"name": f"f{n:05d}.png", "t": float(n - 1), "frameW": 960, "frameH": 540, "done": done, "targets": targets or [], **more}


def box(n: int, **answer) -> dict:
    return {"id": f"B{n:03d}", "corners": BOX, "cornerSource": "box", "outcome": "card", **answer}


NAMED = dict(identity="TOY-001", eligible="yes")


class Toy(unittest.TestCase):
    """A fresh toy project for every test, a folder to start the tool in, and a per-user folder
    of its own."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="labeler-project-test-")).resolve()
        self.start = self.tmp / "start"
        self.toy = self.start / "toy"
        make_toy_data.build(self.toy, seed=1, frames=5)
        self.sample = self.toy / "sample.json"
        self.labels = self.toy / "labels"
        self.state = self.tmp / "state"
        env = mock.patch.dict(os.environ, {"LABELER_STATE_DIR": str(self.state)})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def report(self, **kw):
        kw.setdefault("base", self.start)
        return pj.report(self.sample, **kw)


# ---- a path a person names, and the search ------------------------------------------------------

class FindingProjects(Toy):
    def test_a_folder_or_a_sample_file_names_a_project(self):
        for text in (str(self.toy), str(self.sample), "toy", "toy/sample.json", "  toy  ", '"toy"', "'toy/sample.json'", "./toy/"):
            with self.subTest(text):
                self.assertEqual(pj.find_project(text, self.start), {"ok": True, "sample": self.sample})
        with mock.patch.dict(os.environ, {"HOME": str(self.start)}):
            self.assertEqual(pj.find_project(os.path.join("~", "toy"), self.tmp), {"ok": True, "sample": self.sample})

    def test_what_is_no_sample_says_which_way_and_where_it_looked(self):
        (self.start / "empty").mkdir()
        (self.start / "notes.json").write_text("{not json")
        (self.start / "list.json").write_text("[1, 2]")
        (self.start / "other.json").write_text('{"cards": []}')
        (self.start / "odd.json").write_bytes(b"\xff\xfe\x00")
        for text, problem, path in (
                ("", "empty", None), ("   ", "empty", None), ("nowhere", "missing", self.start / "nowhere"),
                ("empty", "no-sample-in-folder", self.start / "empty"), ("notes.json", "not-json", self.start / "notes.json"),
                ("list.json", "not-sample", self.start / "list.json"), ("other.json", "not-sample", self.start / "other.json"),
                ("odd.json", "unreadable", self.start / "odd.json")):
            with self.subTest(text):
                self.assertEqual(pj.find_project(text, self.start), {"ok": False, "problem": problem, "path": str(path) if path else None})
        self.assertEqual(pj.find_project("a\x00b", self.start)["problem"], "bad-path")
        # a folder stands for its sample.json and nothing else in it is looked at
        (self.start / "empty" / "my-sample.json").write_text(self.sample.read_text())
        self.assertEqual(pj.find_project("empty", self.start)["problem"], "no-sample-in-folder")
        self.assertTrue(pj.find_project("empty/my-sample.json", self.start)["ok"])

    def test_the_search_stays_under_the_start_folder_and_is_bounded(self):
        deep = self.start / "a" / "b" / "c"
        deeper = deep / "d"
        deeper.mkdir(parents=True)
        (self.tmp / "outside-sample.json").write_text(self.sample.read_text())  # above the start folder
        (deep / "sample.json").write_text(self.sample.read_text())
        (deeper / "sample.json").write_text(self.sample.read_text())  # one level too deep
        (self.start / ".hidden").mkdir()
        (self.start / ".hidden" / "sample.json").write_text(self.sample.read_text())
        (self.start / "node_modules").mkdir()
        (self.start / "node_modules" / "sample.json").write_text(self.sample.read_text())
        (self.start / "my-sample-2.json").write_text(self.sample.read_text())
        (self.start / "sample-notes.json").write_text('{"about": "not a sample"}')
        (self.start / "frames.json").write_text(self.sample.read_text())  # no "sample" in its name
        got = pj.find_samples(self.start)
        self.assertEqual(got, {"found": [self.start / "my-sample-2.json", self.sample, deep / "sample.json"], "cut": False, "depth": 3})
        # the bounds: a number of samples, of folders, of files looked at; each says it stopped early
        with mock.patch.object(pj, "SEARCH_FOUND", 2):
            cut = pj.find_samples(self.start)
            self.assertEqual((len(cut["found"]), cut["cut"]), (2, True))
        with mock.patch.object(pj, "SEARCH_DIRS", 1):
            self.assertEqual(pj.find_samples(self.start), {"found": [self.start / "my-sample-2.json"], "cut": True, "depth": 3})
        with mock.patch.object(pj, "SEARCH_ENTRIES", 2):
            self.assertTrue(pj.find_samples(self.start)["cut"])
        self.assertEqual(pj.find_samples(self.tmp / "no-such-folder"), {"found": [], "cut": False, "depth": 3})

    def test_one_line_about_a_sample(self):
        self.assertEqual(pj.summary(self.sample), {"sample": str(self.sample), "folder": str(self.toy), "name": "toy", "recordings": 2, "frames": 10})
        other = self.toy / "second.json"
        other.write_text(json.dumps({"assets": [{"assetId": "table-a", "frames": [{"t": 0, "name": "f00001.png"}, {"t": 1, "name": "../x.png"}]},
                                                {"assetId": "bad id", "frames": []}, "junk"]}))
        self.assertEqual(pj.summary(other), {"sample": str(other), "folder": str(self.toy), "name": "toy/second.json", "recordings": 1, "frames": 1})
        self.assertEqual(pj.summary(self.toy / "gone.json")["problem"], "missing")


# ---- where a project's files are ----------------------------------------------------------------

class Locations(Toy):
    def test_everything_is_found_beside_the_sample_without_asking(self):
        places = self.report()["locations"]
        self.assertEqual({k: (v["path"], v["source"], v["state"], v["usual"]) for k, v in places.items()}, {
            "labels": (str(self.toy / "labels"), "beside", "will-create", True),
            "frames": (str(self.toy / "frames"), "beside", "ok", True),
            "catalog": (str(self.toy / "catalog.json"), "beside", "ok", True),
            "art": (str(self.toy / "art"), "beside", "ok", True),
            "decklists": (str(self.toy / "decklists"), "beside", "ok", True),
            "prefill": (str(self.toy / "prefill.jsonl"), "beside", "ok", True)})
        self.assertEqual((places["catalog"]["cards"], places["decklists"]["files"], places["frames"]["ownFolders"]), (13, 2, 2))
        # the toy's answers lie beside it and are read as nothing: not a sample, not labels, not suggestions
        self.assertTrue((self.toy / "truth.json").is_file())
        self.assertEqual(pj.find_samples(self.start)["found"], [self.sample])
        self.assertFalse(self.labels.exists())
        export = self.report()["export"]
        self.assertEqual((export["coco"]["included"], export["manifest"]["included"]), (0, 0), "nothing to export before a label is made")
        # the server defaults the same three folders when it is started with flags
        serve.configure(serve.build_parser().parse_args(["--mode", "box", "--role", "training", "--sample", str(self.sample)]))
        self.addCleanup(serve.CFG.__dict__.clear)
        self.assertEqual((str(serve.CFG.labels_dir), str(serve.CFG.frames_dir), str(serve.CFG.decklists_dir)),
                         (places["labels"]["path"], places["frames"]["path"], places["decklists"]["path"]))

    def test_what_is_not_there_is_named_with_its_place(self):
        bare = self.start / "bare"
        bare.mkdir()
        (bare / "sample.json").write_text(json.dumps({"assets": [{"assetId": "clip", "frames": [{"t": 0, "name": "f00001.png"}]}]}))
        rep = pj.report(bare / "sample.json", base=self.start)
        self.assertEqual({k: v["state"] for k, v in rep["locations"].items()},
                         {"labels": "will-create", "frames": "absent", "catalog": "absent", "art": "absent", "decklists": "absent", "prefill": "absent"})
        self.assertEqual(rep["locations"]["catalog"]["path"], str(bare / "catalog.json"), "where it was looked for")
        self.assertEqual(rep["frames"], {"listed": 1, "onDisk": 0, "missing": 1, "firstMissing": str(bare / "frames" / "clip" / "f00001.png"), "thumb": None})
        # a place that was named and holds nothing is `missing`, whoever named it
        rep = pj.report(bare / "sample.json", base=self.start, given={"catalog": "nowhere/cards.json"}, flags={"art": self.start / "no-art"})
        self.assertEqual((rep["locations"]["catalog"]["state"], rep["locations"]["catalog"]["path"], rep["locations"]["catalog"]["source"]),
                         ("missing", str(self.start / "nowhere" / "cards.json"), "page"))
        self.assertEqual((rep["locations"]["art"]["state"], rep["locations"]["art"]["source"]), ("missing", "flag"))

    def test_the_page_wins_over_the_command_line_which_wins_over_what_is_remembered(self):
        for name in ("a", "b", "c"):
            (self.start / name).mkdir()
            (self.start / name / "cards.json").write_text(json.dumps({"cards": [{"id": f"X-{name}", "name": name}]}))
        self.labels.mkdir()
        (self.labels / pj.PROJECT_FILE).write_text(json.dumps({"tool": "labeler", "sample": "../sample.json", "role": "development",
                                                               "locations": {"catalog": str(self.start / "c" / "cards.json")}}))
        where = lambda **kw: (lambda place: (Path(place["path"]).parent.name, place["source"], place["usual"]))(self.report(**kw)["locations"]["catalog"])  # noqa: E731
        self.assertEqual(where(), ("c", "remembered", False))
        self.assertEqual(where(flags={"catalog": self.start / "b" / "cards.json"}), ("b", "flag", False))
        self.assertEqual(where(flags={"catalog": self.start / "b" / "cards.json"}, given={"catalog": "a/cards.json"}), ("a", "page", False))
        self.assertEqual(where(given={"catalog": str(self.toy / "catalog.json")}), ("toy", "page", True), "the conventional place, named by hand")
        # card images may come from an address the browser loads them from
        art = self.report(given={"art": "https://cards.example/art/"})["locations"]["art"]
        self.assertEqual((art["path"], art["state"], art.get("url")), ("https://cards.example/art/", "ok", True))

    def test_a_catalog_the_server_would_refuse_is_refused_here_with_the_same_reason(self):
        bad = self.toy / "catalog.json"
        doc = json.loads(bad.read_text())
        doc["cards"][3]["id"] = "TOY 004"
        bad.write_text(json.dumps(doc))
        place = self.report()["locations"]["catalog"]
        self.assertEqual((place["state"], place["problem"]), ("unreadable", serve.catalog_id_problem(doc)))
        with self.assertRaises(SystemExit):
            serve.configure(serve.build_parser().parse_args(["--mode", "box", "--role", "training", "--sample", str(self.sample), "--catalog", str(bad)]))
        serve.CFG.__dict__.clear()
        for text, words in (("{not json", "it is not JSON"), ("[1]", "it is not a JSON object with a `cards` list"),
                            ('{"identity": "printings", "cards": []}', '"identity" must be "name" or "printing", not "printings"'),
                            ('{"facets": {}, "cards": []}', '"facets" must be a list of objects, each with a "key" and a "label"'),
                            ('{"cards": [{"id": "A", "name": "a", "extra": "x"}]}', 'card A: "extra" must be an object (any keys and values), not "x"')):
            bad.write_text(text)
            self.assertEqual(self.report()["locations"]["catalog"]["problem"], words)
        rep = self.report(role="training")
        self.assertEqual((rep["passes"]["identify"]["reason"], rep["passes"]["box"]["allowed"]), ("bad-catalog", True), "boxes need no catalog")

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "the superuser may write anywhere")
    def test_a_labels_folder_that_cannot_be_written_stops_every_pass(self):
        locked = self.start / "locked"
        locked.mkdir()
        os.chmod(locked, 0o555)
        self.addCleanup(os.chmod, locked, 0o755)
        rep = self.report(role="training", given={"labels": "locked/labels"})
        self.assertEqual(rep["locations"]["labels"]["state"], "not-writable")
        self.assertEqual({p["reason"] for p in rep["passes"].values() if p["id"] not in ("center", "verify")}, {"labels-not-writable"})
        self.assertEqual(self.report(role="training", given={"labels": "locked"})["locations"]["labels"]["state"], "not-writable")
        self.assertEqual(self.report(given={"labels": str(self.sample)})["locations"]["labels"]["state"], "not-folder")
        self.assertEqual(self.report(given={"labels": "new/deep/labels"})["locations"]["labels"]["state"], "will-create")

    def test_frames_that_are_not_on_disk(self):
        (self.toy / "frames" / "table-b" / "f00002.png").unlink()
        rep = self.report(role="training")
        self.assertEqual((rep["frames"]["listed"], rep["frames"]["onDisk"], rep["frames"]["missing"], rep["frames"]["firstMissing"]),
                         (10, 9, 1, str(self.toy / "frames" / "table-b" / "f00002.png")))
        self.assertEqual(rep["frames"]["thumb"], {"asset": "table-a", "name": "f00001.png", "path": str(self.toy / "frames" / "table-a" / "f00001.png")})
        self.assertTrue(rep["passes"]["box"]["allowed"], "the frames that are there can be labeled")
        shutil.rmtree(self.toy / "frames")
        rep = self.report(role="training")
        self.assertEqual((rep["frames"]["onDisk"], rep["frames"]["thumb"], rep["locations"]["frames"]["state"]), (0, None, "unused"))
        self.assertEqual((rep["passes"]["box"]["reason"], rep["passes"]["corner"]["reason"]), ("frames-missing", "frames-missing"))
        empty = self.toy / "empty.json"
        empty.write_text('{"assets": []}')
        rep = pj.report(empty, base=self.start, role="training")
        self.assertEqual((rep["recordings"], rep["passes"]["box"]["reason"], rep["next"]), (0, "no-frames", {"pass": None, "startable": False}))


# ---- what the labels are for, and how far each pass has come ------------------------------------

class Status(Toy):
    def test_nothing_labeled_yet(self):
        rep = self.report()
        self.assertEqual(rep["role"], {"value": None, "stored": {}, "fixed": False, "choices": ["training", "development", "test"], "refused": None, "source": None})
        self.assertEqual({p["reason"] for p in rep["passes"].values()}, {"no-role"}, "the purpose comes first")
        self.assertEqual(rep["next"], {"pass": None, "startable": False})
        rep = self.report(role="training")
        box_pass = rep["passes"]["box"]
        self.assertEqual((box_pass["allowed"], box_pass["action"], box_pass["done"], box_pass["frames"], box_pass["sets"]), (True, "start", 0, 10, ["table-a", "table-b"]))
        self.assertEqual((rep["passes"]["identify"]["reason"], rep["passes"]["verify"]["reason"]), ("nothing-to-name", "not-for-training"))
        self.assertEqual(rep["next"], {"pass": "box", "startable": True})
        self.assertEqual((rep["export"]["coco"]["included"], rep["export"]["coco"]["leftOut"]), (0, 10))
        self.assertEqual(rep["modelBoxes"], {"offered": True, "on": True, "file": "prefill.jsonl"})

    def test_counts_come_from_the_label_files(self):
        write_set(self.labels, "table-a", [frame(1, True, [box(1), box(2, **NAMED), {"id": "B003", "corners": BOX, "outcome": "card-back"}]),
                                           frame(2, True, [box(1), box(2, identity="TOY-002"), box(3, ignore=True)]),
                                           frame(3, False, [box(1)]),
                                           frame(9, True, [box(1)])])  # a frame another sample lists: not this project's
        rep = self.report()
        self.assertEqual(rep["role"]["value"], "training", "read from the labels")
        got = rep["sets"][0]
        self.assertEqual((got["mode"], got["role"], got["done"], got["boxes"], got["cards"], got["toName"]), ("box", "training", 2, 7, 5, 4))
        self.assertEqual(got["toName"], len(lc.identify_queue([frame(1, True, [box(1), box(2, **NAMED)]), frame(2, True, [box(1), box(2, identity="TOY-002")]), frame(3, False, [box(1)])])))
        passes = rep["passes"]
        self.assertEqual((passes["box"]["done"], passes["box"]["frames"], passes["box"]["action"]), (2, 10, "continue"))
        self.assertEqual((passes["identify"]["left"], passes["identify"]["cards"], passes["identify"]["action"], passes["identify"]["sets"]), (4, 5, "continue", ["table-a"]))
        self.assertEqual(rep["next"], {"pass": "box", "startable": True}, "Boxes first: frames are left")
        self.assertEqual((rep["export"]["coco"]["included"], rep["export"]["coco"]["recordings"], rep["export"]["coco"]["leftOut"]), (3, 1, 8),
                         "the export writes every done frame in the folder; 8 of this sample's frames are not done")

    def test_boxes_done_then_names_then_export(self):
        rows = lambda named: [frame(n, True, [box(1, **(NAMED if named else {})), box(2, **NAMED)]) for n in range(1, 6)]  # noqa: E731
        for video in ("table-a", "table-b"):
            write_set(self.labels, video, rows(False))
        rep = self.report()
        self.assertEqual((rep["passes"]["box"]["action"], rep["passes"]["box"]["done"]), ("review", 10))
        self.assertEqual((rep["passes"]["identify"]["action"], rep["passes"]["identify"]["left"]), ("continue", 10))
        self.assertEqual(rep["next"], {"pass": "identify", "startable": True})
        write_set(self.labels, "table-a", [frame(n, True, [box(1), box(2)]) for n in range(1, 6)])
        write_set(self.labels, "table-b", [frame(n, True, [box(1)]) for n in range(1, 6)])
        self.assertEqual((self.report()["passes"]["identify"]["action"], self.report()["passes"]["identify"]["left"]), ("start", 15), "none named yet")
        for video in ("table-a", "table-b"):
            write_set(self.labels, video, rows(True))
        rep = self.report()
        self.assertEqual((rep["passes"]["identify"]["action"], rep["passes"]["identify"]["left"]), ("review", 0))
        self.assertEqual(rep["next"], {"pass": "export", "startable": False})
        self.assertEqual((rep["export"]["coco"]["included"], rep["export"]["coco"]["recordings"], rep["export"]["coco"]["leftOut"]), (10, 2, 0))
        # without a catalog nothing can be named, whatever waits
        (self.toy / "catalog.json").unlink()
        for video in ("table-a", "table-b"):
            write_set(self.labels, video, rows(False))
        rep = self.report()
        self.assertEqual((rep["passes"]["identify"]["allowed"], rep["passes"]["identify"]["reason"], rep["passes"]["identify"]["left"]), (False, "no-catalog", 10))
        self.assertEqual(rep["next"], {"pass": "export", "startable": False})

    def test_a_recording_keeps_one_way_of_labeling(self):
        write_set(self.labels, "table-a", [frame(1, True, [box(1)])], mode="corner")
        rep = self.report()
        passes = rep["passes"]
        self.assertEqual((passes["box"]["sets"], passes["box"]["frames"], passes["corner"]["sets"], passes["corner"]["done"], passes["corner"]["frames"]),
                         (["table-b"], 5, ["table-a", "table-b"], 1, 10))
        self.assertEqual(passes["identify"]["sets"], ["table-a"], "corner sets are named in the Names pass too")
        self.assertEqual(rep["next"], {"pass": "corner", "startable": True})
        write_set(self.labels, "table-b", [], mode="corner")
        rep = self.report()
        self.assertEqual((rep["passes"]["box"]["allowed"], rep["passes"]["box"]["reason"], rep["passes"]["box"]["have"]), (False, "other-way", ["corner"]))
        self.assertTrue(rep["passes"]["corner"]["allowed"])

    def test_centers_then_check_names(self):
        centers = [{"id": "C001", "kind": "face", "x": 5, "y": 5}, {"id": "C002", "kind": "back", "x": 9, "y": 9},
                   {"id": "C003", "kind": "face", "x": 7, "y": 7, "verifiedBy": "not-card"}]
        for video in ("table-a", "table-b"):
            write_set(self.labels, video, [frame(n, True, centers=centers) for n in range(1, 6)], mode="center", role="development")
        rep = self.report()
        self.assertEqual(rep["role"]["value"], "development")
        verify = rep["passes"]["verify"]
        self.assertEqual((rep["passes"]["center"]["action"], verify["allowed"], verify["faces"], verify["button"]), ("review", True, 20, True))
        self.assertEqual(verify["named"], sum(1 for c in centers if c["kind"] == "face" and lc.answer_complete(c)) * 10)
        self.assertEqual(rep["next"], {"pass": "verify", "startable": True}, "Check names starts from the page, with no model's proposal")
        self.assertEqual((rep["flow"], rep["export"]["kind"]), ("center", "manifest"))
        self.assertEqual(rep["passes"]["box"]["reason"], "other-way")
        self.assertEqual(rep["export"]["coco"]["included"], 0, "a center set holds no boxes")
        self.assertEqual((rep["export"]["manifest"]["included"], rep["export"]["manifest"]["untagged"], rep["export"]["manifest"]["unaddressed"],
                          rep["export"]["manifest"]["unanswered"]), (10, ["table-a", "table-b"], ["table-a", "table-b"], 10),
                         "the manifest writes the census; it needs a kind of footage and where each video is")
        # every face named: the export is next
        named = [dict(c, verifiedBy="unknown", identity="unknown", eligible="no", blind=True) if c["kind"] == "face" else c for c in centers]
        for video in ("table-a", "table-b"):
            write_set(self.labels, video, [frame(n, True, centers=named) for n in range(1, 6)], mode="center", role="development")
        rep = self.report()
        self.assertEqual((rep["next"], rep["export"]["manifest"]["unanswered"]), ({"pass": "export", "startable": False}, 0))

    def test_labels_for_measuring_start_with_the_census(self):
        """Development and Test: Centers, then Check names, then the manifest. Training: Boxes,
        Names, then the boxes. A project labeled another way goes on that way."""
        for role, flow, kind in (("development", "center", "manifest"), ("test", "center", "manifest"), ("training", "box", "coco"), (None, "box", "coco")):
            rep = self.report(role=role)
            self.assertEqual((rep["flow"], rep["export"]["kind"], rep["next"]["pass"] if role else None), (flow, kind, flow if role else None), role)
        self.assertEqual(self.report(role="test")["next"], {"pass": "center", "startable": True})
        write_set(self.labels, "table-a", [frame(1, True, [box(1)])], role="development")
        rep = self.report()
        self.assertEqual((rep["flow"], rep["next"], rep["export"]["kind"]), ("box", {"pass": "box", "startable": True}, "manifest"))
        self.assertEqual(rep["export"]["manifest"]["included"], 1)

    def test_the_purpose_is_read_from_the_labels_and_cannot_be_changed(self):
        self.assertEqual(self.report(flags={"role": "test"})["role"]["value"], "test")
        self.assertEqual(self.report(flags={"role": "test"}, role="development")["role"]["value"], "development", "the page's choice wins")
        write_set(self.labels, "table-a", [frame(1)], role="training")
        role = self.report(flags={"role": "test"})["role"]
        self.assertEqual(role, {"value": "training", "stored": {"training": ["table-a"]}, "fixed": True, "choices": ["training"], "refused": "test", "source": "labels"})
        self.assertEqual(self.report(role="development")["role"]["refused"], "development")
        self.assertIsNone(self.report(role="training")["role"]["refused"])
        # two purposes in one labels folder: the choice is among those two, and the passes follow it
        write_set(self.labels, "table-b", [frame(1), frame(2)], role="development")
        role = self.report()["role"]
        self.assertEqual((role["value"], role["fixed"], role["choices"], role["stored"]), (None, False, ["training", "development"], {"training": ["table-a"], "development": ["table-b"]}))
        rep = self.report(role="development")
        self.assertEqual((rep["role"]["value"], rep["passes"]["box"]["sets"], rep["passes"]["box"]["done"]), ("development", ["table-b"], 2))
        self.assertEqual(self.report(role="test")["role"]["value"], None, "a purpose no set has is not one of the choices")

    def test_label_files_this_tool_did_not_write_are_left_out(self):
        (self.labels / "table-a").mkdir(parents=True)
        (self.labels / "table-a" / "meta.json").write_text('{"tool": "another", "version": 3}')
        (self.labels / "table-b").mkdir()
        (self.labels / "table-b" / "frames.jsonl").write_text('{"name": "f00001.png"}\nnot json\n')
        rep = self.report(role="training")
        self.assertEqual([(s["setId"], s["foreign"]) for s in rep["sets"]], [("table-a", True), ("table-b", True)])
        self.assertEqual((rep["passes"]["box"]["sets"], rep["passes"]["box"]["reason"], rep["role"]["stored"]), ([], "other-way", {}))

    def test_a_pass_is_offered_only_where_the_server_would_start_it(self):
        """Every pass and purpose: `allowed` is never true where serve.py's own rule refuses."""
        fresh = {m: {} for m in lc.MODES}
        for role in lc.ROLES:
            for mode in lc.MODES:
                with self.subTest(mode=mode, role=role):
                    shutil.rmtree(self.labels, ignore_errors=True)
                    if mode == "identify":
                        write_set(self.labels, "table-a", [frame(1, True, [box(1)])], role=role)
                    if mode == "verify":
                        write_set(self.labels, "table-a", [frame(1, True, centers=[{"id": "C001", "kind": "face", "x": 1, "y": 1}])], mode="center", role=role)
                    got = self.report(role=role)["passes"][mode]
                    try:
                        lc.check_mode_role(mode, role, False, mode == "verify" and role == "test")
                        refused = False
                    except ValueError:
                        refused = True
                    self.assertEqual(got["allowed"], not refused, got["reason"])
                    fresh[mode][role] = got["reason"]
        self.assertEqual(fresh["training"], {"development": "training-only", "test": "training-only", "training": None})
        self.assertEqual(fresh["center"], {"development": None, "test": None, "training": "not-for-training"})
        self.assertEqual(fresh["verify"], {"development": None, "test": None, "training": "not-for-training"})
        # a model's boxes are offered where the server takes --prefill with --mode box, and only there
        shutil.rmtree(self.labels, ignore_errors=True)
        for role in lc.ROLES:
            with self.subTest(prefill=role):
                rep = self.report(role=role)
                try:
                    lc.check_mode_role("box", role, True)
                    takes = True
                except ValueError:
                    takes = False
                self.assertEqual(rep["modelBoxes"]["offered"], takes)
                self.assertEqual(pj.open_values(rep, "box")["prefill"], [str(self.toy / "prefill.jsonl")] if takes else None)
        (self.toy / "prefill.jsonl").unlink()
        rep = self.report(role="training")
        self.assertEqual((rep["modelBoxes"]["offered"], rep["passes"]["training"]["reason"]), (False, "no-suggestions"))
        self.assertIsNone(pj.open_values(rep, "box")["prefill"])


# ---- starting a pass, and the commands ----------------------------------------------------------

class Commands(Toy):
    COMMAND = {"prefix": ["python3", "labeler/serve.py"], "tail": [], "cwd": None}

    def parse(self, command):
        """A pass's command as serve.py reads it."""
        return serve.build_parser().parse_args(command["argv"][2:])

    def test_the_command_of_a_pass_says_what_the_page_would_start(self):
        command = {**self.COMMAND, "cwd": str(self.start)}
        rep = self.report(role="training", command=command)
        self.assertEqual(rep["restart"], "python3 labeler/serve.py")
        self.assertEqual(rep["passes"]["box"]["command"]["text"],
                         "python3 labeler/serve.py --mode box --role training --sample toy/sample.json --catalog toy/catalog.json --art toy/art --prefill toy/prefill.jsonl")
        self.assertEqual(rep["passes"]["identify"]["command"]["text"],
                         "python3 labeler/serve.py --mode identify --role training --sample toy/sample.json --catalog toy/catalog.json --art toy/art")
        self.assertEqual(rep["export"]["coco"]["text"], "python3 labeler/export.py coco --labels-dir toy/labels --out toy/boxes.json --catalog toy/catalog.json")
        self.assertEqual((rep["export"]["coco"]["out"], rep["export"]["coco"]["outExists"]), (str(self.toy / "boxes.json"), False))
        self.assertEqual(rep["export"]["manifest"]["text"], 'python3 labeler/export.py manifest --labels-dir toy/labels --sample toy/sample.json --credit "YOUR NAME" '
                                                           '--out toy/manifest/labels.manifest.jsonl --catalog toy/catalog.json')
        self.assertEqual([x["t"] for x in rep["export"]["manifest"]["parts"] if x["fill"]], ['"YOUR NAME"'])
        with contextlib.chdir(self.start) if hasattr(contextlib, "chdir") else _chdir(self.start):
            for mode in ("box", "identify", "corner", "training"):
                with self.subTest(mode):
                    asked = self.parse(rep["passes"][mode]["command"])
                    values = pj.open_values(rep, mode) if rep["passes"][mode]["allowed"] else None
                    self.assertEqual((asked.mode, asked.role, str(Path(asked.sample).resolve())), (mode, "training", str(self.sample)))
                    if values:  # the flags and the page start the same thing
                        self.assertEqual(str(Path(asked.catalog).resolve()), values["catalog"])
                        self.assertEqual(str(Path(asked.art).resolve()), values["art"])
                        self.assertEqual([str(Path(p).resolve()) for p in asked.prefill or []], values["prefill"] or [])
                        self.assertEqual((asked.labels_dir, asked.frames_dir, asked.decklists_dir), (None, None, None), "the conventional folders need no flag")
        # the model's boxes left out: no --prefill, on the page and in the command
        rep = self.report(role="training", command=command, model_boxes=False)
        self.assertEqual((rep["modelBoxes"]["on"], pj.open_values(rep, "box")["prefill"]), (False, None))
        self.assertNotIn("--prefill", rep["passes"]["box"]["command"]["text"])
        self.assertIn("--prefill toy/prefill.jsonl", rep["passes"]["training"]["command"]["text"], "Corners from the model always starts from it")

    def test_the_parts_a_person_still_has_to_give_are_marked(self):
        rep = self.report(role="development", command={**self.COMMAND, "cwd": str(self.start)})
        fills = lambda mode: [p["t"] for p in rep["passes"][mode]["command"]["parts"] if p["fill"]]  # noqa: E731
        self.assertEqual(rep["passes"]["point"]["command"]["text"].split(" --catalog ")[0] + " … " + rep["passes"]["point"]["command"]["text"].split(" --art toy/art ")[1],
                         "python3 labeler/serve.py --mode point --role development --sample toy/sample.json … --k 12 --seed 1")
        self.assertEqual((fills("point"), fills("verify"), fills("box")), (["12", "1"], [], []))
        self.assertTrue(rep["passes"]["verify"]["command"]["text"].endswith("--all-blind"), "as the page starts it: no model's proposal")
        self.assertIn("--mode center ", rep["passes"]["center"]["command"]["text"], "the spelling of the page")
        self.assertEqual(self.parse(rep["passes"]["center"]["command"]).mode, "center", "read as the stored mode")
        test = self.report(role="test", command=self.COMMAND)
        self.assertTrue(test["passes"]["verify"]["command"]["text"].endswith("--all-blind"), "a test set is named with no model's suggestion")
        self.assertEqual([p["t"] for p in test["passes"]["verify"]["command"]["parts"] if p["fill"]], [])
        undecided = self.report(command=self.COMMAND)["passes"]["box"]["command"]
        self.assertEqual([p["t"] for p in undecided["parts"] if p["fill"]], ["ROLE"])
        self.assertTrue(rep["passes"]["point"]["button"] and rep["passes"]["verify"]["button"], "both start from the page")
        self.assertEqual(pj.open_values(rep, "point")["mode"], "point")
        with self.assertRaises(ValueError) as refused:
            pj.open_values(rep, "training")
        self.assertEqual(str(refused.exception), "training-only")

    def test_paths_with_spaces_other_folders_and_the_port(self):
        mine = self.start / "my set"
        shutil.copytree(self.toy, mine)
        out = self.tmp / "labels out"
        command = {"prefix": ["/usr/bin/python3", "-B", "/opt/my tools/labeler/serve.py"], "tail": ["--port", "8200"], "cwd": str(self.tmp / "elsewhere")}
        rep = pj.report(mine / "sample.json", base=self.start, role="test", given={"labels": str(out), "decklists": str(self.start / "lists")}, command=command)
        self.assertEqual(rep["restart"], "/usr/bin/python3 -B '/opt/my tools/labeler/serve.py' --port 8200")
        self.assertEqual(rep["passes"]["box"]["command"]["text"],
                         f"/usr/bin/python3 -B '/opt/my tools/labeler/serve.py' --mode box --role test --sample '{mine}/sample.json' --labels-dir '{out}' "
                         f"--decklists-dir {self.start}/lists --catalog '{mine}/catalog.json' --art '{mine}/art' --port 8200")
        self.assertEqual(rep["export"]["coco"]["text"],
                         f"/usr/bin/python3 -B '/opt/my tools/labeler/export.py' coco --labels-dir '{out}' --out '{mine}/boxes.json' --catalog '{mine}/catalog.json'")
        asked = self.parse({"argv": ["x", "y"] + rep["passes"]["box"]["command"]["argv"][3:]})
        self.assertEqual((asked.port, asked.labels_dir, asked.sample), (8200, str(out), str(mine / "sample.json")))
        (mine / "boxes.json").write_text("{}")
        self.assertTrue(pj.report(mine / "sample.json", base=self.start)["export"]["coco"]["outExists"])


@contextlib.contextmanager
def _chdir(path):  # contextlib.chdir is Python 3.11
    old = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(old)


# ---- what the tool remembers --------------------------------------------------------------------

class PythonName(Toy):
    """The interpreter every command the tool shows starts with: `python3` (or `python`) when that
    name runs the tool's own Python, else its full path, and the same in every command of a run."""

    def link(self, folder: Path, name: str, target) -> Path:
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).symlink_to(target)
        return folder / name

    def test_the_name_when_path_finds_this_interpreter(self):
        exe = sys.executable
        three = self.link(self.tmp / "bin", "python3", exe)
        plain = self.link(self.tmp / "bin2", "python", exe)
        self.assertEqual(serve.python_name(exe, lambda n: str(three) if n == "python3" else None), "python3", "a link to it counts")
        self.assertEqual(serve.python_name(exe, lambda n: str(plain) if n == "python" else None), "python")
        self.assertEqual(serve.python_name(exe, lambda n: None), exe, "no python on PATH: the full path")
        other = self.tmp / "other-python3"
        other.write_bytes(b"#!/bin/sh\n")
        self.assertEqual(serve.python_name(exe, lambda n: str(other)), exe, "another Python on PATH: the full path")
        self.assertEqual(serve.python_name(exe, lambda n: str(three) if n == "python3" else str(other)), "python3", "python3 first")

    def test_worked_out_once_per_run(self):
        calls = []
        with mock.patch.object(serve, "_PYTHON_NAME", []), mock.patch.object(serve, "python_name", lambda: calls.append(1) or "python3"):
            self.assertEqual((serve._python_name(), serve._python_name()), ("python3", "python3"))
        self.assertEqual(len(calls), 1, "PATH is looked at once: a later look cannot give another answer")

    def run_tool(self, path: str, *args) -> tuple:
        """Start serve.py as a person does, with PATH = `path`. → (process, its address)."""
        env = dict(os.environ, PATH=path, LABELER_QUIET="1", LABELER_STATE_DIR=str(self.state))
        proc = subprocess.Popen([sys.executable, str(HERE / "serve.py"), "--port", "0", *args], cwd=str(self.start), env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.addCleanup(lambda: (proc.poll() is None and proc.terminate(), proc.wait(10)))
        line = proc.stdout.readline()
        at = line.index("http://127.0.0.1:")
        return proc, line[at:].split()[0].rstrip("/")

    def fetch(self, base: str, path: str, body=None):
        import urllib.request
        req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="GET" if body is None else "POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    def commands(self, base: str) -> list:
        """Every command the start screen, the project screen and the labeling page show."""
        facts = self.fetch(base, "/api/hub")
        rep = self.fetch(base, "/api/project", {"path": str(self.sample)})
        out = [facts["restart"], f"{facts['tools']['python']} {facts['tools']['sample']}", rep["restart"]]
        out += [p["command"]["text"] for p in rep["passes"].values()]
        out += [rep["export"][kind]["text"] for kind in ("coco", "manifest")]
        launch = self.fetch(base, "/api/config")["launch"]
        if launch:
            out.append(" ".join(launch))
        return out

    def test_every_command_of_a_run_names_it_the_same_way(self):
        found = self.tmp / "found"
        self.link(found, "python3", sys.executable)
        empty = self.tmp / "empty"
        empty.mkdir()
        for path, word in ((str(found), "python3"), (str(empty), sys.executable)):
            for args in ((), ("--mode", "box", "--role", "training", "--sample", str(self.sample))):
                with self.subTest(path=path, args=args):
                    proc, base = self.run_tool(path, *args)
                    texts = self.commands(base)
                    self.assertGreaterEqual(len(texts), 9)
                    for text in texts:
                        self.assertTrue(text.startswith(shlex.quote(word) + " ") or text.startswith(word + " "), text)
                    proc.terminate()
                    proc.wait(10)


class Remembered(Toy):
    def test_the_per_user_folder_has_a_conventional_place_and_can_be_named(self):
        self.assertEqual(pj.recent_file(), self.state / "recent.json")
        place = pj.state_place
        mine = "/accounts/me"  # a made-up home folder
        self.assertEqual(place("darwin", {}, mine), [mine, "Library", "Application Support", "card-labeler"])
        self.assertEqual(place("linux", {}, mine), [mine, ".local", "state", "card-labeler"])
        self.assertEqual(place("linux", {"XDG_STATE_HOME": "/var/state"}, mine), ["/var/state", "card-labeler"])
        self.assertEqual(place("win32", {"APPDATA": r"D:\me\AppData\Roaming"}, r"D:\me"), [r"D:\me\AppData\Roaming", "card-labeler"])
        self.assertEqual(place("win32", {}, r"D:\me"), [r"D:\me", "AppData", "Roaming", "card-labeler"])
        for platform in ("darwin", "linux", "win32"):  # the variable names the folder itself, everywhere
            self.assertEqual(place(platform, {"LABELER_STATE_DIR": "/somewhere/else", "XDG_STATE_HOME": "/x", "APPDATA": "/y"}, mine), ["/somewhere/else"])
        home = self.tmp / "home"
        with mock.patch.dict(os.environ, {"HOME": str(home)}):
            os.environ.pop("LABELER_STATE_DIR")
            os.environ.pop("XDG_STATE_HOME", None)
            self.assertEqual(pj.state_dir(), Path(*place(sys.platform, {}, str(home))))
        self.assertFalse(home.exists(), "asking where it is writes nothing")

    def test_no_test_can_reach_the_real_per_user_folder(self):
        for module in ("test_project.py", "test_serve.py", "test_tool.py"):
            text = (HERE / module).read_text(encoding="utf-8")
            self.assertIn('os.environ["LABELER_STATE_DIR"] = ', text.split("\nimport serve")[0], f"{module} names its own folder before it imports the server")
        self.assertTrue(pj._inside(pj.recent_file(), tempfile.gettempdir()) or pj._inside(pj.recent_file(), self.tmp))

    def test_projects_opened_before_newest_first(self):
        self.assertEqual(pj.read_recent(), [], "no file: an empty list")
        self.assertFalse(self.state.exists(), "and reading it writes nothing")
        other = self.start / "other" / "sample.json"
        self.assertTrue(pj.remember_recent(self.sample, self.labels))
        self.assertTrue(pj.remember_recent(other, None))
        self.assertTrue(pj.remember_recent(self.sample, self.tmp / "elsewhere"))
        got = pj.read_recent()
        self.assertEqual([(e["sample"], e["labels"]) for e in got], [(str(self.sample), str(self.tmp / "elsewhere")), (str(other), None)])
        self.assertEqual(sorted(p.name for p in self.state.iterdir()), ["recent.json"], "one small file, written whole")
        doc = json.loads(pj.recent_file().read_text())
        self.assertEqual((doc["schemaVersion"], doc["tool"], len(doc["projects"])), (1, "labeler", 2))
        # the labels folder it remembers is where the project is looked for again
        self.assertEqual(self.report()["locations"]["labels"]["path"], str(self.tmp / "elsewhere"))
        self.assertEqual(self.report()["locations"]["labels"]["source"], "remembered")
        self.assertTrue(pj.forget_recent(str(other)))
        self.assertEqual([e["sample"] for e in pj.read_recent()], [str(self.sample)])
        for n in range(pj.RECENT_MAX + 5):
            pj.remember_recent(self.start / f"p{n}" / "sample.json", None)
        self.assertEqual(len(pj.read_recent()), pj.RECENT_MAX)

    def test_the_tool_works_when_the_list_is_absent_unreadable_or_out_of_date(self):
        self.state.mkdir()
        for text in ("{not json", "[1, 2]", '{"projects": "x"}', '{"projects": [3, {"sample": 4}, {"labels": "x"}]}'):
            pj.recent_file().write_text(text)
            self.assertEqual(pj.read_recent(), [], text)
        pj.recent_file().write_text(json.dumps({"projects": [{"sample": str(self.start / "gone" / "sample.json"), "labels": 5}, {"sample": str(self.sample)}]}))
        self.assertEqual([(e["sample"], e["labels"]) for e in pj.read_recent()], [(str(self.start / "gone" / "sample.json"), None), (str(self.sample), None)])
        self.assertEqual(pj.summary(pj.read_recent()[0]["sample"])["problem"], "missing", "a folder that is gone is named as gone")
        self.assertTrue(self.report()["ok"])
        # a per-user folder that cannot be made: nothing is remembered, nothing breaks
        with mock.patch.dict(os.environ, {"LABELER_STATE_DIR": str(self.sample / "not-a-folder")}):
            self.assertFalse(pj.remember_recent(self.sample, self.labels))
            self.assertEqual(pj.read_recent(), [])
            self.assertTrue(self.report()["ok"])

    def test_the_project_file_holds_the_purpose_and_what_is_not_found_anyway(self):
        places = self.report(role="training")["locations"]
        path, problem = pj.write_project_file(self.labels, self.sample, "training", places)
        self.assertEqual((path, problem), (self.labels / "labeler-project.json", None))
        doc = json.loads(path.read_text())
        self.assertEqual({k: v for k, v in doc.items() if k != "savedAt"}, {"schemaVersion": 1, "tool": "labeler", "sample": "../sample.json", "role": "training"},
                         "every file is beside the sample: no location needs storing")
        self.assertEqual(pj.read_project_file(self.labels, self.sample), {"role": "training", "locations": {}, "modelBoxes": None})
        self.assertEqual(self.report()["role"], {**self.report()["role"], "value": "training", "source": "remembered"})
        # written again with nothing new: the file is left as it is
        before = path.read_bytes()
        with mock.patch.object(pj, "_now", return_value="later"):
            pj.write_project_file(self.labels, self.sample, "training", places)
        self.assertEqual(path.read_bytes(), before)
        # a catalog elsewhere, card images in the project's own folder, the model's boxes left out
        cards = self.tmp / "game" / "cards.json"
        cards.parent.mkdir()
        cards.write_text((self.toy / "catalog.json").read_text())
        (self.toy / "pictures").mkdir()
        places = self.report(role="training", given={"catalog": str(cards), "art": "toy/pictures"})["locations"]
        pj.write_project_file(self.labels, self.sample, "training", places, model_boxes=False)
        doc = json.loads(path.read_text())
        self.assertEqual((doc["locations"], doc["modelBoxes"]), ({"catalog": str(cards), "art": "../pictures"}, False))
        rep = self.report()
        self.assertEqual({k: (v["path"], v["source"]) for k, v in rep["locations"].items() if k in ("catalog", "art")},
                         {"catalog": (str(cards), "remembered"), "art": (str(self.toy / "pictures"), "remembered")})
        self.assertEqual(rep["modelBoxes"], {"offered": True, "on": False, "file": "prefill.jsonl"})
        # the project's folder moved as a whole: what was stored relative to it still holds
        moved = self.start / "moved"
        self.toy.rename(moved)
        again = pj.report(moved / "sample.json", base=self.start)
        self.assertEqual((again["role"]["value"], again["locations"]["art"]["path"], again["locations"]["catalog"]["path"]),
                         ("training", str(moved / "pictures"), str(cards)))

    def test_a_project_file_that_is_not_this_samples_is_not_used(self):
        self.labels.mkdir()
        path = self.labels / pj.PROJECT_FILE
        for text in ("{not json", "[]", '{"tool": "other", "sample": "../sample.json", "role": "test"}',
                     '{"tool": "labeler", "role": "test"}', '{"tool": "labeler", "sample": "../another.json", "role": "test"}'):
            path.write_text(text)
            self.assertEqual(pj.read_project_file(self.labels, self.sample), {}, text)
            self.assertIsNone(self.report()["role"]["value"])
        path.write_text(json.dumps({"tool": "labeler", "sample": "../sample.json", "role": "king", "locations": {"catalog": 7, "labels": "x", "art": ""}, "modelBoxes": "yes"}))
        self.assertEqual(pj.read_project_file(self.labels, self.sample), {"role": None, "locations": {}, "modelBoxes": None}, "what it cannot use, it skips")
        # nothing a label set holds is touched by it: the server lists the same sets with it as without
        serve.configure(serve.build_parser().parse_args(["--mode", "box", "--role", "training", "--sample", str(self.sample)]))
        self.addCleanup(serve.CFG.__dict__.clear)
        self.assertEqual([s["setId"] for s in serve.list_sets()], ["table-a", "table-b"])

    def test_a_labels_folder_that_cannot_be_written_is_said_not_raised(self):
        places = self.report(role="training")["locations"]
        path, problem = pj.write_project_file(self.sample / "labels", self.sample, "training", places)
        self.assertIsNone(path)
        self.assertTrue(problem)


# ---- the server's routes for the two screens ----------------------------------------------------

class _TestServer(ThreadingHTTPServer):
    """The tool's server class with a listen queue that holds every connection a test opens at
    once. The default queue is 5; StartsFromThePage opens 16 connections at the same moment, and
    Linux resets the connections that overflow the queue where macOS lets the client retry."""

    request_queue_size = 64


class Server(Toy):
    """A server with no pass yet, started in the folder that holds the toy project."""

    def setUp(self):
        super().setUp()
        serve.CFG.__dict__.clear()
        self.saved = {k: getattr(serve.HUB, k) for k in ("start_dir", "project", "flags", "args", "command", "configuring")}
        serve.HUB.start_dir, serve.HUB.project, serve.HUB.flags, serve.HUB.args, serve.HUB.command = self.start, None, {}, None, None
        self.server = _TestServer(("127.0.0.1", 0), serve.Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        serve.CFG.__dict__.clear()
        for k, v in self.saved.items():
            setattr(serve.HUB, k, v)

    def request(self, method, path, body=None, headers=None, host=True):
        """(status, headers, body bytes), with every header under the test's control."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            sent = {} if host is None else {"Host": f"127.0.0.1:{self.port}" if host is True else host}
            data = None
            if body is not None:
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                sent.update({"Content-Type": "application/json", "Content-Length": str(len(data))})
            sent.update(headers or {})
            for k, v in sent.items():
                if v is not None:
                    conn.putheader(k, v)
            conn.endheaders(data)
            r = conn.getresponse()
            return r.status, dict(r.getheaders()), r.read()
        finally:
            conn.close()

    def get(self, path):
        status, _headers, body = self.request("GET", path)
        return status, json.loads(body)

    def post(self, path, body, run=True):
        """A POST as the tool's pages send it; a save carries the identity of the run the page
        was loaded from (`run=False`: without it; any other value: as that run)."""
        if run is not False and path.startswith(("/api/labels/", "/api/timing/", "/api/verify-reveal/")):
            body = {"run": serve.RUN_ID if run is True else run, **body}
        status, _headers, data = self.request("POST", path, body)
        return status, json.loads(data)


class Screens(Server):
    def test_with_no_pass_the_address_is_the_start_screen(self):
        status, headers, body = self.request("GET", "/")
        page = body.decode()
        self.assertEqual((status, headers["Content-Type"], headers["Cache-Control"]), (200, "text/html; charset=utf-8", "no-store"))
        self.assertIn('<script src="/hub.js"></script>', page)
        self.assertEqual(body, (HERE / "hub.html").read_bytes())
        for path in ("/start", "/project", "/project?sample=x", "/index.html"):
            self.assertEqual(self.request("GET", path)[2], body, path)
        scripts = [part.split('"')[0] for part in page.split('<script src="')[1:]]
        sheets = [part.split('"')[0] for part in page.split('<link rel="stylesheet" href="')[1:]]
        self.assertEqual(scripts, ["/uistate.js", "/keyroute.js", "/savegate.js", "/hubstate.js", "/hub.js"])
        self.assertEqual(sheets, ["/theme.css", "/sources.css", "/hub.css"], "the theme first, then the shared controls")
        for src in scripts + sheets:
            self.assertEqual(self.request("GET", src)[0], 200, src)
        self.assertNotIn("http://", page)
        self.assertNotIn("https://", page)
        # the labeling page's routes say that no pass is open; the question "do you still run" is answered
        self.assertEqual(self.get("/api/config"), (200, {"mode": None, "role": None, "launch": None, "run": serve.RUN_ID, "project": None}))
        for path in ("/api/sets", "/api/catalog", "/api/labels/table-a", "/frames/table-a/f00001.png", "/art/TOY-001"):
            self.assertEqual(self.get(path), (409, {"error": serve.NO_PASS}), path)
        self.assertEqual(self.post("/api/labels/table-a/frames/f00001.png", {"frame": {"name": "f00001.png"}}), (409, {"error": serve.NO_PASS}))
        self.assertEqual(self.get("/nothing-here")[0], 404)
        self.assertFalse(self.labels.exists())

    def test_what_the_start_screen_is_told(self):
        status, facts = self.get("/api/hub")
        self.assertEqual(status, 200)
        self.assertEqual((facts["startDir"], facts["recent"], facts["resume"]), (str(self.start), [], None))
        self.assertEqual(facts["found"], [{"sample": str(self.sample), "folder": str(self.toy), "name": "toy", "recordings": 2, "frames": 10}])
        self.assertEqual(facts["search"], {"cut": False, "depth": 3})
        self.assertEqual(facts["toy"], {"path": str(self.start / "toy-2"), "state": "ok"}, "a folder that is not there yet")
        self.assertEqual(facts["server"], {"configured": False, "mode": None, "role": None, "project": None, "name": None})
        self.assertEqual((facts["restart"], facts["tools"]), ("python3 labeler/serve.py", {"sample": "labeler/make_sample.py", "python": "python3"}))
        self.assertFalse(self.state.exists(), "looking at the start screen remembers nothing")
        # once a project was opened it is the one to resume, with its report; one that is gone is listed as gone
        pj.remember_recent(self.sample, self.labels)
        pj.remember_recent(self.start / "gone" / "sample.json", None)
        facts = self.get("/api/hub")[1]
        self.assertEqual([(e["name"], e.get("problem")) for e in facts["recent"]], [("gone", "missing"), ("toy", None)])
        self.assertEqual((facts["resume"]["sample"], facts["resume"]["next"]), (str(self.sample), {"pass": None, "startable": False}))

    def test_a_path_from_the_page_is_resolved_and_reported(self):
        status, rep = self.post("/api/project", {"path": "toy"})
        self.assertEqual((status, rep["ok"], rep["sample"], rep["recordings"], rep["frames"]["listed"]), (200, True, str(self.sample), 2, 10))
        self.assertEqual(rep["server"], {"configured": False, "sameProject": False, "mode": None, "role": None})
        self.assertEqual(self.post("/api/project", {"path": "nowhere"}), (200, {"ok": False, "problem": "missing", "path": str(self.start / "nowhere")}))
        self.assertEqual(self.post("/api/project", {"path": str(self.toy / "catalog.json")})[1]["problem"], "not-sample")
        self.assertEqual(self.post("/api/project", {}), (200, {"ok": False, "problem": "none", "path": None}), "this run has no project of its own")
        rep = self.post("/api/project", {"path": "toy", "role": "test", "locations": {"catalog": "nowhere.json", "junk": "x", "art": 5}, "modelBoxes": "yes"})[1]
        self.assertEqual((rep["role"]["value"], rep["locations"]["catalog"]["state"], rep["locations"]["art"]["source"]), ("test", "missing", "beside"))
        self.assertEqual(self.post("/api/project", {"path": "toy", "role": "king"})[1]["role"]["value"], None)
        self.assertFalse(self.state.exists() or self.labels.exists(), "checking a path writes nothing")

    def test_one_frame_for_the_project_screen(self):
        """The picture on a project's screen is the frame its report named, asked for by the key
        the report gave. No request can name a file or a folder to be served."""
        first = self.toy / "frames" / "table-a" / "f00001.png"
        unknown = "no-report-gave-this"
        for path in ("/api/thumb", f"/api/thumb?sample={self.sample}", "/api/thumb?sample=toy", f"/api/thumb?sample={self.sample}&frames={self.toy / 'frames'}",
                     f"/api/thumb?key={first}", "/api/thumb?key=", f"/api/thumb?key={unknown}"):
            self.assertEqual(self.get(path), (404, {"error": "no frame to show"}), path)
        thumb = self.post("/api/project", {"path": "toy"})[1]["frames"]["thumb"]
        self.assertEqual((thumb["asset"], thumb["name"], thumb["path"]), ("table-a", "f00001.png", str(first)))
        status, headers, body = self.request("GET", f"/api/thumb?key={thumb['key']}")
        self.assertEqual((status, headers["Content-Type"], body), (200, "image/png", first.read_bytes()))
        # another frames folder named on the page: its report names the frame found there, under another key
        other = self.start / "other-frames" / "table-a"
        other.mkdir(parents=True)
        sample = json.loads(self.sample.read_text())
        for asset in sample["assets"]:
            del asset["framesDir"]
        (self.toy / "plain.json").write_text(json.dumps(sample))
        shutil.copy(self.toy / "frames" / "table-a" / "f00002.png", other / "f00001.png")
        moved = self.post("/api/project", {"path": "toy/plain.json", "locations": {"frames": "other-frames"}})[1]["frames"]["thumb"]
        self.assertNotEqual(moved["key"], thumb["key"])
        self.assertEqual(self.request("GET", f"/api/thumb?key={moved['key']}")[2], (other / "f00001.png").read_bytes())
        # only so many keys are kept: the oldest are dropped, and a report offers its frame again
        with mock.patch.object(serve, "THUMBS_MAX", 1):
            self.post("/api/project", {"path": "toy"})
        self.assertEqual(self.get(f"/api/thumb?key={moved['key']}")[0], 404)
        self.assertEqual(self.request("GET", f"/api/thumb?key={thumb['key']}")[0], 200)
        # what stands at the frame's name is served only when it is a file
        first.unlink()
        os.mkfifo(first) if hasattr(os, "mkfifo") else first.mkdir()
        self.assertEqual(self.get(f"/api/thumb?key={thumb['key']}"), (404, {"error": "not found"}))

    def test_opening_a_project_remembers_it(self):
        status, got = self.post("/api/remember", {"path": "toy"})
        self.assertEqual((status, got["ok"], got["remembered"]), (200, True, {"recent": True, "projectFile": None, "problem": None}))
        self.assertEqual([e["sample"] for e in pj.read_recent()], [str(self.sample)])
        self.assertFalse(self.labels.exists(), "nothing to say about it yet: nothing is written into its labels folder")
        got = self.post("/api/remember", {"path": "toy", "role": "development"})[1]
        self.assertEqual(got["remembered"]["projectFile"], str(self.labels / "labeler-project.json"))
        self.assertEqual(json.loads((self.labels / "labeler-project.json").read_text())["role"], "development")
        self.assertEqual(self.post("/api/project", {"path": "toy"})[1]["role"]["value"], "development", "and it is the answer next time")
        self.post("/api/remember", {"path": "toy", "role": "training", "modelBoxes": False})
        doc = json.loads((self.labels / "labeler-project.json").read_text())
        self.assertEqual((doc["role"], doc["modelBoxes"]), ("training", False))
        self.assertEqual(self.post("/api/remember", {"path": "nowhere"})[1]["problem"], "missing")
        self.assertEqual(len(pj.read_recent()), 1)
        self.assertEqual(self.post("/api/forget", {"sample": str(self.sample)}), (200, {"ok": True}))
        self.assertEqual(pj.read_recent(), [])
        self.assertEqual(self.post("/api/forget", {})[0], 400)

    def test_the_toy_example_goes_into_a_new_folder_that_the_server_names(self):
        target = str(self.start / "toy-2")
        for wrong in (str(self.toy), str(self.start / "elsewhere"), "", None, "../outside"):
            status, got = self.post("/api/toy", {"path": wrong})
            self.assertEqual((status, got["ok"], got["problem"], got["toy"]["path"]), (409, False, "moved", target), wrong)
        self.assertEqual(sorted(p.name for p in self.start.iterdir()), ["toy"], "nothing was written")
        before = (self.toy / "sample.json").read_bytes()
        status, got = self.post("/api/toy", {"path": target})
        self.assertEqual((status, got), (200, {"ok": True, "sample": str(self.start / "toy-2" / "sample.json"), "folder": target}))
        self.assertEqual(len(list((self.start / "toy-2" / "frames").glob("*/*.png"))), 10)
        self.assertEqual((self.toy / "sample.json").read_bytes(), before)
        # it opens ready to start: its purpose is answered (Training, as its pretend model's boxes need)
        rep = self.post("/api/project", {"path": target})[1]
        self.assertEqual((rep["role"]["value"], rep["role"]["fixed"], rep["next"]), ("training", False, {"pass": "box", "startable": True}))
        self.assertEqual([e["sample"] for e in pj.read_recent()], [str(self.start / "toy-2" / "sample.json")])
        # the same request again: the folder is taken now, and is never written over
        status, got = self.post("/api/toy", {"path": target})
        self.assertEqual((status, got["problem"], got["toy"]["path"]), (409, "moved", str(self.start / "toy-3")))
        with mock.patch.object(serve.os, "access", return_value=False):
            self.assertEqual(self.get("/api/hub")[1]["toy"]["state"], "not-writable")
            self.assertEqual(self.post("/api/toy", {"path": str(self.start / "toy-3")})[1]["problem"], "not-writable")
        self.assertFalse((self.start / "toy-3").exists())


class FirstPass(Server):
    def test_the_page_starts_the_first_pass_and_only_the_first(self):
        written = io.StringIO()
        with contextlib.redirect_stdout(written):
            status, got = self.post("/api/open", {"path": "toy", "pass": "box", "role": "training"})
        self.assertEqual((status, got["ok"]), (200, True), got)
        self.assertEqual(written.getvalue().splitlines()[0], f"labeling tool: http://127.0.0.1:{self.port}/  mode=box role=training", "the terminal says what runs now")
        # the labeling page is at the address now, with the settings the flags would have given
        self.assertEqual(self.request("GET", "/")[2], (HERE / "index.html").read_bytes())
        config = self.get("/api/config")[1]
        self.assertEqual((config["mode"], config["role"], config["prefill"], config["art"]), ("box", "training", True, True))
        self.assertEqual(config["launch"][2:], ["--mode", "box", "--role", "training", "--sample", "toy/sample.json", "--catalog", "toy/catalog.json",
                                                "--art", "toy/art", "--prefill", "toy/prefill.jsonl"])
        cfg = serve.CFG
        self.assertEqual((cfg.sample, cfg.labels_dir, cfg.frames_dir, cfg.catalog, cfg.art, cfg.decklists_dir, cfg.prefills),
                         (self.sample, self.labels, self.toy / "frames", self.toy / "catalog.json", self.toy / "art", self.toy / "decklists", {"*": self.toy / "prefill.jsonl"}))
        self.assertEqual((cfg.k, cfg.seed, cfg.zoom, cfg.snap, cfg.verify), (lc.DEFAULT_K, 1, lc.DEFAULT_ZOOM, False, None))
        self.assertEqual([s["setId"] for s in self.get("/api/sets")[1]], ["table-a", "table-b"])
        self.assertEqual(len(self.get("/api/prefill/table-a")[1]["frames"]), 5)
        # what was opened is remembered: the project, and its purpose
        self.assertEqual([e["sample"] for e in pj.read_recent()], [str(self.sample)])
        self.assertEqual(json.loads((self.labels / "labeler-project.json").read_text())["role"], "training")
        # the pass that runs answers "open"; another pass, or another project, is a new start of the tool
        self.assertEqual(self.post("/api/open", {"path": "toy", "pass": "box", "role": "training"}), (200, {"ok": True, "already": True}))
        status, got = self.post("/api/open", {"path": "toy", "pass": "identify"})
        self.assertEqual((status, got["problem"], got["server"]), (409, "running", {"configured": True, "sameProject": True, "mode": "box", "role": "training"}))
        self.assertEqual(self.post("/api/open", {"path": str(self.start / "toy-9"), "pass": "box"})[0], 409)
        self.assertEqual(serve.CFG.mode, "box")
        # the project screen of the running pass: it is "running", with the locations the pass has
        rep = self.post("/api/project", {"path": "toy", "role": "test", "locations": {"catalog": "elsewhere.json"}})[1]
        self.assertEqual((rep["role"]["value"], rep["locations"]["catalog"]["state"], rep["server"]["sameProject"]), ("training", "ok", True),
                         "what the page asks for does not change a running pass")
        self.assertEqual({m: p["running"] for m, p in rep["passes"].items() if p["running"]}, {"box": True})
        self.assertEqual(self.post("/api/project", {})[1]["sample"], str(self.sample), "this run's own project needs no path")
        facts = self.get("/api/hub")[1]
        self.assertEqual(facts["server"], {"configured": True, "mode": "box", "role": "training", "project": str(self.sample), "name": "toy"})

    def test_a_pass_started_from_the_page_writes_the_labels_a_flag_start_writes(self):
        def save():
            status, got = self.post("/api/labels/table-a/frames/f00001.png", {"frame": frame(1, True, [box(1)])})
            self.assertEqual(status, 200, got)
            return ({k: v for k, v in got["meta"].items() if k not in ("createdAt", "labeledAt")}, got["frame"],
                    sorted(path.name for path in (self.labels / "table-a").iterdir()))

        with contextlib.redirect_stdout(io.StringIO()):
            self.post("/api/open", {"path": "toy", "pass": "box", "role": "training", "modelBoxes": False})
        from_page = save()
        self.assertEqual(sorted(path.name for path in self.labels.iterdir()), ["labeler-project.json", "table-a"])
        shutil.rmtree(self.labels)
        serve.CFG.__dict__.clear()
        serve.configure(serve.build_parser().parse_args(["--mode", "box", "--role", "training", "--sample", str(self.sample),
                                                         "--catalog", str(self.toy / "catalog.json"), "--art", str(self.toy / "art")]))
        self.assertEqual(save(), from_page, "the same meta.json, the same row, the same files")
        self.assertEqual(sorted(path.name for path in self.labels.iterdir()), ["table-a"], "a start with flags writes no project file")

    def test_a_pass_that_cannot_be_started_is_refused_and_nothing_is_configured(self):
        for body, problem in (({"path": "toy", "pass": "box"}, "no-role"),
                              ({"path": "toy", "pass": "center", "role": "training"}, "not-for-training"),
                              ({"path": "toy", "pass": "training", "role": "test"}, "training-only"),
                              ({"path": "toy", "pass": "identify", "role": "training"}, "nothing-to-name"),
                              ({"path": "toy", "pass": "verify", "role": "development"}, "no-centers"),
                              ({"path": "toy", "pass": "verify", "role": "training"}, "not-for-training"),
                              ({"path": "toy", "pass": "bogus", "role": "training"}, "not-offered"),
                              ({"path": "toy", "role": "training"}, "not-offered"),
                              ({"path": "nowhere", "pass": "box", "role": "training"}, "missing")):
            with self.subTest(body):
                status, got = self.post("/api/open", body)
                self.assertEqual((status, got["ok"], got["problem"]), (409, False, problem))
                self.assertFalse(serve.ready())
        self.assertEqual(self.request("GET", "/")[2], (HERE / "hub.html").read_bytes())
        # the server's own check has the last word: what it refuses half-way leaves no pass behind
        with mock.patch.object(serve, "load_catalog", side_effect=SystemExit("--catalog: it went away")), \
                mock.patch.object(serve, "_resolve_art", side_effect=SystemExit("--art: not a folder or an http(s) URL: x")):
            status, got = self.post("/api/open", {"path": "toy", "pass": "box", "role": "training"})
        self.assertEqual((status, got["problem"], got["detail"]), (409, "refused", "--art: not a folder or an http(s) URL: x"))
        self.assertFalse(serve.ready())
        self.assertIsNone(serve.CFG.sample)
        self.assertEqual(self.get("/api/sets"), (409, {"error": serve.NO_PASS}))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.post("/api/open", {"path": "toy", "pass": "box", "role": "training"})[0], 200, "and it can still be started")

    def test_other_passes_the_page_can_start(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.post("/api/open", {"path": "toy", "pass": "center", "role": "test"})[0], 200)
        self.assertEqual((serve.CFG.mode, serve.CFG.role, serve.CFG.prefills, serve.prefill_on()), ("center", "test", {}, False))
        serve.CFG.__dict__.clear()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.post("/api/open", {"path": "toy", "pass": "training", "role": "training", "modelBoxes": False})[0], 200)
        self.assertEqual((serve.CFG.mode, serve.CFG.prefills), ("training", {"*": self.toy / "prefill.jsonl"}))
        serve.CFG.__dict__.clear()
        write_set(self.labels, "table-a", [frame(1, True, [box(1)])])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.post("/api/open", {"path": "toy", "pass": "identify", "role": "test"})[0], 200, "the labels say Training: that is what starts")
        self.assertEqual((serve.CFG.mode, serve.CFG.role, serve.CFG.prefills), ("identify", "training", {}))
        self.assertIsNone(serve.read_only_reason(*serve.read_set("table-a")))

    def test_a_project_named_when_the_tool_was_started(self):
        serve.HUB.project = self.sample
        serve.HUB.flags = {"role": "test", "catalog": self.tmp / "no-such.json"}
        serve.HUB.args = serve.build_parser().parse_args([str(self.toy), "--role", "test", "--zoom", "4", "--snap", "on"])
        facts = self.get("/api/hub")[1]
        self.assertEqual((facts["server"]["project"], facts["server"]["name"], facts["server"]["configured"]), (str(self.sample), "toy", False))
        rep = self.post("/api/project", {})[1]
        self.assertEqual((rep["sample"], rep["role"]["value"], rep["locations"]["catalog"]["source"], rep["locations"]["catalog"]["state"]),
                         (str(self.sample), "test", "flag", "missing"))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.post("/api/open", {"pass": "box"})[0], 200)
        self.assertEqual((serve.CFG.role, serve.CFG.catalog, serve.CFG.zoom, serve.CFG.snap), ("test", None, 4.0, True), "its other settings are kept")


# ---- the requests the server turns away ---------------------------------------------------------

class Refusals(Server):
    """A local server that takes paths: only this computer's browser, at the server's own
    address, may ask it for anything, and only a JSON request from its own page may change
    anything. Nothing is written by a request that is turned away."""

    FRAME = {"frame": frame(1, True, [box(1)])}

    def changing_routes(self):
        return (("/api/labels/table-a/frames/f00001.png", self.FRAME), ("/api/labels/table-a/meta", {"notes": "x"}),
                ("/api/timing/table-a", {"events": [{"ev": "session-open"}]}), ("/api/verify-reveal/table-a", {"frame": "f00001.png", "center": "C001"}),
                ("/api/project", {"path": "toy"}), ("/api/remember", {"path": "toy", "role": "training"}), ("/api/forget", {"sample": str(self.sample)}),
                ("/api/toy", {"path": str(self.start / "toy-2")}), ("/api/open", {"path": "toy", "pass": "box", "role": "training"}),
                ("/api/switch", {"run": serve.RUN_ID, "unsaved": 0, "path": "toy", "pass": "box", "role": "training"}),
                ("/api/tabs", {"run": serve.RUN_ID, "tab": "t1", "unsaved": 1}),
                ("/api/export", {"run": serve.RUN_ID, "path": "toy", "kind": "coco", "replace": True}))

    def untouched(self):
        self.assertEqual(sorted(p.name for p in self.start.iterdir()), ["toy"])
        self.assertFalse(self.labels.exists() or self.state.exists())
        self.assertFalse(serve.ready())

    def test_a_request_under_another_name_is_turned_away(self):
        own = [f"127.0.0.1:{self.port}", f"localhost:{self.port}", f"LOCALHOST:{self.port}"]
        for host in own:
            self.assertEqual(self.request("GET", "/api/hub", host=host)[0], 200, host)
        others = ["evil.example", f"evil.example:{self.port}", "127.0.0.1", "localhost", f"127.0.0.1:{self.port + 1}", f"127.0.0.1.evil.example:{self.port}",
                  f"[::1]:{self.port}", "", None]
        for host in others:
            for method, path, body in [("GET", "/", None), ("GET", "/api/hub", None), ("GET", "/api/config", None), ("GET", "/hub.js", None),
                                       ("GET", "/api/thumb?key=x", None), ("GET", "/guide", None)] + [("POST", p, b) for p, b in self.changing_routes()]:
                with self.subTest(host=host, path=path):
                    status, headers, data = self.request(method, path, body, host=host)
                    self.assertEqual(status, 403)
                    self.assertEqual(json.loads(data), {"error": "this tool answers only at its own address on this computer (http://127.0.0.1:<port>/)"})
        self.untouched()

    def test_only_a_json_request_changes_anything(self):
        for path, body in self.changing_routes():
            data = json.dumps(body).encode()
            for ctype in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "", None, "text/plain; application/json"):
                with self.subTest(path=path, ctype=ctype):
                    status, _headers, got = self.request("POST", path, data, headers={"Content-Type": ctype})
                    self.assertEqual(status, 415)
                    self.assertEqual(json.loads(got), {"error": "a request that changes anything must be JSON (Content-Type: application/json)"})
        self.untouched()
        self.assertEqual(self.request("POST", "/api/project", json.dumps({"path": "toy"}).encode(), headers={"Content-Type": "Application/JSON; charset=utf-8"})[0], 200)
        # and nothing is changed by a request that is not a POST
        for method in ("PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"):
            for path, body in self.changing_routes():
                self.assertIn(self.request(method, path, body)[0], (405, 501), f"{method} {path}")
        for path, _body in self.changing_routes()[4:]:
            self.assertIn(self.request("GET", path)[0], (404, 409), f"GET {path}")
        self.untouched()

    def test_only_the_tools_own_page_changes_anything(self):
        for path, body in self.changing_routes():
            for origin in ("http://evil.example", "https://evil.example", "null", f"http://evil.example:{self.port}", f"https://127.0.0.1:{self.port}",
                           "http://127.0.0.1", f"http://127.0.0.1:{self.port + 1}", f"http://127.0.0.1:{self.port}.evil.example", ""):
                with self.subTest(path=path, origin=origin):
                    status, _headers, got = self.request("POST", path, body, headers={"Origin": origin})
                    self.assertEqual(status, 403)
                    self.assertEqual(json.loads(got), {"error": "a request that changes anything must come from this tool's own page"})
        self.untouched()
        for origin in (f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}", None):
            self.assertEqual(self.request("POST", "/api/project", {"path": "toy"}, headers={"Origin": origin})[0], 200, origin)

    def test_the_labeling_routes_are_checked_too_when_a_pass_runs(self):
        serve.configure(serve.build_parser().parse_args(["--mode", "box", "--role", "training", "--sample", str(self.sample)]))
        path = "/api/labels/table-a/frames/f00001.png"
        data = json.dumps({"run": serve.RUN_ID, **self.FRAME}).encode()
        self.assertEqual(self.request("POST", path, data, host="evil.example")[0], 403)
        self.assertEqual(self.request("POST", path, data, headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", path, data, headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/timing/table-a", {"events": [{"ev": "x"}]}, headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/labels/table-a", host="evil.example")[0], 403)
        self.assertEqual(self.request("GET", "/frames/table-a/f00001.png", host=f"evil.example:{self.port}")[0], 403)
        self.assertFalse(self.labels.exists(), "nothing was saved")
        self.assertEqual(self.request("POST", path, data, headers={"Origin": f"http://localhost:{self.port}"})[0], 200, "the page itself saves as before")
        self.assertTrue((self.labels / "table-a" / "frames.jsonl").is_file())

    def test_no_answer_lets_another_site_read_it(self):
        asked = [("GET", "/", None, {}), ("GET", "/api/hub", None, {}), ("GET", "/hub.js", None, {}), ("GET", "/nothing", None, {}),
                 ("POST", "/api/project", {"path": "toy"}, {"Origin": f"http://127.0.0.1:{self.port}"}),
                 ("POST", "/api/project", {"path": "toy"}, {"Origin": "http://evil.example"}),
                 ("GET", "/api/hub", None, {"Origin": "http://evil.example"}),
                 ("OPTIONS", "/api/open", None, {"Origin": "http://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})]
        for method, path, body, headers in asked:
            with self.subTest(method=method, path=path):
                status, got, _data = self.request(method, path, body, headers=headers)
                self.assertEqual([k for k in got if k.lower().startswith("access-control")], [])
                if method == "OPTIONS":
                    self.assertEqual(status, 501, "a browser's question before a request from another site gets no yes")

    def test_the_server_listens_on_this_computer_only(self):
        source = (HERE / "serve.py").read_text(encoding="utf-8")
        self.assertEqual(source.count("ThreadingHTTPServer(("), 1)
        self.assertIn('ThreadingHTTPServer(("127.0.0.1", args.port), Handler)', source)
        # the toy example and the checks of a path are Python calls: nothing here starts a program
        for module in ("serve.py", "project.py"):
            text = (HERE / module).read_text(encoding="utf-8")
            for word in ("subprocess", "os.system", "os.popen", "shell=True"):
                self.assertNotIn(word, text, f"{module}: {word}")


# ---- the command line ---------------------------------------------------------------------------

class CommandLine(Toy):
    def parse(self, *argv):
        with contextlib.redirect_stderr(io.StringIO()) as said:
            try:
                return serve.build_parser().parse_args(list(argv))
            except SystemExit:
                return said.getvalue().strip().splitlines()[-1]

    def test_no_argument_is_needed_and_every_flag_still_means_what_it_meant(self):
        a = self.parse()
        self.assertEqual((a.mode, a.role, a.sample, a.project, a.port), (None, None, None, None, serve.DEFAULT_PORT))
        a = self.parse("toy")
        self.assertEqual((a.mode, a.project), (None, "toy"))
        a = self.parse("--mode", "box", "--role", "training", "--sample", "s.json", "--prefill", "p.jsonl")
        self.assertEqual((a.mode, a.role, a.sample, a.project, a.prefill), ("box", "training", "s.json", None, ["p.jsonl"]))
        a = self.parse("toy", "--mode", "identify", "--role", "test")
        self.assertEqual((a.mode, a.role, a.sample, a.project), ("identify", "test", None, "toy"))
        self.assertEqual(self.parse("toy", "--role", "test", "--catalog", "c.json").catalog, "c.json", "a project's flags, for its screen")
        self.assertEqual(self.parse("--sample", "s.json").sample, "s.json")
        self.assertEqual(self.parse("--port", "0", "--zoom", "2").zoom, 2.0)

    def test_a_command_line_that_cannot_work_ends_in_one_sentence(self):
        for argv, words in (
                (("--mode", "box"), "serve.py: error: --mode box also needs --role and --sample (or start with no arguments and choose on the page)"),
                (("--mode", "box", "--role", "training"), "serve.py: error: --mode box also needs --sample (or start with no arguments and choose on the page)"),
                (("--mode", "box", "--sample", "s.json"), "serve.py: error: --mode box also needs --role (or start with no arguments and choose on the page)"),
                (("toy", "--sample", "s.json"), "serve.py: error: the sample is given twice: use --sample FILE or FOLDER-OR-SAMPLE, not both"),
                (("toy", "--arm", "a=b"), "serve.py: error: --arm: only with --mode verify"),
                (("--all-blind",), "serve.py: error: --all-blind: only with --mode verify"),
                (("--role", "test", "--catalog", "c.json"), "serve.py: error: --role, --catalog: say which project too (FOLDER-OR-SAMPLE), or leave it out and choose on the page"),
                (("--prefill", "p.jsonl"), "serve.py: error: --prefill: say which project too (FOLDER-OR-SAMPLE), or leave it out and choose on the page"),
                (("a", "b"), "serve.py: error: unrecognized arguments: b")):
            with self.subTest(argv):
                self.assertTrue(str(self.parse(*argv)).endswith(words.split("serve.py: ", 1)[1]), self.parse(*argv))

    def run_tool(self, *argv, cwd=None):
        """Start serve.py as a program; (process, the lines it printed first)."""
        proc = subprocess.Popen([sys.executable, "-B", "-u", str(HERE / "serve.py"), "--port", "0", *argv], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                cwd=str(cwd or self.start), env=dict(os.environ, LABELER_QUIET="1", LABELER_STATE_DIR=str(self.state)))
        self.addCleanup(self.end, proc)
        return proc

    def end(self, proc):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        proc.stdout.close()
        proc.stderr.close()

    def fetch(self, base, path, body=None):
        conn = http.client.HTTPConnection(base.split("//")[1], timeout=10)
        try:
            data = None if body is None else json.dumps(body).encode()
            conn.request("POST" if body is not None else "GET", path, body=data, headers={"Content-Type": "application/json"} if body is not None else {})
            r = conn.getresponse()
            return r.status, r.read()
        finally:
            conn.close()

    def test_started_with_no_arguments(self):
        empty = self.tmp / "empty"
        empty.mkdir()
        proc = self.run_tool(cwd=empty)
        lines = [proc.stdout.readline().rstrip("\n") for _ in range(3)]
        base = lines[0].split()[2].rstrip("/")
        self.assertEqual(lines, [f"Card labeler: {base}/", "Open this address to choose what to label.", "Ctrl+C stops the tool."])
        self.assertTrue(base.startswith("http://127.0.0.1:") and not base.endswith(":0"))
        status, page = self.fetch(base, "/")
        self.assertEqual((status, page), (200, (HERE / "hub.html").read_bytes()))
        facts = json.loads(self.fetch(base, "/api/hub")[1])
        self.assertEqual((facts["startDir"], facts["found"], facts["recent"], facts["server"]["configured"]), (str(empty), [], [], False))
        self.assertEqual(facts["toy"], {"path": str(empty / "toy"), "state": "ok"})
        script = str(HERE / "serve.py")
        self.assertEqual(facts["restart"].split(" -B -u ")[1], f"{script} --port 0", "how it was started, to start it again")
        self.assertEqual(sorted(p.name for p in empty.iterdir()), [], "nothing is written where it was started")
        self.assertFalse(self.state.exists())
        # the toy example, then its first pass, from the page; the terminal says what runs
        made = json.loads(self.fetch(base, "/api/toy", {"path": str(empty / "toy")})[1])
        self.assertEqual(made["sample"], str(empty / "toy" / "sample.json"))
        self.assertEqual(json.loads(self.fetch(base, "/api/open", {"path": made["sample"], "pass": "box"})[1])["ok"], True)
        self.assertEqual(proc.stdout.readline().rstrip("\n"), f"labeling tool: {base}/  mode=box role=training")
        self.assertEqual(self.fetch(base, "/")[1], (HERE / "index.html").read_bytes())
        config = json.loads(self.fetch(base, "/api/config")[1])
        self.assertEqual((config["mode"], config["prefill"]), ("box", True))
        self.assertEqual(config["launch"][-4:], ["--prefill", "toy/prefill.jsonl", "--port", "0"])
        self.end(proc)
        # started again with no arguments: it offers to resume the project where it stands
        proc = self.run_tool(cwd=empty)
        base = proc.stdout.readline().split()[2].rstrip("/")
        facts = json.loads(self.fetch(base, "/api/hub")[1])
        self.assertEqual((facts["resume"]["sample"], facts["resume"]["role"]["value"], facts["resume"]["next"]), (made["sample"], "training", {"pass": "box", "startable": True}))
        self.assertEqual(facts["server"]["configured"], False)

    def test_started_on_one_project(self):
        for named in ("toy", "toy/sample.json", str(self.toy)):
            with self.subTest(named):
                proc = self.run_tool(named, "--role", "development")
                lines = [proc.stdout.readline().rstrip("\n") for _ in range(3)]
                base = lines[0].split()[2].rstrip("/")
                self.assertEqual(lines[1:], ["Open this address to choose what to label in toy.", "Ctrl+C stops the tool."])
                facts = json.loads(self.fetch(base, "/api/hub")[1])
                self.assertEqual((facts["server"]["project"], facts["server"]["configured"]), (str(self.sample), False))
                rep = json.loads(self.fetch(base, "/api/project", {})[1])
                self.assertEqual((rep["sample"], rep["role"]["value"]), (str(self.sample), "development"))
                self.end(proc)
        self.assertFalse(self.labels.exists() or self.state.exists(), "nothing is remembered until a person opens the project")

    def test_a_project_and_a_mode_start_that_pass_as_the_sample_flag_does(self):
        proc = self.run_tool("toy", "--mode", "box", "--role", "test")
        lines = [proc.stdout.readline().rstrip("\n") for _ in range(3)]
        base = lines[0].split()[2].rstrip("/")
        self.assertEqual(lines, [f"labeling tool: {base}/  mode=box role=test", f"labels:    {self.labels}", f"sample:    {self.sample}"])
        self.assertEqual(self.fetch(base, "/")[1], (HERE / "index.html").read_bytes())
        self.assertEqual(self.fetch(base, "/project")[1], (HERE / "hub.html").read_bytes(), "the project screen of a pass started with flags")
        rep = json.loads(self.fetch(base, "/api/project", {})[1])
        self.assertEqual((rep["passes"]["box"]["running"], rep["role"]["value"], rep["locations"]["catalog"]["state"]), (True, "test", "off"),
                         "the pass runs with what its flags gave: no catalog was given, though one lies beside the sample")
        self.assertEqual((rep["locations"]["art"]["state"], rep["locations"]["prefill"]["state"], rep["modelBoxes"]["offered"]), ("off", "off", False))
        self.assertFalse(self.labels.exists() or self.state.exists(), "a start with flags remembers nothing by itself")
        # a person opens its project screen: now it is remembered, as it runs
        got = json.loads(self.fetch(base, "/api/remember", {})[1])
        self.assertEqual(got["remembered"], {"recent": True, "projectFile": str(self.labels / "labeler-project.json"), "problem": None, "detail": None})
        self.assertEqual({k: v for k, v in json.loads((self.labels / "labeler-project.json").read_text()).items() if k != "savedAt"},
                         {"schemaVersion": 1, "tool": "labeler", "sample": "../sample.json", "role": "test"})
        self.assertEqual([e["sample"] for e in json.loads((self.state / "recent.json").read_text())["projects"]], [str(self.sample)])

    def test_a_project_that_is_none_ends_the_start_in_one_sentence(self):
        (self.start / "notes.json").write_text("{}")
        (self.start / "empty").mkdir()
        for named, words in (("nowhere", f"nowhere: nothing is there: {self.start / 'nowhere'}"),
                             ("empty", f"empty: that folder holds no sample.json (name the sample file itself if it is called something else): {self.start / 'empty'}"),
                             ("notes.json", "notes.json: the file is JSON but lists no videos")):
            for more in ((), ("--mode", "box", "--role", "training")):
                with self.subTest(named=named, more=more):
                    res = subprocess.run([sys.executable, "-B", str(HERE / "serve.py"), "--port", "0", named, *more], capture_output=True, text=True, timeout=30,
                                         cwd=str(self.start), env=dict(os.environ, LABELER_STATE_DIR=str(self.state)))
                    self.assertEqual((res.returncode, res.stdout), (1, ""))
                    self.assertEqual(len(res.stderr.strip().splitlines()), 1, res.stderr)
                    self.assertTrue(res.stderr.startswith(words), res.stderr)
        # --sample keeps its own, older sentence
        res = subprocess.run([sys.executable, "-B", str(HERE / "serve.py"), "--port", "0", "--mode", "box", "--role", "training", "--sample", "nowhere.json"],
                             capture_output=True, text=True, timeout=30, cwd=str(self.start))
        self.assertEqual(res.stderr.strip(), f"--sample: not a file: {self.start / 'nowhere.json'}")

    def test_a_start_without_a_pass_checks_what_the_pass_would_check(self):
        """`serve.py toy --decklist no-such.txt` once started, and offered a Start button that
        was refused at every press. What a pass checks of its settings is checked when the tool
        starts: one sentence, and it does not start."""
        (self.start / "deck.txt").write_text("TOY-001\n")
        missing = self.start / "no-such.txt"
        for more, words in ((("--decklist", "no-such.txt"), f"--decklist: not a file: {missing}"),
                            (("--decklist", "deck.txt", "--decklist", "table-b=no-such.txt"), f"--decklist: not a file: {missing}"),
                            (("--prefill", "no-such.txt"), f"--prefill: not a file: {missing}"),
                            (("--k", "0"), "--k must be ≥ 1 and --zoom > 0"), (("--zoom", "0"), "--k must be ≥ 1 and --zoom > 0"),
                            (("--zoom", "-1", "--decklist", "deck.txt"), "--k must be ≥ 1 and --zoom > 0"),
                            (("--art", "no-such-folder"), "--art: not a folder or an http(s) URL: no-such-folder")):
            for start in (("toy",), ("toy", "--mode", "box", "--role", "training")):  # the same sentence with and without a pass
                with self.subTest(more=more, start=start):
                    res = subprocess.run([sys.executable, "-B", str(HERE / "serve.py"), "--port", "0", *start, *more], capture_output=True, text=True, timeout=30,
                                         cwd=str(self.start), env=dict(os.environ, LABELER_STATE_DIR=str(self.state)))
                    self.assertEqual((res.returncode, res.stdout, res.stderr.strip()), (1, "", words))
        # settings that can work start the tool, and the page's start then works too
        proc = self.run_tool("toy", "--role", "training", "--decklist", "deck.txt", "--zoom", "2")
        base = proc.stdout.readline().split()[2].rstrip("/")
        status, body = self.fetch(base, "/api/open", {"pass": "box"})
        self.assertEqual((status, json.loads(body)["ok"]), (200, True), body)
        config = json.loads(self.fetch(base, "/api/config")[1])
        self.assertEqual((config["zoom"], config["launch"][-6:]), (2.0, ["--decklist", "deck.txt", "--zoom", "2", "--port", "0"]))


# ---- another site cannot make the tool do anything, or remember anything --------------------------

class OtherSites(Server):
    """Arriving at an address is not a person opening a project: whatever page sent the browser
    here, nothing is remembered, and a page of another site gets neither a project's screen nor
    the tool's data."""

    def test_an_address_with_a_project_in_it_from_another_site_is_the_start_screen(self):
        hub = (HERE / "hub.html").read_bytes()
        for site in ("cross-site", "same-site", "Cross-Site"):
            for path in (f"/project?sample={self.sample}", f"/?sample={self.sample}", f"/start?sample={self.sample}", "/project?sample=", f"/index.html?x=1&sample={self.sample}"):
                with self.subTest(site=site, path=path):
                    status, headers, body = self.request("GET", path, headers={"Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"})
                    self.assertEqual((status, headers["Location"], body), (303, "/start", b""), "the start screen, with nothing named")
        # the tool's own pages, a typed address and a bookmark, and a browser that says nothing, get the screen they ask for
        for site in ("same-origin", "none", None):
            status, _headers, body = self.request("GET", f"/project?sample={self.sample}", headers={"Sec-Fetch-Site": site})
            self.assertEqual((status, body), (200, hub), site)
        # without a project in the address there is nothing to keep from anyone
        self.assertEqual(self.request("GET", "/project", headers={"Sec-Fetch-Site": "cross-site"})[0], 200)
        self.assertFalse(self.state.exists() or self.labels.exists(), "nothing was remembered or written")

    def test_another_sites_page_gets_none_of_the_tools_data(self):
        key = self.post("/api/project", {"path": "toy"})[1]["frames"]["thumb"]["key"]
        asked = ("/api/hub", "/api/config", "/api/config?ping=1", f"/api/thumb?key={key}", "/api/sets", "/api/labels/table-a")
        for site in ("cross-site", "same-site"):
            for path in asked:
                with self.subTest(site=site, path=path):
                    status, headers, body = self.request("GET", path, headers={"Sec-Fetch-Site": site})
                    self.assertEqual((status, json.loads(body)), (403, {"error": "this tool's data is for its own pages only"}))
                    self.assertNotIn("Access-Control-Allow-Origin", headers)
        for site in ("same-origin", "none", None):
            self.assertEqual(self.request("GET", "/api/hub", headers={"Sec-Fetch-Site": site})[0], 200, site)
            self.assertEqual(self.request("GET", f"/api/thumb?key={key}", headers={"Sec-Fetch-Site": site})[0], 200, site)
        # once a pass runs, its data is kept from other sites in the same way
        with contextlib.redirect_stdout(io.StringIO()):
            self.post("/api/open", {"path": "toy", "pass": "box", "role": "training"})
        for path in ("/api/sets", "/api/catalog", "/api/labels/table-a", "/api/prefill/table-a", "/api/config"):
            self.assertEqual(self.request("GET", path, headers={"Sec-Fetch-Site": "cross-site"})[0], 403, path)
            self.assertEqual(self.request("GET", path, headers={"Sec-Fetch-Site": "same-origin"})[0], 200, path)

    def test_looking_at_a_project_remembers_nothing(self):
        """What a page asks on arrival (the report, the start screen's facts, the picture) writes
        nothing: only a request a person causes does."""
        rep = self.post("/api/project", {"path": "toy", "role": "training", "locations": {"catalog": "elsewhere.json"}})[1]
        self.get("/api/hub")
        self.request("GET", f"/api/thumb?key={rep['frames']['thumb']['key']}")
        self.request("GET", f"/project?sample={self.sample}")
        self.assertFalse(self.state.exists() or self.labels.exists())
        self.assertEqual(pj.read_recent(), [])
        self.post("/api/remember", {"path": "toy"})
        self.assertEqual([e["sample"] for e in pj.read_recent()], [str(self.sample)])


# ---- a path from a request is checked before it is read ------------------------------------------

@unittest.skipUnless(hasattr(os, "mkfifo"), "needs named pipes")
class PathsFromRequests(Server):
    """A path a request names is read only when it is a regular file of a bounded size. A named
    pipe would hold a thread for good and a device would be read without end; every request here
    has ten seconds to answer, and none may wait."""

    def odd_things(self):
        pipe, folder, big = self.start / "pipe.json", self.start / "a-folder.json", self.start / "big-sample.json"
        os.mkfifo(pipe)
        folder.mkdir()
        big.write_text(self.sample.read_text() + " " * 5000)
        return (pipe, "not-file"), (folder, "no-sample-in-folder"), (Path("/dev/null"), "not-file"), (big, "too-big")

    def test_a_sample_that_is_no_file_or_too_large_is_not_read(self):
        with mock.patch.object(pj, "SAMPLE_BYTES", 4096):
            self.assertTrue(self.post("/api/project", {"path": "toy"})[1]["ok"], "the toy's own sample is small")
            for path, problem in self.odd_things():
                for route in ("/api/project", "/api/remember"):
                    with self.subTest(path=path.name, route=route):
                        self.assertEqual(self.post(route, {"path": str(path)}), (200, {"ok": False, "problem": problem, "path": str(path)}))
                with self.subTest(path=path.name, route="/api/open"):
                    self.assertEqual(self.post("/api/open", {"path": str(path), "pass": "box", "role": "training"}),
                                     (409, {"ok": False, "problem": problem, "path": str(path)}))
                self.assertEqual(pj.read_sample(path), (None, "not-file" if path.is_dir() else problem))
            self.assertFalse(serve.OPEN_LOCK.locked(), "no start is left waiting on a file")
            # the search for samples passes them by, and the list of projects opened before says they cannot be read
            self.assertEqual(self.get("/api/hub")[1]["found"], [pj.summary(self.sample)])
        self.assertTrue(self.post("/api/project", {"path": str(self.start / "big-sample.json")})[1]["ok"], "under the real limit it is a sample")
        self.assertFalse(self.state.exists() or self.labels.exists())

    def test_the_files_beside_a_sample_are_checked_the_same_way(self):
        """A catalog, a suggestions file, a project file, the list of projects, a deck list, a
        label file: a pipe at any of these names holds nothing up, and a start goes through or
        is refused with the reason."""
        pipe = self.start / "pipe"
        os.mkfifo(pipe)
        for key in ("catalog", "prefill"):
            for path, words in ((pipe, "it is not a file (a folder, a device or a pipe)"), (Path("/dev/null"), "it is not a file (a folder, a device or a pipe)"),
                                (self.toy / "art", "it is not a file (a folder, a device or a pipe)")):
                with self.subTest(key=key, path=path.name):
                    place = self.post("/api/project", {"path": "toy", "role": "training", "locations": {key: str(path)}})[1]["locations"][key]
                    self.assertEqual((place["state"], place["problem"]), ("unreadable", words))
        with mock.patch.object(pj, "SAMPLE_BYTES", self.sample.stat().st_size):  # the sample fits; the two larger files do not
            places = self.post("/api/project", {"path": "toy", "role": "training"})[1]["locations"]
            self.assertEqual({k: (places[k]["state"], places[k]["problem"]) for k in ("catalog", "prefill")},
                             {"catalog": ("unreadable", "it is larger than 20 MB"), "prefill": ("unreadable", "it is larger than 20 MB")})
        rep = self.post("/api/project", {"path": "toy", "role": "training", "locations": {"prefill": str(pipe), "catalog": str(pipe)}})[1]
        self.assertEqual((rep["passes"]["training"]["reason"], rep["passes"]["identify"]["reason"], rep["modelBoxes"]["offered"]), ("bad-suggestions", "bad-catalog", False))
        # pipes where the tool's own small files are looked for: the project file, the list of projects opened before
        self.labels.mkdir()
        os.mkfifo(self.labels / "labeler-project.json")
        self.state.mkdir()
        os.mkfifo(self.state / "recent.json")
        self.assertTrue(self.post("/api/project", {"path": "toy"})[1]["ok"])
        self.assertEqual(self.get("/api/hub")[1]["recent"], [])
        # and where a pass reads while it starts and runs: a deck list, a label file. The pass starts; the pipes are passed by
        for name in ("table-a.txt", "table-b.txt"):
            (self.toy / "decklists" / name).unlink(missing_ok=True)
            os.mkfifo(self.toy / "decklists" / name)
        (self.labels / "table-b").mkdir()
        os.mkfifo(self.labels / "table-b" / "frames.jsonl")
        os.mkfifo(self.labels / "table-b" / "meta.json")
        (self.labels / "labeler-project.json").unlink()
        (self.state / "recent.json").unlink()
        with contextlib.redirect_stdout(io.StringIO()):
            status, got = self.post("/api/open", {"path": "toy", "pass": "box", "role": "training"})
        self.assertEqual((status, got["ok"]), (200, True), got)
        sets = {s["setId"]: s["readOnly"] for s in self.get("/api/sets")[1]}
        self.assertIsNone(sets["table-a"])
        self.assertIn("it is not a file (a folder, a device or a pipe)", sets["table-b"])
        self.assertIsNone(self.get("/api/labels/table-a")[1]["decklist"], "a pipe is no deck list")
        self.assertEqual(self.post("/api/labels/table-a/frames/f00001.png", {"frame": frame(1, True, [box(1)])})[0], 200)

    def test_a_start_with_flags_reads_its_files_whatever_their_size(self):
        """The limit is for paths that requests name. A file named on the command line is read
        as before, so a session started with flags writes what it wrote before."""
        deck = self.toy / "decklists" / "table-a.txt"
        deck.parent.mkdir(exist_ok=True)
        deck.write_text("TOY-001\r\nTOY-002\r\n")
        argv = ["--mode", "box", "--role", "training", "--sample", str(self.sample), "--catalog", str(self.toy / "catalog.json")]
        with mock.patch.object(pj, "SAMPLE_BYTES", 10), mock.patch.object(serve.lf, "SAMPLE_BYTES", 10):
            serve.configure(serve.build_parser().parse_args(argv))
            self.assertIsNone(serve.CFG.byte_cap)
            self.assertEqual(len(serve.load_catalog()), 13)
            self.assertEqual([s["setId"] for s in serve.list_sets()], ["table-a", "table-b"])
            got = serve.decklist_for("table-a")
            self.assertEqual((got["ids"], got["sha1"]), (["TOY-001", "TOY-002"], __import__("hashlib").sha1(deck.read_text().encode()).hexdigest()),
                             "read as a text file was read before: the same text, the same fingerprint in meta.json")
            serve.CFG.__dict__.clear()
            # the same project started from the page: nothing over the limit is read
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(self.post("/api/open", {"path": "toy", "pass": "box", "role": "training"})[1]["problem"], "too-big")
        with mock.patch.object(pj, "SAMPLE_BYTES", 15), contextlib.redirect_stdout(io.StringIO()):
            deck.write_text("TOY-001\nTOY-002\nTOY-003\n")
            serve.configure(argparse_namespace(serve, argv, byte_cap=15, catalog=None))
            self.assertIsNone(serve.decklist_for("table-a"), "a deck list over the limit is passed by on a start from the page")


def argparse_namespace(module, argv, **more):
    args = module.build_parser().parse_args(argv)
    for key, value in more.items():
        setattr(args, key, value)
    return args


# ---- one run of the tool, one page ---------------------------------------------------------------

class Runs(Server):
    """Every save says which run of the tool its page was loaded from. A page of another run
    (the tool was stopped and started again, perhaps on a copy of the project, where every set
    id is the same) is refused, and nothing it sends is written."""

    def begin(self, project="toy", mode="box"):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.post("/api/open", {"path": project, "pass": mode, "role": "training", "modelBoxes": False})[0], 200)
        return self.get("/api/config")[1]

    def test_a_save_from_a_page_of_another_run_is_refused_and_writes_nothing(self):
        config = self.begin()
        self.assertEqual(config["run"], serve.RUN_ID)
        self.assertRegex(config["run"], r"^[0-9a-f]{16}$")
        saves = (("/api/labels/table-a/frames/f00001.png", {"frame": frame(1, True, [box(1)])}), ("/api/labels/table-a/meta", {"notes": "x"}),
                 ("/api/timing/table-a", {"events": [{"ev": "session-open"}]}), ("/api/verify-reveal/table-a", {"frame": "f00001.png", "center": "C001"}))
        for path, body in saves:
            for run in (False, "0123456789abcdef", "", None, 7):
                with self.subTest(path=path, run=run):
                    status, got = self.post(path, body, run=run)
                    self.assertEqual((status, got["problem"]), (409, "other-run"))
                    self.assertIn("started again", got["error"])
        self.assertEqual(sorted(p.name for p in self.labels.iterdir()), ["labeler-project.json"], "no label file was written")
        for path, body in saves[:3]:
            self.assertEqual(self.post(path, body)[0], 200, path)
        self.assertEqual(self.post(*saves[3])[0], 404, "this run's own page gets the route's own answer (no verify pass runs here)")

    def test_a_restart_on_a_copy_of_the_project_cannot_be_written_into_by_the_old_page(self):
        """The case the identity is for: `toy` and its copy `toy-2` have the same set ids, the
        same pass and the same purpose. The page of the first run must not save into the second."""
        shutil.copytree(self.toy, self.start / "toy-2")
        first = self.begin()
        row = {"frame": frame(1, True, [box(1)])}
        self.assertEqual(self.post("/api/labels/table-a/frames/f00001.png", row, run=first["run"])[0], 200)
        # the tool is stopped and started again, on the copy
        serve.CFG.__dict__.clear()
        with mock.patch.object(serve, "RUN_ID", "feedfacefeedface"):
            second = self.begin("toy-2")
            self.assertEqual((second["run"], second["mode"], second["role"]), ("feedfacefeedface", first["mode"], first["role"]))
            self.assertNotEqual(second["project"], first["project"], "the page can tell that this is other work")
            status, got = self.post("/api/labels/table-a/frames/f00001.png", row, run=first["run"])
            self.assertEqual((status, got["problem"]), (409, "other-run"))
            self.assertFalse((self.start / "toy-2" / "labels" / "table-a").exists(), "nothing of the old page reached the copy")
            self.assertEqual(self.post("/api/labels/table-a/frames/f00001.png", row, run="feedfacefeedface")[0], 200)

    def test_the_same_work_started_again_has_the_same_key_and_other_work_another(self):
        key = self.begin()["project"]
        self.assertRegex(key, r"^[0-9a-f]{16}$")
        self.assertNotIn(str(self.toy), json.dumps(self.get("/api/config")[1]["project"]), "no path is given away")
        argv = ["--mode", "box", "--role", "training", "--sample", str(self.sample)]
        seen = {}
        for name, more in (("again", []), ("other labels", ["--labels-dir", str(self.tmp / "elsewhere")]), ("other pass", None), ("other purpose", None)):
            serve.CFG.__dict__.clear()
            words = list(argv) + (more or [])
            if name == "other pass":
                words[1] = "corner"
            if name == "other purpose":
                words[3] = "test"
            serve.configure(serve.build_parser().parse_args(words))
            seen[name] = serve.project_key()
        self.assertEqual(seen["again"], key)
        self.assertEqual(len({key, seen["other labels"], seen["other pass"], seen["other purpose"]}), 4)


# ---- a frame is saved only once its picture has loaded -------------------------------------------

class FrameSize(Server):
    def test_a_pass_that_draws_refuses_a_row_without_the_frames_size(self):
        """The page learns a frame's size from its picture, so a row without one comes from a
        frame whose picture did not load. Every drawing pass refuses it."""
        point = {"i": 0, "x": 0.5, "y": 0.5, "outcome": "not-card", "eligible": "no"}
        quad = dict(box(1), cornerSource="hand", identity="TOY-001", eligible="yes")
        rows = {"box": {"targets": [box(1)]}, "corner": {"targets": [quad]}, "training": {"targets": [quad]}, "point": {"points": [point]},
                "center": {"centers": [], "centerSeq": 0}}
        for mode, content in rows.items():
            role = "training" if mode in ("box", "training") else "development"
            serve.CFG.__dict__.clear()
            argv = ["--mode", mode, "--role", role, "--sample", str(self.sample), "--labels-dir", str(self.tmp / f"labels-{mode}")]
            serve.configure(serve.build_parser().parse_args(argv + (["--prefill", str(self.toy / "prefill.jsonl")] if mode == "training" else [])))
            for size in ({}, {"frameW": 960}, {"frameH": 540}, {"frameW": 0, "frameH": 0}, {"frameW": "960", "frameH": "540"}, {"frameW": None, "frameH": None}):
                with self.subTest(mode=mode, size=size):
                    status, got = self.post("/api/labels/table-a/frames/f00001.png", {"frame": {"name": "f00001.png", "t": 0.0, "done": True, **content, **size}})
                    self.assertEqual(status, 400, got)
                    self.assertRegex(got["error"], "frame[WH]")
            self.assertFalse((self.tmp / f"labels-{mode}").exists(), "nothing was written")
            status, got = self.post("/api/labels/table-a/frames/f00001.png",
                                    {"frame": {"name": "f00001.png", "t": 0.0, "done": True, **content, "frameW": 960, "frameH": 540}})
            self.assertEqual(status, 200, (mode, got))

    def test_the_names_pass_still_answers_a_stored_row_that_has_no_size(self):
        """Nothing valid is refused: a row another program wrote without a size is stored
        already, and the Names pass only answers it."""
        row = frame(1, True, [box(1)])
        del row["frameW"], row["frameH"]
        write_set(self.labels, "table-a", [row])
        serve.configure(serve.build_parser().parse_args(["--mode", "identify", "--role", "training", "--sample", str(self.sample),
                                                         "--catalog", str(self.toy / "catalog.json")]))
        named = dict(row, targets=[box(1, identity="TOY-001", identitySource="current-frame", eligible="yes")])
        status, got = self.post("/api/labels/table-a/frames/f00001.png", {"frame": named})
        self.assertEqual((status, got["frame"]["targets"][0]["identity"]), (200, "TOY-001"), got)
        self.assertEqual(lc.frame_size_errors({"frameW": 960, "frameH": 540}), [])
        self.assertTrue(lc.frame_size_errors({"frameW": True, "frameH": 540}))
        self.assertEqual(lc.validate_frame(row, "box", "training"), [], "a stored row without a size still reads as valid: the export takes it")


# ---- a start from the page: whose flags, what on failure, what is remembered ---------------------

class StartsFromThePage(Server):
    def started_on(self, *argv):
        """As `python3 serve.py ARGV` leaves things, for a start without --mode."""
        with _chdir(self.start):
            args = serve.build_parser().parse_args(list(argv))
            serve.HUB.args, serve.HUB.project = args, serve._named_project(args)
            serve.HUB.flags = serve._hub_flags(args)
            serve.HUB.command = {"prefix": ["python3", "labeler/serve.py"], "tail": [], "cwd": str(self.start)}

    def open(self, **body):
        with contextlib.redirect_stdout(io.StringIO()):
            return self.post("/api/open", body)

    def test_flags_given_at_start_belong_to_the_project_named_at_start(self):
        shutil.copytree(self.toy, self.start / "toy-2")
        (self.start / "a-deck.txt").write_text("TOY-001\nTOY-002\n")
        self.started_on("toy", "--role", "training", "--decklist", "a-deck.txt", "--zoom", "5", "--snap", "on", "--k", "7", "--seed", "3")
        # another project opened on the page gets none of them
        self.assertEqual(self.open(path="toy-2", **{"pass": "box"}, role="training")[0], 200)
        cfg = serve.CFG
        self.assertEqual((cfg.sample, cfg.zoom, cfg.snap, cfg.k, cfg.seed, cfg.decklists),
                         (self.start / "toy-2" / "sample.json", lc.DEFAULT_ZOOM, False, lc.DEFAULT_K, 1, {}))
        status, got = self.post("/api/labels/table-a/frames/f00001.png", {"frame": frame(1, True, [box(1)])})
        self.assertEqual(status, 200, got)
        meta = json.loads((self.start / "toy-2" / "labels" / "table-a" / "meta.json").read_text())
        self.assertEqual((meta["zoom"], meta["decklist"]["file"]), (3.0, "table-a.txt"), "its own zoom and its own deck list, not the other project's")
        self.assertNotIn("--zoom", self.get("/api/config")[1]["launch"])
        # the project named at start gets all of them
        serve.CFG.__dict__.clear()
        status, got = self.open(**{"pass": "box"})
        self.assertEqual(status, 200, got)
        cfg = serve.CFG
        self.assertEqual((cfg.sample, cfg.zoom, cfg.snap, cfg.k, cfg.seed, cfg.decklists), (self.sample, 5.0, True, 7, 3, {"*": [self.start / "a-deck.txt"]}))

    def test_the_command_the_page_shows_starts_the_same_run(self):
        """`launch` and "the same start as one command" say every setting the run has, so the
        tool started again with that command is configured exactly as the page started it."""
        (self.start / "a deck.txt").write_text("TOY-001\n")
        (self.start / "b.txt").write_text("TOY-002\n")
        self.started_on("toy", "--role", "training", "--decklist", "a deck.txt", "--decklist", "table-b=b.txt", "--zoom", "2.5", "--snap", "on", "--k", "7", "--seed", "3")
        shown = self.post("/api/project", {})[1]["passes"]
        self.assertIn("--decklist 'a deck.txt' --decklist table-b=b.txt --zoom 2.5 --snap on --k 7 --seed 3", shown["box"]["command"]["text"])
        point = shown["point"]["command"]
        self.assertEqual([(part["t"], part["fill"]) for part in point["parts"] if part["t"] in ("7", "3")], [("7", False), ("3", False)], "given at start: not for the person to fill in")
        self.assertEqual(self.open(**{"pass": "box"})[0], 200)
        launch = self.get("/api/config")[1]["launch"]
        page_started = dict(serve.CFG.__dict__)
        handoff = self.post("/api/project", {})[1]["passes"]["identify"]["command"]["argv"]
        self.assertEqual(handoff[handoff.index("--decklist"):handoff.index("--seed") + 2], launch[launch.index("--decklist"):launch.index("--seed") + 2],
                         "the command of every other pass keeps the settings too")
        serve.CFG.__dict__.clear()
        with _chdir(self.start):
            serve.configure(serve.build_parser().parse_args(launch[2:]))
        again = dict(serve.CFG.__dict__)
        for key in ("launch", "byte_cap"):  # how each was started, and the limit a start from the page has
            page_started.pop(key, None), again.pop(key, None)
        self.assertEqual(again, page_started)
        self.assertEqual((again["zoom"], again["snap"], again["k"], again["seed"], again["decklists"]),
                         (2.5, True, 7, 3, {"*": [self.start / "a deck.txt"], "table-b": [self.start / "b.txt"]}))
        # a run with the defaults says none of them
        serve.CFG.__dict__.clear()
        serve.HUB.args, serve.HUB.project, serve.HUB.flags = None, None, {}
        self.assertEqual(self.open(path="toy", **{"pass": "box"}, role="training")[0], 200)
        self.assertEqual([w for w in self.get("/api/config")[1]["launch"] if w in ("--decklist", "--zoom", "--snap", "--k", "--seed")], [])

    def test_a_start_that_fails_half_way_leaves_no_pass_whatever_stopped_it(self):
        """Not only the refusals the tool words itself (SystemExit, ValueError): any failure
        after the first settings were written leaves the tool as it was, and it says so."""
        for fault in (RuntimeError("boom"), OSError(5, "Input/output error"), KeyError("art"), SystemExit("--art: not a folder"), ValueError("bad")):
            with self.subTest(fault=type(fault).__name__):
                with mock.patch.object(serve, "_resolve_art", side_effect=fault), contextlib.redirect_stderr(io.StringIO()) as said:
                    status, got = self.open(path="toy", **{"pass": "box"}, role="training")
                expected = isinstance(fault, (SystemExit, ValueError))
                self.assertEqual((status, got["ok"], got["problem"]), (409 if expected else 500, False, "refused"), got)
                self.assertIn(str(fault.args[-1]), got["detail"])
                self.assertEqual("Traceback" in said.getvalue(), not expected, "a fault of the tool is shown in the terminal")
                self.assertFalse(serve.ready())
                self.assertEqual((serve.CFG.sample, serve.CFG.labels_dir, serve.CFG.mode, serve.HUB.configuring), (None, None, "point", False))
                self.assertEqual(serve.CFG.__dict__, {})
                self.assertEqual(self.get("/api/config")[1]["mode"], None)
                self.assertEqual(self.get("/api/sets"), (409, {"error": serve.NO_PASS}))
                self.assertEqual(self.request("GET", "/")[2], (HERE / "hub.html").read_bytes())
                self.assertFalse(serve.OPEN_LOCK.locked())
        self.assertEqual(self.open(path="toy", **{"pass": "box"}, role="training")[0], 200, "and it can still be started")

    def test_configure_puts_everything_back_when_it_is_stopped(self):
        """`configure` itself: a run that is configured stays exactly as it was when a second
        configuration is stopped, by anything, at any point after its first setting."""
        serve.configure(serve.build_parser().parse_args(["--mode", "box", "--role", "training", "--sample", str(self.sample), "--zoom", "2"]))
        before = dict(serve.CFG.__dict__)
        other = serve.build_parser().parse_args(["--mode", "center", "--role", "test", "--sample", str(self.sample), "--labels-dir", str(self.tmp / "x")])
        for where, fault in (("_resolve_art", KeyboardInterrupt()), ("_parse_mapping", MemoryError()), ("_resolve_art", SystemExit("no"))):
            with self.subTest(where=where, fault=type(fault).__name__):
                seen = {}

                def stop(*a, _fault=fault, **kw):
                    seen.update(sample=serve.CFG.sample, mode=serve.CFG.mode, ready=serve.ready())
                    raise _fault
                with mock.patch.object(serve, where, side_effect=stop), self.assertRaises(type(fault)):
                    serve.configure(other)
                self.assertFalse(seen["ready"], "while it is being configured the server reports no pass")
                self.assertEqual(serve.CFG.__dict__, before)
                self.assertTrue(serve.ready())

    def test_a_start_that_is_refused_is_not_remembered(self):
        for body in ({"path": "toy", "pass": "identify", "role": "training"}, {"path": "toy", "pass": "box"}, {"path": "toy", "pass": "bogus", "role": "test"}):
            self.assertEqual(self.open(**body)[0], 409)
        with mock.patch.object(serve, "_resolve_art", side_effect=SystemExit("--art: gone")):
            self.assertEqual(self.open(path="toy", **{"pass": "box"}, role="development")[1]["problem"], "refused")
        with mock.patch.object(serve, "_resolve_art", side_effect=RuntimeError("boom")), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.open(path="toy", **{"pass": "box"}, role="development")[0], 500)
        self.assertEqual(pj.read_recent(), [], "not in the list of projects opened before")
        self.assertFalse(self.state.exists() or self.labels.exists(), "and nothing was written into its labels folder")
        self.assertIsNone(self.get("/api/hub")[1]["resume"])
        # the start that works is remembered, with what it was started with
        status, got = self.open(path="toy", **{"pass": "box"}, role="development")
        self.assertEqual((status, got["remembered"]["recent"], got["remembered"]["projectFile"]), (200, True, str(self.labels / "labeler-project.json")))
        self.assertEqual([e["sample"] for e in pj.read_recent()], [str(self.sample)])
        self.assertEqual(json.loads((self.labels / "labeler-project.json").read_text())["role"], "development")

    def test_one_start_at_a_time(self):
        """Many pages ask for a start at the same moment, for different projects and passes.
        One start is configured at a time, exactly one wins, and what runs afterwards is one
        project's pass in full: never one project's sample with another's labels folder."""
        shutil.copytree(self.toy, self.start / "toy-2")
        inside, most, lock = [0], [0], threading.Lock()
        real = serve._configure

        def slow(args):
            with lock:
                inside[0] += 1
                most[0] = max(most[0], inside[0])
            try:
                threading.Event().wait(0.02)  # room for another start to come in, were it let in
                real(args)
                threading.Event().wait(0.02)
            finally:
                with lock:
                    inside[0] -= 1

        asks = [{"path": "toy", "pass": "box", "role": "training"}, {"path": "toy-2", "pass": "corner", "role": "training"},
                {"path": "toy-2", "pass": "box", "role": "training", "locations": {"labels": str(self.tmp / "other-labels")}},
                {"path": "toy", "pass": "training", "role": "training"}] * 4
        answers, gate = [], threading.Barrier(len(asks))

        def ask(body):
            gate.wait()
            answers.append((body, *self.post("/api/open", body)))

        with mock.patch.object(serve, "_configure", side_effect=slow), contextlib.redirect_stdout(io.StringIO()):
            threads = [threading.Thread(target=ask, args=(body,)) for body in asks]
            for t in threads:
                t.start()
            for t in threads:
                t.join(30)
        self.assertEqual(len(answers), len(asks))
        self.assertEqual(most[0], 1, "two starts were being configured at the same time")
        won = [(body, got) for body, status, got in answers if status == 200 and not got.get("already")]
        self.assertEqual(len(won), 1, "exactly one start configures the tool")
        body = won[0][0]
        project = self.start / body["path"]
        cfg = serve.CFG
        self.assertEqual((cfg.sample, cfg.mode, cfg.labels_dir, cfg.frames_dir, cfg.catalog),
                         (project / "sample.json", body["pass"], Path(body.get("locations", {}).get("labels", project / "labels")), project / "frames", project / "catalog.json"))
        for other, status, got in answers:
            same = (other["path"], other["pass"], other.get("locations")) == (body["path"], body["pass"], body.get("locations"))
            self.assertEqual((status, got.get("already", False) or got is won[0][1]) if same else (status, got.get("problem")), (200, True) if same else (409, "running"), other)
        self.assertEqual([e["sample"] for e in pj.read_recent()], [str(project / "sample.json")], "only the start that ran is remembered")

    def test_the_toy_example_is_made_once_however_many_ask(self):
        target = str(self.start / "toy-2")
        answers, gate = [], threading.Barrier(8)

        def ask():
            gate.wait()
            answers.append(self.post("/api/toy", {"path": target}))

        threads = [threading.Thread(target=ask) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        self.assertEqual(sorted(status for status, _got in answers), [200] + [409] * 7)
        self.assertEqual(sorted(p.name for p in self.start.iterdir()), ["toy", "toy-2"])


# ---- a switch to another pass, from the page, with no new start of the tool -----------------------

class Switching(Server):
    """The page switches the running tool to another pass, of this project or of another, with no
    new start: only from a page of this run, never while a save is in progress or a page says it
    holds unsaved changes, configured while no other request is answered, and as a new run."""

    def begin(self, body=None):
        with contextlib.redirect_stdout(io.StringIO()):
            status, got = self.post("/api/open", body or {"path": "toy", "pass": "box", "role": "training", "modelBoxes": False})
        self.assertEqual(status, 200, got)
        return self.get("/api/config")[1]

    def boxed(self):
        for n in range(1, 6):
            for video in ("table-a", "table-b"):
                status, got = self.post(f"/api/labels/{video}/frames/f{n:05d}.png", {"frame": dict(frame(n, True, [box(1)]), name=f"f{n:05d}.png")})
                self.assertEqual(status, 200, got)

    def switch(self, **body):
        body = {"run": serve.RUN_ID, "unsaved": 0, "path": "toy", **body}
        said = io.StringIO()
        with contextlib.redirect_stdout(said):
            status, got = self.post("/api/switch", body)
        return status, got, said.getvalue()

    def setUp(self):
        super().setUp()
        self.addCleanup(lambda: serve.SAVES.tabs.clear())

    def test_the_next_pass_without_a_new_start(self):
        before = self.begin()
        self.boxed()
        status, got, said = self.switch(**{"pass": "identify"})
        self.assertEqual((status, got["ok"]), (200, True), got)
        after = self.get("/api/config")[1]
        self.assertEqual((after["mode"], after["role"]), ("identify", "training"))
        self.assertEqual(got["run"], after["run"])
        self.assertNotEqual(after["run"], before["run"], "a switch is a new run")
        self.assertNotEqual(after["project"], before["project"], "and other work: every other page follows the rules of a new start")
        self.assertEqual(said.splitlines(), [f"labeling tool: switched to mode=identify role=training · {self.sample} · labels {self.labels}"], "one line in the terminal")
        self.assertEqual(self.request("GET", "/")[2], (HERE / "index.html").read_bytes())
        self.assertEqual((serve.CFG.catalog, serve.CFG.art, serve.CFG.prefills), (self.toy / "catalog.json", self.toy / "art", {}))
        self.assertEqual(after["launch"][2:4], ["--mode", "identify"], "what a start with flags would say")
        # a save from a page of the run before is refused, and writes nothing
        row = {"frame": dict(frame(1, True, [box(1, **NAMED)]))}
        status, got = self.post("/api/labels/table-a/frames/f00001.png", row, run=before["run"])
        self.assertEqual((status, got["problem"]), (409, "other-run"))
        self.assertNotIn("TOY-001", (self.labels / "table-a" / "frames.jsonl").read_text())
        self.assertEqual(self.post("/api/labels/table-a/frames/f00001.png", row)[0], 200, "the page of the new run saves")
        # the pass that runs answers "already"; the pass before can be switched back to
        self.assertEqual(self.switch(**{"pass": "identify"})[:2], (200, {"ok": True, "already": True}))
        self.assertEqual(self.switch(**{"pass": "box"})[0], 200)
        self.assertEqual(self.get("/api/config")[1]["project"], before["project"], "back to the same work: the same key, so a page of it goes on")

    def test_a_switch_is_refused_while_work_could_be_lost(self):
        config = self.begin()
        self.boxed()
        run = config["run"]
        cases = [({"run": "0123456789abcdef"}, "other-run"), ({"run": None}, "other-run"), ({"unsaved": 1}, "unsaved"),
                 ({"unsaved": None}, "unsaved"), ({"unsaved": True}, "unsaved"), ({"unsaved": "0"}, "unsaved")]
        for extra, problem in cases:
            with self.subTest(extra=extra):
                body = {"run": run, "unsaved": 0, "path": "toy", "pass": "identify", **extra}
                if extra.get("unsaved") is None and "unsaved" in extra:
                    body.pop("unsaved")
                status, got = self.post("/api/switch", body)
                self.assertEqual((status, got["problem"]), (409, problem))
        # another page of this run says it holds unsaved changes: refused; the asking page's own
        # report does not count, a report older than a few seconds neither, nor one of another run
        self.assertEqual(self.post("/api/tabs", {"run": run, "tab": "other", "unsaved": 2}), (200, {"ok": True}))
        self.assertEqual(self.post("/api/tabs", {"run": run, "tab": "mine", "unsaved": 1}), (200, {"ok": True}))
        status, got, _said = self.switch(**{"pass": "identify", "tab": "mine"})
        self.assertEqual((status, got), (409, {"ok": False, "problem": "busy", "saving": 0, "pages": 1}))
        self.post("/api/tabs", {"run": run, "tab": "other", "unsaved": 0})
        serve.SAVES.tabs["old"] = {"run": run, "unsaved": 3, "at": 0.0}
        serve.SAVES.tabs["gone"] = {"run": "0123456789abcdef", "unsaved": 3, "at": 9e12}
        # a save in progress: refused
        with mock.patch.object(serve.SAVES, "in_flight", 1):
            status, got, _said = self.switch(**{"pass": "identify", "tab": "mine"})
        self.assertEqual((status, got["problem"], got["saving"]), (409, "busy", 1))
        self.assertEqual((serve.CFG.mode, serve.RUN_ID), ("box", run), "nothing changed")
        # the new pass cannot start: refused, and the tool runs on exactly as it was
        before = dict(serve.CFG.__dict__)
        with mock.patch.object(serve, "_resolve_art", side_effect=SystemExit("--art: gone")):
            status, got, _said = self.switch(**{"pass": "identify", "tab": "mine"})
        self.assertEqual((status, got["problem"], got["detail"]), (409, "refused", "--art: gone"))
        self.assertEqual((dict(serve.CFG.__dict__), serve.RUN_ID, serve.ready()), (before, run, True))
        self.assertEqual(self.switch(**{"pass": "verify", "tab": "mine"})[1]["problem"], "not-for-training")
        self.assertEqual(self.switch(**{"pass": "bogus", "tab": "mine"})[1]["problem"], "not-offered")
        self.assertEqual(self.switch(path="nowhere", **{"pass": "box", "tab": "mine"})[1]["problem"], "missing")
        # and with nothing in the way it switches
        self.assertEqual(self.switch(**{"pass": "identify", "tab": "mine"})[0], 200)

    def test_a_switch_needs_a_running_pass_and_answers_only_a_page_of_this_run(self):
        self.assertEqual(self.post("/api/switch", {"run": serve.RUN_ID, "unsaved": 0, "path": "toy", "pass": "box", "role": "training"}),
                         (409, {"ok": False, "problem": "no-pass"}), "the first pass is a start (/api/open)")
        for body in ({"run": serve.RUN_ID, "tab": "x" * 65, "unsaved": 0}, {"run": serve.RUN_ID, "tab": "a b", "unsaved": 0},
                     {"run": serve.RUN_ID, "tab": "t", "unsaved": -1}, {"run": serve.RUN_ID, "tab": "t", "unsaved": True}, {"run": serve.RUN_ID, "tab": "t"}):
            self.assertEqual(self.post("/api/tabs", body)[0], 400, body)
        self.assertEqual(self.post("/api/tabs", {"run": "0123456789abcdef", "tab": "t", "unsaved": 1})[1]["problem"], "other-run")
        self.assertEqual(serve.SAVES.tabs, {}, "nothing was taken from a page of another run")

    def test_no_request_sees_a_pass_half_switched(self):
        """While the new pass is configured no other request is answered: a page asking meanwhile
        gets the pass before or the pass after, never a tool with no pass."""
        self.begin()
        self.boxed()
        real, seen, started = serve._configure, [], threading.Event()

        def slow(args):
            started.set()
            threading.Event().wait(0.3)
            real(args)

        def ask():
            started.wait(5)
            seen.append(self.get("/api/config")[1]["mode"])

        asker = threading.Thread(target=ask)
        asker.start()
        with mock.patch.object(serve, "_configure", side_effect=slow):
            self.assertEqual(self.switch(**{"pass": "identify"})[0], 200)
        asker.join(10)
        self.assertEqual(seen, ["identify"], "the question waited for the switch")

    def test_a_switch_and_a_request_that_holds_the_start_lock_both_finish(self):
        """The toy example (and a start) hold the start lock inside a request; a switch waits for
        every request. The two never wait for each other for good."""
        self.begin()
        self.boxed()
        real, inside = make_toy_data.build, threading.Event()

        def slow(folder, *a, **kw):
            inside.set()
            threading.Event().wait(0.4)
            return real(folder, *a, **kw)

        answers = []
        with mock.patch.object(serve.make_toy_data, "build", side_effect=slow):
            toy = threading.Thread(target=lambda: answers.append(self.post("/api/toy", {"path": self.get("/api/hub")[1]["toy"]["path"]})[0]))
            toy.start()
            inside.wait(5)
            switched = self.switch(**{"pass": "identify"})[0]
            toy.join(10)
        self.assertEqual((answers, switched, toy.is_alive()), ([200], 200, False))

    def test_switch_to_another_project_and_back_flags_stay_with_theirs(self):
        shutil.copytree(self.toy, self.start / "toy-2")
        with _chdir(self.start):
            args = serve.build_parser().parse_args(["toy", "--role", "training", "--zoom", "5", "--snap", "on"])
            serve.HUB.args, serve.HUB.project = args, serve._named_project(args)
            serve.HUB.flags = serve._hub_flags(args)
        self.begin({"pass": "box"})
        self.assertEqual((serve.CFG.zoom, serve.CFG.snap), (5.0, True))
        self.assertEqual(self.switch(path="toy-2", role="training", **{"pass": "box"})[0], 200)
        self.assertEqual((serve.CFG.sample, serve.CFG.zoom, serve.CFG.snap), (self.start / "toy-2" / "sample.json", lc.DEFAULT_ZOOM, False))
        self.assertEqual(self.switch(path="toy", **{"pass": "box"})[0], 200)
        self.assertEqual((serve.CFG.sample, serve.CFG.zoom, serve.CFG.snap), (self.sample, 5.0, True), "the project named at start gets its flags again")

    def test_a_run_started_with_flags_may_switch(self):
        argv = ["--mode", "box", "--role", "training", "--sample", str(self.sample), "--catalog", str(self.toy / "catalog.json"), "--zoom", "4"]
        args = serve.build_parser().parse_args(argv)
        serve.configure(args)
        serve.adopt_flag_start(args)
        self.boxed()
        status, got, _said = self.switch(path=str(self.sample), **{"pass": "identify"})
        self.assertEqual(status, 200, got)
        self.assertEqual((serve.CFG.mode, serve.CFG.zoom, serve.CFG.catalog, serve.CFG.art), ("identify", 4.0, self.toy / "catalog.json", None),
                         "its flags keep applying to its project; what it was started without stays without")
        shutil.copytree(self.toy, self.start / "toy-2")
        self.assertEqual(self.switch(path=str(self.start / "toy-2"), role="training", **{"pass": "box"})[0], 200)
        self.assertEqual(serve.CFG.zoom, lc.DEFAULT_ZOOM, "another project gets none of them")

    def test_check_names_from_the_page_names_with_no_proposal(self):
        self.begin({"path": "toy", "pass": "center", "role": "development"})
        status, got = self.post("/api/labels/table-a/frames/f00001.png",
                                {"frame": {**{k: v for k, v in frame(1, True).items() if k != "targets"}, "centers": [{"id": "C001", "x": 0.5, "y": 0.5, "kind": "face"}], "centerSeq": 1}})
        self.assertEqual(status, 200, got)
        status, got, _said = self.switch(**{"pass": "verify"})
        self.assertEqual(status, 200, got)
        config = self.get("/api/config")[1]
        self.assertEqual((config["mode"], config["role"], config["verify"]["allBlind"], config["verify"]["arms"]), ("verify", "development", True, []))
        self.assertEqual(config["launch"][-1], "--all-blind", "the command for scripts says the same")


class ExportFromThePage(Server):
    """The Export row writes the file from the page, as export.py would; it asks before it
    replaces a file, and a manifest it cannot write says what is missing, each with a code."""

    def export(self, **body):
        return self.post("/api/export", {"run": serve.RUN_ID, "path": "toy", **body})

    def test_the_boxes_for_training(self):
        self.assertEqual(self.export(kind="coco")[1]["problem"], "nothing", "no labels yet")
        write_set(self.labels, "table-a", [frame(n, True, [box(1, **NAMED), box(2, ignore=True)]) for n in range(1, 4)] + [frame(4, False, [box(1)])])
        status, got = self.export(kind="coco")
        out = self.toy / "boxes.json"
        self.assertEqual((status, got["ok"], got["out"], got["frames"], got["boxes"], got["ignored"], got["sets"]), (200, True, str(out), 3, 6, 3, 1), got)
        doc = json.loads(out.read_text())
        self.assertEqual(doc, {**export.to_coco(export.read_sets(self.labels)[0], export.card_names(self.toy / "catalog.json")), "info": doc["info"]},
                         "what export.py coco writes")
        # it asks before it replaces the file
        out.write_text("mine")
        self.assertEqual(self.export(kind="coco"), (409, {"ok": False, "problem": "exists", "out": str(out)}))
        self.assertEqual(out.read_text(), "mine")
        self.assertEqual(self.export(kind="coco", replace="yes")[1]["problem"], "exists", "only a plain true replaces")
        self.assertEqual(self.export(kind="coco", replace=True)[0], 200)
        self.assertNotEqual(out.read_text(), "mine")
        # a page of another run, an unknown kind, a path that is no project
        self.assertEqual(self.post("/api/export", {"run": "0123456789abcdef", "path": "toy", "kind": "coco"})[1]["problem"], "other-run")
        self.assertEqual(self.export(kind="yaml")[0], 400)
        self.assertEqual(self.export(kind="coco", path="nowhere")[1]["problem"], "missing")

    def test_the_manifest_for_measuring(self):
        centers = [{"id": "C001", "kind": "face", "x": 0.25, "y": 0.5, "verifiedBy": "unknown", "identity": "unknown", "eligible": "no", "blind": True,
                    "verifiedAt": {"x": 0.25, "y": 0.5, "armsManifestSha256": "all-blind"}}, {"id": "C002", "kind": "back", "x": 0.5, "y": 0.5}]
        write_set(self.labels, "table-a", [frame(n, True, centers=centers) for n in range(1, 4)], mode="center", role="development")
        out = self.toy / "manifest" / "labels.manifest.jsonl"
        status, got = self.export(kind="manifest", credit="")
        self.assertEqual((status, got["problem"], [p["code"] for p in got["problems"]]), (409, "refused", ["credit"]))
        status, got = self.export(kind="manifest", credit="Toy Labeler")
        self.assertEqual(sorted({p["code"] for p in got["problems"]}), ["source-type"], "the census has no recording tags")
        status, got = self.export(kind="manifest", credit="Toy Labeler", sourceType="physical/webcam")
        self.assertEqual(({p["code"] for p in got["problems"]}, got["problems"][0]["where"]), ({"address"}, "table-a/f00001.png"), "the toy sample says no platform")
        self.assertFalse(out.exists(), "nothing written while anything is refused")
        sample = json.loads(self.sample.read_text())
        for asset in sample["assets"]:
            asset.update(platform="local", videoId=asset["assetId"])
        self.sample.write_text(json.dumps(sample))
        status, got = self.export(kind="manifest", credit="Toy Labeler", sourceType="physical/webcam")
        self.assertEqual((status, got["ok"], got["out"], got["frames"], got["boxes"], got["points"], got["ownRecording"]), (200, True, str(out), 3, 0, 6, True), got)
        rows = [json.loads(line) for line in out.read_text().splitlines()]
        self.assertEqual([(r["completeness"], r["source_type"], r["credit"], len(r["points"])) for r in rows], [("points", "physical/webcam", "Toy Labeler", 2)] * 3)
        self.assertEqual(self.export(kind="manifest", credit="Toy Labeler", sourceType="physical/webcam")[1]["problem"], "exists")

    def test_the_guide_the_screens_link_to(self):
        status, headers, body = self.request("GET", "/guide")
        self.assertEqual((status, headers["Content-Type"]), (200, "text/plain; charset=utf-8"))
        self.assertEqual(body, (HERE / "README.md").read_bytes())


class InThisCheckout(Server):
    """Started in a checkout of this repository, the tool makes the toy example under work/,
    which git ignores, so that nothing it makes shows up among the repository's files."""

    def test_the_toy_example_goes_under_work(self):
        (self.start / "labeler").mkdir()
        (self.start / "labeler" / "serve.py").write_text("")
        (self.start / ".git").mkdir()
        facts = self.get("/api/hub")[1]
        self.assertEqual(facts["toy"], {"path": str(self.start / "work" / "toy"), "state": "ok"}, "shown before it is written")
        status, got = self.post("/api/toy", {"path": facts["toy"]["path"]})
        self.assertEqual((status, got["folder"]), (200, str(self.start / "work" / "toy")))
        self.assertTrue((self.start / "work" / "toy" / "sample.json").is_file())
        self.assertEqual(self.get("/api/hub")[1]["toy"]["path"], str(self.start / "work" / "toy-2"))
        self.assertIn("work/", (HERE.parent / ".gitignore").read_text().splitlines(), "and git ignores work/ at the repository's root")
        # anywhere else, the folder the tool was started in
        shutil.rmtree(self.start / ".git")
        self.assertEqual(self.get("/api/hub")[1]["toy"]["path"], str(self.start / "toy-2"))


# ---- one reader: the project screen, the labeling page and the export say the same ---------------

class OneReader(Server):
    """What a sample lists and what a label set holds is read by one reader (labelfiles.py), so
    the project screen, the labeling page and the export cannot disagree."""

    def page(self, mode="box", role="training", **more):
        serve.CFG.__dict__.clear()
        serve.configure(serve.build_parser().parse_args(["--mode", mode, "--role", role, "--sample", str(more.get("sample", self.sample))]))
        return serve.list_sets()

    def exported(self):
        with contextlib.redirect_stdout(io.StringIO()):
            sets, notes = export.read_sets(self.labels)
        return export.to_coco(sets), notes

    def test_a_label_line_that_cannot_be_read_is_said_with_its_file_and_line_and_written_over_nowhere(self):
        write_set(self.labels, "table-a", [frame(1, True, [box(1)]), frame(2, True, [box(1)]), frame(3, True, [box(1)])])
        write_set(self.labels, "table-b", [frame(1, True, [box(1)])])
        path = self.labels / "table-a" / "frames.jsonl"
        lines = path.read_text().splitlines()
        path.write_text(lines[0] + "\n" + lines[1][:40] + "\n" + lines[2] + "\n[1, 2]\n")  # line 2 cut short, line 4 no frame row
        before = path.read_bytes()
        damage = [{"file": str(path), "line": 2, "problem": "not JSON"}, {"file": str(path), "line": 4, "problem": "not a JSON object"}]
        self.assertEqual(lf.read_label_set(path.parent)[1].damage, damage)

        # the project screen: named, never passed over; counted as the export will write it
        rep = self.report(role="training")
        sets = {s["setId"]: s for s in rep["sets"]}
        self.assertEqual((sets["table-a"]["damaged"], sets["table-b"]["damaged"]), (damage, []))
        self.assertEqual(rep["export"]["damaged"], [{"setId": "table-a", **d} for d in damage])
        self.assertEqual((rep["passes"]["box"]["sets"], rep["passes"]["box"]["done"], rep["passes"]["box"]["frames"]), (["table-b"], 1, 5))
        self.assertEqual((rep["export"]["coco"]["included"], rep["export"]["coco"]["recordings"], rep["export"]["coco"]["leftOut"]), (1, 1, 4))

        # the export: the damaged set is left out whole (never written from in part), and it says which file and line
        doc, notes = self.exported()
        self.assertEqual((len(doc["images"]), {i["set"] for i in doc["images"]}), (rep["export"]["coco"]["included"], {"table-b"}))
        self.assertEqual(notes, [f"table-a: left out, a label file cannot be read in full ({path}, line 2: not JSON (and 1 more)); correct or remove that line, then export again"])
        out = self.tmp / "boxes.json"
        said = io.StringIO()
        with contextlib.redirect_stdout(said):
            self.assertEqual(export.main(["coco", "--labels-dir", str(self.labels), "--out", str(out)]), 0)
        self.assertIn(f"{path}, line 2: not JSON", said.getvalue())
        self.assertEqual(len(json.loads(out.read_text())["images"]), 1)
        with self.assertRaises(SystemExit) as stop, contextlib.redirect_stdout(io.StringIO()) as said:
            export.main(["coco", "--labels-dir", str(self.labels), "--out", str(self.tmp / "a.json"), "--set", "table-a"])
        self.assertIn("line 2", said.getvalue())
        self.assertEqual(str(stop.exception), "no box, corner or training set to export")
        self.assertFalse((self.tmp / "a.json").exists())

        # the labeling page: it lists the sets (it does not fail), the damaged one read-only with the reason
        listed = {entry["setId"]: entry for entry in self.page()}
        self.assertEqual(self.get("/api/sets")[0], 200)
        self.assertIsNone(listed["table-b"]["readOnly"])
        self.assertIn(f"{path}, line 2: not JSON", listed["table-a"]["readOnly"])
        self.assertIn("read-only", listed["table-a"]["readOnly"])
        status, payload = self.get("/api/labels/table-a")
        self.assertEqual((status, [fr["name"] for fr in payload["frames"]], payload["readOnly"]), (200, ["f00001.png", "f00003.png"], listed["table-a"]["readOnly"]))
        for route, body in (("/api/labels/table-a/frames/f00002.png", {"frame": frame(2, True, [box(1)])}), ("/api/labels/table-a/meta", {"notes": "x"}),
                            ("/api/timing/table-a", {"events": [{"ev": "session-open"}]})):
            status, got = self.post(route, body)
            self.assertEqual((status, got["error"]), (409, listed["table-a"]["readOnly"]), route)
        self.assertEqual(path.read_bytes(), before, "not one byte of the damaged file was written")
        self.assertEqual(self.get("/api/identify-queue/table-a")[1]["readOnly"], listed["table-a"]["readOnly"])

        # mended: everything counts it again
        path.write_text("\n".join(lines) + "\n")
        self.assertEqual(self.report(role="training")["export"]["coco"]["included"], 4)
        self.assertEqual(len(self.exported()[0]["images"]), 4)
        self.assertIsNone(self.get("/api/sets")[1][0]["readOnly"])

    def test_a_meta_file_that_cannot_be_read_is_damage_and_a_folder_of_another_tool_is_not(self):
        write_set(self.labels, "table-a", [frame(1, True, [box(1)])])
        (self.labels / "table-a" / "meta.json").write_text("{cut short")
        (self.labels / "table-b").mkdir()
        (self.labels / "table-b" / "frames.jsonl").write_text('{"name": "f00001.png"}\nnot json\n')  # no meta.json: not this tool's
        rep = self.report(role="training")
        sets = {s["setId"]: s for s in rep["sets"]}
        self.assertEqual(sets["table-a"]["damaged"], [{"file": str(self.labels / "table-a" / "meta.json"), "line": None, "problem": "not JSON"}])
        self.assertEqual((sets["table-b"]["damaged"], sets["table-b"]["foreign"]), ([], True))
        self.assertEqual(rep["passes"]["box"]["reason"], "damaged")
        listed = {entry["setId"]: entry["readOnly"] for entry in self.page()}
        self.assertIn("meta.json: not JSON", listed["table-a"])
        self.assertIn("not a label set of this tool", listed["table-b"])
        self.assertEqual(self.post("/api/labels/table-a/frames/f00001.png", {"frame": frame(1, True, [box(1)])})[0], 409)
        self.assertEqual((self.labels / "table-a" / "meta.json").read_text(), "{cut short")
        self.assertEqual([n.split(":")[0] for n in self.exported()[1]], ["table-a"], "the export says the damaged one; the other tool's folder is no label set")

    def test_the_three_list_the_same_videos_frames_and_sets(self):
        """A sample with entries no route would open, and a repeat set: the project screen, the
        labeling page and the export count the same."""
        doc = json.loads(self.sample.read_text())
        doc["assets"][0]["frames"] += [{"t": 9.0, "name": "../outside.png"}, {"t": 9.5, "name": "notes.txt"}, "f9.png", {"t": 10.0}]
        doc["assets"] += [{"assetId": "bad id", "frames": [{"t": 0, "name": "f00001.png"}]}, {"assetId": "../up", "frames": []}, {"frames": []}, "table-z", None,
                          {"assetId": "table-c", "frames": "none"}]
        self.sample.write_text(json.dumps(doc))
        write_set(self.labels, "table-a", [frame(n, n < 4, [box(1, **NAMED), box(2, **NAMED)]) for n in range(1, 6)])
        make_repeat_set.make_repeat(self.labels, "table-a", "table-a-rep1", 4, 1)
        rows = [json.loads(line) for line in (self.labels / "table-a-rep1" / "frames.jsonl").read_text().splitlines()]
        rows[0]["done"] = True
        (self.labels / "table-a-rep1" / "frames.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))

        rep = self.report(role="training")
        page = self.page()
        self.assertEqual([s["setId"] for s in rep["sets"]], ["table-a", "table-b", "table-c", "table-a-rep1"])
        self.assertEqual([s["setId"] for s in rep["sets"]], [s["setId"] for s in page], "the same sets, in the same order")
        self.assertEqual([s["frames"] for s in rep["sets"]], [len(s["frames"]) for s in page], "the same frames in each")
        self.assertEqual([s["done"] for s in rep["sets"]], [s["labeled"] for s in page], "the same frames done in each")
        self.assertEqual(rep["sets"][3]["repeatOf"], "table-a")
        self.assertEqual((rep["recordings"], rep["frames"]["listed"]), (3, 10), "the videos and frames a route would open, and no others")
        self.assertEqual(sorted(export.read_sample(self.sample)), ["table-a", "table-b", "table-c"])
        self.assertEqual([f["name"] for f in export.read_sample(self.sample)["table-a"]["frames"]], [f"f{n:05d}.png" for n in range(1, 6)])
        # the pass counts take the repeat set in, as the labeling page lists it
        box_pass = rep["passes"]["box"]
        self.assertEqual(box_pass["sets"], ["table-a", "table-b", "table-c", "table-a-rep1"])
        self.assertEqual((box_pass["frames"], box_pass["done"]), (sum(len(s["frames"]) for s in page), sum(s["labeled"] for s in page)))
        self.assertEqual(box_pass["done"], 4)
        # and the export count is what the export writes
        doc, _notes = self.exported()
        self.assertEqual(rep["export"]["coco"]["included"], len(doc["images"]))
        self.assertEqual(rep["export"]["coco"]["leftOut"], sum(len(s["frames"]) - s["labeled"] for s in page))

    def test_a_label_line_ends_at_a_line_break_and_nowhere_else(self):
        """A row another program wrote with a line separator of another script inside a text
        (U+2028, U+0085) is one row, and a file with Windows line ends reads as before."""
        row = frame(1, True, [box(1)], notes="one two\u0085three")
        folder = self.labels / "table-a"
        write_set(self.labels, "table-a", [])
        (folder / "frames.jsonl").write_bytes((json.dumps(row, ensure_ascii=False) + "\r\n" + json.dumps(frame(2)) + "\r\n\r\n").encode("utf-8"))
        meta, rows = lf.read_label_set(folder)
        self.assertEqual((list(rows), rows.damage), ([row, frame(2)], []))
        self.assertEqual(self.report(role="training")["sets"][0]["done"], 2)


# ---- small things -------------------------------------------------------------------------------

# ---- removing a frame from the project -----------------------------------------------------------

class RemovedRecord(unittest.TestCase):
    """removed-frames.json, read and applied by labelfiles.py: no file is nothing removed, a file
    that does not fit is never guessed at, and the sample's frames are filtered, not rewritten."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="labeler-removed-test-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_the_file_round_trip_and_what_is_refused(self):
        self.assertEqual(lf.read_removed(self.tmp), (lf.empty_removed(), None), "no file: nothing removed")
        record = lf.empty_removed()
        record["removed"].append({"assetId": "vid", "name": "f00002.png", "reason": "no-cards", "at": "2026-01-01T00:00:00+00:00"})
        record["replacements"].append({"assetId": "vid", "removed": "f00002.png", "added": {"t": 1.5, "name": "f00003.png"}, "at": None})
        lf.write_removed(self.tmp, record)
        self.assertEqual(lf.read_removed(self.tmp), (record, None))
        self.assertEqual([p.name for p in self.tmp.iterdir()], [lf.REMOVED_FILE], "no temporary file is left")
        for bad in ('{"tool": "labeler", "removed": [{"assetId": "vid", "name": "../x.png"}]}',
                    '{"tool": "labeler", "removed": [{"assetId": "vid", "name": "f1.png", "reason": "ugly"}]}',
                    '{"tool": "labeler", "replacements": [{"assetId": "vid", "removed": "f1.png", "added": {"name": "f2.png", "t": -1}}]}',
                    '{"removed": []}', '[]'):
            (self.tmp / lf.REMOVED_FILE).write_text(bad)
            self.assertEqual(lf.read_removed(self.tmp), (lf.empty_removed(), "not-record"), bad)
        (self.tmp / lf.REMOVED_FILE).write_text("{")
        self.assertEqual(lf.read_removed(self.tmp)[1], "not-json")

    def test_the_overlay_on_a_sample(self):
        assets = [{"assetId": "vid", "framesDir": "frames/vid", "frames": [{"t": 0.0, "name": "f00001.png"}, {"t": 2.0, "name": "f00002.png"}]},
                  {"assetId": "other", "frames": [{"t": 0.0, "name": "f00002.png"}]}]
        before = json.dumps(assets)
        record = {**lf.empty_removed(), "removed": [{"assetId": "vid", "name": "f00002.png", "reason": None, "at": None}],
                  "replacements": [{"assetId": "vid", "removed": "f00002.png", "added": {"t": 3.0, "name": "f00003.png"}, "at": None}]}
        got = lf.apply_frame_changes(assets, record)
        self.assertEqual(got[0]["frames"], [{"t": 0.0, "name": "f00001.png"}, {"t": 3.0, "name": "f00003.png"}])
        self.assertEqual((got[0]["removedFrames"], got[0]["framesDir"]), (["f00002.png"], "frames/vid"))
        self.assertEqual((got[1]["frames"], got[1]["removedFrames"]), (assets[1]["frames"], []), "a frame of the same name in another video stays")
        self.assertEqual(json.dumps(assets), before, "the sample as read is not changed")
        # a nearby frame that was itself removed later is left out like any other
        record["removed"].append({"assetId": "vid", "name": "f00003.png", "reason": "other", "at": None})
        self.assertEqual([f["name"] for f in lf.apply_frame_changes(assets, record)[0]["frames"]], ["f00001.png"])

    def test_nearby_frames_and_their_times(self):
        for k in range(1, 11):
            (self.tmp / f"f{k:05d}.png").write_bytes(b"x")
        (self.tmp / "notes.txt").write_text("not a frame")
        listed = [{"t": 0.5, "name": "f00001.png"}, {"t": 8.5, "name": "f00005.png"}, {"t": 18.5, "name": "f00010.png"}]
        near = lf.nearby_frames(self.tmp, listed, lf.empty_removed(), "vid", "f00005.png")
        self.assertEqual([f["name"] for f in near], ["f00002.png", "f00003.png", "f00004.png", "f00006.png", "f00007.png", "f00008.png"],
                         "the six nearest the frame, the sample's own left out, in folder order")
        self.assertEqual([f["t"] for f in near], [2.5, 4.5, 6.5, 10.5, 12.5, 14.5], "times in proportion between the frames whose time is known")
        taken = {**lf.empty_removed(), "replacements": [{"assetId": "vid", "removed": "f00005.png", "added": {"name": "f00004.png"}, "at": None}]}
        self.assertNotIn("f00004.png", [f["name"] for f in lf.nearby_frames(self.tmp, listed, taken, "vid", "f00005.png")], "a frame chosen before is not offered again")
        self.assertEqual(lf.nearby_frames(self.tmp, listed, lf.empty_removed(), "vid", "f00099.png"), [], "a frame that is not in the folder has none")

    def test_a_time_is_worked_out_never_guessed(self):
        """A nearby frame's time: by its number on the line through the known frames, by
        make_sample.py's rule with one known frame, by folder position only for names without a
        number between two known frames; else none."""
        t = lf.estimate_time
        # a gap in the numbering (f00006 and f00007 were never cut): the numbers, not the positions, say where a frame is
        order = [f"f{k:05d}.png" for k in (1, 2, 3, 4, 5, 8, 9, 10)]
        self.assertEqual(t(order, {"f00001.png": 1.0, "f00010.png": 19.0}, "f00005.png"), 9.0)
        self.assertEqual(t(order, {"f00001.png": 1.0, "f00002.png": 3.0}, "f00009.png"), 17.0, "past the last, at the same pace")
        # one known frame: frames cut fps a second, frame N at (N - 0.5) / fps
        self.assertEqual(t(order, {"f00003.png": 5.0}, "f00004.png"), 7.0, "one frame every 2 s")
        self.assertEqual(t(order, {"clip-f00003.png": 2.5}, "clip-f00001.png"), 0.5, "the name may carry a prefix")
        self.assertIsNone(t(order, {"f00001.png": 0.0}, "f00002.png"), "a time of 0 gives no pace")
        self.assertIsNone(t(order, {"f00004.png": 1.0, "f00005.png": 3.0}, "f00001.png"), "never a time before the video's start")
        self.assertIsNone(t(order, {}, "f00002.png"))
        # names without a number: only between two known frames
        self.assertEqual(t(["a.png", "b.png", "c.png"], {"a.png": 1.0, "c.png": 3.0}, "b.png"), 2.0)
        self.assertIsNone(t(["a.png", "b.png", "c.png"], {"a.png": 1.0, "b.png": 3.0}, "c.png"), "not past the last")
        self.assertIsNone(t(["a.png", "b.png"], {"a.png": 1.0}, "b.png"), "not from one known frame")


class RemovingFrames(Server):
    """A frame removed on the labeling page is skipped by the frame list, the counts and the
    export; its labels stay, and the project screen restores it as it was."""

    def setUp(self):
        super().setUp()
        self.addCleanup(lambda: serve.SAVES.tabs.clear())

    def begin(self, *more):
        serve.configure(serve.build_parser().parse_args(["--mode", "box", "--role", "training", "--sample", str(self.sample), *more]))

    def remove(self, name, set_id="table-a", **body):
        return self.post(f"/api/remove-frame/{set_id}", {"run": serve.RUN_ID, "frame": name, "unsaved": 0, **body})

    def restore(self, name, asset="table-a", **body):
        return self.post("/api/restore-frame", {"run": serve.RUN_ID, "path": "toy", "assetId": asset, "name": name, **body})

    def frames_of(self, set_id="table-a"):
        entry = next(s for s in self.get("/api/sets")[1] if s["setId"] == set_id)
        return [f["name"] for f in entry["frames"]], entry

    def test_remove_count_export_and_restore(self):
        write_set(self.labels, "table-a", [frame(1, True, [box(1, **NAMED)]), frame(2, True, [box(1, **NAMED), box(2, **NAMED)])])
        self.begin()
        stored = (self.labels / "table-a" / "frames.jsonl").read_bytes()
        # refused: a page of another run, a page with unsaved changes, a reason the tool does not know, a frame that is not there
        self.assertEqual(self.post("/api/remove-frame/table-a", {"run": "0123456789abcdef", "frame": "f00002.png", "unsaved": 0})[1]["problem"], "other-run")
        self.assertEqual(self.remove("f00002.png", unsaved=1)[1]["problem"], "unsaved")
        self.assertEqual(self.remove("f00002.png", reason="ugly")[0], 400)
        self.assertEqual(self.remove("f00099.png")[0], 409)
        self.assertFalse((self.labels / lf.REMOVED_FILE).exists(), "nothing written while refused")
        status, got = self.remove("f00002.png", reason="no-cards")
        self.assertEqual((status, got), (200, {"ok": True, "removed": "f00002.png", "added": None}))
        self.assertEqual((self.labels / "table-a" / "frames.jsonl").read_bytes(), stored, "the labels stay as they were")
        doc = json.loads((self.labels / lf.REMOVED_FILE).read_text())
        self.assertEqual([(e["assetId"], e["name"], e["reason"]) for e in doc["removed"]], [("table-a", "f00002.png", "no-cards")])
        self.assertEqual(json.loads(self.sample.read_text())["assets"][0]["frames"][1]["name"], "f00002.png", "the sample file is not rewritten")
        names, entry = self.frames_of()
        self.assertEqual((names, entry["labeled"], entry["removed"]), (["f00001.png", "f00003.png", "f00004.png", "f00005.png"], 1, 1))
        self.assertEqual(self.remove("f00002.png")[0], 409, "a removed frame is no frame of the set any more")
        # the project screen: counts without the frame, and the frame listed
        rep = self.post("/api/project", {"path": "toy"})[1]
        self.assertEqual((rep["passes"]["box"]["frames"], rep["passes"]["box"]["done"], rep["frames"]["listed"]), (9, 1, 9))
        self.assertEqual([(e["name"], e["reason"], e["replacedBy"]) for e in rep["removed"]["frames"]], [("f00002.png", "no-cards", None)])
        self.assertEqual((rep["export"]["coco"]["included"], rep["export"]["coco"]["leftOut"]), (1, 8))
        # the export skips it, and says so
        status, got = self.post("/api/export", {"run": serve.RUN_ID, "path": "toy", "kind": "coco"})
        self.assertEqual((status, got["frames"], got["boxes"]), (200, 1, 1), got)
        self.assertIn("table-a: 1 removed frame skipped", got["notes"])
        # restored: refused while a page holds unsaved changes, then back with its labels as they were
        self.assertEqual(self.post("/api/tabs", {"run": serve.RUN_ID, "tab": "page", "unsaved": 1})[0], 200)
        self.assertEqual(self.restore("f00002.png")[1]["problem"], "busy")
        self.post("/api/tabs", {"run": serve.RUN_ID, "tab": "page", "unsaved": 0})
        self.assertEqual(self.restore("f00002.png", run="0123456789abcdef")[1]["problem"], "other-run")
        self.assertEqual(self.restore("f00002.png"), (200, {"ok": True, "restored": "f00002.png"}))
        self.assertEqual(self.restore("f00002.png")[1]["problem"], "not-removed")
        names, entry = self.frames_of()
        self.assertEqual((names[:2], entry["labeled"], entry["removed"]), (["f00001.png", "f00002.png"], 2, 0))
        self.assertEqual((self.labels / "table-a" / "frames.jsonl").read_bytes(), stored)
        status, got = self.get("/api/labels/table-a")
        self.assertEqual([r["name"] for r in got["frames"] if r.get("done")], ["f00001.png", "f00002.png"])
        self.assertEqual(self.post("/api/project", {"path": "toy"})[1]["removed"]["frames"], [])

    def test_a_nearby_frame_instead(self):
        sample = json.loads(self.sample.read_text())
        sample["assets"][0]["frames"] = [f for f in sample["assets"][0]["frames"] if f["name"] in ("f00001.png", "f00003.png", "f00005.png")]
        self.sample.write_text(json.dumps(sample))
        self.begin("--prefill", str(self.toy / "prefill.jsonl"))
        status, got = self.get("/api/nearby/table-a/f00003.png")
        self.assertEqual(status, 200, got)
        self.assertEqual([(f["name"], f["t"], f["modelBoxes"]) for f in got["frames"]], [("f00002.png", 1.0, True), ("f00004.png", 3.0, True)],
                         "the frames of the folder the sample does not list, with their times from the suggestions file")
        self.assertTrue(got["suggestions"])
        self.assertEqual(self.remove("f00003.png", replaceWith="f00003.png")[0], 409, "only a frame offered")
        status, got = self.remove("f00003.png", reason="blurry-or-small", replaceWith="f00004.png")
        self.assertEqual((status, got["added"]), (200, {"name": "f00004.png", "t": 3.0}))
        names, _entry = self.frames_of()
        self.assertEqual(names, ["f00001.png", "f00005.png", "f00004.png"])
        self.assertEqual([f["name"] for f in self.get("/api/nearby/table-a/f00005.png")[1]["frames"]], ["f00002.png"], "a frame used once is not offered again")
        # the frame used instead is labeled like any other, and exported
        self.assertEqual(self.post("/api/labels/table-a/frames/f00004.png", {"frame": dict(frame(4, True, [box(1)]), t=3.0)})[0], 200)
        self.assertEqual(self.request("GET", "/frames/table-a/f00004.png")[0], 200)
        rep = self.post("/api/project", {"path": "toy"})[1]
        self.assertEqual((rep["passes"]["box"]["frames"], rep["passes"]["box"]["done"]), (8, 1))
        self.assertEqual(rep["removed"]["frames"][0]["replacedBy"], "f00004.png")
        sets, _notes = export.read_sets(self.labels)
        self.assertEqual([r["name"] for r in sets[0][2]], ["f00004.png"])
        # restoring the removed frame keeps the one used instead
        self.assertEqual(self.restore("f00003.png")[0], 200)
        self.assertEqual(self.frames_of()[0], ["f00001.png", "f00003.png", "f00005.png", "f00004.png"])

    def test_a_set_whose_every_frame_is_removed(self):
        self.begin()
        for k in range(1, 6):
            self.assertEqual(self.remove(f"f{k:05d}.png", set_id="table-b")[0], 200)
        names, entry = self.frames_of("table-b")
        self.assertEqual((names, entry["removed"]), ([], 5))
        rep = self.post("/api/project", {"path": "toy"})[1]
        self.assertEqual({s["setId"]: (s["frames"], s["removed"]) for s in rep["sets"]}, {"table-a": (5, 0), "table-b": (0, 5)})
        for k in range(1, 6):
            self.remove(f"f{k:05d}.png")
        rep = self.post("/api/project", {"path": "toy"})[1]
        self.assertEqual((rep["passes"]["box"]["reason"], rep["frames"]["listed"]), ("all-removed", 0))
        self.assertEqual(self.get("/api/nearby/table-a/f00001.png")[1]["frames"], [], "the toy lists every frame of its folders: none to use instead")

    def test_measuring_sets(self):
        """Development and test: removing is allowed, picking a frame by hand is not; a frame whose
        answers were shown, and Check names itself, remove nothing."""
        sample = json.loads(self.sample.read_text())
        sample["assets"][0]["frames"] = [f for f in sample["assets"][0]["frames"] if f["name"] in ("f00001.png", "f00003.png", "f00005.png")]
        self.sample.write_text(json.dumps(sample))
        face = {"id": "C001", "x": 0.5, "y": 0.5, "kind": "face"}
        census = lambda n, c: {**{k: v for k, v in frame(n, True).items() if k != "targets"}, "centers": [c], "centerSeq": 1}  # noqa: E731
        write_set(self.labels, "table-a", [census(1, face), census(3, dict(face, revealedAt="2026-01-01T00:00:00.000+00:00"))],
                  mode="center", role="development")
        serve.configure(serve.build_parser().parse_args(["--mode", "center", "--role", "development", "--sample", str(self.sample)]))
        status, got = self.get("/api/nearby/table-a/f00001.png")
        self.assertEqual((status, got["frames"], got["measuring"]), (200, [], serve.MEASURING_NEARBY), "no frame picked by hand in a measuring set")
        self.assertEqual(self.remove("f00001.png", replaceWith="f00002.png")[1]["problem"], "measuring")
        status, got = self.remove("f00003.png")
        self.assertEqual((status, got["problem"], got["error"]), (409, "revealed", "This frame's answers have been shown; removing it now would bias the measurement."))
        self.assertEqual(self.remove("f00001.png", reason="blurry-or-small")[0], 200, "a plain removal is allowed")
        self.assertEqual(self.restore("f00001.png")[0], 200)
        serve.CFG.__dict__.clear()
        serve.configure(serve.build_parser().parse_args(["--mode", "verify", "--role", "development", "--sample", str(self.sample), "--all-blind",
                                                         "--catalog", str(self.toy / "catalog.json")]))
        self.assertEqual(self.remove("f00001.png")[1]["problem"], "verify", "nothing is removed in Check names")
        # the manifest's summary counts what was removed, by reason
        serve.CFG.__dict__.clear()
        self.begin()
        write_set(self.labels, "table-b", [frame(k, True, [box(1, **NAMED)]) for k in (1, 2)], mode="box", role="development")
        sample["assets"][1]["platform"], sample["assets"][1]["videoId"] = "local", "table-b"
        self.sample.write_text(json.dumps(sample))
        lf.write_removed(self.labels, {**lf.empty_removed(), "removed": [{"assetId": "table-b", "name": "f00002.png", "reason": "no-cards", "at": None}]})
        out = self.tmp / "m.manifest.jsonl"
        said = io.StringIO()
        with contextlib.redirect_stdout(said):
            self.assertEqual(export.main(["manifest", "--labels-dir", str(self.labels), "--set", "table-b", "--sample", str(self.sample), "--out", str(out),
                                          "--credit", "Toy", "--source-type", "physical"]), 0)
        self.assertIn("1 rows, 1 boxes, 1 rows with a frame fingerprint, 1 removed frame skipped (1 no cards)", said.getvalue())

    def test_a_repeat_set_removes_nothing(self):
        write_set(self.labels, "table-a-rep1", [frame(1, True, [box(1)])], frameAsset="table-a", repeatOf={"set": "table-a"})
        meta = json.loads((self.labels / "table-a-rep1" / "meta.json").read_text())
        meta["frameAsset"] = "table-a"
        (self.labels / "table-a-rep1" / "meta.json").write_text(json.dumps(meta))
        self.begin()
        status, got = self.remove("f00001.png", set_id="table-a-rep1")
        self.assertEqual((status, got["problem"]), (409, "repeat-set"), got)
        self.assertIn("table-a", got["error"])

    def test_the_names_pass_counts_only_frames_still_in_the_project(self):
        write_set(self.labels, "table-a", [frame(1, True, [box(1)]), frame(2, True, [box(1), box(2)])])
        self.begin()
        self.assertEqual(self.remove("f00002.png")[0], 200)
        serve.CFG.__dict__.clear()
        serve.configure(serve.build_parser().parse_args(["--mode", "identify", "--role", "training", "--sample", str(self.sample),
                                                         "--catalog", str(self.toy / "catalog.json")]))
        queue = self.get("/api/identify-queue/table-a")[1]["queue"]
        self.assertEqual({e["frame"] for e in queue}, {"f00001.png"}, "the removed frame's boxes wait for no name")
        self.assertEqual({e["frame"] for e in self.get("/api/labels/table-a")[1]["identifyQueue"]}, {"f00001.png"})
        self.assertEqual(self.restore("f00002.png")[0], 200)
        self.assertEqual(len(self.get("/api/identify-queue/table-a")[1]["queue"]), 3)

    def test_a_nearby_frame_whose_time_is_unknown(self):
        """No suggestions file and one known frame at 0 s: no pace, so no time. The frame can be
        used for boxes; the manifest export refuses it cleanly."""
        (self.toy / "prefill.jsonl").unlink()
        sample = json.loads(self.sample.read_text())
        sample["assets"][0]["frames"] = sample["assets"][0]["frames"][:1]
        sample["assets"][0].update(platform="local", videoId="table-a")
        self.sample.write_text(json.dumps(sample))
        self.begin()
        near = self.get("/api/nearby/table-a/f00001.png")[1]["frames"]
        self.assertEqual([(f["name"], f["t"]) for f in near][:2], [("f00002.png", None), ("f00003.png", None)])
        self.assertEqual(self.remove("f00001.png", replaceWith="f00002.png")[1]["added"], {"name": "f00002.png"})
        row = {k: v for k, v in frame(2, True, [box(1, **NAMED)]).items() if k != "t"}
        self.assertEqual(self.post("/api/labels/table-a/frames/f00002.png", {"frame": row})[0], 200)
        status, got = self.post("/api/export", {"run": serve.RUN_ID, "path": "toy", "kind": "coco"})
        self.assertEqual((status, got["frames"]), (200, 1), "the boxes export takes it")
        write_set(self.labels, "table-a", [row], mode="box", role="training", recording={"source": "physical"})
        status, got = self.post("/api/export", {"run": serve.RUN_ID, "path": "toy", "kind": "manifest", "credit": "Toy", "sourceType": "physical", "replace": True})
        self.assertEqual((status, got["problem"], [p["code"] for p in got["problems"]]), (409, "refused", ["time-size"]), got)

    def test_a_list_that_cannot_be_read_is_not_guessed_at(self):
        self.begin()
        self.labels.mkdir(parents=True, exist_ok=True)
        (self.labels / lf.REMOVED_FILE).write_text('{"tool": "labeler", "removed": [{"assetId": "table-a"}]}')
        status, got = self.remove("f00001.png")
        self.assertEqual(status, 409)
        self.assertIn(lf.REMOVED_FILE, got["error"])
        self.assertEqual(self.get("/api/nearby/table-a/f00001.png")[0], 409)
        self.assertEqual(self.restore("f00001.png")[1]["problem"], "removed-file")
        rep = self.post("/api/project", {"path": "toy"})[1]
        self.assertEqual((rep["removed"]["problem"], rep["frames"]["listed"]), ("not-record", 10))
        with self.assertRaises(SystemExit):
            export.read_sets(self.labels)


class SmallThings(Server):
    def test_a_body_nested_too_deep_is_answered_not_dropped(self):
        deep = ("[" * 100000 + "]" * 100000).encode()
        with contextlib.redirect_stderr(io.StringIO()) as said:
            for path in ("/api/project", "/api/open", "/api/remember"):
                status, _headers, body = self.request("POST", path, b'{"path": ' + deep + b"}")
                self.assertEqual((status, json.loads(body)), (400, {"error": "expected a JSON object"}), path)
        self.assertNotIn("Traceback", said.getvalue())
        self.assertEqual(self.post("/api/project", {"path": "toy"})[0], 200, "and the server goes on answering")

    def test_working_times_for_a_set_nobody_labels_make_no_folder(self):
        serve.configure(serve.build_parser().parse_args(["--mode", "box", "--role", "training", "--sample", str(self.sample)]))
        events = {"events": [{"ev": "session-open", "ts": 1}]}
        for unknown in ("nosuchset", "table-c", "labels", "x"):
            self.assertEqual(self.post(f"/api/timing/{unknown}", events), (404, {"error": "unknown set"}), unknown)
        self.assertFalse(self.labels.exists(), "nothing was made in the labels folder")
        # a set of this sample takes them from its first moment, before any label is saved
        self.assertEqual(self.post("/api/timing/table-a", events), (200, {"ok": True}))
        self.assertEqual(sorted(p.name for p in self.labels.iterdir()), ["table-a"])
        self.assertEqual(len((self.labels / "table-a" / "timing.jsonl").read_text().splitlines()), 1)
        # and so does a repeat set, which is a folder of its own
        write_set(self.labels, "table-a-rep1", [frame(1, False, [box(1)])], frameAsset="table-a", repeatOf={"set": "table-a"})
        self.assertEqual(self.post("/api/timing/table-a-rep1", events)[0], 200)

    def test_the_two_commands_for_a_video_survive_a_path_with_a_space(self):
        """The commands under "I only have a video" name the interpreter and make_sample.py as
        this tool was started. A checkout in a folder with a space in its name must not break
        them: each is one word of the command."""
        import shlex
        python, script = "/opt/card tools/venv/bin/python3", "/srv/our team/card tools/labeler/serve.py"
        serve.HUB.command = {"prefix": [python, "-B", script], "tail": [], "cwd": str(self.start)}
        facts = self.get("/api/hub")[1]
        node = shutil.which("node")
        if node is None:
            self.skipTest("node not on PATH")
        code = ("const H = require(process.argv[1]); const f = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
                "console.log(JSON.stringify([H.video(f).commands[1].text, H.problem({problem: 'no-sample-in-folder', path: '/x'}, "
                "{startDir: f.startDir, sampleTool: f.tools.sample, python: f.tools.python}).fix]));")
        res = subprocess.run([node, "-e", code, str(HERE / "hubstate.js")], input=json.dumps(facts), capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)
        command, fix = json.loads(res.stdout)
        words = shlex.split(command)
        self.assertEqual(words[:4], [python, "-B", script.replace("serve.py", "make_sample.py"), "--out"], command)
        self.assertEqual(shlex.split(fix.split("frames: ", 1)[1])[:3], [python, "-B", script.replace("serve.py", "make_sample.py")])
        self.assertEqual(shlex.split(facts["restart"]), [python, "-B", script])


class NodeTests(Server):
    def node(self, *argv, **kw):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node not on PATH")
        return subprocess.run([node, *argv], capture_output=True, text=True, **kw)

    def test_node(self):
        res = self.node(str(HERE / "test_hubstate.js"))
        self.assertEqual(res.returncode, 0, f"test_hubstate.js: {res.stdout}\n{res.stderr}")

    def test_the_two_screens_ask_only_what_a_person_caused(self):
        """hub.js itself, run against a stand-in for the page (test_hubpage.js), with this
        server's own facts: arriving at an address asks for the report and remembers nothing;
        what a person does on the screens is what is remembered."""
        facts = {"facts": self.get("/api/hub")[1], "report": self.post("/api/project", {"path": "toy", "role": "training"})[1], "sample": str(self.sample)}
        res = self.node(str(HERE / "test_hubpage.js"), input=json.dumps(facts))
        self.assertEqual(res.returncode, 0, f"test_hubpage.js: {res.stdout}\n{res.stderr}")

    def test_the_page_words_what_the_server_really_sends(self):
        """test_hubstate.js words facts written by hand; here the same functions get the facts
        this server sends, state after state, so the two sides cannot drift apart unseen."""
        states = {"start-empty": self.get("/api/hub")[1], "fresh": self.post("/api/project", {"path": "toy"})[1],
                  "training": self.post("/api/project", {"path": "toy", "role": "training"})[1],
                  "test": self.post("/api/project", {"path": "toy", "role": "test"})[1],
                  "missing": self.post("/api/project", {"path": "toy", "role": "training", "locations": {"catalog": "none.json", "labels": str(self.sample)}})[1]}
        write_set(self.labels, "table-a", [frame(n, True, [box(1), box(2, **NAMED)]) for n in range(1, 6)])
        self.post("/api/remember", {"path": "toy"})
        states["part"] = self.post("/api/project", {"path": "toy"})[1]
        states["start-resume"] = self.get("/api/hub")[1]
        with contextlib.redirect_stdout(io.StringIO()):
            self.post("/api/open", {"path": "toy", "pass": "box"})
        states["running"] = self.post("/api/project", {})[1]
        states["start-running"] = self.get("/api/hub")[1]
        script = """
          const H = require(process.argv[1]);
          const states = JSON.parse(require("fs").readFileSync(0, "utf8"));
          const out = {};
          const strings = (v, into) => { if (typeof v === "string") into.push(v); else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, into)); return into; };
          for (const [name, facts] of Object.entries(states)) {
            const v = name.startsWith("start") ? H.start(facts) : H.project(facts);
            const said = strings(v, []);
            for (const s of said) if (/undefined|NaN|\\[object/.test(s)) throw new Error(name + ": " + s);
            out[name] = name.startsWith("start") ? [v.guide, v.primary, v.resume && v.resume.primary, v.running && v.running.primary]
              : [v.guide, v.primary, v.rows.map((r) => [r.status, r.kind, r.button]), v.purpose.options.map((o) => [o.checked, o.disabled]), v.exportRow.status, v.warnings.length];
            if (!name.startsWith("start")) for (const id of ["box", "identify", "corner", "center", "verify", "point"]) strings([H.scripts(facts, id), H.passRow(facts, id)], []);
          }
          console.log(JSON.stringify(out));
        """
        res = self.node("-e", script, str(HERE / "hubstate.js"), input=json.dumps(states))
        self.assertEqual(res.returncode, 0, res.stderr)
        got = json.loads(res.stdout)
        self.assertEqual(got["start-empty"], ["Label my frames fits: one sample was found here. {{Enter}} opens it and shows its passes.", "found", None, None])
        self.assertEqual(got["fresh"], ["Say what these labels will be used for. The passes below can be started after that.", None,
                                        [["0 of 10 frames", "disabled", None], ["No boxes yet", "disabled", None]], [[False, False]] * 3, "Nothing to export yet", 0])
        self.assertEqual(got["training"], ["Next: Boxes. {{Enter}} starts it.", "box", [["0 of 10 frames", "start", "Start"], ["No boxes yet", "disabled", None]],
                                           [[True, False], [False, False], [False, False]], "Nothing to export yet", 0])
        self.assertEqual(got["test"][3], [[False, False], [False, False], [True, False]])
        self.assertEqual((got["missing"][1], got["missing"][2][0][1], got["missing"][5]), (None, "disabled", 2), "the labels location and the catalog")
        self.assertEqual(got["part"], ["Next: Boxes. {{Enter}} goes on with it.", "box", [["5 of 10 frames", "start", "Continue"], ["5 cards left to name · 5 named", "start", "Continue"]],
                                       [[True, False], [False, True], [False, True]], "5 frames ready", 0])
        self.assertEqual(got["start-resume"], ["Label my frames fits: carry on where you stopped. {{Enter}} goes on with Boxes on toy.", "resume", "Continue with Boxes on toy", None])
        self.assertEqual(got["running"], ["The tool is running the Boxes pass. {{Enter}} opens it. Any other pass: its row's button switches the tool to it, here.", "box",
                                          [["5 of 10 frames", "open", "Open"], ["5 cards left to name · 5 named", "switch", "Continue"]],
                                          [[True, False], [False, True], [False, True]], "5 frames ready", 0])
        self.assertEqual(got["start-running"], ["The tool is running the Boxes pass on toy, for Training. {{Enter}} goes to it.", "running", None, "Go to the Boxes pass"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
