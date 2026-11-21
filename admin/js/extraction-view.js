// The pages of the extraction work area (docs/extraction.ja.md):
//
//   #/extraction                        the tasks, and a new task
//   #/extraction?task=ID[&view=V]       one task; V = summary | A | B | compare | approve | json
//
// Two inputs of the same source are made independently and blind (each is shown
// only in its own view until both are submitted), then compared row by row,
// decided, approved, and registered in the data through the tool's server, which
// refuses anything not approved or changed after its approval.  The logic is in
// extraction.js; this module draws it.  Edits are stored as drafts of the
// workspace and saved with the 保存 card like every other file.

import { h, replace, nuclideNode } from '../../site/assets/js/core/dom.js';
import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import { CODES, TYPE_OF } from '../../site/assets/js/core/vocabulary.js';
import { bibKind } from '../../site/assets/js/core/cite.js';
import { UNIT_LABELS } from '../../site/assets/js/core/convert.js';
import { T, problemText } from './i18n.js';
import { jsonPane } from './monaco.js';
import { savePanel, issueList } from './save.js';
import { InvalidError } from './backend.js';
import * as ex from './extraction.js';
import { sourceText } from './document.js';
import { SOURCE_HINT } from './reference.js';

const STORE_DELAY_MS = 300;
const list = (v) => (Array.isArray(v) ? v : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Inputs whose content the person at this browser chose to see although someone else types them. */
const opened = new Set();
let aiInfo = null;            // GET /api/extraction/ai, once per page load

const KIND_LABELS = () => ({ lifetime: T('寿命', 'Lifetime'), capture_rate: T('捕獲率', 'Capture rate'), capture_probability: T('捕獲確率', 'Capture probability') });
const MODE_LABELS = () => ({ human: T('人が入力', 'typed by a person'), ai: T('AI が入力', 'written by AI'), assisted: T('AI の下書きを人が修正', 'AI draft corrected by a person') });
const COVERAGE_LABELS = () => ({ covered: T('値あり', 'has values'), 'no-data': T('該当なし', 'no relevant data'), 'needs-check': T('要確認', 'to be checked') });
const SOURCE_LABELS = () => ({ total: T('全体', 'total'), statistical: T('統計', 'statistical'), systematic: T('系統', 'systematic'), other: T('その他', 'other') });
const STAGE_LABELS = () => ({
  inputs: T('入力中', 'inputs being made'), compare: T('比較・判定中', 'comparing'), approved: T('承認済み', 'approved'),
  stale: T('再確認が必要', 're-check needed'), published: T('データに登録済み', 'in the data'),
});
const STAGE_TAGS = { inputs: 'warn', compare: 'warn', approved: 'good', stale: 'bad', published: 'good' };
const INDEPENDENCE_TEXTS = () => ({
  'both-ai': T('独立ではありません: 両方の入力に AI の出力が含まれています(AI の下書きを人が直した入力は、AI の出力から独立していません)。',
    'Not independent: both inputs contain AI output (an AI draft corrected by a person is not independent of AI output).'),
  'same-person': T('独立ではありません: 両方の入力を同じ人が作っています。', 'Not independent: the same person made both inputs.'),
});

// ---- small helpers ------------------------------------------------------------------

const userName = (ctx) => (ctx.backend.session && ctx.backend.session.user ? ctx.backend.session.user.name : '');
const short = (hash) => (typeof hash === 'string' ? hash.slice(0, 12) : '');
const unitLabel = (unit) => UNIT_LABELS[unit] || unit || '';

function numText(obj, key) {
  if (!isObject(obj)) return '';
  if (typeof obj[key] === 'number') return jsonfmt.numberText(obj, key);
  return obj[key] === undefined || obj[key] === null ? '' : String(obj[key]);
}

/** Store typed text as a number keeping its digits; other text is kept so that the checks report it. */
function setNum(obj, key, text) {
  const t = String(text).trim();
  if (t === '') delete obj[key];
  else if (!jsonfmt.setNumber(obj, key, t)) obj[key] = t;
}

function setText(obj, key, text) {
  const t = String(text).trim();
  if (t) obj[key] = t; else delete obj[key];
}

const uncText = (row, source) => numText(list(row.uncertainties).find((u) => u && u.source === source), 'value');

function setUnc(row, source, text) {
  row.uncertainties = list(row.uncertainties).filter((u) => u && u.source !== source);
  const t = String(text).trim();
  if (!t) return;
  const u = { source };
  setNum(u, 'value', t);
  row.uncertainties.push(u);
  row.uncertainties.sort((x, y) => ex.SOURCES.indexOf(x.source) - ex.SOURCES.indexOf(y.source));
}

function input(value, onInput, attrs = {}) {
  const el = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs });
  el.value = value === undefined || value === null ? '' : String(value);
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

