# SPDX-License-Identifier: Apache-2.0
"""The release document: one file that pins everything recognition runs with.

A detector, a recognizer, a bank, identity groups, a catalog and a handful of thresholds only
mean something together: accuracy is measured for one exact combination, and swapping any part
gives a combination nobody measured. A release names the combination. It is a single JSON
document that

* points at each component file by a path relative to the document, and records the file's
  SHA-256 and size, so that a changed or truncated file is noticed;
* writes down the settings that are not files: how the detector's output is decoded, how a crop
  is preprocessed, the accept rule, the hover rule and the runtime settings;
* is named by its content: ``id`` is the first 16 hex digits of the SHA-256 of the document.

A release is all-or-nothing. ``release_errors`` returns every reason a release cannot be used,
and any reason at all means it must not be: there is no partial load and no fallback to another
file. The same document is meant to be read by every runtime, in Python or in a browser, so it
holds nothing about where the files are hosted.

Shape
-----
::

    {"schemaVersion": 1, "kind": "vision-release", "id": "<16 hex>",
     "game": "toy", "locale": "en",
     "detector":   {"arm": "yolox", "version": "<label>", "path": ..., "sha256": ..., "bytes": ...,
                    "weights": "fp32", "input": {"width": 640, "height": 384},
                    "decode": {...}, "faceClass": 0, "minCropPx": 24},
     "recognizer": {"version": "<label>", "path": ..., "sha256": ..., "bytes": ...,
                    "weights": "fp32", "dim": 128, "inputName": ..., "outputName": ...,
                    "preprocessing": {"id": "full128", "size": 128, "centerMask": false,
                                      "poolVersion": 2, "crop": "truncate"}},
     "bank":       {"version": 1, "path": ..., "sha256": ..., "bytes": ...,
                    "cardCount": 20, "entryCount": 20, "views": 16, "aggregation": "mean"},
     "identity":   {"level": "name",
                    "groups": {"version": 1, "path": ..., "sha256": ..., "bytes": ...},
                    "display": "best-printing"},
     "catalog":    {"path": ..., "sha256": ..., "bytes": ..., "cardCount": 20},
     "accept":     {"tau": 0.62, "delta": 0.05, "rotationRetry": true},
     "hover":      {"selection": "accepted-nms", "maxAgeMs": 2000},
     "runtime":    {"ortWeb": "1.29.0", "executionProviders": ["webgpu", "wasm"],
                    "wasmThreads": 1, "analysisWidth": {"min": 720, "max": 1920}}}

``detector``
    ``arm`` names the detector family, which fixes how its raw output becomes boxes; ``decode``
    spells that out as data (tensor names, letterbox, score rule, threshold, suppression) so
    that a runtime can refuse a contract it does not implement. ``faceClass`` is the class
    whose boxes go to the recognizer and ``minCropPx`` the shortest side a box may have.
    ``version`` and ``weights`` are labels: which model this is, and whether the file stores
    its weights as 32-bit floats (``fp32``) or as 16-bit floats widened on load (``fp16w``).
``recognizer``
    ``preprocessing`` is the contract a crop goes through before the model
    (``cardvision.core.preprocess``); it has to be the one the bank was built with.
``bank`` and ``identity``
    The bank file and its identity groups (``cardvision.bank.build``). The bank file is JSON or
    its binary form (``bank.bin``, ``cardvision.core.bank_binary``); a reader tells them apart
    by the binary form's first bytes. A release does not
    require the bank's rows to record their source image (``artV``); ``bank_image_records``
    counts the rows that do. ``identity.level`` is the identity rule of the release's
    catalog (``cardvision.core.catalog``, "Identity"): ``name``, where printings that share
    a catalog name are one identity, or ``printing``, where an entry and the entries whose
    ``printingOf`` names it are one identity. The level, the groups file's own ``rule.level``
    and the catalog's rule must all agree. ``identity.display`` says which id is shown for a
    match: ``best-printing`` shows the printing whose bank row matched best, ``representative``
    shows the group's representative.
``catalog``
    The game's catalog file. Every bank id must be in it.
``accept``
    The accept rule's settings. ``tau`` is the similarity the best match must reach, ``delta``
    the margin it must keep over the best match of any other identity, and ``rotationRetry``
    whether a crop that is not accepted upright is tried again in its three other quarter-turn
    orientations. The same three keys make up a game's ``accept.json``; both are read and
    checked by ``cardvision.recognize.accept``, which inference uses too.
``hover``
    ``selection`` names the rule a runtime uses to choose among detections under the pointer,
    and ``maxAgeMs`` is how old a result may be, against the picture on screen, and still be
    shown.
``runtime``
    What the in-browser runtime was measured on: the ``onnxruntime-web`` version, the
    execution providers to try in order, the WebAssembly thread count, and the range of
    widths, in pixels, of the frame handed to the detector.

The id
------
The id is computed over the document without its ``id`` key, written as JSON with sorted keys,
no whitespace, non-ASCII characters as themselves, in UTF-8; numbers are written the way
Python's ``json`` module writes them. Changing any value therefore changes the id, and
rebuilding from the same inputs gives the same id.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from cardvision.bank.build import (
    AGGREGATION,
    BANK_KIND,
    GROUPS_KIND,
    PREPROCESSING,
    groups_path_for,
    preprocessing_descriptor,
)
from cardvision.bank.documents import canonical_bytes, read_json, sha256_hex, write_document
from cardvision.core.bank import ART_VERSION_KEY, IdentityGroups, decode_bank, is_art_version
from cardvision.core.bank_binary import is_binary_bank, read_bank_bytes, read_bank_file
from cardvision.core.catalog import IDENTITY_NAME, IDENTITY_RULES, CatalogError, parse_catalog
from cardvision.core.constants import DETECTOR_FACE_CLASS, DETECTOR_MIN_CROP_PX, DETECTOR_PARITY_SCORE_FLOOR
from cardvision.core.preprocess import FULL128
from cardvision.recognize.accept import ACCEPT_KEYS, AcceptRule, accept_errors

RELEASE_SCHEMA_VERSION = 1
RELEASE_KIND = "vision-release"

DETECTOR_ARMS = ("yolox",)
WEIGHT_FORMATS = ("fp32", "fp16w")
IDENTITY_LEVELS = IDENTITY_RULES
IDENTITY_LEVEL = IDENTITY_NAME  # the level of a release whose catalog states no rule
IDENTITY_DISPLAYS = ("best-printing", "representative")
HOVER_SELECTIONS = ("detector-score", "accepted-nms", "best-score")
EXECUTION_PROVIDERS = ("webgpu", "wasm")
YOLOX_STRIDES = (8, 16, 32)

_TOP_KEYS = ("schemaVersion", "kind", "id", "game", "locale", "detector", "recognizer", "bank", "identity",
             "catalog", "accept", "hover", "runtime")
_SETTINGS_KEYS = ("detector", "recognizer", "identity", "hover", "runtime")
_SEAL_KEYS = ("path", "sha256", "bytes")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


class ReleaseError(ValueError):
    """A release cannot be built, or fails its checks. ``errors`` lists every reason."""

    def __init__(self, errors: list[str] | str) -> None:
        self.errors = [errors] if isinstance(errors, str) else list(errors)
        super().__init__("\n".join(self.errors))


# --------------------------------------------------------------------------------- defaults
def yolox_anchor_count(width: int, height: int) -> int:
    """How many predictions a YOLOX head makes for an input of this size (strides 8, 16, 32)."""
    return sum((width // stride) * (height // stride) for stride in YOLOX_STRIDES)


def default_detector(width: int = 640, height: int = 384) -> dict[str, Any]:
    """The detector block for a two-class YOLOX model, without its file seal and version.

    The decode contract: the frame is resized by one ratio to fit ``width`` x ``height``, placed
    at the top-left of a canvas filled with ``pad`` and fed as BGR on the 0 to 255 scale. Each
    output row is a box center and size in canvas pixels, an objectness and one score per
    class. A box's score is its objectness times its best class score; boxes under the
    threshold are dropped, the rest go through greedy suppression that ignores the class, and
    at most ``maxProposals`` are kept.
    """
    classes = ["face", "back"]
    return {
        "arm": "yolox",
        "weights": "fp32",
        "input": {"width": width, "height": height},
        "decode": {
            "inputName": "images",
            "outputName": "output",
            "layout": "NCHW",
            "channels": "BGR",
            "scale": "0-255",
            "letterbox": {
                "width": width,
                "height": height,
                "pad": 114,
                "anchor": "top-left",
                "resize": "pillow-bilinear",
                "ratio": "min(height / frameHeight, width / frameWidth)",
                "size": "round(frame * ratio)",
            },
            "output": {
                "anchors": yolox_anchor_count(width, height),
                "columns": ["cx", "cy", "w", "h", "obj", *(f"cls_{name}" for name in classes)],
                "boxes": "cx, cy, w, h in letterbox px (decoded in the graph); frame px = / ratio",
            },
            "classes": classes,
            "score": "obj * max(cls)",
            "class": "argmax(cls)",
            "threshold": 0.3,
            "nms": {"iou": 0.45, "classAgnostic": True, "greedy": True},
            "maxProposals": 80,
        },
        "faceClass": DETECTOR_FACE_CLASS,
        "minCropPx": DETECTOR_MIN_CROP_PX,
    }


def default_settings() -> dict[str, Any]:
    """The settings a release is built with unless told otherwise.

    They are the values the Riftbound release published with this repository uses. The
    ``detector`` block is not here because it also depends on the model's input size: see
    ``default_detector``.
    """
    return {
        "recognizer": {"weights": "fp32", "preprocessing": preprocessing_descriptor(FULL128)},
        "identity": {"display": "best-printing"},
        "hover": {"selection": "accepted-nms", "maxAgeMs": 2000},
        "runtime": {
            "ortWeb": "1.29.0",
            "executionProviders": list(EXECUTION_PROVIDERS),
            "wasmThreads": 1,
            "analysisWidth": {"min": 720, "max": 1920},
        },
    }


def _merge(base: dict[str, Any], over: Mapping[str, Any]) -> dict[str, Any]:
    """``base`` with ``over`` laid on top: objects are merged key by key, anything else replaced."""
    out = copy.deepcopy(base)
    for key, value in over.items():
        if isinstance(value, Mapping) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


# ------------------------------------------------------------------------------ small checks
def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_positive_int(value: Any) -> bool:
    return _is_int(value) and value > 0


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_text(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


# ---------------------------------------------------------------------------- model inspection
@dataclass(frozen=True)
class ModelInfo:
    """The first input and first output of an ONNX model. A dynamic axis is ``None``."""

    input_name: str
    input_shape: tuple[int | None, ...]
    output_name: str
    output_shape: tuple[int | None, ...]


def inspect_model(data: bytes) -> ModelInfo:
    """Open ONNX model bytes on the CPU and read its tensor names and shapes.

    Raises ``ValueError`` when the bytes are not a model ONNX Runtime can load.
    """
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.log_severity_level = 4  # a rejected file is reported by the caller, not on stderr
    try:
        session = ort.InferenceSession(data, sess_options=options, providers=["CPUExecutionProvider"])
    except Exception as error:  # ONNX Runtime raises its own exception types
        raise ValueError(f"not a loadable ONNX model ({str(error).splitlines()[0][:120]})") from None

    def static(shape: Any) -> tuple[int | None, ...]:
        return tuple(axis if _is_int(axis) else None for axis in shape)

    first_in, first_out = session.get_inputs()[0], session.get_outputs()[0]
    return ModelInfo(first_in.name, static(first_in.shape), first_out.name, static(first_out.shape))


# ----------------------------------------------------------------------------------- the id
def release_id(doc: Mapping[str, Any]) -> str:
    """The id of a release document: 16 hex digits computed from everything but its ``id``."""
    body = {key: value for key, value in doc.items() if key != "id"}
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def with_id(doc: Mapping[str, Any]) -> dict[str, Any]:
    """The document with its ``id`` computed and placed after ``kind``."""
    body = {key: value for key, value in doc.items() if key != "id"}
    head = {key: body[key] for key in ("schemaVersion", "kind") if key in body}
    return {**head, "id": release_id(body), **{key: value for key, value in body.items() if key not in head}}


# ------------------------------------------------------------------------------ verification
def _path_problem(path: Any) -> str | None:
    """Why a pinned path is refused, or None. The browser's ``isRelativePath`` applies the same rule.

    A browser resolves the path as an address, so the rule is the URL parser's view of it: no
    scheme prefix (``http:x``, ``data:``, ``C:``), no backslash, no control character, no space at
    either end, not absolute, and no segment that is, or percent-encodes, ``.`` or ``..`` (the
    parser reads ``%2e%2e`` as ``..``).
    """
    if not _is_text(path):
        return "must be a non-empty relative path"
    if "\\" in path or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", path) \
            or re.search(r"[\x00-\x1f\x7f]", path) or path.startswith(" ") or path.endswith(" "):
        return f"{path!r} must be a plain relative path with forward slashes"
    segments = [re.sub(r"%2e", ".", segment, flags=re.IGNORECASE) for segment in path.split("/")]
    if path.startswith("/") or any(segment in (".", "..") for segment in segments):
        return f"{path!r} must stay inside the folder of the release document"
    return None


def _file_errors(label: str, block: Any, root: Path) -> tuple[list[str], bytes | None]:
    """Check one pinned file: its path, presence, size and hash. Returns its bytes when intact."""
    problem = _path_problem(block.get("path"))
    if problem:
        return [f"{label}.path {problem}"], None
    errors = []
    sha, size = block.get("sha256"), block.get("bytes")
    if not isinstance(sha, str) or not _HEX64.fullmatch(sha):
        errors.append(f"{label}.sha256 must be 64 lowercase hex digits")
    if not _is_positive_int(size):
        errors.append(f"{label}.bytes must be a whole number above 0")
    file = root / block["path"]
    if not file.is_file():
        return errors + [f"{label}: file {block['path']} is missing"], None
    body = file.read_bytes()
    if _is_positive_int(size) and len(body) != size:
        errors.append(f"{label}: {block['path']} is {len(body)} bytes, the release says {size}")
    if isinstance(sha, str) and _HEX64.fullmatch(sha) and sha256_hex(body) != sha:
        errors.append(f"{label}: sha256 of {block['path']} does not match the release")
    return errors, (None if errors else body)


def _detector_errors(det: Mapping[str, Any], model: ModelInfo | None) -> list[str]:
    errors = []
    arm = det.get("arm")
    if arm not in DETECTOR_ARMS:
        return [f"detector.arm {arm!r} is not one of {list(DETECTOR_ARMS)}"]
    if not _is_text(det.get("version")):
        errors.append("detector.version must be a non-empty label")
    if det.get("weights") not in WEIGHT_FORMATS:
        errors.append(f"detector.weights {det.get('weights')!r} is not one of {list(WEIGHT_FORMATS)}")
    size = det.get("input")
    if not isinstance(size, Mapping) or not all(_is_positive_int(size.get(key)) for key in ("width", "height")):
        return errors + ["detector.input must give a width and a height as whole numbers above 0"]
    decode = det.get("decode")
    expected = default_detector(size["width"], size["height"])["decode"]
    if not isinstance(decode, Mapping):
        return errors + ["detector.decode must be an object"]
    missing, unknown = sorted(set(expected) - set(decode)), sorted(set(decode) - set(expected))
    if missing or unknown:
        return errors + [f"detector.decode does not have the keys of the {arm} contract "
                         f"(missing {missing}, unknown {unknown})"]
    for key in ("inputName", "outputName"):
        if not _is_text(decode[key]):
            errors.append(f"detector.decode.{key} must be a tensor name")
    for key in ("layout", "channels", "scale", "score", "class"):
        if decode[key] != expected[key]:
            errors.append(f"detector.decode.{key} must be {expected[key]!r} for the {arm} contract")
    letterbox = decode["letterbox"]
    if not isinstance(letterbox, Mapping) or set(letterbox) != set(expected["letterbox"]):
        errors.append("detector.decode.letterbox does not have the keys of the contract")
    else:
        if (letterbox["width"], letterbox["height"]) != (size["width"], size["height"]):
            errors.append("detector.decode.letterbox differs from detector.input")
        if not _is_int(letterbox["pad"]) or not 0 <= letterbox["pad"] <= 255:
            errors.append("detector.decode.letterbox.pad must be a whole number from 0 to 255")
        for key in ("anchor", "resize", "ratio", "size"):
            if letterbox[key] != expected["letterbox"][key]:
                errors.append(f"detector.decode.letterbox.{key} must be {expected['letterbox'][key]!r}")
    classes = decode["classes"]
    face = det.get("faceClass")
    if not isinstance(classes, list) or not classes or not all(_is_text(name) for name in classes) \
            or len(set(classes)) != len(classes):
        errors.append("detector.decode.classes must be a list of distinct class names")
        classes = None
    if face != DETECTOR_FACE_CLASS:
        errors.append(f"detector.faceClass must be {DETECTOR_FACE_CLASS}")
    elif classes is not None and (len(classes) <= face or classes[face] != "face"):
        errors.append('detector.decode.classes must name class detector.faceClass "face"')
    output = decode["output"]
    columns = None
    if not isinstance(output, Mapping) or set(output) != set(expected["output"]):
        errors.append("detector.decode.output does not have the keys of the contract")
    else:
        columns = output["columns"]
        if classes is not None and columns != ["cx", "cy", "w", "h", "obj", *(f"cls_{name}" for name in classes)]:
            errors.append("detector.decode.output.columns must be cx, cy, w, h, obj and one cls_<name> per class")
        if output["anchors"] != yolox_anchor_count(size["width"], size["height"]):
            errors.append(
                f"detector.decode.output.anchors must be {yolox_anchor_count(size['width'], size['height'])} "
                f"for a {size['width']} x {size['height']} input"
            )
    if not _is_number(decode["threshold"]) or not 0 < decode["threshold"] < 1:
        errors.append("detector.decode.threshold must be a number between 0 and 1")
    elif decode["threshold"] < DETECTOR_PARITY_SCORE_FLOOR:
        errors.append(f"detector.decode.threshold {decode['threshold']} is below {DETECTOR_PARITY_SCORE_FLOOR}, "
                      "the lowest score at which the detector export checks box parity")
    nms = decode["nms"]
    if not isinstance(nms, Mapping) or set(nms) != {"iou", "classAgnostic", "greedy"} \
            or not _is_number(nms["iou"]) or not 0 < nms["iou"] <= 1 \
            or not isinstance(nms["classAgnostic"], bool) or nms["greedy"] is not True:
        errors.append("detector.decode.nms must give an iou above 0 and at most 1, classAgnostic and greedy: true")
    if not _is_positive_int(decode["maxProposals"]):
        errors.append("detector.decode.maxProposals must be a whole number above 0")
    if not _is_positive_int(det.get("minCropPx")):
        errors.append("detector.minCropPx must be a whole number above 0")

    if model is not None:
        if model.input_name != decode["inputName"]:
            errors.append(f"detector.decode.inputName {decode['inputName']!r} is not the model's input "
                          f"{model.input_name!r}")
        if model.output_name != decode["outputName"]:
            errors.append(f"detector.decode.outputName {decode['outputName']!r} is not the model's output "
                          f"{model.output_name!r}")
        spatial = model.input_shape[-2:] if len(model.input_shape) == 4 else (None, None)
        if any(axis is not None for axis in spatial) and spatial != (size["height"], size["width"]):
            errors.append(f"detector.input {size['width']} x {size['height']} is not the model's input size "
                          f"{spatial[1]} x {spatial[0]}")
        if isinstance(output, Mapping) and len(model.output_shape) == 3:
            _, anchors, width = model.output_shape
            if anchors is not None and anchors != output.get("anchors"):
                errors.append(f"detector.decode.output.anchors {output.get('anchors')} is not the model's {anchors}")
            if width is not None and isinstance(columns, list) and width != len(columns):
                errors.append(f"detector.decode.output.columns has {len(columns)} names, the model outputs {width}")
    return errors


def _recognizer_errors(rec: Mapping[str, Any], model: ModelInfo | None) -> list[str]:
    errors = []
    if not _is_text(rec.get("version")):
        errors.append("recognizer.version must be a non-empty label")
    if rec.get("weights") not in WEIGHT_FORMATS:
        errors.append(f"recognizer.weights {rec.get('weights')!r} is not one of {list(WEIGHT_FORMATS)}")
    if not _is_positive_int(rec.get("dim")):
        errors.append("recognizer.dim must be a whole number above 0")
    for key in ("inputName", "outputName"):
        if not _is_text(rec.get(key)):
            errors.append(f"recognizer.{key} must be a tensor name")
    pre = rec.get("preprocessing")
    known = isinstance(pre, Mapping) and pre.get("id") in PREPROCESSING and dict(pre) == PREPROCESSING[pre["id"]]
    if not known:
        errors.append(f"recognizer.preprocessing {pre!r} is not a known contract (known: {sorted(PREPROCESSING)})")
    if model is not None:
        if model.input_name != rec.get("inputName"):
            errors.append(f"recognizer.inputName {rec.get('inputName')!r} is not the model's input "
                          f"{model.input_name!r}")
        if model.output_name != rec.get("outputName"):
            errors.append(f"recognizer.outputName {rec.get('outputName')!r} is not the model's output "
                          f"{model.output_name!r}")
        if model.output_shape and model.output_shape[-1] is not None and model.output_shape[-1] != rec.get("dim"):
            errors.append(f"recognizer.dim {rec.get('dim')} is not the model's output size {model.output_shape[-1]}")
        spatial = model.input_shape[-2:] if len(model.input_shape) == 4 else (None, None)
        if known and any(axis is not None for axis in spatial) and spatial != (pre["size"], pre["size"]):
            errors.append(f"recognizer.preprocessing gives {pre['size']} x {pre['size']} inputs, "
                          f"the model takes {spatial[1]} x {spatial[0]}")
    return errors


def _parse(body: bytes | None, label: str, errors: list[str]) -> Any:
    if body is None:
        return None
    try:
        doc = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        errors.append(f"{label}: the file is not JSON")
        return None
    if not isinstance(doc, dict):
        errors.append(f"{label}: the file is not a JSON object")
        return None
    return doc


def _parse_bank(body: bytes | None, errors: list[str]) -> Any:
    """The bank document in a bank file's bytes, JSON or binary (``cardvision.core.bank_binary``)."""
    if body is None or not is_binary_bank(body):
        return _parse(body, "bank", errors)
    try:
        doc = read_bank_bytes(body)
    except ValueError as error:
        errors.append(f"bank: {error}")
        return None
    return doc


