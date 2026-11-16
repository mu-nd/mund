# muND data format

How the database is stored in this repository, and what is published from it.
The authoritative, machine-readable description is the JSON Schema in
[`schema/v1`](../schema/v1); this document explains it.

Status: **LT is defined** (format `muND/LT/1`). XR, ES and BR have no format
yet; nothing below should be read as a decision for them.

The names and the nesting of a data entry — `datasetId`, `datasetType`,
`nuclide`, `observable` (`kind`, `value`, `unit`, `uncertainties` with their
`source`), `bibId` and the reference to the experimental condition — follow
the JSON Schema drafted for muND by S. Kawase
([shkawase/mund](https://github.com/shkawase/mund)). This format adds what
was decided later: short deterministic identifiers instead of UUIDs, one
metadata record per publication, `key`, `originalData`.

## 1. Model

```
sub-library   XR | LT | ES | BR          (XEI | NCR | ESP | RPB in earlier documents)
datasetType   experiment | theory | curated | evaluated      (directories EXP | TH | CUR | EVAL)
metadata      one record per publication (per set-up, if a key is used)   -> MetaID
data entry    one quantity of one nuclide, refers to a metadata record     -> datasetId (DataID)
bibliography  one record per DOI (bibId), cached from Crossref
```

Data, metadata ("experimental condition") and bibliography are separate
records linked by identifiers ([`id-definition.md`](id-definition.md)). In the
repository a metadata record and the data entries that belong to it are stored
together in one file, so that "one publication = one file = one commit"; in
the published files every entry is self-contained (section 6).

The four dataset types are different kinds of data, not stages of one record:

* **experiment** — values exactly as published: of lifetime, capture rate and
  capture probability, the one quantity closest to what the publication gives.
* **theory** — values calculated with a theoretical model.
* **curated** — published experimental data re-analysed on a common footing
  (for example renormalised with one Huff factor), given as capture rates.
  Every curated value names the experimental entries it comes from
  (`originalData`).
* **evaluated** — recommended values, given as capture rates.

## 2. Repository layout

```
data/LT/EXP/Suzuki1987_96f2c4a2ddaf.json      <FirstAuthor><Year>_<MetaID>.json
data/LT/CUR/unpublished_591344c27b81.json
data/LT/EVAL/Iwamoto2025_c93df5b12b00.json
data/master/bibliography.json                  references, by DOI
data/master/facilities.json                    facilities and beam lines
data/master/huff_factors.json, nuclides.json, constants.json     parameters
schema/v1/lt.schema.json, bibliography.schema.json, facilities.schema.json
```

The part of the file name before the underscore is a reading aid (first
author and year, or the last part of the DOI). Only the MetaID identifies the
file.

## 3. An LT file

```json
{
  "format": "muND/LT/1",
  "sublibrary": "LT",
  "datasetType": "experiment",
  "meta": {
    "id": "dcb3b051457e",
    "bibId": "10.1103/vl7z-rzp8",
    "relatedBibIds": ["10.48550/arXiv.2501.05897"],
    "facility": "J-PARC (D1)",
    "method": "electron",
    "beam": "…",
    "target": "…",
    "detector": "…"
  },
  "data": [
    {"datasetId": "e2551c5951a7", "nuclide": {"element": "Si", "mass": 28, "isomer": 0}, "observable": {"kind": "lifetime", "lifetime": {"value": 743.9, "unit": "ns", "uncertainties": [{"source": "total", "value": 5.0}]}}},
    {"datasetId": "4abe86ca167b", "nuclide": {"element": "Si", "mass": 0, "isomer": 0}, "observable": {"kind": "lifetime", "lifetime": {"value": 751.6, "unit": "ns", "uncertainties": [{"source": "statistical", "value": 0.8}, {"source": "systematic", "value": 0.7}]}}, "key": "plate", "comment": "Target: self-supported plate"}
  ]
}
```

(The second entry is written with separate uncertainties only to show the
form.)

### Metadata (`meta`)

| member | | meaning |
|---|---|---|
| `id` | required | MetaID (takes the place of `experimentalConditionId` in the schema draft) |
| `bibId` | required | main reference: its DOI, without `https://doi.org/`. Sources without DOI: placeholder `10.1000/mund.<name>` |
| `key` | optional | separates several metadata records of one publication |
| `relatedBibIds` | optional | arXiv version, erratum, data repository … |
| `facility` | experiment only, required | short name from `data/master/facilities.json` (`Unknown` exists) |
| `method` | optional | experiment: what was detected (electron, gamma, neutron, charged particle, fission fragment); theory: model or code; curated / evaluated: procedure |
| `beam`, `target`, `detector` | experiment only, optional | free text |
| `referenceDatabase` | evaluated only, optional | the set of curated data the evaluation is based on |
| `comment` | optional | free text: corrections, reference data, caveats |

### Data entry (`data[]`)

| member | | meaning |
|---|---|---|
| `datasetId` | required | DataID |
| `nuclide` | required | `element`, `mass` (mass number A; **0 = target of natural isotopic abundance**), `isomer` (0 = ground state) |
| `observable` | required | `kind` and, under the name of the kind, the value block (below) |
| `key` | optional | separates entries of the same nuclide in this file |
| `comment` | optional | free text |
| `originalData` | curated: required, evaluated: optional | datasetIds this value was derived from (curated: experimental entries) |
| `legacyIds` | optional | identifiers this entry had before |

### Value block (`observable.<kind>`)

| member | | meaning |
|---|---|---|
| `value` | required | number, written with the digits given in the source |
| `unit` | required | see the table below |
| `uncertainties` | required | list of `{source, value, description?}`; symmetric, one standard deviation. `source` is `total`, `statistical`, `systematic` or `other`. A single overall uncertainty has the source `total`; statistical and systematic uncertainties are listed separately when the source separates them; the list is empty when the source gives no uncertainty |
| `huffFactor` | optional | Huff factor the source used to convert between lifetime and capture rate (information only) |

| `kind` | meaning | `unit` |
|---|---|---|
| `lifetime` | total lifetime of the muonic atom, τ | `ns`, `us` |
| `capture_rate` | total nuclear capture rate, Λcap | `us-1`, `ms-1`, `s-1` |
| `capture_probability` | fraction of muons captured, Bcap | `%` |

Units are written in ASCII: `us` is the microsecond, `us-1` is per
microsecond. The explorer shows them as µs and µs⁻¹.

Wherever one overall uncertainty is needed (converted quantities, charts, the
`uncertainty` column of the CSV files), the `total` entry is used if there is
one; otherwise the listed components are added in quadrature.

Asymmetric uncertainties, limits and covariances are not part of format 1.

### Bibliography (`data/master/bibliography.json`)

```json
{
  "format": "muND/bibliography/1",
  "references": [
    {"DOI": "10.1103/PhysRevC.35.2212", "type": "journal-article", "author": [{"family": "Suzuki", "given": "T."}, {"family": "Measday", "given": "D. F."}, {"family": "Roalsvig", "given": "J. P."}], "title": ["Total nuclear capture rates for negative muons"], "container-title": ["Physical Review C"], "short-container-title": ["Phys. Rev. C"], "volume": "35", "issue": "6", "page": "2212-2224", "published": {"date-parts": [[1987, 6, 1]]}}
  ]
}
```

An entry is a cached subset of the Crossref record of the DOI and keeps
Crossref's member names and shapes (`title` and `container-title` are lists,
the date is `published.date-parts`). A source without DOI gets a hand-made
entry of the same shape under its placeholder DOI. The data entry tool fills
the cache when a DOI is looked up, so the published site does not depend on
Crossref.

## 4. Canonical layout

Files are written in exactly one way, so that a git diff shows only what
really changed (`python3 tools/mund.py format`; the data entry tool does it
automatically):

1. UTF-8, two spaces of indentation, a newline at the end of the file.
2. An object is written with one member per line.
3. An array of plain values is written on one line.
4. Any other array has one element per line, and that element is written on a
   single line — hence **one data entry per line** and one reference per line.
5. Members appear in the order of the schema; optional members that are empty
   are left out.
6. **Numbers are written as they were typed.** `13.250` stays `13.250`, so
   the precision stated in the source is preserved. The files remain standard
   JSON: an ordinary JSON parser simply reads the number 13.25.

## 5. Checks

`python3 tools/mund.py validate` (run automatically for every change):

| code | meaning |
|---|---|
| `E_JSON`, `E_CANONICAL` | not JSON / not in canonical layout |
| `E_SCHEMA` | does not follow the JSON Schema (unknown element, unit that does not fit the kind, missing member …) |
| `E_PATH` | wrong directory or file name |
| `E_META_ID`, `E_DATA_ID` | identifier does not match its definition |
| `E_DUPLICATE_ID`, `E_DUPLICATE_META` | identifier used twice (give the entries different keys) |
| `E_ORIGINAL_MISSING`, `E_ORIGINAL_NOT_EXP`, `E_ORIGINAL_SELF` | `originalData` does not resolve |
| `E_UNCERTAINTY_TOTAL` | more than one uncertainty with the source `total` |
| `E_FACILITY`, `E_DUPLICATE_FACILITY`, `E_DUPLICATE_REFERENCE` | facility not in the master list / listed twice; DOI listed twice in the bibliography |
| `W_NO_REFERENCE`, `W_MASS_RANGE` | warnings: no bibliography entry for the `bibId`; unusual mass number |

The same checks run in the browser (data entry tool); both implementations
are tested against the cases in `tests/vectors/cases.json`.

## 6. Published files

The web site is built from this repository
(`python3 tools/mund.py build`). For every version it offers

| file | content |
|---|---|
| `data/<version>/manifest.json` | version, commit, counts, list of files with SHA-256 |
| `data/<version>/LT.json` | all LT data in one file: `data` (entries), `meta` (metadata records), `bibliography` |
| `data/<version>/csv/LT.csv`, `LT_EXP.csv` … | flat tables, with lifetime, capture rate and capture probability derived for every row |
| `data/<version>/master.json` | master tables |
| `data/<version>/raw/…` | the source files exactly as stored here |
| `data/<version>/mund-<version>.zip` | all of the above and the schema |

`<version>` is `latest` or a released major version (`v1`, `v2` …), see
[`versioning.md`](versioning.md).

In `LT.json` every entry is self-contained:

```json
{"datasetId": "e2551c5951a7", "datasetType": "experiment", "metaId": "dcb3b051457e", "bibId": "10.1103/vl7z-rzp8", "nuclide": {"element": "Si", "mass": 28, "isomer": 0}, "observable": {"kind": "lifetime", "lifetime": {"value": 743.9, "unit": "ns", "uncertainties": [{"source": "total", "value": 5.0}]}}}
```

`metaId` names the metadata record of the entry (in `meta`), for all four
dataset types.

### Derived columns

```
1 / τ = Λcap + Q / τμ+          Bcap = Λcap / (Λcap + Q / τμ+)
```

Q is the Huff factor from `data/master/huff_factors.json` (value for the
nuclide if tabulated, else the element average, else 1) and τμ+ the free
muon lifetime from `data/master/constants.json`. Uncertainties are propagated
to first order; those of Q and τμ+ are neglected.
