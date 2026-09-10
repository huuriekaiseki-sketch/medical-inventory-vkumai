-- 施設ごとの申し送りメモ。担当者が任意で書く
CREATE TABLE IF NOT EXISTS eval_fixture_holdout_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  title text NOT NULL,
  -- 任意入力。書かない運用の施設もある
  body text,
  author_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eval_fixture_holdout_notes_facility
  ON eval_fixture_holdout_notes (facility_id);

ALTER TABLE eval_fixture_holdout_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "facility members can read notes"
  ON eval_fixture_holdout_notes FOR SELECT
  TO authenticated
  USING (is_facility_member(facility_id));
