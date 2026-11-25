"""muND (Muon Nuclear Data) database tools, used by ``tools/mund.py`` and the automatic checks.

The browser has the same rules in ``site/assets/js/core``: ids, jsonfmt, schema, cite,
database and convert have a twin module of the same name there, and the constants below
have vocabulary.js; the test vectors in ``tests/vectors`` keep both in agreement.

Vocabulary of the database (twin of ``site/assets/js/core/vocabulary.js``)::

    sub-library  XR | LT | ES | BR
    file         a metadata record (meta) and its data entries
    entry        one element of data, identified by its datasetId
    code         EXP | TH | CUR | EVAL, the short form of a file's datasetType
                 (experiment | theory | curated | evaluated) in directory names,
                 identifiers and short labels
"""

SUBLIBRARIES = ("XR", "LT", "ES", "BR")
# sub-libraries whose data format is defined
DEFINED_SUBLIBRARIES = ("LT",)

SUBLIBRARY_TITLES = {
    "XR": "Muonic X-ray energies and intensities",
    "LT": "Lifetimes of muonic atoms / nuclear capture rates",
    "ES": "Energy spectra of emitted particles",
    "BR": "Production branching ratios of residual nuclei",
}

# datasetType -> code
CODE_OF = {"experiment": "EXP", "theory": "TH", "curated": "CUR", "evaluated": "EVAL"}
CODES = tuple(CODE_OF.values())
