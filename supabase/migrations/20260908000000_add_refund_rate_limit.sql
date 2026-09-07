-- supabase/migrations/20260908000000_add_refund_rate_limit.sql
-- issue #757 の 38（部分成功、M-021）。quota-inventory の Q-020。
-- release-order: db-first
-- lock: 関数の追加と置き換えのみ。テーブルには触れないので長いロックは取らない。
--
-- design: 2026-09-08 に人へ聞いて決めた答え（docs/agents/design-questions.md）。
--   質問「回数を数えるなら、送信に失敗したとき消費は戻しますか」→ **送信失敗だけ戻す**。
--   GoTrue が 5xx を返した＝メールが出ていないことが確実なときだけ枠を返す。
--   422（既に登録済み）のような利用者側の誤りは戻さない（同じ操作の連打を抑止し続けるため）。
--   権限: 実行できるのは service_role だけ（consume_rate_limit と同じ）。
--   記録: 払い戻しは拒否ではないので access_denials には残さない。
--   消えるとき: カウンタ行の掃除は consume 側のついで削除がそのまま担う。
--
-- WHY(この migration が必要になった経緯): 2026-09-07 にローカルの SMTP を止めて M-021 を実測した
--      ところ、GoTrue は**利用者行ごとロールバック**していた（auth.users / auth.identities /
--      one_time_tokens / GoTrue の監査行すべて 0 件、3/3 一致）。棚卸しに書いてあった
--      「利用者は作られたがメール送信だけ失敗」という想定は外れており、
--      **本当に残っていたのは消費済みの招待枠だけ**だった。
--      SMTP が落ちている間に押し直すと、メールが 1 通も出ないまま 1 日 50 通の枠が減っていく。
--
-- WHY(SECURITY DEFINER にする理由と、関数内に認可判定を置かない理由):
--      `rate_limit_counters` は誰にも書き込み権限が無い（20260907020000 で PUBLIC・anon・
--      authenticated・service_role すべてから REVOKE 済み。service_role にも SELECT だけ）。
--      カウンタを触れるのは SECURITY DEFINER の関数だけ、という形が既に設計。
--      本関数の EXECUTE も **service_role にしか渡さない**ので、client から到達する経路が無い。
--      「誰の代わりに減らすか」を判断する余地が無いため、関数内の認可判定は置かない
--      （consume_rate_limit と同じ。W-021）。呼び出し側（W-011）は `assertAdminAal2` を
--      通った後にしか呼ばない。
--
-- WHY(窓の鍵を共通の関数に切り出す): 払い戻しは「消費したのと同じ行」を減らさなければならない。
--      鍵の作り方（bucket を 160 文字で切り、窓の開始 epoch を足す）を 2 か所に書くと、
--      片方だけ変えたときに**別のバケットを黙って減らす**ことになる。
--      `rate_limit_bucket_key()` を正本にし、consume も refund もそれを呼ぶ。

