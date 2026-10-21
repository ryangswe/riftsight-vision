# SPDX-License-Identifier: Apache-2.0
"""``cardvision import-catalog``: a card list (CSV, TSV or JSON) in, a catalog out, with a report.
The downloads are made from a server on this machine; nothing reaches the network."""

from __future__ import annotations

import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from cardvision import cli
from cardvision.core.catalog import load_catalog
from cardvision.import_catalog import MAX_IMAGE_BYTES, CatalogImportError, ImportOptions, import_catalog, read_rows
from cardvision.import_catalog.importer import sniff_image

ROOT = Path(__file__).resolve().parents[1]


def _image(kind: str = "PNG", seed: int = 0, size: int = 40) -> bytes:
    pixels = np.random.default_rng(seed).integers(0, 256, (size, size, 3), dtype=np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format=kind)
    return buffer.getvalue()


def _write(path: Path, text: str, bom: bool = False) -> Path:
    path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8"))
    return path


def _import(tmp_path: Path, name: str, text: str, **options) -> tuple:
    source = _write(tmp_path / name, text)
    out = tmp_path / "out" / "catalog.json"
    force = options.pop("force", False)
    sleep = options.pop("sleep", lambda seconds: None)
    report = import_catalog(source, out, ImportOptions(game="toy", delay=options.pop("delay", 0), **options),
                            force=force, sleep=sleep)
    return report, out


SHEET = ("Card ID,Card Name,Type,Reprint of,Image,Color,Cost,Rules text\n"
         "A-001,Alder,unit,,a1.png,Red;Blue,3,Draw a card.\n"
         "A-001A,Alder,unit,A-001,a1a.png,Red,3,\n"
         "A-002,Birch,spell,,,Green,1,\n")


# ----------------------------------------------------------------------------------- reading
def test_a_csv_with_a_byte_order_mark_and_common_headers_imports(tmp_path):
    source = _write(tmp_path / "cards.csv", SHEET, bom=True)
    report = import_catalog(source, tmp_path / "catalog.json", ImportOptions(game="toy"))
    assert report.errors == [] and report.written
    assert report.columns == {"id": "Card ID", "name": "Card Name", "kind": "Type", "printing_of": "Reprint of",
                              "image": "Image"}
    catalog = load_catalog(tmp_path / "catalog.json")
    assert catalog.ids() == ["A-001", "A-001A", "A-002"] and catalog.game == "toy" and catalog.locale == "en"
    assert catalog.card("A-001A").printing_of == "A-001" and catalog.card("A-002").art is None
    assert catalog.card("A-001").kind == "unit"


def test_a_tsv_imports(tmp_path):
    report, out = _import(tmp_path, "cards.tsv", "code\tname\tart\nX1\tOne, with a comma\tx1.png\nX2\tTwo\t\n")
    assert report.written
    catalog = load_catalog(out)
    assert catalog.name_of("X1") == "One, with a comma" and catalog.card("X2").art is None


@pytest.mark.parametrize("wrap", [False, True], ids=["a list of rows", "an object with cards"])
def test_a_json_list_of_rows_imports_with_numbers_and_nested_values(tmp_path, wrap):
    rows = [{"id": 101, "name": "Alder", "cost": 3, "tags": ["a", "b"], "meta": {"artist": "N"}},
            {"id": 102, "name": "Birch", "cost": None, "tags": []}]
    report, out = _import(tmp_path, "cards.json", json.dumps({"cards": rows} if wrap else rows), facets=["cost"])
    assert report.written
    catalog = load_catalog(out)
    assert catalog.ids() == ["101", "102"]
    assert catalog.card("101").facets == {"cost": (3,)} and catalog.card("102").facets == {}
    assert catalog.card("101").extra == {"tags": ["a", "b"], "meta": {"artist": "N"}}
    assert catalog.card("102").extra == {}, "an empty cell is left out"


