#!/usr/bin/env python3
"""Files with fictitious values that follow the templates of XR, ES and BR.

    python3 templates/make_examples.py <folder>

writes <folder>/data/<XR|ES|BR>/<EXP|TH|EVAL>/<Label><Year>_<MetaID>.json and their
sources, <folder>/data/master/bibliography.json (muND:example-...), to design the
pages with.  The files are not kept: the templates (*.schema.json) are, and the
tests check that what this writes follows them.  Nothing here may be copied into data/.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from mundlib import CODE_OF, ids, jsonfmt  # noqa: E402
from mundlib.database import file_path  # noqa: E402

NOTE = "EXAMPLE: fictitious values for designing the pages; the format is not decided"


def unc(value: float) -> list:
    return [{"source": "total", "value": value}]


def r(x: float, digits: int) -> float:
    return float(round(x, digits))


# ---- the sources (fictitious) ---------------------------------------------------------

REFERENCES = []


def source(sub: str, n: int, dataset_type: str, author: str, year: int, title: str, **meta) -> dict:
    bib_id = "muND:example-%s-%d" % (sub.lower(), n)
    REFERENCES.append({"id": bib_id, "type": "journal-article", "author": [{"family": author, "given": "A."}],
                       "title": ["EXAMPLE - " + title], "container-title": ["Example Journal"],
                       "short-container-title": ["Example J."], "volume": str(n), "page": str(100 + n),
                       "published": {"date-parts": [[year]]}})
    mid = ids.meta_id(sub, CODE_OF[dataset_type], bib_id)
    m = {"id": mid, "bibId": bib_id}
    m.update(meta)
    m["comment"] = NOTE
    return {"format": "muND/%s/draft" % sub, "sublibrary": sub, "datasetType": dataset_type, "meta": m, "data": []}


def add(doc: dict, element: str, mass: int, detail: str, observable: dict, **extra) -> None:
    """One entry; its DataID as for LT, with what the entry is about (the detail) as the key."""
    sub, code = doc["sublibrary"], CODE_OF[doc["datasetType"]]
    did = ids.data_id(sub, code, element, mass, doc["meta"]["id"], detail)
    entry = {"datasetId": did, "nuclide": {"element": element, "mass": mass, "isomer": 0}, "observable": observable}
    entry.update(extra)
    doc["data"].append(entry)


def path_of(doc: dict) -> str:
    return file_path(doc, next(x for x in REFERENCES if x["id"] == doc["meta"]["bibId"]))


# ---- XR: muonic X-ray energies and intensities -------------------------------------------

# energy of 2p -> 1s (keV) by element: rough round numbers, enough for the scale of the pages
K_ALPHA = {"C": 75.3, "O": 133.5, "Al": 346.8, "Si": 400.2, "Ca": 783.8, "Fe": 1256.0, "Cu": 1512.0,
           "Pd": 3010.0, "Ag": 3140.0, "Au": 5591.0, "Pb": 5963.0, "Bi": 6032.0}
Z = {"C": 6, "O": 8, "Al": 13, "Si": 14, "Ca": 20, "Fe": 26, "Cu": 29, "Pd": 46, "Ag": 47, "Au": 79, "Pb": 82, "Bi": 83}
RY = 2.813                                              # muonic Rydberg (keV): 13.6057 eV x m_mu/m_e


def transitions(element: str, mass: int):
    """(transition, energy keV, intensity per muon) of a few lines.

    2p -> 1s comes from K_ALPHA (the nuclear size lowers 1s a lot in heavy atoms); the levels above
    are those of a point charge, RY Z^2 / n^2, which the nuclear size hardly moves."""
    e = K_ALPHA[element] - (mass - 106) * 0.9 * (element == "Pd" and mass > 0)
    split = e * (Z[element] / 137.0) ** 2 * 0.1           # fine structure of 2p
    z2 = Z[element] ** 2
    d32, d43 = RY * z2 * (1 / 4 - 1 / 9), RY * z2 * (1 / 9 - 1 / 16)   # n = 3 -> 2 and 4 -> 3
    return [("2p1/2-1s1/2", e - split * 2 / 3, 0.27), ("2p3/2-1s1/2", e + split / 3, 0.53),
            ("3p-1s", e + d32, 0.06), ("3d5/2-2p3/2", d32 - split / 3, 0.36),
            ("3d3/2-2p1/2", d32 + split * 2 / 3, 0.21), ("4f-3d", d43, 0.42)]


def make_xr():
    exp1 = source("XR", 1, "experiment", "Exampleexp", 2024, "Muonic X-rays of light elements",
                  facility="J-PARC (D2)", method="germanium detectors")
    for element in ("C", "O", "Al", "Si", "Ca", "Fe"):
        for i, (t, e, inten) in enumerate(transitions(element, 0)):
            if t == "4f-3d" and element in ("C", "O"):
                continue                                          # below the energy range of the detector
            add(exp1, element, 0, t, {"kind": "xray", "xray": {
                "transition": t,
                "energy": {"value": r(e, 2), "unit": "keV", "uncertainties": unc(r(0.02 + e * 1e-5, 3))},
                "intensity": {"value": r(inten * (1 - 0.01 * i), 3), "unit": "per muon", "uncertainties": unc(r(inten * 0.04, 3))}}})
    exp2 = source("XR", 2, "experiment", "Exampleiso", 2025, "Muonic X-rays of Pd isotopes",
                  facility="MuSIC-M1", method="germanium detectors")
    for mass in (104, 105, 106, 108, 110):
        for t, e, inten in transitions("Pd", mass)[:2]:
            add(exp2, "Pd", mass, t, {"kind": "xray", "xray": {
                "transition": t, "energy": {"value": r(e, 2), "unit": "keV", "uncertainties": unc(0.15)}}})
    exp3 = source("XR", 3, "experiment", "Exampleheavy", 2023, "Muonic X-rays of heavy elements",
                  facility="PSI (piE1)", method="germanium detectors")
    for element in ("Ag", "Au", "Pb", "Bi"):
        for t, e, inten in transitions(element, 0)[:4]:
            add(exp3, element, 0, t, {"kind": "xray", "xray": {
                "transition": t,
                "energy": {"value": r(e, 1), "unit": "keV", "uncertainties": unc(r(0.3 + e * 2e-5, 2))},
                "intensity": {"value": r(inten * 0.95, 3), "unit": "per muon", "uncertainties": unc(r(inten * 0.06, 3))}}})
    th = source("XR", 4, "theory", "Examplecalc", 2025, "Calculated transition energies", method="Dirac equation solver")
    for element in K_ALPHA:
        mass = 106 if element == "Pd" else 0
        for t, e, inten in transitions(element, mass):
            add(th, element, mass, t, {"kind": "xray", "xray": {
                "transition": t, "energy": {"value": r(e * 1.0004, 3), "unit": "keV", "uncertainties": []}}})
    ev = source("XR", 5, "evaluated", "Exampleeval", 2026, "Recommended muonic X-ray data", method="weighted average of the example data")
    for element in ("Al", "Si", "Fe"):
        for t, e, inten in transitions(element, 0)[:3]:
            add(ev, element, 0, t, {"kind": "xray", "xray": {
                "transition": t,
                "energy": {"value": r(e, 2), "unit": "keV", "uncertainties": unc(0.02)},
                "intensity": {"value": r(inten, 3), "unit": "per muon", "uncertainties": unc(r(inten * 0.03, 3))}}})
    return [exp1, exp2, exp3, th, ev]


# ---- ES: energy spectra of emitted particles ---------------------------------------------

def spectrum(total: float, temperature: float, tail: float, edges: list, error: float = 0.0) -> list:
    """Bins of a made-up spectrum: an evaporation peak and a pre-equilibrium tail, `total` per capture."""
    shape = lambda e: e * math.exp(-e / temperature) + tail * math.exp(-e / 9.0)
    grid = [edges[0] + (edges[-1] - edges[0]) * k / 2000 for k in range(2001)]
    norm = sum(shape(e) for e in grid) * (grid[1] - grid[0])
    out = []
    for i, (lo, hi) in enumerate(zip(edges, edges[1:])):
        mid = (lo + hi) / 2
        value = total * shape(mid) / norm
        wobble = 1 + 0.06 * math.sin(3.1 * i)                 # measured points scatter
        b = {"low": lo, "high": hi, "value": float("%.3g" % (value * (wobble if error else 1)))}
        if error:
            b["uncertainty"] = float("%.2g" % (value * error * (1 + 0.15 * i / len(edges))))
        out.append(b)
    return out


def es_observable(particle: str, bins: list) -> dict:
    return {"kind": "spectrum", "spectrum": {"particle": particle, "energyUnit": "MeV", "unit": "per capture per MeV", "bins": bins}}


def make_es():
    coarse = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60]
    fine = [1 + k for k in range(0, 60)]
    exp1 = source("ES", 1, "experiment", "Examplecharged", 2026, "Charged particles after muon capture on Si",
                  facility="RAL (Port-4)", method="silicon detector telescopes with particle identification")
    for particle, total, temp, tail in (("p", 0.15, 2.6, 0.05), ("d", 0.035, 3.0, 0.08), ("t", 0.012, 3.2, 0.06), ("alpha", 0.021, 3.5, 0.02)):
        add(exp1, "Si", 28, particle, es_observable(particle, spectrum(total, temp, tail, coarse, 0.07)))
        add(exp1, "Si", 0, particle, es_observable(particle, spectrum(total * 1.04, temp, tail, coarse, 0.09)))
    exp2 = source("ES", 2, "experiment", "Exampleneutron", 2025, "Neutrons after muon capture on Pd isotopes",
                  facility="MuSIC-M1", method="liquid scintillators, time of flight")
    for mass, total in ((104, 1.21), (105, 1.30), (106, 1.34), (108, 1.41), (110, 1.47)):
        add(exp2, "Pd", mass, "n", es_observable("n", spectrum(total, 1.6, 0.03, [1, 1.5, 2, 3, 4, 5, 6, 8, 10, 13, 16, 20, 25, 30, 40], 0.08)))
    docs = [exp1, exp2]
    for n, (author, model, k) in enumerate((("Examplemodela", "Monte Carlo transport code", 1.0),
                                            ("Examplemodelb", "microscopic and evaporation model", 1.12)), 3):
        th = source("ES", n, "theory", author, 2025, "Calculated particle spectra (%s)" % model, method=model)
        for particle, total, temp, tail in (("p", 0.15, 2.6, 0.05), ("d", 0.035, 3.0, 0.08), ("t", 0.012, 3.2, 0.06),
                                            ("alpha", 0.021, 3.5, 0.02), ("n", 0.9, 1.7, 0.03)):
            add(th, "Si", 28, particle, es_observable(particle, spectrum(total * k, temp * k, tail / k, fine)))
        add(th, "Pd", 106, "n", es_observable("n", spectrum(1.34 * k, 1.6 * k, 0.03, fine)))
        docs.append(th)
    return docs


# ---- BR: production branching ratios of residual nuclei ----------------------------------

BR_TARGETS = {
    ("Al", 27): [("Mg", 27, 9.7, "independent"), ("Mg", 26, 51.0, None), ("Mg", 25, 13.0, None), ("Na", 24, 3.6, "cumulative"),
                 ("Na", 25, 0.9, "independent"), ("Ne", 23, 0.25, "cumulative"), ("Mg", 24, 6.0, None)],
    ("Si", 28): [("Al", 28, 26.0, "independent"), ("Al", 27, 44.0, None), ("Mg", 27, 2.9, "cumulative"), ("Al", 26, 7.5, None),
                 ("Na", 24, 0.95, "cumulative"), ("Mg", 26, 4.1, None)],
    ("Pd", 106): [("Rh", 106, 11.0, "independent"), ("Rh", 105, 48.0, "cumulative"), ("Rh", 104, 21.0, "independent"),
                  ("Rh", 103, 7.0, None), ("Ru", 103, 1.2, "cumulative")],
}


def br_observable(element: str, mass: int, value: float, error: float, production, isomer: int = 0) -> dict:
    block = {"residual": {"element": element, "mass": mass, "isomer": isomer}, "value": value, "unit": "%",
             "uncertainties": unc(error) if error else [], "per": "capture"}
    if production:
        block["production"] = production
    return {"kind": "branching_ratio", "branching_ratio": block}


def make_br():
    exp = source("BR", 1, "experiment", "Exampleactivation", 2025, "Residual nuclei after muon capture (activation)",
                 facility="J-PARC (D1)", method="in-beam and offline activation, gamma-ray spectroscopy")
    for (target, tmass), rows in BR_TARGETS.items():
        for element, mass, value, production in rows:
            if production is None:
                continue                                          # stable or not measured by activation
            add(exp, target, tmass, "%s%d" % (element, mass),
                br_observable(element, mass, r(value * 0.97, 2), r(max(value * 0.06, 0.03), 2), production))
    add(exp, "Pd", 106, "Rh104m", br_observable("Rh", 104, 6.4, 0.5, "independent", isomer=1))      # an isomer
    th = source("BR", 2, "theory", "Examplemodela", 2025, "Calculated residual production", method="Monte Carlo transport code")
    for (target, tmass), rows in BR_TARGETS.items():
        for element, mass, value, production in rows:
            add(th, target, tmass, "%s%d" % (element, mass), br_observable(element, mass, r(value * 1.08, 2), 0, "independent"))
    return [exp, th]


# ---- the files -----------------------------------------------------------------------------

def generate() -> dict:
    """{path under the folder: text}"""
    REFERENCES.clear()
    docs = make_xr() + make_es() + make_br()
    files = {path_of(doc): jsonfmt.dumps(doc) for doc in docs}
    files["data/master/bibliography.json"] = jsonfmt.dumps({"format": "muND/bibliography/1", "references": REFERENCES})
    return files


def main(args):
    if len(args) != 1:
        sys.exit(__doc__)
    out = Path(args[0]).resolve()
    database = ROOT / "data"
    if database.exists() and any(p.exists() and p.samefile(database) for p in (out, *out.parents)):
        sys.exit("choose an output folder outside the database")
    files = generate()
    try:
        (out / "data").mkdir(parents=True)
    except FileExistsError:
        sys.exit("choose an output folder without a data directory")
    for rel, text in files.items():
        (out / rel).parent.mkdir(parents=True, exist_ok=True)
        (out / rel).write_bytes(text.encode("utf-8"))
    print("wrote %d files under %s" % (len(files), out / "data"))


if __name__ == "__main__":
    main(sys.argv[1:])
