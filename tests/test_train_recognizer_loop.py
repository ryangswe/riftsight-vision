# SPDX-License-Identifier: Apache-2.0
"""The schedule, the step, checkpoint selection, and a short training run on the toy data
through the command line, followed by export and a bank built with the exported model.
Skipped without PyTorch and torchvision."""

from __future__ import annotations

import hashlib
import json
import math

import numpy as np
import pytest

torch = pytest.importorskip("torch")
pytest.importorskip("torchvision")

import support_train_recognizer as support  # noqa: E402
from cardvision import cli  # noqa: E402
from cardvision.train_recognizer import loop  # noqa: E402
from cardvision.train_recognizer import validate as V  # noqa: E402
from cardvision.train_recognizer.config import parse_config  # noqa: E402
from cardvision.train_recognizer.losses import NEGATIVE, NEGATIVE_BACK, ArcFace  # noqa: E402
from cardvision.train_recognizer.model import Encoder, StartError, read_start  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def one_thread():
    """Small batches on a CPU run faster on one thread than on many."""
    before = torch.get_num_threads()
    torch.set_num_threads(1)
    yield
    torch.set_num_threads(before)


@pytest.fixture(scope="module")
def toy(tmp_path_factory):
    return support.shared_toy_data(tmp_path_factory)


# ------------------------------------------------------------------------------ schedule
def test_the_learning_rate_rises_in_a_line_then_follows_half_a_cosine():
    warm, total = 30, 130
    assert loop.lr_factor(0, warm, total) == 0.0
    assert loop.lr_factor(15, warm, total) == 0.5
    assert loop.lr_factor(30, warm, total) == 1.0
    assert loop.lr_factor(80, warm, total) == pytest.approx(0.5)
    assert loop.lr_factor(55, warm, total) == pytest.approx(0.5 * (1 + math.cos(math.pi * 0.25)))
    assert loop.lr_factor(130, warm, total) == pytest.approx(0.0, abs=1e-12)
    factors = [loop.lr_factor(step, warm, total) for step in range(total + 1)]
    assert factors[:31] == sorted(factors[:31]) and factors[30:] == sorted(factors[30:], reverse=True)
    # No warm-up: the cosine starts at once.
    assert loop.lr_factor(0, 0, 100) == 1.0 and loop.lr_factor(50, 0, 100) == pytest.approx(0.5)


def test_the_scheduler_moves_the_optimizer_s_rate_once_per_step():
    parameter = torch.nn.Parameter(torch.zeros(1))
    optimizer = torch.optim.AdamW([parameter], lr=3e-4)
    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda step: loop.lr_factor(step, 2, 6))
    rates = []
    for _ in range(6):
        rates.append(optimizer.param_groups[0]["lr"])
        optimizer.step()
        scheduler.step()
    assert rates == pytest.approx([0.0, 1.5e-4, 3e-4, 3e-4 * 0.5 * (1 + math.cos(math.pi / 4)), 1.5e-4,
                                   3e-4 * 0.5 * (1 + math.cos(3 * math.pi / 4))])


# ----------------------------------------------------------------------------- selection
def test_the_grid_is_every_so_many_epochs_and_the_last():
    assert [epoch for epoch in range(1, 35) if V.on_grid(epoch, 34, 5)] == [5, 10, 15, 20, 25, 30, 34]
    assert [epoch for epoch in range(1, 11) if V.on_grid(epoch, 10, 5)] == [5, 10]
    assert [epoch for epoch in range(1, 4) if V.on_grid(epoch, 3, 5)] == [3]


def test_selection_keeps_the_best_half_and_half_score_and_the_later_epoch_on_a_tie():
    assert V.criterion(0.8, 0.4) == pytest.approx(0.6)
    selection = V.Selection()
    offers = [(5, 0.50, 0.50, True), (10, 0.90, 0.30, True), (15, 0.40, 0.80, True), (20, 0.59, 0.60, False),
              (25, 1.00, 0.00, False), (30, 0.70, 0.52, True), (34, 0.61, 0.60, False)]
    for epoch, seen, unseen, kept in offers:
        assert selection.offer(epoch, seen, unseen) is kept, epoch
    assert selection.best_epoch == 30 and selection.best == pytest.approx(0.61)
    assert selection.scores == {"epoch": 30, "top1Seen": 0.70, "top1Unseen": 0.52, "criterion": pytest.approx(0.61)}
    # A first offer of nothing right at all is still kept: there is always a best checkpoint.
    empty = V.Selection()
    assert empty.offer(5, 0.0, 0.0) and empty.best_epoch == 5


