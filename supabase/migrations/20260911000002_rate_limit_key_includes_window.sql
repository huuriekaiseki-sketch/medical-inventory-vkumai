-- supabase/migrations/20260911000002_rate_limit_key_includes_window.sql
-- release-order: app-first
-- contract: 消すのは rate_limit_bucket_key(TEXT, TIMESTAMPTZ)。**アプリは一度も参照していない**
--   （service_role にも EXECUTE を渡していない内部関数で、呼び出し元は consume_rate_limit と
--   refund_rate_limit の 2 つだけ。どちらも同じ migration の中で 3 引数版へ差し替える）。
--   よってアプリ側の先行リリースは不要だが、規約どおり app-first として扱う。
--
-- WHY(2026-09-11 に実測で見つけた): 固定窓カウンタの行の鍵は
--   `left(bucket,160) || '@' || 窓の開始 epoch` で、**窓幅が入っていなかった**。
--   窓の開始は幅で切り捨てた時刻なので、普段は 60 秒窓と 3600 秒窓で別の値になる。
--   だが **毎時 0 分台の 1 分間だけ両方が「その時の 0 分 0 秒」に落ちて一致する**。
--   その間、幅の違う 2 つの窓が**同じ行を共有**する。
--
--   起きること: (a) 払い戻しが「別の窓のつもり」で他方の窓の消費を 1 つ減らす、
--   (b) 同じバケット名を違う幅で使っていると、互いの回数を数え合って早く上限に当たる。
--   どちらも**毎時 0 分台にしか起きない**ので、再現も原因の特定も難しい形をしている。
--
--   見つかったのは 2026-09-11 06:59〜07:00 に統合テストを回したとき。
--   「窓の秒数が違えば別の行を見る（消費した窓だけを戻す）」が落ちた。
--   このテストは 2026-09-08 からあったが、**毎時 0 分台に回さない限り緑**だった
--   （時刻に依存する検査だったことに、落ちるまで誰も気づいていなかった）。
--   同じテストを時刻に依存しない形へ書き直した（鍵そのものを service_role で読んで数える）。
--
-- WHY(鍵に窓幅を入れる): 「別の窓は別の行」は窓の**開始時刻**では表せない。
--   幅の違う窓は開始時刻が一致しうるので、幅そのものを鍵に持たせる。
--   長さは 160(bucket) + 1 + 10(幅) + 1 + 10(epoch) = 最大 182 で、
--   `rate_limit_counters.bucket` の上限 200 に収まる。
--
-- WHY(移行時に一度だけ数え直しになる): 鍵の形が変わるので、いま生きている窓の行は
--   参照されなくなる（＝その窓の消費が 0 に戻る）。カウンタは 1 日で掃除されるうえ、
--   上限は「短時間に押し直したときの抑止」なので、1 窓分の取りこぼしは許容する。

-- 1. 窓の鍵の正本（窓幅を含む）
CREATE OR REPLACE FUNCTION rate_limit_bucket_key(
  p_bucket TEXT,
  p_window_seconds INTEGER,
  p_window_start TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT left(p_bucket, 160)
      || '@' || p_window_seconds::TEXT
      || '@' || extract(epoch FROM p_window_start)::BIGINT::TEXT;
$$;

COMMENT ON FUNCTION rate_limit_bucket_key(TEXT, INTEGER, TIMESTAMPTZ) IS
  '固定窓カウンタの行の鍵。窓幅と窓の開始をどちらも含む（2026-09-11。幅が違えば必ず別の行）';

-- 2. consume を新しい鍵へ（数え方そのものは変えない）
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
  v_key := public.rate_limit_bucket_key(p_bucket, p_window_seconds, v_window_start);

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

-- 3. 払い戻しも同じ鍵へ
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

  v_key := public.rate_limit_bucket_key(
    p_bucket, p_window_seconds, public.rate_limit_window_start(p_window_seconds)
  );

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

-- 4. 古い 2 引数版は消す（残すと「窓幅を渡し忘れた呼び出し」が黙って通る）
DROP FUNCTION IF EXISTS rate_limit_bucket_key(TEXT, TIMESTAMPTZ);

-- 5. 権限（新しい鍵の関数も client からは呼べない。CREATE OR REPLACE した 2 本は ACL を保つ）
REVOKE ALL ON FUNCTION rate_limit_bucket_key(TEXT, INTEGER, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;

-- ROLLBACK: 20260908000000 の 1・3・4 節をそのまま再適用し、
--   DROP FUNCTION IF EXISTS rate_limit_bucket_key(TEXT, INTEGER, TIMESTAMPTZ); を実行する。
--   毎時 0 分台に窓が混ざる状態へ戻ることになるので通常は不要。

-- 関数の変更のみでテーブルの新設・削除ではないため refresh_schema_baseline_snapshot は不要。
