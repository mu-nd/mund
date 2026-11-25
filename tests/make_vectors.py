#!/usr/bin/env python3
"""Generate the test data shared by the Python and JavaScript tests.

    python3 tests/make_vectors.py

* tests/vectors/cases.json       small databases and the problems validation must
                                 report for them, and a file's text with its canonical
                                 text (expectations written by hand below)
* tests/vectors/convert.json     conversions, computed with the master tables of
                                 tests/fixtures (checked against hand calculations
                                 in the Python tests); Huff look-ups, impossible
                                 conversions and combined uncertainties written by hand below
* tests/vectors/cite.json        file labels and citation texts of the sources, the forms
                                 of a bibId, and how to cite the project paper and a version
                                 of the database (written by hand below)
* tests/vectors/jsonfmt.json     texts the parsers write back unchanged or must refuse
                                 (written by hand below)
* tests/vectors/sha256.json      SHA-256 digests (hashlib) of texts around the block
                                 boundaries and of a text with multi-byte characters
* tests/vectors/repository.json  the test database tests/fixtures as {path: text}
* tests/vectors/published.json   the published files of a version (tools/mundlib/build.py)
                                 of tests/fixtures with the entry NO_UNCERTAINTY added

tests/vectors/ids.json is maintained by hand.  tests/python/test_vectors.py
checks that the committed files are what this script writes.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import string
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "tools"))

from mundlib import CODE_OF, ids, jsonfmt  # noqa: E402
from mundlib.build import build_dist  # noqa: E402
from mundlib.cite import bib_kind, bib_name, citations, cite_text, file_label, is_bib_id  # noqa: E402
from mundlib.convert import Physics  # noqa: E402
from mundlib.database import entry_hash, file_path  # noqa: E402
from mundlib.schema import canonical_text  # noqa: E402

N = jsonfmt.loads
EXP_HASH = "5f01337caad1"    # Si-28 in exp_doc(), with the compact input in build_entry_hash()
SUZUKI = {"id": "DOI:10.1103/PhysRevC.35.2212", "type": "journal-article",
          "author": [{"family": "Suzuki", "given": "T."}],
          "title": ["Total nuclear capture rates"], "short-container-title": ["Phys. Rev. C"],
          "volume": "35", "page": "2212", "published": {"date-parts": [[1987]]}}
TEST_REF = {"id": "DOI:10.1000/test", "title": ["A test"], "published": {"date-parts": [[2026]]}}
TH_REF = {"id": "DOI:10.1000/th", "title": ["A theory"], "published": {"date-parts": [[2026]]}}
CUR_REF = {"id": "DOI:10.1000/cur", "title": ["A curation"], "published": {"date-parts": [[2026]]}}
EMPTY_HUFF = {"format": "muND/huff-factors/1", "by_element": [], "by_nuclide": []}


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
        "meta": {"bibId": "DOI:10.1103/PhysRevC.35.2212", "facility": "TRIUMF (M20)", "method": "electron"},
        "data": [
            row("Si", 28),
            row("Al", 27, value="864.0", key="plate"),
            row("Al", 27, value="862.5", total="8.1", key="case"),
        ],
    }


def other_doc(dataset_type, bib_id="DOI:10.1000/test", originals=None):
    r = row("Si", 28, "capture_rate", "0.8926", "us-1", "0.0090")
    if originals:
        r["originalData"] = originals
    return {"format": "muND/LT/1", "sublibrary": "LT", "datasetType": dataset_type,
            "meta": {"bibId": bib_id}, "data": [r]}


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


REFERENCES = {r["id"]: r for r in (SUZUKI, TEST_REF, TH_REF, CUR_REF)}
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
    master["data/master/huff_factors.json"] = canonical_text(EMPTY_HUFF)
    master[BIB_PATH] = bibliography(SUZUKI, TEST_REF, TH_REF, CUR_REF)["text"]
    return master


MASTER = build_master()


def build_cases():
    cases = []

    def case(name, files, expect, bib=None):
        """``bib`` replaces the bibliography of MASTER; it is then the last file of the case."""
        cases.append({"name": name, "files": files + ([bib] if bib else []), "expect": expect})

    exp_id = with_ids(exp_doc())["data"][0]["datasetId"]
    exp_hash = EXP_HASH

    d = exp_doc(); d["meta"]["software"] = "Sample"
    case("experiment with software", [entry(d)], [E("E_SCHEMA", "/meta/software")])
    case("theory with original data", [entry(exp_doc()), entry(other_doc("theory", originals=[orig(exp_id, exp_hash)]))],
         [E("E_SCHEMA", "/data/0/originalData", 1)])
    d = other_doc("evaluated"); d["data"][0]["observable"] = quantity("lifetime", "1", "ns")
    case("evaluated lifetime", [entry(d)], [E("E_SCHEMA", "/data/0/observable/kind")])

    d = other_doc("curated", originals=[{"datasetId": exp_id}])
    case("missing content hash", [entry(exp_doc()), entry(d)], [E("E_SCHEMA", "/data/0/originalData/0", 1)])
    d["data"][0]["originalData"] = [orig(exp_id, "bad")]
    case("malformed content hash", [entry(exp_doc()), entry(d)],
         [E("E_SCHEMA", "/data/0/originalData/0/entryHash", 1), W("W_ORIGINAL_CHANGED", "/data/0/originalData/0", 1)])

    for mass, extra in [(-1, []), (301, [W("W_MASS_RANGE", "/data/0/nuclide/mass")])]:
        d = exp_doc(); d["data"][0]["nuclide"]["mass"] = mass
        case("mass outside allowed bounds: %d" % mass, [entry(d)], [E("E_SCHEMA", "/data/0/nuclide/mass")] + extra)
    d = exp_doc(); d["data"][0]["observable"]["lifetime"]["uncertainties"][0]["source"] = "other-source"
    case("unknown uncertainty source", [entry(d)], [E("E_SCHEMA", "/data/0/observable/lifetime/uncertainties/0/source")])
    d = other_doc("theory"); d["data"][0]["observable"] = quantity("capture_probability", "-1", "%")
    case("negative probability", [entry(d)], [E("E_SCHEMA", "/data/0/observable/capture_probability/value")])

    case("empty date components", [], [E("E_SCHEMA", "/references/0/published/date-parts/0")],
         bib=bibliography(dict(TEST_REF, published={"date-parts": [[]]})))

    case("valid experiment file", [entry(exp_doc())], [])
    case("valid curated file that refers to experimental data",
         [entry(exp_doc()), entry(other_doc("curated", originals=[orig(exp_id, exp_hash)]))], [])
    case("valid evaluated and theory files", [entry(other_doc("evaluated")), entry(other_doc("theory", "DOI:10.1000/th"))], [])

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
         [entry(other_doc("curated", "DOI:10.1000/cur", originals=[orig(ev["data"][0]["datasetId"])])), entry(other_doc("evaluated"))],
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

    f = entry(exp_doc()); f["path"] = "data/LT/EXP/%s.json" % with_ids(exp_doc())["meta"]["id"]
    case("file name without label", [f], [E("E_PATH")])

    a = entry(exp_doc())
    b = entry(exp_doc()); b["path"] = b["path"].replace("Suzuki1987", "Zuzuki1987")
    case("two files for the same publication",
         [a, b], [E("E_DUPLICATE_META", "/meta/id", 1)] +
                 [E("E_DUPLICATE_ID", "/data/%d/datasetId" % i, 1) for i in range(3)])

    text = entry(exp_doc())["text"].replace('  "format"', '    "format"', 1)
    case("file not in canonical layout", [entry(exp_doc(), text=text)], [E("E_CANONICAL")])

    text = entry(exp_doc())["text"].replace("\n", "\r\n")
    case("file with CRLF line endings", [entry(exp_doc(), text=text)], [E("E_CANONICAL")])

    case("null document", [entry(exp_doc(), text="null\n")], [E("E_JSON")])
    d = with_ids(exp_doc())
    d["data"] = 1
    case("data is a number", [{"path": file_path(d, SUZUKI), "text": canonical_text(d)}],
         [E("E_SCHEMA", "/data")])

    case("file is not JSON", [entry(exp_doc(), text='{"format": "muND/LT/1",\n')], [E("E_JSON")])

    text = entry(exp_doc())["text"].replace('"value": 756.0,', '"value": 756.0, "value": 757.0,', 1)
    assert '"value": 757.0' in text
    case("member written twice", [entry(exp_doc(), text=text)], [E("E_JSON")])

    d = exp_doc(); d["format"] = "muND/LT/99"
    case("unknown format", [entry(d)], [E("E_FORMAT", "/format")])

    d = exp_doc(); d["data"][0].update(colour="blue", sample="foil")
    case("two unknown properties on one entry", [entry(d)], [E("E_SCHEMA", "/data/0")])

    text = entry(exp_doc())["text"].replace('"key": "plate"', '"key": "plate\\n"')
    case("key ends in a line break", [entry(exp_doc(), text=text)], [E("E_CANONICAL"), E("E_SCHEMA", "/data/1/key")])

    d = exp_doc(); d["data"][0]["colour"] = "blue"
    case("unknown property", [entry(d)], [E("E_SCHEMA", "/data/0")])

    d = exp_doc(); d["data"][0]["observable"]["lifetime"]["uncertainties"][0]["value"] = N("-1.0")
    case("negative uncertainty", [entry(d)], [E("E_SCHEMA", "/data/0/observable/lifetime/uncertainties/0/value")])

    d = exp_doc(); d["data"][0]["observable"]["lifetime"]["uncertainties"][0]["value"] = "1.0"
    case("uncertainty given as text", [entry(d)], [E("E_SCHEMA", "/data/0/observable/lifetime/uncertainties/0/value")])

    d = exp_doc(); d["data"][0]["nuclide"].update(element="He", mass=1)
    case("fewer nucleons than protons", [entry(d)], [E("E_MASS_BELOW_Z", "/data/0/nuclide/mass")])

    d = exp_doc(); d["data"][0]["nuclide"]["mass"] = 60
    case("implausible mass number", [entry(d)], [W("W_MASS_RANGE", "/data/0/nuclide/mass")])
    d = exp_doc(); d["data"][0]["nuclide"]["mass"] = N("60.0")
    case("mass number written 60.0 is still checked for plausibility", [entry(d)], [W("W_MASS_RANGE", "/data/0/nuclide/mass")])

    case("bibliographic information missing", [entry(exp_doc())], [W("W_NO_REFERENCE", "/meta/bibId")],
         bib=bibliography(TEST_REF))

    case("muND key without bibliographic information", [entry(other_doc("evaluated", "muND:test"))], [],
         bib=bibliography(SUZUKI))

    case("NSR keynumber without bibliographic information", [entry(other_doc("evaluated", "NSR:1987SU06"))],
         [W("W_NO_REFERENCE", "/meta/bibId")], bib=bibliography(SUZUKI))

    case("NSR keynumber with bibliographic information", [entry(other_doc("evaluated", "NSR:1987SU06"))], [],
         bib=bibliography(SUZUKI, {"id": "NSR:1987su06", "title": ["Total nuclear capture rates for negative muons"]}))

    case("bibliography entry without id", [entry(exp_doc())], [E("E_SCHEMA", "/references/1", 1)],
         bib=bibliography(SUZUKI, {"title": ["A report"]}))

    for url in ("http://sample.invalid", "https://sample.invalid/report?year=2025"):
        case("absolute bibliography URL " + url, [], [], bib=bibliography(dict(TEST_REF, URL=url)))
    for url in ("reports/test.pdf", "data:text/plain,test", "HTTPS://sample.invalid", "https://",
                "https://sample.invalid/a report"):
        case("invalid bibliography URL " + url, [], [E("E_SCHEMA", "/references/0/URL")],
             bib=bibliography(dict(TEST_REF, URL=url)))

    case("bibliography title that is not a list", [entry(exp_doc())], [E("E_SCHEMA", "/references/1/title", 1)],
         bib=bibliography(SUZUKI, {"id": "DOI:10.1234/x", "title": "A report"}))

    case("reference listed twice", [entry(exp_doc())], [E("E_DUPLICATE_REFERENCE", "/references/1/id", 1)],
         bib=bibliography(SUZUKI, dict(SUZUKI, id="DOI:10.1103/physrevc.35.2212")))

    d = other_doc("evaluated", "DOI:10.1000/test|setup")
    case("source contains the key separator", [entry(d)],
         [E("E_SCHEMA", "/meta/bibId"), E("E_SCHEMA", "/references/0/id", 1)],
         bib=bibliography({"id": "DOI:10.1000/test|setup"}))

    d = exp_doc(); d["meta"]["key"] = "a|b"
    case("key contains the separator", [entry(d)], [E("E_SCHEMA", "/meta/key")])

    text = canonical_text(with_ids(exp_doc())).replace('"key": "plate"', '"key": "plate\ufeff"', 1)
    assert "\ufeff" in text
    case("key ending in a zero-width no-break space (white space)", [entry(exp_doc(), text=text)],
         [E("E_CANONICAL"), E("E_SCHEMA", "/data/1/key")])

    d = exp_doc(); d["data"][0]["comment"] = "checked"
    text = canonical_text(with_ids(d)).replace('"comment": "checked"', '"comment": "checked\u0085"', 1)
    assert "\u0085" in text
    case("comment ending in U+0085 (not white space)", [entry(d, text=text)], [])

    d = exp_doc(); d["meta"]["bibId"] = "https://doi.org/10.1103/PhysRevC.35.2212"
    case("DOI given as URL", [entry(d)], [E("E_SCHEMA", "/meta/bibId")])    # not a bibId: no look-up in the bibliography

    d = exp_doc(); d["meta"]["bibId"] = "10.1103/PhysRevC.35.2212"
    case("DOI without its prefix", [entry(d)], [E("E_SCHEMA", "/meta/bibId")])

    d = other_doc("theory", "DOI:10.1000/th"); d["data"][0]["observable"] = quantity("capture_probability", "120", "%")
    case("capture probability above 100 %", [entry(d)], [E("E_SCHEMA", "/data/0/observable/capture_probability/value")])

    d = exp_doc(); d["data"][0]["observable"]["lifetime"]["value"] = N("0")
    case("lifetime must be positive", [entry(d)], [E("E_SCHEMA", "/data/0/observable/lifetime/value")])

    text = canonical_text(with_ids(exp_doc())).replace('}]}}},', '}]}}, "comment": ""},', 1)
    assert '"comment": ""' in text
    case("empty optional member", [entry(exp_doc(), text=text)],
         [E("E_CANONICAL"), E("E_SCHEMA", "/data/0/comment")])

    f = entry(exp_doc()); f["path"] = f["path"].replace("data/LT/", "data/BR/")
    case("sub-library without a defined format", [f], [E("E_SUBLIBRARY_UNDEFINED")])

    d = exp_doc(); d["data"][0]["nuclide"]["mass"] = N("27.5")
    case("mass number must be an integer", [entry(d)], [E("E_SCHEMA", "/data/0/nuclide/mass")])

    d = exp_doc(); d["data"][0]["nuclide"]["mass"] = N("28.0")
    case("mass number written as 28.0", [entry(d)], [])

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

    uncertainty = exp_doc(); uncertainty["data"][0]["observable"]["lifetime"]["uncertainties"][0]["value"] = N("2.0")
    case("uncertainty is part of the entry hash",
         [entry(uncertainty), entry(other_doc("curated", originals=[orig(exp_id, exp_hash)]))],
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

    d = exp_doc(); d["data"][0]["legacyIds"] = ["Xy12Ab34"]
    case("reference through an eight-character identifier",
         [entry(d), entry(other_doc("curated", originals=[orig("Xy12Ab34", exp_hash)]))],
         [W("W_ORIGINAL_LEGACY", "/data/0/originalData/0", 1)])

    current_id = renamed["data"][0]["datasetId"]
    case("original data listed twice, once through an earlier identifier",
         [entry(renamed), entry(other_doc("curated", originals=[orig(exp_id, exp_hash), orig(current_id, exp_hash)]))],
         [W("W_ORIGINAL_LEGACY", "/data/0/originalData/0", 1), E("E_ORIGINAL_DUPLICATE", "/data/0/originalData/1", 1)])

    d = exp_doc(); d["data"][1]["legacyIds"] = [exp_id]
    case("an earlier identifier that is the current identifier of another entry", [entry(d)],
         [E("E_LEGACY_ID_CONFLICT", "/data/1/legacyIds/0")])

    d = exp_doc(); d["data"][1]["legacyIds"] = ["old-1"]; d["data"][2]["legacyIds"] = ["old-1"]
    case("the same earlier identifier in two entries", [entry(d)],
         [E("E_LEGACY_ID_CONFLICT", "/data/2/legacyIds/0")])

    d = exp_doc(); d["data"][0]["legacyIds"] = ["old-1", "old-1"]
    case("an earlier identifier listed twice in one entry", [entry(d)],
         [E("E_SCHEMA", "/data/0/legacyIds"), E("E_LEGACY_ID_CONFLICT", "/data/0/legacyIds/1")])

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

    def master_case(name, path, obj, expect, *files):
        case(name, [{"path": path, "text": jsonfmt.dumps(obj)}, *files], expect)

    fac = jsonfmt.loads(MASTER["data/master/facilities.json"])
    fac["facilities"].append(dict(fac["facilities"][0]))
    master_case("facility listed twice", "data/master/facilities.json", fac,
                [E("E_DUPLICATE_FACILITY", "/facilities/%d/abbr" % (len(fac["facilities"]) - 1))])
    master_case("wrong master format", "data/master/huff_factors.json", {"format": "muND/constants/2"},
                [E("E_FORMAT", "/format")])
    huff = dict(EMPTY_HUFF, by_element=[{"z": 1, "q": 0}, {"z": 2, "q": 2}],
                by_nuclide=[{"z": 1, "a": 1, "q": 0}, {"z": 2, "a": 4, "q": 2}])
    master_case("Huff factors outside (0, 1]", "data/master/huff_factors.json", huff,
                [E("E_SCHEMA", "/%s/%d/q" % (member, i)) for member in ("by_element", "by_nuclide") for i in (0, 1)])

    path = "data/master/nuclides.json"
    nuc = N(MASTER[path])
    nuc["elements"][:2] = ["He", "H"]
    master_case("element symbols at the wrong atomic numbers", path, nuc, [E("E_ELEMENT_ORDER", "/elements")])
    nuc["elements"][:2] = ["H", "H"]
    master_case("element symbol listed twice", path, nuc,
                [E("E_SCHEMA", "/elements"), E("E_ELEMENT_ORDER", "/elements")])

    nuc = N(MASTER[path])
    nuc["isotope_ranges"] = [{"z": 2, "a_min": 3, "a_max": 4}, {"z": 2, "a_min": 3, "a_max": 5}]
    nuc["monoisotopic"] = [{"z": 4, "a": 9}, {"z": 4, "a": 10}, {"z": 119, "a": 300}]
    master_case("conflicting or unknown atomic numbers in nuclide rows", path, nuc,
                [E("E_DUPLICATE_Z", "/isotope_ranges/1/z"), E("E_DUPLICATE_Z", "/monoisotopic/1/z"),
                 E("E_UNKNOWN_Z", "/monoisotopic/2/z")])

    nuc = N(MASTER[path])
    nuc["isotope_ranges"] = [{"z": 3, "a_min": 1, "a_max": 2}]
    nuc["monoisotopic"] = [{"z": 2, "a": 1}]
    master_case("isotope table masses below Z", path, nuc,
                [E("E_MASS_BELOW_Z", "/isotope_ranges/0/a_min"), E("E_MASS_BELOW_Z", "/isotope_ranges/0/a_max"),
                 E("E_MASS_BELOW_Z", "/monoisotopic/0/a")])
    huff = dict(EMPTY_HUFF, by_nuclide=[{"z": 2, "a": 1, "q": 1}])
    master_case("Huff isotope mass below Z", "data/master/huff_factors.json", huff,
                [E("E_MASS_BELOW_Z", "/by_nuclide/0/a")])

    # the checks of a data file read the nuclide and facility lists
    fac["facilities"] = {}
    master_case("facilities that are not a list", "data/master/facilities.json", fac,
                [E("E_SCHEMA", "/facilities"), E("E_FACILITY", "/meta/facility", 1)], entry(exp_doc()))
    nuc = jsonfmt.loads(MASTER["data/master/nuclides.json"]); nuc["isotope_ranges"][0] = None
    master_case("isotope range that is not an object", "data/master/nuclides.json", nuc,
                [E("E_SCHEMA", "/isotope_ranges/0")], entry(exp_doc()))
    nuc = jsonfmt.loads(MASTER["data/master/nuclides.json"])
    si = next(i for i, r in enumerate(nuc["isotope_ranges"]) if r["z"] == 14)
    nuc["isotope_ranges"][si]["a_min"] = "28"
    master_case("isotope range bound written as text", "data/master/nuclides.json", nuc,
                [E("E_SCHEMA", "/isotope_ranges/%d/a_min" % si)], entry(exp_doc()))
    nuc = jsonfmt.loads(MASTER["data/master/nuclides.json"]); del nuc["isotope_ranges"][si]["a_max"]
    master_case("isotope range without its upper bound", "data/master/nuclides.json", nuc,
                [E("E_SCHEMA", "/isotope_ranges/%d" % si)], entry(exp_doc()))
    nuc = jsonfmt.loads(MASTER["data/master/nuclides.json"]); nuc["elements"][0] = ["H"]
    master_case("element symbol that is not text", "data/master/nuclides.json", nuc,
                [E("E_SCHEMA", "/elements/0")], entry(exp_doc()))
    fac = jsonfmt.loads(MASTER["data/master/facilities.json"]); fac["facilities"][0]["abbr"] = ["TRIUMF (M20)"]
    master_case("facility abbreviation that is not text", "data/master/facilities.json", fac,
                [E("E_SCHEMA", "/facilities/0/abbr")], entry(exp_doc()))
    f = entry(exp_doc()); f["text"] = f["text"].replace('"element": "Si"', '"element": ["Si"]', 1)
    case("element given as a list", [f], [E("E_SCHEMA", "/data/0/nuclide/element")])
    f = entry(exp_doc()); f["path"] = "data/LT/EXP/%s.json" % with_ids(exp_doc())["meta"]["id"]
    case("bibliography date that is not a list, with a file name to correct", [f],
         [E("E_PATH"), E("E_SCHEMA", "/references/0/published/date-parts", 1)],
         bib=bibliography(dict(SUZUKI, published={"date-parts": {}})))
    nuc = jsonfmt.loads(MASTER["data/master/nuclides.json"]); nuc["monoisotopic"][0] = None
    master_case("monoisotopic entry that is null", "data/master/nuclides.json", nuc,
                [E("E_SCHEMA", "/monoisotopic/0")], entry(exp_doc()))

    c = jsonfmt.loads(MASTER["data/master/constants.json"]); c["mu_plus_lifetime"]["value"] = N("0")
    master_case("mu_plus_lifetime not positive", "data/master/constants.json", c,
                [E("E_SCHEMA", "/mu_plus_lifetime/value")])
    huff = {"format": "muND/huff-factors/1",
            "by_element": [{"z": 14, "q": N("0.9924")}, {"z": 14, "q": N("0.9925")}],
            "by_nuclide": [{"z": 26, "a": 56, "q": N("0.9715")}, {"z": 26, "a": 58, "q": N("0.9716")},
                           {"z": 26, "a": 56, "q": N("0.9715")}]}
    master_case("Huff factor listed twice", "data/master/huff_factors.json", huff,
                [E("E_DUPLICATE_HUFF", "/by_element/1"), E("E_DUPLICATE_HUFF", "/by_nuclide/2")])
    huff = {"format": "muND/huff-factors/1",
            "by_element": [{"z": N("14.0"), "q": N("0.9924")}, {"z": N("14.0"), "q": N("0.9925")}],
            "by_nuclide": []}
    master_case("Huff factor listed twice, Z written 14.0", "data/master/huff_factors.json", huff,
                [E("E_DUPLICATE_HUFF", "/by_element/1")])

    return cases


def build_entry_hash():
    """The content hash, including its sorted preimage and the written digits."""
    text = ('{"observable":{"lifetime":{"value":756.0,"unit":"ns","uncertainties":[{"value":1.0,"source":"total"}]},'
            '"kind":"lifetime"},"nuclide":{"isomer":0,"mass":28,"element":"Si"},"comment":"sample"}')
    compact = ('{"nuclide":{"element":"Si","isomer":0,"mass":28},"observable":{"kind":"lifetime",'
               '"lifetime":{"uncertainties":[{"source":"total","value":1.0}],"unit":"ns","value":756.0}}}')
    row = N(text)
    assert jsonfmt.compact({k: row[k] for k in ("nuclide", "observable")}) == compact
    assert entry_hash(row) == EXP_HASH
    return {"entry": text, "compact": compact, "hash": EXP_HASH}


def build_canonical():
    """A file's text and its canonical text (expectation by hand)."""
    text = ('{"data": [{"comment": " ", "key": "", "zzz": 1, "observable": {"lifetime": {"uncertainties": [], '
            '"unit": "ns", "value": 1.0}, "kind": "lifetime"}, "nuclide": {"isomer": 0, "mass": 0, "element": " Si "}, '
            '"datasetId": "x"}], "meta": {"comment": "", "bibId": "DOI:10.1234/x", "id": "m", "relatedBibIds": []}, '
            '"datasetType": "experiment", "sublibrary": "LT", "format": "muND/LT/1"}')
    canonical = ('{\n  "format": "muND/LT/1",\n  "sublibrary": "LT",\n  "datasetType": "experiment",\n'
                 '  "meta": {\n    "id": "m",\n    "bibId": "DOI:10.1234/x"\n  },\n  "data": [\n'
                 '    {"datasetId": "x", "nuclide": {"element": "Si", "mass": 0, "isomer": 0}, "observable": '
                 '{"kind": "lifetime", "lifetime": {"value": 1.0, "unit": "ns", "uncertainties": []}}, "zzz": 1}\n  ]\n}\n')
    assert canonical_text(jsonfmt.loads(text)) == canonical, canonical_text(jsonfmt.loads(text))
    snapshot = '{"𐀀": [], "10": {}, "\ue000": "", "2": null, "__proto__": [{"v": 1.00, "s": " x "}]}'
    ordered = '{"2": null, "10": {}, "__proto__": [{"s": " x ", "v": 1.00}], "𐀀": [], "\ue000": ""}'
    correction = '{"format":"muND/LT/1","data":[{"corrections":[{"after":"  ","before":%s}]}]}' % snapshot
    expected = ('{\n  "format": "muND/LT/1",\n  "data": [\n'
                '    {"corrections": [{"before": %s, "after": "  "}]}\n  ]\n}\n' % ordered)
    assert canonical_text(N(correction)) == expected
    return [{"text": text, "canonical": canonical}, {"text": correction, "canonical": expected}]


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
    # Extremes with representable results, from the lifetime and rate equations.
    out.extend([
        dict(z=14, a=28, observable="lifetime", value=1e-180, uncertainty=None, unit="ns",
             expected={"capture_rate_us-1": 1e183, "capture_rate_us-1_unc": None, "capture_probability_pct": 100.0}),
        dict(z=14, a=28, observable="capture_rate", value=1e155, uncertainty=None, unit="us-1",
             expected={"lifetime_ns": 1e-152, "lifetime_ns_unc": None, "capture_probability_pct": 100.0}),
        dict(z=14, a=28, observable="capture_rate", value=1e200, uncertainty=1e200, unit="us-1",
             expected={"lifetime_ns": 1e-197, "lifetime_ns_unc": 1e-197,
                       "capture_probability_pct_unc": 100 * 0.9924 / 2.1969811 / 1e200}),
    ])
    # Independent 80-digit Decimal calculation on the binary64 inputs.
    out.append(dict(z=14, a=28, observable="capture_probability", value=99.99999999999999,
                    uncertainty=1e-15, unit="%", expected={
                        "huff_factor": 0.9924, "huff_source": "nuclide",
                        "lifetime_ns": 3.1460075800226406e-13, "lifetime_ns_unc": 2.21380602579605e-14,
                        "capture_rate_us-1": 3178631883629483.5, "capture_rate_us-1_unc": 223676333854089.4,
                        "capture_probability_pct": 99.99999999999999, "capture_probability_pct_unc": 1e-15}))
    return out


