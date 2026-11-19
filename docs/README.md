# Documentation

muND is a set of JSON files in a git repository, one file per publication,
checked automatically on every change.

## For users

| Page | What it is for |
|---|---|
| [Explorer](https://ribf.riken.jp/muon/explorer/) | the data of an element, and a download of what is shown (CSV, JSON) |
| [Downloads](https://ribf.riken.jp/muon/downloads/) | all files of a version |
| [API](api.md) | the data for programs |
| [Converter](https://ribf.riken.jp/muon/tools/converter/) | conversion between lifetime, capture rate and capture probability, with the Huff factors of a data version or one of your own |
| [How to cite](https://ribf.riken.jp/muon/#cite) | the citation of the project paper and of a data version |
| [Data format](data-format.md) | the model, the files of the repository, the files published for every version, and the conversion between lifetime, capture rate and capture probability |
| [Identifiers](id-definition.md) | MetaID and DataID: how they are computed, and when they change |
| [Versions and citing](versioning.md) | version numbers, releases, what the site publishes, how to cite |

The machine-readable description of the files is the JSON Schema in
[`schema/v1`](../schema/v1).

## For contributors and maintainers

### Reporting an error

Open an [issue](https://github.com/mu-nd/mund/issues) with the nuclide, the
DataID of the entry (shown in its details on the site), what is wrong, and the
reference that shows the correct value.

### Proposing a change (pull request)

1. Fork [`mu-nd/mund`](https://github.com/mu-nd/mund) and clone your fork.
2. Add or edit files under `data/`, one file per publication
   ([Data format](data-format.md)). Values from a publication are read twice
   and compared before they are entered ([extraction.ja.md](extraction.ja.md), Japanese).
3. Compute the identifiers, the canonical form and the file name, and check
   the database:

   ```sh
   python3 tools/mund.py fix
   python3 tools/mund.py validate
   ```

4. Open a pull request against `main`. The checks and the tests run on every
   pull request; the site is updated after the change is merged.

This needs Python 3.9 or newer and `pip install -r requirements.txt`, or
[pixi](https://pixi.sh) (`pixi run validate`, `pixi run fix`, `pixi run test`).

### Updating the database

The maintainers use the data entry tool on their own computer: open a file,
edit it, press **Save**. The tool checks the database, records the change
under their name and sends it to `main`; the site is rebuilt a few minutes
later.

| Task | How |
|---|---|
| Set up once | install pixi, clone the repository, log in to GitHub: [admin-guide.ja.md](admin-guide.ja.md), section 1 (Japanese) |
| Enter and correct data | `pixi run admin`; a practice copy: `pixi run admin-practice` ([admin-guide.ja.md](admin-guide.ja.md), section 2) |
| Read values from a publication | the extraction work area of the tool ([extraction.ja.md](extraction.ja.md)) |
| Release a version | the tool's page **Publish a version** (版を公開) ([Versions and citing](versioning.md)) |
| Publish the site | GitHub Actions builds it from `main`; serving it at ribf.riken.jp: [deployment.ja.md](deployment.ja.md) (Japanese) |

### Tools

| Tool | What it does |
|---|---|
| Data entry tool (`pixi run admin`) | enters, checks, saves and releases data, on your own computer |
| `tools/mund.py` | command line: `validate`, `fix` (identifiers, canonical form, file name), `id` (compute a MetaID or DataID), `build` and `serve` (the site), `freeze` and `releases` (frozen releases) |
| [Browser tests](https://ribf.riken.jp/muon/tests/) | the tests of the site's scripts, in your browser |
