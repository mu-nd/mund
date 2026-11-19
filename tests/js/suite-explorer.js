// Tests of the pure modules of the database pages (site/assets/js/explorer:
// model.js, selection.js, versioning.js, route.js, citation.js).  Registered next to suite.js by
// run-node.mjs and by the browser test page; `modules` and `env` as there.
//
// The published files of a version (manifest.json, master.json, LT.json,
// csv/LT.csv) are made here from the test database tests/fixtures
// (tests/vectors/repository.json) in the layout of tools/mundlib/build.py,
// with one entry added whose source gives no uncertainty.

/** Columns of csv/LT.csv (tools/mundlib/build.py CSV_COLUMNS). */
const COLUMNS = ['datasetId', 'datasetType', 'element', 'z', 'mass', 'isomer', 'observable', 'value',
  'uncertainty', 'uncertaintyStatistical', 'uncertaintySystematic', 'unit', 'key', 'comment',
  'originalData', 'metaId', 'bibId', 'reference', 'facility', 'method',
  'lifetime_ns', 'lifetime_ns_unc', 'capture_rate_us-1', 'capture_rate_us-1_unc',
  'capture_probability_pct', 'capture_probability_pct_unc', 'huff_factor', 'huff_source'];
const DERIVED = COLUMNS.slice(COLUMNS.indexOf('lifetime_ns'), COLUMNS.indexOf('huff_factor'));

/** An experimental entry published without uncertainty, with a comment that needs quoting in CSV. */
const NO_UNCERTAINTY = '{"datasetId": "0000000000aa", "nuclide": {"element": "Mn", "mass": 55, "isomer": 0}, '
  + '"observable": {"kind": "lifetime", "lifetime": {"value": 230.0, "unit": "ns", "uncertainties": []}}, '
  + '"key": "extra", "comment": "no uncertainty given, \\"test\\" entry\\nsecond line"}';
const EXPLORER = 'https://ribf.riken.jp/muon/explorer/';
const SHA = 'f'.repeat(64);