def test_top1_counts_crops_whose_nearest_clean_image_is_their_own_card():
    class Color(torch.nn.Module):
        """Embeds an image by its mean color: enough to tell flat-colored cards apart."""

        def forward(self, x):
            return torch.nn.functional.normalize(x.mean(dim=(2, 3)), dim=1)

    def flat(color, size=(40, 30)):
        return np.full((*size, 3), color, np.uint8)

    art = {"RED": flat((250, 20, 20)), "GREEN": flat((20, 250, 20)), "BLUE": flat((20, 20, 250))}
    prepare = lambda rgb: (rgb.astype(np.float32).transpose(2, 0, 1) / 255.0)  # noqa: E731

    def row(card_id, color):
        image = flat((128, 128, 128), (80, 60))
        image[20:60, 15:45] = color                                              # only the card's box holds the color
        return {"image": image, "inner": [15, 20, 30, 40], "card_id": card_id, "group": "g"}

    rows = [row("RED", (240, 30, 30)), row("GREEN", (30, 240, 30)), row("BLUE", (30, 30, 240)), row("RED", (30, 30, 240))]
    model = Color()
    assert V.top1(model, rows, list(art), art, "cpu", prepare) == 0.75
    assert V.top1(model, rows[:3], list(art), art, "cpu", prepare) == 1.0
    assert V.top1(model, rows[2:3], ["RED", "GREEN"], art, "cpu", prepare) == 0.0   # its card is not in the bank
    assert V.top1(model, [], list(art), art, "cpu", prepare) == 0.0
    assert np.array_equal(V.card_box(rows[0]), flat((240, 30, 30)))


def test_the_name_index_groups_printings_of_one_name():
    names = {"A1": "Apple", "A2": "Apple", "B1": "Berry", "C1": "Cherry"}
    assert loop.name_index_of(["B1", "A1", "C1", "A2"], names).tolist() == [1, 0, 2, 0]


# ---------------------------------------------------------------------------------- step
def make_step(refresh=50, back_margin=0.50, printing=None):
    torch.manual_seed(0)
    model = Encoder("random", dim=16)
    head = ArcFace(5, 16, 32.0, 0.2)
    optimizer = torch.optim.AdamW(list(model.parameters()) + list(head.parameters()), lr=1e-3)
    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda step: 1.0)
    cfg = parse_config({"data": {"catalog": "c", "art": "a"}, "epoch": {"base": 1},
                        "loss": {"bank_refresh_steps": refresh, "back_margin": back_margin}})["loss"]
    return loop.Step(model, head, optimizer, scheduler, cfg, torch.randn(6, 3, 128, 128), printing)


def test_a_step_updates_the_weights_and_refreshes_the_memory_bank_on_schedule():
    step = make_step(refresh=2)
    before = {name: value.clone() for name, value in step.model.state_dict().items()}
    crops, arts = torch.randn(6, 3, 128, 128), torch.randn(6, 3, 128, 128)
    labels = torch.tensor([0, 1, 2, 3, NEGATIVE, NEGATIVE_BACK])
    banks = []
    for _ in range(4):
        loss = step(crops, arts, labels)
        assert math.isfinite(loss) and loss > 0
        banks.append(step.bank)
    assert step.bank.shape == (6, 16) and not step.bank.requires_grad and step.model.training
    assert banks[0] is banks[1] and banks[1] is not banks[2] and banks[2] is banks[3]   # recomputed every 2 steps
    after = step.model.state_dict()
    assert any(not torch.equal(before[name], after[name]) for name in before if "weight" in name)
    assert step.stats["steps"] == 4 and step.stats["negatives"] == 8 and step.stats["backs"] == 4
    assert 0 <= step.stats["active"] <= 8


def test_a_step_copes_with_a_batch_of_one_kind_only():
    step = make_step()
    crops, arts = torch.randn(4, 3, 128, 128), torch.randn(4, 3, 128, 128)
    assert math.isfinite(step(crops, arts, torch.tensor([0, 1, 2, 2])))             # no negatives
    assert step.stats["negatives"] == 0
    assert math.isfinite(step(crops, torch.zeros_like(arts), torch.tensor([NEGATIVE] * 4)))   # negatives only
    assert step.stats["negatives"] == 4
    with_mask = make_step(printing=torch.tensor([0, 0, 1, 2, 3]))
    assert math.isfinite(with_mask(crops, arts, torch.tensor([0, 1, 2, NEGATIVE])))


