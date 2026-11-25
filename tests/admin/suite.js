// Tests of the data entry tool (admin/js) that run without a page: the
// client of the local server against tests/admin/fake-local.js, the
// workspace and saving, the document operations of the editor, versions,
// line differences, the reading of pasted rows and the Japanese texts of the checks.
//
// The repository is the frozen test database tests/vectors/repository.json
// (tests/fixtures/data) with the schemas, VERSION, CHANGELOG.md and two files
// the server does not list.  Same `modules` and `env` as tests/js/suite.js.

import { support } from '../js/modules.js';
import { withDom } from './fake-dom.js';
import { issueList } from '../../admin/js/save.js';
import { dataGrid } from '../../admin/js/grid.js';
import { renderHelp, renderMaster, renderHistory } from '../../admin/js/views.js';
import { openEditor } from '../../admin/js/editor.js';
import { referencePart } from '../../admin/js/reference.js';
import { FakeLocal } from './fake-local.js';

const MIZUNO = 'data/LT/EXP/Mizuno2025_4d2ed5c83736.json';
const CURATED = 'data/LT/CUR/unpublished_15fd4fea826c.json';
const S30 = '956677588d77';           // the Si-30 row of MIZUNO (d34215fe02f0) changed to S-30
const BIBLIOGRAPHY = 'data/master/bibliography.json';
const CHANGELOG = '# Changelog\n\nChanges of the data.\n\n## 0.1.0 - 2026-11-16\n\n- First version.\n';

