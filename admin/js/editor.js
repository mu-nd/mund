// Editor of one dataset file: the form (reference card, conditions, data
// grid), the JSON text and the changes since the last save.
//
// Every edit marks the document dirty; a quarter of a second later (and when
// the page is left) the document is stored as a draft in the workspace under
// its canonical file name.  The 保存 (save) card above the form saves all
// drafts at once.  A document is stored only once it has a valid DOI, and
// never over another registered file.
//
// The entries are followed by datasetId (document.js, IdTracker).  When the
// identifiers of a saved entry change, the editor asks whether it is a
// correction of the same entry or different data, and neither saves nor lets
// the page be left before that is chosen.

import { h, replace, clear } from '../../site/assets/js/core/dom.js';
import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import { expectedMetaId, fileCode, filePath, assignIds } from '../../site/assets/js/core/database.js';
import { citeLabel, citeText, firstAuthor } from '../../site/assets/js/core/cite.js';
import { T, statusLabel, issueText } from './i18n.js';
import { renderDiff, diffLines, diffStats } from './diff.js';
import { jsonPane } from './monaco.js';
import { field, textInput, markIssues } from './form.js';
import { isDoi, IdTracker, datasetIdsOf, formProblem, referencesTo, entryLabel, fileName } from './document.js';
import { referencePart } from './reference.js';
import { dataGrid } from './grid.js';
import { savePanel } from './save.js';

const STORE_DELAY_MS = 250;
// what is detected to measure the lifetime (choices of the LT sub-library)
const LT_METHODS = ['electron', 'gamma', 'neutron', 'charged particle', 'fission fragment'];
const REQUIRED_RE = /^'([^']+)' is a required property$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Show the editor of `doc` (stored at `path`, or null for a new document) in
 * `container`.  Returns the page handle { flush, destroy } (see main.js).
 */
