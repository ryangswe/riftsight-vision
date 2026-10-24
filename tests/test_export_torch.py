# SPDX-License-Identifier: Apache-2.0
"""Checkpoint to ONNX and safetensors, on small throwaway networks. Skipped without PyTorch."""

from __future__ import annotations

import json
import sys

import numpy as np
import pytest

torch = pytest.importorskip("torch")
pytest.importorskip("safetensors")
pytest.importorskip("onnx")

import onnx  # noqa: E402
from torch import nn  # noqa: E402

from cardvision import cli  # noqa: E402
from cardvision.core.onnx import create_session  # noqa: E402
from cardvision.export import checkpoint as ckpt  # noqa: E402
from cardvision.export import detector as detector_export  # noqa: E402
from cardvision.export import recognizer as recognizer_export  # noqa: E402
from cardvision.export.torch_export import ParityError, claim_outputs, sha256_of  # noqa: E402


class ToyRecognizer(nn.Module):
    """Convolution, pooling, projection, unit length: the shape of an embedding network."""

    def __init__(self) -> None:
        super().__init__()
        self.conv = nn.Conv2d(3, 8, kernel_size=3, stride=2, padding=1)
        self.norm = nn.BatchNorm2d(8)
        self.project = nn.Linear(8, 128)

    def forward(self, x):
        x = torch.relu(self.norm(self.conv(x)))
        x = x.mean(dim=(2, 3))
        return nn.functional.normalize(self.project(x), dim=1)


