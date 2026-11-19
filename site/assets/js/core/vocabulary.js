// Vocabulary of the database (twin of the constants in tools/mundlib/__init__.py).
//
//   sub-library    XR | LT | ES | BR
//   dataset type   experiment | theory | curated | evaluated   as written in the files (datasetType)
//   dataset code   EXP | TH | CUR | EVAL                       directory names, identifiers, short labels

export const SUBLIBRARIES = ['XR', 'LT', 'ES', 'BR'];
/** Sub-libraries with a defined data format. */
export const DEFINED_SUBLIBRARIES = ['LT'];

/** Dataset codes, in display order. */
export const CODES = ['EXP', 'TH', 'CUR', 'EVAL'];
export const CODE_OF = { experiment: 'EXP', theory: 'TH', curated: 'CUR', evaluated: 'EVAL' };
export const TYPE_OF = { EXP: 'experiment', TH: 'theory', CUR: 'curated', EVAL: 'evaluated' };
export const CODE_TITLES = { EXP: 'Experimental', TH: 'Theoretical', CUR: 'Curated', EVAL: 'Evaluated' };
export const CODE_NOTES = {
  EXP: 'Values as published. Nothing is corrected or renormalised.',
  TH: 'Results of theoretical calculations.',
  CUR: 'Experimental values re-analysed on a common footing (for example with one Huff factor); each entry is traced back to its experimental data.',
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

/** An element as named in a choice of elements (Explorer, Converter): '14 Si Silicon'. */
export const elementLabel = (z, symbol) => `${z} ${symbol} ${ELEMENT_NAMES[z - 1]}`;
