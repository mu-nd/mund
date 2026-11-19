// Names and citation texts derived from a bibliography entry
// (twin of tools/mundlib/cite.py).
//
// A bibliography entry is a cached subset of the Crossref record of a DOI and
// uses Crossref's member names:
//   { "DOI": "...", "author": [{ "family": "...", "given": "..." }], "title": ["..."],
//     "container-title": ["..."], "short-container-title": ["..."], "volume": "...",
//     "page": "...", "article-number": "...", "published": { "date-parts": [[1987, 6, 1]] } }

const PLACEHOLDER_DOI_PREFIX = '10.1000/';

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

/** Readable part of a file name: 'Suzuki1987' (the MetaID that follows it identifies the file). */
export function fileLabel(meta, reference) {
  const family = asciiLabel(firstAuthor(reference));
  const year = referenceYear(reference);
  if (family && year) return `${family}${year}`;
  if (family) return family;
  const tail = String((meta && meta.bibId) || '').split('/').pop();
  return asciiLabel(tail) || 'file';
}

export function isPlaceholderDoi(doi) {
  return String(doi || '').toLowerCase().startsWith(PLACEHOLDER_DOI_PREFIX);
}

/** 'Suzuki1987' style label. */
export function citeLabel(reference, bibId = '') {
  const family = firstAuthor(reference);
  const year = referenceYear(reference);
  if (family && year) return `${family}${year}`;
  return family || String(bibId || '');
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

/** Link target of a DOI (none for placeholders). */
export function doiUrl(doi) {
  if (!doi || isPlaceholderDoi(doi)) return null;
  return `https://doi.org/${String(doi).split('/').map(encodeURIComponent).join('/')}`;
}
