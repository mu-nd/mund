# 公開の仕組みと手順

## 1. 仕組み

```
push / Pull Request ─▶ check    データの検証とテスト
main への push       ─▶ check ─▶ build    サイトをビルド ─▶ deploy   GitHub Pages に公開
                       (検査が通らなければ公開しません)
```

`python3 tools/mund.py build` が `_site/` にサイト一式を作ります。

| パス | 内容 |
|---|---|
| `/` | Home(周期表、紹介・ニュース・メンバー、引用のしかた。`#about`・`#news`・`#team`・`#cite` で各節へ) |
| `/explorer/` | データの閲覧(`?z=14` で元素を指定。Home の周期表もここに進む) |
| `/downloads/`、`/tools/converter/` | ダウンロード、換算(Converter。Docs から入る) |
| `/docs/…`、`/api/` | 文書と API の説明(`docs/*.md` からビルドのときに作る。貢献者・管理者向けの手順と道具の一覧は `/docs/` の後半) |
| `/api/<版>/…` | プログラム向けの JSON ファイル(元素・核種・エントリー・出典ごと。`docs/api.md`) |
| `/db/` | `/explorer/` への転送(プロジェクトサイトの周期表が使っていた `db/?z=14` のアドレスを、同じ条件のまま送る) |
| `/data/latest/…`、`/data/v1/…` | データファイル(JSON / CSV / zip) |
| `/schema/v1/…` | JSON Schema |
| `/tests/` | ブラウザで動くテスト |

- `site/` のファイルがそのまま配信されます(JavaScript のビルド工程はありません)。
  ビルドが加えるのは、各ページのフォルダー(`site/index.html` を元に作る)、文書のページ、データ(`data/`)、
  API(`api/`)、スキーマ、テストと、スクリプト・スタイルシートの参照に付ける内容のハッシュ(`?v=…`)です。ハッシュにより、更新後にブラウザが古いスクリプトを使い続けることがありません。
- `data/latest/` はビルドしたコミット(CI では検査したのと同じコミット)から作られます。
  `data/vN/` は、リリースのときに一度だけ作って `releases/vN/` に保存した固定版のファイルを、
  ハッシュを確かめたうえでそのまま配信します(作り直しません。`docs/versioning.md`)。
- サイトは相対パスだけで作ってあるので、どのアドレス・どの階層に置いても動きます。
- 外部から読み込むものはありません(書体は端末のものを使います)。
- データ入力ツール(`admin/`)は公開しません。データを入力する人の PC で動かします(`docs/admin-guide.ja.md`)。

## 2. GitHub Pages

リポジトリの Settings → Pages → Build and deployment → Source を **GitHub Actions** にしておくと、
main への push のたびに `https://mu-nd.github.io/mund/` が更新されます。

## 3. `https://ribf.riken.jp/muon/` で公開する

公開先は `https://ribf.riken.jp/muon/` です。サーバ側で次のどちらかを設定します。

- **転送**: `/muon/` へのアクセスを `https://mu-nd.github.io/mund/` に転送(リバースプロキシ)する。
  更新は GitHub Pages と同時に反映されます。
- **配置**: サーバ上でリポジトリを取得してビルドし、出力を `/muon/` の公開ディレクトリに置く。

  ```sh
  git pull --tags          # 固定版の検査に履歴とタグを使う
  pip install -r requirements.txt
  python3 tools/mund.py build --out /path/to/muon
  ```

  更新のたびにこの手順が必要です(定期実行にできます)。


## 4. ローカルで確認する

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python3 tools/mund.py validate        # データの検証
python3 tools/mund.py serve           # http://localhost:8000/ にサイト一式
```

## 5. 設定を変えるとき

- リポジトリ名やブランチを変えたら、`site/config.json` の `repository`・`branch` を直します
  (データベースのページの「変更履歴」などのリンクに使われます)。
- 公開先のアドレスを変えたら、`schema/v1/*.schema.json` の `$id`、`CITATION.cff` の `url`、
  `README.md` のアドレスを直します。
