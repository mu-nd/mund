// Editor of one dataset file: a form for the metadata, a grid for the data
// entries, the JSON text (Monaco) and the changes relative to the repository.
//
// Every edit is turned into the canonical file text and kept as a draft in
// the workspace; nothing reaches the repository before "Commit".
//
// A data entry has the shape described in docs/data-format.md:
//   { datasetId, nuclide: { element, mass, isomer },
//     observable: { kind, [kind]: { value, unit, uncertainties: [{ source, value }] } },
//     key?, comment?, originalData?, legacyIds? }

import { h, replace, clear, nuclideNode, debounce } from '../core/dom.js';
import * as jsonfmt from '../core/jsonfmt.js';
import * as schemaMod from '../core/schema.js';
import * as ids from '../core/ids.js';
import { DATASETS, DATASET_TITLES, DATASET_TYPE_OF, assignIds, expectedMetaId, datasetCode, quantity } from '../core/checks.js';
import { datasetPath, citeLabel, citeText, isPlaceholderDoi, asciiLabel, firstAuthor, referenceYear } from '../core/cite.js';
import { Physics, OBSERVABLES, OBSERVABLE_LABELS, UNIT_LABELS, unitsOf, combinedUncertainty } from '../core/convert.js';
import { formatDerived, formatQuantity, effectiveMass } from '../core/format.js';
import { T } from './i18n.js';
import { renderDiff, diffLines, diffStats } from './diff.js';
import { loadMonaco, monacoTheme, configureSchemas, modelFor } from './monaco.js';
import { lookupDoi } from './crossref.js';
import { parsePastedRows } from './paste.js';

const DOI_RE = /^10\.[0-9]{4,9}\/[^\s;]+$/;
const SOURCE_ORDER = ['total', 'statistical', 'systematic', 'other'];
// what is detected to measure the lifetime (choices of the LT sub-library)
const LT_METHODS = ['electron', 'gamma', 'neutron', 'charged particle', 'fission fragment'];

export function newDataset(code) {
  return { format: 'muND/LT/1', sublibrary: 'LT', datasetType: DATASET_TYPE_OF[code], meta: { id: '', bibId: '' }, data: [] };
}

// ---- access to the nested parts of a data entry ---------------------------------

function nuclideOf(row) {
  if (!row.nuclide || typeof row.nuclide !== 'object' || Array.isArray(row.nuclide)) row.nuclide = { element: '', mass: 0, isomer: 0 };
  if (row.nuclide.isomer === undefined) row.nuclide.isomer = 0;
  return row.nuclide;
}

function blockOf(row) {
  if (!row.observable || typeof row.observable !== 'object' || Array.isArray(row.observable)) row.observable = { kind: 'lifetime' };
  const obs = row.observable;
  if (!OBSERVABLES.includes(obs.kind)) obs.kind = 'lifetime';
  if (!obs[obs.kind] || typeof obs[obs.kind] !== 'object') obs[obs.kind] = { unit: unitsOf(obs.kind)[0], uncertainties: [] };
  const block = obs[obs.kind];
  if (!Array.isArray(block.uncertainties)) block.uncertainties = [];
  return block;
}

function setKind(row, kind) {
  const block = blockOf(row);
  const obs = row.observable;
  if (obs.kind !== kind) {
    delete obs[obs.kind];
    obs.kind = kind;
    obs[kind] = block;
  }
  if (!unitsOf(kind).includes(block.unit)) block.unit = unitsOf(kind)[0];
}

function newRow(element, mass, kind, unit) {
  return { nuclide: { element, mass, isomer: 0 }, observable: { kind, [kind]: { unit, uncertainties: [] } } };
}

function numberField(obj, key) {
  if (typeof obj[key] === 'number') return jsonfmt.numberText(obj, key);
  return obj[key] === null || obj[key] === undefined ? '' : String(obj[key]);
}

/** Store typed text as a number; text that is not a number is kept so that the check reports it. */
function setNumberField(obj, key, text) {
  const t = text.trim();
  if (t === '') delete obj[key];
  else if (!jsonfmt.setNumber(obj, key, t)) obj[key] = t;
}

function uncertaintyText(block, source) {
  const u = block.uncertainties.find((x) => x && x.source === source);
  return u ? numberField(u, 'value') : '';
}

function setUncertainty(block, source, text) {
  const t = text.trim();
  let u = block.uncertainties.find((x) => x && x.source === source);
  if (t === '') {
    if (u) block.uncertainties = block.uncertainties.filter((x) => x !== u);
    return;
  }
  if (!u) {
    u = { source };
    block.uncertainties.push(u);
    const rank = (x) => (SOURCE_ORDER.includes(x.source) ? SOURCE_ORDER.indexOf(x.source) : SOURCE_ORDER.length);
    block.uncertainties.sort((a, b) => rank(a) - rank(b));
  }
  setNumberField(u, 'value', t);
}

function authorsToText(authors) {
  return (authors || []).map((a) => (a.family ? (a.given ? `${a.family}, ${a.given}` : a.family) : (a.name || ''))).join('\n');
}

function textToAuthors(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const i = line.indexOf(',');
    if (i < 0) return { family: line };
    const given = line.slice(i + 1).trim();
    return given ? { family: line.slice(0, i).trim(), given } : { family: line.slice(0, i).trim() };
  });
}

