// Loading of the built data (api/versions.json, data/<version>/...) for the
// public pages.  What the pages make of the files is in model.js.

import { siteUrl, fetchJson, fetchText } from './site.js';
import { sha256 } from '../core/sha256.js';
import * as jsonfmt from '../core/jsonfmt.js';
import { buildVersion, checkManifest } from './model.js';

export const loadVersions = () => fetchJson(siteUrl('api/versions.json'));

/**
 * Everything the pages need for one version of the data; `entry` is its entry
 * in api/versions.json.  See model.js.
 */
export async function loadVersion(entry, page) {
  const root = `data/${entry.label}/`;
  const [manifest, master, ltText] = await Promise.all([
    fetchJson(siteUrl(`${root}manifest.json`)),
    page === 'downloads' ? undefined : fetchJson(siteUrl(`${root}master.json`)),
    page === 'downloads' || page === 'tools/converter' ? undefined : fetchText(siteUrl(`${root}LT.json`)),
  ]);
  checkManifest(entry, manifest);
  const version = buildVersion({ label: entry.label, manifest, master, lt: ltText === undefined ? undefined : jsonfmt.parse(ltText) });
  if (ltText === undefined) return version;
  version.checkExportSource = () => {
    if (master.version !== manifest.version) throw reloadError('master.json');
    checkFile(manifest, 'LT.json', ltText);
  };
  return version;
}

const reloadError = (path) => new Error(`${path} does not match the displayed version. Reload the page before downloading.`);

function checkFile(manifest, path, text) {
  const file = manifest.files.find((f) => f.path === path);
  if (!file || sha256(text) !== file.sha256) throw reloadError(path);
  return text;
}

const csvCache = new WeakMap();

/** csv/LT.csv of a version, as text (fetched when first needed). */
export function loadCsv(version) {
  if (!csvCache.has(version)) {
    const path = 'csv/LT.csv';
    const text = fetchText(siteUrl(version.root + path)).then((csv) => checkFile(version.manifest, path, csv));
    text.catch(() => csvCache.delete(version));
    csvCache.set(version, text);
  }
  return csvCache.get(version);
}
