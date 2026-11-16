// Converter, Downloads and About pages.

import { h, replace, nuclideNode } from '../core/dom.js';
import { formatDerived } from '../core/format.js';
import { isNumberLexeme } from '../core/jsonfmt.js';
import { ELEMENT_NAMES, DATASETS, SUBLIBRARIES } from './store.js';

// ---------------------------------------------------------------------------
// Converter (port of the "Muon Lifetime Converter" of the previous explorer)
// ---------------------------------------------------------------------------

const MODES = {
  lifetime: { label: 'Lifetime', unit: 'ns', value: '756.0', unc: '1.0' },
  capture_rate: { label: 'Capture rate', unit: 'us-1', value: '0.8710', unc: '0.0018' },
  capture_probability: { label: 'Capture probability', unit: '%', value: '65.8', unc: '0.1' },
};
const UNIT_TEXT = { ns: 'ns', 'us-1': 'µs⁻¹', '%': '%' };

export function renderConverter(root, ctx) {
  const { version } = ctx;
  const { tables, physics } = version;
  const params = new URLSearchParams(location.search);
  const state = {
    z: Math.min(Math.max(parseInt(params.get('z'), 10) || 14, 1), tables.elements.length),
    mode: 'lifetime', value: MODES.lifetime.value, unc: MODES.lifetime.unc, custom: false, q: '1.0000',
  };
  const form = h('div', { class: 'card' });
  const result = h('div', { class: 'card' });

  function renderForm() {
    const mode = MODES[state.mode];
    replace(form,
      h('div', { class: 'card-head' }, h('h2', null, 'Input')),
      h('div', { class: 'card-body form-grid' },
        h('div', null, h('label', { for: 'c-el' }, 'Element'),
          h('select', { id: 'c-el', onchange: (e) => { state.z = Number(e.target.value); renderResult(); } },
            tables.elements.map((symbol, i) => h('option', { value: String(i + 1), selected: state.z === i + 1 },
              `${i + 1}  ${symbol}  ${ELEMENT_NAMES[i]}`)))),
        h('div', null, h('span', { class: 'filter-label', id: 'c-mode' }, 'Quantity you have'),
          h('div', { class: 'pills', role: 'radiogroup', 'aria-labelledby': 'c-mode' },
            Object.entries(MODES).map(([key, m]) => h('button', {
              class: 'pill', role: 'radio', 'aria-checked': String(state.mode === key),
              onclick: () => { Object.assign(state, { mode: key, value: m.value, unc: m.unc }); renderForm(); renderResult(); },
            }, m.label)))),
        h('div', null, h('label', { for: 'c-val' }, `${mode.label} (${UNIT_TEXT[mode.unit]})`),
          h('input', { id: 'c-val', type: 'text', inputmode: 'decimal', value: state.value,
            oninput: (e) => { state.value = e.target.value; renderResult(); } })),
        h('div', null, h('label', { for: 'c-unc' }, `Uncertainty (${UNIT_TEXT[mode.unit]})`),
          h('input', { id: 'c-unc', type: 'text', inputmode: 'decimal', value: state.unc,
            oninput: (e) => { state.unc = e.target.value; renderResult(); } })),
        h('div', null,
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: state.custom,
              onchange: (e) => { state.custom = e.target.checked; renderForm(); renderResult(); } }),
            ' Use my own Huff factor'),
          state.custom ? h('input', { type: 'text', inputmode: 'decimal', value: state.q, 'aria-label': 'Huff factor Q',
            oninput: (e) => { state.q = e.target.value; renderResult(); } }) : null)));
  }

  function renderResult() {
    const mode = MODES[state.mode];
    const value = isNumberLexeme(state.value.trim()) ? Number(state.value) : NaN;
    const uncText = state.unc.trim();
    const unc = uncText === '' ? null : (isNumberLexeme(uncText) ? Number(uncText) : NaN);
    const head = h('div', { class: 'card-head' }, h('h2', null, 'Result'));
    if (!Number.isFinite(value) || Number.isNaN(unc)) {
      replace(result, head, h('div', { class: 'card-body' }, h('p', { class: 'notice warn' }, 'Enter numbers, e.g. 756.0 and 1.0.')));
      return;
    }
    const symbol = tables.elements[state.z - 1];
    const range = tables.ranges.get(state.z);
    const mono = tables.monoisotopic.get(state.z);
    const masses = [];
    if (state.custom) masses.push({ label: 'Own Q', a: 0, q: Number(state.q) });
    if (!mono) masses.push({ a: 0 });
    if (range) for (let a = range[0]; a <= range[1]; a++) masses.push({ a });
    else if (mono) masses.push({ a: mono });
    const rows = masses.map((m) => {
      const q = m.q !== undefined && Number.isFinite(m.q) ? m.q : undefined;
      const c = physics.convert(state.z, m.a, state.mode, value, unc, mode.unit, q);
      const emphasised = m.label || (!state.custom && (m.a === 0 || m.a === mono));
      return h('tr', { class: emphasised ? 'emph' : null },
        h('td', null, m.label || nuclideNode(symbol, m.a)),
        h('td', { class: 'num' }, c ? c.huff_factor.toFixed(4) : '–'),
        h('td', { class: 'num' }, c ? formatDerived(c.lifetime_ns, c.lifetime_ns_unc).text : '–'),
        h('td', { class: 'num' }, c ? formatDerived(c['capture_rate_us-1'], c['capture_rate_us-1_unc']).text : '–'),
        h('td', { class: 'num' }, c ? formatDerived(c.capture_probability_pct, c.capture_probability_pct_unc).text : '–'));
    });
    replace(result, head, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Nuclide'), h('th', { class: 'num' }, 'Huff factor Q'),
        h('th', { class: 'num' }, 'Lifetime (ns)'), h('th', { class: 'num' }, 'Capture rate (µs⁻¹)'),
        h('th', { class: 'num' }, 'Capture prob. (%)'))),
      h('tbody', null, rows))),
    h('div', { class: 'card-body small muted' },
      'The Huff factor depends slightly on the isotope, so the conversion is listed for each of them. ',
      'The row for the natural element uses the element average.'));
  }

  replace(root,
    h('h1', null, 'Muon lifetime converter'),
    h('div', { class: 'prose' },
      h('p', null, 'The total lifetime of a muonic atom ', h('i', null, 'τ'), ' and the nuclear capture rate ',
        h('i', null, 'Λ'), h('sub', null, 'cap'), ' are related by'),
      h('p', { class: 'formula' }, '1 / τ  =  Λ', h('sub', null, 'cap'), '  +  Q / τ', h('sub', null, 'μ⁺')),
      h('p', null, 'where Q is the Huff factor (the decay rate of the bound muon is slightly lower than that of the free muon) and τ',
        h('sub', null, 'μ⁺'), ` = ${physics.muLifeNs} ns is the lifetime of the free positive muon. `,
        'The capture probability is the fraction of muons that are captured:'),
      h('p', { class: 'formula' }, 'P', h('sub', null, 'cap'), '  =  Λ', h('sub', null, 'cap'), ' / ( Λ', h('sub', null, 'cap'),
        ' + Q / τ', h('sub', null, 'μ⁺'), ' )'),
      h('p', { class: 'muted small' }, 'Uncertainties are propagated to first order; those of Q and τ',
        h('sub', null, 'μ⁺'), ' are neglected. The explorer uses the same conversion for every table and chart.')),
    h('div', { class: 'converter' }, form, result));
  renderForm();
  renderResult();
  document.title = 'Converter – muND';
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

