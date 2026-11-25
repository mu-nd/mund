// The local server of the data entry tool (tools/mundlib/admin.py, started by
// `pixi run admin`).  It serves this page, reads and writes the files of the
// local copy of the repository, and records and sends every save to GitHub.
//
// API (JSON both ways; the server's cookie authenticates the page):
//   GET  /api/session  -> { repository, branch, user: { name, email } | null, practice, copy, pending }
//                         kept as `backend.session`; copy: names this working copy (a practice copy is new at every start)
//   POST /api/sync     -> { updated, pending, error }        bring the copy up to date with GitHub
//   GET  /api/files    -> [{ path, sha, text }]               the files of the database (sha: git blob id)
//   POST /api/save { message, changes: [{ path, content (null: delete), baseSha (null: new file) }] }
//                      -> { sha, sent, pending, error }       409 conflict { paths }, 422 invalid { issues }
//   POST /api/send     -> { sent, pending, error }            send saved changes that were not sent
//   GET  /api/history?path=P&limit=N -> [{ sha, author, date, message }]
//                      newest first, each message in full; a file's saves under its earlier names included
//   GET  /api/tags     -> [{ name, sha }]
//   POST /api/tag { name } -> { name, sha (the release commit), frozen (vN or null), sent, pending, error }
//                      422 invalid { message }: a major version could not be frozen
// Errors: HTTP status with { code, message, ... }.  `error` in a result, when
// a save was not sent: { code: 'offline' | 'auth' | 'permission' | 'rejected' | 'dirty', message }.
//
// No dependencies on the page; `fetchImpl` can be replaced in tests.

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** A file to be saved was changed by someone else since it was read. */
export class ConflictError extends Error {
  constructor(paths) {
    super(`changed in the meantime: ${paths.join(', ')}`);
    this.name = 'ConflictError';
    this.paths = paths;
  }
}

/**
 * The server refused a save or a publication as not valid: `issues` are the
 * problems of the database ({ level, code, file, pointer, message }), `message`
 * the server's reason.
 */
export class InvalidError extends Error {
  constructor(issues, message = 'the database would not be valid') {
    super(message);
    this.name = 'InvalidError';
    this.code = 'invalid';
    this.issues = issues;
  }
}

export class LocalBackend {
  constructor({ fetchImpl } = {}) {
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.session = null;       // GET /api/session
    this.pending = 0;          // saves not sent to GitHub yet
    this.sendError = null;     // why the last save or send was not sent ({ code, message })
  }

  async request(method, path, body) {
    const options = { method, headers: { Accept: 'application/json' }, cache: 'no-store' };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await this.fetch(path, options);
    } catch (err) {
      throw new ApiError(`the tool's server does not answer: ${err.message}`, 0, 'server');
    }
    let data = null;
    try { data = await response.json(); } catch (err) { /* not JSON */ }
    if (response.ok) {
      // A result may say how many saves wait to be sent and why the last one was not sent.
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        if (typeof data.pending === 'number') this.pending = data.pending;
        if ('sent' in data) this.sendError = data.sent ? null : data.error || null;
      }
      return data;
    }
    const detail = data || {};
    if (response.status === 409 && detail.code === 'conflict') throw new ConflictError(detail.paths || []);
    if (response.status === 422 && detail.code === 'invalid') throw new InvalidError(detail.issues || [], detail.message);
    throw new ApiError(detail.message || `HTTP ${response.status}`, response.status, detail.code || null);
  }

  /** The session, then the copy brought up to date: { session, sync }. */
  async connect() {
    this.session = await this.request('GET', '/api/session');
    return { session: this.session, sync: await this.sync() };
  }

  async sync() {
    return this.request('POST', '/api/sync', {});
  }

  async listFiles() {
    return this.request('GET', '/api/files');
  }

  /** Record `changes` as one save and send it.  Throws ConflictError, InvalidError or ApiError. */
  async save({ message, changes }) {
    return this.request('POST', '/api/save', { message, changes });
  }

  async send() {
    return this.request('POST', '/api/send', {});
  }

  async history(path = '', limit = 30) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (path) query.set('path', path);
    return this.request('GET', `/api/history?${query}`);
  }

  async tags() {
    return this.request('GET', '/api/tags');
  }

  /** Mark the release commit of `name` (v1.2.3: the save that set VERSION to 1.2.3) as that version and send it. */
  async tag(name) {
    return this.request('POST', '/api/tag', { name });
  }
}
