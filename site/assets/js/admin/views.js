// Pages of the admin UI other than the dataset editor.

import { h, replace } from '../core/dom.js';
import * as jsonfmt from '../core/jsonfmt.js';
import * as schemaMod from '../core/schema.js';
import { DATASETS, DATASET_TITLES, MASTER_FILES } from '../core/checks.js';
import { citeLabel, citeText, MASTER_DIR } from '../core/cite.js';
import { T } from './i18n.js';
import { renderDiff, diffLines, diffStats } from './diff.js';
import { isDatasetPath } from './workspace.js';
import { ConflictError } from './backend.js';
import { loadMonaco, monacoTheme, configureSchemas, modelFor } from './monaco.js';

const statusLabel = (s) => ({
  modified: T('変更あり', 'modified'), added: T('新規', 'new'), deleted: T('削除', 'deleted'), unchanged: '',
}[s]);

function date(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------------------------------------------------------------------------
// list of datasets
// ---------------------------------------------------------------------------

export function renderDatasets(root, app) {
  const { workspace } = app;
  const state = { query: '', dataset: '' };
  const listEl = h('div');

  function rows() {
    const db = workspace.db;
    const issues = workspace.issues();
    return db.sortedFiles().map((f) => {
      const elements = [...new Set(f.data.map((r) => r.nuclide && r.nuclide.element).filter(Boolean))];
      const own = issues.filter((i) => i.file === f.path);
      const reference = db.reference(f.meta.bibId);
      return {
        path: f.path, dataset: f.code, label: f.obj ? citeLabel(reference, f.meta.bibId) : f.path,
        cite: f.obj ? citeText(reference, f.meta.bibId) : '',
        count: f.data.length, elements, status: workspace.status(f.path),
        errors: own.filter((i) => i.level === 'error').length, warnings: own.filter((i) => i.level === 'warning').length,
        doi: f.meta.bibId || '', facility: f.meta.facility || '',
      };
    });
  }

  function renderList() {
    const q = state.query.trim().toLowerCase();
    const all = rows();
    const shown = all.filter((r) => (!state.dataset || r.dataset === state.dataset)
      && (!q || [r.label, r.cite, r.doi, r.path, r.facility, r.elements.join(' ')].join(' ').toLowerCase().includes(q)));
    replace(listEl,
      shown.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null,
          h('th', null, T('種別', 'Kind')), h('th', null, T('文献', 'Reference')), h('th', { class: 'num' }, T('データ点', 'Data points')),
          h('th', null, T('元素', 'Elements')), h('th', null, T('施設', 'Facility')), h('th', null, T('状態', 'Status')))),
        h('tbody', null, shown.map((r) => h('tr', { class: 'selectable', onclick: () => app.navigate('edit', { path: r.path }) },
          h('td', { class: 'nowrap' }, h('i', { class: `ds-dot ${r.dataset}` }), ` ${r.dataset || '?'}`),
          h('td', null, h('a', { href: `#/edit?path=${encodeURIComponent(r.path)}`, onclick: (e) => e.stopPropagation() }, h('strong', null, r.label)),
            h('div', { class: 'small muted' }, r.cite !== r.label ? r.cite : r.doi)),
          h('td', { class: 'num' }, String(r.count)),
          h('td', { class: 'small' }, r.elements.length > 12 ? `${r.elements.slice(0, 12).join(' ')} … (${r.elements.length})` : r.elements.join(' ')),
          h('td', { class: 'small' }, r.facility),
          h('td', { class: 'nowrap' },
            r.status !== 'unchanged' ? h('span', { class: `tag ${r.status}` }, statusLabel(r.status)) : null, ' ',
            r.errors ? h('span', { class: 'tag bad' }, T(`エラー ${r.errors}`, `${r.errors} error(s)`)) : null, ' ',
            r.warnings ? h('span', { class: 'tag warn' }, T(`警告 ${r.warnings}`, `${r.warnings} warning(s)`)) : null))))))
        : h('div', { class: 'card-body muted' }, all.length ? T('条件に合うデータセットがありません。', 'No dataset matches.')
          : T('まだデータセットがありません。「新規データセット」から登録してください。', 'No datasets yet. Start with “New dataset”.')));
  }

  const search = h('input', { type: 'search', placeholder: T('著者・DOI・元素・施設で検索', 'Search author, DOI, element, facility'), 'aria-label': T('検索', 'Search') });
  search.addEventListener('input', () => { state.query = search.value; renderList(); });
  const pills = h('div', { class: 'pills' });
  const renderPills = () => replace(pills,
    h('button', { class: 'pill', 'aria-pressed': String(!state.dataset), onclick: () => { state.dataset = ''; renderPills(); renderList(); } }, T('すべて', 'All')),
    DATASETS.map((d) => h('button', {
      class: 'pill', 'aria-pressed': String(state.dataset === d), onclick: () => { state.dataset = d; renderPills(); renderList(); },
    }, h('i', { class: `ds-dot ${d}` }), d)));
  const newButtons = DATASETS.map((d) => h('button', {
    class: 'btn', type: 'button', title: DATASET_TITLES[d], onclick: () => app.navigate('edit', { new: d }),
  }, `+ ${d}`));

  replace(root,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, T('データセット', 'Datasets')),
        h('p', { class: 'muted' }, T('LT サブライブラリ(寿命・捕獲率)。1つの論文が1ファイルです。', 'LT sub-library (lifetimes, capture rates). One publication is one file.'))),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, T('新規データセット:', 'New dataset:')), newButtons)),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, pills, h('div', { style: { width: 'min(360px, 100%)' } }, search)),
      listEl),
    h('p', { class: 'small muted' }, T('XR・ES・BR はデータ形式が確定していないため、まだ入力できません(docs/data-format.md 参照)。',
      'XR, ES and BR cannot be entered yet: their data format is not defined (see docs/data-format.md).')));
  renderPills();
  renderList();
}

