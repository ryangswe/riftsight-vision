# SPDX-License-Identifier: Apache-2.0
"""A product's ``cdn.config.json``: everything ``cardvision cdn`` needs to know about the product
that publishes, read once and checked before anything else runs.

::

    {
      "schemaVersion": 1,
      "product": "examplegame",                  log prefix; the default user agent is "<product>-cdn-verify/1"
      "envPrefix": "EXAMPLECDN",                 EXAMPLECDN_R2_ACCOUNT_ID, _R2_ACCESS_KEY_ID, _R2_SECRET_ACCESS_KEY,
                                                 _BUCKET, _PUBLIC_BASE, _EXTENSION_IDS
      "userAgent": "examplegame-cdn-verify/1",   optional
      "forbiddenWords": ["otherproject"],        another project's names: never in a bucket, a base or a template
      "art": {"prefix": "art/", "indexKey": "art/index.json", "cacheControl": "public, max-age=86400",
              "maxImageBytes": 5242880,
              "derived": [{"name": "tooltip", "width": 640, "format": "webp", "quality": 75}]},
      "settings": {"placeholders": ["{art}", "{file}", "{cardId}", "{printedId}"],
                   "corsOrigin": "https://www.youtube.com", "obsoleteCardLink": false},
      "dataFiles": {"details": {"prefix": "data/", "namePattern": "details-<sha8>.json", "schemaVersion": 1,
                                "requiredObjectKeys": ["cards"], "maxBytes": 33554432}},
      "pages": ["privacy.html"],
      "geometric": false,
      "releases": {"legalDir": "release-legal", "runtimes": "cdn/RUNTIMES.json",
                   "bundledDocument": "dist/release/release.json"},
      "runtime": {"dir": "vendor/cardvision-browser", "verifyScript": "node/verify-release.mjs",
                  "userAgent": "examplegame-cdn-verify/1"}
    }

Paths are relative to the product's repository root, which is the config file's grandparent
(``<root>/cdn/cdn.config.json``). The keys that differ between products and switch checks on are
required, so that a key left out never turns a check off: ``schemaVersion``, ``product``,
``envPrefix``, ``forbiddenWords``, ``dataFiles``, ``pages``, ``geometric`` and
``settings.obsoleteCardLink`` (an explicit ``[]``, ``{}`` or ``false`` is fine). Every other key has
the default shown. An unknown key is refused: a misspelled switch must not silently publish with the
default. Nothing can weaken a check: ``primary`` is always on ``<public base>/<art prefix>``, and a
release document is read up to 262144 bytes, the extension's limit.

``art.derived`` (default none) lists smaller pictures made from the catalog's art at publish time,
one set per entry: ``name`` (``[a-z][a-z0-9-]*``, unique), ``width`` (64 to 4096, or ``null`` to
keep each source's own size and only re-encode; a narrower source is never enlarged), ``format``
(``"webp"``, the only one: it keeps the alpha channel) and ``quality`` (1 to 100). A set is one
file per card with art, ``<art prefix><name>/<cardId>.webp``, and its own index at
``<art prefix><name>/index.json``. The product's settings choose whether to use it: a template
such as ``https://cdn.example.com/art/tooltip/{cardId}.webp`` with the full art as a fallback.

``dataFiles`` are content-addressed JSON files that ``config.json`` names by ``{path, sha256}``
under the data file's own key (``"details"`` above). A config may name one only if the same run
publishes it or it is already live with exactly those bytes. ``pages`` are plain HTML pages served
from the CDN's root. ``geometric`` turns on the geometric stage: ``publish-geo``, ``verify-geo``,
``publish-release --geometric`` and a pointer's ``geometric`` block; with ``false`` a pointer
carrying ``geometric`` is refused. ``settings.obsoleteCardLink`` checks a ``cardLink`` field that
old extension builds required (absent or malformed: a warning; pointing at another project: an
error). ``runtime.userAgent`` is passed to the verify script as ``--user-agent`` (default
"<product>-cdn-verify/1", whatever the top-level ``userAgent``; ``false`` passes none, for a script
that takes no such option).
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

SCHEMA_VERSION = 1
DEFAULT_CONFIG_PATH = Path("cdn") / "cdn.config.json"

# The parts of the contract that every product shares.
CONFIG_KEY = "config.json"
CONFIG_CACHE = "public, max-age=300"
INDEX_CACHE = "no-cache"
# The extension reads a release document no further than this.
MAX_DOCUMENT_BYTES = 256 * 1024
# Where the extension looks for release folders: <public base>/vision/releases/<id>/.
RELEASES_PREFIX = "vision/releases/"
IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
PAGE_CACHE = "public, max-age=3600"
MAX_PAGE_BYTES = 1024 * 1024
CONTENT_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}

# config.json fields a data file's key may not take.
RESERVED_FIELDS = frozenset({"schemaVersion", "updatedAt", "namesOnly", "primary", "fallbacks", "cardLink",
                             "geometric", "release", "update"})


class Refused(Exception):
    """A guard refused the run; nothing has been uploaded when this is raised before the first put."""


class CdnConfigError(Refused):
    """The product's cdn.config.json is malformed."""