def test_the_rows_headers_and_format_are_read():
    rows, headers, kind = read_rows(ROOT / "games" / "_template" / "cards.example.csv")
    assert kind == "csv" and headers == ["id", "name", "kind", "printing_of", "image", "set", "cost", "text"]
    assert rows[0]["id"] == "SET-001"


def test_a_file_that_is_not_utf8_or_has_no_known_suffix_is_refused(tmp_path):
    (tmp_path / "cards.csv").write_bytes("id,name\nA,Caf\xe9\n".encode("latin-1"))
    with pytest.raises(CatalogImportError, match="UTF-8"):
        read_rows(tmp_path / "cards.csv")
    _write(tmp_path / "cards.txt", "id,name\nA,B\n")
    with pytest.raises(CatalogImportError, match="--format"):
        read_rows(tmp_path / "cards.txt")
    assert read_rows(tmp_path / "cards.txt", "csv")[0] == [{"id": "A", "name": "B"}]


# ----------------------------------------------------------------------------------- columns
def test_a_mapping_names_the_columns_that_are_not_found_by_themselves(tmp_path):
    text = "Number,Title,Category,Picture\nN1,One,unit,n1.png\n"
    with pytest.raises(CatalogImportError, match="--map id=HEADER"):
        _import(tmp_path, "cards.csv", text)
    report, out = _import(tmp_path, "cards.csv", text,
                          mapping={"id": "number", "name": "Title", "kind": "Category", "art": "Picture"})
    assert report.columns == {"id": "Number", "name": "Title", "kind": "Category", "image": "Picture"}
    assert load_catalog(out).card("N1").art == "n1.png"


def test_two_columns_that_could_each_be_a_field_must_be_chosen_between(tmp_path):
    text = "id,name,image,art\nA,One,a.png,b.png\n"
    with pytest.raises(CatalogImportError, match="--map image=HEADER"):
        _import(tmp_path, "cards.csv", text)
    report, out = _import(tmp_path, "cards.csv", text, mapping={"image": "art"})
    assert load_catalog(out).card("A").art == "b.png" and load_catalog(out).card("A").extra == {"image": "a.png"}


def test_a_column_that_is_not_there_is_named(tmp_path):
    with pytest.raises(CatalogImportError, match="no column 'Colour'"):
        _import(tmp_path, "cards.csv", SHEET, facets=["Colour"])
    with pytest.raises(CatalogImportError, match="unknown field"):
        _import(tmp_path, "cards.csv", SHEET, mapping={"cost": "Cost"})


def test_facets_take_numbers_when_every_value_is_one_and_split_multiple_values(tmp_path):
    report, out = _import(tmp_path, "cards.csv", SHEET, facets=["Color", "Cost"], splits={"color": ";"})
    assert [(f["key"], f["type"]) for f in report.facets] == [("color", "text"), ("cost", "number")]
    catalog = load_catalog(out)
    assert [(f.key, f.label, f.type) for f in catalog.facets] == [("color", "Color", "text"), ("cost", "Cost", "number")]
    assert catalog.card("A-001").facets == {"color": ("Red", "Blue"), "cost": (3,)}
    assert catalog.card("A-002").facets == {"color": ("Green",), "cost": (1,)}


def test_a_facet_with_one_value_that_is_not_a_number_is_text(tmp_path):
    text = "id,name,Sub Type,cost\nA,One,x,3\nB,Two,y,X\nC,Three,,2.5\n"
    report, out = _import(tmp_path, "cards.csv", text, facets=["Sub Type", "cost"])
    catalog = load_catalog(out)
    assert [(f.key, f.type) for f in catalog.facets] == [("subType", "text"), ("cost", "text")]
    assert catalog.card("B").facets["cost"] == ("X",) and catalog.card("C").facets == {"cost": ("2.5",)}


def test_the_other_columns_go_to_extra_by_default_and_the_report_lists_them(tmp_path):
    report, out = _import(tmp_path, "cards.csv", SHEET)
    assert report.extra == ["Color", "Cost", "Rules text"] and report.extra_by_default
    assert any("--no-extra" in line for line in report.lines())
    catalog = load_catalog(out)
    assert catalog.card("A-001").extra == {"Color": "Red;Blue", "Cost": "3", "Rules text": "Draw a card."}
    assert catalog.card("A-001A").extra == {"Color": "Red", "Cost": "3"}, "an empty cell is left out, not \"\""


