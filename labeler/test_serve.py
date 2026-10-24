# SPDX-License-Identifier: Apache-2.0
"""Integration tests for serve.py, make_repeat_set.py, compare_repeat.py, report_throughput.py
against a temporary fixture of made-up cards and frames, plus the Node tests. Standard library
only; nothing outside a temporary folder is written.

Run: python3 -m unittest discover -s labeler   (or: python3 labeler/test_serve.py)
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ["LABELER_QUIET"] = "1"
# never the real per-user folder (the list of projects opened before): see test_project.py
os.environ["LABELER_STATE_DIR"] = str(Path(tempfile.gettempdir()) / "labeler-test-state")

import compare_repeat  # noqa: E402
import decklist_from_text  # noqa: E402
import labelcore as lc  # noqa: E402
import make_repeat_set  # noqa: E402
import report_throughput  # noqa: E402
import serve  # noqa: E402

def quiet(fn, *a, **kw):
    """Call a script's main() without its report on the test output."""
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **kw)


def args(**kw):
    base = dict(port=0, mode="point", role="development", labels_dir=None, sample=None, frames_dir=None,
                catalog=None, art=None, k=12, seed=7, zoom=3.0, decklist=None, prefill=None, decklists_dir=None,
                arm=None, blind=None, problems_report=None)
    base.update(kw)
    return argparse.Namespace(**base)


CATALOG = {"game": "toy", "locale": "en", "cards": [
    {"id": "TOY-001", "name": "Amber Kitemaker", "kind": "Unit", "printingOf": None, "art": "TOY-001.png"},
    {"id": "TOY-120", "name": "Kite", "kind": "Spell", "printingOf": None, "art": "TOY-120.png"},
    {"id": "TOY-290", "name": "Windy Hill", "kind": "Site", "printingOf": None, "art": "sites/TOY-290.png"},
    {"id": "EXT-R01", "name": "Red Marker", "kind": "Marker", "printingOf": None, "art": "EXT-R01.png"},
], "kinds": {"landscape": ["Site"]}}