# ------------------------------------------------------------------------ rigged selection
def test_the_trainer_keeps_the_checkpoint_of_the_best_grid_epoch(toy, tmp_path, monkeypatch):
    # Scores handed out in place of the real ones: seen then unseen, at the end of each epoch.
    script = iter([0.2, 0.2,      # epoch 1: 0.20
                   0.8, 0.4,      # epoch 2: 0.60
                   0.4, 0.8,      # epoch 3: 0.60, a tie: the later epoch wins
                   0.5, 0.5])     # epoch 4: 0.50
    snapshots = []

    def rigged(model, rows, bank_ids, art, device, prepare, root=None):
        snapshots.append({name: value.clone() for name, value in model.state_dict().items()})
        return next(script)

    monkeypatch.setattr(loop, "top1", rigged)
    cfg = parse_config(support.toy_document(toy, epochs=4, batch=4, epoch={"base": 8},
                                            validation={"every": 1, "at_start": False}))
    lines: list[str] = []
    result = loop.train(cfg, tmp_path / "run", device="cpu", log=lines.append)
    assert result["bestEpoch"] == 3 and result["bestCriterion"] == pytest.approx(0.6) and result["initial"] is None
    assert [entry["criterion"] for entry in result["curve"]] == pytest.approx([0.2, 0.6, 0.6, 0.5])
    best = torch.load(tmp_path / "run" / "best.pt", weights_only=True)
    last = torch.load(tmp_path / "run" / "last.pt", weights_only=True)
    assert best["epoch"] == 3 and last["epoch"] == 4 and best["scores"]["top1Unseen"] == 0.8
    at_epoch = {epoch: snapshots[2 * (epoch - 1)] for epoch in (1, 2, 3, 4)}       # the weights when each epoch was scored
    assert all(torch.equal(best["model"][name], at_epoch[3][name]) for name in best["model"])
    assert all(torch.equal(last["model"][name], at_epoch[4][name]) for name in last["model"])
    assert any(not torch.equal(best["model"][name], at_epoch[2][name]) for name in best["model"])
    assert any("best criterion 0.600 at epoch 3" in line for line in lines)
    # A run folder is not written over unless asked.
    with pytest.raises(FileExistsError):
        loop.train(cfg, tmp_path / "run", device="cpu", log=lines.append)


def test_off_grid_epochs_are_not_candidates(toy, tmp_path, monkeypatch):
    calls = []

    def rigged(model, rows, bank_ids, art, device, prepare, root=None):
        calls.append(len(rows))
        return 0.9 if len(calls) <= 2 else 0.1                                    # before training: 0.9; afterwards: 0.1

    monkeypatch.setattr(loop, "top1", rigged)
    cfg = parse_config(support.toy_document(toy, epochs=3, batch=4, epoch={"base": 8},
                                            validation={"every": 2, "at_start": True, "log_unseen_every_epoch": True}))
    result = loop.train(cfg, tmp_path / "run", device="cpu", log=lambda line: None)
    # Scored before training (never a candidate), at epoch 2 and at the last epoch; epoch 1 only logs the unseen set.
    assert result["initial"]["criterion"] == pytest.approx(0.9)
    assert [("criterion" in entry, "top1UnseenLogOnly" in entry) for entry in result["curve"]] == [
        (True, False), (False, True), (True, False), (True, False)]
    assert result["bestEpoch"] == 3 and result["bestCriterion"] == pytest.approx(0.1)
    assert len(calls) == 2 + 1 + 2 + 2