def test_extra_can_be_chosen_split_or_turned_off(tmp_path):
    report, out = _import(tmp_path, "cards.csv", SHEET, extra=["Color"], splits={"Color": ";"})
    assert report.left_out == ["Cost", "Rules text"]
    assert load_catalog(out).card("A-001").extra == {"Color": ["Red", "Blue"]}
    report, out = _import(tmp_path, "cards.csv", SHEET, extra=[], force=True)
    assert report.extra == [] and all(card.extra == {} for card in load_catalog(out))
    assert "extra" not in out.read_text(encoding="utf-8")


# ------------------------------------------------------------------------------------ checks
def test_a_duplicate_id_is_an_error_and_nothing_is_written(tmp_path):
    report, out = _import(tmp_path, "cards.csv", "id,name\nA,One\nB,Two\nA,Three\n")
    assert report.errors == ["row 3: the id 'A' is used twice (first in row 1)"]
    assert not out.exists() and report.written is None
    assert any("nothing was written" in line for line in report.lines())


def test_a_printing_of_that_names_no_card_is_an_error(tmp_path):
    report, out = _import(tmp_path, "cards.csv", "id,name,printing_of\nA,One,\nB,One,Z\n")
    assert report.errors == ["row 2: printing_of 'Z' names no card"] and not out.exists()


def test_a_row_without_an_id_or_a_name_is_an_error(tmp_path):
    report, out = _import(tmp_path, "cards.csv", "id,name,cost\n,One,1\nB,,2\n,,\n")
    assert report.errors == ["row 1: no id (column 'id' is empty)", "row 2: no name (column 'name' is empty)"]
    assert report.blank_rows == 1 and not out.exists()


def test_an_id_the_catalog_refuses_is_reported_and_nothing_is_written(tmp_path):
    report, out = _import(tmp_path, "cards.csv", "id,name\nA 1,One\n")
    assert len(report.errors) == 1 and "'A 1'" in report.errors[0] and not out.exists()


def test_one_name_under_several_ids_suggests_the_name_rule_and_lists_them(tmp_path):
    report, out = _import(tmp_path, "cards.csv", "id,name\nA,Alder\nB,Alder\nC,Birch\n")
    assert report.same_name == [{"name": "Alder", "ids": ["A", "B"]}]
    assert report.identity["suggested"] == "name" and report.identity["rule"] == "name"
    assert not report.identity["given"] and "--identity printing" in report.identity["reason"]
    assert load_catalog(out).identity == "name"


def test_printing_of_suggests_the_printing_rule_and_identity_can_be_chosen(tmp_path):
    text = "id,name,printing_of\nA,Alder,\nA2,Alder,A\nB,Alder,\n"
    report, out = _import(tmp_path, "cards.csv", text)
    assert report.identity["suggested"] == "printing" and load_catalog(out).identity == "printing"
    assert "1 name(s) are shared by cards that printing_of does not join" in report.identity["reason"]
    report, out = _import(tmp_path, "cards.csv", text, identity="name", force=True)
    assert report.identity["given"] and load_catalog(out).identity == "name"


def test_a_printing_of_a_printing_is_an_error_under_the_printing_rule_only(tmp_path):
    text = "id,name,printing_of\nA,Alder,\nA2,Alder,A\nA3,Alder,A2\n"
    report, out = _import(tmp_path, "cards.csv", text)
    assert len(report.errors) == 1 and "itself a printing of 'A'" in report.errors[0] and not out.exists()
    report, out = _import(tmp_path, "cards.csv", text, identity="name")
    assert report.written


