"""Conversion between lifetime, capture rate and capture probability
(twin of ``site/assets/js/core/convert.js``; shared cases: ``tests/vectors/convert.json``).

    1 / tau_total = Lambda_cap + Q / tau_mu+
    Bcap          = Lambda_cap / (Lambda_cap + Q / tau_mu+)

``Q`` is the Huff factor (reduction of the decay rate of the bound muon) and
``tau_mu+`` the lifetime of the free positive muon.  Both come from
``data/master``.  Uncertainties are propagated to first order; the
uncertainty of Q and of tau_mu+ is neglected.

Internal units: lifetime in ns, capture rate in 1/us, probability in %.
"""
from __future__ import annotations

import math
from typing import Dict, Optional, Tuple

from .jsonfmt import as_dict, is_number, objects

# factor that converts a value in the given unit into the internal unit
UNIT_FACTORS = {
    "lifetime": {"ns": 1.0, "us": 1.0e3},
    "capture_rate": {"us-1": 1.0, "ms-1": 1.0e-3, "s-1": 1.0e-6},
    "capture_probability": {"%": 1.0},
}


def combined_uncertainty(uncertainties) -> Optional[float]:
    """One overall uncertainty from the list given in a data entry.

    The entry with source ``total`` if there is one, otherwise the sum in
    quadrature of the listed components (statistical, systematic, other);
    ``None`` when absent or outside the finite numeric range.
    """
    entries = [u for u in objects(uncertainties) if is_number(u.get("value"))]
    for u in entries:
        if u.get("source") == "total":
            return float(u["value"])
    if not entries:
        return None
    total = math.hypot(*(u["value"] for u in entries))
    return total if math.isfinite(total) else None


def _is_finite(x) -> bool:
    return is_number(x) and math.isfinite(x)


def is_huff_factor(q) -> bool:
    """Whether q can be a Huff factor: a finite number with 0 < q <= 1 (as in the master table)."""
    return _is_finite(q) and 0 < q <= 1


class Physics:
    """Huff factors and constants from the master tables.

    Huff factors listed twice or outside (0, 1], and a mu_plus_lifetime that is not
    positive, are refused.
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
        value = as_dict(constants.get("mu_plus_lifetime")).get("value")
        if not (is_number(value) and value > 0):
            raise ValueError("mu_plus_lifetime must be a positive number of ns")
        self.mu_life_ns = float(value)

    def huff(self, z: int, a: Optional[int]) -> Tuple[float, str]:
        """(Q, source): the value tabulated for the nuclide ('nuclide'), else the element value
        ('element': natural targets and isotopes not tabulated), else 1 ('none')."""
        if a and (int(z), int(a)) in self.by_nuclide:
            return self.by_nuclide[(int(z), int(a))], "nuclide"
        if int(z) in self.by_element:
            return self.by_element[int(z)], "element"
        return 1.0, "none"

    def convert(self, z: int, a: int, observable: str, value: float,
                uncertainty: Optional[float], unit: str, q: Optional[float] = None) -> Optional[dict]:
        """Lifetime (ns), capture rate (1/us) and capture probability (%) of one
        data entry; ``None`` when it cannot be converted (unknown unit, value not a
        finite number, uncertainty negative or not a finite number).  Uncertainties
        are ``None`` when the source has none.  ``q`` overrides the Huff factor; a
        value that cannot be a Huff factor (see is_huff_factor) is refused, not replaced.
        """
        if q is not None and not is_huff_factor(q):
            raise ValueError("a Huff factor must be a number in (0, 1]")
        factor = UNIT_FACTORS.get(observable, {}).get(unit)
        has_unc = uncertainty is not None
        if factor is None or not _is_finite(value) or (has_unc and not (_is_finite(uncertainty) and uncertainty >= 0)):
            return None
        huff, source = self.huff(z, a) if q is None else (q, "given")
        v = value * factor
        dv = uncertainty * factor if has_unc else 0.0
        free = (1000.0 * huff) / self.mu_life_ns
        if not (math.isfinite(v) and math.isfinite(free) and free > 0) or (v == 0 and value != 0):
            return None

        dlife = drate = dprob = None
        if observable == "lifetime":
            if v <= 0:
                return None
            life = v
            total = 1000.0 / life
            rate = total - free
            prob = 100.0 * (rate / total)
            if has_unc:
                dlife, drate, dprob = dv, (dv / life) * total, (free / 10.0) * dv
        elif observable == "capture_rate":
            rate = v
            total = rate + free
            if total <= 0 or not math.isfinite(total):
                return None
            life = 1000.0 / total
            prob = 100.0 * (rate / total)
            if has_unc:
                relative = dv / total
                dlife, drate, dprob = life * relative, dv, (100.0 * (free / total)) * relative
        else:
            prob = v
            remaining = 100.0 - prob
            if prob < 0 or remaining <= 0:
                return None
            rate = free * (prob / remaining)
            life = 10.0 * remaining / free
            if has_unc:
                dlife = (dv / free) * 10.0
                drate = (free / remaining) * (100.0 / remaining) * dv
                dprob = dv

        if not all(math.isfinite(x) for x in (life, rate, prob)):
            return None
        if has_unc and not all(math.isfinite(x) and (x > 0 or uncertainty == 0) for x in (dlife, drate, dprob)):
            return None

        return {
            "huff_factor": huff,
            "huff_source": source,
            "lifetime_ns": life,
            "lifetime_ns_unc": dlife,
            "capture_rate_us-1": rate,
            "capture_rate_us-1_unc": drate,
            "capture_probability_pct": prob,
            "capture_probability_pct_unc": dprob,
        }