# ----------------------------------------------------------------------------- smoke run
def test_a_short_run_on_toy_data_then_export_and_a_bank(toy, tmp_path, capsys):
    """Two epochs from random weights on the CPU through the command line: the toy top-1
    after training beats the untrained encoder's, the checkpoint exports, and a bank is built
    with the exported model."""
    doc = support.toy_document(toy, epochs=5, batch=6, epoch={"base": 240},
                               validation={"unseen_count": 16, "every": 2, "at_start": True},
                               components={"pairs": True, "boost": True},
                               pairs={"per_batch": 1, "names": [["Amber Circle", "Azure Circle"], ["Coral Triangle", "Jade Triangle"]]},
                               boost={"share_kind": "site", "share": 0.15})
    config_path = tmp_path / "toy.toml"
    config_path.write_text(support.toml_text(doc), encoding="utf-8")
    run = tmp_path / "run"
    code = cli.main(["train-recognizer", "--config", str(config_path), "--out", str(run), "--init", "random",
                     "--device", "cpu", "--epochs", "2"])
    out = capsys.readouterr()
    assert code == 0, out.err

    record = json.loads((run / "run.json").read_text())
    before, after = record["result"]["initial"], record["result"]["best"]
    assert record["result"]["bestEpoch"] == 2 and after["criterion"] > before["criterion"]
    assert after["top1Seen"] > before["top1Seen"]

    # The run record: config, seeds, versions and the hash of every input.
    assert record["format"] == "cardvision-recognizer-run" and record["seed"] == 3 and record["dataSeed"] == 3
    assert record["config"]["epochs"] == 2 and record["config"]["model"]["init"] == "random"
    assert record["device"] == "cpu" and record["versions"]["torch"] == torch.__version__
    assert {"cardvision", "python", "torchvision", "numpy", "pillow"} <= set(record["versions"])
    inputs = record["inputs"]
    assert all(len(inputs[key]["sha256"]) == 64 for key in ("catalog", "art"))
    assert len(inputs["real"]["manifests"]["toy.manifest.jsonl"]) == 64 and len(inputs["composites"]["labelsSha256"]) == 64
    assert record["classes"] == 17 and record["sameNameClasses"] == 2 and record["memoryBankCards"] == 17
    assert record["validation"]["unseenCards"] == sorted(support.UNSEEN)
    assert record["validation"]["heldOutGroups"] == [support.HELD_OUT_GROUP] and record["validation"]["unseenRows"] == 16
    composition = record["composition"]
    assert composition["base"] == 240 and [s["rows"] for s in composition["segments"]] == [240, 72, 35, 30]
    assert composition["pairs"]["perEpoch"] > 0 and composition["boost"]["kindRows"] > 0
    assert record["stepsPerEpoch"] == composition["pairs"]["perEpoch"] and record["totalSteps"] == 2 * record["stepsPerEpoch"]
    curve = json.loads((run / "curve.json").read_text())
    assert [entry["epoch"] for entry in curve] == [0, 1, 2] and "criterion" not in curve[1]
    assert curve[2]["loss"] < curve[1]["loss"]
    assert (run / "log.txt").read_text().count("\n") >= 4 and (run / "last.pt").is_file()

    # The checkpoint holds weights and plain data only, so it loads in restricted mode.
    checkpoint = torch.load(run / "best.pt", weights_only=True)
    assert checkpoint["epoch"] == 2 and len(checkpoint["cards"]) == 17 and checkpoint["config"]["seed"] == 3
    assert set(name.split(".")[0] for name in checkpoint["model"]) == {"features", "proj", "bn"}

    # Export with the default network, then build a bank of the toy game with the exported model.
    exported = tmp_path / "exported"
    code = cli.main(["export", "recognizer", str(run / "best.pt"), "--out", str(exported)])
    out = capsys.readouterr()
    assert code == 0, out.err
    report = json.loads(out.out)
    assert report["parity"]["fp32"]["minCosine"] >= 0.9999 and report["output"]["shape"][0] == "batch"
    bank_path = tmp_path / "bank.json"
    code = cli.main(["build-bank", "--catalog", str(toy.catalog), "--art", str(toy.art),
                     "--recognizer", str(exported / "recognizer.onnx"), "--out", str(bank_path)])
    out = capsys.readouterr()
    assert code == 0, out.err
    bank = json.loads(bank_path.read_text())
    assert bank["entryCount"] == 20 and bank["dim"] == 128


