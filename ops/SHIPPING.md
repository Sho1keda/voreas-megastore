# 発送通知 自動化・デプロイ・復旧手順（2026-10-20）

## 現在の判断と制約
- 既存185注文への発送通知はS I判断で禁止。`shipping_exclusions` に理由・判断参照・元CSV hashを保存し、送信済みを偽装しない。手動send・自動送信両方のD1 claim文で除外する。TESTは顧客送信ではないため可能。
- Squareデータは読み取りのみ。購読 `wbhk_e5c450b6f83d48028ac335970afab186` へのorder.updated追加も、S Iが操作するか、別途API更新の明示許可が必要。
- `SHIPPING_AUTO_ENABLED` 未設定/`false` はOFF。`true` かつ `SHIPPING_AUTO_START_AT` RFC3339時刻以降の発送だけ対象。開始時刻はGO時に固定し、後続デプロイで変更しない。
- 自動送信OFFでもWebhookは署名検証し、除外/disabledをD1に記録。D1未設定/テーブルなし/署名キー未設定は503。

## 認証済み環境での安全な適用（顧客送信なし）
既存本番: deployment f72c3b31、D1 voreas-shipping `41d44ad8-5031-4944-b271-7b9ec9fc1178`。既存binding・6 secret等を保持。新規DBを作らない。

1. `_worker.js` とopsをレビュー対象へ展開。既存production workerと差分確認（基点a32a8c3＋notify-shipped資産）。
2. 既存D1の通知記録を読み取り確認/退避。既存TEST行を保持。
3. `wrangler d1 execute voreas-shipping --remote --file ops/shipping-schema.sql`
4. **必須追加migration**: `wrangler d1 execute voreas-shipping --remote --file ops/shipping-auto-schema.sql`
5. 元CSV（旧スレッド6910837添付0）から `node ops/seed-shipping-exclusions.mjs <CSV> <private-output.sql>`。185件一意の形式検査済みSQLを生成。添付のshipping-exclusions-185.sqlも同じ内容。**個人情報を含む元CSVを公開/commitしない**。
6. `wrangler d1 execute voreas-shipping --remote --file <private-output.sql>`。INSERT OR IGNOREで既存通知記録を変更しない。batch=legacy-185-20261020の実ID集合を読んでソート・改行結合のSHA256が `1f3f9b0e694c4ed2b938742f461ab8b8e06bd0d0feca23268f546ec7588eb550`、件数185と確認。元CSV SHA256=`e9027d9dda95431b9198c8c229eb11654afc4c84db2c2988514298fbe9633800`。
7. 既存D1 binding SHIPPING_DB、SQUARE_ACCESS_TOKEN、RESEND_API_KEY、SHIPPING_ADMIN_TOKEN、SQUARE_WEBHOOK_SIGNATURE_KEYを維持。**署名キーの存在/購読一致が必須**。旧実装は署名不一致を許可したが、新実装は全イベントで拒否する。これがないままデプロイしない（返金・キャンセル連携も停止する）。
8. production `SHIPPING_AUTO_ENABLED=false` を明示し、既存のSHIPPING_APPROVED_MANIFESTがあれば解除（過去一斉送信の承認用途は終了）。secret変更の反映にデプロイが必要なら必ず同時実施。
9. サイト全体の配信コピーを作り、_worker.jsを置換。`.git`/`ops`/SQL/顧客CSV/テストを配信物から除外し、既存と同じwrangler.toml/D1 bindingで `wrangler pages deploy <配信dir> --project-name voreas-megastore --branch main`。
10. 本番で無署名/不正署名Webhook→401、管理API無認証→401、認証dry-run→200・exclusions185・TEST記録保持・autoEnabled=falseを確認。署名付きfixture（実注文変更なし）で旧ID→excluded_permanently、対象ID→disabled、顧客送信増分0を確認。
11. 正当な署名付きpayment.updated/refund.created fixtureを既存連携の検証計画に従って確認（下流の実スプレッドシートへのテスト投稿は別途管理）。実顧客の返金・決済を起こして試さない。

## GO後の開通
1. CR1/QA1ゲート後、S Iの明示GOと承認メッセージを記録。
2. S IがSquareダッシュボードで既存購読にorder.updatedを追加。API更新は許可があった場合のみ。他のevent_types、endpoint、versionを保持。現API version=2026-08-19をむやみに更新しない。
3. `SHIPPING_AUTO_START_AT=<GO時点のUTC RFC3339>` と `SHIPPING_AUTO_ENABLED=true` を設定し反映。開始前の発送は明示的にheld。配送完了後に追跡番号が追記された場合は、その更新で再判定する。
4. 最初の実発送でWebhook受信→D1 pending→Resend受付→sentを確認。Resendのdelivered/bounceも確認し、単にsentを受信箱到達としない。GO前に本番顧客へfixtureメールを送らない。
5. 緊急停止はSHIPPING_AUTO_ENABLED=falseを反映。送信開始済みのin-flight1件を撤回はできない。D1 claimや除外は消さない。

