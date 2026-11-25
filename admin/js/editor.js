// Editor of one dataset file: the form (reference card, conditions, data
// grid) and the JSON text.
//
// Every edit marks the document dirty; a quarter of a second later (and when
// the page is left) the document is stored as a draft in the workspace under
// its canonical file name.  The 保存 (save) card above the form shows the
// changes since the last save and saves all drafts at once.  A document is stored only once it has a valid bibId, and
// never over another registered file.
//
// The document, its file and the identity of its entries are held by a Draft
// (document.js), which follows the entries by datasetId.  When the
// identifiers of a saved entry change, the editor asks whether it is a
// correction of the same entry or different data, and neither saves nor lets
// the page be left before that is chosen.

import { h, replace, card } from '../../site/assets/js/core/dom.js';
import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import { isObject } from '../../site/assets/js/core/jsonfmt.js';
import { fileCode } from '../../site/assets/js/core/database.js';
import { citeLabel, citeText, firstAuthor } from '../../site/assets/js/core/cite.js';
import { T, statusLabel, issueText, confirmDiscard } from './i18n.js';
import { jsonCard } from './monaco.js';
import { field, textInput, markIssues } from './form.js';
import { Draft, formProblem, referencesTo, entryLabel, fileName } from './document.js';
import { referencePart } from './reference.js';
import { dataGrid } from './grid.js';
import { savePanel, issueList } from './save.js';

const STORE_DELAY_MS = 250;
// what is detected to measure the lifetime (choices of the LT sub-library)
const LT_METHODS = ['electron', 'gamma', 'neutron', 'charged particle', 'fission fragment'];
const REQUIRED_RE = /^'([^']+)' is a required property$/;

/**
 * Show the editor of `doc` (stored at `path`, or null for a new document) in
 * `container`.  Returns the page handle { flush, destroy } (see main.js).
 */