export function register(h, modules, env) {
  const { jsonfmt, schema, database } = modules;
  const ops = modules.document;
  const { LocalBackend, ConflictError, InvalidError, ApiError } = modules.backend;
  const { Workspace } = modules.workspace;

  async function repositoryFiles() {
    const files = { ...JSON.parse(await env.text('vectors', 'repository.json')).files };
    const schemas = await support.schemas(env, Object.values(schema.SCHEMA_FILES));
    for (const [name, text] of Object.entries(schemas)) files[`schema/v1/${name}`] = text;
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

  // A file opened as the editor opens it (Draft, admin/js/document.js); store(ed) stores it
  // under the name the bibliography's entry gives and returns the review of the entries.
  const open = (ws, path) => new ops.Draft(ws, path, jsonfmt.parse(ws.text(path)));
  function store(ed) {
    const blocked = ed.store();
    if (blocked) throw new Error(`not stored: ${JSON.stringify(blocked)}`);
    return ed.review;
  }
  const changesOf = (review) => review.changes.map((c) => [c.from, c.to, c.choice]);
  const none = (review) => [review.changes, review.ambiguous, review.added, review.deleted];
  const savedIds = (ws) => [...ops.datasetIdsOf(ws.upstreamText(MIZUNO))];
  const codes = (ws, path) => ws.issuesFor(path).map((i) => i.code);
  const dataLines = (text) => text.split('\n').filter((l) => l.startsWith('    {"datasetId"')).map((l) => l.replace(/,$/, ''));

  h.test('admin: the local server: session, files, history', async (t) => {
    const server = new FakeLocal({ files: await repositoryFiles() });
    const backend = new LocalBackend({ fetchImpl: server.fetch });
    const { sync } = await backend.connect();
    t.deepEqual(server.log, ['GET /api/session', 'POST /api/sync']);
    t.deepEqual(sync, { updated: false, pending: 0, error: null });
    const files = await backend.listFiles();
    t.ok(files.some((f) => f.path === 'data/master/facilities.json') && files.some((f) => f.path === 'VERSION'));
    t.ok(!files.some((f) => f.path.endsWith('README.md')), 'only the files of the database are listed');
    t.equal(files.find((f) => f.path === MIZUNO).text, server.files.get(MIZUNO));
    t.deepEqual(await backend.history(), []);

    const ws = new Workspace(backend, memoryStorage());
    server.log.length = 0;
    await ws.load();
    t.deepEqual(server.log, ['GET /api/files'], 'the files are read in one request');
    t.ok(!ws.paths().includes('data/LT/README.md'));
    t.deepEqual(ws.dataFilePaths(), [CURATED, 'data/LT/EVAL/Iwamoto2025_194f28ccc0dc.json', MIZUNO]);
    t.deepEqual(ws.db.sortedFiles().map((f) => f.path), ws.dataFilePaths());
    t.equal(ws.upstreamText('CHANGELOG.md'), CHANGELOG);
    t.deepEqual(Object.keys(ws.schemas).sort(), Object.values(schema.SCHEMA_FILES).sort());
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
    t.deepEqual(ed.choose(review.changes, 'same'), [CURATED], 'a correction of the same entry re-points the references');
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
      ['DOI:10.1103/PhysRevC.111.034614', 'DOI:10.1103/vl7z-rzp8', 'DOI:10.48550/arXiv.2501.05897', 'muND:unpublished']);
    ws.setReference({ id: 'muND:UNPUBLISHED', title: ['Curation of lifetimes'] });
    t.equal(jsonfmt.parse(ws.text(BIBLIOGRAPHY)).references.length, 4, 'an entry is replaced, not duplicated');
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
  });

  h.test('admin: the message of a save names the files', async (t) => {
    const { ws } = await connected();
    t.equal(ws.saveMessage(), '');
    edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
    t.equal(ws.saveMessage(), 'Update LT/EXP Mizuno2025');
    t.equal(ws.saveMessage('  Typo.  '), 'Update LT/EXP Mizuno2025\n\nTypo.');
    ws.discard(MIZUNO);
    t.equal(ws.saveMessage(), '');
    t.equal(ws.move(MIZUNO, 'data/LT/EXP/Nizuno2025_4d2ed5c83736.json', ws.text(MIZUNO)), true);
    t.equal(ws.saveMessage(), 'Update LT/EXP Nizuno2025', 'a renamed file is one update');
    ws.discard('data/LT/EXP/Nizuno2025_4d2ed5c83736.json');
    t.equal(ws.saveMessage(), '');
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

  h.test('admin: a document is stored only with the right shape, a valid source and a file name of its own', async (t) => {
    const { ws } = await connected();
    const SOURCE = 'DOI:10.1103/vl7z-rzp8';           // of the Mizuno file
    const staged = [];
    // the reference card (admin/js/reference.js): its entry names the file and is staged before the file
    const card = (family, year) => ({
      entryFor: () => ({ id: SOURCE, author: [{ family }], published: { 'date-parts': [[year]] } }),
      save: (bibId) => staged.push([bibId, ws.status(MIZUNO)]),
    });
    const edited = (change) => {
      const ed = open(ws, MIZUNO);
      change(ed.doc);
      return ed;
    };
    t.equal(edited((doc) => { doc.data = {}; }).store(), 'shape');
    t.equal(edited((doc) => { doc.meta.bibId = '10.1/x'; }).store(), 'incomplete', 'a DOI without DOI:');

    // a new file of the same source, kind of data and key has the MetaID of the Mizuno file, whatever its name
    const twin = new ops.Draft(ws, null, ops.newDocument('EXP'));
    twin.doc.meta.bibId = SOURCE;
    t.deepEqual(twin.store(), { taken: MIZUNO });
    t.deepEqual(twin.store(card('Other', 2024)), { taken: MIZUNO });
    // a file name that holds another file
    const other = 'data/LT/EXP/Other2024_4d2ed5c83736.json';
    ws.stage(other, '{}\n');
    t.deepEqual(open(ws, MIZUNO).store(card('Other', 2024)), { taken: other });
    ws.discard(other);
    t.deepEqual([staged, ws.changes()], [[], []], 'nothing was stored');
    t.equal(ws.move(null, MIZUNO, twin.text()), false, 'the workspace refuses a new file over it');
    t.equal(ws.move(CURATED, MIZUNO, twin.text()), false, 'and another file moved onto it');

    // stored: the entry is staged first, then the file is renamed after it
    const ed = open(ws, MIZUNO);
    t.equal(ed.store(card('Mizuno', 2026)), null);
    t.deepEqual(staged, [[SOURCE, 'unchanged']]);
    t.equal(ed.path, 'data/LT/EXP/Mizuno2026_4d2ed5c83736.json');
    t.deepEqual(ws.changes().map((c) => [c.path, c.status]), [[MIZUNO, 'deleted'], [ed.path, 'added']]);
  });

  h.test('admin: an entry added to the bibliography is removed again when no file names it', async (t) => {
    const { ws } = await connected();
    ws.setReference({ id: 'muND:Q', author: [{ family: 'Tester', given: 'A.' }] });
    t.equal(ws.dropReference('muND:Q'), true);
    t.equal(ws.status(BIBLIOGRAPHY), 'unchanged');
    t.equal(ws.dropReference('DOI:10.1103/vl7z-rzp8'), false, 'a saved entry stays');
    // an entry a file names stays until the file names another source
    const ed = new ops.Draft(ws, null, ops.newDocument('TH'));
    ed.doc.meta.bibId = 'muND:Quux2026';
    t.equal(ed.store(), null);
    ws.setReference({ id: 'muND:Quux2026', author: [{ family: 'Tester' }] });
    t.equal(ws.dropReference('muND:Quux2026'), false);
    ed.doc.meta.bibId = 'muND:Quux2027';
    store(ed);
    t.equal(ws.db.reference('muND:Quux2026'), null);
    ed.doc.meta.bibId = 'muND:Quux2026';
    store(ed);
    // after the file is discarded
    ws.setReference({ id: 'muND:Quux2026', author: [{ family: 'Tester' }] });
    ws.discard(ed.path);
    t.equal(ws.status(BIBLIOGRAPHY), 'unchanged');
    t.deepEqual(ws.changes(), []);

    store(ed);
    ws.setReference({ id: 'muND:Quux2026', title: ['Shared source'] });
    const other = open(ws, CURATED);
    other.doc.meta.relatedBibIds = ['muND:Quux2026'];
    store(other);
    ws.discard(ed.path);
    t.ok(ws.db.reference('muND:Quux2026'));
    ws.discard(other.path);
    t.deepEqual(ws.changes(), []);
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

  h.test('admin: a file whose same lines someone else changed is refused until overwritten', async (t) => {
    const { server, ws } = await connected();
    const mine = ws.upstreamText(MIZUNO).replace('"value": 87.0', '"value": 87.5');
    ws.stage(MIZUNO, mine);
    t.deepEqual(ws.changes().map((c) => c.outdated), [false]);
    const theirs = server.github.get(MIZUNO).replace('"value": 87.0', '"value": 87.4');   // the same line
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

  h.test('admin: a save combined with someone else\'s change of another entry', async (t) => {
    const { server, ws } = await connected();
    edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
    server.changeOnGitHub({ [MIZUNO]: server.github.get(MIZUNO).replace('"value": 230.3', '"value": 230.4') });
    await ws.save('mine');
    t.equal(ws.changes().length, 0, 'the draft is done');
    const saved = server.github.get(MIZUNO);
    t.ok(saved.includes('"value": 87.5') && saved.includes('"value": 230.4'), 'both changes are in the file');
    t.equal(ws.upstreamText(MIZUNO), saved);
  });

  h.test('admin: the fake server does what the server does: renamed history, the first version, merges in canonical form', async (t) => {
    const { server, backend, ws } = await connected();
    // the history of a renamed file includes the saves under its earlier name
    edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
    await ws.save('before');
    const moved = 'data/LT/EXP/Nizuno2025_4d2ed5c83736.json';
    t.equal(ws.move(MIZUNO, moved, ws.text(MIZUNO)), true);
    await ws.save('renamed');
    t.deepEqual((await backend.history(moved)).map((e) => e.message), ['renamed', 'before']);
    // the version the copy starts with can be published, also twice
    const first = await backend.tag('v0.1.0');
    t.equal(first.sent, true);
    t.deepEqual(await backend.tag('v0.1.0'), first);
    // a combined file that is not in canonical form is refused
    edit(ws, moved, '"value": 230.3', '"value":  230.3');
    server.changeOnGitHub({ [moved]: server.github.get(moved).replace('"value": 87.5', '"value": 87.6') });
    let conflict = null;
    try { await ws.save('extra space'); } catch (err) { conflict = err; }
    t.ok(conflict instanceof ConflictError);
  });

  h.test('admin: an outdated draft is saved combined with someone else\'s change of another entry', async (t) => {
    const { server, ws } = await connected();
    edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
    server.changeOnGitHub({ [MIZUNO]: server.github.get(MIZUNO).replace('"value": 230.3', '"value": 230.4') });
    await ws.backend.sync();
    await ws.load();
    t.deepEqual(ws.changes().map((c) => [c.path, c.outdated]), [[MIZUNO, true]], 'the draft is outdated');
    await ws.save('mine');
    const saved = server.github.get(MIZUNO);
    t.ok(saved.includes('"value": 87.5') && saved.includes('"value": 230.4'), 'both changes are kept');
    t.equal(ws.changes().length, 0);
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
    t.deepEqual(tag, { name: 'v0.2.0', sha: saved.sha, frozen: null, sent: true, pending: 0, error: null });
    t.equal(server.github.get('VERSION'), '0.2.0\n');
    t.equal(ws.upstreamText('CHANGELOG.md'), r.changelog);
    t.deepEqual(await backend.tags(), [{ name: 'v0.2.0', sha: saved.sha }]);
    edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
    await ws.save('later');
    t.deepEqual(await backend.tag('v0.2.0'), tag, 'repeated after a later save: the same release commit');
    let failure = null;
    try { await backend.tag('v0.2.1'); } catch (err) { failure = err; }
    t.ok(failure instanceof ApiError && failure.status === 404 && failure.code === 'not-found', 'a version never saved');
    server.online = false;
    const unsent = await backend.tag('v0.2.0');
    t.equal(unsent.sent, false);
    t.equal(backend.sendError.code, 'offline');
    // a major version that cannot be frozen is refused; the server's reason stays out of the page
    const reason = 'v1: LT.json differs from the manifest';
    const refusing = new LocalBackend({ fetchImpl: async () => server.respond(422, { code: 'invalid', message: reason }) });
    let refused = null;
    try { await refusing.tag('v1.0.0'); } catch (err) { refused = err; }
    t.ok(refused instanceof InvalidError);
    t.deepEqual([refused.issues, refused.message, modules.i18n.problemText(refused)], [[], reason, modules.i18n.problemText({ code: 'invalid' })]);
  });

  h.test('admin: document operations of the editor', async (t) => {
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

  h.test('admin: two rows swapped in the JSON tab keep their identifiers', async (t) => {
    // the Mg and Al rows of the curated file: both have legacyIds and original data
    const { ws } = await connected();
    const ed = open(ws, CURATED);
    const lines = ed.text().split('\n');
    const mg = lines.findIndex((l) => l.includes('"element": "Mg"'));
    [lines[mg], lines[mg + 1]] = [lines[mg + 1], lines[mg]];
    ed.adopt(jsonfmt.parse(lines.join('\n')));
    t.deepEqual(none(store(ed)), [[], [], [], []], 'a new order is no change of identity');
    t.deepEqual(ed.doc.data.slice(0, 2).map((e) => [e.datasetId, e.legacyIds, ops.originalIds(e)]),
      [['b15200d13c23', ['935cd42f14bd', '18d9d393dfc6'], ['dd91adba8444', '9f594e0f6502']], ['0c29e247f762', ['4f888682a401', 'f02832f1580f'], ['09c1551803d0']]]);
    t.deepEqual(dataLines(ws.text(CURATED)).sort(), dataLines(ws.upstreamText(CURATED)).sort(), 'every row is as it was');
    t.deepEqual(ws.issues().filter((i) => i.file.startsWith('data/LT/')), []);
  });

  h.test('admin: rows sorted in the form keep their identifiers', async (t) => {
    const { ws } = await connected();
    const ed = open(ws, MIZUNO);
    ed.doc.data.reverse();
    t.deepEqual(none(store(ed)), [[], [], [], []]);
    t.deepEqual(dataLines(ws.text(MIZUNO)).sort(), dataLines(ws.upstreamText(MIZUNO)).sort());
    t.equal(ws.status(CURATED), 'unchanged');
  });

  h.test('admin: a row inserted at the head in the form: the others keep their identifiers', async (t) => {
    const { ws } = await connected();
    const ed = open(ws, MIZUNO);
    const ca = ops.newEntry('Ca', 40, 'lifetime', 'ns');
    ops.setNumberField(ca.observable.lifetime, 'value', '333.0');
    ed.doc.data.unshift(ca);
    const review = store(ed);
    t.deepEqual([review.changes, review.added, review.deleted], [[], [ca], []]);
    t.deepEqual(ed.doc.data.slice(1).map((e) => e.datasetId), savedIds(ws));
    t.ok(ed.doc.data.every((e) => !e.legacyIds || e.legacyIds.length === 1), 'no former identifier is added');
    t.equal(ws.status(CURATED), 'unchanged');
    t.deepEqual(errors(ws), []);
  });

  h.test('admin: a row inserted at the head in the JSON tab: the others keep their identifiers', async (t) => {
    const { ws } = await connected();
    const ed = open(ws, MIZUNO);
    const json = ed.text().split('\n');
    json.splice(json.findIndex((l) => l.startsWith('    {"datasetId"')), 0,
      '    {"nuclide": {"element": "Ca", "mass": 40, "isomer": 0}, "observable": {"kind": "lifetime", "lifetime": {"value": 333.0, "unit": "ns", "uncertainties": []}}},');
    ed.adopt(jsonfmt.parse(json.join('\n')));
    const review = store(ed);
    t.deepEqual([review.changes, review.added.length, review.deleted], [[], 1, []]);
    t.deepEqual(ed.doc.data.slice(1).map((e) => e.datasetId), savedIds(ws));
    t.equal(ws.status(CURATED), 'unchanged');
  });

  // the deleted row (Si-29) is in the middle; the reference to it is reported, not moved to another row
  for (const [where, remove] of [
    ['the JSON tab', (e) => e.adopt(jsonfmt.parse(e.text().split('\n').filter((l) => !l.includes('"ca4139686296"')).join('\n')))],
    ['the form', (e) => e.doc.data.splice(4, 1)],
  ]) {
    h.test(`admin: a row deleted in ${where}: the others keep their identifiers`, async (t) => {
      const { ws } = await connected();
      const ed = open(ws, MIZUNO);
      remove(ed);
      const review = store(ed);
      t.deepEqual([review.changes, review.added, review.deleted], [[], [], ['ca4139686296']]);
      t.deepEqual(ed.doc.data.map((e) => e.datasetId), savedIds(ws).filter((id) => id !== 'ca4139686296'));
      t.equal(ws.status(CURATED), 'unchanged');
      t.deepEqual(errors(ws).map((i) => [i.code, i.file, i.pointer]), [['E_ORIGINAL_MISSING', CURATED, '/data/3/originalData/0']]);
    });
  }

  h.test('admin: a changed identity is a correction of the same entry or different data, as chosen', async (t) => {
    const { ws } = await connected();

    // 'different': no legacyIds, the reference stays and is reported
    const ed = open(ws, MIZUNO);
    const si30 = ed.doc.data.find((e) => e.datasetId === 'd34215fe02f0');
    si30.nuclide.element = 'S';
    let review = store(ed);
    t.deepEqual(changesOf(review), [['d34215fe02f0', S30, null]]);
    t.deepEqual(ed.choose(review.changes, 'different'), []);
    t.deepEqual(changesOf(store(ed)), [['d34215fe02f0', S30, 'different']]);
    t.ok(!('legacyIds' in si30));
    t.equal(ws.status(CURATED), 'unchanged');
    t.deepEqual(errors(ws).map((i) => [i.code, i.file]), [['E_ORIGINAL_MISSING', CURATED]]);

    // changed to 'same': the former ID is kept and the reference follows (in one save with this file)
    t.deepEqual(ed.choose(ed.review.changes, 'same'), [CURATED]);
    store(ed);
    t.deepEqual(si30.legacyIds, ['3fc99c56a5ad', 'd34215fe02f0']);
    t.deepEqual(ops.originalIds(jsonfmt.parse(ws.text(CURATED)).data[4]), [S30]);
    t.deepEqual(errors(ws), []);
    t.deepEqual(ws.changes().map((c) => c.path), [CURATED, MIZUNO]);

    // the draft read again (the page was reloaded): the choice is known from legacyIds
    t.deepEqual(changesOf(store(open(ws, MIZUNO))), [['d34215fe02f0', S30, 'same']]);

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
    const history = [{ date: '2020-06', pointer: '/comment', before: 'thin', after: 'thick', reason: 'Target description', checkedAgainstSource: true }];
    mg.corrections = history;
    mg.nuclide.element = 'Na';
    store(cur);
    cur.choose(cur.review.changes, 'different');
    store(cur);
    t.ok(!('legacyIds' in mg));
    t.equal(mg.corrections, undefined);
    cur.choose(cur.review.changes, 'same');
    store(cur);
    t.deepEqual(mg.legacyIds, ['4f888682a401', 'f02832f1580f', '0c29e247f762']);
    t.deepEqual(mg.corrections, history);
    cur.choose(cur.review.changes, 'different');
    cur.undo();
    t.deepEqual(mg.corrections, history);
    t.deepEqual(mg.legacyIds, ['4f888682a401', 'f02832f1580f']);
  });

  h.test('admin: a changed key of the file changes every row and renames the file; all corrections are saved together', async (t) => {
    const { ws } = await connected();
    const ed = open(ws, MIZUNO);
    ed.doc.meta.key = 'run2';
    const review = store(ed);
    t.equal(review.changes.length, 10);
    t.ok(ed.path !== MIZUNO, 'the file name follows the MetaID');
    t.equal(errors(ws).filter((i) => i.code === 'E_ORIGINAL_MISSING').length, 10, 'before the choice the references do not resolve');
    ed.choose(review.changes, 'same');
    store(ed);
    t.deepEqual(errors(ws), []);
    t.deepEqual(ws.issuesFor(CURATED), [], 'the contents did not change: nothing to check again');
    t.ok(ed.doc.data.every((e) => e.legacyIds && e.legacyIds.length === 2), 'the former identifier follows those saved');
    t.deepEqual(ws.changes().map((c) => c.path).sort(), [CURATED, MIZUNO, ed.path].sort());
  });

  h.test('admin: two rows made from one saved row in the JSON tab are ambiguous: nothing is re-pointed', async (t) => {
    const { ws } = await connected();
    const ed = open(ws, MIZUNO);
    const lines = ed.text().split('\n');
    const at = lines.findIndex((l) => l.includes('"d34215fe02f0"'));
    lines.splice(at, 1, lines[at].replace('"element": "Si"', '"element": "S"'), lines[at].replace('"element": "Si"', '"element": "P"'));
    ed.adopt(jsonfmt.parse(lines.join('\n')));
    const review = store(ed);
    t.deepEqual(review.changes, []);
    t.deepEqual(review.ambiguous.map((a) => [a.from, a.entries.length]), [['d34215fe02f0', 2]]);
    t.equal(ws.status(CURATED), 'unchanged');
    t.ok(ed.doc.data.every((e) => !e.legacyIds || e.legacyIds.length === 1), 'no former identifier is added');
    // one of them deleted again: the other one is the changed row, to be chosen for
    ed.adopt(jsonfmt.parse(ed.text().split('\n').filter((l) => !l.includes('"element": "P"')).join('\n')));
    t.deepEqual(changesOf(store(ed)), [['d34215fe02f0', S30, null]]);
  });

  h.test('admin: a row duplicated in the form and the original changed: the copy is the saved row', async (t) => {
    // the copy has no datasetId
    const { ws } = await connected();
    const ed = open(ws, MIZUNO);
    const original = ed.doc.data[5];
    const copy = jsonfmt.clone(original);
    delete copy.datasetId;
    ed.doc.data.splice(6, 0, copy);
    original.key = 'b';
    const review = store(ed);
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
    await ws.save('comment');
    const [sent] = server.received['/api/save'].changes;
    t.ok(sent.content.includes('{"value": 8.7e-8, "unit": "s", "uncertainties"'), 'sent as written');
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
    ed.adopt(jsonfmt.parse(ed.text()));               // the JSON tab, applied as shown
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

  h.test('admin: reverting input while saving preserves the latest value', async (t) => {
    for (const reachable of [true, false]) {
      const { ws, server } = await connected();
      const before = ws.text(MIZUNO);
      edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
      server.reachable = reachable;
      const saving = ws.save('first');
      ws.stage(MIZUNO, before);
      if (reachable) {
        await saving;
        t.ok(server.files.get(MIZUNO).includes('"value": 87.5'));
        t.equal(ws.text(MIZUNO), before);
        t.deepEqual(ws.changes().map((c) => [c.path, c.status, c.outdated]), [[MIZUNO, 'modified', false]]);
        await ws.save('second');
      } else {
        const failure = await saving.catch((err) => err);
        t.ok(failure instanceof ApiError && failure.code === 'server');
      }
      t.equal(server.files.get(MIZUNO), before);
      t.deepEqual(ws.changes(), []);
    }
  });

  h.test('admin: drafts survive an edit during a save, a failed save, a reload and a new tab', async (t) => {
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

    // saved, but the files cannot be read again: the save is reported, the draft stays until they are read
    edit(again, MIZUNO, '"value": 87.7', '"value": 87.8');
    server.failing.add('/api/files');
    const result = await again.save('fourth');
    t.equal(result.sent, true);
    t.ok(result.reloadError instanceof ApiError && result.reloadError.code === 'server');
    t.ok(server.files.get(MIZUNO).includes('"value": 87.8'), 'saved');
    server.failing.clear();
    await again.load();
    t.equal(again.changes().length, 0, 'done once the files are read');

    // another tab took over: the old workspace, closed, writes no drafts any more
    ws.close();
    edit(ws, MIZUNO, '"value": 87.7', '"value": 87.9');
    t.equal(ws.status(MIZUNO), 'modified');
    t.equal(storage.map.size, 0, 'nothing written');
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
    t.equal(lookup().of({ datasetId: '4f888682a401' }).current, '0c29e247f762');
    t.equal(lookup().of('4f888682a401'), null, 'an item must be an object');

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

  h.test('admin: the Japanese texts of the checks take their identifiers from the database', async (t) => {
    const { issueText, getLang, setLang } = modules.i18n;
    const { master, cases } = JSON.parse(await env.text('vectors', 'cases.json'));
    // the sentence for the issue a shared validation case expects, whatever its English message says
    async function text(name) {
      const c = cases.find((x) => x.name === name);
      const db = await support.testDatabase(modules, env, master);
      for (const f of c.files) db.setFile(f.path, f.text);
      const found = db.validate().find((i) => i.code === c.expect[0].code && i.pointer === c.expect[0].pointer);
      return issueText({ ...found, message: 'reworded' }, db);
    }
    const before = getLang();
    setLang('ja');
    try {
      const starts = async (name, want) => t.equal((await text(name)).slice(0, want.length), want, `${name}:`);
      await starts('original data changed after the curated value was derived from it', '再確認が必要: 元データ 04432cb6b1d8 は、');
      await starts('reference through an earlier identifier', '元データを以前の ID 04432cb6b1d8 で挙げています。現在の ID c2d2a4cdc1ad に直して');
      await starts('original data listed twice', '同じ元データ 04432cb6b1d8 が2回');
      await starts('an earlier identifier that is the current identifier of another entry', 'legacyIds の 04432cb6b1d8 は、ほかの行の現在の ID と同じ');
      await starts('the same earlier identifier in two entries', 'legacyIds の old-1 は、ほかの行の legacyIds と同じ');
      await starts('two entries of one nuclide without keys', 'datasetId 6a31365c35f9 は行 2 でも使われています。');
      await starts('curated refers to data that does not exist', '元データ 0123456789ab は、このサブライブラリにありません。');
      await starts('curated refers to data that is not experimental', 'CUR の元データには EXP のデータを挙げてください。cfd3e8022e1b は EVAL のデータです。');
      await starts('bibliographic information missing', 'DOI:10.1103/PhysRevC.35.2212 の書誌情報が文献データベース (bibliography.json) にありません。「文献」欄の「書誌情報を取得」を押すか、書誌情報を入力してください。');
      // a member name is set off by a space, the Japanese name of a whole row is not
      const unknown = async (pointer) => issueText({ code: 'E_SCHEMA', file: MIZUNO, pointer, level: 'error', message: "unknown properties: 'note'" },
        await support.testDatabase(modules, env, master));
      t.equal((await unknown('/data/0')).slice(0, 10), 'この行に使えない項目');
      t.equal((await unknown('/data/0/nuclide')).slice(0, 15), 'nuclide に使えない項目');
      // every problem the shared cases produce (every code of the checks) has its own Japanese sentence
      const seen = new Set();
      for (const c of cases) {
        const db = await support.testDatabase(modules, env, master);
        for (const f of c.files) if (f.text === null) db.removeFile(f.path); else db.setFile(f.path, f.text);
        for (const issue of db.validate()) {
          seen.add(issue.code);
          const ja = issueText(issue, db);
          t.ok(/[぀-ヿ]/.test(ja) && !ja.includes(issue.message) && !ja.includes('(E_') && !ja.includes('(W_'),
            `${issue.code} ${issue.pointer} ${issue.message}: ${ja}`);
        }
      }
      t.equal(seen.size, 29, 'all codes are covered');
      setLang('en');
      t.equal(await text('original data listed twice'), 'reworded', 'English: the message of the check');
      // both languages say the same: an instruction is given in both or in neither
      t.equal(await text('reference through an earlier identifier'),
        'The original data are listed by the earlier ID 04432cb6b1d8. Change it to the current ID c2d2a4cdc1ad (“Use the current ID” in the “Original data” column).');
      t.equal((await text('original data changed after the curated value was derived from it')).slice(0, 50), 'Check again: the original data 04432cb6b1d8 change');
      t.equal(issueText({ code: 'E_FACILITY', file: MIZUNO, pointer: '/meta/facility', level: 'error', message: "'Nowhere (X1)' is not listed in data/master/facilities.json" },
        await support.testDatabase(modules, env, master)),
        "Facility 'Nowhere (X1)' is not in data/master/facilities.json. Choose one from the list, or add it under Master data.");
      t.equal(await text('bibliographic information missing'), 'No bibliographic data for DOI:10.1103/PhysRevC.35.2212 in the bibliography (bibliography.json). Press “Look up” in the Reference card, or type the bibliographic data.',
        'with the same instructions as the Japanese');
      setLang('ja');
      t.equal(await text('original data listed twice'), '同じ元データ 04432cb6b1d8 が2回挙げられています。');
      t.equal(await text('fewer nucleons than protons'), '質量数が原子番号より小さくなっています。');
    } finally {
      setLang(before);
    }
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

  function referenceForm(ws, source) {
    const controls = new Map();
    const doc = ops.newDocument('EXP');
    doc.meta.bibId = source;
    const part = referencePart({ workspace: ws, controls, markDirty() {}, onTypeChange() {} });
    part.load(source);
    const card = part.card(doc, { isNew: true });
    return { controls, part, card, doc };
  }

  // the source typed in full after an entry was staged under its first letters
  for (const order of ['change, then store', 'store, then change']) {
    h.test(`admin: the bibliography entry follows the source typed to its end (${order})`, async (t) => withDom(async () => {
      const { ws } = await connected();
      const { part, controls, card, doc } = referenceForm(ws, '');
      const draft = new ops.Draft(ws, null, doc);
      const input = controls.get('/meta/bibId');
      const type = async (el, value) => { el.value = value; await el.fire('input'); };
      await type(input, 'muND:Q');
      await type(card.find((el) => el.tag === 'textarea'), 'Tester, A.');
      await type(card.find((el) => el.placeholder === '1987'), '2026');
      t.equal(draft.store(part), null);
      t.equal(ws.db.reference('muND:Q').author[0].family, 'Tester');
      await type(input, 'muND:Quux2026');
      if (order === 'change, then store') await input.fire('change');
      t.equal(draft.store(part), null);
      if (order === 'store, then change') {
        await input.fire('change');
        t.equal(draft.store(part), null);
      }
      t.equal(ws.db.reference('muND:Q'), null, 'the entry of the first letters is gone');
      t.deepEqual(ws.db.reference('muND:Quux2026').author, [{ family: 'Tester', given: 'A.' }]);
      t.ok(draft.path.startsWith('data/LT/EXP/Tester2026_'));
    }));
  }

  /** The editor of the file `path` (null: a new file of kind `code`) on a page of the fake DOM, where confirm() says yes. */
  async function onEditor(ws, { path = null, code = 'TH' }, fn) {
    const page = document.createElement('div');
    globalThis.location = { hash: '#/edit' };
    globalThis.window = {};
    globalThis.confirm = () => true;
    document.head = { appendChild(script) { queueMicrotask(() => script.onerror()); } };
    const doc = path ? jsonfmt.parse(ws.text(path)) : ops.newDocument(code);
    const editor = openEditor(page, { workspace: ws, toast() {}, navigate() {} }, { path, doc });
    const type = async (placeholder, value) => {
      const el = page.find((x) => x.placeholder === placeholder);
      el.value = value;
      await el.fire('input');
    };
    const click = (label) => page.find((x) => x.tag === 'button' && x.children[0]?.textContent === label).fire('click');
    try { await fn({ page, editor, type, click }); } finally {
      editor.destroy();
      for (const name of ['location', 'window', 'confirm']) delete globalThis[name];
    }
  }
  const SOURCE_INPUT = 'DOI:10.1103/PhysRevC.35.2212';
  const AUTHORS_INPUT = 'Suzuki, T.\nMeasday, D. F.';

  for (const button of ['Discard changes', 'Delete']) {
    h.test(`admin: ${button} on a reopened new file removes the bibliography entry it added`, async (t) => withDom(async () => {
      const { ws } = await connected();
      let path;
      await onEditor(ws, {}, async ({ editor, type }) => {
        await type(SOURCE_INPUT, 'muND:Quux2026');
        await type(AUTHORS_INPUT, 'Tester');
        t.ok(editor.flush());
        path = ws.dataFilePaths().find((p) => p.includes('/TH/'));
      });
      t.equal(ws.status(BIBLIOGRAPHY), 'modified');
      await onEditor(ws, { path }, ({ click }) => click(button));
      t.deepEqual(ws.changes(), []);
    }));
  }

  h.test('admin: only a saved file shows its History', async (t) => withDom(async () => {
    const { ws } = await connected();
    const historyLink = (page) => page.find((x) => x.tag === 'a' && x.children[0]?.textContent === 'History');
    let path;
    await onEditor(ws, {}, async ({ page, editor, type }) => {
      t.equal(historyLink(page).hidden, true, 'a new file');
      await type(SOURCE_INPUT, 'muND:Quux2026');
      await type(AUTHORS_INPUT, 'Tester');
      t.ok(editor.flush());
      path = ws.dataFilePaths().find((p) => p.includes('/TH/'));
    });
    await onEditor(ws, { path }, ({ page }) => t.equal(historyLink(page).hidden, true, 'a new file reopened, not saved yet'));
    await onEditor(ws, { path: MIZUNO }, ({ page }) => {
      t.equal(historyLink(page).hidden, false, 'a saved file');
      t.equal(historyLink(page).href, `#/history?path=${encodeURIComponent(MIZUNO)}`);
    });
  }));

  h.test('admin: the entry of a former source stays while the file lists it as related', async (t) => withDom(async () => {
    const { ws } = await connected();
    await onEditor(ws, {}, async ({ editor, type }) => {
      await type(SOURCE_INPUT, 'muND:Old2026');
      await type(AUTHORS_INPUT, 'Tester');
      t.ok(editor.flush());
      await type(SOURCE_INPUT, 'muND:New2026');
      await type('DOI:10.48550/arXiv.2501.05897', 'muND:Old2026');
      t.ok(editor.flush());
    });
    t.ok(ws.db.reference('muND:Old2026'));
    t.ok(ws.db.reference('muND:New2026'));
  }));

  h.test('admin: opening the registered file withdraws the new file and its entry', async (t) => withDom(async () => {
    const { ws } = await connected();
    await onEditor(ws, { code: 'EXP' }, async ({ page, editor, type }) => {
      await type(SOURCE_INPUT, 'muND:Q');
      await type(AUTHORS_INPUT, 'Tester');
      t.ok(editor.flush());
      await type(SOURCE_INPUT, 'DOI:10.1103/vl7z-rzp8');           // the source of the Mizuno file
      t.equal(editor.flush(), false);
      const open = page.find((x) => x.tag === 'a' && x.children[0]?.textContent === 'Open that file');
      await open.events.click[0]({ preventDefault() {} });
    });
    t.deepEqual(ws.changes(), []);
  }));

  h.test('admin: a file is named after the entry of its new source', async (t) => withDom(async () => {
    const { ws } = await connected();
    const { part, controls, card, doc } = referenceForm(ws, 'DOI:10.1234/a');
    const draft = new ops.Draft(ws, null, doc);
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { author: [{ family: 'Tester' }], published: { 'date-parts': [[1995]] } } }) });
    try {
      await card.find((el) => el.tag === 'button').fire('click');
    } finally { globalThis.fetch = original; }
    t.equal(draft.store(part), null);
    t.ok(draft.path.startsWith('data/LT/EXP/Tester1995_'));
    const input = controls.get('/meta/bibId');
    input.value = 'DOI:10.1234/b';
    await input.fire('input');
    t.equal(draft.store(part), null);
    t.ok(draft.path.startsWith('data/LT/EXP/b_'), 'a source without an entry: named after the source');
    t.equal(ws.db.reference('DOI:10.1234/a'), null);
    t.equal(ws.db.reference('DOI:10.1234/b'), null);
  }));

  h.test('admin: a delayed lookup belongs to its source', async (t) => withDom(async () => {
    const { ws } = await connected();
    const { part, controls, card } = referenceForm(ws, 'DOI:10.1234/a');
    const original = globalThis.fetch;
    let respond;
    globalThis.fetch = () => new Promise((resolve) => { respond = resolve; });
    try {
      const lookup = card.find((el) => el.tag === 'button').fire('click');
      const input = controls.get('/meta/bibId');
      input.value = 'DOI:10.1234/b';
      await input.fire('input');
      await input.fire('change');
      respond({ ok: true, json: async () => ({ message: { title: ['Paper A'] } }) });
      await lookup;
      part.save(input.value);
      t.equal(ws.db.reference(input.value), null);
    } finally { globalThis.fetch = original; }
  }));

  h.test('admin: bibliography inputs keep editing the staged entry', async (t) => withDom(async () => {
    const { ws } = await connected();
    const source = 'muND:example';
    const { part, card } = referenceForm(ws, source);
    const pages = card.find((el) => el.placeholder === '2212-2224');
    const url = card.find((el) => el.placeholder === 'https://…');
    pages.value = 'first';
    await pages.fire('input');
    part.save(source);
    pages.value = 'second';
    await pages.fire('input');
    url.value = 'https://example.invalid/paper';
    await url.fire('input');
    part.save(source);
    t.deepEqual(ws.db.reference(source), { id: source, page: 'second', URL: url.value });
  }));

  h.test('admin: correcting the publication year keeps the month and day', async (t) => withDom(async () => {
    const { ws } = await connected();
    const source = 'muND:example';
    ws.setReference({ id: source, published: { 'date-parts': [[1987, 6, 1]] } });
    const { part, card } = referenceForm(ws, source);
    const year = card.find((el) => el.placeholder === '1987');
    for (const value of ['198', '1988']) {
      year.value = value;
      await year.fire('input');
      part.save(source);
    }
    t.deepEqual(ws.db.reference(source).published['date-parts'], [[1988, 6, 1]]);
    year.value = '';
    await year.fire('input');
    part.save(source);
    t.equal(ws.db.reference(source).published, undefined);
  }));

  h.test('admin: a second tab waits while the editor holds incomplete input', async (t) => withDom(async () => {
    const server = new FakeLocal({ files: await repositoryFiles() });
    const root = document.createElement('div');
    const toasts = document.createElement('div');
    document.getElementById = (id) => id === 'app' ? root : toasts;
    document.body = root;
    let owner;
    let released = false;
    const messages = [];
    const savedFetch = globalThis.fetch;
    const savedChannel = globalThis.BroadcastChannel;
    globalThis.BroadcastChannel = class {
      constructor() { owner = this; }
      postMessage(message) { messages.push(message); }
      close() {}
    };
    globalThis.window = { addEventListener() {}, scrollTo() {} };
    globalThis.location = { hash: '#/edit?new=EXP' };
    globalThis.fetch = server.fetch;
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      async request(name, options, callback) { await callback({}); released = true; },
    } });
    try {
      await import('../../admin/js/main.js?handover');
      await new Promise((resolve) => setTimeout(resolve, 0));
      const input = root.find((el) => el.placeholder === 'setup-b');
      input.value = 'unfinished';
      await input.fire('input');
      owner.onmessage({ data: 'open' });
      await Promise.resolve();
      t.deepEqual(messages, ['busy']);
      t.equal(released, false);
      t.equal(root.find((el) => el === input).value, 'unfinished');
      const n = toasts.children.length;
      owner.onmessage({ data: 'open' });
      t.equal(toasts.children.length, n);
    } finally {
      globalThis.fetch = savedFetch;
      globalThis.BroadcastChannel = savedChannel;
      delete navigator.locks;
      delete globalThis.window;
      delete globalThis.location;
    }
  }));

  for (const tab of ['form', 'json']) {
    h.test(`admin: the ${tab} tab keeps a colleague's row after Save`, async (t) => withDom(async () => {
      const { ws, backend, server } = await connected();
      edit(ws, MIZUNO, '"value": 87.0', '"value": 87.5');
      server.changeOnGitHub({ [MIZUNO]: server.github.get(MIZUNO).replace('"value": 743.9', '"value": 744.0') });
      const send = backend.save.bind(backend);
      let finish;
      backend.save = async (args) => {
        await new Promise((resolve) => { finish = resolve; });
        return send(args);
      };
      const page = document.createElement('div');
      globalThis.location = { hash: '#/edit' };
      globalThis.window = {};
      document.head = { appendChild(script) { queueMicrotask(() => script.onerror()); } };
      const editor = openEditor(page, { workspace: ws, toast() {}, navigate() {} }, { path: MIZUNO, doc: jsonfmt.parse(ws.text(MIZUNO)) });
      try {
        if (tab === 'json') await page.find((el) => el.id === 'tab-json').fire('click');
        const saving = page.find((el) => el.tag === 'button' && el.children[0]?.textContent === 'Save').fire('click');
        if (tab === 'form') {
          const input = page.find((el) => el.class === 'c-comment');
          input.value = 'Checked target';
          await input.fire('input');
        }
        if (tab === 'json') t.equal(page.find((el) => el.class === 'json-fallback mono').readOnly, true);
        finish();
        await saving;
        if (tab === 'form') {
          t.ok(ws.text(MIZUNO).includes('Checked target'));
          t.ok(ws.changes()[0].outdated || ws.text(MIZUNO).includes('"value": 744.0'));
          backend.save = send;
          await ws.save('Checked target');
          t.ok(server.files.get(MIZUNO).includes('"value": 744.0'));
        } else {
          t.ok(page.find((el) => el.class === 'json-fallback mono').value.includes('"value": 744.0'));
        }
      } finally {
        editor.destroy();
        delete globalThis.location;
        delete globalThis.window;
      }
    }));
  }

  h.test('admin: editing one source preserves an unreadable bibliography', async (t) => {
    const { ws } = await connected();
    const entry = { id: 'DOI:10.1000/x', title: ['Example'] };
    for (const text of ['{', '{"references":{}}']) {
      ws.stage(BIBLIOGRAPHY, text);
      t.equal(ws.setReference(entry), false);
      t.equal(ws.dropReference(entry.id), false);
      t.equal(ws.text(BIBLIOGRAPHY), text);
    }
    ws.stageDelete(BIBLIOGRAPHY);
    t.equal(ws.setReference(entry), true);
    t.deepEqual(jsonfmt.parse(ws.text(BIBLIOGRAPHY)).references, [entry]);
  });

  h.test('admin: the facilities table respects edits in the raw pane', async (t) => withDom(async () => {
    const { ws } = await connected();
    const page = document.createElement('div');
    globalThis.window = {};
    document.head = { appendChild(script) { queueMicrotask(() => script.onerror()); } };
    const notices = [];
    const master = renderMaster(page, { workspace: ws, toast: (...args) => notices.push(args) });
    const raw = () => page.find((el) => el.class === 'json-fallback mono');
    const detail = () => page.find((el) => el.placeholder === 'J-PARC MLF MUSE D1');
    try {
      await page.find((el) => el.tag === 'button' && el.children[0]?.textContent === 'facilities.json').fire('click');
      const field = detail();
      field.value = 'Table edit';
      await field.fire('input');
      await field.fire('change');
      t.ok(raw().value.includes('Table edit'));
      raw().value = raw().value.replace('Table edit', 'Raw edit');
      field.value = 'Another edit';
      await field.fire('input');
      await field.fire('change');
      t.equal(notices.at(-1)?.[1], 'bad');
      t.equal(detail().value, 'Table edit');
      t.ok(master.flush());
      t.equal(detail().value, 'Raw edit');
    } finally { master.destroy(); delete globalThis.window; }
  }));

  h.test('admin: a facility edit is staged while typing and its problem names the row of the table', async (t) => withDom(async () => {
    const { ws } = await connected();
    const page = document.createElement('div');
    globalThis.window = {};
    const master = renderMaster(page, { workspace: ws, toast() {} });
    try {
      const abbr = page.find((el) => el['aria-label'] === 'Row 2: Short name (used in the data)');
      abbr.value = 'J-PARC (D1)';
      await abbr.fire('input');
      t.equal(ws.status('data/master/facilities.json'), 'modified', 'staged without leaving the field');
      t.deepEqual(codes(ws, 'data/master/facilities.json'), ['E_DUPLICATE_FACILITY']);
      t.ok(page.find((el) => el.tag === 'strong' && el.children[0]?.textContent === 'row 2 · abbr: '));
      // listed once, under the table; the save card says where
      const all = (el, match) => [...(match(el) ? [el] : []), ...(el.children || []).flatMap((c) => all(c, match))];
      t.equal(all(page, (el) => el.tag === 'strong' && el.children[0]?.textContent === 'row 2 · abbr: ').length, 1);
      t.ok(page.find((el) => el.textContent === 'Those in the facilities table (1) are listed under the “Facilities” table (press one to go to its field).'));
    } finally { master.destroy(); delete globalThis.window; }
  }));

  h.test('admin: the duplicate row button leaves correction history on the original', async (t) => withDom(async () => {
    const { ws } = await connected();
    const { doc } = open(ws, MIZUNO);
    const first = doc.data[0];
    first.corrections = [{ date: '2020-06', pointer: '/comment', before: 'thin', after: 'thick', reason: 'Target description', checkedAgainstSource: true }];
    const grid = dataGrid({ workspace: ws, markDirty() {} }).card(doc);
    await grid.find((el) => el.title === 'Duplicate this row').fire('click');
    t.equal(doc.data[1].corrections, undefined);
    t.equal(doc.data[1].datasetId, undefined);
    t.equal(doc.data[1].legacyIds, undefined);
    t.equal(first.corrections.length, 1);
  }));

  h.test('admin: curated and evaluated quantity choices preserve existing values', async (t) => {
    t.deepEqual(ops.kindChoices('CUR', 'capture_rate'), ['capture_rate']);
    t.deepEqual(ops.kindChoices('EVAL', null), ['capture_rate']);
    t.deepEqual(ops.kindChoices('CUR', 'lifetime'), ['capture_rate', 'lifetime']);
    t.deepEqual(ops.kindChoices('EXP', 'lifetime'), modules.convert.KINDS);
    t.deepEqual(ops.kindChoices('TH', null), modules.convert.KINDS);
  });

  h.test('admin: the uncertainty checkbox follows its columns', async (t) => withDom(async () => {
    const { ws } = await connected();
    const { doc } = open(ws, MIZUNO);
    const block = database.quantity(doc.data[0]);
    ops.setUncertainty(block, 'statistical', '1.0');
    const card = dataGrid({ workspace: ws, markDirty() {} }).card(doc);
    const box = card.find((el) => el.type === 'checkbox');
    const column = () => Boolean(card.find((el) => el.tag === 'th' && el.children[0]?.textContent === '± stat.'));
    box.checked = false;
    await box.fire('change');
    t.ok(column());
    t.equal(box.checked, true);
    ops.setUncertainty(block, 'statistical', '');
    box.checked = false;
    await box.fire('change');
    t.equal(column(), false);
    t.equal(box.checked, false);
  }));

  h.test('admin: a master file check links to Master data', async (t) => withDom(async () => {
    const { ws } = await connected();
    const file = 'data/master/facilities.json';
    const list = issueList([{ file, pointer: '/facilities', level: 'error', code: 'E_SCHEMA', message: 'Invalid facilities' }], ws.db);
    const link = list.find((el) => el.tag === 'a');
    t.equal(link?.href, '#/master');
    t.equal(link.children[0].textContent, 'facilities.json');
  }));

  h.test('admin: publication failures and History show no raw message of the server', async (t) => withDom(async () => {
    const { problemText, getLang, setLang } = modules.i18n;
    const text = (el) => (el.tag === '#text' ? el.textContent : el.children.map(text).join(''));
    document.documentElement = {};
    const before = getLang();
    try {
      for (const lang of ['ja', 'en']) {
        setLang(lang);
        for (const error of [new InvalidError([], 'releases/v1: tag v1.0.0 is on 0123456789ab, not on the release commit ba9876543210'),
          { code: 'tag-exists', message: 'the version v1.0.0 is published already' }, { code: 'mystery', message: 'git push failed' }]) {
          t.ok(!/commit|tag|push/i.test(problemText(error)), `${lang}: ${problemText(error)}`);
        }
      }
      setLang('ja');
      const page = document.createElement('div');
      const at = '2026-11-17T00:00:00+09:00';
      const history = async () => [
        { sha: 'a', author: 'A', date: at, message: 'Merge pull request #3 from someone/branch\n\nFix the tag' },
        { sha: 'b', author: 'B', date: at, message: 'Update LT/EXP Mizuno2025; Add LT/TH Tanaka2020\n\nTypo.' },
        { sha: 'c', author: 'C', date: at, message: 'Update 4 files\n\nWhy.\n\n- Update VERSION\n- Delete LT/CUR unpublished' },
      ];
      renderHistory(page, { backend: { history } }, new URLSearchParams());
      await new Promise((resolve) => setTimeout(resolve, 0));
      const shown = text(page);
      for (const part of ['ツールの外で行われた変更', 'LT/EXP Mizuno2025 を更新、LT/TH Tanaka2020 を追加', 'Typo.', '4 個のファイルを更新', '- VERSION を更新\n- LT/CUR unpublished を削除']) {
        t.ok(shown.includes(part), part);
      }
      t.ok(!/Merge|pull|branch|tag/.test(shown), shown);
    } finally { setLang(before); }
  }));

  h.test('admin: practice Help links to the public project guides', async (t) => withDom(async () => {
    const page = document.createElement('div');
    const savedFetch = globalThis.fetch;
    let configUrl;
    globalThis.fetch = async (url) => {
      configUrl = String(url);
      return { ok: true, text: async () => JSON.stringify({ repository: 'example/project', branch: 'published' }) };
    };
    try {
      renderHelp(page, { backend: { session: { practice: true, repository: null, branch: 'practice' } } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const file of ['admin-guide.ja.md', 'data-format.md', 'id-definition.md']) {
        t.ok(page.find((el) => el.href === `https://github.com/example/project/blob/published/docs/${file}`));
      }
      t.ok(configUrl.endsWith('/site/config.json'));
    } finally { globalThis.fetch = savedFetch; }
  }));

  h.test('admin: rows pasted from a spreadsheet', async (t) => {
    const { files } = JSON.parse(await env.text('vectors', 'repository.json'));
    const { elements } = JSON.parse(files['data/master/nuclides.json']);
    const parse = (text) => ops.parsePastedRows(text, elements);
    const r = parse('Element\tA\tValue\tUnc\n28Si\t756.0\t1.0\nSi\t28\t743.9\t5.0\tthick\tfirst run\nnatPd\t95.8\t0.6\nPd-108, 96.0, 0.7\n'
      + 'al 27 864.0 1.0\nAg\tnat\t87.0\nAg\t87.0\t1.0\nXx\t1\t2\t3\nSi\t756\t1.0\nSi\t28\t743.9\t±5.0\nSi\t28\t743.9\t5.O\n');
    t.deepEqual(r.rows, [
      { element: 'Si', mass: 28, value: '756.0', uncertainty: '1.0', key: '', comment: '' },
      { element: 'Si', mass: 28, value: '743.9', uncertainty: '5.0', key: 'thick', comment: 'first run' },
      { element: 'Pd', mass: 0, value: '95.8', uncertainty: '0.6', key: '', comment: '' },
      { element: 'Pd', mass: 108, value: '96.0', uncertainty: '0.7', key: '', comment: '' },
      { element: 'Al', mass: 27, value: '864.0', uncertainty: '1.0', key: '', comment: '' },
      { element: 'Ag', mass: 0, value: '87.0', uncertainty: '', key: '', comment: '' },
    ]);
    t.deepEqual(r.skipped, ['Element\tA\tValue\tUnc', 'Ag\t87.0\t1.0', 'Xx\t1\t2\t3', 'Si\t756\t1.0', 'Si\t28\t743.9\t±5.0', 'Si\t28\t743.9\t5.O']);
  });
}