export function register(h, modules, env) {
  const { jsonfmt, cite, model, selection, versioning, route, citation } = modules;
  const json = async (kind, name) => JSON.parse(await env.text(kind, name));

  /** One version of the test database as the pages build it from its published files. */
  async function published({ label = 'v1', kind = 'release', edit = null } = {}) {
    const files = (await json('vectors', 'repository.json')).files;
    const parsed = (path) => jsonfmt.parse(files[path]);
    const meta = [];
    const data = [];
    const cited = new Set();
    for (const path of Object.keys(files).filter((p) => p.startsWith('data/LT/')).sort()) {
      const obj = parsed(path);
      const { id, ...members } = obj.meta;
      meta.push({ id, datasetType: obj.datasetType, file: path.slice('data/'.length), ...members });
      cited.add(obj.meta.bibId.toUpperCase());
      const entries = obj.datasetType === 'experiment' ? [...obj.data, jsonfmt.parse(NO_UNCERTAINTY)] : obj.data;
      for (const { datasetId, ...rest } of entries) {
        data.push({ datasetId, datasetType: obj.datasetType, metaId: id, bibId: obj.meta.bibId, ...rest });
      }
    }
    if (edit) edit(data);
    const version = kind === 'release' ? '1.0.0' : '1.0.0+2.gabcdef1';
    const counts = { EXP: 0, TH: 0, CUR: 0, EVAL: 0 };
    const codeOf = { experiment: 'EXP', theory: 'TH', curated: 'CUR', evaluated: 'EVAL' };
    for (const e of data) counts[codeOf[e.datasetType]] += 1;
    const planned = (title) => ({ title, status: 'planned', counts: {} });
    const manifest = {
      format: 'muND/manifest/1', label, version, kind, commit: 'abcdef1234567890abcdef1234567890abcdef12',
      date: '2026-11-16T12:00:00+09:00',
      sublibraries: {
        XR: planned('Muonic X-ray energies and intensities'),
        LT: { title: 'Lifetimes of muonic atoms / nuclear capture rates', status: 'available', counts },
        ES: planned('Energy spectra of emitted particles'),
        BR: planned('Production branching ratios of residual nuclei'),
      },
      archive: { path: `mund-${label}.zip`, bytes: 1 },
      files: [{ path: 'LT.json', bytes: 123, sha256: SHA }, { path: 'csv/LT.csv', bytes: 45, sha256: SHA }],
    };
    const master = {
      nuclides: parsed('data/master/nuclides.json'),
      facilities: parsed('data/master/facilities.json'),
      huff_factors: parsed('data/master/huff_factors.json'),
      constants: parsed('data/master/constants.json'),
    };
    const lt = {
      format: 'muND/dist/LT/1', sublibrary: 'LT', version,
      bibliography: parsed('data/master/bibliography.json').references.filter((r) => cited.has(r.DOI.toUpperCase())),
      meta, data,
    };
    return model.buildVersion({ label, manifest, master, lt });
  }

  /** csv/LT.csv of a version, written like tools/mundlib/build.py writes it. */
  function publishedCsv(version) {
    const field = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [COLUMNS.join(',')];
    for (const row of version.rows) {
      const { entry, block, conv, meta } = row;
      const component = (source) => {
        const u = block.uncertainties.find((x) => x.source === source);
        return u ? jsonfmt.numberText(u, 'value') : '';
      };
      const line = {
        datasetId: entry.datasetId, datasetType: entry.datasetType, element: entry.nuclide.element, z: row.z,
        mass: entry.nuclide.mass, isomer: entry.nuclide.isomer, observable: entry.observable.kind,
        value: jsonfmt.numberText(block, 'value'),
        uncertainty: row.unc === null ? '' : (component('total') || String(row.unc)),
        uncertaintyStatistical: component('statistical'), uncertaintySystematic: component('systematic'),
        unit: block.unit, key: entry.key, comment: entry.comment,
        originalData: (entry.originalData || []).map((o) => o.datasetId).join(';'),
        metaId: entry.metaId, bibId: entry.bibId, reference: cite.citeText(row.reference, entry.bibId),
        facility: meta.facility, method: meta.method,
        huff_factor: conv ? conv.huff_factor : '', huff_source: conv ? conv.huff_source : '',
      };
      for (const k of DERIVED) line[k] = conv && conv[k] !== null ? Number(conv[k].toPrecision(6)) : '';
      lines.push(COLUMNS.map((c) => field(line[c])).join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  const idsOf = (rows) => rows.map((r) => r.entry.datasetId);
  const asRecords = (text) => {
    const [header, ...records] = selection.parseCsv(text);
    return records.map((r) => Object.fromEntries(header.fields.map((c, i) => [c, r.fields[i]])));
  };

  // ---------------------------------------------------------------- selection
  h.test('explorer: the filter of the tables', async (t) => {
    const version = await published();
    const { rows } = version;
    t.equal(rows.length, 41);
    t.equal(selection.selectRows(rows).length, 41, 'no filter: everything');
    t.equal(selection.selectRows(rows, { ds: ['EXP'] }).length, 11);
    t.equal(selection.selectRows(rows, { ds: new Set(['CUR']) }).length, 8, 'codes as a Set, as in the explorer');
    t.equal(selection.selectRows(rows, { ds: [] }).length, 0);
    const si = selection.selectRows(rows, { z: 14 });
    t.ok(si.length > 0 && si.every((r) => r.z === 14));
    t.equal(si.length, rows.filter((r) => r.z === 14).length);
    const si28 = selection.selectRows(rows, { z: 14, a: '28' });
    t.ok(si28.length > 0 && si28.every((r) => r.a === 28));
    const siNat = selection.selectRows(rows, { z: 14, a: '0' });
    t.ok(siNat.length > 0 && siNat.every((r) => r.entry.nuclide.mass === 0), 'a = 0: natural targets');
    t.ok(selection.selectRows(rows, { z: 13, a: '27' }).some((r) => r.entry.nuclide.mass === 27));
    const order = selection.selectRows(rows, { z: 14 }).map((r) => ['EXP', 'TH', 'CUR', 'EVAL'].indexOf(r.code));
    t.deepEqual(order, [...order].sort((x, y) => x - y), 'in the order of the tables: by dataset code');
  });

  h.test('explorer: the CSV of a selection has exactly the rows shown, as published', async (t) => {
    const version = await published();
    const csv = publishedCsv(version);
    const published_ = new Map(selection.parseCsv(csv).slice(1).map((r) => [r.fields[0], r.text]));
    const cases = [{}, { z: 14 }, { z: 14, a: '28' }, { z: 14, a: '0' }, { z: 13, a: '27' }, { ds: ['CUR'] },
      { z: 25, ds: ['EXP'] }, { z: 14, ds: ['EXP', 'EVAL'] }, { z: 92 }];
    for (const filters of cases) {
      const shown = selection.selectRows(version.rows, filters);
      const out = selection.parseCsv(selection.selectionCsv(csv, shown));
      t.equal(out[0].text, COLUMNS.join(','), `${JSON.stringify(filters)} header:`);
      t.deepEqual(out.slice(1).map((r) => r.fields[0]), idsOf(shown), `${JSON.stringify(filters)}:`);
      for (const r of out.slice(1)) t.equal(r.text, published_.get(r.fields[0]), 'every record is copied as published');
    }
    t.equal(selection.selectionCsv(csv, []), `${COLUMNS.join(',')}\n`, 'nothing shown: the header only');
  });

  h.test('explorer: CSV columns, unreported uncertainty, quoting', async (t) => {
    const version = await published();
    const csv = publishedCsv(version);
    const shown = selection.selectRows(version.rows, { z: 25, ds: ['EXP'] });
    const text = selection.selectionCsv(csv, shown);
    t.deepEqual(selection.parseCsv(text)[0].fields, COLUMNS, 'the columns of the published file');
    const records = asRecords(text);
    const none = records.find((r) => r.datasetId === '0000000000aa');
    t.equal(none.value, '230.0', 'the value as written in the source');
    t.equal(none.observable, 'lifetime');
    for (const c of ['uncertainty', 'uncertaintyStatistical', 'uncertaintySystematic', 'lifetime_ns_unc',
      'capture_rate_us-1_unc', 'capture_probability_pct_unc']) {
      t.equal(none[c], '', `${c} of a value without uncertainty stays empty:`);
    }
    t.ok(none.lifetime_ns !== '' && none['capture_rate_us-1'] !== '', 'converted values are there');
    t.equal(none.comment, 'no uncertainty given, "test" entry\nsecond line');
    const given = records.find((r) => r.datasetId !== '0000000000aa');
    t.equal(given.uncertainty, '4.5');

    // line ends CR LF, and broken input
    t.deepEqual(asRecords(selection.selectionCsv(csv.replace(/\n/g, '\r\n'), shown)).map((r) => r.datasetId), idsOf(shown));
    t.throws(() => selection.selectionCsv(csv, [{ entry: { datasetId: 'ffffffffffff' } }]), 'an entry missing from the CSV');
    t.throws(() => selection.selectionCsv('a,b\n1,2\n', shown), 'no datasetId column');
    t.throws(() => selection.selectionCsv(`${COLUMNS.join(',')}\n0000000000aa,x\n`, shown), 'a record with too few fields');
    t.throws(() => selection.parseCsv('a,"b\n'), 'unterminated quote');
  });

  h.test('explorer: the JSON of a selection', async (t) => {
    const version = await published();
    const shown = selection.selectRows(version.rows, { z: 14, ds: ['EXP', 'CUR'] });
    const filters = selection.describeFilters({ z: 14, a: '', ds: new Set(['CUR', 'EXP']) }, version.tables.elements);
    t.deepEqual(filters, { element: 'Si', z: 14, massNumber: null, datasetTypes: ['experiment', 'curated'] });
    const url = versioning.permalink(EXPLORER, version.label, { z: 14, ds: 'EXP,CUR' });
    const config = { paper: null, data: { title: 'muND: Muon Nuclear Data', author: 'muND Project Team' } };
    const cited = citation.citationTexts(config, { ...version.manifest, label: version.label }, url);
    const doc = selection.selectionJson({ version, rows: shown, filters, citation: cited, permalink: url, dataLicence: 'to be decided' });
    t.equal(doc.format, 'muND/selection/LT/1');
    t.equal(doc.version, '1.0.0');
    t.equal(doc.commit, version.manifest.commit);
    t.deepEqual(doc.citation, { paper: null, database: `muND Project Team, muND: Muon Nuclear Data, version 1.0.0 (2026), ${url}.` });
    t.ok(doc.permalink.includes('v=v1'));
    t.equal(doc.dataLicence, 'to be decided');
    t.deepEqual(doc.selection, { ...filters, entries: shown.length });
    t.deepEqual(Object.keys(doc.manifest), ['format', 'label', 'version', 'kind', 'commit', 'date', 'sublibraries', 'archive'],
      'the manifest without its list of files');
    t.deepEqual(doc.source, { path: 'data/v1/LT.json', bytes: 123, sha256: SHA });
    t.deepEqual(doc.data.map((e) => e.datasetId), idsOf(shown), 'the entries shown, as published');
    t.deepEqual(doc.meta.map((m) => m.id), ['591344c27b81', 'dcb3b051457e'], 'their metadata records');
    t.deepEqual(doc.bibliography.map((b) => b.DOI), ['10.1103/vl7z-rzp8'], 'the references they cite that have an entry');

    const text = jsonfmt.stringify(doc);
    t.ok(text.includes('"uncertainties": [{"source": "total", "value": 0.0090}]'), 'numbers keep their written digits');
    const back = JSON.parse(text);
    t.deepEqual(back.data.map((e) => e.datasetId), idsOf(shown));
    t.equal(back.manifest.version, '1.0.0');

    const evaluated = selection.selectionJson({ version, rows: selection.selectRows(version.rows, { ds: ['EVAL'] }), filters });
    t.deepEqual(evaluated.bibliography.map((b) => b.DOI), ['10.1103/PhysRevC.111.034614']);
    t.equal(evaluated.citation, null);

    t.equal(selection.selectionName(version.manifest, filters), 'mund_LT_1.0.0_Si_EXP-CUR');
    t.equal(selection.selectionName(version.manifest, selection.describeFilters({}, version.tables.elements)), 'mund_LT_1.0.0_all');
    t.equal(selection.selectionName({ version: '1.0.0+2.gabcdef1' },
      selection.describeFilters({ z: 14, a: '0', ds: ['EVAL'] }, version.tables.elements)), 'mund_LT_1.0.0+2.gabcdef1_Si_nat_EVAL');
  });

  // ----------------------------------------------------------------- versions
  const VERSIONS = {
    format: 'muND/versions/1',
    default: 'v1',
    versions: [
      { label: 'v1', version: '1.0.0', kind: 'release', commit: 'abc', date: '2026-11-16T12:00:00+09:00' },
      { label: 'latest', version: '1.0.0+2.gabcdef1', kind: 'development', commit: 'abcdef1234', date: '2026-11-17T12:00:00+09:00' },
    ],
  };

  h.test('explorer: the version in the address', async (t) => {
    for (const requested of [null, undefined, '']) {
      const r = versioning.resolveVersion(VERSIONS, requested);
      t.equal(r.label, 'v1', 'no version: the default one');
      t.equal(r.error, null);
    }
    t.equal(versioning.resolveVersion(VERSIONS, 'latest').entry.kind, 'development');
    for (const requested of ['v7', '1.0.0', 'LATEST']) {
      const r = versioning.resolveVersion(VERSIONS, requested);
      t.equal(r.label, null, `${requested}: nothing else in its place`);
      t.equal(r.entry, null);
      t.ok(r.error && r.error.includes(`“${requested}”`), `${requested}: an error naming it`);
    }
    t.ok(versioning.resolveVersion({ ...VERSIONS, default: 'v2' }, null).error, 'a default that does not exist');
    t.equal(versioning.checkManifest(VERSIONS.versions[0], { label: 'v1', version: '1.0.0' }).label, 'v1');
    t.throws(() => versioning.checkManifest(VERSIONS.versions[0], { label: 'latest', version: '1.0.0+2.gabcdef1' }));
    t.throws(() => versioning.checkManifest(VERSIONS.versions[0], { label: 'v1', version: '1.0.1' }));
    t.equal(versioning.versionName(VERSIONS.versions[0]), 'version 1.0.0');
    t.equal(versioning.versionName(VERSIONS.versions[1]), 'development version 1.0.0+2.gabcdef1');
  });

  h.test('explorer: citations and permalinks name the version', async (t) => {
    // the default version is shown: its label is still written out
    const shown = versioning.resolveVersion(VERSIONS, null);
    const link = versioning.permalink(EXPLORER, shown.label, { z: 14, a: '', id: 'e2551c5951a7', q: null });
    t.equal(link, 'https://ribf.riken.jp/muon/explorer/?v=v1&z=14&id=e2551c5951a7');
    const data = { title: 'muND: Muon Nuclear Data', author: 'muND Project Team' };
    const release = (await published()).manifest;
    t.equal(citation.citationTexts({ data }, { ...release, label: 'v1' }, link).database,
      'muND Project Team, muND: Muon Nuclear Data, version 1.0.0 (2026), https://ribf.riken.jp/muon/explorer/?v=v1&z=14&id=e2551c5951a7.',
      'an entry: the address of the entry');
    t.equal(versioning.permalink(EXPLORER, 'v1', { a: '0' }), 'https://ribf.riken.jp/muon/explorer/?v=v1&a=0', 'mass number 0 is kept');
    t.equal(versioning.dataLicence({ dataLicence: null }), 'to be decided');
    t.equal(versioning.dataLicence(undefined), 'to be decided');
  });

  // -------------------------------------------------------------------- model
  h.test('pages: addresses of the pages', async (t) => {
    t.ok(route.pageUrl('explorer', { v: 'v1', z: 14, a: '', id: null }).endsWith('/explorer/?v=v1&z=14'), 'empty parameters are left out');
    t.ok(route.pageUrl('nuclide', { z: 14, a: '0' }).endsWith('/nuclide/?z=14&a=0'), 'mass number 0 is kept');
    t.ok(route.pageUrl('docs/data-format').endsWith('/docs/data-format/'));
    t.ok(route.pageUrl('').endsWith('/') && !route.pageUrl('').includes('?'), 'Home');
  });

  h.test('cite: the project paper and the database in the style of Physical Review and in BibTeX', async (t) => {
    t.equal(citation.initials('Yukinobu'), 'Y.');
    t.equal(citation.initials('Jean-Pierre'), 'J.-P.');
    t.equal(citation.initials('T. Y.'), 'T. Y.');
    const authors = ['Watanabe Yukinobu', 'Niikura Megumi', 'Abe Shinichiro', 'Biswas Sayani', 'Iwamoto Hiroki', 'Hillier Adrian',
      'Kawamura Naritoshi', 'Kawase Shoichiro', 'Matsuzaki Teiichiro', 'Minato Futoshi', 'Mizuno Rurie', 'Tomono Dai', 'Yamaguchi Yuji']
      .map((n) => ({ family: n.split(' ')[0], given: n.split(' ')[1] }));
    const paper = {
      title: 'Muon Nuclear Data Development Project', year: 2026, url: 'https://arxiv.org/abs/2605.15539', arxiv: '2605.15539',
      primaryClass: 'nucl-ex', authors: authors.slice(0, 3),
    };
    const p = citation.paperCitations(paper);
    t.equal(p.APS, 'Y. Watanabe, M. Niikura, and S. Abe, Muon Nuclear Data Development Project, arXiv:2605.15539 (2026).');
    t.equal(citation.paperCitations({ ...paper, authors: authors.slice(0, 2) }).APS.slice(0, 29), 'Y. Watanabe and M. Niikura, M', 'two authors');
    t.equal(citation.paperCitations({ ...paper, authors: authors.slice(0, 10) }).APS.split(', Muon')[0].split(', ').length, 10, 'ten authors are listed');
    t.equal(citation.paperCitations({ ...paper, authors }).APS,
      'Y. Watanabe et al., Muon Nuclear Data Development Project, arXiv:2605.15539 (2026).', 'more than ten: the first and et al.');
    t.equal(p.BibTeX, '@misc{Watanabe2026,\n'
      + '  author = {Watanabe, Yukinobu and Niikura, Megumi and Abe, Shinichiro},\n'
      + '  title = {{Muon Nuclear Data Development Project}},\n'
      + '  year = {2026},\n'
      + '  eprint = {2605.15539},\n'
      + '  archivePrefix = {arXiv},\n'
      + '  primaryClass = {nucl-ex},\n'
      + '  url = {https://arxiv.org/abs/2605.15539}\n}');

    const data = { title: 'muND: Muon Nuclear Data', author: 'muND Project Team' };
    const release = { label: 'v1', version: '1.0.0', kind: 'release', commit: 'abcdef1234', date: '2026-11-16T10:00:00+09:00' };
    const r = citation.dataCitations(data, release, `${EXPLORER}?v=v1`);
    t.equal(r.APS, 'muND Project Team, muND: Muon Nuclear Data, version 1.0.0 (2026), https://ribf.riken.jp/muon/explorer/?v=v1.');
    t.ok(r.BibTeX.startsWith('@misc{muND_v1,\n  author = {{muND Project Team}},'), r.BibTeX);
    t.ok(r.BibTeX.includes('  version = {1.0.0},\n  year = {2026},\n  month = nov,'), 'version, year, month');
    t.ok(!r.BibTeX.includes('note'), 'a release has no note');
    const dev = citation.dataCitations(data, { ...release, label: 'latest', version: '1.0.0+2.gabcdef1', kind: 'development' }, `${EXPLORER}?v=latest`);
    t.equal(dev.APS, 'muND Project Team, muND: Muon Nuclear Data, development version 1.0.0+2.gabcdef1, commit abcdef1, '
      + 'not a stable version (2026), https://ribf.riken.jp/muon/explorer/?v=latest.');
    t.ok(dev.BibTeX.includes('  note = {Development version of commit abcdef1; not a stable version},'), dev.BibTeX);
    t.equal(citation.dataCitations(data, { ...release, date: null }, 'u').APS, 'muND Project Team, muND: Muon Nuclear Data, version 1.0.0, u.', 'no date');
  });

  h.test('explorer: sub-libraries of a version', async (t) => {
    const { manifest } = await published();
    const lt = model.sublibraryStatus(manifest, 'LT');
    t.deepEqual([lt.available, lt.entries, lt.defined, lt.text], [true, 41, true, '41 entries']);
    for (const s of ['XR', 'ES', 'BR']) {
      const status = model.sublibraryStatus(manifest, s);
      t.deepEqual([status.available, status.defined, status.text], [false, false, 'no data yet'], `${s}:`);
    }
    t.equal(model.sublibraryStatus({ sublibraries: { LT: { status: 'available', counts: {} } } }, 'LT').text, 'no data yet');
    t.throws(() => model.buildVersion({ label: 'v1', manifest: { format: 'muND/manifest/9' }, master: {}, lt: {} }),
      'a manifest of an unknown format');
  });

  h.test('explorer: derived values whose original changed', async (t) => {
    const version = await published();
    const curated = version.byId.get('6730248ef6ac');
    t.deepEqual(curated.originals.map((o) => [o.id, o.changed, o.row.entry.datasetId]), [['e2551c5951a7', false, 'e2551c5951a7']]);
    t.equal(version.byId.get('ef8409832d42'), curated, 'a former identifier leads to the entry');
    t.deepEqual(idsOf(version.usedBy.get('e2551c5951a7')), ['6730248ef6ac']);
    const edited = await published({
      edit: (data) => jsonfmt.setNumber(data.find((e) => e.datasetId === 'e2551c5951a7').observable.lifetime, 'value', '744.9'),
    });
    t.deepEqual(edited.byId.get('6730248ef6ac').originals.map((o) => o.changed), [true], 'a corrected original is flagged');
    t.ok(edited.byId.get('18d9d393dfc6').originals.every((o) => !o.changed), 'the others are not');
  });
}
