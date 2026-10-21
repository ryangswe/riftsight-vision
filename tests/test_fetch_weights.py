# SPDX-License-Identifier: Apache-2.0
"""``cardvision fetch-weights``, against a server on this machine. The server holds a toy
release, so the final ``verify-release`` is the real one. No test here uses the network."""

from __future__ import annotations

import hashlib
import http.server
import sys
import os
import threading
import time
from pathlib import Path

import pytest

from cardvision import fetch_weights as F
from cardvision import release_assets as R
from cardvision.cli import main

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_browser_fixtures import write_demo  # noqa: E402


class Site:
    """A local HTTP server with a table of pages, counting the requests."""

    def __init__(self) -> None:
        self.pages: dict[str, bytes] = {}
        self.requests: list[str] = []
        self.agents: set[str] = set()
        self.redirects: dict[str, str] = {}
        self.cut: set[str] = set()
        self.drip: set[str] = set()
        site = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                site.requests.append(self.path)
                site.agents.add(self.headers.get("User-Agent", ""))
                if self.path in site.redirects:
                    self.send_response(302)
                    self.send_header("Location", site.redirects[self.path])
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = site.pages.get(self.path)
                if self.path in site.drip and body:  # one byte every 0.2 s
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    for index in range(len(body)):
                        self.wfile.write(body[index:index + 1])
                        self.wfile.flush()
                        time.sleep(0.2)
                    return
                if self.path in site.cut and body:  # promise the whole body, send half, hang up
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body[: len(body) // 2])
                    self.close_connection = True
                    return
                self.send_response(200 if body is not None else 404)
                self.send_header("Content-Length", str(len(body or b"")))
                self.end_headers()
                self.wfile.write(body or b"")

            def log_message(self, *args) -> None:
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.handle_error = lambda *args: None  # a client that hangs up is expected here
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/rel/"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


@pytest.fixture
def site():
    server = Site()
    yield server
    server.close()


@pytest.fixture(scope="module")
def toy_release(tmp_path_factory) -> dict[str, bytes]:
    """The files of a toy release, plus a SHA256SUMS listing them."""
    root = tmp_path_factory.mktemp("toy")
    write_demo(root / "demo")
    files = {path.name: path.read_bytes() for path in (root / "demo" / "release").iterdir()}
    files[R.SUMS_NAME] = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in files.items()).encode()
    return files


def table(files: dict[str, bytes]) -> tuple[R.Asset, ...]:
    return tuple(R.Asset(name, len(data), hashlib.sha256(data).hexdigest()) for name, data in files.items())


@pytest.fixture
def served(site, toy_release, monkeypatch):
    for name, data in toy_release.items():
        site.pages[f"/rel/{name}"] = data
    monkeypatch.setattr(R, "ASSETS", table(toy_release))
    monkeypatch.setattr(R, "BASE_URL", site.base)
    return site


def test_the_happy_path_downloads_checks_and_verifies(served, toy_release, tmp_path, capsys):
    assert main(["fetch-weights", str(tmp_path / "w")]) == 0
    out = capsys.readouterr().out
    assert out.startswith(f"downloading {len(toy_release)} files (about ")
    assert f"from {served.base} into {tmp_path / 'w'}" in out.splitlines()[0]
    assert "ok (" in out and "every file present, unchanged and consistent" in out
    for name, data in toy_release.items():
        assert (tmp_path / "w" / name).read_bytes() == data
    assert not list((tmp_path / "w").glob(".*.part"))
    assert len(served.requests) == len(toy_release)
    assert served.requests[0].endswith(R.SUMS_NAME)  # the sums file comes first
    assert all(agent.startswith("cardvision/") for agent in served.agents)


def test_a_second_run_resumes_and_asks_for_nothing(served, toy_release, tmp_path, capsys):
    dest = tmp_path / "w"
    assert main(["fetch-weights", str(dest)]) == 0
    (dest / "bank.json").unlink()
    served.requests.clear()
    capsys.readouterr()
    assert main(["fetch-weights", str(dest)]) == 0
    assert served.requests == ["/rel/bank.json"]
    assert "downloading 1 file (" in capsys.readouterr().out
    served.requests.clear()
    assert main(["fetch-weights", str(dest)]) == 0
    assert served.requests == []


