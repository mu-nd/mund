// The data versions, and one version of the published data as the pages use
// it, built from its files (manifest.json, master.json, LT.json).  No fetching
// here: see store.js.  The rows of a version are derived as the API derives them
// (twin: rows() in tools/mundlib/api.py).
//
// `versions` is api/versions.json: { default, versions: [{label, version, kind, commit, date}] };
// `default` is the newest stable version (the development version while there
// is none).  kind "release": a stable version, fixed; kind "development": the
// development version, built from the current main branch (label "latest").

import { entryHash } from '../core/database.js';
import { Physics, combinedUncertainty, OBSERVABLES, UNIT_FACTORS } from '../core/convert.js';
import { nuclideTables, effectiveMass } from '../core/nuclides.js';
import { normalizeBibId } from '../core/ids.js';
import { CODE_OF } from '../core/vocabulary.js';

/**
 * The version an address asks for.  No `requested` label: the default
 * version.  A label that is not in the list is an error; another version is
 * never shown in its place.
 * @returns {{label: string|null, entry: object|null, error: string|null}}
 */
export function resolveVersion(versions, requested) {
  const list = versions && Array.isArray(versions.versions) ? versions.versions : [];
  const asked = requested !== null && requested !== undefined && requested !== '';
  const label = asked ? String(requested) : versions && versions.default;
  const entry = list.find((v) => v.label === label) || null;
  if (entry) return { label, entry, error: null };
  return {
    label: null,
    entry: null,
    error: asked ? `There is no data version “${label}”.` : `The default data version “${label}” is not in the list of versions.`,
  };
}

/** The files of a version must describe the version that was asked for. */
export function checkManifest(entry, manifest) {
  if (manifest.label !== entry.label || manifest.version !== entry.version) {
    throw new Error(`the files of “${entry.label}” are those of ${manifest.label} ${manifest.version}, `
      + `not of version ${entry.version}`);
  }
  return manifest;
}

const isRelease = (entry) => entry.kind === 'release';

/**
 * How the pages name a version (an entry of api/versions.json, or a manifest):
 * 'Version 1.0.0 (latest stable)', 'Version 1.0.0' or
 * 'Development version 1.0.0+2.gabcdef1 (unstable)'.  `newest`: the label of
 * the newest stable version (versions.default).
 */
export function versionName(entry, { newest = null } = {}) {
  if (!isRelease(entry)) return `Development version ${entry.version} (unstable)`;
  return entry.label === newest ? `Version ${entry.version} (latest stable)` : `Version ${entry.version}`;
}

// Formats of the built files these pages can read.  Stable versions keep
// the format they were built with, so a list may hold several.
const MANIFEST_FORMATS = ['muND/manifest/1'];
const LT_FORMATS = ['muND/dist/LT/1'];

function expectFormat(obj, formats) {
  if (!obj || !formats.includes(obj.format)) {
    throw new Error(`the data are in a format this page does not know (${obj && obj.format})`);
  }
  return obj;
}

/**
 * How many entries a version holds of a sub-library (XR | LT | ES | BR), from
 * the counts in manifest.sublibraries; 0 unless the sub-library is available.
 */
export function sublibraryTotal(manifest, sublibrary) {
  const info = (manifest.sublibraries || {})[sublibrary] || {};
  if (info.status !== 'available') return 0;
  return Object.values(info.counts || {}).reduce((n, c) => n + c, 0);
}

/**
 * A version is { label, root, manifest, tables, physics, constants, rows, byId, usedBy,
 * meta, bibliography }; `constants` is constants.json of master.json, `meta` and
 * `bibliography` are the lists of LT.json.
 * A row is one data entry as published (`entry`) together with what the pages
 * derive from it:
 *   meta, reference   its metadata record and bibliography entry
 *   code              EXP | TH | CUR | EVAL
 *   z, a              atomic number; mass number for display (see effectiveMass)
 *   block             the value block, entry.observable[entry.observable.kind]
 *   unitScale         factor from the source unit to the unit of the displayed column
 *   unc               one overall uncertainty, or null
 *   conv              lifetime, capture rate and capture probability, or null
 *   originals         [{id, row, changed}] for each originalData item: the row it
 *                     names now, and whether that entry changed after this value
 *                     was derived from it
 *
 * @param label     directory name of the version (data/<label>/)
 * @param manifest  manifest.json
 * @param master    master.json when the page uses the master tables
 * @param lt        LT.json when the page uses measurements, parsed with jsonfmt.parse (numbers keep their written digits)
 *
 * The CSV files and the API derive z, reference, block, unc and conv in the
 * same way (rows() in tools/mundlib/api.py).
 */
export function buildVersion({ label, manifest, master, lt }) {
  expectFormat(manifest, MANIFEST_FORMATS);
  const version = { label, root: `data/${label}/`, manifest };
  if (master === undefined) return version;
  const tables = {
    ...nuclideTables(master.nuclides),
    facilities: new Map((master.facilities.facilities || []).map((f) => [f.abbr, f])),
  };
  const physics = new Physics(master.huff_factors, master.constants);
  Object.assign(version, { tables, physics, constants: master.constants });
  if (lt === undefined) return version;
  expectFormat(lt, LT_FORMATS);
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
      unitScale: UNIT_FACTORS[observable.kind][block.unit] / UNIT_FACTORS[observable.kind][OBSERVABLES[observable.kind].unit],
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
    ...version, rows, byId, usedBy,
    meta: lt.meta, bibliography: lt.bibliography,
  };
}

/** The DataID of the entry that `id` names in the version (its DataID or a former one, see byId), or ''. */
export function currentId(version, id) {
  const row = id ? version.byId.get(id) : null;
  return row ? row.entry.datasetId : '';
}