# Huff factors of tests/fixtures: (z, a, Q, source), by hand
LOOKUPS = [
    (14, 28, 0.9924, "nuclide"),
    (14, 0, 0.9924, "element"),     # natural target: element value
    (14, 99, 0.9924, "element"),    # isotope not tabulated: element value
    (26, 56, 0.9715, "nuclide"),
    (26, 58, 0.9716, "nuclide"),    # isotope dependent
    (26, 0, 0.9715, "element"),
    (3, 6, 1.0, "none"),            # no entry: Q = 1
]

# conversions that give null
IMPOSSIBLE = [
    (14, 28, "lifetime", 1e-320, None, "ns"),            # capture rate exceeds the numeric range
    (14, 28, "lifetime", 0.0, 1.0, "ns"),                 # lifetime not positive
    (14, 28, "capture_probability", -1.0, 1.0, "%"),
    (14, 28, "capture_probability", 101.0, 1.0, "%"),
    (14, 28, "capture_probability", 100.0, 1.0, "%"),     # capture rate infinite
    (14, 28, "lifetime", 756.0, 1.0, "us-1"),             # unit of another kind
    (14, 28, "lifetime", 756.0, -1.0, "ns"),              # negative uncertainty
    (14, 28, "lifetime", "756.0", 1.0, "ns"),             # value not a number
    (14, 28, "lifetime", 756.0, "1.0", "ns"),             # uncertainty not a number
    (14, 28, "lifetime", True, None, "ns"),               # true is not a number
    (14, 28, "constructor", 50.0, 1.0, "length"),         # inherited names are no observable or unit
    (14, 28, "toString", 756.0, 1.0, "ns"),
    (14, 28, "lifetime", 756.0, 1.0, "constructor"),
    (14, 28, "lifetime", 756.0, 1.0, "toString"),
]

