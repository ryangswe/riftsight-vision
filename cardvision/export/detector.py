# SPDX-License-Identifier: Apache-2.0
"""Export a detector: PyTorch module to ONNX, a half-precision-weights copy, and safetensors.

The exported graph takes ``images``, a ``(1, 3, 384, 640)`` float32 tensor (blue-green-red,
0..255, letterboxed: see ``cardvision.detect.letterbox``), and returns ``output``,
``(1, anchors, 5 + classes)``: center, size, objectness and class scores per anchor, decoded to
canvas pixels and with the sigmoid applied. Non-maximum suppression is not in the graph (see
``cardvision.detect.decode``). Opset 13, fixed shapes.

Parity is checked on generated frames passed through the real input contract. Against
PyTorch, the float32 file must agree:

- on every score (objectness times class score) of every anchor, to ``MAX_SCORE_DIFFERENCE``;
- on every box coordinate of the anchors any threshold of ``KEPT_SCORE_FLOOR`` (0.01) or more
  keeps (the operating threshold is 0.3), to ``MAX_BOX_DIFFERENCE`` canvas pixels. An anchor
  counts when its score, as ``decode`` computes it, reaches the floor in either runtime; the
  highest-scoring anchor of each input always counts;
- on every box coordinate of every anchor, to ``MAX_BOX_DIFFERENCE`` plus
  ``MAX_RELATIVE_BOX_DIFFERENCE`` times the coordinate's size (at least 1 px).

The last bound exists because noise frames give few anchors above the floor, and none on some
stride levels: a box error confined to one level would otherwise pass. It scales with the
coordinate because a trained network gives some anchors boxes far larger than the canvas at
scores near zero, and their last bits differ between runtimes by more than a fixed bound. The
evaluation's full sweep of thresholds runs on the ONNX file itself, so it is not a parity
question. The report gives the box difference over the bounded anchors, their number per
input, and the absolute and relative differences over every anchor. The copy with
half-precision weights is held to ``MAX_SCORE_DIFFERENCE_FP16`` on scores only: its weights
were rounded, and what matters downstream is whether a score crosses the threshold. An export
that misses a bound raises ``ParityError`` and should not be used.

The network itself comes from the YOLOX package (Megvii, Apache-2.0), which is built here
through its public API and is not a declared dependency: see ``build_yolox_nano``.
"""

from __future__ import annotations

import json
from pathlib import Path
from dataclasses import dataclass
from typing import Any

import numpy as np

from cardvision.core.constants import DETECTOR_PARITY_SCORE_FLOOR
from cardvision.detect.decode import CLASS_NAMES, scores_and_classes
from cardvision.detect.letterbox import INPUT_HEIGHT, INPUT_WIDTH, letterbox_bgr, to_input_tensor
from cardvision.export.checkpoint import save_safetensors
from cardvision.export.onnx_tools import fp16_weights, output_shape
from cardvision.export.torch_export import ParityError, claim_outputs, environment, export_onnx, file_record, run_onnx

INPUT_NAME = "images"
OUTPUT_NAME = "output"
OPSET = 13
# Largest box coordinate difference, in canvas pixels, on an anchor a decode could keep.
MAX_BOX_DIFFERENCE = 1e-2
# Largest score difference on any anchor: scores decide which anchors a threshold keeps.
MAX_SCORE_DIFFERENCE = 1e-4
# Largest score difference for the half-precision-weights copy, whose weights were rounded.
MAX_SCORE_DIFFERENCE_FP16 = 3e-2
# Boxes are held to MAX_BOX_DIFFERENCE on the anchors any threshold of 0.01 or more keeps (the
# operating threshold is 0.3); release validation refuses a lower threshold.
KEPT_SCORE_FLOOR = DETECTOR_PARITY_SCORE_FLOOR
# Every anchor's box: MAX_BOX_DIFFERENCE plus this times max(|coordinate|, 1 px). Over four times
# the worst seen on trained detectors' junk anchors, and still refuses 1 px anywhere on the canvas.
MAX_RELATIVE_BOX_DIFFERENCE = 1e-3
PARITY_SEED = 0
# Sizes (width, height) of the generated frames: one wider and one taller than the canvas, so
# that the padding falls on a different side in each.
PARITY_FRAME_SIZES = ((1280, 720), (540, 960))

