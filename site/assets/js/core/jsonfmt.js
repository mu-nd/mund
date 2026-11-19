// Canonical JSON for the muND data files (twin of tools/mundlib/jsonfmt.py).
//
// * parse() is a strict JSON parser that remembers how every number was
//   written, so `13.250` is written back as `13.250`.  Values are ordinary
//   JavaScript numbers; the written form is kept in a side table that is
//   looked up by (container, key).
// * stringify() produces the canonical, diff-friendly layout:
//     - two spaces, trailing newline;
//     - objects: one member per line;
//     - arrays of scalars: on one line;
//     - other arrays: one element per line, each element written inline.

const lexemes = new WeakMap(); // container -> Map(key -> text)

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function isNumberLexeme(text) {
  return typeof text === 'string' && NUMBER_RE.test(text);
}

/** Text of a number as JavaScript writes it (shortest round-trip form). */
function jsNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('NaN and Infinity cannot be stored');
  }
  return Object.is(value, -0) ? '0' : String(value);
}

export function getLexeme(container, key) {
  const map = lexemes.get(container);
  return map ? map.get(String(key)) : undefined;
}

export function setLexeme(container, key, text) {
  let map = lexemes.get(container);
  if (!map) lexemes.set(container, (map = new Map()));
  if (text === undefined || text === null) map.delete(String(key));
  else map.set(String(key), String(text));
}

/**
 * Store a number typed by a person: container[key] becomes the numeric value
 * and the typed text is remembered.  Returns false if text is not a number.
 */
export function setNumber(container, key, text) {
  const t = String(text).trim();
  if (!isNumberLexeme(t)) return false;
  container[key] = Number(t);
  setLexeme(container, key, t);
  return true;
}

/** How container[key] is written: the remembered text if it still applies. */
export function numberText(container, key) {
  const value = container[key];
  const lex = getLexeme(container, key);
  if (lex !== undefined && isNumberLexeme(lex) && Number(lex) === value) return lex;
  return jsNumber(value);
}

/** Digits after the decimal point in the written form of container[key]. */
export function decimals(container, key) {
  return decimalsOfText(numberText(container, key));
}

function decimalsOfText(text) {
  const m = /^-?\d+(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m) return 0;
  return Math.max(0, (m[1] || '').length - Number(m[2] || 0));
}

function copyLexemes(from, to, keys) {
  const map = lexemes.get(from);
  if (!map) return;
  for (const key of keys) {
    const k = String(key);
    if (map.has(k)) setLexeme(to, k, map.get(k));
  }
}

/** Deep copy that keeps the written form of numbers. */
export function clone(value) {
  if (Array.isArray(value)) {
    const out = value.map(clone);
    copyLexemes(value, out, value.keys());
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    copyLexemes(value, out, Object.keys(value));
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

class JsonSyntaxError extends SyntaxError {
  constructor(message, text, index) {
    const before = text.slice(0, index);
    const line = before.split('\n').length;
    const column = index - before.lastIndexOf('\n');
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'JsonSyntaxError';
    this.index = index;
    this.line = line;
    this.column = column;
  }
}

const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

export function parse(text) {
  if (typeof text !== 'string') throw new TypeError('parse() needs a string');
  let i = 0;
  const fail = (message, at = i) => { throw new JsonSyntaxError(message, text, at); };
  const skip = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };

  function parseString() {
    const start = i;
    i++; // opening quote
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string', start);
      const c = text[i];
      if (c === '"') { i++; return out; }
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (e in ESCAPES) {
          out += ESCAPES[e];
          i += 2;
        } else {
          fail('invalid escape sequence');
        }
      } else if (c < ' ') {
        fail('control character in string (use \\n for a line break)');
      } else {
        out += c;
        i++;
      }
    }
  }

  function parseNumber() {
    const m = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    m.lastIndex = i;
    const found = m.exec(text);
    if (!found) fail('unexpected character');
    i += found[0].length;
    const value = Number(found[0]);
    if (!Number.isFinite(value)) fail('number out of range', i - found[0].length);
    return { value, lexeme: found[0] };
  }

  function parseValue(container, key) {
    skip();
    if (i >= text.length) fail('unexpected end of file');
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === '-' || (c >= '0' && c <= '9')) {
      const n = parseNumber();
      if (container) setLexeme(container, key, n.lexeme);
      return n.value;
    }
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) { i += word.length; return value; }
    }
    return fail('unexpected character');
  }

  function parseObject() {
    const out = {};
    i++;
    skip();
    if (text[i] === '}') { i++; return out; }
    for (;;) {
      skip();
      if (text[i] !== '"') fail('expected a member name in double quotes');
      const key = parseString();
      skip();
      if (text[i] !== ':') fail("expected ':'");
      i++;
      const value = parseValue(out, key);
      Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
      skip();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return out; }
      fail("expected ',' or '}'");
    }
  }

  function parseArray() {
    const out = [];
    i++;
    skip();
    if (text[i] === ']') { i++; return out; }
    for (;;) {
      out.push(parseValue(out, out.length));
      skip();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return out; }
      fail("expected ',' or ']'");
    }
  }

  const value = parseValue(null, null);
  skip();
  if (i < text.length) fail('unexpected text after the end of the document');
  return value;
}

// ---------------------------------------------------------------------------
// serialiser
// ---------------------------------------------------------------------------

const isScalar = (v) => v === null || typeof v !== 'object';

function scalar(value, container, key) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return numberText(container, key);
  throw new TypeError(`cannot serialise ${typeof value}`);
}

function inline(value, container, key) {
  if (Array.isArray(value)) {
    return '[' + value.map((v, i) => inline(v, value, i)).join(', ') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return '{' + keys.map((k) => `${JSON.stringify(k)}: ${inline(value[k], value, k)}`).join(', ') + '}';
  }
  return scalar(value, container, key);
}

function block(value, level, container, key) {
  const pad = '  '.repeat(level + 1);
  const end = '  '.repeat(level);
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return inline(value, container, key);
    return '[\n' + value.map((v, i) => pad + inline(v, value, i)).join(',\n') + '\n' + end + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return '{\n' + keys.map((k) => `${pad}${JSON.stringify(k)}: ${block(value[k], level + 1, value, k)}`)
      .join(',\n') + '\n' + end + '}';
  }
  return scalar(value, container, key);
}

function compactValue(value, container, key) {
  if (Array.isArray(value)) return '[' + value.map((v, i) => compactValue(v, value, i)).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${compactValue(value[k], value, k)}`)
      .join(',') + '}';
  }
  return scalar(value, container, key);
}

/** Text without spaces and with sorted keys (numbers as written): the input of content hashes. */
export function compact(value) {
  return compactValue(value, [value], 0);
}

/** Serialise in the canonical muND layout (with trailing newline). */
export function stringify(value) {
  const holder = [value];
  return block(value, 0, holder, 0) + '\n';
}
