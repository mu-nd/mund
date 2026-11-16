// Periodic table used to pick an element (same arrangement as the project
// top page: La and Ac in the main body, Ce-Lu and Th-Lr below).

import { h } from '../core/dom.js';
import { DATASETS } from './store.js';

/** [row, column] (1-based) of an element in the 18-column layout. */
export function position(z) {
  if (z === 1) return [1, 1];
  if (z === 2) return [1, 18];
  if (z <= 4) return [2, z - 2];
  if (z <= 10) return [2, z + 8];
  if (z <= 12) return [3, z - 10];
  if (z <= 18) return [3, z];
  if (z <= 36) return [4, z - 18];
  if (z <= 54) return [5, z - 36];
  if (z <= 57) return [6, z - 54];
  if (z <= 71) return [9, z - 54];      // Ce (58) .. Lu (71) -> columns 4 .. 17
  if (z <= 86) return [6, z - 68];
  if (z <= 89) return [7, z - 86];
  if (z <= 103) return [10, z - 86];    // Th (90) .. Lr (103)
  return [7, z - 100];
}

/**
 * @param elements  element symbols (index + 1 = Z)
 * @param names     element names
 * @param counts    Map(z -> {EXP: n, CUR: n, ...}) for the current sub-library
 * @param selected  selected Z (0 = all)
 * @param href      (z) => link target
 * @param onSelect  (z, event) => void
 */
export function renderPeriodicTable({ elements, names, counts, selected, href, onSelect }) {
  const grid = h('div', { class: 'ptable', role: 'group', 'aria-label': 'Periodic table: choose an element' });
  elements.forEach((symbol, i) => {
    const z = i + 1;
    const [row, col] = position(z);
    const c = counts.get(z) || {};
    const total = DATASETS.reduce((n, d) => n + (c[d] || 0), 0);
    const present = DATASETS.filter((d) => c[d]);
    const title = `${names[i]} (Z = ${z})` + (total
      ? ` - ${present.map((d) => `${d} ${c[d]}`).join(', ')}` : ' - no data yet');
    const cell = h('a', {
      class: `pt-cell${total ? ' has-data' : ''}${selected === z ? ' selected' : ''}`,
      href: href(z), title, 'aria-label': title, 'aria-current': selected === z ? 'true' : null,
      style: { gridRow: String(row), gridColumn: String(col) },
      onclick: (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
        event.preventDefault();
        onSelect(z);
      },
    },
    h('span', { class: 'pt-z' }, String(z)),
    h('span', { class: 'pt-sym' }, symbol),
    h('span', { class: 'pt-marks', 'aria-hidden': 'true' }, present.map((d) => h('i', { class: `pt-mark ${d}` }))));
    grid.appendChild(cell);
  });
  return grid;
}
