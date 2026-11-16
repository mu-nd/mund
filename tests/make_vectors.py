#!/usr/bin/env python3
"""Regenerate the test data shared by the Python and JavaScript tests.

    python3 tests/make_vectors.py

* tests/vectors/convert.json   conversions computed by the Python implementation
                               (the Python tests check them against hand calculations,
                               the JavaScript tests check that the browser code agrees)
* tests/vectors/cases.json     small databases with the problems that validation must
                               report.  The expected problems are written by hand below;
                               both implementations must reproduce them exactly.
                               (The last file of every case is the bibliography.)

tests/vectors/ids.json and tests/vectors/numbers.json are maintained by hand.
"""
from __future__ import annotations

import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from mundlib import ids, jsonfmt, schema as schema_mod  # noqa: E402
from mundlib.convert import Physics  # noqa: E402
from mundlib.database import Database, dataset_path  # noqa: E402

N = jsonfmt.make_number
CODES = {"experiment": "EXP", "theory": "TH", "curated": "CUR", "evaluated": "EVAL"}
SUZUKI = {"DOI": "10.1103/PhysRevC.35.2212", "type": "journal-article",
          "author": [{"family": "Suzuki", "given": "T."}],
          "title": ["Total nuclear capture rates"], "short-container-title": ["Phys. Rev. C"],
          "volume": "35", "page": "2212", "published": {"date-parts": [[1987]]}}
TEST_REF = {"DOI": "10.1000/test", "title": ["A test"], "published": {"date-parts": [[2026]]}}
TH_REF = {"DOI": "10.1000/th", "title": ["A theory"], "published": {"date-parts": [[2026]]}}
CUR_REF = {"DOI": "10.1000/cur", "title": ["A curation"], "published": {"date-parts": [[2026]]}}


def quantity(kind, value, unit, total="1.0"):
    uncertainties = [] if total is None else [{"source": "total", "value": N(total)}]
    return {"kind": kind, kind: {"value": N(value), "unit": unit, "uncertainties": uncertainties}}


def row(element, mass, kind="lifetime", value="756.0", unit="ns", total="1.0", **extra):
    out = {"nuclide": {"element": element, "mass": mass, "isomer": 0},
           "observable": quantity(kind, value, unit, total)}
    out.update(extra)
    return out


def exp_doc():
    return {
        "format": "muND/LT/1", "sublibrary": "LT", "datasetType": "experiment",
        "meta": {"bibId": "10.1103/PhysRevC.35.2212", "facility": "TRIUMF (M20)", "method": "electron"},
        "data": [
            row("Si", 28),
            row("Al", 27, value="864.0", key="plate"),
            row("Al", 27, value="862.5", total="8.1", key="case"),
        ],
    }


def other_doc(dataset_type, doi="10.1000/test", originals=None):
    r = row("Si", 28, "capture_rate", "0.8926", "us-1", "0.0090")
    if originals:
        r["originalData"] = originals
    return {"format": "muND/LT/1", "sublibrary": "LT", "datasetType": dataset_type,
            "meta": {"bibId": doi}, "data": [r]}


def with_ids(doc):
    """Fill in correct identifiers (entries that already have one keep it)."""
    meta = doc["meta"]
    code = CODES.get(doc.get("datasetType"), "EXP")
    mid = ids.meta_id("LT", code, meta["bibId"], meta.get("key"))
    meta.setdefault("id", mid)
    for r in doc["data"]:
        if "datasetId" not in r:
            n = r["nuclide"]
            r["datasetId"] = ids.data_id("LT", code, str(n["element"]), n.get("mass", 0), mid, r.get("key"))
    return doc


LT_SCHEMA = schema_mod.load_schema(ROOT, "lt.schema.json")
BIB_SCHEMA = schema_mod.load_schema(ROOT, "bibliography.schema.json")
REFERENCES = {r["DOI"]: r for r in (SUZUKI, TEST_REF, TH_REF, CUR_REF)}
BIB_PATH = "data/master/bibliography.json"


