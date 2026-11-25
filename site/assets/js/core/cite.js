// Names and citation texts of the sources, and how to cite the project paper and a version of
// the database (twin of tools/mundlib/cite.py; shared cases: tests/vectors/cite.json).
// Links to the sources and BibTeX are made in JavaScript only.
//
// The source of a metadata record (bibId) is named by its DOI ('DOI:10.1103/PhysRevC.35.2212');
// a source without one by its keynumber in Nuclear Science References ('NSR:1987SU06'); a
// source found in neither by a muND key ('muND:Suzuki1975thesis').
//
// A bibliography entry is found by its id, the bibId. It is a cached subset of the Crossref
// record of the source and uses Crossref's member names:
//   { "id": "DOI:...", "author": [{ "family": "...", "given": "..." }], "title": ["..."],
//     "container-title": ["..."], "short-container-title": ["..."], "volume": "...",
//     "page": "...", "article-number": "...", "published": { "date-parts": [[1987, 6, 1]] } }

/**
 * The forms of a bibId: prefix and pattern of the name. The bibId pattern of the schemas is
 * `^(DOI:name|NSR:name|muND:name)$` with these names; `$` is the end of the bibId.
 */
export const BIB_ID_FORMS = [
  ['DOI', '10\\.[0-9]{4,9}/[^\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff;|]+'],
  ['NSR', '[0-9]{4}[A-Za-z]{2}[A-Za-z0-9]{2}'],
  ['muND', '[A-Za-z0-9][A-Za-z0-9._-]*'],
];
const NAME_PATTERNS = new Map(BIB_ID_FORMS.map(([prefix, pattern]) => [prefix, new RegExp(`^(?:${pattern})$`)]));

const splitBibId = (bibId) => {
  const text = String(bibId || '').trim();
  const at = text.indexOf(':');
  return at < 0 ? ['', text] : [text.slice(0, at), text.slice(at + 1)];
};

/** 'DOI', 'NSR' or 'muND': the prefix of a valid bibId; '' when bibId has none of these forms. */
export function bibKind(bibId) {
  const [prefix, name] = splitBibId(bibId);
  const pattern = NAME_PATTERNS.get(prefix);
  return pattern && pattern.test(name) ? prefix : '';
}

/** Whether bibId has one of the forms DOI:, NSR: or muND:. */
export const isBibId = (bibId) => bibKind(bibId) !== '';

/** The part after the prefix: the DOI, the keynumber or the name of the muND key. */
export function bibName(bibId) {
  return bibKind(bibId) ? splitBibId(bibId)[1] : String(bibId || '').trim();
}

/** Fold Basic Latin, Latin-1, Latin Extended-A/B and Latin Extended Additional to ASCII. */
export function asciiLabel(text) {
  const latin = String(text).replace(/[^\x00-\u024f\u1e00-\u1eff]/gu, '');
  return latin.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '');
}

const first = (value) => (Array.isArray(value) ? (value.length ? String(value[0]) : '') : String(value || ''));
const authorsOf = (reference) => (reference && Array.isArray(reference.author)
  ? reference.author.filter((a) => a && typeof a === 'object') : []);
const nameOf = (author) => String(author.family || author.name || '');

export function firstAuthor(reference) {
  const authors = authorsOf(reference);
  return authors.length ? nameOf(authors[0]) : '';
}

export function referenceYear(reference) {
  const parts = reference && reference.published ? reference.published['date-parts'] : null;
  const year = Array.isArray(parts) && Array.isArray(parts[0]) ? Number(parts[0][0]) : NaN;
  return Number.isInteger(year) ? year : null;
}

export const referenceTitle = (reference) => (reference ? first(reference.title) : '');
const referenceJournal = (reference) => (reference
  ? first(reference['short-container-title']) || first(reference['container-title']) : '');

/**
 * Readable part of a file name: 'Suzuki1987'; without a bibliography entry the last part of
 * the name of the bibId (the MetaID that follows it identifies the file).
 */
export function fileLabel(meta, reference) {
  const family = asciiLabel(firstAuthor(reference));
  const year = referenceYear(reference);
  if (family && year) return `${family}${year}`;
  if (family) return family;
  const tail = bibName((meta && meta.bibId) || '').split('/').pop();
  return asciiLabel(tail) || 'file';
}

/** 'Suzuki1987' style label; without a bibliography entry the bibId ('unpublished' for muND:unpublished). */
export function citeLabel(reference, bibId = '') {
  const family = firstAuthor(reference);
  const year = referenceYear(reference);
  if (family && year) return `${family}${year}`;
  return family || (bibKind(bibId) === 'muND' ? bibName(bibId) : String(bibId || ''));
}

