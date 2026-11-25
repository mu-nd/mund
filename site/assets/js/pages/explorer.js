// The explorer (explorer/): periodic table, chart, one table per dataset code
// and a detail panel for the selected data entry (detail.js).  Rows are those of model.js; the
// rows shown are chosen by selectRows() of selection.js, and the downloads of
// the selection are made from the same rows.

import { h, replace, card, externalLink, stateLink, rowClick, nuclideNode, downloadText, segSwitch, setSegSwitch } from '../core/dom.js';
import * as jsonfmt from '../core/jsonfmt.js';
import { citeLabel, citeText, sourceUrl, citationTexts } from '../core/cite.js';
import { formatQuantity, formatConverted, quantityText } from '../core/format.js';
import { OBSERVABLES, KINDS, unitLabel } from '../core/convert.js';
import { CODES, CODE_TITLES, CODE_NOTES, ELEMENT_NAMES, elementLabel, entriesText } from '../core/vocabulary.js';
import { query, urlWith, explorerPermalink, pageLink, dsParam } from './route.js';
import { currentId } from './model.js';
import { renderDetail, changedTag, noteTag, naturalTargetNote } from './detail.js';
import { loadCsv } from './store.js';
import { selectRows, elementsWithData, selectionCsv, selectionJson, describeFilters, selectionName } from './selection.js';
import { periodicTableCard } from './ptable.js';
import { renderChart, selectInChart } from './chart.js';

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