// ---------------------------------------------------------------------------
// master data
// ---------------------------------------------------------------------------

export function renderMaster(root, app) {
  const { workspace } = app;
  const facPath = `${MASTER_DIR}/facilities.json`;
  const facEl = h('div');
  const rawEl = h('div');
  let jsonEditor = null;

  function facilityDoc() {
    try { return jsonfmt.parse(workspace.text(facPath)); } catch (err) { return { format: 'muND/facilities/1', facilities: [] }; }
  }

  function saveFacilities(doc) {
    const schema = workspace.schemas['facilities.schema.json'];
    workspace.stage(facPath, jsonfmt.stringify(schema ? schemaMod.normalize(doc, schema) : doc));
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
      el.addEventListener('change', () => { fac[key] = el.value.trim(); saveFacilities(doc); renderFacilities(); });
      return el;
    };
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
            onclick: () => { doc.facilities.splice(i, 1); saveFacilities(doc); renderFacilities(); },
          }, '✕'))))))),
      h('div', { class: 'card-body row' },
        h('button', { class: 'btn', type: 'button', onclick: () => {
          doc.facilities.push({ abbr: '', facility: '', detail: '' });
          saveFacilities(doc); renderFacilities();
          const inputs = facEl.querySelectorAll('tbody tr:last-child input');
          if (inputs[0]) inputs[0].focus();
        } }, T('+ 施設を追加', '+ Add facility')),
        workspace.status(facPath) !== 'unchanged' ? h('span', { class: 'tag modified' }, T('変更あり(未コミット)', 'modified (not committed)')) : null,
        issues.map((i) => h('span', { class: `tag ${i.level === 'error' ? 'bad' : 'warn'}`, title: i.pointer }, i.message))));
  }

  async function openRaw(name) {
    const path = `${MASTER_DIR}/${name}`;
    const holder = h('div', { class: 'monaco-holder' });
    const note = h('span', { class: 'small muted' }, T('読み込み中…', 'Loading …'));
    let text = workspace.text(path) || '';
    const apply = () => {
      const value = jsonEditor ? jsonEditor.getValue() : text;
      let obj;
      try { obj = jsonfmt.parse(value); } catch (err) { app.toast(T(`JSON として読めません: ${err.message}`, `Not valid JSON: ${err.message}`), 'bad'); return; }
      const schema = workspace.db.schemaFor(String(obj.format));
      workspace.stage(path, jsonfmt.stringify(schema ? schemaMod.normalize(obj, schema) : obj));
      app.toast(T('反映しました', 'Applied'));
      renderFacilities();
      openRaw(name);
    };
    replace(rawEl,
      h('div', { class: 'card-head' }, h('h3', null, path), h('div', { class: 'row' }, note,
        h('button', { class: 'btn primary', type: 'button', onclick: apply }, T('反映', 'Apply')))),
      holder);
    try {
      const monaco = await loadMonaco();
      configureSchemas(monaco, workspace.schemas);
      if (jsonEditor) jsonEditor.dispose();
      jsonEditor = monaco.editor.create(holder, {
        model: modelFor(monaco, path, text), theme: monacoTheme(), automaticLayout: true, minimap: { enabled: false },
        scrollBeyondLastLine: false, tabSize: 2, fontSize: 13,
      });
      note.textContent = '';
    } catch (err) {
      jsonEditor = null;
      const area = h('textarea', { class: 'json-fallback mono', rows: 24, spellcheck: 'false' });
      area.value = text;
      area.addEventListener('input', () => { text = area.value; });
      replace(holder, area);
      note.textContent = T('簡易エディタ(Monaco を読み込めませんでした)', 'Plain editor (Monaco could not be loaded)');
    }
  }

  replace(root,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, T('マスタデータ', 'Master data')),
      h('p', { class: 'muted' }, T('データセットから参照される共通の表です。', 'Tables shared by all datasets.')))),
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
  return () => { if (jsonEditor) jsonEditor.dispose(); };
}