def release_errors(doc: Any, root: str | Path) -> list[str]:
    """Every reason a release document cannot be used; an empty list means it can.

    ``root`` is the folder the document's paths are relative to (the folder the document is
    in). The checks, in order: the document's shape and id; each pinned file's presence, size
    and hash; each block's own settings; and the agreement between components (the models
    against the tensor names and sizes written down, the bank against the recognizer, the
    identity groups against the bank and the catalog, the bank's ids against the catalog).
    """
    root = Path(root)
    if not isinstance(doc, Mapping):
        return ["the release is not a JSON object"]
    errors: list[str] = []
    if doc.get("schemaVersion") != RELEASE_SCHEMA_VERSION or doc.get("kind") != RELEASE_KIND:
        return [f'not a "{RELEASE_KIND}" document of schema version {RELEASE_SCHEMA_VERSION}']
    unknown = sorted(set(doc) - set(_TOP_KEYS))
    if unknown:
        errors.append(f"unknown key(s) {unknown}")
    if doc.get("id") != release_id(doc):
        errors.append(f"id {doc.get('id')!r} is not the hash of the document (which is {release_id(doc)})")
    for key in ("game", "locale"):
        if not _is_text(doc.get(key)):
            errors.append(f"{key} must be a non-empty string")

    det, rec, bank, cat = doc.get("detector"), doc.get("recognizer"), doc.get("bank"), doc.get("catalog")
    ident = doc.get("identity") if isinstance(doc.get("identity"), Mapping) else {}
    groups = ident.get("groups")
    blocks = (("detector", det), ("recognizer", rec), ("bank", bank), ("identity.groups", groups),
              ("catalog", cat), ("accept", doc.get("accept")), ("hover", doc.get("hover")),
              ("runtime", doc.get("runtime")))
    missing = [label for label, block in blocks if not isinstance(block, Mapping)]
    if missing:
        return errors + [f"incomplete release: {', '.join(missing)} missing (a release is all-or-nothing)"]

    # -- the pinned files
    found, det_body = _file_errors("detector", det, root)
    errors += found
    found, rec_body = _file_errors("recognizer", rec, root)
    errors += found
    found, bank_body = _file_errors("bank", bank, root)
    errors += found
    found, groups_body = _file_errors("identity.groups", groups, root)
    errors += found
    found, cat_body = _file_errors("catalog", cat, root)
    errors += found

    # -- the models
    models: dict[str, ModelInfo | None] = {}
    for label, body in (("detector", det_body), ("recognizer", rec_body)):
        models[label] = None
        if body is not None:
            try:
                models[label] = inspect_model(body)
            except ValueError as error:
                errors.append(f"{label}: {error}")
    errors += _detector_errors(det, models["detector"])
    errors += _recognizer_errors(rec, models["recognizer"])

    # -- the accept rule, the hover rule, the runtime
    accept = doc["accept"]
    errors += accept_errors(accept)
    hover = doc["hover"]
    if hover.get("selection") not in HOVER_SELECTIONS:
        errors.append(f"hover.selection {hover.get('selection')!r} is not one of {list(HOVER_SELECTIONS)}")
    if not _is_positive_int(hover.get("maxAgeMs")):
        errors.append("hover.maxAgeMs must be a whole number above 0")
    runtime = doc["runtime"]
    if not isinstance(runtime.get("ortWeb"), str) or not _SEMVER.fullmatch(runtime["ortWeb"]):
        errors.append("runtime.ortWeb must be an exact version of the form 1.2.3")
    providers = runtime.get("executionProviders")
    if not isinstance(providers, list) or not providers or len(set(providers)) != len(providers) \
            or not set(providers) <= set(EXECUTION_PROVIDERS):
        errors.append(f"runtime.executionProviders must list one or more of {list(EXECUTION_PROVIDERS)}, each once")
    if runtime.get("wasmThreads") != 1:
        errors.append("runtime.wasmThreads must be 1")
    widths = runtime.get("analysisWidth")
    if not isinstance(widths, Mapping) or not all(_is_positive_int(widths.get(key)) for key in ("min", "max")) \
            or widths["min"] > widths["max"]:
        errors.append("runtime.analysisWidth must give whole numbers min <= max above 0")

    # -- the bank, against the recognizer and the accept rule
    bank_doc = _parse_bank(bank_body, errors)
    bank_ids: list[str] | None = None
    if bank_doc is not None:
        try:
            bank_ids, rows = decode_bank(bank_doc)
        except ValueError as error:
            errors.append(f"bank: {error}")
            rows = None
        entries = bank_doc.get("entries") if isinstance(bank_doc.get("entries"), list) else []
        cards = len({entry.get("cardId") for entry in entries if isinstance(entry, Mapping)})
        checks = [
            (bank_doc.get("kind") == BANK_KIND, f'bank: the file is not an "{BANK_KIND}" document'),
            (bank_doc.get("version") == bank.get("version") and _is_positive_int(bank.get("version")),
             "bank.version differs from the bank file's, or is not a whole number above 0"),
            (bank_doc.get("model") == rec.get("version"),
             f"bank: the file's model {bank_doc.get('model')!r} is not recognizer.version {rec.get('version')!r}"),
            (bank_doc.get("dim") == rec.get("dim") and (rows is None or rows.shape[1] == rec.get("dim")),
             "bank: the vector size differs from recognizer.dim"),
            (bank_doc.get("preprocessing") == rec.get("preprocessing"),
             "bank: the file's preprocessing differs from recognizer.preprocessing"),
            (len(entries) == bank_doc.get("entryCount") == bank.get("entryCount"),
             "bank.entryCount, the file's entryCount and the number of entries do not all agree"),
            (cards == bank_doc.get("cardCount") == bank.get("cardCount"),
             "bank.cardCount, the file's cardCount and the number of distinct card ids do not all agree"),
            (bank.get("views") == bank_doc.get("views"), "bank.views differs from the bank file's"),
            (bank.get("aggregation") == bank_doc.get("aggregation") == AGGREGATION,
             f'bank.aggregation and the bank file\'s must both be "{AGGREGATION}"'),
            ("tau" not in bank_doc or bank_doc["tau"] == accept.get("tau"),
             f"bank: the file records tau {bank_doc.get('tau')!r}, accept.tau is {accept.get('tau')!r}"),
            ("centerMask" not in bank_doc or not isinstance(rec.get("preprocessing"), Mapping)
             or bank_doc["centerMask"] == rec["preprocessing"].get("centerMask"),
             "bank: the file's centerMask contradicts recognizer.preprocessing"),
            ("game" not in bank_doc or bank_doc["game"] == doc.get("game"), "bank: the file is for another game"),
            ("locale" not in bank_doc or bank_doc["locale"] == doc.get("locale"),
             "bank: the file is for another locale"),
        ]
        errors += [message for ok, message in checks if not ok]

    # -- the catalog, and the bank's ids against it
    catalog = None
    cat_doc = _parse(cat_body, "catalog", errors)
    if cat_doc is not None:
        try:
            catalog = parse_catalog(cat_doc, source=str(cat.get("path")))
        except CatalogError as error:
            errors.append(f"catalog: {error}")
    if catalog is not None:
        if (catalog.game, catalog.locale) != (doc.get("game"), doc.get("locale")):
            errors.append(f"catalog: the file is for {catalog.game!r} ({catalog.locale!r}), the release for "
                          f"{doc.get('game')!r} ({doc.get('locale')!r})")
        if cat.get("cardCount") != len(catalog):
            errors.append(f"catalog.cardCount {cat.get('cardCount')!r} is not the file's {len(catalog)} cards")
        if bank_ids is not None:
            lost = sorted({card_id for card_id in bank_ids if card_id not in catalog})
            if lost:
                errors.append(f"{len(lost)} bank id(s) are not in the catalog (e.g. {lost[:3]})")

    # -- identity
    # The rule is the catalog's. Without a readable catalog the level is checked for its form
    # only, and the groups file against the level.
    level = ident.get("level")
    rule = catalog.identity if catalog is not None else level if level in IDENTITY_LEVELS else IDENTITY_LEVEL
    if level not in IDENTITY_LEVELS:
        errors.append(f'identity.level must be "{rule}"')
    elif level != rule:
        errors.append(f'identity.level is "{level}", and the catalog states the identity rule "{rule}": '
                      "a release is used with the rule its catalog states")
    if ident.get("display") not in IDENTITY_DISPLAYS:
        errors.append(f"identity.display {ident.get('display')!r} is not one of {list(IDENTITY_DISPLAYS)}")
    groups_doc = _parse(groups_body, "identity.groups", errors)
    if groups_doc is not None:
        errors += _groups_errors(groups_doc, groups, bank, bank_ids, catalog, rule)
    return errors


