// Entry point of the explorer: page chrome, version selector and routing.
//
//   ?z=14&a=28&ds=EXP,CUR&q=rate&id=<DataID>&v=<version>   state of the explorer
//   #/converter  #/downloads  #/about                      other pages
//
// `?z=` is the address used by the periodic table of the project top page.

import { h, replace } from '../core/dom.js';
import { loadConfig, loadVersions, loadVersion, siteUrl } from './store.js';
import { renderExplorer } from './view-explorer.js';
import { renderConverter, renderDownloads, renderAbout } from './view-pages.js';

const PAGES = {
  '': { label: 'Explorer', render: renderExplorer },
  converter: { label: 'Converter', render: renderConverter },
  downloads: { label: 'Downloads', render: renderDownloads },
  about: { label: 'About', render: renderAbout },
};

const RELOADED_KEY = 'mund:reloaded-for-new-data';
const main = document.getElementById('main');
const nav = document.getElementById('nav');
const versionBox = document.getElementById('version');
const footer = document.getElementById('footer');
let cleanup = null;

function pageKey() {
  const key = location.hash.replace(/^#\/?/, '');
  return PAGES[key] ? key : '';
}

function versionUrl(label, versions) {
  const params = new URLSearchParams(location.search);
  if (label === versions.default) params.delete('v'); else params.set('v', label);
  params.delete('id');
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
}

async function start() {
  let config;
  let versions;
  try {
    [config, versions] = await Promise.all([loadConfig(), loadVersions()]);
  } catch (err) {
    replace(main, h('p', { class: 'notice bad' }, `The data could not be loaded: ${err.message}`));
    return;
  }

  async function show() {
    const requested = new URLSearchParams(location.search).get('v');
    const label = versions.versions.some((v) => v.label === requested) ? requested : versions.default;
    const key = pageKey();
    replace(nav, Object.entries(PAGES).map(([k, page]) => h('a', {
      href: k ? `#/${k}` : `${location.pathname}${location.search}`, 'aria-current': k === key ? 'page' : null,
    }, page.label)),
    config.project_url ? h('a', { href: config.project_url }, 'Project page ↗') : null);

    let version;
    try {
      version = await loadVersion(label);
      try { sessionStorage.removeItem(RELOADED_KEY); } catch (e) { /* ignore */ }
    } catch (err) {
      if (err.outdated) {
        // The site was updated while an older copy of this page was cached: load the new page (once).
        let reloaded = true;
        try { reloaded = Boolean(sessionStorage.getItem(RELOADED_KEY)); sessionStorage.setItem(RELOADED_KEY, '1'); } catch (e) { /* ignore */ }
        if (!reloaded) { location.reload(); return; }
        replace(main, h('p', { class: 'notice warn' }, 'This page is older than the data: the site has just been updated. ',
          h('button', { class: 'btn small', type: 'button', onclick: () => location.reload() }, 'Reload the page')));
        return;
      }
      replace(main, h('p', { class: 'notice bad' }, `Version “${label}” could not be loaded: ${err.message}`));
      return;
    }
    const entry = versions.versions.find((v) => v.label === label);
    replace(versionBox,
      h('label', { for: 'version-select', class: 'visually-hidden' }, 'Data version'),
      h('select', {
        id: 'version-select', title: 'Data version',
        onchange: (e) => { location.href = versionUrl(e.target.value, versions); },
      }, versions.versions.map((v) => h('option', { value: v.label, selected: v.label === label },
        v.kind === 'release' ? `Version ${v.version}` : `Latest (${v.version})`))));
    replace(footer,
      h('span', null, `muND data ${entry.kind === 'release' ? `version ${entry.version}` : `${entry.version}, development snapshot`}`
        + (entry.date ? ` · ${entry.date.slice(0, 10)}` : '')),
      h('a', { href: `https://github.com/${config.repository}`, target: '_blank', rel: 'noopener' }, 'Source and history on GitHub'),
      h('a', { href: '#/downloads' }, 'Downloads'),
      h('a', { href: siteUrl('admin/') }, 'Data entry'));

    if (cleanup) cleanup();
    replace(main);
    if (entry.kind !== 'release' && versions.versions.some((v) => v.kind === 'release')) {
      main.appendChild(h('p', { class: 'notice warn' }, 'You are looking at the development snapshot. Values may change; cite a released version. ',
        h('a', { href: versionUrl(versions.default, versions) }, 'Show the current release')));
    }
    const view = h('div', { class: `view view-${key || 'explorer'}` });
    main.appendChild(view);
    const ctx = { config, versions, version, siteUrl, versionUrl: (l) => versionUrl(l, versions) };
    cleanup = PAGES[key].render(view, ctx) || null;
  }

  window.addEventListener('hashchange', show);
  await show();
}

start();
