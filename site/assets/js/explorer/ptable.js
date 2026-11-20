// The periodic table that leads to the data of an element (Home, Explorer):
// La and Ac in the main body, Ce-Lu and Th-Lr below.

import { h, card } from '../core/dom.js';
import { CODES, CODE_TITLES, ELEMENT_NAMES } from '../core/vocabulary.js';

/** [row, column] (1-based) of an element in the 18-column layout. */
function position(z) {
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

/** Map(z -> {EXP: n, CUR: n, ...}): number of rows (see store.js) per element and dataset code. */
export function elementCounts(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (!counts.has(r.z)) counts.set(r.z, {});
    const c = counts.get(r.z);
    c[r.code] = (c[r.code] || 0) + 1;
  }
  return counts;
}

/**
 * @param elements  element symbols (index + 1 = Z)
 * @param names     element names
 * @param counts    result of elementCounts()
 * @param selected  selected Z (0 = none)
 * @param href      (z) => link target
 * @param onSelect  optional (z) => void, called instead of following the link
 * @param emptyText the title of an element without data
 */
export function renderPeriodicTable({ elements, names, counts, selected = 0, href, onSelect, emptyText }) {
  const grid = h('div', { class: 'ptable', role: 'group', 'aria-label': 'Periodic table: choose an element' });
  elements.forEach((symbol, i) => {
    const z = i + 1;
    const [row, col] = position(z);
    const c = counts.get(z) || {};
    const total = CODES.reduce((n, d) => n + (c[d] || 0), 0);
    const present = CODES.filter((d) => c[d]);
    const title = `${names[i]} (Z = ${z})` + (total
      ? ` - ${present.map((d) => `${d} ${c[d]}`).join(', ')}` : ` - ${emptyText}`);
    const cell = h('a', {
      class: `pt-cell${total ? ' has-data' : ''}${selected === z ? ' selected' : ''}`,
      href: href(z), title, 'aria-label': title, 'aria-current': selected === z ? 'true' : null,
      style: { gridRow: String(row), gridColumn: String(col) },
      onclick: onSelect && ((event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
        event.preventDefault();
        onSelect(z);
      }),
    },
    h('span', { class: 'pt-z' }, String(z)),
    h('span', { class: 'pt-sym' }, symbol),
    h('span', { class: 'pt-marks', 'aria-hidden': 'true' }, present.map((d) => h('i', { class: `pt-mark ${d}` }))));
    grid.appendChild(cell);
  });
  return grid;
}

/**
 * The card with the periodic table, the same on every page: a title, the
 * choice of the data version on the right, the table and its key.  The key is
 * a switch for each kind of data: an element without data of the kinds
 * switched on is shown as one without data.
 * @param version        a version of model.js
 * @param selected       selected Z (0 = none)
 * @param href           (z) => address of the data of an element
 * @param onSelect       optional (z) => void, called instead of following the link
 * @param onClear        optional () => void: shows all elements again; called on a click on an
 *                       empty space of the table and on the element already selected
 * @param versionChoice  optional node shown on the right of the title
 * @param kinds          Set of the dataset codes switched on
 * @param onKinds        (kinds) => void: called with the new Set when a kind is switched on or off;
 *                       the caller draws the card again
 */
export function periodicTableCard({
  version, selected = 0, href, onSelect = null, onClear = null, versionChoice = null, kinds, onKinds,
}) {
  const choose = onSelect && ((z) => (onClear && z === selected ? onClear() : onSelect(z)));
  const grid = renderPeriodicTable({
    elements: version.tables.elements, names: ELEMENT_NAMES, selected, href, onSelect: choose,
    counts: elementCounts(version.rows.filter((r) => kinds.has(r.code))),
    emptyText: kinds.size === CODES.length ? 'no data yet' : 'no data of the kinds shown',
  });
  if (onClear) {
    grid.addEventListener('click', (event) => { if (event.target === grid) onClear(); });
    if (selected) grid.title = 'Click an empty space (or the selected element) to show all elements';
  }
  const toggle = (d, event) => {
    const next = new Set(kinds);
    if (next.has(d)) next.delete(d); else next.add(d);
    onKinds(next);
    // the switch pressed from the keyboard keeps the focus when the card is drawn again
    if (event.detail === 0) document.querySelector(`.ptable-key [data-kind="${d}"]`).focus();
  };
  // the key sits in the empty space of the table when it fits there (explorer.css)
  return card({ title: 'Choose an element', controls: versionChoice, class: 'ptable-card' },
    h('div', { class: 'card-body' }, h('div', { class: 'ptable-wrap' }, grid,
      h('div', { class: 'ptable-key', role: 'group', 'aria-label': 'Kinds of data marked in the table' },
        CODES.map((d) => h('button', {
          class: 'pill', type: 'button', dataset: { kind: d }, 'aria-pressed': String(kinds.has(d)), onclick: (event) => toggle(d, event),
          title: `${kinds.has(d) ? 'Hide' : 'Show'} the ${CODE_TITLES[d].toLowerCase()} data`,
        }, h('i', { class: `ds-dot ${d}` }), CODE_TITLES[d]))))));
}
