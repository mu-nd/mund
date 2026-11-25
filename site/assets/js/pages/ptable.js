// The periodic table that leads to the data of an element (Home, Explorer):
// La and Ac in the main body, Ce-Lu and Th-Lr below.  The table is one stop
// of the Tab key; the arrow keys, Home and End move between its cells.

import { h, card, stateLink } from '../core/dom.js';
import { CODES, CODE_TITLES, countsInWords, elementLabel } from '../core/vocabulary.js';
import { elementsWithData } from './selection.js';

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

/** [row, column] step of each key; Home and End step from beyond the ends of the row. */
const MOVES = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0], Home: [0, 1], End: [0, -1] };

/**
 * The element a key moves to from z, past the empty places (0: none).
 * @param at  Map('row,column' -> z) of the cells of the table
 */
function moveTo(at, z, key) {
  const step = MOVES[key];
  if (!step) return 0;
  let [row, col] = position(z);
  if (key === 'Home') col = 0;
  if (key === 'End') col = 19;
  for (row += step[0], col += step[1]; row >= 1 && row <= 10 && col >= 1 && col <= 18; row += step[0], col += step[1]) {
    if (at.has(`${row},${col}`)) return at.get(`${row},${col}`);
  }
  return 0;
}

/** Map(z -> {EXP: n, CUR: n, ...}): number of rows (see model.js) per element and dataset code. */
function elementCounts(rows) {
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
 * @param counts    result of elementCounts()
 * @param selected  selected Z (0 = none)
 * @param href      (z) => link target
 * @param onSelect  optional (z, event) => void, called instead of following the link
 * @param emptyText the title of an element without data
 */
function renderPeriodicTable({ elements, counts, selected = 0, href, onSelect, emptyText }) {
  const grid = h('div', { class: 'ptable', role: 'group', 'aria-label': 'Periodic table: choose an element' });
  const at = new Map();
  const cells = elements.map((symbol, i) => {
    const z = i + 1;
    const [row, col] = position(z);
    at.set(`${row},${col}`, z);
    const c = counts.get(z) || {};
    const present = CODES.filter((d) => c[d]);
    const title = `${elementLabel(z, symbol)}: ${present.length ? countsInWords(c) : emptyText}`;
    return stateLink({
      class: `pt-cell${present.length ? ' has-data' : ''}${selected === z ? ' selected' : ''}`,
      href: href(z), title, 'aria-label': title, 'aria-current': selected === z ? 'true' : null,
      tabindex: z === (selected || 1) ? '0' : '-1',
      style: { gridRow: String(row), gridColumn: String(col) },
    }, onSelect && ((event) => onSelect(z, event)),
    h('span', { class: 'pt-z' }, String(z)),
    h('span', { class: 'pt-sym' }, symbol),
    h('span', { class: 'pt-marks', 'aria-hidden': 'true' }, present.map((d) => h('i', { class: `ds-dot ${d}` }))));
  });
  grid.append(...cells);
  // the cell last focused is the one the Tab key comes back to
  grid.addEventListener('focusin', (event) => {
    for (const cell of cells) cell.tabIndex = cell === event.target ? 0 : -1;
  });
  grid.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = moveTo(at, cells.indexOf(event.target) + 1, event.key);
    if (next) { event.preventDefault(); cells[next - 1].focus(); }
  });
  return grid;
}

/** A choice of the elements with data of the kinds switched on and a link to the data of the one chosen. */
function elementPicker(version, kinds, href) {
  const zs = elementsWithData(version.rows, kinds);
  if (!zs.length) return null;
  const show = h('a', { class: 'btn', href: href(zs[0]) }, 'Show the data');
  const select = h('select', { id: 'pt-element', onchange: (e) => { show.href = href(Number(e.target.value)); } },
    zs.map((z) => h('option', { value: String(z) }, elementLabel(z, version.tables.elements[z - 1]))));
  return h('div', { class: 'ptable-choice' }, h('label', { for: 'pt-element' }, 'Element'), select, show);
}

/**
 * The card with the periodic table, the same on every page: a title, the
 * choice of the data version on the right, the table and its key.  The key is
 * a switch for each kind of data: an element without data of the kinds
 * switched on is shown as one without data.  A kind without data in the
 * version cannot be switched on, and the last kind on cannot be switched off.
 * @param version        a version of model.js
 * @param selected       selected Z (0 = none)
 * @param href           (z) => address of the data of an element
 * @param onSelect       optional (z) => void, called instead of following the link
 * @param onClear        optional () => void: shows all elements again; called on a click on an
 *                       empty space of the table and on the element already selected
 * @param versionChoice  optional node shown on the right of the title
 * @param kinds          Set of the dataset codes switched on (a code without data counts as off)
 * @param onKinds        (kinds) => void: called with the new Set when a kind is switched on or off
 *                       (all codes when every kind with data is on); the caller draws the card again
 * @param elementChoice  true: below the table, a choice of the elements and a link to the data of the one
 *                       chosen, for screens where the cells are too small to tap (pages.css shows it at
 *                       640px and narrower)
 */
export function periodicTableCard({
  version, selected = 0, href, onSelect = null, onClear = null, versionChoice = null, kinds, onKinds, elementChoice = false,
}) {
  const choose = onSelect && ((z, event) => {
    if (onClear && z === selected) onClear(); else onSelect(z);
    // the element chosen from the keyboard keeps the focus when the card is drawn again
    if (event.detail === 0) document.querySelectorAll('.ptable .pt-cell')[z - 1].focus();
  });
  const withData = CODES.filter((d) => version.rows.some((r) => r.code === d));
  const on = withData.filter((d) => kinds.has(d));
  const grid = renderPeriodicTable({
    elements: version.tables.elements, selected, href, onSelect: choose,
    counts: elementCounts(version.rows.filter((r) => kinds.has(r.code))),
    emptyText: on.length === withData.length ? 'no data yet' : 'no data of the kinds shown',
  });
  if (onClear) {
    grid.addEventListener('click', (event) => { if (event.target === grid) onClear(); });
    if (selected) grid.title = 'Click an empty space (or the selected element) to show all elements';
  }
  const toggle = (d, event) => {
    const next = on.includes(d) ? on.filter((c) => c !== d) : on.concat(d);
    onKinds(new Set(next.length === withData.length ? CODES : next));
    // the switch pressed from the keyboard keeps the focus when the card is drawn again
    if (event.detail === 0) document.querySelector(`.ptable-key [data-kind="${d}"]`).focus();
  };
  // the key sits in the empty space of the table when it fits there (pages.css)
  return card({ title: 'Choose an element', controls: versionChoice, class: 'ptable-card' },
    h('div', { class: 'card-body' }, h('div', { class: 'ptable-wrap' }, grid,
      h('div', { class: 'ptable-key', role: 'group', 'aria-label': 'Kinds of data marked in the table' },
        CODES.map((d) => {
          const name = CODE_TITLES[d].toLowerCase();
          const pressed = on.includes(d);
          const last = pressed && on.length === 1;
          return h('button', {
            class: 'pill', type: 'button', dataset: { kind: d }, 'aria-pressed': String(pressed),
            disabled: !withData.includes(d) || last, onclick: (event) => toggle(d, event),
            title: !withData.includes(d) ? `No ${name} data in this version`
              : last ? 'At least one kind of data stays shown' : `${pressed ? 'Hide' : 'Show'} the ${name} data`,
          }, h('i', { class: `ds-dot ${d}` }), CODE_TITLES[d]);
        }))),
      elementChoice ? elementPicker(version, kinds, href) : null));
}