def test_an_exported_encoder_gives_a_crop_the_same_looks_in_any_batch(toy, tmp_path, capsys):
    """What ``cardvision calibrate`` rests on. It embeds every crop's turned looks in one batch,
    where ``recognize`` embeds those of the crops whose upright look was not accepted, a set that
    changes with the thresholds. With the real network exported as usual, the two give the same
    looks to the last bit, whichever crops share a batch."""
    from cardvision.core.catalog import load_catalog
    from cardvision.core.images import load_rgb
    from cardvision.export.recognizer import export_recognizer
    from cardvision.recognize import AcceptRule, Recognizer

    torch.manual_seed(11)
    model = Encoder("random")
    model.train()
    with torch.no_grad():
        for _ in range(3):                         # running statistics other than the defaults
            model(torch.randn(8, 3, 128, 128))
    export_recognizer(model, tmp_path, "recognizer")
    bank_path = tmp_path / "bank.json"
    assert cli.main(["build-bank", "--catalog", str(toy.catalog), "--art", str(toy.art),
                     "--recognizer", str(tmp_path / "recognizer.onnx"), "--out", str(bank_path)]) == 0
    capsys.readouterr()
    catalog = load_catalog(toy.catalog)
    cards = [load_rgb(toy.art / f"TOY-{number:03d}.png") for number in range(1, 13)]
    gray = np.full_like(cards[0], 90)
    crops = [np.ascontiguousarray(np.rot90(card, index % 4)) if index % 3 else (0.6 * card + 0.4 * gray).astype(np.uint8)
             for index, card in enumerate(cards)]
    base = Recognizer.open(tmp_path / "recognizer.onnx", bank_path, catalog, AcceptRule(0.62, 0.05))
    looks = base.looks(crops)
    # Thresholds that fall between the crops' own upright scores and margins, so that the crops
    # whose turned looks ``recognize`` embeds are none, a few, most and all of them in turn.
    scores, margins = sorted(item[0].score for item in looks), sorted(item[0].margin for item in looks)
    rules = [AcceptRule((scores[k - 1] + scores[k]) / 2, 0.0) for k in (2, 5, 8, 11)]
    rules += [AcceptRule(scores[0] / 2, (margins[k - 1] + margins[k]) / 2) for k in (3, 6, 9)]
    rules += [AcceptRule(scores[0] / 2, 0.0), AcceptRule(1.0, 0.0), AcceptRule(0.62, 0.05)]
    retried = set()
    for rule in rules:
        expected = Recognizer.open(tmp_path / "recognizer.onnx", bank_path, catalog, rule).recognize(crops)
        found = [base.decide(item, rule) for item in looks]
        for got, want in zip(found, expected):
            assert (got.name, got.top_id, got.similarity, got.margin, got.look, got.retried, got.tau_passed,
                    got.accepted) == (want.name, want.top_id, want.similarity, want.margin, want.look, want.retried,
                                      want.tau_passed, want.accepted), rule
        retried.add(sum(item.retried for item in expected))
    # The comparison covered batches of several sizes: none of the crops retried, some, and all.
    assert {0, len(crops)} <= retried and len(retried) >= 6


# ------------------------------------------------------------- starting from a checkpoint
def one_step(toy, **over) -> dict:
    """A config whose epoch is one step of sixteen rows, so that an epoch's loss is a step's."""
    return support.toy_document(toy, epochs=2, batch=16, epoch={"base": 11},
                                validation={"unseen_count": 16, "every": 1, "at_start": True}, **over)


@pytest.fixture(scope="module")
def first_run(toy, tmp_path_factory):
    """Two steps from random weights: the run that others start from."""
    run = tmp_path_factory.mktemp("first-run") / "run"
    result = loop.train(parse_config(one_step(toy)), run, device="cpu", log=lambda line: None)
    assert result["stepsPerEpoch"] == 1
    return run, result