export function openEditor(container, { workspace, toast, dialog, navigate }, { path: initialPath, doc: initialDoc }) {
  let draft = new Draft(workspace, initialPath, initialDoc);
  let dirty = false;             // edited since the document was last stored
  let blocked = null;            // why it could not be stored: 'incomplete' | 'shape' | { taken: path }
  let timer = null;
  let tab = 'form';
  let json = null;               // the card of the JSON tab while it is shown (monaco.js)
  let shownAddress = location.hash;
  const controls = new Map();    // JSON pointer -> metadata control

  const meta = () => (isObject(draft.doc.meta) ? draft.doc.meta : {});
  const bibId = () => String(meta().bibId || '').trim();
  const isNew = () => !draft.path || workspace.baseline(draft.path) === null;
  // the last review of the entries, while the document can be stored: { changes, ambiguous, added, deleted }
  const review = () => (blocked ? null : draft.review);
  const pendingChanges = () => (review() ? review().changes.filter((c) => !c.choice) : []);

  const ref = referencePart({ workspace, controls, markDirty, onTypeChange: renderForm });
  const grid = dataGrid({ workspace, dialog, markDirty });
  const panel = savePanel(workspace, {
    prepare: () => handle.flush(),
    onChange: () => refreshComputed(),
    onBusy: (value) => json?.setReadOnly(value),
    // the saved file may hold other people's changes to other entries: show it as saved
    onSaved: () => {
      clearTimeout(timer);
      if (dirty || pendingChanges().length) { refreshComputed(); return; }
      const text = draft.path ? workspace.text(draft.path) : null;
      if (text === null) { renderForm(); return; }
      draft = new Draft(workspace, draft.path, jsonfmt.parse(text));
      showDoc();
      if (json && !json.dirty()) showJson();
    },
    current: () => draft.path,
  });

  // ---- storing ---------------------------------------------------------------------
  function markDirty() {
    dirty = true;
    clearTimeout(timer);
    if (panel.busy()) storeNow(); else timer = setTimeout(storeNow, STORE_DELAY_MS);
  }

  /**
   * Store the document in the workspace (as a draft) if it was edited.
   * Returns false when it was edited but cannot be stored (see `blocked`).
   */
  function store() {
    if (!dirty) return true;
    blocked = draft.store(ref);
    if (blocked) return false;
    dirty = false;
    return true;
  }

  /** The address follows a renamed file, unless the page is being left for another one. */
  function followAddress() {
    if (location.hash !== shownAddress) return;
    navigate('edit', { path: draft.path }, { replace: true });
    shownAddress = location.hash;
  }

  function storeNow() {
    clearTimeout(timer);
    const before = draft.path;
    store();
    if (draft.path !== before) followAddress();
    refreshComputed();
  }

  /** Forget the edits that are not stored (discard, delete, leaving for another file). */
  function abandon() {
    clearTimeout(timer);
    dirty = false;
    blocked = null;
    closeJson();
  }

  /** Rebuild the form around the document (as it is: nothing is added or replaced). */
  function showDoc() {
    ref.load(bibId());
    renderForm();
  }

  /** Scroll `el` to the top of the window, clear of the header while it stays on screen (it is taller where it wraps). */
  function scrollBelowHeader(el) {
    const header = document.querySelector('.site-header');
    const covered = header && getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().bottom : 0;
    window.scrollBy(0, el.getBoundingClientRect().top - Math.max(covered, 0) - 8);
  }

  // ---- identity of the entries --------------------------------------------------------
  const identityEl = h('div');
  const rowOf = (entry) => draft.doc.data.indexOf(entry) + 1;
  const statusOf = (entry) => {
    const change = review() ? review().changes.find((c) => c.entry === entry) : null;
    return change ? { from: change.from, choice: change.choice } : null;
  };

  /** Links to the entries that name an identifier in their originalData. */
  function referenceLinks(refs) {
    return refs.map((r, i) => [i ? T('、', ', ') : '',
      h('a', { href: `#/edit?path=${encodeURIComponent(r.path)}` }, `${fileName(r.path)} ${T('行', 'row')} ${r.index + 1}`),
      ` (${entryLabel(r.entry)})`]);
  }

  /** Settle identity changes: 'same' (correction of the same entry) or 'different' (different data). */
  function choose(changes, choice) {
    if (json && json.dirty()) {
      if (json.apply()) toast(T('JSON タブの編集を反映しました。もう一度選んでください。', 'The edits of the JSON tab were applied. Please choose again.'));
      return;
    }
    const touched = draft.choose(changes, choice).map(fileName);
    dirty = true;
    storeNow();
    if (tab === 'json') showJson();
    if (touched.length) {
      toast(T(`参照を新しい ID に付け替えました: ${touched.join('、')}(一緒に保存されます)`,
        `References now name the new IDs in: ${touched.join(', ')} (saved together)`));
    }
  }

  function renderIdentity() {
    const r = review();
    const changes = r ? r.changes : [];
    const ambiguous = r ? r.ambiguous : [];
    const deleted = r ? r.deleted.map((id) => ({ id, refs: referencesTo(workspace.db, [id]) })).filter((d) => d.refs.length) : [];
    if (!changes.length && !ambiguous.length && !deleted.length) { replace(identityEl); return; }
    const pending = changes.filter((c) => !c.choice).length;
    const item = (c) => {
      const refs = referencesTo(workspace.db, [c.choice === 'same' ? c.to : c.from]);
      const button = (choice, label) => h('button', {
        class: `btn small${c.choice === choice ? ' primary' : ''}`, type: 'button', 'aria-pressed': String(c.choice === choice),
        onclick: () => choose([c], choice),
      }, label);
      const state = {
        same: T('以前の ID を legacyIds に記録し、参照を新しい ID に付け替えました。', 'The former ID is kept in legacyIds and references name the new ID.'),
        different: T('以前の ID は残さず、参照も付け替えていません。', 'The former ID is not kept and references were left as they are.'),
      }[c.choice] || T('まだ選んでいません', 'not chosen yet');
      return h('li', { class: c.choice ? 'chosen' : 'pending' },
        h('div', null, h('strong', null, `${T('行', 'Row')} ${rowOf(c.entry)} ${entryLabel(c.entry)}`), ' ',
          h('code', null, c.from), ' → ', h('code', null, c.to)),
        h('div', { class: 'small' }, refs.length
          ? [c.choice === 'same' ? T('付け替えた参照: ', 'References now naming the new ID: ')
            : c.choice === 'different' ? T('付け替えていない参照(チェックでエラーになります): ', 'References left as they are (reported by the checks): ')
              : T('この行を元データに挙げているデータ: ', 'Data that name this row as original data: '), referenceLinks(refs)]
          : T('この行を元データに挙げているデータはありません。', 'No other data name this row as original data.')),
        h('div', { class: 'row' },
          button('same', T('同じデータの訂正', 'Correction of the same data')),
          button('different', T('別のデータ', 'Different data')),
          h('span', { class: 'small muted' }, state)));
    };
    replace(identityEl, card({
      title: T('ID が変わる行', 'Rows whose ID changes'),
      controls: changes.length ? h('span', { class: `tag ${pending ? 'warn' : 'good'}` }, pending ? T(`未選択 ${pending} 行`, `${pending} to choose`) : T('選択済み', 'all chosen')) : null,
      class: `identity-card${pending ? ' pending' : ''}`,
    },
      h('div', { class: 'card-body stack' },
        changes.length ? [
          h('p', null, T('元素・質量数・Key(またはファイルの文献・Key)を変えたため、次の行の datasetId が変わります。行ごとにどちらかを選んでください。選ぶまでは保存できず、このページから移ることもできません(元に戻すと、この表示は消えます)。',
            'Element, mass number or key (or the source or key of the file) changed, so the datasetId of these rows changes. Choose for each row; until then nothing can be saved and the page cannot be left (changing it back removes the question).')),
          h('ul', { class: 'small id-help' },
            h('li', null, h('strong', null, T('同じデータの訂正', 'Correction of the same data')),
              T(' — 入力の誤りを直しただけで、同じ測定値・計算値です。以前の ID はこの行の legacyIds に残り、この行を「元データ」に挙げているデータ(キュレーション・評価データ)は新しい ID に付け替えられて、一緒に保存されます。',
                ' — only a mistake was corrected; it is the same measured or calculated value. The former ID stays in the row’s legacyIds, and data naming this row as original data (curated, evaluated) are changed to name the new ID and saved together.')),
            h('li', null, h('strong', null, T('別のデータ', 'Different data')),
              T(' — 以前の行とは別のデータです。以前の ID、legacyIds、訂正記録は引き継がず、参照も付け替えません。以前の行を参照しているデータはチェックでエラーになるので、そちらを直してください。',
                ' — it is not the data of the former row. Earlier IDs and correction records stay with the former row. References still name that row. Correct any references flagged by the checks.'))),
          changes.length > 1 ? h('div', { class: 'row' },
            h('button', { class: 'btn small', type: 'button', onclick: () => choose(changes, 'same') }, T('すべて「同じデータの訂正」', 'All: correction of the same data')),
            h('button', { class: 'btn small', type: 'button', onclick: () => choose(changes, 'different') }, T('すべて「別のデータ」', 'All: different data'))) : null,
          h('ul', { class: 'id-changes' }, changes.map(item)),
        ] : null,
        ambiguous.map((a) => h('p', { class: 'notice warn' },
          T(`行 ${a.entries.map(rowOf).join('・')} は、どれも保存済みの行 ${a.from} から変わったもので、どれが以前の行か判別できません。参照は付け替えず、${a.from} は削除されたものとして扱います。不要な行を削除するか、元素・質量数・Key を見直してください。`,
            `Rows ${a.entries.map(rowOf).join(', ')} all come from the saved row ${a.from}; which one it is cannot be told. No reference is re-pointed and ${a.from} counts as deleted. Delete the rows you do not need, or check element, mass number and key.`))),
        deleted.length ? h('div', { class: 'notice warn' },
          T('削除した行を元データに挙げているデータがあります。保存するには、そちらの「元データ」を直してください: ',
            'Data name deleted rows as original data; correct their original data before saving: '),
          h('ul', null, deleted.map((d) => h('li', null, h('code', null, d.id), ' ← ', referenceLinks(d.refs))))) : null)));
  }

  // ---- form: conditions -------------------------------------------------------------
  function conditionsCard() {
    const { doc } = draft;
    const code = fileCode(doc);
    const exp = code === 'EXP';
    const used = workspace.db.sortedFiles().filter((f) => f.code === code).map((f) => f.meta.method).filter(Boolean);
    const methods = [...new Set([...(exp ? LT_METHODS : []), ...used])];
    const listId = `methods-${code}`;
    const input = (key, options) => {
      const el = textInput(doc.meta, key, markDirty, options);
      controls.set(`/meta/${key}`, el);
      return el;
    };
    let body;
    if (exp) {
      const tables = workspace.db.tables();
      const facility = h('select', {
        onchange: (e) => { doc.meta.facility = e.target.value; markDirty(); },
      }, h('option', { value: '' }, T('(選択してください)', '(choose)')),
      [...tables.facilities.values()].map((f) => h('option', { value: f.abbr, selected: doc.meta.facility === f.abbr }, `${f.abbr} — ${f.detail}`)),
      doc.meta.facility && !tables.facilities.has(doc.meta.facility)
        ? h('option', { value: doc.meta.facility, selected: true }, `${doc.meta.facility} (${T('未登録', 'not in the list')})`) : null);
      controls.set('/meta/facility', facility);
      body = [
        field(T('施設', 'Facility'), facility, {
          hint: h('span', null, T('一覧にない場合は', 'Missing? Add it under '),
            h('a', { href: '#/master' }, T('マスタデータ', 'Master data')), T('で追加', '')),
        }),
        field(T('測定手法', 'Method'), input('method', { list: listId, placeholder: 'electron' }), {
          hint: `${T('何を検出したか', 'What was detected')}: ${LT_METHODS.join(' / ')}`,
        }),
        field(T('ビーム', 'Beam'), input('beam', { area: true }), {
          wide: true, hint: T('ビームライン・運動量・強度など(統一的に書けない項目なので自由記述)', 'Beam line, momentum, intensity … (free text)'),
        }),
        field(T('標的', 'Target'), input('target', { area: true }), {
          wide: true, hint: T('大きさ・厚さ、気体/液体/固体、化学形、同位体濃縮度など(自由記述)', 'Size, thickness, gas / liquid / solid, chemical form, enrichment … (free text)'),
        }),
        field(T('検出器', 'Detector'), input('detector', { area: true }), {
          wide: true, hint: T('例: プラスチックシンチレータ、Ge、NaI、液体シンチレータ、³He 検出器、Si、PPAC など', 'e.g. plastic scintillator, Ge, NaI, liquid scintillator, ³He counter, Si, PPAC …'),
        }),
        field(T('コメント', 'Comment'), input('comment', { area: true, rows: 2 }), {
          wide: true, hint: T('補正・参照データ・注意点など', 'Corrections, reference data, caveats …'),
        }),
      ];
    } else {
      body = [
        field(T('手法', 'Method'), input('method', { list: listId, area: true, rows: 2 }), {
          wide: true,
          hint: { TH: T('理論模型・計算コード', 'Model or code'), CUR: T('キュレーションの手順(使った Huff 因子・定数など)', 'Curation procedure (Huff factors and constants used …)'), EVAL: T('評価方法', 'Evaluation method') }[code],
        }),
        code === 'EVAL' ? field(T('参照データベース', 'Reference database'), input('referenceDatabase', { placeholder: 'muND LT curated v1.0.0' }), {
          wide: true, hint: T('評価の入力に使ったキュレーションデータのセット', 'The set of curated data the evaluation is based on'),
        }) : null,
        field(T('コメント', 'Comment'), input('comment', { area: true, rows: 2 }), { wide: true }),
      ];
    }
    return card({ title: exp ? T('実験条件', 'Experimental conditions') : T('値の導出方法', 'How the values were obtained') },
      h('div', { class: 'card-body' }, h('div', { class: 'form-cols' }, body),
        h('datalist', { id: listId }, methods.map((m) => h('option', { value: m })))));
  }

  // ---- checks -----------------------------------------------------------------------
  const issuesTag = h('span', { class: 'tag' });
  const issuesBody = h('div');
  const issuesEl = card({ title: T('チェック結果', 'Checks'), controls: issuesTag, class: 'issues-card' }, issuesBody);

  /** The input that an issue points at (a missing member: the input of that member). */
  function controlFor(issue) {
    const required = REQUIRED_RE.exec(issue.message);
    const pointer = required ? `${issue.pointer}/${required[1]}` : issue.pointer;
    const m = /^\/data\/(\d+)(?:\/(.*))?$/.exec(pointer);
    if (m) return grid.controlFor(Number(m[1]), m[2] || '');
    for (let p = pointer; p; p = p.slice(0, p.lastIndexOf('/'))) {
      if (controls.has(p)) return controls.get(p);
    }
    return null;
  }

  /** Go to the input that an issue points at. */
  function pick(issue) {
    const el = controlFor(issue);
    if (!el) return;
    setTab('form');
    el.focus();
    el.scrollIntoView({ block: 'center' });
  }

  function refreshIssues() {
    const { path } = draft;
    const issues = path ? workspace.issuesFor(path) : [];
    const marks = new Map();
    for (const issue of issues) {
      const el = controlFor(issue);
      if (el) marks.set(el, [...(marks.get(el) || []), { level: issue.level, message: issueText(issue, workspace.db) }]);
    }
    for (const el of [...controls.values(), ...grid.controls()]) markIssues(el, marks.get(el) || []);
    const errors = issues.filter((i) => i.level === 'error').length;
    issuesTag.className = `tag ${errors ? 'bad' : 'good'}`;
    issuesTag.textContent = !path ? T('文献 未入力', 'no source yet')
      : errors ? T(`エラー ${errors} 件`, `${errors} error(s)`)
        : issues.length ? T(`警告 ${issues.length} 件`, `${issues.length} warning(s)`) : T('問題なし', 'all good');
    issuesBody.className = issues.length ? '' : 'card-body muted small';
    replace(issuesBody, issues.length ? issueList(issues, workspace.db, { onPick: pick })
      : path ? T('スキーマ・ID・参照関係のチェックをすべて通過しています。', 'Format, identifiers and references are all fine.')
        : T('文献(DOI など)を入力するとチェックが始まります。', 'Checks start once the source (DOI …) is entered.'));
  }

  // ---- header -------------------------------------------------------------------------
  const titleEl = h('span');
  const kindEl = h('span', { class: 'tag' });
  const statusEl = h('span', { class: 'tag' });
  const pathEl = h('code', { class: 'computed' });
  const citeEl = h('span');
  const historyEl = h('a', { class: 'btn' }, T('履歴', 'History'));
  const noticeEl = h('div');

  /** Why the edits are not stored, with a way out. */
  function blockedMessage() {
    if (blocked === 'shape') {
      return T('meta または data の形が正しくないため、入力内容を保持できません。JSON タブで直してください。不要なら「変更を破棄」を押してください。',
        'meta or data does not have the right shape, so what you typed cannot be kept. Correct it in the JSON tab, or use “Discard changes”.');
    }
    if (blocked === 'incomplete') {
      return T('有効な文献(DOI など)とデータ種別を入力してください。それまでは入力した内容を保持できないため、このページから移ることも保存することもできません。不要なら「変更を破棄」を押してください。',
        'Please give a valid source (DOI …) and kind of data. Until then what you typed cannot be kept, so you can neither leave this page nor save. Use “Discard changes” if you do not need it.');
    }
    return T(`この文献(同じ文献・データ種別・Key)は登録済みです: ${blocked.taken}`,
      `This publication (same source, kind of data and key) is registered already: ${blocked.taken}`);
  }

  function renderNotice() {
    if (!dirty || !blocked) { replace(noticeEl); return; }
    const open = typeof blocked === 'object'
      ? h('a', {
        href: `#/edit?path=${encodeURIComponent(blocked.taken)}`,
        onclick: (e) => {
          e.preventDefault();
          if (!confirm(T('ここで入力した内容は失われます。登録済みのファイルを開きますか?',
            'What you typed here will be lost. Open the registered file?'))) return;
          const target = blocked.taken;
          const abandoned = isNew() ? draft.path : null;
          draft.undo();
          abandon();
          if (abandoned) workspace.discard(abandoned);     // a new file is withdrawn, with the entries only it named
          navigate('edit', { path: target });
        },
      }, T('そのファイルを開く', 'Open that file'))
      : null;
    replace(noticeEl, h('p', { class: `notice ${open ? 'bad' : 'warn'}` }, blockedMessage(), ' ', open));
  }

  function refreshComputed() {
    const { doc, path } = draft;
    if (isObject(doc.meta)) ref.refresh(doc);
    const doi = bibId();
    const stored = workspace.db.reference(doi);
    titleEl.textContent = firstAuthor(stored) ? citeLabel(stored, doi) : (isNew() ? T('新しいデータセット', 'New dataset') : doi);
    citeEl.textContent = firstAuthor(stored) ? ` · ${citeText(stored, doi)}` : '';
    kindEl.textContent = `${doc.sublibrary} / ${fileCode(doc)}`;
    const state = path ? workspace.status(path) : 'new';
    statusEl.textContent = statusLabel(state);
    statusEl.className = `tag ${state}`;
    pathEl.textContent = path || T('(文献を入力すると保存先が決まります)', '(enter the source to create the file)');
    historyEl.hidden = isNew();                              // only a saved file has a history
    if (!historyEl.hidden) historyEl.href = `#/history?path=${encodeURIComponent(path)}`;
    renderNotice();
    renderIdentity();
    panel.refresh();
    grid.refresh(statusOf);
    refreshIssues();
  }

  // ---- tabs -------------------------------------------------------------------------------
  const formEl = h('div', { class: 'stack', id: 'editor-form', role: 'tabpanel', 'aria-labelledby': 'tab-form' });
  const jsonEl = h('div', { class: 'stack', hidden: true, id: 'editor-json', role: 'tabpanel', 'aria-labelledby': 'tab-json' });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });

  function renderForm() {
    controls.clear();
    const { doc } = draft;
    const problem = formProblem(doc);
    if (problem) {
      grid.detach();
      replace(formEl, h('p', { class: 'notice bad' },
        T(`このファイルは ${problem} の形が正しくないため、フォームでは表示できません。JSON タブで直してください。`,
          `${problem} of this file does not have the right shape, so the form cannot show it. Correct it in the JSON tab.`), ' ',
        h('button', { class: 'btn small', type: 'button', onclick: () => setTab('json') }, T('JSON タブを開く', 'Open the JSON tab'))));
    } else {
      replace(formEl, ref.card(doc, { isNew: isNew() }), conditionsCard(), grid.card(doc));
    }
    refreshComputed();
  }

  /** Take over the text of the JSON tab, if it is shown. Returns false (and reports) when it is not valid. */
  const applyJson = () => !json || json.apply();

  function closeJson() {
    if (json) json.dispose();
    json = null;
    replace(jsonEl);
  }

  function showJson() {
    closeJson();
    json = jsonCard({
      title: 'JSON',
      path: draft.path || `data/${draft.doc.sublibrary}/${fileCode(draft.doc)}/new.json`,
      text: () => draft.text(),
      schemas: workspace.schemas,
      toast,
      onApply: (doc) => {
        draft.adopt(doc);
        showDoc();
        dirty = true;
        storeNow();
      },
      help: T('ここでの編集は「反映」を押すとフォームに取り込まれます。ID は自動で計算し直され、書式も整えられます。行は datasetId で対応づけるので、並べ替えても ID は変わりません。',
        'Edits made here are taken over with “Apply”. Identifiers are recomputed and the layout is normalised. Rows are matched by datasetId, so reordering them keeps their identifiers.'),
    });
    json.setReadOnly(panel.busy());
    replace(jsonEl, json.el);
  }

  function setTab(next) {
    if (next === tab) return;
    if (tab === 'json') {
      if (!applyJson()) return;
      closeJson();
    }
    tab = next;
    formEl.hidden = tab !== 'form';
    jsonEl.hidden = tab !== 'json';
    renderTabs();
    if (dirty) storeNow();
    if (tab === 'json') showJson();
  }

  function renderTabs() {
    const item = (key, label) => h('button', {
      class: 'tab', role: 'tab', type: 'button', id: `tab-${key}`, 'aria-controls': `editor-${key}`, 'aria-selected': String(tab === key), onclick: () => setTab(key),
    }, label);
    replace(tabsEl, item('form', T('フォーム', 'Form')), item('json', 'JSON'));
  }

  // ---- page ------------------------------------------------------------------------------------
  function discard() {
    const { path } = draft;
    if ((path || dirty) && !confirmDiscard()) return;
    draft.undo();
    abandon();
    if (path) workspace.discard(path);
    navigate('datasets');
  }

  function remove() {
    const { path } = draft;
    if (path && !confirm(T(`${path} を削除しますか? 削除は、次の画面で「保存」を押すと確定します。`, `Delete ${path}? The deletion takes effect when you press “Save” on the next page.`))) return;
    draft.undo();
    abandon();
    if (path) {
      workspace.stageDelete(path);
      navigate('datasets', { unsaved: '1' });
    } else {
      navigate('datasets');
    }
  }

  replace(container,
    h('div', { class: 'editor-head' },
      h('a', { class: 'btn ghost', href: '#/datasets' }, T('← 一覧', '← List')),
      h('div', { class: 'editor-title' },
        h('h1', null, titleEl, ' ', kindEl, ' ', statusEl),
        h('p', { class: 'small muted' }, pathEl, citeEl)),
      h('span', { class: 'spacer' }),
      historyEl,
      h('button', { class: 'btn', type: 'button', onclick: discard }, T('変更を破棄', 'Discard changes')),
      h('button', { class: 'btn danger', type: 'button', onclick: remove }, T('削除', 'Delete'))),
    noticeEl, identityEl, panel.el, tabsEl, formEl, jsonEl, issuesEl);
  renderTabs();
  showDoc();
  if (isNew() && !bibId()) {
    const doi = controls.get('/meta/bibId');
    if (doi) doi.focus();
  }

  const handle = {
    /**
     * Store pending edits (before the page is left or a save); false (the user
     * is told why) when they cannot be stored or an identity change waits for
     * a choice.
     */
    flush() {
      clearTimeout(timer);
      if (!applyJson()) return false;
      const before = draft.path;
      if (!store()) {
        refreshComputed();
        toast(blockedMessage(), 'bad');
        return false;
      }
      if (draft.path !== before) followAddress();
      if (pendingChanges().length) {
        refreshComputed();
        toast(T('ID が変わる行があります。行ごとに「同じデータの訂正」か「別のデータ」を選んでください。',
          'The ID of some rows changes. Choose “Correction of the same data” or “Different data” for each.'), 'bad');
        scrollBelowHeader(identityEl);
        return false;
      }
      return true;
    },
    destroy() {
      abandon();
    },
  };
  return handle;
}
