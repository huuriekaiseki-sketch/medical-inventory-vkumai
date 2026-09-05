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
