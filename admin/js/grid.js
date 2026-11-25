// The データ (data) card of the editor: one row per data entry.
//
// The columns are described once (columns()): name (the header text, and with
// the row number the accessible name of the row's input), header cell when it
// differs from the name, row cell and which problems found by the checks (JSON
// pointers below /data/<i>/) are shown at the column's input.  An entry the grid cannot edit (document.js,
// gridProblem) is shown as it is, to be corrected in the JSON tab.

import { h, replace, nuclideNode, card as domCard } from '../../site/assets/js/core/dom.js';
import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import { isObject } from '../../site/assets/js/core/jsonfmt.js';
import * as ids from '../../site/assets/js/core/ids.js';
import { fileCode, quantity, entryHash } from '../../site/assets/js/core/database.js';
import { citeLabel } from '../../site/assets/js/core/cite.js';
import { UNIT_LABELS, unitLabel, combinedUncertainty } from '../../site/assets/js/core/convert.js';
import { formatDerived, formatConverted, quantityText } from '../../site/assets/js/core/format.js';
import { effectiveMass } from '../../site/assets/js/core/nuclides.js';
import { T, kindTitle } from './i18n.js';
import { withHint } from './form.js';
import {
  newEntry, setKind, numberText, setNumberField, uncertaintyText, setUncertainty, uncertaintiesOf, gridProblem,
  kindChoices, unitChoices, entryLabel, entryLookup, parseOriginalData, pickOriginalData, confirmOriginal, fileName, parsePastedRows,
} from './document.js';

const UNCERTAINTY_RE = /^observable\/[^/]+\/uncertainties(?:\/(\d+))?/;

const editable = (row) => gridProblem(row) === null;
const originalItems = (row) => (Array.isArray(row.originalData) ? row.originalData : []);
const originalText = (row) => originalItems(row).map((item) => (isObject(item) ? String(item.datasetId) : String(item))).join(', ');

/** A value block as text with its unit: '1065.5 ± 2.0 ns'. */
const blockText = (block) => (block ? quantityText(block) : '—');

/**
 * workspace    the Workspace (tables, other files, conversion)
 * dialog(...)  a modal dialog (see main.js)
 * markDirty()  called after every edit
 */
