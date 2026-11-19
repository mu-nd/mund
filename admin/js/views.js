// Pages of the data entry tool other than the dataset editor.  Each page
// function fills `root` and may return a handle { flush?, destroy? } (see main.js).

import { h, replace } from '../../site/assets/js/core/dom.js';
import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import { CODES, CODE_TITLES } from '../../site/assets/js/core/vocabulary.js';
import { MASTER_DIR, MASTER_FILES, MASTER_FORMATS } from '../../site/assets/js/core/database.js';
import { citeLabel, citeText } from '../../site/assets/js/core/cite.js';
import { T, statusLabel, problemText } from './i18n.js';
import { jsonPane } from './monaco.js';
import { nextVersion, releaseChanges } from './release.js';
import { savePanel } from './save.js';

function date(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------------------------------------------------------------------------
// list of datasets
// ---------------------------------------------------------------------------

/** params: unsaved=1 shows only the files with unsaved changes. */
export function renderDatasets(root, { workspace, navigate }, params) {
  const state = { query: '', code: '', unsaved: params.get('unsaved') === '1' };
  const listEl = h('div');
  const panel = savePanel({ workspace }, { saved: () => renderList(), changed: () => renderList() });

  function rows() {
    const db = workspace.db;
    const issues = workspace.issues();
    const outdated = new Set(workspace.changes().filter((c) => c.outdated).map((c) => c.path));
    return db.sortedFiles().map((f) => {
      const elements = [...new Set(f.data.map((r) => r.nuclide && r.nuclide.element).filter(Boolean))];
      const own = issues.filter((i) => i.file === f.path);
      const reference = db.reference(f.meta.bibId);
      return {
        path: f.path, code: f.code, label: f.obj ? citeLabel(reference, f.meta.bibId) : f.path,
        cite: f.obj ? citeText(reference, f.meta.bibId) : '',
        count: f.data.length, elements, status: workspace.status(f.path), outdated: outdated.has(f.path),
        errors: own.filter((i) => i.level === 'error').length, warnings: own.filter((i) => i.level === 'warning').length,
        doi: f.meta.bibId || '', facility: f.meta.facility || '',
      };
    });
  }

  function renderList() {
    const q = state.query.trim().toLowerCase();
    const all = rows();
    const shown = all.filter((r) => (!state.code || r.code === state.code) && (!state.unsaved || r.status !== 'unchanged')
      && (!q || [r.label, r.cite, r.doi, r.path, r.facility, r.elements.join(' ')].join(' ').toLowerCase().includes(q)));
    panel.refresh();
    renderPills();
    replace(listEl,
      shown.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null,
          h('th', null, T('種別', 'Kind')), h('th', null, T('文献', 'Reference')), h('th', { class: 'num' }, T('データ点', 'Data points')),
          h('th', null, T('元素', 'Elements')), h('th', null, T('施設', 'Facility')), h('th', null, T('状態', 'Status')))),
        h('tbody', null, shown.map((r) => h('tr', { class: 'selectable', onclick: () => navigate('edit', { path: r.path }) },
          h('td', { class: 'nowrap' }, h('i', { class: `ds-dot ${r.code}` }), ` ${r.code || '?'}`),
          h('td', null, h('a', { href: `#/edit?path=${encodeURIComponent(r.path)}`, onclick: (e) => e.stopPropagation() }, h('strong', null, r.label)),
            h('div', { class: 'small muted' }, r.cite !== r.label ? r.cite : r.doi)),
          h('td', { class: 'num' }, String(r.count)),
          h('td', { class: 'small' }, r.elements.length > 12 ? `${r.elements.slice(0, 12).join(' ')} … (${r.elements.length})` : r.elements.join(' ')),
          h('td', { class: 'small' }, r.facility),
          h('td', { class: 'nowrap' },
            r.status !== 'unchanged' ? h('span', { class: `tag ${r.status}` }, statusLabel(r.status)) : null, ' ',
            r.outdated ? h('span', { class: 'tag bad' }, T('ほかの人が先に変更', 'changed by someone else')) : null, ' ',
            r.errors ? h('span', { class: 'tag bad' }, T(`エラー ${r.errors}`, `${r.errors} error(s)`)) : null, ' ',
            r.warnings ? h('span', { class: 'tag warn' }, T(`警告 ${r.warnings}`, `${r.warnings} warning(s)`)) : null))))))
        : h('div', { class: 'card-body muted' }, state.unsaved ? T('保存していないデータセットはありません。', 'Every dataset is saved.')
          : all.length ? T('条件に合うデータセットがありません。', 'No dataset matches.')
            : T('まだデータセットがありません。「新規データセット」から登録してください。', 'No datasets yet. Start with “New dataset”.')));
  }

  const search = h('input', { type: 'search', placeholder: T('著者・DOI・元素・施設で検索', 'Search author, DOI, element, facility'), 'aria-label': T('検索', 'Search') });
  search.addEventListener('input', () => { state.query = search.value; renderList(); });
  const pills = h('div', { class: 'pills' });
  const pill = (pressed, onclick, ...label) => h('button', { class: 'pill', 'aria-pressed': String(pressed), onclick }, label);
  const renderPills = () => replace(pills,
    pill(!state.code && !state.unsaved, () => { state.code = ''; state.unsaved = false; renderList(); }, T('すべて', 'All')),
    CODES.map((d) => pill(state.code === d, () => { state.code = d; renderList(); }, h('i', { class: `ds-dot ${d}` }), d)),
    pill(state.unsaved, () => { state.unsaved = !state.unsaved; renderList(); }, T('未保存', 'Not saved')));
  const newButtons = CODES.map((d) => h('button', {
    class: 'btn', type: 'button', title: CODE_TITLES[d], onclick: () => navigate('edit', { new: d }),
  }, `+ ${d}`));

  replace(root,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, T('データセット', 'Datasets')),
        h('p', { class: 'muted' }, T('LT サブライブラリ(寿命・捕獲率)。1つの論文が1ファイルです。', 'LT sub-library (lifetimes, capture rates). One publication is one file.'))),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, T('新規データセット:', 'New dataset:')), newButtons)),
    panel.el,
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, pills, h('div', { style: { width: 'min(360px, 100%)' } }, search)),
      listEl),
    h('p', { class: 'small muted' }, T('XR・ES・BR はデータ形式が確定していないため、まだ入力できません(docs/data-format.md 参照)。',
      'XR, ES and BR cannot be entered yet: their data format is not defined (see docs/data-format.md).')));
  renderList();
}

