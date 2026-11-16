// Entry point of the admin UI (data entry tool).
//
// Pages (location.hash):
//   #/datasets            list of dataset files
//   #/edit?path=...       edit a file        #/edit?new=EXP   start a new one
//   #/master              facilities and other master tables
//   #/changes             review and commit
//   #/history[?path=...]  who changed what, when
//   #/release             version numbers
//   #/help

import { h, replace, fetchJson } from '../core/dom.js';
import * as jsonfmt from '../core/jsonfmt.js';
import { DATASETS } from '../core/checks.js';
import { T, getLang, setLang } from './i18n.js';
import { GitHubBackend, DemoBackend } from './backend.js';
import { Workspace } from './workspace.js';
import { openEditor, newDataset } from './editor.js';
import { renderDatasets, renderMaster, renderChanges, renderHistory, renderRelease, renderHelp } from './views.js';

const siteUrl = (path) => new URL(`../../../${path}`, import.meta.url).href;
const SETTINGS_KEY = 'mund-admin:connection';
const TOKEN_KEY = 'mund-admin:token';

const root = document.getElementById('app');
const toastEl = document.getElementById('toasts');

const app = {
  config: { repository: 'niikura-muon/mund', branch: 'main' },
  backend: null,
  workspace: null,
  editor: null,
  cleanup: null,
  banner: null,
  viewEl: null,
  chromeEl: null,
  hash: '',

  toast(message, kind = 'good') {
    const el = h('div', { class: `toast ${kind}` }, message);
    toastEl.appendChild(el);
    setTimeout(() => el.remove(), kind === 'bad' ? 9000 : 4500);
  },

  dialog({ title, body, confirm: confirmLabel, onConfirm }) {
    const dialog = h('dialog', { class: 'modal' });
    const close = () => { dialog.close(); dialog.remove(); };
    replace(dialog,
      h('div', { class: 'modal-head' }, h('h2', null, title),
        h('button', { class: 'btn small ghost', type: 'button', 'aria-label': T('閉じる', 'Close'), onclick: close }, '✕')),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn', type: 'button', onclick: close }, T('キャンセル', 'Cancel')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => { onConfirm(); close(); } }, confirmLabel)));
    dialog.addEventListener('cancel', () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
    return dialog;
  },

  navigate(view, params = {}) {
    const query = new URLSearchParams(params).toString();
    location.hash = `#/${view}${query ? `?${query}` : ''}`;
  },

  /** The editor moved its file: keep the address in step without redrawing. */
  setEditorPath(path) {
    const target = `#/edit?path=${encodeURIComponent(path)}`;
    if (location.hash !== target) {
      history.replaceState(null, '', target);
      app.hash = target;
    }
  },

  refreshChrome() { renderChrome(); },
  render() { renderView(true); },

  async reload() {
    try {
      await app.workspace.load();
      app.toast(T('最新の状態を読み込みました', 'Loaded the latest state'));
    } catch (err) {
      app.toast(T(`読み込めませんでした: ${err.message}`, `Could not load: ${err.message}`), 'bad');
    }
    renderView(true);
  },

  afterCommit(result) {
    const pr = result.pullRequest;
    app.banner = h('p', { class: 'notice good' },
      pr ? T(`Pull Request #${pr.number} を作成しました。マージされると反映されます。`, `Pull request #${pr.number} created. The change is published when it is merged.`)
        : T('コミットしました。', 'Committed.'), ' ',
      (pr ? pr.url : result.url) ? h('a', { href: pr ? pr.url : result.url, target: '_blank', rel: 'noopener' }, T('GitHub で見る', 'View on GitHub'))
        : h('code', null, result.sha.slice(0, 7)));
    app.navigate('datasets');
    renderView(true);
  },
};

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

function savedSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (err) { return {}; }
}

function savedToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ''; } catch (err) { return ''; }
}

function forgetToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch (err) { /* ignore */ }
}

async function connect(backend, statusEl) {
  const say = (text) => { if (statusEl) statusEl.textContent = text; };
  say(T('接続しています…', 'Connecting …'));
  await backend.connect();
  const workspace = new Workspace(backend, localStorage);
  await workspace.load((done, total) => say(T(`ファイルを読み込み中 ${done} / ${total}`, `Loading files ${done} / ${total}`)));
  app.backend = backend;
  app.workspace = workspace;
  workspace.onChange(renderChrome);
  if (!location.hash || location.hash === '#/') history.replaceState(null, '', '#/datasets');
  renderShell();
}

