// The panel with everything about one data entry: value, converted
// quantities, where it comes from, experimental conditions, reference,
// identifiers and how to cite it.

import { h, replace, nuclideNode, externalLink, stateLink } from '../core/dom.js';
import * as jsonfmt from '../core/jsonfmt.js';
import { siteUrl } from './site.js';
import { citeLabel, citeText, authorList, sourceUrl, referenceTitle } from '../core/cite.js';
import { quantityText, formatQuantity, formatUncertainty, formatConverted, formatHuffFactor, formatCorrection } from '../core/format.js';
import { OBSERVABLES, KINDS, UNIT_LABELS, unitLabel, HUFF_SOURCE_TEXT } from '../core/convert.js';
import { CODE_TITLES } from '../core/vocabulary.js';
import { icon } from './icons.js';
import { citeBoxes } from './citebox.js';

/** Qualifier for a natural target displayed under its effective isotope. */
export function naturalTargetNote(row) {
  return row.entry.nuclide.mass === 0 && row.a
    ? h('span', { class: 'muted small', title: 'Target of natural abundance' }, ' nat') : null;
}

/** A small warning tag in a note (`title` explains it where no notice does). */
export const noteTag = (label, title) => h('span', { class: 'tag warn', title }, label);
/** The tag on a value whose original data changed after it was derived from them. */
export const changedTag = (title) => noteTag('changed', title);

/**
 * Show the entry `id` in the panel `el` (an <aside class="detail">), or close
 * the panel when there is no such entry.
 * @param version      a version of model.js
 * @param config       site/config.json
 * @param link         (datasetId) => address of the page showing that entry
 * @param select       (datasetId) => void: show another entry ('' closes the panel)
 * @param permalinkOf  (row) => absolute address of the entry, with the version
 */
export function renderDetail(el, { version, config, id, link, select, permalinkOf }) {
  const { tables } = version;
  const row = id ? version.byId.get(id) : null;
  document.body.classList.toggle('has-detail', Boolean(row));
  el.hidden = !row;
  if (!row) { replace(el); return; }

  const { entry, meta, reference, block, conv } = row;
  const unit = UNIT_LABELS[block.unit];
  const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter((p) => p && p[1] !== null && p[1] !== undefined && p[1] !== '')
    .map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  const idLink = (target, changed = false) => {
    const found = version.byId.get(target);
    return h('li', null,
      stateLink({ href: link(target) }, () => select(target), h('code', null, target)),
      found ? [' ', nuclideNode(found.entry.nuclide.element, found.a), naturalTargetNote(found),
        ` ${quantityText(found.block)}`,
        ` · ${citeLabel(found.reference, found.entry.bibId)}`] : ' (not in this version)',
      changed ? [' ', changedTag()] : null);
  };
  const bibLink = (bibId, reference = null) => {
    const url = sourceUrl(bibId, reference);
    return url ? externalLink(url, bibId) : bibId;
  };
  const usedBy = version.usedBy.get(entry.datasetId) || [];
  const changedOriginals = row.originals.filter((o) => o.changed).length;
  const facility = tables.facilities.get(meta.facility);
  const componentsOnly = block.uncertainties.length && block.uncertainties.every((u) => u.source !== 'total');
  const notes = block.uncertainties.filter((u) => u.description);
  const entryLink = permalinkOf(row);

  replace(el,
    h('div', { class: 'detail-head' },
      h('h2', { tabindex: '-1' }, nuclideNode(entry.nuclide.element, row.a), naturalTargetNote(row), ` · ${CODE_TITLES[row.code]}`),
      h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close details', onclick: () => select('') }, icon('x'))),
    h('div', { class: 'detail-body' },
      h('h3', null, 'Value'),
      kv([
        ['Given in the source', h('strong', null, `${OBSERVABLES[entry.observable.kind].label}: ${quantityText(block)}`)],
        !block.uncertainties.length ? ['Uncertainty', 'not given in the source'] : null,
        componentsOnly && row.unc !== null
          ? ['Combined uncertainty', `± ${formatUncertainty(row.unc)} ${unit} (components added in quadrature)`] : null,
        notes.length ? ['Uncertainty notes', notes.map((u) => `${u.source}: ${u.description}`).join('; ')] : null,
        block.huffFactor !== undefined ? ['Huff factor used in the source', jsonfmt.numberText(block, 'huffFactor')] : null,
        entry.nuclide.isomer ? ['Isomer', String(entry.nuclide.isomer)] : null,
        ['Key', entry.key],
        ['Note', entry.comment],
      ]),
      (entry.corrections || []).length ? [h('h3', null, 'Corrections'),
        h('ul', { class: 'small' }, entry.corrections.map((c) => h('li', null, formatCorrection(c))))] : null,
      h('h3', null, 'Converted'),
      conv ? kv([
        // the quantity given in the source is under Value already (unless it was given in another unit)
        ...KINDS.filter((kind) => kind !== entry.observable.kind || block.unit !== OBSERVABLES[kind].unit)
          .map((kind) => [OBSERVABLES[kind].label, `${kind === entry.observable.kind ? formatQuantity(block, row.unitScale) : formatConverted(conv, kind)} ${unitLabel(kind)}`]),
        ['Huff factor Q', `${formatHuffFactor(conv.huff_factor)} — ${HUFF_SOURCE_TEXT[conv.huff_source]}`],
      ]) : h('p', { class: 'muted' }, 'This value cannot be converted.'),
      row.originals.length ? [h('h3', null, 'Derived from'),
        changedOriginals ? h('p', { class: 'notice warn small' }, changedOriginals === 1
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
        ['Citation', reference ? citeText(reference, entry.bibId) : ''],
        ['Title', referenceTitle(reference)],
        ['Authors', authorList(reference)],
        ['Source', bibLink(entry.bibId, reference)],
        meta.relatedBibIds ? ['Related', h('span', null, meta.relatedBibIds.map((d, i) => [i ? ', ' : '', bibLink(d)]))] : null,
      ]),
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
      h('p', { class: 'small' }, 'The original reference above, the project paper and the database:'),
      citeBoxes(config, version, entryLink, entry.datasetId),
      h('details', null, h('summary', null, 'Entry as published (JSON)'),
        // a tab stop, so that the keyboard can scroll it, also in the panel's Tab loop (explorer.js)
        h('pre', { class: 'code', tabindex: 0 }, jsonfmt.stringify(entry)))));
}
