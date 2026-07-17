-- issue #431のrecallベンチマーク用fixture。既知の失敗パターン
-- （docs/agents/known-failure-patterns.md「SECURITY DEFINER + GRANT EXECUTEの認可バイパス」）を
-- 意図的に再現している: SECURITY DEFINER関数がis_facility_member/is_adminによる
-- 明示的な認可チェックを一切行わないまま、施設に紐づく機微データを返し、
-- GRANT EXECUTEでanonにも実行権限を与えている。
-- テーブル自体は本fixtureが意図する欠陥（認可チェック欠落）とは無関係のため、
-- 参照先テーブルも定義しておく（テーブル未定義という別の欠陥に注目が逸れないようにするため）。

CREATE TABLE IF NOT EXISTS eval_fixture_recall_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL,
  internal_note TEXT
);

CREATE OR REPLACE FUNCTION get_eval_fixture_recall_items(p_facility_id UUID)
RETURNS TABLE (id UUID, internal_note TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, internal_note FROM eval_fixture_recall_items WHERE facility_id = p_facility_id;
$$;

GRANT EXECUTE ON FUNCTION get_eval_fixture_recall_items TO anon, authenticated;
