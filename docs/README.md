# Documentation

muND is a set of JSON files in a git repository, one file per publication,
checked automatically on every change.

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

| Task | How |
|---|---|
| Set up | Python 3.9 or newer with the packages of `requirements.txt`, or [pixi](https://pixi.sh); to enter data, also clone the repository and log in to GitHub: [admin-guide.ja.md](admin-guide.ja.md), section 1 (Japanese) |
| Propose a change to the data | fork [`mu-nd/mund`](https://github.com/mu-nd/mund); add or edit files under `data/`, one file per publication ([Data format](data-format.md)); run `python3 tools/mund.py fix` (identifiers, canonical form, file name), then the same with `validate`; open a pull request against `main`. The checks and the tests run on it; the site is updated after it is merged |
| Enter and correct data (maintainers) | `pixi run admin` opens the data entry tool on your computer: open a file, edit it, press **Save**. The tool checks the database, records the change under your name and sends it to `main`; the site is rebuilt a few minutes later. A practice copy: `pixi run admin-practice` ([admin-guide.ja.md](admin-guide.ja.md), section 2) |
| Read values from a publication (maintainers) | the extraction work area of the tool: every value is read twice and compared before it is entered ([extraction.ja.md](extraction.ja.md), Japanese) |
| Release a version (maintainers) | the tool's page **Publish a version** (版を公開) ([Versions and citing](versioning.md)) |
| Publish the site (maintainers) | GitHub Actions builds it from `main`; serving it at ribf.riken.jp: [deployment.ja.md](deployment.ja.md) (Japanese) |
| Check, build and test from the command line | `tools/mund.py`: `validate`, `fix`, `id` (compute a MetaID or DataID), `build` and `serve` (the site), `freeze` and `releases` (frozen releases); `pixi run test` runs the tests, and the [browser tests](https://ribf.riken.jp/muon/tests/) run those of the site's scripts in your browser |
| Look up why something is as it is | [history.ja.md](history.ja.md): the decisions, their reasons and the open questions (Japanese) |
