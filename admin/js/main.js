// Entry point of the data entry tool, served by its local server
// (`pixi run admin`, tools/mundlib/admin.py).
//
// Pages (location.hash):
//   #/datasets[?unsaved=1]  list of dataset files (only those not saved)
//   #/edit?path=...         edit a file        #/edit?new=EXP   start a new one
//   #/master                facilities and other master tables
//   #/history[?path=...]    who saved what, when
//   #/release               publish a version
//   #/help
//
// A page function fills its element and may return a handle:
//   flush()    store pending edits before the page is left; false keeps the page
//   destroy()  the page is left
// Pages receive the context `ctx` (backend, workspace, toast, dialog, navigate).

import { h, replace, headerShadow } from '../../site/assets/js/core/dom.js';
import { CODES } from '../../site/assets/js/core/vocabulary.js';
import { isDataFilePath } from '../../site/assets/js/core/database.js';
import { T, getLang, setLang, problemText, sendText } from './i18n.js';
import { LocalBackend } from './backend.js';
import { Workspace } from './workspace.js';
import { openEditor } from './editor.js';
import { parseObject } from './monaco.js';
import { newDocument } from './document.js';
import { renderDatasets, renderMaster, renderHistory, renderRelease, renderHelp } from './views.js';

const root = document.getElementById('app');
const toastEl = document.getElementById('toasts');

let chromeEl = null;
let viewEl = null;
let view = null;            // handle of the page shown
let dialogCount = 0;        // numbers the titles of dialogs (their ids)