def test_the_shapes_of_the_ids_are_counted(tmp_path):
    report, _ = _import(tmp_path, "cards.csv", "id,name\nSET-001,A\nSET-002,B\nSET-P01,C\nset-9a,D\n")
    assert report.id_shapes == [{"shape": "AAA-999", "count": 2, "example": "SET-001"},
                                {"shape": "AAA-A99", "count": 1, "example": "SET-P01"},
                                {"shape": "aaa-9a", "count": 1, "example": "set-9a"}]


def test_local_images_are_checked_and_one_file_under_several_cards_is_reported(tmp_path):
    images = tmp_path / "images"
    (images / "sub").mkdir(parents=True)
    (images / "a.png").write_bytes(_image(seed=1))
    (images / "sub" / "b.png").write_bytes(_image(seed=1))  # the same bytes as a.png
    (images / "c.png").write_bytes(_image(seed=2))
    text = (f"id,name,image\nA,Alder,a.png\nB,Birch,sub\\b.png\nC,Cedar,{images / 'c.png'}\nD,Dogwood,d.png\n"
            "E,Elm,/elsewhere/e.png\n")
    report, out = _import(tmp_path, "cards.csv", text, images=images)
    catalog = load_catalog(out)
    assert [catalog.card(card_id).art for card_id in "ABCDE"] == ["a.png", "sub/b.png", "c.png", "d.png", None]
    assert report.shared_images == [["A", "B"]]
    assert [entry["id"] for entry in report.without_art] == ["E"] and "outside --images" in report.without_art[0]["reason"]
    assert report.art_check is not None and report.art_check["missing"] == ["D"]
    assert report.art_check["usable"] == 3


def test_without_an_images_folder_the_images_are_not_checked(tmp_path):
    report, _ = _import(tmp_path, "cards.csv", "id,name,image\nA,One,a.png\n")
    assert report.art_check is None and any("--images" in note for note in report.notes)


def test_an_existing_catalog_is_not_replaced_without_force(tmp_path):
    out = tmp_path / "out" / "catalog.json"
    out.parent.mkdir()
    out.write_text("mine", encoding="utf-8")
    with pytest.raises(CatalogImportError, match="--overwrite"):
        _import(tmp_path, "cards.csv", SHEET)
    assert out.read_text(encoding="utf-8") == "mine"
    report, _ = _import(tmp_path, "cards.csv", SHEET, force=True)
    assert report.written and len(load_catalog(out)) == 3


# --------------------------------------------------------------------------------- downloads
class _Server:
    """A web server on this machine with fixed answers, counting the requests for each path."""

    def __init__(self, routes: dict) -> None:
        self.routes, self.hits = routes, {}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - http.server's name
                outer.hits[self.path] = outer.hits.get(self.path, 0) + 1
                answer = outer.routes.get(self.path, (404, b"not here"))
                if callable(answer):
                    answer = answer(outer.hits[self.path])
                if isinstance(answer, dict):  # a reply shaped by hand
                    if "raw" in answer:
                        self.wfile.write(answer["raw"])
                        return
                    self.send_response(answer.get("status", 200))
                    for name, value in answer.get("headers", {}).items():
                        self.send_header(name, value)
                    if answer.get("length", True) is not None:
                        claimed = answer.get("length", True)
                        self.send_header("Content-Length", str(len(answer["body"]) if claimed is True else claimed))
                    self.end_headers()
                    self.wfile.write(answer.get("body", b""))
                    return
                status, body = answer
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()


@pytest.fixture
def server():
    png, jpg, webp = _image("PNG", 1), _image("JPEG", 2), _image("WEBP", 3)
    started = _Server({
        "/a.png": (200, png), "/b": (200, jpg), "/c.webp": (200, webp),
        "/page.png": (200, b"<html>not an image</html>"),
        "/big.png": (200, png + b"\0" * 2000),
        "/flaky.png": lambda hit: (500, b"busy") if hit == 1 else (200, _image("PNG", 4)),
        "/down.png": (503, b"down"),
    })
    yield started
    started.close()