# uncertainties of a data entry and their combined value, by hand
COMBINED = [
    ([{"source": "statistical", "value": 1e-200}], 1e-200),
    ([{"source": "statistical", "value": 1e200}], 1e200),
    ([{"source": "statistical", "value": 3e200}, {"source": "systematic", "value": 4e200}], 5e200),
    ([{"source": "statistical", "value": 1.5e308}, {"source": "systematic", "value": 1.5e308}], None),
    ([{"source": "total", "value": 5.0}], 5.0),
    ([], None),
    ([{"source": "statistical", "value": 0.8}, {"source": "systematic", "value": 0.7}],
     (0.8 ** 2 + 0.7 ** 2) ** 0.5),                         # components in quadrature
    ([{"source": "statistical", "value": 3.0}, {"source": "total", "value": 4.0},
      {"source": "systematic", "value": 1.0}], 4.0),        # a stated total wins
]


def build_refused():
    """Master tables and Huff factors both implementations must refuse (never use a guess instead)."""
    huff = json.loads(fixture_text("data/master/huff_factors.json"))
    constants = json.loads(fixture_text("data/master/constants.json"))

    def with_constants(**members):
        return {"huff": EMPTY_HUFF, "constants": dict(format=constants["format"], **members)}

    def with_huff(by_element, by_nuclide):
        return {"huff": dict(EMPTY_HUFF, by_element=by_element, by_nuclide=by_nuclide), "constants": constants}

    el, nu = huff["by_element"][0], huff["by_nuclide"][0]
    tables = [
        dict(name="mu_plus_lifetime missing", **with_constants()),
        dict(name="mu_plus_lifetime not positive",
             **with_constants(mu_plus_lifetime=dict(constants["mu_plus_lifetime"], value=-2196.9811))),
        dict(name="element listed twice", **with_huff([el, dict(el, q=0.5)], [])),
        dict(name="nuclide listed twice", **with_huff([], [nu, dict(nu, q=0.5)])),
        dict(name="Huff factor above 1", **with_huff([dict(el, q=1.2)], [])),
    ]
    return {"tables": tables, "huff_factors": [-0.5, 0, 1.5, "0.9"]}