// ---------------------------------------------------------------------------
// master data
// ---------------------------------------------------------------------------

export function renderMaster(root, { workspace, toast }) {
  const facPath = `${MASTER_DIR}/facilities.json`;
  const facEl = h('div');
  const rawEl = h('div');
  let raw = null;              // { name, path, pane } of the file being edited directly

  function facilityDoc() {
    try { return jsonfmt.parse(workspace.text(facPath)); } catch (err) { return { format: MASTER_FORMATS['facilities.json'], facilities: [] }; }
  }

  function stageFacilities(doc) {
    workspace.stage(facPath, workspace.db.canonicalText(doc));
  }

  function renderFacilities() {
    const doc = facilityDoc();
    const used = new Map();
    for (const f of workspace.db.sortedFiles()) {
      if (f.meta.facility) used.set(f.meta.facility, (used.get(f.meta.facility) || 0) + 1);
    }
    const issues = workspace.issuesFor(facPath);
    const input = (fac, key, placeholder) => {
      const el = h('input', { type: 'text', value: fac[key] || '', placeholder });
      el.addEventListener('change', () => { fac[key] = el.value.trim(); stageFacilities(doc); renderFacilities(); });
      return el;
    };
    panel.refresh();
    replace(facEl,
      h('div', { class: 'table-wrap' }, h('table', { class: 'data grid' },
        h('thead', null, h('tr', null, h('th', null, T('略称(データから参照される名前)', 'Short name (used in the data)')),
          h('th', null, T('機関', 'Laboratory')), h('th', null, T('正式名称', 'Full name')), h('th', { class: 'num' }, T('使用数', 'Used')), h('th', null, ''))),
        h('tbody', null, doc.facilities.map((fac, i) => h('tr', null,
          h('td', null, input(fac, 'abbr', 'J-PARC (D1)')), h('td', null, input(fac, 'facility', 'J-PARC')),
          h('td', null, input(fac, 'detail', 'J-PARC MLF MUSE D1')),
          h('td', { class: 'num' }, String(used.get(fac.abbr) || 0)),
          h('td', null, h('button', {
            class: 'btn small ghost', type: 'button', disabled: Boolean(used.get(fac.abbr)),
            title: used.get(fac.abbr) ? T('使用中のため削除できません', 'In use: cannot be deleted') : T('削除', 'Delete'),
            onclick: () => { doc.facilities.splice(i, 1); stageFacilities(doc); renderFacilities(); },
          }, '✕'))))))),
      h('div', { class: 'card-body row' },
        h('button', { class: 'btn', type: 'button', onclick: () => {
          doc.facilities.push({ abbr: '', facility: '', detail: '' });
          stageFacilities(doc); renderFacilities();
          const inputs = facEl.querySelectorAll('tbody tr:last-child input');
          if (inputs[0]) inputs[0].focus();
        } }, T('+ 施設を追加', '+ Add facility')),
        workspace.status(facPath) !== 'unchanged' ? h('span', { class: `tag ${workspace.status(facPath)}` }, statusLabel(workspace.status(facPath))) : null,
        issues.map((i) => h('span', { class: `tag ${i.level === 'error' ? 'bad' : 'warn'}`, title: i.pointer }, i.message))));
  }

  /** Take over the text of the file being edited directly. Returns false (and reports) when it is not valid. */
  function applyRaw() {
    if (!raw || !raw.pane.dirty()) return true;
    let obj;
    try {
      obj = jsonfmt.parse(raw.pane.value());
    } catch (err) {
      toast(T(`JSON として読めません: ${err.message}`, `Not valid JSON: ${err.message}`), 'bad');
      return false;
    }
    workspace.stage(raw.path, workspace.db.canonicalText(obj));
    return true;
  }

  function closeRaw() {
    if (raw) raw.pane.dispose();
    raw = null;
  }

  function openRaw(name) {
    if (!applyRaw()) return;
    closeRaw();
    const path = `${MASTER_DIR}/${name}`;
    const pane = jsonPane(path, workspace.text(path) || '', workspace.schemas);
    raw = { name, path, pane };
    replace(rawEl,
      h('div', { class: 'card-head' }, h('h3', null, path), h('div', { class: 'row' }, pane.note,
        h('button', { class: 'btn', type: 'button', onclick: () => {
          if (!applyRaw()) return;
          toast(T('反映しました(まだ保存されていません)', 'Applied (not saved yet)'));
          renderFacilities();
          openRaw(name);
        } }, T('反映', 'Apply')))),
      pane.el);
  }

  const panel = savePanel({ workspace }, {
    prepare: applyRaw,
    saved: () => { renderFacilities(); if (raw) openRaw(raw.name); },
    changed: () => { renderFacilities(); if (raw) openRaw(raw.name); },
  });

  replace(root,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, T('マスタデータ', 'Master data')),
      h('p', { class: 'muted' }, T('データセットから参照される共通の表です。変更は「保存」を押すと記録されます。', 'Tables shared by all datasets. Changes are recorded when you press “Save”.')))),
    panel.el,
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, T('施設', 'Facilities')),
        h('span', { class: 'small muted' }, T('実験データの「施設」欄の選択肢になります', 'These are the choices of the “Facility” field of experimental data'))),
      facEl),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, T('ファイルを直接編集', 'Edit files directly')),
        h('div', { class: 'row' }, MASTER_FILES.map((name) => h('button', { class: 'btn', type: 'button', onclick: () => openRaw(name) }, name)))),
      h('div', { class: 'card-body small muted' }, T('Huff 因子・定数・核種表は変換結果すべてに影響します。変更は慎重に行ってください。',
        'Huff factors, constants and the nuclide table affect every converted value. Change them with care.')),
      rawEl));
  renderFacilities();
  return { flush: applyRaw, destroy: closeRaw };
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

