// The database as a set of files, and the checks applied to it
// (twin of tools/mundlib/database.py).
//
//   1. syntax   - the file is JSON and written in the canonical layout
//   2. schema   - the file follows schema/v1/*.schema.json
//   3. semantic - identifiers match their definition and are unique,
//                 references resolve, facilities exist ...
//
// tests/vectors/cases.json holds the cases both implementations must agree on.

import * as ids from './ids.js';
import * as jsonfmt from './jsonfmt.js';
import * as schemaMod from './schema.js';
import { DATA_DIR, MASTER_DIR, datasetPath } from './cite.js';

export const SUBLIBRARIES = ['XR', 'LT', 'ES', 'BR'];
export const DATASETS = ['EXP', 'TH', 'CUR', 'EVAL'];
// datasetType (as written in the files) -> code used in directory names and identifiers
export const DATASET_TYPES = { experiment: 'EXP', theory: 'TH', curated: 'CUR', evaluated: 'EVAL' };
export const DATASET_TYPE_OF = { EXP: 'experiment', TH: 'theory', CUR: 'curated', EVAL: 'evaluated' };
export const DEFINED_SUBLIBRARIES = ['LT'];

export const SUBLIBRARY_TITLES = {
  XR: 'Muonic X-ray energies and intensities',
  LT: 'Lifetimes of muonic atoms / nuclear capture rates',
  ES: 'Energy spectra of emitted particles',
  BR: 'Production branching ratios of residual nuclei',
};
export const DATASET_TITLES = { EXP: 'Experimental', TH: 'Theoretical', CUR: 'Curated', EVAL: 'Evaluated' };

export const MASTER_FILES = ['facilities.json', 'bibliography.json', 'nuclides.json', 'huff_factors.json', 'constants.json'];
export const MASTER_FORMATS = {
  'facilities.json': 'muND/facilities/1',
  'bibliography.json': 'muND/bibliography/1',
  'nuclides.json': 'muND/nuclides/1',
  'huff_factors.json': 'muND/huff-factors/1',
  'constants.json': 'muND/constants/1',
};
// file "format" value -> schema file name
export const SCHEMA_FILES = {
  'muND/LT/1': 'lt.schema.json',
  'muND/facilities/1': 'facilities.schema.json',
  'muND/bibliography/1': 'bibliography.schema.json',
};

const FILE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function issue(level, code, file, pointer, message) {
  return { level, code, file, pointer, message };
}

export class DataFile {
  constructor(path, text) {
    this.path = path;
    this.text = text;
    this.obj = null;
    this.parseError = null;
    try {
      this.obj = jsonfmt.parse(text);
    } catch (err) {
      this.parseError = err.message;
    }
  }

  get meta() {
    return isObject(this.obj) && isObject(this.obj.meta) ? this.obj.meta : {};
  }

  get data() {
    return isObject(this.obj) && Array.isArray(this.obj.data) ? this.obj.data.filter(isObject) : [];
  }

  /** EXP / TH / CUR / EVAL for the file's datasetType. */
  get code() {
    return isObject(this.obj) ? datasetCode(this.obj) : null;
  }
}

export function datasetCode(obj) {
  return typeof obj.datasetType === 'string' && has(DATASET_TYPES, obj.datasetType)
    ? DATASET_TYPES[obj.datasetType] : null;
}

/** The value block of a data entry: observable[observable.kind]. */
export function quantity(row) {
  const obs = isObject(row.observable) ? row.observable : {};
  const block = typeof obs.kind === 'string' && has(obs, obs.kind) ? obs[obs.kind] : null;
  return isObject(block) ? block : null;
}

export function expectedMetaId(obj) {
  const meta = isObject(obj.meta) ? obj.meta : {};
  const code = datasetCode(obj);
  if (typeof meta.bibId !== 'string' || code === null) return null;
  return ids.metaId(String(obj.sublibrary), code, meta.bibId, typeof meta.key === 'string' ? meta.key : null);
}

export function expectedDataId(obj, row, metaId) {
  const nuclide = isObject(row.nuclide) ? row.nuclide : {};
  if (typeof nuclide.element !== 'string' || typeof nuclide.mass !== 'number') return null;
  const mass = jsonfmt.numberText(nuclide, 'mass');
  return ids.dataId(String(obj.sublibrary), datasetCode(obj), nuclide.element, mass, metaId,
    typeof row.key === 'string' ? row.key : null);
}

