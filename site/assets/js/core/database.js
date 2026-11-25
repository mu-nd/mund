// The files under data/ and their checks
// (twin of tools/mundlib/database.py; shared cases: tests/vectors/cases.json).
//
// Three layers of checks (docs/data-format.md §5):
//   1. syntax    the file is JSON and written in its canonical form
//   2. schema    the file follows schema/v1/*.schema.json
//   3. semantic  identifiers match their definition and are unique, references
//                resolve, facilities exist ...

import * as ids from './ids.js';
import * as jsonfmt from './jsonfmt.js';
import { isObject, objects } from './jsonfmt.js';
import * as schemaMod from './schema.js';
import { sha256 } from './sha256.js';
import { fileLabel, bibKind } from './cite.js';
import { SUBLIBRARIES, DEFINED_SUBLIBRARIES, CODE_OF } from './vocabulary.js';
import { nuclideTables } from './nuclides.js';

export const DATA_DIR = 'data';
export const MASTER_DIR = 'data/master';
const DATA_FILE_RE = new RegExp(`^${DATA_DIR}/(${SUBLIBRARIES.join('|')})/.+\\.json$`);

/** A file of a sub-library (not a master table). */
export const isDataFilePath = (path) => DATA_FILE_RE.test(path);

// master table -> its format
export const MASTER_FORMATS = {
  'facilities.json': 'muND/facilities/1',
  'bibliography.json': 'muND/bibliography/1',
  'nuclides.json': 'muND/nuclides/1',
  'huff_factors.json': 'muND/huff-factors/1',
  'constants.json': 'muND/constants/2',
};

const FILE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

function issue(level, code, file, pointer, message) {
  return { level, code, file, pointer, message };
}

function checkMass(issues, path, pointer, z, mass) {
  if (Number.isInteger(z) && Number.isInteger(mass) && mass > 0 && mass < z) {
    issues.push(issue('error', 'E_MASS_BELOW_Z', path, pointer, 'mass number is smaller than atomic number'));
  }
}

/** One JSON file of the database, as text and parsed (numbers keep their digits). */
class DataFile {
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
    return isObject(this.obj) ? objects(this.obj.data) : [];
  }

  /** EXP / TH / CUR / EVAL for the file's datasetType. */
  get code() {
    return isObject(this.obj) ? fileCode(this.obj) : null;
  }
}

/** Canonical repository path of a file: data/<sub-library>/<code>/<label>_<MetaID>.json. */
export function filePath(obj, reference) {
  const meta = isObject(obj.meta) ? obj.meta : {};
  return `${DATA_DIR}/${obj.sublibrary}/${fileCode(obj)}/${fileLabel(meta, reference)}_${meta.id}.json`;
}

export function fileCode(obj) {
  return typeof obj.datasetType === 'string' && Object.hasOwn(CODE_OF, obj.datasetType)
    ? CODE_OF[obj.datasetType] : null;
}

/** The value block of an entry: observable[observable.kind]. */
export function quantity(entry) {
  const obs = isObject(entry.observable) ? entry.observable : {};
  const block = typeof obs.kind === 'string' && Object.hasOwn(obs, obs.kind) ? obs[obs.kind] : null;
  return isObject(block) ? block : null;
}

export function expectedMetaId(obj) {
  const meta = isObject(obj.meta) ? obj.meta : {};
  const code = fileCode(obj);
  if (typeof meta.bibId !== 'string' || code === null) return null;
  return ids.metaId(String(obj.sublibrary), code, meta.bibId, typeof meta.key === 'string' ? meta.key : null);
}

function expectedDataId(obj, row, metaId) {
  const nuclide = isObject(row.nuclide) ? row.nuclide : {};
  if (typeof nuclide.element !== 'string' || typeof nuclide.mass !== 'number') return null;
  const mass = jsonfmt.numberText(nuclide, 'mass');
  return ids.dataId(String(obj.sublibrary), fileCode(obj), nuclide.element, mass, metaId,
    typeof row.key === 'string' ? row.key : null);
}

/**
 * Content hash of an entry: 12 hex digits of SHA-256 over its nuclide and observable
 * (values, units and uncertainties as written). Derived entries record it for each
 * of their original data, so that a later correction of an original shows.
 */
