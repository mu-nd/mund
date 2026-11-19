# data/ — the database

Everything under this directory *is* the muND database. The files are plain
JSON, one data entry per line, so that every change can be reviewed as a git
diff.

```
data/
  LT/                 lifetimes of muonic atoms / nuclear capture rates
    EXP/              experimental data, one file per publication
    TH/               theoretical data
    CUR/              curated data (traced back to EXP)
    EVAL/             evaluated (recommended) data
  master/             tables shared by all files
    bibliography.json references by DOI (cached from Crossref)
    facilities.json   muon facilities and beam lines
    nuclides.json     element symbols, isotope ranges, mono-isotopic elements
    huff_factors.json Huff factors used to convert lifetime <-> capture rate
    constants.json    physical constants (free muon lifetime)
```

* Only the LT sub-library has a defined format. Files of XR, ES and BR are
  refused by the validation until their formats are defined.
* Format of the files: [`docs/data-format.md`](../docs/data-format.md),
  schema in [`schema/v1`](../schema/v1).
* File names are `<FirstAuthor><Year>_<MetaID>.json`. The part before the
  underscore is only a reading aid.
* Edit with the [data entry tool](../docs/admin-guide.ja.md) (`pixi run admin`): it computes the
  identifiers, keeps the files in canonical form, checks everything before it
  commits, and — when an element, mass number, key, DOI or datasetType
  changes — asks whether it is a correction of the same record (the former
  identifier goes into `legacyIds` and the `originalData` that referred to it
  are updated) or different data (nothing is carried over).
* `data/` holds approved data only. Values being transcribed from a paper are
  kept apart until they have been compared and approved.
* The MIT licence of this repository covers the software; the licence of the
  data has not been decided yet.
* After an edit by hand run `python3 tools/mund.py fix <file>` (identifiers,
  canonical form, file name) and `python3 tools/mund.py validate`.