def test_a_run_starts_from_another_run_s_checkpoint_and_says_so(toy, first_run, tmp_path, monkeypatch):
    earlier, first = first_run
    start = earlier / "last.pt"
    digest = hashlib.sha256(start.read_bytes()).hexdigest()
    file = torch.load(start, weights_only=True)
    assert set(file) == {"model", "cards", "epoch", "scores", "config"}     # a start from a word records no "init"
    assert "init" not in json.loads((earlier / "run.json").read_text())

    # The weights the run holds when it is first scored, before any step.
    held = []
    top1 = loop.top1

    def watching(model, *args, **kwargs):
        if not held:
            held.append({name: value.clone() for name, value in model.state_dict().items()})
        return top1(model, *args, **kwargs)

    monkeypatch.setattr(loop, "top1", watching)
    lines: list[str] = []
    second = loop.train(parse_config(one_step(toy, model={"init": str(start)})), tmp_path / "second", device="cpu",
                        log=lines.append)
    monkeypatch.setattr(loop, "top1", top1)

    # Every tensor is the file's, and the scores before training are the earlier run's last.
    assert list(held[0]) == list(file["model"]) and len(held[0]) > 200
    assert all(torch.equal(held[0][name], file["model"][name]) for name in held[0])
    last = first["curve"][-1]
    assert (second["initial"]["top1Seen"], second["initial"]["top1Unseen"]) == (last["top1Seen"], last["top1Unseen"])

    # The first step's loss is not the loss of a start from random weights ...
    assert second["stepsPerEpoch"] == 1 and second["curve"][1]["loss"] != first["curve"][1]["loss"]

    # ... it is the loss of that run with the encoder's weights replaced by the file's.
    def replaced(init="random", dim=128):
        model = Encoder(init, dim)
        model.load_state_dict(torch.load(start, weights_only=True)["model"])
        return model

    monkeypatch.setattr(loop, "Encoder", replaced)
    by_hand = loop.train(parse_config(one_step(toy)), tmp_path / "by-hand", device="cpu", log=lambda line: None)
    monkeypatch.setattr(loop, "Encoder", Encoder)
    assert [entry["loss"] for entry in by_hand["curve"][1:]] == [entry["loss"] for entry in second["curve"][1:]]
    assert by_hand["initial"] == second["initial"]

    # Where it started from: the log, the record and both checkpoints, with the file's hash.
    origin = {"init": "last.pt", "sha256": digest, "copiedTensors": len(file["model"])}
    assert f"started from last.pt (SHA-256 {digest}): the encoder's {len(file['model'])} tensors" in "\n".join(lines)
    assert f"started from last.pt (SHA-256 {digest})" in (tmp_path / "second" / "log.txt").read_text()
    record = json.loads((tmp_path / "second" / "run.json").read_text())
    assert record["init"] == origin and record["config"]["model"]["init"] == str(start)
    for name in ("best.pt", "last.pt"):
        written = torch.load(tmp_path / "second" / name, weights_only=True)      # still plain data: restricted mode
        assert written["init"] == origin and set(written) == {"model", "cards", "epoch", "scores", "config", "init"}
    # Nothing but the weights came from the file: the step count and the schedule start over.
    assert record["totalSteps"] == 2 and [entry["epoch"] for entry in second["curve"]] == [0, 1, 2]
    assert not torch.equal(written["model"]["proj.weight"], file["model"]["proj.weight"])       # and it trained on
    # The run started by hand, from the word, records no origin.
    assert "init" not in json.loads((tmp_path / "by-hand" / "run.json").read_text())


def test_the_safetensors_form_starts_a_run_too(toy, first_run, tmp_path, capsys):
    earlier, _ = first_run
    assert cli.main(["export", "recognizer", str(earlier / "last.pt"), "--out", str(tmp_path / "exported")]) == 0
    capsys.readouterr()
    weights = tmp_path / "exported" / "recognizer.safetensors"
    file = torch.load(earlier / "last.pt", weights_only=True)["model"]
    state, origin = read_start(weights)
    assert origin == {"init": "recognizer.safetensors", "sha256": hashlib.sha256(weights.read_bytes()).hexdigest(),
                      "copiedTensors": len(file)}
    assert set(state) == set(file) and all(torch.equal(state[name], file[name]) for name in file)
    # Reading the start leaves PyTorch's random state alone, so the run's own draws do not move.
    torch.manual_seed(5)
    before = torch.rand(3)
    torch.manual_seed(5)
    read_start(earlier / "last.pt")
    assert torch.equal(torch.rand(3), before)

    config_path = tmp_path / "toy.toml"
    config_path.write_text(support.toml_text(one_step(toy)), encoding="utf-8")
    code = cli.main(["train-recognizer", "--config", str(config_path), "--out", str(tmp_path / "run"), "--init",
                     str(weights), "--device", "cpu", "--epochs", "1"])
    out = capsys.readouterr()
    assert code == 0, out.err
    assert f"started from recognizer.safetensors (SHA-256 {origin['sha256']})" in out.out
    record = json.loads((tmp_path / "run" / "run.json").read_text())
    assert record["init"] == origin and record["config"]["model"]["init"] == str(weights.resolve())


