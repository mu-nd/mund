// Entry point of every page: page chrome (navigation, version selector,
// footer) and the page itself, chosen by the address (route.js).
//
// Pages that show data name the version in the address (?v=…): without it the
// default version (the newest release) is shown and v is added (not on Home,
// whose address stays as it is).  A version that does not exist is an error.  The documents (docs/…, api/) are made when
// the site is built; here they only get the page chrome.
//
// Addresses of the former layouts lead to the same content: ?z=14 on Home and
// db/?z=14 to the explorer, #about #news #team (also #/about …) to the
// sections of Home, #/converter and #/downloads to their pages.

import { h, replace, externalLink } from '../core/dom.js';
import { loadConfig } from '../core/site.js';
import { loadVersions, loadVersion } from './store.js';
import { query, urlWith, versionUrl, currentPage, pageUrl, pageLink } from './route.js';
import { resolveVersion, isRelease, versionName } from './versioning.js';
import { renderHome } from './view-home.js';
import { renderExplorer } from './view-explorer.js';
import { renderConverter } from './view-converter.js';
import { renderDownloads } from './view-downloads.js';

/**
 * `data`: the page shows a version of the data (the address names it, except
 * on Home: `keepAddress`).  `versionInPage`: the page places the version
 * choice itself (Home, Explorer: in the head of the periodic table; Downloads,
 * Converter: on the right of the title); otherwise it is at the top of the page.  `document`: made from docs/ when the site is built.
 * `nav`: its entry in the navigation (the converter is listed in Docs).
 */
const PAGES = {
  '': { render: renderHome, data: true, nav: '', keepAddress: true, versionInPage: true },
  explorer: { render: renderExplorer, data: true, nav: 'explorer', versionInPage: true },
  downloads: { render: renderDownloads, data: true, nav: 'downloads', versionInPage: true },
  docs: { document: true, nav: 'docs' },
  api: { document: true, nav: 'api' },
  'tools/converter': { render: renderConverter, data: true, nav: 'docs', versionInPage: true },
};
const NAV = [['', 'Home'], ['explorer', 'Explorer'], ['downloads', 'Downloads'], ['api', 'API'], ['docs', 'Docs']];

const pageOf = (key) => PAGES[key] || (key.startsWith('docs/') ? { document: true, nav: 'docs' } : { document: true, nav: null });

const main = document.getElementById('main');
const nav = document.getElementById('nav');
const footer = document.getElementById('footer');

/** Addresses of the former layouts: true when the browser is sent on. */
function redirectFormer(key) {
  if (key !== '') return false;
  const params = query();
  const moved = { '#/converter': 'tools/converter', '#/downloads': 'downloads', '#/explorer': 'explorer' }[location.hash];
  if (moved || ['z', 'a', 'id', 'ds', 'q'].some((p) => params.has(p))) {
    location.replace(pageUrl(moved || 'explorer') + location.search);
    return true;
  }
  const anchor = { '#/about': '#about', '#/news': '#news', '#/team': '#team', '#/': '', '#home': '' }[location.hash];
  if (anchor !== undefined) history.replaceState(null, '', `${location.pathname}${location.search}${anchor}`);
  return false;
}

/** What each version is, readable in the choice itself: the newest release is the latest stable version. */
function optionText(v, newestRelease) {
  if (!isRelease(v)) return 'Development version (unstable)';
  return v.label === newestRelease ? `Latest stable version (${v.version})` : `Stable version ${v.version}`;
}

/**
 * The colours of the project site are shown unless the reader chooses the dark
 * ones here; the choice is kept in this browser (index.html applies it on load).
 */
function themeSwitch() {
  const dark = () => document.documentElement.dataset.theme === 'dark';
  const button = h('button', { class: 'theme-switch', type: 'button' });
  const label = () => replace(button, dark() ? 'Light colours' : 'Dark colours');
  button.addEventListener('click', () => {
    if (dark()) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = 'dark';
    try { localStorage.setItem('mund-theme', dark() ? 'dark' : 'light'); } catch { /* not kept: the page still works */ }
    label();
  });
  label();
  return button;
}

/** The footer: the source on GitHub and the switch of the colours (the menu and the version are above). */
function renderFooter(config) {
  replace(footer, externalLink(`https://github.com/${config.repository}`, 'Source and history on GitHub'), themeSwitch());
}

/** The version of the data a page shows, at the top of the page (on Home above the periodic table). */
function versionBar(versions, label, entry) {
  const releases = versions.versions.filter(isRelease);
  const newest = releases.length ? releases[0].label : null;    // versions.json lists the newest release first
  return h('div', { class: 'version-bar' },
    h('select', {
      id: 'version-select', 'aria-label': 'Data version', title: 'Version of the data shown',
      onchange: (e) => { location.href = versionUrl(e.target.value); },
    },
    entry ? null : h('option', { value: '', selected: true, disabled: true }, 'Unknown version'),
    versions.versions.map((v) => h('option', { value: v.label, selected: v.label === label }, optionText(v, newest)))));
}

/** After the content is drawn: go to the section the address names (#news …). */
function showAnchor() {
  const id = decodeURIComponent(location.hash.slice(1));
  const target = id && document.getElementById(id);
  if (target) target.scrollIntoView();
}

// the header casts a shadow once the page is scrolled
const markScrolled = () => document.body.classList.toggle('scrolled', window.scrollY > 4);
window.addEventListener('scroll', markScrolled, { passive: true });
markScrolled();

async function start() {
  const key = currentPage();
  const page = pageOf(key);
  if (redirectFormer(key)) return;

  replace(nav, NAV.map(([k, label]) => h('a', {
    href: k === 'docs' || k === 'api' ? pageUrl(k) : pageLink(k), 'aria-current': k === page.nav ? 'page' : null,
  }, label)));

  let config;
  let versions;
  try {
    [config, versions] = await Promise.all([loadConfig(), loadVersions()]);
  } catch (err) {
    if (!page.document) replace(main, h('p', { class: 'notice bad' }, `The data could not be loaded: ${err.message}`));
    return;
  }
  const asked = query().get('v');
  const { label, entry, error } = resolveVersion(versions, asked);
  renderFooter(config);
  if (page.document) return;

  const view = h('div', { class: 'view' });
  // the address names the version shown (Home: only when one was chosen)
  if (!error && asked !== label && !page.keepAddress) history.replaceState(null, '', urlWith({ v: label }));
  const bar = versionBar(versions, label, error ? null : entry);
  if (error && page.keepAddress) {
    replace(main, bar, h('p', { class: 'notice bad' }, error), view);
    page.render(view, { config, versions, version: null });
    showAnchor();
    return;
  }
  if (error) {
    replace(main, bar, h('div', { class: 'notice bad' },
      h('p', null, `${error} Nothing is shown in its place.`),
      h('p', { style: { margin: 0 } }, 'Available: ', versions.versions.map((v, i) => [i ? ' · ' : '',
        h('a', { href: versionUrl(v.label) }, v.label), ` (${versionName(v)})`]))));
    document.title = 'Unknown version – Muon Nuclear Data';
    return;
  }
  let version;
  try {
    version = await loadVersion(entry);
  } catch (err) {
    replace(main, h('p', { class: 'notice bad' }, `Version “${label}” could not be loaded: ${err.message}. `,
      h('button', { class: 'btn small', type: 'button', onclick: () => location.reload() }, 'Reload the page')));
    return;
  }
  replace(main, page.versionInPage ? null : bar, view);
  page.render(view, { config, versions, version, entry, versionChoice: bar });
  showAnchor();
}

start();
