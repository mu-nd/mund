// Conversion between lifetime, capture rate and capture probability
// (twin of tools/mundlib/convert.py; shared cases: tests/vectors/convert.json).
//
//   1 / tau_total = Lambda_cap + Q / tau_mu+
//   Bcap          = Lambda_cap / (Lambda_cap + Q / tau_mu+)
//
// Q is the Huff factor (reduction of the decay rate of the bound muon) and
// tau_mu+ the lifetime of the free positive muon.  Both come from
// data/master.  Uncertainties are propagated to first order; the
// uncertainty of Q and of tau_mu+ is neglected.
//
// Internal units: lifetime in ns, capture rate in 1/us, probability in %.

import { objects } from './jsonfmt.js';

export const UNIT_FACTORS = {
  lifetime: { ns: 1.0, us: 1.0e3 },
  capture_rate: { 'us-1': 1.0, 'ms-1': 1.0e-3, 's-1': 1.0e-6 },
  capture_probability: { '%': 1.0 },
};

/**
 * The observables (the kinds of value a data entry gives): label, the unit
 * they are converted to, and the member of the result of Physics.convert()
 * that holds them (`<key>_unc` holds the uncertainty).
 */
export const OBSERVABLES = {
  lifetime: { label: 'Lifetime', unit: 'ns', key: 'lifetime_ns' },
  capture_rate: { label: 'Capture rate', unit: 'us-1', key: 'capture_rate_us-1' },
  capture_probability: { label: 'Capture probability', unit: '%', key: 'capture_probability_pct' },
};

export const KINDS = Object.keys(OBSERVABLES);

export const UNIT_LABELS = {
  ns: 'ns', us: 'µs', 'us-1': 'µs⁻¹', 'ms-1': 'ms⁻¹', 's-1': 's⁻¹', '%': '%',
};

export const unitsOf = (kind) => Object.keys(UNIT_FACTORS[kind] || {});

/** The label of the unit that the observable `kind` is converted to. */
export const unitLabel = (kind) => UNIT_LABELS[OBSERVABLES[kind].unit];

/**
 * One overall uncertainty from the list given in a data entry: the entry with
 * source 'total' if there is one, otherwise the sum in quadrature of the
 * listed components; null when absent or outside the finite numeric range.
 */
export function combinedUncertainty(uncertainties) {
  const entries = objects(uncertainties).filter((u) => typeof u.value === 'number');
  const total = entries.find((u) => u.source === 'total');
  if (total) return total.value;
  if (!entries.length) return null;
  const scale = entries.reduce((max, u) => Math.max(max, Math.abs(u.value)), 0);
  if (!scale) return 0;
  const norm = scale * Math.sqrt(entries.reduce((sum, u) => sum + (u.value / scale) ** 2, 0));
  return Number.isFinite(norm) ? norm : null;
}

/** What the `huff_source` of a result of Physics.convert() means. */
export const HUFF_SOURCE_TEXT = {
  nuclide: 'value for this nuclide',
  element: 'element value (natural abundance)',
  none: 'not tabulated: Q = 1 assumed',
  given: 'given',
};

/** Whether q can be a Huff factor: a finite number with 0 < q <= 1 (as in the master table). */
export const isHuffFactor = (q) => Number.isFinite(q) && q > 0 && q <= 1;

export class Physics {
  /** @param huff     content of data/master/huff_factors.json
   *  @param constants content of data/master/constants.json
   *  Huff factors listed twice or outside (0, 1], and a mu_plus_lifetime that is not
   *  positive, are refused. */
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
    const value = (constants.mu_plus_lifetime || {}).value;
    if (!(typeof value === 'number' && value > 0)) throw new Error('mu_plus_lifetime must be a positive number of ns');
    this.muLifeNs = value;
  }

  /**
   * [Q, source]: the value tabulated for the nuclide ('nuclide'), else the element value
   * ('element': natural targets and isotopes not tabulated), else 1 ('none').
   */
  huff(z, a) {
    if (a && this.byNuclide.has(`${z}-${a}`)) return [this.byNuclide.get(`${z}-${a}`), 'nuclide'];
    if (this.byElement.has(Number(z))) return [this.byElement.get(Number(z)), 'element'];
    return [1.0, 'none'];
  }

  /**
   * Lifetime (ns), capture rate (1/us) and capture probability (%) of one
   * data entry; null when it cannot be converted (unknown unit, value not a
   * finite number, uncertainty negative or not a finite number).  Uncertainties
   * are null when the source has none.  `q` overrides the Huff factor; a
   * value that cannot be a Huff factor (see isHuffFactor) is refused, not replaced.
   */
  convert(z, a, observable, value, uncertainty, unit, q) {
    if (q !== undefined && !isHuffFactor(q)) throw new RangeError('a Huff factor must be a number in (0, 1]');
    const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
    const factor = own(UNIT_FACTORS, observable) && own(UNIT_FACTORS[observable], unit);
    const hasUnc = uncertainty !== null && uncertainty !== undefined;
    if (factor === undefined || !Number.isFinite(value) || (hasUnc && !(Number.isFinite(uncertainty) && uncertainty >= 0))) return null;
    const [huff, source] = q === undefined ? this.huff(z, a) : [q, 'given'];
    const v = value * factor;
    const dv = hasUnc ? uncertainty * factor : 0.0;
    const free = (1000.0 * huff) / this.muLifeNs;
    if (!Number.isFinite(v) || !Number.isFinite(free) || free <= 0 || (v === 0 && value !== 0)) return null;

    let life, rate, prob;
    let dlife = null, drate = null, dprob = null;
    if (observable === 'lifetime') {
      if (v <= 0) return null;
      life = v;
      const total = 1000.0 / life;
      rate = total - free;
      prob = 100.0 * (rate / total);
      if (hasUnc) {
        dlife = dv;
        drate = (dv / life) * total;
        dprob = (free / 10.0) * dv;
      }
    } else if (observable === 'capture_rate') {
      rate = v;
      const total = rate + free;
      if (total <= 0 || !Number.isFinite(total)) return null;
      life = 1000.0 / total;
      prob = 100.0 * (rate / total);
      if (hasUnc) {
        const relative = dv / total;
        dlife = life * relative;
        drate = dv;
        dprob = (100.0 * (free / total)) * relative;
      }
    } else {
      prob = v;
      const remaining = 100.0 - prob;
      if (prob < 0 || remaining <= 0) return null;
      rate = free * (prob / remaining);
      life = 10.0 * remaining / free;
      if (hasUnc) {
        dlife = (dv / free) * 10.0;
        drate = (free / remaining) * (100.0 / remaining) * dv;
        dprob = dv;
      }
    }
    if (![life, rate, prob].every(Number.isFinite)) return null;
    if (hasUnc && ![dlife, drate, dprob].every((x) => Number.isFinite(x) && (x > 0 || uncertainty === 0))) return null;

    return {
      huff_factor: huff,
      huff_source: source,
      lifetime_ns: life,
      lifetime_ns_unc: dlife,
      'capture_rate_us-1': rate,
      'capture_rate_us-1_unc': drate,
      capture_probability_pct: prob,
      capture_probability_pct_unc: dprob,
    };
  }
}
