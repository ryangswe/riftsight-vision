# SPDX-License-Identifier: Apache-2.0
"""Name the card in a crop: embed it, compare it with the bank, apply the accept rule."""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

from cardvision.core.bank import load_bank
from cardvision.core.catalog import Catalog
from cardvision.core.onnx import DEFAULT_PROVIDERS, Preprocess, create_session, output_width, run_batched
from cardvision.core.preprocess import CONTRACTS, FULL128, preprocessor, rot4
from cardvision.recognize.accept import NAMED, NOTHING, AcceptRule, Choice, choose_look
from cardvision.recognize.crops import Box
from cardvision.recognize.looks import (
    NO_OTHER_IDENTITY,
    Look,
    bank_transposed,
    best_identities,
    best_rows,
    identity_columns,
    score_look,
    similarities,
)
from cardvision.recognize.tilt import TiltedOutcome, TiltedRetry, tilted_rects

if TYPE_CHECKING:
    import onnxruntime as ort

    from cardvision.geometric.stage import GeometricOutcome, GeometricStage

# How many candidates a recognition carries beside the decision, for people to look at.
CANDIDATE_ROWS = 5
CANDIDATE_NAMES = 3


@dataclass(frozen=True)
class Candidate:
    """One bank row a crop was compared with."""

    card_id: str
    name: str
    similarity: float


@dataclass(frozen=True)
class Recognition:
    """What the recognizer concluded about one crop.

    Attributes:
        name: the card's name when one is named, otherwise ``None``.
        card_id: the id of the best-matching printing when a card is named, otherwise ``None``.
        top_id: the best bank row's card id, whether or not it was accepted.
        top_name: that card's name.
        similarity: the chosen look's score.
        margin: the chosen look's margin over the best card of another identity.
        look: the chosen orientation (0 upright, ``k`` quarter turns counter-clockwise).
        retried: whether the three turned looks were computed.
        tau_passed: whether the score reaches ``tau``.
        accepted: whether the accept rule passed, that is, whether a card is named.
        rows: the chosen look's best bank rows, best first (several may be one identity).
        names: the chosen look's best cards of different identities, best first, each
            represented by its best-scoring printing.
        geometric: with a geometric stage, what it found and what the answer was without it;
            ``None`` without one. With a stage, ``top_id``, ``similarity``, ``margin`` and the
            outcome are those of the fused scores, and ``rows`` and ``names`` are ranked by them.
        tilted: with the tilted retry, on a crop it was tried on: the tilt, the rectangle that
            named the card (or none), and the answer before it; ``None`` when it was not tried.
            When a rectangle named the card, ``top_id``, ``similarity``, ``margin``, ``rows`` and
            ``names`` are that rectangle's, and ``look`` is the look it was embedded at.
    """

    name: str | None
    card_id: str | None
    top_id: str
    top_name: str
    similarity: float
    margin: float
    look: int
    retried: bool
    tau_passed: bool
    accepted: bool
    rows: tuple[Candidate, ...] = ()
    names: tuple[Candidate, ...] = ()
    geometric: GeometricOutcome | None = None
    tilted: TiltedOutcome | None = None

    @property
    def outcome(self) -> str:
        """``"named"`` or ``"nothing"``."""
        return NAMED if self.accepted else NOTHING

    @property
    def named_by_tilt(self) -> bool:
        """Whether one of the tilted retry's rectangles named the card."""
        return self.tilted is not None and self.tilted.scale is not None


def declared_contract(bank_doc: Mapping[str, Any]) -> str | None:
    """The preprocessing contract id a bank document declares, if it declares one.

    Accepts ``"preprocessing": "full128"`` and ``"preprocessing": {"id": "full128", ...}``.
    """
    declared = bank_doc.get("preprocessing")
    if isinstance(declared, Mapping):
        declared = declared.get("id")
    return declared if isinstance(declared, str) else None


