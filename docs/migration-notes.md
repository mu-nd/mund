# Notes on the initial data (November 2026)

The first content of this repository is the LT data shown by the project's
previous explorer: 67 experimental values in 2 files, 8 curated values in
1 file and 580 evaluated values in 1 file. This note records what was changed
when the data were brought into the format of this repository, so that
nothing happens silently.
初期データを取り込む際に行った変更の記録です(日本語の要約は各項目の末尾)。

## Corrections

1. **Four element symbols** in the data of Suzuki et al. (1987). They were
   found because two of them produced duplicate identifiers; the atomic
   number that fits the lifetime confirms the correction.

   | value | was entered as | corrected to |
   |---|---|---|
   | 2070.7 ± 3.0 ns | Be-10 | **B-10** |
   | 2096.1 ± 3.0 ns | Be-11 | **B-11** |
   | 554.7 ± 1.0 ns | Si (natural) | **S (natural)** |
   | 83.4 ± 1.5 ns | In (natural) | **I (natural)** |

   These four data points have new identifiers (the old ones belonged to the
   wrong nuclide, two of them clashed with other entries), so no `legacyIds`
   are recorded for them. **Please confirm against the paper.**
   (元素記号の誤記4件を訂正。論文との照合をお願いします。)

2. **Identifiers of the curated data.** They had been computed with the token
   `TH` instead of `CUR`. They were recomputed according to the definition
   (`docs/id-definition.md`); the earlier identifiers are kept in
   `legacyIds`.
   (キュレーションデータの ID は `TH` で計算されていたため、定義どおり `CUR` で再計算。旧 ID は `legacyIds` に保存。)

3. **Identifiers of the evaluated data.** They were random 8-character
   strings. They were replaced by identifiers following the definition
   (MetaID from the DOI 10.1103/PhysRevC.111.034614); the old ones are kept
   in `legacyIds`.
   (評価データのランダム ID を定義どおりの ID に置き換え。旧 ID は `legacyIds` に保存。)

4. **Facility list**: two spelling mistakes corrected (`Liverpool SC`,
   `Liverpool Synchrocyclotron`).

## Conversions

* Units are stored in ASCII: `µs⁻¹` → `us-1`.
* A reference given as `10.1103/vl7z-rzp8; 10.48550/arXiv.2501.05897` became
  `bibId` (the first) and `relatedBibIds` (the rest). The MetaID is unchanged,
  because only the first DOI ever entered it.
* A single uncertainty became one entry of `uncertainties` with the source
  `total`.
* Bibliographic data are a subset of the Crossref records
  (`data/master/bibliography.json`).
* Numbers keep the digits they were stored with (`0.0090`, `13.250`).
* Mass number 0 keeps its meaning (natural abundance); isomer 0 is the ground
  state.

## Written for this repository

* `beam`, `target` and `detector` of the two experimental files are short
  summaries of the experimental set-up, written for this repository. The
  publications are the authoritative description.
  (実験条件の Beam / Target / Detector は、このリポジトリ用に書いた短い要約です。)
* The `method` of the evaluated data ("Gaussian process regression …")
  follows the description in arXiv:2605.15539.