# The upstream revision this export was verified with.
YOLOX_REVISION = "6ddff4824372906469a7fae2dc3206c7aa4bbaee"
YOLOX_INSTALL = (
    "pip install --no-deps --no-build-isolation "
    f'"yolox @ git+https://github.com/Megvii-BaseDetection/YOLOX@{YOLOX_REVISION}"'
)


class YoloxMissing(RuntimeError):
    """The YOLOX package is needed to build the detector network and is not installed."""


def build_yolox_nano(num_classes: int = len(CLASS_NAMES)) -> Any:
    """The YOLOX-Nano network with ``num_classes`` outputs, untrained, built by the YOLOX package.

    This is the package's own ``yolox-nano`` experiment with the class count changed; the
    weights come from the checkpoint afterwards. YOLOX is installed separately, after PyTorch,
    with the command in ``YOLOX_INSTALL``: its package metadata pins versions of other libraries
    that conflict with this package's, hence ``--no-deps``, and its build script imports
    PyTorch, hence ``--no-build-isolation``. The ``train`` extra brings what YOLOX imports.
    """
    try:
        from yolox.exp import get_exp
    except ImportError as error:
        raise YoloxMissing(
            f"the detector network is built by the YOLOX package, which could not be imported ({error}). "
            f"Install the train extra first, then: {YOLOX_INSTALL}"
        ) from None
    experiment = get_exp(None, "yolox-nano")
    experiment.num_classes = num_classes
    return experiment.get_model()


