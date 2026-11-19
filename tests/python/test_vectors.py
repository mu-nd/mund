import importlib.util
import unittest

from helpers import ROOT


class GeneratedVectorTests(unittest.TestCase):
    def test_committed_vectors_are_what_make_vectors_writes(self):
        spec = importlib.util.spec_from_file_location("make_vectors", ROOT / "tests" / "make_vectors.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for name, text in module.generate().items():
            self.assertEqual((ROOT / "tests" / "vectors" / name).read_text(encoding="utf-8"), text,
                             "%s is out of date: run python3 tests/make_vectors.py" % name)


if __name__ == "__main__":
    unittest.main()
