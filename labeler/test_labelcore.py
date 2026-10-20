# SPDX-License-Identifier: Apache-2.0
"""Unit tests for labelcore.py (point generator, corner geometry, validation, deck lists, the
verify pass's answer contract and the arms' proposals). Made-up cards only.
Run: python3 -m unittest discover -s labeler   (or: python3 labeler/test_labelcore.py)"""
from __future__ import annotations

import inspect
import json
import math
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import labelcore as lc  # noqa: E402


def rect(cx, cy, w, h, deg):
    """Card-order corners (TL, TR, BR, BL of the card's own upright orientation) of a w × h card
    rotated `deg` clockwise on screen (y-down)."""
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)
    return [[cx + x * c - y * s, cy + x * s + y * c] for x, y in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]


class PointGenerator(unittest.TestCase):
    def test_deterministic(self):
        a = lc.points_for_frame(46, seed=7, k=12)
        b = lc.points_for_frame(46, seed=7, k=12)
        self.assertEqual(a, b)
        self.assertEqual(len(a), 12)
        self.assertEqual([p["i"] for p in a], list(range(12)))

    def test_inputs_are_index_seed_k_only(self):
        # the generator cannot see an image: its only parameters are these
        self.assertEqual(list(inspect.signature(lc.points_for_frame).parameters), ["index", "seed", "k", "inset"])
        # and the frame index comes from the name (or t), never from pixels
        self.assertEqual(lc.frame_index("f00046.jpg"), 46)
        self.assertEqual(lc.frame_index("clip_a.png", t=12.4), 12)
        with self.assertRaises(ValueError):
            lc.frame_index("clip_a.png")

    def test_seed_and_frame_change_points(self):
        base = lc.points_for_frame(46, 7, 12)
        self.assertNotEqual(base, lc.points_for_frame(46, 8, 12))
        self.assertNotEqual(base, lc.points_for_frame(47, 7, 12))
        # a larger K extends the same frame's set (the first K Halton points, same shift)
        self.assertEqual(lc.points_for_frame(3, 7, 16)[:4], lc.points_for_frame(3, 7, 4))

    def test_spread_over_the_frame(self):
        for idx in list(range(0, 3000, 7)) + [46, 999]:
            pts = lc.points_for_frame(idx, 7, 12)
            for p in pts:
                self.assertGreaterEqual(p["x"], lc.POINT_INSET - 1e-9)
                self.assertLessEqual(p["x"], 1 - lc.POINT_INSET + 1e-9)
                self.assertGreaterEqual(p["y"], lc.POINT_INSET - 1e-9)
                self.assertLessEqual(p["y"], 1 - lc.POINT_INSET + 1e-9)
            # low discrepancy: no two points closer than 0.15 of the frame (on the torus, before
            # the inset mapping); an i.i.d. uniform draw of 12 would often be under 0.05
            span = 1 - 2 * lc.POINT_INSET
            uv = [((p["x"] - lc.POINT_INSET) / span, (p["y"] - lc.POINT_INSET) / span) for p in pts]
            tor = lambda a, b: math.hypot(min(abs(a[0] - b[0]), 1 - abs(a[0] - b[0])), min(abs(a[1] - b[1]), 1 - abs(a[1] - b[1])))  # noqa: E731
            dmin = min(tor(a, b) for n, a in enumerate(uv) for b in uv[n + 1:])
            self.assertGreater(dmin, 0.15, (idx, dmin))

    def test_rule_record(self):
        r = lc.point_rule(7, 12)
        self.assertEqual((r["seed"], r["k"], r["inset"]), (7, 12, lc.POINT_INSET))
        self.assertIn("halton", r["generator"])


class CornerGeometry(unittest.TestCase):
    def test_upright(self):
        m = lc.quad_measures(rect(500, 300, 63, 88, 0))
        self.assertAlmostEqual(m["rotationDeg"], 0.0, places=1)
        self.assertAlmostEqual(m["shortSidePx"], 63.0, places=1)
        self.assertAlmostEqual(m["foreshortening"], 1.0, places=2)
        self.assertEqual(m["aabb"], [468.5, 256.0, 63.0, 88.0])
        self.assertTrue(m["clockwise"] and m["convex"])
        self.assertIsNone(m["shortSideSourcePx"])

    def test_rotations_and_upside_down(self):
        for deg in (30, 90, -90, 135):
            m = lc.quad_measures(rect(500, 300, 63, 88, deg))
            self.assertAlmostEqual(m["rotationDeg"], deg, places=1)
            self.assertAlmostEqual(m["foreshortening"], 1.0, places=2)
            self.assertTrue(m["clockwise"])
        up = lc.quad_measures(rect(500, 300, 63, 88, 180))
        self.assertAlmostEqual(abs(up["rotationDeg"]), 180.0, places=1)
        self.assertGreater(up["rotationDeg"], 0)  # range (−180, 180]
        # the upside-down card's first corner is the screen bottom-right one
        q = rect(500, 300, 63, 88, 180)
        self.assertGreater(q[0][0], 500)
        self.assertGreater(q[0][1], 300)
        # labeling it as if upright (starting at the screen top-left) gives ≈ 0: the order matters
        screen_order = [q[2], q[3], q[0], q[1]]
        self.assertAlmostEqual(lc.quad_measures(screen_order)["rotationDeg"], 0.0, places=1)

    def test_strong_foreshortening(self):
        # a card on a table seen from a low oblique camera: far (top) edge half the near edge,
        # and compressed in depth
        q = [[470, 260], [530, 260], [560, 300], [440, 300]]
        m = lc.quad_measures(q)
        self.assertAlmostEqual(m["foreshorteningParts"]["topBottom"], 0.5, places=3)
        self.assertLess(m["foreshortening"], 0.5)
        self.assertAlmostEqual(m["rotationDeg"], 0.0, places=1)
        self.assertAlmostEqual(m["sides"]["top"], 60.0, places=1)
        self.assertAlmostEqual(m["shortSidePx"], min(m["widthPx"], m["heightPx"]))
        self.assertTrue(m["clockwise"] and m["convex"])

    def test_squashed_card_is_not_read_as_landscape(self):
        m = lc.quad_measures(rect(0, 0, 63, 44, 0))  # portrait card, height halved
        self.assertAlmostEqual(m["foreshorteningParts"]["aspect"], 0.5, places=2)
        bf = lc.quad_measures(rect(0, 0, 88, 63, 0), card_aspect=88 / 63)  # a landscape card, upright
        self.assertAlmostEqual(bf["foreshorteningParts"]["aspect"], 1.0, places=2)

    def test_source_pixels(self):
        m = lc.quad_measures(rect(500, 300, 60, 84, 0), frame_h=1080, source_h=720)
        self.assertAlmostEqual(m["shortSideSourcePx"], 40.0, places=1)
        self.assertEqual(lc.parse_resolution_height("720p"), 720)
        self.assertEqual(lc.parse_resolution_height("1920x1080"), 1080)
        self.assertIsNone(lc.parse_resolution_height("hd"))

    def test_counter_clockwise_flagged(self):
        q = rect(500, 300, 63, 88, 0)[::-1]
        self.assertFalse(lc.quad_measures(q)["clockwise"])

    def test_box_to_corners(self):
        self.assertEqual(lc.box_to_corners([10, 20, 30, 40]), [[10, 20], [40, 20], [40, 60], [10, 60]])
        self.assertEqual(lc.box_to_corners([10, 20, 30, 40], rot=180)[0], [40, 60])


class Rows(unittest.TestCase):
    def test_complete(self):
        self.assertFalse(lc.target_complete({"outcome": "card", "identity": "TOY-001"}))
        self.assertTrue(lc.target_complete({"outcome": "card", "identity": "TOY-001", "eligible": "uncertain"}))
        self.assertTrue(lc.target_complete({"outcome": "not-card"}))
        self.assertFalse(lc.target_complete({"outcome": "maybe"}))

    def test_validate(self):
        ok = {"name": "f00001.jpg", "points": [{"i": 0, "x": 0.5, "y": 0.5, "outcome": "card", "identity": "TOY-001",
                                                "identitySource": "decklist", "eligible": "yes",
                                                "conditions": {"faceUp": True, "visibleShare": "most"}, "labelSource": "manual"}]}
        self.assertEqual(lc.validate_frame(ok, "point"), [])
        bad = {"name": "f00001.jpg", "points": [{"i": 0, "x": 1.5, "y": 0.5, "outcome": "cardd", "eligible": "maybe",
                                                 "conditions": {"blur": "yes"}, "labelSource": "prefill-accepted"}]}
        errs = lc.validate_frame(bad, "point")
        self.assertEqual(len(errs), 5, errs)
        t = {"name": "f00001.jpg", "targets": [{"id": "Q001", "corners": [[0, 0], [1, 0], [1, 1], [0, 1]],
                                                "labelSource": "prefill-corrected", "prefill": {}}]}
        self.assertTrue(lc.validate_frame(t, "corner"))
        self.assertEqual(lc.validate_frame(t, "training"), [])

    def test_mode_role(self):
        lc.check_mode_role("point", "test", False)
        lc.check_mode_role("corner", "development", False)
        lc.check_mode_role("training", "training", True)
        lc.check_mode_role("box", "training", False)
        lc.check_mode_role("box", "development", False)
        lc.check_mode_role("identify", "development", False)
        lc.check_mode_role("box", "training", True)  # box mode takes prefill on a role=training set
        for args in (("training", "test", False), ("point", "training", True), ("corner", "development", True),
                     ("polygon", "training", False), ("identify", "training", True),
                     ("box", "development", True), ("box", "test", True), ("corner", "training", True)):
            with self.assertRaises(ValueError):
                lc.check_mode_role(*args)
        # verify mode: development; a test set only all-blind
        lc.check_mode_role("verify", "development", False)
        lc.check_mode_role("verify", "development", False, all_blind=True)
        lc.check_mode_role("verify", "test", False, all_blind=True)
        for args, kw in ((("verify", "test", False), {}), (("verify", "training", False), {}),
                         (("verify", "training", False), {"all_blind": True}), (("verify", "test", True), {"all_blind": True})):
            with self.subTest(args=args, kw=kw), self.assertRaises(ValueError):
                lc.check_mode_role(*args, **kw)

    def test_foreign_set(self):
        # a folder this tool did not write (its meta names no mode of this tool) is never written to
        self.assertTrue(lc.is_foreign_set({"schemaVersion": 1, "blind": True}, [{"t": 1, "items": []}]))
        self.assertTrue(lc.is_foreign_set({"schemaVersion": 1}, []))
        self.assertTrue(lc.is_foreign_set(None, [{"t": 1}]))
        self.assertTrue(lc.is_foreign_set({"mode": "polygon"}, []))
        self.assertFalse(lc.is_foreign_set({"mode": "point"}, [{"name": "f00001.jpg", "points": []}]))
        self.assertFalse(lc.is_foreign_set(None, []))

    def test_strip_answers(self):
        p = {"i": 3, "x": 0.1, "y": 0.2, "outcome": "card", "identity": "TOY-001", "eligible": "yes",
             "identitySource": "decklist", "conditions": {"glare": True}, "labelSource": "manual"}
        self.assertEqual(lc.strip_answers(p, "point"), {"i": 3, "x": 0.1, "y": 0.2})
        t = {"id": "Q001", "corners": [[0, 0], [1, 0], [1, 1], [0, 1]], "estimated": [False, True, False, False],
             "outcome": "card", "identity": "X", "derived": {}, "prefill": {"cardId": "X"}}
        self.assertEqual(set(lc.strip_answers(t, "corner")), {"id", "corners", "estimated"})

    def test_recording(self):
        self.assertEqual(lc.validate_recording({"source": "physical", "physicalGroup": "phone", "sourceResolution": "720p",
                                                "upscaled": "yes", "language": "en"}), [])
        self.assertEqual(len(lc.validate_recording({"source": "vhs", "color": "red"})), 2)


