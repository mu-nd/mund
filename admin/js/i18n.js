// Two-language user interface (Japanese / English).
// Texts are written where they are used:  T('保存', 'Save')

const KEY = 'mund-admin:lang';

function initial() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch (err) { /* ignore */ }
  return (navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

let lang = initial();

export const T = (ja, en) => (lang === 'ja' ? ja : en);
export const getLang = () => lang;

/** Label of a file's state in the workspace (see Workspace.status; 'new': a document without DOI yet). */
export const statusLabel = (status) => ({
  unchanged: T('保存済み', 'saved'),
  modified: T('未保存', 'not saved'),
  added: T('新規・未保存', 'new, not saved'),
  deleted: T('削除・未保存', 'deleted, not saved'),
  new: T('新規', 'new'),
}[status]);

/**
 * A sentence for a failure reported by the tool's server ({ code, message }):
 * of sending a save to GitHub (`during` 'send'), of bringing the copy up to
 * date ('sync'), or of a request.
 */
export function problemText(error, during = 'send') {
  switch (error.code) {
    case 'offline':
      return during === 'sync'
        ? T('GitHub に接続できないため、このコンピュータにある内容を表示しています。', 'GitHub cannot be reached; this shows the copy on this computer.')
        : T('GitHub に接続できません。保存した内容はこのコンピュータにあり、接続できるようになったら「再送信」で送れます。',
          'GitHub cannot be reached. What you saved is kept on this computer; send it with “Send again” once GitHub can be reached.');
    case 'auth':
      return T('GitHub へのログインが必要です。ターミナルで pixi run login を一度実行してから「再送信」を押してください。',
        'GitHub needs a login: run pixi run login once in a terminal, then press “Send again”.');
    case 'rejected':
      return T('ほかの人の変更と自動では合わせられなかったため、送信できませんでした。保存した内容はこのコンピュータにあります。データの管理者に連絡してください。',
        'Your saves could not be combined automatically with changes made by someone else, so they were not sent. They are kept on this computer; please contact the maintainer of the data.');
    case 'dirty':
      return T('このコンピュータでツールの外から変更されたファイルがあるため、最新の状態にできません。データの管理者に連絡してください。',
        'Files were changed on this computer outside the tool, so the copy cannot be brought up to date. Please contact the maintainer of the data.');
    case 'identity':
      return T('保存する人の名前が分かりません。ターミナルで pixi run login を一度実行してから、もう一度保存してください。',
        'The tool does not know who is saving. Run pixi run login once in a terminal, then save again.');
    case 'server':
      return T('ツールのサーバーが応答しません。ターミナルで pixi run admin を起動し直してください。',
        'The tool’s server does not answer. Start it again in a terminal with pixi run admin.');
    case 'forbidden':
      return T('このページは、ツールを起動したときに開いたアドレスで使ってください(ターミナルに表示されています)。',
        'Use the page at the address the tool opened when it started (it is shown in the terminal).');
    default:
      return error.message || String(error.code);
  }
}

// Japanese sentences for problems found by the checks, by code (issue.message is English).
const ID_RE = /[0-9a-f]{12}/g;
const ISSUE_TEXTS = {
  W_ORIGINAL_CHANGED: (m) => `再確認が必要: 元データ ${m.ids[0] || ''} は、この行の値を導いた後に変更されています。元データの現在の値でこの行を確かめ、「元データ」欄の「再確認が必要」から確認済みにしてください。`,
  W_ORIGINAL_LEGACY: (m) => `元データを以前の ID ${m.ids[0] || ''} で挙げています。現在の ID ${m.ids[1] || ''} に直してください(「元データ」欄の「現在の ID に直す」)。`,
  E_ORIGINAL_DUPLICATE: (m) => `同じ元データ ${m.ids[0] || ''} が2回挙げられています。1つにしてください。`,
  E_LEGACY_ID_CONFLICT: (m) => `legacyIds の ${m.first} は、${/current datasetId/.test(m.text) ? 'ほかの行の現在の ID' : 'ほかの行の legacyIds'} と同じです。1つの ID が指す行は1つだけにしてください。`,
};

/** The sentence shown for a problem found by the checks ({ code, message }). */
export function issueText(issue) {
  const text = ISSUE_TEXTS[issue.code];
  if (lang !== 'ja' || !text) return issue.message;
  const message = String(issue.message || '');
  return text({ text: message, ids: message.match(ID_RE) || [], first: message.split(' ')[0] });
}

export function setLang(value) {
  lang = value === 'ja' ? 'ja' : 'en';
  try { localStorage.setItem(KEY, lang); } catch (err) { /* ignore */ }
  document.documentElement.lang = lang;
}

document.documentElement.lang = lang;
