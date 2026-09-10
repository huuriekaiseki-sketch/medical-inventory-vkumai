CREATE TABLE IF NOT EXISTS shift_handover_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL,
  internal_note TEXT
);

CREATE OR REPLACE FUNCTION get_shift_handover_items(p_facility_id UUID)
RETURNS TABLE (id UUID, internal_note TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, internal_note FROM shift_handover_items WHERE facility_id = p_facility_id;
$$;

GRANT EXECUTE ON FUNCTION get_shift_handover_items TO anon, authenticated;
