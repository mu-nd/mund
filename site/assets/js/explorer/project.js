// About the project: the introduction, the four sub-libraries, news and team
// (shown on Home), as on the project site.  News items and team members are
// listed at the top of this file.

import { h, cardHead, externalLink } from '../core/dom.js';
import { CODES, CODE_TITLES } from '../core/vocabulary.js';
import { sublibraryStatus } from './model.js';
import { pageUrl } from './route.js';

const ext = (text, href) => externalLink(href, text);
/** A news item about a publication: what was published, and the reference. */
const published = (text, reference, href) => () => [text, h('br'), ext(reference, href)];

/**
 * In the order of the project site, newest at the top.  `kind`: workshop,
 * publication or others; `date`: the day or month (ISO, for <time>); `when`:
 * how the date is written on the page.
 */
const NEWS = [
  {
    kind: 'workshop', date: '2026-11-12', when: 'Nov. 12–13, 2026', title: 'Workshop on nuclear physics with negative muons',
    body: () => ['The workshop ', ext('“負ミュオンによる原子核研究の新展開”', 'https://indico2.riken.jp/event/5860/'),
      ' was held at RIKEN Nishina Center. Recent progress and future research plans in muon nuclear data, muon capture, ',
      'and muon-induced fission were discussed.'],
  },
  {
    kind: 'publication', date: '2026-10-27', when: 'Oct. 27, 2026', title: 'Absolute intensity measurement of pulsed muon beams using in-beam activation',
    body: published('Our study of absolute intensity measurement of pulsed muon beams using the in-beam activation method has been published in Nuclear Instruments and Methods A.',
      'R. Mizuno et al., Nucl. Instrum. Methods A 1095, 172196 (2027)', 'https://doi.org/10.1016/j.nima.2026.172196'),
  },
  {
    kind: 'publication', date: '2026-06-09', when: 'Jun. 9, 2026', title: 'Comprehensive table of calculated Huff factors',
    body: published('Our comprehensive table of calculated Huff factors, used to extract nuclear muon capture rates from measured muonic atom lifetimes, has been published in Atomic Data and Nuclear Data Tables.',
      'Y. Uesaka et al., At. Data Nucl. Data Tables 171, 101809 (2026)', 'https://doi.org/10.1016/j.adt.2026.101809'),
  },
  {
    kind: 'publication', date: '2025-11-10', when: 'Nov. 10, 2025', title: 'Measurement of production branching ratio after muon nuclear capture reaction of Al and Si isotopes',
    body: published('Our measurements of residual-nucleus production branching ratios following nuclear muon capture in aluminium and silicon isotopes using the in-beam activation method have been published in Physical Review C.',
      'R. Mizuno et al., Phys. Rev. C 112, 054305 (2025)', 'https://doi.org/10.1103/kycz-qprw'),
  },
  {
    kind: 'publication', date: '2025-07-30', when: 'Jul. 30, 2025', title: 'Measurement of radionuclide production probabilities in negative muon nuclear capture and validation of Monte Carlo simulation model',
    body: published('Our measurements of radionuclide production probabilities following nuclear muon capture and their use in validating Monte Carlo simulations have been published in Nuclear Instruments and Methods B.',
      'Y. Yamaguchi et al., Nucl. Instrum. Methods B 567, 165801 (2025)', 'https://doi.org/10.1016/j.nimb.2025.165801'),
  },
  {
    kind: 'publication', date: '2025-08-04', when: 'Aug. 4, 2025', title: 'Lifetime measurement of the muonic atoms of enriched Si isotopes',
    body: published('Our measurements of muonic atom lifetimes in isotopically enriched silicon targets have been published in Physical Review C.',
      'R. Mizuno et al., Phys. Rev. C 112, 024307 (2025)', 'https://doi.org/10.1103/vl7z-rzp8'),
  },
  {
    kind: 'publication', date: '2025-03-18', when: 'Mar. 18, 2025', title: 'Comprehensive Bayesian machine learning approach to estimating the total nuclear capture rate of a negative muon',
    body: published('Our evaluation of total nuclear muon capture rates using Bayesian machine learning has been published in Physical Review C.',
      'H. Iwamoto et al., Phys. Rev. C 111, 034614 (2025)', 'https://doi.org/10.1103/PhysRevC.111.034614'),
  },
  {
    kind: 'publication', date: '2025-03-11', when: 'Mar. 11, 2025', title: 'Muonic x-ray measurement for the nuclear charge distribution: The case of stable palladium isotopes',
    body: published('Our measurements of muonic X-ray energies in stable palladium isotopes and their application to determining nuclear charge radii and distributions have been published in Physical Review C.',
      'T. Y. Saito et al., Phys. Rev. C 111, 034313 (2025)', 'https://doi.org/10.1103/PhysRevC.111.034313'),
  },
  {
    kind: 'workshop', date: '2025-01-16', when: 'Jan. 16–17, 2025', title: 'Workshop on muon nuclear physics and nuclear data',
    body: () => ['The workshop ', ext('“Muon Nuclear Physics and Nuclear Data: From Basic to Applied Research”', 'https://indico.rcnp.osaka-u.ac.jp/event/2474/'),
      ' was held at RCNP, Osaka University, jointly organized by RCNP and the AESJ Sigma Committee.'],
  },
  {
    kind: 'others', date: '2024-10-10', when: 'Oct. 10, 2024', title: 'Web page launched!',
    body: () => 'Disclose this web page. Currently very limited information is available. Stay tuned for more data!',
  },
  {
    kind: 'publication', date: '2024-08', when: 'Aug. 2024', title: 'Dataset of Nuclide Production from Nuclear Capture Reaction of Negative Muon Based on Monte Carlo Simulation',
    body: published('Our dataset of nuclide production following nuclear muon capture, calculated using Monte Carlo simulations, has been released as a JAEA report.',
      'Y. Yamaguchi et al., JAEA-Data/Code 2024-008 (2024)', 'https://doi.org/10.11484/jaea-data-code-2024-008'),
  },
  {
    kind: 'publication', date: '2024-03', when: 'Mar. 2024', title: 'Development of wide range photon detection system for muonic X-ray spectroscopy',
    body: published('Our development of a photon detection system covering a wide energy range for muonic X-ray spectroscopy has been published in Nuclear Instruments and Methods A.',
      'R. Mizuno et al., Nucl. Instrum. Methods A 1060, 169029 (2024)', 'https://doi.org/10.1016/j.nima.2023.169029'),
  },
  {
    kind: 'publication', date: '2024-02', when: 'Feb. 2024', title: 'Effect of large-angle incidence on particle identification performance for light-charged (Z≤2) particles by pulse shape analysis with a pad-type nTD silicon detector',
    body: published('Our study of the effects of large incidence angles on light charged-particle identification using pulse-shape analysis with a silicon detector has been published in Nuclear Instruments and Methods A.',
      'S. Kawase et al., Nucl. Instrum. Methods A 1059, 168984 (2024)', 'https://doi.org/10.1016/j.nima.2023.168984'),
  },
  {
    kind: 'publication', date: '2024-01-29', when: 'Jan. 29, 2024', title: 'Measurement of the production branching ratios following nuclear muon capture for palladium isotopes using the in-beam activation method',
    body: published('Our measurements of residual-nucleus production branching ratios following nuclear muon capture in palladium isotopes using the in-beam activation method have been published in Physical Review C.',
      'M. Niikura et al., Phys. Rev. C 109, 014328 (2024)', 'https://doi.org/10.1103/PhysRevC.109.014328'),
  },
  {
    kind: 'workshop', date: '2023-12-14', when: 'Dec. 14, 2023', title: 'Muon Nuclear Data workshop',
    body: () => [ext('Muon Nuclear Data workshop (in Japanese)', 'https://indico2.riken.jp/event/4656/'), ' was held at RIKEN Nishina Center.'],
  },
  {
    kind: 'publication', date: '2023-05-31', when: 'May 31, 2023', title: 'Nuclear many-body effects on particle emission following muon capture on ²⁸Si and ⁴⁰Ca',
    body: published('Our theoretical study of nuclear many-body effects on particle emission following muon capture in silicon-28 and calcium-40 has been published in Physical Review C.',
      'F. Minato et al., Phys. Rev. C 107, 054314 (2023)', 'https://doi.org/10.1103/PhysRevC.107.054314'),
  },
  {
    kind: 'publication', date: '2023-05-26', when: 'May 26, 2023', title: 'Emissions of Hydrogen Isotopes from the Nuclear Muon Capture Reaction in ⁿᵃᵗSi',
    body: published('Our measurements of proton, deuteron, and triton energy spectra following nuclear muon capture in natural silicon have been published in EPJ Web of Conferences.',
      'S. Manabe et al., EPJ Web Conf. 284, 01029 (2023)', 'https://doi.org/10.1051/epjconf/202328401029'),
  },
];
/** News items shown at first; the older ones open on request. */
const NEWS_SHOWN = 7;

