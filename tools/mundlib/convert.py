"""Conversion between lifetime, capture rate and capture probability.

    1 / tau_total = Lambda_cap + Q / tau_mu+
    P_cap         = Lambda_cap / (Lambda_cap + Q / tau_mu+)

``Q`` is the Huff factor (reduction of the decay rate of the bound muon) and
``tau_mu+`` the lifetime of the free positive muon.  Both come from
``data/master``.  Uncertainties are propagated to first order; the
uncertainty of Q and of tau_mu+ is neglected (as in the previous explorer).

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

OBSERVABLE_UNITS = {k: tuple(v) for k, v in UNIT_FACTORS.items()}


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


class Physics:
    """Huff factors and constants loaded from ``data/master``."""

    def __init__(self, huff: dict, constants: dict):
        self.by_nuclide: Dict[Tuple[int, int], float] = {
            (int(r["z"]), int(r["a"])): float(r["q"]) for r in huff.get("by_nuclide", [])}
        self.by_element: Dict[int, float] = {
            int(r["z"]): float(r["q"]) for r in huff.get("by_element", [])}
        self.mu_life_ns = None
        for c in constants.get("constants", []):
            if c.get("name") == "mu_plus_lifetime":
                self.mu_life_ns = float(c["value"])
        if not self.mu_life_ns:
            raise ValueError("constant mu_plus_lifetime is missing")

    def huff_factor(self, z: int, a: Optional[int] = None) -> float:
        """Q for the nuclide, else the element average, else 1."""
        if a:
            q = self.by_nuclide.get((int(z), int(a)))
            if q is not None:
                return q
        return self.by_element.get(int(z), 1.0)

    def decay_rate(self, z: int, a: Optional[int] = None) -> float:
        """Bound-muon decay rate Q / tau_mu+ in 1/us."""
        return self.huff_factor(z, a) / (self.mu_life_ns / 1000.0)

    # -- elementary conversions (internal units) ---------------------------
    def life_to_rate(self, z, a, life, dlife=0.0):
        if life <= 0:
            return None
        tau = life / 1000.0
        return 1.0 / tau - self.decay_rate(z, a), (dlife / 1000.0) / tau ** 2

    def rate_to_life(self, z, a, rate, drate=0.0):
        total = rate + self.decay_rate(z, a)
        if total <= 0:
            return None
        return 1000.0 / total, 1000.0 * drate / total ** 2

    def rate_to_prob(self, z, a, rate, drate=0.0):
        free = self.decay_rate(z, a)
        total = rate + free
        if total <= 0:
            return None
        return rate / total, free / total ** 2 * drate

    def prob_to_rate(self, z, a, prob, dprob=0.0):
        free = self.decay_rate(z, a)
        denom = 1.0 - prob
        if denom <= 0:
            return None
        return free * prob / denom, free / denom ** 2 * dprob

    # -- all three representations of one data point -----------------------
    def convert(self, z: int, a: int, observable: str, value: float,
                uncertainty: Optional[float], unit: str) -> Optional[dict]:
        """Return lifetime (ns), capture rate (1/us) and probability (%).

        ``None`` when the value cannot be converted.  Uncertainties are
        ``None`` when the source has none.
        """
        try:
            factor = UNIT_FACTORS[observable][unit]
        except KeyError:
            return None
        has_unc = uncertainty is not None
        v = float(value) * factor
        dv = float(uncertainty) * factor if has_unc else 0.0
        if observable == "lifetime":
            life = (v, dv)
            rate = self.life_to_rate(z, a, v, dv)
        elif observable == "capture_rate":
            rate = (v, dv)
            life = self.rate_to_life(z, a, v, dv)
        else:
            rate = self.prob_to_rate(z, a, v, dv)
            life = self.rate_to_life(z, a, *rate) if rate else None
        if rate is None or life is None:
            return None
        prob = (v, dv) if observable == "capture_probability" else self.rate_to_prob(z, a, *rate)
        if prob is None:
            return None

        def pair(p, scale=1.0):
            return p[0] * scale, (p[1] * scale if has_unc else None)

        out = {"huff_factor": self.huff_factor(z, a)}
        out["lifetime_ns"], out["lifetime_ns_unc"] = pair(life)
        out["capture_rate_us-1"], out["capture_rate_us-1_unc"] = pair(rate)
        out["capture_probability_pct"], out["capture_probability_pct_unc"] = pair(prob, 100.0)
        return out