def _url_sheet(base: str) -> str:
    return ("id,name,image\n"
            f"A,Alder,{base}/a.png\nB,Birch,{base}/b\nC,Cedar,{base}/c.webp\nD,Dogwood,{base}/missing.png\n"
            f"E,Elm,{base}/page.png\nF,Fir,{base}/big.png\nG,Gum,{base}/flaky.png\nH,Hazel,{base}/down.png\n"
            f"I,Ivy,{base}/a.png\n")


def test_urls_are_downloaded_once_each_and_failures_leave_cards_without_art(tmp_path, server):
    waits = []
    report, out = _import(tmp_path, "cards.csv", _url_sheet(server.url), download=True, delay=0.25,
                          sleep=waits.append, max_bytes=len(_image("PNG", 1)) + 100)
    catalog = load_catalog(out)
    art = {card.id: card.art for card in catalog}
    assert art == {"A": "A.png", "B": "B.jpg", "C": "C.webp", "D": None, "E": None, "F": None, "G": "G.png",
                   "H": None, "I": "A.png"}
    reasons = {entry["id"]: entry["reason"] for entry in report.without_art}
    assert reasons["D"].endswith("HTTP 404") and "not a JPEG, PNG or WebP" in reasons["E"]
    assert "larger than" in reasons["F"] and reasons["H"].endswith("HTTP 503")
    assert server.hits["/a.png"] == 1, "one URL, one request"
    assert server.hits["/missing.png"] == 1, "a 404 is not tried again"
    assert server.hits["/flaky.png"] == 2 and server.hits["/down.png"] == 2, "a server error is tried once more"
    requests = sum(server.hits.values())
    assert report.downloads == {"requests": requests, "downloaded": 4, "present": 0, "failed": 4}
    assert waits == [0.25] * (requests - 1), "one request at a time, the delay between two"
    assert report.shared_images == [["A", "I"]]
    folder = out.parent / "art"
    assert sorted(path.name for path in folder.iterdir()) == ["A.png", "B.jpg", "C.webp", "G.png"]
    assert sniff_image((folder / "B.jpg").read_bytes()) == ".jpg"
    assert report.art_check is not None and report.art_check["usable"] == 5


def test_the_size_cap_is_five_megabytes_by_default():
    assert MAX_IMAGE_BYTES == 5 * 1024 * 1024 and ImportOptions(game="toy").max_bytes == MAX_IMAGE_BYTES


def test_a_second_run_skips_the_images_already_there(tmp_path, server):
    _import(tmp_path, "cards.csv", _url_sheet(server.url), download=True)
    first = dict(server.hits)
    report, _ = _import(tmp_path, "cards.csv", _url_sheet(server.url), download=True, force=True)
    again = {path: server.hits[path] - first.get(path, 0) for path in server.hits}
    assert again["/a.png"] == 0 and again["/b"] == 0 and again["/flaky.png"] == 0
    assert again["/missing.png"] == 1, "what failed is asked for again"
    assert report.downloads["present"] == 5 and report.downloads["downloaded"] == 0, "big.png is under the default cap"


def test_without_download_the_urls_stay_urls_and_nothing_is_requested(tmp_path, server):
    report, out = _import(tmp_path, "cards.csv", _url_sheet(server.url))
    assert server.hits == {} and report.downloads["requests"] == 0
    assert load_catalog(out).card("A").art == f"{server.url}/a.png"
    assert report.art_check is None
    assert any(note.startswith("9 image(s) are URLs") and "--download --art-out DIR" in note for note in report.notes)
    assert not (out.parent / "art").exists()


def test_paths_and_urls_together_need_one_art_folder(tmp_path, server):
    text = f"id,name,image\nA,Alder,{server.url}/a.png\nB,Birch,b.png\n"
    with pytest.raises(CatalogImportError, match="--art-out the same folder as --images"):
        _import(tmp_path, "cards.csv", text, download=True)
    images = tmp_path / "images"
    images.mkdir()
    report, out = _import(tmp_path, "cards.csv", text, images=images)
    assert [card.art for card in load_catalog(out)] == [f"{server.url}/a.png", "b.png"], "without --download, no clash"
    report, out = _import(tmp_path, "cards.csv", text, images=images, art_out=images, download=True, force=True)
    assert [card.art for card in load_catalog(out)] == ["A.png", "b.png"]
    assert (images / "A.png").is_file()


