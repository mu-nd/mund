# 公開の仕組みと手順

## 1. 仕組み

GitHub Actions(`.github/workflows/site.yml`)が、main への push と Pull Request のたびに次を実行します。

```
push / Pull Request ─▶ check  検証・テスト・ビルド ─┬─▶ deploy  GitHub Pages に公開(main だけ)
                       py39   Python 3.9 でテスト  ─┘
                       (両方が通らなければ公開しません)
```

`python3 tools/mund.py build` が `_site/` にサイト一式を作ります。

| パス | 内容 |
|---|---|
| `/` | Home(周期表、紹介・ニュース・メンバー、引用のしかた。`#about`・`#news`・`#team`・`#cite` で各節へ) |
| `/explorer/` | データの閲覧(`?z=14` で元素を指定。Home の周期表もここに進む) |
| `/downloads/`、`/tools/converter/` | ダウンロード、換算(Converter。Docs から入る) |
| `/docs/…`、`/api/` | 文書と API の説明(`docs/*.md` からビルドのときに作る。貢献者・管理者向けの手順と道具の一覧は `/docs/` の後半) |
| `/api/<版>/…` | プログラム向けの JSON ファイル(元素・核種・エントリー・出典ごと。`docs/api.md`) |
| `/db/` | `/explorer/` への転送(`db/?z=14` を同じ条件のまま送る) |
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

リポジトリの Settings → Pages → Build and deployment → Source を **GitHub Actions** にしておくと(一度だけの設定)、
main への push のたびに `https://mu-nd.github.io/mund/` が更新されます。
版のタグが `main` より後に GitHub に届いた場合、タグだけの push ではビルドが始まりません。
リポジトリの **Actions** で **Check and deploy** を開き、**Run workflow** で `main` を選んで実行します。
タグを含む履歴を使ってサイトが再ビルドされ、公開されます。

## 3. `https://ribf.riken.jp/muon/` で公開する

公開先は `https://ribf.riken.jp/muon/` です。サーバ側で次のどちらかを設定します。

- **転送**: `/muon/` へのアクセスを `https://mu-nd.github.io/mund/` に転送(リバースプロキシ)する。
  更新は GitHub Pages と同時に反映されます。
- **配置**: サーバ上でリポジトリを取得して別のフォルダーにビルドし、出力を `/muon/` の公開ディレクトリに写す。

  ```sh
  git pull --tags          # 固定版の検査に履歴とタグを使う
  pip install -r requirements.txt
  python3 tools/mund.py build --out /path/to/muon-new && rsync -a --delete -nv /path/to/muon-new/ /path/to/muon/
  ```

  `--out` には新しいフォルダー、空のフォルダー、または確認用の `.mund-build` があり内容が一致するビルドの出力を指定します(ほかのファイルがあるフォルダーは消さずにエラーになります)。
  ビルドが途中で失敗したときは `--out` のフォルダーは変わりません(以前のビルドがそのまま残ります)。
  更新のたびにこの手順が必要です(定期実行にできます)。
  初回は公開ディレクトリの控えを取ってください。上の `rsync` は変更予定を表示します。
  `deleting ...` の行は、公開先だけにある削除対象のファイルです。残すファイルがあれば、
  確認用と配置用の両方のコマンドに `--exclude .htaccess` のように除外指定を加えて、もう一度確認します。
  ビルドが成功し、表示された内容でよければ配置します。

  ```sh
  rsync -a --delete /path/to/muon-new/ /path/to/muon/
  ```

## 4. 設定を変えるとき

- リポジトリ名やブランチを変えたら、`site/config.json` の `repository`・`branch` を直します
  (データベースのページの「変更履歴」などのリンクに使われます)。
  公開用ブランチの名前を変えるときは、`.github/workflows/site.yml` の `on.push.branches` にもその名前を指定します。
  `check` の成果物をアップロードするステップと `deploy` ジョブの `if` にある `refs/heads/main` も、どちらも `refs/heads/<公開用ブランチ名>` に合わせます。
- 公開先のアドレスを変えたら、`site/config.json` の `siteUrl` と、`git grep -l ribf.riken.jp/muon` で出てくるファイル(スキーマの `$id`・`$ref`、`CITATION.cff`、文書、テスト)を直します。
