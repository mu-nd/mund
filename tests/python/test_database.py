import unittest

from helpers import FIXTURE, ROOT, vectors
from mundlib import schema as schema_mod
from mundlib.cite import cite_text, file_label
from mundlib.database import Database, assign_ids, canonical_text, file_path


class RepositoryDataTests(unittest.TestCase):
    """The real data: only what must always hold."""

    def test_no_errors(self):
        errors = [str(i) for i in Database.load(ROOT).validate() if i.level == "error"]
        self.assertEqual(errors, [])

    def test_schema_and_nuclide_table_list_the_same_elements(self):
        db = Database.load(ROOT)
        self.assertEqual(schema_mod.schema_for("muND/LT/1")["$defs"]["element"]["enum"], db.tables()["elements"])


class FixtureTests(unittest.TestCase):
    def test_the_test_database_is_clean(self):
        db = Database.load(FIXTURE)
        self.assertEqual([str(i) for i in db.validate()], [])
        self.assertEqual(sorted(f.code for f in db.files), ["CUR", "EVAL", "EXP"])
        for f in db.files:
            self.assertEqual(f.path, file_path(f.obj, db.reference(f.meta["bibId"])))
        self.assertEqual(db.reference("10.1103/VL7Z-RZP8")["author"][0]["family"], "Mizuno",
                         "DOIs are compared case-insensitively")


class SharedVectorTests(unittest.TestCase):
    def test_validation_cases(self):
        v = vectors("cases.json")
        self.assertTrue(v["cases"])
        for case in v["cases"]:
            texts = dict(v["master"])
            for f in case["files"]:
                if f["text"] is None:
                    texts.pop(f["path"], None)
                else:
                    texts[f["path"]] = f["text"]
            paths = [f["path"] for f in case["files"]]
            got = sorted((i.level, i.code, paths.index(i.file), i.pointer)
                         for i in Database.from_texts(texts).validate())
            want = sorted((e["level"], e["code"], e["file"], e["pointer"]) for e in case["expect"])
            self.assertEqual(got, want, case["name"])

    def test_citations(self):
        for c in vectors("cite.json")["cases"]:
            self.assertEqual(file_label(c["meta"], c["reference"]), c["fileLabel"], c)
            self.assertEqual(cite_text(c["reference"], c["meta"]["bibId"]), c["citeText"], c)


class FileTests(unittest.TestCase):
    def test_assign_ids(self):
        obj = {"format": "muND/LT/1", "sublibrary": "LT", "datasetType": "experiment",
               "meta": {"bibId": "10.1103/vl7z-rzp8"},
               "data": [{"nuclide": {"element": "Al", "mass": 27, "isomer": 0}, "key": "plate"},
                        {"nuclide": {"isomer": 0}}]}
        assign_ids(obj)
        self.assertEqual(obj["meta"]["id"], "dcb3b051457e")
        self.assertEqual(obj["data"][0]["datasetId"], "343adc036597")
        self.assertNotIn("datasetId", obj["data"][1], "an entry without element and mass is left to validation")

    def test_canonical_text(self):
        obj = {"data": [{"comment": " ", "key": "", "zzz": 1,
                         "observable": {"lifetime": {"uncertainties": [], "unit": "ns", "value": 1}, "kind": "lifetime"},
                         "nuclide": {"isomer": 0, "mass": 0, "element": " Si "}, "datasetId": "x"}],
               "meta": {"comment": "", "bibId": "10.1234/x", "id": "m", "relatedBibIds": []},
               "datasetType": "experiment", "sublibrary": "LT", "format": "muND/LT/1"}
        self.assertEqual(canonical_text(obj), (
            '{\n'
            '  "format": "muND/LT/1",\n'
            '  "sublibrary": "LT",\n'
            '  "datasetType": "experiment",\n'
            '  "meta": {\n'
            '    "id": "m",\n'
            '    "bibId": "10.1234/x"\n'
            '  },\n'
            '  "data": [\n'
            '    {"datasetId": "x", "nuclide": {"element": "Si", "mass": 0, "isomer": 0}, "observable": '
            '{"kind": "lifetime", "lifetime": {"value": 1, "unit": "ns", "uncertainties": []}}, "zzz": 1}\n'
            '  ]\n'
            '}\n'))


if __name__ == "__main__":
    unittest.main()
