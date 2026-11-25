# Documentation

muND is a set of JSON files in a git repository, one file per metadata record
and its entries, checked automatically on every change.

## For users

| Task | How |
|---|---|
| Understand the values and the files | [Data format](data-format.md): the model, the files of the repository and of every published version, and the conversion between lifetime, capture rate and capture probability |
| Check files in a program | [JSON Schema](../schema/v1): the same, machine-readable |
| Refer to a data entry | [Identifiers](id-definition.md): MetaID and DataID, how they are computed and when they change |
| Read the data from a program | [API](api.md) |
| Convert a lifetime, capture rate or capture probability | [Converter](https://ribf.riken.jp/muon/tools/converter/), with the Huff factors of a data version or your own |
| Cite the data | [How to cite](https://ribf.riken.jp/muon/#cite) (the texts to copy); [Versions and citing](versioning.md): version numbers, releases, what the site publishes |
| Report an error | an [issue](https://github.com/mu-nd/mund/issues) with the nuclide, the DataID of the entry (shown in its details on the site), what is wrong, and the reference that shows the correct value |

## For contributors and maintainers

Set up once with [pixi](https://pixi.sh), which provides Python, git and the
GitHub CLI as declared in `pixi.toml`:

```sh
pixi exec --spec git -- git clone https://github.com/mu-nd/mund
cd mund
pixi run login        # log in to GitHub, to save from the data entry tool
pixi run admin        # the data entry tool
```

For setup without pixi, install Python 3.9 or newer, git and the GitHub CLI
(`gh`). In a POSIX shell, run the commands below. In Windows PowerShell,
use `py -3 -m venv .venv` to create the environment and
`.\.venv\Scripts\Activate.ps1` to activate it.

```sh
git clone https://github.com/mu-nd/mund
cd mund
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python tools/mund.py login
python tools/mund.py admin
```

Section 1 of the [Japanese guide](admin-guide.ja.md) describes login with pixi.

`python3 tools/mund.py -h` lists the commands. `pixi run test` runs the Python
tests; CI also runs `node tests/js/run-node.mjs`, and
[/tests/](https://ribf.riken.jp/muon/tests/) runs the site's part in a browser.

| Task | How |
|---|---|
| Propose a change to the data | fork [`mu-nd/mund`](https://github.com/mu-nd/mund); add or edit files under `data/`, one file per metadata record ([Data format](data-format.md)); run `python3 tools/mund.py fix` (identifiers, canonical form, file name; it does not change an identifier a file already has: such a change is made in the data entry tool, which keeps the old one in `legacyIds`), then the same with `validate`; open a pull request against `main`. The checks and the tests run on it; the site is updated after it is merged |
| Enter and correct data (maintainers) | `pixi run admin` opens the data entry tool on your computer: open a file, edit it, press **Save**. The tool checks the database, records the change under your name and sends it to `main`; the site is rebuilt a few minutes later. A practice copy: `pixi run admin-practice` ([admin-guide.ja.md](admin-guide.ja.md), section 2) |
| Release a version (maintainers) | the tool's page **Publish a version** (版を公開) ([Versions and citing](versioning.md)) |
| Publish the site (maintainers) | GitHub Actions builds it from `main`; serving it at ribf.riken.jp: [deployment.ja.md](deployment.ja.md) (Japanese) |
| Look up why something is as it is | [history.ja.md](history.ja.md): the decisions, their reasons and the open questions (Japanese) |
