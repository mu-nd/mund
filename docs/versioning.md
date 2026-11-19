# Versions of the data

* **Stable versions** are frozen. The site offers one per *major* version
  (`v1`, `v2`, …), stored in the repository as it was released.
* **latest** is the current state of the `main` branch, shown on the site as
  the development version.
* Any other state is in the git history, which records who changed what, when
  and why.

## Version numbers

`MAJOR.MINOR.PATCH`, stored in the file `VERSION` and as git tags `vX.Y.Z`.

| part | raise it when | example |
|---|---|---|
| PATCH | existing entries are corrected (a typing error, a comment) | 1.0.0 → 1.0.1 |
| MINOR | data are added | 1.0.1 → 1.1.0 |
| MAJOR | a new public release is frozen; also when something is removed or the meaning of existing data changes | 1.4.2 → 2.0.0 |

Between releases the state of the repository is identified as
`<last tag>+<commits since>.g<commit>` (for example `1.0.0+12.g3fa2c1b`), or
`0.0.1-dev+g<commit>` before the first tag. Individual commits do not get
version numbers of their own.

## How a release is made

In the data entry tool, page **Publish a version** (版を公開): choose patch / minor / major and
describe the changes. The tool

1. writes the new number to `VERSION` and an entry to `CHANGELOG.md` and
   saves both — this commit is the **release commit**;
2. for a major version (`N.0.0`), **freezes** it: builds its data files once,
   from the release commit, into `releases/vN/` and saves them in a commit of
   their own ("Freeze release N.0.0");
3. creates the tag `vX.Y.Z` on the release commit and sends everything.

If step 2 or 3 fails (for example without a network), "Complete publishing"
repeats them for the same release commit — never for a later state. A tag is
never moved or deleted once it has been sent.

The same can be done by hand:

```sh
echo 1.0.0 > VERSION                       # and edit CHANGELOG.md
git commit -am "Release 1.0.0"
python3 tools/mund.py freeze HEAD          # major versions only
git add releases && git commit -m "Freeze release 1.0.0"
git tag v1.0.0 HEAD~1                      # the release commit
git push origin main v1.0.0
```

## Frozen releases

`releases/vN/` holds exactly what the site serves as `data/vN/`
(`manifest.json`, `LT.json`, CSV files, master tables, the raw files and the
zip archive). Its `manifest.json` records

| member | content |
|---|---|
| `version`, `commit`, `date` | the release and its release commit |
| `files`, `archive` | SHA-256 and size of every file of the folder |
| `sources` | SHA-256 of every file the release was made from at the release commit: `VERSION`, data, master tables (constants, Huff factors …), schemas, the tools and the browser core (the conversion code) |
| `builder` | SHA-256 of the tools and schemas that built it |

`python3 tools/mund.py releases` checks every frozen release: each file against
the manifest, the sources against the release commit, that the folder was
saved once and not changed afterwards, and that the tag is on the release
commit (a missing tag is reported as a warning). CI runs it for every change,
and the site build refuses to publish a release that fails it. Because the
files are stored, a fixed version stays byte for byte the same when the data,
the format or the tools change later; nothing depends on old tools still
running.

## What the site publishes

The workflow `.github/workflows/site.yml` checks a commit of `main` and then
builds the site from that same commit:

* `data/latest/` from the checked commit — the development version, labelled
  as such on the site;
* `data/vN/` for every frozen release, copied from `releases/vN/` after the
  check above.

The site shows the newest stable version by default (`latest` while there is none). Addresses such as
`…/data/v1/csv/LT.csv` are permanent. Minor and patch versions are not
published as separate folders; they are tags in the repository and can be
downloaded from GitHub. A version that does not exist is reported as such,
never replaced by another one.

## Citing

Cite the version of the database together with the project paper
(`CITATION.cff`). The site, the API and the JSON downloads give both
citations in the style of Physical Review (the site also in BibTeX); they
always name the version, and their address shows that version.
The MIT licence covers the software only; the licence of the data has not been
decided. A DOI per release could be obtained by connecting the repository to
Zenodo; this has not been set up.
