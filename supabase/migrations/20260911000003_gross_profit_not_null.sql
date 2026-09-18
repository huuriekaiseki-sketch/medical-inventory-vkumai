-- supabase/migrations/20260911000003_gross_profit_not_null.sql
-- release-order: app-first
-- contract: 縮めるのは `hospital_prices.gross_profit` の nullable。
--   **アプリは以前から null を書き込んでいない**（生成列なので INSERT / UPDATE できない）し、
--   読み取り側も `asNumber()` で非 null として扱っていた
--   （src/lib/hospital-prices/repository.ts:30、`grossProfit: number`）。
--   つまり「どの PR 以降のアプリが参照しなくなったか」ではなく、**最初から参照していない**。
--   生成型が `number | null` → `number` に変わるので、型の再生成を同じコミットに含める。
--   規約どおり app-first として扱うが、アプリ側の先行リリースは不要。
-- lock: hospital_prices を全行スキャンして NOT NULL を検証する間、この表への書き込みが止まる。
--   列の NOT NULL には NOT VALID のような逃がし方が無いので、避ける書き方が存在しない。
--   **本番の行数は未計測**（当てる前に数えること）。施設ごとの仕入価格なので
--   「施設数 × 取扱品目数」の規模で、数万行なら 1 秒未満の見込み。
--
-- WHY(2026-09-11): `gross_profit` は
--   `GENERATED ALWAYS AS (delivery_price - purchase_price) STORED`（20260623000000:12）で、
--   元の 2 列はどちらも NOT NULL（20260618063046:58-59）なので**値は必ず非 NULL**。
--   ところが PostgreSQL は生成列へ NOT NULL 制約を自動では付けないため、カタログ上は
--   nullable のままで、`supabase gen types` が `gross_profit: number | null` を吐いていた。
--   一方 `src/types/hospitalPrice.ts` は `grossProfit: number` と宣言している。
--   **形式的には食い違っており**、TypeScript 側は「元 2 列が NOT NULL だから」という
--   **コードのどこにも書かれていない知識**に頼っていた。
--
--   実害は無い（値は常に非 NULL）。それでも直すのは、**同じ指摘が eval で 2 回続けて出た**から
--   （2026-09-10 と 2026-09-11 の sweep-types が、どちらも `grossProfit` を挙げた）。
--   1 回目に人が「偽陽性」と判定したのは**実質の観点では正しかった**が、
--   **形式の観点では指摘のほうが正しい**。宣言を実態に合わせて食い違いそのものを消す。
--
-- WHY(TypeScript 側を `number | null` にしない): 値が来ないことを DB が保証しているのに
--   呼び出し側へ null 分岐を配ると、**実際には一度も通らない道**が増える（C-024 の型）。
--   狭める側（DB に NOT NULL を足す）が実態に合う。

ALTER TABLE hospital_prices ALTER COLUMN gross_profit SET NOT NULL;

-- ROLLBACK: ALTER TABLE hospital_prices ALTER COLUMN gross_profit DROP NOT NULL;

-- 列の制約変更のみでテーブルの新設・削除ではないため refresh_schema_baseline_snapshot は不要。
