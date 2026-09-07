-- supabase/migrations/20260907000007_add_remaining_text_length_limits.sql
-- issue #757 の 20。20260907000004 で入れ損ねた自由入力の列に上限を足す。
-- release-order: db-first
-- lock: NOT VALID の CHECK を足すだけ。既存行は読まないので長いロックは取らない。
--
-- design: 新しい表は作らない。値は 2026-09-07 に人が決めた既存の値をそのまま使う
--   （docs/agents/design-questions.md の「決めた値」、aidd.config.json の limits.textLength）。
--   説明・備考 = 用途と同じ 1,000 文字。経路 = 20260907000002 の design 注記が
--   「route は 200 文字まで」と書いていたが CHECK が無く、書いただけになっていた。
--
-- WHY(見つけ方): scripts/lib/scan-text-columns.mjs が migration を適用順に畳み込み、
--      「長さの CHECK も固定語の CHECK も無い TEXT 列」を列挙したところ 10 件出た。
--      うちこの 3 つは**利用者が入れる自由入力**で、残り 7 件はサーバーが書く列だった。
--      同じ見落としが次に起きたら scripts/check-text-column-limits.test.sh が止める。

-- 利用者が入れる自由入力（上限が無く、API を通らない経路からいくらでも長い文字列が入る）
ALTER TABLE categories
  ADD CONSTRAINT categories_description_length CHECK (
    description IS NULL OR length(description) <= 1000
  ) NOT VALID;

ALTER TABLE product_compatibilities
  ADD CONSTRAINT product_compatibilities_note_length CHECK (
    note IS NULL OR length(note) <= 1000
  ) NOT VALID;

-- 拒否の記録の経路。20260907000002 の注記どおり 200 文字に収める
-- （クエリ文字列は record_access_denial() が既に落としている）
ALTER TABLE access_denials
  ADD CONSTRAINT access_denials_route_length CHECK (
    route IS NULL OR length(route) <= 200
  ) NOT VALID;

-- ROLLBACK:
--   ALTER TABLE categories DROP CONSTRAINT categories_description_length;
--   ALTER TABLE product_compatibilities DROP CONSTRAINT product_compatibilities_note_length;
--   ALTER TABLE access_denials DROP CONSTRAINT access_denials_route_length;

-- テーブル新設/削除ではないため refresh_schema_baseline_snapshot は不要