// ---------------------------------------------------------------------------
// pending changes and commit
// ---------------------------------------------------------------------------

function defaultMessage(workspace) {
  const parts = [];
  for (const c of workspace.changes()) {
    if (c.status === 'deleted' && workspace.changes().some((o) => workspace.drafts.get(o.path) && workspace.drafts.get(o.path).origin === c.path)) continue;
    let label = c.path.split('/').pop().replace(/\.json$/, '');
    let where = c.path.split('/').slice(1, 3).join('/');
    let n = '';
    if (isDatasetPath(c.path) && c.content) {
      try {
        const obj = jsonfmt.parse(c.content);
        const bibId = (obj.meta || {}).bibId;
        label = citeLabel(workspace.db.reference(bibId), bibId);
        n = ` (${(obj.data || []).length} data entries)`;
      } catch (err) { /* keep the file name */ }
    } else if (!isDatasetPath(c.path)) {
      where = 'master';
    }
    const verb = { added: 'add', modified: 'update', deleted: 'remove' }[c.status];
    parts.push(`${where}: ${verb} ${label}${c.status === 'added' ? n : ''}`);
  }
  if (parts.length <= 1) return parts[0] || '';
  return `Update ${parts.length} files\n\n${parts.map((p) => `- ${p}`).join('\n')}`;
}