/** [name, affiliation, position] */
const TEAM = [
  ['Megumi Niikura', 'RIKEN Nishina Center', 'Researcher'],
  ['Shinichiro Abe', 'JAEA', 'Researcher'],
  ['Sayani Biswas', 'RAL-ISIS', 'Researcher'],
  ['Hiroki Iwamoto', 'JAEA', 'Researcher'],
  ['Adrian Hillier', 'RAL-ISIS', 'Researcher'],
  ['Naritoshi Kawamura', 'KEK', 'Associate professor'],
  ['Shoichiro Kawase', 'Kyushu Univ.', 'Assistant professor'],
  ['Teiichiro Matsuzaki', 'RIKEN Nishina Center', 'Researcher'],
  ['Futoshi Minato', 'Kyushu Univ.', 'Associate professor'],
  ['Rurie Mizuno', 'RIKEN', 'Postdoctoral Researcher'],
  ['Shuhei Ohno', 'RIKEN', 'Research Associate'],
  ['Dai Tomono', 'Osaka Univ.', 'Assistant professor'],
  ['Yukinobu Watanabe', 'Kyushu Univ.', 'Professor'],
  ['Yuji Yamaguchi', 'JAEA', 'Researcher'],
];

/** The four sub-libraries, in the order of SUBLIBRARIES. */
const SUBLIBRARY_TEXT = {
  XR: {
    title: 'Muonic X-ray energies and intensities (XR)',
    body: 'When a negative muon forms a muonic atom, it emits Auger electrons and muonic X-rays as it cascades to lower atomic '
      + 'energy levels. The XR sub-library provides the energies and intensities of muonic X-rays, which are used for measurements '
      + 'of nuclear charge radii and non-destructive elemental analysis.',
  },
  LT: {
    title: 'Lifetimes of muonic atoms (LT)',
    body: 'After a muonic atom reaches its ground (1s) state, the negative muon disappears through either decay-in-orbit or '
      + 'nuclear muon capture. The LT sub-library provides muonic atom lifetimes, which reflect the competition between these two processes.',
  },
  ES: {
    title: 'Energy spectra of emitted particles (ES)',
    body: 'Nuclear muon capture produces a highly excited nucleus, which subsequently de-excites by emitting neutrons, charged '
      + 'particles, and gamma rays. The ES sub-library provides energy spectra of the emitted neutrons and charged particles, '
      + 'offering information on both the nuclear excitation-energy distribution following muon capture and the subsequent decay processes.',
  },
  BR: {
    title: 'Production branching ratios of residual nuclei (BR)',
    body: 'Nuclear muon capture and subsequent de-excitation lead to the production of various residual nuclei. '
      + 'The BR sub-library provides the production branching ratios of residual nuclei.',
  },
};

