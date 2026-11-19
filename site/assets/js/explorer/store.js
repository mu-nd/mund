// Loading of the built data (data/versions.json, data/<version>/...) for the
// public pages.  What the pages make of the files is in model.js.

import { siteUrl, fetchJson, fetchText } from '../core/site.js';
import * as jsonfmt from '../core/jsonfmt.js';
import { buildVersion, expectFormat, MANIFEST_FORMATS } from './model.js';
import { checkManifest } from './versioning.js';

export const loadVersions = () => fetchJson(siteUrl('data/versions.json'));

const cache = new Map();

/**
 * Everything the pages need for one version of the data (loaded once per
 * version); `entry` is its entry in data/versions.json.  See model.js.
 */
export function loadVersion(entry) {
  if (!cache.has(entry.label)) cache.set(entry.label, load(entry));
  return cache.get(entry.label);
}

async function load(entry) {
  const root = `data/${entry.label}/`;
  const [manifest, master, ltText] = await Promise.all([
    fetchJson(siteUrl(`${root}manifest.json`)),
    fetchJson(siteUrl(`${root}master.json`)),
    fetchText(siteUrl(`${root}LT.json`)),      // as text: the numbers keep their written digits
  ]);
  checkManifest(entry, expectFormat(manifest, MANIFEST_FORMATS));
  return buildVersion({ label: entry.label, manifest, master, lt: jsonfmt.parse(ltText) });
}

const csvCache = new Map();

/** csv/LT.csv of a version, as text (fetched when first needed). */
export function loadCsv(version) {
  if (!csvCache.has(version.label)) {
    const text = fetchText(siteUrl(`${version.root}csv/LT.csv`));
    text.catch(() => csvCache.delete(version.label));
    csvCache.set(version.label, text);
  }
  return csvCache.get(version.label);
}
