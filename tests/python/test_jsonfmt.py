import json
import unittest

from mundlib import jsonfmt


class JsonFormatTests(unittest.TestCase):
    def test_numbers_keep_their_digits(self):
        text = '{\n  "a": 13.250,\n  "b": 2177.0,\n  "c": 0.0090,\n  "d": 12,\n  "e": 1.5e-3\n}\n'
        obj = jsonfmt.loads(text)
        self.assertEqual(obj["a"], 13.25)
        self.assertEqual(jsonfmt.dumps(obj), text)

    def test_computed_numbers(self):
        self.assertEqual(jsonfmt.lexeme(0.5), "0.5")
        self.assertEqual(jsonfmt.lexeme(3), "3")
        self.assertEqual(json.loads(jsonfmt.lexeme(1e-7)), 1e-7)
        for bad in (float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                jsonfmt.dumps({"a": bad})

    def test_layout(self):
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
        obj = jsonfmt.loads(expected)
        self.assertEqual(jsonfmt.dumps(obj), expected)
        self.assertEqual(jsonfmt.plain(obj), json.loads(expected))

    def test_strings(self):
        s = 'µs⁻¹ "quoted" back\\slash\nnew\tline   é 日本語'
        self.assertEqual(jsonfmt.dumps({"s": s}), '{\n  "s": %s\n}\n' % json.dumps(s, ensure_ascii=False))
        self.assertEqual(json.loads(jsonfmt.dumps({"s": s}))["s"], s)

    def test_rejects_non_json_numbers(self):
        for bad in ("NaN", "Infinity", "-Infinity"):
            with self.assertRaises(ValueError):
                jsonfmt.loads('{"a": %s}' % bad)


if __name__ == "__main__":
    unittest.main()
