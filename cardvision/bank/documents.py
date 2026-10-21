# SPDX-License-Identifier: Apache-2.0
"""How the bank tools write and read their JSON documents.

Every document is written in one canonical form, so that building the same thing twice gives the
same bytes and a document can be named by a hash of its file: UTF-8, one-space indentation, keys
in the order the tool lays them out, non-ASCII characters written as themselves, one trailing
newline. No document carries a timestamp.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any


class DocumentExistsError(FileExistsError):
    """A file is already there with different content, and overwriting was not asked for."""


def canonical_bytes(doc: Any) -> bytes:
    """The bytes a document is written as."""
    return (json.dumps(doc, indent=1, ensure_ascii=False) + "\n").encode("utf-8")


def sha256_hex(data: bytes) -> str:
    """The SHA-256 of some bytes, as 64 lowercase hex digits."""
    return hashlib.sha256(data).hexdigest()


def read_json(path: str | Path) -> Any:
    """Parse a JSON file. A file that is not JSON raises ``ValueError`` naming it."""
    path = Path(path)
    try:
        return json.loads(path.read_bytes())
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError(f"{path.name}: not valid JSON: {error}") from None


def write_document(path: str | Path, body: bytes, overwrite: bool = False) -> bool:
    """Write ``body`` to ``path`` in one step, and say whether the file changed.

    A file that already holds exactly these bytes is left alone (returns ``False``). A file
    that holds anything else is replaced only when ``overwrite`` is set; otherwise
    ``DocumentExistsError`` is raised, because other documents may already name it by its hash.
    """
    path = Path(path)
    if path.exists():
        if path.read_bytes() == body:
            return False
        if not overwrite:
            raise DocumentExistsError(
                f"{path} already exists with different content; write to another path, or pass --overwrite to replace it"
            )
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(body)
    os.replace(temporary, path)
    return True
