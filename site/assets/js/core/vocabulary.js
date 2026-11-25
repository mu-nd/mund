// Vocabulary of the database (twin of the constants in tools/mundlib/__init__.py).
//
//   sub-library  XR | LT | ES | BR
//   file         a metadata record (meta) and its data entries
//   entry        one element of data, identified by its datasetId
//   code         EXP | TH | CUR | EVAL, the short form of a file's datasetType
//                (experiment | theory | curated | evaluated) in directory names,
//                identifiers and short labels

export const SUBLIBRARIES = ['XR', 'LT', 'ES', 'BR'];
/** Sub-libraries with a defined data format. */
export const DEFINED_SUBLIBRARIES = ['LT'];

/** datasetType -> code */
export const CODE_OF = { experiment: 'EXP', theory: 'TH', curated: 'CUR', evaluated: 'EVAL' };
/** Dataset codes, in display order. */
export const CODES = Object.values(CODE_OF);
/** code -> datasetType */
export const TYPE_OF = Object.fromEntries(Object.entries(CODE_OF).map(([type, code]) => [code, type]));
export const CODE_TITLES = { EXP: 'Experimental', TH: 'Theoretical', CUR: 'Curated', EVAL: 'Evaluated' };
export const CODE_NOTES = {
  EXP: 'Values as published, not renormalised. Entries that muND corrected (for example a value listed under the wrong nuclide) are marked.',
  TH: 'Results of theoretical calculations.',
  CUR: 'Experimental values re-analysed on a common footing (for example converted again with the same Huff factors and constants for all); each entry is traced back to its experimental data.',
  EVAL: 'Recommended values obtained by evaluating experimental and theoretical information.',
};

/** Element names; index + 1 = Z. */
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

/** Numbers per dataset code ({EXP: 6, CUR: 4, EVAL: 5}) in words: '6 experimental, 4 curated, 5 evaluated'. */
export const countsInWords = (counts) => CODES.filter((d) => counts[d])
  .map((d) => `${counts[d]} ${CODE_TITLES[d].toLowerCase()}`).join(', ');

/** A number of entries in words: '1 entry', '12 entries'. */
export const entriesText = (n) => `${n} entr${n === 1 ? 'y' : 'ies'}`;

/** An element as named in a choice of elements (Explorer, Converter): '14 Si Silicon'. */
export const elementLabel = (z, symbol) => `${z} ${symbol} ${ELEMENT_NAMES[z - 1]}`;
