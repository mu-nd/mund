// Building blocks of the editor's form.
//
// A control may carry its own tooltip in data-hint; the problems found by the
// checks are kept in data-issue.  Its title shows both.

import { h } from '../../site/assets/js/core/dom.js';

let counter = 0;

/** A labelled field. */
export function field(label, control, { hint, wide } = {}) {
  if (!control.id) control.id = `field-${++counter}`;
  return h('div', { class: `field${wide ? ' wide' : ''}` },
    h('label', { for: control.id }, label),
    control,
    hint ? h('p', { class: 'hint' }, hint) : null);
}

/** A text input (or text area) bound to obj[key]; `onInput` runs after each change. */
export function textInput(obj, key, onInput, { area, rows = 3, placeholder, list } = {}) {
  const el = area
    ? h('textarea', { rows, placeholder, spellcheck: 'false' })
    : h('input', { type: 'text', placeholder, list, autocomplete: 'off', spellcheck: 'false' });
  el.value = obj[key] === undefined || obj[key] === null ? '' : String(obj[key]);
  el.addEventListener('input', () => {
    obj[key] = el.value;
    onInput();
  });
  return el;
}

/** Give a control its own tooltip. */
export function withHint(el, text) {
  el.dataset.hint = text;
  el.title = text;
  return el;
}

/** Show the problems found at a control (an empty list clears them). */
export function markIssues(el, issues) {
  el.removeAttribute('aria-invalid');
  el.classList.remove('has-warning');
  delete el.dataset.issue;
  if (issues.length) {
    if (issues.some((i) => i.level === 'error')) el.setAttribute('aria-invalid', 'true');
    else el.classList.add('has-warning');
    el.dataset.issue = issues.map((i) => i.message).join('\n');
  }
  const title = [el.dataset.issue, el.dataset.hint].filter(Boolean).join('\n');
  if (title) el.title = title; else el.removeAttribute('title');
}