def test_card_ids_that_are_no_file_names_get_safe_distinct_ones(tmp_path, server):
    text = f"id,name,image\nX/1,One,{server.url}/a.png\nX_1,Two,{server.url}/b\n"
    report, out = _import(tmp_path, "cards.csv", text, download=True)
    names = [card.art for card in load_catalog(out)]
    assert names[0].startswith("X_1-") and names[0].endswith(".png") and names[1].startswith("X_1-")
    assert names[0] != names[1]


# ------------------------------------------------------------------------------- the command
def test_the_command_writes_the_catalog_and_a_report(tmp_path, capsys):
    source = _write(tmp_path / "cards.csv", SHEET)
    out, report_file = tmp_path / "catalog.json", tmp_path / "report.json"
    assert cli.main(["import-catalog", str(source), "--out", str(out), "--game", "toy", "--locale", "fr",
                     "--facets", "Color,Cost", "--split", "Color=;", "--identity", "name",
                     "--report", str(report_file)]) == 0
    said = capsys.readouterr().out
    assert f"wrote {out}: 3 card(s)" in said and "facet 'cost' <- 'Cost' (number)" in said
    catalog = load_catalog(out)
    assert catalog.locale == "fr" and catalog.identity == "name" and catalog.card("A-001").facets["color"] == ("Red", "Blue")
    saved = json.loads(report_file.read_text(encoding="utf-8"))
    assert saved["cards"] == 3 and saved["extra"] == ["Rules text"] and saved["identity"]["given"] is True
    assert cli.main(["import-catalog", str(source), "--out", str(out), "--game", "toy"]) == 1, "no overwrite"
    assert "--overwrite" in capsys.readouterr().err


def test_the_command_fails_when_the_rows_have_errors(tmp_path, capsys):
    source = _write(tmp_path / "cards.csv", "id,name\nA,One\nA,Two\n")
    assert cli.main(["import-catalog", str(source), "--out", str(tmp_path / "c.json"), "--game", "toy",
                     "--no-extra"]) == 1
    assert "used twice" in capsys.readouterr().out and not (tmp_path / "c.json").exists()


def test_the_template_example_sheet_imports_into_the_templates_shape(tmp_path, capsys):
    out = tmp_path / "catalog.json"
    assert cli.main(["import-catalog", str(ROOT / "games" / "_template" / "cards.example.csv"), "--out", str(out),
                     "--game", "your-game", "--facets", "set,cost"]) == 0
    catalog = load_catalog(out)
    template = load_catalog(ROOT / "games" / "_template" / "catalog.json")
    assert {card.id for card in template} <= set(catalog.ids())
    for card in template:
        mine = catalog.card(card.id)
        assert (mine.name, mine.kind, mine.printing_of, mine.art) == (card.name, card.kind, card.printing_of, card.art)
        assert mine.facets["cost"] == card.facets["cost"] and mine.facets["set"] == card.facets["set"]
    assert catalog.card("SET-P07").art is None and catalog.card("SET-001A").printing_of == "SET-001"
    assert catalog.card("SET-002").extra == {"text": "Deal 2 damage."}


def test_the_command_downloads_only_with_download(tmp_path, server, capsys):
    source = _write(tmp_path / "cards.csv", f"id,name,image\nA,Alder,{server.url}/a.png\n")
    out, art = tmp_path / "catalog.json", tmp_path / "pictures"
    assert cli.main(["import-catalog", str(source), "--out", str(out), "--game", "toy", "--art-out", str(art)]) == 0
    assert server.hits == {} and not art.exists() and "--download --art-out DIR" in capsys.readouterr().out
    assert cli.main(["import-catalog", str(source), "--out", str(out), "--game", "toy", "--art-out", str(art),
                     "--download", "--delay", "0", "--overwrite"]) == 0
    assert server.hits == {"/a.png": 1} and load_catalog(out).card("A").art == "A.png" and (art / "A.png").is_file()


