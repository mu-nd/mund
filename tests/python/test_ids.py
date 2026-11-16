import json
import unittest

from helpers import ROOT
from mundlib import ids


class IdTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vectors = json.loads((ROOT / "tests/vectors/ids.json").read_text(encoding="utf-8"))

    def test_meta_vectors(self):
        self.assertGreaterEqual(len(self.vectors["meta"]), 3)
        for v in self.vectors["meta"]:
            self.assertEqual(ids.meta_id(v["sublibrary"], v["dataset"], v["doi"], v["key"]), v["id"], v)

    def test_data_vectors(self):
        self.assertGreaterEqual(len(self.vectors["data"]), 67)
        for v in self.vectors["data"]:
            self.assertEqual(ids.data_id(v["sublibrary"], v["dataset"], v["element"], v["mass"],
                                         v["meta_id"], v["key"]), v["id"], v)

    def test_hash_source_strings(self):
        self.assertEqual(ids.meta_source("LT", "EXP", " 10.1103/vl7z-rzp8; 10.48550/arXiv.2501.05897 "),
                         "LT|EXP-META|10.1103/VL7Z-RZP8")
        self.assertEqual(ids.meta_source("LT", "CUR", "10.1000/unpublished", " b "),
                         "LT|CUR-META|10.1000/UNPUBLISHED|B")
        self.assertEqual(ids.data_source("LT", "EXP", "Al", 27, "dcb3b051457e", "plate"),
                         "LT|EXP|Al|27000|dcb3b051457e|PLATE")
        self.assertEqual(ids.data_source("LT", "EXP", "Mg", 0, "dcb3b051457e"),
                         "LT|EXP|Mg|0|dcb3b051457e")

    def test_normalisation(self):
        self.assertEqual(ids.normalize_mass("106.5"), "106500")
        self.assertEqual(ids.normalize_mass(27.0), "27000")
        self.assertEqual(ids.normalize_mass(0), "0")
        self.assertEqual(ids.normalize_element(" fe "), "Fe")
        self.assertEqual(ids.normalize_key(None), "")

    def test_value_is_not_part_of_the_id(self):
        # the identifier depends on what is measured, never on the number
        a = ids.data_id("LT", "EXP", "Si", 28, "96f2c4a2ddaf")
        self.assertEqual(a, ids.data_id("LT", "EXP", "Si", "28", "96f2c4a2ddaf", ""))
        self.assertNotEqual(a, ids.data_id("LT", "CUR", "Si", 28, "96f2c4a2ddaf"))
        self.assertNotEqual(a, ids.data_id("LT", "EXP", "Si", 29, "96f2c4a2ddaf"))
        self.assertNotEqual(a, ids.data_id("LT", "EXP", "Si", 28, "96f2c4a2ddaf", "b"))


if __name__ == "__main__":
    unittest.main()