export function openEditor(container, app, { path: initialPath, doc: initialDoc }) {
  const { workspace } = app;
  let path = initialPath || null;            // current location of the draft (null: not stored yet)
  let doc = initialDoc || jsonfmt.parse(workspace.text(path));
  let tab = 'form';
  let destroyed = false;
  let leaving = false;                        // true while the page is being left: do not touch the address
  let monacoEditor = null;
  let jsonText = null;                        // text being edited in the JSON tab (null = in sync)
  let reference = null;                       // bibliography entry of meta.bibId being edited
  let referenceDirty = false;
  const rowViews = [];
  const controls = new Map();                 // JSON pointer -> input element (metadata fields)
  const openIds = new WeakMap();              // row -> datasetId it had when the editor (last) stored it
  const show = { parts: false, isomer: false };

  if (!doc.meta || typeof doc.meta !== 'object') doc.meta = { id: '', bibId: '' };
  if (!Array.isArray(doc.data)) doc.data = [];
  doc.data = doc.data.filter((row) => row && typeof row === 'object');
  for (const row of doc.data) if (typeof row.datasetId === 'string') openIds.set(row, row.datasetId);

  const db = () => workspace.db;
  const tables = () => db().tables();
  const schema = () => db().schemaFor(doc.format);
  const physics = () => new Physics(db().masterObj('huff_factors.json'), db().masterObj('constants.json'));
  const code = () => datasetCode(doc);
  const isNew = () => !path || workspace.baseline(path) === null;
  const bibId = () => String(doc.meta.bibId || '').trim();

  function loadReference() {
    const found = db().reference(bibId());
    reference = found ? jsonfmt.clone(found) : { DOI: bibId() };
    referenceDirty = false;
  }
  loadReference();

  // ---- storing the draft ------------------------------------------------------
  function canonicalText() {
    const sch = schema();
    return jsonfmt.stringify(sch ? schemaMod.normalize(doc, sch) : doc);
  }

  function saveReference() {
    if (!referenceDirty || !DOI_RE.test(bibId())) return;
    referenceDirty = false;
    reference.DOI = bibId();
    workspace.setReference(jsonfmt.clone(reference));
  }

  function store() {
    if (destroyed) return;
    saveReference();
    const metaId = expectedMetaId(doc);
    if (metaId === null || !DOI_RE.test(bibId())) {
      refreshComputed();
      return;                                  // no valid DOI yet: nothing to store
    }
    assignIds(doc);
    // follow identifiers that changed while editing
    const mapping = new Map();
    const committed = workspace.upstreamIds();
    for (const row of doc.data) {
      const before = openIds.get(row);
      if (before && row.datasetId && before !== row.datasetId) {
        mapping.set(before, row.datasetId);
        if (committed.has(before)) row.legacyIds = [...new Set([...(row.legacyIds || []), before])];
      }
      if (row.legacyIds) {
        row.legacyIds = row.legacyIds.filter((x) => x !== row.datasetId);
        if (!row.legacyIds.length) delete row.legacyIds;
      }
      if (row.datasetId) openIds.set(row, row.datasetId);
    }
    const target = datasetPath(doc, db().reference(bibId()));
    workspace.move(path, target, canonicalText());
    path = target;
    const touched = workspace.replaceIds(mapping, path);
    if (touched.length) {
      app.toast(T(`参照元の ID を更新しました: ${touched.length} ファイル`, `Updated references in ${touched.length} file(s)`));
    }
    if (!leaving) app.setEditorPath(path);
    refreshComputed();
  }
  const storeSoon = debounce(store, 250);

  // ---- helpers for form controls ----------------------------------------------------
  function field(label, control, { hint, pointer, wide } = {}) {
    if (pointer) controls.set(pointer, control);
    const id = `f-${Math.random().toString(36).slice(2, 9)}`;
    control.id = id;
    return h('div', { class: `field${wide ? ' wide' : ''}` },
      h('label', { for: id }, label),
      control,
      hint ? h('p', { class: 'hint' }, hint) : null);
  }

  function textInput(obj, key, { area, rows = 3, placeholder, list, onChange } = {}) {
    const el = area
      ? h('textarea', { rows, placeholder, spellcheck: 'false' })
      : h('input', { type: 'text', placeholder, list, autocomplete: 'off', spellcheck: 'false' });
    el.value = obj[key] === undefined || obj[key] === null ? '' : String(obj[key]);
    el.addEventListener('input', () => {
      obj[key] = el.value;
      if (onChange) onChange();
      storeSoon();
    });
    return el;
  }

  // ---- form: reference -----------------------------------------------------------------
  const metaIdEl = h('code', { class: 'computed' });
  const metaSourceEl = h('span', { class: 'muted small mono' });
  const pathEl = h('code', { class: 'computed' });
  const statusEl = h('span', { class: 'tag' });
  const titleEl = h('span');
  const citeEl = h('span');
  const lookupStatus = h('span', { class: 'small muted', role: 'status' });
  let refFields = null;

  /** One-element list member of a bibliography entry (Crossref writes titles as lists). */
  function listInput(key, placeholder) {
    const el = h('input', { type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off' });
    el.value = Array.isArray(reference[key]) && reference[key].length ? String(reference[key][0]) : '';
    el.addEventListener('input', () => {
      const v = el.value.trim();
      if (v) reference[key] = [v]; else delete reference[key];
      referenceDirty = true;
      storeSoon();
    });
    return el;
  }

  function refInput(key, placeholder, list) {
    return textInput(reference, key, { placeholder, list, onChange: () => { referenceDirty = true; } });
  }

  function renderReferenceFields() {
    const authors = h('textarea', { rows: 3, spellcheck: 'false', placeholder: 'Suzuki, T.\nMeasday, D. F.' });
    authors.value = authorsToText(reference.author);
    authors.addEventListener('input', () => {
      const list = textToAuthors(authors.value);
      if (list.length) reference.author = list; else delete reference.author;
      referenceDirty = true;
      storeSoon();
    });
    const year = h('input', { type: 'text', inputmode: 'numeric', placeholder: '1987' });
    year.value = referenceYear(reference) || '';
    year.addEventListener('input', () => {
      const v = year.value.trim();
      const rest = reference.published && Array.isArray(reference.published['date-parts'])
        && Array.isArray(reference.published['date-parts'][0]) ? reference.published['date-parts'][0].slice(1) : [];
      if (/^\d{4}$/.test(v)) reference.published = { 'date-parts': [[Number(v), ...rest]] };
      else delete reference.published;
      referenceDirty = true;
      storeSoon();
    });
    replace(refFields,
      field(T('著者(1行に1人、「姓, 名」)', 'Authors (one per line: Family, Given)'), authors, { wide: true }),
      field(T('タイトル', 'Title'), listInput('title'), { wide: true }),
      field(T('雑誌名', 'Journal'), listInput('container-title', 'Physical Review C')),
      field(T('雑誌名(略称)', 'Journal (abbreviated)'), listInput('short-container-title', 'Phys. Rev. C')),
      field(T('巻', 'Volume'), refInput('volume')),
      field(T('ページ', 'Pages'), refInput('page', '2212-2224')),
      field(T('論文番号', 'Article number'), refInput('article-number', '024307')),
      field(T('年', 'Year'), year),
      field(T('種類', 'Type'), refInput('type', 'journal-article', 'reference-types')),
      field('URL', refInput('URL', 'https://…'), { hint: T('DOI がない文献の所在', 'Where to find a source without DOI') }),
      h('datalist', { id: 'reference-types' }, ['journal-article', 'proceedings-article', 'report', 'dissertation', 'book-chapter', 'posted-content']
        .map((t) => h('option', { value: t }))));
  }

  async function lookup() {
    const doi = bibId();
    if (!DOI_RE.test(doi)) { lookupStatus.textContent = T('DOI を入力してください', 'Enter a DOI first'); return; }
    if (isPlaceholderDoi(doi)) {
      lookupStatus.textContent = T('仮 DOI のため検索できません。書誌情報を手入力してください。',
        'Placeholder DOI: please type the bibliographic data.');
      return;
    }
    lookupStatus.textContent = T('検索中…', 'Looking up …');
    try {
      const found = await lookupDoi(doi);
      if (!found) { lookupStatus.textContent = T('見つかりませんでした', 'Not found'); return; }
      reference = found.reference;
      referenceDirty = true;
      renderReferenceFields();
      lookupStatus.textContent = T(`${found.source} から取得しました。内容を確認してください。`, `Filled from ${found.source}. Please check.`);
      store();
    } catch (err) {
      lookupStatus.textContent = T(`取得できませんでした (${err.message})。手入力してください。`,
        `Lookup failed (${err.message}). Please type the data.`);
    }
  }

  function placeholderDoi() {
    const slug = prompt(T('DOI のない文献の識別名(英数字)。例: Suzuki1975thesis',
      'Short name for a source without DOI (letters and digits), e.g. Suzuki1975thesis'),
    `${asciiLabel(firstAuthor(reference))}${referenceYear(reference) || ''}`);
    if (!slug) return;
    const name = asciiLabel(slug);
    if (!name) return;
    doc.meta.bibId = `10.1000/mund.${name}`;
    controls.get('/meta/bibId').value = doc.meta.bibId;
    reference.DOI = doc.meta.bibId;
    referenceDirty = Object.keys(reference).length > 1;
    store();
  }

  function referenceCard() {
    const dataset = h('select', {
      disabled: !isNew(),
      onchange: (e) => {
        doc.datasetType = DATASET_TYPE_OF[e.target.value];
        if (code() !== 'EXP') for (const k of ['facility', 'beam', 'target', 'detector']) delete doc.meta[k];
        if (code() !== 'EVAL') delete doc.meta.referenceDatabase;
        if (code() === 'EXP' || code() === 'TH') for (const row of doc.data) delete row.originalData;
        store();
        renderForm();
      },
    }, DATASETS.map((d) => h('option', { value: d, selected: code() === d }, `${d} – ${DATASET_TITLES[d]} (${DATASET_TYPE_OF[d]})`)));
    const doi = textInput(doc.meta, 'bibId', { placeholder: '10.1103/PhysRevC.35.2212' });
    doi.addEventListener('change', () => {
      doi.value = doc.meta.bibId = doi.value.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
      saveReference();
      loadReference();                         // bibliography entry of the new DOI, if there is one
      renderReferenceFields();
      store();
    });
    const related = h('input', { type: 'text', spellcheck: 'false', placeholder: '10.48550/arXiv.2501.05897' });
    related.value = (doc.meta.relatedBibIds || []).join(', ');
    related.addEventListener('input', () => {
      doc.meta.relatedBibIds = related.value.split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean);
      storeSoon();
    });
    controls.set('/meta/bibId', doi);
    refFields = h('div', { class: 'form-cols' });
    renderReferenceFields();
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, T('文献', 'Reference')),
        h('span', { class: 'muted small' }, T('1論文 = 1ファイル。データは下の表に入力します。', 'One publication = one file. Data entries go into the table below.'))),
      h('div', { class: 'card-body' },
        h('div', { class: 'form-cols' },
          field(T('データ種別 (datasetType)', 'Kind of data (datasetType)'), dataset, {
            pointer: '/datasetType',
            hint: !isNew() ? T('登録済みのファイルでは変更できません', 'Fixed once the file is in the repository') : null,
          }),
          h('div', { class: 'field' }, h('label', null, 'DOI (bibId)'),
            h('div', { class: 'input-row' }, doi,
              h('button', { class: 'btn', type: 'button', onclick: lookup }, T('書誌情報を取得', 'Look up')),
              h('button', { class: 'btn ghost', type: 'button', onclick: placeholderDoi, title: T('DOI のない文献に仮の識別子 10.1000/mund.… を付けます', 'Give a source without DOI a placeholder 10.1000/mund.…') }, T('DOI なし…', 'No DOI …'))),
            lookupStatus),
          field(T('枝番 Key(任意)', 'Key (optional)'), textInput(doc.meta, 'key', { placeholder: 'setup-b' }), {
            pointer: '/meta/key',
            hint: T('1つの論文に測定条件の異なるメタデータを複数作る場合だけ使います', 'Only when one publication needs several metadata records (e.g. two set-ups)'),
          }),
          field(T('関連 DOI(arXiv・訂正・データ等)', 'Related DOIs (arXiv, erratum, data …)'), related, { pointer: '/meta/relatedBibIds' })),
        h('p', { class: 'computed-line' }, 'MetaID ', metaIdEl, ' ', metaSourceEl),
        h('details', { open: isNew() || !firstAuthor(reference) },
          h('summary', null, T('書誌情報(文献データベース bibliography.json に保存されます)', 'Bibliographic data (stored in bibliography.json)')), refFields)));
  }

  // ---- form: conditions -------------------------------------------------------------------
  function conditionsCard() {
    const exp = code() === 'EXP';
    const used = db().sortedFiles().filter((f) => f.code === code()).map((f) => f.meta.method).filter(Boolean);
    const methods = [...new Set([...(exp ? LT_METHODS : []), ...used])];
    const listId = `methods-${code()}`;
    let body;
    if (exp) {
      const facility = h('select', {
        onchange: (e) => { doc.meta.facility = e.target.value; store(); },
      }, h('option', { value: '' }, T('(選択してください)', '(choose)')),
      tables().facilities.map((f) => h('option', { value: f.abbr, selected: doc.meta.facility === f.abbr }, `${f.abbr} — ${f.detail}`)),
      doc.meta.facility && !tables().facilityAbbrs.has(doc.meta.facility)
        ? h('option', { value: doc.meta.facility, selected: true }, `${doc.meta.facility} (${T('未登録', 'not in the list')})`) : null);
      controls.set('/meta', facility);
      body = [
        field(T('施設', 'Facility'), facility, {
          pointer: '/meta/facility',
          hint: h('span', null, T('一覧にない場合は', 'Missing? Add it under '),
            h('a', { href: '#/master' }, T('マスタデータ', 'Master data')), T('で追加', '')),
        }),
        field(T('測定手法', 'Method'), textInput(doc.meta, 'method', { list: listId, placeholder: 'electron' }), {
          pointer: '/meta/method',
          hint: T('何を検出したか: electron / gamma / neutron / charged particle / fission fragment', 'What was detected: electron / gamma / neutron / charged particle / fission fragment'),
        }),
        field(T('ビーム', 'Beam'), textInput(doc.meta, 'beam', { area: true }), {
          pointer: '/meta/beam', wide: true,
          hint: T('ビームライン・運動量・強度など(統一的に書けない項目なので自由記述)', 'Beam line, momentum, intensity … (free text)'),
        }),
        field(T('標的', 'Target'), textInput(doc.meta, 'target', { area: true }), {
          pointer: '/meta/target', wide: true,
          hint: T('大きさ・厚さ、気体/液体/固体、化学形、同位体濃縮度など(自由記述)', 'Size, thickness, gas / liquid / solid, chemical form, enrichment … (free text)'),
        }),
        field(T('検出器', 'Detector'), textInput(doc.meta, 'detector', { area: true }), {
          pointer: '/meta/detector', wide: true,
          hint: T('例: プラスチックシンチレータ、Ge、NaI、液体シンチレータ、³He 検出器、Si、PPAC など', 'e.g. plastic scintillator, Ge, NaI, liquid scintillator, ³He counter, Si, PPAC …'),
        }),
        field(T('コメント', 'Comment'), textInput(doc.meta, 'comment', { area: true, rows: 2 }), {
          pointer: '/meta/comment', wide: true, hint: T('補正・参照データ・注意点など', 'Corrections, reference data, caveats …'),
        }),
      ];
    } else {
      body = [
        field(T('手法', 'Method'), textInput(doc.meta, 'method', { list: listId, area: true, rows: 2 }), {
          pointer: '/meta/method', wide: true,
          hint: { TH: T('理論模型・計算コード', 'Model or code'), CUR: T('キュレーションの手順(統一した Huff 因子・定数など)', 'Curation procedure (common Huff factor, constants …)'), EVAL: T('評価方法', 'Evaluation method') }[code()],
        }),
        code() === 'EVAL' ? field(T('参照データベース', 'Reference database'), textInput(doc.meta, 'referenceDatabase', { placeholder: 'muND LT curated v1.0.0' }), {
          pointer: '/meta/referenceDatabase', wide: true, hint: T('評価の入力に使ったキュレーションデータのセット', 'The set of curated data the evaluation is based on'),
        }) : null,
        field(T('コメント', 'Comment'), textInput(doc.meta, 'comment', { area: true, rows: 2 }), { pointer: '/meta/comment', wide: true }),
      ];
    }
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, exp ? T('実験条件', 'Experimental conditions') : T('値の導出方法', 'How the values were obtained'))),
      h('div', { class: 'card-body' }, h('div', { class: 'form-cols' }, body),
        h('datalist', { id: listId }, methods.map((m) => h('option', { value: m })))));
  }

  // ---- form: data grid ----------------------------------------------------------------------
  const newRowDefaults = { kind: 'lifetime', unit: 'ns' };
  const gridBody = h('tbody');
  const gridHead = h('thead');
  const gridCount = h('span', { class: 'tag' });
  let evalIndex = null;

  function buildEvalIndex() {
    evalIndex = new Map();
    if (code() === 'EVAL') return;
    const p = physics();
    for (const r of db().rows(doc.sublibrary)) {
      if (r.dataset !== 'EVAL') continue;
      const nuclide = r.row.nuclide || {};
      const block = quantity(r.row);
      if (!block) continue;
      const z = db().zOf(nuclide.element);
      const c = p.convert(z, nuclide.mass, r.row.observable.kind, block.value, combinedUncertainty(block.uncertainties), block.unit);
      if (!c) continue;
      if (!evalIndex.has(z)) evalIndex.set(z, []);
      evalIndex.get(z).push({ a: nuclide.mass, rate: c['capture_rate_us-1'], unc: c['capture_rate_us-1_unc'] || 0 });
    }
  }

  /** Compare with the evaluated value of the same nuclide to catch typing errors. */
  function plausibility(row, conv) {
    if (!conv || !evalIndex) return null;
    const nuclide = nuclideOf(row);
    const z = db().zOf(nuclide.element);
    const refs = evalIndex.get(z);
    if (!refs || !refs.length) return null;
    const a = effectiveMass(z, nuclide.mass, tables().monoisotopic);
    const rate = conv['capture_rate_us-1'];
    const sigma = conv['capture_rate_us-1_unc'] || 0;
    let low;
    let high;
    let text;
    const exact = refs.find((r) => r.a === a);
    if (exact) {
      low = high = exact.rate;
      text = `EVAL ${formatDerived(exact.rate, exact.unc).text} µs⁻¹`;
      const margin = 5 * Math.hypot(sigma, exact.unc);
      low -= margin; high += margin;
    } else if (a === 0) {
      low = Math.min(...refs.map((r) => r.rate));
      high = Math.max(...refs.map((r) => r.rate));
      text = `EVAL ${formatDerived(low, null).text}–${formatDerived(high, null).text} µs⁻¹ (${T('同位体', 'isotopes')})`;
      low -= 5 * sigma; high += 5 * sigma;
    } else {
      return null;
    }
    const ok = rate >= low * 0.75 && rate <= high * 1.25;
    return { ok, text: `${T('この行', 'this row')}: ${formatDerived(rate, sigma || null).text} µs⁻¹ / ${text}` };
  }

  function buildRow(row, index) {
    const nuclide = nuclideOf(row);
    blockOf(row);
    const view = { row, cells: {} };
    const bind = (el, fn) => {
      el.addEventListener('input', () => { fn(el.value); refreshRow(view); storeSoon(); });
      return el;
    };
    const cells = view.cells;
    cells.element = bind(h('input', { type: 'text', class: 'c-el', value: nuclide.element || '', list: 'element-list', spellcheck: 'false', autocomplete: 'off' }),
      (v) => { nuclideOf(row).element = v.trim() ? ids.normalizeElement(v) : ''; });
    cells.element.addEventListener('change', () => { cells.element.value = nuclideOf(row).element || ''; });
    cells.mass = bind(h('input', { type: 'text', class: 'c-a', inputmode: 'numeric', value: numberField(nuclide, 'mass'), title: T('0 = 天然同位体比', '0 = natural abundance') }),
      (v) => {
        const t = v.trim();
        if (t === '') delete nuclideOf(row).mass;
        else nuclideOf(row).mass = /^\d+$/.test(t) ? Number(t) : t;
      });
    cells.isomer = bind(h('input', { type: 'text', class: 'c-m', inputmode: 'numeric', value: numberField(nuclide, 'isomer'), title: T('0 = 基底状態', '0 = ground state') }),
      (v) => {
        const t = v.trim();
        nuclideOf(row).isomer = t === '' ? 0 : (/^\d+$/.test(t) ? Number(t) : t);
      });
    cells.unit = h('select', { class: 'c-unit' });
    const fillUnits = () => {
      const block = blockOf(row);
      const units = unitsOf(row.observable.kind);
      if (!units.includes(block.unit)) block.unit = units[0];
      replace(cells.unit, units.map((u) => h('option', { value: u, selected: block.unit === u }, UNIT_LABELS[u])));
    };
    fillUnits();
    cells.unit.addEventListener('change', () => { blockOf(row).unit = cells.unit.value; refreshRow(view); storeSoon(); });
    cells.kind = h('select', { class: 'c-obs' }, OBSERVABLES.map((o) => h('option', { value: o, selected: row.observable.kind === o }, OBSERVABLE_LABELS[o])));
    cells.kind.addEventListener('change', () => { setKind(row, cells.kind.value); fillUnits(); refreshRow(view); storeSoon(); });
    cells.value = bind(h('input', { type: 'text', class: 'c-num', inputmode: 'decimal', value: numberField(blockOf(row), 'value') }),
      (v) => setNumberField(blockOf(row), 'value', v));
    const uncInput = (source, placeholder) => bind(h('input', {
      type: 'text', class: 'c-num c-unc', inputmode: 'decimal', value: uncertaintyText(blockOf(row), source), placeholder,
    }), (v) => setUncertainty(blockOf(row), source, v));
    cells.total = uncInput('total', T('なし', 'none'));
    cells.stat = uncInput('statistical', 'stat');
    cells.syst = uncInput('systematic', 'syst');
    cells.key = bind(h('input', { type: 'text', class: 'c-key', value: row.key || '', spellcheck: 'false' }), (v) => { row.key = v; });
    cells.comment = bind(h('input', { type: 'text', class: 'c-comment', value: row.comment || '' }), (v) => { row.comment = v; });
    const withOriginal = code() === 'CUR' || code() === 'EVAL';
    if (withOriginal) {
      cells.original = bind(h('input', { type: 'text', class: 'c-orig mono', value: (row.originalData || []).join(', '), spellcheck: 'false', placeholder: code() === 'CUR' ? T('元データの datasetId', 'datasetIds of the original data') : '' }),
        (v) => {
          const list = v.split(/[\s,;]+/).filter(Boolean);
          if (list.length) row.originalData = list; else delete row.originalData;
        });
    }
    view.conv = h('td', { class: 'num small muted c-conv' });
    view.check = h('td', { class: 'c-check' });
    view.id = h('td', { class: 'mono small muted c-id' });
    view.tr = h('tr', null,
      h('td', { class: 'num muted small' }, String(index + 1)),
      h('td', null, cells.element), h('td', null, cells.mass),
      show.isomer ? h('td', null, cells.isomer) : null,
      h('td', null, cells.kind), h('td', null, cells.value), h('td', null, cells.total),
      show.parts ? h('td', null, cells.stat) : null, show.parts ? h('td', null, cells.syst) : null,
      h('td', null, cells.unit), h('td', null, cells.key), h('td', null, cells.comment),
      withOriginal ? h('td', null, h('div', { class: 'input-row' }, cells.original,
        h('button', { class: 'btn small', type: 'button', title: T('実験データから選ぶ', 'Pick from the experimental data'), onclick: () => pickOriginal(view) }, '…'))) : null,
      view.conv, view.check, view.id,
      h('td', { class: 'nowrap' },
        h('button', { class: 'btn small ghost', type: 'button', title: T('この行を複製', 'Duplicate this row'), onclick: () => {
          const copy = jsonfmt.clone(row);
          delete copy.datasetId; delete copy.legacyIds;
          doc.data.splice(index + 1, 0, copy);
          renderGrid(); store();
        } }, '⧉'),
        h('button', { class: 'btn small ghost', type: 'button', title: T('この行を削除', 'Delete this row'), onclick: () => {
          doc.data.splice(index, 1);
          renderGrid(); store();
        } }, '✕')));
    return view;
  }

  function refreshRow(view) {
    const { row } = view;
    const nuclide = nuclideOf(row);
    const block = blockOf(row);
    const z = db().zOf(nuclide.element);
    let conv = null;
    const numeric = typeof block.value === 'number' && block.uncertainties.every((u) => u && typeof u.value === 'number');
    if (z && numeric) {
      conv = physics().convert(z, typeof nuclide.mass === 'number' ? nuclide.mass : 0, row.observable.kind, block.value,
        combinedUncertainty(block.uncertainties), block.unit);
    }
    if (conv) {
      view.conv.textContent = row.observable.kind === 'lifetime'
        ? `${formatDerived(conv['capture_rate_us-1'], conv['capture_rate_us-1_unc']).text} µs⁻¹`
        : `${formatDerived(conv.lifetime_ns, conv.lifetime_ns_unc).text} ns`;
    } else {
      view.conv.textContent = '';
    }
    const p = plausibility(row, conv);
    replace(view.check, p ? h('span', { class: p.ok ? 'ok' : 'warnmark', title: p.text }, p.ok ? '✓' : T('⚠ 要確認', '⚠ check')) : '');
    view.id.textContent = row.datasetId || '';
  }

  function pickOriginal(view) {
    const { row } = view;
    const element = nuclideOf(row).element;
    const z = db().zOf(element);
    const candidates = [...db().rows(doc.sublibrary)].filter((r) => r.dataset === 'EXP' && r.row.nuclide && db().zOf(r.row.nuclide.element) === z && quantity(r.row));
    const selected = new Set(row.originalData || []);
    const list = h('div', { class: 'pick-list' }, candidates.length ? candidates.map((r) => {
      const box = h('input', { type: 'checkbox', checked: selected.has(r.row.datasetId) });
      box.addEventListener('change', () => { if (box.checked) selected.add(r.row.datasetId); else selected.delete(r.row.datasetId); });
      const a = effectiveMass(z, r.row.nuclide.mass, tables().monoisotopic);
      const block = quantity(r.row);
      return h('label', { class: 'pick-item' }, box,
        h('span', null, nuclideNode(r.row.nuclide.element, a), ` ${formatQuantity(block).text} ${UNIT_LABELS[block.unit] || ''} `,
          r.row.key ? h('span', { class: 'tag' }, r.row.key) : null),
        h('span', { class: 'muted small' }, `${citeLabel(db().reference(r.meta.bibId), r.meta.bibId)} · ${r.row.datasetId}`));
    }) : h('p', { class: 'muted' }, T('この元素の実験データがありません。先に EXP を登録してください。', 'No experimental data for this element yet. Enter the EXP data first.')));
    app.dialog({
      title: T(`元データを選択 (${element || '?'})`, `Original data (${element || '?'})`),
      body: list,
      confirm: T('決定', 'Use selection'),
      onConfirm: () => {
        const chosen = candidates.map((r) => r.row.datasetId).filter((id) => selected.has(id));
        if (chosen.length) row.originalData = chosen; else delete row.originalData;
        view.cells.original.value = chosen.join(', ');
        store();
      },
    });
  }

  function renderGridHead() {
    const withOriginal = code() === 'CUR' || code() === 'EVAL';
    replace(gridHead, h('tr', null,
      h('th', null, '#'), h('th', null, T('元素', 'Element')), h('th', { title: T('0 = 天然同位体比', '0 = natural abundance') }, 'A'),
      show.isomer ? h('th', { title: T('アイソマー (0 = 基底状態)', 'Isomer (0 = ground state)') }, 'm') : null,
      h('th', null, T('物理量', 'Quantity')), h('th', null, T('値', 'Value')),
      h('th', { title: T('全体の不確かさ(1σ)', 'Overall uncertainty (1σ)') }, show.parts ? T('± 全体', '± total') : T('± 不確かさ', '± Uncertainty')),
      show.parts ? h('th', null, T('± 統計', '± stat.')) : null, show.parts ? h('th', null, T('± 系統', '± syst.')) : null,
      h('th', null, T('単位', 'Unit')), h('th', { title: T('同じ核種の行を区別する短い名前', 'Short label separating rows of one nuclide') }, 'Key'),
      h('th', null, T('コメント', 'Comment')),
      withOriginal ? h('th', null, T('元データ', 'Original data')) : null,
      h('th', { class: 'num' }, T('換算値', 'Converted')), h('th', { title: T('評価値との比較(入力ミス検出用)', 'Comparison with the evaluated value (to catch typing errors)') }, T('確認', 'Check')),
      h('th', null, 'datasetId'), h('th', null, '')));
  }

  function renderGrid() {
    rowViews.length = 0;
    clear(gridBody);
    if (doc.data.some((r) => quantity(r) && (quantity(r).uncertainties || []).some((u) => u && u.source !== 'total'))) show.parts = true;
    if (doc.data.some((r) => r.nuclide && r.nuclide.isomer)) show.isomer = true;
    renderGridHead();
    buildEvalIndex();
    doc.data.forEach((row, i) => {
      const view = buildRow(row, i);
      rowViews.push(view);
      gridBody.appendChild(view.tr);
      refreshRow(view);
    });
    gridCount.textContent = String(doc.data.length);
  }

  function addRow() {
    const last = doc.data[doc.data.length - 1];
    doc.data.push(newRow(last ? nuclideOf(last).element : '', 0, newRowDefaults.kind, newRowDefaults.unit));
    renderGrid();
    const view = rowViews[rowViews.length - 1];
    view.cells.element.focus();
    view.cells.element.select();
  }

  function pasteDialog() {
    const area = h('textarea', { rows: 10, spellcheck: 'false', placeholder: 'Si\t28\t743.9\t5.0\nSi\t29\t794.2\t3.5\nnatSi\t751.6\t1.0\tplate' });
    const info = h('p', { class: 'small muted' });
    const update = () => {
      const { rows, skipped } = parsePastedRows(area.value, tables().elements);
      info.textContent = T(`${rows.length} 行を読み取りました`, `${rows.length} row(s) recognised`)
        + (skipped.length ? T(`、${skipped.length} 行は読めませんでした: `, `, ${skipped.length} not understood: `) + skipped.slice(0, 3).join(' / ') : '');
    };
    area.addEventListener('input', update);
    app.dialog({
      title: T('表計算ソフトから貼り付け', 'Paste from a spreadsheet'),
      body: h('div', { class: 'stack' },
        h('p', { class: 'small' }, T('列の順番: 元素, 質量数, 値, 不確かさ, [Key], [コメント]。元素は 28Si / Si-28 / natSi の形でも構いません(その場合、質量数の列は不要)。物理量と単位は「新しい行の既定値」が使われます。',
          'Columns: element, mass number, value, uncertainty, [key], [comment]. The element may be written as 28Si / Si-28 / natSi (then leave out the mass column). Quantity and unit are taken from “defaults for new rows”.')),
        area, info),
      confirm: T('追加', 'Add rows'),
      onConfirm: () => {
        const { rows } = parsePastedRows(area.value, tables().elements);
        for (const r of rows) {
          const row = newRow(r.element, r.mass, newRowDefaults.kind, newRowDefaults.unit);
          setNumberField(blockOf(row), 'value', r.value);
          if (r.uncertainty) setUncertainty(blockOf(row), 'total', r.uncertainty);
          if (r.key) row.key = r.key;
          if (r.comment) row.comment = r.comment;
          doc.data.push(row);
        }
        renderGrid(); store();
      },
    });
    area.focus();
  }

  function sortRows() {
    const z = (r) => db().zOf(nuclideOf(r).element) || 999;
    doc.data.sort((a, b) => z(a) - z(b) || (Number(nuclideOf(a).mass) || 0) - (Number(nuclideOf(b).mass) || 0)
      || String(a.key || '').localeCompare(String(b.key || '')));
    renderGrid(); store();
  }

  function dataCard() {
    const obs = h('select', null, OBSERVABLES.map((o) => h('option', { value: o, selected: newRowDefaults.kind === o }, OBSERVABLE_LABELS[o])));
    const unit = h('select');
    const fill = () => {
      const units = unitsOf(newRowDefaults.kind);
      if (!units.includes(newRowDefaults.unit)) newRowDefaults.unit = units[0];
      replace(unit, units.map((u) => h('option', { value: u, selected: newRowDefaults.unit === u }, UNIT_LABELS[u])));
    };
    const lastRow = doc.data[doc.data.length - 1];
    if (lastRow && quantity(lastRow)) {
      newRowDefaults.kind = lastRow.observable.kind;
      newRowDefaults.unit = quantity(lastRow).unit;
    } else if (code() === 'CUR' || code() === 'EVAL') {
      newRowDefaults.kind = 'capture_rate';     // curated and evaluated data are given as capture rates
      newRowDefaults.unit = 'us-1';
    }
    obs.value = newRowDefaults.kind;
    fill();
    obs.addEventListener('change', () => { newRowDefaults.kind = obs.value; fill(); });
    unit.addEventListener('change', () => { newRowDefaults.unit = unit.value; });
    renderGrid();
    const toggle = (key, label) => {
      const box = h('input', { type: 'checkbox', checked: show[key] });
      box.addEventListener('change', () => { show[key] = box.checked; renderGrid(); });
      return h('label', { class: 'check small' }, box, label);
    };
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', null, T('データ ', 'Data entries '), gridCount),
        h('div', { class: 'row' },
          toggle('parts', T('統計・系統誤差を分けて入力', 'Separate statistical / systematic')),
          toggle('isomer', T('アイソマー', 'Isomers')),
          h('span', { class: 'small muted' }, T('新しい行の既定値', 'Defaults for new rows')), obs, unit,
          h('button', { class: 'btn', type: 'button', onclick: addRow }, T('+ 行を追加', '+ Add row')),
          h('button', { class: 'btn', type: 'button', onclick: pasteDialog }, T('貼り付け…', 'Paste …')),
          h('button', { class: 'btn ghost', type: 'button', onclick: sortRows, title: T('Z・A の順に並べ替え', 'Sort by Z and A') }, T('並べ替え', 'Sort')))),
      h('div', { class: 'table-wrap grid-wrap' }, h('table', { class: 'data grid' }, gridHead, gridBody)),
      h('datalist', { id: 'element-list' }, tables().elements.map((e) => h('option', { value: e }))),
      h('div', { class: 'card-body small muted' },
        T('値と不確かさは論文に書かれた桁のまま入力してください(例: 13.250)。A = 0 は天然同位体比の標的です。論文が統計誤差と系統誤差を分けている場合は分けて入力します(換算値には二乗和を使います)。実験データには論文に最も近い物理量を1つだけ入力し、キュレーション・評価データは捕獲率に統一します。',
          'Type value and uncertainty with the digits given in the paper (e.g. 13.250). A = 0 means a target of natural abundance. If the paper separates statistical and systematic uncertainties, enter them separately (converted values use their sum in quadrature). Experimental entries hold the one quantity closest to the publication; curated and evaluated entries are given as capture rates.')));
  }

  // ---- checks -----------------------------------------------------------------------------
  const issuesEl = h('section', { class: 'card issues-card' });

  /** The input that an issue points at. */
  function controlFor(pointer) {
    if (controls.has(pointer)) return controls.get(pointer);
    const m = /^\/data\/(\d+)(?:\/(.*))?$/.exec(pointer);
    if (m) {
      const view = rowViews[Number(m[1])];
      if (!view) return null;
      const rest = m[2] || '';
      const c = view.cells;
      if (rest.startsWith('nuclide/mass')) return c.mass;
      if (rest.startsWith('nuclide/isomer')) return show.isomer ? c.isomer : c.element;
      if (rest.startsWith('nuclide')) return c.element;
      const q = /^observable\/[^/]+\/(value|unit|uncertainties)(?:\/(\d+))?/.exec(rest);
      if (q) {
        if (q[1] === 'value') return c.value;
        if (q[1] === 'unit') return c.unit;
        const entry = q[2] !== undefined ? blockOf(view.row).uncertainties[Number(q[2])] : null;
        if (show.parts && entry && entry.source === 'statistical') return c.stat;
        if (show.parts && entry && entry.source === 'systematic') return c.syst;
        return c.total;
      }
      if (/^observable\/[^/]+$/.test(rest)) return c.value;
      if (rest.startsWith('observable')) return c.kind;
      if (rest.startsWith('key') || rest === 'datasetId') return c.key;
      if (rest.startsWith('comment')) return c.comment;
      if (rest.startsWith('originalData')) return c.original || c.element;
      return c.element;
    }
    let p = pointer;
    while (p) {
      p = p.slice(0, p.lastIndexOf('/'));
      if (controls.has(p)) return controls.get(p);
    }
    return null;
  }

  function refreshComputed() {
    const mid = expectedMetaId(doc);
    const valid = mid && DOI_RE.test(bibId());
    metaIdEl.textContent = valid ? mid : '—';
    metaSourceEl.textContent = valid ? `← ${ids.metaSource(doc.sublibrary, code(), doc.meta.bibId, doc.meta.key)}` : '';
    pathEl.textContent = path || T('(DOI を入力すると保存先が決まります)', '(enter a DOI to create the file)');
    const stored = db().reference(bibId());
    titleEl.textContent = firstAuthor(stored) ? citeLabel(stored, bibId()) : (isNew() ? T('新しいデータセット', 'New dataset') : bibId());
    citeEl.textContent = firstAuthor(stored) ? ` · ${citeText(stored, bibId())}` : '';
    const state = path ? workspace.status(path) : 'new';
    statusEl.textContent = { unchanged: T('変更なし', 'unchanged'), modified: T('変更あり(未コミット)', 'modified (not committed)'),
      added: T('新規(未コミット)', 'new (not committed)'), deleted: T('削除予定', 'to be deleted'), new: T('未保存', 'not stored yet') }[state];
    statusEl.className = `tag ${state}`;
    for (const view of rowViews) view.id.textContent = view.row.datasetId || '';
    gridCount.textContent = String(doc.data.length);
    refreshIssues();
  }

  function refreshIssues() {
    const issues = path ? workspace.issuesFor(path) : [];
    const marked = [...controls.values()];
    for (const view of rowViews) marked.push(...Object.values(view.cells));
    for (const el of marked) {
      el.removeAttribute('aria-invalid');
      el.classList.remove('has-warning');
      if (el._issueTitle) { el.title = ''; el._issueTitle = false; }
    }
    const describe = (issue) => {
      const m = /^\/data\/(\d+)(?:\/(.*))?/.exec(issue.pointer);
      const where = m ? `${T('行', 'row')} ${Number(m[1]) + 1}${m[2] ? ` · ${m[2].split('/').filter((s) => !/^\d+$/.test(s)).slice(-2).join(' ')}` : ''}`
        : issue.pointer.replace(/^\//, '').replace(/\//g, ' › ');
      return { where, text: issue.message };
    };
    const items = issues.map((issue) => {
      const el = controlFor(issue.pointer);
      if (el) {
        if (issue.level === 'error') el.setAttribute('aria-invalid', 'true'); else el.classList.add('has-warning');
        el.title = issue.message; el._issueTitle = true;
      }
      const d = describe(issue);
      return h('li', { class: issue.level },
        h('button', { class: 'link', type: 'button', onclick: () => { if (el) { setTab('form'); el.focus(); el.scrollIntoView({ block: 'center' }); } } },
          h('span', { class: 'issue-mark' }, issue.level === 'error' ? '✕' : '!'), ' ',
          d.where ? h('strong', null, `${d.where}: `) : null, d.text),
        ' ', h('code', { class: 'muted small' }, issue.code));
    });
    const errors = issues.filter((i) => i.level === 'error').length;
    replace(issuesEl,
      h('div', { class: 'card-head' }, h('h2', null, T('チェック結果', 'Checks')),
        h('span', { class: `tag ${errors ? 'bad' : 'good'}` }, !path ? T('未保存', 'not stored')
          : errors ? T(`エラー ${errors} 件`, `${errors} error(s)`)
            : issues.length ? T(`警告 ${issues.length} 件`, `${issues.length} warning(s)`) : T('問題なし', 'all good'))),
      items.length ? h('ul', { class: 'issue-list' }, items)
        : h('div', { class: 'card-body muted small' }, path ? T('スキーマ・ID・参照関係のチェックをすべて通過しています。', 'Format, identifiers and references are all fine.')
          : T('DOI を入力するとチェックが始まります。', 'Checks start once a DOI is entered.')));
  }

  // ---- tabs -------------------------------------------------------------------------------------
  const formEl = h('div', { class: 'stack' });
  const jsonEl = h('div', { class: 'stack', hidden: true });
  const diffEl = h('div', { class: 'stack', hidden: true });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });

  function renderForm() {
    controls.clear();
    replace(formEl, referenceCard(), conditionsCard(), dataCard());
    refreshComputed();
  }

  function currentText() {
    return path ? workspace.text(path) : canonicalText();
  }

  /** Take over the text of the JSON tab. Returns false (and reports) when it is not valid. */
  function applyJson() {
    if (jsonText === null) return true;
    let parsed;
    try {
      parsed = jsonfmt.parse(jsonText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the top level must be an object');
    } catch (err) {
      app.toast(T(`JSON として読めません: ${err.message}`, `Not valid JSON: ${err.message}`), 'bad');
      return false;
    }
    if (!parsed.meta || typeof parsed.meta !== 'object') parsed.meta = { id: '', bibId: '' };
    if (!Array.isArray(parsed.data)) parsed.data = [];
    parsed.data = parsed.data.filter((row) => row && typeof row === 'object');
    // rows keep their place, so identifiers that change are still followed
    parsed.data.forEach((row, i) => {
      const before = doc.data[i] ? openIds.get(doc.data[i]) : null;
      if (before) openIds.set(row, before);
    });
    doc = parsed;
    jsonText = null;
    loadReference();
    store();
    return true;
  }

  async function showJson() {
    const text = jsonText === null ? currentText() : jsonText;
    const holder = h('div', { class: 'monaco-holder' });
    const note = h('span', { class: 'small muted' }, T('エディタを読み込み中…', 'Loading the editor …'));
    replace(jsonEl, h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'JSON'),
        h('div', { class: 'row' }, note,
          h('button', { class: 'btn primary', type: 'button', onclick: () => { if (applyJson()) { app.toast(T('反映しました(ID と書式を整えました)', 'Applied (identifiers and layout updated)')); showJson(); } } }, T('反映', 'Apply')))),
      holder,
      h('div', { class: 'card-body small muted' }, T('ここでの編集は「反映」を押すとフォームに取り込まれます。ID は自動で計算し直され、書式も整えられます。',
        'Edits made here are taken over with “Apply”. Identifiers are recomputed and the layout is normalised.'))));
    try {
      const monaco = await loadMonaco();
      if (destroyed || tab !== 'json') return;
      configureSchemas(monaco, workspace.schemas);
      if (monacoEditor) monacoEditor.dispose();
      monacoEditor = monaco.editor.create(holder, {
        model: modelFor(monaco, path || `data/${doc.sublibrary}/${code()}/new.json`, text),
        theme: monacoTheme(), automaticLayout: true, minimap: { enabled: false }, wordWrap: 'off',
        scrollBeyondLastLine: false, tabSize: 2, fontSize: 13, renderWhitespace: 'none',
      });
      monacoEditor.onDidChangeModelContent(() => { jsonText = monacoEditor.getValue(); });
      note.textContent = T('スキーマに基づく入力補助が有効です(Ctrl+Space)', 'Schema-aware completion is available (Ctrl+Space)');
    } catch (err) {
      if (destroyed) return;
      const area = h('textarea', { class: 'json-fallback mono', spellcheck: 'false', rows: 30 });
      area.value = text;
      area.addEventListener('input', () => { jsonText = area.value; });
      replace(holder, area);
      note.textContent = T(`Monaco Editor を読み込めなかったため簡易エディタを表示しています (${err.message})`,
        `Monaco Editor could not be loaded; using a plain editor (${err.message})`);
    }
  }

  function showDiff() {
    const before = path ? workspace.baseline(path) : null;
    const after = currentText();
    const stats = diffStats(diffLines(before, after));
    replace(diffEl, h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, T('リポジトリとの差分', 'Changes relative to the repository')),
        h('span', { class: 'small muted' }, before === null ? T('新規ファイル', 'new file') : `+${stats.added} / −${stats.removed} ${T('行', 'lines')}`)),
      h('div', { class: 'card-body' }, renderDiff(before, after, 2))));
  }

  function setTab(next) {
    if (next === tab) return;
    if (tab === 'json' && !applyJson()) return;
    if (tab === 'json' && next === 'form') renderForm();
    tab = next;
    formEl.hidden = tab !== 'form';
    jsonEl.hidden = tab !== 'json';
    diffEl.hidden = tab !== 'diff';
    renderTabs();
    if (tab === 'json') { store(); showJson(); }
    if (tab === 'diff') { store(); showDiff(); }
  }

  function renderTabs() {
    const item = (key, label) => h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(tab === key), onclick: () => setTab(key) }, label);
    replace(tabsEl, item('form', T('フォーム', 'Form')), item('json', 'JSON'), item('diff', T('差分', 'Changes')));
  }

  // ---- page ----------------------------------------------------------------------------------------
  function discard() {
    if (!path) { destroyed = true; app.navigate('datasets'); return; }
    if (!confirm(T('このファイルの未コミットの変更を破棄しますか?', 'Discard the uncommitted changes of this file?'))) return;
    const origin = workspace.drafts.get(path) && workspace.drafts.get(path).origin;
    destroyed = true;                          // nothing of this editor may be stored any more
    workspace.discard(path);
    if (origin) workspace.discard(origin);
    app.navigate('datasets');
  }

  function remove() {
    if (!path) { destroyed = true; app.navigate('datasets'); return; }
    if (!confirm(T(`${path} を削除しますか? (コミットするまでリポジトリには反映されません)`, `Delete ${path}? (Nothing changes in the repository before you commit.)`))) return;
    destroyed = true;
    const origin = workspace.drafts.get(path) && workspace.drafts.get(path).origin;
    workspace.stageDelete(path);
    if (origin) workspace.stageDelete(origin);
    app.navigate('datasets');
  }

  replace(container,
    h('div', { class: 'editor-head' },
      h('a', { class: 'btn ghost', href: '#/datasets' }, T('← 一覧', '← List')),
      h('div', { class: 'editor-title' },
        h('h1', null, titleEl, ' ', h('span', { class: 'tag' }, `${doc.sublibrary} / ${code()}`), ' ', statusEl),
        h('p', { class: 'small muted' }, pathEl, citeEl)),
      h('span', { class: 'spacer' }),
      path ? h('a', { class: 'btn', href: `#/history?path=${encodeURIComponent(path)}` }, T('履歴', 'History')) : null,
      h('button', { class: 'btn', type: 'button', onclick: discard }, T('変更を破棄', 'Discard changes')),
      h('button', { class: 'btn danger', type: 'button', onclick: remove }, T('削除', 'Delete'))),
    tabsEl, formEl, jsonEl, diffEl, issuesEl);
  renderTabs();
  renderForm();
  if (isNew() && !doc.meta.bibId) {
    const doi = controls.get('/meta/bibId');
    if (doi) doi.focus();
  }

  return {
    get path() { return path; },
    /** Make sure pending edits are stored (called before leaving the page). */
    flush() {
      if (destroyed) return true;
      leaving = true;
      try {
        if (tab === 'json' && !applyJson()) return false;
        store();
        return true;
      } finally {
        leaving = false;
      }
    },
    destroy() {
      destroyed = true;
      if (monacoEditor) monacoEditor.dispose();
    },
  };
}