def build_project():
    """(paper, manifest) -> how to cite the paper and that version of the database.  Expectations by hand."""
    names = ["Watanabe Yukinobu", "Niikura Megumi", "Abe Shinichiro", "Biswas Sayani", "Iwamoto Hiroki", "Hillier Adrian",
             "Kawamura Naritoshi", "Kawase Shoichiro", "Matsuzaki Teiichiro", "Minato Futoshi", "Mizuno Rurie", "Tomono Dai",
             "Yamaguchi Yuji"]
    authors = [{"family": n.split()[0], "given": n.split()[1]} for n in names]
    paper = {"title": "Muon Nuclear Data Development Project", "year": 2026, "url": "https://arxiv.org/abs/2605.15539",
             "arxiv": "2605.15539", "primaryClass": "nucl-ex"}
    report = {"title": "A report", "year": 2025, "url": "https://example.org/report",
              "authors": [{"family": "Dupont", "given": "Jean--Pierre"}, {"family": "Sato", "given": "T. Y."}]}
    data = {"title": "muND: Muon Nuclear Data", "author": "muND Project Team"}
    site_url = "https://ribf.riken.jp/muon/"
    release = {"label": "v1", "version": "1.0.0", "kind": "release", "commit": "abcdef1234", "date": "2026-11-16T10:00:00+09:00"}
    development = dict(release, label="latest", version="1.0.0+2.gabcdef1", kind="development")
    title = ", Muon Nuclear Data Development Project, arXiv:2605.15539 (2026)."
    database = "muND Project Team, muND: Muon Nuclear Data, "
    cases = [
        (dict(paper, authors=authors[:2]), development,
         "Y. Watanabe and M. Niikura" + title,
         database + "development version 1.0.0+2.gabcdef1, commit abcdef1, not a stable version (2026), "
                    "https://ribf.riken.jp/muon/explorer/?v=latest."),
        (dict(paper, authors=authors[:3]), release,
         "Y. Watanabe, M. Niikura, and S. Abe" + title,
         database + "version 1.0.0 (2026), https://ribf.riken.jp/muon/explorer/?v=v1."),
        (dict(paper, authors=authors[:10]), dict(release, date=None),
         "Y. Watanabe, M. Niikura, S. Abe, S. Biswas, H. Iwamoto, A. Hillier, N. Kawamura, S. Kawase, T. Matsuzaki, "
         "and F. Minato" + title,
         database + "version 1.0.0, https://ribf.riken.jp/muon/explorer/?v=v1."),
        (dict(paper, authors=authors), dict(development, commit=None),
         "Y. Watanabe et al." + title,
         database + "development version 1.0.0+2.gabcdef1, not a stable version (2026), "
                    "https://ribf.riken.jp/muon/explorer/?v=latest."),
        (dict(report, authors=[{"family": "Tavrel", "given": "𠮷郎-Meli\ufeffLari\u0085Seli"}]), release,
         "𠮷.-M. L. Tavrel, A report, https://example.org/report (2025).",
         database + "version 1.0.0 (2026), https://ribf.riken.jp/muon/explorer/?v=v1."),
        (report, release,
         "J.-P. Dupont and T. Y. Sato, A report, https://example.org/report (2025).",
         database + "version 1.0.0 (2026), https://ribf.riken.jp/muon/explorer/?v=v1."),
        (dict(paper, authors=[]), release, None,
         database + "version 1.0.0 (2026), https://ribf.riken.jp/muon/explorer/?v=v1."),
    ]
    out = []
    for paper_, manifest, paper_text, database_text in cases:
        expect = {"paper": paper_text, "database": database_text}
        got = citations({"paper": paper_, "data": data, "siteUrl": site_url}, manifest)
        assert got == expect, (got, expect)
        out.append({"paper": paper_, "data": data, "manifest": manifest, "siteUrl": site_url, "expect": expect})
    url = "https://mund.example.invalid/muon/explorer/?v=v1&z=14&id=123456abcdef"
    expect = {"paper": None, "database": database + "version 1.0.0 (2026), " + url + "."}
    assert citations({"data": data}, release, url) == expect
    out.append({"paper": {"authors": []}, "data": data, "manifest": release, "url": url, "expect": expect})
    return out


