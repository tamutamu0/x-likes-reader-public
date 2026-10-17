# 本人専用の認証・公開範囲

一般ユーザーを受け入れるサービスにはしない。絶対安全・脆弱性ゼロとは保証しないが、閲覧入口、登録方法、保存先への権限を限定する。

## 本番の境界

| Worker | インターネット公開 | 持つ権限 |
| --- | --- | --- |
| margin-api | 本人ログインと認証後のWeb/API | 認証専用D1、静的画面、内部サービス呼び出し。投稿DB・X秘密なし |
| margin-core | **workers.dev・previewとも無効** | 投稿D1、X秘密、暗号化OAuthトークン、Cron。Service Bindingからのみ接続 |
| margin-x-events | CRCと署名付き通知だけ | X署名検証、書き込み専用内部RPC。D1 binding・一覧・ユーザートークンなし |
| margin-preview | **workers.dev・previewとも無効** | 公開サービスのOGP/画像だけ。公開URL・DB・秘密・Cron・VPC bindingなし |

通知は公開側と非公開側の両方で元のHMACを確認する。内部RPCは本文を返さず、永続保存結果のstatusだけを返す。保存失敗は503でXの再送を待つ。処理の起動が失敗しても保存済みinboxをCronが再処理する。公開WebからのAPIも非公開側でセッションを再確認する。

