// The 文献 (reference) card of the editor: kind of data, the source (bibId: DOI:<DOI>;
// without a DOI NSR:<keynumber>; found in neither muND:<name>), key, related
// sources, and the bibliography entry of the source (data/master/bibliography.json),
// which is edited here and stored with save().  An entry no file names any more
// is removed by the workspace (workspace.js).

import { h, replace, externalLink, card as domCard } from '../../site/assets/js/core/dom.js';
import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import * as ids from '../../site/assets/js/core/ids.js';
import { CODES, TYPE_OF } from '../../site/assets/js/core/vocabulary.js';
import { expectedMetaId, fileCode } from '../../site/assets/js/core/database.js';
import { bibKind, bibName, bibUrl, isBibId, asciiLabel, firstAuthor, referenceYear } from '../../site/assets/js/core/cite.js';
import { T, codeTitle } from './i18n.js';
import { field, textInput } from './form.js';
import { setDatasetType, sourceText } from './document.js';
import { lookupDoi } from './crossref.js';

const REFERENCE_TYPES = ['journal-article', 'proceedings-article', 'report', 'dissertation', 'book-chapter', 'posted-content'];

/** How a source is named. */
const SOURCE_HINT = () => T('DOI:10.1103/… の形。DOI がなければ NSR のキー番号を NSR:1987SU06 の形で、どちらもなければ「DOI なし…」で muND:名前。DOI・doi.org のアドレス・キー番号だけを入れても前置きが付きます',
  'DOI:10.1103/…; without a DOI, the NSR keynumber as NSR:1987SU06; found in neither, muND:<name> (“No DOI …”). A bare DOI, doi.org address or keynumber gets its prefix.');

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
 * markDirty()   called after every edit
 * onTypeChange()  called after the datasetType changed (the rest of the form depends on it)
 */