function select(options, value, onChange, attrs = {}) {
  return h('select', { ...attrs, onchange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', null, label, control), hint ? h('p', { class: 'hint' }, hint) : null);
}

/** Base64 of a file chosen in the page. */
async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A sentence for a refusal of the tool's server on the work area. */
function workErrorText(err) {
  const detail = err && err.message ? ` (${err.message})` : '';
  const texts = {
    'not-approved': T('承認されていないため、データに登録できません。', 'Not approved: it cannot be registered in the data.'),
    'approval-stale': T('承認の後に内容が変わったため、データに登録できません。再確認して承認し直してください。', 'The content changed after its approval: check it and approve it again.'),
    'not-submitted': T('両方の入力が提出されていません。', 'Both inputs must be submitted first.'),
    'task-not-saved': T('タスクがまだ保存されていません。先に保存してください。', 'The task is not saved yet: save it first.'),
    'slot-taken': T('この入力はすでにあります。', 'This input exists already.'),
    'pdf-missing': T('PDF がこのコンピュータにありません。「概要」で PDF を選んでください。', 'The PDF is not on this computer: choose it under “Summary”.'),
    'pdf-mismatch': T('このコンピュータにある PDF は、タスクに記録された PDF と異なります(SHA-256 が違います)。', 'The PDF on this computer is not the one recorded in the task (SHA-256 differs).'),
    'ai-unavailable': T('AI による抽出は使えません。', 'AI extraction is not available.') + detail,
    'ai-failed': T('AI による抽出に失敗しました。', 'The AI run failed.') + detail,
    exists: T('登録先のファイルに、同じ核種・条件の行がすでにあります(このタスクから登録したものではありません)。', 'The data file already holds an entry of the same nuclide and conditions that was not registered from this task.') + detail,
    'changed-since-publication': T('このタスクから登録した行が、その後データセットの画面で変更されています。', 'An entry registered from this task was changed in the dataset editor afterwards.') + detail,
    'left-over': T('以前このタスクから登録した行が、承認された結果にありません。データセットの画面で先に削除してください。', 'Entries registered from this task before are not in the approved result: delete them in the dataset editor first.') + detail,
    duplicate: T('同じデータ行になる行が複数あります。条件ラベルで区別してください。', 'Several rows become the same data entry: tell them apart with the conditions label.') + detail,
    nothing: T('採用した行がありません。', 'No rows were adopted.'),
    'not-pdf': T('PDF ファイルではありません。', 'This is not a PDF file.'),
    'too-large': T('PDF が大きすぎます。', 'The PDF is too large.'),
    identity: T('登録する人の名前が分かりません。ターミナルで pixi run login を一度実行してください。', 'The tool does not know who is registering: run pixi run login once.'),
  };
  if (err instanceof InvalidError) return T('チェックで問題が見つかったため、保存しませんでした。', 'Nothing was saved: the checks found problems.');
  return texts[err.code] || problemText(err);
}

function diffLabel(d) {
  const parts = (names) => names.map((p) => ({ page: T('頁', 'page'), item: T('表・図', 'table/figure'), label: T('行・ラベル', 'row/label'),
    value: T('値', 'value'), unit: T('単位', 'unit'), uncertainty: T('不確かさ', 'uncertainty') }[p] || p)).join('・');
  const quantity = (status) => ({
    unit: T('単位のみの違い(換算後は一致)', 'unit only (equal after conversion)'),
    notation: T('表記のみの違い(換算後も桁も一致)', 'notation only (equal value and digits)'),
    digits: T('桁数の違い(換算後の値は一致)', 'number of digits (equal value)'),
    value: T('値の違い', 'different values'),
    missing: T('片方にない', 'missing on one side'),
  }[status] || status);
  switch (d.field) {
    case 'location': return [T(`位置の違い: ${parts(d.parts)}`, `location differs: ${parts(d.parts)}`), 'warn'];
    case 'original': return [T(`原表記の違い: ${parts(d.parts)}`, `notation as printed differs: ${parts(d.parts)}`), 'warn'];
    case 'value': return [quantity(d.status), d.status === 'value' || d.status === 'missing' ? 'bad' : 'warn'];
    case 'uncertainty': return [`${T('不確かさ', 'uncertainty')} (${SOURCE_LABELS()[d.source]}): ${quantity(d.status)}`, d.status === 'value' || d.status === 'missing' ? 'bad' : 'warn'];
    case 'needsCheck': return [T(`要確認 (${d.sides.map((s) => s.toUpperCase()).join('・')})`, `to be checked (${d.sides.map((s) => s.toUpperCase()).join(', ')})`), 'bad'];
    case 'order': return [T('不確かさの並びの違い', 'order of the uncertainties'), 'warn'];
    case 'onlyA': return [T('A のみ', 'only in A'), 'bad'];
    case 'onlyB': return [T('B のみ', 'only in B'), 'bad'];
    default: return [d.field, 'warn'];
  }
}

const tag = (text, kind = '') => h('span', { class: `tag ${kind}` }, text);

/** One row of an input or of the result, as text. */
function rowView(row, { other = null } = {}) {
  if (!isObject(row)) return h('span', { class: 'muted' }, '—');
  const loc = isObject(row.location) ? row.location : {};
  const orig = isObject(row.original) ? row.original : {};
  const value = numText(row, 'value');
  const conv = ex.converted(value || null, row.unit);
  const common = ex.COMMON_UNIT[row.kind];
  const uncs = list(row.uncertainties).filter(isObject).map((u) => `± ${numText(u, 'value')} (${SOURCE_LABELS()[u.source] || u.source})`);
  const differs = (a, b) => other && String(a ?? '') !== String(b ?? '');
  const mark = (text, flag) => (flag ? h('mark', null, text) : text);
  const ol = isObject(other && other.location) ? other.location : {};
  const oo = isObject(other && other.original) ? other.original : {};
  return h('div', { class: 'x-row' },
    h('div', null,
      row.nuclide ? nuclideNode(row.nuclide.element, row.nuclide.mass) : tag(T('核種不明', 'nuclide unknown'), 'bad'), ' ',
      h('span', { class: 'small' }, KIND_LABELS()[row.kind] || row.kind),
      row.conditions ? h('span', { class: 'small muted' }, ` [${row.conditions}]`) : null),
    h('div', { class: 'mono' }, mark(value || '—', differs(value, numText(other, 'value'))), ' ',
      mark(unitLabel(row.unit), differs(row.unit, other && other.unit)), uncs.length ? ` ${uncs.join(' ')}` : ''),
    conv && row.unit !== common ? h('div', { class: 'small muted mono' }, `= ${conv.text} ${unitLabel(common)}`) : null,
    h('div', { class: 'small muted' }, T('原表記: ', 'as printed: '),
      h('span', { class: 'mono' }, mark(orig.value || '—', differs(orig.value, oo.value)), ' ', mark(orig.unit || '', differs(orig.unit, oo.unit)),
        orig.uncertainty ? [' ', mark(orig.uncertainty, differs(orig.uncertainty, oo.uncertainty))] : null)),
    h('div', { class: 'small muted' }, mark(loc.item || '?', differs(loc.item, ol.item)),
      loc.page ? [' · p. ', mark(loc.page, differs(loc.page, ol.page))] : null,
      loc.label ? [' · ', mark(loc.label, differs(loc.label, ol.label))] : null),
    row.needsCheck ? h('div', null, tag(`${T('要確認', 'to be checked')}: ${row.needsCheck}`, 'bad')) : null,
    row.notes ? h('div', { class: 'small muted' }, `${T('メモ', 'Note')}: ${row.notes}`) : null,
    row.comment ? h('div', { class: 'small' }, `${T('コメント', 'Comment')}: ${row.comment}`) : null);
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

export function renderExtraction(root, ctx, params) {
  const id = params.get('task');
  return id ? taskPage(root, ctx, id, params.get('view') || 'summary') : taskList(root, ctx);
}

// ---- list of tasks ------------------------------------------------------------------

function taskList(root, ctx) {
  const { workspace, navigate, toast } = ctx;
  const panel = savePanel({ workspace }, { saved: () => draw(), changed: () => draw() });
  const listEl = h('div');
  const form = { id: '', bibId: '', version: '', code: 'EXP', key: '', facility: '', file: null };
  const status = h('span', { class: 'small muted', role: 'status' });

  function draw() {
    panel.refresh();
    const ids = ex.taskIds(workspace.paths());
    const slotText = (s, slot) => {
      const inp = s[slot];
      if (!inp) return h('span', { class: 'muted' }, T('未作成', 'not started'));
      return h('span', null, MODE_LABELS()[inp.mode] || inp.mode, inp.extractor ? ` (${inp.extractor})` : '', ' ',
        ex.isSubmitted(inp) ? tag(T('提出済み', 'submitted'), 'good') : tag(T('入力中', 'in progress'), 'warn'));
    };
    replace(listEl, ids.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, T('タスク', 'Task')), h('th', null, T('文献', 'Source')),
        h('th', null, T('入力 A', 'Input A')), h('th', null, T('入力 B', 'Input B')), h('th', null, T('段階', 'Step')))),
      h('tbody', null, ids.map((tid) => {
        const s = ex.readTask((p) => workspace.text(p), tid);
        const st = s.task ? ex.stage(s) : null;
        return h('tr', { class: 'selectable', onclick: () => navigate('extraction', { task: tid }) },
          h('td', null, h('a', { href: `#/extraction?task=${encodeURIComponent(tid)}`, onclick: (e) => e.stopPropagation() }, h('strong', null, tid))),
          h('td', { class: 'small' }, s.task ? `${s.task.source.bibId} · ${s.task.source.version}` : T('(task.json がありません)', '(no task.json)')),
          h('td', { class: 'small' }, slotText(s, 'A')), h('td', { class: 'small' }, slotText(s, 'B')),
          h('td', null, st ? tag(STAGE_LABELS()[st], STAGE_TAGS[st]) : null));
      }))))
      : h('div', { class: 'card-body muted' }, T('まだタスクがありません。下の「新しいタスク」から始めます。', 'No tasks yet. Start one under “New task”.')));
  }

  async function create() {
    const tid = form.id.trim();
    if (!ex.TASK_ID_RE.test(tid)) { toast(T('タスク名は英数字と . _ - で付けてください(例 Suzuki1987)', 'A task name consists of letters, digits, . _ - (e.g. Suzuki1987)'), 'bad'); return; }
    if (workspace.text(ex.taskPath(tid, 'task.json')) !== null) { toast(T('同じ名前のタスクがあります', 'A task of this name exists'), 'bad'); return; }
    form.bibId = sourceText(form.bibId);
    if (!bibKind(form.bibId)) { toast(SOURCE_HINT(), 'bad'); return; }
    if (!form.version.trim()) { toast(T('読んだ版を入力してください', 'Say which version was read'), 'bad'); return; }
    if (!form.file) { toast(T('PDF を選んでください', 'Choose the PDF'), 'bad'); return; }
    status.textContent = T('PDF を読み込み中…', 'Reading the PDF …');
    try {
      const info = await ctx.backend.request('POST', '/api/extraction/pdf', { task: tid, data: await fileBase64(form.file) });
      const task = ex.newTask({ id: tid, bibId: form.bibId.trim(), version: form.version.trim(), sha256: info.sha256, size: info.size,
        datasetType: TYPE_OF[form.code], key: form.key, facility: form.facility });
      workspace.stage(ex.taskPath(tid, 'task.json'), ex.workText(task, workspace.schemas));
      toast(T('タスクを作りました(まだ保存されていません)。表・図の一覧を入力してください。', 'Task created (not saved yet). List its tables and figures next.'));
      navigate('extraction', { task: tid });
    } catch (err) {
      status.textContent = '';
      toast(workErrorText(err), 'bad');
    }
  }

  const facilities = workspace.db.tables().facilities;
  const facilityEl = select([['', T('(選択)', '(choose)')], ...facilities.map((f) => [f.abbr, f.abbr])], '', (v) => { form.facility = v; });
  const pdf = h('input', { type: 'file', accept: 'application/pdf,.pdf', onchange: (e) => { form.file = e.target.files[0] || null; } });
  replace(root,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, T('値の抽出', 'Value extraction')),
      h('p', { class: 'muted' }, T('論文の値を2人(または人と AI)が互いに見ずに読み取り、比較・判定し、責任者が承認してからデータに登録します。',
        'The values of a source are read twice, independently (two people, or a person and AI), compared and decided, and registered in the data after a responsible person approved them.')))),
    panel.el,
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, T('タスク', 'Tasks'))), listEl),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, T('新しいタスク', 'New task'))),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'form-cols' },
          field(T('タスク名', 'Task name'), input('', (v) => { form.id = v; }, { placeholder: 'Suzuki1987' }), T('英数字と . _ -。extraction/ の下のフォルダ名になります', 'Letters, digits, . _ -; the folder under extraction/')),
          field(T('文献', 'Source'), input('', (v) => { form.bibId = v; }, { placeholder: 'DOI:10.1103/PhysRevC.35.2212' }), SOURCE_HINT()),
          field(T('読んだ版', 'Version read'), input('', (v) => { form.version = v; }, { placeholder: T('出版社版 / arXiv:2501.05897v2 など', 'journal version / arXiv:2501.05897v2 …') })),
          field('PDF', pdf, T('PDF はこのコンピュータにだけ置かれ、保存・送信されません。SHA-256 と大きさだけが記録されます。', 'The PDF stays on this computer and is never saved or sent; only its SHA-256 and size are recorded.')),
          field(T('登録するデータの種別', 'Kind of data to register'), select(CODES.map((c) => [c, c]), form.code, (v) => { form.code = v; }),
            T('AI が読み取った実験値も EXP です(入力の方法とデータの種別は関係ありません)。', 'Experimental values transcribed by AI are EXP too (how values are entered has nothing to do with the kind of data).')),
          field(T('施設(EXP、新しいデータセットのとき)', 'Facility (EXP, for a new dataset)'), facilityEl),
          field(T('メタデータの Key(任意)', 'Metadata key (optional)'), input('', (v) => { form.key = v; }))),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: create }, T('作成', 'Create')), status))));
  draw();
  return null;
}

