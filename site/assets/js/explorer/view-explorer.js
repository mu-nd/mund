// The explorer (explorer/): periodic table, chart, one table per dataset code
// and a detail panel for the selected data entry (detail.js).  Rows are those of model.js; the
// rows shown are chosen by selectRows() of selection.js, and the downloads of
// the selection are made from the same rows.

import { h, replace, card, cardHead, externalLink, nuclideNode, downloadText, segSwitch } from '../core/dom.js';
import * as jsonfmt from '../core/jsonfmt.js';
import { citeLabel, citeText, sourceUrl } from '../core/cite.js';
import { formatQuantity, formatDerived } from '../core/format.js';
import { QUANTITIES, UNIT_LABELS } from '../core/convert.js';
import { CODES, CODE_TITLES, CODE_NOTES, ELEMENT_NAMES, elementLabel } from '../core/vocabulary.js';
import { query, urlWith, explorerPermalink, pageLink, dsParam } from './route.js';
import { renderDetail } from './detail.js';
import { loadCsv } from './store.js';
import { selectRows, selectionCsv, selectionJson, describeFilters, selectionName } from './selection.js';
import { dataLicence } from './versioning.js';
import { citationTexts } from './citation.js';
import { periodicTableCard } from './ptable.js';
import { renderChart, selectInChart } from './chart.js';

const QUANTITY_NAMES = Object.keys(QUANTITIES);
const DEFAULT_QUANTITY = 'capture_rate';
/** Quantities spanning orders of magnitude across the elements get a logarithmic axis. */
const LOG_AXIS = { lifetime: true, capture_rate: true, capture_probability: false };
const MARKS = {
  EXP: { color: 'var(--ds-exp)', shape: 'circle' },
  TH: { color: 'var(--ds-th)', shape: 'triangle' },
  CUR: { color: 'var(--ds-cur)', shape: 'square' },
  EVAL: { color: 'var(--ds-eval)', shape: 'diamond' },
};

const idOf = (row) => row.entry.datasetId;
const unitText = (name) => UNIT_LABELS[QUANTITIES[name].unit];
const derived = (row, name) => (row.conv
  ? formatDerived(row.conv[QUANTITIES[name].key], row.conv[`${QUANTITIES[name].key}_unc`]).text : '');

function readState(version) {
  const params = query();
  const z = parseInt(params.get('z'), 10);
  const ds = (params.get('ds') || '').split(',').filter((d) => CODES.includes(d));
  return {
    z: z > 0 && z <= version.tables.elements.length ? z : 0,
    a: params.get('a') || '',
    ds: new Set(ds.length ? ds : CODES),
    q: QUANTITIES[params.get('q')] ? params.get('q') : DEFAULT_QUANTITY,
    id: params.get('id') || '',
  };
}

function stateUrl(state) {
  return urlWith({
    z: state.z || null,
    a: state.a,
    ds: dsParam(state.ds),
    q: state.q === DEFAULT_QUANTITY ? null : state.q,
    id: state.id,
  });
}

const givenText = (row) => `${formatQuantity(row.block).text} ${UNIT_LABELS[row.block.unit]}`;
const kindLabel = (row) => QUANTITIES[row.entry.observable.kind].label.toLowerCase();

/**
 * One cell of a table: the quantity given in the source is shown as written
 * and marked; the others are converted from it.
 */
function quantityCell(row, name) {
  if (row.entry.observable.kind === name) {
    const sameUnit = row.block.unit === QUANTITIES[name].unit;
    return h('td', {
      class: 'num measured',
      title: sameUnit ? 'Given in the source' : `Given in the source as ${givenText(row)}; shown here in ${unitText(name)}`,
    }, h('span', { class: 'star', 'aria-label': 'given in the source' }, '★'), ' ', sameUnit ? formatQuantity(row.block).text : derived(row, name));
  }
  return row.conv ? h('td', { class: 'num', title: `Converted from the ${kindLabel(row)} given in the source` }, derived(row, name))
    : h('td', { class: 'num muted' }, '–');
}

function referenceLink(row) {
  const url = sourceUrl(row.entry.bibId, row.reference);
  const label = citeLabel(row.reference, row.entry.bibId);
  const title = citeText(row.reference, row.entry.bibId);
  if (!url) return h('span', { title }, label);
  const link = externalLink(url, label);
  link.title = title;
  link.addEventListener('click', (e) => e.stopPropagation());    // the row behind it opens the details
  return link;
}

