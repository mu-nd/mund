// The site's own files: their addresses and how they are fetched.

const root = new URL('../../../', import.meta.url);

/** Absolute address of a path below the site root ('', 'data/latest/LT.json' ...). */
export const siteUrl = (path) => new URL(path, root).href;

export async function fetchText(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

export async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

/**
 * site/config.json: { repository, branch, siteUrl, paper, data, dataLicence }; `paper` and `data` are
 * what is cited (as in CITATION.cff).
 */
export const loadConfig = () => fetchJson(siteUrl('config.json'));