/** 'Suzuki et al., Phys. Rev. C 35, 2212 (1987)'. */
export function citeText(reference, bibId = '') {
  const ref = reference || {};
  const authors = authorsOf(ref).map(nameOf).filter(Boolean);
  if (!authors.length) return referenceTitle(ref) || String(bibId || '');
  let text = authors[0];
  if (authors.length === 2) text += ` and ${authors[1]}`;
  else if (authors.length > 2) text += ' et al.';
  const parts = [referenceJournal(ref), ref.volume].filter(Boolean);
  if (parts.length) text += `, ${parts.join(' ')}`;
  const location = ref['article-number'] || String(ref.page || '').split(/[-–]/)[0];
  if (location) text += `, ${location}`;
  const year = referenceYear(ref);
  if (year) text += ` (${year})`;
  return text;
}

/** Full author list: 'T. Suzuki, D. F. Measday and J. P. Roalsvig' (at most 12 names). */
export function authorList(reference) {
  const max = 12;
  const authors = authorsOf(reference).map((a) => [a.given, a.family || a.name].filter(Boolean).join(' '));
  if (authors.length > max) return `${authors.slice(0, max).join(', ')} et al.`;
  if (authors.length <= 1) return authors.join('');
  return `${authors.slice(0, -1).join(', ')} and ${authors[authors.length - 1]}`;
}

/** Link of a bibId: doi.org for a DOI, the NSR page for a keynumber; none for a muND key. */
export function bibUrl(bibId) {
  const kind = bibKind(bibId);
  const name = bibName(bibId);
  if (kind === 'DOI') return `https://doi.org/${name.split('/').map(encodeURIComponent).join('/')}`;
  if (kind === 'NSR') return `https://www.nndc.bnl.gov/nsr/?search-type=keynumber&key=${encodeURIComponent(name)}`;
  return null;
}

/** Where to read the source: the link of its bibId, or for a muND key the URL of its bibliography entry (none if neither). */
export function sourceUrl(bibId, reference) {
  const link = bibUrl(bibId);
  if (link) return link;
  const url = reference?.URL;
  // the rule of the bibliography schema
  return typeof url === 'string' && /^https?:\/\/\S+$/.test(url) ? url : null;
}

// How to cite the project paper and a version of the database, in the style of Physical Review
// (APS, the usual style in nuclear physics) and in BibTeX: the boxes of "How to cite" and of an
// entry, and the `citation` of a JSON download (the API writes the same APS texts). What is cited
// comes from site/config.json (`paper`, `data`), the same metadata as CITATION.cff; the version
// from its manifest.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Physical Review lists up to ten authors; with more, the first one and "et al." */
const MAX_NAMES = 10;

/** 'Yukinobu' -> 'Y.', 'Jean-Pierre' -> 'J.-P.', 'T. Y.' -> 'T. Y.' */
function initials(given) {
  return String(given || '').split(/\s+/).filter(Boolean)
    .map((word) => word.split('-').filter(Boolean).map((part) => `${String.fromCodePoint(part.codePointAt(0))}.`).join('-')).join(' ');
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
 * arxiv, primaryClass).  Returns { APS, BibTeX }; null when it has no authors.
 */
export function paperCitations(paper) {
  if (!paper || !Array.isArray(paper.authors) || !paper.authors.length) return null;
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
export function dataCitations(data, manifest, url, datasetId) {
  const date = manifest.date ? String(manifest.date).slice(0, 10) : '';
  const year = date ? date.slice(0, 4) : '';
  const month = date ? MONTHS[Number(date.slice(5, 7)) - 1] : null;
  const release = manifest.kind === 'release';
  const commit = manifest.commit ? String(manifest.commit).slice(0, 7) : '';
  const note = `Development version${commit ? ` of commit ${commit}` : ''}; not a stable version`;
  const version = release ? `version ${manifest.version}` : `development version ${manifest.version}${commit ? `, commit ${commit}` : ''}, not a stable version`;
  return {
    APS: `${data.author}, ${data.title}, ${version}${year ? ` (${year})` : ''}, ${url}.`,
    BibTeX: bibtexEntry('misc', `muND_${manifest.label}${datasetId ? `_${datasetId}` : ''}`, [
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
  const paper = paperCitations(config.paper);
  return { paper: paper ? paper.APS : null, database: dataCitations(config.data, manifest, url).APS };
}