export function entryHash(entry) {
  const content = { nuclide: isObject(entry) ? entry.nuclide ?? null : null, observable: isObject(entry) ? entry.observable ?? null : null };
  return sha256(jsonfmt.compact(content)).slice(0, 12);
}

/** (Re)compute meta.id and every data[].datasetId in place. */
export function assignIds(obj) {
  if (!isObject(obj)) throw new Error('the top level is not an object');
  if (!Array.isArray(obj.data)) throw new Error('data must be an array');
  const mid = expectedMetaId(obj);
  if (mid === null) throw new Error('datasetType and meta.bibId are needed to compute identifiers');
  obj.meta.id = mid;
  for (const entry of obj.data) {
    // an entry without element or mass keeps what it has; validation reports it
    const did = isObject(entry) ? expectedDataId(obj, entry, mid) : null;
    if (did !== null) entry.datasetId = did;
  }
  return obj;
}

export class Database {
  /** @param schemas {file name: schema object}, e.g. {'lt.schema.json': {...}} */
  constructor(schemas) {
    this.schemas = schemas;
    this.files = new Map();   // path -> DataFile of a sub-library
    this.master = new Map();  // name -> DataFile
    this.unknown = new Set(); // other paths under data/
  }

  #setMaster(name, text) {
    this.master.set(name, new DataFile(`${MASTER_DIR}/${name}`, text));
    this._tables = null;
    this._references = null;
  }

  /** Bibliography entries by their normalised id (the bibId). */
  references() {
    if (!this._references) {
      const out = new Map();
      const refs = this.masterObj('bibliography.json').references;
      for (const ref of Array.isArray(refs) ? refs : []) {
        if (isObject(ref) && typeof ref.id === 'string' && ref.id) {
          const key = ids.normalizeBibId(ref.id);
          if (!out.has(key)) out.set(key, ref);
        }
      }
      this._references = out;
    }
    return this._references;
  }

  reference(bibId) {
    return typeof bibId === 'string' ? this.references().get(ids.normalizeBibId(bibId)) || null : null;
  }

  /** Add or replace any file under data/: a master table, a file of a sub-library, or neither. */
  setFile(path, text) {
    const name = path.startsWith(`${MASTER_DIR}/`) ? path.slice(MASTER_DIR.length + 1) : null;
    if (name !== null && Object.hasOwn(MASTER_FORMATS, name)) this.#setMaster(name, text);
    else if (isDataFilePath(path)) this.files.set(path, new DataFile(path, text));
    else this.unknown.add(path);
  }

  removeFile(path) {
    const name = path.startsWith(`${MASTER_DIR}/`) ? path.slice(MASTER_DIR.length + 1) : null;
    if (name !== null && this.master.delete(name)) {
      this._tables = null;
      this._references = null;
    }
    this.files.delete(path);
    this.unknown.delete(path);
  }

  sortedFiles() {
    return [...this.files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  masterObj(name) {
    const f = this.master.get(name);
    return f && isObject(f.obj) ? f.obj : {};
  }

  tables() {
    if (!this._tables) {
      this._tables = {
        ...nuclideTables(this.masterObj('nuclides.json')),
        facilities: new Map(objects(this.masterObj('facilities.json').facilities).map((f) => [f.abbr, f])),
      };
    }
    return this._tables;
  }

  zOf(element) {
    return this.tables().zOf.get(element) || 0;
  }

  /** Every entry with its file, code and metadata record. */
  * entries(sublibrary) {
    for (const f of this.sortedFiles()) {
      if (!isObject(f.obj)) continue;
      if (sublibrary && f.obj.sublibrary !== sublibrary) continue;
      for (const entry of f.data) yield { file: f, code: f.code, meta: f.meta, entry };
    }
  }

  // -- validation ----------------------------------------------------------

  validate() {
    const issues = [];
    for (const name of Object.keys(MASTER_FORMATS)) {
      if (!this.master.has(name)) {
        issues.push(issue('error', 'E_MASTER_MISSING', `${MASTER_DIR}/${name}`, '', 'master table is missing'));
      }
    }
    for (const path of [...this.unknown].sort()) {
      issues.push(issue('error', 'E_PATH', path, '',
        `not part of the database: files belong in ${DATA_DIR}/<sub-library>/<code>/ or are one of the master tables in ${MASTER_DIR}/`));
    }
    for (const name of [...this.master.keys()].sort()) issues.push(...this.#checkMaster(name, this.master.get(name)));
    for (const f of this.sortedFiles()) issues.push(...this.#checkFile(f));
    issues.push(...this.#checkCross());
    return issues;
  }

  #checkSyntax(f) {
    if (f.parseError) return [issue('error', 'E_JSON', f.path, '', `not valid JSON: ${f.parseError}`)];
    if (!isObject(f.obj)) return [issue('error', 'E_JSON', f.path, '', 'the top level must be an object')];
    return [];
  }

  #checkSchema(f, schema) {
    const issues = schemaMod.validate(f.obj, schema).map((e) => issue('error', 'E_SCHEMA', f.path, e.pointer, e.message));
    if (schemaMod.canonicalText(f.obj, this.schemas) !== f.text) {
      issues.push(issue('error', 'E_CANONICAL', f.path, '', 'file is not in canonical form; run: python3 tools/mund.py fix'));
    }
    return issues;
  }

  #checkMaster(name, f) {
    const syntax = this.#checkSyntax(f);
    if (syntax.length) return syntax;
    const format = MASTER_FORMATS[name];
    if (f.obj.format !== format) return [issue('error', 'E_FORMAT', f.path, '/format', `expected '${format}'`)];
    const issues = this.#checkSchema(f, schemaMod.schemaFor(format, this.schemas));
    if (name === 'facilities.json') {
      issues.push(...this.#checkUnique(f, 'facilities', 'abbr', 'E_DUPLICATE_FACILITY', (v) => v));
    }
    if (name === 'bibliography.json') {
      issues.push(...this.#checkUnique(f, 'references', 'id', 'E_DUPLICATE_REFERENCE', ids.normalizeBibId));
    }
    if (name === 'nuclides.json') issues.push(...this.#checkNuclides(f));
    if (name === 'huff_factors.json') issues.push(...this.#checkHuff(f));
    return issues;
  }

  #checkNuclides(f) {
    const issues = [];
    const { elements } = f.obj;
    const expected = schemaMod.schemaFor('muND/LT/1', this.schemas).$defs.element.enum;
    if (Array.isArray(elements) && elements.every((e) => typeof e === 'string')
      && (elements.length !== expected.length || elements.some((e, i) => e !== expected[i]))) {
      issues.push(issue('error', 'E_ELEMENT_ORDER', f.path, '/elements', 'list the LT element symbols in atomic number order'));
    }
    for (const member of ['isotope_ranges', 'monoisotopic']) {
      const seen = new Set();
      (Array.isArray(f.obj[member]) ? f.obj[member] : []).forEach((row, i) => {
        const z = row?.z;
        if (!Number.isInteger(z)) return;
        const ptr = `/${member}/${i}/z`;
        if (seen.has(z)) issues.push(issue('error', 'E_DUPLICATE_Z', f.path, ptr, 'atomic number listed twice'));
        if (Array.isArray(elements) && z > elements.length) {
          issues.push(issue('error', 'E_UNKNOWN_Z', f.path, ptr, 'atomic number outside the element table'));
        }
        for (const field of member === 'isotope_ranges' ? ['a_min', 'a_max'] : ['a']) {
          checkMass(issues, f.path, `/${member}/${i}/${field}`, z, row[field]);
        }
        seen.add(z);
      });
    }
    return issues;
  }

  /** One Huff factor per element and per nuclide. */
  #checkHuff(f) {
    const issues = [];
    for (const [member, fields] of [['by_element', ['z']], ['by_nuclide', ['z', 'a']]]) {
      const seen = new Set();
      (Array.isArray(f.obj[member]) ? f.obj[member] : []).forEach((item, i) => {
        const key = isObject(item) ? fields.map((k) => item[k]) : [];
        if (!key.length || !key.every(Number.isInteger)) return;
        if (member === 'by_nuclide') checkMass(issues, f.path, `/by_nuclide/${i}/a`, ...key);
        const text = fields.map((k, j) => `${k.toUpperCase()}=${key[j]}`).join(' ');
        if (seen.has(text)) {
          issues.push(issue('error', 'E_DUPLICATE_HUFF', f.path, `/${member}/${i}`, `the Huff factor of ${text} is listed twice`));
        }
        seen.add(text);
      });
    }
    return issues;
  }

  #checkUnique(f, member, key, code, norm) {
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

  #checkFile(f) {
    const syntax = this.#checkSyntax(f);
    if (syntax.length) return syntax;
    const sub = f.path.split('/')[1];
    if (!DEFINED_SUBLIBRARIES.includes(sub)) {
      return [issue('error', 'E_SUBLIBRARY_UNDEFINED', f.path, '', `the data format of sub-library ${sub} is not defined`)];
    }
    const format = f.obj.format;
    const schema = typeof format === 'string' && format.startsWith(`muND/${sub}/`) ? schemaMod.schemaFor(format, this.schemas) : null;
    if (!schema) {
      return [issue('error', 'E_FORMAT', f.path, '/format', `${JSON.stringify(format)} is not a format of sub-library ${sub}`)];
    }
    return this.#checkSchema(f, schema).concat(this.#checkContent(f));
  }

  /** Semantic checks that need only this file and the master tables. */
  #checkContent(f) {
    const { obj, path, meta, code } = f;
    const tables = this.tables();
    const issues = [];

    // location
    const parts = path.split('/');
    if (parts.length !== 4 || parts[1] !== obj.sublibrary || parts[2] !== code) {
      issues.push(issue('error', 'E_PATH', path, '', `file must be stored in ${DATA_DIR}/${obj.sublibrary}/${code}/`));
    } else {
      const suffix = `_${meta.id}.json`;
      if (!parts[3].endsWith(suffix) || !FILE_LABEL_RE.test(parts[3].slice(0, -suffix.length))) {
        const example = filePath(obj, this.reference(meta.bibId)).split('/').pop();
        issues.push(issue('error', 'E_PATH', path, '', `file name must be <label>_<MetaID>.json, e.g. ${example}`));
      }
    }

    // identifiers
    const mid = expectedMetaId(obj);
    if (mid !== null && meta.id !== mid) {
      issues.push(issue('error', 'E_META_ID', path, '/meta/id', `MetaID should be ${mid} for this datasetType / bibId / key`));
    }
    f.data.forEach((entry, i) => {
      if (mid !== null) {
        const did = expectedDataId(obj, entry, mid);
        if (did !== null && entry.datasetId !== did) {
          issues.push(issue('error', 'E_DATA_ID', path, `/data/${i}/datasetId`,
            `datasetId should be ${did} for this element / mass / key`));
        }
      }
      // plausibility of the mass number
      const nuclide = isObject(entry.nuclide) ? entry.nuclide : {};
      if (Number.isInteger(nuclide.mass) && nuclide.mass > 0) {
        const z = this.zOf(nuclide.element);
        checkMass(issues, path, `/data/${i}/nuclide/mass`, z, nuclide.mass);
        const range = tables.ranges.get(z);
        if (nuclide.mass >= z && range && !(range[0] - 8 <= nuclide.mass && nuclide.mass <= range[1] + 8)) {
          issues.push(issue('warning', 'W_MASS_RANGE', path, `/data/${i}/nuclide/mass`,
            `mass number ${nuclide.mass} is unusual for ${nuclide.element} (known range ${range[0]}-${range[1]})`));
        }
      }
      // at most one overall uncertainty
      const block = quantity(entry);
      if (block && Array.isArray(block.uncertainties)
        && block.uncertainties.filter((u) => isObject(u) && u.source === 'total').length > 1) {
        issues.push(issue('error', 'E_UNCERTAINTY_TOTAL', path, `/data/${i}/observable/${entry.observable.kind}/uncertainties`,
          "only one uncertainty may have the source 'total'"));
      }
    });

    // metadata
    if (typeof meta.facility === 'string' && !tables.facilities.has(meta.facility)) {
      issues.push(issue('error', 'E_FACILITY', path, '/meta/facility', `'${meta.facility}' is not listed in ${MASTER_DIR}/facilities.json`));
    }
    // a DOI or an NSR keynumber has its bibliographic data in the bibliography; a muND key may have them
    if (['DOI', 'NSR'].includes(bibKind(meta.bibId)) && !this.reference(meta.bibId)) {
      issues.push(issue('warning', 'W_NO_REFERENCE', path, '/meta/bibId',
        `no bibliographic information for ${meta.bibId} in ${MASTER_DIR}/bibliography.json`));
    }
    return issues;
  }

  /** Identifiers that must be unique, and references between entries. */
  #checkCross() {
    const issues = [];
    const files = this.sortedFiles().filter((f) => isObject(f.obj));
    const metas = new Map();
    const entries = new Map();   // datasetId -> where it is first used
    for (const f of files) {
      const mid = f.meta.id;
      if (typeof mid === 'string') {
        if (metas.has(mid)) {
          issues.push(issue('error', 'E_DUPLICATE_META', f.path, '/meta/id', `MetaID ${mid} is also used by ${metas.get(mid)}`));
        } else {
          metas.set(mid, f.path);
        }
      }
      f.data.forEach((entry, i) => {
        if (typeof entry.datasetId !== 'string') return;
        const first = entries.get(entry.datasetId);
        if (first) {
          issues.push(issue('error', 'E_DUPLICATE_ID', f.path, `/data/${i}/datasetId`,
            `datasetId ${entry.datasetId} is also used in ${first.file.path}: give the entries different keys`));
        } else {
          entries.set(entry.datasetId, { file: f, code: f.code, sublibrary: f.obj.sublibrary, entry });
        }
      });
    }
    // earlier identifiers: each names exactly one entry and is nobody's current identifier
    const legacy = new Map();    // earlier id -> current datasetId
    for (const f of files) {
      f.data.forEach((entry, i) => {
        if (!Array.isArray(entry.legacyIds)) return;
        entry.legacyIds.forEach((lid, k) => {
          if (typeof lid !== 'string') return;
          const ptr = `/data/${i}/legacyIds/${k}`;
          const current = entries.get(lid);
          if (current) {
            issues.push(issue('error', 'E_LEGACY_ID_CONFLICT', f.path, ptr,
              `${lid} is the current datasetId of an entry in ${current.file.path}`));
          } else if (legacy.has(lid)) {
            issues.push(issue('error', 'E_LEGACY_ID_CONFLICT', f.path, ptr,
              `${lid} is also an earlier identifier of ${legacy.get(lid)}`));
          } else if (typeof entry.datasetId === 'string') {
            legacy.set(lid, entry.datasetId);
          }
        });
      });
    }
    for (const f of files) {
      f.data.forEach((entry, i) => {
        const seen = new Set();
        (Array.isArray(entry.originalData) ? entry.originalData : []).forEach((item, j) => {
          const oid = isObject(item) ? item.datasetId : null;
          if (typeof oid !== 'string') return;   // the schema reports it
          const ptr = `/data/${i}/originalData/${j}`;
          const current = entries.has(oid) ? oid : legacy.get(oid) ?? oid;
          if (seen.has(current)) {
            issues.push(issue('error', 'E_ORIGINAL_DUPLICATE', f.path, ptr, `original data ${oid} is listed twice`));
            return;
          }
          seen.add(current);
          const target = entries.get(current);
          if (!target || target.sublibrary !== f.obj.sublibrary) {
            issues.push(issue('error', 'E_ORIGINAL_MISSING', f.path, ptr, `original data ${oid} does not exist`));
          } else if (current === entry.datasetId) {
            issues.push(issue('error', 'E_ORIGINAL_SELF', f.path, ptr, 'an entry cannot be its own original data'));
          } else if (f.code === 'CUR' && target.code !== 'EXP') {
            issues.push(issue('error', 'E_ORIGINAL_NOT_EXP', f.path, ptr,
              `curated data must refer to experimental data; ${oid} is ${target.code}`));
          } else {
            if (current !== oid) {
              issues.push(issue('warning', 'W_ORIGINAL_LEGACY', f.path, ptr,
                `${oid} is an earlier identifier of ${current}: refer to ${current}`));
            }
            const now = entryHash(target.entry);
            if (typeof item.entryHash === 'string' && item.entryHash !== now) {
              issues.push(issue('warning', 'W_ORIGINAL_CHANGED', f.path, ptr,
                `${current} has changed since this entry was derived from it (entryHash ${item.entryHash}, now ${now}): ` +
                'check this entry again, then record the new entryHash'));
            }
          }
        });
      });
    }
    return issues;
  }
}
