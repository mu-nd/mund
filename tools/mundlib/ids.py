"""MetaID and DataID as defined in ``docs/id-definition.md``
(twin of ``site/assets/js/core/ids.js``; shared cases: ``tests/vectors/ids.json``).
"""
from __future__ import annotations

import hashlib
import re
import string
from decimal import Context, Decimal, ROUND_HALF_UP
from typing import Optional

from .jsonfmt import is_number, number_text, strip

ID_LENGTH = 12
SEPARATOR = "|"
_ASCII_UPPER = str.maketrans(string.ascii_lowercase, string.ascii_uppercase)
# a decimal number as ids.js accepts it: optional sign, digits, optional point, optional exponent (ASCII digits only)
_DECIMAL = re.compile(r"[+-]?(?=\.?\d)\d*(?:\.\d*)?(?:[eE][+-]?\d+)?", re.ASCII)


def _hash12(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:ID_LENGTH]


def normalize_bib_id(bib_id: str) -> str:
    """A bibId (``DOI:``, ``NSR:`` or ``muND:`` and a name): stripped, upper-cased."""
    return strip(str(bib_id)).upper()


def normalize_key(key: Optional[str]) -> str:
    """Stripped, with ASCII letters upper-cased. Empty string when no key is given."""
    if key is None:
        return ""
    return strip(str(key)).translate(_ASCII_UPPER)


def normalize_element(element: str) -> str:
    """Standard element symbol: one upper-case letter + optional lower-case."""
    s = strip(str(element))
    return s[:1].upper() + s[1:].lower()


def normalize_mass(mass) -> str:
    """Decimal string of ``mass x 1000`` (0 = natural abundance -> ``"0"``), computed exactly on the
    decimal text and rounded half away from zero, as ``normalizeMass`` in ids.js."""
    text = number_text(mass) if is_number(mass) else strip(str(mass))
    if not _DECIMAL.fullmatch(text):
        raise ValueError("mass is not a number: %r" % (mass,))
    milli = Decimal(text).scaleb(3, Context(prec=len(text)))   # exact: the text has at most len(text) digits
    return str(int(milli.to_integral_value(rounding=ROUND_HALF_UP)))


def meta_source(sublibrary: str, code: str, bib_id: str, key: Optional[str] = None) -> str:
    parts = [sublibrary, code + "-META", normalize_bib_id(bib_id)]
    k = normalize_key(key)
    if k:
        parts.append(k)
    return SEPARATOR.join(parts)


def data_source(sublibrary: str, code: str, element: str, mass, meta_id: str,
                key: Optional[str] = None) -> str:
    parts = [sublibrary, code, normalize_element(element), normalize_mass(mass), meta_id]
    k = normalize_key(key)
    if k:
        parts.append(k)
    return SEPARATOR.join(parts)


def meta_id(sublibrary: str, code: str, bib_id: str, key: Optional[str] = None) -> str:
    return _hash12(meta_source(sublibrary, code, bib_id, key))


def data_id(sublibrary: str, code: str, element: str, mass, meta_id: str,
            key: Optional[str] = None) -> str:
    return _hash12(data_source(sublibrary, code, element, mass, meta_id, key))
