# SPDX-License-Identifier: Apache-2.0
"""Tests for what makes the tool stand alone: its flags and defaults, the catalog and the
token table read from it, card art from a folder or a URL base, prefill written for another
frame size, the COCO export, the sample and toy-data scripts, a smoke test of the real server
process, and housekeeping checks on the folder itself. Generated toy data only.

Run: python3 -m unittest discover -s labeler
"""
from __future__ import annotations

import argparse
import ast
import contextlib
import io
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ["LABELER_QUIET"] = "1"
# never the real per-user folder (the list of projects opened before): see test_project.py
os.environ["LABELER_STATE_DIR"] = str(Path(tempfile.gettempdir()) / "labeler-test-state")

import export  # noqa: E402
import labelcore as lc  # noqa: E402
import make_sample  # noqa: E402
import make_toy_data  # noqa: E402
import serve  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n"


def args(**kw):
    base = dict(port=0, mode="box", role="training", labels_dir=None, sample=None, frames_dir=None,
                catalog=None, art=None, k=12, seed=1, zoom=3.0, decklist=None, prefill=None, decklists_dir=None,
                arm=None, blind=None, problems_report=None)
    base.update(kw)
    return argparse.Namespace(**base)


def quiet(fn, *a, **kw):
    """Call a script's main() without its report on the test output."""
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **kw)


