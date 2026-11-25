"""JSON Schema validation and schema-driven normalisation
(twin of ``site/assets/js/core/schema.js``; shared cases: ``tests/vectors/cases.json``).

Python validates with the reference implementation (jsonschema); in a ``pattern``, a final
``$`` matches only at the end of the string, as in JavaScript.  JavaScript implements exactly
the keywords used by schema/v1/*.schema.json (SUPPORTED in schema.js); before validating, it
throws on any other keyword anywhere in the schema, on constraints next to $ref and on an
additionalProperties that is not true or false.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import jsonfmt

# the schemas of the repository these tools belong to, whatever data they are applied to
SCHEMA_DIR = Path(__file__).resolve().parents[2] / "schema" / "v1"

# file "format" -> schema file in SCHEMA_DIR
SCHEMA_FILES = {
    "muND/LT/1": "lt.schema.json",
    "muND/facilities/1": "facilities.schema.json",
    "muND/bibliography/1": "bibliography.schema.json",
    "muND/nuclides/1": "nuclides.schema.json",
    "muND/huff-factors/1": "huff-factors.schema.json",
    "muND/constants/2": "constants.schema.json",
}

_cache: Dict[str, dict] = {}


def schema_for(fmt) -> Optional[dict]:
    """The schema of a file format, or None for an unknown format."""
    name = SCHEMA_FILES.get(fmt) if isinstance(fmt, str) else None
    if name is None:
        return None
    if name not in _cache:
        with open(SCHEMA_DIR / name, encoding="utf-8") as fh:
            _cache[name] = json.load(fh)
    return _cache[name]


def _pointer(path) -> str:
    """JSON pointer of an error location ('' = whole document)."""
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in path)


def _pattern(validator, pattern, instance, schema):
    # jsonschema's own check with a final unescaped "$" read as \Z: Python's re also lets "$"
    # match before a final line feed, JavaScript only at the end of the string.
    from jsonschema import ValidationError

    ecma = pattern[:-1] + r"\Z" if re.search(r"(?<!\\)(\\\\)*\$\Z", pattern) else pattern
    if validator.is_type(instance, "string") and not re.search(ecma, instance):
        yield ValidationError("%r does not match %r" % (instance, pattern))


def validate(instance: Any, schema: dict) -> List[Tuple[str, str]]:
    """Validate with the reference implementation: ``(pointer, message)`` sorted by location."""
    from jsonschema import Draft202012Validator, validators

    validator = validators.extend(Draft202012Validator, {"pattern": _pattern})
    out = []
    for err in validator(schema).iter_errors(instance):
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
    return [(_pointer(err.absolute_path), message)]


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


def _snapshot_order(key):
    # JavaScript enumerates array indices first, then we sort by UTF-16 code units.
    if key.isascii() and key.isdigit() and len(key) <= 10 and str(int(key)) == key and int(key) < 2**32 - 1:
        return (0, int(key))
    return (1, key.encode("utf-16-be", "surrogatepass"))


def normalize(value, schema: dict, root: Optional[dict] = None, *, literal=False):
    """Order object keys as in the schema and drop empty optional members.

    * keys listed in ``properties`` come first, in schema order; unknown keys
      follow in alphabetical order (validation then reports them);
    * strings are stripped of surrounding white space (jsonfmt.strip);
    * optional members that are empty (``""``, ``null``, ``[]``, ``{}``) are
      removed; required members are always kept.
    """
    root = schema if root is None else root
    schema = _resolve(schema, root) if isinstance(schema, dict) else {}
    if isinstance(value, str):
        return value if literal else jsonfmt.strip(value)
    if isinstance(value, list):
        items = schema.get("items", {})
        return [normalize(v, items if isinstance(items, dict) else {}, root, literal=literal) for v in value]
    if isinstance(value, dict):
        props = schema.get("properties", {})
        required = set(schema.get("required", []))
        correction = schema is root.get("$defs", {}).get("correction")
        ordered = [k for k in props if k in value] + sorted(
            (k for k in value if k not in props), key=_snapshot_order if literal else None)
        out = {}
        for key in ordered:
            sub = props.get(key, {})
            v = normalize(value[key], sub if isinstance(sub, dict) else {}, root,
                          literal=literal or (correction and key in ("before", "after")))
            if not literal and _is_empty(v) and key not in required:
                continue
            out[key] = v
        return out
    return value


def canonical_text(obj) -> str:
    """Canonical text of a file's content: members in schema order, empty optional
    members dropped, canonical layout."""
    schema = schema_for(jsonfmt.as_dict(obj).get("format"))
    return jsonfmt.dumps(normalize(obj, schema) if schema is not None else obj)