def parity_inputs(width: int = INPUT_WIDTH, height: int = INPUT_HEIGHT) -> list[np.ndarray]:
    """Generated detector inputs: noise frames with flat rectangles, letterboxed to the canvas."""
    rng = np.random.default_rng(PARITY_SEED)
    inputs = []
    for frame_width, frame_height in PARITY_FRAME_SIZES:
        frame = rng.integers(0, 256, size=(frame_height, frame_width, 3), dtype=np.uint8)
        for _ in range(6):
            w, h = int(rng.integers(40, frame_width // 3)), int(rng.integers(40, frame_height // 3))
            x, y = int(rng.integers(0, frame_width - w)), int(rng.integers(0, frame_height - h))
            frame[y:y + h, x:x + w] = rng.integers(0, 256, size=3, dtype=np.uint8)
        inputs.append(to_input_tensor(letterbox_bgr(frame, width, height)[0]))
    return inputs


def _scores(rows: np.ndarray) -> np.ndarray:
    return rows[..., 4:5] * rows[..., 5:]


def _largest(differences: list[np.ndarray]) -> float:
    return float(max(np.abs(d).max() for d in differences))


def kept_anchors(output: np.ndarray, reference: np.ndarray, floor: float = KEPT_SCORE_FLOOR) -> np.ndarray:
    """Which anchors of one input the box bound covers: a boolean per anchor.

    An anchor is covered when its score (``cardvision.detect.decode.scores_and_classes``) is at
    least ``floor`` in either runtime. The highest-scoring anchor is always covered, so that the
    bound never measures nothing.
    """
    scores = np.maximum(scores_and_classes(output)[0], scores_and_classes(reference)[0])
    kept = scores >= floor
    if len(scores):
        kept[int(np.argmax(scores))] = True
    return kept


@dataclass(frozen=True)
class BoxParity:
    """How far the ONNX boxes are from PyTorch's, over all inputs.

    ``kept``: the largest coordinate difference on the anchors ``kept_anchors`` covers, in
    canvas pixels. ``every``: the same over every anchor. ``relative``: over every anchor, the
    largest coordinate difference beyond the absolute slack, divided by ``max(|coordinate|, 1)``
    (zero when every difference is within the slack). ``bounded``: how many anchors
    ``kept_anchors`` covers, per input. A NaN difference makes the figures it falls in NaN.
    """

    kept: float
    every: float
    relative: float
    bounded: list[int]


def box_differences(outputs: list[np.ndarray], references: list[np.ndarray],
                    floor: float = KEPT_SCORE_FLOOR, slack: float = MAX_BOX_DIFFERENCE) -> BoxParity:
    """Compare the boxes of ONNX ``outputs`` with PyTorch ``references``, one array per input."""
    kept, every, relative, bounded = [], [], [], []
    for output, reference in zip(outputs, references):
        difference = np.abs(output[0, :, :4] - reference[0, :, :4])
        covered = kept_anchors(output, reference, floor)
        kept.append(difference[covered])
        every.append(difference)
        size = np.maximum(np.abs(reference[0, :, :4]), 1.0)
        relative.append(np.maximum(difference - slack, 0.0) / size)
        bounded.append(int(covered.sum()))
    return BoxParity(_largest(kept), _largest(every), _largest(relative), bounded)


def export_detector(
    model: Any,
    out_dir: str | Path,
    name: str = "detector",
    *,
    width: int = INPUT_WIDTH,
    height: int = INPUT_HEIGHT,
    opset: int = OPSET,
    overwrite: bool = False,
    max_box_difference: float = MAX_BOX_DIFFERENCE,
    max_score_difference: float = MAX_SCORE_DIFFERENCE,
    max_score_difference_fp16: float = MAX_SCORE_DIFFERENCE_FP16,
    fp16_weights_copy: bool = True,
    max_relative_box_difference: float = MAX_RELATIVE_BOX_DIFFERENCE,
    kept_score_floor: float = KEPT_SCORE_FLOOR,
) -> dict[str, Any]:
    """Export ``model`` (a ``torch.nn.Module`` with its weights loaded) into ``out_dir``.

    Writes ``<name>.onnx`` (float32), ``<name>-fp16w.onnx`` (the same graph with weights stored
    in half precision; left out when ``fp16_weights_copy`` is false, and with it its parity check),
    ``<name>.safetensors`` (the weights alone) and ``<name>.export.json``
    (the report, which is also returned).

    A YOLOX head decodes its outputs only when told to; this is switched on before the export,
    so that the graph emits canvas pixels. Existing files are not replaced unless ``overwrite``
    is true. Raises ``ParityError`` when the ONNX outputs miss the bounds; the files are left
    in place for inspection, and the report is not written.
    """
    import torch

    if not 0 <= kept_score_floor < 1:
        raise ValueError(f"kept_score_floor must be at least 0 and below 1, got {kept_score_floor}")
    out_dir = Path(out_dir)
    fp32 = out_dir / f"{name}.onnx"
    fp16 = out_dir / f"{name}-fp16w.onnx"
    weights = out_dir / f"{name}.safetensors"
    report_path = out_dir / f"{name}.export.json"
    claim_outputs([fp32, *([fp16] if fp16_weights_copy else []), weights, report_path], overwrite)

    model = model.to("cpu").eval()
    head = getattr(model, "head", None)
    if head is not None and hasattr(head, "decode_in_inference"):
        head.decode_in_inference = True
    inputs = parity_inputs(width, height)
    with torch.no_grad():
        references = [model(torch.from_numpy(x)).numpy() for x in inputs]
    if references[0].ndim != 3 or references[0].shape[-1] < 6:
        raise ValueError(
            f"the model returned shape {references[0].shape}; expected (1, anchors, 5 + classes) decoded rows"
        )
    export_onnx(model, torch.from_numpy(inputs[0]), fp32,
                input_name=INPUT_NAME, output_name=OUTPUT_NAME, opset=opset, dynamic_batch=False)

    outputs = run_onnx(fp32, inputs)
    boxes = box_differences(outputs, references, kept_score_floor, max_box_difference)
    score_difference = _largest([_scores(o) - _scores(r) for o, r in zip(outputs, references)])
    if not (boxes.kept <= max_box_difference and boxes.relative <= max_relative_box_difference
            and score_difference <= max_score_difference):
        raise ParityError(
            f"{fp32.name}: against PyTorch the largest box difference is {boxes.kept:.6g} px on the "
            f"{'/'.join(map(str, boxes.bounded))} anchors per input that score at least {kept_score_floor} "
            f"(allowed {max_box_difference}); over every anchor it is {boxes.every:.6g} px, "
            f"{boxes.relative:.6g} of the coordinate beyond {max_box_difference} px "
            f"(allowed {max_relative_box_difference}); the largest score difference is {score_difference:.6g} "
            f"(allowed {max_score_difference})"
        )
    converted = fp16_weights(fp32, fp16) if fp16_weights_copy else None
    score_difference_fp16 = None
    if fp16_weights_copy:
        outputs_fp16 = run_onnx(fp16, inputs)
        score_difference_fp16 = _largest([_scores(o) - _scores(r) for o, r in zip(outputs_fp16, references)])
    if fp16_weights_copy and not score_difference_fp16 <= max_score_difference_fp16:
        raise ParityError(
            f"{fp16.name}: against PyTorch the largest score difference is {score_difference_fp16:.6g} "
            f"(allowed {max_score_difference_fp16})"
        )
    tensors = save_safetensors(model.state_dict(), weights)

    classes = references[0].shape[-1] - 5
    report = {
        "kind": "detector",
        "input": {"name": INPUT_NAME, "shape": [1, 3, height, width], "dtype": "float32",
                  "layout": "blue-green-red, 0..255, letterboxed top-left, padded with 114"},
        "output": {"name": OUTPUT_NAME, "shape": output_shape(fp32), "dtype": "float32",
                   "columns": ["cx", "cy", "w", "h", "obj", *[f"cls_{c}" for c in CLASS_NAMES[:classes]],
                               *[f"cls_{i}" for i in range(len(CLASS_NAMES), classes)]]},
        "opset": opset,
        "fp32": file_record(fp32),
        "fp16Weights": {**file_record(fp16), **converted} if fp16_weights_copy else None,
        "safetensors": {**file_record(weights), "tensors": tensors},
        "parity": {
            "inputs": f"{len(inputs)} generated frames, seed {PARITY_SEED}, through the letterbox",
            "measure": "largest difference between PyTorch and ONNX Runtime: scores over every anchor; boxes "
                       "over the anchors scoring at least keptScoreFloor in either runtime and each input's "
                       "highest-scoring anchor (boxDifferencePx; boundedAnchors per input); boxes over every "
                       "anchor (boxDifferencePxEveryAnchor, not bounded), and the part of it beyond "
                       "allowedBoxDifferencePx divided by max(|coordinate|, 1) (boxRelativeDifferenceEveryAnchor)",
            "fp32": {"boxDifferencePx": boxes.kept, "allowedBoxDifferencePx": max_box_difference,
                     "keptScoreFloor": kept_score_floor, "boundedAnchors": boxes.bounded,
                     "boxDifferencePxEveryAnchor": boxes.every,
                     "boxRelativeDifferenceEveryAnchor": boxes.relative,
                     "allowedBoxRelativeDifferenceEveryAnchor": max_relative_box_difference,
                     "scoreDifference": score_difference, "allowedScoreDifference": max_score_difference},
            "fp16Weights": ({"scoreDifference": score_difference_fp16,
                             "allowedScoreDifference": max_score_difference_fp16} if fp16_weights_copy else None),
        },
        "environment": environment(),
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report
