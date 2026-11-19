// The working copy of the data entry tool: the files of the database as the
// local server holds them, plus the changes made in this page that are not
// saved yet ("drafts").  A save records all drafts at once (see save()).
//
// A draft holds the complete new text of a file (null: the file is deleted)
// and the blob id of the saved version it was made from (`baseSha`, null for
// a new file).  A file whose canonical name changed (new DOI, key
// or first author) is a pair of drafts: the deletion of the old path and the
// new path, which names the old one as its `origin`; the pair is discarded
// and deleted together.  Drafts are kept in `storage` (localStorage) so that
// they survive closing the page; they are read from it once, when the
// workspace is created.  When the storage cannot be used, the drafts live in
// memory only and storageProblem() says so.  A draft equal to the saved text
// is dropped.

import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import { Physics } from '../../site/assets/js/core/convert.js';
import { Database, DATA_DIR, MASTER_DIR, MASTER_FORMATS, isDataFilePath } from '../../site/assets/js/core/database.js';
import { replaceOriginalIds } from './document.js';
import { ConflictError } from './backend.js';

const SCHEMA_DIR = 'schema/v1/';
const SUMMARY_PARTS = 3;   // a save message names up to this many files in its first line

/** A file the Database is made of (master tables, files of the sub-libraries, strays under data/). */
const inDatabase = (path) => path.startsWith(`${DATA_DIR}/`) && path.endsWith('.json');