class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="labeler-test-"))
        (cls.tmp / "frames" / "vidA").mkdir(parents=True)
        for n, payload in ((1, b"\xff\xd8image-one"), (2, b"\xff\xd8a-completely-different-image")):
            (cls.tmp / "frames" / "vidA" / f"f{n:05d}.jpg").write_bytes(payload)
        sample = {"assets": [
            {"assetId": "vidA", "channel": "Table Cam", "frames": [{"t": 0, "name": "f00001.jpg"}, {"t": 1, "name": "f00002.jpg"},
                                                                    {"t": 2, "name": "f00003.jpg"}]},
            {"assetId": "vidB", "channel": "Other", "frames": [{"t": 0, "name": "f00001.jpg"}]},
            {"assetId": "foreign", "channel": "a folder another tool wrote", "frames": [{"t": 45, "name": "f00046.jpg"}]},
        ]}
        (cls.tmp / "sample.json").write_text(json.dumps(sample))
        (cls.tmp / "catalog.json").write_text(json.dumps(CATALOG))
        (cls.tmp / "deck.txt").write_text("3 Amber Kitemaker\ntoy-120\nNo Such Card\n")
        prefill = {"frames": [{"name": "f00001.jpg", "boxes": [
            {"box": [100, 100, 63, 88], "cardId": "TOY-001", "sim": 0.8, "margin": 0.2, "top5": [{"id": "TOY-001", "sim": 0.8}]},
            {"box": [300, 100, 63, 88], "cardId": None, "flag": "abstained"}]}]}
        (cls.tmp / "prefill.json").write_text(json.dumps(prefill))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def config(self, labels="labels", **kw):
        kw.setdefault("decklists_dir", str(self.tmp / "no-decklists"))
        kw.setdefault("catalog", str(self.tmp / "catalog.json"))
        serve.configure(args(labels_dir=str(self.tmp / labels), sample=str(self.tmp / "sample.json"),
                             frames_dir=str(self.tmp / "frames"), **kw))

    def get(self, path):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}") as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def post(self, path, body, run=True):
        """A POST as the labeling page sends it: with the identity of the run it was loaded
        from (`run=False`: without it; any other value: as that run)."""
        if run is not False and isinstance(body, dict):
            body = {"run": serve.RUN_ID if run is True else run, **body}
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def read_frames(self, labels, set_id):
        with (self.tmp / labels / set_id / "frames.jsonl").open() as f:
            return [json.loads(line) for line in f if line.strip()]

    # ---- point mode ----------------------------------------------------------------------

    def test_points_content_independent(self):
        self.config("lab-pts")
        s1, a = self.get("/api/points/vidA/f00001.jpg?t=0")
        s2, b = self.get("/api/points/vidB/f00001.jpg?t=0")  # another video, another image, same index
        s3, c = self.get("/api/points/vidA/f00003.jpg?t=2")  # no image file on disk at all
        self.assertEqual((s1, s2, s3), (200, 200, 200))
        self.assertEqual(a["points"], b["points"])
        self.assertEqual(a["points"], lc.points_for_frame(1, 7, 12))
        self.assertEqual(len(c["points"]), 12)
        self.assertEqual(a["rule"]["seed"], 7)
        # the frame bytes differ, the points do not
        self.assertNotEqual((self.tmp / "frames/vidA/f00001.jpg").read_bytes(), (self.tmp / "frames/vidA/f00002.jpg").read_bytes())

    def test_point_roundtrip_and_fixed_meta(self):
        self.config("lab-rt", decklist=[str(self.tmp / "deck.txt")])
        pts = lc.points_for_frame(1, 7, 12)
        pts[0].update(outcome="card", identity="TOY-001", identitySource="decklist", eligible="yes",
                      conditions={"faceUp": True, "visibleShare": "full", "glare": False}, labelSource="manual")
        pts[1].update(outcome="card-back", eligible="no", conditions={"faceUp": False}, labelSource="manual")
        frame = {"name": "f00001.jpg", "t": 0, "frameW": 1920, "frameH": 1080, "done": False, "points": pts}
        st, res = self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": frame})
        self.assertEqual(st, 200, res)
        on_disk = self.read_frames("lab-rt", "vidA")
        self.assertEqual(on_disk, [frame])
        st, got = self.get("/api/labels/vidA")
        self.assertEqual(got["frames"], [frame])
        self.assertIsNone(got["readOnly"])
        meta = got["meta"]
        self.assertEqual((meta["mode"], meta["role"], meta["zoom"], meta["pointRule"]["k"], meta["pointRule"]["seed"]),
                         ("point", "development", 3.0, 12, 7))
        self.assertEqual(meta["decklist"]["ids"], ["TOY-001", "TOY-120"])
        self.assertEqual(meta["decklist"]["unresolved"], ["No Such Card"])
        self.assertEqual(got["decklist"]["ids"], ["TOY-001", "TOY-120"])
        # the client cannot change fixed fields; recording tags are validated
        st, _ = self.post("/api/labels/vidA/meta", {"mode": "training", "role": "test",
                                                    "recording": {"source": "physical", "physicalGroup": "webcam",
                                                                  "sourceResolution": "720p", "language": "en"}})
        self.assertEqual(st, 200)
        meta = json.loads((self.tmp / "lab-rt/vidA/meta.json").read_text())
        self.assertEqual((meta["mode"], meta["role"]), ("point", "development"))
        self.assertEqual(meta["recording"]["physicalGroup"], "webcam")
        st, err = self.post("/api/labels/vidA/meta", {"recording": {"source": "vhs"}})
        self.assertEqual(st, 400)
        # a later run with other defaults keeps the set's own point rule
        self.config("lab-rt", seed=99, k=5)
        st, p = self.get("/api/points/vidA/f00001.jpg?t=0")
        self.assertEqual(p["points"], lc.points_for_frame(1, 7, 12))

    def test_validation_and_paths(self):
        self.config("lab-val")
        bad = {"name": "f00001.jpg", "points": [{"i": 0, "x": 0.5, "y": 0.5, "outcome": "cardd"}]}
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": bad})[0], 400)
        self.assertEqual(self.post("/api/labels/vidA/frames/f00002.jpg", {"frame": {**bad, "name": "f00001.jpg"}})[0], 400)
        self.assertEqual(self.post("/api/labels/..%2Fx/frames/f00001.jpg", {"frame": bad})[0], 400)
        self.assertEqual(self.get("/frames/vidA/..%2F..%2Fsample.json")[0], 400)
        self.assertEqual(self.post("/api/labels/nosuchset/frames/f00001.jpg", {"frame": {"name": "f00001.jpg", "points": []}})[0], 404)

    def test_an_id_or_a_frame_name_that_ends_in_a_line_break_is_refused(self):
        self.config("lab-line-break")
        self.assertEqual((serve._safe_id("vidA"), serve._safe_frame("f00001.jpg")), ("vidA", "f00001.jpg"))
        for value in ("vidA%0A", "vidA\n", "%0A", ""):
            self.assertIsNone(serve._safe_id(value), repr(value))
        for value in ("f00001.jpg%0A", "f00001.jpg\n", "f00001.png%0D%0A"):
            self.assertIsNone(serve._safe_frame(value), repr(value))
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/frames/vidA/f00001.jpg") as served:
            self.assertEqual(served.status, 200)
        self.assertEqual(self.get("/frames/vidA%0A/f00001.jpg")[0], 400)
        self.assertEqual(self.get("/frames/vidA/f00001.jpg%0A")[0], 400)
        self.assertEqual(self.get("/api/labels/vidA%0A")[0], 400)
        self.assertEqual(self.get("/api/points/vidA/f00001.jpg%0A?t=0")[0], 400)
        frame = {"name": "f00001.jpg", "points": []}
        self.assertEqual(self.post("/api/labels/vidA%0A/frames/f00001.jpg", {"frame": frame})[0], 400)
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg%0A", {"frame": frame})[0], 400)
        # a folder whose name ends in a line break is no label set
        root = self.tmp / "lab-line-break-root"
        for name in ("setA", "setB\n"):
            (root / name).mkdir(parents=True)
            (root / name / "frames.jsonl").write_text(json.dumps({"name": "f00001.jpg"}) + "\n")
        self.assertEqual(list(serve._labels_root_frames(root)), ["setA"])

    # ---- corner / training mode ----------------------------------------------------------

    def corner_frame(self, identity="TOY-001"):
        return {"name": "f00002.jpg", "t": 1, "frameW": 1920, "frameH": 1080, "done": True, "targets": [{
            "id": "Q001", "corners": [[560, 300], [440, 300], [440, 160], [560, 160]],  # upside-down 120 × 140
            "estimated": [False, False, True, False], "outcome": "card", "identity": identity,
            "identitySource": "current-frame", "eligible": "uncertain", "conditions": {"blur": True},
            "labelSource": "manual", "derived": {"shortSidePx": 1}}]}

    def test_corner_derived_server_side(self):
        self.config("lab-cor", mode="corner")
        self.post("/api/labels/vidA/meta", {"recording": {"source": "physical", "sourceResolution": "720p"}})
        st, res = self.post("/api/labels/vidA/frames/f00002.jpg", {"frame": self.corner_frame()})
        self.assertEqual(st, 200, res)
        t = self.read_frames("lab-cor", "vidA")[0]["targets"][0]
        d = t["derived"]
        self.assertEqual(d["aabb"], [440.0, 160.0, 120.0, 140.0])
        self.assertEqual(d["shortSidePx"], 120.0)
        self.assertEqual(d["shortSideSourcePx"], 80.0)  # native 720p under a 1080p frame
        self.assertEqual(d["rotationDeg"], 180.0)
        self.assertTrue(d["clockwise"])
        self.assertEqual(t["estimated"], [False, False, True, False])
        # a card of a kind the catalog lists under kinds.landscape is landscape when upright
        st, res = self.post("/api/labels/vidA/frames/f00002.jpg", {"frame": self.corner_frame("TOY-290")})
        self.assertAlmostEqual(res["frame"]["targets"][0]["derived"]["cardAspect"], 88 / 63, places=3)
        # point-mode rows are refused in a corner set, and prefill provenance outside training
        pf = self.corner_frame()
        pf["targets"][0]["labelSource"] = "prefill-accepted"
        self.assertEqual(self.post("/api/labels/vidA/frames/f00002.jpg", {"frame": pf})[0], 400)
        self.assertEqual(self.get("/api/prefill/vidA")[0], 404)

    def test_a_card_without_art_is_saved_by_its_id(self):
        # "art": null: a card with an id and a name and no picture yet is named like any other
        doc = json.loads(json.dumps(CATALOG))
        doc["cards"].append({"id": "TOY-NEW", "name": "Lantern Moth", "kind": "Unit", "printingOf": None, "art": None})
        (self.tmp / "catalog-no-art.json").write_text(json.dumps(doc))
        self.config("lab-no-art", mode="corner", catalog=str(self.tmp / "catalog-no-art.json"))
        self.assertTrue(next(c for c in serve.load_catalog() if c["id"] == "TOY-NEW")["noArt"])
        self.post("/api/labels/vidA/meta", {"recording": {"source": "physical", "sourceResolution": "720p"}})
        st, res = self.post("/api/labels/vidA/frames/f00002.jpg", {"frame": self.corner_frame("TOY-NEW")})
        self.assertEqual(st, 200, res)
        saved = self.read_frames("lab-no-art", "vidA")[0]["targets"][0]
        self.assertEqual((saved["outcome"], saved["identity"]), ("card", "TOY-NEW"))
        self.assertEqual(self.get("/api/labels/vidA")[1]["frames"][0]["targets"][0]["identity"], "TOY-NEW")

    def test_mode_mismatch_is_read_only(self):
        self.config("lab-mm", mode="corner")
        self.assertEqual(self.post("/api/labels/vidA/frames/f00002.jpg", {"frame": self.corner_frame()})[0], 200)
        self.config("lab-mm", mode="point")
        st, got = self.get("/api/labels/vidA")
        self.assertIn("mode=corner", got["readOnly"])
        self.assertEqual(self.post("/api/labels/vidA/frames/f00002.jpg", {"frame": {"name": "f00002.jpg", "points": []}})[0], 409)
        self.config("lab-mm", mode="corner", role="test")
        self.assertIn("role=development", self.get("/api/labels/vidA")[1]["readOnly"])

    def test_training_prefill(self):
        self.config("lab-tr", mode="training", role="training", prefill=[str(self.tmp / "prefill.json")])
        st, p = self.get("/api/prefill/vidA")
        self.assertEqual(st, 200)
        props = p["frames"]["f00001.jpg"]
        self.assertEqual(props[0]["corners"], [[100.0, 100.0], [163.0, 100.0], [163.0, 188.0], [100.0, 188.0]])
        self.assertEqual(props[0]["top5"], ["TOY-001"])
        self.assertIsNone(props[1]["cardId"])
        t = {"id": "Q001", "corners": props[0]["corners"], "estimated": [False] * 4, "outcome": "card",
             "identity": "TOY-001", "eligible": "yes", "labelSource": "prefill-accepted",
             "prefill": {"cardId": "TOY-001", "corners": props[0]["corners"]}}
        st, res = self.post("/api/labels/vidA/frames/f00001.jpg",
                            {"frame": {"name": "f00001.jpg", "t": 0, "frameW": 1920, "frameH": 1080, "prefillOffered": True, "targets": [t]}})
        self.assertEqual(st, 200, res)
        meta = json.loads((self.tmp / "lab-tr/vidA/meta.json").read_text())
        self.assertEqual((meta["prefillUsed"], meta["blind"], meta["role"]), (True, False, "training"))

    def test_guards(self):
        sample = str(self.tmp / "sample.json")
        for kw in (dict(mode="training", role="test"), dict(mode="training", role="development"),
                   dict(mode="point", prefill=[str(self.tmp / "prefill.json")]),
                   dict(mode="corner", role="training", prefill=[str(self.tmp / "prefill.json")]),
                   dict(mode="box", role="development", prefill=[str(self.tmp / "prefill.json")]),
                   dict(mode="box", role="test", prefill=[str(self.tmp / "prefill.json")]),
                   dict(mode="identify", role="training", prefill=[str(self.tmp / "prefill.json")])):
            with self.assertRaises((SystemExit, ValueError)):
                serve.configure(args(labels_dir=str(self.tmp / "g"), sample=sample, **kw))
        parsed = serve.build_parser().parse_args(["--mode", "point", "--role", "test", "--sample", sample])
        self.assertEqual((parsed.port, parsed.snap, parsed.catalog, parsed.art), (serve.DEFAULT_PORT, "off", None, None))
        # a corner source from prefill is refused outside training mode
        self.assertTrue(lc.validate_frame({"name": "f00001.jpg", "targets": [{"id": "Q001", "corners": [[0, 0], [1, 0], [1, 1], [0, 1]],
                                                                               "cornerSource": "prefill"}]}, "corner"))

    # ---- box mode + identity pass ------------------------------------------------------

    @staticmethod
    def box(tid, x0, y0, x1, y1, **kw):
        t = {"id": tid, "corners": lc.box_corners(x0, y0, x1, y1), "estimated": [False] * 4, "cornerSource": "box",
             "outcome": "card", "identity": None, "identitySource": None, "eligible": None, "conditions": {},
             "labelSource": "manual"}
        t.update(kw)
        return t

    @staticmethod
    def rotated(cx, cy, w, h, deg):
        t = math.radians(deg)
        return [[round(cx + x * math.cos(t) - y * math.sin(t), 1), round(cy + x * math.sin(t) + y * math.cos(t), 1)]
                for x, y in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]

    def box_frames(self):
        return [
            {"name": "f00001.jpg", "t": 0, "frameW": 1920, "frameH": 1080, "done": True, "targets": [
                self.box("B001", 100, 100, 163, 188),
                self.box("B002", 300, 100, 363, 188, outcome="card-back", eligible="no", conditions={"faceUp": False}),
                self.box("B003", 500, 100, 563, 188, ignore=True, eligible="no"),
                self.box("B004", 700, 100, 763, 188, conditions={"visibleShare": "most"})]},
            {"name": "f00002.jpg", "t": 1, "frameW": 1920, "frameH": 1080, "done": True, "targets": [
                self.box("B001", 110, 100, 173, 188, identity="TOY-120", identitySource="decklist", eligible="yes"),
                self.box("B002", 900, 500, 1020, 700)]},
        ]

    def test_identify_undo_of_an_edit_to_a_box_stored_without_angle(self):
        """A tilted box stored with no `angle` (its top edge's direction is its angle), edited in the
        Names pass and saved, then undone: the page sends the box back with its corners exactly as
        stored and its angle written out, and the server takes it as an edit. The rule for an edit
        is unchanged: the same box with no angle, against the edited copy, is still refused."""
        tilt = self.rotated(400, 300, 63, 88, 30)
        stored = self.box("B001", 100, 100, 163, 188)
        stored["corners"] = tilt
        stored.pop("angle", None)
        folder = self.tmp / "lab-ed-noangle" / "vidA"
        folder.mkdir(parents=True)
        (folder / "meta.json").write_text(json.dumps({"schemaVersion": 2, "tool": "labeler", "setId": "vidA", "frameAsset": "vidA",
                                                      "mode": "box", "role": "training"}))
        frame = {"name": "f00001.jpg", "t": 0, "frameW": 1920, "frameH": 1080, "done": True, "targets": [stored]}
        (folder / "frames.jsonl").write_text(json.dumps(frame) + "\n")
        self.config("lab-ed-noangle", mode="identify", role="training")
        url = "/api/labels/vidA/frames/f00001.jpg"
        edited = json.loads(json.dumps(frame))
        edited["targets"][0].update(corners=self.rotated(420, 300, 63, 88, 30), angle=30)
        st, res = self.post(url, {"frame": edited})
        self.assertEqual(st, 200, res)
        as_stored = json.loads(json.dumps(frame))  # the undo's snapshot, unchanged
        st, res = self.post(url, {"frame": as_stored})
        self.assertEqual(st, 409, "no angle on a tilted box, against the edited copy: refused as before")
        self.assertIn("is not the direction of its top edge", res["error"])
        undone = json.loads(json.dumps(frame))
        undone["targets"][0]["angle"] = 30  # what the page sends (names.js settleProvenance)
        st, res = self.post(url, {"frame": undone})
        self.assertEqual(st, 200, res)
        saved = self.read_frames("lab-ed-noangle", "vidA")[0]["targets"][0]
        self.assertEqual((saved["corners"], saved["angle"], saved["labelSource"]), (tilt, 30, stored["labelSource"]))

    def test_identify_box_edits(self):
        """The Names pass may move, resize or rotate a box of a training or development box set, and
        records its provenance as the Boxes pass does; a test set's boxes stay locked."""
        c = lc.box_corners(100, 100, 163, 188)
        model = self.box("B001", 100, 100, 163, 188, cornerSource="prefill", labelSource="prefill-accepted",
                         prefill={"i": 0, "corners": c, "outcome": "card", "score": 0.9})
        kept = self.box("B002", 300, 100, 363, 188, labelSource="carried", carriedFrom={"frame": "f00002.jpg", "target": "B002"})
        plain = self.box("B003", 500, 100, 563, 188)
        frame = {"name": "f00001.jpg", "t": 0, "frameW": 1920, "frameH": 1080, "done": True, "targets": [model, kept, plain]}
        url = "/api/labels/vidA/frames/f00001.jpg"
        for labels in ("lab-ed-names", "lab-ed-boxes"):
            self.config(labels, mode="box", role="training")
            self.assertEqual(self.post(url, {"frame": frame})[0], 200, labels)
        edited = json.loads(json.dumps(self.read_frames("lab-ed-names", "vidA")[0]))
        moves = {"B001": lc.box_corners(104, 102, 170, 190), "B002": lc.box_corners(310, 110, 373, 198), "B003": self.rotated(531, 144, 63, 88, 12)}
        for t in edited["targets"]:
            t["corners"] = moves[t["id"]]
            if t["id"] == "B003":
                t["angle"] = 12
        # what the page writes after the edit: G.editProvenance, the Boxes pass's rule
        by = {t["id"]: t for t in edited["targets"]}
        by["B001"].update(labelSource="prefill-corrected", cornerSource="prefill-edited")
        by["B002"].update(labelSource="carried-corrected")
        # the same edit in the Boxes pass and in the Names pass: the same stored boxes
        self.config("lab-ed-boxes", mode="box", role="training")
        self.assertEqual(self.post(url, {"frame": edited})[0], 200)
        self.config("lab-ed-names", mode="identify", role="training")
        st, res = self.post(url, {"frame": edited})
        self.assertEqual(st, 200, res)
        names_row, boxes_row = self.read_frames("lab-ed-names", "vidA")[0], self.read_frames("lab-ed-boxes", "vidA")[0]
        self.assertEqual(names_row["targets"], boxes_row["targets"])
        self.assertEqual([t["labelSource"] for t in names_row["targets"]], ["prefill-corrected", "carried-corrected", "manual"])
        self.assertEqual(names_row["targets"][0]["prefill"], model["prefill"], "the proposal is kept")
        # refused: provenance the edit does not give, a changed proposal, ignore or zOrder with an edit
        for tid, change in (("B001", {"labelSource": "prefill-accepted"}), ("B001", {"cornerSource": "prefill"}),
                            ("B001", {"prefill": None}), ("B002", {"labelSource": "carried"}), ("B002", {"carriedFrom": None}),
                            ("B003", {"labelSource": "carried-corrected"}), ("B003", {"ignore": True}), ("B003", {"zOrder": 3})):
            bad = json.loads(json.dumps(names_row))
            t = next(x for x in bad["targets"] if x["id"] == tid)
            t["corners"] = lc.box_corners(600, 300, 663, 388)
            t.pop("angle", None)
            t.update(change)
            st, res = self.post(url, {"frame": bad})
            self.assertEqual(st, 409, (tid, change, res))
        # an undo after a saved edit: back to the old place, which the server sees as one more edit
        # (the page settles its provenance from the server's copy: names.js settleProvenance)
        undone = json.loads(json.dumps(names_row))
        for t in undone["targets"]:
            t["corners"] = next(x for x in frame["targets"] if x["id"] == t["id"])["corners"]
            t.pop("angle", None)
        stale = json.loads(json.dumps(undone))
        stale["targets"][1]["labelSource"] = "carried"  # the snapshot's own, before the edit: refused
        self.assertEqual(self.post(url, {"frame": stale})[0], 409)
        by = {t["id"]: t for t in undone["targets"]}
        by["B001"].update(labelSource="prefill-accepted", cornerSource="prefill")  # back on its proposal
        st, res = self.post(url, {"frame": undone})
        self.assertEqual(st, 200, res)
        self.assertEqual([t["labelSource"] for t in self.read_frames("lab-ed-names", "vidA")[0]["targets"]],
                         ["prefill-accepted", "carried-corrected", "manual"])
        # a save during a drag: the box partway, already with the edit's provenance; then the end
        for x in (310, 330):
            mid = json.loads(json.dumps(self.read_frames("lab-ed-names", "vidA")[0]))
            mid["targets"][0].update(corners=lc.box_corners(x, 300, x + 63, 388), labelSource="prefill-corrected", cornerSource="prefill-edited")
            st, res = self.post(url, {"frame": mid})
            self.assertEqual(st, 200, (x, res))
        # a development set: allowed too
        self.config("lab-ed-dev", mode="box", role="development")
        self.assertEqual(self.post(url, {"frame": dict(frame, targets=[plain])})[0], 200)
        self.config("lab-ed-dev", mode="identify", role="development")
        st, res = self.post(url, {"frame": dict(frame, targets=[dict(plain, corners=lc.box_corners(510, 100, 573, 188))])})
        self.assertEqual(st, 200, res)
        # a test set: refused, with the one line the page shows
        self.config("lab-ed-test", mode="box", role="test")
        self.assertEqual(self.post(url, {"frame": dict(frame, targets=[plain])})[0], 200)
        self.config("lab-ed-test", mode="identify", role="test")
        st, res = self.post(url, {"frame": dict(frame, targets=[dict(plain, corners=lc.box_corners(510, 100, 573, 188))])})
        self.assertEqual(st, 409)
        self.assertIn("In a test set, boxes are not moved, resized or rotated here; the top edge can still be turned.", res["error"])
        self.assertTrue(self.get("/api/config")[1]["identifyEdits"])

    def test_box_mode_roundtrip_shared_corner_format(self):
        self.config("lab-box", mode="box")
        for fr in self.box_frames():
            st, res = self.post(f"/api/labels/vidA/frames/{fr['name']}", {"frame": fr})
            self.assertEqual(st, 200, res)
        rows = self.read_frames("lab-box", "vidA")
        self.assertEqual(len(rows), 2)
        b1 = rows[0]["targets"][0]
        self.assertEqual(b1["corners"], [[100, 100], [163, 100], [163, 188], [100, 188]])
        self.assertEqual((b1["cornerSource"], b1["derived"]["aabb"], b1["derived"]["rotationDeg"]), ("box", [100.0, 100.0, 63.0, 88.0], 0.0))
        self.assertTrue(rows[0]["targets"][2]["ignore"])
        self.assertEqual(rows[0]["targets"][1]["outcome"], "card-back")
        meta = json.loads((self.tmp / "lab-box/vidA/meta.json").read_text())
        self.assertEqual((meta["mode"], meta["role"]), ("box", "development"))
        # a slanted "box" is refused; the box set reads as a corner row set (a later corner pass
        # can refine it) but opens read-only in corner mode, as any other mode mismatch
        bad = self.box_frames()[0]
        bad["targets"][0]["corners"][1][1] += 5
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": bad})[0], 400)
        self.assertEqual(lc.validate_frame(rows[0], "corner"), [])
        self.config("lab-box", mode="corner")
        self.assertIn("mode=box", self.get("/api/labels/vidA")[1]["readOnly"])
        # a rotated rectangle (30°, corners in its own order, the angle stored) is accepted and
        # derives its rotation; a quad that is not a rectangle is refused
        self.config("lab-box", mode="box")
        rot = self.box_frames()[1]
        rot["targets"][1].update(corners=self.rotated(960, 600, 120, 168, 30), angle=30, zOrder=2)
        st, res = self.post("/api/labels/vidA/frames/f00002.jpg", {"frame": rot})
        self.assertEqual(st, 200, res)
        got = self.read_frames("lab-box", "vidA")[1]["targets"][1]
        self.assertEqual((got["angle"], got["zOrder"], got["cornerSource"]), (30, 2, "box"))
        self.assertAlmostEqual(got["derived"]["rotationDeg"], 30.0, delta=0.1)
        trap = self.box_frames()[1]
        trap["targets"][1]["corners"] = [[900, 500], [1020, 500], [1000, 700], [920, 700]]
        st, res = self.post("/api/labels/vidA/frames/f00002.jpg", {"frame": trap})
        self.assertEqual(st, 400)
        self.assertIn("rectangle", res["error"])
        # propagated provenance is refused in a development set
        pf = self.box_frames()[1]
        pf["targets"][0].update(labelSource="propagated", cornerSource="propagated")
        self.config("lab-box", mode="box")
        self.assertEqual(self.post("/api/labels/vidA/frames/f00002.jpg", {"frame": pf})[0], 400)

    def test_identify_pass(self):
        self.config("lab-id", mode="box", decklist=[str(self.tmp / "deck.txt")])
        for fr in self.box_frames():
            self.assertEqual(self.post(f"/api/labels/vidA/frames/{fr['name']}", {"frame": fr})[0], 200)
        before = {r["name"]: r for r in self.read_frames("lab-id", "vidA")}
        self.config("lab-id", mode="identify", decklist=[str(self.tmp / "deck.txt")])
        st, got = self.get("/api/labels/vidA")
        self.assertIsNone(got["readOnly"])
        # the walk skips the back, the ignored box and the box that already has an identity
        self.assertEqual(got["identifyQueue"], [{"frame": "f00001.jpg", "target": "B001"}, {"frame": "f00001.jpg", "target": "B004"},
                                                {"frame": "f00002.jpg", "target": "B002"}])
        self.assertEqual(self.get("/api/identify-queue/vidA")[1]["queue"], got["identifyQueue"])
        self.assertEqual(got["decklist"]["ids"], ["TOY-001", "TOY-120"])
        # answer one: identity + eligibility + a tag; geometry untouched → saved
        fr = json.loads(json.dumps(before["f00001.jpg"]))
        fr["targets"][0].update(identity="TOY-001", identitySource="decklist", eligible="yes")
        fr["done"] = False  # the pass cannot un-confirm a frame
        st, res = self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": fr})
        self.assertEqual(st, 200, res)
        row = next(r for r in self.read_frames("lab-id", "vidA") if r["name"] == "f00001.jpg")
        self.assertEqual((row["targets"][0]["identity"], row["done"]), ("TOY-001", True))
        self.assertEqual(row["targets"][0]["corners"], before["f00001.jpg"]["targets"][0]["corners"])
        meta = json.loads((self.tmp / "lab-id/vidA/meta.json").read_text())
        self.assertEqual(meta["mode"], "box", "the set keeps its own mode")
        self.assertIn("identifiedAt", meta)
        self.assertEqual(self.get("/api/labels/vidA")[1]["identifyQueue"],
                         [{"frame": "f00001.jpg", "target": "B004"}, {"frame": "f00002.jpg", "target": "B002"}])
        # refused: a removed box, a new box, ignore flipped, a new frame (a moved box: test_identify_box_edits)
        for change in ("remove", "add", "ignore"):
            g = json.loads(json.dumps(fr))
            if change == "remove":
                g["targets"].pop()
            elif change == "add":
                g["targets"].append(self.box("B009", 1, 1, 50, 70))
            else:
                g["targets"][3]["ignore"] = True
            self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": g})[0], 409, change)
        new = {"name": "f00003.jpg", "t": 2, "targets": []}
        self.assertEqual(self.post("/api/labels/vidA/frames/f00003.jpg", {"frame": new})[0], 409)
        # the top edge may turn (same four points, order rotated, angle + 90*k)
        cur = next(r for r in self.read_frames("lab-id", "vidA") if r["name"] == "f00001.jpg")
        self.assertTrue(self.get("/api/config")[1]["identifyTurns"])
        g = json.loads(json.dumps(cur))
        q = g["targets"][3]["corners"]
        g["targets"][3]["corners"] = [q[1], q[2], q[3], q[0]]
        g["targets"][3]["angle"] = 90
        st, res = self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": g})
        self.assertEqual(st, 200, res)
        row = next(r for r in self.read_frames("lab-id", "vidA") if r["name"] == "f00001.jpg")
        t4 = row["targets"][3]
        self.assertEqual((t4["corners"], t4["angle"], t4["orientationFixedIn"], t4["labelSource"], row["done"]),
                         ([q[1], q[2], q[3], q[0]], 90, "identify", "manual", True))
        self.assertNotIn("orientationFixedIn", row["targets"][0])
        # refused: the same turn with a point moved, a mismatched angle, a mirrored order
        for bad in ("moved", "angle", "mirror"):
            b = json.loads(json.dumps(row))
            if bad == "moved":
                b["targets"][3]["corners"] = [q[2], q[3], [q[0][0] + 1, q[0][1]], q[1]]
                b["targets"][3]["angle"] = 180
            elif bad == "angle":
                b["targets"][3]["corners"] = [q[2], q[3], q[0], q[1]]
                b["targets"][3]["angle"] = 90
            else:
                b["targets"][3]["corners"] = [q[1], q[0], q[3], q[2]]
            st, res = self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": b})
            self.assertEqual(st, 409, (bad, res))
        self.assertEqual(next(r for r in self.read_frames("lab-id", "vidA") if r["name"] == "f00001.jpg"), row)
        # timing lands in the set's log with the pass's mode
        self.assertEqual(self.post("/api/timing/vidA", {"events": [{"ev": "committed", "ts": 1, "mode": "identify"}]})[0], 200)
        # identify opens only box/corner/training sets of its own role
        self.config("lab-id", mode="identify", role="training")
        self.assertIn("role=development", self.get("/api/labels/vidA")[1]["readOnly"])
        self.config("lab-idp")  # a point set
        pts = lc.points_for_frame(1, 7, 12)
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": {"name": "f00001.jpg", "frameW": 1920, "frameH": 1080, "points": pts}})[0], 200)
        self.config("lab-idp", mode="identify")
        self.assertIn("identify mode opens", self.get("/api/labels/vidA")[1]["readOnly"])
        self.assertIn("draw boxes first", self.get("/api/labels/vidB")[1]["readOnly"])
        self.assertEqual(self.post("/api/labels/vidB/frames/f00001.jpg", {"frame": {"name": "f00001.jpg", "targets": []}})[0], 409)

    def test_decklists_per_video_two_lists(self):
        dd = self.tmp / "decklists"
        dd.mkdir(exist_ok=True)
        (dd / "vidA.player-a.txt").write_text("# label: Player A\n3 Amber Kitemaker\nNo Such Card\n")
        (dd / "vidA.player-b.txt").write_text("2 TOY-120\nRed Marker\nAmber Kitemaker\n")
        (dd / "vidAB.txt").write_text("TOY-290\n")  # another video whose id starts the same: not loaded
        self.config("lab-dk", mode="box", decklists_dir=str(dd))
        st, got = self.get("/api/labels/vidA")
        d = got["decklist"]
        self.assertEqual([(li["label"], li["ids"]) for li in d["lists"]],
                         [("Player A", ["TOY-001"]), ("player-b", ["TOY-120", "EXT-R01", "TOY-001"])])
        self.assertEqual(d["ids"], ["TOY-001", "TOY-120", "EXT-R01"])
        self.assertEqual(d["unresolved"], ["No Such Card"])
        self.assertIsNone(self.get("/api/labels/vidB")[1]["decklist"])
        # stored with the set on save
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": {"name": "f00001.jpg", "frameW": 1920, "frameH": 1080, "targets": []}})[0], 200)
        meta = json.loads((self.tmp / "lab-dk/vidA/meta.json").read_text())
        self.assertEqual(len(meta["decklist"]["lists"]), 2)
        # --decklist overrides the folder; two --decklist values for one set give two lists
        (self.tmp / "p2.txt").write_text("TOY-290\n")
        self.config("lab-dk", mode="box", decklists_dir=str(dd), decklist=[f"vidA={self.tmp / 'deck.txt'}", f"vidA={self.tmp / 'p2.txt'}"])
        d = self.get("/api/labels/vidA")[1]["decklist"]
        self.assertEqual([li["label"] for li in d["lists"]], ["Decklist 1", "Decklist 2"])
        self.assertEqual(d["ids"], ["TOY-001", "TOY-120", "TOY-290"])
        # a single decklist keeps the earlier one-file shape
        self.config("lab-dk", mode="box", decklists_dir=str(dd), decklist=[str(self.tmp / "deck.txt")])
        d = self.get("/api/labels/vidA")[1]["decklist"]
        self.assertEqual(d["file"], "deck.txt", "a file is recorded by its name, never by its full path")

    def test_decklist_from_text(self):
        self.config("lab-dl0", mode="box")
        catalog = serve.load_catalog()
        text = "Main Deck\n3x Amber Kitemaker\nKite x2\nred marker (12)\nNot Real\n"
        res = decklist_from_text.convert(text, catalog)
        self.assertEqual(res["unmatched"], ["Main Deck", "Not Real"])
        body = decklist_from_text.render(res, "Player A", "vidA")
        parsed = lc.parse_decklist(body, catalog)
        self.assertEqual(parsed["ids"], ["TOY-001", "TOY-120", "EXT-R01"])
        self.assertEqual(parsed["counts"], {"TOY-001": 3, "TOY-120": 2, "EXT-R01": 12})
        self.assertEqual(lc.decklist_label(body, "x"), "Player A")
        self.assertIn("# UNMATCHED: Not Real", body)
        out = self.tmp / "dl-out"
        src = self.tmp / "pasted.txt"
        src.write_text(text)
        cat = ["--catalog", str(self.tmp / "catalog.json")]
        self.assertEqual(quiet(decklist_from_text.main, cat + ["--video", "vidA", "--label", "Player A", "--in", str(src), "--out-dir", str(out)]), 0)
        self.assertTrue((out / "vidA.player-a.txt").exists())
        with self.assertRaises(SystemExit):  # no silent overwrite
            quiet(decklist_from_text.main, cat + ["--video", "vidA", "--label", "Player A", "--in", str(src), "--out-dir", str(out)])
        self.assertEqual(quiet(decklist_from_text.main, cat + ["--video", "vidA", "--in", str(src), "--out-dir", str(out), "--strict"]), 1)
        self.assertFalse((out / "vidA.txt").exists())
        with self.assertRaises(SystemExit):  # an id with a trailing line break is not a video id
            quiet(decklist_from_text.main, cat + ["--video", "vidB\n", "--in", str(src), "--out-dir", str(out)])
        self.assertFalse(list(out.glob("vidB*")))
        # the written file is what the server loads for the video
        self.config("lab-dl", mode="box", decklists_dir=str(out))
        self.assertEqual(self.get("/api/labels/vidA")[1]["decklist"]["lists"][0]["label"], "Player A")

    def test_frames_dir_per_asset(self):
        # an asset that names its own framesDir (relative to the sample file) is served from there;
        # a frame name may carry a prefix and dots, as the inference command names video frames
        vd = self.tmp / "elsewhere" / "vidC" / "frames"
        vd.mkdir(parents=True)
        (vd / "my.video-f00004.jpg").write_bytes(b"\xff\xd8from-elsewhere")
        sample = {"assets": [{"assetId": "vidC", "framesDir": "elsewhere/vidC/frames", "frames": [{"t": 3, "name": "my.video-f00004.jpg"}]}]}
        (self.tmp / "sample-elsewhere.json").write_text(json.dumps(sample))
        serve.configure(args(mode="box", labels_dir=str(self.tmp / "lab-fd"), sample=str(self.tmp / "sample-elsewhere.json"),
                             frames_dir=str(self.tmp / "frames"), decklists_dir=str(self.tmp / "none")))
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/frames/vidC/my.video-f00004.jpg") as r:
            self.assertEqual(r.read(), b"\xff\xd8from-elsewhere")
        self.assertEqual(self.get("/frames/vidC/..%2F..%2F..%2Fsample.json")[0], 400)
        self.assertEqual(lc.frame_index("my.video-f00004.jpg"), 4)
        self.assertEqual(lc.frame_index("f00004.jpg"), 4)

    def test_throughput_per_mode(self):
        self.config("lab-tp", mode="box")
        t0 = 1_700_000_000_000
        evs = [{"ev": "session-open", "ts": t0, "mode": "box"}]
        ts = t0
        for i in range(6):  # 6 boxes, 5 s each, one of them a back
            ts += 5000
            evs.append({"ev": "committed", "ts": ts, "mode": "box", "frame": "f00001.jpg", "target": f"B00{i}",
                        "outcome": "card-back" if i == 0 else "card", "ignore": i == 1})
        ts += 1000  # a seventh box, drawn and deleted: not a label
        evs.append({"ev": "committed", "ts": ts, "mode": "box", "frame": "f00001.jpg", "target": "B009", "outcome": "card"})
        ts += 1000
        evs.append({"ev": "deleted", "ts": ts, "mode": "box", "frame": "f00001.jpg", "target": "B009"})
        evs.append({"ev": "frame-confirmed", "ts": ts, "mode": "box", "frame": "f00001.jpg", "n": 6})
        ts += 600_000  # a break, then the identity pass over the same boxes
        evs.append({"ev": "session-open", "ts": ts, "mode": "identify"})
        for i in range(2, 6):  # 4 identities, 10 s each, one unknown; the same targets as the boxes
            ts += 10_000
            evs.append({"ev": "committed", "ts": ts, "mode": "identify", "frame": "f00001.jpg", "target": f"B00{i}",
                        "outcome": "card", "identityKnown": i != 5})
        ts += 3000
        evs.append({"ev": "corrected", "ts": ts, "mode": "identify", "frame": "f00001.jpg", "target": "B002"})
        self.assertEqual(self.post("/api/timing/vidA", {"events": evs})[0], 200)
        r = report_throughput.report(self.tmp / "lab-tp", "vidA", idle=120)
        b, i = r["byMode"]["box"], r["byMode"]["identify"]
        self.assertEqual((b["unit"], b["committed"], b["deletedAfterCommit"], b["activeSec"], b["backs"], b["ignored"]),
                         ("boxes", 6, 1, 32.0, 1, 1))
        self.assertEqual(b["perActiveHour"], round(6 / (32 / 3600), 1))
        self.assertEqual((b["framesConfirmed"], b["reviewedTargets"]), (1, 6))
        # pasted / duplicated / inserted boxes and carried-over boxes are not drawn boxes
        r2 = report_throughput.report(self.tmp / "lab-tp", "vidA", idle=120)
        self.assertEqual((r2["byMode"]["box"]["toolMade"], r2["byMode"]["box"]["carriedOver"]), ({"paste": 0, "duplicate": 0, "insert": 0}, 0))
        # the break (capped at 120 s) is booked to the identify session that it opens
        self.assertEqual((i["unit"], i["committed"], i["activeSec"], i["corrections"]), ("identities", 4, 120 + 40 + 3, 1))
        self.assertEqual((i["identityKnown"], i["identityUnknown"]), (3, 1))
        self.assertEqual(r["committed"], 10, "a box and its identity are two different labels")

    def test_throughput_tool_made_boxes(self):
        """A paste / duplicate / row-insert commit carries `origin` and is counted apart from the
        drawn boxes; carried-over boxes are only reviewed; a frame confirmed twice counts once and
        an unconfirm takes it back."""
        self.config("lab-tm", mode="box", role="training")
        t0 = 1_700_000_000_000
        ev = lambda k, **kw: dict({"ts": t0 + k * 1000, "mode": "box", "frame": "f00001.jpg"}, **kw)  # noqa: E731
        evs = [ev(0, ev="session-open"),
               ev(1, ev="committed", target="B001", outcome="card"),
               ev(2, ev="pasted", target="B002", source={"frame": "f00001.jpg", "target": "B001"}),
               ev(3, ev="committed", target="B002", outcome="card", origin="paste"),
               ev(4, ev="duplicated", target="B003"),
               ev(5, ev="committed", target="B003", outcome="card", origin="duplicate"),
               ev(6, ev="deleted", target="B003"),
               ev(7, ev="committed", target="B004", outcome="card", origin="insert"),
               ev(8, ev="committed", target="B005", outcome="card", origin="snap"),
               ev(9, ev="frame-confirmed", n=4),
               ev(10, ev="frame-unconfirmed"),
               ev(11, ev="frame-confirmed", n=4),
               ev(12, ev="carried-over", n=4, frame="f00002.jpg"),
               ev(13, ev="corrected", target="B001", frame="f00002.jpg", labelSource="propagated-corrected"),
               ev(14, ev="frame-confirmed", n=4, frame="f00002.jpg"),
               ev(15, ev="frame-confirmed", n=3, frame="f00003.jpg"),
               ev(16, ev="frame-unconfirmed", frame="f00003.jpg")]
        self.assertEqual(self.post("/api/timing/vidA", {"events": evs})[0], 200)
        b = report_throughput.report(self.tmp / "lab-tm", "vidA", idle=120)["byMode"]["box"]
        self.assertEqual(b["committed"], 2, "drawn boxes only (a snap click is drawn by hand)")
        self.assertEqual(b["toolMade"], {"paste": 1, "duplicate": 0, "insert": 1})
        self.assertEqual((b["carriedOver"], b["corrections"]), (4, 1))
        self.assertEqual((b["framesConfirmed"], b["reviewedTargets"]), (2, 8))

    def test_throughput_corrections_by_origin(self):
        """The correction rate is corrections of DRAWN boxes over drawn boxes; corrections
        of pasted / carried boxes are listed apart; a frame's carry-over counts once (its latest);
        boxes placed by n+click / snap are drawn and counted as such."""
        self.config("lab-co", mode="box", role="development")
        t0 = 1_700_000_000_000
        ev = lambda k, **kw: dict({"ts": t0 + k * 1000, "mode": "box", "frame": "f00001.jpg"}, **kw)  # noqa: E731
        evs = [ev(0, ev="session-open"),
               ev(1, ev="committed", target="B001", outcome="card"),
               ev(2, ev="committed", target="B002", outcome="card", origin="default-box"),
               ev(3, ev="committed", target="B003", outcome="card", origin="snap"),
               ev(4, ev="committed", target="B004", outcome="card"),
               ev(5, ev="corrected", target="B001", origin="drawn"),
               ev(6, ev="corrected", target="B002", origin="default-box"),
               ev(7, ev="committed", target="B005", outcome="card", origin="paste"),
               ev(8, ev="corrected", target="B005", origin="paste"),
               ev(9, ev="carried-over", n=3, frame="f00002.jpg"),
               ev(10, ev="carried-over", n=3, frame="f00002.jpg"),   # re-armed and carried again
               ev(11, ev="corrected", target="B001", frame="f00002.jpg", origin="carried", labelSource="carried-corrected"),
               ev(12, ev="corrected", target="B009")]                # an older log without origin: drawn
        self.assertEqual(self.post("/api/timing/vidA", {"events": evs})[0], 200)
        r = report_throughput.report(self.tmp / "lab-co", "vidA", idle=120)
        b = r["byMode"]["box"]
        self.assertEqual(b["committed"], 4)
        self.assertEqual(b["placedByClick"], {"snap": 1, "default-box": 1})
        self.assertEqual((b["corrections"], b["correctionsDrawn"]), (5, 3))
        self.assertEqual(b["correctionsByOrigin"], {"drawn": 2, "default-box": 1, "paste": 1, "carried": 1})
        self.assertEqual(b["correctionRate"], 0.75)
        self.assertEqual(r["correctionRate"], 0.75)
        self.assertEqual(b["carriedOver"], 3)
        out = subprocess.run([sys.executable, "-B", str(HERE / "report_throughput.py"), "vidA", "--labels-dir", str(self.tmp / "lab-co")],
                             capture_output=True, text=True)
        self.assertIn("4 boxes drawn (of them placed with n+click 1, snap 1)", out.stdout)
        self.assertIn("correction rate on drawn boxes 75.0 %", out.stdout)
        self.assertIn("carried 1, paste 1", out.stdout)


    # ---- box mode with prefill (role=training only) ----------------------------------------

    def write_box_prefill(self):
        """One JSONL record per frame, naming its set (frame names repeat across videos)."""
        rows = [{"set": "vidA", "name": "f00001.jpg", "boxes": [
                    {"box": [100, 100, 63, 88], "outcome": "card", "score": 0.93},
                    {"box": [300, 100, 63, 88], "outcome": "card-back", "score": 0.61}]},
                {"set": "vidB", "name": "f00001.jpg", "boxes": [{"box": [5, 5, 50, 70], "outcome": "card", "score": 0.5}]},
                {"set": "vidA", "name": "f00002.jpg", "boxes": []}]
        path = self.tmp / "box-prefill.jsonl"
        path.write_text("".join(json.dumps(r) + "\n" for r in rows))
        return path

    def prefill_row(self, props, done=True):
        acc = {"id": "P001", "corners": props[0]["corners"], "estimated": [False] * 4, "cornerSource": "prefill",
               "outcome": "card", "identity": None, "eligible": None, "conditions": {}, "labelSource": "prefill-accepted",
               "prefill": {"i": 0, "corners": props[0]["corners"], "outcome": "card", "score": 0.93}}
        moved = [[x + 4, y] for x, y in props[1]["corners"]]
        cor = {"id": "P002", "corners": moved, "estimated": [False] * 4, "cornerSource": "prefill-edited",
               "outcome": "card-back", "identity": None, "eligible": "no", "conditions": {"faceUp": False},
               "labelSource": "prefill-corrected",
               "prefill": {"i": 1, "corners": props[1]["corners"], "outcome": "card-back", "score": 0.61}}
        return {"name": "f00001.jpg", "t": 0, "frameW": 1920, "frameH": 1080, "done": done, "prefillOffered": True,
                "targets": [acc, cor]}

    def test_box_prefill_training_set(self):
        path = self.write_box_prefill()
        self.config("lab-bp", mode="box", role="training", prefill=[str(path)])
        self.assertTrue(self.get("/api/config")[1]["prefill"])
        st, p = self.get("/api/prefill/vidA")
        self.assertEqual(st, 200, p)
        props = p["frames"]["f00001.jpg"]
        self.assertEqual(len(props), 2, "vidB's row for the same frame name is not vidA's")
        self.assertEqual(props[0]["corners"], [[100.0, 100.0], [163.0, 100.0], [163.0, 188.0], [100.0, 188.0]])
        self.assertEqual((props[0]["box"], props[0]["outcome"], props[0]["score"]), ([100.0, 100.0, 63.0, 88.0], "card", 0.93))
        self.assertEqual(props[1]["outcome"], "card-back")
        self.assertEqual(p["frames"]["f00002.jpg"], [])
        self.assertEqual(len(self.get("/api/prefill/vidB")[1]["frames"]["f00001.jpg"]), 1)
        # an accepted and a corrected detector box save, the derived geometry as for any box
        st, res = self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": self.prefill_row(props)})
        self.assertEqual(st, 200, res)
        row = self.read_frames("lab-bp", "vidA")[0]
        self.assertEqual([t["labelSource"] for t in row["targets"]], ["prefill-accepted", "prefill-corrected"])
        self.assertEqual(row["targets"][0]["prefill"]["score"], 0.93)
        self.assertEqual(row["targets"][0]["derived"]["aabb"], [100.0, 100.0, 63.0, 88.0])
        self.assertTrue(row["prefillOffered"])
        meta = json.loads((self.tmp / "lab-bp/vidA/meta.json").read_text())
        self.assertEqual((meta["mode"], meta["role"], meta["prefillUsed"], meta["blind"]), ("box", "training", True, False))
        self.assertEqual(meta["prefillSource"], path.name, "the file's name, never its full path")
        # an unreviewed detector box: saved on an open frame, refused on a confirmed one
        pend = self.prefill_row(props, done=False)
        pend["targets"][0].update(pending=True)
        del pend["targets"][0]["labelSource"]
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": pend})[0], 200)
        pend["done"] = True
        st, res = self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": pend})
        self.assertEqual(st, 400)
        self.assertIn("unreviewed", res["error"])
        # the identity pass over this box set keeps the review provenance
        self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": self.prefill_row(props)})
        self.config("lab-bp", mode="identify", role="training")
        named = self.prefill_row(props)
        named["targets"][0].update(identity="TOY-001", eligible="yes", identitySource="current-frame")
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": named})[0], 200)
        named["targets"][0]["labelSource"] = "prefill-corrected"
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": named})[0], 409)
        # box mode on role=training without --prefill: works, offers nothing, still saves the reviewed rows
        self.config("lab-bp", mode="box", role="training")
        self.assertFalse(self.get("/api/config")[1]["prefill"])
        self.assertEqual(self.get("/api/prefill/vidA")[0], 404)
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": self.prefill_row(props)})[0], 200)

    def test_box_prefill_refused_outside_training(self):
        path = self.write_box_prefill()
        props = [{"corners": lc.box_corners(100, 100, 163, 188)}, {"corners": lc.box_corners(300, 100, 363, 188)}]
        for role in ("development", "test"):
            self.config(f"lab-bp-{role}", mode="box", role=role)
            self.assertFalse(self.get("/api/config")[1]["prefill"])
            self.assertEqual(self.get("/api/prefill/vidA")[0], 404)
            st, res = self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": self.prefill_row(props)})
            self.assertEqual(st, 400, (role, res))
            self.assertIn("prefill", res["error"])
            with self.assertRaises(ValueError):
                self.config(f"lab-bp-{role}", mode="box", role=role, prefill=[str(path)])
        # a development box set opened by a box + training run is read-only (role mismatch): no prefill there either
        self.config("lab-bp-development", mode="box", role="development")
        ok = self.box_frames()[0]
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": ok})[0], 200)
        self.config("lab-bp-development", mode="box", role="training", prefill=[str(path)])
        self.assertIn("role=development", self.get("/api/labels/vidA")[1]["readOnly"])
        self.assertEqual(self.get("/api/prefill/vidA")[0], 403)

    def test_throughput_box_prefill(self):
        self.config("lab-tpp", mode="box", role="training")
        t0 = 1_700_000_000_000
        ev = lambda k, **kw: dict({"ts": t0 + k * 1000, "mode": "box", "frame": "f00001.jpg"}, **kw)  # noqa: E731
        evs = [ev(0, ev="session-open"),
               ev(1, ev="prefill-offered", n=5, suggestions=0, heldBack=0),
               ev(3, ev="committed", target="P001", outcome="card", labelSource="prefill-accepted", origin="prefill", via="a"),
               ev(5, ev="committed", target="P002", outcome="card", labelSource="prefill-corrected", origin="prefill"),
               ev(6, ev="prefill-rejected", target="P003", reviewed=False),
               ev(7, ev="prefill-rejected", target="P004", reviewed=False),
               ev(8, ev="prefill-unrejected", target="P004", via="history"),       # an undo brings it back
               ev(9, ev="committed", target="B006", outcome="card"),                 # drawn
               ev(10, ev="corrected", target="B006", origin="drawn"),
               ev(11, ev="committed", target="P004", outcome="card", labelSource="prefill-accepted", origin="prefill", via="frame-enter"),
               ev(11, ev="committed", target="P005", outcome="card-back", labelSource="prefill-accepted", origin="prefill", via="frame-enter"),
               ev(11, ev="frame-confirmed", n=5),
               ev(13, ev="corrected", target="P001", origin="prefill", labelSource="prefill-corrected", frame="f00001.jpg"),
               # a frame without prefill: two drawn boxes, not in the prefill time
               ev(20, ev="shown", frame="f00002.jpg"),
               ev(25, ev="committed", target="B001", outcome="card", frame="f00002.jpg"),
               ev(30, ev="committed", target="B002", outcome="card", frame="f00002.jpg")]
        self.assertEqual(self.post("/api/timing/vidA", {"events": evs})[0], 200)
        r = report_throughput.report(self.tmp / "lab-tpp", "vidA", idle=120)
        b = r["byMode"]["box"]
        self.assertEqual(b["committed"], 3, "drawn boxes only: detector boxes are never drawn")
        self.assertEqual((b["correctionsDrawn"], b["correctionRate"]), (1, round(1 / 3, 4)))
        self.assertEqual(b["correctionsByOrigin"], {"drawn": 1, "prefill": 1})
        pf = b["prefill"]
        self.assertEqual((pf["offered"], pf["accepted"], pf["corrected"], pf["rejected"], pf["reviewed"]), (5, 2, 2, 1, 5))
        self.assertEqual(pf["acceptedBy"], {"frame-enter": 2})
        self.assertEqual(pf["framesOffered"], 1)
        self.assertEqual(pf["drawnOnPrefillFrames"], 1)
        self.assertEqual(pf["activeSecOnPrefillFrames"], 13.0)  # f00002.jpg's 17 s are not in it
        self.assertEqual(pf["secPerReviewed"], 2.6)
        out = subprocess.run([sys.executable, "-B", str(HERE / "report_throughput.py"), "vidA", "--labels-dir", str(self.tmp / "lab-tpp")],
                             capture_output=True, text=True)
        self.assertIn("3 boxes drawn", out.stdout)
        self.assertIn("prefill (detector boxes, not drawn): 5 offered on 1 frames (0 as suggestions); reviewed 5: "
                      "accepted 2 (frame-enter 2), corrected 2, rejected 1", out.stdout)
        self.assertIn("2.6 s per reviewed detector box", out.stdout)
        self.assertIn("correction rate on drawn boxes 33.3 %", out.stdout)

    def test_throughput_ignores_kept_moved(self):
        """`kept-moved` (m: a kept box onto the model's suggestion for its card) counts as nothing."""
        t0 = 1_700_000_000_000
        ev = lambda k, **kw: dict({"ts": t0 + k * 1000, "mode": "box", "frame": "f00002.jpg"}, **kw)  # noqa: E731
        evs = [ev(0, ev="session-open"), ev(1, ev="prefill-offered", n=2, suggestions=2, heldBack=3),
               ev(3, ev="committed", target="P006", outcome="card", labelSource="prefill-accepted", origin="prefill", via="a"),
               ev(6, ev="corrected", target="P005", origin="carried", labelSource="carried-corrected"),
               ev(8, ev="frame-confirmed", n=7)]
        reports = []
        for name, extra in (("lab-km-0", []), ("lab-km-1", [ev(5, ev="kept-moved", target="P005", suggestion="P007")])):
            self.config(name, mode="box", role="training")
            self.assertEqual(self.post("/api/timing/vidA", {"events": sorted(evs + extra, key=lambda e: e["ts"])})[0], 200)
            reports.append(report_throughput.report(self.tmp / name, "vidA", idle=120))
        self.assertEqual((reports[0].pop("events"), reports[1].pop("events")), (5, 6), "only the raw count of events differs")
        self.assertEqual(reports[0], reports[1])

    # ---- a folder in the labels root that this tool did not write -----------------------------

    def test_foreign_set_opens_read_only(self):
        dst = self.tmp / "lab-old" / "foreign"
        dst.mkdir(parents=True)
        (dst / "meta.json").write_text(json.dumps({"schemaVersion": 1, "blind": True}))
        (dst / "frames.jsonl").write_text(json.dumps({"t": 45, "done": True, "items": [{"quad": [[0, 0], [1, 0], [1, 1], [0, 1]]}]}) + "\n")
        before = (dst / "frames.jsonl").read_bytes()
        for mode, role in (("point", "development"), ("corner", "test"), ("training", "training")):
            self.config("lab-old", mode=mode, role=role)
            st, got = self.get("/api/labels/foreign")
            self.assertEqual(st, 200)
            self.assertIn("not a label set of this tool", got["readOnly"])
            self.assertGreater(len(got["frames"]), 0)
            self.assertEqual(self.post("/api/labels/foreign/frames/f00046.jpg", {"frame": {"name": "f00046.jpg", "points": []}})[0], 409)
            self.assertEqual(self.post("/api/timing/foreign", {"events": [{"ev": "shown", "ts": 1}]})[0], 409)
            self.assertEqual(self.post("/api/labels/foreign/meta", {"annotator": "x"})[0], 409)
        self.assertEqual((dst / "frames.jsonl").read_bytes(), before)
        sets = {s["setId"]: s for s in self.get("/api/sets")[1]}
        self.assertIn("not a label set of this tool", sets["foreign"]["readOnly"])

    # ---- repeats + throughput ------------------------------------------------------------

    def test_repeat_set_hides_answers_and_compares(self):
        self.config("lab-rep", decklist=[str(self.tmp / "deck.txt")])
        answers = [("card", "TOY-001", "yes"), ("card", "TOY-120", "no"), ("not-card", None, None), ("card-back", None, "no"),
                   ("unreadable", None, "no"), ("card", "unknown", "uncertain")]
        for name, t, idx in (("f00001.jpg", 0, 1), ("f00002.jpg", 1, 2)):
            pts = lc.points_for_frame(idx, 7, 12)
            for p, (o, ident, el) in zip(pts, answers):
                p.update(outcome=o, identity=ident, eligible=el, identitySource="decklist" if ident else None,
                         conditions={"glare": True}, labelSource="manual")
            self.assertEqual(self.post(f"/api/labels/vidA/frames/{name}", {"frame": {"name": name, "t": t, "frameW": 1920, "frameH": 1080, "points": pts}})[0], 200)
        root = self.tmp / "lab-rep"
        res = make_repeat_set.make_repeat(root, "vidA", "vidA-rep1", n=8, seed=3)
        self.assertEqual((res["drawn"], res["pool"]), (8, 12))
        rmeta, rframes = make_repeat_set.read_set(root, "vidA-rep1")
        self.assertEqual(rmeta["repeatOf"]["set"], "vidA")
        self.assertEqual((rmeta["mode"], rmeta["role"], rmeta["frameAsset"]), ("point", "development", "vidA"))
        for fr in rframes:
            self.assertFalse(fr["done"])
            for p in fr["points"]:
                self.assertEqual(set(p), {"i", "x", "y"}, "no previous answer may reach the repeat set")
        # the decklist travels with the set (it is a picker aid, not an answer); nothing else may
        rmeta_wo_deck = {k: v for k, v in rmeta.items() if k != "decklist"}
        raw = (root / "vidA-rep1" / "frames.jsonl").read_text() + json.dumps(rmeta_wo_deck)
        for leak in ("TOY-", "unknown", "outcome", "eligible", "identity", "labelSource", "glare", "card"):
            self.assertNotIn(leak, raw)
        with self.assertRaises(SystemExit):
            make_repeat_set.make_repeat(root, "vidA", "vidA-rep1", n=8, seed=3)
        self.assertEqual(make_repeat_set.make_repeat(root, "vidA", "vidA-rep9", 8, 3)["drawn"], 8)
        a = [json.loads(line) for line in (root / "vidA-rep1/frames.jsonl").read_text().splitlines()]
        b = [json.loads(line) for line in (root / "vidA-rep9/frames.jsonl").read_text().splitlines()]
        self.assertEqual(a, b, "same seed, same draw")
        # the repeat set is served as its own set, restricted to its frames
        sets = {s["setId"]: s for s in self.get("/api/sets")[1]}
        self.assertEqual(sets["vidA-rep1"]["frameAsset"], "vidA")
        self.assertEqual({f["name"] for f in sets["vidA-rep1"]["frames"]}, {fr["name"] for fr in rframes})
        # second pass: same answers except one eligibility and one identity flip
        src = {(fr["name"], p["i"]): p for fr in self.read_frames("lab-rep", "vidA") for p in fr["points"]}
        flipped_e = flipped_id = None
        for fr in rframes:
            for p in fr["points"]:
                s = src[(fr["name"], p["i"])]
                p.update({k: s.get(k) for k in ("outcome", "identity", "eligible", "identitySource")}, labelSource="manual")
                if flipped_e is None and s["outcome"] == "card" and s["eligible"] == "yes":
                    p["eligible"] = "uncertain"; flipped_e = (fr["name"], p["i"])
                elif flipped_id is None and s["outcome"] == "card" and s["identity"] == "TOY-120":
                    p["identity"] = "TOY-001"; flipped_id = (fr["name"], p["i"])
            self.assertEqual(self.post(f"/api/labels/vidA-rep1/frames/{fr['name']}", {"frame": fr})[0], 200)
        r = compare_repeat.compare(root, "vidA-rep1")
        self.assertEqual(r["answeredBoth"], 8)
        self.assertEqual(r["outcomeAgreement"], 1.0)
        n_dis = (flipped_e is not None) + (flipped_id is not None)
        self.assertEqual(len(r["disagreements"]), n_dis)
        if flipped_id:
            self.assertLess(r["identityAgreement"], 1.0)
        if flipped_e:
            self.assertLess(r["eligibilityAgreement"], 1.0)
            self.assertEqual(r["eligibilityTable"]["yes"]["uncertain"], 1)

    def test_throughput_box_naming_and_coverage(self):
        # the page's timing queue module is served (a page without it loads nothing)
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/timinglog.js") as r:
            self.assertIn("createQueue", r.read().decode())
        self.config("lab-name", mode="box")
        box = {"outcome": "card", "corners": [[10, 10], [73, 10], [73, 98], [10, 98]], "cornerSource": "box"}
        for name in ("f00001.jpg", "f00002.jpg"):  # two confirmed frames, only the first logged as confirmed
            frame = {"name": name, "t": 0, "frameW": 1920, "frameH": 1080, "done": True, "targets": [dict(box, id="B001")]}
            self.assertEqual(self.post(f"/api/labels/vidA/frames/{name}", {"frame": frame})[0], 200)
        t0 = 1_700_000_000_000
        evs = [{"ev": "session-open", "ts": t0, "mode": "box"},
               {"ev": "committed", "ts": t0 + 5000, "mode": "box", "frame": "f00001.jpg", "target": "B001", "outcome": "card"},
               {"ev": "identified", "ts": t0 + 9000, "mode": "box", "frame": "f00001.jpg", "target": "B001", "identityKnown": True,
                "first": True, "pickerMs": 3000},
               {"ev": "identified", "ts": t0 + 12000, "mode": "box", "frame": "f00001.jpg", "target": "B001", "identityKnown": False,
                "first": False},
               {"ev": "committed", "ts": t0 + 12500, "mode": "box", "frame": "f00001.jpg", "target": "B002", "outcome": "card"},
               {"ev": "identified", "ts": t0 + 12600, "mode": "box", "frame": "f00001.jpg", "target": "B002", "identityKnown": True,
                "first": True, "pickerMs": 5000},
               {"ev": "deleted", "ts": t0 + 12700, "mode": "box", "frame": "f00001.jpg", "target": "B002"},
               {"ev": "frame-confirmed", "ts": t0 + 13000, "mode": "box", "frame": "f00001.jpg", "n": 1}]
        self.assertEqual(self.post("/api/timing/vidA", {"events": evs})[0], 200)
        r = report_throughput.report(self.tmp / "lab-name", "vidA", idle=120)
        b = r["byMode"]["box"]
        self.assertEqual((b["committed"], b["corrections"]), (1, 0), "naming a box is neither a box nor a correction")
        self.assertEqual(b["activeSec"], 13.0, "naming time is active box-mode time")
        self.assertEqual(b["named"], {"boxes": 1, "known": 0, "unknown": 1, "renamed": 1, "picks": 2,
                                      "medianPickerSec": 5.0, "pickerSec": 8.0}, "a named box deleted later is not a named box")
        self.assertEqual(r["framesDoneWithoutEvents"], ["f00002.jpg"], "a confirmed frame the log never saw is flagged")

    def test_throughput_review_walk(self):
        # the review walk's time is the gaps ending in an event flagged review: true;
        # `reviewed` boxes (distinct) per review hour, `review-turned` counted apart; neither is a
        # box nor a correction, and box mode's own counts are unchanged
        self.config("lab-rev", mode="box")
        t0 = 1_700_000_000_000
        f = "f00001.jpg"
        evs = [{"ev": "session-open", "ts": t0, "mode": "box"},
               {"ev": "committed", "ts": t0 + 10000, "mode": "box", "frame": f, "target": "B001", "outcome": "card"},
               {"ev": "review-start", "ts": t0 + 12000, "mode": "box", "frame": f},
               {"ev": "reviewed", "ts": t0 + 15000, "mode": "box", "frame": f, "target": "B001", "key": "enter", "review": True},
               {"ev": "review-turned", "ts": t0 + 18000, "mode": "box", "frame": f, "target": "P002", "via": "w", "review": True},
               {"ev": "corrected", "ts": t0 + 20000, "mode": "box", "frame": f, "target": "P002", "outcome": "card",
                "origin": "carried", "review": True},
               {"ev": "reviewed", "ts": t0 + 20000, "mode": "box", "frame": f, "target": "P002", "key": "enter", "turned": True, "review": True},
               {"ev": "reviewed", "ts": t0 + 22000, "mode": "box", "frame": f, "target": "B001", "key": "arrow", "review": True},
               {"ev": "review-end", "ts": t0 + 24000, "mode": "box", "frame": f, "review": True},
               {"ev": "shown", "ts": t0 + 30000, "mode": "box", "frame": f}]
        self.assertEqual(self.post("/api/timing/vidA", {"events": evs})[0], 200)
        b = report_throughput.report(self.tmp / "lab-rev", "vidA", idle=120)["byMode"]["box"]
        self.assertEqual(b["committed"], 1, "a reviewed box is not a drawn box")
        self.assertEqual(b["corrections"], 1)
        self.assertEqual(b["activeSec"], 30.0, "review time is inside box mode's time")
        self.assertEqual(b["review"], {"boxes": 2, "passes": 3, "turned": 1, "activeSec": 12.0, "boxesPerActiveHour": 600.0})
        out = subprocess.run([sys.executable, "-B", str(HERE / "report_throughput.py"), "vidA", "--labels-dir", str(self.tmp / "lab-rev")],
                             capture_output=True, text=True, check=True).stdout
        self.assertIn("review walk (inside the time above): 2 boxes passed (3 passes), 1 turned", out)
        self.assertIn("600.0 review boxes per active hour", out)

    def test_throughput_identify_turns(self):
        # identify-mode turns are counted on the identify line, neither identities
        # nor corrections; an undo is listed apart
        self.config("lab-idt", mode="box")  # the timing endpoint; the events carry the identify mode
        t0 = 1_700_000_000_000
        f = "f00001.jpg"
        evs = [{"ev": "session-open", "ts": t0, "mode": "identify"},
               {"ev": "shown", "ts": t0 + 1000, "mode": "identify", "frame": f, "target": "B001"},
               {"ev": "identify-turned", "ts": t0 + 3000, "mode": "identify", "frame": f, "target": "B001", "via": "w", "angle": 90},
               {"ev": "identify-turned", "ts": t0 + 3500, "mode": "identify", "frame": f, "target": "B001", "via": "w", "angle": 180},
               {"ev": "committed", "ts": t0 + 6000, "mode": "identify", "frame": f, "target": "B001", "outcome": "card",
                "identityKnown": True, "eligible": "yes"},
               {"ev": "identify-turned", "ts": t0 + 8000, "mode": "identify", "frame": f, "target": "B002", "via": "edge", "angle": -90},
               {"ev": "identify-turned", "ts": t0 + 9000, "mode": "identify", "frame": f, "target": "B002", "via": "undo", "angle": 0}]
        self.assertEqual(self.post("/api/timing/vidA", {"events": evs})[0], 200)
        i = report_throughput.report(self.tmp / "lab-idt", "vidA", idle=120)["byMode"]["identify"]
        self.assertEqual((i["committed"], i["corrections"]), (1, 0), "a turn is neither an identity nor a correction")
        self.assertEqual(i["turned"], {"boxes": 2, "turns": 3, "via": {"w": 2, "edge": 1, "undo": 1}})
        self.assertEqual(i["activeSec"], 9.0)
        out = subprocess.run([sys.executable, "-B", str(HERE / "report_throughput.py"), "vidA", "--labels-dir", str(self.tmp / "lab-idt")],
                             capture_output=True, text=True, check=True).stdout
        self.assertIn("top edges turned on 2 boxes (3 turns, 1 undone)", out)

    # ---- center mode (a center census) ---------------------------------------------------

    @staticmethod
    def center_frame(name, centers, seq=None, done=True, t=0):
        return {"name": name, "t": t, "frameW": 1920, "frameH": 1080, "done": done, "centers": centers,
                "centerSeq": seq if seq is not None else max([lc.center_number(c["id"]) for c in centers] or [0])}

    def test_center_roundtrip_and_meta(self):
        self.config("lab-cen", mode="center")
        st, cfg = self.get("/api/config")
        self.assertEqual((cfg["mode"], cfg["prefill"]), ("center", False))
        fr = self.center_frame("f00001.jpg", [{"id": "C001", "x": 0.5, "y": 0.25, "kind": "face"},
                                              {"id": "C003", "x": 0.123456789, "y": 1.0, "kind": "back"}], seq=4)
        st, res = self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": fr})
        self.assertEqual(st, 200, res)
        disk = self.read_frames("lab-cen", "vidA")
        self.assertEqual(len(disk), 1)
        self.assertEqual(disk[0]["centers"][1], {"id": "C003", "x": 0.123457, "y": 1.0, "kind": "back"})
        self.assertEqual((disk[0]["centerSeq"], disk[0]["frameW"], disk[0]["frameH"], disk[0]["done"]), (4, 1920, 1080, True))
        meta = json.loads((self.tmp / "lab-cen/vidA/meta.json").read_text())
        self.assertEqual((meta["mode"], meta["role"], meta["blind"]), ("center", "development", True))
        self.assertNotIn("pointRule", meta)
        st, got = self.get("/api/labels/vidA")
        self.assertIsNone(got["readOnly"])
        self.assertEqual(got["frames"][0]["centers"][0]["id"], "C001")
        # a frame with zero clicks confirmed: no cards
        self.assertEqual(self.post("/api/labels/vidA/frames/f00002.jpg", {"frame": self.center_frame("f00002.jpg", [], t=1)})[0], 200)
        # refused: out-of-range x/y, a kind other than face/back, a duplicate id, ids going back
        for centers, seq in (([{"id": "C005", "x": 1.2, "y": 0.5, "kind": "face"}], 5),
                             ([{"id": "C005", "x": 0.5, "y": -0.1, "kind": "face"}], 5),
                             ([{"id": "C005", "x": 0.5, "y": 0.5, "kind": "card"}], 5),
                             ([{"id": "C005", "x": 0.5, "y": 0.5, "kind": "face"}, {"id": "C005", "x": 0.6, "y": 0.5, "kind": "back"}], 5),
                             ([{"id": "C001", "x": 0.5, "y": 0.5, "kind": "face"}], 2)):
            st, res = self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": self.center_frame("f00001.jpg", centers, seq=seq)})
            self.assertEqual(st, 400, (centers, seq, res))
        # a box row is not a center row
        st, _ = self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": {"name": "f00001.jpg", "frameW": 1920, "frameH": 1080, "targets": []}})
        self.assertEqual(st, 400)
        self.assertEqual(self.read_frames("lab-cen", "vidA")[0]["centerSeq"], 4)  # nothing refused was written

    def test_center_guards(self):
        for kw in (dict(mode="center", role="training"),
                   dict(mode="center", role="development", prefill=[str(self.tmp / "prefill.json")]),
                   dict(mode="center", role="test", prefill=[str(self.tmp / "prefill.json")])):
            with self.assertRaises((SystemExit, ValueError)):
                serve.configure(args(labels_dir=str(self.tmp / "g"), sample=str(self.tmp / "sample.json"), **kw))
        parsed = serve.build_parser().parse_args(["--mode", "center", "--role", "test", "--sample", "s.json"])
        self.assertEqual(parsed.mode, "center")
        self.config("lab-cen-g", mode="center")
        self.assertEqual(self.get("/api/prefill/vidA")[0], 404)  # no prefill route in a census

    def test_center_mode_mismatch_is_read_only(self):
        self.config("lab-cmm", mode="center")
        fr = self.center_frame("f00001.jpg", [{"id": "C001", "x": 0.5, "y": 0.5, "kind": "face"}])
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": fr})[0], 200)
        self.config("lab-cmm", mode="point")
        st, got = self.get("/api/labels/vidA")
        self.assertIn("mode=center", got["readOnly"])
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": {"name": "f00001.jpg", "points": []}})[0], 409)
        self.config("lab-cmm", mode="center", role="test")
        self.assertIn("role=development", self.get("/api/labels/vidA")[1]["readOnly"])
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": fr})[0], 409)
        self.config("lab-cmm", mode="identify")
        self.assertIn("identify mode opens box", self.get("/api/labels/vidA")[1]["readOnly"])
        # a point set opened by a center server is read-only too
        self.config("lab-cmm2", mode="point")
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": {"name": "f00001.jpg", "frameW": 1920, "frameH": 1080, "points": []}})[0], 200)
        self.config("lab-cmm2", mode="center")
        self.assertIn("mode=point", self.get("/api/labels/vidA")[1]["readOnly"])
        meta = json.loads((self.tmp / "lab-cmm/vidA/meta.json").read_text())
        self.assertEqual((meta["mode"], meta["role"]), ("center", "development"))

    def test_center_two_samples_one_root(self):
        # two samples of the same sets with different frames, one labels root
        man_a = {"assets": [{"assetId": "vidA", "frames": [{"t": 0, "name": "f00001.jpg"}]},
                            {"assetId": "vidB", "frames": [{"t": 0, "name": "f00001.jpg"}]}]}
        man_b = {"assets": [{"assetId": "vidA", "frames": [{"t": 1, "name": "f00002.jpg"}]},
                            {"assetId": "vidB", "frames": [{"t": 5, "name": "f00005.jpg"}]}]}
        (self.tmp / "census-a.json").write_text(json.dumps(man_a))
        (self.tmp / "census-b.json").write_text(json.dumps(man_b))
        common = dict(labels_dir=str(self.tmp / "lab-c2"), frames_dir=str(self.tmp / "frames"),
                      decklists_dir=str(self.tmp / "no-decklists"), mode="center")
        serve.configure(args(sample=str(self.tmp / "census-a.json"), **common))
        fa = self.center_frame("f00001.jpg", [{"id": "C001", "x": 0.5, "y": 0.5, "kind": "face"}])
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": fa})[0], 200)
        sets = {x["setId"]: x for x in self.get("/api/sets")[1]}
        self.assertEqual((sets["vidA"]["labeled"], len(sets["vidA"]["frames"])), (1, 1))
        created = json.loads((self.tmp / "lab-c2/vidA/meta.json").read_text())["createdAt"]
        serve.configure(args(sample=str(self.tmp / "census-b.json"), **common))
        sets = {x["setId"]: x for x in self.get("/api/sets")[1]}
        # a frame done under the first sample does not make the set look done under the second
        self.assertEqual((sets["vidA"]["labeled"], len(sets["vidA"]["frames"]), sets["vidA"]["readOnly"]), (0, 1, None))
        self.assertEqual([f["name"] for f in sets["vidA"]["frames"]], ["f00002.jpg"])
        fb = self.center_frame("f00002.jpg", [{"id": "C001", "x": 0.25, "y": 0.75, "kind": "back"}], t=1)
        self.assertEqual(self.post("/api/labels/vidA/frames/f00002.jpg", {"frame": fb})[0], 200)
        self.assertEqual([fr["name"] for fr in self.read_frames("lab-c2", "vidA")], ["f00001.jpg", "f00002.jpg"])
        meta = json.loads((self.tmp / "lab-c2/vidA/meta.json").read_text())
        self.assertEqual((meta["mode"], meta["createdAt"]), ("center", created))
        self.assertEqual({x["setId"]: x["labeled"] for x in self.get("/api/sets")[1]}, {"vidA": 1, "vidB": 0})
        serve.configure(args(sample=str(self.tmp / "census-a.json"), **common))
        self.assertEqual({x["setId"]: x["labeled"] for x in self.get("/api/sets")[1]}, {"vidA": 1, "vidB": 0})

    def test_throughput_center(self):
        self.config("lab-ctp", mode="center")
        fr = self.center_frame("f00001.jpg", [{"id": "C001", "x": 0.5, "y": 0.5, "kind": "face"},
                                              {"id": "C003", "x": 0.6, "y": 0.5, "kind": "back"}], seq=4)
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": fr})[0], 200)
        t0 = 1_700_000_000_000
        f = "f00001.jpg"
        evs = [{"ev": "session-open", "ts": t0, "mode": "center", "frame": f},
               {"ev": "shown", "ts": t0 + 1000, "mode": "center", "frame": f},
               {"ev": "center-added", "ts": t0 + 5000, "mode": "center", "frame": f, "center": "C001", "kind": "face"},
               {"ev": "center-added", "ts": t0 + 9000, "mode": "center", "frame": f, "center": "C002", "kind": "face"},
               {"ev": "center-deleted", "ts": t0 + 13000, "mode": "center", "frame": f, "center": "C002", "kind": "face"},
               {"ev": "center-added", "ts": t0 + 17000, "mode": "center", "frame": f, "center": "C003", "kind": "face"},
               {"ev": "center-kind", "ts": t0 + 21000, "mode": "center", "frame": f, "center": "C003", "kind": "back"},
               {"ev": "center-moved", "ts": t0 + 25000, "mode": "center", "frame": f, "center": "C001", "kind": "face"},
               {"ev": "center-added", "ts": t0 + 27000, "mode": "center", "frame": f, "center": "C004", "kind": "back"},
               {"ev": "center-deleted", "ts": t0 + 28000, "mode": "center", "frame": f, "center": "C004", "kind": "back", "via": "undo"},
               {"ev": "frame-confirmed", "ts": t0 + 31000, "mode": "center", "frame": f, "n": 2, "faces": 1, "backs": 1}]
        self.assertEqual(self.post("/api/timing/vidA", {"events": evs})[0], 200)
        r = report_throughput.report(self.tmp / "lab-ctp", "vidA", idle=120)
        ce = r["centers"]
        self.assertEqual((ce["clicks"], ce["clicksFace"], ce["clicksBack"]), (4, 3, 1))
        self.assertEqual((ce["moved"], ce["deleted"], ce["kindToggled"]), (1, 1, 1))
        self.assertEqual(ce["viaHistory"], {"center-deleted": 1})
        self.assertEqual(ce["activeSec"], 31.0)
        self.assertEqual(ce["clicksPerActiveMin"], round(4 / (31 / 60), 2))
        self.assertEqual((ce["framesConfirmed"], ce["clicksPerConfirmedFrame"]), (1, 4.0))
        self.assertEqual(ce["centersNow"], {"faces": 1, "backs": 1, "total": 2, "perFrameMean": 2.0, "perFrameMax": 2, "framesWithNone": 0})
        self.assertEqual(r["byMode"]["center"]["committed"], 2)  # net: C001 and C003
        self.assertEqual(r["byMode"]["center"]["unit"], "centers")
        self.assertEqual(r["framesDoneWithoutEvents"], [])
        out = subprocess.run([sys.executable, "-B", str(HERE / "report_throughput.py"), "vidA", "--labels-dir", str(self.tmp / "lab-ctp")],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("clicks per active minute", out.stdout)
        self.assertIn("clicks per confirmed frame", out.stdout)
        self.assertNotIn("outcome share", out.stdout)

    # ---- verify mode (naming a center census) --------------------------------------------

    ARMS = ("new", "old")  # the run's arms, in command-line order: key 1 and key 2 on the page

    def verify_fixture(self, name):
        """A center labels root (vidA: f00001 with faces C001 C003 C004 and back C002, f00002 with
        face C001; vidB: f00001 with face C001), a sample walking vidA/f00001 + vidB/f00001, two
        arms' prefill files and a blind file naming vidA/f00001/C004.

        The frames are 1920 x 1080. The `new` arm's records are in that space; the `old` arm's
        are in 960 x 540 (a model that ran on half-size frames), so every `old` box must be
        scaled by its record's own frameW / frameH to land on the click.
        new: C001 the kitemaker, C003 the kitemaker, C004 the kite, vidB/C001 nothing.
        old: C001 the kitemaker, C003 the kite, C004 nothing, vidB/C001 the kite."""
        root = self.tmp / name
        lab = root / "labels"
        rows = {"vidA": [self.center_frame("f00001.jpg", [{"id": "C001", "x": 0.5, "y": 0.25, "kind": "face"},
                                                          {"id": "C002", "x": 0.1, "y": 0.1, "kind": "back"},
                                                          {"id": "C003", "x": 0.7, "y": 0.6, "kind": "face"},
                                                          {"id": "C004", "x": 0.3, "y": 0.8, "kind": "face"}], seq=5),
                         self.center_frame("f00002.jpg", [{"id": "C001", "x": 0.2, "y": 0.2, "kind": "face"}], t=1)],
                "vidB": [self.center_frame("f00001.jpg", [{"id": "C001", "x": 0.4, "y": 0.4, "kind": "face"}])]}
        for vid, frs in rows.items():
            (lab / vid).mkdir(parents=True)
            (lab / vid / "frames.jsonl").write_text("".join(json.dumps(fr) + "\n" for fr in frs))
            (lab / vid / "meta.json").write_text(json.dumps({"schemaVersion": 2, "setId": vid, "frameAsset": vid, "mode": "center",
                                                             "role": "development", "zoom": 3.0, "blind": True}))
        sample = {"assets": [{"assetId": "vidA", "frames": [{"t": 0, "name": "f00001.jpg"}]},
                             {"assetId": "vidB", "frames": [{"t": 0, "name": "f00001.jpg"}]}]}
        (root / "sample.json").write_text(json.dumps(sample))

        def box(x, y, w, h, card):
            return {"box": [x, y, w, h], "cardId": card, "sim": 0.8, "margin": 0.1, "rot": 0, "flag": None,
                    "top5": [{"id": card, "sim": 0.8}] if card else []}

        arms = {
            "new": [{"set": "vidA", "name": "f00001.jpg", "t": 0, "frameW": 1920, "frameH": 1080,
                     "boxes": [box(900, 226, 120, 88, "TOY-001"), box(1312, 604, 64, 88, "TOY-001"), box(544, 820, 64, 88, "TOY-120")]},
                    {"set": "vidB", "name": "f00001.jpg", "t": 0, "frameW": 1920, "frameH": 1080, "boxes": []}],
            "old": [{"set": "vidA", "name": "f00001.jpg", "t": 0, "frameW": 960, "frameH": 540,
                     "boxes": [box(450, 113, 60, 44, "TOY-001"), box(656, 302, 32, 44, "TOY-120")]},
                    {"set": "vidB", "name": "f00001.jpg", "t": 0, "frameW": 960, "frameH": 540, "boxes": [box(368, 194, 32, 44, "TOY-120")]}],
        }
        for arm, records in arms.items():
            (root / f"{arm}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
        (root / "blind.json").write_text(json.dumps({"seed": 1, "blind": ["vidA/f00001.jpg/C004"]}))
        return root, arms

    def arm_args(self, root):
        return [f"{arm}={root / (arm + '.jsonl')}" for arm in self.ARMS]

    def verify_config(self, root, **kw):
        base = dict(labels_dir=str(root / "labels"), sample=str(root / "sample.json"), frames_dir=str(self.tmp / "frames"),
                    catalog=str(self.tmp / "catalog.json"), decklists_dir=str(self.tmp / "no-decklists"), mode="verify",
                    arm=self.arm_args(root), blind=str(root / "blind.json"))
        base.update(kw)
        serve.configure(args(**base))

    def answer(self, x, y, **kw):
        """An answer as the page writes it, recorded against the current run of the arms."""
        kw.setdefault("blind", False)
        kw["verifiedAt"] = {"x": x, "y": y, "armsManifestSha256": serve.CFG.verify["defaultSha"]}
        return kw

    # readability first: the page's order is readability (y / m / n), reveal, answer

    def stored_row(self, root, set_id="vidA", frame="f00001.jpg"):
        rows = [json.loads(line) for line in (root / "labels" / set_id / "frames.jsonl").read_text().splitlines() if line.strip()]
        return next(r for r in rows if r["name"] == frame)

    def stored_center(self, root, cid, set_id="vidA", frame="f00001.jpg"):
        return next(c for c in self.stored_row(root, set_id, frame)["centers"] if c["id"] == cid)

    def page_frame(self, root, set_id="vidA", frame="f00001.jpg", **answers):
        """The stored row as the page would post it with `answers` applied: an answer dict replaces
        the center's answer (the page keeps the readability and the server's stamps, as
        verifycore.applyAnswer does, unless the dict gives them); None clears it entirely."""
        fr = self.stored_row(root, set_id, frame)
        fr["done"] = False  # whatever the page says, the click pass's confirmation stays
        for c in fr["centers"]:
            if c["id"] not in answers:
                continue
            keep = {k: c[k] for k in ("eligible", "readabilityAt", "revealedAt") if k in c}
            for k in lc.CENTER_VERIFY_KEYS:
                c.pop(k, None)
            if answers[c["id"]] is not None:
                c.update(keep)
                c.update(answers[c["id"]])
        return fr

    def save(self, root, set_id="vidA", frame="f00001.jpg", **answers):
        return self.post(f"/api/labels/{set_id}/frames/{frame}", {"frame": self.page_frame(root, set_id, frame, **answers)})

    def readable(self, root, cid, eligible="yes", set_id="vidA", frame="f00001.jpg", blind=False):
        """y / m / n from the crop: a pending answer (readability alone), as verifycore.setReadability."""
        return self.save(root, set_id, frame, **{cid: {"eligible": eligible, "blind": blind}})

    def reveal(self, cid, set_id="vidA", frame="f00001.jpg"):
        return self.post(f"/api/verify-reveal/{set_id}", {"frame": frame, "center": cid})

    def read_and_reveal(self, root, cid, eligible="yes", set_id="vidA", frame="f00001.jpg"):
        st, res = self.readable(root, cid, eligible, set_id, frame)
        self.assertEqual(st, 200, res)
        st, res = self.reveal(cid, set_id, frame)
        self.assertEqual(st, 200, res)
        return res

    def test_verify_start_refusals(self):
        root, arms = self.verify_fixture("ver-start")
        self.verify_config(root)  # the fixture starts
        v = serve.CFG.verify
        self.assertEqual((v["arms"], v["rows"], len(v["blind"])), (["new", "old"], 4, 1))
        self.assertEqual(v["armFiles"]["old"]["file"], "old.jsonl")
        self.verify_config(root, blind=None)  # a run with no blind subsample is allowed
        self.assertEqual(len(serve.CFG.verify["blind"]), 0)
        self.verify_config(root, arm=self.arm_args(root)[:1])  # and so is a run with one arm
        self.assertEqual(serve.CFG.verify["arms"], ["new"])
        one = f"new={root / 'new.jsonl'}"
        for kw in (dict(arm=None), dict(arm=[f"new={root / 'nope.jsonl'}"]), dict(arm=["new.jsonl"]), dict(arm=[one, one]),
                   dict(arm=[f"both={root / 'new.jsonl'}"]), dict(arm=[f"New-Arm={root / 'new.jsonl'}"]),
                   dict(arm=self.arm_args(root) + [f"third={root / 'new.jsonl'}"]), dict(blind=str(root / "nope.json")),
                   dict(role="test"), dict(prefill=[str(self.tmp / "prefill.json")])):
            with self.subTest(kw), self.assertRaises((SystemExit, ValueError)):
                self.verify_config(root, **kw)
        with self.assertRaises(SystemExit):  # arms outside verify mode
            self.verify_config(root, mode="center")
        good = {arm: (root / f"{arm}.jsonl").read_text() for arm in self.ARMS}
        bfile = root / "blind.json"

        def refused(new=None, old=None, blind=None):
            for arm, records in (("new", new), ("old", old)):
                if records is not None:
                    (root / f"{arm}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
            orig = bfile.read_text()
            if blind is not None:
                bfile.write_text(json.dumps(blind))
            try:
                with self.assertRaises(SystemExit) as cm:
                    self.verify_config(root, problems_report=str(root / "problems.json"))
                return str(cm.exception)
            finally:
                bfile.write_text(orig)
                for arm, text in good.items():
                    (root / f"{arm}.jsonl").write_text(text)

        msg = refused(new=arms["new"][:1])  # the new arm did not run on vidB's frame
        self.assertIn("no record for a frame with face centers", msg)
        report = json.loads((root / "problems.json").read_text())
        self.assertEqual([(p["arm"], p["video"], p["frame"]) for p in report["problems"]], [("new", "vidB", "f00001.jpg")])
        self.assertEqual(report["arms"], {"new": "new.jsonl", "old": "old.jsonl"}, "files by name, never by full path")
        short = json.loads(json.dumps(arms["old"])); short[0]["boxes"][0]["box"] = [1, 2, 3]
        self.assertIn("box 1 must be", refused(old=short))
        self.assertIn("a second record", refused(new=arms["new"] + arms["new"][:1]))
        stranger = json.loads(json.dumps(arms["new"])); stranger[0]["boxes"][0]["cardId"] = "ZZZ-999"
        self.assertIn("not in the catalog", refused(new=stranger))
        halfsize = json.loads(json.dumps(arms["old"])); del halfsize[0]["frameH"]
        self.assertIn("frameW and frameH must both", refused(old=halfsize))
        self.assertIn("ambiguous", refused(blind=["C001"]))  # C001 is on three frames
        self.assertIn("no such center event", refused(blind=["vidA/f00001.jpg/C077"]))
        labels_before = (root / "labels/vidA/frames.jsonl").read_text()
        self.verify_config(root)
        self.assertEqual((root / "labels/vidA/frames.jsonl").read_text(), labels_before, "a refused start changed nothing")

    def test_verify_payload_blind_and_reveal(self):
        root, _ = self.verify_fixture("ver-pay")
        self.verify_config(root)
        st, cfg = self.get("/api/config")
        self.assertEqual((cfg["mode"], cfg["verify"]["arms"], cfg["verify"]["blindEvents"], cfg["verify"]["allBlind"]),
                         ("verify", ["new", "old"], 1, False))
        st, got = self.get("/api/labels/vidA")
        self.assertIsNone(got["readOnly"])
        cen = got["verify"]["centers"]
        self.assertEqual(sorted(cen), ["f00001.jpg#C001", "f00001.jpg#C002", "f00001.jpg#C003", "f00001.jpg#C004"])
        self.assertTrue(cen["f00001.jpg#C004"]["blind"])
        self.assertNotIn("arms", cen["f00001.jpg#C004"], "a blind center's proposals never leave the server")
        self.assertNotIn("Kite", json.dumps(cen["f00001.jpg#C004"]))
        self.assertEqual({k: v["proposals"] for k, v in cen.items()},
                         {"f00001.jpg#C001": True, "f00001.jpg#C002": False, "f00001.jpg#C003": True, "f00001.jpg#C004": False})
        # readability first: nothing of any arm (no name, no box to crop by) before a readability and a reveal
        for k, v in cen.items():
            self.assertNotIn("arms", v, k)
        self.assertNotIn("Kitemaker", json.dumps(got["verify"]))
        self.assertNotIn("box", json.dumps(got["verify"]))
        st, res = self.readable(root, "C001", "yes")
        self.assertEqual(st, 200, res)
        cen = self.get("/api/labels/vidA")[1]["verify"]["centers"]
        self.assertNotIn("arms", cen["f00001.jpg#C001"], "a readability alone reveals nothing")
        self.assertEqual(self.reveal("C001")[0], 200)
        self.read_and_reveal(root, "C003", "uncertain")
        cen = self.get("/api/labels/vidA")[1]["verify"]["centers"]
        self.assertEqual(cen["f00001.jpg#C001"]["arms"]["new"]["name"], "Amber Kitemaker")
        self.assertEqual(cen["f00001.jpg#C001"]["arms"]["new"]["box"], [900.0, 226.0, 120.0, 88.0])
        # the old arm's record is in 960 x 540: its box comes back in the label row's 1920 x 1080
        old = cen["f00001.jpg#C003"]["arms"]["old"]
        self.assertEqual((old["name"], old["printingId"], old["artId"], old["box"]), ("Kite", "TOY-120", "TOY-120", [1312.0, 604.0, 64.0, 88.0]))
        self.assertNotIn("arms", cen["f00001.jpg#C002"], "a back gets no proposals")
        self.assertNotIn("arms", cen["f00001.jpg#C004"], "a blind center's proposals never leave the server")
        self.assertEqual(self.get("/api/labels/vidA")[1]["verify"]["counts"],
                         {"total": 3, "verified": 0, "stale": 0, "blind": 1, "blindVerified": 0, "open": 3}, "a readability is not an answer")
        st, b = self.get("/api/labels/vidB")
        self.assertNotIn("arms", b["verify"]["centers"]["f00001.jpg#C001"])
        self.read_and_reveal(root, "C001", "no", set_id="vidB")
        st, b = self.get("/api/labels/vidB")
        shown = b["verify"]["centers"]["f00001.jpg#C001"]["arms"]
        self.assertEqual((shown["old"]["artId"], shown["old"]["box"]), ("TOY-120", [736.0, 388.0, 64.0, 88.0]))
        self.assertEqual((shown["new"]["name"], shown["new"]["box"]), (None, None), "the new arm found nothing there")
        self.assertEqual(self.reveal("C002")[0], 404, "a back: nothing to reveal")
        self.assertEqual(self.get("/verify-crop/new/vidA/f00001.jpg/C001")[0], 404, "no crop files: the page crops the frame itself")
        sets = {x["setId"]: x for x in self.get("/api/sets")[1]}
        self.assertEqual(sets["vidA"]["verify"]["open"], 3)
        # verify opens center sets only; a set never clicked is read-only
        st, other = self.get("/api/labels/vidC")
        self.assertIsNotNone(other["readOnly"])

    def test_check_names_follows_the_catalogs_rule(self):
        """A catalog in which two different cards share a name. Under its default rule ("name")
        the two are one card, as before: "accept both" holds when the models show either. Under
        "identity": "printing" they are two cards: "accept both" is refused when the models show
        different ones, and an accept stores the card the model showed, not another of its name."""
        cat = json.loads(json.dumps(CATALOG))
        cat["cards"].append({"id": "TOY-002", "name": "Amber Kitemaker", "kind": "Unit", "printingOf": None, "art": "TOY-002.png"})
        for rule in (None, "printing"):
            with self.subTest(rule=rule):
                (self.tmp / f"cat-{rule}.json").write_text(json.dumps(dict(cat, **({"identity": rule} if rule else {}))))
                root, _arms = self.verify_fixture(f"ver-rule-{rule}")
                old = [json.loads(line) for line in (root / "old.jsonl").read_text().splitlines()]
                old[0]["boxes"][0]["cardId"] = "TOY-002"  # at C001 the old model shows the OTHER card of that name
                (root / "old.jsonl").write_text("".join(json.dumps(r) + "\n" for r in old))
                self.verify_config(root, catalog=str(self.tmp / f"cat-{rule}.json"))
                self.assertEqual(self.get("/api/config")[1]["identity"], rule or "name")
                arms = self.read_and_reveal(root, "C001", "yes")["arms"]
                self.assertEqual((arms["new"]["printingId"], arms["old"]["printingId"], arms["new"]["name"], arms["old"]["name"]),
                                 ("TOY-001", "TOY-002", "Amber Kitemaker", "Amber Kitemaker"))
                answers = {"both": self.answer(0.5, 0.25, verifiedBy="accept-both", identity="TOY-001", printing=None, eligible="yes"),
                           "old, its own card": self.answer(0.5, 0.25, verifiedBy="accept-old", identity="TOY-002", printing=None, eligible="yes"),
                           "old, the other card of that name": self.answer(0.5, 0.25, verifiedBy="accept-old", identity="TOY-001", printing=None, eligible="yes")}
                got = {what: self.save(root, C001=a) for what, a in answers.items()}
                if rule is None:
                    self.assertEqual({what: st for what, (st, _res) in got.items()}, {"both": 200, "old, its own card": 200, "old, the other card of that name": 200})
                else:
                    self.assertEqual({what: st for what, (st, _res) in got.items()}, {"both": 400, "old, its own card": 200, "old, the other card of that name": 400})
                    self.assertIn("accept-both: the arms showed different cards", got["both"][1]["error"])
                    self.assertIn("identity 'TOY-001' is not the old arm's card", got["old, the other card of that name"][1]["error"])
        # a rule the tool does not know refuses the start, in one sentence
        (self.tmp / "cat-bad.json").write_text(json.dumps(dict(cat, identity="printings")))
        root, _arms = self.verify_fixture("ver-rule-bad")
        with self.assertRaises(SystemExit) as stop:
            self.verify_config(root, catalog=str(self.tmp / "cat-bad.json"))
        self.assertEqual(str(stop.exception), f'--catalog: {(self.tmp / "cat-bad.json").resolve()}: "identity" must be "name" or "printing", not "printings"')

    def test_verify_save_answers_only(self):
        root, _ = self.verify_fixture("ver-save")
        self.verify_config(root)
        url = "/api/labels/vidA/frames/f00001.jpg"

        def frame_with(**answers):
            return self.page_frame(root, **answers)  # the stored row, as the page posts it

        # readability first: y / m / n, the reveal, then the accept
        self.read_and_reveal(root, "C001", "yes")
        a1 = self.answer(0.5, 0.25, verifiedBy="accept-new", identity="TOY-001", printing=None, eligible="yes")
        st, res = self.post(url, {"frame": frame_with(C001=a1)})
        self.assertEqual(st, 200, res)
        disk = self.read_frames("ver-save/labels", "vidA")[0]
        c1 = disk["centers"][0]
        self.assertEqual((c1["x"], c1["y"], c1["kind"], c1["identity"], c1["verifiedBy"], c1["eligible"]),
                         (0.5, 0.25, "face", "TOY-001", "accept-new", "yes"))
        self.assertEqual((c1["readabilityAt"]["x"], c1["readabilityAt"]["y"]), (0.5, 0.25))
        self.assertLessEqual(c1["readabilityAt"]["at"], c1["revealedAt"])
        self.assertEqual((disk["done"], disk["centerSeq"]), (True, 5))
        meta = json.loads((root / "labels/vidA/meta.json").read_text())
        self.assertEqual(meta["mode"], "center")
        self.assertEqual({arm: f["file"] for arm, f in meta["verify"]["arms"].items()}, {"new": "new.jsonl", "old": "old.jsonl"})
        self.assertEqual((meta["verify"]["armsManifestSha256"], meta["verify"]["blind"]), ([serve.CFG.verify["defaultSha"]], "blind.json"))
        self.assertNotIn(str(self.tmp), json.dumps(meta), "no full path is written into a label set")
        # corrections are stored as `correction`, never as a kind change; a readability given before
        # it stays. (C003 is read and revealed so the refusals below are refused for their own reason.)
        self.read_and_reveal(root, "C003", "yes")
        self.assertEqual(self.readable(root, "C004", "uncertain", blind=True)[0], 200)
        back = self.answer(0.7, 0.6, verifiedBy="back", correction="back")
        blind_named = self.answer(0.3, 0.8, verifiedBy="picked", identity="TOY-120", printing=None, eligible="uncertain", blind=True)
        st, res = self.post(url, {"frame": frame_with(C001=a1, C003=back, C004=blind_named)})
        self.assertEqual(st, 200, res)
        disk = self.read_frames("ver-save/labels", "vidA")[0]
        self.assertEqual((disk["centers"][2]["kind"], disk["centers"][2]["correction"], disk["centers"][2]["eligible"]), ("face", "back", "yes"))
        self.assertTrue(disk["centers"][3]["blind"])
        self.assertNotIn("revealedAt", disk["centers"][3])
        self.assertEqual(self.get("/api/labels/vidA")[1]["verify"]["counts"]["verified"], 3)
        # refused: any geometry change, at 409, nothing written
        before = (root / "labels/vidA/frames.jsonl").read_text()
        for what, fn in (("x", lambda fr: fr["centers"][0].update(x=0.55)), ("kind", lambda fr: fr["centers"][1].update(kind="face")),
                         ("id", lambda fr: fr["centers"][1].update(id="C009")), ("centerSeq", lambda fr: fr.update(centerSeq=6)),
                         ("removed", lambda fr: fr["centers"].pop()), ("added", lambda fr: fr["centers"].append({"id": "C006", "x": 0.9, "y": 0.9, "kind": "face"}))):
            with self.subTest(what):
                fr = frame_with(C001=a1)
                fn(fr)
                st, res = self.post(url, {"frame": fr})
                self.assertEqual(st, 409, (what, res))
        # refused answers (400): accept on the blind center, a blind flag that is not the subsample's,
        # accept-both where the arms differ, a name the arm did not show, an arm this run does not
        # have, a stale verifiedAt
        sha = serve.CFG.verify["defaultSha"]
        bad = {"accept on blind": dict(C004=self.answer(0.3, 0.8, verifiedBy="accept-new", identity="TOY-120", blind=True)),
               "blind flag": dict(C001=self.answer(0.5, 0.25, verifiedBy="picked", identity="TOY-001", blind=True)),
               "not blind": dict(C004=self.answer(0.3, 0.8, verifiedBy="unknown", identity="unknown", blind=False)),
               "accept-both differ": dict(C003=self.answer(0.7, 0.6, verifiedBy="accept-both", identity="TOY-001")),
               "not the arm's card": dict(C003=self.answer(0.7, 0.6, verifiedBy="accept-old", identity="TOY-001")),
               "no such arm": dict(C003=self.answer(0.7, 0.6, verifiedBy="accept-third", identity="TOY-001")),
               "position": dict(C003=dict(self.answer(0.7, 0.6, verifiedBy="picked", identity="TOY-001"), verifiedAt={"x": 0.1, "y": 0.6, "armsManifestSha256": sha})),
               "run": dict(C003=dict(self.answer(0.7, 0.6, verifiedBy="picked", identity="TOY-001"), verifiedAt={"x": 0.7, "y": 0.6, "armsManifestSha256": "d" * 64})),
               "contract": dict(C003=self.answer(0.7, 0.6, verifiedBy="picked"))}
        for what, answers in bad.items():
            with self.subTest(what):
                st, res = self.post(url, {"frame": frame_with(**answers)})
                self.assertEqual(st, 400, (what, res))
                if what not in ("accept on blind", "not blind"):  # C001 / C003 are read and revealed
                    self.assertNotIn("comes first", res["error"], what)
                    self.assertNotIn("needs the proposals to have been shown", res["error"], what)
        self.assertEqual((root / "labels/vidA/frames.jsonl").read_text(), before, "nothing refused was written")
        # Backspace clears an answer: after the reveal the name goes and the readability and the
        # reveal stay; before any reveal (the blind C004) everything goes
        stamps = {k: self.stored_center(root, "C001")[k] for k in ("readabilityAt", "revealedAt")}
        fr = frame_with()
        for k in ("verifiedBy", "identity", "printing", "eligible", "blind", "verifiedAt", "readabilityAt", "revealedAt"):
            fr["centers"][0].pop(k, None)
            fr["centers"][3].pop(k, None)
        self.assertEqual(self.post(url, {"frame": fr})[0], 200)
        c1 = self.stored_center(root, "C001")
        self.assertNotIn("verifiedBy", c1)
        self.assertEqual(lc.center_answer(c1), dict(eligible="yes", blind=False, **stamps))
        self.assertEqual(lc.center_answer(self.stored_center(root, "C004")), {})
        self.assertIn("arms", self.get("/api/labels/vidA")[1]["verify"]["centers"]["f00001.jpg#C001"], "still revealed")
        self.assertEqual(self.save(root, C001=a1)[0], 200, "named again after a clear")

    def test_verify_readability_first(self):
        """Readability first: the reveal endpoint, accepts only after it, the readability
        fixed once revealed, a clear keeps it, and the server-owned stamps."""
        root, _ = self.verify_fixture("ver-first")
        self.verify_config(root)
        path = root / "labels/vidA/frames.jsonl"
        accept = self.answer(0.5, 0.25, verifiedBy="accept-both", identity="TOY-001", printing=None, eligible="yes")
        # the reveal is refused without a readability (409), on a blind center (403, even with a
        # readability), on a center with no proposals (404); a malformed body is 400
        self.assertEqual(self.reveal("C001")[0], 409)
        self.assertEqual(self.readable(root, "C004", "yes", blind=True)[0], 200)
        self.assertEqual(self.reveal("C004")[0], 403)
        self.assertEqual(self.reveal("C002")[0], 404, "a back: no proposals")
        self.assertEqual(self.reveal("C099")[0], 404)
        self.assertEqual(self.post("/api/verify-reveal/vidA", {"frame": "f00001.jpg"})[0], 400)
        self.assertNotIn("revealedAt", self.stored_center(root, "C001"))
        self.assertNotIn("revealedAt", self.stored_center(root, "C004"))
        # an accept without the reveal: refused (400), with the readability in the same save or
        # before it; nothing written
        before = path.read_text()
        self.assertEqual(self.save(root, C001=accept)[0], 400, "readability and accept in one save")
        self.assertEqual(path.read_text(), before)
        st, res = self.readable(root, "C001", "yes")
        self.assertEqual(st, 200, res)
        ra = self.stored_center(root, "C001")["readabilityAt"]
        self.assertEqual(lc.center_answer(self.stored_center(root, "C001")), {"eligible": "yes", "blind": False, "readabilityAt": ra})
        self.assertEqual((ra["x"], ra["y"]), (0.5, 0.25))
        before = path.read_text()
        st, res = self.save(root, C001=accept)
        self.assertEqual(st, 400, res)
        self.assertIn("revealedAt", res["error"])
        self.assertEqual(path.read_text(), before, "an accept before the reveal writes nothing")
        # the reveal: stamps revealedAt no earlier than the readability, returns the arms; a second
        # call returns the same stamp and writes nothing
        st, r1 = self.reveal("C001")
        self.assertEqual(st, 200, r1)
        c1 = self.stored_center(root, "C001")
        self.assertEqual((r1["revealedAt"], r1["readabilityAt"]), (c1["revealedAt"], ra))
        self.assertLessEqual(ra["at"], c1["revealedAt"])
        self.assertEqual((r1["arms"]["new"]["name"], r1["arms"]["old"]["name"]), ("Amber Kitemaker", "Amber Kitemaker"))
        self.assertEqual(list(r1["arms"]), ["new", "old"])
        after_reveal = path.read_text()
        st, r2 = self.reveal("C001")
        self.assertEqual((st, r2["revealedAt"]), (200, r1["revealedAt"]))
        self.assertEqual(path.read_text(), after_reveal, "idempotent")
        # the page cannot forge the stamps: posted values are replaced by the stored ones
        forged = {"readabilityAt": {"x": 0.5, "y": 0.25, "at": "2000-01-01T00:00:00.000+00:00"}, "revealedAt": "2000-01-01T00:00:01.000+00:00"}
        st, res = self.save(root, C001=dict(accept, **forged))
        self.assertEqual(st, 200, res)
        c1 = self.stored_center(root, "C001")
        self.assertEqual((c1["verifiedBy"], c1["readabilityAt"], c1["revealedAt"]), ("accept-both", ra, r1["revealedAt"]))
        fr = self.page_frame(root)
        for k in ("readabilityAt", "revealedAt"):
            fr["centers"][0].pop(k)
        self.assertEqual(self.post("/api/labels/vidA/frames/f00001.jpg", {"frame": fr})[0], 200)
        c1 = self.stored_center(root, "C001")
        self.assertEqual((c1["readabilityAt"], c1["revealedAt"]), (ra, r1["revealedAt"]), "nor drop them")
        # ... nor fake a reveal: a forged revealedAt on a readability is dropped, so no arms, and an
        # accept is still refused
        st, res = self.save(root, C003=dict({"eligible": "no", "blind": False}, **forged))
        self.assertEqual(st, 200, res)
        c3 = self.stored_center(root, "C003")
        self.assertNotIn("revealedAt", c3)
        self.assertNotEqual(c3["readabilityAt"]["at"], forged["readabilityAt"]["at"])
        self.assertEqual((c3["readabilityAt"]["x"], c3["readabilityAt"]["y"]), (0.7, 0.6), "stamped at the center, not the page's")
        self.assertNotIn("arms", self.get("/api/labels/vidA")[1]["verify"]["centers"]["f00001.jpg#C003"])
        st, res = self.save(root, C003=dict(self.answer(0.7, 0.6, verifiedBy="accept-new", identity="TOY-001", printing=None), **forged))
        self.assertEqual(st, 400, res)
        # after the reveal the readability is fixed: a change is refused (409), named or pending,
        # and nothing is written
        before = path.read_text()
        for what, ans in {"named": dict(accept, eligible="no"), "pending": {"eligible": "uncertain", "blind": False},
                          "picked": self.answer(0.5, 0.25, verifiedBy="picked", identity="TOY-120", printing=None, eligible="no")}.items():
            with self.subTest(what):
                st, res = self.save(root, C001=ans)
                self.assertEqual(st, 409, (what, res))
        self.assertEqual(path.read_text(), before, "a refused readability change writes nothing")
        # Backspace after the reveal (the page posts the center with no answer at all): the name goes,
        # eligible, blind, readabilityAt and revealedAt stay
        st, res = self.save(root, C001=None)
        self.assertEqual(st, 200, res)
        self.assertEqual(lc.center_answer(self.stored_center(root, "C001")),
                         {"eligible": "yes", "blind": False, "readabilityAt": ra, "revealedAt": r1["revealedAt"]})
        self.assertEqual(self.readable(root, "C001", "no")[0], 409, "still fixed after the clear")
        self.assertEqual(self.reveal("C001")[1]["revealedAt"], r1["revealedAt"])
        self.assertEqual(self.save(root, C001=accept)[0], 200, "answered again, no new reveal needed")

    def test_verify_blind_readability(self):
        """A blind center: readability first too, then a name with no reveal (none is possible)."""
        root, _ = self.verify_fixture("ver-blindread")
        self.verify_config(root)
        path = root / "labels/vidA/frames.jsonl"
        picked = self.answer(0.3, 0.8, verifiedBy="picked", identity="TOY-120", printing=None, blind=True)
        before = path.read_text()
        for what, ans in {"picked": picked, "unknown": self.answer(0.3, 0.8, verifiedBy="unknown", identity="unknown", blind=True)}.items():
            with self.subTest(what):
                st, res = self.save(root, C004=ans)
                self.assertEqual(st, 400, (what, res))
                self.assertIn("comes first", res["error"])
        self.assertEqual(self.readable(root, "C004", "no", blind=False)[0], 400, "a readability carries the subsample's blind flag")
        self.assertEqual(path.read_text(), before)
        self.assertEqual(self.readable(root, "C004", "no", blind=True)[0], 200)
        self.assertEqual(self.reveal("C004")[0], 403)
        st, res = self.save(root, C004=picked)
        self.assertEqual(st, 200, res)
        c4 = self.stored_center(root, "C004")
        self.assertEqual((c4["verifiedBy"], c4["identity"], c4["eligible"], c4["blind"]), ("picked", "TOY-120", "no", True))
        self.assertIsInstance(c4["readabilityAt"], dict)
        self.assertNotIn("revealedAt", c4)
        counts = self.get("/api/labels/vidA")[1]["verify"]["counts"]
        self.assertEqual((counts["verified"], counts["blindVerified"]), (1, 1))
        # named, with a stamped readability: clear the answer first to change it
        st, res = self.save(root, C004=dict(picked, eligible="yes"))
        self.assertEqual(st, 409, res)
        self.assertEqual(self.save(root, C004=None)[0], 200)
        self.assertEqual(lc.center_answer(self.stored_center(root, "C004")), {}, "no reveal: the clear takes everything")
        self.assertEqual(self.readable(root, "C004", "yes", blind=True)[0], 200)
        self.assertEqual(self.stored_center(root, "C004")["eligible"], "yes")

    def test_verify_unstamped_answer_untouched(self):
        """An answer that carries no readability stamp (written by another tool), posted back
        unchanged beside another center's change, stays byte-identical: never back-stamped."""
        root, _ = self.verify_fixture("ver-unstamped")
        self.verify_config(root)  # to learn the run the answer is recorded against
        path = root / "labels/vidA/frames.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        rows[0]["centers"][2].update(self.answer(0.7, 0.6, verifiedBy="picked", identity="TOY-001", printing=None, eligible="yes"))
        path.write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))  # the server's own serialization
        self.verify_config(root)
        unstamped = json.dumps(self.stored_center(root, "C003"), sort_keys=True)
        self.assertIn(unstamped, path.read_text())
        self.assertEqual(self.get("/api/labels/vidA")[1]["verify"]["counts"]["verified"], 1, "an unstamped answer still counts")
        self.read_and_reveal(root, "C001", "uncertain")
        st, res = self.save(root, C001=self.answer(0.5, 0.25, verifiedBy="accept-new", identity="TOY-001", printing=None, eligible="uncertain"))
        self.assertEqual(st, 200, res)
        self.assertIn(unstamped, path.read_text(), "the unstamped center's bytes in the rewritten row are unchanged")
        self.assertEqual(json.dumps(self.stored_center(root, "C003"), sort_keys=True), unstamped)
        self.assertNotIn("readabilityAt", self.stored_center(root, "C003"))
        self.assertEqual(self.get("/api/labels/vidA")[1]["verify"]["counts"]["verified"], 2)
        self.assertEqual(self.reveal("C003")[0], 409, "its readability was never stamped: no reveal on it")

    def test_verify_stale(self):
        root, arms = self.verify_fixture("ver-stale")
        self.verify_config(root)
        url = "/api/labels/vidA/frames/f00001.jpg"
        self.read_and_reveal(root, "C001", "yes")
        fr = self.read_frames("ver-stale/labels", "vidA")[0]
        fr["centers"][0].update(self.answer(0.5, 0.25, verifiedBy="accept-both", identity="TOY-001", eligible="yes"))
        self.assertEqual(self.post(url, {"frame": fr})[0], 200)
        self.assertEqual(self.get("/api/labels/vidA")[1]["verify"]["counts"]["verified"], 1)
        # center mode moves the marker (the answer stays on it, now stale)
        serve.configure(args(labels_dir=str(root / "labels"), sample=str(root / "sample.json"), frames_dir=str(self.tmp / "frames"),
                             decklists_dir=str(self.tmp / "no-decklists"), mode="center"))
        moved = self.read_frames("ver-stale/labels", "vidA")[0]
        moved["centers"][0]["x"] = 0.52
        st, res = self.post(url, {"frame": moved})
        self.assertEqual(st, 200, res)
        self.assertEqual(self.read_frames("ver-stale/labels", "vidA")[0]["centers"][0]["verifiedBy"], "accept-both")
        # a verify run on the moved labels: the proposals follow the click, the old answer is stale
        self.verify_config(root)
        counts = self.get("/api/labels/vidA")[1]["verify"]["counts"]
        self.assertEqual((counts["verified"], counts["stale"], counts["open"]), (0, 1, 3))
        # the reveal was for the old position: no arms and no reveal until it is read again
        self.assertNotIn("arms", self.get("/api/labels/vidA")[1]["verify"]["centers"]["f00001.jpg#C001"])
        self.assertEqual(self.reveal("C001")[0], 409)
        # an untouched stale answer does not block answering another center on the frame
        fr = self.read_frames("ver-stale/labels", "vidA")[0]
        fr["centers"][2].update(self.answer(0.7, 0.6, verifiedBy="not-card", correction="not-card"))
        st, res = self.post(url, {"frame": fr})
        self.assertEqual(st, 200, res)
        # answering it again makes it fresh: read again at the new position (the stale answer starts
        # over, as verifycore.setReadability does), reveal, accept
        self.assertEqual(self.save(root, C001=None)[0], 200)
        st, res = self.readable(root, "C001", "no")
        self.assertEqual(st, 200, res)
        c1 = self.stored_center(root, "C001")
        self.assertEqual((c1["readabilityAt"]["x"], c1.get("revealedAt")), (0.52, None), "re-stamped; the old reveal is void")
        self.assertEqual(self.reveal("C001")[0], 200)
        st, res = self.save(root, C001=self.answer(0.52, 0.25, verifiedBy="accept-new", identity="TOY-001", eligible="no"))
        self.assertEqual(st, 200, res)
        counts = self.get("/api/labels/vidA")[1]["verify"]["counts"]
        self.assertEqual((counts["verified"], counts["stale"]), (2, 0))
        # another file for an arm is another run: every answer given under the old run is stale
        first_run = serve.CFG.verify["defaultSha"]
        again = json.loads(json.dumps(arms["old"])); again[0]["boxes"][1]["sim"] = 0.5
        (root / "old.jsonl").write_text("".join(json.dumps(r) + "\n" for r in again))
        self.verify_config(root)
        self.assertNotEqual(serve.CFG.verify["defaultSha"], first_run)
        counts = self.get("/api/labels/vidA")[1]["verify"]["counts"]
        self.assertEqual((counts["verified"], counts["stale"]), (0, 2))

    def test_verify_all_blind(self):
        """--all-blind: no arms and no blind file; every center blind; no proposals and no
        reveal; readability first then a picked name; refusals for mixed runs."""
        root, _ = self.verify_fixture("ver-allblind")
        base = dict(labels_dir=str(root / "labels"), sample=str(root / "sample.json"), frames_dir=str(self.tmp / "frames"),
                    catalog=str(self.tmp / "catalog.json"), decklists_dir=str(self.tmp / "no-decklists"), mode="verify")
        for kw in (dict(arm=self.arm_args(root)), dict(blind=str(root / "blind.json")),
                   dict(problems_report=str(root / "problems.json"))):
            with self.subTest(kw), self.assertRaises(SystemExit):
                serve.configure(args(**base, all_blind=True, **kw))
        with self.assertRaises(SystemExit):  # outside verify mode
            serve.configure(args(**dict(base, mode="center"), all_blind=True))
        with self.assertRaises(SystemExit):  # a sample with no face center
            empty = root / "sample-empty.json"
            empty.write_text(json.dumps({"assets": [{"assetId": "vidZ", "frames": [{"t": 0, "name": "f00001.jpg"}]}]}))
            serve.configure(args(**dict(base, sample=str(empty)), all_blind=True))
        serve.configure(args(**base, all_blind=True))
        self.assertTrue(serve.CFG.verify["allBlind"])
        cfg = self.get("/api/config")[1]["verify"]
        self.assertEqual((cfg["blindEvents"], cfg["arms"], cfg["allBlind"]), (6, [], True))
        st, got = self.get("/api/labels/vidA")
        cen = got["verify"]["centers"]
        self.assertTrue(all(v["blind"] and not v["proposals"] and "arms" not in v for v in cen.values()), cen)
        self.assertEqual(got["verify"]["counts"]["blind"], 3)
        st, res = self.readable(root, "C001", "yes", blind=True)
        self.assertEqual(st, 200, res)
        self.assertEqual(self.reveal("C001")[0], 403, "no reveal in an --all-blind run")
        named = self.answer(0.5, 0.25, verifiedBy="picked", identity="TOY-001", printing=None, blind=True)
        self.assertEqual(named["verifiedAt"]["armsManifestSha256"], serve.ALL_BLIND_SHA)
        st, res = self.save(root, C001=named)
        self.assertEqual(st, 200, res)
        c = self.stored_center(root, "C001")
        self.assertEqual((c["verifiedBy"], c["identity"], c["eligible"], c["blind"]), ("picked", "TOY-001", "yes", True))
        self.assertNotIn("revealedAt", c)
        self.assertIn("readabilityAt", c)
        accept = dict(self.answer(0.7, 0.6, verifiedBy="accept-new", identity="TOY-001", blind=True))
        self.assertEqual(self.readable(root, "C003", "yes", blind=True)[0], 200)
        self.assertEqual(self.save(root, C003=accept)[0], 400, "no accept without proposals")
        not_blind = self.answer(0.3, 0.8, verifiedBy="picked", identity="TOY-120", eligible="yes", blind=False)
        self.assertEqual(self.save(root, C004=not_blind)[0], 400, "every center is blind")
        meta = json.loads((root / "labels/vidA/meta.json").read_text())
        self.assertTrue(meta["verify"]["allBlind"])
        self.assertEqual(meta["verify"]["arms"], {})
        self.assertEqual(self.get("/api/labels/vidA")[1]["verify"]["counts"]["verified"], 1)

    def test_verify_test_role_all_blind_only(self):
        """A role=test center set: verify --all-blind opens it (every center blind, no arms, no
        reveal); verify with arms refuses to start for role=test."""
        root, _ = self.verify_fixture("ver-testrole")
        for vid in ("vidA", "vidB"):
            mp = root / "labels" / vid / "meta.json"
            m = json.loads(mp.read_text()); m["role"] = "test"; mp.write_text(json.dumps(m))
        base = dict(labels_dir=str(root / "labels"), sample=str(root / "sample.json"), frames_dir=str(self.tmp / "frames"),
                    catalog=str(self.tmp / "catalog.json"), decklists_dir=str(self.tmp / "no-decklists"), mode="verify", role="test")
        with self.assertRaises((SystemExit, ValueError)):  # proposals on a test set: never
            serve.configure(args(**base, arm=self.arm_args(root), blind=str(root / "blind.json")))
        with self.assertRaises((SystemExit, ValueError)):  # --all-blind still excludes arms
            serve.configure(args(**base, all_blind=True, arm=self.arm_args(root)))
        serve.configure(args(**base, all_blind=True))
        st, got = self.get("/api/labels/vidA")
        self.assertIsNone(got["readOnly"], got.get("readOnly"))
        cen = got["verify"]["centers"]
        self.assertTrue(cen and all(v["blind"] and "arms" not in v for v in cen.values()))
        self.assertEqual(self.readable(root, "C001", "uncertain", blind=True)[0], 200)
        self.assertEqual(self.reveal("C001")[0], 403)
        named = self.answer(0.5, 0.25, verifiedBy="picked", identity="TOY-001", printing=None, blind=True)
        st, res = self.save(root, C001=named)
        self.assertEqual(st, 200, res)
        self.assertEqual(json.loads((root / "labels/vidA/meta.json").read_text())["role"], "test")

    def test_throughput_total(self):
        """--all / total(): sets (and labels roots) merged on one time line, so switching sets is one
        capped gap, not counted in each set; committed labels per mode summed."""
        t0 = 1_700_000_000_000
        r1, r2 = self.tmp / "tot1", self.tmp / "tot2"
        logs = {(r1, "vidA"): [{"ev": "shown", "ts": t0, "mode": "point", "frame": "f1"},
                               {"ev": "committed", "ts": t0 + 10_000, "mode": "point", "frame": "f1", "target": 0}],
                (r1, "vidB"): [{"ev": "shown", "ts": t0 + 20_000, "mode": "point", "frame": "f2"},
                               {"ev": "committed", "ts": t0 + 30_000, "mode": "point", "frame": "f2", "target": 0}],
                (r2, "vidC"): [{"ev": "verify-shown", "ts": t0 + 1_000_000, "mode": "verify", "frame": "f3", "center": "C001"},
                               {"ev": "verify-answer", "ts": t0 + 1_005_000, "mode": "verify", "frame": "f3", "center": "C001",
                                "verifiedBy": "accept-both", "blind": False}]}
        for (root, sid), evs in logs.items():
            (root / sid).mkdir(parents=True)
            (root / sid / "timing.jsonl").write_text("".join(json.dumps(e) + "\n" for e in evs))
        t = report_throughput.total(list(logs), idle=120)
        self.assertEqual(t["sets"], 3)
        # 10 + 10 (vidA→vidB switch) + 10 s of point; the 970 s pause is capped at 120 s; 5 s of verify
        self.assertEqual(t["byMode"]["point"], {"activeSec": 30.0, "committed": 2, "unit": "points"})
        self.assertEqual(t["byMode"]["verify"], {"activeSec": 125.0, "committed": 1, "unit": "verified centers"})
        self.assertEqual((t["activeSec"], t["wallSec"]), (155.0, 1005.0))

    def test_throughput_verify(self):
        root, _ = self.verify_fixture("ver-tp")
        self.verify_config(root)
        t0 = 1_700_000_000_000
        f = "f00001.jpg"
        evs = [{"ev": "session-open", "ts": t0, "mode": "verify", "frame": f},
               {"ev": "verify-shown", "ts": t0 + 1000, "mode": "verify", "frame": f, "center": "C001", "blind": False},
               {"ev": "verify-revealed", "ts": t0 + 4000, "mode": "verify", "frame": f, "center": "C001", "blind": False, "ms": 3000},
               {"ev": "verify-answer", "ts": t0 + 7000, "mode": "verify", "frame": f, "center": "C001", "blind": False, "verifiedBy": "accept-both", "ms": 6000},
               {"ev": "verify-shown", "ts": t0 + 8000, "mode": "verify", "frame": f, "center": "C003", "blind": False},
               {"ev": "verify-answer", "ts": t0 + 10000, "mode": "verify", "frame": f, "center": "C003", "blind": False, "verifiedBy": "not-card", "ms": 2000},
               {"ev": "verify-correction", "ts": t0 + 10000, "mode": "verify", "frame": f, "center": "C003", "blind": False, "correction": "not-card"},
               {"ev": "verify-shown", "ts": t0 + 11000, "mode": "verify", "frame": f, "center": "C004", "blind": True},
               {"ev": "verify-answer", "ts": t0 + 31000, "mode": "verify", "frame": f, "center": "C004", "blind": True, "verifiedBy": "picked", "ms": 20000},
               # C001 answered again (a change): one answer per center
               {"ev": "verify-shown", "ts": t0 + 32000, "mode": "verify", "frame": f, "center": "C001", "blind": False},
               {"ev": "verify-answer", "ts": t0 + 35000, "mode": "verify", "frame": f, "center": "C001", "blind": False, "verifiedBy": "picked", "ms": 3000},
               {"ev": "verify-cleared", "ts": t0 + 36000, "mode": "verify", "frame": f, "center": "C003", "blind": False}]
        self.assertEqual(self.post("/api/timing/vidA", {"events": evs})[0], 200)
        r = report_throughput.report(root / "labels", "vidA", idle=120)
        v = r["verify"]
        self.assertEqual((v["answers"], v["answerEvents"], v["cleared"]), (2, 4, 1))
        self.assertEqual((v["assisted"]["answers"], v["blind"]["answers"]), (1, 1))
        # a gap is booked to the center on screen during it (the latest verify event before it):
        # session-open → the first shown is no center's (1 s)
        self.assertEqual((v["assisted"]["activeSec"], v["blind"]["activeSec"], v["activeSec"]), (14.0, 21.0, 36.0))
        self.assertEqual(v["assisted"]["answersPerActiveMin"], round(1 / (14 / 60), 2))
        self.assertEqual(v["blind"]["answersPerActiveMin"], round(1 / (21 / 60), 2))
        self.assertEqual(v["answersPerActiveMin"], round(2 / (36 / 60), 2))
        self.assertEqual(v["byVerifiedBy"], {"picked": 2})
        self.assertEqual((v["corrections"], v["revealed"], v["medianRevealSec"]), (1, 1, 3.0))
        self.assertEqual(r["byMode"]["verify"]["committed"], 2)
        out = subprocess.run([sys.executable, "-B", str(HERE / "report_throughput.py"), "vidA", "--labels-dir", str(root / "labels")],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("verify answers per active minute", out.stdout)
        self.assertIn("blind", out.stdout)

    def test_timing_and_throughput(self):
        self.config("lab-time")
        t0 = 1_700_000_000_000
        evs = [{"ev": "session-open", "ts": t0}]
        ts = t0
        for i in range(10):
            ts += 6000
            evs.append({"ev": "shown", "ts": ts, "frame": "f00001.jpg", "target": i})
            ts += 4000
            evs.append({"ev": "committed", "ts": ts, "frame": "f00001.jpg", "target": i, "outcome": "not-card"})
        ts += 3_600_000  # an hour-long break
        evs.append({"ev": "corrected", "ts": ts, "frame": "f00001.jpg", "target": 3})
        evs.append({"ev": "committed", "ts": ts + 1000, "frame": "f00001.jpg", "target": 3})  # duplicate commit counts once
        self.assertEqual(self.post("/api/timing/vidA", {"events": evs})[0], 200)
        self.assertEqual(self.post("/api/timing/vidA", {"events": "nope"})[0], 400)
        lines = (self.tmp / "lab-time/vidA/timing.jsonl").read_text().splitlines()
        self.assertEqual(len(lines), len(evs))
        self.assertIn("serverAt", json.loads(lines[0]))
        r = report_throughput.report(self.tmp / "lab-time", "vidA", idle=120)
        self.assertEqual(r["committed"], 10)
        self.assertEqual(r["corrections"], 1)
        self.assertEqual(r["correctionRate"], 0.1)
        self.assertAlmostEqual(r["activeSec"], 100 + 120 + 1, places=1)
        self.assertAlmostEqual(r["perActiveHour"], round(10 / (221 / 3600), 1), places=1)


class NodeTests(unittest.TestCase):
    def test_node(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node not on PATH")
        for script in ("test_picker.js", "test_quadsnap.js", "test_snap.js", "test_labeltools.js", "test_filters.js", "test_boxgeom.js", "test_boxedit.js", "test_timinglog.js", "test_centergeom.js", "test_verifycore.js",
                       "test_uistate.js", "test_keyroute.js", "test_savegate.js", "test_boxsize.js", "test_names.js"):
            res = subprocess.run([node, str(HERE / script)], capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, f"{script}: {res.stdout}\n{res.stderr}")


if __name__ == "__main__":
    unittest.main(verbosity=1)
