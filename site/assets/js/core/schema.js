// A small JSON Schema validator and the schema-driven normalisation.
//
// It implements exactly the keywords used by schema/v1/*.schema.json:
//   $ref (local), type, const, enum, required, properties, additionalProperties: false,
//   items, pattern, minLength, minimum, maximum, exclusiveMinimum, minItems, uniqueItems,
//   allOf, if / then / else, not
// CI validates the same files with the reference implementation (Python
// `jsonschema`); tests/vectors/cases.json keeps the two in agreement.

import { getLexeme, setLexeme } from './jsonfmt.js';

const SUPPORTED = new Set([
  '$schema', '$id', '$defs', '$ref', '$comment', 'title', 'description', 'default', 'examples',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'pattern',
  'minLength', 'minimum', 'maximum', 'exclusiveMinimum', 'minItems', 'uniqueItems',
  'allOf', 'if', 'then', 'else', 'not',
]);

export function pointer(path) {
  return path.map((p) => '/' + String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

export function resolve(schema, root) {
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
  if (schemaIn === true) return;
  if (schemaIn === false) {
    errors.push({ pointer: pointer(path), keyword: 'false', message: 'this member is not allowed' });
    return;
  }
  // keywords next to $ref (description ...) are annotations in our schemas
  const schema = resolve(schemaIn, root);
  const at = pointer(path);
  const add = (keyword, message) => errors.push({ pointer: at, keyword, message });

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`schema keyword not supported: ${keyword}`);
  }

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
      if (!Object.prototype.hasOwnProperty.call(value, name)) {
        add('required', `'${name}' is a required property`);
      }
    }
    const props = schema.properties || {};
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        check(value[key], props[key], root, path.concat(key), errors);
      } else if (schema.additionalProperties === false) {
        add('additionalProperties', `unknown property '${key}'`);
      }
    }
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
    if (probe.length === 0) {
      const empty = schema.not && typeof schema.not === 'object' && !Object.keys(schema.not).length;
      add('not', empty ? 'this member is not allowed for this dataset type' : 'value is not allowed');
    }
  }
}

/** Validate; returns [{pointer, keyword, message}] sorted by location. */
export function validate(instance, schema) {
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
export function normalize(value, schemaIn, rootIn) {
  const root = rootIn || schemaIn;
  const resolved = schemaIn && typeof schemaIn === 'object' ? resolve(schemaIn, root) : {};
  const schema = resolved && typeof resolved === 'object' ? resolved : {};
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const items = schema.items && typeof schema.items === 'object' ? schema.items : {};
    const out = value.map((v) => normalize(v, items, root));
    value.forEach((v, i) => {
      const lex = getLexeme(value, i);
      if (lex !== undefined) setLexeme(out, i, lex);
    });
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const known = Object.keys(props).filter((k) => Object.prototype.hasOwnProperty.call(value, k));
    const unknown = Object.keys(value).filter((k) => !Object.prototype.hasOwnProperty.call(props, k)).sort();
    const out = {};
    for (const key of known.concat(unknown)) {
      const sub = props[key] && typeof props[key] === 'object' ? props[key] : {};
      const v = normalize(value[key], sub, root);
      if (isEmpty(v) && !required.has(key)) continue;
      out[key] = v;
      const lex = getLexeme(value, key);
      if (lex !== undefined) setLexeme(out, key, lex);
    }
    return out;
  }
  return value;
}
