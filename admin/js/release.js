// The files a release changes: VERSION and CHANGELOG.md (see docs/versioning.md).
// No DOM: the tests import this module.

/** The version after `version` ('1.2.3') when `part` ('major' | 'minor' | 'patch') is increased. */
export function nextVersion(version, part) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  const v = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  if (part === 'major') return `${v[0] + 1}.0.0`;
  if (part === 'minor') return `${v[0]}.${v[1] + 1}.0`;
  return `${v[0]}.${v[1]}.${v[2] + 1}`;
}

/**
 * New version number and CHANGELOG.md text of a release.
 *   version    current content of VERSION (or null)
 *   changelog  current content of CHANGELOG.md (or null)
 *   lines      the changes, one item each
 *   date       'YYYY-MM-DD'
 * The new section is placed above the newest one ("## x.y.z - date").
 */
export function releaseChanges(version, changelog, part, lines, date) {
  const next = nextVersion(version || '0.0.0', part);
  const text = changelog || '# Changelog\n';
  const entry = `## ${next} - ${date}\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`;
  const marker = text.search(/^## /m);
  return {
    version: next,
    changelog: marker < 0 ? `${text.replace(/\n*$/, '\n\n')}${entry}` : `${text.slice(0, marker)}${entry}\n${text.slice(marker)}`,
  };
}
