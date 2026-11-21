// Tests of the extraction work area of the data entry tool (admin/js/extraction.js):
// matching and comparing the two inputs, the adjudication, the content hash an
// approval is bound to (shared with tools/mundlib/extraction.py through
// tests/vectors/extraction.json), the blind display and the publication preview.
// Same `modules` and `env` as tests/js/suite.js.

export function register(h, modules, env) {
  const { jsonfmt, database } = modules;
  const ex = modules.extraction;

  async function vector() {
    const v = JSON.parse(await env.text('vectors', 'extraction.json'));
    const schemas = {};
    for (const name of Object.values(ex.SCHEMA_FILES)) schemas[name] = JSON.parse(await env.text('schema', name));
    const state = () => ex.readTask((path) => {
      const f = ex.workFile(path);
      return f ? v.files[f.name] ?? null : null;
    }, v.task);
    return { v, schemas, state };
  }

  /** The example task with its adjudication removed (both inputs submitted, nothing decided). */
  async function undecided() {
    const { v, schemas, state } = await vector();
    const s = state();
    s.adjudication = null;
    return { v, schemas, s };
  }

  const item = (comparison, a, b) => comparison.items.find((i) => i.ref.a === a && i.ref.b === b);

  h.test('extraction: the files and the content hash agree with the server', async (t) => {
    const { v, schemas, state } = await vector();
    const s = state();
    for (const name of ex.FILES) {
      const obj = s[{ 'task.json': 'task', 'input-A.json': 'A', 'input-B.json': 'B', 'adjudication.json': 'adjudication' }[name]];
      t.deepEqual(ex.schemaProblems(obj, schemas), [], `${name} follows its schema`);
      t.equal(ex.workText(obj, schemas), v.files[name], `${name} is written in the same canonical form`);
    }
    t.equal(ex.contentHash(s.task, s.A, s.B, s.adjudication), v.contentHash, 'the same hash as tools/mundlib/extraction.py');
    t.equal(ex.approvalState(s.task, s.A, s.B, s.adjudication), 'approved');
    t.deepEqual(ex.adjudicationProblems(s.task, s.A, s.B, s.adjudication), { integrity: [], open: [] });
    t.equal(ex.stage(s), 'approved');
    t.deepEqual(ex.taskIds(['extraction/Example2026/task.json', 'extraction/Example2026/input-A.json', 'data/LT/x.json',
      'extraction/Other/adjudication.json', 'extraction/x/source.pdf']), ['Example2026', 'Other']);
  });

  h.test('extraction: numbers are compared exactly, in their notation and after unit conversion', async (t) => {
    const q = (a, ua, b, ub) => ex.compareQuantity(a, ua, b, ub).status;
    t.equal(q('0.880', 'us', '880', 'ns'), 'unit', 'unit-only difference');
    t.equal(q('880', 'ns', '880', 'ns'), 'same');
    t.equal(q('880', 'ns', '880.0', 'ns'), 'digits', 'the same value with another number of digits');
    t.equal(q('0.8800', 'us', '880', 'ns'), 'digits');
    t.equal(q('8.80e2', 'ns', '880', 'ns'), 'notation');
    t.equal(q('880', 'ns', '881', 'ns'), 'value');
    t.equal(q('879.9999999', 'ns', '880', 'ns'), 'value', 'no tolerance');
    t.equal(q('4.6e5', 's-1', '0.46', 'us-1'), 'unit');
    t.equal(q('460', 'ms-1', '0.460', 'us-1'), 'unit');
    t.equal(q('460', 'ms-1', '0.46', 'us-1'), 'digits', '460 ms-1 is 0.460 us-1, one digit more than 0.46');
    t.equal(q('880', 'ns', null, 'ns'), 'missing');
    t.equal(ex.converted('0.7566', 'us').text, '756.6');
    t.equal(ex.converted('0.0010', 'us').text, '1.0');
    t.equal(ex.converted('460e3', 's-1').text, '0.460');
    t.equal(ex.converted('12', 'ms-1').text, '0.012');
    t.equal(ex.converted('-0.0', 'ns').key, '0e0');
    t.equal(ex.converted('abc', 'ns'), null);
  });

  h.test('extraction: value mismatch, unit-only difference and rows missing on one side', async (t) => {
    const { s } = await undecided();
    const c = ex.compare(s.task, s.A, s.B);
    t.deepEqual(c.items.map((i) => ex.refKey(i.ref)), ['r1|r1', 'r2|r2', 'r3|r3', 'r4|', '|r4'], 'paired by nuclide, quantity and conditions');
    t.equal(item(c, 'r1', 'r1').agreed, true);
    const ca = item(c, 'r3', 'r3');
    t.equal(ca.agreed, false);
    t.deepEqual(ca.diffs.map((d) => [d.field, d.status || (d.parts || []).join('/')]), [['original', 'value'], ['value', 'value']], 'value mismatch');
    const si = item(c, 'r2', 'r2');
    t.deepEqual(si.diffs.map((d) => [d.field, d.status || (d.parts || []).join('/')]),
      [['original', 'value/unit/uncertainty'], ['value', 'unit'], ['uncertainty', 'unit']], 'the notation differs, the converted values agree: unit only');
    t.equal(si.diffs[1].a.text, '756.6');
    t.deepEqual(item(c, 'r4', null).diffs, [{ field: 'onlyA' }], 'a row only A found');
    const ti = item(c, null, 'r4');
    t.deepEqual(ti.diffs, [{ field: 'onlyB' }]);
    t.deepEqual(c.coverage.map((x) => [x.item, x.a, x.b, x.agreed, x.rowsA, x.rowsB]),
      [['Table 1', 'covered', 'covered', true, 4, 3], ['Table 2', 'no-data', 'covered', false, 0, 1]], 'coverage compared item by item');
    t.deepEqual(c.independence, { independent: true, reason: 'ai+human', pair: 'ai+human' });

    // every difference and every lone row is open until it is decided
    const adj = ex.withAgreed(ex.newAdjudication(s.task.id), c);
    t.deepEqual(adj.rows.map((r) => [r.a, r.b, r.adopted]), [['r1', 'r1', 'agreed']], 'only identical rows are taken over by themselves');
    const p = ex.adjudicationProblems(s.task, s.A, s.B, adj);
    t.deepEqual(p.integrity, []);
    t.deepEqual(p.open.map((o) => o.code), ['OPEN_ROW', 'OPEN_ROW', 'OPEN_ROW', 'OPEN_ROW', 'OPEN_ROW', 'OPEN_ROW', 'OPEN_ITEM']);
  });

  h.test('extraction: agreement is not approval; a change after the approval needs a new one', async (t) => {
    const { v, schemas, s } = await undecided();
    const c = ex.compare(s.task, s.A, s.B);
    const who = (reason) => ({ reason, by: 'Carol', at: '2026-11-17T03:00:00Z' });
    let adj = ex.withAgreed(ex.newAdjudication(s.task.id), c);
    s.adjudication = adj;
    t.equal(ex.approvalState(s.task, s.A, s.B, adj), 'none');
    t.equal(ex.stage(s), 'compare', 'not approved: not publishable');
    t.ok(ex.approvalBlockers(s).includes('open'));

    ex.decide(adj, item(c, 'r2', 'r2'), 'A', who('the table gives microseconds'));
    ex.decide(adj, item(c, 'r3', 'r3'), 'B', who('first reading'));
    const corrected = jsonfmt.clone(item(c, 'r3', 'r3').a);
    ex.decide(adj, item(c, 'r3', 'r3'), 'other', who('checked in the PDF: 333'), { row: corrected, comment: 'value as in Table 1' });
    ex.decide(adj, item(c, 'r4', null), 'A', who('B missed the last row of Table 1'));
    ex.decide(adj, item(c, null, 'r4'), 'none', who('Table 2 holds X-ray energies only; the value is not a lifetime'));
    ex.decideCoverage(adj, 'Table 2', 'no-data', who('X-ray energies only'));
    t.deepEqual(adj.rows.map((r) => [r.id, r.adopted]), [['f1', 'agreed'], ['f2', 'A'], ['f3', 'other'], ['f4', 'A']], 'a decision replaced in its place');
    t.deepEqual(ex.adjudicationProblems(s.task, s.A, s.B, adj), { integrity: [], open: [] });
    t.deepEqual(ex.approvalBlockers(s), []);
    t.equal(ex.numberText(adj.rows[1], 'value'), '0.7566', 'adopted with the digits as written');

    // only identical rows are agreed: a pair that differs is never taken over by itself
    const forged = jsonfmt.clone(adj);
    forged.rows[2].adopted = 'agreed';
    t.deepEqual(ex.adjudicationProblems(s.task, s.A, s.B, forged).integrity.map((i) => i.code), ['E_ADJ_AGREED']);
    const changed = jsonfmt.clone(adj);
    jsonfmt.setNumber(changed.rows[1], 'value', '0.7567');
    t.deepEqual(ex.adjudicationProblems(s.task, s.A, s.B, changed).integrity.map((i) => i.code), ['E_ADJ_ADOPTED'], 'adopting A means A as written');

    ex.approve(s, 'Carol', '2026-11-17T04:00:00Z');
    t.equal(ex.approvalState(s.task, s.A, s.B, adj), 'approved');
    t.equal(ex.stage(s), 'approved');
    // through the canonical text (as saved) the approval still holds
    adj = jsonfmt.parse(ex.workText(adj, schemas));
    s.adjudication = adj;
    t.equal(ex.approvalState(s.task, s.A, s.B, adj), 'approved');
    t.equal(ex.workText(adj, schemas), v.files['adjudication.json'], 'the same decisions give the file of the vector');
    t.equal(ex.contentHash(s.task, s.A, s.B, adj), v.contentHash);

    // any change after the approval: re-check needed
    const reasons = jsonfmt.clone(adj);
    reasons.rows[1].reason = 'another reason';
    t.equal(ex.approvalState(s.task, s.A, s.B, reasons), 'stale');
    const value = jsonfmt.clone(adj);
    jsonfmt.setNumber(value.rows[2], 'value', '333.0');
    t.equal(ex.approvalState(s.task, s.A, s.B, value), 'stale');
    s.adjudication = value;
    t.equal(ex.stage(s), 'stale');
    const pdf = jsonfmt.clone(s.task);
    pdf.source.sha256 = '0'.repeat(64);
    t.equal(ex.approvalState(pdf, s.A, s.B, adj), 'stale', 'another PDF');
    const input = jsonfmt.clone(s.A);
    input.comment = 'x';
    t.equal(ex.approvalState(s.task, input, s.B, adj), 'stale', 'another input');
  });

  h.test('extraction: rows are matched by nuclide, quantity, conditions and location, never by their order', async (t) => {
    const row = (id, element, mass, value, { item = 'Table 1', label = element, conditions, kind = 'lifetime' } = {}) => {
      const r = { id, location: { item, label }, nuclide: { element, mass }, kind, original: {}, unit: 'ns', uncertainties: [] };
      jsonfmt.setNumber(r, 'value', value);
      if (conditions) r.conditions = conditions;
      return r;
    };
    const A = [row('a1', 'Si', 28, '700', { conditions: 'plate' }), row('a2', 'Si', 28, '710', { conditions: 'powder' }),
      row('a3', 'Al', 27, '864', { item: 'Table 1' }), row('a4', 'Al', 27, '865', { item: 'Table 3' }),
      row('a5', 'Pb', 0, '75'), row('a6', 'Ca', 40, '333', { item: 'Table 1' })];
    const B = [row('b6', 'Ca', 40, '333', { item: 'Table 4' }), row('b5', 'Pb', 208, '75'),
      row('b4', 'Al', 27, '865', { item: 'Table 3' }), row('b3', 'Al', 27, '864', { item: 'Table 1' }),
      row('b2', 'Si', 28, '710', { conditions: 'powder' }), row('b1', 'Si', 28, '700', { conditions: 'plate' })];
    const c = ex.compare({ source: { items: [] } }, { rows: A, coverage: [] }, { rows: B, coverage: [] });
    t.deepEqual(c.items.map((i) => ex.refKey(i.ref)), ['a1|b1', 'a2|b2', 'a3|b3', 'a4|b4', 'a5|', 'a6|b6', '|b5']);
    t.deepEqual(c.items.slice(0, 4).map((i) => i.agreed), [true, true, true, true], 'conditions and location decide, not the order');
    const ca = c.items.find((i) => i.ref.a === 'a6');
    t.equal(ca.located, false);
    t.deepEqual(ca.diffs.map((d) => [d.field, d.parts.join('/')]), [['location', 'item']], 'the only pair of a key; the location differs and is shown');
    t.deepEqual(c.items.find((i) => i.ref.a === 'a5').hints.map((x) => [x.row.id, x.why]), [['b5', ['natural']]], 'natural vs isotope is not matched, but pointed out');
    // two rows of one key at the same place are ambiguous: none of them is paired
    const twice = ex.matchRows([row('x1', 'Fe', 0, '206'), row('x2', 'Fe', 0, '207')], [row('y1', 'Fe', 0, '206'), row('y2', 'Fe', 0, '207')]);
    t.deepEqual(twice.map((m) => [m.a && m.a.id, m.b && m.b.id]), [['x1', null], ['x2', null], [null, 'y1'], [null, 'y2']]);
    // a row without nuclide (要確認) stays alone
    const unread = { id: 'u1', location: { item: 'Table 1' }, kind: 'lifetime', original: {}, uncertainties: [], needsCheck: 'blurred' };
    t.deepEqual(ex.matchRows([unread], [row('y1', 'Fe', 0, '206')]).map((m) => [m.a && m.a.id, m.b && m.b.id]), [['u1', null], [null, 'y1']]);
  });

  h.test('extraction: each input is blind until both are submitted', async (t) => {
    const { s } = await undecided();
    const draft = jsonfmt.clone(s.A);
    delete draft.submitted;
    const state = { task: s.task, A: draft, B: s.B, adjudication: null };
    t.equal(ex.canShowInput(state, 'A', { editing: true }), true, 'the own input while it is typed');
    t.equal(ex.canShowInput(state, 'A'), false, 'not outside its editing view');
    t.equal(ex.canShowInput(state, 'B', { editing: true }), false, 'the other, submitted input is not shown');
    t.equal(ex.canShowInput(state, 'B'), false);
    t.equal(ex.canCompare(state), false);
    t.equal(ex.stage(state), 'inputs');
    const one = { task: s.task, A: s.A, B: null, adjudication: null };
    t.equal(ex.canShowInput(one, 'A'), false, 'a submitted input is hidden until the other is submitted too');
    t.equal(ex.canShowInput(one, 'A', { editing: true }), false);
    const both = { task: s.task, A: s.A, B: s.B, adjudication: null };
    t.equal(ex.canShowInput(both, 'A') && ex.canShowInput(both, 'B'), true, 'both submitted: both shown');
    t.equal(ex.canCompare(both), true);

    // submission needs every source item marked
    const fresh = ex.newInput(s.task, 'A', 'human', 'Alice');
    t.deepEqual(ex.submissionProblems(s.task, fresh), ['coverage']);
    ex.setCoverage(fresh, 'Table 1', 'covered');
    ex.setCoverage(fresh, 'Table 2', 'no-data');
    t.deepEqual(ex.submissionProblems(s.task, fresh), []);
    ex.setCoverage(fresh, 'Table 2', '');
    t.deepEqual(fresh.coverage, [{ item: 'Table 1', status: 'covered' }]);
    const r = ex.newRow(s.A.rows, { item: 'Table 1' });
    t.equal(r.id, 'r5');
  });

  h.test('extraction: which pairs of inputs are independent', async (t) => {
    const ind = (ma, ea, mb, eb) => ex.independence({ mode: ma, extractor: ea }, { mode: mb, extractor: eb });
    t.equal(ind('human', 'Alice', 'human', 'Bob').independent, true);
    t.equal(ind('human', 'Alice', 'ai', undefined).independent, true);
    t.equal(ind('assisted', 'Bob', 'human', 'Alice').independent, true);
    t.deepEqual(ind('human', 'Alice', 'human', 'Alice'), { independent: false, reason: 'same-person', pair: 'human+human' });
    t.deepEqual(ind('assisted', 'Bob', 'ai', undefined), { independent: false, reason: 'both-ai', pair: 'ai+assisted' });
    t.equal(ind('ai', undefined, 'ai', undefined).independent, false);
    t.equal(ind('assisted', 'Alice', 'human', 'Alice').independent, false);
  });

  h.test('extraction: what a publication writes', async (t) => {
    const { state } = await vector();
    const s = state();
    const { files } = JSON.parse(await env.text('vectors', 'repository.json'));
    const schemas = {};
    for (const name of new Set(Object.values(database.SCHEMA_FILES))) schemas[name] = JSON.parse(await env.text('schema', name));
    const db = new database.Database(schemas);
    for (const [path, text] of Object.entries(files)) db.setFile(path, text);
    const p = ex.publicationPreview(s, db);
    t.equal(p.exists, false);
    t.ok(/^data\/LT\/EXP\/ExtractionExample_[0-9a-f]{12}\.json$/.test(p.path), p.path);
    t.equal(p.entries.length, 4);
    t.ok(p.entries.every((e) => /^[0-9a-f]{12}$/.test(e.datasetId) && e.status === 'new'));
    t.equal(jsonfmt.compact(p.entries[1].entry), '{"datasetId":"' + p.entries[1].datasetId
      + '","nuclide":{"element":"Si","isomer":0,"mass":0},"observable":{"kind":"lifetime","lifetime":{"uncertainties":[{"source":"total","value":0.0010}],"unit":"us","value":0.7566}}}',
    'the adopted value with its digits and unit as written');
    t.equal(p.entries[2].entry.comment, 'value as in Table 1');

    // the data file exists: its entries come from this task (replaced) or from elsewhere (refused by the server)
    const mid = p.path.match(/_([0-9a-f]{12})\.json$/)[1];
    const file = { format: 'muND/LT/1', sublibrary: 'LT', datasetType: 'experiment', meta: { id: mid, bibId: s.task.source.bibId, facility: 'J-PARC (D1)' },
      data: p.entries.slice(0, 2).map((e) => ({ datasetId: e.datasetId, ...e.entry })) };
    db.setFile(p.path, db.canonicalText(file));
    s.task.publications = [{ at: '2026-11-17T05:00:00Z', by: 'Carol', contentHash: s.adjudication.approval.contentHash, path: p.path,
      entries: [{ datasetId: p.entries[0].datasetId, entryHash: database.entryHash(file.data[0]) }] }];
    const again = ex.publicationPreview(s, db);
    t.equal(again.exists, true);
    t.deepEqual(again.entries.map((e) => e.status), ['registered', 'clash', 'new', 'new']);
  });
}
