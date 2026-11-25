// Operations on a dataset document - the parsed content of one file of a
// sub-library - as the editor performs them, and the editor's document itself
// (Draft).  No DOM: the tests import this module.
//
// A data entry has the shape described in docs/data-format.md:
//   { datasetId, nuclide: { element, mass, isomer },
//     observable: { kind, [kind]: { value, unit, uncertainties: [{ source, value }] } },
//     key?, comment?, originalData?: [{ datasetId, entryHash }], legacyIds? }
//
// A document is edited as it is: opening it adds, replaces or drops nothing,
// so whatever does not fit the format (an unknown unit, a missing member)
// reaches the checks unchanged.  Defaults are used only for what is created
// here (newDocument, newEntry).

import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import { isObject, isNumberLexeme } from '../../site/assets/js/core/jsonfmt.js';
import { normalizeElement } from '../../site/assets/js/core/ids.js';
import { TYPE_OF } from '../../site/assets/js/core/vocabulary.js';
import { MASTER_DIR, entryHash, isDataFilePath, expectedMetaId, filePath, assignIds } from '../../site/assets/js/core/database.js';
import { canonicalText } from '../../site/assets/js/core/schema.js';
import { KINDS, unitsOf } from '../../site/assets/js/core/convert.js';
import { bibKind, isBibId } from '../../site/assets/js/core/cite.js';

/** Order of the uncertainty components in an entry. */
const SOURCE_ORDER = ['total', 'statistical', 'systematic', 'other'];

const dataOf = (doc) => (isObject(doc) && Array.isArray(doc.data) ? doc.data : []);
const idOf = (entry) => (isObject(entry) && typeof entry.datasetId === 'string' ? entry.datasetId : null);
const legacyOf = (entry) => (isObject(entry) && Array.isArray(entry.legacyIds) ? entry.legacyIds.filter((id) => typeof id === 'string') : []);
const push = (map, key, value) => map.set(key, [...(map.get(key) || []), value]);

export function newDocument(code) {
  return { format: 'muND/LT/1', sublibrary: 'LT', datasetType: TYPE_OF[code], meta: { id: '', bibId: '' }, data: [] };
}

export function newEntry(element, mass, kind, unit) {
  return { nuclide: { element, mass, isomer: 0 }, observable: { kind, [kind]: { unit, uncertainties: [] } } };
}

/** Why the form cannot show `doc` (null: it can): `meta` must be an object and `data` a list. */
export function formProblem(doc) {
  if (!isObject(doc.meta)) return 'meta';
  if (!Array.isArray(doc.data)) return 'data';
  return null;
}

/**
 * Why the data grid cannot edit an entry (null: it can): 'entry' (not an
 * object), 'nuclide', 'observable', 'kind' (not a known quantity) or 'value'
 * (no value block for the kind).  Such an entry is shown as it is and
 * corrected in the JSON tab.
 */
export function gridProblem(entry) {
  if (!isObject(entry)) return 'entry';
  if (!isObject(entry.nuclide)) return 'nuclide';
  if (!isObject(entry.observable)) return 'observable';
  if (!KINDS.includes(entry.observable.kind)) return 'kind';
  if (!isObject(entry.observable[entry.observable.kind])) return 'value';
  return null;
}

/** The kinds offered for this dataset, including the current kind of a row needing correction. */
export function kindChoices(code, current) {
  if (code !== 'CUR' && code !== 'EVAL') return KINDS;
  return KINDS.includes(current) && current !== 'capture_rate' ? ['capture_rate', current] : ['capture_rate'];
}

/** The units offered for a value block: those of the kind, and first the block's own unit if it is not one of them. */
export function unitChoices(kind, unit) {
  const known = unitsOf(kind);
  return known.includes(unit) ? known : [unit === undefined || unit === null ? '' : String(unit), ...known];
}

/** Change the datasetType and drop the members that the new type does not allow. */
export function setDatasetType(doc, code) {
  doc.datasetType = TYPE_OF[code];
  if (code !== 'EXP') for (const key of ['facility', 'beam', 'target', 'detector']) delete doc.meta[key];
  if (code !== 'EVAL') delete doc.meta.referenceDatabase;
  if (code === 'EXP' || code === 'TH') for (const entry of dataOf(doc)) if (isObject(entry)) delete entry.originalData;
}