export function renderExplorer(root, ctx) {
  const { version, config, versionChoice = null } = ctx;
  const { tables } = version;
  let state = readState(version);
  let stopChart = null;

  const ptableEl = h('div');
  const chartEl = h('section', { class: 'card chart-card' });
  const headingEl = h('div', { class: 'element-heading' });
  const tablesEl = h('div', { class: 'stack' });
  const detailEl = h('aside', { class: 'detail', hidden: true, 'aria-label': 'Details of the selected data entry' });
  replace(root, h('div', { class: 'explorer-top' }, ptableEl, chartEl), headingEl, tablesEl, detailEl);

  const symbolOf = (z) => tables.elements[z - 1];

  function setState(patch, { push = false } = {}) {
    state = { ...state, ...patch };
    if (push) history.pushState(null, '', stateUrl(state));
    else history.replaceState(null, '', stateUrl(state));
    render();
  }

  // ---- periodic table -------------------------------------------------------
  function renderPtable() {
    replace(ptableEl, periodicTableCard({
      version, selected: state.z, versionChoice,
      kinds: state.ds, onKinds: (ds) => setState({ ds }),
      href: (z) => stateUrl({ ...state, z, a: '', id: '' }),
      onSelect: (z) => setState({ z, a: '', id: '' }, { push: true }),
      onClear: () => setState({ z: 0, a: '', id: '' }, { push: true }),
    }));
  }

  // ---- chart ----------------------------------------------------------------
  function renderChartCard(rows) {
    const { label, key } = QUANTITIES[state.q];
    const unit = unitText(state.q);
    const holder = h('div');
    replace(chartEl,
      cardHead(state.z ? `${label} of muonic ${ELEMENT_NAMES[state.z - 1].toLowerCase()} by isotope` : `${label} across the elements`,
        segSwitch('Quantity shown in the chart', QUANTITY_NAMES.map((name) => ({ value: name, text: QUANTITIES[name].label })),
          state.q, (q) => setState({ q }))),
      h('div', { class: 'card-body' }, holder,
        state.z ? null : h('p', { class: 'small muted', style: { margin: '6px 0 0' } },
          'Click a point or an element to see its data. ',
          LOG_AXIS[state.q] ? 'Logarithmic scale; error bars are omitted for the evaluated values.' : '')));

    const point = (row, x) => {
      const y = row.conv ? row.conv[key] : NaN;
      const u = row.conv ? row.conv[`${key}_unc`] : null;
      return { x, y, lo: u === null ? NaN : y - u, hi: u === null ? NaN : y + u, data: row };
    };
    const series = (x, context) => CODES.map((d) => ({
      label: CODE_TITLES[d], ...MARKS[d], context: context && d === 'EVAL',
      points: rows.filter((r) => r.code === d).map((r) => point(r, x(r))),
    }));
    const symbol = symbolOf(state.z);
    const masses = [...new Set(rows.map((r) => r.a))].sort((x, y) => x - y);
    if (stopChart) stopChart();
    stopChart = renderChart(holder, {
      series: state.z ? series((r) => r.a, false) : series((r) => r.z, true),
      x: state.z
        ? { type: 'band', label: 'Nuclide', bands: masses.map((a) => ({
          key: a,
          label: () => [h('tspan', { 'baseline-shift': 'super', 'font-size': '9' }, a ? String(a) : 'nat'), h('tspan', null, symbol)],
        })) }
        : { type: 'linear', label: 'Atomic number Z', domain: [0, Math.max(10, ...version.rows.map((r) => r.z)) + 2] },
      y: { label: `${label} (${unit})`, log: !state.z && LOG_AXIS[state.q] },
      tooltip: ({ data: row }) => h('div', null,
        row.entry.observable.kind === state.q
          ? h('div', { class: 'tip-value' }, h('span', { class: 'star' }, '★'), ` ${givenText(row)}`,
            h('span', { class: 'tip-kind' }, ' given in the source'))
          : h('div', { class: 'tip-value' }, `${derived(row, state.q)} ${unit}`,
            h('span', { class: 'tip-kind' }, ` converted from the ${kindLabel(row)}`)),
        h('div', { class: 'tip-name' }, nuclideNode(row.entry.nuclide.element, row.a), ` · ${CODE_TITLES[row.code]}`),
        h('div', { class: 'tip-ref muted' }, citeText(row.reference, row.entry.bibId))),
      onSelect: ({ data: row }) => (state.z ? setState({ id: idOf(row) }) : setState({ z: row.z, a: '', id: '' }, { push: true })),
      keyOf: ({ data: row }) => idOf(row),
      selectedKey: state.id,
      emptyText: 'No data for this selection.',
    });
  }

  // ---- downloads ------------------------------------------------------------
  // The CSV and JSON of a selection hold exactly the rows given to them: those
  // of the tables on the page (see selection.js).
  const codesOf = (ds) => CODES.filter((d) => ds.has(d));
  const selectionLink = (codes) => explorerPermalink(version.label, { z: state.z || null, a: state.a, ds: dsParam(new Set(codes)) });

  function download(kind, rowsToSave, codes, statusEl) {
    const filters = describeFilters({ z: state.z, a: state.a, ds: codes }, tables.elements);
    const name = selectionName(version.manifest, filters);
    replace(statusEl);
    if (kind === 'json') {
      const url = selectionLink(codes);
      const doc = selectionJson({
        version, rows: rowsToSave, filters, permalink: url,
        citation: citationTexts(config, { ...version.manifest, label: version.label }, url), dataLicence: dataLicence(config),
      });
      downloadText(`${name}.json`, jsonfmt.stringify(doc), 'application/json');
      return;
    }
    replace(statusEl, 'Preparing …');
    loadCsv(version)
      .then((text) => { downloadText(`${name}.csv`, selectionCsv(text, rowsToSave), 'text/csv'); replace(statusEl); })
      .catch((err) => replace(statusEl, h('span', { class: 'download-error' }, `The CSV file could not be made: ${err.message}`)));
  }

  function downloadButtons(rowsToSave, codes, what) {
    const status = h('span', { class: 'small', role: 'status' });
    return [
      h('button', {
        class: 'btn small', type: 'button', onclick: () => download('csv', rowsToSave, codes, status),
        title: `${what} as CSV, with the columns of csv/LT.csv of this version: as given in the source and converted`,
      }, 'CSV'),
      h('button', {
        class: 'btn small', type: 'button', onclick: () => download('json', rowsToSave, codes, status),
        title: `${what} as JSON: the entries as published, their metadata and references, and the data version`,
      }, 'JSON'),
      status,
    ];
  }

  // ---- heading and tables ---------------------------------------------------
  // the element and the nuclide, one choice beside the other; the periodic table chooses the element too,
  // and both offer the elements with data of the kinds switched on in its key
  function renderHeading(rows, inElement) {
    const symbol = state.z ? symbolOf(state.z) : '';
    const zs = [...new Set(version.rows.filter((r) => state.ds.has(r.code)).map((r) => r.z).concat(state.z ? [state.z] : []))]
      .sort((x, y) => x - y);
    const masses = state.z ? [...new Set(inElement.map((r) => r.a))].sort((x, y) => x - y) : [];
    // the choice keeps the focus when the heading is drawn again
    const choose = (label, patch, push) => {
      setState(patch, { push });
      headingEl.querySelector(`select[aria-label="${label}"]`).focus();
    };
    replace(headingEl,
      h('h1', { class: 'visually-hidden' }, state.z ? `${ELEMENT_NAMES[state.z - 1]} (Z = ${state.z})` : 'All elements'),
      h('div', { class: 'heading-row' },
        h('select', { 'aria-label': 'Element', onchange: (e) => choose('Element', { z: Number(e.target.value), a: '', id: '' }, true) },
          h('option', { value: '0' }, 'All elements'),
          zs.map((z) => h('option', { value: String(z), selected: state.z === z }, elementLabel(z, symbolOf(z))))),
        h('select', { 'aria-label': 'Nuclide', disabled: !state.z, onchange: (e) => choose('Nuclide', { a: e.target.value, id: '' }, false) },
          h('option', { value: '' }, 'All nuclides'),
          masses.map((a) => h('option', { value: String(a), selected: state.a === String(a) }, `${a || 'nat'}${symbol}`))),
        h('span', { class: 'spacer' }),
        rows.length ? h('div', { class: 'row no-print' },
          h('span', { class: 'small muted' }, `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`),
          downloadButtons(rows, codesOf(state.ds), `The ${rows.length} entries shown below`)) : null),
      h('p', { class: 'small muted' }, '★ the quantity given in the source; the other columns are converted from it (',
        h('a', { href: pageLink('tools/converter') }, 'Converter'), ').'));
  }

  function renderTables(rows) {
    // one table per kind of data shown that has entries in the selection
    const sections = CODES.filter((d) => state.ds.has(d) && rows.some((r) => r.code === d)).map((d) => {
      const subset = rows.filter((r) => r.code === d);
      const exp = d === 'EXP';
      return card({
        title: h('div', null,
          h('h2', null, h('i', { class: `ds-dot ${d}` }), ` ${CODE_TITLES[d]} data `,
            h('span', { class: 'tag' }, String(subset.length))),
          h('p', { class: 'small muted', style: { margin: '2px 0 0' } }, CODE_NOTES[d])),
      },
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', null, h('tr', null,
            h('th', null, 'Nuclide'),
            QUANTITY_NAMES.map((name) => h('th', { class: 'num' }, `${QUANTITIES[name].label} (${unitText(name)})`)),
            exp ? [h('th', null, 'Facility'), h('th', null, 'Method')] : null,
            h('th', null, 'Note'),
            h('th', null, 'Reference'))),
          h('tbody', null, subset.map((r) => {
            const { entry } = r;
            return h('tr', {
              class: 'selectable', tabindex: '0', 'aria-selected': String(idOf(r) === state.id), dataset: { id: idOf(r) },
              onclick: () => setState({ id: idOf(r) === state.id ? '' : idOf(r) }),
              onkeydown: (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setState({ id: idOf(r) }); }
              },
            },
            h('td', { class: 'nowrap' }, nuclideNode(entry.nuclide.element, r.a),
              entry.nuclide.mass === 0 && r.a ? h('span', { class: 'muted small', title: 'Target of natural abundance' }, ' nat') : null,
              entry.nuclide.isomer ? h('span', { class: 'muted small' }, ` m${entry.nuclide.isomer}`) : null),
            QUANTITY_NAMES.map((name) => quantityCell(r, name)),
            exp ? [h('td', null, r.meta.facility || ''), h('td', null, r.meta.method || '')] : null,
            h('td', { class: 'small' }, entry.key ? [h('span', { class: 'tag' }, entry.key), ' '] : null, entry.comment || '',
              r.originals.some((o) => o.changed) ? [' ', h('span', {
                class: 'tag changed', title: 'An entry this value was derived from has changed since; to be checked again',
              }, 'original changed')] : null),
            h('td', { class: 'nowrap' }, referenceLink(r)));
          })))));
    });
    replace(tablesEl, sections.length ? sections
      : h('p', { class: 'notice' }, state.ds.size ? 'No data for this selection.' : 'Choose at least one kind of data in the key below the periodic table.'));
  }

  function markSelection() {
    for (const tr of tablesEl.querySelectorAll('tr[data-id]')) {
      tr.setAttribute('aria-selected', String(tr.dataset.id === state.id));
    }
    selectInChart(chartEl, state.id);
  }

  // ---- detail panel -----------------------------------------------------------
  function showDetail() {
    renderDetail(detailEl, {
      version, config, id: state.id,
      link: (id) => stateUrl({ ...state, id }),
      select: (id) => setState({ id }),
      permalinkOf: (row) => explorerPermalink(version.label, { z: row.z, id: row.entry.datasetId }),
    });
  }

  // ---- drawing ------------------------------------------------------------------
  let drawn = '';
  function render() {
    const key = JSON.stringify([state.z, state.a, [...state.ds], state.q]);
    if (key !== drawn) {
      const inElement = selectRows(version.rows, { z: state.z });
      const rows = selectRows(version.rows, state);
      renderPtable();
      renderChartCard(rows);
      renderHeading(rows, inElement);
      renderTables(rows);
      drawn = key;
    } else {
      markSelection();
    }
    showDetail();
    document.title = `${state.z ? `${ELEMENT_NAMES[state.z - 1]} – ` : ''}Muon Nuclear Data`;
  }

  const onKey = (e) => { if (e.key === 'Escape' && state.id) setState({ id: '' }); };
  const onPop = () => { state = readState(version); render(); };
  document.addEventListener('keydown', onKey);
  window.addEventListener('popstate', onPop);
  render();
  if (state.id) {
    const tr = tablesEl.querySelector(`tr[data-id="${CSS.escape(state.id)}"]`);
    if (tr) tr.scrollIntoView({ block: 'center' });
  }
  return () => {
    if (stopChart) stopChart();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', onPop);
    document.body.classList.remove('has-detail');
  };
}
