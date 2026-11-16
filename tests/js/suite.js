// Tests of the browser code in site/assets/js/core.
//
// They run in two places with the same result:
//   * in a browser:  <site>/tests/           (after `python3 tools/mund.py serve`)
//   * in Node (CI):  node tests/js/run-node.mjs
//
// `core` holds the modules under test, `env` gives access to files:
//   env.text(kind, name)  kind = 'vectors' | 'schema' | 'master'
//   env.dataFiles()       [{path, text}] of every file under data/
//   env.fakeGitHub()      the module tests/js/fake-github.js

export function register(h, core, env) {
  const { sha256, ids, jsonfmt, schema, checks, cite, convert, format } = core;
  const json = async (kind, name) => JSON.parse(await env.text(kind, name));

  async function database() {
    const schemas = {};
    for (const name of Object.values(checks.SCHEMA_FILES)) schemas[name] = await json('schema', name);
    const master = {};
    for (const name of checks.MASTER_FILES) master[name] = await env.text('master', name);
    return new checks.Database(schemas, master);
  }

  // ---------------------------------------------------------------- sha256
  h.test('sha256: standard test vectors', async (t) => {
    t.equal(sha256.sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    t.equal(sha256.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    t.equal(sha256.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    t.equal(sha256.sha256('a'.repeat(1000000)),
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  h.test('sha256: agrees with the platform implementation', async (t) => {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) return;
    const samples = ['LT|EXP-META|10.1103/VL7Z-RZP8', 'µs⁻¹ 日本語 🙂', 'x'.repeat(55), 'x'.repeat(56),
      'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'x'.repeat(119), 'x'.repeat(120), 'x'.repeat(1000)];
    for (const s of samples) {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(s));
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      t.equal(sha256.sha256(s), hex, `sha256 of ${s.length} characters:`);
    }
  });

  // ------------------------------------------------------------------- ids
  h.test('ids: MetaID vectors', async (t) => {
    const vectors = await json('vectors', 'ids.json');
    t.ok(vectors.meta.length >= 3);
    for (const v of vectors.meta) {
      t.equal(ids.metaId(v.sublibrary, v.dataset, v.doi, v.key), v.id, JSON.stringify(v));
    }
  });

  h.test('ids: DataID vectors (identifiers in use before this repository)', async (t) => {
    const vectors = await json('vectors', 'ids.json');
    t.ok(vectors.data.length >= 67);
    for (const v of vectors.data) {
      t.equal(ids.dataId(v.sublibrary, v.dataset, v.element, v.mass, v.meta_id, v.key), v.id, JSON.stringify(v));
    }
  });

  h.test('ids: hash source strings and normalisation', async (t) => {
    t.equal(ids.metaSource('LT', 'EXP', ' 10.1103/vl7z-rzp8; 10.48550/arXiv.2501.05897 '),
      'LT|EXP-META|10.1103/VL7Z-RZP8');
    t.equal(ids.metaSource('LT', 'CUR', '10.1000/unpublished', ' b '), 'LT|CUR-META|10.1000/UNPUBLISHED|B');
    t.equal(ids.dataSource('LT', 'EXP', 'Al', 27, 'dcb3b051457e', 'plate'), 'LT|EXP|Al|27000|dcb3b051457e|PLATE');
    t.equal(ids.dataSource('LT', 'EXP', 'Mg', 0, 'dcb3b051457e'), 'LT|EXP|Mg|0|dcb3b051457e');
    const masses = [['106.5', '106500'], [27, '27000'], ['27.0', '27000'], [0, '0'], ['0.0005', '1'],
      ['0.0004', '0'], ['238', '238000'], ['1e2', '100000']];
    for (const [input, expected] of masses) t.equal(ids.normalizeMass(input), expected, `mass ${input}:`);
    t.equal(ids.normalizeElement(' fe '), 'Fe');
    t.equal(ids.normalizeKey(null), '');
    t.equal(ids.normalizeKey(undefined), '');
  });

  // --------------------------------------------------------------- jsonfmt
  h.test('jsonfmt: numbers keep their digits', async (t) => {
    const text = '{\n  "a": 13.250,\n  "b": 2177.0,\n  "c": 0.0090,\n  "d": 12,\n  "e": 1.5e-3\n}\n';
    const obj = jsonfmt.parse(text);
    t.equal(obj.a, 13.25);
    t.equal(jsonfmt.stringify(obj), text);
    obj.a = 14;                               // a changed value is written as JavaScript writes it
    t.equal(jsonfmt.numberText(obj, 'a'), '14');
    t.ok(jsonfmt.setNumber(obj, 'a', ' 14.00 '));
    t.equal(jsonfmt.numberText(obj, 'a'), '14.00');
    t.ok(!jsonfmt.setNumber(obj, 'a', '1,5'));
    const copy = jsonfmt.clone(obj);
    t.equal(jsonfmt.stringify(copy), jsonfmt.stringify(obj));
  });

  h.test('jsonfmt: canonical layout', async (t) => {
    const expected = '{\n  "format": "x",\n  "meta": {\n    "id": "a",\n    "tags": ["p", "q"],\n'
      + '    "empty": [],\n    "ref": {\n      "year": 1987\n    }\n  },\n  "data": [\n'
      + '    {"id": "1", "v": 1.0, "o": ["z"]},\n    {"id": "2", "v": null}\n  ]\n}\n';
    const obj = jsonfmt.parse(expected);
    t.equal(jsonfmt.stringify(obj), expected);
    t.deepEqual(obj, JSON.parse(expected));
    const s = 'µs⁻¹ "quoted" back\\slash\nnew\tline   é 日本語';
    t.equal(jsonfmt.stringify({ s }), `{\n  "s": ${JSON.stringify(s)}\n}\n`);
    t.equal(jsonfmt.parse(jsonfmt.stringify({ s })).s, s);
  });

  h.test('jsonfmt: number text agrees with JavaScript', async (t) => {
    const vectors = await json('vectors', 'numbers.json');
    for (const v of vectors.js) {
      t.equal(String(Number(v.input)).replace(/^-0$/, '0'), v.text, `vector ${v.input}:`);
      t.equal(jsonfmt.jsNumber(Number(v.input)), v.text);
    }
    for (const v of vectors.decimals) t.equal(jsonfmt.decimalsOfText(v.input), v.decimals, `decimals of ${v.input}:`);
  });

  h.test('jsonfmt: strict parser', async (t) => {
    const bad = ['', '{', '{"a": 1,}', '[1, 2,]', '{"a": NaN}', '{"a": Infinity}', "{'a': 1}", '{"a": 01}',
      '{"a": 1.}', '{"a": .5}', '{"a": +1}', '{"a": "line\nbreak"}', '{"a": 1} x', '{"a" 1}', '[1 2]',
      '{"a": "\\x"}', '﻿{}'];
    for (const text of bad) t.throws(() => jsonfmt.parse(text), `should be rejected: ${JSON.stringify(text)}`);
    try {
      jsonfmt.parse('{\n  "a": 1,\n  "b": ?\n}');
      t.ok(false, 'expected an error');
    } catch (err) {
      t.equal(err.line, 3);
      t.equal(err.column, 8);
    }
    const good = '{"a": [1, -0.5, 1e3, true, false, null, "x\\u00e9\\n", {"__proto__": 1}], "b": {}}';
    t.deepEqual(jsonfmt.parse(good), JSON.parse(good));
    t.equal(Object.keys(jsonfmt.parse('{"__proto__": 1}'))[0], '__proto__');
  });

  h.test('jsonfmt: every file of the repository round-trips', async (t) => {
    const files = await env.dataFiles();
    t.ok(files.length >= 8, 'data files found');
    for (const f of files) t.equal(jsonfmt.stringify(jsonfmt.parse(f.text)), f.text, `${f.path}:`);
  });

  // ---------------------------------------------------------------- schema
  h.test('schema: validator basics', async (t) => {
    const s = await json('schema', 'lt.schema.json');
    const codes = (doc) => schema.validate(doc, s).map((e) => `${e.pointer}:${e.keyword}`);
    t.deepEqual(codes({}), [':required', ':required', ':required', ':required', ':required']);
    const value = (extra = {}) => ({ value: 756, unit: 'ns', uncertainties: [{ source: 'total', value: 1 }], ...extra });
    const row = (extra = {}) => ({ datasetId: '0123456789ab', nuclide: { element: 'Si', mass: 28, isomer: 0 },
      observable: { kind: 'lifetime', lifetime: value() }, ...extra });
    const doc = (rows = [row()], extra = {}) => ({ format: 'muND/LT/1', sublibrary: 'LT', datasetType: 'experiment',
      meta: { id: '0123456789ab', bibId: '10.1234/x', facility: 'A' }, data: rows, ...extra });
    t.deepEqual(codes(doc()), []);
    t.deepEqual(codes(doc([row()], { meta: { id: '0123456789ab', bibId: '10.1/x', facility: 'A' } })), ['/meta/bibId:pattern']);
    t.deepEqual(codes(doc([row({ nuclide: { element: 'Si', mass: 28.5, isomer: 0 } })])), ['/data/0/nuclide/mass:type']);
    t.deepEqual(codes(doc([row({ nuclide: { element: 'Si', mass: 28.0, isomer: 0 } })])), []);
    t.deepEqual(codes(doc([row({ nuclide: { element: 'Si', mass: 28 } })])), ['/data/0/nuclide:required']);
    t.deepEqual(codes(doc([row({ observable: { kind: 'lifetime', lifetime: value({ uncertainties: [] }) } })])), []);
    t.deepEqual(codes(doc([row({ observable: { kind: 'lifetime', lifetime: value({ uncertainties: [
      { source: 'statistical', value: 0.8 }, { source: 'systematic', value: 0.7 }] }) } })])), []);
    t.deepEqual(codes(doc([row({ observable: { kind: 'lifetime', lifetime: value({ uncertainties: [{ source: 'total', value: '1' }] }) } })])),
      ['/data/0/observable/lifetime/uncertainties/0/value:type']);
    t.deepEqual(codes(doc([row({ observable: { kind: 'lifetime', lifetime: value({ unit: '%' }) } })])),
      ['/data/0/observable/lifetime/unit:enum']);
    t.deepEqual(codes(doc([row({ observable: { kind: 'capture_rate', lifetime: value() } })])),
      ['/data/0/observable:required', '/data/0/observable/lifetime:not']);
    t.deepEqual(codes(doc([row()], { datasetType: 'theory' })), ['/meta/facility:not']);
    t.deepEqual(codes(doc([row({ legacyIds: ['a', 'a'] })])), ['/data/0/legacyIds:uniqueItems']);
    t.throws(() => schema.validate(1, { format: 'date' }), 'unsupported keywords must not be ignored');

    const bib = await json('schema', 'bibliography.schema.json');
    const bibCodes = (ref) => schema.validate({ format: 'muND/bibliography/1', references: [ref] }, bib).map((e) => `${e.pointer}:${e.keyword}`);
    t.deepEqual(bibCodes({ DOI: '10.1103/PhysRevC.35.2212', author: [{ family: 'Suzuki', given: 'T.' }], title: ['x'],
      'container-title': ['Physical Review C'], volume: '35', page: '2212-2224', published: { 'date-parts': [[1987, 6, 1]] } }), []);
    t.deepEqual(bibCodes({ title: ['x'] }), ['/references/0:required']);
    t.deepEqual(bibCodes({ DOI: '10.1234/x', title: 'not a list' }), ['/references/0/title:type']);
  });

  h.test('schema: normalisation orders keys and drops empty members', async (t) => {
    const s = await json('schema', 'lt.schema.json');
    const obj = jsonfmt.parse('{"data": [{"comment": " ", "key": "", "zzz": 1, "observable": {"lifetime": {"uncertainties": [], '
      + '"unit": "ns", "value": 1.0}, "kind": "lifetime"}, "nuclide": {"isomer": 0, "mass": 0, "element": " Si "}, "datasetId": "x"}], '
      + '"meta": {"comment": "", "bibId": "10.1234/x", "id": "m", "relatedBibIds": []}, "datasetType": "experiment", '
      + '"sublibrary": "LT", "format": "muND/LT/1"}');
    const out = schema.normalize(obj, s);
    t.deepEqual(Object.keys(out), ['format', 'sublibrary', 'datasetType', 'meta', 'data']);
    t.deepEqual(out.meta, { id: 'm', bibId: '10.1234/x' });
    t.deepEqual(Object.keys(out.data[0]), ['datasetId', 'nuclide', 'observable', 'zzz']);
    t.deepEqual(out.data[0].nuclide, { element: 'Si', mass: 0, isomer: 0 });
    t.deepEqual(Object.keys(out.data[0].observable.lifetime), ['value', 'unit', 'uncertainties']);
    t.deepEqual(out.data[0].observable.lifetime.uncertainties, [], 'required members are kept even when empty');
    t.equal(jsonfmt.numberText(out.data[0].observable.lifetime, 'value'), '1.0');
  });

  // ---------------------------------------------------------------- checks
  h.test('checks: shared validation cases', async (t) => {
    const { cases } = await json('vectors', 'cases.json');
    t.ok(cases.length >= 35);
    for (const c of cases) {
      const db = await database();
      const paths = c.files.map((f) => f.path);
      for (const f of c.files) {
        if (f.path.startsWith('data/master/')) db.setMaster(f.path.slice('data/master/'.length), f.text);
        else db.setFile(f.path, f.text);
      }
      const got = db.validate().map((i) => `${i.level} ${i.code} #${paths.indexOf(i.file)} ${i.pointer}`).sort();
      const want = c.expect.map((e) => `${e.level} ${e.code} #${e.file} ${e.pointer}`).sort();
      t.deepEqual(got, want, `${c.name}:`);
    }
  });

  h.test('checks: the repository data is valid', async (t) => {
    const db = await database();
    const files = await env.dataFiles();
    for (const f of files) if (!f.path.startsWith('data/master/')) db.setFile(f.path, f.text);
    const errors = db.validate().filter((i) => i.level === 'error');
    t.deepEqual(errors, []);
    const counts = {};
    for (const r of db.rows('LT')) counts[r.dataset] = (counts[r.dataset] || 0) + 1;
    t.deepEqual(counts, { CUR: 8, EVAL: 580, EXP: 67 });
    for (const f of db.sortedFiles()) t.equal(cite.datasetPath(f.obj, db.reference(f.meta.bibId)), f.path);
    t.equal(db.tables().elements.length, 118);
    t.equal(db.zOf('Si'), 14);
    t.equal(db.reference('10.1103/physrevc.35.2212').author[0].family, 'Suzuki', 'DOIs are compared case-insensitively');
    t.equal(db.reference('10.1000/unpublished'), null);
  });

  h.test('checks: assignIds', async (t) => {
    const obj = { format: 'muND/LT/1', sublibrary: 'LT', datasetType: 'experiment', meta: { bibId: '10.1103/vl7z-rzp8' },
      data: [{ nuclide: { element: 'Al', mass: 27, isomer: 0 }, key: 'plate' }, { nuclide: { element: 'Mg', mass: 0, isomer: 0 } }] };
    checks.assignIds(obj);
    t.equal(obj.meta.id, 'dcb3b051457e');
    t.equal(obj.data[0].datasetId, '343adc036597');
    t.equal(obj.data[1].datasetId, '5fb28c42563b');
    t.equal(checks.datasetCode(obj), 'EXP');
    t.equal(checks.quantity({ observable: { kind: 'lifetime', lifetime: { value: 1 } } }).value, 1);
    t.equal(checks.quantity({ observable: { kind: 'capture_rate', lifetime: { value: 1 } } }), null);
  });

  // --------------------------------------------------------------- convert
  h.test('convert: shared vectors', async (t) => {
    const vectors = await json('vectors', 'convert.json');
    const physics = new convert.Physics(await json('master', 'huff_factors.json'), await json('master', 'constants.json'));
    t.equal(physics.muLifeNs, 2196.9811);
    t.equal(physics.huffFactor(14, 28), 0.9924);
    t.equal(physics.huffFactor(14), 0.9924);
    t.equal(physics.huffFactor(14, 99), 0.9924);
    t.equal(physics.huffFactor(3, 6), 1.0);
    t.equal(physics.huffFactor(26, 58), 0.9716);
    t.equal(physics.huffSource(26, 58), 'nuclide');
    t.equal(physics.huffSource(26, 0), 'element');
    t.equal(physics.huffSource(3, 6), 'none');
    t.ok(vectors.cases.length >= 10);
    for (const v of vectors.cases) {
      const got = physics.convert(v.z, v.a, v.observable, v.value, v.uncertainty, v.unit);
      for (const [k, expected] of Object.entries(v.expected)) {
        if (expected === null) t.equal(got[k], null, `${k}:`);
        else t.close(got[k], expected, vectors.relative_tolerance, `${JSON.stringify(v)} ${k}:`);
      }
    }
    t.equal(convert.combinedUncertainty([{ source: 'total', value: 5 }]), 5);
    t.equal(convert.combinedUncertainty([]), null);
    t.close(convert.combinedUncertainty([{ source: 'statistical', value: 0.8 }, { source: 'systematic', value: 0.7 }]),
      Math.sqrt(0.8 ** 2 + 0.7 ** 2), 1e-12);
    t.equal(convert.combinedUncertainty([{ source: 'statistical', value: 3 }, { source: 'total', value: 4 }]), 4,
      'a stated total wins over the components');
    t.equal(physics.convert(14, 28, 'lifetime', 0, 1, 'ns'), null);
    t.equal(physics.convert(14, 28, 'capture_probability', 100, 1, '%'), null);
    t.equal(physics.convert(14, 28, 'lifetime', 756, 1, 'us-1'), null);
    const custom = physics.convert(14, 28, 'lifetime', 756, 1, 'ns', 1.0);
    t.close(custom['capture_rate_us-1'], 1 / 0.756 - 1 / 2.1969811, 1e-12);
  });

  // ------------------------------------------------------------------ admin
  async function repositoryFiles() {
    const files = {};
    for (const f of await env.dataFiles()) files[f.path] = f.text;
    for (const name of Object.values(checks.SCHEMA_FILES)) files[`schema/v1/${name}`] = await env.text('schema', name);
    files.VERSION = '0.1.0\n';
    files['README.md'] = 'not part of the database\n';
    return files;
  }

  function memoryStorage() {
    const map = new Map();
    return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
  }

  h.test('admin: GitHub client reads the repository', async (t) => {
    const { FakeGitHub } = await env.fakeGitHub();
    const server = new FakeGitHub({ files: await repositoryFiles() });
    const gh = new core.backend.GitHubBackend({ repository: 'someone/mund', branch: 'main', token: 'secret', fetchImpl: server.fetch });
    const info = await gh.connect();
    t.equal(info.user.login, 'tester');
    t.equal(info.canWrite, true);
    t.equal(info.repo.private, true);
    const files = await gh.listFiles();
    t.ok(files.some((f) => f.path === 'data/master/facilities.json'));
    t.ok(files.some((f) => f.path === 'VERSION'));
    t.ok(!files.some((f) => f.path === 'README.md'), 'only the database files are listed');
    const suzuki = files.find((f) => f.path.includes('Suzuki1987'));
    t.equal(await gh.readFile(suzuki.path, suzuki.sha), server.fileAt('main', suzuki.path));
    t.equal((await gh.history('data', 5)).length, 1);

    const wrong = new core.backend.GitHubBackend({ repository: 'someone/mund', token: 'nope', fetchImpl: server.fetch });
    let status = 0;
    try { await wrong.connect(); } catch (err) { status = err.status; }
    t.equal(status, 401);
    const missing = new core.backend.GitHubBackend({ repository: 'someone/mund', branch: 'nope', token: 'secret', fetchImpl: server.fetch });
    try { await missing.connect(); status = 0; } catch (err) { status = err.status; }
    t.equal(status, 404);
  });

  h.test('admin: one commit for all changes, conflicts are refused', async (t) => {
    const { FakeGitHub } = await env.fakeGitHub();
    const server = new FakeGitHub({ files: { 'data/a.json': 'A1\n', 'data/b.json': 'B1\n', 'data/c.json': 'C1\n' } });
    const gh = new core.backend.GitHubBackend({ repository: 'someone/mund', token: 'secret', fetchImpl: server.fetch });
    await gh.connect();
    const sha = Object.fromEntries((await gh.listFiles()).map((f) => [f.path, f.sha]));

    // someone else changes c.json in the meantime: unrelated, must be kept
    server.pushElsewhere('main', { 'data/c.json': 'C2\n' });
    server.log.length = 0;
    const result = await gh.commit({
      message: 'Update a, remove b, add d',
      changes: [
        { path: 'data/a.json', content: 'A2\n', baseSha: sha['data/a.json'] },
        { path: 'data/b.json', content: null, baseSha: sha['data/b.json'] },
        { path: 'data/d.json', content: 'D1\n', baseSha: null },
      ],
    });
    t.ok(/^https:\/\/github\.com\/someone\/mund\/commit\//.test(result.url));
    t.equal(server.fileAt('main', 'data/a.json'), 'A2\n');
    t.equal(server.fileAt('main', 'data/b.json'), null);
    t.equal(server.fileAt('main', 'data/c.json'), 'C2\n', 'the other change survives');
    t.equal(server.fileAt('main', 'data/d.json'), 'D1\n');
    t.equal(server.log.filter((l) => l.startsWith('POST') || l.startsWith('PATCH')).join(' | '),
      'POST /repos/someone/mund/git/trees | POST /repos/someone/mund/git/commits | PATCH /repos/someone/mund/git/refs/heads/main');
    t.equal(server.commits.get(result.sha).message, 'Update a, remove b, add d');

    // a.json changed by someone else since we loaded it: refuse, change nothing
    const head = server.refs.get('heads/main');
    server.pushElsewhere('main', { 'data/a.json': 'A3\n' });
    const afterOther = server.refs.get('heads/main');
    let conflict = null;
    try {
      await gh.commit({ message: 'stale', changes: [{ path: 'data/a.json', content: 'A-mine\n', baseSha: server.trees.get(server.commits.get(head).tree).get('data/a.json') },
        { path: 'data/d.json', content: 'D2\n', baseSha: server.trees.get(server.commits.get(head).tree).get('data/d.json') }] });
    } catch (err) { conflict = err; }
    t.ok(conflict instanceof core.backend.ConflictError, 'a ConflictError is expected');
    t.deepEqual(conflict.paths, ['data/a.json']);
    t.equal(server.refs.get('heads/main'), afterOther, 'the branch did not move');
    t.equal(server.fileAt('main', 'data/d.json'), 'D1\n');

    // a file we believed to be new already exists
    conflict = null;
    try { await gh.commit({ message: 'dup', changes: [{ path: 'data/c.json', content: 'X\n', baseSha: null }] }); } catch (err) { conflict = err; }
    t.ok(conflict instanceof core.backend.ConflictError);
  });

  h.test('admin: pull request mode and read-only access', async (t) => {
    const { FakeGitHub } = await env.fakeGitHub();
    const server = new FakeGitHub({ files: { 'data/a.json': 'A1\n' } });
    const gh = new core.backend.GitHubBackend({ repository: 'someone/mund', token: 'secret', fetchImpl: server.fetch });
    await gh.connect();
    const [file] = await gh.listFiles();
    const before = server.refs.get('heads/main');
    const result = await gh.commit({ message: 'Fix a\n\ndetails', mode: 'pr', changes: [{ path: file.path, content: 'A2\n', baseSha: file.sha }] });
    t.equal(server.refs.get('heads/main'), before, 'main is untouched');
    t.equal(result.pullRequest.number, 1);
    t.equal(server.pulls[0].title, 'Fix a');
    t.equal(server.pulls[0].base, 'main');
    t.equal(server.fileAt(result.pullRequest.branch, 'data/a.json'), 'A2\n');
    const tag = await gh.createTag('v1.0.0', before);
    t.equal(tag.name, 'v1.0.0');
    t.deepEqual((await gh.tags()).map((x) => x.name), ['v1.0.0']);

    const readOnly = new FakeGitHub({ files: { 'data/a.json': 'A1\n' }, canPush: false });
    const ro = new core.backend.GitHubBackend({ repository: 'someone/mund', token: 'secret', fetchImpl: readOnly.fetch });
    t.equal((await ro.connect()).canWrite, false);
    const [f] = await ro.listFiles();
    let status = 0;
    try { await ro.commit({ message: 'x', changes: [{ path: f.path, content: 'A2\n', baseSha: f.sha }] }); } catch (err) { status = err.status; }
    t.equal(status, 403);
    t.equal(readOnly.fileAt('main', 'data/a.json'), 'A1\n');
  });

  h.test('admin: workspace keeps drafts, follows renamed identifiers and commits', async (t) => {
    const { FakeGitHub } = await env.fakeGitHub();
    const server = new FakeGitHub({ files: await repositoryFiles() });
    const gh = new core.backend.GitHubBackend({ repository: 'someone/mund', token: 'secret', fetchImpl: server.fetch });
    await gh.connect();
    const storage = memoryStorage();
    const ws = new core.workspace.Workspace(gh, storage);
    await ws.load();
    t.deepEqual(ws.issues().filter((i) => i.level === 'error'), []);
    t.equal(ws.changes().length, 0);
    t.equal(ws.upstreamIds().has('3fc99c56a5ad'), true);
    t.equal(ws.upstreamIds().has('dcb3b051457e'), false, 'MetaIDs are not datasetIds');

    // correct an element: Si-30 -> S-30 in the Mizuno file
    const path = 'data/LT/EXP/Mizuno2025_dcb3b051457e.json';
    const doc = jsonfmt.parse(ws.text(path));
    const row = doc.data.find((r) => r.datasetId === '3fc99c56a5ad');
    row.nuclide.element = 'S';
    checks.assignIds(doc);
    t.ok(row.datasetId !== '3fc99c56a5ad');
    ws.stage(path, jsonfmt.stringify(schema.normalize(doc, ws.db.schemaFor(doc.format))));
    t.equal(ws.status(path), 'modified');
    t.deepEqual(ws.issues().filter((i) => i.level === 'error').map((i) => i.code), ['E_ORIGINAL_MISSING']);
    const touched = ws.replaceIds(new Map([['3fc99c56a5ad', row.datasetId]]), path);
    t.deepEqual(touched, ['data/LT/CUR/unpublished_591344c27b81.json']);
    t.deepEqual(ws.issues().filter((i) => i.level === 'error'), []);
    t.equal(ws.changes().length, 2);

    // drafts survive a reload of the page
    const again = new core.workspace.Workspace(gh, storage);
    await again.load();
    t.equal(again.changes().length, 2);
    t.equal(again.text(path), ws.text(path));

    // staging the original text removes the draft
    again.stage(path, again.upstreamText(path));
    t.equal(again.status(path), 'unchanged');

    // a file that moves (new first author) is a delete plus an add, compared with its origin
    const moved = 'data/LT/EXP/Nizuno2025_dcb3b051457e.json';
    ws.move(path, moved, ws.text(path));
    t.equal(ws.status(path), 'deleted');
    t.equal(ws.status(moved), 'added');
    t.equal(ws.baseline(moved), ws.upstreamText(path));
    ws.move(moved, path, ws.text(moved));
    t.equal(ws.status(path), 'modified');
    t.equal(ws.text(moved), null);

    // a reference added to the bibliography: sorted by DOI, found without regard to case, file stays valid
    const bibPath = 'data/master/bibliography.json';
    t.equal(ws.db.reference('10.1000/unpublished'), null);
    ws.setReference({ DOI: '10.1000/unpublished', title: ['Curation in progress'], author: [{ family: 'Niikura', given: 'M.' }],
      published: { 'date-parts': [[2026]] } });
    t.equal(ws.status(bibPath), 'modified');
    t.equal(ws.db.reference('10.1000/UNPUBLISHED').title[0], 'Curation in progress');
    t.deepEqual(jsonfmt.parse(ws.text(bibPath)).references.map((r) => r.DOI),
      ['10.1000/unpublished', '10.1103/PhysRevC.111.034614', '10.1103/PhysRevC.35.2212', '10.1103/vl7z-rzp8']);
    ws.setReference({ DOI: '10.1000/UNPUBLISHED', title: ['Curation of lifetimes'] });
    t.equal(jsonfmt.parse(ws.text(bibPath)).references.length, 4, 'an entry is replaced, not duplicated');
    t.deepEqual(ws.issues().filter((i) => i.file === bibPath), []);
    t.deepEqual(ws.issues().filter((i) => i.code === 'W_NO_REFERENCE'), []);

    const result = await ws.commit('LT/EXP: correct an element');
    t.equal(ws.changes().length, 0);
    t.equal(storage.map.size, 0, 'drafts are cleared after the commit');
    t.equal(server.fileAt('main', path).includes(`"datasetId": "${row.datasetId}", "nuclide": {"element": "S"`), true);
    t.equal(server.fileAt('main', 'data/LT/CUR/unpublished_591344c27b81.json').includes(row.datasetId), true);
    t.equal(server.fileAt('main', bibPath).includes('Curation of lifetimes'), true);
    t.equal(ws.upstreamText(path), server.fileAt('main', path));
    t.equal(server.commits.get(result.sha).message, 'LT/EXP: correct an element');
  });

  h.test('admin: line differences', async (t) => {
    const { diffLines, diffStats } = core.diff;
    const lines = diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
    t.equal(lines.map((l) => `${l.type}${l.text}`).join(' '), ' a -b +B  c  d +e');
    t.deepEqual(diffStats(lines), { added: 2, removed: 1 });
    t.deepEqual(diffStats(diffLines(null, 'x\ny\n')), { added: 2, removed: 0 });
    t.deepEqual(diffStats(diffLines('x\ny\n', null)), { added: 0, removed: 2 });
    t.deepEqual(diffStats(diffLines('same\n', 'same\n')), { added: 0, removed: 0 });
    t.equal(diffLines('a\nb\n', 'b\n').map((l) => l.type).join(''), '- ');
  });

  h.test('admin: rows pasted from a spreadsheet', async (t) => {
    const elements = (await json('master', 'nuclides.json')).elements;
    const parse = (text) => core.paste.parsePastedRows(text, elements);
    const r = parse('Element\tA\tValue\tUnc\n28Si\t756.0\t1.0\nSi\t28\t743.9\t5.0\tthick\tfirst run\nnatPd\t95.8\t0.6\nPd-108, 96.0, 0.7\n'
      + 'al 27 864.0 1.0\nAg\tnat\t87.0\nXx\t1\t2\t3\nSi\t756.0\t1.0\n\n');
    t.deepEqual(r.rows, [
      { element: 'Si', mass: 28, value: '756.0', uncertainty: '1.0', key: '', comment: '' },
      { element: 'Si', mass: 28, value: '743.9', uncertainty: '5.0', key: 'thick', comment: 'first run' },
      { element: 'Pd', mass: 0, value: '95.8', uncertainty: '0.6', key: '', comment: '' },
      { element: 'Pd', mass: 108, value: '96.0', uncertainty: '0.7', key: '', comment: '' },
      { element: 'Al', mass: 27, value: '864.0', uncertainty: '1.0', key: '', comment: '' },
      { element: 'Ag', mass: 0, value: '87.0', uncertainty: '', key: '', comment: '' },
    ]);
    t.deepEqual(r.skipped, ['Element\tA\tValue\tUnc', 'Xx\t1\t2\t3', 'Si\t756.0\t1.0']);
  });

  // ------------------------------------------------------------ cite/format
  h.test('cite: labels and citation text', async (t) => {
    const ref = { DOI: '10.1234/x', author: [{ family: 'Suzuki', given: 'T.' }, { family: 'Measday', given: 'D. F.' },
      { family: 'Roalsvig', given: 'J. P.' }], title: ['Total nuclear capture rates for negative muons'],
    'container-title': ['Physical Review C'], 'short-container-title': ['Phys. Rev. C'], volume: '35', page: '2212-2224',
    published: { 'date-parts': [[1987, 6, 1]] } };
    t.equal(cite.citeText(ref), 'Suzuki et al., Phys. Rev. C 35, 2212 (1987)');
    t.equal(cite.citeText({ ...ref, 'article-number': '024307' }), 'Suzuki et al., Phys. Rev. C 35, 024307 (1987)');
    t.equal(cite.citeLabel(ref), 'Suzuki1987');
    t.equal(cite.authorList(ref), 'T. Suzuki, D. F. Measday and J. P. Roalsvig');
    t.equal(cite.referenceTitle(ref), 'Total nuclear capture rates for negative muons');
    t.equal(cite.citeText(null, '10.1000/unpublished'), '10.1000/unpublished');
    t.equal(cite.citeText({ title: ['A report'] }, '10.1000/mund.x'), 'A report');
    const by = (family, year) => ({ author: [{ family }], ...(year ? { published: { 'date-parts': [[year, 3]] } } : {}) });
    t.equal(cite.fileLabel({ bibId: '10.1234/x' }, by('Kálmán', 2025)), 'Kalman2025');
    t.equal(cite.fileLabel({ bibId: '10.1000/unpublished' }, null), 'unpublished');
    t.equal(cite.fileLabel({ bibId: '10.1016/0375-9474(88)90330-2' }), '0375947488903302');
    t.equal(cite.fileLabel({ bibId: '10.1234/x' }, by('de Groot')), 'deGroot');
    t.equal(cite.fileLabel({ bibId: '10.1234/x' }, { author: [{ name: 'MuX Collaboration' }], published: { 'date-parts': [[2024]] } }),
      'MuXCollaboration2024');
    t.equal(cite.datasetPath({ sublibrary: 'LT', datasetType: 'curated', meta: { id: 'abc', bibId: '10.1000/unpublished' } }, null),
      'data/LT/CUR/unpublished_abc.json');
    t.equal(cite.doiUrl('10.1000/unpublished'), null);
    t.equal(cite.doiUrl('10.1016/0375-9474(88)90330-2'), 'https://doi.org/10.1016/0375-9474(88)90330-2');
  });

  h.test('format: values as given and derived values', async (t) => {
    const q = (text) => format.formatQuantity(jsonfmt.parse(text)).text;
    t.equal(q('{"value": 743.9, "unit": "ns", "uncertainties": [{"source": "total", "value": 5.0}]}'), '743.9 ± 5.0');
    t.equal(q('{"value": 0.8926, "unit": "us-1", "uncertainties": [{"source": "total", "value": 0.0090}]}'), '0.8926 ± 0.0090');
    t.equal(q('{"value": 13.250, "unit": "us-1", "uncertainties": [{"source": "total", "value": 1.550}]}'), '13.250 ± 1.550');
    t.equal(q('{"value": 87.0, "unit": "ns", "uncertainties": []}'), '87.0');
    t.equal(q('{"value": 751.4, "unit": "ns", "uncertainties": [{"source": "statistical", "value": 0.8}, {"source": "systematic", "value": 0.7}]}'),
      '751.4 ± 0.8 (stat) ± 0.7 (syst)');
    t.equal(format.formatQuantity({ value: 863.7, unit: 'ns', uncertainties: [{ source: 'total', value: 1 }] }).text, '863.7 ± 1.0');
    t.equal(format.formatDerived(0.8710364, 0.0017497).text, '0.8710 ± 0.0017');
    t.equal(format.formatDerived(2177.04, 2.0).text, '2177.0 ± 2.0');
    t.equal(format.formatDerived(60.912, 0.0996).text, '60.91 ± 0.10');
    t.equal(format.formatDerived(12900000, 100000).text, '12900000 ± 100000');
    t.equal(format.formatDerived(0.000435, 0.000016).text, '0.000435 ± 0.000016');
    t.equal(format.formatDerived(11.0751, null).text, '11.08');
    t.equal(format.formatDerived(null, null).text, '');
    t.equal(format.plainNumber(0.871036412345), '0.871036');
    const mono = new Map([[13, 27]]);
    t.equal(format.nuclideText('Si', 14, 28, mono), '28Si');
    t.equal(format.nuclideText('Si', 14, 0, mono), 'natSi');
    t.equal(format.nuclideText('Al', 13, 0, mono), '27Al');
    t.equal(format.nuclideHtml('Si', 14, 0, mono), '<sup>nat</sup>Si');
    t.equal(format.toCsv([['a', 'b,c'], ['"q"', null]]), 'a,"b,c"\n"""q""",\n');
  });
}
