"""Conversion between lifetime, capture rate and capture probability.

    1 / tau_total = Lambda_cap + Q / tau_mu+
    P_cap         = Lambda_cap / (Lambda_cap + Q / tau_mu+)

``Q`` is the Huff factor (reduction of the decay rate of the bound muon) and
``tau_mu+`` the lifetime of the free positive muon.  Both come from
``data/master``.  Uncertainties are propagated to first order; the
uncertainty of Q and of tau_mu+ is neglected.

Internal units: lifetime in ns, capture rate in 1/us, probability as fraction.
The JavaScript twin is ``site/assets/js/core/convert.js``.
"""
from __future__ import annotations

from typing import Dict, Optional, Tuple

# factor that converts a value in the given unit into the internal unit
UNIT_FACTORS = {
    "lifetime": {"ns": 1.0, "us": 1.0e3},
    "capture_rate": {"us-1": 1.0, "ms-1": 1.0e-3, "s-1": 1.0e-6},
    "capture_probability": {"%": 1.0e-2},
}


def combined_uncertainty(uncertainties) -> Optional[float]:
    """One overall uncertainty from the list given in a data entry.

    The entry with source ``total`` if there is one, otherwise the sum in
    quadrature of the listed components (statistical, systematic, other);
    ``None`` when the source gives no uncertainty.
    """
    entries = [u for u in (uncertainties or []) if isinstance(u, dict)
               and isinstance(u.get("value"), (int, float)) and not isinstance(u.get("value"), bool)]
    for u in entries:
        if u.get("source") == "total":
            return float(u["value"])
    if not entries:
        return None
    return sum(float(u["value"]) ** 2 for u in entries) ** 0.5


def is_huff_factor(q) -> bool:
    """Whether q can be a Huff factor: a finite number with 0 < q <= 1 (as in the master table)."""
    return isinstance(q, (int, float)) and not isinstance(q, bool) and 0 < q <= 1


class Physics:
    """Huff factors and constants from the master tables.

    Tables with a key listed twice, or without a usable mu_plus_lifetime, are refused.
    """

    def __init__(self, huff: dict, constants: dict):
        self.by_nuclide: Dict[Tuple[int, int], float] = {}
        self.by_element: Dict[int, float] = {}
        for r in huff.get("by_nuclide", []):
            key = (int(r["z"]), int(r["a"]))
            if key in self.by_nuclide:
                raise ValueError("the Huff factor of Z=%d A=%d is listed twice" % key)
            if not is_huff_factor(r["q"]):
                raise ValueError("the Huff factor of Z=%d A=%d is not in (0, 1]" % key)
            self.by_nuclide[key] = float(r["q"])
        for r in huff.get("by_element", []):
            z = int(r["z"])
            if z in self.by_element:
                raise ValueError("the Huff factor of Z=%d is listed twice" % z)
            if not is_huff_factor(r["q"]):
                raise ValueError("the Huff factor of Z=%d is not in (0, 1]" % z)
            self.by_element[z] = float(r["q"])
        found = [c for c in constants.get("constants", []) if c.get("name") == "mu_plus_lifetime"]
        if not found:
            raise ValueError("constant mu_plus_lifetime is missing")
        if len(found) > 1:
            raise ValueError("constant mu_plus_lifetime is listed twice")
        if found[0].get("unit") != "ns":
            raise ValueError("constant mu_plus_lifetime must be given in ns, not %s" % found[0].get("unit"))
        value = found[0].get("value")
        if not (isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0):
            raise ValueError("constant mu_plus_lifetime must be positive")
        self.mu_life_ns = float(value)

    def huff_factor(self, z: int, a: Optional[int] = None) -> float:
        """Q for the nuclide, else the element average, else 1."""
        if a:
            q = self.by_nuclide.get((int(z), int(a)))
            if q is not None:
                return q
        return self.by_element.get(int(z), 1.0)

    def huff_source(self, z: int, a: Optional[int] = None) -> str:
        """Where the Huff factor came from: 'nuclide' (tabulated for the isotope), 'element'
        (element value: natural targets and isotopes not tabulated) or 'none' (Q = 1 assumed)."""
        if a and (int(z), int(a)) in self.by_nuclide:
            return "nuclide"
        return "element" if int(z) in self.by_element else "none"

    def decay_rate(self, z: int, a: Optional[int] = None, q: Optional[float] = None) -> float:
        """Bound-muon decay rate Q / tau_mu+ in 1/us."""
        return (self.huff_factor(z, a) if q is None else q) / (self.mu_life_ns / 1000.0)

    # -- elementary conversions (internal units) ---------------------------
    def life_to_rate(self, z, a, life, dlife=0.0, q=None):
        if life <= 0:
            return None
        tau = life / 1000.0
        return 1.0 / tau - self.decay_rate(z, a, q), (dlife / 1000.0) / tau ** 2

    def rate_to_life(self, z, a, rate, drate=0.0, q=None):
        total = rate + self.decay_rate(z, a, q)
        if total <= 0:
            return None
        return 1000.0 / total, 1000.0 * drate / total ** 2

    def rate_to_prob(self, z, a, rate, drate=0.0, q=None):
        free = self.decay_rate(z, a, q)
        total = rate + free
        if total <= 0:
            return None
        return rate / total, free / total ** 2 * drate

    def prob_to_rate(self, z, a, prob, dprob=0.0, q=None):
        free = self.decay_rate(z, a, q)
        denom = 1.0 - prob
        if denom <= 0:
            return None
        return free * prob / denom, free / denom ** 2 * dprob

    # -- all three representations of one data point -----------------------
    def convert(self, z: int, a: int, observable: str, value: float,
                uncertainty: Optional[float], unit: str, q: Optional[float] = None) -> Optional[dict]:
        """Return lifetime (ns), capture rate (1/us) and probability (%).

        ``None`` when the value cannot be converted.  Uncertainties are
        ``None`` when the source has none.  ``q`` overrides the Huff factor;
        a value that cannot be a Huff factor is refused, not replaced.
        """
        if q is not None and not is_huff_factor(q):
            raise ValueError("a Huff factor must be a number in (0, 1]")
        try:
            factor = UNIT_FACTORS[observable][unit]
        except KeyError:
            return None
        has_unc = uncertainty is not None
        v = float(value) * factor
        dv = float(uncertainty) * factor if has_unc else 0.0
        if observable == "lifetime":
            life = (v, dv)
            rate = self.life_to_rate(z, a, v, dv, q)
        elif observable == "capture_rate":
            rate = (v, dv)
            life = self.rate_to_life(z, a, v, dv, q)
        else:
            rate = self.prob_to_rate(z, a, v, dv, q)
            life = self.rate_to_life(z, a, rate[0], rate[1], q) if rate else None
        if rate is None or life is None:
            return None
        prob = (v, dv) if observable == "capture_probability" else self.rate_to_prob(z, a, rate[0], rate[1], q)
        if prob is None:
            return None

        def pair(p, scale=1.0):
            return p[0] * scale, (p[1] * scale if has_unc else None)

        out = {"huff_factor": self.huff_factor(z, a) if q is None else q,
               "huff_source": self.huff_source(z, a) if q is None else "given"}
        out["lifetime_ns"], out["lifetime_ns_unc"] = pair(life)
        out["capture_rate_us-1"], out["capture_rate_us-1_unc"] = pair(rate)
        out["capture_probability_pct"], out["capture_probability_pct_unc"] = pair(prob, 100.0)
        return out
