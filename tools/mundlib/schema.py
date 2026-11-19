"""JSON Schema: validation and schema-driven normalisation.

The schemas are those of the repository these tools belong to
(``schema/v1``), whatever data they are applied to.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "schema" / "v1"

# file "format" -> schema file in SCHEMA_DIR
SCHEMA_FILES = {
    "muND/LT/1": "lt.schema.json",
    "muND/facilities/1": "facilities.schema.json",
    "muND/bibliography/1": "bibliography.schema.json",
    "muND/nuclides/1": "nuclides.schema.json",
    "muND/huff-factors/1": "huff-factors.schema.json",
    "muND/constants/1": "constants.schema.json",
}

_cache: Dict[str, dict] = {}


def schema_for(fmt) -> dict:
    """The schema of a file format, or None for an unknown format."""
    name = SCHEMA_FILES.get(fmt) if isinstance(fmt, str) else None
    if name is None:
        return None
    if name not in _cache:
        with open(SCHEMA_DIR / name, encoding="utf-8") as fh:
            _cache[name] = json.load(fh)
    return _cache[name]


def pointer(path) -> str:
    """JSON pointer of an error location ('' = whole document)."""
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in path)


def validate(instance: Any, schema: dict) -> List[Tuple[str, str]]:
    """Validate with the reference implementation: ``(pointer, message)`` sorted by location."""
    from jsonschema import Draft202012Validator

    out = []
    for err in Draft202012Validator(schema).iter_errors(instance):
        out.extend(_flatten(err))
    return sorted(set(out))


def _flatten(err):
    # Errors inside if/then/allOf are reported through their leaf errors,
    # which carry the precise location.
    if err.context:
        leaves = []
        for sub in err.context:
            leaves.extend(_flatten(sub))
        if leaves:
            return leaves
    message = "this member is not allowed here" if err.validator == "not" else err.message
    return [(pointer(err.absolute_path), message)]


# ---------------------------------------------------------------------------
# normalisation: canonical key order, no empty optional members
# ---------------------------------------------------------------------------

def _resolve(schema, root):
    while isinstance(schema, dict) and "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise ValueError("only local $ref is supported: %s" % ref)
        node = root
        for part in ref[2:].split("/"):
            node = node[part]
        # keywords next to $ref (description ...) are annotations in these schemas
        schema = node
    return schema


def _is_empty(value) -> bool:
    return value is None or value == "" or value == [] or value == {}


def normalize(value, schema: dict, root: dict = None):
    """Order object keys as in the schema and drop empty optional members.

    * keys listed in ``properties`` come first, in schema order; unknown keys
      follow in alphabetical order (validation then reports them);
    * strings are stripped of surrounding white space;
    * optional members that are empty (``""``, ``null``, ``[]``, ``{}``) are
      removed; required members are always kept.
    """
    root = schema if root is None else root
    schema = _resolve(schema, root) if isinstance(schema, dict) else {}
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        items = schema.get("items", {})
        return [normalize(v, items if isinstance(items, dict) else {}, root) for v in value]
    if isinstance(value, dict):
        props = schema.get("properties", {})
        required = set(schema.get("required", []))
        ordered = [k for k in props if k in value] + sorted(k for k in value if k not in props)
        out = {}
        for key in ordered:
            sub = props.get(key, {})
            v = normalize(value[key], sub if isinstance(sub, dict) else {}, root)
            if _is_empty(v) and key not in required:
                continue
            out[key] = v
        return out
    return value
