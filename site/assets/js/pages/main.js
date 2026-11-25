// Entry point of every page.  The header (menu, GitHub link, colour switch) is
// written when the site is built (tools/mundlib/site.py); here the colour switch
// is wired, the site name and the menu keep the version the address names, and a
// page that shows data is loaded and drawn, chosen by the address (route.js).
//
// Pages that show data name the version in the address (?v=…): without it the
// default version (the newest release) is shown and v is added (not on Home,
// whose address stays as it is).  A version that does not exist is an error.  The
// documents (docs/…, api/) are complete as built: they load no data code
// (store.js, model.js), only the pages that show data do.
//
// Other addresses that show the same content: db/?z=14 leads to explorer/?z=14
// (site/db/index.html).

import { h, replace, headerShadow } from '../core/dom.js';
import { icon } from './icons.js';
import { loadConfig } from './site.js';
import { query, urlWith, versionUrl, currentPage, pageUrl, pageLink } from './route.js';

/**
 * The pages that show a version of the data, each drawn by its own module (only
 * this page loads it).  The page places the version choice in its card head
 * (Home, Explorer: the head of the periodic table; Downloads, Converter: on the
 * right of the title).  The address names the version, except on Home (`keepAddress`).
 */
const PAGES = {
  '': { load: () => import('./home.js').then((m) => m.renderHome), keepAddress: true },
  explorer: { load: () => import('./explorer.js').then((m) => m.renderExplorer) },
  downloads: { load: () => import('./downloads.js').then((m) => m.renderDownloads) },
  'tools/converter': { load: () => import('./converter.js').then((m) => m.renderConverter) },
};

const main = document.getElementById('main');

/**
 * The colours of the project site are shown unless the reader chooses the dark
 * ones here; the choice is kept in this browser (index.html applies it on load).
 * The icon and the name say what a click does: a moon (dark colours), a sun (light colours).
 */
function themeSwitch(button) {
  const dark = () => document.documentElement.dataset.theme === 'dark';
  const show = () => {
    const name = dark() ? 'Light colours' : 'Dark colours';
    button.title = name;
    button.setAttribute('aria-label', name);
    replace(button, icon(dark() ? 'sun' : 'moon'));
  };
  button.addEventListener('click', () => {
    if (dark()) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = 'dark';
    try { localStorage.setItem('mund-theme', dark() ? 'dark' : 'light'); } catch { /* not kept: the page still works */ }
    show();
  });
  show();
}

/** The site name and the menu links to the pages that show data keep the version the address names. */
function keepVersion() {
  if (!query().get('v')) return;
  const keys = new Map(['', 'explorer', 'downloads'].map((key) => [pageUrl(key), key]));
  for (const link of document.querySelectorAll('.site-header .brand, .site-nav a')) {
    if (keys.has(link.href)) link.href = pageLink(keys.get(link.href));
  }
}

/** Keys that move through the list of a select without choosing. */
const BROWSE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * The choice of the data version, in the card head of the page (after a
 * failure: above the message).  A choice opens the page in that version,
 * except while the reader moves through the list with the keys: then Enter or
 * leaving the list does.  `versionName`: that of model.js.
 */
function versionSelect(versions, label, versionName) {
  let browsing = false;
  const open = (e) => {
    browsing = false;
    const chosen = e.target.value;
    e.target.value = label || '';
    if (chosen && chosen !== label) location.href = versionUrl(chosen);
  };
  return h('select', {
    class: 'version-select', 'aria-label': 'Data version', title: 'Version of the data shown',
    onkeydown: (e) => {
      if (BROWSE_KEYS.has(e.key)) browsing = true;
      else if (e.key === 'Enter') open(e);
      else if (e.key === 'Escape') {
        browsing = false;
        e.target.value = label || '';
      }
    },
    onmousedown: () => { browsing = false; },
    onchange: (e) => { if (!browsing) open(e); },
    onblur: (e) => { if (browsing) open(e); },
  },
  label ? null : h('option', { value: '', selected: true, disabled: true }, 'Unknown version'),
  versions.versions.map((v) => h('option', { value: v.label, selected: v.label === label }, versionName(v, { newest: versions.default }))));
}

/** After the content is drawn: go to the section the address names (#news …). */
function showAnchor() {
  const id = decodeURIComponent(location.hash.slice(1));
  const target = id && document.getElementById(id);
  if (target) target.scrollIntoView();
}

async function start() {
  const key = currentPage();
  themeSwitch(document.getElementById('theme'));
  headerShadow();
  keepVersion();
  const page = PAGES[key];
  if (!page) return;    // a document

  const data = Promise.all([import('./store.js'), import('./model.js')]);
  const loaded = await Promise.allSettled([loadConfig(), data.then(([store]) => store.loadVersions()), page.load(), data]);
  const [config, versions, render, [store, model] = []] = loaded.map((r) => r.value);
  const failed = loaded.find((r) => r.status === 'rejected');
  const asked = query().get('v');
  const { label, entry, error } = model ? model.resolveVersion(versions, asked) : {};
  const view = h('div', { class: 'view' });

  /** A failure: the version choice (when the versions are known) above the message; Home keeps its text. */
  const fail = (message) => {
    const home = key === '' && config && render;
    replace(main, versions ? h('p', null, versionSelect(versions, label, model.versionName)) : null,
      h('p', { class: 'notice bad' }, message), home ? view : null);
    if (home) {
      render(view, { config, version: null });
      showAnchor();
    }
  };
  if (failed) {
    fail(`The data could not be loaded: ${failed.reason.message}`);
    return;
  }
  if (error) {
    fail(`${error} Choose one above.`);
    return;
  }
  // the address names the version shown (Home: only when one was chosen)
  if (asked !== label && !page.keepAddress) history.replaceState(null, '', urlWith({ v: label }));
  let version;
  try {
    version = await store.loadVersion(entry, key);
  } catch (err) {
    fail(`Version “${label}” could not be loaded: ${err.message}.`);
    return;
  }
  replace(main, view);
  render(view, { config, versions, version, versionChoice: versionSelect(versions, label, model.versionName) });
  showAnchor();
}

start();
