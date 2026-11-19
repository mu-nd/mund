// The panel with everything about one data entry: value, converted
// quantities, where it comes from, experimental conditions, reference,
// identifiers and how to cite it.

import { h, replace, nuclideNode, externalLink } from '../core/dom.js';
import * as jsonfmt from '../core/jsonfmt.js';
import { siteUrl } from '../core/site.js';
import { citeLabel, citeText, authorList, doiUrl, isPlaceholderDoi, referenceTitle } from '../core/cite.js';
import { formatQuantity, formatDerived } from '../core/format.js';
import { QUANTITIES, UNIT_LABELS } from '../core/convert.js';
import { CODE_TITLES } from '../core/vocabulary.js';
import { citeBoxes } from './citebox.js';

const QUANTITY_NAMES = Object.keys(QUANTITIES);
const unitText = (name) => UNIT_LABELS[QUANTITIES[name].unit];
const derived = (row, name) => (row.conv
  ? formatDerived(row.conv[QUANTITIES[name].key], row.conv[`${QUANTITIES[name].key}_unc`]).text : '');

/**
 * Show the entry `id` in the panel `el` (an <aside class="detail">), or close
 * the panel when there is no such entry.
 * @param version      a version of model.js
 * @param config       site/config.json
 * @param link         (datasetId) => address of the page showing that entry
 * @param select       (datasetId) => void: show another entry ('' closes the panel)
 * @param permalinkOf  (row) => absolute address of the entry, with the version
 * @param extra        optional (row) => nodes shown below the reference (links of the page)
 * @returns the row shown, or null
 */