/** 'LT/EXP Mizuno2025' for a file of a sub-library, 'master/facilities' for a master table, else the path. */
function describe(path) {
  const parts = path.split('/');
  if (isDataFilePath(path) && parts.length === 4) return `${parts[1]}/${parts[2]} ${parts[3].replace(/(_[0-9a-f]{12})?\.json$/, '')}`;
  if (path.startsWith(`${MASTER_DIR}/`)) return `master/${path.slice(MASTER_DIR.length + 1).replace(/\.json$/, '')}`;
  return path;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class Workspace {
  #drafts;            // path -> { content: text | null, baseSha: sha | null, origin?: path }
  #db = null;         // Database of the current texts (built on first use, then updated file by file)
  #issues = null;
  #physics;           // Physics of the current master tables (undefined: not built)
  #upstreamIds = new Set();
  #listeners = new Set();
  #notifying = false;
  #readFailed = false;   // the drafts kept in the storage could not be read
  #writeFailed = false;  // the drafts could not be written to the storage the last time

  constructor(backend, storage) {
    this.backend = backend;
    this.storage = storage || null;
    this.storageKey = `mund-admin:drafts:${backend.copy}:${backend.branch}`;
    this.upstream = new Map();   // path -> { sha, text }
    this.schemas = {};           // file name in schema/v1 -> schema
    this.#drafts = this.#readStorage();
  }

  /**
   * Why the drafts are not kept in the storage: 'unavailable' (there is no
   * storage), 'write' (the last write failed: full or blocked), 'read' (the
   * drafts kept earlier could not be read), or null.
   */
  storageProblem() {
    if (!this.storage) return 'unavailable';
    if (this.#writeFailed) return 'write';
    return this.#readFailed ? 'read' : null;
  }

  /** `fn` is called (once per batch of synchronous changes) whenever the files change. */
  onChange(fn) {
    this.#listeners.add(fn);
  }

  // ---- loading ---------------------------------------------------------------
  /** Read the files the server lists: the database, the schemas, VERSION and CHANGELOG.md. */
  async load(onProgress = () => {}) {
    const listed = await this.backend.listFiles();
    let done = 0;
    const texts = await mapLimit(listed, 8, async (f) => {
      const text = await this.backend.readFile(f.path);
      onProgress(++done, listed.length);
      return text;
    });
    this.upstream = new Map(listed.map((f, i) => [f.path, { sha: f.sha, text: texts[i] }]));
    this.schemas = {};
    for (const [path, entry] of this.upstream) {
      if (path.startsWith(SCHEMA_DIR)) this.schemas[path.slice(SCHEMA_DIR.length)] = JSON.parse(entry.text);
    }
    this.#upstreamIds = new Set();
    for (const [path, entry] of this.upstream) {
      if (!isDataFilePath(path)) continue;
      let obj;
      try { obj = jsonfmt.parse(entry.text); } catch (err) { continue; }
      for (const row of (obj && Array.isArray(obj.data) ? obj.data : [])) {
        if (row && typeof row.datasetId === 'string') this.#upstreamIds.add(row.datasetId);
      }
    }
    for (const [path, draft] of this.#drafts) {
      if (draft.content === this.upstreamText(path)) this.#drafts.delete(path);
    }
    this.#invalidate();
    this.#changed();
  }

  // ---- reading -----------------------------------------------------------------
  upstreamText(path) {
    const entry = this.upstream.get(path);
    return entry ? entry.text : null;
  }

  /** Current text of a file: the draft if there is one (null = deleted / missing). */
  text(path) {
    return this.#drafts.has(path) ? this.#drafts.get(path).content : this.upstreamText(path);
  }

  paths() {
    const all = new Set([...this.upstream.keys(), ...this.#drafts.keys()]);
    return [...all].filter((p) => this.text(p) !== null).sort();
  }

  dataFilePaths() {
    return this.paths().filter(isDataFilePath);
  }

  /** The database with the drafts applied. */
  get db() {
    if (!this.#db) {
      const db = new Database(this.schemas);
      for (const path of this.paths()) if (inDatabase(path)) db.setFile(path, this.text(path));
      this.#db = db;
    }
    return this.#db;
  }

  issues() {
    if (!this.#issues) this.#issues = this.db.validate();
    return this.#issues;
  }

  issuesFor(path) {
    return this.issues().filter((i) => i.file === path);
  }

  /** Conversion between the quantities with the current master tables (null when they are unusable). */
  physics() {
    if (this.#physics === undefined) {
      try {
        this.#physics = new Physics(this.db.masterObj('huff_factors.json'), this.db.masterObj('constants.json'));
      } catch (err) {
        this.#physics = null;
      }
    }
    return this.#physics;
  }

  status(path) {
    const draft = this.#drafts.get(path);
    if (!draft) return 'unchanged';
    if (draft.content === null) return 'deleted';
    return this.upstream.has(path) ? 'modified' : 'added';
  }

  /** Text the current file is compared with: its saved content (or that of its origin). */
  baseline(path) {
    if (this.upstream.has(path)) return this.upstreamText(path);
    const draft = this.#drafts.get(path);
    return draft && draft.origin ? this.upstreamText(draft.origin) : null;
  }

  /** Every datasetId of the saved files (as loaded). */
  upstreamIds() {
    return this.#upstreamIds;
  }

  /**
   * The drafts, sorted by path: { path, content, baseSha, origin, status, outdated }.
   * `outdated`: the saved file is another version than the one the draft was made from.
   */
  changes() {
    return [...this.#drafts].map(([path, draft]) => {
      const entry = this.upstream.get(path);
      return {
        path, content: draft.content, baseSha: draft.baseSha, origin: draft.origin || null,
        status: this.status(path), outdated: (entry ? entry.sha : null) !== draft.baseSha,
      };
    }).sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  // ---- editing -----------------------------------------------------------------
  stage(path, text) {
    this.#put(path, text);
    this.#changed();
  }

  /** Delete a file.  For a renamed file the original stays deleted. */
  stageDelete(path) {
    this.#put(path, null);
    this.#changed();
  }

  /**
   * Store `text` at `to` and delete the file at `from` (the canonical file name
   * changed).  Refused, returning false, when another file exists at `to`.
   */
  move(from, to, text) {
    if (from !== to && this.text(to) !== null) return false;
    if (from && from !== to) {
      const previous = this.#drafts.get(from);
      const origin = previous && previous.origin ? previous.origin : (this.upstream.has(from) ? from : null);
      this.#put(from, null);
      this.#put(to, text);
      const draft = this.#drafts.get(to);
      if (draft && origin && origin !== to) draft.origin = origin;
    } else {
      this.#put(to, text);
    }
    this.#changed();
    return true;
  }

  /** Undo the changes of a file (and of the other half of a renamed file). */
  discard(path) {
    const draft = this.#drafts.get(path);
    const linked = [path];
    if (draft && draft.origin) linked.push(draft.origin);
    for (const [other, d] of this.#drafts) if (d.origin === path) linked.push(other);
    for (const p of linked) this.#drop(p);
    this.#changed();
  }

  discardAll() {
    this.#drafts.clear();
    this.#invalidate();
    this.#changed();
  }

  /**
   * Make the draft of an outdated file a change of the current saved version
   * (it then replaces whatever is there now).
   */
  rebase(path) {
    const draft = this.#drafts.get(path);
    if (!draft) return;
    const entry = this.upstream.get(path);
    draft.baseSha = entry ? entry.sha : null;
    if (draft.content === this.upstreamText(path)) this.#drop(path);
    this.#changed();
  }

  /**
   * Re-point references (`mapping`: old datasetId -> new): wherever a file
   * other than `exceptPath` lists an old datasetId in originalData, write the
   * new one; the recorded entryHash stays.  Returns the paths that were updated.
   */
  replaceIds(mapping, exceptPath) {
    const touched = [];
    if (!mapping.size) return touched;
    for (const path of this.dataFilePaths()) {
      if (path === exceptPath) continue;
      const text = this.text(path);
      if (![...mapping.keys()].some((id) => text.includes(id))) continue;
      let obj;
      try { obj = jsonfmt.parse(text); } catch (err) { continue; }
      if (!replaceOriginalIds(obj, mapping)) continue;
      this.#put(path, this.db.canonicalText(obj));
      touched.push(path);
    }
    if (touched.length) this.#changed();
    return touched;
  }

  /**
   * Add or replace the bibliography entry of a DOI (entries are kept sorted by
   * DOI, compared case-insensitively) and stage the bibliography file.
   */
  setReference(reference) {
    const path = `${MASTER_DIR}/bibliography.json`;
    let doc;
    try { doc = jsonfmt.parse(this.text(path)); } catch (err) { doc = null; }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.references)) {
      doc = { format: MASTER_FORMATS['bibliography.json'], references: [] };
    }
    const key = String(reference.DOI).trim().toUpperCase();
    doc.references = doc.references.filter((r) => String(r && r.DOI).trim().toUpperCase() !== key);
    doc.references.push(reference);
    doc.references.sort((a, b) => {
      const x = String(a.DOI).toUpperCase();
      const y = String(b.DOI).toUpperCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    this.stage(path, this.db.canonicalText(doc));
  }

  // ---- saving ----------------------------------------------------------------------
  /**
   * Save every draft at once ({ sha, sent, pending, error } of the server),
   * then read the files again.  A draft whose text was sent is then done; a
   * draft changed while the save was under way stays, as a change of what
   * was just saved.  When a file was changed by someone else (ConflictError)
   * the files are read again too, so that the drafts concerned are outdated;
   * nothing is saved then, nor when the database would not be valid
   * (InvalidError) or the server cannot be reached; the drafts stay.
   */
  async save(message) {
    const changes = this.changes().map(({ path, content, baseSha }) => ({ path, content, baseSha }));
    let result;
    try {
      result = await this.backend.save({ message, changes });
    } catch (err) {
      if (err instanceof ConflictError) await this.load();
      throw err;
    }
    await this.load();               // drops the drafts equal to the saved texts
    let changed = false;
    for (const c of changes) {
      const draft = this.#drafts.get(c.path);
      if (!draft) continue;
      changed = true;
      if (draft.content === c.content) {
        this.#drop(c.path);          // saved, combined with someone else's change of the file
      } else if (this.upstreamText(c.path) === c.content) {
        const entry = this.upstream.get(c.path);
        draft.baseSha = entry ? entry.sha : null;
        if (entry) delete draft.origin;
      }
    }
    if (changed) this.#changed();
    return result;
  }

  /**
   * Message of a save of the current drafts: a first line in English naming
   * what changes ('Update LT/EXP Mizuno2025; Add LT/CUR Tanaka2020'), then
   * `description`.
   */
  saveMessage(description = '') {
    const changes = this.changes();
    const parts = [];
    for (const c of changes) {
      if (c.status === 'deleted' && changes.some((o) => o.origin === c.path)) continue;   // named with the renamed file
      const verb = c.origin ? 'Update' : { added: 'Add', modified: 'Update', deleted: 'Delete' }[c.status];
      parts.push(`${verb} ${describe(c.path)}`);
    }
    const many = parts.length > SUMMARY_PARTS;
    const subject = many ? `Update ${parts.length} files` : parts.join('; ');
    const body = [String(description).trim(), many ? parts.map((p) => `- ${p}`).join('\n') : ''].filter(Boolean).join('\n\n');
    return body ? `${subject}\n\n${body}` : subject;
  }

  // ---- bookkeeping -------------------------------------------------------------------
  /** Set the text of `path` (null: deleted); a text equal to the saved one leaves no draft. */
  #put(path, content) {
    if (content === this.upstreamText(path)) {
      this.#drop(path);
      return;
    }
    const previous = this.#drafts.get(path);
    const entry = this.upstream.get(path);
    const draft = { content, baseSha: previous ? previous.baseSha : (entry ? entry.sha : null) };
    if (content !== null && previous && previous.origin) draft.origin = previous.origin;
    this.#drafts.set(path, draft);
    this.#sync(path);
  }

  #drop(path) {
    if (this.#drafts.delete(path)) this.#sync(path);
  }

  /** Bring the database up to date with the current text of `path`. */
  #sync(path) {
    this.#issues = null;
    if (!this.#db || !inDatabase(path)) return;
    const text = this.text(path);
    if (text === null) this.#db.removeFile(path); else this.#db.setFile(path, text);
    if (path.startsWith(`${MASTER_DIR}/`)) this.#physics = undefined;
  }

  #invalidate() {
    this.#db = null;
    this.#issues = null;
    this.#physics = undefined;
  }

  #changed() {
    this.#persist();
    if (this.#notifying) return;
    this.#notifying = true;
    Promise.resolve().then(() => {
      this.#notifying = false;
      for (const fn of this.#listeners) fn();
    });
  }

  #readStorage() {
    const drafts = new Map();
    if (!this.storage) return drafts;
    try {
      for (const [path, draft] of JSON.parse(this.storage.getItem(this.storageKey) || '[]')) {
        if (typeof path === 'string' && draft && (typeof draft.content === 'string' || draft.content === null)) {
          drafts.set(path, { ...draft, baseSha: draft.baseSha || null });
        }
      }
    } catch (err) {
      this.#readFailed = true;     // broken or blocked storage: start without drafts (reported)
      try {                        // what cannot be read is set aside, not overwritten
        const raw = this.storage.getItem(this.storageKey);
        if (raw !== null) this.storage.setItem(`${this.storageKey}:unreadable`, raw);
      } catch (err2) { /* blocked: nothing to set aside */ }
    }
    return drafts;
  }

  #persist() {
    if (!this.storage) return;
    try {
      if (this.#drafts.size) this.storage.setItem(this.storageKey, JSON.stringify([...this.#drafts]));
      else this.storage.removeItem(this.storageKey);
      this.#writeFailed = false;
    } catch (err) {
      this.#writeFailed = true;    // storage full or blocked: drafts live in memory only (reported)
    }
  }
}