export function referencePart({ workspace, controls, markDirty, onTypeChange }) {
  let reference = { id: '' };         // the bibliography entry shown and edited
  let edited = false;                 // it differs from what the bibliography holds
  let follows = false;                // that entry was staged while its source was still being typed: it moves with the source
  let fieldsEl = null;
  const metaIdEl = h('code', { class: 'computed' });
  const metaSourceEl = h('span', { class: 'muted small mono' });
  const bibNotice = h('p', { class: 'notice bad', role: 'alert', hidden: true },
    T('文献データベース data/master/bibliography.json に誤りがあるため、書誌情報を保持できません。マスタデータの「ファイルを直接編集」で直してください。',
      'The bibliography (data/master/bibliography.json) has errors. To keep these bibliographic fields, correct the file under Master data → Edit files directly.'));
  const lookupStatus = h('span', { class: 'small muted', role: 'status' });

  /** Show the bibliography entry of `bibId` (an empty one when there is none). */
  function load(bibId) {
    const found = workspace.db.reference(bibId);
    reference = found ? jsonfmt.clone(found) : { id: bibId };
    edited = false;
    follows = false;
    bibNotice.hidden = true;
  }

  /**
   * The entry that belongs to the source `bibId`; the card turns to it.  Data typed and not
   * stored yet belong to it, and so does an entry staged while the source was still being
   * typed, unless the source has an entry of its own.  Otherwise it is the source's entry in
   * the bibliography (an empty one when there is none).
   */
  function entryFor(bibId) {
    if (!edited && ids.normalizeBibId(reference.id || '') !== ids.normalizeBibId(bibId)) {
      if (follows && !workspace.db.reference(bibId)) edited = true;
      else load(bibId);
    }
    return reference;
  }

  /** Stage the entry of `bibId` (entryFor) when it was edited. */
  function save(bibId) {
    if (!isBibId(bibId)) return;
    entryFor(bibId);
    if (!edited) return;
    const { id, ...rest } = reference;
    bibNotice.hidden = workspace.setReference(jsonfmt.clone({ id: bibId, ...rest }));
    if (!bibNotice.hidden) return;
    follows = ids.normalizeBibId(id || '') !== ids.normalizeBibId(bibId);
    edited = false;
    reference.id = bibId;
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
    const parts = reference.published && reference.published['date-parts'];
    const rest = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0].slice(1) : [];
    year.addEventListener('input', () => {
      const v = year.value.trim();
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
      field('URL', input('URL', 'https://…'), { hint: T('muND:… の文献の所在', 'Where to find a source named muND:…') }),
      h('datalist', { id: 'reference-types' }, REFERENCE_TYPES.map((t) => h('option', { value: t }))));
  }

  /** The card for `doc`; `isNew`: the file has not been saved yet. */
  function card(doc, { isNew }) {
    const bibId = () => String(doc.meta.bibId || '').trim();

    async function lookup() {
      const source = bibId();
      if (!isBibId(source)) { lookupStatus.textContent = SOURCE_HINT(); return; }
      if (bibKind(source) === 'NSR') {
        replace(lookupStatus, T('NSR のページで書誌情報を確かめ、手入力してください: ', 'Check the bibliographic data on its NSR page and type them: '),
          externalLink(bibUrl(source), source));
        return;
      }
      if (bibKind(source) === 'muND') {
        lookupStatus.textContent = T('muND の識別子です。書誌情報を手入力してください。', 'A muND key: please type the bibliographic data.');
        return;
      }
      lookupStatus.textContent = T('検索中…', 'Looking up …');
      const current = () => lookupStatus.isConnected && ids.normalizeBibId(bibId()) === ids.normalizeBibId(source);
      try {
        const found = await lookupDoi(bibName(source));
        if (!current()) return;
        if (!found) { lookupStatus.textContent = T('見つかりませんでした', 'Not found'); return; }
        reference = found.reference;
        renderFields();
        lookupStatus.textContent = T(`${found.source} から取得しました。内容を確認してください。`, `Filled from ${found.source}. Please check.`);
        edit();
      } catch (err) {
        if (!current()) return;
        lookupStatus.textContent = T(`取得できませんでした (${err.message})。手入力してください。`,
          `Lookup failed (${err.message}). Please type the data.`);
      }
    }

    function muNDKey() {
      const slug = prompt(T('DOI も NSR のキー番号もない文献の識別名(英数字)。例: Suzuki1975thesis',
        'Short name for a source with neither DOI nor NSR keynumber (letters and digits), e.g. Suzuki1975thesis'),
      `${asciiLabel(firstAuthor(reference))}${referenceYear(reference) || ''}`);
      const name = slug ? asciiLabel(slug) : '';
      if (!name) return;
      doc.meta.bibId = `muND:${name}`;
      doi.value = doc.meta.bibId;
      reference.id = doc.meta.bibId;
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
    }, CODES.map((c) => h('option', { value: c, selected: fileCode(doc) === c }, `${c} – ${codeTitle(c)} (${TYPE_OF[c]})`)));
    controls.set('/datasetType', dataset);

    const doi = textInput(doc.meta, 'bibId', markDirty, { placeholder: 'DOI:10.1103/PhysRevC.35.2212' });
    doi.addEventListener('change', () => {
      lookupStatus.textContent = '';
      doi.value = doc.meta.bibId = sourceText(doi.value);
      entryFor(doc.meta.bibId);
      renderFields();
      markDirty();
    });
    controls.set('/meta/bibId', doi);

    const key = textInput(doc.meta, 'key', markDirty, { placeholder: 'setup-b' });
    controls.set('/meta/key', key);

    const related = h('input', { type: 'text', spellcheck: 'false', placeholder: 'DOI:10.48550/arXiv.2501.05897' });
    related.value = (Array.isArray(doc.meta.relatedBibIds) ? doc.meta.relatedBibIds : []).join(', ');
    related.addEventListener('input', () => {
      doc.meta.relatedBibIds = related.value.split(/[\s,;]+/).map(sourceText).filter(Boolean);
      markDirty();
    });
    controls.set('/meta/relatedBibIds', related);

    fieldsEl = h('div', { class: 'form-cols' });
    renderFields();
    return domCard({
      title: T('文献', 'Reference'),
      controls: h('span', { class: 'muted small' }, T('1ファイルに1件のメタデータを記録します。この測定条件のデータは下の表に入力します。', 'Each file holds one metadata record. Enter the data for this set-up in the table below.')),
    },
      h('div', { class: 'card-body' },
        h('div', { class: 'form-cols' },
          field(T('データ種別 (datasetType)', 'Kind of data (datasetType)'), dataset, {
            hint: !isNew ? T('保存済みのファイルでは変更できません', 'Fixed once the file has been saved') : null,
          }),
          h('div', { class: 'field' }, h('label', { for: 'reference-doi' }, T('文献 (bibId)', 'Source (bibId)')),
            h('div', { class: 'input-row' }, Object.assign(doi, { id: 'reference-doi' }),
              h('button', { class: 'btn', type: 'button', onclick: lookup }, T('書誌情報を取得', 'Look up')),
              h('button', { class: 'btn ghost', type: 'button', onclick: muNDKey, title: T('DOI も NSR のキー番号もない文献に muND:… の識別子を付けます', 'Name a source with neither DOI nor NSR keynumber muND:…') }, T('DOI なし…', 'No DOI …'))),
            h('p', { class: 'hint' }, SOURCE_HINT()), lookupStatus),
          field(T('枝番 Key(任意)', 'Key (optional)'), key, {
            hint: T('1つの論文に測定条件の異なるメタデータを複数作る場合だけ使います', 'Only when one publication needs several metadata records (e.g. two set-ups)'),
          }),
          field(T('関連する文献(arXiv・訂正・データ等の DOI)', 'Related sources (DOIs of arXiv, erratum, data …)'), related)),
        bibNotice,
        h('p', { class: 'computed-line' }, 'MetaID ', metaIdEl, ' ', metaSourceEl),
        h('details', { open: isNew || !firstAuthor(reference) },
          h('summary', null, T('書誌情報(文献データベース bibliography.json に記録されます)', 'Bibliographic data (kept in bibliography.json)')), fieldsEl)));
  }

  /** Show the MetaID that `doc` gets. */
  function refresh(doc) {
    const doi = String(doc.meta.bibId || '').trim();
    const mid = isBibId(doi) ? expectedMetaId(doc) : null;
    metaIdEl.textContent = mid || '—';
    metaSourceEl.textContent = mid ? `← ${ids.metaSource(doc.sublibrary, fileCode(doc), doc.meta.bibId, doc.meta.key)}` : '';
  }

  return {
    load,
    save,
    entryFor,
    card,
    refresh,
  };
}
