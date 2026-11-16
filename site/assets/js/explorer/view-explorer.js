// The data explorer: periodic table, chart, one table per dataset type and a
// detail panel for the selected data entry.
//
// A "row" (see store.js) is one data entry as published (`row.entry`, in the
// shape { datasetId, datasetType, nuclide, observable, bibId, metaId, ... })
// together with what the page needs to filter, sort and convert it.

import { h, replace, nuclideNode, downloadText } from '../core/dom.js';
import * as jsonfmt from '../core/jsonfmt.js';
import { citeLabel, citeText, authorList, doiUrl, isPlaceholderDoi, referenceTitle } from '../core/cite.js';
import { formatQuantity, formatDerived, plainNumber, toCsv } from '../core/format.js';
import { OBSERVABLE_LABELS, UNIT_LABELS } from '../core/convert.js';
import { DATASETS, SUBLIBRARIES, SUBLIBRARY_SHORT, ELEMENT_NAMES } from './store.js';
import { renderPeriodicTable } from './ptable.js';
import { renderChart, selectInChart } from './chart.js';

const DATASET_TITLES = { EXP: 'Experimental', TH: 'Theoretical', CUR: 'Curated', EVAL: 'Evaluated' };
const DATASET_NOTES = {
  EXP: 'Values as published. Nothing is corrected or renormalised.',
  TH: 'Results of theoretical calculations.',
  CUR: 'Experimental values re-analysed on a common footing; each entry is traced back to its experimental data.',
  EVAL: 'Recommended values obtained by evaluating experimental and theoretical information.',
};

const QUANTITIES = {
  rate: { label: 'Capture rate', unit: 'µs⁻¹', key: 'capture_rate_us-1', observable: 'capture_rate', nativeUnit: 'us-1', log: true },
  life: { label: 'Lifetime', unit: 'ns', key: 'lifetime_ns', observable: 'lifetime', nativeUnit: 'ns', log: true },
  prob: { label: 'Capture probability', unit: '%', key: 'capture_probability_pct', observable: 'capture_probability', nativeUnit: '%', log: false },
};

const CSV_COLUMNS = ['datasetId', 'datasetType', 'element', 'z', 'mass', 'isomer', 'observable', 'value', 'uncertainty',
  'uncertaintyStatistical', 'uncertaintySystematic', 'unit', 'key', 'comment', 'originalData', 'metaId', 'bibId',
  'reference', 'facility', 'method', 'lifetime_ns', 'lifetime_ns_unc', 'capture_rate_us-1', 'capture_rate_us-1_unc',
  'capture_probability_pct', 'capture_probability_pct_unc', 'huff_factor'];

function readState(version) {
  const params = new URLSearchParams(location.search);
  const int = (name) => {
    const v = parseInt(params.get(name), 10);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };
  const lib = SUBLIBRARIES.includes(params.get('lib')) ? params.get('lib') : 'LT';
  const available = DATASETS.filter((d) => ((version.manifest.sublibraries[lib] || {}).counts || {})[d]);
  let ds = (params.get('ds') || '').split(',').filter((d) => DATASETS.includes(d));
  if (!ds.length) ds = available.length ? available : [...DATASETS];
  return {
    z: Math.min(int('z'), version.tables.elements.length),
    a: params.has('a') ? params.get('a') : '',
    lib,
    ds: new Set(ds),
    q: QUANTITIES[params.get('q')] ? params.get('q') : 'rate',
    id: params.get('id') || '',
  };
}

