# muND — Muon Nuclear Data

The database of the [Muon Nuclear Data project](https://ribf.riken.jp/muon/):
data on the interaction of negative muons with nuclei, compiled from the
literature and evaluated. This repository holds

* the **database** itself, as plain JSON files under git ([`data/`](data/)),
* the **explorer**, a static web site for reading the data ([`site/`](site/)),
* the **data entry tool**, a web page that edits the database through the
  GitHub API ([`site/admin/`](site/admin/)),
* the tools that check the data and build the site ([`tools/`](tools/)).

日本語の資料: [入力ツールの手引き](docs/admin-guide.ja.md) ·
[公開手順](docs/deployment.ja.md) · [設計メモ](docs/design-notes.ja.md)

## Content

| sub-library | | status |
|---|---|---|
| **LT** | lifetimes of muonic atoms / nuclear capture rates | available: 67 experimental, 8 curated, 580 evaluated values |
| **XR** | muonic X-ray energies and intensities | in preparation |
| **ES** | energy spectra of emitted particles | in preparation |
| **BR** | production branching ratios of residual nuclei | in preparation |

Each sub-library holds four kinds of data: experimental (EXP), theoretical
(TH), curated (CUR) and evaluated (EVAL).

## How it works

```
 data entry tool ──GitHub API──▶  data/*.json  (git: who changed what, when)
                                      │
                         GitHub Actions: validate, test, build
                                      │
                                      ▼
                        GitHub Pages: explorer + JSON / CSV files
                        latest  and frozen releases  v1, v2, …
```

* One publication is one file; one data entry is one line: `datasetId`,
  `nuclide`, `observable`, `uncertainties`, `bibId`
  ([format](docs/data-format.md)).
* Every data point has a permanent identifier computed from what it describes,
  never from its value ([definition](docs/id-definition.md)).
* Released versions are frozen; `latest` follows the daily work
  ([versions](docs/versioning.md)).

## Using the data

Browse them in the explorer, or read the files directly:

```python
import pandas as pd
lt = pd.read_csv("https://niikura-muon.github.io/mund/data/latest/csv/LT.csv")
```

Replace `latest` by a released version (`v1`) to pin your analysis. The site
lists all files under *Downloads*.

## Working on the database

Use the data entry tool (`/admin/` on the site): it looks up the bibliographic
data, computes the identifiers, checks the entry and commits it under your
name. See the [guide](docs/admin-guide.ja.md) (Japanese). It has a practice
mode that sends nothing to GitHub.

To run everything locally (Python 3.9 or newer):

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

python3 tools/mund.py validate        # check the data
python3 tools/mund.py serve           # explorer on http://localhost:8000/, tool on /admin/
python3 -m unittest discover -s tests/python -t tests/python
node tests/js/run-node.mjs            # tests of the browser code (Node 20+), or open /tests/ in a browser
```

The web site needs no build step and has no JavaScript dependencies of its
own; only the JSON view of the data entry tool loads the Monaco Editor from a
CDN.

## Repository layout

```
data/      the database (JSON) and its master tables
schema/    JSON Schema of the files
site/      explorer and data entry tool (static files)
tools/     validation and build (Python)
tests/     tests and the test vectors shared by Python and JavaScript
docs/      format, identifiers, versions, guides
```

## Citing

Please cite the version of the data you used together with

> Y. Watanabe *et al.*, "Muon Nuclear Data Development Project",
> [arXiv:2605.15539](https://arxiv.org/abs/2605.15539) (2026).

and the original reference of each value, which is stored with every data
point.

## Licence

The software in this repository is released under the [MIT licence](LICENSE).
The licence of the **data** has not been decided yet; until it is, please
contact the project before redistributing them.

## Acknowledgements

The data format builds on the JSON Schema and the prototypes written for muND
by S. Kawase ([shkawase/mund](https://github.com/shkawase/mund), `mund_app`,
`mund-backend-prototype`). The explorer keeps the layout of the project's
earlier explorer.
