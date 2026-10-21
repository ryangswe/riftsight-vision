# SPDX-License-Identifier: Apache-2.0
"""Shared fixtures: the generated toy game and a throwaway embedding model."""

from __future__ import annotations

import ipaddress
import socket
from pathlib import Path

import numpy as np
import pytest

import toy_game
from helpers import EMBEDDING_WIDTH


_CONNECT = socket.socket.connect
_CONNECT_EX = socket.socket.connect_ex


def _loopback(address) -> bool:
    host = address[0] if isinstance(address, tuple) else address
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """No test reaches the network: a connection to anything but this computer is refused.

    Tests that need a server start one on 127.0.0.1. A test that fakes being offline and misses
    a code path fails here instead of downloading for real."""

    def guard(connect):
        def guarded(self, address):
            if self.family in (socket.AF_INET, socket.AF_INET6) and not _loopback(address):
                raise OSError(f"tests may not reach the network (asked for {address!r})")
            return connect(self, address)
        return guarded

    monkeypatch.setattr(socket.socket, "connect", guard(_CONNECT))
    monkeypatch.setattr(socket.socket, "connect_ex", guard(_CONNECT_EX))


@pytest.fixture(scope="session")
def toy(tmp_path_factory) -> tuple[Path, Path]:
    """``(catalog path, art folder)`` of a freshly drawn toy game."""
    return toy_game.write_toy_game(tmp_path_factory.mktemp("toy-game"))


@pytest.fixture(scope="session")
def tiny_model(tmp_path_factory) -> Path:
    """An ONNX model with the recognizer's interface and none of its skill.

    Input ``(n, 3, 128, 128)`` float32, output ``(n, 128)`` float32: a 16 x 16 average pool,
    flattened and multiplied by a fixed random matrix. It is deterministic, cheap, and tells the
    four orientations of an image apart, which is all the tests need. It is built at run time
    so that no model file lives in the repository.
    """
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    weights = np.random.default_rng(42).normal(size=(3 * 8 * 8, EMBEDDING_WIDTH)).astype(np.float32)
    graph = helper.make_graph(
        [
            helper.make_node("AveragePool", ["x"], ["pooled"], kernel_shape=[16, 16], strides=[16, 16]),
            helper.make_node("Flatten", ["pooled"], ["flat"], axis=1),
            helper.make_node("MatMul", ["flat", "weights"], ["y"]),
        ],
        "tiny",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, ["n", 3, 128, 128])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT, ["n", EMBEDDING_WIDTH])],
        [numpy_helper.from_array(weights, "weights")],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    path = tmp_path_factory.mktemp("model") / "tiny.onnx"
    onnx.save(model, str(path))
    return path

