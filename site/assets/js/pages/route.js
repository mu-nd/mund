// The addresses of the pages.  Every page is a folder of the site:
//
//   <site>/                      Home
//   <site>/explorer/?v=<version>&z=14&a=28&ds=EXP,CUR&q=lifetime&id=<datasetId>
//   <site>/downloads/?v=<version>
//   <site>/tools/converter/?v=<version>&z=14
//   <site>/docs/…  <site>/api/   documents (made from docs/*.md when the site is built)
//
//   v                 data version (a label of api/versions.json); the pages
//                     that show data add it to the address when it is missing,
//                     so that the address always names the version shown, and
//                     the links between the pages keep it
//   z, a, ds, q, id   state of the explorer (element, mass number, dataset
//                     codes, quantity of the chart, selected data entry)

import { siteUrl } from './site.js';
import { CODES } from '../core/vocabulary.js';

export const query = () => new URLSearchParams(location.search);

/** The page shown ('' for Home, 'docs/data-format' …): its folder, written into <body data-page> by the build. */
export const currentPage = () => document.body.dataset.page || '';

/** Folder of a page below the site root. */
const pagePath = (key) => (key ? `${key}/` : '');

/** Whether a parameter is written into an address: null, undefined and '' are left out. */
const present = (value) => value !== null && value !== undefined && value !== '';

/** Absolute address of a page with query parameters. */
export function pageUrl(key, params = {}) {
  const text = new URLSearchParams(Object.entries(params)
    .filter(([, value]) => present(value))
    .map(([name, value]) => [name, String(value)])).toString();
  return siteUrl(pagePath(key)) + (text ? `?${text}` : '');
}

/** The target of the skip link: not a section of the page, so the addresses the pages build leave it out. */
const SKIP_TARGET = '#main';

/** The current address with some parameters replaced; a value that is not present removes one. */
export function urlWith(patch) {
  const params = query();
  for (const [name, value] of Object.entries(patch)) {
    if (present(value)) params.set(name, String(value));
    else params.delete(name);
  }
  const text = params.toString();
  return `${location.pathname}${text ? `?${text}` : ''}${location.hash === SKIP_TARGET ? '' : location.hash}`;
}

/** The parameter ds for a Set of dataset codes (null when all are chosen). */
export const dsParam = (kinds) => (kinds.size === CODES.length ? null : CODES.filter((d) => kinds.has(d)).join(','));

/** The current page for another data version. */
export const versionUrl = (label) => urlWith({ v: label, id: null });

/** A page in the version the current address names (none: the default version). */
export const pageLink = (key, params = {}) => pageUrl(key, { v: query().get('v'), ...params });

/** Absolute address of the explorer for one data version (citations and permalinks). */
export const explorerPermalink = (label, params = {}) => pageUrl('explorer', { v: label, ...params });
