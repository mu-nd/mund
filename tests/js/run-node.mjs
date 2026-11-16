// Run the browser-code tests with Node (used by CI):  node tests/js/run-node.mjs
// Needs Node 20 or newer; no packages to install.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Harness } from './harness.js';
import { register } from './suite.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const modulePath = (dir, name) => new URL(`../../site/assets/js/${dir}/${name}.js`, import.meta.url).href;
const core = {};
for (const name of ['sha256', 'ids', 'jsonfmt', 'schema', 'checks', 'cite', 'convert', 'format']) {
  core[name] = await import(modulePath('core', name));
}
for (const name of ['backend', 'workspace', 'diff', 'paste']) {
  core[name] = await import(modulePath('admin', name));
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.name.endsWith('.json')) out.push(path);
  }
  return out.sort();
}

const base = { vectors: 'tests/vectors', schema: 'schema/v1', master: 'data/master' };
const env = {
  text: (kind, name) => readFile(join(root, base[kind], name), 'utf8'),
  fakeGitHub: () => import('./fake-github.js'),
  async dataFiles() {
    const files = await walk(join(root, 'data'));
    return Promise.all(files.map(async (path) => ({
      path: relative(root, path).split(sep).join('/'), text: await readFile(path, 'utf8'),
    })));
  },
};

const h = new Harness();
register(h, core, env);
const results = await h.run((r) => {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name} (${r.checks} checks)`);
  if (!r.ok) console.log(r.error.split('\n').map((l) => `     ${l}`).join('\n'));
});
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} tests passed`);
process.exit(failed ? 1 : 0);
