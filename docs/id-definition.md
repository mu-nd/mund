# muND identifiers (MetaID and DataID)

This document defines the identifiers used in the muND database. It is a pure
string definition: it does not depend on a programming language, on the order
in which data were entered, or on random numbers. The same defining
information always gives the same identifier.

Status: **defined for the LT sub-library.** The same idea (deterministic,
value-independent identifiers) applies to XR, ES and BR, but the fields that
enter their identifiers have not been decided; do not reuse the LT rule for
them without a decision.

## 1. Two identifiers

| | identifies | defined by |
|---|---|---|
| **MetaID** (`meta.id` in the files) | a metadata record: one publication (optionally one of several set-ups in it) | sub-library, dataset type, DOI (`bibId`), optional key |
| **DataID** (`datasetId` in the files) | one data entry | sub-library, dataset type, element, mass number, MetaID, optional key |

Values, uncertainties, units and all descriptive metadata (facility, method,
comments ...) are **not** part of an identifier. Correcting a number or a
description therefore keeps the identifier, and the history of a data point
can be followed in git.

## 2. Definition

```
MetaID = first 12 hexadecimal digits of SHA-256( UTF-8( meta_source ) )
DataID = first 12 hexadecimal digits of SHA-256( UTF-8( data_source ) )

meta_source = "LT|{DataSet}-META|{doi_norm}[|{key_norm}]"
data_source = "LT|{DataSet}|{element_norm}|{mass_norm}|{MetaID}[|{key_norm}]"
```

* `[...]` marks a part that is appended only when a key is given. The square
  brackets are notation; they are not part of the string.
* `{DataSet}` is one of `EXP`, `TH`, `CUR`, `EVAL`, for the `datasetType` `experiment`, `theory`,
  `curated`, `evaluated` respectively.
* The separator is the character `|` (U+007C). A key must not contain it.
* The hexadecimal digits are lower case. An identifier has 12 digits (48 bits).

### Normalisation

| part | rule | example |
|---|---|---|
| `doi_norm` | if several DOIs are given separated by `;`, take the first; remove leading and trailing white space; convert to upper case | `10.1103/vl7z-rzp8; 10.48550/arXiv.2501.05897` → `10.1103/VL7Z-RZP8` |
| `key_norm` | remove leading and trailing white space; convert to upper case; an empty key counts as "no key" | ` plate ` → `PLATE` |
| `element_norm` | element symbol: first letter upper case, second letter (if any) lower case, no white space | ` si ` → `Si` |
| `mass_norm` | decimal string of *mass number × 1000*, rounded to an integer, no sign, no decimal point. A target of natural isotopic abundance has mass number 0 | `27` → `27000`, `0` → `0`, `106.5` → `106500` |

Upper-casing means that DOIs and keys are compared case-insensitively:
`10.1103/PhysRevC.35.2212` and `10.1103/physrevc.35.2212` are the same
reference.

### Worked example

```
meta_source = "LT|EXP-META|10.1103/VL7Z-RZP8"
MetaID      = dcb3b051457e

data_source = "LT|EXP|Al|27000|dcb3b051457e|PLATE"
DataID      = 343adc036597
```

You can reproduce it with any SHA-256 tool, for example

```sh
printf '%s' 'LT|EXP-META|10.1103/VL7Z-RZP8' | shasum -a 256 | cut -c1-12
python3 tools/mund.py id LT EXP 10.1103/vl7z-rzp8 --element Al --mass 27 --key plate
```

## 3. Keys

Two data points of the same nuclide in the same metadata record would get the
same DataID. Whenever that happens, give them different keys (for example
`plate` and `powder` for two target forms, or `1` and `2`). Likewise, a
publication that needs two metadata records (two different set-ups) uses a
key in the metadata. The validation refuses duplicate identifiers and asks
for a key.

Keys are part of the identifier: choose them once and keep them.

## 4. Sources without a DOI

A source without a DOI (old report, thesis, unpublished compilation) gets a
*placeholder* of the form `10.1000/mund.<name>`, for example
`10.1000/mund.Suzuki1975thesis`. `10.1000/unpublished` is in use for the
curation whose paper is not written yet. Placeholders are never resolved through doi.org;
their bibliography entry is written by hand. They enter the identifier
exactly like a real DOI.

## 5. What happens when the defining information changes

If the element, mass number, key, DOI or dataset type of an entry is
corrected, its identifier changes — it now identifies something else. To keep
old references resolvable

* the previous identifier is recorded in `legacyIds` of the data entry, and
* other data entries that listed it in `originalData` are updated.

The data entry tool does both automatically. The explorer finds a data point
by its former identifiers as well.

## 6. Test vectors

`tests/vectors/ids.json` contains the identifiers that were in use before
this repository was created (3 MetaIDs, 67 DataIDs). They pin this definition: the Python implementation
(`tools/mundlib/ids.py`) and the browser implementation
(`site/assets/js/core/ids.js`) are tested against them on every change. The
same page is available on the web site under `tests/`.

## 7. History

* An earlier draft derived one identifier from element, mass, *value* and
  DOI. It was abandoned because every correction of a value changed the
  identifier.
* A UUID as `datasetId` was considered and judged too long; the short
  deterministic identifier replaced it.
* The current rule separates MetaID and DataID and leaves out the value. It
  was agreed in the design discussions of 2026 and reproduces the identifiers
  that were already in use.
* Before this repository, the identifiers of the curated data had been
  computed with the token `TH` instead of `CUR`. This repository uses `CUR`
  as defined above; the earlier identifiers are kept in `legacyIds`.
