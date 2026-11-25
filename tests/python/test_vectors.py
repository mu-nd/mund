import json
import unittest

from helpers import ROOT, load_script, vectors
from mundlib import ids, jsonfmt


class GeneratedVectorTests(unittest.TestCase):
    def test_committed_vectors_are_what_make_vectors_writes(self):
        for name, text in load_script(ROOT / "tests" / "make_vectors.py").generate().items():
            self.assertEqual((ROOT / "tests" / "vectors" / name).read_text(encoding="utf-8"), text,
                             "%s is out of date: run python3 tests/make_vectors.py" % name)


class IdVectorTests(unittest.TestCase):
    def test_ids_vectors(self):
        v = vectors("ids.json")
        for m in v["meta"]:
            args = (m["sublibrary"], m["code"], m["bibId"], m.get("key"))
            self.assertEqual((ids.meta_source(*args), ids.meta_id(*args)), (m["source"], m["id"]), m)
        for d in v["data"]:
            args = (d["sublibrary"], d["code"], d["element"], d["mass"], d["meta_id"], d.get("key"))
            self.assertEqual((ids.data_source(*args), ids.data_id(*args)), (d["source"], d["id"]), d)

    def test_refused_masses(self):
        for text in vectors("ids.json")["refusedMasses"]:
            with self.assertRaises(ValueError, msg="should be refused: %r" % text):
                ids.normalize_mass(text)


class JsonFormatVectorTests(unittest.TestCase):
    def test_jsonfmt_vectors(self):
        v = vectors("jsonfmt.json")
        for text in v["roundTrip"]:
            obj = jsonfmt.loads(text)
            self.assertEqual(jsonfmt.dumps(obj), text)
            self.assertEqual(obj, json.loads(text))
        for text in v["rejected"]:
            with self.assertRaises(ValueError, msg="should be rejected: %r" % text):
                jsonfmt.loads(text)


if __name__ == "__main__":
    unittest.main()