/** Change the quantity of an entry; the value block moves with it and gets a unit of the new kind. */
export function setKind(entry, kind) {
  const obs = entry.observable;
  const block = obs[obs.kind];
  if (obs.kind !== kind) {
    delete obs[obs.kind];
    obs.kind = kind;
    obs[kind] = block;
  }
  // the value is not converted and the unit is not guessed: a unit that does not fit the
  // new quantity stays, is shown as unusable and reported by the checks until one is chosen
}

/** How obj[key] is shown in an input: a number with its written digits, or the text as typed. */
export function numberText(obj, key) {
  if (typeof obj[key] === 'number') return jsonfmt.numberText(obj, key);
  return obj[key] === null || obj[key] === undefined ? '' : String(obj[key]);
}

/** Store typed text as a number; text that is not a number is kept as a string, so that the checks report it. */
export function setNumberField(obj, key, text) {
  const t = String(text).trim();
  if (t === '') delete obj[key];
  else if (!jsonfmt.setNumber(obj, key, t)) obj[key] = t;
}

export const uncertaintiesOf = (block) => (Array.isArray(block.uncertainties) ? block.uncertainties : []);

export function uncertaintyText(block, source) {
  const u = uncertaintiesOf(block).find((x) => x && x.source === source);
  return u ? numberText(u, 'value') : '';
}

/** Set (or with empty text remove) the uncertainty component `source`; components stay in SOURCE_ORDER. */
export function setUncertainty(block, source, text) {
  const t = String(text).trim();
  let u = uncertaintiesOf(block).find((x) => x && x.source === source);
  if (t === '') {
    if (u) block.uncertainties = block.uncertainties.filter((x) => x !== u);
    return;
  }
  if (!u) {
    if (!Array.isArray(block.uncertainties)) block.uncertainties = [];
    u = { source };
    block.uncertainties.push(u);
    const rank = (x) => (x && SOURCE_ORDER.includes(x.source) ? SOURCE_ORDER.indexOf(x.source) : SOURCE_ORDER.length);
    block.uncertainties.sort((a, b) => rank(a) - rank(b));
  }
  setNumberField(u, 'value', t);
}

/**
 * Rows pasted from a spreadsheet into the data grid.  Columns: element, mass
 * number (an integer or nat), value, uncertainty, [key], [comment], separated
 * by tabs, commas or blanks.  The element may carry the mass number (28Si,
 * Si-28, natSi); the mass column is then left out.  Lines that cannot be
 * understood (including a nonnumeric uncertainty) are returned in `skipped`.
 */
export function parsePastedRows(text, elements) {
  const symbols = new Set(elements);
  const rows = [];
  const skipped = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let cells = line.includes('\t') ? line.split('\t') : line.includes(',') ? line.split(',') : line.split(/\s+/);
    cells = cells.map((c) => c.trim());
    let element = null;
    let mass = null;
    const first = cells.shift() || '';
    let m = /^(\d+|nat)[-\s]?([A-Za-z]{1,2})$/.exec(first);                 // 28Si, natSi
    if (m) {
      element = m[2];
      mass = m[1] === 'nat' ? '0' : m[1];
    } else if ((m = /^([A-Za-z]{1,2})[-\s]?(\d+|nat)$/.exec(first))) {      // Si-28, Si28
      element = m[1];
      mass = m[2] === 'nat' ? '0' : m[2];
    } else if (/^[A-Za-z]{1,2}$/.test(first)) {                              // Si <tab> 28
      element = first;
      if (cells.length >= 2 && /^nat$/i.test(cells[0])) {
        cells.shift();
        mass = '0';
      } else if (cells.length >= 2 && /^\d+$/.test(cells[0]) && Number(cells[0]) <= 300) {
        mass = cells.shift();
      }
    }
    element = element ? normalizeElement(element) : null;
    const [value, uncertainty, key, ...rest] = cells;
    const valueText = String(value === undefined ? '' : value).trim();
    const uncText = uncertainty || '';
    if (!element || !symbols.has(element) || mass === null || !isNumberLexeme(valueText) || (uncText && !isNumberLexeme(uncText))) {
      skipped.push(raw);
      continue;
    }
    rows.push({
      element, mass: Number(mass), value: valueText,
      uncertainty: uncText,
      key: key || '', comment: rest.join(' ').trim(),
    });
  }
  return { rows, skipped };
}

/** A typed or pasted source as a bibId: a DOI or a doi.org address gets DOI:, a bare NSR keynumber NSR:. */
export function sourceText(text) {
  const t = String(text || '').trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, '');
  if (/^10\./.test(t)) return `DOI:${t}`;
  return bibKind(`NSR:${t}`) === 'NSR' ? `NSR:${t}` : t;
}

