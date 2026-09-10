CREATE TABLE IF NOT EXISTS eval_fixture_holdout_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL,
  internal_note TEXT
);

CREATE OR REPLACE FUNCTION get_eval_fixture_holdout_items(p_facility_id UUID)
RETURNS TABLE (id UUID, internal_note TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.internal_note
  FROM eval_fixture_holdout_items i
  WHERE i.facility_id = p_facility_id
    AND EXISTS (
      SELECT 1 FROM user_facilities uf
      WHERE uf.facility_id = i.facility_id
    );
$$;

GRANT EXECUTE ON FUNCTION get_eval_fixture_holdout_items TO authenticated;
