// Reading rows pasted from a spreadsheet into the data grid.

import { normalizeElement } from '../core/ids.js';
import { isNumberLexeme } from '../core/jsonfmt.js';

/**
 * Columns: element, mass number, value, uncertainty, [key], [comment],
 * separated by tabs, commas or blanks.  The element may carry the mass
 * number (28Si, Si-28, natSi); the mass column is then left out.
 * Lines that cannot be understood (headers, unknown elements) are returned
 * in `skipped`.
 */
export function parsePastedRows(text, elements) {
  const symbols = new Set(elements);
  const rows = [];
  const skipped = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let cells = line.includes('\t') ? line.split('\t') : line.includes(',') ? line.split(',') : line.split(/\s+/);
    cells = cells.map((c) => c.trim());
    let element = null;
    let mass = null;
    const first = cells.shift() || '';
    let m = /^(\d+|nat)[-\s]?([A-Za-z]{1,2})$/.exec(first);                 // 28Si, natSi
    if (m) {
      element = m[2];
      mass = m[1] === 'nat' ? '0' : m[1];
    } else if ((m = /^([A-Za-z]{1,2})[-\s]?(\d+|nat)$/.exec(first))) {      // Si-28, Si28
      element = m[1];
      mass = m[2] === 'nat' ? '0' : m[2];
    } else if (/^[A-Za-z]{1,2}$/.test(first)) {                              // Si <tab> 28
      element = first;
      if (cells.length >= 2 && /^nat$/i.test(cells[0])) {
        cells.shift();
        mass = '0';
      } else if (cells.length >= 2 && /^\d+(\.0*)?$/.test(cells[0]) && Number(cells[0]) <= 300) {
        mass = cells.shift();
      }
    }
    element = element ? normalizeElement(element) : null;
    const [value, uncertainty, key, ...rest] = cells;
    const valueText = String(value === undefined ? '' : value).trim();
    if (!element || !symbols.has(element) || mass === null || !isNumberLexeme(valueText)) {
      skipped.push(raw);
      continue;
    }
    const uncText = String(uncertainty === undefined ? '' : uncertainty).trim();
    rows.push({
      element, mass: Math.trunc(Number(mass)), value: valueText,
      uncertainty: isNumberLexeme(uncText) ? uncText : '',
      key: key || '', comment: rest.join(' ').trim(),
    });
  }
  return { rows, skipped };
}
