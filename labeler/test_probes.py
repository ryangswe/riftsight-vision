# SPDX-License-Identifier: Apache-2.0
"""Tests for probes.py: the optional card height and angle class of a center frame, kept in their
own file. Standard library only.

Run: python3 -m unittest discover -s labeler   (or: python3 labeler/test_probes.py)
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import probes as pr  # noqa: E402


class EntryTests(unittest.TestCase):
    def test_accepts_the_three_classes_and_either_key_alone(self):
        for cls in pr.ANGLE_CLASSES:
            self.assertEqual(pr.entry_errors({"cardHeightPx": 120, "angleClass": cls}), [])
        self.assertEqual(pr.entry_errors({"cardHeightPx": 120}), [])
        self.assertEqual(pr.entry_errors({"angleClass": "<=30"}), [])

    def test_refuses_what_is_not_a_height_or_a_class(self):
        for bad in ({"cardHeightPx": 0}, {"cardHeightPx": -3}, {"cardHeightPx": 1.5}, {"cardHeightPx": "9"}, {"cardHeightPx": True},
                    {"angleClass": "45"}, {"angleClass": 30}, {"angleClass": None}, {"other": 1}, [120], "x", None):
            self.assertTrue(pr.entry_errors(bad), bad)

    def test_full_needs_both(self):
        self.assertTrue(pr.is_full({"cardHeightPx": 120, "angleClass": ">45"}))
        self.assertFalse(pr.is_full({"cardHeightPx": 120}))
        self.assertFalse(pr.is_full({"angleClass": ">45"}))
        self.assertFalse(pr.is_full({"cardHeightPx": 0, "angleClass": ">45"}))
        self.assertFalse(pr.is_full(None))

    def test_merge_keeps_the_other_value(self):
        self.assertEqual(pr.merge({"cardHeightPx": 100}, {"angleClass": "<=30"}), {"cardHeightPx": 100, "angleClass": "<=30"})
        self.assertEqual(pr.merge({"cardHeightPx": 100, "angleClass": "<=30"}, {"cardHeightPx": 90}), {"cardHeightPx": 90, "angleClass": "<=30"})
        self.assertEqual(pr.merge(None, {"cardHeightPx": 90}), {"cardHeightPx": 90})


class FileTests(unittest.TestCase):
    def test_round_trip_and_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(pr.read(tmp), {})
            pr.write(tmp, {"vidB/f1.jpg": {"angleClass": "<=30"}, "vidA/f2.jpg": {"cardHeightPx": 90, "angleClass": ">45"}})
            doc = json.loads((Path(tmp) / pr.FILE).read_text())
            self.assertEqual(list(doc), ["probes"])
            self.assertEqual(list(doc["probes"]), ["vidA/f2.jpg", "vidB/f1.jpg"])
            self.assertEqual(pr.read(tmp), doc["probes"])
            self.assertEqual(pr.read_set(tmp, "vidA"), {"f2.jpg": {"cardHeightPx": 90, "angleClass": ">45"}})
            self.assertEqual(pr.read_set(tmp, "vid"), {}, "a set id is matched whole")
            self.assertEqual([p.name for p in Path(tmp).iterdir()], [pr.FILE], "no temporary file is left")

    def test_strict_read_names_the_damage(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            self.assertEqual(pr.read_strict(d), ({}, None))
            for text in ("{not json", "[]", json.dumps({"probes": []}), json.dumps({"probes": {"a/x.jpg": {"cardHeightPx": 0}}}),
                         json.dumps({"probes": {"nokey": {"cardHeightPx": 3}}})):
                (d / pr.FILE).write_text(text)
                self.assertTrue(pr.read_strict(d)[1], text)
            (d / pr.FILE).write_text(json.dumps({"probes": {"a/x.jpg": {"cardHeightPx": 3}}}))
            self.assertEqual(pr.read_strict(d), ({"a/x.jpg": {"cardHeightPx": 3}}, None))

    def test_a_damaged_file_reads_as_empty_and_bad_entries_are_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / pr.FILE).write_text("{not json")
            self.assertEqual(pr.read(d), {})
            (d / pr.FILE).write_text(json.dumps({"probes": {"a/x.jpg": {"cardHeightPx": 5}, "a/y.jpg": {"cardHeightPx": -1}, "a/z.jpg": 7, "bad": {"cardHeightPx": 5}}}))
            self.assertEqual(pr.read(d), {"a/x.jpg": {"cardHeightPx": 5}})


if __name__ == "__main__":
    unittest.main(verbosity=1)
