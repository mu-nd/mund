// The working copy of the admin UI: the files of the repository plus the
// changes that have been made here but are not committed yet ("drafts").

import * as jsonfmt from '../core/jsonfmt.js';
import * as schemaMod from '../core/schema.js';
import { Database, MASTER_FILES, SUBLIBRARIES, assignIds } from '../core/checks.js';
import { MASTER_DIR } from '../core/cite.js';

const DATASET_RE = new RegExp(`^data/(${SUBLIBRARIES.join('|')})/`);
const SCHEMA_PREFIX = 'schema/v1/';

export const isDatasetPath = (path) => DATASET_RE.test(path);
export const isMasterPath = (path) => path.startsWith(`${MASTER_DIR}/`);

// ---- cache of file contents by git blob id (content addressed, never stale) ----
const blobCache = {
  db: null,
  open() {
    if (this.db !== null) return this.db;
    this.db = new Promise((resolve) => {
      try {
        const request = indexedDB.open('mund-admin-blobs', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('blobs');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
    return this.db;
  },
  async get(sha) {
    const db = await this.open();
    if (!db) return undefined;
    return new Promise((resolve) => {
      const request = db.transaction('blobs').objectStore('blobs').get(sha);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
  },
  async set(sha, text) {
    const db = await this.open();
    if (!db) return;
    try { db.transaction('blobs', 'readwrite').objectStore('blobs').put(text, sha); } catch (err) { /* ignore */ }
  },
};

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
  constructor(backend, storage) {
    this.backend = backend;
    this.storage = storage || null;
    this.storageKey = `mund-admin:drafts:${backend.kind}:${backend.repository}:${backend.branch}`;
    this.upstream = new Map();   // path -> { sha, text }
    this.drafts = new Map();     // path -> { content: text | null, baseSha: sha | null }
    this.schemas = {};
    this.listeners = new Set();
    this._db = null;
    this._issues = null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    this._db = null;
    this._issues = null;
    this.saveDrafts();
    for (const fn of this.listeners) fn();
  }

  // ---- loading ---------------------------------------------------------------
  async load(onProgress = () => {}) {
    const files = await this.backend.listFiles();
    const wanted = files.filter((f) => f.path.startsWith('data/') || f.path.startsWith(SCHEMA_PREFIX)
      || f.path === 'VERSION' || f.path === 'CHANGELOG.md');
    let done = 0;
    const cacheable = this.backend.kind === 'github';
    const texts = await mapLimit(wanted, 8, async (f) => {
      let text = cacheable ? await blobCache.get(f.sha) : undefined;
      if (text === undefined) {
        text = await this.backend.readFile(f.path, f.sha);
        if (cacheable) blobCache.set(f.sha, text);
      }
      onProgress(++done, wanted.length);
      return text;
    });
    this.upstream = new Map(wanted.map((f, i) => [f.path, { sha: f.sha, text: texts[i] }]));
    this.schemas = {};
    for (const [path, entry] of this.upstream) {
      if (path.startsWith(SCHEMA_PREFIX)) this.schemas[path.slice(SCHEMA_PREFIX.length)] = JSON.parse(entry.text);
    }
    this.restoreDrafts();
    this._db = null;
    this._issues = null;
    this._upstreamIds = null;
    for (const fn of this.listeners) fn();
  }

  saveDrafts() {
    if (!this.storage) return;
    try {
      if (this.drafts.size) this.storage.setItem(this.storageKey, JSON.stringify([...this.drafts]));
      else this.storage.removeItem(this.storageKey);
    } catch (err) { /* storage full or blocked: drafts live in memory only */ }
  }

  restoreDrafts() {
    this.drafts = new Map();
    if (!this.storage) return;
    try {
      for (const [path, draft] of JSON.parse(this.storage.getItem(this.storageKey) || '[]')) {
        // drop drafts that no longer differ from the repository
        if (draft.content === this.upstreamText(path)) continue;
        this.drafts.set(path, draft);
      }
    } catch (err) { /* ignore broken storage */ }
  }

  // ---- reading -----------------------------------------------------------------
  upstreamText(path) {
    const entry = this.upstream.get(path);
    return entry ? entry.text : null;
  }

  /** Current text of a file: the draft if there is one (null = deleted / missing). */
  text(path) {
    if (this.drafts.has(path)) return this.drafts.get(path).content;
    return this.upstreamText(path);
  }

  paths() {
    const all = new Set([...this.upstream.keys(), ...this.drafts.keys()]);
    return [...all].filter((p) => this.text(p) !== null).sort();
  }

  datasetPaths() {
    return this.paths().filter(isDatasetPath);
  }

  /** The database with the drafts applied. */
  get db() {
    if (!this._db) {
      const master = {};
      for (const name of MASTER_FILES) {
        const text = this.text(`${MASTER_DIR}/${name}`);
        if (text !== null) master[name] = text;
      }
      const db = new Database(this.schemas, master);
      for (const path of this.datasetPaths()) db.setFile(path, this.text(path));
      this._db = db;
    }
    return this._db;
  }

  issues() {
    if (!this._issues) this._issues = this.db.validate();
    return this._issues;
  }

  issuesFor(path) {
    return this.issues().filter((i) => i.file === path);
  }

  status(path) {
    if (!this.drafts.has(path)) return 'unchanged';
    if (this.drafts.get(path).content === null) return 'deleted';
    return this.upstream.has(path) ? 'modified' : 'added';
  }

  /** A draft whose base is no longer what the repository holds. */
  isOutdated(path) {
    const draft = this.drafts.get(path);
    if (!draft) return false;
    const entry = this.upstream.get(path);
    return (entry ? entry.sha : null) !== (draft.baseSha || null);
  }

  // ---- editing -----------------------------------------------------------------
  stage(path, text) {
    if (text === this.upstreamText(path)) {
      this.drafts.delete(path);
    } else {
      const entry = this.upstream.get(path);
      const previous = this.drafts.get(path);
      this.drafts.set(path, { content: text, baseSha: previous ? previous.baseSha : (entry ? entry.sha : null) });
    }
    this.changed();
  }

  stageDelete(path) {
    if (this.upstream.has(path)) {
      const previous = this.drafts.get(path);
      this.drafts.set(path, { content: null, baseSha: previous ? previous.baseSha : this.upstream.get(path).sha });
    } else {
      this.drafts.delete(path);
    }
    this.changed();
  }

  discard(path) {
    this.drafts.delete(path);
    this.changed();
  }

  discardAll() {
    this.drafts.clear();
    this.changed();
  }

  /**
   * Store `text` at `to`, removing the file from `from` (a new DOI, key or
   * first author changes the canonical file name).  The draft remembers the
   * file it started from (`origin`) so that changes can be shown against it.
   */
  move(from, to, text) {
    if (!from || from === to) {
      this.stage(to, text);
      return;
    }
    const previous = this.drafts.get(from);
    const origin = (previous && previous.origin) || (this.upstream.has(from) ? from : null);
    if (this.upstream.has(from)) {
      this.drafts.set(from, { content: null, baseSha: this.upstream.get(from).sha });
    } else {
      this.drafts.delete(from);
    }
    this.stage(to, text);
    const draft = this.drafts.get(to);
    if (draft && origin && origin !== to) draft.origin = origin;
    this.changed();
  }

  /** Text the current file is compared with: its content in the repository. */
  baseline(path) {
    if (this.upstream.has(path)) return this.upstream.get(path).text;
    const draft = this.drafts.get(path);
    return draft && draft.origin ? this.upstreamText(draft.origin) : null;
  }

  /** Every DataID that exists in the repository (committed state). */
  upstreamIds() {
    if (!this._upstreamIds) {
      const ids = new Set();
      for (const [path, entry] of this.upstream) {
        if (!isDatasetPath(path)) continue;
        for (const m of entry.text.matchAll(/\{"datasetId": "([0-9a-f]{12})"/g)) ids.add(m[1]);
      }
      this._upstreamIds = ids;
    }
    return this._upstreamIds;
  }

  /**
   * Follow renamed identifiers: wherever another file lists an old datasetId as
   * original data, write the new one.  Returns the paths that were updated.
   */
  replaceIds(mapping, exceptPath) {
    const touched = [];
    if (!mapping.size) return touched;
    for (const path of this.datasetPaths()) {
      if (path === exceptPath) continue;
      const text = this.text(path);
      if (![...mapping.keys()].some((id) => text.includes(id))) continue;
      let obj;
      try { obj = jsonfmt.parse(text); } catch (err) { continue; }
      let changed = false;
      for (const row of (Array.isArray(obj.data) ? obj.data : [])) {
        if (!Array.isArray(row.originalData)) continue;
        row.originalData = row.originalData.map((id) => {
          if (!mapping.has(id)) return id;
          changed = true;
          return mapping.get(id);
        });
      }
      if (!changed) continue;
      const schema = this.db.schemaFor(String(obj.format));
      const normalized = schema ? schemaMod.normalize(obj, schema) : obj;
      const entry = this.upstream.get(path);
      const previous = this.drafts.get(path);
      this.drafts.set(path, {
        content: jsonfmt.stringify(normalized), baseSha: previous ? previous.baseSha : (entry ? entry.sha : null),
      });
      touched.push(path);
    }
    if (touched.length) this.changed();
    return touched;
  }

  // ---- bibliography ------------------------------------------------------------------
  /**
   * Add or replace the bibliography entry of a DOI (entries are kept sorted by
   * DOI, compared case-insensitively) and stage the bibliography file.
   */
  setReference(reference) {
    const path = `${MASTER_DIR}/bibliography.json`;
    let doc;
    try { doc = jsonfmt.parse(this.text(path)); } catch (err) { doc = null; }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.references)) {
      doc = { format: 'muND/bibliography/1', references: [] };
    }
    const key = String(reference.DOI).trim().toUpperCase();
    doc.references = doc.references.filter((r) => String(r && r.DOI).trim().toUpperCase() !== key);
    doc.references.push(reference);
    doc.references.sort((a, b) => {
      const x = String(a.DOI).toUpperCase();
      const y = String(b.DOI).toUpperCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const schema = this.schemas['bibliography.schema.json'];
    this.stage(path, jsonfmt.stringify(schema ? schemaMod.normalize(doc, schema) : doc));
  }

  // ---- committing ------------------------------------------------------------------
  changes() {
    return [...this.drafts].map(([path, draft]) => ({
      path, content: draft.content, baseSha: draft.baseSha || null, status: this.status(path),
    })).sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async commit(message, mode = 'direct', pullRequest = {}) {
    const changes = this.changes();
    const result = await this.backend.commit({
      message, mode, pullRequest,
      changes: changes.map(({ path, content, baseSha }) => ({ path, content, baseSha })),
    });
    this.drafts.clear();
    this.saveDrafts();
    await this.load();
    return result;
  }
}

/** Parse a dataset text into an object ready for editing (identifiers recomputed). */
export function parseDataset(text) {
  const obj = jsonfmt.parse(text);
  try { assignIds(obj); } catch (err) { /* incomplete documents keep their identifiers */ }
  return obj;
}