/** Short name of an entry's nuclide and key: '30Si', 'natSi [plate]'. */
export function entryLabel(entry) {
  const nuclide = isObject(entry) && isObject(entry.nuclide) ? entry.nuclide : {};
  const element = typeof nuclide.element === 'string' && nuclide.element ? nuclide.element : '?';
  const mass = nuclide.mass === 0 ? 'nat' : nuclide.mass === undefined ? '' : String(nuclide.mass);
  return `${mass}${element}${isObject(entry) && typeof entry.key === 'string' && entry.key ? ` [${entry.key}]` : ''}`;
}

/** 'LT/EXP Mizuno2025' for the file data/LT/EXP/Mizuno2025_4d2ed5c83736.json, 'master/facilities' for a master table, else the path. */
export function fileName(path) {
  const p = String(path);
  const parts = p.split('/');
  if (isDataFilePath(p) && parts.length === 4) return `${parts[1]}/${parts[2]} ${parts[3].replace(/(_[0-9a-f]{12})?\.json$/, '')}`;
  if (p.startsWith(`${MASTER_DIR}/`)) return `master/${p.slice(MASTER_DIR.length + 1).replace(/\.json$/, '')}`;
  return p;
}

/** The datasetIds of the entries of a file's text (an empty set for no text or text that is not JSON). */
export function datasetIdsOf(text) {
  if (typeof text !== 'string') return new Set();
  try {
    return new Set(dataOf(jsonfmt.parse(text)).map(idOf).filter(Boolean));
  } catch (err) {
    return new Set();
  }
}

// ---- references between entries (originalData) -------------------------------------

/**
 * Find entries of the database `db` by datasetId, or by an earlier identifier
 * (legacyIds) that names exactly one entry - as the checks resolve
 * originalData.  resolve(id) -> { current, path, index, code, entry } | null;
 * of(item) resolves the datasetId of an originalData item (null for anything else).
 */
export function entryLookup(db) {
  const byId = new Map();
  const files = db.sortedFiles().filter((f) => isObject(f.obj));
  for (const f of files) {
    dataOf(f.obj).forEach((entry, index) => {
      const id = idOf(entry);
      if (id !== null && !byId.has(id)) byId.set(id, { path: f.path, index, code: f.code, entry });
    });
  }
  const legacy = new Map();   // earlier id -> current datasetId (null: claimed by several entries)
  for (const f of files) {
    for (const entry of dataOf(f.obj)) {
      const id = idOf(entry);
      if (id === null) continue;
      for (const lid of legacyOf(entry)) if (!byId.has(lid)) legacy.set(lid, legacy.has(lid) ? null : id);
    }
  }
  const resolve = (id) => {
    const current = byId.has(id) ? id : legacy.get(id);
    return current ? { current, ...byId.get(current) } : null;
  };
  return { resolve, of: (item) => resolve(idOf(item)) };
}

/** The datasetIds named in an entry's originalData (as written). */
export function originalIds(entry) {
  return (isObject(entry) && Array.isArray(entry.originalData) ? entry.originalData : [])
    .map((item) => (isObject(item) ? item.datasetId : item)).filter((id) => typeof id === 'string');
}

/** A new originalData item for the entry `id` names now: its datasetId and its entryHash as it is now. */
function freshItem(id, lookup) {
  const target = lookup.resolve(id);
  return target ? { datasetId: id, entryHash: entryHash(target.entry) } : { datasetId: id };
}

/**
 * The originalData list for the datasetIds typed in `text`.  An id that an
 * item of `pool` (the items the entry had) names keeps that item, with the
 * entryHash recorded in it; so does an id that names the same entry as such
 * an item (an earlier and the current identifier).  Any other id gets the
 * entryHash of its entry as it is now, or none when it names no entry (the
 * checks report that).
 */
export function parseOriginalData(text, pool, lookup) {
  const items = (Array.isArray(pool) ? pool : []).filter((item) => isObject(item) && typeof item.datasetId === 'string');
  const used = new Set();
  const take = (test) => {
    const item = items.find((p) => !used.has(p) && test(p));
    if (item) used.add(item);
    return item;
  };
  return String(text).split(/[\s,;]+/).filter(Boolean).map((id) => {
    const target = lookup.resolve(id);
    const same = take((p) => p.datasetId === id);
    if (same) return typeof same.entryHash === 'string' || !target ? same : { ...same, entryHash: entryHash(target.entry) };
    const moved = target ? take((p) => { const t = lookup.resolve(p.datasetId); return Boolean(t) && t.current === target.current; }) : null;
    if (moved) return { ...moved, datasetId: id };
    return freshItem(id, lookup);
  });
}

