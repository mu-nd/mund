// The 保存 (save) card: what is not saved yet, an optional description, and
// the button that saves every change at once (Workspace.save): the server
// checks the database, records the save and sends it to GitHub.

import { h, replace, card } from '../../site/assets/js/core/dom.js';
import { isDataFilePath, MASTER_DIR } from '../../site/assets/js/core/database.js';
import { T, statusLabel, problemText, issueText, sendText, confirmDiscard } from './i18n.js';
import { renderDiff, diffLines, diffStats } from './diff.js';
import { ConflictError, InvalidError } from './backend.js';

/** Where in its file an issue is: the row (counted from 1) and field of a dataset or of the facilities table, or the members of the path. */
function issueWhere(pointer) {
  const m = /^\/(?:data|facilities)\/(\d+)(?:\/(.*))?/.exec(pointer);
  if (!m) return pointer.replace(/^\//, '').replace(/\//g, ' › ');
  return `${T('行', 'row')} ${Number(m[1]) + 1}${m[2] ? ` · ${m[2].split('/').filter((s) => !/^\d+$/.test(s)).slice(-2).join(' ')}` : ''}`;
}

/**
 * The issues of the checks of the database `db` as a list.  With onPick(issue)
 * the issues are those of the file the page edits and each is a button;
 * without, each names its file (a dataset links to its editor).
 */
export function issueList(issues, db, { onPick = null, limit = Infinity } = {}) {
  return h('ul', { class: 'issue-list' }, issues.slice(0, limit).map((issue) => {
    const where = issueWhere(issue.pointer);
    const href = isDataFilePath(issue.file) ? `#/edit?path=${encodeURIComponent(issue.file)}`
      : issue.file.startsWith(`${MASTER_DIR}/`) ? '#/master' : null;
    const text = [h('span', { class: 'issue-mark' }, issue.level === 'error' ? '✕' : '!'), ' ',
      onPick ? null : [href ? h('a', { href }, issue.file.split('/').pop()) : issue.file, ' '],
      where ? h('strong', null, `${where}: `) : null, issueText(issue, db)];
    return h('li', { class: issue.level },
      onPick ? h('button', { class: 'link', type: 'button', onclick: () => onPick(issue) }, text) : text,
      ' ', h('code', { class: 'muted small' }, issue.code));
  }));
}

/**
 * workspace     the Workspace
 * prepare()     called before saving (the editor stores what was typed); false: do not save
 * onChange()    called after a change was discarded or rebased here
 * onSaved()     called after a successful save (by default onChange)
 * onBusy(value) called when a save starts or ends
 * current()     the file the page edits, or null: its changes are shown open, its errors are
 *               only counted (the page's Checks list them), and the page discards them itself
 *               (no 破棄 button for it or the file it was renamed from)
 * listed        the file whose errors the page lists itself (by default current()) and
 *               where(n), the sentence that says where its n errors are listed
 * The card is hidden while there is nothing to save and nothing to say about the last save.
 * Returns { el, refresh }.
 */
const CHECKS_BELOW = (n) => T(`開いているファイルのエラー(${n} 件)は、画面下の「チェック結果」に表示されています(項目を押すとその欄に移ります)。`,
  `Those in this file (${n}) are listed under “Checks” at the bottom (press one to go to its field).`);

export function savePanel(workspace, {
  prepare = () => true, onChange = () => {}, onSaved = onChange, onBusy = () => {}, current = () => null,
  listed = { path: current, where: CHECKS_BELOW },
} = {}) {
  const description = h('textarea', {
    class: 'save-description', rows: 2, spellcheck: 'false',
    placeholder: T('変更の説明(任意): 何を、なぜ変えたか', 'Description (optional): what was changed and why'),
    'aria-label': T('変更の説明', 'Description of the change'),
  });
  const summary = h('span', { class: 'small muted' });
  const body = h('div', { class: 'card-body stack' });
  const el = card({ title: T('保存', 'Save'), controls: summary, class: 'save-panel' }, body);
  let busy = false;
  let result = null;          // notices about the last attempt
  const conflicts = new Set();   // files whose changes could not be combined
  const shown = new Map();    // key -> { by: the default open state, open: as the user left it }

  /** A <details> that stays as the user left it when the card is rendered again, until its default changes. */
  function details(key, open, attrs, ...content) {
    const kept = shown.get(key);
    return h('details', {
      ...attrs, open: kept && kept.by === open ? kept.open : open,
      ontoggle: (e) => shown.set(key, { by: open, open: e.currentTarget.open }),
    }, ...content);
  }

  function fileCard(c, own) {
    const before = workspace.baseline(c.path);
    const stats = diffStats(diffLines(before, c.content));
    return details(c.path, c.path === current(), { class: 'change' },
      h('summary', null,
        h('span', { class: `tag ${c.status}` }, statusLabel(c.status)), ' ', h('code', null, c.path), ' ',
        h('span', { class: 'small muted' }, `+${stats.added} / −${stats.removed}`), ' ',
        c.outdated ? h('span', { class: 'tag bad' }, statusLabel('outdated')) : null,
        h('span', { class: 'spacer' }),
        isDataFilePath(c.path) && c.content !== null ? h('a', { class: 'btn small', href: `#/edit?path=${encodeURIComponent(c.path)}` }, T('開く', 'Open')) : null,
        c.outdated && conflicts.has(c.path) ? h('button', {
          class: 'btn small', type: 'button',
          title: T('このファイルの変更を自動で合わせられません。押すと、ほかの人の変更をこの内容で置き換えて保存できるようになります(「−」の行は、ほかの人が書いたものでも取り消されます)。',
            'The changes to this file could not be combined automatically. Press to save this content over theirs (lines marked − are removed, even if someone else wrote them).'),
          onclick: (e) => { e.preventDefault(); conflicts.delete(c.path); workspace.rebase(c.path); render(); onChange(); },
        }, T('自分の内容で上書き', 'Overwrite with mine')) : null,
        own ? null : h('button', { class: 'btn small', type: 'button', onclick: (e) => {
          e.preventDefault();
          if (!confirmDiscard(c.path)) return;
          workspace.discard(c.path);
          render();
          onChange();
        } }, T('破棄', 'Discard'))),
      h('div', { class: 'card-body' }, renderDiff(before, c.content, 2),
        own && conflicts.has(c.path) ? h('p', null, T('このファイルの変更を取り消すには、画面上部の「変更を破棄」を押します。',
          'To discard edits to this file, press “Discard changes” at the top of the page.')) : null));
  }

  function render() {
    const changes = workspace.changes();
    const errors = workspace.issues().filter((i) => i.level === 'error');
    const here = listed.path();
    const inThisFile = here ? errors.filter((i) => i.file === here).length : 0;
    const elsewhere = errors.filter((i) => i.file !== here);
    const outdated = changes.filter((c) => c.outdated);
    for (const p of [...conflicts]) if (!outdated.some((c) => c.path === p)) conflicts.delete(p);
    const button = h('button', {
      class: 'btn primary', type: 'button', onclick: save,
      disabled: busy || !changes.length || Boolean(errors.length),
    },busy ? T('保存中…', 'Saving …') : T('保存', 'Save'));
    const mine = changes.find((c) => c.path === current());
    const own = (c) => c === mine || (mine !== undefined && mine.origin === c.path);
    el.hidden = !changes.length && !result;
    summary.textContent = changes.length ? T(`保存していない変更: ${changes.length} ファイル`, `Not saved yet: ${changes.length} file(s)`) : '';
    replace(body,
      changes.length ? h('div', { class: 'save-row' }, description, button) : null,
      errors.length ? h('div', { class: 'notice bad' },
        h('strong', null, T(`エラーが ${errors.length} 件あるため保存できません。`, `${errors.length} error(s) must be fixed before saving.`)),
        inThisFile ? [T('', ' '), listed.where(inThisFile)] : null,     // no space after 。
        elsewhere.length ? issueList(elsewhere, workspace.db, { limit: 20 }) : null) : null,
      outdated.length ? h('p', { class: 'notice warn' }, T('ほかの人も変更したファイルがあります。下の差分は最新の内容との比較なので、ほかの人の変更が「−」に見えます。保存時に両方の変更を合わせます。自動で合わせられないときは、保存せずにお知らせします。',
        'Someone else also changed some of these files. The changes below are shown against the latest content, so their changes look removed (−). The tool combines both sets of changes when you save. If it cannot combine them, it asks you to review them before saving.')) : null,
      changes.length ? details('', outdated.length > 0, null,
        h('summary', null, T('保存されるファイル', 'Files to be saved')),
        h('div', { class: 'stack' }, changes.map((c) => fileCard(c, own(c))))) : null,
      result);
  }

  async function save() {
    if (busy) return;
    if (!prepare()) { render(); return; }
    const changes = workspace.changes();
    if (!changes.length || workspace.issues().some((i) => i.level === 'error')) {
      render();
      return;
    }
    busy = true;
    onBusy(true);
    result = null;
    render();
    try {
      const r = await workspace.save(workspace.saveMessage(description.value));
      description.value = '';
      conflicts.clear();
      result = [h('p', { class: `notice ${r.sent ? 'good' : 'warn'}` }, T('保存しました。', 'Saved.'), T('', ' '), sendText(r)),
      r.reloadError ? h('p', { class: 'notice warn' },
        T('最新の内容を読み込めませんでした。「最新にする」を押してください。', 'The latest content could not be read. Press “Update”.')) : null];
      onSaved(r);
    } catch (err) {
      if (err instanceof ConflictError) {
        for (const p of err.paths) conflicts.add(p);
        result = h('p', { class: 'notice bad' },
          T('変更を自動で合わせられなかったため、保存しませんでした。', 'The changes could not be combined automatically. Nothing was saved.'), h('br'), err.paths.join(', '), h('br'),
          T('「保存されるファイル」で差分を確認し、自分の内容で上書きするか、変更を取り消すかを選んでください。', 'Review the differences under “Files to be saved” before overwriting the file or discarding your edits.'));
      } else if (err instanceof InvalidError) {
        result = h('div', { class: 'notice bad' },
          h('strong', null, T('このまま保存するとデータにエラーが生じるため、保存しませんでした。', 'Nothing was saved: the data would have errors.')),
          issueList(err.issues, workspace.db, { limit: 20 }));
      } else {
        result = h('p', { class: 'notice bad' }, T('保存できませんでした: ', 'Could not save: '), problemText(err));
      }
    } finally {
      busy = false;
      onBusy(false);
    }
    render();
  }

  render();
  return { el, refresh: render, busy: () => busy };
}