function renderConnect(error) {
  const settings = savedSettings();
  const repo = h('input', { type: 'text', value: settings.repository || app.config.repository, spellcheck: 'false', autocomplete: 'off' });
  const branch = h('input', { type: 'text', value: settings.branch || app.config.branch, spellcheck: 'false', autocomplete: 'off' });
  const token = h('input', { type: 'password', autocomplete: 'off', placeholder: 'github_pat_…' });
  const remember = h('input', { type: 'checkbox' });
  const status = h('p', { class: 'small', role: 'status' }, error || '');
  const go = h('button', { class: 'btn primary', type: 'submit' }, T('接続', 'Connect'));

  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const backend = new GitHubBackend({ repository: repo.value.trim(), branch: branch.value.trim() || 'main', token: token.value.trim() });
    go.disabled = true;
    try {
      await connect(backend, status);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ mode: 'github', repository: backend.repository, branch: backend.branch }));
      forgetToken();
      if (backend.token) (remember.checked ? localStorage : sessionStorage).setItem(TOKEN_KEY, backend.token);
    } catch (err) {
      go.disabled = false;
      status.textContent = connectError(err);
      status.className = 'small notice bad';
    }
  } },
  h('div', { class: 'form-cols' },
    h('div', { class: 'field' }, h('label', { for: 'c-repo' }, T('リポジトリ', 'Repository')), Object.assign(repo, { id: 'c-repo' })),
    h('div', { class: 'field' }, h('label', { for: 'c-branch' }, T('ブランチ', 'Branch')), Object.assign(branch, { id: 'c-branch' }))),
  h('div', { class: 'field wide' }, h('label', { for: 'c-token' }, T('GitHub アクセストークン', 'GitHub access token')), Object.assign(token, { id: 'c-token' }),
    h('p', { class: 'hint' }, T('トークンはこのブラウザから GitHub (api.github.com) にだけ送られ、他のどこにも送信・保存されません。',
      'The token is sent from this browser to GitHub (api.github.com) only; it is not sent or stored anywhere else.'))),
  h('label', { class: 'check' }, remember, T(' この端末にトークンを保存する(共用の端末では使わないでください)', ' Remember the token on this device (not on shared computers)')),
  h('div', { class: 'row' }, go, status));

  const demo = h('button', { class: 'btn', type: 'button', onclick: async () => {
    demo.disabled = true;
    try {
      await connect(new DemoBackend({ siteUrl }), demoStatus);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ mode: 'demo' }));
    } catch (err) {
      demo.disabled = false;
      demoStatus.textContent = T(`開始できませんでした: ${err.message}`, `Could not start: ${err.message}`);
    }
  } }, T('練習モードを始める', 'Start practice mode'));
  const demoStatus = h('span', { class: 'small muted', role: 'status' });

  replace(root,
    h('header', { class: 'site-header' }, h('div', { class: 'bar' },
      h('a', { class: 'brand', href: siteUrl('') }, h('strong', null, 'μND'), h('span', null, T('データ入力ツール', 'Data entry'))),
      h('span', { class: 'spacer' }), langButton())),
    h('main', { class: 'page connect' },
      h('h1', null, T('μND データ入力ツール', 'μND data entry')),
      h('p', { class: 'muted' }, T('ミューオン核データベースの内容を追加・修正するためのツールです。変更は GitHub のリポジトリにコミットとして記録され、誰がいつ何を変えたかが残ります。',
        'Add to and correct the muon nuclear data base. Changes are recorded as commits in the GitHub repository, with who changed what and when.')),
      h('div', { class: 'connect-grid' },
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, T('GitHub に接続', 'Connect to GitHub'))),
          h('div', { class: 'card-body' }, form,
            h('details', { class: 'small' }, h('summary', null, T('トークンの作り方', 'How to create a token')),
              h('ol', null,
                h('li', null, 'GitHub → Settings → Developer settings → Personal access tokens → ', h('strong', null, 'Fine-grained tokens'), ' → Generate new token'),
                h('li', null, T('Repository access: 「Only select repositories」でこのリポジトリだけを選ぶ', 'Repository access: “Only select repositories”, choose this repository only')),
                h('li', null, T('Permissions: Contents = Read and write、Pull requests = Read and write(Pull Request を使う場合)', 'Permissions: Contents = Read and write, Pull requests = Read and write (if you use pull requests)')),
                h('li', null, T('有効期限を設定し、生成されたトークンを上の欄に貼り付ける', 'Set an expiry date and paste the generated token above'))),
              h('p', null, T('公開リポジトリの閲覧だけならトークンなしでも接続できます(書き込みはできません)。', 'A public repository can be opened without a token (read only).'))))),
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, T('練習モード', 'Practice mode'))),
          h('div', { class: 'card-body stack' },
            h('p', null, T('公開中のデータのコピーを使って、入力からコミットまでの操作を自由に試せます。変更はこのブラウザの中だけに保存され、GitHub には一切送られません。',
              'Try everything, from data entry to commit, on a copy of the published data. Changes stay in this browser and are never sent to GitHub.')),
            h('div', { class: 'row' }, demo, demoStatus))))));
}

