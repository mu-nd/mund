# muND — Muon Nuclear Data

The database and the web site of the Muon Nuclear Data project
(<https://ribf.riken.jp/muon/>): data on the interaction of negative muons
with nuclei, compiled from the literature and evaluated. This repository holds

* the **database**, as plain JSON files under git ([`data/`](data/)),
* the **web site**: Home (about, news, team), the data explorer, downloads,
  the documentation and an API of JSON files, as static files ([`site/`](site/)),
* the **data entry tool**, which runs on the computer of the person entering
  data ([`admin/`](admin/)),
* the **tools** that check the data and build the site ([`tools/`](tools/)).

日本語の資料: [入力ツールの手引き](docs/admin-guide.ja.md) ·
[公開の仕組みと手順](docs/deployment.ja.md) · [経緯と未決事項](docs/history.ja.md)

## Content

| sub-library | | status |
|---|---|---|
| **LT** | lifetimes of muonic atoms / nuclear capture rates | 67 experimental, 8 curated, 580 evaluated values |
| **XR** | muonic X-ray energies and intensities | format not defined yet |
| **ES** | energy spectra of emitted particles | format not defined yet |
| **BR** | production branching ratios of residual nuclei | format not defined yet |

Each sub-library holds four kinds of data: experimental (EXP), theoretical
(TH), curated (CUR) and evaluated (EVAL).

## How it works

```
 data entry tool on your computer ──save = git commit + push──▶  data/**/*.json on GitHub
                                                                  │
                                               GitHub Actions: validate, test, build
                                                                  │
                                                                  ▼
                                         web site: pages, JSON / CSV files and the API
                                         latest  and frozen releases  v1, v2, …
```

* One publication is one file; one data entry is one line: `datasetId`,
  `nuclide`, `observable`, `uncertainties`, `bibId`
  ([format](docs/data-format.md)).
* Every data entry has a permanent identifier computed from what it describes,
  never from its value ([definition](docs/id-definition.md)).
* Released versions are frozen: built once when released, stored in
  `releases/` with SHA-256 hashes and published as stored; `latest` follows
  the daily work ([versions](docs/versioning.md)).

## Using the data

Browse them on the site, or read the files directly:

```python
import pandas as pd
lt = pd.read_csv("https://ribf.riken.jp/muon/data/latest/csv/LT.csv")
```

Replace `latest` by a released version (`v1`) to pin your analysis. The site
lists all files under *Downloads*.

## Working on the database

Use the data entry tool. It runs on your computer: you open a file, edit it
and press **Save**; the tool checks the database, records the change under
your name and sends it to GitHub. Nobody has to use git directly. It looks up
bibliographic data, computes the identifiers and offers a practice copy. See
the [guide](docs/admin-guide.ja.md) (Japanese).

Values read from a publication go through the tool's extraction work area
(`extraction/`, outside `data/`): two independent inputs (two people, or a
person and AI), a row-by-row comparison, recorded decisions and an approval by
a responsible person come before the values are written to `data/`
([description](docs/extraction.ja.md), Japanese). AI extraction runs in the
tool's local server (`pixi run -e ai admin`, with `ANTHROPIC_API_KEY` set).

The environment (Python, jsonschema, git and the GitHub CLI) comes from
[pixi](https://pixi.sh), as declared in `pixi.toml`:

```sh
pixi exec --spec gh --spec git -- gh repo clone mu-nd/mund   # once
cd mund
pixi run login                        # once: log in to GitHub
pixi run admin                        # the data entry tool
pixi run admin-practice               # the same on a throw-away copy
```

Without pixi, Python 3.9 or newer with `pip install -r requirements.txt` and
git are enough for everything except logging in with `gh`:

```sh
python3 tools/mund.py validate        # check the data
python3 tools/mund.py serve           # the whole site on http://localhost:8000/
python3 tools/mund.py admin           # the data entry tool
python3 -m unittest discover -s tests/python
node tests/js/run-node.mjs            # tests of the browser code (Node 20+); the site's part also runs at /tests/ in a browser
```

## Repository layout

```
data/      the database (JSON) and its master tables — approved data only
releases/  the frozen major releases, exactly as published (created when a major version is released)
schema/    JSON Schema of the files
site/      web site (static files, no build step for the scripts)
admin/     data entry tool (served by `tools/mund.py admin` on your computer)
tools/     validation and build (Python)
tests/     tests and the test vectors shared by Python and JavaScript
docs/      format, identifiers, versions, guides
```

Validation, canonical formatting, identifiers, citation labels and unit
conversion are implemented twice — in Python (`tools/mundlib`) for the command
line and the automatic checks, in JavaScript (`site/assets/js/core`) for the
browser — and both are tested against the same vectors in `tests/vectors/`.
The tests use their own small database (`tests/fixtures/`), so adding or
correcting data never breaks them.

## Citing

Please cite the version of the data you used together with

> Y. Watanabe *et al.*, "Muon Nuclear Data Development Project",
> [arXiv:2605.15539](https://arxiv.org/abs/2605.15539) (2026).

and the original reference of each value, which is stored with every data
entry.

## Licence

The software in this repository is released under the [MIT licence](LICENSE).
The licence of the **data** has not been decided; until it is, please contact
the project before redistributing them.

The data format builds on the JSON Schema written for muND by S. Kawase
([shkawase/mund](https://github.com/shkawase/mund)).