def bibliography(*refs):
    doc = {"format": "muND/bibliography/1", "references": list(refs)}
    return {"path": BIB_PATH, "text": jsonfmt.dumps(schema_mod.normalize(doc, BIB_SCHEMA))}


def entry(doc, path=None, text=None):
    """A file of a test case: canonical text unless ``text`` is given."""
    doc = with_ids(doc)
    norm = schema_mod.normalize(doc, LT_SCHEMA)
    ref = REFERENCES.get(doc["meta"].get("bibId"))
    return {"path": path or dataset_path(norm, ref), "text": text if text is not None else jsonfmt.dumps(norm)}


def E(code, pointer="", file=0, level="error"):
    return {"level": level, "code": code, "file": file, "pointer": pointer}


def W(code, pointer="", file=0):
    return E(code, pointer, file, "warning")


def build_cases():
    cases = []
    all_refs = bibliography(SUZUKI, TEST_REF, TH_REF, CUR_REF)

    def case(name, files, expect, bib=None):
        """The bibliography is always the last file of a case."""
        cases.append({"name": name, "files": files + [bib or all_refs], "expect": expect})

    exp_id = with_ids(exp_doc())["data"][0]["datasetId"]

    case("valid experiment file", [entry(exp_doc())], [])
    case("valid curated file that refers to experimental data",
         [entry(exp_doc()), entry(other_doc("curated", originals=[exp_id]))], [])
    case("valid evaluated and theory files", [entry(other_doc("evaluated")), entry(other_doc("theory", "10.1000/th"))], [])

    d = exp_doc(); d["data"][0]["observable"]["lifetime"]["uncertainties"] = [
        {"source": "statistical", "value": N("0.8")}, {"source": "systematic", "value": N("0.7")}]
    case("statistical and systematic uncertainties given separately", [entry(d)], [])

    d = exp_doc(); d["data"][0]["observable"]["lifetime"]["uncertainties"] = []
    case("uncertainty not reported", [entry(d)], [])

    d = exp_doc(); d["data"][0]["observable"]["lifetime"]["uncertainties"] = [
        {"source": "total", "value": N("1.0")}, {"source": "total", "value": N("2.0")}]
    case("two overall uncertainties", [entry(d)], [E("E_UNCERTAINTY_TOTAL", "/data/0/observable/lifetime/uncertainties")])

    d = exp_doc(); d["meta"]["id"] = "0123456789ab"
    case("MetaID does not match datasetType/bibId/key", [entry(d)], [E("E_META_ID", "/meta/id")])

    d = exp_doc(); d["data"][1]["datasetId"] = "0123456789ab"
    case("datasetId does not match element/mass/key", [entry(d)], [E("E_DATA_ID", "/data/1/datasetId")])

    d = exp_doc(); del d["data"][2]["key"]; del d["data"][1]["key"]
    case("two entries of one nuclide without keys", [entry(d)], [E("E_DUPLICATE_ID", "/data/2/datasetId")])

    d = exp_doc(); d["data"][0]["nuclide"]["element"] = "Xx"
    case("unknown element symbol", [entry(d)], [E("E_SCHEMA", "/data/0/nuclide/element")])

    d = exp_doc(); d["data"][0]["observable"]["lifetime"]["unit"] = "us-1"
    case("unit does not fit the observable", [entry(d)], [E("E_SCHEMA", "/data/0/observable/lifetime/unit")])

    d = exp_doc(); d["data"][0]["observable"]["kind"] = "capture_rate"
    case("kind and value block disagree", [entry(d)],
         [E("E_SCHEMA", "/data/0/observable"), E("E_SCHEMA", "/data/0/observable/lifetime")])

    d = exp_doc(); del d["data"][0]["nuclide"]["isomer"]
    case("isomer is required", [entry(d)], [E("E_SCHEMA", "/data/0/nuclide")])

    d = exp_doc(); del d["meta"]["facility"]
    case("experiment without facility", [entry(d)], [E("E_SCHEMA", "/meta")])

    d = exp_doc(); d["meta"]["facility"] = "Nowhere (X1)"
    case("facility not in the master list", [entry(d)], [E("E_FACILITY", "/meta/facility")])

    case("curated without originalData", [entry(other_doc("curated"))], [E("E_SCHEMA", "/data/0")])

    case("curated refers to data that does not exist", [entry(other_doc("curated", originals=["0123456789ab"]))],
         [E("E_ORIGINAL_MISSING", "/data/0/originalData/0")])

    ev = with_ids(other_doc("evaluated"))
    case("curated refers to data that is not experimental",
         [entry(other_doc("curated", "10.1000/cur", originals=[ev["data"][0]["datasetId"]])), entry(other_doc("evaluated"))],
         [E("E_ORIGINAL_NOT_EXP", "/data/0/originalData/0", 0)])

    d = exp_doc(); d["data"][0]["originalData"] = [exp_id]
    case("experiment must not have originalData", [entry(d)],
         [E("E_SCHEMA", "/data/0/originalData"), E("E_ORIGINAL_SELF", "/data/0/originalData/0")])

    d = other_doc("theory"); d["meta"]["facility"] = "TRIUMF (M20)"
    case("experimental conditions are for experiment only", [entry(d)], [E("E_SCHEMA", "/meta/facility")])

    d = other_doc("curated", originals=[exp_id]); d["meta"]["referenceDatabase"] = "muND CUR v1"
    case("referenceDatabase is for evaluated only", [entry(exp_doc()), entry(d)], [E("E_SCHEMA", "/meta/referenceDatabase", 1)])

    f = entry(exp_doc()); f["path"] = f["path"].replace("/EXP/", "/CUR/")
    case("file stored in the wrong directory", [f], [E("E_PATH")])

    f = entry(exp_doc()); f["path"] = "data/LT/EXP/96f2c4a2ddaf.json"
    case("file name without label", [f], [E("E_PATH")])

    a = entry(exp_doc())
    b = entry(exp_doc()); b["path"] = b["path"].replace("Suzuki1987", "Zuzuki1987")
    case("two files for the same publication",
         [a, b], [E("E_DUPLICATE_META", "/meta/id", 1)] +
                 [E("E_DUPLICATE_ID", "/data/%d/datasetId" % i, 1) for i in range(3)])

    text = entry(exp_doc())["text"].replace('  "format"', '    "format"', 1)
    case("file not in canonical layout", [entry(exp_doc(), text=text)], [E("E_CANONICAL")])

    case("file is not JSON", [entry(exp_doc(), text='{"format": "muND/LT/1",\n')], [E("E_JSON")])

    d = exp_doc(); d["format"] = "muND/LT/99"
    case("unknown format", [entry(d)], [E("E_FORMAT", "/format")])

    d = exp_doc(); d["data"][0]["colour"] = "blue"
    case("unknown property", [entry(d)], [E("E_SCHEMA", "/data/0")])

    d = exp_doc(); d["data"][0]["observable"]["lifetime"]["uncertainties"][0]["value"] = N("-1.0")
    case("negative uncertainty", [entry(d)], [E("E_SCHEMA", "/data/0/observable/lifetime/uncertainties/0/value")])

    d = exp_doc(); d["data"][0]["nuclide"]["mass"] = 60
    case("implausible mass number", [entry(d)], [W("W_MASS_RANGE", "/data/0/nuclide/mass")])

    case("bibliographic information missing", [entry(exp_doc())], [W("W_NO_REFERENCE", "/meta/bibId")],
         bib=bibliography(TEST_REF))

    case("reference listed twice", [entry(exp_doc())], [E("E_DUPLICATE_REFERENCE", "/references/1/DOI", 1)],
         bib=bibliography(SUZUKI, dict(SUZUKI, DOI="10.1103/physrevc.35.2212")))

    d = exp_doc(); d["meta"]["key"] = "a|b"
    case("key contains the separator", [entry(d)], [E("E_SCHEMA", "/meta/key")])

    d = exp_doc(); d["meta"]["bibId"] = "https://doi.org/10.1103/PhysRevC.35.2212"
    case("DOI given as URL", [entry(d)], [E("E_SCHEMA", "/meta/bibId"), W("W_NO_REFERENCE", "/meta/bibId")])

    d = other_doc("evaluated"); d["data"][0]["observable"] = quantity("capture_probability", "120", "%")
    case("capture probability above 100 %", [entry(d)], [E("E_SCHEMA", "/data/0/observable/capture_probability/value")])

    d = exp_doc(); d["data"][0]["observable"]["lifetime"]["value"] = N("0")
    case("lifetime must be positive", [entry(d)], [E("E_SCHEMA", "/data/0/observable/lifetime/value")])

    d = with_ids(exp_doc())
    text = jsonfmt.dumps(schema_mod.normalize(d, LT_SCHEMA)).replace('}]}}},', '}]}}, "comment": ""},', 1)
    assert '"comment": ""' in text
    case("empty optional member", [entry(exp_doc(), text=text)],
         [E("E_CANONICAL"), E("E_SCHEMA", "/data/0/comment")])

    f = entry(exp_doc()); f["path"] = "data/BR/EXP/Suzuki1987_96f2c4a2ddaf.json"
    case("sub-library without a defined format", [f], [E("E_SUBLIBRARY_UNDEFINED")])

    d = exp_doc(); d["data"][0]["nuclide"]["mass"] = N("27.5")
    case("mass number must be an integer", [entry(d)], [E("E_SCHEMA", "/data/0/nuclide/mass")])

    d = with_ids(other_doc("evaluated")); d["data"][0]["originalData"] = [d["data"][0]["datasetId"]]
    case("data entry refers to itself", [entry(d)], [E("E_ORIGINAL_SELF", "/data/0/originalData/0")])

    return cases


