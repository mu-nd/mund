// The converter between lifetime, capture rate and capture probability (tools/converter/).

import { h, replace, cardHead, nuclideNode, pageHeading, segSwitch } from '../core/dom.js';
import { formatDerived } from '../core/format.js';
import { isNumberLexeme } from '../core/jsonfmt.js';
import { QUANTITIES, UNIT_LABELS, isHuffFactor } from '../core/convert.js';
import { elementLabel } from '../core/vocabulary.js';
import { query } from './route.js';

const QUANTITY_NAMES = Object.keys(QUANTITIES);
const unitText = (name) => UNIT_LABELS[QUANTITIES[name].unit];
/** Values the form starts with (silicon). */
const EXAMPLES = {
  lifetime: { value: '756.0', unc: '1.0' },
  capture_rate: { value: '0.8710', unc: '0.0018' },
  capture_probability: { value: '65.8', unc: '0.1' },
};

export function renderConverter(root, ctx) {
  const { version, versionChoice = null } = ctx;
  const { tables, physics } = version;
  const z = parseInt(query().get('z'), 10);     // the element chosen in the explorer, if any
  const state = {
    z: z > 0 && z <= tables.elements.length ? z : 14,
    mode: 'lifetime', ...EXAMPLES.lifetime, custom: false, q: '1.0000',
  };
  const form = h('div', { class: 'card' });
  const result = h('div', { class: 'card' });

  function renderForm() {
    replace(form,
      cardHead('Input'),
      h('div', { class: 'card-body form-grid' },
        h('div', null, h('label', { for: 'c-el' }, 'Element'),
          h('select', { id: 'c-el', onchange: (e) => { state.z = Number(e.target.value); renderResult(); } },
            tables.elements.map((symbol, i) => h('option', { value: String(i + 1), selected: state.z === i + 1 },
              elementLabel(i + 1, symbol))))),
        h('div', null, h('label', null, 'Quantity you have'),    // the same look as the labels of the other fields
          segSwitch('Quantity you have', QUANTITY_NAMES.map((name) => ({ value: name, text: QUANTITIES[name].label })), state.mode,
            (name) => { Object.assign(state, { mode: name }, EXAMPLES[name]); renderForm(); renderResult(); })),
        h('div', null, h('label', { for: 'c-val' }, `${QUANTITIES[state.mode].label} (${unitText(state.mode)})`),
          h('input', { id: 'c-val', type: 'text', inputmode: 'decimal', value: state.value,
            oninput: (e) => { state.value = e.target.value; renderResult(); } })),
        h('div', null, h('label', { for: 'c-unc' }, `Uncertainty (${unitText(state.mode)})`),
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
    const value = isNumberLexeme(state.value.trim()) ? Number(state.value) : NaN;
    const uncText = state.unc.trim();
    const unc = uncText === '' ? null : (isNumberLexeme(uncText) ? Number(uncText) : NaN);
    const head = cardHead('Result');
    if (!Number.isFinite(value) || Number.isNaN(unc)) {
      replace(result, head, h('div', { class: 'card-body' }, h('p', { class: 'notice warn' }, 'Enter numbers, e.g. 756.0 and 1.0.')));
      return;
    }
    // a Huff factor of one's own is used as typed or not at all - never replaced by the table value
    const ownQ = isNumberLexeme(state.q.trim()) ? Number(state.q) : NaN;
    if (state.custom && !isHuffFactor(ownQ)) {
      replace(result, head, h('div', { class: 'card-body' }, h('p', { class: 'notice warn' },
        'Enter a Huff factor Q between 0 and 1, e.g. 0.9924.')));
      return;
    }
    const symbol = tables.elements[state.z - 1];
    const range = tables.ranges.get(state.z);
    const mono = tables.monoisotopic.get(state.z);
    const masses = [];
    if (state.custom) masses.push({ label: 'Own Q', a: 0, q: ownQ });
    if (!mono) masses.push({ a: 0 });
    if (range) for (let a = range[0]; a <= range[1]; a++) masses.push({ a });
    else if (mono) masses.push({ a: mono });
    const rows = masses.map((m) => {
      const c = physics.convert(state.z, m.a, state.mode, value, unc, QUANTITIES[state.mode].unit, m.q);
      const emphasised = m.label || (!state.custom && (m.a === 0 || m.a === mono));
      return h('tr', { class: emphasised ? 'emph' : null },
        h('td', null, m.label || nuclideNode(symbol, m.a)),
        h('td', { class: 'num', title: c && c.huff_source === 'none' ? 'No tabulated value: Q = 1 assumed' : null },
          c ? c.huff_factor.toFixed(4) : '–', c && c.huff_source === 'none' ? h('span', { class: 'muted' }, ' (none tabulated)') : null),
        QUANTITY_NAMES.map((name) => h('td', { class: 'num' },
          c ? formatDerived(c[QUANTITIES[name].key], c[`${QUANTITIES[name].key}_unc`]).text : '–')));
    });
    replace(result, head, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Nuclide'), h('th', { class: 'num' }, 'Huff factor Q'),
        QUANTITY_NAMES.map((name) => h('th', { class: 'num' }, `${QUANTITIES[name].label} (${unitText(name)})`)))),
      h('tbody', null, rows))));
  }

  replace(root,
    pageHeading('Converter', versionChoice),
    h('div', { class: 'prose' },
      h('p', null, 'The total lifetime of a muonic atom ', h('i', null, 'τ'), ' and the nuclear capture rate ',
        h('i', null, 'Λ'), h('sub', null, 'cap'), ' are related by'),
      h('p', { class: 'formula' }, '1 / τ  =  Λ', h('sub', null, 'cap'), '  +  Q / τ', h('sub', null, 'μ⁺')),
      h('p', null, 'where Q is the Huff factor (the decay rate of the bound muon is slightly lower than that of the free muon) and τ',
        h('sub', null, 'μ⁺'), ` = ${physics.muLifeNs} ns is the lifetime of the free positive muon. `,
        'The capture probability is the fraction of muons that are captured:'),
      h('p', { class: 'formula' }, 'B', h('sub', null, 'cap'), '  =  τ · Λ', h('sub', null, 'cap'), '  =  Λ', h('sub', null, 'cap'),
        ' / ( Λ', h('sub', null, 'cap'), ' + Q / τ', h('sub', null, 'μ⁺'), ' )'),
      h('p', null, 'Q is taken from the table of Huff factors of the database: the value for the nuclide if there is one, ',
        'otherwise the average for the element. Where neither is tabulated, Q = 1 is assumed (',
        h('code', null, 'huff_source'), ' = ', h('code', null, 'none'), ' in the CSV files).'),
      h('p', { class: 'muted small' }, 'Uncertainties are propagated to first order; those of Q and τ',
        h('sub', null, 'μ⁺'), ' are neglected. The explorer uses the same conversion for every table and chart.')),
    h('div', { class: 'converter' }, form, result));
  renderForm();
  renderResult();
  document.title = 'Converter – Muon Nuclear Data';
}

