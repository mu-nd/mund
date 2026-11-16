"""muND (Muon Nuclear Data) database tools.

Pure-Python helpers used by the command line tool ``tools/mund.py`` and by CI:

* :mod:`mundlib.ids`       deterministic MetaID / DataID generation
* :mod:`mundlib.jsonfmt`   canonical, diff-friendly JSON reading and writing
* :mod:`mundlib.schema`    JSON Schema validation
* :mod:`mundlib.database`  loading the ``data/`` tree and semantic validation
* :mod:`mundlib.convert`   lifetime <-> capture rate <-> capture probability
* :mod:`mundlib.build`     building the distributable files and the web site

The same rules are implemented in JavaScript under ``site/assets/js/core`` for
the browser.  Shared test vectors in ``tests/vectors`` keep both in sync.
"""

SUBLIBRARIES = ("XR", "LT", "ES", "BR")
DATASETS = ("EXP", "TH", "CUR", "EVAL")

SUBLIBRARY_TITLES = {
    "XR": "Muonic X-ray energies and intensities",
    "LT": "Lifetimes of muonic atoms / nuclear capture rates",
    "ES": "Energy spectra of emitted particles",
    "BR": "Production branching ratios of residual nuclei",
}

# datasetType (as written in the files) -> code used in directory names and identifiers
DATASET_TYPES = {"experiment": "EXP", "theory": "TH", "curated": "CUR", "evaluated": "EVAL"}
DATASET_TYPE_OF = {code: name for name, code in DATASET_TYPES.items()}

DATASET_TITLES = {
    "EXP": "Experimental",
    "TH": "Theoretical",
    "CUR": "Curated",
    "EVAL": "Evaluated",
}

# Sub-libraries whose data format is defined so far.
DEFINED_SUBLIBRARIES = ("LT",)
