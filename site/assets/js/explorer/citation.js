// How to cite the project paper and a version of the database, in the style
// of Physical Review (APS, the usual style in nuclear physics) and in BibTeX:
// the boxes of "How to cite" and of an entry, and the `citation` of a JSON
// download (the API writes the same texts: tools/mundlib/api.py).
// What is cited comes from site/config.json (`paper`, `data`), the same
// metadata as CITATION.cff; the version from its manifest.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Physical Review lists up to ten authors; with more, the first one and "et al." */
const MAX_NAMES = 10;

/** 'Yukinobu' -> 'Y.', 'Jean-Pierre' -> 'J.-P.', 'T. Y.' -> 'T. Y.' */
export function initials(given) {
  return String(given || '').split(/\s+/).filter(Boolean)
    .map((word) => word.split('-').map((part) => `${part[0]}.`).join('-')).join(' ');
}

/** Authors as in Physical Review: 'Y. Watanabe', 'A and B', 'A, B, and C', 'A et al.' */
function apsAuthors(authors) {
  const names = authors.map((a) => `${initials(a.given)} ${a.family}`);
  if (names.length > MAX_NAMES) return `${names[0]} et al.`;
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

const bibtexEntry = (type, key, fields) => `@${type}{${key},\n${fields
  .filter(([, value]) => value !== null && value !== undefined && value !== '')
  .map(([name, value]) => `  ${name} = ${value}`).join(',\n')}\n}`;

/**
 * The project paper (config.paper: title, authors [{family, given}], year, url,
 * arxiv, primaryClass).  Returns { APS, BibTeX }.
 */
export function paperCitations(paper) {
  const where = paper.arxiv ? `arXiv:${paper.arxiv}` : paper.url;
  return {
    APS: `${apsAuthors(paper.authors)}, ${paper.title}, ${where} (${paper.year}).`,
    BibTeX: bibtexEntry('misc', `${paper.authors[0].family}${paper.year}`, [
      ['author', `{${paper.authors.map((a) => `${a.family}, ${a.given}`).join(' and ')}}`],
      ['title', `{{${paper.title}}}`],
      ['year', `{${paper.year}}`],
      ['eprint', paper.arxiv ? `{${paper.arxiv}}` : null],
      ['archivePrefix', paper.arxiv ? '{arXiv}' : null],
      ['primaryClass', paper.primaryClass ? `{${paper.primaryClass}}` : null],
      ['url', `{${paper.url}}`],
    ]),
  };
}

/**
 * A version of the database (config.data: title, author; manifest: version,
 * kind, commit, date, label), with the address that shows it.  The development
 * version is named with its commit and marked as not stable.
 * Returns { APS, BibTeX }.
 */
export function dataCitations(data, manifest, url) {
  const date = manifest.date ? String(manifest.date).slice(0, 10) : '';
  const year = date ? date.slice(0, 4) : '';
  const month = date ? MONTHS[Number(date.slice(5, 7)) - 1] : null;
  const release = manifest.kind === 'release';
  const commit = manifest.commit ? String(manifest.commit).slice(0, 7) : '';
  const note = `Development version${commit ? ` of commit ${commit}` : ''}; not a stable version`;
  const version = release ? `version ${manifest.version}` : `development version ${manifest.version}${commit ? `, commit ${commit}` : ''}, not a stable version`;
  return {
    APS: `${data.author}, ${data.title}, ${version}${year ? ` (${year})` : ''}, ${url}.`,
    BibTeX: bibtexEntry('misc', `muND_${manifest.label}`, [
      ['author', `{{${data.author}}}`],
      ['title', `{{${data.title}}}`],
      ['version', `{${manifest.version}}`],
      ['year', date ? `{${year}}` : null],
      ['month', month],
      ['howpublished', '{Data set}'],
      ['note', release ? null : `{${note}}`],
      ['url', `{${url}}`],
    ]),
  };
}

/**
 * Both citations as text in the style of Physical Review, for a file:
 * { paper, database } (paper null when config.paper has no authors).
 */
export function citationTexts(config, manifest, url) {
  return {
    paper: config.paper && config.paper.authors ? paperCitations(config.paper).APS : null,
    database: dataCitations(config.data, manifest, url).APS,
  };
}
