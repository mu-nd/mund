"""File labels and citation texts derived from a bibliography entry
(twin of ``site/assets/js/core/cite.js``; shared cases in ``tests/vectors/cite.json``).

A bibliography entry is a cached subset of the Crossref record of a DOI and
uses Crossref's member names::

    {"DOI": "...", "author": [{"family": "...", "given": "..."}], "title": ["..."],
     "container-title": ["..."], "short-container-title": ["..."], "volume": "...",
     "page": "...", "article-number": "...", "published": {"date-parts": [[1987, 6, 1]]}}
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

PLACEHOLDER_DOI_PREFIX = "10.1000/"


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _first(value) -> str:
    """First element of a Crossref list member such as ``title``."""
    if isinstance(value, list):
        return str(value[0]) if value else ""
    return str(value or "")


def ascii_label(text: str) -> str:
    """ASCII letters and digits of ``text`` (accents removed)."""
    folded = unicodedata.normalize("NFKD", str(text))
    return "".join(c for c in folded if c.isascii() and c.isalnum())


def _authors(reference) -> list:
    authors = _dict(reference).get("author")
    return [a for a in authors if isinstance(a, dict)] if isinstance(authors, list) else []


def _name(author: dict) -> str:
    return str(author.get("family") or author.get("name") or "")


def first_author(reference: Optional[dict]) -> str:
    authors = _authors(reference)
    return _name(authors[0]) if authors else ""


def reference_year(reference: Optional[dict]):
    parts = _dict(_dict(reference).get("published")).get("date-parts")
    try:
        return int(parts[0][0])
    except (TypeError, IndexError, ValueError):
        return None


def is_placeholder_doi(doi) -> bool:
    """``10.1000/...``: the identifier of a source without a DOI."""
    return str(doi or "").lower().startswith(PLACEHOLDER_DOI_PREFIX)


def file_label(meta: dict, reference: Optional[dict] = None) -> str:
    """Readable part of a file name: ``Suzuki1987``.

    First author and year when the bibliography knows the reference, otherwise
    the last part of the DOI.  The MetaID that follows it identifies the file.
    """
    family = ascii_label(first_author(reference))
    year = reference_year(reference)
    if family and year:
        return "%s%d" % (family, year)
    if family:
        return family
    tail = str(_dict(meta).get("bibId", "")).split("/")[-1]
    return ascii_label(tail) or "file"


def cite_text(reference: Optional[dict], bib_id: str = "") -> str:
    """``Suzuki et al., Phys. Rev. C 35, 2212 (1987)``."""
    ref = _dict(reference)
    authors = _authors(ref)
    if not authors:
        return _first(ref.get("title")) or str(bib_id)
    who = _name(authors[0])
    if len(authors) == 2:
        who += " and " + _name(authors[1])
    elif len(authors) > 2:
        who += " et al."
    journal = _first(ref.get("short-container-title")) or _first(ref.get("container-title"))
    parts = [p for p in [journal, ref.get("volume")] if p]
    text = who
    if parts:
        text += ", " + " ".join(str(p) for p in parts)
    pages = ref.get("article-number") or ref.get("page")
    if pages:
        text += ", " + re.split(r"[-–]", str(pages))[0]
    year = reference_year(ref)
    if year:
        text += " (%s)" % year
    return text