export function renderDetail(el, { version, config, id, link, select, permalinkOf, extra = null }) {
  const { tables } = version;
  const row = id ? version.byId.get(id) : null;
  document.body.classList.toggle('has-detail', Boolean(row));
  el.hidden = !row;
  if (!row) { replace(el); return null; }

  const { entry, meta, reference, block, conv } = row;
  const unit = UNIT_LABELS[block.unit];
  const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter((p) => p && p[1] !== null && p[1] !== undefined && p[1] !== '')
    .map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  const idLink = (target, changed = false) => {
    const found = version.byId.get(target);
    return h('li', null,
      h('a', { href: link(target), onclick: (e) => { e.preventDefault(); select(target); } }, h('code', null, target)),
      found ? [' ', nuclideNode(found.entry.nuclide.element, found.a),
        ` ${formatQuantity(found.block).text} ${UNIT_LABELS[found.block.unit]}`,
        ` · ${citeLabel(found.reference, found.entry.bibId)}`] : ' (not in this version)',
      changed ? [' ', h('span', { class: 'changed' }, 'changed after this value was derived from it; to be checked again')] : null);
  };
  const doiLink = (doi) => (doiUrl(doi) ? externalLink(doiUrl(doi), doi) : doi);
  const usedBy = version.usedBy.get(entry.datasetId) || [];
  const changedOriginals = row.originals.filter((o) => o.changed).length;
  const facility = tables.facilities.get(meta.facility);
  const huffSource = conv ? { nuclide: 'value for this nuclide', element: 'element average',
    none: 'no tabulated value: Q = 1 assumed', given: 'given' }[conv.huff_source] : '';
  const separate = block.uncertainties.some((u) => u.source !== 'total');
  const notes = block.uncertainties.filter((u) => u.description);
  const entryLink = permalinkOf(row);

  replace(el,
    h('div', { class: 'detail-head' },
      h('h2', null, nuclideNode(entry.nuclide.element, row.a), ` · ${CODE_TITLES[row.code]}`),
      h('button', { class: 'btn small ghost', 'aria-label': 'Close details', onclick: () => select('') }, '✕')),
    h('div', { class: 'detail-body' },
      h('h3', null, 'Value'),
      kv([
        ['Given in the source', h('strong', null, `${QUANTITIES[entry.observable.kind].label}: ${formatQuantity(block).text} ${unit}`)],
        row.unc === null ? ['Uncertainty', 'not given in the source'] : null,
        separate && row.unc !== null ? ['Combined uncertainty', `± ${formatDerived(block.value, row.unc).uncertainty} ${unit}`
          + (block.uncertainties.some((u) => u.source === 'total') ? '' : ' (components added in quadrature)')] : null,
        notes.length ? ['Uncertainty notes', notes.map((u) => `${u.source}: ${u.description}`).join('; ')] : null,
        block.huffFactor !== undefined ? ['Huff factor used in the source', String(block.huffFactor)] : null,
        entry.nuclide.mass === 0 ? ['Target', 'natural isotopic abundance'] : null,
        entry.nuclide.isomer ? ['Isomer', String(entry.nuclide.isomer)] : null,
        ['Key', entry.key],
        ['Comment', entry.comment],
      ]),
      h('h3', null, 'Converted'),
      conv ? kv([
        // the quantity given in the source is under Value already (unless it was given in another unit)
        ...QUANTITY_NAMES.filter((name) => name !== entry.observable.kind || block.unit !== QUANTITIES[name].unit)
          .map((name) => [QUANTITIES[name].label, `${derived(row, name)} ${unitText(name)}`]),
        ['Huff factor Q', `${conv.huff_factor} (${huffSource})`],
      ]) : h('p', { class: 'muted' }, 'This value cannot be converted.'),
      row.originals.length ? [h('h3', null, 'Derived from'),
        changedOriginals ? h('p', { class: 'notice warn changed-notice' }, changedOriginals === 1
          ? 'One of the entries this value was derived from has changed since. This value is to be checked again.'
          : `${changedOriginals} of the entries this value was derived from have changed since. This value is to be checked again.`) : null,
        h('ul', { class: 'id-list' }, row.originals.map((o) => idLink(o.id, o.changed)))] : null,
      usedBy.length ? [h('h3', null, 'Used by'), h('ul', { class: 'id-list' }, usedBy.map((r) => idLink(r.entry.datasetId)))] : null,
      row.code === 'EXP' ? [h('h3', null, 'Experimental conditions'), kv([
        ['Facility', facility ? `${meta.facility} — ${facility.detail}` : meta.facility],
        ['Method', meta.method], ['Beam', meta.beam], ['Target', meta.target], ['Detector', meta.detector], ['Comment', meta.comment],
      ])] : (meta.method || meta.comment || meta.referenceDatabase ? [h('h3', null, 'How the values were obtained'),
        kv([['Method', meta.method], ['Reference database', meta.referenceDatabase], ['Comment', meta.comment]])] : null),
      h('h3', null, 'Reference'),
      kv([
        ['Citation', reference ? citeText(reference, entry.bibId) : (isPlaceholderDoi(entry.bibId) ? 'Not published yet' : '')],
        ['Title', referenceTitle(reference)],
        ['Authors', authorList(reference)],
        ['DOI', doiUrl(entry.bibId) ? doiLink(entry.bibId) : `${entry.bibId} (placeholder: no public DOI)`],
        meta.relatedBibIds ? ['Related', h('span', null, meta.relatedBibIds.map((d, i) => [i ? ', ' : '', doiLink(d)]))] : null,
      ]),
      extra ? extra(row) : null,
      h('h3', null, 'Identifiers'),
      kv([
        ['DataID', h('code', null, entry.datasetId)],
        ['MetaID', h('code', null, entry.metaId)],
        entry.legacyIds ? ['Former DataIDs', h('code', null, entry.legacyIds.join(', '))] : null,
        ['Source file', h('span', null,
          externalLink(siteUrl(`${version.root}raw/${meta.file}`), meta.file), ' · ',
          externalLink(`https://github.com/${config.repository}/commits/${config.branch}/data/${meta.file}`, 'change history'))],
      ]),
      h('h3', null, 'How to cite'),
      h('p', { class: 'small', style: { margin: '0 0 6px' } }, 'The original reference above, the project paper and the database:'),
      citeBoxes(config, version, entryLink),
      h('details', null, h('summary', null, 'Entry as published (JSON)'),
        h('pre', { class: 'code' }, jsonfmt.stringify(entry)))));
  return row;
}