def _groups_errors(groups_doc: Mapping[str, Any], block: Mapping[str, Any], bank: Mapping[str, Any],
                   bank_ids: list[str] | None, catalog: Any, rule: str) -> list[str]:
    """Check the groups file against its block, the bank and the catalog. ``rule`` is the
    identity rule the release is held to: the file must record it, and the groups must be the
    ones the catalog gives for the bank's ids."""
    where = "identity.groups"
    if groups_doc.get("kind") != GROUPS_KIND or not isinstance(groups_doc.get("groups"), list) \
            or not isinstance(groups_doc.get("representative"), Mapping):
        return [f'{where}: the file is not an "{GROUPS_KIND}" document']
    errors = []
    if groups_doc.get("version") != block.get("version") or not _is_positive_int(block.get("version")):
        errors.append(f"{where}.version differs from the file's, or is not a whole number above 0")
    if (groups_doc.get("rule") or {}).get("level") != rule:
        errors.append(f"{where}: the file's groups are not by {rule}")
    if (groups_doc.get("bank") or {}).get("sha256") != bank.get("sha256"):
        errors.append(f"{where}: the file was not made for this release's bank (its bank sha256 differs)")
    listed = groups_doc["groups"]
    if not all(isinstance(group, list) and len(group) >= 2 and all(_is_text(card_id) for card_id in group)
               for group in listed):
        return errors + [f"{where}: every group must list two or more card ids"]
    try:
        identity = IdentityGroups(listed, bank_ids or [],
                                  prefer=catalog.identity_anchors() if catalog is not None else ())
    except ValueError as error:
        return errors + [f"{where}: {error}"]
    if dict(groups_doc["representative"]) != identity.representative_map():
        errors.append(f"{where}: the representative map does not match the groups")
    if bank_ids is not None:
        if groups_doc.get("identityCount") != len(identity.identity_ids):
            errors.append(f"{where}: identityCount {groups_doc.get('identityCount')!r} is not the "
                          f"{len(identity.identity_ids)} identities of the bank")
        if catalog is not None and all(card_id in catalog for card_id in bank_ids):
            if sorted(identity.groups) != catalog.identity_groups(bank_ids):
                errors.append(f"{where}: the groups are not the ones the catalog's "
                              + ("names give" if catalog.identity == IDENTITY_NAME else "identity rule gives")
                              + " for the bank's ids")
    return errors


