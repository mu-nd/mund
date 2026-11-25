# Identifiers (MetaID and DataID)

The identifiers of the muND database are computed from strings: they do not
depend on a programming language, on the order in which data were entered, or
on random numbers. The same defining information always gives the same
identifier.

The definition covers the LT sub-library. XR, ES and BR have no identifier
rule: which fields identify their data entries is not decided.

## 1. Two identifiers

| | identifies | defined by |
|---|---|---|
| **MetaID** (`meta.id` in the files) | a metadata record: one publication (optionally one of several set-ups in it) | sub-library, dataset type, source (`bibId`), optional key |
| **DataID** (`datasetId` in the files) | one data entry | sub-library, dataset type, element, mass number, MetaID, optional key |

Values, uncertainties, units and all descriptive metadata (facility, method,
comments ...) are **not** part of an identifier. Correcting a number or a
description therefore keeps the identifier, and the history of a data entry
can be followed in git.

## 2. Definition

```
MetaID = first 12 hexadecimal digits of SHA-256( UTF-8( meta_source ) )
DataID = first 12 hexadecimal digits of SHA-256( UTF-8( data_source ) )

meta_source = "LT|{DataSet}-META|{bib_norm}[|{key_norm}]"
data_source = "LT|{DataSet}|{element_norm}|{mass_norm}|{MetaID}[|{key_norm}]"
```

* `[...]` marks a part that is appended only when a key is given. The square
  brackets are notation; they are not part of the string.
* `{DataSet}` is one of `EXP`, `TH`, `CUR`, `EVAL`, for the `datasetType` `experiment`, `theory`,
  `curated`, `evaluated` respectively.
* The separator is the character `|` (U+007C). Both the source (`bibId`) and the optional key exclude this character.
* The hexadecimal digits are lower case. An identifier has 12 digits (48 bits).

### Normalisation

| part | rule | example |
|---|---|---|
| `bib_norm` | the `bibId` (`DOI:`, `NSR:` or `muND:` and a name, §4): remove leading and trailing white space; convert to upper case | `DOI:10.1103/vl7z-rzp8` → `DOI:10.1103/VL7Z-RZP8`, `muND:unpublished` → `MUND:UNPUBLISHED` |
| `key_norm` | trim white space and convert only ASCII `a`–`z` to `A`–`Z`. An empty key counts as "no key" | ` plate ` → `PLATE` |
| `element_norm` | element symbol: remove leading and trailing white space; first letter upper case, the rest lower case | ` si ` → `Si`, `SI` → `Si` |
| `mass_norm` | the mass number, given as a decimal number (ASCII digits with an optional sign, decimal point and exponent, e.g. `27`, `+27`, `.5`, `1e2`; white space around it is removed; any other text is refused), times 1000, computed exactly and rounded to an integer half away from zero; written without `+`, decimal point or exponent, with `-` for a negative value. A target of natural isotopic abundance has mass number 0 | `27` → `27000`, `0` → `0`, `106.5` → `106500`, `0.0005` → `1`, `-2.5e-3` → `-3` |

White space is what JavaScript's `String.prototype.trim()` removes: U+0009–U+000D,
U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and
U+FEFF (Python's `str.strip()` removes a different set).

BibIds are compared case-insensitively. For example,
`DOI:10.1103/PhysRevC.35.2212` and `DOI:10.1103/physrevc.35.2212` are the same
reference.

### Worked example

```
meta_source = "LT|EXP-META|DOI:10.1103/VL7Z-RZP8"
MetaID      = 4d2ed5c83736

data_source = "LT|EXP|Al|27000|4d2ed5c83736|PLATE"
DataID      = dd91adba8444
```

You can reproduce it with any SHA-256 tool, for example

```sh
printf '%s' 'LT|EXP-META|DOI:10.1103/VL7Z-RZP8' | shasum -a 256 | cut -c1-12
python3 tools/mund.py id LT EXP DOI:10.1103/vl7z-rzp8 --element Al --mass 27 --key plate
```

## 3. Keys

Two data entries of the same nuclide in the same metadata record would get the
same DataID. Whenever that happens, give them different keys (for example
`plate` and `powder` for two target forms, or `1` and `2`). Likewise, a
publication that needs two metadata records (two different set-ups) uses a
key in the metadata. The validation refuses duplicate identifiers and asks
for a key.

Keys are part of the identifier: choose them once and keep them.

## 4. Sources (bibId)

A source is named by a prefix and a name:

| form | for | example |
|---|---|---|
| `DOI:<DOI>` | a source with a DOI | `DOI:10.1103/vl7z-rzp8` |
| `NSR:<keynumber>` | a source without a DOI (old report, thesis …), by its keynumber in [Nuclear Science References](https://www.nndc.bnl.gov/nsr/) | `NSR:1987SU06` |
| `muND:<name>` | a source that NSR does not list either | `muND:Suzuki1975thesis`; `muND:unpublished` (the curated LT data) |

No made-up DOI is used: a DOI is only ever one that its registration agency
assigned. The three forms enter the identifier in the same way, prefix
included.

## 5. What happens when the defining information changes

If the element, mass number, key, source (`bibId`) or dataset type of an entry
changes, its identifier changes too, and whoever makes the change says which of
two things it is:

* **a correction of the same record** — the previous identifier is recorded in
  `legacyIds` of the entry, and entries that list it in `originalData` are
  pointed to the new identifier. The new identifier, the `legacyIds` and the
  changed references are one reviewable change.
* **different data** — nothing is carried over; references to the previous
  identifier no longer resolve and validation reports them until they are
  resolved by hand.

Identity is never inferred from the position of an entry in a file or from the
order on screen. The data entry tool matches entries by their identifiers and
asks which of the two cases applies; when it cannot tell which entry became
which, it re-points nothing. The explorer finds a data entry by its former
identifiers as well. A correction that gives an entry a new identifier which
cannot be kept in `legacyIds` (because another entry has it) is described in
the entry's `corrections` (`formerId`).

## 6. Content hash of an entry

`entryHash` identifies the *content* of a data entry, not the entry:

```
entryHash = first 12 hex digits of SHA-256( UTF-8( compact({"nuclide": …, "observable": …}) ) )
```

Use the `nuclide` and `observable` values as stored. At every object level,
sort the member names in ascending ASCII order (the LT schema names are
ASCII). Keep array order. Use the number tokens and string escapes of the
[canonical file format](data-format.md#4-canonical-form). Use a colon between
name and value and a comma between members or elements, with no whitespace
outside strings. Encode the result in UTF-8 without a byte order mark or final
newline. Take the first 12 lowercase hex digits of the digest.

For example, the following line hashes to `cde8099d6886`. The character
`𝜎` is literal, and the value and uncertainty retain their written precision.

```json
{"nuclide":{"element":"Si","isomer":0,"mass":28},"observable":{"kind":"lifetime","lifetime":{"uncertainties":[{"description":"𝜎","source":"total","value":1.50E+0}],"unit":"ns","value":13.250}}}
```

Derived entries record the `entryHash` of each original in `originalData`
so that a correction to its content can be detected.

Test cases: `tests/vectors/ids.json` (identifiers) and `tests/vectors/cases.json`
(entry hashes, through `W_ORIGINAL_CHANGED`); the Python tools and the browser
are tested against both.