/**
 * The originalData list after a choice in the picker.  `offered`: the current
 * datasetIds of the entries offered, `chosen`: those ticked.  Items about
 * entries not offered stay as they are; an item about a ticked entry stays as
 * it is (with the entryHash recorded in it); a ticked entry without an item
 * gets one with its entryHash as it is now.
 */
export function pickOriginalData(items, offered, chosen, lookup) {
  const about = (item) => {
    const t = lookup.of(item);
    return t ? t.current : null;
  };
  const kept = (Array.isArray(items) ? items : []).filter((item) => {
    const current = about(item);
    return current === null || !offered.includes(current) || chosen.has(current);
  }).map((item) => {
    const t = lookup.of(item);
    return t && typeof item.entryHash !== 'string' ? { ...item, entryHash: entryHash(t.entry) } : item;
  });
  const covered = new Set(kept.map(about).filter(Boolean));
  return [...kept, ...offered.filter((id) => chosen.has(id) && !covered.has(id)).map((id) => freshItem(id, lookup))];
}

/**
 * The curator has checked the derived value against the original data as it
 * is now: record the original's current entryHash in `item`.  Returns false
 * when the item names no entry.
 */
export function confirmOriginal(item, lookup) {
  const target = lookup.of(item);
  if (!target) return false;
  item.entryHash = entryHash(target.entry);
  return true;
}

/** The entries of `db` whose originalData names one of `ids`: [{ id, path, index, entry }]. */
export function referencesTo(db, ids) {
  const wanted = new Set(ids);
  const out = [];
  for (const f of db.sortedFiles()) {
    dataOf(f.obj).forEach((entry, index) => {
      for (const id of originalIds(entry)) if (wanted.has(id)) out.push({ id, path: f.path, index, entry });
    });
  }
  return out;
}

/** Write the new ids of `mapping` (old -> new) into the originalData of a document; the entryHash stays. Returns whether anything changed. */
export function replaceOriginalIds(doc, mapping) {
  let changed = false;
  for (const entry of dataOf(doc)) {
    if (!isObject(entry) || !Array.isArray(entry.originalData)) continue;
    entry.originalData = entry.originalData.map((item) => {
      if (!isObject(item) || !mapping.has(item.datasetId)) return item;
      changed = true;
      return { ...item, datasetId: mapping.get(item.datasetId) };
    });
  }
  return changed;
}

// ---- identity of the entries while a document is edited --------------------------

function setLegacy(entry, list) {
  if (list && list.length) entry.legacyIds = list; else delete entry.legacyIds;
}

/**
 * Follows the entries of one document through the editor's edits and tells
 * apart, against the saved version of the file: entries kept (whatever their
 * place), added, deleted, and entries whose identifying fields changed
 * (docs/id-definition.md, section 5).  Entries are matched by datasetId,
 * never by position.
 *
 * An entry that has the datasetId of a saved entry is that entry.  An entry
 * whose identifiers changed still stands for the saved entry it was opened as
 * (its claim) if that is unambiguous: the saved datasetId is used by no entry
 * any more and no other entry claims it.  Otherwise it counts as added, the
 * saved entry as deleted, and nothing is re-pointed.
 *
 * A change of identity waits for a choice (choose()):
 *   'same'       a correction of the same entry: the old datasetId goes into
 *                legacyIds and originalData that named it names the new one
 *                (in every file, this one included);
 *   'different'  different data: legacyIds and corrections are removed and references stay
 *                as they are, so the checks report them.
 * A choice that no longer fits the entry (its identifiers changed again, it
 * was deleted) is undone.  A document read from a file in which an entry
 * lists a saved datasetId the file no longer uses in its legacyIds is taken
 * as one where 'same' was chosen.
 *
 * `workspace` (replaceIds) and `path` (the file of the document) are needed
 * where other files are changed.
 */
class IdTracker {
  #claims = new WeakMap();   // entry -> datasetId of the saved entry it was opened as
  #choices = new Map();      // entry -> choice, identifiers and history before the choice
  #changes = [];             // of the last review

