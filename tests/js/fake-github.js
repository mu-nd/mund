// A tiny in-memory stand-in for the GitHub REST endpoints used by the admin
// UI (site/assets/js/admin/backend.js).  It follows the documented behaviour
// of the real API closely enough to test the order of the calls, what is
// sent, and how conflicts are detected.

let counter = 0;
const nextSha = (prefix) => `${prefix}${String(++counter).padStart(39, '0')}`;

/** Blob ids depend on the content only, as in git (the admin UI caches file contents by blob id). */
function blobSha(text) {
  let out = '';
  for (let seed = 1; seed <= 5; seed++) {
    let h = (0x811c9dc5 ^ (seed * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

export class FakeGitHub {
  constructor({ repository = 'someone/mund', branch = 'main', files = {}, canPush = true, token = 'secret' } = {}) {
    this.repository = repository;
    this.token = token;
    this.canPush = canPush;
    this.blobs = new Map();     // sha -> text
    this.trees = new Map();     // sha -> Map(path -> blob sha)
    this.commits = new Map();   // sha -> { tree, parents, message }
    this.refs = new Map();      // 'heads/main' -> commit sha
    this.pulls = [];
    this.log = [];
    const tree = new Map();
    for (const [path, text] of Object.entries(files)) tree.set(path, this.blob(text));
    const treeSha = nextSha('t');
    this.trees.set(treeSha, tree);
    const commitSha = nextSha('c');
    this.commits.set(commitSha, { tree: treeSha, parents: [], message: 'initial' });
    this.refs.set(`heads/${branch}`, commitSha);
  }

  blob(text) {
    const sha = blobSha(text);
    this.blobs.set(sha, text);
    return sha;
  }

  /** Simulate a commit made by someone else. */
  pushElsewhere(branch, changes, message = 'someone else') {
    const head = this.refs.get(`heads/${branch}`);
    const tree = new Map(this.trees.get(this.commits.get(head).tree));
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) tree.delete(path); else tree.set(path, this.blob(text));
    }
    const treeSha = nextSha('t');
    this.trees.set(treeSha, tree);
    const sha = nextSha('c');
    this.commits.set(sha, { tree: treeSha, parents: [head], message });
    this.refs.set(`heads/${branch}`, sha);
    return sha;
  }

  fileAt(branch, path) {
    const tree = this.trees.get(this.commits.get(this.refs.get(`heads/${branch}`)).tree);
    return tree.has(path) ? this.blobs.get(tree.get(path)) : null;
  }

  respond(status, body, raw = false) {
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => body, text: async () => (raw ? body : JSON.stringify(body)),
    };
  }

  /** Drop-in replacement for fetch(). */
  fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const u = new URL(url);
    const path = u.pathname;
    const headers = options.headers || {};
    const body = options.body ? JSON.parse(options.body) : null;
    this.log.push(`${method} ${path}`);
    if (headers.Authorization !== `Bearer ${this.token}`) return this.respond(401, { message: 'Bad credentials' });
    const base = `/repos/${this.repository}`;
    if (path === '/user') return this.respond(200, { login: 'tester', name: 'Test User' });
    if (!path.startsWith(base)) return this.respond(404, { message: 'Not Found' });
    const rest = path.slice(base.length);
    let m;

    if (rest === '' && method === 'GET') {
      return this.respond(200, { full_name: this.repository, private: true, html_url: `https://github.com/${this.repository}`, permissions: { push: this.canPush } });
    }
    if ((m = /^\/branches\/(.+)$/.exec(rest)) && method === 'GET') {
      const sha = this.refs.get(`heads/${decodeURIComponent(m[1])}`);
      if (!sha) return this.respond(404, { message: 'Branch not found' });
      return this.respond(200, { name: m[1], commit: { sha, commit: { tree: { sha: this.commits.get(sha).tree } } } });
    }
    if ((m = /^\/git\/ref\/(.+)$/.exec(rest)) && method === 'GET') {
      const sha = this.refs.get(decodeURIComponent(m[1]));
      if (!sha) return this.respond(404, { message: 'Not Found' });
      return this.respond(200, { ref: `refs/${m[1]}`, object: { sha, type: 'commit' } });
    }
    if ((m = /^\/git\/commits\/(.+)$/.exec(rest)) && method === 'GET') {
      const c = this.commits.get(m[1]);
      if (!c) return this.respond(404, { message: 'Not Found' });
      return this.respond(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message });
    }
    if ((m = /^\/git\/trees\/(.+)$/.exec(rest)) && method === 'GET') {
      const tree = this.trees.get(m[1]);
      if (!tree) return this.respond(404, { message: 'Not Found' });
      return this.respond(200, { sha: m[1], truncated: false, tree: [...tree].map(([p, sha]) => ({ path: p, mode: '100644', type: 'blob', sha })) });
    }
    if ((m = /^\/git\/blobs\/(.+)$/.exec(rest)) && method === 'GET') {
      if (!this.blobs.has(m[1])) return this.respond(404, { message: 'Not Found' });
      if (headers.Accept !== 'application/vnd.github.raw+json') return this.respond(200, { encoding: 'base64', content: '' });
      return this.respond(200, this.blobs.get(m[1]), true);
    }
    if (!this.canPush && method !== 'GET') return this.respond(403, { message: 'Resource not accessible by personal access token' });

    if (rest === '/git/trees' && method === 'POST') {
      const tree = new Map(this.trees.get(body.base_tree));
      for (const entry of body.tree) {
        if (entry.mode !== '100644' || entry.type !== 'blob') return this.respond(422, { message: 'Invalid tree entry' });
        if (entry.sha === null) tree.delete(entry.path);
        else if (typeof entry.content === 'string') tree.set(entry.path, this.blob(entry.content));
        else return this.respond(422, { message: 'Invalid tree entry' });
      }
      const sha = nextSha('t');
      this.trees.set(sha, tree);
      return this.respond(201, { sha });
    }
    if (rest === '/git/commits' && method === 'POST') {
      if (!this.trees.has(body.tree) || !body.parents.every((p) => this.commits.has(p)) || !body.message) {
        return this.respond(422, { message: 'Invalid commit' });
      }
      const sha = nextSha('c');
      this.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return this.respond(201, { sha, tree: { sha: body.tree } });
    }
    if ((m = /^\/git\/refs\/(.+)$/.exec(rest)) && method === 'PATCH') {
      const name = decodeURIComponent(m[1]);
      const current = this.refs.get(name);
      if (!current) return this.respond(422, { message: 'Reference does not exist' });
      // only fast-forward updates are accepted unless forced
      let cursor = body.sha;
      let ancestor = false;
      while (cursor) {
        if (cursor === current) { ancestor = true; break; }
        cursor = (this.commits.get(cursor) || { parents: [] }).parents[0];
      }
      if (!ancestor && !body.force) return this.respond(422, { message: 'Update is not a fast forward' });
      this.refs.set(name, body.sha);
      return this.respond(200, { ref: `refs/${name}`, object: { sha: body.sha } });
    }
    if (rest === '/git/refs' && method === 'POST') {
      const name = body.ref.replace(/^refs\//, '');
      if (this.refs.has(name)) return this.respond(422, { message: 'Reference already exists' });
      this.refs.set(name, body.sha);
      return this.respond(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (rest === '/pulls' && method === 'POST') {
      if (!this.refs.has(`heads/${body.head}`) || !this.refs.has(`heads/${body.base}`)) return this.respond(422, { message: 'Validation Failed' });
      const number = this.pulls.length + 1;
      this.pulls.push({ number, ...body });
      return this.respond(201, { number, html_url: `https://github.com/${this.repository}/pull/${number}` });
    }
    if (rest === '/commits' && method === 'GET') {
      const out = [];
      let cursor = this.refs.get(`heads/${u.searchParams.get('sha')}`);
      while (cursor) {
        const c = this.commits.get(cursor);
        out.push({ sha: cursor, html_url: `https://github.com/${this.repository}/commit/${cursor}`,
          commit: { message: c.message, author: { name: 'Test User', date: '2026-11-16T00:00:00Z' } }, author: { login: 'tester' } });
        cursor = c.parents[0];
      }
      return this.respond(200, out.slice(0, Number(u.searchParams.get('per_page') || 30)));
    }
    if (rest === '/tags' && method === 'GET') {
      return this.respond(200, [...this.refs].filter(([k]) => k.startsWith('tags/')).map(([k, sha]) => ({ name: k.slice(5), commit: { sha } })));
    }
    return this.respond(404, { message: `Not Found (${method} ${rest})` });
  };
}
