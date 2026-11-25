// JSON Schema validation and schema-driven normalisation
// (twin of tools/mundlib/schema.py; shared cases: tests/vectors/cases.json).
//
// Python validates with the reference implementation (jsonschema); in a pattern, a final $
// matches only at the end of the string, as in JavaScript. JavaScript implements
// exactly the keywords used by schema/v1/*.schema.json (SUPPORTED); before validating, it
// throws on any other keyword anywhere in the schema, on constraints next to $ref and on an
// additionalProperties that is not true or false.

import { copyLexemes, isObject, stringify } from './jsonfmt.js';

// file "format" -> schema file in schema/v1
export const SCHEMA_FILES = {
  'muND/LT/1': 'lt.schema.json',
  'muND/facilities/1': 'facilities.schema.json',
  'muND/bibliography/1': 'bibliography.schema.json',
  'muND/nuclides/1': 'nuclides.schema.json',
  'muND/huff-factors/1': 'huff-factors.schema.json',
  'muND/constants/2': 'constants.schema.json',
};

/** The schema of a file format from `schemas` (schema file name -> schema), or null. */
export function schemaFor(format, schemas) {
  const name = typeof format === 'string' && Object.hasOwn(SCHEMA_FILES, format) ? SCHEMA_FILES[format] : null;
  return (name && schemas[name]) || null;
}

const SUPPORTED = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'pattern',
  'minLength', 'minimum', 'maximum', 'exclusiveMinimum', 'minItems', 'uniqueItems',
  'allOf', 'if', 'then', 'else', 'not',
]);

function pointer(path) {
  return path.map((p) => '/' + String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

function resolve(schema, root) {
  let s = schema;
  while (s && typeof s === 'object' && typeof s.$ref === 'string') {
    if (!s.$ref.startsWith('#/')) throw new Error(`only local $ref is supported: ${s.$ref}`);
    let node = root;
    for (const part of s.$ref.slice(2).split('/')) node = node[part];
    s = node;
  }
  return s;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value; // string, boolean, object
}

function matchesType(value, type) {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

const show = (v) => (typeof v === 'string' ? `'${v}'` : JSON.stringify(v));

function check(value, schemaIn, root, path, errors) {
  // only title and description stand next to $ref (see assertSupported)
  const schema = resolve(schemaIn, root);
  const at = pointer(path);
  const add = (keyword, message) => errors.push({ pointer: at, keyword, message });

  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      add('type', `${show(value)} is not of type ${types.map((t) => `'${t}'`).join(', ')}`);
    }
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    add('const', `${show(schema.const)} was expected`);
  }
  if ('enum' in schema && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    const list = schema.enum.length > 12 ? 'the allowed values' : schema.enum.map(show).join(', ');
    add('enum', `${show(value)} is not one of ${list}`);
  }

  if (typeof value === 'string') {
    if ('minLength' in schema && [...value].length < schema.minLength) {
      add('minLength', value === '' ? 'must not be empty' : `${show(value)} is too short`);
    }
    if ('pattern' in schema && !new RegExp(schema.pattern, 'u').test(value)) {
      add('pattern', `${show(value)} does not match '${schema.pattern}'`);
    }
  }

  if (typeof value === 'number') {
    if ('minimum' in schema && value < schema.minimum) {
      add('minimum', `${value} is less than the minimum of ${schema.minimum}`);
    }
    if ('maximum' in schema && value > schema.maximum) {
      add('maximum', `${value} is greater than the maximum of ${schema.maximum}`);
    }
    if ('exclusiveMinimum' in schema && value <= schema.exclusiveMinimum) {
      add('exclusiveMinimum', `${value} must be greater than ${schema.exclusiveMinimum}`);
    }
  }

  if (Array.isArray(value)) {
    if ('minItems' in schema && value.length < schema.minItems) {
      add('minItems', value.length ? 'has too few elements' : 'must not be empty');
    }
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      add('uniqueItems', 'has non-unique elements');
    }
    if ('items' in schema) {
      value.forEach((v, i) => check(v, schema.items, root, path.concat(i), errors));
    }
  } else if (value !== null && typeof value === 'object') {
    for (const name of schema.required || []) {
      if (!Object.hasOwn(value, name)) {
        add('required', `'${name}' is a required property`);
      }
    }
    const props = schema.properties || {};
    const extra = [];
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(props, key)) {
        check(value[key], props[key], root, path.concat(key), errors);
      } else if (schema.additionalProperties === false) {
        extra.push(key);
      }
    }
    if (extra.length) add('additionalProperties', `unknown properties: ${extra.map(show).join(', ')}`);
  }

  for (const sub of schema.allOf || []) check(value, sub, root, path, errors);
  if ('if' in schema) {
    const probe = [];
    check(value, schema.if, root, path, probe);
    const branch = probe.length === 0 ? schema.then : schema.else;
    if (branch !== undefined) check(value, branch, root, path, errors);
  }
  if ('not' in schema) {
    const probe = [];
    check(value, schema.not, root, path, probe);
    if (probe.length === 0) add('not', 'this member is not allowed here');
  }
}