/** (Re)compute meta.id and every data[].datasetId in place. */
export function assignIds(obj) {
  const mid = expectedMetaId(obj);
  if (mid === null) throw new Error('datasetType and meta.bibId are needed to compute identifiers');
  obj.meta.id = mid;
  for (const row of obj.data || []) {
    const did = expectedDataId(obj, row, mid);
    if (did !== null) row.datasetId = did;
  }
  return obj;
}

export class Database {
  /**
   * @param schemas {file name: schema object}, e.g. {'lt.schema.json': {...}}
   * @param master  {file name: text} of data/master
   */
  constructor(schemas, master = {}) {
    this.schemas = schemas;
    this.files = new Map();   // path -> DataFile (dataset files)
    this.master = new Map();  // name -> DataFile
    for (const name of Object.keys(master)) this.setMaster(name, master[name]);
  }

  setMaster(name, text) {
    this.master.set(name, new DataFile(`${MASTER_DIR}/${name}`, text));
    this._tables = null;
    this._references = null;
  }

  /** Bibliography entries by normalised DOI. */
  references() {
    if (!this._references) {
      const out = new Map();
      const refs = this.masterObj('bibliography.json').references;
      for (const ref of Array.isArray(refs) ? refs : []) {
        if (isObject(ref) && typeof ref.DOI === 'string') {
          const key = ids.normalizeDoi(ref.DOI);
          if (!out.has(key)) out.set(key, ref);
        }
      }
      this._references = out;
    }
    return this._references;
  }

  reference(doi) {
    return typeof doi === 'string' ? this.references().get(ids.normalizeDoi(doi)) || null : null;
  }

  setFile(path, text) {
    this.files.set(path, new DataFile(path, text));
  }

  removeFile(path) {
    this.files.delete(path);
  }

