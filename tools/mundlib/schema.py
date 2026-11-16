"""JSON Schema handling: validation and schema-driven normalisation."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, List, Tuple

SCHEMA_VERSION = "v1"

# file "format" value -> schema file
SCHEMA_FILES = {
    "muND/LT/1": "lt.schema.json",
    "muND/facilities/1": "facilities.schema.json",
    "muND/bibliography/1": "bibliography.schema.json",
}


def schema_dir(root: Path) -> Path:
    return Path(root) / "schema" / SCHEMA_VERSION


def load_schema(root: Path, name: str) -> dict:
    with open(schema_dir(root) / name, encoding="utf-8") as fh:
        return json.load(fh)


def pointer(path) -> str:
    """JSON pointer of an error location ('' = whole document)."""
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in path)


def validate(instance: Any, schema: dict) -> List[Tuple[str, str, str]]:
    """Validate with the reference implementation.

    Returns ``(pointer, keyword, message)`` tuples sorted by location.
    """
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
    message = err.message
    if err.validator == "not" and err.validator_value == {}:
        message = "this member is not allowed for this dataset type"
    return [(pointer(err.absolute_path), str(err.validator), message)]


# ---------------------------------------------------------------------------
# Schema-driven normalisation (canonical key order, no empty optional fields)
# ---------------------------------------------------------------------------

def _resolve(schema, root):
    while isinstance(schema, dict) and "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise ValueError("only local $ref is supported: %s" % ref)
        node = root
        for part in ref[2:].split("/"):
            node = node[part]
        # sibling keywords of $ref (e.g. description) do not affect the shape
        schema = node
    return schema


def _is_empty(value) -> bool:
    return value is None or value == "" or value == [] or value == {}


def normalize(value, schema: dict, root: dict = None):
    """Order object keys as in the schema and drop empty optional members.

    * keys listed in ``properties`` come first, in schema order; unknown keys
      follow in alphabetical order (they will then fail validation);
    * strings are stripped of surrounding white space;
    * optional members that are empty (``""``, ``null``, ``[]``, ``{}``) are
      removed; required members are always kept.
    """
    root = schema if root is None else root
    schema = _resolve(schema, root) if isinstance(schema, dict) else {}
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        items = schema.get("items", {}) if isinstance(schema, dict) else {}
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