def build_cite():
    """(meta, reference) -> file label and citation text; bibId -> kind and name.  Expectations by hand."""
    three = {"id": "DOI:10.1103/PhysRevC.35.2212", "author": [{"family": "Suzuki"}, {"family": "Measday"},
             {"family": "Roalsvig"}], "container-title": ["Physical Review C"],
             "short-container-title": ["Phys. Rev. C"], "volume": "35", "page": "2212-2224",
             "published": {"date-parts": [[1987, 6, 1]]}}
    cases = [
        ({"bibId": three["id"]}, three, "Suzuki1987", "Suzuki et al., Phys. Rev. C 35, 2212 (1987)"),
        ({"bibId": three["id"]}, dict(three, **{"article-number": "024307"}),
         "Suzuki1987", "Suzuki et al., Phys. Rev. C 35, 024307 (1987)"),
        ({"bibId": "DOI:10.1234/x"}, {"author": [{"family": "Kálmán"}, {"family": "Ng"}],
                                  "container-title": ["Some Journal"], "published": {"date-parts": [[2025, 3]]}},
         "Kalman2025", "Kálmán and Ng, Some Journal (2025)"),
        ({"bibId": "DOI:10.1234/x"}, {"author": [{"family": "de Groot"}]}, "deGroot", "de Groot"),
        ({"bibId": "DOI:10.1234/x"}, {"author": [{"name": "MuX Collaboration"}], "published": {"date-parts": [[2024]]}},
         "MuXCollaboration2024", "MuX Collaboration (2024)"),
        ({"bibId": "muND:unpublished"}, None, "unpublished", "muND:unpublished"),
        ({"bibId": "NSR:1987SU06"}, None, "1987SU06", "NSR:1987SU06"),
        ({"bibId": "DOI:10.1016/0375-9474(88)90330-2"}, None, "0375947488903302", "DOI:10.1016/0375-9474(88)90330-2"),
        ({"bibId": "muND:x"}, {"id": "muND:x", "title": ["A report"]}, "x", "A report"),
        ({"bibId": "muND:sample"}, {"author": [{"family": "ꟲ"}], "published": {"date-parts": [[2020]]}},
         "sample", "ꟲ (2020)"),
        ({"bibId": "muND:test"}, {"author": [{}], "title": ["Foil measurements"]}, "test", "Foil measurements"),
        ({"bibId": "muND:test"}, {"author": [{"family": "Veln"}], "article-number": "P-17", "page": "3-7"},
         "Veln", "Veln, P-17"),
    ]
    out = []
    for meta, ref, label, text in cases:
        assert file_label(meta, ref) == label, (file_label(meta, ref), label)
        assert cite_text(ref, meta["bibId"]) == text, (cite_text(ref, meta["bibId"]), text)
        out.append({"meta": meta, "reference": ref, "fileLabel": label, "citeText": text})
    bib_ids = [
        ("DOI:10.1103/PhysRevC.35.2212", "DOI", "10.1103/PhysRevC.35.2212"),
        ("DOI:10.1016/0375-9474(88)90330-2", "DOI", "10.1016/0375-9474(88)90330-2"),
        ("DOI:10.1103/x:y", "DOI", "10.1103/x:y"),
        (" DOI:10.1103/x ", "DOI", "10.1103/x"),
        ("NSR:1987SU06", "NSR", "1987SU06"),
        ("muND:Suzuki1975thesis", "muND", "Suzuki1975thesis"),
        ("muND:unpublished", "muND", "unpublished"),
        ("doi:10.1103/x", "", "doi:10.1103/x"),
        ("mund:x", "", "mund:x"),
        ("DOI:10.1000/test|setup", "", "DOI:10.1000/test|setup"),
        ("DOI:10.1103/a;b", "", "DOI:10.1103/a;b"),
        ("DOI:10.1103/a b", "", "DOI:10.1103/a b"),
        ("DOI:10.110/x", "", "DOI:10.110/x"),
        ("NSR:1987", "", "NSR:1987"),
        ("muND:", "", "muND:"),
        ("muND:-x", "", "muND:-x"),
        ("https://doi.org/10.1103/x", "", "https://doi.org/10.1103/x"),
        ("10.1103/x", "", "10.1103/x"),
        ("1987SU06", "", "1987SU06"),
        ("muNDx", "", "muNDx"),
        ("", "", ""),
    ]
    for bib_id, kind, name in bib_ids:
        assert (bib_kind(bib_id), bib_name(bib_id), is_bib_id(bib_id)) == (kind, name, kind != ""), bib_id
    return {"cases": out, "bibIds": [{"bibId": b, "kind": k, "name": n} for b, k, n in bib_ids],
            "entryKeys": [{"datasetId": did, "key": "muND_v1_" + did} for did in ("0123456789ab", "0123456789ac")],
            "project": build_project()}


