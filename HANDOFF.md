# 開発の引き継ぎ

最新の実装状況は [docs/STATUS.md](docs/STATUS.md)、構成は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照してください。

既存Webは stable/ が正本です。共通API、MCP、iOS基盤はそれぞれ apps/ 以下にあります。ルートで `npm ci`、`npm run check`、`npm test` を実行します。ローカルWebは `npm run dev:web` で起動できます。

デプロイ先・個人の接続状態・実データの記録はこの引き継ぎに含めません。環境ごとの設定は `.cache/cloudflare/deployment.json`、MCP認証情報は `.cache/mcp/` に保管します。運用前に [手順](docs/CLOUDFLARE_RUNBOOK.md) と [セキュリティ](docs/SECURITY.md) を確認してください。

既存のブラウザー編集とローカルの未完作業を保全し、commit対象とデプロイ対象を分けて確認してください。履歴・原成果はローカルに残し、旧版を起動したり古い差分を再適用したりしないでください。

ソース管理の正本は、履歴を引き継がずに切り出した公開リポジトリです。現在のcheckoutのorigin/mainで開発し、個人運用の旧非公開履歴を公開側へ接続しないでください。端末の保存データと認証設定は引き続きGit管理外です。
