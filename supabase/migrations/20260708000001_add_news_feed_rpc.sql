-- supabase/migrations/20260708000001_add_news_feed_rpc.sql
-- WHY: issue #22 ニュースページ実体化。新規テーブルを作らず、既存の price_histories
--      （価格改定履歴）と distributor_products.created_at（新製品登録）を統合した
--      「お知らせフィード」をDB側でUNION ALLし正しくページネーションする。
--      デフォルトのセキュリティコンテキスト（INVOKER）を使用することで、
--      price_histories/distributor_products の既存RLSポリシーがこの関数内の
--      クエリにもそのまま適用され、施設スコープの認可ロジックを関数内に手書きする
--      必要がなくなる（RLSに一元化。詳細は docs/superpowers/specs/2026-07-08-news-feed-design.md）。

CREATE OR REPLACE FUNCTION get_news_feed(
  p_facility_id UUID,
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  id                     TEXT,
  event_type             TEXT,
  occurred_at            TIMESTAMPTZ,
  distributor_product_id UUID,
  product_name           TEXT,
  maker                  TEXT,
  supplier               TEXT,
  field_name             TEXT,
  old_value              NUMERIC,
  new_value              NUMERIC,
  facility_name          TEXT
) LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT
    ph.id::TEXT AS id,
    'distributor_price_change'::TEXT AS event_type,
    ph.changed_at AS occurred_at,
    dp.id AS distributor_product_id,
    dp.name AS product_name,
    dp.maker AS maker,
    dp.supplier AS supplier,
    ph.field_name AS field_name,
    ph.old_value AS old_value,
    ph.new_value AS new_value,
    NULL::TEXT AS facility_name
  FROM price_histories ph
  JOIN distributor_products dp ON dp.id = ph.distributor_product_id
  WHERE ph.entity_type = 'distributor_product'

  UNION ALL

  SELECT
    ('new_product_' || dp.id::TEXT) AS id,
    'new_product'::TEXT AS event_type,
    dp.created_at AS occurred_at,
    dp.id AS distributor_product_id,
    dp.name AS product_name,
    dp.maker AS maker,
    dp.supplier AS supplier,
    NULL::TEXT AS field_name,
    NULL::NUMERIC AS old_value,
    NULL::NUMERIC AS new_value,
    NULL::TEXT AS facility_name
  FROM distributor_products dp

  UNION ALL

  SELECT
    ph.id::TEXT AS id,
    'hospital_price_change'::TEXT AS event_type,
    ph.changed_at AS occurred_at,
    dp.id AS distributor_product_id,
    dp.name AS product_name,
    dp.maker AS maker,
    dp.supplier AS supplier,
    ph.field_name AS field_name,
    ph.old_value AS old_value,
    ph.new_value AS new_value,
    f.name AS facility_name
  FROM price_histories ph
  JOIN hospital_prices hp ON hp.id = ph.entity_id
  JOIN facilities f ON f.id = hp.facility_id
  JOIN distributor_products dp ON dp.id = ph.distributor_product_id
  WHERE ph.entity_type = 'hospital_price'
    AND (p_facility_id IS NULL OR hp.facility_id = p_facility_id)

  ORDER BY occurred_at DESC, id DESC
  LIMIT p_limit OFFSET p_offset;
$$;

GRANT EXECUTE ON FUNCTION get_news_feed TO authenticated;