export function renderHistory(root, { backend }, params) {
  const path = params.get('path') || '';
  const listEl = h('div', { class: 'card-body muted' }, T('読み込み中…', 'Loading …'));
  replace(root,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, T('履歴', 'History')),
      h('p', { class: 'muted' }, path ? h('span', null, h('code', null, path), ' ', h('a', { href: '#/history' }, T('(すべての履歴)', '(all saves)')))
        : T('データの保存の記録です(新しい順)。', 'The saves of the data, newest first.')))),
    h('section', { class: 'card' }, listEl));
  showHistory(listEl, backend, path);
}

async function showHistory(listEl, backend, path) {
  try {
    const entries = await backend.history(path || 'data', 50);
    replace(listEl, entries.length ? h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, T('日時', 'When')), h('th', null, T('誰が', 'Who')), h('th', null, T('内容', 'What')), h('th', null, ''))),
      h('tbody', null, entries.map((e) => h('tr', null,
        h('td', { class: 'nowrap' }, date(e.date)),
        h('td', { class: 'nowrap' }, e.author),
        h('td', null, e.message),
        h('td', { class: 'nowrap' }, h('code', { class: 'muted' }, e.sha.slice(0, 7)))))))
      : T('まだ履歴がありません。', 'No history yet.'));
    listEl.className = entries.length ? 'table-wrap' : 'card-body muted';
  } catch (err) {
    replace(listEl, T('履歴を取得できませんでした: ', 'The history could not be read: '), problemText(err));
  }
}