def test_a_wrong_hash_is_refused_and_nothing_is_left(served, toy_release, tmp_path, capsys):
    served.pages["/rel/catalog.json"] = toy_release["catalog.json"] + b" "
    dest = tmp_path / "w"
    assert main(["fetch-weights", str(dest)]) == 1
    err = capsys.readouterr().err
    assert "catalog.json" in err and "was not written" in err
    assert not (dest / "catalog.json").exists()
    assert not [p for p in dest.iterdir() if p.name.startswith(".")]


def test_a_different_file_is_not_replaced_without_overwrite(served, toy_release, tmp_path, capsys):
    dest = tmp_path / "w"
    dest.mkdir()
    (dest / "bank.json").write_text("mine")
    assert main(["fetch-weights", str(dest)]) == 1
    assert "--overwrite" in capsys.readouterr().err
    assert served.requests == [] and (dest / "bank.json").read_text() == "mine"
    assert main(["fetch-weights", str(dest), "--overwrite"]) == 0
    assert (dest / "bank.json").read_bytes() == toy_release["bank.json"]


def test_sums_that_disagree_with_the_pins_stop_the_run(served, toy_release, tmp_path, capsys, monkeypatch):
    other = dict(toy_release)
    other[R.SUMS_NAME] = other[R.SUMS_NAME].replace(hashlib.sha256(other["bank.json"]).hexdigest().encode(), b"0" * 64)
    served.pages[f"/rel/{R.SUMS_NAME}"] = other[R.SUMS_NAME]
    monkeypatch.setattr(R, "ASSETS", table(other))
    assert main(["fetch-weights", str(tmp_path / "w")]) == 1
    assert "bank.json" in capsys.readouterr().err
    assert served.requests == [f"/rel/{R.SUMS_NAME}"]


def test_list_makes_no_request(served, tmp_path, capsys):
    assert main(["fetch-weights", str(tmp_path / "w"), "--list"]) == 0
    out = capsys.readouterr().out
    assert served.requests == [] and not (tmp_path / "w").exists()
    assert all(f"{served.base}{asset.name}" in out for asset in R.ASSETS)


def test_the_shipped_list_names_eight_files_and_the_real_addresses(capsys):
    assert main(["fetch-weights", "unused", "--list"]) == 0
    out = capsys.readouterr().out
    assert len(R.ASSETS) == 8
    assert f"{R.BASE_URL}detector.onnx" in out and "about 8.5 MB" in out


