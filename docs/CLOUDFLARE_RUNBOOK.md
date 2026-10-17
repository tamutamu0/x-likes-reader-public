# Cloudflare 運用

個人用のWorkers/D1をFreeプランで構成するための手順です。実URL、アカウント/DB ID、残高、稼働履歴はこの文書へ書きません。

## 環境ごとの設定

`deployment.example.json` を `.cache/cloudflare/deployment.json` へコピーし、accountId、databaseId、authDatabaseId、origin、webhookOrigin、creditStopAtを自分の環境に合わせます。Wranglerの既存ログインを使用し、管理認証はMCPへ渡しません。

```sh
mkdir -p .cache/cloudflare
chmod 700 .cache/cloudflare
cp deployment.example.json .cache/cloudflare/deployment.json
chmod 600 .cache/cloudflare/deployment.json
# 自分の環境の値を設定してから生成する
node scripts/prepare-deployment.mjs
```

追跡中のWrangler設定は架空ID・サンプルoriginです。生成した `.cache/cloudflare/wrangler*.jsonc` を本番操作に使います。syncEnabledは初期false、creditStopAtは過去の日付です。同期を有効にする前に無料クレジットの期限を設定し、control.freeStopAtを確認します。registerが既存controlを見つけた場合、その期限を自動更新しません。期限未設定・不正なら購読更新と有料参照は停止します。

秘密はWorkers Secretsへ保存し、設定JSONへ書きません。通常運用の値や管理CLI出力はGit管理外に保管してください。

旧Macの取得係を単独で使う場合だけ、Git管理外の `stable/.env.x.local` にX_FREE_STOP_ATを設定します。空・不正・過去の期限では有料取得を停止します。Cloudと同時に起動しないでください。

## 状態と停止

リポジトリのルートで実行。公式Wranglerの既存ログインを使い、秘密や実本文を出力しない。

```sh
node --import tsx scripts/cloud-admin.mts status
node --import tsx scripts/cloud-admin.mts preview-status
node --import tsx scripts/cloud-admin.mts stop
# 原因・残高・台帳を確認してから再開
node --import tsx scripts/cloud-admin.mts start
```

statusのcron時刻とokはinbox/掃除等の成功記録。購読制御の成功はreason=null、lastCheckAtとexpiresAtで別に判断する。reasonがあればCPUや通信を含め調査し、期限が延びていると断定しない。failurePhase/typeは秘密を含まない診断分類。

Webの「自動更新を止める」も購読解除を行う。受信口を閉じるだけでは停止にならない。期限1時間の自然失効が最後の保護。X自動チャージはオフを維持し、クレジット購入・有料プランは別の本人指示が必要。

## この端末のログイン

```sh
node --import tsx scripts/auth-admin.mts link
```

Macの本人専用ファイル .cache/cloudflare/login.html（600、親700）を開く。「本人のWebを開く」からCloudのボタンを押すと、そのブラウザーだけ30日使える。リンクは24時間・1回、接続後は通常のWeb URLをブックマークできる。新しく発行すると未使用の古いリンクを無効にするが、既存ブラウザーは維持する。リンクをチャット・Git・第三者へ貼らない。パスキー登録は不要。

本番gateway/coreはAUTH_MODE=linkを明示。verify-linkは一時許可でhealthと静的画面・再利用拒否・ログアウトを検証し、X投稿を取得せず秘密を出力しない。

端末停止はWebの「接続と設定 → ログイン端末の管理」。緊急時はauth-admin revoke-allで全セッションと未使用リンクを失効。statusはパスキー登録有無と有効セッション数だけ。cancel-setupは保留した登録許可だけを失効。[境界と制限](SECURITY.md)

## デプロイと検証

