---
paths:
  - "supabase/migrations/**"
---

# DBスキーマ変更ルール

- **新しいテーブルを作るときは 4 軸すべてを決める（2026-09-07）。**
  (1) RLS を有効にするか  (2) ポリシーを作るか  (3) **誰が読み書きできるか**  (4) 監査対象にするか。
  決めた内容は [`docs/agents/table-rulebook.md`](../../docs/agents/table-rulebook.md)（TB-xxx）に 1 行書く。
  **決めごとの正本はこの 1 枚だけ**で、`rls_enabled_all_tables` も `audit_trigger_coverage` も
  ここを読む（同じ判断を 2 か所に置かない）。書かないと
  `supabase/migrations/__tests__/table_registry.test.ts` が「宣言が無い」で落ちる
  （`npm test` に含まれるので毎 PR）。宣言と migration の実態がずれても落ちる。
  表の**形**は汎用エンジン `scripts/lib/check-catalog.mjs` が見る（登録は `scripts/lib/catalog-registry.json`、
  索引は [`docs/agents/rulebooks.md`](../../docs/agents/rulebooks.md)）。
  - 特に (3) は 2026-09-07 まで**どの検査も見ていなかった**。その結果 `schema_drift_log` は
    作られてから 2 か月間 GRANT が 1 行も無く、service_role でも読めなかった。
    RLS のバイパス（service_role）とテーブル権限は別の話で、**GRANT を書かなければ誰も読めない**
  - **`REVOKE ALL ON TABLE <t> FROM PUBLIC, anon, authenticated, service_role;` を先に書いてから
    必要な GRANT だけを書く**。Supabase の既定権限（`ALTER DEFAULT PRIVILEGES`）が効くかは
    環境で変わり、実測でも効いている表と効いていない表の両方があった。既定に答えを委ねない
  - ポリシーを作らない表（SECURITY DEFINER 関数からしか触らない表）は、
    **実 DB で「読める人・読めない人」を測る統合テスト**も必須（静的検査は GRANT の文字列しか見られない）

- **`supabase/` を触ったら `bash scripts/run-integration-tests.sh` で全件を通す。**
  素の `npm run test:integration` ではなくこのラッパーを使うと、結果が
  `logs/integration-runs.jsonl` に機械的に記録される（通ったことにはできない。記録するのは exit code）。
  記録が無い・前回が赤・前回から `supabase/` が変わっている、のいずれかなら
  SessionStart hook（`scripts/check-integration-freshness.sh`）が次のセッションで警告する。
  2026-09-07 に統合テストが 2 件、いつからか分からないほど前から赤いまま放置されていたのが理由

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
- **`supabase/migrations/`やRLSポリシーを変更したPRでは、`npm run test:integration`（RLS/IDOR
  integrationテスト）をローカル実行してから作業を完了する**（2026-08-25、Actions無料枠対応で
  `e2e.yml`のPR自動実行を廃止したため）。実行結果は引き継ぎメモの「検証済み」欄に記載する
  - **このうちパスで表せる範囲は、`integration-gate.yml`がPR時点で機械的にゲートする**
    （`supabase/migrations/**`・`supabase/__tests__/**`・`src/lib/supabase/**`・`**/middleware.ts`・`**/proxy.ts`）。
    従来は`push:[main]`のみで、壊れたRLS変更をマージ前に止められなかった
  - **ただしローカル実行義務は無くならない**。`paths`はファイルパスしか見られず、TRI/RISK基準の
    内容ベース判定（auth / facility / tenant / organization / inventory / RLS / policy に
    関わる変更）は表現できないため、上記パス外でRLSの約束に触れる変更はゲートに掛からない
