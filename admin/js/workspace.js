// The working copy of the data entry tool: the files of the database as the
// local server holds them, plus the changes made in this page that are not
// saved yet ("drafts").  A save records all drafts at once (see save()).
//
// A draft holds the complete new text of a file (null: the file is deleted)
// and the blob id of the saved version it was made from (`baseSha`, null for
// a new file).  A file whose canonical name changed (new source, key
// or first author) is a pair of drafts: the deletion of the old path and the
// new path, which names the old one as its `origin`; the pair is discarded
// and deleted together.  Drafts are kept in `storage` (localStorage, or
// sessionStorage for a practice copy) so that they survive reloading the page;
// they are read from it once, when the workspace is created, and no longer
// written after close().  When the storage cannot be used, the drafts live in
// memory only and storageProblem() says so.  A draft equal to the saved text
// is dropped.  A bibliography entry that only a draft holds is removed when a
// data file that named it changes, is discarded or deleted, and no file names
// it any more.

import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import { Physics } from '../../site/assets/js/core/convert.js';
import { normalizeBibId } from '../../site/assets/js/core/ids.js';
import { Database, DATA_DIR, MASTER_DIR, MASTER_FORMATS, isDataFilePath } from '../../site/assets/js/core/database.js';
import { canonicalText } from '../../site/assets/js/core/schema.js';
import { replaceOriginalIds, fileName } from './document.js';
import { ConflictError } from './backend.js';

const SCHEMA_DIR = 'schema/v1/';
const SUMMARY_PARTS = 3;   // a save message names up to this many files in its first line

/** A file the Database is made of (master tables, files of the sub-libraries, strays under data/). */
const inDatabase = (path) => path.startsWith(`${DATA_DIR}/`) && path.endsWith('.json');

/** The key of a bibliography entry: its id, compared case-insensitively. */
const bibKey = (r) => normalizeBibId((r && r.id) || '');

const sourcesOf = (meta) => [meta?.bibId, ...(Array.isArray(meta?.relatedBibIds) ? meta.relatedBibIds : [])]
  .filter((id) => typeof id === 'string' && id);

export class Workspace {
  #drafts;            // path -> { content: text | null, baseSha: sha | null, origin?: path }
  #sending = null;    // path -> content in the save under way
  #db = null;         // Database of the current texts (built on first use, then updated file by file)
  #issues = null;
  #physics;           // Physics of the current master tables (undefined: not built)
  #listeners = new Set();
  #notifying = false;
  #readFailed = false;   // the drafts kept in the storage could not be read
  #writeFailed = false;  // the drafts could not be written to the storage the last time

