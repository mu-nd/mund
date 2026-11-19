// Home: the periodic table leads to the data (the explorer, explorer/?z=…);
// below, what muND is, the four sub-libraries, news, team and how to cite the
// data.  The sections #about, #news, #team and #cite can be linked to
// (#about, #news and #team are the anchors of the former project site).

import { h, replace } from '../core/dom.js';
import { CODES } from '../core/vocabulary.js';
import { pageLink, dsParam } from './route.js';
import { citeSection } from './citebox.js';
import { periodicTableCard } from './ptable.js';
import { introduction, sublibraryCards, newsList, teamList } from './project.js';

/**
 * @param ctx  { config, version, versionChoice }  version: model.js (null when the address names a
 *             version that does not exist); versionChoice: the choice of the version, shown in the
 *             head of the periodic table
 */
export function renderHome(root, { config, version, versionChoice }) {
  const manifest = version ? version.manifest : null;
  // the kinds of data switched on in the key go with the link to the explorer
  const ptable = h('div');
  const drawTable = (kinds) => replace(ptable, periodicTableCard({
    version, versionChoice, kinds, onKinds: drawTable,
    href: (z) => pageLink('explorer', { z, ds: dsParam(kinds) }),
  }));
  if (version) drawTable(new Set(CODES));
  replace(root,
    // the name is in the header, the version in the head of the periodic table, the introduction under "What is muon nuclear data?"
    h('h1', { class: 'visually-hidden' }, 'Muon Nuclear Data (muND)'),
    version ? ptable : null,
    h('section', { class: 'home-section', id: 'about' },
      h('h2', null, 'What is muon nuclear data?'),
      introduction(config),
      sublibraryCards(manifest, (s) => (s === 'LT' ? pageLink('explorer') : null))),
    h('section', { class: 'home-section', id: 'news' }, h('h2', null, 'News'), newsList()),
    h('section', { class: 'home-section', id: 'team' }, h('h2', null, 'Team'), teamList()),
    citeSection(config, version, { id: 'cite' }));
  document.title = 'Muon Nuclear Data';
}