def test_an_unreachable_host_names_the_address(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(R, "BASE_URL", "http://127.0.0.1:9/rel/")  # nothing listens on the discard port
    assert main(["fetch-weights", str(tmp_path / "w")]) == 1
    err = capsys.readouterr().err
    assert f"http://127.0.0.1:9/rel/{R.SUMS_NAME}" in err and "could not fetch" in err
    assert not list((tmp_path / "w").iterdir())


def test_a_planted_part_link_is_not_followed(served, toy_release, tmp_path):
    victim = tmp_path / "victim.txt"
    victim.write_text("keep me")
    dest = tmp_path / "w"
    dest.mkdir()
    (dest / ".bank.json.part").symlink_to(victim)
    assert main(["fetch-weights", str(dest)]) == 0
    assert victim.read_text() == "keep me"
    final = dest / "bank.json"
    assert final.is_file() and not final.is_symlink() and final.read_bytes() == toy_release["bank.json"]


def test_a_cut_short_body_is_refused(served, toy_release, tmp_path, capsys):
    served.cut.add("/rel/bank.json")
    dest = tmp_path / "w"
    assert main(["fetch-weights", str(dest)]) == 1
    err = capsys.readouterr().err
    assert "bank.json" in err and not (dest / "bank.json").exists()
    assert not [p for p in dest.iterdir() if p.name.startswith(".")]


def test_a_body_far_larger_than_the_pin_is_refused_after_the_cap(served, toy_release, tmp_path, capsys, monkeypatch):
    served.pages["/rel/accept.json"] = b"x" * 5_000_000
    assert main(["fetch-weights", str(tmp_path / "w")]) == 1
    assert "accept.json" in capsys.readouterr().err and not (tmp_path / "w" / "accept.json").exists()


def test_http_404_names_the_address(served, tmp_path, capsys):
    del served.pages["/rel/catalog.json"]
    assert main(["fetch-weights", str(tmp_path / "w")]) == 1
    err = capsys.readouterr().err
    assert f"{served.base}catalog.json" in err and "404" in err


def test_a_failed_write_leaves_no_part_file_and_keeps_the_old_one(served, toy_release, tmp_path, capsys, monkeypatch):
    dest = tmp_path / "w"
    dest.mkdir()
    (dest / "bank.json").write_text("mine")

    def broken(source, target):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(os, "replace", broken)
    assert main(["fetch-weights", str(dest), "--overwrite"]) == 1
    assert "cannot write" in capsys.readouterr().err
    assert (dest / "bank.json").read_text() == "mine"
    assert not [p for p in dest.iterdir() if p.name.startswith(".")]


def test_a_folder_that_is_a_file_is_a_clean_error(served, tmp_path, capsys):
    target = tmp_path / "file"
    target.write_text("x")
    assert main(["fetch-weights", str(target)]) == 1
    err = capsys.readouterr().err
    assert "cannot create" in err and str(target) in err


def test_a_redirect_within_the_site_is_followed(served, toy_release, tmp_path):
    served.pages["/elsewhere/accept.json"] = toy_release["accept.json"]
    served.redirects["/rel/accept.json"] = "/elsewhere/accept.json"
    assert main(["fetch-weights", str(tmp_path / "w")]) == 0


def test_a_redirect_away_from_http_is_refused(served, tmp_path, capsys):
    served.redirects["/rel/accept.json"] = "file:///etc/passwd"
    assert main(["fetch-weights", str(tmp_path / "w")]) == 1
    assert "redirect" in capsys.readouterr().err


def test_a_redirect_from_https_down_to_http_is_refused():
    import urllib.request

    handler = F._HttpOnlyRedirects()
    request = urllib.request.Request("https://host.example/a")
    with pytest.raises(F.FetchWeightsError, match="https to http"):
        handler.redirect_request(request, None, 302, "Found", {}, "http://host.example/a")
    assert handler.redirect_request(request, None, 302, "Found", {}, "https://other.example/a") is not None


def test_a_slow_server_is_cut_off_at_the_deadline(served, tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(F, "MIN_DEADLINE", 1.0)
    served.drip.add(f"/rel/{R.SUMS_NAME}")
    dest = tmp_path / "w"
    started = time.monotonic()
    assert main(["fetch-weights", str(dest)]) == 1
    assert time.monotonic() - started < 3
    assert "too slow" in capsys.readouterr().err
    assert not [p for p in dest.iterdir()]


def test_downloaded_files_follow_the_umask_not_the_private_temp_mode(served, tmp_path, monkeypatch):
    monkeypatch.setattr(F, "_UMASK", 0o022)
    dest = tmp_path / "w"
    assert main(["fetch-weights", str(dest)]) == 0
    assert (dest / "bank.json").stat().st_mode & 0o777 == 0o644


def test_an_empty_dir_is_refused_before_any_request(served, tmp_path, capsys, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert main(["fetch-weights", ""]) == 1
    err = capsys.readouterr().err
    assert "DIR is empty" in err and '"$HOME/Downloads/cardvision-weights"' in err
    assert served.requests == [] and list(tmp_path.iterdir()) == []


def test_a_dir_inside_the_repository_is_refused(served, capsys):
    root = Path(__file__).resolve().parents[1]
    for given in (str(root), str(root / "weights-here")):
        assert main(["fetch-weights", given]) == 1
        err = capsys.readouterr().err
        assert "lies inside the repository" in err and '"$HOME/Downloads/cardvision-weights"' in err
    assert served.requests == [] and not (root / "weights-here").exists()


def test_a_dir_at_the_top_of_the_file_system_hints_at_an_empty_variable(served, capsys):
    assert main(["fetch-weights", "/no-such-cardvision-weights"]) == 1
    err = capsys.readouterr().err
    assert "shell variable is empty" in err and served.requests == []