def utc_now() -> str:
    """The time stamps written into the indexes (one place, so a harness can pin it)."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


@dataclass(frozen=True)
class DataFileKind:
    """One kind of data file: ``config.json[name] = {path, sha256}`` names a file ``<prefix><name>``."""

    name: str
    prefix: str
    name_pattern: str
    name_regex: re.Pattern
    schema_version: int
    required_object_keys: tuple[str, ...]
    max_bytes: int
    cache_control: str = IMMUTABLE_CACHE


DERIVED_NAME = re.compile(r"^[a-z][a-z0-9-]*$")
DERIVED_KEYS = {"name", "width", "format", "quality"}
DERIVED_FORMATS = {"webp": "image/webp"}
DERIVED_MIN_WIDTH, DERIVED_MAX_WIDTH = 64, 4096


@dataclass(frozen=True)
class DerivedSet:
    """One smaller set of the catalog's pictures (``art.derived``)."""
    name: str
    width: Optional[int]   # None: each source's own size
    format: str
    quality: int

    @property
    def spec(self) -> dict:
        return {"name": self.name, "width": self.width, "format": self.format, "quality": self.quality}

    @property
    def spec_hash(self) -> str:
        """Changes when the name, width, format or quality does, so that the whole set is made again."""
        return hashlib.sha256(json.dumps(self.spec, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    @property
    def content_type(self) -> str:
        return DERIVED_FORMATS[self.format]

    def key(self, art_prefix: str, card_id: str) -> str:
        return f"{art_prefix}{self.name}/{card_id}.{self.format}"

    def index_key(self, art_prefix: str) -> str:
        return f"{art_prefix}{self.name}/index.json"


@dataclass(frozen=True)
class CdnConfig:
    root: Path
    product: str
    env_prefix: str
    user_agent: str
    forbidden_words: tuple[str, ...]
    art_prefix: str
    index_key: str
    art_cache: str
    max_image_bytes: int
    placeholders: tuple[str, ...]
    cors_origin: str
    obsolete_card_link: bool
    data_files: tuple[DataFileKind, ...]
    pages: tuple[str, ...]
    geometric: bool
    legal_dir: Path
    runtimes_label: str
    runtimes_path: Path
    bundled_document: Path
    verify_script: Path
    node_user_agent: Optional[str]
    derived: tuple[DerivedSet, ...] = ()

    @property
    def max_document_bytes(self) -> int:
        return MAX_DOCUMENT_BYTES

    @property
    def releases_prefix(self) -> str:
        return RELEASES_PREFIX

    def env(self, name: str) -> str:
        """The environment variable ``<envPrefix>_<name>``."""
        return f"{self.env_prefix}_{name}"

    @property
    def env_keys(self) -> tuple[str, ...]:
        return tuple(self.env(k) for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "BUCKET", "PUBLIC_BASE"))

    @property
    def releases_index_key(self) -> str:
        return self.releases_prefix + "index.json"

    def data_kind(self, name: str) -> Optional[DataFileKind]:
        return next((k for k in self.data_files if k.name == name), None)


REQUIRED = ("product", "envPrefix", "forbiddenWords", "dataFiles", "pages", "geometric")
_TOP = {"schemaVersion", "product", "envPrefix", "userAgent", "forbiddenWords", "art", "settings", "dataFiles",
        "pages", "geometric", "releases", "runtime", "$comment"}
_ART = {"prefix": "art/", "indexKey": "art/index.json", "cacheControl": "public, max-age=86400",
        "maxImageBytes": 5 * 1024 * 1024,
        "derived": []}
_SETTINGS = {"placeholders": ["{art}", "{file}", "{cardId}", "{printedId}"],
             "corsOrigin": "https://www.youtube.com", "obsoleteCardLink": None}
_DATA = {"prefix": "data/", "namePattern": None, "schemaVersion": 1, "requiredObjectKeys": [], "maxBytes": 32 * 1024 * 1024}
_RELEASES = {"legalDir": "release-legal", "runtimes": "cdn/RUNTIMES.json",
             "bundledDocument": "dist/release/release.json"}
_RUNTIME = {"dir": "vendor/cardvision-browser", "verifyScript": "node/verify-release.mjs", "userAgent": None}

_FIELD = re.compile(r"^[A-Za-z][A-Za-z0-9]*$")
_PREFIX = re.compile(r"^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)+$")
_PAGE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*\.html$")


def _section(raw: dict, key: str, defaults: dict, label: str) -> dict:
    value = raw.get(key, {})
    if not isinstance(value, dict):
        raise CdnConfigError(f"{label}: {key} must be an object")
    unknown = sorted(set(value) - set(defaults) - {"$comment"})
    if unknown:
        raise CdnConfigError(f"{label}: unknown key(s) in {key}: {', '.join(unknown)}")
    return {**defaults, **{k: v for k, v in value.items() if k != "$comment"}}


def _string(value: Any, what: str, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise CdnConfigError(f"{label}: {what} must be a non-empty string")
    return value


def _int(value: Any, what: str, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise CdnConfigError(f"{label}: {what} must be a positive integer")
    return value


def _bool(value: Any, what: str, label: str) -> bool:
    if not isinstance(value, bool):
        raise CdnConfigError(f"{label}: {what} must be true or false")
    return value


def _prefix(value: Any, what: str, label: str) -> str:
    value = _string(value, what, label)
    if not _PREFIX.match(value) or any(part in (".", "..") for part in value.split("/")):
        raise CdnConfigError(f"{label}: {what} must be a clean relative folder ending in '/' ({value!r})")
    return value


def _derived_sets(value: Any, label: str) -> tuple[DerivedSet, ...]:
    if not isinstance(value, list):
        raise CdnConfigError(f"{label}: art.derived must be a list of sets")
    out: list[DerivedSet] = []
    for i, spec in enumerate(value):
        at = f"art.derived[{i}]"
        if not isinstance(spec, dict):
            raise CdnConfigError(f"{label}: {at} must be an object")
        spec = {k: v for k, v in spec.items() if k != "$comment"}
        unknown = sorted(set(spec) - DERIVED_KEYS)
        if unknown:
            raise CdnConfigError(f"{label}: unknown key(s) in {at}: {', '.join(unknown)}")
        missing = sorted(DERIVED_KEYS - set(spec))
        if missing:
            raise CdnConfigError(f"{label}: {at} needs {', '.join(missing)} (width may be null)")
        name, width, fmt, quality = spec["name"], spec["width"], spec["format"], spec["quality"]
        if not isinstance(name, str) or not DERIVED_NAME.match(name):
            raise CdnConfigError(f"{label}: {at}.name must be lowercase letters, digits and '-', starting with a letter")
        if any(d.name == name for d in out):
            raise CdnConfigError(f"{label}: {at}.name {name!r} is used twice")
        if width is not None and (not isinstance(width, int) or isinstance(width, bool)
                                  or not DERIVED_MIN_WIDTH <= width <= DERIVED_MAX_WIDTH):
            raise CdnConfigError(f"{label}: {at}.width must be {DERIVED_MIN_WIDTH} to {DERIVED_MAX_WIDTH}, or null")
        if fmt not in DERIVED_FORMATS:
            raise CdnConfigError(f"{label}: {at}.format must be \"webp\" (the only format that keeps alpha and is "
                                 f"small), not {fmt!r}")
        if not isinstance(quality, int) or isinstance(quality, bool) or not 1 <= quality <= 100:
            raise CdnConfigError(f"{label}: {at}.quality must be 1 to 100")
        out.append(DerivedSet(name, width, fmt, quality))
    return tuple(out)


def _relative(root: Path, value: Any, what: str, label: str) -> Path:
    value = _string(value, what, label)
    if value.startswith("/") or "\\" in value or ".." in value.split("/"):
        raise CdnConfigError(f"{label}: {what} must be a path relative to the repository root ({value!r})")
    return root / value


def _name_regex(pattern: str, what: str, label: str) -> re.Pattern:
    if pattern.count("<sha8>") != 1 or not pattern.endswith(".json") or "/" in pattern:
        raise CdnConfigError(f"{label}: {what} must be a flat .json name with one <sha8> (e.g. data-<sha8>.json)")
    before, after = pattern.split("<sha8>")
    if not re.fullmatch(r"[A-Za-z0-9._-]*", before + after):
        raise CdnConfigError(f"{label}: {what} may hold letters, digits, '.', '_', '-' and <sha8> only")
    return re.compile("^" + re.escape(before) + "([0-9a-f]{8})" + re.escape(after) + "$")


def cdn_config_from_dict(raw: object, root: Path, label: str = "cdn.config.json") -> CdnConfig:
    """Check a parsed cdn.config.json and return the product's settings."""
    if not isinstance(raw, dict):
        raise CdnConfigError(f"{label}: not a JSON object")
    if raw.get("schemaVersion") != SCHEMA_VERSION or isinstance(raw.get("schemaVersion"), bool):
        raise CdnConfigError(f"{label}: schemaVersion must be exactly {SCHEMA_VERSION}")
    unknown = sorted(set(raw) - _TOP)
    if unknown:
        raise CdnConfigError(f"{label}: unknown key(s): {', '.join(unknown)}")
    missing = [k for k in REQUIRED if k not in raw]
    if "settings" not in raw or (isinstance(raw["settings"], dict) and "obsoleteCardLink" not in raw["settings"]):
        missing.append("settings.obsoleteCardLink")
    if missing:
        raise CdnConfigError(f"{label}: required key(s) missing: {', '.join(missing)} (an explicit [], {{}} or false is "
                             "fine; a key left out would turn a check off)")
    product = _string(raw.get("product"), "product", label)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", product):
        raise CdnConfigError(f"{label}: product must be lowercase letters, digits and '-'")
    env_prefix = _string(raw.get("envPrefix"), "envPrefix", label)
    if not re.fullmatch(r"[A-Z][A-Z0-9]*", env_prefix) or env_prefix == "R2":
        raise CdnConfigError(f"{label}: envPrefix must be capital letters and digits (not R2), e.g. EXAMPLECDN")
    user_agent = _string(raw.get("userAgent", f"{product}-cdn-verify/1"), "userAgent", label)
    words = raw["forbiddenWords"]
    if not isinstance(words, list) or not all(isinstance(w, str) and w and w == w.lower() for w in words):
        raise CdnConfigError(f"{label}: forbiddenWords must be a list of lowercase strings")

    art = _section(raw, "art", _ART, label)
    settings = _section(raw, "settings", _SETTINGS, label)
    releases = _section(raw, "releases", _RELEASES, label)
    runtime = _section(raw, "runtime", _RUNTIME, label)

    derived = _derived_sets(art["derived"], label)
    placeholders = settings["placeholders"]
    if not isinstance(placeholders, list) or not all(isinstance(p, str) and re.fullmatch(r"\{[A-Za-z]+\}", p) for p in placeholders):
        raise CdnConfigError(f"{label}: settings.placeholders must be a list like [\"{{art}}\", \"{{cardId}}\"]")
    cors_origin = _string(settings["corsOrigin"], "settings.corsOrigin", label)
    if not cors_origin.startswith("https://"):
        raise CdnConfigError(f"{label}: settings.corsOrigin must be an https:// origin")

    raw_data = raw["dataFiles"]
    if not isinstance(raw_data, dict):
        raise CdnConfigError(f"{label}: dataFiles must be an object")
    kinds = []
    for name, spec in raw_data.items():
        if name == "$comment":
            continue
        if not _FIELD.match(name) or name in RESERVED_FIELDS:
            raise CdnConfigError(f"{label}: dataFiles key {name!r} must be a config.json field name of its own")
        if not isinstance(spec, dict):
            raise CdnConfigError(f"{label}: dataFiles.{name} must be an object")
        spec = _section(raw_data, name, _DATA, label)
        pattern = _string(spec["namePattern"], f"dataFiles.{name}.namePattern", label)
        required = spec["requiredObjectKeys"]
        if not isinstance(required, list) or not all(isinstance(k, str) and k for k in required):
            raise CdnConfigError(f"{label}: dataFiles.{name}.requiredObjectKeys must be a list of strings")
        kinds.append(DataFileKind(
            name=name, prefix=_prefix(spec["prefix"], f"dataFiles.{name}.prefix", label), name_pattern=pattern,
            name_regex=_name_regex(pattern, f"dataFiles.{name}.namePattern", label),
            schema_version=_int(spec["schemaVersion"], f"dataFiles.{name}.schemaVersion", label),
            required_object_keys=tuple(required), max_bytes=_int(spec["maxBytes"], f"dataFiles.{name}.maxBytes", label)))
    for i, a in enumerate(kinds):
        for b in kinds[i + 1:]:
            if a.name_pattern == b.name_pattern:
                raise CdnConfigError(f"{label}: dataFiles {a.name} and {b.name} share a namePattern")

    pages = raw["pages"]
    if not isinstance(pages, list) or not all(isinstance(p, str) and _PAGE.match(p) for p in pages):
        raise CdnConfigError(f"{label}: pages must be a list of flat .html names")
    if CONFIG_KEY in pages:
        raise CdnConfigError(f"{label}: pages may not name {CONFIG_KEY}")

    node_ua = runtime["userAgent"]
    if node_ua is None:
        node_ua = f"{product}-cdn-verify/1"
    elif node_ua is False:
        node_ua = None
    else:
        node_ua = _string(node_ua, "runtime.userAgent", label)
    runtime_dir = _relative(root, runtime["dir"], "runtime.dir", label)
    script = _string(runtime["verifyScript"], "runtime.verifyScript", label)
    if script.startswith("/") or ".." in script.split("/"):
        raise CdnConfigError(f"{label}: runtime.verifyScript must be relative to runtime.dir")

    return CdnConfig(
        root=root,
        product=product,
        env_prefix=env_prefix,
        user_agent=user_agent,
        forbidden_words=tuple(words),
        art_prefix=_prefix(art["prefix"], "art.prefix", label),
        index_key=_string(art["indexKey"], "art.indexKey", label),
        art_cache=_string(art["cacheControl"], "art.cacheControl", label),
        max_image_bytes=_int(art["maxImageBytes"], "art.maxImageBytes", label),
        placeholders=tuple(placeholders),
        cors_origin=cors_origin,
        obsolete_card_link=_bool(settings["obsoleteCardLink"], "settings.obsoleteCardLink", label),
        data_files=tuple(kinds),
        pages=tuple(pages),
        geometric=_bool(raw["geometric"], "geometric", label),
        legal_dir=_relative(root, releases["legalDir"], "releases.legalDir", label),
        runtimes_label=_string(releases["runtimes"], "releases.runtimes", label),
        runtimes_path=_relative(root, releases["runtimes"], "releases.runtimes", label),
        bundled_document=_relative(root, releases["bundledDocument"], "releases.bundledDocument", label),
        verify_script=runtime_dir / script,
        node_user_agent=node_ua,
        derived=derived,
    )


def load_cdn_config(path: Path) -> CdnConfig:
    """Read ``<root>/cdn/cdn.config.json``; the repository root is the file's grandparent."""
    path = Path(path)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise CdnConfigError(f"{path}: no such file (pass --cdn-config, or run from the product's repository root)")
    except json.JSONDecodeError as e:
        raise CdnConfigError(f"{path}: not JSON ({e})")
    return cdn_config_from_dict(raw, path.resolve().parent.parent, label=str(path))
