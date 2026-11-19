// The 文献 (reference) card of the editor: kind of data, DOI, key, related
// DOIs, and the bibliography entry of the DOI (data/master/bibliography.json),
// which is edited here and stored with save().

import { h, replace } from '../../site/assets/js/core/dom.js';
import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import * as ids from '../../site/assets/js/core/ids.js';
import { CODES, CODE_TITLES, TYPE_OF } from '../../site/assets/js/core/vocabulary.js';
import { expectedMetaId, fileCode } from '../../site/assets/js/core/database.js';
import { isPlaceholderDoi, asciiLabel, firstAuthor, referenceYear } from '../../site/assets/js/core/cite.js';
import { T } from './i18n.js';
import { field, textInput } from './form.js';
import { setDatasetType } from './document.js';
import { lookupDoi } from './crossref.js';

const REFERENCE_TYPES = ['journal-article', 'proceedings-article', 'report', 'dissertation', 'book-chapter', 'posted-content'];

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

/**
 * workspace     the Workspace (bibliography look-ups, storing the entry)
 * controls      Map JSON pointer -> control, filled with the metadata controls of the card
 * isDoi(text)   whether text is a valid DOI
 * markDirty()   called after every edit
 * onTypeChange()  called after the datasetType changed (the rest of the form depends on it)
 */
