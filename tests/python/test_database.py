import tempfile
import unittest
from pathlib import Path

from helpers import FIXTURE, vectors
from mundlib.database import Database, assign_ids, file_path, fix_files


class FixtureTests(unittest.TestCase):
    def test_the_test_database_is_clean(self):
        db = Database.load(FIXTURE)
        self.assertEqual([str(i) for i in db.validate()], [])
        self.assertEqual(sorted(f.code for f in db.files), ["CUR", "EVAL", "EXP"])
        for f in db.files:
            self.assertEqual(f.path, file_path(f.obj, db.reference(f.meta["bibId"])))
        self.assertEqual(db.reference("DOI:10.1103/VL7Z-RZP8")["author"][0]["family"], "Mizuno",
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


class FileTests(unittest.TestCase):
    def test_crlf_file_is_not_canonical(self):
        rel = "data/master/constants.json"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / rel
            path.parent.mkdir(parents=True)
            path.write_bytes((FIXTURE / rel).read_bytes().replace(b"\n", b"\r\n"))
            issues = Database.load(tmp).validate()
            self.assertEqual([i.code for i in issues if i.file == rel], ["E_CANONICAL"])

    def test_fix_refuses_wrong_document_and_data_shapes(self):
        rel = "data/LT/EXP/test.json"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / rel
            path.parent.mkdir(parents=True)
            for text, reason in [("null", "the top level is not an object"),
                                 ('{"format":"muND/LT/1","sublibrary":"LT","datasetType":"experiment",'
                                  '"meta":{"bibId":"muND:test"},"data":1}',
                                  "data must be an array")]:
                with self.subTest(text=text):
                    path.write_text(text, encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, rel + ": " + reason):
                        fix_files(tmp)
                    self.assertEqual(path.read_text(encoding="utf-8"), text)

    def test_assign_ids(self):
        obj = {"format": "muND/LT/1", "sublibrary": "LT", "datasetType": "experiment",
               "meta": {"bibId": "DOI:10.1103/vl7z-rzp8"},
               "data": [{"nuclide": {"element": "Al", "mass": 27, "isomer": 0}, "key": "plate"},
                        {"nuclide": {"isomer": 0}}]}
        assign_ids(obj)
        self.assertEqual(obj["meta"]["id"], "4d2ed5c83736")
        self.assertEqual(obj["data"][0]["datasetId"], "dd91adba8444")
        self.assertNotIn("datasetId", obj["data"][1], "an entry without element and mass is left to validation")


if __name__ == "__main__":
    unittest.main()
