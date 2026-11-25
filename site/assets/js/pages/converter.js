// The converter between lifetime, capture rate and capture probability (tools/converter/).

import { h, replace, card, nuclideNode, pageHeading, segSwitch } from '../core/dom.js';
import { formatConverted, formatHuffFactor } from '../core/format.js';
import { isNumberLexeme } from '../core/jsonfmt.js';
import { OBSERVABLES, KINDS, unitLabel, isHuffFactor, HUFF_SOURCE_TEXT } from '../core/convert.js';
import { elementLabel } from '../core/vocabulary.js';
import { pageUrl, query } from './route.js';

export function renderConverter(root, ctx) {
  const { version, versionChoice = null } = ctx;
  const { tables, physics, constants } = version;
  const lifetime = { value: '756.0', unc: '1.0' };
  const silicon = physics.convert(14, 0, 'lifetime', Number(lifetime.value), Number(lifetime.unc), 'ns');
  function startValues(z, kind) {
    if (z !== 14) return { value: '', unc: '' };
    if (kind === 'lifetime') return lifetime;
    // the digits the site shows for a derived value
    const [value = '', unc = ''] = formatConverted(silicon, kind).split(' ± ');
    return { value, unc };
  }

  // the elements the nuclide table gives isotopes for; the one chosen in the explorer, if any, else silicon
  const zs = tables.elements.map((_, i) => i + 1).filter((z) => tables.ranges.has(z));
  const requested = query().get('z');
  const z = requested === null ? (zs.includes(14) ? 14 : zs[0]) : Number(requested);
  if (!zs.includes(z)) {
    const symbol = tables.elements[z - 1];
    const message = requested === null ? 'This version has no isotope ranges.'
      : `This version has no isotope range for ${symbol ? `${symbol} (Z = ${z})` : `Z = ${requested}`}.`;
    replace(root, pageHeading('Converter', versionChoice), h('p', { class: 'notice warn' }, message,
      zs.length ? [' ', h('a', { href: pageUrl('tools/converter', { v: version.label }) }, 'Choose another element.')] : null));
    return;
  }
  const tableQ = (z) => formatHuffFactor(physics.huff(z, 0)[0]);    // the element value, or 1 where none is tabulated
  const state = { z, mode: 'lifetime', custom: false };
  Object.assign(state, startValues(state.z, state.mode));
  state.q = tableQ(state.z);

  // the form is built once; a change sets texts and values in place, so the focus stays where it is
  const unitText = (kind) => `(${unitLabel(kind)})`;
  const valueLabel = h('label', { for: 'c-val' });
  const uncLabel = h('label', { for: 'c-unc' });
  const valueInput = h('input', { id: 'c-val', type: 'text', inputmode: 'decimal',
    oninput: (e) => { state.value = e.target.value; renderResult(); } });
  const uncInput = h('input', { id: 'c-unc', type: 'text', inputmode: 'decimal',
    oninput: (e) => { state.unc = e.target.value; renderResult(); } });
  const ownQ = h('input', { type: 'text', inputmode: 'decimal', value: state.q, hidden: true, 'aria-label': 'Huff factor Q',
    oninput: (e) => { state.q = e.target.value; renderResult(); } });
  function showMode() {
    valueLabel.textContent = `${OBSERVABLES[state.mode].label} ${unitText(state.mode)}`;
    uncLabel.textContent = `Uncertainty ${unitText(state.mode)}`;
    valueInput.value = state.value;
    uncInput.value = state.unc;
  }
  showMode();

  const form = card({ title: 'Input' },
    h('div', { class: 'card-body form-grid' },
      h('fieldset', { class: 'wide' }, h('legend', null, 'Quantity you have'),
        segSwitch(null, KINDS.map((kind) => ({ value: kind, text: OBSERVABLES[kind].label })), state.mode,
          (kind) => {
            if (kind === state.mode) return;
            Object.assign(state, { mode: kind }, startValues(state.z, kind));
            showMode();
            renderResult();
          })),
      h('div', null, h('label', { for: 'c-el' }, 'Element'),
        h('select', { id: 'c-el', onchange: (e) => {
          // the fields follow the element only while they still hold its start values; typed numbers stay
          const start = startValues(state.z, state.mode);
          const untouched = state.value === start.value && state.unc === start.unc;
          state.z = Number(e.target.value);
          if (!state.custom) state.q = ownQ.value = tableQ(state.z);
          if (untouched) { Object.assign(state, startValues(state.z, state.mode)); showMode(); }
          renderResult();
        } }, zs.map((z) => h('option', { value: String(z), selected: state.z === z }, elementLabel(z, tables.elements[z - 1]))))),
      h('div', null, valueLabel, valueInput),
      h('div', null, uncLabel, uncInput),
      h('div', null,
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', onchange: (e) => { state.custom = e.target.checked; ownQ.hidden = !state.custom; renderResult(); } }),
          ' Use my own Huff factor'),
        ownQ)));
  const resultBody = h('div');
  const result = card({ title: 'Result' }, resultBody);

  function renderResult() {
    const value = isNumberLexeme(state.value.trim()) ? Number(state.value) : NaN;
    const uncText = state.unc.trim();
    const unc = uncText === '' ? null : (isNumberLexeme(uncText) ? Number(uncText) : NaN);
    const messages = [];
    const markInvalid = (field, message) => {
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', 'c-error');
      messages.push(message);
    };
    const warn = () => {
      resultBody.className = 'card-body';
      replace(resultBody, h('p', { id: 'c-error', class: 'notice warn', role: 'alert' }, messages.join(' ')));
    };
    for (const field of [valueInput, uncInput, ownQ]) {
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-describedby');
    }
    const label = OBSERVABLES[state.mode].label;
    if (!Number.isFinite(value)) {
      markInvalid(valueInput, `Enter a finite number for ${label.toLowerCase()}.`);
    } else if (state.mode === 'lifetime' && value <= 0) {
      markInvalid(valueInput, 'Enter a lifetime greater than zero.');
    } else if (state.mode === 'capture_probability' && (value < 0 || value >= 100)) {
      markInvalid(valueInput, value === 100 ? 'At 100% capture probability the capture rate has no finite value.'
        : 'Enter a capture probability of at least 0% and less than 100%.');
    }
    if (unc !== null && !(Number.isFinite(unc) && unc >= 0)) {
      markInvalid(uncInput, 'Enter a finite, nonnegative uncertainty or leave it blank.');
    }
    const ownValue = isNumberLexeme(state.q.trim()) ? Number(state.q) : NaN;
    if (state.custom && !isHuffFactor(ownValue)) {
      markInvalid(ownQ, 'Enter a Huff factor Q greater than zero and at most 1.');
    }
    if (messages.length) return warn();
    const symbol = tables.elements[state.z - 1];
    const range = tables.ranges.get(state.z);
    const mono = tables.monoisotopic.get(state.z);
    const masses = [];
    if (state.custom) masses.push({ label: 'Own Q', a: 0, q: ownValue });
    if (!mono) masses.push({ a: 0 });
    for (let a = range[0]; a <= range[1]; a++) masses.push({ a });
    const convert = (m, u) => physics.convert(state.z, m.a, state.mode, value, u, OBSERVABLES[state.mode].unit, m.q);
    const converted = masses.map((m) => convert(m, unc));
    if (converted.every((c) => c === null)) {
      if (unc !== null && masses.some((m) => convert(m, null))) {
        markInvalid(uncInput, 'The uncertainty cannot be propagated within the numeric range.');
      } else {
        markInvalid(valueInput, `This ${label.toLowerCase()} has no finite conversion for the selected element.`);
      }
      return warn();
    }
    const rows = masses.map((m, i) => {
      const c = converted[i];
      const emphasised = m.label || (!state.custom && (m.a === 0 || m.a === mono));
      const assumed = c && c.huff_source === 'none';    // said in the cell; the other sources on hover
      const qText = m.q !== undefined ? state.q.trim() : (c ? formatHuffFactor(c.huff_factor) : '–');
      return h('tr', { class: emphasised ? 'emph' : null },
        h('td', null, m.label || nuclideNode(symbol, m.a)),
        h('td', { class: 'num', title: c && !assumed ? HUFF_SOURCE_TEXT[c.huff_source] : null },
          qText, assumed ? h('span', { class: 'muted' }, ` (${HUFF_SOURCE_TEXT.none})`) : null),
        KINDS.map((kind) => h('td', { class: 'num' }, c ? formatConverted(c, kind) : '–')));
    });
    resultBody.className = 'table-wrap';
    replace(resultBody, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Nuclide'), h('th', { class: 'num' }, 'Huff factor Q'),
        KINDS.map((kind) => h('th', { class: 'num' }, `${OBSERVABLES[kind].label} ${unitText(kind)}`)))),
      h('tbody', null, rows)));
  }

  const tabulatedQ = [...physics.byElement.values(), ...physics.byNuclide.values()];    // the range the prose states
  replace(root,
    pageHeading('Converter', versionChoice),
    h('div', { class: 'stack' }, form, result),
    h('div', { class: 'prose' },
      h('p', null, 'The total lifetime of a muonic atom ', h('i', null, 'τ'), ' and the nuclear capture rate ',
        h('i', null, 'Λ'), h('sub', null, 'cap'), ' are related by'),
      h('p', { class: 'formula' }, '1 / τ  =  Λ', h('sub', null, 'cap'), '  +  Q / τ', h('sub', null, 'μ⁺')),
      h('p', null, 'where Q is the Huff factor (the decay rate of the bound muon is lower than that of the free muon: ',
        `Q from ${formatHuffFactor(Math.min(...tabulatedQ))} to ${formatHuffFactor(Math.max(...tabulatedQ))} in the table) and τ`, h('sub', null, 'μ⁺'), ` = ${physics.muLifeNs} ns (${constants.mu_plus_lifetime.source}) `,
        'is the lifetime of the free positive muon. The capture probability is the fraction of muons that are captured:'),
      h('p', { class: 'formula' }, 'B', h('sub', null, 'cap'), '  =  τ · Λ', h('sub', null, 'cap'), '  =  Λ', h('sub', null, 'cap'),
        ' / ( Λ', h('sub', null, 'cap'), ' + Q / τ', h('sub', null, 'μ⁺'), ' )'),
      h('p', null, 'Q is taken from the table of Huff factors of the database: the value for the nuclide if there is one, ',
        'otherwise the element value (natural abundance). Where neither is tabulated, Q = 1 is assumed (',
        h('code', null, 'huff_source'), ' = ', h('code', null, 'none'), ' in the CSV files).'),
      h('p', { class: 'muted small' }, 'Uncertainties are propagated to first order; those of Q and τ',
        h('sub', null, 'μ⁺'), ' are neglected. The explorer uses the same conversion for every table and chart.')));
  renderResult();
}
