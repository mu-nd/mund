"""Canonical JSON for the muND data files
(twin of ``site/assets/js/core/jsonfmt.js``; shared cases: ``tests/vectors/jsonfmt.json``).

* Diff friendly: one data entry per line, one metadata field per line.
* Deterministic: a file that is read and written again gives the same bytes in Python and in
  JavaScript, unless a member name is a whole number such as ``"1"`` (JavaScript lists those first).
  Numbers computed by a program are written by each language's own rules (``1e-07`` / ``1e-7``).
* Faithful numbers: a number is written back exactly as it was typed (``13.250`` stays ``13.250``).
  The files remain standard JSON, so any JSON parser reads them; the parser here also keeps
  the written digits, and accepts finite numbers only and each member name once per object.

Layout:

1. Indentation is two spaces; the file ends with a single newline.
2. An object is written with one member per line.
3. An array whose elements are all scalars is written on one line.
4. Any other array is written with one element per line, each element inline
   (on one line, ``", "`` and ``": "`` as separators).
5. Strings are escaped as by ``JSON.stringify`` (non-ASCII is kept as is).
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

#: White space as JavaScript has it: the characters String.prototype.trim removes and
#: RegExp \s matches (Python's str.strip and re \s use a different set).
WHITESPACE = ("\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008"
              "\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
#: The same characters as the body of a regex character class, as the schemas write it.
WHITESPACE_CLASS = r"\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def strip(text: str) -> str:
    """``text`` without white space at either end (as JavaScript's ``trim``)."""
    return text.strip(WHITESPACE)


class LexFloat(float):
    """A float that remembers how it was written."""
    __slots__ = ("lex",)


class LexInt(int):
    """An int that remembers how it was written."""
    # (int subclasses cannot declare non-empty __slots__)


def _lexed(cls):
    """A number parser for ``json.loads`` that keeps the written text (finite numbers only)."""
    def parse(text: str):
        if math.isinf(float(text)):
            raise ValueError("number out of range")
        v = cls(text)
        v.lex = text
        return v
    return parse


def _reject_constant(name: str):
    raise ValueError("%s is not allowed in muND data files" % name)


def _key(k) -> str:
    """A member name as written in JSON."""
    return json.dumps(str(k), ensure_ascii=False)


def _object(pairs) -> dict:
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("member %s is written twice" % _key(key))
        out[key] = value
    return out


def loads(text: str) -> Any:
    """Parse JSON, keeping the lexical form of every number.  Numbers must be
    finite and a member name may appear only once in an object."""
    return json.loads(text, parse_float=_lexed(LexFloat), parse_int=_lexed(LexInt),
                      parse_constant=_reject_constant, object_pairs_hook=_object)


def as_dict(value) -> dict:
    """``value`` if it is a JSON object, else ``{}``."""
    return value if isinstance(value, dict) else {}


def objects(value) -> list:
    """The objects of a JSON array; ``[]`` for anything that is not an array."""
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


def is_number(value) -> bool:
    """A JSON number (``true`` and ``false`` are not numbers)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_int(value) -> bool:
    """An integer in the JSON Schema sense: 14 and 14.0 (``true`` and ``false`` are not integers)."""
    return (isinstance(value, int) and not isinstance(value, bool)) or \
        (isinstance(value, float) and value.is_integer())


def number_text(value) -> str:
    """Text of a number: its written form when it was read from a file."""
    lex = getattr(value, "lex", None)
    if lex is not None:
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
        return number_text(value)
    raise TypeError("cannot serialise %r" % type(value))


def _is_scalar(value) -> bool:
    return not isinstance(value, (dict, list, tuple))


def _inline(value) -> str:
    if isinstance(value, dict):
        if not value:
            return "{}"
        return "{" + ", ".join("%s: %s" % (_key(k), _inline(v)) for k, v in value.items()) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_inline(v) for v in value) + "]"
    return _scalar(value)


def _block(value, level: int) -> str:
    pad = "  " * (level + 1)
    end = "  " * level
    if isinstance(value, dict):
        if not value:
            return "{}"
        rows = ["%s%s: %s" % (pad, _key(k), _block(v, level + 1)) for k, v in value.items()]
        return "{\n" + ",\n".join(rows) + "\n" + end + "}"
    if isinstance(value, (list, tuple)):
        if all(_is_scalar(v) for v in value):
            return _inline(value)
        return "[\n" + ",\n".join(pad + _inline(v) for v in value) + "\n" + end + "]"
    return _scalar(value)


def dumps(value) -> str:
    """Serialise in the canonical muND layout (with trailing newline)."""
    return _block(value, 0) + "\n"


def write(path: Path, value) -> None:
    """Write ``value`` to the file ``path`` (made with its folders) in the canonical layout (Python only)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(dumps(value).encode("utf-8"))


def compact(value) -> str:
    """Text without spaces and with sorted keys (numbers as written): the input of content hashes."""
    if isinstance(value, dict):
        return "{" + ",".join("%s:%s" % (_key(k), compact(value[k])) for k in sorted(value)) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(compact(v) for v in value) + "]"
    return _scalar(value)