function bytes(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

export function renderDownloads(root, ctx) {
  const { version, versions, config } = ctx;
  const m = version.manifest;
  const url = (path) => ctx.siteUrl(`${version.root}${path}`);
  const repo = `https://github.com/${config.repository}`;
  const fileRow = (f, note) => h('tr', null,
    h('td', null, h('a', { href: url(f.path) }, f.path)),
    h('td', { class: 'num' }, bytes(f.bytes)),
    h('td', { class: 'small muted' }, note || ''));
  const dist = m.files.filter((f) => !f.path.startsWith('raw/'));
  const raw = m.files.filter((f) => f.path.startsWith('raw/'));
  const notes = {
    'master.json': 'Facilities, nuclides, Huff factors and constants in one file',
    'csv/LT.csv': 'All LT data with converted quantities',
  };

  replace(root,
    h('h1', null, 'Downloads'),
    h('div', { class: 'prose' },
      h('p', null, 'All data are plain text files (JSON and CSV) kept under version control. ',
        'Released versions never change, so a calculation that used one can always be repeated; ',
        h('em', null, 'latest'), ' follows the day-to-day work of the compilers.')),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Versions')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Version'), h('th', null, 'Kind'), h('th', null, 'Date'),
          h('th', null, 'Commit'), h('th', null, ''))),
        h('tbody', null, versions.versions.map((v) => h('tr', { 'aria-selected': String(v.label === version.label) },
          h('td', null, h('strong', null, v.label === 'latest' ? 'latest' : `v${v.version}`),
            v.label === 'latest' ? h('span', { class: 'muted small' }, ` ${v.version}`) : null),
          h('td', null, v.kind === 'release' ? 'Release (fixed)' : 'Development snapshot'),
          h('td', { class: 'nowrap' }, v.date ? v.date.slice(0, 10) : '–'),
          h('td', null, v.commit ? h('a', { href: `${repo}/commit/${v.commit}`, target: '_blank', rel: 'noopener' },
            h('code', null, v.commit.slice(0, 7))) : '–'),
          h('td', null, v.label === version.label ? h('span', { class: 'tag' }, 'shown below')
            : h('a', { href: ctx.versionUrl(v.label) }, 'show'))))))),
      h('div', { class: 'card-body small muted' },
        versions.versions.some((v) => v.kind === 'release') ? null
          : 'No version has been released yet. Until the first release the data may change without notice. ',
        h('a', { href: `${repo}/commits/${config.branch}/data`, target: '_blank', rel: 'noopener' }, 'Full history of changes'),
        ' · ', h('a', { href: `${repo}/blob/${config.branch}/CHANGELOG.md`, target: '_blank', rel: 'noopener' }, 'Change log'))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', null, `Files of ${version.label === 'latest' ? 'latest' : `v${m.version}`}`),
        h('a', { class: 'btn primary', href: url(m.archive.path) }, `Download everything (.zip, ${bytes(m.archive.bytes)})`)),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'File'), h('th', { class: 'num' }, 'Size'), h('th', null, ''))),
        h('tbody', null,
          h('tr', null, h('td', null, h('a', { href: url('manifest.json') }, 'manifest.json')), h('td', { class: 'num' }, ''),
            h('td', { class: 'small muted' }, 'List of the files below with SHA-256 checksums')),
          dist.map((f) => fileRow(f, notes[f.path] || (/^[A-Z]+\.json$/.test(f.path) ? 'All data of the sub-library in one file' : ''))),
          raw.map((f) => fileRow(f, f.path.startsWith('raw/master/') ? 'Master table' : 'Source file, exactly as stored in the repository'))))),
      h('div', { class: 'card-body small muted' }, 'File formats: ',
        h('a', { href: ctx.siteUrl('schema/v1/lt.schema.json') }, 'JSON Schema of the LT files'), ' · ',
        h('a', { href: `${repo}/blob/${config.branch}/docs/data-format.md`, target: '_blank', rel: 'noopener' }, 'description of the format'),
        ' · ', h('a', { href: `${repo}/blob/${config.branch}/docs/id-definition.md`, target: '_blank', rel: 'noopener' }, 'definition of the identifiers'))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Use in programs')),
      h('div', { class: 'card-body prose' },
        h('p', null, 'The address of every file is stable. Replace ', h('code', null, version.label),
          ' by the version you want to pin (for example ', h('code', null, 'v1'), ').'),
        h('pre', { class: 'code' }, `import pandas as pd\n\nlt = pd.read_csv("${url('csv/LT.csv')}")\n`
          + 'evaluated = lt[lt.dataset == "EVAL"]'),
        h('h3', null, 'How to cite'),
        h('p', null, 'Please cite the data version you used (shown at the top of this page) together with the project paper: ',
          config.paper ? h('a', { href: config.paper.url, target: '_blank', rel: 'noopener' }, config.paper.text) : null,
          '. Individual values should be cited with their original reference, given with every data point.'),
        h('h3', null, 'Licence'),
        h('p', null, 'The licence of the data has not been fixed yet. Until it is, please contact the project before redistributing the data. ',
          'The software of this site is available under the MIT licence.'))));
  document.title = 'Downloads – muND';
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

