// Formatting of values and uncertainties for display.

import { compact, decimals, numberText } from './jsonfmt.js';
import { OBSERVABLES, UNIT_LABELS } from './convert.js';

const SOURCE_LABELS = { total: '', statistical: 'stat', systematic: 'syst', other: 'other' };

/**
 * The value and each uncertainty with the digits given in the source. With a
 * `scale` (a power of ten: the source unit differs from the unit shown) each
 * number is multiplied by it and keeps the place of its last written digit.
 */
export function formatQuantity(block, scale = 1) {
  const entries = (Array.isArray(block.uncertainties) ? block.uncertainties : [])
    .filter((u) => u && typeof u === 'object' && typeof u.value === 'number');
  const shift = Math.round(Math.log10(scale));
  const number = (holder) => (scale === 1 ? numberText(holder, 'value')
    : (holder.value * scale).toFixed(Math.min(20, Math.max(0, decimals(holder, 'value') - shift))));
  const value = number(block);
  const text = (u) => {
    const label = SOURCE_LABELS[u.source] ?? u.source;
    return `${number(u)}${label ? ` (${label})` : ''}`;
  };
  const total = entries.find((u) => u.source === 'total');
  if (total && entries.length > 1) {
    const parts = entries.filter((u) => u !== total).map(text);
    return `${value} ± ${text(total)} (total) [${parts.join(', ')}]`;
  }
  return [value, ...entries.map((u) => `± ${text(u)}`)].join(' ');
}

/**
 * A value block as text with its unit: '1065.5 ± 2.0 ns'. A value that is not
 * a number, or a unit without a label, is shown as written.
 */
export function quantityText(block) {
  const value = typeof block.value === 'number' ? formatQuantity(block) : String(block.value);
  return `${value} ${UNIT_LABELS[block.unit] || block.unit || ''}`.trim();
}

/**
 * Round to the place 10^place. Plain digits, except for a magnitude of 1e21 or
 * more or a place below 1e-20: there scientific notation retains significant zeros.
 */
function atPlace(value, place) {
  const plain = Math.abs(value) < 1e21 && place >= -20;
  if (plain && place <= 0) return value.toFixed(-place);
  if (value === 0) return '0';
  const [coefficient, exponent] = value.toExponential().split('e');
  const decimals = Number(exponent) - place;
  if (decimals < 0) {
    if (decimals < -1 || Math.abs(Number(coefficient)) < 5) return '0';
    const sign = value < 0 ? '-' : '';
    return plain ? `${sign}1${'0'.repeat(place)}` : `${sign}1e${place >= 0 ? '+' : ''}${place}`;
  }
  // A wide separation between value and uncertainty can exceed toExponential's precision limit.
  if (decimals > 100) return value.toExponential();
  const [digits, roundedExponent] = value.toExponential(decimals).split('e');
  if (plain) return digits.replace('.', '') + '0'.repeat(Number(roundedExponent) - decimals);
  const carry = Number(roundedExponent) > Number(exponent);
  return `${digits}${carry ? (decimals ? '0' : '.0') : ''}e${roundedExponent}`;
}

/** Place of the last significant digit after rounding, including a carry to the next power of ten. */
const lastPlace = (value, digits) => Number(value.toExponential(digits - 1).split('e')[1]) - digits + 1;

/** An uncertainty, to two significant digits. */
export const formatUncertainty = (u) => (u === 0 ? '0' : atPlace(u, lastPlace(u, 2)));

/** A derived value rounded to the uncertainty's place, or to four significant digits without a positive uncertainty. */
export function formatDerived(value, u) {
  if (!Number.isFinite(value)) return '';
  if (!(u > 0)) {
    const text = value === 0 ? '0' : atPlace(value, lastPlace(value, 4));
    return u === 0 ? `${text} ± 0` : text;
  }
  return `${atPlace(value, lastPlace(u, 2))} ± ${formatUncertainty(u)}`;
}

/** A Huff factor, with the four decimals of the master table. */
export const formatHuffFactor = (q) => q.toFixed(4);

/** One record of an entry's `corrections` as one line of text; the corrected field as its members joined by › . */
export function formatCorrection(c) {
  const field = (key) => typeof c[key] === 'number' ? numberText(c, key) : compact(c[key]);
  return `${c.date}: ${c.pointer.replace(/^\//, '').replace(/\//g, ' › ')} ${field('before')} → ${field('after')}. ${c.reason}`
    + (c.formerId ? ` Former DataID ${c.formerId}.` : '')
    + (c.checkedAgainstSource ? '' : ' Not yet checked against the publication.');
}

/** The observable `kind` of a result of Physics.convert() ('' when there is none). */
export function formatConverted(conv, kind) {
  const { key } = OBSERVABLES[kind];
  return conv ? formatDerived(conv[key], conv[`${key}_unc`]) : '';
}
