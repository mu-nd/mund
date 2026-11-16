import json
import unittest

from helpers import ROOT
from mundlib import jsonfmt, schema as schema_mod
from mundlib.database import Database, assign_ids, dataset_path, file_label


def issue_set(issues, paths):
    return sorted("%s %s %s #%d %s" % (i.level, i.code, "", paths.index(i.file), i.pointer) for i in issues)


class RepositoryDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = Database.load(ROOT)
        cls.issues = cls.db.validate()

    def test_no_errors(self):
        errors = [str(i) for i in self.issues if i.level == "error"]
        self.assertEqual(errors, [])

    def test_contents(self):
        counts = {}
        for r in self.db.rows("LT"):
            counts[r["dataset"]] = counts.get(r["dataset"], 0) + 1
        self.assertEqual(counts, {"EXP": 67, "CUR": 8, "EVAL": 580})

    def test_ids_are_unique(self):
        seen = [r["row"]["datasetId"] for r in self.db.rows()]
        self.assertEqual(len(seen), len(set(seen)))

    def test_bibliography(self):
        ref = self.db.reference("10.1103/physrevc.35.2212")      # DOIs are compared case-insensitively
        self.assertEqual(ref["author"][0]["family"], "Suzuki")
        self.assertEqual(ref["published"]["date-parts"][0][0], 1987)
        self.assertIsNone(self.db.reference("10.1000/unpublished"))

    def test_schema_and_reference_implementation_agree_on_element_list(self):
        schema = schema_mod.load_schema(ROOT, "lt.schema.json")
        self.assertEqual(schema["$defs"]["element"]["enum"], self.db.elements())
        self.assertEqual(len(self.db.elements()), 118)

    def test_every_file_has_its_canonical_name(self):
        for f in self.db.files:
            self.assertEqual(f.path, dataset_path(f.obj, self.db.reference(f.meta["bibId"])))


class SharedCaseTests(unittest.TestCase):
    """tests/vectors/cases.json - the same cases run in the browser tests."""

    def test_cases(self):
        cases = json.loads((ROOT / "tests/vectors/cases.json").read_text(encoding="utf-8"))["cases"]
        self.assertGreaterEqual(len(cases), 30)
        for case in cases:
            paths = [f["path"] for f in case["files"]]
            db = Database.from_texts(ROOT, {f["path"]: f["text"] for f in case["files"]})
            got = issue_set(db.validate(), paths)
            want = sorted("%s %s %s #%d %s" % (e["level"], e["code"], "", e["file"], e["pointer"])
                          for e in case["expect"])
            self.assertEqual(got, want, case["name"])


class HelperTests(unittest.TestCase):
    def test_file_label(self):
        ref = lambda family, year=None: dict({"author": [{"family": family}]},
                                             **({"published": {"date-parts": [[year, 3]]}} if year else {}))
        self.assertEqual(file_label({"bibId": "10.1234/x"}, ref("Kálmán", 2025)), "Kalman2025")
        self.assertEqual(file_label({"bibId": "10.1000/unpublished"}), "unpublished")
        self.assertEqual(file_label({"bibId": "10.1016/0375-9474(88)90330-2"}, None), "0375947488903302")
        self.assertEqual(file_label({"bibId": "10.1234/x"}, ref("de Groot")), "deGroot")
        self.assertEqual(file_label({"bibId": "10.1234/x"}, {"author": [{"name": "MuX Collaboration"}],
                                                             "published": {"date-parts": [[2024]]}}),
                         "MuXCollaboration2024")

    def test_assign_ids(self):
        obj = {"format": "muND/LT/1", "sublibrary": "LT", "datasetType": "experiment",
               "meta": {"bibId": "10.1103/vl7z-rzp8"},
               "data": [{"nuclide": {"element": "Al", "mass": 27, "isomer": 0}, "key": "plate"}]}
        assign_ids(obj)
        self.assertEqual(obj["meta"]["id"], "dcb3b051457e")
        self.assertEqual(obj["data"][0]["datasetId"], "343adc036597")

    def test_normalize_orders_keys_and_drops_empty_members(self):
        schema = schema_mod.load_schema(ROOT, "lt.schema.json")
        obj = {"data": [{"comment": " ", "key": "", "zzz": 1,
                         "observable": {"lifetime": {"uncertainties": [], "unit": "ns", "value": 1}, "kind": "lifetime"},
                         "nuclide": {"isomer": 0, "mass": 0, "element": " Si "}, "datasetId": "x"}],
               "meta": {"comment": "", "bibId": "10.1234/x", "id": "m", "relatedBibIds": []},
               "datasetType": "experiment", "sublibrary": "LT", "format": "muND/LT/1"}
        out = schema_mod.normalize(obj, schema)
        self.assertEqual(list(out), ["format", "sublibrary", "datasetType", "meta", "data"])
        self.assertEqual(out["meta"], {"id": "m", "bibId": "10.1234/x"})
        row = out["data"][0]
        self.assertEqual(list(row), ["datasetId", "nuclide", "observable", "zzz"])
        self.assertEqual(list(row["nuclide"].items()), [("element", "Si"), ("mass", 0), ("isomer", 0)])
        self.assertEqual(list(row["observable"]), ["kind", "lifetime"])
        # required members are kept even when empty: no uncertainty reported
        self.assertEqual(list(row["observable"]["lifetime"].items()),
                         [("value", 1), ("unit", "ns"), ("uncertainties", [])])


if __name__ == "__main__":
    unittest.main()
