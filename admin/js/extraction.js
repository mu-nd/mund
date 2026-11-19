// The extraction work area (docs/extraction.ja.md) without the page: reading a
// task, comparing input A with input B, building the adjudication, the content
// hash an approval is bound to, and the entries a publication writes.  No DOM:
// the tests import this module.
//
// Twin of tools/mundlib/extraction.py for contentHash, coverageItems,
// adjudicationProblems and approvalState (the server decides with its own copy;
// tests/vectors/extraction.json keeps the two in agreement).  The matching and
// comparison of rows is only here: the server checks that what is adopted is
// what the inputs say, not how the rows were paired.

import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import * as schemaMod from '../../site/assets/js/core/schema.js';
import { sha256 } from '../../site/assets/js/core/sha256.js';
import { assignIds, filePath, expectedMetaId } from '../../site/assets/js/core/database.js';
import { CODE_OF } from '../../site/assets/js/core/vocabulary.js';

export const WORK_DIR = 'extraction';
export const SLOTS = ['A', 'B'];
export const MODES = ['human', 'ai', 'assisted'];
export const FORMATS = {
  'task.json': 'muND/extraction-task/1',
  'input-A.json': 'muND/extraction-input/1',
  'input-B.json': 'muND/extraction-input/1',
  'adjudication.json': 'muND/extraction-adjudication/1',
};
export const FILES = Object.keys(FORMATS);
// file "format" -> schema file in schema/v1
export const SCHEMA_FILES = {
  'muND/extraction-task/1': 'extraction-task.schema.json',
  'muND/extraction-input/1': 'extraction-input.schema.json',
  'muND/extraction-adjudication/1': 'extraction-adjudication.schema.json',
};
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WORK_FILE_RE = /^extraction\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(task|input-A|input-B|adjudication)\.json$/;
/** What a row says; compared and adopted (not id, needsCheck, notes). */
export const CONTENT_KEYS = ['location', 'nuclide', 'kind', 'conditions', 'original', 'value', 'unit', 'uncertainties'];
export const KINDS = ['lifetime', 'capture_rate', 'capture_probability'];
export const UNITS = { lifetime: ['ns', 'us'], capture_rate: ['us-1', 'ms-1', 's-1'], capture_probability: ['%'] };
export const SOURCES = ['total', 'statistical', 'systematic', 'other'];
const AGREED_COVERAGE = ['covered', 'no-data'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const trim = (v) => (typeof v === 'string' ? v.trim() : '');

export const taskPath = (id, name) => `${WORK_DIR}/${id}/${name}`;
export const inputName = (slot) => `input-${slot}.json`;

/** { task, name } of a file of the work area, else null. */
export function workFile(path) {
  const m = WORK_FILE_RE.exec(path);
  return m ? { task: m[1], name: `${m[2]}.json` } : null;
}

/** The tasks among `paths`, sorted. */
export function taskIds(paths) {
  return [...new Set(paths.map(workFile).filter(Boolean).map((f) => f.task))].sort();
}

/** Time stamps of decisions and submissions: ISO 8601 in UTC, to the second. */
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The files of a task: { id, texts: {name: text|null}, task, A, B, adjudication }
 * (a file that is missing or not JSON is null).  `textOf(path)` gives the current text.
 */
export function readTask(textOf, id) {
  const parse = (text) => {
    if (typeof text !== 'string') return null;
    try {
      const obj = jsonfmt.parse(text);
      return isObject(obj) ? obj : null;
    } catch (err) {
      return null;
    }
  };
  const texts = Object.fromEntries(FILES.map((name) => [name, textOf(taskPath(id, name))]));
  return {
    id, texts, task: parse(texts['task.json']), A: parse(texts['input-A.json']), B: parse(texts['input-B.json']),
    adjudication: parse(texts['adjudication.json']),
  };
}

/** Canonical text of a file of the work area (members in schema order, empty optional ones dropped). */
export function workText(obj, schemas) {
  const name = SCHEMA_FILES[isObject(obj) ? obj.format : null];
  const schema = name && schemas ? schemas[name] : null;
  return jsonfmt.stringify(schema ? schemaMod.normalize(obj, schema) : obj);
}

/** Schema problems of a file of the work area: [{ pointer, message }]. */
export function schemaProblems(obj, schemas) {
  const name = SCHEMA_FILES[isObject(obj) ? obj.format : null];
  const schema = name && schemas ? schemas[name] : null;
  return schema ? schemaMod.validate(obj, schema).map((e) => ({ pointer: e.pointer, message: e.message })) : [];
}

export const isSubmitted = (input) => isObject(input) && isObject(input.submitted);

// ---------------------------------------------------------------------------
// hashes (twin of extraction.py)
// ---------------------------------------------------------------------------

/** SHA-256 of the compact text of a value (sorted keys, numbers as written). */
export const hashOf = (value) => sha256(jsonfmt.compact(value === undefined ? null : value));

/**
 * The hash an approval is bound to: source (with the SHA-256 of the PDF), target,
 * both inputs as saved, and the adjudication without its approval.
 */
export function contentHash(task, a, b, adjudication) {
  const t = isObject(task) ? task : {};
  const j = isObject(adjudication) ? adjudication : {};
  return hashOf({
    task: t.id ?? null,
    source: t.source ?? null,
    target: t.target ?? null,
    inputs: { A: hashOf(a ?? null), B: hashOf(b ?? null) },
    rows: list(j.rows),
    excluded: list(j.excluded),
    coverage: list(j.coverage),
  });
}

/** The members of a row that are compared and adopted, copied with the written form of numbers. */
export function rowContent(row) {
  const out = {};
  copyMembers(row, out, CONTENT_KEYS);
  return out;
}

function copyMembers(from, to, keys) {
  for (const key of keys) {
    if (!isObject(from) || !Object.prototype.hasOwnProperty.call(from, key)) continue;
    to[key] = jsonfmt.clone(from[key]);
    const lex = jsonfmt.getLexeme(from, key);
    if (lex !== undefined) jsonfmt.setLexeme(to, key, lex);
  }
  return to;
}

/** Exactly the same content: equal members, numbers with the same written digits. */
export const sameContent = (x, y) => jsonfmt.compact(rowContent(x)) === jsonfmt.compact(rowContent(y));

// ---------------------------------------------------------------------------
// numbers: the written value and the value after unit conversion
// ---------------------------------------------------------------------------

/** Powers of ten that take a unit to the common unit of its quantity (ns, us-1, %). */
export const UNIT_SHIFT = { ns: 0, us: 3, 'us-1': 0, 'ms-1': -3, 's-1': -6, '%': 0 };
export const COMMON_UNIT = { lifetime: 'ns', capture_rate: 'us-1', capture_probability: '%' };
const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** A written number as sign, digits and the power of ten of its last digit; null if it is not a number. */
export function parseDecimal(text) {
  const m = DECIMAL_RE.exec(String(text).trim());
  if (!m) return null;
  const digits = (m[2] + (m[3] || '')).replace(/^0+(?=\d)/, '');
  return { sign: m[1] === '-' && /[1-9]/.test(digits) ? -1 : 1, digits, exp: Number(m[4] || 0) - (m[3] || '').length };
}

function decimalText(sign, digits, exp) {
  let s;
  if (exp >= 0) {
    s = /^0+$/.test(digits) ? '0' : digits + '0'.repeat(exp);
  } else {
    const padded = digits.padStart(-exp + 1, '0');
    s = `${padded.slice(0, padded.length + exp)}.${padded.slice(padded.length + exp)}`;
  }
  return (sign < 0 ? '-' : '') + s;
}

/**
 * A written number in the common unit, exactly (units differ by powers of ten):
 * { text, key, exp }.  `key` is equal for equal values ("880" ns and "0.880" us);
 * `exp` is the place of the last written digit (it differs for "880" and "880.0").
 */
export function converted(text, unit) {
  const d = text === null || text === undefined ? null : parseDecimal(text);
  if (!d || !Object.prototype.hasOwnProperty.call(UNIT_SHIFT, unit)) return null;
  const exp = d.exp + UNIT_SHIFT[unit];
  let digits = d.digits;
  let e = exp;
  if (/^0+$/.test(digits)) {
    digits = '0';
    e = 0;
  } else {
    while (digits.endsWith('0')) { digits = digits.slice(0, -1); e++; }
  }
  return { text: decimalText(d.sign, d.digits, exp), key: `${d.sign < 0 && digits !== '0' ? '-' : ''}${digits}e${e}`, exp };
}

/** The written form of obj[key] when it is a number, else null. */
export const numberText = (obj, key) => (isObject(obj) && typeof obj[key] === 'number' ? jsonfmt.numberText(obj, key) : null);

/**
 * Compare two written quantities.  status:
 *   same      same text, same unit
 *   unit      same value after conversion, written in another unit with the same digits ("0.880 us" / "880 ns")
 *   notation  same value, unit and digits, written differently ("8.80e2" / "880")
 *   digits    same value, another number of digits ("880" / "880.0")
 *   value     different values
 *   missing   one or both sides have none
 * No tolerance and no rounding: values are equal only when they are exactly equal.
 */
export function compareQuantity(ta, ua, tb, ub) {
  if (ta === null || tb === null || ua === undefined || ub === undefined) {
    return { status: ta === null && tb === null && ua === ub ? 'same' : 'missing', a: null, b: null, unitDiffers: ua !== ub };
  }
  const ca = converted(ta, ua);
  const cb = converted(tb, ub);
  const unitDiffers = ua !== ub;
  let status;
  if (ta === tb && !unitDiffers) status = 'same';
  else if (!ca || !cb || ca.key !== cb.key) status = 'value';
  else if (ca.exp !== cb.exp) status = 'digits';
  else if (unitDiffers) status = 'unit';
  else status = 'notation';
  return { status, a: ca, b: cb, unitDiffers };
}

// ---------------------------------------------------------------------------
// matching and comparing rows
// ---------------------------------------------------------------------------

/** Rows match by nuclide (element and mass: natural = 0 differs from any isotope), quantity and conditions. */
export function matchKey(row) {
  const n = isObject(row.nuclide) ? row.nuclide : null;
  if (!n || typeof n.element !== 'string' || typeof n.mass !== 'number') return null;
  return JSON.stringify([n.element, n.mass, row.kind, trim(row.conditions)]);
}

/** Where a row is printed; it decides between several rows of one key. */
export function locationKey(row) {
  const l = isObject(row.location) ? row.location : {};
  return JSON.stringify([trim(l.page), trim(l.item), trim(l.label)]);
}

/**
 * Pair the rows of A and B - never by their order in the lists:
 *   1. rows with the same key and the same location (unique on both sides);
 *   2. of the rows of a key left over, one of A with one of B ("located": false);
 *   3. everything else stays alone (only in A / only in B).
 * Returns [{ a, b, located }] in the order of A's rows, then B's rows only in B.
 */
export function matchRows(rowsA, rowsB) {
  const groups = new Map();
  const loose = [];
  for (const [side, rows] of [['a', rowsA], ['b', rowsB]]) {
    for (const row of list(rows).filter(isObject)) {
      const key = matchKey(row);
      if (key === null) { loose.push({ [side]: row }); continue; }
      if (!groups.has(key)) groups.set(key, { a: [], b: [] });
      groups.get(key)[side].push(row);
    }
  }
  const found = [];
  for (const group of groups.values()) {
    let A = group.a.slice();
    let B = group.b.slice();
    for (const a of group.a) {
      const where = locationKey(a);
      const sameA = A.filter((x) => locationKey(x) === where);
      const sameB = B.filter((x) => locationKey(x) === where);
      if (sameA.length === 1 && sameA[0] === a && sameB.length === 1) {
        found.push({ a, b: sameB[0], located: true });
        A = A.filter((x) => x !== a);
        B = B.filter((x) => x !== sameB[0]);
      }
    }
    if (A.length === 1 && B.length === 1) {
      found.push({ a: A[0], b: B[0], located: false });
      A = [];
      B = [];
    }
    for (const a of A) found.push({ a, b: null, located: false });
    for (const b of B) found.push({ a: null, b, located: false });
  }
  for (const x of loose) found.push({ a: x.a || null, b: x.b || null, located: false });
  const order = new Map(list(rowsA).map((r, i) => [r, i]));
  const orderB = new Map(list(rowsB).map((r, i) => [r, i]));
  const rank = (m) => (m.a ? order.get(m.a) : list(rowsA).length + orderB.get(m.b));
  return found.sort((x, y) => rank(x) - rank(y));
}

/**
 * Differences of two paired rows: [{ field, ... }], field one of
 *   location (parts: page/item/label), original (parts: value/unit/uncertainty),
 *   value (status of compareQuantity), uncertainty (source, status), needsCheck (sides), order.
 * The written notation (original) and the value after conversion are compared separately.
 */
export function compareRows(a, b) {
  const diffs = [];
  const la = isObject(a.location) ? a.location : {};
  const lb = isObject(b.location) ? b.location : {};
  const locParts = ['page', 'item', 'label'].filter((k) => trim(la[k]) !== trim(lb[k]));
  if (locParts.length) diffs.push({ field: 'location', parts: locParts });
  const oa = isObject(a.original) ? a.original : {};
  const ob = isObject(b.original) ? b.original : {};
  const origParts = ['value', 'unit', 'uncertainty'].filter((k) => trim(oa[k]) !== trim(ob[k]));
  if (origParts.length) diffs.push({ field: 'original', parts: origParts });
  const value = compareQuantity(numberText(a, 'value'), a.unit, numberText(b, 'value'), b.unit);
  if (value.status !== 'same') diffs.push({ field: 'value', ...value });
  const ua = list(a.uncertainties).filter(isObject);
  const ub = list(b.uncertainties).filter(isObject);
  for (const source of SOURCES) {
    const x = ua.find((u) => u.source === source);
    const y = ub.find((u) => u.source === source);
    if (!x && !y) continue;
    const c = compareQuantity(x ? numberText(x, 'value') : null, a.unit, y ? numberText(y, 'value') : null, b.unit);
    if (c.status !== 'same') diffs.push({ field: 'uncertainty', source, ...c });
  }
  const flagged = ['a', 'b'].filter((s) => trim((s === 'a' ? a : b).needsCheck));
  if (flagged.length) diffs.push({ field: 'needsCheck', sides: flagged });
  if (!diffs.length && !sameContent(a, b)) diffs.push({ field: 'order' });
  return diffs;
}

/** For a row without partner: rows of the other side that may be meant (same element, something else differs). */
function hints(row, others) {
  const n = isObject(row.nuclide) ? row.nuclide : null;
  if (!n) return [];
  return others.filter((o) => isObject(o.nuclide) && o.nuclide.element === n.element).map((o) => {
    const why = [];
    if (o.nuclide.mass !== n.mass) why.push(o.nuclide.mass === 0 || n.mass === 0 ? 'natural' : 'mass');
    if (o.kind !== row.kind) why.push('kind');
    if (trim(o.conditions) !== trim(row.conditions)) why.push('conditions');
    return { row: o, why };
  }).filter((x) => x.why.length);
}

/** Labels of the source items: the task's, then those only the inputs name (coverage, rows). */
export function coverageItems(task, a, b) {
  const labels = [];
  const add = (label) => { if (typeof label === 'string' && label && !labels.includes(label)) labels.push(label); };
  for (const item of list(isObject(task) && isObject(task.source) ? task.source.items : [])) add(isObject(item) ? item.label : null);
  for (const inp of [a, b]) for (const c of list(isObject(inp) ? inp.coverage : [])) add(isObject(c) ? c.item : null);
  for (const inp of [a, b]) {
    for (const row of list(isObject(inp) ? inp.rows : [])) add(isObject(row) && isObject(row.location) ? row.location.item : null);
  }
  return labels;
}

export function coverageStatus(input, label) {
  const c = list(isObject(input) ? input.coverage : []).find((x) => isObject(x) && x.item === label);
  return c ? c.status : null;
}

/**
 * Which pairs of inputs are independent (shown with the comparison, recorded in the
 * approved content through the inputs): two inputs neither of which can have been
 * influenced by the other or by a common AI output -
 *   human + human (two different people), human + ai, human + assisted.
 * Not independent: ai + ai, ai + assisted, assisted + assisted (AI output on both
 * sides; an assisted input is not independent of AI output), and two inputs of the
 * same person.
 */
export function independence(a, b) {
  if (!isObject(a) || !isObject(b)) return { independent: null, reason: 'incomplete' };
  const aiLike = (m) => m === 'ai' || m === 'assisted';
  const pair = [a.mode, b.mode].sort().join('+');
  if (aiLike(a.mode) && aiLike(b.mode)) return { independent: false, reason: 'both-ai', pair };
  const person = (x) => (x.mode !== 'ai' ? trim(x.extractor) : '');
  if (person(a) && person(a) === person(b)) return { independent: false, reason: 'same-person', pair };
  return { independent: true, reason: pair, pair };
}

/**
 * The comparison of a task whose inputs are both submitted:
 *   items     [{ ref: {a, b}, a, b, located, diffs, agreed, hints }]
 *   coverage  [{ item, a, b, agreed, rowsA, rowsB }]
 *   independence
 */
export function compare(task, a, b) {
  const rowsA = list(isObject(a) ? a.rows : []).filter(isObject);
  const rowsB = list(isObject(b) ? b.rows : []).filter(isObject);
  const matched = matchRows(rowsA, rowsB);
  const aloneA = matched.filter((m) => m.a && !m.b).map((m) => m.a);
  const aloneB = matched.filter((m) => m.b && !m.a).map((m) => m.b);
  const items = matched.map((m) => {
    const ref = { a: m.a ? m.a.id : null, b: m.b ? m.b.id : null };
    if (m.a && m.b) {
      const diffs = compareRows(m.a, m.b);
      return { ref, a: m.a, b: m.b, located: m.located, diffs, agreed: diffs.length === 0, hints: [] };
    }
    return {
      ref, a: m.a, b: m.b, located: false, diffs: [{ field: m.a ? 'onlyA' : 'onlyB' }], agreed: false,
      hints: m.a ? hints(m.a, aloneB) : hints(m.b, aloneA),
    };
  });
  const count = (rows, label) => rows.filter((r) => isObject(r.location) && r.location.item === label).length;
  const coverage = coverageItems(task, a, b).map((item) => {
    const sa = coverageStatus(a, item);
    const sb = coverageStatus(b, item);
    return { item, a: sa, b: sb, agreed: sa === sb && AGREED_COVERAGE.includes(sa), rowsA: count(rowsA, item), rowsB: count(rowsB, item) };
  });
  return { items, coverage, independence: independence(a, b) };
}

// ---------------------------------------------------------------------------
// adjudication
// ---------------------------------------------------------------------------

const sameRef = (x, ref) => (x.a ?? null) === (ref.a ?? null) && (x.b ?? null) === (ref.b ?? null);
export const refKey = (ref) => `${ref.a ?? ''}|${ref.b ?? ''}`;

export function newAdjudication(taskId) {
  return { format: FORMATS['adjudication.json'], task: taskId, rows: [] };
}

/** How a comparison item is decided: { kind: 'row', row } | { kind: 'excluded', entry } | null. */
export function decisionOf(adj, ref) {
  const row = list(isObject(adj) ? adj.rows : []).find((r) => isObject(r) && sameRef(r, ref));
  if (row) return { kind: 'row', row };
  const entry = list(isObject(adj) ? adj.excluded : []).find((e) => isObject(e) && sameRef(e, ref));
  return entry ? { kind: 'excluded', entry } : null;
}

function nextFinalId(adj) {
  const used = new Set(list(adj.rows).map((r) => r && r.id));
  let n = 1;
  while (used.has(`f${n}`)) n++;
  return `f${n}`;
}

/** Remove the decision on a comparison item. */
export function undecide(adj, ref) {
  adj.rows = list(adj.rows).filter((r) => !sameRef(r, ref));
  adj.excluded = list(adj.excluded).filter((e) => !sameRef(e, ref));
  return adj;
}

/**
 * Decide a comparison item: adopt 'A', 'B', 'other' (`row`: the corrected content), or
 * 'none' (not adopted).  `who`: { reason, by, at }; `comment`: the comment of the published entry.
 */
export function decide(adj, item, choice, who, { row = null, comment = '' } = {}) {
  const ref = { a: item.ref.a ?? null, b: item.ref.b ?? null };
  const place = list(adj.rows).findIndex((r) => sameRef(r, ref));
  const previous = place >= 0 ? adj.rows[place] : null;
  undecide(adj, ref);
  if (choice === 'none') {
    adj.excluded = list(adj.excluded).concat([{ ...refMembers(ref), reason: who.reason, by: who.by, at: who.at }]);
    return adj;
  }
  const source = choice === 'A' || choice === 'agreed' ? item.a : choice === 'B' ? item.b : row;
  if (!isObject(source)) throw new Error(`nothing to adopt from ${choice}`);
  const out = { id: previous ? previous.id : nextFinalId(adj), ...refMembers(ref), adopted: choice };
  copyMembers(source, out, CONTENT_KEYS);
  if (trim(comment)) out.comment = comment;
  if (choice !== 'agreed') Object.assign(out, { reason: who.reason, by: who.by, at: who.at });
  if (place >= 0) adj.rows.splice(Math.min(place, adj.rows.length), 0, out); else adj.rows.push(out);
  return adj;
}

function refMembers(ref) {
  const out = {};
  if (ref.a) out.a = ref.a;
  if (ref.b) out.b = ref.b;
  return out;
}

/** Adopt a row that neither input has (adopted 'other', no a / b). */
export function addRow(adj, row, who, comment = '') {
  const out = { id: nextFinalId(adj), adopted: 'other' };
  copyMembers(row, out, CONTENT_KEYS);
  if (trim(comment)) out.comment = comment;
  Object.assign(out, { reason: who.reason, by: who.by, at: who.at });
  adj.rows = list(adj.rows).concat([out]);
  return adj;
}

/** Remove an adopted row by its id. */
export function removeRow(adj, id) {
  adj.rows = list(adj.rows).filter((r) => r.id !== id);
  return adj;
}

/** Add an 'agreed' row for every identical pair that has no decision yet. */
export function withAgreed(adj, comparison) {
  for (const item of comparison.items) {
    if (item.agreed && !decisionOf(adj, item.ref)) decide(adj, item, 'agreed', {});
  }
  return adj;
}

/** Decide a source item the inputs marked differently ('' status: remove the decision). */
export function decideCoverage(adj, item, status, who) {
  adj.coverage = list(adj.coverage).filter((c) => c.item !== item);
  if (status) adj.coverage.push({ item, status, reason: who.reason, by: who.by, at: who.at });
  return adj;
}

/**
 * (twin of extraction.adjudication_problems) { integrity, open }: [{ pointer, code, message }]
 *   integrity  wrong at any time (a reference to no row, a row used twice, an 'agreed' row
 *              whose inputs differ, an adopted row that is not the row of the input)
 *   open       not decided yet (rows of the inputs, source items marked differently)
 */
export function adjudicationProblems(task, a, b, adj) {
  const integrity = [];
  const open = [];
  const rows = {
    a: new Map(list(isObject(a) ? a.rows : []).filter(isObject).map((r) => [r.id, r])),
    b: new Map(list(isObject(b) ? b.rows : []).filter(isObject).map((r) => [r.id, r])),
  };
  const used = { a: new Map(), b: new Map() };
  const refer = (pointer, entry) => {
    const found = {};
    for (const side of ['a', 'b']) {
      const rid = entry[side];
      if (rid === undefined || rid === null) continue;
      if (!rows[side].has(rid)) {
        integrity.push({ pointer: `${pointer}/${side}`, code: 'E_ADJ_REFERENCE', message: `input ${side.toUpperCase()} has no row '${rid}'` });
        continue;
      }
      used[side].set(rid, (used[side].get(rid) || 0) + 1);
      found[side] = rows[side].get(rid);
    }
    return found;
  };
  const ids = new Set();
  list(isObject(adj) ? adj.rows : []).forEach((row, i) => {
    if (!isObject(row)) return;
    const pointer = `/rows/${i}`;
    if (ids.has(row.id)) integrity.push({ pointer: `${pointer}/id`, code: 'E_ADJ_ROW_ID', message: `row id '${row.id}' is used twice` });
    ids.add(row.id);
    const found = refer(pointer, row);
    if (row.adopted === 'agreed') {
      const ra = found.a;
      const rb = found.b;
      if (!ra || !rb) {
        integrity.push({ pointer, code: 'E_ADJ_AGREED', message: 'an agreed row names a row of A and a row of B' });
      } else if ('needsCheck' in ra || 'needsCheck' in rb || !sameContent(ra, rb) || !sameContent(ra, row)) {
        integrity.push({ pointer, code: 'E_ADJ_AGREED', message: 'the rows of A and B are not identical (or are marked for checking): the row needs a decision' });
      }
    } else if (row.adopted === 'A' || row.adopted === 'B') {
      const source = found[row.adopted.toLowerCase()];
      if (!source) {
        integrity.push({ pointer, code: 'E_ADJ_ADOPTED', message: `the row adopted from ${row.adopted} names no row of ${row.adopted}` });
      } else if (!sameContent(source, row)) {
        integrity.push({ pointer, code: 'E_ADJ_ADOPTED', message: `the row differs from row '${source.id}' of input ${row.adopted}: a changed row is adopted as 'other'` });
      }
    }
  });
  list(isObject(adj) ? adj.excluded : []).forEach((entry, j) => {
    if (!isObject(entry)) return;
    if ((entry.a ?? null) === null && (entry.b ?? null) === null) {
      integrity.push({ pointer: `/excluded/${j}`, code: 'E_ADJ_REFERENCE', message: 'names no row' });
    }
    refer(`/excluded/${j}`, entry);
  });
  for (const side of ['a', 'b']) {
    for (const rid of rows[side].keys()) {
      const n = used[side].get(rid) || 0;
      if (n > 1) integrity.push({ pointer: '', code: 'E_ADJ_TWICE', message: `row '${rid}' of input ${side.toUpperCase()} is decided ${n} times` });
      else if (n === 0) open.push({ pointer: '', code: 'OPEN_ROW', message: `row '${rid}' of input ${side.toUpperCase()} is not decided`, side, id: rid });
    }
  }
  const decided = new Set(list(isObject(adj) ? adj.coverage : []).map((c) => isObject(c) && c.item));
  for (const label of coverageItems(task, a, b)) {
    const sa = coverageStatus(a, label);
    const sb = coverageStatus(b, label);
    if (!(sa === sb && AGREED_COVERAGE.includes(sa)) && !decided.has(label)) {
      open.push({ pointer: '', code: 'OPEN_ITEM', message: `source item '${label}' is marked ${sa || 'nothing'} by A and ${sb || 'nothing'} by B`, item: label });
    }
  }
  return { integrity, open };
}

/** 'none' (not approved), 'approved', or 'stale' (changed after the approval: 再確認が必要). */
export function approvalState(task, a, b, adj) {
  const approval = isObject(adj) ? adj.approval : null;
  if (!isObject(approval)) return 'none';
  return approval.contentHash === contentHash(task, a, b, adj) ? 'approved' : 'stale';
}

/** What still keeps a task from being approved (texts); empty when it can be approved. */
export function approvalBlockers(state) {
  const { task, A, B, adjudication } = state;
  const out = [];
  if (!isObject(task)) out.push('task');
  if (!isSubmitted(A) || !isSubmitted(B)) out.push('inputs');
  if (!isObject(adjudication)) out.push('adjudication');
  else {
    const p = adjudicationProblems(task, A, B, adjudication);
    if (p.integrity.length) out.push('integrity');
    if (p.open.length) out.push('open');
  }
  for (const slot of SLOTS) {
    if (isObject(state[slot]) && isObject(task) && isObject(task.source) && state[slot].sourceSha256 !== task.source.sha256) out.push('source');
  }
  return [...new Set(out)];
}

/** Record the approval of `by` for the content as it is now. */
export function approve(state, by, at) {
  const adj = state.adjudication;
  adj.approval = { by, at, contentHash: contentHash(state.task, state.A, state.B, adj) };
  return adj;
}

// ---------------------------------------------------------------------------
// inputs, blind display, stages
// ---------------------------------------------------------------------------

/**
 * Whether the content of input `slot` may be shown.  Each input is blind: before
 * both are submitted, an input is shown only in its own editing view and only
 * while it is not submitted; once both are submitted, both are shown.
 */
export function canShowInput(state, slot, { editing = false } = {}) {
  const input = state[slot];
  if (!isObject(input)) return false;
  if (isSubmitted(state.A) && isSubmitted(state.B)) return true;
  return editing && !isSubmitted(input);
}

export const canCompare = (state) => isSubmitted(state.A) && isSubmitted(state.B);

/** The step a task is at: inputs | compare | approved | stale | published. */
export function stage(state) {
  if (!canCompare(state)) return 'inputs';
  const approval = approvalState(state.task, state.A, state.B, state.adjudication);
  if (approval === 'stale') return 'stale';
  if (approval !== 'approved') return 'compare';
  const pubs = list(isObject(state.task) ? state.task.publications : []);
  const hash = state.adjudication.approval.contentHash;
  return pubs.some((p) => isObject(p) && p.contentHash === hash) ? 'published' : 'approved';
}

export function newTask({ id, bibId, version, sha256: hash, size, datasetType = 'experiment', key = '', facility = '' }) {
  const target = { sublibrary: 'LT', datasetType };
  if (trim(key)) target.key = trim(key);
  if (trim(facility) && datasetType === 'experiment') target.facility = trim(facility);
  return { format: FORMATS['task.json'], id, source: { bibId, version, sha256: hash, size, items: [] }, target };
}

export function newInput(task, slot, mode, extractor) {
  const input = { format: FORMATS[inputName(slot)], task: task.id, slot, mode, sourceSha256: task.source.sha256, coverage: [], rows: [] };
  if (mode !== 'ai') input.extractor = extractor;
  return input;
}

export function nextRowId(rows) {
  const used = new Set(list(rows).map((r) => r && r.id));
  let n = 1;
  while (used.has(`r${n}`)) n++;
  return `r${n}`;
}

export function newRow(rows, { item = '', page = '' } = {}) {
  const location = { item };
  if (page) location.page = page;
  return { id: nextRowId(rows), location, kind: 'lifetime', original: {}, unit: 'ns', uncertainties: [] };
}

/** Mark a source item in an input ('' removes the mark). */
export function setCoverage(input, item, status) {
  input.coverage = list(input.coverage).filter((c) => c.item !== item);
  if (status) input.coverage.push({ item, status });
  return input;
}

/** Why an input cannot be submitted yet (codes); empty when it can. */
export function submissionProblems(task, input, schemas) {
  const out = [];
  if (!isObject(task) || !isObject(input)) return ['missing'];
  const marked = new Set(list(input.coverage).map((c) => c.item));
  if (list(task.source && task.source.items).some((i) => !marked.has(i.label))) out.push('coverage');
  if (input.sourceSha256 !== task.source.sha256) out.push('source');
  if (schemas && schemaProblems(input, schemas).length) out.push('schema');
  const ids = list(input.rows).map((r) => r && r.id);
  if (new Set(ids).size !== ids.length) out.push('ids');
  return out;
}

// ---------------------------------------------------------------------------
// publication
// ---------------------------------------------------------------------------

/** The data entry an adopted row becomes (twin of extraction._entry). */
export function entryOf(row) {
  const block = {};
  copyMembers(row, block, ['value', 'unit']);
  block.uncertainties = jsonfmt.clone(list(row.uncertainties));
  const entry = { nuclide: { element: row.nuclide.element, mass: row.nuclide.mass, isomer: 0 }, observable: { kind: row.kind, [row.kind]: block } };
  if (trim(row.conditions)) entry.key = row.conditions;
  if (trim(row.comment)) entry.comment = row.comment;
  return entry;
}

/**
 * What a publication would write, for display: { path, exists, entries: [{ row, entry, datasetId, status }] }.
 * status: 'new'; 'registered' (written by an earlier publication of this task: it is
 * replaced); 'clash' (the data file holds that datasetId from elsewhere: refused).
 * The server decides.
 */
export function publicationPreview(state, db) {
  const { task, adjudication } = state;
  const target = task.target;
  const code = CODE_OF[target.datasetType];
  const doc = { format: 'muND/LT/1', sublibrary: 'LT', datasetType: target.datasetType, meta: { id: '', bibId: task.source.bibId }, data: [] };
  if (target.key) doc.meta.key = target.key;
  const rows = list(adjudication && adjudication.rows).filter((r) => isObject(r) && isObject(r.nuclide));
  doc.data = rows.map(entryOf);
  assignIds(doc);
  const mid = expectedMetaId(doc);
  const existing = db.sortedFiles().find((f) => f.code === code && f.meta.id === mid);
  const ids = new Set(existing ? existing.data.map((e) => e.datasetId) : []);
  const path = existing ? existing.path : filePath(doc, db.reference(task.source.bibId));
  const registered = new Set(list(task.publications).filter((p) => isObject(p) && p.path === path)
    .flatMap((p) => list(p.entries).map((e) => e.datasetId)));
  const status = (did) => (!ids.has(did) ? 'new' : registered.has(did) ? 'registered' : 'clash');
  return {
    path,
    exists: Boolean(existing),
    entries: rows.map((row, i) => ({ row, entry: doc.data[i], datasetId: doc.data[i].datasetId, status: status(doc.data[i].datasetId) })),
  };
}
