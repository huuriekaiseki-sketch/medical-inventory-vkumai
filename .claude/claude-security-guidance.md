# Security guidance for this repo

このプロジェクトは医療施設向け在庫管理アプリで、施設（facility）単位のテナント分離が
セキュリティ上の最重要事項です。詳細は `docs/agents/decisions.md`・
`docs/agents/known-failure-patterns.md` を参照してください。

- すべてのRLSポリシーは `auth.uid()` または `facility_id`（`is_facility_member(...)`経由）を
  参照すること。どちらも参照しないポリシーは他施設のデータ漏洩に直結する
- admin権限は `user_facilities.role = 'admin'` をDB側で判定する（`is_admin()`関数経由）。
  環境変数（`ADMIN_EMAILS`等）によるフォールバック判定を新設しない
- `SECURITY DEFINER` 関数はRLSをバイパスする。新規・変更時は関数内で明示的な認可チェック
  （`is_facility_member(...) OR is_admin()`等）を行っているか必ず確認する。まず
  `SECURITY DEFINER` を使わずに済ませられないか（`SECURITY INVOKER`でRLSが自動適用される
  設計にできないか）を先に検討する
- DBスキーマ変更は必ず `supabase/migrations/` 配下のマイグレーションファイル経由で行う。
  `execute_sql`・`executeRaw`・生SQL実行による直接DDL適用は禁止（ローカル・リモート問わず）
- `facility_id`・患者情報等の機微データをINFO以上のログレベルで出力しない
- seed・E2Eテスト・スクリーンショット・issue添付には実在施設名・実データを一切使わない。
  施設名・ユーザー名・在庫品目などはすべてダミー（例: `テスト施設A`、
  `e2e-test-user@example.com`）を使う