export function dataGrid({ workspace, dialog, markDirty }) {
  const show = { parts: false, isomer: false };      // optional columns
  const defaults = { kind: 'lifetime', unit: 'ns' }; // quantity and unit of new rows
  const head = h('thead');
  const body = h('tbody');
  const count = h('span', { class: 'tag' });
  let doc = null;
  let cols = [];
  let views = [];                                    // per row: { row, problem, cells: {key: control}, conv, check, id, pool, originalNote }
  let evalIndex = null;
  let lookup = null;                                 // entries of the database by datasetId (document.js, entryLookup)
  let identity = () => null;                         // entry -> { from, choice } when its identifiers changed

  const db = () => workspace.db;
  const code = () => fileCode(doc);

  // ---- columns ------------------------------------------------------------
  /** The source of the uncertainty a pointer below observable/<kind>/uncertainties names ('' if none). */
  function uncertaintySource(rest, row) {
    const m = UNCERTAINTY_RE.exec(rest);
    if (!m) return null;
    const u = m[1] !== undefined ? uncertaintiesOf(quantity(row))[Number(m[1])] : null;
    return u && typeof u === 'object' ? String(u.source) : '';
  }
  const separate = (source) => show.parts && (source === 'statistical' || source === 'systematic');

  /** An input of the row that writes through `apply`. */
  function bind(view, key, el, apply) {
    el.addEventListener('input', () => { apply(el.value); refreshRow(view); markDirty(); });
    view.cells[key] = el;
    return el;
  }

  const uncertaintyCell = (source, placeholder) => (view) => h('td', null, bind(view, source, h('input', {
    type: 'text', class: 'c-num c-unc', inputmode: 'decimal', value: uncertaintyText(quantity(view.row), source), placeholder,
  }), (v) => setUncertainty(quantity(view.row), source, v)));

  function actionsCell(view, i) {
    return h('td', { class: 'nowrap' },
      view.problem ? null : h('button', { class: 'btn small ghost', type: 'button', title: T('この行を複製', 'Duplicate this row'), onclick: () => {
        const copy = jsonfmt.clone(view.row);
        delete copy.datasetId;
        delete copy.legacyIds;
        delete copy.corrections;
        doc.data.splice(i + 1, 0, copy);
        renderRows();
        markDirty();
      } }, '⧉'),
      h('button', { class: 'btn small ghost', type: 'button', title: T('この行を削除', 'Delete this row'), onclick: () => {
        doc.data.splice(i, 1);
        renderRows();
        markDirty();
      } }, '✕'));
  }

  function columns() {
    const withOriginal = code() === 'CUR' || code() === 'EVAL';
    return [
      {
        key: 'index', head: () => h('th', null, '#'),
        cell: (view, i) => h('td', { class: 'num muted small' }, String(i + 1)),
      },
      {
        key: 'element', name: T('元素', 'Element'),
        pointer: (rest) => rest === 'nuclide' || rest.startsWith('nuclide/element'),
        cell: (view) => {
          const { nuclide } = view.row;
          const el = bind(view, 'element', h('input', { type: 'text', class: 'c-el', value: nuclide.element || '', list: 'element-list', spellcheck: 'false', autocomplete: 'off' }),
            (v) => { nuclide.element = v.trim() ? ids.normalizeElement(v) : ''; });
          el.addEventListener('change', () => { el.value = nuclide.element || ''; });
          return h('td', null, el);
        },
      },
      {
        key: 'mass', name: T('質量数', 'Mass number'), head: () => h('th', { title: T('0 = 天然同位体比', '0 = natural abundance') }, 'A'),
        pointer: (rest) => rest.startsWith('nuclide/mass'),
        cell: (view) => {
          const { nuclide } = view.row;
          return h('td', null, bind(view, 'mass', withHint(h('input', { type: 'text', class: 'c-a', inputmode: 'numeric', value: numberText(nuclide, 'mass') }), T('0 = 天然同位体比', '0 = natural abundance')),
            (v) => {
              const t = v.trim();
              if (t === '') delete nuclide.mass;
              else nuclide.mass = /^\d+$/.test(t) ? Number(t) : t;
            }));
        },
      },
      show.isomer && {
        key: 'isomer', name: T('アイソマー', 'Isomer'), head: () => h('th', { title: T('アイソマー (0 = 基底状態)', 'Isomer (0 = ground state)') }, 'm'),
        pointer: (rest) => rest.startsWith('nuclide/isomer'),
        cell: (view) => {
          const { nuclide } = view.row;
          return h('td', null, bind(view, 'isomer', withHint(h('input', { type: 'text', class: 'c-m', inputmode: 'numeric', value: numberText(nuclide, 'isomer') }), T('0 = 基底状態', '0 = ground state')),
            (v) => {
              const t = v.trim();
              nuclide.isomer = t === '' ? 0 : (/^\d+$/.test(t) ? Number(t) : t);
            }));
        },
      },
      {
        key: 'kind', name: T('物理量', 'Quantity'),
        pointer: (rest) => rest === 'observable' || rest === 'observable/kind',
        cell: (view) => {
          const el = h('select', { class: 'c-obs' });
          const fill = () => replace(el, kindChoices(code(), view.row.observable.kind).map((o) =>
            h('option', { value: o, selected: view.row.observable.kind === o }, kindTitle(o))));
          fill();
          el.addEventListener('change', () => { setKind(view.row, el.value); fill(); fillUnits(view); refreshRow(view); markDirty(); });
          view.cells.kind = el;
          return h('td', null, el);
        },
      },
      {
        key: 'value', name: T('値', 'Value'),
        pointer: (rest) => /^observable\/[^/]+(\/value)?$/.test(rest),
        cell: (view) => h('td', null, bind(view, 'value', h('input', { type: 'text', class: 'c-num', inputmode: 'decimal', value: numberText(quantity(view.row), 'value') }),
          (v) => setNumberField(quantity(view.row), 'value', v))),
      },
      {
        key: 'total',
        name: show.parts ? T('全体の不確かさ', 'Total uncertainty') : T('不確かさ', 'Uncertainty'),
        head: () => h('th', { title: T('全体の不確かさ(1σ)', 'Overall uncertainty (1σ)') }, show.parts ? T('± 全体', '± total') : T('± 不確かさ', '± Uncertainty')),
        pointer: (rest, row) => { const s = uncertaintySource(rest, row); return s !== null && !separate(s); },
        cell: uncertaintyCell('total', T('なし', 'none')),
      },
      show.parts && {
        key: 'statistical', name: T('統計誤差', 'Statistical uncertainty'), head: () => h('th', null, T('± 統計', '± stat.')),
        pointer: (rest, row) => uncertaintySource(rest, row) === 'statistical',
        cell: uncertaintyCell('statistical', 'stat'),
      },
      show.parts && {
        key: 'systematic', name: T('系統誤差', 'Systematic uncertainty'), head: () => h('th', null, T('± 系統', '± syst.')),
        pointer: (rest, row) => uncertaintySource(rest, row) === 'systematic',
        cell: uncertaintyCell('systematic', 'syst'),
      },
      {
        key: 'unit', name: T('単位', 'Unit'),
        pointer: (rest) => /^observable\/[^/]+\/unit/.test(rest),
        cell: (view) => {
          const el = h('select', { class: 'c-unit' });
          el.addEventListener('change', () => { quantity(view.row).unit = el.value; fillUnits(view); refreshRow(view); markDirty(); });
          view.cells.unit = el;
          fillUnits(view);
          return h('td', null, el);
        },
      },
      {
        key: 'key', name: 'Key', head: () => h('th', { title: T('同じ核種の行を区別する短い名前', 'Short label separating rows of one nuclide') }, 'Key'),
        pointer: (rest) => rest.startsWith('key') || rest === 'datasetId',
        cell: (view) => h('td', null, bind(view, 'key', h('input', { type: 'text', class: 'c-key', value: view.row.key || '', spellcheck: 'false' }),
          (v) => { view.row.key = v; })),
      },
      {
        key: 'comment', name: T('コメント', 'Comment'),
        pointer: (rest) => rest.startsWith('comment'),
        cell: (view) => h('td', null, bind(view, 'comment', h('input', { type: 'text', class: 'c-comment', value: view.row.comment || '' }),
          (v) => { view.row.comment = v; })),
      },
      withOriginal && {
        key: 'original', name: T('元データ', 'Original data'),
        pointer: (rest) => rest.startsWith('originalData'),
        cell: (view) => {
          const { row } = view;
          view.pool = originalItems(row).filter(isObject);   // items as recorded: typing an id again restores its entryHash
          const el = bind(view, 'original', h('input', {
            type: 'text', class: 'c-orig mono', value: originalText(row), spellcheck: 'false',
            placeholder: code() === 'CUR' ? T('元データの datasetId', 'datasetIds of the original data') : '',
          }), (v) => setOriginal(view, parseOriginalData(v, view.pool, lookup)));
          view.originalNote = h('div', { class: 'orig-note' });
          return h('td', null, h('div', { class: 'input-row' }, el,
            h('button', { class: 'btn small', type: 'button', title: T('実験データから選ぶ', 'Pick from the experimental data'), onclick: () => pickOriginal(view) }, '…')),
          view.originalNote);
        },
      },
      {
        key: 'conv', head: () => h('th', { class: 'num' }, T('換算値', 'Converted')),
        cell: (view) => (view.conv = h('td', { class: 'num small muted c-conv' })),
      },
      {
        key: 'check', head: () => h('th', { title: T('評価値との比較(入力ミス検出用)', 'Comparison with the evaluated value (to catch typing errors)') }, T('確認', 'Check')),
        cell: (view) => (view.check = h('td', { class: 'c-check' })),
      },
      {
        key: 'id', head: () => h('th', null, 'datasetId'),
        cell: (view) => (view.id = h('td', { class: 'mono small muted c-id' })),
      },
      {
        key: 'actions', head: () => h('th', null, ''),
        cell: actionsCell,
      },
    ].filter(Boolean);
  }

  /** The unit select of a row: the units of its kind, and its own unit first if that is not one of them (it is kept). */
  function fillUnits(view) {
    const block = quantity(view.row);
    replace(view.cells.unit, unitChoices(view.row.observable.kind, block.unit).map((u) => h('option', { value: u, selected: String(block.unit ?? '') === u },
      UNIT_LABELS[u] || (u ? `${u} (${T('使えない単位', 'not a unit of this quantity')})` : T('(なし)', '(none)')))));
  }

  // ---- original data ------------------------------------------------------------
  function setOriginal(view, list) {
    if (list.length) view.row.originalData = list; else delete view.row.originalData;
    for (const item of list) if (!view.pool.includes(item)) view.pool.push(item);
  }

  /** Mark the original data that changed since this row was derived from them, and those named by an earlier identifier. */
  function refreshOriginal(view) {
    if (!view.originalNote) return;
    const notes = [];
    for (const item of originalItems(view.row)) {
      const target = lookup.of(item);
      if (!target) continue;
      if (typeof item.entryHash === 'string' && item.entryHash !== entryHash(target.entry)) {
        notes.push(h('button', {
          class: 'btn small warn-btn', type: 'button', onclick: () => recheck(view, item),
          title: T('元データが、この行の値を導いた後に変更されています', 'The original data changed after this value was derived from it'),
        }, T(`再確認が必要: ${item.datasetId}`, `Check again: ${item.datasetId}`)));
      }
      if (target.current !== item.datasetId) {
        notes.push(h('button', {
          class: 'btn small', type: 'button', title: T('記録された entryHash はそのまま残ります', 'The recorded entryHash stays'),
          onclick: () => {
            item.datasetId = target.current;
            view.cells.original.value = originalText(view.row);
            refreshRow(view);
            markDirty();
          },
        }, T(`現在の ID に直す: ${item.datasetId} → ${target.current}`, `Use the current ID: ${item.datasetId} → ${target.current}`)));
      }
    }
    replace(view.originalNote, notes);
  }

  /** The curator confirms that the derived value was checked against the original as it is now; its entryHash is recorded. */
  function recheck(view, item) {
    const target = lookup.resolve(item.datasetId);
    if (!target) return;
    dialog({
      title: T(`元データの再確認 (${item.datasetId})`, `Check the original data again (${item.datasetId})`),
      body: h('div', { class: 'stack' },
        h('p', null, T(`この行の値を導いた後に、元データ ${entryLabel(target.entry)}(${fileName(target.path)}、${target.current})が変更されています。`,
          `The original data ${entryLabel(target.entry)} (${fileName(target.path)}, ${target.current}) changed after this value was derived from it.`)),
        h('dl', { class: 'kv' },
          h('dt', null, T('元データの現在の値', 'Original data now')), h('dd', null, blockText(quantity(target.entry))),
          h('dt', null, T('この行の値', 'This row')), h('dd', null, blockText(quantity(view.row)))),
        h('p', null, T('この行の値が元データの現在の値に合っているか確かめてください(必要なら先に値を直してください)。確かめたら「確認しました」を押します。元データの現在の内容が記録され、「再確認が必要」の表示は消えます。',
          'Check this row against the original data as it is now (correct the value first if needed), then press “Checked”. The current content of the original data is recorded and the notice goes away.'))),
      confirm: T('確認しました', 'Checked'),
      onConfirm: () => {
        if (!confirmOriginal(item, entryLookup(db()))) return;
        refreshRow(view);
        markDirty();
      },
    });
  }

  function pickOriginal(view) {
    const { row } = view;
    const element = row.nuclide.element;
    const z = db().zOf(element);
    const candidates = [...db().entries(doc.sublibrary)].filter((r) => r.code === 'EXP' && isObject(r.entry.nuclide) && db().zOf(r.entry.nuclide.element) === z
      && quantity(r.entry) && typeof r.entry.datasetId === 'string');
    const offered = candidates.map((r) => r.entry.datasetId);
    const about = (item) => {
      const t = lookup.of(item);
      return t ? t.current : null;
    };
    const selected = new Set(originalItems(row).map(about).filter((id) => id !== null && offered.includes(id)));
    const others = originalItems(row).filter((item) => !offered.includes(about(item)));
    const list = h('div', { class: 'pick-list' }, candidates.length ? candidates.map((r) => {
      const box = h('input', { type: 'checkbox', checked: selected.has(r.entry.datasetId) });
      box.addEventListener('change', () => { if (box.checked) selected.add(r.entry.datasetId); else selected.delete(r.entry.datasetId); });
      const a = effectiveMass(z, r.entry.nuclide.mass, db().tables().monoisotopic);
      return h('label', { class: 'pick-item' }, box,
        h('span', null, nuclideNode(r.entry.nuclide.element, a), ` ${blockText(quantity(r.entry))} `,
          r.entry.key ? h('span', { class: 'tag' }, r.entry.key) : null),
        h('span', { class: 'muted small' }, `${citeLabel(db().reference(r.meta.bibId), r.meta.bibId)} · ${r.entry.datasetId}`));
    }) : h('p', { class: 'muted' }, T('この元素の実験データがありません。先に EXP を登録してください。', 'No experimental data for this element yet. Enter the EXP data first.')));
    dialog({
      title: T(`元データを選択 (${element || '?'})`, `Original data (${element || '?'})`),
      body: h('div', { class: 'stack' }, list,
        others.length ? h('p', { class: 'small muted' }, T('この一覧にない元データ(そのまま残ります): ', 'Original data not in this list (kept as they are): '),
          others.map((item) => (isObject(item) ? String(item.datasetId) : String(item))).join(', ')) : null),
      confirm: T('決定', 'Use selection'),
      onConfirm: () => {
        setOriginal(view, pickOriginalData(row.originalData, offered, selected, lookup));
        view.cells.original.value = originalText(row);
        refreshRow(view);
        markDirty();
      },
    });
  }

  // ---- checks while typing ---------------------------------------------------
  function buildEvalIndex() {
    evalIndex = new Map();
    const physics = workspace.physics();
    if (code() === 'EVAL' || !physics) return;
    for (const r of db().entries(doc.sublibrary)) {
      if (r.code !== 'EVAL' || !editable(r.entry)) continue;
      const nuclide = r.entry.nuclide;
      const block = quantity(r.entry);
      const z = db().zOf(nuclide.element);
      const c = physics.convert(z, nuclide.mass, r.entry.observable.kind, block.value, combinedUncertainty(block.uncertainties), block.unit);
      if (!c) continue;
      if (!evalIndex.has(z)) evalIndex.set(z, []);
      evalIndex.get(z).push({ a: nuclide.mass, rate: c['capture_rate_us-1'], unc: c['capture_rate_us-1_unc'] || 0 });
    }
  }

  /** Compare with the evaluated value of the same nuclide to catch typing errors. */
  function plausibility(row, conv) {
    if (!conv || !evalIndex) return null;
    const z = db().zOf(row.nuclide.element);
    const refs = evalIndex.get(z);
    if (!refs || !refs.length) return null;
    const a = effectiveMass(z, row.nuclide.mass, db().tables().monoisotopic);
    const rate = conv['capture_rate_us-1'];
    const sigma = conv['capture_rate_us-1_unc'] || 0;
    const rateUnit = unitLabel('capture_rate');
    let low;
    let high;
    let text;
    const exact = refs.find((r) => r.a === a);
    if (exact) {
      const margin = 5 * Math.hypot(sigma, exact.unc);
      low = exact.rate - margin;
      high = exact.rate + margin;
      text = `EVAL ${formatDerived(exact.rate, exact.unc)} ${rateUnit}`;
    } else if (a === 0) {
      low = Math.min(...refs.map((r) => r.rate));
      high = Math.max(...refs.map((r) => r.rate));
      text = `EVAL ${formatDerived(low, null)}–${formatDerived(high, null)} ${rateUnit} (${T('同位体', 'isotopes')})`;
      low -= 5 * sigma;
      high += 5 * sigma;
    } else {
      return null;
    }
    const ok = rate >= low * 0.75 && rate <= high * 1.25;
    return { ok, text: `${T('この行', 'this row')}: ${formatDerived(rate, sigma || null)} ${rateUnit} / ${text}` };
  }

  /** The datasetId of a row, marked when its identifiers changed (the editor asks what the change means). */
  function showId(view) {
    const status = identity(view.row);
    const id = view.row.datasetId || '';
    if (!status) { replace(view.id, id); return; }
    const label = status.choice === 'same' ? T('訂正', 'correction') : status.choice === 'different' ? T('別のデータ', 'different data') : T('ID 変更: 未選択', 'ID changed: choose');
    replace(view.id, id, ' ', h('span', {
      class: `tag ${status.choice ? '' : 'warn'}`, title: T(`以前の ID: ${status.from}`, `Former ID: ${status.from}`),
    }, label));
  }

  function refreshRow(view) {
    if (view.problem) return;
    const { row } = view;
    const block = quantity(row);
    const list = uncertaintiesOf(block);
    const z = db().zOf(row.nuclide.element);
    const physics = workspace.physics();
    const numeric = typeof block.value === 'number' && list.every((u) => u && typeof u.value === 'number');
    const conv = physics && z && numeric
      ? physics.convert(z, typeof row.nuclide.mass === 'number' ? row.nuclide.mass : 0, row.observable.kind, block.value,
        combinedUncertainty(list), block.unit)
      : null;
    const other = row.observable.kind === 'lifetime' ? 'capture_rate' : 'lifetime';
    view.conv.textContent = conv ? `${formatConverted(conv, other)} ${unitLabel(other)}` : '';
    const p = plausibility(row, conv);
    replace(view.check, p ? h('span', { class: p.ok ? 'ok' : 'warnmark', title: p.text }, p.ok ? '✓' : T('⚠ 要確認', '⚠ check')) : '');
    showId(view);
    refreshOriginal(view);
  }

  // ---- rows ----------------------------------------------------------------------
  /** A row the grid cannot edit: shown as written, with the reason. */
  function problemRow(view, i) {
    const reason = {
      entry: T('行がオブジェクトではありません', 'the row is not an object'),
      nuclide: T('nuclide がありません', 'nuclide is missing'),
      observable: T('observable がありません', 'observable is missing'),
      kind: T('observable.kind が既知の物理量ではありません', 'observable.kind is not a known quantity'),
      value: T('物理量の値のブロックがありません', 'the value block of the quantity is missing'),
    }[view.problem];
    const cell = h('td', { colspan: String(cols.length - 2), class: 'small', tabindex: '-1' },
      h('span', { class: 'warnmark' }, '⚠ '),
      T(`この行は表では編集できません(${reason})。JSON タブで直してください: `, `This row cannot be edited here (${reason}). Correct it in the JSON tab: `),
      h('code', { class: 'mono' }, jsonfmt.compact(view.row)));
    view.cells.row = cell;
    return h('tr', null, h('td', { class: 'num muted small' }, String(i + 1)), cell, actionsCell(view, i));
  }

  function renderRows() {
    const rows = doc.data.filter(editable);
    if (rows.some((r) => uncertaintiesOf(quantity(r)).some((u) => u && u.source !== 'total'))) show.parts = true;
    if (rows.some((r) => r.nuclide.isomer !== 0)) show.isomer = true;
    cols = columns();
    replace(head, h('tr', null, cols.map((c) => (c.head ? c.head() : h('th', null, c.name)))));
    buildEvalIndex();
    lookup = entryLookup(db());
    replace(body);
    views = doc.data.map((row, i) => {
      const view = { row, cells: {}, problem: gridProblem(row) };
      view.tr = view.problem ? problemRow(view, i) : h('tr', null, cols.map((c) => c.cell(view, i)));
      if (!view.problem) {
        for (const c of cols) {
          const el = view.cells[c.key];
          if (el && c.name) el.setAttribute('aria-label', T(`${i + 1} 行目: ${c.name}`, `Row ${i + 1}: ${c.name}`));
        }
      }
      body.appendChild(view.tr);
      refreshRow(view);
      return view;
    });
    count.textContent = String(doc.data.length);
  }

  const lastEditable = () => [...doc.data].reverse().find(editable);

  function addRow() {
    const last = lastEditable();
    doc.data.push(newEntry(last ? last.nuclide.element : '', 0, defaults.kind, defaults.unit));
    renderRows();
    markDirty();
    const { element } = views[views.length - 1].cells;
    element.focus();
    element.select();
  }

  function pasteDialog() {
    const area = h('textarea', { rows: 10, spellcheck: 'false', 'aria-label': T('貼り付ける行', 'Rows to paste'), placeholder: 'Si\t28\t743.9\t5.0\nSi\t29\t794.2\t3.5\nnatSi\t751.6\t1.0\tplate' });
    const info = h('p', { class: 'small muted' });
    area.addEventListener('input', () => {
      const { rows, skipped } = parsePastedRows(area.value, db().tables().elements);
      info.textContent = T(`${rows.length} 行を読み取りました`, `${rows.length} row(s) recognised`)
        + (skipped.length ? T(`、${skipped.length} 行は読めませんでした: `, `, ${skipped.length} not understood: `) + skipped.slice(0, 3).join(' / ') : '');
    });
    dialog({
      title: T('表計算ソフトから貼り付け', 'Paste from a spreadsheet'),
      body: h('div', { class: 'stack' },
        h('p', { class: 'small' }, T('列の順番: 元素, 質量数, 値, 不確かさ, [Key], [コメント]。元素は 28Si / Si-28 / natSi の形でも構いません(その場合、質量数の列は不要)。物理量と単位は「新しい行の既定値」が使われます。',
          'Columns: element, mass number, value, uncertainty, [key], [comment]. The element may be written as 28Si / Si-28 / natSi (then leave out the mass column). Quantity and unit are taken from “defaults for new rows”.')),
        area, info),
      confirm: T('追加', 'Add rows'),
      onConfirm: () => {
        for (const r of parsePastedRows(area.value, db().tables().elements).rows) {
          const row = newEntry(r.element, r.mass, defaults.kind, defaults.unit);
          setNumberField(quantity(row), 'value', r.value);
          if (r.uncertainty) setUncertainty(quantity(row), 'total', r.uncertainty);
          if (r.key) row.key = r.key;
          if (r.comment) row.comment = r.comment;
          doc.data.push(row);
        }
        renderRows();
        markDirty();
      },
    });
    area.focus();
  }

  function sortRows() {
    const nuclide = (r) => (isObject(r) && isObject(r.nuclide) ? r.nuclide : {});
    const z = (r) => db().zOf(nuclide(r).element) || 999;
    doc.data.sort((a, b) => z(a) - z(b) || (Number(nuclide(a).mass) || 0) - (Number(nuclide(b).mass) || 0)
      || String((isObject(a) && a.key) || '').localeCompare(String((isObject(b) && b.key) || '')));
    renderRows();
    markDirty();
  }

  /** The card for `currentDoc` (a document whose data is a list, see document.js). */
  function card(currentDoc) {
    doc = currentDoc;
    const kinds = kindChoices(code());
    const obs = h('select', { 'aria-label': T('新しい行の物理量', 'Quantity of new rows') }, kinds.map((o) => h('option', { value: o }, kindTitle(o))));
    const unit = h('select', { 'aria-label': T('新しい行の単位', 'Unit of new rows') });
    const fill = () => {
      const units = unitChoices(defaults.kind).filter(Boolean);
      if (!units.includes(defaults.unit)) defaults.unit = units[0];
      replace(unit, units.map((u) => h('option', { value: u, selected: defaults.unit === u }, UNIT_LABELS[u])));
    };
    const last = lastEditable();
    if (last && kinds.includes(last.observable.kind)) {
      defaults.kind = last.observable.kind;
      defaults.unit = quantity(last).unit;
    } else if (code() === 'CUR' || code() === 'EVAL') {
      defaults.kind = 'capture_rate';     // curated and evaluated data are given as capture rates
      defaults.unit = 'us-1';
    }
    obs.value = defaults.kind;
    fill();
    obs.addEventListener('change', () => { defaults.kind = obs.value; fill(); });
    unit.addEventListener('change', () => { defaults.unit = unit.value; });
    renderRows();
    const toggle = (key, label) => {
      const box = h('input', { type: 'checkbox', checked: show[key] });
      box.addEventListener('change', () => { show[key] = box.checked; renderRows(); box.checked = show[key]; });
      return h('label', { class: 'check small' }, box, label);
    };
    return domCard({
      title: h('h2', null, T('データ ', 'Data entries '), count),
      controls: h('div', { class: 'row' },
        toggle('parts', T('統計・系統誤差を分けて入力', 'Separate statistical / systematic')),
        toggle('isomer', T('アイソマー', 'Isomers')),
        h('span', { class: 'small muted' }, T('新しい行の既定値', 'Defaults for new rows')), obs, unit,
        h('button', { class: 'btn', type: 'button', onclick: addRow }, T('+ 行を追加', '+ Add row')),
        h('button', { class: 'btn', type: 'button', onclick: pasteDialog }, T('貼り付け…', 'Paste …')),
        h('button', { class: 'btn ghost', type: 'button', onclick: sortRows, title: T('Z・A の順に並べ替え', 'Sort by Z and A') }, T('並べ替え', 'Sort'))),
    },
      h('div', { class: 'table-wrap grid-wrap' }, h('table', { class: 'data grid' }, head, body)),
      h('datalist', { id: 'element-list' }, db().tables().elements.map((e) => h('option', { value: e }))),
      h('div', { class: 'card-body small muted' },
        T('値と不確かさは論文に書かれた桁のまま入力してください(例: 13.250)。A = 0 は天然同位体比の標的です。論文が統計誤差と系統誤差を分けている場合は分けて入力します。「± 全体」に値があれば換算にはその値を使います。空欄なら各成分の二乗和の平方根を使います。実験データには論文に最も近い物理量を1つだけ入力し、キュレーション・評価データは捕獲率に統一します。',
          'Type value and uncertainty with the digits given in the paper (e.g. 13.250). A = 0 means a target of natural abundance. If the paper separates statistical and systematic uncertainties, enter them separately. Conversions use “± total” when given. If it is blank, they use the square root of the sum of the squared components. Experimental entries hold the one quantity closest to the publication; curated and evaluated entries are given as capture rates.')));
  }

  return {
    card,
    /** Forget the document (the form does not show one). */
    detach() {
      doc = null;
      views = [];
    },
    /** The input of row `index` for the pointer `rest` below /data/<index>/ (the element input if no column claims it). */
    controlFor(index, rest) {
      const view = views[index];
      if (!view) return null;
      if (view.problem) return view.cells.row;
      const col = cols.find((c) => c.pointer && c.pointer(rest, view.row));
      return view.cells[col ? col.key : 'element'] || null;
    },
    /** Every input of the grid. */
    controls: () => views.flatMap((view) => Object.values(view.cells)),
    /**
     * Show the identifiers, the state of the original data and the number of
     * rows after the document was stored.  `statusOf(entry)`: { from, choice }
     * for an entry whose identifiers changed (see the editor).
     */
    refresh(statusOf = () => null) {
      identity = statusOf;
      if (!doc) return;
      lookup = entryLookup(db());
      for (const view of views) refreshRow(view);
      count.textContent = String(doc.data.length);
    },
  };
}