```sh
npm run check
npm run test -w @margin/api
npm --prefix stable test
npm run build -w @margin/api
npm run build:core -w @margin/api
npm run build:webhook -w @margin/api
npm run build:preview -w @margin/api
npm run smoke:activity
npm run smoke:security
npm run smoke:preview
npm run smoke:x-control
WRANGLER_SEND_METRICS=false npx wrangler deploy --config .cache/cloudflare/wrangler.preview.jsonc
WRANGLER_SEND_METRICS=false npx wrangler deploy --config .cache/cloudflare/wrangler.core.jsonc
WRANGLER_SEND_METRICS=false npx wrangler deploy --env='' --config .cache/cloudflare/wrangler.jsonc
WRANGLER_SEND_METRICS=false npx wrangler deploy --config .cache/cloudflare/wrangler.webhook.jsonc
node --import tsx scripts/cloud-admin.mts verify-public
node --import tsx scripts/auth-admin.mts verify-boundaries
```

テストは架空データだけ。smokeの外向き通信は禁止。verify-publicはCRCと未認証拒否のみでX投稿を参照しない。実いいねを何度も取得してQAしない。最新版のデプロイ後、実Cronと期限更新の状態を確認する。

投稿D1はmargin-reader（0001〜0008）、認証D1はmargin-auth（auth-migrations/0001〜0003）。事前にバックアップ・差分を確認して適用。0007はpreview cache/日次予算、0008はMCPの時刻index。auth/0003は専用read tokenのhash/期限/失効table。適用済みの旧migrationを再適用しない。Wrangler Secretsの値はCLI引数・ログ・文書へ書かない。固定X秘密3項目と本人IDは非公開core、Client Secretと本人IDだけを受信側へ保存する。公開gatewayにX秘密を置かない。更新トークンは投稿D1 x_runtimeに暗号化して置く。初回はpreview→core→秘密保存→gateway→receiverの順で用意し、verify-boundariesで確認する。

本人用MCPは追加Workerを作らず、gatewayの限定read経路からcoreを参照。クライアント別30日キー・60回/分/IP制限をWeb認証と分ける。発行/失効・stdio接続確認は [MCP.md](MCP.md)。デプロイ時は公開対象の静的ファイルだけを配置し、別作業の未公開UIや個人データをassetsへ混ぜない。

## プレビュー運用

4 Worker/2 D1で無料プラン維持。margin-previewは公開URL・preview・Cron・bindingを持たず、coreだけがPREVIEW bindingを持つ。画像APIも本人セッションが必須。

取得は表示中のカードだけ、同時2件、UTC日次60回まで。URLごと最大7日/失敗24時間cache、source期限以内。HTML/画像256KiB・全体10秒・redirect3回。未知サイト、署名/認証URL、private DNS、巨大画像は文字カードへ戻る。制限を外して全件backfillしない。許可ホストはpreview-network.ts、信頼境界はSECURITY.md。

smoke:previewはnative HTMLRewriterだけを架空HTMLで検証し、外向き通信を禁止する。本番確認はverify-linkのhealth/静的JS/未認証画像拒否/不存在画像404とverify-boundariesで実施。実いいねを再取得しない。公開ページの通信確認は隔離Workerから既知の公開1URLだけを使い、本人の実リンク・本文・メモをfixtureへ転記しない。

## 移行・復旧

migrateは元のSQLiteを一貫してバックアップし、Mac定期取得を停止、保存済みsourceと台帳だけをD1へ移す。既存D1の投稿・本人編集・更新済みトークンは上書きしない。Xの再取得は0件。通常運用で繰り返す必要はない。

本人の既読・メモ・タグは現在も各originのIndexedDB。旧Mac Webでバックアップを書き出し、Cloud Webでプレビューを確認して復元する。未編集投稿だけファイルの本人編集を復元し、移行先の編集を優先、確認後の競合を拒否。元データ/バックアップは残す。複数端末への編集同期はまだない。

**Mac側をそのまま再開しない。** Cloudのrefreshにより元Macのrefresh tokenは古くなる。ロールバック時は先にcloud購読を停止し、最新トークンを安全な手順で移してから取得係を1つだけ再開する。refreshUncertainは勝手に消さず、再認証または更新結果を確認して復旧する。期限・予算台帳・無料残高をリセットして枠を増やさない。

`.cache/cloudflare/` は700、秘密・ログインHTML・移行報告・SQLite/JSONバックアップは600。Git対象外。元Macの保存先も保全する。実投稿・メモ・個別ID・通知本文を運用文書へ転記しない。