def test_a_checkpoint_that_does_not_fit_is_refused_whole(toy, first_run, tmp_path, capsys):
    earlier, _ = first_run
    file = torch.load(earlier / "last.pt", weights_only=True)["model"]
    names = list(file)

    def saved(name: str, state) -> str:
        torch.save({"model": state}, tmp_path / name)
        return str(tmp_path / name)

    # Another embedding width: the first tensor of another shape is named, with both shapes.
    with pytest.raises(StartError, match=r"last.pt does not fit the encoder: proj.weight has shape \(128, 576\) in the "
                                         r"file and \(64, 576\) in the encoder"):
        read_start(earlier / "last.pt", dim=64)
    torch.manual_seed(1)
    narrow = saved("narrow.pt", Encoder("random", dim=64).state_dict())
    with pytest.raises(StartError, match=r"narrow.pt does not fit the encoder: proj.weight has shape \(64, 576\)"):
        read_start(narrow)
    # A tensor short, a tensor too many, and a file of something else.
    with pytest.raises(StartError, match=r"short.pt does not fit the encoder: it has no tensor bn.running_var \(1 of"):
        read_start(saved("short.pt", {name: value for name, value in file.items() if name != "bn.running_var"}))
    with pytest.raises(StartError, match=r"long.pt does not fit the encoder: it has 1 tensor\(s\) the encoder lacks, "
                                         r"the first being head.weight"):
        read_start(saved("long.pt", {**file, "head.weight": torch.zeros(3)}))
    with pytest.raises(StartError, match=rf"other.pt does not fit the encoder: it has no tensor {names[0]} "
                                         rf"\({len(names)} of the encoder's {len(names)} tensors are missing\)"):
        read_start(saved("other.pt", {"backbone.stem.conv.weight": torch.zeros(4)}))
    torch.save({"note": "no weights here"}, tmp_path / "empty.pt")
    with pytest.raises(StartError, match="empty.pt cannot be read as a recognizer checkpoint: no weights found"):
        read_start(tmp_path / "empty.pt")
    (tmp_path / "text.pt").write_text("not a checkpoint", encoding="utf-8")
    with pytest.raises(StartError, match="text.pt cannot be read as a recognizer checkpoint"):
        read_start(tmp_path / "text.pt")
    with pytest.raises(StartError, match="absent.pt: no such checkpoint file"):
        read_start(tmp_path / "absent.pt")

    # Through the command line: reported, and the run stops before any data is prepared.
    config_path = tmp_path / "toy.toml"
    config_path.write_text(support.toml_text(one_step(toy)), encoding="utf-8")
    base = ["train-recognizer", "--config", str(config_path), "--device", "cpu"]
    assert cli.main([*base, "--out", str(tmp_path / "run"), "--init", narrow]) == 2
    out = capsys.readouterr()
    assert "narrow.pt does not fit the encoder: proj.weight has shape (64, 576) in the file" in out.err
    assert "card images" not in out.out and not (tmp_path / "run" / "run.json").exists()
    assert cli.main([*base, "--out", str(tmp_path / "run"), "--init", str(tmp_path / "absent.pt")]) == 2
    assert "absent.pt: no such checkpoint file" in capsys.readouterr().err
    assert cli.main([*base, "--out", str(tmp_path / "run"), "--init", "pretrained"]) == 2
    assert '--init must be "imagenet", "random" or the path of a checkpoint to start from' in capsys.readouterr().err


def test_the_command_reports_what_is_wrong(tmp_path, capsys, toy):
    assert "train-recognizer" in cli.SUBCOMMANDS
    assert cli.main(["train-recognizer", "--config", str(tmp_path / "missing.toml"), "--out", str(tmp_path / "run")]) == 2
    assert "no such config file" in capsys.readouterr().err
    path = tmp_path / "bad.toml"
    path.write_text('[data]\ncatalog = "c.json"\nart = "art"\n', encoding="utf-8")
    assert cli.main(["train-recognizer", "--config", str(path), "--out", str(tmp_path / "run")]) == 2
    assert "[epoch] base is required" in capsys.readouterr().err
    path.write_text(support.toml_text(support.toy_document(toy, epoch={"base": 2})), encoding="utf-8")
    assert cli.main(["train-recognizer", "--config", str(path), "--out", str(tmp_path / "run"), "--device", "cpu"]) == 2
    assert "does not fill one batch" in capsys.readouterr().err
    assert cli.main(["train-recognizer", "--config", str(path), "--out", str(tmp_path / "run"), "--epochs", "0"]) == 2
    assert "--epochs must be at least 1" in capsys.readouterr().err
