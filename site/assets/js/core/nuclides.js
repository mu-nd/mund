// Look-up tables built from data/master/nuclides.json.

import { objects } from './jsonfmt.js';

/**
 * @param nuclides  content of nuclides.json: { elements, isotope_ranges, monoisotopic }
 * @returns {{elements: string[], zOf: Map, ranges: Map, monoisotopic: Map}}
 *   elements      element symbols (index + 1 = Z)
 *   zOf           symbol -> Z
 *   ranges        Z -> [smallest, largest mass number offered]
 *   monoisotopic  Z -> mass number of the only stable isotope
 */
export function nuclideTables(nuclides) {
  const elements = Array.isArray(nuclides.elements) ? nuclides.elements : [];
  return {
    elements,
    zOf: new Map(elements.map((e, i) => [e, i + 1])),
    ranges: new Map(objects(nuclides.isotope_ranges)
      .filter((r) => [r.z, r.a_min, r.a_max].every((v) => typeof v === 'number'))
      .map((r) => [r.z, [r.a_min, r.a_max]])),
    monoisotopic: new Map(objects(nuclides.monoisotopic).map((r) => [r.z, r.a])),
  };
}

/**
 * Mass number used for display and look-ups: a target of natural abundance
 * (mass 0) of an element with a single stable isotope is that isotope.
 */
export function effectiveMass(z, mass, monoisotopic) {
  if (mass > 0) return mass;
  return (monoisotopic && monoisotopic.get(z)) || 0;
}
