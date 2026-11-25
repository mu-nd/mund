// Downloads (downloads/): the files of the version shown.

import { h, replace, card, externalLink, pageHeading } from '../core/dom.js';
import { siteUrl } from './site.js';
import { pageUrl } from './route.js';
import { citeSection } from './citebox.js';
import { CODES, CODE_TITLES } from '../core/vocabulary.js';

/** What a published file holds (one short note per file; the files under raw/ share the note of their group). */
function fileNote(path) {
  let m;
  if (path === 'manifest.json') return 'The files below, with SHA-256 checksums';
  if (path === 'master.json') return 'Facilities, nuclides, Huff factors and constants';
  if ((m = /^([A-Z]+)\.json$/.exec(path))) return `All ${m[1]} data in one file`;
  if ((m = /^csv\/([A-Z]+)\.csv$/.exec(path))) return `All ${m[1]} data as a table, with the converted quantities`;
  if ((m = /^csv\/[A-Z]+_([A-Z]+)\.csv$/.exec(path))) return `${CODE_TITLES[m[1]] || m[1]} data only`;
  if ((m = /^raw\/master\/(\w+)\.json$/.exec(path))) return (m[1][0].toUpperCase() + m[1].slice(1)).replace(/_/g, ' ');
  return '';
}

/** The files in the order of the manifest, the tables of one dataset type (csv/LT_<CODE>.csv) in the order of CODES. */
function ordered(files) {
  const code = (f) => (/^csv\/[A-Z]+_([A-Z]+)\.csv$/.exec(f.path) || [])[1];
  const rank = (f) => CODES.indexOf(code(f));
  const tables = files.filter(code).sort((a, b) => rank(a) - rank(b));
  return files.map((f) => (code(f) ? tables.shift() : f));
}

function bytes(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)} MB`;
  if (n >= 1000) return `${Math.round(n / 1000)} kB`;
  return `${n} B`;
}

export function renderDownloads(root, ctx) {
  const { version, config, versionChoice = null } = ctx;
  const m = version.manifest;
  const url = (path) => siteUrl(`${version.root}${path}`);
  const repo = `https://github.com/${config.repository}`;
  const fileRow = ({ path, bytes: size = null }) => {
    const note = fileNote(path);
    return h('tr', null,
      h('td', null, h('a', { href: url(path) }, path), note ? h('div', { class: 'small muted' }, note) : null),
      h('td', { class: 'num' }, size === null ? '' : bytes(size)));
  };
  const files = ordered(m.files);
  const raw = files.filter((f) => f.path.startsWith('raw/'));

  replace(root,
    pageHeading('Downloads', versionChoice),
    card({
      title: 'Files',
      controls: [
        h('span', { class: 'small muted' }, m.date ? m.date.slice(0, 10) : null,
          m.date && m.commit ? ' · ' : null,
          m.commit ? externalLink(`${repo}/commit/${m.commit}`, h('code', null, m.commit.slice(0, 7))) : null),
        h('span', { class: 'small' }, externalLink(`${repo}/blob/${config.branch}/CHANGELOG.md`, 'Change log')),
        h('a', { class: 'btn primary', href: url(m.archive.path) }, `Download everything (.zip, ${bytes(m.archive.bytes)})`),
      ],
    },
      h('div', { class: 'table-wrap' }, h('table', { class: 'data files' },
        h('thead', null, h('tr', null, h('th', null, 'File'), h('th', { class: 'num' }, 'Size'))),
        h('tbody', null, [{ path: 'manifest.json' }, ...files.filter((f) => !raw.includes(f))].map(fileRow)),
        raw.length ? h('tbody', null,
          h('tr', null, h('th', { colspan: 2, scope: 'rowgroup', class: 'small' },
            h('code', null, 'raw/'), ' – the source files as stored')),
          raw.map(fileRow)) : null)),
      h('div', { class: 'card-body small muted' }, 'File formats: ',
        h('a', { href: siteUrl('schema/v1/lt.schema.json') }, 'JSON Schema for raw LT publication files'), ' · ',
        h('a', { href: `${pageUrl('docs/data-format')}#6-published-files` }, 'aggregate LT.json format'),
        ' · ', h('a', { href: `${pageUrl('docs/data-format')}#csv-columns` }, 'CSV columns'),
        ' · ', h('a', { href: pageUrl('docs/identifiers') }, 'definition of the identifiers'),
        ' · ', h('a', { href: pageUrl('api') }, 'API: the data as JSON files, one nuclide or entry per file'))),
    citeSection(config, version));
}
