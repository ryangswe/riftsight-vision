# SPDX-License-Identifier: Apache-2.0
"""``cardvision try``: the steps of ``docs/your-game.md`` in one command.

It runs the existing commands one after the other (``import-catalog``, ``check-catalog``,
``build-bank``, ``build-release``, ``verify-release`` and ``infer``) and writes a report page,
``report.html``, that says what came out and what to do next. The work is in ``run``; the
page in ``report``; the arguments in ``cli``.
"""
