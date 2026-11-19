// The selection of the explorer and its downloads.
//
// selectRows() is the one filter of the explorer: its result is what the
// tables show, and the CSV and JSON downloads of the selection are made from
// the same rows.  Rows are those of model.js.
//
// The CSV of a selection is the published csv/LT.csv of the same version,
// restricted to the selected entries: the header and every record are copied
// as published, so the columns, the values as given in the source, the
// converted columns and the empty uncertainty of a value published without
// one are exactly those of the published file.

import { CODES, TYPE_OF } from '../core/vocabulary.js';
import { normalizeDoi } from '../core/ids.js';

/**
 * The rows chosen by the filters of the explorer, in the order of the tables:
 * by dataset code (CODES), then as published.
 * @param z   atomic number, 0 = all elements
 * @param a   mass number as shown (row.a), '' = all
 * @param ds  dataset codes (array or Set)
 */
export function selectRows(rows, { z = 0, a = '', ds = CODES } = {}) {
  const codes = new Set(ds);
  const chosen = rows.filter((r) => (!z || r.z === z) && (a === '' || String(r.a) === String(a)) && codes.has(r.code));
  return CODES.flatMap((code) => chosen.filter((r) => r.code === code));
}

/**
 * Records of a CSV text (RFC 4180: fields separated by commas, quoted with
 * double quotes when needed; a quoted field may hold line breaks).
 * @returns {{fields: string[], text: string}[]}  `text`: the record as written, without its line break
 */
export function parseCsv(text) {
  const records = [];
  let fields = [];
  let field = '';
  let quoted = false;
  let start = 0;
  let i = 0;
  const endRecord = (end) => {
    fields.push(field);
    let raw = text.slice(start, end);
    if (raw.endsWith('\r')) {
      raw = raw.slice(0, -1);
      fields[fields.length - 1] = fields[fields.length - 1].replace(/\r$/, '');
    }
    if (raw !== '') records.push({ fields, text: raw });
    fields = [];
    field = '';
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      fields.push(field);
      field = '';
    } else if (c === '\n') {
      endRecord(i);
      start = i + 1;
    } else {
      field += c;
    }
    i += 1;
  }
  if (quoted) throw new Error('the CSV file ends inside a quoted field');
  if (start < text.length) endRecord(text.length);
  return records;
}

/**
 * The published CSV restricted to `rows`, in their order.  The header and the
 * records are copied as published.  Every row must be in the CSV file.
 */
export function selectionCsv(csvText, rows) {
  const [header, ...records] = parseCsv(csvText);
  if (!header) throw new Error('the CSV file is empty');
  const column = header.fields.indexOf('datasetId');
  if (column < 0) throw new Error('the CSV file has no column datasetId');
  const byId = new Map();
  for (const record of records) {
    if (record.fields.length !== header.fields.length) {
      throw new Error(`a record of the CSV file has ${record.fields.length} fields instead of ${header.fields.length}`);
    }
    byId.set(record.fields[column], record);
  }
  const lines = [header.text];
  for (const row of rows) {
    const record = byId.get(row.entry.datasetId);
    if (!record) throw new Error(`entry ${row.entry.datasetId} is not in the CSV file of this version`);
    lines.push(record.text);
  }
  return `${lines.join('\n')}\n`;
}

/** The filters as stated in a download: element, mass number and dataset types (null = all). */
export function describeFilters({ z = 0, a = '', ds = CODES } = {}, elements = []) {
  const codes = CODES.filter((d) => new Set(ds).has(d));
  return {
    element: z ? elements[z - 1] || null : null,
    z: z || null,
    massNumber: a === '' ? null : Number(a),
    datasetTypes: codes.map((d) => TYPE_OF[d]),
  };
}

/**
 * The selection as one JSON document: the data version, its manifest (without
 * the list of files), how to cite it, the entries as published and the
 * metadata records and bibliography entries they refer to.
 * @param version   a version of model.js ({label, root, manifest, meta, bibliography})
 * @param rows      the selected rows
 * @param filters   result of describeFilters()
 * @param citation  { paper, database }: how to cite (citation.citationTexts)
 * @param permalink address of the selection, with the version
 * @param dataLicence  the licence of the data as stated on the site
 */
export function selectionJson({ version, rows, filters, citation, permalink, dataLicence }) {
  const { manifest } = version;
  const metaIds = new Set(rows.map((r) => r.entry.metaId));
  const meta = version.meta.filter((m) => metaIds.has(m.id));
  const dois = new Set(rows.map((r) => normalizeDoi(r.entry.bibId)));
  for (const m of meta) for (const doi of m.relatedBibIds || []) dois.add(normalizeDoi(doi));
  const { files, ...about } = manifest;
  const source = (files || []).find((f) => f.path === 'LT.json');
  return {
    format: 'muND/selection/LT/1',
    version: manifest.version,
    commit: manifest.commit ?? null,
    citation: citation ?? null,
    permalink: permalink ?? null,
    dataLicence: dataLicence ?? null,
    selection: { ...filters, entries: rows.length },
    manifest: about,
    source: source ? { path: `${version.root}LT.json`, bytes: source.bytes, sha256: source.sha256 } : null,
    bibliography: version.bibliography.filter((b) => dois.has(normalizeDoi(b.DOI))),
    meta,
    data: rows.map((r) => r.entry),
  };
}

/** Name of a downloaded file, without extension: mund_LT_<version>_<element|all>[_A<a>][_<codes>]. */
export function selectionName(manifest, filters) {
  const parts = ['mund', 'LT', manifest.version, filters.element || 'all'];
  if (filters.massNumber !== null) parts.push(filters.massNumber ? `A${filters.massNumber}` : 'nat');
  if (filters.datasetTypes.length !== CODES.length) {
    parts.push(CODES.filter((d) => filters.datasetTypes.includes(TYPE_OF[d])).join('-') || 'none');
  }
  return parts.join('_').replace(/[^A-Za-z0-9.+-]+/g, '_');
}
