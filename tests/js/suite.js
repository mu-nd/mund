// Tests of the shared browser code (site/assets/js/core).
//
// They run in two places with the same result:
//   * in a browser:  <site>/tests/           (after `python3 tools/mund.py serve`)
//   * in Node (CI):  node tests/js/run-node.mjs
//
// `modules` holds the modules under test, `env` gives access to files:
//   env.text(kind, name)  kind = 'vectors' (tests/vectors) | 'schema' (schema/v1)
//   env.dataFiles()       [{path, text}] of every file under data/ (the real data)
// Apart from 'database: the repository data is valid', the tests use the test
// database of tests/fixtures (tests/vectors/repository.json).

export function register(h, modules, env) {
  const { sha256, ids, jsonfmt, schema, database, cite, convert, format, nuclides } = modules;
  const json = async (kind, name) => JSON.parse(await env.text(kind, name));
  const fixture = async (path) => JSON.parse((await json('vectors', 'repository.json')).files[path]);

  /** A database with the schemas and the given {path: text} files. */
  async function newDatabase(files = {}) {
    const schemas = {};
    for (const name of Object.values(database.SCHEMA_FILES)) schemas[name] = await json('schema', name);
    const db = new database.Database(schemas);
    for (const [path, text] of Object.entries(files)) db.setFile(path, text);
    return db;
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
    t.ok(vectors.meta.length > 0);
    for (const v of vectors.meta) {
      t.equal(ids.metaId(v.sublibrary, v.code, v.bibId, v.key), v.id, JSON.stringify(v));
    }
  });

  h.test('ids: DataID vectors', async (t) => {
    const vectors = await json('vectors', 'ids.json');
    t.ok(vectors.data.length > 0);
    for (const v of vectors.data) {
      t.equal(ids.dataId(v.sublibrary, v.code, v.element, v.mass, v.meta_id, v.key), v.id, JSON.stringify(v));
    }
  });

  h.test('ids: hash source strings and normalisation', async (t) => {
    t.equal(ids.metaSource('LT', 'EXP', ' DOI:10.1103/vl7z-rzp8; DOI:10.48550/arXiv.2501.05897 '),
      'LT|EXP-META|DOI:10.1103/VL7Z-RZP8');
    t.equal(ids.metaSource('LT', 'CUR', 'muND:unpublished', ' b '), 'LT|CUR-META|MUND:UNPUBLISHED|B');
    t.equal(ids.dataSource('LT', 'EXP', 'Al', 27, '4d2ed5c83736', 'plate'), 'LT|EXP|Al|27000|4d2ed5c83736|PLATE');
    t.equal(ids.dataSource('LT', 'EXP', 'Mg', 0, '4d2ed5c83736'), 'LT|EXP|Mg|0|4d2ed5c83736');
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

  h.test('jsonfmt: digits after the decimal point, as written', async (t) => {
    const cases = { '2177.0': 1, 2177: 0, '0.0090': 4, '13.250': 3, '1.29e7': 0, '1.5e-3': 4, '-0.50': 2 };
    for (const [text, digits] of Object.entries(cases)) {
      t.equal(jsonfmt.decimals(jsonfmt.parse(`{"x": ${text}}`), 'x'), digits, `${text}:`);
    }
    t.throws(() => jsonfmt.stringify({ x: NaN }), 'NaN cannot be stored');
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

  // ---------------------------------------------------------------- schema
  h.test('schema: validator basics', async (t) => {
    const s = await json('schema', 'lt.schema.json');
    const codes = (doc) => schema.validate(doc, s).map((e) => `${e.pointer}:${e.keyword}`);
    t.deepEqual(codes({}), [':required', ':required', ':required', ':required', ':required']);
    const value = (extra = {}) => ({ value: 756, unit: 'ns', uncertainties: [{ source: 'total', value: 1 }], ...extra });
    const row = (extra = {}) => ({ datasetId: '0123456789ab', nuclide: { element: 'Si', mass: 28, isomer: 0 },
      observable: { kind: 'lifetime', lifetime: value() }, ...extra });
    const doc = (rows = [row()], extra = {}) => ({ format: 'muND/LT/1', sublibrary: 'LT', datasetType: 'experiment',
      meta: { id: '0123456789ab', bibId: 'DOI:10.1234/x', facility: 'A' }, data: rows, ...extra });
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
    t.deepEqual(bibCodes({ id: 'DOI:10.1103/PhysRevC.35.2212', author: [{ family: 'Suzuki', given: 'T.' }], title: ['x'],
      'container-title': ['Physical Review C'], volume: '35', page: '2212-2224', published: { 'date-parts': [[1987, 6, 1]] } }), []);
    t.deepEqual(bibCodes({ title: ['x'] }), ['/references/0:required']);
    t.deepEqual(bibCodes({ id: 'DOI:10.1234/x', title: 'not a list' }), ['/references/0/title:type']);
  });

  h.test('schema: normalisation orders keys and drops empty members', async (t) => {
    const s = await json('schema', 'lt.schema.json');
    const obj = jsonfmt.parse('{"data": [{"comment": " ", "key": "", "zzz": 1, "observable": {"lifetime": {"uncertainties": [], '
      + '"unit": "ns", "value": 1.0}, "kind": "lifetime"}, "nuclide": {"isomer": 0, "mass": 0, "element": " Si "}, "datasetId": "x"}], '
      + '"meta": {"comment": "", "bibId": "DOI:10.1234/x", "id": "m", "relatedBibIds": []}, "datasetType": "experiment", '
      + '"sublibrary": "LT", "format": "muND/LT/1"}');
    const out = schema.normalize(obj, s);
    t.deepEqual(Object.keys(out), ['format', 'sublibrary', 'datasetType', 'meta', 'data']);
    t.deepEqual(out.meta, { id: 'm', bibId: 'DOI:10.1234/x' });
    t.deepEqual(Object.keys(out.data[0]), ['datasetId', 'nuclide', 'observable', 'zzz']);
    t.deepEqual(out.data[0].nuclide, { element: 'Si', mass: 0, isomer: 0 });
    t.deepEqual(Object.keys(out.data[0].observable.lifetime), ['value', 'unit', 'uncertainties']);
    t.deepEqual(out.data[0].observable.lifetime.uncertainties, [], 'required members are kept even when empty');
    t.equal(jsonfmt.numberText(out.data[0].observable.lifetime, 'value'), '1.0');
  });

  // ---------------------------------------------------------------- checks
  h.test('database: shared validation cases', async (t) => {
    const { master, cases } = await json('vectors', 'cases.json');
    t.ok(cases.length > 0);
    for (const c of cases) {
      const db = await newDatabase(master);
      const paths = c.files.map((f) => f.path);
      for (const f of c.files) {
        if (f.text === null) db.removeFile(f.path);
        else db.setFile(f.path, f.text);
      }
      const got = db.validate().map((i) => `${i.level} ${i.code} #${paths.indexOf(i.file)} ${i.pointer}`).sort();
      const want = c.expect.map((e) => `${e.level} ${e.code} #${e.file} ${e.pointer}`).sort();
      t.deepEqual(got, want, `${c.name}:`);
    }
  });

  h.test('database: the repository data is valid', async (t) => {
    const db = await newDatabase();
    for (const f of await env.dataFiles()) db.setFile(f.path, f.text);
    t.deepEqual(db.validate().filter((i) => i.level === 'error'), []);
  });

  h.test('database: the test database is clean', async (t) => {
    const db = await newDatabase((await json('vectors', 'repository.json')).files);
    t.deepEqual(db.validate(), []);
    t.deepEqual(db.sortedFiles().map((f) => f.code), ['CUR', 'EVAL', 'EXP']);
    for (const f of db.sortedFiles()) t.equal(database.filePath(f.obj, db.reference(f.meta.bibId)), f.path);
    t.equal(db.zOf('Si'), 14);
    t.equal(db.reference('DOI:10.1103/VL7Z-RZP8').author[0].family, 'Mizuno', 'DOIs are compared case-insensitively');
    t.ok(database.isDataFilePath('data/LT/EXP/x_0123456789ab.json'));
    t.ok(!database.isDataFilePath('data/LT/README.md'));
    t.ok(!database.isDataFilePath('data/master/facilities.json'));
  });

  h.test('database: assignIds', async (t) => {
    const obj = { format: 'muND/LT/1', sublibrary: 'LT', datasetType: 'experiment', meta: { bibId: 'DOI:10.1103/vl7z-rzp8' },
      data: [{ nuclide: { element: 'Al', mass: 27, isomer: 0 }, key: 'plate' }, { nuclide: { element: 'Mg', mass: 0, isomer: 0 } }] };
    database.assignIds(obj);
    t.equal(obj.meta.id, '4d2ed5c83736');
    t.equal(obj.data[0].datasetId, 'dd91adba8444');
    t.equal(obj.data[1].datasetId, '09c1551803d0');
    const partial = { ...obj, data: [{ nuclide: { isomer: 0 } }] };
    database.assignIds(partial);
    t.equal(partial.data[0].datasetId, undefined, 'an entry without element and mass is left to validation');
    t.equal(database.fileCode(obj), 'EXP');
    t.equal(database.quantity({ observable: { kind: 'lifetime', lifetime: { value: 1 } } }).value, 1);
    t.equal(database.quantity({ observable: { kind: 'capture_rate', lifetime: { value: 1 } } }), null);
  });

  // --------------------------------------------------------------- convert
  h.test('convert: shared vectors', async (t) => {
    const vectors = await json('vectors', 'convert.json');
    const physics = new convert.Physics(await fixture('data/master/huff_factors.json'), await fixture('data/master/constants.json'));
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
      const got = physics.convert(v.z, v.a, v.observable, v.value, v.uncertainty, v.unit, v.q);
      for (const [k, expected] of Object.entries(v.expected)) {
        if (expected === null || typeof expected === 'string') t.equal(got[k], expected, `${k}:`);
        else t.close(got[k], expected, vectors.relative_tolerance, `${JSON.stringify(v)} ${k}:`);
      }
    }
    // the same tables and Huff factors are refused in Python
    for (const table of vectors.refused.tables) {
      t.throws(() => new convert.Physics(table.huff, table.constants), table.name);
    }
    for (const q of [...vectors.refused.huff_factors, Number.NaN, Number('abc')]) {
      t.throws(() => physics.convert(14, 28, 'lifetime', 756, 1, 'ns', q), String(q));
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

  // ------------------------------------------------------------ cite/format
  h.test('cite: shared vectors', async (t) => {
    const { cases } = await json('vectors', 'cite.json');
    t.ok(cases.length > 0);
    for (const c of cases) {
      t.equal(cite.fileLabel(c.meta, c.reference), c.fileLabel, `${JSON.stringify(c.meta)}:`);
      t.equal(cite.citeText(c.reference, c.meta.bibId), c.citeText, `${JSON.stringify(c.meta)}:`);
    }
  });

  h.test('cite: labels, author lists and links', async (t) => {
    const ref = { author: [{ family: 'Suzuki', given: 'T.' }, { family: 'Measday', given: 'D. F.' },
      { family: 'Roalsvig', given: 'J. P.' }], title: ['Total nuclear capture rates for negative muons'],
    published: { 'date-parts': [[1987, 6, 1]] } };
    t.equal(cite.citeLabel(ref), 'Suzuki1987');
    t.equal(cite.citeLabel(null, 'muND:unpublished'), 'unpublished');
    t.equal(cite.citeLabel(null, 'NSR:1987SU06'), 'NSR:1987SU06');
    t.equal(cite.authorList(ref), 'T. Suzuki, D. F. Measday and J. P. Roalsvig');
    t.equal(cite.referenceTitle(ref), 'Total nuclear capture rates for negative muons');
    t.equal(database.filePath({ sublibrary: 'LT', datasetType: 'curated', meta: { id: 'abc', bibId: 'muND:unpublished' } }, null),
      'data/LT/CUR/unpublished_abc.json');
    // the three forms of a bibId and their links
    t.deepEqual(['DOI:10.1103/PhysRevC.35.2212', 'NSR:1987SU06', 'muND:Suzuki1975thesis', 'NSR:1987', 'mund:x',
      'https://doi.org/10.1103/x', '10.1103/x', 'doi:10.1103/x', 'muNDx'].map(cite.bibKind), ['DOI', 'NSR', 'muND', '', '', '', '', '', '']);
    t.deepEqual(['DOI:10.1103/x:y', 'NSR:1987SU06', 'muND:unpublished', '10.1103/x'].map(cite.bibName),
      ['10.1103/x:y', '1987SU06', 'unpublished', '10.1103/x']);
    t.equal(cite.bibUrl('DOI:10.1016/0375-9474(88)90330-2'), 'https://doi.org/10.1016/0375-9474(88)90330-2');
    t.equal(cite.bibUrl('NSR:1987SU06'), 'https://www.nndc.bnl.gov/nsr/?search-type=keynumber&key=1987SU06');
    t.equal(cite.bibUrl('muND:unpublished'), null);
    // a source named by a muND key is linked by the URL of its bibliography entry
    t.equal(cite.sourceUrl('muND:Suzuki1975thesis', { id: 'muND:Suzuki1975thesis', URL: 'https://example.org/thesis.pdf' }),
      'https://example.org/thesis.pdf');
    t.equal(cite.sourceUrl('muND:unpublished', null), null);
    t.equal(cite.sourceUrl('DOI:10.1103/PhysRevC.35.2212', { URL: 'https://example.org/x' }), 'https://doi.org/10.1103/PhysRevC.35.2212');
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
  });

  h.test('nuclides: tables and the mass number of a natural target', async (t) => {
    const tables = nuclides.nuclideTables(await fixture('data/master/nuclides.json'));
    t.equal(tables.elements.length, 118);
    t.equal(tables.zOf.get('Si'), 14);
    t.equal(nuclides.effectiveMass(14, 28, tables.monoisotopic), 28);
    t.equal(nuclides.effectiveMass(14, 0, tables.monoisotopic), 0, 'silicon has several stable isotopes');
    t.equal(nuclides.effectiveMass(13, 0, tables.monoisotopic), 27, 'aluminium has one');
  });
}
