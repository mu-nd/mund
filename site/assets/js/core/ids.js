// Deterministic identifiers (MetaID / DataID) - see docs/id-definition.md.
// JavaScript twin of tools/mundlib/ids.py; both are checked against
// tests/vectors/ids.json.
//
//   meta_source = "LT|{DataSet}-META|{doi_norm}[|{key_norm}]"
//   data_source = "LT|{DataSet}|{element_norm}|{mass_norm}|{MetaID}[|{key_norm}]"
//   ID          = first 12 hex digits of SHA-256(UTF-8(source))

import { sha256 } from './sha256.js';

export const ID_LENGTH = 12;
const SEPARATOR = '|';

const hash12 = (source) => sha256(source).slice(0, ID_LENGTH);

/** First entry of a ';' separated list, trimmed, upper-cased. */
export function normalizeDoi(doi) {
  return String(doi).split(';')[0].trim().toUpperCase();
}

/** Trimmed and upper-cased; '' when there is no key. */
export function normalizeKey(key) {
  return key === null || key === undefined ? '' : String(key).trim().toUpperCase();
}

/** Standard element symbol: one upper-case letter + optional lower-case. */
export function normalizeElement(element) {
  const s = String(element).trim();
  return s.slice(0, 1).toUpperCase() + s.slice(1).toLowerCase();
}

/** Decimal string of mass x 1000, computed on the decimal text (no rounding noise). */
export function normalizeMass(mass) {
  const text = String(mass).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) {
    const n = Number(text);
    if (!Number.isFinite(n) || text === '') throw new Error(`mass is not a number: ${mass}`);
    return String(Math.round(n * 1000));
  }
  const frac = (m[3] || '').padEnd(4, '0');
  let milli = BigInt(m[2] + frac.slice(0, 3));
  if (frac.length > 3 && frac[3] >= '5') milli += 1n;   // round half up, as in Python
  const sign = m[1] && milli !== 0n ? '-' : '';
  return sign + milli.toString();
}

export function metaSource(sublibrary, dataset, doi, key) {
  const parts = [sublibrary, `${dataset}-META`, normalizeDoi(doi)];
  const k = normalizeKey(key);
  if (k) parts.push(k);
  return parts.join(SEPARATOR);
}

export function dataSource(sublibrary, dataset, element, mass, metaId, key) {
  const parts = [sublibrary, dataset, normalizeElement(element), normalizeMass(mass), metaId];
  const k = normalizeKey(key);
  if (k) parts.push(k);
  return parts.join(SEPARATOR);
}

export function metaId(sublibrary, dataset, doi, key) {
  return hash12(metaSource(sublibrary, dataset, doi, key));
}

export function dataId(sublibrary, dataset, element, mass, metaIdValue, key) {
  return hash12(dataSource(sublibrary, dataset, element, mass, metaIdValue, key));
}