export function renderChanges(root, app) {
  const { workspace, backend } = app;
  const changes = workspace.changes();
  const issues = workspace.issues();
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const outdated = changes.filter((c) => workspace.isOutdated(c.path));
  const info = backend.info || {};
  const state = { mode: 'direct', busy: false };
  const message = h('textarea', { rows: 4, spellcheck: 'false' });
  message.value = defaultMessage(workspace);
  const resultEl = h('div');
  const button = h('button', { class: 'btn primary', type: 'button' });

  async function commit() {
    if (state.busy) return;
    const text = message.value.trim();
    if (!text) { app.toast(T('変更内容の説明を入力してください', 'Please describe the change'), 'bad'); message.focus(); return; }
    state.busy = true;
    button.disabled = true;
    button.textContent = T('コミット中…', 'Committing …');
    try {
      const result = await workspace.commit(text, state.mode);
      app.afterCommit(result);
    } catch (err) {
      state.busy = false;
      button.disabled = false;
      updateButton();
      if (err instanceof ConflictError) {
        replace(resultEl, h('p', { class: 'notice bad' },
          T('ほかの人がこのファイルを先に更新しました。最新の状態を読み込み直してから、もう一度変更してください: ',
            'Someone else changed these files first. Reload the latest state and redo your change: '), err.paths.join(', '), ' ',
          h('button', { class: 'btn small', type: 'button', onclick: () => app.reload() }, T('再読み込み', 'Reload'))));
      } else {
        replace(resultEl, h('p', { class: 'notice bad' }, T(`コミットできませんでした: ${err.message}`, `Commit failed: ${err.message}`),
          err.status === 403 || err.status === 404 ? T(' (書き込み権限またはトークンの権限を確認してください)', ' (check your write access and the permissions of the token)') : ''));
      }
    }
  }
  button.addEventListener('click', commit);

  function updateButton() {
    button.textContent = state.mode === 'pr' ? T('ブランチを作って Pull Request を出す', 'Create branch and pull request')
      : T(`${info.branch || 'main'} にコミット`, `Commit to ${info.branch || 'main'}`);
    button.disabled = Boolean(errors.length) || !changes.length || state.busy || (!info.canWrite && backend.kind === 'github');
  }

  const modeEl = h('div', { class: 'pills', role: 'radiogroup', 'aria-label': T('反映方法', 'How to publish') });
  const renderMode = () => {
    replace(modeEl,
      h('button', { class: 'pill', role: 'radio', 'aria-checked': String(state.mode === 'direct'), onclick: () => { state.mode = 'direct'; renderMode(); } },
        T('直接コミット', 'Commit directly')),
      h('button', { class: 'pill', role: 'radio', 'aria-checked': String(state.mode === 'pr'), onclick: () => { state.mode = 'pr'; renderMode(); } },
        T('Pull Request(レビューしてから反映)', 'Pull request (review first)')));
    updateButton();
  };

  const fileCards = changes.map((c) => {
    const before = workspace.baseline(c.path) !== null ? workspace.baseline(c.path) : workspace.upstreamText(c.path);
    const stats = diffStats(diffLines(before, c.content));
    const own = issues.filter((i) => i.file === c.path);
    return h('details', { class: 'card change' },
      h('summary', null,
        h('span', { class: `tag ${c.status}` }, statusLabel(c.status)), ' ', h('code', null, c.path), ' ',
        h('span', { class: 'small muted' }, `+${stats.added} / −${stats.removed}`), ' ',
        own.some((i) => i.level === 'error') ? h('span', { class: 'tag bad' }, T('エラーあり', 'has errors')) : null,
        workspace.isOutdated(c.path) ? h('span', { class: 'tag bad' }, T('リポジトリ側が更新済み', 'changed in the repository')) : null,
        h('span', { class: 'spacer' }),
        isDatasetPath(c.path) && c.content !== null ? h('a', { class: 'btn small', href: `#/edit?path=${encodeURIComponent(c.path)}` }, T('編集', 'Edit')) : null, ' ',
        h('button', { class: 'btn small', type: 'button', onclick: (e) => {
          e.preventDefault();
          if (confirm(T(`${c.path} の変更を破棄しますか?`, `Discard the change of ${c.path}?`))) { workspace.discard(c.path); app.render(); }
        } }, T('破棄', 'Discard'))),
      h('div', { class: 'card-body' }, renderDiff(before, c.content, 2)));
  });

  replace(root,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, T('未コミットの変更', 'Uncommitted changes')),
      h('p', { class: 'muted' }, T('ここにある変更はこのブラウザに保存されているだけです。コミットするとリポジトリに記録され、誰がいつ何を変えたかが残ります。',
        'These changes exist only in this browser. A commit records them in the repository together with who changed what and when.')))),
    !changes.length ? h('p', { class: 'notice' }, T('未コミットの変更はありません。', 'There are no uncommitted changes.')) : null,
    errors.length ? h('div', { class: 'notice bad' },
      h('strong', null, T(`エラーが ${errors.length} 件あるためコミットできません。`, `${errors.length} error(s) must be fixed before committing.`)),
      h('ul', { class: 'issue-list compact' }, errors.slice(0, 20).map((i) => h('li', null,
        isDatasetPath(i.file) ? h('a', { href: `#/edit?path=${encodeURIComponent(i.file)}` }, i.file.split('/').pop()) : i.file,
        ` ${i.pointer} — ${i.message}`)))) : null,
    !errors.length && warnings.length ? h('p', { class: 'notice warn' }, T(`警告が ${warnings.length} 件あります(コミットは可能です)。`, `${warnings.length} warning(s) (committing is possible).`)) : null,
    outdated.length ? h('p', { class: 'notice bad' }, T('リポジトリ側で更新されたファイルがあります。再読み込みして内容を確認してください。', 'Some files were changed in the repository. Reload and check.')) : null,
    fileCards,
    changes.length ? h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, T('コミット', 'Commit'))),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'field wide' }, h('label', { for: 'commit-message' }, T('変更内容の説明(1行目が見出しになります)', 'Describe the change (first line is the summary)')),
          Object.assign(message, { id: 'commit-message' })),
        modeEl,
        h('p', { class: 'small muted' }, backend.kind === 'demo'
          ? T('練習モード: コミットはこのブラウザ内にだけ記録され、GitHub には送られません。', 'Practice mode: commits stay in this browser and are not sent to GitHub.')
          : T(`${info.repo ? info.repo.name : ''} に ${info.user ? info.user.login : ''} として記録されます。直接コミットすると数分後に公開サイトへ反映されます。`,
            `Recorded in ${info.repo ? info.repo.name : ''} as ${info.user ? info.user.login : ''}. A direct commit reaches the public site within minutes.`)),
        !info.canWrite && backend.kind === 'github' ? h('p', { class: 'notice warn' }, T('このトークンには書き込み権限がありません。', 'This token has no write access.')) : null,
        h('div', { class: 'row' }, button,
          h('button', { class: 'btn', type: 'button', onclick: () => {
            if (confirm(T('すべての変更を破棄しますか?', 'Discard all changes?'))) { workspace.discardAll(); app.render(); }
          } }, T('すべて破棄', 'Discard all'))),
        resultEl)) : null);
  renderMode();
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

