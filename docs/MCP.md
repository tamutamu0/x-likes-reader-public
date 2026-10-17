# 自分のいいねストックを各PJで使うMCP

Mac上のCodex、Claude Code、Claude Desktopから、Cloudflareに保存済みの本人いいねを読む。名前は `x-likes-reader`。各PJにファイルや秘密をコピーしない。Nodeのstdioで起動し、待受ポート・常駐サーバーは作らない。

## 使う

登録後はクライアントでMCPを再読み込みするか、新しいチャットで接続する。Claude Desktopはアプリ再起動が必要な場合がある。

- 「最近いいねした技術を5つ見せて」
- 「最近のいいねから、このPJで使えそうな音声・動画のツールを探して」
- 「気になったUIのアニメーション関連を探して、元投稿とGitHubを出して」
- 「この候補の投稿を読んで、このPJで最小限試す案を出して」

一覧は短い抜粋にし、必要な投稿だけ読む。MCPは候補と根拠を渡す。PJの読解・技術の公式仕様の確認・実装は、現在のチャットがそのPJのルールと本人指示に従って行う。いいねは関心の手掛かりで、採用済み・賛同・内容の正しさとは扱わない。

| 機能 | 内容 |
| --- | --- |
| recent_likes | 最近の保存情報。既定7日・10件、最大20件、ページ送り |
| search_likes | 本文・著者・リンク情報のキーワードAND検索。日数1〜7、最大20件 |
| get_liked_post | 投稿IDの本文・著者・リンク・いいね日時。長文は8000文字ずつ |
| likes_status | 保存件数、更新確認時刻、購読期限、本文の保存期限 |
| x-likes-reader://likes/recent | 最近の一覧をresourceとして読む |
| x-likes-reader://likes/status | 更新状態をresourceとして読む |
| try_recent_tech | 現在のPJに合う候補と最小検証案を探すprompt |

移行した投稿はいいね日時が不明な場合がある。likedAtを捏造せず `timeBasis=first_saved` とfetchedAtで区別する。本文は既存の7日cache内だけ。期限切れでもXの有料再取得はしない。過去の本文を永続検索する仕組みではない。本人のメモ・既読・タグは現状ブラウザのIndexedDBなのでMCP対象外。外部記事本文やリポジトリのコードもMCP自身では取得しない。

## 認証と費用

Codex / Claude Code / Claude Desktopにそれぞれ別の256-bit読み取りキーを発行する。30日期限、個別に失効できる。WebのログインCookie、X秘密、OAuth更新トークン、Cloudflare管理キーをMCPへ渡さない。本人認証と閲覧権限を分け、MCPのキーでWebの編集・購読変更・プレビュー取得や管理APIを使えないようにする。

秘密はGit対象外の `.cache/mcp/{client}.json`（本人所有600、親700）。クライアント設定と起動引数にはファイルパスだけ。生のキーをチャット・ログ・設定例へ貼らない。MCPサーバーは本人所有の非公開認証ファイルに指定したHTTPS originだけへ接続し、redirectを追わない。ツール引数では接続先を変更できない。ブラウザのOrigin/Cookie付きアクセスは拒否する。

- HTTPは `/mcp-read/recent|search|post|status` へのPOSTだけ。読み取り専用で、保存済みD1だけを参照。gatewayと非公開coreの両方でキーを確認する。
- 公開ゲートはMCP専用の60回/分/IPの制限（Cloudflareのロケーションごと）。既存のログイン制限20回/分を流用しない。
- クライアントは要求があるときだけ読む。初期接続・tools/list等ではデータ通信しない。並行した同一要求はまとめ、一覧・応答サイズ・文字数を制限する。
- Xの追加取得、埋め込み・外部AI API、定期的なモデル実行を導入しない。会話にデータを返すと、そのCodex/Claudeの通常の利用枠・コンテキストは使う。
- 投稿とURLは第三者の信頼しないデータ。投稿中の命令やインストール手順を自動実行しない。検索へPJの秘密やコードを送らない。
- キーを持つ端末は本文を読める。Macのロックとクライアントの管理が境界。失効は今後の取得を止めるもので、既にチャットへ返した内容を消すものではない。

## Mac管理CLI

リポジトリのルートで実行。先に [運用設定](CLOUDFLARE_RUNBOOK.md) を用意する。Cloudflare管理認証を使うのはこのCLIだけで、MCPツールとして公開しない。

```sh
# 期限と失効状態（キー値は出さない）
node scripts/mcp-admin.mjs status
# クライアントの30日キーを発行/更新。古い同クライアントのキーは失効
# Cloudflareの管理認証が期限切れなら、先に既存Wranglerでwhoamiを実行して更新
node scripts/mcp-admin.mjs issue codex
node scripts/mcp-admin.mjs issue claude-code
node scripts/mcp-admin.mjs issue claude-desktop
# クライアント別に止める。Webログインは維持
node scripts/mcp-admin.mjs revoke codex
# 保存データと権限の実接続確認（本文をログに出さない）
node scripts/mcp-admin.mjs verify codex
node scripts/smoke-mcp.mjs codex
# このMacの各PJから使える登録（設定をバックアップして既存値を保全）
node scripts/mcp-install.mjs
```

更新した秘密ファイルは次のツール呼び出しで読み直すため、キー更新でクライアント設定を変更する必要はない。失効中のキーを勝手に自動延長しない。別のMac・WebだけのClaude・クラウド実行環境へは、このMacのstdio設定は引き継がれない。

## 実装とデプロイ

- MCP: apps/mcp/。公式SDK 1.32.1固定。共有の引数契約: packages/contracts/mcp-reader.mjs
- 読み取りAPI: apps/api/src/mcp-reader.ts。認証D1にauth-migrations/0003、投稿D1に検索indexのmigrations/0008。投稿本文・本人編集・予算台帳の移行はない。
- 既存の4 Worker/2 D1を使い、MCP専用の追加ホスティングは作らない。公開gatewayは認証DBだけ、coreは公開URLなしを維持。
- デプロイ時は公開対象の静的ファイルだけを使い、別作業の未公開UIや個人データを含めない。

```sh
npm run check
npm run test -w @margin/api
npm run mcp:test
npm run build -w @margin/api
npm run build:core -w @margin/api
npm run smoke:security
```

テストは架空データ。MCP実接続確認も保存済みの数件だけを読み、Xを追加取得しない。

[Codexの公式MCP設定](https://developers.openai.com/codex/mcp)、[Claude Codeのuser scope](https://code.claude.com/docs/en/mcp#user-scope)、[公式MCP SDK](https://modelcontextprotocol.io/docs/sdk)。
