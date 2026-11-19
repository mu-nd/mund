// The addresses of the pages.  Every page is a folder of the site:
//
//   <site>/                      Home
//   <site>/explorer/?v=<version>&z=14&a=28&ds=EXP,CUR&q=lifetime&id=<datasetId>
//   <site>/downloads/?v=<version>
//   <site>/tools/converter/?v=<version>
//   <site>/docs/…  <site>/api/   documents (made from docs/*.md when the site is built)
//
//   v                 data version (a label of data/versions.json); the pages
//                     that show data add it to the address when it is missing,
//                     so that the address always names the version shown, and
//                     the links between the pages keep it
//   z, a, ds, q, id   state of the explorer (element, mass number, dataset
//                     codes, quantity of the chart, selected data entry)

import { siteUrl } from '../core/site.js';
import { CODES } from '../core/vocabulary.js';
import { permalink } from './versioning.js';

export const query = () => new URLSearchParams(location.search);

/** The page shown ('' for Home, 'docs/data-format' …): its folder, written into <body data-page> by the build. */
export const currentPage = () => document.body.dataset.page || '';

/** Folder of a page below the site root. */
const pagePath = (key) => (key ? `${key}/` : '');

/** Absolute address of a page with query parameters (null and '' are left out). */
export function pageUrl(key, params = {}) {
  const text = new URLSearchParams(Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([name, value]) => [name, String(value)])).toString();
  return siteUrl(pagePath(key)) + (text ? `?${text}` : '');
}

/** The current address with some parameters replaced; null or '' removes one. */
export function urlWith(patch) {
  const params = query();
  for (const [name, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') params.delete(name);
    else params.set(name, String(value));
  }
  const text = params.toString();
  return `${location.pathname}${text ? `?${text}` : ''}${location.hash}`;
}

/** The parameter ds for a Set of dataset codes (null when all are chosen). */
export const dsParam = (kinds) => (kinds.size === CODES.length ? null : CODES.filter((d) => kinds.has(d)).join(','));

/** The current page for another data version. */
export const versionUrl = (label) => urlWith({ v: label, id: null });

/** A page in the version the current address names (none: the default version). */
export const pageLink = (key, params = {}) => pageUrl(key, { v: query().get('v'), ...params });

/** Absolute address of the explorer for one data version (citations and permalinks). */
export const explorerPermalink = (label, params = {}) => permalink(pageUrl('explorer'), label, params);
