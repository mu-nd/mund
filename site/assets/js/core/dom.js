// Minimal DOM helpers (no framework).

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'path', 'line', 'circle', 'rect', 'text', 'tspan', 'title', 'polygon',
  'polyline', 'defs', 'clipPath']);

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

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

/** A link to another site, opened in a new tab. */
export function externalLink(href, ...children) {
  return h('a', { href, target: '_blank', rel: 'noopener' }, children);
}

/** The head of a card: its title (a text becomes an <h2>) and, on the right, optional controls. */
export function cardHead(title, ...controls) {
  return h('div', { class: 'card-head' }, typeof title === 'string' ? h('h2', null, title) : title, controls);
}

/**
 * A segmented switch: one of a few choices, the chosen one raised (.seg).
 * @param label     what is chosen, for screen readers
 * @param choices   [{ value, text, title? }]
 * @param chosen    the value chosen at first
 * @param onchoose  called with the value of a click
 */
export function segSwitch(label, choices, chosen, onchoose) {
  const box = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const draw = () => replace(box, choices.map(({ value, text, title = null }) => h('button', {
    type: 'button', title, 'aria-pressed': String(value === chosen),
    onclick: () => { chosen = value; draw(); onchoose(value); },
  }, text)));
  draw();
  return box;
}

/** A card: its head (see cardHead) and its content. */
export function card({ title, controls = null, class: extra = null, id = null }, ...content) {
  return h('section', { class: extra ? `card ${extra}` : 'card', id }, cardHead(title, controls), content);
}

/** The title of a page, with controls on the right (the version of the data …). */
export function pageHeading(title, ...controls) {
  return h('div', { class: 'heading-row' }, h('h1', null, title), h('span', { class: 'spacer' }), controls);
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