function connectError(err) {
  if (err.status === 401) return T('トークンが正しくないか、期限が切れています。', 'The token is wrong or has expired.');
  if (err.status === 404) return T('リポジトリまたはブランチが見つかりません。非公開リポジトリの場合は、そのリポジトリを読めるトークンが必要です。',
    'Repository or branch not found. A private repository needs a token that may read it.');
  if (err.status === 403) return T(`アクセスが拒否されました: ${err.message}`, `Access denied: ${err.message}`);
  return T(`接続できませんでした: ${err.message}`, `Could not connect: ${err.message}`);
}

function disconnect() {
  if (app.workspace && app.workspace.changes().length
    && !confirm(T('未コミットの変更はこのブラウザに残ります。接続を切りますか?', 'Uncommitted changes stay in this browser. Disconnect?'))) return;
  forgetToken();
  try { localStorage.removeItem(SETTINGS_KEY); } catch (err) { /* ignore */ }
  location.hash = '';
  location.reload();
}

function langButton() {
  return h('button', { class: 'btn small ghost', type: 'button', onclick: () => {
    setLang(getLang() === 'ja' ? 'en' : 'ja');
    if (app.workspace) renderShell(); else renderConnect();
  } }, getLang() === 'ja' ? 'English' : '日本語');
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

function renderShell() {
  app.chromeEl = h('div');
  app.viewEl = h('main', { class: 'admin-main' });
  replace(root, app.chromeEl, app.viewEl);
  renderChrome();
  renderView(true);
}

function currentRoute() {
  const m = /^#\/([a-z]+)(?:\?(.*))?$/.exec(location.hash);
  return { view: m ? m[1] : 'datasets', params: new URLSearchParams(m && m[2] ? m[2] : '') };
}

function renderChrome() {
  if (!app.chromeEl) return;
  const { workspace, backend } = app;
  const info = backend.info || {};
  const { view } = currentRoute();
  const changes = workspace.changes().length;
  const errors = workspace.issues().filter((i) => i.level === 'error').length;
  const link = (key, label, extra) => h('a', { href: `#/${key}`, 'aria-current': view === key || (key === 'datasets' && view === 'edit') ? 'page' : null }, label, extra || null);
  replace(app.chromeEl,
    h('header', { class: 'site-header' }, h('div', { class: 'bar' },
      h('a', { class: 'brand', href: '#/datasets' }, h('strong', null, 'μND'), h('span', null, T('データ入力ツール', 'Data entry'))),
      h('nav', { class: 'site-nav', 'aria-label': T('ページ', 'Pages') },
        link('datasets', T('データセット', 'Datasets')),
        link('master', T('マスタデータ', 'Master data')),
        link('changes', T('未コミットの変更', 'Uncommitted changes'), changes ? h('span', { class: 'badge' }, String(changes)) : null),
        link('history', T('履歴', 'History')),
        link('release', T('リリース', 'Release')),
        link('help', T('使い方', 'Help'))),
      h('span', { class: 'spacer' }),
      errors ? h('a', { class: 'tag bad', href: '#/changes' }, T(`エラー ${errors}`, `${errors} error(s)`)) : null,
      h('span', { class: `tag ${backend.kind === 'demo' ? 'warn' : ''}`, title: info.repo ? info.repo.name : '' },
        backend.kind === 'demo' ? T('練習モード', 'Practice mode') : `${backend.repository} @ ${backend.branch}`),
      info.user ? h('span', { class: 'small muted' }, info.user.login) : h('span', { class: 'tag warn' }, T('閲覧のみ', 'read only')),
      h('button', { class: 'btn small', type: 'button', title: T('リポジトリの最新状態を読み込む', 'Load the latest state of the repository'), onclick: () => app.reload() }, T('再読み込み', 'Reload')),
      langButton(),
      h('a', { class: 'btn small ghost', href: siteUrl('') }, T('公開サイト', 'Explorer')),
      h('button', { class: 'btn small ghost', type: 'button', onclick: disconnect }, T('切断', 'Disconnect')))),
    backend.kind === 'demo' ? h('div', { class: 'demo-bar' },
      T('練習モード: ここでの変更は GitHub に送られません。', 'Practice mode: nothing you do here is sent to GitHub.'), ' ',
      h('button', { class: 'btn small', type: 'button', onclick: () => {
        if (!confirm(T('練習用のデータを最初の状態に戻しますか?', 'Reset the practice data to its initial state?'))) return;
        backend.reset();
        app.workspace.discardAll();
        app.reload();
      } }, T('最初の状態に戻す', 'Reset'))) : null);
}

function renderView(force) {
  if (!app.viewEl) return;
  if (!force && location.hash === app.hash) return;
  // leave the editor only when its content could be stored
  if (app.editor && !app.editor.flush()) {
    history.replaceState(null, '', app.hash);
    return;
  }
  if (app.editor) { app.editor.destroy(); app.editor = null; }
  if (app.cleanup) { app.cleanup(); app.cleanup = null; }
  app.hash = location.hash;
  const { view, params } = currentRoute();
  const page = h('div', { class: 'stack' });
  replace(app.viewEl, app.banner, page);
  app.banner = null;
  renderChrome();
  window.scrollTo(0, 0);
  const { workspace } = app;

  if (view === 'edit') {
    const path = params.get('path');
    const kind = params.get('new');
    if (path && workspace.text(path) !== null) {
      try {
        jsonfmt.parse(workspace.text(path));
        app.editor = openEditor(page, app, { path });
      } catch (err) {
        replace(page, h('p', { class: 'notice bad' }, T(`${path} は JSON として読めません: ${err.message}`, `${path} is not valid JSON: ${err.message}`)));
      }
    } else if (DATASETS.includes(kind)) {
      app.editor = openEditor(page, app, { doc: newDataset(kind) });
    } else {
      replace(page, h('p', { class: 'notice warn' }, T('ファイルが見つかりません。', 'File not found.'), ' ', h('a', { href: '#/datasets' }, T('一覧へ', 'Back to the list'))));
    }
  } else if (view === 'master') {
    app.cleanup = renderMaster(page, app) || null;
  } else if (view === 'changes') {
    renderChanges(page, app);
  } else if (view === 'history') {
    renderHistory(page, app, params);
  } else if (view === 'release') {
    renderRelease(page, app);
  } else if (view === 'help') {
    renderHelp(page, app);
  } else {
    renderDatasets(page, app);
  }
}

window.addEventListener('hashchange', () => { if (app.workspace) renderView(false); });
window.addEventListener('beforeunload', () => { if (app.editor) app.editor.flush(); });

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function start() {
  try { app.config = { ...app.config, ...(await fetchJson(siteUrl('config.json'))) }; } catch (err) { /* defaults */ }
  const settings = savedSettings();
  const token = savedToken();
  let backend = null;
  if (settings.mode === 'demo') backend = new DemoBackend({ siteUrl });
  else if (settings.mode === 'github' && token) backend = new GitHubBackend({ repository: settings.repository, branch: settings.branch, token });
  if (!backend) { renderConnect(); return; }
  replace(root, h('main', { class: 'page connect' }, h('p', { class: 'muted', id: 'boot-status', role: 'status' }, T('接続しています…', 'Connecting …'))));
  try {
    await connect(backend, document.getElementById('boot-status'));
  } catch (err) {
    renderConnect(connectError(err));
  }
}

start();