// ---------------------------------------------------------------------------
// publishing a version
// ---------------------------------------------------------------------------

/**
 * The state shown is the saved one: VERSION and the versions published so far
 * (the tags vX.Y.Z).  When the saved VERSION has not been published (the
 * last attempt could not finish), only that is offered.
 */
export function renderRelease(root, { workspace, backend, toast }) {
  const state = { part: 'patch', busy: false, result: null, tags: null };
  const notes = h('textarea', { id: 'release-notes', rows: 5, placeholder: T('この版での主な変更点(1行に1項目)', 'Main changes of this version (one per line)') });
  const version = () => (workspace.upstreamText('VERSION') || '').trim();

  /** Read the published versions again and show the page. */
  async function refresh() {
    try {
      state.tags = await backend.tags();
    } catch (err) {
      state.tags = null;
      state.result = h('p', { class: 'notice bad' }, T('公開済みの版を読めませんでした: ', 'The published versions could not be read: '), problemText(err));
    }
    if (root.isConnected) draw();
  }

  function draw() {
    const tags = state.tags || [];
    const current = version();
    const unpublished = Boolean(state.tags && current && !tags.some((t) => t.name === `v${current}`));
    const next = nextVersion(current || '0.0.0', state.part);
    const pending = workspace.changes().length;
    const errors = workspace.issues().filter((i) => i.level === 'error').length;
    const button = h('button', {
      class: 'btn primary', type: 'button', disabled: state.busy || !state.tags || Boolean(pending) || Boolean(errors),
      onclick: unpublished ? () => finish(current) : publish,
    }, unpublished ? T(`v${current} の公開を完了`, `Complete publishing v${current}`) : T(`v${next} を公開`, `Publish v${next}`));
    const parts = [
      ['patch', T('パッチ: 誤記の訂正など', 'Patch: corrections')],
      ['minor', T('マイナー: データの追加', 'Minor: data added')],
      ['major', T('メジャー: 公開版として固定', 'Major: frozen public version')],
    ];
    replace(root,
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, T('版を公開', 'Publish a version')),
        h('p', { class: 'muted' }, T('データに版番号を付けて公開します。メジャー版(v1.0.0, v2.0.0 …)だけが公開サイトで「固定バージョン」として選べるようになり、それ以外の版は履歴として残ります。',
          'Give the data a version number. Only major versions (v1.0.0, v2.0.0 …) become fixed versions on the public site; the others are kept in the history.')))),
      h('section', { class: 'card' },
        h('div', { class: 'card-body stack' },
          h('dl', { class: 'kv' },
            h('dt', null, T('現在の版', 'Current version')), h('dd', null, h('strong', null, current || '—')),
            h('dt', null, T('公開済みの版', 'Published versions')),
            h('dd', null, !state.tags ? '—' : tags.length ? tags.map((t) => t.name).join(', ') : T('まだありません', 'none yet')),
            unpublished ? null : [h('dt', null, T('次の版', 'Next version')), h('dd', null, h('strong', null, `v${next}`))]),
          unpublished
            ? h('p', { class: 'notice warn' }, T(`版 ${current} は VERSION に記録されていますが、公開の手続きが終わっていません。「v${current} の公開を完了」を押すと、版番号を ${current} にしたときに保存された状態を v${current} として公開します(その後に保存した変更は含みません)。`,
              `Version ${current} is recorded in VERSION but its publication did not finish. “Complete publishing v${current}” publishes the state saved when the version number became ${current} as v${current} (changes saved afterwards are not part of it).`))
            : [
              h('div', { class: 'pills', role: 'radiogroup' }, parts.map(([key, label]) => h('button', {
                class: 'pill', role: 'radio', 'aria-checked': String(state.part === key), onclick: () => { state.part = key; draw(); },
              }, label))),
              h('div', { class: 'field wide' }, h('label', { for: 'release-notes' }, T('変更点(CHANGELOG.md に記録されます)', 'Changes (recorded in CHANGELOG.md)')), notes),
            ],
          pending ? h('p', { class: 'notice warn' }, T('保存していない変更があります。先に保存してください。', 'There are unsaved changes. Save them first.')) : null,
          errors ? h('p', { class: 'notice bad' }, T('データにエラーがあります。', 'The data has errors.')) : null,
          h('div', { class: 'row' }, button), state.result)));
  }

  /** Notice about a published version ({ name, sent, error } of the server). */
  const published = (tag, major) => (tag.sent
    ? h('p', { class: 'notice good' }, T(`${tag.name} を公開しました。`, `Published ${tag.name}.`),
      tag.frozen ? T(` 固定版 ${tag.frozen} のファイルを作成して保存しました(今後は作り直されません)。`, ` The files of the fixed version ${tag.frozen} were made and saved (they are never rebuilt).`) : '',
      major ? T(' 数分後に公開サイトの固定バージョンとして選べるようになります。', ' It becomes a fixed version of the public site within minutes.') : '')
    : h('p', { class: 'notice warn' }, T(`${tag.name} を記録しましたが、まだ送信していません: `, `${tag.name} is recorded but not sent yet: `),
      tag.error ? problemText(tag.error) : T('送信先の GitHub が設定されていません。', 'there is no GitHub copy to send to.')));

  async function finish(current) {
    if (!confirm(T(`版番号を ${current} にしたときに保存された状態を v${current} として公開します。公開した版は後から変更できません。よろしいですか?`,
      `Publish the state saved when the version number became ${current} as v${current}? A published version cannot be changed afterwards.`))) return;
    state.busy = true;
    draw();
    try {
      state.result = published(await backend.tag(`v${current}`), /^\d+\.0\.0$/.test(current));
    } catch (err) {
      state.result = h('p', { class: 'notice bad' }, T('公開できませんでした: ', 'Could not publish: '), problemText(err));
    }
    state.busy = false;
    await refresh();
  }

  async function publish() {
    const lines = notes.value.split('\n').map((l) => l.trim().replace(/^[-*]\s*/, '')).filter(Boolean);
    if (!lines.length) { toast(T('変更点を入力してください', 'Please describe the changes'), 'bad'); notes.focus(); return; }
    const today = new Date().toISOString().slice(0, 10);
    const next = releaseChanges(version(), workspace.upstreamText('CHANGELOG.md'), state.part, lines, today);
    if (!confirm(T(`v${next.version} を公開します。公開した版は後から変更できません。よろしいですか?`, `Publish v${next.version}? A published version cannot be changed afterwards.`))) return;
    state.busy = true;
    draw();
    workspace.stage('VERSION', `${next.version}\n`);
    workspace.stage('CHANGELOG.md', next.changelog);
    let saved = false;
    try {
      await workspace.save(`Release ${next.version}`);
      saved = true;
    } catch (err) {
      workspace.discard('VERSION');
      workspace.discard('CHANGELOG.md');
      state.result = h('p', { class: 'notice bad' }, T('公開できませんでした: ', 'Could not publish: '), problemText(err));
    }
    if (saved) {
      notes.value = '';
      try {
        state.result = published(await backend.tag(`v${next.version}`), state.part === 'major');
      } catch (err) {
        state.result = h('p', { class: 'notice bad' }, T('VERSION と CHANGELOG.md は保存しましたが、公開の手続きを終えられませんでした: ',
          'VERSION and CHANGELOG.md were saved, but the publication could not be finished: '), problemText(err));
      }
    }
    state.busy = false;
    await refresh();
  }

  replace(root, h('p', { class: 'muted' }, T('読み込み中…', 'Loading …')));
  refresh();
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

