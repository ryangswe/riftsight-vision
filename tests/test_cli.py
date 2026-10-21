# SPDX-License-Identifier: Apache-2.0
"""The command line entry point."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import pytest

import cardvision
from cardvision import cli

ROOT = Path(__file__).resolve().parents[1]


def test_with_no_arguments_it_lists_the_subcommands(monkeypatch, capsys):
    monkeypatch.setattr(cli, "SUBCOMMANDS", {})
    assert cli.main([]) == 0
    out = capsys.readouterr().out
    assert f"cardvision {cardvision.__version__}" in out
    assert "Available subcommands: none yet." in out


def test_version_flag(capsys):
    with pytest.raises(SystemExit) as exit_info:
        cli.main(["--version"])
    assert exit_info.value.code == 0
    assert capsys.readouterr().out.strip() == f"cardvision {cardvision.__version__}"


def test_an_unknown_subcommand_is_refused(capsys):
    with pytest.raises(SystemExit) as exit_info:
        cli.main(["no-such-command"])
    assert exit_info.value.code != 0


def test_a_registered_subcommand_is_listed_and_run(monkeypatch, capsys):
    seen = {}

    def add_arguments(parser):
        parser.add_argument("--times", type=int, default=1)

    def run(args):
        seen["times"] = args.times
        return 3

    monkeypatch.setattr(cli, "SUBCOMMANDS", {"echo": ("Repeat a greeting.", add_arguments, run)})
    assert cli.main(["echo", "--times", "2"]) == 3 and seen == {"times": 2}
    assert cli.main([]) == 0
    assert "echo  Repeat a greeting." in capsys.readouterr().out


# The subcommands this package has had since its tools were put together. Others may be added;
# none of these may go missing from the listing.
SUBCOMMANDS = ("assign-roles", "build-bank", "build-release", "check-refresh", "export", "fetch", "fetch-textures",
               "infer", "make-composites", "train-detector", "train-recognizer", "validate-manifest", "verify-release")


def test_with_no_arguments_every_registered_subcommand_is_listed(capsys):
    assert set(SUBCOMMANDS) <= set(cli.SUBCOMMANDS)
    assert cli.main([]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[:2] == [f"cardvision {cardvision.__version__}", "Available subcommands:"]
    listed = {line.split()[0]: line for line in lines[2:] if line.startswith("  ")}  # the rest are group headings
    assert sorted(listed) == sorted(cli.SUBCOMMANDS)
    for name, (summary, _add, _run) in cli.SUBCOMMANDS.items():
        assert listed[name].endswith(summary)


def test_every_registered_command_is_in_exactly_one_group():
    grouped = [name for _title, names in cli.GROUPS for name in names]
    assert len(grouped) == len(set(grouped)), "a command is in two groups"
    assert sorted(grouped) == sorted(cli.SUBCOMMANDS)
    assert [title for title, _names in cli.GROUPS] == ["Start here", "Train", "Measure", "Data"]


def test_the_listing_and_the_help_epilog_show_the_groups_in_order(capsys):
    assert cli.main([]) == 0
    out = capsys.readouterr().out
    positions = [out.index(f"{title}:") for title in ("Start here", "Train", "Measure", "Data")]
    assert positions == sorted(positions) and "Other:" not in out
    assert cli.build_parser().epilog == cli.available_subcommands()


@pytest.mark.parametrize("name", sorted(cli.SUBCOMMANDS))
def test_every_subcommand_explains_itself(name, capsys):
    """``--help`` works for each subcommand, and every option says what it is for."""
    with pytest.raises(SystemExit) as exit_info:
        cli.main([name, "--help"])
    assert exit_info.value.code == 0
    out = capsys.readouterr().out
    assert out.startswith(f"usage: cardvision {name}") and cli.SUBCOMMANDS[name][0] in " ".join(out.split())
    parser = cli.build_parser()
    children = next(action for action in parser._actions if isinstance(action, argparse._SubParsersAction)).choices
    for action in children[name]._actions:
        if action.option_strings and action.option_strings != ["-h", "--help"]:
            assert action.help, f"{name} {action.option_strings[0]} has no help text"


def test_python_dash_m_runs_the_same_program():
    done = subprocess.run([sys.executable, "-m", "cardvision"], capture_output=True, text=True, cwd=ROOT)
    assert done.returncode == 0, done.stderr
    assert "Available subcommands:" in done.stdout
