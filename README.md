# muND — Muon Nuclear Data

The database and the web site of the Muon Nuclear Data project
(<https://ribf.riken.jp/muon/>): data on the interaction of negative muons
with nuclei, compiled from the literature and evaluated, kept as JSON files
under git, together with the tools that check them and build the site, and a
data entry tool that runs on the computer of the person entering data.

## Documentation

<https://mu-nd.github.io/mund/docs/>

## Content

| sub-library | quantity | format |
|---|---|---|
| **LT** | lifetimes of muonic atoms / nuclear capture rates | `muND/LT/1`, data on the site |
| **XR** | muonic X-ray energies and intensities | not defined; proposals in [`templates/`](templates/) |
| **ES** | energy spectra of emitted particles | not defined; proposals in [`templates/`](templates/) |
| **BR** | production branching ratios of residual nuclei | not defined; proposals in [`templates/`](templates/) |

## Repository

| folder | content | document |
|---|---|---|
| [`data/`](data/) | one LT file per metadata record and its entries, plus the master tables | [Data format](docs/data-format.md) |
| [`schema/`](schema/) | JSON Schemas of the files | [Data format](docs/data-format.md) |
| [`templates/`](templates/) | proposed shapes of XR, ES and BR files (not decided) | [templates/README.md](templates/README.md) |
| [`VERSION`](VERSION), [`CHANGELOG.md`](CHANGELOG.md) | the version of the data and its changes | [Versions and citing](docs/versioning.md) |
| `releases/` | the stable versions as published (from the first major version on) | [Versions and citing](docs/versioning.md) |
| [`site/`](site/) | the web site (static files) | [deployment.ja.md](docs/deployment.ja.md) |
| [`admin/`](admin/) | the data entry tool (its page) | [admin-guide.ja.md](docs/admin-guide.ja.md) |
| [`tools/`](tools/) | command line tool and the data entry tool's local server (Python) | [Documentation](docs/README.md#for-contributors-and-maintainers) |
| [`tests/`](tests/) | validation, canonical form, identifiers, citation texts and unit conversion exist in Python (`tools/mundlib`) and JavaScript (`site/assets/js/core`); both are tested against `tests/vectors/`, and the tests use `tests/fixtures/` | [Documentation](docs/README.md#for-contributors-and-maintainers) |
| [`docs/`](docs/) | formats and identifiers (English), guides (Japanese) | [docs/README.md](docs/README.md) |

## Citing

Cite the version of the data you used, the project paper and the original
reference of each value; the texts to copy are on the site
([How to cite](https://mu-nd.github.io/mund/#cite)). The project paper is also
in [CITATION.cff](CITATION.cff), which GitHub shows as "Cite this repository".

## Licence

The software in this repository is released under the [MIT licence](LICENSE).
Please contact the project before redistributing the **data**.

The data format builds on the JSON Schema written for muND by S. Kawase
([shkawase/mund](https://github.com/shkawase/mund)).
