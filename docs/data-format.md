# Data format

How the database is stored in this repository, and what is published from it.
The authoritative, machine-readable description is the JSON Schema in
[`schema/v1`](../schema/v1); this document explains it.

This document covers the LT sub-library (format `muND/LT/1`), the only one
with a defined format.

## 1. Model

```
sub-library   XR | LT | ES | BR
datasetType   experiment | theory | curated | evaluated      (directories EXP | TH | CUR | EVAL)
metadata      one record per publication and dataset type (per set-up, if a key is used)   -> MetaID
data entry    one quantity of one nuclide, refers to a metadata record                     -> datasetId (DataID)
bibliography  one record per source (bibId), cached from Crossref or DataCite for a DOI
```

Data, metadata ("experimental condition") and bibliography are separate
records linked by identifiers ([Identifiers](id-definition.md)). In the
repository a metadata record and the data entries that belong to it are stored
together in one file; in the published files every entry is self-contained
(section 6).

The four dataset types are different kinds of data, not stages of one record:

* **experiment** — values exactly as published: of lifetime, capture rate and
  capture probability, the one quantity closest to what the publication gives.
* **theory** — values calculated with a theoretical model.
* **curated** — published experimental data re-analysed on a common footing
  (for example converted again with the same Huff factors and constants for
  all), given as capture rates.
  Every curated value names the experimental entries it comes from
  (`originalData`).
* **evaluated** — recommended values, given as capture rates.

## 2. Repository layout

```
data/LT/EXP/Suzuki1987_6c7ebc35077d.json      <FirstAuthor><Year>_<MetaID>.json
data/LT/CUR/unpublished_15fd4fea826c.json
data/LT/EVAL/Iwamoto2025_194f28ccc0dc.json
data/master/bibliography.json                  references, by bibId
data/master/facilities.json                    facilities and beam lines
data/master/nuclides.json                      element symbols, mass-number ranges
data/master/huff_factors.json                  Huff factors Q of the conversions
data/master/constants.json                     free muon lifetime mu_plus_lifetime (ns)
schema/v1/<name>.schema.json                   one schema per kind of file
```

| file | `format` | schema |
|---|---|---|
| `data/LT/**` | `muND/LT/1` | `lt.schema.json` |
| `data/master/bibliography.json` | `muND/bibliography/1` | `bibliography.schema.json` |
| `data/master/facilities.json` | `muND/facilities/1` | `facilities.schema.json` |
| `data/master/nuclides.json` | `muND/nuclides/1` | `nuclides.schema.json` |
| `data/master/huff_factors.json` | `muND/huff-factors/1` | `huff-factors.schema.json` |
| `data/master/constants.json` | `muND/constants/2` | `constants.schema.json` |

In `<label>_<MetaID>.json`, the label is a reading aid, usually the first
author and year. It must match
`[A-Za-z0-9][A-Za-z0-9.-]*`. The first character is an ASCII letter or
digit. Subsequent characters may also be dots or hyphens. Only the MetaID
identifies the file.

## 3. An LT file

`data/LT/EXP/Mizuno2025_4d2ed5c83736.json`, shortened to two of its entries:

```json
{
  "format": "muND/LT/1",
  "sublibrary": "LT",
  "datasetType": "experiment",
  "meta": {
    "id": "4d2ed5c83736",
    "bibId": "DOI:10.1103/vl7z-rzp8",
    "relatedBibIds": ["DOI:10.48550/arXiv.2501.05897"],
    "facility": "J-PARC (D1)",
    "method": "electron",
    "beam": "…",
    "target": "…",
    "detector": "…"
  },
  "data": [
    {"datasetId": "dd91adba8444", "nuclide": {"element": "Al", "mass": 27, "isomer": 0}, "observable": {"kind": "lifetime", "lifetime": {"value": 863.7, "unit": "ns", "uncertainties": [{"source": "total", "value": 1.0}]}}, "key": "plate", "comment": "Target: self-supported plate", "legacyIds": ["343adc036597"]},
    {"datasetId": "e489422fdeb4", "nuclide": {"element": "Si", "mass": 28, "isomer": 0}, "observable": {"kind": "lifetime", "lifetime": {"value": 743.9, "unit": "ns", "uncertainties": [{"source": "total", "value": 5.0}]}}, "legacyIds": ["e2551c5951a7"]}
  ]
}
```