export async function renderHistory(root, app, params) {
  const path = params.get('path') || '';
  const listEl = h('div', { class: 'card-body muted' }, T('読み込み中…', 'Loading …'));
  replace(root,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, T('変更履歴', 'History')),
      h('p', { class: 'muted' }, path ? h('span', null, h('code', null, path), ' ', h('a', { href: '#/history' }, T('(すべての履歴)', '(all changes)')))
        : T('データに対するコミットの一覧です。', 'Commits that changed the data.')))),
    h('section', { class: 'card' }, listEl));
  try {
    const commits = await app.backend.history(path || 'data', 50);
    replace(listEl, commits.length ? h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, T('日時', 'When')), h('th', null, T('誰が', 'Who')), h('th', null, T('内容', 'What')), h('th', null, ''))),
      h('tbody', null, commits.map((c) => h('tr', null,
        h('td', { class: 'nowrap' }, date(c.date)),
        h('td', { class: 'nowrap' }, c.author, c.login && c.login !== c.author ? h('span', { class: 'muted small' }, ` @${c.login}`) : null),
        h('td', null, h('strong', null, c.message.split('\n')[0]),
          c.message.includes('\n') ? h('div', { class: 'small muted pre' }, c.message.split('\n').slice(1).join('\n').trim()) : null),
        h('td', { class: 'nowrap' }, c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener' }, h('code', null, c.sha.slice(0, 7))) : h('code', null, c.sha.slice(0, 7)))))))
      : T('まだ履歴がありません。', 'No history yet.'));
    listEl.className = commits.length ? 'table-wrap' : 'card-body muted';
  } catch (err) {
    replace(listEl, T(`履歴を取得できませんでした: ${err.message}`, `History could not be loaded: ${err.message}`));
  }
}

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

function bump(version, part) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version) || [0, 0, 0, 0];
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (part === 'major') return `${v[0] + 1}.0.0`;
  if (part === 'minor') return `${v[0]}.${v[1] + 1}.0`;
  return `${v[0]}.${v[1]}.${v[2] + 1}`;
}