## 送る条件／保留条件
- 署名は設定済み通知URL＋raw bodyのHMAC-SHA256/base64、定数時間比較。URLは `https://voreas-megastore.pages.dev/api/webhooks/square` と完全一致必須。
- `order.updated.data.object.order_updated.order_id` からGET /v2/orders/{id}で現注文を取得。source=voreas-ec、所定location、非CANCELED、SHIPMENTが**1つだけ**、そのstate=COMPLETED、追跡番号あり、shipped_at>=開始時刻。
- 自動宛先はshipment.recipient.email_addressのみ。メール不明/不正はheld。手動dry-runではpayment/customerのID一致参照で補完できるが名前推測は禁止。
- 複数発送は未完了分を含めて全てheld。1注文1通が上限。後から別発送が追加された場合も既存claimは破らず個別連絡へ。
- 明示キャリアはヤマト/佐川/日本郵便のみ。番号をNFKC・ハイフン/空白正規化し10〜14桁検証。番号形式だけでキャリアを決めない。Squareの任意tracking_urlはそのまま使用せず、既知公式ドメインのURLを構築。
- 既存送信claimはpending/sent/unknown/provider_errorいずれも自動再送しない。手動と自動は同じorder_id PK・同じResend idempotency keyを共有。
- 文面はテスト確認済み既存shippingEmail関数をそのまま共用（遅延お詫び・行き違い案内も維持）。通常通知向けにこの一文を削る変更は別途文面確認後。
- 自動処理のSquare呼び出しは4秒、Resendは3秒で打切り、本文/署名/宛先/トークンをログへ出さない。D1には注文/イベントIDと結果・保留理由を記録。

## 日常確認とリカバリ
管理POST `/api/manage/notify-shipped`、`Authorization: Bearer $SHIPPING_ADMIN_TOKEN`、JSON `{"mode":"dry-run"}`。トークンをURL/会話/公開ファイルへ書かない。

- dry-runは送信/D1変更なし。`rows`と`records`を注文IDで突合。`exclusions`は恒久除外で未通知障害に数えない。`unnotified`が除外/claimなしの候補（GO前や保留も含むため、開始時刻・heldと照合）。
- `observations`は最新1000イベントの理由。全件監査はD1 `SELECT order_id,outcome,detail,updated_at FROM shipping_observations ORDER BY updated_at DESC`。通知claimは `SELECT order_id,status,resend_id,updated_at FROM shipping_notifications`。
- 受信漏れはSquare Event Logsのendpoint・order.updated購読・401/503/timeout・retryを調査。24時間を過ぎると再送停止するのでdry-run突合を必ず併用。
- メール/キャリア/複数発送のheldは担当者がSquareの正しい情報を確認。Square変更はS Iが実施。情報修正のorder.updatedで再判定するが、複数発送は自動化せず個別対応。
- 未claimで1発送が適格になった個別回復は、最新dry-run hash→test（S I宛固定）→受信確認と対象IDの明示承認→SHIPPING_APPROVED_MANIFEST設定→`{"mode":"send","manifestHash":"<hash>","orderIds":["<対象ID>"]}`。1〜10件、除外185件には送れない。承認前に設定しない。使い終わったら承認hashを解除。
- pending/unknownはResendのログで受付/配信結果を注文のIdempotency-Keyと突合。**D1削除・時限失効・盲目的再送は禁止**。既知のprovider_error（429/5xxを含む）も自動再試行せず個別対応。集中発送でResendレート制限が起き得るため、初期運用は少数発送で監視し、バルク発送前にキュー/レート制御拡張を検討する。既存テーブルのclaim解除機能はない。
- 不達・明確な非受付は人が配信履歴を確認し、対象注文と再連絡方法をS Iへ提示して個別承認を得る。手動メール等で連絡した場合は別の監査記録に残し、既存sent状態を偽装しない。現在このAPIに強制再送機能はない。

## 一次情報（2026-10-20確認）
- https://developer.squareup.com/reference/square/orders-api/webhooks/order.updated （全文でなく要約、Beta）
- https://developer.squareup.com/reference/square/orders/retrieve-order （ORDERS_READ、現在状態）
- https://developer.squareup.com/docs/webhooks/step3validate （通知URL＋raw body・署名検証）
- https://developer.squareup.com/docs/webhooks/overview#notification-retries （重複/順不同、非2xx再送・最長24時間）
- https://developer.squareup.com/docs/webhooks/step2subscribe#format-of-an-event-notification （10秒超はtimeout）
- https://developer.squareup.com/reference/square/objects/OrderFulfillmentShipmentDetails （shipped_at=COMPLETED移行、任意tracking fields）

公開APIリファレンスの最新表示は2026-09-16。既存購読は2026-08-19を保持し、新しいAPI版へ無断変更しない。再送間隔は前回から1/2/4/8/16/32/60分、2/4/8/8時間。event_id記録に加え注文IDの永続claimで24時間後も重複を防ぐ。

## ローカル検証
```sh
node --experimental-default-type=module ops/shipping.test.mjs
node --experimental-default-type=module ops/shipping-auto.test.mjs
```
既存22＋自動36項目。`python3 ops/shipping-db.test.py <private-seed.sql>` でSQLite実行・185件のID集合digest・全185件のclaim拒否・既存TEST保持を検証。本番D1のOFF稼働確認は別途必要。
