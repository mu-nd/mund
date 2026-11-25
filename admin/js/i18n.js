// Two-language user interface (Japanese / English).
// Texts are written where they are used:  T('保存', 'Save')
// The module also loads without a page (the tests).

import { isObject } from '../../site/assets/js/core/jsonfmt.js';
import { CODE_TITLES } from '../../site/assets/js/core/vocabulary.js';
import { OBSERVABLES } from '../../site/assets/js/core/convert.js';
import { entryLookup } from './document.js';

const KEY = 'mund-admin:lang';

function initial() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch (err) { /* ignore */ }
  return (globalThis.navigator?.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

let lang = initial();

export const T = (ja, en) => (lang === 'ja' ? ja : en);
export const getLang = () => lang;

/** The name of a kind of data (EXP, TH, CUR, EVAL). */
export const codeTitle = (code) => T({ EXP: '実験', TH: '理論', CUR: 'キュレーション', EVAL: '評価' }[code], CODE_TITLES[code]);

/** The name of a quantity (observable.kind). */
export const kindTitle = (kind) => T({ lifetime: '寿命', capture_rate: '捕獲率', capture_probability: '捕獲確率' }[kind], OBSERVABLES[kind].label);

/**
 * Label of a file's state in the workspace (see Workspace.status; 'new': a document
 * without a source yet; 'outdated': the saved file changed after the draft was made).
 */
export const statusLabel = (status) => ({
  unchanged: T('保存済み', 'saved'),
  modified: T('未保存', 'not saved'),
  added: T('新規・未保存', 'new, not saved'),
  deleted: T('削除・未保存', 'deleted, not saved'),
  new: T('新規', 'new'),
  outdated: T('ほかの人が先に変更', 'changed by someone else'),
}[status]);

/** Asks before the unsaved changes of the file `path` (none: the file shown) are discarded. */
export const confirmDiscard = (path = null) => confirm(path
  ? T(`${path} の保存していない変更を破棄しますか?`, `Discard the unsaved changes of ${path}?`)
  : T('このファイルの保存していない変更を破棄しますか?', 'Discard the unsaved changes of this file?'));

/** Asks before version `name` is published; `saved`: the version number whose saved state it publishes. */
export const confirmPublish = (name, saved = null) => confirm([
  saved ? T(`版番号を ${saved} にしたときに保存された状態を ${name} として公開します。`, `This publishes the state saved when the version number became ${saved} as ${name}.`)
    : T(`${name} を公開します。`, `This publishes ${name}.`),
  T('公開した版は後から変更できません。よろしいですか?', 'A published version cannot be changed afterwards. Go ahead?'),
].join(T('', ' ')));

/** The sentence for the outcome of sending saves to GitHub ({ sent, error } of the tool's server). */
export const sendText = ({ sent, error }) => (sent ? T('GitHub に送信しました。', 'Sent to GitHub.')
  : T('まだ送信していません: ', 'Not sent yet: ') + (error ? problemText(error) : T('送信先の GitHub が設定されていません。', 'There is no GitHub copy to send to.')));

/**
 * A sentence for a failure reported by the tool's server ({ code, message }):
 * of sending a save to GitHub (`during` 'send'), of bringing the copy up to
 * date ('sync'), or of a request.  The server's message itself is not shown:
 * a failure without a sentence of its own is named by its code.
 */
export function problemText(error, during = 'send') {
  switch (error.code) {
    case 'offline':
      return during === 'sync'
        ? T('GitHub に接続できないため、このコンピュータにある内容を表示しています。', 'GitHub cannot be reached; this shows the copy on this computer.')
        : T('GitHub に接続できません。保存した内容はこのコンピュータにあり、接続できるようになったら「再送信」で送れます。',
          'GitHub cannot be reached. What you saved is kept on this computer; send it with “Send again” once GitHub can be reached.');
    case 'permission':
      return T('GitHub にアクセスを拒否されました。データの管理者にアクセス権の確認を依頼してください。',
        'GitHub denied access. Ask the data maintainer to check your permissions.');
    case 'auth':
      return T('GitHub へのログインが必要です。ターミナルで pixi run login を一度実行してから「再送信」を押してください。',
        'GitHub needs a login: run pixi run login once in a terminal, then press “Send again”.');
    case 'rejected':
      return T('ほかの人の変更と自動では合わせられなかったため、送信できませんでした。保存した内容はこのコンピュータにあります。データの管理者に連絡してください。',
        'Your saves could not be combined automatically with changes made by someone else, so they were not sent. They are kept on this computer; please contact the maintainer of the data.');
    case 'dirty':
      return T('このコンピュータに、記録されていない変更のあるファイルがあります。データの管理者に連絡してください。',
        'Some files on this computer have changes that were not recorded. Please contact the maintainer of the data.');
    case 'identity':
      return T('保存する人の名前が分かりません。ターミナルで pixi run login を一度実行してから、もう一度保存してください。',
        'The tool does not know who is saving. Run pixi run login once in a terminal, then save again.');
    case 'commit':
      return T('記録できませんでした。保存していない変更はそのまま残っています。データの管理者に連絡してください。',
        'The save could not be recorded. Your unsaved changes are kept as they were. Please contact the maintainer of the data.');
    case 'bad-request':
      return T('ツールが要求を読み取れませんでした。入力内容を確認してください。',
        'The tool could not read the request. Check your input.');
    case 'internal':
      return T('ツールが処理を完了できませんでした。「最新にする」で保存状況を確認してから、もう一度試してください。',
        'The tool could not finish the request. Use “Update” to check what was saved before trying again.');
    case 'server':
      return T('ツールのサーバーが応答しません。ターミナルで pixi run admin を起動し直してください。',
        'The tool’s server does not answer. Start it again in a terminal with pixi run admin.');
    case 'forbidden':
      return T('このページは、ツールを起動したときに開いたアドレスで使ってください(ターミナルに表示されています)。',
        'Use the page at the address the tool opened when it started (it is shown in the terminal).');
    case 'invalid':
      return T('データまたは公開する版のファイルがチェックを通りませんでした。データの管理者に連絡してください。',
        'The data or the files of the version did not pass the checks. Please contact the maintainer of the data.');
    case 'not-found':
      return T('その版番号で保存された状態が見つかりません。データの管理者に連絡してください。',
        'No saved state has this version number. Please contact the maintainer of the data.');
    case 'tag-exists':
      return T('この版番号は、別の保存の状態ですでに公開されています。データの管理者に連絡してください。',
        'This version number is published already, from another saved state. Please contact the maintainer of the data.');
    default:
      return T('ツールが処理を完了できませんでした。データの管理者に連絡してください。', 'The tool could not finish this. Please contact the maintainer of the data.')
        + (error.code ? ` (${error.code})` : '');
  }
}

// Japanese sentences for problems found by the checks, by code (issue.message is English).
// Every code the checks report has one; it says what the English text shown (the message or
// EN_TEXTS) says.  `id` is the identifier at the issue's pointer: a
// datasetId, an originalData item's datasetId or a legacyIds member (null when there is
// none).  `current` is the datasetId it names in the database and `target` is that entry
// ({ path, index, code }); both are undefined when there is none.  `file` is the issue's
// file, `field` the member its pointer ends at, `bibId` the source of the file.  Values that the check computed (an expected
// identifier, a range, an example) are taken from the English message with `m(re)`, which
// returns the groups of `re` or null.  A sentence that lacks the values it needs is empty,
// and a general Japanese sentence with the English message is shown.
const TYPE_NAMES = { integer: '整数', number: '数値', string: '文字列', array: 'リスト', object: 'オブジェクト', boolean: 'true / false', null: 'null' };
const typeNames = (text) => text.replace(/'(\w+)'/g, (all, t) => TYPE_NAMES[t] || all).replace(/, /g, '・');

/** The Japanese sentence for a message of the schema check (the forms of core/schema.js and of the Python jsonschema). */
function schemaText(field, m) {
  // a member name is set off by a space, a Japanese name (この行, ファイル) is not
  const f = /^[\x21-\x7e]+$/.test(field) ? `${field} ` : field;
  let g;
  if ((g = m(/^'(.+)' is a required property$/s))) return `必須の項目 ${g[1]} がありません。`;
  if ((g = m(/^(.*) is not of type (.+)$/s))) return `${f}の ${g[1]} は${typeNames(g[2])}にしてください。`;
  if ((g = m(/^(.*) was expected$/s))) return `${f}は ${g[1]} にしてください。`;
  if ((g = m(/^(.*) is not one of the allowed values$/s))) return `${f}の ${g[1]} は使える値ではありません。`;
  if ((g = m(/^(.*) is not one of (.+)$/s))) return `${f}の ${g[1]} は使える値ではありません。使える値: ${g[2]}`;
  if (m(/^must not be empty$|should be non-empty$/)) return `${f}を空にしないでください。`;
  if ((g = m(/^(.*) is too short$|^has too few elements$/s))) return `${f}が短すぎます(要素が足りません)。`;
  if ((g = m(/^(.*) does not match '(.*)'$/s))) return `${f}の ${g[1]} は決められた書き方 '${g[2]}' に合っていません。`;
  if ((g = m(/^(.*) is less than or equal to the minimum of (.+)$|^(.*) must be greater than (.+)$/s))) {
    return `${f}は ${g[2] ?? g[4]} より大きくしてください(いまは ${g[1] ?? g[3]})。`;
  }
  if ((g = m(/^(.*) is less than the minimum of (.+)$/s))) return `${f}の ${g[1]} は最小値 ${g[2]} より小さくなっています。`;
  if ((g = m(/^(.*) is greater than the maximum of (.+)$/s))) return `${f}の ${g[1]} は最大値 ${g[2]} を超えています。`;
  if (m(/has non-unique elements$/)) return `${f}に同じものが2回以上入っています。`;
  if ((g = m(/^unknown properties: (.+)$|^Additional properties are not allowed \((.+) (?:was|were) unexpected\)$/s))) {
    return `${f}に使えない項目があります: ${g[1] ?? g[2]}。`;
  }
  if (m(/^this member is not allowed here$/)) return `${f}はここでは使えません。`;
  return '';
}

const ISSUE_TEXTS = {
  E_MASTER_MISSING: ({ file }) => `マスタデータの表 ${file} がありません。`,
  E_PATH: ({ file, m }) => {
    let g;
    if (m(/^not part of the database/)) return `${file} はデータベースのファイルではありません。ファイルは data/<サブライブラリ>/<データ種別>/ に置くか、data/master/ のマスタデータの表にしてください。`;
    if ((g = m(/^file must be stored in (\S+)$/))) return `このファイルは ${g[1]} に置いてください。`;
    if ((g = m(/^file name must be <label>_<MetaID>\.json, e\.g\. (\S+)$/))) return `ファイル名は <ラベル>_<MetaID>.json の形にしてください。例: ${g[1]}`;
    return '';
  },
  E_JSON: ({ m }) => {
    const g = m(/^not valid JSON: (.*)$/s);
    if (g) return `JSON として読めません: ${g[1]}`;
    return m(/^the top level must be an object$/) ? 'ファイルの最上位はオブジェクト({ … })にしてください。' : '';
  },
  E_SCHEMA: ({ field, m }) => schemaText(field, m),
  E_CANONICAL: () => 'ファイルが決められた書式になっていません。python3 tools/mund.py fix を実行してください。',
  E_FORMAT: ({ m }) => {
    let g;
    if ((g = m(/^expected '(.+)'$/))) return `format は '${g[1]}' にしてください。`;
    if ((g = m(/^(.+) is not a format of sub-library (\S+)$/))) return `format ${g[1]} はサブライブラリ ${g[2]} の形式ではありません。`;
    return '';
  },
  E_DUPLICATE_FACILITY: ({ m }) => { const g = m(/^'(.*)' is listed twice$/s); return g && `施設の略称 (abbr) '${g[1]}' が2回挙げられています。`; },
  E_DUPLICATE_REFERENCE: ({ m }) => { const g = m(/^'(.*)' is listed twice$/s); return g && `文献 (id) '${g[1]}' が2回挙げられています。`; },
  E_DUPLICATE_HUFF: ({ m }) => { const g = m(/^the Huff factor of (.+) is listed twice$/); return g && `${g[1]} の Huff 因子が2回挙げられています。`; },
  E_SUBLIBRARY_UNDEFINED: ({ m }) => { const g = m(/sub-library (\S+) is not defined$/); return g && `サブライブラリ ${g[1]} のデータ形式は定められていないため、ファイルを置けません。`; },
  E_META_ID: ({ m }) => { const g = m(/^MetaID should be (\S+) /); return g && `MetaID は、データ種別・文献 (bibId)・Key から決まる ${g[1]} にしてください。`; },
  E_DATA_ID: ({ m }) => { const g = m(/^datasetId should be (\S+) /); return g && `datasetId は、元素・質量数・Key から決まる ${g[1]} にしてください。`; },
  W_MASS_RANGE: ({ m }) => {
    const g = m(/^mass number (\S+) is unusual for (\S+) \(known range (\S+)\)$/);
    return g && `質量数 ${g[1]} は ${g[2]} としては珍しい値です(知られている範囲 ${g[3]})。`;
  },
  E_UNCERTAINTY_TOTAL: () => '全体の不確かさ (source が total) は1つだけにしてください。',
  E_FACILITY: ({ m }) => { const g = m(/^'(.*)' is not listed in (\S+)$/s); return g && `施設 '${g[1]}' は ${g[2]} にありません。一覧から選ぶか、マスタデータに追加してください。`; },
  E_DUPLICATE_META: ({ m }) => { const g = m(/^MetaID (\S+) is also used by (\S+)$/); return g && `MetaID ${g[1]} は ${g[2]} でも使われています。`; },
  E_ORIGINAL_SELF: () => '行は自分自身を元データにできません。',
  E_MASS_BELOW_Z: () => '質量数が原子番号より小さくなっています。',
  E_ELEMENT_ORDER: () => 'LT の元素記号を原子番号順に並べてください。',
  E_DUPLICATE_Z: () => '同じ原子番号が2回挙げられています。',
  E_UNKNOWN_Z: () => 'この原子番号は元素の一覧にありません。',
  E_DUPLICATE_ID: ({ id, target, file }) => target && `datasetId ${id} は${target.path === file ? '' : ` ${target.path} の`}行 ${target.index + 1} でも使われています。同じ核種の行には、それぞれ異なる Key を付けてください。`,
  E_ORIGINAL_MISSING: ({ id }) => id && `元データ ${id} は、このサブライブラリにありません。`,
  E_ORIGINAL_NOT_EXP: ({ id, target }) => target && `CUR の元データには EXP のデータを挙げてください。${id} は ${target.code} のデータです。`,
  W_NO_REFERENCE: ({ bibId }) => bibId && `${bibId} の書誌情報が文献データベース (bibliography.json) にありません。「文献」欄の「書誌情報を取得」を押すか、書誌情報を入力してください。`,
  W_ORIGINAL_CHANGED: ({ current }) => current && `再確認が必要: 元データ ${current} は、この行の値を導いた後に変更されています。元データの現在の値でこの行を確かめ、「元データ」欄の「再確認が必要」から確認済みにしてください。`,
  W_ORIGINAL_LEGACY: ({ id, current }) => current && `元データを以前の ID ${id} で挙げています。現在の ID ${current} に直してください(「元データ」欄の「現在の ID に直す」)。`,
  E_ORIGINAL_DUPLICATE: ({ id }) => id && `同じ元データ ${id} が2回挙げられています。`,
  E_LEGACY_ID_CONFLICT: ({ id, current }) => id && `legacyIds の ${id} は、${current === id ? 'ほかの行の現在の ID' : 'ほかの行の legacyIds'} と同じです。`,
};

// English sentences shown instead of the message of the check where the tool says what to do
// (the same values as ISSUE_TEXTS).
const EN_TEXTS = {
  E_FACILITY: ({ m }) => { const g = m(/^'(.*)' is not listed in (\S+)$/s); return g && `Facility '${g[1]}' is not in ${g[2]}. Choose one from the list, or add it under Master data.`; },
  W_NO_REFERENCE: ({ bibId }) => bibId && `No bibliographic data for ${bibId} in the bibliography (bibliography.json). Press “Look up” in the Reference card, or type the bibliographic data.`,
  W_ORIGINAL_CHANGED: ({ current }) => current && `Check again: the original data ${current} changed after the values of this row were derived from them. Check this row against their current values, then mark it as checked with “Check again” in the “Original data” column.`,
  W_ORIGINAL_LEGACY: ({ id, current }) => current && `The original data are listed by the earlier ID ${id}. Change it to the current ID ${current} (“Use the current ID” in the “Original data” column).`,
};

/** The identifier at the issue's pointer — /data/i/datasetId, /data/i/originalData/j (its datasetId) or /data/i/legacyIds/k — in its file of `db`. */
function idAt(issue, db) {
  const m = /^\/data\/(\d+)\/(datasetId|(?:originalData|legacyIds)\/\d+)$/.exec(issue.pointer);
  const file = m ? db.files.get(issue.file) : null;
  const value = file ? m[2].split('/').reduce((v, k) => (v !== null && typeof v === 'object' ? v[k] : undefined), file.data[m[1]]) : undefined;
  const id = isObject(value) ? value.datasetId : value;
  return typeof id === 'string' ? id : null;
}

/** The sentence shown for a problem found by the checks ({ code, file, pointer, message }) in the database `db`. */
export function issueText(issue, db) {
  const file = db.files.get(issue.file);
  const bibId = file && typeof file.meta.bibId === 'string' ? file.meta.bibId : null;
  const id = idAt(issue, db);
  const target = id === null ? null : entryLookup(db).resolve(id);
  const field = /^\/data\/\d+$/.test(issue.pointer) ? 'この行' : issue.pointer.split('/').filter((s) => s && !/^\d+$/.test(s)).pop() || 'ファイル';
  const m = (re) => re.exec(String(issue.message));
  const values = { id, current: target ? target.current : undefined, target: target || undefined, file: issue.file, field, bibId, m };
  if (lang !== 'ja') return (EN_TEXTS[issue.code] && EN_TEXTS[issue.code](values)) || issue.message;
  const text = ISSUE_TEXTS[issue.code];
  return (text && text(values)) || `チェックで問題が見つかりました (${issue.code}): ${issue.message}`;
}

/** Marks the page, if there is one, with the language. */
function markPage() {
  if (globalThis.document) document.documentElement.lang = lang;
}

export function setLang(value) {
  lang = value === 'ja' ? 'ja' : 'en';
  try { localStorage.setItem(KEY, lang); } catch (err) { /* ignore */ }
  markPage();
}

markPage();