class BoxFormat(unittest.TestCase):
    """A box is four corners TL, TR, BR, BL of a rectangle with cornerSource box: the corner format."""

    def box_target(self, **kw):
        t = {"id": "B001", "corners": lc.box_corners(300, 200, 240, 110), "estimated": [False] * 4,
             "cornerSource": "box", "outcome": "card", "identity": None, "eligible": None, "conditions": {},
             "labelSource": "manual"}
        t.update(kw)
        return t

    def test_box_corners_shape(self):
        c = lc.box_corners(300, 200, 240, 110)  # any two opposite corners, either order
        self.assertEqual(c, [[240, 110], [300, 110], [300, 200], [240, 200]])
        self.assertTrue(lc.is_axis_aligned_box(c))
        self.assertEqual(lc.corners_aabb(c), [240.0, 110.0, 60.0, 90.0])
        self.assertFalse(lc.is_axis_aligned_box([[0, 0], [10, 1], [10, 10], [0, 10]]))
        self.assertFalse(lc.is_axis_aligned_box(lc.box_corners(5, 5, 5, 9)))  # zero width

    @staticmethod
    def rotated(cx, cy, w, h, deg):
        """Corners TL, TR, BR, BL of a rect rotated `deg` clockwise on screen, rounded to 0.1 px
        as the page stores them (boxgeom.js cornersFromRect)."""
        t = math.radians(deg)
        out = []
        for x, y in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)):
            out.append([round(cx + x * math.cos(t) - y * math.sin(t), 1), round(cy + x * math.sin(t) + y * math.cos(t), 1)])
        return out

    def test_rotated_rectangle_accepted_non_rectangle_refused(self):
        """A box may be rotated; the check is 'a rectangle', not 'axis-aligned'."""
        c30 = self.rotated(500, 400, 120, 168, 30)
        self.assertTrue(lc.is_rectangle_box(c30))
        self.assertFalse(lc.is_axis_aligned_box(c30))
        fr = {"name": "f00001.jpg", "frameH": 1080, "targets": [self.box_target(corners=c30, angle=30),
              self.box_target(id="B002", corners=self.rotated(900, 500, 60, 84, 90), angle=90, zOrder=3)]}
        self.assertEqual(lc.validate_frame(fr, "box"), [])
        n = lc.normalize_frame(fr, "box")
        self.assertAlmostEqual(n["targets"][0]["derived"]["rotationDeg"], 30.0, delta=0.1)
        self.assertAlmostEqual(n["targets"][1]["derived"]["rotationDeg"], 90.0, delta=0.1)
        self.assertAlmostEqual(n["targets"][0]["derived"]["shortSidePx"], 120.0, delta=0.2)
        # every angle, small boxes too, survives the 0.1 px rounding
        for deg in range(-179, 181, 7):
            self.assertTrue(lc.is_rectangle_box(self.rotated(50.33, 60.71, 4.2, 6.9, deg)), deg)
        # refused: a trapezoid, a parallelogram, counter-clockwise order, a degenerate side
        for bad in ([[0, 0], [100, 0], [90, 140], [10, 140]],
                    [[0, 0], [100, 0], [120, 140], [20, 140]],
                    [[0, 0], [0, 140], [100, 140], [100, 0]],
                    [[5, 5], [5, 5], [5, 9], [5, 9]],
                    [[0, 0], [100, 0], [100, 140]]):
            self.assertFalse(lc.is_rectangle_box(bad), bad)
            self.assertTrue(lc.validate_frame({"name": "f", "targets": [self.box_target(corners=bad)]}, "box"), bad)
        # angle and zOrder are checked when present
        self.assertTrue(lc.validate_frame({"name": "f", "targets": [self.box_target(angle="30")]}, "box"))
        self.assertTrue(lc.validate_frame({"name": "f", "targets": [self.box_target(angle=270)]}, "box"))
        self.assertTrue(lc.validate_frame({"name": "f", "targets": [self.box_target(zOrder="top")]}, "box"))
        # the identity pass may change neither
        old = {"targets": [self.box_target(corners=c30, angle=30, zOrder=1)]}
        self.assertEqual(lc.geometry_changes(old, {"targets": [self.box_target(corners=c30, angle=30, zOrder=1, identity="TOY-001")]}), [])
        self.assertTrue(lc.geometry_changes(old, {"targets": [self.box_target(corners=c30, angle=31, zOrder=1)]}))
        self.assertTrue(lc.geometry_changes(old, {"targets": [self.box_target(corners=c30, angle=30, zOrder=2)]}))
        # a repeat keeps the angle (geometry), not the answers
        self.assertEqual(lc.strip_answers(self.box_target(corners=c30, angle=30, identity="TOY-001"), "box")["angle"], 30)

    def test_box_rows_validate_and_derive_like_corners(self):
        fr = {"name": "f00001.jpg", "frameH": 1080, "targets": [self.box_target(),
              self.box_target(id="B002", outcome="card-back", eligible="no", conditions={"faceUp": False}),
              self.box_target(id="B003", ignore=True, eligible="no", conditions={"visibleShare": "half"})]}
        self.assertEqual(lc.validate_frame(fr, "box"), [])
        # the same row is a valid corner row too: a later corner pass can refine it
        self.assertEqual(lc.validate_frame(fr, "corner"), [])
        n = lc.normalize_frame(fr, "box")
        d = n["targets"][0]["derived"]
        self.assertEqual(d["aabb"], [240.0, 110.0, 60.0, 90.0])
        self.assertAlmostEqual(d["rotationDeg"], 0.0)
        self.assertTrue(d["clockwise"] and d["convex"])
        # complete in box mode without identity; not complete for the identity pass
        self.assertTrue(lc.target_complete(fr["targets"][0], "box"))
        self.assertFalse(lc.target_complete(fr["targets"][0]))

    def test_box_rules(self):
        bad = {"name": "f00001.jpg", "targets": [
            self.box_target(corners=[[0, 0], [10, 2], [10, 10], [0, 10]]),  # not axis-aligned
            self.box_target(id="B002", cornerSource="hand"),                  # not a box source
            self.box_target(id="B003", ignore="yes"),
            self.box_target(id="B004", labelSource="prefill-accepted")]}
        errs = lc.validate_frame(bad, "box")
        self.assertEqual(len(errs), 4, errs)
        # a cornerSource box claimed in a corner set must still be a rectangle
        self.assertTrue(lc.validate_frame({"name": "f", "targets": [self.box_target(corners=[[0, 0], [10, 2], [10, 10], [0, 10]])]}, "corner"))
        # propagated provenance: training sets only
        prop = {"name": "f00002.jpg", "targets": [self.box_target(cornerSource="propagated", labelSource="propagated",
                                                                  propagatedFrom={"frame": "f00001.jpg", "target": "B001"})]}
        self.assertEqual(lc.validate_frame(prop, "box", "training"), [])
        self.assertTrue(lc.validate_frame(prop, "box", "development"))
        self.assertTrue(lc.validate_frame(prop, "box", "test"))
        # carried-over provenance (the labeler's own boxes, page carry-over): every role but test
        car = {"name": "f00002.jpg", "targets": [self.box_target(cornerSource="carried", labelSource="carried",
                                                                 carriedFrom={"frame": "f00001.jpg", "target": "B001"})]}
        for role in ("training", "development"):
            self.assertEqual(lc.validate_frame(car, "box", role), [], role)
        self.assertTrue(lc.validate_frame(car, "box", "test"))
        car["targets"][0]["labelSource"] = "carried-corrected"
        self.assertEqual(lc.validate_frame(car, "box", "development"), [])
        self.assertTrue(lc.validate_frame(car, "box", "test"))

    def prefill_box(self, **kw):
        c = lc.box_corners(100, 50, 163, 138)
        t = self.box_target(id="P001", corners=c, cornerSource="prefill", labelSource="prefill-accepted",
                            prefill={"i": 0, "corners": c, "outcome": "card", "score": 0.91})
        t.update(kw)
        return t

    def test_box_prefill_training_only(self):
        """Detector boxes in box mode on a role=training set; never development or test."""
        fr = {"name": "f00001.jpg", "done": True, "prefillOffered": True, "targets": [
            self.prefill_box(),
            self.prefill_box(id="P002", corners=lc.box_corners(300, 50, 363, 138), cornerSource="prefill-edited",
                             labelSource="prefill-corrected", outcome="card-back")]}
        self.assertEqual(lc.validate_frame(fr, "box", "training"), [])
        for role in ("development", "test", None):
            errs = lc.validate_frame(fr, "box", role)
            self.assertTrue(errs and all("prefill" in e for e in errs), (role, errs))
        # unreviewed (pending) detector boxes: fine on an unconfirmed frame, refused on a confirmed one
        pend = self.prefill_box(pending=True)
        del pend["labelSource"]
        self.assertEqual(lc.validate_frame({"name": "f", "done": False, "targets": [pend]}, "box", "training"), [])
        errs = lc.validate_frame({"name": "f", "done": True, "targets": [pend]}, "box", "training")
        self.assertTrue(errs and "unreviewed" in errs[0], errs)
        # a detector "box" must still be a rectangle; training mode keeps its own rules
        self.assertTrue(lc.validate_frame({"name": "f", "targets": [self.prefill_box(corners=[[0, 0], [10, 2], [10, 10], [0, 10]])]}, "box", "training"))
        self.assertTrue(lc.validate_frame({"name": "f", "targets": [self.prefill_box(cornerSource="hand")]}, "box", "training"))
        self.assertEqual(lc.validate_frame({"name": "f", "targets": [self.prefill_box()]}, "training", "training"), [])

    def test_identity_pass_keeps_box_prefill_provenance(self):
        old = {"targets": [self.prefill_box()]}
        named = {"targets": [self.prefill_box(identity="TOY-001", eligible="yes")]}
        self.assertEqual(lc.geometry_changes(old, named, "box"), [])
        flipped = {"targets": [self.prefill_box(identity="TOY-001", labelSource="prefill-corrected")]}
        errs = lc.geometry_changes(old, flipped, "box")
        self.assertTrue(errs and "provenance" in errs[0], errs)
        # a training (corner) set's identity pass may still turn accepted into corrected (its identity is part of it)
        self.assertEqual(lc.geometry_changes(old, flipped, "training"), [])

    def turned(self, t, k):
        """The page's identify-mode turn (boxgeom.js topEdgeCorners + roundAngle): the same four
        points, new q[i] = old q[(i + k) % 4], angle + 90*k; an angle of 0 is not stored."""
        out = json.loads(json.dumps(t))
        out["corners"] = [list(t["corners"][(i + k) % 4]) for i in range(4)]
        a = lc.round_angle(lc.effective_angle(t) + 90 * k)
        if a == 0:
            out.pop("angle", None)
        else:
            out["angle"] = a
        return out

    def test_identity_pass_may_turn_the_top_edge(self):
        """In a box set the identity pass may change which edge is the top: a
        cyclic rotation of the corner order (k = 1, 2, 3) with angle + 90*k; nothing else."""
        c30 = self.rotated(500, 400, 120, 168, 30)
        for base in (self.box_target(), self.box_target(corners=c30, angle=30), self.box_target(corners=c30, angle=-179.99),
                     self.box_target(corners=self.rotated(500, 400, 120, 168, -90), angle=-90)):
            old = {"targets": [base]}
            for k in (1, 2, 3):
                new = {"targets": [self.turned(base, k)]}
                self.assertEqual(lc.geometry_changes(old, new, "box"), [], (base.get("angle"), k))
                self.assertEqual(lc.quarter_turn_steps(base["corners"], new["targets"][0]["corners"]), k)
                self.assertTrue(lc.validate_frame({"name": "f", "targets": new["targets"]}, "box") == [], k)
            # two quick turns = 180: 30 -> 120 -> -150
        self.assertEqual(self.turned(self.turned(self.box_target(corners=c30, angle=30), 1), 1)["angle"], -150)
        self.assertNotIn("angle", self.turned(self.box_target(corners=self.rotated(500, 400, 120, 168, -90), angle=-90), 1))
        base = self.box_target(corners=c30, angle=30)
        old = {"targets": [base]}
        good = self.turned(base, 1)
        # refused: a reflected (anticlockwise) order of the same points
        refl = dict(good, corners=[base["corners"][i] for i in (0, 3, 2, 1)])
        self.assertTrue(lc.geometry_changes(old, {"targets": [refl]}, "box"))
        refl2 = dict(good, corners=[base["corners"][i] for i in (1, 0, 3, 2)])
        self.assertTrue(lc.geometry_changes(old, {"targets": [refl2]}, "box"))
        # refused: one point moved (by 0.1 px) in an otherwise valid turn
        moved = json.loads(json.dumps(good))
        moved["corners"][2][0] += 0.1
        errs = lc.geometry_changes(old, {"targets": [moved]}, "box")
        self.assertTrue(errs and "corners changed" in errs[0], errs)
        # refused: the angle does not match the turn (unturned, the other way, absent, off by 0.01)
        for bad_angle in (30, -60, None, 120.01):
            bad = dict(good)
            if bad_angle is None:
                bad.pop("angle")
            else:
                bad["angle"] = bad_angle
            errs = lc.geometry_changes(old, {"targets": [bad]}, "box")
            self.assertTrue(errs and "angle" in errs[0], (bad_angle, errs))
        # refused: an angle change without a turn (as before)
        self.assertTrue(lc.geometry_changes(old, {"targets": [dict(base, angle=120)]}, "box"))
        # refused alongside a valid turn: ignore, estimated, cornerSource, zOrder
        for change in ({"ignore": True}, {"estimated": [True, False, False, False]}, {"cornerSource": "carried"}, {"zOrder": 4}):
            errs = lc.geometry_changes(old, {"targets": [dict(good, **change)]}, "box")
            self.assertTrue(errs and "never changes geometry" in errs[0], (change, errs))
        # refused: targets added or removed
        self.assertTrue(lc.geometry_changes(old, {"targets": [good, self.box_target(id="B002")]}, "box"))
        self.assertTrue(lc.geometry_changes(old, {"targets": []}, "box"))
        # refused outside a box set (corner / training sets keep the old rule)
        self.assertTrue(lc.geometry_changes(old, {"targets": [good]}, "training"))
        self.assertTrue(lc.geometry_changes(old, {"targets": [good]}))

    def test_turn_keeps_provenance_and_marks_the_box(self):
        carried = self.box_target(labelSource="carried", cornerSource="carried", carriedFrom={"frame": "f0", "target": "B001"})
        prop = self.box_target(id="B002", labelSource="propagated", cornerSource="propagated",
                               propagatedFrom={"frame": "f0", "target": "B002", "steps": 1, "score": 0.9})
        pf = self.prefill_box(id="B003")
        plain = self.box_target(id="B004")
        old = {"targets": [carried, prop, pf, plain]}
        new = {"targets": [self.turned(carried, 1), self.turned(prop, 2), self.turned(pf, 3), dict(plain, identity="TOY-001")]}
        self.assertEqual(lc.geometry_changes(old, new, "box"), [])
        # provenance must stay exactly as it was (a turn is not a box edit for provenance)
        for tid, change in ((0, {"labelSource": "carried-corrected"}), (1, {"labelSource": "propagated-corrected"}),
                            (2, {"labelSource": "prefill-corrected"}), (1, {"propagatedFrom": None})):
            bad = json.loads(json.dumps(new))
            bad["targets"][tid].update(change)
            errs = lc.geometry_changes(old, bad, "box")
            self.assertTrue(errs and "provenance" in errs[0], (tid, change, errs))
        # the server marks the turned boxes, drops a mark the page invents, keeps an earlier mark
        sent = json.loads(json.dumps(new))
        sent["targets"][3]["orientationFixedIn"] = "identify"  # not turned, not marked before: dropped
        self.assertEqual(lc.mark_orientation(old, sent, "box"), ["B001", "B002", "B003"])
        self.assertEqual([t.get("orientationFixedIn") for t in sent["targets"]], ["identify", "identify", "identify", None])
        self.assertEqual(sent["targets"][0]["labelSource"], "carried")
        back = {"targets": [carried, prop, pf, plain]}  # an undo turns them back: the mark stays
        self.assertEqual(lc.geometry_changes(sent, back, "box"), [])
        lc.mark_orientation(sent, back, "box")
        self.assertEqual([t.get("orientationFixedIn") for t in back["targets"]], ["identify", "identify", "identify", None])

    def test_identity_pass_box_edits(self):
        """Box sets of role training or development: the identity pass may move, resize or rotate a
        box, with the provenance a Boxes-pass edit gives it; a test set stays locked."""
        plain = self.box_target()
        moved = dict(plain, corners=lc.box_corners(310, 210, 250, 120))
        spun = dict(plain, corners=self.rotated(280, 160, 60, 90, 20), angle=20)
        for role in ("training", "development"):
            for new in (moved, spun):
                self.assertEqual(lc.geometry_changes({"targets": [plain]}, {"targets": [new]}, "box", role), [], role)
        for role in ("test", None):
            errs = lc.geometry_changes({"targets": [plain]}, {"targets": [moved]}, "box", role)
            self.assertTrue(errs, role)
        self.assertIn(lc.TEST_SET_LOCKED, lc.geometry_changes({"targets": [plain]}, {"targets": [moved]}, "box", "test")[0])
        self.assertTrue(lc.geometry_changes({"targets": [plain]}, {"targets": [moved]}, "training", "training"), "corner sets: never")
        # still refused with an edit: ignore, zOrder, estimated, an angle that is not the top edge's, no rectangle
        for change in ({"ignore": True}, {"zOrder": 2}, {"estimated": [True, False, False, False]}, {"angle": 5},
                       {"corners": [[300, 200], [400, 210], [400, 300], [300, 300]]}):
            self.assertTrue(lc.geometry_changes({"targets": [plain]}, {"targets": [dict(moved, **change)]}, "box", "training"), change)
        # provenance: exactly the Boxes pass's
        pf = self.prefill_box()
        pf_moved = dict(pf, corners=lc.box_corners(110, 60, 173, 148))
        self.assertEqual(lc.edit_provenance(pf, pf_moved), {"labelSource": "prefill-corrected", "cornerSource": "prefill-edited"})
        ok = dict(pf_moved, labelSource="prefill-corrected", cornerSource="prefill-edited")
        self.assertEqual(lc.geometry_changes({"targets": [pf]}, {"targets": [ok]}, "box", "training"), [])
        for change in ({"labelSource": "prefill-accepted"}, {"cornerSource": "prefill"}, {"prefill": dict(pf["prefill"], score=0.5)}):
            self.assertTrue(lc.geometry_changes({"targets": [pf]}, {"targets": [dict(ok, **change)]}, "box", "training"), change)
        back = dict(pf, labelSource="prefill-accepted", cornerSource="prefill")  # moved back onto the proposal: accepted again
        self.assertEqual(lc.geometry_changes({"targets": [ok]}, {"targets": [back]}, "box", "training"), [])
        carried = self.box_target(labelSource="carried", cornerSource="carried", carriedFrom={"frame": "f0", "target": "B001"})
        c_moved = dict(carried, corners=moved["corners"])
        self.assertEqual(lc.geometry_changes({"targets": [carried]}, {"targets": [dict(c_moved, labelSource="carried-corrected")]}, "box", "training"), [])
        self.assertTrue(lc.geometry_changes({"targets": [carried]}, {"targets": [c_moved]}, "box", "training"), "an edit of a kept box corrects it")
        self.assertTrue(lc.geometry_changes({"targets": [carried]}, {"targets": [dict(c_moved, labelSource="carried-corrected", carriedFrom=None)]}, "box", "training"))
        # a provenance change that no edit produced: refused
        self.assertTrue(lc.geometry_changes({"targets": [carried]}, {"targets": [dict(carried, labelSource="carried-corrected")]}, "box", "training"))
        self.assertTrue(lc.geometry_changes({"targets": [pf]}, {"targets": [dict(pf, labelSource="prefill-corrected")]}, "box", "training"))
        self.assertTrue(lc.geometry_changes({"targets": [plain]}, {"targets": [dict(moved, labelSource="carried-corrected")]}, "box", "training"))

    def test_edit_provenance_matches_boxgeom(self):
        """The server's rule for an edit's provenance is the page's (boxgeom.js editProvenance), so a
        Names edit records what a Boxes edit of the same box records."""
        node = shutil.which("node")
        if node is None:
            self.skipTest("node not on PATH")
        pf = self.prefill_box()
        cases = [
            (pf, dict(pf, corners=lc.box_corners(110, 60, 173, 148))),
            (pf, dict(pf, corners=lc.box_corners(100, 50, 163, 138))),
            (dict(pf, labelSource="prefill-corrected", cornerSource="prefill-edited"), dict(pf, outcome="card-back")),
            (dict(pf, pending=True), dict(pf, pending=True, corners=lc.box_corners(100, 50, 160, 140))),
            (self.box_target(labelSource="carried"), self.box_target(labelSource="carried", corners=lc.box_corners(1, 1, 60, 90))),
            (self.box_target(labelSource="propagated"), self.box_target(labelSource="propagated", corners=lc.box_corners(1, 1, 60, 90))),
            (self.box_target(), self.box_target(corners=lc.box_corners(1, 1, 60, 90))),
        ]
        js = ("const G = require(%s); const cs = JSON.parse(process.argv[1]);"
              "console.log(JSON.stringify(cs.map((t) => { const o = G.editProvenance(JSON.parse(JSON.stringify(t)), true); return [o.labelSource || null, o.cornerSource || null]; })));"
              % json.dumps(str(Path(__file__).resolve().parent / "boxgeom.js")))
        res = subprocess.run([node, "-e", js, json.dumps([new for _old, new in cases])], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)
        want = [[(p := lc.edit_provenance(old, new))["labelSource"], p["cornerSource"]] for old, new in cases]
        self.assertEqual(json.loads(res.stdout), want)

    def node_json(self, script, arg):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node not on PATH")
        here = json.dumps(str(Path(__file__).resolve().parent))
        res = subprocess.run([node, "-e", f"const path = require('path'); const HERE = {here}; " + script, json.dumps(arg)], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)
        return json.loads(res.stdout)

    def test_page_settles_provenance_as_the_server_checks(self):
        """names.js settleProvenance (the page, just before a save) gives an edited box what
        edit_provenance wants, from the server's copy, whatever stale provenance the page holds:
        an undo after a saved edit, an outcome changed in the same save, an autosave mid-drag."""
        X0, X1 = lc.box_corners(100, 50, 163, 138), lc.box_corners(110, 60, 173, 148)
        pf = {"i": 0, "corners": X0, "outcome": "card", "score": 0.9}
        carried = self.box_target(corners=X0, labelSource="carried", cornerSource="carried", carriedFrom={"frame": "f0", "target": "B001"})
        pending = self.box_target(corners=X0, cornerSource="prefill", pending=True, prefill=pf)
        pending.pop("labelSource")
        corrected = dict(pending, corners=X1, labelSource="prefill-corrected", cornerSource="prefill-edited")
        corrected.pop("pending")
        cases = [  # (the server's copy, the page's box before it is settled)
            (dict(carried, corners=X1, labelSource="carried-corrected"), carried),          # undo of a saved edit of a kept box
            (corrected, pending),                                                            # undo of a saved edit of a pending model box
            (corrected, dict(pending, labelSource="prefill-accepted", cornerSource="prefill", outcome="card-back")),  # back on the proposal + b
            (carried, dict(carried, corners=X1)),                                            # an autosave mid-drag: not yet corrected
            (pending, dict(pending, corners=X1)),
            (self.prefill_box(), dict(self.prefill_box(), corners=X1, labelSource="manual")),
            (self.box_target(labelSource="propagated", cornerSource="propagated", propagatedFrom={"frame": "f0", "target": "B001", "steps": 1, "score": 0.9}),
             self.box_target(corners=X1, labelSource="propagated", cornerSource="propagated", propagatedFrom={"frame": "f0", "target": "B001", "steps": 1, "score": 0.9})),
            (carried, dict(carried, labelSource="carried-corrected")),                       # not moved: the server's own back
        ]
        got = self.node_json("const G = require(path.join(HERE, 'boxgeom.js')), N = require(path.join(HERE, 'names.js'));"
                             "const cs = JSON.parse(process.argv[1]); console.log(JSON.stringify(cs.map(([b, t]) => {"
                             " N.settleProvenance(G, [t], new Map([[t.id, b]]), true); return t; })));", cases)
        for (old, _page), new in zip(cases, got):
            self.assertEqual(lc.geometry_changes({"targets": [old]}, {"targets": [new]}, "box", "training"), [], (old, new))
        self.assertEqual(got[0]["labelSource"], "carried-corrected", "an undo to the old place is an edit to the server: still corrected")
        self.assertEqual((got[1]["labelSource"], "pending" in got[1]), ("prefill-accepted", False), "back on its proposal: accepted, as in Boxes")
        self.assertEqual(got[2]["labelSource"], "prefill-corrected", "back on its proposal with another outcome: corrected")
        self.assertEqual(got[7]["labelSource"], "carried")

    def test_small_rotated_boxes_are_accepted(self):
        """The angle check allows for corners stored at 0.1 px: a 20 to 30 px rotated box, and a
        random sample of boxes the page makes (cornersFromRect, roundAngle, then a move)."""
        base = self.box_target(corners=lc.box_corners(50, 50, 90, 90))
        for w, h, a in ((20, 28, 17.3), (24, 30, -63.21), (30, 22, 141.07), (21, 29, 2.5)):
            c = self.rotated(400, 300, w, h, a)
            self.assertEqual(lc.geometry_changes({"targets": [base]}, {"targets": [dict(base, corners=c, angle=a)]}, "box", "training"), [], (w, h, a))
        boxes = self.node_json("const G = require(path.join(HERE, 'boxgeom.js')); let seed = 11;"
                               "const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; const out = [];"
                               "while (out.length < 3000) { const w = 12 + rnd() * 200, h = 12 + rnd() * 280, a = G.roundAngle(rnd() * 360 - 180);"
                               " if (a === 0) continue; const c = G.cornersFromRect({ cx: 300 + rnd() * 1300, cy: 300 + rnd() * 500, w, h, angle: a });"
                               " out.push({ c, a, m: G.translateCorners(c, rnd() * 50 - 25, rnd() * 50 - 25, 1920, 1080) }); }"
                               "console.log(JSON.stringify(out));", 0)
        refused = 0
        for b in boxes:
            rot = dict(base, corners=b["c"], angle=b["a"])
            refused += bool(lc.geometry_changes({"targets": [base]}, {"targets": [rot]}, "box", "training"))
            refused += bool(lc.geometry_changes({"targets": [rot]}, {"targets": [dict(rot, corners=b["m"])]}, "box", "training"))
        self.assertEqual(refused, 0)
        # still refused: an angle well off the top edge, on a small box too
        c = self.rotated(400, 300, 24, 30, 17.3)
        self.assertTrue(lc.geometry_changes({"targets": [base]}, {"targets": [dict(base, corners=c, angle=19.5)]}, "box", "training"))

    def test_edit_angle_must_be_a_finite_number(self):
        moved = dict(self.box_target(), corners=lc.box_corners(310, 210, 250, 120))
        for bad in (float("inf"), float("-inf"), float("nan"), True, "0"):
            errs = lc.geometry_changes({"targets": [self.box_target()]}, {"targets": [dict(moved, angle=bad)]}, "box", "training")
            self.assertTrue(errs and "angle" in errs[0], (bad, errs))

    def test_pending_changes_only_by_an_edit(self):
        """A model box is finalized in the Names pass only by an edit of it: pending and suggestion
        may go from present to absent in a save that edits the box, and change no other way."""
        X1 = lc.box_corners(110, 60, 173, 148)
        p0 = dict(self.prefill_box(), pending=True, suggestion=True)
        p0.pop("labelSource")
        gc = lambda o, n: lc.geometry_changes({"targets": [o]}, {"targets": [n]}, "box", "training")
        dropped = {k: v for k, v in p0.items() if k not in ("pending", "suggestion")}
        self.assertTrue(gc(p0, dropped), "dropped without an edit: refused (it would enter the export)")
        self.assertTrue(gc(p0, dict(p0, pending=False)))
        edited = dict(dropped, corners=X1, labelSource="prefill-corrected", cornerSource="prefill-edited")
        self.assertEqual(gc(p0, edited), [], "an edit finalizes it, as in the Boxes pass")
        self.assertEqual(gc(p0, dict(edited, pending=True, suggestion=True)), [], "an edit may also leave it pending")
        self.assertTrue(gc(dropped, dict(dropped, pending=True)), "never added")
        self.assertTrue(gc(edited, dict(edited, corners=lc.box_corners(120, 60, 183, 148), pending=True)), "never added, not by an edit either")

    def test_round_angle_matches_boxgeom(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node not on PATH")
        vals = [0, 30, 89.995, -89.995, 179.999, -179.999, 180, -180, 270, 450.004, 0.005, -0.005, 1.115, -1.115, 359.995]
        js = ("const G = require(%s); console.log(JSON.stringify(%s.map((a) => G.roundAngle(a))));"
              % (json.dumps(str(Path(__file__).resolve().parent / "boxgeom.js")), json.dumps(vals)))
        out = json.loads(subprocess.run([node, "-e", js], capture_output=True, text=True, check=True).stdout)
        self.assertEqual([lc.round_angle(v) for v in vals], out)

    def test_strip_keeps_box_geometry(self):
        t = self.box_target(ignore=True, identity="TOY-001")
        self.assertEqual(lc.strip_answers(t, "box"), {"id": "B001", "corners": t["corners"], "estimated": [False] * 4, "cornerSource": "box"})


class IdentifyWalk(unittest.TestCase):
    def frames(self):
        box = lambda i, **kw: {"id": i, "corners": lc.box_corners(0, 0, 10, 14), "cornerSource": "box", "outcome": "card", **kw}  # noqa: E731
        return [
            {"name": "f00002.jpg", "t": 1, "targets": [box("B001", identity="TOY-001", eligible="yes"), box("B002")]},
            {"name": "f00001.jpg", "t": 0, "targets": [box("B001", outcome="card-back"), box("B002", ignore=True),
                                                       box("B003", identity="unknown", eligible="uncertain"), box("B004"),
                                                       box("B005", outcome="not-card"), box("B006", outcome=None)]},
            {"name": "f00003.jpg", "t": 2, "targets": []},
        ]

    def test_queue_skips_identified_backs_ignored(self):
        q = lc.identify_queue(self.frames())
        self.assertEqual(q, [{"frame": "f00001.jpg", "target": "B004"}, {"frame": "f00001.jpg", "target": "B006"},
                             {"frame": "f00002.jpg", "target": "B002"}])

    def test_queue_includes_named_cards_without_readability(self):
        frames = self.frames()
        frames[0]["targets"].append({"id": "B007", "corners": lc.box_corners(0, 0, 10, 14), "cornerSource": "box",
                                     "outcome": "card", "identity": "TOY-002"})  # named in box mode, no y/n/m
        q = lc.identify_queue(frames)
        self.assertIn({"frame": "f00002.jpg", "target": "B007"}, q)
        self.assertNotIn({"frame": "f00002.jpg", "target": "B001"}, q)  # named and answered
        self.assertNotIn({"frame": "f00001.jpg", "target": "B003"}, q)  # unknown: nothing to answer

    def test_geometry_guard(self):
        old = self.frames()[0]
        new = json.loads(json.dumps(old))
        new["targets"][1].update(identity="TOY-120", eligible="yes", identitySource="decklist", conditions={"glare": True})
        self.assertEqual(lc.geometry_changes(old, new), [])  # answers only: fine
        moved = json.loads(json.dumps(new))
        moved["targets"][1]["corners"][0][0] += 1
        self.assertTrue(lc.geometry_changes(old, moved))
        gone = json.loads(json.dumps(new))
        gone["targets"].pop()
        self.assertTrue(lc.geometry_changes(old, gone))
        ign = json.loads(json.dumps(new))
        ign["targets"][1]["ignore"] = True
        self.assertTrue(lc.geometry_changes(old, ign))

    def test_geometry_guard_keeps_carried_and_propagated_provenance(self):
        """The identity pass answers a carried/propagated box without touching its provenance
        (which records geometry edits only); a manual box's labelSource stays free."""
        old = self.frames()[1]
        old["targets"][1].update(labelSource="carried", cornerSource="carried", carriedFrom={"frame": "f0", "target": "B002"})
        old["targets"][2].update(labelSource="propagated", cornerSource="propagated",
                                 propagatedFrom={"frame": "f0", "target": "B003", "steps": 1, "score": 0.9})
        answered = json.loads(json.dumps(old))
        answered["targets"][1].update(identity="TOY-120", eligible="yes")
        answered["targets"][0]["labelSource"] = "manual"
        self.assertEqual(lc.geometry_changes(old, answered), [])
        for tid, change in ((1, {"labelSource": "carried-corrected"}), (2, {"labelSource": "propagated-corrected"}),
                            (1, {"carriedFrom": {"frame": "f9", "target": "B002"}}), (2, {"propagatedFrom": None}),
                            (1, {"labelSource": "manual"})):
            bad = json.loads(json.dumps(answered))
            bad["targets"][tid].update(change)
            errs = lc.geometry_changes(old, bad)
            self.assertTrue(errs and "provenance" in errs[0], (tid, change, errs))


class Decklist(unittest.TestCase):
    CATALOG = [{"id": "TOY-001", "name": "Amber Kitemaker"}, {"id": "NEW-082", "name": "Jade Lantern, Lit"},
               {"id": "TOY-120", "name": "Kite"}]

    def test_parse(self):
        text = "# my deck\n3 Amber Kitemaker\nnew-082\n2x Kite\n\nAmber Kitemaker\nNot A Card\n"
        r = lc.parse_decklist(text, self.CATALOG)
        self.assertEqual(r["ids"], ["TOY-001", "NEW-082", "TOY-120"])
        self.assertEqual(r["unresolved"], ["Not A Card"])

    def test_counts_both_sides_and_unmatched(self):
        cat = self.CATALOG + [{"id": "OLD-001", "name": "Violet Drum, Loud"}, {"id": "TOY-036", "name": "Violet Drum, Loud"},
                              {"id": "NEW-082A", "name": "Jade Lantern, Lit", "printingOf": "NEW-082"}]
        text = ("Main Deck:\n3x Amber Kitemaker\nKite x2\njade lantern, lit ×1\nViolet Drum, Loud (3)\n"
                "Violet\u2019s Hammer\n  4  kite  \n")
        r = lc.parse_decklist(text, cat)
        # a shared name → every printing (base first), reported, never one of them guessed
        self.assertEqual(r["ids"], ["TOY-001", "TOY-120", "NEW-082", "NEW-082A", "OLD-001", "TOY-036"])
        self.assertEqual([a["ids"] for a in r["ambiguous"]], [["NEW-082", "NEW-082A"], ["OLD-001", "TOY-036"]])
        self.assertEqual(r["unresolved"], ["Main Deck:", "Violet\u2019s Hammer"])
        self.assertEqual(r["counts"]["TOY-001"], 3)
        self.assertEqual(r["counts"]["TOY-120"], 6)  # 2 + 4 over two lines
        self.assertEqual(lc.split_count("Name x3"), (3, "Name"))
        self.assertEqual(lc.split_count("3 x Name"), (3, "Name"))
        self.assertEqual(lc.split_count("Name (x2)"), (2, "Name"))
        self.assertEqual(lc.split_count("Name"), (None, "Name"))
        # typographic quotes match their ASCII spelling, nothing fuzzier
        cat2 = [{"id": "X-001", "name": "Jade's Lantern"}]
        self.assertEqual(lc.parse_decklist("Jade\u2019s Lantern\nJades Lantern\n", cat2)["ids"], ["X-001"])
        self.assertEqual(lc.parse_decklist("Jades Lantern\n", cat2)["unresolved"], ["Jades Lantern"])
        # base printings come before alternate ones (entries with printingOf), whatever the ids
        cat3 = [{"id": "A-PROMO", "name": "Kite", "printingOf": "Z-900"}, {"id": "Z-900", "name": "Kite"}]
        self.assertEqual(lc.catalog_name_index(cat3), {"kite": ["Z-900", "A-PROMO"]})

    def test_label(self):
        self.assertEqual(lc.decklist_label("# label: Player A\nTOY-001\n", "a"), "Player A")
        self.assertEqual(lc.decklist_label("# Player: Player B\n", "a"), "Player B")
        self.assertEqual(lc.decklist_label("TOY-001\n", "fallback"), "fallback")


class CenterModeTests(unittest.TestCase):
    """Center mode (a center census): roles, prefill, row validation."""

    @staticmethod
    def row(centers, **kw):
        fr = {"name": "f02346.jpg", "t": 2346.0, "frameW": 1920, "frameH": 1080, "done": True,
              "centers": centers, "centerSeq": max([lc.center_number(c.get("id")) or 0 for c in centers] or [0])}
        fr.update(kw)
        return fr

    def test_mode_and_roles(self):
        self.assertIn("center", lc.MODES)
        self.assertIn("center", lc.SET_MODES)
        self.assertNotIn("center", lc.IDENTIFY_SET_MODES)
        lc.check_mode_role("center", "development", False)
        lc.check_mode_role("center", "test", False)
        with self.assertRaises(ValueError):
            lc.check_mode_role("center", "training", False)
        for role in ("development", "test"):
            with self.assertRaises(ValueError):
                lc.check_mode_role("center", role, True)
        self.assertFalse(lc.prefill_allowed("center", "development"))

    def test_rows_validate(self):
        ok = self.row([{"id": "C001", "x": 0.5, "y": 0.25, "kind": "face"},
                       {"id": "C003", "x": 0.0, "y": 1.0, "kind": "back"}], centerSeq=4)
        self.assertEqual(lc.validate_frame(ok, "center", "development"), [])
        self.assertEqual(lc.validate_frame(ok, "center", "test"), [])
        # zero clicks confirmed = no cards on the frame
        self.assertEqual(lc.validate_frame(self.row([]), "center", "development"), [])
        # the verify pass's answers follow their contract (CenterVerify below); other extra keys pass
        verified = self.row([{"id": "C001", "x": 0.5, "y": 0.5, "kind": "face", "identity": "TOY-001", "printing": None,
                              "eligible": "yes", "verifiedBy": "picked", "blind": False, "note": "kept",
                              "verifiedAt": {"x": 0.5, "y": 0.5, "armsManifestSha256": "abc"}}])
        self.assertEqual(lc.validate_frame(verified, "center", "development"), [])
        self.assertEqual(lc.CENTER_VERIFY_KEYS, ("identity", "printing", "eligible", "verifiedBy", "blind", "verifiedAt", "correction",
                                                 "readabilityAt", "revealedAt"))
        self.assertEqual(lc.VERIFY_SERVER_KEYS, ("readabilityAt", "revealedAt"))
        self.assertEqual(lc.PENDING_KEYS, ("eligible", "blind", "readabilityAt", "revealedAt"))

    def test_rows_refused(self):
        bad = {
            "x above 1": [{"id": "C001", "x": 1.0001, "y": 0.5, "kind": "face"}],
            "y below 0": [{"id": "C001", "x": 0.5, "y": -0.01, "kind": "face"}],
            "x missing": [{"id": "C001", "y": 0.5, "kind": "face"}],
            "x a bool": [{"id": "C001", "x": True, "y": 0.5, "kind": "face"}],
            "x NaN": [{"id": "C001", "x": float("nan"), "y": 0.5, "kind": "face"}],
            "kind": [{"id": "C001", "x": 0.5, "y": 0.5, "kind": "card"}],
            "kind missing": [{"id": "C001", "x": 0.5, "y": 0.5}],
            "duplicate id": [{"id": "C001", "x": 0.5, "y": 0.5, "kind": "face"}, {"id": "C001", "x": 0.6, "y": 0.5, "kind": "back"}],
            "id form": [{"id": "Q001", "x": 0.5, "y": 0.5, "kind": "face"}],
            "short id": [{"id": "C1", "x": 0.5, "y": 0.5, "kind": "face"}],
        }
        for what, centers in bad.items():
            with self.subTest(what):
                fr = self.row([c for c in centers], centerSeq=5)
                self.assertTrue(lc.validate_frame(fr, "center", "development"), what)
        good = [{"id": "C002", "x": 0.5, "y": 0.5, "kind": "face"}]
        self.assertTrue(lc.validate_frame(self.row(good, centerSeq=1), "center", "development"), "centerSeq below an id")
        self.assertTrue(lc.validate_frame(self.row(good, frameW=0), "center", "development"))
        self.assertTrue(lc.validate_frame(self.row(good, targets=[]), "center", "development"))
        self.assertTrue(lc.validate_frame(self.row(good, prefillOffered=True), "center", "development"))
        self.assertTrue(lc.validate_frame(self.row(good), "center", "training"), "no training role")
        # other modes never carry centers
        self.assertTrue(lc.validate_frame({"name": "f.jpg", "points": [], "centers": []}, "point"))

    def test_seq_never_goes_back(self):
        old = self.row([{"id": "C001", "x": 0.5, "y": 0.5, "kind": "face"}], centerSeq=3)
        self.assertEqual(lc.center_seq_errors(None, old), [])
        self.assertEqual(lc.center_seq_errors(old, self.row([], centerSeq=3)), [])
        self.assertEqual(lc.center_seq_errors(old, self.row([], centerSeq=4)), [])
        self.assertTrue(lc.center_seq_errors(old, self.row([], centerSeq=2)))
        no_seq = self.row([])
        del no_seq["centerSeq"]
        self.assertTrue(lc.center_seq_errors(old, no_seq))

    def test_normalize_rounds_only(self):
        fr = self.row([{"id": "C001", "x": 0.123456789, "y": 0.5, "kind": "back", "note": "kept"}])
        out = lc.normalize_frame(fr, "center")
        self.assertEqual(out["centers"], [{"id": "C001", "x": 0.123457, "y": 0.5, "kind": "back", "note": "kept"}])
        self.assertNotIn("targets", out)


SHA = "a" * 64
TIME_1, TIME_2, TIME_3 = "2030-01-02T10:00:00.000+00:00", "2030-01-02T10:00:05.000+00:00", "2030-01-02T10:00:09.000+00:00"
ARMS = ("new", "old")  # a run's arms, in command-line order


def ra(x=0.5, y=0.25, at=TIME_1):
    """A server readabilityAt stamp."""
    return {"x": x, "y": y, "at": at}


def vc(cid="C001", x=0.5, y=0.25, kind="face", **answer):
    c = {"id": cid, "x": x, "y": y, "kind": kind}
    if answer:
        answer.setdefault("blind", False)
        answer.setdefault("verifiedAt", {"x": x, "y": y, "armsManifestSha256": SHA})
    c.update(answer)
    return c


def arms(new=None, old=None, new_id=None, old_id=None):
    def one(name, pid):
        return {"box": [10, 20, 63, 88] if name else None, "boxScore": 0.9, "name": name, "printingId": pid,
                "similarity": 0.8, "margin": 0.1, "look": 0}
    return {"new": one(new, new_id), "old": one(old, old_id)}


def prow(**arm_kw):
    """One center's proposals as the server keeps them: {armsManifestSha256, arms: {name: view}}."""
    return {"armsManifestSha256": SHA, "arms": arms(**arm_kw)}


class CenterVerify(unittest.TestCase):
    """verify mode: naming a center census, answers only."""

    def row(self, centers, **kw):
        fr = {"name": "f00001.jpg", "t": 0, "frameW": 1920, "frameH": 1080, "done": True, "centers": centers,
              "centerSeq": max([lc.center_number(c.get("id")) or 0 for c in centers] or [0])}
        fr.update(kw)
        return fr

    def test_mode_role(self):
        self.assertIn("verify", lc.MODES)
        self.assertNotIn("verify", lc.SET_MODES)
        lc.check_mode_role("verify", "development", False)
        for role in ("test", "training"):
            with self.assertRaises(ValueError):
                lc.check_mode_role("verify", role, False)
        with self.assertRaises(ValueError):
            lc.check_mode_role("verify", "development", True)

    def test_answer_contract_ok(self):
        ok = [vc(verifiedBy="accept-new", identity="TOY-001", eligible="yes"),
              vc(verifiedBy="accept-old", identity="TOY-001"),  # readability still to come
              vc(verifiedBy="accept-both", identity="TOY-001", printing=None, eligible="uncertain"),
              vc(verifiedBy="picked", identity="TOY-001", printing="TOY-001A", eligible="no", blind=True),
              vc(verifiedBy="unknown", identity="unknown", blind=True),
              vc(verifiedBy="not-card", correction="not-card"),
              vc(verifiedBy="back", correction="back", blind=True),
              vc()]  # no answer at all
        for c in ok:
            with self.subTest(c):
                self.assertEqual(lc.center_answer_errors(c), [])
                self.assertEqual(lc.validate_frame(self.row([c]), "center", "development"), [])

    def test_answer_contract_refused(self):
        at = {"x": 0.5, "y": 0.25, "armsManifestSha256": SHA}
        bad = {
            "no verifiedBy": dict(identity="TOY-001"),
            "unknown verifiedBy": dict(verifiedBy="someone", identity="TOY-001", blind=False, verifiedAt=at),
            "accept of a bad arm name": dict(verifiedBy="accept-New Arm", identity="TOY-001", blind=False, verifiedAt=at),
            "blind missing": dict(verifiedBy="picked", identity="TOY-001", verifiedAt=at),
            "blind not bool": dict(verifiedBy="picked", identity="TOY-001", blind="no", verifiedAt=at),
            "verifiedAt missing": dict(verifiedBy="picked", identity="TOY-001", blind=False),
            "verifiedAt no sha": dict(verifiedBy="picked", identity="TOY-001", blind=False, verifiedAt={"x": 0.5, "y": 0.25}),
            "verifiedAt x out": dict(verifiedBy="picked", identity="TOY-001", blind=False, verifiedAt=dict(at, x=1.5)),
            "accept on blind": dict(verifiedBy="accept-new", identity="TOY-001", blind=True, verifiedAt=at),
            "named without id": dict(verifiedBy="picked", identity=None, blind=False, verifiedAt=at),
            "named as unknown": dict(verifiedBy="accept-new", identity="unknown", blind=False, verifiedAt=at),
            "eligible value": dict(verifiedBy="picked", identity="TOY-001", eligible="maybe", blind=False, verifiedAt=at),
            "named with correction": dict(verifiedBy="picked", identity="TOY-001", correction="back", blind=False, verifiedAt=at),
            "unknown with id": dict(verifiedBy="unknown", identity="TOY-001", blind=False, verifiedAt=at),
            "unknown with eligible": dict(verifiedBy="unknown", identity="unknown", eligible="no", blind=False, verifiedAt=at),
            "not-card without correction": dict(verifiedBy="not-card", blind=False, verifiedAt=at),
            "back with not-card": dict(verifiedBy="back", correction="not-card", blind=False, verifiedAt=at),
            "correction with identity": dict(verifiedBy="back", correction="back", identity="TOY-001", blind=False, verifiedAt=at),
            "correction other value": dict(verifiedBy="picked", identity="TOY-001", correction="face", blind=False, verifiedAt=at),
            "printing empty": dict(verifiedBy="picked", identity="TOY-001", printing="", blind=False, verifiedAt=at),
        }
        for what, answer in bad.items():
            with self.subTest(what):
                c = {"id": "C001", "x": 0.5, "y": 0.25, "kind": "face", **answer}
                self.assertTrue(lc.center_answer_errors(c), what)
                self.assertTrue(lc.validate_frame(self.row([c]), "center", "development"), what)

    def test_complete_and_stale(self):
        named = vc(verifiedBy="picked", identity="TOY-001")
        self.assertFalse(lc.answer_complete(named), "readability y / m / n still to come")
        self.assertTrue(lc.answer_complete(dict(named, eligible="yes")))
        self.assertTrue(lc.answer_complete(vc(verifiedBy="unknown", identity="unknown")))
        self.assertTrue(lc.answer_complete(vc(verifiedBy="back", correction="back")))
        self.assertFalse(lc.answer_complete(vc()))
        done = dict(named, eligible="yes")
        self.assertFalse(lc.answer_stale(done, SHA))
        self.assertTrue(lc.center_verified(done, SHA))
        moved = dict(done, x=0.5006)  # the marker moved one pixel in center mode
        self.assertTrue(lc.answer_stale(moved, SHA))
        self.assertFalse(lc.center_verified(moved, SHA))
        self.assertTrue(lc.answer_stale(done, "b" * 64), "another proposals run")
        self.assertFalse(lc.answer_stale(vc(), SHA), "no answer: nothing to be stale")

    def test_walk_faces_in_order(self):
        frames = [self.row([vc("C010"), vc("C002", kind="back"), vc("C003")], name="f00002.jpg"),
                  self.row([vc("C001")], name="f00001.jpg")]
        self.assertEqual(lc.verify_walk(frames), [{"frame": "f00002.jpg", "id": "C003"}, {"frame": "f00002.jpg", "id": "C010"},
                                                  {"frame": "f00001.jpg", "id": "C001"}])
        self.assertEqual([e["id"] for e in lc.verify_walk(frames, include_backs=True)], ["C002", "C003", "C010", "C001"])

    def test_geometry_guard_and_merge(self):
        old = self.row([vc("C001"), vc("C002", kind="back", verifiedBy="back", correction="back")], centerSeq=4)
        new = json.loads(json.dumps(old))
        new["centers"][0].update(verifiedBy="picked", identity="TOY-001", blind=False,
                                 verifiedAt={"x": 0.5, "y": 0.25, "armsManifestSha256": SHA})
        for k in ("verifiedBy", "correction", "blind", "verifiedAt"):  # Backspace cleared C002's answer
            new["centers"][1].pop(k)
        new["done"] = False  # the page never confirms in verify; the server keeps the stored done
        self.assertEqual(lc.verify_geometry_changes(old, new), [])
        merged = lc.verify_merge(old, new)
        self.assertEqual(merged["centers"][0]["identity"], "TOY-001")
        self.assertEqual(merged["centers"][1], {"id": "C002", "x": 0.5, "y": 0.25, "kind": "back"})
        self.assertEqual((merged["done"], merged["centerSeq"]), (True, 4))
        refused = {
            "x moved": lambda r: r["centers"][0].update(x=0.6),
            "y moved": lambda r: r["centers"][0].update(y=0.1),
            "kind": lambda r: r["centers"][0].update(kind="back"),
            "id": lambda r: r["centers"][0].update(id="C009"),
            "removed": lambda r: r["centers"].pop(),
            "added": lambda r: r["centers"].append(vc("C005")),
            "duplicated": lambda r: r["centers"].append(dict(r["centers"][0])),
            "centerSeq": lambda r: r.update(centerSeq=5),
            "frameW": lambda r: r.update(frameW=1280),
            "other center key": lambda r: r["centers"][0].update(note="x"),
        }
        for what, fn in refused.items():
            with self.subTest(what):
                n = json.loads(json.dumps(old))
                fn(n)
                self.assertTrue(lc.verify_geometry_changes(old, n), what)

    def test_answer_against_proposals(self):
        names = {"TOY-001": "Amber Kitemaker", "TOY-001A": "Amber Kitemaker", "TOY-120": "Kite"}
        agree = prow(new="Amber Kitemaker", old="Amber Kitemaker", new_id="TOY-001", old_id="TOY-001A")
        differ = prow(new="Amber Kitemaker", old="Kite", new_id="TOY-001", old_id="TOY-120")
        none = prow(new=None, old="Kite", old_id="TOY-120")
        # readability first: every name or Unknown after a stamped readability; an
        # accept after the reveal (revealedAt no earlier than the readability)
        shown = dict(eligible="yes", readabilityAt=ra(), revealedAt=TIME_2)  # readability, then the reveal
        read = dict(eligible="uncertain", readabilityAt=ra())  # readability, no reveal (blind)
        ok = [(vc(verifiedBy="accept-new", identity="TOY-001", **shown), agree, False),
              (vc(verifiedBy="accept-old", identity="TOY-001A", **shown), agree, False),
              (vc(verifiedBy="accept-both", identity="TOY-001", **shown), agree, False),
              (vc(verifiedBy="accept-old", identity="TOY-120", **shown), differ, False),
              (vc(verifiedBy="accept-old", identity="TOY-120", **shown), none, False),
              (vc(verifiedBy="picked", identity="TOY-120", blind=True, **read), agree, True),
              (vc(verifiedBy="picked", identity="TOY-120", **shown), differ, False),  # / after the reveal
              (vc(verifiedBy="unknown", identity="unknown", blind=True, **read), None, True),
              (vc(verifiedBy="unknown", identity="unknown", **shown), agree, False),
              (vc(verifiedBy="back", correction="back"), agree, False),  # corrections need no readability
              (vc(verifiedBy="not-card", correction="not-card", **shown), agree, False)]
        for c, p, blind in ok:
            with self.subTest(c["verifiedBy"]):
                self.assertEqual(lc.center_answer_errors(c), [])
                self.assertEqual(lc.verify_answer_errors(c, p, blind, SHA, names, ARMS), [])
        # a readability alone (pending): only its blind flag is checked
        pending = {"id": "C001", "x": 0.5, "y": 0.25, "kind": "face", "eligible": "no", "blind": False, "readabilityAt": ra()}
        self.assertEqual(lc.verify_answer_errors(pending, agree, False, SHA, names, ARMS), [])
        self.assertEqual(lc.verify_answer_errors(dict(pending, revealedAt=TIME_2), agree, False, SHA, names, ARMS), [])
        self.assertEqual(lc.verify_answer_errors(dict(pending, blind=True), agree, True, SHA, names, ARMS), [])
        self.assertTrue(lc.verify_answer_errors(pending, agree, True, SHA, names, ARMS), "pending: blind flag not the subsample's")
        bad = [(vc(verifiedBy="accept-both", identity="TOY-001", **shown), differ, False, "different names"),
               (vc(verifiedBy="accept-new", identity="TOY-001", **shown), none, False, "the new arm showed nothing"),
               (vc(verifiedBy="accept-new", identity="TOY-120", **shown), agree, False, "not the arm's card"),
               (vc(verifiedBy="accept-new", identity="TOY-001", **read), agree, True, "accept on a blind center"),
               (vc(verifiedBy="picked", identity="TOY-001", **read), agree, True, "blind flag not the subsample's"),
               (vc(verifiedBy="picked", identity="TOY-001", blind=True, **read), agree, False, "blind flag on an assisted center"),
               (vc(verifiedBy="picked", identity="NOPE-001", **shown), agree, False, "not in the catalog"),
               (vc(verifiedBy="picked", identity="TOY-001", verifiedAt={"x": 0.4, "y": 0.25, "armsManifestSha256": SHA}, **shown), agree, False, "position"),
               (vc(verifiedBy="picked", identity="TOY-001", verifiedAt={"x": 0.5, "y": 0.25, "armsManifestSha256": "b" * 64}, **shown), agree, False, "run"),
               # readability first
               (vc(verifiedBy="accept-new", identity="TOY-001", eligible="yes", readabilityAt=ra()), agree, False, "accept without a reveal"),
               (vc(verifiedBy="accept-new", identity="TOY-001"), agree, False, "accept without readability or reveal"),
               (vc(verifiedBy="accept-new", identity="TOY-001", eligible="yes", revealedAt=TIME_2), agree, False, "accept, readability unstamped"),
               (vc(verifiedBy="accept-new", identity="TOY-001", eligible="yes", readabilityAt=ra(at=TIME_3), revealedAt=TIME_2), agree, False,
                "readability stamped after the reveal"),
               (vc(verifiedBy="accept-new", identity="TOY-001", eligible="yes", readabilityAt=ra(x=0.4), revealedAt=TIME_2), agree, False,
                "readability stamped for another position"),
               (vc(verifiedBy="picked", identity="TOY-120", blind=True), agree, True, "blind picked without readability"),
               (vc(verifiedBy="picked", identity="TOY-120", blind=True, eligible="yes"), agree, True, "blind picked, readability unstamped"),
               (vc(verifiedBy="unknown", identity="unknown", blind=True), None, True, "unknown without readability"),
               (vc(verifiedBy="unknown", identity="unknown", blind=True, **shown), None, True, "a reveal on a blind center")]
        for c, p, blind, what in bad:
            with self.subTest(what):
                self.assertTrue(lc.verify_answer_errors(c, p, blind, SHA, names, ARMS) or lc.center_answer_errors(c), what)
        # an accept must name an arm of THIS run: another name, or accept-both in a one-arm run
        named = vc(verifiedBy="accept-third", identity="TOY-001", **shown)
        self.assertEqual(lc.center_answer_errors(named), [], "any well-formed arm name passes the stored-row contract")
        self.assertTrue(lc.verify_answer_errors(named, agree, False, SHA, names, ARMS))
        both = vc(verifiedBy="accept-both", identity="TOY-001", **shown)
        self.assertTrue(lc.verify_answer_errors(both, agree, False, SHA, names, ("new",)))
        self.assertEqual(lc.verify_answer_errors(vc(verifiedBy="accept-new", identity="TOY-001", **shown), agree, False, SHA, names, ("new",)), [])
        # each readability-first refusal is the verify check itself, not only the contract (the
        # last one, a stamp on a blind center, is the contract's: center_answer_errors)
        self.assertTrue(lc.center_answer_errors(bad[-1][0]))
        for c, p, blind, what in bad[9:-1]:
            with self.subTest(what=what, check="verify_answer_errors"):
                self.assertTrue(lc.verify_answer_errors(c, p, blind, SHA, names, ARMS), what)

    def test_which_answers_are_one_card_follows_the_catalogs_rule(self):
        """Two different cards that share a name, each with a printing of its own. Under the
        catalog's default rule ("name") a name is a card, so the two are taken as one, as
        before. Under "printing" they are two cards: "accept both" holds only when the two models
        show printings of one card, and an accept stores a card the model showed, not another
        card of that name."""
        catalog = [{"id": "TOY-201", "name": "Amber Circle", "printingOf": None}, {"id": "TOY-201A", "name": "Amber Circle", "printingOf": "TOY-201"},
                   {"id": "TOY-202", "name": "Amber Circle", "printingOf": None}, {"id": "TOY-202A", "name": "amber  circle", "printingOf": "TOY-202"}]
        names = {c["id"]: c["name"] for c in catalog}
        roots = lc.printing_roots(catalog)
        self.assertEqual(roots, {"TOY-201": "TOY-201", "TOY-201A": "TOY-201", "TOY-202": "TOY-202", "TOY-202A": "TOY-202"})
        shown = dict(eligible="yes", readabilityAt=ra(), revealedAt=TIME_2)
        two_cards = prow(new="Amber Circle", old="Amber Circle", new_id="TOY-201", old_id="TOY-202")
        one_card = prow(new="Amber Circle", old="Amber Circle", new_id="TOY-201", old_id="TOY-201A")
        cases = [  # (answer, proposals, under "name", under "printing")
            (vc(verifiedBy="accept-both", identity="TOY-201", **shown), two_cards, [],
             ["center C001: accept-both: identity 'TOY-201' is not the old arm's card ('Amber Circle')", "center C001: accept-both: the arms showed different cards"]),
            (vc(verifiedBy="accept-both", identity="TOY-201", **shown), one_card, [], []),
            (vc(verifiedBy="accept-new", identity="TOY-201", **shown), two_cards, [], []),
            (vc(verifiedBy="accept-old", identity="TOY-202", **shown), two_cards, [], []),
            (vc(verifiedBy="accept-old", identity="TOY-201", **shown), two_cards, [], ["center C001: accept-old: identity 'TOY-201' is not the old arm's card ('Amber Circle')"]),
            (vc(verifiedBy="accept-new", identity="TOY-202A", **shown), two_cards, [], ["center C001: accept-new: identity 'TOY-202A' is not the new arm's card ('Amber Circle')"]),
            (vc(verifiedBy="accept-new", identity="TOY-201A", **shown), two_cards, [], []),  # another printing of the card the model showed
        ]
        for c, p, by_name, by_printing in cases:
            with self.subTest(c["verifiedBy"], identity=c["identity"], old=p["arms"]["old"]["printingId"]):
                self.assertEqual(lc.verify_answer_errors(c, p, False, SHA, names, ARMS), by_name, "the default rule: as before")
                self.assertEqual(lc.verify_answer_errors(c, p, False, SHA, names, ARMS, "name", roots), by_name)
                self.assertEqual(lc.verify_answer_errors(c, p, False, SHA, names, ARMS, "printing", roots), by_printing)
        # the words of the default rule, exactly as they were
        differ = prow(new="Amber Circle", old="Kite", new_id="TOY-201", old_id="TOY-120")
        self.assertEqual(lc.verify_answer_errors(vc(verifiedBy="accept-both", identity="TOY-201", **shown), differ, False, SHA, {**names, "TOY-120": "Kite"}, ARMS),
                         ["center C001: accept-both: identity 'TOY-201' is not the old arm's card ('Kite')", "center C001: accept-both: the arms showed different names"])
        # the rule a catalog states
        self.assertEqual([lc.identity_rule(d) for d in ({}, {"identity": "name"}, {"identity": "printing"}, {"identity": "printings"}, {"identity": None}, [])],
                         ["name", "name", "printing", None, None, "name"])
        self.assertEqual(lc.identity_rule_problem({"identity": "printings"}), '"identity" must be "name" or "printing", not "printings"')
        self.assertIsNone(lc.identity_rule_problem({"cards": []}))
        # the facets a catalog declares (the full cases: tests/test_catalog_facets.py, against the
        # repository's own reading)
        decl = [{"key": "color", "label": "Color", "values": ["Red", "Blue"]}, {"key": "cost", "label": "Cost", "type": "number"}]
        self.assertIsNone(lc.facets_problem({"cards": []}))
        self.assertIsNone(lc.facets_problem({"facets": decl, "cards": [{"id": "A", "facets": {"color": ["Red", "Blue"], "cost": 2}}]}))
        self.assertEqual(lc.facets_problem({"facets": decl + [{"key": "kind", "label": "Kind"}]}),
                         'facets[2]: "key" "kind" is reserved: the card\'s kind is always the first filter')
        self.assertEqual(lc.facets_problem({"facets": decl, "cards": [{"id": "A", "facets": {"color": "Teal"}}]}),
                         'card A: facets.color: "Teal" is not one of the declared values')
        self.assertEqual(lc.facets_problem({"facets": decl, "cards": [{"id": "A", "facets": {"cost": "2"}}]}),
                         'card A: facets.cost: "2" is not a number')
        self.assertEqual(lc.facets_problem({"cards": [{"id": "A", "facets": {"set": "X"}}]}),
                         'card A: facets.set: the catalog declares no facet "set"')
        # a card's extra: any object is kept and read by nothing; anything else refuses the catalog
        # (the full cases: tests/test_catalog_extra.py)
        self.assertIsNone(lc.extra_problem({"cards": [{"id": "A", "extra": {"text": "Draw.", "n": [1, {"x": None}]}}, {"id": "B"}]}))
        self.assertIsNone(lc.extra_problem([]))
        self.assertEqual(lc.extra_problem({"cards": [{"id": "A", "extra": {}}, {"id": "B", "extra": ["Draw."]}]}),
                         'card B: "extra" must be an object (any keys and values), not ["Draw."]')
        self.assertEqual(lc.extra_problem({"cards": [{"id": "A", "extra": None}]}),
                         'card A: "extra" must be an object (any keys and values), not null')
        self.assertTrue(lc.same_card("TOY-201", "Amber Circle", "TOY-202", "amber circle"))
        self.assertFalse(lc.same_card("TOY-201", "Amber Circle", "TOY-202", "Amber Circle", "printing", roots))
        self.assertFalse(lc.same_card(None, None, None, None, "printing", roots), "no card is no card")
        # printings that name each other in a ring are one card, whichever is asked first
        ring = lc.printing_roots([{"id": "B", "printingOf": "C"}, {"id": "C", "printingOf": "B"}, {"id": "E", "printingOf": "C"}, {"id": "S", "printingOf": "S"}])
        self.assertEqual(ring, {"B": "B", "C": "B", "E": "B", "S": "S"})

    def test_readability_contract(self):
        """The readability-first shapes center_answer_errors accepts and refuses."""
        base = {"id": "C001", "x": 0.5, "y": 0.25, "kind": "face"}
        ok = [dict(base, eligible="yes", blind=False, readabilityAt=ra()),  # pending
              dict(base, eligible="no", blind=True, readabilityAt=ra()),
              dict(base, eligible="uncertain", blind=False, readabilityAt=ra(), revealedAt=TIME_2),
              dict(base, eligible="uncertain", blind=False, readabilityAt=ra(), revealedAt=TIME_1),  # same ms
              vc(verifiedBy="unknown", identity="unknown", eligible="no", readabilityAt=ra()),
              vc(verifiedBy="back", correction="back", eligible="yes", readabilityAt=ra(), revealedAt=TIME_2),
              vc(verifiedBy="picked", identity="TOY-001", eligible="yes")]  # an answer that carries no stamps
        for c in ok:
            with self.subTest(c):
                self.assertEqual(lc.center_answer_errors(c), [])
        bad = {
            "pending without readabilityAt": dict(base, eligible="yes", blind=False),
            "pending without blind": dict(base, eligible="yes", readabilityAt=ra()),
            "pending eligible value": dict(base, eligible="maybe", blind=False, readabilityAt=ra()),
            "pending with a name field": dict(base, eligible="yes", blind=False, readabilityAt=ra(), identity="TOY-001"),
            "pending with verifiedAt": dict(base, eligible="yes", blind=False, readabilityAt=ra(),
                                            verifiedAt={"x": 0.5, "y": 0.25, "armsManifestSha256": SHA}),
            "stamps alone": dict(base, blind=False, readabilityAt=ra()),
            "readabilityAt malformed": dict(base, eligible="yes", blind=False, readabilityAt={"x": 0.5, "y": 0.25}),
            "readabilityAt x out": dict(base, eligible="yes", blind=False, readabilityAt=ra(x=1.5)),
            "revealedAt before readabilityAt": dict(base, eligible="yes", blind=False, readabilityAt=ra(at=TIME_3), revealedAt=TIME_2),
            "revealedAt not a time": dict(base, eligible="yes", blind=False, readabilityAt=ra(), revealedAt=7),
            "revealedAt on blind": dict(base, eligible="yes", blind=True, readabilityAt=ra(), revealedAt=TIME_2),
            "named, revealedAt without readabilityAt": vc(verifiedBy="accept-new", identity="TOY-001", eligible="yes", revealedAt=TIME_2),
            "named, readabilityAt without eligible": vc(verifiedBy="accept-new", identity="TOY-001", readabilityAt=ra(), revealedAt=TIME_2),
            "unknown, eligible unstamped": vc(verifiedBy="unknown", identity="unknown", eligible="no"),
            "correction, eligible unstamped": vc(verifiedBy="not-card", correction="not-card", eligible="no"),
        }
        for what, c in bad.items():
            with self.subTest(what):
                self.assertTrue(lc.center_answer_errors(c), what)
                self.assertTrue(lc.validate_frame(self.row([c]), "center", "development"), what)

    def test_verify_stamp(self):
        """verify_stamp / verify_merge: the stamps are the server's, the readability is fixed once
        revealed, a cleared answer keeps it, an unstamped readability is never back-stamped."""
        def merge(old_c, new_c, now=TIME_3):
            errors = []
            out = lc.verify_merge(self.row([old_c]), self.row([new_c]), now, errors)
            return out["centers"][0], errors

        fresh = {"id": "C001", "x": 0.5, "y": 0.25, "kind": "face"}
        # a readability saved: stamped now at the center's position; the page's stamps are ignored
        got, errs = merge(fresh, dict(fresh, eligible="yes", blind=False, readabilityAt=ra(at=TIME_1), revealedAt=TIME_1))
        self.assertEqual(errs, [])
        self.assertEqual(got, dict(fresh, eligible="yes", blind=False, readabilityAt=ra(at=TIME_3)))
        # an unchanged readability keeps its stamp; a changed one (before the reveal) is re-stamped
        pend = dict(fresh, eligible="yes", blind=False, readabilityAt=ra(at=TIME_1))
        self.assertEqual(merge(pend, dict(pend, readabilityAt=ra(at=TIME_2)))[0], pend)
        self.assertEqual(merge(pend, dict(pend, eligible="no"))[0], dict(pend, eligible="no", readabilityAt=ra(at=TIME_3)))
        # a pending readability cleared before the reveal: everything goes
        self.assertEqual(merge(pend, fresh), (fresh, []))
        # after the reveal: the readability cannot change, with or without a name
        shown = dict(pend, revealedAt=TIME_2)
        for what, new in {"pending": dict(shown, eligible="no"),
                          "named": dict(shown, eligible="no", verifiedBy="picked", identity="TOY-001",
                                        verifiedAt={"x": 0.5, "y": 0.25, "armsManifestSha256": SHA})}.items():
            with self.subTest(what):
                self.assertTrue(merge(shown, new)[1], what)
        # after the reveal a clear keeps eligible, blind and both stamps; the name goes
        named = dict(shown, verifiedBy="accept-new", identity="TOY-001", printing=None,
                     verifiedAt={"x": 0.5, "y": 0.25, "armsManifestSha256": SHA})
        self.assertEqual(merge(named, fresh), (shown, []))
        # the page cannot forge or drop the reveal
        self.assertEqual(merge(shown, dict(shown, revealedAt=TIME_3, readabilityAt=ra(at=TIME_2)))[0], shown)
        self.assertEqual(merge(pend, dict(pend, revealedAt=TIME_2))[0], pend, "no reveal stored: a posted revealedAt is dropped")
        # before the reveal, a named answer with a stamped readability: clear first to change it
        blind_named = dict(fresh, eligible="yes", blind=True, readabilityAt=ra(at=TIME_1), verifiedBy="picked", identity="TOY-001",
                           verifiedAt={"x": 0.5, "y": 0.25, "armsManifestSha256": SHA})
        self.assertTrue(merge(blind_named, dict(blind_named, eligible="no"))[1])
        self.assertEqual(merge(blind_named, dict(blind_named, verifiedBy="unknown", identity="unknown"))[1], [])
        # the marker moved since: the old reveal is void, the readability is stamped again
        moved = dict(shown, x=0.52)
        got, errs = merge(moved, dict(moved, eligible="no"))
        self.assertEqual((errs, got.get("revealedAt"), got["readabilityAt"]), ([], None, ra(x=0.52, at=TIME_3)))
        # the same readability posted back untouched is never re-stamped (the labeler has not looked
        # again): kept as stored, so it is not ready and no reveal is released for the new position
        got, errs = merge(moved, dict(moved))
        self.assertEqual((got, errs), (moved, []), "untouched after a move: kept as stored, not re-stamped")
        self.assertFalse(lc.readability_ready(got))
        # the page re-asks after a move: a clear first (the stamps go), then the answer, stamped afresh
        cleared, errs = merge(moved, {k: v for k, v in moved.items() if k not in lc.CENTER_VERIFY_KEYS})
        self.assertEqual((errs, [k for k in lc.CENTER_VERIFY_KEYS if k in cleared]), ([], []))
        got, errs = merge(cleared, dict(cleared, eligible="yes", blind=False))
        self.assertEqual((errs, got.get("revealedAt"), got["readabilityAt"]), ([], None, ra(x=0.52, at=TIME_3)))
        # a stale named answer (the marker moved since its reveal) posted back untouched while another
        # center is answered: kept as stored, stamps and all (an untouched stale answer never blocks
        # the frame's other centers; answering it again starts from a new readability)
        stale_named = dict(named, x=0.52)
        self.assertEqual(merge(stale_named, dict(stale_named)), (stale_named, []))
        # an answer with no stamps (eligible only) saved unchanged: never back-stamped
        unstamped = dict(fresh, eligible="yes", blind=False, verifiedBy="picked", identity="TOY-001", printing=None,
                      verifiedAt={"x": 0.5, "y": 0.25, "armsManifestSha256": SHA})
        self.assertEqual(merge(unstamped, dict(unstamped)), (unstamped, []))

    def test_a_center_id_with_a_trailing_line_break_is_not_a_center_id(self):
        self.assertEqual(lc.center_number("C007"), 7)
        for cid in ("C007\n", "C07", "c007", None, 7):
            self.assertIsNone(lc.center_number(cid), cid)

    def test_arm_names(self):
        for name in ("new", "old", "a", "model_2", "x" * 24):
            self.assertIsNone(lc.arm_name_error(name), name)
        for name in ("both", "New", "2nd", "a-b", "a b", "", "x" * 25, "new\n", None, 3):
            self.assertTrue(lc.arm_name_error(name), name)
        self.assertEqual(lc.accept_arms("accept-both", ("new", "old")), ("new", "old"))
        self.assertEqual(lc.accept_arms("accept-old", ("new", "old")), ("old",))
        self.assertIsNone(lc.accept_arms("accept-both", ("new",)))
        self.assertIsNone(lc.accept_arms("accept-third", ("new", "old")))
        self.assertIsNone(lc.accept_arms("picked", ("new", "old")))
        self.assertTrue(lc.is_accept("accept-new") and lc.is_accept("accept-both"))
        self.assertFalse(lc.is_accept("accept-") or lc.is_accept("accepted") or lc.is_accept(None))
        self.assertTrue(lc.is_named_by("picked") and lc.is_named_by("accept-new") and not lc.is_named_by("unknown"))
        self.assertTrue(all(lc.is_verified_by(v) for v in ("accept-new", "accept-both", "picked", "unknown", "not-card", "back")))
        self.assertFalse(lc.is_verified_by("someone"))

    def test_arm_proposal_from_a_prefill_record(self):
        names = {"TOY-001": "Amber Kitemaker", "TOY-120": "Kite"}
        record = {"name": "f00001.jpg", "frameW": 1920, "frameH": 1080, "boxes": [
            {"box": [900, 226, 120, 88], "cardId": "TOY-001", "sim": 0.81, "margin": 0.12, "rot": 1},
            {"box": [880, 200, 400, 300], "cardId": "TOY-120", "sim": 0.4, "margin": 0.01, "rot": 0},  # a bigger box around it
            {"box": [100, 100, 60, 84], "cardId": None, "sim": 0.2, "margin": 0.0, "rot": 0, "flag": "below-tau"}]}
        # the click at (960, 270) is in two boxes: the one whose own center is nearest wins
        got = lc.arm_proposal(record, 0.5, 0.25, 1920, 1080, names)
        self.assertEqual((got["name"], got["printingId"], got["box"], got["similarity"], got["margin"], got["look"]),
                         ("Amber Kitemaker", "TOY-001", [900.0, 226.0, 120.0, 88.0], 0.81, 0.12, 1))
        # a box the recognizer did not name: the box, and no name
        unnamed = lc.arm_proposal(record, 130 / 1920, 142 / 1080, 1920, 1080, names)
        self.assertEqual((unnamed["name"], unnamed["printingId"], unnamed["box"]), (None, None, [100.0, 100.0, 60.0, 84.0]))
        # a click in no box, or a frame the arm has no record for: nothing shown
        for nothing in (lc.arm_proposal(record, 0.05, 0.9, 1920, 1080, names), lc.arm_proposal(None, 0.5, 0.25, 1920, 1080, names)):
            self.assertEqual((nothing["box"], nothing["name"]), (None, None))
        # the record's own frame size is honored: the same boxes written for a 640 x 360 frame
        # (a third of 1920 x 1080) land on the same click and come back in the label row's pixels
        small = {"name": "f00001.jpg", "frameW": 640, "frameH": 360, "boxes": [
            {"box": [300, 75.3333, 40, 29.3334], "cardId": "TOY-001", "sim": 0.81, "margin": 0.12, "rot": 0}]}
        got = lc.arm_proposal(small, 0.5, 0.25, 1920, 1080, names)
        self.assertEqual(got["name"], "Amber Kitemaker")
        self.assertEqual(got["box"], [900.0, 226.0, 120.0, 88.0])
        # read as if it were in 1920 x 1080 pixels, that box would be nowhere near the click
        unsized = dict(small); del unsized["frameW"], unsized["frameH"]
        self.assertIsNone(lc.arm_proposal(unsized, 0.5, 0.25, 1920, 1080, names)["box"])
        self.assertEqual(lc.prefill_frame_size(small), (640.0, 360.0))
        self.assertEqual(lc.prefill_frame_size(unsized, 1920, 1080), (1920, 1080))
        self.assertEqual(lc.prefill_frame_size({"frameW": 640}, 1, 2), (1, 2))

    def test_prefill_record_errors(self):
        ok = {"name": "f00001.jpg", "frameW": 1280, "frameH": 720, "boxes": [{"box": [1, 2, 30, 40], "cardId": None}]}
        self.assertEqual(lc.prefill_row_errors(ok, "record 1"), [])
        self.assertEqual(lc.prefill_row_errors({"name": "f00001.jpg"}, "record 1"), [], "no boxes, no size: fine")
        bad = [[], {"boxes": []}, dict(ok, frameH=None), dict(ok, frameW=0), dict(ok, boxes={}), dict(ok, boxes=[{"box": [1, 2, 3]}]),
               dict(ok, boxes=[{"box": [1, 2, 0, 4]}]), dict(ok, boxes=[{"box": [1, 2, 3, 4], "cardId": 7}]), dict(ok, boxes=["x"])]
        for record in bad:
            with self.subTest(record):
                self.assertTrue(lc.prefill_row_errors(record, "record 1"))

    def test_rot_is_quarter_turns_or_degrees(self):
        # the inference command writes quarter turns (0..3); degrees (90, 180, 270) are read too
        self.assertEqual([lc.quarter_turns(r) for r in (0, 1, 2, 3, 90, 180, 270, 360, None, "x")], [0, 1, 2, 3, 1, 2, 3, 0, 0, 0])
        upright = lc.box_to_corners([10, 20, 30, 40])
        self.assertEqual(upright, [[10.0, 20.0], [40.0, 20.0], [40.0, 60.0], [10.0, 60.0]])
        self.assertEqual(lc.box_to_corners([10, 20, 30, 40], 1), upright[1:] + upright[:1])
        self.assertEqual(lc.box_to_corners([10, 20, 30, 40], 1), lc.box_to_corners([10, 20, 30, 40], 90))
        self.assertEqual(lc.box_to_corners([10, 20, 30, 40], 3), lc.box_to_corners([10, 20, 30, 40], 270))

    def test_arms_run(self):
        a = lc.arms_run_sha({"new": "1" * 64, "old": "2" * 64})
        self.assertEqual(a, lc.arms_run_sha({"old": "2" * 64, "new": "1" * 64}), "the order the arms were given in does not matter")
        self.assertNotEqual(a, lc.arms_run_sha({"new": "1" * 64, "old": "3" * 64}), "another file for an arm is another run")
        self.assertNotEqual(a, lc.arms_run_sha({"new": "1" * 64}))
        self.assertEqual(len(a), 64)

    def test_parse_blind_shapes(self):
        events = [("vidA", "f00001.jpg", "C001"), ("vidA", "f00001.jpg", "C002"), ("vidA", "f00002.jpg", "C001"),
                  ("vidB", "f00001.jpg", "C001"), ("vidB", "f00001.jpg", "C007")]
        want = {("vidA", "f00002.jpg", "C001"), ("vidB", "f00001.jpg", "C007")}
        shapes = [
            ["vidA/f00002.jpg/C001", "C007"],  # a bare id is fine when only one event has it
            ["vidA:f00002:C001", "vidB|f00001.jpg|C007"],
            [{"video": "vidA", "frame": "f00002.jpg", "centerId": "C001"}, {"video": "vidB", "name": "f00001.jpg", "id": "C007"}],
            {"seed": 1, "note": "15 %", "blind": ["vidA/f00002.jpg/C001", "vidB/f00001.jpg/C007"]},
            {"centerIds": [{"video": "vidA", "frame": "f00002", "centerId": "C001"}, "C007"]},
            {"vidA": {"f00002.jpg": ["C001"]}, "vidB": ["C007"]},
            {"ids": {"vidA": {"f00002.jpg": ["C001"]}, "vidB": ["C007"]}},
            ["vidA/f00002.jpg/C001", "vidA/f00002.jpg/C001", "C007"],  # a repeat names the same event
        ]
        for data in shapes:
            with self.subTest(data):
                keys, errors = lc.parse_blind(data, events)
                self.assertEqual(errors, [])
                self.assertEqual(keys, want)
        refused = [
            ["C001"],  # three events share C001
            ["C002", "C099"],  # unknown
            ["vidA/C001"],  # two parts: video or frame?
            ["vidA/f00009.jpg/C001"],
            ["x/vidA/f00002.jpg/C001"],  # four parts
            [{"video": "vidA", "centerId": "C001"}],  # two frames of vidA have C001
            [{"frame": "f00001.jpg"}],
            [7],
            {"blind": ["C007"], "ids": ["C007"]},  # two list keys
            {"seed": 1, "vidA": ["C002"]},  # neither a list key nor all videos
            {"vidA": {"f00001.jpg": ["vidB/f00001.jpg/C007"]}},  # contradicts its key
            "C007",
        ]
        for data in refused:
            with self.subTest(data):
                self.assertTrue(lc.parse_blind(data, events)[1], data)


if __name__ == "__main__":
    unittest.main(verbosity=1)