class Recognizer:
    """An embedding model, its bank and its accept rule.

    ``ids`` and ``rows`` are the bank as ``cardvision.core.bank.load_bank`` returns it;
    ``names`` maps every bank card id to its name. ``identities`` maps every bank card id to its
    identity key (``Catalog.identities()``, which ``open`` passes): two cards of one identity
    never count against each other, and a named result reports the best-matching printing.
    A caller that has names and no catalog may leave ``identities`` out; cards that share a
    name are then one identity.

    ``geometric`` is an optional ``cardvision.geometric.stage.GeometricStage``. Without one the
    recognizer is exactly what it was before the stage existed. With one, ``recognize`` passes
    each crop and the chosen look's ranking to the stage and decides on the fused scores
    (``_geometric_recognition``); ``looks`` and ``decide``, which serve the threshold search,
    refuse to run, because the stage needs the crop itself.

    ``tilted`` turns on the tilted retry (``cardvision.recognize.tilt``) with a release's
    ``tiltedRetry`` settings. It needs the frame, so it runs only when ``recognize`` is given the
    frame and the boxes; ``looks`` and ``decide`` refuse to run with it.
    """

    def __init__(
        self,
        session: ort.InferenceSession,
        ids: Sequence[str],
        rows: np.ndarray,
        names: Mapping[str, str],
        rule: AcceptRule = AcceptRule(),
        preprocess: Preprocess | None = None,
        identities: Mapping[str, str] | None = None,
        geometric: GeometricStage | None = None,
        tilted: TiltedRetry | None = None,
    ) -> None:
        rows = np.asarray(rows, dtype=np.float32)
        if rows.ndim != 2 or len(rows) != len(ids) or len(ids) == 0:
            raise ValueError(f"expected a non-empty bank with one row per id: {len(ids)} ids, rows of shape {rows.shape}")
        try:
            width = output_width(session)
        except ValueError:
            width = None  # the model does not declare its embedding width; the first run will tell
        if width is not None and rows.shape[1] != width:
            raise ValueError(f"the bank's rows have {rows.shape[1]} values but the model's embeddings have {width}")
        self.session = session
        self.ids = list(ids)
        self.rule = rule
        self.preprocess = preprocess if preprocess is not None else preprocessor(FULL128)
        self.column_identity = identity_columns(self.ids, names if identities is None else identities)
        self._names = [names[card_id] for card_id in self.ids]
        self._bank_t = bank_transposed(rows)
        self.geometric = geometric
        self.tilted = tilted
        self._columns: dict[str, list[int]] = {}
        for column, card_id in enumerate(self.ids):
            self._columns.setdefault(card_id, []).append(column)

    @classmethod
    def open(
        cls,
        model_path: str | Path,
        bank_path: str | Path,
        catalog: Catalog,
        rule: AcceptRule = AcceptRule(),
        *,
        contract: str | None = None,
        providers: Sequence[str] = DEFAULT_PROVIDERS,
        geometric: GeometricStage | None = None,
        identities: Mapping[str, str] | None = None,
        tilted: TiltedRetry | None = None,
    ) -> Recognizer:
        """Open a recognizer from its ONNX file, its bank file and the game's catalog.

        The preprocessing contract is ``contract`` when given, otherwise the one the bank
        declares, otherwise ``full128``. A bank that declares a contract this package does not
        implement is an error, since its rows could not be compared with anything computed here.
        """
        ids, rows, doc = load_bank(bank_path)
        if contract is None:
            contract = declared_contract(doc) or FULL128
            if contract not in CONTRACTS:
                raise ValueError(
                    f"{Path(bank_path).name} declares the preprocessing contract {contract!r}, "
                    f"which is not one of {sorted(CONTRACTS)}"
                )
        session = create_session(model_path, providers=providers)
        identities = catalog.identities() if identities is None else {**catalog.identities(), **identities}
        return cls(session, ids, rows, catalog.names(), rule, preprocessor(contract), identities, geometric=geometric,
                   tilted=tilted)

    def _candidate(self, column: int, row: np.ndarray) -> Candidate:
        return Candidate(card_id=self.ids[column], name=self._names[column], similarity=float(row[column]))

    def _turned_rows(self, tensors: Sequence[np.ndarray], which: Sequence[int]) -> np.ndarray:
        """Similarities of the three turned looks of ``tensors[i]`` for each ``i`` in ``which``, as
        ``(len(which), 3, N)``. The turned tensors are embedded in one batch, in that order."""
        if not which:
            return np.zeros((0, 3, self._bank_t.shape[1]))
        turned = [look for i in which for look in rot4(tensors[i])[1:]]
        flat = run_batched(self.session, turned)
        return similarities(flat.reshape(len(which), 3, flat.shape[-1]), self._bank_t)

    def _recognition(self, choice: Choice, row: np.ndarray | None = None, first: bool = False) -> Recognition:
        """The ``Recognition`` of a crop whose look was chosen. ``row`` is the chosen look's
        similarities, for the candidates; without it the result carries none. With ``first``
        the chosen top row leads both candidate lists even where ``row`` ranks another higher
        (the accept booster keeps its answer whatever the fused scores of other cards)."""
        top = choice.look.top
        rows: tuple[Candidate, ...] = ()
        names: tuple[Candidate, ...] = ()
        if row is not None:
            columns = best_rows(row, CANDIDATE_ROWS)
            leaders = best_identities(row, self.column_identity, CANDIDATE_NAMES)
            if first:
                columns = [top, *[c for c in best_rows(row, CANDIDATE_ROWS + 1) if c != top]][:CANDIDATE_ROWS]
                leaders = [top, *[c for c in best_identities(row, self.column_identity, CANDIDATE_NAMES + 1)
                                  if self.column_identity[c] != self.column_identity[top]]][:CANDIDATE_NAMES]
            rows = tuple(self._candidate(c, row) for c in columns)
            names = tuple(self._candidate(c, row) for c in leaders)
        return Recognition(
            name=self._names[top] if choice.accepted else None,
            card_id=self.ids[top] if choice.accepted else None,
            top_id=self.ids[top],
            top_name=self._names[top],
            similarity=choice.look.score,
            margin=choice.look.margin,
            look=choice.orientation,
            retried=choice.retried,
            tau_passed=choice.tau_passed,
            accepted=choice.accepted,
            rows=rows,
            names=names,
        )

    def recognize(self, crops: Sequence[np.ndarray], source_type: str | None = None, *,
                  frame: np.ndarray | None = None, boxes: Sequence[Box] | None = None,
                  tilted: bool = True) -> list[Recognition]:
        """One ``Recognition`` per ``(H, W, 3)`` uint8 RGB crop.

        ``source_type`` is the kind of footage the crops come from (a manifest's
        ``source_type``), or ``None`` when it is not known. Only a geometric stage reads it: its
        ``gate`` settings may keep it from running on some sources, or on crops the embedding
        already accepts (``GeometricStage.applies``). Without a stage it changes nothing.

        Every crop is embedded upright in one batch. The crops whose upright look is not
        accepted are then embedded at one, two and three quarter turns in a second batch, and
        the orientation rule picks among the four (``cardvision.recognize.accept``). The turns
        are applied to the preprocessed tensor, not to the crop. A rule whose ``rotation_retry``
        is false skips the second batch: every crop is judged on its upright look alone.

        With the tilted retry on (``self.tilted``), ``frame`` the ``(H, W, 3)`` uint8 RGB frame the
        crops were cut from and ``boxes`` their unrounded ``(x, y, width, height)`` boxes in it,
        every crop still not accepted after that is retried (``_tilted_retry``). ``tilted`` false
        skips it for this call: a caller's own condition, such as the kind of footage. Without a
        frame it does not run.
        """
        if len(crops) == 0:
            return []
        if frame is not None and (boxes is None or len(boxes) != len(crops)):
            raise ValueError("recognize: a frame needs one box per crop")
        tensors = [self.preprocess(crop) for crop in crops]
        upright_rows = similarities(run_batched(self.session, tensors), self._bank_t)
        uprights = [score_look(row, self.column_identity) for row in upright_rows]

        retry = [i for i, look in enumerate(uprights) if not self.rule.accepts(look)] if self.rule.rotation_retry else []
        slot = {i: j for j, i in enumerate(retry)}
        turned_rows = self._turned_rows(tensors, retry)

        results = []
        for i, upright in enumerate(uprights):
            def rotations(i: int = i) -> list[Look]:
                return [score_look(row, self.column_identity) for row in turned_rows[slot[i]]]

            choice = choose_look(upright, rotations, self.rule)
            row = upright_rows[i] if choice.orientation == 0 else turned_rows[slot[i]][choice.orientation - 1]
            if self.geometric is None or not self.geometric.applies(source_type, choice.accepted):
                results.append(self._recognition(choice, row))
            else:
                results.append(self._geometric_recognition(choice, row, crops[i]))
        if self.tilted is not None and tilted and frame is not None:
            results = self._tilted_retry(results, crops, frame, boxes)
        return results

    def _tilted_retry(self, results: list[Recognition], crops: Sequence[np.ndarray], frame: np.ndarray,
                      boxes: Sequence[Box]) -> list[Recognition]:
        """``results`` after the tilted retry of every crop that is not accepted.

        Each such crop's straightened rectangles (``tilted_rects``) are embedded in one batch, each
        at the crop's chosen look: the look with the highest score among those computed, which is
        the look its recognition reports. A rectangle whose look the accept rule accepts may name
        the card: the one with the highest score, the earlier scale on equal scores. A geometric
        stage's findings stay on the recognition either way.
        """
        settings = self.tilted
        assert settings is not None
        which = [i for i, found in enumerate(results) if not found.accepted]
        if not which:
            return results
        scales = settings.scales
        tilts: dict[int, float] = {}
        tensors = []
        for i in which:
            tilts[i], rects = tilted_rects(frame, boxes[i], crops[i], scales)
            tensors.extend(rot4(self.preprocess(rect))[results[i].look] for rect in rects)
        rows = similarities(run_batched(self.session, tensors), self._bank_t)
        out = list(results)
        for j, i in enumerate(which):
            before = out[i]
            best: tuple[int, Look, np.ndarray] | None = None
            for q in range(len(scales)):
                row = rows[j * len(scales) + q]
                look = score_look(row, self.column_identity)
                if self.rule.accepts(look) and (best is None or look.score > best[1].score):
                    best = (q, look, row)
            if best is None:
                out[i] = dataclasses.replace(before, tilted=TiltedOutcome(
                    tilt=tilts[i], scale=None, top_id=before.top_id, similarity=before.similarity,
                    margin=before.margin))
                continue
            q, look, row = best
            choice = Choice(orientation=before.look, look=look, retried=before.retried, tau_passed=True, accepted=True)
            out[i] = dataclasses.replace(
                self._recognition(choice, row), geometric=before.geometric,
                tilted=TiltedOutcome(tilt=tilts[i], scale=scales[q], top_id=before.top_id,
                                     similarity=before.similarity, margin=before.margin))
        return out

    def _geometric_recognition(self, choice: Choice, row: np.ndarray, crop: np.ndarray) -> Recognition:
        """The ``Recognition`` of a crop when a geometric stage verifies its candidates.

        The orientation rule has already chosen a look, on the cosines alone. The stage is
        given the crop and that look's ranking of the cards (each card by its best row); each
        verified card's rows are then moved by the difference between its fused score and its
        cosine. With ``fusion.reorder`` the best fused row names the crop. Without it (the
        accept booster) the identity of the chosen look's best row stays the answer: the crop is
        named by that identity's best fused row, which may be another printing than the cosine's
        best, and its margin is taken over the best fused row of any other identity. The accept
        rule judges the fused score and margin.
        """
        before = self._recognition(choice, row)
        order = np.argsort(-row, kind="stable")
        ranked = list(dict.fromkeys(self.ids[column] for column in order))
        best = {card_id: float(row[self._columns[card_id]].max()) for card_id in ranked}
        result = self.geometric.verify(crop, [(card_id, best[card_id]) for card_id in ranked], known=self._columns)
        fused = np.array(row, dtype=np.float64, copy=True)
        for found in result.candidates:
            for column in self._columns[found.card_id]:
                fused[column] += found.fused - found.cosine
        if self.geometric.config["fusion"]["reorder"]:
            look = score_look(fused, self.column_identity)
        else:
            same = self.column_identity == self.column_identity[choice.look.top]
            masked = np.where(same, fused, -np.inf)
            top = int(np.argmax(masked))
            other = float(fused[~same].max()) if (~same).any() else NO_OTHER_IDENTITY
            look = Look(top=top, score=float(fused[top]), margin=float(fused[top]) - other)
        fused_choice = Choice(orientation=choice.orientation, look=look, retried=choice.retried,
                              tau_passed=self.rule.passes_tau(look), accepted=self.rule.accepts(look))
        from cardvision.geometric.stage import GeometricOutcome

        outcome = GeometricOutcome(top_id=before.top_id, similarity=before.similarity, margin=before.margin,
                                   accepted=before.accepted, result=result)
        return dataclasses.replace(self._recognition(fused_choice, fused, first=True), geometric=outcome)

    def looks(self, crops: Sequence[np.ndarray]) -> list[tuple[Look, ...]]:
        """The looks of each ``(H, W, 3)`` uint8 RGB crop, upright first, before any threshold.

        ``recognize`` computes a crop's turned looks only when its upright look is not
        accepted, so which looks it computes depends on ``tau`` and ``delta``. This computes
        them for every crop, once, so that many pairs of thresholds can be tried on the same
        looks (``decide``): all four looks of a crop when this recognizer's rule has
        ``rotation_retry`` true, and the upright look alone when it is false, since the turned
        looks are then never used.

        The upright looks are embedded in one batch, as in ``recognize``, and every crop's
        three turned looks in a second. A look is the same here and there as long as the
        model's answer for one input does not depend on the other inputs of its batch.
        """
        self._refuse_geometric("looks")
        if len(crops) == 0:
            return []
        tensors = [self.preprocess(crop) for crop in crops]
        upright_rows = similarities(run_batched(self.session, tensors), self._bank_t)
        uprights = [score_look(row, self.column_identity) for row in upright_rows]
        if not self.rule.rotation_retry:
            return [(upright,) for upright in uprights]
        turned_rows = self._turned_rows(tensors, range(len(tensors)))
        return [(upright, *(score_look(row, self.column_identity) for row in turned))
                for upright, turned in zip(uprights, turned_rows)]

    def decide(self, looks: Sequence[Look], rule: AcceptRule | None = None) -> Recognition:
        """What ``recognize`` concludes about a crop that has these looks, under ``rule`` (this
        recognizer's own when omitted).

        ``looks`` are a crop's looks as ``looks`` returns them. The orientation rule is the one
        ``recognize`` applies (``choose_look``): with the retry on, the turned looks count only
        when the upright look is not accepted. A rule with the retry on needs all four looks.
        The result carries no candidates: ``rows`` and ``names`` are empty.
        """
        self._refuse_geometric("decide")
        return self._recognition(choose_look(looks[0], lambda: looks[1:], self.rule if rule is None else rule))

    def _refuse_geometric(self, method: str) -> None:
        if self.geometric is not None:
            raise ValueError(f"Recognizer.{method} works on looks alone, and the geometric stage needs the crop: "
                             "use recognize, or a recognizer without the stage")
        if self.tilted is not None:
            raise ValueError(f"Recognizer.{method} works on looks alone, and the tilted retry needs the frame: "
                             "use recognize, or a recognizer without the retry")
