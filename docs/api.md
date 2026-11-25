# API

The data of every published version as JSON files, one element, nuclide,
data entry or metadata record per file. The files are made when the site is
built: their addresses end in `.json` and take no query parameters. For
everything at once, use [Downloads](https://ribf.riken.jp/muon/downloads/).

`<version>` is `latest` (the development version) or a stable version `v1`,
`v2` … ([Versions and citing](versioning.md)).

```
https://ribf.riken.jp/muon/api/<version>/...
```

## Files

| Address relative to the site root | Content and path keys |
|---|---|
| [`api/versions.json`](https://ribf.riken.jp/muon/api/versions.json) | Use `versions[].label` for `<version>` in addresses. `default` is the default label. `versions[].version` is the descriptive version string. |
| `api/<version>/info.json` | Version, commit, date, citation, licence and sub-library counts. Resolve `files.LT` (the LT index) and `data` (the downloads directory) relative to this file. |
| `api/<version>/LT/index.json` | Resolve `elements[].file`, `elements[].nuclides[].file`, `sources[].file` and the values of `datasetTypes` relative to this index. Each source lists its MetaID, dataset type, bibId, short reference and entry count. |
| `api/<version>/LT/Si.json` | all entries of an element |
| `api/<version>/LT/Si-28.json` | all entries of a nuclide ([Si-28 in latest](https://ribf.riken.jp/muon/api/latest/LT/Si-28.json)) |
| `api/<version>/LT/Si-nat.json` | all entries of targets of natural isotopic abundance |
| `api/<version>/LT/evaluated.json` | all entries of one kind of data: `experiment`, `theory`, `curated` or `evaluated` (only the kinds that have data) |
| `api/<version>/LT/entry/e489422fdeb4.json` | one data entry, by its current DataID |
| `api/<version>/LT/meta/4d2ed5c83736.json` | one metadata record (MetaID) and all its entries |

The index uses `EXP`, `TH`, `CUR` and `EVAL` in element and nuclide `counts`,
including zero counts. The corresponding keys in `datasetTypes` are
`experiment`, `theory`, `curated` and `evaluated`, for kinds with entries.
In a file of entries, resolve `meta[].file` relative to `data/<version>/raw/`
at the site root.

Element symbols are written as in the periodic table (`Si`, not `si` or `SI`).
A file that does not exist is answered with HTTP status 404.
Former DataIDs have no API files. To resolve one, find it in an entry's
`legacyIds` in `data/<version>/LT.json` and use that entry's `datasetId`.

## Contents of a file of entries

All files of entries have the same form (`"format": "muND/api/LT/1"`):

| Member | Content |
|---|---|
| `label`, `version`, `kind`, `commit`, `date` | the version of the data; `kind`: `release` (a stable version) or `development` |
| `citation` | how to cite: `paper` (the project paper) and `database` (this version), in the style of Physical Review, as on the site. An entry file links to that entry in the Explorer. Cite the original reference of each value as well |
| `dataLicence` | the data licence, or `null` when none is specified |
| `selection` | what the file holds, for example `{"nuclide": "Si-28", "element": "Si", "z": 14, "mass": 28, "isomer": 0, "entries": 3}` |
| `bibliography` | the references of these entries |
| `meta` | the metadata records of these entries: experimental conditions or how the values were obtained |
| `data` | the entries as published in `LT.json` ([Data format](data-format.md#6-published-files)), each with one more member, `converted` |

`converted` holds the lifetime, capture rate and capture probability computed
from the value given in the source, and the Huff factor used, as in the CSV
columns of the same names ([Data format](data-format.md#derived-columns)); it is
`null` when the value cannot be converted:

```json
"converted": {
  "huff_factor": 0.9924, "huff_source": "nuclide",
  "lifetime_ns": 743.9, "lifetime_ns_unc": 5.0,
  "capture_rate_us-1": 0.892556, "capture_rate_us-1_unc": 0.00903526,
  "capture_probability_pct": 66.3972, "capture_probability_pct_unc": 0.225855
}
```

The value given in the source is the one in `observable`, with the digits
written in the source.

## Examples

Python, with the standard library only:

```python
import json
from urllib.request import urlopen

base = "https://ribf.riken.jp/muon/api/latest/LT/"
si28 = json.load(urlopen(base + "Si-28.json"))
for entry in si28["data"]:
    c = entry["converted"]
    if c is None:
        print(entry["datasetType"], "capture rate unavailable")
    else:
        print(entry["datasetType"], c["capture_rate_us-1"], c["capture_rate_us-1_unc"])
```

The CSV file of a version, with pandas:

```python
import pandas as pd

lt = pd.read_csv("https://ribf.riken.jp/muon/data/latest/csv/LT.csv")
evaluated = lt[lt.datasetType == "evaluated"]
```

The command line:

```sh
curl -s https://ribf.riken.jp/muon/api/latest/LT/evaluated.json | jq '.data[] | [.nuclide.element, .nuclide.mass, .converted."capture_rate_us-1"]'
```
