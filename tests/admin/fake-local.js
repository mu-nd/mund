// An in-memory stand-in for the local server of the data entry tool
// (tools/mundlib/admin.py): the API described in admin/js/backend.js, on a
// set of files ("the copy on this computer") and a second set standing for
// GitHub, which someone else can change.

import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import { canonicalText } from '../../site/assets/js/core/schema.js';

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

/** What `next` changes of `base` (arrays of lines) as admin.merge_lines finds it: [i1, i2, lines],
 *  the opcodes other than 'equal' of difflib.SequenceMatcher(None, base, next, autojunk=False). */
function edits(base, next) {
  const positions = new Map();                     // line -> its indexes in next
  next.forEach((line, j) => positions.set(line, [...(positions.get(line) || []), j]));
  const blocks = [];                               // [i, j, size]: the longest match first, then on each side of it
  const queue = [[0, base.length, 0, next.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    let [besti, bestj, size] = [alo, blo, 0];
    let lengths = new Map();
    for (let i = alo; i < ahi; i++) {
      const longer = new Map();
      for (const j of positions.get(base[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (lengths.get(j - 1) || 0) + 1;
        longer.set(j, k);
        if (k > size) [besti, bestj, size] = [i - k + 1, j - k + 1, k];
      }
      lengths = longer;
    }
    if (!size) continue;
    blocks.push([besti, bestj, size]);
    if (alo < besti && blo < bestj) queue.push([alo, besti, blo, bestj]);
    if (besti + size < ahi && bestj + size < bhi) queue.push([besti + size, ahi, bestj + size, bhi]);
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]).push([base.length, next.length, 0]);
  const out = [];
  let [i, j] = [0, 0];
  for (const [ai, bj, size] of blocks) {
    if (i < ai || j < bj) out.push([i, ai, next.slice(j, bj)]);
    [i, j] = [ai + size, bj + size];
  }
  return out;
}

const lines = (text) => text.match(/[^\n]*\n|[^\n]+/g) || [];

/** Three-way merge by lines; null when both sides change the same lines (admin.merge_lines). */
function mergeLines(base, ours, theirs) {
  const b = lines(base);
  const combined = [];
  for (const edit of [...edits(b, lines(ours)), ...edits(b, lines(theirs))]) {
    if (combined.some((e) => e[0] === edit[0] && e[1] === edit[1] && e[2].join('') === edit[2].join(''))) continue;
    for (const [i1, i2] of combined) {
      const overlap = edit[0] < i2 && i1 < edit[1];
      const touchingInsertion = (edit[0] === edit[1] && i1 <= edit[0] && edit[0] <= i2) || (i1 === i2 && edit[0] <= i1 && i1 <= edit[1]);
      if (overlap || touchingInsertion) return null;
    }
    combined.push(edit);
  }
  const out = [...b];
  for (const [i1, i2, added] of combined.sort((x, y) => y[0] - x[0] || y[1] - x[1])) out.splice(i1, i2 - i1, ...added);
  return out.join('');
}

export class FakeLocal {
  constructor({ files = {}, repository = 'someone/mund', branch = 'main', practice = false } = {}) {
    this.session = { repository, branch, user: { name: 'Test User', email: 'test@example.invalid' }, practice, copy: 'copy-1' };
    this.files = new Map(Object.entries(files));   // the copy on this computer, as saved
    this.github = new Map(this.files);             // what GitHub has
    this.blobs = new Map();                        // every text the copy has had, by blob id (as git keeps them)
    for (const text of this.files.values()) this.keep(text);
    this.commits = [];                             // newest first: { sha, author, date, message, paths, version: VERSION's text, renames: [[from, to]] }
    this.initial = { sha: `c${'0'.repeat(39)}`, version: this.files.get('VERSION') };   // the state the copy starts from (not listed in the history)
    this.tagList = [];
    this.pending = 0;                              // saves not sent yet
    this.online = true;                            // false: GitHub cannot be reached
    this.reachable = true;                         // false: the page cannot reach this server (fetch fails)
    this.failing = new Set();                      // API paths whose requests fail as if the server could not be reached
    this.invalid = null;                           // issues: saves are refused as invalid
    this.log = [];
    this.received = {};                            // API path -> the body of its last request
    this.counter = 0;
  }

  keep(text) {
    this.blobs.set(blobSha(text), text);
  }

  /** A change made by someone else, already on GitHub. */
  changeOnGitHub(changes) {
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) this.github.delete(path); else { this.github.set(path, text); this.keep(text); }
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

  /** admin.save without its validation: `invalid` gives the issues it would report. */
  save({ message, changes }) {
    if (!String(message || '').trim() || !Array.isArray(changes) || !changes.length) {
      return this.respond(400, { code: 'bad-request', message: 'a message and at least one change are needed' });
    }
    this.sync();
    const conflicts = [];
    for (const c of changes) {
      if ((this.files.has(c.path) ? blobSha(this.files.get(c.path)) : null) === c.baseSha) continue;
      const text = this.merge(c);
      if (text === null) conflicts.push(c.path); else c.content = text;
    }
    if (conflicts.length) return this.respond(409, { code: 'conflict', message: 'changed in the meantime', paths: conflicts });
    if (this.invalid) return this.respond(422, { code: 'invalid', message: 'the database would not be valid', issues: this.invalid });
    // a deleted file whose text lives on, mostly, in a new file was renamed (git log --follow finds it so)
    const renames = [];
    for (const c of changes.filter((d) => d.content === null && this.files.has(d.path))) {
      const old = lines(this.files.get(c.path));
      const [to] = changes.filter((d) => d.content !== null && !this.files.has(d.path))
        .map((d) => [d.path, lines(d.content).filter((l) => old.includes(l)).length]).sort((x, y) => y[1] - x[1]);
      if (to && to[1] * 2 > old.length) renames.push([c.path, to[0]]);
    }
    for (const c of changes) {
      if (c.content === null) this.files.delete(c.path); else { this.files.set(c.path, c.content); this.keep(c.content); }
    }
    const sha = `c${String(++this.counter).padStart(39, '0')}`;
    this.commits.unshift({ sha, author: 'Test User', date: '2026-11-17T00:00:00+09:00', message: message.trim(), paths: changes.map((c) => c.path), version: this.files.get('VERSION'), renames });
    this.pending++;
    const sent = this.send();
    return this.respond(200, { sha, ...sent });
  }

  /** admin._merge: a change made on an older version combined with the file as it is now; null unless the result is JSON in canonical form. */
  merge(change) {
    const base = this.blobs.get(change.baseSha);
    if (change.content === null || base === undefined || !this.files.has(change.path)) return null;
    const merged = mergeLines(base, change.content, this.files.get(change.path));
    const schemas = {};
    for (const [path, text] of this.files) if (/^schema\/v1\/[^/]+\.json$/.test(path)) schemas[path.slice(10)] = JSON.parse(text);
    try {
      return merged !== null && canonicalText(jsonfmt.parse(merged), schemas) === merged ? merged : null;
    } catch (err) {
      return null;
    }
  }

  /** admin.tag without freezing releases/vN: the tag goes on the commit that set VERSION (admin.release_commit); a repeat answers the same. */
  tag(name) {
    if (!/^v\d+\.\d+\.\d+$/.test(String(name))) return this.respond(400, { code: 'bad-request', message: 'a version tag looks like v1.2.3' });
    const version = name.slice(1);
    const release = [...this.commits.filter((c) => c.paths.includes('VERSION')), this.initial].find((c) => String(c.version).trim() === version);
    if (!release) return this.respond(404, { code: 'not-found', message: `no saved state has the version ${version}` });
    const tagged = this.tagList.find((t) => t.name === name);
    if (tagged && tagged.sha !== release.sha) return this.respond(409, { code: 'tag-exists', message: `the version ${name} is published already` });
    if (!tagged) this.tagList.unshift({ name, sha: release.sha });
    const major = /^v(\d+)\.0\.0$/.exec(name);
    const sent = this.send();
    const pushed = this.online ? sent : { sent: false, pending: this.pending, error: this.failure('offline') };
    return this.respond(200, { name, sha: release.sha, frozen: major ? `v${Number(major[1])}` : null, ...pushed });
  }

  /** Drop-in replacement for fetch() as the page uses it. */
  fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const path = url.split('?')[0];
    this.log.push(`${method} ${path}`);
    if (!this.reachable || this.failing.has(path)) throw new TypeError('Failed to fetch');
    if (method === 'POST' && options.headers['Content-Type'] !== 'application/json') {
      return this.respond(403, { code: 'forbidden', message: 'not from the tool\'s page' });
    }
    const body = options.body ? JSON.parse(options.body) : {};
    if (options.body) this.received[path] = JSON.parse(options.body);   // as sent, before a save merges it
    const q = query(url);
    if (method === 'GET' && path === '/api/session') return this.respond(200, { ...this.session, pending: this.pending });
    if (method === 'POST' && path === '/api/sync') return this.respond(200, this.sync());
    if (method === 'GET' && path === '/api/files') {
      return this.respond(200, [...this.files.keys()].filter(watched).sort().map((p) => ({ path: p, sha: blobSha(this.files.get(p)), text: this.files.get(p) })));
    }
    if (method === 'POST' && path === '/api/save') return this.save(body);
    if (method === 'POST' && path === '/api/send') return this.respond(200, this.send());
    if (method === 'GET' && path === '/api/history') {
      const names = new Set([q.path]);              // the file and its earlier names, as git log --follow
      const found = this.commits.filter((c) => {
        const hit = !q.path || c.paths.some((p) => names.has(p) || p.startsWith(`${q.path}/`));
        for (const [from, to] of c.renames) if (names.has(to)) names.add(from);
        return hit;
      });
      return this.respond(200, found.slice(0, Number(q.limit || 30)).map(({ sha, author, date, message }) => ({ sha, author, date, message })));
    }
    if (method === 'GET' && path === '/api/tags') return this.respond(200, this.tagList);
    if (method === 'POST' && path === '/api/tag') return this.tag(body.name);
    return this.respond(404, { code: 'not-found', message: `no such API: ${method} ${path}` });
  };
}