-- 1. 窓の鍵の正本（consume と refund が同じものを見るための唯一の場所）
CREATE OR REPLACE FUNCTION rate_limit_bucket_key(
  p_bucket TEXT,
  p_window_start TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT left(p_bucket, 160) || '@' || extract(epoch FROM p_window_start)::BIGINT::TEXT;
$$;

COMMENT ON FUNCTION rate_limit_bucket_key(TEXT, TIMESTAMPTZ) IS
  '固定窓カウンタの行の鍵。consume_rate_limit と refund_rate_limit が同じ行を指すための正本（issue #757 の 38）';

-- 2. 窓の開始時刻の正本（同じ理由）
CREATE OR REPLACE FUNCTION rate_limit_window_start(
  p_window_seconds INTEGER
)
RETURNS TIMESTAMPTZ
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
$$;

COMMENT ON FUNCTION rate_limit_window_start(INTEGER) IS
  '固定窓の開始時刻。consume_rate_limit と refund_rate_limit が同じ窓を見るための正本（issue #757 の 38）';

-- 3. consume を上の 2 つを使う形へ置き換える（数え方そのものは 20260907000005 から変えない）
CREATE OR REPLACE FUNCTION consume_rate_limit(
  p_bucket TEXT,
  p_limit INTEGER,
  p_window_seconds INTEGER
)
RETURNS TABLE (allowed BOOLEAN, hit_count INTEGER, limit_value INTEGER, reset_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_key TEXT;
  v_hits INTEGER;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'p_limit must be >= 1';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'p_window_seconds must be >= 1';
  END IF;

  v_window_start := public.rate_limit_window_start(p_window_seconds);
  v_key := public.rate_limit_bucket_key(p_bucket, v_window_start);

  INSERT INTO public.rate_limit_counters AS c (bucket, window_start, hits, updated_at)
  VALUES (v_key, v_window_start, 1, clock_timestamp())
  ON CONFLICT (bucket) DO UPDATE
    SET hits = c.hits + 1, updated_at = clock_timestamp()
  RETURNING c.hits INTO v_hits;

  -- WHY: 掃除を別のジョブにすると「動いていないことに気づけない」ので、
  --      たまたま当たった呼び出しのついでに消す（1,000 回に 1 回程度）。
  IF (random() < 0.001) THEN
    DELETE FROM public.rate_limit_counters
    WHERE window_start < clock_timestamp() - INTERVAL '1 day';
  END IF;

  RETURN QUERY SELECT
    (v_hits <= p_limit),
    v_hits,
    p_limit,
    v_window_start + make_interval(secs => p_window_seconds);
END;
$$;

-- 4. 払い戻し
--
-- WHY(0 未満にしない): 払い戻しが消費より多く来ても、負のカウンタ（＝上限の実質的な無効化）を
--      作らない。CHECK (hits >= 0) に当たって例外になるより、GREATEST で止めるほうが
--      「払い戻しの失敗で業務を止めない」という上限の設計（fail-open）と揃う。
--
-- WHY(行が無ければ何もしない): 窓が変わったあとに払い戻しが来た場合、消費した行はもう別の鍵。
--      新しい窓の行を減らすと**他人の（次の窓の）消費を無かったことにする**ので、
--      「その窓に行が無ければ何もしない」を選ぶ。窓の境目でごく稀に 1 回分を取り逃す。
CREATE OR REPLACE FUNCTION refund_rate_limit(
  p_bucket TEXT,
  p_window_seconds INTEGER
)
RETURNS TABLE (refunded BOOLEAN, hit_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key TEXT;
  v_hits INTEGER;
BEGIN
  IF p_window_seconds IS NULL OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'p_window_seconds must be >= 1';
  END IF;

  v_key := public.rate_limit_bucket_key(p_bucket, public.rate_limit_window_start(p_window_seconds));

  UPDATE public.rate_limit_counters AS c
     SET hits = GREATEST(c.hits - 1, 0), updated_at = clock_timestamp()
   WHERE c.bucket = v_key
  RETURNING c.hits INTO v_hits;

  IF v_hits IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER;
  ELSE
    RETURN QUERY SELECT TRUE, v_hits;
  END IF;
END;
$$;

COMMENT ON FUNCTION refund_rate_limit(TEXT, INTEGER) IS
  '固定窓カウンタを 1 つ戻す（issue #757 の 38、M-021）。メールが出ていないことが確実なときだけ呼ぶ。service_role のみ実行可';

-- 権限: client からは呼べない（consume_rate_limit と同じ）
REVOKE ALL ON FUNCTION rate_limit_bucket_key(TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION rate_limit_window_start(INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION refund_rate_limit(TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION refund_rate_limit(TEXT, INTEGER) TO service_role;

-- 関数の追加・置き換えのみで列・表の変更が無いため refresh_schema_baseline_snapshot は不要
-- （20260718000001 と同じ判断）。
--
-- ROLLBACK:
--   DROP FUNCTION refund_rate_limit(TEXT, INTEGER);
--   consume_rate_limit を 20260907000005 の本文（鍵と窓をインラインで計算する版）へ戻す;
--   DROP FUNCTION rate_limit_bucket_key(TEXT, TIMESTAMPTZ);
--   DROP FUNCTION rate_limit_window_start(INTEGER);
--   アプリ側は refundInviteQuota() の呼び出しを消す（消費は送信前のまま戻らなくなる）。
