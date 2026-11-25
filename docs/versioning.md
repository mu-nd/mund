# Versions and citing

* **Stable versions** never change. The site offers one per *major* version
  (`v1`, `v2`, …), stored in the repository when it is released.
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
| MAJOR | the data become a new stable version; also when something is removed or the meaning of existing data changes | 1.4.2 → 2.0.0 |

The manifest's `version` describes the checkout used for a build.

| Checkout | Version string |
|---|---|
| At the tag `vX.Y.Z` | `X.Y.Z`, matching `VERSION` |
| After a reachable version tag | Tag number, number of commits since the tag and abbreviated commit ID, e.g. `1.0.0+12.g3fa2c1b` |
| With a commit but no reachable version tag | `<VERSION>-dev+g<first seven digits of commit>` |
| Without an available commit | `<VERSION>-dev`, with `commit` and `date` both null |

For a checkout with a commit, the build appends `.modified` if Git reports
local changes to `VERSION`, `tools/mund.py`, `site/config.json` or under
`data/`, `schema/`, `tools/mundlib/` or `site/assets/js/core/`.

## How a release is made

In the data entry tool, page **Publish a version** (版を公開): choose patch / minor / major and
describe the changes. The tool

1. writes the new number to `VERSION` and an entry to `CHANGELOG.md` and
   saves both and sends the **release commit** to `main`;
2. for a major version (`N.0.0`), **freezes** it: builds its data files once,
   from the release commit, into `releases/vN/` and saves them in a commit of
   their own ("Freeze release N.0.0");
3. creates the tag `vX.Y.Z` on the shared release commit and sends it together
   with the frozen files in a single update.

If step 2 or 3 fails (for example without a network), "Complete publishing"
repeats them for the same release commit — never for a later state. A tag is
never moved or deleted once it has been sent.

The same can be done by hand:

```sh
echo 1.0.0 > VERSION                       # and edit CHANGELOG.md
git commit -m "Release 1.0.0" -- VERSION CHANGELOG.md
git tag v1.0.0                             # on the release commit
# major versions only: store the stable version in releases/
python3 tools/mund.py freeze HEAD
git add -- releases/v1 && git commit -m "Freeze release 1.0.0" -- releases/v1
git push origin main v1.0.0
```

If the version tag reaches GitHub after `main`, a tag-only push does not
trigger a site build. In the repository's **Actions** tab, open
**Check and deploy**, choose **Run workflow**, select `main` and run it.
The build reads the tag and publishes the site from `main`.

## Stored stable versions

`releases/vN/` holds exactly what the site serves as `data/vN/`
(`manifest.json`, `LT.json`, CSV files, master tables, the raw files and the
zip archive). Its `manifest.json` records

| member | content |
|---|---|
| `version`, `commit`, `date` | the version and its release commit |
| `files`, `archive` | SHA-256 and size of every file of the folder |
| `sources` | SHA-256 of every file the version was made from at the release commit: `VERSION`, data, master tables (constants, Huff factors …), schemas, the tools, the browser core (the conversion code) and the site settings (`site/config.json`: the site address and the data licence) |

`python3 tools/mund.py releases` requires a frozen folder for each major release
tag in the checkout’s history. It checks every stable version: each file against
the manifest (files git ignores, such as .DS_Store, are skipped and not
published), the sources against the release commit, that the folder was saved
once and not changed afterwards, and that the tag is on the release commit (a
missing tag is reported as a warning). CI runs it for every change,
and the site build refuses to publish a stable version that fails it. Because
the files are stored, a stable version stays byte for byte the same when the
data, the format or the tools change later; nothing depends on old tools still
running.

## What the site publishes

The workflow `.github/workflows/site.yml` checks a commit of `main` and then
builds the site from that same commit:

* `data/latest/` from the checked commit — the development version, labelled
  as such on the site;
* `data/vN/` for every stable version, copied from `releases/vN/` after the
  check above.

The site shows the newest stable version by default (`latest` while there is
none). Addresses such as `…/data/v1/csv/LT.csv` are permanent. Minor and patch
versions are not published as separate folders; they are tags in the
repository and can be downloaded from GitHub. A version that does not exist is
reported as such, never replaced by another one.

## Citing

A stable citation links to its frozen version (`?v=vN`). A development
citation gives the version string and, when available, the commit. Its
`?v=latest` link and the files under `data/latest/` and `api/latest/` follow
the most recent published development build. To recover a cited development
build, check out its recorded commit and run `python3 tools/mund.py build`.
For a `.modified` build you also need the local changes. For a build without
a commit, keep a copy of the inputs or the built files.
See [How to cite](https://ribf.riken.jp/muon/#cite) on the site.
