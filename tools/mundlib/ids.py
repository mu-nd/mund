"""MetaID and DataID (definition: ``docs/id-definition.md``).

    MetaID = first 12 hex digits of SHA-256( UTF-8( meta_source ) )
    DataID = first 12 hex digits of SHA-256( UTF-8( data_source ) )

    meta_source = "LT|{code}-META|{bib_norm}[|{key_norm}]"
    data_source = "LT|{code}|{element_norm}|{mass_norm}|{MetaID}[|{key_norm}]"

``[...]`` is appended only when a key is given; ``code`` is EXP, TH, CUR or
EVAL.  Values and uncertainties are not part of an identifier.  The rule is
defined for the LT sub-library, whose name is the first part of the source.
"""
from __future__ import annotations

import hashlib
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from typing import Optional

ID_LENGTH = 12
SEPARATOR = "|"


def _hash12(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:ID_LENGTH]


def normalize_bib_id(bib_id: str) -> str:
    """A bibId (``DOI:``, ``NSR:`` or ``muND:`` and a name): first entry of a
    ``;`` separated list, stripped, upper-cased."""
    return str(bib_id).split(";")[0].strip().upper()


def normalize_key(key: Optional[str]) -> str:
    """Stripped and upper-cased.  Empty string when no key is given."""
    if key is None:
        return ""
    return str(key).strip().upper()


def normalize_element(element: str) -> str:
    """Standard element symbol: one upper-case letter + optional lower-case."""
    s = str(element).strip()
    return s[:1].upper() + s[1:].lower()


def normalize_mass(mass) -> str:
    """Decimal string of ``mass x 1000`` (0 = natural abundance -> ``"0"``)."""
    try:
        lex = getattr(mass, "lex", None)
        d = Decimal(lex if lex is not None else str(mass))
    except InvalidOperation as exc:
        raise ValueError("mass is not a number: %r" % (mass,)) from exc
    return str(int((d * 1000).to_integral_value(rounding=ROUND_HALF_UP)))


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
