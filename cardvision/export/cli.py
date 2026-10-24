# SPDX-License-Identifier: Apache-2.0
"""The ``cardvision export`` subcommand: a training checkpoint in, deployable files out.

``cardvision export recognizer CHECKPOINT`` and ``cardvision export detector CHECKPOINT`` each
write a float32 ONNX file, a copy with half-precision weights, the weights alone as
safetensors, and a report with the parity measurements. Both need the ``train`` extra
(``python -m pip install -e ".[train]"`` in the repository folder); the detector also needs
the YOLOX package.

A checkpoint stores weights, not the network that holds them, so the network has to be built
first. ``--model MODULE:FUNCTION`` names a function that takes no arguments and returns it.
For the recognizer the default is the encoder ``cardvision train-recognizer`` trains; for the
detector it is YOLOX-Nano with ``--classes`` outputs.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SUMMARY = "Export a checkpoint to ONNX (fp32 and fp16 weights) and safetensors."
KINDS = ("recognizer", "detector")


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Declare the subcommand's arguments."""
    parser.add_argument("kind", choices=KINDS, help="which model the checkpoint holds")
    parser.add_argument("checkpoint", metavar="CHECKPOINT", help="a PyTorch checkpoint or a .safetensors file")
    parser.add_argument("--out", default=".", metavar="DIR", help="folder for the exported files (default: here)")
    parser.add_argument("--name", metavar="NAME", help="base name of the exported files (default: the kind)")
    parser.add_argument("--model", metavar="MODULE:FUNCTION",
                        help="function that builds the network; by default the trainer's encoder "
                             "for a recognizer and YOLOX-Nano for a detector")
    parser.add_argument("--classes", type=int, default=2, metavar="N",
                        help="detector only: number of classes of the default network (default 2: face, back)")
    parser.add_argument("--no-fp16-weights", action="store_true",
                        help="detector only: write no half-precision copy (<name>-fp16w.onnx) and skip its parity check; "
                             "the float32 file, which a release ships, is still checked")
    parser.add_argument("--key", default="model", metavar="KEY",
                        help='where the weights are inside the checkpoint (default "model")')
    parser.add_argument("--trust-checkpoint", action="store_true",
                        help="unpickle the checkpoint without restrictions; only for a file you made yourself")
    parser.add_argument("--overwrite", action="store_true", help="replace exported files that already exist")


def _note(message: str) -> None:
    print(f"cardvision export: {message}", file=sys.stderr)


def _require_train_extra() -> None:
    missing = []
    for module in ("torch", "onnx", "safetensors"):
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    if missing:
        raise RuntimeError(
            f"export needs {', '.join(missing)}, part of an optional dependency group: python -m pip install -e \".[train]\" in the repository folder"
        )


def _run(args: argparse.Namespace) -> int:
    if not Path(args.checkpoint).is_file():
        raise FileNotFoundError(f"{args.checkpoint}: no such checkpoint file")
    _require_train_extra()
    from cardvision.export.checkpoint import load_checkpoint, load_factory, state_dict_of

    if args.model:
        build = load_factory(args.model)
    elif args.kind == "detector":
        from cardvision.export.detector import build_yolox_nano

        def build():
            return build_yolox_nano(args.classes)
    else:
        build = load_factory("cardvision.train_recognizer.model:build_export_encoder")
    state = state_dict_of(load_checkpoint(args.checkpoint, trust=args.trust_checkpoint), args.key)
    model = build()
    model.load_state_dict(state)

    name = args.name or args.kind
    if args.kind == "recognizer":
        from cardvision.export.recognizer import export_recognizer

        report = export_recognizer(model, args.out, name, overwrite=args.overwrite)
    else:
        from cardvision.export.detector import export_detector

        report = export_detector(model, args.out, name, overwrite=args.overwrite,
                                 fp16_weights_copy=not args.no_fp16_weights)
    print(json.dumps(report, indent=2))
    return 0


def run(args: argparse.Namespace) -> int:
    """Run the subcommand. Returns the process exit code: 0, or 2 after a reported error."""
    try:
        return _run(args)
    except (FileNotFoundError, FileExistsError, ValueError, RuntimeError) as error:
        _note(f"error: {error}")
    return 2
