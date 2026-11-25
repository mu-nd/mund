// Minimal DOM helpers (no framework).

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'path', 'line', 'text', 'tspan']);

/**
 * Create an element.
 *   h('button', { class: 'btn', onclick: fn, 'aria-pressed': 'true' }, 'Label')
 * Attribute values null / undefined / false are skipped; `true` sets an empty
 * attribute.  Children may be nodes, strings, numbers, arrays, or null.
 * Text is always inserted as text (never parsed as HTML).
 */
export function h(tag, attrs, ...children) {
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2), value);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key === 'value' && 'value' in el) {
        el.value = value;
      } else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') {
        el[key] = Boolean(value);
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
  return el;
}

export function replace(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

/** A link to another site, opened in a new tab; `attrs` adds attributes (a title …). */
export function externalLink(href, children, attrs = {}) {
  return h('a', { ...attrs, href, target: '_blank', rel: 'noopener' }, children);
}

/**
 * A link to another state of the page: a plain click calls `follow(event)` in place of loading the
 * href; a click with a modifier key (a new tab or window) follows the href.  Without `follow`, a plain link.
 */
export function stateLink(attrs, follow, ...children) {
  return h('a', {
    ...attrs,
    onclick: follow && ((e) => {
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      follow(e);
    }),
  }, children);
}

/**
 * The click handler of a table row that acts as a whole (class "selectable"): `act(event)` runs on a
 * click that is not on a link in the row and does not end a text selection (a drag to copy a value).
 */
export function rowClick(act) {
  return (e) => { if (!e.target.closest('a') && !String(getSelection())) act(e); };
}

/** The head of a card: its title (a text becomes an <h2>) and, on the right, optional controls. */
function cardHead(title, ...controls) {
  return h('div', { class: 'card-head' }, typeof title === 'string' ? h('h2', null, title) : title, controls);
}

/**
 * A segmented switch: one of a few choices, the chosen one raised (.seg).
 * Its buttons stay on the page, so the one clicked keeps the keyboard focus.
 * @param label     what is chosen, for screen readers; null inside a fieldset whose legend says it
 * @param choices   [{ value, text, title? }], each value a text
 * @param chosen    the value chosen at first
 * @param onchoose  called with the value of a click
 */
export function segSwitch(label, choices, chosen, onchoose) {
  const box = h('div', { class: 'seg', role: 'group', 'aria-label': label }, choices.map(({ value, text, title = null }) => h('button', {
    type: 'button', value, title, onclick: () => { setSegSwitch(box, value); onchoose(value); },
  }, text)));
  setSegSwitch(box, chosen);
  return box;
}

/** Raise the choice `value` of a segmented switch, also when it was chosen elsewhere (the browser's Back). */
export function setSegSwitch(box, value) {
  for (const button of box.children) button.setAttribute('aria-pressed', String(button.value === value));
}

/** A card: its head (see cardHead) when it has a title, and its content. */
export function card({ title = null, controls = null, class: extra = null }, ...content) {
  return h('section', { class: extra ? `card ${extra}` : 'card' }, title === null ? null : cardHead(title, controls), content);
}

/** The title of a page, with controls on the right (the version of the data …). */
export function pageHeading(title, ...controls) {
  return h('div', { class: 'heading-row' }, h('h1', null, title), h('span', { class: 'spacer' }), controls);
}

/** The page header (the site, the data entry tool) casts a shadow once the page is scrolled (base.css). */
export function headerShadow() {
  const mark = () => document.body.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', mark, { passive: true });
  mark();
}

/** Nuclide name with the mass number as superscript: <sup>28</sup>Si. */
export function nuclideNode(element, a) {
  return h('span', { class: 'nuclide' }, h('sup', null, a > 0 ? String(a) : 'nat'), element);
}

/** Offer a text as a file download. */
export function downloadText(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