### Metadata (`meta`)

| member | | meaning |
|---|---|---|
| `id` | required | MetaID |
| `bibId` | required | main reference, as a bibId (`DOI:…`, `NSR:…` or `muND:…`, [definition](id-definition.md#4-sources-bibid)) |
| `key` | optional | separates several metadata records of one publication |
| `relatedBibIds` | optional | arXiv version, erratum, data repository … (the same forms as `bibId`) |
| `facility` | experiment only, required | short name from `data/master/facilities.json` (`Unknown` exists) |
| `method` | optional | experiment: what was detected (electron, gamma, neutron, charged particle, fission fragment); theory: model or code; curated / evaluated: procedure, including the constants and Huff factors it used |
| `beam`, `target`, `detector` | experiment only, optional | short summaries written for this database from the source — not quotations and not the source itself |
| `software` | theory, curated, evaluated; optional | program and version that produced the values |
| `referenceDatabase` | evaluated only, optional | the set of curated data the evaluation is based on |
| `comment` | optional | free text: corrections, reference data, caveats |

### Data entry (`data[]`)

| member | | meaning |
|---|---|---|
| `datasetId` | required | DataID |
| `nuclide` | required | `element`, `mass` (mass number A; **0 = target of natural isotopic abundance**), `isomer` (0 = ground state; format 1 holds ground states only) |
| `observable` | required | `kind` and, under the name of the kind, the value block (below). Experiment and theory keep the quantity of the source; curated and evaluated entries are `capture_rate` |
| `key` | optional | separates entries of the same nuclide in this file |
| `comment` | optional | free text |
| `originalData` | curated: required, evaluated: optional | the entries this value was derived from (curated: experimental entries), each as `{datasetId, entryHash}` — see below |
| `legacyIds` | optional | former DataIDs that resolve to this entry in the Explorer. The API publishes an entry file only for the current `datasetId` |
| `corrections` | optional | corrections made after the entry was first recorded — see below |

**Inputs of derived values.** `entryHash` is the content hash of the original
entry (its `nuclide` and `observable` as written; definition in
[Identifiers](id-definition.md)) at the time the derived value was made
from it. When the original is corrected later — same `datasetId`, other
content — the check `W_ORIGINAL_CHANGED` names the derived entries that must be
checked again; after checking, the new `entryHash` is recorded. A comment does
not change the hash.

**Corrections.** An entry shows its corrected content. Each record in
`corrections` keeps `date`, `pointer` (the member, e.g. `/nuclide/element`),
`before`, `after`, `reason`, `checkedAgainstSource` (`false`: the correction
has not been checked against the publication yet) and, when the correction gave
the entry a new identifier that is not kept in `legacyIds`, `formerId`.
The values of `before` and `after` keep their strings, members and written numbers.
Within these values, object keys that are array indices come first in numeric
order. Other keys follow in UTF-16 code unit order.
The explorer marks a corrected entry and lists its corrections in the entry's details.

### Value block (`observable.<kind>`)

| member | | meaning |
|---|---|---|
| `value` | required | number, written with the digits given in the source |
| `unit` | required | see the table below |
| `uncertainties` | required | list of `{source, value, description?}`; see below |
| `huffFactor` | optional | Huff factor the source used to convert between lifetime and capture rate (information only) |

| `kind` | meaning | `unit` |
|---|---|---|
| `lifetime` | total lifetime of the muonic atom, τ | `ns`, `us` |
| `capture_rate` | total nuclear capture rate, Λcap | `us-1`, `ms-1`, `s-1` |
| `capture_probability` | fraction of muons captured, Bcap | `%` |

Units are written in ASCII: `us` is the microsecond, `us-1` is per
microsecond. The explorer shows them as µs and µs⁻¹.

**Uncertainties.** Format 1 holds symmetric, absolute uncertainties of one
standard deviation. The `source` of an uncertainty is `total`, `statistical`,
`systematic` or `other`: a single overall uncertainty is `total`, and
statistical and systematic uncertainties are listed separately when the source
separates them. Uncertainties that are asymmetric or given only relative to the value,
upper or lower limits and covariances cannot be written in format 1; such
values are not entered, and they are never converted into a symmetric
uncertainty without saying so.

When the source gives no uncertainty the list is empty: no uncertainty is not
an uncertainty of 0. The converted values of such an entry are given, but its
`uncertainty` column and the `*_unc` columns of the CSV files stay empty.
Wherever one overall uncertainty is needed (converted quantities, charts, the
`uncertainty` column of the CSV files), the `total` entry is used if there is
one. Otherwise the listed components are added in quadrature. If their
combined uncertainty exceeds the finite numeric range, the overall and
propagated uncertainties are unavailable.

### Bibliography (`data/master/bibliography.json`)

```json
{
  "format": "muND/bibliography/1",
  "references": [
    {"id": "DOI:10.1103/PhysRevC.35.2212", "type": "journal-article", "author": [{"family": "Suzuki", "given": "T."}, {"family": "Measday", "given": "D. F."}, {"family": "Roalsvig", "given": "J. P."}], "title": ["Total nuclear capture rates for negative muons"], "container-title": ["Physical Review C"], "short-container-title": ["Phys. Rev. C"], "volume": "35", "issue": "6", "page": "2212-2224", "published": {"date-parts": [[1987, 6, 1]]}}
  ]
}
```

An entry is found by its `id`, the bibId of the source. It is a cached subset
of the Crossref record (DataCite records are converted to Crossref's member
names), with Crossref's shapes: `title` and `container-title` are lists, the
date is `published.date-parts`. An entry of an NSR keynumber or a muND key is
written by hand (from the NSR page for a keynumber), and `URL` gives an absolute HTTP or HTTPS
address (`http://` or `https://` in lower case, no white space) for a source named by a muND key. The data entry tool fills the cache when a
DOI is looked up, so the published site does not depend on Crossref or
DataCite.

## 4. Canonical form

Files are written in exactly one way, so that a git diff shows only what
really changed (`python3 tools/mund.py fix`; the data entry tool does it
automatically):

1. Encode in UTF-8 without a byte order mark. Use LF for line breaks and end
   the file with exactly one LF. Indent each level by two spaces.
2. Write a nonempty object with one member per line. Put one space after each
   colon and a comma between members. Align the closing brace with the opening
   line's indentation. Write an empty object as `{}`.
3. Keep array order. Write an array of scalars on one line. Write any other
   array with one element per line, indented one level, and the closing bracket
   on its own line. Within each element, write all objects and arrays inline.
   Separate inline members and elements with a comma and one space.
4. Order members as listed in the schema's `properties`, following local
   `$ref` references. Sort unlisted names after the listed ones. Python sorts
   these names by Unicode code point and JavaScript by UTF-16 code unit.
   JavaScript writes names that are array indices (`"0"`, `"1"` …) before all
   other members, in numeric order. Inside the `before` and `after` values of
   a correction, all names are unlisted and both languages use the JavaScript
   order.
5. Trim both ends of every string value, including values inside arrays, using
   the [identifier whitespace set](id-definition.md#normalisation). In each
   object, omit optional members whose normalized value is `""`, `null`,
   `[]` or `{}`. Keep array elements, and the members named in the object's
   own `required` list, even when empty. A member required only under a
   condition (such as `originalData` of a curated entry) is optional here.
   The `before` and `after` values of a correction are the exception: their
   strings stay untrimmed and none of their members is omitted.
6. Preserve each number's entire JSON token, including trailing zeros, sign
   and exponent spelling. For example, `13.250` and `1.3250E+01` retain those
   spellings. For a computed number without a source token, Python uses
   `str` for integers and `repr` for floats. JavaScript uses `String(number)`.
7. Enclose strings and member names in double quotes. Escape a double quote as
   `\"` and a backslash as `\\`. Use `\b`, `\t`, `\n`, `\f` and `\r` for
   backspace, tab, LF, form feed and CR. Write the remaining U+0000–U+001F
   controls as `\u00xx` with lowercase hex digits. Write all other Unicode
   scalar values literally, including slashes and non-ASCII text.

A member name may appear only once in an object, and every number must be
finite as a double-precision value (`1e400` is refused).

## 5. Checks

`python3 tools/mund.py validate` (run automatically for every change; a change
with an error is not published). It reads every `*.json` file under `data/`.

| code | meaning |
|---|---|
| `E_JSON`, `E_CANONICAL` | not JSON / not in canonical form |
| `E_FORMAT` | the `format` member does not fit the file (a master table, or a file of the sub-library) |
| `E_SCHEMA` | does not follow the JSON Schema (unknown element, unit that does not fit the kind, missing member …) |
| `E_PATH` | wrong directory or file name, or a file under `data/` that is neither a master table nor a file of a sub-library |
| `E_SUBLIBRARY_UNDEFINED` | a file of XR, ES or BR, whose format is not defined |
| `E_MASTER_MISSING` | one of the five master tables is missing |
| `E_META_ID`, `E_DATA_ID` | identifier does not match its definition |
| `E_DUPLICATE_ID`, `E_DUPLICATE_META` | identifier used twice (give the entries different keys) |
| `E_ORIGINAL_MISSING`, `E_ORIGINAL_NOT_EXP`, `E_ORIGINAL_SELF`, `E_ORIGINAL_DUPLICATE` | `originalData` does not resolve, is not experimental (curated), is the entry itself, or names the same entry twice (also through an earlier identifier) |
| `E_LEGACY_ID_CONFLICT` | an earlier identifier is the current identifier of an entry, or is claimed by two entries |
| `E_ELEMENT_ORDER` | the element list must match the LT element symbols in atomic number order |
| `E_DUPLICATE_Z`, `E_UNKNOWN_Z` | isotope ranges and monoisotopic assignments each allow one row per atomic number in the element list |
| `E_DUPLICATE_HUFF` | `huff_factors.json`: an element or a nuclide listed twice |
| `E_MASS_BELOW_Z` | an isotope mass number must be at least its atomic number |
| `E_UNCERTAINTY_TOTAL` | more than one uncertainty with the source `total` |
| `E_FACILITY`, `E_DUPLICATE_FACILITY`, `E_DUPLICATE_REFERENCE` | facility not in the master list / listed twice; a bibId listed twice in the bibliography |
| `W_ORIGINAL_CHANGED` | warning: an original entry changed after the derived value was made from it (check the derived value again) |
| `W_ORIGINAL_LEGACY` | warning: `originalData` names an earlier identifier; write the current one |
| `W_NO_REFERENCE` | warning when a DOI or an NSR keynumber has no bibliography entry (a muND key may have none) |
| `W_MASS_RANGE` | warning for a positive integer mass `A` when the element has a range in `nuclides.json` and `A < a_min - 8` or `A > a_max + 8`. Natural targets (`A = 0`) and elements without a range skip this check |

The same checks run in the browser (data entry tool); both implementations
are tested against the cases in `tests/vectors/cases.json`.

## 6. Published files

The web site is built from this repository
(`python3 tools/mund.py build`). For every version it offers

| file | content |
|---|---|
| `data/<version>/manifest.json` | version, commit, counts, list of files with SHA-256 |
| `data/<version>/LT.json` | all LT data in one file: `data` (entries), `meta` (metadata records), `bibliography` |
| `data/<version>/csv/LT.csv`, `LT_EXP.csv` … | flat tables, one row per data entry, with lifetime, capture rate and capture probability derived for every row ([columns](#csv-columns)) |
| `data/<version>/master.json` | master tables except the bibliography (which is part of `LT.json`) |
| `data/<version>/raw/…` | the source files exactly as stored here |
| `data/<version>/mund-<version>.zip` | `README.txt`, the files above except the manifest, and the JSON Schemas (`schema/`) |

`<version>` is `latest` or a stable version (`v1`, `v2` …), see
[Versions and citing](versioning.md). The same data are also published as one
file per element, nuclide, entry and source for programs ([API](api.md)).

In `LT.json` every entry is self-contained:

```json
{"datasetId": "e489422fdeb4", "datasetType": "experiment", "metaId": "4d2ed5c83736", "bibId": "DOI:10.1103/vl7z-rzp8", "nuclide": {"element": "Si", "mass": 28, "isomer": 0}, "observable": {"kind": "lifetime", "lifetime": {"value": 743.9, "unit": "ns", "uncertainties": [{"source": "total", "value": 5.0}]}}, "legacyIds": ["e2551c5951a7"]}
```

`metaId` names the metadata record of the entry (in `meta`), for all four
dataset types.

### CSV columns

The CSV files are UTF-8 text with a header record. Every record ends with LF.
A field is enclosed in double quotes exactly when it contains a comma, a double
quote, a carriage return or a line feed; a double quote inside it is doubled.

| column | meaning |
|---|---|
| `datasetId`, `datasetType` | DataID and dataset type of the entry |
| `element`, `z`, `mass`, `isomer` | the nuclide; `z` is the atomic number |
| `observable` | the quantity given in the source: `lifetime`, `capture_rate` or `capture_probability` |
| `value` | that quantity, with the digits given in the source |
| `uncertainty` | its overall uncertainty: the `total` given in the source, or the components added in quadrature |
| `uncertaintyStatistical`, `uncertaintySystematic` | one component retains its written digits. Multiple components of the same kind are combined in quadrature. |
| `unit` | the unit of `value` and of its uncertainties |
| `key`, `comment` | as in the data entry |
| `originalData` | DataIDs of the entries the value was derived from, separated by `;` |
| `metaId`, `bibId` | MetaID and main reference of the metadata record |
| `reference` | the main reference in short (`Suzuki et al., Phys. Rev. C 35, 2212 (1987)`) |
| `facility`, `method` | as in the metadata record |
| `lifetime_ns`, `lifetime_ns_unc` | lifetime in ns and its uncertainty, converted from `value` |
| `capture_rate_us-1`, `capture_rate_us-1_unc` | capture rate in µs⁻¹ and its uncertainty, converted from `value` |
| `capture_probability_pct`, `capture_probability_pct_unc` | capture probability in % and its uncertainty, converted from `value` |
| `huff_factor`, `huff_source` | the Huff factor Q of the conversion and where it comes from (below) |

### Derived columns

```
1 / τ = Λcap + Q / τμ+          Bcap = Λcap / (Λcap + Q / τμ+)
```

Q is the Huff factor from `data/master/huff_factors.json` and τμ+ the free
muon lifetime from `data/master/constants.json`. The column `huff_source` says
which Q was used: `nuclide` (tabulated for the isotope), `element` (the element
value — natural targets and isotopes that are not tabulated) or `none` (no
tabulated value; Q = 1 is assumed). A Huff factor given by a user (the
converter) must be a number in (0, 1]; anything else is refused, never replaced.

Each converted uncertainty propagates the source observable's overall uncertainty
to first order, with Q and τμ+ held fixed. Adding source components in quadrature
assumes zero covariance between them. For a nonzero source uncertainty, the
three quantities in a row are fully correlated to first order. Capture rate and
capture probability vary together, and lifetime varies in the opposite direction.
Use the source observable once when fitting a row.

CSV preserves the written digits of the source value and of each reported
uncertainty it exports. It formats a total computed from components, the
converted quantities and their uncertainties, and `huff_factor` with `%.6g`
(six significant digits, with trailing fractional zeros omitted). Missing
numeric results are empty fields. The API preserves source number tokens in
`observable`. In `converted` it uses the same six-significant-digit rounding
for the three quantities and their uncertainties, and keeps the numeric Huff
factor at its conversion precision.

### Downloads of a selection

Before exporting, the explorer checks the master table version and the checksum of the displayed LT data against the manifest. For CSV it also checks the published CSV checksum. If a file differs, the page asks the reader to reload.

The explorer offers the entries it shows as

* **CSV** — the published `csv/LT.csv` of that version cut down to the rows
  shown, in the order shown; header and records are copied byte for byte, so
  columns, written digits and empty uncertainties are exactly as published;
* **JSON** (`muND/selection/LT/1`) — `version`, `commit`, `citation` (`paper`
  and `database`, as in the [API](api.md)), `permalink`, `dataLicence`
  (as in the API), `selection` (filters and
  count), the version's `manifest` (without its file list), `source` (path,
  size and SHA-256 of the `LT.json` read), and the `bibliography`, `meta` and
  `data` of the selected entries, numbers as written.
