-- supabase/migrations/20260907020000_tighten_rate_limit_counters_grants.sql
-- release-order: db-first
-- design: 権限=誰も直接は読み書きしない（consume_rate_limit() だけが触る）／大きさ・量・消え方は
--         20260907000005 で決めた分から変えない／記録=監査対象外（TB-052）／外部送信なし
-- lock: 権限の変更のみ。テーブルロックは取らない
--
-- WHY: 2026-09-07 のマージで `docs/agents/table-rulebook.md`（TB-xxx）の検査が
--      `rate_limit_counters` を捕まえた。20260907000005 は `REVOKE ALL ... FROM anon, authenticated`
--      だけを書いており、**PUBLIC と service_role が残っていた**。
--
--      Supabase の既定権限（ALTER DEFAULT PRIVILEGES）は service_role にも ALL を付けるので、
--      「GRANT を書いていない＝触れない」は成り立たない。実際に service_role キーがあれば
--      カウンタを直接読み書きできた（＝上限の回避が service_role からは可能だった）。
--      consume_rate_limit() は SECURITY DEFINER なので、誰にも直接の権限は要らない。
--
--      新しい規則（.claude/rules/db-schema.md）どおり、client ロール 3 つと PUBLIC から
--      明示的に REVOKE してから、必要な GRANT だけを書く（ここでは 1 つも要らない）。
--
--      service_role には **SELECT だけ**を戻す。理由は 2 つ:
--        (1) 「client から読めない」ことを確かめるテストは、行が実在することを先に確かめないと
--            空の表を読んで「読めない」と言っているだけになる（2026-09-07 の RLS 変異計測で
--            M-010 が 2 回生き残った原因そのもの）。確かめる側はサーバー側の鍵で読む必要がある。
--        (2) 上限の調査（誰がどのバケットで詰まっているか）はサーバー側でしか行わない。
--      書き込みは誰にも与えない（consume_rate_limit() が SECURITY DEFINER で行う）。
--      これは schema_drift_log（20260907010000、TB-050）と同じ形。
--
-- ROLLBACK: GRANT ALL ON TABLE rate_limit_counters TO service_role;（既定に戻す。安全側ではない）

REVOKE ALL ON TABLE rate_limit_counters FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE rate_limit_counters TO service_role;

-- 権限の変更のみでテーブル新設/削除ではないため refresh_schema_baseline_snapshot は不要。