function readState(version) {
  const params = query();
  const z = parseInt(params.get('z'), 10);
  const a = params.get('a') || '';
  const ds = (params.get('ds') || '').split(',').filter((d) => CODES.includes(d));
  return {
    z: z > 0 && z <= version.tables.elements.length ? z : 0,
    a: /^\d+$/.test(a) ? String(Number(a)) : '',
    ds: new Set(ds.length ? ds : CODES),
    q: KINDS.includes(params.get('q')) ? params.get('q') : DEFAULT_QUANTITY,
    id: currentId(version, params.get('id')) || params.get('id') || '',
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

const kindLabel = (row) => OBSERVABLES[row.entry.observable.kind].label.toLowerCase();

/**
 * One cell of a table: the quantity given in the source is shown as written
 * and marked; the others are converted from it.
 */
function quantityCell(row, kind) {
  if (row.entry.observable.kind === kind) {
    const sameUnit = row.block.unit === OBSERVABLES[kind].unit;
    return h('td', {
      class: 'num measured',
      title: sameUnit ? 'Given in the source' : `Given in the source as ${quantityText(row.block)}; shown here in ${unitLabel(kind)}`,
    }, h('span', { class: 'star', 'aria-hidden': 'true' }, '★'), h('span', { class: 'visually-hidden' }, 'given in the source'), ' ',
    formatQuantity(row.block, row.unitScale));
  }
  return row.conv ? h('td', { class: 'num', title: `Converted from the ${kindLabel(row)} given in the source` }, formatConverted(row.conv, kind))
    : h('td', { class: 'num muted' }, '–');
}

function referenceLink(row) {
  const url = sourceUrl(row.entry.bibId, row.reference);
  const label = citeLabel(row.reference, row.entry.bibId);
  const title = citeText(row.reference, row.entry.bibId);
  if (!url) return h('span', { title }, label);
  return externalLink(url, label, { title });
}

export function renderExplorer(root, ctx) {
  const { version, config, versionChoice = null } = ctx;
  const { tables } = version;
  let state = readState(version);
  let stopChart = null;
  const pageTitle = document.title;    // as built; the chosen element goes before it

  // the controls are made once and stay on the page, so they keep the keyboard focus
  const ptableEl = h('div');
  const chartTitle = h('h2');
  const quantitySwitch = segSwitch('Quantity shown in the chart', KINDS.map((kind) => ({ value: kind, text: OBSERVABLES[kind].label })),
    state.q, (q) => setState({ q }));
  const chartBody = h('div', { class: 'card-body' });
  const chartEl = card({ title: chartTitle, controls: quantitySwitch }, chartBody);
  // the page's one h1, first in <main>; the element chosen (renderHeading)
  const elementTitle = h('h1', { class: 'visually-hidden' });
  const elementSelect = h('select', { 'aria-label': 'Element',
    onchange: (e) => setState({ z: Number(e.target.value), a: '', id: '' }, { push: true }) });
  const nuclideSelect = h('select', { 'aria-label': 'Nuclide', onchange: (e) => setState({ a: e.target.value, id: '' }) });
  const selectionTools = h('div', { class: 'row no-print' });
  const converterLink = h('a', null, 'Converter');
  const starNote = h('p', { class: 'small muted' }, '★ the quantity given in the source; the other columns are converted from it (',
    converterLink, ').');
  const headingEl = h('div', { class: 'element-heading' },
    h('div', { class: 'heading-row' }, elementSelect, nuclideSelect, h('span', { class: 'spacer' }), selectionTools), starNote);
  const missingEntry = h('p', { class: 'notice warn', role: 'status', hidden: true });
  const tablesEl = h('div', { class: 'stack' });
  const detailEl = h('aside', { class: 'detail', hidden: true, 'aria-label': 'Details of the selected data entry' });
  // the panel starts below the header (pages.css .detail), so the menu and the icons stay in view
  const header = document.querySelector('.site-header');
  if (header) new ResizeObserver(() => document.documentElement.style.setProperty('--header-height', `${header.getBoundingClientRect().height}px`)).observe(header);
  replace(root, elementTitle, missingEntry, h('div', { class: 'explorer-top' }, ptableEl, chartEl), headingEl, tablesEl, detailEl);

  const symbolOf = (z) => tables.elements[z - 1];

  function setState(patch, { push = false } = {}) {
    state = { ...state, ...patch };
    state.id = currentId(version, state.id) || state.id;
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
  // with no rows, the chart card holds the one message of the page
  function renderChartCard(rows) {
    const { label, key } = OBSERVABLES[state.q];
    const unit = unitLabel(state.q);
    const holder = h('div');
    const name = state.z ? ELEMENT_NAMES[state.z - 1].toLowerCase() : '';
    replace(chartTitle, !state.z ? `${label} across the elements`
      : state.a ? [`${label} of muonic `, nuclideNode(symbolOf(state.z), Number(state.a))] : `${label} of muonic ${name} by isotope`);
    setSegSwitch(quantitySwitch, state.q);
    replace(chartBody, holder,
      state.z || !rows.length ? null : h('p', { class: 'small muted', style: { margin: '6px 0 0' } },
        'Click a point or an element to see its data. ', LOG_AXIS[state.q] ? 'Logarithmic scale. ' : '',
        // the evaluated values are a context series, drawn without error bars
        rows.some((r) => r.code === 'EVAL') ? 'Error bars are omitted for the evaluated values.' : ''));

    const point = (row, x) => {
      const measured = row.entry.observable.kind === state.q;
      const y = measured ? row.block.value * row.unitScale : row.conv?.[key] ?? NaN;
      const u = measured && row.unc !== null ? row.unc * row.unitScale : row.conv?.[`${key}_unc`] ?? null;
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
          ? h('div', { class: 'tip-value' }, h('span', { class: 'star' }, '★'), ` ${quantityText(row.block)}`,
            h('span', { class: 'tip-kind' }, ' given in the source'))
          : h('div', { class: 'tip-value' }, `${formatConverted(row.conv, state.q)} ${unit}`,
            h('span', { class: 'tip-kind' }, ` converted from the ${kindLabel(row)}`)),
        h('div', { class: 'tip-name' }, nuclideNode(row.entry.nuclide.element, row.a), naturalTargetNote(row), ` · ${CODE_TITLES[row.code]}`),
        h('div', { class: 'tip-ref muted' }, citeText(row.reference, row.entry.bibId))),
      onSelect: ({ data: row }) => (state.z ? setState({ id: idOf(row) }) : setState({ z: row.z, a: '', id: '' }, { push: true })),
      keyOf: ({ data: row }) => idOf(row),
      get selectedKey() { return state.id; },
      emptyText: rows.length ? null : state.z && !version.rows.some((r) => r.z === state.z)
        ? `No LT data for ${name} in this version.` : 'No data for this selection.',
    });
  }

  // ---- downloads ------------------------------------------------------------
  // The CSV and JSON of a selection hold exactly the rows of the tables on the
  // page (`shown`, see selection.js).
  let shown = [];
  const status = h('span', { class: 'small', role: 'status' });

  async function download(kind) {
    const rows = shown;
    const filters = describeFilters({ z: state.z, a: state.a, ds: CODES.filter((c) => state.ds.has(c)) }, tables.elements);
    const name = selectionName(version.manifest, filters);
    replace(status, 'Preparing …');
    try {
      version.checkExportSource();
      if (kind === 'json') {
        const url = explorerPermalink(version.label, { z: state.z || null, a: state.a, ds: dsParam(state.ds) });
        const doc = selectionJson({
          version, rows, filters, permalink: url,
          citation: citationTexts(config, { ...version.manifest, label: version.label }, url), dataLicence: config.dataLicence,
        });
        downloadText(`${name}.json`, jsonfmt.stringify(doc), 'application/json');
      } else {
        const csv = await loadCsv(version);
        downloadText(`${name}.csv`, selectionCsv(csv, rows), 'text/csv');
      }
      replace(status);
    } catch (err) {
      replace(status, h('span', { class: 'download-error' }, `The ${kind.toUpperCase()} file could not be made: ${err.message}`));
    }
  }

  function downloadButtons() {
    const what = `The ${entriesText(shown.length)} shown below`;
    replace(status);
    return [
      h('button', {
        class: 'btn small', type: 'button', onclick: () => download('csv'),
        title: `${what} as CSV, with the columns of csv/LT.csv of this version: as given in the source and converted`,
      }, 'CSV'),
      h('button', {
        class: 'btn small', type: 'button', onclick: () => download('json'),
        title: `${what} as JSON: the entries as published, their metadata and references, and the data version`,
      }, 'JSON'),
      status,
    ];
  }

  // ---- heading and tables ---------------------------------------------------
  // the element and the nuclide, one choice beside the other; the periodic table chooses the element too,
  // and both offer the elements with data of the kinds switched on in its key
  function renderHeading(rows) {
    const symbol = state.z ? symbolOf(state.z) : '';
    const zs = elementsWithData(version.rows, state.ds, state.z);
    const masses = new Set(state.z ? selectRows(version.rows, { z: state.z, ds: state.ds }).map((r) => r.a) : []);
    if (state.a) masses.add(Number(state.a));
    elementTitle.textContent = state.z ? `${ELEMENT_NAMES[state.z - 1]} (Z = ${state.z})` : 'All elements';
    replace(elementSelect, h('option', { value: '0' }, 'All elements'),
      zs.map((z) => h('option', { value: String(z), selected: state.z === z }, elementLabel(z, symbolOf(z)))));
    replace(nuclideSelect, h('option', { value: '' }, 'All nuclides'),
      [...masses].sort((x, y) => x - y).map((a) => h('option', { value: String(a), selected: state.a === String(a) },
        symbol ? `${a || 'nat'}${symbol}` : a ? `A = ${a}` : 'Natural targets')));
    nuclideSelect.disabled = !masses.size;
    converterLink.href = pageLink('tools/converter', { z: state.z || null });
    starNote.hidden = !rows.length;
    selectionTools.hidden = !rows.length;
    replace(selectionTools, rows.length ? [
      h('span', { class: 'small muted' }, entriesText(rows.length)), downloadButtons()] : null);
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
            KINDS.map((kind) => h('th', { class: 'num' }, `${OBSERVABLES[kind].label} (${unitLabel(kind)})`)),
            exp ? [h('th', null, 'Facility'), h('th', null, 'Method')] : null,
            h('th', null, 'Note'),
            h('th', null, 'Reference'))),
          h('tbody', null, subset.map((r) => {
            const { entry } = r;
            const id = idOf(r);
            // the nuclide is the link to the details; a click elsewhere in the row (not on a link, not a drag that selects text) opens or closes them
            return h('tr', {
              class: 'selectable', 'aria-current': id === state.id ? 'true' : null, dataset: { id },
              onclick: rowClick(() => setState({ id: id === state.id ? '' : id })),
            },
            h('td', { class: 'nowrap' }, stateLink({ href: stateUrl({ ...state, id }) }, () => setState({ id }),
              nuclideNode(entry.nuclide.element, r.a)),
              naturalTargetNote(r),
              entry.nuclide.isomer ? h('span', { class: 'muted small' }, ` m${entry.nuclide.isomer}`) : null),
            KINDS.map((kind) => quantityCell(r, kind)),
            exp ? [h('td', null, r.meta.facility || ''), h('td', null, r.meta.method || '')] : null,
            h('td', { class: 'small' }, entry.key ? [h('span', { class: 'tag' }, entry.key), ' '] : null, entry.comment || '',
              r.originals.some((o) => o.changed)
                ? [' ', changedTag('An entry this value was derived from has changed since; to be checked again')] : null,
              (entry.corrections || []).length ? [' ', noteTag('corrected', 'Corrected by muND; see the details')] : null),
            h('td', { class: 'nowrap' }, referenceLink(r)));
          })))));
    });
    replace(tablesEl, sections);
  }

  function markSelection() {
    for (const tr of tablesEl.querySelectorAll('tr[data-id]')) {
      if (tr.dataset.id === state.id) tr.setAttribute('aria-current', 'true');
      else tr.removeAttribute('aria-current');
    }
    selectInChart(chartEl, state.id);
  }

  // ---- detail panel -----------------------------------------------------------
  // Focus moves to the panel's heading when it opens for another entry (not when it is drawn again for the
  // same one). Below 1500px it stays in the panel while the panel is open, and Tab from the header enters it.
  // When the panel is closed by its button or Escape, focus goes back to the entry's link in the tables, or, if
  // the entry has no row there, to what had the focus when the panel opened, or else to the element choice.
  let detailId = '';
  let opener = null;
  function showDetail() {
    renderDetail(detailEl, {
      version, config, id: state.id,
      link: (id) => stateUrl({ ...state, id }),
      select: (id) => (id ? setState({ id }) : closeDetail()),
      permalinkOf: (row) => explorerPermalink(version.label, { z: row.z, id: row.entry.datasetId }),
    });
    missingEntry.hidden = !state.id || !detailEl.hidden;
    if (!missingEntry.hidden) replace(missingEntry, `Entry “${state.id}” was not found in version ${version.manifest.version}. `,
      h('button', { type: 'button', class: 'btn small', onclick: () => setState({ id: '' }) }, 'Clear selection'));
    const openId = detailEl.hidden ? '' : state.id;
    if (openId && !detailId) opener = document.activeElement !== document.body ? document.activeElement : null;
    if (!openId) opener = null;
    if (openId && openId !== detailId) detailEl.querySelector('h2').focus({ preventScroll: true });
    detailId = openId;
    syncInert();
  }
  function syncInert() {
    for (const el of root.children) if (el !== detailEl) el.inert = Boolean(detailId) && phone.matches;
  }
  function closeDetail() {
    const id = detailId;
    const back = opener;
    setState({ id: '' });
    const link = id ? tablesEl.querySelector(`tr[data-id="${CSS.escape(id)}"] a`) : null;
    (link || (back && back.isConnected && !detailEl.contains(back) ? back : null) || elementSelect).focus();
  }
  // below 1500px the panel lies over the page (pages.css): Tab stays in it, and on a phone the page under it is inert, until it is closed
  const overlay = window.matchMedia('(max-width: 1499px)');
  const phone = window.matchMedia('(max-width: 640px)');
  phone.addEventListener('change', syncInert);
  const tabStops = (el) => [...el.querySelectorAll('a[href], button, summary, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((e) => e.getClientRects().length > 0 && !e.closest('details:not([open]) > :not(summary)'));
  detailEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !overlay.matches) return;
    const stops = tabStops(detailEl);
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === detailEl.querySelector('h2'))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  });
  // Tab from the last control of the header goes on in the panel, not in the page under it (the page is inert on a phone)
  if (header) header.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.shiftKey || !detailId || !overlay.matches || phone.matches) return;
    const stops = tabStops(header), inPanel = tabStops(detailEl);
    if (document.activeElement !== stops[stops.length - 1] || !inPanel.length) return;
    e.preventDefault();
    inPanel[0].focus();
  });

  // ---- drawing ------------------------------------------------------------------
  let drawn = '';
  function render() {
    const key = JSON.stringify([state.z, state.a, [...state.ds], state.q]);
    if (key !== drawn) {
      shown = selectRows(version.rows, state);
      renderPtable();
      renderChartCard(shown);
      renderHeading(shown);
      renderTables(shown);
      drawn = key;
    } else {
      markSelection();
    }
    showDetail();
    document.title = state.z ? `${ELEMENT_NAMES[state.z - 1]} – ${pageTitle}` : pageTitle;
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detailId) closeDetail(); });
  window.addEventListener('popstate', () => { state = readState(version); render(); });
  render();
  // an entry asked for by a former DataID: the address names its current one
  if (state.id && state.id !== query().get('id')) history.replaceState(null, '', stateUrl(state));
  if (state.id) {
    const tr = tablesEl.querySelector(`tr[data-id="${CSS.escape(state.id)}"]`);
    if (tr) tr.scrollIntoView({ block: 'center' });
  }
}