def build_jsonfmt():
    """Texts both parsers read and write back unchanged, and texts both must refuse."""
    round_trip = [
        '{\n  "a": 13.250,\n  "b": 2177.0,\n  "c": 0.0090,\n  "d": 12,\n  "e": 1.5e-3\n}\n',
        '{\n  "format": "x",\n  "meta": {\n    "id": "a",\n    "tags": ["p", "q"],\n    "empty": [],\n'
        '    "ref": {\n      "year": 1987\n    }\n  },\n  "data": [\n'
        '    {"id": "1", "v": 1.0, "o": ["z"]},\n    {"id": "2", "v": null}\n  ]\n}\n',
        '{\n  "s": "µs⁻¹ \\"quoted\\" back\\\\slash\\nnew\\tline   é 日本語 \\r\\b\\f\\u0001"\n}\n',
        '{\n  "a": [1, -0.5, 1e3, true, false, null, "x"],\n  "__proto__": {\n    "__proto__": 1\n  },\n'
        '  "b": {}\n}\n',
    ]
    rejected = [
        '', '{', '{"a": 1,}', '[1, 2,]', '{"a": NaN}', '{"a": Infinity}', '{"a": -Infinity}', "{'a': 1}",
        '{"a": 01}', '{"a": 1.}', '{"a": .5}', '{"a": +1}', '{"a": "line\nbreak"}', '{"a": 1} x', '{"a" 1}',
        '[1 2]', '{"a": "\\x"}', '﻿{}',
        '{"a": 1e400}', '{"a": -1e400}', '{"a": 1%s}' % ("0" * 399), '{"a": 1, "a": 2}',
    ]
    return {"roundTrip": round_trip, "rejected": rejected}


