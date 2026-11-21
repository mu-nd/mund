import unittest

from helpers import vectors
from mundlib import ids


class IdTests(unittest.TestCase):
    def test_vectors(self):
        v = vectors("ids.json")
        self.assertTrue(v["meta"] and v["data"])
        for m in v["meta"]:
            self.assertEqual(ids.meta_id(m["sublibrary"], m["code"], m["bibId"], m["key"]), m["id"], m)
        for d in v["data"]:
            self.assertEqual(ids.data_id(d["sublibrary"], d["code"], d["element"], d["mass"], d["meta_id"], d["key"]),
                             d["id"], d)

    def test_hash_source_strings(self):
        self.assertEqual(ids.meta_source("LT", "EXP", " DOI:10.1103/vl7z-rzp8; DOI:10.48550/arXiv.2501.05897 "),
                         "LT|EXP-META|DOI:10.1103/VL7Z-RZP8")
        self.assertEqual(ids.meta_source("LT", "CUR", "muND:unpublished", " b "),
                         "LT|CUR-META|MUND:UNPUBLISHED|B")
        self.assertEqual(ids.data_source("LT", "EXP", "Al", 27, "4d2ed5c83736", "plate"),
                         "LT|EXP|Al|27000|4d2ed5c83736|PLATE")
        self.assertEqual(ids.data_source("LT", "EXP", "Mg", 0, "4d2ed5c83736"),
                         "LT|EXP|Mg|0|4d2ed5c83736")

    def test_normalisation(self):
        self.assertEqual(ids.normalize_mass("106.5"), "106500")
        self.assertEqual(ids.normalize_mass(27.0), "27000")
        self.assertEqual(ids.normalize_mass(0), "0")
        self.assertEqual(ids.normalize_element(" fe "), "Fe")
        self.assertEqual(ids.normalize_key(None), "")

    def test_value_is_not_part_of_the_id(self):
        a = ids.data_id("LT", "EXP", "Si", 28, "6c7ebc35077d")
        self.assertEqual(a, ids.data_id("LT", "EXP", "Si", "28", "6c7ebc35077d", ""))
        self.assertNotEqual(a, ids.data_id("LT", "CUR", "Si", 28, "6c7ebc35077d"))
        self.assertNotEqual(a, ids.data_id("LT", "EXP", "Si", 29, "6c7ebc35077d"))
        self.assertNotEqual(a, ids.data_id("LT", "EXP", "Si", 28, "6c7ebc35077d", "b"))


if __name__ == "__main__":
    unittest.main()
