# SPDX-License-Identifier: Apache-2.0
"""The configuration an evaluation scores: models, bank, catalog, rules, and their hashes.

A configuration is described by a ``Spec``: the files and every setting that is not a file. A
spec comes from a release document (``spec_from_release``), which pins all of it, or from
explicit paths (``spec_from_paths``), which take the package's defaults for whatever a release
would have stated. A second configuration for a comparison is the first with some files
replaced (``Spec.replacing``). ``open_configuration`` loads a spec, and the loaded
configuration's ``describe()`` says exactly what ran: the SHA-256 of every file, the accept
rule, the hover selection and the detector's settings, so that a figure can be tied to the
bytes that produced it.

The accept rule is read by ``cardvision.recognize``'s reader and nowhere else: ``load_accept``
for an accept-rule file, ``parse_accept`` for a release document's ``accept`` block. A spec
holds the rule as that reader returned it, the recognizer is opened with it, and ``describe()``
reports the rule the recognizer holds, so a rule whose ``rotationRetry`` is false is scored
without the turned looks, in every measure, and reported as such.
"""

from __future__ import annotations

import dataclasses
import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from cardvision.core.catalog import Catalog, load_catalog
from cardvision.core.constants import DETECTOR_MIN_CROP_PX
from cardvision.detect import MAX_DETECTIONS, NMS_IOU, PAD_VALUE, SCORE_THRESHOLD, Detector
from cardvision.evaluate.hover import ACCEPTED_NMS, ACCEPTED_NMS_IOU, SELECTIONS
from cardvision.infer.frames import MAX_ANALYSIS_WIDTH, MIN_ANALYSIS_WIDTH
from cardvision.infer.pipeline import Pipeline
from cardvision.recognize import AcceptRule, Recognizer, TiltedRetry, load_accept, parse_accept, parse_tilted_retry


