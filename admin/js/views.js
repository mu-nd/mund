// Pages of the data entry tool other than the dataset editor.  Each page
// function fills `root` and may return a handle { flush?, destroy? } (see main.js).

import { h, replace, card, externalLink, pageHeading, segSwitch, rowClick } from '../../site/assets/js/core/dom.js';
import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import { CODES } from '../../site/assets/js/core/vocabulary.js';
import { MASTER_DIR, MASTER_FORMATS } from '../../site/assets/js/core/database.js';
import { canonicalText } from '../../site/assets/js/core/schema.js';
import { citeLabel, citeText } from '../../site/assets/js/core/cite.js';
import { T, getLang, statusLabel, problemText, sendText, confirmPublish, codeTitle } from './i18n.js';
import { jsonCard } from './monaco.js';
import { loadConfig } from '../../site/assets/js/pages/site.js';
import { nextVersion, releaseChanges } from './release.js';
import { savePanel, issueList } from './save.js';

function date(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(getLang(), { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------------------------------------------------------------------------
// list of datasets
// ---------------------------------------------------------------------------

/** params: unsaved=1 shows only the files with unsaved changes. */
export function renderDatasets(root, { workspace, navigate }, params) {
  const state = { query: '', code: '', unsaved: params.get('unsaved') === '1' };
  const listEl = h('div');
  const panel = savePanel(workspace, { onChange: () => renderList() });

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
        bibId: f.meta.bibId || '', facility: f.meta.facility || '',
      };
    });
  }

  function renderList() {
    const q = state.query.trim().toLowerCase();
    const all = rows();
    const shown = all.filter((r) => (!state.code || r.code === state.code) && (!state.unsaved || r.status !== 'unchanged')
      && (!q || [r.label, r.cite, r.bibId, r.path, r.facility, r.elements.join(' ')].join(' ').toLowerCase().includes(q)));
    panel.refresh();
    renderPills();
    listEl.className = shown.length ? 'table-wrap' : 'card-body muted';
    replace(listEl,
      shown.length ? h('table', { class: 'data' },
        h('thead', null, h('tr', null,
          h('th', null, T('種別', 'Kind')), h('th', null, T('文献', 'Reference')), h('th', { class: 'num' }, T('データの行', 'Data entries')),
          h('th', null, T('元素', 'Elements')), h('th', null, T('施設', 'Facility')), h('th', null, T('状態', 'Status')))),
        h('tbody', null, shown.map((r) => h('tr', { class: 'selectable', onclick: rowClick(() => navigate('edit', { path: r.path })) },
          h('td', { class: 'nowrap' }, h('i', { class: `ds-dot ${r.code}` }), ` ${r.code || '?'}`),
          h('td', null, h('a', { href: `#/edit?path=${encodeURIComponent(r.path)}` }, h('strong', null, r.label)),
            h('div', { class: 'small muted' }, r.cite !== r.label ? r.cite : r.bibId)),
          h('td', { class: 'num' }, String(r.count)),
          h('td', { class: 'small' }, r.elements.length > 12 ? `${r.elements.slice(0, 12).join(' ')} … (${r.elements.length})` : r.elements.join(' ')),
          h('td', { class: 'small' }, r.facility),
          h('td', { class: 'nowrap' },
            r.status !== 'unchanged' ? h('span', { class: `tag ${r.status}` }, statusLabel(r.status)) : null, ' ',
            r.outdated ? h('span', { class: 'tag bad' }, statusLabel('outdated')) : null, ' ',
            r.errors ? h('span', { class: 'tag bad' }, T(`エラー ${r.errors}`, `${r.errors} error(s)`)) : null, ' ',
            r.warnings ? h('span', { class: 'tag warn' }, T(`警告 ${r.warnings}`, `${r.warnings} warning(s)`)) : null)))))
        : state.unsaved ? T('保存していないデータセットはありません。', 'Every dataset is saved.')
          : all.length ? T('条件に合うデータセットがありません。', 'No dataset matches.')
            : T('まだデータセットがありません。「新規データセット」から登録してください。', 'No datasets yet. Start with “New dataset”.'));
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
    class: 'btn', type: 'button', title: codeTitle(d), onclick: () => navigate('edit', { new: d }),
  }, `+ ${d}`));

  replace(root,
    pageHeading(T('データセット', 'Datasets'),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, T('新規データセット:', 'New dataset:')), newButtons)),
    h('p', { class: 'muted' }, T('LT サブライブラリ(寿命・捕獲率)。1ファイルに1件のメタデータとそのデータ行を収めます。同じ論文でも測定条件が異なる場合はファイルを分けます。', 'LT sub-library (lifetimes, capture rates). Each file holds one metadata record and its data entries. Use separate files for different set-ups in the same publication.')),
    panel.el,
    card({ title: pills, controls: h('div', { style: { width: 'min(360px, 100%)' } }, search) }, listEl),
    h('p', { class: 'small muted' }, T('XR・ES・BR はデータ形式が確定していないため、まだ入力できません(docs/data-format.md 参照)。',
      'XR, ES and BR cannot be entered yet: their data format is not defined (see docs/data-format.md).')));
  renderList();
}