export function openEditor(container, { workspace, toast, dialog, navigate }, { path: initialPath, doc: initialDoc }) {
  let path = initialPath;
  let doc = null;
  let dirty = false;             // edited since the document was last stored
  let blocked = null;            // why it could not be stored: 'incomplete' | 'shape' | { taken: path }
  let timer = null;
  let tab = 'form';
  let pane = null;               // the editor of the JSON tab while it is shown
  let shownAddress = location.hash;
  let tracker = null;            // follows the entries by datasetId (document.js)
  let identity = null;           // the tracker's last review: { changes, ambiguous, added, deleted }
  const controls = new Map();    // JSON pointer -> metadata control

  const meta = () => (isObject(doc.meta) ? doc.meta : {});
  const bibId = () => String(meta().bibId || '').trim();
  const validDoi = (text) => isDoi(text, workspace.db.schemaFor(doc.format));
  const isNew = () => !path || workspace.baseline(path) === null;
  const currentText = () => workspace.db.canonicalText(doc);
  const savedIds = () => datasetIdsOf(path ? workspace.baseline(path) : null);
  const pendingChanges = () => (identity && !blocked ? identity.changes.filter((c) => !c.choice) : []);

  const ref = referencePart({ workspace, controls, isDoi: validDoi, markDirty, onTypeChange: renderForm });
  const grid = dataGrid({ workspace, dialog, markDirty });
  const panel = savePanel({ workspace }, {
    prepare: () => handle.flush(),
    // the saved file may hold other people's changes to other entries: show it as saved
    saved: () => {
      clearTimeout(timer);
      tracker = new IdTracker(doc, savedIds());     // what was just saved is what the entries are compared with
      identity = null;
      if (dirty && !store()) { refreshComputed(); return; }   // typed while the save was under way: kept
      const text = path ? workspace.text(path) : null;
      if (text === null) { renderForm(); return; }
      doc = null;
      setDoc(jsonfmt.parse(text));
    },
    changed: () => refreshComputed(),
    own: (p) => p === path || (path !== null && workspace.changes().some((c) => c.path === path && c.origin === p)),
  });

  // ---- storing ---------------------------------------------------------------------
  function markDirty() {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(storeNow, STORE_DELAY_MS);
  }

  /**
   * Store the document in the workspace (as a draft) if it was edited.
   * Returns false when it was edited but cannot be stored (see `blocked`).
   */
  function store() {
    if (!dirty) return true;
    if (formProblem(doc)) {
      blocked = 'shape';
      return false;
    }
    const doi = bibId();
    if (!validDoi(doi) || expectedMetaId(doc) === null) {
      blocked = 'incomplete';
      return false;
    }
    assignIds(doc);
    const twin = workspace.db.sortedFiles().find((f) => f.path !== path && f.meta.id === doc.meta.id);
    const target = filePath(doc, ref.entry());
    if (twin || (target !== path && workspace.text(target) !== null)) {
      blocked = { taken: twin ? twin.path : target };
      return false;
    }
    identity = tracker.review(doc, savedIds(), workspace, path);
    ref.save(doi);                                  // the bibliography entry first: the file name depends on it
    workspace.move(path, target, currentText());
    path = target;
    dirty = false;
    blocked = null;
    return true;
  }

  /** The address follows a renamed file, unless the page is being left for another one. */
  function followAddress() {
    if (location.hash !== shownAddress) return;
    navigate('edit', { path }, { replace: true });
    shownAddress = location.hash;
  }

  function storeNow() {
    clearTimeout(timer);
    const before = path;
    store();
    if (path !== before) followAddress();
    refreshComputed();
  }

  /** Forget the edits that are not stored (discard, delete, leaving for another file). */
  function abandon() {
    clearTimeout(timer);
    dirty = false;
    blocked = null;
    identity = null;
    closePane();
  }

  /** Take `obj` as the document (as it is: nothing is added or replaced) and rebuild the form around it. */
  function setDoc(obj) {
    if (doc && tracker) tracker.adopt(doc, obj);    // the JSON text was applied: entries are matched by datasetId
    else tracker = new IdTracker(obj, savedIds());
    doc = obj;
    identity = null;                                // until the next store reviews the entries
    ref.load(bibId());
    renderForm();
  }

  // ---- identity of the entries --------------------------------------------------------
  const identityEl = h('div');
  const rowOf = (entry) => doc.data.indexOf(entry) + 1;
  const statusOf = (entry) => {
    const change = identity && !blocked ? identity.changes.find((c) => c.entry === entry) : null;
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
    if (tab === 'json' && pane && pane.dirty()) {
      if (applyJson()) storeNow();
      toast(T('JSON タブの編集を反映しました。もう一度選んでください。', 'The edits of the JSON tab were applied. Please choose again.'));
      return;
    }
    const touched = new Set();
    for (const change of changes) for (const p of tracker.choose(change.entry, choice, doc, workspace, path)) touched.add(p);
    dirty = true;
    storeNow();
    if (tab === 'json') showJson();
    if (touched.size) {
      toast(T(`参照を新しい ID に付け替えました: ${[...touched].map(fileName).join('、')}(一緒に保存されます)`,
        `References now name the new IDs in: ${[...touched].map(fileName).join(', ')} (saved together)`));
    }
  }

  function renderIdentity() {
    const changes = identity && !blocked ? identity.changes : [];
    const ambiguous = identity && !blocked ? identity.ambiguous : [];
    const deleted = identity && !blocked
      ? identity.deleted.map((id) => ({ id, refs: referencesTo(workspace.db, [id]) })).filter((d) => d.refs.length) : [];
    if (!changes.length && !ambiguous.length && !deleted.length) { clear(identityEl); return; }
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
    replace(identityEl, h('section', { class: `card identity-card${pending ? ' pending' : ''}` },
      h('div', { class: 'card-head' }, h('h2', null, T('ID が変わる行', 'Rows whose ID changes')),
        changes.length ? h('span', { class: `tag ${pending ? 'warn' : 'good'}` }, pending ? T(`未選択 ${pending} 行`, `${pending} to choose`) : T('選択済み', 'all chosen')) : null),
      h('div', { class: 'card-body stack' },
        changes.length ? [
          h('p', null, T('元素・質量数・Key(またはファイルの DOI・Key)を変えたため、次の行の datasetId が変わります。行ごとにどちらかを選んでください。選ぶまでは保存できず、このページから移ることもできません(元に戻すと、この表示は消えます)。',
            'Element, mass number or key (or the DOI or key of the file) changed, so the datasetId of these rows changes. Choose for each row; until then nothing can be saved and the page cannot be left (changing it back removes the question).')),
          h('ul', { class: 'small id-help' },
            h('li', null, h('strong', null, T('同じデータの訂正', 'Correction of the same data')),
              T(' — 入力の誤りを直しただけで、同じ測定値・計算値です。以前の ID はこの行の legacyIds に残り、この行を「元データ」に挙げているデータ(キュレーション・評価データ)は新しい ID に付け替えられて、一緒に保存されます。',
                ' — only a mistake was corrected; it is the same measured or calculated value. The former ID stays in the row’s legacyIds, and data naming this row as original data (curated, evaluated) are changed to name the new ID and saved together.')),
            h('li', null, h('strong', null, T('別のデータ', 'Different data')),
              T(' — 以前の行とは別のデータです。以前の ID(と legacyIds)は残さず、参照も付け替えません。以前の行を参照しているデータはチェックでエラーになるので、そちらを直してください。',
                ' — it is not the data of the former row. The former ID (and legacyIds) are not kept and references are left as they are; data that refer to the former row are reported by the checks and must be corrected.'))),
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
      tables.facilities.map((f) => h('option', { value: f.abbr, selected: doc.meta.facility === f.abbr }, `${f.abbr} — ${f.detail}`)),
      doc.meta.facility && !tables.facilityAbbrs.has(doc.meta.facility)
        ? h('option', { value: doc.meta.facility, selected: true }, `${doc.meta.facility} (${T('未登録', 'not in the list')})`) : null);
      controls.set('/meta/facility', facility);
      body = [
        field(T('施設', 'Facility'), facility, {
          hint: h('span', null, T('一覧にない場合は', 'Missing? Add it under '),
            h('a', { href: '#/master' }, T('マスタデータ', 'Master data')), T('で追加', '')),
        }),
        field(T('測定手法', 'Method'), input('method', { list: listId, placeholder: 'electron' }), {
          hint: T('何を検出したか: electron / gamma / neutron / charged particle / fission fragment', 'What was detected: electron / gamma / neutron / charged particle / fission fragment'),
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
          hint: { TH: T('理論模型・計算コード', 'Model or code'), CUR: T('キュレーションの手順(統一した Huff 因子・定数など)', 'Curation procedure (common Huff factor, constants …)'), EVAL: T('評価方法', 'Evaluation method') }[code],
        }),
        code === 'EVAL' ? field(T('参照データベース', 'Reference database'), input('referenceDatabase', { placeholder: 'muND LT curated v1.0.0' }), {
          wide: true, hint: T('評価の入力に使ったキュレーションデータのセット', 'The set of curated data the evaluation is based on'),
        }) : null,
        field(T('コメント', 'Comment'), input('comment', { area: true, rows: 2 }), { wide: true }),
      ];
    }
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, exp ? T('実験条件', 'Experimental conditions') : T('値の導出方法', 'How the values were obtained'))),
      h('div', { class: 'card-body' }, h('div', { class: 'form-cols' }, body),
        h('datalist', { id: listId }, methods.map((m) => h('option', { value: m })))));
  }

  // ---- checks -----------------------------------------------------------------------
  const issuesEl = h('section', { class: 'card issues-card' });

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

  function refreshIssues() {
    const issues = (path ? workspace.issuesFor(path) : []).map((issue) => ({ ...issue, text: issueText(issue) }));
    const marks = new Map();
    const items = issues.map((issue) => {
      const el = controlFor(issue);
      if (el) marks.set(el, [...(marks.get(el) || []), { level: issue.level, message: issue.text }]);
      const m = /^\/data\/(\d+)(?:\/(.*))?/.exec(issue.pointer);
      const where = m ? `${T('行', 'row')} ${Number(m[1]) + 1}${m[2] ? ` · ${m[2].split('/').filter((s) => !/^\d+$/.test(s)).slice(-2).join(' ')}` : ''}`
        : issue.pointer.replace(/^\//, '').replace(/\//g, ' › ');
      return h('li', { class: issue.level },
        h('button', { class: 'link', type: 'button', onclick: () => { if (el) { setTab('form'); el.focus(); el.scrollIntoView({ block: 'center' }); } } },
          h('span', { class: 'issue-mark' }, issue.level === 'error' ? '✕' : '!'), ' ',
          where ? h('strong', null, `${where}: `) : null, issue.text),
        ' ', h('code', { class: 'muted small' }, issue.code));
    });
    for (const el of [...controls.values(), ...grid.controls()]) markIssues(el, marks.get(el) || []);
    const errors = issues.filter((i) => i.level === 'error').length;
    replace(issuesEl,
      h('div', { class: 'card-head' }, h('h2', null, T('チェック結果', 'Checks')),
        h('span', { class: `tag ${errors ? 'bad' : 'good'}` }, !path ? T('DOI 未入力', 'no DOI yet')
          : errors ? T(`エラー ${errors} 件`, `${errors} error(s)`)
            : issues.length ? T(`警告 ${issues.length} 件`, `${issues.length} warning(s)`) : T('問題なし', 'all good'))),
      items.length ? h('ul', { class: 'issue-list' }, items)
        : h('div', { class: 'card-body muted small' }, path ? T('スキーマ・ID・参照関係のチェックをすべて通過しています。', 'Format, identifiers and references are all fine.')
          : T('DOI を入力するとチェックが始まります。', 'Checks start once a DOI is entered.')));
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
      return T('有効な DOI(とデータ種別)を入力してください。それまでは入力した内容を保持できないため、このページから移ることも保存することもできません。不要なら「変更を破棄」を押してください。',
        'Please give a valid DOI (and kind of data). Until then what you typed cannot be kept, so you can neither leave this page nor save. Use “Discard changes” if you do not need it.');
    }
    return T(`この文献(同じ DOI・データ種別・Key)は登録済みです: ${blocked.taken}`,
      `This publication (same DOI, kind of data and key) is registered already: ${blocked.taken}`);
  }

  function renderNotice() {
    if (!dirty || !blocked) { clear(noticeEl); return; }
    const open = typeof blocked === 'object'
      ? h('a', {
        href: `#/edit?path=${encodeURIComponent(blocked.taken)}`,
        onclick: (e) => {
          e.preventDefault();
          if (!confirm(T('ここで入力した内容は失われます。登録済みのファイルを開きますか?',
            'What you typed here will be lost. Open the registered file?'))) return;
          const target = blocked.taken;
          tracker.undoAll(doc, workspace, path);
          abandon();
          navigate('edit', { path: target });
        },
      }, T('そのファイルを開く', 'Open that file'))
      : null;
    replace(noticeEl, h('p', { class: `notice ${open ? 'bad' : 'warn'}` }, blockedMessage(), ' ', open));
  }

  function refreshComputed() {
    if (isObject(doc.meta)) ref.refresh(doc);
    const doi = bibId();
    const stored = workspace.db.reference(doi);
    titleEl.textContent = firstAuthor(stored) ? citeLabel(stored, doi) : (isNew() ? T('新しいデータセット', 'New dataset') : doi);
    citeEl.textContent = firstAuthor(stored) ? ` · ${citeText(stored, doi)}` : '';
    kindEl.textContent = `${doc.sublibrary} / ${fileCode(doc)}`;
    const state = path ? workspace.status(path) : 'new';
    statusEl.textContent = statusLabel(state);
    statusEl.className = `tag ${state}`;
    pathEl.textContent = path || T('(DOI を入力すると保存先が決まります)', '(enter a DOI to create the file)');
    historyEl.hidden = !path;
    if (path) historyEl.href = `#/history?path=${encodeURIComponent(path)}`;
    renderNotice();
    renderIdentity();
    panel.refresh();
    grid.refresh(statusOf);
    refreshIssues();
  }

  // ---- tabs -------------------------------------------------------------------------------
  const formEl = h('div', { class: 'stack' });
  const jsonEl = h('div', { class: 'stack', hidden: true });
  const diffEl = h('div', { class: 'stack', hidden: true });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });

  function renderForm() {
    controls.clear();
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

  /** Take over the text of the JSON tab. Returns false (and reports) when it is not valid. */
  function applyJson() {
    if (!pane || !pane.dirty()) return true;
    let parsed;
    try {
      parsed = jsonfmt.parse(pane.value());
      if (!isObject(parsed)) throw new Error('the top level must be an object');
    } catch (err) {
      toast(T(`JSON として読めません: ${err.message}`, `Not valid JSON: ${err.message}`), 'bad');
      return false;
    }
    setDoc(parsed);
    dirty = true;
    return true;
  }

  function closePane() {
    if (pane) pane.dispose();
    pane = null;
    clear(jsonEl);
  }

  function showJson() {
    closePane();
    pane = jsonPane(path || `data/${doc.sublibrary}/${fileCode(doc)}/new.json`, currentText(), workspace.schemas);
    replace(jsonEl, h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'JSON'),
        h('div', { class: 'row' }, pane.note,
          h('button', { class: 'btn primary', type: 'button', onclick: () => {
            if (!applyJson()) return;
            storeNow();
            toast(T('反映しました(ID と書式を整えました)', 'Applied (identifiers and layout updated)'));
            showJson();
          } }, T('反映', 'Apply')))),
      pane.el,
      h('div', { class: 'card-body small muted' }, T('ここでの編集は「反映」を押すとフォームに取り込まれます。ID は自動で計算し直され、書式も整えられます。行は datasetId で対応づけるので、並べ替えても ID は変わりません。',
        'Edits made here are taken over with “Apply”. Identifiers are recomputed and the layout is normalised. Rows are matched by datasetId, so reordering them keeps their identifiers.'))));
  }

  function showDiff() {
    const before = path ? workspace.baseline(path) : null;
    const after = currentText();
    const stats = diffStats(diffLines(before, after));
    replace(diffEl, h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, T('保存済みの内容との差分', 'Changes since the last save')),
        h('span', { class: 'small muted' }, before === null ? T('新規ファイル', 'new file') : `+${stats.added} / −${stats.removed} ${T('行', 'lines')}`)),
      h('div', { class: 'card-body' }, renderDiff(before, after, 2))));
  }

  function setTab(next) {
    if (next === tab) return;
    if (tab === 'json') {
      if (!applyJson()) return;
      closePane();
    }
    tab = next;
    formEl.hidden = tab !== 'form';
    jsonEl.hidden = tab !== 'json';
    diffEl.hidden = tab !== 'diff';
    renderTabs();
    if (dirty) storeNow();
    if (tab === 'json') showJson();
    if (tab === 'diff') showDiff();
  }

  function renderTabs() {
    const item = (key, label) => h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(tab === key), onclick: () => setTab(key) }, label);
    replace(tabsEl, item('form', T('フォーム', 'Form')), item('json', 'JSON'), item('diff', T('差分', 'Changes')));
  }

  // ---- page ------------------------------------------------------------------------------------
  function discard() {
    if ((path || dirty) && !confirm(T('このファイルの保存していない変更を破棄しますか?', 'Discard the unsaved changes of this file?'))) return;
    tracker.undoAll(doc, workspace, path);   // references re-pointed for this file go back
    abandon();
    if (path) workspace.discard(path);
    navigate('datasets');
  }

  function remove() {
    if (path && !confirm(T(`${path} を削除しますか? 削除は、次の画面で「保存」を押すと確定します。`, `Delete ${path}? The deletion takes effect when you press “Save” on the next page.`))) return;
    tracker.undoAll(doc, workspace, path);
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
    noticeEl, panel.el, identityEl, tabsEl, formEl, jsonEl, diffEl, issuesEl);
  renderTabs();
  setDoc(initialDoc);
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
      if (tab === 'json' && !applyJson()) return false;
      const before = path;
      if (!store()) {
        refreshComputed();
        toast(blockedMessage(), 'bad');
        return false;
      }
      if (path !== before) followAddress();
      if (pendingChanges().length) {
        refreshComputed();
        toast(T('ID が変わる行があります。行ごとに「同じデータの訂正」か「別のデータ」を選んでください。',
          'The ID of some rows changes. Choose “Correction of the same data” or “Different data” for each.'), 'bad');
        identityEl.scrollIntoView({ block: 'start' });
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