const ctx = {
  backend: null,
  workspace: null,

  toast(message, kind = 'good') {
    const el = h('div', { class: `toast ${kind}` }, message);
    toastEl.appendChild(el);
    setTimeout(() => el.remove(), kind === 'bad' ? 9000 : 4500);
  },

  dialog({ title, body, confirm: confirmLabel, onConfirm }) {
    const titleId = `modal-title-${++dialogCount}`;
    const dialog = h('dialog', { class: 'modal', 'aria-labelledby': titleId });
    const close = () => { dialog.close(); dialog.remove(); };
    replace(dialog,
      h('div', { class: 'modal-head' }, h('h2', { id: titleId }, title),
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

  /** Show a page; `replace`: only change the address (the page shown already is that page). */
  navigate(name, params = {}, { replace: replaceAddress = false } = {}) {
    const query = new URLSearchParams(params).toString();
    const hash = `#/${name}${query ? `?${query}` : ''}`;
    if (replaceAddress) history.replaceState(null, '', hash);
    else if (location.hash !== hash) location.hash = hash;
    else if (leave()) render();
  },
};

// ---------------------------------------------------------------------------
// keeping in step with GitHub
// ---------------------------------------------------------------------------

/** Bring the copy up to date with GitHub, read the files again and show the current page again. */
async function reload() {
  if (!leave()) return;
  replace(viewEl, h('p', { class: 'muted' }, T('読み込み中…', 'Loading …')));
  try {
    const sync = await ctx.backend.sync();
    await ctx.workspace.load();
    if (sync.error) ctx.toast(problemText(sync.error, 'sync'), 'bad');
    else ctx.toast(sync.updated ? T('最新の状態にしました', 'Brought up to date') : T('すでに最新の状態です', 'Already up to date'));
  } catch (err) {
    ctx.toast(T('読み込めませんでした: ', 'Could not load: ') + problemText(err), 'bad');
  }
  render();
}

/** Send the saves that have not reached GitHub yet. */
async function sendAgain() {
  try {
    const result = await ctx.backend.send();
    ctx.toast(sendText(result), result.sent ? 'good' : 'bad');
  } catch (err) {
    ctx.toast(problemText(err), 'bad');
  }
  renderChrome();
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

function currentRoute() {
  const m = /^#\/([a-z]+)(?:\?(.*))?$/.exec(location.hash);
  return { name: m ? m[1] : 'datasets', params: new URLSearchParams(m && m[2] ? m[2] : '') };
}

function editPage(page, params) {
  const path = params.get('path');
  const code = params.get('new');
  const text = path && isDataFilePath(path) ? ctx.workspace.text(path) : null;
  if (text !== null) {
    let doc;
    try {
      doc = parseObject(text);
    } catch (err) {
      replace(page, h('p', { class: 'notice bad' }, T(`${path} は JSON として読めません: ${err.message}`, `${path} is not valid JSON: ${err.message}`)));
      return null;
    }
    return openEditor(page, ctx, { path, doc });
  }
  if (!path && CODES.includes(code)) return openEditor(page, ctx, { path: null, doc: newDocument(code) });
  replace(page, h('p', { class: 'notice warn' }, T('ファイルが見つかりません。', 'File not found.'), ' ', h('a', { href: '#/datasets' }, T('一覧へ', 'Back to the list'))));
  return null;
}

const PAGES = {
  datasets: (page, params) => renderDatasets(page, ctx, params),
  edit: editPage,
  master: (page) => renderMaster(page, ctx),
  history: (page, params) => renderHistory(page, ctx, params),
  release: (page) => renderRelease(page, ctx),
  help: (page) => renderHelp(page, ctx),
};

/** Leave the page shown, storing its pending edits first.  False when it cannot be left. */
function leave() {
  if (!view) return true;
  if (view.flush && !view.flush()) return false;
  if (view.destroy) view.destroy();
  view = null;
  replace(viewEl);
  return true;
}

/** Show the page of the current address. */
function render() {
  if (!ctx.workspace) return;      // handed over to another tab
  const { name, params } = currentRoute();
  const page = h('div', { class: 'stack' });
  replace(viewEl, page);
  renderChrome();
  window.scrollTo(0, 0);
  view = (PAGES[name] || PAGES.datasets)(page, params) || null;
}

headerShadow();

window.addEventListener('hashchange', (event) => {
  if (!ctx.workspace) return;
  if (!leave()) {
    history.replaceState(null, '', new URL(event.oldURL).hash);   // stay on the page
    return;
  }
  render();
});

window.addEventListener('beforeunload', (event) => {
  const kept = view && view.flush ? view.flush() : true;
  const inMemory = ctx.workspace && ['unavailable', 'write'].includes(ctx.workspace.storageProblem()) && ctx.workspace.changes().length;
  if (!kept || inMemory) event.preventDefault();
});

function langButton() {
  return h('button', { class: 'btn small ghost', type: 'button', onclick: () => {
    if (ctx.workspace && !leave()) return;
    setLang(getLang() === 'ja' ? 'en' : 'ja');
    if (ctx.workspace) renderShell(); else start();
  } }, getLang() === 'ja' ? 'English' : '日本語');
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

function renderShell() {
  chromeEl = h('div', { class: 'chrome' });
  viewEl = h('main', { class: 'page' });
  replace(root, chromeEl, viewEl);
  render();
}

function renderChrome() {
  if (!chromeEl) return;
  const { workspace, backend } = ctx;
  const session = backend.session;
  const { name } = currentRoute();
  const unsaved = workspace.changes().length;
  const errors = workspace.issues().filter((i) => i.level === 'error').length;
  const link = (key, label) => h('a', { href: `#/${key}`, 'aria-current': name === key || (key === 'datasets' && name === 'edit') ? 'page' : null }, label);
  replace(chromeEl,
    h('header', { class: 'site-header' }, h('div', { class: 'bar' },
      h('a', { class: 'brand', href: '#/datasets' }, 'Muon Nuclear Data', h('span', null, T('データ入力ツール', 'Data entry'))),
      h('nav', { class: 'site-nav', 'aria-label': T('ページ', 'Pages') },
        link('datasets', T('データセット', 'Datasets')),
        link('master', T('マスタデータ', 'Master data')),
        link('history', T('履歴', 'History')),
        link('release', T('版を公開', 'Publish')),
        link('help', T('使い方', 'Help'))),
      h('span', { class: 'spacer' }),
      unsaved ? h('a', { class: 'tag modified', href: '#/datasets?unsaved=1', title: T('保存していない変更の一覧', 'List of the changes not saved yet') },
        T(`未保存 ${unsaved}`, `${unsaved} not saved`)) : null,
      errors ? h('a', { class: 'tag bad', href: '#/datasets?unsaved=1' }, T(`エラー ${errors}`, `${errors} error(s)`)) : null,
      backend.pending ? h('span', { class: 'row' },
        h('span', { class: 'tag warn', title: backend.sendError ? problemText(backend.sendError) : T('保存したが、まだ GitHub に届いていない変更', 'Saves that have not reached GitHub yet') },
          T(`未送信 ${backend.pending}`, `${backend.pending} not sent`)),
        h('button', { class: 'btn small', type: 'button', onclick: sendAgain }, T('再送信', 'Send again'))) : null,
      session.user ? h('span', { class: 'small muted' }, session.user.name)
        : h('span', { class: 'tag warn', title: problemText({ code: 'identity' }) }, T('ログインが必要', 'Login needed')),
      h('button', { class: 'btn small', type: 'button', title: T('ほかの人の変更を GitHub から取り込みます', 'Bring in other people’s changes from GitHub'), onclick: reload }, T('最新にする', 'Update')),
      langButton())),
    session.practice ? h('div', { class: 'notice warn notice-bar' },
      T('練習用のコピーで動いています。「GitHub に送信」や版の公開も練習用の送信先で行われ、本物のデータや公開サイトには何も届きません。',
        'Practice copy: “Sent to GitHub” and publishing go to a practice stand-in; nothing reaches the real data or the public site.')) : null,
    storageNotice(workspace.storageProblem()));
}

/** Why the drafts are not kept in this browser (Workspace.storageProblem), or nothing. */
function storageNotice(problem) {
  if (!problem) return null;
  const text = {
    unavailable: T('このブラウザでは入力内容を保持できません(ブラウザの保存領域が使えません)。保存していない変更は、このページを閉じたり再読み込みしたりすると失われます。区切りごとに「保存」を押してください。',
      'This browser cannot keep what you type (its storage cannot be used). Changes not saved are lost when this page is closed or reloaded. Press “Save” at every good moment.'),
    write: T('入力内容をこのブラウザに保持できませんでした(保存領域がいっぱいか、使用が許可されていません)。保存していない変更は、このページを閉じたり再読み込みしたりすると失われます。すぐに「保存」を押してください。',
      'What you typed could not be kept in this browser (its storage is full or blocked). Changes not saved are lost when this page is closed or reloaded. Press “Save” now.'),
    read: T('このブラウザに保持していた入力内容を読み込めませんでした。前回保存していなかった変更は表示されていません。',
      'What this browser kept of your earlier work could not be read. Changes not saved last time are not shown.'),
  }[problem];
  return h('div', { class: 'notice bad notice-bar', role: 'alert' }, text);
}

// ---------------------------------------------------------------------------
// one tab
// ---------------------------------------------------------------------------
// The tool works in one tab at a time, the tab holding the lock OWNER: the
// drafts of two tabs would overwrite each other in the storage.  A new tab
// asks the owner on the channel OWNER to hand over and goes on once the lock
// is released, after the owner stored its edits and stopped writing drafts.

const OWNER = 'mund-admin';
let channel = null;
let release = null;      // gives up the lock this tab holds
let starting = false;    // a request to hand over waits until the start has ended
let asked = false;       // another tab asked for the tool

/** Hold the lock OWNER (at once when this browser has no Web Locks). */
async function own() {
  if (channel || !navigator.locks || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel(OWNER);
  channel.onmessage = (event) => {
    if (event.data === 'busy' && !release) {
      const status = root.querySelector('[role="status"]');
      if (status) status.textContent = T('別のタブに、まだ保持できない入力があります。そのタブで仕上げるか破棄して閉じると、ここで始まります。',
        'Another tab holds input that cannot be kept yet. Finish or discard it there and close that tab to start here.');
    }
    if (event.data !== 'open' || !release) return;
    if (asked) { channel.postMessage('busy'); return; }
    asked = true;
    if (!starting) handOver();
  };
  const request = (options) => new Promise((granted) => {
    navigator.locks.request(OWNER, options, (lock) => {
      granted(Boolean(lock));
      return lock ? new Promise((resolve) => { release = resolve; }) : null;
    });
  });
  if (!(await request({ ifAvailable: true }))) {
    channel.postMessage('open');
    await request({});
  }
}

/** Store the pending edits, stop keeping drafts and leave the tool to the tab that asked for it. */
function handOver() {
  if (view && view.flush && !view.flush()) {
    channel.postMessage('busy');
    ctx.toast(T('別のタブでツールが開かれました。このファイルを仕上げるか破棄してから、このタブを閉じてください。',
      'The tool was opened in another tab. Finish or discard this file, then close this tab.'), 'bad');
    return;
  }
  if (view && view.destroy) view.destroy();
  view = null;
  chromeEl = null;
  if (ctx.workspace) ctx.workspace.close();
  ctx.workspace = null;
  channel.close();
  release();
  replace(root, h('main', { class: 'page' }, h('p', { class: 'notice warn' },
    T('このツールは別のタブで開かれています。このタブは閉じてください。', 'The tool is open in another tab. Please close this tab.'))));
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function start() {
  starting = true;
  replace(root, h('main', { class: 'page' }, h('p', { class: 'muted', role: 'status' }, T('準備しています…', 'Starting …'))));
  await own();
  const backend = new LocalBackend();
  try {
    const { sync } = await backend.connect();
    const workspace = new Workspace(backend, draftStorage(backend.session));
    await workspace.load();
    ctx.backend = backend;
    ctx.workspace = workspace;
    workspace.onChange(renderChrome);
    if (!location.hash || location.hash === '#/') history.replaceState(null, '', '#/datasets');
    renderShell();
    if (sync.error) ctx.toast(problemText(sync.error, 'sync'), 'bad');
  } catch (err) {
    replace(root, h('main', { class: 'page' },
      h('h1', null, T('muND データ入力ツール', 'muND data entry')),
      h('p', { class: 'notice bad' }, T('開始できませんでした: ', 'Could not start: '), problemText(err)),
      h('p', { class: 'muted' }, T('このツールは、データのフォルダ(mund)でターミナルから pixi run admin を実行して使います。',
        'The tool is started with pixi run admin in a terminal, in the folder of the data (mund).')),
      h('div', { class: 'row' }, langButton())));
  }
  starting = false;
  if (asked) handOver();
}

/** Where the drafts are kept: for a practice copy (new at every start) only as long as the tab is open. */
function draftStorage(session) {
  try { return session.practice ? sessionStorage : localStorage; } catch (err) { return null; }
}

start();