export async function renderRelease(root, app) {
  const { workspace, backend } = app;
  const current = (workspace.text('VERSION') || '0.0.0').trim();
  const state = { part: 'patch', busy: false };
  const notes = h('textarea', { rows: 5, placeholder: T('このバージョンでの主な変更点(1行に1項目)', 'Main changes of this version (one per line)') });
  const tagsEl = h('span', { class: 'muted' }, '…');
  const resultEl = h('div');
  const nextEl = h('strong');
  const button = h('button', { class: 'btn primary', type: 'button' });
  const pending = workspace.changes().length;
  const errors = workspace.issues().filter((i) => i.level === 'error').length;

  const partEl = h('div', { class: 'pills', role: 'radiogroup' });
  const renderPart = () => {
    const options = [
      ['patch', T('パッチ: 誤記の訂正など', 'Patch: corrections')],
      ['minor', T('マイナー: データの追加', 'Minor: data added')],
      ['major', T('メジャー: 公開版として固定', 'Major: frozen public version')],
    ];
    replace(partEl, options.map(([key, label]) => h('button', {
      class: 'pill', role: 'radio', 'aria-checked': String(state.part === key), onclick: () => { state.part = key; renderPart(); },
    }, label)));
    const next = bump(current, state.part);
    nextEl.textContent = `v${next}`;
    button.textContent = T(`v${next} をリリース`, `Release v${next}`);
    button.disabled = Boolean(pending) || Boolean(errors) || state.busy;
  };

  button.addEventListener('click', async () => {
    const next = bump(current, state.part);
    const lines = notes.value.split('\n').map((l) => l.trim().replace(/^[-*]\s*/, '')).filter(Boolean);
    if (!lines.length) { app.toast(T('変更点を入力してください', 'Please describe the changes'), 'bad'); notes.focus(); return; }
    if (!confirm(T(`v${next} をリリースします。タグは後から変更できません。よろしいですか?`, `Release v${next}? A tag cannot be changed afterwards.`))) return;
    state.busy = true;
    renderPart();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const changelog = workspace.text('CHANGELOG.md') || '# Changelog\n';
      const entry = `## ${next} - ${today}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`;
      const marker = changelog.search(/^## /m);
      const updated = marker < 0 ? `${changelog.replace(/\n*$/, '\n\n')}${entry}` : `${changelog.slice(0, marker)}${entry}\n${changelog.slice(marker)}`;
      workspace.stage('VERSION', `${next}\n`);
      workspace.stage('CHANGELOG.md', updated);
      const result = await workspace.commit(`Release ${next}`, 'direct');
      const tag = await backend.createTag(`v${next}`, result.sha);
      replace(resultEl, h('p', { class: 'notice good' }, T(`v${next} をリリースしました。`, `Released v${next}.`), ' ',
        tag.url ? h('a', { href: tag.url, target: '_blank', rel: 'noopener' }, tag.name) : tag.name,
        state.part === 'major' ? T(' 数分後に公開サイトの固定バージョンとして選べるようになります。', ' It becomes a fixed version of the public site within minutes.') : ''));
      app.refreshChrome();
    } catch (err) {
      workspace.discard('VERSION');
      workspace.discard('CHANGELOG.md');
      replace(resultEl, h('p', { class: 'notice bad' }, T(`リリースできませんでした: ${err.message}`, `Release failed: ${err.message}`)));
    }
    state.busy = false;
    renderPart();
  });

  replace(root,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, T('リリース', 'Release')),
      h('p', { class: 'muted' }, T('データに版番号を付けます。メジャー版(v1.0.0, v2.0.0 …)だけが公開サイトで「固定バージョン」として選べるようになり、それ以外の版は Git の履歴として残ります。',
        'Give the data a version number. Only major versions (v1.0.0, v2.0.0 …) become fixed versions on the public site; the others are kept in the git history.')))),
    h('section', { class: 'card' },
      h('div', { class: 'card-body stack' },
        h('dl', { class: 'kv' },
          h('dt', null, T('現在の版', 'Current version')), h('dd', null, h('strong', null, current)),
          h('dt', null, T('これまでのタグ', 'Existing tags')), h('dd', null, tagsEl),
          h('dt', null, T('次の版', 'Next version')), h('dd', null, nextEl)),
        partEl,
        h('div', { class: 'field wide' }, h('label', { for: 'release-notes' }, T('変更点(CHANGELOG.md に記録されます)', 'Changes (recorded in CHANGELOG.md)')),
          Object.assign(notes, { id: 'release-notes' })),
        pending ? h('p', { class: 'notice warn' }, T('未コミットの変更があります。先にコミットしてください。', 'There are uncommitted changes. Commit them first.')) : null,
        errors ? h('p', { class: 'notice bad' }, T('データにエラーがあります。', 'The data has errors.')) : null,
        h('div', { class: 'row' }, button), resultEl)));
  renderPart();
  try {
    const tags = await backend.tags();
    tagsEl.textContent = tags.length ? tags.map((t) => t.name).join(', ') : T('まだありません', 'none yet');
  } catch (err) {
    tagsEl.textContent = T('取得できませんでした', 'could not be loaded');
  }
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