class ToyHead(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.decode_in_inference = False
        self.predict = nn.Conv2d(3, 7, kernel_size=32, stride=32)

    def forward(self, x):
        rows = self.predict(x).flatten(2).transpose(1, 2)            # (1, 240, 7)
        if not self.decode_in_inference:
            return rows
        boxes = rows[..., :4].abs() + 1.0
        return torch.cat([boxes, torch.sigmoid(rows[..., 4:])], dim=-1)


class ToyDetector(nn.Module):
    """One convolution per 32 x 32 cell, with a head that decodes only when told to."""

    def __init__(self) -> None:
        super().__init__()
        self.head = ToyHead()

    def forward(self, x):
        return self.head(x / 255.0)


def build_toy_recognizer() -> nn.Module:
    torch.manual_seed(0)
    model = ToyRecognizer()
    with torch.no_grad():
        model.norm.running_mean.uniform_(-0.2, 0.2)
        model.norm.running_var.uniform_(0.5, 1.5)
    return model


def build_toy_detector() -> nn.Module:
    torch.manual_seed(0)
    return ToyDetector()


class NotATensor:
    """Something a restricted checkpoint load must refuse."""


# ----------------------------------------------------------------------------- recognizer


def test_export_recognizer_writes_four_files_and_a_report(tmp_path):
    model = build_toy_recognizer()
    report = recognizer_export.export_recognizer(model, tmp_path / "out", "toy")
    names = sorted(path.name for path in (tmp_path / "out").iterdir())
    assert names == ["toy-fp16w.onnx", "toy.export.json", "toy.onnx", "toy.safetensors"]
    assert json.loads((tmp_path / "out" / "toy.export.json").read_text()) == json.loads(json.dumps(report))

    assert report["kind"] == "recognizer" and report["opset"] == 17
    assert report["input"] == {"name": "crops", "shape": ["batch", 3, 128, 128], "dtype": "float32"}
    assert report["output"]["name"] == "embeddings" and report["output"]["shape"][0] == "batch"
    assert report["fp32"]["sha256"] == sha256_of(tmp_path / "out" / "toy.onnx")
    assert report["fp16Weights"]["bytes"] < report["fp32"]["bytes"]
    assert report["safetensors"]["tensors"] == len(model.state_dict())
    assert report["parity"]["fp32"]["required"] == 0.9999 and report["parity"]["fp32"]["minCosine"] >= 0.9999
    assert report["parity"]["fp16Weights"]["required"] == 0.999 and report["parity"]["fp16Weights"]["minCosine"] >= 0.999
    assert set(report["environment"]) == {"machine", "system", "python", "torch", "onnx", "onnxruntime"}


def test_the_exported_recognizer_matches_pytorch_at_any_batch_size(tmp_path):
    model = build_toy_recognizer()
    recognizer_export.export_recognizer(model, tmp_path, "toy")
    exported = onnx.load(str(tmp_path / "toy.onnx"))
    assert [(o.domain, o.version) for o in exported.opset_import] == [("", 17)]
    session = create_session(tmp_path / "toy.onnx")
    assert session.get_inputs()[0].name == "crops" and session.get_outputs()[0].name == "embeddings"
    for batch in (1, 5):
        x = np.random.default_rng(batch).standard_normal((batch, 3, 128, 128)).astype(np.float32)
        with torch.no_grad():
            expected = model.eval()(torch.from_numpy(x)).numpy()
        np.testing.assert_allclose(session.run(None, {"crops": x})[0], expected, atol=1e-5)


def test_the_model_is_exported_in_inference_mode(tmp_path):
    model = build_toy_recognizer().train()
    recognizer_export.export_recognizer(model, tmp_path, "toy")
    assert model.training is False


def test_safetensors_holds_the_weights_and_loads_back(tmp_path):
    from safetensors.torch import load_file

    model = build_toy_recognizer()
    recognizer_export.export_recognizer(model, tmp_path, "toy")
    stored = load_file(str(tmp_path / "toy.safetensors"))
    assert set(stored) == set(model.state_dict())
    for name, value in model.state_dict().items():
        assert torch.equal(stored[name], value), name
    again = ToyRecognizer()
    again.load_state_dict(ckpt.load_checkpoint(tmp_path / "toy.safetensors"))
    x = torch.zeros(2, 3, 128, 128)
    with torch.no_grad():
        assert torch.equal(again.eval()(x), model(x))


def test_existing_files_are_not_replaced_unless_asked(tmp_path):
    model = build_toy_recognizer()
    recognizer_export.export_recognizer(model, tmp_path, "toy")
    before = sha256_of(tmp_path / "toy.onnx")
    with pytest.raises(FileExistsError, match="refusing to overwrite .*toy.onnx"):
        recognizer_export.export_recognizer(model, tmp_path, "toy")
    recognizer_export.export_recognizer(model, tmp_path, "toy", overwrite=True)
    assert sha256_of(tmp_path / "toy.onnx") == before
    recognizer_export.export_recognizer(model, tmp_path, "other")          # another name is free


def test_missing_the_tolerance_is_an_error_and_leaves_no_report(tmp_path):
    with pytest.raises(ParityError, match="lowest cosine against PyTorch"):
        recognizer_export.export_recognizer(build_toy_recognizer(), tmp_path, "toy", min_cosine=1.5)
    assert (tmp_path / "toy.onnx").exists() and not (tmp_path / "toy.export.json").exists()
    with pytest.raises(ParityError, match="toy-fp16w.onnx"):
        recognizer_export.export_recognizer(build_toy_recognizer(), tmp_path, "toy", overwrite=True, min_cosine_fp16=1.5)


def test_row_cosines():
    a = np.array([[1.0, 0.0], [1.0, 1.0], [2.0, 0.0]])
    b = np.array([[2.0, 0.0], [1.0, 0.0], [0.0, 3.0]])
    np.testing.assert_allclose(recognizer_export.row_cosines(a, b), [1.0, np.sqrt(0.5), 0.0])


def test_claim_outputs(tmp_path):
    claim_outputs([tmp_path / "new" / "a.onnx"], overwrite=False)
    assert (tmp_path / "new").is_dir()
    (tmp_path / "new" / "a.onnx").write_bytes(b"x")
    with pytest.raises(FileExistsError):
        claim_outputs([tmp_path / "new" / "a.onnx", tmp_path / "new" / "b.onnx"], overwrite=False)
    claim_outputs([tmp_path / "new" / "a.onnx"], overwrite=True)


# ----------------------------------------------------------------------------- detector


def test_export_detector_without_the_half_precision_copy(tmp_path):
    report = detector_export.export_detector(build_toy_detector(), tmp_path, "toy", fp16_weights_copy=False)
    assert sorted(path.name for path in tmp_path.iterdir()) == ["toy.export.json", "toy.onnx", "toy.safetensors"]
    assert report["fp16Weights"] is None and report["parity"]["fp16Weights"] is None
    assert report["parity"]["fp32"]["scoreDifference"] <= report["parity"]["fp32"]["allowedScoreDifference"]


def test_export_detector_writes_the_decoded_graph(tmp_path):
    model = build_toy_detector()
    assert model.head.decode_in_inference is False
    report = detector_export.export_detector(model, tmp_path, "toy")
    assert model.head.decode_in_inference is True                 # switched on for the export
    assert sorted(path.name for path in tmp_path.iterdir()) == ["toy-fp16w.onnx", "toy.export.json", "toy.onnx", "toy.safetensors"]
    assert report["kind"] == "detector" and report["opset"] == 13
    assert report["input"]["name"] == "images" and report["input"]["shape"] == [1, 3, 384, 640]
    assert report["output"]["name"] == "output" and report["output"]["shape"] == [1, 240, 7]
    assert report["output"]["columns"] == ["cx", "cy", "w", "h", "obj", "cls_face", "cls_back"]
    parity = report["parity"]
    assert parity["fp32"]["boxDifferencePx"] <= parity["fp32"]["allowedBoxDifferencePx"] == 1e-2
    assert parity["fp32"]["scoreDifference"] <= parity["fp32"]["allowedScoreDifference"] == 1e-4
    assert parity["fp16Weights"]["scoreDifference"] <= parity["fp16Weights"]["allowedScoreDifference"] == 3e-2

    exported = onnx.load(str(tmp_path / "toy.onnx"))
    assert [(o.domain, o.version) for o in exported.opset_import] == [("", 13)]
    session = create_session(tmp_path / "toy.onnx")
    x = detector_export.parity_inputs()[0]
    with torch.no_grad():
        expected = model(torch.from_numpy(x)).numpy()
    produced = session.run(None, {"images": x})[0]
    assert produced.shape == (1, 240, 7)
    np.testing.assert_allclose(produced, expected, atol=1e-4)
    assert (produced[..., 4:] >= 0).all() and (produced[..., 4:] <= 1).all()     # the sigmoid is in the graph


def test_detector_parity_inputs_follow_the_input_contract():
    inputs = detector_export.parity_inputs()
    assert len(inputs) == 2
    assert all(x.shape == (1, 3, 384, 640) and x.dtype == np.float32 for x in inputs)
    assert all(0 <= x.min() and x.max() <= 255 for x in inputs)
    wide, tall = inputs
    assert (wide[0, :, 360:, :] == 114).all()            # a 1280 x 720 frame leaves 24 rows of padding below
    assert (tall[0, :, :, 216:] == 114).all()            # a 540 x 960 frame leaves padding to the right
    again = detector_export.parity_inputs()
    assert all(np.array_equal(a, b) for a, b in zip(inputs, again))


def test_detector_tolerances_are_enforced(tmp_path):
    with pytest.raises(ParityError, match="largest box difference"):
        detector_export.export_detector(build_toy_detector(), tmp_path, "toy", max_box_difference=-1.0)
    with pytest.raises(ParityError, match="toy-fp16w.onnx"):
        detector_export.export_detector(build_toy_detector(), tmp_path, "toy", overwrite=True, max_score_difference_fp16=-1.0)
    assert not (tmp_path / "toy.export.json").exists()


class JunkAnchorHead(ToyHead):
    """The toy head with two boxes no threshold keeps (objectness zero): anchor 0 is far larger
    than the canvas, anchor 1 is a mid-size box."""

    def forward(self, x):
        rows = super().forward(x)
        if not self.decode_in_inference:
            return rows
        mask = torch.zeros_like(rows)
        values = torch.zeros_like(rows)
        mask[:, :2, :5] = 1.0
        for anchor, box in ((0, (320.0, 192.0, 1500.0, 1500.0)), (1, (320.0, 192.0, 200.0, 200.0))):
            for column, value in enumerate(box):
                values[:, anchor, column] = value
        return rows * (1.0 - mask) + values * mask


def build_junk_anchor_detector() -> nn.Module:
    model = build_toy_detector()
    model.head = JunkAnchorHead()
    return model


def shift_boxes(monkeypatch, pick, shift, columns=slice(0, 4)):
    """Make the float32 ONNX output differ from PyTorch by ``shift`` px on the box ``columns`` of
    the anchor ``pick(scores)`` chooses, in every input. The half-precision copy is left alone."""
    real = detector_export.run_onnx

    def shifted(path, batches):
        outputs = real(path, batches)
        if path.name.endswith("-fp16w.onnx"):
            return outputs
        for output in outputs:
            scores = (output[0, :, 4:5] * output[0, :, 5:]).max(-1)
            output[0, pick(scores), columns] += shift
        return outputs

    monkeypatch.setattr(detector_export, "run_onnx", shifted)


def second_best(scores):
    return int(np.argsort(-scores)[1])


def test_a_large_box_no_threshold_keeps_may_differ_beyond_the_box_bound(tmp_path, monkeypatch):
    shift_boxes(monkeypatch, lambda scores: 0, 0.5, columns=slice(2, 4))     # its width and height
    report = detector_export.export_detector(build_junk_anchor_detector(), tmp_path, "toy")
    fp32 = report["parity"]["fp32"]
    assert fp32["keptScoreFloor"] == detector_export.KEPT_SCORE_FLOOR == 1e-2
    assert fp32["boxDifferencePx"] <= fp32["allowedBoxDifferencePx"] == 1e-2
    assert fp32["boundedAnchors"] == [238, 238]                       # every anchor but the two junk ones
    assert fp32["boxDifferencePxEveryAnchor"] == pytest.approx(0.5, abs=1e-3)
    assert fp32["boxRelativeDifferenceEveryAnchor"] == pytest.approx(0.49 / 1500, rel=1e-3)
    assert fp32["allowedBoxRelativeDifferenceEveryAnchor"] == detector_export.MAX_RELATIVE_BOX_DIFFERENCE == 1e-3
    written = json.loads((tmp_path / "toy.export.json").read_text())["parity"]["fp32"]
    assert written == json.loads(json.dumps(fp32))


def test_a_mid_size_box_no_threshold_keeps_is_refused_one_pixel_off(tmp_path, monkeypatch):
    shift_boxes(monkeypatch, lambda scores: 1, 1.0, columns=slice(2, 4))     # a 200 x 200 box
    with pytest.raises(ParityError, match=r"on the 238/238 anchors per input .* over every anchor it is 1 px, "
                                          r"0\.00495 of the coordinate beyond 0\.01 px \(allowed 0\.001\)"):
        detector_export.export_detector(build_junk_anchor_detector(), tmp_path, "toy")
    assert not (tmp_path / "toy.export.json").exists()


def test_a_box_the_best_threshold_keeps_is_held_to_the_box_bound(tmp_path, monkeypatch):
    shift_boxes(monkeypatch, lambda scores: int(np.argmax(scores)), 0.05)
    with pytest.raises(ParityError, match=r"largest box difference is 0\.05\d* px on the 238/238 anchors per input "
                                          r"that score at least 0\.01 \(allowed 0\.01\); over every anchor it is "
                                          r"0\.05\d* px"):
        detector_export.export_detector(build_junk_anchor_detector(), tmp_path, "toy",
                                        max_relative_box_difference=1.0)
    assert not (tmp_path / "toy.export.json").exists()


def test_a_box_any_threshold_from_the_floor_keeps_is_held_to_the_box_bound(tmp_path, monkeypatch):
    # The second-best anchor scores well above the floor; only the absolute bound is in play.
    shift_boxes(monkeypatch, second_best, 0.05)
    with pytest.raises(ParityError, match=r"largest box difference is 0\.05\d* px on the 238/238 anchors"):
        detector_export.export_detector(build_junk_anchor_detector(), tmp_path, "toy",
                                        max_relative_box_difference=1.0)
    # With the floor above every toy score, only the best anchor of each input is bounded.
    report = detector_export.export_detector(build_junk_anchor_detector(), tmp_path, "toy", overwrite=True,
                                             max_relative_box_difference=1.0, kept_score_floor=0.99)
    assert report["parity"]["fp32"]["boundedAnchors"] == [1, 1]
    assert report["parity"]["fp32"]["boxDifferencePx"] <= 1e-2


def test_a_box_that_is_not_finite_is_refused_on_any_anchor(tmp_path, monkeypatch):
    shift_boxes(monkeypatch, lambda scores: 0, np.nan)
    with pytest.raises(ParityError, match="over every anchor it is nan px, nan of the coordinate"):
        detector_export.export_detector(build_junk_anchor_detector(), tmp_path, "toy")


@pytest.mark.parametrize("floor", [-0.1, 1.0, float("nan")])
def test_the_kept_score_floor_is_checked(tmp_path, floor):
    with pytest.raises(ValueError, match="kept_score_floor must be at least 0 and below 1"):
        detector_export.export_detector(build_toy_detector(), tmp_path, "toy", kept_score_floor=floor)
    assert not any(tmp_path.iterdir())


def test_kept_anchors():
    rows = np.zeros((1, 4, 7), dtype=np.float32)
    rows[0, :, 4] = [1.0, 1.0, 1.0, 1.0]
    rows[0, :, 5] = [0.5, 0.009, 0.0, 0.002]
    other = rows.copy()
    other[0, 2, 6] = 0.01                                  # anchor 2 reaches the floor in one runtime only
    assert detector_export.kept_anchors(rows, other).tolist() == [True, False, True, False]
    low = rows.copy()
    low[0, :, 5] = [0.001, 0.003, 0.0, 0.002]               # nothing reaches the floor: the best anchor still counts
    assert detector_export.kept_anchors(low, low).tolist() == [False, True, False, False]


def test_a_network_that_does_not_return_decoded_rows_is_refused(tmp_path):
    with pytest.raises(ValueError, match=r"expected \(1, anchors, 5 \+ classes\)"):
        detector_export.export_detector(build_toy_recognizer(), tmp_path, "toy")


def test_the_yolox_package_is_asked_for_by_name_when_missing(monkeypatch):
    monkeypatch.setitem(sys.modules, "yolox", None)
    monkeypatch.setitem(sys.modules, "yolox.exp", None)
    with pytest.raises(detector_export.YoloxMissing, match="pip install --no-deps --no-build-isolation"):
        detector_export.build_yolox_nano()


def test_the_default_detector_network():
    pytest.importorskip("yolox")
    model = detector_export.build_yolox_nano(2).eval()
    model.head.decode_in_inference = True
    with torch.no_grad():
        rows = model(torch.zeros(1, 3, 384, 640))
    assert tuple(rows.shape) == (1, 5040, 7)


# ----------------------------------------------------------------------------- checkpoints


def test_a_plain_checkpoint_loads_in_restricted_mode(tmp_path):
    model = build_toy_recognizer()
    path = tmp_path / "plain.pt"
    torch.save({"model": model.state_dict(), "epoch": 3, "config": {"lr": 0.1, "tags": ["a", "b"]}}, path)
    state = ckpt.state_dict_of(ckpt.load_checkpoint(path))
    assert set(state) == set(model.state_dict())
    assert all(torch.equal(state[name], value) for name, value in model.state_dict().items())


def test_a_checkpoint_with_other_objects_needs_trust(tmp_path):
    path = tmp_path / "objects.pt"
    torch.save({"model": build_toy_recognizer().state_dict(), "extra": NotATensor()}, path)
    with pytest.raises(ValueError, match="--trust-checkpoint"):
        ckpt.load_checkpoint(path)
    loaded = ckpt.load_checkpoint(path, trust=True)
    assert isinstance(loaded["extra"], NotATensor)


def test_where_the_weights_are():
    state = build_toy_recognizer().state_dict()
    assert set(ckpt.state_dict_of({"model": state})) == set(state)
    assert set(ckpt.state_dict_of({"ema": state, "model": {}}, key="ema")) == set(state)
    assert set(ckpt.state_dict_of(state)) == set(state)                 # a bare state dictionary
    with pytest.raises(ValueError, match="no weights found under the key 'model'.*'epoch'"):
        ckpt.state_dict_of({"weights": state, "epoch": 1})
    with pytest.raises(ValueError, match="no weights found"):
        ckpt.state_dict_of([1, 2, 3])


def test_save_safetensors_needs_tensors(tmp_path):
    with pytest.raises(ValueError, match="holds no tensors"):
        ckpt.save_safetensors({"note": "nothing here"}, tmp_path / "empty.safetensors")
    assert ckpt.save_safetensors({"w": torch.ones(2, 3), "note": "skipped"}, tmp_path / "one.safetensors") == 1


def test_load_factory():
    assert ckpt.load_factory("test_export_torch:build_toy_recognizer") is build_toy_recognizer
    for spec, message in [("no-colon", "expected MODULE:FUNCTION"), (":function", "expected MODULE:FUNCTION"),
                          ("no_such_module_anywhere:build", "cannot import"), ("test_export_torch:missing", "has no attribute")]:
        with pytest.raises(ValueError, match=message):
            ckpt.load_factory(spec)


# ----------------------------------------------------------------------------- the command line


def run(capsys, *arguments):
    code = cli.main(["export", *arguments])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def test_the_subcommand_is_registered():
    assert "export" in cli.SUBCOMMANDS


def test_export_recognizer_from_the_command_line(tmp_path, capsys):
    checkpoint = tmp_path / "best.pt"
    torch.save({"model": build_toy_recognizer().state_dict(), "epoch": 10}, checkpoint)
    code, out, err = run(capsys, "recognizer", str(checkpoint), "--model", "test_export_torch:build_toy_recognizer",
                         "--out", str(tmp_path / "out"), "--name", "toy")
    assert code == 0, err
    report = json.loads(out)
    assert report["kind"] == "recognizer" and report["fp32"]["file"] == "toy.onnx"
    assert (tmp_path / "out" / "toy.safetensors").is_file()

    code, _, err = run(capsys, "recognizer", str(checkpoint), "--model", "test_export_torch:build_toy_recognizer",
                       "--out", str(tmp_path / "out"), "--name", "toy")
    assert code == 2 and "refusing to overwrite" in err
    code, _, _ = run(capsys, "recognizer", str(checkpoint), "--model", "test_export_torch:build_toy_recognizer",
                     "--out", str(tmp_path / "out"), "--name", "toy", "--overwrite")
    assert code == 0


def test_export_detector_from_the_command_line_with_default_names(tmp_path, capsys):
    checkpoint = tmp_path / "last.pt"
    torch.save({"ema": build_toy_detector().state_dict()}, checkpoint)
    code, out, err = run(capsys, "detector", str(checkpoint), "--model", "test_export_torch:build_toy_detector",
                         "--key", "ema", "--out", str(tmp_path / "out"))
    assert code == 0, err
    assert json.loads(out)["output"]["shape"] == [1, 240, 7]
    assert (tmp_path / "out" / "detector.onnx").is_file() and (tmp_path / "out" / "detector-fp16w.onnx").is_file()


def test_export_from_a_safetensors_file(tmp_path, capsys):
    weights = tmp_path / "weights.safetensors"
    ckpt.save_safetensors(build_toy_recognizer().state_dict(), weights)
    code, _, err = run(capsys, "recognizer", str(weights), "--model", "test_export_torch:build_toy_recognizer", "--out", str(tmp_path / "out"))
    assert code == 0, err
    assert (tmp_path / "out" / "recognizer.onnx").is_file()


def test_command_line_errors(tmp_path, capsys, monkeypatch):
    checkpoint = tmp_path / "best.pt"
    torch.save({"model": build_toy_recognizer().state_dict()}, checkpoint)

    code, _, err = run(capsys, "recognizer", str(tmp_path / "missing.pt"))
    assert code == 2 and "no such checkpoint file" in err

    code, _, err = run(capsys, "recognizer", str(checkpoint))
    assert code == 2 and "pass --model MODULE:FUNCTION" in err

    code, _, err = run(capsys, "recognizer", str(checkpoint), "--model", "test_export_torch:build_toy_detector")
    assert code == 2 and "state_dict" in err                              # the weights do not fit that network

    code, _, err = run(capsys, "recognizer", str(checkpoint), "--model", "test_export_torch:build_toy_recognizer", "--key", "ema")
    assert code == 2 and "no weights found under the key 'ema'" in err

    monkeypatch.setitem(sys.modules, "yolox", None)
    monkeypatch.setitem(sys.modules, "yolox.exp", None)
    code, _, err = run(capsys, "detector", str(checkpoint))
    assert code == 2 and "YOLOX" in err and "pip install --no-deps --no-build-isolation" in err

    with pytest.raises(SystemExit):
        cli.main(["export", "tracker", str(checkpoint)])
    capsys.readouterr()


def test_export_without_the_optional_dependencies_says_how_to_get_them(tmp_path, capsys, monkeypatch):
    checkpoint = tmp_path / "best.pt"
    checkpoint.write_bytes(b"")
    monkeypatch.setitem(sys.modules, "safetensors", None)
    code, _, err = run(capsys, "recognizer", str(checkpoint), "--model", "test_export_torch:build_toy_recognizer")
    assert code == 2 and 'python -m pip install -e ".[train]"' in err and "safetensors" in err