/** The paragraph that introduces the database. */
export function introduction(config) {
  return h('div', { class: 'prose' },
    h('p', null, 'We are developing a new nuclear database for muon-induced nuclear reactions (muon nuclear data, muND). ',
      'The database will consist of following four sub-libraries. An outline of the muon nuclear data can be found in ',
      config.paper ? ext('our recent publication', config.paper.url) : 'our recent publication',
      ' and on our ', h('a', { href: pageUrl('docs') }, 'documentation page'), '.'));
}

function statusLine(manifest, s, browse) {
  const status = sublibraryStatus(manifest, s);
  const counts = (manifest.sublibraries[s] || {}).counts || {};
  return h('p', { class: 'sub-status small muted' },
    status.available
      ? [`${status.text} in this version (`,
        CODES.filter((d) => counts[d]).map((d, n) => [n ? ', ' : '', `${counts[d]} ${CODE_TITLES[d].toLowerCase()}`]),
        ')', browse && browse(s) ? [' – ', h('a', { href: browse(s) }, 'browse the data')] : null]
      : 'No data yet.');
}

/**
 * One card per sub-library: its description and, when a manifest is given,
 * what this version holds of it, with a link `browse(sublibrary)` to its data.
 */
export function sublibraryCards(manifest, browse) {
  return h('div', { class: 'sublibraries' }, Object.entries(SUBLIBRARY_TEXT).map(([s, text]) => h('section', { class: 'card' },
    cardHead(h('h3', null, text.title)),
    h('div', { class: 'card-body' }, manifest ? statusLine(manifest, s, browse) : null, h('p', null, text.body)))));
}

const newsItem = (item) => h('li', null,
  h('div', { class: 'news-meta' },
    h('span', { class: `news-kind ${item.kind}` }, item.kind),
    h('time', { datetime: item.date }, item.when)),
  h('div', null, h('h3', null, item.title), h('p', null, item.body())));

export function newsList() {
  const older = NEWS.slice(NEWS_SHOWN);
  return h('div', { class: 'news card' },
    h('ul', null, NEWS.slice(0, NEWS_SHOWN).map(newsItem)),
    older.length ? h('details', { class: 'news-older' },
      h('summary', null, `Show ${older.length} older updates`),
      h('ul', null, older.map(newsItem))) : null);
}

export function teamList() {
  return h('ul', { class: 'team' }, TEAM.map(([name, affiliation, position]) => h('li', { class: 'card' },
    h('h3', null, name), h('p', null, affiliation, h('br'), position))));
}