// ---------------------------------------------------------------------------
// master data
// ---------------------------------------------------------------------------

export function renderMaster(root, { workspace, toast }) {
  const facPath = `${MASTER_DIR}/facilities.json`;
  const facEl = h('div', { class: 'table-wrap' });  // the table, built again by renderFacilities
  const facStatus = h('span');
  const facIssues = h('div');
  const facAdd = h('div', { class: 'card-body row' },
    h('button', { class: 'btn', type: 'button', onclick: () => {
      facilities.facilities.push({ abbr: '', facility: '', detail: '' });
      stageFacilities(); renderFacilities();
      const inputs = facEl.querySelectorAll('tbody tr:last-child input');
      if (inputs[0]) inputs[0].focus();
    } }, T('+ 施設を追加', '+ Add facility')),
    facStatus);
  const facInputs = new Map();  // JSON pointer -> input of the table
  const rawEl = h('div');
  let facilities = null;        // the document the table shows
  let raw = null;               // { name, card } of the file being edited directly

  function facilityDoc() {
    try { return jsonfmt.parse(workspace.text(facPath)); } catch (err) { return { format: MASTER_FORMATS['facilities.json'], facilities: [] }; }
  }

  /** The state of facilities.json: its status and problems, and the save card. */
  function refreshFacilities() {
    const status = workspace.status(facPath);
    replace(facStatus, status !== 'unchanged' ? h('span', { class: `tag ${status}` }, statusLabel(status)) : null);
    const issues = workspace.issuesFor(facPath);
    replace(facIssues, issues.length ? issueList(issues, workspace.db, { onPick: pickFacility }) : null);
    panel.refresh();
  }

  function stageFacilities() {
    const rawFacilities = raw?.name === 'facilities.json';
    if (rawFacilities && raw.card.dirty()) {
      toast(T('facilities.json を「ファイルを直接編集」で編集中です。先に「反映」を押してください。',
        'You have edits to facilities.json under “Edit files directly”. Press “Apply” there first.'), 'bad');
      renderFacilities();
      return;
    }
    workspace.stage(facPath, canonicalText(facilities, workspace.schemas));
    if (rawFacilities) openRaw(raw.name);
    refreshFacilities();
  }

  /** Go to the input that a problem of facilities.json points at. */
  function pickFacility(issue) {
    for (let p = issue.pointer; p; p = p.slice(0, p.lastIndexOf('/'))) {
      if (facInputs.has(p)) { facInputs.get(p).focus(); return; }
    }
  }

  /** The table, built again only when a row is added or deleted: typing keeps the focus. */
  function renderFacilities() {
    facilities = facilityDoc();
    facInputs.clear();
    const used = new Map();
    for (const f of workspace.db.sortedFiles()) {
      if (f.meta.facility) used.set(f.meta.facility, (used.get(f.meta.facility) || 0) + 1);
    }
    const heads = { abbr: T('略称(データから参照される名前)', 'Short name (used in the data)'), facility: T('機関', 'Laboratory'), detail: T('正式名称', 'Full name') };
    const row = (fac, i) => {
      const count = h('td', { class: 'num' });
      const remove = h('button', {
        class: 'btn small ghost', type: 'button',
        onclick: () => { facilities.facilities.splice(i, 1); stageFacilities(); renderFacilities(); },
      }, '✕');
      const showUse = () => {
        const n = used.get(fac.abbr) || 0;
        count.textContent = String(n);
        remove.disabled = Boolean(n);
        remove.title = n ? T('使用中のため削除できません', 'In use: cannot be deleted') : T('削除', 'Delete');
      };
      const input = (key, placeholder) => {
        const el = h('input', { type: 'text', value: fac[key] || '', placeholder, 'aria-label': T(`${i + 1} 行目: ${heads[key]}`, `Row ${i + 1}: ${heads[key]}`) });
        el.addEventListener('input', () => {
          fac[key] = el.value.trim();
          if (key === 'abbr') showUse();
          stageFacilities();
        });
        facInputs.set(`/facilities/${i}/${key}`, el);
        return el;
      };
      const abbr = input('abbr', 'J-PARC (D1)');
      facInputs.set(`/facilities/${i}`, abbr);
      showUse();
      return h('tr', null, h('td', null, abbr), h('td', null, input('facility', 'J-PARC')),
        h('td', null, input('detail', 'J-PARC MLF MUSE D1')), count, h('td', null, remove));
    };
    replace(facEl,
      h('table', { class: 'data grid' },
        h('thead', null, h('tr', null, h('th', null, heads.abbr),
          h('th', null, heads.facility), h('th', null, heads.detail), h('th', { class: 'num' }, T('使用数', 'Used')), h('th', null, ''))),
        h('tbody', null, facilities.facilities.map(row))));
    refreshFacilities();
  }

  function closeRaw() {
    if (raw) raw.card.dispose();
    raw = null;
  }

  function openRaw(name) {
    if (raw && !raw.card.apply()) return;
    closeRaw();
    const path = `${MASTER_DIR}/${name}`;
    raw = {
      name,
      card: jsonCard({
        title: path, path, text: () => workspace.text(path) || '', schemas: workspace.schemas, toast,
        onApply: (obj) => { workspace.stage(path, canonicalText(obj, workspace.schemas)); renderFacilities(); },
      }),
    };
    replace(rawEl, raw.card.el);
  }

  /** Take over the file being edited directly; false when its text is not valid. */
  function flush() {
    return !raw || raw.card.apply();
  }

  const panel = savePanel(workspace, {
    prepare: flush,
    onChange: () => { renderFacilities(); if (raw) openRaw(raw.name); },
    // the problems of the facilities table are listed under the table
    listed: {
      path: () => facPath,
      where: (n) => T(`施設の表のエラー(${n} 件)は「施設」の表の下に表示されています(項目を押すとその欄に移ります)。`,
        `Those in the facilities table (${n}) are listed under the “Facilities” table (press one to go to its field).`),
    },
  });

  replace(root,
    pageHeading(T('マスタデータ', 'Master data')),
    h('p', { class: 'muted' }, T('データセットから参照される共通の表です。変更は「保存」を押すと記録されます。', 'Tables shared by all datasets. Changes are recorded when you press “Save”.')),
    panel.el,
    card({
      title: T('施設', 'Facilities'),
      controls: h('span', { class: 'small muted' }, T('実験データの「施設」欄の選択肢になります', 'These are the choices of the “Facility” field of experimental data')),
    }, facEl, facAdd, facIssues),
    card({
      title: T('ファイルを直接編集', 'Edit files directly'),
      controls: h('div', { class: 'row' }, Object.keys(MASTER_FORMATS).map((name) => h('button', { class: 'btn', type: 'button', onclick: () => openRaw(name) }, name))),
    },
      h('div', { class: 'card-body small muted' }, T('Huff 因子・定数・核種表は変換結果すべてに影響します。変更は慎重に行ってください。',
        'Huff factors, constants and the nuclide table affect every converted value. Change them with care.'))),
    rawEl);
  renderFacilities();
  return { flush, destroy: closeRaw };
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

export function renderHistory(root, { backend }, params) {
  const path = params.get('path') || '';
  const listEl = h('div', { class: 'card-body muted' }, T('読み込み中…', 'Loading …'));
  replace(root,
    pageHeading(T('履歴', 'History')),
    h('p', { class: 'muted' }, path ? [h('code', null, path), ' ', h('a', { href: '#/history' }, T('(すべての履歴)', '(all saves)'))]
      : T('データの保存の記録です(新しい順)。', 'The saves of the data, newest first.')),
    card({}, listEl));
  showHistory(listEl, backend, path);
}

async function showHistory(listEl, backend, path) {
  try {
    const entries = await backend.history(path || 'data', 50);
    replace(listEl, entries.length ? h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, T('日時', 'When')), h('th', null, T('誰が', 'Who')), h('th', null, T('内容', 'What')))),
      h('tbody', null, entries.map((e) => h('tr', null,
        h('td', { class: 'nowrap' }, date(e.date)),
        h('td', { class: 'nowrap' }, e.author),
        messageCell(e.message)))))
      : T('まだ履歴がありません。', 'No history yet.'));
    listEl.className = entries.length ? 'table-wrap' : 'card-body muted';
  } catch (err) {
    replace(listEl, T('履歴を取得できませんでした: ', 'The history could not be read: '), problemText(err));
  }
}

