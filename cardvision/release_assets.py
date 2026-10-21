# SPDX-License-Identifier: Apache-2.0
"""The files of the v0.1.0 release of this repository: what each is called, how large it is and
its SHA-256. ``cardvision fetch-weights`` checks every download against this table, and a test
holds it equal to the table in ``docs/release-files.md``."""

from __future__ import annotations

from typing import NamedTuple

RELEASE_TAG = "v0.1.0"
MODEL_RELEASE_ID = "201478a00d6ef6ba"
BASE_URL = "https://github.com/ryangswe/riftsight-vision/releases/download/v0.1.0/"


class Asset(NamedTuple):
    name: str
    bytes: int
    sha256: str


# SHA256SUMS lists the other seven in the form ``shasum -c`` reads.
SUMS_NAME = "SHA256SUMS"
ASSETS: tuple[Asset, ...] = (
    Asset("release.json", 2601, "5054fc41bc3d85a66d934e494ef9f114a7b27ac08eca0a6328c95750428e0a73"),
    Asset("detector.onnx", 3701029, "dd9dc32b74756d83316bf8347784f09fad69d6f54c55384c1d093cb312727185"),
    Asset("recognizer.onnx", 4015458, "a65ee03103893c39f8a0bbde9b3d18b8540130205df7883c4467b2673c47fd3b"),
    Asset("bank.json", 628787, "8dd173a237a19bcd86c52b3cdb88b54f726e690c1d9e19f1bec6d75e63ce969e"),
    Asset("identity-groups.json", 20029, "1c4cf595abc76aa71a338e4ca16344f7a652b8023416d7cd57a1555148cefc61"),
    Asset("catalog.json", 163727, "75e563c8aa39cda85e6f24b683dbb1311cc7c4c18d809df2808a5f36fbfc855d"),
    Asset("accept.json", 57, "b3a3ec47fcfdaafc0923707218eeb056684e5b1407611a6e716c47fdb8b26dc3"),
    Asset(SUMS_NAME, 561, "c8e5555b2aa6d11dbd78962e2502eac010ead82804c78233d9f5699f91d5b126"),
)
