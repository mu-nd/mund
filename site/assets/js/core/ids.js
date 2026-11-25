// MetaID and DataID as defined in docs/id-definition.md
// (twin of tools/mundlib/ids.py; shared cases: tests/vectors/ids.json).

import { sha256 } from './sha256.js';

const ID_LENGTH = 12;
const SEPARATOR = '|';

const hash12 = (source) => sha256(source).slice(0, ID_LENGTH);

/** A bibId ('DOI:', 'NSR:' or 'muND:' and a name): trimmed, upper-cased. */
export function normalizeBibId(bibId) {
  return String(bibId).trim().toUpperCase();
}

/** Trimmed, with ASCII letters upper-cased; '' when there is no key. */
function normalizeKey(key) {
  return key === null || key === undefined ? '' : String(key).trim().replace(/[a-z]/g, (c) => c.toUpperCase());
}

/** Standard element symbol: one upper-case letter + optional lower-case. */
export function normalizeElement(element) {
  const s = String(element).trim();
  return s.slice(0, 1).toUpperCase() + s.slice(1).toLowerCase();
}

/** Decimal string of mass x 1000 (0 = natural abundance -> '0'), computed exactly on the decimal text
 *  and rounded half away from zero, as Python's ROUND_HALF_UP. */
export function normalizeMass(mass) {
  const m = /^([+-]?)(?=\.?\d)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(mass).trim());
  if (!m) throw new Error(`mass is not a number: ${mass}`);
  const digits = m[2] + (m[3] || '');
  const point = m[2].length + Number(m[4] || 0) + 3;     // digits before the decimal point of mass x 1000
  const padded = digits.padEnd(point, '0');
  const next = padded[point] || '0';                     // first digit rounded away
  const milli = BigInt(padded.slice(0, Math.max(point, 0)) || '0') + (next >= '5' ? 1n : 0n);
  return (m[1] === '-' && milli !== 0n ? '-' : '') + milli;
}

export function metaSource(sublibrary, code, bibId, key) {
  const parts = [sublibrary, `${code}-META`, normalizeBibId(bibId)];
  const k = normalizeKey(key);
  if (k) parts.push(k);
  return parts.join(SEPARATOR);
}

export function dataSource(sublibrary, code, element, mass, metaId, key) {
  const parts = [sublibrary, code, normalizeElement(element), normalizeMass(mass), metaId];
  const k = normalizeKey(key);
  if (k) parts.push(k);
  return parts.join(SEPARATOR);
}

export function metaId(sublibrary, code, bibId, key) {
  return hash12(metaSource(sublibrary, code, bibId, key));
}

export function dataId(sublibrary, code, element, mass, metaIdValue, key) {
  return hash12(dataSource(sublibrary, code, element, mass, metaIdValue, key));
}
