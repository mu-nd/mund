// A very small test harness shared by the browser page (index.html) and the
// Node runner (run-node.mjs).  No dependencies.

export class Harness {
  constructor() {
    this.tests = [];
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run(report = () => {}) {
    const results = [];
    for (const { name, fn } of this.tests) {
      const result = { name, ok: true, error: null, checks: 0 };
      const t = makeAsserts(result);
      try {
        await fn(t);
      } catch (err) {
        result.ok = false;
        result.error = err && err.stack ? String(err.stack) : String(err);
      }
      results.push(result);
      report(result);
    }
    return results;
  }
}

function show(v) {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 300 ? `${s.slice(0, 300)}...` : s;
  } catch (e) {
    return String(v);
  }
}

// Compare arrays and plain records by their own keys.
function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  } else if (![a, b].every((v) => [null, Object.prototype].includes(Object.getPrototypeOf(v)))) {
    return false;
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
}

function makeAsserts(result) {
  const fail = (message) => { throw new Error(message); };
  return {
    ok(cond, message = 'expected a true value') {
      result.checks++;
      if (!cond) fail(message);
    },
    equal(actual, expected, message = '') {
      result.checks++;
      if (actual !== expected) fail(`${message} expected ${show(expected)} but got ${show(actual)}`);
    },
    deepEqual(actual, expected, message = '') {
      result.checks++;
      if (!sameValue(actual, expected)) {
        fail(`${message} expected ${show(expected)} but got ${show(actual)}`);
      }
    },
    close(actual, expected, tolerance = 1e-9, message = '') {
      result.checks++;
      if (!Number.isFinite(actual) || !Number.isFinite(expected)) fail(`${message} expected finite numbers`);
      const scale = Math.max(Math.abs(expected), 1e-300);
      if (!(Math.abs(actual - expected) / scale <= tolerance)) {
        fail(`${message} expected ${expected} but got ${actual}`);
      }
    },
    throws(fn, message = 'expected an exception') {
      result.checks++;
      let thrown = false;
      try { fn(); } catch (e) { thrown = true; }
      if (!thrown) fail(message);
    },
  };
}