# ------------------------------------------------------------------------------------ build
def _seal(path: Path, root: Path, label: str) -> tuple[dict[str, Any], bytes]:
    path = Path(path)
    if not path.is_file():
        raise ReleaseError(f"{label}: no file at {path}")
    try:
        relative = path.resolve().relative_to(root.resolve())
    except ValueError:
        raise ReleaseError(
            f"{label}: {path} is not in or below {root}, the folder of the release document; "
            "a release names its files by paths relative to itself"
        ) from None
    body = path.read_bytes()
    return {"path": relative.as_posix(), "sha256": sha256_hex(body), "bytes": len(body)}, body


def _settings(settings: Mapping[str, Any] | None) -> dict[str, Any]:
    settings = {} if settings is None else settings
    if not isinstance(settings, Mapping):
        raise ReleaseError("the settings must be a JSON object")
    unknown = sorted(set(settings) - set(_SETTINGS_KEYS))
    if unknown:
        raise ReleaseError(f"the settings have unknown key(s) {unknown} (expected some of {list(_SETTINGS_KEYS)})")
    for key, block in settings.items():
        if not isinstance(block, Mapping):
            raise ReleaseError(f'the settings\' "{key}" must be an object')
        pinned = sorted(set(block) & set(_SEAL_KEYS))
        if pinned:
            raise ReleaseError(f'the settings\' "{key}" may not set {pinned}: they are computed from the file')
    return dict(settings)


