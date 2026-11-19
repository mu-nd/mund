"""The API: JSON files for programs, one set per published version.

    api/versions.json                        the versions (the same as data/versions.json)
    api/<label>/info.json                    version, citation, licence and contents
    api/<label>/LT/index.json                elements, nuclides and sources, with their files
    api/<label>/LT/<El>.json                 all entries of an element           (Si.json)
    api/<label>/LT/<El>-<A>.json             all entries of a nuclide            (Si-28.json)
    api/<label>/LT/<El>-nat.json             targets of natural isotopic abundance
    api/<label>/LT/<type>.json               all entries of one kind of data     (evaluated.json)
    api/<label>/LT/entry/<datasetId>.json    one entry
    api/<label>/LT/meta/<metaId>.json        one source and all its entries

The files are static: they are made when the site is built, from the
published files of the version (data/<label>/manifest.json, master.json,
LT.json), for the development version and for every stable version alike.
Every file of entries has the same form (format ``muND/api/LT/1``): the
version and how to cite it, what the file holds (``selection``), and the
``bibliography``, ``meta`` and ``data`` of those entries as in LT.json.  Each
entry has one member more than in LT.json: ``converted``, the lifetime,
capture rate and capture probability computed from the value given in the
source, as in the columns of the CSV files.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

from . import CODE_OF, jsonfmt
from .cite import cite_text
from .convert import Physics, combined_uncertainty
from .ids import normalize_doi

FORMAT = "muND/api/LT/1"


def initials(given: str) -> str:
    """'Yukinobu' -> 'Y.', 'Jean-Pierre' -> 'J.-P.', 'T. Y.' -> 'T. Y.'"""
    return " ".join("-".join(part[:1] + "." for part in word.split("-")) for word in str(given or "").split())


def _aps_authors(authors: List[dict]) -> str:
    """Authors as in Physical Review: up to ten names; with more, the first one and "et al."."""
    names = ["%s %s" % (initials(a.get("given")), a["family"]) for a in authors]
    if len(names) > 10:
        return names[0] + " et al."
    if len(names) <= 2:
        return " and ".join(names)
    return ", ".join(names[:-1]) + ", and " + names[-1]


def citations(config: dict, manifest: dict) -> dict:
    """How to cite, as on the site (site/assets/js/explorer/citation.js, the style of
    Physical Review): ``{"paper": ..., "database": ...}``.  ``config`` is site/config.json
    (``paper``, ``data``, ``siteUrl``); the database is cited with the address of the
    explorer showing this version."""
    paper = config.get("paper") or {}
    data = config.get("data") or {}
    year = str(manifest.get("date") or "")[:4]
    if manifest.get("kind") == "release":
        version = "version %s" % manifest["version"]
    else:
        commit = ", commit %s" % manifest["commit"][:7] if manifest.get("commit") else ""
        version = "development version %s%s, not a stable version" % (manifest["version"], commit)
    url = "%sexplorer/?v=%s" % (config.get("siteUrl", ""), manifest["label"])
    paper_text = None
    if paper.get("authors"):
        where = "arXiv:%s" % paper["arxiv"] if paper.get("arxiv") else paper.get("url")
        paper_text = "%s, %s, %s (%s)." % (_aps_authors(paper["authors"]), paper["title"], where, paper["year"])
    return {
        "paper": paper_text,
        "database": "%s, %s, %s%s, %s." % (data.get("author"), data.get("title"), version, " (%s)" % year if year else "", url),
    }


def nuclide_name(nuclide: dict) -> str:
    """Si-28, Si-nat (natural isotopic abundance), Ta-180m1."""
    mass = nuclide.get("mass") or 0
    name = "%s-%s" % (nuclide["element"], mass if mass else "nat")
    return name + ("m%d" % nuclide["isomer"] if nuclide.get("isomer") else "")


def _rounded(x):
    return None if x is None else float("%.6g" % x)


def build_api(dist: Path, out: Path, config: Optional[dict] = None) -> int:
    """Write the API of the version in ``dist`` (data/<label>/) to ``out`` (api/<label>/).
    Returns the number of files written."""
    dist, out = Path(dist), Path(out)
    config = config or {}
    manifest = json.loads((dist / "manifest.json").read_text(encoding="utf-8"))
    master = json.loads((dist / "master.json").read_text(encoding="utf-8"))
    lt = jsonfmt.loads((dist / "LT.json").read_text(encoding="utf-8"))
    label = manifest["label"]
    elements = master["nuclides"]["elements"]
    z_of = {e: i + 1 for i, e in enumerate(elements)}
    physics = Physics(master["huff_factors"], master["constants"])
    metas = {m["id"]: m for m in lt["meta"]}
    references = {normalize_doi(r["DOI"]): r for r in lt["bibliography"]}
    head = {
        "format": FORMAT, "label": label, "version": manifest["version"], "kind": manifest["kind"],
        "commit": manifest.get("commit"), "date": manifest.get("date"),
        "citation": citations(config, manifest),
        "dataLicence": config.get("dataLicence"),
    }

    def with_converted(entry: dict) -> dict:
        block = entry["observable"][entry["observable"]["kind"]]
        n = entry["nuclide"]
        conv = physics.convert(z_of.get(n["element"], 0), n["mass"], entry["observable"]["kind"], block["value"],
                               combined_uncertainty(block.get("uncertainties")), block["unit"])
        out_entry = dict(entry)
        out_entry["converted"] = None if conv is None else {
            k: (v if k in ("huff_factor", "huff_source") else _rounded(v)) for k, v in conv.items()}
        return out_entry

    count = 0

    def emit(rel: str, obj):
        nonlocal count
        path = out / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(jsonfmt.dumps(obj), encoding="utf-8")
        count += 1

    def entries_file(rel: str, selection: dict, entries: List[dict]):
        ids = {e["metaId"] for e in entries}
        meta = [m for m in lt["meta"] if m["id"] in ids]
        dois = {normalize_doi(e["bibId"]) for e in entries}
        for m in meta:
            dois.update(normalize_doi(d) for d in m.get("relatedBibIds") or [])
        doc = dict(head)
        doc["selection"] = dict(selection, entries=len(entries))
        doc["bibliography"] = [r for r in lt["bibliography"] if normalize_doi(r["DOI"]) in dois]
        doc["meta"] = meta
        doc["data"] = [with_converted(e) for e in entries]
        emit(rel, doc)

    data = lt["data"]

    def counts(entries):
        return {CODE_OF[t]: sum(1 for e in entries if e["datasetType"] == t) for t in CODE_OF
                if any(e["datasetType"] == t for e in entries)}

    by_element: Dict[str, List[dict]] = {}
    for e in data:
        by_element.setdefault(e["nuclide"]["element"], []).append(e)
    index_elements = []
    for element in sorted(by_element, key=lambda s: z_of.get(s, 0)):
        entries = by_element[element]
        entries_file("LT/%s.json" % element, {"element": element, "z": z_of.get(element)}, entries)
        by_nuclide: Dict[str, List[dict]] = {}
        for e in entries:
            by_nuclide.setdefault(nuclide_name(e["nuclide"]), []).append(e)
        nuclides = []
        for name, group in sorted(by_nuclide.items(), key=lambda kv: (kv[1][0]["nuclide"]["mass"], kv[1][0]["nuclide"]["isomer"])):
            n = group[0]["nuclide"]
            entries_file("LT/%s.json" % name, {"nuclide": name, "element": element, "z": z_of.get(element),
                                                "mass": n["mass"], "isomer": n["isomer"]}, group)
            nuclides.append({"nuclide": name, "mass": n["mass"], "isomer": n["isomer"],
                             "file": "%s.json" % name, "counts": counts(group)})
        index_elements.append({"element": element, "z": z_of.get(element), "file": "%s.json" % element,
                               "counts": counts(entries), "nuclides": nuclides})

    types = {}
    for dataset_type, code in CODE_OF.items():
        entries = [e for e in data if e["datasetType"] == dataset_type]
        if entries:
            entries_file("LT/%s.json" % dataset_type, {"datasetType": dataset_type}, entries)
            types[dataset_type] = "%s.json" % dataset_type

    for e in data:
        entries_file("LT/entry/%s.json" % e["datasetId"], {"datasetId": e["datasetId"]}, [e])
    sources = []
    for m in lt["meta"]:
        entries = [e for e in data if e["metaId"] == m["id"]]
        entries_file("LT/meta/%s.json" % m["id"], {"metaId": m["id"]}, entries)
        sources.append({"metaId": m["id"], "datasetType": m["datasetType"], "bibId": m.get("bibId"),
                        "reference": cite_text(references.get(normalize_doi(m.get("bibId") or "")), m.get("bibId") or ""),
                        "file": "meta/%s.json" % m["id"], "entries": len(entries)})

    index = {k: head[k] for k in ("label", "version", "kind", "commit", "date")}
    emit("LT/index.json", dict({"format": "muND/api/LT/index/1"}, **index,
                               datasetTypes=types, elements=index_elements, sources=sources))
    emit("info.json", dict({"format": "muND/api/info/1"}, **{k: v for k, v in head.items() if k != "format"},
                           sublibraries=manifest.get("sublibraries", {}),
                           files={"LT": "LT/index.json"}, data="../../data/%s/" % label))
    return count
