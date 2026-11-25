import json
import unittest

from helpers import FIXTURE, ROOT, vectors
from mundlib.convert import UNIT_FACTORS, Physics, combined_uncertainty


def master(name):
    return json.loads((FIXTURE / "data" / "master" / name).read_text(encoding="utf-8"))


class ConvertTests(unittest.TestCase):
    """With the master tables of the test database."""

    @classmethod
    def setUpClass(cls):
        cls.physics = Physics(master("huff_factors.json"), master("constants.json"))

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
        # the units of each kind are those the schema allows
        schema = json.loads((ROOT / "schema" / "v1" / "lt.schema.json").read_text(encoding="utf-8"))
        allowed = {}
        for rule in schema["$defs"]["observable"]["allOf"]:
            kind = rule["if"]["properties"]["kind"]["const"]
            allowed[kind] = set(rule["then"]["properties"][kind]["properties"]["unit"]["enum"])
        self.assertEqual({kind: set(units) for kind, units in UNIT_FACTORS.items()}, allowed)

    def test_shared_vectors(self):
        """The same conversion vectors run in JavaScript."""
        p, v = self.physics, vectors("convert.json")
        NON_FINITE = [float("nan"), float("inf"), float("-inf")]     # values JSON cannot hold
        self.assertEqual(p.mu_life_ns, 2196.9811)
        for x in v["cases"]:
            got = p.convert(x["z"], x["a"], x["observable"], x["value"], x["uncertainty"], x["unit"], x.get("q"))
            for key, expected in x["expected"].items():
                if isinstance(expected, (int, float)):
                    self.assertAlmostEqual(got[key], expected, delta=abs(expected) * v["relative_tolerance"], msg=key)
                else:
                    self.assertEqual(got[key], expected, key)
        for x in v["lookups"]:
            c = p.convert(x["z"], x["a"], "lifetime", 756.0, None, "ns")
            self.assertEqual((c["huff_factor"], c["huff_source"]), (x["huff_factor"], x["huff_source"]), x)
        for x in v["impossible"]:
            self.assertIsNone(p.convert(x["z"], x["a"], x["observable"], x["value"], x["uncertainty"], x["unit"]), x)
        for x in NON_FINITE:
            self.assertIsNone(p.convert(14, 28, "lifetime", x, None, "ns"), x)
            self.assertIsNone(p.convert(14, 28, "lifetime", 756.0, x, "ns"), x)
        for x in v["combined"]:
            got = combined_uncertainty(x["uncertainties"])
            if x["value"] is None:
                self.assertIsNone(got, x)
            else:
                self.assertAlmostEqual(got, x["value"], delta=v["relative_tolerance"] * x["value"], msg=x)
        for t in v["refused"]["tables"]:
            with self.assertRaises(ValueError, msg=t["name"]):
                Physics(t["huff"], t["constants"])
        for q in v["refused"]["huff_factors"] + NON_FINITE:
            with self.assertRaises(ValueError, msg=repr(q)):
                p.convert(14, 28, "lifetime", 756.0, 1.0, "ns", q)


if __name__ == "__main__":
    unittest.main()
