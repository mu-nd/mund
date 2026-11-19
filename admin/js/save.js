// The 保存 (save) card: what is not saved yet, an optional description, and
// the button that saves every change at once (Workspace.save): the server
// checks the database, records the save and sends it to GitHub.

import { h, replace } from '../../site/assets/js/core/dom.js';
import { isDataFilePath } from '../../site/assets/js/core/database.js';
import { T, statusLabel, problemText, issueText } from './i18n.js';
import { renderDiff, diffLines, diffStats } from './diff.js';
import { ConflictError, InvalidError } from './backend.js';

/** Issues of the checks as a list; files of a sub-library link to their editor. */
export function issueList(issues, limit = 20) {
  return h('ul', { class: 'issue-list compact' }, issues.slice(0, limit).map((i) => h('li', null,
    isDataFilePath(i.file) ? h('a', { href: `#/edit?path=${encodeURIComponent(i.file)}` }, i.file.split('/').pop()) : i.file,
    ` ${i.pointer} — ${issueText(i)}`)));
}

/**
 * workspace     the Workspace
 * prepare()     called before saving (the editor stores what was typed); false: do not save
 * saved()       called after a successful save
 * changed()     called after a change was discarded or rebased here
 * own(path)     true for files whose changes the page itself discards (no 破棄 button here)
 * Returns { el, refresh, save }.
 */
export function savePanel({ workspace }, { prepare = () => true, saved = () => {}, changed = () => {}, own = () => false } = {}) {
  const description = h('textarea', {
    class: 'save-description', rows: 2, spellcheck: 'false',
    placeholder: T('変更の説明(任意): 何を、なぜ変えたか', 'Description (optional): what was changed and why'),
    'aria-label': T('変更の説明', 'Description of the change'),
  });
  const el = h('section', { class: 'card save-panel' });
  let busy = false;
  let result = null;          // notice about the last attempt

  function fileCard(c) {
    const before = workspace.baseline(c.path);
    const stats = diffStats(diffLines(before, c.content));
    return h('details', { class: 'change' },
      h('summary', null,
        h('span', { class: `tag ${c.status}` }, statusLabel(c.status)), ' ', h('code', null, c.path), ' ',
        h('span', { class: 'small muted' }, `+${stats.added} / −${stats.removed}`), ' ',
        c.outdated ? h('span', { class: 'tag bad' }, T('ほかの人が先に変更', 'changed by someone else')) : null,
        h('span', { class: 'spacer' }),
        isDataFilePath(c.path) && c.content !== null ? h('a', { class: 'btn small', href: `#/edit?path=${encodeURIComponent(c.path)}` }, T('開く', 'Open')) : null,
        c.outdated ? h('button', {
          class: 'btn small', type: 'button',
          title: T('差分は、ほかの人の変更を含む最新の内容との比較です。確認したうえで押すと、この内容で最新の内容を置き換えて保存できるようになります(「−」の行は、ほかの人が書いたものでも取り消されます)。',
            'The changes shown are relative to the latest content, including the other person’s change. After checking them, press to save this content over it (lines marked − are removed, even if someone else wrote them).'),
          onclick: (e) => { e.preventDefault(); workspace.rebase(c.path); render(); changed(); },
        }, T('最新版を基準にする', 'Rebase on latest')) : null,
        own(c.path) ? null : h('button', { class: 'btn small', type: 'button', onclick: (e) => {
          e.preventDefault();
          if (!confirm(T(`${c.path} の保存していない変更を破棄しますか?`, `Discard the unsaved change of ${c.path}?`))) return;
          workspace.discard(c.path);
          render();
          changed();
        } }, T('破棄', 'Discard'))),
      h('div', { class: 'card-body' }, renderDiff(before, c.content, 2)));
  }

  function render() {
    const changes = workspace.changes();
    const errors = workspace.issues().filter((i) => i.level === 'error');
    const outdated = changes.filter((c) => c.outdated);
    const button = h('button', {
      class: 'btn primary', type: 'button', onclick: save,
      disabled: busy || !changes.length || Boolean(errors.length) || Boolean(outdated.length),
    }, busy ? T('保存中…', 'Saving …') : T('保存', 'Save'));
    replace(el,
      h('div', { class: 'card-head' }, h('h2', null, T('保存', 'Save')),
        h('span', { class: 'small muted' }, changes.length
          ? T(`保存していない変更: ${changes.length} ファイル`, `Not saved yet: ${changes.length} file(s)`)
          : T('すべて保存済みです。', 'Everything is saved.'))),
      changes.length || result ? h('div', { class: 'card-body stack' },
        changes.length ? h('div', { class: 'save-row' }, description, button) : null,
        errors.length ? h('div', { class: 'notice bad' },
          h('strong', null, T(`エラーが ${errors.length} 件あるため保存できません。`, `${errors.length} error(s) must be fixed before saving.`)),
          issueList(errors)) : null,
        outdated.length ? h('p', { class: 'notice bad' }, T('ほかの人が先に変更したファイルがあります。下の一覧で差分(最新の内容との比較)を確認し、ファイルごとに「最新版を基準にする」か「破棄」を選んでから保存してください。',
          'Someone else changed some of these files first. Check their changes below (shown against the latest content) and choose “Rebase on latest” or “Discard” for each, then save.')) : null,
        changes.length ? h('details', { open: outdated.length > 0 },
          h('summary', null, T('保存されるファイル', 'Files to be saved')),
          h('div', { class: 'stack' }, changes.map(fileCard))) : null,
        result) : null);
  }

  async function save() {
    if (busy) return;
    if (!prepare()) { render(); return; }
    const changes = workspace.changes();
    if (!changes.length || changes.some((c) => c.outdated) || workspace.issues().some((i) => i.level === 'error')) {
      render();
      return;
    }
    busy = true;
    result = null;
    render();
    try {
      const r = await workspace.save(workspace.saveMessage(description.value));
      description.value = '';
      result = r.sent
        ? h('p', { class: 'notice good' }, T('保存し、GitHub に送信しました。', 'Saved and sent to GitHub.'))
        : h('p', { class: 'notice warn' }, T('保存しました(このコンピュータ)。まだ送信していません: ', 'Saved on this computer, not sent yet: '),
          r.error ? problemText(r.error) : T('送信先の GitHub が設定されていません。', 'there is no GitHub copy to send to.'));
      busy = false;
      saved(r);
    } catch (err) {
      busy = false;
      if (err instanceof ConflictError) {
        result = h('p', { class: 'notice bad' },
          T('ほかの人が先に変更したため、保存しませんでした: ', 'Nothing was saved: someone else changed these files first: '), err.paths.join(', '));
      } else if (err instanceof InvalidError) {
        result = h('div', { class: 'notice bad' },
          h('strong', null, T('このまま保存するとデータにエラーが生じるため、保存しませんでした。', 'Nothing was saved: the data would have errors.')),
          issueList(err.issues));
      } else {
        result = h('p', { class: 'notice bad' }, T('保存できませんでした: ', 'Could not save: '), problemText(err));
      }
    }
    render();
  }

  render();
  return { el, refresh: render, save };
}
