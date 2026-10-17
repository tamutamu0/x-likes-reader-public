# Public release / 公開準備

公開するのは汎用ソース・架空fixture・設計・手順・架空データの画像だけです。リポジトリの公開は、稼働中の個人用Webやデータを一般公開する操作とは別です。

## 履歴を分ける

最新ファイルから情報を削除しても、古いcommit・別branch・tag・PR・添付・Actionsログに残る場合があります。現在の非公開リポジトリをそのままPublicへ切り替える前に確認してください。

個別の運用履歴がある場合は、検査済みのソースを `git archive` で切り出し、履歴を継承しない新しいリポジトリを用意する方法が明確です。既存の非公開リポジトリとバックアップを残し、`.git` や `.cache` をコピーしません。既存remoteへ強制pushして履歴を消した扱いにしないでください。

```sh
mkdir -p .cache/public-release
# 公開用commitの内容だけ。未コミットの作業・Git履歴・除外ファイルを含めない
git archive --format=zip HEAD > .cache/public-release/x-likes-reader-source.zip
```

切り出したファイルも公開前に検査します。秘密の流出が疑われる場合は、履歴整理だけに頼らず対象の秘密を失効・再発行してください。

## 確認する範囲

- 全branch・tagのソースとcommit metadata、README・PR・Issue・添付・Wiki・Actionsログ。
- 個人名、ユーザー名、メール、端末パス、本番origin、クラウドID、接続状態、残高・保存件数、実投稿・メモ。
- API秘密、OAuth/セッション/MCPのtoken、秘密鍵、署名付きURL、DB・backup・ブラウザー状態。
- 設定例が架空値で、同期は初期無効・期限は過去になっていること。
- 画像が架空データだけで、顔写真・実投稿・アドレスバー・個別通知・EXIF等を含まないこと。
- 公開用ソースだけで型検査と架空テストを実行し、個人の設定がない環境でもデモが動くこと。
- 依存物のライセンスと、自作部分の再利用を許可するライセンス方針。

既存のWebパッケージは `UNLICENSED` です。公開と、MIT等の再利用許諾は別に決めてください。ライセンス名のバッジだけを付けないでください。

## スクリーンショット

`npm run docs:screenshots` は専用のデモサーバーと新しいブラウザー環境を使います。内蔵サンプルだけを挿入し、外部通信、個人用DB、環境変数ファイル、通常プロファイルを使いません。出所とサイズを `docs/images/manifest.json` に記録し、撮影後に目視確認してください。

スクリーンショットの多言語説明と、アプリ自体の多言語対応を混同しないでください。現在のREADMEは英語・日本語、画面は日本語です。

## English summary

Publish a reviewed source snapshot, not a private deployment's history. Inspect all refs and repository metadata, keep credentials and personal data out, use fictional screenshots, verify the credential-free demo, and decide on a license separately. A public repository is not the same as making the private Web application accessible.

References: [GitHub repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility), [GitHub licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).