  constructor(backend, storage) {
    this.backend = backend;
    this.storage = storage || null;
    this.storageKey = `mund-admin:drafts:${backend.session.copy}:${backend.session.branch}`;
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

  /** Stop keeping the drafts in the storage and telling the listeners (another tab took over). */
  close() {
    this.storage = null;
    this.#listeners.clear();
  }

  // ---- loading ---------------------------------------------------------------
  /** Read the files the server lists: the database, the schemas, VERSION and CHANGELOG.md. */
  async load() {
    const listed = await this.backend.listFiles();
    this.upstream = new Map(listed.map((f) => [f.path, { sha: f.sha, text: f.text }]));
    this.schemas = {};
    for (const [path, entry] of this.upstream) {
      if (path.startsWith(SCHEMA_DIR)) this.schemas[path.slice(SCHEMA_DIR.length)] = JSON.parse(entry.text);
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
    const sources = this.#sources([path]);
    this.#put(path, null);
    this.#dropUnused(sources);
    this.#changed();
  }

  /**
   * Store `text` at `to` and delete the file at `from` (the canonical file name
   * changed).  Refused, returning false, when another file exists at `to`.
   */
  move(from, to, text) {
    if (from !== to && this.text(to) !== null) return false;
    const sources = this.#sources([from]);
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
    this.#dropUnused(sources);
    this.#changed();
    return true;
  }

  /** Undo the changes of a file (and of the other half of a renamed file). */
  discard(path) {
    const draft = this.#drafts.get(path);
    const linked = [path];
    if (draft && draft.origin) linked.push(draft.origin);
    for (const [other, d] of this.#drafts) if (d.origin === path) linked.push(other);
    const sources = this.#sources(linked);
    for (const p of linked) this.#drop(p);
    this.#dropUnused(sources);
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
      this.#put(path, canonicalText(obj, this.schemas));
      touched.push(path);
    }
    if (touched.length) this.#changed();
    return touched;
  }

  /**
   * Add or replace the bibliography entry of a bibId (its id; entries are kept sorted by it,
   * compared case-insensitively) and stage the bibliography file. Returns false if it cannot be read.
   */
  setReference(reference) {
    const { path, doc } = this.#bibliography();
    if (!doc) return false;
    const key = bibKey(reference);
    doc.references = doc.references.filter((r) => bibKey(r) !== key);
    doc.references.push(reference);
    doc.references.sort((a, b) => {
      const x = bibKey(a);
      const y = bibKey(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    this.stage(path, canonicalText(doc, this.schemas));
    return true;
  }

  /**
   * Remove the bibliography entry of `bibId` that only a draft holds (the saved bibliography
   * lacks it) and that no data file names (bibId or relatedBibIds).  Returns false if the
   * bibliography cannot be read or the entry stays.
   */
  dropReference(bibId) {
    const key = normalizeBibId(bibId);
    const { path, doc } = this.#bibliography();
    if (!doc) return false;
    let saved;
    try { saved = jsonfmt.parse(this.upstreamText(path)).references; } catch (err) { saved = null; }
    if (Array.isArray(saved) && saved.some((r) => bibKey(r) === key)) return false;
    if (this.db.sortedFiles().some((f) => sourcesOf(f.meta).some((id) => normalizeBibId(id) === key))) return false;
    const kept = doc.references.filter((r) => bibKey(r) !== key);
    if (kept.length === doc.references.length) return false;
    doc.references = kept;
    this.stage(path, canonicalText(doc, this.schemas));
    return true;
  }

  // ---- saving ----------------------------------------------------------------------
  /**
   * Save every draft at once ({ sha, sent, pending, error } of the server),
   * then read the files again.  A draft whose text was sent is then done; a
   * later edit stays as a draft, even when it restores the text before the
   * save.  When the files cannot be read again, the save is done
   * all the same and `reloadError` in the result says why; the drafts stay
   * until the files are read.  When a file was changed by someone else
   * (ConflictError) the files are read again too, so that the drafts
   * concerned are outdated; nothing is saved then, nor when the database
   * would not be valid (InvalidError) or the server cannot be reached; the
   * drafts stay.
   */
  async save(message) {
    const changes = this.changes().map(({ path, content, baseSha }) => ({ path, content, baseSha }));
    this.#sending = new Map(changes.map((c) => [c.path, c.content]));
    let result;
    try {
      result = await this.backend.save({ message, changes });
      try {
        await this.load();
      } catch (reloadError) {
        return { ...result, reloadError };
      }
    } catch (err) {
      if (err instanceof ConflictError) await this.load();
      else {
        for (const { path } of changes) {
          if (this.#drafts.has(path) && this.text(path) === this.upstreamText(path)) this.#drop(path);
        }
        this.#changed();
      }
      throw err;
    } finally {
      this.#sending = null;
    }
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
      parts.push(`${verb} ${fileName(c.path)}`);
    }
    const many = parts.length > SUMMARY_PARTS;
    const subject = many ? `Update ${parts.length} files` : parts.join('; ');
    const body = [String(description).trim(), many ? parts.map((p) => `- ${p}`).join('\n') : ''].filter(Boolean).join('\n\n');
    return body ? `${subject}\n\n${body}` : subject;
  }

  // ---- bookkeeping -------------------------------------------------------------------
  /** The sources (bibId, relatedBibIds) that the current texts of the data files among `paths` name. */
  #sources(paths) {
    const sources = new Set();
    for (const path of paths) {
      const text = path && isDataFilePath(path) ? this.text(path) : null;
      if (text === null) continue;
      try {
        for (const id of sourcesOf(jsonfmt.parse(text)?.meta)) sources.add(id);
      } catch (err) { /* an unreadable file has no identifiable source */ }
    }
    return sources;
  }

  /** After data files changed: remove the entries of `sources` that only a draft holds and no file names any more. */
  #dropUnused(sources) {
    for (const id of sources) this.dropReference(id);
  }

  /** The bibliography starts empty for a missing file. An unreadable file gives doc: null. */
  #bibliography() {
    const path = `${MASTER_DIR}/bibliography.json`;
    const text = this.text(path);
    if (text === null) return { path, doc: { format: MASTER_FORMATS['bibliography.json'], references: [] } };
    let doc;
    try { doc = jsonfmt.parse(text); } catch (err) { doc = null; }
    return { path, doc: Array.isArray(doc?.references) ? doc : null };
  }

  /** Set the text of `path` (null: deleted); a text equal to the saved one leaves no draft. */
  #put(path, content) {
    const reverting = this.#sending?.has(path) && this.#sending.get(path) !== content;
    if (!reverting && content === this.upstreamText(path)) {
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
