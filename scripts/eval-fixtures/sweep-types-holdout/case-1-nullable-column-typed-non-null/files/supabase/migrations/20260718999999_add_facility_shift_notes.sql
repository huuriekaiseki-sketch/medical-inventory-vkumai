-- 施設ごとの申し送りメモ。担当者が任意で書く
CREATE TABLE IF NOT EXISTS facility_shift_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  title text NOT NULL,
  -- 任意入力。書かない運用の施設もある
  body text,
  author_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_facility_shift_notes_facility
  ON facility_shift_notes (facility_id);

ALTER TABLE facility_shift_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "facility members can read notes"
  ON facility_shift_notes FOR SELECT
  TO authenticated
  USING (is_facility_member(facility_id));