export function renderHelp(root, { backend }) {
  const repository = backend.repository;
  const clone = repository || 'mu-nd/mund';
  const docs = (name) => `https://github.com/${repository}/blob/${backend.branch}/docs/${name}`;
  const code = (text) => h('code', null, text);
  replace(root,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, T('使い方', 'Help')))),
    h('section', { class: 'card' }, h('div', { class: 'card-body prose' },
      h('h2', null, T('毎日の使い方', 'Everyday use')),
      h('ol', null,
        h('li', null, T('ターミナルでデータのフォルダ(mund)に移り、', 'In a terminal, go to the folder of the data (mund) and run '), code('pixi run admin'),
          T(' を実行します。ブラウザでこのツールが開きます(終わるときはターミナルで Ctrl+C)。', '. The tool opens in the browser (Ctrl+C in the terminal stops it).')),
        h('li', null, T('「データセット」でファイルを開くか、+ EXP などで新しく作ります。', 'Open a file under “Datasets”, or start a new one with + EXP or another kind.')),
        h('li', null, T('DOI を入力して「書誌情報を取得」を押します(Crossref または DataCite から取得します)。DOI がない文献は「DOI なし…」で仮の識別子を付け、書誌情報を手入力します。',
          'Type the DOI and press “Look up” (the data come from Crossref or DataCite). For a source without DOI use “No DOI …” and type the bibliographic data.')),
        h('li', null, T('条件とデータ点を入力します。表計算ソフトから貼り付けることもできます。換算値と「確認」欄で入力ミスに気付けます。',
          'Fill in the conditions and the data points; they can also be pasted from a spreadsheet. The converted value and the “Check” column help to spot typing errors.')),
        h('li', null, T('「保存」を押します。チェックを通ると記録され、GitHub に送信されます。「変更の説明」は任意です。',
          'Press “Save”. When the checks pass, the change is recorded and sent to GitHub. The description is optional.'))),
      h('h2', null, T('覚えておくこと', 'Good to know')),
      h('ul', null,
        h('li', null, T('入力した内容は、有効な DOI が入っていれば、保存するまでこのブラウザに残ります。保存していないファイルには「未保存」と表示され、画面上部の「未保存」から一覧できます。ツールを終了しても残りますが、ほかのブラウザからは見えないので、区切りのよいところで保存してください。',
          'Once a valid DOI is given, what you type is kept in this browser until you save, also when the tool is stopped and started again. Files not saved yet are marked “not saved”; the “not saved” badge at the top lists them. Other browsers do not see them, so save at a good moment.')),
        h('li', null, T('「未送信」は、保存したけれどまだ GitHub に届いていない変更の数です(オフラインのときなど)。「再送信」で送れます。',
          '“Not sent” counts saves that have not reached GitHub yet (for example while offline). “Send again” sends them.')),
        h('li', null, T('「再読み込み」で、ほかの人の変更を含む最新の状態にします。', '“Reload” brings in the latest state, including other people’s changes.')),
        h('li', null, T('ID(MetaID と各行の datasetId)は自動で計算されます。値・不確かさ・コメントを直しても、行を並べ替えても ID は変わりません。保存済みの行の元素・質量数・Key(またはファイルの DOI・Key)を変えると ID が変わり、「同じデータの訂正」か「別のデータ」かを選ぶよう求められます。訂正なら以前の ID が legacyIds に記録され、その行を元データに挙げているデータも新しい ID に付け替えられます。',
          'Identifiers (the MetaID and the datasetId of each row) are computed automatically. Correcting a value, uncertainty or comment, or reordering rows, keeps them. Changing element, mass number or key of a saved row (or DOI or key of the file) changes them, and you are asked whether it is a correction of the same data or different data. For a correction the former ID is recorded in legacyIds and data naming the row as original data are changed to the new ID.')),
        h('li', null, T('キュレーションデータ(CUR)は「元データ」に実験データの datasetId を指定します。「…」ボタンで選べます。選んだときの元データの内容(entryHash)も記録され、後で元データが変わると「再確認が必要」と表示されます。値を確かめてから「確認しました」を押してください。',
          'Curated data (CUR) list the datasetIds of the experimental data they come from; pick them with the “…” button. The content of the original data at that moment (entryHash) is recorded; when the original changes later, “Check again” is shown. Check the value, then press “Checked”.')),
        h('li', null, T('論文の値は「値の抽出」で、2人(または人と AI)が互いに見ずに読み取り、比較・判定し、責任者が承認してからデータに登録できます(docs/extraction.ja.md)。',
          'Values from a publication can be read twice, independently (two people, or a person and AI), under “Extraction”, compared, decided and approved by a responsible person before they are registered in the data (docs/extraction.ja.md).')),
        h('li', null, T('練習するときは ', 'To practise, start '), code('pixi run admin-practice'),
          T(' で起動します。練習用のコピーが使われ、本物のデータには何も届きません。', ': it works on a throw-away copy, and nothing reaches the real data.'))),
      h('h2', null, T('保存できないとき', 'When saving is refused')),
      h('ul', null,
        h('li', null, T('エラーがあると保存できません。「チェック結果」の項目を押すと、該当の欄に移動します。', 'Errors must be fixed first; click an item under “Checks” to go to the field.')),
        h('li', null, T('「ほかの人が先に変更したため、保存しませんでした」: 「保存されるファイル」で差分を確認し、自分の変更を残すなら「最新版を基準にする」、やめるなら「破棄」を押して、もう一度保存します。',
          '“Someone else changed these files first”: check the changes under “Files to be saved”, press “Rebase on latest” to keep yours or “Discard”, then save again.')),
        h('li', null, T('GitHub へのログインが必要と表示されたら、ターミナルで ', 'If GitHub needs a login, run '), code('pixi run login'),
          T(' を一度実行してから「再送信」を押します。', ' once in a terminal, then press “Send again”.'))),
      h('h2', null, T('最初に一度だけ行う準備', 'One-time setup')),
      h('ol', null,
        h('li', null, T('pixi をインストールします(https://pixi.sh)。', 'Install pixi (https://pixi.sh).')),
        h('li', null, T('データを取得します: ', 'Get the data: '), code(`pixi exec --spec gh --spec git -- gh repo clone ${clone}`), T('、続けて ', ', then '), code(`cd ${clone.split('/')[1]}`)),
        h('li', null, code('pixi run login'), T(' を一度実行して GitHub にログインします。', ' once to log in to GitHub.'))),
      repository ? h('p', null, h('a', { href: docs('admin-guide.ja.md'), target: '_blank', rel: 'noopener' }, T('詳しい手引き', 'Detailed guide (Japanese)')), ' · ',
        h('a', { href: docs('data-format.md'), target: '_blank', rel: 'noopener' }, T('データ形式', 'Data format')), ' · ',
        h('a', { href: docs('id-definition.md'), target: '_blank', rel: 'noopener' }, T('ID の定義', 'Definition of the identifiers'))) : null)));
}