# ------------------------------------------------------------------------- awkward replies
@pytest.fixture
def awkward():
    png = _image("PNG", 5)
    started = _Server({
        "/short.png": {"body": png[:50], "length": len(png)},
        "/short-once.png": lambda hit: {"body": png[:50], "length": len(png)} if hit == 1 else (200, png),
        "/endless.png": {"body": png + b"\0" * 5000, "length": None},
        "/garbage.png": {"raw": b"this is not HTTP\r\n\r\n"},
        "/to-file.png": {"status": 302, "headers": {"Location": "file:///etc/hosts"}, "body": b""},
        "/my%20card.png": (200, png),
    })
    yield started
    started.close()


def _download_one(tmp_path, url, **options):
    report, out = _import(tmp_path, "cards.csv", f"id,name,image\nA,Alder,{url}\n", download=True, **options)
    reason = report.without_art[0]["reason"] if report.without_art else None
    return report, load_catalog(out).card("A").art, reason


def test_a_body_shorter_than_its_length_is_tried_again_and_never_saved(tmp_path, awkward):
    report, art, reason = _download_one(tmp_path, f"{awkward.url}/short.png")
    assert art is None and "cut short" in reason and awkward.hits["/short.png"] == 2
    assert list((tmp_path / "out" / "art").iterdir()) == [], "no file, whole or partial, is left for a rerun to skip"
    report, art, reason = _download_one(tmp_path, f"{awkward.url}/short-once.png", force=True)
    assert art == "A.png" and awkward.hits["/short-once.png"] == 2


def test_a_body_without_a_length_is_capped_while_it_is_read(tmp_path, awkward):
    report, art, reason = _download_one(tmp_path, f"{awkward.url}/endless.png", max_bytes=1000)
    assert art is None and reason.endswith("larger than 1000 bytes") and awkward.hits["/endless.png"] == 1


def test_a_reply_that_is_not_http_and_a_url_that_cannot_be_requested_leave_the_card_without_art(tmp_path, awkward):
    report, art, reason = _download_one(tmp_path, f"{awkward.url}/garbage.png")
    assert art is None and "not a valid HTTP reply" in reason and awkward.hits["/garbage.png"] == 2
    port = awkward.url.rsplit(":", 1)[1]
    bad = f"http://127.0.0.1:{port}x/a.png"
    report, art, reason = _download_one(tmp_path, bad, force=True)
    assert art is None and "not a URL that can be requested" in reason and reason.startswith(bad)
    assert report.downloads["requests"] == 1, "a URL that cannot be requested is not tried again"


def test_a_space_in_a_url_is_encoded_for_the_request_and_the_report_keeps_the_url(tmp_path, awkward):
    report, art, _ = _download_one(tmp_path, f"{awkward.url}/my card.png")
    assert art == "A.png" and awkward.hits["/my%20card.png"] == 1
    report, art, reason = _download_one(tmp_path, f"{awkward.url}/no such card.png", force=True,
                                        art_out=tmp_path / "other")
    assert reason == f"{awkward.url}/no such card.png: HTTP 404"


def test_a_redirect_away_from_http_is_refused_with_its_reason(tmp_path, awkward):
    report, art, reason = _download_one(tmp_path, f"{awkward.url}/to-file.png")
    assert art is None and "redirect to file: refused" in reason and "302" not in reason
    assert awkward.hits["/to-file.png"] == 1, "a refused redirect is not tried again"


def test_a_redirect_from_https_down_to_http_is_refused():
    import urllib.request

    from cardvision.import_catalog.importer import _Failure, _HttpOnlyRedirects

    handler = _HttpOnlyRedirects()
    with pytest.raises(_Failure, match="from https to http refused"):
        handler.redirect_request(urllib.request.Request("https://cards.example/a.png"), None, 302, "Found", {},
                                 "http://cards.example/a.png")
    upgraded = handler.redirect_request(urllib.request.Request("http://cards.example/a.png"), None, 302, "Found", {},
                                        "https://cards.example/a.png")
    assert upgraded.full_url == "https://cards.example/a.png"


