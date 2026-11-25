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

import { support } from './modules.js';

export function register(h, modules, env) {
  const { sha256, ids, jsonfmt, schema, database, cite, convert, format, nuclides, vocabulary } = modules;
  const json = async (kind, name) => JSON.parse(await env.text(kind, name));
  let repository = null;                    // tests/vectors/repository.json, parsed once
  const testFiles = async () => (await (repository ||= json('vectors', 'repository.json'))).files;
  const fixture = async (path) => JSON.parse((await testFiles())[path]);
  const newDatabase = (files) => support.testDatabase(modules, env, files);

  h.test('harness: equality preserves types and object members', (t) => {
    t.throws(() => t.deepEqual({ value: NaN }, { value: null }));
    t.throws(() => t.deepEqual({ value: undefined }, {}));
    t.throws(() => t.deepEqual([], {}));
    t.throws(() => t.close('1', 1));
    t.throws(() => t.close(0, null));
    t.deepEqual({ a: 1, b: [2] }, { b: [2], a: 1 });
  });

  // ---------------------------------------------------------------- sha256
  h.test('sha256: standard test vectors', async (t) => {
    t.equal(sha256.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    t.equal(sha256.sha256('a'.repeat(1000000)),
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  h.test('sha256: shared vectors', async (t) => {
    const { cases } = await json('vectors', 'sha256.json');
    t.ok(cases.length > 0);
    for (const c of cases) t.equal(sha256.sha256(c.text), c.sha256, `sha256 of ${[...c.text].length} characters:`);
  });

  // ------------------------------------------------------------------- ids
  h.test('ids: shared vectors', async (t) => {
    const { meta, data, refusedMasses } = await json('vectors', 'ids.json');
    for (const v of meta) {
      const args = [v.sublibrary, v.code, v.bibId, v.key];
      t.deepEqual([ids.metaSource(...args), ids.metaId(...args)], [v.source, v.id], JSON.stringify(v));
    }
    for (const v of data) {
      const args = [v.sublibrary, v.code, v.element, v.mass, v.meta_id, v.key];
      t.deepEqual([ids.dataSource(...args), ids.dataId(...args)], [v.source, v.id], JSON.stringify(v));
    }
    for (const text of refusedMasses) t.throws(() => ids.normalizeMass(text), `should be refused: ${JSON.stringify(text)}`);
  });

  // --------------------------------------------------------------- jsonfmt
  h.test('jsonfmt: shared vectors', async (t) => {
    const { roundTrip, rejected } = await json('vectors', 'jsonfmt.json');
    for (const text of roundTrip) {
      const obj = jsonfmt.parse(text);
      t.equal(jsonfmt.stringify(obj), text);
      t.deepEqual(obj, JSON.parse(text));
    }
    for (const text of rejected) t.throws(() => jsonfmt.parse(text), `should be rejected: ${JSON.stringify(text)}`);
  });

  h.test('jsonfmt: typed and computed numbers', async (t) => {
    const obj = jsonfmt.parse('{"a": 13.250}');
    obj.a = 14;                               // a changed value is written as JavaScript writes it
    t.equal(jsonfmt.numberText(obj, 'a'), '14');
    t.ok(jsonfmt.setNumber(obj, 'a', ' 14.00 '));
    t.equal(jsonfmt.numberText(obj, 'a'), '14.00');
    t.ok(!jsonfmt.setNumber(obj, 'a', '1,5'));
    t.equal(jsonfmt.stringify(jsonfmt.clone(obj)), '{\n  "a": 14.00\n}\n');
    t.throws(() => jsonfmt.stringify({ x: NaN }), 'NaN cannot be stored');
  });

  h.test('jsonfmt: digits after the decimal point, as written', async (t) => {
    const cases = { '2177.0': 1, 2177: 0, '0.0090': 4, '13.250': 3, '1.29e7': 0, '1.5e-3': 4, '-0.50': 2 };
    for (const [text, digits] of Object.entries(cases)) {
      t.equal(jsonfmt.decimals(jsonfmt.parse(`{"x": ${text}}`), 'x'), digits, `${text}:`);
    }
  });

  h.test('jsonfmt: line and column of a parse error', async (t) => {
    for (const [text, line, column] of [['{\n  "a": 1,\n  "b": ?\n}', 3, 8], ['{\n  "a": 1,\n  "a": 2\n}', 3, 3]]) {
      try {
        jsonfmt.parse(text);
        t.ok(false, `expected an error: ${JSON.stringify(text)}`);
      } catch (err) {
        t.equal(err.line, line);
        t.equal(err.column, column);
      }
    }
  });

  // ---------------------------------------------------------------- schema
  h.test('schema: validator basics', async (t) => {
    const s = await json('schema', 'lt.schema.json');
    t.deepEqual(schema.validate({}, s).map((e) => `${e.pointer}:${e.keyword}`), [':required', ':required', ':required', ':required', ':required']);
    t.throws(() => schema.validate(1, { format: 'date' }), 'unsupported keywords must not be ignored');
    t.throws(() => schema.validate({}, { type: 'object', properties: { a: { maxLength: 3 } } }), 'keywords of members the data does not fill are checked too');
    t.throws(() => schema.validate('x', { $defs: { n: { type: 'string' } }, $ref: '#/$defs/n', minLength: 5 }), 'constraints next to $ref must not be ignored');
    t.throws(() => schema.validate({}, { additionalProperties: { type: 'number' } }), 'a schema-valued additionalProperties must not be ignored');
  });

  h.test('schema: shared canonical texts', async (t) => {
    const { canonical } = await json('vectors', 'cases.json');
    const { schemas } = await newDatabase();
    t.ok(canonical.length > 0);
    for (const c of canonical) {
      const obj = jsonfmt.parse(c.text);
      t.equal(schema.canonicalText(obj, schemas), c.canonical);
      t.equal(schema.canonicalText(jsonfmt.clone(obj), schemas), c.canonical);
    }
  });

  // ---------------------------------------------------------------- checks
  h.test('database: entry content hash', async (t) => {
    const { entryHash } = await json('vectors', 'cases.json');
    const row = jsonfmt.parse(entryHash.entry);
    t.equal(jsonfmt.compact({ observable: row.observable, nuclide: row.nuclide }), entryHash.compact);
    t.equal(database.entryHash(row), entryHash.hash);
  });

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
    const db = await newDatabase(await testFiles());
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
    const { meta, data } = await json('vectors', 'ids.json');
    const source = meta.find((v) => v.code === 'EXP' && v.bibId === 'DOI:10.1103/vl7z-rzp8' && !v.key);
    const rows = data.filter((v) => v.meta_id === source.id && (v.key === 'plate' || !v.key));
    const obj = { format: 'muND/LT/1', sublibrary: source.sublibrary, datasetType: 'experiment', meta: { bibId: source.bibId },
      data: rows.map(({ element, mass, key }) => ({ nuclide: { element, mass, isomer: 0 }, key })) };
    database.assignIds(obj);
    t.equal(obj.meta.id, source.id);
    t.deepEqual(obj.data.map((row) => row.datasetId), rows.map((v) => v.id));
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
    const NON_FINITE = [NaN, Infinity, -Infinity];   // values JSON cannot hold
    t.equal(physics.muLifeNs, 2196.9811);
    t.ok(vectors.cases.length >= 10);
    for (const v of vectors.cases) {
      const got = physics.convert(v.z, v.a, v.observable, v.value, v.uncertainty, v.unit, v.q);
      for (const [k, expected] of Object.entries(v.expected)) {
        if (expected === null || typeof expected === 'string') t.equal(got[k], expected, `${k}:`);
        else t.close(got[k], expected, vectors.relative_tolerance, `${JSON.stringify(v)} ${k}:`);
      }
    }
    for (const x of vectors.lookups) {
      const c = physics.convert(x.z, x.a, 'lifetime', 756.0, null, 'ns');
      t.deepEqual([c.huff_factor, c.huff_source], [x.huff_factor, x.huff_source], JSON.stringify(x));
    }
    for (const x of vectors.impossible) {
      t.equal(physics.convert(x.z, x.a, x.observable, x.value, x.uncertainty, x.unit), null, JSON.stringify(x));
    }
    for (const x of NON_FINITE) {
      t.equal(physics.convert(14, 28, 'lifetime', x, null, 'ns'), null, String(x));
      t.equal(physics.convert(14, 28, 'lifetime', 756.0, x, 'ns'), null, String(x));
    }
    for (const x of vectors.combined) {
      const got = convert.combinedUncertainty(x.uncertainties);
      if (x.value === null) t.equal(got, null, JSON.stringify(x));
      else t.close(got, x.value, vectors.relative_tolerance, JSON.stringify(x));
    }
    for (const table of vectors.refused.tables) {
      t.throws(() => new convert.Physics(table.huff, table.constants), table.name);
    }
    for (const q of [...vectors.refused.huff_factors, ...NON_FINITE]) {
      t.throws(() => physics.convert(14, 28, 'lifetime', 756.0, 1.0, 'ns', q), String(q));
    }
  });

  // ------------------------------------------------------------ cite/format
  h.test('cite: shared vectors and the bibId pattern of the schemas', async (t) => {
    const { cases, bibIds, project } = await json('vectors', 'cite.json');
    t.ok(cases.length > 0 && bibIds.length > 0 && project.length > 0);
    for (const c of cases) {
      t.equal(cite.fileLabel(c.meta, c.reference), c.fileLabel, `${JSON.stringify(c.meta)}:`);
      t.equal(cite.citeText(c.reference, c.meta.bibId), c.citeText, `${JSON.stringify(c.meta)}:`);
    }
    for (const b of bibIds) {
      t.deepEqual([cite.bibKind(b.bibId), cite.bibName(b.bibId), cite.isBibId(b.bibId)], [b.kind, b.name, b.kind !== ''],
        `${JSON.stringify(b.bibId)}:`);
    }
    for (const c of project) {
      t.deepEqual(cite.citationTexts({ paper: c.paper, data: c.data }, c.manifest, c.url ?? `${c.siteUrl}explorer/?v=${c.manifest.label}`),
        c.expect, `${c.paper.authors.length} authors, ${c.manifest.kind}, date ${c.manifest.date}:`);
    }
    const pattern = `^(${cite.BIB_ID_FORMS.map(([prefix, name]) => `${prefix}:${name}`).join('|')})$`;
    const lt = await json('schema', 'lt.schema.json');
    const bibliography = await json('schema', 'bibliography.schema.json');
    t.deepEqual([lt.$defs.bibId.pattern, bibliography.properties.references.items.properties.id.pattern], [pattern, pattern]);
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
    // the links of the three forms of a bibId
    t.equal(cite.bibUrl('DOI:10.1016/0375-9474(88)90330-2'), 'https://doi.org/10.1016/0375-9474(88)90330-2');
    t.equal(cite.bibUrl('NSR:1987SU06'), 'https://www.nndc.bnl.gov/nsr/?search-type=keynumber&key=1987SU06');
    t.equal(cite.bibUrl('muND:unpublished'), null);
    // a source named by a muND key is linked by the URL of its bibliography entry
    t.equal(cite.sourceUrl('muND:Suzuki1975thesis', { id: 'muND:Suzuki1975thesis', URL: 'https://example.org/thesis.pdf' }),
      'https://example.org/thesis.pdf');
    t.equal(cite.sourceUrl('muND:unpublished', null), null);
    t.equal(cite.sourceUrl('muND:test', { URL: 'data:text/plain,test' }), null);
    for (const url of ['HTTPS://example.org/x', 'https://', 'https://example.org/a b']) {
      t.equal(cite.sourceUrl('muND:test', { URL: url }), null, url);
    }
    t.equal(cite.sourceUrl('muND:test', { URL: 'http://example.org:x' }), 'http://example.org:x');
    t.equal(cite.sourceUrl('DOI:10.1103/PhysRevC.35.2212', { URL: 'https://example.org/x' }), 'https://doi.org/10.1103/PhysRevC.35.2212');
  });

  h.test('cite: the project paper and the database in BibTeX', async (t) => {
    const { project, entryKeys } = await json('vectors', 'cite.json');
    const { paper, data, manifest: release } = project.find((c) => c.paper.authors.length === 3);
    t.equal(cite.paperCitations(paper).BibTeX, '@misc{Watanabe2026,\n'
      + '  author = {Watanabe, Yukinobu and Niikura, Megumi and Abe, Shinichiro},\n'
      + '  title = {{Muon Nuclear Data Development Project}},\n'
      + '  year = {2026},\n'
      + '  eprint = {2605.15539},\n'
      + '  archivePrefix = {arXiv},\n'
      + '  primaryClass = {nucl-ex},\n'
      + '  url = {https://arxiv.org/abs/2605.15539}\n}');
    for (const { datasetId, key } of entryKeys) {
      const url = `https://sample.invalid/explorer/?v=v1&id=${datasetId}`;
      t.equal(cite.dataCitations(data, release, url, datasetId).BibTeX.split('\n')[0], `@misc{${key},`);
    }
    const r = cite.dataCitations(data, release, 'https://ribf.riken.jp/muon/explorer/?v=v1').BibTeX;
    t.ok(r.startsWith('@misc{muND_v1,\n  author = {{muND Project Team}},'), r);
    t.ok(r.includes('  version = {1.0.0},\n  year = {2026},\n  month = nov,'), 'version, year, month');
    t.ok(!r.includes('note'), 'a release has no note');
    const dev = cite.dataCitations(data, { ...release, label: 'latest', version: '1.0.0+2.gabcdef1', kind: 'development' },
      'https://ribf.riken.jp/muon/explorer/?v=latest').BibTeX;
    t.ok(dev.includes('  note = {Development version of commit abcdef1; not a stable version},'), dev);
  });

  h.test('format: values as given and derived values', async (t) => {
    const q = (text) => format.formatQuantity(jsonfmt.parse(text));
    t.equal(q('{"value": 743.9, "unit": "ns", "uncertainties": [{"source": "total", "value": 5.0}]}'), '743.9 ± 5.0');
    t.equal(q('{"value": 0.8926, "unit": "us-1", "uncertainties": [{"source": "total", "value": 0.0090}]}'), '0.8926 ± 0.0090');
    t.equal(q('{"value": 13.250, "unit": "us-1", "uncertainties": [{"source": "total", "value": 1.550}]}'), '13.250 ± 1.550');
    t.equal(q('{"value": 87.0, "unit": "ns", "uncertainties": []}'), '87.0');
    t.equal(q('{"value": 751.4, "unit": "ns", "uncertainties": [{"source": "statistical", "value": 0.8}, {"source": "systematic", "value": 0.7}]}'),
      '751.4 ± 0.8 (stat) ± 0.7 (syst)');
    t.equal(format.formatQuantity({ value: 863.7, unit: 'ns', uncertainties: [{ source: 'total', value: 1 }] }), '863.7 ± 1');
    t.equal(q('{"value": 1.2, "uncertainties": [{"source": "total", "value": 0.0050}]}'), '1.2 ± 0.0050');
    for (const text of ['0.100000000000000000', '9007199254740993', '2.50e-21']) {
      t.equal(q(`{"value": ${text}}`), text);
    }
    const correction = jsonfmt.parse('{"pointer": "/observable", "before": 0.0090, "after": {"value": 0.00900}}');
    t.ok(format.formatCorrection(correction).includes('0.0090 → {"value":0.00900}'));
    t.equal(q('{"value": 8, "uncertainties": [{"source": "statistical", "value": 3}, {"source": "total", "value": 5.0}, {"source": "systematic", "value": 4}]}'),
      '8 ± 5.0 (total) [3 (stat), 4 (syst)]');
    const q2 = (text) => format.quantityText(jsonfmt.parse(text));
    t.equal(format.quantityText({ value: 863.7, unit: 'ns', uncertainties: [{ source: 'total', value: 1 }] }), '863.7 ± 1 ns');
    t.equal(q2('{"value": 0.8926, "unit": "us-1", "uncertainties": [{"source": "total", "value": 0.0090}]}'), '0.8926 ± 0.0090 µs⁻¹');
    t.equal(format.quantityText({ value: 2.5, unit: 'xyz', uncertainties: [] }), '2.5 xyz');
    t.equal(format.quantityText({ value: 'abc', unit: 'ns' }), 'abc ns');
    t.equal(format.quantityText({ value: 87 }), '87');
    t.equal(format.formatDerived(0.8710364, 0.0017497), '0.8710 ± 0.0017');
    t.equal(format.formatDerived(2177.04, 2.0), '2177.0 ± 2.0');
    t.equal(format.formatDerived(60.912, 0.0996), '60.91 ± 0.10');
    t.equal(format.formatDerived(12900000, 100000), '12900000 ± 100000');
    t.equal(format.formatDerived(12345, 1234), '12300 ± 1200');
    t.equal(format.formatDerived(991.4, 103), '990 ± 100');
    t.equal(format.formatDerived(999.6, 96), '1000 ± 96');
    t.equal(format.formatDerived(-7, 103), '-10 ± 100');
    t.equal(format.formatDerived(123456, null), '123500');
    t.equal(format.formatDerived(2.5e21, 1.2e21), '2.5e+21 ± 1.2e+21');
    t.equal(format.formatDerived(2e-21, 1e-22), '2.00e-21 ± 1.0e-22');
    t.equal(format.formatDerived(743.9, 0), '743.9 ± 0');
    t.equal(format.formatUncertainty(103.17), '100');
    t.equal(format.formatUncertainty(9.96e21), '1.0e+22');
    t.equal(format.formatDerived(0.000435, 0.000016), '0.000435 ± 0.000016');
    t.equal(format.formatDerived(11.0751, null), '11.08');
    t.equal(format.formatDerived(null, null), '');
    t.equal(format.formatUncertainty(0.0996), '0.10');
    const conv = { 'capture_rate_us-1': 0.8710364, 'capture_rate_us-1_unc': 0.0017497 };
    t.equal(format.formatConverted(conv, 'capture_rate'), '0.8710 ± 0.0017');
    t.equal(format.formatConverted(null, 'capture_rate'), '');
    t.equal(format.formatCorrection({ date: '2026-11', pointer: '/nuclide/element', before: 'Be', after: 'B',
      formerId: '195e7c3cc486', reason: 'R.', checkedAgainstSource: false }),
    '2026-11: nuclide › element "Be" → "B". R. Former DataID 195e7c3cc486. Not yet checked against the publication.');
    const checked = format.formatCorrection({ date: '2026-11-02', pointer: '/nuclide/mass', before: 10, after: 11,
      reason: 'R.', checkedAgainstSource: true });
    t.equal(checked, '2026-11-02: nuclide › mass 10 → 11. R.');
  });

  h.test('vocabulary: numbers in words', async (t) => {
    t.equal(vocabulary.entriesText(1), '1 entry');
    t.equal(vocabulary.entriesText(12), '12 entries');
    t.equal(vocabulary.countsInWords({ EXP: 6, CUR: 4, EVAL: 5 }), '6 experimental, 4 curated, 5 evaluated');
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
