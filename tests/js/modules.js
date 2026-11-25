// The entry point of the JavaScript tests: the modules under test, how a runner
// loads them and registers the suites, and the support code the suites share.
// A runner (index.html in a browser, run-node.mjs in Node) adds only its file
// access (`env`) and its report.
//
// CORE and PAGES lie below site/assets/js/ (in the built site /assets/js/),
// ADMIN below admin/js/, which is not published: its tests run in Node only.

export const CORE = ['core/sha256', 'core/ids', 'core/jsonfmt', 'core/schema', 'core/database', 'core/cite',
  'core/convert', 'core/format', 'core/nuclides', 'core/vocabulary'];
export const PAGES = ['pages/model', 'pages/selection', 'pages/route', 'pages/converter', 'pages/chart'];
export const ADMIN = ['backend', 'workspace', 'diff', 'document', 'release', 'i18n'];

/**
 * {file name: module} of the given modules of the folder `base` (a URL or path ending in '/').  Each
 * address takes the query of this file's own (the ?v= the build adds to every import), so that the
 * modules under test are the instances the other modules import.
 */
export async function load(base, names) {
  const query = import.meta.url.replace(/^[^?]*/, '');
  const modules = {};
  for (const name of names) modules[name.split('/').pop()] = await import(`${base}${name}.js${query}`);
  return modules;
}

/** Registers the tests of each suite (the `register` function of a suite file); returns the harness. */
export function registerAll(h, modules, env, suites) {
  for (const register of suites) register(h, modules, env);
  return h;
}

export const support = {
  /** {file name: text} of the given files of schema/v1. */
  async schemas(env, names) {
    const texts = {};
    for (const name of names) texts[name] = await env.text('schema', name);
    return texts;
  },

  /** A Database with the schemas and the given {path: text} files. */
  async testDatabase(modules, env, files = {}) {
    const { schema, database } = modules;
    const schemas = {};
    for (const [name, text] of Object.entries(await support.schemas(env, Object.values(schema.SCHEMA_FILES)))) {
      schemas[name] = JSON.parse(text);
    }
    const db = new database.Database(schemas);
    for (const [path, text] of Object.entries(files)) db.setFile(path, text);
    return db;
  },
};