function stateUrl(state, version, versions) {
  const params = new URLSearchParams();
  if (state.z) params.set('z', String(state.z));
  if (state.a !== '') params.set('a', state.a);
  if (state.lib !== 'LT') params.set('lib', state.lib);
  const available = DATASETS.filter((d) => ((version.manifest.sublibraries[state.lib] || {}).counts || {})[d]);
  const ds = DATASETS.filter((d) => state.ds.has(d));
  if (ds.join() !== (available.length ? available : DATASETS).join()) params.set('ds', ds.join(','));
  if (state.q !== 'rate') params.set('q', state.q);
  if (version.label !== versions.default) params.set('v', version.label);
  if (state.id) params.set('id', state.id);
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ''}`;
}

/** Text of one cell: the quantity given in the source is shown as written and marked. */
function quantityCell(row, q) {
  const info = QUANTITIES[q];
  if (row.kind === info.observable) {
    const text = row.unit === info.nativeUnit
      ? formatQuantity(row.block).text
      : formatDerived(row.conv ? row.conv[info.key] : null, row.conv ? row.conv[`${info.key}_unc`] : null).text;
    return h('td', { class: 'num measured', title: 'Quantity given in the source' },
      h('span', { class: 'star', 'aria-label': 'given in the source' }, '★'), ' ', text);
  }
  if (!row.conv) return h('td', { class: 'num muted' }, '–');
  return h('td', { class: 'num' }, formatDerived(row.conv[info.key], row.conv[`${info.key}_unc`]).text);
}

function referenceLink(row) {
  const url = doiUrl(row.meta.bibId);
  const label = citeLabel(row.reference, row.meta.bibId);
  const title = citeText(row.reference, row.meta.bibId);
  return url
    ? h('a', { href: url, target: '_blank', rel: 'noopener', title, onclick: (e) => e.stopPropagation() }, label)
    : h('span', { title }, row.reference ? label : 'unpublished');
}

function component(block, source) {
  const u = (block.uncertainties || []).find((x) => x.source === source);
  return u ? jsonfmt.numberText(u, 'value') : '';
}

function csvRows(rows) {
  const out = [CSV_COLUMNS];
  for (const r of rows) {
    const c = r.conv || {};
    const total = component(r.block, 'total');
    const line = {
      datasetId: r.id, datasetType: r.entry.datasetType, element: r.element, z: r.z, mass: r.mass, isomer: r.isomer,
      observable: r.kind, value: jsonfmt.numberText(r.block, 'value'),
      uncertainty: r.unc === null ? '' : (total || plainNumber(r.unc)),
      uncertaintyStatistical: component(r.block, 'statistical'), uncertaintySystematic: component(r.block, 'systematic'),
      unit: r.unit, key: r.entry.key || '', comment: r.entry.comment || '',
      originalData: (r.entry.originalData || []).join(';'), metaId: r.metaId, bibId: r.meta.bibId || '',
      reference: citeText(r.reference, r.meta.bibId), facility: r.meta.facility || '', method: r.meta.method || '',
    };
    for (const k of CSV_COLUMNS.slice(CSV_COLUMNS.indexOf('lifetime_ns'))) line[k] = plainNumber(c[k]);
    out.push(CSV_COLUMNS.map((k) => line[k]));
  }
  return out;
}

export function renderExplorer(root, ctx) {
  const { version, versions, config } = ctx;
  const { tables } = version;
  let state = readState(version);

  const filtersEl = h('section', { class: 'filters card' });
  const ptableEl = h('section', { class: 'card ptable-card' });
  const chartEl = h('section', { class: 'card chart-card' });
  const headingEl = h('div', { class: 'element-heading' });
  const tablesEl = h('div', { class: 'stack' });
  const detailEl = h('aside', { class: 'detail', hidden: true, 'aria-label': 'Details of the selected data entry' });
  replace(root, filtersEl,
    h('div', { class: 'explorer-top' }, ptableEl, chartEl),
    headingEl, tablesEl, detailEl);

  const lib = () => version.libraries[state.lib];
  const libInfo = () => version.manifest.sublibraries[state.lib] || { status: 'planned', counts: {} };

  function setState(patch, { push = false } = {}) {
    state = { ...state, ...patch };
    const url = stateUrl(state, version, versions);
    if (push) history.pushState(null, '', url + location.hash);
    else history.replaceState(null, '', url + location.hash);
    render();
  }

  /** Rows of the current element / mass / dataset selection. */
  function selection() {
    const library = lib();
    if (!library) return [];
    return library.rows.filter((r) => (!state.z || r.z === state.z)
      && (state.a === '' || String(r.a) === state.a || (state.a === '0' && r.mass === 0))
      && state.ds.has(r.dataset));
  }

  function elementRows() {
    const library = lib();
    return library ? library.rows.filter((r) => !state.z || r.z === state.z) : [];
  }

  // ---- filters ------------------------------------------------------------
  function renderFilters() {
    const info = libInfo();
    const inElement = elementRows();
    const masses = [...new Set(inElement.map((r) => r.a))].sort((x, y) => x - y);
    replace(filtersEl,
      h('div', { class: 'filter' },
        h('span', { class: 'filter-label', id: 'f-lib' }, 'Sub-library'),
        h('div', { class: 'pills', role: 'radiogroup', 'aria-labelledby': 'f-lib' }, SUBLIBRARIES.map((s) => {
          const planned = (version.manifest.sublibraries[s] || {}).status !== 'available';
          return h('button', {
            class: 'pill', role: 'radio', 'aria-checked': String(state.lib === s),
            title: (version.manifest.sublibraries[s] || {}).title,
            onclick: () => setState({ lib: s, a: '', id: '' }),
          }, `${SUBLIBRARY_SHORT[s]} (${s})`, planned ? h('span', { class: 'count' }, 'planned') : null);
        }))),
      h('div', { class: 'filter' },
        h('span', { class: 'filter-label', id: 'f-ds' }, 'Data'),
        h('div', { class: 'pills', role: 'group', 'aria-labelledby': 'f-ds' }, DATASETS.map((d) => {
          const n = inElement.filter((r) => r.dataset === d).length;
          return h('button', {
            class: 'pill', 'aria-pressed': String(state.ds.has(d)), title: DATASET_NOTES[d],
            onclick: () => {
              const ds = new Set(state.ds);
              if (ds.has(d)) ds.delete(d); else ds.add(d);
              setState({ ds });
            },
          }, h('i', { class: `ds-dot ${d}` }), DATASET_TITLES[d], h('span', { class: 'count' }, String(n)));
        }))),
      state.z && masses.length ? h('div', { class: 'filter' },
        h('label', { class: 'filter-label', for: 'f-a' }, 'Mass number'),
        h('select', {
          id: 'f-a', value: state.a,
          onchange: (e) => setState({ a: e.target.value, id: '' }),
        }, h('option', { value: '' }, 'All'),
        masses.map((a) => h('option', { value: String(a), selected: state.a === String(a) },
          a ? String(a) : 'natural')))) : null,
      info.status === 'available' ? null
        : h('p', { class: 'notice small', style: { margin: '0', flexBasis: '100%' } },
          `${info.title || state.lib}: this sub-library is being prepared. No data are available yet.`));
  }

  // ---- periodic table ---------------------------------------------------------
  function renderPtable() {
    const counts = new Map();
    for (const r of (lib() ? lib().rows : [])) {
      if (!counts.has(r.z)) counts.set(r.z, {});
      const c = counts.get(r.z);
      c[r.dataset] = (c[r.dataset] || 0) + 1;
    }
    const link = (z) => stateUrl({ ...state, z, a: '', id: '' }, version, versions);
    replace(ptableEl,
      h('div', { class: 'card-head' },
        h('h2', null, 'Element'),
        h('a', {
          class: 'btn small', href: link(0), 'aria-current': state.z ? null : 'true',
          onclick: (e) => { e.preventDefault(); setState({ z: 0, a: '', id: '' }, { push: true }); },
        }, 'All elements')),
      h('div', { class: 'card-body' },
        renderPeriodicTable({
          elements: tables.elements, names: ELEMENT_NAMES, counts, selected: state.z, href: link,
          onSelect: (z) => setState({ z, a: '', id: '' }, { push: true }),
        }),
        h('p', { class: 'ptable-key small muted' }, 'Marks show which data exist: ',
          DATASETS.map((d) => h('span', { class: 'nowrap' }, h('i', { class: `ds-dot ${d}` }), ` ${DATASET_TITLES[d]}  `)))));
  }

  // ---- chart --------------------------------------------------------------------
  function tooltip(point) {
    const row = point.data;
    const info = QUANTITIES[state.q];
    const value = row.conv ? formatDerived(row.conv[info.key], row.conv[`${info.key}_unc`]).text : '';
    return h('div', null,
      h('div', { class: 'tip-value' }, `${value} ${info.unit}`),
      h('div', { class: 'tip-name' }, nuclideNode(row.element, row.a), ` · ${DATASET_TITLES[row.dataset]}`),
      h('div', { class: 'tip-ref muted' }, citeText(row.reference, row.meta.bibId)));
  }

  function renderChartCard() {
    const info = QUANTITIES[state.q];
    const rows = selection();
    const body = h('div', { class: 'card-body' });
    const picker = h('div', { class: 'pills', role: 'radiogroup', 'aria-label': 'Quantity shown in the chart' },
      Object.entries(QUANTITIES).map(([key, q]) => h('button', {
        class: 'pill', role: 'radio', 'aria-checked': String(state.q === key), onclick: () => setState({ q: key }),
      }, q.label)));
    const title = state.z
      ? `${info.label} of muonic ${ELEMENT_NAMES[state.z - 1].toLowerCase()} by isotope`
      : `${info.label} across the elements`;
    replace(chartEl, h('div', { class: 'card-head' }, h('h2', null, title), picker), body);
    if (libInfo().status !== 'available') {
      body.appendChild(h('p', { class: 'muted' }, 'No data to plot.'));
      return;
    }
    const point = (r, x) => {
      const y = r.conv ? r.conv[info.key] : NaN;
      const u = r.conv ? r.conv[`${info.key}_unc`] : null;
      return { x, y, lo: u === null ? NaN : y - u, hi: u === null ? NaN : y + u, data: r };
    };
    const holder = h('div');
    body.appendChild(holder);
    const common = {
      tooltip,
      onSelect: (p) => (state.z ? setState({ id: p.data.id }) : setState({ z: p.data.z, a: '', id: '' }, { push: true })),
      selected: (p) => p.data.id === state.id,
      keyOf: (p) => p.data.id,
      emptyText: 'No data for this selection.',
    };
    if (state.z) {
      const masses = [...new Set(rows.map((r) => r.a))].sort((x, y) => x - y);
      const symbol = tables.elements[state.z - 1];
      renderChart(holder, {
        ...common,
        series: DATASETS.map((d) => ({
          key: d, label: DATASET_TITLES[d], points: rows.filter((r) => r.dataset === d).map((r) => point(r, r.a)),
        })),
        x: {
          type: 'band', label: 'Nuclide',
          bands: masses.map((a) => ({
            key: a, label: a ? `${a}${symbol}` : `nat${symbol}`,
            node: [() => h('tspan', { 'baseline-shift': 'super', 'font-size': '9' }, a ? String(a) : 'nat'),
              () => h('tspan', null, symbol)],
          })),
        },
        y: { label: `${info.label} (${info.unit})`, log: false },
      });
    } else {
      const zs = (lib() ? lib().rows : []).map((r) => r.z);
      renderChart(holder, {
        ...common,
        series: DATASETS.map((d) => ({
          key: d, label: DATASET_TITLES[d], context: d === 'EVAL',
          points: rows.filter((r) => r.dataset === d).map((r) => point(r, r.z)),
        })),
        x: { type: 'linear', label: 'Atomic number Z', domain: [0, Math.max(10, ...zs) + 2] },
        y: { label: `${info.label} (${info.unit})`, log: info.log },
      });
      body.appendChild(h('p', { class: 'small muted', style: { margin: '6px 0 0' } },
        'Click a point or an element to see its data. ',
        info.log ? 'Logarithmic scale; error bars are omitted for the evaluated values.' : ''));
    }
  }

  // ---- tables ---------------------------------------------------------------------
  function renderHeading() {
    const rows = selection();
    const name = state.z ? `${ELEMENT_NAMES[state.z - 1]} (Z = ${state.z})` : 'All elements';
    replace(headingEl,
      h('h1', null, state.z ? h('span', { class: 'element-symbol' }, tables.elements[state.z - 1]) : null, name),
      h('p', { class: 'muted' }, `${(version.manifest.sublibraries[state.lib] || {}).title || state.lib} · `
        + `${rows.length} data entr${rows.length === 1 ? 'y' : 'ies'} in the current selection · `
        + '★ marks the quantity given in the source; the other columns are converted (see Converter).'));
  }

  function renderTables() {
    const rows = selection();
    const sections = [];
    for (const d of DATASETS) {
      if (!state.ds.has(d)) continue;
      const subset = rows.filter((r) => r.dataset === d);
      const fileStem = `mund_${state.lib}_${d}_${state.z ? tables.elements[state.z - 1] : 'all'}`;
      const head = h('div', { class: 'card-head' },
        h('div', null,
          h('h2', null, h('i', { class: `ds-dot ${d}` }), ` ${DATASET_TITLES[d]} data `,
            h('span', { class: 'tag' }, String(subset.length))),
          h('p', { class: 'small muted', style: { margin: '2px 0 0' } }, DATASET_NOTES[d])),
        subset.length ? h('div', { class: 'row no-print' },
          h('button', {
            class: 'btn small', onclick: () => downloadText(`${fileStem}.csv`, toCsv(csvRows(subset)), 'text/csv'),
          }, 'Download CSV'),
          h('button', {
            class: 'btn small',
            onclick: () => downloadText(`${fileStem}.json`, jsonfmt.stringify(subset.map((r) => r.entry)), 'application/json'),
          }, 'JSON')) : null);
      let body;
      if (!subset.length) {
        body = h('div', { class: 'card-body' }, h('p', { class: 'muted', style: { margin: 0 } },
          libInfo().status === 'available' ? 'No data for this selection.' : 'This sub-library has no data yet.'));
      } else {
        const exp = d === 'EXP';
        body = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', null, h('tr', null,
            h('th', null, 'Nuclide'),
            h('th', { class: 'num' }, 'Lifetime (ns)'),
            h('th', { class: 'num' }, 'Capture rate (µs⁻¹)'),
            h('th', { class: 'num' }, 'Capture prob. (%)'),
            exp ? h('th', null, 'Facility') : null,
            exp ? h('th', null, 'Method') : null,
            h('th', null, 'Note'),
            h('th', null, 'Reference'))),
          h('tbody', null, subset.map((r) => h('tr', {
            class: 'selectable', tabindex: '0', 'aria-selected': String(r.id === state.id), dataset: { id: r.id },
            onclick: () => setState({ id: r.id === state.id ? '' : r.id }),
            onkeydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setState({ id: r.id }); }
            },
          },
          h('td', { class: 'nowrap' }, nuclideNode(r.element, r.a),
            r.mass === 0 && r.a ? h('span', { class: 'muted small', title: 'Target of natural abundance' }, ' nat') : null,
            r.isomer ? h('span', { class: 'muted small' }, ` m${r.isomer}`) : null),
          quantityCell(r, 'life'), quantityCell(r, 'rate'), quantityCell(r, 'prob'),
          exp ? h('td', null, r.meta.facility || '') : null,
          exp ? h('td', null, r.meta.method || '') : null,
          h('td', { class: 'small' }, [r.entry.key ? h('span', { class: 'tag' }, r.entry.key) : null,
            r.entry.key && r.entry.comment ? ' ' : null, r.entry.comment || '']),
          h('td', { class: 'nowrap' }, referenceLink(r)))))));
      }
      sections.push(h('section', { class: 'card' }, head, body));
    }
    if (!sections.length) {
      sections.push(h('p', { class: 'notice' }, 'Choose at least one kind of data (Experimental, Theoretical, Curated, Evaluated).'));
    }
    replace(tablesEl, sections);
  }

  // ---- detail panel -----------------------------------------------------------------
  function renderDetail() {
    const library = lib();
    const row = state.id && library ? library.byId.get(state.id) : null;
    document.body.classList.toggle('has-detail', Boolean(row));
    if (!row) {
      detailEl.hidden = true;
      replace(detailEl);
      return;
    }
    const m = row.meta;
    const ref = row.reference;
    const conv = row.conv;
    const { entry, block } = row;
    const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter((p) => p && p[1] !== null && p[1] !== undefined && p[1] !== '')
      .map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
    const idLink = (id) => {
      const target = library.byId.get(id);
      return h('li', null,
        h('a', { href: stateUrl({ ...state, id }, version, versions), onclick: (e) => { e.preventDefault(); setState({ id }); } },
          h('code', null, id)),
        target ? [' ', nuclideNode(target.element, target.a), ` ${formatQuantity(target.block).text} ${UNIT_LABELS[target.unit]}`,
          ` · ${citeLabel(target.reference, target.meta.bibId)}`] : ' (not in this version)');
    };
    const usedBy = library.usedBy.get(row.id) || [];
    const fileUrl = ctx.siteUrl(`${version.root}raw/${m.file}`);
    const historyUrl = `https://github.com/${config.repository}/commits/${config.branch}/data/${m.file}`;
    const url = doiUrl(m.bibId);
    const huffSource = { nuclide: 'for this nuclide', element: 'element average', none: 'no tabulated value; Q = 1 assumed' }[
      version.physics.huffSource(row.z, row.mass)];
    const uncertainties = block.uncertainties || [];
    const separate = uncertainties.some((u) => u.source !== 'total');

    replace(detailEl,
      h('div', { class: 'detail-head' },
        h('h2', null, nuclideNode(row.element, row.a), ` · ${DATASET_TITLES[row.dataset]}`),
        h('button', { class: 'btn small ghost', 'aria-label': 'Close details', onclick: () => setState({ id: '' }) }, '✕')),
      h('div', { class: 'detail-body' },
        h('h3', null, 'Value'),
        kv([
          ['Given in the source', h('strong', null, `${OBSERVABLE_LABELS[row.kind]}: ${formatQuantity(block).text} ${UNIT_LABELS[row.unit]}`)],
          row.unc === null ? ['Uncertainty', 'not given in the source'] : null,
          separate && row.unc !== null ? ['Combined uncertainty', `± ${formatDerived(block.value, row.unc).uncertainty} ${UNIT_LABELS[row.unit]}`
            + (uncertainties.some((u) => u.source === 'total') ? '' : ' (components added in quadrature)')] : null,
          uncertainties.some((u) => u.description) ? ['Uncertainty notes',
            uncertainties.filter((u) => u.description).map((u) => `${u.source}: ${u.description}`).join('; ')] : null,
          block.huffFactor !== undefined ? ['Huff factor used in the source', String(block.huffFactor)] : null,
          row.mass === 0 ? ['Target', 'natural isotopic abundance'] : null,
          row.isomer ? ['Isomer', String(row.isomer)] : null,
          entry.key ? ['Key', entry.key] : null,
          entry.comment ? ['Comment', entry.comment] : null,
        ]),
        h('h3', null, 'Converted'),
        conv ? kv([
          ['Lifetime', `${formatDerived(conv.lifetime_ns, conv.lifetime_ns_unc).text} ns`],
          ['Capture rate', `${formatDerived(conv['capture_rate_us-1'], conv['capture_rate_us-1_unc']).text} µs⁻¹`],
          ['Capture probability', `${formatDerived(conv.capture_probability_pct, conv.capture_probability_pct_unc).text} %`],
          ['Huff factor Q', `${conv.huff_factor} (${huffSource})`],
        ]) : h('p', { class: 'muted' }, 'This value cannot be converted.'),
        entry.originalData ? [h('h3', null, 'Derived from'), h('ul', { class: 'id-list' }, entry.originalData.map(idLink))] : null,
        usedBy.length ? [h('h3', null, 'Used by'), h('ul', { class: 'id-list' }, usedBy.map((r) => idLink(r.id)))] : null,
        row.dataset === 'EXP' ? [h('h3', null, 'Experimental conditions'), kv([
          ['Facility', m.facility ? `${m.facility}${version.tables.facilities.get(m.facility) ? ` — ${version.tables.facilities.get(m.facility).detail}` : ''}` : ''],
          ['Method', m.method], ['Beam', m.beam], ['Target', m.target], ['Detector', m.detector], ['Comment', m.comment],
        ])] : (m.method || m.comment || m.referenceDatabase ? [h('h3', null, 'How the values were obtained'),
          kv([['Method', m.method], ['Reference database', m.referenceDatabase], ['Comment', m.comment]])] : null),
        h('h3', null, 'Reference'),
        kv([
          ['Citation', ref ? citeText(ref, m.bibId) : (isPlaceholderDoi(m.bibId) ? 'Not published yet' : '')],
          ['Title', referenceTitle(ref)],
          ['Authors', authorList(ref)],
          ['DOI', url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, m.bibId) : `${m.bibId} (placeholder: no public DOI)`],
          m.relatedBibIds ? ['Related', h('span', null, m.relatedBibIds.map((d, i) => [i ? ', ' : '',
            doiUrl(d) ? h('a', { href: doiUrl(d), target: '_blank', rel: 'noopener' }, d) : d]))] : null,
        ]),
        h('h3', null, 'Identifiers'),
        kv([
          ['datasetId', h('code', null, row.id)],
          ['MetaID', h('code', null, row.metaId)],
          entry.legacyIds ? ['Former IDs', h('code', null, entry.legacyIds.join(', '))] : null,
          ['Source file', h('span', null, h('a', { href: fileUrl, target: '_blank', rel: 'noopener' }, m.file), ' · ',
            h('a', { href: historyUrl, target: '_blank', rel: 'noopener' }, 'change history'))],
          ['Data version', `${version.manifest.version} (${version.label})`],
        ]),
        h('details', null, h('summary', null, 'Entry as published (JSON)'),
          h('pre', { class: 'code' }, jsonfmt.stringify(entry)))));
    detailEl.hidden = false;
  }

  function markSelection() {
    for (const tr of tablesEl.querySelectorAll('tr[data-id]')) {
      tr.setAttribute('aria-selected', String(tr.dataset.id === state.id));
    }
  }

  let last = {};
  function render() {
    const key = JSON.stringify([state.z, state.a, state.lib, [...state.ds], state.q]);
    if (key !== last.key) {
      renderFilters();
      renderPtable();
      renderHeading();
      renderTables();
    } else {
      markSelection();
    }
    if (key !== last.key) renderChartCard();
    else if (state.id !== last.id) selectInChart(chartEl, state.id);
    renderDetail();
    last = { key, id: state.id };
    document.title = `${state.z ? `${tables.elements[state.z - 1]} – ` : ''}muND explorer`;
  }

  const onKey = (e) => { if (e.key === 'Escape' && state.id) setState({ id: '' }); };
  const onPop = () => { state = readState(version); last = {}; render(); };
  document.addEventListener('keydown', onKey);
  window.addEventListener('popstate', onPop);
  render();
  if (state.id) {
    const tr = tablesEl.querySelector(`tr[data-id="${CSS.escape(state.id)}"]`);
    if (tr) tr.scrollIntoView({ block: 'center' });
  }
  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', onPop);
    document.body.classList.remove('has-detail');
  };
}