export function renderAbout(root, ctx) {
  const { version, config } = ctx;
  const repo = `https://github.com/${config.repository}`;
  const subs = version.manifest.sublibraries;
  const dsNotes = {
    EXP: 'Experimental data, as reported in the literature.',
    TH: 'Data calculated with theoretical models.',
    CUR: 'Curated data: existing experimental data re-analysed in a uniform way (for example with a common muon lifetime and Huff factor). Every curated value lists the experimental values it was derived from.',
    EVAL: 'Evaluated data: recommended values based on experiment and theory.',
  };
  replace(root,
    h('h1', null, 'About muon nuclear data'),
    h('div', { class: 'prose' },
      h('p', null, 'The Muon Nuclear Data (μND) project compiles and evaluates data on the interaction of negative muons with nuclei: ',
        'when a negative muon stops in matter it forms a muonic atom, cascades to the 1s orbit by emitting muonic X-rays, ',
        'and then either decays or is captured by the nucleus. The captured muon leaves a highly excited nucleus that emits particles and γ rays.'),
      h('p', null, 'This site is the explorer of the database. The project is described on the ',
        config.project_url ? h('a', { href: config.project_url }, 'project page') : 'project page',
        config.paper ? [' and in ', h('a', { href: config.paper.url, target: '_blank', rel: 'noopener' }, config.paper.text)] : null, '.')),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Four sub-libraries')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Content'), h('th', null, 'Status'),
          DATASETS.map((d) => h('th', { class: 'num' }, d)))),
        h('tbody', null, SUBLIBRARIES.map((s) => h('tr', null,
          h('td', null, h('strong', null, s)),
          h('td', null, subs[s].title),
          h('td', null, subs[s].status === 'available' ? 'Available' : 'In preparation'),
          DATASETS.map((d) => h('td', { class: 'num' }, subs[s].status === 'available' ? String(subs[s].counts[d] || 0) : '–')))))))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Four kinds of data')),
      h('div', { class: 'card-body' }, h('dl', { class: 'kv' }, DATASETS.map((d) => [
        h('dt', null, h('i', { class: `ds-dot ${d}` }), ` ${d}`), h('dd', null, dsNotes[d])])))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'How the database is kept')),
      h('div', { class: 'card-body prose' },
        h('ul', null,
          h('li', null, 'Every publication is one text file in a ', h('a', { href: repo, target: '_blank', rel: 'noopener' }, 'git repository'),
            '. Each change is recorded with its author, date and reason.'),
          h('li', null, 'Every data point and every reference has a permanent identifier that is computed from what it describes ',
            '(sub-library, kind of data, nuclide, reference), never from the value. Correcting a number keeps its identifier.'),
          h('li', null, 'Each change is checked automatically against the ', h('a', { href: ctx.siteUrl('schema/v1/lt.schema.json') }, 'data format'),
            ' before it is published. ', h('a', { href: ctx.siteUrl('tests/') }, 'Self-test of this site'), '.'),
          h('li', null, 'Released versions are frozen. See ', h('a', { href: '#/downloads' }, 'Downloads'), '.')),
        h('p', { class: 'small muted' }, 'Compilers: ', h('a', { href: ctx.siteUrl('admin/') }, 'data entry tool'), '.'))));
  document.title = 'About – muND';
}
