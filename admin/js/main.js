// Entry point of the data entry tool, served by its local server
// (`pixi run admin`, tools/mundlib/admin.py).
//
// Pages (location.hash):
//   #/datasets[?unsaved=1]  list of dataset files (only those not saved)
//   #/edit?path=...         edit a file        #/edit?new=EXP   start a new one
//   #/master                facilities and other master tables
//   #/history[?path=...]    who saved what, when
//   #/release               publish a version
//   #/extraction[?task=...] values extracted twice from a source, compared, approved (extraction-view.js)
//   #/help
//
// A page function fills its element and may return a handle:
//   flush()    store pending edits before the page is left; false keeps the page
//   destroy()  the page is left
// Pages receive the context `ctx` (backend, workspace, toast, dialog, navigate).

import { h, replace, clear } from '../../site/assets/js/core/dom.js';
import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import { CODES } from '../../site/assets/js/core/vocabulary.js';
import { isDataFilePath } from '../../site/assets/js/core/database.js';
import { T, getLang, setLang, problemText } from './i18n.js';
import { LocalBackend } from './backend.js';
import { Workspace } from './workspace.js';
import { openEditor } from './editor.js';
import { newDocument } from './document.js';
import { renderDatasets, renderMaster, renderHistory, renderRelease, renderHelp } from './views.js';
import { renderExtraction } from './extraction-view.js';

const root = document.getElementById('app');
const toastEl = document.getElementById('toasts');

let chromeEl = null;
let viewEl = null;
let view = null;            // handle of the page shown

const ctx = {
  backend: null,
  workspace: null,

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
    if (result.sent) ctx.toast(T('GitHub に送信しました', 'Sent to GitHub'));
    else ctx.toast(result.error ? problemText(result.error) : T('送信先の GitHub が設定されていません。', 'There is no GitHub copy to send to.'), 'bad');
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
      doc = jsonfmt.parse(text);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('the top level must be an object');
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
  extraction: (page, params) => renderExtraction(page, ctx, params),
  help: (page) => renderHelp(page, ctx),
};

/** Leave the page shown, storing its pending edits first.  False when it cannot be left. */
function leave() {
  if (!view) return true;
  if (view.flush && !view.flush()) return false;
  if (view.destroy) view.destroy();
  view = null;
  clear(viewEl);
  return true;
}

/** Show the page of the current address. */
function render() {
  const { name, params } = currentRoute();
  const page = h('div', { class: 'stack' });
  replace(viewEl, page);
  renderChrome();
  window.scrollTo(0, 0);
  view = (PAGES[name] || PAGES.datasets)(page, params) || null;
}

window.addEventListener('hashchange', (event) => {
  if (!ctx.workspace) return;
  if (!leave()) {
    history.replaceState(null, '', new URL(event.oldURL).hash);   // stay on the page
    return;
  }
  render();
});

window.addEventListener('beforeunload', (event) => {
  if (view && view.flush && !view.flush()) event.preventDefault();
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
  chromeEl = h('div');
  viewEl = h('main', { class: 'admin-main' });
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
      h('a', { class: 'brand', href: '#/datasets' }, h('strong', null, 'Muon Nuclear Data'), h('span', null, T('データ入力ツール', 'Data entry'))),
      h('nav', { class: 'site-nav', 'aria-label': T('ページ', 'Pages') },
        link('datasets', T('データセット', 'Datasets')),
        link('master', T('マスタデータ', 'Master data')),
        link('extraction', T('値の抽出', 'Extraction')),
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
      session.practice ? h('span', { class: 'tag warn' }, T('練習用', 'Practice')) : null,
      h('span', { class: 'small muted' }, [session.repository || T('(GitHub なし)', '(no GitHub)'), session.branch, session.user ? session.user.name : null]
        .filter(Boolean).join(' · ')),
      h('button', { class: 'btn small', type: 'button', title: T('GitHub の最新の状態にする', 'Bring in the latest state from GitHub'), onclick: reload }, T('再読み込み', 'Reload')),
      langButton())),
    session.practice ? h('div', { class: 'practice-bar' },
      T('練習用: 練習用のコピーで動いています。ここで保存した内容は本物のデータには届きません。',
        'Practice: this works on a throw-away copy. Nothing saved here reaches the real data.')) : null,
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
  return h('div', { class: 'notice bad storage-bar', role: 'alert' }, text);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function start() {
  const status = h('p', { class: 'muted', role: 'status' }, T('準備しています…', 'Starting …'));
  replace(root, h('main', { class: 'page' }, status));
  const backend = new LocalBackend();
  try {
    const { sync } = await backend.connect();
    const workspace = new Workspace(backend, draftStorage());
    await workspace.load((done, total) => { status.textContent = T(`ファイルを読み込み中 ${done} / ${total}`, `Loading files ${done} / ${total}`); });
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
}

function draftStorage() {
  try { return localStorage; } catch (err) { return null; }
}

start();
