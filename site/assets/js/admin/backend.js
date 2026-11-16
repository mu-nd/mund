// Where the admin UI reads and writes the database.
//
//   GitHubBackend  the real repository, through the GitHub REST API
//   DemoBackend    a practice copy that lives only in this browser
//
// Both offer the same methods:
//   connect()                     -> { user, repo, branch, canWrite, head }
//   listFiles()                   -> [{ path, sha }]
//   readFile(path, sha)           -> text
//   commit({ message, changes, base, mode })
//                                 -> { sha, url, pullRequest? }
//        changes: [{ path, content | null (delete), baseSha }]
//        mode:    'direct' (commit to the branch) | 'pr' (new branch + pull request)
//   history(path, limit)          -> [{ sha, message, author, date, url }]
//   tags(), createTag(name, sha)
//
// No dependencies; `fetchImpl` can be replaced in tests.

const API = 'https://api.github.com';
const WATCHED = [/^data\//, /^schema\//, /^VERSION$/, /^CHANGELOG\.md$/];

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Someone else changed a file we are about to overwrite. */
export class ConflictError extends Error {
  constructor(paths) {
    super(`changed in the repository in the meantime: ${paths.join(', ')}`);
    this.name = 'ConflictError';
    this.paths = paths;
  }
}

const watched = (path) => WATCHED.some((re) => re.test(path));

export class GitHubBackend {
  constructor({ repository, branch = 'main', token = '', fetchImpl } = {}) {
    this.kind = 'github';
    this.repository = repository;
    this.branch = branch;
    this.token = token;
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.info = null;
  }

  async request(method, path, { body, raw = false, okStatuses = [] } = {}) {
    const headers = {
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetch(`${API}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store',
      });
    } catch (err) {
      throw new ApiError(`network error: ${err.message}`, 0, null);
    }
    if (!response.ok && !okStatuses.includes(response.status)) {
      let detail = null;
      try { detail = await response.json(); } catch (e) { /* not JSON */ }
      const message = detail && detail.message ? detail.message : `HTTP ${response.status}`;
      throw new ApiError(message, response.status, detail);
    }
    if (raw) return response.text();
    if (response.status === 204) return null;
    return response.json();
  }

  repoPath(suffix = '') {
    return `/repos/${this.repository}${suffix}`;
  }

  async connect() {
    const user = this.token ? await this.request('GET', '/user') : null;
    const repo = await this.request('GET', this.repoPath());
    const branch = await this.request('GET', this.repoPath(`/branches/${encodeURIComponent(this.branch)}`));
    this.info = {
      user: user ? { login: user.login, name: user.name || user.login } : null,
      repo: { name: repo.full_name, private: repo.private, url: repo.html_url },
      branch: this.branch,
      canWrite: Boolean(repo.permissions && repo.permissions.push),
      head: branch.commit.sha,
      tree: branch.commit.commit.tree.sha,
    };
    return this.info;
  }

  async head() {
    const ref = await this.request('GET', this.repoPath(`/git/ref/heads/${encodeURIComponent(this.branch)}`));
    const commit = await this.request('GET', this.repoPath(`/git/commits/${ref.object.sha}`));
    return { sha: commit.sha, tree: commit.tree.sha };
  }

  async listTree(treeSha) {
    const tree = await this.request('GET', this.repoPath(`/git/trees/${treeSha}?recursive=1`));
    if (tree.truncated) throw new ApiError('the repository is too large to list in one request', 0, null);
    return tree.tree.filter((e) => e.type === 'blob' && watched(e.path)).map((e) => ({ path: e.path, sha: e.sha }));
  }

  async listFiles() {
    const head = await this.head();
    this.info = { ...(this.info || {}), head: head.sha, tree: head.tree };
    return this.listTree(head.tree);
  }

  async readFile(path, sha) {
    return this.request('GET', this.repoPath(`/git/blobs/${sha}`), { raw: true });
  }

  /**
   * Write all changes as ONE commit.  Refuses when a file was changed in the
   * repository since it was loaded (compare `baseSha` with the current blob).
   */
  async commit({ message, changes, mode = 'direct', pullRequest = {} }) {
    if (!changes.length) throw new Error('nothing to commit');
    const head = await this.head();
    const current = new Map((await this.listTree(head.tree)).map((f) => [f.path, f.sha]));
    const conflicts = changes
      .filter((c) => (current.get(c.path) || null) !== (c.baseSha || null))
      .map((c) => c.path);
    if (conflicts.length) throw new ConflictError(conflicts);

    const tree = await this.request('POST', this.repoPath('/git/trees'), {
      body: {
        base_tree: head.tree,
        tree: changes.map((c) => (c.content === null
          ? { path: c.path, mode: '100644', type: 'blob', sha: null }
          : { path: c.path, mode: '100644', type: 'blob', content: c.content })),
      },
    });
    const commit = await this.request('POST', this.repoPath('/git/commits'), {
      body: { message, tree: tree.sha, parents: [head.sha] },
    });
    const result = { sha: commit.sha, url: `https://github.com/${this.repository}/commit/${commit.sha}` };

    if (mode === 'pr') {
      const name = pullRequest.branch || `edit/${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
      await this.request('POST', this.repoPath('/git/refs'), { body: { ref: `refs/heads/${name}`, sha: commit.sha } });
      const pr = await this.request('POST', this.repoPath('/pulls'), {
        body: { title: message.split('\n')[0], head: name, base: this.branch, body: pullRequest.body || '' },
      });
      result.pullRequest = { number: pr.number, url: pr.html_url, branch: name };
      return result;
    }
    try {
      await this.request('PATCH', this.repoPath(`/git/refs/heads/${encodeURIComponent(this.branch)}`), {
        body: { sha: commit.sha, force: false },
      });
    } catch (err) {
      // the branch moved between our check and the update: nothing was changed
      if (err.status === 422) throw new ConflictError(changes.map((c) => c.path));
      throw err;
    }
    this.info = { ...(this.info || {}), head: commit.sha, tree: tree.sha };
    return result;
  }

  async history(path = '', limit = 30) {
    const query = new URLSearchParams({ sha: this.branch, per_page: String(limit) });
    if (path) query.set('path', path);
    const commits = await this.request('GET', this.repoPath(`/commits?${query}`));
    return commits.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: (c.commit.author && c.commit.author.name) || (c.author && c.author.login) || '',
      login: c.author ? c.author.login : '',
      date: c.commit.author ? c.commit.author.date : '',
      url: c.html_url,
    }));
  }

  async tags() {
    const tags = await this.request('GET', this.repoPath('/tags?per_page=100'));
    return tags.map((t) => ({ name: t.name, sha: t.commit.sha }));
  }

  async createTag(name, sha) {
    await this.request('POST', this.repoPath('/git/refs'), { body: { ref: `refs/tags/${name}`, sha } });
    return { name, sha, url: `https://github.com/${this.repository}/releases/tag/${name}` };
  }
}

// ---------------------------------------------------------------------------
// practice mode
// ---------------------------------------------------------------------------

const DEMO_KEY = 'mund-admin:demo-repository';

async function sha1Hex(text) {
  const bytes = new TextEncoder().encode(text);
  if (globalThis.crypto && globalThis.crypto.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-1', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0;
  for (const b of bytes) h = (Math.imul(h, 31) + b) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(5);
}

/**
 * A copy of the published data that can be edited freely.  "Commits" are
 * kept in this browser only (localStorage) and never leave it.
 */
export class DemoBackend {
  constructor({ siteUrl, storage } = {}) {
    this.kind = 'demo';
    this.repository = 'practice copy';
    this.branch = 'demo';
    this.siteUrl = siteUrl;
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.state = null;
  }

  load() {
    if (this.state) return this.state;
    let saved = null;
    try { saved = JSON.parse(this.storage.getItem(DEMO_KEY)); } catch (e) { /* ignore */ }
    this.state = saved && saved.files ? saved : { files: {}, commits: [], tags: [] };
    return this.state;
  }

  save() {
    try { this.storage.setItem(DEMO_KEY, JSON.stringify(this.state)); } catch (e) { /* storage full or blocked */ }
  }

  reset() {
    this.state = { files: {}, commits: [], tags: [] };
    try { this.storage.removeItem(DEMO_KEY); } catch (e) { /* ignore */ }
  }

  async fetchText(path) {
    const response = await fetch(this.siteUrl(path), { cache: 'no-cache' });
    if (!response.ok) throw new ApiError(`${path}: HTTP ${response.status}`, response.status, null);
    return response.text();
  }

  async connect() {
    this.load();
    this.info = {
      user: { login: 'you', name: 'Practice user' },
      repo: { name: 'practice copy (this browser only)', private: true, url: '' },
      branch: this.branch, canWrite: true, head: this.headSha(),
    };
    return this.info;
  }

  headSha() {
    const commits = this.load().commits;
    return commits.length ? commits[0].sha : '0000000';
  }

  async head() {
    return { sha: this.headSha(), tree: this.headSha() };
  }

  /** Published files, overlaid with what was "committed" in practice mode. */
  async listFiles() {
    const state = this.load();
    const manifest = JSON.parse(await this.fetchText('data/latest/manifest.json'));
    this.published = new Map();
    for (const f of manifest.files) {
      if (f.path.startsWith('raw/')) this.published.set(`data/${f.path.slice(4)}`, `data/latest/${f.path}`);
    }
    for (const name of ['lt.schema.json', 'facilities.schema.json']) {
      this.published.set(`schema/v1/${name}`, `schema/v1/${name}`);
    }
    const out = new Map();
    for (const path of this.published.keys()) out.set(path, `published:${path}`);
    for (const [path, entry] of Object.entries(state.files)) {
      if (entry.content === null) out.delete(path);
      else out.set(path, entry.sha);
    }
    if (!out.has('VERSION')) out.set('VERSION', 'published:VERSION');
    return [...out].map(([path, sha]) => ({ path, sha }));
  }

  async readFile(path, sha) {
    const entry = this.load().files[path];
    if (entry && entry.sha === sha && entry.content !== null) return entry.content;
    if (path === 'VERSION') {
      const manifest = JSON.parse(await this.fetchText('data/latest/manifest.json'));
      return `${manifest.version.split(/[-+]/)[0]}\n`;
    }
    if (path === 'CHANGELOG.md') return '# Changelog\n';
    return this.fetchText(this.published.get(path));
  }

  async commit({ message, changes, mode = 'direct' }) {
    if (!changes.length) throw new Error('nothing to commit');
    const state = this.load();
    const current = new Map((await this.listFiles()).map((f) => [f.path, f.sha]));
    const conflicts = changes.filter((c) => (current.get(c.path) || null) !== (c.baseSha || null)).map((c) => c.path);
    if (conflicts.length) throw new ConflictError(conflicts);
    const sha = (await sha1Hex(`${message}${Date.now()}${JSON.stringify(changes)}`)).slice(0, 40);
    for (const c of changes) {
      state.files[c.path] = c.content === null
        ? { content: null, sha: null }
        : { content: c.content, sha: await sha1Hex(`blob ${c.content.length}\0${c.content}`) };
    }
    state.commits.unshift({
      sha, message, author: 'Practice user', login: 'you', date: new Date().toISOString(), url: '',
      paths: changes.map((c) => c.path),
    });
    this.save();
    const result = { sha, url: '' };
    if (mode === 'pr') result.pullRequest = { number: state.commits.length, url: '', branch: 'edit/practice' };
    return result;
  }

  async history(path = '', limit = 30) {
    return this.load().commits.filter((c) => !path || c.paths.some((p) => p === path || p.startsWith(path)))
      .slice(0, limit);
  }

  async tags() {
    return this.load().tags;
  }

  async createTag(name, sha) {
    const state = this.load();
    state.tags.unshift({ name, sha });
    this.save();
    return { name, sha, url: '' };
  }
}
