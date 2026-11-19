// Conversion between lifetime, capture rate and capture probability
// (twin of tools/mundlib/convert.py).
//
//   1 / tau_total = Lambda_cap + Q / tau_mu+
//   P_cap         = Lambda_cap / (Lambda_cap + Q / tau_mu+)
//
// Internal units: lifetime in ns, capture rate in 1/us, probability as fraction.

const UNIT_FACTORS = {
  lifetime: { ns: 1.0, us: 1.0e3 },
  capture_rate: { 'us-1': 1.0, 'ms-1': 1.0e-3, 's-1': 1.0e-6 },
  capture_probability: { '%': 1.0e-2 },
};

/**
 * The three quantities: label, the unit they are converted to, and the member
 * of the result of Physics.convert() that holds them (`<key>_unc` holds the
 * uncertainty).
 */
export const QUANTITIES = {
  lifetime: { label: 'Lifetime', unit: 'ns', key: 'lifetime_ns' },
  capture_rate: { label: 'Capture rate', unit: 'us-1', key: 'capture_rate_us-1' },
  capture_probability: { label: 'Capture probability', unit: '%', key: 'capture_probability_pct' },
};

export const OBSERVABLES = Object.keys(QUANTITIES);

export const OBSERVABLE_LABELS = Object.fromEntries(OBSERVABLES.map((name) => [name, QUANTITIES[name].label]));

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

/** Whether q can be a Huff factor: a finite number with 0 < q <= 1 (as in the master table). */
export const isHuffFactor = (q) => typeof q === 'number' && Number.isFinite(q) && q > 0 && q <= 1;

export class Physics {
  /** @param huff     content of data/master/huff_factors.json
   *  @param constants content of data/master/constants.json
   *  Tables with a key listed twice, or without a usable mu_plus_lifetime, are refused. */
  constructor(huff, constants) {
    this.byNuclide = new Map();
    this.byElement = new Map();
    for (const r of huff.by_nuclide || []) {
      const key = `${r.z}-${r.a}`;
      if (this.byNuclide.has(key)) throw new Error(`the Huff factor of Z=${r.z} A=${r.a} is listed twice`);
      if (!isHuffFactor(r.q)) throw new Error(`the Huff factor of Z=${r.z} A=${r.a} is not in (0, 1]`);
      this.byNuclide.set(key, r.q);
    }
    for (const r of huff.by_element || []) {
      if (this.byElement.has(r.z)) throw new Error(`the Huff factor of Z=${r.z} is listed twice`);
      if (!isHuffFactor(r.q)) throw new Error(`the Huff factor of Z=${r.z} is not in (0, 1]`);
      this.byElement.set(r.z, r.q);
    }
    const found = (constants.constants || []).filter((x) => x && x.name === 'mu_plus_lifetime');
    if (!found.length) throw new Error('constant mu_plus_lifetime is missing');
    if (found.length > 1) throw new Error('constant mu_plus_lifetime is listed twice');
    if (found[0].unit !== 'ns') throw new Error(`constant mu_plus_lifetime must be given in ns, not ${found[0].unit}`);
    if (!(typeof found[0].value === 'number' && found[0].value > 0)) throw new Error('constant mu_plus_lifetime must be positive');
    this.muLifeNs = found[0].value;
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

  /**
   * Where the Huff factor came from: 'nuclide' (tabulated for the isotope), 'element'
   * (element value: natural targets and isotopes not tabulated) or 'none' (Q = 1 assumed).
   */
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
   * when the source has none.  `q` overrides the Huff factor; a value that
   * cannot be a Huff factor (see isHuffFactor) is refused, not replaced.
   */
  convert(z, a, observable, value, uncertainty, unit, q) {
    if (q !== undefined && !isHuffFactor(q)) throw new RangeError('a Huff factor must be a number in (0, 1]');
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
      huff_source: q === undefined ? this.huffSource(z, a) : 'given',
      lifetime_ns: life[0],
      lifetime_ns_unc: unc(life[1]),
      'capture_rate_us-1': rate[0],
      'capture_rate_us-1_unc': unc(rate[1]),
      capture_probability_pct: prob[0] * 100.0,
      capture_probability_pct_unc: unc(prob[1] * 100.0),
    };
  }
}
