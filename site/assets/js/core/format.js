// Formatting of values, uncertainties and nuclide names for display.

import { decimals } from './jsonfmt.js';

const SOURCE_LABELS = { total: '', statistical: 'stat', systematic: 'syst', other: 'other' };

/**
 * A value as given in the source, from the value block of a data entry
 * ({ value, unit, uncertainties: [{ source, value }] }).  Value and
 * uncertainties are shown with the same number of decimals, the largest one
 * written in the file:
 *   743.9 +- 5                      ->  "743.9 ± 5.0"
 *   751.4 +- 0.8 (stat) +- 0.7 (syst) -> "751.4 ± 0.8 (stat) ± 0.7 (syst)"
 */
export function formatQuantity(block) {
  const entries = (Array.isArray(block.uncertainties) ? block.uncertainties : [])
    .filter((u) => u && typeof u === 'object' && typeof u.value === 'number');
  let digits = decimals(block, 'value');
  for (const u of entries) digits = Math.max(digits, decimals(u, 'value'));
  digits = Math.min(20, digits);
  const value = block.value.toFixed(digits);
  const parts = entries.map((u) => ({
    source: u.source, text: u.value.toFixed(digits), label: SOURCE_LABELS[u.source] === undefined ? u.source : SOURCE_LABELS[u.source],
  }));
  const text = [value].concat(parts.map((p) => `± ${p.text}${p.label ? ` (${p.label})` : ''}`)).join(' ');
  return { value, parts, text };
}

/** Digits after the decimal point so that `x` shows `sig` significant digits. */
function digitsFor(x, sig) {
  if (!(Math.abs(x) > 0) || !Number.isFinite(x)) return 0;
  const exponent = Math.floor(Math.log10(Math.abs(x)));
  return Math.min(20, Math.max(0, sig - 1 - exponent));
}

/**
 * A derived (converted) value: rounded so that the uncertainty has two
 * significant digits; four significant digits when there is no uncertainty.
 */
export function formatDerived(value, uncertainty, sig = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { value: '', uncertainty: null, text: '' };
  }
  if (uncertainty === null || uncertainty === undefined || !(uncertainty > 0)) {
    const v = value.toFixed(digitsFor(value, 4));
    return { value: v, uncertainty: null, text: v };
  }
  let digits = digitsFor(uncertainty, sig);
  // rounding can add a digit (0.0996 -> 0.10): recompute once
  digits = digitsFor(Number(uncertainty.toFixed(digits)), sig);
  const v = value.toFixed(digits);
  const u = uncertainty.toFixed(digits);
  return { value: v, uncertainty: u, text: `${v} ± ${u}` };
}

/** Plain number for CSV export: six significant digits, no exponent noise. */
export function plainNumber(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '';
  return String(Number(x.toPrecision(6)));
}

/**
 * Mass number used for display and look-ups: a target of natural abundance
 * (mass 0) of an element with a single stable isotope is that isotope.
 */
export function effectiveMass(z, mass, monoisotopic) {
  if (mass > 0) return mass;
  return (monoisotopic && monoisotopic.get(z)) || 0;
}

/** '28Si', 'natSi' (plain text). */
export function nuclideText(element, z, mass, monoisotopic) {
  const a = effectiveMass(z, mass, monoisotopic);
  return a > 0 ? `${a}${element}` : `nat${element}`;
}

/** Same with the mass number as superscript (HTML). */
export function nuclideHtml(element, z, mass, monoisotopic) {
  const a = effectiveMass(z, mass, monoisotopic);
  return `<sup>${a > 0 ? a : 'nat'}</sup>${element}`;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** RFC 4180 CSV from an array of rows (arrays of cells). */
export function toCsv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}
