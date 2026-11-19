import json
import unittest

from helpers import FIXTURE, vectors
from mundlib.convert import Physics, combined_uncertainty


def master(name):
    return json.loads((FIXTURE / "data" / "master" / name).read_text(encoding="utf-8"))


class ConvertTests(unittest.TestCase):
    """With the master tables of the test database."""

    @classmethod
    def setUpClass(cls):
        cls.physics = Physics(master("huff_factors.json"), master("constants.json"))
        cls.vectors = vectors("convert.json")

    def test_master_tables(self):
        p = self.physics
        self.assertEqual(p.mu_life_ns, 2196.9811)
        self.assertEqual(p.huff_factor(14, 28), 0.9924)
        self.assertEqual(p.huff_factor(14), 0.9924)        # element average
        self.assertEqual(p.huff_factor(14, 99), 0.9924)    # unknown isotope -> average
        self.assertEqual(p.huff_factor(3, 6), 1.0)         # no entry -> 1
        self.assertEqual(p.huff_factor(26, 56), 0.9715)
        self.assertEqual(p.huff_factor(26, 58), 0.9716)    # isotope dependent

    def test_hand_calculation(self):
        # 28Si, tau = 756.0(10) ns, Q = 0.9924, tau_mu+ = 2196.9811 ns
        c = self.physics.convert(14, 28, "lifetime", 756.0, 1.0, "ns")
        free = 0.9924 / 2.1969811
        rate = 1 / 0.756 - free
        self.assertAlmostEqual(c["capture_rate_us-1"], rate, places=12)
        self.assertAlmostEqual(c["capture_rate_us-1_unc"], 0.001 / 0.756 ** 2, places=12)
        self.assertAlmostEqual(c["capture_probability_pct"], 100 * rate / (rate + free), places=10)
        self.assertAlmostEqual(c["capture_probability_pct_unc"],
                               100 * free / (rate + free) ** 2 * 0.001 / 0.756 ** 2, places=10)
        self.assertEqual(c["lifetime_ns"], 756.0)
        self.assertEqual(c["huff_factor"], 0.9924)
        self.assertAlmostEqual(c["capture_rate_us-1"], 0.871036, places=5)

    def test_round_trip(self):
        p = self.physics
        c1 = p.convert(82, 208, "lifetime", 75.4, 1.0, "ns")
        c2 = p.convert(82, 208, "capture_rate", c1["capture_rate_us-1"], c1["capture_rate_us-1_unc"], "us-1")
        c3 = p.convert(82, 208, "capture_probability", c1["capture_probability_pct"],
                       c1["capture_probability_pct_unc"], "%")
        for c in (c2, c3):
            for k in c1:
                self.assertAlmostEqual(c[k], c1[k], places=9, msg=k)

    def test_units(self):
        p = self.physics
        a = p.convert(26, 56, "capture_rate", 4.411, 0.026, "us-1")
        b = p.convert(26, 56, "capture_rate", 4411.0, 26.0, "ms-1")
        c = p.convert(26, 56, "capture_rate", 4.411e6, 2.6e4, "s-1")
        for k in a:
            self.assertAlmostEqual(a[k], b[k], places=9)
            self.assertAlmostEqual(a[k], c[k], places=9)
        self.assertAlmostEqual(p.convert(3, 6, "lifetime", 2.177, None, "us")["lifetime_ns"], 2177.0)

    def test_missing_uncertainty_and_impossible_values(self):
        p = self.physics
        c = p.convert(47, 0, "lifetime", 87.0, None, "ns")
        self.assertIsNone(c["lifetime_ns_unc"])
        self.assertIsNone(c["capture_rate_us-1_unc"])
        self.assertIsNone(p.convert(14, 28, "lifetime", 0.0, 1.0, "ns"))
        self.assertIsNone(p.convert(14, 28, "capture_probability", 100.0, 1.0, "%"))
        self.assertIsNone(p.convert(14, 28, "lifetime", 756.0, 1.0, "us-1"))

    def test_combined_uncertainty(self):
        self.assertEqual(combined_uncertainty([{"source": "total", "value": 5.0}]), 5.0)
        self.assertIsNone(combined_uncertainty([]))
        # statistical and systematic are added in quadrature
        self.assertAlmostEqual(combined_uncertainty([{"source": "statistical", "value": 0.8},
                                                     {"source": "systematic", "value": 0.7}]),
                               (0.8 ** 2 + 0.7 ** 2) ** 0.5)
        # a stated total wins over the components
        self.assertEqual(combined_uncertainty([{"source": "statistical", "value": 3.0},
                                               {"source": "total", "value": 4.0},
                                               {"source": "systematic", "value": 1.0}]), 4.0)

    def test_shared_vectors(self):
        tolerance = self.vectors["relative_tolerance"]
        self.assertTrue(self.vectors["cases"])
        for v in self.vectors["cases"]:
            got = self.physics.convert(v["z"], v["a"], v["observable"], v["value"], v["uncertainty"], v["unit"],
                                       v.get("q"))
            for k, expected in v["expected"].items():
                if expected is None or isinstance(expected, str):
                    self.assertEqual(got[k], expected, (v, k))
                else:
                    self.assertLessEqual(abs(got[k] / expected - 1.0), tolerance, (v, k))

    def test_refused(self):
        """Tables with a duplicate, a missing or unusable constant, and values that are not a
        Huff factor are refused (the same cases are refused in JavaScript)."""
        refused = self.vectors["refused"]
        for t in refused["tables"]:
            with self.assertRaises(ValueError, msg=t["name"]):
                Physics(t["huff"], t["constants"])
        for q in refused["huff_factors"]:
            with self.assertRaises(ValueError, msg=repr(q)):
                self.physics.convert(14, 28, "lifetime", 756.0, 1.0, "ns", q)


if __name__ == "__main__":
    unittest.main()