def file_sha256(path: str | Path) -> str:
    """The SHA-256 of a file, as 64 lowercase hex digits."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class Spec:
    """Everything a configuration is made of. Paths are files on disk; the rest are settings.

    ``identity_groups``, ``accept_file`` and ``release`` are recorded (and hashed) when given
    and are not otherwise read: identity comes from the catalog, under the rule it states
    (``Catalog.identity_of``), and the accept rule is ``rule`` (``tau``, ``delta`` and whether
    the turned looks are tried), the published model's when nothing states another. A release
    pins an identity groups file, which ``verify-release`` has checked against the catalog;
    the component files need none, so no command takes one.

    ``geometric`` is an optional settings file of the geometric stage
    (``cardvision.geometric``). It is not part of a release: it is added to whatever the rest
    of the spec describes, and recorded, with the descriptor index it pins, beside the other
    files. Without it nothing about the configuration changes.

    ``tilted`` is a release's ``tiltedRetry`` block, read: with it the recognizer gives the
    tilted retry to every face it does not accept (``cardvision.recognize.tilt``). It is a
    setting, so it stays when files are replaced.
    """

    detector: Path
    recognizer: Path
    bank: Path
    catalog: Path
    rule: AcceptRule = AcceptRule()
    selection: str = ACCEPTED_NMS
    threshold: float = SCORE_THRESHOLD
    nms_iou: float = NMS_IOU
    max_detections: int = MAX_DETECTIONS
    pad: int = PAD_VALUE
    min_crop_px: int = DETECTOR_MIN_CROP_PX
    min_width: int = MIN_ANALYSIS_WIDTH
    max_width: int = MAX_ANALYSIS_WIDTH
    contract: str | None = None
    identity_groups: Path | None = None
    accept_file: Path | None = None
    release: Path | None = None
    release_id: str | None = None
    geometric: Path | None = None
    tilted: TiltedRetry | None = None

    def replacing(
        self,
        *,
        detector: str | Path | None = None,
        recognizer: str | Path | None = None,
        bank: str | Path | None = None,
        catalog: str | Path | None = None,
        accept: str | Path | None = None,
        geometric: str | Path | None = None,
    ) -> Spec:
        """This spec with some files replaced and every setting kept.

        The result no longer belongs to a release document. Replacing the recognizer or the
        bank also lets go of the identity groups file and of the preprocessing contract the
        release named: the new bank's own declaration is used. Replacing the catalog lets go of
        the identity groups file too, so groups made from one catalog never meet another. ``accept`` is an accept-rule
        file, and replaces the whole rule: ``tau``, ``delta`` and ``rotationRetry``.
        ``geometric`` adds (or replaces) the geometric stage's settings file and leaves the
        rest, release included, as it was: the stage is not part of a release.
        """
        if geometric is not None and all(value is None for value in (detector, recognizer, bank, catalog, accept)):
            return dataclasses.replace(self, geometric=Path(geometric))
        changes: dict[str, Any] = {"release": None, "release_id": None}
        if geometric is not None:
            changes["geometric"] = Path(geometric)
        for name, value in (("detector", detector), ("recognizer", recognizer), ("bank", bank), ("catalog", catalog)):
            if value is not None:
                changes[name] = Path(value)
        if recognizer is not None or bank is not None:
            changes.update(identity_groups=None, contract=None)
        if catalog is not None:
            changes["identity_groups"] = None   # the old groups were made from another catalog
        if accept is not None:
            changes.update(rule=load_accept(accept), accept_file=Path(accept))
        return dataclasses.replace(self, **changes)


def spec_from_paths(
    detector: str | Path,
    recognizer: str | Path,
    bank: str | Path,
    catalog: str | Path,
    accept: str | Path | None = None,
    *,
    selection: str = ACCEPTED_NMS,
) -> Spec:
    """A spec from explicit files. ``accept`` is an accept-rule file (``tau``, ``delta`` and
    ``rotationRetry``, see ``cardvision.recognize.accept``); without it the published model's
    accept rule is used, with the turned looks tried. The detector runs at the package's default
    operating point."""
    spec = Spec(detector=Path(detector), recognizer=Path(recognizer), bank=Path(bank), catalog=Path(catalog),
                selection=selection)
    return spec.replacing(accept=accept) if accept is not None else spec


def spec_from_release(path: str | Path) -> Spec:
    """A spec from a release document, after checking the document and every file it pins
    (``cardvision.bank.release.verify_release``).

    The detector's threshold, suppression limit, proposal cap and padding, the smallest crop,
    the analysis widths, the accept rule and the hover selection are the release's. The accept
    rule is the release's ``accept`` block whole: with ``rotationRetry`` false no turned look is
    computed. A release whose settings this package's reference pipeline cannot follow is
    refused.
    """
    from cardvision.bank.release import TILTED_RETRY, verify_release

    path = Path(path)
    doc = verify_release(path)
    root = path.parent
    detector, decode = doc["detector"], doc["detector"]["decode"]
    problems = []
    if decode["nms"]["classAgnostic"] is not True:
        problems.append("detector.decode.nms.classAgnostic is false, and the reference detector suppresses across classes")
    if problems:
        raise ValueError(f"{path.name}: this release cannot be used here: " + "; ".join(problems))
    widths = doc["runtime"]["analysisWidth"]
    return Spec(
        detector=root / detector["path"],
        recognizer=root / doc["recognizer"]["path"],
        bank=root / doc["bank"]["path"],
        catalog=root / doc["catalog"]["path"],
        rule=parse_accept(doc["accept"], source=f"{path.name}: accept"),
        selection=doc["hover"]["selection"],
        threshold=float(decode["threshold"]),
        nms_iou=float(decode["nms"]["iou"]),
        max_detections=int(decode["maxProposals"]),
        pad=int(decode["letterbox"]["pad"]),
        min_crop_px=int(detector["minCropPx"]),
        min_width=int(widths["min"]),
        max_width=int(widths["max"]),
        contract=doc["recognizer"]["preprocessing"]["id"],
        identity_groups=root / doc["identity"]["groups"]["path"],
        release=path,
        release_id=doc["id"],
        tilted=parse_tilted_retry(doc[TILTED_RETRY], f"{path.name}: tiltedRetry") if TILTED_RETRY in doc else None,
    )


def spec_from_arguments(
    release: str | Path | None,
    detector: str | Path | None,
    recognizer: str | Path | None,
    bank: str | Path | None,
    catalog: str | Path | None,
    accept: str | Path | None,
) -> Spec:
    """The spec a command line asks for: a release document, or the component files.

    ``release`` pins every file and setting, so it cannot be given with any other argument.
    Without it, the detector, recognizer, bank and catalog are all needed. Raises
    ``ValueError`` saying what to change when the arguments do not fit either form, and
    whatever ``spec_from_release`` raises for a release that cannot be used.
    """
    parts = {"detector": detector, "recognizer": recognizer, "bank": bank, "catalog": catalog}
    if release:
        given = [f"--{name}" for name, value in {**parts, "accept": accept}.items() if value]
        if given:
            raise ValueError(f"--release pins every file and setting; do not also give {', '.join(given)}")
        return spec_from_release(release)
    missing = [f"--{name}" for name, value in parts.items() if not value]
    if missing:
        raise ValueError("give --release, or all of --detector, --recognizer, --bank and --catalog "
                         f"(missing {', '.join(missing)})")
    return spec_from_paths(detector, recognizer, bank, catalog, accept)


@dataclass
class Configuration:
    """A loaded spec, ready to run.

    Attributes:
        spec: what it was loaded from.
        pipeline: the detector and recognizer.
        catalog: the game's catalog.
        files: label to ``{"file": name, "sha256": ...}`` for the detector, the recognizer, the
            bank and the catalog, and for the identity groups, the accept-rule file and the
            release document when the spec has them. Names only, never folders.
    """

    spec: Spec
    pipeline: Pipeline
    catalog: Catalog
    files: dict[str, dict[str, str]] = field(default_factory=dict)

    @property
    def selection(self) -> str:
        return self.spec.selection

    def describe(self) -> dict[str, Any]:
        """What ran, as the report prints it. The accept rule is the one the recognizer holds."""
        spec = self.spec
        described = {
            "release": spec.release_id,
            "files": {label: dict(entry) for label, entry in self.files.items()},
            "identity": self.catalog.identity_description
                        + ("" if spec.identity_groups is not None else " (no identity groups file was given)"),
            "accept": self.pipeline.recognizer.rule.to_json(),
            "hover": {"selection": spec.selection,
                      **({"nmsIou": ACCEPTED_NMS_IOU} if spec.selection == ACCEPTED_NMS else {})},
            "detector": {"threshold": spec.threshold, "nmsIou": spec.nms_iou, "maxDetections": spec.max_detections,
                         "minCropPx": spec.min_crop_px},
            "analysisWidth": {"min": spec.min_width, "max": spec.max_width},
        }
        stage = self.pipeline.recognizer.geometric
        if stage is not None:
            from cardvision.geometric.features import cv2_module

            described["geometric"] = {**stage.config.to_json(), "opencv": cv2_module().__version__,
                                      "indexOpencv": stage.index.doc.get("opencv")}
        tilted = self.pipeline.recognizer.tilted
        if tilted is not None:
            described["tiltedRetry"] = tilted.to_json()
        return described


_FILE_LABELS = (("release", "release"), ("detector", "detector"), ("recognizer", "recognizer"), ("bank", "bank"),
                ("identity_groups", "identityGroups"), ("catalog", "catalog"), ("accept_file", "accept"),
                ("geometric", "geometric"))


def groups_identities(path: str | Path) -> dict[str, str]:
    """Card id to identity key from an identity groups file (``cardvision build-bank`` writes
    it beside the bank): the members of a group share their representative as key. Cards in no
    group are not listed; they are their own identity under any rule."""
    import json

    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    groups, representative = doc.get("groups"), doc.get("representative")
    if not isinstance(groups, list) or not isinstance(representative, dict):
        raise ValueError(f"{Path(path).name}: not an identity groups file (groups and representative are needed)")
    out: dict[str, str] = {}
    for group in groups:
        lead = next((member for member in group if member not in representative), min(group))
        for member in group:
            out[member] = "group:" + representative.get(member, lead)
    return out


def open_configuration(spec: Spec) -> Configuration:
    """Load a spec's models, bank and catalog, and hash its files.

    Raises ``FileNotFoundError`` naming the first file that is missing and ``ValueError`` for
    an unknown hover selection.
    """
    if spec.selection not in SELECTIONS:
        raise ValueError(f"unknown hover selection {spec.selection!r}; expected one of {list(SELECTIONS)}")
    files = {}
    for attribute, label in _FILE_LABELS:
        path = getattr(spec, attribute)
        if path is None:
            continue
        if not Path(path).is_file():
            raise FileNotFoundError(f"{path}: no such {label} file")
        files[label] = {"file": Path(path).name, "sha256": file_sha256(path)}
    catalog = load_catalog(spec.catalog)
    stage = None
    identities = None
    if spec.geometric is not None:
        from cardvision.geometric.stage import GeometricStage

        # With the stage, identity is read from the identity groups file when there is one (a
        # release pins it), as the browser runtime reads it; verify-release has checked that
        # it groups the bank as the catalog's rule does.
        if spec.identity_groups is not None:
            identities = groups_identities(spec.identity_groups)
        # The index must serve this bank (cardvision.geometric.index.bank_mismatch).
        stage = GeometricStage.open(spec.geometric, bank=spec.bank,
                                    identities={**catalog.identities(), **(identities or {})})
        files["geometricIndex"] = {"file": stage.config.index_path.name, "sha256": stage.config.index_sha256}
    detector = Detector.open(spec.detector, threshold=spec.threshold, nms_iou=spec.nms_iou,
                             max_detections=spec.max_detections, pad=spec.pad)
    recognizer = Recognizer.open(spec.recognizer, spec.bank, catalog, spec.rule, contract=spec.contract,
                                 geometric=stage, identities=identities, tilted=spec.tilted)
    pipeline = Pipeline(detector, recognizer, min_width=spec.min_width, max_width=spec.max_width,
                        min_crop_px=spec.min_crop_px)
    return Configuration(spec=spec, pipeline=pipeline, catalog=catalog, files=files)
