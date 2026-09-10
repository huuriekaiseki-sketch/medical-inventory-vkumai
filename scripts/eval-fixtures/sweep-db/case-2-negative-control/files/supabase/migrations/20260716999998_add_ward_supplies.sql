CREATE TABLE IF NOT EXISTS ward_supply_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL,
  internal_note TEXT
);

-- SECURITY DEFINER は RLS を通らないため、呼び出し元がその施設に所属しているかを
-- 関数の中で必ず確かめる（is_facility_member はこのリポジトリの共通ヘルパー）。
CREATE OR REPLACE FUNCTION get_ward_supply_items(p_facility_id UUID)
RETURNS TABLE (id UUID, internal_note TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_facility_member(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: caller is not a member of the facility';
  END IF;
  RETURN QUERY
    SELECT i.id, i.internal_note
    FROM ward_supply_items i
    WHERE i.facility_id = p_facility_id;
END;
$$;

-- 未認証には渡さない
GRANT EXECUTE ON FUNCTION get_ward_supply_items TO authenticated;
