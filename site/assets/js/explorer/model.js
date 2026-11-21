// One version of the published data as the pages use it, built from its files
// (manifest.json, master.json, LT.json).  No fetching here: see store.js.

import { entryHash } from '../core/database.js';
import { Physics, combinedUncertainty } from '../core/convert.js';
import { nuclideTables, effectiveMass } from '../core/nuclides.js';
import { normalizeBibId } from '../core/ids.js';
import { CODE_OF, DEFINED_SUBLIBRARIES } from '../core/vocabulary.js';

// Formats of the built files these pages can read.  Stable versions keep
// the format they were built with, so a list may hold several.
export const MANIFEST_FORMATS = ['muND/manifest/1'];
export const LT_FORMATS = ['muND/dist/LT/1'];

export function expectFormat(obj, formats) {
  if (!obj || !formats.includes(obj.format)) {
    throw new Error(`the data are in a format this page does not know (${obj && obj.format})`);
  }
  return obj;
}

/**
 * What a version holds of a sub-library (XR | LT | ES | BR), from manifest.sublibraries:
 *   { available, entries, defined, title, text }   text: '655 entries' or 'no data yet';
 *   defined: the sub-library has a data format
 */
export function sublibraryStatus(manifest, sublibrary) {
  const info = (manifest.sublibraries || {})[sublibrary] || {};
  const entries = Object.values(info.counts || {}).reduce((n, c) => n + c, 0);
  const available = info.status === 'available' && entries > 0;
  const text = available ? `${entries} entr${entries === 1 ? 'y' : 'ies'}` : 'no data yet';
  return { available, entries, defined: DEFINED_SUBLIBRARIES.includes(sublibrary), title: info.title || sublibrary, text };
}

/**
 * A version is { label, root, manifest, tables, physics, rows, byId, usedBy,
 * meta, bibliography }; `meta` and `bibliography` are the lists of LT.json.
 * A row is one data entry as published (`entry`) together with what the pages
 * derive from it:
 *   meta, reference   its metadata record and bibliography entry
 *   code              EXP | TH | CUR | EVAL
 *   z, a              atomic number; mass number for display (see effectiveMass)
 *   block             the value block, entry.observable[entry.observable.kind]
 *   unc               one overall uncertainty, or null
 *   conv              lifetime, capture rate and capture probability, or null
 *   originals         [{id, row, changed}] for each originalData item: the row it
 *                     names now, and whether that entry changed after this value
 *                     was derived from it
 *
 * @param label     directory name of the version (data/<label>/)
 * @param manifest  manifest.json
 * @param master    master.json
 * @param lt        LT.json, parsed with jsonfmt.parse (numbers keep their written digits)
 */
export function buildVersion({ label, manifest, master, lt }) {
  expectFormat(manifest, MANIFEST_FORMATS);
  expectFormat(lt, LT_FORMATS);
  const tables = {
    ...nuclideTables(master.nuclides),
    facilities: new Map((master.facilities.facilities || []).map((f) => [f.abbr, f])),
  };
  const physics = new Physics(master.huff_factors, master.constants);
  const metas = new Map(lt.meta.map((m) => [m.id, m]));
  const references = new Map(lt.bibliography.map((r) => [normalizeBibId(r.id), r]));

  const rows = lt.data.map((entry) => {
    const { nuclide, observable } = entry;
    const block = observable[observable.kind];
    const z = tables.zOf.get(nuclide.element) || 0;
    const unc = combinedUncertainty(block.uncertainties);
    return {
      entry,
      meta: metas.get(entry.metaId),
      reference: references.get(normalizeBibId(entry.bibId)) || null,
      code: CODE_OF[entry.datasetType],
      z,
      a: effectiveMass(z, nuclide.mass, tables.monoisotopic),
      block,
      unc,
      conv: physics.convert(z, nuclide.mass, observable.kind, block.value, unc, block.unit),
    };
  });

  const byId = new Map();     // datasetId, and former identifiers, -> row
  const usedBy = new Map();   // datasetId -> rows that list it as original data
  for (const row of rows) byId.set(row.entry.datasetId, row);
  for (const row of rows) {
    for (const former of row.entry.legacyIds || []) if (!byId.has(former)) byId.set(former, row);
  }
  for (const row of rows) {
    // each original: the row it names now, and whether it changed after this value was derived from it
    row.originals = (row.entry.originalData || []).map((item) => {
      const target = byId.get(item.datasetId) || null;
      return { id: item.datasetId, row: target, changed: !!target && entryHash(target.entry) !== item.entryHash };
    });
    for (const original of row.originals) {
      if (!original.row) continue;
      const key = original.row.entry.datasetId;
      if (!usedBy.has(key)) usedBy.set(key, []);
      usedBy.get(key).push(row);
    }
  }
  return {
    label, root: `data/${label}/`, manifest, tables, physics, rows, byId, usedBy,
    meta: lt.meta, bibliography: lt.bibliography,
  };
}
