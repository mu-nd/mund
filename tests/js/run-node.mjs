// Run the tests of the browser code with Node (used by CI):  node tests/js/run-node.mjs
// tests/js/suite.js: the shared code of the site; tests/js/suite-pages.js: the pure
// modules of the pages; tests/admin/suite.js: the data entry tool.
// It also loads every module under site/assets/js and admin/js once, so that a parse or
// import error in a page module fails CI.
// Needs Node 24, as in CI; no packages to install.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Harness } from './harness.js';
import { ADMIN, CORE, PAGES, load, registerAll } from './modules.js';
import { register } from './suite.js';
import { register as registerPages } from './suite-pages.js';
import { register as registerAdmin } from '../admin/suite.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const modules = {
  ...await load(new URL('../../site/assets/js/', import.meta.url), [...CORE, ...PAGES]),
  ...await load(new URL('../../admin/js/', import.meta.url), ADMIN),
};

async function walk(dir, ext) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path, ext));
    else if (entry.name.endsWith(ext)) out.push(path);
  }
  return out.sort();
}

const base = { vectors: 'tests/vectors', schema: 'schema/v1' };
const env = {
  text: (kind, name) => readFile(join(root, base[kind], name), 'utf8'),
  async dataFiles() {
    const files = await walk(join(root, 'data'), '.json');
    return Promise.all(files.map(async (path) => ({
      path: relative(root, path).split(sep).join('/'), text: await readFile(path, 'utf8'),
    })));
  },
};

const h = registerAll(new Harness(), modules, env, [register, registerPages, registerAdmin]);
const results = await h.run((r) => {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name} (${r.checks} checks)`);
  if (!r.ok) console.log(r.error.split('\n').map((l) => `     ${l}`).join('\n'));
});
const failed = results.filter((r) => !r.ok).length;

// Every module of the site and of the data entry tool must load. The page modules need a
// browser to run. Syntax errors and missing modules fail this check.
let unloadable = 0;
for (const dir of ['site/assets/js', 'admin/js']) {
  for (const file of await walk(join(root, dir), '.js')) {
    try {
      await import(pathToFileURL(file).href);
    } catch (e) {
      if (e?.name !== 'SyntaxError' && e?.code !== 'ERR_MODULE_NOT_FOUND') continue;
      console.log(`FAIL load ${relative(root, file).split(sep).join('/')}: ${e.message}`);
      unloadable++;
    }
  }
}

console.log(`\n${results.length - failed} of ${results.length} tests passed`);
if (unloadable) console.log(`${unloadable} modules failed to load`);
process.exit(failed || unloadable ? 1 : 0);
