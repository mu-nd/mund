// Names, links and citation texts of the sources (twin of tools/mundlib/cite.py).
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

/** The prefix of each form of a bibId, with the form of the name after it. */
const BIB_ID_FORMS = [
  ['DOI', /^10\.[0-9]{4,9}\/[^\s;]+$/],
  ['NSR', /^[0-9]{4}[A-Za-z]{2}[A-Za-z0-9]{2}$/],
  ['muND', /^[A-Za-z0-9][A-Za-z0-9._-]*$/],
];

const splitBibId = (bibId) => {
  const text = String(bibId || '').trim();
  const at = text.indexOf(':');
  return at < 0 ? ['', text] : [text.slice(0, at), text.slice(at + 1)];
};

/** 'DOI', 'NSR' or 'muND': the prefix of a valid bibId; '' when bibId has none of these forms. */
export function bibKind(bibId) {
  const [prefix, name] = splitBibId(bibId);
  const found = BIB_ID_FORMS.find(([p, pattern]) => p === prefix && pattern.test(name));
  return found ? found[0] : '';
}

/** The part after the prefix: the DOI, the keynumber or the name of the muND key. */
export function bibName(bibId) {
  return bibKind(bibId) ? splitBibId(bibId)[1] : String(bibId || '').trim();
}

/** ASCII letters and digits of a text (accents removed). */
export function asciiLabel(text) {
  return String(text).normalize('NFKD').replace(/[^A-Za-z0-9]/g, '');
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
  const authors = authorsOf(ref);
  if (!authors.length) return referenceTitle(ref) || String(bibId || '');
  let text = nameOf(authors[0]);
  if (authors.length === 2) text += ` and ${nameOf(authors[1])}`;
  else if (authors.length > 2) text += ' et al.';
  const parts = [referenceJournal(ref), ref.volume].filter(Boolean);
  if (parts.length) text += `, ${parts.join(' ')}`;
  const pages = ref['article-number'] || ref.page;
  if (pages) text += `, ${String(pages).split(/[-–]/)[0]}`;
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
  return bibUrl(bibId) || (reference && reference.URL) || null;
}
