"""The API, the JSON files for programs made for every published version when the site is built (``docs/api.md``).

The rows of a version (``rows``) are derived as the pages derive them
(twin: ``buildVersion`` in ``site/assets/js/pages/model.js``).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

from . import CODE_OF, jsonfmt
from .cite import citations, cite_text
from .convert import Physics, combined_uncertainty
from .ids import normalize_bib_id

FORMAT = "muND/api/LT/1"
ROUND = "%.6g"                                                  # converted quantities: six significant digits
VERSION_KEYS = ("label", "version", "kind", "commit", "date")     # what names a version


def type_counts(entries: List[dict]) -> Dict[str, int]:
    """The number of entries of each kind of data, by code: every code, 0 when none."""
    return {code: sum(1 for e in entries if e["datasetType"] == t) for t, code in CODE_OF.items()}


def references(lt: dict) -> Dict[str, dict]:
    """The bibliography of LT.json by normalised bibId."""
    return {normalize_bib_id(r["id"]): r for r in lt["bibliography"]}


def rows(lt: dict, master: dict) -> Iterator[Tuple[dict, int, Optional[dict], dict, Optional[float], Optional[dict]]]:
    """Each entry of LT.json with what is derived from it: ``(entry, z, reference,
    block, total, conv)``.  ``reference`` is its bibliography entry, ``block`` the
    value block ``observable[observable.kind]``, ``total`` one overall uncertainty
    and ``conv`` the lifetime, capture rate and capture probability (both None when
    there is none).  Twin of ``buildVersion`` in site/assets/js/pages/model.js."""
    z_of = {e: i + 1 for i, e in enumerate(master["nuclides"]["elements"])}
    physics = Physics(master["huff_factors"], master["constants"])
    refs = references(lt)
    for entry in lt["data"]:
        nuclide, kind = entry["nuclide"], entry["observable"]["kind"]
        block = entry["observable"][kind]
        z = z_of.get(nuclide["element"], 0)
        total = combined_uncertainty(block.get("uncertainties"))
        yield (entry, z, refs.get(normalize_bib_id(entry["bibId"])), block, total,
               physics.convert(z, nuclide["mass"], kind, block["value"], total, block["unit"]))


def nuclide_name(nuclide: dict) -> str:
    """Si-28, Si-nat (natural isotopic abundance), Ta-180m1."""
    mass = nuclide.get("mass") or 0
    name = "%s-%s" % (nuclide["element"], int(mass) if mass else "nat")
    return name + ("m%d" % nuclide["isomer"] if nuclide.get("isomer") else "")


def _rounded(x):
    return None if x is None else float(ROUND % x)


def build_api(dist: Path, out: Path, config: dict) -> None:
    """Write the API of the version in ``dist`` (data/<label>/) to ``out`` (api/<label>/)."""
    dist, out = Path(dist), Path(out)
    manifest = json.loads((dist / "manifest.json").read_text(encoding="utf-8"))
    master = json.loads((dist / "master.json").read_text(encoding="utf-8"))
    lt = jsonfmt.loads((dist / "LT.json").read_text(encoding="utf-8"))
    label = manifest["label"]
    head = dict({"format": FORMAT}, **{k: manifest.get(k) for k in VERSION_KEYS},
                citation=citations(config, manifest), dataLicence=config.get("dataLicence"))

    def entries_file(rel: str, selection: dict, entries: List[dict], url: Optional[str] = None):
        ids = {e["metaId"] for e in entries}
        meta = [m for m in lt["meta"] if m["id"] in ids or m["id"] == selection.get("metaId")]
        bib_ids = {normalize_bib_id(m["bibId"]) for m in meta}
        for m in meta:
            bib_ids.update(normalize_bib_id(b) for b in m.get("relatedBibIds") or [])
        doc = dict(head)
        if url is not None:
            doc["citation"] = citations(config, manifest, url)
        doc["selection"] = dict(selection, entries=len(entries))
        doc["bibliography"] = [r for r in lt["bibliography"] if normalize_bib_id(r["id"]) in bib_ids]
        doc["meta"] = meta
        doc["data"] = entries
        jsonfmt.write(out / rel, doc)

    data: List[dict] = []                               # the entries with "converted"
    by_element: Dict[Tuple[int, str], List[dict]] = {}
    for entry, z, _reference, _block, _total, conv in rows(lt, master):
        e = dict(entry, converted=None if conv is None else {
            k: (v if k in ("huff_factor", "huff_source") else _rounded(v)) for k, v in conv.items()})
        data.append(e)
        entry_id = e["datasetId"]
        url = "%sexplorer/?v=%s&z=%d&id=%s" % (config.get("siteUrl", ""), label, z, entry_id)
        entries_file("LT/entry/%s.json" % entry_id, {"datasetId": entry_id}, [e], url)
        by_element.setdefault((z, entry["nuclide"]["element"]), []).append(e)
    index_elements = []
    for (z, element), entries in sorted(by_element.items()):
        entries_file("LT/%s.json" % element, {"element": element, "z": z}, entries)
        by_nuclide: Dict[str, List[dict]] = {}
        for e in entries:
            by_nuclide.setdefault(nuclide_name(e["nuclide"]), []).append(e)
        nuclides = []
        for name, group in sorted(by_nuclide.items(), key=lambda kv: (kv[1][0]["nuclide"]["mass"], kv[1][0]["nuclide"]["isomer"])):
            n = group[0]["nuclide"]
            entries_file("LT/%s.json" % name, {"nuclide": name, "element": element, "z": z,
                                                "mass": n["mass"], "isomer": n["isomer"]}, group)
            nuclides.append({"nuclide": name, "mass": n["mass"], "isomer": n["isomer"],
                             "file": "%s.json" % name, "counts": type_counts(group)})
        index_elements.append({"element": element, "z": z, "file": "%s.json" % element,
                               "counts": type_counts(entries), "nuclides": nuclides})

    types = {}
    for dataset_type in CODE_OF:
        entries = [e for e in data if e["datasetType"] == dataset_type]
        if entries:
            entries_file("LT/%s.json" % dataset_type, {"datasetType": dataset_type}, entries)
            types[dataset_type] = "%s.json" % dataset_type

    refs = references(lt)
    sources = []
    for m in lt["meta"]:
        entries = [e for e in data if e["metaId"] == m["id"]]
        entries_file("LT/meta/%s.json" % m["id"], {"metaId": m["id"]}, entries)
        sources.append({"metaId": m["id"], "datasetType": m["datasetType"], "bibId": m.get("bibId"),
                        "reference": cite_text(refs.get(normalize_bib_id(m.get("bibId") or "")), m.get("bibId") or ""),
                        "file": "meta/%s.json" % m["id"], "entries": len(entries)})

    index = {k: head[k] for k in VERSION_KEYS}
    jsonfmt.write(out / "LT/index.json", dict({"format": "muND/api/LT/index/1"}, **index,
                                              datasetTypes=types, elements=index_elements, sources=sources))
    jsonfmt.write(out / "info.json", dict({"format": "muND/api/info/1"},
                                          **{k: v for k, v in head.items() if k != "format"},
                                          sublibraries=manifest.get("sublibraries", {}),
                                          files={"LT": "LT/index.json"}, data="../../data/%s/" % label))
