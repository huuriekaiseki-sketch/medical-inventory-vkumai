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
- マイグレーション外で本番/リモートDBに存在するスキーマ変更（トリガー・関数等）を発見した場合は、
  差分をキャッチアップ用マイグレーションとして必ず記録してから作業を進める
- 理由（過去のスキーマドリフト事例）は [`../../docs/agents/decisions/db-rls.md`](../../docs/agents/decisions/db-rls.md#なぜdbスキーマ変更をmigrationファイル経由に限定し直接ddl実行を禁止したか) を参照
- **publicスキーマのテーブルを追加/削除するmigrationは、末尾で`SELECT refresh_schema_baseline_snapshot('<そのmigrationのタイムスタンプ>');`を呼ぶ**（issue #305のスキーマドリフト検知が使うbaselineスナップショットを更新するため）。
  呼ばないと、正規のPRレビュー済み変更であっても`table_added`/`table_removed`ドリフトとして恒久的に誤検知され続け、対応するGitHub Issueが自動クローズされなくなる
