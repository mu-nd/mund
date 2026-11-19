// Data versions on the pages: which version an address asks for, how a
// version is named, and the permalinks, which always name the version
// explicitly (the citation texts: citation.js).
//
// `versions` is data/versions.json: { default, versions: [{label, version, kind, commit, date}] }.
// kind "release": a stable version, fixed; kind "development": the development
// version, built from the current main branch (label "latest").

/**
 * The version an address asks for.  No `requested` label: the default
 * version.  A label that is not in the list is an error; another version is
 * never shown in its place.
 * @returns {{label: string|null, entry: object|null, error: string|null}}
 */
export function resolveVersion(versions, requested) {
  const list = versions && Array.isArray(versions.versions) ? versions.versions : [];
  const asked = requested !== null && requested !== undefined && requested !== '';
  const label = asked ? String(requested) : versions && versions.default;
  const entry = list.find((v) => v.label === label) || null;
  if (entry) return { label, entry, error: null };
  return {
    label: null,
    entry: null,
    error: asked ? `There is no data version “${label}”.` : `The default data version “${label}” is not in the list of versions.`,
  };
}

/** The files of a version must describe the version that was asked for. */
export function checkManifest(entry, manifest) {
  if (manifest.label !== entry.label || manifest.version !== entry.version) {
    throw new Error(`the files of “${entry.label}” are those of ${manifest.label} ${manifest.version}, `
      + `not of version ${entry.version}`);
  }
  return manifest;
}

export const isRelease = (entry) => entry.kind === 'release';

/** 'version 1.0.0' or 'development version 1.0.0+3.g1a2b3c4'. */
export const versionName = (entry) => (isRelease(entry) ? `version ${entry.version}` : `development version ${entry.version}`);

/** Absolute address of a page (the explorer) for one version: <page>?v=<label>&<params>. */
export function permalink(explorer, label, params = {}) {
  const parts = [`v=${encodeURIComponent(label)}`];
  for (const [name, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  }
  return `${explorer}?${parts.join('&')}`;
}

/** The licence of the data as stated on the site (site/config.json `dataLicence`; not decided yet while empty). */
export const dataLicence = (config) => (config && config.dataLicence) || 'to be decided';
