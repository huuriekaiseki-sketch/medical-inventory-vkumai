-- supabase/migrations/20260907040000_add_aal2_required_denial_reason.sql
-- release-order: db-first
-- lock: `access_denials` への書き込みが CHECK の張り直しの間だけ止まる。
--       既存の全行を再検査するため行数に比例するが、この表は追記のみで
--       ローカルでは 15 行・数ミリ秒。本番規模は未計測（拒否の記録が溜まるほど伸びる）ので、
--       行数が万を超えたら NOT VALID + 後から VALIDATE に切り替える。
--   （語彙を先に広げる。アプリが新しい理由を書く前に受け入れられる状態にする。
--     逆順だと CHECK 違反で拒否の記録だけが落ちる）
--
-- WHY: W-011（Supabase Auth の管理 API）は service_role キーでしか呼べず、
--      SQL の中に入れられないので RLS のトランザクションに統合できない。
--      P-035 で `user_facilities` にやった「経路そのものを無くす」が使えない。
--
--      代わりに特権操作の**直前**で admin と aal2 を再確認する（`assertAdminAal2`）。
--      そこで弾いた拒否を記録するために、理由の語彙に `aal2_required` を足す。
--
--      語彙を固定してあるのは、`check_denial_anomalies`（20260907000006）が理由ごとに
--      数えるため。自由文字列にすると数えられなくなる。
--
-- ROLLBACK:
--   reason = 'aal2_required' の行を消してから、20260907000005 の 5 値の CHECK に戻す。

ALTER TABLE access_denials DROP CONSTRAINT access_denials_reason_check;
ALTER TABLE access_denials
  ADD CONSTRAINT access_denials_reason_check
  CHECK (reason IN (
    'unauthenticated',
    'facility_id_required',
    'forbidden',
    'not_admin',
    'rate_limited',
    -- admin ではあるが aal2 へ昇格していない（多要素認証が要る操作を試みた）
    'aal2_required'
  ));

-- CHECK の変更のみでテーブル新設/削除ではないため refresh_schema_baseline_snapshot は不要。
