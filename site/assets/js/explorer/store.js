// Loading of the built data (data/<version>/...) for the explorer.

import { fetchJson, fetchText } from '../core/dom.js';
import * as jsonfmt from '../core/jsonfmt.js';
import { Physics, combinedUncertainty } from '../core/convert.js';
import { effectiveMass } from '../core/format.js';
import { normalizeDoi } from '../core/ids.js';

export const ELEMENT_NAMES = ('Hydrogen Helium Lithium Beryllium Boron Carbon Nitrogen Oxygen Fluorine Neon '
  + 'Sodium Magnesium Aluminium Silicon Phosphorus Sulfur Chlorine Argon Potassium Calcium Scandium Titanium '
  + 'Vanadium Chromium Manganese Iron Cobalt Nickel Copper Zinc Gallium Germanium Arsenic Selenium Bromine '
  + 'Krypton Rubidium Strontium Yttrium Zirconium Niobium Molybdenum Technetium Ruthenium Rhodium Palladium '
  + 'Silver Cadmium Indium Tin Antimony Tellurium Iodine Xenon Caesium Barium Lanthanum Cerium Praseodymium '
  + 'Neodymium Promethium Samarium Europium Gadolinium Terbium Dysprosium Holmium Erbium Thulium Ytterbium '
  + 'Lutetium Hafnium Tantalum Tungsten Rhenium Osmium Iridium Platinum Gold Mercury Thallium Lead Bismuth '
  + 'Polonium Astatine Radon Francium Radium Actinium Thorium Protactinium Uranium Neptunium Plutonium '
  + 'Americium Curium Berkelium Californium Einsteinium Fermium Mendelevium Nobelium Lawrencium Rutherfordium '
  + 'Dubnium Seaborgium Bohrium Hassium Meitnerium Darmstadtium Roentgenium Copernicium Nihonium Flerovium '
  + 'Moscovium Livermorium Tennessine Oganesson').split(' ');

export const DATASETS = ['EXP', 'TH', 'CUR', 'EVAL'];
export const DATASET_TYPES = { experiment: 'EXP', theory: 'TH', curated: 'CUR', evaluated: 'EVAL' };
export const SUBLIBRARIES = ['XR', 'LT', 'ES', 'BR'];
export const SUBLIBRARY_SHORT = { XR: 'μX-ray', LT: 'Lifetime', ES: 'Energy spectrum', BR: 'Branching ratio' };

const base = new URL('../../../', import.meta.url); // site root

export const siteUrl = (path) => new URL(path, base).href;

export async function loadConfig() {
  try {
    return await fetchJson(siteUrl('config.json'));
  } catch (err) {
    return { repository: 'niikura-muon/mund', branch: 'main' };
  }
}

export async function loadVersions() {
  return fetchJson(siteUrl('data/versions.json'));
}

// Formats of the built files this page can read.  When the shape of
// manifest.json or <sub-library>.json changes, the number in their "format"
// changes and the new number is added here (older ones stay: released versions
// keep the format they were built with).
const MANIFEST_FORMATS = ['muND/manifest/1'];
const DIST_FORMATS = { LT: ['muND/dist/LT/1'] };

/** The page is older than the data (cached scripts right after an update of the site). */
export class OutdatedPageError extends Error {
  constructor(format) {
    super(`the data are in a format this page does not know (${format})`);
    this.name = 'OutdatedPageError';
    this.outdated = true;
  }
}

const cache = new Map();

/** Everything the explorer needs for one version of the data. */
export function loadVersion(label) {
  if (!cache.has(label)) cache.set(label, load(label));
  return cache.get(label);
}

async function load(label) {
  const root = `data/${label}/`;
  const [manifest, masterText] = await Promise.all([
    fetchJson(siteUrl(`${root}manifest.json`)),
    fetchText(siteUrl(`${root}master.json`)),
  ]);
  if (!MANIFEST_FORMATS.includes(manifest.format)) throw new OutdatedPageError(manifest.format);
  const master = jsonfmt.parse(masterText);
  const elements = master.nuclides.elements;
  const tables = {
    elements,
    zOf: new Map(elements.map((e, i) => [e, i + 1])),
    monoisotopic: new Map((master.nuclides.monoisotopic || []).map((r) => [r.z, r.a])),
    ranges: new Map((master.nuclides.isotope_ranges || []).map((r) => [r.z, [r.a_min, r.a_max]])),
    facilities: new Map((master.facilities.facilities || []).map((f) => [f.abbr, f])),
  };
  const physics = new Physics(master.huff_factors, master.constants);
  const version = { label, root, manifest, master, tables, physics, libraries: {} };

  for (const [sub, info] of Object.entries(manifest.sublibraries)) {
    if (info.status !== 'available') continue;
    const agg = jsonfmt.parse(await fetchText(siteUrl(`${root}${sub}.json`)));
    if (!(DIST_FORMATS[sub] || []).includes(agg.format)) throw new OutdatedPageError(agg.format);
    const metas = new Map(agg.meta.map((m) => [m.id, m]));
    const references = new Map((agg.bibliography || []).map((r) => [normalizeDoi(r.DOI), r]));
    const byId = new Map();
    const usedBy = new Map(); // datasetId -> rows that list it as original data
    // One row per data entry: the entry itself (as published) plus what the
    // pages need for filtering, sorting and conversion.
    const rows = agg.data.map((entry) => {
      const nuclide = entry.nuclide || {};
      const kind = entry.observable ? entry.observable.kind : undefined;
      const block = (entry.observable && entry.observable[kind]) || { uncertainties: [] };
      const z = tables.zOf.get(nuclide.element) || 0;
      const unc = combinedUncertainty(block.uncertainties);
      const meta = metas.get(entry.metaId) || {};
      return {
        entry,
        id: entry.datasetId,
        dataset: DATASET_TYPES[entry.datasetType],
        metaId: entry.metaId,
        meta,
        reference: references.get(normalizeDoi(entry.bibId || '')) || null,
        element: nuclide.element,
        z,
        mass: nuclide.mass,
        isomer: nuclide.isomer || 0,
        a: effectiveMass(z, nuclide.mass, tables.monoisotopic),
        kind,
        block,
        unit: block.unit,
        unc,
        conv: physics.convert(z, nuclide.mass, kind, block.value, unc, block.unit),
      };
    });
    for (const row of rows) {
      byId.set(row.id, row);
      for (const legacy of row.entry.legacyIds || []) if (!byId.has(legacy)) byId.set(legacy, row);
    }
    for (const row of rows) {
      for (const oid of row.entry.originalData || []) {
        if (!usedBy.has(oid)) usedBy.set(oid, []);
        usedBy.get(oid).push(row);
      }
    }
    version.libraries[sub] = { rows, metas, references, byId, usedBy };
  }
  return version;
}