def compose_release(
    out: str | Path,
    *,
    detector: str | Path,
    recognizer: str | Path,
    bank: str | Path,
    catalog: str | Path,
    accept: AcceptRule | Mapping[str, Any],
    identity_groups: str | Path | None = None,
    detector_version: str | None = None,
    recognizer_version: str | None = None,
    settings: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Put a release document together from its component files, without writing or checking it.

    ``out`` is where the document will live; every component must be in that folder or below
    it. ``accept`` is the accept rule, as ``cardvision.recognize.load_accept`` returns it or as
    its stored object. ``identity_groups`` defaults to the groups file beside the bank,
    ``detector_version`` to the detector file's name without its suffix, and
    ``recognizer_version`` to the bank's ``model``. ``settings`` overrides parts of the default
    ``detector``, ``recognizer``, ``identity``, ``hover`` and ``runtime`` blocks (see
    ``default_settings``); tensor names, the detector's input size and the embedding size are
    read from the models unless it sets them.
    """
    root = Path(out).parent
    settings = _settings(settings)
    defaults = default_settings()
    if isinstance(accept, AcceptRule):
        accept = accept.to_json()
    identity_groups = groups_path_for(bank) if identity_groups is None else identity_groups

    det_seal, det_body = _seal(Path(detector), root, "detector")
    rec_seal, rec_body = _seal(Path(recognizer), root, "recognizer")
    bank_seal, bank_body = _seal(Path(bank), root, "bank")
    groups_seal, groups_body = _seal(Path(identity_groups), root, "identity groups")
    cat_seal, cat_body = _seal(Path(catalog), root, "catalog")
    try:
        det_model = inspect_model(det_body)
    except ValueError as error:
        raise ReleaseError(f"detector: {error}") from None
    try:
        rec_model = inspect_model(rec_body)
    except ValueError as error:
        raise ReleaseError(f"recognizer: {error}") from None
    problems: list[str] = []
    bank_doc = _parse_bank(bank_body, problems) or {}
    groups_doc = _parse(groups_body, "identity groups", problems) or {}
    cat_doc = _parse(cat_body, "catalog", problems) or {}
    if problems:
        raise ReleaseError(problems)

    det_over = settings.get("detector", {})
    size = det_over.get("input")
    if not isinstance(size, Mapping):
        spatial = det_model.input_shape[-2:] if len(det_model.input_shape) == 4 else (None, None)
        size = {"width": spatial[1], "height": spatial[0]} if all(spatial) else default_detector()["input"]
    if not all(_is_positive_int(size.get(key)) for key in ("width", "height")):
        raise ReleaseError("the settings' detector.input must give a width and a height above 0")
    det_block = default_detector(size["width"], size["height"])
    det_block["decode"]["inputName"], det_block["decode"]["outputName"] = det_model.input_name, det_model.output_name
    det_block = _merge(det_block, det_over)
    det_version = detector_version or det_block.pop("version", None) or Path(detector).stem
    det_block.pop("version", None)
    arm = det_block.pop("arm")

    rec_block = {
        "dim": rec_model.output_shape[-1] if rec_model.output_shape else None,
        "inputName": rec_model.input_name,
        "outputName": rec_model.output_name,
    }
    rec_block = _merge({**defaults["recognizer"], **rec_block}, settings.get("recognizer", {}))
    rec_version = recognizer_version or rec_block.pop("version", None) or bank_doc.get("model")
    rec_block.pop("version", None)
    rec_weights, rec_pre = rec_block.pop("weights"), rec_block.pop("preprocessing")

    return with_id({
        "schemaVersion": RELEASE_SCHEMA_VERSION,
        "kind": RELEASE_KIND,
        "game": cat_doc.get("game"),
        "locale": cat_doc.get("locale"),
        "detector": {"arm": arm, "version": det_version, **det_seal, **det_block},
        "recognizer": {"version": rec_version, **rec_seal, "weights": rec_weights, **rec_block,
                       "preprocessing": rec_pre},
        "bank": {"version": bank_doc.get("version"), **bank_seal, "cardCount": bank_doc.get("cardCount"),
                 "entryCount": bank_doc.get("entryCount"), "views": bank_doc.get("views"),
                 "aggregation": bank_doc.get("aggregation")},
        "identity": {"level": cat_doc.get("identity", IDENTITY_NAME),
                     "groups": {"version": groups_doc.get("version"), **groups_seal},
                     **_merge(defaults["identity"], settings.get("identity", {}))},
        "catalog": {**cat_seal,
                    "cardCount": len(cat_doc["cards"]) if isinstance(cat_doc.get("cards"), list) else None},
        "accept": {key: accept.get(key) for key in ACCEPT_KEYS} if isinstance(accept, Mapping) else accept,
        "hover": _merge(defaults["hover"], settings.get("hover", {})),
        "runtime": _merge(defaults["runtime"], settings.get("runtime", {})),
    })


def build_release(out: str | Path, *, overwrite: bool = False, **components: Any) -> dict[str, Any]:
    """Compose a release (``compose_release``), check it, and write it only if it passes.

    Returns the document. Raises ``ReleaseError`` listing every failed check, in which case
    nothing is written. An existing file with other content is replaced only with ``overwrite``.
    """
    out = Path(out)
    accept = components.get("accept")
    problems = [] if isinstance(accept, AcceptRule) else accept_errors(accept, where="the accept rule")
    if problems:
        raise ReleaseError(problems)
    doc = compose_release(out, **components)
    errors = release_errors(doc, out.parent)
    if errors:
        raise ReleaseError(errors)
    write_document(out, canonical_bytes(doc), overwrite)
    return doc


def verify_release(path: str | Path) -> dict[str, Any]:
    """Check a release file and every file it pins. Returns the document when all is well.

    Raises ``ReleaseError`` listing every failed check.
    """
    path = Path(path)
    if not path.is_file():
        raise ReleaseError(f"no release document at {path}")
    try:
        doc = read_json(path)
    except ValueError as error:
        raise ReleaseError(str(error)) from None
    errors = release_errors(doc, path.parent)
    if errors:
        raise ReleaseError(errors)
    return doc


def bank_image_records(doc: Mapping[str, Any], root: str | Path) -> tuple[int, int]:
    """How many rows of a release's bank record their source image, and how many rows it has.

    ``doc`` is a release document that passed ``release_errors`` and ``root`` the folder it is
    in. A row records its image when its entry has an ``artV`` (``cardvision.core.bank``). This
    is a count for the reader, not a check: a release does not require the field, and a bank
    without it is as valid as before.
    """
    entries = read_bank_file(Path(root) / doc["bank"]["path"]).get("entries", [])
    return sum(1 for entry in entries if is_art_version(entry.get(ART_VERSION_KEY))), len(entries)