class Base(unittest.TestCase):
    """A temporary folder with a sample of two frames, and a server on a free port."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="labeler-tool-test-"))
        (cls.tmp / "frames" / "vidA").mkdir(parents=True)
        for n in (1, 2):
            (cls.tmp / "frames" / "vidA" / f"f{n:05d}.png").write_bytes(PNG + bytes([n]))
        cls.sample = cls.tmp / "sample.json"
        cls.sample.write_text(json.dumps({"assets": [{"assetId": "vidA", "frames": [{"t": 0, "name": "f00001.png"}, {"t": 1, "name": "f00002.png"}]}]}))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def write_catalog(self, doc, name="catalog.json") -> Path:
        path = self.tmp / name
        path.write_text(json.dumps(doc))
        return path

    def config(self, **kw):
        kw.setdefault("sample", str(self.sample))
        serve.configure(args(**kw))

    def fetch(self, path):
        """(status, content type, body bytes)."""
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}") as r:
                return r.status, r.headers.get("Content-Type"), r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Content-Type"), e.read()

    def get(self, path):
        status, _ctype, body = self.fetch(path)
        return status, json.loads(body)


TOY = {"game": "toy", "locale": "en", "cards": [
    {"id": "TOY-001", "name": "Amber Circle", "kind": "unit", "printingOf": None, "art": "TOY-001.png"},
    {"id": "TOY-001A", "name": "Amber Circle", "kind": "unit", "printingOf": "TOY-001", "art": "alt/TOY-001A.png"},
    {"id": "TOY-009", "name": "Coral Diamond", "kind": "site", "printingOf": None, "art": "TOY-009.png"},
    {"id": "TOY-T01", "name": "Plum Square", "kind": "Token", "printingOf": None, "art": "TOY-T01.png"},
], "kinds": {"landscape": ["site"]}}


class Flags(Base):
    def test_port_flag_and_required_sample(self):
        parser = serve.build_parser()
        parsed = parser.parse_args(["--mode", "box", "--role", "training", "--sample", "s.json"])
        self.assertEqual((parsed.port, parsed.catalog, parsed.art, parsed.labels_dir, parsed.frames_dir), (serve.DEFAULT_PORT, None, None, None, None))
        self.assertEqual(parser.parse_args(["--mode", "box", "--role", "training", "--sample", "s.json", "--port", "0"]).port, 0)
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):  # no --sample: nothing is looked up anywhere else
                parser.parse_args(["--mode", "box", "--role", "training"])
            for gone in ("--proposals", "--mismatch-report"):  # replaced by --arm and --problems-report
                with self.subTest(gone), self.assertRaises(SystemExit):
                    parser.parse_args(["--mode", "verify", "--role", "development", "--sample", "s.json", gone, "x"])
        with self.assertRaises(SystemExit):
            serve.configure(args(sample=None))
        with self.assertRaises(SystemExit):
            serve.configure(args(sample=str(self.tmp / "no-such-sample.json")))

    def test_everything_defaults_to_beside_the_sample(self):
        self.config()
        cfg = serve.CFG
        self.assertEqual((cfg.labels_dir, cfg.frames_dir, cfg.decklists_dir),
                         (self.tmp.resolve() / "labels", self.tmp.resolve() / "frames", self.tmp.resolve() / "decklists"))
        self.assertEqual((cfg.catalog, cfg.art), (None, None))
        self.assertEqual(serve.load_catalog(), [], "no catalog: no card can be named, boxes can still be drawn")
        # explicit folders win
        self.config(labels_dir=str(self.tmp / "elsewhere"), frames_dir=str(self.tmp / "f2"), decklists_dir=str(self.tmp / "d2"))
        self.assertEqual(serve.CFG.labels_dir, (self.tmp / "elsewhere").resolve())
        # no path of the tool points outside what it was given: its own folder aside, every
        # configured path lies under the temporary folder
        for path in (serve.CFG.labels_dir, serve.CFG.frames_dir, serve.CFG.decklists_dir, serve.CFG.sample):
            self.assertTrue(serve._inside(Path(path), self.tmp), path)

    def test_catalog_and_art_flags(self):
        cat = self.write_catalog(TOY)
        (self.tmp / "art").mkdir(exist_ok=True)
        self.config(catalog=str(cat), art=str(self.tmp / "art"))
        self.assertEqual((serve.CFG.catalog, serve.CFG.art), (cat.resolve(), (self.tmp / "art").resolve()))
        self.config(catalog=str(cat), art="https://cards.example/art/")
        self.assertEqual(serve.CFG.art, "https://cards.example/art/")
        st, cfg = self.get("/api/config")
        self.assertEqual((cfg["mode"], cfg["art"]), ("box", True))
        # the page refuses an older server; both sides name the same number
        page = (Path(serve.__file__).parent / "sources.js").read_text(encoding="utf-8")
        self.assertEqual(cfg["pageApi"], serve.PAGE_API)
        self.assertIn(f"const PAGE_API = {serve.PAGE_API};", page)
        for bad in (dict(art=str(self.tmp / "no-such-folder")), dict(art="ftp://cards.example/"),
                    dict(catalog=str(self.tmp / "no-such-catalog.json")),
                    dict(catalog=str(self.write_catalog([1, 2], "list.json")))):
            with self.subTest(bad), self.assertRaises(SystemExit):
                self.config(**bad)
        (self.tmp / "broken.json").write_text("{not json")
        with self.assertRaises(SystemExit):
            self.config(catalog=str(self.tmp / "broken.json"))


class CatalogAndTokens(Base):
    def test_catalog_entries(self):
        self.config(catalog=str(self.write_catalog(TOY)))
        cards = serve.load_catalog()
        self.assertEqual([c["id"] for c in cards], ["TOY-001", "TOY-001A", "TOY-009", "TOY-T01"])
        self.assertEqual(cards[1], {"id": "TOY-001A", "name": "Amber Circle", "kind": "unit", "printingOf": "TOY-001", "token": False, "artUrl": None})
        self.assertEqual(serve.landscape_ids(), frozenset({"TOY-009"}), "kinds.landscape decides which cards are landscape")
        self.assertEqual(self.get("/api/catalog")[1], cards)
        # base printings before alternate ones when a deck list names a card by its name
        self.assertEqual(lc.parse_decklist("Amber Circle\n", cards)["ids"], ["TOY-001", "TOY-001A"])

    def test_catalog_facets_are_offered_and_checked_at_start(self):
        doc = {"facets": [{"key": "color", "label": "Color", "values": ["Red", "Blue"]}, {"key": "cost", "label": "Cost"}],
               "cards": [{"id": "A-1", "name": "One", "facets": {"color": ["Red", "Blue"], "cost": 2}},
                         {"id": "A-2", "name": "Two"}]}
        self.config(catalog=str(self.write_catalog(doc, "faceted.json")))
        self.assertEqual(self.get("/api/facets")[1], doc["facets"])
        cards = self.get("/api/catalog")[1]
        self.assertEqual(cards[0]["facets"], {"color": ["Red", "Blue"], "cost": 2})
        self.assertNotIn("facets", cards[1], "a card without facets is listed as before")
        self.config(catalog=str(self.write_catalog(TOY)))
        self.assertEqual(self.get("/api/facets")[1], [], "a catalog without facets: Type is the only filter")
        for bad in ({**doc, "facets": [{"key": "kind", "label": "Kind"}]},
                    {**doc, "cards": [{"id": "A-1", "name": "One", "facets": {"color": "Teal"}}]}):
            with self.subTest(bad), self.assertRaises(SystemExit):
                self.config(catalog=str(self.write_catalog(bad, "bad-facets.json")))

    def test_catalog_is_read_leniently_and_again_when_it_changes(self):
        doc = {"cards": [{"id": "A-1", "name": "One", "rarity": "common", "anything": [1, 2]}, {"name": "no id"}, "junk",
                         {"id": "A-1", "name": "a repeated id is skipped"}, {"id": "A-2", "name": "Two"}],
               "unknownTopLevelKey": True}
        path = self.write_catalog(doc, "lenient.json")
        self.config(catalog=str(path))
        self.assertEqual([(c["id"], c["name"], c["kind"]) for c in serve.load_catalog()], [("A-1", "One", None), ("A-2", "Two", None)])
        self.assertEqual(serve.landscape_ids(), frozenset())
        doc["cards"].append({"id": "A-3", "name": "Three, added while the server runs"})
        path.write_text(json.dumps(doc))
        self.assertEqual([c["id"] for c in serve.load_catalog()], ["A-1", "A-2", "A-3"])

    def test_a_card_id_that_breaks_the_card_id_rule_is_refused_at_start_and_never_offered(self):
        doc = {"cards": [{"id": "A-1", "name": "One"}, {"id": "A 2", "name": "Two"}, {"id": "A-3\n", "name": "Three"}],
               "tokens": [{"name": "Spark", "id": "T 1"}]}
        path = self.write_catalog(doc, "spaced.json")
        with self.assertRaises(SystemExit) as stopped:
            self.config(catalog=str(path))
        self.assertIn("spaced.json: cards[1]: card id 'A 2' must be 1 to 64 characters", str(stopped.exception))
        doc["cards"] = doc["cards"][:1] + doc["cards"][2:]
        with self.assertRaises(SystemExit) as stopped:
            self.config(catalog=str(self.write_catalog(doc, "newline.json")))
        self.assertIn("cards[1]: card id 'A-3\\n'", str(stopped.exception))
        doc["cards"] = doc["cards"][:1]
        with self.assertRaises(SystemExit) as stopped:
            self.config(catalog=str(self.write_catalog(doc, "token.json")))
        self.assertIn("tokens[0]: card id 'T 1'", str(stopped.exception))
        # a catalog edited while the server runs is not refused, but the bad id is not offered
        good = self.write_catalog({"cards": [{"id": "A-1", "name": "One"}]}, "edited.json")
        self.config(catalog=str(good))
        good.write_text(json.dumps({"cards": [{"id": "A-1", "name": "One"}, {"id": "A 2", "name": "Two"}],
                                    "tokens": [{"name": "Spark", "id": "T 1"}]}))
        self.assertEqual([c["id"] for c in serve.load_catalog()], ["A-1", "TOK-Spark"])

    def test_a_card_marked_token_is_a_token_whatever_its_kind(self):
        doc = {"cards": [
            {"id": "C-1", "name": "Sprite", "kind": "Unit", "token": True},
            {"id": "C-2", "name": "Wisp", "kind": "Unit", "token": False},
            {"id": "C-3", "name": "Golem", "kind": "Unit"},
            {"id": "C-4", "name": "Shade", "kind": "Token"},                # a token kind still counts
            {"id": "C-5", "name": "Imp", "kind": "Token", "token": False},  # and is not undone by the mark
            {"id": "C-6", "name": "Moth", "kind": None, "token": "yes"},    # only true marks a token
        ], "tokens": ["Spark", {"name": "Sprite (token)"}]}
        self.config(catalog=str(self.write_catalog(doc, "marked.json")))
        self.assertEqual([(c["id"], c["token"]) for c in serve.load_catalog()],
                         [("C-1", True), ("C-2", False), ("C-3", False), ("C-4", True), ("C-5", True), ("C-6", False),
                          ("TOK-Spark", True)])
        self.assertEqual([t["id"] for t in serve.token_table()], ["C-1", "C-4", "C-5", "TOK-Spark"])
        self.assertEqual(self.get("/api/tokens")[1], serve.token_table())

    def test_token_table_comes_from_the_catalog(self):
        doc = {"cards": [
            {"id": "C-1", "name": "Sprite", "kind": "Unit Token"},
            {"id": "C-2", "name": "Wisp", "kind": "token"},
            {"id": "C-3", "name": "Tokenizer", "kind": "Unit"},
            {"id": "C-4", "name": "Coin Tokens", "kind": "Spell"},  # the kind decides, not the name
            {"id": "C-5", "name": "Golem", "kind": "tokens"},
        ], "tokens": [
            "Spark",
            {"name": "Ember Shard", "id": "X-EMB", "kind": "Shard", "art": "tokens/ember.png"},
            {"name": "Sprite (token)"},  # already a card: never offered twice
            {"name": "wisp"},
            {"name": "Spark"},  # a repeat inside the list
            {"name": "  "}, 7, {"id": "no-name"},
        ]}
        self.config(catalog=str(self.write_catalog(doc, "tokens.json")))
        table = serve.token_table()
        self.assertEqual([(t["id"], t["name"], t["kind"]) for t in table],
                         [("C-1", "Sprite", "Unit Token"), ("C-2", "Wisp", "token"), ("C-5", "Golem", "tokens"),
                          ("TOK-Spark", "Spark", "Token"), ("X-EMB", "Ember Shard", "Shard")])
        self.assertTrue(all(t["token"] for t in table))
        by_id = {c["id"]: c for c in serve.load_catalog()}
        self.assertEqual((by_id["C-3"]["token"], by_id["C-4"]["token"]), (False, False))
        self.assertEqual(len(by_id), 7, "five cards and the two tokens the cards did not have")
        self.assertEqual(self.get("/api/tokens")[1], table)
        self.assertEqual(serve.token_id("Ember Shard, the 2nd!"), "TOK-Ember-Shard-the-2nd")
        # a token of the list can be picked like any card: a deck list resolves it
        self.assertEqual(lc.parse_decklist("2 Spark\nx-emb\n", serve.load_catalog())["ids"], ["TOK-Spark", "X-EMB"])
        # with no catalog there is no token at all: nothing is bundled with the tool
        self.config()
        self.assertEqual(serve.token_table(), [])
        self.assertEqual([p.name for p in HERE.iterdir() if "token" in p.name.lower()], [])


class Art(Base):
    def setUp(self):
        self.art = self.tmp / "art"
        (self.art / "alt").mkdir(parents=True, exist_ok=True)
        (self.art / "TOY-001.png").write_bytes(PNG + b"one")
        (self.art / "alt" / "TOY-001A.png").write_bytes(PNG + b"alt")
        (self.tmp / "outside.png").write_bytes(PNG + b"outside the art folder")

    def urls(self):
        return {c["id"]: c["artUrl"] for c in serve.load_catalog()}

    def test_no_art_means_names_only(self):
        self.config(catalog=str(self.write_catalog(TOY)))
        self.assertEqual(set(self.urls().values()), {None})
        self.assertFalse(self.get("/api/config")[1]["art"])
        self.assertEqual(self.fetch("/art/TOY-001")[0], 404)

    def test_art_from_a_folder(self):
        doc = json.loads(json.dumps(TOY))
        doc["cards"] += [{"id": "ESC-1", "name": "Escaping", "art": "../outside.png"},
                         {"id": "URL-1", "name": "Hosted", "art": "https://cards.example/hosted.png"},
                         {"id": "ODD/1?x#y", "name": "Odd Id", "art": "TOY-001.png"},
                         {"id": "NO-ART", "name": "No Art"}]
        doc["tokens"] = [{"name": "Spark", "art": "alt/TOY-001A.png"}]
        self.config(catalog=str(self.write_catalog(doc, "art.json")), art=str(self.art))
        urls = self.urls()
        self.assertEqual((urls["TOY-001"], urls["TOY-001A"]), ("/art/TOY-001", "/art/TOY-001A"))
        self.assertEqual(urls["URL-1"], "https://cards.example/hosted.png", "an art that is a URL is left to the browser")
        self.assertEqual((urls["NO-ART"], urls["ODD/1?x#y"]), (None, "/art/ODD%2F1%3Fx%23y"))
        status, ctype, body = self.fetch("/art/TOY-001")
        self.assertEqual((status, ctype, body), (200, "image/png", PNG + b"one"))
        self.assertEqual(self.fetch("/art/TOY-001A")[2], PNG + b"alt", "a path inside the folder")
        self.assertEqual(self.fetch("/art/ODD%2F1%3Fx%23y")[2], PNG + b"one", "the id is looked up, never used as a path")
        self.assertEqual(self.fetch("/art/TOK-Spark")[2], PNG + b"alt", "a token of the tokens list")
        for missing in ("ESC-1", "URL-1", "NO-ART", "TOY-009", "nobody", "..%2Foutside.png"):
            with self.subTest(missing):
                self.assertEqual(self.fetch(f"/art/{missing}")[0], 404)
        self.assertIsNone(serve.art_file("ESC-1"), "never a file outside the art folder")

    def test_a_card_without_art_is_listed_marked_and_has_no_picture(self):
        # "art": null in the catalog: a card known by its id and name, with no picture yet
        doc = json.loads(json.dumps(TOY))
        doc["cards"] += [{"id": "TOY-NEW", "name": "Lantern Moth", "kind": "unit", "printingOf": None, "art": None},
                         {"id": "TOY-NEWA", "name": "Lantern Moth", "kind": "unit", "printingOf": "TOY-NEW", "art": "TOY-001.png"},
                         {"id": "NO-ART", "name": "No Art"}]
        for base in (str(self.art), "https://cards.example/art", None):
            with self.subTest(base=base):
                self.config(catalog=str(self.write_catalog(doc, "no-art.json")), **({"art": base} if base else {}))
                by_id = {c["id"]: c for c in serve.load_catalog()}
                self.assertEqual((by_id["TOY-NEW"]["name"], by_id["TOY-NEW"]["artUrl"], by_id["TOY-NEW"].get("noArt")),
                                 ("Lantern Moth", None, True), "listed, with no picture, and marked as such")
                self.assertNotIn("noArt", by_id["TOY-NEWA"], "its printing has a picture")
                self.assertNotIn("noArt", by_id["NO-ART"], "only an art stated as null marks a card without art")
                self.assertNotIn("noArt", by_id["TOY-001"])
                self.assertEqual(self.fetch("/art/TOY-NEW")[0], 404)
                self.assertIsNone(serve.art_file("TOY-NEW"))
                # a deck list names it by its name or its id, like any card
                self.assertEqual(lc.parse_decklist("2 Lantern Moth\ntoy-new\n", serve.load_catalog())["ids"], ["TOY-NEW", "TOY-NEWA"])
                # the page gets it as the server lists it
                status, cards = self.get("/api/catalog")
                self.assertEqual(status, 200)
                self.assertEqual(next(c for c in cards if c["id"] == "TOY-NEW"), by_id["TOY-NEW"])

    def test_art_from_a_url_base(self):
        doc = json.loads(json.dumps(TOY))
        doc["cards"].append({"id": "SP-1", "name": "Spaced", "art": "promo art/sp 1.png"})
        self.config(catalog=str(self.write_catalog(doc, "url.json")), art="https://cards.example/art")
        urls = self.urls()
        self.assertEqual(urls["TOY-001A"], "https://cards.example/art/alt/TOY-001A.png")
        self.assertEqual(urls["SP-1"], "https://cards.example/art/promo%20art/sp%201.png")
        # the browser loads those; this server opens no connection and serves no art itself
        self.assertEqual(self.fetch("/art/TOY-001")[0], 404)
        self.assertIsNone(serve.art_file("TOY-001"))


class PrefillFrameSize(Base):
    """Prefill is written in the pixel space of its own record (frameW x frameH), which is not
    always the size of the frame being labeled, and not always 1920 x 1080."""

    RECORDS = [
        # what the inference command writes: one line per frame, with the frame's size
        {"t": 0.0, "name": "f00001.png", "frameW": 1280, "frameH": 720, "ms": 41.0, "boxes": [
            {"box": [100, 50, 63, 88], "cardId": "TOY-001", "sim": 0.81, "margin": 0.12,
             "top5": [{"id": "TOY-001", "sim": 0.81}, {"id": "TOY-009", "sim": 0.4}], "rot": 0, "flag": None},
            {"box": [400, 300, 88, 63], "cardId": None, "sim": 0.3, "margin": 0.01, "top5": [], "rot": 1, "flag": "below-tau"}]},
        {"t": 1.0, "name": "f00002.png", "frameW": 640, "frameH": 480, "ms": 40.0, "boxes": [
            {"box": [10, 20, 30, 40], "cardId": "TOY-009", "sim": 0.9, "margin": 0.3, "top5": [], "rot": 0, "flag": None}]},
        {"t": 2.0, "name": "f00003.png", "boxes": [{"box": [1, 2, 30, 40], "cardId": None}]},  # no size: the frame's own pixels
    ]

    def prefill(self, mode):
        path = self.tmp / "infer.jsonl"
        path.write_text("".join(json.dumps(r) + "\n" for r in self.RECORDS))
        self.config(mode=mode, role="training", prefill=[str(path)], labels_dir=str(self.tmp / f"lab-pf-{mode}"),
                    catalog=str(self.write_catalog(TOY)))
        status, got = self.get("/api/prefill/vidA")
        self.assertEqual(status, 200, got)
        return got

    def test_server_passes_each_records_own_frame_size(self):
        for mode in ("box", "training"):
            with self.subTest(mode):
                got = self.prefill(mode)
                self.assertEqual(got["sizes"], {"f00001.png": [1280.0, 720.0], "f00002.png": [640.0, 480.0]})
                self.assertEqual(got["file"], "infer.jsonl")
                first = got["frames"]["f00001.png"]
                self.assertEqual((first[0]["box"], first[0]["cardId"], first[0]["top5"]), ([100.0, 50.0, 63.0, 88.0], "TOY-001", ["TOY-001", "TOY-009"]))
                # rot is in quarter turns: one turn starts the corner order at the screen's top-right
                self.assertEqual(first[1]["corners"], [[488.0, 300.0], [488.0, 363.0], [400.0, 363.0], [400.0, 300.0]])
                self.assertEqual((first[1]["cardId"], first[1]["flag"]), (None, "below-tau"))

    def test_page_scales_proposals_to_the_frame_it_shows(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node not on PATH")
        got = self.prefill("box")
        # the page's own helpers (boxgeom.js), fed the server's answer: a 1920 x 1080 frame on screen
        script = """
            const G = require(process.argv[1]);
            const got = JSON.parse(process.argv[2]);
            const out = {};
            for (const [name, props] of Object.entries(got.frames)) {
              out[name] = props.map((p, i) => {
                const t = G.prefillTarget(G.scaleProposal(p, got.sizes[name], 1920, 1080), i, 1920, 1080, "P" + i);
                return t && { corners: t.corners, angle: t.angle || 0 };
              });
            }
            console.log(JSON.stringify(out));
        """
        res = subprocess.run([node, "-e", script, str(HERE / "boxgeom.js"), json.dumps(got)], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)
        out = json.loads(res.stdout)
        # 1280 x 720 → 1920 x 1080: every coordinate times 1.5
        self.assertEqual(out["f00001.png"][0], {"corners": [[150, 75], [244.5, 75], [244.5, 207], [150, 207]], "angle": 0})
        self.assertEqual(out["f00001.png"][1], {"corners": [[732, 450], [732, 544.5], [600, 544.5], [600, 450]], "angle": 90})
        # 640 x 480 → 1920 x 1080: x times 3, y times 2.25
        self.assertEqual(out["f00002.png"][0]["corners"], [[30, 45], [120, 45], [120, 135], [30, 135]])
        # no size on the record: taken as it is
        self.assertEqual(out["f00003.png"][0]["corners"], [[1, 2], [31, 2], [31, 42], [1, 42]])


class CocoExport(Base):
    def labels(self) -> Path:
        """A labels root written through the server's own save path: a confirmed box frame (a
        named card, a rotated box, a back, an ignored box, an unreviewed proposal), an
        unconfirmed frame, a corner set with a quad and a "not a card", and a point set."""
        root = self.tmp / "lab-coco"
        if root.exists():
            return root
        cat = str(self.write_catalog(TOY))

        def box(tid, corners, **kw):
            t = {"id": tid, "corners": corners, "estimated": [False] * 4, "cornerSource": "box", "outcome": "card",
                 "identity": None, "identitySource": None, "eligible": None, "conditions": {}, "labelSource": "manual"}
            t.update(kw)
            return t

        sample = self.tmp / "sample-coco.json"
        frames = [{"t": 0, "name": "f00001.png"}, {"t": 1, "name": "f00002.png"}]
        sample.write_text(json.dumps({"assets": [{"assetId": a, "frames": frames} for a in ("vidA", "vidQ", "vidP")]}))
        tilted = [[400.0, 300.0], [503.9, 360.0], [419.9, 505.5], [316.0, 445.5]]  # 120 x 168 at 30 degrees
        self.config(sample=str(sample), labels_dir=str(root), catalog=cat, mode="box", role="training")
        rows = [
            {"name": "f00001.png", "t": 0, "frameW": 960, "frameH": 540, "done": True, "targets": [
                box("B001", lc.box_corners(100, 100, 163, 188), identity="TOY-001", printing="TOY-001A", eligible="yes", identitySource="current-frame"),
                box("B002", tilted, angle=30, identity="unknown"),
                box("B003", lc.box_corners(600, 100, 663, 188), outcome="card-back", eligible="no", conditions={"faceUp": False}),
                box("B004", lc.box_corners(700, 300, 760, 330), ignore=True, eligible="no")]},
            {"name": "f00002.png", "t": 1, "frameW": 960, "frameH": 540, "done": False, "targets": [
                box("B001", lc.box_corners(10, 10, 73, 98)),
                box("P001", lc.box_corners(200, 10, 263, 98), cornerSource="prefill", pending=True, labelSource=None,
                    prefill={"i": 0, "corners": lc.box_corners(200, 10, 263, 98), "outcome": "card"})]},
        ]
        for row in rows:
            status, res = serve.save_frame("vidA", row)
            self.assertEqual(status, 200, res)
        self.config(sample=str(sample), labels_dir=str(root), catalog=cat, mode="corner", role="development")
        quad = {"id": "Q001", "corners": [[100, 100], [220, 110], [215, 290], [95, 280]], "estimated": [False, False, True, False],
                "outcome": "card", "identity": "TOY-009", "identitySource": "current-frame", "eligible": "yes", "conditions": {}, "labelSource": "manual"}
        junk = dict(quad, id="Q002", corners=[[300, 100], [360, 100], [360, 180], [300, 180]], outcome="not-card", identity=None, eligible=None)
        status, res = serve.save_frame("vidQ", {"name": "f00001.png", "t": 0, "frameW": 1280, "frameH": 720, "done": True, "targets": [quad, junk]})
        self.assertEqual(status, 200, res)
        self.config(sample=str(sample), labels_dir=str(root), catalog=cat, mode="point", role="development")
        status, res = serve.save_frame("vidP", {"name": "f00001.png", "t": 0, "frameW": 960, "frameH": 540, "points": lc.points_for_frame(1, 1, 3)})
        self.assertEqual(status, 200, res)
        return root

    def test_coco_document(self):
        root = self.labels()
        sets, notes = export.read_sets(root)
        self.assertEqual([s[0] for s in sets], ["vidA", "vidQ"])
        self.assertEqual(notes, ["vidP: a point set holds no boxes, skipped"])
        doc = export.to_coco(sets, export.card_names(self.tmp / "catalog.json"))
        self.assertEqual(doc["categories"], [{"id": 1, "name": "card", "supercategory": "card"}, {"id": 2, "name": "card-back", "supercategory": "card"}])
        self.assertEqual([(i["id"], i["file_name"], i["width"], i["height"], i["set"], i["role"]) for i in doc["images"]],
                         [(1, "vidA/f00001.png", 960, 540, "vidA", "training"), (2, "vidQ/f00001.png", 1280, 720, "vidQ", "development")],
                         "confirmed frames only, each with its own frame size")
        anns = doc["annotations"]
        self.assertEqual([a["id"] for a in anns], [1, 2, 3, 4, 5])
        self.assertEqual([(a["image_id"], a["attributes"]["targetId"], a["category_id"], a["iscrowd"]) for a in anns],
                         [(1, "B001", 1, 0), (1, "B002", 1, 0), (1, "B003", 2, 0), (1, "B004", 1, 1), (2, "Q001", 1, 0)],
                         "a back is category 2, an ignored box is a crowd region, a not-card target is left out")
        named = anns[0]
        self.assertEqual((named["bbox"], named["area"], named["segmentation"]),
                         ([100.0, 100.0, 63.0, 88.0], 5544.0, [[100.0, 100.0, 163.0, 100.0, 163.0, 188.0, 100.0, 188.0]]))
        self.assertEqual((named["attributes"]["cardId"], named["attributes"]["cardName"], named["attributes"]["printing"], named["attributes"]["eligible"]),
                         ("TOY-001", "Amber Circle", "TOY-001A", "yes"))
        tilted = anns[1]
        self.assertEqual(tilted["bbox"], [316.0, 300.0, 187.9, 205.5], "the axis-aligned box around a rotated one")
        self.assertEqual(len(tilted["segmentation"][0]), 8, "its four corners are kept as a polygon")
        self.assertAlmostEqual(tilted["area"], 120 * 168, delta=40)
        self.assertEqual((tilted["attributes"]["angle"], tilted["attributes"]["cardId"], tilted["attributes"]["identityUnknown"]), (30, None, True))
        quad = anns[4]
        self.assertEqual((quad["bbox"], quad["attributes"]["estimatedCorners"], quad["attributes"]["cardName"]),
                         ([95.0, 100.0, 125.0, 190.0], [False, False, True, False], "Coral Diamond"))
        for a in anns:  # COCO's own keys, all present
            self.assertTrue({"id", "image_id", "category_id", "bbox", "area", "segmentation", "iscrowd"} <= set(a))
        # with the unconfirmed frame: its drawn box comes in, the unreviewed proposal never does
        more = export.to_coco(sets, include_unconfirmed=True)
        self.assertEqual([i["file_name"] for i in more["images"]], ["vidA/f00001.png", "vidA/f00002.png", "vidQ/f00001.png"])
        second = [a["attributes"]["targetId"] for a in more["annotations"] if a["image_id"] == 2]
        self.assertEqual(second, ["B001"])
        self.assertEqual([i["confirmed"] for i in more["images"]], [True, False, True])
        self.assertIsNone(more["annotations"][0]["attributes"]["cardName"], "no catalog: ids only")

    def test_coco_command_and_filters(self):
        root = self.labels()
        out = self.tmp / "out" / "boxes.json"
        self.assertEqual(quiet(export.main, ["coco", "--labels-dir", str(root), "--out", str(out)]), 0)
        doc = json.loads(out.read_text())
        self.assertEqual((len(doc["images"]), len(doc["annotations"])), (2, 5))
        with self.assertRaises(SystemExit):  # never overwritten silently
            quiet(export.main, ["coco", "--labels-dir", str(root), "--out", str(out)])
        self.assertEqual(quiet(export.main, ["coco", "--labels-dir", str(root), "--out", str(out), "--force", "--role", "training"]), 0)
        self.assertEqual({i["set"] for i in json.loads(out.read_text())["images"]}, {"vidA"})
        self.assertEqual(quiet(export.main, ["coco", "--labels-dir", str(root), "--out", str(out), "--force", "--set", "vidQ"]), 0)
        self.assertEqual({i["set"] for i in json.loads(out.read_text())["images"]}, {"vidQ"})
        for bad in (["--set", "nobody"], ["--set", "vidP"], ["--role", "test"]):
            with self.subTest(bad), self.assertRaises(SystemExit):
                quiet(export.main, ["coco", "--labels-dir", str(root), "--out", str(self.tmp / "none.json")] + bad)
        with self.assertRaises(SystemExit):
            quiet(export.main, ["coco", "--labels-dir", str(self.tmp / "no-such-root"), "--out", str(self.tmp / "none.json")])
        self.assertFalse((self.tmp / "none.json").exists())

    def test_removed_frames_are_skipped_by_both_exports(self):
        root = self.tmp / "lab-removed"
        shutil.copytree(self.labels(), root)
        (root / "removed-frames.json").write_text(json.dumps({"schemaVersion": 1, "tool": "labeler", "replacements": [],
                                                              "removed": [{"assetId": "vidA", "name": "f00001.png", "reason": "no-cards", "at": None}]}))
        sets, notes = export.read_sets(root)
        self.assertIn("vidA: 1 removed frame skipped", notes)
        self.assertEqual([i["file_name"] for i in export.to_coco(sets)["images"]], ["vidQ/f00001.png"])
        self.assertEqual([i["file_name"] for i in export.to_coco(sets, include_unconfirmed=True)["images"]], ["vidA/f00002.png", "vidQ/f00001.png"])
        out = self.tmp / "removed" / "toy.manifest.jsonl"
        said = io.StringIO()
        with contextlib.redirect_stdout(said):
            self.assertEqual(export.main(["manifest", "--labels-dir", str(root), "--sample", str(self.addressed_sample()), "--out", str(out),
                                          "--credit", "Toy Labeler", "--source-type", "physical/webcam"]), 0)
        self.assertIn("vidA: 1 removed frame skipped", said.getvalue())
        self.assertEqual([json.loads(line)["video_id"] for line in out.read_text(encoding="utf-8").splitlines()], ["123456789"])
        self.assertEqual((root / "vidA" / "frames.jsonl").read_text(), (self.tmp / "lab-coco" / "vidA" / "frames.jsonl").read_text(), "the labels are untouched")

    def addressed_sample(self) -> Path:
        """The fixture's sample with what a manifest needs: where each video is hosted."""
        frames = [{"t": 0, "name": "f00001.png"}, {"t": 1, "name": "f00002.png"}]
        path = self.tmp / "sample-manifest.json"
        path.write_text(json.dumps({"assets": [
            {"assetId": "vidA", "platform": "youtube", "videoId": "EXAMPLE0001", "frames": frames},
            # the address may sit on the frame record instead, and wins over the asset's
            {"assetId": "vidQ", "platform": "youtube", "videoId": "EXAMPLE0009",
             "frames": [{"t": 12.3456, "name": "f00001.png", "platform": "twitch", "videoId": "123456789"}]},
            {"assetId": "vidP", "frames": frames}]}))
        return path

    def test_manifest_rows(self):
        root = self.labels()
        sets, _notes = export.read_sets(root)
        sample = export.read_sample(self.addressed_sample())
        rows, notes = export.manifest_rows(sets, sample, "Toy Labeler", source_types={"*": "physical/webcam", "vidQ": "digital"})
        self.assertEqual(notes, ["vidA: 1 frame(s) not confirmed, left out"])
        self.assertEqual([(r["platform"], r["video_id"], r["t"], r["frame_width"], r["frame_height"], r["source_type"]) for r in rows],
                         [("youtube", "EXAMPLE0001", 0.0, 960, 540, "physical/webcam"), ("twitch", "123456789", 12.346, 1280, 720, "digital")])
        first, second = rows
        self.assertEqual(list(first), ["manifest_version", "platform", "video_id", "t", "frame_width", "frame_height", "source_type",
                                       "group", "role", "trained_on", "completeness", "credit", "reachable", "reachable_checked",
                                       "prefill_offered", "boxes"])
        # written as an offer: no role chosen, never trained on, never checked
        for row in rows:
            self.assertEqual((row["manifest_version"], row["role"], row["trained_on"], row["reachable"], row["reachable_checked"]),
                             (1, "extra", False, None, None))
            self.assertEqual((row["completeness"], row["credit"], row["prefill_offered"]), ("exhaustive-boxes", "Toy Labeler", False))
            self.assertNotIn("attributes", row, "the fixture's frames are not real images: no fingerprint")
        # a video nobody grouped is a group of its own
        self.assertEqual(first["group"], export.default_group("youtube", "EXAMPLE0001"))
        self.assertRegex(first["group"], r"^new-[0-9a-f]{12}$")
        self.assertNotEqual(first["group"], second["group"])
        named, tilted, back, ignored = first["boxes"]
        self.assertEqual(named, {"id": "B001", "kind": "face", "ignore": False,
                                 "quad": [[0.104167, 0.185185], [0.169792, 0.185185], [0.169792, 0.348148], [0.104167, 0.348148]],
                                 "oriented": True, "shape": "rotated-box", "card_id": "TOY-001A", "identity": "named",
                                 "readable": "yes", "origin": "manual"}, "fractions of the frame; the printing on screen is the card id")
        self.assertEqual((tilted["card_id"], tilted["identity"], tilted["readable"], tilted["shape"]), (None, "unknown", None, "rotated-box"))
        self.assertEqual(tilted["quad"][1], [round(503.9 / 960, 6), round(360.0 / 540, 6)])
        self.assertEqual(back, {"id": "B003", "kind": "back", "ignore": False, "quad": back["quad"], "oriented": False,
                                "shape": "rotated-box", "origin": "manual"}, "a back carries no identity and no orientation")
        self.assertEqual((ignored["kind"], ignored["ignore"], ignored["oriented"], ignored["identity"], ignored["card_id"], ignored["readable"]),
                         ("face", True, False, "unlabeled", None, "no"))
        quad, junk = second["boxes"]
        self.assertEqual((quad["shape"], quad["card_id"], quad["identity"], quad["readable"], quad["oriented"]), ("quad", "TOY-009", "named", "yes", True))
        self.assertEqual((junk["kind"], junk["oriented"], "identity" in junk), ("not-card", False, False))
        for row in rows:  # every coordinate is a fraction, and the outlines run clockwise
            for box in row["boxes"]:
                self.assertTrue(all(-1 <= v <= 2 for point in box["quad"] for v in point))
                self.assertGreater(lc.signed_area(box["quad"]), 0)

    def test_manifest_groups_source_types_and_what_cannot_be_written(self):
        root = self.labels()
        sets, _notes = export.read_sets(root)
        sample = export.read_sample(self.addressed_sample())
        types = {"*": "physical"}
        grouped, _ = export.manifest_rows(sets, sample, "A", groups={"*": "g-one", "vidQ": "g-two"}, source_types=types)
        self.assertEqual([r["group"] for r in grouped], ["g-one", "g-two"])

        def refused(**kw):
            with self.assertRaises(SystemExit) as cm:
                export.manifest_rows(**{"sets": sets, "sample": sample, "credit": "A", "source_types": types, **kw})
            return str(cm.exception)

        self.assertIn("no source type", refused(source_types={}))            # the fixture's sets carry no recording tags
        self.assertIn("is not physical or digital", refused(source_types={"*": "Webcam"}))
        self.assertIn("must be 2 to 40", refused(groups={"*": "Group One"}))
        # an id that ends in a line break is not that id
        self.assertIn("must be 2 to 40", refused(groups={"*": "g-one\n"}))
        self.assertIn("is not physical or digital", refused(source_types={"*": "physical\n"}))
        for platform, video_id in (("youtube", "EXAMPLE0001\n"), ("twitch", "0000000001\n")):
            with self.subTest(platform=platform):
                self.assertIn('"videoId"', refused(sample=dict(sample, vidA=dict(sample["vidA"], platform=platform, videoId=video_id))))
        card = {"corners": lc.box_corners(10, 10, 73, 98), "outcome": "card"}
        self.assertEqual(export.manifest_box(dict(card, id="B001"), "box", 960, 540)[0]["id"], "B001")
        self.assertNotIn("id", export.manifest_box(dict(card, id="B001\n"), "box", 960, 540)[0])
        self.assertIn('"videoId"', refused(sample={"vidA": {"assetId": "vidA"}, "vidQ": sample["vidQ"]}))
        self.assertIn("the sample has no asset 'vidA'", refused(sample={"vidQ": sample["vidQ"]}))
        for credit in ("", " padded", "two\nlines", "x" * 81):
            with self.subTest(credit=credit):
                self.assertIn("credit", refused(credit=credit))
        # the recording tags give the source type when no flag does
        tagged = [(sid, dict(meta, recording={"source": "physical", "physicalGroup": "tournament"}), frames) for sid, meta, frames in sets]
        self.assertEqual({r["source_type"] for r in export.manifest_rows(tagged, sample, "A")[0]}, {"physical/tournament"})
        self.assertEqual(export.recording_source_type({"recording": {"source": "digital", "client": "Some Client"}}), "digital")
        self.assertIsNone(export.recording_source_type({}))
        # two sets that label the same frame of the same video cannot both be written
        twice = dict(sample, vidQ=dict(sample["vidA"], assetId="vidQ"))
        self.assertIn("the same video and time", refused(sample=twice))
        # a target the format cannot hold takes its frame with it, and the frame is listed
        sid, meta, frames = sets[0]
        hollow = [dict(fr, targets=[dict(t, corners=[[10, 10], [60, 60], [60, 10], [10, 60]]) if t["id"] == "B004" else t
                                    for t in fr["targets"]]) for fr in frames]
        rows, notes = export.manifest_rows([(sid, meta, hollow)], sample, "A", source_types=types)
        self.assertEqual(rows, [])
        self.assertIn("vidA/f00001.png: left out, the manifest cannot hold B004 (an outline that is not convex)", notes)
        # a repeat set labels frames another set has: skipped
        rows, notes = export.manifest_rows([(sid, dict(meta, repeatOf={"set": "vidA"}), frames)], sample, "A", source_types=types)
        self.assertEqual((rows, notes), ([], ["vidA: a repeat set, skipped (its frames are another set's)"]))
        # corners given counter-clockwise are written clockwise, the first corner kept first
        box, why = export.manifest_box({"corners": [[10, 10], [10, 98], [73, 98], [73, 10]], "outcome": "card"}, "corner", 960, 540)
        self.assertIsNone(why)
        self.assertEqual(box["quad"][0], [round(10 / 960, 6), round(10 / 540, 6)])
        self.assertGreater(lc.signed_area(box["quad"]), 0)
        self.assertEqual(export.manifest_box({"corners": lc.box_corners(-300, 10, -200, 98)}, "box", 960, 540)[1], "an outline wholly off the frame")
        half = export.manifest_box({"corners": lc.box_corners(10, 400, 73, 440), "conditions": {"visibleShare": "half"}}, "box", 960, 540)[0]
        self.assertEqual(half["attributes"], {"visible_share": "half"})

    # the manifest of the fixture's box set (vidA), as the export wrote it before boxes could have
    # free corners: sha256 of its bytes
    BOX_SET_MANIFEST_SHA256 = "33a287c458c529d2bb649b76135e9e2ad97279b4a8204139c92e7aad13e372a9"

    def test_a_box_set_exports_as_it_did_before_free_corners(self):
        """A box set with no box whose corners were freed is written byte for byte as before."""
        import hashlib
        sets, _notes = export.read_sets(self.labels())
        rows, _ = export.manifest_rows([s for s in sets if s[0] == "vidA"], export.read_sample(self.addressed_sample()), "Toy Labeler",
                                       source_types={"*": "physical/webcam"})
        text = "".join(json.dumps(row, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n" for row in rows)
        self.assertEqual(hashlib.sha256(text.encode("utf-8")).hexdigest(), self.BOX_SET_MANIFEST_SHA256)

    def test_a_box_with_free_corners_is_a_quad(self):
        """In a box set, a box whose corners were freed (cornerSource hand) is written as a quad;
        one whose freed corners still form a rectangle stays a rotated box; elsewhere as before."""
        freed = {"corners": [[100, 100], [170, 106], [168, 190], [96, 186]], "cornerSource": "hand", "outcome": "card", "identity": "TOY-001"}
        box, why = export.manifest_box(freed, "box", 960, 540)
        self.assertIsNone(why)
        self.assertEqual((box["shape"], box["oriented"]), ("quad", True))
        self.assertEqual(box["quad"][0], [round(100 / 960, 6), round(100 / 540, 6)], "the card's own top-left stays first")
        square = dict(freed, corners=lc.box_corners(100, 100, 163, 188))
        self.assertEqual(export.manifest_box(square, "box", 960, 540)[0]["shape"], "rotated-box")
        for cs in ("box", "carried", "propagated", "prefill", "prefill-edited", None):
            with self.subTest(cs=cs):
                self.assertEqual(export.manifest_box(dict(square, cornerSource=cs), "box", 960, 540)[0]["shape"], "rotated-box")
        # a corner set: as before (a box drawn as a box is a rotated box, anything else a quad)
        self.assertEqual(export.manifest_box(square, "corner", 960, 540)[0]["shape"], "quad")
        self.assertEqual(export.manifest_box(dict(square, cornerSource="box"), "corner", 960, 540)[0]["shape"], "rotated-box")
        # the export's own limits hold for it as for any outline
        self.assertEqual(export.manifest_box(dict(freed, corners=[[100, 100], [170, 190], [170, 100], [100, 190]]), "box", 960, 540)[1],
                         "an outline that is not convex")
        self.assertEqual(export.manifest_box(dict(freed, corners=[[100, 100], [3000, 106], [168, 190], [96, 186]]), "box", 960, 540)[1],
                         "a corner too far outside the frame")

    def test_manifest_rows_of_a_recording_of_your_own(self):
        """A sample that says "platform": "local" gives rows of that platform: the export writes
        them like any other, and points at the plain check, since such rows cannot be offered."""
        root = self.labels()
        sets, _notes = export.read_sets(root)
        sample = export.read_sample(self.addressed_sample())
        own = dict(sample, vidA=dict(sample["vidA"], platform="local", videoId="kitchen-table_01"))
        rows, _ = export.manifest_rows(sets, own, "Toy Labeler", source_types={"*": "physical/phone"})
        first = rows[0]
        self.assertEqual((first["platform"], first["video_id"], first["role"], first["reachable"], first["reachable_checked"]),
                         ("local", "kitchen-table_01", "extra", None, None))
        self.assertEqual(first["group"], export.default_group("local", "kitchen-table_01"))
        for bad in ("-table", "kitchen table", "kitchen/table", "x" * 65, "", "kitchen-table\n"):
            with self.subTest(bad), self.assertRaises(SystemExit) as cm:
                export.manifest_rows(sets, dict(sample, vidA=dict(sample["vidA"], platform="local", videoId=bad)), "A",
                                     source_types={"*": "physical"})
            self.assertIn('"platform" (youtube, twitch or local)', str(cm.exception))
        path = self.tmp / "sample-own.json"
        path.write_text(json.dumps({"assets": list(own.values())}))
        out = self.tmp / "own" / "toy.manifest.jsonl"
        said = io.StringIO()
        with contextlib.redirect_stdout(said):
            self.assertEqual(export.main(["manifest", "--labels-dir", str(root), "--sample", str(path), "--out", str(out),
                                          "--credit", "Toy Labeler", "--source-type", "physical/phone"]), 0)
        self.assertIn(f"check it: cardvision validate-manifest {out.resolve()}\n", said.getvalue())
        self.assertNotIn("--contribution", said.getvalue())
        self.assertIn("cannot be offered", said.getvalue())

    def test_manifest_command(self):
        root = self.labels()
        sample = self.addressed_sample()
        out = self.tmp / "offer" / "toy.manifest.jsonl"
        base = ["manifest", "--labels-dir", str(root), "--sample", str(sample), "--out", str(out)]
        with self.assertRaises(SystemExit):  # the fixture's sets carry no recording tags
            quiet(export.main, base + ["--credit", "Toy Labeler"])
        self.assertFalse(out.exists(), "nothing is written when a row cannot be addressed")
        said = io.StringIO()
        with contextlib.redirect_stdout(said):
            self.assertEqual(export.main(base + ["--credit", "Toy Labeler", "--source-type", "physical/webcam", "--group", "vidA=g-toy-01"]), 0)
        rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([(r["video_id"], r["group"], len(r["boxes"])) for r in rows],
                         [("EXAMPLE0001", "g-toy-01", 4), ("123456789", export.default_group("twitch", "123456789"), 2)])
        self.assertIn("2 rows, 6 boxes, 0 rows with a frame fingerprint", said.getvalue())
        self.assertIn("validate-manifest", said.getvalue())
        self.assertNotIn(" ", out.read_text(encoding="utf-8").splitlines()[0].replace("Toy Labeler", ""), "one compact JSON object per line")
        with self.assertRaises(SystemExit):  # never overwritten silently
            quiet(export.main, base + ["--credit", "Toy Labeler", "--source-type", "physical"])
        with contextlib.redirect_stderr(io.StringIO()):
            for bad in (["--out", str(self.tmp / "offer" / "toy.json")], ["--set", "vidP"], ["--include-unconfirmed"]):
                with self.subTest(bad), self.assertRaises(SystemExit):
                    quiet(export.main, base + ["--credit", "Toy Labeler", "--source-type", "physical", "--force"] + bad)

    def test_manifest_points_from_a_census_and_a_point_set(self):
        """Labels made for measuring a model become `points` rows: a confirmed census of
        centers, named in Check names, and the answered points of a point set; one row for a
        frame both label."""
        sample = export.read_sample(self.addressed_sample())
        at = lambda x, y, sha="all-blind": {"x": x, "y": y, "armsManifestSha256": sha}  # noqa: E731
        named = {"id": "C001", "x": 0.25, "y": 0.5, "kind": "face", "verifiedBy": "picked", "identity": "TOY-001", "printing": "TOY-001A",
                 "eligible": "uncertain", "blind": True, "verifiedAt": at(0.25, 0.5)}
        unknown = {"id": "C002", "x": 0.5, "y": 0.5, "kind": "face", "verifiedBy": "unknown", "identity": "unknown", "eligible": "no",
                   "blind": True, "verifiedAt": at(0.5, 0.5)}
        open_face = {"id": "C003", "x": 0.6, "y": 0.5, "kind": "face"}
        moved = dict(named, id="C004", x=0.7, verifiedAt=at(0.65, 0.5))
        other_run = dict(named, id="C005", x=0.8, verifiedAt=at(0.8, 0.5, "abc"))
        not_card = {"id": "C006", "x": 0.1, "y": 0.1, "kind": "face", "verifiedBy": "not-card", "correction": "not-card", "blind": True,
                    "verifiedAt": at(0.1, 0.1)}
        back = {"id": "C007", "x": 0.9, "y": 0.9, "kind": "back"}
        census = [{"name": "f00001.png", "t": 0, "frameW": 960, "frameH": 540, "done": True,
                   "centers": [named, unknown, open_face, moved, other_run, not_card, back], "centerSeq": 7},
                  {"name": "f00002.png", "t": 1, "frameW": 960, "frameH": 540, "done": True, "centers": [], "centerSeq": 0}]
        meta = {"mode": "center", "role": "development", "frameAsset": "vidA", "verify": {"armsManifestSha256": ["all-blind"]},
                "recording": {"source": "physical", "physicalGroup": "webcam"}}
        rows, notes = export.manifest_rows([("vidA", meta, census)], sample, "A")
        self.assertEqual(len(rows), 1, "a confirmed census with no center has no point to write")
        row = rows[0]
        self.assertEqual((row["completeness"], "boxes" in row, row["prefill_offered"]), ("points", False, False))
        points = {p["id"]: p for p in row["points"]}
        self.assertEqual(points["C001"], {"x": 0.25, "y": 0.5, "id": "C001", "kind": "face", "card_id": "TOY-001A", "identity": "named",
                                          "readable": "maybe", "attributes": {"readable_from": "crop", "blind": True}, "origin": "center"})
        self.assertEqual((points["C002"]["identity"], points["C002"]["card_id"], points["C002"]["readable"]), ("unknown", None, "no"))
        for cid in ("C003", "C004", "C005"):
            self.assertEqual((points[cid]["kind"], points[cid]["identity"], points[cid]["card_id"], points[cid]["readable"], "attributes" in points[cid]),
                             ("face", "unlabeled", None, None, False), cid)
        self.assertEqual(points["C006"], {"x": 0.1, "y": 0.1, "id": "C006", "kind": "not-card", "origin": "center"})
        self.assertEqual(points["C007"], {"x": 0.9, "y": 0.9, "id": "C007", "kind": "back", "origin": "center"})
        self.assertEqual(notes, ["vidA: 1 frame(s) confirmed empty, not exportable as points",
                                 "vidA: 3 face(s) without a checked name (not answered in full, or stale), written as unlabeled"])
        # an unconfirmed census is not written
        rows, notes = export.manifest_rows([("vidA", meta, [dict(census[0], done=False)])], sample, "A")
        self.assertEqual((rows, notes), ([], ["vidA: 1 frame(s) not confirmed, left out"]))
        # a point set of the same frame, from another labels folder: one row with both
        pts = [{"i": 0, "x": 0.11, "y": 0.2, "outcome": "card", "identity": "TOY-009", "eligible": "uncertain"},
               {"i": 1, "x": 0.31, "y": 0.4, "outcome": "not-card", "eligible": "no"},
               {"i": 2, "x": 0.41, "y": 0.6, "outcome": "card", "identity": "unknown", "eligible": "no"},
               {"i": 3, "x": 0.51, "y": 0.7, "outcome": "card-back", "eligible": "no"},
               {"i": 4, "x": 0.61, "y": 0.8}]
        pmeta = dict(meta, mode="point", verify=None)
        rows, notes = export.manifest_rows([("vidA", meta, census[:1]), ("vidA", pmeta, [{"name": "f00001.png", "t": 0, "frameW": 960, "frameH": 540,
                                                                                            "done": True, "points": pts}])], sample, "A")
        self.assertEqual(len(rows), 1)
        seeded = [p for p in rows[0]["points"] if p["origin"] == "seeded"]
        self.assertEqual([(p["id"], p["kind"], p.get("identity"), p.get("card_id"), p.get("readable")) for p in seeded],
                         [("P000", "face", "named", "TOY-009", "maybe"), ("P001", "not-card", None, None, None),
                          ("P002", "face", "unknown", None, "no"), ("P003", "back", None, None, None)])
        self.assertEqual(len(rows[0]["points"]), 11)
        self.assertIn("vidA: 1 point(s) without an answer, left out", notes)
        # a box row and a points row of one frame are never one row
        boxes = [(sid, m, f) for sid, m, f in export.read_sets(self.labels())[0] if sid == "vidA"]
        with self.assertRaises(export.ManifestRefused) as cm:
            export.manifest_rows(boxes + [("vidA", meta, census[:1])], sample, "A", source_types={"*": "physical/webcam"})
        self.assertEqual([p["code"] for p in cm.exception.problems], ["same-frame"])
        self.assertIn("the same video and time", str(cm.exception))
        # every refusal also says, as a code, what to fill in
        with self.assertRaises(export.ManifestRefused) as cm:
            export.manifest_rows([("vidP", dict(meta, frameAsset="vidP", recording=None), census[:1]), ("vidA", meta, census[:1])], sample, "")
        self.assertEqual([p["code"] for p in cm.exception.problems], ["credit"])
        self.assertEqual(str(cm.exception), "a credit is needed (--credit): the name to show for these labels")
        with self.assertRaises(export.ManifestRefused) as cm:
            export.manifest_rows([("vidP", dict(meta, frameAsset="vidP", recording=None), census[:1]), ("vidA", meta, census[:1])], sample, "A")
        self.assertEqual([p["code"] for p in cm.exception.problems], ["source-type"])
        with self.assertRaises(export.ManifestRefused) as cm:
            export.manifest_rows([("vidP", dict(meta, frameAsset="vidP"), census[:1])], sample, "A")
        self.assertEqual([(p["code"], p["where"]) for p in cm.exception.problems], [("address", "vidP/f00001.png")])

    def test_manifest_command_with_two_labels_folders(self):
        sample = self.addressed_sample()
        census, points = self.tmp / "census-labels", self.tmp / "point-labels"
        for root, mode, rows in ((census, "center", {"centers": [{"id": "C001", "x": 0.5, "y": 0.5, "kind": "back"}], "centerSeq": 1}),
                                 (points, "point", {"points": [{"i": 0, "x": 0.2, "y": 0.2, "outcome": "not-card", "eligible": "no"}]})):
            (root / "vidA").mkdir(parents=True)
            (root / "vidA" / "meta.json").write_text(json.dumps({"schemaVersion": 2, "tool": "labeler", "setId": "vidA", "frameAsset": "vidA",
                                                                 "mode": mode, "role": "test"}))
            (root / "vidA" / "frames.jsonl").write_text(json.dumps({"name": "f00001.png", "t": 0, "frameW": 960, "frameH": 540, "done": True, **rows}) + "\n")
        out = self.tmp / "measure" / "m.manifest.jsonl"
        said = io.StringIO()
        with contextlib.redirect_stdout(said):
            self.assertEqual(export.main(["manifest", "--labels-dir", str(census), "--labels-dir", str(points), "--sample", str(sample),
                                          "--out", str(out), "--credit", "A", "--source-type", "digital"]), 0)
        rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([[(p["origin"], p["kind"]) for p in r["points"]] for r in rows], [[("center", "back"), ("seeded", "not-card")]])
        self.assertIn("1 rows, 0 boxes, 2 points, 0 rows with a frame fingerprint", said.getvalue())
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            export.main(["coco", "--labels-dir", str(census), "--out", str(self.tmp / "c.json")])  # no box in a census

    def test_frame_fingerprint_of_a_png(self):
        """The fingerprint as the manifest format defines it, worked out here pixel by pixel."""
        def by_definition(canvas) -> str:
            cells = [[[] for _ in range(9)] for _ in range(8)]
            for y in range(canvas.h):
                for x in range(canvas.w):
                    r, g, b = canvas.px[(y * canvas.w + x) * 3:(y * canvas.w + x) * 3 + 3]
                    cells[min(7, 8 * y // canvas.h)][min(8, 9 * x // canvas.w)].append(round(0.299 * r + 0.587 * g + 0.114 * b))
            means = [[sum(c) / len(c) if c else 0.0 for c in row] for row in cells]
            bits = "".join("1" if row[c + 1] > row[c] else "0" for row in means for c in range(8))
            return f"{int(bits, 2):016x}"

        for n, (w, h) in enumerate(((96, 54), (50, 37), (9, 8), (5, 3))):
            canvas = make_toy_data.Canvas(w, h, (34, 62, 52))
            make_toy_data.draw_card(canvas, make_toy_data.face_sprite("TOY-001", w * 0.3 / 63), w * 0.3, h * 0.5, 20 * n)
            make_toy_data.draw_card(canvas, make_toy_data.back_sprite(w * 0.25 / 63), w * 0.75, h * 0.4, 0)
            path = self.tmp / f"finger-{n}.png"
            path.write_bytes(canvas.png())
            self.assertEqual(export.png_dhash(path), by_definition(canvas), (w, h))
            self.assertRegex(export.png_dhash(path), r"^[0-9a-f]{16}$")
        self.assertNotEqual(export.png_dhash(self.tmp / "finger-0.png"), "0" * 16)
        # what cannot be decoded here has no fingerprint, and nothing is guessed
        (self.tmp / "frame.jpg").write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 32)
        for path in (self.tmp / "frame.jpg", self.tmp / "frames" / "vidA" / "f00001.png", self.tmp / "no-such-frame.png"):
            self.assertIsNone(export.png_dhash(path), path.name)
        self.assertEqual(export.frames_folder({"assetId": "vidA"}, self.sample), self.tmp / "frames" / "vidA")
        self.assertEqual(export.frames_folder({"assetId": "vidA", "framesDir": "elsewhere/a"}, self.sample), (self.tmp / "elsewhere" / "a").resolve())
        self.assertEqual(export.frames_folder({"assetId": "vidA"}, self.sample, self.tmp / "f2"), (self.tmp / "f2").resolve() / "vidA")


class MakeSample(Base):
    def test_sample_from_folders_of_frames(self):
        root = self.tmp / "extracted"
        for video, names in (("vid-one", [f"f{n:05d}.jpg" for n in range(1, 21)]),
                             ("vid_two", ["my.video-f00002.jpg", "my.video-f00010.jpg", "my.video-f00001.jpg"])):
            (root / video).mkdir(parents=True)
            for name in names:
                (root / video / name).write_bytes(b"\xff\xd8" + name.encode())
        (root / "vid-one" / "notes.txt").write_text("not a frame")
        (root / "vid-one" / "has space.jpg").write_bytes(b"\xff\xd8")
        (root / "empty").mkdir()
        out = self.tmp / "made" / "sample.json"
        self.assertEqual(quiet(make_sample.main, ["--out", str(out), "--frames-root", str(root), "--n", "4", "--seed", "3"]), 0)
        doc = json.loads(out.read_text())
        self.assertEqual([a["assetId"] for a in doc["assets"]], ["vid-one", "vid_two"], "a folder with no frames is no asset")
        one, two = doc["assets"]
        self.assertEqual(one["framesDir"], "../extracted/vid-one", "relative to the sample file: the folder can be moved as a whole")
        self.assertEqual(len(one["frames"]), 4)
        index = [int(f["name"][1:6]) for f in one["frames"]]
        self.assertEqual(index, sorted(index))
        self.assertTrue(all(lo < i <= lo + 5 for i, lo in zip(index, (0, 5, 10, 15))), "one frame from each of four equal slices")
        self.assertEqual([f["t"] for f in one["frames"]], [i - 0.5 for i in index],
                         "t from the frame number at one frame a second: the middle of the frame's time on screen")
        self.assertEqual([f["name"] for f in two["frames"]], ["my.video-f00001.jpg", "my.video-f00002.jpg", "my.video-f00010.jpg"])
        self.assertEqual([f["t"] for f in two["frames"]], [0.5, 1.5, 9.5])
        # the same seed draws the same frames; nothing is overwritten without --force
        with self.assertRaises(SystemExit):
            quiet(make_sample.main, ["--out", str(out), "--frames-root", str(root)])
        again = self.tmp / "made" / "again.json"
        quiet(make_sample.main, ["--out", str(again), "--frames-root", str(root), "--n", "4", "--seed", "3"])
        self.assertEqual(json.loads(again.read_text()), doc)
        # the server serves the frames from where they are
        serve.configure(args(sample=str(out), mode="box", role="training"))
        self.assertEqual(self.fetch("/frames/vid_two/my.video-f00010.jpg")[2], b"\xff\xd8my.video-f00010.jpg")
        self.assertEqual([s["setId"] for s in self.get("/api/sets")[1]], ["vid-one", "vid_two"])

    def test_a_time_worked_out_from_a_frame_s_number_is_one_at_which_the_frame_is_on_screen(self):
        """Without --times, a frame's time is the middle of its time on screen, to the millisecond:
        frame N of frames cut `fps` a second is on screen from (N - 1) / fps to N / fps. A manifest
        row carries that time, and its rule, "the last frame whose timestamp is at or before t",
        then names frame N. The frame's start time would not do: rounded, it can fall before the frame."""
        for fps in (1.0, 2.0, 5.0, 24000 / 1001, 25.0, 30000 / 1001, 30.0, 60000 / 1001, 60.0):
            for number in (1, 2, 3, 30, 31, 91, 1000, 54321):
                t = make_sample.frame_time(f"clip-f{number:05d}.png", 0, fps, {})
                self.assertEqual(t, round((number - 0.5) / fps, 3))
                self.assertEqual(round(t, 3), t)
                self.assertTrue((number - 1) / fps < t < number / fps, (fps, number, t))
                self.assertEqual(math.floor(t * fps + 1e-6), number - 1, "the frame the manifest's rule names")
        # at 29.97 frames a second frame 32 starts at 1.034367 s: rounded to 1.034, that is before it
        self.assertEqual(math.floor(round(31 / (30000 / 1001), 3) * (30000 / 1001) + 1e-6), 30)
        self.assertEqual(make_sample.frame_time("clip-f00032.png", 0, 30000 / 1001, {}), 1.051)
        # a name without a number goes by its position in the folder, from 0
        self.assertEqual([make_sample.frame_time("still.png", position, 2.0, {}) for position in (0, 1, 7)], [0.25, 0.75, 3.75])
        # a time given with --times is taken as it is
        self.assertEqual(make_sample.frame_time("clip-f00031.png", 0, 30.0, {"clip-f00031.png": 12.345}), 12.345)
        folder = self.tmp / "cut"
        folder.mkdir()
        for name in ("cut-f00001.png", "cut-f00002.png", "cut-f00031.png"):
            (folder / name).write_bytes(PNG)
        out = self.tmp / "cut.json"
        self.assertEqual(quiet(make_sample.main, ["--out", str(out), "--asset", f"cut={folder}", "--all", "--fps", "29.97"]), 0)
        self.assertEqual([f["t"] for f in json.loads(out.read_text())["assets"][0]["frames"]], [0.017, 0.05, 1.018])

    def test_all_frames_times_and_explicit_assets(self):
        folder = self.tmp / "clip frames"
        folder.mkdir()
        for name in ("clip-f00001.png", "clip-f00002.png"):
            (folder / name).write_bytes(PNG)
        times = self.tmp / "times.jsonl"
        times.write_text(json.dumps({"name": "clip-f00001.png", "t": 12.5, "boxes": []}) + "\n" + json.dumps({"name": "clip-f00002.png", "t": 44.0}) + "\n")
        out = self.tmp / "explicit.json"
        self.assertEqual(quiet(make_sample.main, ["--out", str(out), "--asset", f"clip={folder}", "--all", "--times", str(times)]), 0)
        asset = json.loads(out.read_text())["assets"][0]
        self.assertEqual((asset["assetId"], asset["framesDir"], asset["frames"]),
                         ("clip", "clip frames", [{"t": 12.5, "name": "clip-f00001.png"}, {"t": 44.0, "name": "clip-f00002.png"}]))
        for bad in (["--asset", f"bad id={folder}"], ["--asset", "clip"], ["--asset", f"clip={self.tmp / 'nowhere'}"],
                    ["--asset", f"clip={folder}", "--asset", f"clip={folder}"], ["--frames-root", str(self.tmp / "nowhere")], []):
            with self.subTest(bad), self.assertRaises(SystemExit):
                quiet(make_sample.main, ["--out", str(self.tmp / "bad.json")] + bad)
        self.assertFalse((self.tmp / "bad.json").exists())

    def test_a_sample_of_recordings_of_your_own(self):
        """--local says the frames come from recordings on no platform: each asset records the
        platform "local" and its own id as the video id, which the manifest export reads."""
        folder = self.tmp / "own"
        folder.mkdir()
        (folder / "own-f00001.png").write_bytes(PNG)
        out = self.tmp / "own.json"
        self.assertEqual(quiet(make_sample.main, ["--out", str(out), "--asset", f"kitchen-table_01={folder}", "--all", "--local"]), 0)
        asset = json.loads(out.read_text())["assets"][0]
        self.assertEqual((asset["assetId"], asset["platform"], asset["videoId"]), ("kitchen-table_01", "local", "kitchen-table_01"))
        self.assertEqual(export.frame_address(asset, "own-f00001.png"), {"platform": "local", "videoId": "kitchen-table_01", "t": 0.5})
        plain = self.tmp / "plain.json"
        quiet(make_sample.main, ["--out", str(plain), "--asset", f"kitchen-table_01={folder}", "--all"])
        self.assertNotIn("platform", json.loads(plain.read_text())["assets"][0])
        for bad in ("-own", "_own", "x" * 65):  # an asset id that cannot be a local video id
            with self.subTest(bad), self.assertRaises(SystemExit) as cm:
                quiet(make_sample.main, ["--out", str(self.tmp / "bad-local.json"), f"--asset={bad}={folder}", "--all", "--local"])
            self.assertIn("starts with a letter or a digit", str(cm.exception))
        with self.assertRaises(SystemExit) as cm:  # a line break ends no id
            quiet(make_sample.main, ["--out", str(self.tmp / "bad-local.json"), f"--asset=own\n={folder}", "--all", "--local"])
        self.assertIn("use letters, digits, _ and -", str(cm.exception))
        self.assertFalse((self.tmp / "bad-local.json").exists())

    def test_what_a_sample_says_about_a_video(self):
        """A sample may say a video's title, upload date and language (all optional): make_sample
        copies them when given, the sample loader keeps a value of its form and leaves out any
        other, and the labeling page gets them with the platform and video id. An older sample,
        without them, is as valid as before. The ids and titles here are made up."""
        folder = self.tmp / "about"
        folder.mkdir()
        (folder / "about-f00001.png").write_bytes(PNG)
        out = self.tmp / "about.json"
        self.assertEqual(quiet(make_sample.main, ["--out", str(out), "--asset", f"practice-01={folder}", "--all",
                                                  "--title", "practice-01=A made-up practice game: round two",
                                                  "--upload-date", "practice-01=2025-03-14", "--language", "practice-01=pt-BR"]), 0)
        asset = json.loads(out.read_text())["assets"][0]
        self.assertEqual((asset["title"], asset["uploadDate"], asset["language"]), ("A made-up practice game: round two", "2025-03-14", "pt-BR"))
        plain = self.tmp / "about-plain.json"
        quiet(make_sample.main, ["--out", str(plain), "--asset", f"practice-01={folder}", "--all"])
        self.assertEqual(set(json.loads(plain.read_text())["assets"][0]) & set(lc.SOURCE_FIELDS), set(), "none given, none written")
        for flag, value, words in (("--upload-date", "practice-01=2025-02-30", "YYYY-MM-DD"), ("--upload-date", "practice-01=14/03/2025", "YYYY-MM-DD"),
                                   ("--language", "practice-01=english please", "language tag"), ("--title", "practice-01=two\nlines", "one line"),
                                   ("--title", "practice-01=   ", "one line"), ("--title", "nobody=A title", "no asset"), ("--language", "en", "ID=VALUE")):
            with self.subTest(flag=flag, value=value), self.assertRaises(SystemExit) as cm:
                quiet(make_sample.main, ["--out", str(self.tmp / "about-bad.json"), "--asset", f"practice-01={folder}", "--all", flag, value])
            self.assertIn(words, str(cm.exception))
        self.assertFalse((self.tmp / "about-bad.json").exists())
        # the loader: kept when of its form, left out when not; the rest of the entry stays
        doc = {"assets": [
            {"assetId": "a", "frames": [{"t": 0, "name": "f00001.png"}], "title": "Fine", "uploadDate": "2024-02-29", "language": "en", "channel": "kept"},
            {"assetId": "b", "frames": [{"t": 0, "name": "f00001.png"}], "title": "x" * (lc.TITLE_MAX + 1), "uploadDate": "2023-02-29", "language": 7},
            {"assetId": "c", "frames": [{"t": 0, "name": "f00001.png"}], "title": "tab\there", "uploadDate": "2024-1-5", "language": "e"},
            {"assetId": "d", "frames": [{"t": 0, "name": "f00001.png"}]}]}
        got = {a["assetId"]: a for a in lc.sample_assets(doc)}
        self.assertEqual({k: got["a"].get(k) for k in lc.SOURCE_FIELDS + ("channel",)},
                         {"title": "Fine", "uploadDate": "2024-02-29", "language": "en", "channel": "kept"})
        for aid in ("b", "c", "d"):
            self.assertEqual(set(got[aid]) & set(lc.SOURCE_FIELDS), set(), aid)
            self.assertEqual(len(got[aid]["frames"]), 1, "the video is still listed")
        self.assertEqual(lc.source_unused(doc), {"b": ["title", "uploadDate", "language"], "c": ["title", "uploadDate", "language"]})
        # a title is one plain line: no separator, no NEL, no bidirectional control
        for ch in ("\u2028", "\u2029", "\u0085", "\u202e", "\u2066", "\u200f", "\u061c"):
            self.assertFalse(lc.source_field_ok("title", f"A made-up{ch} game"), repr(ch))
        self.assertTrue(lc.source_field_ok("title", "Un jeu inventé — partie 2"))
        # an upload date from 1990 on, and not after tomorrow (a clock a little behind)
        today = lc.datetime.date(2026, 10, 15)
        for value, ok in (("1990-01-01", True), ("1989-12-31", False), ("2026-10-16", True), ("2026-10-17", False), ("2026-10-15", True)):
            self.assertEqual(lc.source_field_ok("uploadDate", value, today), ok, value)
        self.assertFalse(lc.source_field_ok("uploadDate", "2999-01-01"), "the real today: far ahead is refused")
        # the labeling page: the source of each set, a frame's own platform and video id
        sample = self.tmp / "about-sample.json"
        sample.write_text(json.dumps({"assets": [
            {"assetId": "vidA", "platform": "youtube", "videoId": "EXAMPLE1234", "title": "A made-up practice game", "uploadDate": "2025-03-14",
             "language": "en", "frames": [{"t": 0, "name": "f00001.png"}, {"t": 1, "name": "f00002.png", "platform": "local", "videoId": "own-1"}]},
            {"assetId": "vidB", "uploadDate": "not a date", "title": "two\u2028lines", "frames": [{"t": 0, "name": "f00001.png"}]}]}))
        self.config(sample=str(sample), labels_dir=str(self.tmp / "about-labels"), frames_dir=str(self.tmp / "frames"))
        st, sets = self.get("/api/sets")
        self.assertEqual(st, 200)
        by = {x["setId"]: x for x in sets}
        self.assertEqual(by["vidA"]["source"], {"platform": "youtube", "videoId": "EXAMPLE1234", "title": "A made-up practice game",
                                                "uploadDate": "2025-03-14", "language": "en"})
        self.assertEqual(by["vidA"]["frames"], [{"t": 0, "name": "f00001.png"}, {"t": 1, "name": "f00002.png", "platform": "local", "videoId": "own-1"}])
        self.assertEqual(by["vidB"]["source"], {"unused": ["title", "uploadDate"]}, "a value not of its form is not shown; the page says which")


class WholeOrUntouched(Base):
    """A sample file and an exported manifest are written in one step: a write that fails leaves
    the file that was there as it was."""

    def test_a_write_that_fails_leaves_the_old_file(self):
        path = self.tmp / "only-copy.jsonl"
        path.write_text("the only copy\n")
        os.chmod(path, 0o640)
        for step in ("fsync", "replace"):
            with self.subTest(step), mock.patch.object(export.os, step, side_effect=OSError("no space left")):
                with self.assertRaises(OSError):
                    export.write_text_atomic(path, "a newer copy that never arrives\n")
            self.assertEqual(path.read_text(), "the only copy\n")
            self.assertEqual([p.name for p in self.tmp.iterdir() if p.name.endswith(".partial")], [])
        export.write_text_atomic(path, "a newer copy\n")
        self.assertEqual(path.read_text(), "a newer copy\n")
        if os.name == "posix":
            self.assertEqual(path.stat().st_mode & 0o777, 0o640, "a replaced file keeps its permissions")

    def test_a_sample_whose_write_fails_is_left_as_it_was(self):
        folder = self.tmp / "whole-frames"
        folder.mkdir()
        (folder / "clip-f00001.png").write_bytes(PNG)
        out = self.tmp / "whole-sample.json"
        self.assertEqual(quiet(make_sample.main, ["--out", str(out), "--asset", f"clip={folder}", "--all"]), 0)
        before = out.read_bytes()
        (folder / "clip-f00002.png").write_bytes(PNG)
        with mock.patch.object(export.os, "replace", side_effect=OSError("no space left")), self.assertRaises(OSError):
            quiet(make_sample.main, ["--out", str(out), "--asset", f"clip={folder}", "--all", "--force"])
        self.assertEqual(out.read_bytes(), before)
        self.assertEqual(quiet(make_sample.main, ["--out", str(out), "--asset", f"clip={folder}", "--all", "--force"]), 0)
        self.assertEqual(len(json.loads(out.read_text())["assets"][0]["frames"]), 2)


class ToyData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="labeler-toy-test-"))
        cls.toy = cls.tmp / "toy"
        cls.summary = make_toy_data.build(cls.toy, seed=1, frames=5)
        cls.truth = json.loads((cls.toy / "truth.json").read_text())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_files(self):
        self.assertEqual(self.summary, {"videos": 2, "frames": 10, "cards": 13})
        for rel in ("catalog.json", "sample.json", "prefill.jsonl", "truth.json", "decklists/table-a.txt", "decklists/table-b.txt"):
            self.assertTrue((self.toy / rel).is_file(), rel)
        frames = sorted((self.toy / "frames").glob("*/*.png"))
        self.assertEqual(len(frames), 10, "ten frames to label")
        for path in frames + sorted((self.toy / "art").glob("*.png")):
            data = path.read_bytes()
            self.assertEqual(data[:8], PNG, path.name)
            width, height = struct.unpack(">II", data[16:24])
            if path.parent.parent.name == "frames":
                self.assertEqual((width, height), (make_toy_data.FRAME_W, make_toy_data.FRAME_H))
            self.assertLess(len(data), 100_000, "a drawing of plain shapes, small")
        self.assertEqual(len(list((self.toy / "art").glob("*.png"))), 13)

    def test_same_seed_same_files(self):
        other = self.tmp / "again"
        make_toy_data.forget_drawings()  # drawn afresh, not the drawings kept from the first build
        make_toy_data.build(other, seed=1, frames=5)
        for rel in ["prefill.jsonl", "sample.json", "truth.json", "catalog.json"] + [
                str(p.relative_to(self.toy)) for p in sorted((self.toy / "frames").glob("*/*.png")) + sorted((self.toy / "art").glob("*.png"))]:
            self.assertEqual((other / rel).read_bytes(), (self.toy / rel).read_bytes(), rel)
        third = self.tmp / "other-seed"
        make_toy_data.build(third, seed=2, frames=1)
        self.assertNotEqual((third / "frames/table-a/f00001.png").read_bytes(), (self.toy / "frames/table-a/f00001.png").read_bytes())
        with self.assertRaises(SystemExit):  # never written over
            quiet(make_toy_data.main, [str(self.toy)])

    def test_the_cards_have_silly_names_and_one_name_is_two_cards(self):
        cards = json.loads((self.toy / "catalog.json").read_text())["cards"]
        names = [c["name"] for c in cards]
        self.assertEqual(len(set(c["id"] for c in cards)), 13)
        thieves = [c for c in cards if c["name"] == "Sock Thief"]
        self.assertEqual([(c["id"], c["printingOf"]) for c in thieves], [("TOY-004", None), ("TOY-005", None)], "two different cards of one name")
        alt = next(c for c in cards if c["printingOf"])
        self.assertEqual((alt["id"], alt["name"], names.count(alt["name"])), ("TOY-003A", "Polite Dragon", 2), "and an alternate printing")
        # the catalog says so: the two Sock Thieves are two cards, the Dragon and its printing one
        catalog = json.loads((self.toy / "catalog.json").read_text())
        self.assertEqual(catalog["identity"], "printing")
        rule, roots = lc.identity_rule(catalog), lc.printing_roots(catalog["cards"])
        self.assertFalse(lc.same_card("TOY-004", "Sock Thief", "TOY-005", "Sock Thief", rule, roots))
        self.assertTrue(lc.same_card("TOY-003", "Polite Dragon", "TOY-003A", "Polite Dragon", rule, roots))
        for c in cards:  # every name, cost and rule fits the font
            self.assertTrue(set(c["name"].upper()) <= set(make_toy_data.FONT), c["name"])
            self.assertTrue(set(make_toy_data.LOOKS[c["id"]][4].upper()) <= set(make_toy_data.FONT), c["id"])

    def test_the_tables_change_like_a_game(self):
        """Every lesson a real table holds is on each table, from frame to frame."""
        for seed in (1, 2, 3, 4):
            make_toy_data.forget_drawings()
            for video in make_toy_data.VIDEOS:
                with self.subTest(seed=seed, video=video):
                    frames = [make_toy_data.render_frame(video, seed, k)[1] for k in range(5)]
                    every = [c for cards in frames for c in cards]
                    for cards in frames:
                        self.assertEqual(sum(c["back"] for c in cards), 1, "one card back on the table")
                        self.assertTrue(all(c["visible"] <= 0.4 or c["visible"] >= 0.6 for c in cards), "no card is a borderline case")
                    self.assertTrue(any(c["deg"] % 180 == 90 for c in every), "a card turned sideways")
                    self.assertTrue(any(c["deg"] % 360 == 180 for c in every), "a card upside down")
                    self.assertTrue(any(c["deg"] % 90 for c in every), "a tilted card")
                    self.assertTrue(any(c["cut"] for c in every), "a card cut by the frame's edge")
                    self.assertTrue(any(c["ignore"] and c["coveredBy"] for c in every), "a card more than half hidden by another")
                    self.assertTrue(any(not c["ignore"] and c["coveredBy"] for c in every), "a card partly covered, still a card")
                    for before, after in zip(frames, frames[1:]):
                        was = {c["role"]: (round(c["cx"]), round(c["cy"]), c["deg"]) for c in before}
                        now = {c["role"]: (round(c["cx"]), round(c["cy"]), c["deg"]) for c in after}
                        self.assertNotEqual(was, now, "something happens between two frames")
                    roles = [set(c["role"] for c in cards) for cards in frames]
                    self.assertTrue(any(b - a for a, b in zip(roles, roles[1:])), "a card is played")
                    self.assertTrue(any(a - b for a, b in zip(roles, roles[1:])) or video == "table-a", "a card is taken away")
        make_toy_data.forget_drawings()

    def test_the_truth_file(self):
        doc = self.truth
        self.assertEqual(set(doc), {"about", "seed", "frameW", "frameH", "frames", "model"})
        self.assertIn("not a label file", doc["about"])
        self.assertEqual(sorted(doc["frames"]), sorted(f"{v}/f{n:05d}.png" for v in ("table-a", "table-b") for n in range(1, 6)))
        ids = {c[0] for c in make_toy_data.CARDS}
        for name, cards in doc["frames"].items():
            for c in cards:
                self.assertEqual(c["outcome"], "card-back" if c["cardId"] is None else "card")
                self.assertTrue(c["cardId"] is None or c["cardId"] in ids)
                self.assertEqual(len(c["corners"]), 4)
                if c["ignore"]:  # the box around what shows lies in the frame and inside the whole card's box
                    xs, ys = [q[0] for q in c["corners"]], [q[1] for q in c["corners"]]
                    self.assertTrue(0 <= min(xs) and max(xs) <= 960 and 0 <= min(ys) and max(ys) <= 540, name)
                    whole = [q[0] for q in c["cardCorners"]]
                    self.assertTrue(min(whole) - 1 <= min(xs) and max(xs) <= max(whole) + 1, name)
                else:
                    self.assertEqual(c["corners"], c["cardCorners"])
        kinds = {m["mistake"] for said in doc["model"].values() for m in said}
        self.assertEqual(kinds, {"missed", "wrong-turn", "box-off", "stray", "wrong-name", "boxed-whole"})

    def test_the_model_s_boxes_lie_on_the_cards(self):
        """Every pretend box but the stray one covers a card's box closely, except where truth.json
        says the model got it wrong; it never boxes a card back."""
        def iou(a, b):
            ix = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
            iy = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
            return ix * iy / (a[2] * a[3] + b[2] * b[3] - ix * iy)

        for line in (self.toy / "prefill.jsonl").read_text().splitlines():
            record = json.loads(line)
            key = f"{record['set']}/{record['name']}"
            cards, said = self.truth["frames"][key], self.truth["model"][key]
            off = {m["cardId"] for m in said if m["mistake"] in ("box-off", "boxed-whole")}
            strays = 0
            for b in record["boxes"]:
                best = max(cards, key=lambda c: iou(b["box"], make_toy_data.clip_box(make_toy_data.aabb(c["cardCorners"]))))
                fit = iou(b["box"], make_toy_data.clip_box(make_toy_data.aabb(best["cardCorners"])))
                if fit < 0.3:
                    strays += 1
                    continue
                self.assertEqual(best["outcome"], "card", key)
                self.assertGreater(fit, 0.7 if best["cardId"] in off else 0.85, (key, best["cardId"]))
            self.assertEqual(strays, sum(m["mistake"] == "stray" for m in said), key)
            proposed = len(record["boxes"]) - strays
            self.assertEqual(proposed, len(cards) - sum(m["mistake"] == "missed" for m in said), key)

    def test_the_server_takes_them(self):
        serve.configure(args(sample=str(self.toy / "sample.json"), catalog=str(self.toy / "catalog.json"), art=str(self.toy / "art"),
                             prefill=[str(self.toy / "prefill.jsonl")], mode="box", role="training"))
        cards = serve.load_catalog()
        self.assertEqual(len(cards), 13)
        self.assertEqual([c["id"] for c in serve.token_table()], ["TOY-T01"])
        self.assertEqual(serve.landscape_ids(), frozenset({"TOY-009", "TOY-010"}))
        self.assertEqual({c["artUrl"] for c in cards}, {f"/art/{c['id']}" for c in cards})
        self.assertTrue(all(serve.art_file(c["id"]).is_file() for c in cards))
        self.assertEqual([s["setId"] for s in serve.list_sets()], ["table-a", "table-b"])
        self.assertEqual((serve.CFG.labels_dir, serve.CFG.decklists_dir), (self.toy.resolve() / "labels", self.toy.resolve() / "decklists"))
        for video, faces in (("table-a", 8), ("table-b", 8)):
            status, got = serve.read_prefill(video)
            self.assertEqual(status, 200, got)
            self.assertEqual(sorted(got["frames"]), [f"f{n:05d}.png" for n in range(1, 6)], "each video gets its own records")
            self.assertEqual(set(map(tuple, got["sizes"].values())), {(960.0, 540.0)})
            deck = serve.decklist_for(video)
            self.assertEqual((deck["unresolved"], len(deck["ids"])), ([], faces), "the face-up cards played on each table")
        self.assertIn("TOY-004", serve.decklist_for("table-b")["ids"])
        self.assertIn("TOY-005", serve.decklist_for("table-b")["ids"])
        self.assertEqual(len(serve.read_prefill("table-a")[1]["frames"]["f00001.png"]), 5, "the README's first frame: 5 model boxes")
        ids = {c["id"] for c in cards}
        for line in (self.toy / "prefill.jsonl").read_text().splitlines():
            record = json.loads(line)
            self.assertTrue({"t", "name", "frameW", "frameH", "boxes"} <= set(record))
            self.assertEqual(lc.prefill_row_errors(record, "record"), [])
            self.assertTrue(all(b["cardId"] in ids for b in record["boxes"]))
        self.assertEqual(len(self.truth["frames"]), 10)
        self.assertEqual([len(cards_on) for cards_on in self.truth["frames"].values()], [6, 7, 8, 7, 8, 5, 6, 7, 7, 7])


    def test_a_box_with_free_corners_saves_and_exports_as_a_quad(self):
        """The Boxes pass on the toy project: a box whose corner was pulled on its own (Shift+drag:
        cornerSource hand, no angle) saves, and the manifest holds it as a quad that
        `cardvision validate-manifest` accepts."""
        labels = self.tmp / "labels-quad"
        serve.configure(args(sample=str(self.toy / "sample.json"), catalog=str(self.toy / "catalog.json"), art=str(self.toy / "art"),
                             labels_dir=str(labels), mode="box", role="training"))

        def box(tid, corners, **kw):
            return dict({"id": tid, "corners": corners, "estimated": [False] * 4, "cornerSource": "box", "outcome": "card",
                         "identity": "TOY-001", "identitySource": "current-frame", "eligible": "yes", "conditions": {}, "labelSource": "manual"}, **kw)

        upright = lc.box_corners(100, 100, 163, 188)
        pulled = [[300.0, 100.0], [363.0, 100.0], [371.5, 196.0], [300.0, 188.0]]  # its bottom-right corner pulled down and out
        frame = {"name": "f00001.png", "t": 0.0, "frameW": 960, "frameH": 540, "done": True,
                 "targets": [box("B001", upright), box("B002", pulled, cornerSource="hand")]}
        status, res = serve.save_frame("table-a", frame)
        self.assertEqual(status, 200, res)
        self.assertEqual([t["cornerSource"] for t in res["frame"]["targets"]], ["box", "hand"])
        folded = json.loads(json.dumps(frame))
        folded["targets"][1]["corners"] = [[300, 100], [363, 100], [300, 188], [363, 188]]
        status, res = serve.save_frame("table-a", folded)
        self.assertEqual(status, 400, res)
        self.assertIn("free corners", res["error"])
        doc = json.loads((self.toy / "sample.json").read_text())
        for asset in doc["assets"]:
            asset.update(platform="local", videoId=asset["assetId"], framesDir=str(self.toy / asset["framesDir"]))
        sample = self.tmp / "sample-quad.json"
        sample.write_text(json.dumps(doc))
        out = self.tmp / "quad-manifest" / "toy.manifest.jsonl"
        self.assertEqual(quiet(export.main, ["manifest", "--labels-dir", str(labels), "--sample", str(sample), "--out", str(out),
                                             "--credit", "Toy Labeler", "--source-type", "physical/webcam",
                                             "--catalog", str(self.toy / "catalog.json")]), 0)
        rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual([(b["id"], b["shape"], b["oriented"]) for b in rows[0]["boxes"]], [("B001", "rotated-box", True), ("B002", "quad", True)])
        self.assertEqual(rows[0]["boxes"][1]["quad"][2], [round(371.5 / 960, 6), round(196.0 / 540, 6)])
        repo = HERE.parent
        if subprocess.run([sys.executable, "-c", "import cardvision.cli"], cwd=str(repo), capture_output=True).returncode:
            self.skipTest("the cardvision package cannot be imported here")
        done = subprocess.run([sys.executable, "-m", "cardvision", "validate-manifest", str(out)], cwd=str(repo), capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)


class Smoke(unittest.TestCase):
    """The real thing: start serve.py as a process on a free port and load the page."""

    def test_server_starts_and_serves_the_page(self):
        tmp = Path(tempfile.mkdtemp(prefix="labeler-smoke-test-"))
        proc = None
        try:
            toy = tmp / "toy"
            make_toy_data.build(toy, seed=1, frames=2)
            proc = subprocess.Popen(
                [sys.executable, "-B", "-u", str(HERE / "serve.py"), "--port", "0", "--mode", "box", "--role", "training",
                 "--sample", str(toy / "sample.json"), "--catalog", str(toy / "catalog.json"), "--art", str(toy / "art"),
                 "--prefill", str(toy / "prefill.jsonl")],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=str(tmp), env=dict(os.environ, LABELER_QUIET="1"))
            first = proc.stdout.readline()  # "labeling tool: http://127.0.0.1:<port>/  mode=box role=training"
            self.assertIn("http://127.0.0.1:", first, "the server prints where it listens")
            base = first.split()[2].rstrip("/")
            self.assertNotEqual(base.rsplit(":", 1)[1], "0", "port 0 picks a free port and says which")

            def fetch(path):
                with urllib.request.urlopen(base + path, timeout=10) as r:
                    return r.status, r.headers.get("Content-Type"), r.read()

            status, ctype, body = fetch("/")
            self.assertEqual((status, ctype), (200, "text/html; charset=utf-8"))
            page = body.decode("utf-8")
            self.assertIn("<title>Card labeler</title>", page)
            scripts = [part.split('"')[0] for part in page.split('<script src="')[1:]]
            self.assertEqual(len(scripts), 16)
            self.assertLess(scripts.index("/boxgeom.js"), scripts.index("/boxedit.js"), "boxedit.js reads boxgeom.js as it loads")
            self.assertLess(scripts.index("/boxedit.js"), scripts.index("/sources.js"))
            self.assertLess(scripts.index("/picker.js"), scripts.index("/names.js"), "the list of names reads picker.js as it loads")
            self.assertLess(scripts.index("/names.js"), scripts.index("/sources.js"))
            sheets = [part.split('"')[0] for part in page.split('<link rel="stylesheet" href="')[1:]]
            self.assertEqual(sheets, ["/theme.css", "/sources.css"], "the theme first: the page's style sheet reads its values")
            for src in scripts + sheets:  # everything the page loads comes from this server
                self.assertTrue(src.startswith("/"), src)
                self.assertEqual(fetch(src)[0], 200, src)
            self.assertNotIn("http://", page.replace("http://www.w3.org", ""))
            self.assertNotIn("https://", page)
            config = json.loads(fetch("/api/config")[2])
            self.assertEqual((config["mode"], config["role"], config["prefill"], config["art"]), ("box", "training", True, True))
            # the command this run was started with
            at = config["launch"].index(str(HERE / "serve.py"))
            self.assertEqual(config["launch"][at + 1:at + 5], ["--port", "0", "--mode", "box"])
            self.assertEqual(config["launch"][-2:], ["--prefill", str(toy / "prefill.jsonl")])
            self.assertEqual([s["setId"] for s in json.loads(fetch("/api/sets")[2])], ["table-a", "table-b"])
            self.assertEqual(len(json.loads(fetch("/api/catalog")[2])), 13)
            self.assertEqual(fetch("/frames/table-a/f00001.png")[2][:8], PNG)
            self.assertEqual(fetch("/art/TOY-001")[2][:8], PNG)
            self.assertEqual(len(json.loads(fetch("/api/prefill/table-a")[2])["frames"]), 2)
            self.assertEqual(sorted(p.name for p in tmp.iterdir()), ["toy"], "nothing is written where the server was started")
            self.assertFalse((toy / "labels").exists(), "and no label is written before the first save")
        finally:
            if proc is not None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                proc.stdout.close()
            shutil.rmtree(tmp, ignore_errors=True)


class PlainRefusals(unittest.TestCase):
    """A start that cannot work ends in one sentence and a non-zero exit, never a traceback."""

    def run_server(self, *options):
        tmp = Path(tempfile.mkdtemp(prefix="labeler-refusal-test-"))
        try:
            toy = tmp / "toy"
            make_toy_data.build(toy, seed=1, frames=1)
            cmd = [sys.executable, "-B", str(HERE / "serve.py"), "--sample", str(toy / "sample.json"), "--port", "0"]
            cmd += [o.replace("TOY", str(toy)) for o in options]
            return subprocess.run(cmd, capture_output=True, text=True, timeout=30, cwd=str(tmp), env=dict(os.environ, LABELER_QUIET="1"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_a_mode_and_role_that_do_not_go_together(self):
        for options, words in (
                (("--mode", "box", "--role", "test", "--prefill", "TOY/prefill.jsonl"), "--mode box --role test: prefill is allowed only"),
                (("--mode", "center", "--role", "training"), "--mode center --role training: center mode"),
                (("--mode", "training", "--role", "development"), "--mode training --role development: training mode"),
                (("--mode", "identify", "--role", "training", "--prefill", "TOY/prefill.jsonl"), "--mode identify --role training: prefill is allowed only"),
                (("--mode", "verify", "--role", "test", "--arm", "new=TOY/prefill.jsonl"), "--mode verify --role test: verify mode")):
            with self.subTest(options=options):
                res = self.run_server(*options)
                self.assertEqual(res.returncode, 1)
                self.assertEqual(res.stdout, "")
                self.assertNotIn("Traceback", res.stderr)
                self.assertEqual(len(res.stderr.strip().splitlines()), 1, res.stderr)
                self.assertTrue(res.stderr.startswith(words), res.stderr)

    def test_the_mode_has_one_spelling(self):
        res = self.run_server("--mode", "centre", "--role", "development")
        self.assertEqual(res.returncode, 2)
        self.assertEqual(res.stdout, "")
        self.assertIn("argument --mode: invalid choice: 'centre'", res.stderr)

    def test_a_port_that_cannot_be_opened(self):
        res = self.run_server("--mode", "box", "--role", "training", "--port", "99999")
        self.assertEqual(res.returncode, 1)
        self.assertNotIn("Traceback", res.stderr)
        self.assertEqual(len(res.stderr.strip().splitlines()), 1, res.stderr)
        self.assertTrue(res.stderr.startswith("--port 99999: cannot listen on 127.0.0.1:99999"), res.stderr)


class PageSupport(Base):
    """What the server tells the page beyond the labels: where a missing frame was looked for,
    and that it still runs."""

    def test_a_missing_frame_names_the_file_looked_for(self):
        self.config()
        status, body = self.get("/frames/vidA/f00009.png")
        self.assertEqual(status, 404)
        self.assertEqual(body, {"error": "not found", "path": str((self.tmp / "frames" / "vidA" / "f00009.png").resolve())})
        self.assertEqual(self.fetch("/frames/vidA/f00001.png")[0], 200)
        # only a frame's answer says where it looked: a missing page file does not
        with mock.patch.dict(serve.STATIC_FILES, {"/gone.js": "application/javascript"}):
            self.assertEqual(self.get("/gone.js"), (404, {"error": "not found"}))

    def test_config_says_how_the_run_was_started_only_when_it_was_started_as_a_program(self):
        self.config()
        with mock.patch.object(serve.CFG, "launch", None):
            self.assertIsNone(self.get("/api/config")[1]["launch"])
        with mock.patch.object(serve.CFG, "launch", ["python3", "serve.py", "--mode", "box"]):
            self.assertEqual(self.get("/api/config")[1]["launch"], ["python3", "serve.py", "--mode", "box"])

    def test_the_heartbeat_is_an_ordinary_request_left_out_of_the_log(self):
        self.config()
        self.assertEqual(self.get(serve.HEARTBEAT + "=1")[1]["mode"], "box", "the same answer as /api/config")
        written = io.StringIO()
        with mock.patch.dict(os.environ, {"LABELER_QUIET": ""}), contextlib.redirect_stderr(written):
            handler = serve.Handler.__new__(serve.Handler)
            handler.client_address = ("127.0.0.1", 0)
            for handler.path in ("/api/config", serve.HEARTBEAT + "=1"):
                handler.log_message('"%s" %s', f"GET {handler.path} HTTP/1.1", "200")
        self.assertEqual(written.getvalue().splitlines(), ['127.0.0.1 - "GET /api/config HTTP/1.1" 200'])


class Housekeeping(unittest.TestCase):
    """The folder itself: license lines, no dependency beyond the standard library, no data."""

    SOURCE = (".py", ".js")
    ALLOWED = {".py", ".js", ".html", ".css", ".md"}

    def files(self):
        return sorted(p for p in HERE.rglob("*") if p.is_file() and "__pycache__" not in p.parts)

    def test_every_source_file_starts_with_the_license_identifier(self):
        want = {".py": "# SPDX-License-Identifier: Apache-2.0", ".js": "// SPDX-License-Identifier: Apache-2.0"}
        missing = [p.name for p in self.files() if p.suffix in want and p.read_text(encoding="utf-8").splitlines()[:1] != [want[p.suffix]]]
        self.assertEqual(missing, [])

    def test_python_imports_the_standard_library_and_this_folder_only(self):
        local = {p.stem for p in HERE.glob("*.py")}
        outside = {}
        for path in HERE.glob("*.py"):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0:
                    names = [node.module or ""]
                for name in names:
                    top = name.split(".")[0]
                    if top not in sys.stdlib_module_names and top not in local:
                        outside.setdefault(path.name, set()).add(top)
        self.assertEqual(outside, {})

    def test_javascript_requires_only_this_folder_and_node(self):
        outside = []
        for path in HERE.glob("*.js"):
            text = path.read_text(encoding="utf-8")
            for part in text.split('require("')[1:]:
                module = part.split('"')[0]
                if not (module.startswith("./") and (HERE / module).is_file()) and module not in ("assert", "fs", "path"):
                    outside.append(f"{path.name}: {module}")
        self.assertEqual(outside, [])

    def test_no_data_and_nothing_large(self):
        files = self.files()
        self.assertEqual(sorted({p.suffix for p in files} - self.ALLOWED), [], "source and documentation only: no image, label, frame or log")
        self.assertEqual([p.name for p in files if p.stat().st_size > 300_000], [])
        self.assertEqual([p.name for p in files if p.parent != HERE], [], "a flat folder: no data folder beside the source")


if __name__ == "__main__":
    unittest.main(verbosity=1)
