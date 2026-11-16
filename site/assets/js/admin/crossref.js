// Bibliographic data of a DOI, from Crossref (journal articles) or DataCite
// (arXiv, data repositories).  Only the DOI is sent.
//
// The result is a bibliography entry: a subset of the Crossref record with
// Crossref's member names (see schema/v1/bibliography.schema.json).

function clean(text) {
  return String(text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

const encodeDoi = (doi) => String(doi).trim().split('/').map(encodeURIComponent).join('/');

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const list = (value) => (Array.isArray(value) ? value : value ? [value] : []).map(clean).filter(Boolean);

export function fromCrossref(message, doi) {
  const ref = { DOI: doi };
  if (message.type) ref.type = String(message.type);
  const authors = (message.author || []).map((a) => {
    if (a.family) return a.given ? { family: clean(a.family), given: clean(a.given) } : { family: clean(a.family) };
    return a.name ? { name: clean(a.name) } : null;
  }).filter(Boolean);
  if (authors.length) ref.author = authors;
  for (const key of ['title', 'container-title', 'short-container-title']) {
    const values = list(message[key]);
    if (values.length) ref[key] = values;
  }
  for (const key of ['volume', 'issue', 'page', 'article-number']) {
    if (message[key]) ref[key] = String(message[key]);
  }
  const date = message.published || message['published-print'] || message['published-online'] || message.issued;
  const parts = date && Array.isArray(date['date-parts']) && Array.isArray(date['date-parts'][0])
    ? date['date-parts'][0].map(Number).filter(Number.isInteger) : [];
  if (parts.length) ref.published = { 'date-parts': [parts] };
  return ref;
}

export function fromDataCite(attributes, doi) {
  const ref = { DOI: doi };
  const kind = attributes.types && (attributes.types.resourceTypeGeneral || attributes.types.resourceType);
  if (kind) ref.type = String(kind).toLowerCase();
  const authors = (attributes.creators || []).map((c) => {
    if (c.familyName) return c.givenName ? { family: clean(c.familyName), given: clean(c.givenName) } : { family: clean(c.familyName) };
    return c.name ? { name: clean(c.name) } : null;
  }).filter(Boolean);
  if (authors.length) ref.author = authors;
  const title = clean(((attributes.titles || [])[0] || {}).title);
  if (title) ref.title = [title];
  const publisher = attributes.publisher && (typeof attributes.publisher === 'string' ? attributes.publisher : attributes.publisher.name);
  if (publisher) ref.publisher = clean(publisher);
  if (Number.isInteger(Number(attributes.publicationYear))) ref.published = { 'date-parts': [[Number(attributes.publicationYear)]] };
  return ref;
}

/** @returns {Promise<{reference: object, source: string} | null>} null when the DOI is unknown */
export async function lookupDoi(doi) {
  const id = encodeDoi(doi);
  const crossref = await getJson(`https://api.crossref.org/works/${id}`);
  if (crossref && crossref.message) return { reference: fromCrossref(crossref.message, doi), source: 'Crossref' };
  const datacite = await getJson(`https://api.datacite.org/dois/${id}`);
  if (datacite && datacite.data && datacite.data.attributes) {
    return { reference: fromDataCite(datacite.data.attributes, doi), source: 'DataCite' };
  }
  return null;
}
