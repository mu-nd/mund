# Versions of the data

## Why

People who use the data in a simulation or a publication need a version that
never changes, so that results can be reproduced and cited. The compilers, on
the other hand, change small things all the time. Both needs are served:

* **Released versions** are frozen. The public site offers one per *major*
  version (`v1`, `v2`, …) and shows the newest one by default.
* **latest** is the current state of the `main` branch. It is always
  available, clearly marked as a development snapshot.
* **Everything else** is in the git history: every commit records who changed
  what, when and why, and any past state can be recovered.

## Version numbers

`MAJOR.MINOR.PATCH`, stored in the file `VERSION` and as git tags `vX.Y.Z`.

| part | raise it when | example |
|---|---|---|
| PATCH | existing entries are corrected (a typing error, a comment) | 1.0.0 → 1.0.1 |
| MINOR | data are added | 1.0.1 → 1.1.0 |
| MAJOR | a new public release is frozen; also when something is removed or the meaning of existing data changes | 1.4.2 → 2.0.0 |

Between releases the state of the repository is identified as
`<last tag>+<commits since>.g<commit>` (for example `1.0.0+12.g3fa2c1b`), or
`0.1.0-dev+g<commit>` before the first tag. Individual commits do not get
version numbers of their own.

## How a release is made

In the data entry tool, page **Release**: choose patch / minor / major and
describe the changes. The tool

1. writes the new number to `VERSION` and an entry to `CHANGELOG.md`,
2. commits both, and
3. creates the tag `vX.Y.Z` on that commit.

The same can be done by hand:

```sh
echo 1.0.0 > VERSION            # and edit CHANGELOG.md
git commit -am "Release 1.0.0"
git tag v1.0.0
git push origin main v1.0.0
```

## What the site publishes

The deploy workflow builds

* `data/latest/` from the current `main`, and
* `data/vN/` from each tag `vN.0.0`, **using the tools of that tag** — an old
  release is rebuilt exactly as it was, even after the format or the tools
  have changed.

Addresses such as `…/data/v1/csv/LT.csv` are therefore permanent. Minor and
patch versions are not published as separate folders; they are tags in the
repository and can be downloaded from GitHub.

A tag must never be moved or deleted once it has been pushed.

## Citing

Cite the version (for example "muND v1.0.0") together with the project paper
(see `CITATION.cff`). A DOI per release can be obtained by connecting the
repository to Zenodo; this has not been set up yet.