def build_sha256():
    """Texts of 0 to 1000 characters (around the 64-byte blocks) and one with multi-byte characters."""
    texts = [(string.ascii_lowercase * 40)[:n] for n in (0, 3, 55, 56, 63, 64, 65, 119, 120, 1000)]
    texts.append("µs⁻¹ 日本語 🙂")
    return [{"text": t, "sha256": hashlib.sha256(t.encode("utf-8")).hexdigest()} for t in texts]


# an experimental entry without uncertainty, with a comment that needs quoting in CSV
NO_UNCERTAINTY = row("Mn", 55, value="230.0", total=None, key="extra",
                     comment='no uncertainty given, "test" entry\nsecond line')
RELEASE = {"version": "1.0.0", "kind": "release", "commit": "abcdef1234567890abcdef1234567890abcdef12",
           "date": "2026-11-16T12:00:00+09:00"}


def build_published():
    """Version v1 of tests/fixtures, with NO_UNCERTAINTY added to its experiment file, as build_dist writes it."""
    with tempfile.TemporaryDirectory() as tmp:
        root, out = Path(tmp) / "root", Path(tmp) / "v1"
        shutil.copytree(FIXTURE / "data", root / "data")
        shutil.copytree(ROOT / "schema", root / "schema")       # build_dist puts them in the archive
        (root / "site").mkdir()
        shutil.copy(ROOT / "site" / "config.json", root / "site")     # and its README links the site
        path = next((root / "data" / "LT" / "EXP").glob("*.json"))
        doc = jsonfmt.loads(path.read_text(encoding="utf-8"))
        doc["data"].append(dict(NO_UNCERTAINTY))
        path.write_bytes(canonical_text(with_ids(doc)).encode("utf-8"))
        manifest = build_dist(root, out, "v1", RELEASE)
        manifest["archive"] = {"path": manifest["archive"]["path"]}      # its bytes depend on the zlib in use
        lt, csv, master = ((out / rel).read_bytes().decode("utf-8") for rel in ("LT.json", "csv/LT.csv", "master.json"))
        return {"manifest": manifest, "master": jsonfmt.loads(master), "lt": lt, "csv": csv}