export function referencePart({ workspace, controls, isDoi, markDirty, onTypeChange }) {
  let reference = { DOI: '' };        // the bibliography entry shown and edited
  let edited = false;                 // it differs from what the bibliography holds
  let fieldsEl = null;
  const metaIdEl = h('code', { class: 'computed' });
  const metaSourceEl = h('span', { class: 'muted small mono' });
  const lookupStatus = h('span', { class: 'small muted', role: 'status' });

  /** Show the bibliography entry of `doi` (an empty one when there is none). */
  function load(doi) {
    const found = workspace.db.reference(doi);
    reference = found ? jsonfmt.clone(found) : { DOI: doi };
    edited = false;
  }

  /** Stage the entry under `doi` when it was edited. */
  function save(doi) {
    if (!edited || !isDoi(doi)) return;
    edited = false;
    reference.DOI = doi;
    workspace.setReference(jsonfmt.clone(reference));
  }

  function edit() {
    edited = true;
    markDirty();
  }

  /** One-element list member of a bibliography entry (Crossref writes titles as lists). */
  function listInput(key, placeholder) {
    const el = h('input', { type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off' });
    el.value = Array.isArray(reference[key]) && reference[key].length ? String(reference[key][0]) : '';
    el.addEventListener('input', () => {
      const v = el.value.trim();
      if (v) reference[key] = [v]; else delete reference[key];
      edit();
    });
    return el;
  }

  function renderFields() {
    const authors = h('textarea', { rows: 3, spellcheck: 'false', placeholder: 'Suzuki, T.\nMeasday, D. F.' });
    authors.value = authorsToText(reference.author);
    authors.addEventListener('input', () => {
      const list = textToAuthors(authors.value);
      if (list.length) reference.author = list; else delete reference.author;
      edit();
    });
    const year = h('input', { type: 'text', inputmode: 'numeric', placeholder: '1987' });
    year.value = referenceYear(reference) || '';
    year.addEventListener('input', () => {
      const v = year.value.trim();
      const parts = reference.published && reference.published['date-parts'];
      const rest = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0].slice(1) : [];
      if (/^\d{4}$/.test(v)) reference.published = { 'date-parts': [[Number(v), ...rest]] };
      else delete reference.published;
      edit();
    });
    const input = (key, placeholder, list) => textInput(reference, key, edit, { placeholder, list });
    replace(fieldsEl,
      field(T('著者(1行に1人、「姓, 名」)', 'Authors (one per line: Family, Given)'), authors, { wide: true }),
      field(T('タイトル', 'Title'), listInput('title'), { wide: true }),
      field(T('雑誌名', 'Journal'), listInput('container-title', 'Physical Review C')),
      field(T('雑誌名(略称)', 'Journal (abbreviated)'), listInput('short-container-title', 'Phys. Rev. C')),
      field(T('巻', 'Volume'), input('volume')),
      field(T('ページ', 'Pages'), input('page', '2212-2224')),
      field(T('論文番号', 'Article number'), input('article-number', '024307')),
      field(T('年', 'Year'), year),
      field(T('種類', 'Type'), input('type', 'journal-article', 'reference-types')),
      field('URL', input('URL', 'https://…'), { hint: T('DOI がない文献の所在', 'Where to find a source without DOI') }),
      h('datalist', { id: 'reference-types' }, REFERENCE_TYPES.map((t) => h('option', { value: t }))));
  }

  /** The card for `doc`; `isNew`: the file has not been saved yet. */
  function card(doc, { isNew }) {
    const bibId = () => String(doc.meta.bibId || '').trim();

    async function lookup() {
      const doi = bibId();
      if (!isDoi(doi)) { lookupStatus.textContent = T('DOI を入力してください', 'Enter a DOI first'); return; }
      if (isPlaceholderDoi(doi)) {
        lookupStatus.textContent = T('仮 DOI のため検索できません。書誌情報を手入力してください。',
          'Placeholder DOI: please type the bibliographic data.');
        return;
      }
      lookupStatus.textContent = T('検索中…', 'Looking up …');
      try {
        const found = await lookupDoi(doi);
        if (!lookupStatus.isConnected) return;          // the editor was left meanwhile
        if (!found) { lookupStatus.textContent = T('見つかりませんでした', 'Not found'); return; }
        reference = found.reference;
        renderFields();
        lookupStatus.textContent = T(`${found.source} から取得しました。内容を確認してください。`, `Filled from ${found.source}. Please check.`);
        edit();
      } catch (err) {
        if (!lookupStatus.isConnected) return;
        lookupStatus.textContent = T(`取得できませんでした (${err.message})。手入力してください。`,
          `Lookup failed (${err.message}). Please type the data.`);
      }
    }

    function placeholderDoi() {
      const slug = prompt(T('DOI のない文献の識別名(英数字)。例: Suzuki1975thesis',
        'Short name for a source without DOI (letters and digits), e.g. Suzuki1975thesis'),
      `${asciiLabel(firstAuthor(reference))}${referenceYear(reference) || ''}`);
      const name = slug ? asciiLabel(slug) : '';
      if (!name) return;
      doc.meta.bibId = `10.1000/mund.${name}`;
      doi.value = doc.meta.bibId;
      reference.DOI = doc.meta.bibId;
      edited = Object.keys(reference).length > 1;     // bibliographic data typed so far belong to it
      markDirty();
    }

    const dataset = h('select', {
      disabled: !isNew,
      onchange: (e) => {
        setDatasetType(doc, e.target.value);
        markDirty();
        onTypeChange();
      },
    }, CODES.map((c) => h('option', { value: c, selected: fileCode(doc) === c }, `${c} – ${CODE_TITLES[c]} (${TYPE_OF[c]})`)));
    controls.set('/datasetType', dataset);

    const doi = textInput(doc.meta, 'bibId', markDirty, { placeholder: '10.1103/PhysRevC.35.2212' });
    doi.addEventListener('change', () => {
      doi.value = doc.meta.bibId = doi.value.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
      if (!edited) load(doc.meta.bibId);               // the bibliography entry of the new DOI, if there is one
      renderFields();
      markDirty();
    });
    controls.set('/meta/bibId', doi);

    const key = textInput(doc.meta, 'key', markDirty, { placeholder: 'setup-b' });
    controls.set('/meta/key', key);

    const related = h('input', { type: 'text', spellcheck: 'false', placeholder: '10.48550/arXiv.2501.05897' });
    related.value = (Array.isArray(doc.meta.relatedBibIds) ? doc.meta.relatedBibIds : []).join(', ');
    related.addEventListener('input', () => {
      doc.meta.relatedBibIds = related.value.split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean);
      markDirty();
    });
    controls.set('/meta/relatedBibIds', related);

    fieldsEl = h('div', { class: 'form-cols' });
    renderFields();
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, T('文献', 'Reference')),
        h('span', { class: 'muted small' }, T('1論文 = 1ファイル。データは下の表に入力します。', 'One publication = one file. Data entries go into the table below.'))),
      h('div', { class: 'card-body' },
        h('div', { class: 'form-cols' },
          field(T('データ種別 (datasetType)', 'Kind of data (datasetType)'), dataset, {
            hint: !isNew ? T('保存済みのファイルでは変更できません', 'Fixed once the file has been saved') : null,
          }),
          h('div', { class: 'field' }, h('label', { for: 'reference-doi' }, 'DOI (bibId)'),
            h('div', { class: 'input-row' }, Object.assign(doi, { id: 'reference-doi' }),
              h('button', { class: 'btn', type: 'button', onclick: lookup }, T('書誌情報を取得', 'Look up')),
              h('button', { class: 'btn ghost', type: 'button', onclick: placeholderDoi, title: T('DOI のない文献に仮の識別子 10.1000/mund.… を付けます', 'Give a source without DOI a placeholder 10.1000/mund.…') }, T('DOI なし…', 'No DOI …'))),
            lookupStatus),
          field(T('枝番 Key(任意)', 'Key (optional)'), key, {
            hint: T('1つの論文に測定条件の異なるメタデータを複数作る場合だけ使います', 'Only when one publication needs several metadata records (e.g. two set-ups)'),
          }),
          field(T('関連 DOI(arXiv・訂正・データ等)', 'Related DOIs (arXiv, erratum, data …)'), related)),
        h('p', { class: 'computed-line' }, 'MetaID ', metaIdEl, ' ', metaSourceEl),
        h('details', { open: isNew || !firstAuthor(reference) },
          h('summary', null, T('書誌情報(文献データベース bibliography.json に記録されます)', 'Bibliographic data (kept in bibliography.json)')), fieldsEl)));
  }

  /** Show the MetaID that `doc` gets. */
  function refresh(doc) {
    const doi = String(doc.meta.bibId || '').trim();
    const mid = isDoi(doi) ? expectedMetaId(doc) : null;
    metaIdEl.textContent = mid || '—';
    metaSourceEl.textContent = mid ? `← ${ids.metaSource(doc.sublibrary, fileCode(doc), doc.meta.bibId, doc.meta.key)}` : '';
  }

  return {
    load,
    save,
    /** The entry the bibliography holds for the DOI once saved. */
    entry: () => reference,
    card,
    refresh,
  };
}
