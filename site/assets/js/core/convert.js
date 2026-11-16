// Conversion between lifetime, capture rate and capture probability
// (twin of tools/mundlib/convert.py).
//
//   1 / tau_total = Lambda_cap + Q / tau_mu+
//   P_cap         = Lambda_cap / (Lambda_cap + Q / tau_mu+)
//
// Internal units: lifetime in ns, capture rate in 1/us, probability as fraction.

export const UNIT_FACTORS = {
  lifetime: { ns: 1.0, us: 1.0e3 },
  capture_rate: { 'us-1': 1.0, 'ms-1': 1.0e-3, 's-1': 1.0e-6 },
  capture_probability: { '%': 1.0e-2 },
};

export const OBSERVABLES = Object.keys(UNIT_FACTORS);

export const OBSERVABLE_LABELS = {
  lifetime: 'Lifetime',
  capture_rate: 'Capture rate',
  capture_probability: 'Capture probability',
};

export const UNIT_LABELS = {
  ns: 'ns', us: 'µs', 'us-1': 'µs⁻¹', 'ms-1': 'ms⁻¹', 's-1': 's⁻¹', '%': '%',
};

export const unitsOf = (observable) => Object.keys(UNIT_FACTORS[observable] || {});

/**
 * One overall uncertainty from the list given in a data entry: the entry with
 * source 'total' if there is one, otherwise the sum in quadrature of the
 * listed components; null when the source gives no uncertainty.
 */
export function combinedUncertainty(uncertainties) {
  const entries = (Array.isArray(uncertainties) ? uncertainties : [])
    .filter((u) => u && typeof u === 'object' && typeof u.value === 'number');
  const total = entries.find((u) => u.source === 'total');
  if (total) return total.value;
  if (!entries.length) return null;
  return Math.sqrt(entries.reduce((sum, u) => sum + u.value ** 2, 0));
}

export class Physics {
  /** @param huff     content of data/master/huff_factors.json
   *  @param constants content of data/master/constants.json */
  constructor(huff, constants) {
    this.byNuclide = new Map((huff.by_nuclide || []).map((r) => [`${r.z}-${r.a}`, r.q]));
    this.byElement = new Map((huff.by_element || []).map((r) => [r.z, r.q]));
    const c = (constants.constants || []).find((x) => x.name === 'mu_plus_lifetime');
    if (!c) throw new Error('constant mu_plus_lifetime is missing');
    this.muLifeNs = c.value;
  }

  /** Q for the nuclide, else the element average, else 1. */
  huffFactor(z, a) {
    if (a) {
      const q = this.byNuclide.get(`${z}-${a}`);
      if (q !== undefined) return q;
    }
    const avg = this.byElement.get(Number(z));
    return avg === undefined ? 1.0 : avg;
  }

  /** Where the Huff factor came from: 'nuclide', 'element' or 'none'. */
  huffSource(z, a) {
    if (a && this.byNuclide.has(`${z}-${a}`)) return 'nuclide';
    return this.byElement.has(Number(z)) ? 'element' : 'none';
  }

  /** Bound-muon decay rate Q / tau_mu+ in 1/us. */
  decayRate(z, a, q) {
    return (q === undefined ? this.huffFactor(z, a) : q) / (this.muLifeNs / 1000.0);
  }

  /**
   * Lifetime (ns), capture rate (1/us) and capture probability (%) of one
   * data point; null when it cannot be converted.  Uncertainties are null
   * when the source has none.  `q` overrides the Huff factor.
   */
  convert(z, a, observable, value, uncertainty, unit, q) {
    const factor = (UNIT_FACTORS[observable] || {})[unit];
    if (factor === undefined || typeof value !== 'number' || !Number.isFinite(value)) return null;
    const hasUnc = uncertainty !== null && uncertainty !== undefined;
    const v = value * factor;
    const dv = hasUnc ? uncertainty * factor : 0.0;
    const free = this.decayRate(z, a, q);

    const lifeToRate = (life, dlife) => {
      if (life <= 0) return null;
      const tau = life / 1000.0;
      return [1.0 / tau - free, dlife / 1000.0 / tau ** 2];
    };
    const rateToLife = (rate, drate) => {
      const total = rate + free;
      return total <= 0 ? null : [1000.0 / total, (1000.0 * drate) / total ** 2];
    };
    const rateToProb = (rate, drate) => {
      const total = rate + free;
      return total <= 0 ? null : [rate / total, (free / total ** 2) * drate];
    };
    const probToRate = (prob, dprob) => {
      const denom = 1.0 - prob;
      return denom <= 0 ? null : [(free * prob) / denom, (free / denom ** 2) * dprob];
    };

    let life;
    let rate;
    if (observable === 'lifetime') {
      life = [v, dv];
      rate = lifeToRate(v, dv);
    } else if (observable === 'capture_rate') {
      rate = [v, dv];
      life = rateToLife(v, dv);
    } else {
      rate = probToRate(v, dv);
      life = rate ? rateToLife(rate[0], rate[1]) : null;
    }
    if (!rate || !life) return null;
    const prob = observable === 'capture_probability' ? [v, dv] : rateToProb(rate[0], rate[1]);
    if (!prob) return null;
    const unc = (x) => (hasUnc ? x : null);
    return {
      huff_factor: q === undefined ? this.huffFactor(z, a) : q,
      lifetime_ns: life[0],
      lifetime_ns_unc: unc(life[1]),
      'capture_rate_us-1': rate[0],
      'capture_rate_us-1_unc': unc(rate[1]),
      capture_probability_pct: prob[0] * 100.0,
      capture_probability_pct_unc: unc(prob[1] * 100.0),
    };
  }
}
