# 公開手順(GitHub Pages)

サイトは GitHub Actions が自動でビルドし、GitHub Pages で公開します。サーバの管理は不要です。

```
main に push ─▶ Check     データ検証・テスト
             └▶ Deploy    サイトをビルド ─▶ GitHub Pages に公開
```

公開されるもの:

| アドレス | 内容 |
|---|---|
| `https://niikura-muon.github.io/mund/` | Explorer(`?z=14` で元素を指定) |
| `…/mund/admin/` | データ入力ツール |
| `…/mund/data/latest/…`、`…/mund/data/v1/…` | データファイル(JSON / CSV / zip) |
| `…/mund/schema/v1/…` | JSON Schema |
| `…/mund/tests/` | 自己テストページ |

## 1. 最初に一度だけ行う設定(リポジトリの管理者)

1. **リポジトリを公開(Public)にする。**
   無料プランの GitHub Pages は公開リポジトリでしか使えません
   (Settings → General → Danger Zone → Change repository visibility)。
   非公開の間も Actions はサイトをビルドし、実行結果の Artifact として保存しますが、公開はしません。
   有料プランで非公開のまま公開したい場合は、Settings → Secrets and variables → Actions →
   Variables に `DEPLOY_PAGES` = `true` を追加します。
2. **Pages の配信元を GitHub Actions にする。**
   Settings → Pages → Build and deployment → Source: **GitHub Actions**
3. Actions タブで **Deploy** を開き、Run workflow(または main に何か push)。
   数分で上のアドレスに公開されます。

## 2. プロジェクトのトップページからリンクする

`https://ribf.riken.jp/muon/` の周期表は `./db/?z=14` のようなリンクになっています。
新しい Explorer も同じ `?z=` を受け付けるので、リンクの先頭を置き換えるだけです。

```html
<!-- 変更前 -->  <a href="./db/?z=14">Si</a>
<!-- 変更後 -->  <a href="https://niikura-muon.github.io/mund/?z=14">Si</a>
```

トップページの HTML で `./db/?z=` を `https://niikura-muon.github.io/mund/?z=` に
一括置換してください。旧 Explorer は不要になります。

## 3. 独自ドメインを使う場合(任意)

`ribf.riken.jp` の下など別のアドレスで見せたい場合は、DNS に CNAME を設定してもらい、
Settings → Pages → Custom domain に登録します。サイトは相対パスだけで作ってあるので、
どのアドレスでもそのまま動きます。あわせて `site/config.json` と
`schema/v1/*.schema.json` の `$id` を新しいアドレスに直してください。

## 4. ローカルで確認する

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python3 tools/mund.py validate        # データの検証
python3 tools/mund.py serve           # http://localhost:8000/ で Explorer、/admin/ で入力ツール
```

## 5. 仕組みのメモ

- `tools/mund.py build` が `_site/` を作ります(`site/` のコピー + `schema/` + ビルドしたデータ)。
- `data/latest/` は現在の main から、`data/vN/` はタグ `vN.0.0` から、そのタグ時点のツールで作られます。
- JavaScript のビルド工程はありません(`site/` のファイルがそのまま配信されます)。
  ビルド時に行うのは、スクリプトとスタイルシートの参照に内容のハッシュ(`?v=…`)を付けることだけです。
  更新直後にブラウザが古いスクリプトと新しいスクリプトを混ぜて読み込むのを防ぐためです。
  それでも古いページが新しいデータを読んだ場合は、Explorer が自動で再読み込みします。
  入力ツールの JSON エディタ(Monaco Editor)だけは CDN(cdnjs)から読み込みます。
  読み込めない場合は簡易エディタに切り替わります。
- リポジトリ名や公開先を変えたら `site/config.json` の `repository` を直してください
  (入力ツールの既定の接続先と、Explorer の「変更履歴」リンクに使われます)。