/**
 * The first line of a save's message as the tool writes it (Workspace.saveMessage, renderRelease,
 * the frozen files of a major version) in the language of the page; null for any other line.
 */
function subjectText(subject) {
  let m;
  if ((m = /^Update (\d+) files$/.exec(subject))) return T(`${m[1]} 個のファイルを更新`, subject);
  if ((m = /^Release (\S+)$/.exec(subject))) return T(`版 ${m[1]} を公開`, subject);
  if ((m = /^Freeze release (\S+)$/.exec(subject))) return T(`固定版 ${m[1]} のファイルを作成`, subject);
  const parts = subject.split('; ').map((part) => /^(Add|Update|Delete) (.+)$/.exec(part));
  if (!parts.every(Boolean)) return null;
  const verbs = { Add: '追加', Update: '更新', Delete: '削除' };
  return T(parts.map(([, verb, name]) => `${name} を${verbs[verb]}`).join('、'), subject);
}

/**
 * A save's message: its first line in bold, the researcher's description and the list of files
 * below.  A change made outside the tool is shown as such, without its message.
 */
function messageCell(message) {
  const [subject, ...rest] = message.split('\n');
  const title = subjectText(subject);
  if (title === null) return h('td', { class: 'muted' }, T('ツールの外で行われた変更', 'A change made outside the tool'));
  const body = rest.join('\n').trim().split('\n').map((line) => {
    const listed = /^- (.+)$/.exec(line);
    const text = listed && subjectText(listed[1]);
    return text ? `- ${text}` : line;
  }).join('\n');
  return h('td', null, h('strong', null, title), body ? h('div', { class: 'pre' }, body) : null);
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
      { value: 'patch', text: T('パッチ: 誤記の訂正など', 'Patch: corrections') },
      { value: 'minor', text: T('マイナー: データの追加', 'Minor: data added') },
      { value: 'major', text: T('メジャー: 固定版にする', 'Major: stable version') },
    ];
    replace(root,
      pageHeading(T('版を公開', 'Publish a version')),
      h('p', { class: 'muted' }, T('データに版番号を付けて公開します。メジャー版(v1.0.0, v2.0.0 …)だけが公開サイトで「固定版」として選べるようになり、それ以外の版は履歴として残ります。',
        'Give the data a version number. Only major versions (v1.0.0, v2.0.0 …) become stable versions on the public site; the others are kept in the history.')),
      card({},
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
              h('div', null, segSwitch(T('上げる桁', 'Part of the version number to raise'), parts, state.part, (part) => { state.part = part; draw(); })),
              h('div', { class: 'field wide' }, h('label', { for: 'release-notes' }, T('変更点(CHANGELOG.md に記録されます)', 'Changes (recorded in CHANGELOG.md)')), notes),
            ],
          pending ? h('p', { class: 'notice warn' }, T('保存していない変更があります。先に保存してください。', 'There are unsaved changes. Save them first.')) : null,
          errors ? h('p', { class: 'notice bad' }, T('データにエラーがあります。', 'The data has errors.')) : null,
          h('div', { class: 'row' }, button), state.result)));
  }

  /** Notice about a published version ({ name, frozen, sent, error } of the server; frozen: vN of a major version). */
  const published = (tag) => (tag.sent
    ? h('p', { class: 'notice good' }, T(`${tag.name} を公開しました。`, `Published ${tag.name}.`),
      tag.frozen ? T(` 固定版 ${tag.frozen} のファイルを作成して保存しました(今後は作り直されません)。数分後に公開サイトで選べるようになります。`,
        ` The files of the stable version ${tag.frozen} were made and saved (they are never rebuilt). It can be chosen on the public site within minutes.`) : '')
    : h('p', { class: 'notice warn' }, T(`${tag.name} を記録しました。`, `${tag.name} is recorded.`), ' ', sendText(tag)));

  async function finish(current) {
    if (!confirmPublish(`v${current}`, current)) return;
    state.busy = true;
    draw();
    try {
      state.result = published(await backend.tag(`v${current}`));
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
    if (!confirmPublish(`v${next.version}`)) return;
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
        state.result = published(await backend.tag(`v${next.version}`));
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
  const guides = h('p', { hidden: true });
  function showGuides({ repository, branch }) {
    if (!repository || !branch) return;
    const docs = (name) => `https://github.com/${repository}/blob/${branch}/docs/${name}`;
    replace(guides, externalLink(docs('admin-guide.ja.md'), T('詳しい手引き', 'Detailed guide (Japanese)')), ' · ',
      externalLink(docs('data-format.md'), T('データ形式', 'Data format')), ' · ',
      externalLink(docs('id-definition.md'), T('ID の定義', 'Definition of the identifiers')));
    guides.hidden = false;
  }
  if (backend.session.practice) loadConfig().then(showGuides).catch(() => {
    guides.textContent = T('手引きのリンクを読み込めませんでした。', 'The guide links could not be loaded.');
    guides.hidden = false;
  });
  else showGuides(backend.session);
  const code = (text) => h('code', null, text);
  replace(root,
    pageHeading(T('使い方', 'Help')),
    card({}, h('div', { class: 'card-body prose' },
      h('h2', null, T('毎日の使い方', 'Everyday use')),
      h('ol', null,
        h('li', null, T('ターミナルでデータのフォルダ(mund)に移り、', 'In a terminal, go to the folder of the data (mund) and run '), code('pixi run admin'),
          T(' を実行します。ブラウザでこのツールが開きます(終わるときはターミナルで Ctrl+C)。', '. The tool opens in the browser (Ctrl+C in the terminal stops it).')),
        h('li', null, T('「データセット」でファイルを開くか、+ EXP などで新しく作ります。', 'Open a file under “Datasets”, or start a new one with + EXP or another kind.')),
        h('li', null, T('DOI を入力して「書誌情報を取得」を押します(DOI: は自動で付きます。書誌情報は Crossref または DataCite から取得します)。DOI がない文献は NSR のキー番号(NSR:1987SU06)を、どちらもなければ「DOI なし…」で muND:名前 を付け、書誌情報を手入力します。',
          'Type the DOI and press “Look up” (DOI: is added; the bibliographic data come from Crossref or DataCite). For a source without DOI give its NSR keynumber (NSR:1987SU06); for one with neither, use “No DOI …” to name it muND:<name>; then type the bibliographic data.')),
        h('li', null, T('条件とデータの行を入力します。表計算ソフトから貼り付けることもできます。換算値と「確認」欄で入力ミスに気付けます。',
          'Fill in the conditions and the data entries; they can also be pasted from a spreadsheet. The converted value and the “Check” column help to spot typing errors.')),
        h('li', null, T('「保存」を押します。チェックを通ると、変更はこのコンピュータに記録され、続けて GitHub に送信されます。送信できなかった変更はこのコンピュータに残ります。「変更の説明」は任意です。',
          'Press “Save”. When the checks pass, the change is recorded on this computer and then sent to GitHub. A change that could not be sent stays on this computer. The description is optional.'))),
      h('h2', null, T('覚えておくこと', 'Good to know')),
      h('ul', null,
        h('li', null, T('入力した内容は、ファイルとして保持できるようになると、保存するまでこのブラウザに残ります。それには有効な文献 (bibId) とデータ種別が必要で、同じ文献・データ種別・Key のファイルがほかにあってはいけません。保持できないあいだは、編集画面の上にその理由が表示されます。ツールを終了して起動し直しても残りますが、このブラウザに保持できないときは画面上部に知らせが出ます。練習用のコピーでは、タブを閉じると消えます。ほかのブラウザからは見えないので、区切りのよいところで保存してください。',
          'What you type is kept in this browser until you save, once the file can be stored: it needs a valid source (bibId) and kind of data, and no other file may have the same source, kind of data and key. While it cannot be stored, the editor says why at the top. It stays when the tool is stopped and started again; if this browser cannot keep it, a notice at the top says so. In the practice copy it is gone when the tab is closed. Other browsers do not see it, so save at a good moment.')),
        h('li', null, T('保存していないファイルには「未保存」と表示されます。画面上部の「未保存」は、変更のあるファイル(マスタデータと削除したファイルを含む)の数です。押すと、そのうちのデータセットが一覧されます。',
          'Files not saved yet are marked “not saved”. The “not saved” badge at the top counts every changed file, master data and deleted files included; pressing it lists the datasets among them.')),
        h('li', null, T('「未送信」は、このコンピュータに記録したけれどまだ GitHub に届いていない保存の数です(オフラインのときなど)。「再送信」で送れます。送信先の GitHub が設定されていないときは、保存はこのコンピュータにだけ記録されます。',
          '“Not sent” counts saves recorded on this computer that have not reached GitHub yet (for example while offline). “Send again” sends them. When no GitHub copy is set up, saves are recorded on this computer only.')),
        h('li', null, T('「最新にする」で、ほかの人の変更を含む最新の状態にします。', '“Update” brings in the latest state, including other people’s changes.')),
        h('li', null, T('ID(MetaID と各行の datasetId)は自動で計算されます。値・不確かさ・コメントを直しても、行を並べ替えても ID は変わりません。保存済みの行の元素・質量数・Key(またはファイルの文献 bibId・Key)を変えると ID が変わり、「同じデータの訂正」か「別のデータ」かを選ぶよう求められます。訂正なら以前の ID が legacyIds に記録され、その行を元データに挙げているデータも新しい ID に付け替えられます。1つの保存済みの行から複数の行ができたときは選択は求められず、以前の行は削除されたものとして扱われ、参照は付け替えられません。',
          'Identifiers (the MetaID and the datasetId of each row) are computed automatically. Correcting a value, uncertainty or comment, or reordering rows, keeps them. Changing element, mass number or key of a saved row (or source (bibId) or key of the file) changes them, and you are asked whether it is a correction of the same data or different data. For a correction the former ID is recorded in legacyIds and data naming the row as original data are changed to the new ID. When several rows come from one saved row, no choice is offered: the saved row counts as deleted and no reference is re-pointed.')),
        h('li', null, T('キュレーションデータ(CUR)は「元データ」に実験データの datasetId を指定します。「…」ボタンで選べます。選んだときの元データの内容(entryHash: 核種と、物理量・値・単位・不確かさ)も記録され、後でそれが変わると行に「再確認が必要」が表示されます。それを押して値を確かめ、「確認しました」を押してください。',
          'Curated data (CUR) list the datasetIds of the experimental data they come from; pick them with the “…” button. The content of the original data at that moment (entryHash: the nuclide and the quantity, value, unit and uncertainties) is recorded; when it changes later, the row shows “Check again”. Press it, check the value, then press “Checked”.')),
        h('li', null, T('練習するときは ', 'To practise, start '), code('pixi run admin-practice'),
          T(' で起動します。練習用のコピーが使われ、本物のデータには何も届きません。', ': it works on a throw-away copy, and nothing reaches the real data.'))),
      h('h2', null, T('保存できないとき', 'When saving is refused')),
      h('ul', null,
        h('li', null, T('エラーがあると保存できません。「チェック結果」の項目を押すと、該当する欄があればその欄に移動します。施設の表の問題は「マスタデータ」ページの「施設」の表の下に表示されます。',
          'Errors must be fixed first. Click an item under “Checks” to go to its field, if it has one. Problems of the facilities table are listed under the “Facilities” table on the Master data page.')),
        h('li', null, T('ほかの人が同じファイルを先に変更していたときは、保存するときに両方の変更を合わせます。合わせられるのは、変更した行が重ならず、合わせた結果がファイルの決まった書式のままのときだけです。',
          'If someone else changed the same file first, Save combines both changes. This works only when the changes touch different lines and the combined file keeps its layout.')),
        h('li', null, T('変更を自動で合わせられなかったときは、「保存されるファイル」で差分を確認し、自分の変更を残すなら「自分の内容で上書き」、やめるなら「破棄」(開いているファイルは画面上部の「変更を破棄」)を押して、もう一度保存します。',
          'If the changes could not be combined automatically, check the changes under “Files to be saved”, press “Overwrite with mine” to keep yours or “Discard” to withdraw your edits. For the open file, use “Discard changes” at the top. Then save again.')),
        h('li', null, T('GitHub へのログインが必要と表示されたら、ターミナルで ', 'If GitHub needs a login, run '), code('pixi run login'),
          T(' を一度実行してから「再送信」を押します。', ' once in a terminal, then press “Send again”.'))),
      guides)));
}
