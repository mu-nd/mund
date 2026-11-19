#!/usr/bin/env python3
"""Generate the test data shared by the Python and JavaScript tests.

    python3 tests/make_vectors.py

* tests/vectors/cases.json       small databases and the problems validation must
                                 report for them (expectations written by hand below)
* tests/vectors/convert.json     conversions, computed with the master tables of
                                 tests/fixtures (checked against hand calculations
                                 in the Python tests)
* tests/vectors/cite.json        file labels and citation texts (written by hand below)
* tests/vectors/repository.json  the test database tests/fixtures as {path: text}

tests/vectors/ids.json is maintained by hand.  tests/python/test_vectors.py
checks that the committed files are what this script writes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "tools"))

from mundlib import CODE_OF, ids, jsonfmt  # noqa: E402
from mundlib.cite import cite_text, file_label  # noqa: E402
from mundlib.convert import Physics  # noqa: E402
from mundlib.database import canonical_text, entry_hash, file_path  # noqa: E402

N = jsonfmt.loads
SUZUKI = {"DOI": "10.1103/PhysRevC.35.2212", "type": "journal-article",
          "author": [{"family": "Suzuki", "given": "T."}],
          "title": ["Total nuclear capture rates"], "short-container-title": ["Phys. Rev. C"],
          "volume": "35", "page": "2212", "published": {"date-parts": [[1987]]}}
TEST_REF = {"DOI": "10.1000/test", "title": ["A test"], "published": {"date-parts": [[2026]]}}
TH_REF = {"DOI": "10.1000/th", "title": ["A theory"], "published": {"date-parts": [[2026]]}}
CUR_REF = {"DOI": "10.1000/cur", "title": ["A curation"], "published": {"date-parts": [[2026]]}}


def fixture_text(rel: str) -> str:
    return (FIXTURE / rel).read_text(encoding="utf-8")


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


def orig(dataset_id, hash_="000000000000"):
    """An originalData item."""
    return {"datasetId": dataset_id, "entryHash": hash_}


def with_ids(doc):
    """Fill in correct identifiers (entries that already have one keep it)."""
    meta = doc["meta"]
    code = CODE_OF.get(doc.get("datasetType"), "EXP")
    mid = ids.meta_id("LT", code, meta["bibId"], meta.get("key"))
    meta.setdefault("id", mid)
    for r in doc["data"]:
        if "datasetId" not in r:
            n = r["nuclide"]
            r["datasetId"] = ids.data_id("LT", code, str(n["element"]), n.get("mass", 0), mid, r.get("key"))
    return doc


REFERENCES = {r["DOI"]: r for r in (SUZUKI, TEST_REF, TH_REF, CUR_REF)}
BIB_PATH = "data/master/bibliography.json"


def bibliography(*refs):
    return {"path": BIB_PATH, "text": canonical_text({"format": "muND/bibliography/1", "references": list(refs)})}


def entry(doc, path=None, text=None):
    """A file of a test case: canonical text unless ``text`` is given."""
    doc = with_ids(doc)
    ref = REFERENCES.get(doc["meta"].get("bibId"))
    return {"path": path or file_path(doc, ref), "text": text if text is not None else canonical_text(doc)}


def E(code, pointer="", file=0, level="error"):
    return {"level": level, "code": code, "file": file, "pointer": pointer}


def W(code, pointer="", file=0):
    return E(code, pointer, file, "warning")


def build_master():
    """The master tables every validation case starts from: those of the
    test database, with a bibliography of the references used in the cases."""
    master = {"data/master/%s" % n: fixture_text("data/master/%s" % n)
              for n in ("facilities.json", "nuclides.json", "constants.json")}
    master["data/master/huff_factors.json"] = canonical_text(
        {"format": "muND/huff-factors/1", "by_element": [], "by_nuclide": []})
    master[BIB_PATH] = bibliography(SUZUKI, TEST_REF, TH_REF, CUR_REF)["text"]
    return master


MASTER = build_master()


def build_cases():
    cases = []

    def case(name, files, expect, bib=None):
        """``bib`` replaces the bibliography of MASTER; it is then the last file of the case."""
        cases.append({"name": name, "files": files + ([bib] if bib else []), "expect": expect})

    exp_id = with_ids(exp_doc())["data"][0]["datasetId"]
    exp_hash = entry_hash(exp_doc()["data"][0])

    case("valid experiment file", [entry(exp_doc())], [])
    case("valid curated file that refers to experimental data",
         [entry(exp_doc()), entry(other_doc("curated", originals=[orig(exp_id, exp_hash)]))], [])
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

    case("curated refers to data that does not exist", [entry(other_doc("curated", originals=[orig("0123456789ab")]))],
         [E("E_ORIGINAL_MISSING", "/data/0/originalData/0")])

    ev = with_ids(other_doc("evaluated"))
    case("curated refers to data that is not experimental",
         [entry(other_doc("curated", "10.1000/cur", originals=[orig(ev["data"][0]["datasetId"])])), entry(other_doc("evaluated"))],
         [E("E_ORIGINAL_NOT_EXP", "/data/0/originalData/0", 0)])

    d = exp_doc(); d["data"][0]["originalData"] = [orig(exp_id)]
    case("experiment must not have originalData", [entry(d)],
         [E("E_SCHEMA", "/data/0/originalData"), E("E_ORIGINAL_SELF", "/data/0/originalData/0")])

    d = other_doc("theory"); d["meta"]["facility"] = "TRIUMF (M20)"
    case("experimental conditions are for experiment only", [entry(d)], [E("E_SCHEMA", "/meta/facility")])

    d = other_doc("curated", originals=[orig(exp_id, exp_hash)]); d["meta"]["referenceDatabase"] = "muND CUR v1"
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

    case("placeholder DOI without bibliographic information", [entry(other_doc("evaluated", "10.1000/mund.test"))], [],
         bib=bibliography(SUZUKI))

    case("reference listed twice", [entry(exp_doc())], [E("E_DUPLICATE_REFERENCE", "/references/1/DOI", 1)],
         bib=bibliography(SUZUKI, dict(SUZUKI, DOI="10.1103/physrevc.35.2212")))

    d = exp_doc(); d["meta"]["key"] = "a|b"
    case("key contains the separator", [entry(d)], [E("E_SCHEMA", "/meta/key")])

    d = exp_doc(); d["meta"]["bibId"] = "https://doi.org/10.1103/PhysRevC.35.2212"
    case("DOI given as URL", [entry(d)], [E("E_SCHEMA", "/meta/bibId"), W("W_NO_REFERENCE", "/meta/bibId")])

    d = other_doc("theory", "10.1000/th"); d["data"][0]["observable"] = quantity("capture_probability", "120", "%")
    case("capture probability above 100 %", [entry(d)], [E("E_SCHEMA", "/data/0/observable/capture_probability/value")])

    d = exp_doc(); d["data"][0]["observable"]["lifetime"]["value"] = N("0")
    case("lifetime must be positive", [entry(d)], [E("E_SCHEMA", "/data/0/observable/lifetime/value")])

    text = canonical_text(with_ids(exp_doc())).replace('}]}}},', '}]}}, "comment": ""},', 1)
    assert '"comment": ""' in text
    case("empty optional member", [entry(exp_doc(), text=text)],
         [E("E_CANONICAL"), E("E_SCHEMA", "/data/0/comment")])

    f = entry(exp_doc()); f["path"] = "data/BR/EXP/Suzuki1987_96f2c4a2ddaf.json"
    case("sub-library without a defined format", [f], [E("E_SUBLIBRARY_UNDEFINED")])

    d = exp_doc(); d["data"][0]["nuclide"]["mass"] = N("27.5")
    case("mass number must be an integer", [entry(d)], [E("E_SCHEMA", "/data/0/nuclide/mass")])

    d = with_ids(other_doc("evaluated")); d["data"][0]["originalData"] = [orig(d["data"][0]["datasetId"])]
    case("data entry refers to itself", [entry(d)], [E("E_ORIGINAL_SELF", "/data/0/originalData/0")])

    changed = exp_doc(); changed["data"][0]["observable"]["lifetime"]["value"] = N("756.5")
    case("original data changed after the curated value was derived from it",
         [entry(changed), entry(other_doc("curated", originals=[orig(exp_id, exp_hash)]))],
         [W("W_ORIGINAL_CHANGED", "/data/0/originalData/0", 1)])

    digits = exp_doc(); digits["data"][0]["observable"]["lifetime"]["value"] = N("756.00")
    case("a change of the written digits counts as a change of the original",
         [entry(digits), entry(other_doc("curated", originals=[orig(exp_id, exp_hash)]))],
         [W("W_ORIGINAL_CHANGED", "/data/0/originalData/0", 1)])

    commented = exp_doc(); commented["data"][0]["comment"] = "checked against the paper"
    case("a comment is not part of the entry hash",
         [entry(commented), entry(other_doc("curated", originals=[orig(exp_id, exp_hash)]))], [])

    case("original data listed twice",
         [entry(exp_doc()), entry(other_doc("curated", originals=[orig(exp_id, exp_hash), orig(exp_id, exp_hash)]))],
         [E("E_ORIGINAL_DUPLICATE", "/data/0/originalData/1", 1)])

    renamed = exp_doc(); renamed["data"][0]["key"] = "foil"; renamed["data"][0]["legacyIds"] = [exp_id]
    case("reference through an earlier identifier",
         [entry(renamed), entry(other_doc("curated", originals=[orig(exp_id, exp_hash)]))],
         [W("W_ORIGINAL_LEGACY", "/data/0/originalData/0", 1)])

    d = exp_doc(); d["data"][1]["legacyIds"] = [exp_id]
    case("an earlier identifier that is the current identifier of another entry", [entry(d)],
         [E("E_LEGACY_ID_CONFLICT", "/data/1/legacyIds/0")])

    d = exp_doc(); d["data"][1]["legacyIds"] = ["old-1"]; d["data"][2]["legacyIds"] = ["old-1"]
    case("the same earlier identifier in two entries", [entry(d)],
         [E("E_LEGACY_ID_CONFLICT", "/data/2/legacyIds/0")])

    d = other_doc("curated", originals=[orig(exp_id, exp_hash)])
    d["data"][0]["observable"] = quantity("lifetime", "756.0", "ns")
    case("curated value that is not a capture rate", [entry(exp_doc()), entry(d)],
         [E("E_SCHEMA", "/data/0/observable/kind", 1)])

    d = exp_doc(); d["data"][0]["nuclide"]["isomer"] = 1
    case("isomeric state (format version 1 holds ground states)", [entry(d)],
         [E("E_SCHEMA", "/data/0/nuclide/isomer")])

    d = exp_doc(); d["format"] = "muND/facilities/1"
    case("a master table format in a sub-library", [entry(d)], [E("E_FORMAT", "/format")])

    case("files outside the known places",
         [{"path": "data/LT.json", "text": "{}\n"}, {"path": "data/master/extra.json", "text": "{}\n"}],
         [E("E_PATH", "", 0), E("E_PATH", "", 1)])

    case("master table missing", [{"path": "data/master/constants.json", "text": None}],
         [E("E_MASTER_MISSING", "", 0)])

    fac = jsonfmt.loads(MASTER["data/master/facilities.json"])
    fac["facilities"].append(dict(fac["facilities"][0]))
    case("facility listed twice", [{"path": "data/master/facilities.json", "text": jsonfmt.dumps(fac)}],
         [E("E_DUPLICATE_FACILITY", "/facilities/%d/abbr" % (len(fac["facilities"]) - 1), 0)])

    def master_case(name, path, obj, expect):
        case(name, [{"path": path, "text": jsonfmt.dumps(obj)}], expect)

    const = jsonfmt.loads(MASTER["data/master/constants.json"])
    mu = next(i for i, c in enumerate(const["constants"]) if c["name"] == "mu_plus_lifetime")
    c = jsonfmt.loads(MASTER["data/master/constants.json"]); c["constants"].append(dict(c["constants"][mu]))
    master_case("constant listed twice", "data/master/constants.json", c,
                [E("E_DUPLICATE_CONSTANT", "/constants/%d/name" % (len(c["constants"]) - 1))])
    c = jsonfmt.loads(MASTER["data/master/constants.json"]); c["constants"][mu]["name"] = "muon_lifetime"
    master_case("mu_plus_lifetime missing", "data/master/constants.json", c, [E("E_CONSTANT_MISSING", "/constants")])
    c = jsonfmt.loads(MASTER["data/master/constants.json"])
    c["constants"][mu]["unit"] = "us"; c["constants"][mu]["value"] = N("2.1969811")
    master_case("mu_plus_lifetime not in ns", "data/master/constants.json", c,
                [E("E_CONSTANT_UNIT", "/constants/%d/unit" % mu)])
    c = jsonfmt.loads(MASTER["data/master/constants.json"]); c["constants"][mu]["value"] = N("0")
    master_case("mu_plus_lifetime not positive", "data/master/constants.json", c,
                [E("E_CONSTANT_VALUE", "/constants/%d/value" % mu)])
    huff = {"format": "muND/huff-factors/1",
            "by_element": [{"z": 14, "q": N("0.9924")}, {"z": 14, "q": N("0.9925")}],
            "by_nuclide": [{"z": 26, "a": 56, "q": N("0.9715")}, {"z": 26, "a": 58, "q": N("0.9716")},
                           {"z": 26, "a": 56, "q": N("0.9715")}]}
    master_case("Huff factor listed twice", "data/master/huff_factors.json", huff,
                [E("E_DUPLICATE_HUFF", "/by_element/1"), E("E_DUPLICATE_HUFF", "/by_nuclide/2")])

    return cases


def build_convert():
    physics = Physics(json.loads(fixture_text("data/master/huff_factors.json")),
                      json.loads(fixture_text("data/master/constants.json")))
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
        (14, 28, "lifetime", 756.0, 1.0, "ns", 0.95),      # Huff factor given by the user
        (13, 27, "capture_probability", 60.9, 0.1, "%", 1),
    ]
    out = []
    for z, a, obs, value, unc, unit, *q in inputs:
        case = {"z": z, "a": a, "observable": obs, "value": value, "uncertainty": unc, "unit": unit}
        if q:
            case["q"] = q[0]
        case["expected"] = physics.convert(z, a, obs, value, unc, unit, *q)
        out.append(case)
    return out


def build_refused():
    """Master tables and Huff factors both implementations must refuse (never use a guess instead)."""
    huff = json.loads(fixture_text("data/master/huff_factors.json"))
    constants = json.loads(fixture_text("data/master/constants.json"))
    mu = next(c for c in constants["constants"] if c["name"] == "mu_plus_lifetime")

    def with_constants(*items):
        return {"huff": huff, "constants": {"format": "muND/constants/1", "constants": list(items)}}

    def with_huff(by_element, by_nuclide):
        return {"huff": {"format": "muND/huff-factors/1", "by_element": by_element, "by_nuclide": by_nuclide},
                "constants": constants}

    el, nu = huff["by_element"][0], huff["by_nuclide"][0]
    tables = [
        dict(name="mu_plus_lifetime missing", **with_constants()),
        dict(name="mu_plus_lifetime listed twice", **with_constants(mu, dict(mu, value=2197.0))),
        dict(name="mu_plus_lifetime in microseconds", **with_constants(dict(mu, value=2.1969811, unit="us"))),
        dict(name="mu_plus_lifetime not positive", **with_constants(dict(mu, value=-2196.9811))),
        dict(name="element listed twice", **with_huff([el, dict(el, q=0.5)], [])),
        dict(name="nuclide listed twice", **with_huff([], [nu, dict(nu, q=0.5)])),
        dict(name="Huff factor above 1", **with_huff([dict(el, q=1.2)], [])),
    ]
    return {"tables": tables, "huff_factors": [-0.5, 0, 1.5, "0.9"]}


def build_cite():
    """(meta, reference) -> file label and citation text, expectations by hand."""
    three = {"DOI": "10.1103/PhysRevC.35.2212", "author": [{"family": "Suzuki"}, {"family": "Measday"},
             {"family": "Roalsvig"}], "container-title": ["Physical Review C"],
             "short-container-title": ["Phys. Rev. C"], "volume": "35", "page": "2212-2224",
             "published": {"date-parts": [[1987, 6, 1]]}}
    cases = [
        ({"bibId": three["DOI"]}, three, "Suzuki1987", "Suzuki et al., Phys. Rev. C 35, 2212 (1987)"),
        ({"bibId": three["DOI"]}, dict(three, **{"article-number": "024307"}),
         "Suzuki1987", "Suzuki et al., Phys. Rev. C 35, 024307 (1987)"),
        ({"bibId": "10.1234/x"}, {"author": [{"family": "Kálmán"}, {"family": "Ng"}],
                                  "container-title": ["Some Journal"], "published": {"date-parts": [[2025, 3]]}},
         "Kalman2025", "Kálmán and Ng, Some Journal (2025)"),
        ({"bibId": "10.1234/x"}, {"author": [{"family": "de Groot"}]}, "deGroot", "de Groot"),
        ({"bibId": "10.1234/x"}, {"author": [{"name": "MuX Collaboration"}], "published": {"date-parts": [[2024]]}},
         "MuXCollaboration2024", "MuX Collaboration (2024)"),
        ({"bibId": "10.1000/unpublished"}, None, "unpublished", "10.1000/unpublished"),
        ({"bibId": "10.1016/0375-9474(88)90330-2"}, None, "0375947488903302", "10.1016/0375-9474(88)90330-2"),
        ({"bibId": "10.1000/mund.x"}, {"title": ["A report"]}, "mundx", "A report"),
    ]
    out = []
    for meta, ref, label, text in cases:
        assert file_label(meta, ref) == label, (file_label(meta, ref), label)
        assert cite_text(ref, meta["bibId"]) == text, (cite_text(ref, meta["bibId"]), text)
        out.append({"meta": meta, "reference": ref, "fileLabel": label, "citeText": text})
    return out


def generate() -> dict:
    """{file name in tests/vectors: text}"""
    cases = {"description": "Small databases and the problems validation must report for them. A case "
                            "starts from 'master'; a file of the case replaces the file of the same path "
                            "(text null: the file is removed). 'file' is the index of the file in 'files'. "
                            "Generated by tests/make_vectors.py; the expectations are written by hand there.",
             "master": MASTER, "cases": build_cases()}
    convert = {"description": "Conversions between lifetime (ns), capture rate (1/us) and capture "
                              "probability (%) with the master tables of tests/fixtures ('q': a Huff "
                              "factor given by the user). 'refused': master tables the conversion "
                              "must refuse, and values that are not a Huff factor.",
               "relative_tolerance": 1e-9, "cases": build_convert(),
               "refused": build_refused()}
    cite = {"description": "File labels and citation texts derived from a bibliography entry "
                           "(reference null: no entry).", "cases": build_cite()}
    repository = {"description": "The test database tests/fixtures as {path: text}.",
                  "files": {p.relative_to(FIXTURE).as_posix(): p.read_text(encoding="utf-8")
                            for p in sorted(FIXTURE.glob("data/**/*.json"))}}
    return {"cases.json": jsonfmt.dumps(cases), "convert.json": jsonfmt.dumps(convert),
            "cite.json": jsonfmt.dumps(cite), "repository.json": jsonfmt.dumps(repository)}


def main():
    for name, text in generate().items():
        (ROOT / "tests" / "vectors" / name).write_text(text, encoding="utf-8")
        print("wrote tests/vectors/%s" % name)


if __name__ == "__main__":
    main()