// ---- one task -------------------------------------------------------------------------

function taskPage(root, ctx, id, view) {
  const { workspace, backend, toast, dialog, navigate } = ctx;
  let pending = null;          // { path, obj } typed but not stored yet
  let timer = null;
  let pane = null;             // JSON editor { name, pane }
  let pdfInfo = null;          // GET /api/extraction/pdf
  let busy = false;
  let onFlush = null;          // redraws the parts of the view that follow what is typed
  const body = h('div', { class: 'stack' });
  const head = h('div');
  const panel = savePanel({ workspace }, { prepare: () => flush(), saved: () => draw(), changed: () => draw() });

  function flush() {
    clearTimeout(timer);
    if (pending) {
      workspace.stage(pending.path, ex.workText(pending.obj, workspace.schemas));
      pending = null;
      panel.refresh();
      if (onFlush) onFlush();
    }
    return true;
  }

  /** Ask before a step that cannot be undone; `onYes` runs on confirmation. */
  function ask(title, text, label, onYes) {
    dialog({ title, body: h('p', null, text), confirm: label, onConfirm: onYes });
  }

  /** Store an edited file a moment later (typing), or at once and redraw (`now`). */
  function put(name, obj, { now = false } = {}) {
    pending = { path: ex.taskPath(id, name), obj };
    clearTimeout(timer);
    if (now) { flush(); draw(); } else timer = setTimeout(flush, STORE_DELAY_MS);
  }

  const state = () => ex.readTask((p) => workspace.text(p), id);
  const who = (reason) => ({ reason, by: userName(ctx), at: ex.nowIso() });
  const saved = (name) => workspace.status(ex.taskPath(id, name)) === 'unchanged';

  function draw() {
    flush();
    onFlush = null;
    if (pane) { pane.pane.dispose(); pane = null; }
    const s = state();
    panel.refresh();
    drawHead(s);
    if (!s.task) {
      replace(body, h('p', { class: 'notice warn' }, T('このタスクの task.json がありません。', 'This task has no task.json.'), ' ',
        h('a', { href: '#/extraction' }, T('一覧へ', 'Back to the list'))));
      return;
    }
    const views = { summary: summaryView, A: slotView, B: slotView, compare: compareView, approve: approveView, json: jsonView };
    replace(body, (views[view] || summaryView)(s, view));
  }

  function drawHead(s) {
    const st = s.task ? ex.stage(s) : null;
    const tab = (key, label) => h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(view === key),
      onclick: () => navigate('extraction', { task: id, view: key }) }, label);
    const src = s.task ? s.task.source : null;
    replace(head,
      h('div', { class: 'page-head' }, h('div', null,
        h('h1', null, h('a', { href: '#/extraction' }, T('値の抽出', 'Value extraction')), ' / ', id, ' ', st ? tag(STAGE_LABELS()[st], STAGE_TAGS[st]) : null),
        src ? h('p', { class: 'muted small' }, `${src.bibId} · ${src.version} · SHA-256 ${short(src.sha256)}… · ${src.size} bytes`) : null)),
      h('div', { class: 'tabs', role: 'tablist' },
        tab('summary', T('概要', 'Summary')), tab('A', T('入力 A', 'Input A')), tab('B', T('入力 B', 'Input B')),
        tab('compare', T('比較・判定', 'Compare and decide')), tab('approve', T('承認・登録', 'Approve and register')), tab('json', 'JSON')));
  }

  // ---- summary ----------------------------------------------------------------------
  function summaryView(s) {
    const task = s.task;
    const frozen = ex.SLOTS.some((slot) => ex.isSubmitted(s[slot]));
    const items = h('div');
    const drawItems = () => replace(items, h('table', { class: 'data grid' },
      h('thead', null, h('tr', null, h('th', null, T('表・図・本文の箇所', 'Table, figure or passage')), h('th', null, T('頁', 'Page')), h('th', null, ''))),
      h('tbody', null, list(task.source.items).map((item, i) => h('tr', null,
        h('td', null, input(item.label, (v) => { item.label = v; put('task.json', task); }, { placeholder: 'Table 1' })),
        h('td', null, input(item.page, (v) => { setText(item, 'page', v); put('task.json', task); }, { class: 'c-a' })),
        h('td', null, h('button', { class: 'btn small ghost', type: 'button', 'aria-label': T('削除', 'Delete'),
          onclick: () => { task.source.items.splice(i, 1); put('task.json', task, { now: true }); } }, '✕')))))));
    drawItems();
    const verify = h('input', { type: 'file', accept: 'application/pdf,.pdf', onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        pdfInfo = await backend.request('POST', '/api/extraction/pdf', { task: id, data: await fileBase64(file) });
      } catch (err) { toast(workErrorText(err), 'bad'); }
      draw();
    } });
    if (pdfInfo === null) {
      pdfInfo = {};
      backend.request('GET', `/api/extraction/pdf?task=${encodeURIComponent(id)}`).then((info) => { pdfInfo = info; if (view === 'summary' && root.isConnected) draw(); }, () => {});
    }
    if (aiInfo === null) {
      aiInfo = {};
      backend.request('GET', '/api/extraction/ai').then((info) => { aiInfo = info; if (root.isConnected) draw(); }, () => {});
    }
    const same = pdfInfo && pdfInfo.present ? pdfInfo.sha256 === task.source.sha256 : null;
    const checking = !pdfInfo || pdfInfo.present === undefined;
    const target = task.target;
    const facilities = workspace.db.tables().facilities;
    const slotBox = (slot) => {
      const inp = s[slot];
      return h('div', { class: 'x-slot' }, h('h3', null, T(`入力 ${slot}`, `Input ${slot}`)),
        inp ? [h('p', null, MODE_LABELS()[inp.mode], inp.extractor ? ` — ${inp.extractor}` : ''),
          inp.run ? h('p', { class: 'small muted' }, `${inp.run.model} · ${inp.run.promptVersion} · ${inp.run.at}`) : null,
          inp.aiDraft ? h('p', { class: 'small muted' }, T('AI 下書き: ', 'AI draft: '), `${inp.aiDraft.run.model} · ${inp.aiDraft.run.promptVersion} · ${inp.aiDraft.run.at}`) : null,
          h('p', null, ex.isSubmitted(inp) ? tag(T(`提出済み ${inp.submitted.at}`, `submitted ${inp.submitted.at}`), 'good') : tag(T('入力中', 'in progress'), 'warn'))]
          : h('p', { class: 'muted' }, T('未作成', 'not started')),
        h('a', { class: 'btn small', href: `#/extraction?task=${encodeURIComponent(id)}&view=${slot}` }, T('開く', 'Open')));
    };
    const ind = ex.independence(s.A, s.B);
    return [
      panel.el,
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, T('文献と PDF', 'Source and PDF'))),
        h('div', { class: 'card-body stack' },
          frozen ? h('p', { class: 'notice warn' }, T('提出済みの入力があります。文献・PDF・表の一覧を変えると、提出済みの入力と合わなくなり保存できません。',
            'An input is submitted: changing the source, the PDF or the list of items no longer fits it, and is refused when saving.')) : null,
          h('div', { class: 'form-cols' },
            field(T('文献', 'Source'), input(task.source.bibId, (v) => { task.source.bibId = sourceText(v); put('task.json', task); })),
            field(T('読んだ版', 'Version read'), input(task.source.version, (v) => { task.source.version = v; put('task.json', task); })),
            h('div', { class: 'field wide' },
              h('p', { class: 'mono small' }, `SHA-256 ${task.source.sha256} · ${task.source.size} bytes`),
              h('p', null, checking ? h('span', { class: 'muted' }, T('PDF を確認中…', 'Checking the PDF …')) : same === null ? tag(T('この PDF はこのコンピュータにありません', 'The PDF is not on this computer'), 'warn')
                : same ? tag(T('このコンピュータの PDF はタスクの PDF と同じです', 'The PDF on this computer is the one of the task'), 'good')
                  : [tag(T('このコンピュータの PDF はタスクの PDF と異なります', 'The PDF on this computer differs from the one of the task'), 'bad'), ' ',
                    frozen ? null : h('button', { class: 'btn small', type: 'button', onclick: () => {
                      task.source.sha256 = pdfInfo.sha256; task.source.size = pdfInfo.size;
                      for (const slot of ex.SLOTS) {
                        const inp = s[slot];
                        if (inp && !ex.isSubmitted(inp)) { inp.sourceSha256 = pdfInfo.sha256; workspace.stage(ex.taskPath(id, ex.inputName(slot)), ex.workText(inp, workspace.schemas)); }
                      }
                      put('task.json', task, { now: true });
                    } }, T('この PDF に切り替える', 'Use this PDF'))]),
              field(T('PDF を選んで確かめる', 'Choose the PDF to check it'), verify,
                T('PDF はこのコンピュータの extraction/ に置かれるだけで、保存・送信されません。', 'The PDF is only kept in extraction/ on this computer; it is never saved or sent.')))))),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, T('表・図の一覧', 'Tables and figures')),
          h('button', { class: 'btn small', type: 'button', onclick: () => {
            task.source.items = list(task.source.items).concat([{ label: '' }]);
            put('task.json', task, { now: true });
          } }, T('+ 追加', '+ Add'))),
        h('div', { class: 'card-body stack' },
          h('p', { class: 'small muted' }, T('値が載っている可能性のある表・図・本文の箇所をすべて挙げます。各入力はそのそれぞれに「値あり」「該当なし」を付け、読み落としを見つけます。',
            'List every table, figure or passage that may hold values. Each input marks every one of them as “has values” or “no relevant data”, so that missed tables are found.')),
          items)),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, T('登録先', 'Where the values go'))),
        h('div', { class: 'card-body form-cols' },
          field(T('データの種別', 'Kind of data'), select(CODES.map((c) => [TYPE_OF[c], c]), target.datasetType, (v) => {
            target.datasetType = v;
            if (v !== 'experiment') delete target.facility;
            put('task.json', task, { now: true });
          }), T('入力の方法(人 / AI)とは関係ありません。AI が読み取った実験値も EXP です。', 'Unrelated to how the values are entered: experimental values read by AI are EXP.')),
          target.datasetType === 'experiment' ? field(T('施設(新しいデータセットのとき)', 'Facility (for a new dataset)'),
            select([['', T('(選択)', '(choose)')], ...facilities.map((f) => [f.abbr, f.abbr])], target.facility || '', (v) => { setText(target, 'facility', v); put('task.json', task); })) : null,
          field(T('メタデータの Key(任意)', 'Metadata key (optional)'), input(target.key, (v) => { setText(target, 'key', v); put('task.json', task); })))),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, T('入力', 'Inputs'))),
        h('div', { class: 'card-body stack' },
          h('div', { class: 'x-slots' }, slotBox('A'), slotBox('B')),
          ind.independent === null ? null : h('p', { class: `notice ${ind.independent ? 'good' : 'warn'}` },
            ind.independent ? T(`独立な二重入力です(${ind.pair})。`, `Independent double extraction (${ind.pair}).`) : INDEPENDENCE_TEXTS()[ind.reason]),
          h('p', { class: 'small muted' }, T('独立とみなす組み合わせ: 人 + 人(別の人)、人 + AI、人 + AI 下書きを人が修正。独立とみなさない組み合わせ: AI + AI、AI + AI 下書き、AI 下書き + AI 下書き、同じ人による2つの入力。',
            'Independent: person + person (two people), person + AI, person + AI draft corrected by a person. Not independent: AI + AI, AI + AI draft, AI draft + AI draft, two inputs of the same person.')),
          h('p', { class: 'small' }, T('AI による抽出: ', 'AI extraction: '),
            !aiInfo || aiInfo.available === undefined ? T('確認中…', 'checking …')
              : aiInfo.available ? tag(T(`利用できます (${aiInfo.model}, ${aiInfo.promptVersion})`, `available (${aiInfo.model}, ${aiInfo.promptVersion})`), 'good')
                : tag(aiInfo.reason === 'no-key' ? T('利用できません: ツールを起動した環境に ANTHROPIC_API_KEY がありません', 'not available: ANTHROPIC_API_KEY is not set where the tool was started')
                  : T('利用できません: anthropic パッケージがありません(pixi run -e ai admin で起動します)', 'not available: the anthropic package is missing (start with pixi run -e ai admin)'), 'warn')))),
    ];
  }

  // ---- one input ----------------------------------------------------------------------
  function slotView(s, slot) {
    const inp = s[slot];
    const other = slot === 'A' ? 'B' : 'A';
    const name = ex.inputName(slot);
    const blind = h('p', { class: 'notice' }, T(`入力 ${other} の内容は、両方の入力が提出されるまで表示されません。AI には入力 ${other} を渡しません。`,
      `Input ${other} is not shown until both inputs are submitted. The AI never receives input ${other}.`));
    if (!inp) return [panel.el, blind, startCard(s, slot)];
    if (ex.isSubmitted(inp)) {
      return [panel.el, h('section', { class: 'card' }, h('div', { class: 'card-body stack' },
        h('p', null, tag(T(`提出済み ${inp.submitted.at}`, `submitted ${inp.submitted.at}`), 'good'), ' ', MODE_LABELS()[inp.mode], inp.extractor ? ` — ${inp.extractor}` : ''),
        ex.canShowInput(s, slot) ? h('p', null, T('両方の入力が提出されました。内容は「比較・判定」で見られます。', 'Both inputs are submitted; see them under “Compare and decide”.'), ' ',
          h('a', { href: `#/extraction?task=${encodeURIComponent(id)}&view=compare` }, T('比較・判定へ', 'Compare and decide')))
          : h('p', { class: 'muted' }, T(`提出した入力は変更できません。内容は、入力 ${other} も提出されると表示されます。`, `A submitted input cannot be changed. It is shown once input ${other} is submitted too.`))))];
    }
    const me = userName(ctx);
    const key = `${id}/${slot}`;
    if (inp.extractor && me && inp.extractor !== me && !opened.has(key)) {
      return [panel.el, blind, h('section', { class: 'card' }, h('div', { class: 'card-body stack' },
        h('p', null, T(`この入力の担当は ${inp.extractor} さんです。開くと入力途中の内容が表示されます。もう一方の入力を担当している場合は開かないでください。`,
          `${inp.extractor} makes this input. Opening it shows what has been typed so far; do not open it if you make the other input.`)),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => { opened.add(key); draw(); } }, T('表示して続ける', 'Show it and continue')))))];
    }
    return [panel.el, blind, ...inputEditor(s, slot, inp, name)];
  }

  function startCard(s, slot) {
    const me = userName(ctx);
    const extractor = { name: me };
    const run = async (mode) => {
      if (!saved('task.json')) { toast(workErrorText({ code: 'task-not-saved' }), 'bad'); return; }
      if (mode === 'assisted' && !extractor.name.trim()) { toast(T('修正する人の名前を入力してください', 'Enter the name of the person who corrects the draft'), 'bad'); return; }
      if (!await new Promise((resolve) => ask(T(`入力 ${slot} を AI で作る`, `Input ${slot} by AI`),
        T(`AI に PDF を読ませて入力 ${slot} を作り、保存します。数分かかることがあります。`, `The AI reads the PDF; the result is saved as input ${slot}. This can take minutes.`),
        T('AI に読ませる', 'Let the AI read it'), () => resolve(true)))) return;
      busy = true;
      draw();
      try {
        const r = await backend.request('POST', '/api/extraction/ai-run', { task: id, slot, mode, extractor: extractor.name.trim() });
        backend.pending = r.pending;
        backend.sendError = r.sent ? null : r.error || null;
        await workspace.load();
        toast(T(`AI が ${r.rows} 行を読み取り、入力 ${slot} として保存しました。`, `The AI read ${r.rows} row(s); saved as input ${slot}.`));
      } catch (err) {
        toast(workErrorText(err), 'bad');
      }
      busy = false;
      draw();
    };
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, T(`入力 ${slot} を始める`, `Start input ${slot}`))),
      h('div', { class: 'card-body stack' },
        field(T('入力する人', 'Extractor'), input(me, (v) => { extractor.name = v; }), T('人が入力する場合、AI 下書きを修正する場合', 'when a person types or corrects')),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', disabled: busy, onclick: () => {
            if (!extractor.name.trim()) { toast(T('入力する人の名前を入力してください', 'Enter the name of the extractor'), 'bad'); return; }
            put(ex.inputName(slot), ex.newInput(s.task, slot, 'human', extractor.name.trim()), { now: true });
          } }, T('人が入力する', 'Type it')),
          h('button', { class: 'btn', type: 'button', disabled: busy || !(aiInfo && aiInfo.available), onclick: () => run('ai') }, T('AI に入力させる', 'Let the AI make it')),
          h('button', { class: 'btn', type: 'button', disabled: busy || !(aiInfo && aiInfo.available), onclick: () => run('assisted') }, T('AI の下書きを人が直す', 'AI draft, corrected by a person'))),
        busy ? h('p', { class: 'muted', role: 'status' }, T('AI が読み取っています…', 'The AI is reading …')) : null,
        h('p', { class: 'small muted' }, T('AI は PDF とタスクの表・図の一覧だけを受け取ります。読み取れない箇所は推測せず「要確認」にします。AI が作った入力はすぐに提出済みになります。「AI の下書きを人が直す」は、下書きを記録に残したまま人が直して提出するもので、AI の出力から独立した入力ではありません。',
          'The AI receives the PDF and the task’s list of tables and figures only. What it cannot read it marks “to be checked” instead of guessing. An input made by the AI is submitted at once. “AI draft, corrected by a person” keeps the draft on record; such an input is not independent of AI output.')),
        aiInfo && aiInfo.available === false ? h('p', { class: 'small muted' }, T('AI による抽出は、このツールを起動した環境に API キー(ANTHROPIC_API_KEY)があり、pixi run -e ai admin で起動したときに使えます。',
          'AI extraction works when the tool runs with an API key (ANTHROPIC_API_KEY) in its environment and was started with pixi run -e ai admin.')) : null));
  }

  function inputEditor(s, slot, inp, name) {
    const task = s.task;
    const save = (opts) => put(name, inp, opts);
    const labels = ex.coverageItems(task, inp, null);
    const coverage = h('table', { class: 'data grid' },
      h('thead', null, h('tr', null, h('th', null, T('表・図・本文の箇所', 'Table, figure or passage')), h('th', null, T('印', 'Mark')), h('th', { class: 'num' }, T('行', 'Rows')))),
      h('tbody', null, labels.map((label) => h('tr', null,
        h('td', null, label, list(task.source.items).some((i) => i.label === label) ? null : h('span', { class: 'small muted' }, T(' (この入力で追加)', ' (added by this input)'))),
        h('td', null, select([['', T('(未確認)', '(not marked)')], ...Object.entries(COVERAGE_LABELS())], ex.coverageStatus(inp, label) || '',
          (v) => { ex.setCoverage(inp, label, v); save({ now: true }); })),
        h('td', { class: 'num' }, String(list(inp.rows).filter((r) => r.location && r.location.item === label).length))))));
    const newItem = input('', () => {}, { placeholder: T('一覧にない表・図(例 Table 5)', 'a table or figure not listed (e.g. Table 5)') });
    const rowsEl = rowsTable(task, inp, save);
    const submitEl = h('div', { class: 'card-body stack' });
    const drawSubmit = () => {
      const problems = ex.schemaProblems(inp, workspace.schemas);
      const blockers = ex.submissionProblems(task, inp, workspace.schemas);
      replace(submitEl,
        problems.length ? h('div', { class: 'notice bad' }, h('strong', null, T('直すところがあります', 'To be fixed')),
          h('ul', { class: 'issue-list compact' }, problems.slice(0, 20).map((p) => h('li', null, `${p.pointer} — ${p.message}`)))) : null,
        blockers.includes('coverage') ? h('p', { class: 'notice warn' }, T('印を付けていない表・図があります。', 'Some tables or figures are not marked.')) : null,
        h('p', { class: 'small muted' }, T('提出すると、この入力は変更できなくなります。もう一方の入力が提出されるまで、内容は表示されません。提出の後に「保存」を押すと記録されます。',
          'Once submitted, this input cannot be changed, and it is not shown until the other input is submitted. Press “Save” afterwards to record it.')),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', disabled: blockers.length > 0, onclick: () => ask(
          T(`入力 ${slot} を提出`, `Submit input ${slot}`), T('提出した入力は変更できません。提出しますか?', 'A submitted input cannot be changed. Submit it?'), T('提出', 'Submit'), () => {
            inp.submitted = { at: ex.nowIso() };
            save({ now: true });
            toast(T('提出しました。「保存」を押すと記録されます。', 'Submitted. Press “Save” to record it.'));
          }) }, T('提出', 'Submit'))));
    };
    drawSubmit();
    onFlush = drawSubmit;
    return [
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, T(`入力 ${slot}`, `Input ${slot}`), ' ', tag(MODE_LABELS()[inp.mode], 'warn'))),
        h('div', { class: 'card-body form-cols' },
          field(T('入力する人', 'Extractor'), input(inp.extractor, (v) => { inp.extractor = v; save(); })),
          inp.aiDraft ? h('div', { class: 'field' }, h('p', { class: 'small muted' },
            T(`AI 下書き: ${inp.aiDraft.run.model}(${inp.aiDraft.run.promptVersion}、${inp.aiDraft.run.at})、${inp.aiDraft.rows.length} 行。下書きはそのまま記録に残ります。`,
              `AI draft: ${inp.aiDraft.run.model} (${inp.aiDraft.run.promptVersion}, ${inp.aiDraft.run.at}), ${inp.aiDraft.rows.length} row(s); it is kept on record as it is.`))) : null,
          inp.sourceSha256 !== task.source.sha256 ? h('p', { class: 'notice bad wide' }, T('この入力は、タスクに記録された PDF とは別の PDF について作られています。', 'This input was made for another PDF than the one of the task.')) : null)),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, T('表・図ごとの確認', 'Coverage of the source'))),
        h('div', { class: 'card-body stack' },
          h('p', { class: 'small muted' }, T('すべての表・図・箇所に「値あり」か「該当なし」を付けます(決められないときは「要確認」)。全部に付けるまで提出できません。',
            'Mark every table, figure and passage as “has values” or “no relevant data” (“to be checked” when undecided). The input can be submitted once all are marked.')),
          h('div', { class: 'table-wrap' }, coverage),
          h('div', { class: 'row' }, newItem, h('button', { class: 'btn small', type: 'button', onclick: () => {
            const label = newItem.value.trim();
            if (!label) return;
            ex.setCoverage(inp, label, 'covered');
            save({ now: true });
          } }, T('一覧にない箇所を追加', 'Add an item not listed'))))),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, T('値', 'Values')),
          h('button', { class: 'btn small', type: 'button', onclick: () => {
            const last = list(inp.rows)[inp.rows.length - 1];
            const row = ex.newRow(inp.rows, { item: last && last.location ? last.location.item : (labels[0] || ''), page: last && last.location ? last.location.page : '' });
            if (last) { row.kind = last.kind; row.unit = last.unit; }
            inp.rows.push(row);
            save({ now: true });
          } }, T('+ 行を追加', '+ Add row'))),
        h('div', { class: 'card-body stack' },
          h('p', { class: 'small muted' }, T('「原表記」には論文に印刷されているとおりの数値・単位・不確かさだけを書きます(文章は写しません)。「値」「単位」「±」には同じ数値を、書かれた桁のまま入力します。換算・丸めはしません。読み取れない箇所は空欄にして「要確認」に書きます。',
            'Under “as printed” write only the number, unit and uncertainty exactly as printed (no sentences). Enter the same number under value, unit and ± with the digits printed; nothing is converted or rounded. Leave out what cannot be read and describe it under “to be checked”.')),
          rowsEl)),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, T('提出', 'Submit'))), submitEl),
    ];
  }

  function rowsTable(task, inp, save) {
    const items = ex.coverageItems(task, inp, null);
    const listId = `x-items-${id}`;
    const kinds = Object.entries(KIND_LABELS());
    const head = ['#', T('頁', 'Page'), T('表・図', 'Table/fig.'), T('行・ラベル', 'Row/label'), T('元素', 'El.'), 'A', T('量', 'Quantity'), T('条件', 'Conditions'),
      T('原表記: 値', 'Printed: value'), T('単位', 'unit'), T('不確かさ', 'uncertainty'), T('値', 'Value'), T('単位', 'Unit'),
      T('± 全体', '± total'), T('± 統計', '± stat.'), T('± 系統', '± syst.'), T('要確認', 'To be checked'), T('メモ', 'Notes'), ''];
    return h('div', { class: 'table-wrap grid-wrap' },
      h('datalist', { id: listId }, items.map((i) => h('option', { value: i }))),
      h('table', { class: 'data grid' },
        h('thead', null, h('tr', null, head.map((x) => h('th', null, x)))),
        h('tbody', null, list(inp.rows).map((row, i) => {
          if (!isObject(row.location)) row.location = { item: '' };
          if (!isObject(row.original)) row.original = {};
          const nuc = () => { if (!isObject(row.nuclide)) row.nuclide = {}; return row.nuclide; };
          const dropEmptyNuclide = () => { if (isObject(row.nuclide) && !row.nuclide.element && row.nuclide.mass === undefined) delete row.nuclide; };
          return h('tr', null,
            h('td', { class: 'small muted' }, row.id),
            h('td', null, input(row.location.page, (v) => { setText(row.location, 'page', v); save(); }, { class: 'c-m' })),
            h('td', null, input(row.location.item, (v) => { row.location.item = v.trim(); save(); }, { class: 'c-key', list: listId })),
            h('td', null, input(row.location.label, (v) => { setText(row.location, 'label', v); save(); }, { class: 'c-key' })),
            h('td', null, input(row.nuclide && row.nuclide.element, (v) => { setText(nuc(), 'element', v); dropEmptyNuclide(); save(); }, { class: 'c-el' })),
            h('td', null, input(row.nuclide ? numText(row.nuclide, 'mass') : '', (v) => { setNum(nuc(), 'mass', v); dropEmptyNuclide(); save(); }, { class: 'c-a', title: T('質量数。0 = 天然同位体比', 'Mass number; 0 = natural abundance') })),
            h('td', null, select(kinds, row.kind, (v) => { row.kind = v; if (!ex.UNITS[v].includes(row.unit)) row.unit = ex.UNITS[v][0]; save({ now: true }); }, { class: 'c-obs' })),
            h('td', null, input(row.conditions, (v) => { setText(row, 'conditions', v); save(); }, { class: 'c-key', title: T('同じ核種・量の値を区別する短いラベル(標的の形など)。データの Key になります', 'Short label telling values of the same nuclide and quantity apart (target form …); becomes the key of the data entry') })),
            h('td', null, input(row.original.value, (v) => { setText(row.original, 'value', v); save(); }, { class: 'c-num' })),
            h('td', null, input(row.original.unit, (v) => { setText(row.original, 'unit', v); save(); }, { class: 'c-a' })),
            h('td', null, input(row.original.uncertainty, (v) => { setText(row.original, 'uncertainty', v); save(); }, { class: 'c-unc' })),
            h('td', null, input(numText(row, 'value'), (v) => { setNum(row, 'value', v); save(); }, { class: 'c-num' })),
            h('td', null, select([['', '—'], ...ex.UNITS[row.kind].map((u) => [u, unitLabel(u)])], row.unit || '', (v) => { setText(row, 'unit', v); save(); }, { class: 'c-unit' })),
            ...['total', 'statistical', 'systematic'].map((src) => h('td', null, input(uncText(row, src), (v) => { setUnc(row, src, v); save(); }, { class: 'c-unc' }))),
            h('td', null, input(row.needsCheck, (v) => { setText(row, 'needsCheck', v); save(); }, { class: 'c-comment', placeholder: T('読み取れない点', 'what is unclear') })),
            h('td', null, input(row.notes, (v) => { setText(row, 'notes', v); save(); }, { class: 'c-comment' })),
            h('td', null, h('button', { class: 'btn small ghost', type: 'button', 'aria-label': T('行を削除', 'Delete row'),
              onclick: () => { inp.rows.splice(i, 1); save({ now: true }); } }, '✕')));
        }))));
  }

  // ---- comparison and decisions ------------------------------------------------------------
  function compareView(s) {
    if (!ex.canCompare(s)) {
      const st = (slot) => (s[slot] ? (ex.isSubmitted(s[slot]) ? T('提出済み', 'submitted') : T('入力中', 'in progress')) : T('未作成', 'not started'));
      return [panel.el, h('p', { class: 'notice' }, T(`両方の入力が提出されると比較できます(A: ${st('A')}、B: ${st('B')})。それまでは、どちらの入力の内容も表示しません。`,
        `The inputs are compared once both are submitted (A: ${st('A')}, B: ${st('B')}). Until then neither is shown here.`))];
    }
    const c = ex.compare(s.task, s.A, s.B);
    const base = s.adjudication || ex.newAdjudication(id);
    const adjust = (fn) => {
      const adj = s.adjudication || ex.newAdjudication(id);
      fn(adj);
      ex.withAgreed(adj, c);
      put('adjudication.json', adj, { now: true });
    };
    const problems = ex.adjudicationProblems(s.task, s.A, s.B, ex.withAgreed(jsonfmt.clone(base), c));
    const openRows = new Set(problems.open.filter((o) => o.code === 'OPEN_ROW').map((o) => `${o.side}:${o.id}`));
    const counts = {
      agreed: c.items.filter((i) => i.agreed).length,
      differ: c.items.filter((i) => i.a && i.b && !i.agreed).length,
      onlyA: c.items.filter((i) => i.a && !i.b).length,
      onlyB: c.items.filter((i) => !i.a && i.b).length,
    };
    const approval = ex.approvalState(s.task, s.A, s.B, s.adjudication);
    const src = s.task.source;
    const inputInfo = (slot) => {
      const inp = s[slot];
      return h('div', { class: 'x-slot' }, h('h3', null, T(`入力 ${slot}`, `Input ${slot}`)),
        h('p', null, MODE_LABELS()[inp.mode], inp.extractor ? ` — ${inp.extractor}` : ''),
        inp.run ? h('p', { class: 'small muted' }, `${inp.run.model} · ${inp.run.promptVersion} · ${inp.run.at}`) : null,
        inp.aiDraft ? h('p', { class: 'small muted' }, T('AI 下書き: ', 'AI draft: '), `${inp.aiDraft.run.model} · ${inp.aiDraft.run.at}`) : null,
        h('p', { class: 'small muted' }, T(`提出 ${inp.submitted.at} · ${inp.rows.length} 行`, `submitted ${inp.submitted.at} · ${inp.rows.length} row(s)`)));
    };
    return [
      panel.el,
      approval === 'stale' ? h('p', { class: 'notice bad' }, T('承認の後に内容が変わりました。再確認が必要です(「承認・登録」で承認し直します)。', 'The content changed after its approval: re-check needed (approve again under “Approve and register”).')) : null,
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, T('文献と入力', 'Source and inputs'))),
        h('div', { class: 'card-body stack' },
          h('p', { class: 'small' }, `${src.bibId} · ${src.version} · SHA-256 ${src.sha256} · ${src.size} bytes`),
          h('div', { class: 'x-slots' }, inputInfo('A'), inputInfo('B')),
          h('p', { class: `notice ${c.independence.independent ? 'good' : 'warn'}` },
            c.independence.independent ? T(`独立な二重入力です(${c.independence.pair})。`, `Independent double extraction (${c.independence.pair}).`) : INDEPENDENCE_TEXTS()[c.independence.reason]),
          h('p', { class: 'small' }, T(`一致 ${counts.agreed} · 相違 ${counts.differ} · A のみ ${counts.onlyA} · B のみ ${counts.onlyB} · 未判定 ${problems.open.length}`,
            `identical ${counts.agreed} · different ${counts.differ} · only A ${counts.onlyA} · only B ${counts.onlyB} · open ${problems.open.length}`)),
          h('p', { class: 'small muted' }, T('一致していても正しいとは限りません。登録の前に責任者が承認します。比較に許容幅や丸めはありません: 数値は書かれた桁のまま、換算後の値は厳密に比べます。',
            'Agreement is not correctness: a responsible person approves before anything is registered. There is no tolerance or rounding: numbers are compared as written, converted values exactly.')))),
      coverageCard(s, c, adjust),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, T('値の比較と判定', 'Values: comparison and decision')),
          h('button', { class: 'btn small', type: 'button', onclick: () => otherDialog(s, null, adjust) }, T('両方にない行を追加…', 'Add a row neither has …'))),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data x-compare' },
          h('thead', null, h('tr', null, h('th', null, T('違い', 'Differences')), h('th', null, 'A'), h('th', null, 'B'),
            h('th', null, T('候補(採用する値)', 'Candidate (adopted)')), h('th', null, T('判定', 'Decision')))),
          h('tbody', null, c.items.map((item) => compareRow(s, item, base, openRows, adjust)),
            list(base.rows).filter((r) => !r.a && !r.b).map((r) => h('tr', null,
              h('td', null, tag(T('両方にない行', 'in neither input'), 'warn')), h('td', null, '—'), h('td', null, '—'),
              h('td', null, rowView(r)),
              h('td', null, decisionText(r), h('button', { class: 'btn small', type: 'button', onclick: () => adjust((adj) => ex.removeRow(adj, r.id)) }, T('取り消す', 'Undo'))))))))),
    ];
  }

  function coverageCard(s, c, adjust) {
    const decisions = new Map(list(s.adjudication && s.adjudication.coverage).map((x) => [x.item, x]));
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, T('表・図ごとの確認', 'Coverage of the source'))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, T('表・図・箇所', 'Item')), h('th', null, 'A'), h('th', null, 'B'), h('th', null, T('判定', 'Decision')))),
        h('tbody', null, c.coverage.map((x) => {
          const d = decisions.get(x.item);
          const mark = (status, rows) => h('span', null, status ? COVERAGE_LABELS()[status] : h('span', { class: 'muted' }, T('印なし', 'not marked')),
            h('span', { class: 'small muted' }, T(` · ${rows} 行`, ` · ${rows} row(s)`)),
            status === 'no-data' && rows ? [' ', tag(T('「該当なし」なのに行がある', 'marked “no data” but has rows'), 'bad')] : null);
          return h('tr', null,
            h('td', null, x.item, list(s.task.source.items).some((i) => i.label === x.item) ? null : [' ', tag(T('一覧にない', 'not listed'), 'warn')]),
            h('td', null, mark(x.a, x.rowsA)), h('td', null, mark(x.b, x.rowsB)),
            h('td', null, x.agreed && !d ? tag(T('一致', 'same'), 'good')
              : d ? h('span', null, COVERAGE_LABELS()[d.status], h('span', { class: 'small muted' }, ` — ${d.reason} (${d.by}, ${d.at})`), ' ',
                h('button', { class: 'btn small', type: 'button', onclick: () => adjust((adj) => ex.decideCoverage(adj, x.item, '', {})) }, T('取り消す', 'Undo')))
                : h('span', { class: 'row' }, ['covered', 'no-data'].map((status) => h('button', { class: 'btn small', type: 'button', onclick: () => reasonDialog(
                  T(`「${x.item}」を「${COVERAGE_LABELS()[status]}」とする理由`, `Why “${x.item}” is “${COVERAGE_LABELS()[status]}”`),
                  (reason) => adjust((adj) => ex.decideCoverage(adj, x.item, status, who(reason)))) }, COVERAGE_LABELS()[status])))));
        })))));
  }

  function decisionText(row) {
    const choice = { agreed: T('一致(そのまま採用)', 'identical (adopted as is)'), A: T('A を採用', 'A adopted'), B: T('B を採用', 'B adopted'), other: T('修正して採用', 'corrected and adopted') }[row.adopted];
    return h('div', null, h('strong', null, choice), row.reason ? h('div', { class: 'small muted' }, `${row.reason} (${row.by}, ${row.at})`) : null);
  }

  function compareRow(s, item, adj, openRows, adjust) {
    const decision = ex.decisionOf(adj, item.ref);
    const isOpen = (item.a && openRows.has(`a:${item.a.id}`)) || (item.b && openRows.has(`b:${item.b.id}`));
    const diffs = item.diffs.map((d) => { const [text, kind] = diffLabel(d); return tag(text, kind); });
    if (item.agreed) diffs.push(tag(T('一致', 'identical'), 'good'));
    if (item.a && item.b && !item.located) diffs.push(h('span', { class: 'small muted' }, T('(同じ核種・量・条件の唯一の組)', '(the only pair of this nuclide, quantity and conditions)')));
    const hints = item.hints.map((x) => h('div', { class: 'small muted' }, T(`もう一方の ${x.row.id} と比べて: `, `compare with ${x.row.id} of the other: `),
      x.why.map((w) => ({ natural: T('天然/同位体の違い', 'natural vs isotope'), mass: T('質量数の違い', 'mass number'), kind: T('量の違い', 'quantity'), conditions: T('条件の違い', 'conditions') }[w])).join('・')));
    const buttons = [];
    const choose = (choice, label) => h('button', { class: 'btn small', type: 'button', onclick: () => reasonDialog(
      T(`${label}: 理由`, `${label}: reason`), (reason) => adjust((a) => ex.decide(a, item, choice, who(reason)))) }, label);
    if (item.a) buttons.push(choose('A', T('A を採用', 'Adopt A')));
    if (item.b) buttons.push(choose('B', T('B を採用', 'Adopt B')));
    buttons.push(h('button', { class: 'btn small', type: 'button', onclick: () => otherDialog(s, item, adjust) }, T('修正して採用…', 'Correct and adopt …')));
    buttons.push(choose('none', T('採用しない', 'Do not adopt')));
    let candidate;
    let decided;
    if (decision && decision.kind === 'row') {
      candidate = rowView(decision.row);
      decided = [decisionText(decision.row), decision.row.adopted === 'agreed' ? null
        : h('button', { class: 'btn small', type: 'button', onclick: () => adjust((a) => ex.undecide(a, item.ref)) }, T('取り消す', 'Undo'))];
    } else if (decision) {
      candidate = h('span', { class: 'muted' }, T('採用しない', 'not adopted'));
      decided = [h('div', null, h('strong', null, T('採用しない', 'not adopted')), h('div', { class: 'small muted' }, `${decision.entry.reason} (${decision.entry.by}, ${decision.entry.at})`)),
        h('button', { class: 'btn small', type: 'button', onclick: () => adjust((a) => ex.undecide(a, item.ref)) }, T('取り消す', 'Undo'))];
    } else if (item.agreed) {
      candidate = rowView(item.a);
      decided = [h('div', null, h('strong', null, T('一致(そのまま採用)', 'identical (adopted as is)')))];
    } else {
      candidate = h('span', { class: 'muted' }, T('未判定', 'not decided'));
      decided = [];
    }
    return h('tr', { class: isOpen ? 'x-open' : null },
      h('td', null, h('div', { class: 'x-diffs' }, diffs), hints),
      h('td', null, rowView(item.a, { other: item.b }), item.a ? h('div', { class: 'small muted' }, item.a.id) : null),
      h('td', null, rowView(item.b, { other: item.a }), item.b ? h('div', { class: 'small muted' }, item.b.id) : null),
      h('td', null, candidate),
      h('td', null, h('div', { class: 'stack' }, decided, h('div', { class: 'row' }, buttons))));
  }

  /** Ask for the reason of a decision; `onReason(text)` once one is given. */
  function reasonDialog(title, onReason) {
    const text = h('textarea', { rows: 3, placeholder: T('理由(必須): 何を確かめて、なぜそうしたか', 'Reason (required): what was checked and why') });
    dialog({
      title, body: h('div', { class: 'stack' }, text, h('p', { class: 'small muted' }, T(`判定した人: ${userName(ctx) || T('(不明)', '(unknown)')}`, `Decided by: ${userName(ctx) || '(unknown)'}`))),
      confirm: T('判定する', 'Decide'),
      onConfirm: () => {
        if (!text.value.trim()) { toast(T('理由を入力してください', 'Please give the reason'), 'bad'); return; }
        onReason(text.value.trim());
      },
    });
    setTimeout(() => text.focus(), 0);
  }

  /** Adopt a corrected row (from A or B as a start, or a new one when `item` is null). */
  function otherDialog(s, item, adjust) {
    const start = item ? (item.a || item.b) : ex.newRow([], { item: '' });
    const row = jsonfmt.clone(ex.rowContent(start));
    if (!isObject(row.location)) row.location = { item: '' };
    if (!isObject(row.original)) row.original = {};
    if (!isObject(row.nuclide)) row.nuclide = { element: '', mass: 0 };
    if (!Array.isArray(row.uncertainties)) row.uncertainties = [];
    const extra = { comment: '', reason: '' };
    const kinds = Object.entries(KIND_LABELS());
    const unitBox = h('span');
    const drawUnit = () => replace(unitBox, select(ex.UNITS[row.kind].map((u) => [u, unitLabel(u)]), row.unit, (v) => { row.unit = v; }));
    if (!ex.UNITS[row.kind || 'lifetime'].includes(row.unit)) { row.kind = row.kind || 'lifetime'; row.unit = ex.UNITS[row.kind][0]; }
    drawUnit();
    const form = h('div', { class: 'form-cols' },
      field(T('表・図', 'Table/figure'), input(row.location.item, (v) => { row.location.item = v.trim(); })),
      field(T('頁', 'Page'), input(row.location.page, (v) => setText(row.location, 'page', v))),
      field(T('行・ラベル', 'Row/label'), input(row.location.label, (v) => setText(row.location, 'label', v))),
      field(T('元素', 'Element'), input(row.nuclide.element, (v) => { row.nuclide.element = v.trim(); })),
      field(T('質量数(0 = 天然)', 'Mass number (0 = natural)'), input(numText(row.nuclide, 'mass'), (v) => setNum(row.nuclide, 'mass', v))),
      field(T('量', 'Quantity'), select(kinds, row.kind, (v) => { row.kind = v; if (!ex.UNITS[v].includes(row.unit)) row.unit = ex.UNITS[v][0]; drawUnit(); })),
      field(T('条件(データの Key)', 'Conditions (key of the data entry)'), input(row.conditions, (v) => setText(row, 'conditions', v))),
      field(T('原表記: 値', 'As printed: value'), input(row.original.value, (v) => setText(row.original, 'value', v))),
      field(T('原表記: 単位', 'As printed: unit'), input(row.original.unit, (v) => setText(row.original, 'unit', v))),
      field(T('原表記: 不確かさ', 'As printed: uncertainty'), input(row.original.uncertainty, (v) => setText(row.original, 'uncertainty', v))),
      field(T('値(書かれた桁のまま)', 'Value (digits as printed)'), input(numText(row, 'value'), (v) => setNum(row, 'value', v))),
      field(T('単位', 'Unit'), unitBox),
      ...['total', 'statistical', 'systematic'].map((src) => field(`± ${SOURCE_LABELS()[src]}`, input(uncText(row, src), (v) => setUnc(row, src, v)))),
      field(T('データのコメント(任意)', 'Comment of the data entry (optional)'), input('', (v) => { extra.comment = v; })),
      h('div', { class: 'field wide' }, h('label', null, T('理由(必須)', 'Reason (required)'), h('textarea', { rows: 2, oninput: (e) => { extra.reason = e.target.value; } }))));
    dialog({
      title: item ? T('修正して採用', 'Correct and adopt') : T('両方にない行を追加', 'Add a row neither input has'),
      body: form,
      confirm: T('採用する', 'Adopt'),
      onConfirm: () => {
        if (!extra.reason.trim()) { toast(T('理由を入力してください', 'Please give the reason'), 'bad'); return; }
        const decision = who(extra.reason.trim());
        adjust((adj) => (item ? ex.decide(adj, item, 'other', decision, { row, comment: extra.comment }) : ex.addRow(adj, row, decision, extra.comment)));
      },
    });
  }

  // ---- approval and registration ----------------------------------------------------------
  function approveView(s) {
    if (!ex.canCompare(s)) return [panel.el, h('p', { class: 'notice' }, T('両方の入力が提出され、判定が終わると承認できます。', 'Approval comes after both inputs are submitted and every difference is decided.'))];
    const approval = ex.approvalState(s.task, s.A, s.B, s.adjudication);
    const blockers = ex.approvalBlockers(s);
    const me = userName(ctx);
    const st = ex.stage(s);
    const adj = s.adjudication;
    const unsaved = ex.FILES.filter((n) => !saved(n));
    const ind = ex.independence(s.A, s.B);
    const own = [s.A, s.B].some((x) => x && x.extractor && x.extractor === me);
    const blockerText = {
      inputs: T('両方の入力が提出されていません。', 'Both inputs must be submitted.'),
      adjudication: T('まだ判定がありません(「比較・判定」)。', 'Nothing is decided yet (“Compare and decide”).'),
      integrity: T('判定に矛盾があります(JSON タブで確認できます)。', 'The decisions are inconsistent (see the JSON tab).'),
      open: T('判定していない違いがあります(「比較・判定」)。', 'Some differences are not decided (“Compare and decide”).'),
      source: T('入力が、タスクに記録された PDF とは別の PDF について作られています。', 'An input was made for another PDF than the one of the task.'),
      task: T('task.json がありません。', 'task.json is missing.'),
    };
    let preview = null;
    try { preview = adj ? ex.publicationPreview(s, workspace.db) : null; } catch (err) { preview = null; }
    const approveButton = h('button', { class: 'btn primary', type: 'button', disabled: blockers.length > 0 || !me || approval === 'approved', onclick: () => ask(
      T('承認', 'Approval'),
      T(`${me} として承認します。承認するのはこの内容(ハッシュ ${short(ex.contentHash(s.task, s.A, s.B, adj))}…)だけで、後で何かが変わると承認は無効になり再確認が必要になります。`,
        `Approve as ${me}? The approval holds for this content (hash ${short(ex.contentHash(s.task, s.A, s.B, adj))}…) only; any later change makes it void and needs a new approval.`),
      T('承認する', 'Approve'), () => {
        ex.approve(s, me, ex.nowIso());
        put('adjudication.json', s.adjudication, { now: true });
        toast(T('承認しました。「保存」を押すと記録されます。', 'Approved. Press “Save” to record it.'));
      }) }, approval === 'stale' ? T('承認し直す', 'Approve again') : T('承認する', 'Approve'));
    const registerButton = h('button', { class: 'btn primary', type: 'button', disabled: busy || unsaved.length > 0 || !(st === 'approved' || st === 'published'),
      onclick: () => ask(T('データに登録', 'Register in the data'), T('承認された行をデータに登録し、保存・送信します。', 'The approved rows are written into the data, saved and sent.'),
        T('登録する', 'Register'), register) },
      busy ? T('登録中…', 'Registering …') : T('データに登録', 'Register in the data'));
    return [
      panel.el,
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, T('承認', 'Approval'))),
        h('div', { class: 'card-body stack' },
          approval === 'approved' ? h('p', { class: 'notice good' }, T(`${adj.approval.by} が ${adj.approval.at} に承認しました(ハッシュ ${short(adj.approval.contentHash)}…)。`, `Approved by ${adj.approval.by} at ${adj.approval.at} (hash ${short(adj.approval.contentHash)}…).`))
            : approval === 'stale' ? h('p', { class: 'notice bad' }, T(`再確認が必要: ${adj.approval.by} が ${adj.approval.at} に承認した後に内容が変わりました。確かめて承認し直してください。`, `Re-check needed: the content changed after ${adj.approval.by} approved it at ${adj.approval.at}. Check it and approve again.`))
              : h('p', { class: 'notice warn' }, T('未承認です。A と B が一致していても、承認されるまでデータには登録できません。', 'Not approved. Even when A and B agree, nothing is registered before the approval.')),
          blockers.length ? h('ul', null, blockers.map((b) => h('li', null, blockerText[b] || b))) : null,
          ind.independent === false ? h('p', { class: 'notice warn' }, INDEPENDENCE_TEXTS()[ind.reason]) : null,
          own ? h('p', { class: 'notice warn' }, T('あなたはこのタスクの入力を作った人でもあります。', 'You also made one of the inputs of this task.')) : null,
          !me ? h('p', { class: 'notice bad' }, T('承認する人の名前が分かりません。ターミナルで pixi run login を一度実行してください。', 'The tool does not know who you are: run pixi run login once.')) : null,
          h('p', { class: 'small muted' }, T('承認は、文献(PDF の SHA-256 を含む)・登録先・2つの入力・判定の内容のハッシュに結び付けて記録されます。サーバーは、承認された内容と変わっていないことを確かめてからでないと登録しません。',
            'The approval is bound to a hash of the source (with the SHA-256 of the PDF), the target, both inputs and the decisions. The server registers nothing unless the content is still the approved one.')),
          h('div', { class: 'row' }, approveButton))),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, T('データに登録', 'Register in the data'))),
        h('div', { class: 'card-body stack' },
          preview ? h('p', null, preview.exists ? T('追加先: ', 'Added to: ') : T('新しいファイル: ', 'New file: '), h('code', null, preview.path)) : null,
          preview && preview.entries.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
            h('thead', null, h('tr', null, h('th', null, 'datasetId'), h('th', null, T('核種', 'Nuclide')), h('th', null, T('量', 'Quantity')),
              h('th', { class: 'num' }, T('値', 'Value')), h('th', null, 'Key'), h('th', null, T('コメント', 'Comment')), h('th', null, ''))),
            h('tbody', null, preview.entries.map((e) => h('tr', null, h('td', null, h('code', null, e.datasetId)),
              h('td', null, nuclideNode(e.row.nuclide.element, e.row.nuclide.mass)), h('td', null, KIND_LABELS()[e.row.kind]),
              h('td', { class: 'num mono' }, `${numText(e.row, 'value')} ${unitLabel(e.row.unit)}`, list(e.row.uncertainties).map((u) => ` ± ${numText(u, 'value')}`).join('')),
              h('td', null, e.row.conditions || ''), h('td', { class: 'small' }, e.row.comment || ''),
              h('td', null, e.status === 'clash' ? tag(T('同じ ID の行がほかから登録済み', 'an entry of this ID exists, not from this task'), 'bad')
                : e.status === 'registered' ? tag(T('このタスクから登録済み(置き換え)', 'registered from this task (replaced)'), 'good') : tag(T('新規', 'new'), 'warn'))))))) : null,
          unsaved.length ? h('p', { class: 'notice warn' }, T('このタスクに保存していない変更があります。先に保存してください。', 'This task has unsaved changes: save them first.')) : null,
          h('p', { class: 'small muted' }, T('「データに登録」を押すと、承認された行がデータセットのファイルに書き込まれ、ふだんの保存と同じチェックを通ってから保存・送信されます。登録した datasetId と承認のハッシュは task.json に記録されます。',
            'Registering writes the approved rows into the dataset file; it is checked like every save, then saved and sent. The datasetIds and the approved hash are recorded in task.json.')),
          h('div', { class: 'row' }, registerButton),
          list(s.task.publications).length ? h('div', null, h('h3', null, T('登録の記録', 'Registrations')),
            h('ul', null, s.task.publications.map((p) => h('li', { class: 'small' },
              `${p.at} · ${p.by} · ${p.path} · ${p.entries.length} ${T('行', 'entries')} · ${T('ハッシュ', 'hash')} ${short(p.contentHash)}…`)))) : null)),
    ];
  }

  async function register() {
    busy = true;
    draw();
    try {
      const r = await backend.request('POST', '/api/extraction/publish', { task: id });
      backend.pending = r.pending;
      backend.sendError = r.sent ? null : r.error || null;
      await workspace.load();
      toast(r.sent ? T(`${r.datasetIds.length} 行をデータに登録し、保存・送信しました: ${r.path}`, `Registered ${r.datasetIds.length} entries, saved and sent: ${r.path}`)
        : T(`${r.datasetIds.length} 行をデータに登録し、保存しました(このコンピュータ)。まだ送信していません。`, `Registered ${r.datasetIds.length} entries and saved them on this computer; not sent yet.`));
    } catch (err) {
      if (err instanceof InvalidError) {
        dialog({ title: workErrorText(err), body: issueList(err.issues), confirm: T('閉じる', 'Close'), onConfirm: () => {} });
      } else {
        toast(workErrorText(err), 'bad');
      }
    }
    busy = false;
    draw();
  }

  // ---- JSON ---------------------------------------------------------------------------------
  function jsonView(s) {
    const both = ex.canCompare(s);
    const editable = (name) => {
      if (name === 'task.json') return true;
      if (name === 'adjudication.json') return both;
      const slot = name === 'input-A.json' ? 'A' : 'B';
      return Boolean(s[slot]) && !ex.isSubmitted(s[slot]) && (!s[slot].extractor || s[slot].extractor === userName(ctx) || opened.has(`${id}/${slot}`));
    };
    const visible = (name) => {
      if (name === 'task.json') return true;
      if (name === 'adjudication.json') return both && s.texts[name] !== null;
      return both || editable(name);
    };
    const names = ex.FILES.filter((n) => visible(n) && (s.texts[n] !== null || n === 'task.json'));
    const holder = h('div');
    const show = (name) => {
      if (pane) { pane.pane.dispose(); pane = null; }
      const text = workspace.text(ex.taskPath(id, name)) || '';
      if (!editable(name)) {
        replace(holder, h('div', { class: 'card-head' }, h('h3', null, ex.taskPath(id, name)), h('span', { class: 'small muted' }, T('提出済みの入力は変更できません', 'A submitted input cannot be changed'))),
          h('pre', { class: 'diff pre' }, text));
        return;
      }
      const p = jsonPane(ex.taskPath(id, name), text, workspace.schemas, ex.SCHEMA_FILES);
      pane = { name, pane: p };
      replace(holder,
        h('div', { class: 'card-head' }, h('h3', null, ex.taskPath(id, name)), h('div', { class: 'row' }, p.note,
          h('button', { class: 'btn', type: 'button', onclick: () => {
            let obj;
            try { obj = jsonfmt.parse(p.value()); } catch (err) { toast(T(`JSON として読めません: ${err.message}`, `Not valid JSON: ${err.message}`), 'bad'); return; }
            workspace.stage(ex.taskPath(id, name), ex.workText(obj, workspace.schemas));
            toast(T('反映しました(まだ保存されていません)', 'Applied (not saved yet)'));
            show(name);
            panel.refresh();
          } }, T('反映', 'Apply')))),
        p.el);
    };
    const el = [panel.el, h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, T('ファイルを直接編集', 'Edit the files directly')),
        h('div', { class: 'row' }, names.map((n) => h('button', { class: 'btn', type: 'button', onclick: () => show(n) }, n)))),
      h('div', { class: 'card-body small muted' }, T('両方の入力が提出されるまで、もう一方の入力のファイルはここにも表示されません。提出済みの入力・AI の記録・登録の記録は、保存のときにサーバーが変更を受け付けません。',
        'Until both inputs are submitted, the other input is not listed here either. Changes to submitted inputs, AI records and registration records are refused by the server when saving.')),
      holder)];
    setTimeout(() => { if (root.isConnected && !pane) show('task.json'); }, 0);
    return el;
  }

  replace(root, head, body);
  draw();
  return {
    flush,
    destroy() {
      flush();
      if (pane) pane.pane.dispose();
    },
  };
}
