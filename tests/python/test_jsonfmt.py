import json
import unittest

from helpers import ROOT
from mundlib import jsonfmt


class JsonFormatTests(unittest.TestCase):
    def test_numbers_keep_their_digits(self):
        text = '{\n  "a": 13.250,\n  "b": 2177.0,\n  "c": 0.0090,\n  "d": 12,\n  "e": 1.5e-3\n}\n'
        obj = jsonfmt.loads(text)
        self.assertEqual(obj["a"], 13.25)
        self.assertEqual(jsonfmt.dumps(obj), text)

    def test_layout(self):
        obj = {"format": "x", "meta": {"id": "a", "tags": ["p", "q"], "empty": [], "ref": {"year": 1987}},
               "data": [{"id": "1", "v": jsonfmt.make_number("1.0"), "o": ["z"]}, {"id": "2", "v": None}]}
        expected = (
            '{\n'
            '  "format": "x",\n'
            '  "meta": {\n'
            '    "id": "a",\n'
            '    "tags": ["p", "q"],\n'
            '    "empty": [],\n'
            '    "ref": {\n'
            '      "year": 1987\n'
            '    }\n'
            '  },\n'
            '  "data": [\n'
            '    {"id": "1", "v": 1.0, "o": ["z"]},\n'
            '    {"id": "2", "v": null}\n'
            '  ]\n'
            '}\n')
        self.assertEqual(jsonfmt.dumps(obj), expected)
        self.assertEqual(jsonfmt.plain(jsonfmt.loads(expected)), json.loads(expected))

    def test_strings(self):
        s = 'µs⁻¹ "quoted" back\\slash\nnew\tline   é 日本語'
        self.assertEqual(jsonfmt.dumps({"s": s}), '{\n  "s": %s\n}\n' % json.dumps(s, ensure_ascii=False))
        self.assertEqual(json.loads(jsonfmt.dumps({"s": s}))["s"], s)

    def test_javascript_number_text(self):
        vectors = json.loads((ROOT / "tests/vectors/numbers.json").read_text(encoding="utf-8"))
        for v in vectors["js"]:
            self.assertEqual(jsonfmt.js_number(float(v["input"])), v["text"], v)
        for v in vectors["decimals"]:
            self.assertEqual(jsonfmt.decimals(jsonfmt.make_number(v["input"])), v["decimals"], v)
        self.assertEqual(jsonfmt.js_number(3), "3")
        self.assertEqual(jsonfmt.lexeme(0.5), "0.5")

    def test_rejects_non_json_numbers(self):
        for bad in ("NaN", "Infinity", "-Infinity"):
            with self.assertRaises(ValueError):
                jsonfmt.loads('{"a": %s}' % bad)
        for bad in ("1.", ".5", "+1", "0x10", "1,5", ""):
            with self.assertRaises(ValueError):
                jsonfmt.make_number(bad)

    def test_repository_files_round_trip(self):
        files = sorted((ROOT / "data").glob("**/*.json"))
        self.assertTrue(files)
        for path in files:
            text = path.read_text(encoding="utf-8")
            self.assertEqual(jsonfmt.dumps(jsonfmt.loads(text)), text, path)


if __name__ == "__main__":
    unittest.main()