// Every node of a schema is checked once, before any data is validated against it,
// so that a keyword or form this validator does not implement fails at once.
const checked = new WeakSet();

function assertSupported(node, at) {
  if (!isObject(node)) throw new Error(`schema at ${at} must be an object`);
  for (const keyword of Object.keys(node)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`schema keyword not supported: ${keyword} (at ${at})`);
  }
  if ('$ref' in node && Object.keys(node).some((k) => k !== '$ref' && k !== 'title' && k !== 'description')) {
    throw new Error(`only title and description may stand next to $ref (at ${at})`);
  }
  if ('additionalProperties' in node && typeof node.additionalProperties !== 'boolean') {
    throw new Error(`additionalProperties must be true or false (at ${at})`);
  }
  for (const key of ['properties', '$defs']) {
    for (const [name, sub] of Object.entries(node[key] || {})) assertSupported(sub, `${at}/${key}/${name}`);
  }
  for (const key of ['items', 'if', 'then', 'else', 'not']) if (key in node) assertSupported(node[key], `${at}/${key}`);
  (node.allOf || []).forEach((sub, i) => assertSupported(sub, `${at}/allOf/${i}`));
}

/** Validate; returns [{pointer, keyword, message}] sorted by location. */
export function validate(instance, schema) {
  if (!checked.has(schema)) {
    assertSupported(schema, '#');
    checked.add(schema);
  }
  const errors = [];
  check(instance, schema, schema, [], errors);
  const seen = new Set();
  return errors
    .filter((e) => {
      const k = `${e.pointer}\u0000${e.keyword}\u0000${e.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0));
}

const isEmpty = (v) => v === null || v === undefined || v === ''
  || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/**
 * Order object keys as in the schema and drop empty optional members
 * (twin of mundlib.schema.normalize).  Returns a new value; the written form
 * of numbers is carried over.
 */
function normalize(value, schemaIn, rootIn, literal = false) {
  const root = rootIn || schemaIn;
  const resolved = schemaIn && typeof schemaIn === 'object' ? resolve(schemaIn, root) : {};
  const schema = resolved && typeof resolved === 'object' ? resolved : {};
  if (typeof value === 'string') return literal ? value : value.trim();
  if (Array.isArray(value)) {
    const items = schema.items && typeof schema.items === 'object' ? schema.items : {};
    const out = value.map((v) => normalize(v, items, root, literal));
    copyLexemes(value, out, value.keys());
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const known = Object.keys(props).filter((k) => Object.hasOwn(value, k));
    const unknown = Object.keys(value).filter((k) => !Object.hasOwn(props, k)).sort();
    const out = Object.create(null);
    const correction = schema === root?.$defs?.correction;
    for (const key of known.concat(unknown)) {
      const sub = Object.hasOwn(props, key) ? props[key] : {};
      const v = normalize(value[key], sub, root, literal || (correction && (key === 'before' || key === 'after')));
      if (!literal && isEmpty(v) && !required.has(key)) continue;
      out[key] = v;
    }
    copyLexemes(value, out, Object.keys(out));
    return out;
  }
  return value;
}

/**
 * Canonical text of a file's content: members in schema order, empty optional
 * members dropped, canonical layout.
 */
export function canonicalText(obj, schemas) {
  const schema = isObject(obj) ? schemaFor(obj.format, schemas) : null;
  return stringify(schema ? normalize(obj, schema) : obj);
}
