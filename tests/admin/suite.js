// Tests of the data entry tool (admin/js) that run without a page: the
// client of the local server against tests/admin/fake-local.js, the
// workspace and saving, the document operations of the editor, versions,
// line differences and the reading of pasted rows.
//
// The repository is the frozen test database tests/vectors/repository.json
// (tests/fixtures/data) with the schemas, VERSION, CHANGELOG.md and two files
// the server does not list.  Same `modules` and `env` as tests/js/suite.js.

import { FakeLocal } from './fake-local.js';

const MIZUNO = 'data/LT/EXP/Mizuno2025_4d2ed5c83736.json';
const CURATED = 'data/LT/CUR/unpublished_15fd4fea826c.json';
const BIBLIOGRAPHY = 'data/master/bibliography.json';
const CHANGELOG = '# Changelog\n\nChanges of the data.\n\n## 0.1.0 - 2026-11-16\n\n- First version.\n';

export function register(h, modules, env) {
  const { jsonfmt, database } = modules;
  const ops = modules.document;
  const { LocalBackend, ConflictError, InvalidError, ApiError } = modules.backend;
  const { Workspace } = modules.workspace;

  async function repositoryFiles() {
    const files = { ...JSON.parse(await env.text('vectors', 'repository.json')).files };
    for (const name of new Set(Object.values(database.SCHEMA_FILES))) files[`schema/v1/${name}`] = await env.text('schema', name);
    files.VERSION = '0.1.0\n';
    files['CHANGELOG.md'] = CHANGELOG;
    files['README.md'] = 'not part of the database\n';
    files['data/LT/README.md'] = 'notes on the LT files: not a data file\n';
    return files;
  }

  function memoryStorage() {
    const map = new Map();
    return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
  }

  /** A workspace on the fake local server holding the test database. */
  async function connected(storage = memoryStorage()) {
    const server = new FakeLocal({ files: await repositoryFiles() });
    const backend = new LocalBackend({ fetchImpl: server.fetch });
    await backend.connect();
    const ws = new Workspace(backend, storage);
    await ws.load();
    return { server, backend, ws, storage };
  }

  const errors = (ws) => ws.issues().filter((i) => i.level === 'error');
  const edit = (ws, path, from, to) => ws.stage(path, ws.text(path).replace(from, to));

  // The editor's handling of a document (admin/js/editor.js) without the page:
  // open a file, store it as a draft, apply the text of the JSON tab.
  function open(ws, path) {
    const doc = jsonfmt.parse(ws.text(path));
    return { ws, path, doc, tracker: new ops.IdTracker(doc, ops.datasetIdsOf(ws.baseline(path))), review: null };
  }
  function store(ed) {
    database.assignIds(ed.doc);
    ed.review = ed.tracker.review(ed.doc, ops.datasetIdsOf(ed.ws.baseline(ed.path)), ed.ws, ed.path);
    const target = database.filePath(ed.doc, ed.ws.db.reference(ed.doc.meta.bibId));
    if (!ed.ws.move(ed.path, target, ed.ws.db.canonicalText(ed.doc))) throw new Error(`${target} is taken`);
    ed.path = target;
    return ed.review;
  }
  function applyJson(ed, text) {
    const next = jsonfmt.parse(text);
    ed.tracker.adopt(ed.doc, next);
    ed.doc = next;
  }
  const choose = (ed, entry, choice) => ed.tracker.choose(entry, choice, ed.doc, ed.ws, ed.path);
  const shown = (ed) => ed.ws.db.canonicalText(ed.doc);           // the text of the JSON tab
  const changesOf = (review) => review.changes.map((c) => [c.from, c.to, c.choice]);
  const codes = (ws, path) => ws.issuesFor(path).map((i) => i.code);
  const dataLines = (text) => text.split('\n').filter((l) => l.startsWith('    {"datasetId"')).map((l) => l.replace(/,$/, ''));

  h.test('admin: the local server: session, files, history', async (t) => {
    const server = new FakeLocal({ files: await repositoryFiles() });
    const backend = new LocalBackend({ fetchImpl: server.fetch });
    const { session, sync } = await backend.connect();
    t.deepEqual(server.log, ['GET /api/session', 'POST /api/sync']);
    t.equal(session.repository, 'someone/mund');
    t.equal(backend.kind, 'local');
    t.deepEqual(sync, { updated: false, pending: 0, error: null });
    const files = await backend.listFiles();
    t.ok(files.some((f) => f.path === 'data/master/facilities.json') && files.some((f) => f.path === 'VERSION'));
    t.ok(!files.some((f) => f.path.endsWith('README.md')), 'only the files of the database are listed');
    t.equal(await backend.readFile(MIZUNO), server.files.get(MIZUNO));
    let failure = null;
    try { await backend.readFile('README.md'); } catch (err) { failure = err; }
    t.ok(failure instanceof ApiError && failure.status === 404 && failure.code === 'not-found');
    t.deepEqual(await backend.history(), []);

    const ws = new Workspace(backend, memoryStorage());
    await ws.load();
    t.ok(!ws.paths().includes('data/LT/README.md'));
    t.deepEqual(ws.dataFilePaths(), [CURATED, 'data/LT/EVAL/Iwamoto2025_194f28ccc0dc.json', MIZUNO]);
    t.deepEqual(ws.db.sortedFiles().map((f) => f.path), ws.dataFilePaths());
    t.equal(ws.upstreamText('CHANGELOG.md'), CHANGELOG);
    t.deepEqual(Object.keys(ws.schemas).sort(), [...new Set(Object.values(database.SCHEMA_FILES))].sort());
    t.deepEqual(errors(ws), []);
    t.ok(ws.physics() !== null);
    edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
    await ws.save(ws.saveMessage());
    t.deepEqual(await backend.history(MIZUNO, 5), [{ sha: server.commits[0].sha, author: 'Test User', date: '2026-11-17T00:00:00+09:00', message: 'Update LT/EXP Mizuno2025' }]);
    t.deepEqual(await backend.history('data/master'), []);
  });

  h.test('admin: workspace keeps drafts, follows renamed identifiers and saves', async (t) => {
    const { server, backend, ws, storage } = await connected();
    t.equal(ws.changes().length, 0);
    t.equal(ws.upstreamIds().has('d34215fe02f0'), true);
    t.equal(ws.upstreamIds().has('4d2ed5c83736'), false, 'MetaIDs are not datasetIds');

    // correct an element: Si-30 -> S-30 in the Mizuno file, as the editor does
    const ed = open(ws, MIZUNO);
    const row = ed.doc.data.find((r) => r.datasetId === 'd34215fe02f0');
    row.nuclide.element = 'S';
    let review = store(ed);
    t.ok(row.datasetId !== 'd34215fe02f0');
    t.deepEqual(changesOf(review), [['d34215fe02f0', row.datasetId, null]], 'the change waits for a choice');
    t.equal(ws.status(MIZUNO), 'modified');
    t.equal(ws.status(CURATED), 'unchanged', 'nothing is re-pointed before the choice');
    t.deepEqual(errors(ws).map((i) => i.code), ['E_ORIGINAL_MISSING']);
    t.deepEqual(choose(ed, row, 'same'), [CURATED], 'a correction of the same entry re-points the references');
    review = store(ed);
    t.deepEqual(changesOf(review), [['d34215fe02f0', row.datasetId, 'same']]);
    t.deepEqual(row.legacyIds, ['3fc99c56a5ad', 'd34215fe02f0']);
    t.deepEqual(errors(ws), []);
    t.deepEqual(jsonfmt.parse(ws.text(CURATED)).data[4].originalData, [{ datasetId: row.datasetId, entryHash: '1c0e1571f823' }],
      'the recorded entryHash stays');
    t.deepEqual(codes(ws, CURATED), ['W_ORIGINAL_CHANGED'], 'the curated value must be checked again');
    t.equal(ws.changes().length, 2);

    // drafts survive a reload of the page
    const again = new Workspace(backend, storage);
    await again.load();
    t.equal(again.changes().length, 2);
    t.equal(again.text(MIZUNO), ws.text(MIZUNO));

    // a file written back to its saved text has no draft
    again.stage(MIZUNO, again.upstreamText(MIZUNO));
    t.equal(again.status(MIZUNO), 'unchanged');
    t.deepEqual(again.replaceIds(new Map([[row.datasetId, 'd34215fe02f0']]), MIZUNO), [CURATED]);
    t.equal(again.status(CURATED), 'unchanged', 'identifiers changed back: no change left');
    t.equal(again.changes().length, 0);

    // a reference added to the bibliography: sorted by id, found without regard to case, file stays valid
    let notified = 0;
    ws.onChange(() => { notified++; });
    t.equal(ws.db.reference('muND:unpublished'), null);
    ws.setReference({ id: 'muND:unpublished', title: ['Curation in progress'], author: [{ family: 'Niikura', given: 'M.' }],
      published: { 'date-parts': [[2026]] } });
    t.equal(ws.status(BIBLIOGRAPHY), 'modified');
    t.equal(ws.db.reference('MUND:UNPUBLISHED').title[0], 'Curation in progress');
    t.deepEqual(jsonfmt.parse(ws.text(BIBLIOGRAPHY)).references.map((r) => r.id),
      ['DOI:10.1103/PhysRevC.111.034614', 'DOI:10.1103/vl7z-rzp8', 'muND:unpublished']);
    ws.setReference({ id: 'muND:UNPUBLISHED', title: ['Curation of lifetimes'] });
    t.equal(jsonfmt.parse(ws.text(BIBLIOGRAPHY)).references.length, 3, 'an entry is replaced, not duplicated');
    t.deepEqual(ws.issuesFor(BIBLIOGRAPHY), []);
    await null;
    t.equal(notified, 1, 'listeners are told once per batch of changes');

    // one save for all drafts; the drafts are gone afterwards
    const message = ws.saveMessage('Si-30 was S-30 in the table of the paper.');
    t.equal(message, 'Update LT/CUR unpublished; Update LT/EXP Mizuno2025; Update master/bibliography\n\nSi-30 was S-30 in the table of the paper.');
    const result = await ws.save(message);
    t.deepEqual(result, { sha: server.commits[0].sha, sent: true, pending: 0, error: null });
    t.equal(notified, 2, 'and once after the save');
    t.equal(ws.changes().length, 0);
    t.equal(storage.map.size, 0, 'drafts are cleared after the save');
    t.deepEqual(server.commits[0].paths, [CURATED, MIZUNO, BIBLIOGRAPHY]);
    t.equal(server.commits[0].message, message);
    t.ok(server.github.get(MIZUNO).includes(`"datasetId": "${row.datasetId}", "nuclide": {"element": "S"`), 'sent to GitHub');
    t.ok(server.github.get(MIZUNO).includes('"legacyIds": ["3fc99c56a5ad", "d34215fe02f0"]'));
    t.ok(server.github.get(CURATED).includes(row.datasetId));
    t.ok(server.github.get(BIBLIOGRAPHY).includes('Curation of lifetimes'));
    t.equal(ws.upstreamText(MIZUNO), server.files.get(MIZUNO));
    t.ok(ws.upstreamIds().has(row.datasetId), 'saved identifiers are known after the save');
  });

  h.test('admin: the message of a save names the files', async (t) => {
    const { ws } = await connected();
    t.equal(ws.saveMessage(), '');
    edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
    t.equal(ws.saveMessage(), 'Update LT/EXP Mizuno2025');
    t.equal(ws.saveMessage('  Typo.  '), 'Update LT/EXP Mizuno2025\n\nTypo.');
    ws.discardAll();
    t.equal(ws.move(MIZUNO, 'data/LT/EXP/Nizuno2025_4d2ed5c83736.json', ws.text(MIZUNO)), true);
    t.equal(ws.saveMessage(), 'Update LT/EXP Nizuno2025', 'a renamed file is one update');
    ws.discardAll();
    ws.stage('data/LT/TH/Tanaka2020_0123456789ab.json', '{}\n');
    ws.stageDelete(CURATED);
    t.equal(ws.saveMessage(), 'Delete LT/CUR unpublished; Add LT/TH Tanaka2020');
    edit(ws, 'data/master/facilities.json', 'J-PARC', 'J-PARC ');
    edit(ws, 'VERSION', '0.1.0', '0.1.1');
    t.equal(ws.saveMessage('Why.'), 'Update 4 files\n\nWhy.\n\n- Update VERSION\n- Delete LT/CUR unpublished\n- Add LT/TH Tanaka2020\n- Update master/facilities');
  });

  h.test('admin: drafts live in memory when the storage is blocked', async (t) => {
    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    const { ws } = await connected(blocked);
    edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
    t.equal(ws.status(MIZUNO), 'modified');
    t.equal(ws.storageProblem(), 'write', 'and that is reported');
    await ws.load();
    t.equal(ws.status(MIZUNO), 'modified', 'a reload keeps the drafts');
  });

  h.test('admin: a file is never stored over another registered file', async (t) => {
    const { ws } = await connected();
    // a new EXP document with the DOI of the Mizuno publication gets the Mizuno file name
    const doc = ops.newDocument('EXP');
    doc.meta.bibId = 'DOI:10.1103/vl7z-rzp8';
    doc.meta.facility = 'J-PARC (D1)';
    database.assignIds(doc);
    const target = database.filePath(doc, ws.db.reference(doc.meta.bibId));
    t.equal(target, MIZUNO);
    t.equal(ws.move(null, target, ws.db.canonicalText(doc)), false, 'a new file may not replace it');
    t.equal(ws.move(CURATED, target, ws.db.canonicalText(doc)), false, 'another file may not move onto it');
    t.equal(ws.changes().length, 0, 'nothing was changed');
    t.equal(ws.text(MIZUNO), ws.upstreamText(MIZUNO));
    // the same file under its own name is fine
    t.equal(ws.move(MIZUNO, MIZUNO, ws.upstreamText(MIZUNO).replace('"value": 87.0', '"value": 87.5')), true);
    t.equal(ws.status(MIZUNO), 'modified');
  });

  h.test('admin: a renamed file is discarded and deleted as a pair', async (t) => {
    const { ws } = await connected();
    const moved = 'data/LT/EXP/Nizuno2025_4d2ed5c83736.json';
    const text = ws.upstreamText(MIZUNO);
    const rename = () => t.equal(ws.move(MIZUNO, moved, text), true);

    rename();
    t.equal(ws.status(MIZUNO), 'deleted');
    t.equal(ws.status(moved), 'added');
    t.equal(ws.baseline(moved), text, 'compared with the file it came from');
    t.deepEqual(ws.changes().map((c) => [c.path, c.status, c.origin]), [[MIZUNO, 'deleted', null], [moved, 'added', MIZUNO]]);

    ws.discard(MIZUNO);                       // either half undoes the rename
    t.equal(ws.changes().length, 0);
    t.equal(ws.text(MIZUNO), text);
    t.equal(ws.text(moved), null);

    rename();
    ws.discard(moved);
    t.equal(ws.changes().length, 0);

    rename();
    ws.stageDelete(moved);                    // deleting the renamed file deletes the original
    t.deepEqual(ws.changes().map((c) => [c.path, c.status]), [[MIZUNO, 'deleted']]);
    ws.discard(MIZUNO);

    rename();                                 // renamed twice: still one pair with the first origin
    const again = 'data/LT/EXP/Ozuno2025_4d2ed5c83736.json';
    t.equal(ws.move(moved, again, text), true);
    t.deepEqual(ws.changes().map((c) => [c.path, c.status, c.origin]), [[MIZUNO, 'deleted', null], [again, 'added', MIZUNO]]);
    t.equal(ws.move(again, MIZUNO, text), true, 'renamed back');
    t.equal(ws.changes().length, 0);
  });

  h.test('admin: a file changed by someone else is rebased before it is saved', async (t) => {
    const { server, ws } = await connected();
    const mine = ws.upstreamText(MIZUNO).replace('"value": 87.0', '"value": 87.5');
    ws.stage(MIZUNO, mine);
    t.deepEqual(ws.changes().map((c) => c.outdated), [false]);
    const theirs = server.github.get(MIZUNO).replace('"value": 230.3', '"value": 230.4');
    server.changeOnGitHub({ [MIZUNO]: theirs });

    let conflict = null;
    try { await ws.save('mine'); } catch (err) { conflict = err; }
    t.ok(conflict instanceof ConflictError);
    t.deepEqual(conflict.paths, [MIZUNO]);
    t.equal(server.commits.length, 0, 'nothing was saved');
    t.equal(ws.text(MIZUNO), mine, 'the draft is kept');
    t.deepEqual(ws.changes().map((c) => [c.path, c.outdated]), [[MIZUNO, true]], 'the files were read again: the draft is outdated');
    t.equal(ws.baseline(MIZUNO), theirs, 'the changes are shown against their version');
    try { await ws.save('mine'); conflict = null; } catch (err) { conflict = err; }
    t.ok(conflict instanceof ConflictError, 'an outdated draft is still refused');

    ws.rebase(MIZUNO);
    t.deepEqual(ws.changes().map((c) => c.outdated), [false]);
    await ws.save('mine, over theirs');
    t.equal(server.github.get(MIZUNO), mine);

    // a draft equal to the new saved text leaves nothing to save
    ws.stage(MIZUNO, theirs);
    server.changeOnGitHub({ [MIZUNO]: theirs });
    await ws.backend.sync();
    await ws.load();
    t.equal(ws.changes().length, 0, 'a draft equal to the saved text is dropped on load');
  });

  h.test('admin: a save that could not be sent is sent later', async (t) => {
    const { server, backend, ws } = await connected();
    server.online = false;
    edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
    const result = await ws.save(ws.saveMessage());
    t.equal(result.sent, false);
    t.equal(result.error.code, 'offline');
    t.equal(ws.changes().length, 0, 'saved on this computer: no draft left');
    t.equal(backend.pending, 1);
    t.equal(backend.sendError.code, 'offline');
    t.ok(server.files.get(MIZUNO).includes('"value": 87.5') && server.github.get(MIZUNO).includes('"value": 87.0'));
    t.equal((await backend.send()).sent, false, 'still offline');
    server.online = true;
    t.deepEqual(await backend.send(), { sent: true, pending: 0, error: null });
    t.equal(backend.pending, 0);
    t.equal(backend.sendError, null);
    t.ok(server.github.get(MIZUNO).includes('"value": 87.5'));
    const fresh = new LocalBackend({ fetchImpl: server.fetch });
    server.online = false;
    const { sync } = await fresh.connect();
    t.equal(sync.error.code, 'offline', 'starting offline is reported, not fatal');
  });

  h.test('admin: a save that would make the database invalid saves nothing', async (t) => {
    const { server, ws } = await connected();
    const issue = { level: 'error', code: 'E_SCHEMA', file: MIZUNO, pointer: '/data/0/nuclide/mass', message: "'x' is not of type 'integer'" };
    server.invalid = [issue];
    edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
    const before = server.files.get(MIZUNO);
    let refused = null;
    try { await ws.save(ws.saveMessage()); } catch (err) { refused = err; }
    t.ok(refused instanceof InvalidError);
    t.deepEqual(refused.issues, [issue]);
    t.equal(server.files.get(MIZUNO), before, 'nothing saved');
    t.equal(server.commits.length, 0);
    t.equal(ws.status(MIZUNO), 'modified', 'the draft is kept');
    server.invalid = null;
    t.equal((await ws.save(ws.saveMessage())).sent, true);
  });

  h.test('admin: a version changes VERSION and CHANGELOG.md and is tagged', async (t) => {
    const { nextVersion, releaseChanges } = modules.release;
    t.equal(nextVersion('0.1.0', 'patch'), '0.1.1');
    t.equal(nextVersion('0.1.3\n', 'minor'), '0.2.0');
    t.equal(nextVersion('0.9.9', 'major'), '1.0.0');
    const r = releaseChanges('0.1.0\n', CHANGELOG, 'minor', ['Si isotopes added', 'Typo fixed'], '2026-12-01');
    t.equal(r.version, '0.2.0');
    t.equal(r.changelog, '# Changelog\n\nChanges of the data.\n\n## 0.2.0 - 2026-12-01\n\n- Si isotopes added\n- Typo fixed\n\n## 0.1.0 - 2026-11-16\n\n- First version.\n');
    t.deepEqual(releaseChanges(null, null, 'patch', ['First'], '2026-12-01'),
      { version: '0.0.1', changelog: '# Changelog\n\n## 0.0.1 - 2026-12-01\n\n- First\n' });

    // as the page publishes a version: save VERSION and CHANGELOG.md, then tag
    const { server, backend, ws } = await connected();
    ws.stage('VERSION', `${r.version}\n`);
    ws.stage('CHANGELOG.md', r.changelog);
    const saved = await ws.save('Release 0.2.0');
    const tag = await backend.tag('v0.2.0');
    t.deepEqual(tag, { name: 'v0.2.0', sha: saved.sha, sent: true, error: null });
    t.equal(server.github.get('VERSION'), '0.2.0\n');
    t.equal(ws.upstreamText('CHANGELOG.md'), r.changelog);
    t.deepEqual(await backend.tags(), [{ name: 'v0.2.0', sha: saved.sha }]);
    let failure = null;
    try { await backend.tag('v0.2.0'); } catch (err) { failure = err; }
    t.ok(failure instanceof ApiError && failure.status === 400, 'a version is tagged once');
    server.online = false;
    const unsent = await backend.tag('v0.2.1');
    t.equal(unsent.sent, false);
    t.equal(backend.sendError.code, 'offline');
  });

  h.test('admin: document operations of the editor', async (t) => {
    const schemas = { lt: JSON.parse(await env.text('schema', 'lt.schema.json')) };
    t.ok(ops.isBibId('DOI:10.1103/PhysRevC.35.2212', schemas.lt));
    t.ok(ops.isBibId('NSR:1987SU06', schemas.lt) && ops.isBibId('muND:Suzuki1975thesis', schemas.lt));
    t.ok(!ops.isBibId('https://doi.org/10.1103/x', schemas.lt) && !ops.isBibId('DOI:10.1103/a;b', schemas.lt) && !ops.isBibId('', schemas.lt));
    t.ok(!ops.isBibId('10.1103/x', schemas.lt) && !ops.isBibId('1987SU06', schemas.lt) && !ops.isBibId('mund:x', schemas.lt),
      'DOI:, NSR: and muND: are written out');
    t.ok(!ops.isBibId('DOI:10.1103/x', null), 'no schema: nothing is a bibId');
    // what is typed or pasted gets its prefix
    t.deepEqual(['10.1103/x', 'https://doi.org/10.1103/x', 'doi: 10.1103/x', 'DOI:10.1103/x', '1987SU06', 'NSR:1987SU06', 'muND:x', ' unpublished ']
      .map(ops.sourceText), ['DOI:10.1103/x', 'DOI:10.1103/x', 'DOI:10.1103/x', 'DOI:10.1103/x', 'NSR:1987SU06', 'NSR:1987SU06', 'muND:x', 'unpublished']);

    // shape: what the grid cannot edit is reported, nothing is added or replaced
    const text = '{"format": "muND/LT/1", "sublibrary": "LT", "datasetType": "curated", "meta": {"bibId": "DOI:10.1000/test"}, '
      + '"data": [{"nuclide": {"element": "Si", "mass": 28}, "observable": {"kind": "lifetime", "lifetime": {"value": 743.90, "unit": "ns"}}}, 7, '
      + '{"observable": {"kind": "speed"}}, {"nuclide": {"element": "Si", "mass": 0, "isomer": 0}, "observable": {"kind": "lifetime", "lifetime": {"value": 8.7e-8, "unit": "s", "uncertainties": "none"}}}]}';
    const doc = jsonfmt.parse(text);
    t.equal(ops.formProblem(doc), null);
    t.equal(ops.formProblem({ meta: 'x', data: [] }), 'meta');
    t.equal(ops.formProblem({ meta: {}, data: {} }), 'data');
    t.deepEqual(doc.data.map(ops.gridProblem), [null, 'entry', 'nuclide', null]);
    t.equal(ops.gridProblem({ nuclide: {}, observable: { kind: 'speed' } }), 'kind');
    t.equal(ops.gridProblem({ nuclide: {}, observable: { kind: 'lifetime' } }), 'value');
    t.deepEqual(ops.unitChoices('lifetime', 's'), ['s', 'ns', 'us'], 'an unknown unit is offered (and kept) first');
    t.deepEqual(ops.unitChoices('lifetime', 'us'), ['ns', 'us']);
    t.equal(ops.uncertaintyText(doc.data[3].observable.lifetime, 'total'), '', 'uncertainties that are not a list show as empty');
    t.equal(jsonfmt.stringify(doc), jsonfmt.stringify(jsonfmt.parse(text)), 'reading changes nothing');

    // uncertainties: kept in source order, empty text removes, other text is kept as typed
    const block = doc.data[0].observable.lifetime;
    t.ok(!('uncertainties' in block));
    ops.setUncertainty(block, 'total', '');
    t.ok(!('uncertainties' in block), 'removing what is not there adds nothing');
    ops.setUncertainty(block, 'systematic', '1.0');
    ops.setUncertainty(block, 'total', '5.0');
    ops.setUncertainty(block, 'statistical', '2.50');
    t.deepEqual(block.uncertainties.map((u) => u.source), ['total', 'statistical', 'systematic']);
    t.equal(ops.uncertaintyText(block, 'statistical'), '2.50');
    ops.setUncertainty(block, 'total', '');
    t.deepEqual(block.uncertainties.map((u) => u.source), ['statistical', 'systematic']);
    ops.setUncertainty(block, 'systematic', 'abc');
    t.equal(block.uncertainties[1].value, 'abc');
    ops.setNumberField(block, 'value', '743.900');
    t.equal(ops.numberText(block, 'value'), '743.900');

    // quantity: the value block moves with the kind; value and unit are kept as they are
    // (a unit that does not fit is reported, never replaced by a guess)
    const entry = doc.data[0];
    ops.setKind(entry, 'capture_rate');
    t.deepEqual(Object.keys(entry.observable), ['kind', 'capture_rate']);
    t.equal(entry.observable.capture_rate.unit, 'ns');
    t.equal(ops.numberText(entry.observable.capture_rate, 'value'), '743.900');
    ops.setKind(entry, 'lifetime');
    t.equal(entry.observable.lifetime.unit, 'ns');

    // datasetType: members the new type does not allow are dropped
    entry.originalData = [{ datasetId: '09c1551803d0', entryHash: '660544992a4a' }];
    doc.meta.facility = 'J-PARC (D1)';
    doc.meta.referenceDatabase = 'x';
    ops.setDatasetType(doc, 'TH');
    t.equal(doc.datasetType, 'theory');
    t.ok(!('facility' in doc.meta) && !('referenceDatabase' in doc.meta) && !('originalData' in entry));
    t.equal(doc.data[1], 7, 'an entry that is not an object is left alone');

    // references in originalData follow new ids; the recorded entryHash stays
    const cur = { data: [{ originalData: [{ datasetId: 'a', entryHash: '1' }, { datasetId: 'b', entryHash: '2' }] },
      { originalData: [{ datasetId: 'c', entryHash: '3' }, 'b'] }, { comment: 'x' }, 7] };
    t.equal(ops.replaceOriginalIds(cur, new Map([['b', 'B']])), true);
    t.deepEqual(cur.data.map((e) => e.originalData), [[{ datasetId: 'a', entryHash: '1' }, { datasetId: 'B', entryHash: '2' }],
      [{ datasetId: 'c', entryHash: '3' }, 'b'], undefined, undefined]);
    t.equal(ops.replaceOriginalIds(cur, new Map([['z', 'Z']])), false);
    t.deepEqual(ops.originalIds(cur.data[1]), ['c', 'b']);
    t.equal(ops.entryLabel({ nuclide: { element: 'Si', mass: 0 }, key: 'plate' }), 'natSi [plate]');
    t.equal(ops.fileName(MIZUNO), 'LT/EXP Mizuno2025');
  });

  h.test('admin: rows are matched by datasetId: reordered, inserted and deleted rows keep their identifiers', async (t) => {
    const { ws } = await connected();
    const savedIds = [...ops.datasetIdsOf(ws.upstreamText(MIZUNO))];
    const none = (review) => [review.changes, review.ambiguous, review.added, review.deleted];

    // JSON tab: the Mg and Al rows of the curated file swapped (both have legacyIds and original data)
    let ed = open(ws, CURATED);
    const lines = shown(ed).split('\n');
    const mg = lines.findIndex((l) => l.includes('"element": "Mg"'));
    [lines[mg], lines[mg + 1]] = [lines[mg + 1], lines[mg]];
    applyJson(ed, lines.join('\n'));
    t.deepEqual(none(store(ed)), [[], [], [], []], 'a new order is no change of identity');
    t.deepEqual(ed.doc.data.slice(0, 2).map((e) => [e.datasetId, e.legacyIds, ops.originalIds(e)]),
      [['b15200d13c23', ['935cd42f14bd', '18d9d393dfc6'], ['dd91adba8444', '9f594e0f6502']], ['0c29e247f762', ['4f888682a401', 'f02832f1580f'], ['09c1551803d0']]]);
    t.deepEqual(dataLines(ws.text(CURATED)).sort(), dataLines(ws.upstreamText(CURATED)).sort(), 'every row is as it was');
    t.deepEqual(ws.issues().filter((i) => i.file.startsWith('data/LT/')), []);
    ws.discardAll();

    // the form: rows sorted (the same rows in another order)
    ed = open(ws, MIZUNO);
    ed.doc.data.reverse();
    t.deepEqual(none(store(ed)), [[], [], [], []]);
    t.deepEqual(dataLines(ws.text(MIZUNO)).sort(), dataLines(ws.upstreamText(MIZUNO)).sort());
    t.equal(ws.status(CURATED), 'unchanged');
    ws.discardAll();

    // a row inserted at the head: in the form ...
    ed = open(ws, MIZUNO);
    const ca = ops.newEntry('Ca', 40, 'lifetime', 'ns');
    ops.setNumberField(ca.observable.lifetime, 'value', '333.0');
    ed.doc.data.unshift(ca);
    let review = store(ed);
    t.deepEqual([review.changes, review.added, review.deleted], [[], [ca], []]);
    t.deepEqual(ed.doc.data.slice(1).map((e) => e.datasetId), savedIds);
    t.ok(ed.doc.data.every((e) => !e.legacyIds || e.legacyIds.length === 1), 'no former identifier is added');
    t.equal(ws.status(CURATED), 'unchanged');
    t.deepEqual(errors(ws), []);
    ws.discardAll();
    // ... and in the JSON tab
    ed = open(ws, MIZUNO);
    const json = shown(ed).split('\n');
    json.splice(json.findIndex((l) => l.startsWith('    {"datasetId"')), 0,
      '    {"nuclide": {"element": "Ca", "mass": 40, "isomer": 0}, "observable": {"kind": "lifetime", "lifetime": {"value": 333.0, "unit": "ns", "uncertainties": []}}},');
    applyJson(ed, json.join('\n'));
    review = store(ed);
    t.deepEqual([review.changes, review.added.length, review.deleted], [[], 1, []]);
    t.deepEqual(ed.doc.data.slice(1).map((e) => e.datasetId), savedIds);
    t.equal(ws.status(CURATED), 'unchanged');
    ws.discardAll();

    // a row deleted in the middle (Si-29), in the JSON tab and in the form: the others keep their
    // identifiers; the reference to the deleted row is reported, not moved to another row
    for (const remove of [
      (e) => applyJson(e, shown(e).split('\n').filter((l) => !l.includes('"ca4139686296"')).join('\n')),
      (e) => e.doc.data.splice(4, 1),
    ]) {
      ed = open(ws, MIZUNO);
      remove(ed);
      review = store(ed);
      t.deepEqual([review.changes, review.added, review.deleted], [[], [], ['ca4139686296']]);
      t.deepEqual(ed.doc.data.map((e) => e.datasetId), savedIds.filter((id) => id !== 'ca4139686296'));
      t.equal(ws.status(CURATED), 'unchanged');
      t.deepEqual(errors(ws).map((i) => [i.code, i.file, i.pointer]), [['E_ORIGINAL_MISSING', CURATED, '/data/3/originalData/0']]);
      ws.discardAll();
    }
  });

  h.test('admin: a changed identity is a correction of the same entry or different data, as chosen', async (t) => {
    const { ws } = await connected();

    // 'different': no legacyIds, the reference stays and is reported
    let ed = open(ws, MIZUNO);
    const si30 = ed.doc.data.find((e) => e.datasetId === 'd34215fe02f0');
    si30.nuclide.element = 'S';
    let review = store(ed);
    const s30 = si30.datasetId;
    t.deepEqual(changesOf(review), [['d34215fe02f0', s30, null]]);
    t.deepEqual(choose(ed, si30, 'different'), []);
    t.deepEqual(changesOf(store(ed)), [['d34215fe02f0', s30, 'different']]);
    t.ok(!('legacyIds' in si30));
    t.equal(ws.status(CURATED), 'unchanged');
    t.deepEqual(errors(ws).map((i) => [i.code, i.file]), [['E_ORIGINAL_MISSING', CURATED]]);

    // changed to 'same': the former ID is kept and the reference follows (in one save with this file)
    t.deepEqual(choose(ed, si30, 'same'), [CURATED]);
    store(ed);
    t.deepEqual(si30.legacyIds, ['3fc99c56a5ad', 'd34215fe02f0']);
    t.deepEqual(ops.originalIds(jsonfmt.parse(ws.text(CURATED)).data[4]), [s30]);
    t.deepEqual(errors(ws), []);
    t.deepEqual(ws.changes().map((c) => c.path), [CURATED, MIZUNO]);

    // the draft read again (the page was reloaded): the choice is known from legacyIds
    t.deepEqual(changesOf(store(open(ws, MIZUNO))), [['d34215fe02f0', s30, 'same']]);

    // the identifiers change again: the choice is undone and asked again
    si30.nuclide.mass = 31;
    review = store(ed);
    t.deepEqual(changesOf(review), [['d34215fe02f0', si30.datasetId, null]]);
    t.deepEqual(si30.legacyIds, ['3fc99c56a5ad'], 'the former identifiers as saved');
    t.equal(ws.status(CURATED), 'unchanged', 'the reference names the saved ID again');

    // changed back: nothing to choose, nothing changed
    si30.nuclide.element = 'Si';
    si30.nuclide.mass = 30;
    review = store(ed);
    t.deepEqual([review.changes, review.deleted], [[], []]);
    t.equal(ws.status(MIZUNO), 'unchanged');

    // an entry with legacyIds of its own: 'different' drops them, 'same' adds the former ID; discarding undoes the choice
    const cur = open(ws, CURATED);
    const mg = cur.doc.data[0];
    mg.nuclide.element = 'Na';
    store(cur);
    choose(cur, mg, 'different');
    store(cur);
    t.ok(!('legacyIds' in mg));
    choose(cur, mg, 'same');
    store(cur);
    t.deepEqual(mg.legacyIds, ['4f888682a401', 'f02832f1580f', '0c29e247f762']);
    cur.tracker.undoAll(cur.doc, ws, cur.path);
    t.deepEqual(mg.legacyIds, ['4f888682a401', 'f02832f1580f']);
    ws.discardAll();

    // the key of the file changed: every row changes and the file is renamed; all corrections, saved together
    ed = open(ws, MIZUNO);
    ed.doc.meta.key = 'run2';
    review = store(ed);
    t.equal(review.changes.length, 10);
    t.ok(ed.path !== MIZUNO, 'the file name follows the MetaID');
    t.equal(errors(ws).filter((i) => i.code === 'E_ORIGINAL_MISSING').length, 10, 'before the choice the references do not resolve');
    for (const c of review.changes) choose(ed, c.entry, 'same');
    store(ed);
    t.deepEqual(errors(ws), []);
    t.deepEqual(ws.issuesFor(CURATED), [], 'the contents did not change: nothing to check again');
    t.ok(ed.doc.data.every((e) => e.legacyIds && e.legacyIds.length === 2), 'the former identifier follows those saved');
    t.deepEqual(ws.changes().map((c) => c.path).sort(), [CURATED, MIZUNO, ed.path].sort());
    ws.discardAll();

    // ambiguous: two rows made from one saved row in the JSON tab; nothing is re-pointed
    ed = open(ws, MIZUNO);
    const lines = shown(ed).split('\n');
    const at = lines.findIndex((l) => l.includes('"d34215fe02f0"'));
    lines.splice(at, 1, lines[at].replace('"element": "Si"', '"element": "S"'), lines[at].replace('"element": "Si"', '"element": "P"'));
    applyJson(ed, lines.join('\n'));
    review = store(ed);
    t.deepEqual(review.changes, []);
    t.deepEqual(review.ambiguous.map((a) => [a.from, a.entries.length]), [['d34215fe02f0', 2]]);
    t.equal(ws.status(CURATED), 'unchanged');
    t.ok(ed.doc.data.every((e) => !e.legacyIds || e.legacyIds.length === 1), 'no former identifier is added');
    // one of them deleted again: the other one is the changed row, to be chosen for
    applyJson(ed, shown(ed).split('\n').filter((l) => !l.includes('"element": "P"')).join('\n'));
    t.deepEqual(changesOf(store(ed)), [['d34215fe02f0', s30, null]]);
    ws.discardAll();

    // the form: a row duplicated (the copy has no datasetId) and the original changed: the copy is the saved row
    ed = open(ws, MIZUNO);
    const original = ed.doc.data[5];
    const copy = jsonfmt.clone(original);
    delete copy.datasetId;
    ed.doc.data.splice(6, 0, copy);
    original.key = 'b';
    review = store(ed);
    t.deepEqual([review.changes, review.ambiguous, review.deleted, review.added], [[], [], [], [original]]);
    t.equal(copy.datasetId, 'd34215fe02f0');
    t.equal(ws.status(CURATED), 'unchanged');
  });

  h.test('admin: what does not fit the format is kept as it is: an unknown unit is not rewritten', async (t) => {
    const { server, backend, ws } = await connected();
    const text = server.github.get(MIZUNO).replace('"value": 87.0, "unit": "ns"', '"value": 8.7e-8, "unit": "s"')
      .replace('{"element": "Mn", "mass": 55, "isomer": 0}', '{"element": "Mn", "mass": 55}');
    server.changeOnGitHub({ [MIZUNO]: text });
    await backend.sync();
    await ws.load();
    const ed = open(ws, MIZUNO);
    const ag = ed.doc.data[9];
    t.equal(ops.gridProblem(ag), null, 'the grid shows the row');
    t.deepEqual(ops.unitChoices('lifetime', ag.observable.lifetime.unit), ['s', 'ns', 'us'], 'with its own unit selected');
    store(ed);
    t.equal(ws.status(MIZUNO), 'unchanged', 'opening and storing change nothing');
    ed.doc.data[0].comment = 'Target: natural Mg';    // an edit elsewhere
    store(ed);
    t.ok(ws.text(MIZUNO).includes('{"value": 8.7e-8, "unit": "s", "uncertainties"'));
    t.ok(ws.text(MIZUNO).includes('"nuclide": {"element": "Mn", "mass": 55}, '), 'a missing member stays missing');
    t.ok(errors(ws).some((i) => i.pointer === '/data/9/observable/lifetime/unit'), 'the checks report the unit');
    t.ok(errors(ws).some((i) => i.pointer === '/data/8/nuclide'), 'and the missing isomer');
    await ws.save('comment');                         // the fake server does not check
    t.ok(server.files.get(MIZUNO).includes('{"value": 8.7e-8, "unit": "s", "uncertainties"'), 'saved as written');
  });

  h.test('admin: form, JSON tab and form again keep what was typed', async (t) => {
    const { ws } = await connected();
    const ed = open(ws, MIZUNO);
    const mg = ed.doc.data[0];
    const block = database.quantity(mg);
    ops.setNumberField(block, 'value', '1.06550');
    block.unit = 'us';
    ops.setUncertainty(block, 'total', '');
    ops.setUncertainty(block, 'statistical', '0.00080');
    ops.setUncertainty(block, 'systematic', '0.0012');
    mg.comment = 'Target: natural Mg, 2.0 mm';
    t.deepEqual(store(ed).changes, [], 'values, units and comments do not change the identity');
    const text = ws.text(MIZUNO);
    t.ok(text.includes('"observable": {"kind": "lifetime", "lifetime": {"value": 1.06550, "unit": "us", "uncertainties": '
      + '[{"source": "statistical", "value": 0.00080}, {"source": "systematic", "value": 0.0012}]}}, "comment": "Target: natural Mg, 2.0 mm", "legacyIds": ["5fb28c42563b"]}'));
    applyJson(ed, shown(ed));                         // the JSON tab, applied as shown
    store(ed);
    t.equal(ws.text(MIZUNO), text);
    const again = database.quantity(ed.doc.data[0]);  // what the form shows
    t.equal(ops.numberText(again, 'value'), '1.06550');
    t.equal(jsonfmt.decimals(again, 'value'), 5);
    t.equal(again.unit, 'us');
    t.deepEqual(['total', 'statistical', 'systematic'].map((s) => ops.uncertaintyText(again, s)), ['', '0.00080', '0.0012']);
    t.equal(ed.doc.data[0].comment, 'Target: natural Mg, 2.0 mm');
    t.equal(ed.doc.data[0].datasetId, '09c1551803d0');
  });

  h.test('admin: drafts survive an edit during a save, a failed save and a reload', async (t) => {
    const { server, backend, ws, storage } = await connected();
    // an edit made while the save is under way stays, as a change of what was saved
    edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
    edit(ws, CURATED, '"value": 0.4858', '"value": 0.4859');
    const saving = ws.save('first');
    edit(ws, MIZUNO, '"value": 87.5', '"value": 87.6');
    await saving;
    t.ok(server.files.get(MIZUNO).includes('"value": 87.5') && server.files.get(CURATED).includes('"value": 0.4859'), 'what was sent is saved');
    t.deepEqual(ws.changes().map((c) => [c.path, c.status, c.outdated]), [[MIZUNO, 'modified', false]], 'the later edit stays');
    t.ok(ws.text(MIZUNO).includes('"value": 87.6'));
    t.equal(ws.baseline(MIZUNO), server.files.get(MIZUNO), 'compared with what was just saved');
    t.ok(storage.map.get(ws.storageKey).includes('87.6'), 'and kept in the browser');
    await ws.save('second');
    t.ok(server.files.get(MIZUNO).includes('"value": 87.6'));
    t.equal(ws.changes().length, 0);

    // the server cannot be reached: nothing is saved, nothing is lost
    edit(ws, MIZUNO, '"value": 87.6', '"value": 87.7');
    server.reachable = false;
    let failure = null;
    try { await ws.save('third'); } catch (err) { failure = err; }
    t.ok(failure instanceof ApiError && failure.code === 'server');
    t.deepEqual(ws.changes().map((c) => c.path), [MIZUNO], 'the draft is kept');
    t.ok(storage.map.get(ws.storageKey).includes('87.7'));

    // the page reloaded: a new workspace on the same storage has the draft
    server.reachable = true;
    const again = new Workspace(backend, storage);
    await again.load();
    t.equal(again.text(MIZUNO), ws.text(MIZUNO));
    t.deepEqual(again.changes().map((c) => [c.path, c.outdated]), [[MIZUNO, false]]);
    await again.save('third');
    t.ok(server.files.get(MIZUNO).includes('"value": 87.7'));
  });

  h.test('admin: drafts that cannot be kept in the browser are reported', async (t) => {
    // the storage is full: the draft lives in memory and the problem is reported until a write succeeds
    const storage = memoryStorage();
    const setItem = storage.setItem;
    let full = false;
    storage.setItem = (k, v) => { if (full) throw new Error('QuotaExceededError'); setItem(k, v); };
    const { ws } = await connected(storage);
    t.equal(ws.storageProblem(), null);
    let notified = 0;
    ws.onChange(() => { notified++; });
    full = true;
    edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
    t.equal(ws.storageProblem(), 'write');
    t.equal(ws.status(MIZUNO), 'modified', 'the draft is kept in memory');
    await null;
    t.equal(notified, 1, 'the page is told');
    full = false;
    edit(ws, MIZUNO, '"value": 87.5', '"value": 87.6');
    t.equal(ws.storageProblem(), null);
    t.ok(storage.map.get(ws.storageKey).includes('87.6'));

    // no storage at all
    t.equal((await connected(null)).ws.storageProblem(), 'unavailable');

    // drafts that cannot be read are reported and set aside, not overwritten
    const broken = memoryStorage();
    broken.setItem('mund-admin:drafts:copy-1:main', '[["data/LT/EXP/x.json", {"content": "trunc');
    const b = await connected(broken);
    t.equal(b.ws.storageProblem(), 'read');
    t.equal(b.ws.changes().length, 0);
    t.equal(broken.map.get('mund-admin:drafts:copy-1:main:unreadable'), '[["data/LT/EXP/x.json", {"content": "trunc');
  });

  h.test('admin: original data record the entryHash when chosen; a changed original must be checked again', async (t) => {
    const { ws } = await connected();
    const lookup = () => ops.entryLookup(ws.db);
    const MG = '09c1551803d0';
    t.equal(lookup().resolve(MG).entry.nuclide.element, 'Mg');
    t.equal(lookup().resolve('4f888682a401').current, '0c29e247f762', 'an earlier identifier names its entry');
    t.equal(lookup().resolve('000000000000'), null);

    // the text cell: a new id gets the entryHash of its entry now; an id typed again gets back what was recorded
    const recorded = { datasetId: MG, entryHash: '000000000000' };
    t.deepEqual(ops.parseOriginalData(`${MG}, dd91adba8444`, [recorded], lookup()), [recorded, { datasetId: 'dd91adba8444', entryHash: 'f0ba34e98a85' }]);
    t.equal(ops.parseOriginalData(` ${MG} `, [recorded], lookup())[0], recorded);
    t.deepEqual(ops.parseOriginalData('343adc0365', [recorded], lookup()), [{ datasetId: '343adc0365' }], 'no entry: no entryHash (reported)');
    t.deepEqual(ops.parseOriginalData('', [recorded], lookup()), []);
    t.deepEqual(ops.parseOriginalData('0c29e247f762', [{ datasetId: '4f888682a401', entryHash: 'aaaaaaaaaaaa' }], lookup()),
      [{ datasetId: '0c29e247f762', entryHash: 'aaaaaaaaaaaa' }], 'the current ID of the same entry keeps the recorded entryHash');

    // the picker: ticked entries keep their items, new ones get the entryHash now, entries not offered stay
    const other = { datasetId: 'ffffffffffff', entryHash: '111111111111' };
    const offered = [MG, 'dd91adba8444', '9f594e0f6502'];
    t.deepEqual(ops.pickOriginalData([recorded, other], offered, new Set([MG, '9f594e0f6502']), lookup()),
      [recorded, other, { datasetId: '9f594e0f6502', entryHash: '5cf2b08a8d7c' }]);
    t.deepEqual(ops.pickOriginalData([recorded, other], offered, new Set(), lookup()), [other]);
    t.deepEqual(ops.pickOriginalData([{ datasetId: '4f888682a401', entryHash: 'aaaaaaaaaaaa' }], ['0c29e247f762'], new Set(['0c29e247f762']), lookup()),
      [{ datasetId: '4f888682a401', entryHash: 'aaaaaaaaaaaa' }], 'an item naming the entry by an earlier ID covers it');

    // an original corrected: the curated entry must be checked again, and nothing records the new entryHash by itself
    edit(ws, MIZUNO, '"value": 1065.5', '"value": 1065.6');
    t.deepEqual(ws.issuesFor(CURATED).map((i) => [i.code, i.pointer]), [['W_ORIGINAL_CHANGED', '/data/0/originalData/0']]);
    const ed = open(ws, CURATED);
    ed.doc.data[0].comment = 'checked later';
    store(ed);
    t.deepEqual(codes(ws, CURATED), ['W_ORIGINAL_CHANGED']);
    // the curator checked it (「確認しました」): the original's entryHash as it is now is recorded
    const item = ed.doc.data[0].originalData[0];
    t.equal(ops.confirmOriginal(item, lookup()), true);
    store(ed);
    t.deepEqual(ws.issuesFor(CURATED), []);
    t.equal(item.entryHash, database.entryHash(lookup().resolve(MG).entry));
    t.equal(ops.confirmOriginal({ datasetId: '000000000000' }, lookup()), false);
  });

  h.test('admin: line differences', async (t) => {
    const { diffLines, diffStats } = modules.diff;
    const lines = diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
    t.equal(lines.map((l) => `${l.type}${l.text}`).join(' '), ' a -b +B  c  d +e');
    t.deepEqual(diffStats(lines), { added: 2, removed: 1 });
    t.deepEqual(diffStats(diffLines(null, 'x\ny\n')), { added: 2, removed: 0 });
    t.deepEqual(diffStats(diffLines('x\ny\n', null)), { added: 0, removed: 2 });
    t.deepEqual(diffStats(diffLines('same\n', 'same\n')), { added: 0, removed: 0 });
    t.equal(diffLines('a\nb\n', 'b\n').map((l) => l.type).join(''), '- ');
  });

  h.test('admin: rows pasted from a spreadsheet', async (t) => {
    const { files } = JSON.parse(await env.text('vectors', 'repository.json'));
    const { elements } = JSON.parse(files['data/master/nuclides.json']);
    const parse = (text) => modules.paste.parsePastedRows(text, elements);
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
}
