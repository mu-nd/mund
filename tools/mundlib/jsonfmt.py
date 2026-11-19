"""Canonical JSON for the muND data files.

Goals
-----
* **Diff friendly**: one data point per line, one metadata field per line.
* **Deterministic**: the same content always produces the same bytes, in
  Python and in JavaScript (``site/assets/js/core/jsonfmt.js``).
* **Faithful numbers**: a number is written back exactly as it was typed
  (``13.250`` stays ``13.250``).  The files remain standard JSON, so any JSON
  parser reads them; only the reported number of digits is preserved on top.

Layout rules
------------
1. Indentation is two spaces, the file ends with a single newline.
2. An object is written with one member per line.
3. An array whose elements are all scalars is written on one line.
4. Any other array is written with one element per line, and each element is
   written *inline* (on a single line, ``", "`` and ``": "`` as separators).
5. Strings are escaped as by ``JSON.stringify`` (non-ASCII is kept as is).
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

_NUMBER_RE = re.compile(r"-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?\Z")


class LexFloat(float):
    """A float that remembers how it was written."""
    __slots__ = ("lex",)


class LexInt(int):
    """An int that remembers how it was written."""
    # (int subclasses cannot declare non-empty __slots__)


def _parse_float(text: str) -> LexFloat:
    v = LexFloat(text)
    v.lex = text
    return v


def _parse_int(text: str) -> LexInt:
    v = LexInt(text)
    v.lex = text
    return v


def _reject_constant(name: str):
    raise ValueError("%s is not allowed in muND data files" % name)


def loads(text: str) -> Any:
    """Parse JSON, keeping the lexical form of every number."""
    return json.loads(text, parse_float=_parse_float, parse_int=_parse_int,
                      parse_constant=_reject_constant)


def _is_number_lexeme(text: str) -> bool:
    return bool(_NUMBER_RE.match(text))


def lexeme(value) -> str:
    """Text of a number: its written form when it was read from a file."""
    lex = getattr(value, "lex", None)
    if lex is not None and _is_number_lexeme(lex):
        return lex
    if isinstance(value, bool):
        raise TypeError("bool is not a number")
    if isinstance(value, int):
        return str(int(value))
    f = float(value)
    if math.isnan(f) or math.isinf(f):
        raise ValueError("NaN and Infinity cannot be stored")
    return repr(f)


def _scalar(value) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):
        return lexeme(value)
    raise TypeError("cannot serialise %r" % type(value))


def _is_scalar(value) -> bool:
    return not isinstance(value, (dict, list, tuple))


def _inline(value) -> str:
    if isinstance(value, dict):
        if not value:
            return "{}"
        return "{" + ", ".join("%s: %s" % (json.dumps(str(k), ensure_ascii=False), _inline(v))
                               for k, v in value.items()) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_inline(v) for v in value) + "]"
    return _scalar(value)


def _block(value, level: int) -> str:
    pad = "  " * (level + 1)
    end = "  " * level
    if isinstance(value, dict):
        if not value:
            return "{}"
        rows = ["%s%s: %s" % (pad, json.dumps(str(k), ensure_ascii=False), _block(v, level + 1))
                for k, v in value.items()]
        return "{\n" + ",\n".join(rows) + "\n" + end + "}"
    if isinstance(value, (list, tuple)):
        if all(_is_scalar(v) for v in value):
            return _inline(value)
        return "[\n" + ",\n".join(pad + _inline(v) for v in value) + "\n" + end + "]"
    return _scalar(value)


def dumps(value) -> str:
    """Serialise in the canonical muND layout (with trailing newline)."""
    return _block(value, 0) + "\n"


def compact(value) -> str:
    """Text without spaces and with sorted keys (numbers as written): the input of content hashes."""
    if isinstance(value, dict):
        return "{" + ",".join("%s:%s" % (json.dumps(str(k), ensure_ascii=False), compact(value[k]))
                              for k in sorted(value)) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(compact(v) for v in value) + "]"
    return _scalar(value)


def plain(value):
    """Convert to plain ``dict``/``list``/``int``/``float`` (drops lexemes)."""
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value)
    return value