  sortedFiles() {
    return [...this.files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  schemaFor(format) {
    const name = SCHEMA_FILES[format];
    return name ? this.schemas[name] || null : null;
  }

  masterObj(name) {
    const f = this.master.get(name);
    return f && isObject(f.obj) ? f.obj : {};
  }

  tables() {
    if (!this._tables) {
      const nuclides = this.masterObj('nuclides.json');
      const elements = Array.isArray(nuclides.elements) ? nuclides.elements : [];
      this._tables = {
        elements,
        zOf: new Map(elements.map((e, i) => [e, i + 1])),
        ranges: new Map((nuclides.isotope_ranges || []).map((r) => [r.z, [r.a_min, r.a_max]])),
        monoisotopic: new Map((nuclides.monoisotopic || []).map((r) => [r.z, r.a])),
        facilities: (this.masterObj('facilities.json').facilities || []).filter(isObject),
      };
      this._tables.facilityAbbrs = new Set(this._tables.facilities.map((f) => f.abbr));
    }
    return this._tables;
  }

  zOf(element) {
    return this.tables().zOf.get(element) || 0;
  }

  /** Every data point with its dataset, metadata and file. */
  * rows(sublibrary) {
    for (const f of this.sortedFiles()) {
      if (!isObject(f.obj)) continue;
      if (sublibrary && f.obj.sublibrary !== sublibrary) continue;
      for (const row of f.data) yield { file: f, dataset: f.code, meta: f.meta, row };
    }
  }

  // -- validation ----------------------------------------------------------

  validate() {
    const issues = [];
    for (const name of MASTER_FILES) {
      if (!this.master.has(name)) {
        issues.push(issue('error', 'E_MASTER_MISSING', `${MASTER_DIR}/${name}`, '', 'master file is missing'));
      }
    }
    for (const name of MASTER_FILES) {
      if (this.master.has(name)) issues.push(...this.checkMaster(name, this.master.get(name)));
    }
    for (const f of this.sortedFiles()) issues.push(...this.checkFile(f));
    issues.push(...this.checkCross());
    return issues;
  }

  checkSyntax(f) {
    if (f.parseError) return [issue('error', 'E_JSON', f.path, '', `not valid JSON: ${f.parseError}`)];
    if (!isObject(f.obj)) return [issue('error', 'E_JSON', f.path, '', 'the top level must be an object')];
    return [];
  }

  checkCanonical(f, normalized) {
    if (jsonfmt.stringify(normalized) !== f.text) {
      return [issue('error', 'E_CANONICAL', f.path, '',
        'file is not in canonical layout; run: python3 tools/mund.py format')];
    }
    return [];
  }

  checkMaster(name, f) {
    const issues = this.checkSyntax(f);
    if (issues.length) return issues;
    const format = MASTER_FORMATS[name];
    if (f.obj.format !== format) {
      issues.push(issue('error', 'E_FORMAT', f.path, '/format', `expected '${format}'`));
    }
    const schema = this.schemaFor(format);
    let normalized = f.obj;
    if (schema) {
      for (const e of schemaMod.validate(f.obj, schema)) {
        issues.push(issue('error', 'E_SCHEMA', f.path, e.pointer, e.message));
      }
      normalized = schemaMod.normalize(f.obj, schema);
    }
    issues.push(...this.checkCanonical(f, normalized));
    if (name === 'facilities.json') {
      issues.push(...this.checkUnique(f, 'facilities', 'abbr', 'E_DUPLICATE_FACILITY', (v) => v));
    }
    if (name === 'bibliography.json') {
      issues.push(...this.checkUnique(f, 'references', 'DOI', 'E_DUPLICATE_REFERENCE', ids.normalizeDoi));
    }
    return issues;
  }

  checkUnique(f, member, key, code, norm) {
    const issues = [];
    const seen = new Set();
    (Array.isArray(f.obj[member]) ? f.obj[member] : []).forEach((item, i) => {
      const value = isObject(item) ? item[key] : undefined;
      if (typeof value !== 'string') return;
      if (seen.has(norm(value))) {
        issues.push(issue('error', code, f.path, `/${member}/${i}/${key}`, `'${value}' is listed twice`));
      }
      seen.add(norm(value));
    });
    return issues;
  }

  checkFile(f) {
    const issues = this.checkSyntax(f);
    if (issues.length) return issues;
    const obj = f.obj;
    const sub = f.path.split('/')[1] || '';
    if (!DEFINED_SUBLIBRARIES.includes(sub)) {
      return [issue('error', 'E_SUBLIBRARY_UNDEFINED', f.path, '',
        `the data format of sub-library ${sub} is not defined yet`)];
    }
    const schema = this.schemaFor(String(obj.format));
    if (!schema) {
      return [issue('error', 'E_FORMAT', f.path, '/format', `unknown format ${JSON.stringify(obj.format)}`)];
    }
    for (const e of schemaMod.validate(obj, schema)) {
      issues.push(issue('error', 'E_SCHEMA', f.path, e.pointer, e.message));
    }
    issues.push(...this.checkCanonical(f, schemaMod.normalize(obj, schema)));
    issues.push(...this.checkDataset(obj, f.path));
    return issues;
  }

  /** Semantic checks that need only this file and the master tables. */
  checkDataset(obj, path) {
    const issues = [];
    const meta = isObject(obj.meta) ? obj.meta : {};
    const rows = Array.isArray(obj.data) ? obj.data : [];
    const tables = this.tables();
    const code = datasetCode(obj);

    const parts = path.split('/');
    if (parts.length !== 4 || parts[0] !== DATA_DIR || parts[1] !== obj.sublibrary || parts[2] !== code) {
      issues.push(issue('error', 'E_PATH', path, '', `file must be stored in ${DATA_DIR}/${obj.sublibrary}/${code}/`));
    } else {
      const name = parts[3];
      const suffix = `_${meta.id}.json`;
      if (!name.endsWith(suffix) || !FILE_LABEL_RE.test(name.slice(0, -suffix.length))) {
        const example = datasetPath(obj, this.reference(meta.bibId)).split('/').pop();
        issues.push(issue('error', 'E_PATH', path, '', `file name must be <label>_<MetaID>.json, e.g. ${example}`));
      }
    }

    const mid = expectedMetaId(obj);
    if (mid !== null && meta.id !== mid) {
      issues.push(issue('error', 'E_META_ID', path, '/meta/id',
        `MetaID should be ${mid} for this datasetType / bibId / key`));
    }
    const seen = new Map();
    rows.forEach((row, i) => {
      if (!isObject(row)) return;
      if (mid !== null) {
        const did = expectedDataId(obj, row, mid);
        if (did !== null && row.datasetId !== did) {
          issues.push(issue('error', 'E_DATA_ID', path, `/data/${i}/datasetId`,
            `datasetId should be ${did} for this element / mass / key`));
        }
      }
      if (typeof row.datasetId === 'string') {
        if (seen.has(row.datasetId)) {
          issues.push(issue('error', 'E_DUPLICATE_ID', path, `/data/${i}/datasetId`,
            `same datasetId as data[${seen.get(row.datasetId)}]: give the entries different keys`));
        } else {
          seen.set(row.datasetId, i);
        }
      }
      const nuclide = isObject(row.nuclide) ? row.nuclide : {};
      if (typeof nuclide.element === 'string' && Number.isInteger(nuclide.mass) && nuclide.mass > 0) {
        const z = this.zOf(nuclide.element);
        const range = z ? tables.ranges.get(z) : null;
        if (range && !(range[0] - 8 <= nuclide.mass && nuclide.mass <= range[1] + 8)) {
          issues.push(issue('warning', 'W_MASS_RANGE', path, `/data/${i}/nuclide/mass`,
            `mass number ${nuclide.mass} is unusual for ${nuclide.element} (known range ${range[0]}-${range[1]})`));
        }
      }
      const block = quantity(row);
      if (block && Array.isArray(block.uncertainties)
        && block.uncertainties.filter((u) => isObject(u) && u.source === 'total').length > 1) {
        issues.push(issue('error', 'E_UNCERTAINTY_TOTAL', path, `/data/${i}/observable/${row.observable.kind}/uncertainties`,
          "only one uncertainty may have the source 'total'"));
      }
    });

    if (typeof meta.facility === 'string' && !tables.facilityAbbrs.has(meta.facility)) {
      issues.push(issue('error', 'E_FACILITY', path, '/meta/facility',
        `'${meta.facility}' is not listed in ${MASTER_DIR}/facilities.json`));
    }
    if (typeof meta.bibId === 'string' && !this.reference(meta.bibId)) {
      issues.push(issue('warning', 'W_NO_REFERENCE', path, '/meta/bibId',
        `no bibliographic information for ${meta.bibId} in ${MASTER_DIR}/bibliography.json`));
    }
    return issues;
  }

  /** Checks that involve several files. */
  checkCross() {
    const issues = [];
    const metas = new Map();
    const dataIds = new Map();
    const files = this.sortedFiles().filter((f) => isObject(f.obj));
    for (const f of files) {
      const mid = f.meta.id;
      if (typeof mid === 'string') {
        if (metas.has(mid)) {
          issues.push(issue('error', 'E_DUPLICATE_META', f.path, '/meta/id',
            `MetaID ${mid} is also used by ${metas.get(mid)}`));
        } else {
          metas.set(mid, f.path);
        }
      }
      f.data.forEach((row, i) => {
        if (typeof row.datasetId !== 'string') return;
        const known = dataIds.get(row.datasetId);
        if (known && known.file !== f) {
          issues.push(issue('error', 'E_DUPLICATE_ID', f.path, `/data/${i}/datasetId`,
            `datasetId ${row.datasetId} is also used in ${known.file.path}`));
        }
        if (!known) dataIds.set(row.datasetId, { file: f, dataset: f.code, sublibrary: f.obj.sublibrary });
      });
    }
    for (const f of files) {
      f.data.forEach((row, i) => {
        if (!Array.isArray(row.originalData)) return;
        row.originalData.forEach((oid, j) => {
          const ptr = `/data/${i}/originalData/${j}`;
          const target = typeof oid === 'string' ? dataIds.get(oid) : null;
          if (!target || target.sublibrary !== f.obj.sublibrary) {
            issues.push(issue('error', 'E_ORIGINAL_MISSING', f.path, ptr, `original data ${oid} does not exist`));
          } else if (oid === row.datasetId) {
            issues.push(issue('error', 'E_ORIGINAL_SELF', f.path, ptr,
              'a data entry cannot be its own original data'));
          } else if (f.code === 'CUR' && target.dataset !== 'EXP') {
            issues.push(issue('error', 'E_ORIGINAL_NOT_EXP', f.path, ptr,
              `curated data must refer to experimental data; ${oid} is ${target.dataset}`));
          }
        });
      });
    }
    return issues;
  }
}