CRCと通知署名が同じ鍵を使うため、CRC入力にJSON構造文字・制御文字・空白を許さない。任意の通知本文をCRCへ渡して署名を作る攻撃を拒否する。これは公式サンプルへの独自の防御追加で、CRCトークンの文字集合を公式が保証したという意味ではない。疎通確認は通し、JSON本文を署名する経路を閉じる。[Xの署名・CRC仕様](https://docs.x.com/x-api/webhooks/introduction)

[Cloudflare Service Bindingの公式仕様](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)では、公開URLを経由せずに呼び出せる。無料枠を維持し、境界を分けるための有料プランを契約していない。

## 本人リンク方式

本人リンク方式はgateway/coreにAUTH_MODE=linkを明示する。設定が欠けても匿名閲覧を許さない。

- Mac管理CLIだけが256-bitのリンクを発行。24時間・1回限定、DBにはSHA-256 hashだけ。一般登録や公開のリンク発行・メール再発行はない。
- fragmentは即消し、正確なOriginとCSRFヘッダーを確認したPOSTで交換。許可消費と別のWebセッション作成はD1 batchで原子的に行い、並行再送でも1回だけ成功。
- セッションは30日、256-bit乱数のSecure/HttpOnly/SameSite=Strict Cookie。hashだけを認証DBに保存し、非公開coreでも確認。この端末/全端末を失効可能。CLI全失効は未使用リンクも破棄する。
- リンクを持つ人は本人と同じアクセスができる。パスキーの端末本人確認と同等ではない。Git・チャット・ログへ出さず、本人だけ読めるMacファイル（600、親700）で渡す。
- 本番リンク方式でパスキー経路は拒否。旧bootstrap・Authorization/Bearer/Accessヘッダーでも迂回できない。

## パスキー実装

以下のパスキー方式も実装と架空テストを保持する。リンク方式の設定では使えない。


- パスワード・一般の新規登録・メールによる再発行・追加の鍵を登録する公開APIを置かない。
- 最初の登録だけ、Macの管理CLIで発行する256-bit乱数の10分・1回限定許可を使う。許可は登録専用で、投稿を読む権限がない。リンクはfragmentから即消去し、Originを確認したPOSTで交換する。
- 登録許可は本人のみ読めるMacのファイル（600、親700）へ書く。ローカルHTTPで配布しない。本人がファイルを開いて登録し、エージェントはfile://のブラウザー操作制限を迂回しない。
- 登録できるownerはDB制約で1つ。登録成功で許可・旧接続を失効し、その後の登録は拒否する。
- SimpleWebAuthn server 14.0.3/browser 14.0.0を固定。RP IDとOriginは設定された本番ホストだけ。user verification必須。cross-origin ceremony、別の鍵、署名不正、5分のchallenge期限切れを拒否する。challengeは検証前にDBで原子的に消費し、再送を受け入れない。公開鍵だけを保存し、秘密鍵や生体情報はサーバーへ渡さない。[公式ライブラリ仕様](https://simplewebauthn.dev/docs/packages/server)
- 認証成功後は256-bit乱数の24時間セッション。DBにはSHA-256 hash、Cookieは`__Host-` / Secure / HttpOnly / SameSite=Strict / Path=/。CookieはJSから読めない。90日の旧セッション、Bearer、Accessヘッダーでは本番を開けない。認証DBが欠けても旧方式へ戻らない。
- 「接続と設定 → ログイン端末の管理」でこの端末/全端末のログアウト。CLIでも全失効可能。端末一覧・公開復旧APIはない。紛失時の鍵再登録は、本人確認後のMac管理作業として別に実装する。

## Web/API

`/mcp-read/` は以下のWeb Cookie経路と別の限定読み取り経路。専用の256-bit/30日/クライアント別キーのhashを認証D1へ保存し、gatewayとcoreで検証する。POSTによるrecent/search/post/statusの4つだけ、Origin/Cookie付きアクセスは拒否。MCPキーを既存Web・/api・/v1・購読変更・認証管理に流用できない。発行/失効はMac CLIだけ。専用60回/分/IP制限、引数/本文/結果の上限、所有者の非公開設定で指定したHTTPS宛先・redirect禁止、投稿TTL検査を設ける。クライアント設定は秘密ファイルのパスだけ。投稿中の指示を信頼せず、PJのコードや秘密を検索へ送らない。[詳細](MCP.md)

すべてのデータ・health・静的ファイルを認証してから振り分ける。未認証APIは401、画面はログインへ移す。別のHost/Originは拒否。Cookieを使う書き込みには正確なOriginとX-Margin-Requestを要求し、CORSを許可しない。認証切れのWebは次のAPI応答でログインへ戻す。

レスポンスにno-store、CSP、frame-ancestors none、DENY、nosniff、no-referrer、HSTS、同一Originのopener/resource制限を適用。第三者スクリプト、inline script、任意HTMLやiframeの実行を許可しない。投稿・メモは文字として描画する。クラウドの任意URL取得は無効。保存済みリンクのカード取得だけ、専用の隔離Workerへ制限する。JSONは実際のストリームのサイズで制限し、SQLはパラメーターを使う。

## リンクプレビューの境界

本人セッション＋正確なOrigin＋X-Margin-RequestがあるPOSTだけ許可し、保存済みsource内のURLと一致することを確認する。画像GETも本人セッションが必須。画像パスを知っているだけでは読めない。GET画像ではimg用途のヘッダー例外を許すがCookie認証は外さない。未認証401と別Origin403を実Workersで検証。

外向きWorkerにはデータ・秘密・内部bindingがない。HTTPSの許可サービスだけに限定し、DNS全件と各redirectを再検査。署名付きURL・認証URL・X/開発Console・非標準ポート・private/reserved IPを拒否する。WorkersのIP固定TLSは保証できないので、任意ドメインのDNS rebinding耐性を主張しない。標準TLS検証を維持し、許可サービスのDNS管理を信頼する。[Cloudflare workerdの制約](https://github.com/cloudflare/workerd/issues/6903)

OGPはnative HTMLRewriterで抽出し、script/HTMLは返さない。画像をPNG/JPEG/WebP・256KiBに限定し、同一Originの認証付き画像APIへ保存。外部Cookie/認証情報や投稿本文・メモは送らない。日次60回と同一URLcacheをD1で制御し、外向き失敗もcacheして再試行の連打を避ける。認証/CSPは維持する。

認証処理はIP単位20回/分のWorkers Rate Limit、challengeは5分と保存件数上限で制限する。これは世界全体での厳密なDDoS上限ではない。無料枠を使い切った場合は利用不能になり得るが、認証を外して継続しない。

## 信頼する範囲と残る限界

Cloudflare管理アカウント・GitHub管理アカウント・Mac/ブラウザー・パスキーを保存する端末/同期アカウントは本人が管理する前提。管理者権限や解除済み端末を他人に渡す場合まで防げるとは言わない。セッションが盗まれた場合、失効するか30日経つまで悪用される可能性は残る。

投稿D1はアプリ上の他ユーザーには公開せず、X更新トークンはAES-256-GCMで保存する。一方、投稿本文はCloudflare側で処理するため、本人だけが復号できるE2E暗号化とは説明しない。メモ・既読・タグは今もブラウザー内IndexedDB。ログアウトで消さず保全するので、端末自体のロックも境界になる。

認証方式のHTTP検証と実ブラウザーの接続確認を分け、未確認の実接続を完了と扱わない。

## 検証・運用

`npm run smoke:security`は架空の認証器で、実際のWorkers crypto/D1上の登録・署名ログイン・本人以外の拒否・CSRF・再送・失効・DBを持たない受信口を確認する。外向きfetchは禁止し、実Xのテスト取得を行わない。

`node --import tsx scripts/auth-admin.mts verify-boundaries`は本番のbinding名/型、公開URL、Cronが非公開coreだけにある設定を確認する。秘密値・本文・Cookie・鍵を出力しない。`status`はowner登録有無と有効セッション数だけを返す。

デプロイ時もmargin-coreの公開URL・previewを無効、gatewayに投稿DB/X秘密なし、receiverにD1なしを維持する。障害時に旧公開Workerへ安易に戻さない。