def generate() -> dict:
    """{file name in tests/vectors: text}"""
    cases = {"description": "Small databases and the problems validation must report for them. A case "
                            "starts from 'master'; a file of the case replaces the file of the same path "
                            "(text null: the file is removed). 'file' is the index of the file in 'files'. "
                            "Generated by tests/make_vectors.py; the expectations are written by hand there. "
                            "'canonical': a file's text and its canonical text (members in schema order, "
                            "unknown members last, strings trimmed, empty optional members dropped, numbers "
                            "as written).",
             "master": MASTER, "cases": build_cases(), "canonical": build_canonical(), "entryHash": build_entry_hash()}
    convert = {"description": "Conversions between lifetime (ns), capture rate (1/us) and capture "
                              "probability (%) with the master tables of tests/fixtures ('q': a Huff "
                              "factor given by the user). 'lookups': the Huff factor and its source "
                              "for a nuclide; 'impossible': conversions that give null (the runners "
                              "add NaN and infinite values, which JSON cannot hold); 'combined': the "
                              "overall uncertainty of a list of uncertainties; 'refused': master "
                              "tables the conversion must refuse, and values that are not a Huff factor.",
               "relative_tolerance": 1e-9, "cases": build_convert(),
               "lookups": [{"z": z, "a": a, "huff_factor": q, "huff_source": source}
                           for z, a, q, source in LOOKUPS],
               "impossible": [{"z": z, "a": a, "observable": obs, "value": value, "uncertainty": unc,
                               "unit": unit} for z, a, obs, value, unc, unit in IMPOSSIBLE],
               "combined": [{"uncertainties": u, "value": value} for u, value in COMBINED],
               "refused": build_refused()}
    cite = {"description": "'cases': file labels and citation texts derived from a bibliography entry "
                           "(reference null: no entry); 'bibIds': texts with the kind of bibId they are "
                           "('': none) and the name after the prefix; 'project': how to cite the project paper "
                           "(null: it has no authors) and a version of the database, which the site "
                           "shows at siteUrl + 'explorer/?v=' + the label of the version.", **build_cite()}
    texts = {"description": "'roundTrip': texts in canonical form that are written back unchanged; "
                            "'rejected': texts the parser must refuse.", **build_jsonfmt()}
    sha256 = {"description": "SHA-256 digests of the UTF-8 bytes of texts, computed with hashlib.",
              "cases": build_sha256()}
    repository = {"description": "The test database tests/fixtures as {path: text}.",
                  "files": {p.relative_to(FIXTURE).as_posix(): p.read_text(encoding="utf-8")
                            for p in sorted(FIXTURE.glob("data/**/*.json"))}}
    published = {"description": "manifest.json, master.json, LT.json (text) and csv/LT.csv (text) of version v1 of "
                                "the test database with one entry added whose source gives no uncertainty; the "
                                "manifest leaves out the size and checksum of the zip archive.",
                 **build_published()}
    return {"cases.json": jsonfmt.dumps(cases), "convert.json": jsonfmt.dumps(convert),
            "cite.json": jsonfmt.dumps(cite), "jsonfmt.json": jsonfmt.dumps(texts),
            "sha256.json": jsonfmt.dumps(sha256), "repository.json": jsonfmt.dumps(repository),
            "published.json": jsonfmt.dumps(published)}


def main():
    for name, text in generate().items():
        (ROOT / "tests" / "vectors" / name).write_bytes(text.encode("utf-8"))
        print("wrote tests/vectors/%s" % name)


if __name__ == "__main__":
    main()
