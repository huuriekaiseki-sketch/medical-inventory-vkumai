# 鍵・権限・token の四半期棚卸し（access review runbook）

鍵・token・権限・runbook は「作った日から古くなる」。使っていない権限や期限の無い token は、
漏れたときに気づく手段が無いまま残る（issue #757 の 36。29 のローテーション実測、35 の設定ドリフトと
一体）。依存の月次棚卸し（[`dependency-update-runbook.md`](./dependency-update-runbook.md)）と同じ型で
「次回実施予定日」を持ち、SessionStart hook（`scripts/check-access-review-staleness.sh`）と
`claude -p --maintenance`（`scripts/maintenance-digest.sh`）が期限切れを警告する。

鍵の種類と所在の正本は代替経路の棚卸し（access-path-inventory.md、26 番の PR）の「鍵の所在」表。
本ファイルはそれを**定期に見直す入口**で、「最後に確認した日」と「棚卸しの結果」を持つ。

## 次回実施予定日

2026-12-06（四半期の目安。鍵の漏洩が疑われたとき、admin 利用者を足したとき、外部連携を足したときは
予定日を待たず実施する。実施後に手動で書き換える）

## 手順（30 分）

1. **公開 RPC のうちアプリが使っていないもの**を機械で出す:
   `bash scripts/check-constraint-coverage.sh --json rpc` の `functions[]` で `exposedVia` が空でなく
   `appUses: false` のもの。認可述語（`is_admin` / `is_facility_member` / `is_facility_writer` / `has_aal2`）は
   RLS の要で残す（P-045 が境界テストを持つ）。それ以外は REVOKE を検討し、決めた理由を下の記録に書く。
2. **Supabase**: ダッシュボードの Project Settings → API で anon / service_role key の発行日を見る。
   ローテーションしたことが無ければ #757-29 の実測と同時に決める。Auth → Users で admin ロールの利用者数
   （`user_facilities` の `role='admin'`）を数え、増減の理由が分かるか確認する。
3. **Vercel**: 環境変数に `SUPABASE_SERVICE_ROLE_KEY` と `ADMIN_EMAILS` があるか。**DB に admin が 1 人以上
   いる間 `ADMIN_EMAILS` は効かない**（`resolveIsAdmin` は `db_has_admin` が false のときだけ見る）ので、
   admin がいるなら空にして未使用の権限を消す。preview 環境の変数が本番と同じ Supabase を指していないか（X-030）。
4. **GitHub**: `gh auth status` で token の scope を見る（`project` 以外に不要な scope が無いか）。
   Settings → Developer settings の PAT 一覧で期限切れ・未使用を消す。Actions の secrets は
   `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` の 2 つだけであることを確認する。
5. **SSH 鍵と第 2 リモート**: GitHub / GitLab に登録した公開鍵が開発機の `~/.ssh/id_ed25519.pub` と一致し、
   使っていない鍵が残っていないか。
6. **手順書の鮮度**: `bash scripts/maintenance-digest.sh`（`MAINTENANCE_DIGEST_PLAIN=1`）で 5 つの期限を見る。
   `docs/agents/*-runbook.md` と `SPEC.md` の最終更新が 3 か月以上前なら中身を読み直す。
7. 「最後に確認した結果」と「次回実施予定日」を更新する。

## 判断の目安

| 対象 | 残す条件 | 消す・絞る条件 |
| --- | --- | --- |
| 公開 RPC | アプリが呼ぶ、または RLS の認可述語 | どちらでもない → REVOKE FROM anon, authenticated（P-044 の型） |
| admin 利用者 | 直近 3 か月に admin 操作の監査行がある | 無ければ staff に降格（P-023 で即時に効く） |
| `ADMIN_EMAILS` | DB に admin が 0 人（初期化中） | admin がいる → 空にする |
| token / PAT | 期限が付いていて、用途が 1 つ書ける | 期限なし・用途不明 → 失効 |
| SSH 鍵 | 開発機の鍵と一致する | 一致しない・持ち主不明 → 削除 |

## 最後に確認した結果

### 2026-09-06（初回。GitHub 停止中のため GitHub 側は未確認）

- 公開 RPC 13 本のうちアプリが使わないもの 4 本: `has_aal2` / `is_admin` / `is_facility_writer`（認可述語、残す）、
  `resolve_jan_unit_price`（SECURITY INVOKER で RLS が効く。発注 RPC の内部でしか使わないため、次の migration で
  anon / authenticated から REVOKE する候補。`-- release-order: db-first`）。
- Supabase の anon / service_role key: ローテーション実績なし（#757-29）。発行日はダッシュボード未確認。
- Vercel: `ADMIN_EMAILS` の有無と preview 環境の Supabase URL は未確認（#757-35 と同時）。
- GitHub: `gh auth status` はアカウント停止中で実行不能。復旧後に scope を確認する。Actions の secrets は
  ワークフロー上 2 つ（`schema-drift-check.yml`）。
- SSH 鍵: `id_ed25519` 1 本を GitHub と GitLab（2026-09-06 登録）で共用。
- 手順書: 5 本とも期限内（fault injection 12-06、hook 実走 12-05、docs 差分 10-05、依存 10-06、本表 12-06）。
