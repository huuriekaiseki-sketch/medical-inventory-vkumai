-- supabase/migrations/20260907000005_add_rate_limits.sql
-- issue #757 の 32（量の上限）。quota-inventory の Q-002 / Q-020。
-- release-order: db-first
-- lock: 新しい表と関数だけを作る。既存の表を触らないので、長いロックは取らない。
--
-- design: 2026-09-07 に人へ聞いて決めた答え（docs/agents/design-questions.md）。
--   量: 1 人あたり毎分 300 回（画面操作では届かず、機械的な連打だけが止まる値）。
--       招待メールは管理者 1 人あたり毎日 50 通。値は aidd.config.json の limits に置き、
--       scripts/check-design-answers.test.sh が未記入・食い違いを止める。
--   超えたとき: 拒否して記録に残す（429 と access_denials）。黙って通さない。
--   大きさ: bucket は 200 文字まで（誰の・何の・どの窓か）。1 行はカウンタ 1 つ。
--   権限: 読み書きできるのは service_role だけ（RPC 経由）。client は一切触れない。
--   消えるとき: 窓が過ぎた行は不要。次の呼び出しのついでに古い行を消す（保持は 1 日）。
--   記録: 拒否は access_denials（guard='rate_limit'）。成功は記録しない（量が多すぎる）。
--   途中で止まったら: DB が落ちているときは通す（fail-open）。上限はお金と可用性のための
--                     仕組みであって認可ではないので、記録の失敗で業務を止めない。
--                     docs/agents/fail-open-inventory.md に行を足す。
--   外に出るもの: なし。
--
-- WHY(固定窓): 直近 N 秒の厳密な滑走窓にすると 1 リクエストごとに履歴行が要る。
--      固定窓なら 1 人 1 窓 1 行で済み、上限の 2 倍までしか通らない（窓の境目の最悪ケース）。
--      毎分 300 回に対して最悪 600 回/分。お金と可用性を守る目的には十分な精度。
--
-- WHY(DB に置く): Vercel の関数は複数のインスタンスで動くので、プロセス内のカウンタでは
--      インスタンスの数だけ上限が緩む。人ごとの上限を正しく数えられるのは共有の場所だけ。

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket TEXT PRIMARY KEY CHECK (char_length(bucket) <= 200),
  window_start TIMESTAMPTZ NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE rate_limit_counters IS
  '1 人あたりの回数の上限を数える固定窓カウンタ（issue #757 の 32、Q-002 / Q-020）。service_role だけが RPC 経由で触る';

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window_start
  ON rate_limit_counters (window_start);

-- RLS: client からは一切見えない・書けない（ポリシーを 1 つも作らないことで拒否になる）
ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON rate_limit_counters FROM anon, authenticated;

-- WHY: 数える処理を関数に閉じ込め、service_role にも表への直接 INSERT/UPDATE を渡さない。
--      窓の切り方と上限の比較を 1 か所に固定するため（呼び出し側が数え方を変えられない）。
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

  -- 窓の始まり（epoch を窓幅で切り捨てる）
  v_window_start := to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
  -- 窓ごとに別の行にする。前の窓の行は下の掃除で消える
  v_key := left(p_bucket, 160) || '@' || extract(epoch FROM v_window_start)::BIGINT::TEXT;

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

REVOKE ALL ON FUNCTION consume_rate_limit(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_rate_limit(TEXT, INTEGER, INTEGER) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_rate_limit(TEXT, INTEGER, INTEGER) TO service_role;

COMMENT ON FUNCTION consume_rate_limit(TEXT, INTEGER, INTEGER) IS
  '固定窓で 1 回数え、上限内なら allowed=true を返す（issue #757 の 32）。service_role のみ実行可';

-- WHY: 拒否の語彙に「量を超えた」を足す。access_denials（20260907000002）は guard / reason を
--      固定語で持つので、新しい種類の拒否を記録するには語彙を広げる必要がある。
--      固定語のままにしているのは、自由文字列にすると集計できなくなるため。
ALTER TABLE access_denials DROP CONSTRAINT IF EXISTS access_denials_guard_check;
ALTER TABLE access_denials ADD CONSTRAINT access_denials_guard_check
  CHECK (guard IN ('auth', 'facility', 'admin', 'proxy_admin', 'rate_limit'));

ALTER TABLE access_denials DROP CONSTRAINT IF EXISTS access_denials_reason_check;
ALTER TABLE access_denials ADD CONSTRAINT access_denials_reason_check
  CHECK (reason IN ('unauthenticated', 'facility_id_required', 'forbidden', 'not_admin', 'rate_limited'));

SELECT refresh_schema_baseline_snapshot('20260907000005');
