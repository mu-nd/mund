// An in-memory stand-in for the local server of the data entry tool
// (tools/mundlib/admin.py): the API described in admin/js/backend.js, on a
// set of files ("the copy on this computer") and a second set standing for
// GitHub, which someone else can change.

/** Content addressed ids, as git blob ids are. */
function blobSha(text) {
  let out = '';
  for (let seed = 1; seed <= 5; seed++) {
    let h = (0x811c9dc5 ^ (seed * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

/** The files the server lists: the database, the schemas, VERSION and CHANGELOG.md. */
const watched = (path) => (path.startsWith('data/') && path.endsWith('.json'))
  || /^schema\/v1\/[^/]+\.json$/.test(path) || path === 'VERSION' || path === 'CHANGELOG.md';

function query(url) {
  const out = {};
  const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  for (const kv of q.split('&').filter(Boolean)) {
    const [k, v = ''] = kv.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return out;
}

export class FakeLocal {
  constructor({ files = {}, repository = 'someone/mund', branch = 'main', practice = false } = {}) {
    this.session = { repository, branch, user: { name: 'Test User', email: 'test@example.invalid' }, remote: true, practice, copy: 'copy-1' };
    this.files = new Map(Object.entries(files));   // the copy on this computer, as saved
    this.github = new Map(this.files);             // what GitHub has
    this.commits = [];                             // newest first: { sha, author, date, message, paths }
    this.tagList = [];
    this.pending = 0;                              // saves not sent yet
    this.online = true;                            // false: GitHub cannot be reached
    this.reachable = true;                         // false: the page cannot reach this server (fetch fails)
    this.invalid = null;                           // issues: saves are refused as invalid
    this.log = [];
    this.counter = 0;
  }

  /** A change made by someone else, already on GitHub. */
  changeOnGitHub(changes) {
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) this.github.delete(path); else this.github.set(path, text);
    }
  }

  respond(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  failure(code) {
    return { code, message: `${code} (fake)` };
  }

  sync() {
    if (!this.online) return { updated: false, pending: this.pending, error: this.failure('offline') };
    if (this.pending) return { updated: false, pending: this.pending, error: null };
    const updated = [...this.github].some(([p, t]) => this.files.get(p) !== t) || [...this.files.keys()].some((p) => !this.github.has(p));
    this.files = new Map(this.github);
    return { updated, pending: 0, error: null };
  }

  send() {
    if (!this.pending) return { sent: true, pending: 0, error: null };
    if (!this.online) return { sent: false, pending: this.pending, error: this.failure('offline') };
    this.github = new Map(this.files);
    this.pending = 0;
    return { sent: true, pending: 0, error: null };
  }

  save({ message, changes }) {
    if (!String(message || '').trim() || !Array.isArray(changes) || !changes.length) {
      return this.respond(400, { code: 'bad-request', message: 'a message and at least one change are needed' });
    }
    this.sync();
    const conflicts = changes.filter((c) => (this.files.has(c.path) ? blobSha(this.files.get(c.path)) : null) !== c.baseSha).map((c) => c.path);
    if (conflicts.length) return this.respond(409, { code: 'conflict', message: 'changed in the meantime', paths: conflicts });
    if (this.invalid) return this.respond(422, { code: 'invalid', message: 'the database would not be valid', issues: this.invalid });
    for (const c of changes) {
      if (c.content === null) this.files.delete(c.path); else this.files.set(c.path, c.content);
    }
    const sha = `c${String(++this.counter).padStart(39, '0')}`;
    this.commits.unshift({ sha, author: 'Test User', date: '2026-11-17T00:00:00+09:00', message: message.trim(), paths: changes.map((c) => c.path) });
    this.pending++;
    const sent = this.send();
    return this.respond(200, { sha, ...sent });
  }

  /** Drop-in replacement for fetch() as the page uses it. */
  fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const path = url.split('?')[0];
    this.log.push(`${method} ${path}`);
    if (!this.reachable) throw new TypeError('Failed to fetch');
    if (method === 'POST' && options.headers['Content-Type'] !== 'application/json') {
      return this.respond(403, { code: 'forbidden', message: 'not from the tool\'s page' });
    }
    const body = options.body ? JSON.parse(options.body) : {};
    const q = query(url);
    if (method === 'GET' && path === '/api/session') return this.respond(200, { ...this.session, pending: this.pending });
    if (method === 'POST' && path === '/api/sync') return this.respond(200, this.sync());
    if (method === 'GET' && path === '/api/files') {
      return this.respond(200, [...this.files.keys()].filter(watched).sort().map((p) => ({ path: p, sha: blobSha(this.files.get(p)) })));
    }
    if (method === 'GET' && path === '/api/file') {
      if (!watched(q.path) || !this.files.has(q.path)) return this.respond(404, { code: 'not-found', message: `${q.path} is not a file of the database` });
      return this.respond(200, { path: q.path, text: this.files.get(q.path) });
    }
    if (method === 'POST' && path === '/api/save') return this.save(body);
    if (method === 'POST' && path === '/api/send') return this.respond(200, this.send());
    if (method === 'GET' && path === '/api/history') {
      const found = this.commits.filter((c) => !q.path || c.paths.some((p) => p === q.path || p.startsWith(`${q.path}/`)));
      return this.respond(200, found.slice(0, Number(q.limit || 30)).map(({ sha, author, date, message }) => ({ sha, author, date, message })));
    }
    if (method === 'GET' && path === '/api/tags') return this.respond(200, this.tagList);
    if (method === 'POST' && path === '/api/tag') {
      if (!/^v\d+\.\d+\.\d+$/.test(String(body.name))) return this.respond(400, { code: 'bad-request', message: 'a version tag looks like v1.2.3' });
      if (this.tagList.some((t) => t.name === body.name)) return this.respond(400, { code: 'bad-request', message: `the tag ${body.name} exists already` });
      const sha = this.commits.length ? this.commits[0].sha : 'c-initial';
      this.tagList.unshift({ name: body.name, sha });
      const sent = this.send();
      if (sent.sent && !this.online) return this.respond(200, { name: body.name, sha, sent: false, pending: 0, error: this.failure('offline') });
      return this.respond(200, sent.sent ? { name: body.name, sha, sent: true, error: null } : { name: body.name, sha, ...sent });
    }
    return this.respond(404, { code: 'not-found', message: `no such API: ${method} ${path}` });
  };
}