def build_convert():
    db = Database.load(ROOT)
    physics = Physics(db.master_obj("huff_factors.json"), db.master_obj("constants.json"))
    inputs = [
        (14, 28, "lifetime", 756.0, 1.0, "ns"),
        (14, 0, "lifetime", 751.6, 1.0, "ns"),
        (3, 6, "lifetime", 2.1770, 0.0020, "us"),
        (82, 0, "lifetime", 75.4, 1.0, "ns"),
        (14, 28, "capture_rate", 0.8926, 0.0090, "us-1"),
        (1, 1, "capture_rate", 0.000435, 0.000016, "us-1"),
        (26, 56, "capture_rate", 4411.0, 26.0, "ms-1"),
        (92, 238, "capture_rate", 1.29e7, 1.0e5, "s-1"),
        (13, 27, "capture_probability", 60.9, 0.1, "%"),
        (47, 0, "lifetime", 87.0, None, "ns"),
        (96, 249, "capture_rate", 12.02, 1.69, "us-1"),
        (6, 12, "lifetime", 2500.0, 5.0, "ns"),
    ]
    out = []
    for z, a, obs, value, unc, unit in inputs:
        out.append({"z": z, "a": a, "observable": obs, "value": value, "uncertainty": unc,
                    "unit": unit, "expected": physics.convert(z, a, obs, value, unc, unit)})
    return out


def main():
    vectors = ROOT / "tests" / "vectors"
    cases = {"description": "Small databases and the problems validation must report for them. "
                            "'file' is the index of the file in 'files'. Generated by "
                            "tests/make_vectors.py; the expectations are written by hand there.",
             "cases": build_cases()}
    (vectors / "cases.json").write_text(jsonfmt.dumps(cases), encoding="utf-8")
    conv = {"description": "Conversions between lifetime (ns), capture rate (1/us) and capture "
                           "probability (%) with the master tables of this repository. "
                           "'expected' is null when no conversion is possible.",
            "relative_tolerance": 1e-9,
            "cases": build_convert()}
    (vectors / "convert.json").write_text(jsonfmt.dumps(conv), encoding="utf-8")
    print("%d validation cases, %d conversion cases" % (len(cases["cases"]), len(conv["cases"])))


if __name__ == "__main__":
    main()
