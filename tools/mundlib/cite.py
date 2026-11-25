"""Names and citation texts of the sources, and how to cite the project paper and a version of
the database (twin of ``site/assets/js/core/cite.js``; shared cases: ``tests/vectors/cite.json``).
Links to the sources and BibTeX are made in JavaScript only.

The source of a metadata record (``bibId``) is named by its DOI
(``DOI:10.1103/PhysRevC.35.2212``); a source without one by its keynumber in
Nuclear Science References (``NSR:1987SU06``); a source found in neither by a
muND key (``muND:Suzuki1975thesis``).

A bibliography entry is found by its ``id``, the bibId.  It is a cached subset
of the Crossref record of the source and uses Crossref's member names::

    {"id": "DOI:...", "author": [{"family": "...", "given": "..."}], "title": ["..."],
     "container-title": ["..."], "short-container-title": ["..."], "volume": "...",
     "page": "...", "article-number": "...", "published": {"date-parts": [[1987, 6, 1]]}}
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

from .jsonfmt import WHITESPACE_CLASS, as_dict, objects, strip

#: The forms of a bibId: prefix and pattern of the name.  The bibId pattern of the schemas is
#: ``^(DOI:name|NSR:name|muND:name)$`` with these names; ``$`` is the end of the bibId.
BIB_ID_FORMS = (
    ("DOI", r"10\.[0-9]{4,9}/[^" + WHITESPACE_CLASS + ";|]+"),
    ("NSR", r"[0-9]{4}[A-Za-z]{2}[A-Za-z0-9]{2}"),
    ("muND", r"[A-Za-z0-9][A-Za-z0-9._-]*"),
)
_NAME_PATTERNS = {prefix: re.compile(pattern) for prefix, pattern in BIB_ID_FORMS}


def _first(value) -> str:
    """First element of a Crossref list member such as ``title``."""
    if isinstance(value, list):
        return str(value[0]) if value else ""
    return str(value or "")


def ascii_label(text: str) -> str:
    """Fold Basic Latin, Latin-1, Latin Extended-A/B and Latin Extended Additional to ASCII."""
    latin = re.sub(r"[^\x00-\u024f\u1e00-\u1eff]", "", str(text))
    folded = unicodedata.normalize("NFKD", latin)
    return "".join(c for c in folded if c.isascii() and c.isalnum())


def _authors(reference) -> list:
    return objects(as_dict(reference).get("author"))


def _name(author: dict) -> str:
    return str(author.get("family") or author.get("name") or "")


def first_author(reference: Optional[dict]) -> str:
    authors = _authors(reference)
    return _name(authors[0]) if authors else ""


def reference_year(reference: Optional[dict]):
    parts = as_dict(as_dict(reference).get("published")).get("date-parts")
    try:
        return int(parts[0][0])
    except (TypeError, IndexError, KeyError, ValueError):
        return None


def _split_bib_id(bib_id):
    prefix, sep, name = strip(str(bib_id or "")).partition(":")
    return (prefix, name) if sep else ("", prefix)


def bib_kind(bib_id) -> str:
    """``DOI``, ``NSR`` or ``muND``: the prefix of a valid bibId; ``""`` when
    ``bib_id`` has none of these forms."""
    prefix, name = _split_bib_id(bib_id)
    pattern = _NAME_PATTERNS.get(prefix)
    return prefix if pattern and pattern.fullmatch(name) else ""


def is_bib_id(bib_id) -> bool:
    """Whether ``bib_id`` has one of the forms DOI:, NSR: or muND:."""
    return bib_kind(bib_id) != ""


def bib_name(bib_id) -> str:
    """The part after the prefix: the DOI, the keynumber or the name of the muND key."""
    return _split_bib_id(bib_id)[1] if bib_kind(bib_id) else strip(str(bib_id or ""))


def file_label(meta: dict, reference: Optional[dict] = None) -> str:
    """Readable part of a file name: ``Suzuki1987``.

    First author and year when the bibliography knows the reference, otherwise
    the last part of the name of the bibId.  The MetaID that follows it
    identifies the file.
    """
    family = ascii_label(first_author(reference))
    year = reference_year(reference)
    if family and year:
        return "%s%d" % (family, year)
    if family:
        return family
    tail = bib_name(as_dict(meta).get("bibId", "")).split("/")[-1]
    return ascii_label(tail) or "file"


def cite_text(reference: Optional[dict], bib_id: str = "") -> str:
    """``Suzuki et al., Phys. Rev. C 35, 2212 (1987)``."""
    ref = as_dict(reference)
    authors = [name for name in map(_name, _authors(ref)) if name]
    if not authors:
        return _first(ref.get("title")) or str(bib_id)
    who = authors[0]
    if len(authors) == 2:
        who += " and " + authors[1]
    elif len(authors) > 2:
        who += " et al."
    journal = _first(ref.get("short-container-title")) or _first(ref.get("container-title"))
    parts = [p for p in [journal, ref.get("volume")] if p]
    text = who
    if parts:
        text += ", " + " ".join(str(p) for p in parts)
    location = ref.get("article-number") or re.split(r"[-–]", str(ref.get("page") or ""))[0]
    if location:
        text += ", " + str(location)
    year = reference_year(ref)
    if year:
        text += " (%s)" % year
    return text


#: Physical Review lists up to ten authors; with more, the first one and "et al.".
MAX_NAMES = 10


def initials(given) -> str:
    """'Yukinobu' -> 'Y.', 'Jean-Pierre' -> 'J.-P.', 'T. Y.' -> 'T. Y.'"""
    words = re.split("[%s]+" % WHITESPACE_CLASS, strip(str(given or "")))
    return " ".join("-".join(part[0] + "." for part in word.split("-") if part) for word in words)


def _aps_authors(authors: list) -> str:
    """Authors as in Physical Review: 'Y. Watanabe', 'A and B', 'A, B, and C', 'A et al.'"""
    names = ["%s %s" % (initials(a.get("given")), a["family"]) for a in authors]
    if len(names) > MAX_NAMES:
        return names[0] + " et al."
    if len(names) <= 2:
        return " and ".join(names)
    return ", ".join(names[:-1]) + ", and " + names[-1]


def citations(config: dict, manifest: dict, url: Optional[str] = None) -> dict:
    """How to cite, in the style of Physical Review: ``{"paper": ..., "database": ...}``
    (paper None when the paper has no authors).  ``config`` is site/config.json
    (``paper``, ``data``, ``siteUrl``), ``manifest`` that of the version; the database
    is cited with the address of the explorer showing this version.  The site gives
    the address itself (``citationTexts`` in cite.js)."""
    paper = config.get("paper") or {}
    data = config.get("data") or {}
    year = str(manifest.get("date") or "")[:4]
    if manifest.get("kind") == "release":
        version = "version %s" % manifest["version"]
    else:
        commit = ", commit %s" % str(manifest["commit"])[:7] if manifest.get("commit") else ""
        version = "development version %s%s, not a stable version" % (manifest["version"], commit)
    if url is None:
        url = "%sexplorer/?v=%s" % (config.get("siteUrl", ""), manifest["label"])
    paper_text = None
    if paper.get("authors"):
        where = "arXiv:%s" % paper["arxiv"] if paper.get("arxiv") else paper.get("url")
        paper_text = "%s, %s, %s (%s)." % (_aps_authors(paper["authors"]), paper["title"], where, paper["year"])
    return {
        "paper": paper_text,
        "database": "%s, %s, %s%s, %s." % (data.get("author"), data.get("title"), version, " (%s)" % year if year else "", url),
    }
