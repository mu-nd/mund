"""muND (Muon Nuclear Data) database tools.

Used by the command line tool ``tools/mund.py`` and by the automatic checks:

* :mod:`mundlib.ids`       MetaID and DataID
* :mod:`mundlib.jsonfmt`   canonical JSON that keeps the written digits of numbers
* :mod:`mundlib.schema`    JSON Schema validation and normalisation
* :mod:`mundlib.cite`      file labels and citation texts from bibliography entries
* :mod:`mundlib.database`  the files under ``data/`` and their checks
* :mod:`mundlib.convert`   lifetime <-> capture rate <-> capture probability
* :mod:`mundlib.build`     the published data files and the web site

The browser has the same rules in ``site/assets/js/core`` (one module of the
same name for each of the first six); the test vectors in ``tests/vectors``
keep both in agreement.

Words used throughout:

* *file*   one publication: a metadata record (``meta``) and its data entries
* *entry*  one element of ``data``, identified by its ``datasetId``
* *code*   ``EXP`` | ``TH`` | ``CUR`` | ``EVAL``, the short form of a file's
  ``datasetType`` (``experiment`` | ``theory`` | ``curated`` | ``evaluated``)
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
