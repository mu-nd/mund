// Downloads (downloads/): the files of every version.

import { h, replace, card, externalLink, pageHeading } from '../core/dom.js';
import { siteUrl } from '../core/site.js';
import { versionUrl, pageUrl, pageLink } from './route.js';
import { isRelease } from './versioning.js';
import { citeSection } from './citebox.js';
import { CODE_TITLES } from '../core/vocabulary.js';

/** What a published file holds (one short note per file). */
function fileNote(path) {
  const masters = { bibliography: 'Bibliography', facilities: 'Facilities', huff_factors: 'Huff factors', nuclides: 'Nuclides', constants: 'Constants' };
  let m;
  if (path === 'manifest.json') return 'The files below, with SHA-256 checksums';
  if (path === 'master.json') return 'Facilities, nuclides, Huff factors and constants';
  if ((m = /^([A-Z]+)\.json$/.exec(path))) return `All ${m[1]} data in one file`;
  if ((m = /^csv\/([A-Z]+)\.csv$/.exec(path))) return `All ${m[1]} data as a table, with the converted quantities`;
  if ((m = /^csv\/[A-Z]+_([A-Z]+)\.csv$/.exec(path))) return `${CODE_TITLES[m[1]] || m[1]} data only`;
  if ((m = /^raw\/master\/(\w+)\.json$/.exec(path))) return masters[m[1]] || 'Master table';
  return path.startsWith('raw/') ? 'Source file, as stored' : '';
}

function bytes(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

export function renderDownloads(root, ctx) {
  const { version, versions, config, versionChoice = null } = ctx;
  const m = version.manifest;
  const url = (path) => siteUrl(`${version.root}${path}`);
  const repo = `https://github.com/${config.repository}`;
  const fileRow = (path, size) => h('tr', null,
    h('td', null, h('a', { href: url(path) }, path)),
    h('td', { class: 'num' }, size === null ? '' : bytes(size)),
    h('td', { class: 'small muted' }, fileNote(path)));
  const code = (text) => h('code', null, text);

  replace(root,
    pageHeading('Downloads', versionChoice),
    card({ title: 'Versions' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Version'), h('th', null, 'Kind'), h('th', null, 'Date'), h('th', null, 'Commit'))),
        h('tbody', null, versions.versions.map((v) => {
          const name = h('strong', null, isRelease(v) ? `v${v.version}` : v.label);
          // the version shown is highlighted; the others are links to them
          return h('tr', { 'aria-selected': String(v.label === version.label) },
            h('td', null, v.label === version.label ? name : h('a', { href: versionUrl(v.label) }, name),
              isRelease(v) ? null : h('span', { class: 'muted small' }, ` ${v.version}`)),
            h('td', null, isRelease(v) ? 'Stable version' : 'Development version'),
            h('td', { class: 'nowrap' }, v.date ? v.date.slice(0, 10) : '–'),
            h('td', null, v.commit ? externalLink(`${repo}/commit/${v.commit}`, h('code', null, v.commit.slice(0, 7))) : '–'));
        })))),
      h('div', { class: 'card-body small' }, externalLink(`${repo}/blob/${config.branch}/CHANGELOG.md`, 'Change log'))),
    card({
      title: `Files of ${isRelease(m) ? `v${m.version}` : `the development version ${m.version}`}`,
      controls: h('a', { class: 'btn primary', href: url(m.archive.path) }, `Download everything (.zip, ${bytes(m.archive.bytes)})`),
    },
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'File'), h('th', { class: 'num' }, 'Size'), h('th', null, 'Content'))),
        h('tbody', null, fileRow('manifest.json', null), m.files.map((f) => fileRow(f.path, f.bytes))))),
      h('div', { class: 'card-body small muted' }, 'File formats: ',
        h('a', { href: siteUrl('schema/v1/lt.schema.json') }, 'JSON Schema of the LT files'), ' · ',
        h('a', { href: pageUrl('docs/data-format') }, 'description of the format'),
        ' · ', h('a', { href: pageUrl('docs/identifiers') }, 'definition of the identifiers'),
        ' · ', h('a', { href: pageUrl('api') }, 'API: the data as JSON files, one nuclide or entry per file'))),
    card({ title: 'Columns of the CSV files' },
      h('div', { class: 'card-body prose' },
        h('p', null, 'One row per data entry. ', code('observable'), ' names the quantity given in the source; ',
          code('value'), ', ', code('uncertainty'), ', ', code('uncertaintyStatistical'), ', ', code('uncertaintySystematic'),
          ' and ', code('unit'), ' are that quantity as given in the source. An uncertainty the source does not give is left empty.'),
        h('p', null, code('lifetime_ns'), ', ', code('capture_rate_us-1'), ', ', code('capture_probability_pct'),
          ' and their ', code('_unc'), ' columns are converted from it with the Huff factor ', code('huff_factor'),
          ' (', code('huff_source'), ': where it comes from); see the ', h('a', { href: pageLink('tools/converter') }, 'Converter'), '.'),
        h('p', { class: 'small muted' }, 'The CSV download of a selection in the Explorer has the same columns.'))),
    citeSection(config, version));
  document.title = 'Downloads – Muon Nuclear Data';
}
