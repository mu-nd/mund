// The citation boxes (Home, Downloads, an entry): one for the project paper and
// one for the version of the database, one below the other, each with the style
// (Physical Review or BibTeX) above a text that cannot be edited, with a copy
// button in its top right corner (as on code blocks on GitHub); long lines
// wrap, and the box is as high as its text (no scroll bars).

import { h, replace, card, segSwitch } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { paperCitations, dataCitations } from './citation.js';
import { pageUrl, explorerPermalink } from './route.js';

const STYLES = ['APS', 'BibTeX'];
const STYLE_TITLES = { APS: 'The style of Physical Review (APS)', BibTeX: 'BibTeX, for LaTeX' };
const COPY_TITLE = 'Copy the citation';

/**
 * @param title    heading of the box
 * @param formats  { APS: text, BibTeX: text }
 */
export function citeBox({ title, formats }) {
  let style = STYLES[0];
  const text = h('textarea', { class: 'cite-text', readonly: true, spellcheck: 'false', wrap: 'soft', rows: 1 });
  const styles = segSwitch(`Citation style: ${title}`, STYLES.map((s) => ({ value: s, text: s, title: STYLE_TITLES[s] })), style,
    (s) => { style = s; draw(); });
  const copy = h('button', { class: 'icon-button cite-copy', type: 'button', title: COPY_TITLE, 'aria-label': COPY_TITLE }, icon('copy'));
  let reset = null;

  function draw() {
    text.value = formats[style];
    text.setAttribute('aria-label', `${title}, ${style}`);
    fit();
  }

  // the box is as high as its text (once it is on the page, and again when its width changes)
  let width = 0;
  function fit() {
    if (!text.isConnected) return;
    text.style.height = 'auto';
    text.style.height = `${text.scrollHeight + 2}px`;
    width = text.clientWidth;
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (text.clientWidth !== width) fit(); }).observe(text);
  }

  // copied: a tick for a moment; not possible: the text stays selected, to be copied by hand
  function done(ok) {
    const label = ok ? 'Copied' : 'Selected: press Ctrl+C (⌘C on a Mac) to copy';
    if (ok) replace(copy, icon('copied'));
    copy.classList.toggle('copied', ok);
    copy.title = label;
    copy.setAttribute('aria-label', label);
    clearTimeout(reset);
    reset = setTimeout(() => {
      replace(copy, icon('copy'));
      copy.classList.remove('copied');
      copy.title = COPY_TITLE;
      copy.setAttribute('aria-label', COPY_TITLE);
    }, 1600);
  }

  copy.addEventListener('click', () => {
    const fallback = () => {
      text.focus();
      text.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      done(ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text.value).then(() => done(true), fallback);
    } else {
      fallback();
    }
  });
  // a click in the text selects all of it
  text.addEventListener('focus', () => text.select());

  draw();
  return card({ title: h('h3', null, title), controls: styles }, h('div', { class: 'card-body' }, h('div', { class: 'cite-wrap' }, text, copy)));
}

/**
 * The two boxes, one below the other: the project paper (config.paper) and the
 * database in the version `version` (model.js; null: the paper alone), with
 * the address `url` that shows that version (or one entry of it).
 */
export function citeBoxes(config, version, url) {
  return h('div', { class: 'cite-grid' },
    config.paper && config.paper.authors ? citeBox({ title: 'Project paper', formats: paperCitations(config.paper) }) : null,
    version ? citeBox({ title: 'Database', formats: dataCitations(config.data, { ...version.manifest, label: version.label }, url) }) : null);
}

/**
 * "How to cite", the same on every page (Home, Downloads): one line, then the
 * boxes for the paper and for the version shown (null: the paper alone).
 */
export function citeSection(config, version, { id = null } = {}) {
  return h('section', { class: 'cite-section', id },
    h('h2', null, 'How to cite'),
    h('p', null, 'Please cite both, and the original reference of each value you use (given with every data entry). ',
      'Stable versions never change: ', h('a', { href: pageUrl('docs/versions') }, 'Versions and citing'), '.'),
    citeBoxes(config, version, version ? explorerPermalink(version.label) : ''));
}