export function renderHelp(root, app) {
  const repo = app.config.repository;
  const docs = (name) => `https://github.com/${repo}/blob/${app.config.branch}/docs/${name}`;
  replace(root,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, T('使い方', 'Help')))),
    h('section', { class: 'card' }, h('div', { class: 'card-body prose' },
      h('h2', null, T('論文を1本登録する', 'Entering one publication')),
      h('ol', null,
        h('li', null, T('「データセット」で + EXP(実験)などを選びます。', 'Under “Datasets” choose + EXP (experiment) or another kind.')),
        h('li', null, T('DOI を入力して「書誌情報を取得」を押します。DOI がない文献は「DOI なし…」で仮の識別子を付け、書誌情報を手入力します。',
          'Type the DOI and press “Look up”. For a source without DOI use “No DOI …” and type the bibliographic data.')),
        h('li', null, T('施設・手法・ビーム・標的・検出器を記入します(自由記述で構いません)。', 'Fill in facility, method, beam, target and detector (free text).')),
        h('li', null, T('データ点を1行ずつ入力するか、表計算ソフトからまとめて貼り付けます。換算値と「確認」欄で入力ミスに気付けます。',
          'Enter the data points row by row or paste them from a spreadsheet. The converted value and the “Check” column help to spot typing errors.')),
        h('li', null, T('「未コミットの変更」で差分を確認し、説明を書いてコミットします。', 'Review the differences under “Uncommitted changes”, describe them and commit.'))),
      h('h2', null, T('覚えておくこと', 'Good to know')),
      h('ul', null,
        h('li', null, T('ID(MetaID / DataID)は自動で計算されます。値や不確かさを直しても ID は変わりません。元素・質量数・DOI・Key を変えると ID が変わり、以前の ID は「旧 ID」として記録されます。',
          'Identifiers (MetaID / DataID) are computed automatically. Correcting a value or uncertainty keeps the ID. Changing element, mass number, DOI or key changes it; the former ID is recorded.')),
        h('li', null, T('入力中の内容はこのブラウザに自動保存されます。コミットするまで他の人には見えません。', 'Your edits are saved in this browser automatically. Nobody else sees them before you commit.')),
        h('li', null, T('キュレーションデータ(CUR)は「元データ」に実験データの ID を指定します。「…」ボタンで選べます。', 'Curated data (CUR) list the IDs of the experimental data they come from; pick them with the “…” button.')),
        h('li', null, T('間違えても大丈夫です。すべての変更は Git に残り、いつでも前の状態に戻せます。', 'Mistakes are fine: every change is kept in git and can be undone.'))),
      h('p', null, h('a', { href: docs('admin-guide.ja.md'), target: '_blank', rel: 'noopener' }, T('詳しい手引き', 'Detailed guide (Japanese)')), ' · ',
        h('a', { href: docs('data-format.md'), target: '_blank', rel: 'noopener' }, T('データ形式', 'Data format')), ' · ',
        h('a', { href: docs('id-definition.md'), target: '_blank', rel: 'noopener' }, T('ID の定義', 'Definition of the identifiers'))))));
}

