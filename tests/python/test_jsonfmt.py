import json
import re
import unittest

from helpers import ROOT
from mundlib import jsonfmt


class JsonFormatTests(unittest.TestCase):
    def test_computed_numbers(self):
        self.assertEqual(jsonfmt.number_text(0.5), "0.5")
        self.assertEqual(jsonfmt.number_text(3), "3")
        self.assertEqual(json.loads(jsonfmt.number_text(1e-7)), 1e-7)
        for bad in (float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                jsonfmt.dumps({"a": bad})

    def test_white_space_is_that_of_javascript(self):
        js = {0x9, 0xA, 0xB, 0xC, 0xD, 0x20, 0xA0, 0x1680, *range(0x2000, 0x200B),
              0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF}
        self.assertEqual({ord(c) for c in jsonfmt.WHITESPACE}, js)
        cls = re.compile("[%s]" % jsonfmt.WHITESPACE_CLASS)
        self.assertEqual({c for c in range(0x10000) if cls.fullmatch(chr(c))}, js)
        key = json.loads((ROOT / "schema" / "v1" / "lt.schema.json").read_text(encoding="utf-8"))["$defs"]["key"]
        self.assertEqual(key["pattern"], r"^[^{0}|]([^|]*[^{0}|])?$".format(jsonfmt.WHITESPACE_CLASS))


if __name__ == "__main__":
    unittest.main()