def test_every_request_uses_this_packages_certificates_even_after_a_redirect_to_https(monkeypatch):
    import ssl
    import urllib.request

    from cardvision.import_catalog import importer

    context = ssl.create_default_context()
    monkeypatch.setattr(importer, "tls_context", lambda: context)
    downloader = importer._Downloader(ImportOptions(game="toy"), importer.ImportReport(), lambda seconds: None)
    https = [handler for handler in downloader.opener.handlers if isinstance(handler, urllib.request.HTTPSHandler)]
    assert len(https) == 1 and https[0]._context is context


def test_a_number_column_with_a_leading_zero_stays_text_and_the_report_says_which_are_numbers(tmp_path):
    text = "id,name,number,cost\nA,One,008,3\nB,Two,12,1\n"
    report, out = _import(tmp_path, "cards.csv", text, facets=["number", "cost"])
    catalog = load_catalog(out)
    assert [(f.key, f.type) for f in catalog.facets] == [("number", "text"), ("cost", "number")]
    assert catalog.card("A").facets["number"] == ("008",)
    assert report.facets[0]["why"] == "a value has a leading zero (008)"
    assert "taken as numbers (every value is one): cost" in report.lines()


@pytest.mark.parametrize("suffix", [".xlsx", ".xls", ".numbers", ".ods", ".XLSX"])
def test_a_spreadsheet_file_is_refused_with_what_to_do(tmp_path, suffix):
    with pytest.raises(CatalogImportError) as refused:
        _import(tmp_path, f"cards{suffix}", "not read")
    assert str(refused.value) == (f"cards{suffix} is a spreadsheet file: export it as CSV (UTF-8) first, "
                                  "then import the .csv")


def test_a_semicolon_separated_csv_says_to_pass_a_delimiter(tmp_path):
    with pytest.raises(CatalogImportError, match=r"header looks semicolon-separated \('id;name'\): pass --delimiter ';'"):
        _import(tmp_path, "cards.csv", "id;name\nA;One\n")


def test_a_delimiter_reads_a_semicolon_csv(tmp_path):
    report, out = _import(tmp_path, "cards.csv", "id;name;cost\nA;One;3\nB;Two;1\n", delimiter=";")
    assert report.written and [card.name for card in load_catalog(out)] == ["One", "Two"]


def test_a_delimiter_is_for_csv_and_one_character_only(tmp_path):
    with pytest.raises(CatalogImportError, match="--delimiter is for CSV files only"):
        _import(tmp_path, "cards.tsv", "id\tname\nA\tOne\n", delimiter=";")
    with pytest.raises(CatalogImportError, match="one character"):
        _import(tmp_path, "cards.csv", "id,name\nA,One\n", delimiter=";;")


def test_the_command_line_takes_overwrite_and_delimiter_and_still_takes_force(tmp_path, capsys):
    source = _write(tmp_path / "cards.csv", "id;name\nA;One\n")
    out = tmp_path / "catalog.json"
    base = ["import-catalog", str(source), "--out", str(out), "--game", "toy"]
    assert cli.main(base) == 1 and "pass --delimiter ';'" in capsys.readouterr().err
    assert cli.main([*base, "--delimiter", ";"]) == 0
    assert cli.main([*base, "--delimiter", ";"]) == 1 and "--overwrite" in capsys.readouterr().err
    assert cli.main([*base, "--delimiter", ";", "--overwrite"]) == 0
    assert cli.main([*base, "--delimiter", ";", "--force"]) == 0
    cli.build_parser().parse_args([*base, "--overwrite"])
    with pytest.raises(SystemExit):
        cli.main(["import-catalog", "--help"])
    assert "--force" not in capsys.readouterr().out
