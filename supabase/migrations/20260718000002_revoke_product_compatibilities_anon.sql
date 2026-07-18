-- supabase/migrations/20260718000002_revoke_product_compatibilities_anon.sql
-- issue #461: product_compatibilitiesテーブルへのanon向けGRANT ALLが、
-- 他マスタテーブル（products/categories等、20260626001000_enable_rls.sqlでREVOKE済み）
-- との一貫性を欠いていた。
--
-- WHY: 20260714224053_create_product_compatibilities.sqlは
-- `GRANT ALL ON TABLE public.product_compatibilities TO postgres, anon, authenticated, service_role;`
-- でanonにも書き込み権限まで含む広い権限を付与していたが、RLSポリシー（同ファイル54-56行目）は
-- authenticatedのみを対象にしているため、現状anonは実質アクセス不能（RLSのdeny-by-defaultで
-- 防御済み・実害なし）。ただし将来ポリシーの書き方を誤ると（例えばUSING句をtrueに緩める等）
-- 即座に匿名アクセスを許してしまうリスクがあるため、防御を多層化する。
--
-- 横断確認（issue #461対応時に実施）: product_compatibilities以降に作成された他のテーブル
-- （schema_drift_log・schema_baseline_snapshots・news関連・user_facilities）は、いずれも
-- anonへテーブルレベルのGRANT ALLを付与しておらず（user_facilitiesは一切anon grantなし、
-- schema_drift関連はdrift_alert_viewへのGRANT SELECTのみに限定）、product_compatibilities
-- が唯一の例外だった。他に同種の是正が必要なテーブルは無い。

REVOKE ALL ON product_compatibilities FROM anon;

-- テーブル権限のREVOKEのみでテーブル新設/削除ではないため、
-- refresh_schema_baseline_snapshot は不要（issue #305要件の対象外）。
