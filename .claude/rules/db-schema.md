---
paths:
  - "supabase/migrations/**"
---

# DBスキーマ変更ルール

- **DBスキーマ変更は必ず `supabase/migrations/` 配下のマイグレーションファイル経由で行う。**
  `execute_sql` 等による直接実行・直接DDL適用は禁止（ローカル・リモート問わず）。
  `supabase db execute`・`psql`直接実行、およびMCP経由のexecute_sql系ツール呼び出しは
  PreToolUse hook（`scripts/check-direct-ddl-execution.sh`、issue #444）で機械的にdenyされる
  （`db push`/`db reset`等の正規のmigration適用手段は対象外）
- **2026-09-07 以降の migration は先頭付近に `-- release-order: db-first` か `-- release-order: app-first`、
  末尾に `-- ROLLBACK:` を書く**（`scripts/check-migration-release-safety.test.sh` が必須にする、issue #757 の 13・25）。
  認可を絞る・列や関数を足す変更は `db-first`、列・表・関数・ポリシーを消す・改名する・型を変える
  変更（contract）は `app-first` にし、`-- contract:` に「どの PR 以降のアプリが参照しなくなったか」を書く。
  順序の理由と混在期間の表は [`../../docs/agents/release-safety-runbook.md`](../../docs/agents/release-safety-runbook.md)
- マイグレーション外で本番/リモートDBに存在するスキーマ変更（トリガー・関数等）を発見した場合は、
  差分をキャッチアップ用マイグレーションとして必ず記録してから作業を進める
- 理由（過去のスキーマドリフト事例）は [`../../docs/agents/decisions/db-rls.md`](../../docs/agents/decisions/db-rls.md#なぜdbスキーマ変更をmigrationファイル経由に限定し直接ddl実行を禁止したか) を参照
- **その表への書き込みを止める DDL を書いたら `-- lock:` の 1 行を添える**（issue #757 の 18）。
  対象は CREATE INDEX（CONCURRENTLY 無し）・ADD CONSTRAINT CHECK / FOREIGN KEY（NOT VALID 無し）・
  ALTER COLUMN ... TYPE。何がどれだけ止まるか、本番規模を測ったかを書く。
  `scripts/check-migration-lock-safety.test.sh`（CI `hooks-test`）が注記の有無だけを機械検査する
  （止まる時間の見積もりは人にしか書けないため）。安全な書き方（CONCURRENTLY / NOT VALID）を
  使っていれば注記は要らない
- **publicスキーマのテーブルを追加/削除するmigrationは、末尾で`SELECT refresh_schema_baseline_snapshot('<そのmigrationのタイムスタンプ>');`を呼ぶ**（issue #305のスキーマドリフト検知が使うbaselineスナップショットを更新するため）。
  呼ばないと、正規のPRレビュー済み変更であっても`table_added`/`table_removed`ドリフトとして恒久的に誤検知され続け、対応するGitHub Issueが自動クローズされなくなる
- **`supabase/migrations/`やRLSポリシーを変更したPRでは、`npm run test:integration`（RLS/IDOR
  integrationテスト）をローカル実行してから作業を完了する**（2026-08-25、Actions無料枠対応で
  `e2e.yml`のPR自動実行を廃止したため）。実行結果は引き継ぎメモの「検証済み」欄に記載する
  - **このうちパスで表せる範囲は、`integration-gate.yml`がPR時点で機械的にゲートする**
    （`supabase/migrations/**`・`supabase/__tests__/**`・`src/lib/supabase/**`・`**/middleware.ts`・`**/proxy.ts`）。
    従来は`push:[main]`のみで、壊れたRLS変更をマージ前に止められなかった
  - **ただしローカル実行義務は無くならない**。`paths`はファイルパスしか見られず、TRI/RISK基準の
    内容ベース判定（auth / facility / tenant / organization / inventory / RLS / policy に
    関わる変更）は表現できないため、上記パス外でRLSの約束に触れる変更はゲートに掛からない
