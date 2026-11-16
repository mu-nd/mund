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
  XR/  ES/  BR/       sub-libraries in preparation (format not defined yet)
  master/             tables shared by all files
    bibliography.json references by DOI (cached from Crossref)
    facilities.json   muon facilities and beam lines
    nuclides.json     element symbols, isotope ranges, mono-isotopic elements
    huff_factors.json Huff factors used to convert lifetime <-> capture rate
    constants.json    physical constants (free muon lifetime)
```

* Format of the files: [`docs/data-format.md`](../docs/data-format.md),
  schema in [`schema/v1`](../schema/v1).
* File names are `<FirstAuthor><Year>_<MetaID>.json`. The part before the
  underscore is only a reading aid.
* Do not edit by hand unless you have to: the
  [data entry tool](../docs/admin-guide.ja.md) computes the identifiers, keeps
  the layout canonical and checks everything before it commits.
  After a manual edit run `python3 tools/mund.py ids <file>` and
  `python3 tools/mund.py validate`.
