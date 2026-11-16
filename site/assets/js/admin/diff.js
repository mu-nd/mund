// Line-by-line comparison of two texts (used to review changes before a commit).

import { h } from '../core/dom.js';

/** [{ type: ' ' | '-' | '+', text, a, b }] with 1-based line numbers. */
export function diffLines(before, after) {
  const a = before === null || before === undefined ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === null || after === undefined ? [] : after.replace(/\n$/, '').split('\n');
  if (before === '') a.length = 0;
  if (after === '') b.length = 0;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const out = [];
  for (let i = 0; i < start; i++) out.push({ type: ' ', text: a[i], a: i + 1, b: i + 1 });

  const n = endA - start;
  const m = endB - start;
  if (n * m > 4000000) {
    // very large change: show it as one block rather than computing an alignment
    for (let i = start; i < endA; i++) out.push({ type: '-', text: a[i], a: i + 1 });
    for (let j = start; j < endB; j++) out.push({ type: '+', text: b[j], b: j + 1 });
  } else {
    // longest common subsequence of the differing middle part
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = a[start + i] === b[start + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        out.push({ type: ' ', text: a[start + i], a: start + i + 1, b: start + j + 1 });
        i++; j++;
      } else if (j < m && (i === n || table[i * width + j + 1] > table[(i + 1) * width + j])) {
        out.push({ type: '+', text: b[start + j], b: start + j + 1 });
        j++;
      } else {
        out.push({ type: '-', text: a[start + i], a: start + i + 1 });
        i++;
      }
    }
  }
  for (let k = 0; endA + k < a.length; k++) {
    out.push({ type: ' ', text: a[endA + k], a: endA + k + 1, b: endB + k + 1 });
  }
  return out;
}

export function diffStats(lines) {
  return { added: lines.filter((l) => l.type === '+').length, removed: lines.filter((l) => l.type === '-').length };
}

/** A compact unified view: changed lines with `context` unchanged lines around them. */
export function renderDiff(before, after, context = 2) {
  const lines = diffLines(before, after);
  const keep = new Uint8Array(lines.length);
  lines.forEach((line, i) => {
    if (line.type === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = 1;
  });
  const body = h('div', { class: 'diff', role: 'figure' });
  if (!keep.some(Boolean)) {
    body.appendChild(h('div', { class: 'diff-line same' }, h('span', { class: 'diff-text muted' }, '(no differences)')));
    return body;
  }
  let skipping = false;
  lines.forEach((line, i) => {
    if (!keep[i]) {
      if (!skipping) body.appendChild(h('div', { class: 'diff-gap' }, '⋯'));
      skipping = true;
      return;
    }
    skipping = false;
    const cls = line.type === '+' ? 'add' : line.type === '-' ? 'del' : 'same';
    body.appendChild(h('div', { class: `diff-line ${cls}` },
      h('span', { class: 'diff-no' }, line.a || ''),
      h('span', { class: 'diff-no' }, line.b || ''),
      h('span', { class: 'diff-sign' }, line.type),
      h('span', { class: 'diff-text' }, line.text)));
  });
  return body;
}