  /** `saved`: the datasetIds of the saved version of the file. */
  constructor(doc, saved) {
    const entries = dataOf(doc);
    const current = new Set(entries.map(idOf).filter(Boolean));
    const listed = new Map();   // saved id the file no longer uses -> entries listing it in legacyIds
    for (const entry of entries) {
      const id = idOf(entry);
      if (id !== null && saved.has(id)) {
        this.#claims.set(entry, id);
        continue;
      }
      for (const lid of legacyOf(entry)) if (saved.has(lid) && !current.has(lid)) push(listed, lid, entry);
    }
    const byEntry = new Map();
    for (const [lid, list] of listed) if (list.length === 1) push(byEntry, list[0], lid);
    for (const [entry, lids] of byEntry) {
      if (lids.length !== 1 || idOf(entry) === null) continue;
      const rest = legacyOf(entry).filter((id) => id !== lids[0]);
      this.#claims.set(entry, lids[0]);
      this.#choices.set(entry, { choice: 'same', from: lids[0], to: idOf(entry), legacy: rest.length ? rest : null });
    }
  }

  /**
   * Take over the entries of `next`, the document read again from its JSON
   * text: an entry of `next` stands for the entry of `previous` whose
   * datasetId is written in it.
   */
  adopt(previous, next) {
    const before = new Map();
    for (const entry of dataOf(previous)) if (idOf(entry) !== null) push(before, idOf(entry), entry);
    const written = new Map();
    for (const entry of dataOf(next)) if (idOf(entry) !== null) push(written, idOf(entry), entry);
    for (const [id, entries] of written) {
      const olds = before.get(id) || [];
      if (olds.length !== 1) continue;
      const [old] = olds;
      if (this.#claims.has(old)) for (const entry of entries) this.#claims.set(entry, this.#claims.get(old));
      if (entries.length === 1 && this.#choices.has(old)) {
        this.#choices.set(entries[0], this.#choices.get(old));
        this.#choices.delete(old);
      }
    }
  }

  /**
   * Compare the entries of `doc` (identifiers computed) with the saved
   * version of the file (`saved`: its datasetIds) and undo choices that no
   * longer fit.  Returns
   *   changes    [{ entry, from, to, choice }]  identity changes (choice null: not chosen yet)
   *   ambiguous  [{ from, entries }]            several entries stand for one saved entry
   *   added      entries that are not saved entries
   *   deleted    saved datasetIds no entry stands for
   */
  review(doc, saved, workspace, path) {
    const entries = dataOf(doc);
    const current = new Set(entries.map(idOf).filter(Boolean));
    const claimed = new Map();
    for (const entry of entries) {
      const id = idOf(entry);
      if (id === null || saved.has(id)) continue;
      const from = this.#claims.get(entry);
      if (from !== undefined && saved.has(from) && !current.has(from)) push(claimed, from, entry);
    }
    const changes = [];
    const ambiguous = [];
    for (const [from, list] of claimed) {
      const settled = list.filter((e) => this.#choices.has(e) && this.#choices.get(e).to === idOf(e));
      const entry = list.length === 1 ? list[0] : settled.length === 1 ? settled[0] : null;
      if (entry) changes.push({ entry, from, to: idOf(entry), choice: null });
      else ambiguous.push({ from, entries: list });
    }
    for (const [entry, choice] of [...this.#choices]) {
      const change = changes.find((c) => c.entry === entry);
      if (!change || change.from !== choice.from || change.to !== choice.to) this.#undo(entry, choice, doc, workspace, path);
    }
    for (const change of changes) {
      if (this.#choices.has(change.entry)) change.choice = this.#choices.get(change.entry).choice;
    }
    this.#changes = changes;
    const accounted = new Set([...changes.map((c) => c.from), ...ambiguous.map((a) => a.from)]);
    return {
      changes,
      ambiguous,
      added: entries.filter((e) => isObject(e) && !saved.has(idOf(e)) && !changes.some((c) => c.entry === e)),
      deleted: [...saved].filter((id) => !current.has(id) && !accounted.has(id)).sort(),
    };
  }

  /**
   * Settle the identity change of `entry` found by the last review: 'same'
   * or 'different' (see above).  Returns the other files that were changed.
   */
  choose(entry, choice, doc, workspace, path) {
    const change = this.#changes.find((c) => c.entry === entry);
    if (!change) return [];
    const previous = this.#choices.get(entry);
    if (previous && previous.choice === choice) return [];
    if (previous) this.#undo(entry, previous, doc, workspace, path);
    const legacy = Array.isArray(entry.legacyIds) ? [...entry.legacyIds] : null;
    let touched = [];
    const corrections = entry.corrections;
    if (choice === 'same') {
      setLegacy(entry, [...new Set([...(legacy || []), change.from])].filter((id) => id !== change.to));
      const mapping = new Map([[change.from, change.to]]);
      replaceOriginalIds(doc, mapping);
      touched = workspace.replaceIds(mapping, path);
    } else {
      delete entry.legacyIds;
      delete entry.corrections;
    }
    this.#choices.set(entry, { choice, from: change.from, to: change.to, legacy, corrections });
    change.choice = choice;
    return touched;
  }

  /** Undo every choice (the edits of the document are discarded). */
  undoAll(doc, workspace, path) {
    for (const [entry, choice] of [...this.#choices]) this.#undo(entry, choice, doc, workspace, path);
    this.#changes = [];
  }

  #undo(entry, choice, doc, workspace, path) {
    this.#choices.delete(entry);
    if (dataOf(doc).includes(entry)) {
      setLegacy(entry, choice.legacy);
      if (choice.choice === 'different' && choice.corrections !== undefined) entry.corrections = choice.corrections;
    }
    if (choice.choice !== 'same') return;
    const back = new Map([[choice.to, choice.from]]);
    replaceOriginalIds(doc, back);
    workspace.replaceIds(back, path);
  }
}

// ---- the editor's document --------------------------------------------------------

/**
 * The document the editor holds: `doc`, stored as a draft in the workspace at
 * `path` (null until it is first stored), and its entries followed by an
 * IdTracker against the saved version of the file.
 */
export class Draft {
  #workspace;
  #tracker;
  #review = null;

  constructor(workspace, path, doc) {
    this.#workspace = workspace;
    this.path = path;
    this.doc = doc;
    this.#tracker = new IdTracker(doc, this.#savedIds());
  }

  /** The tracker's review of the entries at the last store (IdTracker.review); null until then. */
  get review() {
    return this.#review;
  }

  /** The text the document is stored as and the JSON tab shows. */
  text() {
    return canonicalText(this.doc, this.#workspace.schemas);
  }

  /**
   * Store the document in the workspace as a draft under its canonical file
   * name.  `reference`, the reference card (reference.js), gives the
   * bibliography entry of the source, which the file is named after (entryFor(bibId)),
   * and stages it before the document is stored (save(bibId)); without it, the file is named after
   * the bibliography's entry.  Returns null, or why the document cannot be
   * stored: 'shape' (formProblem), 'incomplete' (no valid bibId or no MetaID)
   * or { taken: path } (another file has the same MetaID, or the file name
   * holds another file).
   */
  store(reference = null) {
    const { doc } = this;
    if (formProblem(doc)) return 'shape';
    const bibId = String(doc.meta.bibId || '').trim();
    if (!isBibId(bibId) || expectedMetaId(doc) === null) return 'incomplete';
    assignIds(doc);
    const twin = this.#workspace.db.sortedFiles().find((f) => f.path !== this.path && f.meta.id === doc.meta.id);
    const target = filePath(doc, reference ? reference.entryFor(bibId) : this.#workspace.db.reference(bibId));
    if (twin || (target !== this.path && this.#workspace.text(target) !== null)) return { taken: twin ? twin.path : target };
    this.#review = this.#tracker.review(doc, this.#savedIds(), this.#workspace, this.path);
    if (reference) reference.save(bibId);   // the bibliography entry first: the file name depends on it
    this.#workspace.move(this.path, target, this.text());
    this.path = target;
    return null;
  }

  /** Take `next` (of the JSON tab) as the document; its entries are matched by datasetId (IdTracker.adopt). */
  adopt(next) {
    this.#tracker.adopt(this.doc, next);
    this.doc = next;
    this.#review = null;                            // until the next store reviews the entries
  }

  /** Settle identity changes of the last review: 'same' or 'different' (IdTracker.choose).  Returns the other files that were changed. */
  choose(changes, choice) {
    const touched = new Set();
    for (const change of changes) {
      for (const p of this.#tracker.choose(change.entry, choice, this.doc, this.#workspace, this.path)) touched.add(p);
    }
    return [...touched];
  }

  /** Undo every choice, so that references re-pointed for this document go back (its edits are discarded). */
  undo() {
    this.#tracker.undoAll(this.doc, this.#workspace, this.path);
    this.#review = null;
  }

  #savedIds() {
    return datasetIdsOf(this.path ? this.#workspace.baseline(this.path) : null);
  }
}
