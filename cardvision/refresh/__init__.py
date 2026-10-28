# SPDX-License-Identifier: Apache-2.0
"""The release gate of a card-data refresh: a candidate release that only appends cards to the
live one, judged before it replaces it.

* ``check``: the structural preconditions (nothing but new rows and new catalog entries);
* ``diff``: two ``evaluate hover`` runs compared event by event;
* ``subset``: the catalog of the new cards, for generated new-card scenes;
* ``verdict``: a rule written before any of the new data was seen and frozen by its SHA-256,
  applied to the diffs (gate R) and to the new-card runs (gate N). Its numbers follow the
  schema ``refresh-rule/1`` (``rule_schema.json``); ``docs/refresh-rule-template.md`` is the
  text to write one from.

Each is a function taking explicit paths (``check_release``, ``diff_runs``, ``subset_catalog``,
``judge``) and a step of ``cardvision refresh``.
"""

from cardvision.refresh.check import check_release
from cardvision.refresh.diff import diff_runs
from cardvision.refresh.subset import subset_catalog
from cardvision.refresh.verdict import RuleError, judge, load_rule

__all__ = ["RuleError", "check_release", "diff_runs", "judge", "load_rule", "subset_catalog"]
